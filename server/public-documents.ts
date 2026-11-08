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
type DocumentIdentity = { status: 200 | 404; pingback?: string };

/** Choose HTTP status from public metadata, never bodies, tokens or internal HTTP. */
export async function publicDocumentIdentity(path: string): Promise<DocumentIdentity> {
  const { pathname, segments, query } = readPublicPath(path);
  // React matches framework route literals without regard to case and decodes
  // each segment. Do not turn an encoded slash into a new route boundary.
  const route = "/" + segments.map(segment => segment.replaceAll("/", "%2F")).join("/").toLowerCase();
  if (frameworkPaths.has(route) || /^\/wp-admin(?:\/|$)/.test(route) ||
    /^\/(?:preview\/[^/]+|admin\/(?:posts|pages|content|media|users)\/[^/]+)$/.test(route))
    return { status: 200 };

  const fixed = readPlainPermalinkQuery(query);
  if (fixed.kind === "invalid" || (fixed.kind !== "none" && pathname !== "/")) return { status: 404 };
  const root = pathname === "/";
  const filtered = [...query].some(([key, value]) => value && archiveQuery.test(key));
  // Ordinary home/search/archive query paging remains valid even with no results.
  if (root && fixed.kind === "none") {
    if (filtered) return { status: 200 };
    if (query.has("page")) {
      const settings = await getSettings();
      if (settings.frontPageMode !== "page" || !settings.frontPageId) return { status: 200 };
      // A selected static front is a singular document, including body paging.
      // Do not let a stale private/missing selection become ordinary home here.
    }
  }

  let post;
  // These are actual React routes, independent of the current permalink setting.
  if (segments.length === 2 && ["posts", "pages"].includes(segments[0].toLowerCase())) {
    post = (await pool.query(
      'SELECT id,type,status,ping_status AS "pingStatus",published_at AS "publishedAt",password_hash IS NOT NULL AS "hasPassword" FROM posts WHERE slug=$1 AND type=$2 AND status=\'publish\'',
      [segments[1], segments[0].toLowerCase() === "pages" ? "page" : "post"],
    )).rows[0];
    if (!post) return { status: 404 };
  } else {
    const identity = await resolvePublicPath(path);
    if (identity) post = (await pool.query(
      'SELECT id,type,status,ping_status AS "pingStatus",published_at AS "publishedAt",password_hash IS NOT NULL AS "hasPassword" FROM posts WHERE id=$1 AND status=\'publish\' AND type IN (\'post\',\'page\')',
      [identity.id],
    )).rows[0];
    if (identity && !post) return { status: 404 };
  }
  if (post) {
    const settings = await getSettings();
    const isPostsPage = post.type === "page" && settings.frontPageMode === "page" && post.id === settings.postsPageId;
    const pingback = !filtered && !isPostsPage ? pingbackHeader(post, settings) : null;
    return { status: 200, ...(pingback ? { pingback } : {}) };
  }
  if (root && fixed.kind === "none") {
    const settings = await getSettings();
    return { status: settings.frontPageMode === "page" && settings.frontPageId ? 404 : 200 };
  }
  return { status: await resolvePublicArchive(path) ? 200 : 404 };
}
