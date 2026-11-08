import test, { before, after } from "./isolated-test.js";
import assert from "node:assert/strict";
import { pool, getSettings } from "../server/db.js";
import { version } from "../package.json";
const base=process.env.TEST_API_URL!,origin=process.env.APP_ORIGIN!;
let admin:any,initialSettings:any,adminCookie="",authorCookie="",contributorCookie="",subscriberCookie="";
const users:number[]=[],posts:number[]=[],ownDrafts:number[]=[],otherDrafts:number[]=[],published:number[]=[],future:number[]=[];
let contributorPost:number;
async function login(login:string){
  const r=await fetch(base+"/api/auth/login",{method:"POST",headers:{Origin:origin,"Content-Type":"application/json"},body:JSON.stringify({login,password:process.env.ADMIN_PASSWORD})});assert.equal(r.status,200);return r.headers.get("set-cookie")!.split(";")[0];
}
async function dashboard(cookie=adminCookie){const r=await fetch(base+"/api/dashboard",{headers:cookie?{Cookie:cookie}:{}});return {status:r.status,...await r.json()};}
async function post(author:number,status:string,type="post",date=new Date(),updated=date){
  const n=posts.length;
  const row=(await pool.query(`INSERT INTO posts(type,title,slug,content,raw_content,status,author_id,published_at,scheduled_at,updated_at,password_hash) VALUES($1,$2,$3,$4,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,[type,"Dashboard fixture "+n,"dashboard-fixture-"+n,"<p>One two three four five six seven eight nine ten eleven twelve.</p>",status,author,status==="publish"?date:null,status==="future"?date:null,updated,status==="publish"?"protected-fixture-marker":null])).rows[0];posts.push(row.id);return row.id as number;
}
before(async()=>{
  initialSettings=await getSettings();admin=(await pool.query("SELECT * FROM users WHERE lower(email)=lower($1)",[process.env.ADMIN_EMAIL])).rows[0];adminCookie=await login(process.env.ADMIN_EMAIL!);
  for(const role of ["author","contributor","subscriber"]){const email="dashboard-"+role+"-"+Date.now()+"@example.test";const id=(await pool.query("INSERT INTO users(username,email,display_name,password_hash,role) VALUES($1,$1,$2,$3,$4) RETURNING id",[email,role,admin.password_hash,role])).rows[0].id;users.push(id);const cookie=await login(email);if(role==="author")authorCookie=cookie;else if(role==="contributor")contributorCookie=cookie;else subscriberCookie=cookie;}
  const old=new Date("2020-01-01T00:00:00Z");
  published.push(await post(admin.id,"publish","post",old),await post(users[0],"publish","post",new Date("2021-01-01T00:00:00Z")));
  for(let i=0;i<6;i++){ownDrafts.push(await post(admin.id,"draft","post",old,new Date(Date.now()+i*1000)));otherDrafts.push(await post(users[0],"draft","post",old,new Date(Date.now()+i*1000+500)));}
  // More than the old shared limit of recently modified pages and private rows.
  for(let i=0;i<6;i++)await post(admin.id,i%2?"private":"draft","page",old,new Date(Date.now()+20_000+i*1000));
  for(const [owner,days] of [[admin.id,3],[users[0],2],[users[0],1],[users[1],4]])future.push(await post(owner,"future","post",new Date(Date.now()+days*86_400_000)));
  contributorPost=await post(users[1],"publish","post",new Date("2022-01-01T00:00:00Z"));
  await pool.query("INSERT INTO comments(post_id,author_name,author_email,content,status) VALUES($1,'Private email fixture','private-person@example.test','Comment preview','approved')",[contributorPost]);
});
after(async()=>{try{await pool.query("DELETE FROM posts WHERE id=ANY($1::int[])",[posts]);await pool.query("DELETE FROM users WHERE id=ANY($1::int[])",[users]);await pool.query("UPDATE settings SET data=data || $1::jsonb WHERE id=1",[JSON.stringify({theme:initialSettings.theme})]);}finally{await pool.end();}});

test("publication and own-draft queries remain independent of newer pages/statuses and use source order/limits",async()=>{
  const data=await dashboard();assert.equal(data.status,200);
  for(const id of published)assert.ok(data.recentPublished.some((row:any)=>row.id===id));
  assert.ok(data.recentPublished.every((row:any)=>row.type==="post"&&row.status==="publish"));
  assert.deepEqual(data.recentDrafts.map((row:any)=>row.id),[...ownDrafts].reverse().slice(0,4));
  assert.ok(data.recentDrafts.every((row:any)=>row.authorId===admin.id&&row.status==="draft"&&row.type==="post"));
  assert.equal(data.recentDrafts[0].preview,"One two three four five six seven eight nine ten…");
  assert.ok(data.publishingSoon.every((row:any)=>row.status==="future"&&row.canEdit));
  assert.deepEqual(data.publishingSoon.map((row:any)=>row.id),[future[2],future[1],future[0],future[3]]);
  assert.equal(data.recentPosts.length,5);assert.ok(!data.recentPosts.some((row:any)=>published.includes(row.id)));
});
test("readable publication metadata never exposes bodies and future/draft/comment permissions follow the actual actor",async()=>{
  const data=await dashboard(authorCookie);assert.equal(data.status,200);
  assert.ok(data.recentPublished.some((row:any)=>row.id===published[0]&&!row.canEdit));
  assert.ok(data.recentPublished.some((row:any)=>row.id===published[1]&&row.canEdit));
  for(const row of data.recentPublished){for(const field of ["content","rawContent","blocks","excerpt","footnotes","password_hash"])assert.equal(row[field],undefined);assert.ok(row.permalink.startsWith("/"));}
  assert.ok(data.recentDrafts.every((row:any)=>row.authorId===users[0]));assert.equal(data.recentDrafts.length,4);
  assert.deepEqual(data.publishingSoon.map((row:any)=>row.id),[future[2],future[1]]);
  const lower=await dashboard(contributorCookie);assert.equal(lower.status,200);assert.deepEqual(lower.publishingSoon,[]);
  assert.equal(lower.recentComments[0].authorEmail,undefined);assert.equal(lower.recentComments[0].userId,undefined);
  assert.ok(!JSON.stringify(lower).includes("private-person@example.test"));
  assert.equal((await dashboard(subscriberCookie)).status,403);assert.equal((await dashboard("")).status,401);
});
test("dashboard application and active-theme labels derive from actual registered metadata for all supported themes",async()=>{
  for(const [id,name] of [["twentytwentyfive","Twenty Twenty-Five"],["twentytwentyfour","Twenty Twenty-Four"],["twentytwentythree","Twenty Twenty-Three"],["classic","WorldAct Classic"]]){
    await pool.query("UPDATE settings SET data=data || $1::jsonb WHERE id=1",[JSON.stringify({theme:id})]);
    const data=await dashboard();assert.deepEqual(data.application,{name:"WorldAct",version});assert.equal(data.theme.id,id);assert.equal(data.theme.name,name);assert.ok(data.theme.version);
  }
});
