import test, { after } from "./isolated-test.js";
import "dotenv/config";
import assert from "node:assert/strict";
import { DOMParser } from "linkedom";
import { parse } from "@wordpress/block-serialization-default-parser";
import { pool, defaultSettings } from "../server/db.js";
import { renderSiteDocument } from "../server/block-renderer.js";
import { cleanBlocks, cleanRawContent } from "../server/utils.js";
import { remapImportedBlockReferences } from "../server/block-portability.js";

const dom = (html: string) => new DOMParser().parseFromString("<!doctype html><html><body>" + html + "</body></html>", "text/html");
const block = (name: string, attributes: Record<string, unknown> = {}, inner = "") => `<!-- wp:${name} ${JSON.stringify(attributes)}${inner ? ` -->${inner}<!-- /wp:${name} -->` : " /-->"}`;
const node = (name: string, attributes: Record<string, unknown> = {}, innerBlocks: any[] = []) => ({ name: `core/${name}`, attributes, innerBlocks });
const track = (id = 1, overrides: Record<string, unknown> = {}) => ({ id, src: `/uploads/song-${id}.wav`, title: `Song ${id}`, artist: "Artist", album: "Album", image: "/uploads/cover.jpg", imageAlt: "Artwork", length: "0:02", ...overrides });
const document = (attrs: Record<string, unknown> = {}, tracks = [track(), track(2)]) => cleanRawContent(block("playlist", attrs, '<figure class="wp-block-playlist source-wrapper" style="margin-top:2rem" data-wp-interactive="untrusted"><ol class="wp-block-playlist__tracklist">' + tracks.map(a => block("playlist-track", a)).join("") + '</ol><figcaption class="wp-element-caption"><em>Saved caption</em></figcaption></figure>'));
const settingsOnly = { query: async (sql: string) => { assert.match(sql, /FROM settings/); return { rows: [{ data: defaultSettings }] }; } } as any;
after(async () => { await pool.end(); });

test("canonical playlist renders source tracks, saved wrapper/caption and usable script-free media", async () => {
  const output = dom(await renderSiteDocument({ rawContent: document() }, { db: settingsOnly }));
  const figure = output.querySelector("figure")!;
  assert.ok(figure.classList.contains("source-wrapper")); assert.match(figure.getAttribute("style")!, /margin-top:2rem/);
  assert.equal(output.querySelectorAll(".wp-block-playlist-track__button").length, 2);
  assert.equal(output.querySelector(".wp-block-playlist-track__button")!.getAttribute("aria-current"), "true");
  assert.equal(output.querySelectorAll("[data-worldact-playlist-track]")[1].getAttribute("data-worldact-playlist-track"), "1");
  assert.equal(output.querySelectorAll(".wp-block-playlist-track__image").length, 2);
  assert.equal(output.querySelector("figcaption em")!.textContent, "Saved caption");
  assert.equal(output.querySelector("[data-worldact-playlist-fallback] audio")!.getAttribute("src"), "/uploads/song-1.wav");
  assert.equal(output.querySelectorAll("[data-worldact-playlist-fallback] a").length, 2);
  assert.deepEqual(JSON.parse(figure.getAttribute("data-worldact-playlist")!), [track(), track(2)].map(({ src, title, artist, album, image, imageAlt }) => ({ url: src, title, artist, album, image, imageAlt, ariaLabel: `${title} by ${artist} from the album ${album}` })));
  assert.equal(figure.getAttribute("data-worldact-waveform-style"), "bars");
  assert.equal(output.querySelector("[data-wp-interactive]"), null);
});

