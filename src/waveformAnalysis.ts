import { boundedAudioFrames } from "./audioBounds";
/** Peak analysis is optional; native audio playback never depends on it. */
export const waveformLimits = {
  bytes: 8 * 1024 * 1024,
  duration: 600,
  pcmBytes: 32 * 1024 * 1024,
  concurrent: 2,
  timeout: 15000,
} as const;
const queue: {
  signal: AbortSignal;
  resolve: () => void;
  reject: (reason: unknown) => void;
  abort: () => void;
}[] = [];
let active = 0;
async function reserve(signal: AbortSignal) {
  signal.throwIfAborted();
  if (active < waveformLimits.concurrent) {
    active++;
    return;
  }
  await new Promise<void>((resolve, reject) => {
    const item = {
      signal,
      resolve,
      reject,
      abort: () => {
        const index = queue.indexOf(item);
        if (index >= 0) queue.splice(index, 1);
        reject(signal.reason);
      },
    };
    queue.push(item);
    signal.addEventListener("abort", item.abort, { once: true });
  });
}
function release() {
  active--;
  while (queue.length) {
    const item = queue.shift()!;
    item.signal.removeEventListener("abort", item.abort);
    if (item.signal.aborted) continue;
    active++;
    item.resolve();
    break;
  }
}
export async function readBoundedAudio(
  response: Response,
  signal: AbortSignal,
): Promise<ArrayBuffer> {
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error("Audio could not be read.");
  }
  const length = Number(response.headers.get("content-length"));
  if (length > waveformLimits.bytes) {
    await response.body?.cancel();
    throw new Error("Audio is too large for waveform analysis.");
  }
  if (!response.body) throw new Error("Audio stream is unavailable.");
  const reader = response.body.getReader(),
    chunks: Uint8Array[] = [];
  let size = 0;
  const abort = () => {
    void reader.cancel().catch(() => {});
  };
  signal.addEventListener("abort", abort, { once: true });
  try {
    while (true) {
      signal.throwIfAborted();
      const { done, value } = await reader.read();
      signal.throwIfAborted();
      if (done) break;
      size += value.byteLength;
      if (size > waveformLimits.bytes)
        throw new Error("Audio is too large for waveform analysis.");
      chunks.push(value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.length;
    }
    return bytes.buffer;
  } finally {
    signal.removeEventListener("abort", abort);
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
export async function analyzeWaveform(
  url: string,
  duration: number,
  signal: AbortSignal,
  extract: (buffer: AudioBuffer, samples: number) => number[],
  dependencies: {
    fetch: typeof fetch;
    createContext: () => AudioContext;
  },
): Promise<number[]> {
  if (
    !Number.isFinite(duration) ||
    duration <= 0 ||
    duration > waveformLimits.duration
  )
    throw new Error("Audio duration is outside waveform limits.");
  await reserve(signal);
  let context: AudioContext | undefined, closeTask: Promise<void> | undefined;
  const close = () => {
    if (context && !closeTask) closeTask = context.close().catch(() => {});
  };
  try {
    const bytes = await readBoundedAudio(
      await dependencies.fetch(url, {
        signal,
        credentials: "same-origin",
        mode: "cors",
      }),
      signal,
    );
    signal.throwIfAborted();
    if (!boundedAudioFrames(bytes, waveformLimits.pcmBytes))
      throw new Error("Audio is outside bounded waveform formats.");
    context = dependencies.createContext();
    if (context.sampleRate !== 8000)
      throw new Error("Bounded waveform sample rate is unavailable.");
    signal.addEventListener("abort", close, { once: true });
    try {
      const buffer = await context.decodeAudioData(bytes);
      signal.throwIfAborted();
      if (
        !Number.isSafeInteger(buffer.length) ||
        buffer.length <= 0 ||
        !Number.isInteger(buffer.numberOfChannels) ||
        buffer.numberOfChannels < 1 ||
        buffer.numberOfChannels > 8 ||
        !Number.isFinite(buffer.duration) ||
        buffer.duration <= 0 ||
        buffer.sampleRate !== 8000 ||
        buffer.length * buffer.numberOfChannels * 4 > waveformLimits.pcmBytes ||
        buffer.duration > waveformLimits.duration
      )
        throw new Error("Decoded audio exceeds waveform limits.");
      return extract(buffer, 300);
    } finally {
      signal.removeEventListener("abort", close);
    }
  } finally {
    close();
    await closeTask;
    release();
  }
}
export function audioMetadata(
  audio: HTMLAudioElement,
  signal: AbortSignal,
): Promise<number> {
  return new Promise((resolve, reject) => {
    const clean = () => {
      audio.removeEventListener("loadedmetadata", ready);
      audio.removeEventListener("error", failed);
      signal.removeEventListener("abort", aborted);
    };
    const ready = () => {
        clean();
        resolve(audio.duration);
      },
      failed = () => {
        clean();
        reject(new Error("Audio metadata is unavailable."));
      },
      aborted = () => {
        clean();
        reject(signal.reason);
      };
    if (signal.aborted) {
      aborted();
      return;
    }
    if (audio.readyState >= 1 && Number.isFinite(audio.duration)) {
      ready();
      return;
    }
    audio.addEventListener("loadedmetadata", ready, { once: true });
    audio.addEventListener("error", failed, { once: true });
    signal.addEventListener("abort", aborted, { once: true });
    audio.preload = "metadata";
    audio.load();
  });
}
