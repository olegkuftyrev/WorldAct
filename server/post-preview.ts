import { pool } from "./db.js";

/** Preview only the requesting editor's current, atomic autosave snapshot. */
export async function withPreviewAutosave<T extends { id: number; version: number }>(post: T, userId: number): Promise<T> {
  const saved = (await pool.query(
    `SELECT title,content,raw_content AS "rawContent",excerpt,blocks,footnotes
     FROM post_autosaves WHERE post_id=$1 AND user_id=$2 AND version=$3`,
    [post.id, userId, post.version],
  )).rows[0];
  return saved ? { ...post, ...saved } : post;
}
