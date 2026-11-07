import sharp from "sharp";
import path from "node:path";
import { mkdir, writeFile, unlink } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { uploadsDir } from "./db.js";
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
export async function buildSizes(
  buffer: Buffer,
  prefix: string,
  settings: Record<string, any>,
) {
  const result: Record<string, ImageSize> = {};
  await mkdir(path.join(uploadsDir, prefix), { recursive: true });
  try {
    for (const [name, w, h, crop] of [
      [
        "thumbnail",
        settings.thumbnailWidth || 150,
        settings.thumbnailHeight || 150,
        settings.thumbnailCrop !== false,
      ],
      [
        "medium",
        settings.mediumWidth || 300,
        settings.mediumHeight || 300,
        false,
      ],
      [
        "large",
        settings.largeWidth || 1024,
        settings.largeHeight || 1024,
        false,
      ],
    ] as const) {
      const { data, info } = await sharp(buffer, {
        limitInputPixels: 80_000_000,
      })
        .rotate()
        .resize({
          width: w,
          height: h,
          fit: crop ? "cover" : "inside",
          withoutEnlargement: true,
        })
        .png()
        .toBuffer({ resolveWithObject: true });
      const filename = `${prefix}${randomBytes(20).toString("hex")}-${info.width}x${info.height}.png`;
      await writeFile(path.join(uploadsDir, filename), data, { flag: "wx" });
      result[name] = {
        filename,
        url: `/uploads/${filename}`,
        width: info.width,
        height: info.height,
        mimeType: "image/png",
      };
    }
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
