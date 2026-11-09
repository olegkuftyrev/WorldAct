import test, { after } from "./isolated-test.js";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { parseHTML } from "linkedom";

const base = process.env.TEST_API_URL!, origin = process.env.APP_ORIGIN!;
const testBaseline = "0f7dd2f3d55a72a3b2b498a152a10332ef066c68";
type Reply = { status: number; text: string; data: any; error?: string };
type Pair = { label: string; path: string; get: Reply; head: Reply };
type Check = [string, () => void];
const pairs = new Map<string, Pair>(), documentIds: number[] = [], cleanupFailures: string[] = [];
let cookie = "", restore: Record<string, unknown> | undefined, cleaned = false;
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
  if (endpoint === "/api/site-editor/documents" && method === "POST" && Number.isSafeInteger(reply.data?.document?.id)) documentIds.push(reply.data.document.id);
  assert.equal(reply.error, undefined, "SETUP transport: " + endpoint); assert.equal(reply.status, status, "SETUP HTTP: " + endpoint);
  assert.notEqual(reply.data, null, "SETUP JSON: " + endpoint); return reply.data;
}
async function acquire(endpoint: string, method: "GET" | "HEAD"): Promise<Reply> {
  try {
    // These actual public template reads are anonymous, with no setup cookie.
    const response = await fetch(base + endpoint, { method, redirect: "manual", signal: AbortSignal.timeout(15000), headers: { Accept: "application/json" } });
    const text = await response.text(); let data: any = null, error: string | undefined;
    if (method === "GET") try { data = JSON.parse(text); } catch { error = "Public template response was not JSON"; }
    return { status: response.status, text, data, ...(error ? { error } : {}) };
  } catch (error) { return { status: 0, text: "", data: null, error: String(error) }; }
}
async function gather(label: string, endpoint: string) {
  const [get, head] = await Promise.all([acquire(endpoint, "GET"), acquire(endpoint, "HEAD")]);
  pairs.set(label, { label, path: endpoint, get, head });
  const describe = (reply: Reply) => ({ status: reply.status, bytes: Buffer.byteLength(reply.text), sha256: sha(reply.text), error: reply.error });
  console.log("ARCHIVE_TITLE_DIRECT_DISPATCH " + JSON.stringify({ label, path: endpoint, get: describe(get), head: describe(head), document: get.data?.document }));
}
function required(root: any, selector: string) {
  const node = root?.querySelector(selector); assert.ok(node, "Actual markup missing " + selector); return node;
}
function main(pair: Pair | undefined, mainId: string) {
  const content = pair?.get.data?.content; assert.equal(typeof content, "string", "Actual direct-template content fragment");
  return required(parseHTML("<!doctype html><html><body>" + content + "</body></html>").document, "#" + mainId);
}
function verify(checks: Check[]) {
  const failures: string[] = [];
  for (const [label, check] of checks) try { check(); } catch (error) { failures.push(label + ": " + (error instanceof Error ? error.message : String(error))); }
  assert.equal(failures.length, 0, failures.join("\n"));
}
function commonChecks(label: string, saved: any, mainId: string, marker: string): Check[] {
  const pair = pairs.get(label);
  return [[label + " gathered", () => assert.ok(pair)],
    ...(["get", "head"] as const).flatMap(surface => [
      [label + " " + surface + " transport/parse", () => assert.equal(pair?.[surface].error, undefined)],
      [label + " " + surface + " HTTP", () => assert.equal(pair?.[surface].status, 200)],
    ] as Check[]), [label + " HEAD body empty", () => assert.equal(pair?.head.text, "")],
    [label + " saved document ID", () => assert.equal(pair?.get.data?.document?.id, saved.id)],
    [label + " saved document slug", () => assert.equal(pair?.get.data?.document?.slug, saved.slug)],
    [label + " saved document type", () => assert.equal(pair?.get.data?.document?.type, "template")],
    [label + " independent current marker", () => assert.equal(Array.from(main(pair, mainId).querySelectorAll("p")).filter((node: any) => node.textContent.trim() === marker).length, 1)]];
}
async function cleanup() {
  if (cleaned) return; cleaned = true;
  const attempt = async (endpoint: string, method: string, body?: unknown) => {
    const reply = await api(endpoint, method, body);
    if (reply.error || reply.status < 200 || reply.status >= 300) cleanupFailures.push(method + " " + endpoint + ": " + reply.status + (reply.error ? " " + reply.error : ""));
  };
  for (const id of documentIds) await attempt("/api/site-editor/documents/" + id, "DELETE");
  if (restore) await attempt("/api/settings", "PUT", restore);
  if (cookie) await attempt("/api/auth/logout", "POST");
  console.log("ARCHIVE_TITLE_DIRECT_FIXTURE_CLEANUP " + JSON.stringify({ documentIds, settingsRestoreAttempted: Boolean(restore), failures: cleanupFailures }));
}
after(async () => { await cleanup(); assert.equal(cleanupFailures.length, 0, "Owned API cleanup: " + cleanupFailures.join("; ")); });

