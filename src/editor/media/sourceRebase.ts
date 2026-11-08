import { parseDocument } from "htmlparser2";
import { parse, type Block } from "@wordpress/blocks";

export type ImageAttributes = Record<string, unknown>;
export type NativeImageChange = {
  clientId: string;
  expected: ImageAttributes;
  changes: ImageAttributes;
};
const value = (input: unknown) =>
  input === undefined || input === null
    ? ""
    : typeof input === "object"
      ? JSON.parse(JSON.stringify(input))
      : input;
const equal = (a: unknown, b: unknown) =>
  JSON.stringify(value(a)) === JSON.stringify(value(b));
export const imageAttributes = (
  block: Block | null | undefined,
): ImageAttributes | undefined =>
  block?.name === "core/image"
    ? JSON.parse(JSON.stringify(block.attributes))
    : undefined;
export function changedImageAttributes(
  before: ImageAttributes,
  after: ImageAttributes,
): ImageAttributes {
  return Object.fromEntries(
    [...new Set([...Object.keys(before), ...Object.keys(after)])]
      .filter((key) => !equal(before[key], after[key]))
      .map((key) => [key, after[key]]),
  );
}
const images = (blocks: Block[]): Block[] =>
  blocks.flatMap((block) => [
    ...(block.name === "core/image" ? [block] : []),
    ...images(block.innerBlocks || []),
  ]);
const key = (block: Block) =>
  JSON.stringify([block.attributes.id, block.attributes.url]);
/** Keep the real Image callback's block owner alive across source reparsing.
 * Exact peers are paired first; an ambiguous newly duplicated image is never
 * assigned somebody else's pending native operation. No parser fields change. */
export function retainSourceImageOwners(
  next: Block[],
  previous: Block[],
): Block[] {
  const old = images(previous),
    fresh = images(next),
    matches = new Map<Block, string>(),
    used = new Set<Block>();
  for (const item of fresh) {
    const signature = JSON.stringify(item.attributes),
      candidates = old.filter(
        (peer) =>
          !used.has(peer) &&
          key(peer) === key(item) &&
          JSON.stringify(peer.attributes) === signature,
      );
    const peers = fresh.filter(
      (peer) =>
        key(peer) === key(item) &&
        JSON.stringify(peer.attributes) === signature,
    );
    if (candidates.length === 1 && peers.length === 1) {
      matches.set(item, candidates[0].clientId);
      used.add(candidates[0]);
    }
  }
  for (const item of fresh)
    if (!matches.has(item)) {
      const candidates = old.filter(
        (peer) => !used.has(peer) && key(peer) === key(item),
      );
      const peers = fresh.filter(
        (peer) => !matches.has(peer) && key(peer) === key(item),
      );
      if (candidates.length === 1 && peers.length === 1) {
        for (let i = 0; i < peers.length; i++) {
          matches.set(peers[i], candidates[i].clientId);
          used.add(candidates[i]);
        }
      }
    }
  const walk = (items: Block[]): Block[] =>
    items.map((block) => ({
      ...block,
      clientId: matches.get(block) || block.clientId,
      innerBlocks: walk(block.innerBlocks || []),
    }));
  return walk(next);
}

// Delimiter grammar from the supplied Gutenberg default parser. Offsets are
// used only to splice an already native-parsed Image; this is not validation.
const tokens = () =>
  /<!--[ \t\f\r\n]+(\/)?wp:([a-z][a-z0-9_-]*\/)?([a-z][a-z0-9_-]*)[ \t\f\r\n]+({(?:(?=([^}]+|}+(?=})|(?!}[ \t\f\r\n]+\/?-->)[^])*)\5|[^]*?)}[ \t\f\r\n]+)?(\/)?-->/g;
