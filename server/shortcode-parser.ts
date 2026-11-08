/** Fixed source builtins only. No callback registry, plugin code, or evaluation. */
import { SHORTCODE_NAMES, hasShortcodes } from "../shared/shortcodes.js";
export { SHORTCODE_NAMES, hasShortcodes };
export type Shortcode = { tag: string; attributes: Record<string, string>; content: string | null; raw: string; escaped: boolean; suffix: string; start: number; end: number };
export type ShortcodePiece = string | Shortcode;
export class ShortcodeLimitError extends Error {}
type Token = { tag: string; attributes: Record<string, string>; start: number; end: number; closing: boolean; selfClosing: boolean; extraOpen: boolean; extraClose: boolean; pair?: number };
const inert = new Set(["code", "pre", "script", "style", "textarea", "xmp"]);
const decode = (value: string) => value.replace(/\\([\\"'])/g, "$1");
export function shortcodeAttributes(input: string) {
  const result: Record<string, string> = Object.create(null);
  const pattern = /([\w-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"']+))|"([^"]*)"|'([^']*)'|([^\s"']+)/g;
  let match: RegExpExecArray | null, count = 0, position = 0;
  while ((match = pattern.exec(input.replace(/[\u00a0\u200b]/g, " ")))) {
    if (++count > 64) throw new ShortcodeLimitError("A shortcode has too many attributes.");
    const key = match[1]?.toLowerCase() || String(position++);
    if (["__proto__", "constructor", "prototype"].includes(key)) continue;
    result[key] = decode(match[2] ?? match[3] ?? match[4] ?? match[5] ?? match[6] ?? match[7] ?? "");
  }
  return result;
}
function tagEnd(input: string, start: number) {
  let quote = "";
  for (let index = start; index < input.length; index++) {
    const character = input[index];
    if (quote) { if (character === quote) quote = ""; }
    else if (character === '"' || character === "'") quote = character;
    else if (character === ">") return index + 1;
  }
  return input.length;
}
function tokens(input: string, editableComments?: Set<number>): Token[] {
  if (input.length > 2 * 1024 * 1024) throw new ShortcodeLimitError("Shortcode content exceeds the 2 MiB limit.");
  const output: Token[] = [], protectedTags: string[] = [], stack = new Map<string, number[]>();
  const lower = input.toLowerCase();
  for (let index = 0; index < input.length;) {
    const protectedTag = protectedTags.at(-1);
    if (protectedTag && ["script", "style", "textarea", "xmp"].includes(protectedTag)) {
      let closing = lower.indexOf("</" + protectedTag, index);
      while (closing >= 0 && !/[\s/>]/.test(input[closing + protectedTag.length + 2] || "")) closing = lower.indexOf("</" + protectedTag, closing + 2);
      if (closing < 0) break;
      index = closing;
    }
    if (input.startsWith("<!--", index)) { if (!protectedTags.length) editableComments?.add(index); const end = input.indexOf("-->", index + 4); index = end < 0 ? input.length : end + 3; continue; }
    if (input[index] === "<" && /^<\/?[a-z!]/i.test(input.slice(index, index + 3))) {
      const end = tagEnd(input, index + 1), name = /^<\s*(\/?)\s*([a-z][a-z\d-]*)/i.exec(input.slice(index, end));
      if (name) {
        const tag = name[2].toLowerCase();
        if (inert.has(tag)) {
          if (name[1]) { if (protectedTags.at(-1) === tag) protectedTags.pop(); }
          else if (!/\/\s*>$/.test(input.slice(index, end))) protectedTags.push(tag);
          if (protectedTags.length > 100) throw new ShortcodeLimitError("Shortcode HTML nesting is too deep.");
        }
      }
      index = end; continue;
    }
    if (editableComments || protectedTags.length || input[index] !== "[") { index++; continue; }
    const start = index, extraOpen = input[index + 1] === "[", header = index + (extraOpen ? 2 : 1);
    const name = /^(\/?)([a-z_][a-z\d_-]*)(?=[\s/\]])/i.exec(input.slice(header, header + 100));
    if (!name) { index++; continue; }
    let end = header + name[0].length, quote = "";
    for (; end < input.length && end - start <= 8192; end++) {
      const character = input[end];
      if (quote) { if (character === quote && input[end - 1] !== "\\") quote = ""; }
      else if (character === '"' || character === "'") quote = character;
      else if (character === "]") break;
      else if (character === "<" || character === "[") break;
    }
    if (input[end] !== "]" || quote || end - start > 8192) { index = Math.max(index + 1, end); continue; }
    const extraClose = input[end + 1] === "]", closing = !!name[1], attributesText = input.slice(header + name[0].length, end), selfClosing = /\/\s*$/.test(attributesText);
    if (!SHORTCODE_NAMES.has(name[2])) { index = end + 1 + (extraClose ? 1 : 0); continue; }
    const token: Token = { tag: name[2], attributes: closing ? {} : shortcodeAttributes(attributesText.replace(/\/\s*$/, "")), start, end: end + 1 + (extraClose ? 1 : 0), closing, selfClosing, extraOpen, extraClose };
    if (output.length >= 1024) throw new ShortcodeLimitError("Too many shortcodes in one content fragment.");
    const position = output.push(token) - 1;
    if (!closing && !selfClosing && !(extraOpen && extraClose)) {
      const previous = stack.get(token.tag) || []; previous.push(position); stack.set(token.tag, previous);
    } else if (closing) {
      const previous = stack.get(token.tag), open = previous?.pop();
      if (open !== undefined) { output[open].pair = position; token.pair = open; }
    }
    index = token.end;
  }
  let depth = 0;
  for (let index = 0; index < output.length; index++) {
    const token = output[index];
    if (token.pair === undefined) continue;
    depth += token.closing ? -1 : 1;
    if (depth > 12) throw new ShortcodeLimitError("Shortcode nesting is too deep.");
  }
  return output;
}
export function parseShortcodes(input: string): ShortcodePiece[] {
  const scanned = tokens(input), output: ShortcodePiece[] = []; let offset = 0;
  for (let index = 0; index < scanned.length; index++) {
    const token = scanned[index];
    if (token.start < offset || token.closing) continue;
    if (token.start > offset) output.push(input.slice(offset, token.start));
    const close = token.pair === undefined ? undefined : scanned[token.pair];
    const end = close?.end ?? token.end, raw = input.slice(token.start, end);
    const escaped = token.extraOpen && (close ? close.extraClose : token.extraClose);
    output.push(token.extraOpen && !escaped ? raw : { tag: token.tag, attributes: token.attributes, content: close ? input.slice(token.end, close.start) : null, raw, escaped, suffix: !escaped && (close?.extraClose || !close && token.extraClose) ? "]" : "", start: token.start, end });
    offset = end;
  }
  if (offset < input.length) output.push(input.slice(offset));
  return output;
}
export function formatShortcodeBlocks(input: string, format: (content: string) => string): string {
  if (!/<!--\s*wp:(?:core\/)?shortcode\b/.test(input)) return input;
  const eligible = new Set<number>(); tokens(input, eligible);
  return input.replace(/(<!--\s*wp:(?:core\/)?shortcode(?:\s+\{[^]*?\})?\s*-->)([^]*?)(<!--\s*\/wp:(?:core\/)?shortcode\s*-->)/g,
    (match, open, content, close, offset) => eligible.has(offset) ? open + format(content) + close : match);
}
export function stripBuiltinShortcodes(input: string, depth = 0): string {
  if (!hasShortcodes(input) || depth > 12) return input;
  try { return parseShortcodes(input).map(piece => typeof piece === "string" ? piece : piece.escaped ? piece.raw.slice(1, -1) : piece.suffix).join(""); }
  catch (error) { if (error instanceof ShortcodeLimitError) return input; throw error; }
}
