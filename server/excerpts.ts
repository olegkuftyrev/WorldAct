import { DOMParser } from "linkedom";
import { plainText } from "./utils.js";
import { stripBuiltinShortcodes } from "./shortcode-parser.js";

/** Source automatic excerpts omit both reference markers and the footnote list. */
export function excerptText(value: string): string {
  value = stripBuiltinShortcodes(value);
  if (!/data-fn|wp-block-footnotes/i.test(value)) return plainText(value);
  const document = new DOMParser().parseFromString(`<!doctype html><html><body>${value}</body></html>`, "text/html");
  for (const node of document.querySelectorAll("sup[data-fn], .wp-block-footnotes")) node.remove();
  return plainText(document.body.innerHTML);
}
