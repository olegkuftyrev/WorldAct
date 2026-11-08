import { test } from "./isolated-test.js";
import assert from "node:assert/strict";
import sharp from "sharp";
import { applyMediaModifiers, mediaEditCopySchema, mediaEditModifiers, type MediaModifier } from "../server/media-edit-transforms.js";

async function matrixImage() {
  const values = Array.from({ length: 24 }, (_, index) => index + 1);
  const data = Buffer.from(values.flatMap(value => [value * 8, 0, 0, 255]));
  return sharp(data, { raw: { width: 6, height: 4, channels: 4 } }).png().toBuffer();
}
async function matrix(buffer: Buffer) {
  const { data, info } = await sharp(buffer).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return { width: info.width, height: info.height, values: Array.from({ length: info.width * info.height }, (_, index) => data[index * 4] / 8) };
}
const rotation = (angle: number): MediaModifier => ({ type: "rotate", args: { angle } });
const crop = (left: number, top: number, width: number, height: number): MediaModifier => ({ type: "crop", args: { left, top, width, height } });

test("native transforms retain ordered repeated rotations and crop in the current frame", async () => {
  const source = await matrixImage();
  const twice = await applyMediaModifiers(source, [rotation(90), rotation(90)]);
  assert.deepEqual(await matrix(twice.data), { width: 6, height: 4, values: Array.from({ length: 24 }, (_, index) => 24 - index) });
  const rotatedCrop = await applyMediaModifiers(source, [rotation(90), crop(25, 0, 50, 50)]);
  assert.deepEqual(await matrix(rotatedCrop.data), { width: 2, height: 3, values: [13, 7, 14, 8, 15, 9] });
  const cropRotated = await applyMediaModifiers(source, [crop(0, 25, 50, 50), rotation(90)]);
  assert.deepEqual(await matrix(cropRotated.data), { width: 2, height: 3, values: [13, 7, 14, 8, 15, 9] });
  const differentCrop = await applyMediaModifiers(source, [crop(25, 0, 50, 50), rotation(90)]);
  assert.deepEqual(await matrix(differentCrop.data), { width: 2, height: 3, values: [9, 3, 10, 4, 11, 5] });
});

test("native flips and repeated crops operate on their immediate predecessor", async () => {
  const source = await matrixImage();
  const result = await applyMediaModifiers(source, [
    crop(0, 0, 50, 100), crop(0, 50, 100, 50),
    { type: "flip", args: { flip: { horizontal: true, vertical: true } } },
  ]);
  assert.deepEqual(await matrix(result.data), { width: 3, height: 2, values: [21, 20, 19, 15, 14, 13] });
  const reversed = await applyMediaModifiers(source, [rotation(-90), rotation(450)]);
  assert.deepEqual(await matrix(reversed.data), await matrix(source));
});

test("native modifier requests validate fixed operators, precedence and legacy completeness", () => {
  const input = mediaEditCopySchema.parse({ src: "/uploads/known.png", modifiers: [rotation(90)], rotation: 180, x: 2 });
  assert.deepEqual(mediaEditModifiers(input), [rotation(90)]);
  const legacy = mediaEditCopySchema.parse({ src: "/uploads/known.png", flip: { horizontal: true }, rotation: 90, x: 0, y: 0, width: 50, height: 100 });
  assert.deepEqual(mediaEditModifiers(legacy), [
    { type: "flip", args: { flip: { horizontal: true, vertical: false } } }, rotation(90), crop(0, 0, 50, 100),
  ]);
  assert.throws(() => mediaEditModifiers(mediaEditCopySchema.parse({ src: "/uploads/known.png", x: 0 })));
  assert.throws(() => mediaEditModifiers(mediaEditCopySchema.parse({ src: "/uploads/known.png" })));
  for (const modifiers of [[{ type: "exec", args: { command: "ignored" } }], [rotation(Infinity)], [crop(-1, 0, 20, 20)], [crop(0, 0, 0, 20)], Array.from({ length: 9 }, () => rotation(90))]) {
    assert.equal(mediaEditCopySchema.safeParse({ src: "/uploads/known.png", modifiers }).success, false);
  }
});

test("native crops reject unusable or out-of-frame pixels and corrupt input", async () => {
  const source = await matrixImage();
  for (const modifier of [crop(90, 0, 50, 50), crop(0, 0, 0.01, 50), crop(0, 100, 50, 50)]) {
    await assert.rejects(applyMediaModifiers(source, [modifier]), /dimensions|outside/);
  }
  await assert.rejects(applyMediaModifiers(Buffer.from("not an image"), [rotation(90)]), /could not be applied|format/);
  await assert.rejects(applyMediaModifiers(source, []), /one and eight/);
  const fractional = await applyMediaModifiers(source, [rotation(45)]);
  const metadata = await sharp(fractional.data).metadata();
  assert.ok(metadata.width! > 6 && metadata.height! > 4);
  assert.equal(metadata.hasAlpha, true);
});

test("native edits preserve final codecs, transparency, profiles and JPEG-only EXIF orientation", async () => {
  const source = await matrixImage();
  for (const format of ["jpeg", "png", "gif", "webp", "avif"] as const) {
    const encoded = await sharp(source).toFormat(format).toBuffer();
    const result = await applyMediaModifiers(encoded, [rotation(90)]);
    assert.equal(result.output.format, format);
    const metadata = await sharp(result.data).metadata();
    assert.equal(metadata.width, 4); assert.equal(metadata.height, 6);
    assert.equal(metadata.format, format === "avif" ? "heif" : format);
  }
  const jpeg = await sharp(source).jpeg().withMetadata({ orientation: 6 }).toBuffer();
  const jpegEdited = await applyMediaModifiers(jpeg, [rotation(90)]);
  assert.equal(jpegEdited.info.width, 6); assert.equal(jpegEdited.info.height, 4);
  assert.equal((await sharp(jpegEdited.data).metadata()).orientation, undefined);
  const png = await sharp(source).png().withMetadata({ orientation: 6 }).toBuffer();
  assert.equal((await sharp(png).metadata()).orientation, 6);
  const pngEdited = await applyMediaModifiers(png, [rotation(90)]);
  assert.equal(pngEdited.info.width, 4); assert.equal(pngEdited.info.height, 6);
  assert.ok((await sharp(pngEdited.data).metadata()).icc);
  assert.equal((await sharp(pngEdited.data).metadata()).exif, undefined);
  const transparent = await sharp({ create: { width: 4, height: 2, channels: 4, background: { r: 255, g: 0, b: 0, alpha: 0.25 } } }).webp({ lossless: true }).toBuffer();
  const alpha = await applyMediaModifiers(transparent, [rotation(90)]);
  assert.equal(alpha.output.lossless, true);
  const { data } = await sharp(alpha.data).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  assert.ok(data[3] >= 63 && data[3] <= 64);
});
