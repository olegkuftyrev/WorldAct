import test from "./isolated-test.js";
import assert from "node:assert/strict";
import { editorSelectorContext, isNavigationOverlayEntity, ownsEntityEdit, siteDocumentEntity } from "../src/editor/entityContext.js";

test("site editing identity stays separate from representative post context and only overlay parts enable close insertion", () => {
  const preview = { id: 42, type: "post", attributes: { title: "Preview post" } };
  const document = { id: 7, slug: "menu", title: "Menu", type: "template-part" as const, area: "navigation-overlay" as const, content: "<p>Menu</p>", blocks: [], updatedAt: "2026-11-07" };
  const entity = siteDocumentEntity(document, "twentytwentyfive")!;
  assert.deepEqual(editorSelectorContext(entity, preview), { id: "twentytwentyfive//menu", type: "wp_template_part", attributes: entity.record });
  assert.equal(isNavigationOverlayEntity(entity), true);
  assert.equal(isNavigationOverlayEntity(siteDocumentEntity({ ...document, area: "header" }, "twentytwentyfive")), false);
  assert.equal(isNavigationOverlayEntity(siteDocumentEntity({ ...document, type: "template" }, "twentytwentyfive")), false);
  assert.equal(siteDocumentEntity({ ...document, type: "pattern" }, "twentytwentyfive"), null);
  assert.deepEqual(editorSelectorContext(null, preview), {});
  assert.equal(editorSelectorContext(undefined, preview), preview);
  assert.equal(preview.id, 42, "post block previews retain their own context");
  assert.equal(ownsEntityEdit(entity, { kind: "postType", name: "wp_template_part", key: entity.id }), true);
  assert.equal(ownsEntityEdit(entity, { kind: "postType", name: "wp_template_part", key: "twentytwentyfive//footer" }), false);
});
