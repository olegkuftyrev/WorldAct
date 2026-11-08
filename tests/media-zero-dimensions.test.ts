import test, { after } from "./isolated-test.js";
import "dotenv/config";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdir, readFile, unlink } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { DOMParser } from "linkedom";
import { buildSizes, imageResizeGeometry } from "../server/media-files.js";
import { pool, uploadsDir } from "../server/db.js";
import { settingSchema } from "../server/site-validation.js";

after(() => pool.end());
const dimensions = ["thumbnailWidth", "thumbnailHeight", "mediumWidth", "mediumHeight", "largeWidth", "largeHeight"] as const;
const disabled = Object.fromEntries(dimensions.map(key => [key, 0]));
const geometry = (width: number, height: number) => ({ width, height });
const shape = (size: any) => geometry(size.width, size.height);
const files = async () => (await readdir(uploadsDir, { recursive: true, withFileTypes: true })).filter(item => item.isFile()).map(item => path.join(item.parentPath, item.name)).sort();
const png = (width = 600, height = 300) => sharp({ create: { width, height, channels: 3, background: "#237aba" } }).png().toBuffer();

test("source geometry treats zero as unconstrained and avoids upscaling or identical intermediates", () => {
  const full = { left: 0, top: 0, cropWidth: 600, cropHeight: 300 };
  assert.deepEqual(imageResizeGeometry(600, 300, 0, 100, false), { ...full, width: 200, height: 100 });
  assert.deepEqual(imageResizeGeometry(600, 300, 200, 0, true), { ...full, width: 200, height: 100 });
  assert.deepEqual(imageResizeGeometry(600, 300, 400, 400, true), { left: 100, top: 0, cropWidth: 400, cropHeight: 300, width: 400, height: 300 });
  assert.deepEqual(imageResizeGeometry(200, 500, 400, 400, true), { left: 0, top: 50, cropWidth: 200, cropHeight: 400, width: 200, height: 400 });
  assert.deepEqual(shape(imageResizeGeometry(600, 300, 400, 400)!), geometry(400, 200));
  assert.deepEqual(shape(imageResizeGeometry(600, 401, 300, 200)!), geometry(300, 200), "Source rounding corrects a one-pixel short constrained side");
  assert.deepEqual(shape(imageResizeGeometry(465, 700, 177, 177)!), geometry(118, 177));
  for (const [w, h] of [[0, 0], [150, 150], [150, 0], [0, 150]]) assert.equal(imageResizeGeometry(8, 8, w, h, true), null);
  assert.equal(imageResizeGeometry(150, 150, 149, 149), null, "Source fuzzy matching skips derivatives within one pixel of the original");
  assert.equal(imageResizeGeometry(2, 1000, 0, 1, true), null, "A crop with a rounded zero side has no usable intermediate");
});

