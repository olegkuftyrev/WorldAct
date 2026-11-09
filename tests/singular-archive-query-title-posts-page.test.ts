import test, { after } from "./isolated-test.js";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { parseHTML } from "linkedom";

const base = process.env.TEST_API_URL!, origin = process.env.APP_ORIGIN!;
type Reply = { status: number; text: string; data: any; error?: string };
type Pair = { label: string; endpoint: string; get: Reply; head: Reply };
type Page = { id: number; slug: string; visiblePath: string; bodyId: string; titleId: string; marker: string };
type Check = [string, () => void];
const pairs = new Map<string, Pair>(), ownedIds: number[] = [], cleanupFailures: string[] = [];
let cookie = "", settingsRestore: Record<string, unknown> | undefined, cleaned = false;
const sha = (value: string) => createHash("sha256").update(value).digest("hex");

async function admin(endpoint: string, method = "GET", body?: unknown): Promise<Reply> {
  try {
    const response = await fetch(base + endpoint, { method, redirect: "manual", signal: AbortSignal.timeout(15000),
      headers: { Origin: origin, "Content-Type": "application/json", ...(cookie ? { Cookie: cookie } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const text = await response.text(); let data: any = null;
    try { data = JSON.parse(text); } catch { /* Setup reports malformed replies. */ }
    if (endpoint === "/api/auth/login" && response.ok) cookie = response.headers.get("set-cookie")?.split(";")[0] || "";
    return { status: response.status, text, data };
  } catch (error) { return { status: 0, text: "", data: null, error: String(error) }; }
}
async function setup(endpoint: string, method = "GET", body?: unknown, status = 200) {
  const reply = await admin(endpoint, method, body);
  if (method === "POST" && endpoint === "/api/posts" && Number.isSafeInteger(reply.data?.post?.id)) ownedIds.push(reply.data.post.id);
  assert.equal(reply.error, undefined, "SETUP transport " + endpoint);
  assert.equal(reply.status, status, "SETUP HTTP " + endpoint);
  assert.notEqual(reply.data, null, "SETUP JSON " + endpoint);
  return reply.data;
}
async function acquire(endpoint: string, method: "GET" | "HEAD", json = false): Promise<Reply> {
  try {
    // Anonymous acquisition never inherits the administrator setup cookie.
    const response = await fetch(base + endpoint, { method, redirect: "manual", signal: AbortSignal.timeout(15000),
      headers: { Accept: json ? "application/json" : "text/html" } });
    const text = await response.text(); let data: any = null, error: string | undefined;
    if (json) try { data = JSON.parse(text); } catch { error = "Public response was not JSON"; }
    return { status: response.status, text, data, ...(error ? { error } : {}) };
  } catch (error) { return { status: 0, text: "", data: null, error: String(error) }; }
}
function receipt(reply: Reply) { return { status: reply.status, bytes: Buffer.byteLength(reply.text), sha256: sha(reply.text), error: reply.error }; }
async function gatherPair(label: string, endpoint: string) {
  const [get, head] = await Promise.all([acquire(endpoint, "GET", true), acquire(endpoint, "HEAD")]);
  pairs.set(label, { label, endpoint, get, head });
  console.log("QUERY_TITLE_POSTS_PAGE_PAIR " + JSON.stringify({ label, endpoint, get: { ...receipt(get), postId: get.data?.post?.id }, head: receipt(head) }));
}
function dom(html: unknown) {
  assert.equal(typeof html, "string", "Actual content must be a string");
  return parseHTML("<!doctype html><html><body>" + html + "</body></html>").document;
}
function required(root: any, selector: string) { const node = root?.querySelector(selector); assert.ok(node, "Actual markup missing " + selector); return node; }
function verify(checks: Check[]) {
  const failures: string[] = [];
  for (const [label, check] of checks) try { check(); } catch (error) { failures.push(label + ": " + (error instanceof Error ? error.message : String(error))); }
  assert.equal(failures.length, 0, failures.join("\n"));
}
function pairChecks(label: string): Check[] {
  const pair = pairs.get(label);
  return [[label + " gathered", () => assert.ok(pair)],
    ...(["get", "head"] as const).flatMap(surface => [
      [label + " " + surface + " transport/parse", () => assert.equal(pair?.[surface].error, undefined)],
      [label + " " + surface + " HTTP200", () => assert.equal(pair?.[surface].status, 200)],
    ] as Check[]), [label + " HEAD empty", () => assert.equal(pair?.head.text, "")]];
}
function bodyChecks(label: string, post: () => any, page: Page, other: Page, retained: boolean): Check[] {
  const read = () => required(dom(post()?.content), "#" + page.bodyId);
  return [[label + " exact page ID", () => assert.equal(post()?.id, page.id)],
    [label + " actual page type", () => assert.equal(post()?.type, "page")],
    [label + " public unlocked body", () => assert.equal(post()?.locked, false)],
    [label + " independent body marker", () => assert.ok(read().textContent.includes(page.marker))],
    [label + " excludes other body marker", () => assert.equal(read().textContent.includes(other.marker), false)],
    [label + " archive anchor count", () => assert.equal(read().querySelectorAll("#" + page.titleId).length, retained ? 1 : 0)],
    [label + " archive wrapper count", () => assert.equal(read().querySelectorAll(".wp-block-query-title").length, retained ? 1 : 0)],
    ...(retained ? [[label + " existing empty-query Blog title", () => {
      const title = required(read(), "#" + page.titleId);
      assert.ok(title.classList.contains("wp-block-query-title")); assert.equal(title.textContent.trim(), "Blog");
    }] as Check] : [])];
}
async function cleanup() {
  if (cleaned) return; cleaned = true;
  const attempt = async (endpoint: string, method: string, body?: unknown) => {
    const reply = await admin(endpoint, method, body);
    if (reply.error || reply.status < 200 || reply.status >= 300) cleanupFailures.push(method + " " + endpoint + ": " + reply.status + (reply.error ? " " + reply.error : ""));
  };
  if (settingsRestore) await attempt("/api/settings", "PUT", settingsRestore);
  for (const id of ownedIds) { await attempt("/api/posts/" + id, "PUT", { status: "trash" }); await attempt("/api/posts/" + id, "DELETE"); }
  if (cookie) await attempt("/api/auth/logout", "POST");
  console.log("QUERY_TITLE_POSTS_PAGE_CLEANUP " + JSON.stringify({ ownedIds, settingsRestoreAttempted: Boolean(settingsRestore), failures: cleanupFailures }));
}
after(async () => { await cleanup(); assert.equal(cleanupFailures.length, 0, "Owned API cleanup: " + cleanupFailures.join("; ")); });

test("configured posts-page path provenance differs from an ordinary selected page and its standalone body", async t => {
  const stamp = "query-title-posts-page-" + Date.now().toString(36);
  try {
    await setup("/api/auth/login", "POST", { login: process.env.ADMIN_EMAIL, password: process.env.ADMIN_PASSWORD });
    assert.ok(cookie, "SETUP administrator cookie");
    const settings = (await setup("/api/settings")).settings;
    settingsRestore = Object.fromEntries(["theme", "timezone", "frontPageMode", "frontPageId", "postsPageId", "permalinkStructure"].map(key => [key, settings[key]]));
    await setup("/api/settings", "PUT", { theme: "twentytwentyfive", timezone: "UTC", frontPageMode: "posts", frontPageId: null, postsPageId: null, permalinkStructure: "/%postname%/" });
    const make = async (suffix: string): Promise<Page> => {
      const bodyId = stamp + "-" + suffix + "-body", titleId = stamp + "-" + suffix + "-archive", marker = "INDEPENDENT-BODY-" + suffix + "-" + stamp;
      const content = '<!-- wp:group ' + JSON.stringify({ tagName: "section", anchor: bodyId }) + ' --><section id="' + bodyId + '" class="wp-block-group"><p>' + marker
        + '</p><!-- wp:query-title ' + JSON.stringify({ type: "archive", anchor: titleId }) + ' /--></section><!-- /wp:group -->';
      const created = (await setup("/api/posts", "POST", { type: "page", title: stamp + " " + suffix, slug: stamp + "-" + suffix,
        status: "publish", commentStatus: "closed", postDate: "2001-02-03T04:05:37", content }, 201)).post;
      return { id: created.id, slug: created.slug, visiblePath: "", bodyId, titleId, marker };
    };
    const p = await make("configured"), q = await make("ordinary");
    await setup("/api/settings", "PUT", { frontPageMode: "page", frontPageId: null, postsPageId: p.id });
    const configured = (await setup("/api/settings")).settings;
    assert.equal(configured.frontPageMode, "page", "SETUP actual reading mode");
    assert.equal(configured.frontPageId, null, "SETUP no selected front page");
    assert.equal(configured.postsPageId, p.id, "SETUP actual posts-page identity");
    for (const page of [p, q]) {
      const saved = (await setup("/api/posts/" + page.id)).post;
      assert.equal(saved.id, page.id, "SETUP saved page ID"); assert.equal(saved.type, "page", "SETUP saved page type");
      assert.equal(saved.status, "publish", "SETUP saved publication");
      assert.equal(typeof saved.slug, "string", "SETUP saved slug"); page.slug = saved.slug;
      assert.ok(saved.rawContent.includes(page.marker) && saved.rawContent.includes(page.titleId), "SETUP retained owned marker and title anchor");
      assert.match(saved.rawContent, /wp:query-title\s+\{[^}]*"type"\s*:\s*"archive"/, "SETUP explicit saved archive type");
      assert.equal(typeof saved.permalink, "string", "SETUP actual permalink");
      const url = new URL(saved.permalink, base);
      assert.equal(url.origin, new URL(base).origin, "SETUP actual site permalink origin");
      page.visiblePath = url.pathname + url.search;
    }
    const design = await setup("/api/site-editor"), listing = design.templates.find((item: any) => item.slug === "home") || design.templates.find((item: any) => item.slug === "index");
    assert.ok(listing, "SETUP existing home/index listing template");
    // Plain ID200 aliases are existing WorldAct acquisition surfaces, not a claim about WordPress redirects.
    for (const [label, visible] of [["configured-pretty", p.visiblePath], ["configured-plain", "/?page_id=" + p.id],
      ["ordinary-pretty", q.visiblePath], ["ordinary-plain", "/?page_id=" + q.id]] as const)
      await gatherPair(label, "/api/public/resolve?" + new URLSearchParams({ path: visible }));
    await gatherPair("configured-standalone", "/api/public/posts/" + encodeURIComponent(p.slug));
    const visible = "/?page_id=" + p.id;
    const [nativeGet, nativeHead, model] = await Promise.all([acquire(visible, "GET"), acquire(visible, "HEAD"),
      acquire("/api/public/document?" + new URLSearchParams({ path: visible }), "GET", true)]);
    console.log("QUERY_TITLE_POSTS_PAGE_DOCUMENT " + JSON.stringify({ path: visible, get: receipt(nativeGet), head: receipt(nativeHead),
      model: { ...receipt(model), kind: model.data?.route?.kind, selectedId: model.data?.route?.selectedId, postId: model.data?.post?.id,
        documentId: model.data?.presentation?.document?.id, documentSlug: model.data?.presentation?.document?.slug } }));
    const dispatches = pairs.size * 2 + 3;
    console.log("QUERY_TITLE_POSTS_PAGE_GATHER_COMPLETE " + JSON.stringify({ pairs: pairs.size, documentGroups: 1, dispatches, intendedDispatches: 13 }));
    const proofPath = process.env.QUERY_TITLE_POSTS_PAGE_PROOF_PATH;
    if (proofPath) {
      assert.ok(path.isAbsolute(proofPath), "HARNESS proof path must be absolute");
      await writeFile(proofPath, JSON.stringify({ dispatches, pairs: [...pairs.values()], document: { visible, nativeGet, nativeHead, model } }, null, 2) + "\n", { flag: "wx", mode: 0o600 });
    }
    // All13 public responses above have been consumed before any aggregate policy assertions.
    await t.test("configured posts-page compat and full-document body preserve explicit archive titles", () => {
      const checks: Check[] = [["all13 responses acquired", () => assert.equal(dispatches, 13)]];
      for (const label of ["configured-pretty", "configured-plain"]) checks.push(...pairChecks(label), ...bodyChecks(label, () => pairs.get(label)?.get.data?.post, p, q, true));
      checks.push(["document GET transport", () => assert.equal(nativeGet.error, undefined)], ["document GET200", () => assert.equal(nativeGet.status, 200)],
        ["document HEAD transport", () => assert.equal(nativeHead.error, undefined)], ["document HEAD200", () => assert.equal(nativeHead.status, 200)],
        ["document HEAD empty", () => assert.equal(nativeHead.text, "")], ["model transport/parse", () => assert.equal(model.error, undefined)],
        ["model HTTP200", () => assert.equal(model.status, 200)], ["model status200", () => assert.equal(model.data?.status, 200)],
        ["model posts-page route", () => assert.equal(model.data?.route?.kind, "posts-page")],
        ["model exact selected ID", () => assert.equal(model.data?.route?.selectedId, p.id)],
        ["model selected page type", () => assert.equal(model.data?.route?.selectedType, "page")],
        ...bodyChecks("model selected page", () => model.data?.post, p, q, true),
        ["model Source listing", () => assert.equal(model.data?.presentation?.kind, "source")],
        ["model actual chosen listing ID", () => assert.equal(model.data?.presentation?.document?.id, listing.id)],
        ["model actual chosen listing slug", () => assert.equal(model.data?.presentation?.document?.slug, listing.slug)],
        ["model successful listing markup", () => assert.ok(required(dom(model.data?.presentation?.html), ".wp-block-query"))],
        ["native successful listing island", () => {
          const island = required(parseHTML(nativeGet.text).document, '.wp-site-blocks[data-worldact-public-island="true"]');
          required(island, ".wp-block-query");
        }]);
      // A listing template need not render the configured page's body in its presentation.
      verify(checks);
    });
    await t.test("ordinary selected page compat suppresses archive titles for both path spellings", () => {
      const checks: Check[] = [];
      for (const label of ["ordinary-pretty", "ordinary-plain"]) checks.push(...pairChecks(label), ...bodyChecks(label, () => pairs.get(label)?.get.data?.post, q, p, false));
      verify(checks);
    });
    await t.test("standalone selected body of the configured posts-page remains singular", () => verify([
      ...pairChecks("configured-standalone"), ...bodyChecks("configured-standalone", () => pairs.get("configured-standalone")?.get.data?.post, p, q, false)]));
  } finally { await cleanup(); }
});
