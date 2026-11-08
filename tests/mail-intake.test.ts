import test, { before, after, beforeEach } from "./isolated-test.js";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { pool, userFields, type User } from "../server/db.js";
import type { AuthRequest } from "../server/auth.js";
import { checkMailIntake, updateMailIntakeConfiguration, readMailIntakeConfiguration } from "../server/mail-intake.js";
import { POP3Error } from "../server/pop3.js";

const base = process.env.TEST_API_URL!, origin = process.env.APP_ORIGIN!;
let actor: AuthRequest, cookie = "", subscriberCookie = "", category: number;
const people: User[] = [], password = "Mailbox-isolated-R9s-Z6k-4Hv";
const configuration = { host: "mail.example.test", username: "mailbox", password: "fake-mailbox-secret", secure: true, port: 995, enabled: true };
async function request(route: string, method = "GET", body?: unknown, auth = cookie) {
  const response = await fetch(base + "/api" + route, { method, headers: { Origin: origin, "Content-Type": "application/json", ...(auth ? { Cookie: auth } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { status: response.status, data: await response.json(), cookie: response.headers.get("set-cookie")?.split(";")[0] };
}
async function login(login = process.env.ADMIN_EMAIL!, secret = process.env.ADMIN_PASSWORD!) {
  const result = await request("/auth/login", "POST", { login, password: secret }, "");
  assert.equal(result.status, 200); return { user: result.data.user, cookie: result.cookie! };
}
const requestActor = (session: Awaited<ReturnType<typeof login>>) => ({ user: session.user, headers: { cookie: session.cookie }, authenticationMethod: "session" }) as AuthRequest;
async function cleanPosts() {
  await pool.query("DELETE FROM posts WHERE id IN (SELECT post_id FROM mail_intake_receipts WHERE post_id IS NOT NULL)");
  await pool.query("DELETE FROM mail_intake_receipts");
}
before(async () => {
  const session = await login(); cookie = session.cookie; actor = requestActor(session);
  for (const role of ["author", "contributor", "subscriber"] as const) {
    const name = "mail-fixture-" + role + "-" + Date.now();
    const result = await request("/users", "POST", { username: name, email: name + "@example.test", displayName: name, password, role });
    assert.equal(result.status, 201); people.push(result.data.user);
  }
  subscriberCookie = (await login(people[2].email, password)).cookie;
  category = (await pool.query("INSERT INTO terms(taxonomy,name,slug) VALUES('category','Mail fixture category','mail-fixture-category') RETURNING id")).rows[0].id;
});
beforeEach(async () => {
  await cleanPosts();
  await pool.query("UPDATE mail_intake_configuration SET generation=gen_random_uuid(),host='',username='',password='',port=110,secure=false,enabled=false,polling=false,category_id=NULL,configured_by=NULL,last_checked=NULL,lease_token=NULL,lease_until=NULL,outcome='',summary='{}'::jsonb WHERE id=1");
});
after(async () => {
  try {
    await cleanPosts();
    await pool.query("DELETE FROM users WHERE id=ANY($1::int[])", [people.map(person => person.id)]);
    await pool.query("DELETE FROM terms WHERE id=$1", [category]);
    await pool.query("UPDATE mail_intake_configuration SET generation=gen_random_uuid(),host='',username='',password='',port=110,secure=false,enabled=false,polling=false,category_id=NULL,configured_by=NULL,last_checked=NULL,lease_token=NULL,lease_until=NULL,outcome='',summary='{}'::jsonb WHERE id=1");
  } finally { await pool.end(); }
});
function message(sender: string, body = "Mailbox body <literal>", extra = "") {
  return Buffer.from(`From: ${sender}\r\nSubject: Mail fixture subject::ignored\r\n${extra}Content-Type: text/plain; charset=utf-8\r\n\r\n${body}\r\n`);
}
function peer(raw: Buffer, options: { uid?: string; failDelete?: boolean; failQuit?: boolean; heldRetrieve?: Promise<void>; onRetrieve?: () => void; onDelete?: () => Promise<void>; holdClose?: Promise<void> } = {}) {
  const calls: string[] = [];
  const open = async () => ({
    closed: options.holdClose || Promise.resolve(),
    list: async () => [{ number: 1, uid: options.uid || "fixture-uid", size: raw.length }],
    retrieve: async () => { calls.push("RETR"); options.onRetrieve?.(); await options.heldRetrieve; return Buffer.from(raw); },
    remove: async () => { calls.push("DELE"); await options.onDelete?.(); if (options.failDelete) throw new POP3Error("unavailable"); },
    quit: async () => { calls.push("QUIT"); if (options.failQuit) throw new POP3Error("unavailable"); },
    abort: async () => { calls.push("CLOSE"); await options.holdClose; },
  });
  return { open, calls };
}
async function enable(value: Record<string, unknown> = {}) { await updateMailIntakeConfiguration(actor, { ...configuration, categoryId: category, ...value }); }
async function allowCheck() { await pool.query("UPDATE mail_intake_configuration SET last_checked=NULL WHERE id=1"); }
const receipts = async () => (await pool.query("SELECT * FROM mail_intake_receipts ORDER BY created_at")).rows;
async function imported() { return (await pool.query(`SELECT ${userFields.split(",").map(field => "u." + field.trim()).join(",")},p.id AS "postId",p.title,p.content,p.raw_content,p.status,p.published_at,p.scheduled_at FROM posts p JOIN mail_intake_receipts r ON r.post_id=p.id JOIN users u ON u.id=p.author_id`)).rows; }

test("mailbox settings are administrator-only, write-only, versioned and absent from public/archive output", async () => {
  assert.equal((await request("/tools/mail-intake", "GET", undefined, "")).status, 401);
  assert.equal((await request("/tools/mail-intake", "PUT", configuration, subscriberCookie)).status, 403);
  assert.equal((await request("/tools/mail-intake/check", "POST", {})).status, 409);
  const saved = await request("/tools/mail-intake", "PUT", { ...configuration, polling: true, categoryId: category });
  assert.equal(saved.status, 200); assert.equal(saved.data.mailbox.passwordConfigured, true);
  assert.equal(saved.data.mailbox.automaticChecksActive, false); assert.equal(saved.data.mailbox.environment, "local");
  assert.ok(!JSON.stringify(saved.data).includes(configuration.password));
  const version = saved.data.mailbox.version;
  assert.equal((await request("/tools/mail-intake", "PUT", { version, password: "", username: "retained" })).status, 200);
  assert.equal((await pool.query("SELECT password FROM mail_intake_configuration")).rows[0].password, configuration.password);
  assert.equal((await request("/tools/mail-intake", "PUT", { version, username: "stale" })).status, 409);
  for (const value of [{ host: "127.0.0.1" }, { host: "example.test:443" }, { username: "bad\r\nDELE 1" }, { port: 110 }, { arbitrary: true }])
    assert.equal((await request("/tools/mail-intake", "PUT", value)).status, 400);
  const publicSite = await request("/public/site"), archive = await request("/tools/export?format=json");
  assert.equal(publicSite.status, 200); assert.equal(archive.status, 200);
  for (const output of [publicSite.data, archive.data]) {
    assert.ok(!JSON.stringify(output).includes(configuration.password)); assert.ok(!JSON.stringify(output).includes(configuration.host));
  }
  const cleared = await request("/tools/mail-intake", "PUT", { clearPassword: true, enabled: false, polling: false });
  assert.equal(cleared.status, 200); assert.equal(cleared.data.mailbox.passwordConfigured, false);
});

test("matched publish capability and pending lower/unknown senders use ordinary category, sanitizer and publication semantics", async () => {
  await enable();
  const cases = [
    { sender: people[0].email, author: people[0].id, status: "publish" },
    { sender: people[1].email, author: people[1].id, status: "pending" },
    { sender: people[2].email, author: people[2].id, status: "pending" },
    { sender: "unknown@example.test", author: actor.user!.id, status: "pending" },
  ];
  for (const [index, item] of cases.entries()) {
    await allowCheck();
    const f = peer(message(item.sender, "ignored::Body <literal>::ignored", "Date: Fri, 20 Mar 2020 20:32:37 +0100\r\n"), { uid: "identity-" + index, onDelete: async () => {
      const rows = await receipts(); assert.equal(rows.length, index + 1); assert.ok(rows.at(-1)!.post_id);
    } });
    const result = await checkMailIntake(actor, f.open); assert.equal(result.imported, 1); assert.equal(result.deletionCommitted, 1);
    const row = (await imported()).find(row => row.id === item.author && row.status === item.status)!;
    assert.ok(row); assert.equal(row.title, "Mail fixture subject"); assert.equal(row.raw_content, "Body &lt;literal&gt;");
    assert.equal(new Date(row.published_at).toISOString(), "2020-03-20T19:32:37.000Z");
    assert.equal((await pool.query("SELECT term_id FROM post_terms WHERE post_id=$1", [row.postId])).rows[0].term_id, category);
  }
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM outgoing_ping_jobs WHERE post_id IN(SELECT post_id FROM mail_intake_receipts) AND state='suppressed'")).rows[0].n, 1);
});

test("HTML mail is sanitized, title/body conventions survive and future publisher dates schedule normally", async () => {
  await enable();
  const future = new Date(Date.now() + 86_400_000).toUTCString();
  const raw = Buffer.from(`From: ${people[0].email}\r\nSubject: Mail fixture fallback\r\nDate: ${future}\r\nContent-Type: text/html\r\n\r\n<title>Mail fixture embedded title</title><p><strong>Kept</strong><script>alert(1)</script><a href="javascript:alert(2)">safe</a></p>`);
  await checkMailIntake(actor, peer(raw).open);
  const [post] = await imported(); assert.equal(post.status, "future"); assert.equal(post.title, "Mail fixture embedded title");
  assert.equal(new Date(post.scheduled_at).toUTCString(), future); assert.match(post.content, /<strong>Kept<\/strong>/); assert.doesNotMatch(post.content, /script|javascript:|alert/);
});

test("durable UIDL receipts survive deletion failure, credential rotation and deleted posts without duplicate creation", async () => {
  await enable(); const raw = message(people[0].email);
  const first = peer(raw, { failQuit: true }); await assert.rejects(checkMailIntake(actor, first.open), (error: any) => error.status === 502);
  assert.deepEqual(first.calls, ["RETR", "DELE", "QUIT", "CLOSE"]); assert.equal((await receipts()).length, 1);
  const id = (await receipts())[0].post_id;
  await pool.query("DELETE FROM posts WHERE id=$1", [id]); assert.equal((await receipts())[0].post_id, null);
  await updateMailIntakeConfiguration(actor, { password: "fake-rotated-secret" }); await allowCheck();
  const second = peer(raw), result = await checkMailIntake(actor, second.open);
  assert.equal(result.imported, 0); assert.equal(result.duplicates, 1); assert.deepEqual(second.calls, ["DELE", "QUIT", "CLOSE"]);
  assert.equal((await imported()).length, 0); assert.equal((await receipts()).length, 1);
});

test("unsupported mail remains on the server and oversized/unbounded mailbox work is limited", async () => {
  await enable();
  const raw = Buffer.from(`From: ${people[0].email}\r\nSubject: Mail fixture attachment\r\nContent-Type: text/plain; name*=utf-8''file.txt\r\n\r\nNot imported`);
  const f = peer(raw), result = await checkMailIntake(actor, f.open);
  assert.equal(result.skipped, 1); assert.ok(!f.calls.includes("DELE")); assert.equal((await receipts()).length, 0);
  await allowCheck(); let retrieves = 0, removes = 0;
  const valid = message(people[0].email);
  const limited = async () => ({ closed: Promise.resolve(), list: async () => Array.from({ length: 1000 }, (_, i) => ({ number: i + 1, uid: "bounded-" + i, size: i < 3 ? 2 * 1024 * 1024 : valid.length })), retrieve: async () => { retrieves++; return valid; }, remove: async () => { removes++; }, quit: async () => {}, abort: async () => {} });
  const bounded = await checkMailIntake(actor, limited); assert.equal(bounded.examined, 20); assert.equal(bounded.skipped, 3); assert.equal(retrieves, 17); assert.equal(removes, 17);
});

test("remote retrieval holds no pool client; new configuration, revoked authentication and expired leases cannot publish or delete", async () => {
  for (const change of ["configuration", "session", "lease"] as const) {
    await cleanPosts(); await allowCheck(); await enable();
    const fresh = await login(), req = requestActor(fresh);
    let release!: () => void, entered!: () => void;
    const barrier = new Promise<void>(resolve => { release = resolve; }), started = new Promise<void>(resolve => { entered = resolve; });
    const f = peer(message(people[0].email), { uid: change, heldRetrieve: barrier, onRetrieve: entered });
    const pending = checkMailIntake(req, f.open), rejected = assert.rejects(pending, (error: any) => [401, 409].includes(error.status));
    try {
      await started;
      const all = await Promise.all(Array.from({ length: 10 }, () => pool.connect())); all.forEach(client => client.release());
      if (change === "configuration") await updateMailIntakeConfiguration(actor, { username: "replacement" });
      if (change === "session") await pool.query("DELETE FROM sessions WHERE token_hash=$1", [createHash("sha256").update(fresh.cookie.split("=")[1]).digest("hex")]);
      if (change === "lease") await pool.query("UPDATE mail_intake_configuration SET lease_until=clock_timestamp()-interval '1 second'");
      release(); await rejected;
      assert.equal((await receipts()).length, 0); assert.ok(!f.calls.includes("DELE"));
      if (change === "configuration") assert.equal((await readMailIntakeConfiguration()).outcome, "");
    } finally { release(); await pending.catch(() => {}); }
  }
});

test("sender ordering and current role are rechecked after retrieval; display-name pseudo identities never publish", async () => {
  await enable();
  let release!: () => void, entered!: () => void;
  const barrier = new Promise<void>(resolve => { release = resolve; }), started = new Promise<void>(resolve => { entered = resolve; });
  const f = peer(message(people[0].email, "Body", `Reply-To: ${people[1].email}\r\n`), { heldRetrieve: barrier, onRetrieve: entered });
  const pending = checkMailIntake(actor, f.open);
  try {
    await started; await pool.query("UPDATE users SET role='subscriber' WHERE id=$1", [people[0].id]); release(); await pending;
    const [post] = await imported(); assert.equal(post.id, people[0].id); assert.equal(post.status, "pending");
  } finally { release(); await pending.catch(() => {}); await pool.query("UPDATE users SET role='author' WHERE id=$1", [people[0].id]); }
  await allowCheck();
  await checkMailIntake(actor, peer(message(`"${people[0].email}" <invalid>`), { uid: "pseudo" }).open);
  const pseudo = (await imported()).find(post => post.id === actor.user!.id); assert.ok(pseudo); assert.equal(pseudo.status, "pending");
});

test("mailbox interval and process admission stay reserved through physical close", async () => {
  await enable();
  let close!: () => void, closing!: () => void;
  const heldClose = new Promise<void>(resolve => { close = resolve; }), atClose = new Promise<void>(resolve => { closing = resolve; });
  const f = peer(message(people[0].email), { holdClose: heldClose });
  const pending = checkMailIntake(actor, async config => { const session = await f.open(); return { ...session, abort: async () => { closing(); await heldClose; } }; });
  try {
    await atClose;
    assert.equal((await readMailIntakeConfiguration()).busy, true);
    await assert.rejects(checkMailIntake(actor, f.open), (error: any) => error.status === 429);
    close(); await pending;
    await assert.rejects(checkMailIntake(actor, peer(message(people[0].email)).open), (error: any) => error.status === 429);
  } finally { close(); await pending.catch(() => {}); }
});

test("post validation waiting past lease or session expiry rolls back both post and receipt before deletion", async () => {
  for (const expiry of ["lease", "session"] as const) {
    await cleanPosts(); await allowCheck(); await enable();
    const fresh = await login(), req = requestActor(fresh), blocker = await pool.connect();
    let release!: () => void, entered!: () => void;
    const retrieval = new Promise<void>(resolve => { release = resolve; }), started = new Promise<void>(resolve => { entered = resolve; });
    const f = peer(message(people[0].email), { uid: expiry, heldRetrieve: retrieval, onRetrieve: entered });
    await blocker.query("BEGIN"); await blocker.query("SELECT pg_advisory_xact_lock(hashtext('worldact-post-slug'))");
    const pending = checkMailIntake(req, f.open), rejected = assert.rejects(pending, (error: any) => [401, 409].includes(error.status));
    try {
      await started;
      // Set expiry before the import transaction takes its mailbox/user locks,
      // then hold ordinary post validation beyond its transaction start time.
      const until = new Date(Date.now() + 350);
      if (expiry === "lease") await pool.query("UPDATE mail_intake_configuration SET lease_until=$1", [until]);
      else await pool.query("UPDATE sessions SET expires_at=$1 WHERE token_hash=$2", [until, createHash("sha256").update(fresh.cookie.split("=")[1]).digest("hex")]);
      release();
      let waiting = false;
      for (let i = 0; i < 100; i++) {
        waiting = Boolean((await pool.query("SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event='advisory' AND query LIKE '%worldact-post-slug%' AND pid<>pg_backend_pid() LIMIT 1")).rowCount);
        if (waiting) break; await new Promise(resolve => setTimeout(resolve, 5));
      }
      assert.equal(waiting, true);
      await new Promise(resolve => setTimeout(resolve, Math.max(0, until.getTime() - Date.now() + 50)));
      await blocker.query("COMMIT"); await rejected;
      assert.equal((await receipts()).length, 0); assert.ok(!f.calls.includes("DELE"));
    } finally { release(); await blocker.query("ROLLBACK"); blocker.release(); await pending.catch(() => {}); }
  }
});

test("bounded checks rotate past unsupported messages so an unchanged mailbox cannot starve later valid mail", async () => {
  await enable();
  const invalid = Buffer.from("Subject: Unsupported\r\nContent-Type: multipart/mixed; boundary=x\r\n\r\n--x--\r\n"), valid = message(people[0].email);
  const removed: number[] = [];
  const open = async () => ({
    closed: Promise.resolve(),
    list: async () => Array.from({ length: 21 }, (_, index) => ({ number: index + 1, uid: "rotation-" + index, size: index === 20 ? valid.length : invalid.length })),
    retrieve: async (number: number) => number === 21 ? valid : invalid,
    remove: async (number: number) => { removed.push(number); }, quit: async () => {}, abort: async () => {},
  });
  const first = await checkMailIntake(actor, open); assert.equal(first.skipped, 20); assert.equal(first.imported, 0);
  await allowCheck();
  const second = await checkMailIntake(actor, open); assert.equal(second.imported, 1); assert.deepEqual(removed, [21]);
  const config = await readMailIntakeConfiguration(); assert.ok(!JSON.stringify(config).includes("rotation-"));
});
