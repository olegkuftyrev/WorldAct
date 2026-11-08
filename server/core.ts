import {pingbackHeader} from "./incoming-ping-policy.js";
import {moderateComment,renderedCommentContent} from "./comment-policy.js";
export {matchesCommentKeywords} from "./comment-policy.js";
import {enqueuePublicationPings} from "./outgoing-pings.js";
import {checkAkismetComment,recordAkismetCheck,type AkismetComment} from "./bundled-plugins.js";
import { Router, type Request, type Response } from "express";
import { createHash, randomBytes } from "node:crypto";
import type { PoolClient } from "pg";
import { z } from "zod";
import { pool, getPost, getSettings, postFields, type User } from "./db.js";
import {
  hashPassword,
  verifyPassword,
  requireRole,
  type AuthRequest,
} from "./auth.js";
import {
  HttpError,
  parseId,
  needUser,
  cleanContent,
  plainText,
  slugify,
  cleanBlocks,
  cleanRawContent,
} from "./utils.js";
import { enhancePublicPost, classifySpam } from "./design.js";
import { withPermalink } from "./permalinks.js";
import { renderPublicContent, type RenderOptions } from "./block-renderer.js";
import { postAccessReader } from "./post-passwords.js";
import { queueMail, deliverMail } from "./accounts.js";
import {validatePostTemplate} from "./post-templates.js";
import { avatarURL } from "./avatars.js";
import { assertEditLease } from "./edit-lease.js";
import { postFormats } from "../shared/post-formats.js";
import { contributorCanEditPostStatus } from "./comment-access.js";
import { appendDateArchiveSQL, dateArchiveDTO, parseDateArchiveQuery } from "./date-archives.js";
import { parseFootnotes } from "./footnotes.js";
import { withPreviewAutosave } from "./post-preview.js";
import { contentPagination, parseContentPage } from "./legacy-content.js";

const router = Router();
const contentRoles = requireRole(
  "administrator",
  "editor",
  "author",
  "contributor",
);
const manageTerms = requireRole("administrator", "editor", "author");
const statuses = [
  "publish",
  "draft",
  "pending",
  "future",
  "private",
  "trash",
] as const;
const idSchema = z.number().int().positive().max(2_147_483_647);
const idsSchema = z
  .array(idSchema)
  .max(500)
  .transform((ids) => [...new Set(ids)]);
const dateSchema = z.iso.datetime({ offset: true }).nullable();
const postShape = {
  authorId: idSchema.optional(),
  type: z.enum(["post", "page"]).optional(),
  format: z.enum(postFormats).optional(),
  title: z.string().trim().max(300).optional(),
  content: z.string().max(1_000_000).optional(),
  excerpt: z.string().max(20_000).optional(),
  status: z.enum(statuses).optional(),
  slug: z.string().max(220).optional(),
  blocks: z.array(z.unknown()).max(2000).optional(),
  footnotes: z.unknown().transform(parseFootnotes).optional(),
  version: idSchema.optional(),
  scheduledAt: dateSchema.optional(),
  publishedAt: dateSchema.optional(),
  parentId: idSchema.nullable().optional(),
  menuOrder: z.number().int().min(-2_147_483_648).max(2_147_483_647).optional(),
  templateSlug:z.string().max(160).regex(/^[a-zA-Z0-9_-]*$/).optional(),
  featuredMediaId: idSchema.nullable().optional(),
  commentStatus: z.enum(["open", "closed"]).optional(),
  pingStatus: z.enum(["open", "closed"]).optional(),
  sticky: z.boolean().optional(),
  password: z.string().max(1024).optional(),
  categoryIds: idsSchema.optional(),
  tagIds: idsSchema.optional(),
};
const createSchema = z.object(postShape).strict();
const updateSchema = z
  .object(postShape)
  .strict()
  .refine(
    (input) => Object.keys(input).some((key) => key !== "version"),
    "Provide at least one field to update.",
  );
