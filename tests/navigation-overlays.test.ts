import "dotenv/config";
import assert from "node:assert/strict";
import test, { after } from "node:test";
import { DOMParser } from "linkedom";
import { pool, defaultSettings } from "../server/db.js";
import { renderSiteDocument, renderBlock, SUPPORTED_DYNAMIC_BLOCKS, type RenderDocument } from "../server/block-renderer.js";
import { navigationOverlayReference } from "../server/navigation-overlays.js";
import { cleanContent, cleanRawContent, HttpError } from "../server/utils.js";

after(async () => { await pool.end(); });
const block = (name: string, attrs: Record<string, unknown> = {}, html = "") => `<!-- wp:${name} ${JSON.stringify(attrs)}${html ? " -->" + html + `<!-- /wp:${name} -->` : " /-->"}`;
const paragraph = (text: string) => block("paragraph", {}, `<p>${text}</p>`);
const link = block("navigation-link", { label: "Public destination", url: "/public-destination/" });
const navigation = (attrs: Record<string, unknown> = {}, children = link) => block("navigation", attrs, children);
const dom = (html: string) => new DOMParser().parseFromString("<!doctype html><html><body>" + html + "</body></html>", "text/html");
function stub(documents: Record<string, string | RenderDocument> = {}) {
  const calls: Array<{ sql: string; args: any[] }> = [];
  const db = { query: async (sql: string, args: any[] = []) => {
    calls.push({ sql, args });
    if (/FROM settings/.test(sql)) return { rows: [{ data: defaultSettings }] };
    assert.match(sql, /FROM site_documents/);
    assert.match(sql, /type='template-part'/);
    assert.equal(args[1], defaultSettings.theme);
    const document = documents[args[0]];
    return { rows: document === undefined ? [] : [typeof document === "string" ? { rawContent: document, content: "", blocks: null } : document] };
  } } as any;
  return { db, calls };
}
const render = (rawContent: string, db = stub().db) => renderSiteDocument({ id: 31, type: "template", rawContent: cleanRawContent(rawContent) }, { db });
function assertPairs(document: ReturnType<typeof dom>) {
  const ids = [...document.querySelectorAll("[id]")].map(element => element.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const root of document.querySelectorAll('[data-worldact-interactive="navigation"]')) {
    const toggle = root.querySelector("[data-worldact-navigation-open]")!;
    const panel = document.getElementById(toggle.getAttribute("aria-controls")!)!;
    assert.ok(panel); assert.equal(panel.closest('[data-worldact-interactive="navigation"]'), root);
    for (const close of root.querySelectorAll("[data-worldact-navigation-close]")) assert.equal(close.getAttribute("data-worldact-navigation-close"), panel.id);
  }
}

test("overlay references accept only bounded active-theme template-part identities", () => {
  assert.deepEqual(navigationOverlayReference("dialog", "twentytwentyfive"), { theme: "twentytwentyfive", slug: "dialog" });
  assert.deepEqual(navigationOverlayReference("twentytwentyfive//dialog", "twentytwentyfive"), { theme: "twentytwentyfive", slug: "dialog" });
  for (const value of ["twentytwentyfour//dialog", "//dialog", "twentytwentyfive/dialog", "../dialog", "https://evil.test/dialog", "dialog?x=1", "dialog\\bad", "x".repeat(161), {}, 4, "dialog\u0000"]) assert.equal(navigationOverlayReference(value, "twentytwentyfive"), null);
});

