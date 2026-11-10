import test, { after } from "./isolated-test.js";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { parseHTML } from "linkedom";
import { parse } from "@wordpress/block-serialization-default-parser";

const base = process.env.TEST_API_URL!, origin = process.env.APP_ORIGIN!;
const testBaseline = "f6f4dcda7ff0f8b7ef08ae43f7dac3422e510a07";
type Reply = { status: number; text: string; data: any; error?: string };
type Group = { label: string; path: string; get: Reply; head: Reply; model: Reply };
type Preview = { label: string; status: number; rendered: string | null };
type Check = [string, () => void];
const groups = new Map<string, Group>(), previews = new Map<string, Preview>();
const postIds: number[] = [], documentIds: number[] = [], cleanupFailures: string[] = [];
let cookie = "", settingsRestore: Record<string, unknown> | undefined, documentRestore: any, cleaned = false, dispatches = 0;
const sha = (text: string) => createHash("sha256").update(text).digest("hex");

async function api(endpoint: string, method = "GET", body?: unknown): Promise<Reply> {
  try {
    const response = await fetch(base + endpoint, { method, redirect: "manual", signal: AbortSignal.timeout(15000),
      headers: { Origin: origin, "Content-Type": "application/json", ...(cookie ? { Cookie: cookie } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const text = await response.text(); let data: any = null;
    try { data = JSON.parse(text); } catch { /* Setup checks report malformed responses. */ }
    if (endpoint === "/api/auth/login" && response.ok) cookie = response.headers.get("set-cookie")?.split(";")[0] || "";
    return { status: response.status, text, data };
  } catch (error) { return { status: 0, text: "", data: null, error: String(error) }; }
}
async function setup(endpoint: string, method = "GET", body?: unknown, status = 200) {
  const reply = await api(endpoint, method, body);
  if (endpoint === "/api/posts" && method === "POST" && Number.isSafeInteger(reply.data?.post?.id)) postIds.push(reply.data.post.id);
  if (endpoint === "/api/site-editor/documents" && method === "POST" && Number.isSafeInteger(reply.data?.document?.id)) documentIds.push(reply.data.document.id);
  assert.equal(reply.error, undefined, "SETUP transport: " + endpoint); assert.equal(reply.status, status, "SETUP HTTP: " + endpoint);
  assert.notEqual(reply.data, null, "SETUP JSON: " + endpoint); return reply.data;
}
async function acquire(endpoint: string, method: "GET" | "HEAD", json = false): Promise<Reply> {
  dispatches++;
  try {
    // Public observations are anonymous; the setup cookie is never sent.
    const response = await fetch(base + endpoint, { method, redirect: "manual", signal: AbortSignal.timeout(15000), headers: { Accept: json ? "application/json" : "text/html" } });
    const text = await response.text(); let data: any = null, error: string | undefined;
    if (json) try { data = JSON.parse(text); } catch { error = "Public response was not JSON"; }
    return { status: response.status, text, data, ...(error ? { error } : {}) };
  } catch (error) { return { status: 0, text: "", data: null, error: String(error) }; }
}
async function gather(label: string, term: string) {
  const visiblePath = "/?" + new URLSearchParams({ s: term });
  const [get, head, model] = await Promise.all([acquire(visiblePath, "GET"), acquire(visiblePath, "HEAD"),
    acquire("/api/public/document?" + new URLSearchParams({ path: visiblePath }), "GET", true)]);
  groups.set(label, { label, path: visiblePath, get, head, model });
  const describe = (reply: Reply) => ({ status: reply.status, bytes: Buffer.byteLength(reply.text), sha256: sha(reply.text), error: reply.error });
  console.log("QUERY_TITLE_SEARCH_DISPATCH " + JSON.stringify({ label, path: visiblePath, get: describe(get), head: describe(head), model: { ...describe(model), kind: model.data?.route?.kind, template: model.data?.presentation?.document } }));
}
async function preview(label: string, key: "search" | "s", term: string, attributes: Record<string, unknown>) {
  dispatches++;
  // The actual handler reads URL query values, not an invented body.query.
  const reply = await api("/wp-json/wp/v2/block-renderer/core/query-title?" + new URLSearchParams({ [key]: term }), "POST", { attributes });
  const safe: Preview = { label, status: reply.status, rendered: typeof reply.data?.rendered === "string" ? reply.data.rendered : null };
  previews.set(label, safe);
  // Persist only selector label/status/rendered, not raw authenticated responses.
  console.log("QUERY_TITLE_SEARCH_PREVIEW " + JSON.stringify(safe));
}
function required(root: any, selector: string) {
  const element = root?.querySelector(selector); assert.ok(element, "Actual markup missing " + selector); return element;
}
function nativeMain(group: Group | undefined, mainId: string) {
  assert.equal(typeof group?.get.text, "string", "Actual native HTML");
  return required(required(parseHTML(group!.get.text).document, '.wp-site-blocks[data-worldact-public-island="true"]'), "#" + mainId);
}
function presentationMain(group: Group | undefined, mainId: string) {
  const html = group?.model.data?.presentation?.html; assert.equal(typeof html, "string", "Actual presentation fragment");
  return required(parseHTML("<!doctype html><html><body>" + html + "</body></html>").document, "#" + mainId);
}
function previewDocument(label: string) {
  const rendered = previews.get(label)?.rendered; assert.equal(typeof rendered, "string", "Actual preview rendered string");
  return parseHTML("<!doctype html><html><body>" + rendered + "</body></html>").document;
}
function verify(checks: Check[]) {
  const failures: string[] = [];
  for (const [label, check] of checks) try { check(); } catch (error) { failures.push(label + ": " + (error instanceof Error ? error.message : String(error))); }
  assert.equal(failures.length, 0, failures.join("\n"));
}
function commonChecks(label: string, term: string, saved: any, mainId: string, marker: string, populatedPostId?: number): Check[] {
  const group = groups.get(label), model = group?.model.data;
  const checks: Check[] = [[label + " gathered", () => assert.ok(group)],
    ...(["get", "head", "model"] as const).flatMap(surface => [
      [label + " " + surface + " transport/parse", () => assert.equal(group?.[surface].error, undefined)],
      [label + " " + surface + " HTTP", () => assert.equal(group?.[surface].status, 200)],
    ] as Check[]), [label + " HEAD empty", () => assert.equal(group?.head.text, "")],
    [label + " model status", () => assert.equal(model?.status, 200)], [label + " actual search route kind", () => assert.equal(model?.route?.kind, "archive")],
    [label + " actual normalized term", () => assert.equal(model?.route?.query?.search, term)],
    [label + " Source presentation", () => assert.equal(model?.presentation?.kind, "source")],
    [label + " actual template ID", () => assert.equal(model?.presentation?.document?.id, saved.id)],
    [label + " actual template slug", () => assert.equal(model?.presentation?.document?.slug, saved.slug)],
    [label + " actual template type", () => assert.equal(model?.presentation?.document?.type, "template")]];
  if (populatedPostId !== undefined) checks.push([label + " owned post populates search", () => assert.ok(model?.site?.posts?.some((post: any) => post.id === populatedPostId))]);
  for (const [surface, read] of [["native", () => nativeMain(group, mainId)], ["model HTML", () => presentationMain(group, mainId)]] as const)
    checks.push([label + " " + surface + " independent marker", () => assert.equal(Array.from(read().querySelectorAll("p")).filter((node: any) => node.textContent.trim() === marker).length, 1)]);
  return checks;
}
function titleChecks(label: string, root: () => any, anchor: string, expected: string, section = false): Check[] {
  return [[label + " anchor count", () => assert.equal(root().querySelectorAll("#" + anchor).length, 1)],
    [label + " wrapper count", () => assert.equal((section ? required(root(), "#" + anchor + "-case") : root()).querySelectorAll(".wp-block-query-title").length, 1)],
    [label + " exact class", () => assert.ok(required(root(), "#" + anchor).classList.contains("wp-block-query-title"))],
    [label + " current h1 tag", () => assert.equal(required(root(), "#" + anchor).tagName, "H1")],
    [label + " exact text", () => assert.equal(required(root(), "#" + anchor).textContent, expected)],
    [label + " text has no active child markup", () => assert.equal(required(root(), "#" + anchor).children.length, 0)]];
}
async function cleanup() {
  if (cleaned) return; cleaned = true;
  const attempt = async (endpoint: string, method: string, body?: unknown) => {
    const reply = await api(endpoint, method, body);
    if (reply.error || reply.status < 200 || reply.status >= 300) cleanupFailures.push(method + " " + endpoint + ": " + reply.status + (reply.error ? " " + reply.error : ""));
    return reply;
  };
  for (const id of postIds) { await attempt("/api/posts/" + id, "PUT", { status: "trash" }); await attempt("/api/posts/" + id, "DELETE"); }
  for (const id of documentIds) await attempt("/api/site-editor/documents/" + id, "DELETE");
  if (documentRestore) {
    const inventory = await attempt("/api/site-editor", "GET"), current = inventory.data?.templates?.find((entry: any) => entry.id === documentRestore.id);
    if (!current) cleanupFailures.push("Could not acquire actual search template restoration version: " + documentRestore.id);
    else await attempt("/api/site-editor/documents/" + documentRestore.id, "PUT", { type: documentRestore.type, slug: documentRestore.slug, title: documentRestore.title,
      content: documentRestore.rawContent ?? documentRestore.content, blocks: documentRestore.blocks, version: current.version });
  }
  if (settingsRestore) await attempt("/api/settings", "PUT", settingsRestore);
  if (cookie) await attempt("/api/auth/logout", "POST");
  console.log("QUERY_TITLE_SEARCH_FIXTURE_CLEANUP " + JSON.stringify({ postIds, documentIds, restoredDocumentId: documentRestore?.id || null, settingsRestoreAttempted: Boolean(settingsRestore), failures: cleanupFailures }));
}
after(async () => { await cleanup(); assert.equal(cleanupFailures.length, 0, "Owned API cleanup: " + cleanupFailures.join("; ")); });

test("explicit search QueryTitle formatting follows default, false, prefix and entity source text without new alias behavior", async t => {
  const stamp = Date.now().toString(36), token = "searchformat" + stamp, fixtureSlug = "qt-search-" + stamp;
  const mainId = fixtureSlug + "-main", marker = "SEARCH-FORMAT-MARKER-" + stamp;
  const entityTerm = token + ' A&amp;B &#00065; <x> "q" \'r\'', visibleEntityTerm = token + ' A&B A <x> "q" \'r\'';
  const anchors = { default: fixtureSlug + "-default", explicitTrue: fixtureSlug + "-true", falseTerm: fixtureSlug + "-false", prefixFalse: fixtureSlug + "-prefix" };
  const attributes = { default: { type: "search", anchor: anchors.default }, explicitTrue: { type: "search", anchor: anchors.explicitTrue, showSearchTerm: true }, falseTerm: { type: "search", anchor: anchors.falseTerm, showSearchTerm: false }, prefixFalse: { type: "search", anchor: anchors.prefixFalse, showPrefix: false } };
  const previewAnchors = Object.fromEntries(["default", "true", "false", "prefix", "entity", "raw-s"].map(key => [key, fixtureSlug + "-preview-" + key]));
  const quoted = (term: string) => "Search results for: “" + term + "”";
  try {
    await setup("/api/auth/login", "POST", { login: process.env.ADMIN_EMAIL, password: process.env.ADMIN_PASSWORD }); assert.ok(cookie, "SETUP administrator session");
    const settings = (await setup("/api/settings")).settings;
    settingsRestore = Object.fromEntries(["theme", "timezone", "frontPageMode", "permalinkStructure"].map(key => [key, settings[key]]));
    await setup("/api/settings", "PUT", { theme: "twentytwentyfive", timezone: "UTC", frontPageMode: "posts", permalinkStructure: "/%postname%/" });
    const content = '<!-- wp:group ' + JSON.stringify({ tagName: "main", anchor: mainId }) + ' --><main id="' + mainId + '" class="wp-block-group"><p>' + marker + '</p>'
      + (Object.keys(attributes) as Array<keyof typeof attributes>).map(key => '<section id="' + anchors[key] + '-case"><!-- wp:query-title ' + JSON.stringify(attributes[key]) + ' /--></section>').join("") + '</main><!-- /wp:group -->';
    const existing = (await setup("/api/site-editor")).templates.find((entry: any) => entry.slug === "search");
    let saved: any;
    if (existing) { documentRestore = existing; saved = (await setup("/api/site-editor/documents/" + existing.id, "PUT", { type: "template", slug: "search", title: existing.title, content, version: existing.version })).document; }
    else saved = (await setup("/api/site-editor/documents", "POST", { type: "template", slug: "search", title: fixtureSlug, content }, 201)).document;
    assert.ok(Number.isSafeInteger(saved.id), "SETUP actual saved template ID");
    const search = (await setup("/api/site-editor")).templates.find((entry: any) => entry.id === saved.id);
    assert.ok(search, "SETUP actual template reread"); assert.equal(search.slug, "search", "SETUP saved slug"); assert.equal(search.type, "template", "SETUP saved type"); assert.equal(search.version, saved.version, "SETUP saved version");
    assert.ok(search.rawContent.includes('id="' + mainId + '"') && search.rawContent.includes(marker), "SETUP literal main/independent marker");
    const flattened: any[] = [], walk = (blocks: any[]) => { for (const block of blocks) { flattened.push(block); walk(block.innerBlocks || []); } };
    walk(parse(search.rawContent));
    for (const key of Object.keys(attributes) as Array<keyof typeof attributes>) {
      const nodes = flattened.filter(block => block.blockName === "core/query-title" && block.attrs?.anchor === anchors[key]);
      assert.equal(nodes.length, 1, "SETUP retained QueryTitle anchor " + key); assert.deepEqual(nodes[0].attrs, attributes[key], "SETUP exact explicit type/default absence/boolean/prefix attrs " + key);
      assert.ok(search.rawContent.includes('id="' + anchors[key] + '-case"'), "SETUP literal case container " + key);
    }
    const created = (await setup("/api/posts", "POST", { type: "post", title: token + " ordinary fixture", slug: fixtureSlug + "-post", status: "publish", commentStatus: "closed", content: "<p>OWNED-PLAIN-SEARCH-" + token + "</p>" }, 201)).post;
    const post = (await setup("/api/posts/" + created.id)).post;
    assert.equal(post.id, created.id, "SETUP refetched post ID"); assert.equal(post.type, "post", "SETUP post type"); assert.equal(post.status, "publish", "SETUP published post"); assert.ok(Number.isSafeInteger(post.version), "SETUP post version");
    assert.equal(typeof post.permalink, "string", "SETUP actual permalink"); assert.equal(new URL(post.permalink, base).origin, new URL(base).origin, "SETUP local permalink");
    assert.ok(entityTerm.length <= 200, "SETUP bounded public search term");
    await gather("ordinary", token); await gather("entity", entityTerm);
    await preview("default", "search", token, { type: "search", anchor: previewAnchors.default });
    await preview("true", "search", token, { type: "search", anchor: previewAnchors.true, showSearchTerm: true });
    await preview("false", "search", token, { type: "search", anchor: previewAnchors.false, showSearchTerm: "false" });
    await preview("prefix", "search", token, { type: "search", anchor: previewAnchors.prefix, showPrefix: false });
    await preview("entity", "search", entityTerm, { type: "search", anchor: previewAnchors.entity });
    await preview("raw-s", "s", token, { type: "search", anchor: previewAnchors["raw-s"] });
    console.log("QUERY_TITLE_SEARCH_GATHER_COMPLETE " + JSON.stringify({ testBaseline, groups: groups.size, previews: previews.size, dispatches, intendedDispatches: 12 }));
    const proofPath = process.env.QUERY_TITLE_SEARCH_FORMAT_PROOF_PATH;
    if (proofPath) {
      assert.ok(path.isAbsolute(proofPath), "HARNESS proof path must be absolute");
      await writeFile(proofPath, JSON.stringify({ testBaseline, dispatches, fixture: { postId: post.id, type: post.type, version: post.version, slug: post.slug, permalink: post.permalink, token, entityTerm, visibleEntityTerm, template: { id: search.id, slug: search.slug, type: search.type, version: search.version, mainId, marker }, anchors, previewAnchors }, groups: [...groups.values()], previews: [...previews.values()] }, null, 2) + "\n", { flag: "wx", mode: 0o600 });
      console.log("QUERY_TITLE_SEARCH_SAFE_PROOF " + JSON.stringify({ path: proofPath }));
    }
    const publicReads = (label: string) => [["native", () => nativeMain(groups.get(label), mainId)], ["model HTML", () => presentationMain(groups.get(label), mainId)]] as const;
    const ordinaryChecks = () => commonChecks("ordinary", token, search, mainId, marker, post.id);
    const previewChecks = (label: string): Check[] => [[label + " preview HTTP", () => assert.equal(previews.get(label)?.status, 200)], [label + " preview rendered string", () => assert.equal(typeof previews.get(label)?.rendered, "string")]];
    // All twelve actual responses are consumed before the five aggregate feature children.
    await t.test("omitted and explicit true showSearchTerm retain the complete curly-quoted label", () => {
      const checks = ordinaryChecks(); checks.push(["all twelve reads consumed", () => assert.equal(dispatches, 12)]);
      for (const key of ["default", "explicitTrue"] as const) for (const [surface, read] of publicReads("ordinary")) checks.push(...titleChecks(surface + " " + key, read, anchors[key], quoted(token), true));
      for (const label of ["default", "true"]) checks.push(...previewChecks(label), ...titleChecks(label + " preview", () => previewDocument(label), previewAnchors[label], quoted(token)));
      verify(checks);
    });
    await t.test("showSearchTerm false emits exactly Search results without exposing the term", () => {
      const checks = ordinaryChecks();
      for (const [surface, read] of publicReads("ordinary")) checks.push(...titleChecks(surface + " false", read, anchors.falseTerm, "Search results", true));
      checks.push(...previewChecks("false"), ...titleChecks("normalized false preview", () => previewDocument("false"), previewAnchors.false, "Search results")); verify(checks);
    });
    await t.test("showPrefix false does not remove any part of the explicit search label", () => {
      const checks = ordinaryChecks();
      for (const [surface, read] of publicReads("ordinary")) checks.push(...titleChecks(surface + " prefix", read, anchors.prefixFalse, quoted(token), true));
      checks.push(...previewChecks("prefix"), ...titleChecks("prefix preview", () => previewDocument("prefix"), previewAnchors.prefix, quoted(token))); verify(checks);
    });
    await t.test("literal entities, quotes and angle brackets produce exact safe visible search text", () => {
      const checks = commonChecks("entity", entityTerm, search, mainId, marker);
      for (const key of Object.keys(attributes) as Array<keyof typeof attributes>) for (const [surface, read] of publicReads("entity"))
        checks.push(...titleChecks(surface + " entity " + key, read, anchors[key], key === "falseTerm" ? "Search results" : quoted(visibleEntityTerm), true));
      checks.push(...previewChecks("entity"), ...titleChecks("entity preview", () => previewDocument("entity"), previewAnchors.entity, quoted(visibleEntityTerm))); verify(checks);
    });
    await t.test("raw URL s preview preserves its current Blog fallback and gains no new alias behavior", () => {
      const checks: Check[] = [["two public groups", () => assert.equal(groups.size, 2)], ["six renderer API reads", () => assert.equal(previews.size, 6)], ["twelve dispatched reads", () => assert.equal(dispatches, 12)]];
      for (const label of previews.keys()) checks.push(...previewChecks(label));
      checks.push(...titleChecks("raw-s compatibility", () => previewDocument("raw-s"), previewAnchors["raw-s"], "Blog")); verify(checks);
    });
    // Entity search may have no matches; no new SQL, eligibility, alias, level0, registry, UI or source byte-spelling claim.
  } finally { await cleanup(); }
});