type Range = {
  start: number;
  openEnd: number;
  closeStart: number;
  end: number;
  attrsStart: number;
  attrsEnd: number;
  id: unknown;
};
function ranges(source: string): Range[] {
  const stack: {
      name: string;
      start: number;
      openEnd: number;
      attrsStart: number;
      attrsEnd: number;
      id: unknown;
    }[] = [],
    found: Range[] = [];
  for (const match of source.matchAll(tokens())) {
    const name = (match[2] || "core/") + match[3],
      start = match.index!;
    if (match[1]) {
      const opened = stack.pop();
      if (opened?.name === name && name === "core/image")
        found.push({
          ...opened,
          closeStart: start,
          end: start + match[0].length,
        });
    } else if (!match[6]) {
      const json = match[4]?.trimEnd();
      let attrs: any = {};
      try {
        attrs = json ? JSON.parse(json) : {};
      } catch {
        /* Native parser owns recovery. */
      }
      const attrsStart = json ? start + match[0].indexOf(json) : -1;
      stack.push({
        name,
        start,
        openEnd: start + match[0].length,
        attrsStart,
        attrsEnd: attrsStart + (json?.length || 0),
        id: attrs.id,
      });
    }
  }
  return found;
}
function stringEnd(text: string, start: number): number {
  let i = start + 1;
  for (; i < text.length; i++) {
    if (text[i] === "\\") i++;
    else if (text[i] === '"') return i + 1;
  }
  throw Error("Unfinished source string");
}
function jsonFields(text: string) {
  const fields: {
    key: string;
    start: number;
    valueStart: number;
    valueEnd: number;
    comma?: number;
  }[] = [];
  let i = 1;
  while (i < text.length) {
    while (/\s/.test(text[i] || "")) i++;
    if (text[i] === "}") break;
    const start = i,
      end = stringEnd(text, i),
      key = JSON.parse(text.slice(i, end));
    i = end;
    while (/\s/.test(text[i] || "")) i++;
    if (text[i++] !== ":") throw Error("Source attribute separator");
    while (/\s/.test(text[i] || "")) i++;
    const valueStart = i;
    let depth = 0;
    for (; i < text.length; i++) {
      const c = text[i];
      if (c === '"') {
        i = stringEnd(text, i) - 1;
        continue;
      }
      if (c === "{" || c === "[") depth++;
      if (c === "}" || c === "]") {
        if (depth === 0) break;
        depth--;
      }
      if (c === "," && depth === 0) break;
    }
    let valueEnd = i;
    while (/\s/.test(text[valueEnd - 1] || "")) valueEnd--;
    const comma = text[i] === "," ? i : undefined;
    fields.push({ key, start, valueStart, valueEnd, comma });
    if (comma === undefined) break;
    i++;
  }
  return fields;
}
const jsonValue = (input: unknown) =>
  JSON.stringify(input)
    .replaceAll("\\\\", "\\u005c")
    .replaceAll("--", "\\u002d\\u002d")
    .replaceAll("<", "\\u003c")
    .replaceAll(">", "\\u003e")
    .replaceAll("&", "\\u0026")
    .replaceAll('\\"', "\\u0022");
