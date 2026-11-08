import test, { after } from "./isolated-test.js";
import assert from "node:assert/strict";
import { pool } from "../server/db.js";
import { approvalFixture } from "./comment-approval-fixtures.js";
after(() => pool.end());

async function blocked(pid: number, pattern: string) {
  const end = Date.now() + 6000;
  do {
    const rows = await pool.query("WITH RECURSIVE waiting(pid) AS(SELECT $1::int UNION SELECT a.pid FROM pg_stat_activity a JOIN waiting w ON w.pid=ANY(pg_blocking_pids(a.pid)) WHERE a.datname=current_database()) SELECT a.pid FROM pg_stat_activity a JOIN waiting w ON w.pid=a.pid WHERE a.pid<>$1 AND position($2 in a.query)>0", [pid, pattern]);
    if (rows.rowCount) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  } while (Date.now() < end);
  assert.fail("Actual HTTP request did not wait for the expected protected row: " + pattern);
}

test("public approval uses current protected actor/post identity and rejects sign-ins revoked during actual waits", { timeout: 60000 }, async t => {
  const f = await approvalFixture("approval-waits"), post = await f.post();
  await f.ok("/api/settings", "PUT", { commentModeration: true, commentPreviouslyApproved: true });
  const counts = async () => (await pool.query("SELECT (SELECT count(*) FROM comments)::int AS comments,(SELECT count(*) FROM comment_author_tokens)::int AS tokens,(SELECT count(*) FROM mail_outbox)::int AS mail")).rows[0];
  try {
    await t.test("ordinary actor changes block admission and committed demotion/name/email/profile replace middleware values", async () => {
      const actor = await f.account("demoted", "editor"), lock = await pool.connect(); let request: ReturnType<typeof f.submit> | undefined;
      try {
        await lock.query("BEGIN"); await lock.query("SELECT id FROM users WHERE id=$1 FOR NO KEY UPDATE", [actor.id]);
        const pid = (await lock.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
        request = f.submit(post.id, { content: "Current demoted actor identity" }, actor.auth);
        await blocked(pid, "FROM users WHERE id=$1 FOR SHARE");
        const email = f.stamp + "-current@example.test";
        await lock.query("UPDATE users SET role='subscriber',display_name='Current actor',email=$2,profile=profile || '{\"website\":\"https://current.example.test/profile/\"}'::jsonb WHERE id=$1", [actor.id,email]);
        await lock.query("COMMIT"); const result = await request; request = undefined;
        assert.equal(result.response.status, 201, JSON.stringify(result.data)); assert.equal(result.data.comment.status, "pending");
        assert.deepEqual((await pool.query("SELECT author_name,author_email,author_url,user_id FROM comments WHERE id=$1", [result.data.comment.id])).rows[0], { author_name: "Current actor", author_email: email, author_url: "https://current.example.test/profile/", user_id: actor.id });
      } finally { await lock.query("ROLLBACK"); await request?.catch(() => {}); lock.release(); }
    });
    await t.test("post-author approval reads the actual post row after a real ownership wait", async () => {
      const actor = await f.account("former-owner", "author"), ownPost = await f.post(actor.id), lock = await pool.connect(); let request: ReturnType<typeof f.submit> | undefined;
      try {
        await lock.query("BEGIN"); await lock.query("SELECT id FROM posts WHERE id=$1 FOR NO KEY UPDATE", [ownPost.id]);
        const pid = (await lock.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
        request = f.submit(ownPost.id, { content: "Ownership changed while waiting" }, actor.auth);
        await blocked(pid, "FROM posts WHERE id=$1 FOR SHARE");
        await lock.query("UPDATE posts SET author_id=$2 WHERE id=$1", [ownPost.id,f.adminUser.id]);
        await lock.query("COMMIT"); const result = await request; request = undefined;
        assert.equal(result.response.status, 201); assert.equal(result.data.comment.status, "pending");
      } finally { await lock.query("ROLLBACK"); await request?.catch(() => {}); lock.release(); }
    });
    for (const mode of ["logout", "expiry", "application-password"] as const) await t.test(mode + " during a real hierarchy wait rejects without rows, tokens, cookies or mail", async () => {
      const actor = await f.account(mode, "editor"), lock = await pool.connect(); let request: ReturnType<typeof f.submit> | undefined;
      let headers: Record<string,string> = {}, application: any;
      if (mode === "application-password") {
        application = await f.ok("/api/profile/application-passwords", "POST", { name: "Waiting comment client" }, actor.auth);
        headers = { Authorization: "Basic " + Buffer.from(actor.username + ":" + application.password.replace(/\s/g, "")).toString("base64") };
      }
      try {
        await lock.query("BEGIN"); await lock.query("SELECT pg_advisory_xact_lock(hashtext('worldact-comment-hierarchy'))");
        const pid = (await lock.query("SELECT pg_backend_pid() AS pid")).rows[0].pid, before = await counts();
        request = f.submit(post.id, { content: "Rejected waiting " + mode, rememberAuthor: true }, mode === "application-password" ? "" : actor.auth, headers);
        await blocked(pid, "SELECT pg_advisory_xact_lock");
        if (mode === "logout") await f.ok("/api/auth/logout", "POST", {}, actor.auth);
        else if (mode === "application-password") await f.ok("/api/profile/application-passwords/" + application.applicationPassword.uuid, "DELETE", undefined, actor.auth);
        else {
          // The expiry is later than the admission transaction's now(), then
          // actually elapses while that transaction remains blocked.
          await pool.query("UPDATE sessions SET expires_at=clock_timestamp()+interval '100 milliseconds' WHERE user_id=$1", [actor.id]);
          while (!(await pool.query("SELECT bool_and(expires_at<=clock_timestamp()) AS expired FROM sessions WHERE user_id=$1", [actor.id])).rows[0].expired) await new Promise(resolve => setTimeout(resolve, 10));
        }
        await lock.query("COMMIT"); const result = await request; request = undefined;
        assert.equal(result.response.status, 401, JSON.stringify(result.data)); assert.equal(result.response.headers.get("set-cookie"), null);
        assert.deepEqual(await counts(), before); assert.doesNotMatch(JSON.stringify(result.data), /@example\.test|token_hash|key_hash|password_hash/);
      } finally { await lock.query("ROLLBACK"); await request?.catch(() => {}); lock.release(); }
    });
    await t.test("an actor deleted after middleware authentication cannot leave a privileged comment", async () => {
      const actor = await f.account("deleted", "editor"), lock = await pool.connect(); let request: ReturnType<typeof f.submit> | undefined;
      try {
        await lock.query("BEGIN"); await lock.query("SELECT id FROM users WHERE id=$1 FOR UPDATE", [actor.id]);
        const pid = (await lock.query("SELECT pg_backend_pid() AS pid")).rows[0].pid, before = await counts();
        request = f.submit(post.id, { content: "Deleted actor request", rememberAuthor: true }, actor.auth);
        await blocked(pid, "FROM users WHERE id=$1 FOR SHARE"); await lock.query("DELETE FROM users WHERE id=$1", [actor.id]);
        await lock.query("COMMIT"); const result = await request; request = undefined;
        assert.equal(result.response.status, 401); assert.equal(result.response.headers.get("set-cookie"), null); assert.deepEqual(await counts(), before);
      } finally { await lock.query("ROLLBACK"); await request?.catch(() => {}); lock.release(); }
    });
  } finally { await f.dispose(); }
});
