import sharp from "sharp";
import path from "node:path";
import { mkdir, writeFile, unlink } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import type { Pool } from "pg";
import { pool, uploadsDir } from "./db.js";
import { HttpError } from "./utils.js";
import { rasterOutput, encodeRaster } from "./image-formats.js";
export type ImageSize = {
  filename: string;
  url: string;
  width: number;
  height: number;
  mimeType: string;
};
export function safeStoredFile(filename: unknown): filename is string {
  return (
    typeof filename === "string" &&
    !path.isAbsolute(filename) &&
    !filename.includes("\\") &&
    path.resolve(uploadsDir, filename).startsWith(uploadsDir + path.sep)
  );
}

/** Run after the deleting transaction commits. Archives can share physical files. */
export async function unlinkUnreferencedMediaFiles(
  candidates: Iterable<unknown>,
  database: Pick<Pool, "query"> = pool,
) {
  const files = [...new Set([...candidates].filter(safeStoredFile))];
  if (!files.length) return;
  const referenced = new Set<string>();
  try {
    // Read every batch before unlinking anything. A failed ownership check must
    // retain files, including those in earlier, successfully checked batches.
    for (let offset = 0; offset < files.length; offset += 256) {
      const result = await database.query<{ filename: string }>(
        `SELECT DISTINCT referenced.filename FROM (
          SELECT filename FROM media
          UNION ALL SELECT original_filename FROM media
          UNION ALL SELECT entry.value FROM media
            CROSS JOIN LATERAL jsonb_each_text(CASE WHEN jsonb_typeof(derivatives)='object' THEN derivatives ELSE '{}'::jsonb END) entry
          UNION ALL SELECT entry.value->>'filename' FROM media
            CROSS JOIN LATERAL jsonb_each(CASE WHEN jsonb_typeof(sizes)='object' THEN sizes ELSE '{}'::jsonb END) entry
        ) referenced WHERE referenced.filename=ANY($1::text[])`,
        [files.slice(offset, offset + 256)],
      );
      for (const row of result.rows) referenced.add(row.filename);
    }
  } catch {
    // The media deletion is already committed; a database outage must not turn
    // best-effort file cleanup into deletion of another attachment's bytes.
    return;
  }
  await Promise.all(
    files.filter(filename => !referenced.has(filename)).map(filename =>
      unlink(path.join(uploadsDir, filename)).catch(() => {}),
    ),
  );
}
export function uploadPrefix(settings: {
  uploadsYearMonth?: boolean;
  timezone?: string;
}) {
  if (!settings.uploadsYearMonth) return "";
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: settings.timezone || "UTC",
    year: "numeric",
    month: "2-digit",
  }).formatToParts(new Date());
  return `${parts.find((p) => p.type === "year")!.value}/${parts.find((p) => p.type === "month")!.value}/`;
}
export type ImageResizeGeometry = {
  left: number;
  top: number;
  cropWidth: number;
  cropHeight: number;
  width: number;
  height: number;
};
/** Supplied media.php image_resize_dimensions/wp_constrain_dimensions, no filters. */
export function imageResizeGeometry(
  originalWidth: number,
  originalHeight: number,
  maxWidth: number,
  maxHeight: number,
  crop = false,
): ImageResizeGeometry | null {
  if (
    ![originalWidth, originalHeight, maxWidth, maxHeight].every(Number.isInteger) ||
    originalWidth <= 0 || originalHeight <= 0 || maxWidth < 0 || maxHeight < 0 ||
    (!maxWidth && !maxHeight)
  ) return null;
  const wouldEnlarge = !maxHeight
    ? originalWidth < maxWidth
    : !maxWidth
      ? originalHeight < maxHeight
      : originalWidth < maxWidth && originalHeight < maxHeight;
  if (wouldEnlarge) return null;
  let width: number, height: number;
  let cropWidth = originalWidth, cropHeight = originalHeight, left = 0, top = 0;
  if (crop) {
    width = Math.min(maxWidth, originalWidth);
    height = Math.min(maxHeight, originalHeight);
    if (!width) width = Math.round(height * originalWidth / originalHeight);
    if (!height) height = Math.round(width * originalHeight / originalWidth);
    const ratio = Math.max(width / originalWidth, height / originalHeight);
    cropWidth = Math.round(width / ratio);
    cropHeight = Math.round(height / ratio);
    left = Math.floor((originalWidth - cropWidth) / 2);
    top = Math.floor((originalHeight - cropHeight) / 2);
  } else {
    const widthRatio = maxWidth > 0 && originalWidth > maxWidth ? maxWidth / originalWidth : 1;
    const heightRatio = maxHeight > 0 && originalHeight > maxHeight ? maxHeight / originalHeight : 1;
    const larger = Math.max(widthRatio, heightRatio), smaller = Math.min(widthRatio, heightRatio);
    const ratio = Math.round(originalWidth * larger) > maxWidth || Math.round(originalHeight * larger) > maxHeight
      ? smaller : larger;
    width = Math.max(1, Math.round(originalWidth * ratio));
    height = Math.max(1, Math.round(originalHeight * ratio));
    if (widthRatio < 1 && width === maxWidth - 1) width = maxWidth;
    if (heightRatio < 1 && height === maxHeight - 1) height = maxHeight;
  }
  // Extremely thin crops can round one side to zero; no usable intermediate
  // exists in that case, so retain the original instead of failing the upload.
  if (Math.min(width, height, cropWidth, cropHeight) < 1) return null;
  if (Math.abs(width - originalWidth) <= 1 && Math.abs(height - originalHeight) <= 1) return null;
  return { left, top, cropWidth, cropHeight, width, height };
}
export async function buildSizes(
  buffer: Buffer,
  prefix: string,
  settings: Record<string, any>,
) {
  const result: Record<string, ImageSize> = {};
  const metadata = await sharp(buffer, { limitInputPixels: 80_000_000 }).metadata();
  const output = await rasterOutput(buffer, metadata);
  // Geometry uses the same automatic EXIF orientation applied by the pipeline.
  const swapped = metadata.orientation !== undefined && metadata.orientation >= 5 && metadata.orientation <= 8;
  const originalWidth = swapped ? metadata.height : metadata.width;
  const originalHeight = swapped ? metadata.width : metadata.height;
  if (!originalWidth || !originalHeight) throw new HttpError(400, "The image could not be decoded.");
  await mkdir(path.join(uploadsDir, prefix), { recursive: true });
  try {
    for (const [name, w, h, crop] of [
      [
        "thumbnail",
        settings.thumbnailWidth ?? 150,
        settings.thumbnailHeight ?? 150,
        settings.thumbnailCrop !== false,
      ],
      [
        "medium",
        settings.mediumWidth ?? 300,
        settings.mediumHeight ?? 300,
        false,
      ],
      [
        "large",
        settings.largeWidth ?? 1024,
        settings.largeHeight ?? 1024,
        false,
      ],
    ] as const) {
      const maximum = name === "thumbnail" ? 4096 : 8192;
      if (![w, h].every(value => typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= maximum)) {
        throw new HttpError(400, "Image size dimensions must be whole numbers within the supported range.");
      }
      const geometry = imageResizeGeometry(originalWidth, originalHeight, w, h, crop);
      if (!geometry) continue;
      const pipeline = sharp(buffer, {
        limitInputPixels: 80_000_000,
      })
        .rotate()
        .extract({ left: geometry.left, top: geometry.top, width: geometry.cropWidth, height: geometry.cropHeight })
        .resize({
          width: geometry.width,
          height: geometry.height,
          fit: "fill",
          withoutEnlargement: true,
        });
      const { data, info } = await encodeRaster(pipeline, output).toBuffer({ resolveWithObject: true });
      const filename = `${prefix}${randomBytes(20).toString("hex")}-${info.width}x${info.height}.${output.extension}`;
      await writeFile(path.join(uploadsDir, filename), data, { flag: "wx" });
      result[name] = {
        filename,
        url: `/uploads/${filename}`,
        width: info.width,
        height: info.height,
        mimeType: output.mimeType,
      };
    }
    // With all sizes disabled or unchanged, no encoder has decoded the pixels.
    // Header-only metadata must not allow a truncated tiny image to be stored.
    if (!Object.keys(result).length) await sharp(buffer, { limitInputPixels: 80_000_000 }).stats();
    return result;
  } catch (error) {
    await Promise.all(
      Object.values(result).map((item) =>
        unlink(path.join(uploadsDir, item.filename)).catch(() => {}),
      ),
    );
    throw error;
  }
}
export function mediaBackups(item: any) {
  return {
    ...item.derivatives,
    ...Object.fromEntries(
      Object.entries(item.sizes || {}).map(([key, value]) => [
        `size-${key}-${randomBytes(6).toString("hex")}`,
        (value as ImageSize).filename,
      ]),
    ),
  };
}
