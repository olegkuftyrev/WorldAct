import { test } from "./isolated-test.js";
import assert from "node:assert/strict";
import { pool } from "../server/db.js";
import { publishDuePosts } from "../server/core.js";
const base = process.env.TEST_API_URL || "http://127.0.0.1:3001",
  origin = process.env.APP_ORIGIN || "http://127.0.0.1:5173";
test("Core editorial workflows, scheduling, taxonomy and access isolation", async () => {
  let cookie = "";
  let priorPostFormat: string | undefined;
  const suffix = `core-${Date.now()}`;
  const posts: number[] = [],
    terms: number[] = [],
    users: number[] = [];
  async function call(
    path: string,
    method = "GET",
    body?: unknown,
    c = cookie,
  ) {
    const r = await fetch(base + "/api" + path, {
      method,
      headers: {
        Origin: origin,
        "Content-Type": "application/json",
        ...(c ? { Cookie: c } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const data = await r.json();
    return { r, data };
  }
  async function ok(path: string, method = "GET", body?: unknown, c = cookie) {
    const result = await call(path, method, body, c);
    assert.ok(
      result.r.ok,
      `${method} ${path} ${result.r.status}: ${JSON.stringify(result.data)}`,
    );
    return result;
  }
  try {
    const login = await ok(
      "/auth/login",
      "POST",
      { login: process.env.ADMIN_EMAIL, password: process.env.ADMIN_PASSWORD },
      "",
    );
    cookie = login.r.headers.get("set-cookie")!.split(";")[0];
    const category = (
      await ok("/terms", "POST", { taxonomy: "category", name: suffix })
    ).data.term;
    terms.push(category.id);
    const child = (
      await ok("/terms", "POST", {
        taxonomy: "category",
        name: suffix + " child",
        parentId: category.id,
      })
    ).data.term;
    terms.push(child.id);
    assert.equal(
      (await call("/terms/" + category.id, "PUT", { parentId: child.id })).r
        .status,
      400,
    );
    const tag = (
      await ok("/terms", "POST", { taxonomy: "tag", name: suffix + " tag" })
    ).data.term;
    terms.push(tag.id);
    assert.equal(
      (
        await call("/posts", "POST", {
          title: suffix + " invalid block",
          blocks: [
            { name: "core/image", attributes: { url: "javascript:alert(1)" } },
          ],
        })
      ).r.status,
      400,
    );
    const defaultCategory = (
      await ok("/terms?taxonomy=category")
    ).data.terms.find((term: { isDefault: boolean }) => term.isDefault);
    assert.ok(defaultCategory);
    assert.equal(
      (await call("/terms/" + defaultCategory.id, "DELETE")).r.status,
      409,
    );
    const p = (
      await ok("/posts", "POST", {
        title: suffix,
        slug: suffix,
        status: "publish",
        content:
          '<p style="color:#ff0000;padding:12px" onclick="x()">Initial</p><script>bad()</script>',
        blocks: [
          {
            name: "core/paragraph",
            attributes: { content: "Initial" },
            innerBlocks: [],
          },
        ],
        categoryIds: [category.id],
        tagIds: [tag.id],
      })
    ).data.post;
    posts.push(p.id);
    assert.equal(p.categoryIds[0], category.id);
    assert.equal(p.tagIds[0], tag.id);
    assert.match(p.content, /color:#ff0000/);
    assert.doesNotMatch(p.content, /onclick|script/);
    assert.equal(
      (
        await call("/posts/" + p.id, "PUT", {
          version: p.version,
          categoryIds: [tag.id],
        })
      ).r.status,
      400,
    );
    await ok("/posts/" + p.id + "/autosave", "PUT", {
      version: p.version,
      title: "Autosave-only",
      content: "<p>Never published</p>",
      blocks: [
        { name: "core/paragraph", attributes: { content: "Never published" } },
      ],
    });
    assert.equal(
      (await ok("/posts/" + p.id + "/autosave")).data.autosave.title,
      "Autosave-only",
    );
    const publicBefore = (await ok("/public/posts/" + p.slug)).data.post;
    assert.equal(publicBefore.title, suffix);
    assert.equal(publicBefore.blocks, undefined);
    const edit = (
      await ok("/posts/" + p.id, "PUT", {
        version: p.version,
        title: "Edited " + suffix,
        content:
          "<details open><summary>Read</summary><p>Changed</p></details>",
      })
    ).data.post;
    assert.equal(edit.version, p.version + 1);
    assert.deepEqual(
      edit.blocks,
      [],
      "HTML-only updates invalidate the previous block tree",
    );
    assert.equal(
      (
        await call("/posts/" + p.id, "PUT", {
          version: p.version,
          title: "Stale",
        })
      ).r.status,
      409,
    );
    assert.equal(
      (await ok("/posts/" + p.id + "/autosave")).data.autosave,
      null,
    );
    const revs = (await ok("/posts/" + p.id + "/revisions")).data.revisions;
    assert.equal(revs.length, 1);
    assert.equal(revs[0].title, suffix);
    const countBefore = revs.length;
    await ok("/posts/" + p.id, "PUT", { status: "draft" });
    assert.equal(
      (await ok("/posts/" + p.id + "/revisions")).data.revisions.length,
      countBefore,
    );
    const restored = (
      await ok(
        "/posts/" + p.id + "/revisions/" + revs[0].id + "/restore",
        "POST",
        {},
      )
    ).data.post;
    assert.equal(restored.title, suffix);
    assert.equal(restored.content, p.content);
    assert.equal(restored.status, "draft");
    assert.equal(
      (await ok("/posts/" + p.id + "/revisions")).data.revisions.length,
      2,
    );
    const current = (await ok("/posts/" + p.id)).data.post;
    const competing = await Promise.all([
      call("/posts/" + p.id, "PUT", {
        version: current.version,
        title: suffix + " first edit",
      }),
      call("/posts/" + p.id, "PUT", {
        version: current.version,
        title: suffix + " second edit",
      }),
    ]);
    assert.deepEqual(
      competing.map((result) => result.r.status).sort(),
      [200, 409],
    );
    await ok("/posts/" + p.id, "PUT", {
      status: "publish",
      password: "protected example",
    });
    const locked = (await ok("/public/posts/" + p.slug, "GET", undefined, ""))
      .data;
    assert.equal(locked.post.locked, true);
    assert.equal(locked.post.content, "");
    assert.equal(locked.post.blocks, undefined);
    assert.equal(
      (
        await call(
          "/public/posts/" + p.slug + "/unlock",
          "POST",
          { password: "wrong" },
          "",
        )
      ).r.status,
      403,
    );
    const unlocked = await ok(
      "/public/posts/" + p.slug + "/unlock",
      "POST",
      { password: "protected example" },
      "",
    );
    assert.equal(unlocked.data.post.locked, false);
    assert.ok(unlocked.data.post.content);
    const accessCookie = unlocked.r.headers.get("set-cookie")!.split(";")[0];
    assert.equal(
      (await ok("/public/posts/" + p.slug, "GET", undefined, accessCookie)).data
        .post.locked,
      false,
    );
    assert.equal(
      (
        await call(
          "/public/comments",
          "POST",
          {
            postId: p.id,
            authorName: "Tester",
            authorEmail: "test@example.com",
            content: "hello",
          },
          "",
        )
      ).r.status,
      403,
    );
    await ok("/posts/" + p.id, "PUT", {
      password: "",
      commentStatus: "closed",
    });
    assert.equal(
      (
        await call(
          "/public/comments",
          "POST",
          {
            postId: p.id,
            authorName: "Tester",
            authorEmail: "test@example.com",
            content: "hello",
          },
          "",
        )
      ).r.status,
      409,
    );
    const listing = (
      await ok("/posts?category=" + category.id + "&perPage=1&page=1")
    ).data;
    assert.equal(listing.posts[0].id, p.id);
    assert.equal(listing.pagination.perPage, 1);
    assert.equal(
      (await ok("/public/site?category=" + category.slug)).data.posts.some(
        (x: any) => x.id === p.id,
      ),
      true,
    );
    const future = (
      await ok("/posts", "POST", {
        title: suffix + " future",
        status: "future",
        scheduledAt: new Date(Date.now() + 60_000).toISOString(),
      })
    ).data.post;
    posts.push(future.id);
    assert.equal(
      (await call("/public/posts/" + future.slug, "GET", undefined, "")).r
        .status,
      404,
    );
    await publishDuePosts(new Date(Date.now() + 120_000), [future.id]);
    assert.equal(
      (await ok("/public/posts/" + future.slug)).data.post.status,
      "publish",
    );
    const page1 = (
      await ok("/posts", "POST", { type: "page", title: suffix + " parent" })
    ).data.post;
    posts.push(page1.id);
    const page2 = (
      await ok("/posts", "POST", {
        type: "page",
        title: suffix + " child",
        parentId: page1.id,
      })
    ).data.post;
    posts.push(page2.id);
    assert.equal(
      (await call("/posts/" + page1.id, "PUT", { type: "post" })).r.status,
      400,
    );
    assert.equal(
      (await call("/posts/" + page1.id, "PUT", { parentId: page2.id })).r
        .status,
      400,
    );
    priorPostFormat = (await ok("/settings")).data.settings.defaultPostFormat;
    await ok("/settings", "PUT", { defaultPostFormat: "quote" });
    const formatted = (
      await ok("/posts", "POST", { title: suffix + " formatted" })
    ).data.post;
    posts.push(formatted.id);
    assert.equal(formatted.format, "quote");
    assert.equal(
      (
        await ok("/posts/" + formatted.id, "PUT", {
          title: suffix + " formatted revised",
        })
      ).data.post.format,
      "quote",
    );
    await ok("/posts/" + formatted.id, "PUT", { format: "video" });
    const formatRevision = (await ok("/posts/" + formatted.id + "/revisions"))
      .data.revisions[0];
    assert.equal(formatRevision.metadata.format, "quote");
    assert.equal(
      (
        await ok(
          "/posts/" +
            formatted.id +
            "/revisions/" +
            formatRevision.id +
            "/restore",
          "POST",
          {},
        )
      ).data.post.format,
      "quote",
    );
    const formatPage = (
      await ok("/posts", "POST", {
        type: "page",
        title: suffix + " formatted page",
      })
    ).data.post;
    posts.push(formatPage.id);
    assert.equal(formatPage.format, "standard");
    assert.equal(
      (await call("/posts/" + formatted.id, "PUT", { format: "invented" })).r
        .status,
      400,
    );
    await ok("/settings", "PUT", { defaultPostFormat: priorPostFormat });
    priorPostFormat = undefined;
    const contrib = (
      await ok("/users", "POST", {
        username: suffix,
        email: suffix + "@example.com",
        displayName: "Contributor",
        password: "Test-contributor-password!",
        role: "contributor",
      })
    ).data.user;
    users.push(contrib.id);
    const cl = await ok(
      "/auth/login",
      "POST",
      { login: suffix, password: "Test-contributor-password!" },
      "",
    );
    const cc = cl.r.headers.get("set-cookie")!.split(";")[0];
    const pending = (
      await ok(
        "/posts",
        "POST",
        { title: suffix + " pending", status: "pending" },
        cc,
      )
    ).data.post;
    posts.push(pending.id);
    assert.equal(
      (await call("/posts/" + pending.id, "PUT", { status: "publish" }, cc)).r
        .status,
      403,
    );
    assert.equal(
      (await call("/posts/" + p.id, "GET", undefined, cc)).r.status,
      403,
    );
    assert.equal(
      (await call("/posts", "POST", { type: "page", title: "no" }, cc)).r
        .status,
      403,
    );
    assert.equal((await call("/media", "POST", {}, cc)).r.status, 403);
    await ok("/terms/" + category.id, "DELETE");
    terms.splice(terms.indexOf(category.id), 1);
    const recategorized = (await ok("/posts/" + p.id)).data.post;
    assert.equal(recategorized.categories[0].isDefault, undefined);
    assert.ok(recategorized.categories.length);
    assert.notEqual(recategorized.categoryIds[0], category.id);
  } finally {
    if (priorPostFormat !== undefined)
      await call("/settings", "PUT", { defaultPostFormat: priorPostFormat });
    if (posts.length)
      await pool.query("DELETE FROM posts WHERE id=ANY($1::int[])", [posts]);
    if (terms.length)
      await pool.query("DELETE FROM terms WHERE id=ANY($1::int[])", [terms]);
    if (users.length)
      await pool.query("DELETE FROM users WHERE id=ANY($1::int[])", [users]);
    await pool.end();
  }
});
