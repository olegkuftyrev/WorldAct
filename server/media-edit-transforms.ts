import sharp from "sharp";
import { z } from "zod";
import { rasterOutput, encodeRaster } from "./image-formats.js";
import { HttpError } from "./utils.js";

const percent = z.number().min(0).max(100);
const flip = z.object({ horizontal: z.boolean(), vertical: z.boolean() }).strict();
export const mediaModifierSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("rotate"), args: z.object({ angle: z.number() }).strict() }).strict(),
  z.object({ type: z.literal("flip"), args: z.object({ flip }).strict() }).strict(),
  z.object({ type: z.literal("crop"), args: z.object({
    left: percent, top: percent, width: percent.gt(0), height: percent.gt(0),
  }).strict() }).strict(),
]);
export type MediaModifier = z.infer<typeof mediaModifierSchema>;
export const mediaEditCopySchema = z.object({
  src: z.string().min(1).max(2000),
  modifiers: z.array(mediaModifierSchema).min(1).max(8).optional(),
  flip: flip.partial().optional(),
  rotation: z.number().int().gt(0).lt(360).optional(),
  x: percent.optional(), y: percent.optional(),
  width: percent.gt(0).optional(), height: percent.gt(0).optional(),
  title: z.string().trim().min(1).max(300).optional(),
  caption: z.string().max(20_000).optional(),
  description: z.string().max(20_000).optional(),
  alt_text: z.string().max(1000).optional(),
  post: z.number().int().min(0).max(2147483647).optional(),
  comment_status: z.enum(["open", "closed"]).optional(),
}).strict();
export type MediaEditCopy = z.infer<typeof mediaEditCopySchema>;

/** Fixed source operators only. The current modifiers array takes precedence. */
export function mediaEditModifiers(input: MediaEditCopy): MediaModifier[] {
  if (input.modifiers) return input.modifiers;
  const modifiers: MediaModifier[] = [];
  if (input.flip && Object.keys(input.flip).length) modifiers.push({
    type: "flip", args: { flip: { horizontal: input.flip.horizontal ?? false, vertical: input.flip.vertical ?? false } },
  });
  if (input.rotation) modifiers.push({ type: "rotate", args: { angle: input.rotation } });
  const crop = [input.x, input.y, input.width, input.height];
  if (crop.some(value => value !== undefined)) {
    if (crop.some(value => value === undefined)) throw new HttpError(400, "Provide every crop dimension.");
    modifiers.push({ type: "crop", args: { left: input.x!, top: input.y!, width: input.width!, height: input.height! } });
  }
  if (!modifiers.length) throw new HttpError(400, "Edit the image before applying the changes.");
  return modifiers;
}

const MAX_PIXELS = 80_000_000;
function checkFrame(width: number, height: number) {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width * height > MAX_PIXELS) {
    throw new HttpError(400, "The requested image dimensions are invalid or too large.");
  }
}

/**
 * Execute each operator in order. Sharp coalesces repeated rotate/extract calls,
 * so use lossless, profile-preserving PNG frames between source operations and
 * encode the chosen final format only once. Never execute request code or URLs.
 */
export async function applyMediaModifiers(buffer: Buffer, modifiers: MediaModifier[]) {
  if (!buffer.length || buffer.length > 32 * 1024 * 1024) throw new HttpError(413, "The image exceeds the editing size limit.");
  if (!modifiers.length || modifiers.length > 8) throw new HttpError(400, "Choose between one and eight image edits.");
  // Revalidate internal callers too; typed values do not establish trust.
  modifiers = z.array(mediaModifierSchema).min(1).max(8).parse(modifiers);
  try {
    const metadata = await sharp(buffer, { limitInputPixels: MAX_PIXELS }).metadata();
    const output = await rasterOutput(buffer, metadata);
    if (!metadata.width || !metadata.height) throw new HttpError(400, "The image could not be decoded.");
    checkFrame(metadata.width, metadata.height);
    let pipeline = sharp(buffer, { limitInputPixels: MAX_PIXELS });
    // Supplied maybe_exif_rotate() applies only to JPEG images.
    if (output.mimeType === "image/jpeg" && metadata.orientation && metadata.orientation >= 2 && metadata.orientation <= 8) pipeline = pipeline.autoOrient();
    let frame = await pipeline.keepIccProfile().png().toBuffer({ resolveWithObject: true });
    for (const modifier of modifiers) {
      const { width, height } = frame.info;
      checkFrame(width, height);
      let edit = sharp(frame.data, { limitInputPixels: MAX_PIXELS });
      if (modifier.type === "rotate") {
        const angle = ((modifier.args.angle % 360) + 360) % 360;
        const radians = angle * Math.PI / 180;
        // Check an upper bound before allocating a rotated frame.
        const cosine = Math.abs(Math.cos(radians)), sine = Math.abs(Math.sin(radians));
        checkFrame(Math.max(1, Math.ceil(width * cosine + height * sine - 1e-9)), Math.max(1, Math.ceil(width * sine + height * cosine - 1e-9)));
        edit = edit.rotate(angle, { background: { r: 0, g: 0, b: 0, alpha: 0 } });
      } else if (modifier.type === "flip") {
        if (modifier.args.flip.horizontal) edit = edit.flop();
        if (modifier.args.flip.vertical) edit = edit.flip();
      } else {
        const left = Math.round(width * modifier.args.left / 100), top = Math.round(height * modifier.args.top / 100);
        const cropWidth = Math.round(width * modifier.args.width / 100), cropHeight = Math.round(height * modifier.args.height / 100);
        checkFrame(cropWidth, cropHeight);
        if (left + cropWidth > width || top + cropHeight > height) throw new HttpError(400, "The requested crop is outside the image.");
        edit = edit.extract({ left, top, width: cropWidth, height: cropHeight });
      }
      frame = await edit.keepIccProfile().png().toBuffer({ resolveWithObject: true });
      checkFrame(frame.info.width, frame.info.height);
    }
    const result = await encodeRaster(sharp(frame.data, { limitInputPixels: MAX_PIXELS }), output).toBuffer({ resolveWithObject: true });
    if (result.data.length > 32 * 1024 * 1024) throw new HttpError(413, "The edited image exceeds the upload size limit.");
    return { ...result, output };
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(400, "The requested image edits could not be applied.");
  }
}
