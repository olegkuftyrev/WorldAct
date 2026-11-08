import test, { after } from "./isolated-test.js";
import "dotenv/config";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { pool, rootDir } from "../server/db.js";
import { canEditPostComments, contributorCanEditPostStatus } from "../server/comment-access.js";
after(async () => { await pool.end(); });

test("contributor comment permissions distinguish private content and the status before Trash", () => {
  const contributor = { id: 1, role: "contributor" };
  for (const [status, preTrashStatus, allowed] of [
    ["draft", null, true], ["pending", null, true], ["private", null, true],
    ["publish", null, false], ["future", null, false],
    ["trash", "draft", true], ["trash", "pending", true], ["trash", "private", true],
    ["trash", "publish", false], ["trash", "future", false], ["trash", null, true],
  ] as const) {
    assert.equal(contributorCanEditPostStatus({ status, preTrashStatus }), allowed);
    assert.equal(canEditPostComments(contributor, { authorId: 1, type: "post", status, preTrashStatus }), allowed);
    assert.equal(canEditPostComments(contributor, { authorId: 2, type: "post", status, preTrashStatus }), false);
    assert.equal(canEditPostComments(contributor, { authorId: 1, type: "page", status, preTrashStatus }), false);
    assert.equal(canEditPostComments({ id: 1, role: "author" }, { authorId: 1, type: "post", status, preTrashStatus }), true);
  }
});

