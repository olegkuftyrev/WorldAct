import "dotenv/config";
import assert from "node:assert/strict";
import { test } from "node:test";
import sharp from "sharp";
const base = process.env.TEST_API_URL || "http://127.0.0.1:3001",
  origin = process.env.APP_ORIGIN || "http://127.0.0.1:5173";
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
function cookie(response: Response) {
  return (response.headers.get("set-cookie") || "").split(";")[0];
}
test("site platform persistence, editing and extension lifecycles", async (t) => {
  const stamp = Date.now().toString(36),
    login = await api("/api/auth/login", "POST", {
      login: process.env.ADMIN_EMAIL,
      password: process.env.ADMIN_PASSWORD,
    });
  assert.equal(login.response.status, 200);
  const admin = cookie(login.response);
  let userId: number | undefined,
    postId: number | undefined,
    menuId: number | undefined,
    docId: number | undefined,
    mediaId: number | undefined;
  let tempCookie = "";
  let pluginOriginal: any;
  let pluginInstalled = false;
  let settingsOriginal: any;
  const importedIds: number[] = [];
  const importedTerms: number[] = [];
  try {
    await t.test(
      "platform endpoints enforce authentication and settings validation",
      async () => {
        for (const path of [
          "/api/profile",
          "/api/menus",
          "/api/plugins",
          "/api/site-editor",
          "/api/tools/export",
          "/api/tools/mail",
        ])
          assert.equal((await api(path)).response.status, 401, path);
        const current = await api("/api/settings", "GET", undefined, admin);
        assert.equal(current.response.status, 200);
        settingsOriginal = current.data.settings;
        assert.equal(
          (
            await api(
              "/api/settings",
              "PUT",
              { permalinkStructure: "javascript:bad" },
              admin,
            )
          ).response.status,
          400,
        );
        assert.equal(
          (await api("/api/settings", "PUT", { mediumWidth: 421 }, admin))
            .response.status,
          200,
        );
        assert.equal(
          (await api("/api/settings", "GET", undefined, admin)).data.settings
            .mediumWidth,
          421,
        );
        await api(
          "/api/settings",
          "PUT",
          { mediumWidth: settingsOriginal.mediumWidth },
          admin,
        );
      },
    );
    await t.test(
      "navigation menus persist and reject hierarchy cycles",
      async () => {
        const saved = await api(
          "/api/menus",
          "POST",
          {
            name: `QA menu ${stamp}`,
            location: "primary",
            items: [
              { id: "one", label: "Home", url: "/" },
              {
                id: "two",
                label: "Child",
                url: "/pages/sample-page",
                parentId: "one",
              },
            ],
          },
          admin,
        );
        assert.equal(saved.response.status, 201, JSON.stringify(saved.data));
        menuId = saved.data.menu.id;
        assert.ok(
          (await api("/api/menus", "GET", undefined, admin)).data.menus.some(
            (m: any) => m.id === menuId,
          ),
        );
        const invalid = await api(
          `/api/menus/${menuId}`,
          "PUT",
          {
            name: "Bad cycle",
            location: "primary",
            items: [
              { id: "one", label: "One", url: "/", parentId: "two" },
              { id: "two", label: "Two", url: "/", parentId: "one" },
            ],
          },
          admin,
        );
        assert.equal(invalid.response.status, 400);
        assert.equal(
          (
            await api(
              `/api/menus/${menuId}`,
              "PUT",
              {
                name: `QA edited ${stamp}`,
                location: "footer",
                items: [
                  { id: "one", label: "About", url: "/pages/sample-page" },
                ],
              },
              admin,
            )
          ).response.status,
          200,
        );
        const design = await api("/api/public/design");
        assert.ok(
          design.data.menus.some(
            (m: any) => m.id === menuId && m.location === "footer",
          ),
        );
      },
    );
    await t.test(
      "templates retain safe markup, blocks and version conflicts",
      async () => {
        const created = await api(
          "/api/site-editor/documents",
          "POST",
          {
            slug: `qa-pattern-${stamp}`,
            title: "QA pattern",
            type: "pattern",
            content:
              '<section><h2 style="color:#ff0000">Heading</h2><script>alert(1)</script></section>',
            blocks: [
              {
                name: "core/heading",
                attributes: { content: "Heading" },
                innerBlocks: [],
              },
            ],
          },
          admin,
        );
        assert.equal(
          created.response.status,
          201,
          JSON.stringify(created.data),
        );
        docId = created.data.document.id;
        assert.match(created.data.document.content, /<section>/);
        assert.doesNotMatch(created.data.document.content, /<script/);
        const payload = {
          slug: `qa-pattern-${stamp}`,
          title: "QA changed",
          type: "pattern",
          content: "<p>Saved</p>",
          blocks: [],
          version: created.data.document.version,
        };
        assert.equal(
          (
            await api(
              `/api/site-editor/documents/${docId}`,
              "PUT",
              payload,
              admin,
            )
          ).response.status,
          200,
        );
        assert.equal(
          (
            await api(
              `/api/site-editor/documents/${docId}`,
              "PUT",
              payload,
              admin,
            )
          ).response.status,
          409,
        );
      },
    );
    await t.test(
      "JavaScript plugin installation, activation, output and deletion safeguards",
      async () => {
        const registry = await api("/api/plugins", "GET", undefined, admin);
        pluginOriginal = registry.data.plugins.find(
          (p: any) => p.slug === "reading-time",
        );
        if (!pluginOriginal.installed) {
          assert.equal(
            (await api("/api/plugins/reading-time/install", "POST", {}, admin))
              .response.status,
            201,
          );
          pluginInstalled = true;
        }
        const activated = await api(
          "/api/plugins/reading-time",
          "PUT",
          { enabled: true, settings: { wordsPerMinute: 100 } },
          admin,
        );
        assert.equal(activated.response.status, 200);
        assert.equal(
          (await api("/api/plugins/reading-time", "DELETE", undefined, admin))
            .response.status,
          409,
        );
        const post = await api(
          "/api/posts",
          "POST",
          {
            type: "post",
            title: `QA plugin ${stamp}`,
            status: "publish",
            content: `<p>${"word ".repeat(250)}</p>`,
          },
          admin,
        );
        assert.equal(post.response.status, 201);
        postId = post.data.post.id;
        const detail = await api(`/api/public/posts/${post.data.post.slug}`);
        assert.equal(detail.data.post.readingTime, 3);
        await api(
          "/api/plugins/reading-time",
          "PUT",
          {
            enabled: pluginOriginal.enabled ?? false,
            settings: pluginOriginal.settings,
          },
          admin,
        );
        if (pluginInstalled) {
          assert.equal(
            (await api("/api/plugins/reading-time", "DELETE", undefined, admin))
              .response.status,
            200,
          );
          pluginInstalled = false;
        }
      },
    );
    await t.test(
      "profile editing, password checks and local reset tokens",
      async () => {
        const password = `QA-strong-${stamp}-password`,
          created = await api(
            "/api/users",
            "POST",
            {
              username: `platform-${stamp}`,
              email: `platform-${stamp}@example.com`,
              displayName: "Platform QA",
              password,
              role: "administrator",
            },
            admin,
          );
        assert.equal(created.response.status, 201);
        userId = created.data.user.id;
        const signed = await api("/api/auth/login", "POST", {
          login: `platform-${stamp}`,
          password,
        });
        tempCookie = cookie(signed.response);
        const profile = await api(
          "/api/profile",
          "PUT",
          {
            displayName: "QA renamed",
            bio: "<script>bad</script>Biography",
            website: "https://example.com",
            firstName: "Test",
          },
          tempCookie,
        );
        assert.equal(
          profile.response.status,
          200,
          JSON.stringify(profile.data),
        );
        assert.equal(profile.data.user.displayName, "QA renamed");
        assert.doesNotMatch(profile.data.user.bio, /<script/);
        assert.equal(
          (
            await api(
              "/api/profile",
              "PUT",
              { password: `${password}-new`, currentPassword: "wrong" },
              tempCookie,
            )
          ).response.status,
          400,
        );
        assert.equal(
          (
            await api(
              "/api/profile",
              "PUT",
              { password: `${password}-new`, currentPassword: password },
              tempCookie,
            )
          ).response.status,
          200,
        );
        const preferences = await api(
          "/api/preferences",
          "PUT",
          { collapsedMenu: true, hiddenWidgets: ["activity"] },
          tempCookie,
        );
        assert.equal(preferences.data.preferences.collapsedMenu, true);
        assert.equal(
          (
            await api("/api/auth/forgot-password", "POST", {
              login: `platform-${stamp}`,
            })
          ).response.status,
          200,
        );
        const outbox = await api("/api/tools/mail", "GET", undefined, admin),
          mail = outbox.data.messages.find(
            (m: any) => m.recipient === `platform-${stamp}@example.com`,
          );
        assert.ok(mail);
        const token = mail.body.match(/token=([a-f0-9]{64})/)[1];
        assert.equal(
          (
            await api("/api/auth/reset-password", "POST", {
              token,
              password: `${password}-reset`,
            })
          ).response.status,
          200,
        );
        assert.equal(
          (await api("/api/session", "GET", undefined, tempCookie)).data.user,
          null,
        );
        assert.equal(
          (
            await api("/api/auth/reset-password", "POST", {
              token,
              password: `${password}-again`,
            })
          ).response.status,
          400,
        );
        const newLogin = await api("/api/auth/login", "POST", {
          login: `platform-${stamp}`,
          password: `${password}-reset`,
        });
        assert.equal(newLogin.response.status, 200);
        tempCookie = cookie(newLogin.response);
        await api(`/api/tools/mail/${mail.id}`, "DELETE", undefined, admin);
      },
    );
    await t.test(
      "image editing persists resized dimensions and restores the original",
      async () => {
        const png = await sharp({
            create: {
              width: 300,
              height: 200,
              channels: 3,
              background: "#e04040",
            },
          })
            .png()
            .toBuffer(),
          form = new FormData();
        form.append(
          "file",
          new Blob([new Uint8Array(png)], { type: "image/png" }),
          "qa-image.png",
        );
        const uploaded = await fetch(base + "/api/media", {
            method: "POST",
            headers: { Cookie: admin, Origin: origin },
            body: form,
          }),
          data = await uploaded.json();
        assert.equal(uploaded.status, 201, JSON.stringify(data));
        mediaId = data.media.id;
        assert.equal(data.media.width, 300);
        assert.ok(data.media.sizes.thumbnail);
        assert.equal(
          data.media.sizes.thumbnail.width,
          settingsOriginal.thumbnailWidth,
        );
        if (settingsOriginal.uploadsYearMonth)
          assert.match(data.media.url, /\/uploads\/\d{4}\/\d{2}\//);
        const thumbnail = await fetch(base + data.media.sizes.thumbnail.url);
        assert.equal(thumbnail.status, 200);
        assert.equal(
          (await sharp(Buffer.from(await thumbnail.arrayBuffer())).metadata())
            .width,
          settingsOriginal.thumbnailWidth,
        );
        const edited = await api(
          `/api/media/${mediaId}/edit`,
          "POST",
          { width: 150, height: 100 },
          admin,
        );
        assert.equal(edited.response.status, 200, JSON.stringify(edited.data));
        assert.equal(edited.data.media.width, 150);
        assert.equal(edited.data.media.canRestore, true);
        const restored = await api(
          `/api/media/${mediaId}/restore`,
          "POST",
          {},
          admin,
        );
        assert.equal(restored.response.status, 200);
        assert.equal(restored.data.media.width, 300);
        assert.equal(restored.data.media.canRestore, false);
      },
    );
    await t.test("health and export omit credential hashes", async () => {
      assert.equal(
        (await api("/api/tools/health", "GET", undefined, admin)).data.status,
        "good",
      );
      const exported = await api("/api/tools/export", "GET", undefined, admin);
      assert.equal(exported.response.status, 200);
      assert.equal(exported.data.application, "WorldAct");
      assert.equal(exported.data.users, undefined);
      assert.ok(
        exported.data.posts.every((p: any) => p.password_hash === undefined),
      );
    });
    await t.test(
      "JSON portability preserves Gutenberg and hierarchy without publishing protected content",
      async () => {
        const raw =
          "<!-- wp:paragraph --><p>Portable blocks</p><!-- /wp:paragraph -->";
        const source = await api(
          "/api/posts",
          "POST",
          {
            title: `QA protected ${stamp}`,
            content: raw,
            status: "publish",
            password: "portable-secret",
            blocks: [
              {
                name: "core/paragraph",
                attributes: { content: "Portable blocks" },
                innerBlocks: [],
              },
            ],
          },
          admin,
        );
        assert.equal(source.response.status, 201, JSON.stringify(source.data));
        importedIds.push(source.data.post.id);
        const archive = await api("/api/tools/export", "GET", undefined, admin);
        const protectedPost = archive.data.posts.find(
          (p: any) => p.id === source.data.post.id,
        );
        assert.equal(protectedPost.status, "draft");
        assert.equal(protectedPost.passwordProtected, true);
        assert.equal(protectedPost.password_hash, undefined);
        assert.match(protectedPost.raw_content, /<!-- wp:paragraph -->/);
        protectedPost.created_at = "2020-02-03T04:05:06.000Z";
        protectedPost.updated_at = "2021-03-04T05:06:07.000Z";
        protectedPost.published_at = "2020-02-03T04:05:06.000Z";
        const payload = {
          application: "WorldAct",
          version: 2,
          posts: [
            protectedPost,
            {
              id: 2000001,
              type: "page",
              title: `QA parent ${stamp}`,
              slug: `qa-parent-${stamp}`,
              content: "<p>Parent</p>",
              status: "draft",
            },
            {
              id: 2000002,
              type: "page",
              title: `QA child ${stamp}`,
              slug: `qa-child-${stamp}`,
              parent_id: 2000001,
              content: "<p>Child</p>",
              status: "draft",
            },
          ],
          comments: [
            {
              id: 1,
              post_id: protectedPost.id,
              author_name: "Portable reader",
              author_email: "portable@example.test",
              content: "<p>Parent comment</p>",
              status: "approved",
            },
            {
              id: 2,
              post_id: protectedPost.id,
              parent_id: 1,
              author_name: "Portable reply",
              author_email: "portable@example.test",
              content: "<p>Reply</p>",
              status: "pending",
            },
          ],
        };
        const existingCategory = await api(
          "/api/terms",
          "POST",
          {
            taxonomy: "category",
            name: `QA retained ${stamp}`,
            slug: `qa-retained-${stamp}`,
          },
          admin,
        );
        assert.equal(existingCategory.response.status, 201);
        importedTerms.push(existingCategory.data.term.id);
        Object.assign(payload, {
          terms: [
            {
              id: 3000001,
              taxonomy: "category",
              name: "Imported existing",
              slug: `qa-retained-${stamp}`,
              parent_id: 3000002,
            },
            {
              id: 3000002,
              taxonomy: "category",
              name: `QA parent term ${stamp}`,
              slug: `qa-parent-term-${stamp}`,
            },
            {
              id: 3000003,
              taxonomy: "category",
              name: `QA child term ${stamp}`,
              slug: `qa-child-term-${stamp}`,
              parent_id: 3000002,
            },
          ],
        });
        const imported = await api("/api/tools/import", "POST", payload, admin);
        assert.equal(
          imported.response.status,
          201,
          JSON.stringify(imported.data),
        );
        importedIds.push(...imported.data.postIds);
        importedTerms.push(...imported.data.termIds);
        const taxonomy = await api(
          "/api/terms?taxonomy=category",
          "GET",
          undefined,
          admin,
        );
        assert.equal(
          taxonomy.data.terms.find(
            (term: any) => term.id === existingCategory.data.term.id,
          ).parentId,
          null,
        );
        const parentTerm = taxonomy.data.terms.find(
          (term: any) => term.slug === `qa-parent-term-${stamp}`,
        );
        assert.equal(
          taxonomy.data.terms.find(
            (term: any) => term.slug === `qa-child-term-${stamp}`,
          ).parentId,
          parentTerm.id,
        );
        assert.equal(imported.data.imported, 3);
        const restored = await api(
          `/api/posts/${imported.data.postIds[0]}`,
          "GET",
          undefined,
          admin,
        );
        assert.equal(restored.data.post.status, "draft");
        assert.match(restored.data.post.rawContent, /<!-- wp:paragraph -->/);
        assert.equal(restored.data.post.blocks[0].name, "core/paragraph");
        assert.equal(restored.data.post.createdAt, protectedPost.created_at);
        assert.equal(
          restored.data.post.publishedAt,
          protectedPost.published_at,
        );
        const child = await api(
          `/api/posts/${imported.data.postIds[2]}`,
          "GET",
          undefined,
          admin,
        );
        assert.equal(child.data.post.parentId, imported.data.postIds[1]);
        const comments = await api(
          `/api/comments?postId=${imported.data.postIds[0]}&status=all`,
          "GET",
          undefined,
          admin,
        );
        const ownComments = comments.data.comments.filter(
          (c: any) => c.postId === imported.data.postIds[0],
        );
        assert.equal(ownComments.length, 2);
        assert.ok(ownComments.some((c: any) => c.parentId));
        const invalid = await api(
          "/api/tools/import",
          "POST",
          {
            application: "WorldAct",
            version: 2,
            posts: [
              {
                id: 1,
                type: "page",
                title: "Cycle A",
                slug: `qa-cycle-a-${stamp}`,
                parent_id: 2,
                content: "",
              },
              {
                id: 2,
                type: "page",
                title: "Cycle B",
                slug: `qa-cycle-b-${stamp}`,
                parent_id: 1,
                content: "",
              },
            ],
          },
          admin,
        );
        assert.equal(invalid.response.status, 400);
      },
    );
  } finally {
    for (const record of importedIds) {
      await api(`/api/posts/${record}`, "PUT", { status: "trash" }, admin);
      await api(`/api/posts/${record}`, "DELETE", undefined, admin);
    }
    for (const term of importedTerms)
      await api(`/api/terms/${term}`, "DELETE", undefined, admin);
    if (postId) {
      await api(`/api/posts/${postId}`, "PUT", { status: "trash" }, admin);
      await api(`/api/posts/${postId}`, "DELETE", undefined, admin);
    }
    if (menuId) await api(`/api/menus/${menuId}`, "DELETE", undefined, admin);
    if (docId)
      await api(
        `/api/site-editor/documents/${docId}`,
        "DELETE",
        undefined,
        admin,
      );
    if (mediaId) await api(`/api/media/${mediaId}`, "DELETE", undefined, admin);
    if (userId) await api(`/api/users/${userId}`, "DELETE", undefined, admin);
    if (pluginOriginal) {
      await api(
        "/api/plugins/reading-time",
        "PUT",
        {
          enabled: pluginOriginal.enabled ?? false,
          settings: pluginOriginal.settings,
        },
        admin,
      );
      if (pluginInstalled)
        await api("/api/plugins/reading-time", "DELETE", undefined, admin);
    }
    await api("/api/auth/logout", "POST", undefined, admin);
  }
});
