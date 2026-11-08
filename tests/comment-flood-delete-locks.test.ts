import test, { after } from "./isolated-test.js";
import assert from "node:assert/strict";
import { pool } from "../server/db.js";
import { approvalFixture } from "./comment-approval-fixtures.js";
import { recordCommentFloodMetadata } from "../server/comment-flood.js";
after(() => pool.end());
async function waitingOn(pid:number,pattern:string){
  for(let i=0;i<300;i++){
    const rows=await pool.query("WITH RECURSIVE waiting(pid) AS(SELECT $1::int UNION SELECT a.pid FROM pg_stat_activity a JOIN waiting w ON w.pid=ANY(pg_blocking_pids(a.pid)) WHERE a.datname=current_database()) SELECT a.pid FROM pg_stat_activity a JOIN waiting w ON w.pid=a.pid WHERE a.pid<>$1 AND a.query ~ $2",[pid,pattern]);
    if(rows.rowCount)return;await new Promise(resolve=>setTimeout(resolve,10));
  }assert.fail("Actual pending operation did not reach "+pattern);
}

test("permanent post cascade and IP erasure cannot invert comment/metadata row locks",{timeout:60000},async t=>{
  const f=await approvalFixture("flood-delete-locks"),requests:number[]=[];
  try{
    for(const operation of ["post","account"] as const)for(const first of ["post","erasure"] as const)await t.test(operation+": "+first+" takes its actual first row lock before the other request",async()=>{
      const owner=operation==="account"?await f.account("delete-owner-"+first,"author"):undefined;
      const post=await f.post(owner?.id),second=operation==="account"?await f.post(owner!.id):undefined,email=f.stamp+"-"+operation+"-"+first+"@example.test";
      const commentIds:number[]=[];
      // Interleave comment IDs across two posts rather than accidentally
      // proving one global comment-ID order for a multi-post account cascade.
      for(const postId of second?[second.id,post.id,second.id]:[post.id]){
        const id=(await pool.query("INSERT INTO comments(post_id,author_name,author_email,content,status) VALUES($1,'Delete lock reader',$2,'Delete lock body','approved') RETURNING id",[postId,email])).rows[0].id;
        commentIds.push(id);await recordCommentFloodMetadata(pool,id,"192.0.2.231",new Date());
      }
      const comment=commentIds[second?1:0];
      if(operation==="post")await f.ok(`/api/posts/${post.id}`,"PUT",{status:"trash"});
      const request=(await f.ok("/api/tools/privacy/requests","POST",{email,type:"erase",sendConfirmation:false})).request.id;requests.push(request);
      const lock=await pool.connect();let deletion:ReturnType<typeof f.api>|undefined,erasure:ReturnType<typeof f.api>|undefined;
      const before=Number((await pool.query("SELECT deadlocks FROM pg_stat_database WHERE datname=current_database()")).rows[0].deadlocks);
      try{
        // Pause only after the real DELETE has acquired its first row lock.
        const table=first==="post"?"comments":"comment_flood_metadata",field=first==="post"?"id":"comment_id";
        await pool.query(`CREATE FUNCTION flood_delete_gate() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF OLD.${field}=${comment} THEN PERFORM pg_advisory_xact_lock(hashtext('worldact-flood-delete-gate')); END IF; RETURN OLD; END $$`);
        await pool.query(`CREATE TRIGGER flood_delete_gate BEFORE DELETE ON ${table} FOR EACH ROW EXECUTE FUNCTION flood_delete_gate()`);
        await lock.query("BEGIN");await lock.query("SELECT pg_advisory_xact_lock(hashtext('worldact-flood-delete-gate'))");const pid=(await lock.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
        if(first==="post"){
          deletion=f.api(operation==="post"?`/api/posts/${post.id}`:`/api/users/${owner!.id}?deleteContent=true`,"DELETE");await waitingOn(pid,"DELETE FROM posts");
          erasure=f.api(`/api/tools/privacy/requests/${request}/erase`,"POST",{});await waitingOn(pid,"comments|worldact-page-hierarchy");
        }else{
          erasure=f.api(`/api/tools/privacy/requests/${request}/erase`,"POST",{});await waitingOn(pid,"DELETE FROM comment_flood_metadata");
          deletion=f.api(operation==="post"?`/api/posts/${post.id}`:`/api/users/${owner!.id}?deleteContent=true`,"DELETE");await waitingOn(pid,"DELETE FROM posts|worldact-page-hierarchy");
        }
        await lock.query("COMMIT");const results=await Promise.all([deletion,erasure]);deletion=undefined;erasure=undefined;
        const deadlocks=Number((await pool.query("SELECT deadlocks FROM pg_stat_database WHERE datname=current_database()")).rows[0].deadlocks)-before;
        assert.deepEqual(results.map(result=>result.response.status),[200,200],JSON.stringify({responses:results.map(result=>result.data),deadlocks}));
        assert.equal(deadlocks,0);
        assert.equal((await pool.query("SELECT count(*)::int AS n FROM comment_flood_metadata WHERE comment_id=ANY($1::int[])",[commentIds])).rows[0].n,0);
        assert.equal((await pool.query("SELECT count(*)::int AS n FROM comments WHERE id=ANY($1::int[])",[commentIds])).rows[0].n,0);
      }finally{
        await lock.query("ROLLBACK");await deletion?.catch(()=>{});await erasure?.catch(()=>{});lock.release();
        await pool.query("DROP TRIGGER IF EXISTS flood_delete_gate ON comments");await pool.query("DROP TRIGGER IF EXISTS flood_delete_gate ON comment_flood_metadata");await pool.query("DROP FUNCTION IF EXISTS flood_delete_gate()");
      }
    });
  }finally{await pool.query("DELETE FROM privacy_requests WHERE id=ANY($1::int[])",[requests]);await f.dispose();}
});
