import test, { after } from "./isolated-test.js";
import assert from "node:assert/strict";
import { pool } from "../server/db.js";

after(async () => { await pool.end(); });
const base = process.env.TEST_API_URL!, origin = process.env.APP_ORIGIN!;
test("private toolbar and comment-shortcut preferences persist per account across every authentication method", async () => {
  const stamp = "profile-options-" + Date.now().toString(36), password = "Temporary-profile-options-" + stamp;
  let adminCookie = "", ownCookie = ""; const users: number[] = [], posts: number[] = [];
  const api = async (path: string, method = "GET", body?: unknown, cookie = ownCookie, authorization = "") => {
    const response = await fetch(base + path, { method, headers: { Origin: origin, "Content-Type": "application/json", ...(cookie ? { Cookie: cookie } : {}), ...(authorization ? { Authorization: authorization } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { response, data: await response.json() };
  };
  try {
    const admin = await api("/api/auth/login", "POST", { login: process.env.ADMIN_EMAIL, password: process.env.ADMIN_PASSWORD }, ""); assert.equal(admin.response.status, 200); adminCookie = admin.response.headers.get("set-cookie")!.split(";")[0];
    async function account(suffix: string, role: "author" | "subscriber") {
      const result = await api("/api/users", "POST", { username: stamp + suffix, email: stamp + suffix + "@example.test", displayName: suffix, password, role }, adminCookie); assert.equal(result.response.status, 201); users.push(result.data.user.id); return result.data.user;
    }
    const own = await account("-author", "author"), other = await account("-subscriber", "subscriber");
    const signed = await api("/api/auth/login", "POST", { login: own.username, password }, ""); assert.equal(signed.response.status, 200); ownCookie = signed.response.headers.get("set-cookie")!.split(";")[0];
    assert.equal(signed.data.user.showAdminBar, true); assert.equal(signed.data.user.commentShortcuts, false);
    const saved = await api("/api/profile", "PUT", { showAdminBar: false, commentShortcuts: true, firstName: "Preserved name" }); assert.equal(saved.response.status, 200); assert.equal(saved.data.user.showAdminBar, false); assert.equal(saved.data.user.commentShortcuts, true);
    const session = await api("/api/session"); assert.equal(session.data.user.showAdminBar, false); assert.equal(session.data.user.commentShortcuts, true);
    const reloaded = await api("/api/profile"); assert.equal(reloaded.data.user.showAdminBar, false); assert.equal(reloaded.data.user.commentShortcuts, true);
    await api("/api/profile", "PUT", { nickname: "Another partial save" });
    const stored = (await pool.query("SELECT profile FROM users WHERE id=$1", [own.id])).rows[0].profile; assert.equal(stored.firstName, "Preserved name"); assert.equal(stored.showAdminBar, false); assert.equal(stored.commentShortcuts, true);
    for (const body of [{ showAdminBar: "false" }, { commentShortcuts: 1 }, { showAdminBar: null }, { showAdminBar: false, userId: other.id }]) assert.equal((await api("/api/profile", "PUT", body)).response.status, 400);
    assert.equal((await api(`/api/users/${other.id}`, "PUT", { showAdminBar: false })).response.status, 403);
    const otherProfile = await api(`/api/users/${other.id}`, "GET", undefined, adminCookie); assert.equal(otherProfile.data.user.showAdminBar, true); assert.equal(otherProfile.data.user.commentShortcuts, false);
    const key = await api("/api/profile/application-passwords", "POST", { name: "Profile options client" }); assert.equal(key.response.status, 201); const basic = "Basic " + Buffer.from(own.username + ":" + key.data.password).toString("base64");
    const application = await api("/api/session", "GET", undefined, "", basic); assert.equal(application.response.status, 200); assert.equal(application.data.user.showAdminBar, false); assert.equal(application.data.user.commentShortcuts, true); assert.equal(application.response.headers.get("set-cookie"), null);
    const fresh = await api("/api/auth/login", "POST", { login: own.username, password }, ""); assert.equal(fresh.data.user.showAdminBar, false); assert.equal(fresh.data.user.commentShortcuts, true); const freshCookie = fresh.response.headers.get("set-cookie")!.split(";")[0]; await api("/api/auth/logout", "POST", {}, freshCookie);
    const post = await api("/api/posts", "POST", { title: stamp, status: "publish", content: "<p>Public author fixture</p>" }); assert.equal(post.response.status, 201); posts.push(post.data.post.id);
    const authors = await api("/wp-json/wp/v2/users", "GET", undefined, ""); assert.equal(authors.response.status, 200); assert.doesNotMatch(JSON.stringify(authors.data), /showAdminBar|commentShortcuts|Preserved name/);
    const archive = await api("/api/tools/export", "GET", undefined, adminCookie); assert.equal(archive.response.status, 200); assert.doesNotMatch(JSON.stringify(archive.data), /showAdminBar|commentShortcuts|Preserved name/);
    const edited = await api(`/api/users/${own.id}`, "PUT", { showAdminBar: true, commentShortcuts: false }, adminCookie); assert.equal(edited.response.status, 200);
    const changed = await api("/api/session"); assert.equal(changed.data.user.showAdminBar, true); assert.equal(changed.data.user.commentShortcuts, false);
    assert.equal((await api("/api/profile", "PUT", { showAdminBar: false }, "")).response.status, 401);
  } finally {
    for (const id of posts) { await api(`/api/posts/${id}`, "PUT", { status: "trash" }, adminCookie); await api(`/api/posts/${id}`, "DELETE", undefined, adminCookie); }
    for (const id of users) await api(`/api/users/${id}`, "DELETE", undefined, adminCookie);
    if (adminCookie) await api("/api/auth/logout", "POST", {}, adminCookie);
  }
});
