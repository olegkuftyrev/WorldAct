import "dotenv/config";
import test from "node:test";
import assert from "node:assert/strict";

const base = process.env.TEST_API_URL || "http://127.0.0.1:3001";
const origin = process.env.APP_ORIGIN || "http://127.0.0.1:5173";
async function api(path: string, method = "GET", body?: unknown, cookie = "") {
  const response = await fetch(base + path, {
    method,
    headers: {
      Origin: origin,
      "Content-Type": "application/json",
      ...(cookie ? { Cookie: cookie } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { response, data: await response.json() };
}
const cookieOf = (response: Response) =>
  (response.headers.get("set-cookie") || "").split(";")[0];

test("comment editorial workflows preserve ownership, hierarchy, versions and public privacy", async () => {
  const stamp = Date.now().toString(36);
  const login = await api("/api/auth/login", "POST", {
    login: process.env.ADMIN_EMAIL,
    password: process.env.ADMIN_PASSWORD,
  });
  assert.equal(login.response.status, 200);
  const admin = cookieOf(login.response),
    posts: number[] = [],
    comments: number[] = [];
  let userId: number | undefined,
    authorCookie = "";
  try {
    for (const suffix of ["one", "two"]) {
      const result = await api(
        "/api/posts",
        "POST",
        {
          title: `Comment QA ${stamp} ${suffix}`,
          status: "publish",
          content: "<p>Comment test</p>",
        },
        admin,
      );
      assert.equal(result.response.status, 201);
      posts.push(result.data.post.id);
    }
    assert.equal((await api("/api/comments")).response.status, 401);
    const created = await api(
      "/api/comments",
      "POST",
      {
        postId: posts[0],
        content: "<p>Moderator reply %needle</p><script>alert(1)</script>",
        authorUrl: "https://example.test/author",
      },
      admin,
    );
    assert.equal(created.response.status, 201, JSON.stringify(created.data));
    comments.push(created.data.comment.id);
    assert.equal(created.data.comment.status, "approved");
    assert.equal(created.data.comment.userId, login.data.user.id);
    assert.doesNotMatch(created.data.comment.content, /<script/);
    const reply = await api(
      "/api/comments",
      "POST",
      {
        postId: posts[0],
        parentId: comments[0],
        content: "<p>A threaded reply</p>",
        status: "pending",
      },
      admin,
    );
    assert.equal(reply.response.status, 201);
    comments.push(reply.data.comment.id);
    const visitor = await api(
      "/api/comments",
      "POST",
      {
        postId: posts[1],
        authorEmail: "visitor@example.test",
        authorName: "Another person",
        content: "A visitor comment",
      },
      admin,
    );
    assert.equal(visitor.response.status, 201);
    comments.push(visitor.data.comment.id);
    assert.equal(visitor.data.comment.userId, null);
    const edit = await api(
      `/api/comments/${comments[0]}`,
      "PUT",
      {
        version: created.data.comment.version,
        authorName: "Edited moderator",
        authorEmail: "edited@example.test",
        content: "<p>Edited text %needle</p>",
      },
      admin,
    );
    assert.equal(edit.response.status, 200);
    assert.equal(edit.data.comment.authorUrl, "https://example.test/author");
    assert.equal(edit.data.comment.userId, null);
    assert.equal(edit.data.comment.version, created.data.comment.version + 1);
    assert.equal(
      (
        await api(
          `/api/comments/${comments[0]}`,
          "PUT",
          { version: created.data.comment.version, content: "Stale text" },
          admin,
        )
      ).response.status,
      409,
    );
    assert.equal(
      (
        await api(
          `/api/comments/${comments[0]}`,
          "PUT",
          { parentId: comments[1] },
          admin,
        )
      ).response.status,
      400,
    );
    assert.equal(
      (
        await api(
          "/api/comments",
          "POST",
          {
            postId: posts[1],
            parentId: comments[0],
            content: "Cross-post reply",
          },
          admin,
        )
      ).response.status,
      400,
    );
    assert.equal(
      (
        await api(
          `/api/comments/${comments[0]}`,
          "PUT",
          { authorUrl: "javascript:alert(1)" },
          admin,
        )
      ).response.status,
      400,
    );
    const list = await api(
      `/api/comments?postId=${posts[0]}&perPage=1&page=2&order=asc`,
      "GET",
      undefined,
      admin,
    );
    assert.equal(list.response.status, 200);
    assert.equal(list.data.pagination.total, 2);
    assert.equal(list.data.comments.length, 1);
    assert.equal(list.data.counts.pending, 1);
    const searched = await api(
      `/api/comments?postId=${posts[0]}&search=${encodeURIComponent("%needle")}`,
      "GET",
      undefined,
      admin,
    );
    assert.equal(searched.data.comments.length, 1);
    const post = await api(`/api/posts/${posts[0]}`, "GET", undefined, admin);
    const publicDetail = await api(`/api/public/posts/${post.data.post.slug}`);
    const publicComment = publicDetail.data.comments.find(
      (c: any) => c.id === comments[0],
    );
    assert.equal(publicComment.authorEmail, undefined);
    assert.equal(publicComment.authorUrl, "https://example.test/author");
    const account = await api(
      "/api/users",
      "POST",
      {
        username: `comment-author-${stamp}`,
        email: `comment-author-${stamp}@example.test`,
        displayName: "Comment author",
        password: `Safe-comment-${stamp}-password`,
        role: "author",
      },
      admin,
    );
    assert.equal(account.response.status, 201);
    userId = account.data.user.id;
    const authorLogin = await api("/api/auth/login", "POST", {
      login: account.data.user.username,
      password: `Safe-comment-${stamp}-password`,
    });
    authorCookie = cookieOf(authorLogin.response);
    assert.equal(
      (await api("/api/comments", "GET", undefined, authorCookie)).response
        .status,
      403,
    );
    assert.equal(
      (
        await api(
          `/api/comments/${comments[0]}`,
          "PUT",
          { status: "approved" },
          authorCookie,
        )
      ).response.status,
      403,
    );
    const submitted = await api(
      "/api/public/comments",
      "POST",
      { postId: posts[0], content: "<p>Authenticated public comment</p>" },
      authorCookie,
    );
    assert.equal(submitted.response.status, 201);
    comments.push(submitted.data.comment.id);
    const stored = await api(
      `/api/comments?postId=${posts[0]}`,
      "GET",
      undefined,
      admin,
    );
    assert.equal(
      stored.data.comments.find((c: any) => c.id === submitted.data.comment.id)
        .userId,
      userId,
    );
    assert.equal(
      (
        await api(
          `/api/comments/${created.data.comment.id}`,
          "DELETE",
          undefined,
          admin,
        )
      ).response.status,
      200,
    );
    const orphaned = (
      await api(`/api/comments?postId=${posts[0]}`, "GET", undefined, admin)
    ).data.comments.find((c: any) => c.id === reply.data.comment.id);
    assert.equal(orphaned.parentId, null);
    assert.equal(orphaned.version, reply.data.comment.version + 1);
    assert.equal(
      (
        await api(
          `/api/comments/${reply.data.comment.id}`,
          "PUT",
          { version: reply.data.comment.version, content: "Stale reply" },
          admin,
        )
      ).response.status,
      409,
    );
  } finally {
    for (const id of comments.reverse())
      await api(`/api/comments/${id}`, "DELETE", undefined, admin);
    for (const id of posts) {
      await api(`/api/posts/${id}`, "PUT", { status: "trash" }, admin);
      await api(`/api/posts/${id}`, "DELETE", undefined, admin);
    }
    if (authorCookie)
      await api("/api/auth/logout", "POST", undefined, authorCookie);
    if (userId) await api(`/api/users/${userId}`, "DELETE", undefined, admin);
    await api("/api/auth/logout", "POST", undefined, admin);
  }
});