type PostInput = z.infer<typeof createSchema>;
// Only the internal mail wrapper can relax the normal author-role check for a
// new pending post. This authority cannot be supplied by any request body.
const mailPostAuthority = Symbol("pending-mail-post");
function ownOnly(user: User) {
  return user.role === "author" || user.role === "contributor";
}
export function assertPostAccess(
  user: User,
  post: { authorId: number; type: string; status: string; preTrashStatus?: string | null },
) {
  if (ownOnly(user) && post.authorId !== user.id)
    throw new HttpError(403, "You can only edit your own content.");
  if (ownOnly(user) && post.type === "page")
    throw new HttpError(
      403,
      "Editing pages requires an editor or administrator.",
    );
  if (
    user.role === "contributor" &&
    !contributorCanEditPostStatus(post)
  )
    throw new HttpError(
      403,
      "Contributors can only edit their own drafts and pending posts.",
    );
}
function assertNewAccess(user: User, type: string, status: string, existingStatus?: string) {
  if (ownOnly(user) && type === "page")
    throw new HttpError(
      403,
      "Editing pages requires an editor or administrator.",
    );
  if (
    user.role === "contributor" &&
    !["draft", "pending", "trash"].includes(status) &&
    !(status === "private" && existingStatus === "private")
  )
    throw new HttpError(
      403,
      "Contributors can save drafts or submit posts for review; publishing requires an editor.",
    );
}
export async function lockPostMutationUsers(client: PoolClient, user: User, authorId?: number) {
  if (authorId !== undefined && ownOnly(user) && authorId !== user.id)
    throw new HttpError(403, "You can only assign content to yourself.");
  // Account deletion locks users before posts. Lock both the acting account and
  // any newly assigned author in one stable order before acquiring post locks:
  // revisions, autosaves and edit leases also insert foreign keys to the actor.
  const ids = [...new Set([user.id, ...(authorId === undefined ? [] : [authorId])])].sort((a, b) => a - b);
  const people = await client.query<{ id: number; role: string }>(
    "SELECT id,role FROM users WHERE id=ANY($1::int[]) ORDER BY id FOR SHARE", [ids],
  );
  const actor = people.rows.find(person => person.id === user.id);
  if (!actor) throw new HttpError(401, "Your account is no longer available. Sign in again.");
  if (actor.role !== user.role) throw new HttpError(409, "Your permissions changed. Reload before saving.");
  if (authorId !== undefined) {
    const target = people.rows.find(person => person.id === authorId);
    if (!target || !["administrator", "editor", "author", "contributor"].includes(target.role))
      throw new HttpError(400, "Choose an existing author who can create content.");
  }
}
async function validateAuthor(client: PoolClient, authorId: number, user: User) {
  await lockPostMutationUsers(client, user, authorId);
}
function decoratePost(post: any) {
  post.terms ??= [];
  post.categories = post.terms.filter(
    (term: any) => term.taxonomy === "category",
  );
  post.tags = post.terms.filter((term: any) => term.taxonomy === "tag");
  post.categoryIds = post.categories.map((term: any) => term.id);
  post.tagIds = post.tags.map((term: any) => term.id);
  return post;
}
async function transaction<T>(work: (client: PoolClient) => Promise<T>) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await work(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
async function lockedPost(client: PoolClient, id: number, user: User, authorId?: number) {
  await lockPostMutationUsers(client, user, authorId);
  const locked = await client.query(
    "SELECT id,password_hash FROM posts WHERE id=$1 FOR NO KEY UPDATE",
    [id],
  );
  if (!locked.rows[0]) throw new HttpError(404, "Post not found.");
  const post = await getPost(id, client);
  assertPostAccess(user, post);
  await assertEditLease(client, id, user.id);
  return { post, passwordHash: locked.rows[0].password_hash as string | null };
}
function checkVersion(input: { version?: number }, post: { version: number }) {
  if (input.version !== undefined && input.version !== post.version)
    throw new HttpError(
      409,
      "This post was changed by another editor. Reload the latest version before saving.",
    );
}
async function validateParent(
  client: PoolClient,
  parentId: number | null,
  type: string,
  id?: number,
) {
  if (parentId === null) return;
  if (type !== "page")
    throw new HttpError(400, "Only pages can have a parent page.");
  // All parent edits share a lock, preventing simultaneous edits from forming a cycle.
  await client.query(
    "SELECT pg_advisory_xact_lock(hashtext('worldact-page-hierarchy'))",
  );
  const parent = await client.query("SELECT type FROM posts WHERE id=$1", [
    parentId,
  ]);
  if (parent.rows[0]?.type !== "page")
    throw new HttpError(400, "Choose an existing page as the parent.");
  if (id) {
    const cycle = await client.query(
      `WITH RECURSIVE ancestors AS (SELECT id,parent_id FROM posts WHERE id=$1 UNION SELECT p.id,p.parent_id FROM posts p JOIN ancestors a ON p.id=a.parent_id) SELECT 1 FROM ancestors WHERE id=$2 LIMIT 1`,
      [parentId, id],
    );
    if (cycle.rowCount)
      throw new HttpError(400, "A page cannot be its own ancestor.");
  }
}
async function validateMedia(
  client: PoolClient,
  mediaId: number | null,
  user: User,
) {
  if (mediaId === null) return;
  const result = await client.query("SELECT author_id FROM media WHERE id=$1", [
    mediaId,
  ]);
  if (!result.rows[0])
    throw new HttpError(400, "The featured media item no longer exists.");
  if (ownOnly(user) && result.rows[0].author_id !== user.id)
    throw new HttpError(
      403,
      "Choose a featured image from your own media library.",
    );
}
async function resolveTerms(
  client: PoolClient,
  type: string,
  categoryIds: number[],
  tagIds: number[],
) {
  if (type !== "post") {
    if (categoryIds.length || tagIds.length)
      throw new HttpError(
        400,
        "Categories and tags can only be assigned to posts.",
      );
    return [] as number[];
  }
  if (!categoryIds.length) {
    const configured = await client.query(
      "SELECT t.id FROM terms t JOIN settings s ON s.id=1 WHERE t.taxonomy='category' AND t.id::text=s.data->>'defaultCategoryId'",
    );
    const result = configured.rowCount
      ? configured
      : await client.query(
          "SELECT id FROM terms WHERE taxonomy='category' AND is_default",
        );
    categoryIds = [result.rows[0].id];
  }
  const ids = [...categoryIds, ...tagIds];
  const existing = await client.query(
    "SELECT id,taxonomy FROM terms WHERE id=ANY($1::int[]) FOR KEY SHARE",
    [ids],
  );
  const byId = new Map(existing.rows.map((term) => [term.id, term.taxonomy]));
  if (
    categoryIds.some((id) => byId.get(id) !== "category") ||
    tagIds.some((id) => byId.get(id) !== "tag")
  )
    throw new HttpError(
      400,
      "Choose existing categories and tags with the correct taxonomy.",
    );
  return ids;
}
async function setTerms(client: PoolClient, postId: number, ids: number[]) {
  await client.query(
    "DELETE FROM post_terms WHERE post_id=$1 AND NOT (term_id=ANY($2::int[]))",
    [postId, ids],
  );
  if (ids.length)
    await client.query(
      "INSERT INTO post_terms(post_id,term_id) SELECT $1,unnest($2::int[]) ON CONFLICT DO NOTHING",
      [postId, ids],
    );
}
function metadata(post: any) {
  return {
    footnotes: post.footnotes ?? [],
    preTrashStatus: post.preTrashStatus ?? null,
    authorId: post.authorId,
    format: post.format ?? "standard",
    templateSlug:post.templateSlug || "",
    parentId: post.parentId,
    menuOrder: post.menuOrder,
    featuredMediaId: post.featuredMediaId,
    commentStatus: post.commentStatus,
    pingStatus: post.pingStatus,
    sticky: post.sticky,
    scheduledAt: post.scheduledAt,
    categoryIds: [...(post.categoryIds ?? [])].sort(
      (a: number, b: number) => a - b,
    ),
    tagIds: [...(post.tagIds ?? [])].sort((a: number, b: number) => a - b),
  };
}
async function saveRevision(client: PoolClient, post: any, userId: number) {
  await client.query(
    `INSERT INTO post_revisions(post_id,author_id,title,content,excerpt,blocks,slug,status,version,metadata,raw_content) VALUES($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9,$10::jsonb,$11)`,
    [
      post.id,
      userId,
      post.title,
      post.content,
      post.excerpt,
      JSON.stringify(post.blocks),
      post.slug,
      post.status,
      post.version,
      JSON.stringify(metadata(post)),
      post.rawContent ?? "",
    ],
  );
  await client.query(
    "DELETE FROM post_revisions WHERE post_id=$1 AND id NOT IN (SELECT id FROM post_revisions WHERE post_id=$1 ORDER BY id DESC LIMIT 100)",
    [post.id],
  );
}
function comparable(post: any) {
  return JSON.stringify([
    post.type,
    post.title,
    post.slug,
    post.content,
    post.rawContent ?? "",
    post.excerpt,
    post.blocks,
    metadata(post),
  ]);
}
async function savePost(
  client: PoolClient,
  input: PostInput,
  user: User,
  existing?: any,
  oldPasswordHash?: string | null,
  authority?: typeof mailPostAuthority,
) {
  const type = input.type ?? existing?.type ?? "post";
  const templateSlug=input.templateSlug ?? existing?.templateSlug ?? "";
  if(input.templateSlug!==undefined || (input.type!==undefined && type!==existing?.type))await validatePostTemplate(templateSlug,type,client);
  const authorId = input.authorId ?? existing?.authorId ?? user.id;
  if (authority === mailPostAuthority) {
    if (existing || type !== "post" || input.status !== "pending" || authorId !== user.id)
      throw new HttpError(400, "Invalid mail post authority.");
    const account = (await client.query("SELECT role FROM users WHERE id=$1 FOR SHARE", [authorId])).rows[0];
    if (!account || account.role !== user.role) throw new HttpError(409, "The mail author changed. Check mail again.");
  } else if (!existing || input.authorId !== undefined) await validateAuthor(client, authorId, user);
  let status = input.status ?? existing?.status ?? "draft";
  assertNewAccess(user, type, status, existing?.status);
  if (input.sticky !== undefined && input.sticky !== (existing?.sticky ?? false) && ownOnly(user))
    throw new HttpError(403, "Making a post sticky requires an editor or administrator.");
  if (type === "page" && input.sticky)
    throw new HttpError(400, "Only posts can be sticky.");
  let scheduledAt =
    input.scheduledAt !== undefined
      ? input.scheduledAt
      : (existing?.scheduledAt ?? null);
  if (status === "future") {
    if (!scheduledAt)
      throw new HttpError(
        400,
        "Choose a publication date before scheduling this post.",
      );
    if (new Date(scheduledAt).getTime() <= Date.now()) {
      status = "publish";
      assertNewAccess(user, type, status, existing?.status);
    }
  }
  const title =
    input.title === undefined
      ? (existing?.title ?? "")
      : plainText(input.title);
  const content =
    input.content === undefined
      ? (existing?.content ?? "")
      : cleanContent(input.content);
  const rawContent =
    input.content === undefined
      ? (existing?.rawContent ?? "")
      : cleanRawContent(input.content);
  const excerpt =
    input.excerpt === undefined
      ? (existing?.excerpt ?? "")
      : plainText(input.excerpt);
  // HTML-only clients cannot update an older block tree. The editor reparses
  // canonical rawContent when there is no JSON tree, avoiding stale overwrites.
  const blocks =
    input.blocks !== undefined
      ? cleanBlocks(input.blocks)
      : input.content !== undefined
        ? []
        : (existing?.blocks ?? []);
  const parentId =
    input.parentId !== undefined
      ? input.parentId
      : type === "page"
        ? (existing?.parentId ?? null)
        : null;
  const featuredMediaId =
    input.featuredMediaId !== undefined
      ? input.featuredMediaId
      : (existing?.featuredMediaId ?? null);
  if (existing?.type === "page" && type !== "page") {
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtext('worldact-page-hierarchy'))",
    );
    const children = await client.query(
      "SELECT 1 FROM posts WHERE parent_id=$1 LIMIT 1",
      [existing.id],
    );
    if (children.rowCount)
      throw new HttpError(
        400,
        "Move this page's child pages before converting its post type.",
      );
  }
  await validateParent(client, parentId, type, existing?.id);
  await validateMedia(client, featuredMediaId, user);
  const termIds = await resolveTerms(
    client,
    type,
    input.categoryIds ??
      (type === existing?.type ? existing?.categoryIds : []) ??
      [],
    input.tagIds ?? (type === existing?.type ? existing?.tagIds : []) ?? [],
  );
  const terms = (
    await client.query(
      "SELECT id,taxonomy FROM terms WHERE id=ANY($1::int[]) ORDER BY id",
      [termIds],
    )
  ).rows;
  const settings = existing ? undefined : await getSettings(client);
  if (type === "page" && input.format && input.format !== "standard")
    throw new HttpError(400, "Post formats can only be assigned to posts.");
  const format =
    type === "post"
      ? (input.format ??
        existing?.format ??
        settings?.defaultPostFormat ??
        "standard")
      : "standard";
  const preTrashStatus = status === "trash"
    ? existing?.status === "trash" ? existing.preTrashStatus ?? null : existing?.status ?? "draft"
    : null;
  const values = {
    type,
    authorId,
    format,
    templateSlug,
    title,
    content,
    rawContent,
    excerpt,
    blocks,
    footnotes: input.footnotes ?? existing?.footnotes ?? [],
    parentId,
    featuredMediaId,
    status,
    preTrashStatus,
    scheduledAt,
    menuOrder: input.menuOrder ?? existing?.menuOrder ?? 0,
    commentStatus:
      input.commentStatus ??
      existing?.commentStatus ??
      settings?.defaultCommentStatus ??
      "open",
    pingStatus: input.pingStatus ?? existing?.pingStatus ?? (type === "post" ? settings?.defaultPingStatus ?? "open" : "closed"),
    sticky: type === "post" ? input.sticky ?? existing?.sticky ?? false : false,
    categoryIds: terms
      .filter((term) => term.taxonomy === "category")
      .map((term) => term.id),
    tagIds: terms
      .filter((term) => term.taxonomy === "tag")
      .map((term) => term.id),
    slug:
      input.slug === undefined
        ? (existing?.slug ?? slugify(title))
        : slugify(input.slug || title),
  };
  const passwordHash =
    input.password !== undefined
      ? input.password
        ? await hashPassword(input.password)
        : null
      : (oldPasswordHash ?? null);
  let publishedAt =
    input.publishedAt !== undefined
      ? input.publishedAt
      : (existing?.publishedAt ?? null);
  if (status === "publish" && !publishedAt)
    publishedAt =
      scheduledAt && new Date(scheduledAt) <= new Date()
        ? scheduledAt
        : new Date();
  if (existing && comparable(existing) !== comparable(values))
    await saveRevision(client, existing, user.id);
  const baseSlug = values.slug;
  for (let suffix = 0; suffix < 1000; suffix++) {
    const slug = baseSlug + (suffix ? `-${suffix + 1}` : "");
    // Serialize slug allocation across all writers without aborting transactions on a collision.
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtext('worldact-post-slug'))",
    );
    const collision = await client.query(
      "SELECT id FROM posts WHERE slug=$1 AND id<>$2",
      [slug, existing?.id ?? 0],
    );
    if (collision.rowCount) continue;
    const args: unknown[] = [
      type,
      title,
      slug,
      content,
      excerpt,
      status,
      JSON.stringify(blocks),
      scheduledAt,
      parentId,
      values.menuOrder,
      featuredMediaId,
      values.commentStatus,
      values.sticky,
      passwordHash,
      publishedAt,
      rawContent,
      format,
      authorId,
      values.pingStatus,
    ];
    let id: number;
    if (existing) {
      args.push(existing.id);
      await client.query(
        `UPDATE posts SET type=$1,title=$2,slug=$3,content=$4,excerpt=$5,status=$6,blocks=$7::jsonb,scheduled_at=$8,parent_id=$9,menu_order=$10,featured_media_id=$11,comment_status=$12,sticky=$13,password_hash=$14,published_at=$15,raw_content=$16,format=$17,author_id=$18,ping_status=$19,version=version+1,updated_at=now() WHERE id=$20`,
        args,
      );
      id = existing.id;
    } else {
      const created = await client.query(
        `INSERT INTO posts(type,title,slug,content,excerpt,status,blocks,scheduled_at,parent_id,menu_order,featured_media_id,comment_status,sticky,password_hash,published_at,raw_content,format,author_id,ping_status) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19) RETURNING id`,
        args,
      );
      id = created.rows[0].id;
    }
    await client.query("UPDATE posts SET template_slug=$1,pre_trash_status=$2,footnotes=$3::jsonb WHERE id=$4",[templateSlug,preTrashStatus,JSON.stringify(values.footnotes),id]);
    await setTerms(client, id, termIds);
    if (input.password !== undefined)
      await client.query("DELETE FROM post_access_tokens WHERE post_id=$1", [
        id,
      ]);
    await client.query(
      "DELETE FROM post_autosaves WHERE post_id=$1 AND user_id=$2",
      [id, user.id],
    );
    await enqueuePublicationPings(client,id);
    return getPost(id, client);
  }
  throw new HttpError(409, "Please choose a different permalink.");
}

