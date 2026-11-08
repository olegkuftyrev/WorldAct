import type { Comment } from "./api";

export type CommentShortcut =
  | "approved"
  | "pending"
  | "spam"
  | "trash"
  | "delete"
  | "restore"
  | "reply"
  | "quick"
  | "edit";
/** The source table-hotkeys activate existing permitted actions only. */
export function commentShortcut(
  comment: Comment,
  key: string,
  shifted: boolean,
): CommentShortcut | null {
  const removed = comment.status === "spam" || comment.status === "trash",
    permissions = comment.permissions;
  if (shifted) {
    if (!permissions?.moderate)
      return key === "d" && removed && permissions?.delete ? "delete" : null;
    if (key === "z" && comment.status === "trash") return "restore";
    if (key === "d" && removed && permissions.delete) return "delete";
    if (removed) return null;
    return (
      ({ a: "approved", u: "pending", s: "spam", t: "trash" } as const)[
        key as "a" | "u" | "s" | "t"
      ] || null
    );
  }
  if (key === "z" && removed && permissions?.moderate) return "restore";
  if (key === "d")
    return removed
      ? permissions?.delete
        ? "delete"
        : null
      : permissions?.moderate
        ? "trash"
        : null;
  if (removed) return null;
  if (key === "a" && comment.status === "pending" && permissions?.moderate)
    return "approved";
  if (key === "u" && comment.status === "approved" && permissions?.moderate)
    return "pending";
  if (key === "s" && permissions?.moderate) return "spam";
  if (key === "r" && permissions?.reply) return "reply";
  if (key === "q" && permissions?.edit) return "quick";
  if (key === "e" && permissions?.edit) return "edit";
  return null;
}
