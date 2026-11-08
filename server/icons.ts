import express, { type Response } from "express";
import { DOMParser } from "linkedom";
import { z } from "zod";
import { attachUser, type AuthRequest } from "./auth.js";
import type { Node } from "./block-renderer.js";
import icons from "./icon-source/core-icons.json" with { type: "json" };

export type BundledIcon = { name: string; label: string; content: string; collection: string };
const slug = /^[a-z0-9](?:[a-z0-9_-]*[a-z0-9])?$/;
const namePattern = /^[a-z0-9](?:[a-z0-9_-]*[a-z0-9])?\/[a-z0-9](?:[a-z0-9_-]*[a-z0-9])?$/;
const escape = (value: unknown) => String(value ?? "").replace(/[&<>"']/g, character => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]!);

/** Fail closed if the checked-in, fixed manifest ever gains active SVG content. */
export function auditBundledIcon(icon: BundledIcon): void {
  if (!namePattern.test(icon.name) || !icon.name.startsWith("core/") || icon.collection !== "core" || !icon.label || icon.label.length > 200 || icon.content.length > 8192 || /<!|<\?|&/.test(icon.content)) throw new Error("Invalid bundled icon manifest.");
  const document = new DOMParser().parseFromString(icon.content, "image/svg+xml");
  const root = document.documentElement;
  if (root?.localName !== "svg" || document.childNodes.length !== 1 || !root.querySelector("path")) throw new Error("Invalid bundled icon root.");
  for (const node of [root, ...root.querySelectorAll("*")]) {
    if (!["svg", "path"].includes(node.localName) || (node !== root && (node.localName !== "path" || node.parentElement !== root))) throw new Error("Unsupported bundled SVG element.");
    for (const attribute of [...node.attributes]) {
      const valid = node === root
        ? (attribute.name === "xmlns" && attribute.value === "http://www.w3.org/2000/svg") || (attribute.name === "viewBox" && attribute.value === "0 0 24 24") || (attribute.name === "fill" && attribute.value === "currentColor")
        : (attribute.name === "d" && /^[MmLlHhVvCcSsQqTtAaZzEe\d.,+\-\s]+$/.test(attribute.value)) || (["fill-rule", "clip-rule"].includes(attribute.name) && attribute.value === "evenodd") || (attribute.name === "fill" && attribute.value === "currentColor");
      if (!valid) throw new Error("Unsupported bundled SVG attribute.");
    }
    for (const child of [...node.childNodes]) if (child.nodeType !== 1 && (child.nodeType !== 3 || child.textContent?.trim())) throw new Error("Unsupported bundled SVG node.");
  }
}
const registry = new Map<string, Readonly<BundledIcon>>();
for (const icon of icons) { auditBundledIcon(icon); if (registry.has(icon.name)) throw new Error("Duplicate bundled icon."); registry.set(icon.name, Object.freeze({ ...icon })); }
export const bundledIcons = Object.freeze([...registry.values()]);
export const coreIconCollection = Object.freeze({ slug: "core", label: "WordPress", description: "Default icon collection." });
export const getBundledIcon = (name: unknown) => typeof name === "string" ? registry.get(name) : undefined;

/** Source icon.php applies styles to SVG; only margin/alignment belongs to its wrapper. */
export function renderIconBlock(node: Node, attributes: (extra?: string, override?: Record<string, any>) => string, blockStyle: (attrs: Record<string, any>) => string): string | undefined {
  if (node.name !== "core/icon") return undefined;
  const a = node.attrs, icon = getBundledIcon(a.icon);
  if (!icon) return "";
  const style = a.style || {}, border = style.border || {}, colors = style.color || {};
  const preset = (value: unknown) => typeof value === "string" && /^[a-zA-Z0-9_-]{1,100}$/.test(value) ? value : null;
  const text = preset(a.textColor), background = preset(a.backgroundColor), borderColor = preset(a.borderColor);
  const svgStyle = { color: { text: text ? `var:preset|color|${text}` : colors.text, background: background ? `var:preset|color|${background}` : colors.background }, border: { color: borderColor ? `var:preset|color|${borderColor}` : border.color, radius: typeof border.radius === "object" ? undefined : border.radius, style: border.style, width: border.width }, spacing: { padding: style.spacing?.padding } };
  const pairs = [blockStyle({ style: svgStyle })];
  const cssValue = (value: unknown) => typeof value === "string" && value.startsWith("var:preset|") ? `var(--wp--preset--${value.slice(11).replace(/\|/g, "--")})` : value;
  const push = (key: string, value: unknown) => { const converted = cssValue(value); if (typeof converted === "string" || typeof converted === "number") pairs.push(`${key}:${converted}`); };
  // Shared blockStyle handles scalar borders. The source also supports sides
  // and corner radii, without applying unrelated background/shadow controls.
  for (const side of ["top", "right", "bottom", "left"]) for (const key of ["color", "style", "width"]) push(`border-${side}-${key}`, border[side]?.[key]);
  for (const [corner, key] of [["top-left", "topLeft"], ["top-right", "topRight"], ["bottom-left", "bottomLeft"], ["bottom-right", "bottomRight"]]) push(`border-${corner}-radius`, border.radius?.[key]);
  push("width", style.dimensions?.width);
  // The source casts rotation to an integer; a finite bound keeps generated
  // CSS small while preserving all whole turns used by its native toolbar.
  const rotation = typeof a.rotation === "number" && Number.isFinite(a.rotation) ? Math.trunc(Math.max(-360000, Math.min(360000, a.rotation))) : 0;
  if (rotation) pairs.push(`rotate:${rotation}deg`);
  const classes = [text || colors.text ? "has-text-color" : "", text ? `has-${text}-color` : "", background || colors.background ? "has-background" : "", background ? `has-${background}-background-color` : "", borderColor || border.color ? "has-border-color" : "", borderColor ? `has-${borderColor}-border-color` : "", a.flipHorizontal === true ? "is-flip-horizontal" : "", a.flipVertical === true ? "is-flip-vertical" : ""].filter(Boolean).join(" ");
  const label = typeof a.ariaLabel === "string" ? a.ariaLabel.slice(0, 2000) : "";
  const svg = icon.content.replace(/^<svg\b/, `<svg${classes ? ` class="${escape(classes)}"` : ""}${pairs.filter(Boolean).length ? ` style="${escape(pairs.filter(Boolean).join(";"))}"` : ""}${label ? ` role="img" aria-label="${escape(label)}"` : ' aria-hidden="true" focusable="false"'}`);
  const wrapper = { className: a.className, anchor: a.anchor, align: ["left", "center", "right"].includes(a.align) ? a.align : undefined, style: { spacing: { margin: style.spacing?.margin } } };
  return `<div${attributes("", wrapper)}>${svg}</div>`;
}

const fieldSchema = z.union([z.string().max(2000), z.array(z.string().max(100)).max(100)]).optional();
const itemQuery = z.object({ context: z.enum(["view", "edit", "embed"]).default("view"), _fields: fieldSchema });
const collectionQuery = itemQuery.extend({ page: z.coerce.number().int().min(1).optional(), per_page: z.coerce.number().int().min(1).max(100).optional(), search: z.string().max(2000).optional() });
const querySchema = collectionQuery.extend({ collection: z.string().max(120).regex(slug).optional() });
const schema = (collection: boolean) => ({ $schema: "http://json-schema.org/draft-04/schema#", title: collection ? "icon-collection" : "icon", type: "object", properties: Object.fromEntries((collection ? [["slug", "The icon collection slug."], ["label", "The icon collection label."], ["description", "The icon collection description."]] : [["name", "The icon name."], ["label", "The icon label."], ["content", "The icon content (SVG markup)."], ["collection", "The slug of the collection this icon belongs to."]]).map(([key, description]) => [key, { description, type: "string", readonly: true, context: ["view", "edit", "embed"] }])) });
function fail(res: Response, status: number, code: string, message: string) { return res.status(status).json({ code, message, data: { status } }); }
function fields<T extends object>(record: T, query: z.infer<typeof querySchema>) { const requested = query._fields; if (requested === undefined) return record; const wanted = (Array.isArray(requested) ? requested : requested.split(",")).map(value => value.trim()); return Object.fromEntries(Object.entries(record).filter(([key]) => wanted.includes(key))); }
const router = express.Router();
router.use(["/wp-json/wp/v2/icons", "/wp-json/wp/v2/icon-collections"], attachUser);
router.all(["/wp-json/wp/v2/icons{/:collection}{/:name}", "/wp-json/wp/v2/icon-collections{/:slug}"], (req: AuthRequest, res, next) => {
  if (Object.values(req.params).some(value => typeof value === "string" && !slug.test(value))) return next();
  const collectionRoute = req.path.startsWith("/wp-json/wp/v2/icon-collections");
  const item = Boolean(req.params.name || (collectionRoute && req.params.slug));
  if (req.method === "OPTIONS") return res.json({ namespace: "wp/v2", methods: ["GET"], schema: schema(collectionRoute), endpoints: [{ methods: ["GET"], args: { context: { type: "string", enum: ["view", "edit", "embed"], default: "view" }, ...(!item ? { page: { type: "integer", default: 1, minimum: 1 }, per_page: { type: "integer", default: 10, minimum: 1, maximum: 100 }, search: { type: "string" }, ...(!collectionRoute ? { collection: { type: "string", pattern: slug.source } } : {}) } : {}) } }] });
  if (!["GET", "HEAD"].includes(req.method)) return next();
  if (!req.user || !["administrator", "editor", "author", "contributor"].includes(req.user.role)) return fail(res, req.user ? 403 : 401, "rest_cannot_view", collectionRoute ? "Sorry, you are not allowed to view the registered icon collections." : "Sorry, you are not allowed to view the registered icons.");
  const parsed = (item ? itemQuery : collectionRoute ? collectionQuery : querySchema).safeParse(req.query);
  if (!parsed.success) return fail(res, 400, "rest_invalid_param", "Invalid icon query parameter(s).");
  const query = parsed.data as z.infer<typeof querySchema>;
  if (collectionRoute) {
    if (req.params.slug && req.params.slug !== "core") return fail(res, 404, "rest_icon_collection_not_found", `Icon collection not found: "${req.params.slug}".`);
    const value = fields(coreIconCollection, query); return res.json(req.params.slug ? value : [value]);
  }
  const collection = req.params.collection || query.collection;
  if (req.params.name) {
    const name = `${req.params.collection}/${req.params.name}`, icon = getBundledIcon(name);
    if (!icon) return fail(res, 404, "rest_icon_not_found", `Icon not found: "${name}".`);
    return res.json(fields(icon, query));
  }
  if (collection && collection !== "core") return fail(res, 404, "rest_icon_collection_not_found", `Icon collection not found: "${collection}".`);
  // Like the source registry, icon collections are small, fixed, and do not
  // paginate even though the inherited REST collection params are validated.
  const search = query.search && query.search !== "0" ? query.search.toLowerCase() : "";
  return res.json(bundledIcons.filter(icon => !search || icon.name.toLowerCase().includes(search) || icon.label.toLowerCase().includes(search)).map(icon => fields(icon, query)));
});
export default router;
