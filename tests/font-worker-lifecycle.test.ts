import test, { after } from "./isolated-test.js";
import "dotenv/config";
import assert from "node:assert/strict";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { EventEmitter } from "node:events";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { inspectFont, bundledFontCollection } from "../server/fonts.js";
import { pool, rootDir } from "../server/db.js";

after(async () => { await pool.end(); });

test("font parser reservations follow physical worker exits through delayed and failed termination", async () => {
  const bytes = await readFile(path.join(rootDir, "public", bundledFontCollection[0].faces[0].url));
  const verified = await inspectFont(bytes);
  const require = createRequire(import.meta.url), threads = require("node:worker_threads"), OriginalWorker = threads.Worker;
  let live = 0, maximum = 0;
  const workers: ControlledWorker[] = [];
  class ControlledWorker extends EventEmitter {
    resolveTermination!: (code: number) => void;
    rejectTermination!: (error: Error) => void;
    termination = new Promise<number>((resolve, reject) => { this.resolveTermination = resolve; this.rejectTermination = reject; });
    beginTermination!: () => void;
    startedTermination = new Promise<void>(resolve => { this.beginTermination = resolve; });
    exited = false;
    constructor() { super(); workers.push(this); live++; maximum = Math.max(maximum, live); }
    terminate() { this.beginTermination(); return this.termination; }
    exit() { if (!this.exited) { this.exited = true; live--; this.emit("exit", 0); } }
    stop() { this.exit(); this.resolveTermination(0); }
  }
  threads.Worker = ControlledWorker;
  syncBuiltinESMExports();
  const start = () => {
    let settled = false;
    const result: Promise<{ value?: Awaited<ReturnType<typeof inspectFont>>; error?: any }> = inspectFont(bytes).then(value => ({ value }), error => ({ error })).finally(() => { settled = true; });
    return { result, settled: () => settled };
  };
  try {
    const first = start(), second = start();
    workers[0].emit("message", { ok: true, metadata: verified.metadata });
    workers[1].emit("message", { ok: false, error: "Rejected fixture font." });
    await Promise.all(workers.map(worker => worker.startedTermination));
    assert.equal(first.settled(), false); assert.equal(second.settled(), false);
    assert.equal((await start().result).error.status, 503);
    assert.equal(live, 2);
    workers[0].stop();
    assert.deepEqual((await first.result).value, verified);
    const third = start();
    assert.equal(live, 2);
    workers[2].emit("message", { ok: true, metadata: verified.metadata });
    await workers[2].startedTermination;
    workers[2].rejectTermination(new Error("Controlled termination failure"));
    assert.match((await third.result).error.message, /could not be verified safely/);
    assert.equal((await start().result).error.status, 503, "A termination rejection cannot release a still-live worker");
    workers[2].exit();
    const fourth = start();
    assert.equal(live, 2);
    workers[3].emit("message", { ok: true, metadata: verified.metadata });
    await workers[3].startedTermination;
    workers[3].stop();
    assert.deepEqual((await fourth.result).value, verified);
    workers[1].stop();
    assert.match((await second.result).error.message, /Rejected fixture font/);
    assert.equal(maximum, 2); assert.equal(live, 0);
    threads.Worker = class { constructor() { throw new Error("Controlled worker constructor failure"); } };
    syncBuiltinESMExports();
    await assert.rejects(inspectFont(bytes), /Controlled worker constructor failure/);
  } finally {
    for (const worker of workers) worker.stop();
    threads.Worker = OriginalWorker;
    syncBuiltinESMExports();
  }
  assert.equal((await inspectFont(bytes)).metadata.family, verified.metadata.family, "All reservations are reusable after real exits");
});

test("real font workers enforce two concurrent inspections and release successful reservations", async () => {
  const bytes = await readFile(path.join(rootDir, "public", bundledFontCollection[0].faces[0].url));
  const results = await Promise.allSettled([inspectFont(bytes), inspectFont(bytes), inspectFont(bytes)]);
  assert.equal(results.filter(result => result.status === "fulfilled").length, 2);
  assert.ok(results.some(result => result.status === "rejected" && result.reason.status === 503));
  assert.ok((await inspectFont(bytes)).metadata.numGlyphs > 0);
});
