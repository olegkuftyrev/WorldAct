import "dotenv/config";
import assert from "node:assert/strict";
import test, { after } from "node:test";
import { DOMParser } from "linkedom";
import { inspectAudio } from "../server/audio-metadata.js";
import { pool } from "../server/db.js";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { EventEmitter } from "node:events";

after(async () => { await pool.end(); });
const chunk = (name: string, data: Buffer) => { const head = Buffer.alloc(8); head.write(name); head.writeUInt32LE(data.length, 4); return Buffer.concat([head, data, ...(data.length % 2 ? [Buffer.alloc(1)] : [])]); };
function wave(tags: Record<string, string> = {}) {
  const format = Buffer.alloc(16); format.writeUInt16LE(1, 0); format.writeUInt16LE(1, 2); format.writeUInt32LE(8000, 4); format.writeUInt32LE(16000, 8); format.writeUInt16LE(2, 12); format.writeUInt16LE(16, 14);
  const info = Object.keys(tags).length ? chunk("LIST", Buffer.concat([Buffer.from("INFO"), ...Object.entries(tags).map(([name, value]) => chunk(name, Buffer.from(value + "\0")))])) : Buffer.alloc(0);
  const body = Buffer.concat([Buffer.from("WAVE"), chunk("fmt ", format), info, chunk("data", Buffer.alloc(32000))]), head = Buffer.alloc(8); head.write("RIFF"); head.writeUInt32LE(body.length, 4);
  return Buffer.concat([head, body]);
}

test("bounded local audio parser extracts real RIFF duration, tags and technical metadata", async () => {
  const bytes = wave({ INAM: "Tagged title", IART: "Tagged artist", IPRD: "Tagged album", ICRD: "2024" });
  const metadata = await inspectAudio(bytes, "audio/wav");
  assert.equal(metadata.title, "Tagged title"); assert.equal(metadata.artist, "Tagged artist"); assert.equal(metadata.album, "Tagged album"); assert.equal(metadata.year, 2024);
  assert.equal(metadata.length, 2); assert.equal(metadata.length_formatted, "0:02"); assert.equal(metadata.sample_rate, 8000); assert.equal(metadata.channels, 1); assert.equal(metadata.bits_per_sample, 16); assert.equal(metadata.filesize, bytes.length);
  assert.equal(metadata.mime_type, "audio/wav"); assert.equal(metadata.lossless, true);
});

test("audio metadata strips active tags, ignores nonaudio, fails malformed data closed and bounds concurrency", async () => {
  const metadata = await inspectAudio(wave({ INAM: '<script>bad()</script>Safe title', IART: '<img src="https://evil.invalid" onerror="bad()">Safe artist', IPRD: "<strong>Safe album</strong>" }), "audio/wav");
  assert.equal(metadata.title, "Safe title"); assert.equal(metadata.artist, "Safe artist"); assert.equal(metadata.album, "Safe album");
  assert.doesNotMatch(JSON.stringify(metadata), /<|bad\(\)|evil\.invalid|onerror/);
  assert.deepEqual(await inspectAudio(Buffer.from("No audio"), "image/png"), {});
  assert.deepEqual(await inspectAudio(Buffer.from("RIFF\xff\xff\xff\xffWAVEfmt "), "audio/wav"), {});
  await assert.rejects(inspectAudio(Buffer.alloc(0), "audio/wav"), /1 byte to 32 MiB/);
  await assert.rejects(inspectAudio(Buffer.alloc(32 * 1024 * 1024 + 1), "audio/wav"), /1 byte to 32 MiB/);
  const results = await Promise.allSettled([inspectAudio(wave(), "audio/wav"), inspectAudio(wave(), "audio/wav"), inspectAudio(wave(), "audio/wav")]);
  assert.equal(results.filter(result => result.status === "fulfilled").length, 2);
  assert.ok(results.some(result => result.status === "rejected" && /Two audio files/.test(result.reason.message)));
  assert.equal((await inspectAudio(wave(), "audio/wav")).length, 2, "Worker completion releases the parser reservation");
});

test("audio parser reservations outlive message/error results until workers physically exit", async () => {
  const threads = createRequire(import.meta.url)("node:worker_threads"), original = threads.Worker;
  let live = 0, maximum = 0;
  const workers: DelayedWorker[] = [];
  class DelayedWorker extends EventEmitter {
    finish?: () => void;
    constructor() { super(); workers.push(this); maximum = Math.max(maximum, ++live); queueMicrotask(() => workers.indexOf(this) === 1 ? this.emit("error", new Error("Controlled parser failure")) : this.emit("message", { length: 2, length_formatted: "0:02" })); }
    terminate() { return new Promise<number>((resolve, reject) => { this.finish = () => { live--; this.emit("exit", 0); resolve(0); }; if (workers.indexOf(this) === 2) reject(new Error("Controlled termination failure")); }); }
  }
  const pending: Promise<unknown>[] = [];
  try {
    threads.Worker = DelayedWorker; syncBuiltinESMExports();
    let settled = 0;
    const first = inspectAudio(wave(), "audio/wav").then(value => { settled++; return value; }); pending.push(first);
    const second = inspectAudio(wave(), "audio/wav").then(value => { settled++; return value; }); pending.push(second);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(workers.length, 2); assert.equal(live, 2); assert.equal(settled, 0, "Neither successful nor failed parsing finishes before termination");
    await assert.rejects(inspectAudio(wave(), "audio/wav"), /Two audio files/);
    assert.equal(workers.length, 2); assert.equal(maximum, 2);
    workers[0].finish!(); assert.equal((await first).length, 2);
    const third = inspectAudio(wave(), "audio/wav"); pending.push(third); await new Promise(resolve => setImmediate(resolve));
    assert.equal(live, 2); assert.equal(maximum, 2);
    assert.deepEqual(await third, {}, "Termination failure returns no metadata");
    await assert.rejects(inspectAudio(wave(), "audio/wav"), /Two audio files/, "A failed termination retains its live worker reservation");
    workers[1].finish!(); workers[2].finish!(); assert.deepEqual(await second, {});
    assert.equal(live, 0); assert.equal(maximum, 2);
  } finally {
    for (const worker of workers) if (worker.finish) { const finish = worker.finish; worker.finish = undefined; if (worker.listenerCount("exit")) finish(); }
    await Promise.allSettled(pending); threads.Worker = original; syncBuiltinESMExports();
  }
});

