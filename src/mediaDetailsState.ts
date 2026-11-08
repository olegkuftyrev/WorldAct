import type { Media } from "./api";

const draftFields = ["title", "alt", "caption", "description", "commentStatus"] as const;
type Details = Media & { description?: string; commentStatus?: "open" | "closed" };
export type MediaMetadataDraft = Partial<Pick<Details, typeof draftFields[number]>>;
export function mediaMetadataDraft(current: Details, baseline: Details): MediaMetadataDraft {
  const draft: MediaMetadataDraft = {};
  for (const field of draftFields) if (current[field] !== baseline[field])
    draft[field] = current[field] as never;
  return draft;
}

// Pixel operations do not submit these fields. A metadata save may normalize
// them, but only while the user has not edited that field again after Submit.
export function mergeMediaDetails<T extends Details>(current: T | null, submitted: T | null, updated: Details): T | null {
  if (!current || current.id !== updated.id) return current;
  const result = { ...current, ...updated };
  for (const field of draftFields)
    if (!submitted || current[field] !== submitted[field])
      (result as Details)[field] = current[field] as never;
  return result;
}
