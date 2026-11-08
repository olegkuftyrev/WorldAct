import test, { after } from "./isolated-test.js";
import assert from "node:assert/strict";
import sharp from "sharp";
import { parseHTML } from "linkedom";
import { pool } from "../server/db.js";
import { classicMediaHTML } from "../src/editor/classic/content.js";
import { attachment } from "../src/editor/mediaAttachment.js";

after(() => pool.end());
const base = process.env.TEST_API_URL!, origin = process.env.APP_ORIGIN!;
test("real initial attachment captions retain rich/literal source through saves, public rendering and JSON copies", async () => {
  let cookie = ""; const posts: number[] = [], media: number[] = [], stamp = "classic-caption-" + Date.now();
  async function api(route: string, method = "GET", body?: unknown) {
    const response = await fetch(base + route, { method, headers: { Origin: origin, Cookie: cookie, "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
    const data = await response.json(); assert.ok(response.ok, route + ": " + response.status + " " + JSON.stringify(data)); return { response, data };
  }
  const dom = (html: string) => parseHTML('<html><body>' + html + '</body></html>').document;
  try {
    const signed = await api("/api/auth/login", "POST", { login: process.env.ADMIN_EMAIL, password: process.env.ADMIN_PASSWORD }); cookie = signed.response.headers.get("set-cookie")!.split(";")[0];
    const bytes = await sharp({ create: { width: 640, height: 480, channels: 3, background: "#2685a4" } }).png().toBuffer();
    const form = new FormData(); form.append("file", new Blob([new Uint8Array(bytes)], { type: "image/png" }), stamp + ".png");
    const uploaded = await fetch(base + "/api/media", { method: "POST", headers: { Origin: origin, Cookie: cookie }, body: form }); assert.equal(uploaded.status, 201); const initial = (await uploaded.json()).media; media.push(initial.id);
    for (const caption of ['Rich <strong>caption</strong> <em>emphasis</em> <a href="/safe" onclick="bad()">link</a> &lt;b&gt;literal&lt;/b&gt; &amp; 2 < 3', 'Literal [/caption] [gallery ids="1"] &lt;img src=x onerror=&quot;bad()&quot;&gt;']) {
      const saved = (await api("/api/media/" + initial.id, "PUT", { caption, alt: "Caption image" })).data.media;
      const source = classicMediaHTML(attachment(saved)); assert.match(source, /^\[caption /); assert.doesNotMatch(source, /<figure|mceTemp|<dl/);
      const blocks = [{ name: "core/freeform", attributes: { content: source }, innerBlocks: [] }];
      const post = (await api("/api/posts", "POST", { title: stamp + " " + posts.length, status: "publish", content: source, blocks })).data.post; posts.push(post.id);
      assert.equal(post.blocks[0].attributes.content, source);
      const reloaded = (await api("/api/posts/" + post.id)).data.post;
      assert.equal(reloaded.blocks[0].attributes.content, source); assert.doesNotMatch(reloaded.rawContent, /mceTemp|data-mce/);
      const publicPost = (await api("/api/public/posts/" + post.slug)).data.post, document = dom(publicPost.content), figure = document.querySelector("figure.wp-caption")!;
      assert.ok(figure, JSON.stringify({ source, content: publicPost.content })); assert.equal(figure.querySelectorAll("img").length, 1); assert.equal(figure.querySelector("img")!.getAttribute("width"), "640");
      const text = figure.querySelector("figcaption")!;
      assert.equal(document.querySelectorAll("script,iframe,.gallery").length, 0);
      if (caption.startsWith("Rich")) { assert.equal(text.querySelector("strong")!.textContent, "caption"); assert.equal(text.querySelector("em")!.textContent, "emphasis"); assert.equal(text.querySelector("a")!.getAttribute("href"), "/safe"); assert.match(text.textContent!, /<b>literal<\/b> & 2 < 3/); }
      else { assert.match(text.textContent!, /Literal \[\/caption\] \[gallery ids="1"\]/); assert.match(text.textContent!, /<img src=x onerror="bad\(\)">/); }
      const archive = (await api("/api/tools/export")).data, record = archive.media.find((item: any) => item.id === initial.id);
      const names = new Set([record.filename, record.original_filename, ...Object.values(record.derivatives || {}), ...Object.values(record.sizes || {}).map((size: any) => size.filename)].filter(Boolean));
      const copy = (await api("/api/tools/import", "POST", { application: "WorldAct", version: 3, posts: [{ ...reloaded, id: 2147483000, slug: stamp + "-copy-" + posts.length, title: stamp + " copy", status: "publish" }], media: [record], mediaFiles: archive.mediaFiles.filter((file: any) => names.has(file.filename)) })).data; posts.push(...copy.postIds); media.push(...copy.mediaIds);
      const copied = (await api("/api/posts/" + copy.postIds[0])).data.post, copySource = copied.blocks[0].attributes.content;
      assert.match(copySource, new RegExp('attachment_' + copy.mediaIds[0])); assert.doesNotMatch(copySource, /attachment-missing|wp-image-missing|mceTemp/);
      const copyPublic = (await api("/api/public/posts/" + copied.slug)).data.post;
      assert.equal(dom(copyPublic.content).querySelector("figcaption")!.textContent, text.textContent);
    }
    const empty = (await api("/api/media/" + initial.id, "PUT", { caption: "" })).data.media;
    assert.match(classicMediaHTML(attachment(empty)), /^<img /);
  } finally {
    for (const id of posts) { await api("/api/posts/" + id, "PUT", { status: "trash" }); await api("/api/posts/" + id, "DELETE"); }
    for (const id of media) await api("/api/media/" + id, "DELETE");
    if (cookie) await api("/api/auth/logout", "POST", {});
  }
});
