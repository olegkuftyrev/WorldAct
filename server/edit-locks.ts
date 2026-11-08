import {Router} from "express";
import {z} from "zod";
import {pool,getPost} from "./db.js";
import {requireRole,type AuthRequest} from "./auth.js";
import {assertPostAccess,lockPostMutationUsers} from "./core.js";
import {readEditLease} from "./edit-lease.js";
import {HttpError,needUser,parseId} from "./utils.js";
const router=Router();
router.use("/posts/:id/lock",requireRole("administrator","editor","author","contributor"));
router.get("/posts/:id/lock",async(req:AuthRequest,res)=>{
  const user=needUser(req),id=parseId(req.params.id),post=await getPost(id);
  if(!post)throw new HttpError(404,"Post not found.");assertPostAccess(user,post);
  res.json({lock:await readEditLease(id,user.id)});
});
router.put("/posts/:id/lock",async(req:AuthRequest,res)=>{
  const user=needUser(req),id=parseId(req.params.id),input=z.object({takeover:z.boolean().default(false)}).strict().parse(req.body || {}),db=await pool.connect();
  try{
    await db.query("BEGIN");
    await lockPostMutationUsers(db,user);
    if(!(await db.query("SELECT id FROM posts WHERE id=$1 FOR NO KEY UPDATE",[id])).rowCount)throw new HttpError(404,"Post not found.");
    const post=await getPost(id,db);assertPostAccess(user,post);
    const lock=await readEditLease(id,user.id,db);
    if(lock && !lock.owned && !input.takeover){await db.query("COMMIT");res.status(409).json({error:`${lock.displayName} is currently editing this post.`,lock});return;}
    await db.query("INSERT INTO post_edit_locks(post_id,user_id,expires_at) VALUES($1,$2,now()+interval '150 seconds') ON CONFLICT(post_id) DO UPDATE SET user_id=excluded.user_id,expires_at=excluded.expires_at,updated_at=now()",[id,user.id]);
    const saved=await readEditLease(id,user.id,db);await db.query("COMMIT");res.json({lock:saved});
  }catch(error){await db.query("ROLLBACK");throw error;}finally{db.release();}
});
router.delete("/posts/:id/lock",async(req:AuthRequest,res)=>{
  const user=needUser(req),id=parseId(req.params.id),post=await getPost(id);
  if(!post)throw new HttpError(404,"Post not found.");assertPostAccess(user,post);
  const result=await pool.query("DELETE FROM post_edit_locks WHERE post_id=$1 AND user_id=$2",[id,user.id]);res.json({released:!!result.rowCount});
});
export default router;
