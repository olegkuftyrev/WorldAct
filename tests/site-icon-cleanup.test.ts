import test, { after } from "./isolated-test.js";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import pg, { type PoolClient } from "pg";
import type { Response, NextFunction } from "express";
import sharp from "sharp";
import { pool, uploadsDir } from "../server/db.js";
import { attachUser, type AuthRequest } from "../server/auth.js";
import router from "../server/site-identity.js";

const base=process.env.TEST_API_URL!,origin=process.env.APP_ORIGIN!;
const observer=new pg.Pool({connectionString:process.env.DATABASE_URL,max:2,connectionTimeoutMillis:3000});
after(async()=>{await observer.end();await pool.end();});
const sha=(bytes:Buffer)=>createHash("sha256").update(bytes).digest("hex");
const inventory=async()=>(await readdir(uploadsDir,{recursive:true,withFileTypes:true})).filter(e=>e.isFile()).map(e=>path.relative(uploadsDir,path.join(e.parentPath,e.name))).sort();
const files=(row:any):string[]=>[row.filename,...Object.values(row.sizes).map((size:any)=>size.filename)];
const api=async(route:string,method="GET",body?:unknown,cookie="")=>{const response=await fetch(base+route,{method,headers:{Origin:origin,Cookie:cookie,"Content-Type":"application/json"},signal:AbortSignal.timeout(15000),...(body===undefined?{}:{body:JSON.stringify(body)})});return{response,data:await response.json()};};
async function login(){const r=await api("/api/auth/login","POST",{login:process.env.ADMIN_EMAIL,password:process.env.ADMIN_PASSWORD});assert.equal(r.response.status,200);return r.response.headers.get("set-cookie")!.split(";")[0];}

// Invoke the existing real route middleware/handler in this test process. This
// is a direct handler fault-injection test, not a simulated successful HTTP call.
async function directIcon(cookie:string,mediaId:number){
 const req={headers:{cookie},method:"POST",body:{mediaId}} as AuthRequest;
 let status=200,data:unknown;
 const res={status(code:number){status=code;return this;},json(value:unknown){data=value;return this;}} as unknown as Response;
 let failure:unknown;await attachUser(req,res,((error?:unknown)=>{failure=error;}) as NextFunction);if(failure)throw failure;
 const route=(router as any).stack.find((layer:any)=>layer.route?.path==="/settings/site-icon").route;
 for(const layer of route.stack){let next=false;await layer.handle(req,res,(error?:unknown)=>{if(error)throw error;next=true;});if(!next)break;}
 return{status,data};
}

type OwnedClient={client:PoolClient;released:boolean;names:string[]};
async function wrappedClients<T>(work:(records:OwnedClient[],cleanupReads:()=>number)=>Promise<T>,intercept:(client:PoolClient,args:any[])=>Promise<any>){
 const connect=pool.connect,query=pool.query,records:OwnedClient[]=[];let cleanupReads=0;
 // Callback acquisitions belong to pool.query itself and remain real/unwrapped.
 pool.connect=function(...args:any[]){
  if(args.length)return Reflect.apply(connect,pool,args);
  return Reflect.apply(connect,pool,[]).then((client:PoolClient)=>{
   const entry:OwnedClient={client,released:false,names:[]},release=client.release.bind(client);records.push(entry);
   return new Proxy(client,{get(target,key){
    if(key==="release")return()=>{assert.equal(entry.released,false);entry.released=true;release();};
    if(key==="query")return async(...queryArgs:any[])=>{if(typeof queryArgs[0]==="string"&&queryArgs[0].startsWith("INSERT INTO media(author_id,title,filename")){entry.names=[queryArgs[1][2],...Object.values(JSON.parse(queryArgs[1][4])).map((size:any)=>size.filename)];assert.equal(entry.names.length,6);}return intercept(target,queryArgs);};
    const value=Reflect.get(target,key,target);return typeof value==="function"?value.bind(target):value;
   }});
  });
 } as typeof pool.connect;
 pool.query=function(...args:any[]){
  if(typeof args[0]==="string"&&args[0].includes("SELECT DISTINCT referenced.filename")){
   cleanupReads++;for(const entry of records)if(entry.names.some(name=>args[1][0].includes(name)))assert.equal(entry.released,true,"Release the icon transaction before its reference lookup borrows a client");
  }
  return Reflect.apply(query,pool,args);
 } as typeof pool.query;
 try{return await work(records,()=>cleanupReads);}finally{
  pool.connect=connect;pool.query=query;
  // Only an assertion/timeout fallback; the passing path releases every client.
  for(const entry of records)if(!entry.released){entry.released=true;entry.client.release(new Error("Failed isolated icon test"));}
 }
}