/** Caller owns the transaction and has locked/rechecked its operator and mailbox.
 * Email headers are claimed sender identities, never an authenticated session. */
export async function createMailPost(
  client: PoolClient,
  author: User,
  input: { title: string; content: string; categoryId: number | null; date: string | null },
  recognized: boolean,
) {
  const publishing = recognized && ["administrator", "editor", "author"].includes(author.role);
  const future = publishing && input.date !== null && Date.parse(input.date) > Date.now() + 60_000;
  const data = createSchema.parse({
    type: "post", authorId: author.id, title: input.title, content: input.content,
    categoryIds: input.categoryId === null ? [] : [input.categoryId],
    status: future ? "future" : publishing ? "publish" : "pending",
    ...(future ? { scheduledAt: input.date } : input.date ? { publishedAt: input.date } : {}),
  });
  return savePost(client, data, author, undefined, undefined,
    !publishing ? mailPostAuthority : undefined);
}

export async function publishDuePosts(
  now: Date = new Date(),
  postIds?: number[],
) {
  const client=await pool.connect();
  try{
    await client.query("BEGIN");
    const result=await client.query("UPDATE posts SET status='publish',published_at=scheduled_at,updated_at=now(),version=version+1 WHERE status='future' AND scheduled_at <= $1 AND ($2::int[] IS NULL OR id=ANY($2::int[])) RETURNING id",[now,postIds ?? null]);
    for(const row of result.rows)await enqueuePublicationPings(client,row.id);
    await client.query("COMMIT");return result.rows.map(row=>row.id as number);
  }catch(error){await client.query("ROLLBACK");throw error;}finally{client.release();}
}
export function startScheduler(intervalMs = 30_000) {
  let lastPluginCleanup=0;
  const publish = () => {
    if(Date.now()-lastPluginCleanup>=60*60_000){lastPluginCleanup=Date.now();void pool.query("DELETE FROM akismet_comment_checks WHERE expires_at<=now()").catch(()=>{});}
    void publishDuePosts().catch((error) =>
      console.error("Scheduled publication failed:", error.message),
    );
  };
  publish();
  const interval = setInterval(publish, intervalMs);
  interval.unref();
  return () => clearInterval(interval);
}

