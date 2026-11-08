import { cleanContent, HttpError } from "./utils.js";
import { randomUUID } from "node:crypto";

export type Footnote = { id: string; content: string };
export const MAX_FOOTNOTES = 500;
export const MAX_FOOTNOTES_BYTES = 1_000_000;
const invalid = () => new HttpError(400, "Provide footnotes as a JSON array of unique safe IDs and rich-text content.");

/** Native WordPress metadata stores JSON text; internal workflows use an array. */
export function parseFootnotes(value: unknown): Footnote[] {
  if (typeof value === "string") {
    if (!value) return [];
    if (Buffer.byteLength(value) > MAX_FOOTNOTES_BYTES) throw new HttpError(413, "Footnotes exceed 1 MB.");
    try { value = JSON.parse(value); } catch { throw invalid(); }
  }
  if (!Array.isArray(value) || value.length > MAX_FOOTNOTES) throw invalid();
  const ids = new Set<string>();
  let bytes = 0;
  const notes = value.map((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry) ||
      !Object.hasOwn(entry, "id") || !Object.hasOwn(entry, "content") || Object.keys(entry).some((key) => !["id", "content"].includes(key)) ||
      typeof entry.id !== "string" || !/^[a-z0-9_-]{1,100}$/.test(entry.id) || ids.has(entry.id) ||
      typeof entry.content !== "string") throw invalid();
    ids.add(entry.id);
    const rawBytes = Buffer.byteLength(entry.content);
    if (rawBytes > 20_000 || (bytes += rawBytes) > MAX_FOOTNOTES_BYTES) throw new HttpError(413, "Footnote content exceeds the supported size.");
    return { id: entry.id, content: cleanContent(entry.content) };
  });
  if (Buffer.byteLength(JSON.stringify(notes)) > MAX_FOOTNOTES_BYTES) throw new HttpError(413, "Footnotes exceed 1 MB.");
  return notes;
}

export function serializeFootnotes(value: unknown): string {
  return JSON.stringify(parseFootnotes(value));
}

/** Context/access is established by the public renderer or authorized preview. */
export function renderFootnotes(post: Record<string, any> | null, attributes: () => string): string {
  if (!post || post.locked || (post.locked !== false && (post.hasPassword || post.password_hash || post._passwordHash))) return "";
  const notes = parseFootnotes(post.footnotes ?? []);
  if (!notes.length) return "";
  return `<ol${attributes()}>${notes.map((note, index) => `<li id="${note.id}">${note.content} <a href="#${note.id}-link" aria-label="Jump to footnote reference ${index + 1}">↩︎</a></li>`).join("")}</ol>`;
}

/** Copy imports receive fresh fragment IDs so originals and copies can coexist. */
export function freshFootnoteIds(notes: Footnote[], rawContent: string): Map<string, string> {
  const ids = new Set(notes.map((note) => note.id));
  for (const match of rawContent.matchAll(/<sup\b[^>]*\bdata-fn\s*=\s*(["'])([a-z0-9_-]{1,100})\1[^>]*>/gi)) {
    ids.add(match[2]);
    if (ids.size > MAX_FOOTNOTES) throw new HttpError(413, "Select at most 500 unique footnote references per post.");
  }
  return new Map([...ids].map((id) => [id, "fn-" + randomUUID()]));
}
