import test, { after } from "./isolated-test.js";
import assert from "node:assert/strict";
import { DOMParser } from "linkedom";
import { pool, getSettings, getPost } from "../server/db.js";
import { renderSiteDocument } from "../server/block-renderer.js";
import { hashPassword } from "../server/auth.js";
import { avatarURL } from "../server/avatars.js";
import { MAX_PUBLIC_COMMENT_BYTES, MAX_PUBLIC_COMMENT_RECORDS } from "../server/comment-window.js";
import { fixtureUserNicename } from "./helpers/user-fixtures.js";

const base = process.env.TEST_API_URL!;
const block = (name: string, attrs: Record<string, unknown> = {}, body = "") => `<!-- wp:${name} ${JSON.stringify(attrs)}${body ? " -->" + body + `<!-- /wp:${name} -->` : " /-->"}`;
const dom = (html: string) => new DOMParser().parseFromString(html, "text/html");
const idsIn = (html: string) => [...dom(html).querySelectorAll('li[id^="comment-"]')].map(node => Number(node.id.slice(8)));
const sorted = (ids: number[]) => [...ids].sort((a, b) => a - b);
const api = async (path: string, options: RequestInit = {}) => {
  const response = await fetch(base + path, options); return { response, data: await response.json() };
};
after(() => pool.end());

async function fixture() {
  const previous = (await pool.query("SELECT data FROM settings WHERE id=1")).rows[0].data;
  const stamp = "thread-window-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 7);
  const owner = (await pool.query("SELECT id,email FROM users WHERE role='administrator' ORDER BY id LIMIT 1")).rows[0];
  const posts: number[] = [], documents: number[] = [], users: number[] = [];
  const settings = async (patch: Record<string, unknown>) => pool.query("UPDATE settings SET data=data || $1::jsonb WHERE id=1", [JSON.stringify(patch)]);
  await settings({theme: "twentytwentyfive", threadComments: true, threadDepth: 5, paginateComments: true, commentsPerPage: 2, commentOrder: "asc", defaultCommentPage: "oldest", showAvatars: true, closeCommentsDays: 0});
  const post = async (label: string, password: string | null = null) => {
    const result = (await pool.query("INSERT INTO posts(type,title,slug,status,author_id,published_at,content,raw_content,password_hash,post_date,post_date_gmt) VALUES('post',$1,$2,'publish',$3,'2025-01-01',$4,$4,$5,to_char(CASE WHEN coalesce((SELECT data->>'timezone' FROM settings WHERE id=1),'America/Los_Angeles')~'^[+-]' THEN timezone(coalesce((SELECT data->>'timezone' FROM settings WHERE id=1),'America/Los_Angeles')::interval,coalesce(CASE WHEN 'publish'='future' THEN NULL::timestamptz END,'2025-01-01'::timestamptz,NULL::timestamptz,now())) ELSE timezone(coalesce((SELECT data->>'timezone' FROM settings WHERE id=1),'America/Los_Angeles'),coalesce(CASE WHEN 'publish'='future' THEN NULL::timestamptz END,'2025-01-01'::timestamptz,NULL::timestamptz,now())) END,'YYYY-MM-DD\"T\"HH24:MI:SS'),coalesce(CASE WHEN 'publish'='future' THEN NULL::timestamptz END,'2025-01-01'::timestamptz,NULL::timestamptz,now())) RETURNING id,slug,title", [stamp + " " + label, stamp + "-" + label, owner.id, "<p>First body page.</p><!--nextpage--><p>Second body page.</p>", password])).rows[0];
    posts.push(result.id); return result;
  };
  const p = await post("main");
  const comment = async (label: string, parent: number | null = null, day = 1, status = "approved", type = "comment", postId = p.id, userId: number | null = null) =>
    (await pool.query("INSERT INTO comments(post_id,parent_id,author_name,author_email,author_url,user_id,content,status,type,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id", [postId, parent, label, stamp + "-" + label + "-private@example.test", "https://reader.example.test/" + label, userId, "<p>" + label + " body.</p>", status, type, `2025-01-${String(day).padStart(2, "0")}T12:00:00Z`])).rows[0].id as number;
  const a = await comment("RootA", null, 1), b = await comment("RootB", null, 2), c = await comment("RootC", null, 3);
  // Replies deliberately interleave other roots, and the grandchild's date
  // precedes its parent's date. Neither may become an independent page unit.
  const ar = await comment("ReplyA", a, 6), ag = await comment("GrandchildA", ar, 4), br = await comment("ReplyB", b, 5);
  const read = (query = "", cookie = "") => api(`/api/public/posts/${p.slug}${query ? "?" + query : ""}`, {headers: {Cookie: cookie}});
  const bundled = async (query = "", cookie = "") => {
    const result = await api(`/api/public/templates/single?postId=${p.id}&requestPath=${encodeURIComponent('/posts/' + p.slug + '/')}${query ? "&" + query : ""}`, {headers: {Cookie: cookie}});
    return result;
  };
  const document = async (rawContent: string) => {
    const record = (await pool.query("INSERT INTO site_documents(slug,title,type,theme,content,raw_content) VALUES($1,$1,'template','twentytwentyfive',$2,$2) RETURNING id,slug", [stamp + "-template-" + documents.length, rawContent])).rows[0];
    documents.push(record.id); return record;
  };
  const clean = async () => {
    await pool.query("DELETE FROM site_documents WHERE id=ANY($1::int[])", [documents]);
    await pool.query("DELETE FROM posts WHERE id=ANY($1::int[])", [posts]);
    await pool.query("DELETE FROM users WHERE id=ANY($1::int[])", [users]);
    await pool.query("UPDATE settings SET data=$1::jsonb WHERE id=1", [JSON.stringify(previous)]);
  };
  return {p, owner, post, posts, comment, settings, read, bundled, document, users, a, b, c, ar, ag, br, clean};
}

