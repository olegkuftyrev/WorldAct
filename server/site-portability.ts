import { createHash, randomBytes } from "node:crypto";
import { readFile, writeFile, mkdir, unlink, rmdir, stat } from "node:fs/promises";
import path from "node:path";
import { fileTypeFromBuffer } from "file-type";
import sharp from "sharp";
import { z } from "zod";
import type { PoolClient } from "pg";
import { uploadsDir, rootDir, type User, getSettings, getPost } from "./db.js";
import { cleanContent, plainText, slugify, HttpError } from "./utils.js";
import { safeStoredFile } from "./media-files.js";
import { remapImportedBlockReferences, type ImportedBlockEntity, type BlockReferenceOptions } from "./block-portability.js";
import { settingSchema, styleSchema, menuSchema, validMenu, documentSchema, normalizedText, validateExtensionSettings } from "./site-validation.js";
import { postPermalink } from "./permalinks.js";
import { validateThemeDesign } from "./themes.js";
import { inspectFont, bundledFontCollection, validateFontChoices } from "./fonts.js";

export const MAX_ARCHIVE_FILE_BYTES = 32 * 1024 * 1024;
export const MAX_ARCHIVE_MEDIA_BYTES = 64 * 1024 * 1024;
export const MAX_ARCHIVE_JSON_BYTES = 96 * 1024 * 1024;
// Sanitization can expand a valid 1 MiB editor input (for example '&' to '&amp;').
export const MAX_STORED_CONTENT_BYTES = 8_000_000;
const id = z.number().int().positive().max(2147483647);
const filename = z.string().min(1).max(500).refine(value => safeStoredFile(value) && !value.split("/").includes(".."), "Use a safe upload-relative filename.");
const themes = z.enum(["twentytwentyfive", "twentytwentyfour", "twentytwentythree", "classic"]);
const supportedMimes = new Set(["image/jpeg","image/png","image/gif","image/webp","image/avif","audio/mpeg","audio/wav","audio/x-wav","audio/ogg","audio/flac","audio/mp4","video/mp4","video/webm","video/quicktime","application/pdf","application/vnd.openxmlformats-officedocument.wordprocessingml.document","application/vnd.openxmlformats-officedocument.spreadsheetml.sheet","application/vnd.openxmlformats-officedocument.presentationml.presentation"]);
const entitySchema = z.object({
  id, kind: z.enum(["reusable", "navigation"]), title: z.string().max(200), slug: z.string().max(220).optional(),
  content: z.string().max(MAX_STORED_CONTENT_BYTES), raw_content: z.string().max(MAX_STORED_CONTENT_BYTES).optional(), blocks: z.unknown().optional(),
  status: z.enum(["publish", "draft", "trash"]).default("publish"),
  created_at: z.iso.datetime({ offset: true }).optional(), updated_at: z.iso.datetime({ offset: true }).optional(),
});
export async function allocateImportedBlockEntities(client: PoolClient, records: unknown[], authorId: number) {
  const parsed = z.array(entitySchema).max(1000).parse(records);
  if (new Set(parsed.map(item => item.id)).size !== parsed.length) throw new HttpError(400, "Imported block entity IDs must be unique.");
  const map = new Map<number, ImportedBlockEntity>();
  for (const entity of parsed) {
    const result = await client.query("INSERT INTO block_entities(kind,title,slug,status,author_id,created_at,updated_at) VALUES($1,$2,$3,$4,$5,coalesce($6::timestamptz,now()),coalesce($7::timestamptz,now())) RETURNING id", [entity.kind, plainText(entity.title), `${slugify(entity.slug || entity.title).slice(0,160)}-import-${randomBytes(8).toString("hex")}`, entity.status, authorId, entity.created_at ?? null, entity.updated_at ?? null]);
    map.set(entity.id, { id: result.rows[0].id, kind: entity.kind });
  }
  return { map, ids: [...map.values()].map(item => item.id), async finalize(options: BlockReferenceOptions = {}) {
    const warnings = new Set<string>();
    for (const entity of parsed) {
      const value = remapImportedBlockReferences(entity.raw_content || entity.content, entity.blocks, map, options);
      for (const warning of value.warnings) if (warnings.size < 100) warnings.add(warning);
      await client.query("UPDATE block_entities SET content=$1,raw_content=$2,blocks=$3::jsonb WHERE id=$4", [value.content, value.rawContent, JSON.stringify(value.blocks), map.get(entity.id)!.id]);
    }
    return [...warnings];
  }};
}

