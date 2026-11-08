import { version } from "../package.json";
import { pool, getSettings, postMetadataFields, commentFields, type User } from "./db.js";
import { getBundledTheme } from "./themes.js";
import { withPermalink } from "./permalinks.js";
import { canEditPostComments, editableCommentPostsSQL } from "./comment-access.js";
import { plainText } from "./utils.js";

/** Source dashboard.php uses independent publication, future and own-draft
 * queries. Applying these filters after a shared LIMIT loses real activity. */
export async function readDashboard(user: User) {
  const own = ["author", "contributor"].includes(user.role), params = own ? [user.id] : [];
  const metadata = `${postMetadataFields},p.scheduled_at AS "scheduledAt"`;
  const commentParams: unknown[] = [...params];
  const editableCommentPost = editableCommentPostsSQL(user,value=>{commentParams.push(value);return "$"+commentParams.length;});
  const [counts, legacy, comments, published, scheduled, drafts, settings] = await Promise.all([
    pool.query(`SELECT
      (SELECT count(*)::int FROM posts WHERE type='post' AND status='publish' ${own ? "AND author_id=$1" : ""}) AS posts,
      (SELECT count(*)::int FROM posts WHERE type='page' AND status='publish' ${own ? "AND author_id=$1" : ""}) AS pages,
      (SELECT count(*)::int FROM comments c JOIN posts p ON p.id=c.post_id WHERE c.status NOT IN('trash','spam') ${own ? "AND p.author_id=$1" : ""}) AS comments,
      (SELECT count(*)::int FROM media ${own ? "WHERE author_id=$1" : ""}) AS media`, params),
    // Retained as a metadata-only compatibility field until all clients migrate.
    pool.query(`SELECT ${metadata} FROM posts p WHERE p.status<>'trash' ${own ? "AND p.author_id=$1" : ""} ORDER BY p.updated_at DESC,p.id DESC LIMIT 5`, params),
    pool.query(`SELECT ${commentFields},p.author_id AS "postAuthorId",p.type AS "postType",p.status AS "postStatus",p.pre_trash_status AS "postPreTrashStatus"
      FROM comments c JOIN posts p ON p.id=c.post_id WHERE c.status NOT IN('trash','spam') ${own ? "AND p.author_id=$1" : ""}
      AND (${editableCommentPost} OR (p.status='publish' AND p.password_hash IS NULL))
      ORDER BY c.created_at DESC,c.id DESC LIMIT 5`, commentParams),
    // Published metadata is readable even when another author owns it; no body,
    // blocks, raw source, excerpt, password hash or private draft enters this DTO.
    pool.query(`SELECT ${metadata} FROM posts p WHERE p.type='post' AND p.status='publish' ORDER BY COALESCE(p.published_at,p.created_at) DESC,p.id DESC LIMIT 5`),
    pool.query(`SELECT ${metadata} FROM posts p WHERE p.type='post' AND p.status='future'
      ${user.role === "contributor" ? "AND false" : own ? "AND p.author_id=$1" : ""}
      ORDER BY p.scheduled_at ASC NULLS LAST,p.id ASC LIMIT 5`, user.role === "contributor" ? [] : params),
    pool.query(`SELECT ${metadata},left(p.content,10000) AS "previewContent" FROM posts p
      WHERE p.type='post' AND p.status='draft' AND p.author_id=$1 ORDER BY p.updated_at DESC,p.id DESC LIMIT 4`, [user.id]),
    getSettings(),
  ]);
  const summarize = async (post: any) => ({ ...await withPermalink(post,settings), canEdit:canEditPostComments(user,post) });
  const theme = getBundledTheme(settings.theme);
  return {
    counts: counts.rows[0],
    recentPosts: await Promise.all(legacy.rows.map(summarize)),
    recentPublished: await Promise.all(published.rows.map(summarize)),
    publishingSoon: await Promise.all(scheduled.rows.map(summarize)),
    recentDrafts: await Promise.all(drafts.rows.map(async ({previewContent,...post}) => {
      const words=plainText(previewContent).trim().split(/\s+/).filter(Boolean);
      return {...await summarize(post),preview:words.slice(0,10).join(" ").slice(0,1000)+(words.length>10?"…":"")};
    })),
    recentComments: comments.rows.map(({postAuthorId,postType,postStatus,postPreTrashStatus,...comment}) => {
      if (!canEditPostComments(user,{authorId:postAuthorId,type:postType,status:postStatus,preTrashStatus:postPreTrashStatus})) {
        delete comment.authorEmail; delete comment.userId;
      }
      return comment;
    }),
    application: { name:"WorldAct", version },
    theme: { id:settings.theme, name:theme?.name || "WorldAct Classic", version:theme?.version || "1.0.0" },
  };
}
