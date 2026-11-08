import test, { after } from "./isolated-test.js";
import "dotenv/config";
import assert from "node:assert/strict";
import { DOMParser } from "linkedom";
import { XMLParser } from "fast-xml-parser";
import { pool } from "../server/db.js";
import { parseFootnotes, serializeFootnotes, freshFootnoteIds, renderFootnotes } from "../server/footnotes.js";
import { excerptText } from "../server/excerpts.js";
import { cleanContent } from "../server/utils.js";
import { remapImportedBlockReferences } from "../server/block-portability.js";

after(async () => { await pool.end(); });
const block = (name: string, attrs: unknown = {}, html = "") => `<!-- wp:${name} ${JSON.stringify(attrs)}${html ? " -->" + html + `<!-- /wp:${name} -->` : " /-->"}`;
const reference = (id: string, ordinal = 1) => `<sup data-fn="${id}" class="fn"><a href="#${id}" id="${id}-link">${ordinal}</a></sup>`;
const body = (id: string, text = "Readable body") => block("paragraph", {}, `<p>${text}${reference(id)}</p>`) + block("footnotes");
const notes = [{ id: "source-note", content: "A <strong>rich note</strong> with <a href=\"https://example.test/\" rel=\"noopener noreferrer\">citation</a>" }];
const dom = (html: string) => new DOMParser().parseFromString(html, "text/html");

test("footnote metadata round trips rich text, rejects ambiguous IDs and bounds its complete JSON envelope", () => {
  assert.deepEqual(parseFootnotes(serializeFootnotes(notes)), notes);
  assert.deepEqual(parseFootnotes(""), []);
  for (const value of [null, {}, "broken", [{ id: "unsafe id", content: "x" }], [...notes, ...notes], [{ ...notes[0], extra: true }], Array.from({ length: 501 }, (_, i) => ({ id: "n" + i, content: "" }))]) assert.throws(() => parseFootnotes(value));
  assert.throws(() => parseFootnotes([{ id: "a", content: "x".repeat(20001) }]));
  const nearLimit = Array.from({ length: 450 }, (_, i) => ({ id: "n" + i + "x".repeat(96), content: "a".repeat(1950) }));
  assert.deepEqual(parseFootnotes(serializeFootnotes(nearLimit)), nearLimit);
  assert.throws(() => parseFootnotes(Array.from({ length: 500 }, (_, i) => ({ id: "n" + i + "x".repeat(96), content: "a".repeat(1950) }))));
  const safe = parseFootnotes([{ id: "safe", content: '<strong onclick="bad()">Kept</strong><script>bad()</script><a href="javascript:bad()">Bad link</a>' }]);
  assert.match(safe[0].content, /<strong>Kept<\/strong>/); assert.doesNotMatch(safe[0].content, /onclick|script|javascript/);
  assert.match(cleanContent(reference("source-note")), /data-fn="source-note"/);
  assert.doesNotMatch(cleanContent('<p data-fn="safe">Text</p><sup data-fn="unsafe id">1</sup>'), /data-fn/);
  assert.equal(renderFootnotes({ footnotes: notes, hasPassword: true }, () => ""), "");
  assert.equal(renderFootnotes({ footnotes: notes, locked: true }, () => ""), "");
  assert.match(renderFootnotes({ footnotes: notes, hasPassword: true, locked: false }, () => ' class="wp-block-footnotes"'), /Jump to footnote reference 1/);
  const generated = freshFootnoteIds(notes, reference("orphan-note"));
  assert.equal(generated.size, 2); assert.notEqual(generated.get(notes[0].id), notes[0].id);
  assert.throws(() => freshFootnoteIds([], Array.from({ length: 501 }, (_, i) => reference("n" + i)).join("")));
});

