import "dotenv/config";
import assert from "node:assert/strict";
import test, { after } from "node:test";
import { DOMParser } from "linkedom";
import { pool, postFields, defaultSettings } from "../server/db.js";
import { renderSiteDocument, SUPPORTED_DYNAMIC_BLOCKS } from "../server/block-renderer.js";
import { countReadingWords, readingTimeText, WIDGET_BLOCKS } from "../server/widget-blocks.js";
const block = (name: string, attrs: Record<string, unknown> = {}, content = "") => `<!-- wp:${name} ${JSON.stringify(attrs)}${content ? " -->" + content + `<!-- /wp:${name} -->` : " /-->"}`;
const dom = (html: string) => new DOMParser().parseFromString(html, "text/html");
after(async () => { await pool.end(); });

test("reading time matches source word counting and bounded speed/range controls", () => {
  assert.equal(countReadingWords(""), 0);
  assert.equal(countReadingWords("<p>One&nbsp;two—three</p><!-- invisible words -->four &amp; five"), 5);
  assert.equal(countReadingWords("<p>123! one--two</p>"), 2);
  assert.equal(readingTimeText("word ".repeat(189), { displayAsRange: false }), "1 minute");
  assert.equal(readingTimeText("word ".repeat(378), { displayAsRange: false }), "2 minutes");
  assert.equal(readingTimeText("", {}), "1–2 minutes");
  assert.equal(readingTimeText("word ".repeat(1000), { displayMode: "words" }), "1,000 words");
  assert.equal(readingTimeText("word ".repeat(189), { averageReadingSpeed: 0 }), "151–227 minutes");
  assert.equal(readingTimeText("word", { displayMode: "<script>" }), "");
  for (const name of WIDGET_BLOCKS) assert.equal(SUPPORTED_DYNAMIC_BLOCKS.has(name), true);
});

