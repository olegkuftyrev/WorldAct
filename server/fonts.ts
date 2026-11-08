import { Router, type ErrorRequestHandler } from "express";
import multer from "multer";
import path from "node:path";
import { mkdir, readFile, writeFile, unlink } from "node:fs/promises";
import { createHash, randomBytes } from "node:crypto";
import { Worker } from "node:worker_threads";
import type pg from "pg";
import { z } from "zod";
import { pool, rootDir, uploadsDir, getSettings } from "./db.js";
import { requireRole } from "./auth.js";
import { HttpError, parseId } from "./utils.js";
import bundledData from "../src/theme-source/bundled.json";
import fontNotices from "../src/theme-source/font-attributions.json";
import type { ThemeJSON } from "../src/themeStyles.js";

type Database = Pick<pg.Pool, "query"> | pg.PoolClient;
const MAX_UPLOAD = 8 * 1024 * 1024,
  MAX_EXPANDED = 32 * 1024 * 1024;
const supportedThemes = z.enum([
  "twentytwentyfive",
  "twentytwentyfour",
  "twentytwentythree",
  "classic",
]);
const fontName = z
  .string()
  .trim()
  .min(1)
  .max(120)
  .regex(/^[\p{L}\p{N}][\p{L}\p{N} ._'()-]*$/u);
const weight = z
  .string()
  .regex(/^(?:[1-9]\d{0,2}|1000)(?: (?:[1-9]\d{0,2}|1000))?$/)
  .refine((value) => {
    const values = value.split(" ").map(Number);
    return values.length === 1 || values[0] <= values[1];
  });
const stretch = z
  .string()
  .max(30)
  .regex(
    /^(?:normal|(?:[5-9]\d|1\d\d|200)(?:\.\d+)?%(?: (?:[5-9]\d|1\d\d|200)(?:\.\d+)?%)?)$/,
  )
  .refine((value) => {
    const values = value.split(" ").map(parseFloat);
    return (
      value === "normal" ||
      (values.every((item) => item >= 50 && item <= 200) &&
        (values.length === 1 || values[0] <= values[1]))
    );
  });
const description = z.object({
  family: fontName,
  fullName: z.string().max(240),
  postscriptName: z.string().max(240),
  style: z.enum(["normal", "italic", "oblique"]),
  weight,
  stretch,
  copyright: z.string().max(8000),
  license: z.string().max(12000),
  licenseURL: z.string().max(2000),
  numGlyphs: z.number().int().min(1).max(65535),
  unitsPerEm: z.number().int().min(16).max(16384),
  characterCount: z.number().int().min(1).max(1_114_112),
  axes: z
    .record(
      z.string().max(8),
      z.object({
        min: z.number().finite(),
        max: z.number().finite(),
        default: z.number().finite(),
      }),
    )
    .optional(),
});
export type FontMetadata = z.infer<typeof description>;
export interface LibraryFace {
  id: number;
  url: string;
  format: string;
  style: string;
  weight: string;
  stretch: string;
  metadata: Record<string, unknown>;
}
export interface LibraryFamily {
  id: number;
  name: string;
  slug: string;
  source: "upload" | "bundled";
  active: boolean;
  activeThemes: string[];
  faces: LibraryFace[];
}
function formatFor(buffer: Buffer) {
  if (buffer.length < 12 || buffer.length > MAX_UPLOAD)
    throw new HttpError(400, "Upload a font no larger than 8 MiB.");
  const signature = buffer.toString("ascii", 0, 4);
  if (signature === "wOFF" || signature === "wOF2") {
    const woff2 = signature === "wOF2",
      header = woff2 ? 48 : 44;
    if (
      buffer.length < header ||
      buffer.readUInt32BE(8) !== buffer.length ||
      buffer.readUInt16BE(14) !== 0
    )
      throw new HttpError(400, "The font header is invalid.");
    const flavor = buffer.toString("ascii", 4, 8),
      tables = buffer.readUInt16BE(12),
      expanded = buffer.readUInt32BE(16);
    if (
      flavor === "ttcf" ||
      tables < 1 ||
      tables > 256 ||
      expanded < 12 ||
      expanded > MAX_EXPANDED
    )
      throw new HttpError(
        400,
        "The font exceeds the supported table or expanded-size limits.",
      );
    if (woff2) {
      // Fontkit allocates its Brotli destination from the directory, not from
      // totalSfntSize. Check both sizes before any parser/decompressor runs.
      let cursor = 48,
        originalSize = 12 + tables * 16,
        transformedSize = 0;
      const base128 = () => {
        let result = 0;
        for (let index = 0; index < 5; index++) {
          if (cursor >= buffer.length)
            throw new HttpError(400, "The font directory is truncated.");
          const byte = buffer[cursor++];
          if ((index === 0 && byte === 0x80) || result > 0x1ffffff)
            throw new HttpError(400, "The font directory length is invalid.");
          result = result * 128 + (byte & 0x7f);
          if (!(byte & 0x80)) return result;
        }
        throw new HttpError(400, "The font directory length is invalid.");
      };
      const tags = new Set<string>();
      for (let index = 0; index < tables; index++) {
        if (cursor >= buffer.length)
          throw new HttpError(400, "The font directory is truncated.");
        const flags = buffer[cursor++],
          tagIndex = flags & 63,
          version = flags >>> 6;
        let tag = String(tagIndex);
        if (tagIndex === 63) {
          if (cursor + 4 > buffer.length)
            throw new HttpError(400, "The font directory is truncated.");
          tag = buffer.toString("ascii", cursor, cursor + 4);
          cursor += 4;
        }
        if (tags.has(tag))
          throw new HttpError(400, "The font has duplicate tables.");
        tags.add(tag);
        const original = base128(),
          glyf =
            tagIndex === 10 ||
            tagIndex === 11 ||
            tag === "glyf" ||
            tag === "loca";
        const transformed = glyf ? version === 0 : version !== 0;
        const stored = transformed ? base128() : original;
        originalSize += Math.ceil(original / 4) * 4;
        transformedSize += stored;
        if (originalSize > MAX_EXPANDED || transformedSize > MAX_EXPANDED)
          throw new HttpError(400, "The expanded font exceeds 32 MiB.");
      }
      if (originalSize !== expanded || transformedSize === 0)
        throw new HttpError(400, "The expanded font length is invalid.");
      if (cursor + buffer.readUInt32BE(20) > buffer.length)
        throw new HttpError(400, "The compressed font data is truncated.");
    } else {
      if (header + tables * 20 > buffer.length)
        throw new HttpError(400, "The font directory is truncated.");
      let sum = 12 + tables * 16;
      for (let n = 0; n < tables; n++) {
        const start = header + n * 20,
          offset = buffer.readUInt32BE(start + 4),
          length = buffer.readUInt32BE(start + 8),
          original = buffer.readUInt32BE(start + 12);
        if (
          offset < header + tables * 20 ||
          offset + length > buffer.length ||
          length > original ||
          original > MAX_EXPANDED
        )
          throw new HttpError(400, "The font table is invalid.");
        sum += (original + 3) & ~3;
      }
      if (sum > MAX_EXPANDED || sum !== expanded)
        throw new HttpError(400, "The expanded font length is invalid.");
    }
    return {
      format: woff2 ? "woff2" : "woff",
      extension: woff2 ? "woff2" : "woff",
    };
  }
  if (
    buffer.readUInt32BE(0) !== 0x00010000 &&
    signature !== "OTTO" &&
    signature !== "true"
  )
    throw new HttpError(400, "Choose a valid TTF, OTF, WOFF, or WOFF2 font.");
  const tables = buffer.readUInt16BE(4),
    directory = 12 + tables * 16;
  if (tables < 1 || tables > 256 || directory > buffer.length)
    throw new HttpError(400, "The font directory is invalid.");
  const tags = new Set<string>();
  for (let n = 0; n < tables; n++) {
    const start = 12 + n * 16,
      offset = buffer.readUInt32BE(start + 8),
      length = buffer.readUInt32BE(start + 12);
    if (offset < directory || offset + length > buffer.length)
      throw new HttpError(400, "The font table is truncated.");
    tags.add(buffer.toString("ascii", start, start + 4));
  }
  if (!["head", "name", "maxp", "cmap"].every((tag) => tags.has(tag)))
    throw new HttpError(400, "The font is missing required metadata tables.");
  return {
    format: signature === "OTTO" ? "opentype" : "truetype",
    extension: signature === "OTTO" ? "otf" : "ttf",
  };
}
const workerSource = String.raw`
const {parentPort,workerData}=require('node:worker_threads');
const {createRequire}=require('node:module');
try {
  const fontkit=createRequire(workerData.packagePath)('fontkit');
  const font=fontkit.create(Buffer.from(workerData.bytes));
  if(font.fonts)throw new Error('Font collections are not supported.');
  const text=(value,max)=>String(value || '').replace(/[\u0000-\u001f\u007f]/g,' ').slice(0,max);
  const axes={};for(const [key,value] of Object.entries(font.variationAxes || {}))axes[key]={min:value.min,max:value.max,default:value.default};
  const os2=font['OS/2'] || {},wght=axes.wght;
  const weight=wght?Math.max(1,Math.round(wght.min))+' '+Math.min(1000,Math.round(wght.max)):String(os2.usWeightClass || 400);
  const family=text(font.familyName,121),subfamily=String(font.subfamilyName || '');
  const charset=font.characterSet;
  if(!Array.isArray(charset) || charset.length===0 || charset.some(n=>!Number.isInteger(n) || n<0 || n>0x10ffff))throw new Error('Invalid Unicode character map.');
  const glyph=font.glyphForCodePoint(charset[0]);
  if(!glyph || glyph.id<0 || glyph.id>=font.numGlyphs)throw new Error('Invalid font glyph map.');
  const names=font.name?.records || {};
  const notice=(id)=>{const value=names[id];return value && typeof value==='object' ? Object.values(value).find(v=>typeof v==='string') : value;};
  parentPort.postMessage({ok:true,metadata:{family,fullName:text(font.fullName,240),postscriptName:text(font.postscriptName,240),style:/italic/i.test(subfamily)?'italic':/oblique/i.test(subfamily)?'oblique':'normal',weight,stretch:'normal',copyright:text(font.copyright || notice('copyright'),8000),license:text(notice('license') || notice('licenseDescription'),12000),licenseURL:text(notice('licenseURL') || notice('licenseInfoURL'),2000),numGlyphs:font.numGlyphs,unitsPerEm:font.unitsPerEm,characterCount:charset.length,axes}});
}catch(error){parentPort.postMessage({ok:false,error:'The font metadata or glyph tables could not be read.'});}
`;
let activeParsers = 0;
export async function inspectFont(buffer: Buffer) {
  const format = formatFor(buffer);
  if (activeParsers >= 2)
    throw new HttpError(
      503,
      "Two fonts are being checked. Try uploading again shortly.",
    );
  activeParsers++;
  try {
    const metadata = await new Promise<FontMetadata>((resolve, reject) => {
      let settled = false;
      const worker = new Worker(workerSource, {
        eval: true,
        name: "WorldAct font verification",
        workerData: {
          packagePath: path.join(rootDir, "package.json"),
          bytes: buffer,
        },
        resourceLimits: {
          maxOldGenerationSizeMb: 64,
          maxYoungGenerationSizeMb: 16,
          stackSizeMb: 4,
        },
      });
      const finish = (error: Error | null, value?: FontMetadata) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        void worker.terminate();
        error ? reject(error) : resolve(value!);
      };
      const timer = setTimeout(
        () =>
          finish(
            new HttpError(
              400,
              "This font took too long to verify. Choose a different font file.",
            ),
          ),
        5000,
      );
      worker.once("message", (result) => {
        if (!result.ok) finish(new HttpError(400, result.error));
        else {
          const parsed = description.safeParse(result.metadata);
          parsed.success
            ? finish(null, parsed.data)
            : finish(
                new HttpError(
                  400,
                  "The font has unsupported or invalid family metadata.",
                ),
              );
        }
      });
      worker.once("error", () =>
        finish(new HttpError(400, "This font could not be verified safely.")),
      );
      worker.once("exit", (code) => {
        if (!settled)
          finish(
            new HttpError(
              400,
              code
                ? "The font exceeded the verification memory limit."
                : "The font metadata is missing.",
            ),
          );
      });
    });
    return { ...format, metadata };
  } finally {
    activeParsers--;
  }
}
const normalizedFamily = (value: string) =>
  value.replace(/^['"]|['"]$/g, "").trim();
type CollectionFamily = {
  key: string;
  name: string;
  faces: Array<{
    url: string;
    format: string;
    style: string;
    weight: string;
    stretch: string;
    metadata: Record<string, unknown>;
  }>;
};
export const bundledFontCollection: CollectionFamily[] = (() => {
  const families = new Map<string, CollectionFamily>();
  for (const theme of bundledData as any[])
    for (const document of [
      theme.themeJSON,
      ...theme.variations.map((item: any) => item.data),
    ])
      for (const family of document.settings?.typography?.fontFamilies || []) {
        if (!family.fontFace?.length) continue;
        const name = fontName.parse(
          normalizedFamily(family.fontFace[0].fontFamily || family.name),
        );
        let item = families.get(name.toLowerCase());
        if (!item) {
          item = {
            key: name
              .toLowerCase()
              .normalize("NFKD")
              .replace(/[^a-z0-9]+/g, "-")
              .replace(/^-|-$/g, ""),
            name,
            faces: [],
          };
          families.set(name.toLowerCase(), item);
        }
        for (const face of family.fontFace) {
          const url = (Array.isArray(face.src) ? face.src : [face.src]).find(
            (src: string) =>
              /^\/vendor\/wordpress\/wp-content\/themes\/[a-z]+\/assets\/fonts\/.+\.(?:woff2?|ttf|otf)$/.test(
                src,
              ),
          );
          if (
            !url ||
            item.faces.some(
              (f) =>
                f.url === url ||
                (f.weight === (face.fontWeight || "400") &&
                  f.style === (face.fontStyle || "normal") &&
                  f.stretch === (face.fontStretch || "normal")),
            )
          )
            continue;
          const attribution = (fontNotices as any[])
            .find((record) => record.theme === theme.id)
            ?.fonts.find((record: any) => url.endsWith("/" + record.file));
          item.faces.push({
            url,
            format: url.endsWith("woff2")
              ? "woff2"
              : url.endsWith("woff")
                ? "woff"
                : url.endsWith("otf")
                  ? "opentype"
                  : "truetype",
            style: face.fontStyle || "normal",
            weight: weight.parse(String(face.fontWeight || "400")),
            stretch: face.fontStretch || "normal",
            metadata: {
              copyright: attribution?.copyright || "",
              license: attribution?.license || "",
              licenseURL: attribution?.licenseURL || "",
              bundledTheme: theme.id,
            },
          });
        }
      }
  return [...families.values()]
    .filter((item) => item.faces.length)
    .sort((a, b) => a.name.localeCompare(b.name));
})();
export async function readFontLibrary(
  theme: string,
  database: Database = pool,
): Promise<LibraryFamily[]> {
  const [families, faces, active] = await Promise.all([
    database.query(
      "SELECT id,name,slug,source FROM font_families ORDER BY name,id",
    ),
    database.query(
      "SELECT id,family_id,url,format,style,weight,stretch,metadata FROM font_faces ORDER BY family_id,id",
    ),
    database.query("SELECT theme,family_id FROM theme_fonts ORDER BY theme"),
  ]);
  return families.rows.map((family) => ({
    ...family,
    active: active.rows.some(
      (item) => item.family_id === family.id && item.theme === theme,
    ),
    activeThemes: active.rows
      .filter((item) => item.family_id === family.id)
      .map((item) => item.theme),
    faces: faces.rows
      .filter((item) => item.family_id === family.id)
      .map(({ family_id: _family, ...face }) => face),
  }));
}
export async function injectFontLibrary(
  document: ThemeJSON,
  theme: string,
  database: Database = pool,
): Promise<ThemeJSON> {
  const families = (await readFontLibrary(theme, database)).filter(
    (family) => family.active,
  );
  if (!families.length) return document;
  const result = structuredClone(document),
    typography = ((result.settings ||= {}).typography ||= {});
  const names = new Set(
    (typography.fontFamilies || []).map(
      (family: ThemeJSON) => family.fontFamily,
    ),
  );
  typography.fontFamilies = [
    ...(typography.fontFamilies || []),
    ...families
      .filter((family) => !names.has(JSON.stringify(family.name)))
      .map((family) => ({
        name: family.name,
        slug: "worldact-font-" + family.id,
        fontFamily: JSON.stringify(family.name),
        fontFace: family.faces.map((face) => ({
          fontFamily: JSON.stringify(family.name),
          fontStyle: face.style,
          fontWeight: face.weight,
          fontStretch: face.stretch,
          src: [face.url],
        })),
      })),
  ];
  return result;
}
/** Keep style writes atomic with activation/removal and archive restoration. */
export async function withFontLibraryLock<T>(
  work: (database: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const database = await pool.connect();
  try {
    await database.query("BEGIN");
    await database.query(
      "SELECT pg_advisory_xact_lock(hashtext('worldact-font-library'))",
    );
    const value = await work(database);
    await database.query("COMMIT");
    return value;
  } catch (reason) {
    await database.query("ROLLBACK");
    throw reason;
  } finally {
    database.release();
  }
}
export async function validateFontChoices(
  styles: Record<string, unknown>,
  theme: string,
  database: Database = pool,
) {
  const choices = [styles.fontFamily, styles.headingFont].filter(
    (value): value is string => typeof value === "string",
  );
  const basic = new Set([
    "Manrope",
    "Inter",
    "Georgia",
    "System",
    "serif",
    "sans-serif",
  ]);
  if (choices.every((choice) => basic.has(choice))) return;
  const active = (await readFontLibrary(theme, database)).filter(
    (family) => family.active,
  );
  for (const choice of choices)
    if (!basic.has(choice) && !active.some((family) => family.name === choice))
      throw new HttpError(
        400,
        "Activate this font for the current theme before selecting it.",
      );
}
function slugFor(name: string) {
  return (
    name
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 120) || "font"
  );
}
async function cleanupStyleChoices(
  database: Database,
  name: string,
  theme?: string,
) {
  const condition = theme ? " AND theme=$2" : "",
    args = theme ? [name, theme] : [name];
  await database.query(
    `UPDATE theme_designs SET styles=CASE WHEN styles->>'fontFamily'=$1 THEN styles-'fontFamily' ELSE styles END WHERE styles->>'fontFamily'=$1${condition}`,
    args,
  );
  await database.query(
    `UPDATE theme_designs SET styles=CASE WHEN styles->>'headingFont'=$1 THEN styles-'headingFont' ELSE styles END WHERE styles->>'headingFont'=$1${condition}`,
    args,
  );
  if (!theme || theme === "classic")
    await database.query(
      "UPDATE site_styles SET data=(CASE WHEN data->>'fontFamily'=$1 THEN data-'fontFamily' ELSE data END) WHERE id=1",
      [name],
    );
  if (!theme || theme === "classic")
    await database.query(
      "UPDATE site_styles SET data=(CASE WHEN data->>'headingFont'=$1 THEN data-'headingFont' ELSE data END) WHERE id=1",
      [name],
    );
}
const router = Router();
router.use("/fonts", requireRole("administrator"));
router.get("/fonts", async (req, res) => {
  const theme = supportedThemes.parse(
    req.query.theme || (await getSettings()).theme,
  );
  res.json({
    theme,
    families: await readFontLibrary(theme),
    collection: bundledFontCollection.map(({ faces, ...family }) => ({
      ...family,
      faceCount: faces.length,
      faces,
    })),
  });
});
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_UPLOAD, files: 1, fields: 0 },
});
router.post("/fonts/upload", upload.single("file"), async (req, res) => {
  if (!req.file) throw new HttpError(400, "Choose a font file to upload.");
  const verified = await inspectFont(req.file.buffer),
    hash = createHash("sha256").update(req.file.buffer).digest("hex");
  const filename = `fonts/${randomBytes(24).toString("hex")}.${verified.extension}`;
  const db = await pool.connect();
  let written = false;
  try {
    await db.query("BEGIN");
    await db.query(
      "SELECT pg_advisory_xact_lock(hashtext('worldact-font-library'))",
    );
    if (
      (await db.query("SELECT id FROM font_faces WHERE sha256=$1", [hash]))
        .rowCount
    )
      throw new HttpError(409, "This font face is already installed.");
    if (
      Number(
        (await db.query("SELECT count(*)::int AS count FROM font_faces"))
          .rows[0].count,
      ) >= 800
    )
      throw new HttpError(400, "Install at most 800 font faces.");
    const name = verified.metadata.family;
    let family = (
      await db.query(
        "SELECT * FROM font_families WHERE lower(name)=lower($1)",
        [name],
      )
    ).rows[0];
    if (!family) {
      if (
        Number(
          (await db.query("SELECT count(*)::int AS count FROM font_families"))
            .rows[0].count,
        ) >= 200
      )
        throw new HttpError(400, "Install at most 200 font families.");
      family = (
        await db.query(
          "INSERT INTO font_families(name,slug,source) VALUES($1,$2,'upload') RETURNING *",
          [name, slugFor(name) + "-" + randomBytes(4).toString("hex")],
        )
      ).rows[0];
    }
    await mkdir(path.join(uploadsDir, "fonts"), { recursive: true });
    await writeFile(path.join(uploadsDir, filename), req.file.buffer, {
      flag: "wx",
    });
    written = true;
    await db.query(
      "INSERT INTO font_faces(family_id,filename,url,format,style,weight,stretch,sha256,metadata) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb)",
      [
        family.id,
        filename,
        "/uploads/" + filename,
        verified.format,
        verified.metadata.style,
        verified.metadata.weight,
        verified.metadata.stretch,
        hash,
        JSON.stringify(verified.metadata),
      ],
    );
    await db.query("COMMIT");
    res.status(201).json({
      family: (await readFontLibrary((await getSettings()).theme)).find(
        (item) => item.id === family.id,
      ),
    });
  } catch (error) {
    await db.query("ROLLBACK");
    if (written) await unlink(path.join(uploadsDir, filename)).catch(() => {});
    throw error;
  } finally {
    db.release();
  }
});
router.post("/fonts/install", async (req, res) => {
  const input = z
      .object({ collectionKey: z.string().max(160) })
      .strict()
      .parse(req.body),
    source = bundledFontCollection.find(
      (family) => family.key === input.collectionKey,
    );
  if (!source) throw new HttpError(404, "Bundled font family not found.");
  const db = await pool.connect();
  try {
    await db.query("BEGIN");
    await db.query(
      "SELECT pg_advisory_xact_lock(hashtext('worldact-font-library'))",
    );
    let family = (
      await db.query(
        "SELECT * FROM font_families WHERE lower(name)=lower($1)",
        [source.name],
      )
    ).rows[0];
    if (!family) {
      if (
        Number(
          (await db.query("SELECT count(*)::int AS count FROM font_families"))
            .rows[0].count,
        ) >= 200
      )
        throw new HttpError(400, "Install at most 200 font families.");
      family = (
        await db.query(
          "INSERT INTO font_families(name,slug,source,collection_key) VALUES($1,$2,'bundled',$3) RETURNING *",
          [
            source.name,
            slugFor(source.name) + "-" + randomBytes(4).toString("hex"),
            source.key,
          ],
        )
      ).rows[0];
    }
    for (const face of source.faces) {
      const buffer = await readFile(path.join(rootDir, "public", face.url));
      formatFor(buffer);
      const hash = createHash("sha256").update(buffer).digest("hex");
      if (
        (await db.query("SELECT id FROM font_faces WHERE sha256=$1", [hash]))
          .rowCount
      )
        continue;
      if (
        Number(
          (await db.query("SELECT count(*)::int AS count FROM font_faces"))
            .rows[0].count,
        ) >= 800
      )
        throw new HttpError(400, "Install at most 800 font faces.");
      await db.query(
        "INSERT INTO font_faces(family_id,url,format,style,weight,stretch,sha256,metadata) VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb) ON CONFLICT(family_id,sha256) DO NOTHING",
        [
          family.id,
          face.url,
          face.format,
          face.style,
          face.weight,
          face.stretch,
          createHash("sha256").update(buffer).digest("hex"),
          JSON.stringify(face.metadata),
        ],
      );
    }
    if (
      !(
        await db.query("SELECT id FROM font_faces WHERE family_id=$1", [
          family.id,
        ])
      ).rowCount
    )
      throw new HttpError(
        409,
        "These font faces are already installed under another family.",
      );
    await db.query("COMMIT");
    res.status(201).json({
      family: (await readFontLibrary((await getSettings()).theme)).find(
        (item) => item.id === family.id,
      ),
    });
  } catch (error) {
    await db.query("ROLLBACK");
    throw error;
  } finally {
    db.release();
  }
});
router.put("/fonts/:id/activation", async (req, res) => {
  const input = z
      .object({ theme: supportedThemes, active: z.boolean() })
      .strict()
      .parse(req.body),
    id = parseId(req.params.id);
  const db = await pool.connect();
  try {
    await db.query("BEGIN");
    await db.query(
      "SELECT pg_advisory_xact_lock(hashtext('worldact-font-library'))",
    );
    const family = (
      await db.query("SELECT name FROM font_families WHERE id=$1 FOR UPDATE", [
        id,
      ])
    ).rows[0];
    if (!family) throw new HttpError(404, "Font family not found.");
    if (input.active)
      await db.query(
        "INSERT INTO theme_fonts(theme,family_id) VALUES($1,$2) ON CONFLICT DO NOTHING",
        [input.theme, id],
      );
    else {
      await db.query(
        "DELETE FROM theme_fonts WHERE theme=$1 AND family_id=$2",
        [input.theme, id],
      );
      await cleanupStyleChoices(db, family.name, input.theme);
    }
    await db.query("COMMIT");
    res.json({
      family: (await readFontLibrary(input.theme)).find(
        (item) => item.id === id,
      ),
    });
  } catch (error) {
    await db.query("ROLLBACK");
    throw error;
  } finally {
    db.release();
  }
});
router.delete("/fonts/:id", async (req, res) => {
  const id = parseId(req.params.id),
    db = await pool.connect();
  let files: string[] = [];
  try {
    await db.query("BEGIN");
    await db.query(
      "SELECT pg_advisory_xact_lock(hashtext('worldact-font-library'))",
    );
    const family = (
      await db.query("SELECT name FROM font_families WHERE id=$1 FOR UPDATE", [
        id,
      ])
    ).rows[0];
    if (!family) throw new HttpError(404, "Font family not found.");
    files = (
      await db.query(
        "SELECT filename FROM font_faces WHERE family_id=$1 AND filename IS NOT NULL",
        [id],
      )
    ).rows
      .map((row) => row.filename)
      .filter((filename) =>
        /^fonts\/[a-f0-9]{48}\.(?:woff2?|ttf|otf)$/.test(filename),
      );
    await cleanupStyleChoices(db, family.name);
    await db.query("DELETE FROM font_families WHERE id=$1", [id]);
    await db.query("COMMIT");
  } catch (error) {
    await db.query("ROLLBACK");
    throw error;
  } finally {
    db.release();
  }
  await Promise.all(
    files.map((filename) =>
      unlink(path.join(uploadsDir, filename)).catch(
        (error: NodeJS.ErrnoException) => {
          if (error.code !== "ENOENT") throw error;
        },
      ),
    ),
  );
  res.json({ deleted: true });
});
router.use("/fonts", ((error, _req, res, next) => {
  if (error instanceof multer.MulterError) {
    res
      .status(error.code === "LIMIT_FILE_SIZE" ? 413 : 400)
      .json({
        error:
          error.code === "LIMIT_FILE_SIZE"
            ? "The font exceeds the 8 MiB upload limit."
            : "Upload one font file using the file field.",
      });
    return;
  }
  next(error);
}) satisfies ErrorRequestHandler);
export default router;
