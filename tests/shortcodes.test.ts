import "dotenv/config";
import assert from "node:assert/strict";
import test, { after } from "node:test";
import { DOMParser } from "linkedom";
import sharp from "sharp";
import { readdir } from "node:fs/promises";
import { pool, defaultSettings, uploadsDir } from "../server/db.js";
import { parseShortcodes, shortcodeAttributes, stripBuiltinShortcodes, ShortcodeLimitError } from "../server/shortcode-parser.js";
import { renderPublicContent, renderSiteDocument, renderBlock } from "../server/block-renderer.js";
import { cleanRawContent, cleanBlocks } from "../server/utils.js";
import { remapImportedBlockReferences } from "../server/block-portability.js";
import { excerptText } from "../server/excerpts.js";

after(async () => { await pool.end(); });
const dom = (value: string) => new DOMParser().parseFromString("<!doctype html><html><body>" + value + "</body></html>", "text/html");
const block = (name: string, inner: string, attrs: Record<string,unknown> = {}) => `<!-- wp:${name} ${JSON.stringify(attrs)} -->${inner}<!-- /wp:${name} -->`;
const sample = (id: number, type = "image", extra: Record<string,unknown> = {}) => ({ id, title: "Media " + id, alt: "Alternative " + id, caption: "Caption <em>" + id + "</em>", mimeType: type + (type === "image" ? "/png" : type === "audio" ? "/wav" : "/mp4"), url: "/uploads/media-" + id + (type === "image" ? ".png" : type === "audio" ? ".wav" : ".mp4"), width: 640, height: 360, sizes: { thumbnail: { url: "/uploads/thumb-" + id + ".png", width: 150, height: 150 } }, audioMetadata: { artist: "Artist <Literal>", album: "Album", length_formatted: "0:02" }, ...extra });
function fixture(rows: any[] = [], parents: any[] = []) {
  let queries = 0;
  return { get queries() { return queries; }, db: { query: async (sql: string, args: any[] = []) => {
    if (sql.includes("FROM settings")) return { rows: [{ data: defaultSettings }] };
    queries++;
    if (sql.includes("FROM posts WHERE id")) return { rows: parents.filter(row => row.id === args[0]) };
    assert.match(sql, /FROM media m/); assert.doesNotMatch(sql, /p\.content|p\.raw_content|password_hash\s+AS/);
    let selected = rows.filter(row => row.mimeType.startsWith(String(args[0]).slice(0, -1)) && (args[4] ? args[1].includes(row.id) : row.parentId === args[2]) && !args[3].includes(row.id));
    if (sql.includes("array_position")) selected.sort((a,b) => args[1].indexOf(a.id) - args[1].indexOf(b.id));
    return { rows: selected };
  } } as any };
}

test("fixed parser handles quoted/nested/escaped tokens and excludes HTML attributes and inert elements", () => {
  assert.equal(shortcodeAttributes('ID="4,2" title=\'A quoted value\' bare=okay')["id"], "4,2");
  assert.equal(Object.getPrototypeOf(shortcodeAttributes('__proto__="bad" constructor=bad')), null);
  const pieces = parseShortcodes('Before [[gallery ids="4"]] [caption width="100"][audio src="/sound.wav"][/audio] Caption[/caption] [plugin value="literal"]');
  assert.equal(typeof pieces[1] === "object" && pieces[1].escaped, true);
  assert.equal(typeof pieces[3] === "object" && pieces[3].tag, "caption");
  for (const input of ['<code>[gallery ids="1"]</code>', '<pre>' + block("shortcode", '[gallery ids="1"]') + '</pre>', '<a title="[gallery ids=1]">Safe</a>', '<script>[audio src="/x.wav"]</script>', '<textarea>[gallery]</textarea>', '<!-- [gallery] -->']) assert.deepEqual(parseShortcodes(input), [input]);
  assert.deepEqual(parseShortcodes('[plugin attribute=\'[gallery ids="1"]\']Literal[/plugin]'), ['[plugin attribute=\'[gallery ids="1"]\']Literal[/plugin]']);
  assert.equal(parseShortcodes('<script>"<pre>" [gallery]</script>[audio src="/sound.wav"]').filter(piece => typeof piece !== "string").length, 1);
  assert.equal(stripBuiltinShortcodes('One [gallery ids="1"] [unknown] [[audio]] [caption width=100]Inner[/caption]'), 'One  [unknown] [audio] ');
  assert.equal(stripBuiltinShortcodes('[gallery]]'), ']');
  assert.throws(() => parseShortcodes('[gallery]'.repeat(1025)), ShortcodeLimitError);
  assert.throws(() => parseShortcodes('[caption]'.repeat(13) + '[/caption]'.repeat(13)), ShortcodeLimitError);
  const hostile = '[audio src="'.repeat(10000); assert.equal(parseShortcodes(hostile).join(""), hostile);
  assert.equal(excerptText('<p>Excerpt [gallery ids="1"] tail</p>'), "Excerpt  tail");
});

