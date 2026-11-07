/** Bind public template tokens through DOM nodes, never through HTML attributes. */
export function renderTemplate(
  template: string,
  values: Record<string, string>,
  parser: Pick<DOMParser, "parseFromString"> = new DOMParser(),
): string {
  const parse = (html: string) =>
    parser.parseFromString(
      `<!doctype html><html><head></head><body>${html}</body></html>`,
      "text/html",
    );
  const document = parse(template);
  const rawSlots = new Set(["content", "navigation", "postList"]);
  const token = /\{\{([a-zA-Z]+)\}\}/g;
  const textValue = (key: string) => values[key] || "";

  function bind(node: Node) {
    if (node.nodeType === 3) {
      const text = node.textContent || "";
      const matches = Array.from(text.matchAll(token));
      if (!matches.length) return;
      const fragment = document.createDocumentFragment();
      let offset = 0;
      for (const match of matches) {
        fragment.appendChild(
          document.createTextNode(text.slice(offset, match.index)),
        );
        const key = match[1];
        if (rawSlots.has(key)) {
          const source = parse(values[key] || "");
          for (const child of Array.from(source.body.childNodes))
            fragment.appendChild(document.importNode(child, true));
        } else fragment.appendChild(document.createTextNode(textValue(key)));
        offset = match.index! + match[0].length;
      }
      fragment.appendChild(document.createTextNode(text.slice(offset)));
      node.parentNode?.replaceChild(fragment, node);
      return;
    }
    if (node.nodeType !== 1) return;
    const element = node as Element;
    for (const attribute of Array.from(element.attributes)) {
      const matches = Array.from(attribute.value.matchAll(token));
      if (!matches.length) continue;
      // HTML slots have no attribute representation. Binding styles, handlers,
      // and srcset also requires a different type of value than a text token.
      if (
        /^on/i.test(attribute.name) ||
        ["style", "srcset"].includes(attribute.name) ||
        matches.some((match) => rawSlots.has(match[1]))
      ) {
        element.removeAttribute(attribute.name);
        continue;
      }
      element.setAttribute(
        attribute.name,
        attribute.value.replace(token, (_match, key: string) => textValue(key)),
      );
    }
    for (const child of Array.from(element.childNodes)) bind(child);
  }
  for (const node of Array.from(document.body.childNodes)) bind(node);

  // Both template and raw slots come from the server's allowlist sanitizer.
  // Enforce structural and URL boundaries again after token binding, since a
  // safe placeholder in an href can otherwise become an unsafe final scheme.
  function guard(element: Element) {
    const tag = element.tagName.toLowerCase();
    if (!allowedTags.has(tag)) {
      element.remove();
      return;
    }
    for (const attribute of Array.from(element.attributes)) {
      const name = attribute.name.toLowerCase();
      if (
        /^on/i.test(name) ||
        name === "srcdoc" ||
        !allowedAttribute(tag, name)
      ) {
        element.removeAttribute(attribute.name);
      } else if (
        ["href", "src", "poster", "cite"].includes(name) &&
        !safeURL(attribute.value, tag === "a" && name === "href")
      ) {
        element.removeAttribute(attribute.name);
      } else if (
        name === "srcset" &&
        !attribute.value
          .split(",")
          .every((part) => safeURL(part.trim().split(/\s+/)[0], false))
      ) {
        element.removeAttribute(attribute.name);
      }
    }
    if (tag === "a") element.setAttribute("rel", "noopener noreferrer");
    for (const child of Array.from(element.children)) guard(child);
  }
  for (const element of Array.from(document.body.children)) guard(element);
  return document.body.innerHTML;
}

function safeURL(value: string, links: boolean) {
  const normalized = value.trim().replace(/[\u0000-\u0020\u007f]+/g, "");
  if (normalized.replace(/\\/g, "/").startsWith("//")) return false;
  if (/^[a-z][a-z\d+.-]*:/i.test(normalized))
    return (links ? /^(?:https?:|mailto:|tel:)/i : /^https?:/i).test(
      normalized,
    );
  return true;
}
const allowedTags = new Set(
  "header footer main article section nav aside p br h1 h2 h3 h4 h5 h6 ul ol li blockquote figure figcaption img a strong em b i u s del ins code pre hr div span table caption thead tbody tfoot tr th td details summary time video audio source mark sub sup kbd cite abbr".split(
    " ",
  ),
);
const globalAttributes = new Set([
  "class",
  "id",
  "style",
  "aria-label",
  "aria-hidden",
  "role",
]);
const tagAttributes: Record<string, Set<string>> = Object.fromEntries(
  Object.entries({
    a: "href title target rel download",
    img: "src srcset sizes alt title width height loading decoding",
    video:
      "src poster controls autoplay muted loop playsinline preload width height",
    audio: "src controls autoplay muted loop preload",
    source: "src type media srcset sizes",
    details: "open",
    time: "datetime",
    ol: "start reversed type",
    li: "value",
    td: "colspan rowspan headers",
    th: "colspan rowspan scope",
    abbr: "title",
    blockquote: "cite",
  }).map(([tag, attributes]) => [tag, new Set(attributes.split(" "))]),
);
function allowedAttribute(tag: string, attribute: string) {
  return globalAttributes.has(attribute) || tagAttributes[tag]?.has(attribute);
}
