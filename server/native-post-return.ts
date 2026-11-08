import { pool, getSettings, postMetadataFields } from "./db.js";
import { postPermalink } from "./permalinks.js";
import { resolvePublicDocumentRoute } from "./public-documents.js";
import { parseDateArchiveQuery } from "./date-archives.js";
import { normalizeLoginRedirect } from "../shared/login-redirect.js";
import { normalizePublicQuery, PublicQueryError } from "../shared/public-routing.js";
import { HttpError } from "./utils.js";

type Settings = Awaited<ReturnType<typeof getSettings>>;

/** Page identity follows chronological roots even when their display is reversed.
 * No content, email or grant is needed to locate an approved saved comment. */
export async function nativeCommentPage(postId: number, commentId: number, settings: Settings): Promise<number | null> {
  if (!settings.paginateComments) return null;
  const rows = (await pool.query(`WITH RECURSIVE ancestry AS (
    SELECT id,parent_id,created_at FROM comments WHERE id=$2 AND post_id=$1 AND status='approved'
    UNION
    SELECT parent.id,parent.parent_id,parent.created_at FROM comments parent
    JOIN ancestry child ON parent.id=child.parent_id
    WHERE $3::boolean AND parent.post_id=$1 AND parent.status='approved'
  ), selected AS (
    SELECT id,created_at FROM ancestry
    WHERE (NOT $3::boolean AND id=$2) OR ($3::boolean AND parent_id IS NULL)
    LIMIT 1
  ) SELECT ceil(count(*)::numeric / $4::int)::int AS page
  FROM comments c CROSS JOIN selected root
  WHERE c.post_id=$1 AND c.status='approved' AND (NOT $3::boolean OR c.parent_id IS NULL)
    AND (c.created_at,c.id)<=(root.created_at,root.id)
  GROUP BY root.id`, [postId, commentId, settings.threadComments, settings.commentsPerPage])).rows;
  return rows[0]?.page || null;
}

/** Only a current public route for this immutable post can supply continuation
 * state. Invalid explicit input never falls through to an unrelated Referer. */
export async function nativePostReturn(postId: number, requested: unknown, referer: unknown, options: {
  comment?: { id: number; status: string };
} = {}): Promise<string> {
  const post = (await pool.query(`SELECT ${postMetadataFields} FROM posts p
    WHERE p.id=$1 AND p.type IN ('post','page') AND p.status='publish'`, [postId])).rows[0];
  if (!post) throw new HttpError(404, "Post not found.");
  const settings = await getSettings(), origin = new URL(process.env.APP_ORIGIN || "http://127.0.0.1:5173").origin;
  let url = new URL(await postPermalink(post, settings), origin);
  const local = normalizeLoginRedirect(requested === undefined ? referer : requested, origin);
  if (local) {
    const candidate = new URL(local, origin);
    try {
      const resolved = await resolvePublicDocumentRoute(candidate.pathname + candidate.search);
      if (resolved.status === 200 && resolved.selectedId === post.id && resolved.selectedType === post.type &&
          (resolved.kind === "singular" || resolved.kind === "front-page")) {
        const query = normalizePublicQuery(candidate.searchParams, { singular: true, contentPage: resolved.contentPage });
        parseDateArchiveQuery(query.values);
        const params = new URLSearchParams();
        for (const key of ["p", "page_id"]) if (candidate.searchParams.has(key)) params.set(key, candidate.searchParams.get(key)!);
        for (const [key, value] of Object.entries(query.values)) {
          if (key === "replytocom" && (options.comment || !/^[1-9]\d{0,9}$/.test(value) || Number(value) > 2147483647)) continue;
          params.set(key, value);
        }
        url = new URL(candidate.pathname + (params.size ? "?" + params : ""), origin);
      }
    } catch (error) {
      // Malformed continuation is a safe canonical fallback. Database failures
      // still fail normally instead of being mistaken for malformed user input.
      if (!(error instanceof PublicQueryError || error instanceof URIError || error instanceof HttpError && [400, 414].includes(error.status))) throw error;
    }
  }
  const comment = options.comment;
  if (comment) {
    url.searchParams.delete("replytocom");
    if (comment.status === "approved") {
      const page = await nativeCommentPage(post.id, comment.id, settings);
      if (page) url.searchParams.set("commentPage", String(page));
      url.hash = "comment-" + comment.id;
    } else {
      url.searchParams.set("comment-status", "pending");
      url.hash = "respond";
    }
  }
  // Continuation resolution and chronological comment paging can await more
  // database work after canonical generation. Fence the immutable selection at
  // the final metadata boundary too; no body or password is needed here.
  try{
    if(!(await pool.query("SELECT 1 FROM posts WHERE id=$1 AND type=$2 AND status='publish' AND author_id=$3 AND post_date=$4 FOR SHARE NOWAIT",[post.id,post.type,post.authorId,post.postDate])).rowCount)
      throw new HttpError(404,"Post not found.");
  }catch(error){if(["55P03","40001"].includes((error as {code?:string}).code || ""))throw new HttpError(409,"The post publication changed while its return path was being read. Reload to continue.");throw error;}
  return url.pathname + url.search + url.hash;
}
