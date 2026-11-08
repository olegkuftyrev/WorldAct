import NativePlayer from "@arraypress/waveform-player/dist/waveform-player-no-autoinit.esm.js";
import type {
  WaveformPlayerOptions,
  WaveformPeaks,
} from "@arraypress/waveform-player";
import {
  analyzeWaveform,
  audioMetadata,
  waveformLimits,
} from "./waveformAnalysis";
const jobs = new WeakMap<
  object,
  {
    abort: AbortController;
    timer: ReturnType<typeof setTimeout>;
  }
>();
const dispose = (owner: object) => {
  const job = jobs.get(owner);
  if (job) {
    clearTimeout(job.timer);
    job.abort.abort();
    jobs.delete(owner);
  }
};
/** Keep the installed native player/controls; replace only unbounded peak I/O. */
export default class BoundedWaveformPlayer extends NativePlayer {
  declare audio: HTMLAudioElement | null;
  constructor(
    element: HTMLElement,
    options: Partial<WaveformPlayerOptions> = {},
  ) {
    super(element, {
      ...options,
      preload: "none",
      waveform: [0],
      onError: (reason, player) => {
        player.container.dispatchEvent(
          new CustomEvent("worldact:waveform-error"),
        );
        options.onError?.(reason, player);
      },
    });
  }
  override setWaveformData(peaks: WaveformPeaks) {
    const safe =
      Array.isArray(peaks) &&
      peaks.length <= 4096 &&
      peaks.every(
        (value) =>
          typeof value === "number" &&
          Number.isFinite(value) &&
          value >= 0 &&
          value <= 1,
      )
        ? peaks
        : [0];
    return super.setWaveformData(safe);
  }
  override loadTrack(
    url: string,
    title?: string | null,
    artist?: string | null,
    options: WaveformPlayerOptions = {},
  ) {
    return super.loadTrack(url, title, artist, {
      ...options,
      preload: "none",
      waveform: [0],
    });
  }
  override load(url: string): Promise<void> {
    dispose(this);
    const abort = new AbortController(),
      timer = setTimeout(() => {
        abort.abort(
          new DOMException("Waveform analysis timed out.", "TimeoutError"),
        );
        if (jobs.get(this) === job)
          this.container.dispatchEvent(
            new CustomEvent("worldact:waveform-analysis", {
              detail: { state: "unavailable" },
            }),
          );
      }, waveformLimits.timeout);
    const job = { abort, timer };
    jobs.set(this, job);
    // Base loadTrack captures its load ticket immediately after this call.
    this.container.dataset.worldactWaveformState = "pending";
    this.options.waveform = [0];
    if (this.audio) this.audio.preload = "none";
    const loaded = super.load(url);
    const finish = (state: string) => {
      if (!abort.signal.aborted && jobs.get(this) === job)
        this.container.dispatchEvent(
          new CustomEvent("worldact:waveform-analysis", { detail: { state } }),
        );
    };
    void (async () => {
      try {
        await loaded;
        abort.signal.throwIfAborted();
        const target = new URL(url, window.location.href);
        if (
          !["http:", "https:"].includes(target.protocol) &&
          !(
            target.protocol === "blob:" &&
            target.origin === window.location.origin
          )
        )
          throw new Error("Audio URL is unavailable.");
        if (!this.audio) throw new Error("Audio is unavailable.");
        const duration = await audioMetadata(this.audio, abort.signal);
        const AudioCtx = window.AudioContext;
        if (!AudioCtx) throw new Error("Waveform analysis is unavailable.");
        const peaks = await analyzeWaveform(
          target.href,
          duration,
          abort.signal,
          NativePlayer.utils.extractPeaks,
          {
            fetch: window.fetch.bind(window),
            createContext: () => new AudioCtx({ sampleRate: 8000 }),
          },
        );
        abort.signal.throwIfAborted();
        if (jobs.get(this) !== job) return;
        this.setWaveformData(peaks);
        this.container.dataset.worldactWaveformState = "ready";
        this.container.dataset.worldactWaveformSamples = String(peaks.length);
        this.container.classList.remove("waveform-is-placeholder");
        finish("ready");
      } catch (reason) {
        if (jobs.get(this) === job) {
          this.container.classList.add("waveform-is-placeholder");
          this.container.dataset.worldactWaveformState = "unavailable";
          if (!abort.signal.aborted) finish("unavailable");
        }
      } finally {
        clearTimeout(timer);
        if (jobs.get(this) === job) jobs.delete(this);
      }
    })();
    return loaded;
  }
  override destroy() {
    dispose(this);
    super.destroy();
  }
}
