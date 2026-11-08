/** Fixed data adapters for the supplied legacy editor; never execute saved text. */
import { string as shortcode } from "@wordpress/shortcode";
import { parseDocument } from "htmlparser2";

export const escapeClassicHTML = (value: unknown) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (character) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        character
      ]!,
  );
export function classicMediaURL(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length > 8192 ||
    !/^(?:https?:\/\/|\/(?!\/))/i.test(value) ||
    /[\u0000-\u0020<>"'\\]/.test(value)
  )
    return "";
  try {
    const url = new URL(value, "https://worldact.invalid/");
    return !url.username && !url.password ? value : "";
  } catch {
    return "";
  }
}
/** wpeditimage's caption regex is not an HTML tokenizer. Hide attribute bracket
 * text from that regex while the source HTML parser retains its exact value. */
export function protectClassicCaptionAttributes(html: string): string {
  return /\[(?:wp_)?caption[\s\]]/.test(html)
    ? html.replace(/<[a-z](?:[^>"']|"[^"]*"|'[^']*')*>/gi, tag => tag.replace(/\[/g, "&#91;").replace(/\]/g, "&#93;"))
    : html;
}
/** Canonical attachment HTML is not plaintext. Match the source caption paste
 * boundary: retain inline formatting, remove active/media nodes and flatten
 * blocks to breaks. Entity decoding belongs to the HTML parser, exactly once. */
export function classicImageCaption(value: unknown): string {
  const raw = typeof value === "string" ? value
    : value && typeof value === "object" && "raw" in value ? (value as { raw: unknown }).raw : "";
  if (typeof raw !== "string" || !raw || raw.length > 120_000) return "";
  const root = parseDocument(raw), inline = new Set(["a", "strong", "em", "b", "i", "u", "s", "del", "ins", "code", "kbd", "small", "sub", "sup", "span", "mark", "abbr", "cite", "q"]);
  const blocked = new Set(["script", "style", "svg", "math", "iframe", "object", "embed", "audio", "video", "img", "input", "textarea", "button", "form"]);
  const blocks = new Set(["p", "div", "section", "article", "blockquote", "pre", "ul", "ol", "li", "h1", "h2", "h3", "h4", "h5", "h6", "dl", "dt", "dd", "figure", "figcaption", "table", "tr", "td", "th"]);
  let visible = "";
  function render(node: (typeof root.children)[number]): string {
    if (node.type === "text") {
      visible += node.data;
      // A durable inline boundary prevents literal caption terminators from
      // ending wpeditimage's source regex or activating another builtin. The
      // span has no visual styles and survives TinyMCE and canonical sanitation.
      return node.data.replace(/[&<>]/g, character => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[character]!)
        .replace(/\[(\/?(?:caption|wp_caption|gallery|audio|video|playlist|embed))(?=[\s/\]])/gi,
        '[<span class="worldact-classic-caption-literal">$1</span>');
    }
    if (!("name" in node) || !("children" in node) || blocked.has(node.name)) return "";
    if (node.name === "br") return "<br />";
    const content = node.children.map(render).join("");
    if (!inline.has(node.name)) return content + (blocks.has(node.name) && content ? "<br />" : "");
    const attrs: string[] = [];
    for (const [name, value] of Object.entries(node.attribs)) {
      if (["title", "lang"].includes(name) || name === "dir" && /^(ltr|rtl|auto)$/.test(value))
        attrs.push(`${name}="${escapeClassicHTML(value)}"`);
      else if (name === "class") {
        const classes = value.split(/\s+/).filter(token => /^[a-zA-Z_-][\w-]{0,100}$/.test(token) && !/^mce/i.test(token)).slice(0, 20).join(" ");
        if (classes) attrs.push(`class="${classes}"`);
      } else if (name === "style" && !/(?:url\s*\(|expression\s*\(|@import|[<>\\\0])/i.test(value)) attrs.push(`style="${escapeClassicHTML(value)}"`);
      else if (node.name === "a" && name === "href") {
        try { const url = new URL(value, "https://worldact.invalid/"); if (!url.username && !url.password && /^(https?:|mailto:|tel:)$/.test(url.protocol) && !value.startsWith("//") && !/[\u0000-\u0020<>"'\\]/.test(value)) attrs.push(`href="${escapeClassicHTML(value)}"`); } catch { /* omit unsafe links */ }
      } else if (node.name === "a" && name === "target" && /^_(?:blank|self|parent|top)$/.test(value)) attrs.push(`target="${value}"`);
      else if (node.name === "a" && name === "rel" && /^[\w\s-]*$/.test(value)) attrs.push(`rel="${escapeClassicHTML(value)}"`);
    }
    return `<${node.name}${attrs.length ? " " + attrs.join(" ") : ""}>${content}</${node.name}>`;
  }
  const html = root.children.map(render).join("");
  return visible.replace(/[\s\u00a0\u200b\ufeff]/g, "") ? html.trim().replace(/^(?:<br\s*\/>\s*)+|(?:\s*<br\s*\/>)+$/g, "").replace(/(?:<br\s*\/>\s*){2,}/g, "<br />") : "";
}
export function classicMediaHTML(item: Record<string, any>): string {
  const url = classicMediaURL(item.url || item.source_url),
    type = String(item.mime || item.mime_type || ""),
    title =
      typeof item.title === "object"
        ? item.title.raw || item.title.rendered
        : item.title;
  if (!url) return "";
  const text = escapeClassicHTML(title || item.filename || "Media"),
    href = escapeClassicHTML(url),
    id = Number.isSafeInteger(item.id) && item.id > 0 ? item.id : 0;
  if (type.startsWith("image/")) {
    const caption = classicImageCaption(item.caption);
    const dimension = (name: string) =>
      Number.isSafeInteger(item[name]) && item[name] > 0
        ? ` ${name}="${item[name]}"`
        : "";
    const image = `<img src="${href}" alt="${escapeClassicHTML(item.alt || item.alt_text || "")}" class="${caption ? "" : "alignnone "}size-full${id ? ` wp-image-${id}` : ""}"${dimension("width")}${dimension("height")} />`;
    return caption ? protectClassicCaptionAttributes(shortcode({ tag: "caption", type: "closed", attrs: { named: {
      ...(dimension("width") ? { width: String(item.width) } : {}),
      ...(id ? { id: "attachment_" + id } : {}), align: "alignnone",
    }, numeric: [] }, content: image + " " + caption })) : image;
  }
  if (type.startsWith("audio/") || type.startsWith("video/")) {
    const tag = type.startsWith("audio/") ? "audio" : "video";
    return `<${tag} controls="controls" preload="none" src="${href}"><a href="${href}">${text}</a></${tag}>`;
  }
  return `<a href="${href}">${text}</a>`;
}
export type LegacyLink = {
  ID: number;
  title: string;
  permalink: string;
  info: string;
};
export async function classicLinkQuery(
  search: unknown,
  page: unknown,
  signal: AbortSignal,
  fetcher: typeof fetch = fetch,
): Promise<LegacyLink[]> {
  const query = new URLSearchParams({
    search: typeof search === "string" ? search.slice(0, 200) : "",
    page: String(Math.min(1000, Math.max(1, Math.trunc(Number(page)) || 1))),
    per_page: "20",
  });
  const response = await fetcher(`/wp-json/wp/v2/search?${query}`, {
    signal,
    credentials: "same-origin",
    headers: { Accept: "application/json" },
  });
  if (!response.ok)
    throw new Error("Links could not be loaded. Try searching again.");
  const rows: unknown = await response.json();
  if (!Array.isArray(rows))
    throw new Error("Links could not be loaded. Try searching again.");
  return rows.slice(0, 20).flatMap((row) =>
    row &&
    Number.isSafeInteger(row.id) &&
    row.id > 0 &&
    classicMediaURL(row.url)
      ? [
          {
            ID: row.id,
            title: escapeClassicHTML(row.title || "(no title)"),
            permalink: row.url,
            info: row.subtype === "page" ? "Page" : "Post",
          },
        ]
      : [],
  );
}