test("actual public DTO and bundled template page complete approved threads instead of date-interleaved replies", async () => {
  const f = await fixture();
  try {
    for (const [page, expected] of [[1, [f.a, f.ar, f.ag, f.b, f.br]], [2, [f.c]]] as const) {
      const classic = await f.read("commentPage=" + page), source = await f.bundled("commentPage=" + page);
      assert.equal(classic.response.status, 200); assert.equal(source.response.status, 200);
      assert.deepEqual(sorted(classic.data.comments.map((c: any) => c.id)), sorted([...expected]));
      assert.deepEqual(idsIn(source.data.content), [...expected]);
      assert.deepEqual(classic.data.commentsPagination, {page, perPage: 2, totalComments: 6, totalTopLevelComments: 3, totalPages: 2});
      assert.match(source.data.content, /6 responses/);
      for (const row of classic.data.comments) for (const key of ["authorEmail", "_avatarEmail", "_accountAvatarEmail", "email"]) assert.equal(Object.hasOwn(row, key), false);
      assert.doesNotMatch(JSON.stringify(classic.data.comments) + source.data.content, /private@example\.test/);
    }
    const first = dom((await f.bundled("commentPage=1")).data.content);
    assert.ok(first.querySelector(`#comment-${f.a} ol.children #comment-${f.ar} ol.children #comment-${f.ag}`));
    assert.equal((await f.read("commentPage=999")).data.commentsPagination.page, 2);
  } finally {await f.clean();}
});

