import test, { after } from "./isolated-test.js";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { parseHTML } from "linkedom";

const base = process.env.TEST_API_URL!, origin = process.env.APP_ORIGIN!;
const testBaseline = "0f7dd2f3d55a72a3b2b498a152a10332ef066c68";
type Reply = { status: number; text: string; data: any; error?: string };
type Group = { label: string; visiblePath: string; siteEndpoint: string; get: Reply; head: Reply; model: Reply; site: Reply };
type Check = [string, () => void];
const groups = new Map<string, Group>(), postIds: number[] = [], documentIds: number[] = [], documentRestores: any[] = [], cleanupFailures: string[] = [];
let cookie = "", settingsRestore: Record<string, unknown> | undefined, cleaned = false;
const sha = (text: string) => createHash("sha256").update(text).digest("hex");

async function api(endpoint: string, method = "GET", body?: unknown): Promise<Reply> {
  try {
    const response = await fetch(base + endpoint, { method, redirect: "manual", signal: AbortSignal.timeout(15000),
      headers: { Origin: origin, "Content-Type": "application/json", ...(cookie ? { Cookie: cookie } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const text = await response.text(); let data: any = null;
    try { data = JSON.parse(text); } catch { /* Setup validation reports malformed replies. */ }
    if (endpoint === "/api/auth/login" && response.ok) cookie = response.headers.get("set-cookie")?.split(";")[0] || "";
    return { status: response.status, text, data };
  } catch (error) { return { status: 0, text: "", data: null, error: String(error) }; }
}
async function setup(endpoint: string, method = "GET", body?: unknown, status = 200) {
  const reply = await api(endpoint, method, body);
  if (method === "POST" && endpoint === "/api/posts" && Number.isSafeInteger(reply.data?.post?.id)) postIds.push(reply.data.post.id);
  if (method === "POST" && endpoint === "/api/site-editor/documents" && Number.isSafeInteger(reply.data?.document?.id)) documentIds.push(reply.data.document.id);
  assert.equal(reply.error, undefined, "SETUP transport " + endpoint);
  assert.equal(reply.status, status, "SETUP HTTP " + endpoint); assert.notEqual(reply.data, null, "SETUP JSON " + endpoint);
  return reply.data;
}
async function acquire(endpoint: string, method: "GET" | "HEAD", json = false): Promise<Reply> {
  try {
    // Actual public acquisitions never send the administrator setup cookie.
    const response = await fetch(base + endpoint, { method, redirect: "manual", signal: AbortSignal.timeout(15000),
      headers: { Accept: json ? "application/json" : "text/html" } });
    const text = await response.text(); let data: any = null, error: string | undefined;
    if (json) try { data = JSON.parse(text); } catch { error = "Public response was not JSON"; }
    return { status: response.status, text, data, ...(error ? { error } : {}) };
  } catch (error) { return { status: 0, text: "", data: null, error: String(error) }; }
}
const receipt = (reply: Reply) => ({ status: reply.status, bytes: Buffer.byteLength(reply.text), sha256: sha(reply.text), error: reply.error });
async function gather(label: string, visiblePath: string, siteEndpoint: string) {
  const [get, head, model, site] = await Promise.all([acquire(visiblePath, "GET"), acquire(visiblePath, "HEAD"),
    acquire("/api/public/document?" + new URLSearchParams({ path: visiblePath }), "GET", true), acquire(siteEndpoint, "GET", true)]);
  groups.set(label, { label, visiblePath, siteEndpoint, get, head, model, site });
  console.log("HOME_TITLE_BODY_DISPATCH " + JSON.stringify({ label, visiblePath, siteEndpoint, get: receipt(get), head: receipt(head),
    model: { ...receipt(model), kind: model.data?.route?.kind, theme: model.data?.site?.settings?.theme,
      presentationKind: model.data?.presentation?.kind, documentId: model.data?.presentation?.document?.id, documentSlug: model.data?.presentation?.document?.slug }, site: receipt(site) }));
}
function dom(html: unknown) {
  assert.equal(typeof html, "string", "Actual HTML fragment");
  return parseHTML("<!doctype html><html><body>" + html + "</body></html>").document;
}
function required(root: any, selector: string) { const node = root?.querySelector(selector); assert.ok(node, "Actual markup missing " + selector); return node; }
function verify(checks: Check[]) {
  const failures: string[] = [];
  for (const [label, check] of checks) try { check(); } catch (error) { failures.push(label + ": " + (error instanceof Error ? error.message : String(error))); }
  assert.equal(failures.length, 0, failures.join("\n"));
}
function common(label: string, theme: string, kind: "home" | "archive"): Check[] {
  const group = groups.get(label), model = group?.model.data;
  return [[label + " acquired", () => assert.ok(group)],
    ...(["get", "head", "model", "site"] as const).flatMap(surface => [
      [label + " " + surface + " transport/parse", () => assert.equal(group?.[surface].error, undefined)],
      [label + " " + surface + " HTTP200", () => assert.equal(group?.[surface].status, 200)],
    ] as Check[]), [label + " HEAD empty", () => assert.equal(group?.head.text, "")],
    [label + " model status200", () => assert.equal(model?.status, 200)],
    [label + " exact route kind", () => assert.equal(model?.route?.kind, kind)],
    [label + " model actual theme", () => assert.equal(model?.site?.settings?.theme, theme)],
    [label + " site API actual theme", () => assert.equal(group?.site.data?.settings?.theme, theme)],
    [label + " posts reading mode", () => assert.equal(model?.site?.settings?.frontPageMode, "posts")]];
}
async function cleanup() {
  if (cleaned) return; cleaned = true;
  const attempt = async (endpoint: string, method: string, body?: unknown): Promise<Reply> => {
    const reply = await api(endpoint, method, body);
    if (reply.error || reply.status < 200 || reply.status >= 300) cleanupFailures.push(method + " " + endpoint + ": " + reply.status + (reply.error ? " " + reply.error : ""));
    return reply;
  };
  if (documentRestores.length || documentIds.length) {
    // Document APIs use the active theme. Never restore TT25 documents under Classic.
    await attempt("/api/settings", "PUT", { theme: "twentytwentyfive" });
    for (const id of documentIds) await attempt("/api/site-editor/documents/" + id, "DELETE");
    for (const saved of documentRestores) {
      const inventory = await attempt("/api/site-editor", "GET"), current = inventory.data?.templates?.find((item: any) => item.id === saved.id);
      if (!current) cleanupFailures.push("Could not acquire current TT25 template version: " + saved.id);
      else await attempt("/api/site-editor/documents/" + saved.id, "PUT", { type: saved.type, slug: saved.slug, title: saved.title,
        content: saved.rawContent ?? saved.content, blocks: saved.blocks, version: current.version });
    }
  }
  for (const id of postIds) { await attempt("/api/posts/" + id, "PUT", { status: "trash" }); await attempt("/api/posts/" + id, "DELETE"); }
  if (settingsRestore) await attempt("/api/settings", "PUT", settingsRestore);
  if (cookie) await attempt("/api/auth/logout", "POST");
  console.log("HOME_TITLE_BODY_CLEANUP " + JSON.stringify({ postIds, documentIds, restoredTT25Ids: documentRestores.map(item => item.id),
    originalSettingsRestoreAttempted: Boolean(settingsRestore), failures: cleanupFailures }));
}
after(async () => { await cleanup(); assert.equal(cleanupFailures.length, 0, "Owned API cleanup: " + cleanupFailures.join("; ")); });

test("ordinary posts-home archive titles are omitted from Source and Classic post bodies, not real date bodies", async t => {
  const stamp = "home-title-body-" + Date.now().toString(36), bodyId = stamp + "-body", titleId = stamp + "-title", marker = "INDEPENDENT-POST-BODY-" + stamp;
  const homeMain = stamp + "-home-main", dateMain = stamp + "-date-main", homeMarker = "SOURCE-HOME-" + stamp, dateMarker = "SOURCE-DATE-" + stamp;
  try {
    await setup("/api/auth/login", "POST", { login: process.env.ADMIN_EMAIL, password: process.env.ADMIN_PASSWORD }); assert.ok(cookie, "SETUP administrator cookie");
    const original = (await setup("/api/settings")).settings;
    settingsRestore = Object.fromEntries(["theme", "timezone", "frontPageMode", "frontPageId", "postsPageId", "permalinkStructure", "postsPerPage"].map(key => [key, original[key]]));
    await setup("/api/settings", "PUT", { theme: "twentytwentyfive", timezone: "UTC", frontPageMode: "posts", frontPageId: null, postsPageId: null, permalinkStructure: "/%postname%/", postsPerPage: 100 });
    const content = '<!-- wp:group ' + JSON.stringify({ tagName: "section", anchor: bodyId }) + ' --><section id="' + bodyId + '" class="wp-block-group"><p>' + marker
      + '</p><!-- wp:query-title ' + JSON.stringify({ type: "archive", anchor: titleId }) + ' /--></section><!-- /wp:group -->';
    const created = (await setup("/api/posts", "POST", { type: "post", title: stamp + " owned post", slug: stamp + "-post", status: "publish", excerpt: "",
      commentStatus: "closed", postDate: "2001-02-03T04:05:37", content }, 201)).post;
    const post = (await setup("/api/posts/" + created.id)).post;
    assert.equal(post.id, created.id, "SETUP actual POST ID"); assert.equal(post.type, "post", "SETUP actual POST type");
    assert.equal(post.status, "publish", "SETUP actual publication"); assert.equal(post.excerpt, "", "SETUP actual explicit empty excerpt");
    assert.equal(post.hasPassword, false, "SETUP actual unprotected post"); assert.equal(post.postDate, "2001-02-03T04:05:37", "SETUP civil date");
    assert.ok(post.rawContent.includes(bodyId) && post.rawContent.includes(marker) && post.rawContent.includes(titleId), "SETUP actual saved body container/marker/title");
    assert.match(post.rawContent, /wp:query-title\s+\{[^}]*"type"\s*:\s*"archive"/, "SETUP explicit archive body type");
    assert.equal(typeof post.permalink, "string", "SETUP actual permalink");
    const savedURL = new URL(post.permalink, base); assert.equal(savedURL.origin, new URL(base).origin, "SETUP actual permalink origin");
    const actualPostPath = savedURL.pathname + savedURL.search;
    const makeTemplate = async (slug: "home" | "date", mainId: string, templateMarker: string) => {
      const raw = '<!-- wp:group ' + JSON.stringify({ tagName: "main", anchor: mainId }) + ' --><main id="' + mainId + '" class="wp-block-group"><p>' + templateMarker
        + '</p><!-- wp:query {"query":{"inherit":true,"perPage":100}} --><!-- wp:post-template --><!-- wp:post-title {"isLink":true} /--><!-- wp:post-content /--><!-- /wp:post-template --><!-- /wp:query --></main><!-- /wp:group -->';
      const existing = (await setup("/api/site-editor")).templates.find((item: any) => item.slug === slug); let saved: any;
      if (existing) {
        documentRestores.push(existing);
        saved = (await setup("/api/site-editor/documents/" + existing.id, "PUT", { type: "template", slug, title: existing.title, content: raw, version: existing.version })).document;
      } else saved = (await setup("/api/site-editor/documents", "POST", { type: "template", slug, title: stamp + " " + slug, content: raw }, 201)).document;
      const readBack = (await setup("/api/site-editor")).templates.find((item: any) => item.id === saved.id);
      assert.ok(readBack, "SETUP current saved document inventory"); assert.equal(readBack.slug, slug, "SETUP actual saved template slug");
      assert.equal(readBack.type, "template", "SETUP actual template type");
      assert.ok(readBack.rawContent.includes(mainId) && readBack.rawContent.includes(templateMarker), "SETUP retained template identity/marker");
      assert.match(readBack.rawContent, /wp:query\s+\{[^\n]*"inherit"\s*:\s*true/, "SETUP inherited query");
      assert.ok(readBack.rawContent.includes("wp:post-content"), "SETUP actual PostContent loop"); return readBack;
    };
    const homeDocument = await makeTemplate("home", homeMain, homeMarker), dateDocument = await makeTemplate("date", dateMain, dateMarker);
    await gather("source-home", "/", "/api/public/site"); await gather("source-date", "/?year=2001", "/api/public/site?year=2001");
    await setup("/api/settings", "PUT", { theme: "classic" });
    await gather("classic-home", "/", "/api/public/site"); await gather("classic-date", "/?year=2001", "/api/public/site?year=2001");
    const dispatches = groups.size * 4;
    console.log("HOME_TITLE_BODY_GATHER_COMPLETE " + JSON.stringify({ testBaseline, groups: groups.size, dispatches, intendedDispatches: 16 }));
    const proofPath = process.env.ARCHIVE_TITLE_HOME_BODY_PROOF_PATH;
    if (proofPath) {
      assert.ok(path.isAbsolute(proofPath), "HARNESS proof path must be absolute");
      await writeFile(proofPath, JSON.stringify({ testBaseline, dispatches, fixture: { id: post.id, title: post.title, slug: post.slug, permalink: post.permalink,
        excerpt: post.excerpt, bodyId, titleId, marker, homeMain, dateMain, homeMarker, dateMarker, homeDocumentId: homeDocument.id, dateDocumentId: dateDocument.id }, groups: [...groups.values()] }, null, 2) + "\n", { flag: "wx", mode: 0o600 });
    }
    function identityChecks(label: string, item: () => any): Check[] {
      return [[label + " exact owned POST ID", () => assert.equal(item()?.id, post.id)], [label + " actual POST type", () => assert.equal(item()?.type, "post")],
        [label + " exact owned title", () => assert.equal(item()?.title, post.title)], [label + " unlocked", () => assert.equal(item()?.locked, false)],
        [label + " explicit empty excerpt", () => assert.equal(item()?.excerpt, "")], [label + " actual owned permalink", () => {
          const url = new URL(item()?.permalink, base); assert.equal(url.pathname + url.search, actualPostPath);
        }]];
    }
    function bodyChecks(label: string, read: () => any, retained: boolean): Check[] {
      return [[label + " exact body section", () => assert.equal(read().id, bodyId)],
        [label + " independent literal body marker", () => assert.equal(Array.from(read().querySelectorAll("p")).filter((node: any) => node.textContent.trim() === marker).length, 1)],
        [label + " owned title anchor count", () => assert.equal(read().querySelectorAll("#" + titleId).length, retained ? 1 : 0)],
        [label + " body archive wrapper count", () => assert.equal(read().querySelectorAll(".wp-block-query-title").length, retained ? 1 : 0)],
        ...(retained ? [[label + " actual date title text/class", () => { const title = required(read(), "#" + titleId);
          assert.ok(title.classList.contains("wp-block-query-title")); assert.equal(title.textContent.trim(), "Year: 2001"); }] as Check] : [])];
    }
    function projectionChecks(label: string, retained: boolean): Check[] {
      const group = groups.get(label), modelPost = () => group?.model.data?.site?.posts?.find((item: any) => item.id === post.id), sitePost = () => group?.site.data?.posts?.find((item: any) => item.id === post.id);
      return [...identityChecks(label + " model POST", modelPost), ...identityChecks(label + " site API POST", sitePost),
        ...bodyChecks(label + " model POST content", () => required(dom(modelPost()?.content), "#" + bodyId), retained),
        ...bodyChecks(label + " actual site API POST content", () => required(dom(sitePost()?.content), "#" + bodyId), retained)];
    }
    function linkChecks(label: string, article: () => any): Check[] {
      return [[label + " actual owned post-title link", () => {
        const link = required(article(), "h2.wp-block-post-title a, h2 a"), href = link.getAttribute("href");
        assert.equal(typeof href, "string"); const url = new URL(href!, base);
        assert.equal(url.pathname + url.search, actualPostPath); assert.equal(link.textContent.trim(), post.title);
      }]];
    }
    function sourceChecks(label: string, document: any, mainId: string, templateMarker: string, retained: boolean): Check[] {
      const group = groups.get(label), model = group?.model.data;
      const checks: Check[] = [[label + " actual Source presentation", () => assert.equal(model?.presentation?.kind, "source")],
        [label + " exact saved document ID", () => assert.equal(model?.presentation?.document?.id, document.id)],
        [label + " exact saved document slug", () => assert.equal(model?.presentation?.document?.slug, document.slug)]];
      for (const [surface, root] of [["native Source island", () => required(parseHTML(group!.get.text).document, '.wp-site-blocks[data-worldact-public-island="true"]')],
        ["model presentation fragment", () => dom(model?.presentation?.html)]] as const) {
        const main = () => required(root(), "#" + mainId), row = () => required(main(), "li.post-" + post.id);
        checks.push([label + " " + surface + " exact template container", () => assert.equal(main().id, mainId)],
          [label + " " + surface + " independent template marker", () => assert.equal(Array.from(main().querySelectorAll("p")).filter((node: any) => node.textContent.trim() === templateMarker).length, 1)],
          ...linkChecks(label + " " + surface, row), ...bodyChecks(label + " " + surface + " owned loop body", () => required(row(), "#" + bodyId), retained));
      }
      return checks;
    }
    function classicChecks(label: string, retained: boolean): Check[] {
      const group = groups.get(label), model = group?.model.data;
      const native = () => parseHTML(group!.get.text).document, section = () => required(native(), '.public-posts article .public-content[data-worldact-public-island="true"] #' + bodyId);
      const card = () => { const article = section().closest("article"); assert.ok(article, "Actual Classic card article"); return article; };
      return [[label + " actual Classic presentation", () => assert.equal(model?.presentation?.kind, "classic")],
        [label + " actual default cards not custom index", () => assert.equal(model?.presentation?.slots?.index, undefined)],
        [label + " actual full-body island", () => assert.ok(section().closest('.public-content[data-worldact-public-island="true"]'))],
        ...linkChecks(label + " Classic card", card), ...bodyChecks(label + " native Classic owned body", section, retained)];
    }
    // Every one of the16 actual responses has been consumed before these children.
    await t.test("Source posts home omits archive title in inherited loop, model POST and actual site API body", () => verify([
      ["all16 intended responses consumed", () => assert.equal(dispatches, 16)], ...common("source-home", "twentytwentyfive", "home"),
      ...projectionChecks("source-home", false), ...sourceChecks("source-home", homeDocument, homeMain, homeMarker, false)]));
    await t.test("Classic posts home default full-body card, model POST and actual site API omit archive title", () => verify([
      ...common("classic-home", "classic", "home"), ...projectionChecks("classic-home", false), ...classicChecks("classic-home", false)]));
    await t.test("real date archive body titles remain in both themes and both actual body projection APIs", () => {
      const checks: Check[] = [];
      for (const [label, theme] of [["source-date", "twentytwentyfive"], ["classic-date", "classic"]] as const) {
        checks.push(...common(label, theme, "archive"), [label + " actual date identity", () => assert.equal(groups.get(label)?.model.data?.route?.archive?.type, "date")],
          [label + " actual year2001", () => assert.equal(groups.get(label)?.model.data?.route?.archive?.year, 2001)], ...projectionChecks(label, true));
      }
      checks.push(...sourceChecks("source-date", dateDocument, dateMain, dateMarker, true), ...classicChecks("classic-date", true)); verify(checks);
    });
  } finally { await cleanup(); }
});
