import test from "node:test";
import assert from "node:assert/strict";
import { boundedAudioFrames } from "../src/audioBounds.js";
import {
  analyzeWaveform,
  readBoundedAudio,
  waveformLimits,
} from "../src/waveformAnalysis.js";
function wave() {
  const b = Buffer.alloc(16044);
  b.write("RIFF");
  b.writeUInt32LE(b.length - 8, 4);
  b.write("WAVEfmt ", 8);
  b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20);
  b.writeUInt16LE(1, 22);
  b.writeUInt32LE(8000, 24);
  b.writeUInt32LE(16000, 28);
  b.writeUInt16LE(2, 32);
  b.writeUInt16LE(16, 34);
  b.write("data", 36);
  b.writeUInt32LE(16000, 40);
  return new Uint8Array(b).buffer;
}
test("preflight permits bounded complete PCM/MP3 frames and refuses unproved or huge decoded input", () => {
  assert.equal(boundedAudioFrames(wave(), 32 * 1024 * 1024), true);
  assert.equal(boundedAudioFrames(wave(), 100), false);
  assert.equal(
    boundedAudioFrames(new Uint8Array([1, 2]).buffer, 32 * 1024 * 1024),
    false,
  );
  const original = Buffer.from(wave()),
    fmt = Buffer.from(original.subarray(12, 36));
  fmt.writeUInt32LE(192000, 12);
  fmt.writeUInt32LE(768000, 16);
  fmt.writeUInt16LE(4, 20);
  fmt.writeUInt16LE(32, 22);
  const ambiguous = Buffer.concat([original, fmt]);
  ambiguous.writeUInt32LE(ambiguous.length - 8, 4);
  assert.equal(
    boundedAudioFrames(new Uint8Array(ambiguous).buffer, 32768),
    false,
    "duplicate format descriptors cannot understate the decoder allocation",
  );
  const trailing = Buffer.concat([original, Buffer.alloc(1)]);
  trailing.writeUInt32LE(trailing.length - 8, 4);
  assert.equal(
    boundedAudioFrames(new Uint8Array(trailing).buffer, 32 * 1024 * 1024),
    false,
  );
  const badRate = Buffer.from(original);
  badRate.writeUInt32LE(1, 28);
  assert.equal(
    boundedAudioFrames(new Uint8Array(badRate).buffer, 32 * 1024 * 1024),
    false,
  );
  const mixed = Buffer.alloc(417 + 384);
  mixed.writeUInt32BE(0xfffb9000, 0);
  mixed.writeUInt32BE(0xfffb9400, 417);
  assert.equal(
    boundedAudioFrames(new Uint8Array(mixed).buffer, 32 * 1024 * 1024),
    false,
    "a stream cannot change its decode geometry",
  );
  const mp3 = Buffer.alloc(417 * 3);
  for (let i = 0; i < 3; i++) mp3.writeUInt32BE(0xfffb9000, 417 * i);
  assert.equal(
    boundedAudioFrames(new Uint8Array(mp3).buffer, 32 * 1024 * 1024),
    true,
  );
  mp3.write("Xing", 36);
  mp3.writeUInt32BE(1, 40);
  mp3.writeUInt32BE(10000000, 44);
  assert.equal(
    boundedAudioFrames(new Uint8Array(mp3).buffer, 32 * 1024 * 1024),
    false,
  );
});
test("stream bounds reject both declared and chunked oversize before decode and cancel the stream", async () => {
  let canceled = 0;
  const response = new Response(
    new ReadableStream({
      start(c) {
        c.enqueue(new Uint8Array(2));
      },
      cancel() {
        canceled++;
      },
    }),
    { headers: { "content-length": String(waveformLimits.bytes + 1) } },
  );
  await assert.rejects(
    readBoundedAudio(response, new AbortController().signal),
    /too large/,
  );
  assert.equal(canceled, 1);
  const chunked = new Response(
    new ReadableStream({
      start(c) {
        c.enqueue(new Uint8Array(waveformLimits.bytes));
        c.enqueue(new Uint8Array(1));
      },
      cancel() {
        canceled++;
      },
    }),
  );
  await assert.rejects(
    readBoundedAudio(chunked, new AbortController().signal),
    /too large/,
  );
  assert.equal(canceled, 2);
});
test("aborted decode reservations remain held until actual decode and context close settle", async () => {
  const decodes: { done: (buffer: AudioBuffer) => void; closed: () => void }[] =
    [];
  let live = 0,
    max = 0;
  const deps = {
    fetch: async () => new Response(wave()),
    createContext: () => {
      live++;
      max = Math.max(max, live);
      let finishClose!: () => void;
      const closed = new Promise<void>(
        (r) =>
          (finishClose = () => {
            live--;
            r();
          }),
      );
      return {
        state: "running",
        sampleRate: 8000,
        decodeAudioData: () =>
          new Promise<AudioBuffer>((done) =>
            decodes.push({ done, closed: finishClose }),
          ),
        close: () => closed,
      } as unknown as AudioContext;
    },
  };
  const aborts = [
    new AbortController(),
    new AbortController(),
    new AbortController(),
  ];
  const pending = aborts.map((a) =>
    analyzeWaveform(
      "https://example.test/audio.wav",
      1,
      a.signal,
      () => [0, 1],
      deps as any,
    ).then(
      () => "ok",
      () => "aborted",
    ),
  );
  await new Promise((r) => setImmediate(r));
  assert.equal(decodes.length, 2);
  aborts[0].abort();
  await new Promise((r) => setImmediate(r));
  assert.equal(
    decodes.length,
    2,
    "aborting UI cannot release a running native decoder",
  );
  const buffer = {
    length: 8000,
    numberOfChannels: 1,
    duration: 1,
    sampleRate: 8000,
  } as AudioBuffer;
  decodes[0].done(buffer);
  await new Promise((r) => setImmediate(r));
  assert.equal(decodes.length, 2, "context close must also settle");
  decodes[0].closed();
  assert.equal(await pending[0], "aborted");
  await new Promise((r) => setImmediate(r));
  assert.equal(decodes.length, 3);
  assert.equal(max, 2);
  decodes[1].done(buffer);
  decodes[1].closed();
  decodes[2].done(buffer);
  decodes[2].closed();
  assert.deepEqual(await Promise.all(pending), ["aborted", "ok", "ok"]);
  assert.equal(live, 0);
});

