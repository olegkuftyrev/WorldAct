import sanitizeHtml from "sanitize-html";
import type { AuthRequest } from "./auth.js";
import { gridTemplateColumnsPattern } from "./block-layout.js";
import { LEGACY_CONTENT_MARKER, canonicalLegacyMarker } from "./legacy-content.js";
import { backgroundImagePattern, backgroundSizePattern, backgroundPositionPattern, backgroundRepeatPattern, backgroundAttachmentPattern } from "./background-styles.js";

export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
export function parseId(value: unknown): number {
  if (
    typeof value !== "string" ||
    !/^[1-9]\d{0,9}$/.test(value) ||
    Number(value) > 2_147_483_647
  )
    throw new HttpError(400, "Invalid item ID.");
  return Number(value);
}
export function needUser(req: AuthRequest) {
  if (!req.user) throw new HttpError(401, "Please log in to continue.");
  return req.user;
}
const lengthAtom =
  "(?:var\\(--wp--[a-z\\d-]+\\)|auto|none|initial|inherit|unset|normal|fit-content|-?\\d+(?:\\.\\d+)?(?:px|em|rem|%|vh|vw|ch|ex|pt)?)";
const length = new RegExp(`^${lengthAtom}(?:\\s+${lengthAtom}){0,3}$`, "i");
const gradient =
  /^(?!.*(?:url|expression|image-set|\\|;|@|:))(?:linear-gradient|radial-gradient|conic-gradient)\((?:[^()"'<>]|(?:rgba?|hsla?|var)\([^()"'<>]*\))*\)$/i;
const shadow = /^(?!.*(?:url|expression|\\|;|@|:))[a-z\d\s#.,()%+\-]+$/i;
const color =
  /^(?:#[a-f\d]{3,8}|[a-z]+|(?:rgb|hsl)a?\([\d\s,.%/+\-]+\)|var\(--wp--[a-z\d-]+\))$/i;
const border =
  /^(?:0|none|(?:\d+(?:\.\d+)?)(?:px|em|rem)?\s+(?:solid|dashed|dotted|double)\s+(?:#[a-f\d]{3,8}|[a-z]+|var\(--wp--[a-z\d-]+\)))$/i;
const allowedStyles: Record<string, RegExp[]> = {
  "--separator": [/^"[^"\\\u0000-\u001f]{0,40}"$/u],
  border: [border],
  "border-top": [border],
  "border-right": [border],
  "border-bottom": [border],
  "border-left": [border],
  color: [color],
  background: [color, gradient],
  "background-image": [gradient,backgroundImagePattern],
  "background-size": [backgroundSizePattern],
  "background-position": [backgroundPositionPattern],
  "background-repeat": [backgroundRepeatPattern],
  "background-attachment": [backgroundAttachmentPattern],
  "box-shadow": [shadow],
  "text-shadow": [shadow],
  "object-position": [
    length,
    /^(?:left|right|top|bottom|center)(?:\s+(?:left|right|top|bottom|center))?$/,
  ],
  "background-color": [color],
  "border-color": [color],
  "font-size": [length],
  "font-weight": [/^(?:normal|bold|bolder|lighter|[1-9]00)$/],
  "font-style": [/^(?:normal|italic|oblique)$/],
  "font-family": [/^(?!.*(?:url\s*\(|expression\s*\())(?:[\p{L}\p{N} ._'",()-]){1,500}$/iu],
  "text-align": [/^(?:left|center|right|justify|start|end)$/],
  "text-decoration": [
    /^(?:none|underline|line-through|overline)(?:\s+(?:solid|dotted|dashed|double|wavy))?$/,
  ],
  "text-transform": [/^(?:none|uppercase|lowercase|capitalize)$/],
  "line-height": [length],
  "letter-spacing": [length],
  "word-spacing": [length],
  margin: [length],
  "margin-top": [length],
  "margin-right": [length],
  "margin-bottom": [length],
  "margin-left": [length],
  padding: [length],
  "padding-top": [length],
  "padding-right": [length],
  "padding-bottom": [length],
  "padding-left": [length],
  width: [length],
  height: [length],
  "min-width": [length],
  "max-width": [length],
  "min-height": [length],
  "max-height": [length],
  "border-width": [length],
  "border-radius": [length],
  "border-style": [/^(?:none|solid|dashed|dotted|double)$/],
  "border-top-width": [length],
  "border-right-width": [length],
  "border-bottom-width": [length],
  "border-left-width": [length],
  "border-top-color": [color],
  "border-right-color": [color],
  "border-bottom-color": [color],
  "border-left-color": [color],
  display: [/^(?:block|inline|inline-block|flex|inline-flex|grid|none)$/],
  "flex-direction": [/^(?:row|column|row-reverse|column-reverse)$/],
  "justify-content": [
    /^(?:start|end|center|space-between|space-around|space-evenly|flex-start|flex-end)$/,
  ],
  "align-items": [
    /^(?:start|end|center|stretch|baseline|flex-start|flex-end)$/,
  ],
  "flex-wrap": [/^(?:nowrap|wrap|wrap-reverse)$/],
  gap: [length],
  "row-gap": [length],
  "column-gap": [length],
  "flex-basis": [length],
  "flex-grow": [/^\d+(?:\.\d+)?$/],
  "flex-shrink": [/^\d+(?:\.\d+)?$/],
  "grid-column": [/^span (?:[1-9]|1[0-2])$/],
  "grid-row": [/^span (?:[1-9]|1[0-2])$/],
  "grid-template-columns": [gridTemplateColumnsPattern],
  "object-fit": [/^(?:cover|contain|fill|none|scale-down)$/],
  "aspect-ratio": [/^\d+(?:\.\d+)?(?:\s*\/\s*\d+(?:\.\d+)?)?$/],
};
export function cleanContent(content: string, generatedBlocks = false, canonicalInteractive = false) {
  const interactive = generatedBlocks || canonicalInteractive;
  return sanitizeHtml(content, {
    allowedTags: [
      "header",
      "footer",
      "main",
      "article",
      "section",
      "nav",
      "aside",
      "p",
      "br",
      "h1",
      "h2",
      "h3",
      "h4",
      "h5",
      "h6",
      "ul",
      "ol",
      "li",
      "blockquote",
      "figure",
      "figcaption",
      "img",
      "a",
      "strong",
      "em",
      "b",
      "i",
      "u",
      "s",
      "del",
      "ins",
      "code",
      "pre",
      "hr",
      "div",
      "span",
      "table",
      "caption",
      "thead",
      "tbody",
      "tfoot",
      "tr",
      "th",
      "td",
      "details",
      "summary",
      "video",
      "audio",
      "source",
      "mark",
      "sub",
      "sup",
      "kbd",
      "cite",
      "abbr",
      "time",
      ...(canonicalInteractive && !generatedBlocks ? ["button"] : []),
      ...(generatedBlocks ? ["form", "input", "label", "button", "textarea", "select", "option", "svg", "path", "circle", "rect", "g"] : []),
    ],
    allowedAttributes: {
      "*": ["class", "id", "style", "aria-label", "aria-hidden", "role", ...(interactive ? ["aria-expanded", "aria-controls", "aria-labelledby", "aria-selected", "tabindex", "hidden"] : []), ...(generatedBlocks ? ["data-*", "aria-*"] : [])],
      a: ["href", "title", "target", "rel", "download"],
      img: [
        "src",
        "srcset",
        "sizes",
        "alt",
        "title",
        "width",
        "height",
        "loading",
        "decoding",
        "fetchpriority",
      ],
      video: [
        "src",
        "poster",
        "controls",
        "autoplay",
        "muted",
        "loop",
        "playsinline",
        "preload",
        "width",
        "height",
      ],
      audio: ["src", "controls", "autoplay", "muted", "loop", "preload"],
      source: ["src", "type", "media", "srcset", "sizes"],
      details: ["open"],
      ol: ["start", "reversed", "type"],
      li: ["value"],
      td: ["colspan", "rowspan", "headers"],
      th: ["colspan", "rowspan", "scope"],
      abbr: ["title"],
      blockquote: ["cite"],
      time: ["datetime"],
      sup: ["data-fn"],
      ...(canonicalInteractive && !generatedBlocks ? { button: ["type"] } : {}),
      ...(generatedBlocks ? {
        form: ["action", "method", "autocomplete"],
        input: ["type", "name", "value", "placeholder", "required", "checked", "disabled", "maxlength", "minlength", "autocomplete"],
        label: ["for"], button: ["type", "name", "value", "disabled"],
        textarea: ["name", "rows", "cols", "required", "placeholder", "maxlength"],
        select: ["name", "required"], option: ["value", "selected"],
        svg: ["width", "height", "viewbox", "version", "xmlns", "focusable", "fill"],
        path: ["d", "fill", "fill-rule", "clip-rule"], circle: ["cx", "cy", "r", "fill"],
        rect: ["x", "y", "width", "height", "rx", "fill"], g: ["fill"],
      } : {}),
    },
    allowedStyles: { "*": allowedStyles },
    allowedSchemes: ["http", "https", "mailto", "tel"],
    allowedSchemesByTag: {
      img: ["http", "https"],
      video: ["http", "https"],
      audio: ["http", "https"],
      source: ["http", "https"],
    },
    allowProtocolRelative: false,
    transformTags: {
      sup: (_tag: string, attrs: Record<string, string>) => {
        const { "data-fn": id, ...safe } = attrs;
        return { tagName: "sup", attribs: { ...safe, ...(id && /^[a-z0-9_-]{1,100}$/.test(id) ? { "data-fn": id } : {}) } };
      },
      ...(interactive ? { "*": (tag: string, original: Record<string,string>) => {
        const attrs = { ...original };
        if ("tabindex" in attrs && !["0", "-1"].includes(attrs.tabindex)) delete attrs.tabindex;
        if ("hidden" in attrs && attrs.hidden !== "until-found") delete attrs.hidden;
        for (const key of ["aria-expanded", "aria-selected"]) if (key in attrs && !["true", "false"].includes(attrs[key])) delete attrs[key];
        for (const key of ["aria-controls", "aria-labelledby"]) if (key in attrs && !/^[A-Za-z0-9_-]{1,160}(?: [A-Za-z0-9_-]{1,160}){0,9}$/.test(attrs[key])) delete attrs[key];
        if (tag === "button" && canonicalInteractive && !generatedBlocks) attrs.type = "button";
        return { tagName: tag, attribs: attrs };
      }} : {}),
      ...(generatedBlocks ? { form: (_tag: string, attrs: Record<string,string>) => ({
        tagName: "form", attribs: { ...attrs, action: ["/", "/wp-comments-post.php", "/login", "/logout", "/post-password", "/public-login"].includes(attrs.action) ? attrs.action : "/", method: attrs.method?.toLowerCase() === "post" ? "post" : "get" },
      }) } : {}),
      img: (_tag, attrs) => {
        const next = { ...attrs }; if (next.fetchpriority && !["low", "high", "auto"].includes(next.fetchpriority)) delete next.fetchpriority;
        return { tagName: "img", attribs: next };
      },
      a: (_tag, attrs) => ({
        tagName: "a",
        attribs: { ...attrs, rel: "noopener noreferrer" },
      }),
    },
  });
}
export function plainText(value: string) {
  return sanitizeHtml(value, {
    allowedTags: [],
    allowedAttributes: {},
  }).replace(
    /&(amp|lt|gt|quot|#39);/g,
    (_match, entity: string) =>
      ({ amp: "&", lt: "<", gt: ">", quot: '"', "#39": "'" })[entity]!,
  );
}
export function slugify(value: string) {
  return (
    value
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9\u00a1-\uffff]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 180) || "untitled"
  );
}
export interface StoredBlock {
  name: string;
  attributes: Record<string, unknown>;
  innerBlocks: StoredBlock[];
}
export function cleanBlocks(input: unknown): StoredBlock[] {
  let count = 0;
  let valueCount = 0;
  if (!Array.isArray(input))
    throw new HttpError(400, "Blocks must be an array.");
  if (JSON.stringify(input).length > 1_000_000)
    throw new HttpError(400, "Block content is too large.");
  function attributes(value: unknown, depth: number, key = ""): unknown {
    if (++valueCount > 25_000 || depth > 25)
      throw new HttpError(400, "Block attributes are too complex.");
    if (
      value === null ||
      typeof value === "boolean" ||
      (typeof value === "number" && Number.isFinite(value))
    )
      return value;
    if (typeof value === "string") {
      if (value.length > 1_000_000)
        throw new HttpError(400, "Block attribute is too large.");
      if (
        /(?:^|_)(?:url|href|src|poster|srcset)$/i.test(key) ||
        /(?:Url|URL|Href|Src)$/.test(key)
      ) {
        const url = value.trim().replace(/[\u0000-\u0020\u007f]+/g, "");
        if (
          /^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(url) &&
          !/^(?:https?:|mailto:|tel:)/i.test(url)
        )
          throw new HttpError(
            400,
            "Block URLs must use a safe HTTP, HTTPS, mailto, or tel URL.",
          );
      }
      return value.includes("<") ? cleanContent(value) : value;
    }
    if (Array.isArray(value))
      return value.map((item) => attributes(item, depth + 1, key));
    if (typeof value === "object") {
      const result: Record<string, unknown> = {};
      for (const [childKey, childValue] of Object.entries(
        value as Record<string, unknown>,
      )) {
        if (
          ["__proto__", "prototype", "constructor"].includes(childKey) ||
          /^on[a-z]/i.test(childKey)
        )
          continue;
        result[childKey] = attributes(childValue, depth + 1, childKey);
      }
      return result;
    }
    throw new HttpError(400, "Invalid block attribute.");
  }
  function walk(blocks: unknown[], depth: number): StoredBlock[] {
    if (depth > 20)
      throw new HttpError(400, "Blocks may be nested at most 20 levels deep.");
    return blocks.map((item) => {
      if (
        ++count > 2000 ||
        !item ||
        typeof item !== "object" ||
        Array.isArray(item)
      )
        throw new HttpError(400, "Invalid block content.");
      const block = item as Record<string, unknown>;
      if (
        typeof block.name !== "string" ||
        !/^[a-z\d-]+\/[a-z\d-]+$/i.test(block.name)
      )
        throw new HttpError(400, "Invalid block name.");
      if (
        block.attributes !== undefined &&
        (!block.attributes ||
          typeof block.attributes !== "object" ||
          Array.isArray(block.attributes))
      )
        throw new HttpError(400, "Block attributes must be an object.");
      if (block.innerBlocks !== undefined && !Array.isArray(block.innerBlocks))
        throw new HttpError(400, "Inner blocks must be an array.");
      return {
        name: block.name,
        attributes: attributes(block.attributes ?? {}, 0) as Record<
          string,
          unknown
        >,
        innerBlocks: walk((block.innerBlocks ?? []) as unknown[], depth + 1),
      };
    });
  }
  return walk(input, 0);
}

// Retain canonical Gutenberg delimiters and the three source content separators.
// Public HTML is always cleanContent(raw), so arbitrary comments never survive.
export function cleanRawContent(content: string) {
  const nonce = `WORLDActBLOCK${Math.random().toString(36).slice(2)}X`;
  const comments: string[] = [];
  const stack: string[] = [];
  const withBlockMarkers = content.replace(
    /<!--\s*(\/?)wp:([a-z\d_-]+(?:\/[a-z\d_-]+)?)\s*(\{[\s\S]*?\})?\s*(\/?)\s*-->/gi,
    (
      _match,
      closing: string,
      shortName: string,
      encoded: string | undefined,
      selfClosing: string,
    ) => {
      const name = shortName.includes("/") ? shortName : `core/${shortName}`;
      if (comments.length >= 4000)
        throw new HttpError(400, "Too many Gutenberg block markers.");
      let marker: string;
      if (closing) {
        if (encoded || selfClosing || stack.pop() !== name)
          throw new HttpError(400, "Gutenberg block markers must be balanced.");
        marker = `<!-- /wp:${shortName} -->`;
      } else {
        let attrs: unknown = {};
        try {
          if (encoded) attrs = JSON.parse(encoded);
        } catch {
          throw new HttpError(
            400,
            "Gutenberg block attributes must be valid JSON.",
          );
        }
        const block = cleanBlocks([
          { name, attributes: attrs, innerBlocks: [] },
        ])[0];
        const json = Object.keys(block.attributes).length
          ? JSON.stringify(block.attributes)
              .replace(/--/g, "\\u002d\\u002d")
              .replace(/</g, "\\u003c")
              .replace(/>/g, "\\u003e")
              .replace(/&/g, "\\u0026")
          : "";
        marker = selfClosing
          ? `<!-- wp:${shortName}${json ? " " + json : ""} /-->`
          : `<!-- wp:${shortName}${json ? " " + json : ""} -->`;
        if (!selfClosing) {
          stack.push(name);
          if (stack.length > 20)
            throw new HttpError(
              400,
              "Blocks may be nested at most 20 levels deep.",
            );
        }
      }
      const index = comments.push(marker) - 1;
      return `${nonce}${index}END`;
    },
  );
  if (stack.length)
    throw new HttpError(400, "Gutenberg block markers must be balanced.");
  const replaced = withBlockMarkers.replace(LEGACY_CONTENT_MARKER, value => {
    const marker = canonicalLegacyMarker(value);
    if (!marker) return "";
    if (comments.length >= 4000) throw new HttpError(400, "Too many content markers.");
    const index = comments.push(marker) - 1;
    return `${nonce}${index}END`;
  });
  const safe = cleanContent(replaced, false, true);
  // Markers can be restored only in text, never inside an HTML attribute.
  let inTag = false,
    quote = "",
    output = "";
  for (let i = 0; i < safe.length; i++) {
    const c = safe[i];
    if (!inTag && safe.startsWith(nonce, i)) {
      const match = /^(\d+)END/.exec(safe.slice(i + nonce.length));
      if (match && comments[Number(match[1])]) {
        output += comments[Number(match[1])];
        i += nonce.length + match[0].length - 1;
        continue;
      }
    }
    output += c;
    if (inTag) {
      if (quote) {
        if (c === quote) quote = "";
      } else if (c === '"' || c === "'") quote = c;
      else if (c === ">") inTag = false;
    } else if (c === "<") inTag = true;
  }
  return output;
}
