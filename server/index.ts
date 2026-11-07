import "dotenv/config";
import express, {
  type ErrorRequestHandler,
  type NextFunction,
  type Request,
  type Response,
} from "express";
import multer from "multer";
import sanitizeHtml from "sanitize-html";
import { z } from "zod";
import { mkdir, unlink, writeFile, access } from "node:fs/promises";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import {
  pool,
  rootDir,
  uploadsDir,
  userFields,
  postFields,
  mediaFields,
  commentFields,
  getSettings,
  getPost,
  getComment,
  type User,
} from "./db.js";
import {
  attachUser,
  createSession,
  destroySession,
  hashPassword,
  requireRole,
  verifyPassword,
  type AuthRequest,
} from "./auth.js";

export const app = express();
app.disable("x-powered-by");
app.use((_req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  next();
});
app.use("/api", (_req, res, next) => {
  res.setHeader("Cache-Control", "no-store");
  next();
});
app.use("/api", (req, res, next) => {
  if (["GET", "HEAD", "OPTIONS"].includes(req.method)) {
    next();
    return;
  }
  const configuredOrigin = process.env.APP_ORIGIN || "http://127.0.0.1:5173";
  let expected: string;
  try {
    expected = new URL(configuredOrigin).origin;
  } catch {
    res
      .status(503)
      .json({ error: "The site origin is not configured correctly." });
    return;
  }
  if (!req.headers.origin || req.headers.origin !== expected) {
    res
      .status(403)
      .json({
        error: "This request must come from the configured site origin.",
      });
    return;
  }
  next();
});
app.use(express.json({ limit: "2mb" }));

app.get("/api/health", async (_req, res) => {
  try {
    await pool.query("SELECT 1");
    res.json({ ok: true });
  } catch {
    res.status(503).json({ ok: false });
  }
});
app.use("/api", attachUser);

function parseId(value: unknown): number {
  if (
    typeof value !== "string" ||
    !/^[1-9]\d{0,9}$/.test(value) ||
    Number(value) > 2_147_483_647
  )
    throw new HttpError(400, "Invalid item ID.");
  return Number(value);
}
class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
function needUser(req: AuthRequest) {
  if (!req.user) throw new HttpError(401, "Please log in to continue.");
  return req.user;
}
const contentRoles = requireRole("administrator", "editor", "author");
const moderationRoles = requireRole("administrator", "editor");
const administrator = requireRole("administrator");
function assertOwner(user: User, authorId: number) {
  if (user.role === "author" && user.id !== authorId)
    throw new HttpError(403, "You can only edit your own content.");
}
function assertPostType(user: User, type: string) {
  if (user.role === "author" && type === "page")
    throw new HttpError(
      403,
      "Authors can manage posts. Editing pages requires an editor or administrator.",
    );
}
const postSchema = z
  .object({
    type: z.enum(["post", "page"]).default("post"),
    title: z.string().trim().max(300).default(""),
    content: z.string().max(1_000_000).default(""),
    excerpt: z.string().max(20_000).default(""),
    status: z.enum(["publish", "draft", "trash"]).default("draft"),
    slug: z.string().max(220).optional(),
  })
  .strict();
// Keep update fields free of defaults: Zod 4 applies inner defaults even in
// optional fields, which would otherwise erase title/content on status updates.
const updatePostSchema = z
  .object({
    type: z.enum(["post", "page"]).optional(),
    title: z.string().trim().max(300).optional(),
    content: z.string().max(1_000_000).optional(),
    excerpt: z.string().max(20_000).optional(),
    status: z.enum(["publish", "draft", "trash"]).optional(),
    slug: z.string().max(220).optional(),
  })
  .strict()
  .refine(
    (value) => Object.keys(value).length > 0,
    "Provide at least one field to update.",
  );
