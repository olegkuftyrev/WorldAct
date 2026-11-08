import test, { after } from "./isolated-test.js";
import assert from "node:assert/strict";
import express from "express";
import { createServer } from "node:http";
import { pool } from "../server/db.js";
import compatRouter from "../server/compat.js";
import { submitPublicComment } from "../server/core.js";
import { approvalFixture } from "./comment-approval-fixtures.js";
after(() => pool.end());

test("REST in-process adapter retains a genuine IPv6 loopback request address and actual sign-in",async()=>{
  const f=await approvalFixture("flood-rest-ip"),post=await f.post(),reader=await f.account("ipv6-reader");
  // A separate disposable server binds only the existing IPv6 loopback; no
  // aliases, interfaces, proxy trust, external sockets or forwarded IP headers.
  const app=express();app.use(express.json());app.use(compatRouter);app.post("/api/public/comments",submitPublicComment);
  app.use((error:any,_req:any,res:any,_next:any)=>res.status(error.status??500).json({error:error.message}));
  const server=createServer(app);await new Promise<void>((resolve,reject)=>{server.once("error",reject);server.listen(0,"::1",resolve);});
  const base=`http://[::1]:${(server.address() as {port:number}).port}`;
  try{
    const first=await fetch(base+"/wp-json/wp/v2/comments",{method:"POST",headers:{Origin:process.env.APP_ORIGIN!,Cookie:reader.auth,"Content-Type":"application/json"},body:JSON.stringify({post:post.id,content:"Actual IPv6 REST comment"})});
    const comment=await first.json();assert.equal(first.status,201,JSON.stringify(comment));
    const stored=(await pool.query("SELECT m.author_ip,c.user_id FROM comment_flood_metadata m JOIN comments c ON c.id=m.comment_id WHERE c.id=$1",[comment.id])).rows[0];assert.deepEqual(stored,{author_ip:"::1",user_id:reader.id});
    const guest=await fetch(base+"/api/public/comments",{method:"POST",headers:{Origin:process.env.APP_ORIGIN!,"Content-Type":"application/json"},body:JSON.stringify({postId:post.id,authorName:"Other visitor",authorEmail:"ipv6-guest@example.test",content:"Different IPv6 guest body"})});
    assert.equal(guest.status,429);assert.equal((await guest.json()).error,"You are posting comments too quickly. Slow down.");
    const rest=await fetch(base+"/wp-json/wp/v2/comments",{method:"POST",headers:{Origin:process.env.APP_ORIGIN!,Cookie:reader.auth,"Content-Type":"application/json"},body:JSON.stringify({post:post.id,content:"Actual IPv6 REST comment"})});
    const duplicate=await rest.json();assert.equal(rest.status,409);assert.equal(duplicate.data.status,409);assert.match(duplicate.message,/Duplicate comment/);
    // The guarded API is another actual Node process. Matching email makes
    // these distinct IPv4/IPv6 requests one source identity without spoofing IP.
    await pool.query("UPDATE comments SET created_at=clock_timestamp()-interval '20 seconds' WHERE post_id=$1",[post.id]);
    const lock=await pool.connect();let concurrent:Promise<any[]>|undefined;
    try{
      await lock.query("BEGIN");await lock.query("SELECT pg_advisory_xact_lock(hashtext('worldact-comment-hierarchy'))");const pid=(await lock.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
      concurrent=Promise.all([
        f.submit(post.id,{authorEmail:f.stamp+"-cross-process@example.test",content:"Guarded process distinct body"}),
        fetch(base+"/api/public/comments",{method:"POST",headers:{Origin:process.env.APP_ORIGIN!,"Content-Type":"application/json"},body:JSON.stringify({postId:post.id,authorName:"Other process",authorEmail:f.stamp+"-cross-process@example.test",content:"IPv6 process distinct body"})}).then(async response=>({response,data:await response.json()})),
      ]);
      let blocked=false;
      for(let i=0;i<300;i++){
        const n=(await pool.query("SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=current_database() AND $1=ANY(pg_blocking_pids(pid)) AND query LIKE 'SELECT pg_advisory_xact_lock%'",[pid])).rows[0].n;
        if(n===2){blocked=true;break;}await new Promise(resolve=>setTimeout(resolve,10));
      }
      assert.ok(blocked,"both independent Node processes must wait on the same database lock");await lock.query("COMMIT");
      const responses=await concurrent;concurrent=undefined;assert.deepEqual(responses.map(row=>row.response.status).sort(),[201,429]);assert.equal(responses.find(row=>row.response.status===429).data.error,"You are posting comments too quickly. Slow down.");
      assert.equal((await pool.query("SELECT count(*)::int AS n FROM comments WHERE post_id=$1 AND author_email=$2",[post.id,f.stamp+"-cross-process@example.test"])).rows[0].n,1);
    }finally{await lock.query("ROLLBACK");await concurrent?.catch(()=>{});lock.release();}
  }finally{await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));await f.dispose();}
});
