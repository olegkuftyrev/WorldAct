import express from "express";
import multer from "multer";
import sharp from "sharp";
import { fileTypeFromBuffer } from "file-type";
import nodemailer from "nodemailer";
import { z } from "zod";
import { createHash, randomBytes } from "node:crypto";
import { mkdir, writeFile, readFile, unlink, copyFile } from "node:fs/promises";
import path from "node:path";
import {
  pool,
  uploadsDir,
  getSettings,
  userFields,
  mediaFields,
} from "./db.js";
import {
  hashPassword,
  verifyPassword,
  requireRole,
  type AuthRequest,
} from "./auth.js";
import {
  cleanContent,
  cleanRawContent,
  plainText,
  HttpError,
  parseId,
  needUser,
  cleanBlocks,
} from "./utils.js";
import { readDesign, pluginRegistry, themes } from "./design.js";
import {
  buildSizes,
  uploadPrefix,
  safeStoredFile,
  mediaBackups,
} from "./media-files.js";

const router = express.Router();
const admin = requireRole("administrator");
const editors = requireRole("administrator", "editor");
const creators = requireRole("administrator", "editor", "author");
const auth = requireRole(
  "administrator",
  "editor",
  "author",
  "contributor",
  "subscriber",
);
const text = (min: number, max: number) => z.string().trim().min(min).max(max);
const id = z.number().int().positive().max(2147483647);
const nullableId = id.nullable();
const safeUrl = z
  .string()
  .max(2000)
  .refine(
    (s) =>
      !s || (/^(https?:\/\/|\/|#|mailto:)/i.test(s) && !s.startsWith("//")),
    "Use an HTTP(S), relative, or email URL.",
  );
const docFields =
  'id,slug,title,type,content,blocks,version,updated_at AS "updatedAt"';
const menuFields = 'id,name,location,items,updated_at AS "updatedAt"';
function normalizedText(value: string) {
  const clean = plainText(value).trim();
  if (!clean) throw new HttpError(400, "Enter meaningful text.");
  return clean;
}
function ownsMedia(req: AuthRequest, owner: number) {
  const user = needUser(req);
  if (user.role === "author" && owner !== user.id)
    throw new HttpError(403, "You can only edit your own media.");
}
function parseBlocks(value: unknown) {
  return value === undefined || value === null ? null : cleanBlocks(value);
}

// General, Writing, Reading, Discussion, Media, Permalinks and Privacy settings.
const settingSchema = z
  .object({
    siteTitle: text(1, 200),
    tagline: z.string().max(500),
    siteUrl: z
      .url()
      .max(2000)
      .refine((v) => /^https?:\/\//i.test(v)),
    adminEmail: z.email().max(254),
    timezone: text(1, 100).refine((v) => {
      try {
        new Intl.DateTimeFormat("en", { timeZone: v });
        return true;
      } catch {
        return false;
      }
    }),
    dateFormat: text(1, 80),
    timeFormat: text(1, 80),
    postsPerPage: z.number().int().min(1).max(100),
    discourageSearchEngines: z.boolean(),
    theme: z.enum([
      "twentytwentyfive",
      "twentytwentyfour",
      "twentytwentythree",
      "classic",
    ]),
    defaultCategoryId: nullableId,
    defaultPostFormat: z.enum([
      "standard",
      "aside",
      "image",
      "video",
      "quote",
      "link",
      "gallery",
      "audio",
    ]),
    frontPageMode: z.enum(["posts", "page"]),
    frontPageId: nullableId,
    postsPageId: nullableId,
    feedItems: z.number().int().min(1).max(100),
    feedExcerpt: z.boolean(),
    defaultCommentStatus: z.enum(["open", "closed"]),
    requireCommentNameEmail: z.boolean(),
    commentRegistration: z.boolean(),
    commentModeration: z.boolean(),
    commentsPerPage: z.number().int().min(1).max(200),
    threadComments: z.boolean(),
    threadDepth: z.number().int().min(1).max(10),
    closeCommentsDays: z.number().int().min(0).max(3650),
    commentOrder: z.enum(["asc", "desc"]),
    permalinkStructure: text(1, 200).refine((s) => {
      const tokens = s.match(/%[^%]+%/g) || [];
      return (
        s.startsWith("/") &&
        s.endsWith("/") &&
        !/[?#<>\\\s]/.test(s) &&
        !s.includes("//") &&
        !s.split("/").includes("..") &&
        !/^\/(api|admin|uploads|wp-json|login|lost-password|reset-password)(\/|$)/.test(
          s,
        ) &&
        /%(postname|post_id)%/.test(s) &&
        new Set(tokens).size === tokens.length &&
        !/%[^%]+%%/.test(s) &&
        !s
          .replace(/%(postname|post_id|year|monthnum|day|category)%/g, "")
          .includes("%")
      );
    }, "Use a unique path beginning and ending with / and containing %postname% or %post_id%. Supported tokens: %postname%, %post_id%, %year%, %monthnum%, %day%, %category%."),
    categoryBase: text(1, 80).regex(/^[a-z0-9-]+$/),
    tagBase: text(1, 80).regex(/^[a-z0-9-]+$/),
    thumbnailWidth: z.number().int().min(1).max(4096),
    thumbnailCrop: z.boolean(),
    thumbnailHeight: z.number().int().min(1).max(4096),
    mediumWidth: z.number().int().min(1).max(8192),
    mediumHeight: z.number().int().min(1).max(8192),
    largeWidth: z.number().int().min(1).max(8192),
    largeHeight: z.number().int().min(1).max(8192),
    uploadsYearMonth: z.boolean(),
    privacyPageId: nullableId,
  })
  .partial()
  .strict();
router.get("/settings", admin, async (_req, res) =>
  res.json({ settings: await getSettings() }),
);
router.put("/settings", admin, async (req, res) => {
  const input = settingSchema.parse(req.body);
  if (!Object.keys(input).length)
    throw new HttpError(400, "Provide settings to save.");
  for (const field of ["siteTitle", "tagline"] as const)
    if (input[field] !== undefined)
      input[field] =
        field === "siteTitle"
          ? normalizedText(input[field]!)
          : plainText(input[field]!);
  for (const key of ["frontPageId", "postsPageId", "privacyPageId"] as const) {
    if (input[key]) {
      const found = await pool.query(
        "SELECT id FROM posts WHERE id=$1 AND type='page' AND status<>'trash'",
        [input[key]],
      );
      if (!found.rowCount) throw new HttpError(400, "Choose an existing page.");
    }
  }
  if (input.defaultCategoryId) {
    const term = await pool.query(
      "SELECT id FROM terms WHERE id=$1 AND taxonomy='category'",
      [input.defaultCategoryId],
    );
    if (!term.rowCount)
      throw new HttpError(400, "Choose an existing category.");
  }
  await pool.query("UPDATE settings SET data=data || $1::jsonb WHERE id=1", [
    JSON.stringify(input),
  ]);
  res.json({ settings: await getSettings() });
});

const profileSchema = z
  .object({
    email: z.email().max(254).optional(),
    displayName: text(1, 160).optional(),
    firstName: z.string().max(100).optional(),
    lastName: z.string().max(100).optional(),
    nickname: z.string().max(100).optional(),
    bio: z.string().max(5000).optional(),
    website: safeUrl.optional(),
    adminColor: z
      .enum([
        "modern",
        "fresh",
        "light",
        "blue",
        "coffee",
        "ectoplasm",
        "midnight",
        "ocean",
        "sunrise",
      ])
      .optional(),
    locale: text(1, 40).optional(),
    password: z.string().min(12).max(1024).optional(),
    currentPassword: z.string().max(1024).optional(),
    role: z
      .enum(["administrator", "editor", "author", "contributor", "subscriber"])
      .optional(),
  })
  .strict();
router.get("/profile", auth, async (req: AuthRequest, res) => {
  const user = needUser(req);
  const result = await pool.query(
    `SELECT ${userFields},profile,preferences FROM users WHERE id=$1`,
    [user.id],
  );
  const row = result.rows[0];
  res.json({ user: { ...row, ...row.profile }, preferences: row.preferences });
});
async function updateUser(req: AuthRequest, target: number) {
  const user = needUser(req),
    input = profileSchema.parse(req.body);
  if (target !== user.id && user.role !== "administrator")
    throw new HttpError(403, "You cannot edit this user.");
  const existing = await pool.query("SELECT * FROM users WHERE id=$1", [
    target,
  ]);
  const row = existing.rows[0];
  if (!row) throw new HttpError(404, "User not found.");
  if (
    input.role &&
    input.role !== row.role &&
    (user.role !== "administrator" || user.id === target)
  )
    throw new HttpError(403, "You cannot change this account role.");
  if (
    input.password &&
    target === user.id &&
    (!input.currentPassword ||
      !(await verifyPassword(input.currentPassword, row.password_hash)))
  )
    throw new HttpError(400, "Your current password is incorrect.");
  const {
    email,
    displayName,
    password,
    currentPassword: _current,
    role,
    ...profile
  } = input;
  for (const key of ["firstName", "lastName", "nickname", "bio"] as const)
    if (profile[key] !== undefined) profile[key] = plainText(profile[key]!);
  await pool.query(
    "UPDATE users SET email=$1,display_name=$2,password_hash=$3,role=$4,profile=profile || $5::jsonb WHERE id=$6",
    [
      email?.toLowerCase() ?? row.email,
      displayName !== undefined
        ? normalizedText(displayName)
        : row.display_name,
      password ? await hashPassword(password) : row.password_hash,
      role ?? row.role,
      JSON.stringify(profile),
      target,
    ],
  );
  if (password) {
    const token = req.headers.cookie
      ?.split(";")
      .map((s) => s.trim())
      .find((s) => s.startsWith("worldact_session="))
      ?.split("=")[1];
    await pool.query(
      "DELETE FROM sessions WHERE user_id=$1 AND token_hash<>$2",
      [target, token ? createHash("sha256").update(token).digest("hex") : ""],
    );
  }
  const result = await pool.query(
    `SELECT ${userFields},profile FROM users WHERE id=$1`,
    [target],
  );
  return { ...result.rows[0], ...result.rows[0].profile };
}
router.put("/profile", auth, async (req: AuthRequest, res) =>
  res.json({ user: await updateUser(req, needUser(req).id) }),
);
router.get("/users/:id", admin, async (req, res) => {
  const result = await pool.query(
    `SELECT ${userFields},profile FROM users WHERE id=$1`,
    [parseId(req.params.id)],
  );
  if (!result.rowCount) throw new HttpError(404, "User not found.");
  const { profile, ...user } = result.rows[0];
  res.json({ user: { ...user, ...profile } });
});
router.delete("/users/:id", admin, async (req: AuthRequest, res) => {
  const user = needUser(req),
    target = parseId(req.params.id);
  if (target === user.id)
    throw new HttpError(
      400,
      "You cannot delete the account you are signed in with.",
    );
  const options = z
    .object({
      reassignTo: z.coerce.number().int().positive().optional(),
      deleteContent: z.enum(["true", "false"]).optional(),
    })
    .parse(req.query);
  const replacement = options.reassignTo ?? user.id;
  if (replacement === target)
    throw new HttpError(400, "Choose another user to receive this content.");
  const client = await pool.connect();
  const files: string[] = [];
  try {
    await client.query("BEGIN");
    const exists = await client.query(
      "SELECT id FROM users WHERE id=ANY($1::int[]) ORDER BY id FOR UPDATE",
      [[target, replacement]],
    );
    if (exists.rowCount !== 2) throw new HttpError(404, "User not found.");
    if (options.deleteContent === "true") {
      const media = await client.query(
        "SELECT filename,original_filename,derivatives,sizes FROM media WHERE author_id=$1",
        [target],
      );
      for (const item of media.rows)
        for (const value of [
          item.filename,
          item.original_filename,
          ...Object.values(item.derivatives || {}),
          ...Object.values(item.sizes || {}).map((size: any) => size.filename),
        ])
          if (safeStoredFile(value)) files.push(value);
      await client.query("DELETE FROM posts WHERE author_id=$1", [target]);
      await client.query("DELETE FROM media WHERE author_id=$1", [target]);
    } else {
      await client.query("UPDATE posts SET author_id=$1 WHERE author_id=$2", [
        replacement,
        target,
      ]);
      await client.query("UPDATE media SET author_id=$1 WHERE author_id=$2", [
        replacement,
        target,
      ]);
    }
    await client.query("DELETE FROM users WHERE id=$1", [target]);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
  await Promise.all(
    files.map((filename) =>
      unlink(path.join(uploadsDir, filename)).catch(() => {}),
    ),
  );
  res.json({ ok: true });
});
router.put("/users/:id", admin, async (req: AuthRequest, res) =>
  res.json({ user: await updateUser(req, parseId(req.params.id)) }),
);
router.patch("/users/:id", admin, async (req: AuthRequest, res) =>
  res.json({ user: await updateUser(req, parseId(req.params.id)) }),
);
router.put("/preferences", auth, async (req: AuthRequest, res) => {
  const preferences = z
    .object({
      collapsedMenu: z.boolean().optional(),
      dashboardWidgets: z.array(z.string().max(100)).max(30).optional(),
      hiddenWidgets: z.array(z.string().max(100)).max(30).optional(),
      welcome: z.boolean().optional(),
      postsPerPage: z.number().int().min(1).max(100).optional(),
    })
    .strict()
    .parse(req.body);
  const result = await pool.query(
    "UPDATE users SET preferences=preferences || $1::jsonb WHERE id=$2 RETURNING preferences",
    [JSON.stringify(preferences), needUser(req).id],
  );
  res.json({ preferences: result.rows[0].preferences });
});
router.post(
  "/profile/logout-other-sessions",
  auth,
  async (req: AuthRequest, res) => {
    const token = req.headers.cookie
      ?.split(";")
      .map((s) => s.trim())
      .find((s) => s.startsWith("worldact_session="))
      ?.split("=")[1];
    await pool.query(
      "DELETE FROM sessions WHERE user_id=$1 AND token_hash<>$2",
      [
        needUser(req).id,
        token ? createHash("sha256").update(token).digest("hex") : "",
      ],
    );
    res.json({ ok: true });
  },
);
const resetAttempts = new Map<string, { count: number; expires: number }>();
router.post("/auth/forgot-password", async (req, res) => {
  const key = req.ip || "local",
    now = Date.now(),
    attempt = resetAttempts.get(key);
  if (attempt && attempt.expires > now && attempt.count >= 10)
    throw new HttpError(429, "Please wait before requesting another reset.");
  resetAttempts.set(key, {
    count: attempt && attempt.expires > now ? attempt.count + 1 : 1,
    expires: now + 15 * 60_000,
  });
  const { login } = z
    .object({ login: text(1, 254) })
    .strict()
    .parse(req.body);
  const user = await pool.query(
    "SELECT id,email FROM users WHERE lower(username)=lower($1) OR lower(email)=lower($1)",
    [login],
  );
  const mode = process.env.SMTP_HOST ? "queued" : "local-outbox";
  if (user.rows[0]) {
    const token = randomBytes(32).toString("hex");
    await pool.query(
      "DELETE FROM password_resets WHERE user_id=$1 OR expires_at<now()",
      [user.rows[0].id],
    );
    await pool.query(
      "INSERT INTO password_resets(token_hash,user_id,expires_at) VALUES($1,$2,now()+interval '30 minutes')",
      [createHash("sha256").update(token).digest("hex"), user.rows[0].id],
    );
    const link = `${process.env.APP_ORIGIN || "http://127.0.0.1:5173"}/reset-password?token=${token}`,
      body = `Someone requested a password reset for your WorldAct account.\n\nReset your password within 30 minutes:\n${link}\n\nIgnore this message if you did not request a reset.`;
    const saved = await pool.query(
      "INSERT INTO mail_outbox(recipient,subject,body) VALUES($1,$2,$3) RETURNING id",
      [user.rows[0].email, "Reset your WorldAct password", body],
    );
    if (process.env.SMTP_HOST) {
      const transport = nodemailer.createTransport({
        host: process.env.SMTP_HOST,
        port: Number(process.env.SMTP_PORT || 587),
        secure: process.env.SMTP_SECURE === "true",
        auth: process.env.SMTP_USER
          ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASSWORD }
          : undefined,
      });
      try {
        await transport.sendMail({
          from: process.env.SMTP_FROM || "WorldAct <worldact@localhost>",
          to: user.rows[0].email,
          subject: "Reset your WorldAct password",
          text: body,
        });
        await pool.query("UPDATE mail_outbox SET delivered=true WHERE id=$1", [
          saved.rows[0].id,
        ]);
      } catch {
        console.error(
          "SMTP delivery failed; the message remains in the local mail outbox.",
        );
      }
    }
  }
  res.json({
    ok: true,
    delivery: mode,
    message: process.env.SMTP_HOST
      ? "If the account exists, a password reset request has been recorded."
      : "If the account exists, a reset link is in the local mail outbox. An administrator can read it in Tools → Mail.",
  });
});
router.post("/auth/reset-password", async (req, res) => {
  const input = z
    .object({
      token: z.string().regex(/^[a-f0-9]{64}$/),
      password: z.string().min(12).max(1024),
    })
    .strict()
    .parse(req.body);
  const hash = createHash("sha256").update(input.token).digest("hex"),
    client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await client.query(
      "DELETE FROM password_resets WHERE token_hash=$1 AND expires_at>now() RETURNING user_id",
      [hash],
    );
    if (!result.rowCount)
      throw new HttpError(
        400,
        "This password reset link has expired or has already been used.",
      );
    await client.query("UPDATE users SET password_hash=$1 WHERE id=$2", [
      await hashPassword(input.password),
      result.rows[0].user_id,
    ]);
    await client.query("DELETE FROM sessions WHERE user_id=$1", [
      result.rows[0].user_id,
    ]);
    await client.query("DELETE FROM password_resets WHERE user_id=$1", [
      result.rows[0].user_id,
    ]);
    await client.query("COMMIT");
    res.json({ ok: true });
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
});

const menuSchema = z
  .object({
    name: text(1, 160),
    location: z.enum(["", "primary", "footer"]).default(""),
    items: z
      .array(
        z
          .object({
            id: text(1, 100),
            label: text(1, 200),
            url: safeUrl,
            parentId: z.string().max(100).nullable().optional(),
            target: z.enum(["_self", "_blank"]).optional(),
          })
          .strict(),
      )
      .max(200)
      .default([]),
  })
  .strict();
function validMenu(items: z.infer<typeof menuSchema>["items"]) {
  const ids = new Set(items.map((i) => i.id));
  if (ids.size !== items.length)
    throw new HttpError(400, "Menu item IDs must be unique.");
  for (const item of items) {
    if (item.parentId && !ids.has(item.parentId))
      throw new HttpError(400, "Choose an existing parent menu item.");
    let parent = item.parentId;
    const seen = new Set([item.id]);
    while (parent) {
      if (seen.has(parent))
        throw new HttpError(400, "Menu items cannot form a cycle.");
      seen.add(parent);
      parent = items.find((i) => i.id === parent)?.parentId;
    }
    item.label = normalizedText(item.label);
  }
}
router.get("/menus", editors, async (_req, res) =>
  res.json({
    menus: (
      await pool.query(`SELECT ${menuFields} FROM navigation_menus ORDER BY id`)
    ).rows,
  }),
);
async function saveMenu(input: z.infer<typeof menuSchema>, id?: number) {
  validMenu(input.items);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtext('worldact-menu-locations'))",
    );
    if (
      id &&
      !(await client.query("SELECT id FROM navigation_menus WHERE id=$1", [id]))
        .rowCount
    )
      throw new HttpError(404, "Menu not found.");
    if (input.location)
      await client.query(
        "UPDATE navigation_menus SET location='',updated_at=now() WHERE location=$1 AND id<>$2",
        [input.location, id ?? 0],
      );
    const values = [
      normalizedText(input.name),
      input.location,
      JSON.stringify(input.items),
    ];
    const result = id
      ? await client.query(
          `UPDATE navigation_menus SET name=$1,location=$2,items=$3,updated_at=now() WHERE id=$4 RETURNING ${menuFields}`,
          [...values, id],
        )
      : await client.query(
          `INSERT INTO navigation_menus(name,location,items) VALUES($1,$2,$3) RETURNING ${menuFields}`,
          values,
        );
    await client.query("COMMIT");
    return result.rows[0];
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
router.post("/menus", editors, async (req, res) => {
  res.status(201).json({ menu: await saveMenu(menuSchema.parse(req.body)) });
});
router.put("/menus/:id", editors, async (req, res) => {
  res.json({
    menu: await saveMenu(menuSchema.parse(req.body), parseId(req.params.id)),
  });
});
router.delete("/menus/:id", editors, async (req, res) => {
  const result = await pool.query(
    "DELETE FROM navigation_menus WHERE id=$1 RETURNING id",
    [parseId(req.params.id)],
  );
  if (!result.rowCount) throw new HttpError(404, "Menu not found.");
  res.json({ ok: true });
});
router.get("/site-editor", editors, async (_req, res) =>
  res.json(await readDesign()),
);
router.get("/public/design", async (_req, res) => res.json(await readDesign()));
const styleSchema = z
  .object({
    backgroundColor: z.string().regex(/^#[a-f\d]{3,8}$/i),
    textColor: z.string().regex(/^#[a-f\d]{3,8}$/i),
    accentColor: z.string().regex(/^#[a-f\d]{3,8}$/i),
    fontFamily: z.enum([
      "Manrope",
      "Inter",
      "Georgia",
      "System",
      "serif",
      "sans-serif",
    ]),
    headingFont: z.enum([
      "Manrope",
      "Inter",
      "Georgia",
      "System",
      "serif",
      "sans-serif",
    ]),
    contentWidth: z.number().int().min(480).max(1800),
    spacing: z.number().int().min(8).max(80),
  })
  .partial()
  .strict();
router.put("/site-editor/styles", admin, async (req, res) => {
  const input = styleSchema.parse(req.body);
  const result = await pool.query(
    "UPDATE site_styles SET data=data || $1::jsonb WHERE id=1 RETURNING data",
    [JSON.stringify(input)],
  );
  res.json({ styles: result.rows[0].data });
});
const documentSchema = z
  .object({
    slug: text(1, 160).regex(/^[a-z0-9-]+$/),
    title: text(1, 200),
    type: z.enum(["template", "template-part", "pattern"]),
    content: z.string().max(1_000_000).default(""),
    blocks: z.unknown().optional(),
    version: z.number().int().positive().optional(),
  })
  .strict();
router.post("/site-editor/documents", editors, async (req, res) => {
  const input = documentSchema.parse(req.body);
  const result = await pool.query(
    `INSERT INTO site_documents(slug,title,type,content,blocks) VALUES($1,$2,$3,$4,$5) RETURNING ${docFields}`,
    [
      input.slug,
      normalizedText(input.title),
      input.type,
      cleanContent(input.content),
      JSON.stringify(parseBlocks(input.blocks)),
    ],
  );
  res.status(201).json({ document: result.rows[0] });
});
router.put("/site-editor/documents/:id", editors, async (req, res) => {
  const input = documentSchema.parse(req.body);
  const result = await pool.query(
    `UPDATE site_documents SET slug=$1,title=$2,type=$3,content=$4,blocks=$5,version=version+1,updated_at=now() WHERE id=$6 ${input.version ? "AND version=$7" : ""} RETURNING ${docFields}`,
    [
      input.slug,
      normalizedText(input.title),
      input.type,
      cleanContent(input.content),
      JSON.stringify(parseBlocks(input.blocks)),
      parseId(req.params.id),
      ...(input.version ? [input.version] : []),
    ],
  );
  if (!result.rowCount)
    throw new HttpError(
      input.version ? 409 : 404,
      input.version
        ? "This template changed in another window. Reload before saving."
        : "Template not found.",
    );
  res.json({ document: result.rows[0] });
});
router.delete("/site-editor/documents/:id", editors, async (req, res) => {
  const existing = await pool.query(
    "SELECT slug,type FROM site_documents WHERE id=$1",
    [parseId(req.params.id)],
  );
  if (!existing.rowCount) throw new HttpError(404, "Template not found.");
  if (
    ["header", "footer", "single", "page", "index"].includes(
      existing.rows[0].slug,
    )
  )
    throw new HttpError(
      400,
      "Built-in templates can be edited but cannot be deleted.",
    );
  await pool.query("DELETE FROM site_documents WHERE id=$1", [
    parseId(req.params.id),
  ]);
  res.json({ ok: true });
});
router.get("/themes", admin, async (_req, res) =>
  res.json({ themes, active: (await getSettings()).theme }),
);
router.get("/plugins", admin, async (_req, res) => {
  const installed = await pool.query(
    'SELECT slug,enabled,settings,installed_at AS "installedAt" FROM extensions',
  );
  res.json({
    plugins: pluginRegistry.map((p) => ({
      ...p,
      ...installed.rows.find((r) => r.slug === p.slug),
      installed: installed.rows.some((r) => r.slug === p.slug),
    })),
  });
});
router.post("/plugins/:slug/install", admin, async (req, res) => {
  const plugin = pluginRegistry.find((p) => p.slug === req.params.slug);
  if (!plugin)
    throw new HttpError(
      404,
      "This JavaScript extension is not in the local registry.",
    );
  await pool.query(
    "INSERT INTO extensions(slug,settings) VALUES($1,$2) ON CONFLICT DO NOTHING",
    [plugin.slug, JSON.stringify(plugin.settings)],
  );
  res.status(201).json({ ok: true });
});
router.put("/plugins/:slug", admin, async (req, res) => {
  const plugin = pluginRegistry.find((p) => p.slug === req.params.slug);
  if (!plugin) throw new HttpError(404, "Plugin not found.");
  const input = z
    .object({
      enabled: z.boolean().optional(),
      settings: z.record(z.string(), z.unknown()).optional(),
    })
    .strict()
    .parse(req.body);
  let settings: Record<string, unknown> = {};
  if (input.settings) {
    if (plugin.slug === "reading-time")
      settings = z
        .object({ wordsPerMinute: z.number().int().min(50).max(1000) })
        .strict()
        .parse(input.settings);
    if (plugin.slug === "spam-shield")
      settings = z
        .object({ maxLinks: z.number().int().min(0).max(30) })
        .strict()
        .parse(input.settings);
    if (plugin.slug === "site-seo")
      settings = z
        .object({ description: z.string().max(500), siteImage: safeUrl })
        .strict()
        .parse(input.settings);
    if (plugin.slug === "custom-footer")
      settings = z
        .object({ text: z.string().max(2000) })
        .strict()
        .parse(input.settings);
  }
  const result = await pool.query(
    "UPDATE extensions SET enabled=coalesce($1,enabled),settings=settings || $2::jsonb WHERE slug=$3 RETURNING slug,enabled,settings",
    [input.enabled ?? null, JSON.stringify(settings), plugin.slug],
  );
  if (!result.rowCount)
    throw new HttpError(404, "Install this extension first.");
  res.json({ plugin: result.rows[0] });
});
router.delete("/plugins/:slug", admin, async (req, res) => {
  const existing = await pool.query(
    "SELECT enabled FROM extensions WHERE slug=$1",
    [req.params.slug],
  );
  if (!existing.rowCount) throw new HttpError(404, "Plugin not found.");
  if (existing.rows[0].enabled)
    throw new HttpError(409, "Deactivate the extension before deleting it.");
  await pool.query("DELETE FROM extensions WHERE slug=$1", [req.params.slug]);
  res.json({ ok: true });
});

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 32 * 1024 * 1024, files: 1, fields: 0 },
});
const allowedMimes = new Set([
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
  "image/avif",
  "audio/mpeg",
  "audio/wav",
  "audio/x-wav",
  "audio/ogg",
  "audio/flac",
  "audio/mp4",
  "video/mp4",
  "video/webm",
  "video/quicktime",
  "application/pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
]);
const expandedMediaFields = `${mediaFields},author_id AS "authorId",width,height,sizes,derivatives,original_filename IS NOT NULL AS "canRestore"`;
router.get("/media", creators, async (req: AuthRequest, res) => {
  const user = needUser(req);
  const result = await pool.query(
    `SELECT ${expandedMediaFields} FROM media ${user.role === "author" ? "WHERE author_id=$1" : ""} ORDER BY created_at DESC,id DESC`,
    user.role === "author" ? [user.id] : [],
  );
  res.json({ media: result.rows });
});
router.get("/media/:id", creators, async (req: AuthRequest, res) => {
  const result = await pool.query(
    `SELECT ${expandedMediaFields} FROM media WHERE id=$1`,
    [parseId(req.params.id)],
  );
  if (!result.rowCount) throw new HttpError(404, "Media not found.");
  ownsMedia(req, result.rows[0].authorId);
  res.json({ media: result.rows[0] });
});
router.post(
  "/media",
  creators,
  upload.single("file"),
  async (req: AuthRequest, res) => {
    const file = req.file;
    if (!file?.buffer.length)
      throw new HttpError(400, "Choose a file to upload.");
    const type = await fileTypeFromBuffer(file.buffer).catch(() => undefined);
    if (!type || !allowedMimes.has(type.mime))
      throw new HttpError(
        400,
        "This file type is not permitted. Upload a valid image, audio, video, PDF, or Office document.",
      );
    if (
      file.mimetype === "image/svg+xml" ||
      /\.(php\d?|phtml|html?|svg|js|exe|sh)$/i.test(file.originalname)
    )
      throw new HttpError(400, "Executable files are not permitted.");
    let width: number | null = null,
      height: number | null = null;
    if (type.mime.startsWith("image/")) {
      const metadata = await sharp(file.buffer, {
        limitInputPixels: 80_000_000,
      })
        .metadata()
        .catch(() => null);
      if (!metadata?.width || !metadata?.height)
        throw new HttpError(400, "The image could not be decoded.");
      width = metadata.width;
      height = metadata.height;
    }
    const settings = await getSettings();
    const prefix = uploadPrefix(settings);
    await mkdir(path.join(uploadsDir, prefix), { recursive: true });
    const filename = `${prefix}${randomBytes(20).toString("hex")}.${type.ext}`;
    const sizes = type.mime.startsWith("image/")
      ? await buildSizes(file.buffer, prefix, settings).catch(() => {
          throw new HttpError(400, "The image could not be decoded.");
        })
      : {};
    await writeFile(path.join(uploadsDir, filename), file.buffer, {
      flag: "wx",
    });
    try {
      const result = await pool.query(
        `INSERT INTO media(author_id,title,filename,mime_type,size,width,height,sizes) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING ${expandedMediaFields}`,
        [
          needUser(req).id,
          plainText(
            path.basename(file.originalname).replace(/\.[^.]+$/, ""),
          ).slice(0, 300) || "Untitled file",
          filename,
          type.mime,
          file.size,
          width,
          height,
          JSON.stringify(sizes),
        ],
      );
      res.status(201).json({ media: result.rows[0] });
    } catch (e) {
      await unlink(path.join(uploadsDir, filename)).catch(() => {});
      await Promise.all(
        Object.values(sizes).map((size) =>
          unlink(path.join(uploadsDir, size.filename)).catch(() => {}),
        ),
      );
      throw e;
    }
  },
);
router.post("/media/:id/edit", creators, async (req: AuthRequest, res) => {
  const input = z
    .object({
      rotate: z.number().int().min(-360).max(360).optional(),
      flip: z.boolean().optional(),
      flop: z.boolean().optional(),
      width: z.number().int().min(1).max(8192).optional(),
      height: z.number().int().min(1).max(8192).optional(),
      crop: z
        .object({
          left: z.number().int().min(0),
          top: z.number().int().min(0),
          width: z.number().int().positive().max(8192),
          height: z.number().int().positive().max(8192),
        })
        .optional(),
    })
    .strict()
    .parse(req.body);
  if (!Object.keys(input).length)
    throw new HttpError(400, "Choose an image edit.");
  const selected = await pool.query("SELECT * FROM media WHERE id=$1", [
      parseId(req.params.id),
    ]),
    item = selected.rows[0];
  if (!item) throw new HttpError(404, "Media not found.");
  ownsMedia(req, item.author_id);
  if (!item.mime_type.startsWith("image/"))
    throw new HttpError(400, "Only images can be edited.");
  let pipeline = sharp(path.join(uploadsDir, item.filename), {
    limitInputPixels: 80_000_000,
  });
  if (input.crop) pipeline = pipeline.extract(input.crop);
  if (input.rotate) pipeline = pipeline.rotate(input.rotate);
  if (input.flip) pipeline = pipeline.flip();
  if (input.flop) pipeline = pipeline.flop();
  if (input.width || input.height)
    pipeline = pipeline.resize({
      width: input.width,
      height: input.height,
      fit: "inside",
      withoutEnlargement: true,
    });
  const { data, info } = await pipeline
    .png()
    .toBuffer({ resolveWithObject: true })
    .catch(() => {
      throw new HttpError(
        400,
        "The requested crop or image dimensions are invalid.",
      );
    });
  const prefix =
    path.dirname(item.filename) === "."
      ? ""
      : path.dirname(item.filename) + "/";
  const filename = `${prefix}${randomBytes(20).toString("hex")}.png`;
  const sizes = await buildSizes(data, prefix, await getSettings());
  await writeFile(path.join(uploadsDir, filename), data, { flag: "wx" });
  try {
    const result = await pool.query(
      `UPDATE media SET filename=$1,mime_type='image/png',size=$2,width=$3,height=$4,original_filename=coalesce(original_filename,$5),derivatives=derivatives || $7::jsonb || jsonb_build_object($8::text,$5::text),sizes=$9::jsonb WHERE id=$6 AND filename=$5 RETURNING ${expandedMediaFields}`,
      [
        filename,
        data.length,
        info.width,
        info.height,
        item.filename,
        item.id,
        JSON.stringify(mediaBackups(item)),
        `backup-${randomBytes(8).toString("hex")}`,
        JSON.stringify(sizes),
      ],
    );
    if (!result.rowCount)
      throw new HttpError(
        409,
        "This image changed in another window. Reload before editing.",
      );
    // Keep previous files available: published content and revisions may still
    // reference their URLs. Permanent deletion removes the complete history.
    res.json({ media: result.rows[0] });
  } catch (error) {
    await unlink(path.join(uploadsDir, filename)).catch(() => {});
    await Promise.all(
      Object.values(sizes).map((size) =>
        unlink(path.join(uploadsDir, size.filename)).catch(() => {}),
      ),
    );
    throw error;
  }
});
router.post("/media/:id/restore", creators, async (req: AuthRequest, res) => {
  const selected = await pool.query("SELECT * FROM media WHERE id=$1", [
      parseId(req.params.id),
    ]),
    item = selected.rows[0];
  if (!item) throw new HttpError(404, "Media not found.");
  ownsMedia(req, item.author_id);
  if (!item.original_filename)
    throw new HttpError(400, "This image has no original to restore.");
  const buffer = await readFile(path.join(uploadsDir, item.original_filename)),
    type = await fileTypeFromBuffer(buffer),
    metadata = await sharp(buffer).metadata();
  const prefix =
    path.dirname(item.original_filename) === "."
      ? ""
      : path.dirname(item.original_filename) + "/";
  const sizes = await buildSizes(buffer, prefix, await getSettings());
  try {
    const result = await pool.query(
      `UPDATE media SET filename=original_filename,original_filename=NULL,mime_type=$1,size=$2,width=$3,height=$4,derivatives=derivatives || $7::jsonb || jsonb_build_object($8::text,filename),sizes=$9::jsonb WHERE id=$5 AND filename=$6 RETURNING ${expandedMediaFields}`,
      [
        type?.mime || "image/png",
        buffer.length,
        metadata.width,
        metadata.height,
        item.id,
        item.filename,
        JSON.stringify(mediaBackups(item)),
        `backup-${randomBytes(8).toString("hex")}`,
        JSON.stringify(sizes),
      ],
    );
    if (!result.rowCount)
      throw new HttpError(
        409,
        "This image changed in another window. Reload before restoring.",
      );
    res.json({ media: result.rows[0] });
  } catch (error) {
    await Promise.all(
      Object.values(sizes).map((size) =>
        unlink(path.join(uploadsDir, size.filename)).catch(() => {}),
      ),
    );
    throw error;
  }
});
router.delete("/media/:id", creators, async (req: AuthRequest, res) => {
  const selected = await pool.query("SELECT * FROM media WHERE id=$1", [
      parseId(req.params.id),
    ]),
    item = selected.rows[0];
  if (!item) throw new HttpError(404, "Media not found.");
  ownsMedia(req, item.author_id);
  await pool.query("DELETE FROM media WHERE id=$1", [item.id]);
  for (const filename of [
    item.filename,
    item.original_filename,
    ...Object.values(item.derivatives || {}),
  ])
    if (safeStoredFile(filename))
      await unlink(path.join(uploadsDir, filename)).catch(() => {});
  for (const size of Object.values(item.sizes || {}))
    if (safeStoredFile((size as any).filename))
      await unlink(path.join(uploadsDir, (size as any).filename)).catch(
        () => {},
      );
  res.json({ ok: true });
});

router.get("/tools/health", admin, async (_req, res) => {
  const [database, counts] = await Promise.all([
    pool.query("SELECT version() AS version"),
    pool.query(
      "SELECT (SELECT count(*)::int FROM posts) AS posts,(SELECT count(*)::int FROM media) AS media,(SELECT count(*)::int FROM users) AS users",
    ),
  ]);
  res.json({
    status: "good",
    checks: [
      {
        label: "PostgreSQL connection",
        status: "good",
        detail: database.rows[0].version.split(",")[0],
      },
      { label: "JavaScript runtime", status: "good", detail: process.version },
      {
        label: "Upload storage",
        status: "good",
        detail: "Local filesystem with MIME and content validation",
      },
      {
        label: "Sessions",
        status: "good",
        detail: "HttpOnly cookies with database-backed session revocation",
      },
      {
        label: "Email delivery",
        status: process.env.SMTP_HOST ? "good" : "recommended",
        detail: process.env.SMTP_HOST
          ? "SMTP is configured"
          : "Local mail outbox; configure SMTP for delivery",
      },
    ],
    counts: counts.rows[0],
  });
});
router.get("/tools/mail", admin, async (_req, res) =>
  res.json({
    messages: (
      await pool.query(
        'SELECT id,recipient,subject,body,delivered,created_at AS "createdAt" FROM mail_outbox ORDER BY created_at DESC LIMIT 100',
      )
    ).rows,
  }),
);
router.delete("/tools/mail/:id", admin, async (req, res) => {
  await pool.query("DELETE FROM mail_outbox WHERE id=$1", [
    parseId(req.params.id),
  ]);
  res.json({ ok: true });
});
router.get("/tools/export", admin, async (_req, res) => {
  const [posts, terms, media, comments, menus, docs, styles] =
    await Promise.all(
      [
        "posts",
        "terms",
        "media",
        "comments",
        "navigation_menus",
        "site_documents",
        "site_styles",
      ].map((table) => pool.query(`SELECT * FROM ${table} ORDER BY id`)),
    );
  const postIds = posts.rows.map((p) => p.id),
    relations = await pool.query(
      "SELECT * FROM post_terms WHERE post_id=ANY($1::int[])",
      [postIds],
    );
  res.json({
    application: "WorldAct",
    version: 2,
    exportedAt: new Date().toISOString(),
    posts: posts.rows.map(({ password_hash: password, ...post }) =>
      password ? { ...post, status: "draft", passwordProtected: true } : post,
    ),
    terms: terms.rows,
    postTerms: relations.rows,
    media: media.rows,
    comments: comments.rows,
    menus: menus.rows,
    documents: docs.rows,
    styles: styles.rows[0]?.data || {},
    settings: await getSettings(),
    note: "Media file bytes and password/session data are not included. Password-protected content exports as drafts. Import assigns content to the importing administrator.",
  });
});
router.post("/tools/import", admin, async (req: AuthRequest, res) => {
  const input = z
    .object({
      application: z.literal("WorldAct"),
      version: z.number(),
      posts: z.array(z.record(z.string(), z.unknown())).max(1000),
      terms: z.array(z.record(z.string(), z.unknown())).max(1000).optional(),
      postTerms: z
        .array(z.record(z.string(), z.unknown()))
        .max(10000)
        .optional(),
      comments: z
        .array(z.record(z.string(), z.unknown()))
        .max(10000)
        .optional(),
    })
    .passthrough()
    .parse(req.body);
  for (const records of [
    input.posts,
    input.terms || [],
    input.comments || [],
  ]) {
    const ids = records.map((item) => Number(item.id));
    if (new Set(ids).size !== ids.length)
      throw new HttpError(
        400,
        "The import contains duplicate record identifiers.",
      );
  }
  const client = await pool.connect();
  let imported = 0;
  try {
    await client.query("BEGIN");
    const postMap = new Map<number, number>(),
      termMap = new Map<number, number>(),
      newTerms = new Set<number>();
    for (const item of input.terms || []) {
      const term = z
        .object({
          id: id,
          taxonomy: z.enum(["category", "tag"]),
          name: text(1, 200),
          slug: text(1, 220),
          description: z.string().max(5000).default(""),
        })
        .parse(item);
      let r = await client.query(
        "INSERT INTO terms(taxonomy,name,slug,description) VALUES($1,$2,$3,$4) ON CONFLICT(taxonomy,slug) DO NOTHING RETURNING id",
        [
          term.taxonomy,
          normalizedText(term.name),
          term.slug,
          plainText(term.description),
        ],
      );
      if (r.rowCount) newTerms.add(r.rows[0].id);
      else
        r = await client.query(
          "SELECT id FROM terms WHERE taxonomy=$1 AND slug=$2",
          [term.taxonomy, term.slug],
        );
      termMap.set(term.id, r.rows[0].id);
    }
    for (const item of input.terms || []) {
      if (!item.parent_id) continue;
      const term = termMap.get(Number(item.id)),
        parent = termMap.get(Number(item.parent_id));
      if (
        !term ||
        !parent ||
        item.taxonomy !== "category" ||
        !newTerms.has(term)
      )
        continue;
      const ancestors = new Set<number>([term]);
      let cursor: number | undefined = parent;
      while (cursor) {
        if (ancestors.size > 100)
          throw new HttpError(
            400,
            "Category hierarchies cannot exceed 100 levels.",
          );
        if (ancestors.has(cursor))
          throw new HttpError(
            400,
            "The import contains a category hierarchy cycle.",
          );
        ancestors.add(cursor);
        const row: {
          rows: { parent_id: number | null }[];
          rowCount: number | null;
        } = await client.query(
          "SELECT parent_id FROM terms WHERE id=$1 AND taxonomy='category'",
          [cursor],
        );
        if (!row.rowCount)
          throw new HttpError(
            400,
            "A category parent must also be a category.",
          );
        cursor = row.rows[0].parent_id ?? undefined;
      }
      await client.query(
        "UPDATE terms SET parent_id=$1 WHERE id=$2 AND NOT is_default",
        [parent, term],
      );
    }
    for (const item of input.posts) {
      const post = z
        .object({
          id: id,
          type: z.enum(["post", "page"]),
          title: z.string().max(300),
          slug: text(1, 220),
          content: z.string().max(1_000_000),
          raw_content: z.string().max(1_000_000).optional(),
          excerpt: z.string().max(20000).default(""),
          status: z
            .enum(["publish", "draft", "pending", "future", "private", "trash"])
            .default("draft"),
          blocks: z.unknown().optional(),
          scheduled_at: z.string().nullable().optional(),
          created_at: z.iso.datetime({ offset: true }).optional(),
          updated_at: z.iso.datetime({ offset: true }).optional(),
          published_at: z.iso.datetime({ offset: true }).nullable().optional(),
          passwordProtected: z.boolean().optional(),
          parent_id: nullableId.optional(),
          menu_order: z.number().int().min(-10000).max(10000).optional(),
          sticky: z.boolean().optional(),
          comment_status: z.enum(["open", "closed"]).optional(),
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
            .default("standard"),
        })
        .parse(item);
      let slug = post.slug;
      if (
        (await client.query("SELECT id FROM posts WHERE slug=$1", [slug]))
          .rowCount
      )
        slug = `${post.slug.slice(0, 160)}-import-${randomBytes(4).toString("hex")}`;
      const status =
        post.status === "future" || post.passwordProtected
          ? "draft"
          : post.status;
      const r = await client.query(
        "INSERT INTO posts(type,title,slug,content,excerpt,status,author_id,blocks,raw_content,menu_order,sticky,comment_status,created_at,updated_at,published_at,format) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,COALESCE($13::timestamptz,now()),COALESCE($14::timestamptz,now()),CASE WHEN $6::varchar='publish' THEN COALESCE($15::timestamptz,$13::timestamptz,now()) ELSE $15::timestamptz END,$16) RETURNING id",
        [
          post.type,
          plainText(post.title),
          slug,
          cleanContent(post.content),
          plainText(post.excerpt),
          status,
          needUser(req).id,
          JSON.stringify(parseBlocks(post.blocks) ?? []),
          cleanRawContent(post.raw_content || post.content),
          post.menu_order ?? 0,
          post.sticky ?? false,
          post.comment_status ?? "open",
          post.created_at ?? null,
          post.updated_at ?? null,
          post.published_at ?? null,
          post.type === "page" ? "standard" : post.format,
        ],
      );
      postMap.set(post.id, r.rows[0].id);
      imported++;
    }
    for (const item of input.posts) {
      const child = postMap.get(Number(item.id)),
        parent = postMap.get(Number(item.parent_id));
      if (child && parent && item.type === "page") {
        const ancestors = new Set<number>([child]);
        let cursor: number | undefined = parent;
        while (cursor) {
          if (ancestors.size > 100)
            throw new HttpError(
              400,
              "Page hierarchies cannot exceed 100 levels.",
            );
          if (ancestors.has(cursor))
            throw new HttpError(
              400,
              "The import contains a page hierarchy cycle.",
            );
          ancestors.add(cursor);
          const row: {
            rows: { parent_id: number | null }[];
            rowCount: number | null;
          } = await client.query(
            "SELECT parent_id FROM posts WHERE id=$1 AND type='page'",
            [cursor],
          );
          if (!row.rowCount)
            throw new HttpError(400, "A page parent must also be a page.");
          cursor = row.rows[0].parent_id ?? undefined;
        }
        await client.query("UPDATE posts SET parent_id=$1 WHERE id=$2", [
          parent,
          child,
        ]);
      }
    }
    for (const rel of input.postTerms || []) {
      const p = postMap.get(Number(rel.post_id)),
        term = termMap.get(Number(rel.term_id));
      if (p && term)
        await client.query(
          "INSERT INTO post_terms(post_id,term_id) VALUES($1,$2) ON CONFLICT DO NOTHING",
          [p, term],
        );
    }
    const commentMap = new Map<number, number>();
    for (const item of input.comments || []) {
      const comment = z
        .object({
          id,
          post_id: id,
          author_name: text(1, 160),
          author_email: z.union([z.email().max(254), z.literal("")]),
          content: text(1, 20000),
          status: z
            .enum(["approved", "pending", "spam", "trash"])
            .default("pending"),
          parent_id: nullableId.optional(),
        })
        .parse(item);
      const post = postMap.get(comment.post_id);
      if (!post) continue;
      const result = await client.query(
        "INSERT INTO comments(post_id,author_name,author_email,content,status) VALUES($1,$2,$3,$4,$5) RETURNING id",
        [
          post,
          normalizedText(comment.author_name),
          comment.author_email,
          cleanContent(comment.content),
          comment.status,
        ],
      );
      commentMap.set(comment.id, result.rows[0].id);
    }
    for (const item of input.comments || []) {
      const child = commentMap.get(Number(item.id)),
        parent = commentMap.get(Number(item.parent_id));
      if (!child || !parent) continue;
      const ancestors = new Set<number>([child]);
      let cursor: number | undefined = parent;
      while (cursor) {
        if (ancestors.size > 100)
          throw new HttpError(
            400,
            "Comment hierarchies cannot exceed 100 levels.",
          );
        if (ancestors.has(cursor))
          throw new HttpError(
            400,
            "The import contains a comment hierarchy cycle.",
          );
        ancestors.add(cursor);
        const row: { rows: { parent_id: number | null; post_id: number }[] } =
          await client.query(
            "SELECT parent_id,post_id FROM comments WHERE id=$1",
            [cursor],
          );
        if (row.rows[0].post_id !== postMap.get(Number(item.post_id)))
          throw new HttpError(
            400,
            "Comment replies must belong to the same post.",
          );
        cursor = row.rows[0].parent_id ?? undefined;
      }
      await client.query("UPDATE comments SET parent_id=$1 WHERE id=$2", [
        parent,
        child,
      ]);
    }
    await client.query(
      "INSERT INTO post_terms(post_id,term_id) SELECT p.id,t.id FROM posts p CROSS JOIN terms t WHERE p.id=ANY($1::int[]) AND p.type='post' AND t.taxonomy='category' AND t.is_default=true AND NOT EXISTS(SELECT 1 FROM post_terms pt JOIN terms x ON x.id=pt.term_id WHERE pt.post_id=p.id AND x.taxonomy='category') ON CONFLICT DO NOTHING",
      [[...postMap.values()]],
    );
    await client.query("COMMIT");
    res
      .status(201)
      .json({
        ok: true,
        imported,
        postIds: [...postMap.values()],
        termIds: [...newTerms],
      });
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
});
router.post("/tools/privacy/export", auth, async (req: AuthRequest, res) => {
  const user = needUser(req);
  const comments = await pool.query(
    "SELECT author_name,content,status,created_at FROM comments WHERE lower(author_email)=lower($1)",
    [user.email],
  );
  res.json({
    user,
    comments: comments.rows,
    exportedAt: new Date().toISOString(),
  });
});

export default router;