const allowedTags = [
  "p",
  "br",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "ul",
  "ol",
  "li",
  "blockquote",
  "figure",
  "figcaption",
  "img",
  "a",
  "strong",
  "em",
  "b",
  "i",
  "u",
  "s",
  "del",
  "ins",
  "code",
  "pre",
  "hr",
  "div",
  "span",
  "table",
  "thead",
  "tbody",
  "tr",
  "th",
  "td",
];
function cleanContent(content: string) {
  return sanitizeHtml(content, {
    allowedTags,
    allowedAttributes: {
      a: ["href", "title", "target", "rel"],
      img: ["src", "alt", "title", "width", "height"],
      "*": ["class"],
      ol: ["start"],
      td: ["colspan", "rowspan"],
      th: ["colspan", "rowspan"],
    },
    allowedSchemes: ["http", "https", "mailto"],
    allowProtocolRelative: false,
    transformTags: {
      a: (_tag, attrs) => ({
        tagName: "a",
        attribs: { ...attrs, rel: "noopener noreferrer" },
      }),
    },
  });
}
function plainText(value: string) {
  // Text fields are escaped by React on output; decode the entities emitted by
  // the HTML stripper so a title such as "News & events" stays literal text.
  return sanitizeHtml(value, {
    allowedTags: [],
    allowedAttributes: {},
  }).replace(
    /&(amp|lt|gt|quot|#39);/g,
    (_match, entity: string) =>
      ({ amp: "&", lt: "<", gt: ">", quot: '"', "#39": "'" })[entity]!,
  );
}
function slugify(value: string) {
  return (
    value
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9\u00a1-\uffff]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 180) || "untitled"
  );
}
function rateLimit(max: number, duration: number) {
  const attempts = new Map<string, { count: number; expires: number }>();
  return (req: Request, res: Response, next: NextFunction) => {
    const now = Date.now();
    if (attempts.size >= 10_000)
      for (const [key, value] of attempts)
        if (value.expires <= now) attempts.delete(key);
    if (attempts.size >= 10_000 && !attempts.has(req.ip || "unknown")) {
      res
        .status(429)
        .json({ error: "Too many requests. Please try again later." });
      return;
    }
    const key = req.ip || "unknown";
    let attempt = attempts.get(key);
    if (!attempt || attempt.expires <= now) {
      attempt = { count: 0, expires: now + duration };
      attempts.set(key, attempt);
    }
    attempt.count++;
    if (attempt.count > max) {
      res.setHeader("Retry-After", Math.ceil((attempt.expires - now) / 1000));
      res
        .status(429)
        .json({ error: "Too many requests. Please try again later." });
      return;
    }
    next();
  };
}

app.get("/api/session", (req: AuthRequest, res) =>
  res.json({ user: req.user || null }),
);
app.post("/api/auth/login", rateLimit(30, 15 * 60_000), async (req, res) => {
  const input = z
    .object({
      login: z.string().trim().min(1).max(254),
      password: z.string().min(1).max(1024),
    })
    .strict()
    .parse(req.body);
  const result = await pool.query<User & { password_hash: string }>(
    `SELECT ${userFields}, password_hash FROM users WHERE lower(username) = lower($1) OR lower(email) = lower($1) LIMIT 1`,
    [input.login],
  );
  const record = result.rows[0];
  if (
    !record ||
    !(await verifyPassword(input.password, record.password_hash))
  ) {
    res.status(401).json({ error: "The username or password is incorrect." });
    return;
  }
  const { password_hash: _password, ...user } = record;
  await createSession(req, res, user.id);
  res.json({ user });
});
app.post("/api/auth/logout", async (req, res) => {
  await destroySession(req, res);
  res.json({ ok: true });
});

