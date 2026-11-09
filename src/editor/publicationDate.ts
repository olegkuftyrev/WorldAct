import { civilFromInstant, parsePostCivil, postCivilInstant } from "../../shared/post-civil-date";

/** datetime-local can omit zero seconds. Keep the API's canonical civil grammar. */
export function publicationDateInput(value: string): string {
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value) ? `${value}:00` : value;
}

export function publicationDateChange(value: string, original: string) {
  const postDate = publicationDateInput(value);
  return { postDate, postDateIntent: postDate === original ? undefined : postDate || null };
}

export function publicationDatePayload(intent: string | null | undefined): { postDate?: string | null } {
  return intent === undefined ? {} : { postDate: intent };
}

/** Client scheduling hints use the site zone. The server still validates writes.
 * Reject gap normalization here rather than silently selecting another hour. */
export function publicationInstant(civil: string, timezone: string): string | null {
  if (!parsePostCivil(civil)) return null;
  try {
    const instant = postCivilInstant(civil, timezone);
    return civilFromInstant(instant, timezone) === civil ? instant : null;
  } catch { return null; }
}

/** An unchanged fixed draft may have a chosen GMT but no legacy scheduledAt.
 * A floating draft has no chosen instant, even if a legacy due value remains.
 * Only a local edit asks the current site zone to select a new instant. */
export function publicationActionInstant(value: {
  postDate: string;
  postDateGmt: string | null;
  postDateIntent?: string | null;
}, timezone?: string): string | null {
  if (value.postDateIntent === undefined)
    return value.postDateGmt && Number.isFinite(Date.parse(value.postDateGmt)) ? value.postDateGmt : null;
  if (value.postDateIntent === null || !timezone) return null;
  return publicationInstant(value.postDate, timezone);
}
