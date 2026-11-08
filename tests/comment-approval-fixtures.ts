import "./isolated-test.js";
import assert from "node:assert/strict";
import { pool } from "../server/db.js";

export const base = process.env.TEST_API_URL!, origin = process.env.APP_ORIGIN!;
export const cookieOf = (response: Response) => response.headers.get("set-cookie")!.split(";")[0];
export async function approvalFixture(label: string) {
  const stamp = label + "-" + Date.now().toString(36), password = "Approval-safe-" + stamp;
  const original = (await pool.query("SELECT data FROM settings WHERE id=1")).rows[0].data;
  const extensions = (await pool.query("SELECT * FROM extensions WHERE slug IN ('spam-shield','akismet')")).rows;
  const secrets = (await pool.query("SELECT * FROM extension_secrets WHERE slug='akismet'")).rows;
  const posts: number[] = [], users: number[] = [], emails: string[] = [];
  let admin = "", sequence = 0;
  async function api(route: string, method = "GET", body?: unknown, auth = admin, headers: Record<string,string> = {}) {
    const response = await fetch(base + route, { method, signal: AbortSignal.timeout(12000), headers: { Origin: origin, Cookie: auth, "Content-Type": "application/json", ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { response, data: await response.json() };
  }
  async function ok(route: string, method = "GET", body?: unknown, auth = admin) {
    const result = await api(route, method, body, auth); assert.ok(result.response.ok, `${route}: ${result.response.status} ${JSON.stringify(result.data)}`); return result.data;
  }
  const login = await api("/api/auth/login", "POST", { login: process.env.ADMIN_EMAIL, password: process.env.ADMIN_PASSWORD }, "");
  assert.equal(login.response.status, 200); admin = cookieOf(login.response);
  await ok("/api/settings", "PUT", { commentModeration: false, commentPreviouslyApproved: false, commentMaxLinks: 0, commentModerationKeys: "", disallowedCommentKeys: "", requireCommentNameEmail: true, commentRegistration: false, closeCommentsDays: 0, commentCookieConsent: true, notifyComments: true, notifyModeration: true });
  await pool.query("UPDATE extensions SET enabled=false WHERE slug IN ('spam-shield','akismet')");
  async function account(name: string, role = "subscriber", email = `${stamp}-${name}@example.test`) {
    const user = (await ok("/api/users", "POST", { username: stamp + "-" + name, email, displayName: name, role, password })).user;
    users.push(user.id); emails.push(email);
    const signed = await api("/api/auth/login", "POST", { login: user.username, password }, ""); assert.equal(signed.response.status, 200);
    return { ...user, auth: cookieOf(signed.response) };
  }
  async function post(authorId = login.data.user.id) {
    const post = (await ok("/api/posts", "POST", { title: stamp + " post " + posts.length, authorId, status: "publish", commentStatus: "open", content: "<p>Approval fixture</p>" })).post; posts.push(post.id); return post;
  }
  async function submit(postId: number, values: Record<string, unknown> = {}, auth = "", headers: Record<string,string> = {}) {
    return api("/api/public/comments", "POST", { postId, authorName: "Guest reader", authorEmail: stamp + "-guest@example.test", content: "Approval body " + ++sequence, ...values }, auth, headers);
  }
  // Approval cases intentionally exercise independent moderation states. Age
  // only this fixture's predecessors when a caller explicitly starts a case;
  // immediate duplicate/flood/wait tests never invoke this helper.
  async function ageAdmissions(postId: number) {
    assert.ok(posts.includes(postId), "only this fixture's own post can be aged");
    await pool.query("UPDATE comments SET created_at=date_trunc('second',clock_timestamp())-interval '20 seconds' WHERE post_id=$1", [postId]);
  }
  async function dispose() {
    await pool.query("DELETE FROM posts WHERE id=ANY($1::int[])", [posts]);
    await pool.query("DELETE FROM users WHERE id=ANY($1::int[])", [users]);
    await pool.query("DELETE FROM mail_outbox WHERE subject LIKE $1 OR recipient=ANY($2::text[])", ["%" + stamp + "%", emails]);
    await pool.query("UPDATE settings SET data=$1::jsonb WHERE id=1", [JSON.stringify(original)]);
    await pool.query("DELETE FROM extensions WHERE slug IN ('spam-shield','akismet')");
    for (const row of extensions) await pool.query("INSERT INTO extensions(slug,enabled,settings,installed_at) VALUES($1,$2,$3,$4)", [row.slug,row.enabled,row.settings,row.installed_at]);
    for (const row of secrets) await pool.query("INSERT INTO extension_secrets(slug,api_key,verified_site_url,verified_at,last_error_code,updated_at) VALUES($1,$2,$3,$4,$5,$6)", [row.slug,row.api_key,row.verified_site_url,row.verified_at,row.last_error_code,row.updated_at]);
  }
  return { stamp, admin, adminUser: login.data.user, api, ok, account, post, submit, ageAdmissions, dispose };
}
