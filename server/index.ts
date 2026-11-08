import { publicDocumentIdentity } from "./public-documents.js";
import incomingPingsRouter from "./incoming-pings.js";
import outgoingPingsRouter,{startOutgoingPingWorker} from "./outgoing-pings.js";
import "dotenv/config";
import express, {
  type ErrorRequestHandler,
} from "express";
import multer from "multer";
import { z } from "zod";
import qs from "qs";
import { access } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  pool,
  rootDir,
  uploadsDir,
  mediaFields,
  type User,
} from "./db.js";
import {
  attachUser,
  destroySession,
  requireRole,
  type AuthRequest,
} from "./auth.js";

import coreRouter, { startScheduler } from "./core.js";
import platformRouter from "./platform.js";
import compatRouter from "./compat.js";
import commentsRouter from "./comments.js";
import accountsRouter from "./accounts.js";
import legacyRouter from "./legacy.js";
import blocksRouter from "./blocks.js";
import applicationPasswordsRouter from "./application-passwords.js";
import usersRouter from "./users.js";
import nativeFormsRouter from "./native-forms.js";
import { authenticateLogin, loginRateLimit } from "./login.js";
import editLocksRouter from "./edit-locks.js";
import siteIdentityRouter from "./site-identity.js";
import profileEmailRouter from "./profile-email.js";
import installRouter from "./install.js";
import diagnosticsRouter from "./diagnostics.js";
import privacyPolicyRouter from "./privacy-policy.js";
import fontsRouter from "./fonts.js";
import postTemplatesRouter from "./post-templates.js";
import bundledPluginsRouter from "./bundled-plugins.js";
import connectorsRouter from "./connectors.js";
import { readDashboard } from "./dashboard.js";
import mailIntakeRouter, { startMailIntakeWorker } from "./mail-intake.js";
import { plainText, HttpError, parseId, needUser } from "./utils.js";

export const app = express();
app.disable("x-powered-by");
app.set("query parser", (query: string) => {
  try {
    return qs.parse(query, {
      arrayLimit: 1000,
      parameterLimit: 2000,
      depth: 5,
      strictDepth: true,
      throwOnLimitExceeded: true,
      allowPrototypes: false,
    });
  } catch {
    throw new HttpError(400, "The query exceeds the supported size or nesting limit.");
  }
});
app.use((_req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  next();
});
app.use(incomingPingsRouter);
app.use(["/api", "/wp-json", "/wp-comments-post.php", "/logout", "/post-password", "/public-login"], attachUser);
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
  if (req.headers.origin !== expected && !(!req.headers.origin && (req as AuthRequest).authenticationMethod === "application-password")) {
    res.status(403).json({
      error: "This request must come from the configured site origin.",
    });
    return;
  }
  next();
});
app.use("/api/tools/import", attachUser, requireRole("administrator"), express.json({ limit: "96mb" }));
app.use(express.json({ limit: "10mb" }));
app.use(nativeFormsRouter);
app.use(blocksRouter);
app.use(applicationPasswordsRouter);
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
app.use("/api", accountsRouter);
app.use("/api", installRouter);
app.use("/api", commentsRouter);
app.use("/api", usersRouter);
app.use("/api", editLocksRouter);
app.use("/api", siteIdentityRouter);
app.use("/api", profileEmailRouter);
app.use("/api", diagnosticsRouter);
app.use("/api", privacyPolicyRouter);
app.use("/api", fontsRouter);
app.use("/api", postTemplatesRouter);
app.use("/api", bundledPluginsRouter);
app.use("/api", connectorsRouter);
app.use("/api", mailIntakeRouter);
app.use("/api", outgoingPingsRouter);
app.use("/api", platformRouter);
app.use("/api", coreRouter);

const contentRoles = requireRole("administrator", "editor", "author");
const dashboardRoles = requireRole(
  "administrator",
  "editor",
  "author",
  "contributor",
);
const administrator = requireRole("administrator");
function assertOwner(user: User, authorId: number) {
  if (["author", "contributor"].includes(user.role) && user.id !== authorId)
    throw new HttpError(403, "You can only edit your own content.");
}

app.get("/api/session", (req: AuthRequest, res) =>
  res.json({ user: req.user || null }),
);
app.post("/api/auth/login", loginRateLimit, async (req, res) => {
  const input = z
    .object({
      login: z.string().trim().min(1).max(254),
      password: z.string().min(1).max(1024),
      remember: z.boolean().optional(),
    })
    .strict()
    .parse(req.body);
  const user = await authenticateLogin(req, res, input);
  if (!user) {
    res.status(401).json({ error: "The username or password is incorrect." });
    return;
  }
  res.json({ user });
});
app.post("/api/auth/logout", async (req, res) => {
  await destroySession(req, res);
  res.json({ ok: true });
});

app.get("/api/dashboard", dashboardRoles, async (req: AuthRequest, res) => {
  res.json(await readDashboard(needUser(req)));
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
app.use(legacyRouter);
const distDir = path.resolve(
  process.env.STATIC_DIR || path.join(rootDir, "dist"),
);
app.use(express.static(distDir, { index: false }));
app.get("/{*splat}", async (req, res) => {
  const document = await publicDocumentIdentity(req.originalUrl);
  const index = path.join(distDir, "index.html");
  await access(index).catch(error => {
    if (error?.code === "ENOENT" || error?.code === "ENOTDIR")
      throw new HttpError(404, "Build the React application or use the development server.");
    throw error;
  });
  if (document.pingback) res.setHeader("X-Pingback", document.pingback);
  // A React document can acquire account/password state without a new HTML
  // navigation. Keep every bootstrap private, including an anonymous opening
  // followed by an in-app login; assets retain their own static-file policy.
  res.setHeader("Cache-Control", "no-cache, must-revalidate, max-age=0, no-store, private");
  res.setHeader("Expires", "Wed, 11 Jan 1984 05:00:00 GMT");
  res.status(document.status).sendFile(index, { cacheControl: false, lastModified: false });
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
  if (error instanceof URIError) {
    res.status(400).json({ error: "The URL path is malformed." });
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
  let stopPings=()=>{}, stopMail=()=>{};
  const port = Number(process.env.PORT || 3001);
  const server = app.listen(port, "127.0.0.1", (error?:Error) => {
    if(error){
      stopScheduler();stopPings();stopMail();
      console.error("Could not start WorldAct API:",error.message);
      process.exitCode=1;
      void pool.end();
      return;
    }
    stopPings=startOutgoingPingWorker();
    stopMail=startMailIntakeWorker();
    console.log(`WorldAct API listening on http://127.0.0.1:${port}`);
  });
  const stop = () => {
    stopScheduler();stopPings();stopMail();
    server.close(() => {
      void pool.end().then(() => process.exit(0));
    });
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}
