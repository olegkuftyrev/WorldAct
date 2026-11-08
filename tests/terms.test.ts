import "dotenv/config";
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { pool } from "../server/db.js";
after(async () => { await pool.end(); });
const base = process.env.TEST_API_URL || "http://127.0.0.1:3001", origin = process.env.APP_ORIGIN || "http://127.0.0.1:5173";

test("term deletion preserves the configured default, category ancestry and affected post assignments", async (t) => {
  let cookie = "";
  const termIds: number[] = [], postIds: number[] = [], stamp = "terms-" + Date.now().toString(36);
  const api = async (route: string, method = "GET", body?: unknown) => {
    const response = await fetch(base + "/api" + route, { method, headers: { Origin: origin, "Content-Type": "application/json", Cookie: cookie }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { response, data: await response.json() };
  };
  const ok = async (route: string, method = "GET", body?: unknown) => { const r = await api(route, method, body); assert.ok(r.response.ok, `${route}: ${r.response.status} ${JSON.stringify(r.data)}`); return r.data; };
  const signed = await api("/auth/login", "POST", { login: process.env.ADMIN_EMAIL, password: process.env.ADMIN_PASSWORD });
  assert.equal(signed.response.status, 200); cookie = (signed.response.headers.get("set-cookie") || "").split(";")[0];
  const baseline = (await pool.query("SELECT data FROM settings WHERE id=1")).rows[0].data;
  const markers = (await pool.query("SELECT id FROM terms WHERE is_default ORDER BY id")).rows.map(item => item.id);
  const category = async (suffix: string, parentId?: number) => { const term = (await ok("/terms", "POST", { taxonomy: "category", name: stamp + " " + suffix, slug: stamp + "-" + suffix, ...(parentId ? { parentId } : {}) })).term; termIds.push(term.id); return term; };
  const post = async (suffix: string, categoryIds: number[]) => { const row = (await ok("/posts", "POST", { title: stamp + " " + suffix, content: "<p>Term integrity fixture</p>", categoryIds })).post; postIds.push(row.id); return row; };
  try {
    const former = await category("former-default"), selected = await category("selected-default");
    // Move the internal legacy marker only onto our own fixture; existing term
    // records are never deleted, and the original markers are restored below.
    const markerClient = await pool.connect();
    try {
      await markerClient.query("BEGIN");
      await markerClient.query("UPDATE terms SET is_default=false WHERE is_default");
      await markerClient.query("UPDATE terms SET is_default=true WHERE id=$1", [former.id]);
      await markerClient.query("COMMIT");
    } catch (error) { await markerClient.query("ROLLBACK"); throw error; }
    finally { markerClient.release(); }
    await ok("/settings", "PUT", { defaultCategoryId: former.id });
    assert.equal((await api(`/terms/${former.id}`, "DELETE")).response.status, 409);
    await ok("/settings", "PUT", { defaultCategoryId: selected.id });
    await t.test("the configured default, rather than the old static marker, controls protection and DTOs", async () => {
      const terms = (await ok("/terms?taxonomy=category")).terms;
      assert.equal(terms.find((item: any) => item.id === selected.id).isDefault, true);
      assert.equal(terms.find((item: any) => item.id === former.id).isDefault, false);
      assert.equal((await api(`/terms/${selected.id}`, "DELETE")).response.status, 409);
      await ok(`/terms/${former.id}`, "DELETE");
      assert.equal((await pool.query("SELECT 1 FROM terms WHERE id=$1", [former.id])).rowCount, 0);
      assert.deepEqual((await pool.query("SELECT id FROM terms WHERE is_default ORDER BY id")).rows.map(item => item.id), [selected.id]);
      assert.equal((await ok("/settings")).settings.defaultCategoryId, selected.id);
    });
    const grandparent = await category("grandparent"), parent = await category("parent", grandparent.id), child = await category("child", parent.id), grandchild = await category("grandchild", child.id);
    await t.test("opt-in server paging preserves unpaged pickers and repeated category ancestors", async () => {
      const picker = await ok("/terms?taxonomy=category");
      assert.equal(picker.pagination, undefined);
      assert.equal((await ok(`/terms/${child.id}`)).term.parentId, parent.id);
      assert.equal((await api("/terms/2147483647")).response.status, 404);
      const all = await ok("/terms?taxonomy=category&page=1&perPage=1000");
      assert.equal(all.pagination.total, picker.terms.length);
      const childIndex = all.terms.findIndex((item: any) => item.id === child.id);
      const page = await ok(`/terms?taxonomy=category&page=${childIndex + 1}&perPage=1`);
      assert.deepEqual(page.terms.filter((item: any) => item.contextOnly).map((item: any) => item.id), [grandparent.id, parent.id]);
      assert.deepEqual(page.terms.filter((item: any) => !item.contextOnly).map((item: any) => item.id), [child.id]);
      assert.deepEqual(page.terms.map((item: any) => item.depth), [0, 1, 2]);
      assert.equal(page.pagination.total, picker.terms.length);
      assert.equal(page.pagination.totalPages, picker.terms.length);
      const searched = await ok(`/terms?taxonomy=category&search=${stamp}&page=1&perPage=2&orderby=name&order=desc`);
      assert.equal(searched.terms.length, 2);
      assert.equal(searched.pagination.total, 5);
      assert.ok(searched.terms.every((item: any) => !item.contextOnly));
      const second = await ok(`/terms?taxonomy=category&search=${stamp}&page=2&perPage=2&orderby=name&order=desc`);
      assert.equal(new Set([...searched.terms, ...second.terms].map((item: any) => item.id)).size, 4);
      const empty = await ok(`/terms?taxonomy=category&search=${stamp}-missing&page=1&perPage=2`);
      assert.equal(empty.pagination.total, 0); assert.deepEqual(empty.terms, []);
      for (const query of ["page=0", "perPage=1001", "orderby=invalid", "order=invalid"])
        assert.equal((await api(`/terms?taxonomy=category&${query}`)).response.status, 400);
    });
    const onlyDeleted = await post("only-deleted", [parent.id]), alsoOther = await post("also-other", [parent.id, grandparent.id]), unrelated = await post("unrelated", [grandparent.id]);
    await t.test("deleting an intermediate category moves direct children up one level and categorizes only affected posts", async () => {
      await ok(`/terms/${parent.id}`, "DELETE");
      const terms = (await ok("/terms?taxonomy=category")).terms;
      assert.equal(terms.find((item: any) => item.id === child.id).parentId, grandparent.id);
      assert.equal(terms.find((item: any) => item.id === grandchild.id).parentId, child.id);
      assert.deepEqual((await ok(`/posts/${onlyDeleted.id}`)).post.categoryIds, [selected.id]);
      assert.deepEqual((await ok(`/posts/${alsoOther.id}`)).post.categoryIds, [grandparent.id]);
      assert.deepEqual((await ok(`/posts/${unrelated.id}`)).post.categoryIds, [grandparent.id]);
      const created = await post("new-default-post", []);
      assert.deepEqual(created.categoryIds, [selected.id]);
    });
    await t.test("a deleted top-level category leaves its direct children at the top level", async () => {
      await ok(`/terms/${grandparent.id}`, "DELETE");
      const terms = (await ok("/terms?taxonomy=category")).terms;
      assert.equal(terms.find((item: any) => item.id === child.id).parentId, null);
      assert.equal(terms.find((item: any) => item.id === grandchild.id).parentId, child.id);
      assert.deepEqual((await ok(`/posts/${alsoOther.id}`)).post.categoryIds, [selected.id]);
      assert.deepEqual((await ok(`/posts/${unrelated.id}`)).post.categoryIds, [selected.id]);
    });
    await t.test("concurrent default selection and deletion serialize without a dangling setting", async () => {
      const waitForBlocked = async (count: number) => {
        for (let attempt = 0; attempt < 200; attempt++) {
          const result = await pool.query("SELECT count(*)::int AS count FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query ILIKE '%settings%FOR UPDATE%'");
          if (result.rows[0].count >= count) return;
          await new Promise(resolve => setTimeout(resolve, 10));
        }
        throw new Error("The concurrent settings requests did not reach the row lock.");
      };
      for (const winner of ["delete", "setting"] as const) {
        const target = await category(`race-${winner}`), blocker = await pool.connect();
        let first: ReturnType<typeof api> | undefined, second: ReturnType<typeof api> | undefined;
        try {
          await blocker.query("BEGIN");
          await blocker.query("SELECT id FROM settings WHERE id=1 FOR UPDATE");
          first = winner === "delete" ? api(`/terms/${target.id}`, "DELETE") : api("/settings", "PUT", { defaultCategoryId: target.id });
          await waitForBlocked(1);
          second = winner === "delete" ? api("/settings", "PUT", { defaultCategoryId: target.id }) : api(`/terms/${target.id}`, "DELETE");
          await waitForBlocked(2);
          await blocker.query("COMMIT");
          const [a, b] = await Promise.all([first, second]);
          assert.equal(a.response.status, 200, JSON.stringify(a.data));
          assert.equal(b.response.status, winner === "delete" ? 400 : 409, JSON.stringify(b.data));
          const current = (await ok("/settings")).settings.defaultCategoryId;
          assert.equal(current, winner === "delete" ? selected.id : target.id);
          assert.equal((await pool.query("SELECT 1 FROM terms WHERE taxonomy='category' AND id=$1", [current])).rowCount, 1);
        } finally {
          await blocker.query("ROLLBACK"); blocker.release();
          await Promise.allSettled([first, second].filter(Boolean));
          await ok("/settings", "PUT", { defaultCategoryId: selected.id });
        }
      }
    });
  } finally {
    await pool.query("UPDATE settings SET data=(data-'defaultCategoryId') || $1::jsonb WHERE id=1", [JSON.stringify(Object.hasOwn(baseline, "defaultCategoryId") ? { defaultCategoryId: baseline.defaultCategoryId } : {})]);
    await pool.query("UPDATE terms SET is_default=false WHERE is_default");
    if (markers.length) await pool.query("UPDATE terms SET is_default=true WHERE id=ANY($1::int[])", [markers]);
    for (const id of postIds) { await api(`/posts/${id}`, "PUT", { status: "trash" }); await api(`/posts/${id}`, "DELETE"); }
    for (const id of termIds.reverse()) await api(`/terms/${id}`, "DELETE");
    await api("/auth/logout", "POST", {});
  }
});
