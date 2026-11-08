import type { Comment } from "./api";

export type CommentTypeFilter = "all" | "comment" | "pings";
export function commentTypeFilter(value: string | null): CommentTypeFilter {
  return ["comment", "pings"].includes(value || "") ? value as CommentTypeFilter : "all";
}
export const isNotification = (comment: Pick<Comment, "type">) => comment.type === "pingback" || comment.type === "trackback";
export const commentTypeLabel = (comment: Pick<Comment, "type">) => comment.type === "pingback" ? "Pingback" : comment.type === "trackback" ? "Trackback" : "Comment";
/** Counts are scoped to readable posts, independently of current status/search. */
export function commentTypeOptions(counts: {comment?: number; pings?: number}, selected: CommentTypeFilter, loading: boolean) {
  const options = [{value: "all", label: "All comment types"}];
  if (counts.comment || (loading && selected === "comment")) options.push({value: "comment", label: "Comments"});
  if (counts.pings || (loading && selected === "pings")) options.push({value: "pings", label: "Pings"});
  return options;
}
