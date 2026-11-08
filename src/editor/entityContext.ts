import type { SiteTemplate } from "../api";

export type EditorEntityContext = {
  id: string | number;
  type: "wp_template" | "wp_template_part" | "wp_block";
  record: Record<string, unknown>;
};
export type EditorSelectorContext = { id?: string | number; type?: string; attributes?: Record<string, unknown> };

/** A representative post supplies block previews, never the editing identity. */
export function editorSelectorContext(entity: EditorEntityContext | null | undefined, preview: EditorSelectorContext): EditorSelectorContext {
  if (entity === undefined) return preview;
  return entity ? { id: entity.id, type: entity.type, attributes: entity.record } : {};
}

export function siteDocumentEntity(document: SiteTemplate & { version?: number }, theme: string): EditorEntityContext | null {
  // Unsynced site-document patterns are not wp_block records. Do not borrow a
  // numeric pattern entity ID or a representative post's editing identity.
  if (document.type === "pattern") return null;
  const id = `${theme}//${document.slug}`, type = document.type === "template-part" ? "wp_template_part" : "wp_template";
  return {
    id, type,
    record: { id, wp_id: document.id, type, theme, slug: document.slug, status: "publish", area: document.area || "uncategorized", title: { raw: document.title, rendered: document.title.replace(/[&<>\"]/g,character=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"})[character]!) }, content: { raw: document.content, rendered: "" }, version: document.version },
  };
}

export function isNavigationOverlayEntity(entity: EditorEntityContext | null | undefined) {
  return entity?.type === "wp_template_part" && !!entity.id && entity.record.area === "navigation-overlay";
}

export function ownsEntityEdit(entity: EditorEntityContext | null | undefined, edit: { kind: string; name: string; key: unknown }) {
  return !!entity && edit.kind === "postType" && edit.name === entity.type && String(edit.key) === String(entity.id);
}
