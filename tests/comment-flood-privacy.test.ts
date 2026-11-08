import test, { after } from "./isolated-test.js";
import assert from "node:assert/strict";
import { pool } from "../server/db.js";
import { approvalFixture } from "./comment-approval-fixtures.js";
import { recordCommentFloodMetadata } from "../server/comment-flood.js";
after(() => pool.end());

async function blocked(pid:number, pattern:string){
  for(let i=0;i<300;i++){
    const rows=await pool.query("WITH RECURSIVE waiting(pid) AS(SELECT $1::int UNION SELECT a.pid FROM pg_stat_activity a JOIN waiting w ON w.pid=ANY(pg_blocking_pids(a.pid)) WHERE a.datname=current_database()) SELECT a.pid FROM pg_stat_activity a JOIN waiting w ON w.pid=a.pid WHERE a.pid<>$1 AND position($2 in a.query)>0",[pid,pattern]);
    if(rows.rowCount)return; await new Promise(resolve=>setTimeout(resolve,10));
  }assert.fail("Actual request did not wait: "+pattern);
}

test("private flood IP exports, erasure and actual pending-admission fence",{timeout:60000},async t=>{
  const f=await approvalFixture("flood-privacy"), post=await f.post(), account=await f.account("private-reader"), requests:number[]=[];
  const own:number[]=[],other:number[]=[];
  async function comment(email:string,userId:number|null=null,expired=false){
    const id=(await pool.query("INSERT INTO comments(post_id,author_name,author_email,user_id,content,status) VALUES($1,'Private reader',$2,$3,'Retained body','approved') RETURNING id",[post.id,email,userId])).rows[0].id;
    await recordCommentFloodMetadata(pool,id,"192.0.2.241",new Date(Date.now()-(expired?7200000:0)));return id;
  }
  async function request(email:string,type:"export"|"erase"){
    const result=await f.ok("/api/tools/privacy/requests","POST",{email,type,sendConfirmation:false});requests.push(result.request.id);return result.request.id;
  }
  try{
    own.push(await comment(account.email,account.id),await comment("old-"+account.email,account.id),await comment(account.email,null,true));
    other.push(await comment("unrelated-"+account.email));
    let exportId:number;
    await t.test("confirmed personal export contains only matching unexpired IP metadata and policy explains actual retention",async()=>{
      exportId=await request(account.email,"export");const result=await f.ok(`/api/tools/privacy/requests/${exportId}/export`,"POST",{});
      const downloaded=await f.ok(`/api/tools/privacy/requests/${exportId}/download`);
      assert.deepEqual(downloaded.commentFloodMetadata.map((row:any)=>row.commentId),own.slice(0,2));
      assert.ok(downloaded.commentFloodMetadata.every((row:any)=>row.authorIP==="192.0.2.241"&&Date.parse(row.expiresAt)>Date.now()));
      assert.ok(downloaded.scope.some((value:string)=>/flood-prevention IP/.test(value)));assert.ok(result.downloadUrl);
      const guide=await f.ok("/api/tools/privacy/policy-guide");assert.match(JSON.stringify(guide),/expires after one hour/);assert.match(JSON.stringify(guide),/offline/);
    });
    await t.test("public/admin comments, WXR and site archive never include the private side table",async()=>{
      const publicPost=await f.ok(`/api/public/posts/${post.slug}`,"GET",undefined,"");
      const adminComments=await f.ok(`/api/comments?postId=${post.id}`),rest=await f.ok(`/wp-json/wp/v2/comments?post=${post.id}`),archive=await f.ok("/api/tools/export");
      const wxr=await fetch(process.env.TEST_API_URL!+"/api/tools/export?format=wxr",{headers:{Cookie:f.admin}});
      // Verify the real supported XML route rather than accepting an error body.
      assert.equal(wxr.status,200);const xml=await wxr.text();assert.match(xml,/<rss/);
      for(const data of [publicPost,adminComments,rest,archive,xml])assert.doesNotMatch(typeof data==="string"?data:JSON.stringify(data),/192\.0\.2\.241|comment_flood_metadata|commentFloodMetadata|author_ip/);
    });
    await t.test("erasure removes active AND expired own IPs, keeps unrelated same-IP records and revokes snapshots",async()=>{
      const eraseId=await request(account.email,"erase"),result=await f.ok(`/api/tools/privacy/requests/${eraseId}/erase`,"POST",{});
      assert.equal(result.result.commentsAnonymized,3);assert.equal(result.result.commentFloodMetadataRemoved,3);assert.ok(result.result.exportsRevoked>=1);
      assert.equal((await pool.query("SELECT count(*)::int AS n FROM comment_flood_metadata WHERE comment_id=ANY($1::int[])",[own])).rows[0].n,0);
      assert.equal((await pool.query("SELECT count(*)::int AS n FROM comment_flood_metadata WHERE comment_id=ANY($1::int[])",[other])).rows[0].n,1);
      assert.equal((await f.api(`/api/tools/privacy/requests/${exportId}/download`)).response.status,404);
      assert.deepEqual((await pool.query("SELECT DISTINCT author_name,author_email,user_id,content,status FROM comments WHERE id=ANY($1::int[])",[own])).rows,[{author_name:"Anonymous",author_email:"",user_id:null,content:"Retained body",status:"approved"}]);
    });
    await t.test("erasure waits for actual in-flight comment+IP commit before anonymizing",async()=>{
      const email=f.stamp+"-race@example.test",eraseId=await request(email,"erase"),lock=await pool.connect();
      let admission:ReturnType<typeof f.submit>|undefined,erasure:ReturnType<typeof f.api>|undefined;
      try{
        await pool.query(`CREATE FUNCTION flood_private_gate() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.author_email='${email}' THEN PERFORM pg_advisory_xact_lock(hashtext('worldact-flood-private-insert')); END IF; RETURN NEW; END $$`);
        await pool.query("CREATE TRIGGER flood_private_gate BEFORE INSERT ON comments FOR EACH ROW EXECUTE FUNCTION flood_private_gate()");
        await lock.query("BEGIN");await lock.query("SELECT pg_advisory_xact_lock(hashtext('worldact-flood-private-insert'))");const pid=(await lock.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
        admission=f.submit(post.id,{authorEmail:email,content:"Actual erasure race body"});await blocked(pid,"INSERT INTO comments");
        erasure=f.api(`/api/tools/privacy/requests/${eraseId}/erase`,"POST",{});await blocked(pid,"worldact-comment-hierarchy");
        await lock.query("COMMIT");const admitted=await admission;admission=undefined;assert.equal(admitted.response.status,201,JSON.stringify(admitted.data));
        const erased=await erasure;erasure=undefined;assert.equal(erased.response.status,200,JSON.stringify(erased.data));assert.equal(erased.data.result.commentFloodMetadataRemoved,1);
        const row=(await pool.query("SELECT author_name,author_email,user_id FROM comments WHERE id=$1",[admitted.data.comment.id])).rows[0];assert.deepEqual(row,{author_name:"Anonymous",author_email:"",user_id:null});
        assert.equal((await pool.query("SELECT count(*)::int AS n FROM comment_flood_metadata WHERE comment_id=$1",[admitted.data.comment.id])).rows[0].n,0);
        const repeated=await f.ok(`/api/tools/privacy/requests/${eraseId}/erase`,"POST",{});assert.deepEqual(repeated.result,erased.data.result);
      }finally{await lock.query("ROLLBACK");await admission?.catch(()=>{});await erasure?.catch(()=>{});lock.release();await pool.query("DROP TRIGGER IF EXISTS flood_private_gate ON comments");await pool.query("DROP FUNCTION IF EXISTS flood_private_gate()");}
    });
    await t.test("retained-content account deletion preserves submitted-email/IP history until expiry",async()=>{
      const retained=await f.account("deleted-reader"),id=await comment(retained.email,retained.id);
      const before=(await pool.query("SELECT author_ip,expires_at FROM comment_flood_metadata WHERE comment_id=$1",[id])).rows[0];
      await f.ok(`/api/users/${retained.id}`,"DELETE");
      assert.deepEqual((await pool.query("SELECT author_email,user_id FROM comments WHERE id=$1",[id])).rows[0],{author_email:retained.email,user_id:null});
      assert.deepEqual((await pool.query("SELECT author_ip,expires_at FROM comment_flood_metadata WHERE comment_id=$1",[id])).rows[0],before);
    });
  }finally{await pool.query("DELETE FROM privacy_requests WHERE id=ANY($1::int[])",[requests]);await f.dispose();}
});
