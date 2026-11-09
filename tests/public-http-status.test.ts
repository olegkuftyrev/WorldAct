import test, { after } from "./isolated-test.js";
import assert from "node:assert/strict";
import { DOMParser } from "linkedom";
import { publicDocumentIdentity } from "../server/public-documents.js";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { pool, rootDir, uploadsDir } from "../server/db.js";
import { postPermalink } from "../server/permalinks.js";

const base = process.env.TEST_API_URL!, origin = process.env.APP_ORIGIN!;
const documentCacheControl = "no-cache, must-revalidate, max-age=0, no-store, private";
after(() => pool.end());

function assertPrivateDocument(response: Response) {
  assert.equal(response.headers.get("cache-control"), documentCacheControl);
  assert.equal(response.headers.get("expires"), "Wed, 11 Jan 1984 05:00:00 GMT");
  assert.equal(response.headers.get("last-modified"), null);
}

function assertRenderedDocument(html: string, route: string, status = 200) {
  const document = new DOMParser().parseFromString(html,"text/html"),root=document.querySelector("#root"),data=document.querySelector("#worldact-public-document");
  assert.ok(root,route+" root");
  assert.equal(document.querySelectorAll("title").length,1,route+" has one actual document title");
  if(data){
    const model=JSON.parse(data.textContent!);assert.equal(model.schema,1);assert.equal(model.requestPath,route);assert.equal(model.status,status);
    assert.ok(root.innerHTML.length>0,route+" contains the rendered public presentation");
    assert.ok(document.querySelector(".public-site"),route+" public view");
    assert.doesNotMatch(root.textContent || "",/Loading WorldAct|Loading…/);
    assert.equal(document.querySelectorAll("#worldact-public-document").length,1);
    assert.ok(document.querySelector("style[data-worldact-public-gate]"));
  }else{
    const pathname=decodeURIComponent(new URL(route,base).pathname).toLowerCase();
    assert.match(pathname,/^\/(?:login|register|check-email|privacy|confirm-admin-email|confirm-profile-email|install|lost-password|reset-password|preview|admin|wp-admin)(?:\/|$)/);
    assert.equal(root.innerHTML,"");assert.equal(document.querySelector("style[data-worldact-public-gate]"),null);
  }
}

