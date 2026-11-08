import test, { after } from "./isolated-test.js";
import "dotenv/config";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileTypeFromBuffer } from "file-type";
import { pool } from "../server/db.js";
import { detectMediaType } from "../server/media-types.js";

after(async () => { await pool.end(); });
const fixture = () => readFile(new URL("./fixtures/aac-tone.m4a", import.meta.url));

test("only the verified M4A signature receives the canonical audio MIME", async () => {
  const bytes = await fixture();
  assert.deepEqual(await fileTypeFromBuffer(bytes), { ext: "m4a", mime: "audio/x-m4a" });
  assert.deepEqual(await detectMediaType(bytes), { ext: "m4a", mime: "audio/mp4" });
  assert.equal(await detectMediaType(Buffer.from("This is not an M4A file.")), undefined);
  const genericMP4 = Buffer.from(bytes);
  // The ISO base-media brand is a different verified container, not the alias.
  genericMP4.write("isom", 8, "ascii");
  assert.deepEqual(await detectMediaType(genericMP4), { ext: "mp4", mime: "video/mp4" });
});

test("real AAC M4A uploads and embedded archive restores retain canonical MIME, metadata and fresh mapped bytes", async () => {
  const base = process.env.TEST_API_URL!, origin = process.env.APP_ORIGIN!;
  let cookie = "";
  const mediaIds = new Set<number>(), postIds = new Set<number>();
  const api = async (route: string, method = "GET", body?: unknown) => {
    const response = await fetch(base + route, { method, headers: { Origin: origin, "Content-Type": "application/json", ...(cookie ? { Cookie: cookie } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { response, data: await response.json() };
  };
  const upload = async (bytes: Buffer, mime: string) => {
    const form = new FormData(); form.append("file", new Blob([new Uint8Array(bytes)], { type: mime }), "canonical-aac.m4a");
    const response = await fetch(base + "/api/media", { method: "POST", headers: { Origin: origin, Cookie: cookie }, body: form });
    return { response, data: await response.json() };
  };
  const removeMedia = async (id: number) => {
    assert.equal((await api(`/api/media/${id}`, "DELETE")).response.status, 200); mediaIds.delete(id);
  };
  try {
    const signed = await api("/api/auth/login", "POST", { login: process.env.ADMIN_EMAIL, password: process.env.ADMIN_PASSWORD });
    assert.equal(signed.response.status, 200); cookie = signed.response.headers.get("set-cookie")!.split(";")[0];
    const bytes = await fixture();
    const uploaded = await upload(bytes, "text/plain");
    assert.equal(uploaded.response.status, 201, JSON.stringify(uploaded.data));
    const item = uploaded.data.media; mediaIds.add(item.id);
    assert.equal(item.mimeType, "audio/mp4"); assert.ok(item.filename.endsWith(".m4a"));
    assert.equal(item.audioMetadata.mime_type, "audio/mp4"); assert.equal(item.audioMetadata.length, 2);
    assert.equal(item.audioMetadata.sample_rate, 44100); assert.equal(item.audioMetadata.channels, 2);
    assert.match(item.audioMetadata.codec, /AAC/i); assert.equal(item.audioMetadata.filesize, bytes.length);
    const stored = (await pool.query("SELECT mime_type,audio_metadata FROM media WHERE id=$1", [item.id])).rows[0];
    assert.equal(stored.mime_type, "audio/mp4"); assert.equal(stored.audio_metadata.mime_type, "audio/mp4");
    const native = (await api(`/wp-json/wp/v2/media/${item.id}`)).data;
    assert.equal(native.mime_type, "audio/mp4"); assert.equal(native.media_details.mime_type, "audio/mp4");
    assert.equal(native.media_details.length, 2); assert.equal(native.media_details.sample_rate, 44100);
    const file = await fetch(base + item.url); assert.equal(file.status, 200);
    assert.match(file.headers.get("content-type")!, /^audio\/mp4(?:;|$)/);
    assert.deepEqual(Buffer.from(await file.arrayBuffer()), bytes);

    const raw = `<!-- wp:audio {"id":${item.id}} --><figure class="wp-block-audio"><audio controls src="${item.url}"></audio></figure><!-- /wp:audio -->`;
    const created = await api("/api/posts", "POST", { title: "M4A archive " + Date.now().toString(36), status: "draft", content: raw });
    assert.equal(created.response.status, 201); postIds.add(created.data.post.id);
    const exported = await api("/api/tools/export"); assert.equal(exported.response.status, 200);
    const archive = exported.data, record = archive.media.find((row: any) => row.id === item.id);
    const embedded = archive.mediaFiles.find((row: any) => row.filename === item.filename);
    assert.ok(embedded, "Verified M4A bytes are included in the archive");
    assert.equal(embedded.mimeType, "audio/mp4"); assert.equal(embedded.sha256, createHash("sha256").update(bytes).digest("hex"));
    assert.deepEqual(Buffer.from(embedded.data, "base64"), bytes);
    const payload = { application: "WorldAct", version: 3, media: [{ ...record, audio_metadata: { mime_type: "video/mp4", length: 999, title: "Forged" } }], mediaFiles: [embedded], posts: archive.posts.filter((post: any) => post.id === created.data.post.id) };
    const restore = async () => {
      const restored = await api("/api/tools/import", "POST", payload);
      assert.equal(restored.response.status, 201, JSON.stringify(restored.data));
      restored.data.mediaIds.forEach((id: number) => mediaIds.add(id)); restored.data.postIds.forEach((id: number) => postIds.add(id));
      assert.equal(restored.data.mediaIds.length, 1); assert.equal(restored.data.postIds.length, 1);
      const copy = (await api(`/api/media/${restored.data.mediaIds[0]}`)).data.media;
      assert.notEqual(copy.id, item.id); assert.notEqual(copy.filename, item.filename);
      assert.equal(copy.mimeType, "audio/mp4"); assert.equal(copy.audioMetadata.mime_type, "audio/mp4");
      assert.equal(copy.audioMetadata.length, 2); assert.notEqual(copy.audioMetadata.title, "Forged");
      assert.deepEqual(Buffer.from(await (await fetch(base + copy.url)).arrayBuffer()), bytes);
      const copyNative = (await api(`/wp-json/wp/v2/media/${copy.id}`)).data;
      assert.equal(copyNative.mime_type, "audio/mp4"); assert.equal(copyNative.media_details.mime_type, "audio/mp4");
      const post = (await api(`/api/posts/${restored.data.postIds[0]}`)).data.post;
      assert.ok(post.rawContent.includes(copy.url)); assert.ok(!post.rawContent.includes(item.url));
      assert.match(post.rawContent, new RegExp('"id":' + copy.id + '(?:,|})'));
      return copy;
    };
    const firstCopy = await restore();
    await removeMedia(item.id); await removeMedia(firstCopy.id);
    assert.equal((await fetch(base + item.url)).status, 404);
    const freshCopy = await restore();
    assert.notEqual(freshCopy.id, firstCopy.id); assert.notEqual(freshCopy.url, firstCopy.url);

    const before = (await pool.query("SELECT count(*)::int AS n FROM media")).rows[0].n;
    for (const claimed of ["audio/mp4", "audio/x-m4a"]) {
      assert.equal((await upload(Buffer.from("Forged AAC bytes"), claimed)).response.status, 400);
    }
    const fake = Buffer.from("Not an MPEG4 audio container");
    const invalid = await api("/api/tools/import", "POST", { ...payload, posts: [], mediaFiles: [{ ...embedded, size: fake.length, data: fake.toString("base64"), sha256: createHash("sha256").update(fake).digest("hex") }] });
    assert.equal(invalid.response.status, 400); assert.match(invalid.data.error, /MIME signature/);
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM media")).rows[0].n, before);
  } finally {
    for (const id of postIds) { await api(`/api/posts/${id}`, "PUT", { status: "trash" }); await api(`/api/posts/${id}`, "DELETE"); }
    for (const id of mediaIds) await api(`/api/media/${id}`, "DELETE");
    if (cookie) await api("/api/auth/logout", "POST", {});
  }
});