test("nine source widgets render live editorial data with local archives, safe metadata and shared query context", async t => {
  const db = await pool.connect(); await db.query("BEGIN");
  try {
    const admin = (await db.query("SELECT id,display_name AS name FROM users WHERE role='administrator' ORDER BY id LIMIT 1")).rows[0];
    const stamp = "widget-" + Date.now().toString(36), posts: any[] = [], terms: any[] = [];
    await db.query("UPDATE settings SET data=data || $1::jsonb WHERE id=1", [JSON.stringify({ timezone: "+05:30", dateFormat: "F j, Y", weekStartsOn: 1, showAvatars: true, defaultAvatar: "identicon", avatarRating: "PG", closeCommentsDays: 0, permalinkStructure: "/%year%/%monthnum%/%postname%/" })]);
    for (const [label, status, date, password] of [
      ["old", "publish", "2023-12-31T19:00:00Z", null], // Local January 1.
      ["new", "publish", "2024-02-29T17:00:00Z", null],
      ["protected", "publish", "2024-02-28T18:00:00Z", "fixture-password-hash"],
      ["draft", "draft", "2024-02-27T00:00:00Z", null],
      ["private", "private", "2024-02-27T00:00:00Z", null],
      ["scheduled", "future", "2099-02-01T00:00:00Z", null],
    ] as const) {
      const row = (await db.query("INSERT INTO posts(type,title,slug,status,author_id,published_at,content,raw_content,excerpt,password_hash,comment_status) VALUES('post',$1,$2,$3,$4,$5,$6,$6,$7,$8,'open') RETURNING id", [stamp + " " + label, stamp + "-" + label, status, admin.id, date, password ? "<p>CONFIDENTIAL-PASSWORD-BODY</p>" : `<p>${label} body ${"word ".repeat(60)}</p>`, password ? "CONFIDENTIAL-EXCERPT" : "", password])).rows[0];
      posts.push((await db.query(`SELECT ${postFields} FROM posts p JOIN users u ON u.id=p.author_id WHERE p.id=$1`, [row.id])).rows[0]);
    }
    for (const name of ["Alpha", "Beta", "Empty"]) terms.push((await db.query("INSERT INTO terms(taxonomy,name,slug) VALUES('tag',$1,$2) RETURNING *", [stamp + " " + name, stamp + "-" + name.toLowerCase()])).rows[0]);
    await db.query("INSERT INTO post_terms(post_id,term_id) VALUES($1,$3),($2,$3),($1,$4)", [posts[0].id, posts[1].id, terms[0].id, terms[1].id]);
    const category = (await db.query("INSERT INTO terms(taxonomy,name,slug) VALUES('category',$1,$1) RETURNING id", [stamp])).rows[0];
    await db.query("INSERT INTO post_terms(post_id,term_id) VALUES($1,$2)", [posts[1].id, category.id]);
    const comments: any[] = [];
    for (const [post, status, author, content] of [[posts[0], "approved", "First visitor", "<p>Safe first comment</p>"], [posts[0], "approved", "Second visitor", "<p>Safe second comment</p>"], [posts[1], "pending", "PENDING-AUTHOR", "PENDING-CONTENT"], [posts[2], "approved", "Protected visitor", "CONFIDENTIAL-COMMENT"], [posts[3], "approved", "DRAFT-AUTHOR", "DRAFT-COMMENT"], [posts[4], "approved", "PRIVATE-AUTHOR", "PRIVATE-COMMENT"]] as const) comments.push((await db.query("INSERT INTO comments(post_id,author_name,author_email,author_url,content,status,created_at) VALUES($1,$2,'private-email@example.test','javascript:alert(1)',$3,$4,now()+($5::int * interval '1 second')) RETURNING id", [post.id, author, content, status, comments.length])).rows[0]);
    const render = (rawContent: string, extra: Record<string, unknown> = {}) => renderSiteDocument({ rawContent }, { db, post: posts[0], requestPath: "/2024/02/", ...extra });

    await t.test("Latest Posts ignores sticky ranking, filters categories/authors and masks protected text", async () => {
      await db.query("UPDATE posts SET sticky=true WHERE id=$1", [posts[0].id]);
      const raw = await render(block("latest-posts", { postsToShow: 100, selectedAuthor: admin.id, displayPostContent: true, displayAuthor: true, displayPostDate: true, postLayout: "grid", columns: 2 }));
      const parsed = dom(raw), list = parsed.querySelector("ul.wp-block-latest-posts")!;
      assert.ok(list.classList.contains("is-grid")); assert.ok(list.classList.contains("columns-2"));
      const titles = [...list.querySelectorAll(".wp-block-latest-posts__post-title")].map(item => item.textContent);
      assert.ok(titles.indexOf(stamp + " new") < titles.indexOf(stamp + " old"));
      assert.match(raw, /This content is password protected/); assert.doesNotMatch(raw, /CONFIDENTIAL|widget-[^<>]* (?:draft|private|scheduled)/);
      assert.ok(parsed.querySelector(`a[href="/2024/01/${stamp}-old/"]`));
      assert.match(raw, /Read more/); assert.match(raw, /by /);
      const filtered = dom(await render(block("latest-posts", { categories: [{ id: category.id }], postsToShow: 100 })));
      assert.equal(filtered.querySelectorAll("li").length, 1); assert.match(filtered.toString(), new RegExp(stamp + " new"));
      assert.equal(dom(await render(block("latest-posts", { selectedAuthor: 2147483647 }))).querySelectorAll("li").length, 0);
      const combined = await render(block("latest-posts", { categories: [{ id: category.id }] }) + block("latest-posts", { categories: [{ id: category.id }], displayPostContent: true, displayPostContentRadio: "full_post" }));
      assert.match(combined, /new body/, "A title-only widget must not poison the full-content widget cache.");
      await db.query("UPDATE posts SET excerpt=$2 WHERE id=$1", [posts[1].id,"manual ".repeat(100).trim()]);
      const manual=dom(await render(block("latest-posts",{categories:[{id:category.id}],displayPostContent:true,excerptLength:10})));
      assert.equal(manual.querySelector(".wp-block-latest-posts__post-excerpt")!.textContent!.trim().split(/\s+/).length,100);
      assert.equal(manual.querySelector(".wp-block-latest-posts__read-more"),null);
      await db.query("UPDATE posts SET excerpt='' WHERE id=$1",[posts[1].id]);
      const full = await render(block("latest-posts", { postsToShow: 100, displayPostContent: true, displayPostContentRadio: "full_post" }));
      assert.doesNotMatch(full, /CONFIDENTIAL/); assert.match(full, /new body/);
    });
    await t.test("Latest Comments respects approval, protected bodies, avatar settings and legacy excerpt controls", async () => {
      const raw = await render(block("latest-comments", { commentsToShow: 100, displayContent: "full" }));
      assert.match(raw, /Safe first comment/); assert.match(raw, /Password protected/);
      assert.doesNotMatch(raw, /private-email@|CONFIDENTIAL|PENDING-|DRAFT-|PRIVATE-|javascript:/);
      for (const item of [comments[0], comments[1], comments[3]]) assert.ok(dom(raw).querySelector(`a[href$="#comment-${item.id}"]`));
      assert.match(raw, /secure\.gravatar\.com/); assert.match(raw, /r=pg/);
      const hidden = await render(block("latest-comments", { displayExcerpt: false, displayContent: "full", displayAvatar: false, displayDate: false }));
      assert.doesNotMatch(hidden, /comment-excerpt|<img|<time/);
      await db.query("UPDATE settings SET data=data || '{\"permalinkStructure\":\"/%category%/%postname%/\"}'::jsonb WHERE id=1");
      await db.query("INSERT INTO post_terms(post_id,term_id) VALUES($1,$2)", [posts[0].id, category.id]);
      const canonical = (await db.query(`SELECT ${postFields} FROM posts p JOIN users u ON u.id=p.author_id WHERE p.id=$1`, [posts[0].id])).rows[0];
      const { postPermalink } = await import("../server/permalinks.js");
      const actual = await postPermalink(canonical, undefined, db);
      assert.ok(dom(await render(block("latest-comments"))).querySelector(`a[href="${actual}#comment-${comments[0].id}"]`));
      await db.query("UPDATE settings SET data=data || '{\"showAvatars\":false,\"permalinkStructure\":\"/%year%/%monthnum%/%postname%/\"}'::jsonb WHERE id=1");
      assert.doesNotMatch(await render(block("latest-comments")), /<img/);
      await db.query("UPDATE comments SET content=$2 WHERE id=$1",[comments[0].id,"word ".repeat(25)]);
      const truncated=dom(await render(block("latest-comments")));
      assert.match(truncated.querySelector(`a[href$="#comment-${comments[0].id}"]`)!.closest("li")!.querySelector(".wp-block-latest-comments__comment-excerpt")!.textContent!,/…$/);
      await db.query("UPDATE comments SET content=$2 WHERE id=$1",[comments[0].id,"Plain line one\nline two\n\nSecond paragraph"]);
      const plain=dom(await render(block("latest-comments",{displayContent:"full"}))).querySelector(`a[href$="#comment-${comments[0].id}"]`)!.closest("li")!.querySelector(".wp-block-latest-comments__comment-excerpt")!;
      assert.equal(plain.querySelectorAll("p").length,2); assert.equal(plain.querySelectorAll("br").length,1);
      await db.query("UPDATE comments SET content='<p>Rich <strong>body</strong></p>' WHERE id=$1",[comments[0].id]);
      const rich=dom(await render(block("latest-comments",{displayContent:"full"}))).querySelector(`a[href$="#comment-${comments[0].id}"]`)!.closest("li")!.querySelector(".wp-block-latest-comments__comment-excerpt")!;
      assert.equal(rich.querySelectorAll("p").length,1);assert.equal(rich.querySelector("strong")!.textContent,"body");
    });
    await t.test("Archives use publication civil dates, source grouping types and real dropdown destinations", async () => {
      const monthly = await render(block("archives", { showPostCounts: true }));
      assert.match(monthly, /January 2024 \(1\)/); assert.match(monthly, /February 2024 \(2\)/); assert.match(monthly, /href="\/2024\/01\/"/);
      for (const type of ["yearly", "daily", "weekly", "alpha", "postbypost"]) {
        const html = await render(block("archives", { type, displayAsDropdown: true, showLabel: false, showPostCounts: true }));
        const select = dom(html).querySelector("select[name=archive-dropdown]")!; assert.ok(select); assert.ok(select.querySelectorAll("option").length > 1);
        if (type === "weekly") assert.match(html, /\/?m=2024&amp;w=/);
        if (type === "daily") assert.match(html, /2024\/02\/29\//);
        assert.doesNotMatch(html, /CONFIDENTIAL|javascript|<script/);
      }
    });
    await t.test("Calendar uses leap days, configured week start, local dates and populated neighbouring months", async () => {
      const html = await render(block("calendar", { year: 2024, month: 2 })), parsed = dom(html);
      assert.equal(parsed.querySelector("caption")!.textContent, "February 2024");
      assert.equal(parsed.querySelector("th")!.getAttribute("aria-label"), "Monday");
      assert.ok(parsed.querySelector('a[href="/2024/02/29/"]')); assert.ok(parsed.querySelector('a[href="/2024/01/"]'));
      assert.equal(parsed.querySelector('a[href="/2024/02/29/"]')!.getAttribute("aria-label"),"Posts published on February 29, 2024");
      assert.equal(parsed.querySelectorAll("tbody td").length > 28, true);
      const january = await render(block("calendar"), { query: { year: "2024", month: "1" } });
      assert.match(january, /href="\/2024\/01\/01\/"/); assert.match(january, /January 2024/);
      assert.match(await render(block("calendar"), { query: { m: "2024", w: "5" } }), /February 2024/);
      assert.match(await render(block("calendar"), { query: { m: "2024", w: "0" } }), /January 2024/);
      assert.doesNotMatch(html, /CONFIDENTIAL|PRIVATE|DRAFT/);
    });
    await t.test("Tag Cloud hides empty terms, shows live counts and restricts font style input", async () => {
      await db.query("UPDATE settings SET data=data || '{\"tagBase\":\"topics\",\"categoryBase\":\"sections\"}'::jsonb WHERE id=1");
      const raw = await render(block("tag-cloud", { numberOfTags: 100, showTagCounts: true, smallestFontSize: "8pt", largestFontSize: "22pt" })), parsed = dom(raw);
      const alpha = parsed.querySelector(".tag-link-" + terms[0].id)!; assert.equal(alpha.getAttribute("href"), `/topics/${terms[0].slug}/`); assert.match(alpha.textContent!, /\(2\)/); assert.match(alpha.getAttribute("style")!, /font-size:22pt/);
      assert.equal(parsed.querySelector(".tag-link-" + terms[2].id), null);
      for (const unit of ["vw","vh","ch","ex"]) {
        const sized=dom(await render(block("tag-cloud",{smallestFontSize:"2"+unit,largestFontSize:"4"+unit})));
        assert.match(sized.querySelector(".tag-link-"+terms[0].id)!.getAttribute("style")!,new RegExp("font-size:4"+unit));
      }
      const naturalIds:number[]=[];
      for(const suffix of ["Tag10","Tag2"]) {
        const row=(await db.query("INSERT INTO terms(taxonomy,name,slug) VALUES('tag',$1,$2) RETURNING id",[stamp+" "+suffix,stamp+"-"+suffix.toLowerCase()])).rows[0]; naturalIds.push(row.id);
        await db.query("INSERT INTO post_terms(post_id,term_id) VALUES($1,$2)",[posts[0].id,row.id]);
      }
      const ordered=[...dom(await render(block("tag-cloud",{numberOfTags:100}))).querySelectorAll("a")].map(item=>item.className);
      assert.ok(ordered.findIndex(value=>value.includes("tag-link-"+naturalIds[1]+" "))<ordered.findIndex(value=>value.includes("tag-link-"+naturalIds[0]+" ")));
      const inverted=dom(await render(block("tag-cloud",{smallestFontSize:"22pt",largestFontSize:"8pt"})));
      assert.match(inverted.querySelector(".tag-link-"+terms[0].id)!.getAttribute("style")!,/font-size:23pt/);
      const unsafe = await render(block("tag-cloud", { smallestFontSize: "url(javascript:bad())", largestFontSize: "1px;position:fixed" }));
      assert.doesNotMatch(unsafe, /javascript|position:|url\(/);
      await db.query("DELETE FROM post_terms WHERE post_id=$1 AND term_id=$2", [posts[1].id, terms[0].id]);
      assert.match(dom(await render(block("tag-cloud", { showTagCounts: true }))).querySelector(".tag-link-" + terms[0].id)!.textContent!, /\(1\)/);
    });
    await t.test("Post metadata widgets respect context, approved counts and closed/protected comments", async () => {
      const raw = await render(block("post-comments-count") + block("post-comments-link") + block("post-time-to-read", { displayMode: "words" }));
      assert.equal(dom(raw).querySelector(".wp-block-post-comments-count")!.textContent, "2"); assert.match(raw, /2 comments/); assert.match(raw, /#comments/); assert.match(raw, /62 words/);
      assert.equal(await render(block("post-comments-count") + block("post-time-to-read"), { post: null }), "");
      assert.equal(await render(block("post-comments-count") + block("post-time-to-read"), { post: posts[2] }), "");
      assert.equal(await render(block("post-comments-link"), { post: { ...posts[0], commentStatus: "closed" } }), "");
      await db.query("UPDATE settings SET data=data || '{\"closeCommentsDays\":1}'::jsonb WHERE id=1");
      assert.equal(await render(block("post-comments-link")), "");
    });
    await t.test("Query Total uses actual nested loop metadata and does not fetch another query", async () => {
      const html = await render(block("query", { queryId: 91, query: { perPage: 1, include: [posts[0].id, posts[1].id], sticky: "exclude" } }, block("query-total") + block("query-total", { displayType: "range-display" })), { query: { "query-91-page": "1" } });
      assert.match(html, /1 result found/); assert.match(html, /Displaying 1 of 1/);
      const empty = await render(block("query", { query: { include: [2147483647] } }, block("query-total", { displayType: "range-display" })));
      assert.match(empty, /Displaying 0 of 0/);
    });
    await t.test("Full-post widgets terminate recursive post references while rendering later siblings", async () => {
      const raw = block("latest-posts", { categories: [{ id: category.id }], displayPostContent: true, displayPostContentRadio: "full_post" }) + block("paragraph", {}, "<p>Following sibling remains</p>");
      await db.query("UPDATE posts SET raw_content=$2,content='<p>Outer recursive body</p>' WHERE id=$1", [posts[1].id, raw]);
      const html = await render(raw, { post: posts[1] });
      assert.ok(html.length < 20000); assert.match(html, /Following sibling remains/);
      assert.equal(dom(html).querySelectorAll(".wp-block-latest-posts").length, 2);
    });
    await t.test("Empty states and extreme Gregorian calendar years remain bounded and valid", async () => {
      for (const [year,timezone] of [[1,"+14:00"],[9999,"-12:00"]] as const) {
        await db.query("UPDATE settings SET data=data || $1::jsonb WHERE id=1", [JSON.stringify({timezone})]);
        const html=await render(block("calendar",{year,month:year===1?1:12}));
        assert.match(html,/wp-calendar-table/);
      }
      await db.query("UPDATE posts SET status='draft' WHERE status='publish'");
      assert.match(await render(block("archives")),/No archives to show/);
      assert.match(await render(block("latest-comments")),/No comments to show/);
      assert.equal(await render(block("tag-cloud")),"");
      assert.equal(await render(block("calendar")),"");
      assert.match(await render(block("calendar"),{user:{id:admin.id,role:"administrator",displayName:admin.name}}),/no published posts/);
    });
  } finally { await db.query("ROLLBACK"); db.release(); }
});

test("Latest Posts full-content expansion shares the global byte budget and request cache", async () => {
  let queries=0;
  const content="<p>"+"a".repeat(256*1024)+"</p>";
  const db={query:async(sql:string)=>{
    queries++;
    if(sql.includes("FROM settings"))return{rows:[{data:defaultSettings}]};
    if(sql.includes("FROM posts p JOIN users"))return{rows:Array.from({length:40},(_,index)=>({id:index+10,type:"post",title:"Expanded",slug:"expanded-"+index,status:"publish",publishedAt:new Date(),hasPassword:false,terms:[],content,rawContent:content}))};
    throw new Error("Unexpected widget query");
  }};
  await assert.rejects(renderSiteDocument({rawContent:block("latest-posts",{postsToShow:100,displayPostContent:true,displayPostContentRadio:"full_post"})},{db:db as any}),/8 MiB/);
  assert.equal(queries,2);
});

const apiBase = process.env.TEST_API_URL || "http://127.0.0.1:3001", apiOrigin = process.env.APP_ORIGIN || "http://127.0.0.1:5173";
test("native widget REST dependencies embed safe author/media records and page actual published author selectors", async () => {
  let cookie = "";
  const people: number[] = [], posts: number[] = [], media: number[] = [], stamp = "widget-rest-" + Date.now().toString(36);
  const request = async (route: string, method = "GET", body?: unknown) => {
    const response = await fetch(apiBase + route, { method, headers: { Origin: apiOrigin, Cookie: cookie, ...(body instanceof FormData ? {} : { "Content-Type": "application/json" }) }, ...(body === undefined ? {} : { body: body instanceof FormData ? body : JSON.stringify(body) }) });
    return { response, data: await response.json() };
  };
  const ok = async (route: string, method = "GET", body?: unknown) => { const r = await request(route, method, body); assert.ok(r.response.ok, `${route}: ${r.response.status} ${JSON.stringify(r.data)}`); return r; };
  try {
    const login = await ok("/api/auth/login", "POST", { login: process.env.ADMIN_EMAIL, password: process.env.ADMIN_PASSWORD }); cookie = login.response.headers.get("set-cookie")!.split(";")[0];
    for (const type of ["post", "page", "protected", "draft"]) {
      const person = (await ok("/api/users", "POST", { username: stamp + "-" + type, email: stamp + "-" + type + "@example.test", displayName: stamp + " " + type, role: "author", password: "Temporary-widget-" + stamp })).data.user; people.push(person.id);
      const post = (await ok("/api/posts", "POST", { title: stamp + " " + type, authorId: person.id, type: type === "page" ? "page" : "post", status: type === "draft" ? "draft" : "publish", ...(type === "protected" ? { password: "Protected-widget-fixture" } : {}) })).data.post; posts.push(post.id);
    }
    const source = await import("sharp"), png = await source.default({ create: { width: 360, height: 360, channels: 3, background: "#336699" } }).png().toBuffer(), upload = new FormData();
    upload.append("file", new Blob([new Uint8Array(png)], { type: "image/png" }), "widget-image.png");
    const image = (await ok("/api/media", "POST", upload)).data.media; media.push(image.id);
    await ok(`/api/posts/${posts[0]}`, "PUT", { featuredMediaId: image.id });
    const record = (await ok(`/wp-json/wp/v2/posts/${posts[0]}?_embed=author,wp:featuredmedia`)).data;
    assert.equal(record._embedded.author[0].id, people[0]); assert.equal(record._embedded.author[0].name, stamp + " post");
    assert.equal(record._embedded["wp:featuredmedia"][0].id, image.id); assert.match(record._embedded["wp:featuredmedia"][0].media_details.sizes.thumbnail.source_url, /\/uploads\//);
    assert.doesNotMatch(JSON.stringify(record._embedded.author), /email|roles|password|registered/);
    assert.equal((await ok(`/wp-json/wp/v2/posts/${posts[0]}`)).data._embedded, undefined);
    const authorOnly = (await ok(`/wp-json/wp/v2/posts/${posts[0]}?_embed=author`)).data._embedded;
    assert.ok(authorOnly.author); assert.equal(authorOnly["wp:featuredmedia"], undefined);
    const list = (await ok(`/wp-json/wp/v2/posts?include=${posts[0]}&_embed=author,wp:featuredmedia`)).data;
    assert.equal(list[0]._embedded.author[0].id, people[0]);
    const query = `/wp-json/wp/v2/users?search=${stamp}&has_published_posts[]=post&per_page=1`;
    const authors = await ok(query); assert.deepEqual(authors.data.map((row: any) => row.id), [people[0]]); assert.equal(authors.response.headers.get("X-WP-Total"), "1");
    const pages = await ok(`/wp-json/wp/v2/users?search=${stamp}&has_published_posts[]=page`); assert.deepEqual(pages.data.map((row: any) => row.id), [people[1]]);
    const both = await ok(`/wp-json/wp/v2/users?search=${stamp}&has_published_posts[]=post&has_published_posts[]=page&per_page=1`);
    assert.equal(both.response.headers.get("X-WP-Total"), "2"); assert.equal(both.response.headers.get("X-WP-TotalPages"), "2"); assert.match(both.response.headers.get("Link")!, /page=2/);
    const next = await ok(`/wp-json/wp/v2/users?search=${stamp}&has_published_posts[]=post&has_published_posts[]=page&per_page=1&page=2`); assert.notEqual(both.data[0].id, next.data[0].id);
    for (const record of [...both.data, ...next.data]) assert.deepEqual(Object.keys(record).sort(), ["avatar_urls", "description", "id", "link", "name", "slug", "url"]);
    const types = (await ok("/wp-json/wp/v2/block-types")).data; for (const name of WIDGET_BLOCKS) assert.ok(types.some((row: any) => row.name === name && row.is_dynamic));
    const counts = await ok(`/wp-json/wp/v2/comments?post=${posts[0]}&per_page=1&_fields=id&context=view`); assert.equal(counts.response.headers.get("X-WP-Total"), "0");
    const rendered = await ok(`/wp-json/wp/v2/block-renderer/core/latest-posts?attributes=${encodeURIComponent(JSON.stringify({ selectedAuthor: people[0], displayAuthor: true }))}`); assert.match(rendered.data.rendered, new RegExp(stamp + " post"));
  } finally {
    for (const id of posts) { await request(`/api/posts/${id}`, "PUT", { status: "trash" }); await request(`/api/posts/${id}`, "DELETE"); }
    for (const id of media) await request(`/api/media/${id}`, "DELETE");
    for (const id of people) await request(`/api/users/${id}`, "DELETE");
    if (cookie) await request("/api/auth/logout", "POST", {});
  }
});
