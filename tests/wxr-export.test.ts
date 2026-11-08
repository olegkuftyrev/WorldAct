import test, { after } from "./isolated-test.js";
import assert from "node:assert/strict";
import sharp from "sharp";
import { XMLParser } from "fast-xml-parser";
import { pool } from "../server/db.js";
import { readWxrExportFilters, wxrExportWhere, wxrEntityReferences } from "../server/wxr-export.js";

after(async () => { await pool.end(); });
const block = (name: string, attrs: Record<string, unknown>) => `<!-- wp:${name} ${JSON.stringify(attrs)} /-->`;
test("WXR filters accept fixed typed values and parameterize local month boundaries", () => {
  const input = readWxrExportFilters({ format: "wxr", content: "posts", author: "7", category: "9", startDate: "2025-01", endDate: "2025-02", status: "private" });
  const query = wxrExportWhere(input, "+05:30");
  assert.deepEqual(query.args, ["post", 7, "private", 9, "+05:30", "2025-01-01", "2025-02-01"]);
  assert.match(query.sql, /timezone\(\$5::interval/); assert.match(query.sql, /interval '1 month'/);
  assert.equal(readWxrExportFilters({ format: "wxr", startDate: "0001-01", endDate: "0999-12" }).startDate, "0001-01");
  for (const extra of [{ author: "1 OR true" }, { author: ["1", "2"] }, { author: ["1"] }, { category: ["1"] }, { author: true }, { category: -1 }, { startDate: "0000-01" }, { startDate: "2025-13" }, { endDate: "2025-00" }, { startDate: "2025-02", endDate: "2025-01" }, { status: "inherit" }, { content: "users" }, { executable: "anything" }])
    assert.throws(() => readWxrExportFilters({ format: "wxr", ...extra }));
  assert.deepEqual(wxrExportWhere(readWxrExportFilters({ format: "wxr", author: "7" }), "UTC"), { sql: "TRUE", args: [] }, "All content retains the full-site selection");
});

test("entity dependencies inspect fixed block names and bound tree traversal", () => {
  const refs = wxrEntityReferences([{ rawContent: block("block", { ref: 8 }) + block("navigation", { ref: 9 }) + block("image", { ref: 10 }) + block("block", { ref: "11" }) }]);
  assert.deepEqual([...refs].map(([id, kinds]) => [id, [...kinds]]).sort(), [[8, ["reusable"]], [9, ["navigation"]]]);
  assert.throws(() => wxrEntityReferences([{ blocks: [{ name: "core/group", innerBlocks: Array.from({ length: 25001 }, () => ({})) }] }]), /too large/);
});

test("actual WXR exports select posts/pages/media with related data and preserve full JSON archives", { timeout: 45000 }, async t => {
  const base = process.env.TEST_API_URL!, origin = process.env.APP_ORIGIN!, stamp = "wxr-filter-" + Date.now().toString(36);
  let cookie = ""; const postIds: number[] = [], mediaIds: number[] = [], entityIds: number[] = [], termIds: number[] = [], userIds: number[] = [];
  const originalSettings = (await pool.query("SELECT data FROM settings WHERE id=1")).rows[0].data;
  async function api(path: string, method = "GET", body?: unknown, auth = cookie) {
    const response = await fetch(base + path, { method, signal: AbortSignal.timeout(12000), headers: { Origin: origin, "Content-Type": "application/json", ...(auth ? { Cookie: auth } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { response, data: await response.json() };
  }
  async function exported(query: string) {
    const response = await fetch(base + "/api/tools/export?format=wxr" + query, { headers: { Cookie: cookie }, signal: AbortSignal.timeout(12000) });
    const xml = await response.text(); assert.equal(response.status, 200, xml); assert.match(response.headers.get("content-disposition") || "", /worldact-export.xml/);
    const parsed = new XMLParser({ ignoreAttributes: false, parseTagValue: false, isArray: name => ["item", "wp:category", "wp:tag", "wp:author", "wp:comment"].includes(name) }).parse(xml).rss.channel;
    return { xml, channel: parsed, items: (parsed.item || []) as any[] };
  }
  try {
    const login = await api("/api/auth/login", "POST", { login: process.env.ADMIN_EMAIL, password: process.env.ADMIN_PASSWORD }); assert.equal(login.response.status, 200); cookie = login.response.headers.get("set-cookie")!.split(";")[0]; const adminId = login.data.user.id;
    await pool.query("UPDATE settings SET data=jsonb_set(data,'{timezone}','\"America/Los_Angeles\"') WHERE id=1");
    const other = (await pool.query("INSERT INTO users(username,email,password_hash,display_name,role) VALUES($1,$2,'unusable',$1,'author') RETURNING id", [stamp, stamp + "@example.test"])).rows[0].id; userIds.push(other);
    async function entity(kind: "reusable" | "navigation", suffix: string, raw: string) {
      const id = (await pool.query("INSERT INTO block_entities(kind,slug,title,raw_content,content,author_id,status) VALUES($1,$2,$2,$3,$3,$4,'publish') RETURNING id", [kind, stamp + suffix, raw, adminId])).rows[0].id; entityIds.push(id); return id;
    }
    const child = await entity("reusable", "-child", "<p>Nested selected pattern</p>"), outer = await entity("reusable", "-outer", block("block", { ref: child })), navigation = await entity("navigation", "-nav", "<p>Selected navigation</p>");
    await entity("reusable", "-unrelated", "<p>Unrelated pattern</p>");
    async function post(suffix: string, type: string, status: string, author: number, date: string, raw = "<p>Filtered content</p>") {
      const id = (await pool.query("INSERT INTO posts(type,title,slug,content,raw_content,status,author_id,published_at,created_at) VALUES($1,$2,$2,$3,$3,$4,$5,$6,$6) RETURNING id", [type, stamp + suffix, raw, status, author, date])).rows[0].id; postIds.push(id); return id;
    }
    const selected = await post("-selected", "post", "publish", adminId, "2025-02-01T07:59:59Z", block("navigation", { ref: child }) + block("block", { ref: outer }) + block("navigation", { ref: navigation }));
    const boundary = await post("-boundary", "post", "publish", adminId, "2025-02-01T08:00:00Z");
    const draft = await post("-draft", "post", "draft", adminId, "2025-01-15T12:00:00Z"), foreign = await post("-foreign", "post", "publish", other, "2025-01-16T12:00:00Z"), page = await post("-page", "page", "private", adminId, "2025-01-17T12:00:00Z");
    const parent = (await pool.query("INSERT INTO terms(taxonomy,name,slug) VALUES('category',$1,$1) RETURNING id", [stamp + "-parent"])).rows[0].id; termIds.push(parent);
    const category = (await pool.query("INSERT INTO terms(taxonomy,name,slug,parent_id) VALUES('category',$1,$1,$2) RETURNING id", [stamp + "-child", parent])).rows[0].id; termIds.push(category);
    for (const id of [selected, draft, foreign]) await pool.query("INSERT INTO post_terms(post_id,term_id) VALUES($1,$2)", [id, category]);
    await pool.query("INSERT INTO comments(post_id,author_name,author_email,content,status) VALUES($1,$2,'private@example.test','Selected comment','approved'),($3,'Unrelated','unrelated@example.test','Unrelated comment','approved')", [selected, stamp, boundary]);
    async function upload(suffix: string, date: string) {
      const bytes = await sharp({ create: { width: 8, height: 6, channels: 3, background: "#447799" } }).png().toBuffer(), form = new FormData(); form.append("file", new Blob([new Uint8Array(bytes)]), stamp + suffix + ".png");
      const response = await fetch(base + "/api/media", { method: "POST", headers: { Origin: origin, Cookie: cookie }, body: form }); assert.equal(response.status, 201); const media = (await response.json()).media; mediaIds.push(media.id); await pool.query("UPDATE media SET created_at=$1 WHERE id=$2", [date, media.id]); return media;
    }
    const attached = await upload("-attached", "2025-03-01T12:00:00Z"), featured = await upload("-featured", "2025-01-15T12:00:00Z"), unrelatedMedia = await upload("-unrelated", "2025-02-01T08:00:00Z");
    await pool.query("UPDATE media SET attached_post_id=$1 WHERE id=$2", [selected, attached.id]); await pool.query("UPDATE posts SET featured_media_id=$1 WHERE id=$2", [featured.id, selected]);
    await t.test("combined filters select the local inclusive start/exclusive following-month boundary and only required dependencies", async () => {
      const result = await exported(`&content=posts&category=${category}&author=${adminId}&startDate=2025-01&endDate=2025-01&status=publish`);
      assert.deepEqual(result.items.filter(row => row["wp:post_type"] === "post").map(row => Number(row["wp:post_id"])), [selected]);
      assert.equal(result.items.filter(row => row["wp:post_type"] === "wp_block").length, 2, "A later correct-kind reference resolves an earlier mismatched request");
      assert.equal(result.items.filter(row => row["wp:post_type"] === "wp_navigation").length, 1);
      assert.ok(!result.xml.includes(stamp + "-unrelated")); assert.ok(!result.xml.includes("Unrelated comment")); assert.ok(result.xml.includes("Selected comment"));
      assert.deepEqual(result.items.filter(row => row["wp:post_type"] === "attachment").map(row => Number(row["wp:post_id"]) - 2147483648).sort((a, b) => a - b), [attached.id, featured.id].sort((a, b) => a - b));
      assert.deepEqual((result.channel["wp:category"] || []).map((row: any) => Number(row["wp:term_id"])).sort((a: number, b: number) => a - b), [parent, category]);
      const imported = await api("/api/tools/import", "POST", { format: "wxr", xml: result.xml }); assert.equal(imported.response.status, 201, JSON.stringify(imported.data)); postIds.push(...imported.data.postIds); entityIds.push(...imported.data.blockEntityIds); assert.equal(imported.data.postIds.length, 1); assert.equal(imported.data.blockEntityIds.length, 3); assert.equal(imported.data.skippedAttachments, 2);
      const copied = (await pool.query("SELECT raw_content FROM posts WHERE id=$1", [imported.data.postIds[0]])).rows[0].raw_content;
      assert.ok(imported.data.blockEntityIds.some((id: number) => copied.includes(`\"ref\":${id}`)));
      // The import is verified; remove this copy before later selection checks.
      await pool.query("DELETE FROM posts WHERE id=ANY($1::int[])", [imported.data.postIds]);
      await pool.query("DELETE FROM block_entities WHERE id=ANY($1::int[])", [imported.data.blockEntityIds]);
    });
    await t.test("pages, author and publishing status do not include unrelated posts", async () => {
      const pages = await exported(`&content=pages&author=${adminId}&status=private&startDate=2025-01&endDate=2025-01`); assert.deepEqual(pages.items.map(row => Number(row["wp:post_id"])), [page]);
      const drafts = await exported(`&content=posts&author=${adminId}&status=draft`); assert.deepEqual(drafts.items.filter(row => row["wp:post_type"] === "post").map(row => Number(row["wp:post_id"])), [draft]);
      const authors = await exported(`&content=posts&author=${other}`); assert.deepEqual(authors.items.filter(row => row["wp:post_type"] === "post").map(row => Number(row["wp:post_id"])), [foreign]);
      const empty = await exported("&content=posts&category=2147483647"); assert.equal(empty.items.length, 0);
    });
    await t.test("media month filters use upload dates, retain authors and omit content/patterns", async () => {
      const result = await exported("&content=attachment&startDate=2025-01&endDate=2025-01"); assert.deepEqual(result.items.map(row => Number(row["wp:post_id"]) - 2147483648), [featured.id]); assert.ok((result.channel["wp:author"] || []).some((row: any) => Number(row["wp:author_id"]) === adminId)); assert.ok(!result.xml.includes("Selected comment"));
    });
    await t.test("all-content XML and JSON remain whole-site and options expose source-local months without secrets", async () => {
      const all = await exported("&content=all"); assert.ok(all.items.some(row => row.title === stamp + "-unrelated" && row["wp:post_type"] === "wp_block")); assert.ok(all.items.some(row => Number(row["wp:post_id"]) === boundary)); assert.ok(all.items.some(row => Number(row["wp:post_id"]) === unrelatedMedia.id + 2147483648));
      const json = await api("/api/tools/export"); assert.equal(json.response.status, 200); assert.ok(JSON.stringify(json.data).includes(stamp + "-boundary")); assert.ok(JSON.stringify(json.data).includes(unrelatedMedia.filename));
      const options = await api("/api/tools/export/options"); assert.equal(options.response.status, 200); assert.ok(options.data.months.posts.includes("2025-01")); assert.ok(options.data.months.posts.includes("2025-02")); assert.ok(options.data.months.pages.includes("2025-01")); assert.ok(options.data.categories.some((row: any) => row.id === category && row.parentId === parent)); assert.doesNotMatch(JSON.stringify(options.data), /password_hash|@example.test|token_hash/);
    });
    await t.test("every offered positive four-digit year month can be selected", async () => {
      const early = await post("-early", "post", "draft", other, "0099-01-15T12:00:00Z");
      const options = await api("/api/tools/export/options"); assert.ok(options.data.months.posts.includes("0099-01"));
      const result = await exported(`&content=posts&author=${other}&startDate=0099-01&endDate=0099-01`); assert.deepEqual(result.items.map(row => Number(row["wp:post_id"])), [early]);
    });
    await t.test("page links and parent references share the same snapshot during concurrent ancestor renaming", async () => {
      const ancestor = await post("-ancestor", "page", "publish", adminId, "2025-01-15T12:00:00Z");
      await pool.query("UPDATE posts SET parent_id=$1 WHERE id=$2", [ancestor, page]);
      const locker = await pool.connect(); let waiting: ReturnType<typeof exported> | undefined;
      try {
        await locker.query("BEGIN"); await locker.query("LOCK TABLE media IN ACCESS EXCLUSIVE MODE");
        const pid = (await locker.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
        waiting = exported(`&content=pages&author=${adminId}&status=private`);
        let blocked = false;
        for (let attempt = 0; attempt < 500; attempt++) {
          const rows = await pool.query("SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND $1=ANY(pg_blocking_pids(pid)) AND query LIKE '%FROM media m JOIN users%'", [pid]);
          if (rows.rowCount) { blocked = true; break; }
          await new Promise(resolve => setTimeout(resolve, 10));
        }
        assert.ok(blocked, "The export holds its established snapshot while waiting for the media read");
        await locker.query("UPDATE posts SET slug=$1 WHERE id=$2", [stamp + "-renamed", ancestor]); await locker.query("COMMIT");
        const result = await waiting; waiting = undefined;
        const child = result.items.find(row => Number(row["wp:post_id"]) === page)!;
        assert.equal(Number(child["wp:post_parent"]), ancestor); assert.ok(child.link.endsWith(`/${stamp}-ancestor/${stamp}-page/`), child.link);
        assert.equal((await pool.query("SELECT slug FROM posts WHERE id=$1", [ancestor])).rows[0].slug, stamp + "-renamed");
      } finally {
        await locker.query("ROLLBACK"); await waiting?.catch(() => {}); locker.release();
        await pool.query("UPDATE posts SET slug=$1 WHERE id=$2", [stamp + "-ancestor", ancestor]);
      }
    });
    await t.test("cyclic dependencies terminate and excessive nesting returns a bounded error", async () => {
      await pool.query("UPDATE block_entities SET raw_content=$1 WHERE id=$2", [block("block", { ref: child }) + block("block", { ref: outer }), outer]);
      const cycle = await exported(`&content=posts&author=${adminId}&status=publish&startDate=2025-01&endDate=2025-01`); assert.equal(cycle.items.filter(row => row["wp:post_type"] === "wp_block").length, 2);
      const originalRaw = (await pool.query("SELECT raw_content FROM posts WHERE id=$1", [selected])).rows[0].raw_content;
      let head = 0, allowedHead = 0;
      for (let index = 0; index < 65; index++) { if (index === 64) allowedHead = head; head = await entity("reusable", "-deep-" + index, head ? block("block", { ref: head }) : "<p>End</p>"); }
      try {
        await pool.query("UPDATE posts SET raw_content=$1 WHERE id=$2", [block("block", { ref: head }), selected]);
        assert.equal((await api(`/api/tools/export?format=wxr&content=posts&author=${adminId}&status=publish&startDate=2025-01&endDate=2025-01`)).response.status, 413);
        await pool.query("UPDATE posts SET raw_content=$1 WHERE id=$2", [block("block", { ref: allowedHead }), selected]);
        const allowed = await exported(`&content=posts&author=${adminId}&status=publish&startDate=2025-01&endDate=2025-01`); assert.equal(allowed.items.filter(row => row["wp:post_type"] === "wp_block").length, 64);
      } finally { await pool.query("UPDATE posts SET raw_content=$1 WHERE id=$2", [originalRaw, selected]); }
    });
    await t.test("untrusted filters and unauthorized exports cannot read content", async () => {
      for (const query of ["&format=wxr", "&format[]=wxr", "&format[nested]=wxr", "&author=1%20OR%20true", "&author=1&author=2", "&author[]=1", "&category[]=1", "&startDate=2025-14", "&startDate=2025-03&endDate=2025-01", "&status=invalid", "&content=users", "&extra=1"]) assert.equal((await fetch(base + "/api/tools/export?format=wxr" + query, { headers: { Cookie: cookie } })).status, 400);
      for (const path of ["/api/tools/export?format=wxr&content=posts", "/api/tools/export/options"]) assert.equal((await api(path, "GET", undefined, "")).response.status, 401);
    });
  } finally {
    await pool.query("DELETE FROM posts WHERE id=ANY($1::int[])", [postIds]);
    for (const id of mediaIds) await api("/api/media/" + id, "DELETE");
    await pool.query("DELETE FROM block_entities WHERE id=ANY($1::int[])", [entityIds]);
    await pool.query("DELETE FROM terms WHERE id=ANY($1::int[])", [termIds]);
    await pool.query("DELETE FROM users WHERE id=ANY($1::int[])", [userIds]);
    await pool.query("UPDATE settings SET data=$1 WHERE id=1", [originalSettings]);
    if (cookie) await api("/api/auth/logout", "POST", {});
  }
});
