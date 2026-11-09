import {resolvePrettyAuthorArchive} from "./author-archives.js";
import { pool, getSettings } from "./db.js";
import { pingbackHeader } from "./incoming-ping-policy.js";
import { resolvePublicPath } from "./permalinks.js";
import { readPlainPermalinkQuery } from "../shared/plain-permalink-query.js";
import { readPublicPath, resolvePublicArchive } from "./public-path.js";

// Keep this inventory aligned with the actual React routes in src/App.tsx.
const frameworkPaths = new Set([
  "/login", "/register", "/check-email", "/privacy/confirm", "/confirm-admin-email",
  "/confirm-profile-email", "/install", "/lost-password", "/reset-password",
  "/admin", "/admin/posts", "/admin/posts/categories", "/admin/posts/tags",
  "/admin/pages", "/admin/media", "/admin/comments", "/admin/users", "/admin/profile",
  "/admin/settings", "/admin/settings/connectors", "/admin/appearance", "/admin/appearance/editor",
  "/admin/appearance/menus", "/admin/appearance/fonts", "/admin/plugins", "/admin/tools", "/admin/about",
]);
const archiveQuery = /^(?:search|s|category|tag|author|year|month|monthnum|day|m|w)(?:\[|$)/;
export type PublicDocumentResolution = {
  status: 200 | 404; kind: "framework" | "home" | "archive" | "singular" | "front-page" | "posts-page" | "not-found";
  selectedId?: number; selectedType?: "post" | "page"; contentPage?: number;
  archive?: Awaited<ReturnType<typeof resolvePublicArchive>>; pingback?: string;
};
const missing = (): PublicDocumentResolution => ({status:404,kind:"not-found"});

/** Choose HTTP status from public metadata, never bodies, tokens or internal HTTP. */
export async function resolvePublicDocumentRoute(path: string): Promise<PublicDocumentResolution> {
  const { pathname, segments, query } = readPublicPath(path);
  // React matches framework route literals without regard to case and decodes
  // each segment. Do not turn an encoded slash into a new route boundary.
  const route = "/" + segments.map(segment => segment.replaceAll("/", "%2F")).join("/").toLowerCase();
  if (frameworkPaths.has(route) || /^\/wp-admin(?:\/|$)/.test(route) ||
    /^\/(?:preview\/[^/]+|admin\/(?:posts|pages|content|media|users)\/[^/]+)$/.test(route))
    return { status: 200, kind: "framework" };

  const fixed = readPlainPermalinkQuery(query);
  if (fixed.kind === "invalid" || (fixed.kind !== "none" && pathname !== "/")) return missing();
  const root = pathname === "/";
  const filtered = [...query].some(([key, value]) => value && archiveQuery.test(key));
  // Ordinary home/search/archive query paging remains valid even with no results.
  if (root && fixed.kind === "none") {
    if (filtered) return { status: 200, kind: "archive" };
    if (query.has("page")) {
      const settings = await getSettings();
      if (settings.frontPageMode !== "page" || !settings.frontPageId) return { status: 200, kind: "home" };
      // A selected static front is a singular document, including body paging.
      // Do not let a stale private/missing selection become ordinary home here.
    }
  }

  let post, contentPage: number | undefined;
  // These are actual React routes, independent of the current permalink setting.
  if (segments.length === 2 && ["posts", "pages"].includes(segments[0].toLowerCase())) {
    post = (await pool.query(
      'SELECT id,type,status,ping_status AS "pingStatus",published_at AS "publishedAt",password_hash IS NOT NULL AS "hasPassword" FROM posts WHERE slug=$1 AND type=$2 AND status=\'publish\'',
      [segments[1], segments[0].toLowerCase() === "pages" ? "page" : "post"],
    )).rows[0];
    if (!post) return missing();
  } else {
    const author=await resolvePrettyAuthorArchive(path);
    if(author.recognized)return author.archive?{status:200,kind:"archive",archive:author.archive}:missing();
    const identity = await resolvePublicPath(path);
    contentPage = identity?.contentPage;
    if (identity) post = (await pool.query(
      'SELECT id,type,status,ping_status AS "pingStatus",published_at AS "publishedAt",password_hash IS NOT NULL AS "hasPassword" FROM posts WHERE id=$1 AND status=\'publish\' AND type=$2',
      [identity.id,identity.type],
    )).rows[0];
    if (identity && !post) return missing();
  }
  if (post) {
    const settings = await getSettings();
    const isPostsPage = post.type === "page" && settings.frontPageMode === "page" && post.id === settings.postsPageId;
    const pingback = !filtered && !isPostsPage ? pingbackHeader(post, settings) : null;
    const isFrontPage = !filtered && settings.frontPageMode === "page" && post.type === "page" && post.id === settings.frontPageId;
    return { status: 200, kind: isPostsPage ? "posts-page" : isFrontPage ? "front-page" : "singular", selectedId: post.id, selectedType: post.type, ...(contentPage ? {contentPage} : {}), ...(pingback ? { pingback } : {}) };
  }
  if (root && fixed.kind === "none") {
    const settings = await getSettings();
    return settings.frontPageMode === "page" && settings.frontPageId ? missing() : {status:200,kind:"home"};
  }
  const archive=await resolvePublicArchive(path);
  return archive ? {status:200,kind:"archive",archive} : missing();
}

/** Retained metadata-only status helper; it never reads body columns. */
export async function publicDocumentIdentity(path: string): Promise<{status:200|404;pingback?:string}> {
  const {status,pingback}=await resolvePublicDocumentRoute(path);
  return {status,...(pingback?{pingback}:{})};
}
