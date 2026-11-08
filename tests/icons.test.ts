import test, { after } from "./isolated-test.js";
import "dotenv/config";
import assert from "node:assert/strict";
import { DOMParser } from "linkedom";
import { auditBundledIcon, bundledIcons, getBundledIcon } from "../server/icons.js";
import { renderPublicContent, renderSiteDocument, SUPPORTED_DYNAMIC_BLOCKS } from "../server/block-renderer.js";
import { cleanContent, cleanRawContent } from "../server/utils.js";
import { defaultSettings, pool } from "../server/db.js";
const block = (attrs: Record<string, unknown>, html = "") => `<!-- wp:icon ${JSON.stringify(attrs)}${html ? " -->" + html + "<!-- /wp:icon -->" : " /-->"}`;
const dom = (html: string) => new DOMParser().parseFromString("<!doctype html><html><body>" + html + "</body></html>", "text/html");
const settingsOnly = { query: async (sql: string) => { assert.match(sql, /FROM settings/); return { rows: [{ data: defaultSettings }] }; } } as any;
const render = (attrs: Record<string, unknown>, html = "") => renderPublicContent({ id: 31, type: "post", slug: "icons", rawContent: block(attrs, html) }, { db: settingsOnly });
after(async () => { await pool.end(); });

test("all bundled source SVGs are finite, inert, namespaced registry data", () => {
  assert.equal(bundledIcons.length, 88); assert.equal(new Set(bundledIcons.map(icon => icon.name)).size, 88);
  for (const icon of bundledIcons) {
    auditBundledIcon(icon); assert.match(icon.name, /^core\/[a-z0-9_-]+$/);
    const parsed = dom(icon.content); assert.equal(parsed.querySelectorAll("svg").length, 1); assert.ok(parsed.querySelector("path"));
    assert.equal(parsed.querySelectorAll("[id],[href],[src],script,style,use,foreignObject,iframe").length, 0);
  }
  assert.ok(getBundledIcon("core/arrow-down")); assert.equal(getBundledIcon("arrow-down"), undefined); assert.equal(getBundledIcon("toString"), undefined);
  const valid = getBundledIcon("core/arrow-down")!;
  for (const content of [
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><script>alert(1)</script><path d="M0 0"/></svg>',
    '<svg viewBox="0 0 24 24" onload="bad()"><path d="M0 0"/></svg>',
    '<svg viewBox="0 0 24 24"><path id="location" d="M0 0"/></svg>',
    '<svg viewBox="0 0 24 24"><use href="https://evil.invalid"/><path d="M0 0"/></svg>',
    '<!DOCTYPE svg [<!ENTITY evil "bad">]><svg><path d="M0 0"/></svg>',
    valid.content + '<svg><path d="M0 0"/></svg>',
  ]) assert.throws(() => auditBundledIcon({ ...valid, content }));
});

test("Icon dynamically renders only the registered SVG with source decorative or labelled accessibility", async () => {
  assert.ok(SUPPORTED_DYNAMIC_BLOCKS.has("core/icon"));
  const output = await render({ icon: "core/arrow-down", content: '<svg onload="bad()"><text>Injected</text></svg>' }, '<svg onload="bad()"><path d="M1 1"/></svg><p>Injected fallback</p>');
  const parsed = dom(output), svg = parsed.querySelector("svg")!;
  assert.equal(parsed.querySelectorAll("svg").length, 1); assert.equal(svg.getAttribute("aria-hidden"), "true"); assert.equal(svg.getAttribute("focusable"), "false"); assert.equal(svg.getAttribute("viewbox"), "0 0 24 24"); assert.doesNotMatch(output, /Injected|onload|M1 1/);
  const label = 'Arrow <script>alert(1)</script> "label"'; const labelled = dom(await render({ icon: "core/arrow-down", ariaLabel: label }));
  assert.equal(labelled.querySelector("svg")!.getAttribute("aria-label"), label); assert.equal(labelled.querySelector("svg")!.getAttribute("role"), "img"); assert.equal(labelled.querySelector("svg")!.getAttribute("aria-hidden"), null); assert.equal(labelled.querySelector("script"), null);
  for (const icon of [undefined, "arrow-down", "core/no-such-icon", "https://evil.invalid/icon.svg", "__proto__/constructor"]) assert.equal(await render({ icon }, '<p>Untrusted fallback</p>'), "");
  assert.equal(dom(await renderSiteDocument({ blocks: [{ name: "core/icon", attributes: { icon: "core/bell" }, innerBlocks: [] }] }, { db: settingsOnly })).querySelectorAll("svg").length, 1);
});