const base = process.env.TEST_API_URL || "http://127.0.0.1:3001", origin = process.env.APP_ORIGIN || "http://127.0.0.1:5173";
test("existing private posts remain editable without granting contributors publication or former-published Trash access", async (t) => {
  let admin = "", contributor = "", userId: number | undefined;
  const postIds: number[] = [], stamp = "contributor-status-" + Date.now().toString(36);
  const api = async (route: string, method = "GET", body?: unknown, cookie = admin) => {
    const response = await fetch(base + route, { method, headers: { Origin: origin, "Content-Type": "application/json", Cookie: cookie }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { response, data: await response.json() };
  };
  const ok = async (route: string, method = "GET", body?: unknown, cookie = admin) => { const r = await api(route, method, body, cookie); assert.ok(r.response.ok, `${route}: ${r.response.status} ${JSON.stringify(r.data)}`); return r.data; };
  const create = async (label: string, status: string, extra: Record<string, unknown> = {}) => { const post = (await ok("/api/posts", "POST", { title: stamp + " " + label, authorId: userId, status, content: "<p>Contributor status fixture</p>", ...extra })).post; postIds.push(post.id); return post; };
  const makeComment = async (postId: number) => (await ok("/api/comments", "POST", { postId, authorName: stamp, authorEmail: stamp + "@example.test", content: "<p>Private visitor comment</p>" })).comment;
  try {
    const signed = await api("/api/auth/login", "POST", { login: process.env.ADMIN_EMAIL, password: process.env.ADMIN_PASSWORD }, "");
    assert.equal(signed.response.status, 200); admin = (signed.response.headers.get("set-cookie") || "").split(";")[0];
    const password = randomBytes(24).toString("base64url");
    const user = (await ok("/api/users", "POST", { username: stamp, email: stamp + "@example.test", displayName: stamp, password, role: "contributor" })).user; userId = user.id;
    const signedContributor = await api("/api/auth/login", "POST", { login: stamp, password }, "");
    assert.equal(signedContributor.response.status, 200); contributor = (signedContributor.response.headers.get("set-cookie") || "").split(";")[0];
    const privatePost = await create("private", "private"), privateComment = await makeComment(privatePost.id);
    const draft = await create("draft", "draft"), draftComment = await makeComment(draft.id);

    await t.test("private content-only saves, autosaves and comment actions are allowed while new restricted states remain forbidden", async () => {
      const opened = (await ok(`/api/posts/${privatePost.id}`, "GET", undefined, contributor)).post;
      assert.equal(opened.status, "private");
      assert.equal((await ok(`/api/posts/${privatePost.id}`, "PUT", { title: stamp + " private edited", status: "private", version: opened.version }, contributor)).post.status, "private");
      assert.equal((await api(`/api/posts/${privatePost.id}/autosave`, "PUT", { title: "Private recovery copy" }, contributor)).response.status, 200);
      assert.equal((await api("/api/posts", "POST", { title: stamp, status: "private" }, contributor)).response.status, 403);
      for (const [id, body] of [[draft.id, { status: "private" }], [privatePost.id, { status: "publish" }], [privatePost.id, { status: "future", scheduledAt: new Date(Date.now() + 86_400_000).toISOString() }]] as const)
        assert.equal((await api(`/api/posts/${id}`, "PUT", body, contributor)).response.status, 403);
      const listed = (await ok(`/api/comments?postId=${privatePost.id}`, "GET", undefined, contributor)).comments;
      assert.equal(listed[0].id, privateComment.id); assert.equal(listed[0].permissions.edit, true); assert.ok(listed[0].authorEmail);
      assert.equal((await api(`/api/comments/${privateComment.id}`, "PUT", { content: "<p>Edited private comment</p>" }, contributor)).response.status, 200);
      assert.equal((await api("/api/comments", "POST", { postId: privatePost.id, parentId: privateComment.id, content: "<p>Private reply</p>" }, contributor)).response.status, 201);
      assert.equal((await api(`/wp-json/wp/v2/comments/${privateComment.id}?context=edit`, "GET", undefined, contributor)).response.status, 403);
      assert.equal((await api(`/wp-json/wp/v2/comments/${privateComment.id}`, "GET", undefined, contributor)).response.status, 200);
      const bulk = await ok("/api/posts/bulk", "POST", { ids: [privatePost.id, draft.id], changes: { pingStatus: "open" } }, contributor);
      assert.equal(bulk.updated.length, 2); assert.deepEqual(bulk.errors, []);
    });
    await t.test("Trash retains its previous status and applies identical post, comment, SQL list and REST permissions", async () => {
      const unpublishedTrash = (await ok(`/api/posts/${draft.id}`, "PUT", { status: "trash" }, contributor)).post;
      assert.equal(unpublishedTrash.preTrashStatus, "draft");
      assert.equal((await ok(`/api/posts/${draft.id}`, "PUT", { title: stamp + " edited trash", status: "trash" }, contributor)).post.preTrashStatus, "draft");
      assert.equal((await api(`/api/comments/${draftComment.id}`, "PUT", { status: "pending" }, contributor)).response.status, 200);
      assert.equal((await ok(`/api/comments?postId=${draft.id}`, "GET", undefined, contributor)).comments[0].permissions.edit, true);
      assert.equal((await ok(`/api/posts/${privatePost.id}`, "PUT", { status: "trash" })).post.preTrashStatus, "private");
      assert.equal((await api(`/api/posts/${privatePost.id}`, "GET", undefined, contributor)).response.status, 200);
      for (const status of ["publish", "future"]) {
        const post = await create(status, status, status === "future" ? { scheduledAt: new Date(Date.now() + 86_400_000).toISOString() } : {}), comment = await makeComment(post.id);
        const removed = (await ok(`/api/posts/${post.id}`, "PUT", { status: "trash" })).post;
        assert.equal(removed.preTrashStatus, status);
        await ok(`/api/posts/${post.id}`, "PUT", { title: stamp + " changed while trash" });
        assert.equal((await ok(`/api/posts/${post.id}`)).post.preTrashStatus, status);
        assert.equal((await api(`/api/posts/${post.id}`, "GET", undefined, contributor)).response.status, 403);
        assert.equal((await api(`/api/posts/${post.id}`, "PUT", { title: "Forbidden" }, contributor)).response.status, 403);
        assert.equal((await api(`/api/comments/${comment.id}`, "PUT", { content: "Forbidden" }, contributor)).response.status, 403);
        assert.equal((await api(`/api/comments/${comment.id}`, "DELETE", undefined, contributor)).response.status, 403);
        assert.equal((await ok(`/api/comments?postId=${post.id}`, "GET", undefined, contributor)).pagination.total, 0);
        assert.equal((await api(`/wp-json/wp/v2/comments/${comment.id}`, "GET", undefined, contributor)).response.status, 404);
        assert.equal((await api(`/wp-json/wp/v2/comments/${comment.id}?force=true`, "DELETE", undefined, contributor)).response.status, 403);
        const revisions = (await ok(`/api/posts/${post.id}/revisions`)).revisions;
        assert.ok(revisions.some((item: any) => item.status === status), "Entering Trash must keep a recoverable snapshot of the previous status.");
        await ok(`/api/posts/${post.id}`, "PUT", { status: "draft" });
        assert.equal((await ok(`/api/posts/${post.id}`, "GET", undefined, contributor)).post.preTrashStatus, null);
        assert.equal((await api(`/api/comments/${comment.id}`, "PUT", { content: "Allowed after draft transition" }, contributor)).response.status, 200);
      }
      assert.equal((await api(`/api/posts/${draft.id}`, "PUT", { preTrashStatus: "publish" }, contributor)).response.status, 400);
    });
    await t.test("repeatable migration backfills legacy Trash from revision history without replacing explicit metadata", async () => {
      const legacy = await create("legacy", "publish");
      await ok(`/api/posts/${legacy.id}`, "PUT", { status: "trash" });
      await pool.query("UPDATE posts SET pre_trash_status=NULL WHERE id=$1", [legacy.id]);
      const sql = await readFile(path.join(rootDir, "server/post-trash-schema.sql"), "utf8");
      await pool.query(sql); await pool.query(sql);
      assert.equal((await ok(`/api/posts/${legacy.id}`)).post.preTrashStatus, "publish");
      await pool.query("UPDATE posts SET pre_trash_status='draft' WHERE id=$1", [legacy.id]);
      await pool.query(sql);
      assert.equal((await ok(`/api/posts/${legacy.id}`)).post.preTrashStatus, "draft");
    });
    await t.test("JSON copies retain validated pre-trash metadata across fresh IDs", async () => {
      const imported = await ok("/api/tools/import", "POST", { application: "WorldAct", version: 3, posts: [{ id: 1, type: "post", title: stamp + " imported trash", slug: stamp + "-imported", status: "trash", pre_trash_status: "publish", content: "<p>Imported status</p>" }] });
      postIds.push(...imported.postIds);
      const id = imported.postIds[0];
      assert.equal((await ok(`/api/posts/${id}`)).post.preTrashStatus, "publish");
      await ok(`/api/posts/${id}`, "PUT", { authorId: userId });
      assert.equal((await api(`/api/posts/${id}`, "GET", undefined, contributor)).response.status, 403);
    });
  } finally {
    for (const id of postIds) { await api(`/api/posts/${id}`, "PUT", { status: "trash" }); await api(`/api/posts/${id}`, "DELETE"); }
    if (contributor) await api("/api/auth/logout", "POST", {}, contributor);
    if (userId) await api(`/api/users/${userId}`, "DELETE");
    if (admin) await api("/api/auth/logout", "POST", {});
  }
});