test("Node renders real public documents with actual identity status and preserves other HTTP handlers", async t => {
  const original = (await pool.query("SELECT data FROM settings WHERE id=1")).rows[0].data;
  const ids: number[] = [], terms: number[] = [], stamp = "http-status-" + Date.now();
  const index = await readFile(path.join(rootDir, "dist/index.html"), "utf8");
  let cookie = "";
  async function api(route: string, method = "GET", body?: unknown) {
    const response = await fetch(base + route, { method, headers: { Origin: origin, Cookie: cookie, "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
    const data = await response.json();
    assert.ok(response.ok, route + ": " + response.status + " " + JSON.stringify(data));
    return { response, data };
  }
  async function post(input: Record<string, unknown> = {}) {
    const p = (await api("/api/posts", "POST", { title: stamp + "-" + ids.length, status: "publish", content: "<p>STATUS-FIRST</p><!--nextpage--><p>STATUS-SECOND</p>", ...input })).data.post;
    ids.push(p.id); return p;
  }
  async function html(route: string, status = 200) {
    const response = await fetch(base + route);
    assert.equal(response.status, status, route);
    assert.match(response.headers.get("content-type")!, /text\/html/);
    assertPrivateDocument(response);
    assertRenderedDocument(await response.text(),route,status);
    assert.equal(response.headers.get("x-pingback"), null, "local servers never advertise ping reception");
    return response;
  }
  async function resolved(route: string, status = 200) {
    const response = await fetch(base + "/api/public/resolve?" + new URLSearchParams({ path: route }));
    assert.equal(response.status, status, route); return response.json();
  }
  try {
    const signed = await api("/api/auth/login", "POST", { login: process.env.ADMIN_EMAIL, password: process.env.ADMIN_PASSWORD });
    cookie = signed.response.headers.get("set-cookie")!.split(";")[0];
    await api("/api/settings", "PUT", { frontPageMode: "posts", frontPageId: null, postsPageId: null, timezone: "America/Los_Angeles", pingServices: [], closeCommentsDays: 0 });
    await t.test("empty ordinary first pages stay valid and empty later main pages return404", async () => {
      const published = (await pool.query("SELECT id FROM posts WHERE status='publish'")).rows.map(row => row.id);
      try {
        await pool.query("UPDATE posts SET status='draft' WHERE id=ANY($1::int[])", [published]);
        assert.equal((await pool.query("SELECT count(*)::int AS n FROM posts WHERE status='publish'")).rows[0].n, 0);
        for (const route of ["/", "/?search=absent", "/?category=absent&tag=absent", "/?author=2147483647"]) await html(route);
        for (const route of ["/?s=absent&page=999", "/?year=1901&monthnum=2&page=999", "/?page=999&query-3-page=6&commentPage=4"]) await html(route, 404);
      } finally { await pool.query("UPDATE posts SET status='publish' WHERE id=ANY($1::int[])", [published]); }
    });
    const story = await post({ pingStatus: "open", publishedAt: "2024-03-01T07:30:00Z" });
    const parent = await post({ type: "page" }), child = await post({ type: "page", parentId: parent.id });
    const locked = await post({ type: "page", password: "HTTP-status-private-password", content: "<p>HTTP-PRIVATE-BODY</p>" });
    const draft = await post({ status: "draft" }), privatePost = await post({ status: "private" });
    const future = await post({ status: "future", scheduledAt: new Date(Date.now() + 86400000).toISOString() });
    await t.test("HTML bootstraps remain private across anonymous, session and password contexts without changing authentication", async () => {
      // An anonymous bootstrap can later log in through React, so its HTTP
      // cache policy must already cover the eventual authenticated document.
      for (const context of [undefined, cookie, "worldact_session=expired", "worldact_post_" + locked.id + "=expired"]) {
        for (const route of ["/", "/login", "/admin/posts", "/preview/" + draft.id, "/?page_id=" + locked.id, "/missing-" + stamp]) {
          const response = await fetch(base + route, { headers: context ? { Cookie: context } : {} });
          assert.equal(response.status, route.startsWith("/missing-") ? 404 : 200);
          assertPrivateDocument(response);
          assertRenderedDocument(await response.text(),route,route.startsWith("/missing-") ? 404 : 200);
        }
      }
      const conditional = await fetch(base + "/", { headers: { "If-Modified-Since": new Date(Date.now() + 86400000).toUTCString() } });
      assert.equal(conditional.status, 200); assertPrivateDocument(conditional);
      assertRenderedDocument(await conditional.text(),"/");
      // Classifying HTML must not start application-password authentication or
      // update credential usage merely to choose cache headers.
      const basic = await fetch(base + "/", { headers: { Authorization: "Basic invalid" } });
      assert.equal(basic.status, 200); assertPrivateDocument(basic);
      assertRenderedDocument(await basic.text(),"/");
      const head = await fetch(base + "/", { method: "HEAD", headers: { Cookie: cookie } });
      assert.equal(head.status, 200); assertPrivateDocument(head); assert.equal(await head.text(), "");
      for (const route of ["/index.html", "/index%2Ehtml", "/%69ndex.html", "/INDEX.HTML"]) {
        const response = await fetch(base + route);
        assert.equal(response.status, 404, "a direct file opening retains the unknown public-route identity");
        assertPrivateDocument(response); assertRenderedDocument(await response.text(),route,404);
      }
      const asset = /src="([^"]+\.js)"/.exec(index)![1];
      const staticResponse = await fetch(base + asset, { headers: { Cookie: cookie } });
      assert.equal(staticResponse.status, 200);
      assert.doesNotMatch(staticResponse.headers.get("cache-control") || "", /no-store|private/);
      assert.ok(staticResponse.headers.get("last-modified"));
    });
    await t.test("all source presets, hierarchical pages, aliases, fixed IDs and clamped body pages keep public identity", async () => {
      for (const structure of ["", "/%year%/%monthnum%/%day%/%postname%/", "/%year%/%monthnum%/%postname%/", "/archives/%post_id%", "/%postname%/"]) {
        await api("/api/settings", "PUT", { permalinkStructure: structure });
        const canonical = await postPermalink(story), hierarchical = await postPermalink(child);
        for (const route of [canonical, hierarchical, "/?p=" + story.id, "/?page_id=" + child.id, "/posts/" + story.slug, "/POSTS/" + story.slug, "/pages/" + child.slug, "/pages/" + locked.slug]) await html(route);
        await html(canonical.includes("?") ? canonical + "&page=999" : canonical.replace(/\/?$/, "/") + "999/");
      }
      const body = await resolved("/?p=" + story.id + "&page=999&query-3-page=7&commentPage=4");
      assert.equal(body.post.id, story.id); assert.equal(body.post.contentPagination.page, 2);
      assert.match(body.post.content, /STATUS-SECOND/); assert.doesNotMatch(body.post.content, /STATUS-FIRST/);
      await html("/?page_id=" + locked.id); const metadata = await resolved("/?page_id=" + locked.id);
      assert.equal(metadata.post.locked, true); assert.doesNotMatch(JSON.stringify(metadata), /HTTP-PRIVATE-BODY|HTTP-status-private-password/);
      await api("/api/settings", "PUT", { frontPageMode: "page", frontPageId: parent.id, postsPageId: child.id });
      for (const route of ["/", "/?page=2&query-3-page=7", "/page/2/", "/?s=absent"]) await html(route);
      await html("/?year=1901&page=999", 404);
      await api("/api/settings", "PUT", { frontPageId: locked.id }); await html("/");
      await api("/api/settings", "PUT", { frontPageMode: "posts", frontPageId: null, postsPageId: null });
    });
    await t.test("selected static-front body paging requires the same actual public identity", async () => {
      await api("/api/settings", "PUT", { frontPageMode: "page", frontPageId: parent.id, postsPageId: child.id });
      try {
        await html("/?page=999"); assert.equal((await resolved("/?page=999")).post.contentPagination.page, 2);
        for (const status of ["private", "draft", "future"]) {
          await pool.query("UPDATE posts SET status=$1 WHERE id=$2", [status, parent.id]);
          for (const route of ["/", "/?page=2", "/?page=2&query-3-page=4&commentPage=2", "/page/2/"]) await html(route, 404);
          await html("/?search=absent&page=2", 404);
        }
        await pool.query("UPDATE settings SET data=jsonb_set(data,'{frontPageId}','2147483647'::jsonb) WHERE id=1");
        for (const route of ["/", "/?page=2", "/page/2/"]) await html(route, 404);
        await html("/?category=absent&page=2", 404);
      } finally {
        await pool.query("UPDATE posts SET status='publish' WHERE id=$1", [parent.id]);
        await api("/api/settings", "PUT", { frontPageMode: "posts", frontPageId: null, postsPageId: null });
      }
      await html("/?page=999&query-3-page=4&commentPage=2", 404);
    });
    await t.test("accepted category canonicals with more than 64 ancestors remain public within the URL bound", async () => {
      await api("/api/settings", "PUT", { permalinkStructure: "/%category%/%postname%/" });
      const slugs: string[] = []; let parentId: number | undefined;
      try {
        for (let depth = 0; depth < 66; depth++) {
          const slug = "h" + Date.now().toString(36) + "-" + depth.toString(36);
          const term = (await api("/api/terms", "POST", { taxonomy: "category", name: slug, slug, ...(parentId ? { parentId } : {}) })).data.term;
          terms.push(term.id); slugs.push(term.slug); parentId = term.id;
        }
        const deep = await post({ categoryIds: [parentId] });
        const canonical = "/" + slugs.join("/") + "/" + deep.slug + "/";
        assert.ok(canonical.length < 2000); assert.ok(canonical.split("/").filter(Boolean).length > 64);
        assert.equal(deep.permalink, canonical); assert.equal(await postPermalink(deep), canonical);
        await html(canonical); await html(canonical + "999/"); assert.equal((await resolved(canonical)).post.id, deep.id);
      } finally { await api("/api/settings", "PUT", { permalinkStructure: "/%postname%/" }); }
    });
    await t.test("missing, unpublished, wrong-type and malformed fixed identities return 404 HTML", async () => {
      for (const route of ["/?p=2147483647", "/?p=" + parent.id, "/?page_id=" + story.id,
        ...[draft, privatePost, future].flatMap(p => ["/?p=" + p.id, "/posts/" + p.slug, "/" + p.slug + "/"]),
        "/posts/missing-" + stamp, "/pages/" + story.slug, "/pages/missing-" + stamp,
        "/unknown/" + stamp + "/", "/author/" + stamp + "/",
        ...["p=0", "p=-1", "p=1.5", "p=2147483648", "p=9999999999999999999", "p[]=1", "p[x]=1", "p=1&p=2", "p=1&page_id=2", "page_id=bad", "p=" + story.id + "&page=0", "p=" + story.id + "&page[]=2", "p=" + story.id + "&page=2&page=3"].map(query => "/?" + query),
        "/wrong/?p=" + story.id]) await html(route, 404);
      const head = await fetch(base + "/missing-" + stamp, { method: "HEAD" });
      assert.equal(head.status, 404); assertPrivateDocument(head); assert.match(head.headers.get("content-type")!, /text\/html/); assert.equal(await head.text(), "");
    });
    await t.test("taxonomy and date archives share actual existence and local dates with the API resolver", async () => {
      await api("/api/settings", "PUT", { categoryBase: "topics", tagBase: "labels" });
      for (const taxonomy of ["category", "tag"]) {
        const term = (await api("/api/terms", "POST", { taxonomy, name: stamp + " " + taxonomy })).data.term; terms.push(term.id);
        const route = "/" + (taxonomy === "category" ? "topics" : "labels") + "/" + term.slug + "/";
        await html(route); assert.equal((await resolved(route)).archive.id, term.id);
        await html(route + "?page=999&query-8-page=4", 404);
        await html(route + "missing/", 404); await resolved(route + "missing/", 404);
        await html(route + "?p=bad", 404); await resolved(route + "?p=bad", 404);
      }
      for (const route of ["/2024/", "/2024/02/", "/2024/02/29/"]) { await html(route); assert.equal((await resolved(route)).archive.type, "date"); }
      for (const route of ["/1901/", "/2024/02/30/", "/2024/13/", "/0000/", "/topics/missing-" + stamp + "/"]) { await html(route, 404); await resolved(route, 404); }
    });
    await t.test("production headers describe singular open unprotected records, never home queries or archives", async () => {
      const directory = await mkdtemp(path.join(tmpdir(), "worldact-http-status-static-"));
      await writeFile(path.join(directory, "index.html"), index);
      try {
        await api("/api/posts/" + parent.id, "PUT", { pingStatus: "open" });
        await api("/api/posts/" + child.id, "PUT", { pingStatus: "open" });
        await api("/api/posts/" + locked.id, "PUT", { pingStatus: "open" });
        await api("/api/settings", "PUT", { frontPageMode: "page", frontPageId: parent.id, postsPageId: child.id });
        await withDocumentServer(directory, async url => {
          const settings = (await pool.query("SELECT data FROM settings WHERE id=1")).rows[0].data;
          const expected = new URL("/xmlrpc.php", settings.siteUrl || origin).href;
          for (const route of ["/", "/?page=2", "/?query-3-page=2&commentPage=4", await postPermalink(story), "/?p=" + story.id + "&page=2", "/posts/" + story.slug, "/pages/" + parent.slug]) {
            const response = await fetch(url + route); assert.equal(response.status, 200, route); assert.equal(response.headers.get("x-pingback"), expected, route);
          }
          for (const route of ["/?search=absent", "/?s=absent", "/?category=absent", "/?tag=absent", "/?author=2147483647", "/?year=1901", "/2024/02/29/", "/pages/" + child.slug, "/?page_id=" + locked.id, "/pages/" + locked.slug, "/missing-" + stamp]) {
            const response = await fetch(url + route); assert.equal(response.headers.get("x-pingback"), null, route);
          }
          await api("/api/settings", "PUT", { closeCommentsDays: 1 });
          assert.equal((await fetch(url + "/posts/" + story.slug)).headers.get("x-pingback"), null);
          assert.equal((await fetch(url + "/")).headers.get("x-pingback"), expected, "the age cutoff applies to posts, not pages");
          await api("/api/settings", "PUT", { frontPageMode: "posts", frontPageId: null, postsPageId: null });
          assert.equal((await fetch(url + "/?page=2")).headers.get("x-pingback"), null, "ordinary posts-home paging is not singular");
        }, "production");
      } finally {
        await api("/api/settings", "PUT", { frontPageMode: "posts", frontPageId: null, postsPageId: null, closeCommentsDays: 0 });
        await rm(directory, { recursive: true, force: true });
      }
    });
    await t.test("framework destinations, legacy redirects, JSON APIs, feeds and files retain their real handlers", async () => {
      for (const route of ["/login", "/LOGIN", "/%6Cogin", "/register", "/check-email", "/privacy/confirm?token=bad", "/confirm-admin-email?token=bad", "/confirm-profile-email?token=bad", "/install", "/lost-password", "/reset-password", "/preview/" + draft.id,
        "/admin", "/admin/posts", "/admin/posts/new", "/admin/posts/" + draft.id, "/admin/pages/new", "/admin/content/" + story.id,
        "/admin/posts/categories", "/admin/posts/tags", "/admin/pages", "/admin/media", "/admin/media/33", "/admin/users/33", "/admin/comments", "/admin/users", "/admin/profile", "/admin/settings", "/admin/settings/connectors", "/admin/appearance", "/admin/appearance/editor", "/admin/appearance/menus", "/admin/appearance/fonts", "/admin/plugins", "/admin/tools?tab=privacy-export", "/admin/about", "/wp-admin/deeper/legacy/path"]) await html(route);
      for (const [source, destination] of [["/wp-login.php?action=lostpassword", "/lost-password"], ["/wp-admin/font-library.php", "/admin/appearance/fonts"], ["/wp-admin/media-new.php", "/admin/media"], ["/wp-admin/options-connectors.php", "/admin/settings/connectors"]]) {
        const response = await fetch(base + source, { redirect: "manual" }); assert.equal(response.status, 302); assert.equal(new URL(response.headers.get("location")!, base).pathname, destination);
      }
      for (const route of ["/api/missing-" + stamp, "/wp-json/missing-" + stamp, "/wp-json/wp/v2/missing"]) {
        const response = await fetch(base + route); assert.equal(response.status, 404); assert.match(response.headers.get("content-type")!, /application\/json/); assert.doesNotMatch(await response.text(), /<!doctype|<script/i);
      }
      for (const route of ["/feed/", "/comments/feed/", "/sitemap.xml", "/robots.txt"]) {
        const response = await fetch(base + route); assert.equal(response.status, 200, route); assert.doesNotMatch(response.headers.get("content-type")!, /text\/html/); assert.notEqual(await response.text(), index);
      }
      const asset = /src="([^"]+\.js)"/.exec(index)![1], response = await fetch(base + asset);
      assert.equal(response.status, 200); assert.match(response.headers.get("content-type")!, /javascript/); assert.notEqual(await response.text(), index);
      const filename = stamp + ".txt"; await writeFile(path.join(uploadsDir, filename), "isolated static file");
      try { const upload = await fetch(base + "/uploads/" + filename); assert.equal(upload.status, 200); assert.equal(await upload.text(), "isolated static file"); }
      finally { await rm(path.join(uploadsDir, filename)); }
    });
    await t.test("malformed and oversized URLs have bounded errors and database failures stay generic 500s", async () => {
      for (const route of ["/%E0%A4%A", "/%ZZ", "/topics/%E0%A4%A/", "/?search=%ZZ", "/%00"]) {
        const response = await fetch(base + route); assert.equal(response.status, 400, route);
        assert.doesNotMatch(await response.text(), /URIError|stack|decodeURIComponent|node_modules|SELECT|Build the React/);
        await resolved(route, 400);
      }
      const long = await fetch(base + "/" + "x".repeat(2001)); assert.equal(long.status, 414); assert.doesNotMatch(await long.text(), /stack|node_modules/);
      // Metadata status remains body-independent, while full SSR genuinely
      // needs its body column and must preserve generic500 rather than a shell200.
      await pool.query("ALTER TABLE posts RENAME COLUMN content TO http_status_unavailable_content");
      try {
        for (const route of ["/?p=" + story.id, "/posts/" + story.slug, "/?page_id=" + locked.id, await postPermalink(child)]) {
          assert.equal((await publicDocumentIdentity(route)).status,200);
          const response=await fetch(base+route);assert.equal(response.status,500);
          assert.deepEqual(await response.json(),{error:"Something went wrong. Please try again."});
        }
      } finally { await pool.query("ALTER TABLE posts RENAME COLUMN http_status_unavailable_content TO content"); }
      await pool.query("ALTER TABLE posts RENAME TO http_status_unavailable_posts");
      try {
        const response = await fetch(base + "/?p=" + story.id); assert.equal(response.status, 500);
        assert.deepEqual(await response.json(), { error: "Something went wrong. Please try again." });
      } finally { await pool.query("ALTER TABLE http_status_unavailable_posts RENAME TO posts"); }
    });
  } finally {
    await pool.query("DELETE FROM posts WHERE id=ANY($1::int[])", [ids]);
    await pool.query("DELETE FROM terms WHERE id=ANY($1::int[])", [terms]);
    await pool.query("UPDATE settings SET data=$1::jsonb WHERE id=1", [JSON.stringify(original)]);
  }
});

