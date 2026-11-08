import {parse, getBlockType, type Block} from "@wordpress/blocks";
import {editorBlockAttributes} from "./blockAttributes";

// Keep native validation/recovery fields and client IDs. Creating new blocks
// from the durable JSON here would silently turn malformed source into valid
// replacement markup before the user sees the native recovery controls.
export function parseEditorSource(source: string): Block[] {
  const adapt = (block: Block): Block => {
    const attributes = editorBlockAttributes(block.attributes, getBlockType(block.name)?.attributes);
    if (block.name === "core/post-date" && !attributes.datetime && !(attributes.metadata as any)?.bindings?.datetime) {
      attributes.metadata = { ...(attributes.metadata as object), bindings: { datetime: { source: "core/post-data", args: { field: attributes.displayModified ? "modified" : "date" } } } };
    }
    return { ...block, attributes, innerBlocks: (block.innerBlocks || []).map(adapt) };
  };
  return parse(source).map(adapt);
}
