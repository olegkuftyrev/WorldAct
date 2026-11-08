import test, { after } from "./isolated-test.js";
import "dotenv/config";
import assert from "node:assert/strict";
import sharp from "sharp";
import { DOMParser } from "linkedom";
import { inspectAudio, inspectAudioWithArtwork, MAX_AUDIO_ARTWORK_BYTES } from "../server/audio-metadata.js";
import { pool } from "../server/db.js";

after(async () => { await pool.end(); });
const chunk = (name: string, data: Buffer) => { const head = Buffer.alloc(8); head.write(name); head.writeUInt32LE(data.length, 4); return Buffer.concat([head, data, ...(data.length % 2 ? [Buffer.alloc(1)] : [])]); };
const frame = (name: string, data: Buffer) => { const head = Buffer.alloc(10); head.write(name); head.writeUInt32BE(data.length, 4); return Buffer.concat([head, data]); };
function wave(artwork: Buffer, mime = "image/png") {
  const frames = Buffer.concat([frame("TIT2", Buffer.from("\0Embedded artwork title")), frame("TPE1", Buffer.from("\0Embedded artist")), frame("TALB", Buffer.from("\0Embedded album")), frame("APIC", Buffer.concat([Buffer.from("\0" + mime + "\0\x03\0"), artwork]))]);
  const id3 = Buffer.alloc(10); id3.write("ID3"); id3[3] = 3; for (let i = 0; i < 4; i++) id3[9 - i] = (frames.length >> (i * 7)) & 127;
  const format = Buffer.alloc(16); format.writeUInt16LE(1); format.writeUInt16LE(1, 2); format.writeUInt32LE(8000, 4); format.writeUInt32LE(16000, 8); format.writeUInt16LE(2, 12); format.writeUInt16LE(16, 14);
  const body = Buffer.concat([Buffer.from("WAVE"), chunk("fmt ", format), chunk("id3 ", Buffer.concat([id3, frames])), chunk("data", Buffer.alloc(32000))]), head = Buffer.alloc(8); head.write("RIFF"); head.writeUInt32LE(body.length, 4); return Buffer.concat([head, body]);
}
const image = () => sharp({ create: { width: 12, height: 8, channels: 3, background: "#1255aa" } }).png().toBuffer();

test("embedded artwork bytes stay separate from bounded descriptive metadata", async () => {
  const png = await image(), bytes = wave(png), inspection = await inspectAudioWithArtwork(bytes, "audio/wav");
  assert.equal(inspection.metadata.title, "Embedded artwork title"); assert.equal(inspection.metadata.artist, "Embedded artist"); assert.equal(inspection.metadata.length, 2);
  assert.deepEqual(inspection.artwork!.data, png); assert.equal(inspection.artwork!.mimeType, "image/png");
  assert.equal((await inspectAudio(bytes, "audio/wav") as any).artwork, undefined);
  const oversized = await inspectAudioWithArtwork(wave(Buffer.alloc(MAX_AUDIO_ARTWORK_BYTES + 1), "image/png"), "audio/wav");
  assert.equal(oversized.artwork, undefined);
});

