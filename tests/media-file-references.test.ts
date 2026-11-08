import test, { after } from "./isolated-test.js";
import "dotenv/config";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { pool, uploadsDir } from "../server/db.js";
import { unlinkUnreferencedMediaFiles } from "../server/media-files.js";

const base = process.env.TEST_API_URL || "http://127.0.0.1:3001";
const origin = process.env.APP_ORIGIN || "http://127.0.0.1:5173";
after(async () => { await pool.end(); });

async function api(route: string, method = "GET", body?: unknown, cookie = "") {
  const response = await fetch(base + route, { method, headers: { Origin: origin, "Content-Type": "application/json", ...(cookie ? { Cookie: cookie } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { response, data: await response.json() };
}
const filenames = (row: any): string[] => [...new Set<string>([
  row.filename, row.original_filename, ...Object.values(row.derivatives || {}),
  ...Object.values(row.sizes || {}).map((size: any) => size.filename),
].filter((name): name is string => typeof name === "string"))];

// A second-batch failure must also preserve files cleared by the first read.
test("unverifiable media ownership retains every candidate and bounds reference reads", async () => {
  await mkdir(uploadsDir, { recursive: true });
  const directory = await mkdtemp(path.join(uploadsDir, "reference-check-"));
  const prefix = path.relative(uploadsDir, directory) + "/";
  const candidates = Array.from({ length: 257 }, (_, i) => prefix + i + ".txt");
  await writeFile(path.join(uploadsDir, candidates[0]), "keep first");
  await writeFile(path.join(uploadsDir, candidates[256]), "keep last");
  let reads = 0;
  const database = { query: async (_sql: string, params: string[][]) => {
    assert.ok(params[0].length <= 256);
    assert.ok(params[0].every(name => name.startsWith(prefix)));
    if (++reads === 2) throw new Error("Controlled unavailable reference lookup");
    return { rows: [] };
  } };
  try {
    await unlinkUnreferencedMediaFiles([...candidates, candidates[0], "../outside.txt", "/outside.txt", null], database as any);
    assert.equal(reads, 2);
    assert.equal(await readFile(path.join(uploadsDir, candidates[0]), "utf8"), "keep first");
    assert.equal(await readFile(path.join(uploadsDir, candidates[256]), "utf8"), "keep last");
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("archive aliases retain current, original, derivative and size files until their last media deletion", async () => {
  const stamp = "shared-files-" + Date.now().toString(36);
  let cookie = "", accountId: number | undefined;
  const media = new Set<number>();
  try {
    const login = await api("/api/auth/login", "POST", { login: process.env.ADMIN_EMAIL, password: process.env.ADMIN_PASSWORD });
    assert.equal(login.response.status, 200); cookie = login.response.headers.get("set-cookie")!.split(";")[0];
    // Exercise real generated sizes now that unchanged/tiny copies are omitted.
    const image = await sharp({ create: { width: 1200, height: 800, channels: 3, background: "#2658aa" } }).png().toBuffer();
    const form = new FormData(); form.append("file", new Blob([new Uint8Array(image)], { type: "image/png" }), stamp + ".png");
    const upload = await fetch(base + "/api/media", { method: "POST", headers: { Origin: origin, Cookie: cookie }, body: form });
    const uploaded = await upload.json(); assert.equal(upload.status, 201); media.add(uploaded.media.id);
    const edited = await api(`/api/media/${uploaded.media.id}/edit`, "POST", { rotate: 90 }, cookie); assert.equal(edited.response.status, 200);
    const exported = (await api("/api/tools/export", "GET", undefined, cookie)).data;
    const record = exported.media.find((item: any) => item.id === uploaded.media.id);
    assert.ok(record.original_filename); assert.ok(Object.keys(record.derivatives).length); assert.equal(Object.keys(record.sizes).length, 3);
    const names = new Set(filenames(record));
    const files = exported.mediaFiles.filter((file: any) => names.has(file.filename));
    assert.equal(files.length, names.size);
    const copy = async () => {
      // Current filenames are unique, but original/history/size references can
      // legitimately share bytes with another attachment's current file.
      const alias = { ...record, id: 2147483000, title: stamp + " alias", filename: record.original_filename, derivatives: { ...record.derivatives, "shared-current": record.filename } };
      const imported = await api("/api/tools/import", "POST", { application: "WorldAct", version: 3, posts: [], media: [record, alias], mediaFiles: files }, cookie);
      assert.equal(imported.response.status, 201, JSON.stringify(imported.data));
      const ids: number[] = imported.data.mediaIds; ids.forEach(id => media.add(id)); assert.equal(ids.length, 2);
      const rows = (await pool.query("SELECT * FROM media WHERE id=ANY($1::int[]) ORDER BY id", [ids])).rows;
      assert.notEqual(rows[0].filename, rows[1].filename);
      assert.equal(rows[0].original_filename, rows[1].original_filename);
      assert.equal(rows[1].derivatives["shared-current"], rows[0].filename);
      assert.equal(rows[0].original_filename, rows[1].filename);
      assert.deepEqual(rows[0].sizes, rows[1].sizes);
      assert.deepEqual(new Set(filenames(rows[0])), new Set(filenames(rows[1])));
      return { ids, names: filenames(rows[0]) };
    };
    const checkFiles = async (names: string[], status: number) => {
      for (const filename of names) assert.equal((await fetch(base + "/uploads/" + filename)).status, status, filename);
    };
    const pair = await copy(); await checkFiles(pair.names, 200);
    assert.equal((await api(`/api/media/${pair.ids[0]}`, "DELETE", undefined, cookie)).response.status, 200); media.delete(pair.ids[0]);
    assert.equal((await api(`/api/media/${pair.ids[1]}`, "GET", undefined, cookie)).response.status, 200); await checkFiles(pair.names, 200);
    assert.equal((await api(`/api/media/${pair.ids[1]}`, "DELETE", undefined, cookie)).response.status, 200); media.delete(pair.ids[1]); await checkFiles(pair.names, 404);

    const other = await copy();
    const account = await api("/api/users", "POST", { username: stamp, email: stamp + "@example.test", displayName: "Shared media owner", role: "author", password: "Temporary-shared-files-" + stamp }, cookie);
    assert.equal(account.response.status, 201); accountId = account.data.user.id;
    // Model a shared archived file whose two attachment rows now have different
    // owners. Account deletion must obey the same reference boundary as Media.
    await pool.query("UPDATE media SET author_id=$1 WHERE id=$2", [accountId, other.ids[0]]);
    assert.equal((await api(`/api/users/${accountId}?deleteContent=true`, "DELETE", undefined, cookie)).response.status, 200); accountId = undefined; media.delete(other.ids[0]);
    assert.equal((await api(`/api/media/${other.ids[1]}`, "GET", undefined, cookie)).response.status, 200); await checkFiles(other.names, 200);
    assert.equal((await api(`/api/media/${other.ids[1]}`, "DELETE", undefined, cookie)).response.status, 200); media.delete(other.ids[1]); await checkFiles(other.names, 404);
  } finally {
    for (const id of media) await api(`/api/media/${id}`, "DELETE", undefined, cookie);
    if (accountId) await api(`/api/users/${accountId}?deleteContent=true`, "DELETE", undefined, cookie);
    if (cookie) await api("/api/auth/logout", "POST", {}, cookie);
  }
});
