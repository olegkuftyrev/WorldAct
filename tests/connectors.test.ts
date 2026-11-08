import test, { before, after } from "./isolated-test.js";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { pool, getSettings } from "../server/db.js";
import type { AuthRequest } from "../server/auth.js";
import { createAkismetClient, verifyAkismetKey, updateAkismetConfiguration } from "../server/bundled-plugins.js";

const base = process.env.TEST_API_URL!, origin = process.env.APP_ORIGIN!;
let cookie = "", actor: AuthRequest, editorCookie = "";
let initialPlugin: any, initialSecret: any, editorId: number | undefined;
async function request(path: string, method = "GET", body?: unknown, auth = cookie) {
  const response = await fetch(base + "/api" + path, {
    method, headers: { Origin: origin, "Content-Type": "application/json", ...(auth ? { Cookie: auth } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, data: await response.json() };
}
async function ok(path: string, method = "GET", body?: unknown) {
  const result = await request(path, method, body);
  assert.ok(result.status >= 200 && result.status < 300, JSON.stringify({ path, ...result }));
  return result.data;
}
async function login(login: string, password: string) {
  const response = await fetch(base + "/api/auth/login", {
    method: "POST", headers: { Origin: origin, "Content-Type": "application/json" }, body: JSON.stringify({ login, password }),
  });
  assert.equal(response.status, 200);
  return { cookie: response.headers.get("set-cookie")!.split(";")[0], user: (await response.json()).user };
}
before(async () => {
  initialPlugin = (await pool.query("SELECT * FROM extensions WHERE slug='akismet'")).rows[0];
  initialSecret = (await pool.query("SELECT * FROM extension_secrets WHERE slug='akismet'")).rows[0];
  const session = await login(process.env.ADMIN_EMAIL!, process.env.ADMIN_PASSWORD!);
  cookie = session.cookie;
  actor = { user: session.user, headers: { cookie }, authenticationMethod: "session" } as AuthRequest;
  const username = "connector-editor-" + Date.now(), password = "Editor-isolated-7Wj-R9s-4Kv";
  editorId = (await ok("/users", "POST", { username, email: username + "@example.test", displayName: "Connector editor", password, role: "editor" })).user.id;
  editorCookie = (await login(username, password)).cookie;
});
after(async () => {
  try {
    if (editorId) await pool.query("DELETE FROM users WHERE id=$1", [editorId]);
    await pool.query("DELETE FROM extension_secrets WHERE slug='akismet'");
    if (initialPlugin) {
      await pool.query("INSERT INTO extensions(slug,enabled,settings,installed_at) VALUES('akismet',$1,$2::jsonb,$3) ON CONFLICT(slug) DO UPDATE SET enabled=excluded.enabled,settings=excluded.settings,installed_at=excluded.installed_at", [initialPlugin.enabled, JSON.stringify(initialPlugin.settings), initialPlugin.installed_at]);
      if (initialSecret) await pool.query("INSERT INTO extension_secrets(slug,api_key,verified_site_url,verified_at,last_error_code,updated_at) VALUES('akismet',$1,$2,$3,$4,$5)", [initialSecret.api_key, initialSecret.verified_site_url, initialSecret.verified_at, initialSecret.last_error_code, initialSecret.updated_at]);
    } else await pool.query("DELETE FROM extensions WHERE slug='akismet'");
  } finally { await pool.end(); }
});

test("connector registry and mutations require an administrator and never invent unsupported providers", async () => {
  for (const auth of ["", editorCookie]) {
    for (const [path, method, body] of [["/connectors", "GET", undefined], ["/connectors/akismet", "PUT", { apiKey: "fakeSecret123456" }], ["/connectors/akismet/verify", "POST", {}]] as const) {
      assert.equal((await request(path, method, body, auth)).status, auth ? 403 : 401);
    }
  }
  const registry = await ok("/connectors");
  assert.deepEqual(registry.connectors.map((item: any) => item.id), ["akismet"]);
  assert.equal(registry.connectors[0].connected, false);
  assert.equal((await request("/connectors/openai", "PUT", { apiKey: "fakeSecret123456" })).status, 404);
});

test("Connectors and Plugins share activation, one write-only credential and actual processing consent", async () => {
  await ok("/plugins/akismet", "PUT", { enabled: false, clearApiKey: true });
  await ok("/plugins/akismet", "DELETE");
  assert.equal((await ok("/connectors")).connectors[0].installed, false);
  assert.equal((await request("/connectors/akismet", "PUT", { apiKey: "fakeSecret123456" })).status, 404);
  await ok("/plugins/akismet/install", "POST", {});
  assert.equal((await request("/connectors/akismet", "PUT", { apiKey: "fakeSecret123456" })).status, 409);
  await ok("/plugins/akismet", "PUT", { enabled: true, settings: { sendComments: false } });
  const key = "fakeConnectorSharedKey123456";
  const configured = (await ok("/connectors/akismet", "PUT", { apiKey: key })).connector;
  assert.equal(configured.active, true);
  assert.equal(configured.apiKeyConfigured, true);
  assert.equal(configured.keySource, "database");
  assert.equal(configured.connected, false);
  assert.equal(configured.sendComments, false);
  assert.equal((await request("/connectors/akismet/verify", "POST", {})).status, 409);
  await ok("/connectors/akismet", "PUT", { apiKey: "", sendComments: true });
  assert.equal((await pool.query("SELECT api_key FROM extension_secrets WHERE slug='akismet'")).rows[0].api_key, key);
  const plugin = (await ok("/plugins")).plugins.find((item: any) => item.slug === "akismet");
  assert.equal(plugin.settings.sendComments, true);
  assert.equal(plugin.apiKeyConfigured, true);
  for (const route of ["/connectors", "/plugins", "/tools/export", "/public/design"]) {
    assert.ok(!JSON.stringify(await ok(route)).includes(key), route);
  }
  for (const input of [{ apiKey: "abc\ncommand" }, { apiKey: key, clearApiKey: true }, { settings: { apiKey: key } }, { enabled: true }, { sendComments: "true" }])
    assert.equal((await request("/connectors/akismet", "PUT", input)).status, 400);
  await ok("/connectors/akismet", "PUT", { clearApiKey: true });
  assert.equal((await ok("/connectors")).connectors[0].apiKeyConfigured, false);
  assert.equal((await pool.query("SELECT 1 FROM extension_secrets WHERE slug='akismet'")).rowCount, 0);
});

const service = (value: string, seen?: (key: string, site: string) => void) => createAkismetClient((async (_url, init) => {
  const fields = init!.body as URLSearchParams;
  seen?.(fields.get("api_key")!, fields.get("blog")!);
  return new Response(value);
}) as typeof fetch);
test("real verification service publishes valid, invalid and unavailable outcomes without returning keys", async () => {
  await updateAkismetConfiguration(actor, { enabled: true, settings: { sendComments: true }, apiKey: "fakeVerifiedConnector123" });
  let calls = 0;
  const valid = await verifyAkismetKey(actor, service("valid", (key, site) => {
    calls++; assert.equal(key, "fakeVerifiedConnector123"); assert.equal(site, new URL((site)).href);
  }));
  assert.equal(calls, 1); assert.equal(valid.result, "valid"); assert.equal(valid.keyVerified, true);
  assert.equal((await ok("/connectors")).connectors[0].connected, true);
  assert.ok(!JSON.stringify(valid).includes("fakeVerifiedConnector123"));
  const invalid = await verifyAkismetKey(actor, service("invalid"));
  assert.equal(invalid.result, "invalid"); assert.equal(invalid.keyVerified, false); assert.equal(invalid.lastServiceError, "invalid");
  const unavailable = await verifyAkismetKey(actor, service("Unexpected service body"));
  assert.equal(unavailable.result, "unavailable"); assert.equal(unavailable.keyVerified, false);
  assert.equal((await ok("/connectors")).connectors[0].connected, false);
});

test("in-flight verification releases all pool clients and cannot validate a replacement key or changed site", async () => {
  for (const change of ["key", "site", "consent"] as const) {
    await updateAkismetConfiguration(actor, { enabled: true, settings: { sendComments: true }, apiKey: "fakeBeforeDelayed123" });
    let release!: () => void, started!: () => void;
    const barrier = new Promise<void>(resolve => { release = resolve; });
    const entered = new Promise<void>(resolve => { started = resolve; });
    const pending = verifyAkismetKey(actor, createAkismetClient((async () => { started(); await barrier; return new Response("valid"); }) as typeof fetch));
    // Attach the rejection handler before deliberately retiring the snapshot.
    const rejected = assert.rejects(pending, (error: any) => error.status === 409);
    await entered;
    const clients = await Promise.all(Array.from({ length: 10 }, () => pool.connect()));
    clients.forEach(client => client.release());
    const oldSite = (await getSettings()).siteUrl;
    try {
      if (change === "key") await updateAkismetConfiguration(actor, { apiKey: "fakeReplacementKey456" });
      if (change === "site") await pool.query("UPDATE settings SET data=data || $1::jsonb WHERE id=1", [JSON.stringify({ siteUrl: "https://changed.example.test/" })]);
      if (change === "consent") await updateAkismetConfiguration(actor, { settings: { sendComments: false } });
      release(); await rejected;
      assert.equal((await pool.query("SELECT verified_at FROM extension_secrets WHERE slug='akismet'")).rows[0].verified_at, null);
    } finally {
      release(); await pending.catch(() => {});
      await pool.query("UPDATE settings SET data=data || $1::jsonb WHERE id=1", [JSON.stringify({ siteUrl: oldSite })]);
    }
  }
});

test("verification rechecks the signing account after I/O before publishing a credential result", async () => {
  await updateAkismetConfiguration(actor, { enabled: true, settings: { sendComments: true }, apiKey: "fakeBeforeSessionRevoked123" });
  const session = await login(process.env.ADMIN_EMAIL!, process.env.ADMIN_PASSWORD!);
  const requestActor = { user: session.user, headers: { cookie: session.cookie }, authenticationMethod: "session" } as AuthRequest;
  let release!: () => void, started!: () => void;
  const barrier = new Promise<void>(resolve => { release = resolve; });
  const entered = new Promise<void>(resolve => { started = resolve; });
  const pending = verifyAkismetKey(requestActor, createAkismetClient((async () => { started(); await barrier; return new Response("valid"); }) as typeof fetch));
  const rejected = assert.rejects(pending, (error: any) => error.status === 401);
  try {
    await entered;
    const token = session.cookie.split("=")[1];
    await pool.query("DELETE FROM sessions WHERE token_hash=$1", [createHash("sha256").update(token).digest("hex")]);
    release(); await rejected;
    assert.equal((await pool.query("SELECT verified_at FROM extension_secrets WHERE slug='akismet'")).rows[0].verified_at, null);
  } finally { release(); await pending.catch(() => {}); }
});

async function waitForActorLock() {
  for (let count = 0; count < 100; count++) {
    const waiting = await pool.query("SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid() AND wait_event_type='Lock' AND query LIKE 'SELECT role FROM users WHERE id=%FOR UPDATE'");
    if (waiting.rowCount) return;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error("Expected the real connector mutation to wait for its actor lock.");
}
test("a queued connector write rechecks an administrator role after its actor lock", async () => {
  const blocker = await pool.connect();
  let pending: ReturnType<typeof request> | undefined;
  try {
    await blocker.query("BEGIN");
    await blocker.query("SELECT id FROM users WHERE id=$1 FOR UPDATE", [actor.user!.id]);
    pending = request("/connectors/akismet", "PUT", { apiKey: "fakeMustNotBeSaved789" });
    await waitForActorLock();
    await blocker.query("UPDATE users SET role='editor' WHERE id=$1", [actor.user!.id]);
    await blocker.query("COMMIT");
    assert.equal((await pending).status, 403);
    assert.notEqual((await pool.query("SELECT api_key FROM extension_secrets WHERE slug='akismet'")).rows[0].api_key, "fakeMustNotBeSaved789");
  } finally {
    await blocker.query("ROLLBACK"); blocker.release();
    await pending;
    await pool.query("UPDATE users SET role='administrator' WHERE id=$1", [actor.user!.id]);
  }
});

test("a queued connector write rechecks a revoked session and verification rejects unsupported request fields", async () => {
  assert.equal((await request("/connectors/akismet/verify", "POST", { endpoint: "https://evil.example.test/" })).status, 400);
  const blocker = await pool.connect();
  let pending: ReturnType<typeof request> | undefined;
  try {
    await blocker.query("BEGIN");
    await blocker.query("SELECT id FROM users WHERE id=$1 FOR UPDATE", [actor.user!.id]);
    pending = request("/connectors/akismet", "PUT", { apiKey: "fakeRevokedMustNotSave123" });
    await waitForActorLock();
    await blocker.query("DELETE FROM sessions WHERE user_id=$1", [actor.user!.id]);
    await blocker.query("COMMIT");
    assert.equal((await pending).status, 401);
  } finally {
    await blocker.query("ROLLBACK"); blocker.release(); await pending;
  }
});