test("real Sharp sub-sizes preserve source crops, orientation, defaults, and failed-write cleanup", async () => {
  const owned = new Set<string>();
  const build = async (bytes: Buffer, settings: Record<string, unknown>) => {
    const sizes = await buildSizes(bytes, "", settings); Object.values(sizes).forEach(size => owned.add(size.filename));
    for (const size of Object.values(sizes)) { const metadata = await sharp(await readFile(path.join(uploadsDir, size.filename))).metadata(); assert.deepEqual(shape(metadata), shape(size)); assert.equal(metadata.format, "png"); }
    return sizes;
  };
  try {
    const bytes = await png();
    assert.deepEqual(await build(bytes, disabled), {});
    const sizes = await build(bytes, { thumbnailWidth: 400, thumbnailHeight: 400, mediumWidth: 0, mediumHeight: 100, largeWidth: 200, largeHeight: 0 });
    assert.deepEqual(shape(sizes.thumbnail), geometry(400, 300)); assert.deepEqual(shape(sizes.medium), geometry(200, 100)); assert.deepEqual(shape(sizes.large), geometry(200, 100));
    const expected = await sharp(bytes).extract({ left: 100, top: 0, width: 400, height: 300 }).png().toBuffer();
    assert.deepEqual(await readFile(path.join(uploadsDir, sizes.thumbnail.filename)), expected);
    const defaults = await build(await png(1200, 800), {});
    assert.deepEqual(shape(defaults.thumbnail), geometry(150, 150)); assert.deepEqual(shape(defaults.medium), geometry(300, 200)); assert.deepEqual(shape(defaults.large), geometry(1024, 683));
    const oriented = await sharp(await png()).jpeg().withMetadata({ orientation: 6 }).toBuffer();
    const rotated = await build(oriented, { ...disabled, thumbnailWidth: 0, thumbnailHeight: 200 });
    assert.deepEqual(shape(rotated.thumbnail), geometry(100, 200));
    assert.deepEqual(await build(await png(12, 8), {}), {});
    const before = await files();
    await assert.rejects(buildSizes(bytes, "", { thumbnailWidth: 150, thumbnailHeight: 150, mediumWidth: Number.NaN }), /whole numbers/);
    assert.deepEqual(await files(), before, "An invalid later size removes all intermediates generated earlier in the same call");
    for (const value of [-1, 0.5, Number.NaN, Number.POSITIVE_INFINITY, "0", null, 8193]) assert.equal(settingSchema.safeParse({ mediumWidth: value }).success, false);
    assert.equal(settingSchema.safeParse(disabled).success, true);
  } finally { await Promise.all([...owned].map(filename => unlink(path.join(uploadsDir, filename)).catch(() => {}))); }
});

