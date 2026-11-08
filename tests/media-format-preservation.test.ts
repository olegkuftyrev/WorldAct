import test, { after } from "./isolated-test.js";
import "dotenv/config";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdir, readFile, writeFile, unlink } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { detectMediaType } from "../server/media-types.js";
import { rasterOutput, encodeRaster } from "../server/image-formats.js";
import { buildSizes } from "../server/media-files.js";
import { pool, uploadsDir } from "../server/db.js";

after(() => pool.end());
const base = process.env.TEST_API_URL!, origin = process.env.APP_ORIGIN!;
const formats = [
  { name: "jpeg", mime: "image/jpeg", ext: "jpg", alpha: false },
  { name: "png", mime: "image/png", ext: "png", alpha: true },
  { name: "webp", mime: "image/webp", ext: "webp", alpha: true },
  { name: "avif", mime: "image/avif", ext: "avif", alpha: true },
  { name: "gif", mime: "image/gif", ext: "gif", alpha: true },
] as const;
type Format = typeof formats[number];
const sha = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const shape = (value: any) => ({ width: value.width, height: value.height });
const inventory = async () => (await readdir(uploadsDir, { recursive: true, withFileTypes: true })).filter(item => item.isFile()).map(item => path.join(item.parentPath, item.name)).sort();
const filenames = (row: any): string[] => [...new Set<string>([row.filename, row.original_filename, ...Object.values(row.derivatives || {}), ...Object.values(row.sizes || {}).map((size: any) => size.filename)].filter((value): value is string => typeof value === "string"))];
async function sample(format: Format, width = 600, height = 400, lossless = false) {
  const rgba = Buffer.alloc(width * height * 4);
  for (let i = 0; i < width * height; i++) { const x = i % width, y = Math.floor(i / width); rgba[i * 4] = x < width / 2 ? 210 : 20; rgba[i * 4 + 1] = y < height / 2 ? 50 : 180; rgba[i * 4 + 2] = 110; rgba[i * 4 + 3] = x < width / 4 ? 0 : 255; }
  const image = sharp(rgba, { raw: { width, height, channels: 4 } });
  switch (format.name) {
    case "jpeg": return image.jpeg({ quality: 95 }).toBuffer();
    case "png": return image.png().toBuffer();
    case "webp": return image.webp({ quality: 90, lossless }).toBuffer();
    case "avif": return image.avif({ quality: 90, effort: 1 }).toBuffer();
    case "gif": return image.gif().toBuffer();
  }
}
async function verified(bytes: Buffer, format: Format, size?: { width: number; height: number }) {
  const signature = await detectMediaType(bytes), metadata = await sharp(bytes).metadata();
  assert.equal(signature?.mime, format.mime); assert.equal(signature?.ext, format.ext); assert.equal(metadata.format, format.name === "avif" ? "heif" : format.name);
  if (size) assert.deepEqual(shape(metadata), size);
  assert.equal(Boolean(metadata.hasAlpha), format.alpha);
  assert.ok(!metadata.orientation || metadata.orientation === 1, "Derived bytes cannot carry a stale EXIF rotation");
  assert.equal(metadata.exif, undefined, "Derived output does not copy private source EXIF data");
  if (format.alpha) { const rgba = await sharp(bytes).ensureAlpha().raw().toBuffer(); assert.equal(rgba[3], 0, "Transparent source pixels remain transparent"); }
  return metadata;
}

