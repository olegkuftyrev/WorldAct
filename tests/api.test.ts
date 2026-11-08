import { test } from "./isolated-test.js";
import "dotenv/config";
import assert from "node:assert/strict";

const base = process.env.TEST_API_URL || "http://127.0.0.1:3001";
const origin = process.env.APP_ORIGIN || "http://127.0.0.1:5173";
let adminCookie = "";
async function request(
  path: string,
  options: {
    method?: string;
    body?: unknown;
    cookie?: string;
    origin?: string;
  } = {},
) {
  const response = await fetch(`${base}${path}`, {
    method: options.method || "GET",
    headers: {
      "Content-Type": "application/json",
      Origin: options.origin || origin,
      ...(options.cookie ? { Cookie: options.cookie } : {}),
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const data = await response.json();
  return { response, data };
}

// Runs against a running local API and PostgreSQL. Creates only uniquely named test records,
// then removes them. No existing content or settings are modified.
test("PostgreSQL-backed CMS workflows and access boundaries", async (t) => {
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  let postId: number | undefined;
  let commentId: number | undefined;
  let authorId: number | undefined;
  let mediaId: number | undefined;
  let authorCookie = "";
  const password = `Test-only-${suffix}!`;
  try {
    await t.test(
      "anonymous sessions return no user and admin data is protected",
      async () => {
        const session = await request("/api/session");
        assert.equal(session.response.status, 200);
        assert.equal(session.data.user, null);
        for (const path of [
          "/api/posts",
          "/api/users",
          "/api/settings",
          "/api/media",
          "/api/comments",
          "/api/dashboard",
        ]) {
          assert.equal((await request(path)).response.status, 401, path);
        }
      },
    );
    await t.test("invalid passwords do not authenticate", async () => {
      const { response } = await request("/api/auth/login", {
        method: "POST",
        body: {
          login: process.env.ADMIN_EMAIL,
          password: "deliberately-wrong-password",
        },
      });
      assert.equal(response.status, 401);
    });
    await t.test(
      "administrator login creates a protected session cookie",
      async () => {
        const { response, data } = await request("/api/auth/login", {
          method: "POST",
          body: {
            login: process.env.ADMIN_EMAIL,
            password: process.env.ADMIN_PASSWORD,
          },
        });
        assert.equal(response.status, 200, JSON.stringify(data));
        assert.equal(data.user.role, "administrator");
        const cookie = response.headers.get("set-cookie") || "";
        assert.match(cookie, /HttpOnly/i);
        assert.match(cookie, /SameSite=Lax/i);
        adminCookie = cookie.split(";")[0];
        assert.ok(adminCookie);
        assert.equal(
          (await request("/api/session", { cookie: adminCookie })).data.user.id,
          data.user.id,
        );
      },
    );
    await t.test("foreign-origin writes are rejected", async () => {
      const { response } = await request("/api/posts", {
        method: "POST",
        cookie: adminCookie,
        origin: "https://foreign.invalid",
        body: {
          type: "post",
          title: "forbidden",
          content: "",
          status: "draft",
        },
      });
      assert.equal(response.status, 403);
    });
    await t.test(
      "draft creation persists and stays out of the public site",
      async () => {
        const { response, data } = await request("/api/posts", {
          method: "POST",
          cookie: adminCookie,
          body: {
            type: "post",
            title: `Workflow ${suffix}`,
            slug: `workflow-${suffix}`,
            content: "<p>Persistent test content</p>",
            excerpt: "Test",
            status: "draft",
          },
        });
        assert.equal(response.status, 201, JSON.stringify(data));
        postId = data.post.id;
        assert.ok(postId);
        const read = await request(`/api/posts/${postId}`, {
          cookie: adminCookie,
        });
        assert.equal(read.data.post.title, `Workflow ${suffix}`);
        const site = await request("/api/public/site");
        assert.ok(
          !site.data.posts.some((p: { id: number }) => p.id === postId),
        );
        assert.equal(
          (await request(`/api/public/posts/workflow-${suffix}`)).response
            .status,
          404,
        );
      },
    );
    await t.test("invalid post status is rejected", async () => {
      const { response } = await request(`/api/posts/${postId}`, {
        method: "PUT",
        cookie: adminCookie,
        body: { status: "invented-status" },
      });
      assert.equal(response.status, 400);
    });
    await t.test(
      "publish sanitizes active HTML and renders the persistent post publicly",
      async () => {
        const { response, data } = await request(`/api/posts/${postId}`, {
          method: "PUT",
          cookie: adminCookie,
          body: {
            status: "publish",
            content:
              '<p onclick="alert(1)">Safe paragraph</p><script>alert(2)</script><a href="javascript:alert(3)">link</a>',
          },
        });
        assert.equal(response.status, 200, JSON.stringify(data));
        assert.ok(data.post.publishedAt);
        assert.equal(data.post.title, `Workflow ${suffix}`);
        assert.equal(data.post.excerpt, "Test");
        assert.equal(data.post.type, "post");
        assert.doesNotMatch(data.post.content, /<script|onclick|javascript:/i);
        assert.match(data.post.content, /Safe paragraph/);
        const site = await request(`/api/public/posts/workflow-${suffix}`);
        assert.equal(site.response.status, 200);
        assert.equal(site.data.post.id, postId);
      },
    );
    await t.test(
      "public settings exclude administrator contact details",
      async () => {
        const { data } = await request("/api/public/site");
        assert.equal(data.settings.adminEmail, undefined);
        assert.equal(typeof data.settings.siteTitle, "string");
        assert.ok(data.settings.siteTitle.length > 0);
      },
    );
    await t.test(
      "public pagination returns totals and rejects invalid pages",
      async () => {
        const { response, data } = await request("/api/public/site?page=1");
        assert.equal(response.status, 200);
        assert.equal(data.pagination.page, 1);
        assert.ok(data.pagination.totalPosts >= 1);
        assert.ok(data.pagination.totalPages >= 1);
        assert.ok(data.posts.length <= data.settings.postsPerPage);
        assert.equal(
          (await request("/api/public/site?page=0")).response.status,
          400,
        );
        assert.equal(
          (await request("/api/public/site?page=invalid")).response.status,
          400,
        );
      },
    );
    await t.test(
      "public comments await moderation before appearing",
      async () => {
        const submitted = await request("/api/public/comments", {
          method: "POST",
          body: {
            postId,
            authorName: `Tester ${suffix}`,
            authorEmail: "test@example.com",
            content: "Please moderate this comment.",
          },
        });
        assert.equal(
          submitted.response.status,
          201,
          JSON.stringify(submitted.data),
        );
        let detail = await request(`/api/public/posts/workflow-${suffix}`);
        assert.ok(
          !detail.data.comments.some(
            (c: { authorName: string }) => c.authorName === `Tester ${suffix}`,
          ),
        );
        const adminComments = await request("/api/comments", {
          cookie: adminCookie,
        });
        const comment = adminComments.data.comments.find(
          (c: { authorName: string }) => c.authorName === `Tester ${suffix}`,
        );
        assert.ok(comment);
        commentId = comment.id;
        assert.equal(comment.status, "pending");
        assert.equal(
          (
            await request(`/api/comments/${commentId}`, {
              method: "PUT",
              cookie: adminCookie,
              body: { status: "approved" },
            })
          ).response.status,
          200,
        );
        detail = await request(`/api/public/posts/workflow-${suffix}`);
        assert.ok(
          detail.data.comments.some((c: { id: number }) => c.id === commentId),
        );
      },
    );
    await t.test(
      "media upload stores an image with editable metadata",
      async () => {
        const form = new FormData();
        const png = Buffer.from(
          "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADElEQVQImWP4//8/AAX+Av5Y8msOAAAAAElFTkSuQmCC",
          "base64",
        );
        form.append(
          "file",
          new Blob([png], { type: "image/png" }),
          `test-${suffix}.png`,
        );
        const response = await fetch(`${base}/api/media`, {
          method: "POST",
          headers: { Cookie: adminCookie, Origin: origin },
          body: form,
        });
        const data = await response.json();
        assert.equal(response.status, 201, JSON.stringify(data));
        mediaId = data.media.id;
        assert.match(data.media.url, /^\/uploads\//);
        assert.equal((await fetch(`${base}${data.media.url}`)).status, 200);
        const updated = await request(`/api/media/${mediaId}`, {
          method: "PUT",
          cookie: adminCookie,
          body: { alt: "A tiny test image", title: "Test fixture" },
        });
        assert.equal(updated.data.media.alt, "A tiny test image");
      },
    );
    await t.test("active SVG uploads are rejected", async () => {
      const form = new FormData();
      form.append(
        "file",
        new Blob(
          [
            '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
          ],
          { type: "image/svg+xml" },
        ),
        "unsafe.svg",
      );
      const response = await fetch(`${base}/api/media`, {
        method: "POST",
        headers: { Cookie: adminCookie, Origin: origin },
        body: form,
      });
      assert.equal(response.status, 400);
    });
    await t.test(
      "new authors can create posts but cannot edit others or administer users",
      async () => {
        const created = await request("/api/users", {
          method: "POST",
          cookie: adminCookie,
          body: {
            username: `author-${suffix}`,
            email: `author-${suffix}@example.com`,
            displayName: "Integration Author",
            password,
            role: "author",
          },
        });
        assert.equal(
          created.response.status,
          201,
          JSON.stringify(created.data),
        );
        authorId = created.data.user.id;
        assert.equal(created.data.user.passwordHash, undefined);
        const login = await request("/api/auth/login", {
          method: "POST",
          body: { login: `author-${suffix}`, password },
        });
        assert.equal(login.response.status, 200);
        authorCookie = (login.response.headers.get("set-cookie") || "").split(
          ";",
        )[0];
        assert.equal(
          (await request("/api/users", { cookie: authorCookie })).response
            .status,
          403,
        );
        assert.equal(
          (await request("/api/posts?type=page", { cookie: authorCookie }))
            .response.status,
          403,
        );
        assert.equal(
          (
            await request("/api/posts", {
              method: "POST",
              cookie: authorCookie,
              body: { type: "page", title: "Forbidden page" },
            })
          ).response.status,
          403,
        );
        assert.equal(
          (
            await request("/api/settings", {
              method: "PUT",
              cookie: authorCookie,
              body: { siteTitle: "Forbidden" },
            })
          ).response.status,
          403,
        );
        assert.equal(
          (
            await request(`/api/posts/${postId}`, {
              method: "PUT",
              cookie: authorCookie,
              body: { title: "Forbidden" },
            })
          ).response.status,
          403,
        );
        const own = await request("/api/posts", {
          method: "POST",
          cookie: authorCookie,
          body: {
            type: "post",
            title: `Author ${suffix}`,
            content: "<p>Own content</p>",
            status: "draft",
          },
        });
        assert.equal(own.response.status, 201, JSON.stringify(own.data));
        await request(`/api/posts/${own.data.post.id}`, {
          method: "PUT",
          cookie: adminCookie,
          body: { status: "trash" },
        });
        assert.equal(
          (
            await request(`/api/posts/${own.data.post.id}`, {
              method: "DELETE",
              cookie: adminCookie,
            })
          ).response.status,
          200,
        );
      },
    );
    await t.test(
      "trash hides a published post and restore republishes it",
      async () => {
        assert.equal(
          (
            await request(`/api/posts/${postId}`, {
              method: "PUT",
              cookie: adminCookie,
              body: { status: "trash" },
            })
          ).response.status,
          200,
        );
        assert.equal(
          (await request(`/api/public/posts/workflow-${suffix}`)).response
            .status,
          404,
        );
        const trash = await request("/api/posts?type=post&status=trash", {
          cookie: adminCookie,
        });
        assert.ok(
          trash.data.posts.some((p: { id: number }) => p.id === postId),
        );
        assert.equal(
          (
            await request(`/api/posts/${postId}`, {
              method: "PUT",
              cookie: adminCookie,
              body: { status: "publish" },
            })
          ).response.status,
          200,
        );
        const restored = await request(`/api/public/posts/workflow-${suffix}`);
        assert.equal(restored.response.status, 200);
        assert.equal(restored.data.post.title, `Workflow ${suffix}`);
        assert.match(restored.data.post.content, /Safe paragraph/);
      },
    );
    await t.test("logout revokes the session in PostgreSQL", async () => {
      assert.equal(
        (
          await request("/api/auth/logout", {
            method: "POST",
            cookie: authorCookie,
          })
        ).response.status,
        200,
      );
      assert.equal(
        (await request("/api/session", { cookie: authorCookie })).data.user,
        null,
      );
    });
  } finally {
    if (commentId)
      await request(`/api/comments/${commentId}`, {
        method: "DELETE",
        cookie: adminCookie,
      });
    if (postId) {
      await request(`/api/posts/${postId}`, {
        method: "PUT",
        cookie: adminCookie,
        body: { status: "trash" },
      });
      await request(`/api/posts/${postId}`, {
        method: "DELETE",
        cookie: adminCookie,
      });
    }
    if (mediaId)
      await request(`/api/media/${mediaId}`, {
        method: "DELETE",
        cookie: adminCookie,
      });
    if (authorId)
      await request(`/api/users/${authorId}`, {
        method: "DELETE",
        cookie: adminCookie,
      });
    if (adminCookie)
      await request("/api/auth/logout", {
        method: "POST",
        cookie: adminCookie,
      });
  }
});
