import sharp, { type Metadata, type Sharp } from "sharp";
import { detectMediaType } from "./media-types.js";
import { HttpError } from "./utils.js";

const formats = {
  "image/jpeg": { format: "jpeg", decoder: "jpeg", extension: "jpg" },
  "image/png": { format: "png", decoder: "png", extension: "png" },
  "image/gif": { format: "gif", decoder: "gif", extension: "gif" },
  "image/webp": { format: "webp", decoder: "webp", extension: "webp" },
  "image/avif": { format: "avif", decoder: "heif", extension: "avif" },
} as const;
export type RasterOutput = typeof formats[keyof typeof formats] & {
  mimeType: keyof typeof formats;
  lossless: boolean;
};

/** Inspect only local verified bytes; no filename, request MIME, or codec fallback. */
export async function rasterOutput(buffer: Buffer, metadata?: Metadata): Promise<RasterOutput> {
  const signature = await detectMediaType(buffer).catch(() => undefined);
  const mimeType = signature?.mime as keyof typeof formats;
  const format = Object.hasOwn(formats, mimeType) ? formats[mimeType] : undefined;
  metadata ??= await sharp(buffer, { limitInputPixels: 80_000_000 }).metadata().catch(() => {
    throw new HttpError(400, "The image could not be decoded safely.");
  });
  if (!format || metadata.format !== format.decoder || !sharp.format[format.decoder].output.buffer) {
    throw new HttpError(400, "This image format cannot be edited safely on this server.");
  }
  return { ...format, mimeType, lossless: mimeType === "image/webp" && losslessWebP(buffer) };
}

/** RIFF's VP8L image payload identifies the source lossless WebP encoder mode. */
function losslessWebP(buffer: Buffer): boolean {
  if (buffer.length < 12 || buffer.toString("ascii", 0, 4) !== "RIFF" || buffer.toString("ascii", 8, 12) !== "WEBP") return false;
  const end = Math.min(buffer.length, buffer.readUInt32LE(4) + 8);
  for (let offset = 12; offset + 8 <= end;) {
    const type = buffer.toString("ascii", offset, offset + 4), length = buffer.readUInt32LE(offset + 4);
    if (length > end - offset - 8) return false;
    if (type === "VP8L") return true;
    if (type === "VP8 ") return false;
    offset += 8 + length + (length % 2);
  }
  return false;
}

/** Supplied WP image-editor defaults; codec implementations need not be byte-identical. */
export function encodeRaster(pipeline: Sharp, output: RasterOutput): Sharp {
  // Preserve color profiles while avoiding private EXIF/IPTC metadata copies.
  pipeline = pipeline.keepIccProfile();
  switch (output.format) {
    case "jpeg": return pipeline.jpeg({ quality: 82, progressive: false });
    case "png": return pipeline.png();
    case "gif": return pipeline.gif();
    case "webp": return pipeline.webp({ quality: 86, lossless: output.lossless });
    case "avif": return pipeline.avif({ quality: 82, effort: 2 });
  }
}