test("generated sub-sizes preserve verified raster signatures, alpha, first-frame and lossless encoding semantics", async () => {
  const owned = new Set<string>();
  try {
    for (const format of formats) {
      const bytes = await sample(format), sizes = await buildSizes(bytes, "", { thumbnailWidth: 120, thumbnailHeight: 0, mediumWidth: 0, mediumHeight: 100, largeWidth: 300, largeHeight: 0 });
      assert.equal(Object.keys(sizes).length, 3);
      for (const [name, size] of Object.entries(sizes)) { owned.add(size.filename); assert.equal(size.mimeType, format.mime); assert.ok(size.filename.endsWith("." + format.ext)); await verified(await readFile(path.join(uploadsDir, size.filename)), format, name === "thumbnail" ? { width: 120, height: 80 } : name === "medium" ? { width: 150, height: 100 } : { width: 300, height: 200 }); }
    }
    const webp = formats.find(format => format.name === "webp")!, lossless = await sample(webp, 200, 120, true), output = await rasterOutput(lossless);
    assert.equal(output.lossless, true); assert.equal((await rasterOutput(await sample(webp))).lossless, false);
    const encoded = await encodeRaster(sharp(lossless), output).toBuffer(); assert.equal((await rasterOutput(encoded)).lossless, true);
    assert.deepEqual(await sharp(encoded).ensureAlpha().raw().toBuffer(), await sharp(lossless).ensureAlpha().raw().toBuffer());
    const animated = await sharp(Buffer.concat([Buffer.alloc(100 * 60 * 4, 100), Buffer.alloc(100 * 60 * 4, 255)]), { raw: { width: 100, height: 120, channels: 4, pageHeight: 60 } }).gif({ delay: [100, 100], loop: 0 }).toBuffer();
    assert.equal((await sharp(animated, { animated: true }).metadata()).pages, 2);
    const single = await buildSizes(animated, "", { thumbnailWidth: 50, thumbnailHeight: 0, mediumWidth: 0, mediumHeight: 0, largeWidth: 0, largeHeight: 0 }); owned.add(single.thumbnail.filename);
    const first = await sharp(await readFile(path.join(uploadsDir, single.thumbnail.filename)), { animated: true }).metadata(); assert.equal(first.pages || 1, 1); assert.deepEqual(shape(first), { width: 50, height: 30 });
    const before = await inventory();
    await assert.rejects(buildSizes(await sharp(await sample(formats[1])).tiff().toBuffer(), "", {}), /cannot be edited safely/);
    await assert.rejects(rasterOutput(Buffer.from("<svg xmlns='http://www.w3.org/2000/svg' width='2' height='2'/>")), /cannot be edited safely/);
    assert.deepEqual(await inventory(), before, "Unsupported formats produce no conversion files");
  } finally { await Promise.all([...owned].map(filename => unlink(path.join(uploadsDir, filename)).catch(() => {}))); }
});

