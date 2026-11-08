import { isHorizontalEdge, isRTL, isVerticalEdge } from "@wordpress/dom";

/** Native editableRoot lets the browser cross RichText siblings itself. The
 * source arrow-navigation setting skips its own moves, so also contain that
 * browser default at the same native edges. Ordinary text movement is intact. */
export function containNativeCaret(event: KeyboardEvent): boolean {
  if (event.defaultPrevented || event.isComposing || event.shiftKey || event.metaKey || event.ctrlKey || event.altKey || !/^Arrow(Up|Down|Left|Right)$/.test(event.key)) return false;
  const doc = (event.target as Node)?.ownerDocument, selection = doc?.defaultView?.getSelection();
  if (!selection?.isCollapsed || !selection.anchorNode) return false;
  const anchor = selection.anchorNode.nodeType === 1 ? selection.anchorNode as Element : selection.anchorNode.parentElement;
  const editable = anchor?.closest<HTMLElement>('[contenteditable="true"][data-wp-block-attribute-key]');
  if (!editable || !selection.focusNode || !editable.contains(selection.focusNode) || doc?.body.contentEditable !== "true") return false;
  const reverse = event.key === "ArrowUp" || event.key === "ArrowLeft";
  const edge = event.key === "ArrowUp" || event.key === "ArrowDown"
    ? isVerticalEdge(editable, reverse)
    : isHorizontalEdge(editable, isRTL(editable) ? !reverse : reverse);
  if (!edge) return false;
  event.preventDefault();
  return true;
}