test("JSON playlist honors visibility, waveform appearance and independent render-time identities", async () => {
  const attrs = { anchor: "music", showImages: false, showTracklist: false, showArtists: false, showTrackLength: false, showNumbers: false, waveformStyle: "dots", waveformColor: "#123456", waveformGradient: "linear-gradient(90deg, #123456, #abcdef)", waveformBackgroundColor: "#ffffff", waveformBackgroundGradient: "radial-gradient(circle, #ffffff, #dddddd)", showPlayButtonArtwork: true, caption: "<strong>JSON caption</strong>" };
  const blocks = cleanBlocks([node("playlist", attrs, [node("playlist-track", track())]), node("playlist", attrs, [node("playlist-track", track(2))])]);
  const output = dom(await renderSiteDocument({ content: "<p>Stale playlist snapshot</p>", blocks }, { db: settingsOnly }));
  assert.equal(output.querySelectorAll("figure").length, 2); assert.equal(output.querySelectorAll(".wp-block-playlist-track__image").length, 0);
  assert.notEqual(output.querySelectorAll("figure")[0].id, output.querySelectorAll("figure")[1].id);
  const list = output.querySelector("ol")!;
  for (const suffix of ["is-hidden", "artist-is-hidden", "length-is-hidden"]) assert.ok(list.classList.contains("wp-block-playlist__tracklist-" + suffix));
  assert.ok(!list.classList.contains("wp-block-playlist__tracklist-show-numbers"));
  assert.equal(output.querySelector("figure")!.getAttribute("data-worldact-waveform-style"), "dots");
  assert.equal(output.querySelector("figure")!.getAttribute("data-worldact-play-button-artwork"), "true");
  assert.equal(output.querySelector(".wp-block-playlist__waveform-player")!.getAttribute("data-waveform-player-color"), "#123456");
  assert.match(output.querySelector(".wp-block-playlist__waveform-player")!.getAttribute("data-waveform-player-gradient")!, /linear-gradient/);
  assert.equal(output.querySelector("figcaption strong")!.textContent, "JSON caption");
  assert.doesNotMatch(output.body.innerHTML, /Stale playlist snapshot/);
});

test("empty/invalid tracks are omitted and saved active markup cannot define the trusted player", async () => {
  assert.equal(await renderSiteDocument({ rawContent: document({}, []) }, { db: settingsOnly }), "");
  assert.equal(await renderSiteDocument({ blocks: [node("playlist", {}, [node("playlist-track", track(0)), node("playlist-track", track(-1))])] }, { db: settingsOnly }), "");
  const hostile = node("playlist", { waveformStyle: "<img src=x onerror=bad()>", waveformColor: "url(https://evil.invalid/pixel)", waveformGradient: "linear-gradient(red,blue);background:url(https://evil.invalid/pixel)", caption: '<img src="https://evil.invalid/pixel" onerror="bad()"><strong onclick="bad()">Safe caption</strong>' }, [node("playlist-track", track(8, { title: '<img src=x onerror=bad()>Safe title', src: "javascript:bad()", image: "//evil.invalid/pixel", imageAlt: '" onerror="bad()', blob: "blob:untrusted", artist: "<script>bad()</script>", album: "Album" }))]);
  const html = await renderSiteDocument({ blocks: [hostile] }, { db: settingsOnly }), output = dom(html);
  const data = JSON.parse(output.querySelector("figure")!.getAttribute("data-worldact-playlist")!);
  assert.equal(data[0].url, ""); assert.equal(data[0].image, ""); assert.equal(data[0].title, "Safe title"); assert.equal(data[0].artist, "");
  assert.equal(output.querySelector("figure")!.getAttribute("data-worldact-waveform-style"), "bars");
  assert.equal(output.querySelector("[data-waveform-player-color]"), null); assert.equal(output.querySelector("[data-waveform-player-gradient]"), null);
  assert.equal(output.querySelector("figcaption")!.textContent, "Safe caption");
  assert.doesNotMatch(html, /<script|<img|onclick=|javascript:|blob:untrusted|evil\.invalid/);
});

test("all six source waveform modes survive canonical rendering", async () => {
  for (const waveformStyle of ["bars", "mirror", "line", "blocks", "dots", "seekbar"]) {
    const output = dom(await renderSiteDocument({ rawContent: document({ waveformStyle, showPlayButtonArtwork: true }) }, { db: settingsOnly }));
    assert.equal(output.querySelector("figure")!.getAttribute("data-worldact-waveform-style"), waveformStyle);
  }
});

test("track rows escape literal display labels while the separate player state strips markup", async () => {
  const attributes = track(9, { title: "Song <Live>", artist: "Artist <Guest>", length: "2:00 <extended>", imageAlt: 'Artwork <Front> "quoted"' });
  const output = dom(await renderSiteDocument({ blocks: [node("playlist", {}, [node("playlist-track", attributes)])] }, { db: settingsOnly }));
  assert.equal(output.querySelector(".wp-block-playlist-track__title")!.textContent, attributes.title);
  assert.equal(output.querySelector(".wp-block-playlist-track__artist")!.textContent, attributes.artist);
  assert.equal(output.querySelector(".wp-block-playlist-track__length")!.textContent, "Duration: " + attributes.length);
  assert.equal(output.querySelector(".wp-block-playlist-track__image")!.getAttribute("alt"), attributes.imageAlt);
  assert.equal(JSON.parse(output.querySelector("figure")!.getAttribute("data-worldact-playlist")!)[0].title, "Song ");
  assert.equal(output.querySelector("live"), null); assert.equal(output.querySelector("guest"), null);
});

