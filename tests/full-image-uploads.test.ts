import test, { after } from "./isolated-test.js";
import "dotenv/config";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { open, readFile, writeFile, unlink, readdir } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { DOMParser } from "linkedom";
import { pool, uploadsDir } from "../server/db.js";
import { detectMediaType } from "../server/media-types.js";
import { stageImageUpload } from "../server/image-uploads.js";

after(() => pool.end());
const base = process.env.TEST_API_URL!, origin = process.env.APP_ORIGIN!;
const disabled = { thumbnailWidth: 0, thumbnailHeight: 0, mediumWidth: 0, mediumHeight: 0, largeWidth: 0, largeHeight: 0 };
const shape = (value: any) => ({ width: value.width, height: value.height });
const sha = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const files = async () => (await readdir(uploadsDir, { recursive: true, withFileTypes: true })).filter(item => item.isFile()).map(item => path.join(item.parentPath, item.name)).sort();
const names = (row: any): string[] => [...new Set<string>([row.filename, row.original_filename, ...Object.values(row.derivatives || {}), ...Object.values(row.sizes || {}).map((size: any) => size.filename)].filter((value): value is string => typeof value === "string"))];
const formats = ["jpeg", "png", "webp", "avif", "gif"] as const;
type Format = typeof formats[number];
const mime = (format: Format) => "image/" + (format === "jpeg" ? "jpeg" : format);
async function image(format: Format, width = 3000, height = 1500, orientation?: number) {
  const bytes = Buffer.alloc(width * height * 4), colors = [[220, 20, 30], [20, 210, 40], [30, 40, 220], [220, 210, 20]];
  for (let i = 0; i < width * height; i++) { const x = i % width, y = Math.floor(i / width), color = colors[(y < height / 2 ? 0 : 2) + (x < width / 2 ? 0 : 1)]; bytes[i * 4] = color[0]; bytes[i * 4 + 1] = color[1]; bytes[i * 4 + 2] = color[2]; bytes[i * 4 + 3] = format !== "jpeg" && x < width / 8 ? 0 : 255; }
  let input = sharp(bytes, { raw: { width, height, channels: 4 } });
  if (orientation) input = input.withMetadata({ orientation });
  return format === "jpeg" ? input.jpeg({ quality: 95 }).toBuffer() : format === "png" ? input.png().toBuffer() : format === "webp" ? input.webp({ lossless: true }).toBuffer() : format === "avif" ? input.avif({ quality: 90, effort: 1 }).toBuffer() : input.gif().toBuffer();
}
const bytesAt = async (url: string) => { const response = await fetch(new URL(url, base)); assert.equal(response.status, 200, url); return Buffer.from(await response.arrayBuffer()); };
function client() {
  let cookie = "";
  const request = async (url: string, method = "GET", body?: unknown, auth = cookie) => { const response = await fetch(base + url, { method, signal: AbortSignal.timeout(30000), headers: { Origin: origin, "Content-Type": "application/json", ...(auth ? { Cookie: auth } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }); return { response, data: await response.json() }; };
  const ok = async (url: string, method = "GET", body?: unknown, auth = cookie) => { const result = await request(url, method, body, auth); assert.ok(result.response.ok, `${url}: ${result.response.status} ${JSON.stringify(result.data)}`); return result.data; };
  return {
    request, ok,
    async login() { const result = await request("/api/auth/login", "POST", { login: process.env.ADMIN_EMAIL, password: process.env.ADMIN_PASSWORD }); assert.equal(result.response.status, 200); cookie = result.response.headers.get("set-cookie")!.split(";")[0]; },
    async upload(bytes: Buffer, filename = "full-image.png", expected = 201) { const form = new FormData(); form.append("file", new Blob([new Uint8Array(bytes)], { type: "image/png" }), filename); const response = await fetch(base + "/api/media", { method: "POST", headers: { Origin: origin, Cookie: cookie }, body: form }); const data = await response.json(); assert.equal(response.status, expected, JSON.stringify(data)); return data.media; },
  };
}

test("large full images normalize in every supported format while raw uploads, source sub-sizes and manual restores remain distinct", async () => {
  const api = client(), media = new Set<number>(), posts: number[] = [], before = (await pool.query("SELECT data FROM settings WHERE id=1")).rows[0].data;
  try {
    await api.login(); await api.ok("/api/settings", "PUT", disabled);
    for (const format of formats) {
      const raw = await image(format, 3000, 1500, format === "png" ? 6 : undefined), item = await api.upload(raw); media.add(item.id);
      assert.equal(item.mimeType, mime(format)); assert.deepEqual(shape(item), { width: 2560, height: 1280 }); assert.match(item.filename, /-scaled\./); assert.equal(item.canRestore, false); assert.ok(item.originalUploadUrl);
      assert.deepEqual(await bytesAt(item.originalUploadUrl), raw); const normalized = await bytesAt(item.url); assert.notDeepEqual(normalized, raw); assert.equal(item.size, normalized.length); assert.equal((await detectMediaType(normalized))!.mime, mime(format));
      const decoded = await sharp(normalized).metadata(); assert.deepEqual(shape(decoded), shape(item)); assert.ok(!decoded.orientation || decoded.orientation === 1);
      if (format !== "jpeg") assert.equal((await sharp(normalized).ensureAlpha().raw().toBuffer())[3], 0);
      assert.deepEqual(Object.keys(item.sizes).sort(), ["1536x1536", "2048x2048", "medium_large"]);
      assert.deepEqual(shape(item.sizes.medium_large), { width: 768, height: 384 }); assert.deepEqual(shape(item.sizes["1536x1536"]), { width: 1536, height: 768 }); assert.deepEqual(shape(item.sizes["2048x2048"]), { width: 2048, height: 1024 });
      assert.equal((await api.request(`/api/media/${item.id}/restore`, "POST", {})).response.status, 400, "Upload normalization is not a manual edit");
      const native = await api.ok(`/wp-json/wp/v2/media/${item.id}`); assert.ok(native.source_url.endsWith(item.url)); assert.ok(native.original_image_url.endsWith(item.originalUploadUrl)); assert.equal(native.media_details.original_image, path.posix.basename(item.originalUploadUrl)); assert.equal(native.media_details.sizes.full.source_url, native.source_url);
      if (format === "jpeg") {
        const post = (await api.ok("/api/posts", "POST", { title: "Normalized full image " + Date.now().toString(36), status: "publish", featuredMediaId: item.id, content: '<!-- wp:post-featured-image {"sizeSlug":"full"} /-->' })).post; posts.push(post.id);
        const html = (await api.ok("/api/public/posts/" + post.slug, "GET", undefined, "")).post.content, img = new DOMParser().parseFromString(html, "text/html").querySelector("img")!; assert.equal(img.getAttribute("src"), item.url); assert.equal(img.getAttribute("width"), "2560");
      }
      const edited = (await api.ok(`/api/media/${item.id}/edit`, "POST", { rotate: 90, width: 600 })).media; assert.equal(edited.canRestore, true); assert.equal(edited.originalUploadUrl, item.originalUploadUrl);
      const backup = (await pool.query("SELECT original_filename FROM media WHERE id=$1", [item.id])).rows[0].original_filename; assert.equal(backup, item.filename);
      const restored = (await api.ok(`/api/media/${item.id}/restore`, "POST", {})).media; assert.equal(restored.filename, item.filename); assert.equal(restored.canRestore, false); assert.deepEqual(await bytesAt(restored.url), normalized); assert.deepEqual(await bytesAt(restored.originalUploadUrl), raw);
      const row = (await pool.query("SELECT * FROM media WHERE id=$1", [item.id])).rows[0], graph = names(row);
      await api.ok(`/api/media/${item.id}`, "DELETE"); media.delete(item.id); for (const filename of graph) assert.equal((await fetch(base + "/uploads/" + filename)).status, 404, filename);
    }
    await api.ok("/api/settings", "PUT", { ...disabled, largeWidth: 2800 });
    const raw = await image("jpeg"), item = await api.upload(raw); media.add(item.id); assert.equal(item.width, 2560); assert.equal(item.sizes.large.width, 2800, "Sub-sizes use the original source, not the normalized full image");
    const expected = await sharp(raw).resize({ width: 2800, height: 1400, fit: "fill" }).keepIccProfile().jpeg({ quality: 82, progressive: false }).toBuffer(); assert.deepEqual(await bytesAt(item.sizes.large.url), expected);
  } finally { for (const id of posts) { await api.ok(`/api/posts/${id}`, "PUT", { status: "trash" }); await api.ok(`/api/posts/${id}`, "DELETE"); } for (const id of media) await api.ok(`/api/media/${id}`, "DELETE"); await pool.query("UPDATE settings SET data=$1::jsonb WHERE id=1", [JSON.stringify(before)]); await api.ok("/api/auth/logout", "POST", {}); }
});

test("JPEG orientations2–8 normalize actual corner geometry; small unrotated and non-JPEG files remain untouched", async () => {
  const api = client(), ids = new Set<number>(), before = (await pool.query("SELECT data FROM settings WHERE id=1")).rows[0].data;
  const colors = [[220, 20, 30], [20, 210, 40], [30, 40, 220], [220, 210, 20]], corners: Record<number, number[]> = { 2: [1, 0, 3, 2], 3: [3, 2, 1, 0], 4: [2, 3, 0, 1], 5: [0, 2, 1, 3], 6: [2, 0, 3, 1], 7: [3, 1, 2, 0], 8: [1, 3, 0, 2] };
  try {
    await api.login(); await api.ok("/api/settings", "PUT", disabled);
    for (const orientation of [2, 3, 4, 5, 6, 7, 8]) {
      const raw = await image("jpeg", 200, 120, orientation), item = await api.upload(raw); ids.add(item.id); assert.match(item.filename, /-rotated\.jpg$/); assert.equal(item.canRestore, false); assert.deepEqual(shape(item), orientation >= 5 ? { width: 120, height: 200 } : { width: 200, height: 120 }); assert.deepEqual(await bytesAt(item.originalUploadUrl), raw);
      const normalized = await bytesAt(item.url), decoded = await sharp(normalized).removeAlpha().raw().toBuffer({ resolveWithObject: true }), { width, height, channels } = decoded.info;
      for (const [index, [x, y]] of [[10, 10], [width - 11, 10], [10, height - 11], [width - 11, height - 11]].entries()) for (let channel = 0; channel < 3; channel++) assert.ok(Math.abs(decoded.data[(y * width + x) * channels + channel] - colors[corners[orientation][index]][channel]) < 12, `EXIF${orientation} corner${index} channel${channel}`);
      const metadata = await sharp(normalized).metadata(); assert.equal(metadata.exif, undefined); assert.deepEqual(metadata.icc, (await sharp(raw).metadata()).icc);
    }
    for (const format of formats) { const raw = await image(format, 200, 120), item = await api.upload(raw); ids.add(item.id); assert.deepEqual(await bytesAt(item.url), raw); assert.equal(item.originalUploadUrl, null); assert.equal(item.canRestore, false); }
    const png = await image("png", 200, 120, 6), untouched = await api.upload(png); ids.add(untouched.id); assert.deepEqual(shape(untouched), { width: 200, height: 120 }); assert.deepEqual(await bytesAt(untouched.url), png); assert.equal(untouched.originalUploadUrl, null);
    const edited = (await api.ok(`/api/media/${untouched.id}/edit`, "POST", { rotate: 90 })).media; assert.deepEqual(shape(edited), { width: 120, height: 200 }, "Non-JPEG EXIF metadata is not an extra rotation");
    const edge = await image("jpeg", 2561, 1), unchanged = await api.upload(edge); ids.add(unchanged.id); assert.equal(unchanged.width, 2561); assert.equal(unchanged.originalUploadUrl, null); assert.deepEqual(await bytesAt(unchanged.url), edge, "Source's one-pixel resize refusal retains the original");
  } finally { for (const id of ids) await api.ok(`/api/media/${id}`, "DELETE"); await pool.query("UPDATE settings SET data=$1::jsonb WHERE id=1", [JSON.stringify(before)]); await api.ok("/api/auth/logout", "POST", {}); }
});

test("staged raw/full writes are cleaned after partial failures while exclusive collisions retain existing bytes", async () => {
  const bytes = await image("png"), filename = randomBytes(20).toString("hex") + ".png", target = path.join(uploadsDir, filename), probeName = randomBytes(20).toString("hex") + ".tmp", probePath = path.join(uploadsDir, probeName);
  const probe = await open(probePath, "wx"), prototype = Object.getPrototypeOf(probe), original = prototype.writeFile; await probe.close(); await unlink(probePath);
  const before = await files();
  try {
    for (const failAt of [4, 5]) {
      let writes = 0; prototype.writeFile = async function(this: any, data: Buffer, ...options: any[]) { if (++writes === failAt) { await original.call(this, data.subarray(0, 24), ...options); throw new Error("Controlled partial image write"); } return original.call(this, data, ...options); };
      const owned = new Set<string>(); await assert.rejects(stageImageUpload(bytes, filename, "", disabled, owned), /Controlled partial/); assert.equal(writes, failAt); assert.deepEqual(await files(), before);
      prototype.writeFile = original;
    }
    await writeFile(target, "Existing file must survive", { flag: "wx" }); const occupied = await files();
    await assert.rejects(stageImageUpload(bytes, filename, "", disabled, new Set()), (error: any) => error.code === "EEXIST"); assert.deepEqual(await files(), occupied); assert.equal(await readFile(target, "utf8"), "Existing file must survive");
  } finally { prototype.writeFile = original; await unlink(target).catch(() => {}); }
});

test("normalized file graphs survive archive aliases and failed upload/edit transactions without unsafe original URLs", async () => {
  const api = client(), ids = new Set<number>(); let createdTrigger = false;
  try {
    await api.login(); const raw = await image("jpeg"), item = await api.upload(raw); ids.add(item.id); const norm = await bytesAt(item.url);
    const edited = (await api.ok(`/api/media/${item.id}/edit`, "POST", { width: 600 })).media;
    const archive = await api.ok("/api/tools/export"), record = archive.media.find((row: any) => row.id === item.id), alias = { ...record, id: 2147483000, filename: record.derivatives["original-upload"], derivatives: { ...record.derivatives, "shared-current": record.filename } };
    const sourceNames = new Set([...names(record), ...names(alias)]), mediaFiles = archive.mediaFiles.filter((file: any) => sourceNames.has(file.filename));
    const copied = await api.ok("/api/tools/import", "POST", { application: "WorldAct", version: 3, posts: [], media: [record, alias], mediaFiles }); copied.mediaIds.forEach((id: number) => ids.add(id));
    const rows = (await pool.query("SELECT * FROM media WHERE id=ANY($1::int[]) ORDER BY id", [copied.mediaIds])).rows, copy = (await api.ok(`/api/media/${rows[0].id}`)).media, graph = new Set(rows.flatMap(names));
    assert.notEqual(copy.originalUploadUrl, item.originalUploadUrl); assert.deepEqual(await bytesAt(copy.originalUploadUrl), raw); assert.equal(rows[1].filename, rows[0].derivatives["original-upload"]); assert.equal(rows[1].derivatives["shared-current"], rows[0].filename);
    await api.ok(`/api/media/${rows[0].id}`, "DELETE"); ids.delete(rows[0].id); for (const name of graph) assert.equal((await fetch(base + "/uploads/" + name)).status, 200);
    await api.ok(`/api/media/${rows[1].id}`, "DELETE"); ids.delete(rows[1].id); for (const name of graph) assert.equal((await fetch(base + "/uploads/" + name)).status, 404);
    const derivatives = { ...record.derivatives }; delete derivatives["original-upload"];
    const legacy = await api.ok("/api/tools/import", "POST", { application: "WorldAct", version: 3, posts: [], media: [{ ...record, derivatives }], mediaFiles }); legacy.mediaIds.forEach((id: number) => ids.add(id)); assert.equal((await api.ok(`/api/media/${legacy.mediaIds[0]}`)).media.originalUploadUrl, null);
    const restored = (await api.ok(`/api/media/${legacy.mediaIds[0]}/restore`, "POST", {})).media; assert.deepEqual(await bytesAt(restored.url), norm);
    await pool.query("UPDATE media SET derivatives=$1::jsonb WHERE id=$2", [JSON.stringify({ "original-upload": "../private.env", other: record.derivatives["original-upload"] }), item.id]);
    assert.equal((await api.ok(`/api/media/${item.id}`)).media.originalUploadUrl, null); assert.equal((await api.ok(`/wp-json/wp/v2/media/${item.id}`)).original_image_url, undefined);
    await pool.query("UPDATE media SET derivatives=$1::jsonb WHERE id=$2", [JSON.stringify(record.derivatives), item.id]);
    await pool.query("CREATE FUNCTION full_image_test_failure() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN RAISE EXCEPTION 'Controlled staged-image rollback'; END$$; CREATE TRIGGER full_image_test_failure BEFORE INSERT OR UPDATE ON media FOR EACH ROW EXECUTE FUNCTION full_image_test_failure()"); createdTrigger = true;
    const inventory = await files(), count = (await pool.query("SELECT count(*)::int AS n FROM media")).rows[0].n;
    await api.upload(raw, "full-rollback.jpg", 500); assert.deepEqual(await files(), inventory); assert.equal((await pool.query("SELECT count(*)::int AS n FROM media")).rows[0].n, count);
    assert.equal((await api.request(`/api/media/${item.id}/edit`, "POST", { rotate: 90 })).response.status, 500); assert.deepEqual(await files(), inventory); assert.equal((await api.ok(`/api/media/${item.id}`)).media.filename, edited.filename); assert.deepEqual(await bytesAt(item.originalUploadUrl), raw);
  } finally { if (createdTrigger) await pool.query("DROP TRIGGER full_image_test_failure ON media; DROP FUNCTION full_image_test_failure()"); for (const id of ids) await api.ok(`/api/media/${id}`, "DELETE"); await api.ok("/api/auth/logout", "POST", {}); }
});

const archiveStage = process.env.FULL_IMAGE_ARCHIVE_STAGE, archivePath = process.env.FULL_IMAGE_ARCHIVE_PATH;
test("normalized full images, raw downloads and first-edit backups cross fresh database archives", { skip: !archiveStage || !archivePath }, async () => {
  const api = client(), ids = new Set<number>();
  try {
    await api.login();
    if (archiveStage === "export") {
      for (const format of ["jpeg", "png", "webp", "avif"] as const) { const item = await api.upload(await image(format)); ids.add(item.id); await api.ok(`/api/media/${item.id}/edit`, "POST", { width: 600 }); }
      const archive = await api.ok("/api/tools/export"), media = archive.media.filter((row: any) => ids.has(row.id)), sourceNames = new Set(media.flatMap(names)), mediaFiles = archive.mediaFiles.filter((file: any) => sourceNames.has(file.filename));
      await writeFile(archivePath!, JSON.stringify({ application: "WorldAct", version: 3, posts: [], media, mediaFiles }));
    } else {
      const archived = JSON.parse(await readFile(archivePath!, "utf8")); const occupied = await api.upload(await image("png", 12, 8)); ids.add(occupied.id);
      const restored = await api.ok("/api/tools/import", "POST", archived); restored.mediaIds.forEach((id: number) => ids.add(id)); assert.equal(restored.mediaIds.length, 4);
      for (let index = 0; index < restored.mediaIds.length; index++) {
        const item = (await api.ok(`/api/media/${restored.mediaIds[index]}`)).media, source = archived.media[index], row = (await pool.query("SELECT * FROM media WHERE id=$1", [item.id])).rows[0];
        assert.notEqual(row.filename, source.filename); assert.notEqual(row.derivatives["original-upload"], source.derivatives["original-upload"]); assert.equal(item.originalUploadUrl, "/uploads/" + row.derivatives["original-upload"]); assert.equal(item.canRestore, true);
        const raw = await bytesAt(item.originalUploadUrl); assert.equal(sha(raw), archived.mediaFiles.find((file: any) => file.filename === source.derivatives["original-upload"]).sha256);
        for (const [oldName, newName] of [[source.filename, row.filename], [source.original_filename, row.original_filename], ...Object.keys(source.sizes).map(key => [source.sizes[key].filename, row.sizes[key].filename])]) assert.equal(sha(await bytesAt("/uploads/" + newName)), archived.mediaFiles.find((file: any) => file.filename === oldName).sha256);
        const normalized = (await api.ok(`/api/media/${item.id}/restore`, "POST", {})).media; assert.equal(normalized.canRestore, false); assert.equal(normalized.originalUploadUrl, item.originalUploadUrl); assert.equal(normalized.width, 2560); assert.equal(sha(await bytesAt(normalized.url)), archived.mediaFiles.find((file: any) => file.filename === source.original_filename).sha256);
        const native = await api.ok(`/wp-json/wp/v2/media/${item.id}`); assert.ok(native.source_url.endsWith(normalized.url)); assert.ok(native.original_image_url.endsWith(item.originalUploadUrl));
      }
    }
  } finally { for (const id of ids) await api.ok(`/api/media/${id}`, "DELETE"); await api.ok("/api/auth/logout", "POST", {}); }
});
