import { pool } from "./db.js";
import { createHash } from "node:crypto";
import type { Request } from "express";
import type { BlockDatabase, RenderPost, RenderOptions } from "./block-renderer.js";
import { commentReturnPath } from "../shared/comment-links.js";

export const protectedPostExcerpt = "There is no excerpt because this is a protected post.";
export const postHasPassword = (post: RenderPost) => Boolean(post.hasPassword || post.password_hash || post._passwordHash || post.passwordHash);
export const postNeedsPassword = (post: RenderPost) => post.locked !== false && Boolean(post.locked || postHasPassword(post));
export const publicPostTitle = (post: RenderPost) => (postHasPassword(post) ? "Protected: " : post.status === "private" ? "Private: " : "") + (post.title || "(no title)");
const escape = (value: unknown) => String(value ?? "").replace(/[&<>"']/g, character => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]!);

export function postPasswordForm(post: RenderPost, inputId: string, context: {requestPath?:string;query?:Record<string,unknown>} = {}) {
  let replyId=Number(context.query?.replytocom);
  if(!replyId)try{replyId=Number(new URL(context.requestPath || "/","https://worldact.invalid").searchParams.get("replytocom"));}catch{}
  const redirect=context.requestPath?commentReturnPath(context.requestPath,context.query,replyId).split("#")[0]:"";
  return `<form class="post-password-form worldact-native-password-form" action="/post-password" method="post"><p>This content is password protected. To view it please enter your password below:</p><p><label for="${escape(inputId)}">Password: <input id="${escape(inputId)}" type="password" name="password" maxlength="1024" required></label><input type="hidden" name="postSlug" value="${escape(post.slug)}">${redirect?`<input type="hidden" name="redirect_to" value="${escape(redirect)}">`:""}<button class="wp-element-button" type="submit">Enter</button></p><p class="worldact-native-password-notice" role="status"></p></form>`;
}

/** Trusted request-only grants: saved blocks and URL parameters cannot supply them. */
export function postAccessReader(req: Pick<Request, "headers">) {
  const tokens = new Map<number, string>();
  for (const part of (req.headers.cookie || "").split(";").slice(0, 200)) {
    const match = /^worldact_post_([1-9]\d{0,9})=([a-f\d]{64})$/.exec(part.trim());
    if (match && Number(match[1]) <= 2147483647 && !tokens.has(Number(match[1]))) tokens.set(Number(match[1]), createHash("sha256").update(match[2]).digest("hex"));
  }
  const read=async (postId: number, db: BlockDatabase) => {
    const hash = tokens.get(postId);
    if (!hash) return false;
    const result = await db.query("SELECT 1 FROM post_access_tokens access JOIN posts p ON p.id=access.post_id AND p.password_hash=access.password_hash WHERE access.post_id=$1 AND access.token_hash=$2 AND access.expires_at>now()", [postId, hash]);
    return Boolean(result.rowCount);
  };
  // Keep the final public policy in one statement snapshot. Only the server's
  // request closure knows token hashes; no grant stamp enters a public DTO.
  read.publicPolicy=async(postId:number,type:"post"|"page",db:BlockDatabase):Promise<PublicPostPolicy|null>=>{
    const row=(await db.query(`SELECT p.password_hash IS NOT NULL AS "hasPassword",
      p.password_hash IS NOT NULL AND NOT EXISTS(SELECT 1 FROM post_access_tokens access
        WHERE access.post_id=p.id AND access.token_hash=$3 AND access.password_hash=p.password_hash
          AND access.expires_at>clock_timestamp()) AS locked
      FROM posts p WHERE p.id=$1 AND p.type=$2 AND p.status='publish'`,[postId,type,tokens.get(postId) || null])).rows[0];
    return row || null;
  };
  return read;
}

export type PublicPostPolicy={hasPassword:boolean;locked:boolean};
/** Final metadata/access decision after asynchronous document work. Preserve a
 * supplied transaction; opaque trusted service readers get a bounded metadata
 * stability check instead of inventing request tokens. */
export async function currentPublicPostPolicy(postId:number,type:"post"|"page",reader:NonNullable<RenderOptions["canReadProtectedPost"]>,db:BlockDatabase=pool):Promise<PublicPostPolicy|null>{
  const requestReader=reader as typeof reader & {publicPolicy?:ReturnType<typeof postAccessReader>["publicPolicy"]};
  if(requestReader.publicPolicy)return requestReader.publicPolicy(postId,type,db);
  const row=(await db.query("SELECT password_hash FROM posts WHERE id=$1 AND type=$2 AND status='publish'",[postId,type])).rows[0];
  if(!row)return null;
  const locked=Boolean(row.password_hash) && !(await reader(postId,db));
  const stable=await db.query("SELECT 1 FROM posts WHERE id=$1 AND type=$2 AND status='publish' AND password_hash IS NOT DISTINCT FROM $3",[postId,type,row.password_hash]);
  return stable.rowCount?{hasPassword:Boolean(row.password_hash),locked}:null;
}

function accessToken(req: Pick<Request, "headers">, postId: number) {
  const cookie = req.headers.cookie
    ?.split(";")
    .map((value) => value.trim())
    .find((value) => value.startsWith(`worldact_post_${postId}=`));
  const token = cookie?.slice(`worldact_post_${postId}=`.length);
  return token && /^[a-f\d]{64}$/.test(token) ? token : null;
}
export async function hasPostAccess(
  req: Pick<Request, "headers">,
  postId: number,
  passwordHash: string | null,
) {
  if (!passwordHash) return true;
  const token = accessToken(req, postId);
  if (!token) return false;
  const access = await pool.query(
    "SELECT 1 FROM post_access_tokens WHERE token_hash=$1 AND post_id=$2 AND password_hash=$3 AND expires_at>now()",
    [createHash("sha256").update(token).digest("hex"), postId, passwordHash],
  );
  return !!access.rowCount;
}
