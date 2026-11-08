import "dotenv/config";
import assert from "node:assert/strict";
import test, { after } from "node:test";
import sharp from "sharp";
import { parse } from "@wordpress/block-serialization-default-parser";
import { pool } from "../server/db.js";
import { remapImportedBlockReferences } from "../server/block-portability.js";

after(async () => { await pool.end(); });
const block = (name: string, attributes: Record<string,unknown>, inner = "") => `<!-- wp:${name} ${JSON.stringify(attributes)}${inner ? " -->" + inner + "<!-- /wp:" + name + " -->" : " /-->"}`;

test("empty media maps detach canonical and JSON attachment identity while retaining original safe URLs", () => {
  const src = "https://source.example.test/audio.wav", source = block("playlist-track", { id: 71, src, title: "Original" }) + block("image", { id: 71, url: "https://source.example.test/image.png" }, '<figure><img src="https://source.example.test/image.png" class="wp-image-71"></figure>');
  const portable = remapImportedBlockReferences(source, [{ name: "core/audio", attributes: { id: 71, src }, innerBlocks: [] }, { name: "core/gallery", attributes: { ids: [71] }, innerBlocks: [] }], new Map(), { media: new Map() });
  const canonical = parse(portable.rawContent).filter(row => row.blockName);
  assert.ok(canonical.every(row => !Object.hasOwn(row.attrs || {}, "id"))); assert.match(portable.rawContent, /wp-image-missing/);
  assert.equal(portable.blocks[0].attributes.id, undefined); assert.equal(portable.blocks[0].attributes.src, src); assert.deepEqual(portable.blocks[1].attributes.ids, []); assert.ok(portable.warnings.length >= 2);
});

test("real WXR import cannot bind local attachment collisions in posts or reusable entities", async () => {
  const base = process.env.TEST_API_URL || "http://127.0.0.1:3001", origin = process.env.APP_ORIGIN || "http://127.0.0.1:5173", stamp = "wxr-media-" + Date.now().toString(36);
  let cookie = "", imageId = 0; const posts: number[] = [], entities: number[] = [];
  const api = async (route: string, method = "GET", body?: unknown) => { const response = await fetch(base + route, { method, headers: { Origin: origin, "Content-Type": "application/json", ...(cookie ? { Cookie: cookie } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }); return { response, data: await response.json() }; };
  try {
    const signed = await api("/api/auth/login", "POST", { login: process.env.ADMIN_EMAIL, password: process.env.ADMIN_PASSWORD }); assert.equal(signed.response.status, 200); cookie = signed.response.headers.get("set-cookie")!.split(";")[0];
    const bytes = await sharp({ create: { width: 4, height: 4, channels: 4, background: "#224466" } }).png().toBuffer(), form = new FormData(); form.append("file", new Blob([new Uint8Array(bytes)], { type: "image/png" }), stamp + ".png");
    const upload = await fetch(base + "/api/media", { method: "POST", headers: { Origin: origin, Cookie: cookie }, body: form }); assert.equal(upload.status, 201); const image = (await upload.json()).media; imageId = image.id;
    const before = (await pool.query("SELECT count(*)::int AS n FROM media")).rows[0].n;
    const sourceURL = "https://unreachable-source.example.test/source.png", audioURL = "https://unreachable-source.example.test/source.wav";
    const body = block("image", { id: imageId, url: sourceURL }, `<figure><img src="${sourceURL}" class="wp-image-${imageId}"></figure>`) + block("playlist-track", { id: imageId, src: audioURL, title: "Source track" }) + block("block", { ref: 900002 });
    const reusable = block("audio", { id: imageId, src: audioURL }, `<figure><audio src="${audioURL}" controls></audio></figure>`);
    const item = (id: number, type: string, raw: string) => `<item><title>${stamp} ${type}</title><wp:post_id>${id}</wp:post_id><wp:post_type>${type}</wp:post_type><wp:status>publish</wp:status><content:encoded><![CDATA[${raw}]]></content:encoded></item>`;
    const xml = `<?xml version="1.0"?><rss version="2.0" xmlns:wp="http://wordpress.org/export/1.2/" xmlns:content="http://purl.org/rss/1.0/modules/content/"><channel><title>Fixture</title><wp:wxr_version>1.2</wp:wxr_version>${item(900001, "post", body)}${item(900002, "wp_block", reusable)}<item><title>Remote attachment</title><wp:post_id>${imageId}</wp:post_id><wp:post_type>attachment</wp:post_type><wp:attachment_url>${sourceURL}</wp:attachment_url></item></channel></rss>`;
    const imported = await api("/api/tools/import", "POST", { format: "wxr", xml }); assert.equal(imported.response.status, 201, JSON.stringify(imported.data)); posts.push(...imported.data.postIds); entities.push(...imported.data.blockEntityIds);
    assert.equal(posts.length, 1); assert.equal(entities.length, 1); assert.equal(imported.data.skippedAttachments, 1); assert.ok(imported.data.warnings.some((warning: string) => /Detached missing media reference/.test(warning)));
    const post = (await api("/api/posts/" + posts[0])).data.post, canonical = parse(post.rawContent).filter(row => row.blockName);
    assert.equal(canonical.find(row => row.blockName === "core/image")!.attrs!.id, undefined); assert.equal(canonical.find(row => row.blockName === "core/playlist-track")!.attrs!.id, undefined); assert.equal(canonical.find(row => row.blockName === "core/block")!.attrs!.ref, entities[0]); assert.ok(post.rawContent.includes(sourceURL)); assert.ok(post.rawContent.includes(audioURL)); assert.ok(!post.rawContent.includes(image.url));
    const entity = (await pool.query("SELECT raw_content,blocks FROM block_entities WHERE id=$1", [entities[0]])).rows[0]; assert.equal(parse(entity.raw_content).find(row => row.blockName === "core/audio")!.attrs!.id, undefined); assert.ok(entity.raw_content.includes(audioURL));
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM media")).rows[0].n, before, "Remote attachment URLs must never create/download a media record");
    assert.equal((await api("/api/media/" + imageId)).data.media.filename, image.filename, "Unrelated existing media remains intact");
  } finally {
    for (const id of posts) { await api("/api/posts/" + id, "PUT", { status: "trash" }); await api("/api/posts/" + id, "DELETE"); }
    for (const id of entities) await api("/wp-json/wp/v2/blocks/" + id + "?force=true", "DELETE");
    if (imageId) await api("/api/media/" + imageId, "DELETE");
    if (cookie) await api("/api/auth/logout", "POST", {});
  }
});
