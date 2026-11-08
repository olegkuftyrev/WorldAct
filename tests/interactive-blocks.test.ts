import test, { after } from "./isolated-test.js";
import "dotenv/config";
import assert from "node:assert/strict";
import { DOMParser } from "linkedom";
import { pool, defaultSettings, postFields } from "../server/db.js";
import { renderSiteDocument, renderPublicContent, SUPPORTED_DYNAMIC_BLOCKS, type SerializedNode } from "../server/block-renderer.js";
import { INTERACTIVE_BLOCKS } from "../server/interactive-blocks.js";
import { cleanContent, cleanRawContent, HttpError } from "../server/utils.js";
const block = (name: string, attrs: Record<string, unknown> = {}, html = "") => `<!-- wp:${name} ${JSON.stringify(attrs)}${html ? " -->" + html + `<!-- /wp:${name} -->` : " /-->"}`;
const dom = (html: string) => new DOMParser().parseFromString("<!doctype html><html><body>" + html + "</body></html>", "text/html");
const json = (name: string, attributes: Record<string, unknown> = {}, innerBlocks: SerializedNode[] = []): SerializedNode => ({ name: "core/" + name, attributes, innerBlocks });
const settingsOnly = { query: async (sql: string) => { assert.match(sql, /FROM settings/); return { rows: [{ data: defaultSettings }] }; } } as any;
const render = (rawContent: string) => renderSiteDocument({ rawContent: cleanRawContent(rawContent) }, { db: settingsOnly });
const paragraph = (text: string) => block("paragraph", {}, `<p>${text}</p>`);
const item = (title: string, body: string, attrs: Record<string, unknown> = {}, headingAttrs: Record<string, unknown> = {}) => block("accordion-item", attrs,
  `<div class="wp-block-accordion-item${attrs.openByDefault ? " is-open" : ""}">` +
  block("accordion-heading", headingAttrs, `<h3 class="wp-block-accordion-heading has-icon has-icon-right"><button type="button" class="wp-block-accordion-heading__toggle" style="padding:12px"><span class="wp-block-accordion-heading__toggle-title">${title}</span><span class="wp-block-accordion-heading__toggle-icon" aria-hidden="true">+</span></button></h3>`) +
  block("accordion-panel", {}, `<div class="wp-block-accordion-panel" role="region">${body}</div>`) + "</div>");
const accordion = (items: string, attrs: Record<string, unknown> = {}) => block("accordion", attrs, `<div class="wp-block-accordion" role="group">${items}</div>`);
const tabs = (labels: string[], contents = labels.map(label => paragraph(label + " body")), attrs: Record<string, unknown> = {}, panelAttrs: Record<string, unknown>[] = []) => block("tabs", attrs, '<div class="wp-block-tabs">' +
  block("tab-list", {}, '<div class="wp-block-tab-list" role="tablist">' + labels.map(label => `<button type="button" role="tab" style="padding:4px;color:#123456">${label}</button>`).join("") + "</div>") +
  block("tab-panels", {}, '<div class="wp-block-tab-panels">' + labels.map((label, index) => block("tab-panel", { label, ...panelAttrs[index] }, `<section class="wp-block-tab-panel" role="tabpanel" tabindex="0">${contents[index]}</section>`)).join("") + "</div>") + "</div>");
after(async () => { await pool.end(); });
function assertPairs(document: ReturnType<typeof dom>) {
  const ids = [...document.querySelectorAll("[id]")].map(element => element.id); assert.equal(new Set(ids).size, ids.length, "Every generated ID is unique within the response");
  for (const toggle of document.querySelectorAll("button[aria-controls]")) {
    const panel = document.getElementById(toggle.getAttribute("aria-controls")!); assert.ok(panel);
    assert.equal(panel.getAttribute("aria-labelledby"), toggle.id);
    assert.equal(panel.closest('[data-worldact-interactive]'), toggle.closest('[data-worldact-interactive]'));
  }
}

