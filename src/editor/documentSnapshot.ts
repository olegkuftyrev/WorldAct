import type { Footnote, Post, SerializedBlock } from "../api";
import { publicationDateChange } from "./publicationDate";

type DocumentContent = { content: string; blocks: SerializedBlock[] | null; footnotes: Footnote[] };
type Canvas = { getHTML: () => string; getBlocks: () => SerializedBlock[]; getFootnotes: () => Footnote[] };
type DateSelection = { postDate: string; postDateIntent?: string | null };
export type DraftPublicationAcknowledgement = {
  from: DateSelection;
  post: Pick<Post, "status" | "postDate" | "postDateGmt" | "scheduledAt">;
};

export function acknowledgedDraftPublication(current: DateSelection, { from, post }: DraftPublicationAcknowledgement) {
  return { savedStatus: post.status, postDateOriginal: post.postDate, postDateGmt: post.postDateGmt,
    ...(current.postDate === from.postDate && current.postDateIntent === from.postDateIntent
      ? { postDate: post.postDate, postDateIntent: undefined, scheduledAt: post.scheduledAt || "" }
      : publicationDateChange(current.postDate, post.postDate)) };
}

export function liveDocumentSnapshot<T extends DocumentContent>(current: T, editor: Canvas | null): T {
  return editor ? { ...current, content: editor.getHTML(), blocks: editor.getBlocks(), footnotes: editor.getFootnotes() } : current;
}

/** Only a known draft-creation response may rebase the submitted comparison.
 * Its editable values remain the values captured when Save was pressed. */
export function submittedSnapshotAfterDraft<T extends DateSelection>(submitted: T, creation?: DraftPublicationAcknowledgement | null): T {
  return creation ? { ...submitted, ...acknowledgedDraftPublication(submitted, creation) } : submitted;
}

export function documentHasUnsentChanges<T extends DocumentContent & DateSelection, U extends DocumentContent & DateSelection>(current: T, submitted: U, editor: Canvas | null, creation?: DraftPublicationAcknowledgement | null): boolean {
  return JSON.stringify(liveDocumentSnapshot(current, editor)) !== JSON.stringify(submittedSnapshotAfterDraft(submitted, creation));
}
