export type EditorPreferences = {
  editorMode: "visual" | "text";
  fixedToolbar: boolean;
  distractionFree: boolean;
  focusMode: boolean;
  fullscreenMode: boolean;
  showBlockBreadcrumbs: boolean;
  showListViewByDefault: boolean;
  showIconLabels: boolean;
  keepCaretInsideBlock: boolean;
};

/** Supplied edit-post/editor defaults, scoped to each authenticated account. */
export const DEFAULT_EDITOR_PREFERENCES = Object.freeze<EditorPreferences>({
  editorMode: "visual",
  fixedToolbar: false,
  distractionFree: false,
  focusMode: false,
  fullscreenMode: true,
  showBlockBreadcrumbs: true,
  showListViewByDefault: false,
  showIconLabels: false,
  keepCaretInsideBlock: false,
});

/** Ignore unavailable legacy keys; never let malformed storage enable a mode. */
export function resolveEditorPreferences(value: unknown): EditorPreferences {
  const result: EditorPreferences = { ...DEFAULT_EDITOR_PREFERENCES };
  if (!value || typeof value !== "object" || Array.isArray(value)) return result;
  const source = value as Record<string, unknown>;
  for (const key of Object.keys(DEFAULT_EDITOR_PREFERENCES) as (keyof EditorPreferences)[]) {
    if (!Object.hasOwn(source, key)) continue;
    if (key === "editorMode") {
      if (source[key] === "visual" || source[key] === "text") result[key] = source[key];
    } else if (typeof source[key] === "boolean") result[key] = source[key];
  }
  return result;
}
