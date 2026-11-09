import test,{after} from "./isolated-test.js";
import assert from "node:assert/strict";
import {pool} from "../server/db.js";
const base=process.env.TEST_API_URL!,origin=process.env.APP_ORIGIN!;
after(()=>pool.end());
test("direct site preserves its established explicit and path-only empty page boundary",async t=>{
 const initial=(await pool.query("SELECT data FROM settings WHERE id=1")).rows[0].data;let cookie="";
 async function admin(path:string,method="GET",body?:unknown){const response=await fetch(base+path,{method,headers:{Origin:origin,Cookie:cookie,"Content-Type":"application/json"},body:body===undefined?undefined:JSON.stringify(body)}),data=await response.json();assert.ok(response.ok,path+" "+JSON.stringify(data));return {response,data};}
 try{
  const login=await admin("/api/auth/login","POST",{login:process.env.ADMIN_EMAIL,password:process.env.ADMIN_PASSWORD});cookie=login.response.headers.get("set-cookie")!.split(";")[0];await admin("/api/settings","PUT",{frontPageMode:"posts",frontPageId:null,postsPageId:null,pingServices:[]});
  for(const [label,values,status]of [["explicit",{page:""},400],["path-only",{requestPath:"/?page="},200],["explicit plus path",{page:"",requestPath:"/?page="},400]] as const)await t.test(label,async()=>{const response=await fetch(base+"/api/public/site?"+new URLSearchParams(values));await response.text();assert.equal(response.status,status);});
 }finally{await pool.query("UPDATE settings SET data=$1 WHERE id=1",[initial]);}
});
