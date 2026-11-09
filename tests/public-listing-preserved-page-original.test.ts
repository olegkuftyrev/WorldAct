import test,{after} from "./isolated-test.js";
import assert from "node:assert/strict";
import {pool} from "../server/db.js";
const base=process.env.TEST_API_URL!,origin=process.env.APP_ORIGIN!;
after(()=>pool.end());
test("ordinary empty page and existing pretty-author filtered paging preserve their prior status",async t=>{
 const initial=(await pool.query("SELECT data FROM settings WHERE id=1")).rows[0].data,own:number[]=[],stamp="ordinary-preserved-page-"+Date.now();let cookie="";
 async function admin(path:string,method="GET",body?:unknown){const response=await fetch(base+path,{method,headers:{Origin:origin,Cookie:cookie,"Content-Type":"application/json"},body:body===undefined?undefined:JSON.stringify(body)}),data=await response.json();assert.ok(response.ok,path+" "+JSON.stringify(data));return {response,data};}
 async function replies(path:string,resource=false){const targets=[path,path,"/api/public/document?"+new URLSearchParams({path}),...(resource?["/api/public/resolve?"+new URLSearchParams({path})]:[])];return Promise.all(targets.map(async(target,i)=>{const response=await fetch(base+target,{method:i===1?"HEAD":"GET"}),text=await response.text();return{status:response.status,text};}));}
 try{
  const login=await admin("/api/auth/login","POST",{login:process.env.ADMIN_EMAIL,password:process.env.ADMIN_PASSWORD});cookie=login.response.headers.get("set-cookie")!.split(";")[0];await admin("/api/settings","PUT",{frontPageMode:"posts",frontPageId:null,postsPageId:null,postsPerPage:1,permalinkStructure:"/%postname%/",pingServices:[]});
  for(const n of [1,2])own.push((await admin("/api/posts","POST",{title:stamp+n,status:"publish",postDate:"2001-02-03T04:05:06",content:"<p>PRESERVED-PAGE-CONTROL</p>"})).data.post.id);
  const person=(await pool.query("SELECT id,nicename FROM users WHERE email=$1",[process.env.ADMIN_EMAIL])).rows[0];
  for(const path of ["/?page=","/?author="+person.id+"&page=","/?category=missing-"+stamp+"&page="])await t.test("empty first main page stays200 "+path,async()=>{const results=await replies(path);assert.equal(results[1].text,"");for(const r of results)assert.equal(r.status,200);});
  await t.test("resolved pretty author retains its existing unfiltered page policy",async()=>{const path="/author/"+person.nicename+"/?"+new URLSearchParams({page:"2",search:"missing-"+stamp}),results=await replies(path,true);assert.equal(results[1].text,"");for(const r of results)assert.equal(r.status,200);const model=JSON.parse(results[2].text);assert.equal(model.route.archive.authorId,person.id);assert.equal(model.site.pagination.totalPosts,0);assert.deepEqual(model.site.posts,[]);});
 }finally{if(own.length)await pool.query("DELETE FROM posts WHERE id=ANY($1::int[])",[own]);await pool.query("UPDATE settings SET data=$1 WHERE id=1",[initial]);}
});
