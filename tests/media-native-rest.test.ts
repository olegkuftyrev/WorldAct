import test, { before, after } from "./isolated-test.js";
import assert from "node:assert/strict";
import sharp from "sharp";
import { pool } from "../server/db.js";
import { parseHTML } from "linkedom";

const base = process.env.TEST_API_URL!, origin = process.env.APP_ORIGIN!, stamp = "native-rest-" + Date.now().toString(36);
let admin = "", author = "", subscriber = "", contributor = "", authorId = 0;
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
  for (const role of ["author", "subscriber", "contributor"]) {
    const password = "Native-media-password-" + stamp, username = stamp + "-" + role;
    const created = await api("/api/users", "POST", { username, email: username + "@example.test", displayName: "Native media " + role, role, password }); assert.equal(created.response.status, 201); accounts.push(created.data.user.id);
    const login = await api("/api/auth/login", "POST", { login: username, password }, ""); assert.equal(login.response.status, 200);
    const cookie = login.response.headers.get("set-cookie")!.split(";")[0];
    if (role === "author") { author = cookie; authorId = created.data.user.id; } else if (role === "subscriber") subscriber = cookie; else contributor = cookie;
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
  assert.equal(updated.data.caption.raw, "Caption &amp; &lt;img src=x onerror=bad()&gt;");
  assert.equal(updated.data.caption.rendered, "<p>Caption &amp; &lt;img src=x onerror=bad()&gt;</p>\n");
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

test("native Details embeds real authors and readable attached-post metadata without exposing private records or bodies", async () => {
  const item = await upload(author, stamp + "-embedded");
  const initialSettings = (await pool.query("SELECT data FROM settings WHERE id=1")).rows[0].data;
  const createParent = async (title: string, status: string, cookie = admin, extra: Record<string, unknown> = {}) => {
    const result = await api("/api/posts", "POST", { title, status, content: "Private relation body must never appear", ...extra }, cookie);
    assert.equal(result.response.status, 201, JSON.stringify(result.data)); parents.push(result.data.post.id); return result.data.post;
  };
  try {
    const hidden = await createParent(stamp + " confidential parent", "draft");
    assert.equal((await api(`/wp-json/wp/v2/media/${item.id}`, "POST", { post: hidden.id })).response.status, 200);
    const own = await api(`/wp-json/wp/v2/media/${item.id}?context=edit&_embed=author,wp:attached-to`, "GET", undefined, author);
    assert.equal(own.response.status, 200); assert.equal(own.data._embedded.author[0].id, authorId);
    assert.equal(own.data._embedded.author[0].name, "Native media author");
    assert.equal(Object.hasOwn(own.data._embedded, "wp:attached-to"), false);
    assert.ok(!JSON.stringify(own.data).includes(hidden.title));
    const publicView = await api(`/wp-json/wp/v2/media/${item.id}?_embed=true`, "GET", undefined, "");
    assert.equal(publicView.response.status, 200); assert.equal(publicView.data._embedded.author[0].id, authorId);
    assert.equal(Object.hasOwn(publicView.data._embedded, "wp:attached-to"), false);
    assert.doesNotMatch(JSON.stringify(publicView.data._embedded), /email|preferences|password|showAdminBar|commentShortcuts/);
    assert.match(publicView.data._embedded.author[0].avatar_urls[48], /^https:\/\/secure\.gravatar\.com\/avatar\/[a-f0-9]{64}\?s=48/);
    const administrator = await api(`/wp-json/wp/v2/media/${item.id}?context=edit&_embed=author,wp:attached-to`);
    assert.equal(administrator.response.status, 200);
    assert.deepEqual(Object.keys(administrator.data._embedded["wp:attached-to"][0]).sort(), ["id", "link", "slug", "title", "type"]);
    assert.equal(administrator.data._embedded["wp:attached-to"][0].title.rendered, hidden.title);
    assert.ok(!JSON.stringify(administrator.data._embedded).includes("Private relation body"));
    const ownDraft = await createParent(stamp + " own parent", "draft", author);
    assert.equal((await api(`/wp-json/wp/v2/media/${item.id}`, "POST", { post: ownDraft.id }, author)).response.status, 200);
    assert.equal((await api(`/wp-json/wp/v2/media/${item.id}?context=edit&_embed=wp:attached-to`, "GET", undefined, author)).data._embedded["wp:attached-to"][0].id, ownDraft.id);
    const published = await createParent(stamp + " public protected parent", "publish", admin, { password: "Only-a-relation-test" });
    const changed = await api(`/wp-json/wp/v2/media/${item.id}?_embed=author,wp:attached-to`, "POST", { post: published.id });
    assert.equal(changed.response.status, 200); assert.equal(changed.data._embedded["wp:attached-to"][0].id, published.id);
    for (const query of ["_embed", "_embed=true", "_embed=1", "_embed=author,wp:attached-to"]) {
      const view = await api(`/wp-json/wp/v2/media/${item.id}?${query}`, "GET", undefined, "");
      assert.equal(view.response.status, 200); assert.equal(view.data._embedded["wp:attached-to"][0].id, published.id);
      assert.ok(!JSON.stringify(view.data._embedded).includes("Private relation body"));
      assert.ok(!JSON.stringify(view.data._embedded).includes("Only-a-relation-test"));
    }
    const selected = await api(`/wp-json/wp/v2/media?include=${item.id}&_embed=author,wp:attached-to&_fields=id,media_details.filesize,_embedded.author.name,_embedded.wp:attached-to.title.rendered`);
    assert.equal(selected.response.status, 200);
    assert.deepEqual(selected.data[0]._embedded, { author: [{ name: "Native media author" }], "wp:attached-to": [{ title: { rendered: published.title } }] });
    const bytes = await fetch(base + new URL(item.source_url).pathname); assert.equal(bytes.status, 200);
    assert.equal(selected.data[0].media_details.filesize, (await bytes.arrayBuffer()).byteLength);
    for (const query of ["", "?_embed=false", "?_embed=0", "?_embed=unknown"]) {
      assert.equal(Object.hasOwn((await api(`/wp-json/wp/v2/media/${item.id}${query}`)).data, "_embedded"), false);
    }
    assert.equal((await api("/api/settings", "PUT", { showAvatars: false })).response.status, 200);
    assert.deepEqual((await api(`/wp-json/wp/v2/media/${item.id}?_embed=author`)).data._embedded.author[0].avatar_urls, {});
  } finally { await api("/api/settings", "PUT", { showAvatars: initialSettings.showAvatars }); }
});

test("invalid native embedding and field projections fail before metadata writes or edit-copy staging", async () => {
  const item = await upload(admin, stamp + "-embed-validation");
  const count = Number((await pool.query("SELECT count(*) AS n FROM media")).rows[0].n);
  for (const query of ["_embed[bad]=author", "_embed[]=author", "_embed=" + "a".repeat(2001), "_embed=" + Array(21).fill("author").join(","), "_fields=title..raw"]) {
    assert.equal((await api(`/wp-json/wp/v2/media/${item.id}?${query}`, "POST", { title: "Must stay unchanged" })).response.status, 400, query.slice(0, 50));
    assert.equal((await api(`/wp-json/wp/v2/media/${item.id}/edit?${query}`, "POST", { src: item.source_url, modifiers: [{ type: "rotate", args: { angle: 90 } }] })).response.status, 400);
    assert.equal(Number((await pool.query("SELECT count(*) AS n FROM media")).rows[0].n), count);
    assert.equal((await api(`/api/media/${item.id}`)).data.media.title, item.title.raw);
  }
});

test("attached-post embedding retains contributor authority across draft-origin versus published-origin trash", async () => {
  const item = await upload(admin, stamp + "-contributor-parent");
  const created = await api("/api/posts", "POST", { title: stamp + " contributor trash parent", status: "draft", content: "A body which must never be embedded" }, contributor);
  assert.equal(created.response.status, 201); const parent = created.data.post; parents.push(parent.id);
  assert.equal((await api(`/wp-json/wp/v2/media/${item.id}`, "POST", { post: parent.id })).response.status, 200);
  assert.equal((await api(`/api/posts/${parent.id}`, "PUT", { status: "trash" })).response.status, 200);
  const draftTrash = await api(`/wp-json/wp/v2/media/${item.id}?_embed=wp:attached-to`, "GET", undefined, contributor);
  assert.equal(draftTrash.response.status, 200); assert.equal(draftTrash.data._embedded["wp:attached-to"][0].id, parent.id);
  assert.equal((await api(`/api/posts/${parent.id}`, "PUT", { status: "publish" })).response.status, 200);
  assert.equal((await api(`/api/posts/${parent.id}`, "PUT", { status: "trash" })).response.status, 200);
  assert.equal((await api(`/api/posts/${parent.id}`, "GET", undefined, contributor)).response.status, 403);
  const publishedTrash = await api(`/wp-json/wp/v2/media/${item.id}?_embed=wp:attached-to`, "GET", undefined, contributor);
  assert.equal(publishedTrash.response.status, 200); assert.equal(Object.hasOwn(publishedTrash.data, "_embedded"), false);
  assert.ok(!JSON.stringify(publishedTrash.data).includes(parent.title));
});

test("native Attached-to saves ignore bounded read-only previews and authorize only the actual post field", async () => {
  const item = await upload(author, stamp + "-readonly-relations");
  const own = await api("/api/posts", "POST", { title: stamp + " actual attached post", status: "draft", content: "A real parent" }, author);
  assert.equal(own.response.status, 201); parents.push(own.data.post.id);
  const preview = { author: [{ id: 2147483000, name: "Forged author must stay ignored" }], "wp:attached-to": [{ id: 2147483000, type: "post", title: { raw: "Forged parent", rendered: "Forged parent" } }] };
  const saved = await api(`/wp-json/wp/v2/media/${item.id}?context=edit&_embed=author,wp:attached-to`, "POST", { id: item.id, post: own.data.post.id, _embedded: preview }, author);
  assert.equal(saved.response.status, 200, JSON.stringify(saved.data)); assert.equal(saved.data.post, own.data.post.id);
  assert.equal(saved.data._embedded.author[0].id, authorId); assert.equal(saved.data._embedded["wp:attached-to"][0].title.rendered, own.data.post.title);
  assert.doesNotMatch(JSON.stringify(saved.data), /Forged author|Forged parent/);
  const foreign = await api("/api/posts", "POST", { title: stamp + " foreign attached post", status: "draft", content: "Foreign parent" });
  assert.equal(foreign.response.status, 201); parents.push(foreign.data.post.id);
  assert.equal((await api(`/wp-json/wp/v2/media/${item.id}`, "POST", { id: item.id, post: foreign.data.post.id, _embedded: { "wp:attached-to": [{ id: own.data.post.id }] } }, author)).response.status, 403);
  let deep: unknown = "ignored"; for (let index = 0; index < 10; index++) deep = { nested: deep };
  for (const _embedded of [null, [], { escaped: "\\".repeat(17000) }, { author: [{ name: "x".repeat(32769) }] }, { values: Array(513).fill(false) }, { deep }, JSON.parse('{"__proto__":{"ignored":"' + "x".repeat(32769) + '"}}')]) {
    assert.equal((await api(`/wp-json/wp/v2/media/${item.id}`, "POST", { title: "Must not change", _embedded }, author)).response.status, 400);
    assert.equal((await api(`/api/media/${item.id}`)).data.media.title, item.title.raw);
  }
});
