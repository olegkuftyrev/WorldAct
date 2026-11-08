import {akismetKey,readAkismetSecretStatus,setAkismetCredentials} from "./bundled-plugins.js";
import { validateFontChoices, withFontLibraryLock } from "./fonts.js";
import express from "express";
import multer from "multer";
import sharp from "sharp";
import { fileTypeFromBuffer } from "file-type";
import { z } from "zod";
import { postFormats } from "../shared/post-formats.js";
import { createHash, randomBytes } from "node:crypto";
import type { PoolClient } from "pg";
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
  slugify,
} from "./utils.js";
import { readDesign, pluginRegistry, themes, publicExtensionSettings } from "./design.js";
import {
  buildSizes,
  uploadPrefix,
  safeStoredFile,
  mediaBackups,
} from "./media-files.js";
import { remapImportedBlockReferences } from "./block-portability.js";
import { SiteImport, allocateImportedBlockEntities, exportMediaFiles, exportFontLibrary, MAX_ARCHIVE_JSON_BYTES, MAX_STORED_CONTENT_BYTES } from "./site-portability.js";
import { postPermalink } from "./permalinks.js";
import { dateArchiveLocalSQL } from "./date-archives.js";
import { parseFootnotes, freshFootnoteIds } from "./footnotes.js";

import { settingSchema, menuSchema, validMenu, styleSchema, documentSchema, validateExtensionSettings } from "./site-validation.js";
import { readThemeDesign, validateThemeDesign, resetBundledDocument } from "./themes.js";
import {pendingAdminEmail,queueAdminEmailChange} from "./site-identity.js";
import {deliverMail,queueMail} from "./accounts.js";

const router = express.Router();
const admin = requireRole("administrator");
// Default WordPress roles reserve theme options, templates and menus for admins.
const editors = requireRole("administrator");
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
  'id,slug,title,type,theme,area,source_hash AS "sourceHash",source_metadata AS "sourceMetadata",content,raw_content AS "rawContent",blocks,version,updated_at AS "updatedAt"';
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
async function clearDeletedSiteImages(client: PoolClient, ids: number[]) {
  if (!ids.length) return;
  await client.query(
    `UPDATE settings SET data=data
      || CASE WHEN data->>'siteLogoId'=ANY($1::text[]) THEN '{"siteLogoId":0}'::jsonb ELSE '{}'::jsonb END
      || CASE WHEN data->>'siteIconId'=ANY($1::text[]) THEN '{"siteIconId":0}'::jsonb ELSE '{}'::jsonb END
      WHERE id=1 AND (data->>'siteLogoId'=ANY($1::text[]) OR data->>'siteIconId'=ANY($1::text[]))`,
    [ids.map(String)],
  );
}