test("upload, image edit, restore and native/public size selection honor zero settings and ownership", async () => {
  const base = process.env.TEST_API_URL!, origin = process.env.APP_ORIGIN!;
  const mediaIds = new Set<number>(), postIds = new Set<number>(); let cookie = "", userId = 0;
  const settingsBefore = (await pool.query("SELECT data FROM settings WHERE id=1")).rows[0].data;
  const request = async (url: string, method = "GET", body?: unknown, auth = cookie) => {
    const response = await fetch(base + url, { method, headers: { Origin: origin, "Content-Type": "application/json", ...(auth ? { Cookie: auth } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { response, data: await response.json() };
  };
  const ok = async (url: string, method = "GET", body?: unknown, auth = cookie) => { const result = await request(url, method, body, auth); assert.ok(result.response.ok, `${url}: ${result.response.status} ${JSON.stringify(result.data)}`); return result.data; };
  const upload = async () => {
    const form = new FormData(); form.append("file", new Blob([new Uint8Array(await png())], { type: "image/png" }), "zero-dimension.png");
    const response = await fetch(base + "/api/media", { method: "POST", headers: { Origin: origin, Cookie: cookie }, body: form }); const data = await response.json(); assert.equal(response.status, 201, JSON.stringify(data)); mediaIds.add(data.media.id); return data.media;
  };
  const liveShape = async (size: any) => { const response = await fetch(base + size.url); assert.equal(response.status, 200); return shape(await sharp(Buffer.from(await response.arrayBuffer())).metadata()); };
  try {
    const signed = await request("/api/auth/login", "POST", { login: process.env.ADMIN_EMAIL, password: process.env.ADMIN_PASSWORD }); assert.equal(signed.response.status, 200); cookie = signed.response.headers.get("set-cookie")!.split(";")[0];
    await ok("/api/settings", "PUT", { ...disabled, mediumHeight: 100, largeWidth: 200 });
    const initial = await upload(); assert.equal(initial.sizes.thumbnail, undefined); assert.deepEqual(await liveShape(initial.sizes.medium), geometry(200, 100)); assert.deepEqual(await liveShape(initial.sizes.large), geometry(200, 100));
    await ok("/api/settings", "PUT", { ...disabled, thumbnailWidth: 400, thumbnailHeight: 400, thumbnailCrop: true });
    const edited = (await ok(`/api/media/${initial.id}/edit`, "POST", { rotate: 90 })).media;
    assert.deepEqual(shape(edited), geometry(300, 600)); assert.deepEqual(await liveShape(edited.sizes.thumbnail), geometry(300, 400)); assert.equal(edited.sizes.medium, undefined);
    assert.equal((await fetch(base + initial.sizes.medium.url)).status, 200, "An old published size survives image editing");
    await ok("/api/settings", "PUT", { ...disabled, mediumHeight: 120, largeWidth: 120 });
    const restored = (await ok(`/api/media/${initial.id}/restore`, "POST", {})).media;
    assert.equal(restored.filename, initial.filename); assert.deepEqual(shape(restored), geometry(600, 300)); assert.deepEqual(await liveShape(restored.sizes.medium), geometry(240, 120)); assert.deepEqual(await liveShape(restored.sizes.large), geometry(120, 60)); assert.equal(restored.sizes.thumbnail, undefined);
    assert.equal((await fetch(base + edited.sizes.thumbnail.url)).status, 200, "Restore retains the previous file and size history");
    await ok("/api/settings", "PUT", disabled);
    const plain = await upload(); assert.deepEqual(plain.sizes, {});
    const native = await ok(`/wp-json/wp/v2/media/${plain.id}`); assert.equal(native.media_details.sizes.full.source_url, native.source_url); assert.deepEqual(shape(native.media_details.sizes.full), geometry(600, 300));
    const raw = '<!-- wp:post-featured-image {"sizeSlug":"thumbnail"} /-->';
    const post = (await ok("/api/posts", "POST", { title: "Media zero fallback " + Date.now().toString(36), status: "publish", content: raw, featuredMediaId: plain.id })).post; postIds.add(post.id);
    const rendered = (await ok("/api/public/posts/" + post.slug, "GET", undefined, "")).post.content;
    const image = new DOMParser().parseFromString(rendered, "text/html").querySelector("img")!; assert.equal(image.getAttribute("src"), plain.url); assert.equal(image.getAttribute("width"), "600"); assert.equal(image.getAttribute("height"), "300");
    const ssr = await ok("/wp-json/wp/v2/block-renderer/core/post-featured-image", "POST", { attributes: { sizeSlug: "large" }, post_id: post.id }); assert.ok(ssr.rendered.includes(plain.url));
    const beforeReject = await files();
    for (const [key, value] of [["thumbnailWidth", -1], ["thumbnailHeight", 4097], ["mediumWidth", 0.5], ["mediumHeight", 8193], ["largeWidth", "0"], ["largeHeight", null]] as const) assert.equal((await request("/api/settings", "PUT", { [key]: value })).response.status, 400);
    assert.deepEqual(await files(), beforeReject); assert.equal((await ok("/api/settings")).settings.largeHeight, 0);
    const stamp = "zero-owner-" + Date.now().toString(36);
    userId = (await ok("/api/users", "POST", { username: stamp, email: stamp + "@example.test", displayName: stamp, role: "author", password: "Temporary-" + stamp })).user.id;
    const author = await request("/api/auth/login", "POST", { login: stamp, password: "Temporary-" + stamp }, ""); assert.equal(author.response.status, 200); const authorCookie = author.response.headers.get("set-cookie")!.split(";")[0];
    assert.equal((await request(`/api/media/${plain.id}/edit`, "POST", { rotate: 90 }, authorCookie)).response.status, 403);
    assert.equal((await request(`/api/media/${initial.id}/restore`, "POST", {}, authorCookie)).response.status, 403); assert.deepEqual(await files(), beforeReject);
    const history = [initial.url, ...Object.values(initial.sizes).map((size: any) => size.url), edited.url, edited.sizes.thumbnail.url, restored.sizes.medium.url, restored.sizes.large.url];
    await ok(`/api/media/${initial.id}`, "DELETE"); mediaIds.delete(initial.id);
    for (const url of history) assert.equal((await fetch(base + url)).status, 404, `Deleted owned history ${url}`);
  } finally {
    for (const id of postIds) { await request(`/api/posts/${id}`, "PUT", { status: "trash" }); await request(`/api/posts/${id}`, "DELETE"); }
    for (const id of mediaIds) await request(`/api/media/${id}`, "DELETE");
    if (userId) await request(`/api/users/${userId}`, "DELETE");
    await pool.query("UPDATE settings SET data=$1::jsonb WHERE id=1", [JSON.stringify(settingsBefore)]);
    if (cookie) await request("/api/auth/logout", "POST", {});
  }
});

test("site archives preserve disabled dimensions and verified original bytes with full-image fallbacks", async () => {
  const base = process.env.TEST_API_URL!, origin = process.env.APP_ORIGIN!; let cookie = ""; const mediaIds = new Set<number>();
  const before = (await pool.query("SELECT data FROM settings WHERE id=1")).rows[0].data;
  const api = async (route: string, method = "GET", body?: unknown) => {
    const response = await fetch(base + route, { method, headers: { Origin: origin, "Content-Type": "application/json", Cookie: cookie }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }); const data = await response.json(); assert.ok(response.ok, `${route}: ${response.status} ${JSON.stringify(data)}`); return { response, data };
  };
  try {
    const login = await api("/api/auth/login", "POST", { login: process.env.ADMIN_EMAIL, password: process.env.ADMIN_PASSWORD }); cookie = login.response.headers.get("set-cookie")!.split(";")[0];
    await api("/api/settings", "PUT", disabled);
    const bytes = await png(), form = new FormData(); form.append("file", new Blob([new Uint8Array(bytes)], { type: "image/png" }), "zero-archive.png");
    const upload = await fetch(base + "/api/media", { method: "POST", headers: { Origin: origin, Cookie: cookie }, body: form }); const image = (await upload.json()).media; assert.equal(upload.status, 201); mediaIds.add(image.id);
    const archive = (await api("/api/tools/export")).data, media = archive.media.filter((row: any) => row.id === image.id), mediaFiles = archive.mediaFiles.filter((row: any) => row.filename === image.filename);
    assert.deepEqual(media[0].sizes, {}); for (const key of dimensions) assert.equal(archive.settings[key], 0);
    assert.equal(mediaFiles.length, 1); assert.equal(mediaFiles[0].sha256, createHash("sha256").update(bytes).digest("hex"));
    await api("/api/settings", "PUT", { thumbnailWidth: 150, thumbnailHeight: 150, mediumWidth: 300, mediumHeight: 300, largeWidth: 1024, largeHeight: 1024 });
    const imported = (await api("/api/tools/import", "POST", { application: "WorldAct", version: 3, posts: [], media, mediaFiles, settings: Object.fromEntries(dimensions.map(key => [key, archive.settings[key]])), replaceDesign: true })).data;
    imported.mediaIds.forEach((id: number) => mediaIds.add(id)); assert.equal(imported.restoredDesign, true); assert.equal(imported.mediaIds.length, 1); assert.notEqual(imported.mediaIds[0], image.id);
    const copied = (await api(`/api/media/${imported.mediaIds[0]}`)).data.media; assert.notEqual(copied.filename, image.filename); assert.deepEqual(copied.sizes, {});
    assert.deepEqual(Buffer.from(await (await fetch(base + copied.url)).arrayBuffer()), bytes);
    for (const key of dimensions) assert.equal((await api("/api/settings")).data.settings[key], 0);
    const native = (await api(`/wp-json/wp/v2/media/${copied.id}`)).data; assert.equal(native.media_details.sizes.full.source_url, native.source_url); assert.deepEqual(shape(native.media_details.sizes.full), geometry(600, 300));
    const inventory = await files(), records = (await pool.query("SELECT count(*)::int AS count FROM media")).rows[0].count;
    const rejected = await fetch(base + "/api/tools/import", { method: "POST", headers: { Origin: origin, Cookie: cookie, "Content-Type": "application/json" }, body: JSON.stringify({ application: "WorldAct", version: 3, posts: [], media, mediaFiles, settings: { largeHeight: -1 }, replaceDesign: true }) }); assert.equal(rejected.status, 400);
    assert.deepEqual(await files(), inventory); assert.equal((await pool.query("SELECT count(*)::int AS count FROM media")).rows[0].count, records); assert.equal((await api("/api/settings")).data.settings.largeHeight, 0);
  } finally { for (const id of mediaIds) await api(`/api/media/${id}`, "DELETE"); await pool.query("UPDATE settings SET data=$1::jsonb WHERE id=1", [JSON.stringify(before)]); if (cookie) await api("/api/auth/logout", "POST", {}); }
});
