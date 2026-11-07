import "dotenv/config";
import assert from "node:assert/strict";
import test from "node:test";
import sharp from "sharp";
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
test("account deletion reassigns or removes posts, reusable entities and stored media atomically", async () => {
  const stamp = Date.now().toString(36);
  const login = await api("/api/auth/login", "POST", {
    login: process.env.ADMIN_EMAIL,
    password: process.env.ADMIN_PASSWORD,
  });
  assert.equal(login.response.status, 200);
  const admin = cookieOf(login.response),
    users: number[] = [],
    posts: number[] = [],
    patterns: number[] = [],
    media: number[] = [],
    sessions: string[] = [];
  let initialImageSettings: { siteLogoId: number; siteIconId: number } | undefined;
  let reassignedMediaId: number | undefined;
  try {
    const currentSettings = (await api("/api/settings", "GET", undefined, admin)).data.settings;
    initialImageSettings = { siteLogoId: 0, siteIconId: 0 };
    for (const key of ["siteLogoId", "siteIconId"] as const) {
      const selected = currentSettings[key] || 0;
      if (selected && (await api(`/api/media/${selected}`, "GET", undefined, admin)).response.status === 200)
        initialImageSettings[key] = selected;
    }
    const png = await sharp({
      create: { width: 8, height: 8, channels: 3, background: "#336699" },
    }).png().toBuffer();
    for (const mode of ["reassign", "delete"] as const) {
      const created = await api(
        "/api/users",
        "POST",
        {
          username: `owner-${mode}-${stamp}`,
          email: `owner-${mode}-${stamp}@example.test`,
          password: `Safe-owner-${stamp}-password`,
          displayName: "Temporary editor",
          role: "editor",
        },
        admin,
      );
      assert.equal(created.response.status, 201);
      users.push(created.data.user.id);
      const signedIn = await api("/api/auth/login", "POST", {
        login: created.data.user.username,
        password: `Safe-owner-${stamp}-password`,
      });
      assert.equal(signedIn.response.status, 200);
      const owner = cookieOf(signedIn.response);
      sessions.push(owner);
      const post = await api(
        "/api/posts",
        "POST",
        {
          title: `Owner QA ${mode} ${stamp}`,
          content: "<p>Owned post</p>",
          status: "draft",
        },
        owner,
      );
      assert.equal(post.response.status, 201);
      posts.push(post.data.post.id);
      const pattern = await api(
        "/wp-json/wp/v2/blocks",
        "POST",
        {
          title: `Owner pattern ${mode} ${stamp}`,
          content:
            "<!-- wp:paragraph --><p>Reusable owner content</p><!-- /wp:paragraph -->",
          status: "publish",
        },
        owner,
      );
      assert.equal(pattern.response.status, 201, JSON.stringify(pattern.data));
      patterns.push(pattern.data.id);
      const form = new FormData();
      form.append(
        "file",
        new Blob([new Uint8Array(png)], { type: "image/png" }),
        "owner-image.png",
      );
      const uploaded = await fetch(base + "/api/media", {
        method: "POST",
        headers: { Cookie: owner, Origin: origin },
        body: form,
      });
      const image = (await uploaded.json()).media;
      assert.equal(uploaded.status, 201);
      media.push(image.id);
      const imageHistory = [image];
      for (const operation of [{ rotate: 90 }, { flop: true }]) {
        const edited = await api(
          `/api/media/${image.id}/edit`,
          "POST",
          operation,
          owner,
        );
        assert.equal(edited.response.status, 200, JSON.stringify(edited.data));
        assert.notEqual(edited.data.media.url, imageHistory.at(-1).url);
        imageHistory.push(edited.data.media);
      }
      const latestImage = imageHistory.at(-1);
      assert.equal(latestImage.canRestore, true);
      assert.ok(Object.values(latestImage.derivatives).includes(image.filename));
      assert.ok(
        Object.values(latestImage.derivatives).includes(imageHistory[1].filename),
      );
      // Published content may still reference any original, edit, or size URL.
      // Account deletion must remove the complete stored history, not only the
      // latest image filename and its current sizes.
      const storedImageUrls = new Set<string>(
        imageHistory.flatMap((item) => [
          item.url,
          ...Object.values(item.sizes || {}).map((size: any) => size.url),
          ...Object.values(item.derivatives || {}).map(
            (filename) => `/uploads/${filename}`,
          ),
        ]),
      );
      for (const url of storedImageUrls)
        assert.equal((await fetch(base + url)).status, 200, url);
      const selectedImage = await api("/api/settings", "PUT", {
        siteLogoId: image.id, siteIconId: image.id,
      }, admin);
      assert.equal(selectedImage.response.status, 200);
      const removed = await api(
        `/api/users/${created.data.user.id}?${mode === "delete" ? "deleteContent=true" : "reassignTo=" + login.data.user.id}`,
        "DELETE",
        undefined,
        admin,
      );
      assert.equal(removed.response.status, 200, JSON.stringify(removed.data));
      assert.equal(
        (await api("/api/session", "GET", undefined, owner)).data.user,
        null,
      );
      const imageSettings = (await api("/api/settings", "GET", undefined, admin)).data.settings;
      assert.equal(imageSettings.siteLogoId, mode === "delete" ? 0 : image.id);
      assert.equal(imageSettings.siteIconId, mode === "delete" ? 0 : image.id);
      if (mode === "reassign") {
        reassignedMediaId = image.id;
        assert.equal(
          (
            await api(
              `/api/posts/${post.data.post.id}`,
              "GET",
              undefined,
              admin,
            )
          ).data.post.authorId,
          login.data.user.id,
        );
        assert.equal(
          (
            await api(
              `/wp-json/wp/v2/blocks/${pattern.data.id}?context=edit`,
              "GET",
              undefined,
              admin,
            )
          ).data.author,
          login.data.user.id,
        );
        assert.equal(
          (await api(`/api/media/${image.id}`, "GET", undefined, admin)).data
            .media.authorId,
          login.data.user.id,
        );
        for (const url of storedImageUrls)
          assert.equal((await fetch(base + url)).status, 200, url);
      } else {
        assert.equal(
          (
            await api(
              `/api/posts/${post.data.post.id}`,
              "GET",
              undefined,
              admin,
            )
          ).response.status,
          404,
        );
        assert.equal(
          (
            await api(
              `/wp-json/wp/v2/blocks/${pattern.data.id}`,
              "GET",
              undefined,
              admin,
            )
          ).response.status,
          404,
        );
        assert.equal(
          (await api(`/api/media/${image.id}`, "GET", undefined, admin))
            .response.status,
          404,
        );
        for (const url of storedImageUrls)
          assert.equal((await fetch(base + url)).status, 404, url);
      }
    }
    const extraImage = new FormData();
    extraImage.append("file", new Blob([new Uint8Array(png)], { type: "image/png" }), "separate-icon.png");
    const uploadedIcon = await fetch(base + "/api/media", {
      method: "POST", headers: { Cookie: admin, Origin: origin }, body: extraImage,
    });
    assert.equal(uploadedIcon.status, 201);
    const icon = (await uploadedIcon.json()).media;
    media.push(icon.id);
    assert.ok(reassignedMediaId);
    assert.equal((await api("/api/settings", "PUT", {
      siteLogoId: reassignedMediaId, siteIconId: icon.id,
    }, admin)).response.status, 200);
    assert.equal((await api(`/api/media/${reassignedMediaId}`, "DELETE", undefined, admin)).response.status, 200);
    const afterLogoDeletion = (await api("/api/settings", "GET", undefined, admin)).data.settings;
    assert.equal(afterLogoDeletion.siteLogoId, 0);
    assert.equal(afterLogoDeletion.siteIconId, icon.id, "Deleting the logo must retain the unrelated icon.");
    assert.equal((await api(`/api/media/${icon.id}`, "DELETE", undefined, admin)).response.status, 200);
    const afterIconDeletion = (await api("/api/settings", "GET", undefined, admin)).data.settings;
    assert.equal(afterIconDeletion.siteLogoId, 0);
    assert.equal(afterIconDeletion.siteIconId, 0);
  } finally {
    const restoredSettings = initialImageSettings
      ? await api("/api/settings", "PUT", initialImageSettings, admin)
      : null;
    for (const id of posts) {
      await api(`/api/posts/${id}`, "PUT", { status: "trash" }, admin);
      await api(`/api/posts/${id}`, "DELETE", undefined, admin);
    }
    for (const id of patterns)
      await api(
        `/wp-json/wp/v2/blocks/${id}?force=true`,
        "DELETE",
        undefined,
        admin,
      );
    for (const id of media)
      await api(`/api/media/${id}`, "DELETE", undefined, admin);
    for (const session of sessions)
      await api("/api/auth/logout", "POST", undefined, session);
    for (const id of users)
      await api(`/api/users/${id}`, "DELETE", undefined, admin);
    await api("/api/auth/logout", "POST", undefined, admin);
    if (restoredSettings) assert.equal(restoredSettings.response.status, 200);
  }
});