app.get("/api/dashboard", contentRoles, async (req: AuthRequest, res) => {
  const user = needUser(req);
  const own = user.role === "author";
  const params = own ? [user.id] : [];
  const [counts, recentPosts, recentComments] = await Promise.all([
    pool.query(
      `SELECT
      (SELECT count(*)::int FROM posts WHERE type = 'post' AND status = 'publish' ${own ? "AND author_id = $1" : ""}) AS posts,
      (SELECT count(*)::int FROM posts WHERE type = 'page' AND status = 'publish' ${own ? "AND author_id = $1" : ""}) AS pages,
      (SELECT count(*)::int FROM comments c JOIN posts p ON p.id = c.post_id WHERE c.status NOT IN ('trash', 'spam') ${own ? "AND p.author_id = $1" : ""}) AS comments,
      (SELECT count(*)::int FROM media ${own ? "WHERE author_id = $1" : ""}) AS media`,
      params,
    ),
    pool.query(
      `SELECT ${postFields} FROM posts p JOIN users u ON u.id = p.author_id WHERE p.status <> 'trash' ${own ? "AND p.author_id = $1" : ""} ORDER BY p.updated_at DESC LIMIT 5`,
      params,
    ),
    pool.query(
      `SELECT ${commentFields} FROM comments c JOIN posts p ON p.id = c.post_id WHERE c.status NOT IN ('trash', 'spam') ${own ? "AND p.author_id = $1" : ""} ORDER BY c.created_at DESC LIMIT 5`,
      params,
    ),
  ]);
  res.json({
    counts: counts.rows[0],
    recentPosts: recentPosts.rows,
    recentComments: recentComments.rows,
  });
});