function patchJSON(text: string, name: string, input: unknown): string {
  const fields = jsonFields(text),
    index = fields.findIndex((field) => field.key === name),
    field = fields[index];
  if (!field)
    return input === undefined
      ? text
      : text.slice(0, -1) +
          (fields.length ? "," : "") +
          JSON.stringify(name) +
          ":" +
          jsonValue(input) +
          "}";
  if (input !== undefined)
    return (
      text.slice(0, field.valueStart) +
      jsonValue(input) +
      text.slice(field.valueEnd)
    );
  const start =
      field.comma !== undefined
        ? field.start
        : index > 0
          ? fields[index - 1].comma!
          : field.start,
    end = field.comma !== undefined ? field.comma + 1 : field.valueEnd;
  return text.slice(0, start) + text.slice(end);
}
const escapeAttribute = (input: unknown, quote: string) =>
  String(input ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll(quote, quote === '"' ? "&quot;" : "&#39;");
function tagEnd(html: string, start: number): number {
  let quote = "";
  for (let i = start; i < html.length; i++) {
    const c = html[i];
    if (quote) {
      if (c === quote) quote = "";
    } else if (c === '"' || c === "'") quote = c;
    else if (c === ">") return i + 1;
  }
  throw Error("Unfinished source tag");
}
function setAttribute(tag: string, name: string, input: unknown): string {
  const attrs =
    /\s+([^\s"'=<>`]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
  attrs.lastIndex = tag.match(/^<[^\s/>]+/)?.[0].length || 1;
  let match: RegExpExecArray | null;
  while ((match = attrs.exec(tag))) {
    if (match[1].toLowerCase() !== name) continue;
    const raw = match[0],
      eq = raw.indexOf("=");
    if (input === undefined)
      return tag.slice(0, match.index) + tag.slice(match.index + raw.length);
    if (eq < 0)
      return (
        tag.slice(0, match.index) +
        raw +
        '="' +
        escapeAttribute(input, '"') +
        '"' +
        tag.slice(match.index + raw.length)
      );
    const valueAt = eq + 1 + (raw.slice(eq + 1).match(/^\s*/)?.[0].length || 0),
      quote = raw[valueAt] === "'" ? "'" : '"';
    return (
      tag.slice(0, match.index) +
      raw.slice(0, valueAt) +
      quote +
      escapeAttribute(input, quote) +
      quote +
      tag.slice(match.index + raw.length)
    );
  }
  if (input === undefined) return tag;
  const end = tag.search(/\/?\s*>$/);
  return (
    tag.slice(0, end) +
    " " +
    name +
    '="' +
    escapeAttribute(input, '"') +
    '"' +
    tag.slice(end)
  );
}
type Edit = { start: number; end: number; text: string };
/** Splice only genuine source-native Image fields. Everything else, including
 * malformed neighboring blocks, JSON whitespace and a newer caption stays raw. */
export function rebaseNativeImageSource(
  source: string,
  blocks: Block[],
  change: NativeImageChange,
): { source: string; blocks: Block[]; changed: boolean } {
  const current = images(blocks).find(
    (block) => block.clientId === change.clientId,
  );
  if (
    !current ||
    current.isValid === false ||
    !equal(current.attributes.id, change.expected.id) ||
    !equal(current.attributes.url, change.expected.url)
  )
    return { source, blocks, changed: false };
  const allowed = new Set(["id", "url", "sizeSlug", "href", "alt", "caption"]),
    patch = Object.fromEntries(
      Object.entries(change.changes).filter(
        ([name]) =>
          allowed.has(name) &&
          equal(current.attributes[name], change.expected[name]) &&
          (name !== "href" ||
            equal(
              current.attributes.linkDestination,
              change.expected.linkDestination,
            )),
      ),
    );
  if (!Object.keys(patch).length) return { source, blocks, changed: false };
  const candidates = ranges(source).filter((range) =>
    equal(range.id, current.attributes.id),
  );
  const peers = images(blocks).filter((block) =>
    equal(block.attributes.id, current.attributes.id),
  );
  if (candidates.length !== peers.length)
    return { source, blocks, changed: false };
  const range = candidates[peers.indexOf(current)],
    html = source.slice(range.openEnd, range.closeStart),
    doc = parseDocument(html, { withStartIndices: true, withEndIndices: true });
  const elements: any[] = [];
  const visit = (nodes: any[]) => {
    for (const node of nodes) {
      if (node.type === "tag") elements.push(node);
      if (node.children) visit(node.children);
    }
  };
  visit(doc.children);
  const image = elements.find((node) => node.name === "img"),
    figure = elements.find((node) => node.name === "figure"),
    caption = elements.find((node) => node.name === "figcaption"),
    link = elements.find(
      (node) =>
        node.name === "a" &&
        node.children?.some((child: any) => child === image),
    );
  if (!image || !figure || !equal(image.attribs.src, current.attributes.url))
    return { source, blocks, changed: false };
  const edits: Edit[] = [],
    tagPatches = new Map<any, Record<string, unknown>>();
  const attr = (node: any, name: string, input: unknown) => {
    if (!node) return;
    tagPatches.set(node, { ...tagPatches.get(node), [name]: input });
  };
  if (Object.hasOwn(patch, "url")) attr(image, "src", patch.url);
  if (Object.hasOwn(patch, "alt")) attr(image, "alt", patch.alt);
  if (Object.hasOwn(patch, "href")) attr(link, "href", patch.href);
  if (Object.hasOwn(patch, "id"))
    attr(
      image,
      "class",
      String(image.attribs.class || "").replace(
        new RegExp(`(^|\\s)wp-image-${Number(current.attributes.id)}(?=\\s|$)`),
        `$1wp-image-${Number(patch.id)}`,
      ),
    );
  if (Object.hasOwn(patch, "sizeSlug")) {
    const classes = String(figure.attribs.class || "");
    const token = new RegExp(
      `(^|\\s)size-${String(current.attributes.sizeSlug).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?=\\s|$)`,
    );
    attr(
      figure,
      "class",
      token.test(classes)
        ? classes.replace(
            token,
            patch.sizeSlug ? `$1size-${patch.sizeSlug}` : "$1",
          )
        : classes + (patch.sizeSlug ? ` size-${patch.sizeSlug}` : ""),
    );
  }
  for (const [node, attributes] of tagPatches) {
    const start = range.openEnd + node.startIndex,
      end = range.openEnd + tagEnd(html, node.startIndex);
    let text = source.slice(start, end);
    for (const [name, input] of Object.entries(attributes))
      text = setAttribute(text, name, input);
    edits.push({ start, end, text });
  }
  if (Object.hasOwn(patch, "caption")) {
    const text = String(patch.caption ?? "");
    if (caption) {
      const start = range.openEnd + caption.startIndex,
        end = range.openEnd + caption.endIndex + 1;
      if (!text) edits.push({ start, end, text: "" });
      else {
        const innerStart = range.openEnd + tagEnd(html, caption.startIndex),
          innerEnd = range.openEnd + html.lastIndexOf("</", caption.endIndex);
        edits.push({ start: innerStart, end: innerEnd, text });
      }
    } else if (text) {
      const pos = range.openEnd + html.lastIndexOf("</", figure.endIndex);
      edits.push({
        start: pos,
        end: pos,
        text:
          '<figcaption class="wp-element-caption">' + text + "</figcaption>",
      });
    }
  }
  const commentChanges = Object.entries(patch).filter(
    ([name]) => name === "id" || name === "sizeSlug",
  );
  if (commentChanges.length) {
    if (range.attrsStart < 0) return { source, blocks, changed: false };
    let json = source.slice(range.attrsStart, range.attrsEnd);
    for (const [name, input] of commentChanges)
      json = patchJSON(json, name, input);
    edits.push({ start: range.attrsStart, end: range.attrsEnd, text: json });
  }
  let next = source;
  for (const edit of edits.sort((a, b) => b.start - a.start))
    next = next.slice(0, edit.start) + edit.text + next.slice(edit.end);
  // Validate only the affected Image with the same registered native parser.
  // Keep all other raw bytes and native recovery records exactly as they were.
  const candidate = parse(
    next.slice(range.start, range.end + next.length - source.length),
  )[0];
  if (
    candidate?.name !== "core/image" ||
    candidate.isValid === false ||
    Object.keys(patch).some(
      (name) => !equal(candidate.attributes[name], patch[name]),
    )
  )
    return { source, blocks, changed: false };
  const nativePatch = Object.fromEntries(
    Object.keys(patch).map((name) => [name, candidate.attributes[name]]),
  );
  const walk = (items: Block[]): Block[] =>
    items.map((block) =>
      block === current
        ? { ...block, attributes: { ...block.attributes, ...nativePatch } }
        : block.innerBlocks?.length
          ? { ...block, innerBlocks: walk(block.innerBlocks) }
          : block,
    );
  return { source: next, blocks: walk(blocks), changed: next !== source };
}
