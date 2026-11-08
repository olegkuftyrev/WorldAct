import test, { after } from "./isolated-test.js";
import assert from "node:assert/strict";
import { pool, getSettings } from "../server/db.js";
import { moderateComment } from "../server/comment-policy.js";
import { approvalFixture } from "./comment-approval-fixtures.js";
after(() => pool.end());

test("only actual human post authors and moderators bypass ordinary policy, while plugins remain filters", async t => {
  const f = await approvalFixture("approval-actors");
  try {
    const author = await f.account("owner", "author"), editor = await f.account("moderator", "editor"), foreign = await f.account("foreign", "author"), subscriber = await f.account("reader");
    const post = await f.post(author.id);
    await f.ok("/api/settings", "PUT", { commentModeration: true, commentPreviouslyApproved: true, commentMaxLinks: 1, commentModerationKeys: "moderate-marker", disallowedCommentKeys: "discard-marker" });
    const content = '<p>moderate-marker discard-marker <a href="https://example.test/">A link</a></p>';
    let sequence = 0;
    const accepted = async (auth: string, values: Record<string,unknown> = {}) => { const result = await f.submit(post.id, { content: content + " case " + ++sequence, ...values }, auth); assert.equal(result.response.status, 201, JSON.stringify(result.data)); return result.data.comment; };
    await t.test("current admin, global editor and actual post author receive source approval", async () => {
      for (const auth of [f.admin, editor.auth, author.auth]) assert.equal((await accepted(auth)).status, "approved");
      assert.equal((await accepted(foreign.auth)).status, "trash");
      assert.equal((await accepted("", { authorName: f.adminUser.displayName, authorEmail: f.adminUser.email })).status, "trash", "claimed moderator email conveys no authority");
      const forged = await f.submit(post.id, { actor: { id: f.adminUser.id, role: "administrator" }, postAuthorId: f.adminUser.id });
      assert.equal(forged.response.status, 400);
    });
    await t.test("ordinary authenticated readers still obey each manual, keyword, link and disallowed control", async () => {
      await f.ok("/api/settings", "PUT", { commentPreviouslyApproved: false });
      assert.equal((await accepted(subscriber.auth, { content: "Manual moderation applies" })).status, "pending");
      await f.ok("/api/settings", "PUT", { commentModeration: false });
      assert.equal((await accepted(subscriber.auth, { content: "Only moderate-marker" })).status, "pending");
      assert.equal((await accepted(subscriber.auth, { content: 'Only <a href="https://example.test/">one link</a>' })).status, "pending");
      assert.equal((await accepted(subscriber.auth, { content: "Only discard-marker" })).status, "trash");
    });
    await t.test("the actual Spam Shield plugin still classifies an otherwise trusted approval", async () => {
      await f.ok("/api/plugins/spam-shield/install", "POST", {});
      await f.ok("/api/plugins/spam-shield", "PUT", { enabled: true, settings: { maxLinks: 1 } });
      const spam = await accepted(author.auth, { content: "discard-marker " + "x".repeat(20) }); assert.equal(spam.status, "spam");
      assert.equal((await pool.query("SELECT status FROM comments WHERE id=$1", [spam.id])).rows[0].status, "spam");
      await f.ok("/api/plugins/spam-shield", "PUT", { enabled: false });
    });
    await t.test("later Akismet filtering still holds a trusted human approval when configured but unverified", async () => {
      await f.ok("/api/plugins/akismet/install", "POST", {});
      await f.ok("/api/plugins/akismet", "PUT", { enabled: true, settings: { sendComments: true }, apiKey: "approvalfixtureunverifiedkey" });
      const held = await accepted(editor.auth, { content: "Trusted editor still reaches the separate filter" }); assert.equal(held.status, "pending");
      const check = (await pool.query("SELECT verdict FROM akismet_comment_checks WHERE comment_id=$1", [held.id])).rows[0]; assert.equal(check.verdict, "unavailable");
      assert.equal((await pool.query("SELECT verified_at FROM extension_secrets WHERE slug='akismet'")).rows[0].verified_at, null, "the unverified guard returns without any remote service call");
      await f.ok("/api/plugins/akismet", "PUT", { enabled: false, clearApiKey: true });
    });
    await t.test("typed pings cannot borrow trusted human actor or approved account history", async () => {
      await f.ok("/api/settings", "PUT", { commentModeration: true, disallowedCommentKeys: "", commentPreviouslyApproved: true });
      const settings = await getSettings();
      for (const type of ["pingback", "trackback"] as const) assert.equal(await moderateComment({ type, authorName: author.displayName, authorEmail: author.email, authorUrl: "https://source.example.test/", content: "Typed notification", ip: "127.0.0.1", actor: { id: f.adminUser.id, role: "administrator" }, postAuthorId: f.adminUser.id }, pool, settings), "pending");
    });
  } finally { await f.dispose(); }
});
