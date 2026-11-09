import test,{after} from "./isolated-test.js";
import assert from "node:assert/strict";
import {pool} from "../server/db.js";
after(()=>pool.end());
const base=process.env.TEST_API_URL!,origin=process.env.APP_ORIGIN!;
test("overlong named template inputs cannot select a truncated account",async t=>{
 const original=(await pool.query("SELECT data FROM settings WHERE id=1")).rows[0].data,people:number[]=[],posts:number[]=[],documents:number[]=[];let cookie="";const stamp="named-encoded-"+Date.now();
 async function api(path:string,method="GET",body?:unknown,anonymous=false){const response=await fetch(base+path,{method,headers:{Origin:origin,Cookie:anonymous?"":cookie,"Content-Type":"application/json"},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(15000)});return {response,data:await response.json()};}
 async function ok(path:string,method="GET",body?:unknown){const r=await api(path,method,body);assert.ok(r.response.ok,JSON.stringify(r.data));return r.data;}
 try{
  const login=await api("/api/auth/login","POST",{login:process.env.ADMIN_EMAIL,password:process.env.ADMIN_PASSWORD});assert.equal(login.response.status,200);cookie=login.response.headers.get("set-cookie")!.split(";")[0];await ok("/api/settings","PUT",{theme:"twentytwentyfive",frontPageMode:"posts",postsPerPage:20,permalinkStructure:"/%postname%/",pingServices:[]});
  const selected=(await ok("/api/users","POST",{username:stamp,email:stamp+"@example.test",displayName:"Encoded key author",role:"author",password:"Named-encoded-password-123"})).user;people.push(selected.id);const slug=(await pool.query("SELECT nicename FROM users WHERE id=$1",[selected.id])).rows[0].nicename;
  for(const [authorId,label]of [[selected.id,"SELECTED"],[login.data.user.id,"OTHER"]])posts.push((await ok("/api/posts","POST",{title:"NAMED-ENCODED-"+label,status:"publish",authorId,postDate:"2001-02-03T04:05:06",content:"<p>NAMED-ENCODED-"+label+"</p>"})).post.id);
  documents.push((await ok("/api/site-editor/documents","POST",{type:"template",slug:"named-encoded",title:"Encoded key",content:'<!-- wp:query {"query":{"inherit":true,"perPage":100}} --><!-- wp:post-template --><!-- wp:post-title /--><!-- /wp:post-template --><!-- /wp:query -->'})).document.id);
  for(const variant of ["suffix","retarget"])await t.test("overlong "+variant+" named template path rejects the full visible input",async()=>{
   const tail="&author_name="+slug,prefix="/?ignored="+"x".repeat(2000-"/?ignored=".length-tail.length)+tail,path=variant==="suffix"?"/?author_name="+slug+"&ignored="+"x".repeat(2100):prefix+"/not-this-account";assert.ok(path.length>2000);
   const template=await api("/api/public/templates/named-encoded?"+new URLSearchParams({requestPath:path}),"GET",undefined,true);assert.ok([400,414].includes(template.response.status),JSON.stringify(template));
   const site=await api("/api/public/site?"+new URLSearchParams({requestPath:path}),"GET",undefined,true);assert.ok([400,414].includes(site.response.status));
  });
 }finally{if(documents.length)await pool.query("DELETE FROM site_documents WHERE id=ANY($1::int[])",[documents]);if(posts.length)await pool.query("DELETE FROM posts WHERE id=ANY($1::int[])",[posts]);if(people.length)await pool.query("DELETE FROM users WHERE id=ANY($1::int[])",[people]);await pool.query("UPDATE settings SET data=$1 WHERE id=1",[original]);}
});
