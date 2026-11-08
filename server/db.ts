import dotenv from "dotenv";
import pg from "pg";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { withPermalink } from "./permalinks.js";
import type { PostFormat } from "../shared/post-formats.js";
import { normalizeFixedTimezone } from "./timezone.js";
import { ORIGINAL_UPLOAD_URL_SQL } from "./media-original.js";

export const rootDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
dotenv.config({ path: path.join(rootDir, ".env"), quiet: true });
// Isolated regression runs use a disposable filesystem alongside their database.
export const uploadsDir = path.resolve(process.env.WORLDACT_UPLOADS_DIR || path.join(rootDir, "uploads"));
export const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  max: 10,
  connectionTimeoutMillis: 5_000,
  idleTimeoutMillis: 30_000,
});
// Pool's idle listener is removed on checkout. A dead checked-out Client also
// emits error after rejecting its queries; observe that event so request catches
// can roll back/release. pg marks it nonqueryable and evicts it on release.
// Register once per physical connection, never once per borrow, and log no SQL,
// credentials or server-provided error detail here. Query errors still reject.
pool.on("connect", (client) => {
  client.on("error", () => console.error("Database client connection failed."));
});
pool.on("error", (error) =>
  console.error("Database pool error:", error.message),
);

export type Role =
  | "administrator"
  | "editor"
  | "author"
  | "contributor"
  | "subscriber";
export interface User {
  id: number;
  username: string;
  email: string;
  displayName: string;
  role: Role;
  createdAt: Date;
  showAdminBar?: boolean;
  commentShortcuts?: boolean;
}
export const userFields = `id, username, email, display_name AS "displayName", role, created_at AS "createdAt"`;
export const postMetadataFields = `p.id,p.type,p.title,p.slug,p.status,p.parent_id AS "parentId",p.published_at AS "publishedAt",p.created_at AS "createdAt",p.updated_at AS "updatedAt",p.author_id AS "authorId",(p.password_hash IS NOT NULL) AS "hasPassword",
  COALESCE((SELECT jsonb_build_array(jsonb_build_object('slug',t.slug)) FROM post_terms pt JOIN terms t ON t.id=pt.term_id WHERE pt.post_id=p.id AND t.taxonomy='category' ORDER BY t.id LIMIT 1),'[]'::jsonb) AS categories`;
export const postFields = `p.id, p.type, p.title, p.slug, p.content,p.raw_content AS "rawContent", p.excerpt, p.status, p.pre_trash_status AS "preTrashStatus", p.format,
  p.author_id AS "authorId", u.display_name AS "authorName", p.created_at AS "createdAt",
  p.updated_at AS "updatedAt", p.published_at AS "publishedAt", p.scheduled_at AS "scheduledAt",
  p.blocks, p.footnotes, p.version, p.parent_id AS "parentId", p.menu_order AS "menuOrder",p.template_slug AS "templateSlug",
  p.featured_media_id AS "featuredMediaId", p.comment_status AS "commentStatus", p.ping_status AS "pingStatus", p.sticky,
  (p.password_hash IS NOT NULL) AS "hasPassword",
  (SELECT count(*)::int FROM comments c WHERE c.post_id=p.id AND c.status IN('approved','pending')) AS "commentCount",
  (SELECT count(*)::int FROM comments c WHERE c.post_id=p.id AND c.status='approved') AS "approvedCommentCount",
  (SELECT count(*)::int FROM comments c WHERE c.post_id=p.id AND c.status='pending') AS "pendingCommentCount",
  COALESCE((SELECT jsonb_agg(jsonb_build_object('id',t.id,'taxonomy',t.taxonomy,'name',t.name,'slug',t.slug,'description',t.description,'parentId',t.parent_id,'count',(SELECT count(*)::int FROM post_terms counted JOIN posts counted_post ON counted_post.id=counted.post_id WHERE counted.term_id=t.id AND counted_post.status='publish')) ORDER BY t.name,t.id)
    FROM post_terms pt JOIN terms t ON t.id=pt.term_id WHERE pt.post_id=p.id), '[]'::jsonb) AS terms`;
export const mediaFields = `id, title, '/uploads/' || filename AS url, mime_type AS "mimeType", filename,
  ${ORIGINAL_UPLOAD_URL_SQL} AS "originalUploadUrl",
  alt, caption, size, audio_metadata AS "audioMetadata", artwork_media_id AS "artworkMediaId",
  (SELECT jsonb_build_object('id',art.id,'src','/uploads/' || art.filename,'alt',art.alt,'width',art.width,'height',art.height) FROM media art WHERE art.id=media.artwork_media_id AND art.mime_type LIKE 'image/%') AS image,
  created_at AS "createdAt"`;
