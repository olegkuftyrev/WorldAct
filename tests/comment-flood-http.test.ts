import test, { after } from "./isolated-test.js";
import assert from "node:assert/strict";
import { pool } from "../server/db.js";
import { approvalFixture } from "./comment-approval-fixtures.js";
after(() => pool.end());
const message = "You are posting comments too quickly. Slow down.";

test("real human flood admission rejects before preferences, filters and mail across native/API/REST", async t => {
  const f = await approvalFixture("flood-http"), post = await f.post(), ids: number[] = [];
  const age = async () => { await pool.query("UPDATE comments SET created_at=date_trunc('second',clock_timestamp())-interval '20 seconds' WHERE post_id=$1",[post.id]); };
  const counts = async () => (await pool.query("SELECT (SELECT count(*) FROM comments WHERE post_id=$1)::int AS comments,(SELECT count(*) FROM comment_flood_metadata m JOIN comments c ON c.id=m.comment_id WHERE c.post_id=$1)::int AS ips,(SELECT count(*) FROM comment_author_tokens)::int AS tokens,(SELECT count(*) FROM mail_outbox)::int AS mail",[post.id])).rows[0];
  try {
    await t.test("cold persisted history blocks a distinct request even with disabled Akismet", async () => {
      const prior = (await pool.query("INSERT INTO comments(post_id,author_name,author_email,content,status,created_at) VALUES($1,'Cold history',$2,'Other body','trash',clock_timestamp()-interval '1 second') RETURNING id",[post.id,f.stamp+"-guest@example.test"])).rows[0].id; ids.push(prior);
      const before=await counts(), result=await f.submit(post.id); assert.equal(result.response.status,429); assert.equal(result.data.error,message); assert.deepEqual(await counts(),before);
      await age();
    });
    let admitted: Awaited<ReturnType<typeof f.submit>>;
    await t.test("successful human stores private one-hour IP; distinct429 preserves its preference and mail", async () => {
      admitted=await f.submit(post.id,{content:"Remembered first body",rememberAuthor:true}); assert.equal(admitted.response.status,201,JSON.stringify(admitted.data)); ids.push(admitted.data.comment.id);
      const metadata=(await pool.query("SELECT m.author_ip,m.expires_at,c.created_at FROM comment_flood_metadata m JOIN comments c ON c.id=m.comment_id WHERE c.id=$1",[admitted.data.comment.id])).rows[0];
      assert.match(metadata.author_ip,/127\.0\.0\.1/); assert.equal(metadata.expires_at.getTime()-metadata.created_at.getTime(),3600000); assert.equal(metadata.created_at.getMilliseconds(),0);
      const cookie=admitted.response.headers.get("set-cookie")!.split(";")[0], before=await counts(), tokens=(await pool.query("SELECT * FROM comment_author_tokens WHERE comment_id=$1",[admitted.data.comment.id])).rows;
      // A configured unverified connector would hold approval and write metadata
      // if this request reached filtering; flood admission must stop first.
      await pool.query("UPDATE extensions SET enabled=true,settings='{\"sendComments\":true}'::jsonb WHERE slug='akismet'");
      await pool.query("INSERT INTO extension_secrets(slug,api_key) VALUES('akismet','unverified-flood-fixture') ON CONFLICT(slug) DO UPDATE SET api_key=excluded.api_key,verified_at=NULL");
      const result=await f.submit(post.id,{content:"Distinct rapid body",rememberAuthor:false},cookie); assert.equal(result.response.status,429); assert.equal(result.data.error,message); assert.equal(result.response.headers.get("set-cookie"),null);
      assert.deepEqual(await counts(),before); assert.deepEqual((await pool.query("SELECT * FROM comment_author_tokens WHERE comment_id=$1",[admitted.data.comment.id])).rows,tokens);
      assert.equal((await pool.query("SELECT count(*)::int AS n FROM akismet_comment_checks WHERE comment_id=ANY($1::int[])",[ids])).rows[0].n,0);
      assert.doesNotMatch(JSON.stringify(result.data),/author_ip|created_at|commentId|127\.0\.0\.1/);
      await pool.query("UPDATE extensions SET enabled=false WHERE slug='akismet'");
    });
    await t.test("duplicate remains409 before flooding and native form propagates source429", async () => {
      const duplicate=await f.submit(post.id,{content:"Remembered first body"}); assert.equal(duplicate.response.status,409); assert.match(duplicate.data.error,/Duplicate comment detected/);
      const before=await counts();
      const response=await fetch(process.env.TEST_API_URL!+"/wp-comments-post.php",{method:"POST",headers:{Origin:process.env.APP_ORIGIN!},body:new URLSearchParams({comment_post_ID:String(post.id),author:"Different native name",email:f.stamp+"-native@example.test",comment:"Native distinct body"}),redirect:"manual"});
      assert.equal(response.status,429); assert.equal((await response.json()).error,message); assert.equal(response.headers.get("location"),null); assert.equal(response.headers.get("set-cookie"),null); assert.deepEqual(await counts(),before);
      await age();
    });
    await t.test("authenticated REST uses its real current account and source error envelope", async () => {
      const subscriber=await f.account("rest-reader");
      const prior=await f.submit(post.id,{content:"REST predecessor"},subscriber.auth); assert.equal(prior.response.status,201); ids.push(prior.data.comment.id);
      const before=await counts(), response=await f.api("/wp-json/wp/v2/comments","POST",{post:post.id,content:"Distinct REST body"},subscriber.auth);
      assert.equal(response.response.status,429); assert.equal(response.data.message,message); assert.equal(response.data.data.status,429); assert.deepEqual(await counts(),before);
      await age();
    });
    await t.test("two actual requests blocked on PostgreSQL admit one distinct body and reject one429",async()=>{
      const lock=await pool.connect(); let requests:Promise<Awaited<ReturnType<typeof f.submit>>[]>|undefined;
      try {
        await lock.query("BEGIN"); await lock.query("SELECT pg_advisory_xact_lock(hashtext('worldact-comment-hierarchy'))");
        const pid=(await lock.query("SELECT pg_backend_pid() AS pid")).rows[0].pid, before=await counts();
        requests=Promise.all([f.submit(post.id,{content:"Concurrent distinct one",rememberAuthor:true}),f.submit(post.id,{content:"Concurrent distinct two",rememberAuthor:true})]);
        let blocked=false;
        for(let i=0;i<300;i++){const n=(await pool.query("SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=current_database() AND $1=ANY(pg_blocking_pids(pid)) AND query LIKE 'SELECT pg_advisory_xact_lock%'",[pid])).rows[0].n;if(n===2){blocked=true;break;}await new Promise(resolve=>setTimeout(resolve,10));}
        assert.ok(blocked,"both actual requests must wait on the shared PostgreSQL lock"); await lock.query("COMMIT");
        const responses=await requests;requests=undefined;assert.deepEqual(responses.map(r=>r.response.status).sort(),[201,429]);
        assert.equal(responses.find(r=>r.response.status===429)!.data.error,message);
        const after=await counts(); assert.equal(after.comments,before.comments+1);assert.equal(after.ips,before.ips+1);assert.equal(after.tokens,before.tokens+1);assert.equal(after.mail,before.mail+1);
        await age();
      }finally{await lock.query("ROLLBACK");await requests?.catch(()=>{});lock.release();}
    });
    await t.test("current moderator exemption is distinct from own-author approval and claimed moderator email",async()=>{
      const editor=await f.account("flood-editor","editor"), author=await f.account("flood-author","author"), own=await f.post(author.id);
      try {
        for(const auth of [f.admin,editor.auth]) for(let i=0;i<2;i++){const response=await f.submit(own.id,{content:"Moderator rapid "+auth.slice(-8)+i},auth);assert.equal(response.response.status,201,JSON.stringify(response.data));}
        const first=await f.submit(own.id,{content:"Own author first"},author.auth);assert.equal(first.response.status,201);
        const second=await f.submit(own.id,{content:"Own author rapid second"},author.auth);assert.equal(second.response.status,429);assert.equal(second.data.error,message);
        const claimed=await f.submit(own.id,{authorEmail:f.adminUser.email,content:"Claimed moderator identity"});assert.equal(claimed.response.status,429);assert.equal(claimed.data.error,message);
      }finally{await pool.query("UPDATE comments SET created_at=clock_timestamp()-interval '20 seconds' WHERE post_id=$1",[own.id]);}
    });
  } finally { await f.dispose(); }
});