app.get("/api/posts", contentRoles, async (req: AuthRequest, res) => {
  const user = needUser(req);
  const filter = z
    .object({
      type: z.enum(["post", "page"]).default("post"),
      status: z.enum(["all", "publish", "draft", "trash"]).default("all"),
      search: z.string().trim().max(200).default(""),
    })
    .parse(req.query);
  assertPostType(user, filter.type);
  const args: unknown[] = [filter.type];
  let where = "p.type = $1";
  if (user.role === "author") {
    args.push(user.id);
    where += ` AND p.author_id = $${args.length}`;
  }
  if (filter.search) {
    args.push(`%${filter.search}%`);
    where += ` AND (p.title ILIKE $${args.length} OR p.content ILIKE $${args.length})`;
  }
  const counts = await pool.query(
    `SELECT
    count(*) FILTER (WHERE p.status <> 'trash')::int AS all,
    count(*) FILTER (WHERE p.status = 'publish')::int AS publish,
    count(*) FILTER (WHERE p.status = 'draft')::int AS draft,
    count(*) FILTER (WHERE p.status = 'trash')::int AS trash FROM posts p WHERE ${where}`,
    args,
  );
  if (filter.status === "all") where += " AND p.status <> 'trash'";
  else {
    args.push(filter.status);
    where += ` AND p.status = $${args.length}`;
  }
  const result = await pool.query(
    `SELECT ${postFields} FROM posts p JOIN users u ON u.id = p.author_id WHERE ${where} ORDER BY p.updated_at DESC, p.id DESC`,
    args,
  );
  res.json({ posts: result.rows, counts: counts.rows[0] });
});
app.get("/api/posts/:id", contentRoles, async (req: AuthRequest, res) => {
  const post = await getPost(parseId(req.params.id));
  if (!post) throw new HttpError(404, "Post not found.");
  assertOwner(needUser(req), post.authorId);
  assertPostType(needUser(req), post.type);
  res.json({ post });
});
app.post("/api/posts", contentRoles, async (req: AuthRequest, res) => {
  const input = postSchema.parse(req.body);
  const user = needUser(req);
  assertPostType(user, input.type);
  const baseSlug = slugify(input.slug || input.title);
  for (let suffix = 0; suffix < 1000; suffix++) {
    const slug = baseSlug + (suffix ? `-${suffix + 1}` : "");
    const result = await pool.query(
      `INSERT INTO posts (type, title, slug, content, excerpt, status, author_id, published_at)
      VALUES ($1, $2, $3, $4, $5, $6::varchar, $7, CASE WHEN $6::varchar = 'publish'::varchar THEN now() ELSE NULL END)
      ON CONFLICT (slug) DO NOTHING RETURNING id`,
      [
        input.type,
        plainText(input.title),
        slug,
        cleanContent(input.content),
        plainText(input.excerpt),
        input.status,
        user.id,
      ],
    );
    if (result.rows[0]) {
      res.status(201).json({ post: await getPost(result.rows[0].id) });
      return;
    }
  }
  throw new HttpError(409, "Please choose a different permalink.");
});
app.put("/api/posts/:id", contentRoles, async (req: AuthRequest, res) => {
  const id = parseId(req.params.id);
  const input = updatePostSchema.parse(req.body);
  const post = await getPost(id);
  if (!post) throw new HttpError(404, "Post not found.");
  assertOwner(needUser(req), post.authorId);
  assertPostType(needUser(req), post.type);
  assertPostType(needUser(req), input.type ?? post.type);
  const status = input.status ?? post.status;
  const baseSlug =
    input.slug !== undefined
      ? slugify(input.slug || input.title || post.title)
      : post.slug;
  for (let suffix = 0; suffix < 1000; suffix++) {
    const slug = baseSlug + (suffix ? `-${suffix + 1}` : "");
    try {
      await pool.query(
        `UPDATE posts SET type = $1, title = $2, slug = $3, content = $4, excerpt = $5, status = $6::varchar,
        updated_at = now(), published_at = CASE WHEN $6::varchar = 'publish'::varchar THEN coalesce(published_at, now()) ELSE published_at END WHERE id = $7`,
        [
          input.type ?? post.type,
          input.title !== undefined ? plainText(input.title) : post.title,
          slug,
          input.content !== undefined
            ? cleanContent(input.content)
            : post.content,
          input.excerpt !== undefined ? plainText(input.excerpt) : post.excerpt,
          status,
          id,
        ],
      );
      res.json({ post: await getPost(id) });
      return;
    } catch (error) {
      if ((error as { code?: string }).code !== "23505") throw error;
    }
  }
  throw new HttpError(409, "Please choose a different permalink.");
});
app.delete("/api/posts/:id", contentRoles, async (req: AuthRequest, res) => {
  const id = parseId(req.params.id);
  const post = await getPost(id);
  if (!post) throw new HttpError(404, "Post not found.");
  assertOwner(needUser(req), post.authorId);
  assertPostType(needUser(req), post.type);
  if (post.status !== "trash")
    throw new HttpError(
      409,
      "Move the post to Trash before deleting it permanently.",
    );
  await pool.query("DELETE FROM posts WHERE id = $1 AND status = 'trash'", [
    id,
  ]);
  res.json({ ok: true });
});

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 8 * 1024 * 1024, files: 1, fields: 0 },
});
function imageType(buffer: Buffer) {
  if (
    buffer.length >= 8 &&
    buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  )
    return { extension: "png", mime: "image/png" };
  if (
    buffer.length >= 3 &&
    buffer[0] === 255 &&
    buffer[1] === 216 &&
    buffer[2] === 255
  )
    return { extension: "jpg", mime: "image/jpeg" };
  if (
    buffer.length >= 6 &&
    ["GIF87a", "GIF89a"].includes(buffer.subarray(0, 6).toString("ascii"))
  )
    return { extension: "gif", mime: "image/gif" };
  if (
    buffer.length >= 12 &&
    buffer.subarray(0, 4).toString("ascii") === "RIFF" &&
    buffer.subarray(8, 12).toString("ascii") === "WEBP"
  )
    return { extension: "webp", mime: "image/webp" };
  return null;
}
app.get("/api/media", contentRoles, async (req: AuthRequest, res) => {
  const user = needUser(req);
  const result = await pool.query(
    `SELECT ${mediaFields} FROM media ${user.role === "author" ? "WHERE author_id = $1" : ""} ORDER BY created_at DESC, id DESC`,
    user.role === "author" ? [user.id] : [],
  );
  res.json({ media: result.rows });
});
app.post(
  "/api/media",
  contentRoles,
  upload.single("file"),
  async (req: AuthRequest, res) => {
    const file = req.file;
    if (!file?.buffer.length)
      throw new HttpError(400, "Choose an image to upload.");
    const type = imageType(file.buffer);
    if (!type || type.mime !== file.mimetype)
      throw new HttpError(400, "Upload a valid JPEG, PNG, GIF, or WebP image.");
    const filename = `${randomBytes(20).toString("hex")}.${type.extension}`;
    const title =
      plainText(path.basename(file.originalname).replace(/\.[^.]+$/, "")).slice(
        0,
        300,
      ) || "Untitled image";
    await mkdir(uploadsDir, { recursive: true });
    const destination = path.join(uploadsDir, filename);
    await writeFile(destination, file.buffer, { flag: "wx", mode: 0o644 });
    try {
      const result = await pool.query(
        `INSERT INTO media (author_id, title, filename, mime_type, size) VALUES ($1, $2, $3, $4, $5) RETURNING ${mediaFields}`,
        [needUser(req).id, title, filename, type.mime, file.size],
      );
      res.status(201).json({ media: result.rows[0] });
    } catch (error) {
      await unlink(destination).catch(() => {});
      throw error;
    }
  },
);
const mediaSchema = z
  .object({
    title: z.string().trim().min(1).max(300).optional(),
    alt: z.string().max(1000).optional(),
    caption: z.string().max(20_000).optional(),
  })
  .strict()
  .refine(
    (value) => Object.keys(value).length > 0,
    "Provide at least one field to update.",
  );
