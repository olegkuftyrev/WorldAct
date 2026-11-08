import catalog from "./theme-source/tokens.json";
import { mergeThemeJSON, type ThemeJSON } from "./themeStyles";
export function themeDocument(id: string, variation = ""): ThemeJSON | null {
  const theme = catalog.find((item) => item.id === id);
  if (!theme) return null;
  const selected = theme.variations.find((item) => item.slug === variation && item.type === "theme");
  return selected ? mergeThemeJSON(theme.themeJSON, selected.data) : theme.themeJSON;
}
/** Resolve theme.json presets for native form values without changing source tokens. */
export function resolveThemeValue(value: unknown, document: ThemeJSON | null, depth = 0): string {
  if (depth > 8) return "";
  if (typeof value !== "string") return "";
  const token = /^var(?::preset\|([\w-]+)\|([\w-]+)|\(--wp--preset--([\w-]+?)--([\w-]+)\))$/.exec(value);
  if (!token) return value;
  const type = token[1] || token[3], slug = token[2] || token[4];
  const settings = document?.settings;
  const entries = type === "color" ? settings?.color?.palette
    : type === "font-family" ? settings?.typography?.fontFamilies
    : type === "font-size" ? settings?.typography?.fontSizes
    : type === "spacing" ? settings?.spacing?.spacingSizes : [];
  const preset = entries?.find((item: ThemeJSON) => item.slug === slug);
  return resolveThemeValue(preset?.color || preset?.fontFamily || preset?.size || "", document, depth + 1);
}
