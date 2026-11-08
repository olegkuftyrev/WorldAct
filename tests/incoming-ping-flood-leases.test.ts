import test, { after } from "./isolated-test.js";
import assert from "node:assert/strict";
import { pool, getSettings } from "../server/db.js";
import { approvalFixture } from "./comment-approval-fixtures.js";
import { createIncomingPings, IncomingPingError } from "../server/incoming-pings.js";
import { createAkismetClient } from "../server/bundled-plugins.js";
after(() => pool.end());

// Independent service probes execute source imports in either guarded main-server mode.
test("independent incoming lease-row waits, future predecessor and late precheck duplicate", async t => {
 const f=await approvalFixture("independent-incoming-lease"),post=await f.post(),other=await f.post();
 const site=(await getSettings()).siteUrl,target=new URL(post.permalink,site).href;
 await f.ok("/api/settings","PUT",{requireCommentNameEmail:false});
 let sequence=0,filter: (()=>Promise<void>)|undefined,verifier: (()=>Promise<void>)|undefined,filters=0;
 const receive=createIncomingPings({environment:()=>"production",http:async url=>{if(verifier)await verifier();return{url,status:200,headers:{},body:Buffer.from(`<title>Owned verifier</title><a href="${target}">Target</a>`)};},akismet:createAkismetClient((async()=>{filters++;if(filter)await filter();return new Response("false");}) as typeof fetch)});
 const input=()=>({type:"trackback" as "trackback"|"pingback",source:`https://independent.example.test/${f.stamp}/${++sequence}`,target,title:"Lease probe",ip:"192.0.2.218"});
 const counts=async()=>(await pool.query("SELECT(SELECT count(*) FROM comments)::int AS comments,(SELECT count(*) FROM comment_flood_metadata)::int AS ips,(SELECT count(*) FROM akismet_comment_checks)::int AS checks,(SELECT count(*) FROM mail_outbox)::int AS mail")).rows[0];
 const refused=(error:unknown)=>error instanceof IncomingPingError&&error.code===0;
 async function clear(){filter=undefined;verifier=undefined;await pool.query("DELETE FROM comments WHERE post_id=ANY($1::int[])",[[post.id,other.id]]);await pool.query("DELETE FROM incoming_ping_leases");await pool.query("DELETE FROM incoming_ping_rates");await pool.query("DELETE FROM mail_outbox WHERE subject LIKE $1",["%"+f.stamp+"%"]);await pool.query("UPDATE extensions SET enabled=false WHERE slug='akismet'");await pool.query("DELETE FROM extension_secrets WHERE slug='akismet'");}
 async function active(){await pool.query("UPDATE extensions SET enabled=true,settings='{\"sendComments\":true}' WHERE slug='akismet'");await pool.query("INSERT INTO extension_secrets(slug,api_key,verified_site_url,verified_at,last_error_code)VALUES('akismet','controlledIndependentLeaseKey',$1,clock_timestamp(),'original-owned-marker')",[new URL(site).href]);}
 async function blocked(pid:number){for(let i=0;i<400;i++){const r=await pool.query("SELECT xact_start FROM pg_stat_activity WHERE datname=current_database() AND $1=ANY(pg_blocking_pids(pid)) AND position('FROM incoming_ping_leases WHERE token=$1 AND expires_at>clock_timestamp() FOR UPDATE' in query)>0",[pid]);if(r.rowCount===1)return r.rows[0].xact_start as Date;await new Promise(r=>setTimeout(r,10));}assert.fail("actual final lease row wait was not observed");}
 async function run(name:string,fn:()=>Promise<void>){await t.test(name,async()=>{await clear();try{await fn();}finally{await clear();}});}
 try{
  await run("future blank-email predecessor on another post blocks before Akismet",async()=>{await active();await pool.query("INSERT INTO comments(post_id,author_name,author_email,content,status,created_at)VALUES($1,'Future owned prior','','Different body','trash',clock_timestamp()+interval '1 hour')",[other.id]);const before=await counts(),calls=filters;await assert.rejects(receive(input()),refused);assert.deepEqual(await counts(),before);assert.equal(filters,calls);assert.equal((await pool.query("SELECT last_error_code FROM extension_secrets WHERE slug='akismet'")).rows[0].last_error_code,"original-owned-marker");assert.equal((await pool.query("SELECT count(*)::int AS n FROM incoming_ping_leases")).rows[0].n,0);});
  await run("duplicate inserted while real verification is held wins48 at precheck without Akismet",async()=>{await active();let entered!:()=>void,release!:()=>void;const started=new Promise<void>(r=>entered=r),held=new Promise<void>(r=>release=r);verifier=async()=>{entered();await held;};const request={...input(),type:"pingback" as const},pending=receive(request);const rejected=assert.rejects(pending,e=>e instanceof IncomingPingError&&e.code===48);try{await started;await pool.query("INSERT INTO comments(post_id,author_name,author_email,author_url,content,status)VALUES($1,'Late same URL','',$2,'Other body','approved')",[post.id,request.source]);const before=await counts(),calls=filters;release();await rejected;assert.deepEqual(await counts(),before);assert.equal(filters,calls);assert.equal((await pool.query("SELECT count(*)::int AS n FROM incoming_ping_leases")).rows[0].n,0);}finally{release();await pending.catch(()=>{});}});
  for(const mode of ["accept","expire","new-predecessor"] as const)await run(`actual lease-row wait ${mode} uses fresh final admission`,async()=>{
   await active();let entered!:()=>void,release!:()=>void;const started=new Promise<void>(r=>entered=r),held=new Promise<void>(r=>release=r);filter=async()=>{entered();await held;};const request=input(),pending=receive(request);const observed=pending.then(()=>({ok:true,error:undefined as unknown}),error=>({ok:false,error}));const lock=await pool.connect();
   try{await started;await lock.query("BEGIN");const lease=(await lock.query("SELECT token FROM incoming_ping_leases FOR UPDATE")).rows;assert.equal(lease.length,1);const pid=(await lock.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;release();const start=await blocked(pid);let sampled:Date;for(;;){sampled=(await pool.query("SELECT date_trunc('second',clock_timestamp())AS at")).rows[0].at;if(sampled.getTime()>start.getTime())break;await new Promise(r=>setTimeout(r,10));}
    if(mode==="expire")await lock.query("UPDATE incoming_ping_leases SET expires_at=clock_timestamp()-interval '1 second' WHERE token=$1",[lease[0].token]);
    if(mode==="new-predecessor")await pool.query("INSERT INTO comments(post_id,author_name,author_email,content,status,created_at)VALUES($1,'Prior during lease wait','','Different body','spam',date_trunc('second',clock_timestamp()))",[other.id]);
    const before=await counts();await lock.query("COMMIT");const result=await observed;
    if(mode==="accept"){assert.equal(result.ok,true,String(result.error));const row=(await pool.query("SELECT c.created_at,c.updated_at,m.expires_at,m.author_ip FROM comments c JOIN comment_flood_metadata m ON m.comment_id=c.id WHERE c.post_id=$1 AND c.author_url=$2",[post.id,request.source])).rows[0];assert.ok(row.created_at.getTime()>=sampled.getTime());assert.equal(row.created_at.getTime(),row.updated_at.getTime());assert.equal(row.expires_at.getTime()-row.created_at.getTime(),3600000);assert.equal(row.author_ip,request.ip);const after=await counts();assert.equal(after.comments,before.comments+1);assert.equal(after.ips,before.ips+1);assert.equal(after.checks,before.checks+1);}
    else{assert.equal(result.ok,false);assert.ok(refused(result.error));assert.deepEqual(await counts(),before);}
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM incoming_ping_leases")).rows[0].n,0);
   }finally{release();await lock.query("ROLLBACK");lock.release();await observed;}
  });
 }finally{await clear();await f.dispose();}
});
