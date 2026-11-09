import test, { after } from "./isolated-test.js";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { parseHTML } from "linkedom";

const base = process.env.TEST_API_URL!, origin = process.env.APP_ORIGIN!;
const baseline = "2a06562b60fc67a22694b1ca42c1f2fb9f050c15";
type Reply = { status: number; text: string; data: any; error?: string };
type PublicGroup = { label: string; path: string; get: Reply; head: Reply; model: Reply };
type Pair = { label: string; path: string; get: Reply; head: Reply };
type Check = [string, () => void];
type Fixture = { post: any; path: string; bodyId: string; bodyTitleId: string; bodyMarker: string };
const publicGroups = new Map<string, PublicGroup>(), directGroups = new Map<string, Pair>(), bodyGroups = new Map<string, Pair>();
const postIds: number[] = [], documentIds: number[] = [];
let cookie = "", settingsRestore: Record<string, unknown> | undefined, dateRestore: any;
let cleaned = false;
const cleanupFailures: string[] = [];
const sha = (value: string) => createHash("sha256").update(value).digest("hex");

async function api(endpoint: string, method = "GET", body?: unknown): Promise<Reply> {
  try {
    const response = await fetch(base + endpoint, { method, redirect: "manual", signal: AbortSignal.timeout(15000),
      headers: { Origin: origin, "Content-Type": "application/json", ...(cookie ? { Cookie: cookie } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const text = await response.text();
    let data: any = null; try { data = JSON.parse(text); } catch { /* Setup reports malformed responses. */ }
    if (endpoint === "/api/auth/login" && response.ok) cookie = response.headers.get("set-cookie")?.split(";")[0] || "";
    return { status: response.status, text, data };
  } catch (error) { return { status: 0, text: "", data: null, error: String(error) }; }
}
async function setup(endpoint: string, method = "GET", body?: unknown, status = 200) {
  const reply = await api(endpoint, method, body);
  // Track successful creates even if a later setup assertion fails.
  if (method === "POST" && endpoint === "/api/posts" && Number.isSafeInteger(reply.data?.post?.id)) postIds.push(reply.data.post.id);
  if (method === "POST" && endpoint === "/api/site-editor/documents" && Number.isSafeInteger(reply.data?.document?.id)) documentIds.push(reply.data.document.id);
  assert.equal(reply.error, undefined, "SETUP transport: " + endpoint);
  assert.equal(reply.status, status, "SETUP HTTP: " + endpoint);
  assert.notEqual(reply.data, null, "SETUP JSON: " + endpoint);
  return reply.data;
}
async function acquire(endpoint: string, method: "GET" | "HEAD", json = false): Promise<Reply> {
  try {
    // These observations are anonymous. Never reuse the setup administrator cookie.
    const response = await fetch(base + endpoint, { method, redirect: "manual", signal: AbortSignal.timeout(15000),
      headers: { Accept: json ? "application/json" : "text/html" } });
    const text = await response.text();
    let data: any = null, error: string | undefined;
    if (json) try { data = JSON.parse(text); } catch { error = "Public response was not JSON"; }
    return { status: response.status, text, data, ...(error ? { error } : {}) };
  } catch (error) { return { status: 0, text: "", data: null, error: String(error) }; }
}
function receipt(reply: Reply) {
  return { status: reply.status, bytes: Buffer.byteLength(reply.text), sha256: sha(reply.text), error: reply.error };
}
async function gatherPublic(label: string, visiblePath: string) {
  const [get, head, model] = await Promise.all([acquire(visiblePath, "GET"), acquire(visiblePath, "HEAD"),
    acquire("/api/public/document?" + new URLSearchParams({ path: visiblePath }), "GET", true)]);
  publicGroups.set(label, { label, path: visiblePath, get, head, model });
  console.log("ARCHIVE_TITLE_PUBLIC " + JSON.stringify({ label, path: visiblePath, get: receipt(get), head: receipt(head),
    model: { ...receipt(model), kind: model.data?.route?.kind, selectedId: model.data?.route?.selectedId,
      postId: model.data?.post?.id, documentSlug: model.data?.presentation?.document?.slug } }));
}
async function gatherPair(target: Map<string, Pair>, label: string, endpoint: string) {
  const [get, head] = await Promise.all([acquire(endpoint, "GET", true), acquire(endpoint, "HEAD")]);
  target.set(label, { label, path: endpoint, get, head });
  console.log("ARCHIVE_TITLE_PAIR " + JSON.stringify({ label, path: endpoint, get: receipt(get), head: receipt(head) }));
}
function visiblePath(value: unknown) {
  assert.equal(typeof value, "string", "SETUP actual saved permalink");
  const url = new URL(value as string, base);
  assert.equal(url.origin, new URL(base).origin, "SETUP fixture permalink origin");
  return url.pathname + url.search;
}
function withYear(value: string) {
  const url = new URL(value, base); url.searchParams.set("year", "2001");
  return url.pathname + url.search;
}
function dom(html: unknown) {
  assert.equal(typeof html, "string", "Actual markup must be a string");
  return parseHTML("<!doctype html><html><body>" + html + "</body></html>").document;
}
function required(root: any, selector: string) {
  const node = root?.querySelector(selector);
  assert.ok(node, "Actual markup missing " + selector);
  return node;
}
function nativeMain(group: PublicGroup | undefined, mainId: string) {
  assert.equal(typeof group?.get.text, "string");
  const document = parseHTML(group!.get.text).document;
  // Never interpret the inert bootstrap JSON as rendered presentation markup.
  const island = required(document, '.wp-site-blocks[data-worldact-public-island="true"]');
  return required(island, "#" + mainId);
}
function modelMain(group: PublicGroup | undefined, mainId: string) {
  return required(dom(group?.model.data?.presentation?.html), "#" + mainId);
}
function verify(checks: Check[]) {
  const failures: string[] = [];
  for (const [label, check] of checks) try { check(); } catch (error) {
    failures.push(label + ": " + (error instanceof Error ? error.message : String(error)));
  }
  assert.equal(failures.length, 0, failures.join("\n"));
}
function replyChecks(label: string, group: Pair | undefined): Check[] {
  return [[label + " gathered", () => assert.ok(group)],
    ...(["get", "head"] as const).flatMap(surface => [
      [label + " " + surface + " transport/parse", () => assert.equal(group?.[surface].error, undefined)],
      [label + " " + surface + " HTTP", () => assert.equal(group?.[surface].status, 200)],
    ] as Check[]), [label + " HEAD has no body", () => assert.equal(group?.head.text, "")]];
}
function publicReplyChecks(label: string): Check[] {
  const group = publicGroups.get(label);
  return [...replyChecks(label, group),
    [label + " model transport/parse", () => assert.equal(group?.model.error, undefined)],
    [label + " model HTTP", () => assert.equal(group?.model.status, 200)],
    [label + " model status", () => assert.equal(group?.model.data?.status, 200)]];
}
function selectedBodyChecks(label: string, read: () => any, fixture: Fixture, otherBody: string): Check[] {
  return [[label + " correct body marker", () => assert.ok(read().textContent.includes(fixture.bodyMarker))],
    [label + " excludes other fixture body", () => assert.equal(read().textContent.includes(otherBody), false)],
    [label + " archive body anchor absent", () => assert.equal(read().querySelectorAll("#" + fixture.bodyTitleId).length, 0)],
    [label + " archive body wrapper absent", () => assert.equal(read().querySelectorAll(".wp-block-query-title").length, 0)]];
}
function singularChecks(label: string, fixture: Fixture, other: Fixture, slug: string, mainId: string, titleId: string, marker: string): Check[] {
  const group = publicGroups.get(label), model = group?.model.data;
  const checks: Check[] = [...publicReplyChecks(label),
    [label + " route is singular", () => assert.equal(model?.route?.kind, "singular")],
    [label + " selected ID", () => assert.equal(model?.route?.selectedId, fixture.post.id)],
    [label + " selected type", () => assert.equal(model?.route?.selectedType, fixture.post.type)],
    [label + " model post ID", () => assert.equal(model?.post?.id, fixture.post.id)],
    [label + " Source presentation", () => assert.equal(model?.presentation?.kind, "source")],
    [label + " actual assigned template", () => assert.equal(model?.presentation?.document?.slug, slug)]];
  for (const [surface, read] of [["native", () => nativeMain(group, mainId)], ["model HTML", () => modelMain(group, mainId)]] as const) {
    checks.push([label + " " + surface + " independent template marker", () => assert.ok(read().textContent.includes(marker))],
      [label + " " + surface + " actual PostTitle", () => assert.equal(required(read(), ".wp-block-post-title").textContent.trim(), fixture.post.title)],
      [label + " " + surface + " archive template anchor absent", () => assert.equal(read().querySelectorAll("#" + titleId).length, 0)],
      [label + " " + surface + " ALL archive wrappers absent", () => assert.equal(read().querySelectorAll(".wp-block-query-title").length, 0)],
      ...selectedBodyChecks(label + " " + surface, () => required(read(), "#" + fixture.bodyId), fixture, other.bodyMarker));
  }
  checks.push(...selectedBodyChecks(label + " selected post.content", () => required(dom(model?.post?.content), "#" + fixture.bodyId), fixture, other.bodyMarker));
  return checks;
}
async function cleanup() {
  if (cleaned) return cleanupFailures;
  cleaned = true;
  const attempt = async (endpoint: string, method: string, body?: unknown) => {
    const reply = await api(endpoint, method, body);
    if (reply.error || reply.status < 200 || reply.status >= 300) cleanupFailures.push(method + " " + endpoint + ": " + reply.status + (reply.error ? " " + reply.error : ""));
    return reply;
  };
  for (const id of postIds) { await attempt("/api/posts/" + id, "PUT", { status: "trash" }); await attempt("/api/posts/" + id, "DELETE"); }
  for (const id of documentIds) await attempt("/api/site-editor/documents/" + id, "DELETE");
  if (dateRestore) {
    const inventory = await attempt("/api/site-editor", "GET");
    const current = inventory.data?.templates?.find((item: any) => item.id === dateRestore.id);
    if (!current) cleanupFailures.push("Owned date-template restoration could not acquire its current version");
    else await attempt("/api/site-editor/documents/" + dateRestore.id, "PUT", { slug: dateRestore.slug, title: dateRestore.title,
      type: dateRestore.type, content: dateRestore.rawContent ?? dateRestore.content, blocks: dateRestore.blocks, version: current.version });
  }
  if (settingsRestore) await attempt("/api/settings", "PUT", settingsRestore);
  if (cookie) await attempt("/api/auth/logout", "POST");
  console.log("ARCHIVE_TITLE_FIXTURE_CLEANUP " + JSON.stringify({ postIds, documentIds, restoredDateId: dateRestore?.id,
    settingsRestoreAttempted: Boolean(settingsRestore), failures: cleanupFailures }));
  return cleanupFailures;
}
after(async () => { await cleanup(); assert.equal(cleanupFailures.length, 0, "Owned API cleanup: " + cleanupFailures.join("; ")); });

test("explicit archive QueryTitle is absent for actual singular templates and bodies, not archive loop posts", async t => {
  const stamp = "archive-title-" + Date.now().toString(36);
  const slug = stamp + "-assigned", mainId = stamp + "-main", titleId = stamp + "-template-title", marker = "ASSIGNED-MARKER-" + stamp;
  const archiveMain = stamp + "-date-main", archiveMarker = "DATE-MARKER-" + stamp;
  const archiveTitle = stamp + "-date-title", loopTitle = stamp + "-loop-title";
  try {
    await setup("/api/auth/login", "POST", { login: process.env.ADMIN_EMAIL, password: process.env.ADMIN_PASSWORD });
    assert.ok(cookie, "SETUP administrator session");
    const settings = (await setup("/api/settings")).settings;
    settingsRestore = Object.fromEntries(["theme", "timezone", "frontPageMode", "permalinkStructure"].map(key => [key, settings[key]]));
    await setup("/api/settings", "PUT", { theme: "twentytwentyfive", timezone: "UTC", frontPageMode: "posts", permalinkStructure: "/%postname%/" });
    const explicitTitle = (anchor: string) => '<!-- wp:query-title ' + JSON.stringify({ type: "archive", anchor }) + ' /-->';
    const group = (anchor: string, inner: string) => '<!-- wp:group ' + JSON.stringify({ tagName: "main", anchor }) + ' --><main id="' + anchor + '" class="wp-block-group">' + inner + '</main><!-- /wp:group -->';
    const assignedContent = group(mainId, "<p>" + marker + "</p>" + explicitTitle(titleId) + '<!-- wp:post-title {"level":1} /--><!-- wp:post-content /-->');
    const assigned = (await setup("/api/site-editor/documents", "POST", { type: "template", slug, title: slug, content: assignedContent }, 201)).document;
    assert.equal(assigned.slug, slug, "SETUP actual assigned slug");
    assert.ok(assigned.rawContent.includes(titleId), "SETUP retained template QueryTitle anchor");
    assert.match(assigned.rawContent, /wp:query-title\s+\{[^}]*"type"\s*:\s*"archive"/, "SETUP retained explicit archive type");
    const archiveContent = group(archiveMain, "<p>" + archiveMarker + "</p>" + explicitTitle(archiveTitle)
      + '<!-- wp:query {"query":{"inherit":true,"perPage":10}} --><!-- wp:post-template -->'
      + '<!-- wp:post-title {"level":2} /-->' + explicitTitle(loopTitle) + '<!-- wp:post-content /-->'
      + '<!-- /wp:post-template --><!-- /wp:query -->');
    const design = await setup("/api/site-editor"), date = design.templates.find((item: any) => item.slug === "date");
    let dateDocument: any;
    if (date) {
      dateRestore = date;
      dateDocument = (await setup("/api/site-editor/documents/" + date.id, "PUT", { type: "template", slug: "date", title: date.title, content: archiveContent, version: date.version })).document;
    } else dateDocument = (await setup("/api/site-editor/documents", "POST", { type: "template", slug: "date", title: stamp + " date", content: archiveContent }, 201)).document;
    assert.equal(dateDocument.slug, "date", "SETUP actual date template");
    assert.ok(dateDocument.rawContent.includes(archiveTitle) && dateDocument.rawContent.includes(loopTitle), "SETUP retained outer and loop archive anchors");
    assert.match(dateDocument.rawContent, /wp:query-title\s+\{[^}]*"type"\s*:\s*"archive"/, "SETUP retained date archive type");
    const make = async (type: "post" | "page"): Promise<Fixture> => {
      const bodyId = stamp + "-" + type + "-body", bodyTitleId = stamp + "-" + type + "-body-title", bodyMarker = "BODY-" + type.toUpperCase() + "-" + stamp;
      const content = '<!-- wp:group ' + JSON.stringify({ tagName: "section", anchor: bodyId }) + ' --><section id="' + bodyId + '" class="wp-block-group"><p>'
        + bodyMarker + '</p>' + explicitTitle(bodyTitleId) + '</section><!-- /wp:group -->';
      const created = (await setup("/api/posts", "POST", { type, title: stamp + " " + type, slug: stamp + "-" + type,
        status: "publish", commentStatus: "closed", templateSlug: slug, postDate: "2001-02-03T04:05:37", content }, 201)).post;
      const post = (await setup("/api/posts/" + created.id)).post;
      assert.equal(post.type, type, "SETUP saved type"); assert.equal(post.status, "publish", "SETUP saved publication");
      assert.equal(post.templateSlug, slug, "SETUP assigned template"); assert.equal(post.postDate.slice(0, 4), "2001", "SETUP matching civil year");
      assert.ok(post.rawContent.includes(bodyTitleId), "SETUP retained body QueryTitle anchor");
      assert.match(post.rawContent, /wp:query-title\s+\{[^}]*"type"\s*:\s*"archive"/, "SETUP retained body archive type");
      assert.ok((await setup("/api/posts/templates?type=" + type)).templates.some((item: any) => item.slug === slug), "SETUP template selectable for " + type);
      return { post, path: visiblePath(post.permalink), bodyId, bodyTitleId, bodyMarker };
    };
    const post = await make("post"), page = await make("page");
    await gatherPublic("post-bare", post.path); await gatherPublic("post-year", withYear(post.path));
    await gatherPublic("page-bare", page.path); await gatherPublic("page-year", withYear(page.path));
    await gatherPublic("date-archive", "/?year=2001");
    for (const [label, visible, year] of [["direct-bare", post.path, false], ["direct-year", withYear(post.path), true]] as const) {
      const query = new URLSearchParams({ postId: String(post.post.id), requestPath: visible });
      if (year) query.set("year", "2001");
      await gatherPair(directGroups, label, "/api/public/templates/" + slug + "?" + query);
    }
    await gatherPair(bodyGroups, "body-bare", "/api/public/posts/" + encodeURIComponent(post.post.slug));
    await gatherPair(bodyGroups, "body-year", "/api/public/posts/" + encodeURIComponent(post.post.slug) + "?year=2001");
    const dispatches = publicGroups.size * 3 + (directGroups.size + bodyGroups.size) * 2;
    console.log("ARCHIVE_TITLE_GATHER_COMPLETE " + JSON.stringify({ testBaseline: baseline, publicGroups: publicGroups.size, directGroups: directGroups.size,
      bodyGroups: bodyGroups.size, dispatches, intendedDispatches: 23 }));
    const proofPath = process.env.QUERY_TITLE_PROOF_PATH;
    if (proofPath) {
      assert.ok(path.isAbsolute(proofPath), "HARNESS proof path must be absolute");
      // Only anonymous public observations are persisted; setup/auth replies are excluded.
      await writeFile(proofPath, JSON.stringify({ testBaseline: baseline, dispatches, publicGroups: [...publicGroups.values()],
        directGroups: [...directGroups.values()], bodyGroups: [...bodyGroups.values()] }, null, 2) + "\n", { flag: "wx", mode: 0o600 });
      console.log("ARCHIVE_TITLE_PUBLIC_PROOF " + JSON.stringify({ path: proofPath }));
    }
    // Every intended response has been consumed before these aggregate policy checks.
    await t.test("selected POST bare and matching year omit template and embedded-body archive wrappers", () => verify([
      ...singularChecks("post-bare", post, page, slug, mainId, titleId, marker), ...singularChecks("post-year", post, page, slug, mainId, titleId, marker)]));
    await t.test("selected PAGE bare and matching year omit template and embedded-body archive wrappers", () => verify([
      ...singularChecks("page-bare", page, post, slug, mainId, titleId, marker), ...singularChecks("page-year", page, post, slug, mainId, titleId, marker)]));
    await t.test("real date archive keeps outer, loop-current-post and current-post-body archive titles", () => {
      const archive = publicGroups.get("date-archive"), model = archive?.model.data;
      const checks: Check[] = [...publicReplyChecks("date-archive"),
        ["all intended23 reads consumed", () => assert.equal(dispatches, 23)],
        ["archive route", () => assert.equal(model?.route?.kind, "archive")],
        ["actual date identity", () => assert.equal(model?.route?.archive?.type, "date")],
        ["actual year", () => assert.equal(model?.route?.archive?.year, 2001)],
        ["date template", () => assert.equal(model?.presentation?.document?.slug, "date")],
        ["owned post populates date listing", () => assert.ok(model?.site?.posts?.some((item: any) => item.id === post.post.id))]];
      for (const [surface, read] of [["native", () => nativeMain(archive, archiveMain)], ["model HTML", () => modelMain(archive, archiveMain)]] as const) {
        checks.push([surface + " independent date marker", () => assert.ok(read().textContent.includes(archiveMarker))],
          [surface + " outer archive title element", () => assert.equal(required(read(), "#" + archiveTitle).textContent.trim(), "Year: 2001")],
          [surface + " outer archive title wrapper", () => assert.ok(required(read(), "#" + archiveTitle).classList.contains("wp-block-query-title"))]);
        const row = () => required(read(), "li.post-" + post.post.id);
        checks.push([surface + " actual current-post title", () => assert.equal(required(row(), ".wp-block-post-title").textContent.trim(), post.post.title)],
          [surface + " loop archive title element", () => assert.equal(required(row(), "#" + loopTitle).textContent.trim(), "Year: 2001")],
          [surface + " loop archive title wrapper", () => assert.ok(required(row(), "#" + loopTitle).classList.contains("wp-block-query-title"))],
          [surface + " current-post body marker", () => assert.ok(required(row(), "#" + post.bodyId).textContent.includes(post.bodyMarker))],
          [surface + " current-post BODY archive title element", () => assert.equal(required(row(), "#" + post.bodyTitleId).textContent.trim(), "Year: 2001")],
          [surface + " current-post BODY archive wrapper", () => assert.ok(required(row(), "#" + post.bodyTitleId).classList.contains("wp-block-query-title"))]);
      }
      verify(checks);
    });
    await t.test("actual public direct-template selected post omits archive wrappers without a listing input", () => {
      const checks: Check[] = [];
      for (const label of ["direct-bare", "direct-year"]) {
        const reply = directGroups.get(label), data = reply?.get.data, read = () => required(dom(data?.content), "#" + mainId);
        checks.push(...replyChecks(label, reply), [label + " actual template ID", () => assert.equal(data?.document?.id, assigned.id)],
          [label + " template slug", () => assert.equal(data?.document?.slug, slug)],
          [label + " template type", () => assert.equal(data?.document?.type, "template")],
          [label + " independent template marker", () => assert.ok(read().textContent.includes(marker))],
          [label + " selected PostTitle", () => assert.equal(required(read(), ".wp-block-post-title").textContent.trim(), post.post.title)],
          [label + " template anchor absent", () => assert.equal(read().querySelectorAll("#" + titleId).length, 0)],
          [label + " ALL archive wrappers absent", () => assert.equal(read().querySelectorAll(".wp-block-query-title").length, 0)],
          ...selectedBodyChecks(label, () => required(read(), "#" + post.bodyId), post, page.bodyMarker));
      }
      verify(checks);
    });
    await t.test("actual public POST-body endpoint bare and matching year omits embedded archive wrappers", () => {
      const checks: Check[] = [];
      for (const label of ["body-bare", "body-year"]) {
        const reply = bodyGroups.get(label), data = reply?.get.data;
        checks.push(...replyChecks(label, reply), [label + " selected post ID", () => assert.equal(data?.post?.id, post.post.id)],
          [label + " post type", () => assert.equal(data?.post?.type, "post")],
          [label + " public unlocked body", () => assert.equal(data?.post?.locked, false)],
          ...selectedBodyChecks(label, () => required(dom(data?.post?.content), "#" + post.bodyId), post, page.bodyMarker));
      }
      verify(checks);
    });
    // No missing type, other type, mismatching pretty year, date SQL/flags, browser or feed claim.
  } finally { await cleanup(); }
});
