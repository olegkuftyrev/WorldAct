import { after, test } from "./isolated-test.js";
import "dotenv/config";
import assert from "node:assert/strict";
import { pool } from "../server/db.js";
import { renderSiteDocument } from "../server/block-renderer.js";
import { restDateToUTC, restLocalDate } from "../server/date.js";
import { settingSchema } from "../server/site-validation.js";
import {
  appendDateArchiveSQL, dateArchiveBoundsUTC, dateArchiveLocalSQL, dateArchivePath, dateArchiveSQLBounds,
  dateArchiveTitle, dateArchiveWeekSQL, parseDateArchivePath, parseDateArchiveQuery,
} from "../server/date-archives.js";

after(() => pool.end());

test("date archive syntax, calendar validation and source archive headings", () => {
  assert.equal(parseDateArchiveQuery({}), null);
  assert.deepEqual(parseDateArchiveQuery({ m: "20240229" }), { year: 2024, month: 2, day: 29 });
  assert.deepEqual(parseDateArchiveQuery({ year: "2026", monthnum: "11", day: "07" }), { year: 2026, month: 11, day: 7 });
  assert.deepEqual(parseDateArchiveQuery({ year: 2026, month: "11" }), { year: 2026, month: 11 });
  assert.deepEqual(parseDateArchiveQuery({ m: "2021", w: "0" }), { year: 2021, week: 0 });
  for (const query of [{ year: ["2026"] }, { year: "0000" }, { year: "10000" }, { m: "20230229" }, { m: "20260230" }, { m: "202613" }, { m: "20261" }, { monthnum: "11" }, { year: "2026", day: "1" }, { year: "2026", month: "11", monthnum: "12" }, { m: "202611", year: "2025" }, { m: "202611", w: "1" }, { year: "2026", w: "54" }])
    assert.throws(() => parseDateArchiveQuery(query), { status: 400 }, JSON.stringify(query));
  assert.deepEqual(parseDateArchivePath("/2024/02/29/"), { year: 2024, month: 2, day: 29 });
  for (const path of ["/2023/02/29/", "/2026/13/", "/0000/", "/2026/11/07/extra/", "/something/"]) assert.equal(parseDateArchivePath(path), null);
  assert.equal(dateArchivePath({ year: 2026 }), "/2026/");
  assert.equal(dateArchivePath({ year: 2026, month: 11, day: 7 }), "/2026/11/07/");
  assert.equal(dateArchivePath({ year: 2021, week: 0 }), "/?m=2021&w=0");
  assert.equal(dateArchiveTitle({ year: 2026 }), "Year: 2026");
  assert.equal(dateArchiveTitle({ year: 2026, month: 11 }), "Month: November 2026");
  assert.equal(dateArchiveTitle({ year: 2026, month: 11, day: 7 }), "Day: November 7, 2026");
  assert.equal(dateArchiveTitle({ year: 2026, month: 11 }, { showPrefix: false }), "November 2026");
});

test("archive bounds preserve civil days across DST, skipped days and fixed offsets", () => {
  assert.deepEqual(dateArchiveBoundsUTC({ year: 2026, month: 3, day: 8 }, "America/Los_Angeles"), { start: "2026-03-08T08:00:00.000Z", end: "2026-03-09T07:00:00.000Z" });
  assert.deepEqual(dateArchiveBoundsUTC({ year: 2026, month: 11, day: 1 }, "America/Los_Angeles"), { start: "2026-11-01T07:00:00.000Z", end: "2026-11-02T08:00:00.000Z" });
  assert.deepEqual(dateArchiveBoundsUTC({ year: 2026, month: 1 }, "+05:45"), { start: "2025-12-31T18:15:00.000Z", end: "2026-01-31T18:15:00.000Z" });
  const skipped = dateArchiveBoundsUTC({ year: 2011, month: 12, day: 30 }, "Pacific/Apia");
  assert.equal(skipped.start, skipped.end);
  assert.equal(dateArchiveBoundsUTC({ year: 1 }, "UTC").start, "0001-01-01T00:00:00.000Z");
  assert.equal(dateArchiveBoundsUTC({ year: 9999 }, "UTC").end, "+010000-01-01T00:00:00.000Z");
  for (const timezone of ["+03", "+0300", "+03:00"]) {
    assert.equal(settingSchema.parse({ timezone }).timezone, "+03:00");
    assert.equal(dateArchiveBoundsUTC({ year: 2026, month: 1, day: 1 }, timezone).start, "2025-12-31T21:00:00.000Z");
    assert.equal(restDateToUTC("2026-01-01T00:00:00", timezone), "2025-12-31T21:00:00.000Z");
    assert.equal(restLocalDate("2025-12-31T21:00:00Z", timezone), "2026-01-01T00:00:00");
  }
  assert.equal(settingSchema.parse({ timezone: "-0700" }).timezone, "-07:00");
});