test("canonical interactive buttons retain native labels while form actions, handlers and invalid state are removed", () => {
  const raw = block("tab-list", {}, '<div class="wp-block-tab-list"><button type="submit" onclick="bad()" formaction="https://evil.invalid" data-wp-on--click="actions.bad" tabindex="999" aria-controls="bad\"id" aria-expanded="script">Rich <strong>label</strong></button><form action="https://evil.invalid"><input name="pwd" value="secret"></form></div>');
  const cleaned = cleanRawContent(raw), parsed = dom(cleaned), button = parsed.querySelector("button")!;
  assert.ok(button); assert.equal(button.getAttribute("type"), "button"); assert.equal(button.textContent, "Rich label");
  assert.doesNotMatch(cleaned, /onclick|formaction|data-wp|<form|<input|secret|tabindex|aria-expanded/);
  assert.equal(parsed.querySelector("strong")?.textContent, "label");
  const sanitized = dom(cleanContent('<div tabindex="0" hidden="until-found" aria-controls="safe-id" aria-selected="true"></div><div tabindex="4" hidden="hidden" aria-controls="bad id !" aria-selected="bad"></div>', true));
  const [valid, invalid] = [...sanitized.querySelectorAll("div")];
  assert.equal(valid.getAttribute("tabindex"), "0"); assert.equal(valid.getAttribute("hidden"), "until-found"); assert.equal(valid.getAttribute("aria-controls"), "safe-id");
  for (const attribute of ["tabindex", "hidden", "aria-controls", "aria-selected"]) assert.equal(invalid.getAttribute(attribute), null);
  assert.equal(dom(cleanContent('<button type="button">Standalone</button>')).querySelector("button"), null);
});

test("canonical accordion rich titles, default states, styles and ARIA survive sanitized reload without hiding content", async () => {
  const output = await render(accordion(item('First <strong>rich</strong>', paragraph("First body"), { openByDefault: true }) + item("Second", paragraph("Second body")), { autoclose: true, anchor: "faq" }));
  const parsed = dom(output), root = parsed.querySelector('[data-worldact-interactive="accordion"]')!;
  assert.equal(root.id, "faq"); assert.equal(root.getAttribute("data-worldact-autoclose"), "true");
  const items = [...root.querySelectorAll("[data-worldact-accordion-item]")]; assert.equal(items.length, 2);
  assert.deepEqual(items.map(element => element.getAttribute("data-worldact-open")), ["true", "false"]);
  assert.deepEqual([...root.querySelectorAll("button")].map(element => element.getAttribute("aria-expanded")), ["true", "false"]);
  assert.ok(root.querySelector("button strong")); assert.match(root.querySelector("button")!.getAttribute("style")!, /padding:12px/);
  assert.equal(parsed.querySelectorAll("[hidden]").length, 0); assert.match(output, /First body/); assert.match(output, /Second body/);
  assertPairs(parsed);
});

test("collapsed accordion images receive source low fetch priority without changing visible content", async () => {
  const image=block("image",{},'<figure class="wp-block-image"><img src="/uploads/safe.png" alt="Source image" loading="lazy" fetchpriority="high"></figure>');
  const parsed=dom(await render(accordion(item("Closed",image)+item("Open",image,{openByDefault:true}))));
  const images=[...parsed.querySelectorAll("img")];assert.deepEqual(images.map(img=>img.getAttribute("fetchpriority")),["low","high"]);
  assert.equal(images[0].getAttribute("alt"),"Source image");assert.equal(parsed.querySelectorAll("[hidden]").length,0);assertPairs(parsed);
  assert.doesNotMatch(cleanContent('<img src="/safe.png" fetchpriority="bad">'),/fetchpriority/);
});

test("JSON accordion controls inherit group heading/icon settings and malformed items keep readable content", async () => {
  const document = { blocks: [json("accordion", { headingLevel: 2, showIcon: false, iconPosition: "left" }, [
    json("accordion-item", { openByDefault: true }, [json("accordion-heading", { title: 'Title <em>emphasis</em>', style: { spacing: { padding: "8px" } } }), json("accordion-panel", {}, [json("paragraph", { content: "Readable panel" })])]),
    json("accordion-item", {}, [json("accordion-panel", {}, [json("paragraph", { content: "Malformed still readable" })])]),
  ])] };
  const parsed = dom(await renderSiteDocument(document, { db: settingsOnly }));
  assert.ok(parsed.querySelector("h2 button em")); assert.equal(parsed.querySelector(".wp-block-accordion-heading__toggle-icon"), null);
  assert.match(parsed.querySelector("button")!.getAttribute("style")!, /padding:8px/);
  assert.equal(parsed.querySelectorAll("[data-worldact-accordion-item]").length, 1); assert.equal(parsed.querySelectorAll("[aria-labelledby]").length, 1);
  assert.match(parsed.body.textContent!, /Malformed still readable/); assertPairs(parsed);
});

