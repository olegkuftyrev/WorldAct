import { z } from "zod";
import { autop } from "@wordpress/autop";
import { cleanContent, HttpError } from "./utils.js";

export const MAX_MEDIA_CAPTION_LENGTH = 120_000;
export const mediaCaptionSchema = z.string().max(MAX_MEDIA_CAPTION_LENGTH);
const legacyCaptionSchema = z.string().max(20_000);
export function escapeLegacyMediaCaption(text: string) {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
/** Canonical HTML is always sanitized; its format marker never grants trust. */
export function mediaCaptionHTML(value: unknown, isHTML = true): string {
  const input = mediaCaptionSchema.parse(value);
  const caption = cleanContent(isHTML ? input : escapeLegacyMediaCaption(input));
  if (caption.length > MAX_MEDIA_CAPTION_LENGTH) throw new HttpError(400, "The sanitized media caption exceeds 120000 characters.");
  return caption;
}
export function importedMediaCaption(value: unknown = "", marker: unknown = undefined): string {
  const isHTML = z.boolean().optional().default(false).parse(marker);
  return mediaCaptionHTML((isHTML ? mediaCaptionSchema : legacyCaptionSchema).parse(value), isHTML);
}
/** Supplied attachment REST controller applies the_excerpt's paragraph filter. */
export function renderedMediaCaption(value: string): string {
  return cleanContent(autop(value));
}
