import { RichTextToolbarButton, store as blockEditorStore } from "@wordpress/block-editor";
import { createBlock, store as blocksStore } from "@wordpress/blocks";
import { store as coreDataStore } from "@wordpress/core-data";
import { useDispatch, useRegistry, useSelect } from "@wordpress/data";
import { formatListNumbered } from "@wordpress/icons";
import { insertObject } from "@wordpress/rich-text";
import { findOwnedFootnotes, footnoteEntityBoundaries } from "./footnoteScope";

/** Source Footnote format action, with its list lookup scoped to the owner. */
export function OwnedFootnoteFormat({ value, onChange, isObjectActive, context: { postId, postType } }: any) {
  const registry = useRegistry();
  const supported = useSelect((select) => {
    if (!select(blocksStore).getBlockType("core/footnotes")) return false;
    const editor = select(blockEditorStore), allowed = editor.getSettings().allowedBlockTypes;
    if (allowed === false || (Array.isArray(allowed) && !allowed.includes("core/footnotes"))) return false;
    const record = select(coreDataStore).getEntityRecord("postType", postType, postId) as any;
    const selected = editor.getSelectedBlockClientId();
    return typeof record?.meta?.footnotes === "string" && !!selected && editor.getBlockName(selected) !== "core/footnotes" &&
      !editor.getBlockParents(selected).some((id) => footnoteEntityBoundaries.has(editor.getBlockName(id) || ""));
  }, [postId, postType]);
  const { insertBlock, selectionChange } = useDispatch(blockEditorStore);
  if (!supported) return null;
  function onClick() {
    registry.batch(() => {
      let id: string;
      if (isObjectActive) id = value.replacements[value.start]?.attributes?.["data-fn"];
      else {
        id = `fn-${crypto.randomUUID()}`;
        const next = insertObject(value, { type: "core/footnote", attributes: { "data-fn": id }, innerHTML: `<a href="#${id}" id="${id}-link">*</a>` }, value.end, value.end);
        next.start = next.end! - 1;
        onChange(next);
      }
      if (!id) return;
      const editor = registry.select(blockEditorStore);
      let list = findOwnedFootnotes(editor.getBlocks());
      if (!list) { list = createBlock("core/footnotes"); insertBlock(list); }
      selectionChange(list.clientId, id, 0, 0);
    });
  }
  return <RichTextToolbarButton name="footnote" icon={formatListNumbered} title="Footnote" onClick={onClick} isActive={isObjectActive} />;
}
