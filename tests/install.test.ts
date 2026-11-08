import test, { after } from "./isolated-test.js";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, stat, symlink, copyFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import dotenv from "dotenv";
import { installationTokenMatches } from "../server/install.js";
import { pool, rootDir } from "../server/db.js";

after(async () => { await pool.end(); });
const base = process.env.TEST_API_URL!, origin = process.env.APP_ORIGIN!;
const unseeded = process.env.ISOLATED_TEST_UNSEEDED === "true";
async function api(path: string, method = "GET", body?: unknown, requestOrigin = origin) {
  const response = await fetch(base + path, { method, signal: AbortSignal.timeout(15000), headers: { Origin: requestOrigin, "Content-Type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { response, data: await response.json() };
}
test("installation bootstrap tokens require exact nonempty server-owned secrets", () => {
  const token = "7a".repeat(32);
  assert.equal(installationTokenMatches(token, token), true);
  for (const input of ["", "7a", token.toUpperCase(), "0".repeat(64), token + "0"]) assert.equal(installationTokenMatches(input, token), false);
  assert.equal(installationTokenMatches(token, null), false);
});
test("local browser preparation creates a private fragment link without seeding or changing existing CLI setup", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "worldact-bootstrap-test-")), scripts = path.join(directory, "scripts"), bin = path.join(directory, "bin"), log = path.join(directory, "commands.log");
  try {
    await mkdir(scripts); await mkdir(bin);
    await copyFile(path.join(rootDir, "scripts/setup.mjs"), path.join(scripts, "setup.mjs"));
    await copyFile(path.join(rootDir, ".env.example"), path.join(directory, ".env.example"));
    await symlink(path.join(rootDir, "node_modules"), path.join(directory, "node_modules"), "dir");
    for (const command of ["docker", "npm"]) await writeFile(path.join(bin, command), '#!/bin/sh\nprintf "%s\\n" "$*" >> "$WORLDACT_BOOTSTRAP_COMMAND_LOG"\n', { mode: 0o700 });
    const run = (browser: boolean) => spawnSync(process.execPath, [path.join(scripts, "setup.mjs"), ...(browser ? ["--browser"] : [])], { cwd: directory, encoding: "utf8", timeout: 15000, env: { ...process.env, PATH: bin + path.delimiter + process.env.PATH, WORLDACT_BOOTSTRAP_COMMAND_LOG: log } });
    const first = run(true); assert.equal(first.status, 0, first.stderr);
    const envPath = path.join(directory, ".env"), settings = dotenv.parse(await readFile(envPath));
    assert.equal((await stat(envPath)).mode & 0o777, 0o600); assert.ok(/^[a-f0-9]{64}$/.test(settings.WORLDACT_INSTALL_TOKEN)); assert.notEqual(settings.ADMIN_PASSWORD, "change-this-worldact-password");
    const link = first.stdout.split("\n").find(line => line.startsWith("http"))!; const url = new URL(link); assert.equal(url.pathname, "/install"); assert.equal(url.search, ""); assert.equal(url.hash, "#token=" + settings.WORLDACT_INSTALL_TOKEN);
    assert.equal(await readFile(log, "utf8"), "compose up -d --wait db\nrun db:migrate\n");
    const second = run(true); assert.equal(second.status, 0, second.stderr); const rotated = dotenv.parse(await readFile(envPath)); assert.notEqual(rotated.WORLDACT_INSTALL_TOKEN, settings.WORLDACT_INSTALL_TOKEN); assert.equal(rotated.ADMIN_PASSWORD, settings.ADMIN_PASSWORD);
    const cli = run(false); assert.equal(cli.status, 0, cli.stderr); assert.ok((await readFile(log, "utf8")).endsWith("run db:seed\n")); assert.ok(!cli.stdout.includes(rotated.WORLDACT_INSTALL_TOKEN));
    assert.equal((await stat(envPath)).mode & 0o777, 0o600);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
test("initialized sites expose no installer or credentials", { skip: unseeded }, async () => {
  const before = (await pool.query("SELECT count(*)::int AS count FROM users")).rows[0].count;
  const state = await api("/api/install"); assert.equal(state.response.status, 200); assert.equal(state.data.installed, true); assert.equal(state.data.available, false); assert.doesNotMatch(JSON.stringify(state.data), /token|password|email|username/);
  const rejected = await api("/api/install", "POST", { token: "0".repeat(64), siteTitle: "Must stay unchanged", username: "installer", email: "installer@example.test", password: "Only-a-test-password" }); assert.ok([403, 409].includes(rejected.response.status));
  assert.equal((await pool.query("SELECT count(*)::int AS count FROM users")).rows[0].count, before);
});
test("a fresh migrated PostgreSQL site installs atomically once through its local bootstrap link", { skip: !unseeded, timeout: 60000 }, async t => {
  const token = process.env.WORLDACT_INSTALL_TOKEN!, stamp = "installer-" + Date.now().toString(36);
  const input = { token, siteTitle: "My <b>WorldAct</b> Site", username: stamp, email: process.env.ADMIN_EMAIL!, password: process.env.ADMIN_PASSWORD!, discourageSearchEngines: true };
  assert.equal((await pool.query("SELECT count(*)::int AS count FROM users")).rows[0].count, 0);
  await t.test("GET is read-only and omitted/invalid tokens or foreign origins create nothing", async () => {
    const state = await api("/api/install"); assert.deepEqual(state.data, { installed: false, available: true, language: "en_US" }); assert.match(state.response.headers.get("cache-control") || "", /no-store/);
    assert.equal((await api("/api/install", "POST", { ...input, token: "0".repeat(64) })).response.status, 403);
    const { token: _ignored, ...without } = input; assert.equal((await api("/api/install", "POST", without)).response.status, 400);
    assert.equal((await api("/api/install", "POST", input, "https://foreign.invalid")).response.status, 403);
    for (const patch of [{ username: "bad user" }, { email: "invalid" }, { password: "short" }, { siteTitle: "<script></script>" }, { role: "administrator" }]) assert.equal((await api("/api/install", "POST", { ...input, ...patch })).response.status, 400);
    assert.equal((await pool.query("SELECT count(*)::int AS count FROM users")).rows[0].count, 0);
  });
  await t.test("a late initialization failure rolls back account, settings, content, markers and welcome mail", async () => {
    await pool.query("CREATE FUNCTION worldact_install_test_failure() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN RAISE EXCEPTION 'Controlled install content failure'; END$$; CREATE TRIGGER worldact_install_test_failure AFTER INSERT ON mail_outbox FOR EACH ROW EXECUTE FUNCTION worldact_install_test_failure()");
    try {
      assert.equal((await api("/api/install", "POST", input)).response.status, 500);
      for (const table of ["users", "posts", "settings", "extensions", "extension_secrets", "mail_outbox"]) assert.equal((await pool.query(`SELECT count(*)::int AS count FROM ${table}`)).rows[0].count, 0, table);
      assert.equal((await pool.query("SELECT count(*)::int AS count FROM seed_markers WHERE name IN('initial-content-v1','browser-install-v1')")).rows[0].count, 0);
      assert.equal((await api("/api/install")).data.installed, false);
    } finally { await pool.query("DROP TRIGGER worldact_install_test_failure ON mail_outbox; DROP FUNCTION worldact_install_test_failure()"); }
  });
  let userId = 0;
  await t.test("two concurrent installers create one administrator and one sample site", async () => {
    const responses = await Promise.all([api("/api/install", "POST", input), api("/api/install", "POST", { ...input, username: stamp + "-other" })]);
    assert.deepEqual(responses.map(result => result.response.status).sort(), [201, 409]);
    const result = responses.find(result => result.response.status === 201)!; userId = result.data.user.id;
    assert.equal(result.data.user.role, "administrator"); assert.equal(result.data.delivery, "local-outbox"); assert.equal(result.data.loginUrl, "/login"); assert.doesNotMatch(JSON.stringify(result.data), /password_hash|token_hash/); assert.ok(!JSON.stringify(result.data).includes(token));
    assert.equal((await pool.query("SELECT count(*)::int AS count FROM users")).rows[0].count, 1);
    assert.equal((await pool.query("SELECT count(*)::int AS count FROM posts")).rows[0].count, 3); assert.equal((await pool.query("SELECT count(*)::int AS count FROM comments")).rows[0].count, 1);
    const defaults=(await pool.query("SELECT type,slug,status,comment_status,template_slug,raw_content FROM posts ORDER BY id")).rows;
    assert.deepEqual(defaults.map(row=>row.status),["publish","publish","draft"]);
    assert.deepEqual(defaults.map(row=>row.slug),["hello-world","sample-page","privacy-policy"]);
    assert.ok(defaults.every(row=>row.raw_content.includes("<!-- wp:")));
    assert.equal(defaults[1].comment_status,"closed");assert.equal(defaults[2].comment_status,"closed");assert.equal(defaults[2].template_slug,"");
    const plugins=(await pool.query("SELECT slug,enabled FROM extensions ORDER BY slug")).rows;
    assert.deepEqual(plugins,[{slug:"akismet",enabled:false},{slug:"hello-dolly",enabled:false}]);
    const policy=(await pool.query("SELECT id FROM posts WHERE slug='privacy-policy'")).rows[0];
    assert.equal((await pool.query("SELECT data->>'privacyPageId' AS id FROM settings WHERE id=1")).rows[0].id,String(policy.id));
    assert.equal((await api("/api/public/posts/privacy-policy")).response.status,404);
    const publicSite=await api("/api/public/site");assert.equal(publicSite.response.status,200);assert.equal(publicSite.data.pages.length,1);assert.equal(publicSite.data.posts.length,1);
    const settings = (await pool.query("SELECT data FROM settings WHERE id=1")).rows[0].data; assert.equal(settings.siteTitle, "My WorldAct Site"); assert.equal(settings.adminEmail, input.email); assert.equal(settings.discourageSearchEngines, true); assert.equal(settings.siteUrl, origin);
    const mail = (await pool.query("SELECT recipient,body FROM mail_outbox")).rows; assert.equal(mail.length, 1); assert.equal(mail[0].recipient, input.email); assert.ok(!mail[0].body.includes(input.password)); assert.ok(!mail[0].body.includes(token));
    const login = await api("/api/auth/login", "POST", { login: result.data.user.username, password: input.password }); assert.equal(login.response.status, 200); assert.equal(login.data.user.id, userId);
    const cookie = login.response.headers.get("set-cookie")!.split(";")[0]; await fetch(base + "/api/auth/logout", { method: "POST", headers: { Origin: origin, Cookie: cookie } });
  });
  await t.test("installation stays closed after replay and even after all accounts are removed", async () => {
    assert.deepEqual((await api("/api/install")).data, { installed: true, available: false, language: "en_US" });
    assert.equal((await api("/api/install", "POST", input)).response.status, 409);
    // This database belongs only to this unseeded test. Retain durable install markers.
    await pool.query("DELETE FROM comments; DELETE FROM post_terms; DELETE FROM posts");
    await pool.query("DELETE FROM users WHERE id=$1", [userId]);
    assert.equal((await api("/api/install")).data.installed, true); assert.equal((await api("/api/install", "POST", input)).response.status, 409);
  });
});
