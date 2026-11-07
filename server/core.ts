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
  type: z.enum(["post", "page"]).optional(),
  format: z
    .enum([
      "standard",
      "aside",
      "image",
      "video",
      "quote",
      "link",
      "gallery",
      "audio",
    ])
    .optional(),
  title: z.string().trim().max(300).optional(),
  content: z.string().max(1_000_000).optional(),
  excerpt: z.string().max(20_000).optional(),
  status: z.enum(statuses).optional(),
  slug: z.string().max(220).optional(),
  blocks: z.array(z.unknown()).max(2000).optional(),
  version: idSchema.optional(),
  scheduledAt: dateSchema.optional(),
  publishedAt: dateSchema.optional(),
  parentId: idSchema.nullable().optional(),
  menuOrder: z.number().int().min(-2_147_483_648).max(2_147_483_647).optional(),
  featuredMediaId: idSchema.nullable().optional(),
  commentStatus: z.enum(["open", "closed"]).optional(),
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
function ownOnly(user: User) {
  return user.role === "author" || user.role === "contributor";
}
function assertPostAccess(
  user: User,
  post: { authorId: number; type: string; status: string },
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
    !["draft", "pending", "trash"].includes(post.status)
  )
    throw new HttpError(
      403,
      "Contributors can only edit their own drafts and pending posts.",
    );
}
function assertNewAccess(user: User, type: string, status: string) {
  if (ownOnly(user) && type === "page")
    throw new HttpError(
      403,
      "Editing pages requires an editor or administrator.",
    );
  if (
    user.role === "contributor" &&
    !["draft", "pending", "trash"].includes(status)
  )
    throw new HttpError(
      403,
      "Contributors can save drafts or submit posts for review; publishing requires an editor.",
    );
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
async function lockedPost(client: PoolClient, id: number, user: User) {
  const locked = await client.query(
    "SELECT id,password_hash FROM posts WHERE id=$1 FOR NO KEY UPDATE",
    [id],
  );
  if (!locked.rows[0]) throw new HttpError(404, "Post not found.");
  const post = await getPost(id, client);
  assertPostAccess(user, post);
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
    format: post.format ?? "standard",
    parentId: post.parentId,
    menuOrder: post.menuOrder,
    featuredMediaId: post.featuredMediaId,
    commentStatus: post.commentStatus,
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
) {
  const type = input.type ?? existing?.type ?? "post";
  let status = input.status ?? existing?.status ?? "draft";
  assertNewAccess(user, type, status);
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
      assertNewAccess(user, type, status);
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
  const values = {
    type,
    format,
    title,
    content,
    excerpt,
    blocks,
    parentId,
    featuredMediaId,
    status,
    scheduledAt,
    menuOrder: input.menuOrder ?? existing?.menuOrder ?? 0,
    commentStatus:
      input.commentStatus ??
      existing?.commentStatus ??
      settings?.defaultCommentStatus ??
      "open",
    sticky: input.sticky ?? existing?.sticky ?? false,
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
    ];
    let id: number;
    if (existing) {
      args.push(existing.id);
      await client.query(
        `UPDATE posts SET type=$1,title=$2,slug=$3,content=$4,excerpt=$5,status=$6,blocks=$7::jsonb,scheduled_at=$8,parent_id=$9,menu_order=$10,featured_media_id=$11,comment_status=$12,sticky=$13,password_hash=$14,published_at=$15,raw_content=$16,format=$17,version=version+1,updated_at=now() WHERE id=$18`,
        args,
      );
      id = existing.id;
    } else {
      args.push(user.id);
      const created = await client.query(
        `INSERT INTO posts(type,title,slug,content,excerpt,status,blocks,scheduled_at,parent_id,menu_order,featured_media_id,comment_status,sticky,password_hash,published_at,raw_content,format,author_id) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18) RETURNING id`,
        args,
      );
      id = created.rows[0].id;
    }
    await setTerms(client, id, termIds);
    if (input.password !== undefined)
      await client.query("DELETE FROM post_access_tokens WHERE post_id=$1", [
        id,
      ]);
    await client.query(
      "DELETE FROM post_autosaves WHERE post_id=$1 AND user_id=$2",
      [id, user.id],
    );
    return getPost(id, client);
  }
  throw new HttpError(409, "Please choose a different permalink.");
}

