import test, { after } from "./isolated-test.js";
import "dotenv/config";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import type { PoolClient } from "pg";
import { pool } from "../server/db.js";
import { verifyPassword } from "../server/auth.js";
const base = process.env.TEST_API_URL || "http://127.0.0.1:3001";
const origin = process.env.APP_ORIGIN || "http://127.0.0.1:5173";
const smtpActive = !!process.env.SMTP_HOST && process.env.WORLDACT_MAIL_MODE !== "outbox" && process.env.NODE_ENV !== "test";
const hash = (token: string) => createHash("sha256").update(token).digest("hex");
const cookieOf = (response: Response) => (response.headers.get("set-cookie") || "").split(";")[0];
async function api(path: string, method = "GET", body?: unknown, cookie = "") {
  const response = await fetch(base + path, {
    method, signal: AbortSignal.timeout(10_000),
    headers: { Origin: origin, "Content-Type": "application/json", ...(cookie ? { Cookie: cookie } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { response, data: await response.json() };
}
async function barrier(client: PoolClient, userId: number) {
  await client.query("BEGIN");
  const pid = (await client.query("SELECT pg_backend_pid() AS id")).rows[0].id as number;
  await client.query("SELECT id FROM users WHERE id=$1 FOR UPDATE", [userId]);
  return pid;
}
// PostgreSQL may queue the second tuple waiter behind the first waiter;
// follow the lock graph to prove both ultimately wait on our held account.
async function waitForBlocked(blocker: number, queryIncludes: string, expected = 1) {
  const deadline = Date.now() + 5000;
  do {
    const result = await pool.query(
      `WITH RECURSIVE blocked(pid) AS (
         SELECT $1::int
         UNION SELECT a.pid FROM pg_stat_activity a JOIN blocked b ON b.pid=ANY(pg_blocking_pids(a.pid)) WHERE a.datname=current_database()
       ) SELECT a.pid FROM pg_stat_activity a JOIN blocked b ON b.pid=a.pid WHERE a.pid<>$1 AND position($2 in a.query)>0`,
      [blocker, queryIncludes],
    );
    if (result.rowCount === expected) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  } while (Date.now() < deadline);
  assert.fail("Expected " + expected + " requests blocked on the user row: " + queryIncludes);
}
async function token(userId: number) {
  const value = randomBytes(32).toString("hex");
  await pool.query("INSERT INTO password_resets(token_hash,user_id,expires_at) VALUES($1,$2,now()+interval '30 minutes')", [hash(value), userId]);
  return value;
}
after(async () => { await pool.end(); });

test("password reset and forgotten-password requests serialize safely with revocation and account deletion", { skip: smtpActive, timeout: 30_000 }, async t => {
  const stamp = "reset-race-" + Date.now().toString(36), password = "Temporary-" + stamp + "-password";
  const createdIds = new Set<number>(), emails: string[] = [], cookies: string[] = [];
  const signed = await api("/api/auth/login", "POST", { login: process.env.ADMIN_EMAIL, password: process.env.ADMIN_PASSWORD });
  assert.equal(signed.response.status, 200); const admin = cookieOf(signed.response);
  async function account(suffix: string) {
    const email = stamp + "-" + suffix + "@example.test", username = stamp + "-" + suffix;
    const created = await api("/api/users", "POST", { username, email, password, role: "subscriber", displayName: "Reset concurrency fixture" }, admin);
    assert.equal(created.response.status, 201, JSON.stringify(created.data));
    createdIds.add(created.data.user.id); emails.push(email); return created.data.user as { id: number; username: string; email: string };
  }
  async function noSessionsOrTokens(userId: number) {
    assert.equal((await pool.query("SELECT 1 FROM sessions WHERE user_id=$1", [userId])).rowCount, 0);
    assert.equal((await pool.query("SELECT 1 FROM password_resets WHERE user_id=$1", [userId])).rowCount, 0);
  }
  try {
    await t.test("two valid tokens wait for the same account and exactly one password reset wins", async () => {
      const user = await account("two-tokens"), tokens = [await token(user.id), await token(user.id)];
      for (let i = 0; i < 2; i++) {
        const login = await api("/api/auth/login", "POST", { login: user.username, password }); assert.equal(login.response.status, 200);
        cookies.push(cookieOf(login.response));
      }
      const oldCookies = cookies.slice(-2), next = [password + "-first", password + "-second"];
      const locker = await pool.connect(); let requests: Array<ReturnType<typeof api>> = [];
      try {
        const pid = await barrier(locker, user.id);
        requests = tokens.map((value, index) => api("/api/auth/reset-password", "POST", { token: value, password: next[index] }));
        await waitForBlocked(pid, "SELECT id FROM users WHERE id=$1 FOR UPDATE", 2);
        assert.equal((await pool.query("SELECT 1 FROM password_resets WHERE user_id=$1", [user.id])).rowCount, 2, "Neither token can be consumed before the user lock");
        assert.equal((await pool.query("SELECT 1 FROM sessions WHERE user_id=$1", [user.id])).rowCount, 2);
        await locker.query("COMMIT");
        const results = await Promise.all(requests); requests = [];
        assert.deepEqual(results.map(result => result.response.status).sort(), [200, 400]);
        const winner = results.findIndex(result => result.response.status === 200), loser = 1 - winner;
        assert.deepEqual(results[winner].data, { ok: true });
        assert.deepEqual(results[loser].data, { error: "This password reset link has expired or has already been used." });
        for (const result of results) assert.equal(result.response.headers.get("set-cookie"), null);
        const currentHash = (await pool.query("SELECT password_hash FROM users WHERE id=$1", [user.id])).rows[0].password_hash;
        assert.equal(await verifyPassword(next[winner], currentHash), true); assert.equal(await verifyPassword(next[loser], currentHash), false);
        await noSessionsOrTokens(user.id);
        for (const cookie of oldCookies) assert.equal((await api("/api/session", "GET", undefined, cookie)).data.user, null);
        for (const value of tokens) assert.equal((await api("/api/auth/reset-password", "POST", { token: value, password: password + "-replay" })).response.status, 400);
      } finally {
        await locker.query("ROLLBACK"); await Promise.allSettled(requests); locker.release();
      }
    });
    await t.test("a forgotten-password request cannot queue a token or mail after its account is deleted", async () => {
      const user = await account("forgot-delete"); await token(user.id);
      const locker = await pool.connect(); let request: ReturnType<typeof api> | undefined;
      try {
        const pid = await barrier(locker, user.id);
        request = api("/api/auth/forgot-password", "POST", { login: user.username });
        await waitForBlocked(pid, "SELECT id,email FROM users WHERE id=$1 FOR UPDATE");
        await locker.query("DELETE FROM users WHERE id=$1", [user.id]); await locker.query("COMMIT"); createdIds.delete(user.id);
        const result = await request; request = undefined;
        const unknown = await api("/api/auth/forgot-password", "POST", { login: stamp + "-unknown" });
        assert.equal(result.response.status, 200); assert.deepEqual(result.data, unknown.data);
        assert.equal(result.data.delivery, "local-outbox"); assert.equal(result.response.headers.get("set-cookie"), null);
        assert.equal((await pool.query("SELECT 1 FROM users WHERE id=$1", [user.id])).rowCount, 0);
        await noSessionsOrTokens(user.id);
        assert.equal((await pool.query("SELECT 1 FROM mail_outbox WHERE recipient=$1", [user.email])).rowCount, 0);
      } finally { await locker.query("ROLLBACK"); if (request) await request.catch(() => {}); locker.release(); }
    });
    await t.test("account deletion wins a blocked reset without a token-first deadlock or replacement session", async () => {
      const user = await account("reset-delete"), value = await token(user.id);
      const login = await api("/api/auth/login", "POST", { login: user.username, password }); assert.equal(login.response.status, 200);
      const previous = cookieOf(login.response); cookies.push(previous);
      const locker = await pool.connect(); let request: ReturnType<typeof api> | undefined;
      try {
        const pid = await barrier(locker, user.id);
        request = api("/api/auth/reset-password", "POST", { token: value, password: password + "-deleted" });
        await waitForBlocked(pid, "SELECT id FROM users WHERE id=$1 FOR UPDATE");
        assert.equal((await pool.query("SELECT 1 FROM password_resets WHERE token_hash=$1", [hash(value)])).rowCount, 1);
        await locker.query("DELETE FROM users WHERE id=$1", [user.id]); await locker.query("COMMIT"); createdIds.delete(user.id);
        const result = await request; request = undefined;
        assert.equal(result.response.status, 400); assert.deepEqual(result.data, { error: "This password reset link has expired or has already been used." });
        assert.equal(result.response.headers.get("set-cookie"), null); await noSessionsOrTokens(user.id);
        assert.equal((await api("/api/session", "GET", undefined, previous)).data.user, null);
        assert.equal((await pool.query("SELECT 1 FROM mail_outbox WHERE recipient=$1", [user.email])).rowCount, 0);
      } finally { await locker.query("ROLLBACK"); if (request) await request.catch(() => {}); locker.release(); }
    });
    await t.test("forgotten-password replacement commits one hashed token with one local outbox message", async () => {
      const user = await account("forgot-valid"), old = await token(user.id);
      const result = await api("/api/auth/forgot-password", "POST", { login: user.email.toUpperCase() });
      assert.equal(result.response.status, 200); assert.equal(result.data.delivery, "local-outbox"); assert.equal(result.response.headers.get("set-cookie"), null);
      const records = (await pool.query("SELECT token_hash FROM password_resets WHERE user_id=$1", [user.id])).rows; assert.equal(records.length, 1); assert.notEqual(records[0].token_hash, hash(old));
      const mail = (await pool.query("SELECT body,delivered FROM mail_outbox WHERE recipient=$1", [user.email])).rows;
      assert.equal(mail.length, 1); assert.equal(mail[0].delivered, false);
      const value = mail[0].body.match(/reset-password\?token=([a-f0-9]{64})/)?.[1]; assert.ok(value); assert.equal(records[0].token_hash, hash(value));
      assert.ok(!JSON.stringify(result.data).includes(value));
      const reset = await api("/api/auth/reset-password", "POST", { token: value, password: password + "-outbox" }); assert.equal(reset.response.status, 200); await noSessionsOrTokens(user.id);
    });
  } finally {
    for (const id of createdIds) { const removed = await api("/api/users/" + id, "DELETE", undefined, admin); assert.equal(removed.response.status, 200, JSON.stringify(removed.data)); }
    await pool.query("DELETE FROM mail_outbox WHERE recipient=ANY($1::text[])", [emails]);
    for (const cookie of cookies) await api("/api/auth/logout", "POST", undefined, cookie);
    await api("/api/auth/logout", "POST", undefined, admin);
  }
});
