import sanitizeHTML from "sanitize-html";
import { z } from "zod";
import type { RenderDocument, RenderPost, SerializedNode } from "./block-renderer.js";
import { hasDynamicBlocks } from "../shared/dynamic-blocks.js";

export type ContentMode = "singular" | "archive" | "complete" | "feed";
export type ContentPagination = { page: number; totalPages: number; links: Array<{ page: number; url: string; current: boolean }> };
type Marker = { type: "more"; text: string; noTeaser?: boolean } | { type: "nextpage" } | { type: "noteaser" };
type Piece = { raw: string } | { block: SerializedNode } | Marker;
const escape = (value: unknown) => String(value ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const text = (value: unknown) => sanitizeHTML(String(value ?? ""), { allowedTags: [], allowedAttributes: {} }).replace(/&(amp|lt|gt|quot|#39);/g, (_match, name: string) => ({ amp: "&", lt: "<", gt: ">", quot: '"', "#39": "'" } as Record<string,string>)[name]!);
export const LEGACY_CONTENT_MARKER = /<!--(?:more(?:[ \t]+[^<>\r\n]{0,1000})?|noteaser|nextpage)-->/gi;
export const parseContentPage = (value: unknown) => z.union([z.string().regex(/^[1-9]\d{0,9}$/).transform(Number),z.number().int().positive()]).pipe(z.number().int().positive().max(2147483647)).optional().default(1).parse(value);

/** These are content separators, never executable comments or shortcode hooks. */
export function canonicalLegacyMarker(value: string): string | null {
  if (/^<!--noteaser-->$/i.test(value)) return "<!--noteaser-->";
  if (/^<!--nextpage-->$/i.test(value)) return "<!--nextpage-->";
  const match = /^<!--more(?:[ \t]+([^<>\r\n]{0,1000}))?-->$/i.exec(value);
  if (!match || /[\u0000-\u001f\u007f]|--/.test(match[1] || "")) return null;
  const label = text(match[1] || "").replace(/[<>]|--/g, "").trim();
  return `<!--more${label ? " " + label : ""}-->`;
}
function marker(value: string): Marker {
  if (/^<!--nextpage/i.test(value)) return { type: "nextpage" };
  if (/^<!--noteaser/i.test(value)) return { type: "noteaser" };
  return { type: "more", text: text(value.slice(8, -3)).trim() };
}
function normalizeNativeMarkers(raw: string): string {
  const markerFor = (kind: string, encoded = "", inner = "") => {
    if (kind.toLowerCase() === "nextpage") return "<!--nextpage-->";
    let attrs: Record<string, unknown> = {};
    try { if (encoded) attrs = JSON.parse(encoded); } catch { /* Validated storage is canonical; tolerate old imported delimiter-only blocks. */ }
    if (/<!--more(?:[ \t]|-->)/i.test(inner)) return inner;
    const label = text(attrs.customText || "").replace(/[<>\r\n]|--/g, "").slice(0, 1000).trim();
    return `<!--more${label ? " " + label : ""}-->${attrs.noTeaser === true ? "<!--noteaser-->" : ""}${inner}`;
  };
  return raw
    .replace(/<!--\s*wp:(?:core\/)?(more|nextpage)\s*(\{[\s\S]*?\})?\s*-->([\s\S]*?)<!--\s*\/wp:(?:core\/)?\1\s*-->/gi, (_all, kind, encoded, inner) => markerFor(kind, encoded, inner))
    .replace(/<!--\s*wp:(?:core\/)?(more|nextpage)\s*(\{[\s\S]*?\})?\s*\/\s*-->/gi, (_all, kind, encoded) => markerFor(kind, encoded));
}
function rawPieces(raw: string): Piece[] {
  const pieces: Piece[] = [], source = normalizeNativeMarkers(raw);let previous = 0;
  for (const match of source.matchAll(LEGACY_CONTENT_MARKER)) {
    pieces.push({ raw: source.slice(previous, match.index) }, marker(match[0]));previous = match.index! + match[0].length;
  }
  pieces.push({ raw: source.slice(previous) });return pieces;
}
function jsonPieces(blocks: SerializedNode[], depth = 0): Piece[] {
  if (depth > 20) return [];
  const pieces: Piece[] = [];
  for (const block of blocks) {
    if (block.name === "core/more") { pieces.push({ type: "more", text: text(block.attributes.customText || ""), noTeaser: block.attributes.noTeaser === true });continue; }
    if (block.name === "core/nextpage") { pieces.push({ type: "nextpage" });continue; }
    const children = jsonPieces(block.innerBlocks || [], depth + 1);
    if (!children.some(piece => "type" in piece)) { pieces.push({ block });continue; }
    let segment: SerializedNode[] = [];
    const flush = () => { if (segment.length) pieces.push({ block: { ...block, innerBlocks: segment } });segment = []; };
    for (const piece of children) if ("block" in piece) segment.push(piece.block);else if ("type" in piece) { flush();pieces.push(piece); }
    flush();
  }
  return pieces;
}
function usesJSON(document: RenderDocument): boolean {
  const raw = document.rawContent || document.raw_content || document.content || "";
  return !raw.includes("<!-- wp:") && !/<!--(?:more(?:[ \t]|-->)|noteaser-->|nextpage-->)/i.test(raw) && !!document.blocks?.length && (!raw.length || hasLegacyContent(document) || hasDynamicBlocks(document.blocks));
}
function pieces(document: RenderDocument): Piece[] {
  const raw = document.rawContent || document.raw_content || document.content || "";
  return usesJSON(document) ? jsonPieces(document.blocks!) : rawPieces(raw);
}
function splitPages(content: Piece[]): Piece[][] {
  const pages: Piece[][] = [[]];let atStart = true;
  for (const piece of content) {
    if ("type" in piece && piece.type === "nextpage") { if (!atStart) pages.push([]);atStart = false; }
    else { pages.at(-1)!.push(piece);if ("block" in piece || "type" in piece || ("raw" in piece && piece.raw.trim())) atStart = false; }
  }
  return pages;
}
export const legacyPageCount = (document: RenderDocument) => splitPages(pieces(document)).length;
export function hasLegacyContent(document: RenderDocument): boolean {
  const raw = document.rawContent || document.raw_content || document.content || "";
  if (/<!--(?:more(?:[ \t]|-->)|noteaser-->|nextpage-->)|<!--\s*wp:(?:core\/)?(?:more|nextpage)\b/i.test(raw)) return true;
  const visit = (blocks: SerializedNode[], depth = 0): boolean => depth <= 20 && blocks.some(block => ["core/more", "core/nextpage"].includes(block.name) || visit(block.innerBlocks || [], depth + 1));
  return visit(document.blocks || []);
}
export function legacyExcerptSource(document: RenderDocument): string {
  const selected = selectLegacyContent(document, document, "/", "archive").document;
  if (selected.rawContent !== undefined) return selected.rawContent;
  const read = (blocks: SerializedNode[], depth = 0): string => depth > 20 ? "" : blocks.map(block => String(block.attributes.content || block.attributes.value || block.attributes.text || "") + " " + read(block.innerBlocks || [], depth + 1)).join(" ");
  return read(selected.blocks || []);
}
export function contentPageURL(post: RenderPost, permalink: string, page: number, preview = false): string {
  if (preview || ["draft", "pending", "future", "private"].includes(post.status)) return `/preview/${post.id}${page > 1 ? "?page=" + page : ""}`;
  if (page === 1) return permalink;
  if (permalink.includes("?")) return permalink + "&page=" + page;
  return permalink.replace(/\/?$/, "/") + (permalink === "/" ? "page/" : "") + page + "/";
}
export function contentPagination(post: RenderPost, permalink: string, requested = 1, preview = false): ContentPagination {
  const totalPages = legacyPageCount(post), page = Math.min(totalPages, Math.max(1, Math.trunc(requested) || 1));
  return { page, totalPages, links: Array.from({ length: totalPages }, (_, index) => ({ page: index + 1, url: contentPageURL(post, permalink, index + 1, preview), current: page === index + 1 })) };
}
export function renderContentPagination(pagination: ContentPagination, archive = false): string {
  if (pagination.totalPages < 2) return "";
  return `<p class="post-nav-links">Pages: ${pagination.links.map(link => link.current && !archive ? `<span class="post-page-numbers current" aria-current="page">${link.page}</span>` : `<a href="${escape(link.url)}" class="post-page-numbers">${link.page}</a>`).join(" ")}</p>`;
}
export function selectLegacyContent(document: RenderDocument, post: RenderPost, permalink: string, mode: ContentMode, requested = 1, preview = false) {
  const all = pieces(document), pages = splitPages(all);
  const page = mode === "complete" || mode === "archive" || mode === "feed" ? 1 : Math.min(pages.length, Math.max(1, Math.trunc(requested) || 1));
  const selected = mode === "complete" ? pages.flat() : pages[page - 1], more = selected.findIndex(piece => "type" in piece && piece.type === "more");
  const moreMarker = more < 0 ? undefined : selected[more] as Extract<Marker, { type: "more" }>;
  // Source get_the_content checks the entire stored post for noteaser, but
  // strips the selected page's teaser only on page one of multipage content.
  const noTeaser = all.some(piece => "type" in piece && (piece.type === "noteaser" || (piece.type === "more" && piece.noTeaser)));
  let shown = mode === "archive" && more >= 0 ? selected.slice(0, more) : selected;
  if (mode !== "archive" && mode !== "complete" && page === 1 && noTeaser && more >= 0) shown = shown.slice(more);
  const raw: string[] = [], blocks: SerializedNode[] = [];
  for (const piece of shown) {
    if ("raw" in piece) raw.push(piece.raw);
    else if ("block" in piece) blocks.push(piece.block);
    else if (piece.type === "more" && mode !== "archive" && mode !== "complete") { const anchor = `<span id="more-${Number(post.id) || 0}"></span>`;raw.push(anchor);blocks.push({ name: "core/html", attributes: { content: anchor }, innerBlocks: [] }); }
  }
  const isJSON = usesJSON(document);
  const output: RenderDocument = isJSON ? { blocks } : { rawContent: raw.join("") };
  const title = text(post.title || ""), label = moreMarker?.text ? escape(moreMarker.text) : `<span aria-label="Continue reading ${escape(title)}">(more…)</span>`;
  const moreLink = mode === "archive" && more >= 0 ? ` <a href="${escape(permalink + "#more-" + (Number(post.id) || 0))}" class="more-link">${label}</a>` : "";
  const pagination: ContentPagination = { page, totalPages: pages.length, links: pages.map((_value, index) => ({ page: index + 1, url: contentPageURL(post, permalink, index + 1, preview), current: page === index + 1 })) };
  return { document: output, moreLink, pagination, navigation: mode === "singular" || mode === "archive" ? renderContentPagination(pagination, mode === "archive") : "" };
}