export async function exportMediaFiles(media: any[]) {
  const warnings: string[] = [], files: any[] = [];
  let omittedWarnings = 0;
  const warn = (message: string) => { if (warnings.length < 99) warnings.push(message); else omittedWarnings++; };
  const names = new Set<string>();
  for (const item of media) for (const value of [item.filename, item.original_filename, ...Object.values(item.derivatives || {}), ...Object.values(item.sizes || {}).map((size: any) => size.filename)]) {
    if (value == null) continue;
    if (!safeStoredFile(value)) throw new HttpError(400, "The media library contains an invalid stored filename.");
    names.add(value);
  }
  if (names.size > 5000) throw new HttpError(413, "Export at most 5000 uploaded file versions per archive.");
  let bytes = 0;
  for (const name of names) {
    let data: Buffer;
    try { const info = await stat(path.join(uploadsDir, name)); if (info.size > MAX_ARCHIVE_FILE_BYTES || bytes + info.size > MAX_ARCHIVE_MEDIA_BYTES) throw new HttpError(413, "Uploaded files exceed the archive size limit."); data = await readFile(path.join(uploadsDir, name)); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; warn(`Uploaded file ${name} is missing from disk and is not embedded in the archive.`); continue; }
    bytes += data.length;
    if (data.length > MAX_ARCHIVE_FILE_BYTES || bytes > MAX_ARCHIVE_MEDIA_BYTES) throw new HttpError(413, "The archive exceeds 32 MiB per file or 64 MiB of uploaded files. Export a smaller media library.");
    const type = await fileTypeFromBuffer(data);
    if (!type || !supportedMimes.has(type.mime)) { warn(`Uploaded file ${name} has an unsupported signature and is not embedded.`); continue; }
    files.push({ filename: name, mimeType: type.mime, size: data.length, sha256: createHash("sha256").update(data).digest("hex"), data: data.toString("base64") });
  }
  if (omittedWarnings) warnings.push(`${omittedWarnings} additional missing or unsupported uploaded files were not embedded.`);
  return { files, warnings };
}