test("source close modes produce trusted 24px icons, rich text, styles and inert standalone controls", async () => {
  assert.ok(SUPPORTED_DYNAMIC_BLOCKS.has("core/navigation-overlay-close"));
  for (const [displayMode, icon, text] of [[undefined, true, false], ["text", false, true], ["both", true, true], ["invalid", true, false]] as const) {
    const output = await renderBlock("core/navigation-overlay-close", { ...(displayMode ? { displayMode } : {}), text: '<strong>Finish</strong> <em>menu</em><a href="javascript:bad()">link</a><script>bad()</script><img src=x onerror=bad()>', style: { spacing: { padding: "12px" }, color: { text: "#123456", background: "#ffffff" } } }, { db: stub().db });
    const parsed = dom(output), button = parsed.querySelector("button")!;
    assert.equal(button.getAttribute("type"), "button");assert.equal(!!button.querySelector("svg"), icon);assert.equal(!!button.querySelector(".wp-block-navigation-overlay-close__text"), text);
    assert.match(button.getAttribute("style")!, /padding:12px/);assert.match(button.getAttribute("style")!, /color:#123456/);
    assert.equal(button.hasAttribute("data-worldact-navigation-close"), false);
    if (icon) { assert.equal(button.querySelector("svg")!.getAttribute("width"), "24");assert.equal(button.querySelector("svg")!.getAttribute("height"), "24"); }
    if (text) { assert.ok(button.querySelector("strong"));assert.ok(button.querySelector("em"));assert.equal(button.getAttribute("aria-label"), null); }
    else assert.equal(button.getAttribute("aria-label"), "Close");
    assert.doesNotMatch(output, /<script|<img|<a\b|javascript:|onerror|data-wp/);
  }
  const fallback = dom(await renderBlock("core/navigation-overlay-close", { displayMode: "text", text: "" }, { db: stub().db }));assert.equal(fallback.querySelector("button")!.textContent, "Close");
  assert.equal(dom(await renderBlock("core/navigation-overlay-close", { displayMode: "both", text: "<script>bad()</script>" }, { db: stub().db })).querySelector(".wp-block-navigation-overlay-close__text")!.textContent, "Close");
});

test("mobile, always and never keep native disclosure fallbacks and source icon/text choices", async () => {
  for (const mode of ["mobile", "always", "never"]) {
    const parsed = dom(await render(navigation({ overlayMenu: mode, hasIcon: false, _isWithinOverlayTemplatePart: true })));
    assert.equal(parsed.querySelectorAll("nav").length, 1, "Saved private attrs cannot suppress a top-level overlay");
    assert.equal(parsed.querySelectorAll("details").length, mode === "never" ? 0 : 1);
    assert.equal(parsed.querySelectorAll(".worldact-navigation-desktop").length, mode === "always" ? 0 : 1);
    if (mode !== "never") {
      assert.equal(parsed.querySelector("summary")!.textContent, "Menu");assert.equal(parsed.querySelector("details")!.hasAttribute("open"), false);
      assert.equal(parsed.querySelector("[data-worldact-navigation-panel]")!.getAttribute("style"), "display:block");
      assert.equal(parsed.querySelector("[data-worldact-navigation-dialog]")!.getAttribute("aria-modal"), null);
      assert.equal(parsed.querySelector("[data-worldact-navigation-close]")!.textContent, "Close");
    }
    assert.equal(parsed.querySelectorAll("[hidden]").length, 0);assertPairs(parsed);
  }
  const sourceIcon = dom(await render(navigation({ icon: "menu" })));assert.equal(sourceIcon.querySelector("summary svg")!.getAttribute("width"), "24");assert.equal(sourceIcon.querySelector("summary")!.getAttribute("aria-label"), "Open menu");
  const colored = dom(await render(navigation({ overlayTextColor: "contrast", customOverlayBackgroundColor: "#123456" })));
  assert.ok(colored.querySelector(".has-contrast-color"));assert.match(colored.querySelector("[data-worldact-navigation-panel]")!.getAttribute("style")!, /background-color:#123456/);
  assert.doesNotMatch(await render(navigation({ customOverlayBackgroundColor: 'url(javascript:bad());position:fixed', customOverlayTextColor: '\" onclick=bad()' })), /javascript:|onclick|position:fixed/);
});

test("custom overlays use their own styles, public content and low-priority images with no area restriction", async () => {
  const custom = block("group", { style: { color: { background: "#123456" }, spacing: { padding: "24px" } } }, '<div class="custom-overlay">' + paragraph("Custom panel") + block("image", {}, '<figure><img src="/uploads/image.png" fetchpriority="high" alt="Overlay image"></figure>') + block("navigation-overlay-close", { displayMode: "both", text: "<strong>Dismiss</strong>" }) + '</div>');
  const { db, calls } = stub({ dialog: custom });
  const output = await render(navigation({ overlay: "twentytwentyfive//dialog", overlayTextColor: "red", customOverlayBackgroundColor: "#ff0000" }), db), parsed = dom(output);
  assert.match(output, /Custom panel/);assert.match(parsed.querySelector(".custom-overlay")!.getAttribute("style")!, /background-color:#123456/);
  assert.equal(parsed.querySelector(".wp-block-navigation__overlay-container img")!.getAttribute("fetchpriority"), "low");
  assert.equal(parsed.querySelectorAll(".wp-block-navigation__responsive-container-close").length, 0);assert.ok(parsed.querySelector("button strong"));
  assert.doesNotMatch(parsed.querySelector("[data-worldact-navigation-panel]")!.outerHTML, /has-red-color|background-color:#ff0000/);
  assert.equal(calls.filter(call => /site_documents/.test(call.sql)).length, 1);assert.ok(calls.every(call => !/area=/.test(call.sql)));assertPairs(parsed);
});

test("missing, empty, foreign and malformed overlays fall back without binding unrelated data", async () => {
  for (const overlay of ["missing", "empty", "twentytwentyfour//dialog", "../dialog", "twentytwentyfive//dialog/extra", { slug: "dialog" }]) {
    const { db, calls } = stub({ empty: " \n ", dialog: paragraph("Unrelated overlay") });
    const output = await render(navigation({ overlay }), db), parsed = dom(output);
    assert.equal(parsed.querySelector(".wp-block-navigation__overlay-container"), null);assert.ok(parsed.querySelector(".wp-block-navigation__responsive-container-close"));
    assert.equal(parsed.querySelector("[data-worldact-navigation-panel] a")!.getAttribute("href"), "/public-destination/");
    assert.doesNotMatch(output, /Unrelated overlay/);assertPairs(parsed);
    if (overlay !== "missing" && overlay !== "empty") assert.equal(calls.length, 1, "Invalid identities perform no document query");
  }
  const never = stub({ dialog: paragraph("Unused overlay") });await render(navigation({ overlayMenu: "never", overlay: "dialog" }), never.db);assert.equal(never.calls.length, 1);
});

test("shared caches and deterministic render namespaces pair reused overlays without ID collisions", async () => {
  const custom = paragraph("Cached content") + block("navigation-overlay-close"), raw = navigation({ overlay: "dialog" }) + navigation({ overlay: "dialog" });
  const first = stub({ dialog: custom }), second = stub({ dialog: custom });
  const output = dom(await render(raw, first.db)), reloaded = dom(await render(raw, second.db));
  assertPairs(output);assert.equal(first.calls.length, 2, "One settings read plus one shared template-part lookup");
  assert.deepEqual([...output.querySelectorAll("[id]")].map(node => node.id), [...reloaded.querySelectorAll("[id]")].map(node => node.id));
  assert.notEqual(output.querySelectorAll("[data-worldact-navigation-panel]")[0].id, output.querySelectorAll("[data-worldact-navigation-panel]")[1].id);
  const separate = await Promise.all(["header", "footer"].map(instanceKey => renderSiteDocument({ id: 31, rawContent: raw }, { db: stub({ dialog: custom }).db, instanceKey })));assertPairs(dom(separate.join("")));
});

test("ordinary responsive menus render native Search and interactive controls as independently paired DOM instances", async () => {
  const children = block("search", { label: "Find a page" }) + block("tabs", {}, block("tab-list", { tabs: [{ label: "First tab" }] }) + block("tab-panels", {}, block("tab-panel", { label: "First tab" }, paragraph("Tab content"))));
  const parsed = dom(await render(navigation({}, children)));assertPairs(parsed);
  assert.equal(parsed.querySelectorAll("input[type=search]").length, 2);
  for (const label of parsed.querySelectorAll("label[for]")) assert.equal(parsed.getElementById(label.getAttribute("for")!)!.closest("form"), label.closest("form"));
  for (const button of parsed.querySelectorAll('[role="tab"]')) assert.equal(parsed.getElementById(button.getAttribute("aria-controls")!)!.getAttribute("aria-labelledby"), button.id);
  const invalidRef = stub();await render(navigation({ ref: -1 }), invalidRef.db);assert.equal(invalidRef.calls.length, 1, "Malformed refs must not alias a real entity ID");
});

test("overlay traversal keeps nested navigation, pattern/reusable refs and private post content within shared access rules", async () => {
  const db = await pool.connect();await db.query("BEGIN");
  try {
    const admin = (await db.query("SELECT id FROM users WHERE role='administrator' LIMIT 1")).rows[0], stamp = "overlay-" + Date.now().toString(36);
    const reusable: any[] = [];
    for (const status of ["publish", "draft", "trash"]) reusable.push((await db.query("INSERT INTO block_entities(kind,title,slug,status,author_id,raw_content,content) VALUES('reusable',$1,$2,$3,$4,$5,'') RETURNING id", [stamp, stamp + status, status, admin.id, paragraph(status === "publish" ? "Public reusable" : "CONFIDENTIAL-" + status)])).rows[0]);
    const pattern = stamp + "-pattern", dialog = stamp + "-dialog";
    await db.query("INSERT INTO site_documents(theme,type,slug,title,content,raw_content,area) VALUES('twentytwentyfive','pattern',$1,$1,'',$2,'uncategorized')", [pattern, block("navigation-overlay-close", { displayMode: "text", text: "Pattern close" }) + block("block", { ref: reusable[0].id })]);
    const navEntity = (await db.query("INSERT INTO block_entities(kind,title,slug,status,author_id,raw_content,content) VALUES('navigation',$1,$1,'publish',$2,$3,'') RETURNING id", [stamp, admin.id, link])).rows[0];
    const raw = block("pattern", { slug: "twentytwentyfive/" + pattern }) + reusable.slice(1).map(entity => block("block", { ref: entity.id })).join("") + navigation({ overlay: dialog, ref: navEntity.id, overlayMenu: "always" }) + block("template-part", { slug: dialog }) + block("post-content");
    await db.query("INSERT INTO site_documents(theme,type,slug,title,content,raw_content,area) VALUES('twentytwentyfive','template-part',$1,$1,'',$2,'header')", [dialog, raw]);
    const output = await renderSiteDocument({ id: 52, rawContent: navigation({ overlay: dialog }) }, { db, post: { id: 71, slug: "private", type: "post", status: "publish", locked: true, rawContent: paragraph("CONFIDENTIAL-password"), content: "CONFIDENTIAL-password" } }), parsed = dom(output);
    assert.equal(parsed.querySelectorAll("nav").length, 1);assert.equal(parsed.querySelectorAll("details.worldact-navigation-toggle").length, 1);assert.ok(parsed.querySelector(".wp-block-navigation__overlay-container div.wp-block-navigation.worldact-overlay-never"));
    assert.match(output, /Public reusable|Pattern close/);assert.doesNotMatch(output, /CONFIDENTIAL/);assert.match(output, /password protected/);
    assert.equal(parsed.querySelectorAll(".wp-block-navigation__responsive-container-close").length, 0);assertPairs(parsed);
  } finally { await db.query("ROLLBACK");db.release(); }
});

test("untrusted close-like markup cannot suppress the generated fallback or inject runtime directives", async () => {
  const custom = paragraph('<span class="wp-block-navigation-overlay-close" data-worldact-navigation-close="foreign">Fake close</span>') + block("html", { content: '<button type="button" class="wp-block-navigation-overlay-close" data-wp-on--click="evil()" onclick="bad()">Fake button</button>' });
  const output = await render(navigation({ overlay: "dialog", customOverlayTextColor: 'url(javascript:bad());position:fixed' }), stub({ dialog: cleanRawContent(custom) }).db), parsed = dom(output);
  assert.equal(parsed.querySelectorAll(".wp-block-navigation__responsive-container-close").length, 1);assertPairs(parsed);assert.doesNotMatch(output, /onclick|data-wp|javascript:|position:fixed|foreign/);
});

test("close fallback depends on a genuine control surviving rendered output, not discarded children or forged markers", async () => {
  const discarded = { blocks: [{ name: "core/heading", attributes: { content: "Visible overlay heading" }, innerBlocks: [{ name: "core/navigation-overlay-close", attributes: {}, innerBlocks: [] }] }] };
  const malformed = dom(await render(navigation({ overlay: "dialog" }), stub({ dialog: discarded }).db));
  assert.match(malformed.body.textContent!, /Visible overlay heading/);assert.equal(malformed.querySelectorAll(".wp-block-navigation-overlay-close").length, 0);assert.equal(malformed.querySelectorAll(".wp-block-navigation__responsive-container-close").length, 1);assertPairs(malformed);
  const fake = { blocks: [{ name: "core/html", attributes: { content: '<button type="button" class="wp-block-navigation-overlay-close" data-worldact-navigation-close="fake" data-worldact-internal-close="forged">Untrusted control</button>' }, innerBlocks: [] }] };
  const output = await render(navigation({ overlay: "dialog" }), stub({ dialog: fake }).db), parsed = dom(output);
  assert.equal(parsed.querySelectorAll(".wp-block-navigation__responsive-container-close").length, 1);assert.doesNotMatch(output, /data-worldact-internal-close/);
  const actual = await render(navigation({ overlay: "dialog" }), stub({ dialog: paragraph("Actual overlay") + block("navigation-overlay-close") }).db);
  assert.equal(dom(actual).querySelectorAll(".wp-block-navigation__responsive-container-close").length, 0);assert.doesNotMatch(actual, /data-worldact-internal-close/);
});

test("custom overlays preserve requesting user and safe public return context for native account controls", async () => {
  const rawContent = navigation({ overlay: "dialog" });
  for (const [requestPath, expected] of [["/journal/?view=recent#section", "/journal/?view=recent#section"], ["https://evil.invalid/steal", "/"]]) {
    const current = stub({ dialog: block("loginout") + block("navigation-overlay-close") });
    const authenticated = dom(await renderSiteDocument({ id: 93, rawContent }, { db: current.db, requestPath, user: { id: 4, role: "author", displayName: "Author" } }));
    const form = authenticated.querySelector(".wp-block-navigation__overlay-container form")!;assert.equal(form.getAttribute("action"), "/logout");assert.equal(form.querySelector('input[name="redirect_to"]')!.getAttribute("value"), expected);
    const anonymous = dom(await renderSiteDocument({ id: 93, rawContent }, { db: stub({ dialog: block("loginout") }).db, requestPath }));
    const href = anonymous.querySelector(".wp-block-navigation__overlay-container a")!.getAttribute("href")!;assert.equal(new URL(href, "http://127.0.0.1:5173").searchParams.get("redirect_to"), expected);
    assertPairs(authenticated);assertPairs(anonymous);
  }
});

test("navigation overlays share cumulative output, recursion and query budgets", async () => {
  const large = paragraph("x".repeat(256 * 1024)), repeated = navigation({ overlay: "dialog" }).repeat(40), limited = stub({ dialog: large });
  await assert.rejects(() => render(repeated, limited.db), (error: unknown) => error instanceof HttpError && error.status === 413);assert.equal(limited.calls.length, 2);
  const recursive = stub({ dialog: block("template-part", { slug: "dialog" }) + paragraph("Cycle terminates") });assert.match(await render(navigation({ overlay: "dialog" }), recursive.db), /Cycle terminates/);assert.equal(recursive.calls.length, 2);
  const many = stub();await assert.rejects(() => render(Array.from({ length: 520 }, (_, index) => navigation({ overlay: "missing-" + index })).join(""), many.db), /query limit/);assert.equal(many.calls.length, 512);
});

test("native APIs persist selected overlays, expose close metadata and render public content without design write access", async () => {
  const base = process.env.TEST_API_URL || "http://127.0.0.1:3001", origin = process.env.APP_ORIGIN || "http://127.0.0.1:5173";
  let cookie = "", postId: number | undefined, partId: string | undefined;
  const api = async (path: string, method = "GET", body?: unknown, auth = cookie) => {
    const response = await fetch(base + path, { method, headers: { Origin: origin, "Content-Type": "application/json", ...(auth ? { Cookie: auth } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });return { response, data: await response.json() };
  };
  try {
    const login = await api("/api/auth/login", "POST", { login: process.env.ADMIN_EMAIL, password: process.env.ADMIN_PASSWORD }, "");assert.equal(login.response.status, 200);cookie = login.response.headers.get("set-cookie")!.split(";")[0];
    const stamp = "native-overlay-" + Date.now().toString(36), content = paragraph("Native overlay body") + block("navigation-overlay-close", { displayMode: "both", text: "<strong>Close native overlay</strong>" });
    const part = await api("/wp-json/wp/v2/template-parts", "POST", { slug: stamp, title: stamp, area: "navigation-overlay", content });assert.equal(part.response.status, 201, JSON.stringify(part.data));partId = part.data.id;
    const created = await api("/api/posts", "POST", { title: stamp, content: navigation({ overlay: partId }), status: "publish" });assert.equal(created.response.status, 201, JSON.stringify(created.data));postId = created.data.post.id;
    const edit = await api("/api/posts/" + postId);assert.match(edit.data.post.rawContent, /"overlay":/);
    const publicPost = await api("/api/public/posts/" + created.data.post.slug, "GET", undefined, "");assert.equal(publicPost.response.status, 200);assert.equal(publicPost.data.post.rawContent, undefined);
    assert.match(publicPost.data.post.content, /Native overlay body/);assert.ok(dom(publicPost.data.post.content).querySelector(".wp-block-navigation-overlay-close strong"));assertPairs(dom(publicPost.data.post.content));
    const metadata = await api("/wp-json/wp/v2/block-types/core/navigation-overlay-close");assert.equal(metadata.response.status, 200);assert.equal(metadata.data.is_dynamic, true);assert.deepEqual(metadata.data.attributes.displayMode.enum, ["icon", "text", "both"]);
    const preview = await api("/wp-json/wp/v2/block-renderer/core/navigation-overlay-close", "POST", { attributes: { displayMode: "text", text: "Preview close" } });assert.equal(preview.response.status, 200);assert.match(preview.data.rendered, /Preview close/);
    assert.equal((await api("/wp-json/wp/v2/template-parts/" + partId, "GET", undefined, "")).response.status, 401);
  } finally {
    if (postId) { await api("/api/posts/" + postId, "PUT", { status: "trash" });await api("/api/posts/" + postId, "DELETE"); }
    if (partId) await api("/wp-json/wp/v2/template-parts/" + partId + "?force=true", "DELETE");
    if (cookie) await api("/api/auth/logout", "POST", {});
  }
});
