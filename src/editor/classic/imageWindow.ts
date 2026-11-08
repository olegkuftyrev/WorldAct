/** Reflow the actual TinyMCE 4 form controls on narrow viewports. No fields,
 * callbacks or image behavior are replaced by a second editor. */
export function classicImageWindow(
  spec: any,
  viewport: number,
  height = 812,
): any {
  if (viewport >= 600) return spec;
  const form = (item: any): any => {
    if (!item || typeof item !== "object") return item;
    return {
      ...item,
      ...(typeof item.size === "number"
        ? { size: Math.min(20, item.size) }
        : {}),
      ...(item.type === "form"
        ? {
            labelGapCalc: false,
            formItemDefaults: {
              layout: "flex",
              direction: "column",
              align: "stretch",
              spacing: 4,
              defaults: { flex: 1 },
            },
            ...(item.layout === "grid" ? { columns: 1 } : {}),
          }
        : {}),
      ...(Array.isArray(item.items) ? { items: item.items.map(form) } : {}),
    };
  };
  return {
    ...spec,
    width: Math.max(260, viewport - 24),
    height: Math.min(400, Math.max(260, height - 160)),
    minHeight: Math.min(400, Math.max(260, height - 160)),
    minWidth: 0,
    maxWidth: Math.max(260, viewport - 24),
    body: Array.isArray(spec.body) ? spec.body.map(form) : spec.body,
  };
}
