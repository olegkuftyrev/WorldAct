import type {PoolClient} from "pg";
import {pool} from "./db.js";
import {HttpError} from "./utils.js";
type Database=Pick<PoolClient,"query">;
export async function readEditLease(postId:number,userId:number,db:Database=pool){
  const row=(await db.query('SELECT l.user_id AS "userId",u.display_name AS "displayName",l.expires_at AS "expiresAt" FROM post_edit_locks l JOIN users u ON u.id=l.user_id WHERE l.post_id=$1 AND l.expires_at>now()',[postId])).rows[0];
  return row?{...row,owned:row.userId===userId}:null;
}
/** The caller holds the post row lock, serializing this check with takeovers. */
export async function assertEditLease(db:Database,postId:number,userId:number){
  const lock=await readEditLease(postId,userId,db);
  if(lock && !lock.owned)throw new HttpError(409,`${lock.displayName} is currently editing this post. Take over the editing lock before saving.`);
}