app.put("/api/media/:id", contentRoles, async (req: AuthRequest, res) => {
  const id = parseId(req.params.id);
  const input = mediaSchema.parse(req.body);
  const result = await pool.query("SELECT * FROM media WHERE id = $1", [id]);
  const media = result.rows[0];
  if (!media) throw new HttpError(404, "Media item not found.");
  assertOwner(needUser(req), media.author_id);
  const title = plainText(input.title ?? media.title).trim();
  if (!title) throw new HttpError(400, "Enter an image title containing text.");
  const updated = await pool.query(
    `UPDATE media SET title = $1, alt = $2, caption = $3 WHERE id = $4 RETURNING ${mediaFields}`,
    [
      title,
      plainText(input.alt ?? media.alt),
      plainText(input.caption ?? media.caption),
      id,
    ],
  );
  res.json({ media: updated.rows[0] });
});
app.delete("/api/media/:id", contentRoles, async (req: AuthRequest, res) => {
  const id = parseId(req.params.id);
  const result = await pool.query(
    "SELECT filename, author_id FROM media WHERE id = $1",
    [id],
  );
  if (!result.rows[0]) throw new HttpError(404, "Media item not found.");
  assertOwner(needUser(req), result.rows[0].author_id);
  await pool.query("DELETE FROM media WHERE id = $1", [id]);
  await unlink(path.join(uploadsDir, result.rows[0].filename)).catch(
    (error) => {
      if (error.code !== "ENOENT")
        console.error("Could not remove deleted media file:", error.message);
    },
  );
  res.json({ ok: true });
});

app.get("/api/comments", moderationRoles, async (_req, res) => {
  const result = await pool.query(
    `SELECT ${commentFields} FROM comments c JOIN posts p ON p.id = c.post_id ORDER BY c.created_at DESC, c.id DESC`,
  );
  res.json({ comments: result.rows });
});
app.put("/api/comments/:id", moderationRoles, async (req, res) => {
  const id = parseId(req.params.id);
  const input = z
    .object({ status: z.enum(["approved", "pending", "spam", "trash"]) })
    .strict()
    .parse(req.body);
  const result = await pool.query(
    "UPDATE comments SET status = $1 WHERE id = $2 RETURNING id",
    [input.status, id],
  );
  if (!result.rows[0]) throw new HttpError(404, "Comment not found.");
  res.json({ comment: await getComment(id) });
});
app.delete("/api/comments/:id", moderationRoles, async (req, res) => {
  const result = await pool.query(
    "DELETE FROM comments WHERE id = $1 RETURNING id",
    [parseId(req.params.id)],
  );
  if (!result.rows[0]) throw new HttpError(404, "Comment not found.");
  res.json({ ok: true });
});