router.get("/posts", contentRoles, async (req: AuthRequest, res) => {
  const user = needUser(req);
  const filter = z
    .object({
      type: z.enum(["post", "page"]).default("post"),
      status: z.enum(["all", ...statuses]).default("all"),
      search: z.string().trim().max(200).default(""),
      page: z.coerce.number().int().min(1).max(2_147_483_647).optional(),
      perPage: z.coerce.number().int().min(1).max(100).optional(),
      orderby: z
        .enum(["title", "date", "modified", "menuOrder"])
        .default("modified"),
      order: z.enum(["asc", "desc"]).default("desc"),
      category: z.coerce.number().int().positive().optional(),
      author: z.coerce.number().int().positive().optional(),
      tag: z.coerce.number().int().positive().optional(),
      term: z.coerce.number().int().positive().optional(),
      month: z
        .string()
        .regex(/^\d{4}-(?:0[1-9]|1[0-2])$/)
        .optional(),
    })
    .parse(req.query);
  if (ownOnly(user) && filter.type === "page")
    throw new HttpError(
      403,
      "Editing pages requires an editor or administrator.",
    );
  const args: unknown[] = [filter.type];
  let where = "p.type=$1";
  if (ownOnly(user)) {
    args.push(user.id);
    where += ` AND p.author_id=$${args.length}`;
  }
  if (filter.search) {
    args.push(`%${filter.search}%`);
    where += ` AND (p.title ILIKE $${args.length} OR p.content ILIKE $${args.length})`;
  }
  if (filter.author) { args.push(filter.author); where += ` AND p.author_id=$${args.length}`; }
  for (const [taxonomy, id] of [
    ["category", filter.category],
    ["tag", filter.tag],
    [null, filter.term],
  ] as const)
    if (id) {
      args.push(id);
      where += ` AND EXISTS(SELECT 1 FROM post_terms pt JOIN terms t ON t.id=pt.term_id WHERE pt.post_id=p.id AND t.id=$${args.length}${taxonomy ? ` AND t.taxonomy='${taxonomy}'` : ""})`;
    }
  if (filter.month) {
    args.push(filter.month);
    where += ` AND to_char(p.created_at AT TIME ZONE 'UTC','YYYY-MM')=$${args.length}`;
  }
  const counts = await pool.query(
    `SELECT count(*) FILTER(WHERE status<>'trash')::int AS all,${statuses.map((status) => `count(*) FILTER(WHERE status='${status}')::int AS ${status}`).join(",")} FROM posts p WHERE ${where}`,
    args,
  );
  if (filter.status === "all") where += " AND p.status<>'trash'";
  else {
    args.push(filter.status);
    where += ` AND p.status=$${args.length}`;
  }
  const count = await pool.query(
    `SELECT count(*)::int AS total FROM posts p WHERE ${where}`,
    args,
  );
  const totalPosts = count.rows[0].total;
  const page = filter.page ?? 1;
  const perPage =
    filter.perPage ?? (filter.page ? 20 : Math.max(1, totalPosts));
  let limit = "";
  if (filter.page !== undefined || filter.perPage !== undefined) {
    args.push(perPage, (page - 1) * perPage);
    limit = ` LIMIT $${args.length - 1} OFFSET $${args.length}`;
  }
  const column = {
    title: "p.title",
    date: "p.created_at",
    modified: "p.updated_at",
    menuOrder: "p.menu_order",
  }[filter.orderby];
  const posts = await pool.query(
    `SELECT ${postFields} FROM posts p JOIN users u ON u.id=p.author_id WHERE ${where} ORDER BY ${column} ${filter.order},p.id ${filter.order}${limit}`,
    args,
  );
  res.json({
    posts: await Promise.all(
      posts.rows.map((post) => withPermalink(decoratePost(post))),
    ),
    counts: counts.rows[0],
    pagination: {
      page,
      perPage,
      totalPosts,
      totalPages: Math.max(1, Math.ceil(totalPosts / perPage)),
    },
  });
});
router.get("/authors", contentRoles, async (req: AuthRequest, res) => {
  const user = needUser(req), settings = await getSettings();
  const authors = await pool.query(
    `SELECT id,display_name AS "displayName",username,role FROM users WHERE role IN('administrator','editor','author','contributor')${ownOnly(user) ? " AND id=$1" : ""} ORDER BY lower(display_name),id`,
    ownOnly(user) ? [user.id] : [],
  );
  res.json({ authors: authors.rows, defaults: { format: settings.defaultPostFormat, commentStatus: settings.defaultCommentStatus, pingStatus: settings.defaultPingStatus } });
});
const bulkSchema = z.object({
  ids: z.array(idSchema).min(1).max(100).transform(ids => [...new Set(ids)]),
  changes: z.object({
    authorId: postShape.authorId,
    categoryIds: postShape.categoryIds,
    tagIds: postShape.tagIds,
    parentId: postShape.parentId,
    commentStatus: postShape.commentStatus,
    pingStatus: postShape.pingStatus,
    sticky: postShape.sticky,
    format: postShape.format,
    password: postShape.password,
    status: postShape.status,
    scheduledAt: postShape.scheduledAt,
    menuOrder: postShape.menuOrder,
    templateSlug:postShape.templateSlug,
  }).strict().refine(changes => Object.keys(changes).length > 0, "Choose at least one field to change."),
  categoryMode: z.enum(["add", "replace"]).default("add"),
  tagMode: z.enum(["add", "replace"]).default("add"),
  versions: z.record(z.string().regex(/^[1-9]\d{0,9}$/), idSchema).optional(),
}).strict();
router.post("/posts/bulk", contentRoles, async (req: AuthRequest, res) => {
  const input = bulkSchema.parse(req.body), user = needUser(req);
  const posts: any[] = [], errors: Array<{ id: number; status: number; error: string }> = [];
  for (const id of input.ids) {
    try {
      const saved = await transaction(async client => {
        const { post, passwordHash } = await lockedPost(client, id, user, input.changes.authorId);
        checkVersion({ version: input.versions?.[String(id)] }, post);
        const changes = { ...input.changes };
        if (changes.categoryIds !== undefined && input.categoryMode === "add") changes.categoryIds = [...new Set([...post.categoryIds, ...changes.categoryIds])];
        if (changes.tagIds !== undefined && input.tagMode === "add") changes.tagIds = [...new Set([...post.tagIds, ...changes.tagIds])];
        return savePost(client, changes, user, post, passwordHash);
      });
      posts.push(saved);
    } catch (error) {
      if (error instanceof HttpError) errors.push({ id, status: error.status, error: error.message });
      else {
        const conflict = ["40001", "40P01", "23503"].includes(String((error as { code?: string }).code));
        errors.push({ id, status: conflict ? 409 : 500, error: conflict ? "This content or its author changed during the update. Reload and try again." : "This post could not be updated. Try again." });
      }
    }
  }
  res.json({ updated: posts.map(post => post.id), errors, posts });
});
router.get("/posts/:id", contentRoles, async (req: AuthRequest, res) => {
  const post = await getPost(parseId(req.params.id));
  if (!post) throw new HttpError(404, "Post not found.");
  assertPostAccess(needUser(req), post);
  res.json({ post });
});
router.post("/posts", contentRoles, async (req: AuthRequest, res) => {
  const input = createSchema.parse(req.body);
  const user = needUser(req);
  const post = await transaction(async (client) => {
    await lockPostMutationUsers(client, user, input.authorId ?? user.id);
    return savePost(client, input, user);
  });
  res.status(201).json({ post });
});
router.put("/posts/:id", contentRoles, async (req: AuthRequest, res) => {
  const id = parseId(req.params.id),
    input = updateSchema.parse(req.body),
    user = needUser(req);
  const post = await transaction(async (client) => {
    const { post, passwordHash } = await lockedPost(client, id, user, input.authorId);
    checkVersion(input, post);
    return savePost(client, input, user, post, passwordHash);
  });
  res.json({ post });
});
router.delete("/posts/:id", contentRoles, async (req: AuthRequest, res) => {
  await transaction(async (client) => {
    const { post } = await lockedPost(
      client,
      parseId(req.params.id),
      needUser(req),
    );
    if (post.status !== "trash")
      throw new HttpError(
        409,
        "Move the post to Trash before deleting it permanently.",
      );
    await client.query("DELETE FROM posts WHERE id=$1", [post.id]);
  });
  res.json({ ok: true });
});

const revisionFields = `r.id,r.post_id AS "postId",r.title,r.content,r.raw_content AS "rawContent",r.excerpt,r.blocks,coalesce(r.metadata->'footnotes','[]'::jsonb) AS footnotes,r.slug,r.status,r.version,r.metadata,r.created_at AS "createdAt",coalesce(u.display_name,'Deleted user') AS "authorName"`;
async function authorizedPost(req: AuthRequest) {
  const post = await getPost(parseId(req.params.id));
  if (!post) throw new HttpError(404, "Post not found.");
  assertPostAccess(needUser(req), post);
  return post;
}
router.get(
  "/posts/:id/revisions",
  contentRoles,
  async (req: AuthRequest, res) => {
    const post = await authorizedPost(req);
    const result = await pool.query(
      `SELECT ${revisionFields} FROM post_revisions r LEFT JOIN users u ON u.id=r.author_id WHERE r.post_id=$1 ORDER BY r.id DESC`,
      [post.id],
    );
    res.json({ revisions: result.rows });
  },
);
router.get(
  "/posts/:id/revisions/:revisionId",
  contentRoles,
  async (req: AuthRequest, res) => {
    const post = await authorizedPost(req);
    const result = await pool.query(
      `SELECT ${revisionFields} FROM post_revisions r LEFT JOIN users u ON u.id=r.author_id WHERE r.post_id=$1 AND r.id=$2`,
      [post.id, parseId(req.params.revisionId)],
    );
    if (!result.rows[0]) throw new HttpError(404, "Revision not found.");
    res.json({ revision: result.rows[0] });
  },
);
router.post(
  "/posts/:id/revisions/:revisionId/restore",
  contentRoles,
  async (req: AuthRequest, res) => {
    const id = parseId(req.params.id),
      revisionId = parseId(req.params.revisionId),
      input = z
        .object({ version: idSchema.optional() })
        .strict()
        .parse(req.body ?? {}),
      user = needUser(req);
    const post = await transaction(async (client) => {
      const { post, passwordHash } = await lockedPost(client, id, user);
      checkVersion(input, post);
      const revision = (
        await client.query(
          "SELECT * FROM post_revisions WHERE id=$1 AND post_id=$2",
          [revisionId, id],
        )
      ).rows[0];
      if (!revision) throw new HttpError(404, "Revision not found.");
      return savePost(
        client,
        {
          title: revision.title,
          content: revision.raw_content || revision.content,
          excerpt: revision.excerpt,
          blocks: revision.blocks,
          footnotes: parseFootnotes(revision.metadata?.footnotes ?? []),
          slug: revision.slug,
          format:
            post.type === "post"
              ? (revision.metadata?.format ?? "standard")
              : "standard",
        },
        user,
        post,
        passwordHash,
      );
    });
    res.json({ post });
  },
);
const autosaveShape = {
  title: z.string().trim().max(300).optional(),
  content: z.string().max(1_000_000).optional(),
  excerpt: z.string().max(20_000).optional(),
  blocks: z.array(z.unknown()).max(2000).optional(),
  footnotes: z.unknown().transform(parseFootnotes).optional(),
  version: idSchema.optional(),
};
const autosaveFields = `title,content,raw_content AS "rawContent",excerpt,blocks,footnotes,saved_at AS "savedAt",version`;
router.get(
  "/posts/:id/autosave",
  contentRoles,
  async (req: AuthRequest, res) => {
    const post = await authorizedPost(req);
    const result = await pool.query(
      `SELECT ${autosaveFields} FROM post_autosaves WHERE post_id=$1 AND user_id=$2`,
      [post.id, needUser(req).id],
    );
    res.json({ autosave: result.rows[0] ?? null });
  },
);
router.put(
  "/posts/:id/autosave",
  contentRoles,
  async (req: AuthRequest, res) => {
    const input = z.object(autosaveShape).strict().parse(req.body),
      user = needUser(req);
    const autosave = await transaction(async (client) => {
      const { post } = await lockedPost(client, parseId(req.params.id), user);
      checkVersion(input, post);
      const result = await client.query(
        `INSERT INTO post_autosaves(post_id,user_id,title,content,excerpt,blocks,version,raw_content,footnotes) VALUES($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9::jsonb) ON CONFLICT(post_id,user_id) DO UPDATE SET title=EXCLUDED.title,content=EXCLUDED.content,excerpt=EXCLUDED.excerpt,blocks=EXCLUDED.blocks,version=EXCLUDED.version,raw_content=EXCLUDED.raw_content,footnotes=EXCLUDED.footnotes,saved_at=now() RETURNING ${autosaveFields}`,
        [
          post.id,
          user.id,
          input.title === undefined ? post.title : plainText(input.title),
          input.content === undefined
            ? post.content
            : cleanContent(input.content),
          input.excerpt === undefined ? post.excerpt : plainText(input.excerpt),
          JSON.stringify(
            input.blocks !== undefined
              ? cleanBlocks(input.blocks)
              : input.content !== undefined
                ? []
                : (post.blocks ?? []),
          ),
          post.version,
          input.content === undefined
            ? (post.rawContent ?? "")
            : cleanRawContent(input.content),
          JSON.stringify(input.footnotes ?? post.footnotes ?? []),
        ],
      );
      return result.rows[0];
    });
    res.json({ autosave });
  },
);
router.delete(
  "/posts/:id/autosave",
  contentRoles,
  async (req: AuthRequest, res) => {
    const post = await authorizedPost(req);
    await pool.query(
      "DELETE FROM post_autosaves WHERE post_id=$1 AND user_id=$2",
      [post.id, needUser(req).id],
    );
    res.json({ ok: true });
  },
);

