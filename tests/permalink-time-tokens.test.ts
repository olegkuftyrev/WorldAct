import test, { after } from "./isolated-test.js";
import assert from "node:assert/strict";
import { XMLParser } from "fast-xml-parser";
import { getSettings, pool } from "../server/db.js";
import { postPermalink, resolvePublicPath } from "../server/permalinks.js";
import { publishDuePosts } from "../server/core.js";

const base = process.env.TEST_API_URL!, origin = process.env.APP_ORIGIN!;
after(() => pool.end());

test("saved custom time tags share chosen site-clock dates without weakening public identity or body fences", async t => {
  const initial = (await pool.query("SELECT data FROM settings WHERE id=1")).rows[0].data;
  const ids: number[] = [], terms: number[] = [], stamp = "permalink-time-" + Date.now();
  let cookie = "";
  async function request(path: string, method = "GET", body?: unknown, auth = cookie) {
    const response = await fetch(base + path, { method, headers: { Origin: origin, "Content-Type": "application/json", ...(auth ? { Cookie: auth } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { response, data: await response.json() };
  }
  async function ok(path: string, method = "GET", body?: unknown, auth = cookie) {
    const result = await request(path, method, body, auth);
    assert.ok(result.response.ok, `${path}: ${result.response.status} ${JSON.stringify(result.data)}`);
    return result;
  }
  const settings = (input: Record<string, unknown>) => ok("/api/settings", "PUT", input);
  const resolve = (path: string, auth = "") => request("/api/public/resolve?" + new URLSearchParams({ path }), "GET", undefined, auth);
  async function post(input: Record<string, unknown> = {}) {
    const record = (await ok("/api/posts", "POST", { title: stamp + "-" + ids.length, status: "publish", publishedAt: "2024-01-02T03:04:05Z", content: "<p>TIME-FIRST</p><!--nextpage--><p>TIME-SECOND</p>", ...input })).data.post;
    ids.push(record.id); return record;
  }
  const full = "/%year%/%monthnum%/%day%/%hour%/%minute%/%second%/%postname%/";
  try {
    const signed = await ok("/api/auth/login", "POST", { login: process.env.ADMIN_EMAIL, password: process.env.ADMIN_PASSWORD }, "");
    cookie = signed.response.headers.get("set-cookie")!.split(";")[0];
    await settings({ timezone: "UTC", pingServices: [], frontPageMode: "posts", frontPageId: null, postsPageId: null });
    const story = await post();

    await t.test("each newly supported tag saves and resolves with a name or numeric identity", async () => {
      for (const [tag, expected] of [["hour", "03"], ["minute", "04"], ["second", "05"]]) {
        for (const identity of ["postname", "post_id"]) {
          const structure = `/clock/%${tag}%/%${identity}%/`;
          await settings({ permalinkStructure: structure });
          assert.equal((await getSettings()).permalinkStructure, structure);
          const canonical = `/clock/${expected}/${identity === "postname" ? story.slug : story.id}/`;
          assert.equal((await ok("/api/posts/" + story.id)).data.post.permalink, canonical);
          assert.equal((await resolve(canonical)).data.post.id, story.id);
          assert.equal((await resolvePublicPath(canonical))?.id, story.id);
        }
      }
    });

    await t.test("the full timestamp alone, unknown and repeated tags, and reserved paths remain rejected", async () => {
      for (const structure of ["/%year%/%monthnum%/%day%/%hour%/%minute%/%second%/", "/%hour%/", "/%postname%/%hour%/%hour%/", "/prefix-%author%/%postname%/", "/%milliseconds%/%post_id%/", "/api/%hour%/%post_id%/"]) {
        const before = (await getSettings()).permalinkStructure;
        assert.equal((await request("/api/settings", "PUT", { permalinkStructure: structure })).response.status, 400, structure);
        assert.equal((await getSettings()).permalinkStructure, before);
      }
    });

    for (const [label, timezone, instant, civil] of [
      ["midnight zero fields", "UTC", "2024-01-02T00:00:00Z", "2024/01/02/00/00/00"],
      ["last second", "UTC", "2024-12-31T23:59:59Z", "2024/12/31/23/59/59"],
      ["positive fractional offset and next-day rollover", "+05:45", "2024-12-31T18:15:07Z", "2025/01/01/00/00/07"],
      ["negative fractional offset and previous-day rollover", "-03:30", "2025-01-01T03:29:59Z", "2024/12/31/23/59/59"],
      ["first repeated DST hour", "America/Los_Angeles", "2024-11-03T08:09:05Z", "2024/11/03/01/09/05"],
      ["second repeated DST hour", "America/Los_Angeles", "2024-11-03T09:09:05Z", "2024/11/03/01/09/05"],
    ]) {
      await t.test(label, async () => {
        await settings({ timezone, permalinkStructure: full });
        const record = await post({ publishedAt: instant });
        const canonical = `/${civil}/${record.slug}/`;
        assert.equal(record.permalink, canonical);
        assert.equal((await ok("/api/posts/" + record.id)).data.post.permalink, canonical);
        const result = await resolve(canonical);
        assert.equal(result.response.status, 200); assert.equal(result.data.post.id, record.id);
        assert.match(result.data.post.content, /TIME-FIRST/); assert.doesNotMatch(result.data.post.content, /TIME-SECOND/);
        const bodySecond = await resolve(canonical + "2/?query-4-page=3&commentPage=4");
        assert.equal(bodySecond.response.status, 200); assert.equal(bodySecond.data.contentPage, 2);
        assert.match(bodySecond.data.post.content, /TIME-SECOND/); assert.doesNotMatch(bodySecond.data.post.content, /TIME-FIRST/);
        assert.equal(bodySecond.data.post.contentPagination.links[1].url, canonical + "2/");
      });
    }

    await t.test("wrong time fields and conflicting names cannot select a different body", async () => {
      await settings({ timezone: "UTC", permalinkStructure: full });
      const canonical = await postPermalink(story);
      for (const bad of [canonical.replace("/03/", "/02/"), canonical.replace("/04/", "/06/"), canonical.replace("/05/", "/07/"), canonical.replace("/03/", "/3/"), canonical.replace("/04/", "/004/"), canonical.replace("/05/", "/60/")]) {
        assert.equal(await resolvePublicPath(bad), null, bad);
        const result = await resolve(bad); assert.equal(result.response.status, 404, bad); assert.doesNotMatch(JSON.stringify(result.data), /TIME-FIRST|TIME-SECOND/);
      }
      await settings({ permalinkStructure: "/%hour%/%minute%/%second%/%post_id%/%postname%/" });
      const another = await post({ content: "<p>TIME-WRONG-IDENTITY-BODY</p>" });
      const mismatch = (await postPermalink(story)).replace(story.slug, another.slug);
      const result = await resolve(mismatch); assert.equal(result.response.status, 404); assert.doesNotMatch(JSON.stringify(result.data), /TIME-WRONG-IDENTITY-BODY/);
      for (const id of ["0", "000" + story.id, "2147483648", "99999999999999999999"]) assert.equal((await resolve(`/03/04/05/${id}/${story.slug}/`)).response.status, 404);
    });

    await t.test("category hierarchy, name and ID share caller-transaction generation and exact resolution", async () => {
      const parent = (await ok("/api/terms", "POST", { taxonomy: "category", name: stamp + " parent", slug: stamp + "-parent" })).data.term; terms.push(parent.id);
      const child = (await ok("/api/terms", "POST", { taxonomy: "category", name: stamp + " child", slug: stamp + "-child", parentId: parent.id })).data.term; terms.push(child.id);
      await settings({ permalinkStructure: "/%category%/%year%/%monthnum%/%day%/%hour%/%minute%/%second%/%post_id%/%postname%/" });
      const record = await post({ categoryIds: [child.id] });
      const canonical = `/${parent.slug}/${child.slug}/2024/01/02/03/04/05/${record.id}/${record.slug}/`;
      assert.equal(record.permalink, canonical); assert.equal((await resolve(canonical)).data.post.id, record.id);
      assert.equal((await resolve(canonical.replace(parent.slug, "wrong-category"))).response.status, 404);
      const client = await pool.connect();
      try {
        await client.query("BEGIN"); await client.query("UPDATE terms SET slug=$1 WHERE id=$2", [stamp + "-uncommitted", parent.id]);
        assert.equal(await postPermalink(record, await getSettings(client), client), canonical.replace(parent.slug, stamp + "-uncommitted"));
        assert.equal(await postPermalink(record), canonical);
      } finally { await client.query("ROLLBACK"); client.release(); }
    });

    await t.test("private, draft, pending, future and wrong-type IDs stay fenced while protected bodies require a grant", async () => {
      await settings({ permalinkStructure: full });
      for (const status of ["private", "draft", "pending", "future"]) {
        const hidden = await post({ status, ...(status === "future" ? { scheduledAt: "2100-01-02T03:04:05Z" } : {}) });
        const result = await resolve(await postPermalink(hidden)); assert.equal(result.response.status, 404, status); assert.doesNotMatch(JSON.stringify(result.data), /TIME-FIRST|TIME-SECOND/);
      }
      const protectedPost = await post({ password: "Time-password-123", content: "<p>TIME-PROTECTED-FIRST</p><!--nextpage--><p>TIME-PROTECTED-SECOND</p>" });
      const locked = await resolve(protectedPost.permalink); assert.equal(locked.response.status, 200); assert.equal(locked.data.post.locked, true);
      const hash = (await pool.query("SELECT password_hash FROM posts WHERE id=$1", [protectedPost.id])).rows[0].password_hash;
      assert.ok(hash); assert.ok(!JSON.stringify(locked.data).includes(hash)); assert.doesNotMatch(JSON.stringify(locked.data), /TIME-PROTECTED|Time-password|password_hash/);
      const unlocked = await ok("/api/public/posts/" + protectedPost.slug + "/unlock?page=2", "POST", { password: "Time-password-123" }, "");
      const grant = unlocked.response.headers.get("set-cookie")!.split(";")[0];
      const second = await resolve(protectedPost.permalink + "2/", grant); assert.match(second.data.post.content, /TIME-PROTECTED-SECOND/); assert.doesNotMatch(second.data.post.content, /TIME-PROTECTED-FIRST/);
      const page = await post({ type: "page" });
      await settings({ permalinkStructure: "/%hour%/%minute%/%second%/%post_id%/" });
      assert.equal((await resolve(`/03/04/05/${page.id}/`)).response.status, 404);
      assert.equal((await resolve("/?p=" + page.id)).response.status, 404);
      assert.equal((await resolve("/?page_id=" + story.id)).response.status, 404);
    });

    await t.test("hierarchical numeric child pages win before body suffixes and Plain identities remain available", async () => {
      const parent = await post({ type: "page" }), child = await post({ type: "page", parentId: parent.id, slug: "2", content: "<p>TIME-EXACT-CHILD</p>" });
      const exact = await resolve(`/${parent.slug}/2/`); assert.equal(exact.response.status, 200); assert.equal(exact.data.post.id, child.id); assert.match(exact.data.post.content, /TIME-EXACT-CHILD/);
      const second = await resolve(`/${parent.slug}/2/2/`); assert.equal(second.data.post.id, child.id);
      const plain = await resolve(`/?p=${story.id}&page=2`); assert.equal(plain.response.status, 200); assert.match(plain.data.post.content, /TIME-SECOND/);
      assert.equal((await resolve(`/?p=${story.id}&p=${child.id}`)).response.status, 404);
    });

    await t.test("editing a chosen date and publishing a saved schedule preserve nonzero seconds", async () => {
      await settings({ timezone: "+05:45", permalinkStructure: full });
      const old = await postPermalink(story);
      const edited = (await ok("/api/posts/" + story.id, "PUT", { publishedAt: "2024-12-31T18:15:39Z" })).data.post;
      assert.equal(edited.permalink, `/2025/01/01/00/00/39/${story.slug}/`); assert.equal((await resolve(old)).response.status, 404); assert.equal((await resolve(edited.permalink)).data.post.id, story.id);
      const scheduled = await post({ status: "future", publishedAt: null, scheduledAt: "2100-01-01T00:00:37Z" });
      assert.deepEqual(await publishDuePosts(new Date("2100-01-01T00:01:00Z"), [scheduled.id]), [scheduled.id]);
      const published = (await ok("/api/posts/" + scheduled.id)).data.post;
      assert.equal(published.publishedAt, "2100-01-01T00:00:37.000Z"); assert.equal(published.permalink, `/2100/01/01/05/45/37/${scheduled.slug}/`);
      assert.equal((await resolve(published.permalink)).data.post.id, scheduled.id);
    });

    await t.test("WXR exports and imports saved second precision using the same local/GMT pair", async () => {
      const response = await fetch(base + "/api/tools/export?" + new URLSearchParams({ format: "wxr", content: "posts", status: "publish", startDate: "2025-01", endDate: "2025-01" }), { headers: { Cookie: cookie } });
      assert.equal(response.status, 200); const xml = await response.text();
      const parsed = new XMLParser({ parseTagValue: false, isArray: name => name === "item" }).parse(xml);
      const item = parsed.rss.channel.item.find((entry: any) => Number(entry["wp:post_id"]) === story.id);
      assert.ok(item); assert.equal(item["wp:post_date"], "2025-01-01 00:00:39"); assert.equal(item["wp:post_date_gmt"], "2024-12-31 18:15:39");
      const imported = (await ok("/api/tools/import", "POST", { format: "wxr", xml })).data; ids.push(...imported.postIds);
      const copy = (await pool.query("SELECT id,type,slug,published_at AS \"publishedAt\",created_at AS \"createdAt\" FROM posts WHERE id=ANY($1::int[]) AND title=$2", [imported.postIds, story.title])).rows[0];
      assert.ok(copy); assert.equal(copy.publishedAt.toISOString(), "2024-12-31T18:15:39.000Z");
      const canonical = `/2025/01/01/00/00/39/${copy.slug}/`; assert.equal(await postPermalink(copy), canonical); assert.equal((await resolve(canonical)).data.post.id, copy.id);
    });
  } finally {
    await pool.query("DELETE FROM posts WHERE id=ANY($1::int[])", [ids]);
    await pool.query("DELETE FROM terms WHERE id=ANY($1::int[])", [terms]);
    await pool.query("UPDATE settings SET data=$1::jsonb WHERE id=1", [JSON.stringify(initial)]);
  }
});
