import sharp from "sharp";
import { randomBytes } from "node:crypto";
import { buildSizes, imageResizeGeometry, writeNewMediaFile, cleanupStagedMediaFiles } from "./media-files.js";
import { rasterOutput, encodeRaster, jpegAutoOrientation } from "./image-formats.js";
import { HttpError } from "./utils.js";

/** Supplied wp_create_image_subsizes(): normalize full, derive sizes from raw. */
export async function stageImageUpload(buffer: Buffer, rawFilename: string, prefix: string, settings: Record<string, any>, owned: Set<string>) {
  try {
    const metadata = await sharp(buffer, { limitInputPixels: 80_000_000 }).metadata();
    if (!metadata.width || !metadata.height) throw new HttpError(400, "The image could not be decoded.");
    const output = await rasterOutput(buffer, metadata), orient = jpegAutoOrientation(metadata, output);
    const swapped = orient && metadata.orientation! >= 5;
    const orientedWidth = swapped ? metadata.height : metadata.width, orientedHeight = swapped ? metadata.width : metadata.height;
    const scale = metadata.width > 2560 || metadata.height > 2560;
    const geometry = scale ? imageResizeGeometry(orientedWidth, orientedHeight, 2560, 2560) : null;
    // Source resize can decline an effectively unchanged one-pixel difference.
    const normalize = scale ? geometry !== null : orient;
    const sizes = await buildSizes(buffer, prefix, settings);
    Object.values(sizes).forEach(size => owned.add(size.filename));
    await writeNewMediaFile(rawFilename, buffer, owned);
    if (!normalize) return { filename: rawFilename, mimeType: output.mimeType, size: buffer.length, width: metadata.width, height: metadata.height, sizes, derivatives: {} as Record<string, string> };
    let pipeline = sharp(buffer, { limitInputPixels: 80_000_000 });
    if (orient) pipeline = pipeline.autoOrient();
    if (geometry) pipeline = pipeline.resize({ width: geometry.width, height: geometry.height, fit: "fill", withoutEnlargement: true });
    const { data, info } = await encodeRaster(pipeline, output).toBuffer({ resolveWithObject: true });
    const filename = `${prefix}${randomBytes(20).toString("hex")}-${scale ? "scaled" : "rotated"}.${output.extension}`;
    await writeNewMediaFile(filename, data, owned);
    return { filename, mimeType: output.mimeType, size: data.length, width: info.width, height: info.height, sizes, derivatives: { "original-upload": rawFilename } };
  } catch (error) {
    await cleanupStagedMediaFiles(owned);
    throw error;
  }
}
