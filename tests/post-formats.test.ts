import test from "./isolated-test.js";
import "dotenv/config";
import assert from "node:assert/strict";
import { pool } from "../server/db.js";
import { renderPublicContent } from "../server/block-renderer.js";
import { postFormats } from "../shared/post-formats.js";

const base = process.env.TEST_API_URL || "http://127.0.0.1:3001";
const origin = process.env.APP_ORIGIN || "http://127.0.0.1:5173";
test("Chat and Status formats survive editing, defaults, queries and both import formats", async () => {
  let cookie = "";
  const posts: number[] = [];
  const stamp = "formats-" + Date.now().toString(36);
  const before = (await pool.query("SELECT data FROM settings WHERE id=1")).rows[0].data;
  const api = async (path: string, method = "GET", body?: unknown) => {
    const response = await fetch(base + path, { method, headers: { Origin: origin, Cookie: cookie, "Content-Type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const data = await response.json();
    assert.ok(response.ok, `${path}: ${response.status} ${JSON.stringify(data)}`);
    return { response, data };
  };
  try {
    const login = await api("/api/auth/login", "POST", { login: process.env.ADMIN_EMAIL, password: process.env.ADMIN_PASSWORD });
    cookie = login.response.headers.get("set-cookie")!.split(";")[0];
    const chat = (await api("/api/posts", "POST", { title: stamp + " chat", format: "chat", status: "publish" })).data.post;
    posts.push(chat.id); assert.equal(chat.format, "chat");
    await api("/api/settings", "PUT", { defaultPostFormat: "status" });
    const status = (await api("/api/posts", "POST", { title: stamp + " status", status: "publish" })).data.post;
    posts.push(status.id); assert.equal(status.format, "status");
    const selected = (await api(`/wp-json/wp/v2/posts?include=${posts.join(",")}&format=chat,status`)).data;
    assert.deepEqual(selected.map((post: any) => post.format).sort(), ["chat", "status"]);
    assert.equal((await api("/wp-json/wp/v2/posts/" + chat.id, "POST", { format: "status" })).data.format, "status");
    const bulk = (await api("/api/posts/bulk", "POST", { ids: posts, changes: { format: "chat" } })).data;
    assert.deepEqual(bulk.updated, posts); assert.ok(bulk.posts.every((post: any) => post.format === "chat"));
    const query = await renderPublicContent({ ...chat, rawContent: `<!-- wp:query ${JSON.stringify({ query: { perPage: 100, format: ["chat"], search: stamp } })} --><!-- wp:post-template --><!-- wp:post-title /--><!-- /wp:post-template --><!-- /wp:query -->` });
    assert.match(query, new RegExp(stamp + " chat")); assert.match(query, new RegExp(stamp + " status"));
    const native = (await api("/wp-json/wp/v2/themes")).data;
    assert.deepEqual(native[0].theme_supports.formats, postFormats);
    const archive = await api("/api/tools/import", "POST", { application: "WorldAct", version: 3, posts: ["chat", "status"].map((format, i) => ({ id: i + 100, type: "post", title: stamp + " JSON " + format, slug: stamp + "-json-" + format, status: "draft", format, content: "" })) });
    posts.push(...archive.data.postIds);
    assert.deepEqual((await pool.query("SELECT format FROM posts WHERE id=ANY($1::int[]) ORDER BY format", [archive.data.postIds])).rows.map(row => row.format), ["chat", "status"]);
    const xml = `<rss xmlns:wp="http://wordpress.org/export/1.2/"><channel><wp:wxr_version>1.2</wp:wxr_version>${["chat", "status"].map((format, i) => `<item><wp:post_id>${i + 100}</wp:post_id><wp:post_type>post</wp:post_type><title>${stamp} WXR ${format}</title><wp:status>draft</wp:status><category domain="post_format" nicename="post-format-${format}">${format}</category></item>`).join("")}</channel></rss>`;
    const imported = await api("/api/tools/import", "POST", { format: "wxr", xml });
    posts.push(...imported.data.postIds);
    assert.deepEqual((await pool.query("SELECT format FROM posts WHERE id=ANY($1::int[]) ORDER BY format", [imported.data.postIds])).rows.map(row => row.format), ["chat", "status"]);
  } finally {
    await pool.query("DELETE FROM posts WHERE id=ANY($1::int[])", [posts]);
    await pool.query("UPDATE settings SET data=$1::jsonb WHERE id=1", [JSON.stringify(before)]);
    if (cookie) await api("/api/auth/logout", "POST", {});
    await pool.end();
  }
});
