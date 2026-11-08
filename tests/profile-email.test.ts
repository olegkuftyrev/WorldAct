import test, { after } from "./isolated-test.js";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import type { PoolClient } from "pg";
import { pool } from "../server/db.js";
const base = process.env.TEST_API_URL!, origin = process.env.APP_ORIGIN!;
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const cookie = (response: Response) => (response.headers.get("set-cookie") || "").split(";")[0];
async function api(path: string, method = "GET", body?: unknown, auth = "", requestOrigin = origin) {
  const response = await fetch(base + path, { method, signal: AbortSignal.timeout(12000), headers: { Origin: requestOrigin, "Content-Type": "application/json", ...(auth ? { Cookie: auth } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { response, data: await response.json() };
}
async function hold(db: PoolClient, id: number) { await db.query("BEGIN"); const pid = (await db.query("SELECT pg_backend_pid() AS pid")).rows[0].pid; await db.query("SELECT id FROM users WHERE id=$1 FOR UPDATE", [id]); return pid; }
async function blocked(pid: number, pattern: string, count = 1) {
  const end = Date.now() + 6000;
  do {
    const result = await pool.query(`WITH RECURSIVE blocked(pid) AS(SELECT $1::int UNION SELECT a.pid FROM pg_stat_activity a JOIN blocked b ON b.pid=ANY(pg_blocking_pids(a.pid)) WHERE a.datname=current_database()) SELECT a.pid FROM pg_stat_activity a JOIN blocked b ON b.pid=a.pid WHERE a.pid<>$1 AND position($2 in a.query)>0`, [pid, pattern]);
    if (result.rowCount === count) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  } while (Date.now() < end);
  assert.fail("Expected blocked requests: " + pattern);
}
after(async () => { await pool.end(); });

test("self-profile email confirmation preserves identity and serializes account changes safely", { timeout: 60000 }, async t => {
  const stamp = "profile-email-" + Date.now().toString(36), password = "Temporary-profile-password-" + stamp;
  const ids = new Set<number>(), emails = new Set<string>(), sessions = new Set<string>();
  const signed = await api("/api/auth/login", "POST", { login: process.env.ADMIN_EMAIL, password: process.env.ADMIN_PASSWORD }); assert.equal(signed.response.status, 200); const admin = cookie(signed.response);
  async function account(name: string, role = "subscriber", customEmail?: string) {
    const email = customEmail || stamp + "-" + name + "@example.test", username = stamp + "-" + name;
    const result = await api("/api/users", "POST", { username, email, password, role, displayName: name }, admin); assert.equal(result.response.status, 201, JSON.stringify(result.data)); ids.add(result.data.user.id); emails.add(email);
    const login = await api("/api/auth/login", "POST", { login: username, password }); assert.equal(login.response.status, 200); const auth = cookie(login.response); sessions.add(auth); return { ...result.data.user, auth };
  }
  async function request(user: any, suffix: string) {
    const email = stamp + "-" + suffix + "@example.test"; emails.add(email);
    const result = await api("/api/profile", "PUT", { email }, user.auth); assert.equal(result.response.status, 200, JSON.stringify(result.data)); assert.equal(result.data.user.email, user.email); assert.equal(result.data.pendingEmail.email, email); assert.equal(result.data.delivery, "local-outbox"); return { email, token: await latest(email) };
  }
  async function latest(email: string) { const row = (await pool.query("SELECT body FROM mail_outbox WHERE recipient=$1 ORDER BY id DESC LIMIT 1", [email])).rows[0]; const value = row?.body.match(/confirm-profile-email\?token=([a-f0-9]{64})/)?.[1]; assert.ok(value); return value as string; }
  async function pendingCount(id: number) { return (await pool.query("SELECT 1 FROM user_email_changes WHERE user_id=$1", [id])).rowCount; }
  try {
    await t.test("old addresses remain active until explicit own confirmation and tokens stay private", async () => {
      const user = await account("basic"), contact = (await pool.query("SELECT data->>'adminEmail' AS email FROM settings WHERE id=1")).rows[0].email;
      const next = await request(user, "basic-new"); const stored = (await pool.query("SELECT token_hash,previous_email FROM user_email_changes WHERE user_id=$1", [user.id])).rows[0]; assert.equal(stored.token_hash, hash(next.token)); assert.notEqual(stored.token_hash, next.token); assert.equal(stored.previous_email, user.email);
      const read = await api("/api/profile", "GET", undefined, user.auth); assert.equal(read.data.pendingEmail.email, next.email); assert.doesNotMatch(JSON.stringify(read.data), /token_hash|previous_email|password_hash/); assert.ok(!JSON.stringify(read.data).includes(next.token));
      assert.equal((await api("/api/profile/email/confirmation?token=" + next.token)).response.status, 401);
      const other = await account("other"); assert.equal((await api("/api/profile/email/confirmation?token=" + next.token, "GET", undefined, other.auth)).response.status, 410);
      assert.equal((await api("/api/profile/email/confirmation", "POST", { token: next.token }, user.auth, "https://foreign.invalid")).response.status, 403);
      assert.equal((await api("/api/profile/email/confirmation?token=" + next.token, "GET", undefined, user.auth)).response.status, 200); assert.equal((await pool.query("SELECT email FROM users WHERE id=$1", [user.id])).rows[0].email, user.email);
      assert.equal((await api("/api/auth/login", "POST", { login: next.email, password })).response.status, 401);
      const oldLogin = await api("/api/auth/login", "POST", { login: user.email, password }); assert.equal(oldLogin.response.status, 200); sessions.add(cookie(oldLogin.response));
      const archive = await api("/api/tools/export", "GET", undefined, admin); assert.ok(!JSON.stringify(archive.data).includes(next.token)); assert.ok(!JSON.stringify(archive.data).includes(stored.token_hash)); assert.ok(!JSON.stringify(archive.data).includes(next.email));
      const done = await api("/api/profile/email/confirmation", "POST", { token: next.token }, user.auth); assert.equal(done.response.status, 200, JSON.stringify(done.data)); assert.equal(done.data.user.email, next.email); assert.equal(done.data.pending, null); assert.equal((await api("/api/profile/email/confirmation", "POST", { token: next.token }, user.auth)).response.status, 410);
      assert.equal((await api("/api/auth/login", "POST", { login: user.email, password })).response.status, 401); const newLogin = await api("/api/auth/login", "POST", { login: next.email, password }); assert.equal(newLogin.response.status, 200); sessions.add(cookie(newLogin.response));
      assert.equal((await api("/api/session", "GET", undefined, user.auth)).data.user.email, next.email); assert.equal((await pool.query("SELECT data->>'adminEmail' AS email FROM settings WHERE id=1")).rows[0].email, contact);
      assert.equal((await pool.query("SELECT count(*)::int n FROM mail_outbox WHERE recipient=$1 AND body LIKE $2", [user.email, "%" + next.email + "%"])).rows[0].n, 1);
    });
    await t.test("every default role can request its own address and even an administrator confirms self-edits", async () => {
      for (const role of ["administrator", "editor", "author", "contributor"]) {
        const user = await account("own-" + role, role), email = stamp + "-own-new-" + role + "@example.test"; emails.add(email);
        const result = await api(role === "administrator" ? `/api/users/${user.id}` : "/api/profile", "PUT", { email }, user.auth);
        assert.equal(result.response.status, 200); assert.equal(result.data.user.email, user.email); assert.equal(result.data.pendingEmail.email, email);
        if (role === "administrator") {
          const token = await latest(email), results = await Promise.all([api("/api/profile/email/confirmation", "POST", { token }, user.auth), api("/api/profile/email/confirmation", "POST", { token }, user.auth)]); assert.deepEqual(results.map(result => result.response.status).sort(), [200, 410]);
        } else assert.equal((await api("/api/profile/email", "DELETE", undefined, user.auth)).response.status, 200);
      }
    });
    await t.test("replacement, resend, cancellation and expiry revoke old links while unrelated profile saves preserve pending state", async () => {
      const user = await account("rotate"), first = await request(user, "rotate-first"), second = await request(user, "rotate-second");
      assert.equal((await api("/api/profile/email/confirmation?token=" + first.token, "GET", undefined, user.auth)).response.status, 410);
      const saved = await api("/api/profile", "PUT", { email: user.email, displayName: "Unrelated save" }, user.auth); assert.equal(saved.data.pendingEmail.email, second.email);
      const resent = await api("/api/profile/email/resend", "POST", {}, user.auth); assert.equal(resent.response.status, 200); const third = await latest(second.email); assert.notEqual(third, second.token);
      assert.equal((await api("/api/profile/email/confirmation?token=" + second.token, "GET", undefined, user.auth)).response.status, 410);
      await pool.query("UPDATE user_email_changes SET expires_at=now()-interval '1 second' WHERE user_id=$1", [user.id]); assert.equal((await api("/api/profile/email", "GET", undefined, user.auth)).data.pending.expired, true); assert.equal((await api("/api/profile/email/confirmation", "POST", { token: third }, user.auth)).response.status, 410);
      assert.equal((await api("/api/profile/email/resend", "POST", {}, user.auth)).response.status, 200); const fourth = await latest(second.email);
      assert.equal((await api("/api/profile/email", "DELETE", undefined, user.auth)).response.status, 200); assert.equal(await pendingCount(user.id), 0); assert.equal((await api("/api/profile/email/confirmation?token=" + fourth, "GET", undefined, user.auth)).response.status, 410);
    });
    await t.test("administrators edit other accounts immediately and duplicate confirmation revalidates identity", async () => {
      const user = await account("duplicates"), next = await request(user, "duplicate-destination"), competitor = await account("competitor", "subscriber", next.email);
      assert.equal((await api("/api/profile/email/confirmation", "POST", { token: next.token }, user.auth)).response.status, 409); assert.equal(await pendingCount(user.id), 0); assert.equal((await pool.query("SELECT email FROM users WHERE id=$1", [competitor.id])).rows[0].email, next.email);
      const usernameCollision = await request(user, "username-destination"), unrelatedEmail = stamp + "-username-owner@example.test"; emails.add(unrelatedEmail);
      const owner = await api("/api/users", "POST", { username: usernameCollision.email, email: unrelatedEmail, password, role: "subscriber", displayName: "Username collision" }, admin); assert.equal(owner.response.status, 201); ids.add(owner.data.user.id);
      assert.equal((await api("/api/profile/email/confirmation", "POST", { token: usernameCollision.token }, user.auth)).response.status, 409); assert.equal(await pendingCount(user.id), 0);
      const pending = await request(user, "admin-replaces"), immediate = stamp + "-admin-immediate@example.test"; emails.add(immediate);
      const changed = await api(`/api/users/${user.id}`, "PUT", { email: immediate }, admin); assert.equal(changed.response.status, 200); assert.equal(changed.data.user.email, immediate); assert.equal(changed.data.pendingEmail, null); assert.equal(await pendingCount(user.id), 0); assert.equal((await api("/api/profile/email/confirmation?token=" + pending.token, "GET", undefined, user.auth)).response.status, 410);
    });
    await t.test("current-password rules remain enforced and credential changes invalidate older confirmation/reset links", async () => {
      const user = await account("password"), next = await request(user, "password-pending"), token = randomBytes(32).toString("hex"); await pool.query("INSERT INTO password_resets(token_hash,user_id,expires_at) VALUES($1,$2,now()+interval '30 minutes')", [hash(token), user.id]);
      assert.equal((await api("/api/profile", "PUT", { password: password + "-new", currentPassword: "wrong" }, user.auth)).response.status, 400); assert.equal(await pendingCount(user.id), 1);
      assert.equal((await api("/api/profile", "PUT", { password: password + "-new", currentPassword: password }, user.auth)).response.status, 200); assert.equal(await pendingCount(user.id), 0); assert.equal((await api("/api/profile/email/confirmation?token=" + next.token, "GET", undefined, user.auth)).response.status, 410);
      assert.equal((await api("/api/auth/reset-password", "POST", { token, password: password + "-stale-reset" })).response.status, 400);
      const freshEmail = stamp + "-combined-change@example.test"; emails.add(freshEmail);
      const combined = await api("/api/profile", "PUT", { password: password + "-combined", currentPassword: password + "-new", email: freshEmail }, user.auth); assert.equal(combined.response.status, 200); assert.equal(combined.data.user.email, user.email); assert.equal(combined.data.pendingEmail.email, freshEmail);
    });
    await t.test("a queued confirmation wins before old-address login and forgotten-password snapshots", async () => {
      const user = await account("identity-race"), next = await request(user, "identity-race-new"), locker = await pool.connect(); let pending: ReturnType<typeof api>[] = [];
      try {
        const pid = await hold(locker, user.id); const confirm = api("/api/profile/email/confirmation", "POST", { token: next.token }, user.auth); pending.push(confirm); await blocked(pid, "SELECT id,email,username FROM users WHERE id=$1 FOR UPDATE");
        const login = api("/api/auth/login", "POST", { login: user.email, password }), forgot = api("/api/auth/forgot-password", "POST", { login: user.email }); pending.push(login, forgot); await blocked(pid, "FOR SHARE"); await blocked(pid, "SELECT id,email FROM users WHERE id=$1 FOR UPDATE");
        await locker.query("COMMIT"); const [confirmed, oldLogin, oldForgot] = await Promise.all(pending); pending = []; assert.equal(confirmed.response.status, 200); assert.equal(oldLogin.response.status, 401); assert.equal(oldForgot.response.status, 200); assert.equal((await pool.query("SELECT 1 FROM password_resets WHERE user_id=$1", [user.id])).rowCount, 0);
        assert.equal((await pool.query("SELECT count(*)::int n FROM mail_outbox WHERE recipient=$1", [next.email])).rows[0].n, 1, "only the confirmation request, no stale reset");
      } finally { await locker.query("ROLLBACK"); await Promise.allSettled(pending); locker.release(); }
    });
    await t.test("a winning password reset invalidates already-authenticated waiting profile mutations", async () => {
      const user = await account("reset-race"), next = await request(user, "reset-race-pending"), token = randomBytes(32).toString("hex"); await pool.query("INSERT INTO password_resets(token_hash,user_id,expires_at) VALUES($1,$2,now()+interval '30 minutes')", [hash(token), user.id]);
      const locker = await pool.connect(); let pending: ReturnType<typeof api>[] = [];
      try {
        const pid = await hold(locker, user.id), reset = api("/api/auth/reset-password", "POST", { token, password: password + "-reset" }); pending.push(reset); await blocked(pid, "SELECT id FROM users WHERE id=$1 FOR UPDATE");
        const confirm = api("/api/profile/email/confirmation", "POST", { token: next.token }, user.auth), save = api("/api/profile", "PUT", { email: stamp + "-must-not-queue@example.test" }, user.auth); pending.push(confirm, save);
        await blocked(pid, "SELECT id,email,username FROM users WHERE id=$1 FOR UPDATE"); await blocked(pid, "ORDER BY id FOR UPDATE"); await locker.query("COMMIT"); const results = await Promise.all(pending); pending = [];
        assert.equal(results[0].response.status, 200); assert.equal(results[1].response.status, 401); assert.equal(results[2].response.status, 401); assert.equal(await pendingCount(user.id), 0); assert.equal((await pool.query("SELECT email FROM users WHERE id=$1", [user.id])).rows[0].email, user.email);
      } finally { await locker.query("ROLLBACK"); await Promise.allSettled(pending); locker.release(); }
    });
    await t.test("actor roles are revalidated and cross-administrator edits use one sorted row order", async () => {
      const actor = await account("actor", "administrator"), target = await account("target"), locker = await pool.connect(); let waiting: ReturnType<typeof api> | undefined;
      try {
        const pid = await hold(locker, actor.id); waiting = api(`/api/users/${target.id}`, "PUT", { displayName: "Must not save" }, actor.auth); await blocked(pid, "ORDER BY id FOR UPDATE"); await locker.query("UPDATE users SET role='subscriber' WHERE id=$1", [actor.id]); await locker.query("COMMIT"); assert.equal((await waiting).response.status, 403); waiting = undefined;
      } finally { await locker.query("ROLLBACK"); await waiting?.catch(() => {}); locker.release(); }
      const left = await account("left", "administrator"), right = await account("right", "administrator");
      const result = await Promise.all([api(`/api/users/${left.id}`, "PUT", { displayName: "Edited by right" }, right.auth), api(`/api/users/${right.id}`, "PUT", { displayName: "Edited by left" }, left.auth)]); assert.deepEqual(result.map(r => r.response.status), [200, 200]);
    });
    await t.test("account deletion removes pending state and a waiting token cannot recreate the account", async () => {
      const user = await account("delete"), next = await request(user, "delete-pending"), locker = await pool.connect(); let waiting: ReturnType<typeof api> | undefined;
      try {
        const pid = await hold(locker, user.id); waiting = api("/api/profile/email/confirmation", "POST", { token: next.token }, user.auth); await blocked(pid, "SELECT id,email,username FROM users WHERE id=$1 FOR UPDATE"); await locker.query("DELETE FROM users WHERE id=$1", [user.id]); await locker.query("COMMIT"); ids.delete(user.id); assert.equal((await waiting).response.status, 410); waiting = undefined; assert.equal(await pendingCount(user.id), 0); assert.equal((await pool.query("SELECT 1 FROM sessions WHERE user_id=$1", [user.id])).rowCount, 0);
      } finally { await locker.query("ROLLBACK"); await waiting?.catch(() => {}); locker.release(); }
    });
  } finally {
    for (const id of ids) assert.equal((await api(`/api/users/${id}`, "DELETE", undefined, admin)).response.status, 200);
    await pool.query("DELETE FROM mail_outbox WHERE recipient=ANY($1::text[]) OR body LIKE $2", [[...emails], "%" + stamp + "%"]);
    for (const session of sessions) await api("/api/auth/logout", "POST", undefined, session);
    await api("/api/auth/logout", "POST", undefined, admin);
  }
});