test("canonical tabs restore source-query button labels, styles and three panels with a real default index", async () => {
  const output = await render(tabs(["First <em>rich</em>", "Second", "Third"], undefined, { activeTabIndex: 2, editorActiveTabIndex: 0, anchor: "products" }, [{ anchor: "first-product" }]));
  const parsed = dom(output), root = parsed.querySelector('[data-worldact-interactive="tabs"]')!;
  assert.equal(root.id, "products"); assert.equal(root.getAttribute("data-worldact-active-tab"), "2");
  assert.equal(root.querySelector('[role="tablist"]')?.getAttribute("aria-label"), "Tabbed content");
  const buttons = [...root.querySelectorAll('[role="tab"]')], panels = [...root.querySelectorAll('[role="tabpanel"]')];
  assert.deepEqual(buttons.map(button => button.textContent), ["First rich", "Second", "Third"]); assert.ok(buttons[0].querySelector("em"));
  assert.deepEqual(buttons.map(button => button.getAttribute("aria-selected")), ["false", "false", "true"]);
  assert.deepEqual(buttons.map(button => button.getAttribute("tabindex")), ["-1", "-1", "0"]);
  assert.deepEqual(panels.map(panel => panel.getAttribute("data-worldact-tab-panel")), ["0", "1", "2"]);
  assert.equal(panels[0].id, "first-product"); assert.equal(panels[2].getAttribute("tabindex"), "0");
  assert.match(buttons[0].getAttribute("style")!, /padding:4px/); assert.equal(parsed.querySelectorAll("[hidden]").length, 0);
  assert.equal(panels.length, 3); assertPairs(parsed); assert.doesNotMatch(output, /data-wp|editorActiveTabIndex/);
});

test("JSON tab fallbacks derive labels from panels, clamp invalid defaults and ignore local editor selection", async () => {
  const document = (index: unknown) => ({ blocks: [json("tabs", { activeTabIndex: index, editorActiveTabIndex: 1 }, [json("tab-list", { ariaLabel: "Product <b>details</b>" }), json("tab-panels", {}, [json("tab-panel", { label: "Alpha" }, [json("paragraph", { content: "A body" })]), json("tab-panel", { label: "Beta" }, [json("paragraph", { content: "B body" })])])])] });
  for (const [index, expected] of [[undefined, "0"], [-5, "0"], [100, "1"], ["1", "0"], [1.9, "1"]] as const) {
    const parsed = dom(await renderSiteDocument(document(index), { db: settingsOnly }));
    assert.equal(parsed.querySelector("[data-worldact-active-tab]")?.getAttribute("data-worldact-active-tab"), expected);
    assert.deepEqual([...parsed.querySelectorAll('[role="tab"]')].map(button => button.textContent), ["Alpha", "Beta"]);
    assert.equal(parsed.querySelector('[role="tablist"]')?.getAttribute("aria-label"), "Product details"); assertPairs(parsed);
    assert.equal(parsed.querySelectorAll("[hidden]").length,0);
  }
});

