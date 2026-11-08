import { HttpError } from "./utils.js";

type CommentActor={id:number;role:string};
export type CommentPost = { authorId: number; type: string; status: string; preTrashStatus?: string | null };
export function contributorCanEditPostStatus(post: Pick<CommentPost, "status" | "preTrashStatus">) {
  return ["draft", "pending", "private"].includes(post.status) ||
    (post.status === "trash" && !["publish", "future"].includes(post.preTrashStatus || ""));
}
export function canModerateAllComments(user: CommentActor) {
  return user.role === "administrator" || user.role === "editor";
}
export function canEditPostComments(user: CommentActor, post: CommentPost) {
  if (canModerateAllComments(user)) return true;
  return ["author", "contributor"].includes(user.role) && post.type === "post" &&
    post.authorId === user.id &&
    (user.role !== "contributor" || contributorCanEditPostStatus(post));
}
export function assertCommentAccess(user: CommentActor, post: CommentPost) {
  if (!canEditPostComments(user, post)) throw new HttpError(403, "You cannot edit comments on this post.");
}
/** SQL aliases are fixed by the caller; IDs remain query parameters. */
export function editableCommentPostsSQL(user: CommentActor, parameter: (value: unknown) => string) {
  if (canModerateAllComments(user)) return "true";
  if (!["author", "contributor"].includes(user.role)) return "false";
  return `(p.type='post' AND p.author_id=${parameter(user.id)}${user.role === "contributor" ? " AND (p.status IN ('draft','pending','private') OR (p.status='trash' AND COALESCE(p.pre_trash_status,'') NOT IN ('publish','future')))" : ""})`;
}