app.get("/api/users", administrator, async (_req, res) => {
  const result = await pool.query(
    `SELECT ${userFields} FROM users ORDER BY id`,
  );
  res.json({ users: result.rows });
});
app.post("/api/users", administrator, async (req, res) => {
  const input = z
    .object({
      username: z
        .string()
        .trim()
        .min(1)
        .max(60)
        .regex(
          /^[a-zA-Z0-9_.@-]+$/,
          "Use letters, numbers, periods, underscores, @, or hyphens for the username.",
        ),
      email: z.email().max(254),
      displayName: z.string().trim().min(1).max(160),
      password: z
        .string()
        .min(12, "Use a password with at least 12 characters.")
        .max(1024),
      role: z.enum(["administrator", "editor", "author", "subscriber"]),
    })
    .strict()
    .parse(req.body);
  const displayName = plainText(input.displayName).trim();
  if (!displayName)
    throw new HttpError(400, "Enter a display name containing text.");
  const result = await pool.query(
    `INSERT INTO users (username, email, display_name, password_hash, role) VALUES ($1, $2, $3, $4, $5) RETURNING ${userFields}`,
    [
      input.username,
      input.email.toLowerCase(),
      displayName,
      await hashPassword(input.password),
      input.role,
    ],
  );
  res.status(201).json({ user: result.rows[0] });
});
app.delete("/api/users/:id", administrator, async (req: AuthRequest, res) => {
  const id = parseId(req.params.id);
  const user = needUser(req);
  if (id === user.id)
    throw new HttpError(
      400,
      "You cannot delete the account you are signed in with.",
    );
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const existing = await client.query(
      "SELECT id FROM users WHERE id = $1 FOR UPDATE",
      [id],
    );
    if (!existing.rows[0]) throw new HttpError(404, "User not found.");
    await client.query("UPDATE posts SET author_id = $1 WHERE author_id = $2", [
      user.id,
      id,
    ]);
    await client.query("UPDATE media SET author_id = $1 WHERE author_id = $2", [
      user.id,
      id,
    ]);
    await client.query("DELETE FROM users WHERE id = $1", [id]);
    await client.query("COMMIT");
    res.json({ ok: true });
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
});

const settingsSchema = z
  .object({
    siteTitle: z.string().trim().min(1).max(200),
    tagline: z.string().max(500),
    siteUrl: z
      .url()
      .max(2000)
      .refine(
        (value) => /^https?:\/\//i.test(value),
        "Use an HTTP or HTTPS site URL.",
      ),
    adminEmail: z.email().max(254),
    timezone: z
      .string()
      .max(100)
      .refine((value) => {
        try {
          new Intl.DateTimeFormat("en", { timeZone: value });
          return true;
        } catch {
          return false;
        }
      }, "Choose a valid timezone."),
    dateFormat: z.string().min(1).max(80),
    timeFormat: z.string().min(1).max(80),
    postsPerPage: z.number().int().min(1).max(100),
    discourageSearchEngines: z.boolean(),
    theme: z.enum(["twentytwentyfive", "classic"]),
  })
  .partial()
  .strict()
  .refine(
    (value) => Object.keys(value).length > 0,
    "Provide at least one setting to update.",
  );
