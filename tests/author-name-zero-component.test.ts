import test,{after} from "./isolated-test.js";
import assert from "node:assert/strict";
import {pool} from "../server/db.js";
const base=process.env.TEST_API_URL!;after(()=>pool.end());
test("source slash component uses the immediate previous value when its last component is literal zero",async t=>{
 const initial=(await pool.query("SELECT data FROM settings WHERE id=1")).rows[0].data, ids:number[]=[];
 const prefix="named-zero-"+Date.now();
 async function user(slug:string){const row=(await pool.query("INSERT INTO users(username,nicename,email,display_name,password_hash,role) VALUES($1,$2,$3,$4,'unusable','author') RETURNING id",[prefix+"-"+slug,slug,prefix+"-"+slug+"@example.test","Named zero "+slug])).rows[0];ids.push(row.id);return row.id;}
 try{
  await pool.query("UPDATE settings SET data=data || $1::jsonb WHERE id=1",[JSON.stringify({frontPageMode:"posts",frontPageId:null,postsPageId:null})]);
  const prefixId=await user(prefix),doubleId=await user("00");
  for(const [value,id,status]of [["0",null,404],[prefix+"/0",prefixId,200],[prefix+"/0/",null,404],["/0",null,404],[prefix+"/00",doubleId,200],[prefix+"/0//",null,404]] as const){
   await t.test(JSON.stringify(value)+" selects "+String(id),async()=>{
    for(const endpoint of ["/api/public/document?","/api/public/resolve?"]){
     const r=await fetch(base+endpoint+new URLSearchParams({path:"/?"+new URLSearchParams({author_name:value})}),{signal:AbortSignal.timeout(10000)}),body=await r.json();
     assert.equal(r.status,status,endpoint+" "+value);
     if(status===200)assert.equal(endpoint.includes("document")?body.route.archive.authorId:body.archive.authorId,id,value);
    }
   });
  }
 }finally{if(ids.length)await pool.query("DELETE FROM users WHERE id=ANY($1::int[])",[ids]);await pool.query("UPDATE settings SET data=$1 WHERE id=1",[initial]);}
});