test("root pages preserve ascending/descending newest/oldest defaults, while flat and unpaginated settings retain their own windows", async () => {
  const f = await fixture();
  try {
    for (const [commentOrder, defaultCommentPage, page, expected] of [
      ["asc", "oldest", 1, [f.a, f.ar, f.ag, f.b, f.br]],
      ["asc", "newest", 2, [f.c]],
      ["desc", "newest", 2, [f.c]],
      ["desc", "oldest", 1, [f.b, f.br, f.a, f.ar, f.ag]],
    ] as const) {
      await f.settings({commentOrder, defaultCommentPage});
      const result = await f.read(), source = await f.bundled();
      assert.equal(result.data.commentsPagination.page, page);
      assert.deepEqual(sorted(result.data.comments.map((c: any) => c.id)), sorted([...expected]));
      assert.deepEqual(idsIn(source.data.content), [...expected]);
    }
    await f.settings({threadComments: false, commentOrder: "asc", defaultCommentPage: "oldest"});
    for (const [page, expected] of [[1, [f.a, f.b]], [2, [f.c, f.ag]], [3, [f.br, f.ar]]] as const) {
      const result = await f.read("commentPage=" + page), source = await f.bundled("commentPage=" + page);
      assert.deepEqual(result.data.comments.map((c: any) => c.id), [...expected]);
      assert.deepEqual(idsIn(source.data.content), [...expected]);
      assert.equal(result.data.commentsPagination.totalPages, 3);
      assert.equal(dom(source.data.content).querySelector("ol.children"), null);
    }
    await f.settings({commentOrder: "desc"});
    for (const [page, expected] of [[1, [f.b, f.a]], [2, [f.ag, f.c]], [3, [f.ar, f.br]]] as const) {
      assert.deepEqual((await f.read("commentPage=" + page)).data.comments.map((c: any) => c.id), [...expected]);
      assert.deepEqual(idsIn((await f.bundled("commentPage=" + page)).data.content), [...expected]);
    }
    await f.settings({commentOrder: "asc"});
    for (const threadComments of [true, false]) {
      await f.settings({threadComments, paginateComments: false});
      const result = await f.read("commentPage=99"), source = await f.bundled("commentPage=99");
      assert.deepEqual(result.data.commentsPagination, {page: 1, perPage: 6, totalComments: 6, totalTopLevelComments: 3, totalPages: 1});
      assert.equal(result.data.comments.length, 6); assert.equal(idsIn(source.data.content).length, 6);
    }
    await f.settings({theme: "classic", threadComments: true, paginateComments: true});
    assert.deepEqual(sorted((await f.read("commentPage=1")).data.comments.map((c: any) => c.id)), sorted([f.a, f.b, f.ar, f.ag, f.br]));
  } finally {await f.clean();}
});

test("descending reverses only the selected chronological roots, preserving chronological child siblings and stable tied dates", async () => {
  const f = await fixture();
  try {
    const earlier = await f.comment("EarlierA", f.a, 5), tied = await f.comment("TiedEarlierA", f.a, 5), later = await f.comment("LaterA", f.a, 9);
    await f.settings({commentOrder: "desc", defaultCommentPage: "oldest"});
    const result = await f.read(), source = await f.bundled();
    assert.equal(result.data.commentsPagination.page, 1);
    assert.deepEqual(result.data.comments.filter((c: any) => c.parentId == null).map((c: any) => c.id), [f.b, f.a]);
    assert.deepEqual(result.data.comments.filter((c: any) => c.parentId === f.a).map((c: any) => c.id), [earlier, tied, f.ar, later]);
    assert.deepEqual(idsIn(source.data.content), [f.b, f.br, f.a, earlier, tied, f.ar, f.ag, later]);
    await f.settings({defaultCommentPage: "newest"});
    assert.equal((await f.read()).data.commentsPagination.page, 2);
    assert.deepEqual(idsIn((await f.bundled()).data.content), [f.c]);
  } finally {await f.clean();}
});