export const commentFields = `c.id, c.author_name AS "authorName", c.author_email AS "authorEmail",
  c.author_url AS "authorUrl",c.user_id AS "userId",c.content, c.type, c.status, c.version,c.updated_at AS "updatedAt",c.parent_id AS "parentId", c.post_id AS "postId", p.title AS "postTitle", c.created_at AS "createdAt"`;

export const defaultSettings = {
  siteTitle: "WorldAct",
  tagline: "Just another WorldAct site",
  siteUrl: process.env.APP_ORIGIN || "http://127.0.0.1:5173",
  adminEmail: process.env.ADMIN_EMAIL || "admin@worldact.local",
  usersCanRegister: false,
  defaultRole: "subscriber" as Role,
  siteLogoId: 0,
  siteIconId: 0,
  timezone: "America/Los_Angeles",
  dateFormat: "F j, Y",
  timeFormat: "g:i a",
  weekStartsOn: 1,
  postsPerPage: 10,
  discourageSearchEngines: false,
  theme: "twentytwentyfive" as
    | "twentytwentyfive"
    | "twentytwentyfour"
    | "twentytwentythree"
    | "classic",
  defaultCategoryId: null as number | null,
  defaultPingbackFlag: true,
  pingServices: ["https://rpc.pingomatic.com/"],
  defaultPostFormat: "standard" as PostFormat,
  frontPageMode: "posts" as "posts" | "page",
  frontPageId: null as number | null,
  postsPageId: null as number | null,
  feedItems: 10,
  feedExcerpt: false,
  defaultCommentStatus: "open" as "open" | "closed",
  defaultPingStatus: "open" as "open" | "closed",
  requireCommentNameEmail: true,
  commentRegistration: false,
  commentModeration: true,
  commentMaxLinks: 2,
  commentModerationKeys: "",
  disallowedCommentKeys: "",
  commentPreviouslyApproved: false,
  notifyComments: false,
  notifyModeration: false,
  showAvatars: true,
  avatarRating: "G" as "G" | "PG" | "R" | "X",
  defaultAvatar: "mystery" as "mystery" | "blank" | "identicon" | "wavatar" | "monsterid" | "retro",
  commentCookieConsent: true,
  paginateComments: true,
  defaultCommentPage: "oldest" as "oldest" | "newest",
  commentsPerPage: 50,
  threadComments: true,
  threadDepth: 5,
  closeCommentsDays: 0,
  commentOrder: "asc" as "asc" | "desc",
  permalinkStructure: "/posts/%postname%/",
  categoryBase: "category",
  tagBase: "tag",
  thumbnailWidth: 150,
  thumbnailHeight: 150,
  thumbnailCrop: true,
  mediumWidth: 300,
  mediumHeight: 300,
  largeWidth: 1024,
  largeHeight: 1024,
  uploadsYearMonth: true,
  privacyPageId: null as number | null,
};
export async function getSettings(
  db: Pick<pg.Pool, "query"> | pg.PoolClient = pool,
) {
  const result = await db.query<{ data: Partial<typeof defaultSettings> }>(
    "SELECT data FROM settings WHERE id = 1",
  );
  const settings = { ...defaultSettings, ...result.rows[0]?.data };
  return { ...settings, timezone: normalizeFixedTimezone(settings.timezone) };
}

export async function getPost(
  id: number,
  db: Pick<pg.Pool, "query"> | pg.PoolClient = pool,
) {
  const result = await db.query(
    `SELECT ${postFields},p.raw_content AS "rawContent" FROM posts p JOIN users u ON u.id = p.author_id WHERE p.id = $1`,
    [id],
  );
  const post = result.rows[0];
  if (post) {
    post.categories = post.terms.filter(
      (term: { taxonomy: string }) => term.taxonomy === "category",
    );
    post.tags = post.terms.filter(
      (term: { taxonomy: string }) => term.taxonomy === "tag",
    );
    post.categoryIds = post.categories.map((term: { id: number }) => term.id);
    post.tagIds = post.tags.map((term: { id: number }) => term.id);
  }
  return post ? withPermalink(post, undefined, db) : post;
}
export async function getComment(id: number) {
  const result = await pool.query(
    `SELECT ${commentFields} FROM comments c JOIN posts p ON p.id = c.post_id WHERE c.id = $1`,
    [id],
  );
  return result.rows[0];
}
