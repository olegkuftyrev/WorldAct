import test, { after } from "./isolated-test.js";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { parseHTML } from "linkedom";
import { parse } from "@wordpress/block-serialization-default-parser";

const base = process.env.TEST_API_URL!, origin = process.env.APP_ORIGIN!;
const testBaseline = "d7c9a996f7336fc91049833db89789385a214545";
type Reply = { status: number; text: string; data: any; error?: string };
type Group = { label: string; path: string; get: Reply; head: Reply; model: Reply };
type Preview = { label: string; status: number; rendered: string | null };
type Check = [string, () => void];
const groups = new Map<string, Group>(), previews = new Map<string, Preview>();
const postIds: number[] = [], documentIds: number[] = [], documentRestores: any[] = [], cleanupFailures: string[] = [];
let cookie = "", settingsRestore: Record<string, unknown> | undefined, cleaned = false, dispatches = 0;
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
  if (method === "POST" && endpoint === "/api/posts" && Number.isSafeInteger(reply.data?.post?.id)) postIds.push(reply.data.post.id);
  if (method === "POST" && endpoint === "/api/site-editor/documents" && Number.isSafeInteger(reply.data?.document?.id)) documentIds.push(reply.data.document.id);
  assert.equal(reply.error, undefined, "SETUP transport: " + endpoint); assert.equal(reply.status, status, "SETUP HTTP: " + endpoint);
  assert.notEqual(reply.data, null, "SETUP JSON: " + endpoint); return reply.data;
}
async function acquire(endpoint: string, method: "GET" | "HEAD", json = false): Promise<Reply> {
  dispatches++;
  try {
    // These actual public observations never send the setup cookie.
    const response = await fetch(base + endpoint, { method, redirect: "manual", signal: AbortSignal.timeout(15000), headers: { Accept: json ? "application/json" : "text/html" } });
    const text = await response.text(); let data: any = null, error: string | undefined;
    if (json) try { data = JSON.parse(text); } catch { error = "Public response was not JSON"; }
    return { status: response.status, text, data, ...(error ? { error } : {}) };
  } catch (error) { return { status: 0, text: "", data: null, error: String(error) }; }
}
async function gather(label: string, visiblePath: string) {
  const [get, head, model] = await Promise.all([acquire(visiblePath, "GET"), acquire(visiblePath, "HEAD"),
    acquire("/api/public/document?" + new URLSearchParams({ path: visiblePath }), "GET", true)]);
  groups.set(label, { label, path: visiblePath, get, head, model });
  const describe = (reply: Reply) => ({ status: reply.status, bytes: Buffer.byteLength(reply.text), sha256: sha(reply.text), error: reply.error });
  console.log("QUERY_TITLE_MISSING_DISPATCH " + JSON.stringify({ label, path: visiblePath, get: describe(get), head: describe(head), model: { ...describe(model), kind: model.data?.route?.kind, template: model.data?.presentation?.document } }));
}
async function preview(label: string, attributes: Record<string, unknown>) {
  dispatches++;
  // The handler reads URL query year, not an invented body.query field.
  const reply = await api("/wp-json/wp/v2/block-renderer/core/query-title?year=2001", "POST", { attributes });
  const rendered = typeof reply.data?.rendered === "string" ? reply.data.rendered : null;
  const safe: Preview = { label, status: reply.status, rendered };
  previews.set(label, safe);
  // Never persist raw authenticated responses, headers, cookies or setup data.
  console.log("QUERY_TITLE_MISSING_PREVIEW " + JSON.stringify(safe));
}
function required(root: any, selector: string) {
  const element = root?.querySelector(selector); assert.ok(element, "Actual markup missing " + selector); return element;
}
function nativeMain(group: Group | undefined, mainId: string) {
  assert.equal(typeof group?.get.text, "string", "Actual native HTML");
  const document = parseHTML(group!.get.text).document;
  return required(required(document, '.wp-site-blocks[data-worldact-public-island="true"]'), "#" + mainId);
}
function presentationMain(group: Group | undefined, mainId: string) {
  const html = group?.model.data?.presentation?.html; assert.equal(typeof html, "string", "Actual presentation fragment");
  return required(parseHTML("<!doctype html><html><body>" + html + "</body></html>").document, "#" + mainId);
}
function verify(checks: Check[]) {
  const failures: string[] = [];
  for (const [label, check] of checks) try { check(); } catch (error) { failures.push(label + ": " + (error instanceof Error ? error.message : String(error))); }
  assert.equal(failures.length, 0, failures.join("\n"));
}
function commonChecks(label: string, saved: any, mainId: string, marker: string, postId: number): Check[] {
  const group = groups.get(label), model = group?.model.data;
  const checks: Check[] = [[label + " gathered", () => assert.ok(group)],
    ...(["get", "head", "model"] as const).flatMap(surface => [
      [label + " " + surface + " transport/parse", () => assert.equal(group?.[surface].error, undefined)],
      [label + " " + surface + " HTTP", () => assert.equal(group?.[surface].status, 200)],
    ] as Check[]), [label + " HEAD empty", () => assert.equal(group?.head.text, "")],
    [label + " model status", () => assert.equal(model?.status, 200)],
    [label + " archive route kind", () => assert.equal(model?.route?.kind, "archive")],
    [label + " Source presentation", () => assert.equal(model?.presentation?.kind, "source")],
    [label + " actual template ID", () => assert.equal(model?.presentation?.document?.id, saved.id)],
    [label + " actual template slug", () => assert.equal(model?.presentation?.document?.slug, saved.slug)],
    [label + " actual template type", () => assert.equal(model?.presentation?.document?.type, "template")],
    [label + " actual fixture post in listing", () => assert.ok(model?.site?.posts?.some((post: any) => post.id === postId))]];
  for (const [surface, read] of [["native", () => nativeMain(group, mainId)], ["model HTML", () => presentationMain(group, mainId)]] as const)
    checks.push([label + " " + surface + " independent marker", () => assert.equal(Array.from(read().querySelectorAll("p")).filter((node: any) => node.textContent.trim() === marker).length, 1)]);
  return checks;
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
  for (const saved of documentRestores) {
    const inventory = await attempt("/api/site-editor", "GET"), current = inventory.data?.templates?.find((entry: any) => entry.id === saved.id);
    if (!current) cleanupFailures.push("Could not acquire actual template version for restoration: " + saved.id);
    else await attempt("/api/site-editor/documents/" + saved.id, "PUT", { type: saved.type, slug: saved.slug, title: saved.title,
      content: saved.rawContent ?? saved.content, blocks: saved.blocks, version: current.version });
  }
  if (settingsRestore) await attempt("/api/settings", "PUT", settingsRestore);
  if (cookie) await attempt("/api/auth/logout", "POST");
  console.log("QUERY_TITLE_MISSING_FIXTURE_CLEANUP " + JSON.stringify({ postIds, documentIds, restoredDocumentIds: documentRestores.map(entry => entry.id), settingsRestoreAttempted: Boolean(settingsRestore), failures: cleanupFailures }));
}
after(async () => { await cleanup(); assert.equal(cleanupFailures.length, 0, "Owned API cleanup: " + cleanupFailures.join("; ")); });

