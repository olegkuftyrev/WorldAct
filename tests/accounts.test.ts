import "dotenv/config";
import assert from "node:assert/strict";
import { test } from "node:test";
import { createHash, randomBytes } from "node:crypto";
import { pool } from "../server/db.js";
const base = process.env.TEST_API_URL || "http://127.0.0.1:3001",
  origin = process.env.APP_ORIGIN || "http://127.0.0.1:5173";
// Only the local outbox is exercised. Never send account/privacy mail through SMTP in tests.
const smtpActive =
  !!process.env.SMTP_HOST &&
  process.env.WORLDACT_MAIL_MODE !== "outbox" &&
  process.env.NODE_ENV !== "test";
test(
  "membership, verified personal-data export and idempotent erasure",
  { skip: smtpActive },
  async (t) => {
    const stamp = "accounts-" + Date.now(),
      email = stamp + "@example.invalid";
    let admin = "",
      member = "",
      userId: number | undefined,
      postId: number | undefined,
      settingsBefore:
        | { usersCanRegister: boolean; defaultRole: string }
        | undefined;
    const requests: number[] = [];
    let exportId = 0,
      exportToken = "",
      exportData: any;
    async function call(
      path: string,
      method = "GET",
      body?: unknown,
      cookie = admin,
      requestOrigin = origin,
    ) {
      const response = await fetch(base + "/api" + path, {
        method,
        headers: {
          Origin: requestOrigin,
          "Content-Type": "application/json",
          ...(cookie ? { Cookie: cookie } : {}),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const data = await response.json();
      return { response, data };
    }
    async function ok(
      path: string,
      method = "GET",
      body?: unknown,
      cookie = admin,
    ) {
      const result = await call(path, method, body, cookie);
      assert.ok(
        result.response.ok,
        `${method} ${path}: ${result.response.status} ${JSON.stringify(result.data)}`,
      );
      return result;
    }
    async function newestToken(subject: string, expression: RegExp) {
      const mail = (
        await pool.query(
          "SELECT id,body,delivered FROM mail_outbox WHERE lower(recipient)=lower($1) AND subject=$2 ORDER BY id DESC LIMIT 1",
          [email, subject],
        )
      ).rows[0];
      assert.ok(mail);
      assert.equal(mail.delivered, false);
      const token = mail.body.match(expression)?.[1];
      assert.ok(
        token,
        "Expected a private token only in the local email outbox.",
      );
      return token as string;
    }
    async function create(type: "export" | "erase", sendConfirmation = true) {
      const row = (
        await ok("/tools/privacy/requests", "POST", {
          email,
          type,
          sendConfirmation,
        })
      ).data.request;
      requests.push(row.id);
      return row;
    }
    async function historicalArtifact(alias: string, data: unknown) {
      const token = randomBytes(32).toString("hex");
      const row = (
        await pool.query(
          "INSERT INTO privacy_requests(email,type,status,confirmed_at,completed_at,download_token_hash,download_expires_at,export_data) VALUES($1,'export','completed',now(),now(),$2,now()+interval '3 days',$3::jsonb) RETURNING id",
          [
            alias,
            createHash("sha256").update(token).digest("hex"),
            JSON.stringify(data),
          ],
        )
      ).rows[0];
      requests.push(row.id);
      return { token, id: row.id };
    }
    try {
      const login = await ok(
        "/auth/login",
        "POST",
        {
          login: process.env.ADMIN_EMAIL,
          password: process.env.ADMIN_PASSWORD,
        },
        "",
      );
      admin = (login.response.headers.get("set-cookie") || "").split(";")[0];
      assert.ok(admin);
      const settings = (await ok("/settings")).data.settings;
      settingsBefore = {
        usersCanRegister: settings.usersCanRegister,
        defaultRole: settings.defaultRole,
      };
      await t.test(
        "registration is disabled by default and settings are administrator protected",
        async () => {
          await ok("/settings", "PUT", { usersCanRegister: false });
          assert.equal(
            (await ok("/auth/registration", "GET", undefined, "")).data.enabled,
            false,
          );
          assert.equal(
            (
              await call(
                "/auth/register",
                "POST",
                { username: stamp, email },
                "",
              )
            ).response.status,
            403,
          );
          assert.equal(
            (await call("/settings", "PUT", { usersCanRegister: true }, ""))
              .response.status,
            401,
          );
          for (const path of [
            "/tools/privacy/requests",
            "/tools/privacy/requests/1",
            "/tools/privacy/requests/1/download",
          ])
            assert.equal(
              (await call(path, "GET", undefined, "")).response.status,
              401,
              path,
            );
        },
      );
      await t.test(
        "registration uses the configured role, keeps the user logged out and sets a password by a single-use emailed link",
        async () => {
          await ok("/settings", "PUT", {
            usersCanRegister: true,
            defaultRole: "contributor",
          });
          assert.equal(
            (await ok("/auth/registration", "GET", undefined, "")).data.enabled,
            true,
          );
          const registered = await ok(
            "/auth/register",
            "POST",
            { username: stamp, email },
            "",
          );
          assert.equal(registered.response.status, 201);
          assert.equal(registered.response.headers.get("set-cookie"), null);
          assert.equal(registered.data.delivery, "local-outbox");
          assert.doesNotMatch(
            JSON.stringify(registered.data),
            /token|password_hash|scrypt|userId/,
          );
          const user = (
            await pool.query(
              "SELECT id,role FROM users WHERE lower(email)=lower($1)",
              [email],
            )
          ).rows[0];
          userId = user.id;
          assert.equal(user.role, "contributor");
          assert.equal(
            (await call("/session", "GET", undefined, "")).data.user,
            null,
          );
          assert.equal(
            (
              await call(
                "/auth/register",
                "POST",
                {
                  username: stamp.toUpperCase(),
                  email: stamp + "-other@example.invalid",
                },
                "",
              )
            ).response.status,
            409,
          );
          assert.equal(
            (
              await call(
                "/auth/register",
                "POST",
                { username: stamp + "-duplicate", email: email.toUpperCase() },
                "",
              )
            ).response.status,
            409,
          );
          assert.equal(
            (
              await call(
                "/auth/register",
                "POST",
                {
                  username: stamp + "-role",
                  email: stamp + "-role@example.invalid",
                  role: "administrator",
                },
                "",
              )
            ).response.status,
            400,
          );
          const token = await newestToken(
            "Set your WorldAct password",
            /\/reset-password\?token=([a-f0-9]{64})/,
          );
          const stored = (
            await pool.query(
              "SELECT token_hash FROM password_resets WHERE user_id=$1",
              [userId],
            )
          ).rows[0];
          assert.equal(
            stored.token_hash,
            createHash("sha256").update(token).digest("hex"),
          );
          assert.notEqual(stored.token_hash, token);
          const password = "Accounts-test-" + stamp + "!";
          await ok("/auth/reset-password", "POST", { token, password }, "");
          assert.equal(
            (
              await call(
                "/auth/reset-password",
                "POST",
                { token, password },
                "",
              )
            ).response.status,
            400,
          );
          const signedIn = await ok(
            "/auth/login",
            "POST",
            { login: stamp, password },
            "",
          );
          member = (signedIn.response.headers.get("set-cookie") || "").split(
            ";",
          )[0];
          assert.equal(signedIn.data.user.id, userId);
          assert.equal(signedIn.data.user.role, "contributor");
          assert.equal(
            (await call("/tools/privacy/requests", "GET", undefined, member))
              .response.status,
            403,
          );
          const created = (
            await ok(
              "/posts",
              "POST",
              {
                title: stamp + " retained post",
                content: "Authored content remains after erasure.",
                status: "draft",
              },
              member,
            )
          ).data.post;
          postId = created.id;
          await pool.query(
            "UPDATE users SET profile=$2::jsonb,preferences=$3::jsonb WHERE id=$1",
            [
              userId,
              JSON.stringify({
                firstName: "Personal first name",
                lastName: "Personal last name",
                bio: "Personal profile text",
                website: "https://example.invalid/profile",
                apiToken: "PRIVATE_PROFILE_SECRET",
              }),
              JSON.stringify({ secret: "PRIVATE_PREFERENCE_SECRET" }),
            ],
          );
          await pool.query(
            `INSERT INTO comments(post_id,author_name,author_email,author_url,user_id,content,status) VALUES($1,'Personal author',$2,'https://example.invalid/author',$3,'First personal comment','approved'),($1,'Linked previous email','previous-'||$2,'https://example.invalid/previous',$3,'Linked account comment','pending'),($1,'Unrelated author','unrelated-'||$2,'https://example.invalid/untouched',NULL,'Unrelated comment stays unchanged','approved')`,
            [postId, email, userId],
          );
        },
      );
      await t.test(
        "email confirmation has a read-only preview, rotation, expiration and single-use processing",
        async () => {
          const row = await create("export");
          exportId = row.id;
          assert.equal(row.status, "pending");
          assert.equal(row.hasExport, false);
          assert.equal(row.confirmedAt, null);
          assert.equal(row.confirmation_token_hash, undefined);
          assert.equal(
            (
              await call(
                "/tools/privacy/requests/" + row.id + "/export",
                "POST",
                {},
              )
            ).response.status,
            409,
          );
          assert.equal(
            (
              await call(
                "/tools/privacy/requests/" + row.id + "/erase",
                "POST",
                {},
              )
            ).response.status,
            400,
          );
          assert.equal(
            (
              await call(
                "/tools/privacy/requests/" + row.id + "/export",
                "POST",
                {},
                member,
              )
            ).response.status,
            403,
          );
          assert.equal(
            (
              await call("/tools/privacy/requests", "POST", {
                email,
                type: "export",
              })
            ).response.status,
            409,
          );
          const token = await newestToken(
            "Confirm your WorldAct personal data export request",
            /\/privacy\/confirm\?token=([a-f0-9]{64})/,
          );
          const stored = (
            await pool.query(
              "SELECT confirmation_token_hash FROM privacy_requests WHERE id=$1",
              [row.id],
            )
          ).rows[0];
          assert.equal(
            stored.confirmation_token_hash,
            createHash("sha256").update(token).digest("hex"),
          );
          const preview = (
            await ok("/privacy/confirm?token=" + token, "GET", undefined, "")
          ).data;
          assert.equal(preview.request.type, "export");
          assert.equal(preview.request.status, "pending");
          assert.doesNotMatch(
            JSON.stringify(preview),
            new RegExp(email.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
          );
          assert.equal(
            (await ok("/tools/privacy/requests/" + row.id)).data.request.status,
            "pending",
          );
          assert.equal(
            (
              await call(
                "/privacy/confirm",
                "POST",
                { token },
                "",
                "https://foreign.invalid",
              )
            ).response.status,
            403,
          );
          await ok("/privacy/confirm", "POST", { token }, "");
          assert.equal(
            (await call("/privacy/confirm", "POST", { token }, "")).response
              .status,
            409,
          );
          assert.equal(
            (await ok("/tools/privacy/requests/" + row.id)).data.request.status,
            "confirmed",
          );
        },
      );
      await t.test(
        "exports are scoped, sanitized of credentials and downloadable only by an administrator or a private expiring token",
        async () => {
          const exported = (
            await ok(
              "/tools/privacy/requests/" + exportId + "/export",
              "POST",
              {},
            )
          ).data;
          assert.equal(exported.request.status, "completed");
          assert.equal(exported.request.hasExport, true);
          assert.equal(exported.request.result.accountsExported, 1);
          assert.equal(exported.request.result.commentsExported, 2);
          assert.ok(exported.downloadUrl);
          exportToken = new URL(exported.downloadUrl).searchParams.get(
            "token",
          )!;
          assert.match(exportToken, /^[a-f0-9]{64}$/);
          const downloaded = await ok(
            "/privacy/download?token=" + exportToken,
            "GET",
            undefined,
            "",
          );
          exportData = downloaded.data;
          assert.match(
            downloaded.response.headers.get("content-disposition") || "",
            /attachment/,
          );
          assert.match(
            downloaded.response.headers.get("cache-control") || "",
            /no-store/,
          );
          assert.equal(exportData.accounts.length, 1);
          assert.equal(exportData.accounts[0].id, userId);
          assert.equal(
            exportData.accounts[0].profile.firstName,
            "Personal first name",
          );
          assert.equal(exportData.comments.length, 2);
          assert.ok(
            exportData.comments.every(
              (comment: any) =>
                comment.content !== "Unrelated comment stays unchanged",
            ),
          );
          assert.doesNotMatch(
            JSON.stringify(exportData),
            /password_hash|scrypt:|token_hash|PRIVATE_PROFILE_SECRET|PRIVATE_PREFERENCE_SECRET|sessions|password_resets/,
          );
          assert.deepEqual(
            (await ok("/tools/privacy/requests/" + exportId + "/download"))
              .data,
            exportData,
          );
          assert.equal(
            (
              await call(
                "/tools/privacy/requests/" + exportId + "/download",
                "GET",
                undefined,
                "",
              )
            ).response.status,
            401,
          );
          assert.equal(
            (
              await call(
                "/tools/privacy/requests/" + exportId + "/download",
                "GET",
                undefined,
                member,
              )
            ).response.status,
            403,
          );
          assert.equal(
            (
              await call(
                "/privacy/download?token=" + "f".repeat(64),
                "GET",
                undefined,
                "",
              )
            ).response.status,
            404,
          );
          const before = (
            await pool.query(
              "SELECT count(*)::int AS total FROM mail_outbox WHERE recipient=$1",
              [email],
            )
          ).rows[0].total;
          const repeated = (
            await ok(
              "/tools/privacy/requests/" + exportId + "/export",
              "POST",
              {},
            )
          ).data;
          assert.equal(repeated.request.id, exportId);
          assert.deepEqual(
            (await ok("/tools/privacy/requests/" + exportId + "/download"))
              .data,
            exportData,
          );
          assert.equal(
            (
              await pool.query(
                "SELECT count(*)::int AS total FROM mail_outbox WHERE recipient=$1",
                [email],
              )
            ).rows[0].total,
            before,
          );
          const listed = (
            await ok(
              "/tools/privacy/requests?type=export&status=completed&search=" +
                encodeURIComponent(email) +
                "&perPage=1&orderby=email&order=asc",
            )
          ).data;
          assert.equal(listed.counts.completed, 1);
          assert.equal(listed.requests[0].id, exportId);
          assert.equal(listed.pagination.totalRequests, 1);
          assert.equal(listed.requests[0].export_data, undefined);
          assert.equal(listed.requests[0].download_token_hash, undefined);
        },
      );
      await t.test(
        "resending revokes old confirmation tokens and expired links never authorize erasure",
        async () => {
          const erase = await create("erase");
          const old = await newestToken(
            "Confirm your WorldAct personal data erase request",
            /\/privacy\/confirm\?token=([a-f0-9]{64})/,
          );
          assert.equal(
            (
              await call(
                "/tools/privacy/requests/" + erase.id + "/erase",
                "POST",
                {},
              )
            ).response.status,
            409,
          );
          await ok(
            "/tools/privacy/requests/" + erase.id + "/resend",
            "POST",
            {},
          );
          const rotated = await newestToken(
            "Confirm your WorldAct personal data erase request",
            /\/privacy\/confirm\?token=([a-f0-9]{64})/,
          );
          assert.notEqual(rotated, old);
          assert.equal(
            (await call("/privacy/confirm", "POST", { token: old }, ""))
              .response.status,
            400,
          );
          await pool.query(
            "UPDATE privacy_requests SET confirmation_expires_at=now()-interval '1 minute' WHERE id=$1",
            [erase.id],
          );
          assert.equal(
            (
              await call(
                "/privacy/confirm?token=" + rotated,
                "GET",
                undefined,
                "",
              )
            ).response.status,
            410,
          );
          assert.equal(
            (await call("/privacy/confirm", "POST", { token: rotated }, ""))
              .response.status,
            410,
          );
          assert.equal(
            (
              await call(
                "/tools/privacy/requests/" + erase.id + "/erase",
                "POST",
                {},
              )
            ).response.status,
            409,
          );
          await ok(
            "/tools/privacy/requests/" + erase.id + "/confirm",
            "PUT",
            {},
          );
          assert.equal(
            (await call("/privacy/confirm", "POST", { token: rotated }, ""))
              .response.status,
            400,
          );
          const beforeErase = (
            await pool.query(
              "SELECT id,version,updated_at FROM comments WHERE post_id=$1 ORDER BY id",
              [postId],
            )
          ).rows;
          const oldAccountArtifact = await historicalArtifact(
            "old-account-" + email,
            {
              accounts: [{ id: userId, email: "old-account-" + email }],
              comments: [],
            },
          );
          const oldCommentArtifact = await historicalArtifact(
            "old-comment-" + email,
            {
              accounts: [],
              comments: [
                { id: beforeErase[0].id, content: "First personal comment" },
              ],
            },
          );
          const unrelatedArtifact = await historicalArtifact(
            "unrelated-artifact-" + email,
            {
              accounts: [],
              comments: [
                {
                  id: beforeErase[2].id,
                  content: "Unrelated comment stays unchanged",
                },
              ],
            },
          );
          const completed = (
            await ok(
              "/tools/privacy/requests/" + erase.id + "/erase",
              "POST",
              {},
            )
          ).data;
          assert.equal(completed.request.status, "completed");
          assert.equal(completed.result.commentsAnonymized, 2);
          assert.equal(completed.result.exportsRevoked, 3);
          assert.equal(
            (
              await call(
                "/privacy/download?token=" + oldAccountArtifact.token,
                "GET",
                undefined,
                "",
              )
            ).response.status,
            404,
          );
          assert.equal(
            (
              await call(
                "/privacy/download?token=" + oldCommentArtifact.token,
                "GET",
                undefined,
                "",
              )
            ).response.status,
            404,
          );
          assert.equal(
            (
              await ok(
                "/privacy/download?token=" + unrelatedArtifact.token,
                "GET",
                undefined,
                "",
              )
            ).data.comments[0].id,
            beforeErase[2].id,
          );
          const currentComment = (
            await pool.query(
              "SELECT version,updated_at FROM comments WHERE id=$1",
              [beforeErase[0].id],
            )
          ).rows[0];
          assert.equal(currentComment.version, beforeErase[0].version + 1);
          assert.equal(
            (
              await call("/comments/" + beforeErase[0].id, "PUT", {
                version: beforeErase[0].version,
                authorName: "Attempted stale restoration",
                authorEmail: email,
              })
            ).response.status,
            409,
          );
          assert.ok(
            completed.result.retained.includes(
              "User accounts and profile fields",
            ),
          );
          const comments = (
            await pool.query(
              "SELECT author_name,author_email,author_url,user_id,content,status FROM comments WHERE post_id=$1 ORDER BY id",
              [postId],
            )
          ).rows;
          assert.equal(comments[0].author_name, "Anonymous");
          assert.equal(comments[0].author_email, "");
          assert.equal(comments[0].author_url, "");
          assert.equal(comments[0].user_id, null);
          assert.equal(comments[0].content, "First personal comment");
          assert.equal(comments[0].status, "approved");
          assert.equal(comments[1].author_name, "Anonymous");
          assert.equal(comments[1].content, "Linked account comment");
          assert.equal(comments[2].author_name, "Unrelated author");
          assert.equal(
            comments[2].content,
            "Unrelated comment stays unchanged",
          );
          assert.equal(
            (
              await pool.query("SELECT profile FROM users WHERE id=$1", [
                userId,
              ])
            ).rows[0].profile.firstName,
            "Personal first name",
          );
          assert.equal(
            (
              await pool.query("SELECT author_id FROM posts WHERE id=$1", [
                postId,
              ])
            ).rows[0].author_id,
            userId,
          );
          assert.equal(
            (
              await call(
                "/privacy/download?token=" + exportToken,
                "GET",
                undefined,
                "",
              )
            ).response.status,
            404,
          );
          assert.equal(
            (await ok("/tools/privacy/requests/" + exportId)).data.request
              .hasExport,
            false,
          );
          const mailCount = (
            await pool.query(
              "SELECT count(*)::int AS total FROM mail_outbox WHERE recipient=$1",
              [email],
            )
          ).rows[0].total;
          const repeated = (
            await ok(
              "/tools/privacy/requests/" + erase.id + "/erase",
              "POST",
              {},
            )
          ).data;
          assert.deepEqual(repeated.result, completed.result);
          assert.equal(
            (
              await pool.query(
                "SELECT count(*)::int AS total FROM mail_outbox WHERE recipient=$1",
                [email],
              )
            ).rows[0].total,
            mailCount,
          );
          assert.equal(
            (
              await call(
                "/tools/privacy/requests/" + erase.id + "/resend",
                "POST",
                {},
              )
            ).response.status,
            409,
          );
        },
      );
      await t.test(
        "explicit administrator confirmation, export expiry, failure retry and deletion preserve capability boundaries",
        async () => {
          const explicit = await create("export", false);
          assert.equal(explicit.status, "confirmed");
          assert.ok(explicit.confirmedAt);
          assert.equal(explicit.confirmationExpiresAt, null);
          const generated = (
            await ok(
              "/tools/privacy/requests/" + explicit.id + "/export",
              "POST",
              {},
            )
          ).data;
          const token = new URL(generated.downloadUrl).searchParams.get(
            "token",
          );
          await pool.query(
            "UPDATE privacy_requests SET download_expires_at=now()-interval '1 minute' WHERE id=$1",
            [explicit.id],
          );
          assert.equal(
            (
              await call(
                "/privacy/download?token=" + token,
                "GET",
                undefined,
                "",
              )
            ).response.status,
            410,
          );
          assert.equal(
            (await call("/tools/privacy/requests/" + explicit.id + "/download"))
              .response.status,
            410,
          );
          assert.equal(
            (
              await call(
                "/tools/privacy/requests/" + explicit.id + "/export",
                "POST",
                {},
              )
            ).response.status,
            410,
          );
          const retry = await create("export", false);
          await pool.query(
            "UPDATE privacy_requests SET status='failed',error='Test a recoverable failure' WHERE id=$1",
            [retry.id],
          );
          const done = (
            await ok(
              "/tools/privacy/requests/" + retry.id + "/export",
              "POST",
              {},
            )
          ).data;
          assert.equal(done.request.status, "completed");
          assert.equal(done.request.error, null);
          const privateToken = new URL(done.downloadUrl).searchParams.get(
            "token",
          );
          await ok("/tools/privacy/requests/" + retry.id, "DELETE");
          assert.equal(
            (await call("/tools/privacy/requests/" + retry.id)).response.status,
            404,
          );
          assert.equal(
            (
              await call(
                "/privacy/download?token=" + privateToken,
                "GET",
                undefined,
                "",
              )
            ).response.status,
            404,
          );
        },
      );
    } finally {
      if (settingsBefore && admin)
        await call("/settings", "PUT", settingsBefore);
      if (requests.length)
        await pool.query(
          "DELETE FROM privacy_requests WHERE id=ANY($1::int[])",
          [requests],
        );
      await pool.query(
        "DELETE FROM mail_outbox WHERE lower(recipient)=lower($1)",
        [email],
      );
      if (postId) await pool.query("DELETE FROM posts WHERE id=$1", [postId]);
      if (userId) await pool.query("DELETE FROM users WHERE id=$1", [userId]);
      await pool.end();
    }
  },
);
