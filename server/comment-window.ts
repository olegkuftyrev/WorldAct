import type pg from "pg";
import { pool, type defaultSettings } from "./db.js";
import { HttpError } from "./utils.js";

type Database = Pick<pg.Pool, "query"> | pg.PoolClient;
type CommentSettings = Pick<typeof defaultSettings, "threadComments" | "paginateComments" | "commentsPerPage" | "commentOrder" | "defaultCommentPage">;

// Reject an oversized complete window; never truncate a thread into another page.
export const MAX_PUBLIC_COMMENT_RECORDS = 4000;
export const MAX_PUBLIC_COMMENT_BYTES = 8 * 1024 * 1024;

/** Root selection, descendants and counts share one statement snapshot. Only a
 * real approved root admits descendants: hidden/cross-post parents and detached
 * historical cycles do not turn their children into additional threaded roots.
 * UNION visits immutable comment IDs once, without growing ancestry arrays. */
export async function publicCommentWindow(
  postId: number,
  requestedPage: number | undefined,
  settings: CommentSettings,
  db: Database = pool,
) {
  const rows = (await db.query(`WITH RECURSIVE
    counts AS (
      SELECT count(*)::int AS total,
        count(*) FILTER (WHERE parent_id IS NULL)::int AS roots
      FROM comments WHERE post_id=$1 AND status='approved'
    ),
    pages AS (
      SELECT *,CASE WHEN $3::boolean
        THEN greatest(1,ceil((CASE WHEN $2::boolean THEN roots ELSE total END)::numeric / $4::int))::int
        ELSE 1 END AS "totalPages" FROM counts
    ),
    pagination AS (
      SELECT *,CASE WHEN $3::boolean THEN least(
        coalesce($5::int,CASE WHEN $6::boolean THEN "totalPages" ELSE 1 END),"totalPages")
        ELSE 1 END AS page FROM pages
    ),
    selected AS (
      SELECT c.id FROM comments c
      WHERE c.post_id=$1 AND c.status='approved' AND (NOT $2::boolean OR c.parent_id IS NULL)
      ORDER BY c.created_at ASC,c.id ASC
      LIMIT (CASE WHEN $3::boolean THEN $4::int ELSE $7::int + 1 END)
      OFFSET (SELECT CASE WHEN $3::boolean THEN (page::bigint-1)*$4::int ELSE 0 END FROM pagination)
    ),
    reachable(id) AS (
      SELECT id FROM selected
      UNION
      SELECT c.id FROM comments c JOIN reachable parent ON c.parent_id=parent.id
      WHERE $2::boolean AND c.post_id=$1 AND c.status='approved'
    ),
    window_ids AS MATERIALIZED (SELECT id FROM reachable LIMIT $7::int + 1),
    budget AS (
      SELECT count(*)::int AS "windowCount",
        coalesce(sum(octet_length(c.content)+octet_length(c.author_name)+octet_length(c.author_url)+512),0) AS "windowBytes"
      FROM window_ids ids JOIN comments c ON c.id=ids.id
    )
    SELECT pagination.*,budget.*,
      c.id,c.parent_id AS "parentId",c.author_name AS "authorName",
      c.author_email AS "_avatarEmail",avatar_user.email AS "_accountAvatarEmail",
      c.author_url AS "authorUrl",c.user_id AS "userId",c.content,c.type,c.status,
      c.post_id AS "postId",p.title AS "postTitle",c.created_at AS "createdAt"
    FROM pagination CROSS JOIN budget
    LEFT JOIN window_ids ids ON budget."windowCount"<=$7 AND budget."windowBytes"<=$8
    LEFT JOIN comments c ON c.id=ids.id
    LEFT JOIN posts p ON p.id=c.post_id
    LEFT JOIN users avatar_user ON avatar_user.id=c.user_id
    ORDER BY c.created_at ASC,c.id ASC`,
  [postId, settings.threadComments, settings.paginateComments, settings.commentsPerPage,
    requestedPage ?? null, settings.defaultCommentPage === "newest",
    MAX_PUBLIC_COMMENT_RECORDS, MAX_PUBLIC_COMMENT_BYTES])).rows;
  const first = rows[0];
  if (first.windowCount > MAX_PUBLIC_COMMENT_RECORDS || Number(first.windowBytes) > MAX_PUBLIC_COMMENT_BYTES)
    throw new HttpError(413, "The complete comment window exceeds the 4000-comment or 8 MiB limit. Reduce comments per page or enable comment pagination.");
  let comments = rows.filter(row => row.id != null).map(({total: _total, roots: _roots, totalPages: _totalPages,
    page: _page, windowCount: _windowCount, windowBytes: _windowBytes, ...comment}) => comment);
  // Source pages always advance through chronological roots. Descending is a
  // display choice for the selected roots, never a reversal of page identity
  // or of a threaded root's chronological children. Flat rows are all roots.
  if (settings.commentOrder === "desc") comments = settings.threadComments
    ? [...comments.filter(comment => comment.parentId == null).reverse(), ...comments.filter(comment => comment.parentId != null)]
    : comments.reverse();
  return {
    comments,
    total: first.total as number,
    totalTopLevelComments: first.roots as number,
    page: first.page as number,
    perPage: settings.paginateComments ? settings.commentsPerPage : Math.max(1, first.total),
    totalPages: first.totalPages as number,
  };
}