test("direct-template archive title home eligibility preserves original path-only and transport-only date labels", async t => {
  const stamp = Date.now().toString(36), slug = "qt-direct-" + stamp, mainId = slug + "-main", titleId = slug + "-title", marker = "DIRECT-MARKER-" + stamp;
  try {
    await setup("/api/auth/login", "POST", { login: process.env.ADMIN_EMAIL, password: process.env.ADMIN_PASSWORD }); assert.ok(cookie, "SETUP administrator session");
    const settings = (await setup("/api/settings")).settings;
    restore = Object.fromEntries(["theme", "timezone", "frontPageMode"].map(key => [key, settings[key]]));
    await setup("/api/settings", "PUT", { theme: "twentytwentyfive", timezone: "UTC", frontPageMode: "posts" });
    const content = '<!-- wp:group ' + JSON.stringify({ tagName: "main", anchor: mainId }) + ' --><main id="' + mainId + '" class="wp-block-group"><p>' + marker + '</p>'
      + '<!-- wp:query-title ' + JSON.stringify({ type: "archive", anchor: titleId }) + ' /--></main><!-- /wp:group -->';
    const saved = (await setup("/api/site-editor/documents", "POST", { type: "template", slug, title: "Owned direct title " + stamp, content }, 201)).document;
    assert.ok(Number.isSafeInteger(saved.id), "SETUP actual saved ID"); assert.equal(saved.slug, slug, "SETUP saved unique slug"); assert.equal(saved.type, "template", "SETUP saved type");
    assert.notEqual(slug, "home", "SETUP no home-slug inference"); assert.notEqual(slug, "date", "SETUP no date-slug inference");
    assert.ok(saved.rawContent.includes('id="' + mainId + '"'), "SETUP matching literal saved Group ID");
    assert.ok(saved.rawContent.includes(titleId), "SETUP retained title anchor");
    assert.match(saved.rawContent, /wp:query-title\s+\{[^}]*"type"\s*:\s*"archive"/, "SETUP retained explicit archive type");
    const endpoint = (requestPath: string, year?: string) => {
      const query = new URLSearchParams({ requestPath }); if (year !== undefined) query.set("year", year);
      return "/api/public/templates/" + encodeURIComponent(saved.slug) + "?" + query;
    };
    await gather("home", endpoint("/"));
    await gather("path-only-date", endpoint("/?year=2001"));
    await gather("transport-only-date", endpoint("/", "2001"));
    const dispatches = pairs.size * 2;
    console.log("ARCHIVE_TITLE_DIRECT_GATHER_COMPLETE " + JSON.stringify({ testBaseline, pairs: pairs.size, dispatches, intendedDispatches: 6 }));
    const proofPath = process.env.ARCHIVE_TITLE_HOME_DIRECT_PROOF_PATH;
    if (proofPath) {
      assert.ok(path.isAbsolute(proofPath), "HARNESS proof path must be absolute");
      await writeFile(proofPath, JSON.stringify({ testBaseline, dispatches, fixture: { documentId: saved.id, slug: saved.slug, type: saved.type, mainId, titleId, marker }, pairs: [...pairs.values()] }, null, 2) + "\n", { flag: "wx", mode: 0o600 });
      console.log("ARCHIVE_TITLE_DIRECT_PUBLIC_PROOF " + JSON.stringify({ path: proofPath }));
    }
    // All six actual GET/HEAD responses are consumed before aggregate policy checks.
    await t.test("unfiltered direct-template home omits its explicit archive title element and wrapper", () => {
      const pair = pairs.get("home"), checks = commonChecks("home", saved, mainId, marker);
      checks.push(["all six intended responses consumed", () => assert.equal(dispatches, 6)],
        ["home archive anchor absent", () => assert.equal(main(pair, mainId).querySelectorAll("#" + titleId).length, 0)],
        ["home archive wrapper absent", () => assert.equal(main(pair, mainId).querySelectorAll(".wp-block-query-title").length, 0)]);
      verify(checks);
    });
    for (const [label, expected] of [["path-only-date", "Blog"], ["transport-only-date", "Year: 2001"]] as const)
      await t.test(label + " preserves its original exact title wrapper and label", () => {
        const pair = pairs.get(label), checks = commonChecks(label, saved, mainId, marker);
        checks.push([label + " exact title element", () => assert.equal(main(pair, mainId).querySelectorAll("#" + titleId).length, 1)],
          [label + " exact wrapper count", () => assert.equal(main(pair, mainId).querySelectorAll(".wp-block-query-title").length, 1)],
          [label + " title class", () => assert.ok(required(main(pair, mainId), "#" + titleId).classList.contains("wp-block-query-title"))],
          [label + " preserved label", () => assert.equal(required(main(pair, mainId), "#" + titleId).textContent.trim(), expected)]);
        verify(checks);
      });
    // No posts, loops, public-model route flags, SQL filters, other types, or transport-label repair claim.
  } finally { await cleanup(); }
});
