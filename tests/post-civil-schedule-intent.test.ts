import test,{after} from "./isolated-test.js";
import assert from "node:assert/strict";
import {pool} from "../server/db.js";
after(()=>pool.end());
const base=process.env.TEST_API_URL!,origin=process.env.APP_ORIGIN!;
test("civil clear and reload scheduling respect selected GMT rather than stale legacy due fields",async t=>{
 const original=(await pool.query("SELECT data FROM settings WHERE id=1")).rows[0].data,ids:number[]=[];let cookie="";
 async function api(path:string,method="GET",body?:unknown){const response=await fetch(base+path,{method,headers:{Origin:origin,Cookie:cookie,"Content-Type":"application/json"},body:body===undefined?undefined:JSON.stringify(body)});return {response,data:await response.json()};}
 async function ok(path:string,method="GET",body?:unknown){const r=await api(path,method,body);assert.ok(r.response.ok,JSON.stringify({path,status:r.response.status,data:r.data}));return r.data;}
 async function future(){await ok("/api/settings","PUT",{timezone:"America/Los_Angeles",pingServices:[]});const post=(await ok("/api/posts","POST",{title:"Civil schedule intent "+ids.length,status:"future",postDate:"2100-01-02T03:04:05"})).post;ids.push(post.id);return post;}
 try{
 const login=await api("/api/auth/login","POST",{login:process.env.ADMIN_EMAIL,password:process.env.ADMIN_PASSWORD});assert.equal(login.response.status,200);cookie=login.response.headers.get("set-cookie")!.split(";")[0];
 await t.test("clearing a saved future as draft clears the intentional due time",async()=>{
  const post=await future(),draft=(await ok(`/api/posts/${post.id}`,"PUT",{status:"draft",postDate:null})).post;
  assert.equal(draft.postDateGmt,null);assert.equal(draft.publishedAt,null);assert.equal(draft.scheduledAt,null);
 });
 await t.test("changed fixed draft schedules its selected GMT after reload and zone change",async()=>{
  const post=await future(),draft=(await ok(`/api/posts/${post.id}`,"PUT",{status:"draft",postDate:"2101-02-03T04:05:06"})).post;assert.notEqual(draft.postDateGmt,post.scheduledAt);
  await ok("/api/settings","PUT",{timezone:"+05:45"});const loaded=(await ok(`/api/posts/${post.id}`)).post;
  const scheduled=(await ok(`/api/posts/${post.id}`,"PUT",{status:"future",version:loaded.version})).post;
  assert.equal(scheduled.postDate,loaded.postDate);assert.equal(scheduled.postDateGmt,loaded.postDateGmt);assert.equal(scheduled.scheduledAt,loaded.postDateGmt);
 });
 await t.test("unchanged stale scheduledAt input does not override a newly chosen draft pair",async()=>{
  const post=await future(),draft=(await ok(`/api/posts/${post.id}`,"PUT",{status:"draft",postDate:"2101-02-03T04:05:06"})).post;
  const scheduled=(await ok(`/api/posts/${post.id}`,"PUT",{status:"future",scheduledAt:post.scheduledAt})).post;assert.equal(scheduled.scheduledAt,draft.postDateGmt);assert.equal(scheduled.postDate,draft.postDate);
 });
 await t.test("explicitly changed UTC schedule overrides the prior selected pair",async()=>{
  const post=await future();await ok(`/api/posts/${post.id}`,"PUT",{status:"draft",postDate:"2101-02-03T04:05:06"});
  const scheduled=(await ok(`/api/posts/${post.id}`,"PUT",{status:"future",scheduledAt:"2102-03-04T05:06:07Z"})).post;assert.equal(scheduled.scheduledAt,"2102-03-04T05:06:07.000Z");assert.equal(scheduled.postDateGmt,scheduled.scheduledAt);
 });
 await t.test("a clear does not resurrect old due time on later Schedule or Publish",async()=>{
  const post=await future();await ok(`/api/posts/${post.id}`,"PUT",{status:"draft",postDate:null});await ok("/api/settings","PUT",{timezone:"+05:45"});
  assert.equal((await api(`/api/posts/${post.id}`,"PUT",{status:"future"})).response.status,400);
  const published=(await ok(`/api/posts/${post.id}`,"PUT",{status:"publish"})).post;assert.equal(published.scheduledAt,null);assert.ok(published.postDateGmt);assert.notEqual(published.postDateGmt,post.scheduledAt);
 });
 await t.test("ordinary future content edits preserve every selected and legacy UTC publication field",async()=>{
  const post=await future();await ok("/api/settings","PUT",{timezone:"+05:45"});const changed=(await ok(`/api/posts/${post.id}`,"PUT",{content:"<p>Keep the actual due clock.</p>"})).post;
  for(const field of ["postDate","postDateGmt","scheduledAt","publishedAt","createdAt"])assert.equal(changed[field],post[field]);
 });
 }finally{await pool.query("DELETE FROM posts WHERE id=ANY($1::int[])",[ids]);await pool.query("UPDATE settings SET data=$1::jsonb WHERE id=1",[JSON.stringify(original)]);}
});
