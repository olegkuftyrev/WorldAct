import test, { after } from "./isolated-test.js";
import assert from "node:assert/strict";
import express from "express";
import { createServer } from "node:http";
import { pool, getSettings } from "../server/db.js";
import { approvalFixture } from "./comment-approval-fixtures.js";
import { createIncomingPings, createIncomingPingsRouter, IncomingPingError } from "../server/incoming-pings.js";
import { pingRPC, parsePingReply } from "../server/ping-protocol.js";
import { createAkismetClient } from "../server/bundled-plugins.js";
import { commentFloodInterval } from "../server/comment-flood.js";
after(() => pool.end());

// The controlled verifier/Akismet adapter and receiver are real source imports.
// ISOLATED_TEST_COMPILED changes the guarded main HTTP server, not these imports.
test("incoming ordinary flood admission shares real human history and serializes final PostgreSQL admission", async t => {
  const f = await approvalFixture("incoming-flood"), first = await f.post(), second = await f.post();
  const ids = [first.id, second.id], site = (await getSettings()).siteUrl;
  const target = (post = first) => new URL(post.permalink, site).href;
  await f.ok("/api/settings", "PUT", { defaultPingStatus: "open", requireCommentNameEmail: false });
  let verifies = 0, filters = 0, sequence = 0;
  let verifier: (() => Promise<void>) | undefined, filter: (() => Promise<void>) | undefined;
  const receive = createIncomingPings({ environment: () => "production", http: async (url, options) => {
    verifies++; assert.equal(options?.redirects, 0); assert.equal(options?.waitForPhysicalClose, true);
    if (verifier) await verifier();
    return { url, status: 200, headers: {}, body: Buffer.from(`<title>Verified source</title><a href="${target()}">first</a><a href="${target(second)}">second</a>`) };
  }, akismet: createAkismetClient((async () => { filters++; if (filter) await filter(); return new Response("false"); }) as typeof fetch) });
  const app = express(); app.use(createIncomingPingsRouter(receive));
  const server = createServer(app); await new Promise<void>(done => server.listen(3062, "127.0.0.1", done));
  const endpoint = "http://127.0.0.1:3062", source = (label: string) => `https://source.example.test/${f.stamp}/${label}-${++sequence}`;
  async function ping(url: string, post = first, credentials = false) {
    const response = await fetch(endpoint + "/xmlrpc.php", { method: "POST", headers: { "Content-Type": "text/xml", ...(credentials ? { Cookie: f.admin, Authorization: "Basic " + Buffer.from("claimed-admin:claimed-password").toString("base64") } : {}) }, body: pingRPC("pingback.ping", [url, target(post)]), signal: AbortSignal.timeout(12000) });
    const text = await response.text(); assert.equal(response.status, 200); return { text, fault: parsePingReply(Buffer.from(text)).fault };
  }
  async function track(url: string, post = first) {
    const response = await fetch(endpoint + "/wp-trackback.php?tb_id=" + post.id, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", Cookie: f.admin }, body: new URLSearchParams({ url, title: "Claimed source", excerpt: "Safe excerpt" }), signal: AbortSignal.timeout(12000) });
    const text = await response.text(); assert.equal(response.status, 200); return text;
  }
  const counts = async () => (await pool.query("SELECT (SELECT count(*) FROM comments)::int AS comments,(SELECT count(*) FROM comment_flood_metadata)::int AS ips,(SELECT count(*) FROM akismet_comment_checks)::int AS checks,(SELECT count(*) FROM mail_outbox)::int AS mail,(SELECT count(*) FROM comment_author_tokens)::int AS tokens")).rows[0];
  async function clean() {
    verifier = undefined; filter = undefined;
    await pool.query("DELETE FROM comments WHERE post_id=ANY($1::int[])", [ids]);
    await pool.query("DELETE FROM incoming_ping_rates"); await pool.query("DELETE FROM incoming_ping_leases");
    await pool.query("DELETE FROM mail_outbox WHERE subject LIKE $1", ["%" + f.stamp + "%"]);
    await pool.query("UPDATE extensions SET enabled=false WHERE slug='akismet'");
    await pool.query("DELETE FROM extension_secrets WHERE slug='akismet'");
  }
  async function activeFilter() {
    await pool.query("UPDATE extensions SET enabled=true,settings='{\"sendComments\":true}' WHERE slug='akismet'");
    await pool.query("INSERT INTO extension_secrets(slug,api_key,verified_site_url,verified_at,last_error_code) VALUES('akismet','controlledIncomingFloodKey',$1,clock_timestamp(),'retained-marker')", [new URL(site).href]);
  }
  async function history(input: { type?: string; status?: string; email?: string; ip?: string; age?: number; postId?: number } = {}) {
    const row = (await pool.query("INSERT INTO comments(post_id,type,author_name,author_email,author_url,content,status,created_at,updated_at) VALUES($1,$2,'Cold predecessor',$3,$4,'Cold different body',$5,date_trunc('second',clock_timestamp())-($6::int*interval '1 second'),date_trunc('second',clock_timestamp())-($6::int*interval '1 second')) RETURNING id,created_at", [input.postId ?? second.id, input.type ?? "comment", input.email ?? "", source("history"), input.status ?? "approved", input.age ?? 1])).rows[0];
    if (input.ip) await pool.query("INSERT INTO comment_flood_metadata(comment_id,author_ip,expires_at) VALUES($1,$2,$3::timestamptz+interval '1 hour')", [row.id, input.ip, row.created_at]);
    return row;
  }
  async function blocked(pid: number, fragment: string, n = 1) {
    for (let i = 0; i < 400; i++) {
      const result = await pool.query("SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=current_database() AND $1=ANY(pg_blocking_pids(pid)) AND position($2 in query)>0", [pid, fragment]);
      if (result.rows[0].n === n) return;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.fail("actual PostgreSQL wait was not observed: " + fragment);
  }
  async function run(name: string, fn: () => Promise<void>) { await t.test(name, async () => { await clean(); try { await fn(); } finally { await clean(); } }); }
  function generic(reply: { text: string; fault: number | null }) { assert.equal(reply.fault, 0, reply.text); assert.doesNotMatch(reply.text, /429|posting comments|Slow down|author_ip|retained-marker|127\.0\.0\.1|stack/); }
  try {
    await run("human API IP predecessor blocks verified ping before moderation/filtering without storage or mail", async () => {
      const human = await f.submit(second.id, { content: "Actual human before ping", authorEmail: "human-distinct@example.test" }); assert.equal(human.response.status, 201, JSON.stringify(human.data));
      await activeFilter(); const before = await counts(), v = verifies, a = filters;
      generic(await ping(source("human-then-ping"), first, true));
      assert.equal(verifies, v + 1, "real verification still precedes flood admission"); assert.equal(filters, a, "known flood must not reach Akismet"); assert.deepEqual(await counts(), before);
      assert.equal((await pool.query("SELECT last_error_code FROM extension_secrets WHERE slug='akismet'")).rows[0].last_error_code, "retained-marker");
      assert.equal((await pool.query("SELECT count(*)::int AS n FROM incoming_ping_leases")).rows[0].n, 0);
      assert.equal((await pool.query("SELECT count(*)::int AS n FROM incoming_ping_rates WHERE count=1")).rows[0].n, 4, "independent attempt buckets remain consumed");
    });
    for (const type of ["comment", "pingback", "trackback"]) for (const status of ["approved", "pending", "spam", "trash"]) {
      await run(`global blank-email OR includes ${status} ${type} on a different post with a different IP`, async () => {
        await history({ type, status, ip: "203.0.113.99" }); const before = await counts();
        generic(await ping(source("blank-history"))); assert.deepEqual(await counts(), before);
      });
    }
    await run("trackback uses generic source error and cannot turn a claimed administrator cookie into exemption", async () => {
      await history({ email: "nonblank@example.test", ip: "127.0.0.1", status: "trash" }); const before = await counts(), v = verifies;
      const text = await track(source("track-flood")); assert.match(text, /<error>1<\/error>/); assert.doesNotMatch(text, /429|posting comments|author_ip|stack/); assert.equal(verifies, v); assert.deepEqual(await counts(), before);
    });
    await run("new ping remains a predecessor for the actual human API across posts", async () => {
      assert.equal((await ping(source("ping-before-human"))).fault, null);
      const before = await counts(), result = await f.submit(second.id, { content: "Actual human after ping", authorEmail: "different-after-ping@example.test" });
      assert.equal(result.response.status, 429); assert.equal(result.data.error, "You are posting comments too quickly. Slow down."); assert.deepEqual(await counts(), before);
    });
    await run("nonmatching email/IP, exactly15 seconds and outside-hour records permit fresh admission", async () => {
      assert.equal(commentFloodInterval(new Date("2025-01-01T00:00:00.999Z"), new Date("2025-01-01T00:00:14.999Z")), true);
      assert.equal(commentFloodInterval(new Date("2025-01-01T00:00:00.999Z"), new Date("2025-01-01T00:00:15.001Z")), false);
      await history({ email: "other@example.test", ip: "203.0.113.99" });
      await history({ age: 15, status: "trash" }); await history({ age: 3601 });
      assert.equal((await ping(source("allowed-boundaries"))).fault, null);
    });
    await run("same source duplicate48 precedes flood and does not consume another persistent attempt", async () => {
      const url = source("duplicate"); assert.equal((await ping(url)).fault, null); const before = await counts(), rates = (await pool.query("SELECT * FROM incoming_ping_rates ORDER BY key")).rows;
      assert.equal((await ping(url)).fault, 48); assert.deepEqual(await counts(), before); assert.deepEqual((await pool.query("SELECT * FROM incoming_ping_rates ORDER BY key")).rows, rates);
    });
    await run("two distinct verified/filter-complete requests really waiting on PostgreSQL admit one and flood one", async () => {
      await activeFilter(); let ready!: () => void, release!: () => void, entered = 0;
      const both = new Promise<void>(resolve => ready = resolve), held = new Promise<void>(resolve => release = resolve);
      filter = async () => { if (++entered === 2) ready(); await held; };
      const a = source("concurrent-a"), b = source("concurrent-b"), pending = Promise.all([ping(a), ping(b, second)]);
      const lock = await pool.connect();
      try {
        await both; await lock.query("BEGIN"); await lock.query("SELECT pg_advisory_xact_lock(hashtext('worldact-comment-hierarchy'))"); const pid = (await lock.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
        release(); await blocked(pid, "worldact-comment-hierarchy", 2); const before = await counts(); await lock.query("COMMIT");
        const results = await pending; assert.deepEqual(results.map(r => r.fault).sort(), [0, null].sort()); generic(results.find(r => r.fault === 0)!);
        const after = await counts(); assert.equal(after.comments, before.comments + 1); assert.equal(after.ips, before.ips + 1); assert.equal(after.checks, before.checks + 1); assert.equal(after.mail, before.mail + 1);
        assert.equal((await pool.query("SELECT count(*)::int AS n FROM incoming_ping_leases")).rows[0].n, 0);
      } finally { release(); await lock.query("ROLLBACK"); lock.release(); await pending.catch(() => {}); }
    });
    await run("a human admitted while source verification is actually held defeats the late ping", async () => {
      let ready!: () => void, release!: () => void; const entered = new Promise<void>(resolve => ready = resolve), held = new Promise<void>(resolve => release = resolve);
      verifier = async () => { ready(); await held; }; const pending = ping(source("held-verification"));
      try {
        await entered; const clients = await Promise.all(Array.from({ length: 10 }, () => pool.connect())); clients.forEach(client => client.release());
        const human = await f.submit(second.id, { content: "Human committed during verification", authorEmail: "while-verifying@example.test" }); assert.equal(human.response.status, 201);
        const before = await counts(); release(); generic(await pending); assert.deepEqual(await counts(), before);
      } finally { release(); await pending.catch(() => {}); }
    });
    for (const resource of ["post", "settings"]) await run(`final ${resource} wait rechecks a new predecessor before inserting`, async () => {
      await activeFilter(); let ready!: () => void, release!: () => void; const entered = new Promise<void>(resolve => ready = resolve), held = new Promise<void>(resolve => release = resolve);
      filter = async () => { ready(); await held; }; const pending = ping(source("wait-" + resource)), lock = await pool.connect();
      try {
        await entered; await lock.query("BEGIN"); await lock.query(resource === "post" ? "SELECT id FROM posts WHERE id=$1 FOR NO KEY UPDATE" : "SELECT id FROM settings WHERE id=1 FOR UPDATE", resource === "post" ? [first.id] : []);
        const pid = (await lock.query("SELECT pg_backend_pid() AS pid")).rows[0].pid; release(); await blocked(pid, resource === "post" ? "FROM posts WHERE id=$1 FOR SHARE" : "FROM settings WHERE id=1 FOR SHARE");
        await history({ status: "spam", ip: "203.0.113.45" }); const before = await counts(); await lock.query("COMMIT"); generic(await pending); assert.deepEqual(await counts(), before);
      } finally { release(); await lock.query("ROLLBACK"); lock.release(); await pending.catch(() => {}); }
    });
    await run("post-wait accepted timestamp samples actual release time and IP expiry shares that one second", async () => {
      await activeFilter(); let ready!: () => void, release!: () => void; const entered = new Promise<void>(resolve => ready = resolve), held = new Promise<void>(resolve => release = resolve);
      filter = async () => { ready(); await held; }; const url = source("admitted-timestamp"), pending = ping(url), lock = await pool.connect();
      try {
        await entered; await lock.query("BEGIN"); await lock.query("SELECT id FROM posts WHERE id=$1 FOR NO KEY UPDATE", [first.id]); const pid = (await lock.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
        release(); await blocked(pid, "FROM posts WHERE id=$1 FOR SHARE");
        const start = (await pool.query("SELECT xact_start FROM pg_stat_activity WHERE datname=current_database() AND $1=ANY(pg_blocking_pids(pid)) AND position('FROM posts WHERE id=$1 FOR SHARE' in query)>0", [pid])).rows[0].xact_start as Date;
        let sampled: Date;
        do { sampled = (await pool.query("SELECT date_trunc('second',clock_timestamp()) AS time")).rows[0].time; if (sampled.getTime() > start.getTime()) break; await new Promise(resolve => setTimeout(resolve, 10)); } while (true);
        await lock.query("COMMIT"); assert.equal((await pending).fault, null);
        const row = (await pool.query("SELECT c.created_at,c.updated_at,m.expires_at FROM comments c JOIN comment_flood_metadata m ON m.comment_id=c.id WHERE c.author_url=$1 AND c.post_id=$2", [url, first.id])).rows[0];
        assert.ok(row.created_at.getTime() >= sampled.getTime()); assert.equal(row.created_at.getMilliseconds(), 0); assert.equal(row.updated_at.getTime(), row.created_at.getTime()); assert.equal(row.expires_at.getTime() - row.created_at.getTime(), 3600000);
      } finally { release(); await lock.query("ROLLBACK"); lock.release(); await pending.catch(() => {}); }
    });
    await run("flood lease is removed, retry does not extend history, and independent source attempt cap still holds", async () => {
      const prior = await history(), url = source("retry"), before = await counts(); generic(await ping(url));
      assert.deepEqual(await counts(), before); assert.equal((await pool.query("SELECT count(*)::int AS n FROM incoming_ping_leases")).rows[0].n, 0);
      await pool.query("UPDATE comments SET created_at=date_trunc('second',clock_timestamp())-interval '20 seconds' WHERE id=$1", [prior.id]);
      assert.equal((await ping(url)).fault, null); const accepted = await counts(); assert.equal(accepted.comments, before.comments + 1);
      assert.equal((await pool.query("SELECT count FROM incoming_ping_rates WHERE key=encode(sha256(convert_to($1,'UTF8')),'hex')", ["source:" + url])).rows[0].count, 2);
      await pool.query("UPDATE incoming_ping_rates SET count=10 WHERE key=encode(sha256(convert_to($1,'UTF8')),'hex')", ["source:" + url]);
      const v = verifies; generic(await ping(url, second)); assert.equal(verifies, v); assert.deepEqual(await counts(), accepted);
    });
  } finally { await new Promise<void>(done => server.close(() => done())); await clean(); await f.dispose(); }
});