test("automatic excerpts omit reference ordinals and note bodies, and copies rewrite only their own footnote URLs", () => {
  const html = `<p>Before${reference("source-note")} after</p>` + renderFootnotes({ footnotes: notes }, () => ' class="wp-block-footnotes"');
  assert.equal(excerptText(html), "Before after");
  const urls = new Map([["https://old.test/post/", "/copy/"], ["/post/", "/copy/"]]);
  const input = body("source-note") + '<p>Plain source-note <a href="/post/#source-note">Self</a> <a href="https://old.test/post/#source-note-link">Back</a> <a href="https://other.test/post/#source-note">Foreign</a> <a href="/other/#source-note">Another post</a></p>';
  const copied = remapImportedBlockReferences(input, [{ name: "core/paragraph", attributes: { content: reference("source-note") }, innerBlocks: [] }], new Map(), { urls, footnotes: new Map([["source-note", "fresh-note"]]), footnoteSelfURLs: new Set(["/post/", "/copy/", "https://old.test/post/"]) });
  assert.match(copied.rawContent, /data-fn="fresh-note"/); assert.match(copied.rawContent, /id="fresh-note-link"/);
  assert.match(copied.rawContent, /href="\/copy\/#fresh-note"/); assert.match(copied.rawContent, /href="\/copy\/#fresh-note-link"/);
  assert.match(copied.rawContent, /https:\/\/other.test\/post\/#source-note/); assert.match(copied.rawContent, /\/other\/#source-note/);
  assert.match(copied.rawContent, /Plain source-note/); assert.match(String(copied.blocks[0].attributes.content), /fresh-note/);
  for (const foreign of ["https://foreign.test/?next=/post/#source-note", "https://foreign.test/x=/post/#source-note", "https://foreign.test/x(/post/#source-note", "//foreign.test/?next=/post/#source-note", "https://foreign.test/?next=https://old.test/post/#source-note", "https://foreign.test/?next=,x=/post/#source-note"]) {
    const untouched = remapImportedBlockReferences(`<a href="${foreign}">Foreign</a>`, [], new Map(), { urls });
    assert.equal(untouched.rawContent, cleanContent(`<a href="${foreign}">Foreign</a>`));
  }
});

const root = process.env.TEST_API_URL || "http://127.0.0.1:3001", origin = process.env.APP_ORIGIN || "http://127.0.0.1:5173";
async function api(path: string, method = "GET", data?: unknown, cookie = "") {
  const response = await fetch(root + path, { method, headers: { Origin: origin, "Content-Type": "application/json", ...(cookie ? { Cookie: cookie } : {}) }, ...(data === undefined ? {} : { body: JSON.stringify(data) }) });
  return { response, data: await response.json() };
}

test("footnotes stay atomic across editorial saves, revisions, actor previews, protected reads and portable copies", async t => {
  const stamp = "footnote-" + Date.now().toString(36), postIds: number[] = [], userIds: number[] = [];
  const login = await api("/api/auth/login", "POST", { login: process.env.ADMIN_EMAIL, password: process.env.ADMIN_PASSWORD });
  assert.equal(login.response.status, 200); const admin = login.response.headers.get("set-cookie")!.split(";")[0];
  const people: Record<string, { id: number; cookie: string }> = {};
  const create = async (extra: Record<string, unknown> = {}) => {
    const r = await api("/api/posts", "POST", { title: stamp, content: body("source-note"), footnotes: notes, ...extra }, admin);
    assert.equal(r.response.status, 201, JSON.stringify(r.data)); postIds.push(r.data.post.id); return r.data.post;
  };
  try {
    for (const role of ["editor", "contributor"]) {
      const r = await api("/api/users", "POST", { username: stamp + role, email: stamp + role + "@example.test", displayName: stamp + role, password: "Footnote-test-" + stamp, role }, admin);
      assert.equal(r.response.status, 201); userIds.push(r.data.user.id);
      const signed = await api("/api/auth/login", "POST", { login: stamp + role, password: "Footnote-test-" + stamp });
      people[role] = { id: r.data.user.id, cookie: signed.response.headers.get("set-cookie")!.split(";")[0] };
    }
    await t.test("footnote-only saves create restorable revisions and omission preserves metadata", async () => {
      let post = await create(); const route = "/api/posts/" + post.id;
      assert.deepEqual(post.footnotes, notes);
      const changed = [{ id: "source-note", content: "Changed <em>only note</em>" }];
      post = (await api(route, "PUT", { version: post.version, footnotes: changed }, admin)).data.post;
      assert.deepEqual(post.footnotes, changed);
      const revisions = (await api(route + "/revisions", "GET", undefined, admin)).data.revisions;
      const previous = revisions.find((r: any) => r.footnotes[0]?.content === notes[0].content); assert.ok(previous);
      post = (await api(route, "PUT", { title: stamp + " preserve", version: post.version }, admin)).data.post; assert.deepEqual(post.footnotes, changed);
      post = (await api(route + "/revisions/" + previous.id + "/restore", "POST", { version: post.version }, admin)).data.post; assert.deepEqual(post.footnotes, notes);
      post = (await api(route, "PUT", { version: post.version, footnotes: [] }, admin)).data.post; assert.deepEqual(post.footnotes, []);
      assert.equal((await api(route, "PUT", { footnotes: [...notes, ...notes] }, admin)).response.status, 400);
    });
    await t.test("autosaves pair body and notes; previews are actor scoped, version matched and unpublished", async () => {
      let post = await create({ status: "publish" }); const route = "/api/posts/" + post.id;
      const unsaved = [{ id: "unsaved-note", content: "UNSAVED <strong>NOTE</strong>" }];
      const saved = await api(route + "/autosave", "PUT", { version: post.version, title: "Unsaved title", content: body("unsaved-note", "UNSAVED BODY") + block("post-comments-form"), footnotes: unsaved }, admin);
      assert.equal(saved.response.status, 200); assert.deepEqual(saved.data.autosave.footnotes, unsaved);
      const preview = await api(route + "/preview", "GET", undefined, admin);
      assert.match(preview.data.post.content, /UNSAVED BODY/); assert.match(preview.data.post.content, /UNSAVED <strong>NOTE/);
      assert.equal(dom(preview.data.post.content).querySelector("form"), null, "Previews must not expose a working comment form.");
      assert.equal(preview.response.headers.get("cache-control"), "private, no-store");
      const template = await api("/api/public/templates/single?preview=true&postId=" + post.id, "GET", undefined, admin);
      assert.equal(template.response.status, 200); assert.match(template.data.content, /UNSAVED BODY/); assert.match(template.data.content, /UNSAVED <strong>NOTE/);
      assert.doesNotMatch((await api(route + "/preview", "GET", undefined, people.editor.cookie)).data.post.content, /UNSAVED/);
      assert.doesNotMatch((await api("/api/public/posts/" + post.slug)).data.post.content, /UNSAVED/);
      assert.equal((await api(route + "/autosave", "PUT", { version: post.version + 1, footnotes: [] }, admin)).response.status, 409);
      await api(route + "/lock", "PUT", {}, people.editor.cookie);
      assert.equal((await api(route + "/autosave", "PUT", { version: post.version, footnotes: [] }, admin)).response.status, 409);
      await api(route + "/lock", "DELETE", undefined, people.editor.cookie);
      // Another editor's save makes this actor's old autosave ineligible for preview.
      post = (await api(route, "PUT", { version: post.version, title: "Newer saved version" }, people.editor.cookie)).data.post;
      assert.doesNotMatch((await api(route + "/preview", "GET", undefined, admin)).data.post.content, /UNSAVED/);
      assert.deepEqual((await api(route, "GET", undefined, admin)).data.post.footnotes, notes);
    });
    await t.test("native REST metadata, schemas and server previews enforce content capabilities", async () => {
      const post = await create({ status: "private", authorId: people.contributor.id });
      const route = "/wp-json/wp/v2/posts/" + post.id;
      const read = await api(route + "?context=edit", "GET", undefined, people.contributor.cookie);
      assert.equal(read.response.status, 200); assert.deepEqual(JSON.parse(read.data.meta.footnotes), notes);
      const updated = await api(route, "POST", { meta: { footnotes: JSON.stringify([{ id: "source-note", content: "Native note" }]) } }, people.contributor.cookie);
      assert.equal(updated.response.status, 200); assert.equal(JSON.parse(updated.data.meta.footnotes)[0].content, "Native note");
      const schema = await api(route, "OPTIONS", undefined, people.contributor.cookie); assert.equal(schema.data.schema.properties.meta.properties.footnotes.type, "string");
      const ssr = "/wp-json/wp/v2/block-renderer/core/footnotes?context=edit&post_id=" + post.id;
      assert.match((await api(ssr, "GET", undefined, people.contributor.cookie)).data.rendered, /Native note/);
      const other = await create({ status: "private" });
      assert.equal((await api("/wp-json/wp/v2/block-renderer/core/footnotes?post_id=" + other.id, "GET", undefined, people.contributor.cookie)).response.status, 403);
      for (const status of ["publish", "future", "trash"]) {
        await pool.query("UPDATE posts SET status=$1::varchar,pre_trash_status=CASE WHEN $1::varchar='trash' THEN 'publish' ELSE NULL END WHERE id=$2", [status, post.id]);
        assert.equal((await api(ssr, "GET", undefined, people.contributor.cookie)).response.status, 403);
        assert.equal((await api(route, "POST", { meta: { footnotes: "[]" } }, people.contributor.cookie)).response.status, 403);
      }
    });
    await t.test("locked public responses clear metadata; unlocking renders rich notes and automatic excerpts omit them", async () => {
      const post = await create({ status: "publish", password: "Protected-footnotes-" + stamp });
      const locked = await api("/api/public/posts/" + post.slug); assert.deepEqual(locked.data.post.footnotes, []); assert.doesNotMatch(locked.data.post.content, /rich note|Readable body/);
      const rest = await api("/wp-json/wp/v2/posts/" + post.id); assert.equal(rest.data.meta.footnotes, "[]"); assert.doesNotMatch(rest.data.content.rendered, /rich note/);
      const unlocked = await api("/api/public/posts/" + post.slug + "/unlock", "POST", { password: "Protected-footnotes-" + stamp });
      assert.equal(unlocked.response.status, 200); const cookie = unlocked.response.headers.get("set-cookie")!.split(";")[0];
      const accessible = await api("/api/public/posts/" + post.slug, "GET", undefined, cookie); assert.match(accessible.data.post.content, /<strong>rich note<\/strong>/); assert.equal(dom(accessible.data.post.content).querySelectorAll("ol.wp-block-footnotes li").length, 1);
      const open = await create({ status: "publish" });
      const restOpen = await api("/wp-json/wp/v2/posts/" + open.id); assert.match(restOpen.data.excerpt.rendered, /Readable body/); assert.doesNotMatch(restOpen.data.excerpt.rendered, /rich note|citation|body1/);
      const excerpt = await api("/wp-json/wp/v2/block-renderer/core/post-excerpt?post_id=" + open.id, "GET", undefined, admin); assert.doesNotMatch(excerpt.data.rendered, /rich note|citation|body1/);
      const feed = await fetch(root + "/feed"); assert.doesNotMatch(await feed.text(), /Readable body1/);
    });
    await t.test("JSON and WXR copies receive fresh linked fragments and invalid note metadata rolls back", async () => {
      const post = await create({ status: "publish", slug: stamp + "-portable" });
      const archive = (await api("/api/tools/export", "GET", undefined, admin)).data;
      const record = archive.posts.find((p: any) => p.id === post.id); assert.deepEqual(record.footnotes, notes);
      const ownURL = record.permalink;
      record.raw_content += `<p><a href="${ownURL}#source-note">Self note</a><a href="https://elsewhere.test${ownURL}#source-note">Foreign note</a></p>`;
      record.blocks = [{ name: "core/paragraph", attributes: { content: reference("source-note") }, innerBlocks: [] }];
      const copied = await api("/api/tools/import", "POST", { application: "WorldAct", version: 3, posts: [record] }, admin);
      assert.equal(copied.response.status, 201, JSON.stringify(copied.data)); postIds.push(...copied.data.postIds);
      const copy = (await api("/api/posts/" + copied.data.postIds[0], "GET", undefined, admin)).data.post;
      const id = copy.footnotes[0].id; assert.notEqual(id, "source-note"); assert.match(copy.rawContent, new RegExp('data-fn="' + id + '"')); assert.match(copy.rawContent, new RegExp('href="' + copy.permalink + '#' + id + '"'));
      assert.ok(copy.rawContent.includes(`https://elsewhere.test${ownURL}#source-note`)); assert.match(copy.blocks[0].attributes.content, new RegExp(id));
      const before = (await pool.query("SELECT count(*)::int AS n FROM posts")).rows[0].n;
      const bad = await api("/api/tools/import", "POST", { application: "WorldAct", version: 3, posts: [{ ...record, id: 91231 }, { ...record, id: 91232, slug: stamp + "-bad", footnotes: [...notes, ...notes] }] }, admin);
      assert.equal(bad.response.status, 400); assert.equal((await pool.query("SELECT count(*)::int AS n FROM posts")).rows[0].n, before);
      const wxrResponse = await fetch(root + "/api/tools/export?format=wxr", { headers: { Cookie: admin } }); assert.equal(wxrResponse.status, 200);
      const xml = await wxrResponse.text(), parsed = new XMLParser({ ignoreAttributes: false, parseTagValue: false }).parse(xml);
      const item = parsed.rss.channel.item.find((p: any) => Number(p["wp:post_id"]) === post.id);
      const metadata = Array.isArray(item["wp:postmeta"]) ? item["wp:postmeta"] : [item["wp:postmeta"]];
      assert.deepEqual(JSON.parse(metadata.find((m: any) => m["wp:meta_key"] === "footnotes")["wp:meta_value"]), notes);
      const exportedItem = xml.match(/<item>[\s\S]*?<\/item>/g)!.find(entry => entry.includes(`<wp:post_id>${post.id}</wp:post_id>`))!;
      const minimal = `<rss xmlns:wp="http://wordpress.org/export/1.2/" xmlns:content="http://purl.org/rss/1.0/modules/content/" xmlns:excerpt="http://wordpress.org/export/1.2/excerpt/" xmlns:dc="http://purl.org/dc/elements/1.1/"><channel><wp:wxr_version>1.2</wp:wxr_version>${exportedItem}</channel></rss>`;
      const imported = await api("/api/tools/import", "POST", { format: "wxr", xml: minimal }, admin); assert.equal(imported.response.status, 201, JSON.stringify(imported.data)); postIds.push(...imported.data.postIds);
      const wxrCopy = (await api("/api/posts/" + imported.data.postIds[0], "GET", undefined, admin)).data.post;
      assert.notEqual(wxrCopy.footnotes[0].id, "source-note"); assert.match(wxrCopy.rawContent, new RegExp(wxrCopy.footnotes[0].id)); assert.equal(wxrCopy.footnotes[0].content, notes[0].content);
    });
  } finally {
    await pool.query("DELETE FROM posts WHERE id=ANY($1::int[])", [postIds]);
    await pool.query("DELETE FROM users WHERE id=ANY($1::int[])", [userIds]);
    await api("/api/auth/logout", "POST", undefined, admin);
  }
});
