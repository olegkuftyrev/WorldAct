import { parseDocument } from "htmlparser2";
import moment from "moment-timezone";
import type { Context, Node, RenderPost, State } from "./block-renderer.js";
import { cleanContent, HttpError } from "./utils.js";
import { postNeedsPassword } from "./post-passwords.js";
import { postPermalink } from "./permalinks.js";
import { archiveTerm, termLink, type RenderTerm } from "./term-blocks.js";

/** Supplied block-bindings.php: the fixed default-core supported attributes. */
export const bindingAttributes: Readonly<Record<string, readonly string[]>> = {
  "core/paragraph": ["content"], "core/heading": ["content"], "core/list-item": ["content"],
  "core/image": ["id", "url", "title", "alt", "caption"],
  "core/button": ["url", "text", "linkTarget", "rel"], "core/post-date": ["datetime"],
  "core/navigation-link": ["url"], "core/navigation-submenu": ["url"],
};
export type PatternOverrides = Readonly<Record<string, unknown>>;
const object = (value: unknown): value is Record<string, any> => !!value && typeof value === "object" && !Array.isArray(value);
const own = (value: object, key: string) => Object.hasOwn(value, key);
const escape = (value: unknown) => String(value ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const id = (value: unknown) => (typeof value === "string" || typeof value === "number") && /^(?:[1-9]\d{0,9})$/.test(String(value)) && Number(value) <= 2147483647 ? Number(value) : 0;
const cached = <T>(state: State, key: string, read: () => Promise<T>): Promise<T> => { if (!state.cache.has(key)) state.cache.set(key, read()); return state.cache.get(key)!; };
type Value = { value: string | number | boolean; textOnly?: boolean };

/** Every synced-pattern instance supplies its own map, including an empty one. */
export function patternOverrides(attributes: Record<string, any>): PatternOverrides {
  const content = object(attributes.content) ? attributes.content : object(attributes.overrides) ? attributes.overrides : {};
  return Object.fromEntries(Object.entries(content).map(([name, values]) => [name,
    object(attributes.content) && object(values) && object(values.values) ? values.values : values,
  ]));
}
function safeURL(value: unknown): string {
  const input = String(value ?? "").trim();
  if (input.length > 8192 || /[\u0000-\u0020\u007f<>"'\\]/.test(input) || !/^(?:https?:\/\/|mailto:|tel:|#|\/(?!\/))/i.test(input)) return "";
  if (/^https?:/i.test(input)) try { const parsed = new URL(input); if (parsed.username || parsed.password) return ""; } catch { return ""; }
  return input;
}
async function readablePost(post: RenderPost, state: State) {
  if (!["post", "page"].includes(post.type)) return false;
  if (post.status !== "publish") {
    const user = state.options.user;
    if (!state.options.preview || !user || !(["administrator", "editor"].includes(user.role) || Number(post.authorId ?? post.author_id) === user.id)) return false;
  }
  if (!postNeedsPassword(post)) return true;
  if (state.options.post?.id === post.id && state.options.post?.locked === false) return true;
  return !!state.options.canReadProtectedPost && await cached(state, `binding-post-access:${post.id}`, () => state.options.canReadProtectedPost!(post.id, state.db));
}
async function postValue(args: Record<string, any>, node: Node, context: Context, state: State): Promise<Value | null> {
  const field = args.field || args.key;
  if (!["date", "modified", "link"].includes(field)) return null;
  const navigation = ["core/navigation-link", "core/navigation-submenu"].includes(node.name || "");
  const postId = navigation ? id(node.attrs.id) : id(context.post?.id);
  if (!postId) return null;
  const post = context.post?.id === postId ? context.post : await cached(state, `binding-post:${postId}`, async () => (await state.db.query(`SELECT p.id,p.type,p.slug,p.status,p.author_id AS "authorId",p.parent_id AS "parentId",p.published_at AS "publishedAt",p.updated_at AS "updatedAt",p.created_at AS "createdAt",password_hash IS NOT NULL AS "hasPassword",
    COALESCE((SELECT jsonb_build_array(jsonb_build_object('slug',t.slug)) FROM terms t JOIN post_terms pt ON pt.term_id=t.id WHERE pt.post_id=p.id AND t.taxonomy='category' ORDER BY t.name,t.id LIMIT 1),'[]'::jsonb) AS categories
    FROM posts p WHERE p.id=$1`, [postId])).rows[0]);
  if (!post || !await readablePost(post, state)) return null;
  if (field === "link") return { value: await cached(state, `link:${postId}`, () => postPermalink(post, state.settings, state.db)) };
  const published = post.publishedAt ?? post.published_at ?? post.createdAt ?? post.created_at;
  const modified = post.updatedAt ?? post.updated_at ?? published;
  // The source compares get_the_*_date('U'), whose precision is whole seconds.
  if (field === "modified" && !(Math.floor(new Date(modified).valueOf() / 1000) > Math.floor(new Date(published).valueOf() / 1000))) return { value: "" };
  let date = moment(field === "modified" ? modified : published);
  if (!date.isValid()) return null;
  date = /^[+-]/.test(state.settings.timezone) ? date.utcOffset(state.settings.timezone) : date.tz(state.settings.timezone);
  return { value: date.format("YYYY-MM-DDTHH:mm:ssZ") };
}
async function termValue(args: Record<string, any>, node: Node, context: Context, state: State): Promise<Value | null> {
  const field = args.field;
  if (!["id", "name", "link", "slug", "description", "parent", "count"].includes(field)) return null;
  const navigation = ["core/navigation-link", "core/navigation-submenu"].includes(node.name || "");
  let term: RenderTerm | null = navigation ? null : await archiveTerm(context, state);
  if (navigation) {
    const taxonomy = node.attrs.type === "category" ? "category" : ["tag", "post_tag"].includes(node.attrs.type) ? "tag" : null;
    const termId = id(node.attrs.id);
    if (!taxonomy || !termId) return null;
    term = await cached(state, `binding-term:${taxonomy}:${termId}`, async () => (await state.db.query(`SELECT t.id,t.taxonomy,t.name,t.slug,t.description,t.parent_id AS "parentId",(SELECT count(*)::int FROM post_terms pt JOIN posts p ON p.id=pt.post_id WHERE pt.term_id=t.id AND p.type='post' AND p.status='publish') AS count FROM terms t WHERE t.id=$1 AND t.taxonomy=$2`, [termId, taxonomy])).rows[0] || null);
  }
  if (!term) return null;
  const values: Record<string, unknown> = { id: term.id, name: term.name, link: termLink(term, state), slug: term.slug, description: term.description, parent: term.parentId || 0, count: term.count };
  return { value: String(values[field] ?? ""), textOnly: !["description", "link"].includes(field) };
}
async function sourceValue(binding: Record<string, any>, node: Node, attribute: string, context: Context, state: State): Promise<Value | null> {
  if (binding.source === "core/pattern-overrides") {
    const name = node.attrs.metadata?.name, values = typeof name === "string" && context.patternOverrides && own(context.patternOverrides, name) ? context.patternOverrides[name] : null;
    const value = object(values) && own(values, attribute) ? values[attribute] : null;
    return ["string", "number", "boolean"].includes(typeof value) && (typeof value !== "number" || Number.isFinite(value)) ? { value } as Value : null;
  }
  const args = object(binding.args) ? binding.args : {};
  if (binding.source === "core/post-data") return postValue(args, node, context, state);
  if (binding.source === "core/term-data") return termValue(args, node, context, state);
  return null;
}

type Edit = { start: number; end: number; value: string };
const selectors: Record<string, Record<string, string>> = {
  "core/paragraph": { content: "p" }, "core/heading": { content: "h1,h2,h3,h4,h5,h6" }, "core/list-item": { content: "li" },
  "core/image": { url: "img", alt: "img", title: "img", caption: "figcaption", id: "img" },
  "core/button": { url: "a", text: "a,button", linkTarget: "a", rel: "a" },
};
function openerEnd(html: string, start: number) {
  let quote = "";
  for (let i = start; i < html.length; i++) { const c = html[i]; if (quote) { if (c === quote) quote = ""; } else if (c === '"' || c === "'") quote = c; else if (c === ">") return i + 1; }
  return -1;
}
function replacement(html: string, offsets: number[], name: string, attribute: string, value: unknown): Edit | null {
  const selector = selectors[name]?.[attribute]; if (!selector) return null;
  const parsed = parseDocument(html, { withStartIndices: true, withEndIndices: true });
  let element: any;
  const firstChild = offsets[0] ?? Infinity;
  for (const tag of selector.split(",")) {
    const stack: any[] = [];
    for (let i = parsed.children.length - 1; i >= 0; i--) stack.push(parsed.children[i]);
    while (stack.length) {
      const candidate = stack.pop();
      if (typeof candidate.startIndex !== "number" || candidate.startIndex >= firstChild) continue;
      if (candidate.type === "tag" && candidate.name === tag) { element = candidate; break; }
      for (let i = (candidate.children?.length || 0) - 1; i >= 0; i--) stack.push(candidate.children[i]);
    }
    if (element) break;
  }
  if (!element) return null;
  const start = element.startIndex, end = openerEnd(html, start); if (end < 0) return null;
  if (["content", "text", "caption"].includes(attribute)) {
    const last = Number(element.endIndex) + 1, close = new RegExp(`</${element.name}\\s*>$`, "i").exec(html.slice(end, last));
    if (!close) return null;
    let finish = end + close.index;
    for (const offset of offsets) if (offset >= end && offset < finish) { finish = offset; break; }
    if (name === "core/image" && attribute === "caption" && !value && !offsets.some(offset => offset >= end && offset < last)) return { start, end: last, value: "" };
    return { start: end, end: finish, value: String(value ?? "") };
  }
  const attrs: Record<string, string> = { ...element.attribs };
  if (attribute === "id") {
    const imageId = id(value);
    if (attrs.class) attrs.class = attrs.class.replace(/\bwp-image-\d+\b/g, imageId ? `wp-image-${imageId}` : "").trim();
    if (own(attrs, "data-id")) { if (imageId) attrs["data-id"] = String(imageId); else delete attrs["data-id"]; }
  } else {
    const field = ({ url: name === "core/image" ? "src" : "href", linkTarget: "target" } as Record<string, string>)[attribute] || attribute;
    if (value === false) delete attrs[field]; else attrs[field] = String(value);
  }
  return { start, end, value: `<${element.name}${Object.entries(attrs).map(([key, value]) => ` ${key}="${escape(value)}"`).join("")}>` };
}
function bindFragments(node: Node, values: Record<string, unknown>): Node {
  if (!node.fragments || !Object.keys(values).length) return node;
  let html = ""; const offsets: number[] = [];
  for (const fragment of node.fragments) { if (fragment === null) offsets.push(html.length); else html += fragment; }
  for (const [attribute, value] of Object.entries(values)) {
    const edit = replacement(html, offsets, node.name || "", attribute, value); if (!edit) continue;
    html = html.slice(0, edit.start) + edit.value + html.slice(edit.end);
    const delta = edit.value.length - (edit.end - edit.start);
    for (let i = 0; i < offsets.length; i++) if (offsets[i] >= edit.end) offsets[i] += delta;
  }
  const fragments: Array<string | null> = []; let previous = 0;
  for (const offset of offsets) { fragments.push(html.slice(previous, offset), null); previous = offset; }
  fragments.push(html.slice(previous));
  return { ...node, html, fragments };
}

/** Resolve only fixed core sources; leave the input tree and cached entity intact. */
export async function applyBlockBindings(node: Node, context: Context, state: State): Promise<Node> {
  const supported = bindingAttributes[node.name || ""]; if (!supported) return node;
  const metadata = object(node.attrs.metadata) ? node.attrs.metadata : {}, original = object(metadata.bindings) ? metadata.bindings : {};
  let bindings = original;
  if (object(original.__default) && original.__default.source === "core/pattern-overrides") bindings = Object.fromEntries(supported.map(attribute => [attribute, original[attribute] ?? { source: "core/pattern-overrides" }]));
  const values: Record<string, unknown> = {}, attrs = { ...node.attrs };
  for (const attribute of supported) {
    const binding = bindings[attribute]; if (!object(binding)) continue;
    const result = await sourceValue(binding, node, attribute, context, state); if (result === null) continue;
    let value: unknown = result.value;
    if (typeof value === "string" && Buffer.byteLength(value) > 2 * 1024 * 1024) throw new HttpError(413, "Bound block content exceeds the 2 MiB limit.");
    if (["content", "text", "caption"].includes(attribute)) value = result.textOnly ? escape(value) : cleanContent(value === false ? "" : String(value));
    else if (attribute === "url") value = value === false ? false : safeURL(value);
    else if (attribute === "id") {
      value = id(value);
      if (own(attrs, "data-id")) { if (value) attrs["data-id"] = value; else delete attrs["data-id"]; }
    }
    attrs[attribute] = value; values[attribute] = value;
  }
  if (bindings !== original) attrs.metadata = { ...metadata, bindings };
  if (node.name === "core/post-date" && !own(attrs, "datetime") && !(object(bindings.datetime) && bindings.datetime.source != null && bindings.datetime.args != null)) {
    const legacy = await postValue({ field: attrs.displayType === "modified" || attrs.displayModified ? "modified" : "date" }, node, context, state);
    if (legacy) attrs.datetime = legacy.value;
  }
  return bindFragments({ ...node, attrs }, values);
}