test("source wrapper margin is separate from SVG color, border, padding, width, flips and rotation", async () => {
  const parsed = dom(await render({ icon: "core/bell", anchor: "my-icon", align: "center", className: "kept-icon", textColor: "accent-1", backgroundColor: "base", borderColor: "contrast", flipHorizontal: true, flipVertical: true, rotation: 90.9,
    style: { spacing: { margin: { top: "var:preset|spacing|40", bottom: "5px" }, padding: { top: "6px", left: "7px" } }, dimensions: { width: "72px", minHeight: "400px" }, border: { width: "2px", style: "solid", radius: { topLeft: "3px", bottomRight: "8px" }, left: { color: "#123456", width: "4px", style: "dashed" } }, color: { text: "#ffffff", gradient: "linear-gradient(red,blue)" }, background: { backgroundImage: { url: "https://evil.invalid/image" } }, shadow: "20px 20px red" } }));
  const wrapper = parsed.querySelector(".wp-block-icon")!, svg = wrapper.querySelector("svg")!;
  assert.equal(wrapper.id, "my-icon"); assert.ok(wrapper.classList.contains("aligncenter")); assert.ok(wrapper.classList.contains("kept-icon"));
  assert.match(wrapper.getAttribute("style")!, /margin-top:var\(--wp--preset--spacing--40\)/); assert.doesNotMatch(wrapper.getAttribute("style")!, /padding|border|color|width/);
  assert.match(svg.getAttribute("style")!, /color:var\(--wp--preset--color--accent-1\)/); assert.match(svg.getAttribute("style")!, /background-color:var\(--wp--preset--color--base\)/);
  for (const value of ["padding-top:6px", "padding-left:7px", "width:72px", "border-width:2px", "border-style:solid", "border-top-left-radius:3px", "border-bottom-right-radius:8px", "border-left-style:dashed", "border-left-width:4px", "border-left-color:#123456", "rotate:90deg"]) assert.ok(svg.getAttribute("style")!.includes(value), value);
  assert.ok(svg.classList.contains("has-accent-1-color")); assert.ok(svg.classList.contains("has-contrast-border-color")); assert.ok(svg.classList.contains("is-flip-horizontal")); assert.ok(svg.classList.contains("is-flip-vertical"));
  assert.doesNotMatch(svg.getAttribute("style")!, /margin|shadow|gradient|min-height|evil/);
});

test("untrusted icon styles and rotation cannot inject active markup or unrelated CSS", async () => {
  const output = await render({ icon: "core/bell", ariaLabel: '\" onload=\"bad()', rotation: '90deg; background:url(javascript:bad())', textColor: 'bad\" onclick=\"bad()', style: { color: { text: "expression(bad())", background: "url(javascript:bad())" }, dimensions: { width: "expression(bad())" }, border: { radius: "url(https://evil.invalid)" } } });
  assert.equal(dom(output).querySelector("svg")!.getAttribute("style"), null); assert.equal(dom(output).querySelector("[onload],[onclick]"), null);
  assert.doesNotMatch(cleanContent('<svg style="rotate:expression(bad());border-top-left-radius:url(javascript:bad())"><path d="M0 0"></path></svg>', true), /expression|javascript|rotate|radius/);
  assert.doesNotMatch(cleanContent('<svg style="rotate:360001deg"></svg>', true), /rotate/);
  const bounded = dom(await render({ icon: "core/bell", rotation: 1e308 })); assert.equal(bounded.querySelector("svg")!.style.getPropertyValue("rotate"), "360000deg");
  assert.doesNotMatch(cleanRawContent('<svg onload="bad()"><path d="M1 1"/></svg>'), /<svg|<path|onload/);
});

