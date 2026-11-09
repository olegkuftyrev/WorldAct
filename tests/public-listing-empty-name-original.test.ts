import test,{after} from "./isolated-test.js";
import assert from "node:assert/strict";
import {pool} from "../server/db.js";
const base=process.env.TEST_API_URL!,origin=process.env.APP_ORIGIN!;
after(()=>pool.end());
test("empty visible name retains direct-site normalization and search aliases",async t=>{
 const initial=(await pool.query("SELECT data FROM settings WHERE id=1")).rows[0].data,own:number[]=[],stamp="ordinary-empty-name-"+Date.now();let cookie="";
 async function admin(path:string,method="GET",body?:unknown){const response=await fetch(base+path,{method,headers:{Origin:origin,Cookie:cookie,"Content-Type":"application/json"},body:body===undefined?undefined:JSON.stringify(body)}),data=await response.json();assert.ok(response.ok,path+" "+JSON.stringify(data));return {response,data};}
 try{
  const login=await admin("/api/auth/login","POST",{login:process.env.ADMIN_EMAIL,password:process.env.ADMIN_PASSWORD});cookie=login.response.headers.get("set-cookie")!.split(";")[0];await admin("/api/settings","PUT",{frontPageMode:"posts",frontPageId:null,postsPageId:null,pingServices:[]});
  const selected=(await admin("/api/posts","POST",{title:stamp,status:"publish",postDate:"2001-02-03T04:05:06",content:"<p>EMPTY-NAME-MATCH</p>"})).data.post;own.push(selected.id);const other=(await admin("/api/posts","POST",{title:"Other empty-name control",status:"publish",postDate:"2001-02-03T04:05:06",content:"<p>EMPTY-NAME-OTHER</p>"})).data.post;own.push(other.id);
  for(const pathOnly of [false,true])await t.test(pathOnly?"visible path-only alias remains filtered":"explicit empty-name alias remains filtered",async()=>{
   const visible="/?"+new URLSearchParams({author_name:"",s:stamp}),query=pathOnly?new URLSearchParams({requestPath:visible}):new URLSearchParams({author_name:"",s:stamp});
   const [site,doc]=await Promise.all([fetch(base+"/api/public/site?"+query),fetch(base+"/api/public/document?"+new URLSearchParams({path:visible}))]);const [a,b]=await Promise.all([site.json(),doc.json()]);assert.equal(site.status,200);assert.equal(doc.status,200);assert.equal(b.site.pagination.totalPosts,1);assert.deepEqual(b.site.posts.map((p:any)=>p.id),[selected.id]);assert.equal(a.pagination.totalPosts,1);assert.deepEqual(a.posts.map((p:any)=>p.id),[selected.id]);
  });
 }finally{if(own.length)await pool.query("DELETE FROM posts WHERE id=ANY($1::int[])",[own]);await pool.query("UPDATE settings SET data=$1 WHERE id=1",[initial]);}
});