app.get("/api/settings", administrator, async (_req, res) =>
  res.json({ settings: await getSettings() }),
);
app.put("/api/settings", administrator, async (req, res) => {
  const input = settingsSchema.parse(req.body);
  if (input.siteTitle !== undefined) {
    input.siteTitle = plainText(input.siteTitle).trim();
    if (!input.siteTitle)
      throw new HttpError(400, "Enter a site title containing text.");
  }
  if (input.tagline !== undefined) input.tagline = plainText(input.tagline);
  if (input.adminEmail !== undefined)
    input.adminEmail = input.adminEmail.toLowerCase();
  // Merge only the requested fields in PostgreSQL, preserving simultaneous
  // changes to other settings made by another administrator.
  await pool.query(
    "INSERT INTO settings (id, data) VALUES (1, $1::jsonb) ON CONFLICT (id) DO UPDATE SET data = settings.data || EXCLUDED.data",
    [JSON.stringify(input)],
  );
  res.json({ settings: await getSettings() });
});

function publicSettings(settings: Awaited<ReturnType<typeof getSettings>>) {
  const { adminEmail: _adminEmail, ...safe } = settings;
  return safe;
}
app.get("/api/public/site", async (req, res) => {
  const page = z.coerce
    .number()
    .int()
    .positive()
    .max(2_147_483_647)
    .default(1)
    .parse(req.query.page);
  const settings = await getSettings();
  const [posts, pages, count] = await Promise.all([
    pool.query(
      `SELECT ${postFields} FROM posts p JOIN users u ON u.id = p.author_id WHERE p.type = 'post' AND p.status = 'publish' ORDER BY p.published_at DESC, p.id DESC LIMIT $1 OFFSET $2`,
      [settings.postsPerPage, (page - 1) * settings.postsPerPage],
    ),
    pool.query(
      `SELECT ${postFields} FROM posts p JOIN users u ON u.id = p.author_id WHERE p.type = 'page' AND p.status = 'publish' ORDER BY p.title`,
    ),
    pool.query(
      "SELECT count(*)::int AS total FROM posts WHERE type = 'post' AND status = 'publish'",
    ),
  ]);
  const totalPosts = count.rows[0].total as number;
  const pagination = {
    page,
    totalPosts,
    totalPages: Math.max(1, Math.ceil(totalPosts / settings.postsPerPage)),
  };
  if (settings.discourageSearchEngines)
    res.setHeader("X-Robots-Tag", "noindex, nofollow");
  res.json({
    settings: publicSettings(settings),
    posts: posts.rows,
    pages: pages.rows,
    pagination,
  });
});
app.get("/api/public/posts/:slug", async (req, res) => {
  const slug = z.string().min(1).max(220).parse(req.params.slug);
  const result = await pool.query(
    `SELECT ${postFields} FROM posts p JOIN users u ON u.id = p.author_id WHERE p.slug = $1 AND p.status = 'publish'`,
    [slug],
  );
  const post = result.rows[0];
  if (!post) throw new HttpError(404, "Post not found.");
  const comments = await pool.query(
    `SELECT c.id, c.author_name AS "authorName", c.content, c.status, c.post_id AS "postId", p.title AS "postTitle", c.created_at AS "createdAt" FROM comments c JOIN posts p ON p.id = c.post_id WHERE c.post_id = $1 AND c.status = 'approved' ORDER BY c.created_at`,
    [post.id],
  );
  if ((await getSettings()).discourageSearchEngines)
    res.setHeader("X-Robots-Tag", "noindex, nofollow");
  res.json({ post, comments: comments.rows });
});
app.post(
  "/api/public/comments",
  rateLimit(20, 60 * 60_000),
  async (req, res) => {
    const input = z
      .object({
        postId: z.number().int().positive().max(2_147_483_647),
        authorName: z.string().trim().min(1).max(160),
        authorEmail: z.email().max(254),
        content: z.string().trim().min(1).max(20_000),
      })
      .strict()
      .parse(req.body);
    const content = sanitizeHtml(input.content, {
      allowedTags: ["p", "br", "strong", "em", "a", "blockquote", "code"],
      allowedAttributes: { a: ["href"] },
      allowedSchemes: ["http", "https"],
      allowProtocolRelative: false,
    });
    if (!plainText(content).trim())
      throw new HttpError(400, "Write a comment before submitting.");
    const authorName = plainText(input.authorName).trim();
    if (!authorName) throw new HttpError(400, "Enter a name containing text.");
    const result = await pool.query(
      `INSERT INTO comments (post_id, author_name, author_email, content, status)
    SELECT id, $2, $3, $4, 'pending' FROM posts WHERE id = $1 AND status = 'publish' RETURNING id`,
      [input.postId, authorName, input.authorEmail.toLowerCase(), content],
    );
    if (!result.rows[0]) throw new HttpError(404, "Post not found.");
    res.status(201).json({ ok: true });
  },
);

