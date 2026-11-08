import { HttpError } from "./utils.js";

type Field = { whole: boolean; children: Map<string, Field> };
const field = (): Field => ({ whole: false, children: new Map() });
/** Fixed own-property projection for native REST `_fields`, including arrays. */
export function projectRestFields(value: any, input: unknown) {
  if (input === undefined || input === "") return value;
  const fields = typeof input === "string" ? input.split(",") : Array.isArray(input) && input.every(item => typeof item === "string") ? input.flatMap(item => item.split(",")) : null;
  if (!fields || fields.length > 100 || fields.join(",").length > 4000) throw new HttpError(400, "The requested REST fields exceed the supported limit.");
  const root = field();
  for (const name of fields) {
    const path = name.trim().split(".");
    if (!name.trim()) continue;
    if (path.length > 10 || path.some(key => !/^[a-zA-Z0-9_:-]+$/.test(key))) throw new HttpError(400, "Use valid REST field paths.");
    if (path.some(key => ["__proto__", "prototype", "constructor"].includes(key))) continue;
    let node = root;
    for (const key of path) {
      if (!node.children.has(key)) node.children.set(key, field());
      node = node.children.get(key)!;
    }
    node.whole = true;
  }
  function pick(item: any, node: Field): any {
    if (node.whole) return item;
    if (Array.isArray(item)) return item.map(entry => pick(entry, node));
    const selected: Record<string, unknown> = {};
    if (!item || typeof item !== "object") return selected;
    for (const [key, next] of node.children) if (Object.hasOwn(item, key)) selected[key] = pick(item[key], next);
    return selected;
  }
  return pick(value, root);
}