const base = process.env.TEST_API_URL || "http://127.0.0.1:3001", origin = process.env.APP_ORIGIN || "http://127.0.0.1:5173";
test("native read-only Icon REST supports source shapes, search, fields, schemas and every content role", async () => {
  let cookie = ""; const users: number[] = [], posts: number[] = [], sessions: string[] = [], stamp = "icons-" + Date.now().toString(36);
  const api = async (path: string, method = "GET", body?: unknown, auth = cookie) => { const response = await fetch(base + path, { method, headers: { Origin: origin, "Content-Type": "application/json", ...(auth ? { Cookie: auth } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }); let data: any; try { data = await response.json(); } catch { data = null; } return { response, data }; };
  const ok = async (path: string, method = "GET", body?: unknown, auth = cookie) => { const value = await api(path, method, body, auth); assert.ok(value.response.ok, `${path}: ${value.response.status} ${JSON.stringify(value.data)}`); return value; };
  try {
    const login = await ok("/api/auth/login", "POST", { login: process.env.ADMIN_EMAIL, password: process.env.ADMIN_PASSWORD }, ""); cookie = login.response.headers.get("set-cookie")!.split(";")[0];
    const routes = ["/icons", "/icons/core", "/icons/core/arrow-down", "/icon-collections", "/icon-collections/core"];
    for (const route of routes) { const anon = await api("/wp-json/wp/v2" + route, "GET", undefined, ""); assert.equal(anon.response.status, 401); assert.equal(anon.data.code, "rest_cannot_view"); }
    for (const role of ["subscriber", "contributor", "author", "editor"] as const) {
      const username = `${stamp}-${role}`, password = "Safe-icon-fixture-" + stamp;
      const created = await ok("/api/users", "POST", { username, email: username + "@example.test", password, displayName: role, role }); users.push(created.data.user.id);
      const signed = await ok("/api/auth/login", "POST", { login: username, password }, ""), auth = signed.response.headers.get("set-cookie")!.split(";")[0]; sessions.push(auth);
      for (const route of routes) assert.equal((await api("/wp-json/wp/v2" + route, "GET", undefined, auth)).response.status, role === "subscriber" ? 403 : 200);
    }
    const all = await ok("/wp-json/wp/v2/icons?per_page=1&page=2"); assert.equal(all.data.length, 88); assert.equal(all.response.headers.get("X-WP-Total"), null);
    assert.deepEqual((await ok("/wp-json/wp/v2/icons?collection=core")).data, all.data);
    assert.deepEqual((await ok("/wp-json/wp/v2/icon-collections/core")).data, { slug: "core", label: "WordPress", description: "Default icon collection." });
    const searched = await ok("/wp-json/wp/v2/icons?search=" + encodeURIComponent("At Symbol (@)")); assert.deepEqual(searched.data.map((row: any) => row.name), ["core/at-symbol"]);
    assert.ok((await ok("/wp-json/wp/v2/icons/core?search=ARROW")).data.length > 1);
    assert.deepEqual(Object.keys((await ok("/wp-json/wp/v2/icons/core/bell?_fields=name,label")).data), ["name", "label"]);
    assert.deepEqual((await ok("/wp-json/wp/v2/icon-collections?_fields=slug")).data, [{ slug: "core" }]);
    assert.equal((await api("/wp-json/wp/v2/icons/core/not-real")).data.code, "rest_icon_not_found"); assert.equal((await api("/wp-json/wp/v2/icons/not-real")).data.code, "rest_icon_collection_not_found");
    for (const query of ["context=unknown", "collection=BAD", "per_page=0", "search[]=arrow", "page=0"]) assert.equal((await api("/wp-json/wp/v2/icons?" + query)).response.status, 400);
    const schema = await ok("/wp-json/wp/v2/icons/core/bell", "OPTIONS", undefined, ""); assert.equal(schema.data.schema.title, "icon"); assert.equal(schema.data.schema.properties.content.readonly, true);
    const collectionSchema = await ok("/wp-json/wp/v2/icon-collections", "OPTIONS", undefined, ""); assert.equal(collectionSchema.data.schema.title, "icon-collection");
    assert.equal((await api("/wp-json/wp/v2/icons/core/bell", "POST", { content: "<svg/>" })).response.status, 404);
    const metadata = await ok("/wp-json/wp/v2/block-types/core/icon"); assert.equal(metadata.data.is_dynamic, true); assert.equal(metadata.data.attributes.icon.type, "string"); assert.equal(metadata.data.supports.html, false);
    const preview = await ok("/wp-json/wp/v2/block-renderer/core/icon", "POST", { attributes: { icon: "core/bell", ariaLabel: "Preview bell" } }); assert.equal(dom(preview.data.rendered).querySelector("svg")!.getAttribute("aria-label"), "Preview bell");
    const native = block({ icon: "core/bell", ariaLabel: "Saved bell", rotation: 90, style: { dimensions: { width: "48px" } } });
    const created = await ok("/api/posts", "POST", { title: stamp, status: "publish", content: native }); posts.push(created.data.post.id);
    const saved = (await ok("/api/posts/" + posts[0])).data.post; assert.match(saved.rawContent, /core\/bell/); assert.match(saved.rawContent, /rotation/);
    const published = (await ok("/api/public/posts/" + saved.slug, "GET", undefined, "")).data.post; assert.equal(dom(published.content).querySelector("svg")!.getAttribute("aria-label"), "Saved bell"); assert.match(published.content, /rotate:90deg/);
    const changed = await ok("/api/posts/" + posts[0], "PUT", { version: saved.version, content: block({ icon: "core/arrow-down" }) });
    const revisions = (await ok("/api/posts/" + posts[0] + "/revisions")).data.revisions, previous = revisions.find((revision: any) => revision.rawContent.includes('"icon":"core/bell"')); assert.ok(previous);
    await ok(`/api/posts/${posts[0]}/revisions/${previous.id}/restore`, "POST", { version: changed.data.post.version });
    assert.match((await ok("/api/public/posts/" + saved.slug, "GET", undefined, "")).data.post.content, /Saved bell/);
    const restored = (await ok("/api/posts/" + posts[0])).data.post;
    const metadataOnly = await ok("/api/posts/" + posts[0], "PUT", { version: restored.version, excerpt: "Metadata only edit" });
    assert.equal(metadataOnly.data.post.rawContent, restored.rawContent, "Omitting content preserves canonical dynamic attributes.");
  } finally {
    for (const id of posts) { await api("/api/posts/" + id, "PUT", { status: "trash" }); await api("/api/posts/" + id, "DELETE"); }
    for (const auth of sessions) await api("/api/auth/logout", "POST", {}, auth);
    for (const id of users) await api("/api/users/" + id + "?deleteContent=true", "DELETE");
    if (cookie) await api("/api/auth/logout", "POST", {});
  }
});
