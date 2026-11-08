import test, { after } from "./isolated-test.js";
import assert from "node:assert/strict";
import { pool } from "../server/db.js";

const base = process.env.TEST_API_URL!, origin = process.env.APP_ORIGIN!;
after(() => pool.end());

test("public duplicate admission serializes real retries before rows, author cookies and notification mail", async t => {
  const original = (await pool.query("SELECT data FROM settings WHERE id=1")).rows[0].data;
  const posts: number[] = [], stamp = "comment-retry-" + Date.now();
  let admin = "";
  async function api(route: string, method = "GET", body?: unknown, cookie = admin) {
    const response = await fetch(base + route, { method, headers: { Origin: origin, Cookie: cookie, "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { response, data: await response.json() };
  }
  async function ok(route: string, method = "GET", body?: unknown) {
    const result = await api(route, method, body);
    assert.ok(result.response.ok, `${route}: ${result.response.status} ${JSON.stringify(result.data)}`);
    return result.data;
  }
  const mail = async () => Number((await pool.query("SELECT count(*) FROM mail_outbox WHERE subject LIKE $1", ["%" + stamp + "%"])).rows[0].count);
  // Independent duplicate-identity cases must be outside the separate flood
  // interval; age only this test's own predecessors, never the immediate retry.
  const ageAdmissions = () => pool.query("UPDATE comments SET created_at=date_trunc('second',clock_timestamp())-interval '20 seconds' WHERE post_id=ANY($1::int[])",[posts]);
  try {
    const signed = await api("/api/auth/login", "POST", { login: process.env.ADMIN_EMAIL, password: process.env.ADMIN_PASSWORD }, "");
    assert.equal(signed.response.status, 200); admin = signed.response.headers.get("set-cookie")!.split(";")[0];
    await ok("/api/settings", "PUT", { commentModeration: false, commentPreviouslyApproved: false, commentMaxLinks: 0, commentModerationKeys: "", disallowedCommentKeys: "", requireCommentNameEmail: true, commentRegistration: false, closeCommentsDays: 0, threadComments: true, threadDepth: 5, commentCookieConsent: true, notifyComments: true, notifyModeration: true });
    for (const suffix of ["one", "two"]) posts.push((await ok("/api/posts", "POST", { title: stamp + " " + suffix, status: "publish", commentStatus: "open", content: "<p>Retry fixture</p>" })).post.id);
    const parent = (await ok("/api/comments", "POST", { postId: posts[0], authorName: "Parent", authorEmail: "parent@example.test", content: "Parent body", status: "approved" })).comment;
    // Fixture administrative creation may notify; measure only actual admission.
    const before = await mail();
    const input = { postId: posts[0], authorName: "Retry guest", authorEmail: stamp + "@example.test", content: "<p>Retry body</p>", rememberAuthor: true };
    const submit = (extra: Record<string, unknown> = {}, cookie = "") => api("/api/public/comments", "POST", { ...input, ...extra }, cookie);
    let winner: Awaited<ReturnType<typeof submit>>;
    await t.test("simultaneous identical POSTs wait on the real shared lock and admit exactly one", async () => {
      const lock = await pool.connect();
      let waiting: Promise<Awaited<ReturnType<typeof submit>>[]> | undefined;
      try {
        await lock.query("BEGIN"); await lock.query("SELECT pg_advisory_xact_lock(hashtext('worldact-comment-hierarchy'))");
        const pid = (await lock.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
        waiting = Promise.all([submit(), submit()]);
        let blocked = false;
        for (let attempt = 0; attempt < 300; attempt++) {
          const count = Number((await pool.query("SELECT count(*) FROM pg_stat_activity WHERE datname=current_database() AND $1=ANY(pg_blocking_pids(pid)) AND query LIKE 'SELECT pg_advisory_xact_lock%'", [pid])).rows[0].count);
          if (count === 2) { blocked = true; break; }
          await new Promise(resolve => setTimeout(resolve, 10));
        }
        assert.ok(blocked, "both actual public requests must wait for this transaction");
        await lock.query("COMMIT");
        const results = await waiting; waiting = undefined;
        assert.deepEqual(results.map(result => result.response.status).sort(), [201, 409]);
        winner = results.find(result => result.response.status === 201)!;
        const loser = results.find(result => result.response.status === 409)!;
        assert.match(loser.data.error, /Duplicate comment detected/);
        assert.equal(loser.response.headers.get("set-cookie"), null);
        assert.doesNotMatch(JSON.stringify(loser.data), new RegExp(stamp));
        assert.equal(Number((await pool.query("SELECT count(*) FROM comments WHERE post_id=$1 AND author_name=$2", [posts[0], input.authorName])).rows[0].count), 1);
        assert.equal(await mail(), before + 1);
      } finally { await lock.query("ROLLBACK"); await waiting?.catch(() => {}); lock.release(); }
    });
    const admitted = winner!;
    await t.test("a rejected retry preserves an existing remembered-author preference and sends no mail", async () => {
      const cookie = admitted.response.headers.get("set-cookie")!.split(";")[0];
      assert.match(cookie, /^worldact_comment_author=[a-f0-9]{64}$/);
      const preference = (await pool.query("SELECT * FROM comment_author_tokens WHERE comment_id=$1", [admitted.data.comment.id])).rows;
      assert.equal(preference.length, 1);
      const result = await submit({ rememberAuthor: false }, cookie);
      assert.equal(result.response.status, 409); assert.equal(result.response.headers.get("set-cookie"), null);
      assert.deepEqual((await pool.query("SELECT * FROM comment_author_tokens WHERE comment_id=$1", [admitted.data.comment.id])).rows, preference);
      assert.equal(await mail(), before + 1);
    });
    await t.test("post, parent, name, email and content changes remain distinct; URL and email casing do not bypass duplicates", async () => {
      for (const extra of [{ postId: posts[1] }, { parentId: parent.id }, { authorName: "Another guest" }, { authorEmail: stamp + "-other@example.test" }, { content: "<p>Different body</p>" }]) {
        await ageAdmissions();
        assert.equal((await submit(extra)).response.status, 201);
      }
      for (const extra of [{ authorEmail: input.authorEmail.toUpperCase() }, { authorUrl: "https://example.test/new" }]) assert.equal((await submit(extra)).response.status, 409);
      await ok("/api/settings", "PUT", { requireCommentNameEmail: false });
      assert.equal((await submit({ authorEmail: "" })).response.status, 409, "a source no-email retry matches the same name/body regardless of the older email");
      await ok("/api/settings", "PUT", { requireCommentNameEmail: true });
    });
    await t.test("pending and spam predecessors block duplicates, while trash permits a new comment", async () => {
      for (const status of ["pending", "spam"]) {
        await pool.query("UPDATE comments SET status=$1 WHERE id=$2", [status, admitted.data.comment.id]);
        assert.equal((await submit()).response.status, 409);
      }
      await pool.query("UPDATE comments SET status='trash' WHERE id=$1", [admitted.data.comment.id]);
      await ageAdmissions();
      const retry = await submit(); assert.equal(retry.response.status, 201);
      assert.notEqual(retry.data.comment.id, admitted.data.comment.id);
    });
    await t.test("native source forms and authenticated REST creation share the actual duplicate boundary", async () => {
      await ageAdmissions();
      const form = new URLSearchParams({ comment_post_ID: String(posts[0]), author: "Native retry", email: stamp + "-native@example.test", comment: "<p>Native retry body</p>", "wp-comment-cookies-consent": "yes" });
      const count = await mail();
      const first = await fetch(base + "/wp-comments-post.php", { method: "POST", headers: { Origin: origin }, body: form, redirect: "manual" });
      assert.equal(first.status, 303); assert.match(first.headers.get("location")!, /#comment-/);
      const second = await fetch(base + "/wp-comments-post.php", { method: "POST", headers: { Origin: origin }, body: form, redirect: "manual" });
      assert.equal(second.status, 409); assert.equal(second.headers.get("set-cookie"), null);
      assert.match((await second.json()).error, /Duplicate comment detected/); assert.equal(await mail(), count + 1);
      const firstRest = await api("/wp-json/wp/v2/comments", "POST", { post: posts[0], content: "<p>REST retry body</p>" });
      assert.equal(firstRest.response.status, 201);
      const secondRest = await api("/wp-json/wp/v2/comments", "POST", { post: posts[0], content: "<p>REST retry body</p>" });
      assert.equal(secondRest.response.status, 409); assert.match(secondRest.data.message, /Duplicate comment detected/);
      assert.equal(secondRest.data.data.status, 409);
      assert.equal(Number((await pool.query("SELECT count(*) FROM comments WHERE post_id=$1 AND content=$2", [posts[0], "<p>REST retry body</p>"])).rows[0].count), 1);
    });
  } finally {
    await pool.query("DELETE FROM posts WHERE id=ANY($1::int[])", [posts]);
    await pool.query("DELETE FROM mail_outbox WHERE subject LIKE $1", ["%" + stamp + "%"]);
    await pool.query("UPDATE settings SET data=$1::jsonb WHERE id=1", [JSON.stringify(original)]);
  }
});
