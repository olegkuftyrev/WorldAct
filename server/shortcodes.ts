import { autop } from "@wordpress/autop";
import type { Context, Node, RenderDocument, SerializedNode, State } from "./block-renderer.js";
import { cleanContent, plainText, HttpError } from "./utils.js";
import { parseShortcodes, hasShortcodes, formatShortcodeBlocks, ShortcodeLimitError, type Shortcode } from "./shortcode-parser.js";
import { reserveInteractiveId } from "./interactive-blocks.js";
import { postNeedsPassword } from "./post-passwords.js";
import { renderPlaylistBlock } from "./playlist-blocks.js";
import { parseVideoEmbed } from "../src/embeds.js";

const escape = (value: unknown) => String(value ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const number = (value: unknown, fallback: number, min = 0, max = 20000) => value !== undefined && /^\d+$/.test(String(value)) ? Math.min(max, Math.max(min, Number(value))) : fallback;
const ids = (value: string | undefined) => [...new Set((value || "").split(/[\s,]+/).filter(value => /^[1-9]\d{0,9}$/.test(value)).map(Number).filter(value => value <= 2147483647))].slice(0, 200);
const own = (object: object, key: string) => Object.hasOwn(object, key);
const boolean = (value: string | undefined, fallback = false) => value === undefined ? fallback : value.toLowerCase() !== "false" && value !== "0" && value !== "";
const classes = (value: string | undefined) => (value || "").split(/\s+/).filter(value => /^[a-zA-Z_-][a-zA-Z\d_-]{0,100}$/.test(value)).slice(0, 20).join(" ");
const url = (value: string | undefined) => {
  const input = (value || "").trim().replace(/&amp;/g, "&");
  if (input.length > 8192 || /[\u0000-\u0020\u007f<>"'\\]/.test(input) || !/^(?:https?:\/\/|\/(?!\/))/i.test(input)) return "";
  if (input.startsWith("/")) return input;
  try { const parsed = new URL(input); return parsed.username || parsed.password ? "" : input; } catch { return ""; }
};
const limit = (html: string, state: State) => {
  if (state.outputBytes + Buffer.byteLength(html) > 8 * 1024 * 1024) throw new HttpError(413, "Rendered shortcode content exceeds the 8 MiB limit.");
  return html;
};
async function cached<T>(state: State, key: string, work: () => Promise<T>): Promise<T> {
  if (!state.cache.has(key)) state.cache.set(key, work());
  return state.cache.get(key)!;
}
async function readableParent(parent: any, context: Context, state: State) {
  if (!parent) return false;
  const id = Number(parent.id), status = parent.status;
  const user = state.options.user;
  const editor = !!user && ["administrator", "editor"].includes(user.role);
  const preview = state.options.preview && (editor || user?.id === Number(parent.authorId));
  if (status !== "publish" && !preview) return false;
  if (!parent.hasPassword) return true;
  if (context.post?.id === id && !postNeedsPassword(context.post)) return true;
  return !!state.options.canReadProtectedPost && cached(state, `shortcode-parent-access:${id}`, () => state.options.canReadProtectedPost!(id, state.db));
}
async function attachmentRows(tag: string, a: Record<string, string>, context: Context, state: State) {
  const explicit = own(a, "ids") || own(a, "include"), include = ids(own(a, "ids") ? a.ids : a.include), exclude = ids(a.exclude);
  if (explicit && !include.length) return [];
  const parentId = ["gallery", "playlist"].includes(tag) && own(a, "id") ? number(a.id, 0, 0, 2147483647) : Number(context.post?.id || 0);
  if (!explicit && !parentId) return [];
  if (!explicit) {
    const parent = context.post?.id === parentId ? { id: parentId, status: context.post.status, authorId: context.post.authorId ?? context.post.author_id, hasPassword: context.post.hasPassword ?? context.post.has_password } : await cached(state, `shortcode-parent:${parentId}`, async () => (await state.db.query('SELECT id,status,author_id AS "authorId",password_hash IS NOT NULL AS "hasPassword" FROM posts WHERE id=$1', [parentId])).rows[0]);
    if (!await readableParent(parent, context, state)) return [];
  }
  const type = tag === "gallery" ? "image" : tag === "playlist" ? a.type === "video" ? "video" : "audio" : tag;
  const requestedOrder = a.orderby || (own(a, "ids") ? "post__in" : "menu_order ID");
  const order = requestedOrder !== "post__in" && a.order?.toUpperCase() === "DESC" ? "DESC" : "ASC";
  const orderby = requestedOrder === "post__in" && explicit ? "array_position($2::int[],m.id)" : ({ title: "m.title", date: "m.created_at", ID: "m.id", id: "m.id", rand: "random()" } as Record<string,string>)[requestedOrder] || "m.id";
  const key = JSON.stringify([type, explicit ? 0 : parentId, explicit, include, exclude, orderby, order]);
  const rows: any[] = await cached(state, "shortcode-media:" + key, async () => (await state.db.query(`SELECT m.id,m.title,m.alt,m.caption,m.width,m.height,m.sizes,m.audio_metadata AS "audioMetadata",m.mime_type AS "mimeType",'/uploads/'||m.filename AS url,m.attached_post_id AS "parentId",p.status AS "parentStatus",p.author_id AS "parentAuthorId",p.password_hash IS NOT NULL AS "parentHasPassword" FROM media m LEFT JOIN posts p ON p.id=m.attached_post_id WHERE m.mime_type LIKE $1 AND (($5::boolean AND m.id=ANY($2::int[])) OR (NOT $5::boolean AND m.attached_post_id=$3::int)) AND NOT m.id=ANY($4::int[]) ORDER BY ${orderby} ${order},m.id ${order} LIMIT 200`, [type + "/%", include, parentId, exclude, explicit])).rows);
  const visible = [];
  for (const row of rows) {
    if (row.parentId && !await readableParent({ id: row.parentId, status: row.parentStatus, authorId: row.parentAuthorId, hasPassword: row.parentHasPassword }, context, state)) continue;
    visible.push(row);
  }
  return visible;
}
function embed(input: string) {
  const safe = url(input);
  if (!safe) return "";
  const provider = parseVideoEmbed(safe);
  return provider ? `<figure class="wp-block-embed is-type-video is-provider-${provider.provider.toLowerCase()}"><div class="wp-block-embed__wrapper">${escape(safe)}</div></figure>` : `<a href="${escape(safe)}">${escape(safe)}</a>`;
}
async function renderMedia(tag: "audio" | "video", a: Record<string,string>, content: string | null, context: Context, state: State) {
  const types: Record<string,string> = tag === "audio" ? { mp3: "audio/mpeg", m4a: "audio/mp4", wav: "audio/wav", ogg: "audio/ogg", flac: "audio/flac" } : { mp4: "video/mp4", m4v: "video/mp4", webm: "video/webm", ogv: "video/ogg", flv: "video/x-flv" };
  if (tag === "video" && url(a.src) && parseVideoEmbed(url(a.src))) return embed(a.src);
  const sources: Array<{ url: string; type: string }> = [];
  for (const key of ["src", ...Object.keys(types)]) {
    if (!a[key]) continue;
    const safe = url(a[key]); if (!safe) continue;
    const extension = /\.([a-z\d]+)(?:[?#]|$)/i.exec(safe)?.[1].toLowerCase();
    if (key === "src" && (!extension || !types[extension])) return `<a class="wp-embedded-${tag}" href="${escape(safe)}">${escape(safe)}</a>`;
    if (extension && types[extension] && (key === "src" || key === extension)) sources.push({ url: safe, type: types[extension] });
  }
  if (!sources.length) {
    if (["src", ...Object.keys(types)].some(key => own(a, key))) return "";
    const first = (await attachmentRows(tag, a, context, state))[0];
    if (!first) return "";
    sources.push({ url: first.url, type: first.mimeType });
  }
  const id = reserveInteractiveId(state, "", tag), width = number(a.width, 640, 1), height = number(a.height, 360, 1);
  const preload = ["none", "metadata", "auto"].includes(a.preload) ? a.preload : a.preload === undefined ? tag === "audio" ? "none" : "metadata" : "";
  const attrs = ` id="${id}" class="${escape(classes(a.class) || `wp-${tag}-shortcode`)}" controls${boolean(a.loop) ? " loop" : ""}${boolean(a.autoplay) ? " autoplay" : ""}${boolean(a.muted) ? " muted" : ""}${preload ? ` preload="${preload}"` : ""}${tag === "video" ? ` width="${width}" height="${height}"${url(a.poster) ? ` poster="${escape(url(a.poster))}"` : ""}` : ` style="${escape(a.style || "width:100%")}"`}`;
  const output = `<${tag}${attrs}>${sources.map(source => `<source src="${escape(source.url)}" type="${escape(source.type)}">`).join("")}${tag === "video" && content ? cleanContent(content) : ""}<a href="${escape(sources[0].url)}">${escape(sources[0].url)}</a></${tag}>`;
  return tag === "video" ? `<div class="wp-video" style="width:${width}px">${output}</div>` : output;
}
async function renderShortcode(shortcode: Shortcode, context: Context, state: State, depth: number): Promise<string> {
  const a = shortcode.attributes;
  if (shortcode.tag === "embed") return embed(shortcode.content?.trim() || a.src || "");
  if (shortcode.tag === "audio" || shortcode.tag === "video") return renderMedia(shortcode.tag, a, shortcode.content, context, state);
  if (shortcode.tag === "caption" || shortcode.tag === "wp_caption") {
    let content = shortcode.content || "", caption = a.caption;
    if (caption === undefined) { const match = /^([\s\S]*?(?:<a\b[^>]*>\s*)?<img\b[^>]*>(?:\s*<\/a>)?)([\s\S]*)$/i.exec(content); if (match) { content = match[1]; caption = match[2].trim(); } }
    const width = number(a.width, 0);
    if (!width || !caption) return content;
    const inner = await expandShortcodes(content, context, state, depth + 1);
    const id = a.id ? reserveInteractiveId(state, a.id.replace(/[^a-zA-Z\d_-]/g, "").slice(0, 100), "caption") : "";
    const captionId = a.caption_id || id ? reserveInteractiveId(state, (a.caption_id || "caption-" + id).replace(/[^a-zA-Z\d_-]/g, "").slice(0, 100), "caption-text") : "";
    return `<figure${id ? ` id="${id}"` : ""}${captionId ? ` aria-describedby="${captionId}"` : ""} style="width:${width}px" class="wp-caption ${escape(classes(a.align || "alignnone"))}${a.class ? " " + escape(classes(a.class)) : ""}">${inner}<figcaption${captionId ? ` id="${captionId}"` : ""} class="wp-caption-text">${cleanContent(caption)}</figcaption></figure>`;
  }
  const rows = await attachmentRows(shortcode.tag, a, context, state);
  if (!rows.length) return "";
  if (state.options.contentMode === "feed" && shortcode.tag === "playlist") return rows.map(row => `<a href="${escape(row.url)}">${escape(row.title)}</a>`).join("\n");
  if (shortcode.tag === "gallery") {
    const galleryId = reserveInteractiveId(state, "", "gallery"), columns = number(a.columns, 3, 0, 100), size = /^[a-zA-Z\d_-]{1,100}$/.test(a.size || "") ? a.size : "thumbnail";
    const allowed = ["figure", "div", "span", "li", "ul", "p", "figcaption", "dl", "dt", "dd"], item = allowed.includes(a.itemtag) ? a.itemtag : "figure", icon = allowed.includes(a.icontag) ? a.icontag : "div", caption = a.captiontag === "" ? "" : allowed.includes(a.captiontag) ? a.captiontag : "figcaption";
    const items = rows.map(row => {
      const image = row.sizes?.[size] || row, imageURL = url(image.url || (image.filename ? "/uploads/" + image.filename : row.url)), captionId = `${galleryId}-${row.id}`;
      const img = `<img src="${escape(imageURL)}" alt="${escape(row.alt)}" class="attachment-${size} size-${size} wp-image-${row.id}"${image.width ? ` width="${number(image.width, 1, 1)}"` : ""}${image.height ? ` height="${number(image.height, 1, 1)}"` : ""}${caption && row.caption ? ` aria-describedby="${captionId}"` : ""} loading="lazy">`;
      const link = a.link === "none" ? img : `<a href="${escape(row.url)}">${img}</a>`;
      if (state.options.contentMode === "feed") return link;
      return `<${item} class="gallery-item"><${icon} class="gallery-icon ${row.height > row.width ? "portrait" : "landscape"}">${link}</${icon}>${caption && row.caption ? `<${caption} class="wp-caption-text gallery-caption" id="${captionId}">${cleanContent(row.caption)}</${caption}>` : ""}</${item}>`;
    }).join("");
    return state.options.contentMode === "feed" ? items : `<div id="${galleryId}" class="gallery galleryid-${number(a.id, Number(context.post?.id || 0))} gallery-columns-${columns} gallery-size-${size}">${items}</div>`;
  }
  const type = a.type === "video" ? "video" : "audio", list = boolean(a.tracklist, true), artists = boolean(a.artists, true), numbers = boolean(a.tracknumbers, true);
  if (type === "video") return `<div class="wp-playlist wp-video-playlist wp-playlist-${a.style === "dark" ? "dark" : "light"}">${await renderMedia("video", { src: rows[0].url }, null, context, state)}<${numbers ? "ol" : "ul"}${list ? "" : ' class="screen-reader-text"'}>${rows.map(row => `<li><a href="${escape(row.url)}">${escape(row.title)}</a></li>`).join("")}</${numbers ? "ol" : "ul"}></div>`;
  const nodes: Node[] = rows.map(row => ({ name: "core/playlist-track", children: [], attrs: { id: row.id, src: row.url, title: row.title, artist: artists ? row.audioMetadata?.artist || "" : "", album: row.audioMetadata?.album || "", length: row.audioMetadata?.length_formatted || "" } }));
  const node: Node = { name: "core/playlist", children: nodes, attrs: { showTracklist: list, showArtists: artists, showNumbers: numbers, showImages: boolean(a.images, true), waveformStyle: "seekbar" } };
  return (await renderPlaylistBlock(node, context, state, async (children, next) => {
    const result = []; for (const child of children) result.push(await renderPlaylistBlock(child, next, state, async () => "", () => ' class="wp-block-playlist-track"')); return result.join("");
  }, () => ` class="wp-block-playlist wp-playlist wp-audio-playlist wp-playlist-${a.style === "dark" ? "dark" : "light"}"`)) || "";
}
export async function expandShortcodes(input: string, context: Context, state: State, depth = 0): Promise<string> {
  if (!hasShortcodes(input)) return input;
  if (depth > 12) throw new HttpError(413, "Shortcode nesting exceeds the limit.");
  let pieces;
  try { pieces = parseShortcodes(input); } catch (error) { if (error instanceof ShortcodeLimitError) throw new HttpError(413, error.message); throw error; }
  const out: string[] = []; let bytes = 0;
  for (const piece of pieces) {
    const html = typeof piece === "string" ? piece : piece.escaped ? piece.raw.slice(1, -1) : ++state.nodes > 4000 ? "" : await renderShortcode(piece, context, state, depth) + piece.suffix;
    bytes += Buffer.byteLength(html);
    if (state.outputBytes + bytes > 8 * 1024 * 1024) throw new HttpError(413, "Rendered shortcode content exceeds the 8 MiB limit.");
    out.push(html);
  }
  return limit(out.join(""), state);
}
/** Transient copies only: storage, revisions and exports retain source text. */
export async function prepareShortcodeDocument(document: RenderDocument, context: Context, state: State): Promise<RenderDocument> {
  const raw = document.rawContent || document.raw_content || document.content || "";
  if (raw.includes("<!-- wp:") || !document.blocks?.length) {
    if (!hasShortcodes(raw) && !/<!--\s*wp:(?:core\/)?shortcode\b/.test(raw)) return document;
    let source;
    try { source = formatShortcodeBlocks(raw, autop); } catch (error) { if (error instanceof ShortcodeLimitError) throw new HttpError(413, error.message); throw error; }
    const expanded = await expandShortcodes(source, context, state);
    return { ...document, rawContent: expanded, raw_content: expanded, content: expanded };
  }
  let preparedBytes = 0;
  const walk = async (blocks: SerializedNode[], depth = 0): Promise<SerializedNode[]> => {
    if (depth > 20) return [];
    const result = [];
    for (const block of blocks) {
      if (["core/code", "core/preformatted", "core/verse", "core/math", "core/icon"].includes(block.name)) { result.push(block); continue; }
      const attributes = { ...block.attributes };
      for (const key of ["text", "content", "value", "values", "caption"]) if (typeof attributes[key] === "string" && (block.name === "core/shortcode" || hasShortcodes(attributes[key]))) {
        attributes[key] = await expandShortcodes(block.name === "core/shortcode" ? autop(attributes[key]) : attributes[key], context, state);
        preparedBytes += Buffer.byteLength(attributes[key] as string);
        if (state.outputBytes + preparedBytes > 8 * 1024 * 1024) throw new HttpError(413, "Prepared shortcode content exceeds the 8 MiB limit.");
      }
      result.push({ ...block, attributes, innerBlocks: await walk(block.innerBlocks || [], depth + 1) });
    }
    return result;
  };
  return { ...document, blocks: await walk(document.blocks) };
}
