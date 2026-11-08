import test, { after } from "./isolated-test.js";
import assert from "node:assert/strict";
import { pool } from "../server/db.js";
import { DEFAULT_EDITOR_PREFERENCES, resolveEditorPreferences } from "../shared/editor-preferences.js";

after(() => pool.end());
const base = process.env.TEST_API_URL!, origin = process.env.APP_ORIGIN!;
async function api(route: string, method = "GET", body?: unknown, cookie = "") {
  const response = await fetch(base + route, {
    method, signal: AbortSignal.timeout(10_000),
    headers: { Origin: origin, "Content-Type": "application/json", ...(cookie ? { Cookie: cookie } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { response, data: await response.json() };
}

test("editor defaults match source and malformed legacy preferences cannot enable modes", () => {
  assert.equal(DEFAULT_EDITOR_PREFERENCES.fixedToolbar, false);
  assert.equal(DEFAULT_EDITOR_PREFERENCES.fullscreenMode, true);
  assert.equal(DEFAULT_EDITOR_PREFERENCES.showBlockBreadcrumbs, true);
  assert.equal(DEFAULT_EDITOR_PREFERENCES.editorMode, "visual");
  for (const value of [null, [], false, "text", { editorMode: "invalid", focusMode: "true" }, Object.create({ fixedToolbar: true })]) {
    assert.deepEqual(resolveEditorPreferences(value), DEFAULT_EDITOR_PREFERENCES);
  }
  assert.deepEqual(resolveEditorPreferences({ editorMode: "text", focusMode: true, unknown: true }), {
    ...DEFAULT_EDITOR_PREFERENCES, editorMode: "text", focusMode: true,
  });
});

test("editor preferences remain private per account and concurrent partial saves preserve other preferences", async () => {
  const stamp = "editor-prefs-" + Date.now().toString(36), password = "Temporary-editor-preferences-" + stamp;
  let adminCookie = "", ownCookie = "", otherCookie = "", ownId = 0, otherId = 0;
  try {
    const login = await api("/api/auth/login", "POST", { login: process.env.ADMIN_EMAIL, password: process.env.ADMIN_PASSWORD });
    assert.equal(login.response.status, 200); adminCookie = login.response.headers.get("set-cookie")!.split(";")[0];
    for (const suffix of ["own", "other"]) {
      const created = await api("/api/users", "POST", { username: stamp + suffix, email: stamp + suffix + "@example.test", displayName: suffix, password, role: "author" }, adminCookie);
      assert.equal(created.response.status, 201);
      const signed = await api("/api/auth/login", "POST", { login: created.data.user.username, password });
      assert.equal(signed.response.status, 200);
      if (suffix === "own") { ownId = created.data.user.id; ownCookie = signed.response.headers.get("set-cookie")!.split(";")[0]; }
      else { otherId = created.data.user.id; otherCookie = signed.response.headers.get("set-cookie")!.split(";")[0]; }
    }
    assert.equal((await api("/api/preferences", "PUT", { editor: { editorMode: "text" } })).response.status, 401);
    for (const editor of [null, [], true, { fixedToolbar: "false" }, { focusMode: 1 }, { editorMode: "code" }, { madeUpFeature: true }]) {
      assert.equal((await api("/api/preferences", "PUT", { editor }, ownCookie)).response.status, 400);
    }
    assert.equal((await api("/api/preferences", "PUT", { editor: { focusMode: true }, userId: otherId }, ownCookie)).response.status, 400);
    const seed = await api("/api/preferences", "PUT", { editor: { editorMode: "text", showBlockBreadcrumbs: false }, listTables: { posts: { perPage: 7 } }, collapsedMenu: true }, ownCookie);
    assert.equal(seed.response.status, 200);
    const responses = await Promise.all([
      api("/api/preferences", "PUT", { editor: { fixedToolbar: true, keepCaretInsideBlock: true } }, ownCookie),
      api("/api/preferences", "PUT", { editor: { showIconLabels: true, showListViewByDefault: true } }, ownCookie),
      api("/api/preferences", "PUT", { listTables: { posts: { hiddenColumns: ["date"] } } }, ownCookie),
    ]);
    for (const result of responses) assert.equal(result.response.status, 200);
    const profile = await api("/api/profile", "GET", undefined, ownCookie);
    assert.deepEqual(profile.data.preferences.editor, { editorMode: "text", showBlockBreadcrumbs: false, fixedToolbar: true, keepCaretInsideBlock: true, showIconLabels: true, showListViewByDefault: true });
    assert.deepEqual(profile.data.preferences.listTables.posts, { perPage: 7, hiddenColumns: ["date"] });
    assert.equal(profile.data.preferences.collapsedMenu, true);
    const other = await api("/api/profile", "GET", undefined, otherCookie);
    assert.deepEqual(resolveEditorPreferences(other.data.preferences.editor), DEFAULT_EDITOR_PREFERENCES);
    const freshLogin = await api("/api/auth/login", "POST", { login: stamp + "own", password });
    assert.equal(freshLogin.response.status, 200); const freshCookie = freshLogin.response.headers.get("set-cookie")!.split(";")[0];
    try { assert.deepEqual((await api("/api/profile", "GET", undefined, freshCookie)).data.preferences.editor, profile.data.preferences.editor); }
    finally { await api("/api/auth/logout", "POST", {}, freshCookie); }
    const publicAuthors = await api("/wp-json/wp/v2/users"); assert.equal(publicAuthors.response.status, 200);
    const archive = await api("/api/tools/export", "GET", undefined, adminCookie); assert.equal(archive.response.status, 200);
    for (const data of [publicAuthors.data, archive.data]) assert.doesNotMatch(JSON.stringify(data), /keepCaretInsideBlock|showIconLabels|showListViewByDefault/);
  } finally {
    for (const cookie of [ownCookie, otherCookie]) if (cookie) await api("/api/auth/logout", "POST", {}, cookie);
    for (const id of [ownId, otherId]) if (id) await api("/api/users/" + id, "DELETE", undefined, adminCookie);
    if (adminCookie) await api("/api/auth/logout", "POST", {}, adminCookie);
  }
});
