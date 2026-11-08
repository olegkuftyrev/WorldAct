import type { PoolClient } from "pg";
import { pool } from "./db.js";
import { canModerateAllComments } from "./comment-access.js";
import { HttpError } from "./utils.js";

/** The source stores UTC seconds. Sample after actual admission lock waits. */
export async function commentAdmissionTime(db: Pick<PoolClient, "query">): Promise<Date> {
  return (await db.query("SELECT date_trunc('second',clock_timestamp()) AS time")).rows[0].time;
}

export function commentFloodInterval(last: Date, current: Date) {
  return Math.floor(current.getTime() / 1000) - Math.floor(last.getTime() / 1000) < 15;
}

/** Caller holds actor → comment hierarchy → post locks and has rechecked authentication. */
export async function assertCommentFloodAllowed(
  db: Pick<PoolClient, "query">,
  input: { actor?: { id: number; role: string }; email: string; ip: string },
  current: Date,
) {
  if (input.actor && canModerateAllComments(input.actor)) return;
  // Source deliberately includes every status/type/post and the blank-email OR.
  // A signed-in user matches account/email, never somebody else's shared IP.
  const last = (await db.query(
    `SELECT c.created_at FROM comments c WHERE c.created_at >= $3::timestamptz - interval '1 hour'
     AND (lower(c.author_email)=$1 OR c.user_id=$2::int OR ($2::int IS NULL AND EXISTS(
       SELECT 1 FROM comment_flood_metadata m WHERE m.comment_id=c.id AND m.author_ip=$4 AND m.expires_at>$3::timestamptz
     ))) ORDER BY c.created_at DESC,c.id DESC LIMIT 1`,
    [input.email.toLowerCase(), input.actor?.id ?? null, current, input.ip.slice(0, 64)],
  )).rows[0];
  if (last && commentFloodInterval(last.created_at, current))
    throw new HttpError(429, "You are posting comments too quickly. Slow down.");
}

/** Private, one-hour metadata; no profile, cookie or Akismet dependency. */
export async function recordCommentFloodMetadata(db: Pick<PoolClient, "query">, commentId: number, ip: string, current: Date) {
  await db.query("INSERT INTO comment_flood_metadata(comment_id,author_ip,expires_at) VALUES($1,$2,$3::timestamptz+interval '1 hour')", [commentId, ip.slice(0, 64), current]);
}

/** One bounded batch per scheduler tick; expired records never affect admission. */
export async function cleanupCommentFloodMetadata() {
  const db = await pool.connect();
  try {
    await db.query("BEGIN");
    await db.query("SELECT pg_advisory_xact_lock(hashtext('worldact-comment-hierarchy'))");
    const result = await db.query("DELETE FROM comment_flood_metadata WHERE comment_id IN(SELECT comment_id FROM comment_flood_metadata WHERE expires_at<=clock_timestamp() ORDER BY comment_id LIMIT 500)");
    await db.query("COMMIT");
    return result.rowCount ?? 0;
  } catch (error) { await db.query("ROLLBACK"); throw error; }
  finally { db.release(); }
}
