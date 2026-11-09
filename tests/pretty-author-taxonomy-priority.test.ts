import test,{after} from "./isolated-test.js";
import assert from "node:assert/strict";
import {pool} from "../server/db.js";
after(()=>pool.end());
const base=process.env.TEST_API_URL!,origin=process.env.APP_ORIGIN!;
test("overlapping taxonomy spelling retains caller filters and bounded direct-endpoint counters",async()=>{
 const original=(await pool.query("SELECT data FROM settings WHERE id=1")).rows[0].data;
 let cookie="";const posts:number[]=[],people:number[]=[],terms:number[]=[],documents:number[]=[];
 async function api(path:string,method="GET",body?:unknown,anonymous=false){const response=await fetch(base+path,{method,headers:{Origin:origin,Cookie:anonymous?"":cookie,"Content-Type":"application/json"},body:body===undefined?undefined:JSON.stringify(body)}),text=await response.text();let data:any;try{data=JSON.parse(text);}catch{}return {response,text,data};}
 async function ok(path:string,method="GET",body?:unknown){const r=await api(path,method,body);assert.ok(r.response.ok,`${path}: ${r.response.status} ${r.text}`);return r.data;}
 try{
  const signed=await api("/api/auth/login","POST",{login:process.env.ADMIN_EMAIL,password:process.env.ADMIN_PASSWORD});assert.equal(signed.response.status,200);cookie=signed.response.headers.get("set-cookie")!.split(";")[0];
  const username="pretty-taxonomy-"+Date.now(),person=(await ok("/api/users","POST",{username,email:username+"@example.test",displayName:"Taxonomy spelling account",password:"Taxonomy-fixture-password",role:"author"})).user;people.push(person.id);
  const slug=(await pool.query("SELECT nicename FROM users WHERE id=$1",[person.id])).rows[0].nicename;
  const term=(await pool.query("INSERT INTO terms(taxonomy,name,slug) VALUES('category','Independent taxonomy',$1) RETURNING id",[slug])).rows[0];terms.push(term.id);
  await ok("/api/settings","PUT",{permalinkStructure:"/%postname%/",categoryBase:"author",postsPerPage:1,pingServices:[]});
  for(const n of [1,2])posts.push((await ok("/api/posts","POST",{title:"INDEPENDENT-TAXONOMY-"+n,status:"publish",categoryIds:[term.id],content:"<p>Public category item.</p>"})).post.id);
  posts.push((await ok("/api/posts","POST",{title:"OUTSIDE-CATEGORY-AUTHOR-ITEM",status:"publish",authorId:person.id,content:"<p>Public separate author item.</p>"})).post.id);
  const document=(await ok("/api/site-editor/documents","POST",{type:"template",slug:"pretty-taxonomy-direct",title:"Taxonomy direct",content:'<!-- wp:query {"query":{"inherit":true}} --><!-- wp:post-template --><!-- wp:post-title /--><!-- /wp:post-template --><!-- /wp:query -->'})).document;documents.push(document.id);
  const path="/author/"+slug+"/";
  for(const endpoint of ["/api/public/site","/api/public/templates/pretty-taxonomy-direct"]){
   for(const visible of [path,path+"?page=2"]){const r=await api(endpoint+"?"+new URLSearchParams({requestPath:visible,category:slug,page:"2"}),"GET",undefined,true);assert.equal(r.response.status,200,JSON.stringify({endpoint,visible,status:r.response.status,body:r.text}));if(endpoint.endsWith("site")){assert.equal(r.data.pagination.page,2);assert.equal(r.data.posts.length,1);assert.ok(posts.slice(0,2).includes(r.data.posts[0].id));}else{assert.match(r.data.content,/INDEPENDENT-TAXONOMY/);assert.doesNotMatch(r.data.content,/OUTSIDE-CATEGORY-AUTHOR-ITEM/);}}
   const conflicting=await api(endpoint+"?"+new URLSearchParams({requestPath:path+"?page=2",category:slug,page:"1"}),"GET",undefined,true);assert.equal(conflicting.response.status,400);
  }
 }finally{if(documents.length)await pool.query("DELETE FROM site_documents WHERE id=ANY($1::int[])",[documents]);if(posts.length)await pool.query("DELETE FROM posts WHERE id=ANY($1::int[])",[posts]);if(terms.length)await pool.query("DELETE FROM terms WHERE id=ANY($1::int[])",[terms]);if(people.length)await pool.query("DELETE FROM users WHERE id=ANY($1::int[])",[people]);await pool.query("UPDATE settings SET data=$1 WHERE id=1",[original]);}
});