test("playlist media import remaps canonical/JSON IDs and URLs, detaching unrelated local attachments", () => {
  const attrs = track(7, { src: "https://source.test/uploads/song.wav", image: "https://source.test/uploads/art.jpg" });
  const result = remapImportedBlockReferences(document({}, [attrs, track(8)]), [node("playlist", {}, [node("playlist-track", attrs), node("playlist-track", track(8))])], new Map(), { media: new Map([[7, 70]]), urls: new Map([[attrs.src, "/uploads/imported.wav"], [attrs.image, "/uploads/imported.jpg"]]) });
  const tracks = parse(result.rawContent)[0].innerBlocks;
  assert.equal(tracks[0].attrs!.id, 70); assert.equal(tracks[0].attrs!.src, "/uploads/imported.wav"); assert.equal(tracks[0].attrs!.image, "/uploads/imported.jpg");
  assert.equal(tracks[1].attrs!.id, undefined);
  assert.equal(result.blocks[0].innerBlocks[0].attributes.id, 70); assert.equal(result.blocks[0].innerBlocks[1].attributes.id, undefined);
  assert.ok(result.warnings.some(value => value.includes("8") && value.includes("playlist-track")));
});

test("playlist canonical data survives real saves, raw-only revisions, autosaves and protected publication", async () => {
  const base = process.env.TEST_API_URL || "http://127.0.0.1:3001", origin = process.env.APP_ORIGIN || "http://127.0.0.1:5173";
  let cookie = "", id = 0;
  const api = async (path: string, method = "GET", body?: unknown, authenticated = true) => {
    const response = await fetch(base + path, { method, headers: { Origin: origin, "Content-Type": "application/json", ...(authenticated && cookie ? { Cookie: cookie } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { response, data: await response.json() };
  };
  try {
    const signed = await api("/api/auth/login", "POST", { login: process.env.ADMIN_EMAIL, password: process.env.ADMIN_PASSWORD }); assert.equal(signed.response.status, 200); cookie = signed.response.headers.get("set-cookie")!.split(";")[0];
    const raw = document({ waveformStyle: "mirror" });
    const created = await api("/api/posts", "POST", { title: "Playlist " + Date.now(), status: "publish", content: raw }); assert.equal(created.response.status, 201); let post = created.data.post; id = post.id;
    const publicPost = (await api("/api/public/posts/" + post.slug, "GET", undefined, false)).data.post;
    assert.equal(dom(publicPost.content).querySelectorAll("[data-worldact-playlist-track]").length, 2);
    const changed = await api("/api/posts/" + id, "PUT", { version: post.version, content: document({ waveformStyle: "line" }, [track(2)]) }); assert.equal(changed.response.status, 200); post = changed.data.post;
    const previous = (await api(`/api/posts/${id}/revisions`)).data.revisions.find((revision: any) => revision.rawContent.includes('"mirror"')); assert.ok(previous);
    const restored = await api(`/api/posts/${id}/revisions/${previous.id}/restore`, "POST", { version: post.version }); assert.equal(restored.response.status, 200); post = restored.data.post;
    assert.equal(parse(post.rawContent)[0].attrs!.waveformStyle, "mirror");
    const autosave = await api(`/api/posts/${id}/autosave`, "PUT", { version: post.version, content: document({ waveformStyle: "seekbar" }) }); assert.equal(autosave.response.status, 200);
    const preview = (await api(`/api/posts/${id}/preview`)).data.post; assert.equal(dom(preview.content).querySelector("figure")!.getAttribute("data-worldact-waveform-style"), "seekbar");
    const protectedSave = await api(`/api/posts/${id}`, "PUT", { version: post.version, password: "playlist-test-secret" }); assert.equal(protectedSave.response.status, 200);
    const locked = (await api("/api/public/posts/" + post.slug, "GET", undefined, false)).data.post;
    assert.equal(dom(locked.content).querySelector("[data-worldact-playlist]"), null); assert.equal(locked.rawContent || "", "");
    const types = await api("/wp-json/wp/v2/block-types/core/playlist"); assert.equal(types.response.status, 200); assert.equal(types.data.is_dynamic, true); assert.equal(types.data.attributes.waveformStyle.default, "bars");
  } finally {
    if (id) { await api(`/api/posts/${id}`, "PUT", { status: "trash" }); await api(`/api/posts/${id}`, "DELETE"); }
    if (cookie) await api("/api/auth/logout", "POST", {});
  }
});
