import test, { after } from "./isolated-test.js";
import "dotenv/config";
import assert from "node:assert/strict";
import { pool } from "../server/db.js";
const base = process.env.TEST_API_URL || "http://127.0.0.1:3001", origin = process.env.APP_ORIGIN || "http://127.0.0.1:5173";
after(async () => { await pool.end(); });

test("post saves, revisions, autosaves and leases lock their actor before content during account changes", async t => {
  const stamp = "actor-lock-" + Date.now().toString(36), password = "Temporary-actor-" + stamp;
  let admin = "", editor = "", userId: number | undefined, postId: number | undefined;
  const api = async (route: string, method = "GET", body?: unknown, cookie = admin) => {
    const response = await fetch(base + "/api" + route, { method, headers: { Origin: origin, "Content-Type": "application/json", Cookie: cookie }, signal: AbortSignal.timeout(10_000), ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { response, data: await response.json() };
  };
  const ok = async (route: string, method = "GET", body?: unknown, cookie = admin) => { const r = await api(route, method, body, cookie); assert.ok(r.response.ok, `${route}: ${r.response.status} ${JSON.stringify(r.data)}`); return r.data; };
  // Hold the same first lock as account deletion, wait for the actual HTTP
  // mutation to reach it, then take the post lock. Reversed ordering deadlocks
  // here (or hits our short lock timeout) instead of relying on lucky timing.
  const whileActorLocked = async (route: string, method: string, body: unknown, changeRole = false) => {
    const blocker = await pool.connect(); let pending: ReturnType<typeof api> | undefined;
    try {
      await blocker.query("BEGIN");
      const pid = (await blocker.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
      await blocker.query("SELECT id FROM users WHERE id=$1 FOR UPDATE", [userId]);
      pending = api(route, method, body, editor);
      let blocked = false;
      for (let attempt = 0; attempt < 100; attempt++) {
        const waiting = await pool.query("SELECT query FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid))", [pid]);
        if (waiting.rows.some(row => row.query.includes("SELECT id,role FROM users"))) { blocked = true; break; }
        await new Promise(resolve => setTimeout(resolve, 15));
      }
      assert.ok(blocked, "The mutation must wait for its actor account before locking a post.");
      await blocker.query("SET LOCAL lock_timeout='200ms'");
      await blocker.query("SELECT id FROM posts WHERE id=$1 FOR UPDATE", [postId]);
      if (changeRole) await blocker.query("UPDATE users SET role='subscriber' WHERE id=$1", [userId]);
      await blocker.query(changeRole ? "COMMIT" : "ROLLBACK");
      return await pending;
    } finally {
      await blocker.query("ROLLBACK").catch(() => {}); blocker.release();
      if (pending) await pending.catch(() => {});
    }
  };
  try {
    const login = await api("/auth/login", "POST", { login: process.env.ADMIN_EMAIL, password: process.env.ADMIN_PASSWORD }, ""); assert.equal(login.response.status, 200); admin = login.response.headers.get("set-cookie")!.split(";")[0];
    const person = (await ok("/users", "POST", { username: stamp, email: stamp + "@example.test", displayName: stamp, password, role: "editor" })).user; userId = person.id;
    const signed = await api("/auth/login", "POST", { login: stamp, password }, ""); assert.equal(signed.response.status, 200); editor = signed.response.headers.get("set-cookie")!.split(";")[0];
    postId = (await ok("/posts", "POST", { title: stamp + " original", status: "draft" }, editor)).post.id;
    await ok(`/posts/${postId}`, "PUT", { title: stamp + " revised" }, editor);
    const revisionId = (await ok(`/posts/${postId}/revisions`, "GET", undefined, editor)).revisions.at(-1).id;
    for (const [label, route, method, body] of [
      ["save with implicit actor", `/posts/${postId}`, "PUT", { title: stamp + " save" }],
      ["save with explicit assigned author", `/posts/${postId}`, "PUT", { authorId: userId, title: stamp + " assigned" }],
      ["bulk save", "/posts/bulk", "POST", { ids: [postId], changes: { pingStatus: "open" } }],
      ["autosave", `/posts/${postId}/autosave`, "PUT", { title: stamp + " recovered" }],
      ["revision restore", `/posts/${postId}/revisions/${revisionId}/restore`, "POST", {}],
      ["edit lease", `/posts/${postId}/lock`, "PUT", {}],
    ] as const) await t.test(label, async () => {
      const result = await whileActorLocked(route, method, body); assert.equal(result.response.status, 200, JSON.stringify(result.data));
      if (route === "/posts/bulk") assert.deepEqual(result.data.errors, []);
      if (route.endsWith("/lock")) await ok(route, "DELETE", undefined, editor);
    });
    await t.test("a concurrent role revocation cannot use permissions loaded before the account lock", async () => {
      const before = (await ok(`/posts/${postId}`)).post;
      const result = await whileActorLocked(`/posts/${postId}`, "PUT", { title: "Should not survive role revocation" }, true);
      assert.equal(result.response.status, 409);
      assert.equal((await ok(`/posts/${postId}`)).post.title, before.title);
      await ok(`/users/${userId}`, "PUT", { role: "editor" });
    });
    await t.test("permanent deletion uses the same actor-first ordering", async () => {
      await ok(`/posts/${postId}`, "PUT", { status: "trash" }, editor);
      const result = await whileActorLocked(`/posts/${postId}`, "DELETE", undefined); assert.equal(result.response.status, 200, JSON.stringify(result.data)); postId = undefined;
    });
  } finally {
    if (postId) { await pool.query("DELETE FROM post_edit_locks WHERE post_id=$1", [postId]); await api(`/posts/${postId}`, "PUT", { status: "trash" }); await api(`/posts/${postId}`, "DELETE"); }
    if (userId) await api(`/users/${userId}`, "DELETE");
    if (editor) await api("/auth/logout", "POST", {}, editor);
    if (admin) await api("/auth/logout", "POST", {});
  }
});