function client() {
  let cookie = "";
  const request = async (url: string, method = "GET", body?: unknown, auth = cookie) => {
    const response = await fetch(base + url, { method, headers: { Origin: origin, "Content-Type": "application/json", ...(auth ? { Cookie: auth } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }); return { response, data: await response.json() };
  };
  const ok = async (url: string, method = "GET", body?: unknown, auth = cookie) => { const result = await request(url, method, body, auth); assert.ok(result.response.ok, `${url}: ${result.response.status} ${JSON.stringify(result.data)}`); return result.data; };
  return {
    request, ok,
    async login() { const result = await request("/api/auth/login", "POST", { login: process.env.ADMIN_EMAIL, password: process.env.ADMIN_PASSWORD }); assert.equal(result.response.status, 200); cookie = result.response.headers.get("set-cookie")!.split(";")[0]; return result; },
    async upload(bytes: Buffer, filename = "misleading.png") { const form = new FormData(); form.append("file", new Blob([new Uint8Array(bytes)], { type: "image/png" }), filename); const response = await fetch(base + "/api/media", { method: "POST", headers: { Origin: origin, Cookie: cookie }, body: form }); const data = await response.json(); assert.equal(response.status, 201, JSON.stringify(data)); return data.media; },
  };
}
const fetchBytes = async (url: string) => { const response = await fetch(base + url); assert.equal(response.status, 200, url); return Buffer.from(await response.arrayBuffer()); };

test("omitted image sizes and archive copies still require complete pixel decoding", async () => {
  const api = client(), valid = await sample(formats[0], 8, 8), scan = valid.indexOf(Buffer.from([0xff, 0xda]));
  const broken = valid.subarray(0, scan + 2 + valid.readUInt16BE(scan + 2));
  assert.equal((await sharp(broken).metadata()).width, 8, "The malformed fixture has valid header dimensions");
  await assert.rejects(sharp(broken).stats(), "It cannot decode a complete pixel image");
  const beforeSettings = (await pool.query("SELECT data FROM settings WHERE id=1")).rows[0].data;
  let image: any;
  try {
    const signed = await api.login(), cookie = signed.response.headers.get("set-cookie")!.split(";")[0];
    for (const disabled of [false, true]) {
      if (disabled) await api.ok("/api/settings", "PUT", { thumbnailWidth: 0, thumbnailHeight: 0, mediumWidth: 0, mediumHeight: 0, largeWidth: 0, largeHeight: 0 });
      const before = await inventory(), count = (await pool.query("SELECT count(*)::int AS count FROM media")).rows[0].count;
      const form = new FormData(); form.append("file", new Blob([new Uint8Array(broken)], { type: "image/jpeg" }), "truncated-tiny.jpg");
      assert.equal((await fetch(base + "/api/media", { method: "POST", headers: { Origin: origin, Cookie: cookie }, body: form })).status, 400);
      assert.deepEqual(await inventory(), before); assert.equal((await pool.query("SELECT count(*)::int AS count FROM media")).rows[0].count, count);
    }
    image = await api.upload(valid); assert.deepEqual(image.sizes, {});
    const archive = await api.ok("/api/tools/export"), record = archive.media.find((row: any) => row.id === image.id), good = archive.mediaFiles.find((file: any) => file.filename === image.filename);
    const bad = { filename: "truncated.jpg", mimeType: "image/jpeg", size: broken.length, sha256: sha(broken), data: broken.toString("base64") };
    const before = await inventory(), count = (await pool.query("SELECT count(*)::int AS count FROM media")).rows[0].count;
    for (const [media, mediaFiles] of [
      [[{ ...record, filename: bad.filename }], [bad]],
      [[{ ...record, sizes: { thumbnail: { filename: bad.filename, width: 8, height: 8 } } }], [good, bad]],
    ]) {
      const rejected = await api.request("/api/tools/import", "POST", { application: "WorldAct", version: 3, posts: [], media, mediaFiles });
      assert.equal(rejected.response.status, 400); assert.match(rejected.data.error, /image.*decoded/);
      assert.deepEqual(await inventory(), before); assert.equal((await pool.query("SELECT count(*)::int AS count FROM media")).rows[0].count, count);
    }
    await writeFile(path.join(uploadsDir, image.filename), broken);
    try {
      const rejected = await api.request("/api/tools/import", "POST", { application: "WorldAct", version: 2, posts: [], media: [record] }); assert.equal(rejected.response.status, 400); assert.match(rejected.data.error, /image.*decoded/);
      assert.deepEqual(await inventory(), before); assert.equal((await pool.query("SELECT count(*)::int AS count FROM media")).rows[0].count, count);
    } finally { await writeFile(path.join(uploadsDir, image.filename), valid); }
  } finally {
    if (image) await api.ok(`/api/media/${image.id}`, "DELETE");
    await pool.query("UPDATE settings SET data=$1::jsonb WHERE id=1", [JSON.stringify(beforeSettings)]); await api.ok("/api/auth/logout", "POST", {});
  }
});

test("native API upload/edit/crop/scale/restore retain each actual image format and previous URLs", async () => {
  const api = client(), ids = new Set<number>(); let otherId = 0;
  const settingsBefore = (await pool.query("SELECT data FROM settings WHERE id=1")).rows[0].data;
  try {
    await api.login(); await api.ok("/api/settings", "PUT", { thumbnailWidth: 80, thumbnailHeight: 0, mediumWidth: 0, mediumHeight: 60, largeWidth: 200, largeHeight: 0 });
    for (const format of formats) {
      const original = await sample(format), image = await api.upload(original); ids.add(image.id);
      assert.equal(image.mimeType, format.mime); assert.ok(image.filename.endsWith("." + format.ext)); assert.deepEqual(await fetchBytes(image.url), original);
      for (const size of Object.values(image.sizes) as any[]) { assert.equal(size.mimeType, format.mime); await verified(await fetchBytes(size.url), format, shape(size)); }
      if (format.name === "jpeg") await pool.query("UPDATE media SET mime_type='image/png' WHERE id=$1", [image.id]);
      const edited = (await api.ok(`/api/media/${image.id}/edit`, "POST", { rotate: 90, width: 200 })).media;
      assert.equal(edited.mimeType, format.mime); assert.ok(edited.filename.endsWith("." + format.ext)); assert.deepEqual(shape(edited), { width: 200, height: 300 });
      await verified(await fetchBytes(edited.url), format, shape(edited));
      const cropped = (await api.ok(`/api/media/${image.id}/edit`, "POST", { crop: { left: 0, top: 0, width: 100, height: 150 } })).media;
      assert.equal(cropped.mimeType, format.mime); assert.deepEqual(shape(cropped), { width: 100, height: 150 }); await verified(await fetchBytes(cropped.url), format, shape(cropped));
      const native = await api.ok(`/wp-json/wp/v2/media/${image.id}`); assert.equal(native.mime_type, format.mime); assert.equal(native.media_details.sizes.full.mime_type, format.mime);
      for (const size of Object.values(native.media_details.sizes) as any[]) assert.equal(size.mime_type, format.mime);
      const restored = (await api.ok(`/api/media/${image.id}/restore`, "POST", {})).media; assert.equal(restored.filename, image.filename); assert.equal(restored.mimeType, format.mime); assert.deepEqual(await fetchBytes(restored.url), original);
      const history = new Set([image.url, edited.url, cropped.url, ...[image, edited, cropped, restored].flatMap(item => Object.values(item.sizes).map((size: any) => size.url))]);
      for (const url of history) assert.equal((await fetch(base + url)).status, 200);
      await api.ok(`/api/media/${image.id}`, "DELETE"); ids.delete(image.id); for (const url of history) assert.equal((await fetch(base + url)).status, 404, url);
    }
    const jpeg = formats[0], oriented = await sharp(await sample(jpeg)).withMetadata({ orientation: 6 }).jpeg().toBuffer(), image = await api.upload(oriented); ids.add(image.id);
    assert.deepEqual(shape(image.sizes.medium), { width: 40, height: 60 });
    const edited = (await api.ok(`/api/media/${image.id}/edit`, "POST", { rotate: 90 })).media; assert.deepEqual(shape(edited), { width: 600, height: 400 }); await verified(await fetchBytes(edited.url), jpeg, shape(edited));
    assert.deepEqual((await sharp(await fetchBytes(edited.url)).metadata()).icc, (await sharp(oriented).metadata()).icc);
    assert.deepEqual(await fetchBytes((await api.ok(`/api/media/${image.id}/restore`, "POST", {})).media.url), oriented);
    const orientedCrop = (await api.ok(`/api/media/${image.id}/edit`, "POST", { crop: { left: 0, top: 0, width: 300, height: 500 } })).media;
    assert.deepEqual(shape(orientedCrop), { width: 300, height: 500 }, "Crop coordinates refer to the EXIF-oriented 400×600 image"); await verified(await fetchBytes(orientedCrop.url), jpeg, shape(orientedCrop));
    const stamp = "format-owner-" + Date.now().toString(36), password = "Temporary-" + stamp;
    otherId = (await api.ok("/api/users", "POST", { username: stamp, email: stamp + "@example.test", displayName: stamp, role: "author", password })).user.id;
    const signed = await api.request("/api/auth/login", "POST", { login: stamp, password }, ""); const otherCookie = signed.response.headers.get("set-cookie")!.split(";")[0], before = await inventory();
    assert.equal((await api.request(`/api/media/${image.id}/edit`, "POST", { rotate: 90 }, otherCookie)).response.status, 403);
    assert.equal((await api.request(`/api/media/${image.id}/restore`, "POST", {}, otherCookie)).response.status, 403);
    assert.deepEqual(await inventory(), before);
  } finally { for (const id of ids) await api.ok(`/api/media/${id}`, "DELETE"); if (otherId) await api.ok(`/api/users/${otherId}`, "DELETE"); await pool.query("UPDATE settings SET data=$1::jsonb WHERE id=1", [JSON.stringify(settingsBefore)]); await api.ok("/api/auth/logout", "POST", {}); }
});

test("archives verify sub-size bytes and preserve mixed old PNG histories with shared deletion boundaries", async () => {
  const api = client(), ids = new Set<number>();
  try {
    await api.login(); const jpeg = await api.upload(await sample(formats[0])); ids.add(jpeg.id); const png = await api.upload(await sample(formats[1])); ids.add(png.id);
    const edited = (await api.ok(`/api/media/${jpeg.id}/edit`, "POST", { rotate: 90 })).media;
    const archive = await api.ok("/api/tools/export"), record = archive.media.find((row: any) => row.id === jpeg.id), pngRecord = archive.media.find((row: any) => row.id === png.id);
    record.sizes.thumbnail = { ...pngRecord.sizes.thumbnail, mimeType: "image/jpeg", width: 1, height: 1 }; record.mime_type = "image/png";
    const alias = { ...record, id: 2147483000, filename: record.original_filename, derivatives: { ...record.derivatives, "shared-current": record.filename } };
    const names = new Set([...filenames(record), ...filenames(alias)]), files = archive.mediaFiles.filter((file: any) => names.has(file.filename));
    const restored = await api.ok("/api/tools/import", "POST", { application: "WorldAct", version: 3, posts: [], media: [record, alias], mediaFiles: files }); restored.mediaIds.forEach((id: number) => ids.add(id)); assert.ok(restored.warnings.some((warning: string) => /dimensions were recomputed/.test(warning)));
    const copies = (await pool.query("SELECT * FROM media WHERE id=ANY($1::int[]) ORDER BY id", [restored.mediaIds])).rows;
    assert.equal(copies[0].mime_type, "image/jpeg"); assert.equal(copies[0].sizes.thumbnail.mimeType, "image/png"); assert.deepEqual(shape(copies[0].sizes.thumbnail), shape(pngRecord.sizes.thumbnail));
    assert.equal(copies[0].original_filename, copies[1].filename); assert.equal(copies[1].derivatives["shared-current"], copies[0].filename);
    const copiedFiles = new Set(copies.flatMap(filenames));
    for (const row of copies) { assert.deepEqual(await fetchBytes("/uploads/" + row.filename), await fetchBytes(row.id === copies[0].id ? edited.url : jpeg.url)); assert.equal((await detectMediaType(await fetchBytes(row.sizes.thumbnail.url)))!.mime, "image/png"); }
    await api.ok(`/api/media/${copies[0].id}`, "DELETE"); ids.delete(copies[0].id); for (const name of copiedFiles) assert.equal((await fetch(base + "/uploads/" + name)).status, 200);
    await api.ok(`/api/media/${copies[1].id}`, "DELETE"); ids.delete(copies[1].id); for (const name of copiedFiles) assert.equal((await fetch(base + "/uploads/" + name)).status, 404);
    const pdf = Buffer.from("%PDF-1.4\n% Controlled non-image sub-size fixture\n%%EOF"), pdfFile = { filename: "not-an-image.pdf", mimeType: "application/pdf", size: pdf.length, sha256: sha(pdf), data: pdf.toString("base64") };
    const before = await inventory(), count = (await pool.query("SELECT count(*)::int AS n FROM media")).rows[0].n;
    const rejected = await api.request("/api/tools/import", "POST", { application: "WorldAct", version: 3, posts: [], media: [{ ...record, sizes: { thumbnail: { filename: pdfFile.filename, width: 50, height: 50 } } }], mediaFiles: [...files, pdfFile] }); assert.equal(rejected.response.status, 400); assert.match(rejected.data.error, /sub-size/);
    assert.deepEqual(await inventory(), before); assert.equal((await pool.query("SELECT count(*)::int AS n FROM media")).rows[0].n, count);
  } finally { for (const id of ids) await api.ok(`/api/media/${id}`, "DELETE"); await api.ok("/api/auth/logout", "POST", {}); }
});

const archiveStage = process.env.IMAGE_FORMAT_ARCHIVE_STAGE, archivePath = process.env.IMAGE_FORMAT_ARCHIVE_PATH;
test("all supported image formats and original histories cross fresh database archives", { skip: !archiveStage || !archivePath }, async () => {
  const api = client(), ids = new Set<number>();
  try {
    await api.login();
    if (archiveStage === "export") {
      for (const format of formats) { const image = await api.upload(await sample(format)); ids.add(image.id); await api.ok(`/api/media/${image.id}/edit`, "POST", { rotate: 90 }); }
      const archive = await api.ok("/api/tools/export"), media = archive.media.filter((item: any) => ids.has(item.id)), names = new Set(media.flatMap(filenames)), mediaFiles = archive.mediaFiles.filter((file: any) => names.has(file.filename));
      await writeFile(archivePath!, JSON.stringify({ application: "WorldAct", version: 3, posts: [], media, mediaFiles }));
    } else {
      const archived = JSON.parse(await readFile(archivePath!, "utf8")), sentinel = await api.upload(await sample(formats[1], 12, 8)); ids.add(sentinel.id);
      const imported = await api.ok("/api/tools/import", "POST", archived); imported.mediaIds.forEach((id: number) => ids.add(id)); assert.equal(imported.mediaIds.length, formats.length);
      for (let index = 0; index < formats.length; index++) {
        const format = formats[index], source = archived.media[index], row = (await pool.query("SELECT * FROM media WHERE id=$1", [imported.mediaIds[index]])).rows[0];
        assert.notEqual(row.id, source.id); assert.notEqual(row.filename, source.filename); assert.equal(row.mime_type, format.mime);
        for (const [oldName, newName] of [[source.filename, row.filename], [source.original_filename, row.original_filename], ...Object.keys(source.sizes).map(key => [source.sizes[key].filename, row.sizes[key].filename])]) { const bytes = await fetchBytes("/uploads/" + newName); assert.equal(sha(bytes), archived.mediaFiles.find((file: any) => file.filename === oldName).sha256); assert.equal((await detectMediaType(bytes))!.mime, format.mime); }
        const native = await api.ok(`/wp-json/wp/v2/media/${row.id}`); assert.equal(native.mime_type, format.mime); for (const size of Object.values(native.media_details.sizes) as any[]) assert.equal(size.mime_type, format.mime);
        const restored = (await api.ok(`/api/media/${row.id}/restore`, "POST", {})).media; assert.equal(restored.mimeType, format.mime); assert.equal(sha(await fetchBytes(restored.url)), archived.mediaFiles.find((file: any) => file.filename === source.original_filename).sha256);
      }
      assert.equal((await api.ok(`/api/media/${sentinel.id}`)).media.filename, sentinel.filename);
    }
  } finally { for (const id of ids) await api.ok(`/api/media/${id}`, "DELETE"); await api.ok("/api/auth/logout", "POST", {}); }
});
