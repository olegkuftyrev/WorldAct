import { parse } from "@wordpress/block-serialization-default-parser";
import { cleanBlocks, cleanContent, cleanRawContent, type StoredBlock } from "./utils.js";

export type ImportedBlockEntity = {
  id: number;
  kind: "reusable" | "navigation";
};

/** Imported references must resolve only inside the imported entity graph. */
export function remapImportedBlockReferences(
  rawContent: string,
  blocks: unknown,
  entities: ReadonlyMap<number, ImportedBlockEntity>,
) {
  const warnings = new Set<string>();
  const reference = (name: string, attributes: Record<string, unknown>) => {
    const kind = name === "core/block" ? "reusable" : "navigation";
    if (name !== "core/block" && name !== "core/navigation") return attributes;
    if (name === "core/navigation" && !Object.hasOwn(attributes, "ref"))
      return attributes;
    const value = attributes.ref;
    const sourceId = typeof value === "number" ||
      (typeof value === "string" && /^\d+$/.test(value)) ? Number(value) : 0;
    const target = Number.isSafeInteger(sourceId) && sourceId > 0
      ? entities.get(sourceId)
      : undefined;
    if (target?.kind === kind) return { ...attributes, ref: target.id };
    if (warnings.size < 100)
      warnings.add(`Dropped ${name} reference ${sourceId || "without a valid ID"}: its ${kind} entity is not included in this import.`);
    return null;
  };
  const rewriteJSON = (nodes: StoredBlock[]): StoredBlock[] => nodes.flatMap(node => {
    const attributes = reference(node.name, node.attributes);
    return attributes ? [{ ...node, attributes, innerBlocks: rewriteJSON(node.innerBlocks) }] : [];
  });
  const serialize = (node: ReturnType<typeof parse>[number]): string => {
    if (!node.blockName) return node.innerHTML;
    const attributes = reference(node.blockName, node.attrs || {});
    if (!attributes) return "";
    let child = 0;
    const content = node.innerContent.map(fragment => fragment === null
      ? serialize(node.innerBlocks[child++])
      : fragment);
    while (child < node.innerBlocks.length) content.push(serialize(node.innerBlocks[child++]));
    const inner = content.join("");
    const name = node.blockName.replace(/^core\//, "");
    const encoded = Object.keys(attributes).length
      ? " " + JSON.stringify(attributes).replace(/--/g, "\\u002d\\u002d")
        .replace(/</g, "\\u003c").replace(/>/g, "\\u003e").replace(/&/g, "\\u0026")
      : "";
    return inner
      ? `<!-- wp:${name}${encoded} -->${inner}<!-- /wp:${name} -->`
      : `<!-- wp:${name}${encoded} /-->`;
  };
  const safeRaw = cleanRawContent(rawContent);
  const rewrittenRaw = safeRaw.includes("<!-- wp:")
    ? cleanRawContent(parse(safeRaw).map(serialize).join(""))
    : safeRaw;
  const rewrittenBlocks = rewriteJSON(cleanBlocks(blocks ?? []));
  return {
    rawContent: rewrittenRaw,
    content: cleanContent(rewrittenRaw),
    blocks: rewrittenBlocks,
    warnings: [...warnings],
  };
}
