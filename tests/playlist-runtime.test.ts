import test from "./isolated-test.js";
import assert from "node:assert/strict";
import { parseHTML } from "linkedom";
import {
  enhancePlaylists,
  readPlaylistTracks,
  type PlaylistFactory,
} from "../src/playlists.js";
function fixture() {
  const tracks = [0, 1, 2].map((i) => ({
    url: `/track-${i}.wav`,
    title: `Track ${i}`,
    artist: "Artist",
    album: "Album",
    image: "",
    imageAlt: "",
    ariaLabel: `Track ${i} by Artist`,
  }));
  const figure = (id: string) =>
    `<figure id="${id}" data-worldact-playlist='${JSON.stringify(tracks)}' data-worldact-waveform-style="dots"><div class="wp-block-playlist__waveform-player"></div><div data-worldact-playlist-fallback><audio controls preload="none" src="/track-0.wav"></audio><a href="/track-1.wav">Track1</a></div><ol>${tracks.map((_, i) => `<li><button data-worldact-playlist-track="${i}" aria-current="${i === 0}"><span data-worldact-playlist-action>Play</span></button></li>`).join("")}</ol></figure>`;
  const { document, window } = parseHTML(
    `<html><body>${figure("a")}${figure("b")}</body></html>`,
  );
  Object.defineProperty(window, "location", {
    configurable: true,
    value: new URL("https://example.test/post/"),
  });
  const event = (node: Element, type: string, detail?: unknown) =>
    node.dispatchEvent(new window.CustomEvent(type, { bubbles: true, detail }));
  let nativePlays = 0;
  for (const audio of document.querySelectorAll("audio")) {
    let paused = true;
    Object.defineProperty(audio, "paused", { get: () => paused });
    audio.load = () => {};
    audio.pause = () => {
      paused = true;
      event(audio, "pause");
    };
    audio.play = async () => {
      paused = false;
      nativePlays++;
      event(audio, "play");
    };
  }
  const made: {
    host: HTMLElement;
    options: Record<string, any>;
    container: HTMLElement;
    destroyed: number;
    play: () => Promise<void>;
    pause: () => void;
    ready: () => void;
  }[] = [];
  const factory: PlaylistFactory = (host, options) => {
    const container = document.createElement("div") as unknown as HTMLElement;
    host.appendChild(container);
    const state = {
      isPlaying: false,
      play: async () => {
        state.isPlaying = true;
        event(container, "waveformplayer:play");
      },
      pause: () => {
        state.isPlaying = false;
        event(container, "waveformplayer:pause");
      },
    };
    const item = {
      host,
      options,
      container,
      destroyed: 0,
      play: state.play,
      pause: state.pause,
      ready: () => {
        event(container, "waveformplayer:ready");
        if (options.autoPlay) void state.play();
      },
    };
    made.push(item);
    return {
      instance: state,
      container,
      destroy: () => {
        item.destroyed++;
        container.remove();
      },
    };
  };
  return {
    document: document as unknown as Document,
    event,
    made,
    factory,
    nativePlays: () => nativePlays,
    get: (id: string) => document.getElementById(id)! as unknown as HTMLElement,
  };
}
test("playlist selection/playback/ended progression stay local and cleanup restores readable source fallback", () => {
  const f = fixture(),
    a = f.get("a"),
    b = f.get("b"),
    click = (root: HTMLElement, index: number) =>
      f.event(root.querySelectorAll("button")[index], "click");
  assert.equal(a.querySelector("[hidden]"), null);
  const cleanup = enhancePlaylists(f.document, f.factory);
  assert.equal(f.made.length, 2);
  assert.equal(f.made[0].options.waveformStyle, "dots");
  f.made[0].ready();
  assert.equal(
    (a.querySelector("[data-worldact-playlist-fallback]") as HTMLElement)
      .hidden,
    true,
  );
  assert.equal(
    (b.querySelector("[data-worldact-playlist-fallback]") as HTMLElement)
      .hidden,
    false,
  );
  click(a, 0);
  assert.match(
    a.querySelector("button")!.getAttribute("aria-label")!,
    /^Pause Track0? /,
  );
  click(a, 1);
  assert.equal(f.made[0].destroyed, 1);
  assert.equal(f.made.length, 3);
  assert.equal(f.made[2].options.autoPlay, true);
  f.made[2].ready();
  assert.equal(
    a.querySelectorAll("button")[1].getAttribute("aria-current"),
    "true",
  );
  assert.equal(b.querySelector("button")!.getAttribute("aria-current"), "true");
  f.made[2].options.onEnded();
  assert.equal(f.made.length, 4);
  assert.equal(f.made[3].options.title, "Track 2");
  f.made[2].options.onEnded();
  assert.equal(
    f.made.length,
    4,
    "stale callbacks cannot advance the replacement",
  );
  f.made[3].ready();
  f.made[3].options.onEnded();
  assert.equal(f.made.length, 4, "last track does not loop unexpectedly");
  cleanup();
  assert.equal(f.made[1].destroyed, 1);
  assert.equal(f.made[3].destroyed, 1);
  assert.equal(a.querySelector("[hidden]"), null);
  assert.equal(a.querySelector("audio")!.getAttribute("src"), "/track-0.wav");
  assert.equal(a.querySelector("button")!.getAttribute("aria-label"), null);
  const count = f.made.length;
  click(a, 1);
  assert.equal(f.made.length, count);
  assert.equal(f.nativePlays(), 0);
});
test("analysis/error failure retains real playable audio and leases prevent duplicate players", () => {
  const f = fixture(),
    a = f.get("a");
  const one = enhancePlaylists(a, f.factory),
    two = enhancePlaylists(a, f.factory);
  assert.equal(f.made.length, 1);
  f.made[0].ready();
  f.event(f.made[0].container, "worldact:waveform-analysis", {
    state: "unavailable",
  });
  assert.equal(f.made[0].destroyed, 1);
  assert.equal(
    (a.querySelector("[data-worldact-playlist-fallback]") as HTMLElement)
      .hidden,
    false,
  );
  f.event(a.querySelector("button")!, "click");
  assert.equal(f.nativePlays(), 1);
  one();
  assert.equal(f.made.length, 1);
  f.event(a.querySelectorAll("button")[1], "click");
  assert.equal(
    f.made.length,
    2,
    "another safe track can retry the waveform player",
  );
  two();
  assert.equal(f.made[1].destroyed, 1);
  f.event(a.querySelector("button")!, "click");
  assert.equal(f.nativePlays(), 1);
});
test("playlist data never interprets expressions and rejects unsafe source/artwork URLs", () => {
  const tracks = readPlaylistTracks(
    JSON.stringify([
      {
        url: "javascript:bad()",
        image: "//evil.test/p.png",
        title: "<script>bad()</script>",
      },
      {
        url: "https://user:pass@example.test/audio",
        image: "data:image/svg+xml,bad",
      },
      { url: "/safe.wav", image: "/cover.png" },
    ]),
    "https://example.test/",
  );
  assert.equal(tracks[0].url, "");
  assert.equal(tracks[0].image, "");
  assert.equal(tracks[0].title, "<script>bad()</script>");
  assert.equal(tracks[1].url, "");
  assert.equal(tracks[2].url, "https://example.test/safe.wav");
  assert.deepEqual(
    readPlaylistTracks('{"action":"alert(1)"}', "https://example.test"),
    [],
  );
});

