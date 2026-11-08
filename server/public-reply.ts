/** Resolve the actual visible approved human tree, without promoting detached
 * or cross-post children. Supplied WP _get_comment_reply_id validates existence,
 * approval and post; WorldAct's existing Reply controls additionally enforce the
 * real ancestry/depth limit, which direct/native navigation must preserve. */
export function publicReplyParent(postId: number, requested: unknown, comments: {
  id: number; postId?: number; parentId?: number | null; status?: string; type?: string; authorName: string;
}[], settings: { threadComments?: boolean; threadDepth?: number }) {
  if (!settings.threadComments || typeof requested !== "string" || !/^[1-9]\d{0,9}$/.test(requested) || Number(requested) > 2147483647) return null;
  const byId = new Map(comments.map(comment => [comment.id, comment]));
  const selected = byId.get(Number(requested));
  if (!selected || selected.type && selected.type !== "comment") return null;
  let current: typeof selected | undefined = selected, depth = 1;
  const seen = new Set<number>();
  while (current) {
    if (seen.has(current.id) || current.postId !== postId || current.status !== "approved" || depth >= Number(settings.threadDepth || 1)) return null;
    seen.add(current.id);
    if (current.parentId == null) return selected;
    current = byId.get(current.parentId); depth++;
  }
  return null;
}