const defaultCategorySQL = `COALESCE(
  (SELECT selected.id FROM terms selected JOIN settings s ON s.id=1 WHERE selected.taxonomy='category' AND selected.id::text=s.data->>'defaultCategoryId'),
  (SELECT fallback.id FROM terms fallback WHERE fallback.taxonomy='category' ORDER BY fallback.is_default DESC,fallback.id LIMIT 1)
)`;
const termFields = `t.id,t.taxonomy,t.name,t.slug,t.description,t.parent_id AS "parentId",COALESCE(t.taxonomy='category' AND t.id=(${defaultCategorySQL}),false) AS "isDefault",(SELECT count(*)::int FROM post_terms pt JOIN posts p ON p.id=pt.post_id WHERE pt.term_id=t.id AND p.status='publish') AS count`;
const termShape = {
  taxonomy: z.enum(["category", "tag"]),
  name: z.string().trim().min(1).max(200),
  slug: z.string().max(220).optional(),
  description: z.string().max(20_000).optional(),
  parentId: idSchema.nullable().optional(),
};
async function validateTermParent(
  client: PoolClient,
  parentId: number | null,
  taxonomy: string,
  id?: number,
) {
  if (parentId === null) return;
  if (taxonomy !== "category")
    throw new HttpError(400, "Tags cannot have a parent.");
  const parent = (
    await client.query("SELECT taxonomy FROM terms WHERE id=$1", [parentId])
  ).rows[0];
  if (parent?.taxonomy !== "category")
    throw new HttpError(400, "Choose an existing category as the parent.");
  if (id) {
    const cycle = await client.query(
      `WITH RECURSIVE ancestors AS(SELECT id,parent_id FROM terms WHERE id=$1 UNION SELECT t.id,t.parent_id FROM terms t JOIN ancestors a ON t.id=a.parent_id) SELECT 1 FROM ancestors WHERE id=$2 LIMIT 1`,
      [parentId, id],
    );
    if (cycle.rowCount)
      throw new HttpError(400, "A category cannot be its own ancestor.");
  }
}
router.get("/terms", contentRoles, async (req, res) => {
  const input = z.object({
    taxonomy: z.enum(["category", "tag"]).optional(),
    page: z.coerce.number().int().positive().max(1_000_000).default(1),
    perPage: z.coerce.number().int().positive().max(1000).default(20),
    search: z.string().trim().max(300).optional(),
    orderby: z.enum(["name", "slug", "description", "count"]).optional(),
    order: z.enum(["asc", "desc"]).default("asc"),
  }).parse(req.query);
  const paged = ["page", "perPage", "search", "orderby", "order"].some(key => Object.hasOwn(req.query, key));
  const args: unknown[] = [], predicates: string[] = [];
  if (input.taxonomy) { args.push(input.taxonomy); predicates.push(`t.taxonomy=$${args.length}`); }
  if (paged && input.search) {
    args.push(`%${input.search.replace(/[\\%_]/g, "\\$&")}%`);
    predicates.push(`(t.name ILIKE $${args.length} OR t.slug ILIKE $${args.length})`);
  }
  const where = predicates.length ? `WHERE ${predicates.join(" AND ")}` : "";
  if (!paged) {
    const result = await pool.query(`SELECT ${termFields} FROM terms t ${where} ORDER BY t.name,t.id`, args);
    res.json({ terms: result.rows }); return;
  }
  const offset = (input.page - 1) * input.perPage;
  let terms: any[], total: number;
  if (input.taxonomy === "category" && !input.orderby && !input.search) {
    // WordPress's default category table pages a complete hierarchy, repeating
    // ancestors when a page begins inside a subtree. Explicit sorting is flat.
    const rows = (await pool.query(`SELECT ${termFields} FROM terms t ${where} ORDER BY lower(t.name) ${input.order},t.id ${input.order}`, args)).rows;
    const byId = new Map(rows.map(row => [row.id, row])), children = new Map<number | null, any[]>();
    for (const row of rows) { const parent = byId.has(row.parentId) ? row.parentId : null; const group = children.get(parent) || []; group.push(row); children.set(parent, group); }
    const ordered: any[] = [], seen = new Set<number>();
    const append = (roots: any[]) => {
      const stack = roots.slice().reverse().map(row => ({ row, depth: 0 }));
      while (stack.length) {
        const item = stack.pop()!; if (seen.has(item.row.id)) continue;
        seen.add(item.row.id); ordered.push({ ...item.row, depth: item.depth });
        for (const child of (children.get(item.row.id) || []).slice().reverse()) stack.push({ row: child, depth: item.depth + 1 });
      }
    };
    append(children.get(null) || []);
    // Retain legacy malformed records without recursive loops or silent loss.
    for (const row of rows) if (!seen.has(row.id)) append([row]);
    total = ordered.length; terms = ordered.slice(offset, offset + input.perPage);
    const first = terms[0], context: any[] = [], ancestors = new Set<number>(terms.map(row => row.id));
    let parent = first?.parentId;
    while (parent && !ancestors.has(parent)) { ancestors.add(parent); const row = byId.get(parent); if (!row) break; context.unshift(row); parent = row.parentId; }
    const depths = new Map(ordered.map(row => [row.id, row.depth]));
    terms = [...context.map(row => ({ ...row, depth: depths.get(row.id) || 0, contextOnly: true })), ...terms];
  } else {
    const column = { name: "lower(t.name)", slug: "t.slug", description: "lower(t.description)", count: '"count"' }[input.orderby || "name"];
    const [count, rows] = await Promise.all([
      pool.query(`SELECT count(*)::int AS total FROM terms t ${where}`, args),
      pool.query(`SELECT ${termFields} FROM terms t ${where} ORDER BY ${column} ${input.order},t.id ${input.order} LIMIT $${args.length + 1} OFFSET $${args.length + 2}`, [...args, input.perPage, offset]),
    ]);
    total = count.rows[0].total; terms = rows.rows;
  }
  res.json({ terms, pagination: { page: input.page, perPage: input.perPage, total, totalPages: Math.max(1, Math.ceil(total / input.perPage)) } });
});
router.get("/terms/:id", contentRoles, async (req, res) => {
  const result = await pool.query(`SELECT ${termFields} FROM terms t WHERE t.id=$1`, [parseId(req.params.id)]);
  if (!result.rowCount) throw new HttpError(404, "Term not found.");
  res.json({ term: result.rows[0] });
});
router.post("/terms", manageTerms, async (req: AuthRequest, res) => {
  const input = z.object(termShape).strict().parse(req.body);
  if (needUser(req).role === "author" && input.taxonomy !== "tag")
    throw new HttpError(
      403,
      "Authors can create tags. Managing categories requires an editor.",
    );
  const name = plainText(input.name).trim();
  if (!name) throw new HttpError(400, "Enter a term name containing text.");
  const term = await transaction(async (client) => {
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtext('worldact-term-hierarchy'))",
    );
    await validateTermParent(client, input.parentId ?? null, input.taxonomy);
    const slug = slugify(input.slug || name);
    const exists = await client.query(
      "SELECT id FROM terms WHERE taxonomy=$1 AND slug=$2",
      [input.taxonomy, slug],
    );
    if (exists.rowCount)
      throw new HttpError(409, "A term with this permalink already exists.");
    const result = await client.query(
      "INSERT INTO terms(taxonomy,name,slug,description,parent_id) VALUES($1,$2,$3,$4,$5) RETURNING id",
      [
        input.taxonomy,
        name,
        slug,
        plainText(input.description ?? ""),
        input.parentId ?? null,
      ],
    );
    return (
      await client.query(`SELECT ${termFields} FROM terms t WHERE t.id=$1`, [
        result.rows[0].id,
      ])
    ).rows[0];
  });
  res.status(201).json({ term });
});
router.put(
  "/terms/:id",
  requireRole("administrator", "editor"),
  async (req, res) => {
    const id = parseId(req.params.id),
      input = z
        .object({
          ...termShape,
          taxonomy: termShape.taxonomy.optional(),
          name: termShape.name.optional(),
        })
        .strict()
        .refine(
          (input) => Object.keys(input).length > 0,
          "Provide a term field to update.",
        )
        .parse(req.body);
    const term = await transaction(async (client) => {
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtext('worldact-term-hierarchy'))",
      );
      const old = (
        await client.query(
          "SELECT * FROM terms WHERE id=$1 FOR NO KEY UPDATE",
          [id],
        )
      ).rows[0];
      if (!old) throw new HttpError(404, "Term not found.");
      if (input.taxonomy && input.taxonomy !== old.taxonomy)
        throw new HttpError(400, "A term's taxonomy cannot be changed.");
      const name =
        input.name === undefined ? old.name : plainText(input.name).trim();
      if (!name) throw new HttpError(400, "Enter a term name containing text.");
      const parentId =
        input.parentId === undefined ? old.parent_id : input.parentId;
      await validateTermParent(client, parentId, old.taxonomy, id);
      await client.query(
        "UPDATE terms SET name=$1,slug=$2,description=$3,parent_id=$4 WHERE id=$5",
        [
          name,
          input.slug === undefined ? old.slug : slugify(input.slug || name),
          input.description === undefined
            ? old.description
            : plainText(input.description),
          parentId,
          id,
        ],
      );
      return (
        await client.query(`SELECT ${termFields} FROM terms t WHERE t.id=$1`, [
          id,
        ])
      ).rows[0];
    });
    res.json({ term });
  },
);
router.delete(
  "/terms/:id",
  requireRole("administrator", "editor"),
  async (req, res) => {
    await transaction(async (client) => {
      // Settings writers use the same row before locking the selected term.
      await client.query("SELECT id FROM settings WHERE id=1 FOR UPDATE");
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtext('worldact-term-hierarchy'))",
      );
      const id = parseId(req.params.id),
        term = (
          await client.query(
            "SELECT * FROM terms WHERE id=$1 FOR NO KEY UPDATE",
            [id],
          )
        ).rows[0];
      if (!term) throw new HttpError(404, "Term not found.");
      const defaultCategory = (await client.query(`SELECT ${defaultCategorySQL} AS id`)).rows[0].id as number | null;
      if (term.taxonomy === "category" && term.id === defaultCategory)
        throw new HttpError(409, "The default category cannot be deleted.");
      const affected = term.taxonomy === "category"
        ? (await client.query("SELECT p.id FROM posts p JOIN post_terms pt ON pt.post_id=p.id WHERE p.type='post' AND pt.term_id=$1 ORDER BY p.id FOR KEY SHARE OF p", [id])).rows.map(post => post.id)
        : [];
      if (term.taxonomy === "category") {
        await client.query("UPDATE terms SET parent_id=$1 WHERE parent_id=$2", [term.parent_id, id]);
        // Keep the legacy fallback marker valid after deleting a former default,
        // including across repeated schema/seed runs on an existing site.
        if (term.is_default && defaultCategory) {
          await client.query("UPDATE terms SET is_default=false WHERE is_default");
          await client.query("UPDATE terms SET is_default=true WHERE id=$1", [defaultCategory]);
        }
      }
      await client.query("DELETE FROM terms WHERE id=$1", [id]);
      if (affected.length && defaultCategory)
        await client.query(
          `INSERT INTO post_terms(post_id,term_id) SELECT p.id,$2 FROM posts p WHERE p.id=ANY($1::int[]) AND NOT EXISTS(SELECT 1 FROM post_terms pt JOIN terms assigned ON assigned.id=pt.term_id WHERE pt.post_id=p.id AND assigned.taxonomy='category') ON CONFLICT DO NOTHING`,
          [affected, defaultCategory],
        );
    });
    res.json({ ok: true });
  },
);

