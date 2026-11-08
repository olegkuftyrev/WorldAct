/** Supplied default comments_open age filter: posts only, strict age boundary.
 * A missing publication date is undated, never a fallback to creation time. */
export function commentsOpen(post: {type?: string; commentStatus?: string; comment_status?: string; publishedAt?: string | Date | null; published_at?: string | Date | null}, settings?: {closeCommentsDays?: number}, now = Date.now()): boolean {
  const status = post.commentStatus ?? post.comment_status;
  if (status !== undefined && status !== "open") return false;
  const days = Number(settings?.closeCommentsDays), published = post.publishedAt ?? post.published_at;
  if (post.type !== "post" || !Number.isFinite(days) || days <= 0 || !published) return true;
  const date = new Date(published).getTime();
  return !Number.isFinite(date) || now - date <= days * 86_400_000;
}
