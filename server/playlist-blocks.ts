import { DOMParser } from "linkedom";
import sanitizeHTML from "sanitize-html";
import type { Context, Node, State } from "./block-renderer.js";
import { reserveInteractiveId } from "./interactive-blocks.js";
import { cleanContent, plainText } from "./utils.js";

export type PlaylistTrack = { url: string; title: string; artist: string; album: string; image: string; imageAlt: string; ariaLabel: string };
export type PlaylistContext = { id: string; showImages: boolean; tracks: ReadonlyMap<Node, number> };
type Attributes = (extra?: string, override?: Record<string, any>) => string;
const escape = (value: unknown) => String(value ?? "").replace(/[&<>"']/g, character => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]!);
const documentFor = (html: string) => new DOMParser().parseFromString("<!doctype html><html><body>" + html + "</body></html>", "text/html");
const text = (value: unknown) => plainText(typeof value === "string" ? value.slice(0, 10000) : "");
const displayText = (value: unknown) => typeof value === "string" ? value.slice(0, 10000) : "";
const mediaURL = (value: unknown) => {
  const url = typeof value === "string" ? value.trim() : "";
  return url.length <= 8192 && /^(?:https?:\/\/|\/(?!\/))/i.test(url) && !/[\u0000-\u0020<>"'\\]/.test(url) ? url : "";
};
const hasTrackID = (node: Node) => node.name === "core/playlist-track" && Number.isSafeInteger(node.attrs.id) && node.attrs.id > 0 && node.attrs.id <= 2147483647;
function trackData(node: Node): PlaylistTrack {
  const a = node.attrs, title = text(a.title) || "Unknown title", artist = text(a.artist), album = text(a.album);
  return { url: mediaURL(a.src), title, artist, album, image: mediaURL(a.image), imageAlt: text(a.imageAlt), ariaLabel: artist && album ? `${title} by ${artist} from the album ${album}` : title };
}
function inline(value: string) {
  return sanitizeHTML(value, { allowedTags: ["strong", "em", "b", "i", "u", "s", "del", "ins", "span", "code", "mark", "sub", "sup", "br", "a"], allowedAttributes: { "*": ["class", "style"], a: ["href", "rel", "target"] }, allowedSchemes: ["http", "https", "mailto", "tel"], allowProtocolRelative: false });
}
// Read only inert saved classes/styles. Saved directives, IDs, buttons, player
// state and handlers never become authoritative runtime state.
function wrapper(node: Node, attributes: Attributes, saved: Element | null, id?: string) {
  const computed = documentFor("<div" + attributes() + "></div>").body.firstElementChild!;
  const classes = [...new Set(((saved?.getAttribute("class") || "") + " " + (computed.getAttribute("class") || "")).split(/\s+/).filter(Boolean))].join(" ");
  const styles = [saved?.getAttribute("style"), computed.getAttribute("style")].filter(Boolean).join(";");
  const anchor = typeof node.attrs.anchor === "string" && /^[A-Za-z0-9_-]{1,100}$/.test(node.attrs.anchor) ? node.attrs.anchor : "";
  return ` class="${escape(classes)}"${id || anchor ? ` id="${escape(id || anchor)}"` : ""}${styles ? ` style="${escape(styles)}"` : ""}`;
}
function waveformAppearance(a: Record<string, any>) {
  return [["waveformColor", "color", "color"], ["waveformGradient", "background", "gradient"], ["waveformBackgroundColor", "color", "background-color"], ["waveformBackgroundGradient", "background", "background-gradient"]].map(([key, property, attribute]) => {
    const input = a[key];
    if (typeof input !== "string" || input.length > 2000 || /[;\u0000-\u001f]/.test(input)) return "";
    const cleaned = documentFor(cleanContent(`<div style="${property}:${escape(input)}"></div>`)).body.firstElementChild?.getAttribute("style") || "";
    return cleaned.startsWith(property + ":") ? ` data-waveform-player-${attribute}="${escape(cleaned.slice(property.length + 1))}"` : "";
  }).join("");
}

export async function renderPlaylistBlock(node: Node, context: Context, state: State, children: (nodes: Node[], context: Context) => Promise<string>, attributes: Attributes): Promise<string | undefined> {
  if (node.name === "core/playlist-track") {
    if (!hasTrackID(node)) return "";
    const track = trackData(node), a = node.attrs, index = context.playlist?.tracks.get(node);
    // Source playlist.php strips state labels, while playlist-track.php escapes
    // the literal display strings. A title such as "Song <Live>" is text here.
    const image = context.playlist?.showImages !== false && track.image ? `<img class="wp-block-playlist-track__image" src="${escape(track.image)}" alt="${escape(displayText(a.imageAlt))}">` : "";
    const title = displayText(a.title) || "Unknown title", artist = displayText(a.artist), length = displayText(a.length);
    return `<li${attributes()}><button type="button" class="wp-block-playlist-track__button"${index !== undefined ? ` data-worldact-playlist-track="${index}" aria-current="${index === 0}"` : ""}>${image}<span class="wp-block-playlist-track__content"><span class="wp-block-playlist-track__title">${escape(title)}</span>${artist ? `<span class="wp-block-playlist-track__artist">${escape(artist)}</span>` : ""}</span>${length ? `<span class="wp-block-playlist-track__length"><span class="screen-reader-text">Duration: </span>${escape(length)}</span>` : ""}<span class="screen-reader-text" data-worldact-playlist-action>Play</span></button></li>`;
  }
  if (node.name !== "core/playlist") return undefined;
  const trackNodes = node.children.filter(hasTrackID);
  if (!trackNodes.length) return "";
  const a = node.attrs, id = reserveInteractiveId(state, typeof a.anchor === "string" && /^[A-Za-z0-9_-]{1,100}$/.test(a.anchor) ? a.anchor : "", "playlist");
  const tracks = trackNodes.map(trackData), trackMap = new Map(trackNodes.map((track, index) => [track, index]));
  const saved = documentFor(cleanContent(node.html || "", false, true));
  const savedFigure = saved.body.firstElementChild?.tagName === "FIGURE" ? saved.body.firstElementChild : null;
  const listClasses = ["wp-block-playlist__tracklist", a.showTracklist === false && "wp-block-playlist__tracklist-is-hidden", a.showArtists === false && "wp-block-playlist__tracklist-artist-is-hidden", a.showTrackLength === false && "wp-block-playlist__tracklist-length-is-hidden", a.showNumbers !== false && "wp-block-playlist__tracklist-show-numbers"].filter(Boolean).join(" ");
  const caption = inline(cleanContent(typeof a.caption === "string" ? a.caption : savedFigure?.querySelector("figcaption")?.innerHTML || ""));
  const style = ["bars", "mirror", "line", "blocks", "dots", "seekbar"].includes(a.waveformStyle) ? a.waveformStyle : "bars";
  const player = `<div class="wp-block-playlist__waveform-player"${waveformAppearance(a)} data-label-play="Play" data-label-pause="Pause" data-label-seek="Seek" data-label-seek-value="%1$s of %2$s"></div>`;
  // A native audio control and direct media links remain usable without any
  // script. The trusted client player hides this fallback after initialization.
  const fallback = `<div data-worldact-playlist-fallback>${tracks[0].url ? `<audio controls preload="none" src="${escape(tracks[0].url)}" aria-label="${escape(tracks[0].ariaLabel)}"></audio>` : ""}<ul>${tracks.filter(track => track.url).map(track => `<li><a href="${escape(track.url)}">${escape(track.ariaLabel)}</a></li>`).join("")}</ul></div>`;
  return `<figure${wrapper(node, attributes, savedFigure, id)} data-worldact-playlist="${escape(JSON.stringify(tracks))}" data-worldact-waveform-style="${style}" data-worldact-play-button-artwork="${a.showPlayButtonArtwork === true}">${player}${fallback}<ol class="${listClasses}">${await children(node.children, { ...context, playlist: { id, showImages: a.showImages !== false, tracks: trackMap } })}</ol>${caption ? `<figcaption class="wp-element-caption">${caption}</figcaption>` : ""}</figure>`;
}