test("hidden parents, unapproved branches, cross-post links and detached cycles cannot create threaded roots or leak replies", async () => {
  const f = await fixture();
  try {
    const unavailable: number[] = [];
    for (const status of ["pending", "spam", "trash"]) {
      const parent = await f.comment("Hidden-" + status, null, 7, status);
      unavailable.push(await f.comment("Below-" + status, parent, 8));
    }
    const hiddenReply = await f.comment("HiddenReply", f.a, 9, "pending");
    unavailable.push(await f.comment("BelowHiddenReply", hiddenReply, 10));
    const other = await f.post("other"), foreignParent = await f.comment("ForeignParent", null, 1, "approved", "comment", other.id);
    unavailable.push(await f.comment("CrossPostOrphan", foreignParent, 11));
    const self = await f.comment("SelfCycle", null, 12); await pool.query("UPDATE comments SET parent_id=id WHERE id=$1", [self]); unavailable.push(self);
    const cycleA = await f.comment("CycleA", null, 13), cycleB = await f.comment("CycleB", cycleA, 14);
    await pool.query("UPDATE comments SET parent_id=$2 WHERE id=$1", [cycleA, cycleB]); unavailable.push(cycleA, cycleB);
    const deleted = await f.comment("DeletedParent", null, 15), surviving = await f.comment("SurvivingChild", deleted, 16);
    await pool.query("DELETE FROM comments WHERE id=$1", [deleted]);
    assert.equal((await pool.query("SELECT parent_id FROM comments WHERE id=$1", [surviving])).rows[0].parent_id, null);
    await f.settings({paginateComments: false});
    const result = await f.read(), source = await f.bundled();
    const expected = [f.a, f.b, f.c, f.ar, f.ag, f.br, surviving];
    assert.deepEqual(sorted(result.data.comments.map((c: any) => c.id)), sorted(expected));
    assert.deepEqual(sorted(idsIn(source.data.content)), sorted(expected));
    assert.equal(result.data.commentsPagination.totalComments, 15);
    assert.equal(result.data.commentsPagination.totalTopLevelComments, 4);
    assert.match(source.data.content, /15 responses/);
    assert.doesNotMatch(source.data.content, /Hidden|Below-|CrossPostOrphan|SelfCycle|Cycle[AB]|ForeignParent|DeletedParent/);
    await f.settings({paginateComments: true});
    assert.equal((await f.read()).data.commentsPagination.totalPages, 2);
    await f.settings({threadComments: false, paginateComments: false});
    const flat = await f.read(), flatSource = await f.bundled();
    assert.equal(flat.data.comments.length, 15); assert.equal(idsIn(flatSource.data.content).length, 15);
    for (const id of unavailable) assert.ok(flat.data.comments.some((c: any) => c.id === id));
    assert.doesNotMatch(flatSource.data.content, /<p>(?:Hidden-pending|Hidden-spam|Hidden-trash|HiddenReply) body/);
    await pool.query("UPDATE comments SET status='pending' WHERE id=ANY($1::int[])", [[f.a, f.b, f.c, surviving]]);
    await f.settings({threadComments: true, paginateComments: true});
    const noRoots = await f.read();
    assert.deepEqual(noRoots.data.comments, []);
    assert.deepEqual(noRoots.data.commentsPagination, {page: 1, perPage: 2, totalComments: 11, totalTopLevelComments: 0, totalPages: 1});
    assert.deepEqual(idsIn((await f.bundled()).data.content), []);
  } finally {await f.clean();}
});

