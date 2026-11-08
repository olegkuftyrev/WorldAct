import test, { after } from "./isolated-test.js";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { pool } from "../server/db.js";
const base = process.env.TEST_API_URL!;
const origin = process.env.APP_ORIGIN!;
after(async () => { await pool.end(); });

test("explicit Remember Me uses fourteen-day persistence while unchecked login is a two-day browser session", async () => {
  for (const remember of [false, true]) {
    const response = await fetch(base + "/api/auth/login", { method: "POST", headers: { Origin: origin, "Content-Type": "application/json" }, body: JSON.stringify({ login: process.env.ADMIN_EMAIL, password: process.env.ADMIN_PASSWORD, remember }) });
    assert.equal(response.status, 200);
    const cookie = response.headers.get("set-cookie")!;
    if (remember) assert.match(cookie, /Max-Age=1209600/);
    else assert.doesNotMatch(cookie, /Max-Age=|Expires=/i);
    const token = cookie.split(";")[0].slice(cookie.indexOf("=") + 1);
    const hash = createHash("sha256").update(decodeURIComponent(token)).digest("hex");
    const row = (await pool.query("SELECT extract(epoch from (expires_at-now())) AS seconds FROM sessions WHERE token_hash=$1", [hash])).rows[0];
    const seconds = Number(row.seconds), expected = (remember ? 14 : 2) * 86400;
    assert.ok(seconds > expected - 30 && seconds <= expected, "Database session expiry follows the submitted choice");
    await pool.query("DELETE FROM sessions WHERE token_hash=$1", [hash]);
  }
});
