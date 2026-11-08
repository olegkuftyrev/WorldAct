import test, { after } from "./isolated-test.js";
import assert from "node:assert/strict";
import { XMLParser } from "fast-xml-parser";
import { pool } from "../server/db.js";

const base = process.env.TEST_API_URL!, origin = process.env.APP_ORIGIN!;
after(() => pool.end());

test("admin Date order, month membership and available months share publication/schedule dates in the site timezone", async t => {
  const original = (await pool.query("SELECT data FROM settings WHERE id=1")).rows[0].data;
  const ids: number[] = [], users: number[] = [], stamp = "list-dates-" + Date.now();
  let admin = "", author = "";
  async function request(route: string, method = "GET", body?: unknown, cookie = admin) {
    const response = await fetch(base + "/api" + route, {method, headers: {Origin: origin, Cookie: cookie, "Content-Type": "application/json"}, body: body === undefined ? undefined : JSON.stringify(body)});
    return {response, data: await response.json()};
  }
  async function ok(route: string, method = "GET", body?: unknown, cookie = admin) {
    const result = await request(route, method, body, cookie);
    assert.ok(result.response.ok, `${route}: ${result.response.status} ${JSON.stringify(result.data)}`);
    return result.data;
  }
  async function post(label: string, input: Record<string, unknown> = {}) {
    const record = (await ok("/posts", "POST", {title: stamp + " " + label, status: "publish", content: "<p>Unchanged date fixture body.</p>", ...input})).post;
    ids.push(record.id); return record;
  }
  async function list(values: Record<string, string> = {}, cookie = admin) {
    return ok("/posts?" + new URLSearchParams({search: stamp, orderby: "date", order: "asc", page: "1", perPage: "100", ...values}), "GET", undefined, cookie);
  }
  const selected = (data: {posts: {id: number}[]}) => data.posts.map(post => post.id);
  try {
    const signed = await request("/auth/login", "POST", {login: process.env.ADMIN_EMAIL, password: process.env.ADMIN_PASSWORD}, "");
    assert.equal(signed.response.status, 200); admin = signed.response.headers.get("set-cookie")!.split(";")[0];
    await ok("/settings", "PUT", {timezone: "America/Los_Angeles", pingServices: []});
    const later = await post("later", {publishedAt: "2024-03-01T08:30:00Z"});
    const earlier = await post("earlier", {publishedAt: "2024-03-01T07:30:00Z"});
    const page = await post("page", {type: "page", publishedAt: "2024-03-01T07:45:00Z"});
    const futureLater = await post("future later", {status: "future", scheduledAt: "2100-06-01T08:30:00Z"});
    const futureEarlier = await post("future earlier", {status: "future", scheduledAt: "2100-06-01T06:30:00Z"});
    const rescheduled = await post("rescheduled", {publishedAt: "2020-01-15T12:00:00Z"});
    await ok(`/posts/${rescheduled.id}`, "PUT", {status: "future", scheduledAt: "2100-07-01T06:30:00Z"});
    const draft = await post("draft", {status: "draft"});
    await pool.query("UPDATE posts SET created_at='2023-02-01T07:30:00Z',updated_at='2025-01-01T00:00:00Z' WHERE id=$1", [draft.id]);
    const trash = await post("trash", {publishedAt: "1891-02-01T07:30:00Z"});
    await ok(`/posts/${trash.id}`, "PUT", {status: "trash"});

    await t.test("backdated publications and pages use their visible publication month rather than creation month", async () => {
      assert.deepEqual(selected(await list({status: "publish"})), [earlier.id, later.id]);
      assert.deepEqual(selected(await list({status: "publish", order: "desc"})), [later.id, earlier.id]);
      const february = await list({month: "2024-02"});
      assert.deepEqual(selected(february), [earlier.id]);
      assert.equal(february.posts[0].postDate, earlier.publishedAt);
      assert.equal(february.timezone, "America/Los_Angeles");
      assert.equal(february.pagination.totalPosts, 1); assert.equal(february.counts.publish, 1);
      assert.deepEqual(selected(await list({month: "2024-03"})), [later.id]);
      assert.deepEqual(selected(await list({type: "page", month: "2024-02"})), [page.id]);
    });
    await t.test("scheduled and previously published rescheduled records use the current schedule", async () => {
      assert.deepEqual(selected(await list({status: "future"})), [futureEarlier.id, futureLater.id, rescheduled.id]);
      assert.equal((await list({status: "future"})).posts.find((record: {id: number}) => record.id === rescheduled.id).postDate, "2100-07-01T06:30:00.000Z");
      assert.deepEqual(selected(await list({status: "future", month: "2100-05"})), [futureEarlier.id]);
      assert.deepEqual(selected(await list({status: "future", month: "2100-06"})), [futureLater.id, rescheduled.id]);
      assert.equal((await list({status: "future", month: "2020-01"})).pagination.totalPosts, 0);
      assert.deepEqual(selected(await list({status: "draft", month: "2023-01"})), [draft.id]);
      assert.equal((await list({status: "draft", month: "2023-01"})).posts[0].postDate, "2023-02-01T07:30:00.000Z");
    });
    await t.test("Modified ordering remains independent of the chosen post date", async () => {
      await pool.query("UPDATE posts SET updated_at=CASE id WHEN $1 THEN '2025-02-01'::timestamptz ELSE '2025-01-01'::timestamptz END WHERE id=ANY($2::int[])", [earlier.id, [earlier.id, later.id]]);
      assert.deepEqual(selected(await list({status: "publish", orderby: "modified"})), [later.id, earlier.id]);
      assert.deepEqual(selected(await list({status: "publish", orderby: "date"})), [earlier.id, later.id]);
      assert.deepEqual(selected(await list({status: "publish", orderby: "modified", order: "desc"})), [earlier.id, later.id]);
    });
    await t.test("month choices are independent of selected filters and respect the Trash view", async () => {
      const active = await list({month: "2024-02", search: "absent-" + stamp});
      assert.equal(active.posts.length, 0);
      for (const month of ["2023-01", "2024-02", "2024-03", "2100-05", "2100-06"]) assert.ok(active.months.includes(month), month);
      assert.equal(active.months.includes("1891-01"), false);
      assert.deepEqual((await list({status: "trash"})).months, ["1891-01"]);
      assert.deepEqual((await list({type: "page"})).months, [...new Set((await list({type: "page"})).months)].sort().reverse());
      assert.ok((await list({type: "page"})).months.includes("2024-02"));
      const exported = await ok("/tools/export/options");
      assert.ok(exported.months.posts.includes("2100-06"));
      assert.equal(exported.months.posts.includes("2020-01"), false, "export choices cannot use the stale publication before the new schedule");
    });
    await t.test("offered rescheduled months export and import the actual current schedule", async () => {
      const parse = new XMLParser({ parseTagValue: false, isArray: name => name === "item" });
      async function exported(month: string) {
        const response = await fetch(base + "/api/tools/export?" + new URLSearchParams({ format: "wxr", content: "posts", status: "future", startDate: month, endDate: month }), { headers: { Cookie: admin } });
        const xml = await response.text(); assert.equal(response.status, 200, xml);
        const items: any[] = parse.parse(xml).rss.channel.item || [];
        return { xml, items };
      }
      const chosen = await exported("2100-06");
      const item = chosen.items.find(item => Number(item["wp:post_id"]) === rescheduled.id);
      assert.ok(item, "the month offered for a rescheduled publication must export its record");
      assert.equal(item["wp:status"], "future");
      assert.equal(item["wp:post_date"], "2100-06-30 23:30:00");
      assert.equal(item["wp:post_date_gmt"], "2100-07-01 06:30:00");
      assert.equal(item.pubDate, new Date("2100-07-01T06:30:00Z").toUTCString());
      assert.equal((await exported("2020-01")).items.some(item => Number(item["wp:post_id"]) === rescheduled.id), false);
      const imported = await ok("/tools/import", "POST", { format: "wxr", xml: chosen.xml });
      ids.push(...imported.postIds);
      try {
        const copied = (await pool.query("SELECT status,scheduled_at,published_at FROM posts WHERE id=ANY($1::int[]) AND title=$2", [imported.postIds, stamp + " rescheduled"])).rows[0];
        assert.equal(copied.status, "future");
        assert.equal(copied.scheduled_at.toISOString(), "2100-07-01T06:30:00.000Z");
        assert.equal(copied.published_at, null);
      } finally { await pool.query("DELETE FROM posts WHERE id=ANY($1::int[])", [imported.postIds]); }
      await ok("/settings", "PUT", { timezone: "+05:45" });
      try {
        const choices = await ok("/tools/export/options");
        assert.ok(choices.months.posts.includes("2100-07"));
        const shifted = (await exported("2100-07")).items.find(item => Number(item["wp:post_id"]) === rescheduled.id);
        assert.ok(shifted);
        assert.equal(shifted["wp:post_date"], "2100-07-01 12:15:00");
        assert.equal(shifted["wp:post_date_gmt"], "2100-07-01 06:30:00");
        assert.equal((await exported("2100-06")).items.some(item => Number(item["wp:post_id"]) === rescheduled.id), false);
      } finally { await ok("/settings", "PUT", { timezone: "America/Los_Angeles" }); }
    });
    await t.test("supported fixed-offset timezones move month membership and choices together", async () => {
      await ok("/settings", "PUT", {timezone: "+05:45"});
      assert.deepEqual(selected(await list({status: "publish", month: "2024-03"})), [earlier.id, later.id]);
      assert.equal((await list()).timezone, "+05:45");
      assert.equal((await list({status: "publish", month: "2024-02"})).pagination.totalPosts, 0);
      assert.deepEqual(selected(await list({status: "future", month: "2100-07"})), [rescheduled.id]);
      assert.ok((await list()).months.includes("2100-07"));
      await ok("/settings", "PUT", {timezone: "America/Los_Angeles"});
    });
    await t.test("author month metadata and filtered counts cannot reveal another author's months", async () => {
      const password = "Date-fixture-password-" + stamp;
      const person = (await ok("/users", "POST", {username: stamp, email: stamp + "@example.test", displayName: "Date author", role: "author", password})).user;
      users.push(person.id);
      const signed = await request("/auth/login", "POST", {login: person.username, password}, "");
      assert.equal(signed.response.status, 200); author = signed.response.headers.get("set-cookie")!.split(";")[0];
      const owned = await post("owned private", {authorId: person.id, status: "private", publishedAt: "1889-05-15T12:00:00Z"});
      const scoped = await list({month: "1889-05", author: String(person.id)}, author);
      assert.deepEqual(selected(scoped), [owned.id]); assert.deepEqual(scoped.months, ["1889-05"]);
      assert.equal(scoped.counts.private, 1); assert.equal(scoped.pagination.totalPosts, 1);
      assert.equal((await request("/posts?type=page", "GET", undefined, author)).response.status, 403);
      assert.equal((await request("/posts", "GET", undefined, "")).response.status, 401);
    });
  } finally {
    await pool.query("DELETE FROM posts WHERE id=ANY($1::int[])", [ids]);
    await pool.query("DELETE FROM users WHERE id=ANY($1::int[])", [users]);
    await pool.query("UPDATE settings SET data=$1::jsonb WHERE id=1", [JSON.stringify(original)]);
  }
});
