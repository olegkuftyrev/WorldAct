import "dotenv/config";
import assert from "node:assert/strict";
import test, { after } from "node:test";
import { randomBytes, createHash } from "node:crypto";
import { DOMParser } from "linkedom";
import { pool, defaultSettings } from "../server/db.js";
import { renderPublicContent, renderSiteDocument } from "../server/block-renderer.js";
import { postAccessReader, postNeedsPassword, publicPostTitle } from "../server/post-passwords.js";

const block = (name: string, attrs: Record<string, unknown> = {}, html = "") => html ? `<!-- wp:${name} ${JSON.stringify(attrs)} -->${html}<!-- /wp:${name} -->` : `<!-- wp:${name} ${JSON.stringify(attrs)} /-->`;
const dom = (html: string) => new DOMParser().parseFromString("<!doctype html><html><body>" + html + "</body></html>", "text/html");
const query = (ids: number[], extra: Record<string, unknown> = {}) => block("query", { queryId: 17, query: { include: ids, orderBy: "id", order: "asc", perPage: 10, ...extra } }, block("query-total") + block("post-template", {}, block("post-title", { isLink: true }) + block("post-excerpt") + block("post-content") + block("footnotes") + block("comments", {}, block("comment-template", {}, block("comment-content")))));
const settingsOnly = { query: async (sql: string) => { assert.match(sql, /FROM settings/); return { rows: [{ data: defaultSettings }] }; } } as any;
after(async () => { await pool.end(); });

test("protected titles keep their source prefix after unlocking and request grants require real cookie tokens", async () => {
  assert.equal(publicPostTitle({ title: "Example", hasPassword: true, locked: false }), "Protected: Example");
  assert.equal(publicPostTitle({ title: "Example", status: "private" }), "Private: Example");
  assert.equal(postNeedsPassword({ hasPassword: true }), true); assert.equal(postNeedsPassword({ hasPassword: true, locked: false }), false);
  let reads = 0;
  const db = { query: async () => { reads++; return { rowCount: 1 }; } } as any;
  assert.equal(await postAccessReader({ headers: { cookie: "worldact_post_5=bad; worldact_post_6=" + "a".repeat(64) } })(5, db), false);
  assert.equal(reads, 0); assert.equal(await postAccessReader({ headers: { cookie: "worldact_post_6=" + "a".repeat(64) } })(6, db), true); assert.equal(reads, 1);
});

test("direct public rendering blocks protected static and canonical bodies unless explicitly unlocked", async () => {
  for (const rawContent of ["<p>CONFIDENTIAL-static</p>", block("paragraph", {}, "<p>CONFIDENTIAL-block</p>")]) {
    const post = { id: 42, type: "post", title: "Protected", slug: "protected", hasPassword: true, rawContent };
    const locked = await renderPublicContent(post, { db: settingsOnly });
    assert.match(locked, /worldact-native-password-form/); assert.doesNotMatch(locked, /CONFIDENTIAL/);
    const unlocked = await renderPublicContent({ ...post, locked: false }, { db: settingsOnly }); assert.match(unlocked, /CONFIDENTIAL/);
  }
});