const MAX_ARCHIVE_FONT_BYTES = 8 * 1024 * 1024;
const storedFont = z.string().regex(/^fonts\/[a-f0-9]{48}\.(?:woff2?|ttf|otf)$/);
const archivedFont = z.string().regex(/^fonts\/(?:[a-f0-9]{48}|[a-f0-9]{64})\.(?:woff2?|ttf|otf)$/);
const fontName = z.string().trim().min(1).max(120).regex(/^[\p{L}\p{N}][\p{L}\p{N} ._'()-]*$/u);
const fontFormat = z.enum(["truetype", "opentype", "woff", "woff2"]);
const fontExtension = (format: z.infer<typeof fontFormat>) => ({ truetype: "ttf", opentype: "otf", woff: "woff", woff2: "woff2" })[format];
const fontMIME = (format: string) => ({ truetype: "font/ttf", opentype: "font/otf", woff: "font/woff", woff2: "font/woff2" } as Record<string, string>)[format];

/** Archive font bytes remain separate from the ordinary Media Library MIME policy. */
export async function exportFontLibrary(database: Pick<PoolClient, "query">, mediaBytes = 0) {
  const empty = { fontFamilies: [] as any[], fontFaces: [] as any[], themeFonts: [] as any[], fontFiles: [] as any[], warnings: [] as string[] };
  if (!(await database.query("SELECT to_regclass('font_families') present")).rows[0].present) return empty;
  const families = (await database.query("SELECT * FROM font_families ORDER BY id")).rows;
  const faces = (await database.query("SELECT * FROM font_faces ORDER BY id")).rows;
  const themeFonts = (await database.query("SELECT theme,family_id FROM theme_fonts ORDER BY theme,family_id")).rows;
  if (families.length > 200 || faces.length > 800 || themeFonts.length > 800) throw new HttpError(413, "Export at most 200 font families and 800 font faces or theme selections.");
  const result = { ...empty, fontFamilies: families, fontFaces: [] as any[], themeFonts };
  let bytes = mediaBytes, omitted = 0;
  const warned = (value: string) => { if (result.warnings.length < 99) result.warnings.push(value); else omitted++; };
  const included = new Set<string>();
  for (const face of faces) {
    const format = fontFormat.parse(face.format), extension = fontExtension(format);
    const family = families.find(item => item.id === face.family_id);
    const source = face.filename ? storedFont.parse(face.filename) : null;
    const collection = family?.source === "bundled" ? bundledFontCollection.find(item => item.key === family.collection_key) : undefined;
    const bundled = !source ? collection?.faces.find(item => item.url === face.url) : undefined;
    if (!source && !bundled) { warned(`Font face ${face.id} has no known local file and could not be embedded.`); result.fontFaces.push(face); continue; }
    const archiveFile = source || `fonts/${face.sha256}.${extension}`;
    result.fontFaces.push({ ...face, archiveFile });
    if (included.has(archiveFile)) continue;
    let data: Buffer;
    try { const sourcePath = source ? path.join(uploadsDir, source) : path.join(rootDir, "public", bundled!.url); const info = await stat(sourcePath); if (info.size > MAX_ARCHIVE_FONT_BYTES || bytes + info.size > MAX_ARCHIVE_MEDIA_BYTES) throw new HttpError(413, "Export at most 8 MiB per font and 64 MiB of media plus fonts."); data = await readFile(sourcePath); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; warned(`Font face ${face.id} is missing from disk and was not embedded.`); continue; }
    bytes += data.length;
    if (data.length > MAX_ARCHIVE_FONT_BYTES || bytes > MAX_ARCHIVE_MEDIA_BYTES) throw new HttpError(413, "The archive exceeds its combined media and font size limit.");
    const hash = createHash("sha256").update(data).digest("hex");
    if (hash !== face.sha256) { warned(`Font face ${face.id} failed its stored checksum and was not embedded.`); continue; }
    included.add(archiveFile); result.fontFiles.push({ filename: archiveFile, mimeType: fontMIME(format), format, size: data.length, sha256: hash, data: data.toString("base64") });
  }
  if (omitted) result.warnings.push(`${omitted} additional unavailable font files were not embedded.`);
  return result;
}

export class SiteImport {
  readonly media = new Map<number, number>();
  readonly fontFamilies = new Map<number, number>();
  readonly fontFaceIds: number[] = [];
  private fontNames = new Map<string, string | null>();
  private fontSlugs = new Map<string, string | null>();
  private decodedBytes = 0;
  private importedThemeFonts: Array<{ theme: string; family_id: number }> = [];
  private hasFontArchive = false;
  readonly documents = new Map<string, string>();
  readonly urls = new Map<string, string>();
  readonly documentIds: number[] = [];
  readonly menuIds: number[] = [];
  readonly createdFiles = new Set<string>();
  readonly warnings = new Set<string>();
  private suppressedWarnings = 0;
  readonly settings: ReturnType<typeof settingSchema.parse>;
  readonly styles: ReturnType<typeof styleSchema.parse>;
  private docs: any[] = [];
  private menus: any[] = [];
  private sourceTheme: string;
  private destination: Awaited<ReturnType<typeof getSettings>>;
  private themedDocuments = false;
  private themeDesigns: ReturnType<typeof validateThemeDesign>[] = [];
  private extensions: Array<{ slug: string; enabled: boolean; settings: unknown }> = [];
  constructor(private client: PoolClient, readonly input: Record<string, any>, private user: User, destination: Awaited<ReturnType<typeof getSettings>>) {
    this.destination = destination;
    this.settings = settingSchema.parse(input.settings || {});
    this.styles = styleSchema.parse(input.styles || {});
    this.sourceTheme = this.settings.theme || destination.theme;
    const themeDesigns = z.array(z.record(z.string(), z.unknown())).max(4).parse(input.themeDesigns || []);
    if (new Set(themeDesigns.map(item => item.theme)).size !== themeDesigns.length) throw new HttpError(400, "Theme designs must have unique themes.");
    this.themeDesigns = themeDesigns.map(item => validateThemeDesign(String(item.theme), item));
    const extensions = z.array(z.object({ slug: z.string().max(100), enabled: z.boolean(), settings: z.unknown() })).max(6).parse(input.extensions || []);
    if (new Set(extensions.map(item => item.slug)).size !== extensions.length) throw new HttpError(400, "Extension records must be unique.");
    this.extensions = extensions.map(item => {
      let settings = item.settings;
      if (item.slug === "akismet" && settings && typeof settings === "object" && !Array.isArray(settings)) {
        const source = settings as Record<string, unknown>;
        if (Object.keys(source).some(key => key !== "sendComments")) this.warn("Akismet credentials and verification fields were discarded from the archive; destination credentials were retained.");
        settings = Object.hasOwn(source, "sendComments") ? { sendComments: source.sendComments } : {};
      }
      return { ...item, settings: validateExtensionSettings(item.slug, settings) };
    });
    for (const warning of z.array(z.string().max(2000)).max(1000).parse(input.warnings || [])) this.warn(warning);
  }
  warn(message: string) { if (this.warnings.has(message)) return; if (this.warnings.size < 99) this.warnings.add(message); else this.suppressedWarnings++; }
  get importWarnings() { return [...this.warnings, ...(this.suppressedWarnings ? [`${this.suppressedWarnings} additional import warnings were omitted; some missing references or files could not be restored.`] : [])]; }
  get options(): BlockReferenceOptions { return { media: this.media, documents: this.documents, documentTheme: this.sourceTheme, urls: this.urls, fontFamilies: this.fontNames, fontSlugs: this.fontSlugs }; }
  mapPostTemplate(slug: string) {
    if (!slug) return "";
    const mapped = this.documents.get(`${this.sourceTheme}:template:${slug}`);
    if (mapped) return mapped;
    this.warn(`Template ${slug} was missing from the imported design; content uses the default template.`);
    return "";
  }
  async prepare() {
    await this.restoreMedia();
    await this.restoreFonts();
    this.themedDocuments = !!(await this.client.query("SELECT 1 FROM information_schema.columns WHERE table_schema=current_schema() AND table_name='site_documents' AND column_name='theme'")).rowCount;
    const docs = z.array(z.record(z.string(), z.unknown())).max(1000).parse(this.input.documents || []);
    const keys = new Set<string>();
    for (const item of docs) {
      const doc = documentSchema.extend({ content: z.string().max(MAX_STORED_CONTENT_BYTES) }).parse({ slug: item.slug, title: item.title, type: item.type, content: item.content, blocks: item.blocks });
      const theme = themes.parse(item.theme || this.sourceTheme);
      const key = `${theme}:${doc.type}:${doc.slug}`;
      if (keys.has(key)) throw new HttpError(400, "Imported design document keys must be unique.");
      keys.add(key);
      const raw = z.string().max(MAX_STORED_CONTENT_BYTES).optional().parse(item.raw_content);
      let slug = doc.slug;
      const existing = await this.client.query(`SELECT id FROM site_documents WHERE type=$1 AND slug=$2${this.themedDocuments ? " AND theme=$3" : ""} FOR UPDATE`, this.themedDocuments ? [doc.type, slug, theme] : [doc.type, slug]);
      let documentId: number;
      if (existing.rowCount && this.input.replaceDesign === true) documentId = existing.rows[0].id;
      else {
        if (existing.rowCount) { slug = `${slug.slice(0,120)}-import-${randomBytes(6).toString("hex")}`; this.warn("Conflicting design documents were imported as copies with unique slugs; existing content was retained."); }
        const allocated = await this.client.query(`INSERT INTO site_documents(slug,title,type,content${this.themedDocuments ? ",theme" : ""}) VALUES($1,$2,$3,''${this.themedDocuments ? ",$4" : ""}) RETURNING id`, this.themedDocuments ? [slug, normalizedText(doc.title), doc.type, theme] : [slug, normalizedText(doc.title), doc.type]);
        documentId = allocated.rows[0].id;
      }
      this.documents.set(key, slug);
      if (theme === this.sourceTheme) this.documents.set(`${doc.type}:${doc.slug}`, slug);
      this.documentIds.push(documentId);
      this.docs.push({ ...doc, raw_content: raw || doc.content, id: documentId, slug, theme });
    }
    const menus = z.array(z.record(z.string(), z.unknown())).max(1000).parse(this.input.menus || []);
    for (const item of menus) { const menu = menuSchema.parse({ name: item.name, location: item.location, items: item.items }); validMenu(menu.items); this.menus.push(menu); }
  }
  private async restoreMedia() {
    const records = z.array(z.record(z.string(), z.unknown())).max(1000).parse(this.input.media || []);
    if (new Set(records.map(item => Number(item.id))).size !== records.length) throw new HttpError(400, "Imported media IDs must be unique.");
    const fileRecords = z.array(z.object({ filename, mimeType: z.string().max(255), size: z.number().int().positive().max(MAX_ARCHIVE_FILE_BYTES), sha256: z.string().regex(/^[a-f0-9]{64}$/), data: z.string().max(Math.ceil(MAX_ARCHIVE_FILE_BYTES / 3) * 4).regex(/^[A-Za-z0-9+/]*={0,2}$/) })).max(5000).parse(this.input.mediaFiles || []);
    if (new Set(fileRecords.map(item => item.filename)).size !== fileRecords.length) throw new HttpError(400, "Imported file names must be unique.");
    let byteCount = 0;
    const embedded = new Map<string, { data: Buffer; mime: string; ext: string }>();
    for (const file of fileRecords) {
      const data = Buffer.from(file.data, "base64"); byteCount += data.length;
      if (data.toString("base64") !== file.data || data.length !== file.size || createHash("sha256").update(data).digest("hex") !== file.sha256) throw new HttpError(400, "An embedded media file failed its size or checksum check.");
      if (byteCount > MAX_ARCHIVE_MEDIA_BYTES) throw new HttpError(413, "Import at most 64 MiB of uploaded files per archive.");
      const type = await fileTypeFromBuffer(data);
      if (!type || type.mime !== file.mimeType || !supportedMimes.has(type.mime)) throw new HttpError(400, "An embedded media file has an unsupported or mismatched MIME signature.");
      if (type.mime.startsWith("image/")) await sharp(data, { limitInputPixels: 80_000_000 }).metadata().catch(() => { throw new HttpError(400, "An embedded image cannot be decoded safely."); });
      embedded.set(file.filename, { data, mime: type.mime, ext: type.ext });
    }
    const copied = new Map<string, { filename: string; mime: string; data: Buffer }>();
    const prefix = `imports/${randomBytes(8).toString("hex")}/`;
    const copy = async (name: unknown) => {
      if (name == null || name === "") return null;
      const source = filename.parse(name);
      if (copied.has(source)) return copied.get(source)!;
      let file = embedded.get(source);
      if (!file) {
        if (this.input.version >= 3) { this.warn(`Media file ${source} is absent from the archive.`); return null; }
        let data: Buffer;
        try { const info = await stat(path.join(uploadsDir, source)); if (info.size > MAX_ARCHIVE_FILE_BYTES || byteCount + info.size > MAX_ARCHIVE_MEDIA_BYTES) throw new HttpError(413, "Local media exceeds the archive size limit."); data = await readFile(path.join(uploadsDir, source)); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; this.warn(`Media file ${source} is not available locally and was not downloaded.`); return null; }
        byteCount += data.length;
        if (data.length > MAX_ARCHIVE_FILE_BYTES || byteCount > MAX_ARCHIVE_MEDIA_BYTES) throw new HttpError(413, "Local media exceeds the archive file limit.");
        const type = await fileTypeFromBuffer(data);
        if (!type || !supportedMimes.has(type.mime)) throw new HttpError(400, "A local media file has an unsupported MIME signature.");
        file = { data, mime: type.mime, ext: type.ext };
        this.warn(`Media file ${source} was copied from the existing local upload library.`);
      }
      const target = prefix + randomBytes(16).toString("hex") + "." + file.ext;
      await mkdir(path.join(uploadsDir, prefix), { recursive: true });
      await writeFile(path.join(uploadsDir, target), file.data, { flag: "wx" }); this.createdFiles.add(target);
      const result = { filename: target, mime: file.mime, data: file.data }; copied.set(source, result);
      const url = "/uploads/" + target, sourceURL = "/uploads/" + source;
      this.urls.set(sourceURL, url);
      if (this.settings.siteUrl) this.urls.set(new URL(sourceURL, this.settings.siteUrl).href, new URL(url, this.destination.siteUrl).href);
      return result;
    };
    for (const item of records) {
      const sourceId = id.parse(item.id);
      const main = await copy(item.filename);
      if (!main) { this.warn(`Media record ${sourceId} could not be restored; its ID references were detached.`); continue; }
      const original = await copy(item.original_filename), derivatives: Record<string, string> = {}, sizes: Record<string, any> = {};
      const inputDerivatives = z.record(z.string().max(200), filename).parse(item.derivatives || {});
      for (const [key, name] of Object.entries(inputDerivatives)) { const file = await copy(name); if (file) derivatives[key] = file.filename; }
      const inputSizes = z.record(z.string().max(100), z.object({ filename, width: z.number().int().positive().max(20000), height: z.number().int().positive().max(20000) }).passthrough()).parse(item.sizes || {});
      for (const [key, size] of Object.entries(inputSizes)) { const file = await copy(size.filename); if (file) sizes[key] = { filename: file.filename, url: "/uploads/" + file.filename, width: size.width, height: size.height, mimeType: file.mime }; }
      let width = null, height = null;
      if (main.mime.startsWith("image/")) { const metadata = await sharp(main.data, { limitInputPixels: 80_000_000 }).metadata(); width = metadata.width ?? null; height = metadata.height ?? null; }
      const row = await this.client.query("INSERT INTO media(author_id,title,filename,mime_type,alt,caption,size,width,height,original_filename,derivatives,sizes,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12::jsonb,coalesce($13::timestamptz,now())) RETURNING id", [this.user.id, plainText(z.string().max(300).parse(item.title)), main.filename, main.mime, plainText(z.string().max(1000).parse(item.alt || "")), plainText(z.string().max(20000).parse(item.caption || "")), main.data.length, width, height, original?.filename || null, JSON.stringify(derivatives), JSON.stringify(sizes), z.iso.datetime({ offset: true }).optional().parse(item.created_at) ?? null]);
      this.media.set(sourceId, row.rows[0].id);
      await this.client.query("UPDATE media SET description=$1,comment_status=$2 WHERE id=$3",[cleanContent(z.string().max(20000).parse(item.description || "")),z.enum(["open","closed"]).parse(item.comment_status || "closed"),row.rows[0].id]);
    }
    this.decodedBytes = byteCount;
    const unused = [...embedded.keys()].filter(name => !copied.has(name));
    if (unused.length) this.warn(`${unused.length} embedded file(s) had no restored media record references and were not written.`);
  }
  private async restoreFonts() {
    this.hasFontArchive = ["fontFamilies", "fontFaces", "themeFonts", "fontFiles"].some(field => Object.hasOwn(this.input, field));
    const families = z.array(z.object({ id, name: fontName, slug: z.string().min(1).max(160).regex(/^[a-z0-9][a-z0-9-]*$/), source: z.enum(["upload", "bundled"]), collection_key: z.string().max(160).nullable().optional(), created_at: z.iso.datetime({ offset: true }).optional() })).max(200).parse(this.input.fontFamilies || []);
    const faces = z.array(z.object({ id, family_id: id, archiveFile: archivedFont.optional(), filename: storedFont.nullable().optional(), format: fontFormat, sha256: z.string().regex(/^[a-f0-9]{64}$/), created_at: z.iso.datetime({ offset: true }).optional() })).max(800).parse(this.input.fontFaces || []);
    const selections = z.array(z.object({ theme: themes, family_id: id }).strict()).max(800).parse(this.input.themeFonts || []);
    const records = z.array(z.object({ filename: archivedFont, mimeType: z.string().max(30), format: fontFormat, size: z.number().int().positive().max(MAX_ARCHIVE_FONT_BYTES), sha256: z.string().regex(/^[a-f0-9]{64}$/), data: z.string().max(Math.ceil(MAX_ARCHIVE_FONT_BYTES / 3) * 4).regex(/^[A-Za-z0-9+/]*={0,2}$/) }).strict()).max(800).parse(this.input.fontFiles || []);
    for (const values of [families.map(item => item.id), families.map(item => item.name.toLowerCase()), faces.map(item => item.id), selections.map(item => item.theme + ":" + item.family_id), records.map(item => item.filename)]) if (new Set<string | number>(values).size !== values.length) throw new HttpError(400, "Font archive identifiers, family names, selections and filenames must be unique.");
    const embedded = new Map<string, { data: Buffer; hash: string; verified: Awaited<ReturnType<typeof inspectFont>> }>();
    for (const file of records) {
      const data = Buffer.from(file.data, "base64"); this.decodedBytes += data.length;
      if (this.decodedBytes > MAX_ARCHIVE_MEDIA_BYTES) throw new HttpError(413, "Import at most 64 MiB of decoded media plus font files.");
      const hash = createHash("sha256").update(data).digest("hex");
      if (data.length !== file.size || data.toString("base64") !== file.data || hash !== file.sha256) throw new HttpError(400, "An embedded font failed its size or checksum check.");
      const verified = await inspectFont(data);
      if (verified.format !== file.format || fontMIME(verified.format) !== file.mimeType || !file.filename.endsWith("." + verified.extension)) throw new HttpError(400, "An embedded font has a mismatched format, extension or MIME type.");
      embedded.set(file.filename, { data, hash, verified });
    }
    this.importedThemeFonts = selections;
    if (this.hasFontArchive && !(await this.client.query("SELECT to_regclass('font_families') present")).rows[0].present) throw new HttpError(400, "The Font Library schema must be migrated before restoring fonts.");
    if (!families.length && !faces.length) { if (records.length) this.warn("Embedded font files without family or face records were not installed."); for (const selection of selections) this.warn(`Font selection ${selection.family_id} for ${selection.theme} had no family record and was detached.`); return; }
    if (!(await this.client.query("SELECT to_regclass('font_families') present")).rows[0].present) throw new HttpError(400, "The Font Library schema must be migrated before restoring fonts.");
    await this.client.query("SELECT pg_advisory_xact_lock(hashtext('worldact-font-library'))");
    const counts = (await this.client.query("SELECT (SELECT count(*)::int FROM font_families) families,(SELECT count(*)::int FROM font_faces) faces")).rows[0];
    const written = new Set<string>();
    for (const family of families) {
      this.fontNames.set(family.name, null); this.fontSlugs.set(`worldact-font-${family.id}`, null); this.fontSlugs.set(family.slug, null);
      const collection = family.source === "bundled" ? bundledFontCollection.find(item => item.key === family.collection_key) : undefined;
      if (family.source === "bundled" && !collection) throw new HttpError(400, "A bundled font family must identify a known local collection.");
      const canonical = new Map<string, (typeof bundledFontCollection)[number]["faces"][number]>();
      if (collection) for (const face of collection.faces) { const data = await readFile(path.join(rootDir, "public", face.url)); canonical.set(createHash("sha256").update(data).digest("hex"), face); }
      const prepared: Array<{ face: typeof faces[number]; file: NonNullable<ReturnType<typeof embedded.get>>; bundled?: (typeof bundledFontCollection)[number]["faces"][number] }> = [];
      const hashes = new Set<string>();
      for (const face of faces.filter(item => item.family_id === family.id)) {
        const key = face.archiveFile || face.filename, file = key ? embedded.get(key) : undefined;
        if (!file) { this.warn(`Font face ${face.id} has no embedded file and was not installed.`); continue; }
        if (face.sha256 !== file.hash || face.format !== file.verified.format) throw new HttpError(400, "A font face does not match its verified embedded file.");
        if (hashes.has(file.hash)) throw new HttpError(400, "A font family cannot contain duplicate file checksums."); hashes.add(file.hash);
        if (collection && !canonical.has(file.hash)) throw new HttpError(400, "A bundled font face must match a known local collection file.");
        prepared.push({ face, file, bundled: canonical.get(file.hash) });
      }
      if (!prepared.length) { this.warn(`Font family ${family.name} had no available faces; references and selections were detached.`); continue; }
      if (Number(counts.families) + this.fontFamilies.size + 1 > 200 || Number(counts.faces) + this.fontFaceIds.length + prepared.length > 800) throw new HttpError(400, "Restore at most 200 installed font families and 800 font faces.");
      let name = family.name;
      if ((await this.client.query("SELECT 1 FROM font_families WHERE lower(name)=lower($1)", [name])).rowCount) { name = `${name.slice(0,90)} Imported ${randomBytes(6).toString("hex")}`; this.warn(`Font family ${family.name} was installed with a unique CSS family alias; the existing family was retained.`); }
      const target = (await this.client.query("INSERT INTO font_families(name,slug,source,collection_key,created_at) VALUES($1,$2,$3,$4,coalesce($5::timestamptz,now())) RETURNING id", [name, `${slugify(family.slug).slice(0,120)}-import-${randomBytes(8).toString("hex")}`, family.source, collection?.key || null, family.created_at ?? null])).rows[0].id;
      this.fontFamilies.set(family.id, target); this.fontNames.set(family.name, name); this.fontSlugs.set(`worldact-font-${family.id}`, `worldact-font-${target}`); this.fontSlugs.set(family.slug, `worldact-font-${target}`);
      for (const { face, file, bundled } of prepared) {
        const filename = `fonts/${randomBytes(24).toString("hex")}.${file.verified.extension}`;
        await mkdir(path.join(uploadsDir, "fonts"), { recursive: true }); await writeFile(path.join(uploadsDir, filename), file.data, { flag: "wx" }); this.createdFiles.add(filename); written.add(face.archiveFile || face.filename!);
        const metadata = { ...file.verified.metadata, ...(bundled ? { copyright: bundled.metadata.copyright || file.verified.metadata.copyright, license: bundled.metadata.license || file.verified.metadata.license, licenseURL: bundled.metadata.licenseURL || file.verified.metadata.licenseURL } : {}) };
        const inserted = await this.client.query("INSERT INTO font_faces(family_id,filename,url,format,style,weight,stretch,sha256,metadata,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,coalesce($10::timestamptz,now())) RETURNING id", [target, filename, "/uploads/" + filename, file.verified.format, bundled?.style || file.verified.metadata.style, bundled?.weight || file.verified.metadata.weight, bundled?.stretch || file.verified.metadata.stretch, file.hash, JSON.stringify(metadata), face.created_at ?? null]);
        this.fontFaceIds.push(inserted.rows[0].id);
        const sourceURL = face.filename ? "/uploads/" + face.filename : bundled?.url;
        if (sourceURL) { this.urls.set(sourceURL, "/uploads/" + filename); if (this.settings.siteUrl) this.urls.set(new URL(sourceURL, this.settings.siteUrl).href, new URL("/uploads/" + filename, this.destination.siteUrl).href); }
      }
    }
    for (const face of faces) if (!families.some(family => family.id === face.family_id)) this.warn(`Font face ${face.id} referred to a missing family and was not installed.`);
    this.importedThemeFonts = selections;
    const unused = records.filter(file => !written.has(file.filename)).length;
    if (unused) this.warn(`${unused} embedded font file(s) had no installed face references and were not written.`);
    if (this.input.replaceDesign !== true && selections.length) this.warn("Imported fonts were installed without changing live theme font activations.");
  }
  private mappedFontStyles(styles: Record<string, unknown>) {
    const value = { ...styles };
    for (const field of ["fontFamily", "headingFont"]) if (typeof value[field] === "string") {
      const source = [...this.fontNames.keys()].find(name => name.toLowerCase() === String(value[field]).toLowerCase());
      const mapped = source ? this.fontNames.get(source) : undefined;
      if (mapped) value[field] = mapped;
      else if (source || (this.hasFontArchive && !["Manrope", "Inter", "Georgia", "System", "serif", "sans-serif"].includes(value[field] as string))) {
        delete value[field]; this.warn(`The unavailable imported ${field} override was removed.`);
      }
    }
    return value;
  }
  async finalize(posts: ReadonlyMap<number, number>, terms: ReadonlyMap<number, number>, entities: ReadonlyMap<number, ImportedBlockEntity>) {
    for(const item of this.input.media || []){
      const target=this.media.get(Number(item.id));if(!target || !item.attached_post_id)continue;
      const source=id.parse(item.attached_post_id),post=posts.get(source);
      if(post)await this.client.query("UPDATE media SET attached_post_id=$1 WHERE id=$2",[post,target]);
      else this.warn(`Media attachment ${source} referred to content missing from the archive and was detached.`);
    }
    const authors = new Map<number, number>();
    for (const post of this.input.posts || []) if (post.author_id) authors.set(Number(post.author_id), this.user.id);
    if (this.input.replaceDesign === true) {
      const { adminEmail: _contact, siteUrl: _url, ...settings } = this.settings;
      for (const field of ["frontPageId", "postsPageId", "privacyPageId"] as const) if (settings[field]) { const source = settings[field]!; settings[field] = posts.get(source) || null; if (!settings[field]) this.warn(`Setting ${field} referred to a page missing from the archive and was cleared.`); }
      if (settings.defaultCategoryId) { const source = settings.defaultCategoryId; settings.defaultCategoryId = terms.get(source) || null; if (!settings.defaultCategoryId) this.warn("The missing default category setting was cleared."); }
      for (const field of ["siteLogoId", "siteIconId"] as const) if (settings[field]) { const source = settings[field]!; settings[field] = this.media.get(source) || 0; if (!settings[field]) this.warn(`The missing ${field} media selection was cleared.`); }
      if (settings.frontPageMode === "page" && !settings.frontPageId) { settings.frontPageMode = "posts"; this.warn("The missing front page was replaced with the posts index."); }
      for (const field of ["siteTitle", "tagline"] as const) if (settings[field] !== undefined) settings[field] = field === "siteTitle" ? normalizedText(settings[field]!) : plainText(settings[field]!);
      for (const field of ["frontPageId", "postsPageId", "privacyPageId"] as const) if (settings[field] && !(await this.client.query("SELECT id FROM posts WHERE id=$1 AND type='page' AND status<>'trash'", [settings[field]])).rowCount) throw new HttpError(400, `Imported ${field} must identify a non-trash page.`);
      if (settings.defaultCategoryId && !(await this.client.query("SELECT id FROM terms WHERE id=$1 AND taxonomy='category'", [settings.defaultCategoryId])).rowCount) throw new HttpError(400, "Imported default category must be a category.");
      if (this.hasFontArchive) {
        await this.client.query("DELETE FROM theme_fonts WHERE theme=ANY($1::text[])", [["twentytwentyfive", "twentytwentyfour", "twentytwentythree", "classic"]]);
        await this.client.query("UPDATE theme_designs SET styles=styles-'fontFamily'-'headingFont'");
        for (const selection of this.importedThemeFonts) { const target = this.fontFamilies.get(selection.family_id); if (target) await this.client.query("INSERT INTO theme_fonts(theme,family_id) VALUES($1,$2) ON CONFLICT DO NOTHING", [selection.theme, target]); else this.warn(`An unavailable font selection for ${selection.theme} was detached.`); }
      }
      const styles = this.mappedFontStyles(this.styles);
      await validateFontChoices(styles, this.themeDesigns.length ? "classic" : this.sourceTheme, this.client);
      for (const design of this.themeDesigns) { design.styles = this.mappedFontStyles(design.styles); await validateFontChoices(design.styles, design.theme, this.client); }
      await this.client.query("UPDATE settings SET data=data || $1::jsonb WHERE id=1", [JSON.stringify(settings)]);
      await this.client.query(`UPDATE site_styles SET data=${this.hasFontArchive ? "(data-'fontFamily'-'headingFont')" : "data"} || $1::jsonb WHERE id=1`, [JSON.stringify(styles)]);
      if (this.themeDesigns.length && (await this.client.query("SELECT to_regclass('theme_designs') present")).rows[0].present)
        for (const design of this.themeDesigns) await this.client.query("INSERT INTO theme_designs(theme,variation,styles) VALUES($1,$2,$3::jsonb) ON CONFLICT(theme) DO UPDATE SET variation=excluded.variation,styles=excluded.styles,updated_at=now()", [design.theme, design.variation, JSON.stringify(design.styles)]);
      else if (Object.keys(styles).length && (await this.client.query("SELECT to_regclass('theme_designs') present")).rows[0].present)
        await this.client.query("INSERT INTO theme_designs(theme,variation,styles) VALUES($1,'',$2::jsonb) ON CONFLICT(theme) DO UPDATE SET styles=excluded.styles,updated_at=now()", [this.sourceTheme, JSON.stringify(styles)]);
      this.destination = await getSettings(this.client);
      for (const extension of this.extensions) await this.client.query("INSERT INTO extensions(slug,enabled,settings) VALUES($1,$2,$3::jsonb) ON CONFLICT(slug) DO UPDATE SET enabled=excluded.enabled,settings=excluded.settings", [extension.slug, extension.enabled, JSON.stringify(extension.settings)]);
    } else if (this.input.settings || this.input.styles) this.warn("Live settings and styles were retained. Choose Replace site design and settings to activate the archive's design.");
    if (this.input.replaceDesign !== true && (this.extensions.length || this.themeDesigns.length)) this.warn("Live extension and theme variation settings were retained; activation requires Replace site design and settings.");
    if (this.settings.adminEmail || this.settings.siteUrl) this.warn("The destination administrator contact and site URL were retained.");
    for (const oldPost of this.input.posts || []) {
      const targetId = posts.get(Number(oldPost.id));
      if (!targetId || typeof oldPost.permalink !== "string") continue;
      const post = await getPost(targetId, this.client);
      const url = await postPermalink(post, this.destination, this.client);
      if (/^\/(?!\/)[^?#<>\\]*$/.test(oldPost.permalink) && oldPost.permalink !== "/") {
        this.urls.set(oldPost.permalink, url);
        if (this.settings.siteUrl) this.urls.set(new URL(oldPost.permalink, this.settings.siteUrl).href, new URL(url, this.destination.siteUrl).href);
      }
    }
    for (const oldTerm of this.input.terms || []) {
      const targetId = terms.get(Number(oldTerm.id));
      if (!targetId) continue;
      const term = (await this.client.query("SELECT taxonomy,slug FROM terms WHERE id=$1", [targetId])).rows[0];
      const sourceBase = oldTerm.taxonomy === "category" ? this.settings.categoryBase || "category" : this.settings.tagBase || "tag";
      const targetBase = term.taxonomy === "category" ? this.destination.categoryBase : this.destination.tagBase;
      const oldURL = `/${sourceBase}/${encodeURIComponent(String(oldTerm.slug))}/`, newURL = `/${targetBase}/${encodeURIComponent(term.slug)}/`;
      this.urls.set(oldURL, newURL);
      if (this.settings.siteUrl) this.urls.set(new URL(oldURL, this.settings.siteUrl).href, new URL(newURL, this.destination.siteUrl).href);
    }
    const options = { ...this.options, posts, terms, authors };
    for (const doc of this.docs) {
      const value = remapImportedBlockReferences(doc.raw_content, doc.blocks, entities, { ...options, documentTheme: doc.theme });
      for (const warning of value.warnings) this.warn(warning);
      await this.client.query("UPDATE site_documents SET slug=$1,title=$2,content=$3,raw_content=$4,blocks=$5::jsonb,version=version+1,updated_at=now() WHERE id=$6", [doc.slug, normalizedText(doc.title), value.content, value.rawContent, JSON.stringify(value.blocks), doc.id]);
    }
    await this.client.query("SELECT pg_advisory_xact_lock(hashtext('worldact-menu-locations'))");
    const assigned = new Set<string>();
    for (const menu of this.menus) {
      if (menu.location && this.input.replaceDesign === true) {
        if (assigned.has(menu.location)) throw new HttpError(400, "An archive may assign only one menu to each theme location.");
        assigned.add(menu.location); await this.client.query("UPDATE navigation_menus SET location='',updated_at=now() WHERE location=$1", [menu.location]);
      } else if (menu.location) this.warn(`Menu ${menu.name} imported without changing the existing ${menu.location} assignment.`);
      const items = menu.items.map((item: any) => ({ ...item, url: [...this.urls].sort((a,b) => b[0].length-a[0].length).reduce((value, [source,target]) => value.split(source).join(target), item.url) }));
      validMenu(menuSchema.parse({ ...menu, items }).items);
      const row = await this.client.query("INSERT INTO navigation_menus(name,location,items) VALUES($1,$2,$3::jsonb) RETURNING id", [menu.name, this.input.replaceDesign === true ? menu.location : "", JSON.stringify(items)]); this.menuIds.push(row.rows[0].id);
    }
    return options;
  }
  async rollbackFiles() { await Promise.all([...this.createdFiles].map(name => unlink(path.join(uploadsDir, name)).catch(() => {}))); await Promise.all([...new Set([...this.createdFiles].map(name => path.dirname(name)))].map(name => rmdir(path.join(uploadsDir, name)).catch(() => {}))); }
}
