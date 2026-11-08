import test, { after } from "./isolated-test.js";
import "dotenv/config";
import assert from "node:assert/strict";
import { DOMParser } from "linkedom";
import { parse } from "@wordpress/block-serialization-default-parser";
import temml from "temml";
import { cleanBlocks, cleanContent, cleanRawContent } from "../server/utils.js";
import { renderSiteDocument } from "../server/block-renderer.js";
import { pool, defaultSettings } from "../server/db.js";

const dom = (html: string) => new DOMParser().parseFromString("<!doctype html><html><body>" + html + "</body></html>", "text/html");
const latex = String.raw`\frac{x^2}{y} \quad x<y \ \&`;
const mathML = `<semantics><mrow><mfrac linethickness="0.04em"><msup><mi>x</mi><mn>2</mn></msup><mi>y</mi></mfrac><mo>&lt;</mo><mi>z</mi></mrow><annotation encoding="application/x-tex">\\frac{x^2}{y} \\quad x&lt;y \\ \\&amp;</annotation></semantics>`;
const block = (attrs: Record<string, unknown> = {}, markup = mathML) => `<!-- wp:math ${JSON.stringify(attrs)} --><div class="wp-block-math"><math display="block">${markup}</math></div><!-- /wp:math -->`;
const json = (attributes: Record<string, unknown>) => ({ name: "core/math", attributes, innerBlocks: [] });
const settingsOnly = { query: async (sql: string) => { assert.match(sql, /FROM settings/); return { rows: [{ data: defaultSettings }] }; } } as any;
after(async () => { await pool.end(); });

test("canonical MathML preserves native structure, escaped LaTeX and presentation attributes", () => {
  const raw = cleanRawContent(block({ latex })), document = dom(raw);
  assert.equal(document.querySelector("math")!.getAttribute("display"), "block");
  assert.equal(document.querySelector("mfrac")!.getAttribute("linethickness"), "0.04em");
  assert.equal(document.querySelector("annotation")!.getAttribute("encoding"), "application/x-tex");
  assert.equal(document.querySelector("annotation")!.textContent, latex);
  assert.equal(parse(raw)[0].attrs!.latex, latex);
  assert.equal(cleanBlocks([json({ latex, mathML })])[0].attributes.latex, latex);
  const literal = String.raw`a<script>alert(1)</script><b & c`;
  assert.equal(cleanBlocks([json({ latex: literal })])[0].attributes.latex, literal, "LaTeX stays inert source text rather than being parsed as HTML");
});

test("real Temml equations retain native MathML fraction, scripts, matrix alignment and annotation", () => {
  const source = String.raw`\frac{x^2}{y}+\begin{cases}x&x<1\\y&x\ge1\end{cases}`;
  const output = temml.renderToString(source, { displayMode: true, annotate: true, throwOnError: true });
  const cleaned = dom(cleanContent(output));
  for (const tag of ["math", "semantics", "mfrac", "msup", "mtable", "mtr", "mtd", "annotation"]) assert.ok(cleaned.querySelector(tag), tag);
  assert.equal(cleaned.querySelector("annotation")!.textContent, source);
  const attrs = dom(cleanContent('<math><mtable columnalign="left center right" rowspacing="0.25em 1ex"><mtr rowalign="baseline"><mtd columnspan="2" columnalign="right"><mi mathvariant="normal" mathcolor="#123456">x</mi></mtd></mtr></mtable></math>'));
  assert.equal(attrs.querySelector("mtable")!.getAttribute("columnalign"), "left center right");
  assert.equal(attrs.querySelector("mtd")!.getAttribute("columnspan"), "2");
  assert.equal(attrs.querySelector("mi")!.getAttribute("mathcolor"), "#123456");
});

test("MathML cannot introduce executable attributes, embedded resources or XML integration points", () => {
  const unsafe = '<math href="javascript:bad()" xmlns="https://evil.test" onload="bad()"><mstyle mathbackground="url(javascript:bad())"><mi mathsize="1em;position:fixed" onclick="bad()">x</mi><mo href="https://evil.test" stretchy="bad" lspace="expression(bad())">+</mo><annotation encoding="text/html">Text</annotation><annotation-xml encoding="text/html"><script>bad()</script><iframe src="https://evil.test"></iframe></annotation-xml></mstyle></math>';
  const cleaned = cleanContent(unsafe);
  assert.doesNotMatch(cleaned, /javascript:|onload|onclick|href=|evil\.test|annotation-xml|<script|<iframe|expression|position:fixed|mathbackground=|mathsize=|stretchy=|lspace=|encoding=/);
  assert.ok(dom(cleaned).querySelector("math mi"));
  assert.equal(cleanContent(cleaned), cleaned, "A second sanitization cannot expose an alternate unsafe interpretation");
});

