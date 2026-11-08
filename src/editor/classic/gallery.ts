import { next, string } from "@wordpress/shortcode";
export type ClassicGallery = { attrs: Record<string, string>; ids: number[] };
export function readClassicGallery(text: string): ClassicGallery | null {
  const match = next("gallery", text);
  if (!match || match.content.trim() !== text.trim()) return null;
  const attrs = { ...match.shortcode.attrs.named } as Record<string, string>;
  const ids = String(attrs.ids || attrs.include || "")
    .split(",")
    .map(Number)
    .filter((id) => Number.isSafeInteger(id) && id > 0)
    .slice(0, 1000);
  return { attrs, ids };
}
export function writeClassicGallery(value: ClassicGallery): string {
  const attrs = {
    ...value.attrs,
    ids: [...new Set(value.ids)]
      .filter((id) => Number.isSafeInteger(id) && id > 0)
      .slice(0, 1000)
      .join(","),
  };
  delete (attrs as Record<string, string>).include;
  return string({
    tag: "gallery",
    type: "single",
    attrs: { named: attrs, numeric: [] },
  });
}
