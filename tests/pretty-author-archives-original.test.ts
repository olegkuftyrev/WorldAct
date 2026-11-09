import test,{after} from "./isolated-test.js";
import assert from "node:assert/strict";
import {XMLParser} from "fast-xml-parser";
import {pool} from "../server/db.js";
after(()=>pool.end());
const base=process.env.TEST_API_URL!,origin=process.env.APP_ORIGIN!;
test("persisted nicenames identify pretty author archives and all current generated author URLs",async t=>{
 const original=(await pool.query("SELECT data FROM settings WHERE id=1")).rows[0].data,posts:number[]=[],people:number[]=[];let cookie="";
 async function request(path:string,method="GET",body?:unknown){const response=await fetch(base+path,{method,headers:{Origin:origin,Cookie:cookie,"Content-Type":"application/json"},body:body===undefined?undefined:JSON.stringify(body)});const text=await response.text();let data:any;try{data=JSON.parse(text);}catch{}return {response,text,data};}
 async function ok(path:string,method="GET",body?:unknown){const r=await request(path,method,body);assert.ok(r.response.ok,`${path} ${r.response.status} ${r.text}`);return r.data;}
 try{
  const sign=await request("/api/auth/login","POST",{login:process.env.ADMIN_EMAIL,password:process.env.ADMIN_PASSWORD});assert.equal(sign.response.status,200);cookie=sign.response.headers.get("set-cookie")!.split(";")[0];
  const stamp="pretty-author-"+Date.now(),person=(await ok("/api/users","POST",{username:stamp+".Login",email:stamp+"@example.test",displayName:"Pretty author display",role:"author",password:"Pretty-only-fixture-password"})).user;people.push(person.id);
  const slug=(await pool.query("SELECT nicename FROM users WHERE id=$1",[person.id])).rows[0].nicename;assert.notEqual(slug,person.username);const path="/journal/author/"+slug+"/";
  await ok("/api/settings","PUT",{permalinkStructure:"/journal/%postname%/",postsPerPage:1,pingServices:[]});
  for(let n=0;n<2;n++)posts.push((await ok("/api/posts","POST",{title:stamp+"-"+n,status:"publish",authorId:person.id,content:'<!-- wp:post-author-name {"isLink":true} /--><p>Pretty archive body.</p>'})).post.id);
  await t.test("native HTTP resolves persisted nicename under static permalink front",async()=>{const r=await request(path);assert.equal(r.response.status,200);assert.match(r.text,/Pretty author display/);});
  await t.test("resolver DTO pins the actual persisted author identity",async()=>{const r=await request("/api/public/resolve?"+new URLSearchParams({path}));assert.equal(r.response.status,200);assert.equal(r.data.archive.type,"author");assert.equal(r.data.archive.authorId,person.id);assert.equal(r.data.archive.slug,slug);assert.equal(r.data.archive.permalink,path);});
  await t.test("pretty page suffix remains archive paging with independent counters",async()=>{const r=await request("/api/public/document?"+new URLSearchParams({path:path+"page/2/?query-4-page=3&commentPage=2"}));assert.equal(r.response.status,200);assert.equal(r.data.status,200);assert.equal(r.data.route.kind,"archive");assert.equal(r.data.route.query.archivePage,2);assert.equal(r.data.route.query.contentPage,1);assert.equal(r.data.route.query.blockPages["query-4-page"],3);assert.equal(r.data.route.query.commentPage,2);assert.equal(r.data.site.posts[0].authorId,person.id);});
  await t.test("public REST users and post embeddings use the same pretty path",async()=>{const account=await ok("/wp-json/wp/v2/users/"+person.id),post=await ok("/wp-json/wp/v2/posts/"+posts[0]+"?_embed=author");assert.equal(account.link,path);assert.equal(post._embedded.author[0].link,path);});
  await t.test("source post-author-name links use persisted archive path",async()=>{const post=(await ok("/api/posts/"+posts[0])).post,r=await request("/api/public/posts/"+post.slug);assert.equal(r.response.status,200);assert.ok(r.data.post.content.includes('href="'+path+'"'),r.data.post.content);});
  await t.test("numeric aliases and recognized unknown author404 stay bounded",async()=>{assert.equal((await request("/?author="+person.id)).response.status,200);assert.equal((await request("/journal/author/absent-"+stamp+"/")).response.status,404);});
  await t.test("Plain generated author links retain their numeric alias",async()=>{await ok("/api/settings","PUT",{permalinkStructure:""});assert.equal((await ok("/wp-json/wp/v2/users/"+person.id)).link,"/?author="+person.id);});
 }finally{if(posts.length)await pool.query("DELETE FROM posts WHERE id=ANY($1::int[])",[posts]);if(people.length)await pool.query("DELETE FROM users WHERE id=ANY($1::int[])",[people]);await pool.query("UPDATE settings SET data=$1 WHERE id=1",[original]);}
});