function tokenHash(token: string) {
  return createHash("sha256").update(token).digest("hex");
}
const commentAuthorCookie = "worldact_comment_author";
function rememberedAuthorToken(req: Pick<Request, "headers">) {
  const value = req.headers.cookie?.split(";").map(part => part.trim()).find(part => part.startsWith(commentAuthorCookie + "="))?.slice(commentAuthorCookie.length + 1);
  return value && /^[a-f\d]{64}$/.test(value) ? value : null;
}
export async function readRememberedCommentAuthor(req: Pick<Request, "headers">) {
  if (!(await getSettings()).commentCookieConsent) return null;
  const token = rememberedAuthorToken(req);
  if (!token) return null;
  const result = await pool.query(
    `SELECT c.author_name AS "authorName",c.author_email AS "authorEmail",c.author_url AS "authorUrl" FROM comment_author_tokens t JOIN comments c ON c.id=t.comment_id WHERE t.token_hash=$1 AND t.expires_at>now() AND (c.author_name<>'Anonymous' OR c.author_email<>'' OR c.author_url<>'')`,
    [tokenHash(token)],
  );
  return result.rows[0] || null;
}
router.get("/public/comment-author", async (req, res) => {
  const author = await readRememberedCommentAuthor(req);
  if (!author && rememberedAuthorToken(req)) res.clearCookie(commentAuthorCookie, { path: "/", httpOnly: true, sameSite: "lax" });
  res.json({ author });
});
function accessToken(req: Request, postId: number) {
  const cookie = req.headers.cookie
    ?.split(";")
    .map((value) => value.trim())
    .find((value) => value.startsWith(`worldact_post_${postId}=`));
  const token = cookie?.slice(`worldact_post_${postId}=`.length);
  return token && /^[a-f\d]{64}$/.test(token) ? token : null;
}
export async function hasPostAccess(
  req: Request,
  postId: number,
  passwordHash: string | null,
) {
  if (!passwordHash) return true;
  const token = accessToken(req, postId);
  if (!token) return false;
  const access = await pool.query(
    "SELECT 1 FROM post_access_tokens WHERE token_hash=$1 AND post_id=$2 AND password_hash=$3 AND expires_at>now()",
    [tokenHash(token), postId, passwordHash],
  );
  return !!access.rowCount;
}
async function publicPost(post: any, locked = false, options: RenderOptions = {}) {
  const {
    blocks: _blocks,
    rawContent: _rawContent,
    raw_content: _raw,
    pendingCommentCount: _pendingCommentCount,
    ...safe
  } = decoratePost(post);
  const linked = await withPermalink(safe);
  const result = {
    ...linked,
    commentCount: safe.approvedCommentCount ?? safe.commentCount ?? 0,
    locked,
    footnotes: locked ? [] : safe.footnotes ?? [],
    ...(!locked ? { contentPagination: contentPagination(post, linked.permalink, options.contentPage || 1, options.preview) } : {}),
    content: locked ? "" : await renderPublicContent({ ...post, locked }, { requestPath: linked.permalink, ...options }),
    excerpt: locked ? "" : safe.excerpt,
  };
  return locked ? result : enhancePublicPost(result);
}
async function publicComments(postId: number, page: number, settings: Awaited<ReturnType<typeof getSettings>>) {
  return (
    await pool.query(
      `SELECT c.id,c.author_name AS "authorName",c.author_url AS "authorUrl",coalesce(avatar_user.email,c.author_email) AS "_avatarEmail",c.user_id AS "userId",c.content,c.type,c.status,c.parent_id AS "parentId",c.post_id AS "postId",p.title AS "postTitle",c.created_at AS "createdAt" FROM comments c JOIN posts p ON p.id=c.post_id LEFT JOIN users avatar_user ON avatar_user.id=c.user_id WHERE c.post_id=$1 AND c.status='approved' ORDER BY c.created_at ${settings.commentOrder === "desc" ? "DESC" : "ASC"},c.id ${settings.commentOrder === "desc" ? "DESC" : "ASC"}${settings.paginateComments ? " LIMIT $2 OFFSET $3" : ""}`,
      settings.paginateComments ? [postId, settings.commentsPerPage, (page - 1) * settings.commentsPerPage] : [postId],
    )
  ).rows.map(({ _avatarEmail, ...comment }) => ({ ...comment, content:renderedCommentContent(comment.content,comment.type), avatarUrl: comment.type === "comment" ? avatarURL(_avatarEmail, settings) : null }));
}
async function commentResponse(postId: number, req: Request, locked = false) {
  const requestedPage = z.coerce
    .number()
    .int()
    .positive()
    .max(2_147_483_647)
    .optional()
    .parse(req.query.commentPage);
  const settings = await getSettings();
  const total = locked
    ? 0
    : (
        await pool.query(
          "SELECT count(*)::int AS total FROM comments WHERE post_id=$1 AND status='approved'",
          [postId],
        )
      ).rows[0].total;
  const totalPages = settings.paginateComments ? Math.max(1, Math.ceil(total / settings.commentsPerPage)) : 1;
  const page = settings.paginateComments
    ? Math.min(requestedPage ?? ((settings.defaultCommentPage === "newest") === (settings.commentOrder === "asc") ? totalPages : 1), totalPages)
    : 1;
  return {
    comments: locked ? [] : await publicComments(postId, page, settings),
    commentsPagination: {
      page,
      perPage: settings.paginateComments ? settings.commentsPerPage : Math.max(1, total),
      totalComments: total,
      totalPages,
    },
  };
}
async function setRobots(res: Response) {
  if ((await getSettings()).discourageSearchEngines)
    res.setHeader("X-Robots-Tag", "noindex, nofollow");
}
router.get(
  "/posts/:id/preview",
  contentRoles,
  async (req: AuthRequest, res) => {
    const post = await withPreviewAutosave(await authorizedPost(req), needUser(req).id);
    res.setHeader("X-Robots-Tag", "noindex, nofollow");
    res.setHeader("Cache-Control", "private, no-store");
    res.json({
      post: await publicPost(post, false, { query: req.query, preview: true, user: needUser(req), contentPage: parseContentPage(req.query.page), canReadProtectedPost: postAccessReader(req) }),
      ...(await commentResponse(post.id, req)),
    });
  },
);
router.get("/public/site", async (req, res) => {
  const filter = z
    .object({
      page: z.coerce.number().int().positive().max(2_147_483_647).default(1),
      search: z.string().trim().max(200).optional(),
      category: z.string().min(1).max(220).optional(),
      tag: z.string().min(1).max(220).optional(),
      author: z.coerce.number().int().positive().max(2147483647).optional(),
    })
    .parse(req.query);
  const settings = await getSettings(),
    args: unknown[] = [];
  const dateArchive = parseDateArchiveQuery(req.query);
  let where = "p.type='post' AND p.status='publish'";
  if (filter.author) { args.push(filter.author); where += ` AND p.author_id=$${args.length}`; }
  if (filter.search) {
    args.push(`%${filter.search}%`);
    where += ` AND (p.title ILIKE $${args.length} OR p.content ILIKE $${args.length} OR p.excerpt ILIKE $${args.length})`;
    if (!(req as AuthRequest).user) where += " AND p.password_hash IS NULL";
  }
  for (const taxonomy of ["category", "tag"] as const)
    if (filter[taxonomy]) {
      args.push(filter[taxonomy]);
      where += ` AND EXISTS(SELECT 1 FROM post_terms pt JOIN terms t ON t.id=pt.term_id WHERE pt.post_id=p.id AND t.taxonomy='${taxonomy}' AND t.slug=$${args.length})`;
    }
  const dateWhere: string[] = [];
  appendDateArchiveSQL(dateWhere, args, "coalesce(p.published_at,p.created_at)", dateArchive, settings.timezone, settings.weekStartsOn);
  if (dateWhere.length) where += " AND " + dateWhere.map((clause) => `(${clause})`).join(" AND ");
  const count = await pool.query(
    `SELECT count(*)::int AS total FROM posts p WHERE ${where}`,
    args,
  );
  args.push(settings.postsPerPage, (filter.page - 1) * settings.postsPerPage);
  const [posts, pages] = await Promise.all([
    pool.query(
      `SELECT ${postFields},p.password_hash AS "_passwordHash" FROM posts p JOIN users u ON u.id=p.author_id WHERE ${where} ORDER BY ${dateArchive || filter.search || filter.author || filter.category || filter.tag ? "" : "p.sticky DESC,"}p.published_at DESC,p.id DESC LIMIT $${args.length - 1} OFFSET $${args.length}`,
      args,
    ),
    pool.query(
      `SELECT ${postFields},p.password_hash AS "_passwordHash" FROM posts p JOIN users u ON u.id=p.author_id WHERE p.type='page' AND p.status='publish' ORDER BY p.menu_order,p.title,p.id`,
    ),
  ]);
  const sanitize = async (post: any, contentMode: "singular" | "archive" = "singular") => {
    const { _passwordHash, ...safe } = post;
    return publicPost(
      safe,
      !(await hasPostAccess(req, post.id, _passwordHash)),
      { query: req.query, requestPath: "/", user: (req as AuthRequest).user, contentMode, canReadProtectedPost: postAccessReader(req) },
    );
  };
  const { defaultPingbackFlag: _outgoingFlag, pingServices: _pingServices, adminEmail: _adminEmail, commentModerationKeys: _moderationKeys, disallowedCommentKeys: _disallowedKeys, ...safeSettings } = settings;
  const author = filter.author ? (await pool.query("SELECT display_name AS name FROM users WHERE id=$1 AND EXISTS(SELECT 1 FROM posts WHERE author_id=$1 AND type='post' AND status='publish')", [filter.author])).rows[0] : null;
  const icon = settings.siteIconId
    ? (
        await pool.query(
          "SELECT filename,sizes FROM media WHERE id=$1 AND mime_type LIKE 'image/%'",
          [settings.siteIconId],
        )
      ).rows[0]
    : null;
  const totalPosts = count.rows[0].total;
  const safePages = await Promise.all(pages.rows.map(post => sanitize(post)));
  const frontPage =
    settings.frontPageMode === "page"
      ? (safePages.find((page) => page.id === settings.frontPageId) ?? null)
      : null;
  const postsPage =
    safePages.find((page) => page.id === settings.postsPageId) ?? null;
  await setRobots(res);
  res.json({
    settings: {
      ...safeSettings,
      siteIconUrl: icon ? `/uploads/${icon.filename}` : null,
      siteIconSizes:icon?.sizes || {},
    },
    archive: dateArchive ? dateArchiveDTO(dateArchive) : author ? { type: "author", name: author.name, authorId: filter.author } : null,
    posts: await Promise.all(posts.rows.map(post => sanitize(post, "archive"))),
    pages: safePages,
    frontPage,
    postsPage,
    pagination: {
      page: filter.page,
      totalPosts,
      totalPages: Math.max(1, Math.ceil(totalPosts / settings.postsPerPage)),
    },
  });
});
router.get("/public/terms", async (req, res) => {
  const taxonomy = z
    .enum(["category", "tag"])
    .optional()
    .parse(req.query.taxonomy);
  const result = await pool.query(
    `SELECT ${termFields} FROM terms t ${taxonomy ? "WHERE t.taxonomy=$1" : ""} ORDER BY t.name,t.id`,
    taxonomy ? [taxonomy] : [],
  );
  res.json({ terms: result.rows });
});
router.get("/public/posts/:slug", async (req, res) => {
  const slug = z.string().min(1).max(220).parse(req.params.slug),
    row = (
      await pool.query(
        `SELECT ${postFields},p.password_hash AS "_passwordHash" FROM posts p JOIN users u ON u.id=p.author_id WHERE p.slug=$1 AND p.status='publish'`,
        [slug],
      )
    ).rows[0];
  if (!row) throw new HttpError(404, "Post not found.");
  const { _passwordHash, ...post } = row;
  const locked = !(await hasPostAccess(req, post.id, _passwordHash));
  const pingback=pingbackHeader(post,await getSettings());if(pingback)res.setHeader("X-Pingback",pingback);
  await setRobots(res);
  res.json({
    post: await publicPost(post, locked, { query: req.query, user: (req as AuthRequest).user, contentPage: parseContentPage(req.query.page), canReadProtectedPost: postAccessReader(req) }),
    ...(await commentResponse(post.id, req, locked)),
  });
});
const passwordAttempts = new Map<string, { count: number; expires: number }>();
export async function unlockPublicPost(req:Request,res:Response) {
  const key = req.ip ?? "unknown",
    now = Date.now();
  if (passwordAttempts.size > 10000)
    for (const [key, attempt] of passwordAttempts)
      if (attempt.expires < now) passwordAttempts.delete(key);
  const attempt = passwordAttempts.get(key);
  if (attempt && attempt.expires > now && attempt.count >= 30) {
    res.setHeader("Retry-After", Math.ceil((attempt.expires - now) / 1000));
    throw new HttpError(429, "Too many password attempts. Try again later.");
  }
  passwordAttempts.set(key, {
    count: attempt && attempt.expires > now ? attempt.count + 1 : 1,
    expires:
      attempt && attempt.expires > now ? attempt.expires : now + 15 * 60_000,
  });
  const { password } = z
      .object({ password: z.string().min(1).max(1024) })
      .strict()
      .parse(req.body),
    slug = z.string().min(1).max(220).parse(req.params.slug);
  const row = (
    await pool.query(
      `SELECT ${postFields},p.password_hash AS "_passwordHash" FROM posts p JOIN users u ON u.id=p.author_id WHERE p.slug=$1 AND p.status='publish'`,
      [slug],
    )
  ).rows[0];
  if (!row) throw new HttpError(404, "Post not found.");
  const { _passwordHash, ...post } = row;
  if (_passwordHash && !(await verifyPassword(password, _passwordHash)))
    throw new HttpError(403, "The post password is incorrect.");
  if (_passwordHash) {
    const token = randomBytes(32).toString("hex");
    await pool.query(
      "INSERT INTO post_access_tokens(token_hash,post_id,password_hash,expires_at) VALUES($1,$2,$3,now()+interval '7 days')",
      [tokenHash(token), post.id, _passwordHash],
    );
    await pool.query("DELETE FROM post_access_tokens WHERE expires_at<=now()");
    res.cookie(`worldact_post_${post.id}`, token, {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      path: "/",
      maxAge: 7 * 24 * 60 * 60_000,
    });
  }
  res.json({
    post: await publicPost(post, false, { query: req.query, user: (req as AuthRequest).user }),
    ...(await commentResponse(post.id, req)),
  });
}
router.post("/public/posts/:slug/unlock",unlockPublicPost);
const commentAttempts = new Map<string, { count: number; expires: number }>();
export async function queueCommentNotifications(client: PoolClient, commentId: number, actorId?: number) {
  const settings = await getSettings(client);
  const comment = (await client.query(
    "SELECT c.author_name,c.author_email,c.author_url,c.content,c.status,c.type,p.id AS post_id,p.title,p.author_id,u.email AS post_author_email,u.role AS post_author_role FROM comments c JOIN posts p ON p.id=c.post_id JOIN users u ON u.id=p.author_id WHERE c.id=$1",
    [commentId],
  )).rows[0];
  if (!comment || !["approved", "pending"].includes(comment.status)) return [];
  const recipients = new Set<string>();
  if (comment.status === "pending" && settings.notifyModeration) {
    recipients.add(settings.adminEmail.toLowerCase());
    if (["administrator", "editor", "author"].includes(comment.post_author_role)) recipients.add(comment.post_author_email.toLowerCase());
  }
  if (comment.status === "approved" && settings.notifyComments && actorId !== comment.author_id)
    recipients.add(comment.post_author_email.toLowerCase());
  const subject = `[${settings.siteTitle}] ${comment.status === "pending" ? "Please moderate" : "New " + comment.type}: ${comment.title}`;
  const link = new URL(`/admin/comments?postId=${comment.post_id}`, process.env.APP_ORIGIN || "http://127.0.0.1:5173").href;
  const body = `A ${comment.status === "pending" ? comment.type + " is awaiting moderation" : "new " + comment.type + " was approved"} on "${comment.title}".\n\nAuthor: ${comment.author_name}\nEmail: ${comment.author_email}\nWebsite: ${comment.author_url || ""}\n\n${plainText(comment.content)}\n\nReview comments:\n${link}`;
  const messages: Awaited<ReturnType<typeof queueMail>>[] = [];
  for (const recipient of recipients) messages.push(await queueMail(client, recipient, subject, body));
  return messages;
}
export async function submitPublicComment(req: Request, res: Response) {
  const key = req.ip ?? "unknown",
    now = Date.now(),
    attempt = commentAttempts.get(key);
  if (attempt && attempt.expires > now && attempt.count >= 20)
    throw new HttpError(429, "Too many comments. Please try again later.");
  if (commentAttempts.size >= 10000)
    for (const [k, v] of commentAttempts)
      if (v.expires <= now) commentAttempts.delete(k);
  if (commentAttempts.size >= 10000 && !commentAttempts.has(key))
    throw new HttpError(429, "Too many comments. Please try again later.");
  commentAttempts.set(key, {
    count: attempt && attempt.expires > now ? attempt.count + 1 : 1,
    expires:
      attempt && attempt.expires > now ? attempt.expires : now + 60 * 60_000,
  });
  const input = z
    .object({
      postId: idSchema,
      parentId: idSchema.nullable().optional(),
      authorName: z.string().trim().max(160).optional(),
      authorEmail: z.union([z.email().max(254), z.literal("")]).optional(),
      authorUrl: z
        .union([
          z.literal(""),
          z
            .url()
            .max(2000)
            .refine(
              (value) => /^https?:\/\//i.test(value),
              "Use an HTTP or HTTPS website URL.",
            ),
        ])
        .optional(),
      content: z.string().trim().min(1).max(20_000),
      rememberAuthor: z.boolean().optional(),
    })
    .strict()
    .parse(req.body);
  const user = (req as AuthRequest).user;
  const saved = await transaction(async client => {
    let profileWebsite = "";
    if (user) {
      // Match account deletion's lock order before protecting the post.
      const account = (await client.query("SELECT profile FROM users WHERE id=$1 FOR KEY SHARE", [user.id])).rows[0];
      if (!account) throw new HttpError(401, "Please log in again before commenting.");
      if (typeof account.profile?.website === "string" && /^https?:\/\//i.test(account.profile.website)) profileWebsite = account.profile.website;
    }
    await client.query("SELECT pg_advisory_xact_lock(hashtext('worldact-comment-hierarchy'))");
    const settings = await getSettings(client);
    if (settings.commentRegistration && !user)
      throw new HttpError(401, "Please log in to leave a comment.");
    const submittedName = user?.displayName ?? input.authorName ?? "",
      submittedEmail = (user?.email ?? input.authorEmail ?? "").toLowerCase();
    if (settings.requireCommentNameEmail && (!submittedName.trim() || !submittedEmail))
      throw new HttpError(400, "Enter your name and email address.");
    const cleanName = plainText(submittedName).trim();
    if (settings.requireCommentNameEmail && !cleanName) throw new HttpError(400, "Enter a name containing text.");
    const content = cleanContent(input.content), authorName = cleanName || "Anonymous",
      authorUrl = input.authorUrl ?? profileWebsite;
    if (!plainText(content).trim()) throw new HttpError(400, "Write a comment before submitting.");
    const post = (await client.query(
      "SELECT id,type,slug,parent_id,status,comment_status,password_hash,published_at,created_at,(SELECT jsonb_agg(jsonb_build_object('taxonomy',t.taxonomy,'slug',t.slug)) FROM terms t JOIN post_terms pt ON pt.term_id=t.id WHERE pt.post_id=posts.id) AS terms FROM posts WHERE id=$1 FOR SHARE", [input.postId],
    )).rows[0];
    if (!post || post.status !== "publish") throw new HttpError(404, "Post not found.");
    if (post.comment_status !== "open" || (settings.closeCommentsDays > 0 && post.published_at && new Date(post.published_at).getTime() + settings.closeCommentsDays * 86_400_000 < Date.now()))
      throw new HttpError(409, "Comments are closed for this post.");
    if (!(await hasPostAccess(req, post.id, post.password_hash)))
      throw new HttpError(403, "Unlock this post before leaving a comment.");
    if (input.parentId) {
      if (!settings.threadComments) throw new HttpError(400, "Threaded comments are disabled.");
      const parent = await client.query("SELECT id FROM comments WHERE id=$1 AND post_id=$2 AND status='approved'", [input.parentId, post.id]);
      if (!parent.rowCount) throw new HttpError(400, "Choose an approved comment on this post to reply to.");
      const ancestors = await client.query(
        "WITH RECURSIVE ancestors AS(SELECT id,parent_id FROM comments WHERE id=$1 UNION SELECT c.id,c.parent_id FROM comments c JOIN ancestors a ON c.id=a.parent_id) SELECT count(*)::int AS depth FROM ancestors", [input.parentId],
      );
      if (ancestors.rows[0].depth >= settings.threadDepth)
        throw new HttpError(400, "This comment thread has reached its maximum depth.");
    }
    let status = await moderateComment({type:"comment",authorName,authorEmail:submittedEmail,authorUrl,content,rawContent:input.content,ip:req.ip || ""},client,settings);
    const akismetInput:AkismetComment={userIP:req.ip || "",userAgent:req.get("user-agent") || "",referrer:req.get("referer") || "",authorName,authorEmail:submittedEmail,authorURL:input.authorUrl || "",content,permalink:new URL((await withPermalink(post,settings,client)).permalink,settings.siteUrl).href,userRole:user?.role};
    const akismetResult=["trash","spam"].includes(status)?"skipped":await checkAkismetComment(akismetInput,client);
    if(akismetResult==="spam")status="spam";else if(akismetResult==="unavailable")status="pending";
    const result = await client.query(
      "INSERT INTO comments(post_id,author_name,author_email,content,status,parent_id,author_url,user_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id",
      [post.id, authorName, submittedEmail, content, status, input.parentId ?? null, authorUrl, user?.id ?? null],
    );
    const comment = { id: result.rows[0].id, status };
    await recordAkismetCheck(comment.id,akismetInput,akismetResult,client);
    let rememberedToken: string | null | undefined;
    if (!user && (input.rememberAuthor !== undefined || !settings.commentCookieConsent)) {
      const previousToken = rememberedAuthorToken(req);
      if (previousToken) await client.query("DELETE FROM comment_author_tokens WHERE token_hash=$1", [tokenHash(previousToken)]);
      rememberedToken = null;
      if (settings.commentCookieConsent && input.rememberAuthor) {
        rememberedToken = randomBytes(32).toString("hex");
        await client.query("DELETE FROM comment_author_tokens WHERE expires_at<=now()");
        await client.query("INSERT INTO comment_author_tokens(token_hash,comment_id,expires_at) VALUES($1,$2,now()+interval '347 days')", [tokenHash(rememberedToken), comment.id]);
      }
    }
    const messages = await queueCommentNotifications(client, comment.id, user?.id);
    return { comment, messages, rememberedToken };
  });
  if (saved.rememberedToken) res.cookie(commentAuthorCookie, saved.rememberedToken, { path: "/", httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production", maxAge: 347 * 86_400_000 });
  else if (saved.rememberedToken === null) res.clearCookie(commentAuthorCookie, { path: "/", httpOnly: true, sameSite: "lax" });
  for (const message of saved.messages) await deliverMail(message);
  res.status(201).json({ ok: true, comment: saved.comment });
}

router.post("/public/comments", submitPublicComment);
export default router;
