import test, { after } from "./isolated-test.js";
import assert from "node:assert/strict";
import { pool } from "../server/db.js";
import { shouldResolveStaticFrontPage } from "../src/plainPermalinkRouting.js";
const base=process.env.TEST_API_URL!,origin=process.env.APP_ORIGIN!;
after(()=>pool.end());
test("saved static-front identity survives unavailable page transitions and the adapter delegates its real404 without consuming archives",async t=>{
 const initial=(await pool.query("SELECT data FROM settings WHERE id=1")).rows[0].data,ids:number[]=[];let cookie="";
 async function request(path:string,method="GET",body?:unknown,auth=cookie){const response=await fetch(base+path,{method,headers:{Origin:origin,"Content-Type":"application/json",...(auth?{Cookie:auth}:{})},...(body===undefined?{}:{body:JSON.stringify(body)})});return {response,data:await response.json()};}
 async function api(path:string,method="GET",body?:unknown,auth=cookie){const r=await request(path,method,body,auth);assert.ok(r.response.ok,`${path}: ${r.response.status} ${JSON.stringify(r.data)}`);return r;}
 async function site(){return(await api("/api/public/site","GET",undefined,"")).data;}
 async function resolve(path:string){return request("/api/public/resolve?"+new URLSearchParams({path}),"GET",undefined,"");}
 try{
  const login=await api("/api/auth/login","POST",{login:process.env.ADMIN_EMAIL,password:process.env.ADMIN_PASSWORD},"");cookie=login.response.headers.get("set-cookie")!.split(";")[0];
  const stamp="front-availability-"+Date.now(),front=(await api("/api/posts","POST",{type:"page",title:stamp,status:"publish",content:"<p>FRONT AVAILABLE FIRST</p><!--nextpage--><p>FRONT AVAILABLE SECOND</p>"})).data.post;ids.push(front.id);
  const blog=(await api("/api/posts","POST",{type:"page",title:stamp+" posts",status:"publish",content:"<p>POSTS EDITOR BODY</p>"})).data.post;ids.push(blog.id);
  await api("/api/settings","PUT",{permalinkStructure:"",frontPageMode:"page",frontPageId:front.id,postsPageId:blog.id});
  const published=await site();assert.equal(published.frontPage.id,front.id);assert.equal(shouldResolveStaticFrontPage("/",new URLSearchParams(),published),false);assert.equal(shouldResolveStaticFrontPage("/",new URLSearchParams("page=2"),published),true);assert.match((await resolve("/?page=2")).data.post.content,/FRONT AVAILABLE SECOND/);
  for(const status of ["private","draft","trash"]){await t.test(status+" front remains a selected identity and delegates root/counters to404",async()=>{
   await api("/api/posts/"+front.id,"PUT",{status});const data=await site();assert.equal(data.settings.frontPageId,front.id);assert.equal(data.frontPage,null);assert.doesNotMatch(JSON.stringify(data),/FRONT AVAILABLE/);
   for(const query of ["","page=2","page=2&query-4-page=2&commentPage=2","query-4-page=2&commentPage=2","s=","page=2&s=","category=","author=","year=","page=2&monthnum="]){assert.equal(shouldResolveStaticFrontPage("/",new URLSearchParams(query),data),true,query);const result=await resolve("/"+(query?"?"+query:""));assert.equal(result.response.status,404,query);assert.doesNotMatch(JSON.stringify(result.data),/FRONT AVAILABLE/);}
   for(const filter of ["search","s","category","tag","author","year","monthnum","day","m","w"])assert.equal(shouldResolveStaticFrontPage("/",new URLSearchParams(filter+"=actual-archive&page=2"),data),false,filter);
   await api("/api/posts/"+front.id,"PUT",{status:"publish"});assert.equal((await site()).frontPage.id,front.id);
  });}
  await t.test("deletion and a stale saved ID cannot silently become a posts home",async()=>{
   await api("/api/posts/"+front.id,"PUT",{status:"trash"});await api("/api/posts/"+front.id,"DELETE");const data=await site();assert.equal(data.settings.frontPageId,front.id);assert.equal(data.frontPage,null);assert.equal(shouldResolveStaticFrontPage("/",new URLSearchParams(),data),true);assert.equal((await resolve("/")).response.status,404);
   const stale=2147483647;await pool.query("UPDATE settings SET data=data || $1::jsonb WHERE id=1",[JSON.stringify({frontPageId:stale})]);const staleSite=await site();assert.equal(staleSite.frontPage,null);assert.equal(shouldResolveStaticFrontPage("/",new URLSearchParams("page=2&query-4-page=3&commentPage=2"),staleSite),true);assert.equal((await resolve("/?page=2")).response.status,404);
  });
  await t.test("ordinary posts home and a password-protected published front retain their real semantics",async()=>{
   await api("/api/settings","PUT",{frontPageMode:"posts",frontPageId:null});assert.equal(shouldResolveStaticFrontPage("/",new URLSearchParams("page=2"),await site()),false);
   const protectedFront=(await api("/api/posts","POST",{type:"page",title:stamp+" protected",status:"publish",password:"Front-test-password-123",content:"<p>PROTECTED FRONT SECRET</p><!--nextpage--><p>PROTECTED FRONT SECOND</p>"})).data.post;ids.push(protectedFront.id);await api("/api/settings","PUT",{frontPageMode:"page",frontPageId:protectedFront.id});const data=await site();assert.equal(data.frontPage.id,protectedFront.id);assert.equal(data.frontPage.locked,true);assert.equal(shouldResolveStaticFrontPage("/",new URLSearchParams(),data),false);assert.equal(shouldResolveStaticFrontPage("/",new URLSearchParams("page=2"),data),true);const locked=await resolve("/?page=2");assert.equal(locked.response.status,200);assert.equal(locked.data.post.locked,true);assert.doesNotMatch(JSON.stringify(locked.data),/PROTECTED FRONT (SECRET|SECOND)/);
  });
 }finally{await pool.query("DELETE FROM posts WHERE id=ANY($1::int[])",[ids]);await pool.query("UPDATE settings SET data=$1::jsonb WHERE id=1",[JSON.stringify(initial)]);}
});
