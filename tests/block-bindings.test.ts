import test, { after } from "./isolated-test.js";
import assert from "node:assert/strict";
import { DOMParser } from "linkedom";
import { pool, defaultSettings } from "../server/db.js";
import { renderPublicContent, renderSiteDocument } from "../server/block-renderer.js";
import { applyBlockBindings, bindingAttributes, patternOverrides } from "../server/block-bindings.js";
import { remapImportedBlockReferences } from "../server/block-portability.js";
import { cleanBlocks, cleanRawContent } from "../server/utils.js";

after(async () => { await pool.end(); });
const block = (name: string, attrs: Record<string, unknown> = {}, content = "") => `<!-- wp:${name} ${JSON.stringify(attrs)}${content ? ` -->${content}<!-- /wp:${name} -->` : " /-->"}`;
const bind = (name: string, bindings: Record<string, unknown> = { __default: { source: "core/pattern-overrides" } }) => ({ metadata: { name, bindings } });
const doc = (html: string) => new DOMParser().parseFromString("<!doctype html><html><body>" + html + "</body></html>", "text/html");
const post = (id: number, extra: Record<string, unknown> = {}) => ({ id, type: "post", status: "publish", slug: "post-" + id, authorId: 1, publishedAt: "2026-01-02T03:04:05Z", createdAt: "2026-01-02T03:04:05Z", updatedAt: "2026-01-03T04:05:06Z", ...extra });
function fixture(entities: Record<number, any> = {}, posts: Record<number, any> = {}) {
  const calls: { sql: string; args: any[] }[] = [];
  const db = { query: async (sql: string, args: any[] = []) => {
    calls.push({ sql, args });
    if (sql.includes("FROM settings")) return { rows: [{ data: { ...defaultSettings, timezone: "UTC" } }] };
    if (sql.includes("FROM block_entities")) return { rows: entities[args[0]] ? [entities[args[0]]] : [] };
    // Complete public renders now validate accumulated metadata on this same
    // supplied fixture client; body/title/raw reads remain forbidden below.
    if(sql.startsWith('SELECT id,type,author_id AS "authorId",password_hash FROM posts'))return {rows:args[0].map((id:number)=>posts[id]).filter((row:any)=>row?.status==='publish').map((row:any)=>({id:row.id,type:row.type,authorId:row.authorId,password_hash:row.hasPassword?'fixture-private-hash':null}))};
    if(sql.startsWith('SELECT p.id FROM posts p JOIN jsonb_to_recordset'))return {rows:JSON.parse(args[0]).filter((row:any)=>posts[row.id]?.status==='publish').map((row:any)=>({id:row.id}))};
    if (sql.includes("FROM posts p WHERE p.id")) { assert.doesNotMatch(sql, /p\.content|p\.raw_content|p\.title|AS\s+"?(?:passwordHash|_passwordHash)/i); return { rows: posts[args[0]] ? [posts[args[0]]] : [] }; }
    throw new Error(sql);
  } } as any;
  return { calls, db };
}

test("fixed bindings replace canonical rich text and safe attributes for all eight source-supported blocks", async () => {
  assert.equal(Object.keys(bindingAttributes).length, 8);
  const content = block("paragraph", bind("P"), '<p class="saved">Fallback</p>') + block("heading", bind("H"), '<h2>Fallback</h2>') +
    block("list-item", bind("L"), '<li>Fallback</li>') + block("image", bind("I"), '<figure class="kept"><img src="/old.png" alt="old" title="old" class="size-large wp-image-4" data-id="4"><figcaption>Old</figcaption></figure>') +
    block("button", bind("B"), '<div><a href="/old/">Old</a></div>') + block("post-date", bind("D")) + block("navigation-link", { ...bind("N"), label: "Navigation" }) + block("navigation-submenu", { ...bind("S"), label: "Submenu" });
  const data = fixture({ 1: { rawContent: content } });
  const values = { P: { content: '<strong>Paragraph</strong><script>bad()</script>' }, H: { content: "Heading" }, L: { content: "List" }, I: { id: 99, url: "/new.png", title: 'Title "<>', alt: 'Alternative "<>', caption: "<em>Caption</em>" }, B: { url: "/new/", text: "<em>Button</em>", linkTarget: "_blank", rel: "nofollow ugc" }, D: { datetime: "2026-06-07T08:09:10Z" }, N: { url: "/navigation/" }, S: { url: "/submenu/" } };
  const html = doc(await renderSiteDocument({ rawContent: block("block", { ref: 1, content: values }) }, { db: data.db }));
  assert.equal(html.querySelector("p strong")!.textContent, "Paragraph"); assert.equal(html.querySelector("script"), null); assert.equal(html.querySelector("h2")!.textContent, "Heading"); assert.equal(html.querySelector("li")!.textContent, "List");
  const image = html.querySelector("img")!; assert.equal(image.getAttribute("src"), "/new.png"); assert.equal(image.getAttribute("class"), "size-large wp-image-99"); assert.equal(image.getAttribute("data-id"), "99"); assert.equal(image.getAttribute("alt"), 'Alternative "<>'); assert.equal(image.getAttribute("title"), 'Title "<>'); assert.equal(html.querySelector("figcaption em")!.textContent, "Caption");
  assert.equal(html.querySelector("a em")!.textContent, "Button"); assert.equal(html.querySelector("a")!.getAttribute("href"), "/new/"); assert.match(html.querySelector("a")!.getAttribute("rel")!, /nofollow/); assert.equal(html.querySelector("time")!.getAttribute("datetime"), "2026-06-07T08:09:10.000Z");
  assert.deepEqual([...html.querySelectorAll(".wp-block-navigation-item__content")].map(a => a.getAttribute("href")), ["/navigation/", "/submenu/"]);
});

test("reusable instance maps, legacy formats, explicit bindings, null and empty overrides stay isolated", async () => {
  const content = block("paragraph", bind("Label"), "<p>Saved</p>") + block("paragraph", bind("Explicit", { __default: { source: "core/pattern-overrides" }, content: { source: "unregistered/plugin" } }), "<p>Explicit saved</p>");
  const data = fixture({ 1: { rawContent: content }, 2: { rawContent: block("block", { ref: 1 }) + block("paragraph", bind("Label"), "<p>Outer saved</p>") } });
  const raw = block("block", { ref: 1, content: { Label: { content: "First" }, Explicit: { content: "Wrong" } } }) + block("block", { ref: 1, content: { Label: { values: { content: "Second" } } } }) + block("block", { ref: 1, overrides: { Label: { content: "Legacy" } } }) + block("block", { ref: 1, content: { Label: { content: null } } }) + block("block", { ref: 1, content: { Label: { content: "" } } }) + block("block", { ref: 2, content: { Label: { content: "Outer" } } });
  const html = doc(await renderSiteDocument({ rawContent: raw }, { db: data.db }));
  assert.deepEqual([...html.querySelectorAll("p")].map(p => p.textContent), ["First", "Explicit saved", "Second", "Explicit saved", "Legacy", "Explicit saved", "Saved", "Explicit saved", "", "Explicit saved", "Saved", "Explicit saved", "Outer"]);
  assert.equal(data.calls.filter(call => call.sql.includes("FROM block_entities") && call.args[0] === 1).length, 1, "only the immutable entity is cached");
  assert.deepEqual(patternOverrides({ content: {}, overrides: { Old: { content: "Ignored" } } }), {});
  assert.deepEqual(patternOverrides({ content: { Name: { values: { content: "v2" } } } }), { Name: { content: "v2" } });
});

test("UTF-16 canonical splicing preserves dynamic inner children and trailing markup verbatim", async () => {
  const child = block("list", {}, "<ul>" + block("list-item", {}, "<li>子🙂</li>") + "</ul>");
  const content = block("list-item", bind("Row"), "<li>旧🙂" + block("block", { ref: 2 }) + "尾</li>") + block("list-item", bind("Empty"), "<li>" + block("block", { ref: 2 }) + "</li>");
  const data = fixture({ 1: { rawContent: content }, 2: { rawContent: child } });
  const html = await renderSiteDocument({ rawContent: block("block", { ref: 1, content: { Row: { content: "新🙂<strong>字</strong>" }, Empty: { content: "空🙂" } } }) }, { db: data.db });
  assert.match(html, /<li>新🙂<strong>字<\/strong><ul><li>子🙂<\/li><\/ul>尾<\/li>/);
  assert.match(html, /<li>空🙂<ul><li>子🙂<\/li><\/ul><\/li>/);
  assert.equal((html.match(/子🙂/g) || []).length, 2);
});

test("new bound rich text expands fixed shortcodes once after authored-content sanitization", async () => {
  const data = fixture({ 1: { rawContent: block("paragraph", bind("P"), "<p>Saved</p>") } });
  const db = { query: async (sql: string, args?: any[]) => sql.includes("FROM media m")
    ? { rows: [{ id: 9, title: "Bound audio", mimeType: "audio/wav", url: "/uploads/bound.wav", audioMetadata: {} }] }
    : data.db.query(sql, args) } as any;
  const value = '[playlist ids="9"] [[audio src="/uploads/literal.wav"]] <code>[audio src="/uploads/code.wav"]</code><figure data-worldact-playlist="[]" data-worldact-waveform-style="dots">Untrusted</figure><img src="/safe.png" onerror="bad()">';
  const raw = block("block", { ref: 1, content: { P: { content: value } } });
  const html = doc(await renderSiteDocument({ rawContent: raw }, { db }));
  const figures = html.querySelectorAll("[data-worldact-playlist]");
  assert.equal(figures.length, 1, "Only trusted generated playlist state survives");
  assert.equal(JSON.parse(figures[0].getAttribute("data-worldact-playlist")!)[0].url, "/uploads/bound.wav");
  assert.match(html.body.textContent!, /\[audio src="\/uploads\/literal.wav"\]/);
  assert.equal(html.querySelector("code")!.textContent, '[audio src="/uploads/code.wav"]');
  assert.equal(html.querySelectorAll("audio").length, 1, "Escaped/code audio is never processed a second time");
  assert.equal(html.querySelector("[onerror]"), null);
});

test("JSON bindings defeat stale snapshots, sanitize rich text and never invoke unknown sources or unsupported attributes", async () => {
  const data = fixture({ 1: { blocks: [{ name: "core/paragraph", attributes: bind("P"), innerBlocks: [] }, { name: "core/button", attributes: { ...bind("B"), text: "saved" }, innerBlocks: [] }] } });
  const html = doc(await renderSiteDocument({ content: "<p>Stale saved snapshot</p>", blocks: [{ name: "core/block", attributes: { ref: 1, content: { P: { content: '<img src="/safe.png" onerror="bad()"><strong>Bound</strong>' }, B: { text: "", url: "javascript:bad()", linkTarget: '" onclick="bad()' } } }, innerBlocks: [] }] }, { db: data.db }));
  assert.equal(html.querySelector("p strong")!.textContent, "Bound"); assert.equal(html.querySelector("[onerror]"), null); assert.equal(html.querySelector("[onclick]"), null); assert.equal(html.querySelector("a")!.textContent, ""); assert.equal(html.querySelector("a")!.getAttribute("href"), null);
  const direct = await renderPublicContent(post(1, { content: "<p>Stale</p>", blocks: [{ name: "core/paragraph", attributes: { content: "Saved", metadata: { bindings: { content: { source: "core/post-data", args: { field: "date" } }, className: { source: "core/post-data", args: { field: "link" } } } } }, innerBlocks: [] }] }), { db: data.db });
  assert.doesNotMatch(direct, /Stale/); assert.match(direct, /2026-01-02T03:04:05\+00:00/); assert.doesNotMatch(direct, /className/);
  const empty = doc(await renderSiteDocument({ blocks: [{ name: "core/block", attributes: { ref: 1, content: { B: { url: false } } }, innerBlocks: [] }, { name: "core/button", attributes: { tagName: "button", text: "Native button" }, innerBlocks: [] }] }, { db: data.db }));
  assert.equal(empty.querySelector("a")!.hasAttribute("href"), false); assert.equal(empty.querySelector("button")!.textContent, "Native button");
  const stored = cleanBlocks([{ name: "core/block", attributes: { onclick: "bad()", content: { Onboarding: { content: "First", onclick: "bad()", values: { content: "v2", onload: "bad()" } }, One: { content: "Second" }, constructor: { content: "Bad" } }, overrides: { One: { content: "Legacy", onclick: "bad()" } } }, innerBlocks: [] }])[0].attributes as any;
  assert.deepEqual(Object.keys(stored.content), ["Onboarding", "One"]); assert.equal(stored.content.Onboarding.onclick, undefined); assert.equal(stored.content.Onboarding.values.onload, undefined); assert.equal(stored.onclick, undefined); assert.equal(stored.overrides.One.onclick, undefined);
});

test("post-data uses only source date/modified/link fields, correct navigation identity and password/preview grants", async () => {
  const data = fixture({}, { 2: post(2), 3: post(3, { hasPassword: true }), 4: post(4, { status: "private" }) });
  const navigation = (id: number, field = "link") => block("navigation-link", { id, kind: "post-type", url: "/fallback/", label: "Link", metadata: { bindings: { url: { source: "core/post-data", args: { field } } } } });
  assert.equal(doc(await renderSiteDocument({ rawContent: navigation(2) }, { db: data.db, post: post(1) })).querySelector("a")!.getAttribute("href"), "/posts/post-2/");
  for (const target of [3, 4]) assert.equal(doc(await renderSiteDocument({ rawContent: navigation(target) }, { db: data.db })).querySelector("a")!.getAttribute("href"), "/fallback/");
  assert.equal(doc(await renderSiteDocument({ rawContent: block("navigation-link", { id: { toString: "not callable" }, label: "Malformed id", url: "/fallback/", metadata: { bindings: { url: { source: "core/post-data", args: { field: "link" } } } } }) }, { db: data.db })).querySelector("a")!.getAttribute("href"), "/fallback/");
  assert.equal(doc(await renderSiteDocument({ rawContent: navigation(3) }, { db: data.db, canReadProtectedPost: async id => id === 3 })).querySelector("a")!.getAttribute("href"), "/posts/post-3/");
  assert.equal(doc(await renderSiteDocument({ rawContent: navigation(4) }, { db: data.db, preview: true, user: { id: 1, role: "administrator", displayName: "Admin" } })).querySelector("a")!.getAttribute("href"), "/posts/post-4/");
  const modified = block("post-date", { metadata: { bindings: { datetime: { source: "core/post-data", args: { key: "modified" } } } } });
  assert.equal(await renderSiteDocument({ rawContent: modified }, { db: data.db, post: post(1, { updatedAt: "2026-01-02T03:04:05Z" }) }), "");
  assert.equal(await renderSiteDocument({ rawContent: modified }, { db: data.db, post: post(1, { updatedAt: "2020-01-02T03:04:05Z" }) }), "");
  assert.equal(await renderSiteDocument({ rawContent: modified }, { db: data.db, post: post(1, { publishedAt: "2026-01-02T03:04:05.100Z", updatedAt: "2026-01-02T03:04:05.900Z" }) }), "");
  assert.equal(await renderSiteDocument({ rawContent: block("post-date", { metadata: { bindings: { datetime: { source: "unknown/plugin", args: false } } } }) }, { db: data.db, post: post(1) }), "");
  for (const field of ["title", "excerpt", "content", "password", "author_email"]) {
    const html = await renderSiteDocument({ rawContent: block("paragraph", { metadata: { bindings: { content: { source: "core/post-data", args: { field } } } } }, "<p>Saved</p>") }, { db: data.db, post: post(1) }); assert.equal(doc(html).querySelector("p")!.textContent, "Saved");
  }
});

test("term-data provides only the seven public source fields with escaped names and rich descriptions", async () => {
  const data = fixture(), term = { id: 12, taxonomy: "category" as const, name: "Name <Literal> &", slug: "term", description: '<em>Description</em><script>bad()</script>', parentId: 3, count: 7 };
  for (const field of ["id", "name", "link", "slug", "description", "parent", "count"]) {
    const node = { name: "core/paragraph", attrs: { metadata: { bindings: { content: { source: "core/term-data", args: { field } } } } }, children: [] };
    const bound = await applyBlockBindings(node, { post: null, depth: 0, refs: new Set(), contentIds: new Set(), term }, { db: data.db, settings: defaultSettings, options: {}, cache: new Map() } as any);
    const expected: Record<string, string> = { id: "12", name: "Name &lt;Literal&gt; &amp;", link: "/category/term/", slug: "term", description: "<em>Description</em>", parent: "3", count: "7" };
    assert.equal(bound.attrs.content, expected[field]);
  }
  assert.equal(data.calls.length, 0, "the current term context needs no further database lookup");
});

test("override media identities remap through current and legacy forms, while cycles and output remain bounded", async () => {
  const attrs = { ref: 1, content: { Image: { values: { id: 40, url: "/uploads/old.png" } }, Missing: { id: 41 } }, overrides: { Old: { id: 40 } } };
  const imported = remapImportedBlockReferences(block("block", attrs), [{ name: "core/block", attributes: attrs, innerBlocks: [] }], new Map([[1, { id: 2, kind: "reusable" }]]), { media: new Map([[40, 80]]), urls: new Map([["/uploads/old.png", "/uploads/new.png"]]) });
  assert.match(imported.rawContent, /"id":80/); assert.match(imported.rawContent, /"id":0/); assert.ok(imported.warnings.length); assert.equal((imported.blocks[0].attributes.content as any).Image.values.url, "/uploads/new.png");
  const cycle = fixture({ 1: { rawContent: block("block", { ref: 1 }) } }); assert.equal(await renderSiteDocument({ rawContent: block("block", { ref: 1 }) }, { db: cycle.db }), "");
  const data = fixture({ 1: { rawContent: block("paragraph", bind("P"), "<p>Saved</p>") } });
  await assert.rejects(renderSiteDocument({ rawContent: Array.from({ length: 40 }, () => block("block", { ref: 1, content: { P: { content: "x".repeat(256 * 1024) } } })).join("") }, { db: data.db }), /8 MiB/);
  const deep = fixture({ 1: { rawContent: block("paragraph", bind("P"), "<div>".repeat(12000) + "Deep saved fallback" + "</div>".repeat(12000)) } });
  assert.match(await renderSiteDocument({ rawContent: block("block", { ref: 1, content: { P: { content: "No selector to replace" } } }) }, { db: deep.db }), /Deep saved fallback/);
});

test("real saves, revisions, native reusable previews, JSON and WXR copies retain bindings and fresh scoped references", async () => {
  const base = process.env.TEST_API_URL!, origin = process.env.APP_ORIGIN!; let cookie = "";
  const posts = new Set<number>(), entities = new Set<number>(), terms = new Set<number>();
  const api = async (route: string, method = "GET", body?: unknown, auth = cookie) => { const response = await fetch(base + route, { method, headers: { Origin: origin, "Content-Type": "application/json", ...(auth ? { Cookie: auth } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }); const data = await response.json(); assert.ok(response.ok, `${route}: ${response.status} ${JSON.stringify(data)}`); return { data, response }; };
  const stamp = "bindings-" + Date.now().toString(36);
  try {
    const signed = await api("/api/auth/login", "POST", { login: process.env.ADMIN_EMAIL, password: process.env.ADMIN_PASSWORD }, ""); cookie = signed.response.headers.get("set-cookie")!.split(";")[0];
    const raw = block("paragraph", bind("Onboarding"), "<p>Original saved text</p>");
    const entity = (await api("/wp-json/wp/v2/blocks", "POST", { title: stamp, status: "publish", content: raw })).data; entities.add(entity.id);
    const source = block("block", { ref: entity.id, content: { Onboarding: { content: "First instance", onclick: "bad()" }, One: { content: "Preserved unused override" } } }) + block("block", { ref: entity.id, content: { Onboarding: { content: "Second instance" } } });
    const created = (await api("/api/posts", "POST", { title: stamp, status: "publish", content: source })).data.post; posts.add(created.id);
    assert.equal(created.rawContent, cleanRawContent(source)); assert.doesNotMatch(created.rawContent, /<p>First instance|onclick/); assert.match(created.rawContent, /"One"/); assert.match(created.rawContent, /"Onboarding"/);
    assert.deepEqual([...doc((await api("/api/public/posts/" + created.slug, "GET", undefined, "")).data.post.content).querySelectorAll("p")].map(p => p.textContent), ["First instance", "Second instance"]);
    const native = (await api("/wp-json/wp/v2/block-renderer/core/block", "POST", { attributes: { ref: entity.id, content: { Onboarding: { content: "Native preview" } } }, post_id: created.id })).data.rendered; assert.equal(doc(native).querySelector("p")!.textContent, "Native preview");
    await api(`/api/posts/${created.id}`, "PUT", { content: source.replace("First instance", "Changed instance") });
    const revisions = (await api(`/api/posts/${created.id}/revisions`)).data.revisions; const prior = revisions.find((revision: any) => revision.rawContent?.includes("First instance")); assert.ok(prior);
    await api(`/api/posts/${created.id}/revisions/${prior.id}/restore`, "POST", {}); assert.match((await api(`/api/posts/${created.id}`)).data.post.rawContent, /First instance/);
    const current = (await api(`/api/posts/${created.id}`)).data.post;
    await api(`/api/posts/${created.id}/autosave`, "PUT", { version: current.version, content: source.replace("First instance", "Autosaved instance") });
    assert.match((await api(`/api/posts/${created.id}/autosave`)).data.autosave.rawContent, /Autosaved instance/);
    assert.match((await api("/api/public/posts/" + created.slug, "GET", undefined, "")).data.post.content, /First instance/);
    const protectedPost = (await api("/api/posts", "POST", { title: stamp + " locked", status: "publish", password: "bound-data-locked", content: "Protected body", publishedAt: "2025-02-03T04:05:06Z" })).data.post; posts.add(protectedPost.id);
    const term = (await api("/api/terms", "POST", { taxonomy: "category", name: stamp + " <Literal>", description: "<strong>Bound description</strong>" })).data.term; terms.add(term.id);
    const dateBinding = { metadata: { bindings: { content: { source: "core/post-data", args: { field: "date" } } } } };
    const query = block("query", { query: { inherit: false, include: [created.id, protectedPost.id], perPage: 2 } }, block("post-template", {}, block("paragraph", dateBinding, "<p>Private date fallback</p>")));
    const termQuery = block("terms-query", { termQuery: { taxonomy: "category", include: [term.id], hideEmpty: false } }, block("term-template", {}, block("paragraph", { metadata: { bindings: { content: { source: "core/term-data", args: { field: "name" } } } } }, "<p>Saved name</p>") + block("paragraph", { metadata: { bindings: { content: { source: "core/term-data", args: { field: "description" } } } } }, "<p>Saved description</p>")));
    const host = (await api("/api/posts", "POST", { title: stamp + " context", status: "publish", content: query + termQuery })).data.post; posts.add(host.id);
    const contextual = doc((await api("/api/public/posts/" + host.slug, "GET", undefined, "")).data.post.content);
    assert.equal(contextual.querySelectorAll(".wp-block-post p").length, 2); assert.equal([...contextual.querySelectorAll(".wp-block-post p")].filter(p => p.textContent === "Private date fallback").length, 1);
    assert.doesNotMatch(contextual.body.textContent!, /2025-02-03|Protected body/); assert.match(contextual.querySelector(".wp-block-term")!.textContent!, new RegExp(stamp)); assert.match(contextual.querySelector(".wp-block-term")!.textContent!, /Bound description/);
    const archive = (await api("/api/tools/export")).data;
    const imported = (await api("/api/tools/import", "POST", { application: "WorldAct", version: 3, posts: archive.posts.filter((row: any) => row.id === created.id), blockEntities: archive.blockEntities.filter((row: any) => row.id === entity.id) })).data;
    imported.postIds.forEach((id: number) => posts.add(id)); imported.blockEntityIds.forEach((id: number) => entities.add(id)); assert.notEqual(imported.blockEntityIds[0], entity.id);
    const copy = (await api(`/api/posts/${imported.postIds[0]}`)).data.post; assert.match(copy.rawContent, new RegExp(`"ref":${imported.blockEntityIds[0]}`)); assert.match((await api("/api/public/posts/" + copy.slug, "GET", undefined, "")).data.post.content, /First instance/);
    const wxrResponse = await fetch(base + "/api/tools/export?format=wxr", { headers: { Cookie: cookie } }); assert.equal(wxrResponse.status, 200); const xml = await wxrResponse.text(); assert.match(xml, /core\/pattern-overrides/);
    const wxr = (await api("/api/tools/import", "POST", { format: "wxr", xml })).data; wxr.postIds.forEach((id: number) => posts.add(id)); wxr.blockEntityIds.forEach((id: number) => entities.add(id));
    const wxrPost = (await Promise.all(wxr.postIds.map(async (id: number) => (await api(`/api/posts/${id}`)).data.post))).find((row: any) => row.title === stamp); assert.ok(wxrPost); assert.match((await api("/api/public/posts/" + wxrPost.slug, "GET", undefined, "")).data.post.content, /First instance/);
    await api(`/api/posts/${created.id}`, "PUT", { password: "locked-binding-content" }); assert.doesNotMatch((await api("/api/public/posts/" + created.slug, "GET", undefined, "")).data.post.content, /First instance|Original saved/);
  } finally {
    for (const id of posts) { await api(`/api/posts/${id}`, "PUT", { status: "trash" }); await api(`/api/posts/${id}`, "DELETE"); }
    for (const id of entities) await api(`/wp-json/wp/v2/blocks/${id}?force=true`, "DELETE");
    for (const id of terms) await api(`/api/terms/${id}`, "DELETE");
    if (cookie) await api("/api/auth/logout", "POST", {});
  }
});
