const units = "(?:px|em|rem|%|ch|ex|vw|vh|vmin|vmax|svw|svh|lvw|lvh|dvw|dvh|cm|mm|in|pt|pc)";
const literalLength = `(?:\\d+(?:\\.\\d+)?|\\.\\d+)${units}`;
const presetLength = "var\\(--wp--preset--spacing--[a-z0-9-]{1,100}\\)";
const lengthToken = `(?:${literalLength}|${presetLength})`;
const rootGap = "var\\(--wp--style--block-gap, 1\\.2rem\\)";
const gapToken = `(?:0px|${lengthToken}|${rootGap})`;
const countToken = "(?:[1-9]\\d{0,2}|1000)";

/** A CSS length accepted by the native grid controls, without executable CSS. */
export function gridLength(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const input = value.trim().toLowerCase();
  const preset = input.match(/^var:preset\|spacing\|([a-z0-9-]{1,100})$/);
  if (preset) return `var(--wp--preset--spacing--${preset[1]})`;
  if (new RegExp(`^${presetLength}$`).test(input)) return input;
  if (!new RegExp(`^${literalLength}$`).test(input)) return null;
  const amount = parseFloat(input);
  return Number.isFinite(amount) && amount > 0 && amount <= 10000 ? input : null;
}

export function gridColumnCount(layout: Record<string, unknown>): number | null {
  const value = Number(layout.columnCount);
  return Number.isFinite(value) && value >= 1 ? Math.min(1000, Math.trunc(value)) : null;
}

export function isResponsiveGrid(layout: Record<string, unknown> | undefined): boolean {
  return layout?.type === "grid" && (!gridColumnCount(layout) || !!gridLength(layout.minimumColumnWidth));
}

/** Mirrors wp-includes/block-supports/layout.php's fixed and adaptive grids. */
export function gridTemplateColumns(layout: Record<string, unknown>, blockGap?: unknown): string {
  const count = gridColumnCount(layout), minimum = gridLength(layout.minimumColumnWidth);
  if (count && !minimum) return `repeat(${count}, minmax(0, 1fr))`;
  const placement = layout.autoFit === true ? "auto-fit" : "auto-fill";
  if (!count) return `repeat(${placement}, minmax(min(${minimum || "12rem"}, 100%), 1fr))`;
  const gapValue = blockGap && typeof blockGap === "object" ? (blockGap as Record<string, unknown>).left ?? (blockGap as Record<string, unknown>).top : blockGap;
  const zeroGap = gapValue === 0 || typeof gapValue === "string" && /^0(?:\.0+)?(?:px|em|rem|%|ch|ex|vw|vh|vmin|vmax|svw|svh|lvw|lvh|dvw|dvh|cm|mm|in|pt|pc)?$/i.test(gapValue.trim());
  const gap = zeroGap ? "0px" : gridLength(gapValue) || "var(--wp--style--block-gap, 1.2rem)";
  return `repeat(${placement}, minmax(max(min(${minimum}, 100%), (100% - (${gap} * (${count} - 1))) / ${count}), 1fr))`;
}

// Only the three generated forms above survive HTML sanitization. The bounded
// grammar excludes arbitrary functions, URLs, declarations and selector text.
export const gridTemplateColumnsPattern = new RegExp(
  `^repeat\\((?:${countToken}, minmax\\(0, 1fr\\)|(?:auto-fill|auto-fit), minmax\\((?:min\\(${lengthToken}, 100%\\)|max\\(min\\(${lengthToken}, 100%\\), \\(100% - \\(${gapToken} \\* \\(${countToken} - 1\\)\\)\\) / ${countToken}\\)), 1fr\\))\\)$`, "i",
);