test("PostgreSQL grouping and source week modes agree for named and fixed zones", async () => {
  for (const [timezone, expected] of [["America/Los_Angeles", "2025-12-31"], ["+05:45", "2026-01-01"], ["-05:30", "2025-12-31"], ["-07", "2025-12-31"], ["+0300", "2026-01-01"]]) {
    const args: unknown[] = ["2026-01-01T00:30:00Z"];
    const local = dateArchiveLocalSQL("$1::timestamptz", args, timezone);
    assert.equal((await pool.query(`SELECT to_char(${local},'YYYY-MM-DD') AS day`, args)).rows[0].day, expected);
  }
  const values = [["2021-01-01", 1, 0], ["2021-01-04", 1, 1], ["2024-12-31", 1, 53], ["2021-01-01", 0, 0], ["2021-01-03", 0, 1], ["2023-01-01", 0, 1], ["2021-01-01", 2, 52]] as const;
  for (const [date, start, expected] of values) {
    const sql = dateArchiveWeekSQL("$1::timestamp", start);
    assert.equal((await pool.query(`SELECT ${sql} AS week`, [date])).rows[0].week, expected, `${date}, start ${start}`);
  }
  const args: unknown[] = [], where: string[] = [];
  appendDateArchiveSQL(where, args, "published_at", { year: 2021, week: 0 }, "UTC", 1);
  const selected = (await pool.query(`SELECT id FROM (VALUES (1,'2021-01-01T12:00:00Z'::timestamptz),(2,'2021-01-04T12:00:00Z'),(3,'2020-12-31T12:00:00Z')) AS p(id,published_at) WHERE ${where.join(" AND ")}`, args)).rows;
  assert.deepEqual(selected, [{ id: 1 }]);
  for (const [year, timezone] of [[9999, "UTC"], [1, "+14:00"]] as const) {
    const boundsArgs: unknown[] = [], boundsWhere: string[] = [];
    appendDateArchiveSQL(boundsWhere, boundsArgs, "published_at", { year }, timezone);
    assert.equal((await pool.query(`SELECT count(*)::int AS count FROM (VALUES ('2026-01-01T00:00:00Z'::timestamptz)) AS p(published_at) WHERE ${boundsWhere.join(" AND ")}`, boundsArgs)).rows[0].count, 0);
    const sqlBounds = dateArchiveSQLBounds({ year }, timezone), utcBounds = dateArchiveBoundsUTC({ year }, timezone);
    assert.deepEqual((await pool.query("SELECT (extract(epoch from $1::timestamptz)*1000)::text AS start,(extract(epoch from $2::timestamptz)*1000)::text AS end", [sqlBounds.start, sqlBounds.end])).rows.map(row => [Number(row.start), Number(row.end)]), [[new Date(utcBounds.start).valueOf(), new Date(utcBounds.end).valueOf()]]);
  }
});