test("real audio uploads expose native metadata and archive copies recompute it from verified bytes", async () => {
  const base = process.env.TEST_API_URL || "http://127.0.0.1:3001", origin = process.env.APP_ORIGIN || "http://127.0.0.1:5173";
  let cookie = ""; const media: number[] = [], posts: number[] = [];
  const api = async (path: string, method = "GET", body?: unknown) => {
    const response = await fetch(base + path, { method, headers: { Origin: origin, "Content-Type": "application/json", ...(cookie ? { Cookie: cookie } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { response, data: await response.json() };
  };
  try {
    const signed = await api("/api/auth/login", "POST", { login: process.env.ADMIN_EMAIL, password: process.env.ADMIN_PASSWORD }); assert.equal(signed.response.status, 200); cookie = signed.response.headers.get("set-cookie")!.split(";")[0];
    const bytes = wave({ INAM: "Native tagged title", IART: "Native artist", IPRD: "Native album" });
    const form = new FormData(); form.append("file", new Blob([new Uint8Array(bytes)], { type: "audio/wav" }), "untagged-filename.wav");
    const uploaded = await fetch(base + "/api/media", { method: "POST", headers: { Origin: origin, Cookie: cookie }, body: form }); const item = (await uploaded.json()).media; assert.equal(uploaded.status, 201); media.push(item.id);
    assert.equal(item.title, "Native tagged title"); assert.equal(item.audioMetadata.artist, "Native artist"); assert.equal(item.audioMetadata.length_formatted, "0:02");
    const wp = await api(`/wp-json/wp/v2/media/${item.id}`); assert.equal(wp.response.status, 200); assert.equal(wp.data.media_details.artist, "Native artist"); assert.equal(wp.data.media_details.album, "Native album"); assert.equal(wp.data.media_details.length, 2); assert.equal(wp.data.media_details.length_formatted, "0:02");
    const fetched = await fetch(base + item.url); assert.equal(fetched.status, 200); assert.deepEqual(Buffer.from(await fetched.arrayBuffer()), bytes);
    const raw = `<!-- wp:playlist --><figure class="wp-block-playlist"><ol class="wp-block-playlist__tracklist"><!-- wp:playlist-track ${JSON.stringify({ id: item.id, src: item.url, title: item.title, artist: item.audioMetadata.artist, album: item.audioMetadata.album, length: item.audioMetadata.length_formatted })} /--></ol></figure><!-- /wp:playlist -->`;
    const created = await api("/api/posts", "POST", { title: "Audio archive " + Date.now(), status: "publish", content: raw }); assert.equal(created.response.status, 201); posts.push(created.data.post.id);
    const archive = (await api("/api/tools/export")).data, record = archive.media.find((row: any) => row.id === item.id);
    const imported = await api("/api/tools/import", "POST", { application: "WorldAct", version: 3, media: [{ ...record, audio_metadata: { title: "Forged", artist: "Forged", length: 999999999999, path: "/etc/passwd" } }], mediaFiles: archive.mediaFiles.filter((file: any) => file.filename === item.filename), posts: archive.posts.filter((post: any) => post.id === posts[0]) });
    assert.equal(imported.response.status, 201, JSON.stringify(imported.data)); media.push(...imported.data.mediaIds); posts.push(...imported.data.postIds);
    const copy = (await api(`/api/media/${imported.data.mediaIds[0]}`)).data.media; assert.notEqual(copy.filename, item.filename); assert.equal(copy.audioMetadata.artist, "Native artist"); assert.equal(copy.audioMetadata.length, 2); assert.equal(copy.audioMetadata.path, undefined);
    const copiedPost = (await api(`/api/posts/${imported.data.postIds[0]}`)).data.post;
    assert.match(copiedPost.rawContent, new RegExp('"id":' + copy.id)); assert.ok(copiedPost.rawContent.includes(copy.url)); assert.ok(!copiedPost.rawContent.includes(item.url));
    const publicCopy = (await api(`/api/public/posts/${copiedPost.slug}`)).data.post;
    const output = new DOMParser().parseFromString("<html><body>" + publicCopy.content + "</body></html>", "text/html"); assert.equal(output.querySelector("audio")!.getAttribute("src"), copy.url);
  } finally {
    for (const id of posts) { await api(`/api/posts/${id}`, "PUT", { status: "trash" }); await api(`/api/posts/${id}`, "DELETE"); }
    for (const id of media) await api(`/api/media/${id}`, "DELETE");
    if (cookie) await api("/api/auth/logout", "POST", {});
  }
});
