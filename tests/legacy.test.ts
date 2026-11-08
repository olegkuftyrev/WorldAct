import test from "./isolated-test.js";
import assert from "node:assert/strict";
const base = process.env.TEST_API_URL || "http://127.0.0.1:3001";
test("legacy CMS URLs redirect to equivalent React screens without executing PHP", async () => {
  for (const [path, target] of [
    ["/wp-admin", "/admin"],
    ["/wp-admin/", "/admin"],
    ["/wp-login.php", "/login"],
    ["/wp-login.php?action=register", "/register"],
    ["/wp-login.php?action=lostpassword", "/lost-password"],
    ["/wp-login.php?redirect_to=https://example.test", "/login"],
    [
      "/wp-admin/edit.php?post_type=page&post_status=draft&s=Hello&m=202611",
      "/admin/pages?search=Hello&status=draft&month=2026-11",
    ],
    ["/wp-admin/post-new.php?post_type=page", "/admin/pages/new"],
    ["/wp-admin/post.php?post=2&action=edit", "/admin/content/2"],
    ["/wp-admin/options-permalink.php", "/admin/settings?tab=permalinks"],
    ["/wp-admin/options-privacy.php", "/admin/settings?tab=privacy"],
    [
      "/wp-admin/edit-comments.php?comment_status=moderated",
      "/admin/comments?status=pending",
    ],
    [
      "/wp-admin/tools.php?page=export_personal_data",
      "/admin/tools?tab=privacy-export",
    ],
    [
      "/wp-admin/tools.php?page=remove_personal_data",
      "/admin/tools?tab=privacy-erase",
    ],
    ["/wp-admin/edit-tags.php?taxonomy=post_tag", "/admin/posts/tags"],
  ]) {
    const response = await fetch(base + path, { redirect: "manual" });
    assert.equal(response.status, 302, path);
    assert.equal(response.headers.get("location"), target, path);
  }
});
