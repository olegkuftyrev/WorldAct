import sanitizeHTML from "sanitize-html";
import type { Context, Node, State, RenderDocument } from "./block-renderer.js";
import { reserveInteractiveId } from "./interactive-blocks.js";
import { cleanContent, plainText } from "./utils.js";

export const NAVIGATION_OVERLAY_BLOCKS = ["core/navigation-overlay-close"];
export type NavigationOverlayContext = { id: string; closeCount: number };
type Attributes = (extra?: string) => string;
type RenderDocumentContent = (document: RenderDocument, context: Context) => Promise<string>;
const escape = (value: unknown) => String(value ?? "").replace(/[&<>"']/g, character => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]!);
const closeIcon = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="24" height="24" aria-hidden="true" focusable="false"><path d="M13 11.8l6.1-6.3-1.1-1-6.1 6.2-6.1-6.2-1.1 1 6.1 6.3-6.5 6.7 1.1 1 6.5-6.6 6.5 6.6 1.1-1z"></path></svg>';
const defaultCloseIcon = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="24" height="24" aria-hidden="true" focusable="false"><path d="m13.06 12 6.47-6.47-1.06-1.06L12 10.94 5.53 4.47 4.47 5.53 10.94 12l-6.47 6.47 1.06 1.06L12 13.06l6.47 6.47 1.06-1.06L13.06 12Z"></path></svg>';
const openIcon = (menu: boolean) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="24" height="24" aria-hidden="true" focusable="false">${menu ? '<path d="M5 5v1.5h14V5H5zM5 12.8h14v-1.5H5v1.5zM5 19h14v-1.5H5V19z"></path>' : '<path d="M4 7.5h16v1.5H4zM4 15h16v1.5H4z"></path>'}</svg>`;

/** Source overlay IDs select an active-theme template part, irrespective of its picker area. */
export function navigationOverlayReference(value: unknown, activeTheme: string): { theme: string; slug: string } | null {
  if (typeof value !== "string") return null;
  const match = /^(?:([a-z0-9_-]{1,40})\/\/)?([a-z0-9_-]{1,160})$/i.exec(value);
  if (!match || (match[1] && match[1] !== activeTheme)) return null;
  return { theme: activeTheme, slug: match[2] };
}

export function renderNavigationOverlayClose(node: Node, context: Context, attributes: Attributes): string | undefined {
  if (node.name !== "core/navigation-overlay-close") return undefined;
  const mode = ["text", "both"].includes(node.attrs.displayMode) ? node.attrs.displayMode : "icon";
  const sanitizedText = sanitizeHTML(cleanContent(typeof node.attrs.text === "string" && node.attrs.text ? node.attrs.text : "Close"), {
    // The native RichText field offers bold and italic only. Never place links,
    // forms or arbitrary controls inside the generated button.
    allowedTags: ["strong", "em", "b", "i", "br"], allowedAttributes: {},
  });
  const text = plainText(sanitizedText).trim() ? sanitizedText : "Close";
  const overlay = context.navigationOverlay;
  if (overlay) overlay.closeCount++;
  return `<button${attributes()} type="button"${mode === "icon" ? ' aria-label="Close"' : ""}${overlay ? ` data-worldact-navigation-close="${escape(overlay.id)}"` : ""}>${mode === "text" ? "" : closeIcon}${mode === "icon" ? "" : `<span class="wp-block-navigation-overlay-close__text">${text}</span>`}</button>`;
}

function lowerImagePriority(html: string) {
  if (!/<img\b/i.test(html)) return html;
  return sanitizeHTML(html, {
    allowedTags: false, allowedAttributes: false, allowVulnerableTags: true,
    transformTags: { img: (_tag, attrs) => ({ tagName: "img", attribs: { ...attrs, fetchpriority: "low" } }) },
  });
}
function overlayColors(node: Node) {
  const a = node.attrs, classes: string[] = [], styles: string[] = [];
  for (const [field, property, suffix] of [["Text", "color", "color"], ["Background", "background-color", "background-color"]] as const) {
    const preset = a[`overlay${field}Color`], custom = a[`customOverlay${field}Color`];
    if (typeof preset === "string" && /^[a-z0-9_-]{1,100}$/i.test(preset)) classes.push(`has-${preset}-${suffix}`);
    else if (typeof custom === "string") styles.push(`${property}:${custom}`);
  }
  // All declarations pass through the shared CSS validator at the render boundary.
  return { classes, styles };
}

export async function renderNavigationWithOverlay(
  node: Node, context: Context, state: State, items: string, attributes: Attributes, renderDocument: RenderDocumentContent, renderItems: () => Promise<string>,
): Promise<string> {
  // This flag is trusted traversal state, never the saved source-private attr.
  if (context.navigationOverlay) return `<div${attributes("worldact-overlay-never")}><ul class="wp-block-navigation__container">${items}</ul></div>`;
  const mode = ["always", "never"].includes(node.attrs.overlayMenu) ? node.attrs.overlayMenu : "mobile";
  const label = plainText(String(node.attrs.ariaLabel || "Navigation"));
  const desktop = mode === "always" ? "" : `<ul class="wp-block-navigation__container worldact-navigation-desktop">${items}</ul>`;
  if (mode === "never") return `<nav${attributes("worldact-overlay-never")} aria-label="${escape(label)}">${desktop}</nav>`;
  const panelId = reserveInteractiveId(state, "", "navigation"), overlay: NavigationOverlayContext = { id: panelId, closeCount: 0 };
  const reference = navigationOverlayReference(node.attrs.overlay, state.settings.theme);
  let custom = "";
  if (reference) {
    const key = `part:${reference.theme}:${reference.slug}`;
    if (!context.refs.has(key)) {
      if (!state.cache.has(key)) state.cache.set(key, state.db.query('SELECT content,raw_content AS "rawContent",blocks FROM site_documents WHERE slug=$1 AND theme=$2 AND type=\'template-part\' LIMIT 1', [reference.slug, reference.theme]).then(result => result.rows[0]));
      const document = await state.cache.get(key);
      if (document) custom = await renderDocument(document, { ...context, navigationOverlay: overlay, refs: new Set([...context.refs, key]) });
    }
  }
  const hasCustom = !!custom.trim(), showIcon = node.attrs.hasIcon !== false;
  const fallbackClose = hasCustom && overlay.closeCount ? "" : `<button type="button" class="wp-block-navigation__responsive-container-close" data-worldact-navigation-close="${escape(panelId)}"${showIcon ? ' aria-label="Close menu"' : ""}>${showIcon ? defaultCloseIcon : "Close"}</button>`;
  // Desktop and mobile fallbacks are distinct DOM instances. Render controls
  // afresh so Search/interactive IDs remain local; entity and query reads still
  // share the same cache, traversal state and cumulative resource budgets.
  const mobileItems = !hasCustom && mode === "mobile" ? await renderItems() : items;
  const content = hasCustom ? `<div class="wp-block-navigation__overlay-container" style="display:block">${lowerImagePriority(custom)}</div>` : `<ul class="wp-block-navigation__container">${mobileItems}</ul>`;
  const colors = hasCustom ? { classes: [], styles: [] } : overlayColors(node);
  const panelClasses = ["wp-block-navigation__responsive-container",mode === "always" ? "hidden-by-default" : "",hasCustom ? "disable-default-overlay" : "",...colors.classes].filter(Boolean).join(" ");
  const panelStyle = ["display:block",...colors.styles].join(";");
  return `<nav${attributes("worldact-overlay-" + mode)} aria-label="${escape(label)}" data-worldact-interactive="navigation" data-worldact-overlay-mode="${mode}">${desktop}<details class="worldact-navigation-toggle" data-worldact-navigation-toggle><summary class="wp-block-navigation__responsive-container-open${mode === "always" ? " always-shown" : ""}" data-worldact-navigation-open aria-haspopup="dialog" aria-controls="${escape(panelId)}" aria-label="Open menu">${showIcon ? openIcon(node.attrs.icon === "menu") : "Menu"}</summary><div class="${escape(panelClasses)}" style="${escape(panelStyle)}" id="${escape(panelId)}" data-worldact-navigation-panel tabindex="-1"><div class="wp-block-navigation__responsive-close" tabindex="-1"><div class="wp-block-navigation__responsive-dialog" data-worldact-navigation-dialog aria-label="Menu">${fallbackClose}<div class="wp-block-navigation__responsive-container-content">${content}</div></div></div></div></details></nav>`;
}
