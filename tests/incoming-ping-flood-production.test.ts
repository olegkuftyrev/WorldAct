import test, { after } from "./isolated-test.js";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { pool, getSettings, rootDir } from "../server/db.js";
import { approvalFixture } from "./comment-approval-fixtures.js";
import { createIncomingPings, IncomingPingError } from "../server/incoming-pings.js";
import { createAkismetClient } from "../server/bundled-plugins.js";
after(() => pool.end());
const flood = (error: unknown) => error instanceof IncomingPingError && error.code === 0;

// The auxiliary production process uses the selected real source/compiled entry.
// Only trackbacks reach it, so neither source verification nor external services run.
test("real production receiver entry and direct source-service error/wait contracts", async t => {
  const f = await approvalFixture("incoming-production");
  await f.ok("/api/settings", "PUT", { defaultPingbackFlag: false, pingServices: [], requireCommentNameEmail: false });
  const post = await f.post(), settings = await getSettings(), target = new URL(post.permalink, settings.siteUrl).href;
  let sequence = 0, hook: (() => Promise<void>) | undefined;
  const source = () => `https://production-source.example.test/${f.stamp}/${++sequence}`;
  const receive = createIncomingPings({ environment: () => "production", akismet: createAkismetClient((async () => { if (hook) await hook(); return new Response("false"); }) as typeof fetch) });
  const input = () => ({ type: "trackback" as const, title: "Direct source", source: source(), target, ip: "192.0.2.30" });
  const snapshot = async () => (await pool.query("SELECT (SELECT count(*) FROM comments WHERE post_id=$1)::int AS comments,(SELECT count(*) FROM comment_flood_metadata m JOIN comments c ON c.id=m.comment_id WHERE c.post_id=$1)::int AS ips,(SELECT count(*) FROM akismet_comment_checks m JOIN comments c ON c.id=m.comment_id WHERE c.post_id=$1)::int AS checks,(SELECT count(*) FROM mail_outbox)::int AS mail", [post.id])).rows[0];
  async function predecessor() { return (await pool.query("INSERT INTO comments(post_id,author_name,author_email,content,status,created_at) VALUES($1,'Own cold prior','','Other body','trash',date_trunc('second',clock_timestamp())) RETURNING id", [post.id])).rows[0].id; }
  async function clear() {
    hook = undefined; await pool.query("DELETE FROM comments WHERE post_id=$1", [post.id]);
    await pool.query("DELETE FROM incoming_ping_rates"); await pool.query("DELETE FROM incoming_ping_leases");
    await pool.query("UPDATE extensions SET enabled=false WHERE slug='akismet'"); await pool.query("DELETE FROM extension_secrets WHERE slug='akismet'");
    await pool.query("DELETE FROM mail_outbox WHERE subject LIKE $1", ["%" + f.stamp + "%"]);
  }
  async function activeFilter() {
    await pool.query("UPDATE extensions SET enabled=true,settings='{\"sendComments\":true}' WHERE slug='akismet'");
    await pool.query("INSERT INTO extension_secrets(slug,api_key,verified_site_url,verified_at) VALUES('akismet','controlledProductionFloodKey',$1,clock_timestamp())", [new URL(settings.siteUrl).href]);
  }
  async function wait(pid: number, fragment: string, count = 1) {
    for (let i = 0; i < 400; i++) {
      if ((await pool.query("SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=current_database() AND $1=ANY(pg_blocking_pids(pid)) AND position($2 in query)>0", [pid, fragment])).rows[0].n === count) return;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.fail("actual receiver wait was not reached: " + fragment);
  }
  async function run(name: string, fn: () => Promise<void>) { await t.test(name, async () => { await clear(); try { await fn(); } finally { await clear(); } }); }
  try {
    await run("known flood is IncomingPingError0 while unrelated verifier failures retain their identity", async () => {
      await predecessor(); const before = await snapshot(); await assert.rejects(receive(input()), flood); assert.deepEqual(await snapshot(), before);
      const original = new Error("Owned verifier error must not be relabeled");
      const broken = createIncomingPings({ environment: () => "production", http: async () => { throw original; } });
      await assert.rejects(broken({ ...input(), type: "pingback" }), error => error === original); assert.deepEqual(await snapshot(), before);
    });
    await run("a flood arriving during actual Akismet I/O is rejected only at final admission without retained submission metadata", async () => {
      await activeFilter(); let ready!: () => void, release!: () => void;
      const entered = new Promise<void>(resolve => ready = resolve), held = new Promise<void>(resolve => release = resolve);
      hook = async () => { ready(); await held; }; const pending = receive(input()), rejected = assert.rejects(pending, flood);
      try {
        await entered; const clients = await Promise.all(Array.from({ length: 10 }, () => pool.connect())); clients.forEach(client => client.release());
        await predecessor(); const before = await snapshot(); release(); await rejected; assert.deepEqual(await snapshot(), before);
        assert.equal((await pool.query("SELECT count(*)::int AS n FROM incoming_ping_leases")).rows[0].n, 0);
      } finally { release(); await pending.catch(() => {}); }
    });
    await run("same-source final race retains duplicate48 before the newly committed flood predecessor", async () => {
      await activeFilter(); let ready!: () => void, release!: () => void, count = 0;
      const both = new Promise<void>(resolve => ready = resolve), held = new Promise<void>(resolve => release = resolve);
      hook = async () => { if (++count === 2) ready(); await held; }; const request = input();
      const pending = Promise.allSettled([receive(request), receive(request)]), lock = await pool.connect();
      try {
        await both; await lock.query("BEGIN"); await lock.query("SELECT pg_advisory_xact_lock(hashtext('worldact-comment-hierarchy'))"); const pid = (await lock.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
        release(); await wait(pid, "worldact-comment-hierarchy", 2); await lock.query("COMMIT");
        const results = await pending; assert.equal(results.filter(r => r.status === "fulfilled").length, 1);
        const refusal = results.find(r => r.status === "rejected"); assert.ok(refusal && refusal.status === "rejected" && refusal.reason instanceof IncomingPingError); assert.equal(refusal.reason.code, 48);
        const after = await snapshot(); assert.equal(after.comments, 1); assert.equal(after.ips, 1); assert.equal(after.checks, 1);
      } finally { release(); await lock.query("ROLLBACK"); lock.release(); await pending; }
    });
    await run("lease expiry after a real final target-row wait still rejects before any comment/private metadata/mail", async () => {
      await activeFilter(); let ready!: () => void, release!: () => void;
      const entered = new Promise<void>(resolve => ready = resolve), held = new Promise<void>(resolve => release = resolve);
      hook = async () => { ready(); await held; }; const pending = receive(input()), rejected = assert.rejects(pending, flood), lock = await pool.connect();
      try {
        await entered; await lock.query("BEGIN"); await lock.query("SELECT id FROM posts WHERE id=$1 FOR NO KEY UPDATE", [post.id]); const pid = (await lock.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
        release(); await wait(pid, "FROM posts WHERE id=$1 FOR SHARE"); await pool.query("UPDATE incoming_ping_leases SET expires_at=clock_timestamp()"); const before = await snapshot();
        await lock.query("COMMIT"); await rejected; assert.deepEqual(await snapshot(), before);
        assert.equal((await pool.query("SELECT count(*)::int AS n FROM incoming_ping_leases")).rows[0].n, 0);
      } finally { release(); await lock.query("ROLLBACK"); lock.release(); await pending.catch(() => {}); }
    });
    await run("actual selected production process accepts one trackback then blocks another trackback and human flooding without credential exemption", async () => {
      assert.equal((await pool.query("SELECT count(*)::int AS n FROM outgoing_ping_jobs WHERE state IN ('pending','running')")).rows[0].n, 0);
      const entry = process.env.ISOLATED_TEST_COMPILED === "true" ? ["dist-server/index.js"] : ["--import", "tsx", "server/index.ts"];
      const child = spawn(process.execPath, entry, { cwd: rootDir, env: { ...process.env, PORT: "3062", WORLDACT_ENVIRONMENT_TYPE: "production" }, stdio: ["ignore", "pipe", "pipe"] });
      let output = ""; for (const stream of [child.stdout, child.stderr]) stream.on("data", data => { output = (output + data.toString()).slice(-10000); });
      const exited = new Promise<number | null>((resolve, reject) => { child.once("error", reject); child.once("exit", resolve); });
      const endpoint = "http://127.0.0.1:3062";
      async function track() { const response = await fetch(endpoint + "/wp-trackback.php?tb_id=" + post.id, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", Cookie: f.admin }, body: new URLSearchParams({ url: source(), title: "Production actual router" }), signal: AbortSignal.timeout(10000) }); assert.equal(response.status, 200); return response.text(); }
      try {
        let ready = false;
        for (let i = 0; i < 100; i++) { if (child.exitCode !== null || child.signalCode !== null) assert.fail(output); if (output.includes("WorldAct API listening on ")) { try { if ((await fetch(endpoint + "/api/health")).ok) { ready = true; break; } } catch {} } await new Promise(resolve => setTimeout(resolve, 50)); }
        assert.ok(ready, output); assert.match(await track(), /<error>0<\/error>/);
        const before = await snapshot(), denied = await track(); assert.match(denied, /<error>1<\/error>/); assert.doesNotMatch(denied, /429|posting comments|author_ip|stack/); assert.deepEqual(await snapshot(), before);
        const human = await f.submit(post.id, { content: "Actual human after real production trackback", authorEmail: "production-human@example.test" }); assert.equal(human.response.status, 429); assert.deepEqual(await snapshot(), before);
        const row = (await pool.query("SELECT author_email,user_id FROM comments WHERE post_id=$1", [post.id])).rows[0]; assert.equal(row.author_email, ""); assert.equal(row.user_id, null);
        assert.equal((await pool.query("SELECT count(*)::int AS n FROM incoming_ping_leases")).rows[0].n, 0);
        assert.equal((await pool.query("SELECT count FROM incoming_ping_rates WHERE key=encode(sha256(convert_to('global','UTF8')),'hex')")).rows[0].count, 2);
      } finally {
        child.kill("SIGTERM"); const timer = setTimeout(() => child.kill("SIGKILL"), 3000); try { await exited; } finally { clearTimeout(timer); }
      }
    });
  } finally { await clear(); await f.dispose(); }
});
