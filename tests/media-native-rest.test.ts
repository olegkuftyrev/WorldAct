import test, { before, after } from "./isolated-test.js";
import assert from "node:assert/strict";
import sharp from "sharp";
import { pool } from "../server/db.js";
import { parseHTML } from "linkedom";

const base = process.env.TEST_API_URL!, origin = process.env.APP_ORIGIN!, stamp = "native-rest-" + Date.now().toString(36);
let admin = "", author = "", subscriber = "", authorId = 0;
const media: any[] = [], accounts: number[] = [], parents: number[] = [];
async function api(route: string, method = "GET", body?: unknown, cookie = admin) {
  const response = await fetch(base + route, { method, signal: AbortSignal.timeout(12000), headers: { Origin: origin, "Content-Type": "application/json", ...(cookie ? { Cookie: cookie } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { response, data: await response.json() };
}
async function upload(cookie: string, name: string) {
  const image = await sharp({ create: { width: 24, height: 12, channels: 3, background: "#3258aa" } }).png().toBuffer();
  const form = new FormData(); form.append("file", new Blob([new Uint8Array(image)], { type: "image/png" }), name + ".png");
  const response = await fetch(base + "/wp-json/wp/v2/media", { method: "POST", headers: { Origin: origin, Cookie: cookie }, body: form });
  const item = await response.json(); assert.equal(response.status, 201, JSON.stringify(item)); media.push(item); return item;
}
before(async () => {
  const signed = await api("/api/auth/login", "POST", { login: process.env.ADMIN_EMAIL, password: process.env.ADMIN_PASSWORD }, ""); assert.equal(signed.response.status, 200);
  admin = signed.response.headers.get("set-cookie")!.split(";")[0];
  for (const role of ["author", "subscriber"]) {
    const password = "Native-media-password-" + stamp, username = stamp + "-" + role;
    const created = await api("/api/users", "POST", { username, email: username + "@example.test", displayName: "Native media " + role, role, password }); assert.equal(created.response.status, 201); accounts.push(created.data.user.id);
    const login = await api("/api/auth/login", "POST", { login: username, password }, ""); assert.equal(login.response.status, 200);
    const cookie = login.response.headers.get("set-cookie")!.split(";")[0];
    if (role === "author") { author = cookie; authorId = created.data.user.id; } else subscriber = cookie;
  }
});
after(async () => {
  for (const item of media) await api(`/api/media/${item.id}`, "DELETE");
  for (const id of parents) { await api(`/api/posts/${id}`, "PUT", { status: "trash" }); await api(`/api/posts/${id}`, "DELETE"); }
  for (const id of accounts) await api(`/api/users/${id}?deleteContent=true`, "DELETE");
  if (admin) await api("/api/auth/logout", "POST", {});
  await pool.end();
});

test("native media edit responses expose saved raw fields to permitted editors while view stays rendered", async () => {
  const item = await upload(admin, stamp + "-raw");
  for (const key of ["title", "caption", "description"]) assert.equal(typeof item[key].raw, "string", key);
  const updated = await api(`/wp-json/wp/v2/media/${item.id}`, "POST", {
    id: item.id, title: "Image &amp; title", caption: "Caption &amp; &lt;img src=x onerror=bad()&gt;", description: "<p>Real <strong>description</strong><script>bad()</script></p>",
  });
  assert.equal(updated.response.status, 200); assert.equal(updated.data.title.raw, "Image & title"); assert.equal(updated.data.title.rendered, "Image &amp; title");
  assert.equal(updated.data.caption.raw, "Caption & <img src=x onerror=bad()>");
  assert.equal(parseHTML("<body>" + updated.data.caption.rendered + "</body>").document.querySelectorAll("img,script").length, 0);
  assert.equal(updated.data.description.raw, "<p>Real <strong>description</strong></p>"); assert.equal(updated.data.description.rendered, updated.data.description.raw);
  const mismatched = await api(`/wp-json/wp/v2/media/${item.id}`, "POST", { id: item.id + 1, title: "Must not replace" }); assert.equal(mismatched.response.status, 400);
  assert.equal((await api(`/api/media/${item.id}`)).data.media.title, "Image & title");
  const edited = await api(`/wp-json/wp/v2/media/${item.id}?context=edit`); assert.equal(edited.response.status, 200);
  for (const key of ["title", "caption", "description"]) assert.deepEqual(edited.data[key], updated.data[key]);
  for (const context of ["view", "embed"]) {
    const viewed = await api(`/wp-json/wp/v2/media/${item.id}?context=${context}`, "GET", undefined, ""); assert.equal(viewed.response.status, 200);
    for (const key of ["title", "caption", "description"]) assert.equal(Object.hasOwn(viewed.data[key], "raw"), false);
  }
  assert.equal((await api(`/wp-json/wp/v2/media/${item.id}?context=edit`, "GET", undefined, "")).response.status, 401);
  assert.equal((await api(`/wp-json/wp/v2/media/${item.id}?context=edit`, "GET", undefined, subscriber)).response.status, 403);
  assert.equal((await api(`/wp-json/wp/v2/media/${item.id}?context=edit`, "GET", undefined, author)).response.status, 403);
  assert.equal((await api(`/wp-json/wp/v2/media/${item.id}?context=invalid`)).response.status, 400);
  const copied = await api(`/wp-json/wp/v2/media/${item.id}/edit`, "POST", { src: item.source_url, modifiers: [{ type: "rotate", args: { angle: 90 } }], title: "New title", caption: "New caption", description: "<p>New description</p>" });
  assert.equal(copied.response.status, 201, JSON.stringify(copied.data)); media.push(copied.data);
  assert.equal(copied.data.title.raw, "New title"); assert.equal(copied.data.caption.raw, "New caption"); assert.equal(copied.data.description.raw, "<p>New description</p>");
});

test("real native media collections filter fixed queries before pagination and retain include order", async () => {
  const items = [];
  for (let index = 0; index < 3; index++) items.push(await upload(admin, `${stamp}-filter-${index}`));
  const owned = await upload(author, stamp + "-filter-author"); items.push(owned);
  const parent = await api("/api/posts", "POST", { title: stamp + " parent", type: "post", status: "draft" }); assert.equal(parent.response.status, 201); parents.push(parent.data.post.id);
  await api(`/wp-json/wp/v2/media/${items[1].id}`, "POST", { post: parent.data.post.id });
  const search = encodeURIComponent(stamp + "-filter");
  const first = await api(`/wp-json/wp/v2/media?context=edit&search=${search}&per_page=2&orderby=id&order=asc`);
  assert.equal(first.response.status, 200); assert.deepEqual(first.data.map((item: any) => item.id), items.slice(0, 2).map(item => item.id));
  assert.equal(first.response.headers.get("x-wp-total"), "4"); assert.equal(first.response.headers.get("x-wp-totalpages"), "2"); assert.match(first.response.headers.get("link") || "", /page=2.*rel="next"/);
  const second = await api(`/wp-json/wp/v2/media?context=edit&search=${search}&per_page=2&orderby=id&order=asc&page=2`);
  assert.deepEqual(second.data.map((item: any) => item.id), items.slice(2).map(item => item.id));
  assert.equal((await api(`/wp-json/wp/v2/media?search=${search}&per_page=2&page=3`)).response.status, 400);
  const ordered = await api(`/wp-json/wp/v2/media?include=${items[2].id},${items[0].id}&orderby=include`);
  assert.deepEqual(ordered.data.map((item: any) => item.id), [items[2].id, items[0].id]);
  const bracket = await api(`/wp-json/wp/v2/media?include[0]=${items[0].id}&include[1]=${items[1].id}&exclude[]=${items[0].id}`);
  assert.deepEqual(bracket.data.map((item: any) => item.id), [items[1].id]);
  assert.deepEqual((await api(`/wp-json/wp/v2/media?search=${search}&parent=${parent.data.post.id}&media_type=image&mime_type=image%2Fpng`)).data.map((item: any) => item.id), [items[1].id]);
  assert.equal((await api(`/wp-json/wp/v2/media?search=${search}&parent=0`)).data.length, 3);
  assert.equal((await api(`/wp-json/wp/v2/media?search=${search}&media_type=audio`)).data.length, 0);
  assert.deepEqual((await api(`/wp-json/wp/v2/media?search=${search}&author=${authorId}`)).data.map((item: any) => item.id), [owned.id]);
  const own = await api(`/wp-json/wp/v2/media?context=edit&search=${search}`, "GET", undefined, author); assert.equal(own.response.status, 200); assert.equal(own.response.headers.get("x-wp-total"), "1"); assert.deepEqual(own.data.map((item: any) => item.id), [owned.id]);
  assert.equal(typeof own.data[0].caption.raw, "string");
  assert.equal((await api(`/wp-json/wp/v2/media?context=edit`, "GET", undefined, "")).response.status, 401);
  assert.equal((await api(`/wp-json/wp/v2/media?context=edit`, "GET", undefined, subscriber)).response.status, 403);
  const filtered = await api(`/wp-json/wp/v2/media?include=${owned.id}&context=edit&_fields=id,caption.raw`, "GET", undefined, author); assert.equal(filtered.response.status, 200); assert.deepEqual(filtered.data, [{ id: owned.id, caption: { raw: "" } }]);
});

test("native media filter validation rejects nested IDs, excessive lists and SQL-shaped selectors", async () => {
  for (const query of ["include[bad]=1", "include[0][bad]=1", "include=-1", "include=1.5", "include=2147483648", "include=1,OR%201=1", "orderby=include", "orderby=title%3BDROP", "order=descending", "media_type=unknown", "mime_type=image%2F%25", "parent=-1", "author[bad]=1", "context[]=edit", "search[bad]=x", "include=" + Array.from({ length: 101 }, (_, index) => index + 1).join(",")]) {
    assert.equal((await api("/wp-json/wp/v2/media?" + query)).response.status, 400, query);
  }
});