test("classic, canonical paragraphs and shortcode JSON render once with safe source media options", async () => {
  const data = fixture([sample(1), sample(2), sample(3, "audio"), sample(4, "video")]);
  const source = '[gallery ids="2,1" link="none" columns="2"] [audio src="/uploads/sound.wav" autoplay="false" loop="true" muted="true" preload="metadata"][/audio] [video src="/uploads/movie.mp4" width="320" height="180" poster="/uploads/poster.png"]Safe fallback[/video] [caption id="attachment_1" width="150"]<img src="/uploads/image.png" alt="Captioned">A <strong>caption</strong>[/caption] [embed]https://youtu.be/abcdefghijk[/embed] [unknown]';
  const output = dom(await renderSiteDocument({ content: cleanRawContent(source) }, { db: data.db }));
  assert.deepEqual([...output.querySelectorAll(".gallery img")].map(image => image.getAttribute("alt")), ["Alternative 2", "Alternative 1"]);
  assert.equal(output.querySelector(".gallery a"), null); assert.ok(output.querySelector(".gallery-columns-2"));
  assert.equal(output.querySelector(".gallery")!.getAttribute("style"), null, "the source HTML5 gallery leaves layout to theme CSS");
  assert.equal(output.querySelector("audio")!.hasAttribute("autoplay"), false); assert.ok(output.querySelector("audio")!.hasAttribute("loop")); assert.equal(output.querySelector("audio")!.getAttribute("preload"), "metadata");
  assert.equal(dom(await renderSiteDocument({ content: '[audio src="/sound.wav" autoplay="FALSE"]' }, { db: data.db })).querySelector("audio")!.hasAttribute("autoplay"), false);
  assert.equal(output.querySelector("video")!.getAttribute("width"), "320"); assert.match(output.querySelector("video")!.textContent!, /Safe fallback/);
  assert.equal(output.querySelector(".wp-caption-text strong")!.textContent, "caption"); assert.ok(output.querySelector(".wp-block-embed__wrapper")); assert.match(output.body.textContent!, /\[unknown\]/);
  const canonical = block("paragraph", '<p>Before [gallery ids="1"] After [[audio src="/uploads/escaped.wav"]]</p>') + block("shortcode", '[audio src="/uploads/native.wav"]');
  const rendered = dom(await renderSiteDocument({ rawContent: canonical }, { db: data.db }));
  assert.equal(rendered.querySelectorAll(".gallery").length, 1); assert.equal(rendered.querySelectorAll("audio").length, 1); assert.match(rendered.body.textContent!, /\[audio src="\/uploads\/escaped.wav"\]/);
  const json = cleanBlocks([{ name: "core/shortcode", attributes: { text: '[audio src="/uploads/json.wav"]' }, innerBlocks: [] }]);
  assert.equal(dom(await renderSiteDocument({ blocks: json }, { db: data.db })).querySelector("source")!.getAttribute("src"), "/uploads/json.wav");
  const paragraph = cleanBlocks([{ name: "core/paragraph", attributes: { content: '[audio src="/uploads/paragraph.wav"]' }, innerBlocks: [] }]);
  assert.equal(dom(await renderSiteDocument({ content: '<p>Stale snapshot</p>', blocks: paragraph }, { db: data.db })).querySelector("source")!.getAttribute("src"), "/uploads/paragraph.wav");
  assert.match(await renderBlock("core/shortcode", { text: '[audio src="/uploads/preview.wav"]' }, { db: data.db }), /preview.wav/);
  assert.equal((await renderBlock("core/shortcode", { text: 'First\n\nSecond' }, { db: data.db })).trim(), '<p>First</p>\n<p>Second</p>');
  assert.equal(dom(await renderSiteDocument({ rawContent: block("shortcode", '[unknown]') }, { db: data.db })).querySelector("p")!.textContent, "[unknown]");
  const inert = await renderSiteDocument({ rawContent: '<pre>' + block("shortcode", '[audio src="/uploads/never.wav"]') + '</pre><code>[gallery ids="1"]</code><a title="[audio src=evil]">Attribute</a>' }, { db: data.db });
  assert.equal(dom(inert).querySelector("audio"), null); assert.match(dom(inert).querySelector("pre")!.textContent!, /\[audio/);
  assert.equal(dom(inert).querySelector("pre p"), null);
});

test("attachment defaults use actual post context and block protected/private parent metadata", async () => {
  const data = fixture([sample(1, "image", { parentId: 10, parentStatus: "publish" }), sample(2, "image", { parentId: 11, parentStatus: "publish" }), sample(3, "image", { parentId: 12, parentStatus: "private" }), sample(4, "image", { parentId: 13, parentStatus: "publish", parentHasPassword: true })], [{ id: 12, status: "private" }, { id: 13, status: "publish", hasPassword: true }]);
  for (const id of [10,11]) { const html = dom(await renderPublicContent({ id, type: "post", status: "publish", slug: "fixture", content: "[gallery]", terms: [], parentId: null }, { db: data.db })); assert.equal(html.querySelector("img")!.getAttribute("alt"), "Alternative " + (id - 9)); }
  for (const shortcode of ['[gallery id="12"]', '[gallery id="13"]', '[gallery ids="3,4"]', '[gallery ids=""]', '[playlist ids="0"]']) assert.equal(await renderSiteDocument({ content: shortcode }, { db: data.db }), "");
  const lockedData = fixture(); const locked = await renderPublicContent({ id: 100, type: "post", status: "publish", slug: "locked", locked: true, hasPassword: true, content: '[gallery ids="1"] CONFIDENTIAL' }, { db: lockedData.db }); assert.match(locked, /post-password/); assert.doesNotMatch(locked, /CONFIDENTIAL/); assert.equal(lockedData.queries, 0);
});

test("legacy playlists share trusted audio state, while unsafe URLs/classes/attributes never execute", async () => {
  const data = fixture([sample(3, "audio"), sample(4, "audio")]);
  const output = dom(await renderSiteDocument({ content: '[playlist ids="4,3" style="dark" artists="true" tracknumbers="false"] [audio src="javascript:bad()"] [video src="https://user:secret@example.test/video.mp4"] [embed]https://notyoutube.invalid/anything[/embed]' }, { db: data.db }));
  const figure = output.querySelector("figure.wp-playlist")!; assert.ok(figure.classList.contains("wp-playlist-dark")); assert.equal(output.querySelectorAll("audio").length, 1); assert.equal(output.querySelector("[data-worldact-playlist-fallback] source"), null);
  const tracks = JSON.parse(figure.getAttribute("data-worldact-playlist")!); assert.equal(tracks[0].url, "/uploads/media-4.wav"); assert.equal(tracks[0].artist, "Artist ");
  assert.match(output.querySelector(".wp-block-playlist-track__artist")!.textContent!, /Artist <Literal>/); assert.equal(output.querySelector("iframe"), null); assert.equal(output.querySelector("[onclick]"), null);
  const caption = await renderSiteDocument({ content: '[caption width="100" caption="&lt;script&gt;evil()&lt;/script&gt;"]<img src="/image.png" onerror="evil()">[/caption]' }, { db: data.db }); assert.equal(dom(caption).querySelector("script"), null); assert.equal(dom(caption).querySelector("[onerror]"), null);
  const unknown = await renderSiteDocument({ content: '[plugin arg="literal"]No evaluation[/plugin]' }, { db: data.db }); assert.match(unknown, /\[plugin/);
  const video = dom(await renderSiteDocument({ content: '[video src="/movie.mp4"]<track kind="captions" src="/captions.vtt" srclang="en" label="English" default>[/video]' }, { db: data.db })); assert.equal(video.querySelector("track")!.getAttribute("srclang"), "en");
  const feed = dom(await renderSiteDocument({ content: '[playlist ids="3,4"]' }, { db: data.db, contentMode: "feed" })); assert.equal(feed.querySelector("audio"), null); assert.equal(feed.querySelectorAll("a").length, 2);
});

test("shortcode preparation bounds repeated raw and JSON expansion before joins and caches only metadata", async () => {
  const data = fixture([sample(1, "image", { caption: "x".repeat(20000) })]);
  await assert.rejects(renderSiteDocument({ content: '[gallery ids="1"]'.repeat(500) }, { db: data.db }), (error: any) => error.status === 413);
  assert.equal(data.queries, 1);
  const json = Array.from({ length: 500 }, () => ({ name: "core/shortcode", attributes: { text: '[gallery ids="1"]' }, innerBlocks: [] }));
  await assert.rejects(renderSiteDocument({ blocks: json }, { db: data.db }), (error: any) => error.status === 413);
  assert.equal(data.queries, 2, "Each independent render caches its own media query");
});

test("MathML equations and SVG integration subtrees keep shortcode-shaped text inert and unchanged", async () => {
  const equation = '<math display="block"><semantics><mtext>[gallery ids="1"]</mtext><annotation encoding="application/x-tex">\\text{[audio src="/uploads/never.wav"]}</annotation><annotation-xml encoding="text/html"><div>[playlist ids="1"]</div></annotation-xml></semantics></math>';
  const vector = '<svg><foreignObject><div>[video src="/uploads/never.mp4"]</div></foreignObject><text>[gallery ids="1"]</text></svg>';
  assert.deepEqual(parseShortcodes(equation + vector), [equation + vector]);
  const data = fixture();
  const output = dom(await renderSiteDocument({ rawContent: block("math", '<div class="wp-block-math">' + equation + '</div>', { latex: '\\text{[gallery ids="1"]}' }) + vector + '[audio src="/uploads/actual.wav"]' }, { db: data.db }));
  assert.equal(output.querySelectorAll("audio").length, 1); assert.equal(output.querySelectorAll(".gallery").length, 0); assert.equal(output.querySelectorAll("video").length, 0); assert.equal(data.queries, 0);
  assert.equal(output.querySelector("annotation")!.textContent, '\\text{[audio src="/uploads/never.wav"]}'); assert.match(output.querySelector("mtext")!.textContent!, /\[gallery ids="1"\]/); assert.equal(output.querySelector("source")!.getAttribute("src"), "/uploads/actual.wav");
  const json = cleanBlocks([{ name: "core/math", attributes: { latex: '[gallery ids="1"]', mathML: '<semantics><mtext>[audio src="/uploads/never.wav"]</mtext></semantics>', caption: '[gallery ids="1"]' }, innerBlocks: [] }]);
  const math = dom(await renderSiteDocument({ blocks: json }, { db: data.db })); assert.equal(math.querySelector("audio"), null); assert.match(math.querySelector("mtext")!.textContent!, /\[audio/); assert.equal(data.queries, 0);
  const portable = remapImportedBlockReferences(equation + vector, [], new Map(), { media: new Map([[1, 99]]) }); assert.match(portable.rawContent, /gallery ids="1"/); assert.doesNotMatch(portable.rawContent, /ids="99"/);
  assert.match(portable.rawContent, /worldact-inert-shortcodes/); assert.equal(dom(await renderSiteDocument({ rawContent: portable.rawContent }, { db: data.db })).querySelector("audio"), null);
  const copiedMath = remapImportedBlockReferences(block("math", equation, { latex: '[gallery ids="1"]', mathML: equation }), json, new Map(), { media: new Map([[1, 99]]) }); assert.doesNotMatch(copiedMath.rawContent, /ids=\\"99\\"/); assert.equal(copiedMath.blocks[0].attributes.latex, '[gallery ids="1"]'); assert.equal(data.queries, 0);
  const nested = '<svg onload="evil()"><foreignObject><span>' + equation + '<span>[gallery ids="1"]</span></span><script>evil()</script><img src="/image.png" onerror="evil()"></foreignObject></svg>';
  const saved = cleanRawContent(nested); assert.equal(cleanRawContent(cleanRawContent(saved)), saved, "Repeated canonical saves retain the inert context");
  const copied = remapImportedBlockReferences(saved, cleanBlocks([{ name: "core/html", attributes: { content: nested }, innerBlocks: [] }]), new Map(), { media: new Map([[1, 99]]) });
  assert.doesNotMatch(copied.rawContent, /ids="99"|onload|onerror|<script|evil\(\)/);
  const repeated = dom(await renderSiteDocument({ rawContent: cleanRawContent(copied.rawContent) + '[audio src="/uploads/outside.wav"]' }, { db: data.db })); assert.equal(repeated.querySelectorAll("audio").length, 1); assert.equal(repeated.querySelector("[onerror]"), null); assert.equal(data.queries, 0);
});

test("portable shortcode IDs and uploaded URLs remap in raw/JSON without falling back after detachment", async () => {
  const raw = '[gallery ids="2,9" id="4"] [playlist include="9"] [audio src="/uploads/old.wav"] [caption id="attachment_2" width="100"]<img src="/uploads/old.png">Caption[/caption] [[gallery ids="2"]] <code>[gallery ids="2"]</code>';
  const options = { media: new Map([[2, 22]]), posts: new Map([[4, 44]]), urls: new Map([["/uploads/old.wav", "/uploads/new.wav"], ["/uploads/old.png", "/uploads/new.png"]]) };
  const result = remapImportedBlockReferences(raw, [{ name: "core/shortcode", attributes: { text: '[gallery ids="2"]' }, innerBlocks: [] }], new Map(), options);
  assert.match(result.rawContent, /ids="22" id="44"/); assert.match(result.rawContent, /include="0"/); assert.match(result.rawContent, /\/uploads\/new.wav/); assert.match(result.rawContent, /attachment_22/); assert.match(result.rawContent, /\[\[gallery ids="2"\]\]/); assert.match(result.rawContent, /<code>\[gallery ids="2"\]<\/code>/); assert.equal(result.blocks[0].attributes.text, '[gallery ids="22"]'); assert.ok(result.warnings.length);
  const queryURLs = remapImportedBlockReferences('[audio src="/uploads/old.wav?one=1#play"] [embed]/uploads/old.wav?two=2[/embed]', [], new Map(), options); assert.match(queryURLs.rawContent, /new.wav\?one=1#play/); assert.match(queryURLs.rawContent, /new.wav\?two=2/);
  const detached = remapImportedBlockReferences('[gallery ids="2"] [gallery id="4"] [audio src="/uploads/missing.wav"]', [], new Map(), { media: new Map(), posts: new Map(), urls: new Map(), detachMissingShortcodeMediaURLs: true });
  const data = fixture([sample(99)]); assert.equal((await renderSiteDocument({ rawContent: detached.rawContent }, { db: data.db })).trim(), ""); assert.equal(data.queries, 0);
  assert.equal(await renderSiteDocument({ content: '[caption width="0" caption="Invalid width"][gallery ids="99"][/caption]' }, { db: data.db }), '[gallery ids="99"]'); assert.equal(data.queries, 0, "Source invalid-caption fallback does not recursively expand its body");
  const wxr = remapImportedBlockReferences('[audio src="https://source.example.test/uploads/original.wav"]', [], new Map(), { media: new Map(), urls: new Map() }); assert.match(wxr.rawContent, /source.example.test\/uploads\/original.wav/);
});

const base = process.env.TEST_API_URL || "http://127.0.0.1:3001", origin = process.env.APP_ORIGIN || "http://127.0.0.1:5173";
test("actual API preserves shortcode source through save/history/SSR/public and safe JSON/WXR imports", async () => {
  let cookie = ""; const posts: number[] = [], media: number[] = [], stamp = "shortcodes-" + Date.now().toString(36);
  const call = async (route: string, method = "GET", body?: unknown, auth = cookie) => { const response = await fetch(base + route, { method, headers: { Origin: origin, "Content-Type": "application/json", ...(auth ? { Cookie: auth } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }); return { response, data: await response.json() }; };
  const ok = async (route: string, method = "GET", body?: unknown, auth = cookie) => { const result = await call(route, method, body, auth); assert.ok(result.response.ok, `${route}: ${result.response.status} ${JSON.stringify(result.data)}`); return result.data; };
  try {
    const login = await call("/api/auth/login", "POST", { login: process.env.ADMIN_EMAIL, password: process.env.ADMIN_PASSWORD }, ""); assert.equal(login.response.status, 200); cookie = login.response.headers.get("set-cookie")!.split(";")[0];
    const bytes = await sharp({ create: { width: 8, height: 8, channels: 4, background: "#4488aa" } }).png().toBuffer();
    for (const title of ["included", "collision"]) { const form = new FormData(); form.append("file", new Blob([new Uint8Array(bytes)], { type: "image/png" }), stamp + title + ".png"); const result = await fetch(base + "/api/media", { method: "POST", headers: { Origin: origin, Cookie: cookie }, body: form }); assert.equal(result.status, 201); media.push((await result.json()).media.id); }
    const equation = '<math display="block"><semantics><annotation encoding="application/x-tex">[gallery ids="' + media[0] + '"]</annotation></semantics></math>';
    const source = block("shortcode", `[gallery ids="${media[0]}" link="none"]`) + '<p>[[audio src="/uploads/literal.wav"]] [unknown]</p>' + block("math", equation, { latex: '[gallery ids="' + media[0] + '"]' });
    const created = (await ok("/api/posts", "POST", { title: stamp, status: "publish", content: source })).post; posts.push(created.id); assert.match(created.rawContent, /\[gallery/); assert.doesNotMatch(created.rawContent, /gallery-item/);
    await ok("/api/media/" + media[0], "PUT", { attachedPostId: created.id });
    const publicPost = (await ok("/api/public/posts/" + created.slug, "GET", undefined, "")).post; assert.equal(dom(publicPost.content).querySelectorAll(".gallery img").length, 1); assert.match(dom(publicPost.content).body.textContent!, /\[audio/);
    assert.equal(dom(publicPost.content).querySelector("annotation")!.textContent, '[gallery ids="' + media[0] + '"]');
    const preview = await ok("/wp-json/wp/v2/block-renderer/core/shortcode", "POST", { attributes: { text: `[gallery ids="${media[0]}"]` }, post_id: created.id }); assert.equal(dom(preview.rendered).querySelectorAll(".gallery img").length, 1);
    const updated = (await ok("/api/posts/" + created.id, "PUT", { content: `[gallery ids="${media[1]}" link="none"]` })).post; assert.ok(updated.version > created.version);
    const revisions = (await ok(`/api/posts/${created.id}/revisions`)).revisions; assert.ok(revisions.some((row: any) => row.rawContent?.includes(`[gallery ids="${media[0]}"`)));
    const revision = revisions.find((row: any) => row.rawContent?.includes(`[gallery ids="${media[0]}"`)); await ok(`/api/posts/${created.id}/revisions/${revision.id}/restore`, "POST", {});
    const restored = (await ok(`/api/posts/${created.id}`)).post; assert.match(restored.rawContent, new RegExp(`gallery ids="${media[0]}"`));
    const defaults = [];
    for (let index = 0; index < 2; index++) { const post = (await ok("/api/posts", "POST", { title: stamp + " default " + index, status: "publish", content: "[gallery]" })).post; posts.push(post.id); defaults.push(post.id); await ok("/api/media/" + media[index], "PUT", { attachedPostId: post.id }); }
    const queryBody = block("query", block("post-template", block("post-content", "")), { query: { inherit: false, include: defaults, perPage: 2, postType: "post" } });
    const host = (await ok("/api/posts", "POST", { title: stamp + " query", status: "publish", content: queryBody })).post; posts.push(host.id);
    const queryOutput = dom((await ok("/api/public/posts/" + host.slug, "GET", undefined, "")).post.content);
    assert.equal(queryOutput.querySelectorAll(".gallery img").length, 2); assert.equal(new Set([...queryOutput.querySelectorAll(".gallery img")].map(image => image.getAttribute("src"))).size, 2, "Identical shortcode source must use each query post's own attachment parent");
    const archive = await ok("/api/tools/export"), item = archive.media.find((row: any) => row.id === media[0]);
    const imported = await ok("/api/tools/import", "POST", { application: "WorldAct", version: 3, posts: [{ ...archive.posts.find((row: any) => row.id === created.id), raw_content: `[gallery ids="${media[0]},${media[1]}"] [gallery ids="${media[1]}"]`, blocks: [] }], media: [item], mediaFiles: archive.mediaFiles.filter((file: any) => file.filename === item.filename || Object.values(item.sizes || {}).some((size: any) => size.filename === file.filename)) });
    posts.push(...imported.postIds); media.push(...imported.mediaIds); assert.ok(imported.warnings.some((warning: string) => /shortcode|gallery/.test(warning)));
    const copy = (await ok(`/api/posts/${imported.postIds[0]}`)).post; assert.match(copy.rawContent, new RegExp(`ids="${imported.mediaIds[0]}"`)); assert.match(copy.rawContent, /ids="0"/);
    const copyPublic = (await ok("/api/public/posts/" + copy.slug, "GET", undefined, "")).post; assert.equal(dom(copyPublic.content).querySelectorAll(".gallery img").length, 1);
    const beforeMedia = (await pool.query("SELECT count(*)::int AS n FROM media")).rows[0].n, beforeFiles = (await readdir(uploadsDir, { recursive: true })).filter(name => /\.(?:png|wav)$/.test(name)).sort();
    const rejected = await call("/api/tools/import", "POST", { application: "WorldAct", version: 3, posts: [{ id: 900099, type: "post", title: stamp + " rollback", slug: stamp + "-rollback", status: "publish", content: '[gallery]'.repeat(1025) }], media: [item], mediaFiles: archive.mediaFiles.filter((file: any) => file.filename === item.filename || Object.values(item.sizes || {}).some((size: any) => size.filename === file.filename)) });
    assert.equal(rejected.response.status, 400); assert.equal((await pool.query("SELECT count(*)::int AS n FROM posts WHERE title=$1", [stamp + " rollback"])).rows[0].n, 0); assert.equal((await pool.query("SELECT count(*)::int AS n FROM media")).rows[0].n, beforeMedia); assert.deepEqual((await readdir(uploadsDir, { recursive: true })).filter(name => /\.(?:png|wav)$/.test(name)).sort(), beforeFiles, "Invalid shortcode imports remove copied files and roll back records");
    const xml = `<?xml version="1.0"?><rss version="2.0" xmlns:wp="http://wordpress.org/export/1.2/" xmlns:content="http://purl.org/rss/1.0/modules/content/"><channel><title>Fixture</title><wp:wxr_version>1.2</wp:wxr_version><item><title>${stamp} WXR</title><wp:post_id>900001</wp:post_id><wp:post_type>post</wp:post_type><wp:status>publish</wp:status><content:encoded><![CDATA[[gallery ids="${media[0]}"]]]></content:encoded></item></channel></rss>`;
    const wxr = await ok("/api/tools/import", "POST", { format: "wxr", xml }); posts.push(...wxr.postIds); assert.ok(wxr.warnings.length); assert.match((await ok(`/api/posts/${wxr.postIds[0]}`)).post.rawContent, /ids="0"/);
    await ok("/api/posts/" + created.id, "PUT", { password: "Private-shortcode-body" }); const locked = (await ok("/api/public/posts/" + created.slug, "GET", undefined, "")).post; assert.equal(dom(locked.content).querySelector(".gallery"), null);
  } finally {
    for (const id of posts) { await call("/api/posts/" + id, "PUT", { status: "trash" }); await call("/api/posts/" + id, "DELETE"); }
    for (const id of media) await call("/api/media/" + id, "DELETE");
    if (cookie) await call("/api/auth/logout", "POST", {});
  }
});
