import { useEffect, useRef, type RefObject } from "react";

export type EditorShortcut = "mode" | "distraction" | "help" | "reveal";
export function editorShortcut(event: Pick<KeyboardEvent, "key" | "code" | "metaKey" | "ctrlKey" | "shiftKey" | "altKey" | "repeat" | "isComposing" | "defaultPrevented">, apple: boolean): EditorShortcut | null {
  if (event.repeat || event.isComposing || event.defaultPrevented) return null;
  const primary = apple ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
  if (primary && event.shiftKey && event.altKey && event.key.toLowerCase() === "m") return "mode";
  if (primary && event.shiftKey && !event.altKey && (event.code === "Backslash" || event.key === "\\")) return "distraction";
  if ((apple ? event.ctrlKey && event.altKey && !event.metaKey && !event.shiftKey : event.altKey && event.shiftKey && !event.ctrlKey && !event.metaKey) && event.key.toLowerCase() === "h") return "help";
  if (event.key === "F6" && !event.altKey && !event.metaKey && !event.ctrlKey && !event.shiftKey) return "reveal";
  return null;
}

/** Global editor keys reach its same-origin canvas, but never a modal/URL form. */
export function useEditorShortcuts(root: RefObject<HTMLElement | null>, onShortcut: (action: EditorShortcut) => boolean | void, active: boolean) {
  const handler = useRef(onShortcut); handler.current = onShortcut;
  useEffect(() => {
    if (!active || !root.current) return;
    const documents = new Map<Document, MutationObserver | null>(), apple = /Mac|iPod|iPhone|iPad/.test(navigator.platform);
    const keyDown = (event: KeyboardEvent) => {
      if (document.querySelector('[role="dialog"], [role="alertdialog"]')) return;
      const target = event.target as HTMLElement;
      if (target.closest('[role="dialog"], .components-popover, .tox-dialog') || target.matches('input, select') || target.matches('textarea:not(.editor-post-text-editor):not(.editor-title)')) return;
      const action = editorShortcut(event, apple);
      if (!action) return;
      if (handler.current(action) === false) return;
      event.preventDefault(); event.stopPropagation();
    };
    const bind = () => {
      const current = new Set([document]);
      const visit = (frames: Iterable<HTMLIFrameElement>) => { for (const frame of frames) { const doc = frame.contentDocument; if (!doc || current.has(doc)) continue; current.add(doc); visit(doc.querySelectorAll<HTMLIFrameElement>("iframe")); } };
      visit(root.current?.querySelectorAll<HTMLIFrameElement>('iframe[name="editor-canvas"]') || []);
      for (const [old, observer] of documents) if (!current.has(old)) { old.removeEventListener("keydown", keyDown, true); old.removeEventListener("load", bind, true); observer?.disconnect(); documents.delete(old); }
      for (const doc of current) if (!documents.has(doc)) { const observer = doc !== document ? new MutationObserver(bind) : null; documents.set(doc, observer); doc.addEventListener("keydown", keyDown, true); doc.addEventListener("load", bind, true); if (doc.documentElement) observer?.observe(doc.documentElement, { childList: true, subtree: true }); }
    };
    const observer = new MutationObserver(bind); observer.observe(root.current, { childList: true, subtree: true }); root.current.addEventListener("load", bind, true); bind();
    const element = root.current;
    return () => { observer.disconnect(); element.removeEventListener("load", bind, true); for (const [doc, nestedObserver] of documents) { doc.removeEventListener("keydown", keyDown, true); doc.removeEventListener("load", bind, true); nestedObserver?.disconnect(); } };
  }, [active, root]);
}
