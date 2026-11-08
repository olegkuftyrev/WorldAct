import test, { after } from "./isolated-test.js";
import assert from "node:assert/strict";
import { pool } from "../server/db.js";
import { approvalFixture } from "./comment-approval-fixtures.js";
after(() => pool.end());

test("prior human approval follows exact guest identity and real registered account history", async t => {
  const f = await approvalFixture("approval-history"), post = await f.post(), email = f.stamp + "-exact@example.test";
  const accepted = async (values: Record<string,unknown> = {}, auth = "") => { await f.ageAdmissions(post.id); const result = await f.submit(post.id, values, auth); assert.equal(result.response.status, 201, JSON.stringify(result.data)); return result.data.comment; };
  try {
    await accepted({ authorName: "Exact guest", authorEmail: email });
    await accepted({ authorName: "Anonymous", authorEmail: email });
    await f.ok("/api/settings", "PUT", { commentPreviouslyApproved: true, requireCommentNameEmail: false });
    await t.test("name and normalized email must both be present and match a human predecessor", async () => {
      assert.equal((await accepted({ authorName: "Exact guest", authorEmail: email.toUpperCase() })).status, "approved");
      for (const values of [{ authorName: "Changed guest", authorEmail: email }, { authorName: "", authorEmail: email }, { authorName: "Exact guest", authorEmail: "" }, { authorName: "", authorEmail: "" }])
        assert.equal((await accepted(values)).status, "pending");
    });
    await t.test("new registration cannot inherit an unrelated guest's approval by claiming that address", async () => {
      const registered = await f.account("new-registration", "subscriber", email);
      const guest = await accepted({ authorName: "Exact guest", authorEmail: email }); assert.equal(guest.status, "pending");
      assert.equal((await accepted({}, registered.auth)).status, "pending");
      assert.equal((await pool.query("SELECT user_id FROM comments WHERE id=$1", [guest.id])).rows[0].user_id, null);
    });
    await t.test("account approval survives actual admin email/name updates and does not authenticate a claimant", async () => {
      const user = await f.account("established");
      await f.ok("/api/settings", "PUT", { commentPreviouslyApproved: false });
      const first = await accepted({}, user.auth); assert.equal(first.status, "approved");
      const nextEmail = f.stamp + "-changed@example.test";
      await f.ok("/api/users/" + user.id, "PUT", { email: nextEmail, displayName: "Changed account name" });
      await f.ok("/api/settings", "PUT", { commentPreviouslyApproved: true });
      const next = await accepted({}, user.auth); assert.equal(next.status, "approved");
      const row = (await pool.query("SELECT author_email,author_name,user_id FROM comments WHERE id=$1", [next.id])).rows[0];
      assert.deepEqual(row, { author_email: nextEmail, author_name: "Changed account name", user_id: user.id });
      const claimant = await accepted({ authorName: "Claimed account email", authorEmail: nextEmail }); assert.equal(claimant.status, "approved", "source email lookup can satisfy history, never authentication");
      assert.equal((await pool.query("SELECT user_id FROM comments WHERE id=$1", [claimant.id])).rows[0].user_id, null);
      assert.equal((await accepted({ authorName: "Changed account name", authorEmail: f.stamp + "-unrelated@example.test" })).status, "pending");
    });
    await t.test("approved notification rows never establish human account or guest history", async () => {
      const user = await f.account("only-pings"), guestEmail = f.stamp + "-ping-guest@example.test";
      await pool.query("INSERT INTO comments(post_id,type,author_name,author_email,author_url,content,status,user_id) VALUES($1,'pingback',$2,$3,'https://ping.example.test/account/','Ping history','approved',$4),($1,'trackback','Ping guest',$5,'https://ping.example.test/guest/','Trackback history','approved',NULL)", [post.id,user.displayName,user.email,user.id,guestEmail]);
      assert.equal((await accepted({}, user.auth)).status, "pending");
      assert.equal((await accepted({ authorName: "Ping guest", authorEmail: guestEmail })).status, "pending");
    });
    await t.test("public DTOs and private aliases remain email-free", async () => {
      for (const route of ["/api/public/posts/" + post.slug, "/wp-json/wp/v2/comments?post=" + post.id]) {
        const data = await f.ok(route, "GET", undefined, ""); const serialized = JSON.stringify(data);
        assert.doesNotMatch(serialized, /authorEmail|_authorEmail|author_email|user_email/); assert.ok(!serialized.includes(email));
      }
    });
  } finally { await f.dispose(); }
});
