import test,{after} from "./isolated-test.js";
import assert from "node:assert/strict";
import {pool} from "../server/db.js";
import {createMailPost} from "../server/core.js";
import {civilFromInstant} from "../shared/post-civil-date.js";
const base=process.env.TEST_API_URL!,origin=process.env.APP_ORIGIN!;
after(()=>pool.end());

test("publication actions capture their clock and timezone after actual PostgreSQL waits",async t=>{
 const original=(await pool.query("SELECT data FROM settings WHERE id=1")).rows[0].data,ids:number[]=[];let cookie="",admin:any;
 async function api(path:string,method="GET",body?:unknown){const response=await fetch(base+path,{method,headers:{Origin:origin,Cookie:cookie,"Content-Type":"application/json"},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(20000)});return {response,data:await response.json()};}
 async function ok(path:string,method="GET",body?:unknown){const result=await api(path,method,body);assert.ok(result.response.ok,`${path}: ${result.response.status} ${JSON.stringify(result.data)}`);return result.data;}
 async function make(body:Record<string,unknown>={}){const p=(await ok("/api/posts","POST",{title:"Publication waited "+Date.now()+"-"+ids.length,status:"draft",...body})).post;ids.push(p.id);return p;}
 async function zone(timezone:string){await pool.query("UPDATE settings SET data=data||$1::jsonb WHERE id=1",[JSON.stringify({timezone,pingServices:[]})]);}
 async function held<T>(kind:"actor"|"slug",operation:()=>Promise<T>,whileWaiting:()=>Promise<void>){
  const blocker=await pool.connect();let pending:Promise<T>|undefined;
  try{
   await blocker.query("BEGIN");const pid=(await blocker.query("SELECT pg_backend_pid() pid")).rows[0].pid;
   if(kind==="actor")await blocker.query("SELECT id FROM users WHERE id=$1 FOR UPDATE",[admin.id]);else await blocker.query("SELECT pg_advisory_xact_lock(hashtext('worldact-post-slug'))");
   pending=operation();let query="";
   for(let i=0;i<250;i++){const waiting=await pool.query("SELECT query FROM pg_stat_activity WHERE datname=current_database() AND $1=ANY(pg_blocking_pids(pid)) AND pid<>pg_backend_pid()",[pid]);query=waiting.rows.map(r=>r.query).find(q=>kind==="slug"?q.includes("worldact-post-slug"):/FROM users .*FOR SHARE/is.test(q)) || "";if(query)break;await new Promise(r=>setTimeout(r,10));}
   assert.ok(query,`the actual ${kind} mutation statement must wait on the owned blocker`);await whileWaiting();const released=Date.now();await blocker.query("COMMIT");return {value:await pending,released,completed:Date.now(),query};
  }finally{await blocker.query("ROLLBACK");if(pending)await pending.catch(()=>{});blocker.release();}
 }
 try{
  const signed=await api("/api/auth/login","POST",{login:process.env.ADMIN_EMAIL,password:process.env.ADMIN_PASSWORD});assert.equal(signed.response.status,200);cookie=signed.response.headers.get("set-cookie")!.split(";")[0];admin=signed.data.user;await zone("UTC");
  await t.test("inherited future crosses the minute boundary during the measured actor lock, preserving fixed GMT",async()=>{
   const p=await make(),chosen=new Date(Math.floor(Date.now()/1000)*1000+64000).toISOString();await pool.query("UPDATE posts SET status='future',post_date=$2,post_date_gmt=$3,scheduled_at='2099-01-01T00:00:00Z',published_at='1999-01-01T00:00:00Z' WHERE id=$1",[p.id,civilFromInstant(chosen,"UTC"),chosen]);
   const result=await held("actor",()=>api(`/api/posts/${p.id}`,"PUT",{title:p.title+" after wait"}),async()=>{await zone("+05:45");await new Promise(r=>setTimeout(r,Math.max(0,Date.parse(chosen)-Date.now()-58000)));});
   assert.equal(result.value.response.status,200,JSON.stringify(result.value.data));const saved=result.value.data.post;assert.equal(saved.status,"publish");assert.equal(saved.postDateGmt,chosen);assert.equal(saved.postDate,civilFromInstant(chosen,"UTC"));assert.equal(saved.publishedAt,chosen);assert.equal(saved.scheduledAt,"2099-01-01T00:00:00.000Z");assert.ok(Math.floor(Date.parse(chosen)/1000)-Math.floor(result.released/1000)<60);
  });
  await t.test("Bulk Publish Now uses one clock and the settings committed during its measured slug wait",async()=>{
   await zone("UTC");const p=await make({postDate:"2099-02-03T04:05:06"}),result=await held("slug",()=>api("/api/posts/bulk","POST",{ids:[p.id],changes:{status:"publish",postDate:"2100-02-03T04:05:06"}}),async()=>zone("+05:45"));
   assert.equal(result.value.response.status,200);assert.deepEqual(result.value.data.updated,[p.id]);const saved=result.value.data.posts[0],gmt=Date.parse(saved.postDateGmt);assert.ok(gmt>=result.released&&gmt<=result.completed);assert.equal(saved.postDate,civilFromInstant(saved.postDateGmt,"+05:45"));assert.equal(saved.publishedAt,saved.postDateGmt);assert.equal(saved.scheduledAt,null);assert.equal(saved.status,"publish");
  });
  await t.test("null-GMT fixation uses the late zone while retaining the unchanged nonfloating civil",async()=>{
   await zone("UTC");const p=await make();await pool.query("UPDATE posts SET status='publish',post_date='2001-02-03T04:05:06',post_date_gmt=NULL,published_at='1999-01-01T00:00:00Z' WHERE id=$1",[p.id]);const result=await held("actor",()=>api(`/api/posts/${p.id}`,"PUT",{title:p.title+" fixed"}),async()=>zone("+05:45"));assert.equal(result.value.response.status,200);const saved=result.value.data.post;assert.equal(saved.postDate,"2001-02-03T04:05:06");assert.equal(saved.postDateGmt,"2001-02-02T22:20:06.000Z");assert.equal(saved.publishedAt,"1999-01-01T00:00:00.000Z");
  });
  await t.test("a genuinely changed bulk civil becomes invalid in the late zone and rolls the item back",async()=>{
   await zone("UTC");const p=await make({postDate:"2099-02-03T04:05:06"}),before=(await pool.query("SELECT * FROM posts WHERE id=$1",[p.id])).rows[0],result=await held("slug",()=>api("/api/posts/bulk","POST",{ids:[p.id],changes:{status:"publish",postDate:"2024-03-10T02:30:00"}}),async()=>zone("America/Los_Angeles"));assert.equal(result.value.response.status,200);assert.deepEqual(result.value.data.updated,[]);assert.equal(result.value.data.errors[0].status,400);assert.deepEqual((await pool.query("SELECT * FROM posts WHERE id=$1",[p.id])).rows[0],before);
  });
  await t.test("recognized publishing mail delegates classification after the actual core slug wait (direct service)",async()=>{
   await zone("UTC");const date=new Date(Math.floor(Date.now()/1000)*1000+64000).toISOString(),writer=await pool.connect();
   try{
    await writer.query("BEGIN");const result=await held("slug",()=>createMailPost(writer,admin,{title:"Publication waited recognized mail",content:"<p>MAIL-PUBLICATION-WAIT</p>",categoryId:null,date},true),async()=>{await zone("+05:45");await new Promise(r=>setTimeout(r,Math.max(0,Date.parse(date)-Date.now()-58000)));});const p=result.value;ids.push(p.id);assert.equal(p.status,"publish");assert.equal(new Date(p.postDateGmt).toISOString(),date);assert.equal(p.postDate,civilFromInstant(date,"+05:45"));assert.equal(new Date(p.publishedAt).toISOString(),date);assert.equal(p.scheduledAt,null);await writer.query("COMMIT");
   }finally{await writer.query("ROLLBACK");writer.release();}
  });
 }finally{if(ids.length)await pool.query("DELETE FROM posts WHERE id=ANY($1::int[])",[ids]);await pool.query("UPDATE settings SET data=$1 WHERE id=1",[original]);}
});