export async function publishDuePosts(
  now: Date = new Date(),
  postIds?: number[],
) {
  const result = await pool.query(
    "UPDATE posts SET status='publish',published_at=scheduled_at,updated_at=now(),version=version+1 WHERE status='future' AND scheduled_at <= $1 AND ($2::int[] IS NULL OR id=ANY($2::int[])) RETURNING id",
    [now, postIds ?? null],
  );
  return result.rows.map((row) => row.id as number);
}
export function startScheduler(intervalMs = 30_000) {
  const publish = () => {
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
router.get("/posts/:id", contentRoles, async (req: AuthRequest, res) => {
  const post = await getPost(parseId(req.params.id));
  if (!post) throw new HttpError(404, "Post not found.");
  assertPostAccess(needUser(req), post);
  res.json({ post });
});
router.post("/posts", contentRoles, async (req: AuthRequest, res) => {
  const input = createSchema.parse(req.body);
  const post = await transaction((client) =>
    savePost(client, input, needUser(req)),
  );
  res.status(201).json({ post });
});
router.put("/posts/:id", contentRoles, async (req: AuthRequest, res) => {
  const id = parseId(req.params.id),
    input = updateSchema.parse(req.body),
    user = needUser(req);
  const post = await transaction(async (client) => {
    const { post, passwordHash } = await lockedPost(client, id, user);
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

const revisionFields = `r.id,r.post_id AS "postId",r.title,r.content,r.raw_content AS "rawContent",r.excerpt,r.blocks,r.slug,r.status,r.version,r.metadata,r.created_at AS "createdAt",coalesce(u.display_name,'Deleted user') AS "authorName"`;
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
  version: idSchema.optional(),
};
const autosaveFields = `title,content,raw_content AS "rawContent",excerpt,blocks,saved_at AS "savedAt",version`;
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
        `INSERT INTO post_autosaves(post_id,user_id,title,content,excerpt,blocks,version,raw_content) VALUES($1,$2,$3,$4,$5,$6::jsonb,$7,$8) ON CONFLICT(post_id,user_id) DO UPDATE SET title=EXCLUDED.title,content=EXCLUDED.content,excerpt=EXCLUDED.excerpt,blocks=EXCLUDED.blocks,version=EXCLUDED.version,raw_content=EXCLUDED.raw_content,saved_at=now() RETURNING ${autosaveFields}`,
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

const termFields = `t.id,t.taxonomy,t.name,t.slug,t.description,t.parent_id AS "parentId",t.is_default AS "isDefault",(SELECT count(*)::int FROM post_terms pt JOIN posts p ON p.id=pt.post_id WHERE pt.term_id=t.id AND p.status='publish') AS count`;
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
      if (term.is_default)
        throw new HttpError(409, "The default category cannot be deleted.");
      await client.query("DELETE FROM terms WHERE id=$1", [id]);
      if (term.taxonomy === "category")
        await client.query(
          `INSERT INTO post_terms(post_id,term_id) SELECT p.id,t.id FROM posts p CROSS JOIN terms t WHERE p.type='post' AND t.is_default AND NOT EXISTS(SELECT 1 FROM post_terms pt JOIN terms assigned ON assigned.id=pt.term_id WHERE pt.post_id=p.id AND assigned.taxonomy='category') ON CONFLICT DO NOTHING`,
        );
    });
    res.json({ ok: true });
  },
);

function tokenHash(token: string) {
  return createHash("sha256").update(token).digest("hex");
}
function accessToken(req: Request, postId: number) {
  const cookie = req.headers.cookie
    ?.split(";")
    .map((value) => value.trim())
    .find((value) => value.startsWith(`worldact_post_${postId}=`));
  const token = cookie?.slice(`worldact_post_${postId}=`.length);
  return token && /^[a-f\d]{64}$/.test(token) ? token : null;
}
async function hasPostAccess(
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
    ...safe
  } = decoratePost(post);
  const result = {
    ...safe,
    locked,
    content: locked ? "" : await renderPublicContent(post, options),
    excerpt: locked ? "" : safe.excerpt,
  };
  const linked = await withPermalink(result);
  return locked ? linked : enhancePublicPost(linked);
}
async function publicComments(postId: number, page = 1) {
  const settings = await getSettings();
  return (
    await pool.query(
      `SELECT c.id,c.author_name AS "authorName",c.author_url AS "authorUrl",c.user_id AS "userId",c.content,c.status,c.parent_id AS "parentId",c.post_id AS "postId",p.title AS "postTitle",c.created_at AS "createdAt" FROM comments c JOIN posts p ON p.id=c.post_id WHERE c.post_id=$1 AND c.status='approved' ORDER BY c.created_at ${settings.commentOrder === "desc" ? "DESC" : "ASC"},c.id ${settings.commentOrder === "desc" ? "DESC" : "ASC"} LIMIT $2 OFFSET $3`,
      [postId, settings.commentsPerPage, (page - 1) * settings.commentsPerPage],
    )
  ).rows;
}
async function commentResponse(postId: number, req: Request, locked = false) {
  const page = z.coerce
    .number()
    .int()
    .positive()
    .max(2_147_483_647)
    .default(1)
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
  return {
    comments: locked ? [] : await publicComments(postId, page),
    commentsPagination: {
      page,
      perPage: settings.commentsPerPage,
      totalComments: total,
      totalPages: Math.max(1, Math.ceil(total / settings.commentsPerPage)),
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
    const post = await authorizedPost(req);
    res.setHeader("X-Robots-Tag", "noindex, nofollow");
    res.json({
      post: await publicPost(post, false, { query: req.query }),
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
  let where = "p.type='post' AND p.status='publish'";
  if (filter.author) { args.push(filter.author); where += ` AND p.author_id=$${args.length}`; }
  if (filter.search) {
    args.push(`%${filter.search}%`);
    where += ` AND (p.title ILIKE $${args.length} OR (p.password_hash IS NULL AND (p.content ILIKE $${args.length} OR p.excerpt ILIKE $${args.length})))`;
  }
  for (const taxonomy of ["category", "tag"] as const)
    if (filter[taxonomy]) {
      args.push(filter[taxonomy]);
      where += ` AND EXISTS(SELECT 1 FROM post_terms pt JOIN terms t ON t.id=pt.term_id WHERE pt.post_id=p.id AND t.taxonomy='${taxonomy}' AND t.slug=$${args.length})`;
    }
  const count = await pool.query(
    `SELECT count(*)::int AS total FROM posts p WHERE ${where}`,
    args,
  );
  args.push(settings.postsPerPage, (filter.page - 1) * settings.postsPerPage);
  const [posts, pages] = await Promise.all([
    pool.query(
      `SELECT ${postFields},p.password_hash AS "_passwordHash" FROM posts p JOIN users u ON u.id=p.author_id WHERE ${where} ORDER BY p.sticky DESC,p.published_at DESC,p.id DESC LIMIT $${args.length - 1} OFFSET $${args.length}`,
      args,
    ),
    pool.query(
      `SELECT ${postFields},p.password_hash AS "_passwordHash" FROM posts p JOIN users u ON u.id=p.author_id WHERE p.type='page' AND p.status='publish' ORDER BY p.menu_order,p.title,p.id`,
    ),
  ]);
  const sanitize = async (post: any) => {
    const { _passwordHash, ...safe } = post;
    return publicPost(
      safe,
      !(await hasPostAccess(req, post.id, _passwordHash)),
      { query: req.query },
    );
  };
  const { adminEmail: _adminEmail, ...safeSettings } = settings;
  const author = filter.author ? (await pool.query("SELECT display_name AS name FROM users WHERE id=$1 AND EXISTS(SELECT 1 FROM posts WHERE author_id=$1 AND type='post' AND status='publish')", [filter.author])).rows[0] : null;
  const icon = settings.siteIconId
    ? (
        await pool.query(
          "SELECT filename FROM media WHERE id=$1 AND mime_type LIKE 'image/%'",
          [settings.siteIconId],
        )
      ).rows[0]
    : null;
  const totalPosts = count.rows[0].total;
  const safePages = await Promise.all(pages.rows.map(sanitize));
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
    },
    archive: author ? { type: "author", name: author.name, authorId: filter.author } : null,
    posts: await Promise.all(posts.rows.map(sanitize)),
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
  await setRobots(res);
  res.json({
    post: await publicPost(post, locked, { query: req.query }),
    ...(await commentResponse(post.id, req, locked)),
  });
});
const passwordAttempts = new Map<string, { count: number; expires: number }>();
router.post("/public/posts/:slug/unlock", async (req, res) => {
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
    post: await publicPost(post, false, { query: req.query }),
    ...(await commentResponse(post.id, req)),
  });
});
const commentAttempts = new Map<string, { count: number; expires: number }>();
router.post("/public/comments", async (req, res) => {
  const key = req.ip ?? "unknown",
    now = Date.now(),
    attempt = commentAttempts.get(key);
  if (attempt && attempt.expires > now && attempt.count >= 20)
    throw new HttpError(429, "Too many comments. Please try again later.");
  if (commentAttempts.size >= 10000)
    for (const [k, v] of commentAttempts)
      if (v.expires <= now) commentAttempts.delete(k);
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
    })
    .strict()
    .parse(req.body);
  const settings = await getSettings(),
    user = (req as AuthRequest).user;
  if (settings.commentRegistration && !user)
    throw new HttpError(401, "Please log in to leave a comment.");
  const submittedName = user?.displayName ?? input.authorName ?? "",
    submittedEmail = user?.email ?? input.authorEmail ?? "";
  if (
    settings.requireCommentNameEmail &&
    (!submittedName.trim() || !submittedEmail)
  )
    throw new HttpError(400, "Enter your name and email address.");
  const content = cleanContent(input.content),
    authorName = plainText(submittedName).trim() || "Anonymous";
  if (!plainText(content).trim())
    throw new HttpError(400, "Write a comment before submitting.");
  if (!authorName) throw new HttpError(400, "Enter a name containing text.");
  const post = (
    await pool.query(
      "SELECT id,status,comment_status,password_hash,published_at FROM posts WHERE id=$1",
      [input.postId],
    )
  ).rows[0];
  if (!post || post.status !== "publish")
    throw new HttpError(404, "Post not found.");
  if (
    post.comment_status !== "open" ||
    (settings.closeCommentsDays > 0 &&
      post.published_at &&
      new Date(post.published_at).getTime() +
        settings.closeCommentsDays * 86_400_000 <
        Date.now())
  )
    throw new HttpError(409, "Comments are closed for this post.");
  if (!(await hasPostAccess(req, post.id, post.password_hash)))
    throw new HttpError(403, "Unlock this post before leaving a comment.");
  if (input.parentId) {
    if (!settings.threadComments)
      throw new HttpError(400, "Threaded comments are disabled.");
    const parent = await pool.query(
      "SELECT id FROM comments WHERE id=$1 AND post_id=$2 AND status='approved'",
      [input.parentId, post.id],
    );
    if (!parent.rowCount)
      throw new HttpError(
        400,
        "Choose an approved comment on this post to reply to.",
      );
    const ancestors = await pool.query(
      `WITH RECURSIVE ancestors AS(SELECT id,parent_id FROM comments WHERE id=$1 UNION SELECT c.id,c.parent_id FROM comments c JOIN ancestors a ON c.id=a.parent_id) SELECT count(*)::int AS depth FROM ancestors`,
      [input.parentId],
    );
    if (ancestors.rows[0].depth >= settings.threadDepth)
      throw new HttpError(
        400,
        "This comment thread has reached its maximum depth.",
      );
  }
  const status = (await classifySpam(content))
    ? "spam"
    : settings.commentModeration
      ? "pending"
      : "approved";
  const result = await pool.query(
    `INSERT INTO comments(post_id,author_name,author_email,content,status,parent_id,author_url,user_id) SELECT id,$2,$3,$4,$5,$6,$7,$8 FROM posts WHERE id=$1 AND status='publish' AND comment_status='open' RETURNING id`,
    [
      post.id,
      authorName,
      submittedEmail.toLowerCase(),
      content,
      status,
      input.parentId ?? null,
      input.authorUrl ?? "",
      user?.id ?? null,
    ],
  );
  if (!result.rowCount)
    throw new HttpError(409, "Comments are no longer available on this post.");
  res
    .status(201)
    .json({ ok: true, comment: { id: result.rows[0].id, status } });
});
export default router;