test("JSON gradients, shadows, button padding and layout stay on their source target elements", async () => {
  const output=dom(await renderSiteDocument({blocks:[json("tabs",{style:{color:{gradient:"linear-gradient(90deg, #ffffff, #123456)"},shadow:"2px 3px 4px #123456"}},[json("tab-list",{style:{color:{text:"#123456",background:"#ffffff"},spacing:{padding:"8px",blockGap:"12px"},shadow:"1px 1px 2px #000000"},tabs:[{label:"One"}]}),json("tab-panels",{},[json("tab-panel",{label:"One"},[json("paragraph",{content:"Body"})])])])]},{db:settingsOnly}));
  const root=output.querySelector("[data-worldact-interactive=tabs]")!,list=output.querySelector('[role="tablist"]')!,button=output.querySelector('[role="tab"]')!;
  assert.match(root.getAttribute("style")!,/linear-gradient/);assert.match(root.getAttribute("style")!,/box-shadow/);
  assert.match(list.getAttribute("style")!,/gap:12px/);assert.doesNotMatch(list.getAttribute("style")!,/padding|background-color/);
  assert.match(button.getAttribute("style")!,/padding:8px/);assert.match(button.getAttribute("style")!,/background-color:#ffffff/);assert.match(button.getAttribute("style")!,/box-shadow/);
});

test("independent render calls and nested instances use collision-free, locally paired controls", async () => {
  const inner = tabs(["Nested A", "Nested B"]), nested = tabs(["Outer A", "Outer B"], [inner, accordion(item("Inner question", paragraph("Answer")))]);
  const output = await render(accordion(item("Outer question", nested)) + nested), parsed = dom(output);
  assertPairs(parsed); assert.equal(parsed.querySelectorAll('[data-worldact-interactive="tabs"]').length, 4);
  const first = await render(nested), reloaded = await render(nested);
  assert.deepEqual([...dom(first).querySelectorAll("[id]")].map(element=>element.id),[...dom(reloaded).querySelectorAll("[id]")].map(element=>element.id),"Hash targets survive an identical public reload");
  const generated = await Promise.all(["header","single","footer"].map((slug,index)=>renderSiteDocument({id:index+1,slug,type:index===1?"template":"template-part",rawContent:cleanRawContent(nested)},{db:settingsOnly}))), merged = dom(generated.join(""));
  assertPairs(merged);
  const stable = async(rawContent:string)=>dom(await renderSiteDocument({id:37,type:"post",slug:"stable",rawContent:cleanRawContent(rawContent)},{db:settingsOnly}));
  assert.deepEqual([...(await stable(nested)).querySelectorAll("[id]")].map(element=>element.id),[...(await stable(nested.replace("Outer A","Renamed A"))).querySelectorAll("[id]")].map(element=>element.id),"Title/content edits retain a logical root namespace");
  const instances=await Promise.all(["first","second"].map(instanceKey=>renderSiteDocument({rawContent:cleanRawContent(nested)},{db:settingsOnly,instanceKey})));assertPairs(dom(instances.join("")));
  const duplicates = dom(await render(tabs(["A", "B"], undefined, { anchor: "duplicate" }, [{ anchor: "same" }, { anchor: "same" }]) + tabs(["C", "D"], undefined, { anchor: "duplicate" })));
  assertPairs(duplicates); assert.ok(duplicates.getElementById("same"));
});

test("malformed duplicate structural children never emit duplicate paired controls", async () => {
  const document={blocks:[json("tabs",{},[json("tab-list",{tabs:[{label:"Primary"}]}),json("tab-list",{tabs:[{label:"Duplicate list"}]}),json("tab-panels",{},[json("tab-panel",{label:"Panel"},[json("paragraph",{content:"Body"})])])]),json("accordion",{},[json("accordion-item",{},[json("accordion-heading",{title:"Primary"}),json("accordion-heading",{title:"Extra heading"}),json("accordion-panel",{},[json("paragraph",{content:"Primary panel"})]),json("accordion-panel",{},[json("paragraph",{content:"Extra panel"})])])])]};
  const parsed=dom(await renderSiteDocument(document,{db:settingsOnly}));assertPairs(parsed);
  assert.equal(parsed.querySelectorAll('[role="tab"]').length,1);assert.equal(parsed.querySelectorAll('.wp-block-accordion-heading__toggle').length,1);
  assert.match(parsed.body.textContent!,/Duplicate list/);assert.match(parsed.body.textContent!,/Extra heading/);assert.match(parsed.body.textContent!,/Extra panel/);
});

test("malicious labels, anchors, CSS and saved directives never become script or cross-instance selectors", async () => {
  const output = await render(tabs(['<img src=x onerror="bad()">Title<script>bad()</script><a href="javascript:bad()">link</a>', "Safe"], undefined, { anchor: 'bad\" onclick=\"bad', activeTabIndex: 0 }, [{ anchor: 'bad id' }]));
  const parsed = dom(output); assert.doesNotMatch(output, /<script|onerror|onclick|javascript:|data-wp/);
  assert.equal(parsed.querySelector('[role="tab"] img'), null); assert.equal(parsed.querySelector('[role="tab"] a'), null); assertPairs(parsed);
  const unsafe = accordion(item("Safe", paragraph("Body"), {}, { title: '<script>bad()</script>Safe', style: { spacing: { padding: "1px;position:fixed" } } }));
  const cleaned = await render(unsafe); assert.doesNotMatch(cleaned, /<script|position:fixed/); assertPairs(dom(cleaned));
});

test("interactive children keep the shared public access rules for reusable references and protected content", async () => {
  const db = await pool.connect(); await db.query("BEGIN");
  try {
    const user = (await db.query("SELECT id FROM users WHERE role='administrator' LIMIT 1")).rows[0];
    const stamp = "interactive-" + Date.now().toString(36), entities: any[] = [];
    for (const status of ["publish", "draft", "trash"]) entities.push((await db.query("INSERT INTO block_entities(kind,title,slug,status,author_id,raw_content,content) VALUES('reusable',$1,$2,$3,$4,$5,$6) RETURNING id", [stamp, stamp + status, status, user.id, paragraph(status === "publish" ? "Public referenced body" : "CONFIDENTIAL-" + status), status === "publish" ? "Public referenced body" : "CONFIDENTIAL-" + status])).rows[0]);
    const body = entities.map(entity => block("block", { ref: entity.id })).join("");
    const raw = tabs(["Public", "Private"], [body, accordion(item("Question", body))]);
    const post = { id: 123, status: "publish", slug: stamp, type: "post", rawContent: cleanRawContent(raw), content: "", locked: false };
    const output = await renderPublicContent(post, { db, requestPath: "/sample/" });
    assert.match(output, /Public referenced body/); assert.doesNotMatch(output, /CONFIDENTIAL/); assertPairs(dom(output));
    const protectedContent = await renderSiteDocument({ rawContent: accordion(item("Public question", block("post-content"))) }, { db, post: { ...post, locked: true } });
    assert.match(protectedContent, /password protected/); assert.doesNotMatch(protectedContent, /Public referenced body|CONFIDENTIAL/);
  } finally { await db.query("ROLLBACK"); db.release(); }
});

const base = process.env.TEST_API_URL || "http://127.0.0.1:3001", origin = process.env.APP_ORIGIN || "http://127.0.0.1:5173";
test("the API persists canonical button labels and renders all eight native block types without leaking raw markup", async () => {
  let cookie = "", postId: number | undefined;
  const api = async (path: string, method = "GET", body?: unknown, auth = cookie) => { const response = await fetch(base + path, { method, headers: { Origin: origin, "Content-Type": "application/json", ...(auth ? { Cookie: auth } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }); return { response, data: await response.json() }; };
  try {
    const login = await api("/api/auth/login", "POST", { login: process.env.ADMIN_EMAIL, password: process.env.ADMIN_PASSWORD }, ""); assert.equal(login.response.status, 200); cookie = login.response.headers.get("set-cookie")!.split(";")[0];
    const content = tabs(["Native <strong>title</strong>", "Second"], [accordion(item("Nested title", paragraph("Native body"))), paragraph("Second body")]);
    const created = await api("/api/posts", "POST", { title: "Interactive " + Date.now(), content, status: "publish" }); assert.equal(created.response.status, 201, JSON.stringify(created.data)); postId = created.data.post.id;
    const edit = await api("/api/posts/" + postId); assert.match(edit.data.post.rawContent, /<button/); assert.match(edit.data.post.rawContent, /Native <strong>title<\/strong>/);
    const publicPost = await api("/api/public/posts/" + created.data.post.slug, "GET", undefined, "");
    assert.equal(publicPost.response.status, 200); assert.equal(publicPost.data.post.rawContent, undefined); assert.equal(dom(publicPost.data.post.content).querySelectorAll('[role="tab"]').length, 2); assertPairs(dom(publicPost.data.post.content));
    const metadata = await api("/wp-json/wp/v2/block-types");
    for (const name of INTERACTIVE_BLOCKS) { assert.ok(SUPPORTED_DYNAMIC_BLOCKS.has(name)); assert.ok(metadata.data.some((record: any) => record.name === name && record.is_dynamic)); }
    assert.equal((await api("/wp-json/wp/v2/block-types/core/tabs", "GET", undefined, "")).response.status, 401);
  } finally {
    if (postId) { await api("/api/posts/" + postId, "PUT", { status: "trash" }); await api("/api/posts/" + postId, "DELETE"); }
    if (cookie) await api("/api/auth/logout", "POST", {});
  }
});

test("large interactive expansions still stop at the shared output budget", async () => {
  let queries = 0;
  const raw = tabs(["Large"], [paragraph("x".repeat(256 * 1024))]);
  const db = { query: async (sql: string) => { queries++; if (sql.includes("FROM settings")) return { rows: [{ data: defaultSettings }] }; if (sql.includes("FROM block_entities")) return { rows: [{ rawContent: raw }] }; throw new Error("Unexpected query"); } } as any;
  await assert.rejects(() => renderSiteDocument({ rawContent: Array.from({ length: 40 }, () => block("block", { ref: 7 })).join("") }, { db }), (error: unknown) => error instanceof HttpError && error.status === 413);
  assert.equal(queries, 2);
});