test("ordinary Query Loops include protected metadata and totals while all body contexts remain locked", async () => {
  const db = await pool.connect(); await db.query("BEGIN");
  try {
    const user = (await db.query("SELECT id FROM users WHERE role='administrator' LIMIT 1")).rows[0];
    const stamp = "password-loop-" + Date.now().toString(36), ids: number[] = [];
    for (const [title, status, password] of [["Public", "publish", null], ["Protected", "publish", "source-password"], ["Private", "private", null], ["Draft", "draft", null]] as const) {
      ids.push((await db.query("INSERT INTO posts(type,title,slug,content,raw_content,excerpt,footnotes,status,password_hash,author_id,published_at) VALUES('post',$1,$2,$3,$3,$4,$5,$6,$7,$8,now()) RETURNING id", [stamp + title, stamp + title, block("paragraph", {}, `<p>${password ? "CONFIDENTIAL-body" : title}</p>`), password ? "CONFIDENTIAL-excerpt" : "Public excerpt", JSON.stringify(password ? [{ id: "secret-note", content: "CONFIDENTIAL-note" }] : []), status, password, user.id])).rows[0].id);
    }
    await db.query("INSERT INTO comments(post_id,author_name,author_email,content,status) VALUES($1,'Reader','reader@example.test','CONFIDENTIAL-comment','approved')", [ids[1]]);
    const rawContent = query(ids), options = { db, requestPath: "/journal/", placeholderBindings: false };
    const locked = dom(await renderSiteDocument({ rawContent }, options));
    assert.match(locked.body.textContent!, /2 results found/); assert.match(locked.body.textContent!, /Protected: .*Protected/);
    assert.doesNotMatch(locked.body.textContent!, /CONFIDENTIAL|password-loop-[a-z0-9]+(?:Private|Draft)/);
    assert.equal(locked.querySelectorAll(".post-password-required").length, 1);
    assert.ok(locked.querySelector("form.worldact-native-password-form"));
    const anonymousSearch = await renderSiteDocument({ rawContent: query(ids, { search: stamp }) }, options);
    assert.match(anonymousSearch, /1 result found/); assert.doesNotMatch(anonymousSearch, /Protected:/);
    const authenticatedSearch = await renderSiteDocument({ rawContent: query(ids, { search: stamp }) }, { ...options, user: { id: user.id, role: "administrator", displayName: "Administrator" } });
    assert.match(authenticatedSearch, /2 results found/); assert.match(authenticatedSearch, /Protected:/); assert.doesNotMatch(authenticatedSearch, /CONFIDENTIAL/);
    const token = randomBytes(32).toString("hex"), hash = createHash("sha256").update(token).digest("hex");
    await db.query("INSERT INTO post_access_tokens(token_hash,post_id,password_hash,expires_at) VALUES($1,$2,'source-password',now()+interval '1 hour')", [hash, ids[1]]);
    const reader = postAccessReader({ headers: { cookie: `worldact_post_${ids[1]}=${token}` } });
    const unlocked = await renderSiteDocument({ rawContent }, { ...options, canReadProtectedPost: reader });
    assert.match(unlocked, /CONFIDENTIAL-body/); assert.match(unlocked, /CONFIDENTIAL-excerpt/); assert.match(unlocked, /CONFIDENTIAL-note/); assert.match(unlocked, /CONFIDENTIAL-comment/); assert.match(unlocked, /Protected:/);
    await db.query("UPDATE posts SET password_hash='changed-password' WHERE id=$1", [ids[1]]);
    const revoked = await renderSiteDocument({ rawContent }, { ...options, canReadProtectedPost: reader }); assert.doesNotMatch(revoked, /CONFIDENTIAL/);
    const duplicated = dom(await renderSiteDocument({ rawContent: rawContent + rawContent }, options));
    const inputs = [...duplicated.querySelectorAll('input[type="password"]')]; assert.equal(inputs.length, 2); assert.equal(new Set(inputs.map(input => input.id)).size, 2);
  } finally { await db.query("ROLLBACK"); db.release(); }
});