test("audio artwork creates one verified owned image, deduplicates and remaps across archive copies", async () => {
  const base = process.env.TEST_API_URL || "http://127.0.0.1:3001", origin = process.env.APP_ORIGIN || "http://127.0.0.1:5173";
  let cookie = ""; const ids = new Set<number>();
  const api = async (route: string, method = "GET", body?: unknown) => { const response = await fetch(base + route, { method, headers: { Origin: origin, "Content-Type": "application/json", ...(cookie ? { Cookie: cookie } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }); return { response, data: await response.json() }; };
  const upload = async (bytes: Buffer, name: string) => { const form = new FormData(); form.append("file", new Blob([new Uint8Array(bytes)], { type: "audio/wav" }), name); const response = await fetch(base + "/api/media", { method: "POST", headers: { Origin: origin, Cookie: cookie }, body: form }); const data = await response.json(); assert.equal(response.status, 201, JSON.stringify(data)); ids.add(data.media.id); if (data.media.artworkMediaId) ids.add(data.media.artworkMediaId); return data.media; };
  try {
    const signed = await api("/api/auth/login", "POST", { login: process.env.ADMIN_EMAIL, password: process.env.ADMIN_PASSWORD }); assert.equal(signed.response.status, 200); cookie = signed.response.headers.get("set-cookie")!.split(";")[0];
    const png = await image(), audio = wave(png), before = (await pool.query("SELECT count(*)::int AS n FROM media")).rows[0].n;
    const [first, second] = await Promise.all([upload(audio, "art-one.wav"), upload(audio, "art-two.wav")]);
    assert.ok(first.artworkMediaId); assert.equal(first.artworkMediaId, second.artworkMediaId); assert.equal(first.image.id, first.artworkMediaId); assert.equal(first.image.width, 12); assert.equal(first.image.height, 8);
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM media")).rows[0].n, before + 3);
    const cover = (await api(`/api/media/${first.artworkMediaId}`)).data.media;
    assert.equal(cover.mimeType, "image/png"); assert.ok(cover.sizes.thumbnail); assert.deepEqual(Buffer.from(await (await fetch(base + cover.url)).arrayBuffer()), png);
    const native = (await api(`/wp-json/wp/v2/media/${first.id}`)).data; assert.ok(native.image.src.endsWith(cover.url)); assert.equal(native.media_details.album, "Embedded album");
    const archive = (await api("/api/tools/export")).data, sourceIds = new Set([first.id, second.id, cover.id]);
    const records = archive.media.filter((item: any) => sourceIds.has(item.id)), names = new Set(records.flatMap((item: any) => [item.filename, ...Object.values(item.sizes || {}).map((size: any) => size.filename)]));
    const files = archive.mediaFiles.filter((file: any) => names.has(file.filename));
    const copied = await api("/api/tools/import", "POST", { application: "WorldAct", version: 3, posts: [], media: records, mediaFiles: files }); assert.equal(copied.response.status, 201, JSON.stringify(copied.data)); copied.data.mediaIds.forEach((id: number) => ids.add(id));
    const exported = (await api("/api/tools/export")).data, restored = exported.media.filter((item: any) => copied.data.mediaIds.includes(item.id)), restoredImage = restored.find((item: any) => item.mime_type === "image/png");
    assert.ok(restoredImage); assert.notEqual(restoredImage.id, cover.id);
    for (const item of restored.filter((row: any) => row.mime_type === "audio/wav")) { assert.equal(item.artwork_media_id, restoredImage.id); assert.equal(item.audio_metadata.artist, "Embedded artist"); }
    const forged = { ...records.find((item: any) => item.id === first.id), artwork_media_id: first.id };
    const detached = await api("/api/tools/import", "POST", { application: "WorldAct", version: 3, posts: [], media: [forged], mediaFiles: files.filter((file: any) => file.filename === forged.filename) }); assert.equal(detached.response.status, 201); detached.data.mediaIds.forEach((id: number) => ids.add(id));
    assert.ok(detached.data.warnings.some((warning: string) => /artwork.*detached/i.test(warning))); assert.equal((await api(`/api/media/${detached.data.mediaIds[0]}`)).data.media.image, null);
    const invalid = await upload(wave(Buffer.from('<svg onload="bad()"><script>bad()</script></svg>'), "image/png"), "invalid-art.wav"); assert.equal(invalid.artworkMediaId, null); assert.equal(invalid.image, null);
    const linked = await upload(wave(Buffer.from("https://unreachable-source.example.test/cover.png"), "-->"), "linked-art.wav"); assert.equal(linked.artworkMediaId, null);
    await api(`/api/media/${cover.id}`, "DELETE"); ids.delete(cover.id);
    assert.equal((await api(`/api/media/${first.id}`)).data.media.artworkMediaId, null); assert.equal((await api(`/api/media/${second.id}`)).data.media.image, null);
  } finally {
    for (const id of ids) await api(`/api/media/${id}`, "DELETE");
    if (cookie) await api("/api/auth/logout", "POST", {});
  }
});

test("legacy playlist public and native previews retain verified covers after a full-site copy", async () => {
  const base = process.env.TEST_API_URL || "http://127.0.0.1:3001", origin = process.env.APP_ORIGIN || "http://127.0.0.1:5173";
  const mediaIds = new Set<number>(), postIds = new Set<number>(); let cookie = "";
  const api = async (route: string, method = "GET", body?: unknown, auth = cookie) => {
    const response = await fetch(base + route, { method, headers: { Origin: origin, "Content-Type": "application/json", ...(auth ? { Cookie: auth } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const data = await response.json(); assert.ok(response.ok, `${route}: ${response.status} ${JSON.stringify(data)}`); return { response, data };
  };
  const document = (html: string) => new DOMParser().parseFromString("<!doctype html><html><body>" + html + "</body></html>", "text/html");
  const tracks = (html: string) => JSON.parse(document(html).querySelector("[data-worldact-playlist]")!.getAttribute("data-worldact-playlist")!);
  try {
    const signed = await api("/api/auth/login", "POST", { login: process.env.ADMIN_EMAIL, password: process.env.ADMIN_PASSWORD }, ""); cookie = signed.response.headers.get("set-cookie")!.split(";")[0];
    const form = new FormData(); form.append("file", new Blob([new Uint8Array(wave(await image()))], { type: "audio/wav" }), "shortcode-artwork.wav");
    const uploaded = await fetch(base + "/api/media", { method: "POST", headers: { Origin: origin, Cookie: cookie }, body: form }); const upload = await uploaded.json(); assert.equal(uploaded.status, 201, JSON.stringify(upload));
    const audio = upload.media; mediaIds.add(audio.id); if (audio.artworkMediaId) mediaIds.add(audio.artworkMediaId); assert.ok(audio.artworkMediaId);
    const cover = (await api(`/api/media/${audio.artworkMediaId}`, "PUT", { alt: "Verified cover" })).data.media;
    const source = `[playlist ids="${audio.id}"]`;
    const post = (await api("/api/posts", "POST", { title: "Shortcode artwork " + Date.now().toString(36), status: "publish", content: source })).data.post; postIds.add(post.id);
    const publicHTML = (await api("/api/public/posts/" + post.slug, "GET", undefined, "")).data.post.content;
    assert.equal(tracks(publicHTML)[0].image, cover.url); assert.equal(tracks(publicHTML)[0].imageAlt, "Verified cover");
    assert.equal(document(publicHTML).querySelector(".wp-block-playlist-track__image")!.getAttribute("src"), cover.url);
    const preview = (await api("/wp-json/wp/v2/block-renderer/core/shortcode", "POST", { attributes: { text: source }, post_id: post.id })).data.rendered;
    assert.equal(tracks(preview)[0].image, cover.url);
    const hiddenPreview = (await api("/wp-json/wp/v2/block-renderer/core/shortcode", "POST", { attributes: { text: `[playlist ids="${audio.id}" images="false"]` }, post_id: post.id })).data.rendered;
    assert.equal(document(hiddenPreview).querySelector(".wp-block-playlist-track__image"), null);
    const archive = (await api("/api/tools/export")).data, records = archive.media.filter((item: any) => mediaIds.has(item.id));
    const names = new Set(records.flatMap((item: any) => [item.filename, ...Object.values(item.sizes || {}).map((size: any) => size.filename)]));
    const copied = (await api("/api/tools/import", "POST", { application: "WorldAct", version: 3, posts: archive.posts.filter((item: any) => item.id === post.id), media: records, mediaFiles: archive.mediaFiles.filter((file: any) => names.has(file.filename)) })).data;
    copied.mediaIds.forEach((id: number) => mediaIds.add(id)); copied.postIds.forEach((id: number) => postIds.add(id));
    const copies = await Promise.all(copied.mediaIds.map(async (id: number) => (await api(`/api/media/${id}`)).data.media));
    const newAudio = copies.find((item: any) => item.mimeType === "audio/wav"), newCover = copies.find((item: any) => item.mimeType === "image/png");
    assert.ok(newAudio && newCover); assert.equal(newAudio.artworkMediaId, newCover.id); assert.notEqual(newCover.url, cover.url);
    const copy = (await api(`/api/posts/${copied.postIds[0]}`)).data.post;
    assert.match(copy.rawContent, new RegExp(`ids="${newAudio.id}"`));
    const copiedHTML = (await api("/api/public/posts/" + copy.slug, "GET", undefined, "")).data.post.content;
    assert.equal(tracks(copiedHTML)[0].image, newCover.url); assert.equal(tracks(copiedHTML)[0].imageAlt, "Verified cover");
    await api(`/api/media/${newCover.id}`, "DELETE"); mediaIds.delete(newCover.id);
    const detachedHTML = (await api("/api/public/posts/" + copy.slug, "GET", undefined, "")).data.post.content;
    assert.equal(tracks(detachedHTML)[0].image, ""); assert.equal(document(detachedHTML).querySelector(".wp-block-playlist-track__image"), null);
  } finally {
    for (const id of postIds) { await api(`/api/posts/${id}`, "PUT", { status: "trash" }); await api(`/api/posts/${id}`, "DELETE"); }
    for (const id of mediaIds) await api(`/api/media/${id}`, "DELETE");
    if (cookie) await api("/api/auth/logout", "POST", {});
  }
});
