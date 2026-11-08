import path from "node:path";
import { open, mkdir } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { pool, uploadsDir, getSettings } from "./db.js";
import { assertActiveAccountAuthentication, type AuthRequest } from "./auth.js";
import { needUser, HttpError, plainText, cleanContent } from "./utils.js";
import { safeStoredFile, uploadPrefix, unlinkUnreferencedMediaFiles } from "./media-files.js";
import { stageImageUpload } from "./image-uploads.js";
import { applyMediaModifiers, mediaEditCopySchema, mediaEditModifiers } from "./media-edit-transforms.js";

/** Compare known local paths only. The request URL is never opened or fetched. */
export function matchesEditableMediaSource(src: string, item: {
  filename: unknown; derivatives?: Record<string, unknown>; sizes?: Record<string, unknown>;
}, siteUrl: string): boolean {
  try {
    if (/[\\\u0000-\u0020\u007f]/.test(src) || src.startsWith("//")) return false;
    const base = new URL(siteUrl), url = new URL(src, base);
    if (!["http:", "https:"].includes(url.protocol) || url.origin !== base.origin || url.username || url.password) return false;
    const known = [item.filename, item.derivatives?.["original-upload"], ...Object.values(item.sizes || {}).map(value =>
      value && typeof value === "object" && !Array.isArray(value) ? (value as { filename?: unknown }).filename : undefined,
    )].filter(safeStoredFile);
    return known.some(filename => url.pathname === new URL("/uploads/" + filename, base).pathname);
  } catch { return false; }
}

async function readEditableImage(filename: unknown) {
  if (!safeStoredFile(filename)) throw new HttpError(404, "The source image file is unavailable.");
  let handle;
  try {
    handle = await open(path.join(uploadsDir, filename), "r");
    const info = await handle.stat();
    if (!info.isFile() || !info.size || info.size > 32 * 1024 * 1024) throw new HttpError(400, "The source image cannot be edited safely.");
    return await handle.readFile();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new HttpError(404, "The source image file is unavailable.");
    throw error;
  } finally { await handle?.close(); }
}

/** Gutenberg edits duplicate an attachment; existing blocks and Undo retain it. */
export async function editMediaCopy(req: AuthRequest, sourceId: number, body: unknown, mediaFields: string) {
  const input = mediaEditCopySchema.parse(body), modifiers = mediaEditModifiers(input);
  const settings = await getSettings(), actorId = needUser(req).id;
  const database = await pool.connect(), owned = new Set<string>();
  let released = false;
  try {
    await database.query("BEGIN");
    // Match the account -> post -> media order used by account deletion. Keep
    // credentials/role stable while waiting for the source file or image work.
    const actor = (await database.query("SELECT id,role FROM users WHERE id=$1 FOR SHARE", [actorId])).rows[0];
    if (!actor) throw new HttpError(401, "Your account is unavailable. Sign in again.");
    await assertActiveAccountAuthentication(req, database);
    if (!["administrator", "editor", "author"].includes(actor.role)) throw new HttpError(403, "You are not allowed to edit images.");
    if (input.post) {
      const post = (await database.query("SELECT id,author_id,type FROM posts WHERE id=$1 AND status<>'trash' FOR KEY SHARE", [input.post])).rows[0];
      if (!post) throw new HttpError(400, "Choose an existing post or page.");
      if (actor.role === "author" && (post.author_id !== actorId || post.type !== "post")) throw new HttpError(403, "You can only attach files to your own posts.");
    }
    const item = (await database.query("SELECT * FROM media WHERE id=$1 FOR SHARE", [sourceId])).rows[0];
    if (!item) throw new HttpError(404, "Media not found.");
    if (actor.role === "author" && item.author_id !== actorId) throw new HttpError(403, "You can only edit your own media.");
    if (!String(item.mime_type).startsWith("image/")) throw new HttpError(400, "Only images can be edited.");
    if (!matchesEditableMediaSource(input.src, item, settings.siteUrl)) throw new HttpError(404, "This image URL does not belong to the attachment.");
    // Source metadata chooses its raw upload for quality. A missing local file
    // is an error; never fall back to a request-controlled network address.
    const original = Object.hasOwn(item.derivatives || {}, "original-upload") ? item.derivatives["original-upload"] : item.filename;
    const edited = await applyMediaModifiers(await readEditableImage(original), modifiers);
    const prefix = uploadPrefix(settings);
    await mkdir(path.join(uploadsDir, prefix), { recursive: true });
    const rawFilename = `${prefix}${randomBytes(20).toString("hex")}.${edited.output.extension}`;
    const staged = await stageImageUpload(edited.data, rawFilename, prefix, settings, owned);
    const title = plainText(input.title ?? item.title).trim();
    if (!title) throw new HttpError(400, "Enter meaningful text for the image title.");
    const result = await database.query(
      `INSERT INTO media(author_id,title,filename,mime_type,size,width,height,sizes,derivatives,alt,caption,description,attached_post_id,comment_status)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb,$10,$11,$12,$13,$14) RETURNING ${mediaFields}`,
      [actorId, title, staged.filename, staged.mimeType, staged.size, staged.width, staged.height,
        JSON.stringify(staged.sizes), JSON.stringify(staged.derivatives), plainText(input.alt_text ?? item.alt),
        plainText(input.caption ?? item.caption), cleanContent(input.description ?? item.description), input.post || null, input.comment_status ?? "closed"],
    );
    await database.query("COMMIT");
    return result.rows[0];
  } catch (error) {
    await database.query("ROLLBACK").catch(() => {});
    database.release(); released = true;
    // COMMIT can succeed even if its acknowledgement fails. Query all live
    // references before removing owned files, as ordinary upload already does.
    await unlinkUnreferencedMediaFiles(owned);
    throw error;
  } finally { if (!released) database.release(); }
}