test("real templates, feeds and public search honor cookie grants without exposing protected notes or excerpts", async () => {
  const base = process.env.TEST_API_URL || "http://127.0.0.1:3001", origin = process.env.APP_ORIGIN || "http://127.0.0.1:5173";
  let admin = "", documentId: number | undefined;
  const ids: number[] = [], stamp = "password-api-" + Date.now().toString(36), password = "Fixture-password-" + stamp;
  const api = async (path: string, method = "GET", body?: unknown, cookie = admin) => {
    const response = await fetch(base + path, { method, headers: { Origin: origin, "Content-Type": "application/json", ...(cookie ? { Cookie: cookie } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const raw = await response.text(); let data: any; try { data = JSON.parse(raw); } catch { data = raw; } return { response, data, raw };
  };
  try {
    const signed = await api("/api/auth/login", "POST", { login: process.env.ADMIN_EMAIL, password: process.env.ADMIN_PASSWORD }, ""); assert.equal(signed.response.status, 200); admin = signed.response.headers.get("set-cookie")!.split(";")[0];
    let protectedPost: any;
    for (const [label, secret] of [["Public", false], ["Protected", true], ["OtherProtected", true]] as const) {
      const created = await api("/api/posts", "POST", { title: stamp + label, status: "publish", ...(secret ? { password } : {}), excerpt: secret ? "CONFIDENTIAL-api-excerpt" : "Public excerpt", content: block("paragraph", {}, `<p>${secret ? "CONFIDENTIAL-api-body" : "Public body"}</p>`) + block("footnotes"), footnotes: secret ? [{ id: "secret-note", content: "CONFIDENTIAL-api-note" }] : [] });
      assert.equal(created.response.status, 201); ids.push(created.data.post.id); if (label === "Protected") protectedPost = created.data.post;
    }
    const createdDocument = await api("/api/site-editor/documents", "POST", { title: stamp, slug: stamp, type: "template", content: query(ids) + block("latest-posts", { postsToShow: 3, displayPostContent: true, displayPostContentRadio: "full_post" }) }); assert.equal(createdDocument.response.status, 201); documentId = createdDocument.data.document.id;
    const route = "/api/public/templates/" + stamp + "?requestPath=%2Fjournal%2F";
    const locked = await api(route, "GET", undefined, ""); assert.equal(locked.response.status, 200); assert.match(locked.data.content, /3 results found/); assert.match(locked.data.content, /Protected:/); assert.doesNotMatch(locked.data.content, /CONFIDENTIAL/);
    const search = await api("/api/public/site?search=" + stamp, "GET", undefined, ""); assert.equal(search.data.pagination.totalPosts, 1);
    const authenticatedSearch = await api("/api/public/site?search=" + stamp); assert.equal(authenticatedSearch.data.pagination.totalPosts, 3); assert.doesNotMatch(authenticatedSearch.raw, /CONFIDENTIAL|scrypt:|_passwordHash/);
    for (const path of ["/feed/", "/feed/atom/"]) {
      const feed = await api(path, "GET", undefined, ""); assert.match(feed.raw, new RegExp("Protected: " + stamp + "Protected")); assert.match(feed.raw, /There is no excerpt because this is a protected post/); assert.doesNotMatch(feed.raw, /CONFIDENTIAL/);
    }
    const unlock = await api("/api/public/posts/" + protectedPost.slug + "/unlock", "POST", { password }, ""); assert.equal(unlock.response.status, 200); const grant = unlock.response.headers.get("set-cookie")!.split(";")[0];
    const unlocked = dom((await api(route, "GET", undefined, grant)).data.content);
    const own = unlocked.querySelector(".post-" + protectedPost.id)!; assert.match(own.textContent!, /CONFIDENTIAL-api-body/); assert.match(own.textContent!, /CONFIDENTIAL-api-note/); assert.equal(unlocked.querySelectorAll(".post-password-required").length, 1);
    const feed = await api("/feed/", "GET", undefined, grant); assert.match(feed.raw, /CONFIDENTIAL-api-body/); assert.match(feed.response.headers.get("cache-control") || "", /private.*no-store/); assert.match(feed.response.headers.get("vary") || "", /Cookie/i);
    assert.match((await api(route, "GET", undefined, "worldact_post_" + protectedPost.id + "=" + "a".repeat(64))).data.content, /worldact-native-password-form/);
    const changed = await api("/api/posts/" + protectedPost.id, "PUT", { password: "Changed-" + password }); assert.equal(changed.response.status, 200);
    assert.doesNotMatch((await api(route, "GET", undefined, grant)).data.content, /CONFIDENTIAL/);
  } finally {
    if (documentId) await api("/api/site-editor/documents/" + documentId, "DELETE");
    for (const id of ids) { await api("/api/posts/" + id, "PUT", { status: "trash" }); await api("/api/posts/" + id, "DELETE"); }
    if (admin) await api("/api/auth/logout", "POST", {});
  }
});
