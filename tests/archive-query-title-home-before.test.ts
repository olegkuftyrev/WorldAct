import test, { after } from "./isolated-test.js";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { parseHTML } from "linkedom";

const base = process.env.TEST_API_URL!, origin = process.env.APP_ORIGIN!;
const testBaseline = "eba54f98188fe6752ad37380bd6e4cb7b18b82bc";
type Reply = { status: number; text: string; data: any; error?: string };
type Group = { label: string; path: string; get: Reply; head: Reply; model: Reply };
type Check = [string, () => void];
const groups = new Map<string, Group>(), postIds: number[] = [], documentIds: number[] = [], documentRestores: any[] = [];
const cleanupFailures: string[] = [];
let cookie = "", settingsRestore: Record<string, unknown> | undefined, cleaned = false;
const sha = (text: string) => createHash("sha256").update(text).digest("hex");

async function api(endpoint: string, method = "GET", body?: unknown): Promise<Reply> {
  try {
    const response = await fetch(base + endpoint, { method, redirect: "manual", signal: AbortSignal.timeout(15000),
      headers: { Origin: origin, "Content-Type": "application/json", ...(cookie ? { Cookie: cookie } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const text = await response.text();
    let data: any = null; try { data = JSON.parse(text); } catch { /* Setup validation reports malformed responses. */ }
    if (endpoint === "/api/auth/login" && response.ok) cookie = response.headers.get("set-cookie")?.split(";")[0] || "";
    return { status: response.status, text, data };
  } catch (error) { return { status: 0, text: "", data: null, error: String(error) }; }
}
async function setup(endpoint: string, method = "GET", body?: unknown, status = 200) {
  const reply = await api(endpoint, method, body);
  if (method === "POST" && endpoint === "/api/posts" && Number.isSafeInteger(reply.data?.post?.id)) postIds.push(reply.data.post.id);
  if (method === "POST" && endpoint === "/api/site-editor/documents" && Number.isSafeInteger(reply.data?.document?.id)) documentIds.push(reply.data.document.id);
  assert.equal(reply.error, undefined, "SETUP transport: " + endpoint);
  assert.equal(reply.status, status, "SETUP HTTP: " + endpoint);
  assert.notEqual(reply.data, null, "SETUP JSON: " + endpoint);
  return reply.data;
}
async function acquire(endpoint: string, method: "GET" | "HEAD", json = false): Promise<Reply> {
  try {
    // Actual public observations are anonymous; do not send the setup cookie.
    const response = await fetch(base + endpoint, { method, redirect: "manual", signal: AbortSignal.timeout(15000),
      headers: { Accept: json ? "application/json" : "text/html" } });
    const text = await response.text();
    let data: any = null, error: string | undefined;
    if (json) try { data = JSON.parse(text); } catch { error = "Public response was not JSON"; }
    return { status: response.status, text, data, ...(error ? { error } : {}) };
  } catch (error) { return { status: 0, text: "", data: null, error: String(error) }; }
}
async function gather(label: string, visiblePath: string) {
  const [get, head, model] = await Promise.all([acquire(visiblePath, "GET"), acquire(visiblePath, "HEAD"),
    acquire("/api/public/document?" + new URLSearchParams({ path: visiblePath }), "GET", true)]);
  groups.set(label, { label, path: visiblePath, get, head, model });
  const describe = (reply: Reply) => ({ status: reply.status, bytes: Buffer.byteLength(reply.text), sha256: sha(reply.text), error: reply.error });
  console.log("ARCHIVE_TITLE_HOME_DISPATCH " + JSON.stringify({ label, path: visiblePath, get: describe(get), head: describe(head),
    model: { ...describe(model), kind: model.data?.route?.kind, documentId: model.data?.presentation?.document?.id, documentSlug: model.data?.presentation?.document?.slug } }));
}
function required(root: any, selector: string) {
  const element = root?.querySelector(selector); assert.ok(element, "Actual markup missing " + selector); return element;
}
function nativeMain(group: Group | undefined, mainId: string) {
  assert.equal(typeof group?.get.text, "string", "Actual native HTML");
  const document = parseHTML(group!.get.text).document;
  // The bootstrap JSON is never interpreted as rendered presentation markup.
  return required(required(document, '.wp-site-blocks[data-worldact-public-island="true"]'), "#" + mainId);
}
function presentationMain(group: Group | undefined, mainId: string) {
  const html = group?.model.data?.presentation?.html; assert.equal(typeof html, "string", "Actual presentation HTML");
  return required(parseHTML("<!doctype html><html><body>" + html + "</body></html>").document, "#" + mainId);
}
function verify(checks: Check[]) {
  const failures: string[] = [];
  for (const [label, check] of checks) try { check(); } catch (error) { failures.push(label + ": " + (error instanceof Error ? error.message : String(error))); }
  assert.equal(failures.length, 0, failures.join("\n"));
}
function commonChecks(label: string, savedDocument: any, marker: string, mainId: string, kind: "home" | "archive"): Check[] {
  const group = groups.get(label), model = group?.model.data;
  const checks: Check[] = [[label + " gathered", () => assert.ok(group)],
    ...(["get", "head", "model"] as const).flatMap(surface => [
      [label + " " + surface + " transport/parse", () => assert.equal(group?.[surface].error, undefined)],
      [label + " " + surface + " status", () => assert.equal(group?.[surface].status, 200)],
    ] as Check[]),
    [label + " HEAD body empty", () => assert.equal(group?.head.text, "")],
    [label + " model status", () => assert.equal(model?.status, 200)],
    [label + " resolved route kind", () => assert.equal(model?.route?.kind, kind)],
    [label + " Source presentation", () => assert.equal(model?.presentation?.kind, "source")],
    [label + " saved template ID", () => assert.equal(model?.presentation?.document?.id, savedDocument.id)],
    [label + " saved template slug", () => assert.equal(model?.presentation?.document?.slug, savedDocument.slug)],
    [label + " saved template type", () => assert.equal(model?.presentation?.document?.type, "template")]];
  for (const [surface, read] of [["native", () => nativeMain(group, mainId)], ["model HTML", () => presentationMain(group, mainId)]] as const)
    checks.push([label + " " + surface + " independent current marker", () => assert.equal(Array.from(read().querySelectorAll("p")).filter((node: any) => node.textContent.trim() === marker).length, 1)]);
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
    if (!current) cleanupFailures.push("Could not acquire template version for restoration: " + saved.id);
    else await attempt("/api/site-editor/documents/" + saved.id, "PUT", { type: saved.type, slug: saved.slug, title: saved.title,
      content: saved.rawContent ?? saved.content, blocks: saved.blocks, version: current.version });
  }
  if (settingsRestore) await attempt("/api/settings", "PUT", settingsRestore);
  if (cookie) await attempt("/api/auth/logout", "POST");
  console.log("ARCHIVE_TITLE_HOME_FIXTURE_CLEANUP " + JSON.stringify({ postIds, documentIds, restoredDocumentIds: documentRestores.map(entry => entry.id), settingsRestoreAttempted: Boolean(settingsRestore), failures: cleanupFailures }));
}
after(async () => { await cleanup(); assert.equal(cleanupFailures.length, 0, "Owned API cleanup: " + cleanupFailures.join("; ")); });

test("explicit archive QueryTitle is absent on ordinary posts home and retained on a real date archive", async t => {
  const stamp = "archive-home-" + Date.now().toString(36), homeMain = stamp + "-home-main", dateMain = stamp + "-date-main";
  const homeTitle = stamp + "-home-title", dateTitle = stamp + "-date-title", homeMarker = "HOME-MARKER-" + stamp, dateMarker = "DATE-MARKER-" + stamp;
  try {
    await setup("/api/auth/login", "POST", { login: process.env.ADMIN_EMAIL, password: process.env.ADMIN_PASSWORD });
    assert.ok(cookie, "SETUP administrator session");
    const original = (await setup("/api/settings")).settings;
    settingsRestore = Object.fromEntries(["theme", "timezone", "frontPageMode", "permalinkStructure"].map(key => [key, original[key]]));
    await setup("/api/settings", "PUT", { theme: "twentytwentyfive", timezone: "UTC", frontPageMode: "posts", permalinkStructure: "/%postname%/" });
    const makeTemplate = async (slug: "home" | "date", mainId: string, titleId: string, marker: string) => {
      const content = '<!-- wp:group ' + JSON.stringify({ tagName: "main", anchor: mainId }) + ' --><main id="' + mainId + '" class="wp-block-group"><p>' + marker + '</p>'
        + '<!-- wp:query-title ' + JSON.stringify({ type: "archive", anchor: titleId }) + ' /--></main><!-- /wp:group -->';
      const existing = (await setup("/api/site-editor")).templates.find((entry: any) => entry.slug === slug);
      let saved: any;
      if (existing) {
        documentRestores.push(existing);
        saved = (await setup("/api/site-editor/documents/" + existing.id, "PUT", { type: "template", slug, title: existing.title, content, version: existing.version })).document;
      } else saved = (await setup("/api/site-editor/documents", "POST", { type: "template", slug, title: stamp + " " + slug, content }, 201)).document;
      assert.ok(Number.isSafeInteger(saved.id), "SETUP actual saved template ID");
      assert.equal(saved.slug, slug, "SETUP actual saved template slug"); assert.equal(saved.type, "template", "SETUP actual saved template type");
      assert.ok(saved.rawContent.includes('id="' + mainId + '"'), "SETUP matching literal saved Group ID");
      assert.ok(saved.rawContent.includes(titleId), "SETUP retained explicit QueryTitle anchor");
      assert.match(saved.rawContent, /wp:query-title\s+\{[^}]*"type"\s*:\s*"archive"/, "SETUP retained archive type");
      return saved;
    };
    const home = await makeTemplate("home", homeMain, homeTitle, homeMarker), date = await makeTemplate("date", dateMain, dateTitle, dateMarker);
    const created = (await setup("/api/posts", "POST", { type: "post", title: stamp + " dated post", slug: stamp + "-post", status: "publish",
      commentStatus: "closed", postDate: "2001-02-03T04:05:37", content: "<p>OWNED-DATE-FIXTURE-" + stamp + "</p>" }, 201)).post;
    const post = (await setup("/api/posts/" + created.id)).post;
    assert.equal(post.id, created.id, "SETUP refetched post ID"); assert.equal(post.type, "post", "SETUP saved post type");
    assert.equal(post.status, "publish", "SETUP saved publication"); assert.equal(post.postDate, "2001-02-03T04:05:37", "SETUP matching civil year and seconds");
    assert.equal(typeof post.permalink, "string", "SETUP actual saved permalink");
    const permalink = new URL(post.permalink, base); assert.equal(permalink.origin, new URL(base).origin, "SETUP actual permalink origin");
    await gather("home", "/"); await gather("date", "/?year=2001");
    const dispatches = groups.size * 3;
    console.log("ARCHIVE_TITLE_HOME_GATHER_COMPLETE " + JSON.stringify({ testBaseline, groups: groups.size, dispatches, intendedDispatches: 6 }));
    const proofPath = process.env.ARCHIVE_TITLE_HOME_PROOF_PATH;
    if (proofPath) {
      assert.ok(path.isAbsolute(proofPath), "HARNESS proof path must be absolute");
      // Persist only anonymous public observations and public fixture metadata.
      await writeFile(proofPath, JSON.stringify({ testBaseline, dispatches, fixture: { id: post.id, slug: post.slug, postDate: post.postDate, permalink: post.permalink }, groups: [...groups.values()] }, null, 2) + "\n", { flag: "wx", mode: 0o600 });
      console.log("ARCHIVE_TITLE_HOME_PUBLIC_PROOF " + JSON.stringify({ path: proofPath }));
    }
    // Both complete GET/HEAD/model groups are consumed before aggregate policy assertions.
    await t.test("ordinary unfiltered posts home has no explicit archive QueryTitle element or wrapper", () => {
      const homeGroup = groups.get("home"), checks = commonChecks("home", home, homeMarker, homeMain, "home");
      checks.push(["all six intended reads consumed", () => assert.equal(dispatches, 6)]);
      for (const [surface, read] of [["native", () => nativeMain(homeGroup, homeMain)], ["model HTML", () => presentationMain(homeGroup, homeMain)]] as const)
        checks.push([surface + " home archive anchor absent", () => assert.equal(read().querySelectorAll("#" + homeTitle).length, 0)],
          [surface + " home archive wrapper absent", () => assert.equal(read().querySelectorAll(".wp-block-query-title").length, 0)]);
      verify(checks);
    });
    await t.test("actual populated date archive retains its explicit archive QueryTitle", () => {
      const dateGroup = groups.get("date"), model = dateGroup?.model.data, checks = commonChecks("date", date, dateMarker, dateMain, "archive");
      checks.push(["date archive identity", () => assert.equal(model?.route?.archive?.type, "date")],
        ["date archive year", () => assert.equal(model?.route?.archive?.year, 2001)],
        ["owned post populates actual date archive", () => assert.ok(model?.site?.posts?.some((entry: any) => entry.id === post.id))]);
      for (const [surface, read] of [["native", () => nativeMain(dateGroup, dateMain)], ["model HTML", () => presentationMain(dateGroup, dateMain)]] as const)
        checks.push([surface + " date archive title element", () => assert.equal(read().querySelectorAll("#" + dateTitle).length, 1)],
          [surface + " date archive title text", () => assert.equal(required(read(), "#" + dateTitle).textContent.trim(), "Year: 2001")],
          [surface + " date archive wrapper", () => assert.ok(required(read(), "#" + dateTitle).classList.contains("wp-block-query-title"))]);
      verify(checks);
    });
    // No raw global flags, canonical/body selection, other QueryTitle types, or extra matrix claim.
  } finally { await cleanup(); }
});
