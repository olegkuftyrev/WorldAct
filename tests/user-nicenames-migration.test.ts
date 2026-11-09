import test, { after, assertIsolatedTestContext } from "./isolated-test.js";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import pg from "pg";
import { pool, rootDir, defaultSettings } from "../server/db.js";
import { migrate } from "../server/migrate.js";

after(() => pool.end());
const digest = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const identitySQL = "SELECT pg_advisory_xact_lock(hashtext('worldact-account-identity'))";
const creationSQL = "SELECT pg_advisory_xact_lock(hashtext('worldact-user-creation'))";
const quote = (name: string) => '"' + name.replace(/"/g, '""') + '"';
type Outcome = { code: number | null; signal: NodeJS.Signals | null; output: string };
type Running = { child: ChildProcess; done: Promise<Outcome> };

function start(args: string[], env: NodeJS.ProcessEnv): Running {
  const child = spawn(process.execPath, args, { cwd: rootDir, env, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  for (const stream of [child.stdout, child.stderr]) stream!.on("data", value => { output = (output + value).slice(-8000); });
  const done = new Promise<Outcome>(resolve => {
    child.once("error", error => resolve({ code: null, signal: null, output: error.message }));
    child.once("close", (code, signal) => resolve({ code, signal, output }));
  });
  return { child, done };
}
async function stop(running: Running) {
  if (running.child.exitCode !== null || running.child.signalCode !== null) return running.done;
  running.child.kill("SIGTERM");
  const timer = setTimeout(() => running.child.kill("SIGKILL"), 2000);
  try { return await running.done; } finally { clearTimeout(timer); }
}
async function success(running: Running) {
  const result = await running.done;
  assert.equal(result.code, 0, result.output);
  assert.equal(result.signal, null);
}

/** Both the outer runner and every additional database have explicit ownership. */
async function ownDatabase(work: (db: pg.Pool, run: (entry: string, name?: string) => Running, env: NodeJS.ProcessEnv, uploads: string) => Promise<void>) {
  assertIsolatedTestContext();
  const original = new URL(process.env.DATABASE_URL!);
  assert.match(original.pathname, /^\/worldact_test_\d+_[a-f0-9]{8}$/);
  const name = "worldact_test_" + Date.now() + "_" + randomBytes(4).toString("hex");
  assert.notEqual("/" + name, original.pathname);
  const url = new URL(original); url.pathname = "/" + name;
  const adminURL = new URL(original); adminURL.pathname = "/postgres";
  const admin = new pg.Pool({ connectionString: adminURL.href, connectionTimeoutMillis: 5000 });
  const db = new pg.Pool({ connectionString: url.href, max: 8, connectionTimeoutMillis: 5000, options: "-c statement_timeout=20000 -c lock_timeout=15000" });
  const uploads = await mkdtemp(path.join(os.tmpdir(), "worldact-test-uploads-"));
  const env = { ...process.env, DATABASE_URL: url.href, WORLDACT_UPLOADS_DIR: uploads, PGOPTIONS: "-c statement_timeout=20000 -c lock_timeout=15000" };
  const running: Running[] = [];
  let created = false;
  const run = (entry: string, applicationName = "nicename-migration") => {
    const child = start(["--import", "tsx", entry], { ...env, PGAPPNAME: applicationName });
    running.push(child); return child;
  };
  try {
    await admin.query("CREATE DATABASE " + quote(name)); created = true;
    assert.equal((await db.query("SELECT current_database() AS name")).rows[0].name, name);
    await success(run("server/migrate.ts"));
    await db.query("INSERT INTO settings(id,data) VALUES(1,$1)", [JSON.stringify(defaultSettings)]);
    // Establish the existing full schema's ordinary defaults before testing the
    // new additive identity migration against a deliberately older users table.
    await success(run("server/migrate.ts"));
    await work(db, run, env, uploads);
  } finally {
    await Promise.all(running.map(stop));
    await db.end();
    try {
      if (created) {
        assert.match(name, /^worldact_test_\d+_[a-f0-9]{8}$/);
        // Pool.end() removes idle clients before their server-side sessions have
        // necessarily finished disconnecting. Do not FORCE-terminate our own
        // closing clients and race a late error into the completed test.
        const deadline = Date.now() + 5000;
        while (Number((await admin.query("SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=$1", [name])).rows[0].n)) {
          assert.ok(Date.now() < deadline, "Owned database sessions did not finish closing");
          await new Promise(resolve => setTimeout(resolve, 10));
        }
        await admin.query("DROP DATABASE " + quote(name));
      }
    } finally { await admin.end(); await rm(uploads, { recursive: true, force: true }); }
  }
}
async function snapshot(db: pg.Pool, excludeNicename = false) {
  const result: Record<string, { columns: string[]; count: number; digest: string }> = {};
  const tables = (await db.query("SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename")).rows;
  for (const { tablename } of tables) {
    const columns = (await db.query("SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name=$1 ORDER BY ordinal_position", [tablename])).rows
      .map(row => row.column_name as string).filter(column => !(excludeNicename && tablename === "users" && column === "nicename"));
    const rows = (await db.query(`SELECT to_jsonb(item)::text AS body FROM (SELECT ${columns.map(quote).join(",")} FROM ${quote(tablename)}) item ORDER BY body`)).rows.map(row => row.body);
    result[tablename] = { columns, count: rows.length, digest: digest(JSON.stringify(rows)) };
  }
  return result;
}
async function looseIdentities(db: pg.Pool) {
  await db.query("ALTER TABLE users ALTER COLUMN nicename DROP NOT NULL");
  await db.query("ALTER TABLE users DROP CONSTRAINT users_nicename_shape");
  await db.query("DROP INDEX users_nicename_unique");
}
async function legacyUser(db: pg.Pool, username: string, nicename?: string | null) {
  const args: unknown[] = [username, "legacy-" + randomBytes(6).toString("hex") + "@example.test", "Legacy " + username];
  const extra = nicename === undefined ? "" : ",nicename";
  if (nicename !== undefined) args.push(nicename);
  return (await db.query(`INSERT INTO users(username,email,display_name,password_hash,role,profile,preferences${extra}) VALUES($1,$2,$3,'preserved-private-password-hash','administrator','{"bio":"Preserved biography","nickname":"Old nickname"}','{"editor":{"mode":"code"}}'${extra ? ",$4" : ""}) RETURNING id,username`, args)).rows[0] as { id: number; username: string };
}
async function waitState(db: pg.Pool | typeof pool, label: string, query: string, args: unknown[] = []) {
  const deadline = Date.now() + 12000;
  while (Date.now() < deadline) {
    const rows = (await db.query(query, args)).rows;
    if (rows.length) return rows[0];
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error("Timed out observing actual PostgreSQL lock state: " + label);
}
const blockedQuery = `SELECT a.pid,a.query,pg_blocking_pids(a.pid) AS blockers FROM pg_stat_activity a WHERE a.datname=current_database() AND a.pid<>pg_backend_pid() AND position($1 in a.query)>0 AND a.wait_event_type='Lock' AND cardinality(pg_blocking_pids(a.pid))>0`;
async function held(db: pg.Pool | typeof pool, key: string, pid: number) {
  return Number((await db.query(`SELECT count(*)::int AS n FROM pg_locks WHERE pid=$1 AND locktype='advisory' AND granted AND objsubid=1 AND classid=((hashtext($2)::bigint >> 32)&4294967295)::oid AND objid=(hashtext($2)::bigint&4294967295)::oid`, [pid, key])).rows[0].n);
}
async function noApplicationRelations(db: pg.Pool | typeof pool, pid: number) {
  assert.deepEqual((await db.query("SELECT c.relname,l.mode,l.granted FROM pg_locks l JOIN pg_class c ON c.oid=l.relation JOIN pg_namespace n ON n.oid=c.relnamespace WHERE l.pid=$1 AND n.nspname='public'", [pid])).rows, []);
}

test("old-schema migration preserves every old table value and upload while backfilling source defaults, collision suffixes and legacy fallbacks", { timeout: 120000 }, async () => {
  await ownDatabase(async (db, run, _env, uploads) => {
    await db.query("ALTER TABLE users DROP COLUMN nicename");
    const expected = new Map<number, string>();
    async function add(username: string, name: string | ((id: number) => string)) {
      const user = await legacyUser(db, username); expected.set(user.id, typeof name === "function" ? name(user.id) : name); return user;
    }
    const owner = await add("John.Doe", "john-doe");
    await add("john-doe", "john-doe-2");
    await add("John_Doe", "john_doe"); await add("A@B", "ab");
    await add("_", "_"); await add("000", "000");
    for (const username of ["0", "0@", "@@@", "Éclair", "literal%41", "@".repeat(50) + "later"])
      await add(username, id => "user-" + id);
    const fallback = await add("...", id => "user-" + id);
    await add("user-" + fallback.id, "user-" + fallback.id + "-2");
    for (let n = 1; n <= 10; n++) await add("suffix" + "@".repeat(n), "suffix" + (n === 1 ? "" : "-" + n));
    const long = "x".repeat(50);
    for (let n = 1; n <= 10; n++) await add(long + "@".repeat(n - 1), n === 1 ? long : "x".repeat(n === 10 ? 47 : 48) + "-" + n);
    const edge = "a".repeat(47) + "-bb";
    await add(edge, edge); await add(edge + "@", "a".repeat(47) + "--2");
    await db.query("UPDATE settings SET data=data || '{\"siteTitle\":\"Preserved migration site\",\"timezone\":\"America/Los_Angeles\"}' WHERE id=1");
    await db.query("INSERT INTO sessions(token_hash,user_id,expires_at) VALUES($1,$2,'2030-01-01')", [digest("retained-session"), owner.id]);
    await db.query("INSERT INTO password_resets(token_hash,user_id,expires_at) VALUES($1,$2,'2030-01-01')", [digest("retained-reset"), owner.id]);
    await db.query("INSERT INTO application_passwords(uuid,user_id,name,key_hash) VALUES('a0192cf4-74cf-49f4-ae4a-5814dd8f2001',$1,'Preserved key',$2)", [owner.id, digest("retained-key")]);
    const post = (await db.query("INSERT INTO posts(type,title,slug,content,raw_content,status,author_id,password_hash,post_date,post_date_gmt) VALUES('post','Preserved private post','preserved-private','<p>Private body.</p>','<p>Private raw.</p>','private',$1,'retained-post-hash',to_char(CASE WHEN coalesce((SELECT data->>'timezone' FROM settings WHERE id=1),'America/Los_Angeles')~'^[+-]' THEN timezone(coalesce((SELECT data->>'timezone' FROM settings WHERE id=1),'America/Los_Angeles')::interval,coalesce(CASE WHEN 'private'='future' THEN NULL::timestamptz END,NULL::timestamptz,NULL::timestamptz,now())) ELSE timezone(coalesce((SELECT data->>'timezone' FROM settings WHERE id=1),'America/Los_Angeles'),coalesce(CASE WHEN 'private'='future' THEN NULL::timestamptz END,NULL::timestamptz,NULL::timestamptz,now())) END,'YYYY-MM-DD\"T\"HH24:MI:SS'),coalesce(CASE WHEN 'private'='future' THEN NULL::timestamptz END,NULL::timestamptz,NULL::timestamptz,now())) RETURNING id", [owner.id])).rows[0];
    await db.query("INSERT INTO post_terms(post_id,term_id) SELECT $1,id FROM terms WHERE is_default", [post.id]);
    await db.query("INSERT INTO comments(post_id,author_name,author_email,content,status,user_id) VALUES($1,'Preserved commenter','private@example.test','<p>Preserved comment.</p>','pending',$2)", [post.id, owner.id]);
    const bytes = Buffer.from([0, 255, 13, 10, 1, 2, 3, 128]);
    await writeFile(path.join(uploads, "preserved-migration.bin"), bytes);
    await db.query("INSERT INTO media(author_id,title,filename,mime_type,size) VALUES($1,'Preserved upload','preserved-migration.bin','application/octet-stream',$2)", [owner.id, bytes.length]);
    const before = await snapshot(db, true);
    await success(run("server/migrate.ts"));
    assert.deepEqual(await snapshot(db, true), before, "all preexisting columns and rows survive the additive upgrade");
    assert.deepEqual(await readFile(path.join(uploads, "preserved-migration.bin")), bytes);
    assert.deepEqual((await db.query("SELECT id,nicename FROM users ORDER BY id")).rows, [...expected].map(([id, nicename]) => ({ id, nicename })));
    const once = await snapshot(db);
    await success(run("server/migrate.ts"));
    assert.deepEqual(await snapshot(db), once, "repeat migration cannot rename identities or alter old data");
    const column = (await db.query("SELECT data_type,character_maximum_length,is_nullable FROM information_schema.columns WHERE table_schema='public' AND table_name='users' AND column_name='nicename'")).rows[0];
    assert.deepEqual(column, { data_type: "character varying", character_maximum_length: 50, is_nullable: "NO" });
    const shape = (await db.query("SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE conrelid='users'::regclass AND conname='users_nicename_shape'")).rows;
    assert.equal(shape.length, 1); assert.match(shape[0].definition, /CHECK/);
    assert.equal((await db.query("SELECT indisunique FROM pg_index WHERE indexrelid='users_nicename_unique'::regclass")).rows[0].indisunique, true);
    for (const [nicename, code] of [[null, "23502"], ["", "23514"], ["0", "23514"], ["Uppercase", "23514"], ["with/slash", "23514"], ["z".repeat(51), "22001"], ["john-doe", "23505"]] as const)
      await assert.rejects(legacyUser(db, "constraint-" + randomBytes(6).toString("hex"), nicename), error => (error as { code?: string }).code === code);
  });
});

test("nullable preassigned identities are reserved before null backfill and remain unchanged on repeat", { timeout: 90000 }, async () => {
  await ownDatabase(async (db, run) => {
    await looseIdentities(db);
    const earlier = await legacyUser(db, "John.Doe", null);
    const later = await legacyUser(db, "assigned-owner", "john-doe");
    const unchanged = await legacyUser(db, "manual-stable", "manual--stable");
    const before = await snapshot(db, true);
    await success(run("server/migrate.ts"));
    assert.deepEqual(await snapshot(db, true), before);
    assert.deepEqual((await db.query("SELECT id,nicename FROM users ORDER BY id")).rows, [{ id: earlier.id, nicename: "john-doe-2" }, { id: later.id, nicename: "john-doe" }, { id: unchanged.id, nicename: "manual--stable" }]);
    const once = await snapshot(db); await success(run("server/migrate.ts")); assert.deepEqual(await snapshot(db), once);
  });
});

test("a preexisting wider nicename column is narrowed without changing any assigned identity", { timeout: 90000 }, async () => {
  await ownDatabase(async (db, run) => {
    await looseIdentities(db);
    await db.query("ALTER TABLE users ALTER COLUMN nicename TYPE text");
    await legacyUser(db, "wider-owner", "preserved--identity");
    const before = await snapshot(db);
    await success(run("server/migrate.ts"));
    assert.deepEqual(await snapshot(db), before);
    assert.deepEqual((await db.query("SELECT data_type,character_maximum_length,is_nullable FROM information_schema.columns WHERE table_schema='public' AND table_name='users' AND column_name='nicename'")).rows[0], { data_type: "character varying", character_maximum_length: 50, is_nullable: "NO" });
    await assert.rejects(legacyUser(db, "oversized-after-type-upgrade", "z".repeat(51)), error => (error as { code?: string }).code === "22001");
  });
});

for (const invalid of ["invalid assigned identity", "duplicate assigned identity", "oversized assigned identity"] as const) {
  test(invalid + " rolls the complete real migration back atomically", { timeout: 90000 }, async () => {
    await ownDatabase(async (db, run) => {
      await looseIdentities(db);
      if (invalid.startsWith("oversized")) await db.query("ALTER TABLE users ALTER COLUMN nicename TYPE varchar(200)");
      const first = await legacyUser(db, "first-unassigned", null);
      await legacyUser(db, "invalid-owner", invalid.startsWith("invalid") ? "Invalid/Identity" : invalid.startsWith("oversized") ? "z".repeat(51) : "reserved");
      if (invalid.startsWith("duplicate")) await legacyUser(db, "second-owner", "reserved");
      // schema.sql would backfill this post's missing category before nicename validation.
      await db.query("INSERT INTO posts(type,title,slug,content,status,author_id,post_date,post_date_gmt) VALUES('post','Rollback category proof','rollback-category-proof','<p>Preserve.</p>','publish',$1,to_char(CASE WHEN coalesce((SELECT data->>'timezone' FROM settings WHERE id=1),'America/Los_Angeles')~'^[+-]' THEN timezone(coalesce((SELECT data->>'timezone' FROM settings WHERE id=1),'America/Los_Angeles')::interval,coalesce(CASE WHEN 'publish'='future' THEN NULL::timestamptz END,NULL::timestamptz,NULL::timestamptz,now())) ELSE timezone(coalesce((SELECT data->>'timezone' FROM settings WHERE id=1),'America/Los_Angeles'),coalesce(CASE WHEN 'publish'='future' THEN NULL::timestamptz END,NULL::timestamptz,NULL::timestamptz,now())) END,'YYYY-MM-DD\"T\"HH24:MI:SS'),coalesce(CASE WHEN 'publish'='future' THEN NULL::timestamptz END,NULL::timestamptz,NULL::timestamptz,now()))", [first.id]);
      const before = await snapshot(db);
      const schema = async () => (await db.query("SELECT column_name,data_type,character_maximum_length,is_nullable FROM information_schema.columns WHERE table_schema='public' AND table_name='users' ORDER BY ordinal_position")).rows;
      const oldSchema = await schema();
      const result = await run("server/migrate.ts").done;
      assert.notEqual(result.code, 0); assert.match(result.output, /Invalid or duplicate assigned public author identity/);
      assert.doesNotMatch(result.output, /40P01|deadlock detected/);
      assert.deepEqual(await snapshot(db), before); assert.deepEqual(await schema(), oldSchema);
      assert.equal((await db.query("SELECT nicename FROM users WHERE id=$1", [first.id])).rows[0].nicename, null);
      assert.equal((await db.query("SELECT to_regclass('users_nicename_unique') AS present")).rows[0].present, null);
    });
  });
}

async function api(route: string, method = "GET", body?: unknown, cookie = "") {
  const response = await fetch(process.env.TEST_API_URL! + route, { method, signal: AbortSignal.timeout(30000), headers: { Origin: process.env.APP_ORIGIN!, "Content-Type": "application/json", ...(cookie ? { Cookie: cookie } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { response, data: await response.json() };
}
for (const first of ["profile", "migration"] as const) {
  test(first + " starts first: real profile, migration and registration obey barrier/users/identity order", { timeout: 90000 }, async () => {
    const signed = await api("/api/auth/login", "POST", { login: process.env.ADMIN_EMAIL, password: process.env.ADMIN_PASSWORD });
    assert.equal(signed.response.status, 200);
    const cookie = signed.response.headers.get("set-cookie")!.split(";")[0], actorId = signed.data.user.id;
    const oldName = signed.data.user.displayName;
    const settings = (await pool.query("SELECT data FROM settings WHERE id=1")).rows[0].data;
    const email = "migration-barrier-" + randomBytes(6).toString("hex") + "@example.test";
    const identity = await pool.connect(), creation = await pool.connect();
    const pending: Promise<unknown>[] = [];
    try {
      await pool.query("UPDATE settings SET data=data || '{\"usersCanRegister\":true,\"defaultRole\":\"subscriber\"}' WHERE id=1");
      await identity.query("BEGIN"); await identity.query(identitySQL);
      const identityPid = (await identity.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
      let migrating: Promise<void> | undefined;
      if (first === "migration") {
        await creation.query("BEGIN"); await creation.query(creationSQL);
        migrating = migrate(); pending.push(migrating);
        const waiting = await waitState(pool, "migration at creation barrier", blockedQuery, ["worldact-user-creation"]);
        assert.equal(await held(pool, "worldact-migration", waiting.pid), 1);
        await noApplicationRelations(pool, waiting.pid);
      }
      const updating = api("/api/profile", "PUT", { displayName: "Migration row order " + first }, cookie); pending.push(updating);
      const profile = await waitState(pool, "profile holds actor while waiting identity", blockedQuery + " AND $2=ANY(pg_blocking_pids(a.pid))", ["worldact-account-identity", identityPid]);
      await assert.rejects(pool.query("SELECT id FROM users WHERE id=$1 FOR UPDATE NOWAIT", [actorId]), error => (error as { code?: string }).code === "55P03");
      if (first === "profile") { migrating = migrate(); pending.push(migrating); }
      else await creation.query("COMMIT");
      const ddl = await waitState(pool, "migration waits for actor's users relation before other tables", blockedQuery, ["LOCK TABLE users IN ACCESS EXCLUSIVE MODE"]);
      assert.ok(ddl.blockers.includes(profile.pid));
      assert.equal(await held(pool, "worldact-user-creation", ddl.pid), 1);
      assert.deepEqual((await pool.query("SELECT c.relname FROM pg_locks l JOIN pg_class c ON c.oid=l.relation JOIN pg_namespace n ON n.oid=c.relnamespace WHERE l.pid=$1 AND l.granted AND n.nspname='public'", [ddl.pid])).rows, []);
      const registering = api("/api/auth/register", "POST", { username: "barrier-" + first + "-" + randomBytes(5).toString("hex"), email }); pending.push(registering);
      const creator = await waitState(pool, "registration waits without settings/users relation", blockedQuery + " AND $2=ANY(pg_blocking_pids(a.pid))", ["worldact-user-creation", ddl.pid]);
      await noApplicationRelations(pool, creator.pid);
      assert.equal(await held(pool, "worldact-account-identity", creator.pid), 0);
      await identity.query("COMMIT");
      const updated = await updating; assert.equal(updated.response.status, 200, JSON.stringify(updated.data));
      assert.ok(migrating); await migrating;
      const registered = await registering; assert.equal(registered.response.status, 201, JSON.stringify(registered.data));
      assert.equal((await pool.query("SELECT count(*)::int AS n FROM users WHERE email=$1 AND nicename IS NOT NULL AND role='subscriber'", [email])).rows[0].n, 1);
      assert.equal((await pool.query("SELECT count(*)::int AS n FROM mail_outbox WHERE recipient=$1", [email])).rows[0].n, 1);
    } finally {
      await identity.query("ROLLBACK"); await creation.query("ROLLBACK");
      await Promise.allSettled(pending);
      identity.release(); creation.release();
      await pool.query("UPDATE users SET display_name=$1 WHERE id=$2", [oldName, actorId]);
      await pool.query("UPDATE settings SET data=$1 WHERE id=1", [JSON.stringify(settings)]);
      await pool.query("DELETE FROM users WHERE email=$1", [email]);
      await pool.query("DELETE FROM mail_outbox WHERE recipient=$1", [email]);
      await api("/api/auth/logout", "POST", undefined, cookie);
    }
  });
}

test("real seed locks an existing administrator before identity when initial content marker is absent", { timeout: 120000 }, async () => {
  await ownDatabase(async (db, run, env) => {
    const actor = await legacyUser(db, "existing-admin", "existing-admin");
    const token = randomBytes(32).toString("hex");
    await db.query("INSERT INTO sessions(token_hash,user_id,expires_at) VALUES($1,$2,clock_timestamp()+interval '1 hour')", [digest(token), actor.id]);
    const seedGate = await db.connect(), identity = await db.connect();
    const extra: Running[] = [];
    try {
      await seedGate.query("BEGIN"); await seedGate.query("SELECT pg_advisory_xact_lock(hashtext('worldact-seed'))");
      const seed = run("server/seed.ts", "nicename-seed-order");
      const waitingSeed = await waitState(db, "seed completed migrate and waits its seed lock", blockedQuery + " AND a.application_name='nicename-seed-order'", ["worldact-seed"]);
      await identity.query("BEGIN"); await identity.query(identitySQL);
      const identityPid = (await identity.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
      const script = `import { pool } from './server/db.ts'; import { updateUser } from './server/platform.ts'; try { const user=(await pool.query('SELECT id,role FROM users WHERE username=$1',['existing-admin'])).rows[0]; await updateUser({user,authenticationMethod:'session',headers:{cookie:'worldact_session='+process.env.NICENAME_TEST_SESSION},body:{displayName:'Profile completed before seed'}},user.id); } finally { await pool.end(); }`;
      const profile = start(["--import", "tsx", "--input-type=module", "--eval", script], { ...env, PGAPPNAME: "nicename-seed-profile", NICENAME_TEST_SESSION: token }); extra.push(profile);
      const waitingProfile = await waitState(db, "actual profile owns existing admin before identity", blockedQuery + " AND a.application_name='nicename-seed-profile' AND $2=ANY(pg_blocking_pids(a.pid))", ["worldact-account-identity", identityPid]);
      await seedGate.query("COMMIT");
      const seedRow = await waitState(db, "seed waits existing admin before identity", blockedQuery + " AND a.application_name='nicename-seed-order'", ["LIMIT 1 FOR UPDATE"]);
      assert.equal(seedRow.pid, waitingSeed.pid); assert.ok(seedRow.blockers.includes(waitingProfile.pid));
      assert.equal(await held(db, "worldact-account-identity", seedRow.pid), 0);
      assert.equal(await held(db, "worldact-user-creation", seedRow.pid), 1);
      await identity.query("COMMIT");
      await success(profile); await success(seed);
      assert.deepEqual((await db.query("SELECT id,nicename,display_name,password_hash FROM users")).rows, [{ id: actor.id, nicename: "existing-admin", display_name: "Profile completed before seed", password_hash: "preserved-private-password-hash" }]);
      assert.equal((await db.query("SELECT count(*)::int AS n FROM seed_markers WHERE name='initial-content-v1'")).rows[0].n, 1);
      assert.deepEqual((await db.query("SELECT DISTINCT author_id FROM posts")).rows, [{ author_id: actor.id }]);
      assert.equal((await db.query("SELECT count(*)::int AS n FROM posts")).rows[0].n, 3);
      await success(run("server/seed.ts", "nicename-seed-repeat"));
      assert.equal((await db.query("SELECT count(*)::int AS n FROM users")).rows[0].n, 1);
      assert.equal((await db.query("SELECT count(*)::int AS n FROM posts")).rows[0].n, 3);
    } finally {
      await seedGate.query("ROLLBACK"); await identity.query("ROLLBACK");
      await Promise.all(extra.map(stop)); seedGate.release(); identity.release();
    }
  });
});