test("omitted and empty QueryTitle types emit no wrapper while explicit archive, unknown date and current search controls remain", async t => {
  const stamp = Date.now().toString(36), token = "missingtype" + stamp, fixtureSlug = "qt-missing-" + stamp;
  const dateMain = fixtureSlug + "-date-main", searchMain = fixtureSlug + "-search-main", dateMarker = "DATE-MARKER-" + stamp, searchMarker = "SEARCH-MARKER-" + stamp;
  const anchors = { omitted: fixtureSlug + "-omitted", empty: fixtureSlug + "-empty", archive: fixtureSlug + "-archive", unknown: fixtureSlug + "-unknown", search: fixtureSlug + "-search" };
  const attributes = { omitted: { anchor: anchors.omitted }, empty: { type: "", anchor: anchors.empty }, archive: { type: "archive", anchor: anchors.archive }, unknown: { type: "extension-example", anchor: anchors.unknown }, search: { type: "search", anchor: anchors.search } };
  const title = (attrs: Record<string, unknown>) => '<!-- wp:query-title ' + JSON.stringify(attrs) + ' /-->';
  const groupContent = (mainId: string, marker: string, children: string) => '<!-- wp:group ' + JSON.stringify({ tagName: "main", anchor: mainId }) + ' --><main id="' + mainId + '" class="wp-block-group"><p>' + marker + '</p>' + children + '</main><!-- /wp:group -->';
  try {
    await setup("/api/auth/login", "POST", { login: process.env.ADMIN_EMAIL, password: process.env.ADMIN_PASSWORD }); assert.ok(cookie, "SETUP administrator session");
    const settings = (await setup("/api/settings")).settings;
    settingsRestore = Object.fromEntries(["theme", "timezone", "frontPageMode", "permalinkStructure"].map(key => [key, settings[key]]));
    await setup("/api/settings", "PUT", { theme: "twentytwentyfive", timezone: "UTC", frontPageMode: "posts", permalinkStructure: "/%postname%/" });
    const makeTemplate = async (slug: "date" | "search", mainId: string, marker: string, cases: Array<keyof typeof attributes>) => {
      const content = groupContent(mainId, marker, cases.map(key => '<section id="' + anchors[key] + '-case">' + title(attributes[key]) + '</section>').join(""));
      const existing = (await setup("/api/site-editor")).templates.find((entry: any) => entry.slug === slug);
      let saved: any;
      if (existing) { documentRestores.push(existing); saved = (await setup("/api/site-editor/documents/" + existing.id, "PUT", { type: "template", slug, title: existing.title, content, version: existing.version })).document; }
      else saved = (await setup("/api/site-editor/documents", "POST", { type: "template", slug, title: fixtureSlug + " " + slug, content }, 201)).document;
      assert.ok(Number.isSafeInteger(saved.id), "SETUP actual saved document ID");
      const reread = (await setup("/api/site-editor")).templates.find((entry: any) => entry.id === saved.id);
      assert.ok(reread, "SETUP actual document reread"); assert.equal(reread.slug, slug, "SETUP saved slug"); assert.equal(reread.type, "template", "SETUP saved type");
      assert.equal(reread.version, saved.version, "SETUP saved version"); assert.ok(reread.rawContent.includes('id="' + mainId + '"'), "SETUP matching literal Group ID");
      assert.ok(reread.rawContent.includes(marker), "SETUP retained independent marker");
      const flattened: any[] = [];
      const walk = (blocks: any[]) => { for (const block of blocks) { flattened.push(block); walk(block.innerBlocks || []); } };
      walk(parse(reread.rawContent));
      for (const key of cases) {
        const nodes = flattened.filter(block => block.blockName === "core/query-title" && block.attrs?.anchor === anchors[key]);
        assert.equal(nodes.length, 1, "SETUP retained exact QueryTitle anchor " + key);
        assert.deepEqual(nodes[0].attrs, attributes[key], "SETUP exact saved explicit/omitted type " + key);
        assert.ok(reread.rawContent.includes('id="' + anchors[key] + '-case"'), "SETUP literal case container " + key);
      }
      return reread;
    };
    const date = await makeTemplate("date", dateMain, dateMarker, ["omitted", "empty", "archive", "unknown"]), search = await makeTemplate("search", searchMain, searchMarker, ["search"]);
    const created = (await setup("/api/posts", "POST", { type: "post", title: token + " fixture", slug: fixtureSlug + "-post", status: "publish", commentStatus: "closed", postDate: "2001-02-03T04:05:37", content: "<p>OWNED-PLAIN-FIXTURE-" + token + "</p>" }, 201)).post;
    const post = (await setup("/api/posts/" + created.id)).post;
    assert.equal(post.id, created.id, "SETUP refetched post ID"); assert.equal(post.type, "post", "SETUP post type"); assert.equal(post.status, "publish", "SETUP published post");
    assert.equal(post.postDate, "2001-02-03T04:05:37", "SETUP saved date and seconds"); assert.ok(Number.isSafeInteger(post.version), "SETUP saved post version"); assert.equal(typeof post.permalink, "string", "SETUP actual permalink");
    assert.equal(new URL(post.permalink, base).origin, new URL(base).origin, "SETUP local actual permalink");
    await gather("date", "/?year=2001"); await gather("search", "/?" + new URLSearchParams({ s: token }));
    await preview("omitted", attributes.omitted); await preview("empty", attributes.empty); await preview("archive", attributes.archive);
    console.log("QUERY_TITLE_MISSING_GATHER_COMPLETE " + JSON.stringify({ testBaseline, groups: groups.size, previews: previews.size, dispatches, intendedDispatches: 9 }));
    const proofPath = process.env.QUERY_TITLE_MISSING_TYPE_PROOF_PATH;
    if (proofPath) {
      assert.ok(path.isAbsolute(proofPath), "HARNESS proof path must be absolute");
      // Raw setup/auth responses are excluded; previews contain only rendered/status observations.
      await writeFile(proofPath, JSON.stringify({ testBaseline, dispatches, fixture: { postId: post.id, type: post.type, version: post.version, slug: post.slug, postDate: post.postDate, permalink: post.permalink, token, date: { id: date.id, slug: date.slug, type: date.type, version: date.version, mainId: dateMain, marker: dateMarker }, search: { id: search.id, slug: search.slug, type: search.type, version: search.version, mainId: searchMain, marker: searchMarker }, anchors }, groups: [...groups.values()], previews: [...previews.values()] }, null, 2) + "\n", { flag: "wx", mode: 0o600 });
      console.log("QUERY_TITLE_MISSING_SAFE_PROOF " + JSON.stringify({ path: proofPath }));
    }
    // All nine actual responses are consumed before the five aggregate policy children.
    for (const key of ["omitted", "empty"] as const) await t.test(key + " type emits no element or wrapper on the actual date archive", () => {
      const group = groups.get("date"), checks = commonChecks("date", date, dateMain, dateMarker, post.id);
      checks.push(["all nine observations consumed", () => assert.equal(dispatches, 9)], ["date archive type", () => assert.equal(group?.model.data?.route?.archive?.type, "date")], ["date archive year", () => assert.equal(group?.model.data?.route?.archive?.year, 2001)]);
      for (const [surface, read] of [["native", () => nativeMain(group, dateMain)], ["model HTML", () => presentationMain(group, dateMain)]] as const)
        checks.push([surface + " " + key + " anchor absent", () => assert.equal(read().querySelectorAll("#" + anchors[key]).length, 0)],
          [surface + " " + key + " wrapper absent", () => assert.equal(required(read(), "#" + anchors[key] + "-case").querySelectorAll(".wp-block-query-title").length, 0)]);
      verify(checks);
    });
    await t.test("explicit archive and unknown nonempty types retain actual date wrappers and labels", () => {
      const group = groups.get("date"), checks = commonChecks("date", date, dateMain, dateMarker, post.id);
      for (const key of ["archive", "unknown"] as const) for (const [surface, read] of [["native", () => nativeMain(group, dateMain)], ["model HTML", () => presentationMain(group, dateMain)]] as const)
        checks.push([surface + " " + key + " element count", () => assert.equal(read().querySelectorAll("#" + anchors[key]).length, 1)],
          [surface + " " + key + " wrapper count", () => assert.equal(required(read(), "#" + anchors[key] + "-case").querySelectorAll(".wp-block-query-title").length, 1)],
          [surface + " " + key + " class", () => assert.ok(required(read(), "#" + anchors[key]).classList.contains("wp-block-query-title"))],
          [surface + " " + key + " current date label", () => assert.equal(required(read(), "#" + anchors[key]).textContent.trim(), "Year: 2001")]);
      verify(checks);
    });
    await t.test("valid explicit search emits its exact quoted label", () => {
      const group = groups.get("search"), checks = commonChecks("search", search, searchMain, searchMarker, post.id);
      checks.push(["actual normalized search token", () => assert.equal(group?.model.data?.route?.query?.search, token)]);
      for (const [surface, read] of [["native", () => nativeMain(group, searchMain)], ["model HTML", () => presentationMain(group, searchMain)]] as const)
        checks.push([surface + " search element count", () => assert.equal(read().querySelectorAll("#" + anchors.search).length, 1)],
          [surface + " search wrapper count", () => assert.equal(required(read(), "#" + anchors.search + "-case").querySelectorAll(".wp-block-query-title").length, 1)],
          [surface + " search class", () => assert.ok(required(read(), "#" + anchors.search).classList.contains("wp-block-query-title"))],
          [surface + " quoted search label", () => assert.equal(required(read(), "#" + anchors.search).textContent.trim(), "Search results for: “" + token + "”")]);
      verify(checks);
    });
    await t.test("authenticated metadata-normalized previews suppress only omitted and empty types", () => {
      const checks: Check[] = [["three preview reads", () => assert.equal(previews.size, 3)]];
      for (const key of ["omitted", "empty", "archive"] as const) {
        const response = previews.get(key);
        checks.push([key + " preview rendered string", () => assert.equal(typeof response?.rendered, "string")], [key + " preview HTTP", () => assert.equal(response?.status, 200)]);
        if (key !== "archive") checks.push([key + " exact empty rendered output", () => assert.equal(response?.rendered, "")]);
        else {
          const read = () => parseHTML("<!doctype html><html><body>" + response?.rendered + "</body></html>").document;
          checks.push(["archive preview title count", () => assert.equal(read().querySelectorAll("#" + anchors.archive).length, 1)],
            ["archive preview wrapper count", () => assert.equal(read().querySelectorAll(".wp-block-query-title").length, 1)],
            ["archive preview class", () => assert.ok(required(read(), "#" + anchors.archive).classList.contains("wp-block-query-title"))],
            ["archive preview current year label", () => assert.equal(required(read(), "#" + anchors.archive).textContent.trim(), "Year: 2001")]);
        }
      }
      verify(checks);
    });
    // Other malformed/falsy types, defaults, source search formatting, loops and existing contradictory fixtures remain out of scope.
  } finally { await cleanup(); }
});
