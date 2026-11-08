import { initWaveformPlayer } from "@wordpress/block-library/build-module/utils/waveform-utils.mjs";
import type WaveformPlayer from "@arraypress/waveform-player";
export type PlaylistTrack = {
  url: string;
  title: string;
  artist: string;
  album: string;
  image: string;
  imageAlt: string;
  ariaLabel: string;
};
type Player = {
  instance: Pick<WaveformPlayer, "play" | "pause" | "isPlaying">;
  container: HTMLElement;
  destroy: () => void;
};
export type PlaylistFactory = (
  host: HTMLElement,
  options: Record<string, unknown>,
) => Player;
function listen(
  target: EventTarget,
  type: string,
  handler: EventListener,
  signal: AbortSignal,
) {
  if (signal.aborted) return;
  target.addEventListener(type, handler);
  signal.addEventListener(
    "abort",
    () => target.removeEventListener(type, handler),
    { once: true },
  );
}
const mounted = new WeakMap<
  HTMLElement,
  {
    users: number;
    cleanup: () => void;
  }
>();
function safeURL(value: unknown, origin: string) {
  if (
    typeof value !== "string" ||
    value.length > 8192 ||
    /[\u0000-\u0020<>"'\\]/.test(value) ||
    value.startsWith("//")
  )
    return "";
  try {
    const url = new URL(value, origin);
    return ["http:", "https:"].includes(url.protocol) &&
      !url.username &&
      !url.password
      ? url.href
      : "";
  } catch {
    return "";
  }
}
export function readPlaylistTracks(
  value: string | null,
  origin: string,
): PlaylistTrack[] {
  if (!value || value.length > 2 * 1024 * 1024) return [];
  try {
    const tracks: unknown = JSON.parse(value);
    if (!Array.isArray(tracks) || !tracks.length || tracks.length > 5000)
      return [];
    return tracks.map((track) => {
      if (!track || typeof track !== "object") throw Error();
      const text = (key: string) =>
        typeof track[key] === "string" ? track[key].slice(0, 10000) : "";
      return {
        url: safeURL(track.url, origin),
        title: text("title"),
        artist: text("artist"),
        album: text("album"),
        image: safeURL(track.image, origin),
        imageAlt: text("imageAlt"),
        ariaLabel: text("ariaLabel") || text("title") || "Audio track",
      };
    });
  } catch {
    return [];
  }
}
function mount(figure: HTMLElement, factory: PlaylistFactory): () => void {
  const document = figure.ownerDocument,
    origin = document.defaultView?.location.href || "http://localhost/",
    tracks = readPlaylistTracks(
      figure.getAttribute("data-worldact-playlist"),
      origin,
    );
  const local = (selector: string) =>
    [...figure.querySelectorAll<HTMLElement>(selector)].filter(
      (node) => node.closest("[data-worldact-playlist]") === figure,
    );
  const host = local(".wp-block-playlist__waveform-player")[0],
    fallback = local("[data-worldact-playlist-fallback]")[0];
  const audio = fallback?.querySelector<HTMLAudioElement>("audio"),
    buttons = local("button[data-worldact-playlist-track]");
  const first = tracks.findIndex((track) => !!track.url);
  if (!host || !fallback || !audio || first < 0) return () => {};
  const abort = new AbortController(),
    originalFallbackHidden = fallback.hidden,
    originalSrc = audio.getAttribute("src"),
    originalHostHidden = host.hidden;
  const originals = buttons.map((button) => ({
    button,
    current: button.getAttribute("aria-current"),
    label: button.getAttribute("aria-label"),
    action: button.querySelector("[data-worldact-playlist-action]")
      ?.textContent,
  }));
  let player: Player | null = null,
    playerListeners: AbortController | null = null,
    current = first,
    playing = false,
    position = 0,
    disposed = false,
    generation = 0;
  const labels = {
    play: host.dataset.labelPlay || "Play",
    pause: host.dataset.labelPause || "Pause",
  };
  const update = () => {
    for (const button of buttons) {
      const index = Number(button.dataset.worldactPlaylistTrack),
        selected = index === current,
        action = selected && playing ? labels.pause : labels.play;
      button.setAttribute("aria-current", String(selected));
      if (tracks[index])
        button.setAttribute(
          "aria-label",
          `${action} ${tracks[index].ariaLabel}`,
        );
      const text = button.querySelector("[data-worldact-playlist-action]");
      if (text) text.textContent = action;
    }
  };
  const playAudio = () => {
    void audio.play().catch(() => {
      playing = false;
      update();
    });
  };
  const destroyPlayer = () => {
    playerListeners?.abort();
    playerListeners = null;
    const previous = player;
    player = null;
    previous?.destroy();
  };
  const fallbackToAudio = (ticket: number) => {
    if (disposed || ticket !== generation) return;
    const wasPlaying = playing,
      time = position;
    destroyPlayer();
    host.hidden = true;
    fallback.hidden = false;
    audio.src = tracks[current].url;
    audio.preload = "none";
    playing = false;
    update();
    if (time > 0) audio.currentTime = time;
    if (wasPlaying) playAudio();
  };
  const activate = (index: number, autoPlay: boolean) => {
    if (disposed || !tracks[index]?.url) return;
    const ticket = ++generation;
    destroyPlayer();
    audio.pause();
    current = index;
    playing = false;
    position = 0;
    host.hidden = false;
    fallback.hidden = false;
    audio.src = tracks[index].url;
    audio.preload = "none";
    update();
    const track = tracks[index],
      style = figure.dataset.worldactWaveformStyle;
    try {
      player = factory(host, {
        src: track.url,
        title: track.title,
        artist: track.artist,
        image: track.image,
        imageAlt: track.imageAlt,
        waveformStyle: [
          "bars",
          "mirror",
          "line",
          "blocks",
          "dots",
          "seekbar",
        ].includes(style || "")
          ? style
          : "bars",
        showPlayButtonArtwork:
          figure.dataset.worldactPlayButtonArtwork === "true",
        waveformColor: host.dataset.waveformPlayerColor,
        waveformGradient: host.dataset.waveformPlayerGradient,
        backgroundColor: host.dataset.waveformPlayerBackgroundColor,
        backgroundGradient: host.dataset.waveformPlayerBackgroundGradient,
        autoPlay,
        labels: {
          ...labels,
          seek: host.dataset.labelSeek || "Seek",
          seekValueText: host.dataset.labelSeekValue,
        },
        onEnded: () => {
          if (disposed || ticket !== generation) return;
          playing = false;
          update();
          const next = tracks.findIndex(
            (track, i) => i > current && !!track.url,
          );
          if (next >= 0) activate(next, true);
        },
      });
      playerListeners = new AbortController();
      const signal = playerListeners.signal;
      listen(
        player.container,
        "waveformplayer:ready",
        () => {
          if (ticket === generation && !disposed) fallback.hidden = true;
        },
        signal,
      );
      for (const event of [
        "waveformplayer:play",
        "waveformplayer:pause",
        "waveformplayer:ended",
      ])
        listen(
          player.container,
          event,
          () => {
            if (ticket === generation && !disposed) {
              playing = event === "waveformplayer:play";
              update();
            }
          },
          signal,
        );
      listen(
        player.container,
        "waveformplayer:timeupdate",
        (event) => {
          if (ticket === generation)
            position = (event as CustomEvent).detail?.currentTime || 0;
        },
        signal,
      );
      listen(
        player.container,
        "worldact:waveform-error",
        () => fallbackToAudio(ticket),
        signal,
      );
      listen(
        player.container,
        "worldact:waveform-analysis",
        (event) => {
          if ((event as CustomEvent).detail?.state === "unavailable")
            fallbackToAudio(ticket);
        },
        signal,
      );
    } catch {
      fallbackToAudio(ticket);
    }
  };
  for (const button of buttons)
    listen(
      button,
      "click",
      () => {
        if (disposed) return;
        const index = Number(button.dataset.worldactPlaylistTrack);
        if (!Number.isInteger(index) || !tracks[index]?.url) return;
        if (index !== current) {
          activate(index, true);
          return;
        }
        if (player) {
          if (player.instance.isPlaying) player.instance.pause();
          else
            void player.instance.play()?.catch(() => {
              playing = false;
              update();
            });
        } else if (audio.paused) playAudio();
        else audio.pause();
      },
      abort.signal,
    );
  for (const event of ["play", "pause", "ended"])
    listen(
      audio,
      event,
      () => {
        if (disposed || player) return;
        playing = event === "play";
        update();
        if (event === "ended") {
          const next = tracks.findIndex(
            (track, i) => i > current && !!track.url,
          );
          if (next >= 0) activate(next, true);
        }
      },
      abort.signal,
    );
  activate(first, false);
  return () => {
    disposed = true;
    generation++;
    abort.abort();
    destroyPlayer();
    audio.pause();
    if (originalSrc === null) audio.removeAttribute("src");
    else audio.setAttribute("src", originalSrc);
    audio.preload = "none";
    audio.load();
    fallback.hidden = originalFallbackHidden;
    host.hidden = originalHostHidden;
    for (const { button, current, label, action } of originals) {
      for (const [name, value] of [
        ["aria-current", current],
        ["aria-label", label],
      ]) {
        if (value === null) button.removeAttribute(name!);
        else button.setAttribute(name!, value!);
      }
      const text = button.querySelector("[data-worldact-playlist-action]");
      if (text && action !== undefined) text.textContent = action;
    }
  };
}
/** Only trusted server playlist data and fixed controls are enhanced. */
export function enhancePlaylists(
  root: ParentNode | null,
  factory: PlaylistFactory = initWaveformPlayer,
): () => void {
  if (!root) return () => {};
  const figures = [
    ...(root.nodeType === 1 &&
    (root as HTMLElement).matches("figure[data-worldact-playlist]")
      ? [root as HTMLElement]
      : []),
    ...root.querySelectorAll<HTMLElement>("figure[data-worldact-playlist]"),
  ];
  const releases: (() => void)[] = [];
  for (const figure of figures) {
    let state = mounted.get(figure);
    if (!state) {
      state = { users: 0, cleanup: mount(figure, factory) };
      mounted.set(figure, state);
    }
    state.users++;
    let released = false;
    releases.push(() => {
      if (released) return;
      released = true;
      if (--state!.users === 0) {
        state!.cleanup();
        mounted.delete(figure);
      }
    });
  }
  return () => {
    for (const release of releases) release();
  };
}
