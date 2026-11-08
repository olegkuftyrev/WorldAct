import { createHash } from "node:crypto";
import { DOMParser } from "linkedom";
import sanitizeHTML from "sanitize-html";
import type { Context, Node, State, RenderDocument, RenderOptions } from "./block-renderer.js";
import { cleanContent, plainText } from "./utils.js";

export const INTERACTIVE_BLOCKS = [
  "core/accordion", "core/accordion-item", "core/accordion-heading", "core/accordion-panel",
  "core/tabs", "core/tab-list", "core/tab-panels", "core/tab-panel",
];
export type InteractiveRenderState = { prefix: string; sequence: number; ids: Set<string> };
export type AccordionContext = { iconPosition: "left" | "right"; showIcon: boolean; headingLevel: number };
export type AccordionItemContext = { toggleId: string; panelId: string; open: boolean; heading: Node; panel: Node };
export type TabsContext = { id: string; activeIndex: number; list?: Node; panels: Array<{ node: Node; id: string; label: string }> };
type Attributes = (extra?: string, override?: Record<string, any>) => string;
const escape = (value: unknown) => String(value ?? "").replace(/[&<>"']/g, character => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]!);
const level = (value: unknown, fallback = 3) => Number.isInteger(value) && Number(value) >= 1 && Number(value) <= 6 ? Number(value) : fallback;
const safeAnchor = (value: unknown) => typeof value === "string" && /^[A-Za-z0-9_-]{1,100}$/.test(value) ? value : "";
const documentFor = (html: string) => new DOMParser().parseFromString("<!doctype html><html><body>" + html + "</body></html>", "text/html");
const sourceDocuments = new WeakMap<Node, ReturnType<typeof documentFor>>();
function source(node: Node) {
  if (!sourceDocuments.has(node)) sourceDocuments.set(node, documentFor(cleanContent(node.html || "", false, true)));
  return sourceDocuments.get(node)!;
}
function inline(value: unknown): string {
  return sanitizeHTML(cleanContent(typeof value === "string" ? value : ""), {
    allowedTags: ["strong", "em", "b", "i", "u", "s", "del", "ins", "span", "code", "mark", "sub", "sup", "br"],
    allowedAttributes: { "*": ["class", "style"] },
  });
}
export function createInteractiveRenderState(document: RenderDocument, options: RenderOptions, theme: string): InteractiveRenderState {
  const documentIdentity = document.id !== undefined || document.slug
    ? [document.theme || theme, document.type || "document", document.id ?? "", document.slug || ""]
    : options.post?.id !== undefined ? [theme, options.post.type || "post", options.post.id] : null;
  const identity = documentIdentity || ["anonymous", createHash("sha256").update(document.rawContent || document.raw_content || document.content || JSON.stringify(document.blocks || [])).digest("hex")];
  const prefix = "wa-" + createHash("sha256").update(JSON.stringify([identity, options.instanceKey || ""])).digest("hex").slice(0, 16);
  return { prefix, sequence: 0, ids: new Set() };
}
function interactiveState(state: State): InteractiveRenderState {
  return state.interactive ||= createInteractiveRenderState({}, state.options, state.settings.theme);
}
function reserve(state: State, desired: string, kind: string): string {
  const ids = interactiveState(state);
  let id = desired || `${ids.prefix}-${kind}-${++ids.sequence}`;
  while (ids.ids.has(id) || ids.ids.has("tab__" + id) || ids.ids.has(id + "-panel")) id = `${ids.prefix}-${kind}-${++ids.sequence}`;
  ids.ids.add(id); return id;
}
export const reserveInteractiveId = reserve;
function supplementalStyle(attrs: Record<string, any>) {
  const style = attrs.style || {}, pairs: string[] = [];
  const preset = (value: string) => /^var:preset\|[a-z0-9-]+\|[a-z0-9-]+$/i.test(value) ? "var(--wp--preset--" + value.slice(11).replace(/\|/g, "--") + ")" : value;
  for (const [property, value] of [["background", style.color?.gradient], ["box-shadow", style.shadow], ["min-width", style.dimensions?.minWidth]] as const)
    if (typeof value === "string") pairs.push(property + ":" + preset(value));
  // These declarations still pass through the shared CSS allowlist on output.
  return pairs.join(";");
}
// Only class/style come from the saved wrapper. Runtime state and ARIA links
// are derived afresh; saved directives, hidden values and handlers are ignored.
function wrapper(node: Node, attributes: Attributes, extra = "", override = node.attrs, id?: string) {
  const computed = documentFor("<div" + attributes(extra, override) + "></div>").body.firstElementChild!;
  const saved = source(node).body.firstElementChild;
  const transient = node.name === "core/accordion-item" ? ["is-open"] : node.name === "core/accordion-heading" ? ["has-icon", "has-icon-left", "has-icon-right"] : [];
  const savedClasses = (saved?.getAttribute("class") || "").split(/\s+/).filter(value => !transient.includes(value)).join(" ");
  const classes = [...new Set((savedClasses + " " + (computed.getAttribute("class") || "")).trim().split(/\s+/).filter(Boolean))].join(" ");
  const styles = [saved?.getAttribute("style"), supplementalStyle(override), computed.getAttribute("style")].filter(Boolean).join(";");
  const anchor = id ?? safeAnchor(node.attrs.anchor);
  const label = typeof node.attrs.ariaLabel === "string" ? plainText(node.attrs.ariaLabel) : saved?.getAttribute("aria-label") || "";
  return `${classes ? ` class="${escape(classes)}"` : ""}${anchor ? ` id="${escape(anchor)}"` : ""}${styles ? ` style="${escape(styles)}"` : ""}${label ? ` aria-label="${escape(label)}"` : ""}`;
}
function styleAttribute(saved: string | null | undefined, computed = "") {
  const style = [saved, computed].filter(Boolean).join(";");
  return style ? ` style="${escape(style)}"` : "";
}
function lowerImagePriority(html: string) {
  if (!/<img\b/i.test(html)) return html;
  return sanitizeHTML(html, {
    allowedTags: false, allowedAttributes: false, allowVulnerableTags: true,
    transformTags: { img: (_tag, attrs) => ({ tagName: "img", attribs: { ...attrs, fetchpriority: "low" } }) },
  });
}
function headingParts(attrs: Record<string, any>) {
  const style = attrs.style || {}, typography = style.typography || {}, spacing = style.spacing || {};
  const { padding, ...wrapperSpacing } = spacing, { letterSpacing, textDecoration, ...wrapperTypography } = typography;
  return {
    wrapper: { ...attrs, style: { ...style, spacing: wrapperSpacing, typography: wrapperTypography } },
    button: { style: { spacing: { padding } } },
    title: { style: { typography: { letterSpacing, textDecoration } } },
  };
}
function tabButtonParts(attrs: Record<string, any>) {
  const { backgroundColor, textColor, gradient, ...rest } = attrs;
  const style = attrs.style || {}, { padding, ...wrapperSpacing } = style.spacing || {};
  const { color, border, shadow, background, ...wrapperStyle } = style;
  return {
    wrapper: { ...rest, layout: attrs.layout || { type: "flex", flexWrap: "wrap" }, style: { ...wrapperStyle, spacing: wrapperSpacing } },
    button: { style: { color, border, shadow, background, spacing: { padding } } },
    classes: [backgroundColor && safeAnchor(backgroundColor) ? `has-${backgroundColor}-background-color has-background` : "", textColor && safeAnchor(textColor) ? `has-${textColor}-color has-text-color` : "", gradient && safeAnchor(gradient) ? `has-${gradient}-gradient-background has-background` : ""].filter(Boolean).join(" "),
  };
}

export async function renderInteractiveBlock(
  node: Node, context: Context, state: State,
  children: (nodes: Node[], context: Context) => Promise<string>,
  attributes: Attributes, styleFor: (attributes: Record<string, any>) => string,
): Promise<string | undefined> {
  const name = node.name, a = node.attrs;
  if (name === "core/accordion") {
    const config: AccordionContext = { iconPosition: a.iconPosition === "left" ? "left" : "right", showIcon: a.showIcon !== false, headingLevel: level(a.headingLevel) };
    const id = reserve(state, safeAnchor(a.anchor), "accordion");
    return `<div${wrapper(node, attributes, "", a, id)} role="group" data-worldact-interactive="accordion" data-worldact-autoclose="${a.autoclose === true}">${await children(node.children, { ...context, accordion: config, accordionItem: undefined })}</div>`;
  }
  if (name === "core/accordion-item") {
    const heading = node.children.find(child => child.name === "core/accordion-heading"), panel = node.children.find(child => child.name === "core/accordion-panel");
    const id = reserve(state, "", "accordion-item"), open = a.openByDefault === true;
    interactiveState(state).ids.add(id + "-panel");
    const item = heading && panel ? { toggleId: id, panelId: id + "-panel", open, heading, panel } : undefined;
    const content = await children(node.children, { ...context, accordionItem: item });
    return `<div${wrapper(node, attributes, open ? "is-open" : "")}${item ? ` data-worldact-accordion-item="${id}" data-worldact-open="${open}"` : ""}>${open ? content : lowerImagePriority(content)}</div>`;
  }
  if (name === "core/accordion-heading") {
    const root = source(node).body.firstElementChild, savedButton = source(node).querySelector(".wp-block-accordion-heading__toggle"), savedTitle = source(node).querySelector(".wp-block-accordion-heading__toggle-title");
    const number = level(a.level, level(root?.tagName?.match(/^H([1-6])$/)?.[1] ? Number(root!.tagName.slice(1)) : undefined, context.accordion?.headingLevel || 3));
    const config = context.accordion || { iconPosition: a.iconPosition === "left" ? "left" : "right", showIcon: a.showIcon !== false }, parts = headingParts(a);
    const title = inline(a.title ?? savedTitle?.innerHTML ?? ""), icon = '<span class="wp-block-accordion-heading__toggle-icon" aria-hidden="true">+</span>';
    const extra = config.showIcon ? `has-icon has-icon-${config.iconPosition}` : "";
    if (!context.accordionItem || context.accordionItem.heading !== node) return `<h${number}${wrapper(node, attributes, extra, parts.wrapper)}>${title}</h${number}>`;
    const item = context.accordionItem;
    return `<h${number}${wrapper(node, attributes, extra, parts.wrapper)}><button type="button" class="wp-block-accordion-heading__toggle" id="${item.toggleId}" aria-controls="${item.panelId}" aria-expanded="${item.open}"${styleAttribute(savedButton?.getAttribute("style"), [supplementalStyle(parts.button), styleFor(parts.button)].filter(Boolean).join(";"))}>${config.showIcon && config.iconPosition === "left" ? icon : ""}<span class="wp-block-accordion-heading__toggle-title"${styleAttribute(savedTitle?.getAttribute("style"), styleFor(parts.title))}>${title}</span>${config.showIcon && config.iconPosition === "right" ? icon : ""}</button></h${number}>`;
  }
  if (name === "core/accordion-panel") {
    const item = context.accordionItem?.panel === node ? context.accordionItem : undefined;
    // No server hidden attribute: every panel remains readable without script.
    return `<div${wrapper(node, attributes, "", a, item?.panelId)} role="region"${item ? ` aria-labelledby="${item.toggleId}"` : ""}>${await children(node.children, context)}</div>`;
  }
  if (name === "core/tabs") {
    const id = reserve(state, safeAnchor(a.anchor), "tabs"), panelContainer = node.children.find(child => child.name === "core/tab-panels");
    const panels = (panelContainer?.children || []).filter(child => child.name === "core/tab-panel").map((panel, index) => {
      const panelId = reserve(state, safeAnchor(panel.attrs.anchor) || `${id}-tab-${index + 1}`, "tab");
      interactiveState(state).ids.add("tab__" + panelId);
      return { node: panel, id: panelId, label: inline(panel.attrs.label) };
    });
    const requested = Number.isFinite(a.activeTabIndex) ? Math.trunc(a.activeTabIndex) : 0;
    const tabs: TabsContext = { id, list: node.children.find(child => child.name === "core/tab-list"), activeIndex: Math.max(0, Math.min(Math.max(0, panels.length - 1), requested)), panels };
    return `<div${wrapper(node, attributes, "", a, id)} data-worldact-interactive="tabs" data-worldact-active-tab="${tabs.activeIndex}">${await children(node.children, { ...context, tabs })}</div>`;
  }
  if (name === "core/tab-list") {
    const buttons = [...source(node).querySelectorAll("button")], parts = tabButtonParts(a);
    const labels = Array.isArray(a.tabs) ? a.tabs.map((tab: any) => inline(tab?.label)) : buttons.map(button => inline(button.innerHTML));
    const panelList = context.tabs?.list === node ? context.tabs.panels : [], count = Math.max(panelList.length, labels.length);
    const markup = Array.from({ length: count }, (_, index) => {
      const panel = panelList[index], saved = buttons[index], classes = [saved?.getAttribute("class"), parts.classes].filter(Boolean).join(" ");
      const label = labels[index] ?? panel?.label ?? "", active = context.tabs?.activeIndex === index;
      if (!panel) return `<span${classes ? ` class="${escape(classes)}"` : ""}>${label}</span>`;
      return `<button type="button" role="tab" id="tab__${panel.id}" aria-controls="${panel.id}" aria-selected="${active}" tabindex="${active ? 0 : -1}"${classes ? ` class="${escape(classes)}"` : ""}${styleAttribute(saved?.getAttribute("style"), [supplementalStyle(parts.button), styleFor(parts.button)].filter(Boolean).join(";"))}>${label}</button>`;
    }).join("");
    const label = plainText(typeof a.ariaLabel === "string" && a.ariaLabel ? a.ariaLabel : "Tabbed content");
    // wrapper aria-label is replaced here to avoid duplicate attributes.
    const wrapperAttrs = wrapper(node, attributes, "", { ...parts.wrapper, ariaLabel: "" }).replace(/ aria-label="[^"]*"/g, "");
    return `<div${wrapperAttrs}${panelList.length ? ` role="tablist" aria-label="${escape(label)}"` : ""}>${markup}</div>`;
  }
  if (name === "core/tab-panels") return `<div${wrapper(node, attributes)}>${await children(node.children, context)}</div>`;
  if (name === "core/tab-panel") {
    const index = context.tabs?.panels.findIndex(panel => panel.node === node) ?? -1, panel = index >= 0 ? context.tabs!.panels[index] : undefined;
    const active = context.tabs?.activeIndex === index;
    return `<section${wrapper(node, attributes, "", a, panel?.id)}${panel ? ` role="tabpanel" aria-labelledby="tab__${panel.id}" tabindex="${active ? 0 : -1}" data-worldact-tab-panel="${index}"` : ""}>${await children(node.children, context)}</section>`;
  }
  return undefined;
}
