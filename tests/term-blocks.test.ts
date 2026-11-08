import test, { after } from "./isolated-test.js";
import "dotenv/config";
import assert from "node:assert/strict";
import { DOMParser } from "linkedom";
import { pool, postFields, defaultSettings } from "../server/db.js";
import { renderSiteDocument, SUPPORTED_DYNAMIC_BLOCKS } from "../server/block-renderer.js";
import { readTermQuery, TERM_BLOCKS } from "../server/term-blocks.js";
import { cleanContent } from "../server/utils.js";
const block = (name: string, attrs: Record<string, unknown> = {}, html = "") => `<!-- wp:${name} ${JSON.stringify(attrs)}${html ? " -->" + html + `<!-- /wp:${name} -->` : " /-->"}`;
const dom = (html: string) => new DOMParser().parseFromString(html, "text/html");
after(async () => { await pool.end(); });

test("term loops, inherited taxonomy context and breadcrumbs render actual source relationships safely", async t => {
  const db = await pool.connect(); await db.query("BEGIN");
  try {
    const user = (await db.query("SELECT id,display_name AS name FROM users WHERE role='administrator' ORDER BY id LIMIT 1")).rows[0], stamp = "term-block-" + Date.now().toString(36);
    await db.query("UPDATE settings SET data=data || $1::jsonb WHERE id=1", [JSON.stringify({ categoryBase: "sections", tagBase: "topics", frontPageMode: "posts", frontPageId: null, postsPageId: null })]);
    const terms: Record<string, any> = {}, posts: Record<string, any> = {};
    for (const [name, parent, taxonomy] of [["Root", null, "category"], ["Child", "Root", "category"], ["Grandchild", "Child", "category"], ["Empty", "Root", "category"], ["Other", null, "category"], ["TagAlpha", null, "tag"], ["TagBeta", null, "tag"]] as const) terms[name] = (await db.query("INSERT INTO terms(taxonomy,name,slug,parent_id,description) VALUES($1,$2,$3,$4,$5) RETURNING id,name,slug,taxonomy", [taxonomy, stamp + " " + name, stamp + "-" + name.toLowerCase(), parent ? terms[parent].id : null, `<p>${name} description <strong>safe</strong><script>bad()</script></p>`])).rows[0];
    for (const [name, type, status, parent] of [["Post", "post", "publish", null], ["Parent", "page", "publish", null], ["ChildPage", "page", "publish", "Parent"], ["Private", "page", "private", null], ["PrivateAncestorChild", "page", "publish", "Private"], ["Draft", "post", "draft", null]] as const) {
      const id = (await db.query("INSERT INTO posts(type,status,title,slug,author_id,parent_id,published_at) VALUES($1,$2,$3,$4,$5,$6,now()) RETURNING id", [type, status, stamp + " " + name, stamp + "-" + name.toLowerCase(), user.id, parent ? posts[parent].id : null])).rows[0].id;
      posts[name] = (await db.query(`SELECT ${postFields} FROM posts p JOIN users u ON u.id=p.author_id WHERE p.id=$1`, [id])).rows[0];
    }
    await db.query("INSERT INTO post_terms(post_id,term_id) VALUES($1,$3),($1,$4),($1,$5),($1,$6),($2,$7)", [posts.Post.id, posts.Draft.id, terms.Child.id, terms.Grandchild.id, terms.Other.id, terms.TagAlpha.id, terms.Empty.id]);
    posts.Post = (await db.query(`SELECT ${postFields} FROM posts p JOIN users u ON u.id=p.author_id WHERE p.id=$1`, [posts.Post.id])).rows[0];
    const render = (rawContent: string, extra: Record<string, unknown> = {}) => renderSiteDocument({ rawContent }, { db, post: posts.Post, requestPath: "/article/", ...extra });
    const names = block("term-name", { isLink: true }), counts = block("term-count", { bracketType: "angle" }), description = block("term-description");

    await t.test("hierarchical hideEmpty retains a zero-count ancestor while omitting empty branches", async () => {
      const result = await readTermQuery(db, { taxonomy: "category", parent: 0, hideEmpty: true, perPage: 100 });
      assert.ok(result.terms.some(row => row.id === terms.Root.id && row.count === 0));
      const raw = await render(block("terms-query", { termQuery: { taxonomy: "category", hideEmpty: true, include: [terms.Root.id, terms.Other.id] } }, block("term-template", {}, names + counts + description)));
      assert.equal(dom(raw).querySelectorAll("li.wp-block-term").length, 2);
      assert.ok(dom(raw).querySelector(`a[href="/sections/${terms.Root.slug}/"]`));
      assert.match(raw, /&lt;0&gt;/); assert.match(raw, /<strong>safe<\/strong>/); assert.doesNotMatch(raw, /<script|bad\(\)/);
      assert.equal(dom(raw).querySelector(".wp-block-term-name")!.tagName, "P");
    });
    await t.test("include order, counts and inherited children match the source term query", async () => {
      const input = [terms.Other.id, terms.Grandchild.id, terms.Child.id];
      const raw = await render(block("terms-query", { termQuery: { taxonomy: "category", include: input, hideEmpty: false } }, block("term-template", {}, block("term-name", { level: 3 }) + counts)));
      assert.deepEqual([...dom(raw).querySelectorAll("li.wp-block-term")].map(item => Number(/term-(\d+)/.exec(item.className)![1])), input);
      assert.equal(dom(raw).querySelectorAll("h3").length, 3);
      const direct = dom(await render(block("terms-query", { termQuery: { inherit: true, showNested: false, hideEmpty: true, include: [terms.Other.id] } }, block("term-template", {}, names)), { query: { category: terms.Root.slug } }));
      assert.equal(direct.querySelectorAll("li").length, 1); assert.match(direct.toString(), new RegExp(terms.Child.name)); assert.doesNotMatch(direct.toString(), /Grandchild|Empty/);
      const nested = dom(await render(block("terms-query", { termQuery: { inherit: true, showNested: true, hideEmpty: true } }, block("term-template", {}, names)), { query: { category: terms.Root.slug } }));
      assert.equal(nested.querySelectorAll("li").length, 2);
      const allTags = await render(block("terms-query", { termQuery: { inherit: true, hideEmpty: false } }, block("term-template", {}, names)), { query: { tag: terms.TagAlpha.slug } });
      assert.match(allTags, /TagAlpha/); assert.match(allTags, /TagBeta/);
    });
    await t.test("nested term loops restore outer context and archive fallbacks remain independent", async () => {
      const inner = block("terms-query", { termQuery: { taxonomy: "post_tag", include: [terms.TagAlpha.id], hideEmpty: false } }, block("term-template", {}, names));
      const raw = await render(block("terms-query", { termQuery: { taxonomy: "category", include: [terms.Root.id], hideEmpty: false } }, block("term-template", {}, names + inner + names)));
      const labels = [...dom(raw).querySelectorAll(".wp-block-term-name")].map(item => item.textContent);
      assert.deepEqual(labels, [terms.Root.name, terms.TagAlpha.name, terms.Root.name]);
      const archive = await render(names + counts + description, { query: { category: terms.Child.slug } }); assert.match(archive, /Child description/); assert.match(archive, /&lt;1&gt;/);
      assert.equal(dom(await render(block("term-count"),{query:{category:terms.Child.slug}})).querySelector(".wp-block-term-count")?.textContent,"(1)");
      assert.equal(dom(await render(block("term-count",{bracketType:"none"}),{query:{category:terms.Child.slug}})).querySelector(".wp-block-term-count")?.textContent,"1");
      assert.equal(await render(names + counts, { post: null }), "");
      const malformed = await render(block("terms-query", { termQuery: { taxonomy: "users; DROP TABLE posts" } }, block("term-template", {}, names))); assert.doesNotMatch(malformed, /wp-block-term-name/);
    });
    await t.test("breadcrumbs use published page ancestors, real taxonomy trails and safe custom separators", async () => {
      const raw = await render(block("breadcrumbs", { separator: ">" }), { post: posts.ChildPage, requestPath: "/parent/child/" }), parsed = dom(raw);
      assert.deepEqual([...parsed.querySelectorAll("li")].map(item => item.textContent), ["Home", posts.Parent.title, posts.ChildPage.title]);
      assert.equal(parsed.querySelector('[aria-current=page]')!.textContent, posts.ChildPage.title);
      assert.equal(parsed.querySelector("nav")!.style.getPropertyValue("--separator"), '\">\"');
      assert.match(parsed.querySelectorAll("a")[1].getAttribute("href")!, new RegExp(posts.Parent.slug));
      const tax = dom(await render(block("breadcrumbs"))); assert.deepEqual([...tax.querySelectorAll("li")].map(item => item.textContent), ["Home", terms.Root.name, terms.Child.name, posts.Post.title]);
      const guarded = await render(block("breadcrumbs"), { post: posts.PrivateAncestorChild, requestPath: "/public-child/" }); assert.ok(![...dom(guarded).querySelectorAll("li")].some(item=>item.textContent===posts.Private.title));
      const hostile = dom(await render(block("breadcrumbs", { separator: '\";position:fixed;--bad:yes;/*' })));
      assert.equal(hostile.querySelector("nav")!.style.getPropertyValue("position"), ""); assert.equal(hostile.querySelector("nav")!.style.getPropertyValue("--bad"), "");
      assert.equal(dom(cleanContent('<nav style=\'--separator:"\\\\bad";--other:"x"\'>safe</nav>', true)).querySelector("nav")!.getAttribute("style"), null);
      await db.query("UPDATE terms SET parent_id=$2 WHERE id=$1",[terms.Root.id,terms.Grandchild.id]);
      const cycle=await render(block("breadcrumbs"),{post:null,query:{category:terms.Grandchild.slug}});
      assert.ok(cycle.length<10000);assert.equal(dom(cycle).querySelectorAll("li").length,4);
      assert.ok((await readTermQuery(db,{taxonomy:"category",hideEmpty:true,include:[terms.Root.id],perPage:100})).terms.length===1);
      await db.query("UPDATE terms SET parent_id=NULL WHERE id=$1",[terms.Root.id]);
      await db.query("UPDATE posts SET parent_id=$2 WHERE id=$1",[posts.Parent.id,posts.ChildPage.id]);
      assert.ok((await render(block("breadcrumbs"),{post:posts.ChildPage,requestPath:"/cycle/"})).length<10000);
      await db.query("UPDATE posts SET parent_id=NULL WHERE id=$1",[posts.Parent.id]);
    });
    await t.test("home/search/date/author/404 pagination breadcrumbs have source current-item semantics", async () => {
      assert.equal(await render(block("breadcrumbs"), { post: null, requestPath: "/" }), "");
      assert.equal(dom(await render(block("breadcrumbs", { showOnHomePage: true }), { post: null, requestPath: "/" })).querySelector('[aria-current=page]')!.textContent, "Home");
      const search = await render(block("breadcrumbs"), { post: null, query: { search: '<script>Search & words</script>', page: "2" } }); assert.match(search, /Page 2/); assert.doesNotMatch(search, /<script>/); assert.equal(dom(search).querySelector('[aria-current=page]')!.textContent, "Page 2");
      const longSearch=dom(await render(block("breadcrumbs"),{post:null,query:{search:"one two three four five six seven eight nine ten eleven"}}));
      assert.equal(longSearch.querySelector("li:last-child")!.textContent,'Search results for: "one two three four five six seven eight nine ten…"');
      const date = dom(await render(block("breadcrumbs"), { post: null, requestPath: "/2024/02/29/", query: { year: "2024", month: "2", day: "29" } }));
      assert.deepEqual([...date.querySelectorAll("li")].map(item => item.textContent), ["Home", "2024", "February", "29"]); assert.ok(date.querySelector('a[href="/2024/02/"]'));
      const taxonomy = dom(await render(block("breadcrumbs"), { post: null, query: { category: terms.Grandchild.slug, page: "2" } })); assert.deepEqual([...taxonomy.querySelectorAll("li")].map(item => item.textContent), ["Home", terms.Root.name, terms.Child.name, terms.Grandchild.name, "Page 2"]);
      const author = await render(block("breadcrumbs"), { post: null, query: { author: String(user.id) } }); assert.match(author, new RegExp(user.name)); assert.doesNotMatch(author, /@/);
      assert.match(await render(block("breadcrumbs"), { post: null, templateSlug: "404" }), /Page not found/);
      assert.match(await render(block("breadcrumbs"), { query: { commentPage: "3" } }), /Comments Page 3/);
      const omitted = dom(await render(block("breadcrumbs", { showHomeItem: false, showCurrentItem: false }))); assert.deepEqual([...omitted.querySelectorAll("li")].map(item => item.textContent), [terms.Root.name, terms.Child.name]);
      await db.query("UPDATE settings SET data=data || $1::jsonb WHERE id=1",[JSON.stringify({frontPageMode:"page",frontPageId:posts.Parent.id,postsPageId:posts.ChildPage.id})]);
      const index=dom(await render(block("breadcrumbs"),{post:posts.ChildPage,requestPath:"/blog/",templateSlug:"home"}));
      assert.deepEqual([...index.querySelectorAll("li")].map(item=>item.textContent),["Home",posts.ChildPage.title]);
      const front=dom(await render(block("breadcrumbs",{showOnHomePage:true}),{post:posts.Parent,requestPath:"/",templateSlug:"front-page"}));
      assert.deepEqual([...front.querySelectorAll("li")].map(item=>item.textContent),["Home"]);
      const single=dom(await render(block("breadcrumbs")));
      assert.deepEqual([...single.querySelectorAll("li")].map(item=>item.textContent),["Home",posts.ChildPage.title,terms.Root.name,terms.Child.name,posts.Post.title]);
      await db.query("UPDATE settings SET data=data || '{\"frontPageMode\":\"posts\",\"frontPageId\":null,\"postsPageId\":null}'::jsonb WHERE id=1");
    });
    await t.test("page-list-item preserves canonical wrappers and supplies safe JSON fallbacks", async () => {
      const hierarchy=dom(await render(block("page-list")));
      const parent=hierarchy.querySelector(`a[href="${posts.Parent.permalink || '/'+posts.Parent.slug+'/'}"]`) || [...hierarchy.querySelectorAll("summary a")].find(link=>link.textContent===posts.Parent.title);
      assert.ok(parent,"Hierarchical parent pages must retain their own navigation link.");assert.equal(parent.closest("summary")?.tagName,"SUMMARY");
      const canonical = block("page-list-item", {}, '<li class="kept"><a href="/kept/">Kept</a>'+block("term-name")+'</li>');
      const preserved = await render(canonical, { query: { tag: terms.TagAlpha.slug } }); assert.match(preserved, /class="kept"/); assert.match(preserved, /TagAlpha/);
      const json = [{ name: "core/page-list-item", attributes: { id: posts.ChildPage.id, label: "Safe <script>label</script>" }, innerBlocks: [{ name: "core/page-list-item", attributes: { link: "/second/", title: "Second" }, innerBlocks: [] }] }];
      const html = await renderSiteDocument({ blocks: json }, { db }); assert.match(html, new RegExp(posts.Parent.slug)); assert.match(html, /\/second\//); assert.doesNotMatch(html, /<script>/);
      assert.equal(await renderSiteDocument({ blocks: [{ name: "core/page-list-item", attributes: { id: posts.Private.id }, innerBlocks: [] }] }, { db }), "");
      assert.equal(await renderSiteDocument({ blocks: [{ name: "core/page-list-item", attributes: { link: "javascript:alert(1)" }, innerBlocks: [] }] }, { db }), "");
    });
    for (const name of TERM_BLOCKS) assert.ok(SUPPORTED_DYNAMIC_BLOCKS.has(name));
  } finally { await db.query("ROLLBACK"); db.release(); }
});

const base = process.env.TEST_API_URL || "http://127.0.0.1:3001", origin = process.env.APP_ORIGIN || "http://127.0.0.1:5173";
test("native taxonomy REST parent, ordering, include and post filters match server term loops", async () => {
  let cookie = ""; const terms: number[] = [], posts: number[] = [], stamp = "term-rest-" + Date.now().toString(36);
  const api = async (route: string, method = "GET", body?: unknown, auth = cookie) => { const response = await fetch(base + route, { method, headers: { Origin: origin, "Content-Type": "application/json", Cookie: auth }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }); return { response, data: await response.json() }; };
  const ok = async (route: string, method = "GET", body?: unknown, auth = cookie) => { const result = await api(route, method, body, auth); assert.ok(result.response.ok, `${route}: ${result.response.status} ${JSON.stringify(result.data)}`); return result; };
  try {
    const signed = await ok("/api/auth/login", "POST", { login: process.env.ADMIN_EMAIL, password: process.env.ADMIN_PASSWORD }, ""); cookie = signed.response.headers.get("set-cookie")!.split(";")[0];
    let parentId: number | undefined;
    for (const name of ["Root", "Child", "Grandchild"]) { const term = (await ok("/api/terms", "POST", { taxonomy: "category", name: stamp + " " + name, ...(parentId ? { parentId } : {}) })).data.term; terms.push(term.id); parentId = term.id; }
    const post = (await ok("/api/posts", "POST", { title: stamp, status: "publish", categoryIds: [terms[1]] })).data.post; posts.push(post.id);
    const draft = (await ok("/api/posts", "POST", { title: stamp + " draft", status: "draft", categoryIds: [terms[2]] })).data.post; posts.push(draft.id);
    const ids = terms.join(",");
    const roots = await ok(`/wp-json/wp/v2/categories?include=${ids}&parent=0&hide_empty=true`); assert.deepEqual(roots.data.map((row: any) => row.id), [terms[0]]); assert.equal(roots.data[0].count, 0);
    const direct = await ok(`/wp-json/wp/v2/categories?include=${ids}&parent=${terms[0]}&hide_empty=false`); assert.deepEqual(direct.data.map((row: any) => row.id), [terms[1]]);
    const order = [terms[2], terms[0], terms[1]], ordered = await ok(`/wp-json/wp/v2/categories?include=${order.join(",")}&orderby=include&order=asc&per_page=2`);
    assert.deepEqual(ordered.data.map((row: any) => row.id), order.slice(0, 2)); assert.equal(ordered.response.headers.get("X-WP-Total"), "3"); assert.match(ordered.response.headers.get("Link")!, /page=2/);
    const next = await ok(`/wp-json/wp/v2/categories?include=${order.join(",")}&orderby=include&order=asc&per_page=2&page=2`); assert.deepEqual(next.data.map((row: any) => row.id), order.slice(2));
    assert.equal((await ok(`/wp-json/wp/v2/categories?include=${ids}&orderby=count&order=desc`)).data[0].id, terms[1]);
    assert.deepEqual((await ok(`/wp-json/wp/v2/categories?include=${ids}&post=${post.id}`, "GET", undefined, "")).data.map((row: any) => row.id), [terms[1]]);
    assert.equal((await api(`/wp-json/wp/v2/categories?post=${draft.id}`, "GET", undefined, "")).response.status, 404);
    assert.deepEqual((await ok(`/wp-json/wp/v2/categories?include=${ids}&post=${draft.id}`)).data.map((row: any) => row.id), [terms[2]]);
    const slugOrder = [roots.data[0].slug, direct.data[0].slug].reverse();
    assert.deepEqual((await ok(`/wp-json/wp/v2/categories?slug=${slugOrder.join(",")}&orderby=include_slugs`)).data.map((row: any) => row.slug), slugOrder);
    for (const query of ["parent=-1", "orderby=DROP", "order=DROP", "hide_empty=unknown"]) assert.equal((await api("/wp-json/wp/v2/categories?" + query)).response.status, 400);
    const metadata = (await ok("/wp-json/wp/v2/block-types")).data; for (const name of TERM_BLOCKS) assert.ok(metadata.some((item: any) => item.name === name));
    const preview = await ok(`/wp-json/wp/v2/block-renderer/core/term-name?attributes=${encodeURIComponent(JSON.stringify({ level: 2 }))}`); assert.equal(preview.data.rendered, "");
    const breadcrumb = dom((await ok(`/wp-json/wp/v2/block-renderer/core/breadcrumbs?post_id=${post.id}`)).data.rendered);
    assert.equal(breadcrumb.querySelector("li:last-child")?.textContent,post.title);
    assert.ok(breadcrumb.querySelector('a[href="/"]'));
    const loginout = dom((await ok(`/wp-json/wp/v2/block-renderer/core/loginout?post_id=${post.id}`)).data.rendered);
    assert.ok(loginout.querySelector(".logged-in")); assert.equal(loginout.querySelector("form")?.getAttribute("action"),"/logout");
    const searchBreadcrumb = dom((await ok("/wp-json/wp/v2/block-renderer/core/breadcrumbs?search=Native%20search")).data.rendered);
    assert.match(searchBreadcrumb.querySelector("li:last-child")?.textContent || "",/Native search/);
  } finally {
    for (const id of posts) { await api(`/api/posts/${id}`, "PUT", { status: "trash" }); await api(`/api/posts/${id}`, "DELETE"); }
    for (const id of terms.reverse()) await api(`/api/terms/${id}`, "DELETE");
    if (cookie) await api("/api/auth/logout", "POST", {});
  }
});

test("term loops share renderer byte/query budgets", async () => {
  let queries = 0;
  const db = { query: async (sql: string) => {
    queries++;
    if (sql.includes("FROM settings")) return { rows: [{ data: defaultSettings }] };
    if (sql.startsWith("SELECT count(*)::int AS total FROM terms")) return { rows: [{ total: 40 }] };
    if (sql.startsWith("SELECT t.id")) return { rows: Array.from({ length: 40 }, (_, index) => ({ id: index + 10, taxonomy: "category", name: "Large", slug: "large", count: 1, description: "<p>" + "a".repeat(256 * 1024) + "</p>", parentId: null })) };
    throw new Error("Unexpected term query");
  } };
  const content = block("terms-query", { termQuery: { taxonomy: "category", perPage: 100 } }, block("term-template", {}, block("term-description")));
  await assert.rejects(renderSiteDocument({ rawContent: content }, { db: db as any }), /8 MiB/); assert.equal(queries, 3);
});