test("public date archives, inherited loops and titles use the site-local publication date", async () => {
  const base = process.env.TEST_API_URL || "http://127.0.0.1:3001", origin = process.env.APP_ORIGIN || "http://127.0.0.1:5173";
  const stamp = "dates-" + Date.now().toString(36), ids: number[] = [], mediaIds: number[] = [];
  const before = (await pool.query("SELECT data FROM settings WHERE id=1")).rows[0].data;
  let cookie = "";
  async function api(path: string, method = "GET", body?: unknown) {
    const response = await fetch(base + path, { method, headers: { Origin: origin, Cookie: cookie, "Content-Type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const data = await response.json(); return { response, data };
  }
  async function ok(path: string, method = "GET", body?: unknown) {
    const result = await api(path, method, body); assert.ok(result.response.ok, `${path}: ${result.response.status} ${JSON.stringify(result.data)}`); return result;
  }
  try {
    const signed = await ok("/api/auth/login", "POST", { login: process.env.ADMIN_EMAIL, password: process.env.ADMIN_PASSWORD });
    cookie = signed.response.headers.get("set-cookie")!.split(";")[0];
    await ok("/api/settings", "PUT", { timezone: "America/Los_Angeles", postsPerPage: 2, weekStartsOn: 1 });
    const fixtures = [
      { title: stamp + " end", publishedAt: "2026-01-01T07:59:59Z" },
      { title: stamp + " first", publishedAt: "2025-12-01T08:00:00Z", sticky: true },
      { title: stamp + " before", publishedAt: "2025-12-01T07:59:59Z" },
      { title: stamp + " after", publishedAt: "2026-01-01T08:00:00Z" },
      { title: stamp + " private", publishedAt: "2025-12-12T12:00:00Z", status: "private" },
      { title: stamp + " page", publishedAt: "2025-12-12T12:00:00Z", type: "page" },
      { title: stamp + " protected", publishedAt: "2025-12-15T12:00:00Z", password: "private-archive-test" },
    ];
    for (const fixture of fixtures) ids.push((await ok("/api/posts", "POST", { status: "publish", content: "<p>Archive body marker</p>", excerpt: "Archive excerpt marker", ...fixture })).data.post.id);
    const listing = (await ok(`/api/public/site?m=202512&search=${stamp}`)).data;
    assert.equal(listing.pagination.totalPosts, 3);
    assert.equal(listing.archive.name, "Month: December 2025");
    assert.equal(listing.archive.permalink, "/2025/12/");
    assert.deepEqual(listing.posts.map((post: any) => post.id), [ids[0], ids[6]]);
    assert.equal(listing.posts[1].locked, true); assert.equal(listing.posts[1].content, ""); assert.equal(listing.posts[1].excerpt, "");
    assert.deepEqual((await ok(`/api/public/site?year=2025&monthnum=12&search=${stamp}&page=2`)).data.posts.map((post: any) => post.id), [ids[1]]);
    assert.equal((await ok("/api/public/resolve?path=%2F2025%2F12%2F")).data.archive.month, 12);
    assert.equal((await api("/api/public/resolve?path=%2F0001%2F")).response.status, 404);
    for (const suffix of ["m=20250229", "year=2025&monthnum=13", "year=2025&day=2", "year[]=2025", "m=202512&monthnum=11"]) assert.equal((await api("/api/public/site?" + suffix)).response.status, 400, suffix);
    const document = { rawContent: '<!-- wp:query-title {"type":"archive"} /--><!-- wp:query {"query":{"inherit":true,"perPage":10}} --><!-- wp:post-template --><!-- wp:post-title /--><!-- /wp:post-template --><!-- /wp:query -->' };
    const html = await renderSiteDocument(document, { query: { year: "2025", monthnum: "12", search: stamp }, requestPath: "/2025/12/" });
    assert.match(html, new RegExp(stamp + " end")); assert.match(html, new RegExp(stamp + " first"));
    assert.doesNotMatch(html, new RegExp(stamp + " (before|after|private|page|protected)"));
    assert.match(await renderSiteDocument({ rawContent: '<!-- wp:query-title {"type":"archive"} /-->' }, { query: { m: "202512" } }), /Month: December 2025/);
    assert.match(await renderSiteDocument({ rawContent: '<!-- wp:query-title {"type":"archive","showPrefix":false} /-->' }, { query: { year: "2025", monthnum: "12", day: "31" } }), />December 31, 2025</);
    const authorId = (await pool.query("SELECT author_id FROM posts WHERE id=$1", [ids[0]])).rows[0].author_id;
    const media = (await pool.query("INSERT INTO media(author_id,title,filename,mime_type,size,created_at) VALUES($1,$2,$3,'image/png',1,'2026-01-01T00:30:00Z') RETURNING id", [authorId, stamp, stamp + ".png"])).rows[0];
    mediaIds.push(media.id);
    assert.equal((await ok("/api/settings", "PUT", { timezone: "-07" })).data.settings.timezone, "-07:00");
    assert.deepEqual((await ok(`/api/media?search=${stamp}&month=2025-12`)).data.media.map((item: any) => item.id), [media.id]);
    assert.equal((await ok(`/api/media?search=${stamp}&month=2026-01`)).data.media.length, 0);
    assert.equal((await ok("/api/settings", "PUT", { timezone: "+0300" })).data.settings.timezone, "+03:00");
    assert.deepEqual((await ok(`/api/media?search=${stamp}&month=2026-01`)).data.media.map((item: any) => item.id), [media.id]);
    assert.equal((await ok(`/api/media?search=${stamp}&month=2025-12`)).data.media.length, 0);
    await pool.query("UPDATE settings SET data=jsonb_set(data,'{timezone}',to_jsonb($1::text)) WHERE id=1", ["-0700"]);
    assert.equal((await ok("/api/settings")).data.settings.timezone, "-07:00");
    assert.equal((await ok("/api/public/site?year=9999")).data.pagination.totalPosts, 0);
    await ok("/api/settings", "PUT", { timezone: "+14:00" });
    assert.equal((await ok("/api/public/site?year=0001")).data.pagination.totalPosts, 0);
  } finally {
    await pool.query("DELETE FROM media WHERE id=ANY($1::int[])", [mediaIds]);
    await pool.query("DELETE FROM posts WHERE id=ANY($1::int[])", [ids]);
    await pool.query("UPDATE settings SET data=$1::jsonb WHERE id=1", [JSON.stringify(before)]);
    if (cookie) await api("/api/auth/logout", "POST", {});
  }
});
