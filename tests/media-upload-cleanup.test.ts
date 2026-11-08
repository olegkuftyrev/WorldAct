import test, { after } from "./isolated-test.js";
import "dotenv/config";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { readdir } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import type { PoolClient } from "pg";
import { pool, uploadsDir } from "../server/db.js";

const base = process.env.TEST_API_URL!, origin = process.env.APP_ORIGIN!;
after(() => pool.end());
const inventory = async () => (await readdir(uploadsDir, { recursive: true, withFileTypes: true }))
  .filter(entry => entry.isFile()).map(entry => path.relative(uploadsDir, path.join(entry.parentPath, entry.name))).sort();

async function waitForUploadPool(blocker: number, expected: number) {
  const deadline = Date.now() + 8_000;
  let observed = 0;
  do {
    // Advisory waiters can queue behind other waiters, so follow the complete
    // PostgreSQL lock graph instead of assuming every waiter names our holder.
    const result = await pool.query(
      `WITH RECURSIVE blocked(pid) AS (
         SELECT $1::int
         UNION SELECT a.pid FROM pg_stat_activity a JOIN blocked b ON b.pid=ANY(pg_blocking_pids(a.pid)) WHERE a.datname=current_database()
       ) SELECT a.pid FROM pg_stat_activity a JOIN blocked b ON b.pid=a.pid
         WHERE a.pid<>$1 AND position($2 in a.query)>0`,
      [blocker, "INSERT INTO media("],
    );
    observed = result.rowCount || 0;
    if (observed === expected) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  } while (Date.now() < deadline);
  assert.fail(`Expected ${expected} upload transactions to occupy the server pool; observed ${observed}`);
}

test("ten failed uploads release transaction clients before reference-aware file cleanup", { timeout: 35_000 }, async () => {
  const suffix = randomBytes(6).toString("hex"), trigger = "upload_cleanup_" + suffix;
  const title = "upload-cleanup-" + suffix, namespace = 18761342, key = randomBytes(4).readUInt32BE() % 2147483647;
  let cookie = "", locker: PoolClient | undefined, requests: Array<Promise<{ status: number; data: unknown }>> = [];
  let triggerCreated = false, functionCreated = false;
  const login = await fetch(base + "/api/auth/login", {
    method: "POST", signal: AbortSignal.timeout(10_000),
    headers: { Origin: origin, "Content-Type": "application/json" },
    body: JSON.stringify({ login: process.env.ADMIN_EMAIL, password: process.env.ADMIN_PASSWORD }),
  });
  assert.equal(login.status, 200); cookie = login.headers.get("set-cookie")!.split(";")[0];
  const beforeFiles = await inventory(), beforeCount = (await pool.query("SELECT count(*)::int AS n FROM media")).rows[0].n;
  try {
    // These identifiers/literals contain generated hexadecimal characters only.
    // The barrier is private to this test and only intercepts its own titles.
    await pool.query(`CREATE FUNCTION ${trigger}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF left(NEW.title,${title.length})='${title}' THEN
        PERFORM pg_advisory_xact_lock(${namespace},${key});
        RAISE EXCEPTION 'Controlled upload insertion failure';
      END IF; RETURN NEW; END $$`);
    functionCreated = true;
    await pool.query(`CREATE TRIGGER ${trigger} BEFORE INSERT ON media FOR EACH ROW EXECUTE FUNCTION ${trigger}()`);
    triggerCreated = true;
    locker = await pool.connect(); await locker.query("BEGIN");
    const pid = (await locker.query("SELECT pg_backend_pid() AS pid")).rows[0].pid as number;
    await locker.query("SELECT pg_advisory_xact_lock($1,$2)", [namespace, key]);
    const image = await sharp({ create: { width: 20, height: 12, channels: 3, background: "#2769a8" } }).png().toBuffer();
    requests = Array.from({ length: 10 }, (_, index) => {
      const form = new FormData();
      form.append("file", new Blob([new Uint8Array(image)], { type: "image/png" }), `${title}-${index}.png`);
      return fetch(base + "/api/media", {
        method: "POST", signal: AbortSignal.timeout(20_000),
        headers: { Origin: origin, Cookie: cookie }, body: form,
      }).then(async response => ({ status: response.status, data: await response.json() }));
    });
    await waitForUploadPool(pid, 10);
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM media")).rows[0].n, beforeCount, "No blocked insert has committed");
    const staged = await inventory();
    assert.equal(staged.length, beforeFiles.length + 10, "Every failed transaction already owns a tiny full-image file");
    await locker.query("COMMIT"); locker.release(); locker = undefined;
    const results = await Promise.all(requests); requests = [];
    assert.deepEqual(results.map(result => result.status), Array(10).fill(500), JSON.stringify(results));
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM media")).rows[0].n, beforeCount);
    // Holding all ten clients while issuing cleanup through pool.query would
    // exhaust the same pool: at least one timed-out cleanup leaves its raw file.
    assert.deepEqual(await inventory(), beforeFiles, "All raw/generated files are removed without starving reference checks");
    const health = await fetch(base + "/api/health", { signal: AbortSignal.timeout(3_000) });
    assert.equal(health.status, 200, "The complete server pool remains reusable");
  } finally {
    if (locker) { await locker.query("ROLLBACK").catch(() => {}); locker.release(); }
    await Promise.allSettled(requests);
    if (triggerCreated) await pool.query(`DROP TRIGGER IF EXISTS ${trigger} ON media`);
    if (functionCreated) await pool.query(`DROP FUNCTION IF EXISTS ${trigger}()`);
    if (cookie) await fetch(base + "/api/auth/logout", {
      method: "POST", signal: AbortSignal.timeout(10_000),
      headers: { Origin: origin, Cookie: cookie, "Content-Type": "application/json" }, body: "{}",
    }).catch(() => {});
  }
});
