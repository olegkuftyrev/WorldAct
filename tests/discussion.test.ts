import "dotenv/config";
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { pool } from "../server/db.js";
import { matchesCommentKeywords } from "../server/core.js";
const base = process.env.TEST_API_URL || "http://127.0.0.1:3001", origin = process.env.APP_ORIGIN || "http://127.0.0.1:5173";
const smtpActive = !!process.env.SMTP_HOST && process.env.WORLDACT_MAIL_MODE !== "outbox" && process.env.NODE_ENV !== "test";
const cookieOf = (response: Response) => (response.headers.get("set-cookie") || "").split(";")[0];

test("discussion keywords are case-insensitive literal substrings across supported fields", () => {
  for (const value of ["Comment text", "Reader NAME", "mail@example.invalid", "https://example.invalid/", "127.0.0.1"])
    assert.equal(matchesCommentKeywords("\n  " + value.toUpperCase() + "\n", [value]), true);
  assert.equal(matchesCommentKeywords("a.*b", ["a123b"]), false);
  assert.equal(matchesCommentKeywords("a.*b", ["literal A.*B entry"]), true);
  assert.equal(matchesCommentKeywords("\r\n \n", ["anything"]), false);
});

test("Discussion controls enforce moderation, safe mail, private consent preferences and pagination", { skip: smtpActive }, async t => {
  const stamp = "discussion-" + Date.now().toString(36), email = stamp + "@example.invalid";
  let admin = "", author = "", settingsBefore: Record<string, unknown> | undefined, authorId = 0, privacyId = 0;
  const posts: any[] = [], comments: number[] = [];
  const keys = ["adminEmail", "commentModeration", "commentMaxLinks", "commentModerationKeys", "disallowedCommentKeys", "commentPreviouslyApproved", "notifyComments", "notifyModeration", "showAvatars", "avatarRating", "defaultAvatar", "commentCookieConsent", "paginateComments", "defaultCommentPage", "commentOrder", "commentsPerPage", "requireCommentNameEmail", "commentRegistration", "closeCommentsDays", "threadComments", "threadDepth"];
  const call = async (url: string, method = "GET", body?: unknown, cookie = admin) => {
    const response = await fetch(base + "/api" + url, { method, headers: { Origin: origin, "Content-Type": "application/json", Cookie: cookie }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { response, data: await response.json() };
  };
  const ok = async (url: string, method = "GET", body?: unknown, cookie = admin) => {
    const result = await call(url, method, body, cookie);
    assert.ok(result.response.ok, `${url}: ${result.response.status} ${JSON.stringify(result.data)}`); return result;
  };
  const settings = async (values: Record<string, unknown>) => { await ok("/settings", "PUT", values); };
  const mail = async () => (await pool.query("SELECT id,recipient,subject,body,delivered FROM mail_outbox WHERE subject LIKE $1 ORDER BY id", ["%" + stamp + "%"])).rows;
  const submit = async (post: any, values: Record<string, unknown> = {}, cookie = "") => {
    const result = await ok("/public/comments", "POST", { postId: post.id, authorName: "Temporary reader", authorEmail: email, content: "A useful comment", ...values }, cookie);
    comments.push(result.data.comment.id); return result;
  };
  let rememberedCookie = "";
  try {
    const login = await ok("/auth/login", "POST", { login: process.env.ADMIN_EMAIL, password: process.env.ADMIN_PASSWORD }, ""); admin = cookieOf(login.response);
    const current = (await ok("/settings")).data.settings; settingsBefore = Object.fromEntries(keys.map(key => [key, current[key]]));
    await settings({ adminEmail: login.data.user.email, commentModeration: false, commentMaxLinks: 0, commentModerationKeys: "", disallowedCommentKeys: "", commentPreviouslyApproved: false, notifyComments: false, notifyModeration: false, commentCookieConsent: true, paginateComments: true, defaultCommentPage: "oldest", commentOrder: "asc", commentsPerPage: 2, requireCommentNameEmail: true, commentRegistration: false, closeCommentsDays: 0, threadComments: true, threadDepth: 5 });
    const created = (await ok("/users", "POST", { username: stamp, email: stamp + "-owner@example.invalid", displayName: "Temporary Discussion editor", role: "editor", password: "Discussion-safe-" + stamp })).data.user; authorId = created.id;
    const signed = await ok("/auth/login", "POST", { login: created.username, password: "Discussion-safe-" + stamp }, ""); author = cookieOf(signed.response);
    for (const [label, owner] of [["Admin", login.data.user.id], ["Author", authorId]]) posts.push((await ok("/posts", "POST", { title: stamp + " " + label, authorId: owner, status: "publish", content: "<p>Discussion fixture</p>" })).data.post);
    const history = (await ok("/comments", "POST", { postId: posts[0].id, authorName: "Approved reader", authorEmail: email, content: "Approved history", status: "approved" })).data.comment; comments.push(history.id);
    await t.test("new settings validate, remain private, and explicit moderation sends one deduplicated message", async () => {
      for (const value of [{ commentMaxLinks: 101 }, { commentModerationKeys: "a".repeat(20001) }, { defaultAvatar: "remote-script" }, { paginateComments: "false" }]) assert.equal((await call("/settings", "PUT", value)).response.status, 400);
      assert.equal((await call("/settings", "PUT", { notifyComments: true }, "")).response.status, 401);
      await settings({ commentModeration: true, commentPreviouslyApproved: true, notifyModeration: true, notifyComments: true });
      const pending = await submit(posts[0]); assert.equal(pending.data.comment.status, "pending");
      const messages = await mail(); assert.equal(messages.length, 1); assert.equal(messages[0].recipient, login.data.user.email.toLowerCase()); assert.equal(messages[0].delivered, false);
      assert.match(messages[0].subject, /Please moderate/); assert.match(messages[0].body, /Review comments/);
    });
    await t.test("literal URL moderation and disallowed HTML text use the correct status and mail recipients", async () => {
      await settings({ commentModeration: false, commentPreviouslyApproved: false, commentModerationKeys: "SUSPEND.EXAMPLE" });
      const moderated = await submit(posts[1], { authorUrl: "https://suspend.example/reader" }); assert.equal(moderated.data.comment.status, "pending");
      let messages = await mail(); assert.equal(messages.length, 3); assert.deepEqual(new Set(messages.slice(-2).map(row => row.recipient)), new Set([login.data.user.email.toLowerCase(), created.email.toLowerCase()]));
      await settings({ commentModerationKeys: "a.*b" });
      const accepted = await submit(posts[1], { content: "a123b is not a literal moderation keyword", rememberAuthor: true, authorUrl: "https://reader.example.invalid" }); assert.equal(accepted.data.comment.status, "approved");
      rememberedCookie = cookieOf(accepted.response); assert.match(rememberedCookie, /^worldact_comment_author=[a-f0-9]{64}$/); assert.match(accepted.response.headers.get("set-cookie") || "", /HttpOnly/i); assert.match(accepted.response.headers.get("set-cookie") || "", /SameSite=Lax/i); assert.ok(!rememberedCookie.includes(email));
      messages = await mail(); assert.equal(messages.length, 4); assert.equal(messages.at(-1).recipient, created.email.toLowerCase()); assert.match(messages.at(-1).subject, /New comment/);
      const recalled = await ok("/public/comment-author", "GET", undefined, rememberedCookie); assert.equal(recalled.data.author.authorEmail, email); assert.equal(recalled.data.author.authorUrl, "https://reader.example.invalid");
      assert.equal((await ok("/public/comment-author", "GET", undefined, "")).data.author, null);
      assert.equal((await ok("/public/comment-author", "GET", undefined, "worldact_comment_author=" + "0".repeat(64))).data.author, null);
      await settings({ commentModerationKeys: "", disallowedCommentKeys: "badword" });
      const rejected = await submit(posts[1], { content: "Ba<b>Dword</b> is blocked", rememberAuthor: false }, rememberedCookie); assert.equal(rejected.data.comment.status, "trash"); assert.match(rejected.response.headers.get("set-cookie") || "", /Expires=/i);
      assert.equal((await ok("/public/comment-author", "GET", undefined, rememberedCookie)).data.author, null); assert.equal((await mail()).length, messages.length);
      const publicSite = (await ok("/public/site", "GET", undefined, "")).data;
      assert.equal(publicSite.settings.commentModerationKeys, undefined); assert.equal(publicSite.settings.disallowedCommentKeys, undefined); assert.equal(publicSite.settings.adminEmail, undefined);
      assert.ok(!JSON.stringify(publicSite).includes(email));
    });
    await t.test("link threshold, prior approval and optional identity checks are enforced", async () => {
      await settings({ disallowedCommentKeys: "", commentMaxLinks: 2, notifyComments: false, notifyModeration: false });
      const linked = '<p><a href="https://one.invalid">https://one.invalid</a> https://two.invalid</p>';
      assert.equal((await submit(posts[1], { content: linked })).data.comment.status, "pending");
      await settings({ commentMaxLinks: 0 });
      const unbounded = await submit(posts[1], { content: linked, rememberAuthor: true }); assert.equal(unbounded.data.comment.status, "approved"); rememberedCookie = cookieOf(unbounded.response);
      const token = rememberedCookie.split("=")[1], hash = createHash("sha256").update(token).digest("hex");
      const preference = (await pool.query("SELECT * FROM comment_author_tokens WHERE token_hash=$1", [hash])).rows[0]; assert.equal(preference.comment_id, unbounded.data.comment.id); assert.ok(!JSON.stringify(preference).includes(email));
      await pool.query("UPDATE comment_author_tokens SET expires_at=now()-interval '1 second' WHERE token_hash=$1", [hash]); assert.equal((await ok("/public/comment-author", "GET", undefined, rememberedCookie)).data.author, null);
      await pool.query("UPDATE comment_author_tokens SET expires_at=now()+interval '1 day' WHERE token_hash=$1", [hash]);
      await settings({ commentPreviouslyApproved: true });
      assert.equal((await submit(posts[1], { authorEmail: stamp + "-unknown@example.invalid" })).data.comment.status, "pending");
      assert.equal((await submit(posts[1], { authorEmail: email.toUpperCase() })).data.comment.status, "approved");
      await settings({ requireCommentNameEmail: false });
      assert.equal((await submit(posts[1], { authorName: "", authorEmail: "" })).data.comment.status, "pending");
    });
    await t.test("self notifications, failed submission, IP lists and consent lifecycle preserve privacy", async () => {
      await settings({ commentPreviouslyApproved: false, requireCommentNameEmail: true, notifyComments: true, notifyModeration: true });
      const before = (await mail()).length;
      assert.equal((await submit(posts[1], {}, author)).data.comment.status, "approved"); assert.equal((await mail()).length, before);
      await ok(`/posts/${posts[1].id}`, "PUT", { commentStatus: "closed" });
      const failed = await call("/public/comments", "POST", { postId: posts[1].id, authorName: "Reader", authorEmail: email, content: "Must not insert", rememberAuthor: true }, ""); assert.equal(failed.response.status, 409); assert.equal(failed.response.headers.get("set-cookie"), null); assert.equal((await mail()).length, before);
      await ok(`/posts/${posts[1].id}`, "PUT", { commentStatus: "open" });
      await settings({ disallowedCommentKeys: "127.0.0.1" }); assert.equal((await submit(posts[1])).data.comment.status, "trash"); assert.equal((await mail()).length, before);
      await settings({ disallowedCommentKeys: "", commentCookieConsent: false }); assert.equal((await ok("/public/comment-author", "GET", undefined, rememberedCookie)).data.author, null);
      await settings({ commentCookieConsent: true }); assert.equal((await ok("/public/comment-author", "GET", undefined, rememberedCookie)).data.author.authorEmail, email);
      const request = (await ok("/tools/privacy/requests", "POST", { type: "erase", email, sendConfirmation: false })).data.request; privacyId = request.id;
      await ok(`/tools/privacy/requests/${privacyId}/erase`, "POST", {}); assert.equal((await ok("/public/comment-author", "GET", undefined, rememberedCookie)).data.author, null);
    });
    await t.test("pagination toggle and default newest or oldest pages follow the selected comment order", async () => {
      for (let n = 0; n < 5; n++) comments.push((await ok("/comments", "POST", { postId: posts[0].id, authorName: "Page reader", authorEmail: email, content: "Page comment " + n, status: "approved" })).data.comment.id);
      await settings({ paginateComments: false, commentOrder: "asc", showAvatars: true, defaultAvatar: "identicon", avatarRating: "PG" });
      const all = (await ok(`/public/posts/${posts[0].slug}?commentPage=99`, "GET", undefined, "")).data;
      assert.equal(all.commentsPagination.page, 1); assert.equal(all.commentsPagination.totalPages, 1); assert.equal(all.comments.length, all.commentsPagination.totalComments); assert.ok(all.comments.length > 2);
      for (const comment of all.comments) {
        assert.equal(comment.authorEmail, undefined); assert.equal(comment._authorEmail, undefined);
        assert.match(comment.avatarUrl, /^https:\/\/secure\.gravatar\.com\/avatar\/[a-f0-9]{64}\?s=96&d=identicon&r=pg$/);
      }
      await settings({ paginateComments: true, commentsPerPage: 2, defaultCommentPage: "newest" });
      const newest = (await ok(`/public/posts/${posts[0].slug}`, "GET", undefined, "")).data; assert.equal(newest.commentsPagination.page, newest.commentsPagination.totalPages); assert.deepEqual(newest.comments.map((item: any) => item.id), all.comments.slice((newest.commentsPagination.page - 1) * 2).map((item: any) => item.id));
      const first = (await ok(`/public/posts/${posts[0].slug}?commentPage=1`, "GET", undefined, "")).data; assert.deepEqual(first.comments.map((item: any) => item.id), all.comments.slice(0, 2).map((item: any) => item.id));
      await settings({ commentOrder: "desc" });
      const descending = (await ok(`/public/posts/${posts[0].slug}`, "GET", undefined, "")).data; assert.equal(descending.commentsPagination.page, 1); assert.deepEqual(descending.comments.map((item: any) => item.id), all.comments.slice(-2).reverse().map((item: any) => item.id));
      await settings({ showAvatars: false });
      assert.ok((await ok(`/public/posts/${posts[0].slug}`, "GET", undefined, "")).data.comments.every((comment: any) => comment.avatarUrl === null));
    });
  } finally {
    if (settingsBefore) await settings(settingsBefore);
    for (const id of comments) await call(`/comments/${id}`, "DELETE");
    for (const post of posts) { await call(`/posts/${post.id}`, "PUT", { status: "trash" }); await call(`/posts/${post.id}`, "DELETE"); }
    if (privacyId) await call(`/tools/privacy/requests/${privacyId}`, "DELETE");
    await pool.query("DELETE FROM mail_outbox WHERE subject LIKE $1", ["%" + stamp + "%"]);
    if (author) await call("/auth/logout", "POST", {}, author);
    if (authorId) await call(`/users/${authorId}?deleteContent=true`, "DELETE");
    if (admin) await call("/auth/logout", "POST", {}, admin);
    await pool.end();
  }
});
