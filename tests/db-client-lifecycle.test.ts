import test, { after } from "./isolated-test.js";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import pg, { type PoolClient } from "pg";
import { pool } from "../server/db.js";

const observer=new pg.Pool({connectionString:process.env.DATABASE_URL,max:2,connectionTimeoutMillis:3000});
after(async()=>{await observer.end();await pool.end();});
async function activeBackend(sql:string){
 for(let n=0;n<300;n++){
  const row=(await observer.query("SELECT pid FROM pg_stat_activity WHERE datname=current_database() AND query=$1 AND state='active' AND pid<>pg_backend_pid()",[sql])).rows[0];
  if(row)return row.pid as number;
  await new Promise(resolve=>setTimeout(resolve,10));
 }
 assert.fail("Expected the actual owned database query to be active before terminating its backend");
}
function removedClient(client:PoolClient){
 let listener:(removed:PoolClient)=>void;
 const promise=new Promise<void>((resolve,reject)=>{
  const timer=setTimeout(()=>{pool.off("remove",listener);reject(new Error("Disconnected client was not evicted"));},3000);
  listener=removed=>{if(removed===client){clearTimeout(timer);pool.off("remove",listener);resolve();}};
  pool.on("remove",listener);
 });
 return promise;
}

test("one connection error listener survives repeated checkouts without accumulating",async()=>{
 const first=await pool.connect();const handlers=first.listeners("error");assert.equal(handlers.length,1,"Checked-out physical connections need their lifetime error observer");first.release();
 for(let n=0;n<20;n++){
  const client=await pool.connect();try{assert.equal(client,first);assert.deepEqual(client.listeners("error"),handlers);assert.equal((await client.query("SELECT 42 AS answer")).rows[0].answer,42);}finally{client.release();}
 }
});

test("ordinary SQL errors retain their SQLSTATE and a rolled-back transaction remains usable",async()=>{
 await assert.rejects(pool.query("SELECT 1/0"),(error:any)=>error.code==="22012");
 await new Promise<void>((resolve,reject)=>{pool.query("SELECT 1/0",(error)=>{try{assert.equal((error as Error&{code?:string})?.code,"22012");resolve();}catch(failure){reject(failure);}});});
 const client=await pool.connect();try{
  const pid=(await client.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;await client.query("BEGIN");await assert.rejects(client.query("SELECT 1/0"),(error:any)=>error.code==="22012");await client.query("ROLLBACK");assert.equal((await client.query("SELECT pg_backend_pid() AS pid")).rows[0].pid,pid);
 }finally{client.release();}
 assert.equal((await pool.query("SELECT 1 AS healthy")).rows[0].healthy,1);
});

test("a real checked-out transaction disconnect rejects queries, survives its Client error event and evicts that connection",async()=>{
 const client=await pool.connect();let released=false;
 try{
  assert.equal(client.listenerCount("error"),1,"No test Client error listener substitutes for the production observer");await client.query("BEGIN");const sql="SELECT pg_sleep(20) /* lifecycle-tx-"+randomBytes(6).toString("hex")+" */",pid=(await client.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
  const pending=client.query(sql),rejected=assert.rejects(pending,(error:any)=>error.code==="57P01");assert.equal(await activeBackend(sql),pid);assert.equal((await observer.query("SELECT pg_terminate_backend($1) AS terminated",[pid])).rows[0].terminated,true);await rejected;
  await assert.rejects(client.query("ROLLBACK"));const removed=removedClient(client);client.release();released=true;await removed;
  const replacement=await pool.connect();try{assert.notEqual((await replacement.query("SELECT pg_backend_pid() AS pid")).rows[0].pid,pid);assert.equal(replacement.listenerCount("error"),1);}finally{replacement.release();}
 }finally{if(!released)client.release(true);}
});

test("a real ordinary pooled read disconnect still rejects and leaves a healthy replacement",async()=>{
 const sql="SELECT pg_sleep(20) /* lifecycle-read-"+randomBytes(6).toString("hex")+" */",pending=pool.query(sql),rejected=assert.rejects(pending,(error:any)=>error.code==="57P01"),pid=await activeBackend(sql);
 assert.equal((await observer.query("SELECT pg_terminate_backend($1) AS terminated",[pid])).rows[0].terminated,true);await rejected;
 const healthy=await pool.query("SELECT 1 AS healthy,pg_backend_pid() AS pid");assert.equal(healthy.rows[0].healthy,1);assert.notEqual(healthy.rows[0].pid,pid);
});

test("idle connection errors still reach the pool error listener and eviction",async()=>{
 const client=await pool.connect(),pid=(await client.query("SELECT pg_backend_pid() AS pid")).rows[0].pid,removed=removedClient(client);
 let listener:(error:Error,failed:PoolClient)=>void;const emitted=new Promise<void>(resolve=>{listener=(_error,failed)=>{if(failed===client){pool.off("error",listener);resolve();}};pool.on("error",listener);});
 client.release();assert.equal((await observer.query("SELECT pg_terminate_backend($1) AS terminated",[pid])).rows[0].terminated,true);await removed;await emitted;assert.equal((await pool.query("SELECT 1 AS healthy")).rows[0].healthy,1);
});
