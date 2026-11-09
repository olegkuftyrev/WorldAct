import test, { after } from "./isolated-test.js";
import assert from "node:assert/strict";
import { DOMParser } from "linkedom";
import { parse } from "@wordpress/block-serialization-default-parser";
import { pool } from "../server/db.js";

after(() => pool.end());
const base = process.env.TEST_API_URL!, origin = process.env.APP_ORIGIN!;
type Reply = { status: number; text: string; json: any; headers: Headers };
type Host = { id: number; path: string; query: unknown; boundary: string };
type Check = () => unknown;

// Expected entity/coercion behavior is inferred from the supplied source; PHP
// is never executed. Preview/save differences and global default search remain.
test("explicit Search query fields survive real saved forms without inheriting ambient filters", { timeout: 180000 }, async t => {
  const original = (await pool.query("SELECT data FROM settings WHERE id=1")).rows[0].data;
  const people: number[] = [], posts: number[] = [], terms: number[] = [], documents: number[] = [], entities: number[] = [];
  const stamp = "explicit-search-" + Date.now(), word = stamp + "-needle";
  let cookie = "";
  async function api(path: string, method = "GET", body?: unknown, authenticated = false): Promise<Reply> {
    const response = await fetch(base + path, { method, headers: { Origin: origin, Cookie: authenticated ? cookie : "", "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(25000) });
    const text = await response.text(); let json: any;
    try { json = JSON.parse(text); } catch {}
    return { status: response.status, text, json, headers: response.headers };
  }
  async function setup(path: string, method = "GET", body?: unknown) {
    const r = await api(path, method, body, true);
    if (r.status < 200 || r.status >= 300) throw new Error("SETUP: " + method + " " + path + " returned " + r.status);
    return r.json;
  }
  async function person(label: string) {
    const user = (await setup("/api/users", "POST", { username: stamp + "-" + label, email: stamp + "-" + label + "@example.test", displayName: "Explicit Search " + label, password: "Explicit-search-fixture-password-123", role: "author" })).user;
    people.push(user.id);
    const row = (await pool.query("SELECT nicename FROM users WHERE id=$1", [user.id])).rows[0];
    if (!row?.nicename) throw new Error("SETUP: created author has no persisted nicename");
    return { id: user.id as number, slug: row.nicename as string };
  }
  async function savePost(values: Record<string, unknown>) {
    const post = (await setup("/api/posts", "POST", { title: stamp + " host", status: "publish", postDate: "2001-02-03T04:05:06", ...values })).post;
    if (!post?.id || typeof post.permalink !== "string") throw new Error("SETUP: created post has no actual identity/permalink");
    posts.push(post.id); return post;
  }
  const attrs = (query: unknown, present = true) => present ? { query } : {};
  function rawSearch(query: unknown, present = true) { return "<!-- wp:search " + JSON.stringify(attrs(query, present)) + " /-->"; }
  async function host(boundary: "raw" | "json", query: unknown, present = true): Promise<Host> {
    const post = await savePost({ type: "page", ...(boundary === "raw" ? { content: rawSearch(query, present) } : { content: "", blocks: [{ name: "core/search", attributes: attrs(query, present), innerBlocks: [] }] }) });
    const saved = boundary === "raw" ? (parse(post.rawContent || "").find(block => block.blockName === "core/search")?.attrs as any) : post.blocks?.[0]?.attributes;
    if (!saved || boundary === "json" && post.rawContent?.includes("<!-- wp:")) throw new Error("SETUP: saved raw/JSON boundary is not the requested one");
    return { id: post.id, path: post.permalink, query: saved.query, boundary };
  }
  function dom(text: string) { return new DOMParser().parseFromString(text, "text/html"); }
  function model(text: string) { const node = dom(text).querySelector("#worldact-public-document"); if (!node) return undefined; try { return JSON.parse(node.textContent!); } catch { return undefined; } }
  async function pair(path: string) {
    const [get, head] = await Promise.all([api(path), api(path, "HEAD")]);
    return { get, head, data: model(get.text) };
  }
  // Actual successful controls, in order. In particular a hidden s is not
  // overwritten with the visible input's typed value, and duplicates survive.
  function controls(form: any, typed: string) {
    const fields = new URLSearchParams(); let visible = 0;
    for (const input of form.querySelectorAll("input,select,textarea,button")) {
      if (["SELECT", "TEXTAREA"].includes(input.tagName)) throw new Error("SETUP: unexpected non-input Search control");
      const name = input.getAttribute("name"), type = (input.getAttribute("type") || (input.tagName === "BUTTON" ? "submit" : "text")).toLowerCase();
      if (!name || input.hasAttribute("disabled") || ["submit", "button", "reset", "file"].includes(type)) continue;
      if (["checkbox", "radio"].includes(type) && !input.hasAttribute("checked")) continue;
      const search = input.tagName === "INPUT" && type === "search" && name === "s";
      if (search) visible++;
      fields.append(name, search ? typed : input.getAttribute("value") || "");
    }
    if (visible !== 1) throw new Error("SETUP: expected exactly one visible Search s input");
    return fields;
  }
  async function formSubmission(path: string, typed = word, template = false) {
    const initial = await api(path), html = template ? initial.json?.content : initial.text;
    if (initial.status !== 200 || typeof html !== "string") throw new Error("SETUP: form acquisition returned " + initial.status);
    const document = dom(html), form = document.querySelector("form.wp-block-search") as any;
    if (!form) throw new Error("SETUP: actual returned HTML has no Search form");
    const fields = controls(form, typed), action = form.getAttribute("action"), method = form.getAttribute("method"), target = new URL(action || "", base);
    if (target.origin !== new URL(base).origin) throw new Error("SETUP: refusing a nonlocal actual form action");
    target.search = fields.toString();
    const submitted = await pair(target.pathname + target.search);
    return { initial, document, form, fields, hidden: [...form.querySelectorAll('input[type="hidden"]')].map((input: any) => [input.getAttribute("name"), input.getAttribute("value") || ""] as [string, string]), action, method, submitted };
  }
  // Complete all intended surfaces before the first policy assertion. Setup
  // faults are retained separately and do not prevent other tasks dispatching.
  async function gather(label: string, tasks: Array<[string, () => Promise<any>]>) {
    const result: Record<string, any> = {}, failures: string[] = [], observations: any[] = [];
    for (const [name, run] of tasks) {
      try {
        const value = await run(); result[name] = value;
        const p = value.submitted || (value.get ? value : undefined);
        observations.push({ name, ...(p ? { get: p.get.status, head: p.head.status, headBytes: p.head.text.length } : { status: value.status }), ...(value.fields ? { fieldNames: [...value.fields.keys()], hiddenNames: value.hidden.map((entry: string[]) => entry[0]) } : {}) });
      } catch (error) { const message = error instanceof Error ? error.message : String(error); failures.push(name + ": " + message); observations.push({ name, setupFailure: message }); }
    }
    console.log(JSON.stringify({ explicitSearchCase: label, observations }));
    if (failures.length) throw new Error("SETUP surfaces failed after all planned dispatches: " + failures.join(" | "));
    return result;
  }
  function verify(checks: Check[]) { const failures: string[] = []; for (const check of checks) try { check(); } catch (error) { failures.push(error instanceof Error ? error.message : String(error)); } assert.equal(failures.length, 0, failures.join("\n")); }
  // JSONB retains canonical key order, which can differ from the request.
  // Only ordering comes from saved keys; values/decoded names stay manual.
  function canonicalOrder(query: unknown, sourceNames: string[], expected: Array<[string, string]>) {
    assert.equal(sourceNames.length, expected.length, "Manual key/value table must stay complete");
    const bySource = new Map<string, [string, string]>();
    sourceNames.forEach((name, index) => { assert.equal(bySource.has(name), false, "Duplicate manual source key"); bySource.set(name, expected[index]); });
    const savedNames = Object.keys(query as object);
    assert.equal(savedNames.length, bySource.size, "Canonical saved query must retain every expected key");
    return savedNames.map(name => { assert.ok(bySource.has(name), "Unexpected canonical saved query key: " + name); return bySource.get(name)!; });
  }
  const common = (r: any, status = 200): Check[] => [() => assert.equal(r.action, "/"), () => assert.equal(r.method?.toLowerCase(), "get"), () => assert.equal(r.submitted.get.status, status), () => assert.equal(r.submitted.head.status, status), () => assert.equal(r.submitted.head.text, "")];
  const preview = (query: unknown) => api("/wp-json/wp/v2/block-renderer/core/search", "POST", { attributes: { query } }, true);
  try {
    const login = await api("/api/auth/login", "POST", { login: process.env.ADMIN_EMAIL, password: process.env.ADMIN_PASSWORD });
    if (login.status !== 200 || !login.headers.get("set-cookie")) throw new Error("SETUP: isolated administrator login failed");
    cookie = login.headers.get("set-cookie")!.split(";")[0];
    await setup("/api/settings", "PUT", { theme: "twentytwentyfive", permalinkStructure: "/%postname%/", frontPageMode: "posts", frontPageId: null, postsPageId: null, postsPerPage: 20, timezone: "UTC", pingServices: [] });
    const a = await person("a"), b = await person("b"), category = (await setup("/api/terms", "POST", { taxonomy: "category", name: stamp + " category", slug: stamp + "-category" })).term; terms.push(category.id);
    for (const user of [a, b]) for (const n of [1, 2]) await savePost({ type: "post", authorId: user.id, title: word + " public " + user.id + " " + n, content: "<p>EXPLICIT-PUBLIC-" + user.id + "</p>", ...(user === a ? { categoryIds: [category.id] } : {}) });
    await savePost({ authorId: a.id, title: word + " private", status: "private", content: "<p>EXPLICIT-PRIVATE-SECRET</p>" });
    await savePost({ authorId: a.id, title: word + " protected", password: "Explicit-search-protected-password", content: "<p>EXPLICIT-PROTECTED-SECRET</p>" });
    const template = stamp + "-default", doc = (await setup("/api/site-editor/documents", "POST", { type: "template", slug: template, title: "Explicit Search default control", content: rawSearch(undefined, false) })).document; documents.push(doc.id);

    await t.test("normal explicit maps survive raw and JSON forms while an ambient default remains global", async () => {
      const normal = { author: String(a.id), author_name: a.slug, category: category.slug, custom: "retained literal" }, contradictory = { author: String(b.id), author_name: a.slug }, unknown = { author_name: stamp + "-unknown" };
      const raw = await host("raw", normal), json = await host("json", normal), mismatch = await host("raw", contradictory), absent = await host("json", unknown);
      const ambient = "/?" + new URLSearchParams({ author: String(b.id), author_name: a.slug, category: category.slug, search: word, page: "1", "query-7-page": "3", commentPage: "4" });
      const r = await gather("normal-and-global", [["raw", () => formSubmission(raw.path)], ["json", () => formSubmission(json.path)], ["contradictory", () => formSubmission(mismatch.path)], ["unknown", () => formSubmission(absent.path)], ["default", () => formSubmission("/api/public/templates/" + template + "?" + new URLSearchParams({ requestPath: ambient }), word, true)]]);
      const checks: Check[] = [() => assert.deepEqual(raw.query, normal), () => assert.deepEqual(json.query, normal)];
      for (const name of ["raw", "json"]) checks.push(...common(r[name]), () => assert.deepEqual(r[name].hidden, name === "json" ? canonicalOrder(json.query, Object.keys(normal), Object.entries(normal)) : Object.entries(normal)), () => assert.equal(r[name].submitted.data?.route.query.namedAuthor?.selected?.authorId, a.id), () => assert.deepEqual(r[name].submitted.data?.site.posts.map((p: any) => p.authorId), [a.id, a.id]));
      for (const name of ["contradictory", "unknown"]) checks.push(...common(r[name]), () => assert.deepEqual(r[name].submitted.data?.site.posts, []), () => assert.equal(r[name].submitted.data?.route.query.namedAuthor?.selected?.authorId, name === "unknown" ? undefined : a.id));
      checks.push(() => assert.ok(r.unknown.submitted.data?.route.query.namedAuthor), () => assert.equal(r.unknown.submitted.data?.route.query.namedAuthor?.selected, null), ...common(r.default), () => assert.deepEqual([...r.default.fields.keys()], ["s"]), () => assert.equal(r.default.submitted.data?.route.query.namedAuthor, undefined), () => assert.ok(r.default.submitted.data?.site.posts.some((p: any) => p.authorId === b.id)));
      verify(checks);
    });

    await t.test("coercion and literal names preserve saved boundaries without widening preview normalization", async () => {
      const query = Object.fromEntries([["text", "unchanged"], ["integer", 42], ["decimal", 1.25], ["yes", true], ["no", false], ["nil", null], ["object", { child: "x" }], ["array", [1, 2]], ["custom[one]", "literal"], ["p%61ge", "encoded-looking"], ["action", "/untrusted-action"], ["method", "post"], ["submit", "shadow"], ["formaction", "/untrusted-action"], ["quote", 'x" autofocus onfocus="bad'], ["onfocus", "discarded"], ["constructor", "discarded"], ["__proto__", { polluted: true }]]);
      const expected = Object.entries({ text: "unchanged", integer: "42", decimal: "1.25", yes: "1", no: "", nil: "", object: "Array", array: "Array", "custom[one]": "literal", "p%61ge": "encoded-looking", action: "/untrusted-action", method: "post", submit: "shadow", formaction: "/untrusted-action", quote: 'x" autofocus onfocus="bad' });
      const raw = await host("raw", query), json = await host("json", query), array = await host("raw", ["zero", true, null, { child: "x" }]);
      const emptyHosts = await Promise.all([host("raw", {}, true), host("json", undefined, false), host("raw", null), host("json", "invalid-map"), host("json", ""), host("raw", true), host("raw", 123)]);
      const tasks: Array<[string, () => Promise<any>]> = [["raw", () => formSubmission(raw.path)], ["json", () => formSubmission(json.path)], ["array", () => formSubmission(array.path)], ["previewObject", () => preview({ word: "preview" })], ["previewArray", () => preview([])], ["previewNull", () => preview(null)], ["previewScalar", () => preview("invalid-map")]];
      emptyHosts.forEach((item, n) => tasks.push(["empty" + n, () => formSubmission(item.path)]));
      const r = await gather("coercion-and-boundaries", tasks), checks: Check[] = [];
      for (const name of ["raw", "json"]) checks.push(...common(r[name]), () => assert.deepEqual(r[name].hidden, name === "json" ? canonicalOrder(json.query, expected.map(entry => entry[0]), expected) : expected), () => assert.equal(Boolean(r[name].document.querySelector("[autofocus],[onfocus]")), false));
      checks.push(...common(r.array), () => assert.deepEqual(r.array.hidden, [["0", "zero"], ["1", "1"], ["2", ""], ["3", "Array"]]), () => assert.equal(r.previewObject.status, 200), () => assert.deepEqual([...dom(r.previewObject.json?.rendered || "").querySelectorAll('input[type="hidden"]')].map((input: any) => [input.getAttribute("name"), input.getAttribute("value") || ""]), [["word", "preview"]]));
      for (const name of ["previewArray", "previewNull", "previewScalar"]) checks.push(() => assert.equal(r[name].status, 400));
      emptyHosts.forEach((_item, n) => checks.push(...common(r["empty" + n]), () => assert.deepEqual(r["empty" + n].hidden, [])));
      for (const item of [raw, json]) for (const key of ["onfocus", "constructor", "__proto__"]) checks.push(() => assert.equal(Object.hasOwn(item.query as object, key), false));
      checks.push(() => assert.equal(({} as any).polluted, undefined)); verify(checks);
    });

    await t.test("entity-preserving attribute escaping reaches actual DOM and submitted pairs without double decoding", async () => {
      const entries: Array<[string, string]> = [["amp", "a&amp;b"], ["quote", "&quot;"], ["copy", "&copy;"], ["apos", "&apos;"], ["upper", "&AMP;"], ["html5", "&NotEqualTilde;"], ["unknown", "&unknown;"], ["decimal", "&#65;"], ["hex", "&#x41;"], ["twice", "&amp;#65;"], ["c1", "&#128;"], ["zero", "&#0;"], ["surrogate", "&#xD800;"], ["outside", "&#x110000;"], ["invalidUpperHex", "&#X00D800;"], ["zeroUpperHex", "&#X000;"], ["paddedDecimal", "&#00065;"], ["literal", 'a"b\'c café'], ["field&amp;name", "named"]];
      const expected: Array<[string, string]> = [["amp", "a&b"], ["quote", '"'], ["copy", "©"], ["apos", "&apos;"], ["upper", "&AMP;"], ["html5", "&NotEqualTilde;"], ["unknown", "&unknown;"], ["decimal", "A"], ["hex", "A"], ["twice", "&#65;"], ["c1", "€"], ["zero", "&#0;"], ["surrogate", "&#xD800;"], ["outside", "&#x110000;"], ["invalidUpperHex", "&#x00D800;"], ["zeroUpperHex", "&#X000;"], ["paddedDecimal", "A"], ["literal", 'a"b\'c café'], ["field&name", "named"]];
      const raw = await host("raw", Object.fromEntries(entries)), json = await host("json", Object.fromEntries(entries)), r = await gather("entities-and-values", [["raw", () => formSubmission(raw.path)], ["json", () => formSubmission(json.path)]]), checks: Check[] = [() => assert.deepEqual(raw.query, Object.fromEntries(entries)), () => assert.deepEqual(json.query, Object.fromEntries(entries))];
      for (const name of ["raw", "json"]) checks.push(...common(r[name]), () => assert.deepEqual(r[name].hidden, name === "json" ? canonicalOrder(json.query, entries.map(entry => entry[0]), expected) : expected), () => assert.deepEqual([...r[name].fields].slice(1), name === "json" ? canonicalOrder(json.query, entries.map(entry => entry[0]), expected) : expected), () => assert.equal(Boolean(r[name].document.querySelector("[autofocus],[onfocus]")), false));
      verify(checks);
    });

    await t.test("duplicates and explicit counters keep existing routing policy and anonymous bodies remain private", async () => {
      const duplicate = await host("raw", { s: "hidden second term" }), nested = await host("json", { "page[]": "2" }), counter = await host("raw", { author: String(a.id), page: "2", "query-7-page": "3", commentPage: "4" }), unknown = await host("json", { post_type: "page", custom: "no new authority" }), selected = await host("raw", { author: String(a.id), author_name: a.slug });
      const r = await gather("duplicates-counters-privacy", [["duplicate", () => formSubmission(duplicate.path)], ["nested", () => formSubmission(nested.path)], ["counter", () => formSubmission(counter.path)], ["unknown", () => formSubmission(unknown.path)], ["selected", () => formSubmission(selected.path)]]), checks: Check[] = [...common(r.duplicate, 400), ...common(r.nested, 400), ...common(r.counter, 404), ...common(r.unknown), ...common(r.selected), () => assert.deepEqual(r.duplicate.fields.getAll("s"), [word, "hidden second term"]), () => assert.equal(r.nested.fields.get("page[]"), "2"), () => assert.equal(r.counter.fields.get("page"), "2"), () => assert.equal(r.counter.submitted.data?.route.query.blockPages["query-7-page"], 3), () => assert.equal(r.counter.submitted.data?.route.query.commentPage, 4), () => assert.deepEqual(r.counter.submitted.data?.site.posts, []), () => assert.equal(r.unknown.fields.get("post_type"), "page"), () => assert.ok(r.unknown.submitted.data?.site.posts.some((p: any) => p.authorId === b.id)), () => assert.deepEqual(r.selected.submitted.data?.site.posts.map((p: any) => p.authorId), [a.id, a.id])];
      for (const name of ["unknown", "selected"]) checks.push(() => assert.doesNotMatch(r[name].submitted.get.text, /EXPLICIT-(?:PRIVATE|PROTECTED)-SECRET|Explicit-search-protected-password|@example\.test/));
      verify(checks);
    });

    await t.test("reusable explicit fields retain full single output and share the cumulative render byte limit", async () => {
      const large = "&".repeat(60 * 1024), entity = await setup("/wp-json/wp/v2/blocks", "POST", { title: stamp + " reusable query", status: "publish", content: rawSearch({ large }) });
      if (!entity?.id) throw new Error("SETUP: reusable block has no actual ID"); entities.push(entity.id);
      const reference = "<!-- wp:block " + JSON.stringify({ ref: entity.id }) + " /-->", one = await savePost({ type: "page", content: reference });
      const r = await gather("cumulative-resource", [["single", () => pair(one.permalink)], ["repeated", async () => { const repeated = await savePost({ type: "page", content: reference.repeat(40) }); return pair(repeated.permalink); }], ["discardedOversizePreview", () => preview(Object.fromEntries([["prototype", "x".repeat(100001)]]))]]), input = dom(r.single.get.text).querySelector('form.wp-block-search input[type="hidden"][name="large"]'), checks: Check[] = [() => assert.equal(r.single.get.status, 200), () => assert.equal(r.single.head.status, 200), () => assert.equal(r.single.head.text, ""), () => assert.equal(input?.getAttribute("value")?.length, large.length), () => assert.equal(input?.getAttribute("value") === large, true, "single hidden field must retain its entire value"), () => assert.equal(r.repeated.get.status, 413), () => assert.equal(r.repeated.head.status, 413), () => assert.equal(r.repeated.head.text, ""), () => assert.match(r.repeated.get.headers.get("content-type") || "", /application\/json/), () => assert.match(r.repeated.get.json?.error || "", /8 MiB/), () => assert.doesNotMatch(r.repeated.get.text, /<!doctype|worldact-public-document|wp-block-search/), () => assert.equal(r.discardedOversizePreview.status, 400)];
      // No giant Search URL is submitted: its route URL budget is independent.
      verify(checks);
    });
  } finally {
    if (documents.length) await pool.query("DELETE FROM site_documents WHERE id=ANY($1::int[])", [documents]);
    if (posts.length) await pool.query("DELETE FROM posts WHERE id=ANY($1::int[])", [posts]);
    if (entities.length) await pool.query("DELETE FROM block_entities WHERE id=ANY($1::int[])", [entities]);
    if (terms.length) await pool.query("DELETE FROM terms WHERE id=ANY($1::int[])", [terms]);
    if (people.length) await pool.query("DELETE FROM users WHERE id=ANY($1::int[])", [people]);
    await pool.query("UPDATE settings SET data=$1 WHERE id=1", [original]);
  }
});