test("WAV alternate size authorities must agree or decline analysis before decode", () => {
  const pcm = Buffer.from(wave());
  pcm.writeUInt16LE(3, 20);
  pcm.writeUInt16LE(32, 34);
  pcm.writeUInt16LE(4, 32);
  pcm.writeUInt32LE(32000, 28);
  const chunk = (name: string, data: Buffer) => {
    const b = Buffer.alloc(8 + data.length + (data.length & 1));
    b.write(name);
    b.writeUInt32LE(data.length, 4);
    data.copy(b, 8);
    return b;
  };
  const appended = (...chunks: Buffer[]) => {
    const result = Buffer.concat([pcm, ...chunks]);
    result.writeUInt32LE(result.length - 8, 4);
    return new Uint8Array(result).buffer;
  };
  const fact = Buffer.alloc(4);
  fact.writeUInt32LE(4000);
  assert.equal(
    boundedAudioFrames(appended(chunk("fact", fact)), 32 * 1024 * 1024),
    true,
  );
  const huge = Buffer.alloc(4);
  huge.writeUInt32LE(0xffffffff);
  assert.equal(
    boundedAudioFrames(appended(chunk("fact", huge)), 32 * 1024 * 1024),
    false,
    "fact cannot advertise a huge allocation over tiny data",
  );
  assert.equal(
    boundedAudioFrames(
      appended(chunk("fact", fact), chunk("fact", fact)),
      32 * 1024 * 1024,
    ),
    false,
  );
  for (const alternate of [
    chunk("ds64", Buffer.alloc(28)),
    chunk("LIST", Buffer.from("wavl")),
    chunk("slnt", huge),
    chunk("plst", huge),
  ]) {
    assert.equal(
      boundedAudioFrames(appended(alternate), 32 * 1024 * 1024),
      false,
      "unsupported alternate audio stays playable only through native fallback",
    );
  }
  assert.equal(
    boundedAudioFrames(
      appended(chunk("LIST", Buffer.from("INFO"))),
      32 * 1024 * 1024,
    ),
    true,
  );
});
