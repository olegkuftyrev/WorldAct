import test, { after } from "./isolated-test.js";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { pool, rootDir } from "../server/db.js";
import { assertCommentFloodAllowed, commentFloodInterval, recordCommentFloodMetadata, cleanupCommentFloodMetadata } from "../server/comment-flood.js";
after(() => pool.end());

test("persisted source flood identities, statuses and integer-second boundaries", async t => {
  const user = (await pool.query("SELECT id FROM users WHERE role='administrator' ORDER BY id LIMIT 1")).rows[0].id;
  const post = (await pool.query("INSERT INTO posts(type,title,slug,author_id,status,post_date,post_date_gmt) VALUES('post','Flood policy','flood-policy-'||gen_random_uuid(),$1,'publish',to_char(CASE WHEN coalesce((SELECT data->>'timezone' FROM settings WHERE id=1),'America/Los_Angeles')~'^[+-]' THEN timezone(coalesce((SELECT data->>'timezone' FROM settings WHERE id=1),'America/Los_Angeles')::interval,coalesce(CASE WHEN 'publish'='future' THEN NULL::timestamptz END,NULL::timestamptz,NULL::timestamptz,now())) ELSE timezone(coalesce((SELECT data->>'timezone' FROM settings WHERE id=1),'America/Los_Angeles'),coalesce(CASE WHEN 'publish'='future' THEN NULL::timestamptz END,NULL::timestamptz,NULL::timestamptz,now())) END,'YYYY-MM-DD\"T\"HH24:MI:SS'),coalesce(CASE WHEN 'publish'='future' THEN NULL::timestamptz END,NULL::timestamptz,NULL::timestamptz,now())) RETURNING id", [user])).rows[0].id;
  const current = new Date("2026-11-08T20:00:00Z");
  const guest = { email: "guest@example.test", ip: "192.0.2.4" };
  async function predecessor(values: { age?: number; email?: string; ip?: string; status?: string; type?: string; userId?: number } = {}) {
    const created = new Date(current.getTime() - (values.age ?? 1) * 1000);
    const row = (await pool.query("INSERT INTO comments(post_id,author_name,author_email,content,status,type,user_id,created_at,author_url) VALUES($1,'Prior',$2,'Prior body',$3,$4,$5,$6,$7) RETURNING id", [post, values.email ?? guest.email, values.status ?? "pending", values.type ?? "comment", values.userId ?? null, created, values.type && values.type !== "comment" ? `https://example.test/${Math.random()}` : ""])).rows[0];
    await recordCommentFloodMetadata(pool, row.id, values.ip ?? guest.ip, created);
    return row.id;
  }
  async function clear() { await pool.query("DELETE FROM comments WHERE post_id=$1", [post]); }
  const allowed = (input = guest) => assertCommentFloodAllowed(pool, input, current);
  const flooded = (input = guest) => assert.rejects(allowed(input), { status: 429, message: "You are posting comments too quickly. Slow down." });
  try {
    await t.test("exact15 permits; same-second,14 and future times reject after second truncation", async () => {
      for (const [last, result] of [["19:59:45.999Z", false], ["19:59:46.000Z", true], ["20:00:00.999Z", true], ["20:00:01.000Z", true]] as const)
        assert.equal(commentFloodInterval(new Date("2026-11-08T" + last), current), result);
      for (const age of [15,16]) { await clear(); await predecessor({ age }); await allowed(); }
      for (const age of [0,14,-1]) { await clear(); await predecessor({ age }); await flooded(); }
    });
    await t.test("approved, pending, spam and trash all participate; newest timestamp wins", async () => {
      for (const status of ["approved","pending","spam","trash"]) { await clear(); await predecessor({ status }); await flooded(); }
      await clear(); await predecessor({ age: 1 }); await predecessor({ age: 40 }); await flooded();
    });
    await t.test("guest IP OR case-normalized email and unconditional blank email", async () => {
      await clear(); await predecessor({ email: "another@example.test" }); await flooded();
      await clear(); await predecessor({ ip: "198.51.100.8" }); await flooded({ ...guest, email: guest.email.toUpperCase() });
      await clear(); await predecessor({ email: "", ip: "198.51.100.8" }); await flooded({ email: "", ip: guest.ip });
      await clear(); await predecessor({ email: "another@example.test", ip: "198.51.100.8" }); await allowed();
    });
    await t.test("authenticated matching uses stable user OR current email, never shared IP", async () => {
      const actor = { id: user, role: "subscriber" };
      await clear(); await predecessor({ userId: user, email: "old@example.test", ip: "198.51.100.8" });
      await assert.rejects(assertCommentFloodAllowed(pool, { ...guest, actor }, current), { status: 429 });
      await clear(); await predecessor({ email: "another@example.test" }); await assertCommentFloodAllowed(pool, { ...guest, actor }, current);
      await clear(); await predecessor({ ip: "198.51.100.8" }); await assert.rejects(assertCommentFloodAllowed(pool, { ...guest, actor }, current), { status: 429 });
    });
    await t.test("only current administrator/editor roles are exempt; own author approval is separate", async () => {
      await clear(); await predecessor();
      for (const role of ["administrator","editor"]) await assertCommentFloodAllowed(pool, { ...guest, actor: { id: user, role } }, current);
      for (const role of ["author","contributor","subscriber"]) await assert.rejects(assertCommentFloodAllowed(pool, { ...guest, actor: { id: user, role } }, current), { status: 429 });
    });
    await t.test("typed pings are predecessors for IP and blank-email branches", async () => {
      for (const type of ["pingback","trackback"]) {
        await clear(); await predecessor({ type }); await flooded();
        await clear(); await predecessor({ type, ip: "198.51.100.8" }); await flooded({ email: "", ip: guest.ip });
      }
    });
    await t.test("old history permits, expired IP is ignored and email history needs no IP backfill", async () => {
      await clear(); await predecessor({ age: 3600 });
      await allowed();
      await clear(); const expired = await predecessor({ email: "another@example.test" });
      await pool.query("UPDATE comment_flood_metadata SET expires_at=$2 WHERE comment_id=$1", [expired,current]); await allowed();
      await clear(); const retained = await predecessor(); await pool.query("DELETE FROM comment_flood_metadata WHERE comment_id=$1", [retained]); await flooded();
      await clear(); await predecessor({ age: 3601 }); await allowed();
    });
    await t.test("additive repeated migration preserves populated content and does not backfill IPs", async () => {
      await clear(); const id = await predecessor();
      await pool.query("DELETE FROM comment_flood_metadata WHERE comment_id=$1", [id]);
      const before = (await pool.query("SELECT * FROM comments WHERE id=$1", [id])).rows;
      const sql = await readFile(path.join(rootDir,"server/comments-schema.sql"),"utf8"); await pool.query(sql); await pool.query(sql);
      assert.deepEqual((await pool.query("SELECT * FROM comments WHERE id=$1", [id])).rows,before);
      assert.equal((await pool.query("SELECT count(*)::int AS count FROM comment_flood_metadata WHERE comment_id=$1", [id])).rows[0].count,0);
    });
    await t.test("bounded scheduled cleanup removes expired bytes and permanent deletion cascades", async () => {
      await clear(); const id = await predecessor(); await pool.query("UPDATE comment_flood_metadata SET expires_at=clock_timestamp()-interval '1 second' WHERE comment_id=$1", [id]);
      assert.ok(await cleanupCommentFloodMetadata() >= 1); assert.equal((await pool.query("SELECT count(*)::int AS count FROM comment_flood_metadata WHERE comment_id=$1", [id])).rows[0].count,0);
      const active = await predecessor(); await pool.query("UPDATE comment_flood_metadata SET expires_at=clock_timestamp()+interval '1 hour' WHERE comment_id=$1",[active]);
      await cleanupCommentFloodMetadata(); assert.equal((await pool.query("SELECT count(*)::int AS count FROM comment_flood_metadata WHERE comment_id=$1", [active])).rows[0].count,1);
      await pool.query("DELETE FROM comments WHERE id=$1",[active]); assert.equal((await pool.query("SELECT count(*)::int AS count FROM comment_flood_metadata WHERE comment_id=$1", [active])).rows[0].count,0);
      await clear();
      await pool.query("WITH added AS(INSERT INTO comments(post_id,author_name,author_email,content,status) SELECT $1,'Expired batch','batch@example.test','Expired body','pending' FROM generate_series(1,501) RETURNING id) INSERT INTO comment_flood_metadata(comment_id,author_ip,expires_at) SELECT id,'192.0.2.99',clock_timestamp()-interval '1 second' FROM added",[post]);
      assert.equal(await cleanupCommentFloodMetadata(),500);assert.equal((await pool.query("SELECT count(*)::int AS count FROM comment_flood_metadata m JOIN comments c ON c.id=m.comment_id WHERE c.post_id=$1",[post])).rows[0].count,1);
      assert.equal(await cleanupCommentFloodMetadata(),1);
    });
  } finally { await pool.query("DELETE FROM posts WHERE id=$1", [post]); }
});