async function withDocumentServer(directory: string, run: (url: string) => Promise<void>, environment = "local") {
  const entry = pathToFileURL(path.join(rootDir, process.env.ISOLATED_TEST_COMPILED === "true" ? "dist-server/index.js" : "server/index.ts")).href;
  const script = `const {app}=await import(${JSON.stringify(entry)});const server=app.listen(0,'127.0.0.1',()=>console.log('STATUS_FIXTURE_PORT:'+server.address().port));process.on('SIGTERM',()=>server.close(()=>process.exit(0)));`;
  // Importing the app does not start workers; production policy is exercised
  // against loopback HTTP only, with no external ping/SMTP/POP services.
  const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], { cwd: rootDir, env: { ...process.env, STATIC_DIR: directory, WORLDACT_ENVIRONMENT_TYPE: environment }, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  const ready = new Promise<number>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Isolated static fixture did not start.")), 10000);
    child.once("error", error => { clearTimeout(timer); reject(error); });
    child.once("exit", () => { clearTimeout(timer); reject(new Error("Isolated static fixture exited early.")); });
    child.stdout.on("data", data => { output = (output + data.toString()).slice(-10000); const match = /STATUS_FIXTURE_PORT:(\d+)/.exec(output); if (match) { clearTimeout(timer); resolve(Number(match[1])); } });
    child.stderr.on("data", () => {});
  });
  try {
    await run("http://127.0.0.1:" + await ready);
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      const stopped = new Promise<void>(resolve => child.once("exit", () => resolve()));
      child.kill("SIGTERM"); const timer = setTimeout(() => child.kill("SIGKILL"), 3000);
      await stopped; clearTimeout(timer);
    }
  }
}

test("missing index errors are separate from document classification on the actual Node server", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "worldact-http-status-static-"));
  try {
    await withDocumentServer(directory, async url => {
      const response = await fetch(url + "/"); assert.equal(response.status, 404);
      assert.deepEqual(await response.json(), { error: "Build the React application or use the development server." });
    });
  } finally { await rm(directory, { recursive: true, force: true }); }
});
