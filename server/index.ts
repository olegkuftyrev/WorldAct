import "dotenv/config";
import express, {
  type ErrorRequestHandler,
  type NextFunction,
  type Request,
  type Response,
} from "express";
import multer from "multer";
import { z } from "zod";
import { access } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  pool,
  rootDir,
  uploadsDir,
  userFields,
  postFields,
  mediaFields,
  commentFields,
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

import coreRouter, { startScheduler } from "./core.js";
import platformRouter from "./platform.js";
import compatRouter from "./compat.js";
import { plainText, HttpError, parseId, needUser } from "./utils.js";

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
    res.status(403).json({
      error: "This request must come from the configured site origin.",
    });
    return;
  }
  next();
});
app.use(express.json({ limit: "10mb" }));
app.use(compatRouter);

app.get("/api/health", async (_req, res) => {
  try {
    await pool.query("SELECT 1");
    res.json({ ok: true });
  } catch {
    res.status(503).json({ ok: false });
  }
});
app.use("/api", attachUser);
app.use("/api", platformRouter);
app.use("/api", coreRouter);

const contentRoles = requireRole("administrator", "editor", "author");
const dashboardRoles = requireRole(
  "administrator",
  "editor",
  "author",
  "contributor",
);
const moderationRoles = requireRole("administrator", "editor");
const administrator = requireRole("administrator");
function assertOwner(user: User, authorId: number) {
  if (["author", "contributor"].includes(user.role) && user.id !== authorId)
    throw new HttpError(403, "You can only edit your own content.");
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

app.get("/api/dashboard", dashboardRoles, async (req: AuthRequest, res) => {
  const user = needUser(req);
  const own = user.role === "author" || user.role === "contributor";
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
      role: z.enum([
        "administrator",
        "editor",
        "author",
        "contributor",
        "subscriber",
      ]),
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
    res.status(400).json({
      error: error.issues
        .map(
          (issue) => `${issue.path.join(".") || "Request"}: ${issue.message}`,
        )
        .join(" "),
    });
    return;
  }
  if (error instanceof multer.MulterError) {
    res.status(error.code === "LIMIT_FILE_SIZE" ? 413 : 400).json({
      error:
        error.code === "LIMIT_FILE_SIZE"
          ? "The file exceeds the 32 MiB upload limit."
          : "Upload one file using the file field.",
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
    res.status(409).json({
      error: "This item changed while you were editing. Refresh and try again.",
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
  const stopScheduler = startScheduler();
  const port = Number(process.env.PORT || 3001);
  const server = app.listen(port, "127.0.0.1", () =>
    console.log(`WorldAct API listening on http://127.0.0.1:${port}`),
  );
  const stop = () => {
    stopScheduler();
    server.close(() => {
      void pool.end().then(() => process.exit(0));
    });
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}