app.use("/api", (_req, res) =>
  res.status(404).json({ error: "API endpoint not found." }),
);
app.use(
  "/uploads",
  express.static(uploadsDir, {
    index: false,
    dotfiles: "deny",
    fallthrough: false,
    maxAge: "1d",
    setHeaders: (res) =>
      res.setHeader("Content-Security-Policy", "default-src 'none'; sandbox"),
  }),
);
app.get("/wp-admin", (_req, res) => res.redirect("/admin"));
app.get("/wp-login.php", (_req, res) => res.redirect("/login"));
const distDir = path.resolve(
  process.env.STATIC_DIR || path.join(rootDir, "dist"),
);
app.use(express.static(distDir, { index: false }));
app.get("/{*splat}", async (_req, res, next) => {
  try {
    await access(path.join(distDir, "index.html"));
    res.sendFile(path.join(distDir, "index.html"));
  } catch {
    next(
      new HttpError(
        404,
        "Build the React application or use the development server.",
      ),
    );
  }
});

const errorHandler: ErrorRequestHandler = (error, _req, res, _next) => {
  if (res.headersSent) return;
  if (error instanceof z.ZodError) {
    res
      .status(400)
      .json({
        error: error.issues
          .map(
            (issue) => `${issue.path.join(".") || "Request"}: ${issue.message}`,
          )
          .join(" "),
      });
    return;
  }
  if (error instanceof multer.MulterError) {
    res
      .status(error.code === "LIMIT_FILE_SIZE" ? 413 : 400)
      .json({
        error:
          error.code === "LIMIT_FILE_SIZE"
            ? "The image exceeds the 8 MiB upload limit."
            : "Upload one image using the file field.",
      });
    return;
  }
  if (error instanceof HttpError) {
    res.status(error.status).json({ error: error.message });
    return;
  }
  if (error?.type === "entity.too.large") {
    res.status(413).json({ error: "The request is too large." });
    return;
  }
  if (error instanceof SyntaxError && "body" in error) {
    res
      .status(400)
      .json({ error: "The request body must contain valid JSON." });
    return;
  }
  if (error?.status === 404) {
    res.status(404).json({ error: "File not found." });
    return;
  }
  if (error?.code === "23505") {
    res
      .status(409)
      .json({ error: "That username, email, or permalink is already in use." });
    return;
  }
  if (error?.code === "23503") {
    res
      .status(409)
      .json({
        error:
          "This item changed while you were editing. Refresh and try again.",
      });
    return;
  }
  console.error(
    "WorldAct request failed:",
    error instanceof Error ? error.message : error,
  );
  res.status(500).json({ error: "Something went wrong. Please try again." });
};
app.use(errorHandler);

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const port = Number(process.env.PORT || 3001);
  const server = app.listen(port, "127.0.0.1", () =>
    console.log(`WorldAct API listening on http://127.0.0.1:${port}`),
  );
  const stop = () =>
    server.close(() => {
      void pool.end().then(() => process.exit(0));
    });
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}
