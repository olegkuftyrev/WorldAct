import test, { after } from "./isolated-test.js";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { parseHTML } from "linkedom";

const base = process.env.TEST_API_URL!, origin = process.env.APP_ORIGIN!;
type Reply = { status: number; text: string; data: any; error?: string };
type Group = { label: string; path: string; get: Reply; head: Reply; model: Reply };
type Check = [string, () => void];
const groups = new Map<string, Group>(), postIds: number[] = [], documentIds: number[] = [];
let cookie = "", restore: Record<string, unknown> | undefined, cleaned = false;
const sha = (text: string) => createHash("sha256").update(text).digest("hex");
async function api(path: string, method = "GET", body?: unknown): Promise<Reply> {
  try {
    const response = await fetch(base + path, { method, redirect: "manual", signal: AbortSignal.timeout(15000),
      headers: { Origin: origin, "Content-Type": "application/json", ...(cookie ? { Cookie: cookie } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const text = await response.text();
    let data: any = null; try { data = JSON.parse(text); } catch { /* Report through setup validation. */ }
    if (path === "/api/auth/login" && response.ok) cookie = response.headers.get("set-cookie")?.split(";")[0] || "";
    return { status: response.status, text, data };
  } catch (error) { return { status: 0, text: "", data: null, error: String(error) }; }
}
async function setup(path: string, method = "GET", body?: unknown, expected = 200) {
  const reply = await api(path, method, body);
  if (Number.isSafeInteger(reply.data?.post?.id) && method === "POST" && path === "/api/posts") postIds.push(reply.data.post.id);
  if (Number.isSafeInteger(reply.data?.document?.id) && method === "POST" && path === "/api/site-editor/documents") documentIds.push(reply.data.document.id);
  assert.equal(reply.error, undefined, "SETUP transport: " + path);
  assert.equal(reply.status, expected, "SETUP HTTP: " + path);
  return reply.data;
}
async function acquire(path: string, method: "GET" | "HEAD", json = false): Promise<Reply> {
  try {
    const response = await fetch(base + path, { method, redirect: "manual", signal: AbortSignal.timeout(15000),
      headers: { Accept: json ? "application/json" : "text/html" } });
    const text = await response.text();
    let data: any = null, error: string | undefined;
    if (json) try { data = JSON.parse(text); } catch { error = "document response was not JSON"; }
    return { status: response.status, text, data, ...(error ? { error } : {}) };
  } catch (error) { return { status: 0, text: "", data: null, error: String(error) }; }
}
async function gather(label: string, path: string) {
  // All three surfaces are actually dispatched independently before policy checks.
  const [get, head, model] = await Promise.all([acquire(path, "GET"), acquire(path, "HEAD"),
    acquire("/api/public/document?" + new URLSearchParams({ path }), "GET", true)]);
  const group = { label, path, get, head, model }; groups.set(label, group);
  console.log("SINGULAR_DATE_DISPATCH " + JSON.stringify({ label, path,
    get: { status: get.status, bytes: Buffer.byteLength(get.text), sha256: sha(get.text), error: get.error },
    head: { status: head.status, bytes: Buffer.byteLength(head.text), error: head.error },
    model: { status: model.status, kind: model.data?.route?.kind, selectedId: model.data?.route?.selectedId,
      postId: model.data?.post?.id, documentSlug: model.data?.presentation?.document?.slug, error: model.error } }));
  return group;
}
function visiblePath(value: unknown) {
  assert.equal(typeof value, "string", "SETUP saved permalink must be a string");
  const url = new URL(value as string, base);
  assert.equal(url.origin, new URL(base).origin, "SETUP same-origin relative fixture URL");
  return url.pathname + url.search;
}
function withQuery(path: string, values: Record<string, string>) {
  const url = new URL(path, base); for (const [key, value] of Object.entries(values)) url.searchParams.set(key, value);
  return url.pathname + url.search;
}
function responseChecks(label: string, status: number): Check[] {
  const group = groups.get(label);
  return [[label + " was gathered", () => assert.ok(group)],
    ...(["get", "head", "model"] as const).flatMap(surface => [
      [label + " " + surface + " transport/parse", () => assert.equal(group?.[surface].error, undefined)],
      [label + " " + surface + " HTTP", () => assert.equal(group?.[surface].status, status)],
    ] as Check[]),
    [label + " HEAD body", () => assert.equal(group?.head.text, "")],
    [label + " model status", () => assert.equal(group?.model.data?.status, status)]];
}
function singularChecks(label: string, post: any, slug: string, marker: string, bodyMarker: string, excludedBody: string): Check[] {
  const group = groups.get(label);
  return [...responseChecks(label, 200),
    [label + " singular", () => assert.equal(group?.model.data?.route?.kind, "singular")],
    [label + " selected id", () => assert.equal(group?.model.data?.route?.selectedId, post.id)],
    [label + " selected type", () => assert.equal(group?.model.data?.route?.selectedType, post.type)],
    [label + " main id", () => assert.equal(group?.model.data?.post?.id, post.id)],
    [label + " Source presentation", () => assert.equal(group?.model.data?.presentation?.kind, "source")],
    [label + " assigned custom template", () => assert.equal(group?.model.data?.presentation?.document?.slug, slug)],
    [label + " native custom marker", () => assert.equal(group?.get.text.includes(marker), true)],
    [label + " model custom marker", () => assert.equal(group?.model.data?.presentation?.html?.includes(marker), true)],
    [label + " native selected body", () => assert.equal(group?.get.text.includes(bodyMarker), true)],
    [label + " model selected body", () => assert.equal(group?.model.data?.post?.content?.includes(bodyMarker), true)],
    [label + " native excludes other body", () => assert.equal(group?.get.text.includes(excludedBody), false)],
    [label + " main excludes other body", () => assert.equal(group?.model.data?.post?.content?.includes(excludedBody), false)]];
}
function verify(checks: Check[]) {
  const failures: string[] = [];
  for (const [label, check] of checks) try { check(); } catch (error) { failures.push(label + ": " + (error instanceof Error ? error.message : String(error))); }
  assert.equal(failures.length, 0, failures.join("\n"));
}
async function cleanup() {
  if (cleaned) return; cleaned = true;
  const failures: string[] = [];
  const request = async (path: string, method: string, body?: unknown) => {
    const reply = await api(path, method, body);
    if (reply.status < 200 || reply.status >= 300) failures.push(method + " " + path + ": " + reply.status);
  };
  for (const id of postIds) { await request("/api/posts/" + id, "PUT", { status: "trash" }); await request("/api/posts/" + id, "DELETE"); }
  for (const id of documentIds) await request("/api/site-editor/documents/" + id, "DELETE");
  if (restore) await request("/api/settings", "PUT", restore);
  if (cookie) await request("/api/auth/logout", "POST");
  assert.equal(failures.length, 0, "Owned fixture cleanup: " + failures.join("; "));
}
after(cleanup);

test("singular/date template priority preserves chosen bodies without changing date SQL policy", async t => {
  const stamp = "singular-date-" + Date.now().toString(36);
  const pageTemplate = stamp + "-page-template", postTemplate = stamp + "-post-template";
  const pageMarker = "OWNED-PAGE-CUSTOM-" + stamp, postMarker = "OWNED-POST-CUSTOM-" + stamp;
  const pageOne = "OWNED-PAGE-FIRST-" + stamp, pageTwo = "OWNED-PAGE-SECOND-" + stamp;
  const postOne = "OWNED-POST-FIRST-" + stamp, postTwo = "OWNED-POST-SECOND-" + stamp;
  try {
    await setup("/api/auth/login", "POST", { login: process.env.ADMIN_EMAIL, password: process.env.ADMIN_PASSWORD });
    assert.ok(cookie, "SETUP administrator session");
    const original = (await setup("/api/settings")).settings;
    restore = Object.fromEntries(["theme", "timezone", "frontPageMode", "permalinkStructure"].map(key => [key, original[key]]));
    await setup("/api/settings", "PUT", { theme: "twentytwentyfive", timezone: "UTC", frontPageMode: "posts", permalinkStructure: "/%postname%/" });
    const design = await setup("/api/site-editor");
    for (const slug of ["date", "404"]) if (!design.templates.some((document: any) => document.slug === slug)) {
      const created = await setup("/api/site-editor/documents", "POST", { type: "template", slug, title: stamp + " " + slug,
        content: "<p>OWNED-FALLBACK-" + slug.toUpperCase() + "-" + stamp + "</p>" }, 201);
      assert.equal(created.document.slug, slug, "SETUP actual saved fallback slug");
    }
    const inventory = await setup("/api/site-editor");
    assert.ok(inventory.templates.some((document: any) => document.slug === "date"), "SETUP available date template");
    assert.ok(inventory.templates.some((document: any) => document.slug === "404"), "SETUP available404 template");
    for (const [slug, marker] of [[pageTemplate, pageMarker], [postTemplate, postMarker]])
      await setup("/api/site-editor/documents", "POST", { type: "template", slug, title: slug,
        content: '<!-- wp:group {"tagName":"main"} --><main class="wp-block-group"><p>' + marker + '</p><!-- wp:post-title {"level":1} /--><!-- wp:post-content /--></main><!-- /wp:group -->' }, 201);
    for (const type of ["page", "post"]) {
      const available = (await setup("/api/posts/templates?type=" + type)).templates;
      assert.ok(available.some((entry: any) => entry.slug === (type === "page" ? pageTemplate : postTemplate)), "SETUP custom template selectable for " + type);
    }
    const make = async (type: "post" | "page", templateSlug: string, one: string, two: string) => {
      const made = (await setup("/api/posts", "POST", { type, title: stamp + " " + type, slug: stamp + "-" + type,
        status: "publish", commentStatus: "closed", templateSlug, postDate: "2001-02-03T04:05:37",
        content: "<p>" + one + "</p><!--nextpage--><p>" + two + "</p>" }, 201)).post;
      const saved = (await setup("/api/posts/" + made.id)).post;
      assert.equal(saved.type, type, "SETUP saved type"); assert.equal(saved.status, "publish", "SETUP saved publication");
      assert.equal(saved.templateSlug, templateSlug, "SETUP saved custom template");
      assert.equal(saved.postDate.slice(0, 4), "2001", "SETUP matching civil year");
      assert.equal(saved.rawContent.includes("<!--nextpage-->"), true, "SETUP retained body separator");
      return saved;
    };
    const page = await make("page", pageTemplate, pageOne, pageTwo), post = await make("post", postTemplate, postOne, postTwo);
    const pagePath = visiblePath(page.permalink), postPath = visiblePath(post.permalink);
    await gather("page-bare", pagePath); await gather("page-year", withQuery(pagePath, { year: "2001" }));
    await gather("post-bare", postPath); await gather("post-year", withQuery(postPath, { year: "2001" }));
    // Plain-ID200 aliases are existing supported WorldAct acquisition surfaces.
    // WP page_id SQL replacement supports the template target; canonical redirects are separate.
    await gather("plain-bare", "/?page_id=" + page.id); await gather("plain-year", "/?page_id=" + page.id + "&year=1999");
    let linkError = "";
    try {
      const { document } = parseHTML(groups.get("page-bare")!.get.text);
      const anchor = Array.from(document.querySelectorAll(".post-nav-links a.post-page-numbers")).find(item => item.textContent?.trim() === "2");
      const href = anchor?.getAttribute("href");
      if (!href) throw new Error("Actual bare PAGE body-page2 link was absent; no fallback URL fabricated.");
      const actual = visiblePath(href);
      await gather("body2-actual", actual);
      await gather("body2-counters", withQuery(actual, { year: "2001", "query-7-page": "2", commentPage: "1" }));
    } catch (error) { linkError = String(error); console.log("SINGULAR_DATE_LINK_ACQUISITION " + JSON.stringify({ error: linkError })); }
    await gather("root-date", "/?year=2001"); await gather("path-date", "/2001/");
    await gather("missing-date", "/missing-" + stamp + "/?year=2001");
    console.log("SINGULAR_DATE_GATHER_COMPLETE " + JSON.stringify({ groups: groups.size, intendedGroups: 11, surfaces: groups.size * 3, intendedSurfaces: 33, linkError }));

    // Every intended available surface above is consumed before these aggregate policy assertions.
    await t.test("matching-year pretty PAGE keeps its assigned custom template", () => verify([
      ...singularChecks("page-bare", page, pageTemplate, pageMarker, pageOne, pageTwo),
      ...singularChecks("page-year", page, pageTemplate, pageMarker, pageOne, pageTwo)]));
    await t.test("matching-year pretty POST keeps its assigned custom template", () => verify([
      ...singularChecks("post-bare", post, postTemplate, postMarker, postOne, postTwo),
      ...singularChecks("post-year", post, postTemplate, postMarker, postOne, postTwo)]));
    await t.test("Plain page_id keeps its custom template under a mismatching year", () => verify([
      ...singularChecks("plain-bare", page, pageTemplate, pageMarker, pageOne, pageTwo),
      ...singularChecks("plain-year", page, pageTemplate, pageMarker, pageOne, pageTwo)]));
    await t.test("actual body-page links retain singular identity, selected body and independent counters", () => {
      const checks: Check[] = [["actual link acquisition", () => assert.equal(linkError, "")],
        ["all eleven groups gathered", () => assert.equal(groups.size, 11)]];
      for (const label of ["body2-actual", "body2-counters"]) {
        const model = groups.get(label)?.model.data;
        checks.push(...singularChecks(label, page, pageTemplate, pageMarker, pageTwo, pageOne),
          [label + " contentPage", () => assert.equal(model?.route?.query?.contentPage, 2)],
          [label + " archivePage", () => assert.equal(model?.route?.query?.archivePage, 1)],
          [label + " body pagination", () => assert.equal(model?.post?.contentPagination?.page, 2)]);
      }
      checks.push(["independent query counter", () => assert.equal(groups.get("body2-counters")?.model.data?.route?.query?.blockPages?.["query-7-page"], 2)],
        ["independent comment counter", () => assert.equal(groups.get("body2-counters")?.model.data?.route?.query?.commentPage, 1)]);
      // No loop/comment rows are created: this checks counter parsing, not loop/comment contents.
      verify(checks);
    });
    await t.test("populated root/path date archives and retained404 keep their template priority", () => {
      const checks: Check[] = [];
      for (const label of ["root-date", "path-date"]) {
        const group = groups.get(label), model = group?.model.data;
        checks.push(...responseChecks(label, 200),
          [label + " archive route", () => assert.equal(model?.route?.kind, "archive")],
          [label + " date identity", () => assert.equal(model?.route?.archive?.type, "date")],
          [label + " date year", () => assert.equal(model?.route?.archive?.year, 2001)],
          [label + " date template", () => assert.equal(model?.presentation?.document?.slug, "date")],
          [label + " populated by owned POST", () => assert.equal(model?.site?.posts?.some((entry: any) => entry.id === post.id), true)],
          [label + " no PAGE custom surrounding marker", () => assert.equal(group?.get.text.includes(pageMarker), false)],
          [label + " no POST custom surrounding marker", () => assert.equal(group?.get.text.includes(postMarker), false)]);
      }
      const missing = groups.get("missing-date")?.model.data;
      checks.push(...responseChecks("missing-date", 404),
        ["retained404 kind", () => assert.equal(missing?.route?.kind, "not-found")],
        ["retained404 main post", () => assert.equal(missing?.post, null)],
        ["retained404 no selected identity", () => assert.equal(missing?.route?.selectedId, undefined)],
        ["retained404 template", () => assert.equal(missing?.presentation?.document?.slug, "404")]);
      verify(checks);
    });
    // Raw query.date/site.archive flags and authored query-title labels are deliberately unasserted.
    // No mismatching pretty-year200 target, date SQL change, Search block, account or race is involved.
  } finally { await cleanup(); }
});