test("missing artwork stays empty and empty track URLs never resolve to the page", () => {
  const f = fixture(),
    a = f.get("a");
  const tracks = JSON.parse(a.getAttribute("data-worldact-playlist")!);
  tracks[0].url = "";
  for (const track of tracks) track.image = "";
  a.setAttribute("data-worldact-playlist", JSON.stringify(tracks));
  const parsed = readPlaylistTracks(
    JSON.stringify(tracks),
    "https://example.test/post/",
  );
  assert.equal(parsed[0].url, "");
  assert.equal(parsed[1].image, "");
  assert.equal(
    readPlaylistTracks(
      JSON.stringify([{ url: "audio.wav", image: "" }]),
      "https://example.test/post/",
    )[0].url,
    "",
  );
  const cleanup = enhancePlaylists(a, f.factory);
  assert.equal(f.made.length, 1);
  assert.equal(f.made[0].options.src, "https://example.test/track-1.wav");
  assert.equal(f.made[0].options.image, "");
  f.event(a.querySelector("button")!, "click");
  assert.equal(f.made.length, 1, "an empty track cannot load the current page");
  cleanup();
  tracks.forEach((track: { url: string }) => {
    track.url = "";
  });
  a.setAttribute("data-worldact-playlist", JSON.stringify(tracks));
  enhancePlaylists(a, f.factory)();
  assert.equal(
    f.made.length,
    1,
    "a playlist without playable URLs is left readable",
  );
});
