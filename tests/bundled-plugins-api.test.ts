import "dotenv/config";
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { pool } from "../server/db.js";
after(async () => {
  await pool.end();
});
const base = process.env.TEST_API_URL || "http://127.0.0.1:3001",
  origin = process.env.APP_ORIGIN || "http://127.0.0.1:5173";
// This suite deliberately uses isolated credentials and never verifies a real key.
test(
  "bundled plugins persist source behavior while credentials stay out of all DTOs and archives",
  { skip: process.env.NODE_ENV !== "test" },
  async () => {
    const fakeKey = "fakeAkismetTest123456",
      email = "plugin-" + Date.now() + "@example.invalid";
    let cookie = "",
      postId: number | undefined;
    const requestIds: number[] = [];
    async function call(
      route: string,
      method = "GET",
      body?: unknown,
      authenticated = true,
    ) {
      const response = await fetch(base + "/api" + route, {
        method,
        headers: {
          Origin: origin,
          "Content-Type": "application/json",
          ...(authenticated && cookie ? { Cookie: cookie } : {}),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      return { response, data: await response.json() };
    }
    async function ok(
      route: string,
      method = "GET",
      body?: unknown,
      authenticated = true,
    ) {
      const result = await call(route, method, body, authenticated);
      assert.ok(
        result.response.ok,
        `${route}: ${result.response.status} ${JSON.stringify(result.data)}`,
      );
      return result.data;
    }
    try {
      const login = await call(
        "/auth/login",
        "POST",
        {
          login: process.env.ADMIN_EMAIL,
          password: process.env.ADMIN_PASSWORD,
        },
        false,
      );
      assert.equal(login.response.status, 200);
      cookie = (login.response.headers.get("set-cookie") || "").split(";")[0];
      assert.equal(
        (await call("/plugins", "GET", undefined, false)).response.status,
        401,
      );
      for (const slug of ["hello-dolly", "akismet"])
        await ok(`/plugins/${slug}/install`, "POST");
      assert.equal((await ok("/admin/plugin-notices")).helloDolly, null);
      await ok("/plugins/hello-dolly", "PUT", { enabled: true });
      const notice = (await ok("/admin/plugin-notices")).helloDolly;
      assert.equal(typeof notice.lyric, "string");
      assert.match(notice.attribution, /Jerry Herman/);
      assert.equal(
        (await call("/plugins/hello-dolly", "DELETE")).response.status,
        409,
      );
      await ok("/plugins/hello-dolly", "PUT", { enabled: false });
      assert.equal((await ok("/admin/plugin-notices")).helloDolly, null);
      const configured = await ok("/plugins/akismet", "PUT", {
        enabled: true,
        settings: { sendComments: false },
        apiKey: fakeKey,
      });
      assert.equal(configured.plugin.apiKeyConfigured, true);
      assert.equal(configured.plugin.keyVerified, false);
      assert.ok(!JSON.stringify(configured).includes(fakeKey));
      assert.equal(
        (await call("/plugins/akismet/verify", "POST", {})).response.status,
        409,
      );
      await ok("/plugins/akismet", "PUT", { apiKey: "" });
      assert.equal(
        (
          await pool.query(
            "SELECT api_key FROM extension_secrets WHERE slug='akismet'",
          )
        ).rows[0].api_key,
        fakeKey,
      );
      for (const route of ["/plugins", "/public/design", "/tools/export"]) {
        const data = await ok(route);
        assert.ok(!JSON.stringify(data).includes(fakeKey), route);
        if (route !== "/plugins")
          assert.ok(!JSON.stringify(data).includes("apiKeyHint"), route);
      }
      assert.equal(
        (
          await call("/plugins/akismet", "PUT", {
            settings: { sendComments: true, apiKey: fakeKey },
          })
        ).response.status,
        400,
      );
      await ok("/plugins/akismet", "PUT", { settings: { sendComments: true } });
      const post = (
        await ok("/posts", "POST", {
          type: "post",
          title: "Bundled plugin fixture",
          content: "A public test post",
          status: "publish",
          commentStatus: "open",
        })
      ).post;
      postId = post.id;
      const nativeTemplate=await ok("/public/templates/single?postId="+postId);
      assert.match(nativeTemplate.content,/akismet_comment_form_privacy_notice/);
      assert.match(nativeTemplate.content,/https:\/\/akismet.com\/privacy\//);
      const guide=await ok("/tools/privacy/policy-guide");
      assert.match(guide.sections.find((section:any)=>section.id==="comments").text.join(" "),/may be sent to Akismet/);
      assert.match(guide.sections.find((section:any)=>section.id==="retention").text.join(" "),/30 days/);
      const submitted = await ok(
        "/public/comments",
        "POST",
        {
          postId,
          authorName: "Plugin test reader",
          authorEmail: email,
          content: "An original useful comment",
        },
        false,
      );
      assert.equal(submitted.comment.status, "pending");
      const check = (
        await pool.query(
          "SELECT * FROM akismet_comment_checks WHERE comment_id=$1",
          [submitted.comment.id],
        )
      ).rows[0];
      assert.equal(check.verdict, "unavailable");
      assert.ok(check.user_ip);
      const exportRequest = (
        await ok("/tools/privacy/requests", "POST", {
          email,
          type: "export",
          sendConfirmation: false,
        })
      ).request;
      requestIds.push(exportRequest.id);
      await ok(
        `/tools/privacy/requests/${exportRequest.id}/export`,
        "POST",
        {},
      );
      const download = await ok(
        `/tools/privacy/requests/${exportRequest.id}/download`,
      );
      assert.equal(download.akismetChecks[0].commentId, submitted.comment.id);
      assert.ok(!JSON.stringify(download).includes(fakeKey));
      const eraseRequest = (
        await ok("/tools/privacy/requests", "POST", {
          email,
          type: "erase",
          sendConfirmation: false,
        })
      ).request;
      requestIds.push(eraseRequest.id);
      const erased = await ok(
        `/tools/privacy/requests/${eraseRequest.id}/erase`,
        "POST",
        {},
      );
      assert.equal(erased.result.akismetChecksRemoved, 1);
      assert.equal(
        (
          await pool.query(
            "SELECT comment_id FROM akismet_comment_checks WHERE comment_id=$1",
            [submitted.comment.id],
          )
        ).rowCount,
        0,
      );
      await ok("/plugins/akismet", "PUT", { clearApiKey: true });
      assert.equal(
        (
          await pool.query(
            "SELECT slug FROM extension_secrets WHERE slug='akismet'",
          )
        ).rowCount,
        0,
      );
    } finally {
      for (const slug of ["hello-dolly", "akismet"]) {
        await call(`/plugins/${slug}`, "PUT", { enabled: false });
        await call(`/plugins/${slug}`, "DELETE");
      }
      if (postId) {
        await call(`/posts/${postId}`, "PUT", {status:"trash"});
        await call(`/posts/${postId}`, "DELETE");
      }
      for (const id of requestIds)
        await call(`/tools/privacy/requests/${id}`, "DELETE");
      await pool.query("DELETE FROM mail_outbox WHERE recipient=$1", [email]);
      await call("/auth/logout", "POST", {});
    }
  },
);
