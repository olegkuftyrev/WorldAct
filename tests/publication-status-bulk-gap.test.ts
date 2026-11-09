import test,{after} from "./isolated-test.js";
import assert from "node:assert/strict";
import {pool} from "../server/db.js";
const base=process.env.TEST_API_URL!,origin=process.env.APP_ORIGIN!;
after(()=>pool.end());

test("bulk Publish Now validates explicit unfixed civil intent without rebasing a fixed pair",async t=>{
 const original=(await pool.query("SELECT data FROM settings WHERE id=1")).rows[0].data,ids:number[]=[];let cookie="";
 async function api(path:string,method:string,body:unknown){const response=await fetch(base+path,{method,headers:{Origin:origin,Cookie:cookie,"Content-Type":"application/json"},body:JSON.stringify(body),signal:AbortSignal.timeout(15000)});return {response,data:await response.json()};}
 async function make(status="draft",gmt:string|null="2024-03-10T02:30:00Z"){const result=await api("/api/posts","POST",{title:"Bulk original gap "+Date.now()+"-"+ids.length,status:"draft"});assert.equal(result.response.status,201);const id=result.data.post.id;ids.push(id);await pool.query("UPDATE posts SET status=$2,post_date='2024-03-10T02:30:00',post_date_gmt=$3 WHERE id=$1",[id,status,gmt]);return id;}
 async function bulk(id:number,changes:Record<string,unknown>){return api("/api/posts/bulk","POST",{ids:[id],changes:{status:"publish",...changes}});}
 async function saved(id:number){return (await pool.query("SELECT * FROM posts WHERE id=$1",[id])).rows[0];}
 try{
  const signed=await api("/api/auth/login","POST",{login:process.env.ADMIN_EMAIL,password:process.env.ADMIN_PASSWORD});assert.equal(signed.response.status,200);cookie=signed.response.headers.get("set-cookie")!.split(";")[0];await pool.query("UPDATE settings SET data=data||$1::jsonb WHERE id=1",[JSON.stringify({timezone:"America/Los_Angeles",pingServices:[]})]);
  await t.test("identical fixed civil keeps its original GMT exemption before Publish Now reset",async()=>{const id=await make(),before=Date.now(),result=await bulk(id,{postDate:"2024-03-10T02:30:00"});assert.equal(result.response.status,200);assert.deepEqual(result.data.updated,[id]);assert.equal(result.data.posts[0].status,"publish");assert.ok(Date.parse(result.data.posts[0].postDateGmt)>=before);});
  await t.test("identical explicit nonfloating null-GMT civil must finish strict derivation before reset",async()=>{const id=await make("future",null),before=await saved(id),result=await bulk(id,{postDate:"2024-03-10T02:30:00"});assert.equal(result.response.status,200);assert.deepEqual(result.data.updated,[]);assert.equal(result.data.errors[0].status,400);assert.deepEqual(await saved(id),before);});
  await t.test("no-date Publish Now can reset an old nonfloating unfixed gap",async()=>{const id=await make("future",null),before=Date.now(),result=await bulk(id,{});assert.deepEqual(result.data.updated,[id]);assert.equal(result.data.posts[0].status,"publish");assert.ok(Date.parse(result.data.posts[0].postDateGmt)>=before);});
  await t.test("genuinely changed gap is rejected before reset",async()=>{const id=await make();await pool.query("UPDATE posts SET post_date='2024-03-09T02:30:00' WHERE id=$1",[id]);const before=await saved(id),result=await bulk(id,{postDate:"2024-03-10T02:30:00"});assert.deepEqual(result.data.updated,[]);assert.equal(result.data.errors[0].status,400);assert.deepEqual(await saved(id),before);});
  await t.test("floating unchanged civil and explicit null retain current-clock reset semantics",async()=>{for(const changes of [{postDate:"2024-03-10T02:30:00"},{postDate:null}]){const id=await make("draft",null),before=Date.now(),result=await bulk(id,changes);assert.deepEqual(result.data.updated,[id]);assert.ok(Date.parse(result.data.posts[0].postDateGmt)>=before);assert.equal(result.data.posts[0].status,"publish");}});
 }finally{if(ids.length)await pool.query("DELETE FROM posts WHERE id=ANY($1::int[])",[ids]);await pool.query("UPDATE settings SET data=$1 WHERE id=1",[original]);}
});