async function waitForBlocked(pid:number,expected=1){
 for(let n=0;n<300;n++){
  const result=await observer.query(`WITH RECURSIVE blocked(pid) AS (SELECT $1::int UNION SELECT a.pid FROM pg_stat_activity a JOIN blocked b ON b.pid=ANY(pg_blocking_pids(a.pid)) WHERE a.datname=current_database()) SELECT a.pid,a.query FROM pg_stat_activity a JOIN blocked b ON a.pid=b.pid WHERE a.pid<>$1`,[pid]);
  if(result.rowCount===expected)return result.rows;
  await new Promise(resolve=>setTimeout(resolve,10));
 }
 assert.fail("Expected actual database lock waiters before releasing the private gate");
}

test("site-icon failures preserve committed references and clean real rollbacks after releasing clients",{timeout:45000},async t=>{
 let cookie=await login();const ids=new Set<number>(),settings=(await pool.query("SELECT data FROM settings WHERE id=1")).rows[0].data;
 const upload=async(color:string)=>{const bytes=await sharp({create:{width:800,height:600,channels:3,background:color}}).png().toBuffer(),form=new FormData();form.append("file",new Blob([new Uint8Array(bytes)],{type:"image/png"}),"icon-cleanup-"+randomBytes(6).toString("hex")+".png");const response=await fetch(base+"/api/media",{method:"POST",headers:{Origin:origin,Cookie:cookie},body:form});assert.equal(response.status,201);const item=(await response.json()).media;ids.add(item.id);return{item,bytes};};
 const source=await upload("#2467a8"),unrelated=await upload("#a86724"),label="icon-owner-"+randomBytes(6).toString("hex");
 const account=await api("/api/users","POST",{username:label,displayName:"Unrelated icon fixture owner",email:label+"@example.test",role:"author",password:randomBytes(24).toString("base64url")},cookie);assert.equal(account.response.status,201);const otherOwner=account.data.user.id;
 await pool.query("UPDATE media SET author_id=$1 WHERE id=$2",[otherOwner,unrelated.item.id]);
 const originalFiles=async()=>{for(const fixture of[source,unrelated]){const response=await fetch(base+fixture.item.url);assert.equal(response.status,200);assert.equal(sha(Buffer.from(await response.arrayBuffer())),sha(fixture.bytes));}assert.equal((await pool.query("SELECT author_id FROM media WHERE id=$1",[unrelated.item.id])).rows[0].author_id,otherOwner);};
 try{
  for(const rejectRollback of[false,true])await t.test("real committed icon survives injected acknowledgement error"+(rejectRollback?" and a secondary rollback error":""),async()=>{
   const acknowledgement=new Error("Injected acknowledgement loss after REAL COMMIT"),secondary=new Error("Injected secondary rollback acknowledgement loss");let committed:any,checksums=new Map<string,string>();
   await wrappedClients(async(records,cleanupReads)=>{
    await assert.rejects(directIcon(cookie,source.item.id),error=>error===acknowledgement);
    assert.equal(records.length,1);assert.equal(records[0].released,true);assert.ok(committed);ids.add(committed.id);
    assert.equal((await pool.query("SELECT data->>'siteIconId' AS id FROM settings WHERE id=1")).rows[0].id,String(committed.id));
    const remaining=(await inventory()).filter(name=>checksums.has(name)).length;
    console.log(JSON.stringify({scenario:"direct-handler injected COMMIT acknowledgement loss",rollbackAlsoRejected:rejectRollback,realCommitCompleted:true,committedMediaId:committed.id,generatedFiles:checksums.size,filesAfterRejectedAcknowledgement:remaining}));
    assert.equal(remaining,6,"Committed icon media/settings must keep all six actual files");assert.equal(cleanupReads(),1);
    for(const [name,hash]of checksums){assert.equal(sha(await readFile(path.join(uploadsDir,name))),hash);const response=await fetch(base+"/uploads/"+name);assert.equal(response.status,200);assert.equal(sha(Buffer.from(await response.arrayBuffer())),hash);}
    const row=await api("/api/media/"+committed.id,"GET",undefined,cookie);assert.equal(row.response.status,200);assert.equal(row.data.media.id,committed.id);await originalFiles();
   },async(client,args)=>{
    const result=await Reflect.apply(client.query,client,args);
    if(args[0]==="COMMIT"){
     committed=(await client.query("SELECT media.* FROM media JOIN settings ON media.id=(settings.data->>'siteIconId')::int WHERE settings.id=1")).rows[0];
     for(const name of files(committed))checksums.set(name,sha(await readFile(path.join(uploadsDir,name))));throw acknowledgement;
    }
    if(args[0]==="ROLLBACK"&&rejectRollback)throw secondary;
    return result;
   });
  });

  for(const logout of[false,true])await t.test("actual HTTP "+(logout?"logout":"SQL insertion failure")+" rolls back all six staged icon files",async()=>{
   const suffix=randomBytes(6).toString("hex"),fn="icon_failure_"+suffix,key=randomBytes(4).readUInt32BE()%2147483647,before=await inventory(),beforeSettings=(await pool.query("SELECT data FROM settings WHERE id=1")).rows[0].data,count=(await pool.query("SELECT count(*)::int AS n FROM media")).rows[0].n;
   const gate=await observer.connect();let pending:ReturnType<typeof api>|undefined;
   try{
    await observer.query(`CREATE FUNCTION ${fn}() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN PERFORM pg_advisory_xact_lock(${key}); ${logout?"RETURN NEW;":"RAISE EXCEPTION 'Controlled icon insertion failure';"} END$$`);
    await observer.query(`CREATE TRIGGER ${fn} BEFORE ${logout?"UPDATE ON settings":"INSERT ON media"} FOR EACH ROW ${logout?"WHEN (OLD.id=1)":"WHEN (NEW.title LIKE 'Site Icon — %')"} EXECUTE FUNCTION ${fn}()`);
    await gate.query("BEGIN");const pid=(await gate.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;await gate.query("SELECT pg_advisory_xact_lock($1)",[key]);
    pending=api("/api/settings/site-icon","POST",{mediaId:source.item.id},cookie);await waitForBlocked(pid);const staged=(await inventory()).filter(name=>!before.includes(name));assert.equal(staged.length,6);for(const name of staged)assert.ok((await readFile(path.join(uploadsDir,name))).length);
    if(logout){assert.equal((await api("/api/auth/logout","POST",{},cookie)).response.status,200);cookie="";}
    await gate.query("COMMIT");const response=await pending;assert.equal(response.response.status,logout?401:500);assert.equal((await pool.query("SELECT count(*)::int AS n FROM media")).rows[0].n,count);assert.deepEqual((await pool.query("SELECT data FROM settings WHERE id=1")).rows[0].data,beforeSettings);assert.deepEqual(await inventory(),before);for(const name of staged)assert.equal((await fetch(base+"/uploads/"+name)).status,404);await originalFiles();
   }finally{await gate.query("ROLLBACK").catch(()=>{});gate.release();await pending?.catch(()=>{});await observer.query(`DROP TRIGGER IF EXISTS ${fn} ON ${logout?"settings":"media"}; DROP FUNCTION IF EXISTS ${fn}()`);if(!cookie)cookie=await login();}
  });

  await t.test("ten real rolled-back icon transactions release the full pool before reference cleanup",async()=>{
   const suffix=randomBytes(6).toString("hex"),fn="icon_pool_"+suffix,key=randomBytes(4).readUInt32BE()%2147483647,before=await inventory(),count=(await pool.query("SELECT count(*)::int AS n FROM media")).rows[0].n,beforeSettings=(await pool.query("SELECT data FROM settings WHERE id=1")).rows[0].data;
   const gate=await observer.connect();let pending:Array<Promise<unknown>>=[];
   try{
    await observer.query(`CREATE FUNCTION ${fn}() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN PERFORM pg_advisory_xact_lock(${key}); RAISE EXCEPTION 'Controlled full-pool icon rollback'; END$$`);
    await observer.query(`CREATE TRIGGER ${fn} BEFORE INSERT ON media FOR EACH ROW WHEN (NEW.title LIKE 'Site Icon — %') EXECUTE FUNCTION ${fn}()`);
    await gate.query("BEGIN");const pid=(await gate.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;await gate.query("SELECT pg_advisory_xact_lock($1)",[key]);
    // Authenticate each real cookie before occupying every client. The direct
    // handler still runs its ordinary actor/token/admin checks inside its TX.
    const requests=await Promise.all(Array.from({length:10},async()=>{const req={headers:{cookie},method:"POST",body:{mediaId:source.item.id}} as AuthRequest;await attachUser(req,{} as Response,()=>{});return req;}));
    const route=(router as any).stack.find((layer:any)=>layer.route?.path==="/settings/site-icon").route;
    await wrappedClients(async(records,cleanupReads)=>{
     pending=requests.map(async req=>{const res={status(){return this;},json(){assert.fail("Controlled insertion failure cannot return success");}} as unknown as Response;await route.stack[0].handle(req,res,()=>{});try{await route.stack[1].handle(req,res,()=>{});assert.fail("Expected actual PostgreSQL insertion failure");}catch(error){assert.match((error as Error).message,/Controlled full-pool icon rollback/);}});
     const blocked=await waitForBlocked(pid,10);assert.equal(blocked.filter(row=>row.query.includes("worldact-page-hierarchy")).length,9);assert.equal(blocked.filter(row=>row.query.includes("INSERT INTO media(")).length,1);assert.equal(records.length,10);assert.equal(pool.totalCount,10);assert.equal(pool.idleCount,0);assert.equal((await inventory()).length,before.length+6);
     await gate.query("COMMIT");await Promise.race([Promise.all(pending),new Promise((_,reject)=>setTimeout(()=>reject(new Error("Icon cleanup starved its full transaction pool")),8000).unref())]);assert.ok(records.every(entry=>entry.released));assert.equal(records.flatMap(entry=>entry.names).length,60);assert.equal(cleanupReads(),10);
    },(client,args)=>Reflect.apply(client.query,client,args));
    pending=[];assert.deepEqual(await inventory(),before);assert.equal((await pool.query("SELECT count(*)::int AS n FROM media")).rows[0].n,count);assert.deepEqual((await pool.query("SELECT data FROM settings WHERE id=1")).rows[0].data,beforeSettings);await originalFiles();assert.equal((await pool.query("SELECT 1 AS healthy")).rows[0].healthy,1);
   }finally{await gate.query("ROLLBACK").catch(()=>{});gate.release();await Promise.allSettled(pending);await observer.query(`DROP TRIGGER IF EXISTS ${fn} ON media; DROP FUNCTION IF EXISTS ${fn}()`);}
  });
 }finally{
  for(const id of ids)await api("/api/media/"+id,"DELETE",undefined,cookie);await api("/api/users/"+otherOwner+"?deleteContent=true","DELETE",undefined,cookie);await pool.query("UPDATE settings SET data=$1::jsonb WHERE id=1",[JSON.stringify(settings)]);if(cookie)await api("/api/auth/logout","POST",{},cookie);
 }
});
