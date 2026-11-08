import test, { after } from "./isolated-test.js";
import assert from "node:assert/strict";
import { pool } from "../server/db.js";
import { approvalFixture } from "./comment-approval-fixtures.js";
after(() => pool.end());

async function blocked(pid:number,pattern:string){
  for(let i=0;i<300;i++){
    if((await pool.query("SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND $1=ANY(pg_blocking_pids(pid)) AND position($2 in query)>0",[pid,pattern])).rowCount)return;
    await new Promise(resolve=>setTimeout(resolve,10));
  }assert.fail("Real HTTP request did not wait for "+pattern);
}

test("flood exemption and admitted UTC time use current actor and actual completed waits",async t=>{
  const f=await approvalFixture("flood-waits"),post=await f.post();
  try{
    for(const [oldRole,nextRole,expected] of [["editor","subscriber",429],["subscriber","editor",201]] as const){
      await t.test(`${oldRole} becomes ${nextRole} during actual actor-row wait`,async()=>{
        const actor=await f.account(oldRole+"-to-"+nextRole,oldRole), lock=await pool.connect();let request:ReturnType<typeof f.submit>|undefined;
        await pool.query("INSERT INTO comments(post_id,author_name,author_email,user_id,content,status) VALUES($1,$2,$3,$4,'Prior for live role','pending')",[post.id,actor.displayName,actor.email,actor.id]);
        try{
          await lock.query("BEGIN");await lock.query("SELECT id FROM users WHERE id=$1 FOR NO KEY UPDATE",[actor.id]);const pid=(await lock.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
          request=f.submit(post.id,{content:"Role changed actual request"},actor.auth);await blocked(pid,"FROM users WHERE id=$1 FOR SHARE");
          await lock.query("UPDATE users SET role=$2 WHERE id=$1",[actor.id,nextRole]);await lock.query("COMMIT");
          const response=await request;request=undefined;assert.equal(response.response.status,expected,JSON.stringify(response.data));
          if(expected===429)assert.equal(response.data.error,"You are posting comments too quickly. Slow down.");
        }finally{await lock.query("ROLLBACK");await request?.catch(()=>{});lock.release();}
      });
    }
    await t.test("revoked real moderator session is401 before any exemption or side effect",async()=>{
      const actor=await f.account("revoked-editor","editor"),lock=await pool.connect();let request:ReturnType<typeof f.submit>|undefined;
      try{
        await lock.query("BEGIN");await lock.query("SELECT pg_advisory_xact_lock(hashtext('worldact-comment-hierarchy'))");const pid=(await lock.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
        const before=(await pool.query("SELECT count(*)::int AS n FROM comments WHERE post_id=$1",[post.id])).rows[0].n;
        request=f.submit(post.id,{content:"Revoked moderator cannot bypass"},actor.auth);await blocked(pid,"worldact-comment-hierarchy");
        assert.equal((await f.api("/api/auth/logout","POST",undefined,actor.auth)).response.status,200);
        await lock.query("COMMIT");const response=await request;request=undefined;assert.equal(response.response.status,401);
        assert.equal((await pool.query("SELECT count(*)::int AS n FROM comments WHERE post_id=$1",[post.id])).rows[0].n,before);
      }finally{await lock.query("ROLLBACK");await request?.catch(()=>{});lock.release();}
    });
    await t.test("post wait inserts the sampled release-second rather than transaction-start now",async()=>{
      const actor=await f.account("post-wait-reader"),lock=await pool.connect();let request:ReturnType<typeof f.submit>|undefined;
      try{
        await lock.query("BEGIN");await lock.query("SELECT id FROM posts WHERE id=$1 FOR NO KEY UPDATE",[post.id]);const pid=(await lock.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
        request=f.submit(post.id,{content:"Timestamp after actual post wait"},actor.auth);await blocked(pid,"FROM posts WHERE id=$1 FOR SHARE");
        const start=(await pool.query("SELECT xact_start FROM pg_stat_activity WHERE datname=current_database() AND $1=ANY(pg_blocking_pids(pid)) AND query LIKE '%FROM posts WHERE id=$1 FOR SHARE%'",[pid])).rows[0].xact_start as Date;
        let sampled:Date;
        do{sampled=(await pool.query("SELECT date_trunc('second',clock_timestamp()) AS time")).rows[0].time;if(sampled.getTime()>start.getTime())break;await new Promise(resolve=>setTimeout(resolve,10));}while(true);
        await lock.query("COMMIT");const response=await request;request=undefined;assert.equal(response.response.status,201,JSON.stringify(response.data));
        const row=(await pool.query("SELECT c.created_at,m.expires_at FROM comments c JOIN comment_flood_metadata m ON m.comment_id=c.id WHERE c.id=$1",[response.data.comment.id])).rows[0];
        assert.ok(row.created_at.getTime()>=sampled.getTime());assert.equal(row.created_at.getMilliseconds(),0);assert.equal(row.expires_at.getTime()-row.created_at.getTime(),3600000);
      }finally{await lock.query("ROLLBACK");await request?.catch(()=>{});lock.release();}
    });
  }finally{await f.dispose();}
});
