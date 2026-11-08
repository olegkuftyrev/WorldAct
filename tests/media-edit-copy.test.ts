import test, { before, after } from "./isolated-test.js";
import assert from "node:assert/strict";
import { readFile, readdir, rename } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { pool, uploadsDir } from "../server/db.js";
import { matchesEditableMediaSource } from "../server/media-edit-copy.js";

const base = process.env.TEST_API_URL!, origin = process.env.APP_ORIGIN!;
let cookie = "";
const media = new Set<number>(), users = new Set<number>(), posts = new Set<number>();
async function api(route: string, method = "GET", body?: unknown, actor = cookie, headers: Record<string, string> = {}) {
  const response = await fetch(base + route, { method, signal: AbortSignal.timeout(12000), headers: { Origin: origin, "Content-Type": "application/json", ...(actor ? { Cookie: actor } : {}), ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { response, data: await response.json() };
}
async function upload(image: Buffer, actor = cookie) {
  const form = new FormData(); form.append("file", new Blob([new Uint8Array(image)], { type: "image/png" }), "native-edit.png");
  const response = await fetch(base + "/api/media", { method: "POST", headers: { Origin: origin, Cookie: actor }, body: form });
  const data = await response.json(); assert.equal(response.status, 201, JSON.stringify(data)); media.add(data.media.id); return data.media;
}
async function copy(id: number, body: unknown, actor = cookie) {
  const result = await api(`/wp-json/wp/v2/media/${id}/edit`, "POST", body, actor);
  if (result.response.status === 201) media.add(result.data.id);
  return result;
}
const rotate = (angle = 90) => ({ type: "rotate", args: { angle } });
const crop = (left: number, top: number, width: number, height: number) => ({ type: "crop", args: { left, top, width, height } });
async function files(directory = uploadsDir): Promise<string[]> {
  const result: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const filename = path.join(directory, entry.name);
    if (entry.isDirectory()) result.push(...await files(filename)); else result.push(path.relative(uploadsDir, filename));
  }
  return result.sort();
}
async function pixels(data: Buffer) { return sharp(data).ensureAlpha().raw().toBuffer(); }
before(async () => {
  const login = await api("/api/auth/login", "POST", { login: process.env.ADMIN_EMAIL, password: process.env.ADMIN_PASSWORD }, "");
  assert.equal(login.response.status, 200); cookie = login.response.headers.get("set-cookie")!.split(";")[0];
});
after(async () => {
  for (const id of media) await api(`/api/media/${id}`, "DELETE");
  for (const id of posts) { await api(`/api/posts/${id}`, "PUT", { status: "trash" }); await api(`/api/posts/${id}`, "DELETE"); }
  for (const id of users) await api(`/api/users/${id}?deleteContent=true`, "DELETE");
  if (cookie) await api("/api/auth/logout", "POST", {});
  await pool.end();
});

test("native crop duplicates real image bytes and metadata while preserving the source for Undo", async () => {
  const raw = Buffer.alloc(20 * 12 * 3);
  for (let index = 0; index < 20 * 12; index++) { raw[index * 3] = index % 20 * 10; raw[index * 3 + 1] = Math.floor(index / 20) * 20; }
  const image = await sharp(raw, { raw: { width: 20, height: 12, channels: 3 } }).png().toBuffer();
  const source = await upload(image);
  const parent = await api("/api/posts", "POST", { title: "Native image source parent", type: "post", status: "draft" });
  assert.equal(parent.response.status, 201); posts.add(parent.data.post.id);
  assert.equal((await api(`/api/media/${source.id}`, "PUT", { title: "Original title", alt: "Original alt", caption: "Original caption", description: "<p>Original description</p>", attachedPostId: parent.data.post.id, commentStatus: "open" })).response.status, 200);
  const before = (await pool.query("SELECT * FROM media WHERE id=$1", [source.id])).rows[0];
  const nativeSource = (await api(`/wp-json/wp/v2/media/${source.id}`)).data;
  const result = await copy(source.id, { src: nativeSource.source_url + "?cache=1", modifiers: [rotate(), crop(25, 0, 50, 50)] });
  assert.equal(result.response.status, 201, JSON.stringify(result.data)); assert.notEqual(result.data.id, source.id);
  assert.equal(result.response.headers.get("location"), `/wp-json/wp/v2/media/${result.data.id}`);
  assert.equal(result.data.media_details.width, 6); assert.equal(result.data.media_details.height, 10);
  assert.equal(result.data.title.rendered, "Original title"); assert.equal(result.data.alt_text, "Original alt");
  assert.equal(result.data.caption.raw, "Original caption"); assert.equal(result.data.caption.rendered, "<p>Original caption</p>\n"); assert.equal(result.data.description.rendered, "<p>Original description</p>");
  assert.equal(result.data.post, 0); assert.equal(result.data.comment_status, "closed");
  assert.deepEqual((await pool.query("SELECT * FROM media WHERE id=$1", [source.id])).rows[0], before);
  assert.deepEqual(await readFile(path.join(uploadsDir, before.filename)), image);
  const duplicate = (await api(`/api/media/${result.data.id}`)).data.media;
  assert.equal(duplicate.canRestore, false); assert.notEqual(duplicate.filename, before.filename);
  const expected = await sharp(image).rotate(90).png().toBuffer();
  const expectedCrop = await sharp(expected).extract({ left: 3, top: 0, width: 6, height: 10 }).png().toBuffer();
  assert.deepEqual(await pixels(await readFile(path.join(uploadsDir, duplicate.filename))), await pixels(expectedCrop));
  // Deleting the source must not remove the duplicated attachment's own graph.
  assert.equal((await api(`/api/media/${source.id}`, "DELETE")).response.status, 200); media.delete(source.id);
  assert.equal((await fetch(base + duplicate.url)).status, 200);
});

test("native editing accepts only current metadata URLs and uses the retained raw original for quality", async () => {
  const image = await sharp({ create: { width: 3000, height: 1200, channels: 4, background: "#7849aacc" } }).png().toBuffer();
  const source = await upload(image), native = (await api(`/wp-json/wp/v2/media/${source.id}`)).data;
  assert.equal(source.width, 2560); assert.equal(source.height, 1024); assert.ok(source.originalUploadUrl);
  const selected = native.media_details.sizes.medium.source_url;
  const result = await copy(source.id, { src: selected, modifiers: [crop(0, 0, 50, 100)], title: "Copied image", caption: "<b>New caption</b>", alt_text: "<i>new alt</i>", description: "<p>New<script>bad()</script></p>" });
  assert.equal(result.response.status, 201, JSON.stringify(result.data));
  assert.equal(result.data.media_details.width, 1500); assert.equal(result.data.media_details.height, 1200);
  assert.equal(result.data.title.rendered, "Copied image"); assert.equal(result.data.caption.raw, "<b>New caption</b>"); assert.equal(result.data.caption.rendered, "<p><b>New caption</b></p>\n"); assert.equal(result.data.alt_text, "new alt"); assert.equal(result.data.description.rendered, "<p>New</p>");
  const rawResult = await copy(source.id, { src: native.original_image_url, modifiers: [rotate(180)] });
  assert.equal(rawResult.response.status, 201); assert.equal(rawResult.data.media_details.width, 2560); assert.equal(rawResult.data.media_details.height, 1024); assert.ok(rawResult.data.original_image_url);
  const clone = (await api(`/api/media/${rawResult.data.id}`)).data.media;
  const edit = await api(`/api/media/${clone.id}/edit`, "POST", { rotate: 90 }); assert.equal(edit.response.status, 200);
  const restore = await api(`/api/media/${clone.id}/restore`, "POST", {}); assert.equal(restore.response.status, 200); assert.equal(restore.data.media.filename, clone.filename);
  assert.equal((await api(`/api/media/${clone.id}`, "DELETE")).response.status, 200); media.delete(clone.id);
  assert.equal((await fetch(base + source.url)).status, 200); assert.equal((await fetch(base + source.originalUploadUrl)).status, 200);
  const row = (await pool.query("SELECT * FROM media WHERE id=$1", [source.id])).rows[0], original = row.derivatives["original-upload"];
  await rename(path.join(uploadsDir, original), path.join(uploadsDir, original + ".test-missing"));
  try { assert.equal((await copy(source.id, { src: native.source_url, modifiers: [rotate()] })).response.status, 404); }
  finally { await rename(path.join(uploadsDir, original + ".test-missing"), path.join(uploadsDir, original)); }
});

test("native editing rejects foreign sources, unsupported modifiers, bad origins and lower roles without creating files", async () => {
  const source = await upload(await sharp({ create: { width: 30, height: 20, channels: 3, background: "red" } }).png().toBuffer());
  const native = (await api(`/wp-json/wp/v2/media/${source.id}`)).data;
  const inventory = await files(), count = (await pool.query("SELECT count(*)::int AS n FROM media")).rows[0].n;
  for (const src of ["https://example.test" + new URL(native.source_url).pathname, "file:///etc/passwd", "/uploads/../outside.png", "/uploads/unknown.png", "//example.test/known.png", "data:image/png;base64,AAAA"]) {
    assert.equal((await copy(source.id, { src, modifiers: [rotate()] })).response.status, 404, src);
  }
  for (const modifiers of [[], [crop(90, 0, 50, 100)], [{ type: "exec", args: {} }], [rotate("90" as any)], Array.from({ length: 9 }, () => rotate())]) {
    assert.equal((await copy(source.id, { src: native.source_url, modifiers })).response.status, 400);
  }
  assert.equal((await api(`/wp-json/wp/v2/media/${source.id}/edit`, "POST", { src: native.source_url, modifiers: [rotate()] }, cookie, { Origin: "https://example.test" })).response.status, 403);
  assert.equal((await copy(source.id, { src: native.source_url, modifiers: [rotate()] }, "")).response.status, 401);
  const stamp = "native-image-author-" + Date.now().toString(36), password = "Native-image-test-" + stamp;
  const account = await api("/api/users", "POST", { username: stamp, displayName: "Image author", email: stamp + "@example.test", role: "author", password });
  assert.equal(account.response.status, 201); users.add(account.data.user.id);
  const login = await api("/api/auth/login", "POST", { login: stamp, password }, ""); assert.equal(login.response.status, 200);
  const author = login.response.headers.get("set-cookie")!.split(";")[0];
  assert.equal((await copy(source.id, { src: native.source_url, modifiers: [rotate()] }, author)).response.status, 403);
  assert.deepEqual(await files(), inventory); assert.equal((await pool.query("SELECT count(*)::int AS n FROM media")).rows[0].n, count);
  const owned = await upload(await sharp({ create: { width: 12, height: 8, channels: 3, background: "blue" } }).png().toBuffer(), author);
  const ownNative = (await api(`/wp-json/wp/v2/media/${owned.id}`)).data;
  const allowed = await copy(owned.id, { src: ownNative.source_url, modifiers: [rotate()] }, author); assert.equal(allowed.response.status, 201); assert.equal(allowed.data.author, account.data.user.id);
  const foreignParent = [...posts][0]; assert.ok(foreignParent);
  assert.equal((await copy(owned.id, { src: ownNative.source_url, modifiers: [rotate()], post: foreignParent }, author)).response.status, 403);
  await api(`/api/users/${account.data.user.id}`, "PUT", { role: "contributor" });
  assert.equal((await copy(owned.id, { src: ownNative.source_url, modifiers: [rotate()] }, author)).response.status, 403);
});

test("native edit failures roll back staged files and JSON archives remap the copied image graph", async () => {
  const source = await upload(await sharp({ create: { width: 3000, height: 1500, channels: 3, background: "#8362ac" } }).jpeg().toBuffer());
  const native = (await api(`/wp-json/wp/v2/media/${source.id}`)).data;
  const inventory = await files(), count = (await pool.query("SELECT count(*)::int AS n FROM media")).rows[0].n;
  await pool.query("CREATE FUNCTION worldact_test_copy_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.title='controlled-copy-failure' THEN RAISE EXCEPTION 'controlled copy failure'; END IF; RETURN NEW; END $$");
  await pool.query("CREATE TRIGGER worldact_test_copy_fail BEFORE INSERT ON media FOR EACH ROW EXECUTE FUNCTION worldact_test_copy_fail()");
  try {
    const failed = await copy(source.id, { src: native.source_url, modifiers: [rotate()], title: "controlled-copy-failure" });
    assert.equal(failed.response.status, 500); assert.deepEqual(await files(), inventory); assert.equal((await pool.query("SELECT count(*)::int AS n FROM media")).rows[0].n, count);
  } finally { await pool.query("DROP TRIGGER worldact_test_copy_fail ON media"); await pool.query("DROP FUNCTION worldact_test_copy_fail()"); }
  const result = await copy(source.id, { src: native.source_url, modifiers: [rotate()] }); assert.equal(result.response.status, 201);
  const exported = (await api("/api/tools/export")).data, record = exported.media.find((row: any) => row.id === result.data.id);
  const names = new Set([record.filename, ...Object.values(record.derivatives), ...Object.values(record.sizes).map((value: any) => value.filename)]);
  const subset = { application: "WorldAct", version: 3, posts: [], media: [record], mediaFiles: exported.mediaFiles.filter((file: any) => names.has(file.filename)) };
  const imported = await api("/api/tools/import", "POST", subset); assert.equal(imported.response.status, 201, JSON.stringify(imported.data));
  const id = imported.data.mediaIds[0]; media.add(id); assert.notEqual(id, record.id);
  const restored = (await api(`/api/media/${id}`)).data.media;
  assert.notEqual(restored.filename, record.filename); assert.ok(restored.originalUploadUrl);
  assert.equal(restored.width, result.data.media_details.width); assert.equal(restored.height, result.data.media_details.height);
  assert.equal((await fetch(base + restored.url)).status, 200); assert.equal((await fetch(base + restored.originalUploadUrl)).status, 200);
});

test("editable source matching excludes arbitrary backups, origins and unsafe paths", () => {
  const item = { filename: "2026/01/full.png", derivatives: { "original-upload": "2026/01/raw.png", backup: "2026/01/old.png" }, sizes: { thumbnail: { filename: "2026/01/small.png" } } };
  for (const name of ["full", "raw", "small"]) assert.equal(matchesEditableMediaSource(`https://local.example/uploads/2026/01/${name}.png?cache=1`, item, "https://local.example/"), true);
  for (const src of ["https://foreign.example/uploads/2026/01/full.png", "/uploads/2026/01/old.png", "https://user:pass@local.example/uploads/2026/01/full.png", "/uploads/2026/01/full.png\n", "//local.example/uploads/2026/01/full.png"]) assert.equal(matchesEditableMediaSource(src, item, "https://local.example/"), false);
  assert.equal(matchesEditableMediaSource("/uploads/outside.png", { filename: "../outside.png" }, "https://local.example/"), false);
});

async function blocked(pid: number, fragment: string) {
  const end = Date.now() + 6000;
  do {
    const result = await pool.query("SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND $1=ANY(pg_blocking_pids(pid)) AND position($2 in query)>0", [pid, fragment]);
    if (result.rowCount) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  } while (Date.now() < end);
  assert.fail("Expected request waiting at " + fragment);
}

test("native copy takes the media lock before the requested parent, matching attachment updates and deletion", async () => {
  const source = await upload(await sharp({ create: { width: 20, height: 12, channels: 3, background: "green" } }).png().toBuffer());
  const native = (await api(`/wp-json/wp/v2/media/${source.id}`)).data;
  const parent = await api("/api/posts", "POST", { title: "Native image lock parent", type: "post", status: "draft" }); assert.equal(parent.response.status, 201); posts.add(parent.data.post.id);
  const locker = await pool.connect(); let waiting: ReturnType<typeof copy> | undefined;
  try {
    await locker.query("BEGIN"); await locker.query("SET LOCAL lock_timeout='750ms'");
    const pid = (await locker.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
    // Existing attachment updates and delete-with-content take this lock first.
    await locker.query("SELECT id FROM media WHERE id=$1 FOR UPDATE", [source.id]);
    waiting = copy(source.id, { src: native.source_url, modifiers: [rotate()], post: parent.data.post.id });
    await blocked(pid, "SELECT * FROM media WHERE id=$1 FOR SHARE");
    // A reversed copy implementation would already hold KEY SHARE on the post,
    // so this real conflicting row lock would time out and expose the cycle.
    await locker.query("SELECT id FROM posts WHERE id=$1 FOR UPDATE", [parent.data.post.id]);
    await locker.query("UPDATE media SET attached_post_id=$1 WHERE id=$2", [parent.data.post.id, source.id]);
    await locker.query("COMMIT");
    const result = await waiting; waiting = undefined;
    assert.equal(result.response.status, 201, JSON.stringify(result.data)); assert.equal(result.data.post, parent.data.post.id);
  } finally { await locker.query("ROLLBACK"); await waiting?.catch(() => {}); locker.release(); }
});

test("native copy rechecks actor role and credentials after waiting on its account lock", async () => {
  const source = await upload(await sharp({ create: { width: 20, height: 12, channels: 3, background: "purple" } }).png().toBuffer());
  const native = (await api(`/wp-json/wp/v2/media/${source.id}`)).data;
  for (const change of ["role", "session"] as const) {
    const stamp = "image-wait-" + change + "-" + Date.now().toString(36), password = "Temporary-image-" + stamp;
    const created = await api("/api/users", "POST", { username: stamp, displayName: "Waiting image editor", email: stamp + "@example.test", role: "editor", password });
    assert.equal(created.response.status, 201); users.add(created.data.user.id);
    const login = await api("/api/auth/login", "POST", { login: stamp, password }, ""); assert.equal(login.response.status, 200);
    const actor = login.response.headers.get("set-cookie")!.split(";")[0];
    const inventory = await files(), locker = await pool.connect(); let waiting: ReturnType<typeof copy> | undefined;
    try {
      await locker.query("BEGIN"); const pid = (await locker.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
      await locker.query("SELECT id FROM users WHERE id=$1 FOR UPDATE", [created.data.user.id]);
      waiting = copy(source.id, { src: native.source_url, modifiers: [rotate()] }, actor);
      await blocked(pid, "SELECT id,role FROM users WHERE id=$1 FOR SHARE");
      if (change === "role") await locker.query("UPDATE users SET role='contributor' WHERE id=$1", [created.data.user.id]);
      else await locker.query("DELETE FROM sessions WHERE user_id=$1", [created.data.user.id]);
      await locker.query("COMMIT");
      const result = await waiting; waiting = undefined;
      assert.equal(result.response.status, change === "role" ? 403 : 401); assert.deepEqual(await files(), inventory);
    } finally { await locker.query("ROLLBACK"); await waiting?.catch(() => {}); locker.release(); }
  }
});

test("native image copies support authenticated application passwords without browser cookies or Origin", async () => {
  const source = await upload(await sharp({ create: { width: 20, height: 12, channels: 3, background: "orange" } }).png().toBuffer());
  const native = (await api(`/wp-json/wp/v2/media/${source.id}`)).data;
  const created = await api("/api/profile/application-passwords", "POST", { name: "Native image copy test" }); assert.equal(created.response.status, 201);
  const uuid = created.data.applicationPassword.uuid;
  try {
    const authorization = "Basic " + Buffer.from(process.env.ADMIN_EMAIL + ":" + created.data.password).toString("base64");
    const response = await fetch(base + `/wp-json/wp/v2/media/${source.id}/edit`, { method: "POST", signal: AbortSignal.timeout(12000), headers: { "Content-Type": "application/json", Authorization: authorization }, body: JSON.stringify({ src: native.source_url, modifiers: [rotate()] }) });
    const data = await response.json(); assert.equal(response.status, 201, JSON.stringify(data)); media.add(data.id);
    assert.equal(response.headers.get("set-cookie"), null); assert.equal(data.media_details.width, 12); assert.equal(data.media_details.height, 20);
  } finally { await api(`/api/profile/application-passwords/${uuid}`, "DELETE"); }
});