// General, Writing, Reading, Discussion, Media, Permalinks and Privacy settings.
router.get("/settings", admin, async (_req, res) =>
  res.json({ settings: await getSettings(),pendingAdminEmail:await pendingAdminEmail() }),
);
router.put("/settings", admin, async (req:AuthRequest, res) => {
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
  for (const key of ["siteLogoId", "siteIconId"] as const)
    if (input[key]) {
      const image = await pool.query(
        "SELECT id FROM media WHERE id=$1 AND mime_type LIKE 'image/%'",
        [input[key]],
      );
      if (!image.rowCount)
        throw new HttpError(400, "Choose an existing image.");
    }
  const db=await pool.connect();let mail=null;
  try{
    await db.query("BEGIN");await db.query("SELECT id FROM settings WHERE id=1 FOR UPDATE");
    if(input.defaultCategoryId){
      const term=await db.query("SELECT id FROM terms WHERE id=$1 AND taxonomy='category' FOR KEY SHARE",[input.defaultCategoryId]);
      if(!term.rowCount)throw new HttpError(400,"Choose an existing category.");
    }
    if(input.adminEmail){
      const current=await getSettings(db);
      input.adminEmail=input.adminEmail.toLowerCase();
      if(input.adminEmail!==current.adminEmail.toLowerCase()){mail=await queueAdminEmailChange(db,input.adminEmail,needUser(req).id);delete input.adminEmail;}
    }
    await db.query("UPDATE settings SET data=data || $1::jsonb WHERE id=1",[JSON.stringify(input)]);await db.query("COMMIT");
  }catch(error){await db.query("ROLLBACK");throw error;}finally{db.release();}
  res.json({settings:await getSettings(),pendingAdminEmail:await pendingAdminEmail(),delivery:await deliverMail(mail)});
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
export async function updateUser(req: AuthRequest, target: number) {
  const user = needUser(req),
    input = profileSchema.parse(req.body);
  if (target !== user.id && user.role !== "administrator")
    throw new HttpError(403, "You cannot edit this user.");
  const client=await pool.connect();
  try {
  await client.query("BEGIN");
  await client.query("SELECT pg_advisory_xact_lock(hashtext('worldact-account-identity'))");
  const existing = await client.query("SELECT * FROM users WHERE id=$1 FOR UPDATE", [
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
  if(input.email && input.email.toLowerCase()!==row.email.toLowerCase() && (await client.query("SELECT id FROM users WHERE id<>$1 AND (lower(email)=lower($2) OR lower(username)=lower($2))",[target,input.email])).rowCount)throw new HttpError(409,"That email address is already registered.");
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
  await client.query(
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
    await client.query(
      "DELETE FROM sessions WHERE user_id=$1 AND token_hash<>$2",
      [target, token ? createHash("sha256").update(token).digest("hex") : ""],
    );
  }
  const result = await client.query(
    `SELECT ${userFields},profile FROM users WHERE id=$1`,
    [target],
  );
  await client.query("COMMIT");
  return { ...result.rows[0], ...result.rows[0].profile };
  } catch(error){await client.query("ROLLBACK");throw error;}finally{client.release();}
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
export async function deleteUser(req: AuthRequest, target: number, options: {reassignTo?: number; deleteContent?: "true" | "false"} = {}) {
  const user = needUser(req),
    replacement = options.reassignTo ?? user.id;
  if (target === user.id)
    throw new HttpError(
      400,
      "You cannot delete the account you are signed in with.",
    );
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
        "SELECT id,filename,original_filename,derivatives,sizes FROM media WHERE author_id=$1 ORDER BY id FOR UPDATE",
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
      await clearDeletedSiteImages(client, media.rows.map(item => item.id));
      await client.query("DELETE FROM block_entities WHERE author_id=$1", [
        target,
      ]);
    } else {
      await client.query("UPDATE posts SET author_id=$1 WHERE author_id=$2", [
        replacement,
        target,
      ]);
      await client.query("UPDATE media SET author_id=$1 WHERE author_id=$2", [
        replacement,
        target,
      ]);
      await client.query(
        "UPDATE block_entities SET author_id=$1 WHERE author_id=$2",
        [replacement, target],
      );
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
}
router.delete("/users/:id", admin, async (req: AuthRequest, res) => {
  const options = z.object({reassignTo:z.coerce.number().int().positive().optional(),deleteContent:z.enum(["true","false"]).optional()}).parse(req.query);
  await deleteUser(req, parseId(req.params.id), options);
  res.json({ok:true});
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
      listTables: z.partialRecord(
        z.enum(["posts", "pages", "comments", "categories", "tags", "users", "media"]),
        z.object({
          hiddenColumns: z.array(z.string().min(1).max(60)).max(30).optional(),
          perPage: z.number().int().min(1).max(100).optional(),
          viewMode: z.enum(["list", "excerpt"]).optional(),
        }).strict(),
      ).optional(),
    })
    .strict()
    .parse(req.body);
  const result = await pool.query(
    `UPDATE users SET preferences=(preferences || ($1::jsonb-'listTables'))
      || CASE WHEN $1::jsonb ? 'listTables' THEN jsonb_build_object('listTables',
        coalesce(preferences->'listTables','{}'::jsonb) || coalesce((
          SELECT jsonb_object_agg(entry.key,
            coalesce(preferences->'listTables'->entry.key,'{}'::jsonb) || entry.value)
          FROM jsonb_each($1::jsonb->'listTables') entry
        ),'{}'::jsonb)) ELSE '{}'::jsonb END
      WHERE id=$2 RETURNING preferences`,
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
  const mode = process.env.SMTP_HOST && process.env.NODE_ENV !== "test" && process.env.WORLDACT_MAIL_MODE !== "outbox" ? "queued" : "local-outbox";
  if (user.rows[0]) {
    const token = randomBytes(32).toString("hex");
    const link = `${process.env.APP_ORIGIN || "http://127.0.0.1:5173"}/reset-password?token=${token}`,
      body = `Someone requested a password reset for your WorldAct account.\n\nReset your password within 30 minutes:\n${link}\n\nIgnore this message if you did not request a reset.`;
    // Global expiry cleanup holds no user lock. Token replacement and its
    // outbox message then share the user-first order used by login/reset.
    await pool.query("DELETE FROM password_resets WHERE expires_at<now()");
    const client=await pool.connect();
    let mail: Awaited<ReturnType<typeof queueMail>> | null=null;
    try {
      await client.query("BEGIN");
      const current=(await client.query("SELECT id,email FROM users WHERE id=$1 FOR UPDATE",[user.rows[0].id])).rows[0];
      if(current){
        await client.query("DELETE FROM password_resets WHERE user_id=$1",[current.id]);
        await client.query("INSERT INTO password_resets(token_hash,user_id,expires_at) VALUES($1,$2,now()+interval '30 minutes')",[createHash("sha256").update(token).digest("hex"),current.id]);
        mail=await queueMail(client,current.email,"Reset your WorldAct password",body);
      }
      await client.query("COMMIT");
    }catch(error){await client.query("ROLLBACK");throw error;}
    finally{client.release();}
    await deliverMail(mail);
  }
  res.json({
    ok: true,
    delivery: mode,
    message: mode === "queued"
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
  const hash = createHash("sha256").update(input.token).digest("hex");
  const candidate = (await pool.query("SELECT user_id FROM password_resets WHERE token_hash=$1 AND expires_at>now()", [hash])).rows[0];
  if (!candidate) throw new HttpError(400, "This password reset link has expired or has already been used.");
  const passwordHash = await hashPassword(input.password),
    client = await pool.connect();
  try {
    await client.query("BEGIN");
    // Match login, profile and account deletion: lock the user before any
    // reset/session rows, then consume the still-valid token under that lock.
    if (!(await client.query("SELECT id FROM users WHERE id=$1 FOR UPDATE", [candidate.user_id])).rowCount)
      throw new HttpError(400, "This password reset link has expired or has already been used.");
    const result = await client.query(
      "DELETE FROM password_resets WHERE token_hash=$1 AND user_id=$2 AND expires_at>now() RETURNING user_id",
      [hash, candidate.user_id],
    );
    if (!result.rowCount)
      throw new HttpError(
        400,
        "This password reset link has expired or has already been used.",
      );
    await client.query("UPDATE users SET password_hash=$1 WHERE id=$2", [
      passwordHash,
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
router.put("/site-editor/styles", admin, async (req, res) => {
  const input=styleSchema.parse(req.body);
  const result=await withFontLibraryLock(async(database)=>{
    const settings=await getSettings(database);
    await validateFontChoices(input,settings.theme,database);
    if(settings.theme!=="classic"){
      const result=await database.query("UPDATE theme_designs SET styles=styles || $2::jsonb,updated_at=now() WHERE theme=$1 RETURNING styles",[settings.theme,JSON.stringify(input)]);
      return {styles:result.rows[0]?.styles || {},theme:await readThemeDesign(settings.theme,database)};
    }
    const result=await database.query("UPDATE site_styles SET data=data || $1::jsonb WHERE id=1 RETURNING data",[JSON.stringify(input)]);
    return {styles:result.rows[0].data};
  });
  res.json(result);
});
router.put("/site-editor/theme", admin, async (req, res) => {
  const result=await withFontLibraryLock(async(database)=>{
    const settings=await getSettings(database),previous=await readThemeDesign(settings.theme,database);
    const input=validateThemeDesign(settings.theme,{...req.body,variation:req.body?.variation ?? previous.variation,styles:req.body?.styles ?? previous.styles});
    await validateFontChoices(input.styles,settings.theme,database);
    await database.query("UPDATE theme_designs SET variation=$2,styles=$3::jsonb,updated_at=now() WHERE theme=$1",[settings.theme,input.variation,JSON.stringify(input.styles)]);
    if(settings.theme==="classic")await database.query("UPDATE site_styles SET data=$1::jsonb WHERE id=1",[JSON.stringify(input.styles)]);
    return {theme:await readThemeDesign(settings.theme,database)};
  });
  res.json(result);
});
router.post("/site-editor/documents/:id/reset", editors, async (req, res) => {
  res.json({ document: await resetBundledDocument(parseId(req.params.id)) });
});
router.post("/site-editor/documents", editors, async (req, res) => {
  const input = documentSchema.parse(req.body);
  const settings = await getSettings();
  const result = await pool.query(
    `INSERT INTO site_documents(slug,title,type,content,blocks,raw_content,theme,area) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING ${docFields}`,
    [
      input.slug,
      normalizedText(input.title),
      input.type,
      cleanContent(input.content),
      JSON.stringify(parseBlocks(input.blocks)),
      cleanRawContent(input.content),
      settings.theme,
      input.type === "template-part" ? input.area ?? "uncategorized" : "uncategorized",
    ],
  );
  res.status(201).json({ document: result.rows[0] });
});
router.put("/site-editor/documents/:id", editors, async (req, res) => {
  const input = documentSchema.parse(req.body);
  const result = await pool.query(
    `UPDATE site_documents SET slug=$1,title=$2,type=$3,content=$4,blocks=$5,raw_content=$6,area=CASE WHEN $3::varchar='template-part' THEN COALESCE($8,area) ELSE 'uncategorized' END,source_hash=CASE WHEN slug<>$1::varchar OR type<>$3::varchar THEN NULL ELSE source_hash END,source_content=CASE WHEN slug<>$1::varchar OR type<>$3::varchar THEN NULL ELSE source_content END,source_metadata=CASE WHEN slug<>$1::varchar OR type<>$3::varchar THEN '{}'::jsonb ELSE source_metadata END,version=version+1,updated_at=now() WHERE id=$7 ${input.version ? "AND version=$9" : ""} RETURNING ${docFields}`,
    [
      input.slug,
      normalizedText(input.title),
      input.type,
      cleanContent(input.content),
      JSON.stringify(parseBlocks(input.blocks)),
      cleanRawContent(input.content),
      parseId(req.params.id),
      input.area ?? null,
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
    "SELECT slug,type,source_hash FROM site_documents WHERE id=$1",
    [parseId(req.params.id)],
  );
  if (!existing.rowCount) throw new HttpError(404, "Template not found.");
  if (
    existing.rows[0].source_hash || ["header", "footer", "single", "page", "index"].includes(
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
router.get("/plugins",admin,async(_req,res)=>{
  const installed=await pool.query('SELECT slug,enabled,settings,installed_at AS "installedAt" FROM extensions');
  const secret=await readAkismetSecretStatus();
  res.json({plugins:pluginRegistry.map((plugin)=>{const row=installed.rows.find((item)=>item.slug===plugin.slug);return {...plugin,...row,settings:publicExtensionSettings(plugin.slug,row?.settings || plugin.settings),installed:Boolean(row),...(plugin.slug==="akismet"?secret:{})};})});
});
router.post("/plugins/:slug/install",admin,async(req,res)=>{
  const plugin=pluginRegistry.find((item)=>item.slug===req.params.slug);if(!plugin)throw new HttpError(404,"This extension is not in the local registry.");
  await pool.query("INSERT INTO extensions(slug,settings) VALUES($1,$2) ON CONFLICT DO NOTHING",[plugin.slug,JSON.stringify(plugin.settings)]);res.status(201).json({ok:true});
});
router.put("/plugins/:slug",admin,async(req,res)=>{
  const plugin=pluginRegistry.find((item)=>item.slug===req.params.slug);if(!plugin)throw new HttpError(404,"Plugin not found.");
  const input=z.object({enabled:z.boolean().optional(),settings:z.record(z.string(),z.unknown()).optional(),apiKey:akismetKey.optional(),clearApiKey:z.boolean().optional()}).strict().parse(req.body);
  if(plugin.slug!=="akismet" && (input.apiKey!==undefined || input.clearApiKey!==undefined))throw new HttpError(400,"API key fields are only available for Akismet.");
  const settings=input.settings?validateExtensionSettings(plugin.slug,input.settings):{};
  const database=await pool.connect();let updated;
  try{await database.query("BEGIN");
    const row=(await database.query("SELECT slug,enabled,settings FROM extensions WHERE slug=$1 FOR UPDATE",[plugin.slug])).rows[0];if(!row)throw new HttpError(404,"Install this extension first.");
    updated=(await database.query("UPDATE extensions SET enabled=coalesce($1,enabled),settings=$2::jsonb WHERE slug=$3 RETURNING slug,enabled,settings",[input.enabled ?? null,JSON.stringify({...publicExtensionSettings(plugin.slug,row.settings),...settings}),plugin.slug])).rows[0];
    if(plugin.slug==="akismet")await setAkismetCredentials(database,input);
    await database.query("COMMIT");
  }catch(reason){await database.query("ROLLBACK");throw reason;}finally{database.release();}
  res.json({plugin:{...updated,settings:publicExtensionSettings(plugin.slug,updated.settings),...(plugin.slug==="akismet"?await readAkismetSecretStatus():{})}});
});
router.delete("/plugins/:slug",admin,async(req,res)=>{
  const database=await pool.connect();
  try{await database.query("BEGIN");const row=(await database.query("SELECT enabled FROM extensions WHERE slug=$1 FOR UPDATE",[req.params.slug])).rows[0];if(!row)throw new HttpError(404,"Plugin not found.");if(row.enabled)throw new HttpError(409,"Deactivate the extension before deleting it.");
    if(req.params.slug==="akismet")await database.query("DELETE FROM akismet_comment_checks");
    await database.query("DELETE FROM extensions WHERE slug=$1",[req.params.slug]);await database.query("COMMIT");
  }catch(reason){await database.query("ROLLBACK");throw reason;}finally{database.release();}res.json({ok:true});
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
const expandedMediaFields = `${mediaFields},author_id AS "authorId",(SELECT display_name FROM users WHERE users.id=media.author_id) AS "authorName",attached_post_id AS "attachedPostId",(SELECT title FROM posts WHERE posts.id=media.attached_post_id) AS "attachedPostTitle",description,comment_status AS "commentStatus",width,height,sizes,derivatives,original_filename IS NOT NULL AS "canRestore"`;
router.get("/media", creators, async (req: AuthRequest, res) => {
  const user = needUser(req),input=z.object({search:z.string().trim().max(200).default(""),type:z.enum(["all","image","audio","video","document"]).default("all"),month:z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/).optional(),unattached:z.enum(["true","false"]).default("false"),page:z.coerce.number().int().positive().max(1_000_000).default(1),perPage:z.coerce.number().int().min(1).max(1000).default(1000),orderby:z.enum(["title","author","date"]).default("date"),order:z.enum(["asc","desc"]).default("desc")}).strict().parse(req.query);
  const values:unknown[]=[],where:string[]=[];
  if(user.role==="author"){values.push(user.id);where.push("author_id=$1");}
  const base=where.length?"WHERE "+where.join(" AND "):"";
  const timezone=(await getSettings()).timezone,monthValues=[...values],monthLocal=dateArchiveLocalSQL("created_at",monthValues,timezone);
  const [counts,months]=await Promise.all([pool.query(`SELECT count(*)::int AS all,count(*) FILTER(WHERE mime_type LIKE 'image/%')::int AS image,count(*) FILTER(WHERE mime_type LIKE 'audio/%')::int AS audio,count(*) FILTER(WHERE mime_type LIKE 'video/%')::int AS video,count(*) FILTER(WHERE mime_type !~ '^(image|audio|video)/')::int AS document,count(*) FILTER(WHERE attached_post_id IS NULL)::int AS unattached FROM media ${base}`,values),pool.query(`SELECT DISTINCT to_char(${monthLocal},'YYYY-MM') AS month FROM media ${base} ORDER BY month DESC`,monthValues)]);
  if(input.search){values.push("%"+input.search.replace(/[\\%_]/g,"\\$&")+"%");where.push(`(title ILIKE $${values.length} OR filename ILIKE $${values.length} OR caption ILIKE $${values.length})`);}
  if(input.type!=="all"){if(input.type==="document")where.push("mime_type !~ '^(image|audio|video)/'");else{values.push(input.type+"/%");where.push(`mime_type LIKE $${values.length}`);}}
  if(input.month){values.push(input.month);const monthParameter=values.length,local=dateArchiveLocalSQL("created_at",values,timezone);where.push(`to_char(${local},'YYYY-MM')=$${monthParameter}`);}
  if(input.unattached==="true")where.push("attached_post_id IS NULL");
  const predicate=where.length?"WHERE "+where.join(" AND "):"";
  const total=(await pool.query(`SELECT count(*)::int AS n FROM media ${predicate}`,values)).rows[0].n,totalPages=Math.max(1,Math.ceil(total/input.perPage)),page=Math.min(input.page,totalPages);
  values.push(input.perPage,(page-1)*input.perPage);
  const sort={title:"lower(title)",author:'"authorName"',date:"created_at"}[input.orderby];
  const result=await pool.query(`SELECT ${expandedMediaFields} FROM media ${predicate} ORDER BY ${sort} ${input.order},id ${input.order} LIMIT $${values.length-1} OFFSET $${values.length}`,values);
  res.json({media:result.rows,counts:counts.rows[0],months:months.rows.map(row=>row.month),pagination:{page,perPage:input.perPage,total,totalPages}});
});
const mediaUpdate=z.object({title:z.string().trim().min(1).max(300).optional(),alt:z.string().max(1000).optional(),caption:z.string().max(20_000).optional(),description:z.string().max(20_000).optional(),commentStatus:z.enum(["open","closed"]).optional(),attachedPostId:z.number().int().positive().max(2147483647).nullable().optional()}).strict().refine(value=>Object.keys(value).length>0,"Provide a field to update.");
async function updateMedia(req:AuthRequest,id:number,body:unknown){
  const input=mediaUpdate.parse(body),client=await pool.connect();
  try{
    await client.query("BEGIN");const existing=(await client.query("SELECT * FROM media WHERE id=$1 FOR UPDATE",[id])).rows[0];
    if(!existing)throw new HttpError(404,"Media not found.");ownsMedia(req,existing.author_id);
    if(input.attachedPostId){
      const post=(await client.query("SELECT id,author_id,type FROM posts WHERE id=$1 AND status<>'trash' FOR KEY SHARE",[input.attachedPostId])).rows[0];
      if(!post)throw new HttpError(400,"Choose an existing post or page.");
      if(needUser(req).role==="author" && (post.author_id!==needUser(req).id || post.type!=="post"))throw new HttpError(403,"You can only attach files to your own posts.");
    }
    const title=normalizedText(input.title ?? existing.title);
    const result=await client.query(`UPDATE media SET title=$1,alt=$2,caption=$3,description=$4,comment_status=$5,attached_post_id=$6 WHERE id=$7 RETURNING ${expandedMediaFields}`,[title,plainText(input.alt ?? existing.alt),plainText(input.caption ?? existing.caption),cleanContent(input.description ?? existing.description),input.commentStatus ?? existing.comment_status,input.attachedPostId===undefined?existing.attached_post_id:input.attachedPostId,id]);
    await client.query("COMMIT");return result.rows[0];
  }catch(error){await client.query("ROLLBACK");throw error;}finally{client.release();}
}
router.put("/media/:id",creators,async(req:AuthRequest,res)=>res.json({media:await updateMedia(req,parseId(req.params.id),req.body)}));
router.post("/media/bulk",creators,async(req:AuthRequest,res)=>{
  const input=z.object({ids:z.array(z.number().int().positive().max(2147483647)).min(1).max(100),action:z.enum(["delete","attach","detach"]),postId:z.number().int().positive().max(2147483647).optional()}).strict().parse(req.body);
  if(input.action==="attach"&&!input.postId)throw new HttpError(400,"Choose a post or page to attach these files to.");
  let updated=0;const errors:{id:number;message:string}[]=[];
  for(const id of new Set(input.ids))try{if(input.action==="delete")await deleteMedia(req,id);else await updateMedia(req,id,{attachedPostId:input.action==="detach"?null:input.postId});updated++;}catch(error){if(!(error instanceof HttpError))throw error;errors.push({id,message:error.message});}
  res.json({updated,errors});
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
async function deleteMedia(req: AuthRequest,id:number) {
  const client = await pool.connect();
  let item: any;
  try {
    await client.query("BEGIN");
    item = (
      await client.query("SELECT * FROM media WHERE id=$1 FOR UPDATE", [
        id,
      ])
    ).rows[0];
    if (!item) throw new HttpError(404, "Media not found.");
    ownsMedia(req, item.author_id);
    await client.query("DELETE FROM media WHERE id=$1", [item.id]);
    await clearDeletedSiteImages(client, [item.id]);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
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
}
router.delete("/media/:id", creators, async (req: AuthRequest, res) => {
  await deleteMedia(req,parseId(req.params.id));res.json({ok:true});
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
  const [posts, terms, media, comments, menus, docs, styles, blockEntities, extensions] = await Promise.all(
    ["posts", "terms", "media", "comments", "navigation_menus", "site_documents", "site_styles", "block_entities", "extensions"].map(table => pool.query(`SELECT * FROM ${table} ORDER BY ${table === "extensions" ? "slug" : "id"}`)),
  );
  for (const records of [posts, terms, media, menus, docs, blockEntities]) if (records.rows.length > 1000) throw new HttpError(413, "Export at most 1000 records per section in a site archive.");
  if (comments.rows.length > 10000) throw new HttpError(413, "Export at most 10000 comments per archive.");
  const relations = await pool.query("SELECT * FROM post_terms ORDER BY post_id,term_id");
  const settings = await getSettings(), { adminEmail: _contact, ...publicSettings } = settings;
  const embedded = await exportMediaFiles(media.rows);
  const fonts = await exportFontLibrary(pool, embedded.files.reduce((total, file) => total + file.size, 0));
  const themeDesigns = (await pool.query("SELECT to_regclass('theme_designs') present")).rows[0].present
    ? (await pool.query("SELECT theme,variation,styles FROM theme_designs ORDER BY theme")).rows : [];
  const archive = {
    application: "WorldAct", version: 3, exportedAt: new Date().toISOString(),
    posts: await Promise.all(posts.rows.map(async ({password_hash: password, ...post}) => ({...post, permalink: await postPermalink({...post, terms: terms.rows.filter(term => relations.rows.some(rel => rel.post_id === post.id && rel.term_id === term.id))}, settings), ...(password ? {status: "draft", passwordProtected: true} : {})}))),
    terms: terms.rows, postTerms: relations.rows, media: media.rows, mediaFiles: embedded.files,
    comments: comments.rows, blockEntities: blockEntities.rows, menus: menus.rows, documents: docs.rows,
    styles: styles.rows[0]?.data || {}, themeDesigns, extensions: extensions.rows.map(extension => ({ ...extension, settings: publicExtensionSettings(extension.slug, extension.settings) })), settings: publicSettings,
    fontFamilies: fonts.fontFamilies, fontFaces: fonts.fontFaces, themeFonts: fonts.themeFonts, fontFiles: fonts.fontFiles,
    warnings: [...embedded.warnings, ...fonts.warnings],
    note: "Local media and font bytes are embedded with SHA-256 checksums; font activation follows the explicit design replacement choice. Passwords, sessions and account credentials are excluded. Imported content belongs to the importing administrator. Existing content is retained; explicitly choose replaceDesign to activate imported site design and settings. Destination site URL and administrator contact remain unchanged.",
  };
  if (Buffer.byteLength(JSON.stringify(archive)) > MAX_ARCHIVE_JSON_BYTES) throw new HttpError(413, "The complete archive exceeds 96 MiB. Export a smaller site archive.");
  res.json(archive);
});
router.post("/tools/import", admin, async (req: AuthRequest, res) => {
  const input = z
    .object({
      application: z.literal("WorldAct"),
      version: z.number().int().min(1).max(3),
      replaceDesign: z.boolean().optional(),
      media: z.array(z.record(z.string(), z.unknown())).max(1000).optional(),
      mediaFiles: z.array(z.record(z.string(), z.unknown())).max(5000).optional(),
      fontFamilies: z.array(z.record(z.string(), z.unknown())).max(200).optional(),
      fontFaces: z.array(z.record(z.string(), z.unknown())).max(800).optional(),
      themeFonts: z.array(z.record(z.string(), z.unknown())).max(800).optional(),
      fontFiles: z.array(z.record(z.string(), z.unknown())).max(800).optional(),
      documents: z.array(z.record(z.string(), z.unknown())).max(1000).optional(),
      menus: z.array(z.record(z.string(), z.unknown())).max(1000).optional(),
      themeDesigns: z.array(z.record(z.string(), z.unknown())).max(4).optional(),
      extensions: z.array(z.record(z.string(), z.unknown())).max(1000).optional(),
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
      blockEntities: z.array(z.record(z.string(), z.unknown())).max(1000).optional(),
    })
    .passthrough()
    .parse(req.body);
  for (const records of [
    input.posts,
    input.terms || [],
    input.comments || [],
    input.blockEntities || [],
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
  let site: SiteImport | undefined;
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtext('worldact-site-import'))");
    site = new SiteImport(client, input, needUser(req), await getSettings(client));
    await site.prepare();
    const postMap = new Map<number, number>(),
      termMap = new Map<number, number>(),
      newTerms = new Set<number>(),
      warnings = new Set<string>();
    let suppressedWarnings = 0;
    const addWarnings = (items: string[]) => {
      for (const warning of items)
        if (warnings.has(warning)) continue;
        else if (warnings.size < 99) warnings.add(warning);
        else suppressedWarnings++;
    };
    const blockGraph = await allocateImportedBlockEntities(client, input.blockEntities || [], needUser(req).id);
    const blockEntityMap = blockGraph.map;
    for (const item of input.terms || []) {
      const term = z
        .object({
          id: id,
          taxonomy: z.enum(["category", "tag"]),
          name: text(1, 200),
          slug: text(1, 220),
          description: z.string().max(5000).default(""),
          parent_id: nullableId.optional(),
        })
        .parse(item);
      let slug = slugify(term.slug);
      if ((await client.query("SELECT id FROM terms WHERE taxonomy=$1 AND slug=$2", [term.taxonomy, slug])).rowCount) {
        slug = `${slug.slice(0,160)}-import-${randomBytes(6).toString("hex")}`;
        site.warn("Conflicting taxonomy terms were imported with unique slugs; existing taxonomy content was retained.");
      }
      const r = await client.query("INSERT INTO terms(taxonomy,name,slug,description) VALUES($1,$2,$3,$4) RETURNING id", [term.taxonomy, normalizedText(term.name), slug, plainText(term.description)]);
      newTerms.add(r.rows[0].id);
      termMap.set(term.id, r.rows[0].id);
    }
    for (const item of input.terms || []) {
      if (!item.parent_id) continue;
      const term = termMap.get(Number(item.id)),
        parent = termMap.get(Number(item.parent_id));
      if (!term || !parent || item.taxonomy !== "category" || !newTerms.has(term)) { site.warn(`Term ${item.id} had an unresolved parent and was imported at the top level.`); continue; }
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
          content: z.string().max(MAX_STORED_CONTENT_BYTES),
          raw_content: z.string().max(MAX_STORED_CONTENT_BYTES).optional(),
          excerpt: z.string().max(20000).default(""),
          status: z
            .enum(["publish", "draft", "pending", "future", "private", "trash"])
            .default("draft"),
          blocks: z.unknown().optional(),
          footnotes: z.unknown().transform(parseFootnotes).optional(),
          scheduled_at: z.iso.datetime({ offset: true }).nullable().optional(),
          featured_media_id: nullableId.optional(),
          created_at: z.iso.datetime({ offset: true }).optional(),
          updated_at: z.iso.datetime({ offset: true }).optional(),
          published_at: z.iso.datetime({ offset: true }).nullable().optional(),
          passwordProtected: z.boolean().optional(),
          parent_id: nullableId.optional(),
          menu_order: z.number().int().min(-10000).max(10000).optional(),
          sticky: z.boolean().optional(),
          comment_status: z.enum(["open", "closed"]).optional(),
          ping_status: z.enum(["open", "closed"]).optional(),
          template_slug: z.string().max(160).regex(/^[a-zA-Z0-9_-]*$/).default(""),
          pre_trash_status: z.enum(["publish", "future", "private", "draft", "pending"]).nullable().optional(),
          format: z.enum(postFormats).default("standard"),
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
      const rewritten = remapImportedBlockReferences(
        post.raw_content || post.content, post.blocks, blockEntityMap, site.options,
      );
      addWarnings(rewritten.warnings);
      const r = await client.query(
        "INSERT INTO posts(type,title,slug,content,excerpt,status,author_id,blocks,raw_content,menu_order,sticky,comment_status,created_at,updated_at,published_at,format,featured_media_id,scheduled_at,ping_status,template_slug,pre_trash_status) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,COALESCE($13::timestamptz,now()),COALESCE($14::timestamptz,now()),CASE WHEN $6::varchar='publish' THEN COALESCE($15::timestamptz,$13::timestamptz,now()) ELSE $15::timestamptz END,$16,$17,$18,$19,$20,$21) RETURNING id",
        [
          post.type,
          plainText(post.title),
          slug,
          rewritten.content,
          plainText(post.excerpt),
          status,
          needUser(req).id,
          JSON.stringify(rewritten.blocks),
          rewritten.rawContent,
          post.menu_order ?? 0,
          post.sticky ?? false,
          post.comment_status ?? "open",
          post.created_at ?? null,
          post.updated_at ?? null,
          post.published_at ?? null,
          post.type === "page" ? "standard" : post.format,
          post.featured_media_id ? site.media.get(post.featured_media_id) || null : null,
          post.scheduled_at ?? null,
          post.ping_status ?? "closed",
          site.mapPostTemplate(post.template_slug),
          post.status === "trash" ? post.pre_trash_status ?? null : null,
        ],
      );
      await client.query("UPDATE posts SET footnotes=$1::jsonb WHERE id=$2", [JSON.stringify(post.footnotes ?? []), r.rows[0].id]);
      if (post.featured_media_id && !site.media.has(post.featured_media_id)) site.warn(`Featured media ${post.featured_media_id} was missing and detached from imported post ${post.id}.`);
      if (post.status === "future") site.warn("Scheduled content was imported as a draft for review; its scheduled date was retained.");
      if (post.passwordProtected) site.warn("Password-protected content was imported as a draft. Set a new password before publishing it.");
      postMap.set(post.id, r.rows[0].id);
      imported++;
    }
    for (const item of input.posts) {
      const child = postMap.get(Number(item.id)),
        parent = postMap.get(Number(item.parent_id));
      if (item.parent_id && (!child || !parent)) site.warn(`Page ${item.id} had a missing parent and was imported at the top level.`);
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
    for (const item of input.postTerms || []) {
      const rel = z.object({post_id:id,term_id:id}).parse(item);
      const post = postMap.get(rel.post_id), term = termMap.get(rel.term_id);
      if (post && term) await client.query("INSERT INTO post_terms(post_id,term_id) VALUES($1,$2) ON CONFLICT DO NOTHING", [post,term]);
      else site.warn(`A taxonomy relationship for post ${rel.post_id} and term ${rel.term_id} could not be restored.`);
    }
    const commentMap = new Map<number, number>();
    for (const item of input.comments || []) {
      const comment = z
        .object({
          id,
          post_id: id,
          author_name: text(1, 160),
          author_email: z.union([z.email().max(254), z.literal("")]),
          author_url: z
            .union([
              z.literal(""),
              z
                .url()
                .max(2000)
                .refine((value) => /^https?:\/\//i.test(value)),
            ])
            .default(""),
          content: text(1, 20000),
          status: z
            .enum(["approved", "pending", "spam", "trash"])
            .default("pending"),
          parent_id: nullableId.optional(),
          created_at: z.iso.datetime({ offset: true }).optional(),
        })
        .parse(item);
      const post = postMap.get(comment.post_id);
      if (!post) { site.warn(`Comment ${comment.id} referred to a missing post and was not imported.`); continue; }
      const result = await client.query(
        "INSERT INTO comments(post_id,author_name,author_email,content,status,author_url,created_at) VALUES($1,$2,$3,$4,$5,$6,coalesce($7::timestamptz,now())) RETURNING id",
        [
          post,
          normalizedText(comment.author_name),
          comment.author_email,
          cleanContent(comment.content),
          comment.status,
          comment.author_url,
          comment.created_at ?? null,
        ],
      );
      commentMap.set(comment.id, result.rows[0].id);
    }
    for (const item of input.comments || []) {
      const child = commentMap.get(Number(item.id)),
        parent = commentMap.get(Number(item.parent_id));
      if (!child || !parent) { if (item.parent_id) site.warn(`Comment ${item.id} had an unresolved parent and was imported without it.`); continue; }
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
    const references = await site.finalize(postMap, termMap, blockEntityMap);
    addWarnings(await blockGraph.finalize(references));
    for (const item of input.posts) {
      const post = postMap.get(Number(item.id));
      if (!post) continue;
      const rawContent = String(item.raw_content || item.content), notes = parseFootnotes(item.footnotes ?? []);
      const footnotes = freshFootnoteIds(notes, rawContent), footnoteSelfURLs = new Set<string>();
      const sourceURL = typeof item.permalink === "string" ? item.permalink : "", targetURL = references.urls?.get(sourceURL);
      if (targetURL) for (const [source, target] of references.urls || []) {
        let samePost = target === targetURL;
        if (!samePost && /^https?:\/\//i.test(target)) { try { samePost = new URL(target).pathname === targetURL; } catch {} }
        if (samePost) { footnoteSelfURLs.add(source); footnoteSelfURLs.add(target); }
      }
      const options = { ...references, footnotes, footnoteSelfURLs };
      const rewritten = remapImportedBlockReferences(rawContent, item.blocks, blockEntityMap, options);
      addWarnings(rewritten.warnings);
      const copiedNotes = notes.map(note => ({ id: footnotes.get(note.id)!, content: remapImportedBlockReferences(note.content, [], blockEntityMap, options).content }));
      await client.query("UPDATE posts SET content=$1,raw_content=$2,blocks=$3::jsonb,footnotes=$4::jsonb WHERE id=$5", [rewritten.content, rewritten.rawContent, JSON.stringify(rewritten.blocks), JSON.stringify(copiedNotes), post]);
    }
    const defaultCategory = (await getSettings(client)).defaultCategoryId;
    await client.query("INSERT INTO post_terms(post_id,term_id) SELECT p.id,t.id FROM posts p JOIN terms t ON t.id=COALESCE($2::int,(SELECT id FROM terms WHERE is_default LIMIT 1)) WHERE p.id=ANY($1::int[]) AND p.type='post' AND NOT EXISTS(SELECT 1 FROM post_terms pt JOIN terms x ON x.id=pt.term_id WHERE pt.post_id=p.id AND x.taxonomy='category') ON CONFLICT DO NOTHING", [[...postMap.values()], defaultCategory]);
    addWarnings(site.importWarnings);
    await client.query("COMMIT");
    res.status(201).json({
      ok: true,
      imported,
      postIds: [...postMap.values()],
      termIds: [...newTerms],
      blockEntityIds: [...blockEntityMap.values()].map(entity => entity.id),
      fontFamilyIds: [...site.fontFamilies.values()], fontFaceIds: site.fontFaceIds,
      mediaIds: [...site.media.values()], documentIds: site.documentIds, menuIds: site.menuIds,
      restoredDesign: input.replaceDesign === true,
      ...(warnings.size ? { warnings: [...warnings, ...(suppressedWarnings ? [`${suppressedWarnings} additional import warnings were omitted; review missing data and references before publishing.`] : [])] } : {}),
    });
  } catch (e) {
    await client.query("ROLLBACK");
    await site?.rollbackFiles();
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