test("canonical and JSON-only Math render source wrappers and safe annotation fallbacks", async () => {
  const canonical = dom(await renderSiteDocument({ rawContent: cleanRawContent(block({ style: { background: { backgroundImage: { url: "/uploads/math.jpg" } } } })) }, { db: settingsOnly }));
  assert.ok(canonical.querySelector(".wp-block-math math mfrac"));
  assert.match(canonical.querySelector(".wp-block-math")!.getAttribute("style")!, /background-image:url/);
  const fallback = dom(await renderSiteDocument({ blocks: cleanBlocks([json({ latex: 'x<y & <script>bad()</script>' })]) }, { db: settingsOnly }));
  assert.equal(fallback.querySelector("annotation")!.textContent, 'x<y & <script>bad()</script>');
  assert.equal(fallback.querySelector("script"), null);
  const rendered = dom(await renderSiteDocument({ blocks: cleanBlocks([json({ latex, mathML })]) }, { db: settingsOnly }));
  assert.ok(rendered.querySelector("math mfrac")); assert.equal(rendered.querySelector("annotation")!.textContent, latex);
});

test("MathML and LaTeX survive real saves, history, autosaves and JSON/WXR copies", async () => {
  const base = process.env.TEST_API_URL || "http://127.0.0.1:3001", origin = process.env.APP_ORIGIN || "http://127.0.0.1:5173";
  const ids: number[] = []; let cookie = "";
  const api = async (path: string, method = "GET", body?: unknown) => {
    const response = await fetch(base + path, { method, headers: { Origin: origin, "Content-Type": "application/json", ...(cookie ? { Cookie: cookie } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const raw = await response.text(); let data: any; try { data = JSON.parse(raw); } catch { data = raw; } return { response, data, raw };
  };
  const check = (post: any) => { assert.equal(dom(post.rawContent).querySelector("annotation")!.textContent, latex); assert.ok(dom(post.rawContent).querySelector("mfrac")); assert.equal(post.blocks[0].attributes.latex, latex); };
  try {
    const signed = await api("/api/auth/login", "POST", { login: process.env.ADMIN_EMAIL, password: process.env.ADMIN_PASSWORD }); assert.equal(signed.response.status, 200); cookie = signed.response.headers.get("set-cookie")!.split(";")[0];
    const created = await api("/api/posts", "POST", { title: "Math " + Date.now(), status: "publish", content: block({ latex }), blocks: [json({ latex, mathML })] }); assert.equal(created.response.status, 201); let post = created.data.post; ids.push(post.id); check(post);
    const route = "/api/posts/" + post.id;
    const autosave = await api(route + "/autosave", "PUT", { version: post.version, content: block({ latex }) + "<p>Unsaved Math</p>", blocks: [json({ latex, mathML })] }); assert.equal(autosave.response.status, 200); assert.ok(dom(autosave.data.autosave.rawContent).querySelector("mfrac"));
    assert.equal(dom((await api(route + "/preview")).data.post.content).querySelector("annotation")!.textContent, latex);
    const saved = await api(route, "PUT", { version: post.version, content: block({ latex }) + "<p>Changed Math</p>", blocks: [json({ latex, mathML })] }); assert.equal(saved.response.status, 200); post = saved.data.post; check(post);
    const previous = (await api(route + "/revisions")).data.revisions.find((revision: any) => !revision.rawContent.includes("Changed Math")); assert.ok(previous);
    const restored = await api(route + "/revisions/" + previous.id + "/restore", "POST", { version: post.version }); assert.equal(restored.response.status, 200); check(restored.data.post);
    assert.equal(dom((await api("/api/public/posts/" + post.slug)).data.post.content).querySelector("annotation")!.textContent, latex);
    const archive = (await api("/api/tools/export")).data, record = archive.posts.find((item: any) => item.id === post.id);
    const copied = await api("/api/tools/import", "POST", { application: "WorldAct", version: 3, posts: [record] }); assert.equal(copied.response.status, 201); ids.push(...copied.data.postIds); check((await api("/api/posts/" + copied.data.postIds[0])).data.post);
    const wxr = await api("/api/tools/export?format=wxr"); assert.equal(wxr.response.status, 200);
    const item = wxr.raw.match(/<item>[\s\S]*?<\/item>/g)!.find(value => value.includes(`<wp:post_id>${post.id}</wp:post_id>`))!;
    const xml = `<rss xmlns:wp="http://wordpress.org/export/1.2/" xmlns:content="http://purl.org/rss/1.0/modules/content/" xmlns:excerpt="http://wordpress.org/export/1.2/excerpt/" xmlns:dc="http://purl.org/dc/elements/1.1/"><channel><wp:wxr_version>1.2</wp:wxr_version>${item}</channel></rss>`;
    const imported = await api("/api/tools/import", "POST", { format: "wxr", xml }); assert.equal(imported.response.status, 201); ids.push(...imported.data.postIds);
    const wxrPost = (await api("/api/posts/" + imported.data.postIds[0])).data.post;
    assert.ok(dom(wxrPost.rawContent).querySelector("mfrac")); assert.equal(dom(wxrPost.rawContent).querySelector("annotation")!.textContent, latex);
  } finally {
    for (const id of ids) { await api("/api/posts/" + id, "PUT", { status: "trash" }); await api("/api/posts/" + id, "DELETE"); }
    if (cookie) await api("/api/auth/logout", "POST", {});
  }
});