test("threaded human/ping identity and password grants preserve private avatar semantics and complete windows", async () => {
  const f = await fixture();
  try {
    const member = (await pool.query("INSERT INTO users(username,email,display_name,password_hash,role,nicename) VALUES($1,$2,'Member','PRIVATE-HASH','subscriber',$3) RETURNING id,email", [f.p.slug + "-member", f.p.slug + "-current-private@example.test", fixtureUserNicename(f.p.slug + "-member")])).rows[0]; f.users.push(member.id);
    const registered = await f.comment("Registered", f.a, 7, "approved", "comment", f.p.id, member.id);
    const ping = await f.comment("Pingback", null, 8, "approved", "pingback"), trackback = await f.comment("Trackback", null, 9, "approved", "trackback");
    await f.settings({paginateComments: false});
    const settings = await getSettings(), normal = await f.read(), source = dom((await f.bundled()).data.content);
    assert.equal(normal.data.commentsPagination.totalComments, 9); assert.equal(normal.data.commentsPagination.totalTopLevelComments, 5);
    assert.equal(normal.data.comments.find((c: any) => c.id === registered).avatarUrl, avatarURL(member.email, settings));
    for (const id of [ping, trackback]) {
      assert.equal(normal.data.comments.find((c: any) => c.id === id).avatarUrl, null);
      assert.equal(source.querySelector(`#comment-${id} .wp-block-avatar img,#comment-${id} [data-comment-reply]`), null);
    }
    assert.equal(source.querySelector(`#comment-${registered} img`)!.getAttribute("src"), avatarURL(member.email, settings, Number(source.querySelector(`#comment-${registered} img`)!.getAttribute("width"))));
    await pool.query("UPDATE posts SET password_hash=$2 WHERE id=$1", [f.p.id, await hashPassword("Thread-fixture-password")]);
    const locked = await f.read(), lockedSource = await f.bundled();
    assert.equal(locked.data.post.locked, true); assert.deepEqual(locked.data.comments, []);
    assert.equal(locked.data.commentsPagination.totalComments, 0); assert.equal(locked.data.commentsPagination.totalTopLevelComments, 0);
    assert.deepEqual(idsIn(lockedSource.data.content), []); assert.doesNotMatch(lockedSource.data.content, /RootA body|Registered body|private@example|PRIVATE-HASH/);
    const unlocked = await api(`/api/public/posts/${f.p.slug}/unlock`, {method: "POST", headers: {Origin: process.env.APP_ORIGIN!, "Content-Type": "application/json"}, body: JSON.stringify({password: "Thread-fixture-password"})});
    assert.equal(unlocked.response.status, 200); const cookie = unlocked.response.headers.get("set-cookie")!.split(";")[0];
    assert.equal((await f.read("", cookie)).data.comments.length, 9); assert.equal(idsIn((await f.bundled("", cookie)).data.content).length, 9);
    assert.doesNotMatch(JSON.stringify(unlocked.data), /current-private@example|_accountAvatarEmail|_avatarEmail|PRIVATE-HASH/);
  } finally {await f.clean();}
});

test("source template exhaustion rejects the complete window instead of successfully emitting empty comment bodies", async () => {
  const f = await fixture();
  try {
    const template = await f.document(block("comments", {}, block("comment-template", {}, block("comment-content").repeat(900))));
    const result = await api(`/api/public/templates/${template.slug}?postId=${f.p.id}&requestPath=${encodeURIComponent('/posts/' + f.p.slug + '/')}&commentPage=1`);
    assert.equal(result.response.status, 413); assert.match(result.data.error, /complete comment window.*node limit/); assert.equal(result.data.content, undefined);
    assert.equal((await f.read("commentPage=1")).data.comments.length, 5);
  } finally {await f.clean();}
});

test("actual template comment pages retain separate singular body and Query Loop counters and links", async () => {
  const f = await fixture();
  try {
    const second = await f.post("loop-second"), third = await f.post("loop-third");
    const template = await f.document(block("post-content") + block("query", {queryId: 17, query: {include: [f.p.id, second.id, third.id], perPage: 1, orderBy: "id", order: "asc"}}, block("post-template", {}, block("post-title"))) + block("comments", {}, block("comments-title") + block("comment-template", {}, block("comment-content")) + block("comments-pagination", {}, block("comments-pagination-numbers"))));
    const path = `/api/public/templates/${template.slug}?postId=${f.p.id}&requestPath=${encodeURIComponent('/posts/' + f.p.slug + '/')}`;
    const rendered = await api(path + "&page=2&query-17-page=2&commentPage=2");
    assert.equal(rendered.response.status, 200); assert.match(rendered.data.content, /Second body page/); assert.doesNotMatch(rendered.data.content, /First body page/);
    assert.match(rendered.data.content, new RegExp(second.title)); assert.doesNotMatch(rendered.data.content, new RegExp(third.title));
    assert.deepEqual(idsIn(rendered.data.content), [f.c]);
    const link = dom(rendered.data.content).querySelector('.wp-block-comments-pagination a')!;
    const query = new URL(link.getAttribute("href")!, "http://fixture.test").searchParams;
    assert.equal(query.get("commentPage"), "1"); assert.equal(query.get("page"), "2"); assert.equal(query.get("query-17-page"), "2");
    const changed = await api(path + "&page=2&query-17-page=2&commentPage=1");
    assert.match(changed.data.content, /Second body page/); assert.match(changed.data.content, new RegExp(second.title));
    assert.deepEqual(idsIn(changed.data.content), [f.a, f.ar, f.ag, f.b, f.br]);
    const classic = await f.read("page=2&query-17-page=2&commentPage=2");
    assert.equal(classic.data.post.contentPagination.page, 2); assert.deepEqual(classic.data.comments.map((c: any) => c.id), [f.c]);
  } finally {await f.clean();}
});

test("oversized complete threads reject with 413 in both real public surfaces instead of splitting or returning partial output", async () => {
  const f = await fixture();
  try {
    await pool.query("INSERT INTO comments(post_id,parent_id,author_name,author_email,content,status) SELECT $1,$2,'Budget reply','','Small body','approved' FROM generate_series(1,$3)", [f.p.id, f.a, MAX_PUBLIC_COMMENT_RECORDS]);
    await f.settings({commentsPerPage: 1});
    for (const result of [await f.read("commentPage=1"), await f.bundled("commentPage=1")]) {
      assert.equal(result.response.status, 413); assert.match(result.data.error, /complete comment window/); assert.equal(result.data.comments, undefined); assert.equal(result.data.content, undefined);
    }
    await pool.query("DELETE FROM comments WHERE post_id=$1 AND author_name='Budget reply'", [f.p.id]);
    await pool.query("UPDATE comments SET content=repeat('x',$2) WHERE id=$1", [f.a, MAX_PUBLIC_COMMENT_BYTES]);
    assert.equal((await f.read("commentPage=1")).response.status, 413); assert.equal((await f.bundled("commentPage=1")).response.status, 413);
    await f.settings({commentsPerPage: 1, defaultCommentPage: "newest"});
    assert.deepEqual((await f.read()).data.comments.map((c: any) => c.id), [f.c]);
  } finally {await f.clean();}
});

test("deep historical approved threads keep all IDs and source depth flattening without recursive JavaScript stack growth", async () => {
  const f = await fixture();
  try {
    await pool.query(`WITH numbered AS MATERIALIZED (
      SELECT n,nextval(pg_get_serial_sequence('comments','id'))::int AS id FROM generate_series(1,2500) n
    ) INSERT INTO comments(id,post_id,parent_id,author_name,author_email,content,status)
      OVERRIDING SYSTEM VALUE SELECT id,$1,coalesce(lag(id) OVER (ORDER BY n),$2),
        'Deep historical reply','','Deep reply','approved' FROM numbered`, [f.p.id, f.a]);
    await f.settings({paginateComments: false, threadDepth: 2});
    const response = await f.read(); assert.equal(response.response.status, 200); assert.equal(response.data.comments.length, 2506);
    const post = await getPost(f.p.id);
    const html = await renderSiteDocument({rawContent: block("comments", {}, block("comment-template", {}, block("comment-content")))}, {post});
    assert.equal(idsIn(html).length, 2506); assert.equal(new Set(idsIn(html)).size, 2506);
    assert.equal(dom(html).querySelector("ol.children ol.children"), null);
  } finally {await f.clean();}
});
