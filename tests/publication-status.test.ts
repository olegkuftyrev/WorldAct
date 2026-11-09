import test,{after} from "./isolated-test.js";
import assert from "node:assert/strict";
import {pool} from "../server/db.js";
import {publishDuePosts} from "../server/core.js";
import {publicationStatusAt} from "../shared/publication-status.js";
const base=process.env.TEST_API_URL!,origin=process.env.APP_ORIGIN!;
after(()=>pool.end());

test("publication classification floors both explicit instants without mutating fractions or other statuses",()=>{
 const now=new Date("2026-11-08T12:34:56.987Z");
 for(const requested of ["publish","future"])for(const delta of [-1,0,59,60,61]){
  const chosen=new Date(Math.floor(now.valueOf()/1000)*1000+delta*1000+123),before=chosen.toISOString();
  assert.equal(publicationStatusAt(requested,chosen,now),delta>=60?"future":"publish");assert.equal(chosen.toISOString(),before);
 }
 assert.equal(publicationStatusAt("publish","2026-11-08T12:35:56.001Z",now),"future");
 assert.equal(publicationStatusAt("future","2026-11-08T12:35:55.999Z",now),"publish");
 assert.equal(publicationStatusAt("publish","2026-11-08T18:20:56.001+05:45",now),"future");
 for(const status of ["draft","pending","private","trash","auto-draft"])assert.equal(publicationStatusAt(status,null,now),status);
 for(const invalid of [null,"2026-11-08T12:35:56","2026-02-30T12:35:56Z",new Date(NaN)])assert.throws(()=>publicationStatusAt("publish",invalid,now));
 assert.throws(()=>publicationStatusAt("future","2026-11-08T12:35:56Z",new Date(NaN)));
});

test("actual core and REST saves preserve publication intent, permissions, revisions and exact scheduler effects",async t=>{
 const original=(await pool.query("SELECT data FROM settings WHERE id=1")).rows[0].data,posts:number[]=[],users:number[]=[];let admin="";const stamp="publication-policy-"+Date.now();
 async function api(path:string,method="GET",body?:unknown,cookie=admin){const response=await fetch(base+path,{method,headers:{Origin:origin,Cookie:cookie,"Content-Type":"application/json"},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(15000)}),data=await response.json();return {response,data};}
 async function ok(path:string,method="GET",body?:unknown,cookie=admin){const result=await api(path,method,body,cookie);assert.ok(result.response.ok,`${path}: ${result.response.status} ${JSON.stringify(result.data)}`);return result.data;}
 async function make(input:Record<string,unknown>={},cookie=admin){const p=(await ok("/api/posts","POST",{title:stamp+"-"+posts.length,status:"draft",content:"<p>STATUS-CONTENT-A</p>",...input},cookie)).post;posts.push(p.id);return p;}
 const saved=async(id:number)=>(await ok("/api/posts/"+id)).post;
 async function snapshot(id:number){return (await pool.query("SELECT * FROM posts WHERE id=$1",[id])).rows[0];}
 async function nullable(p:any,status:string,civil:string,legacyPublication="2000-01-01T00:00:00Z",due:string|null=null){await pool.query("UPDATE posts SET status=$2,post_date=$3,post_date_gmt=NULL,published_at=$4,scheduled_at=$5 WHERE id=$1",[p.id,status,civil,legacyPublication,due]);}
 async function user(role:string,label=role){const username=stamp+"-"+label,password="Publication-policy-password-123",record=(await ok("/api/users","POST",{username,email:username+"@example.test",displayName:"Status policy "+label,role,password})).user;users.push(record.id);const login=await api("/api/auth/login","POST",{login:username,password},"");assert.equal(login.response.status,200);return {...record,cookie:login.response.headers.get("set-cookie")!.split(";")[0]};}
 try{
  const signed=await api("/api/auth/login","POST",{login:process.env.ADMIN_EMAIL,password:process.env.ADMIN_PASSWORD},"");assert.equal(signed.response.status,200);admin=signed.response.headers.get("set-cookie")!.split(";")[0];await ok("/api/settings","PUT",{timezone:"UTC",permalinkStructure:"/%year%/%monthnum%/%day%/%postname%/",pingServices:[]});
  await t.test("post and page transitions share selected GMT classification and public visibility",async()=>{
   for(const type of ["post","page"]){const scheduled=await make({type,status:"publish",postDate:"2099-02-03T04:05:06"});assert.equal(scheduled.status,"future");assert.equal(scheduled.scheduledAt,scheduled.postDateGmt);assert.equal((await fetch(base+scheduled.permalink)).status,404);
    const published=(await ok("/api/posts/"+scheduled.id,"PUT",{status:"future",postDate:"2001-02-03T04:05:06",version:scheduled.version})).post;assert.equal(published.status,"publish");assert.equal(published.publishedAt,published.postDateGmt);assert.equal((await fetch(base+published.permalink)).status,200);
   }
  });
  await t.test("REST local precedence, fractional GMT and explicit offsets retain their selected instant",async()=>{
   const rest=await ok("/wp-json/wp/v2/posts","POST",{title:stamp+"-rest",status:"publish",date:"2099-02-03T04:05:06.123",date_gmt:"2001-02-03T04:05:06"});posts.push(rest.id);assert.equal(rest.status,"future");let p=await saved(rest.id);assert.equal(p.postDateGmt,"2099-02-03T04:05:06.123Z");assert.equal(p.scheduledAt,p.postDateGmt);
   const result=await ok("/wp-json/wp/v2/posts/"+rest.id,"POST",{date:"2001-02-03T04:05:06.456+05:45",date_gmt:"2099-02-03T04:05:06"});assert.equal(result.status,"publish");p=await saved(rest.id);assert.equal(p.postDateGmt,"2001-02-02T22:20:06.456Z");assert.equal(p.publishedAt,p.postDateGmt);
  });
  await t.test("inherited future resynchronizes active due while fixed pair and inactive publication survive a zone change",async()=>{
   const p=await make({status:"future",postDate:"2099-02-03T04:05:06"});await pool.query("UPDATE posts SET scheduled_at='2100-01-01T00:00:00Z',published_at='1999-01-01T00:00:00Z' WHERE id=$1",[p.id]);await ok("/api/settings","PUT",{timezone:"+05:45"});const updated=(await ok("/api/posts/"+p.id,"PUT",{title:p.title+" edited"})).post;assert.equal(updated.status,"future");assert.equal(updated.postDate,p.postDate);assert.equal(updated.postDateGmt,p.postDateGmt);assert.equal(updated.scheduledAt,p.postDateGmt);assert.equal(updated.publishedAt,"1999-01-01T00:00:00.000Z");await ok("/api/settings","PUT",{timezone:"UTC"});
  });
  await t.test("touched publish and future null GMT fix their unchanged civil in current zone; private remains null",async()=>{
   await ok("/api/settings","PUT",{timezone:"+05:45"});
   const published=await make();await nullable(published,"publish","2001-02-03T04:05:06");const updated=(await ok("/api/posts/"+published.id,"PUT",{title:published.title+" fixed"})).post;assert.equal(updated.status,"publish");assert.equal(updated.postDate,"2001-02-03T04:05:06");assert.equal(updated.postDateGmt,"2001-02-02T22:20:06.000Z");assert.equal(updated.publishedAt,"2000-01-01T00:00:00.000Z");
   const future=await make();await nullable(future,"future","2099-02-03T04:05:06","2000-01-01T00:00:00Z","2100-01-01T00:00:00Z");const fixed=(await ok("/api/posts/"+future.id,"PUT",{title:future.title+" fixed"})).post;assert.equal(fixed.status,"future");assert.equal(fixed.postDate,"2099-02-03T04:05:06");assert.equal(fixed.postDateGmt,"2099-02-02T22:20:06.000Z");assert.equal(fixed.scheduledAt,fixed.postDateGmt);
   const privatePost=await make();await nullable(privatePost,"private","2001-02-03T04:05:06");const privateSaved=(await ok("/api/posts/"+privatePost.id,"PUT",{title:privatePost.title+" private"})).post;assert.equal(privateSaved.status,"private");assert.equal(privateSaved.postDateGmt,null);assert.equal(privateSaved.postDate,"2001-02-03T04:05:06");await ok("/api/settings","PUT",{timezone:"UTC"});
  });
  await t.test("a stored null-GMT DST gap fails atomically instead of changing civil or adding a revision",async()=>{
   const p=await make();await nullable(p,"publish","2024-03-10T02:30:00");await ok("/api/settings","PUT",{timezone:"America/Los_Angeles"});const before=await snapshot(p.id),revisions=(await ok(`/api/posts/${p.id}/revisions`)).revisions.length,result=await api("/api/posts/"+p.id,"PUT",{title:p.title+" forbidden roll"});assert.equal(result.response.status,400);assert.deepEqual(await snapshot(p.id),before);assert.equal((await ok(`/api/posts/${p.id}/revisions`)).revisions.length,revisions);await ok("/api/settings","PUT",{timezone:"UTC"});
  });
  await t.test("explicit reset can normalize future to publish while missing schedule intent remains400",async()=>{
   const p=await make({status:"future",postDate:"2099-02-03T04:05:06"}),before=Date.now(),reset=(await ok("/api/posts/"+p.id,"PUT",{status:"future",postDate:null})).post;assert.equal(reset.status,"publish");assert.ok(Date.parse(reset.postDateGmt)>=before);assert.equal(reset.scheduledAt,null);
   for(const body of [{status:"future"},{status:"future",scheduledAt:null}])assert.equal((await api("/api/posts","POST",{title:stamp+"-missing",...body})).response.status,400);
   const floating=await make();assert.equal((await api("/api/posts/"+floating.id,"PUT",{status:"future"})).response.status,400);
  });
  await t.test("bulk reset cannot hide malformed civil or a current-zone DST gap and never accepts a client intent flag",async()=>{
   const p=await make({postDate:"2099-02-03T04:05:06"});await ok("/api/settings","PUT",{timezone:"America/Los_Angeles"});for(const changes of [{status:"publish",postDate:"not-civil"},{status:"publish",postDate:"2024-03-10T02:30:00"},{status:"publish",postDate:"2024-03-10T02:30:00",scheduledAt:null}]){const before=await snapshot(p.id),result=await ok("/api/posts/bulk","POST",{ids:[p.id],changes});assert.equal(result.updated.length,0);assert.equal(result.errors[0].status,400);assert.deepEqual(await snapshot(p.id),before);}assert.equal((await api("/api/posts/bulk","POST",{ids:[p.id],changes:{status:"publish",publishNow:true}})).response.status,400);await ok("/api/settings","PUT",{timezone:"UTC"});
  });
  await t.test("bulk resets only draft/future, preserves other selected dates, and clears inactive due on Publish Now",async()=>{
   for(const status of ["draft","future"]){const p=await make({status,postDate:"2099-02-03T04:05:06"});const before=Date.now(),result=await ok("/api/posts/bulk","POST",{ids:[p.id],changes:{status:"publish",postDate:"2100-02-03T04:05:06"}}),record=result.posts[0];assert.equal(record.status,"publish");assert.ok(Date.parse(record.postDateGmt)>=before);assert.equal(record.scheduledAt,null);}
   for(const status of ["pending","private","publish"]){const p=await make({status:status==="publish"?"draft":status,postDate:"2001-02-03T04:05:06"});if(status==="publish")await pool.query("UPDATE posts SET status='publish',published_at='1999-01-01T00:00:00Z' WHERE id=$1",[p.id]);const result=await ok("/api/posts/bulk","POST",{ids:[p.id],changes:{status:"publish"}});assert.equal(result.posts[0].postDateGmt,"2001-02-03T04:05:06.000Z");assert.equal(result.posts[0].publishedAt,status==="publish"?"1999-01-01T00:00:00.000Z":"2001-02-03T04:05:06.000Z");}
  });
  const editor=await user("editor"),author=await user("author"),other=await user("author","other"),contributor=await user("contributor");
  await t.test("requested and resulting publication permissions remain enforced",async()=>{
   for(const person of [editor,author]){const p=await make({status:"publish",postDate:"2099-02-03T04:05:06"},person.cookie);assert.equal(p.status,"future");}
   const p=await make({},contributor.cookie),before=await snapshot(p.id);for(const status of ["publish","future"]){assert.equal((await api("/api/posts/"+p.id,"PUT",{status,postDate:"2001-02-03T04:05:06"},contributor.cookie)).response.status,403);assert.equal((await api("/api/posts","POST",{title:stamp+"-denied",status,postDate:"2001-02-03T04:05:06"},contributor.cookie)).response.status,403);}assert.deepEqual(await snapshot(p.id),before);const bulk=await ok("/api/posts/bulk","POST",{ids:[p.id],changes:{status:"publish"}},contributor.cookie);assert.equal(bulk.errors[0].status,403);assert.equal((await api("/api/posts","POST",{title:stamp+"-author-page",type:"page",status:"publish"},author.cookie)).response.status,403);
  });
  await t.test("mixed bulk keeps success per item and ownership lease stale-version and deletion errors",async()=>{
   const good=await make({postDate:"2099-02-03T04:05:06"},author.cookie),forbidden=await make({postDate:"2099-02-03T04:05:06"},other.cookie),locked=await make({postDate:"2099-02-03T04:05:06"},author.cookie),stale=await make({postDate:"2099-02-03T04:05:06"},author.cookie);
   await ok(`/api/posts/${locked.id}/lock`,"PUT",{},editor.cookie);const snapshots=await Promise.all([forbidden,locked,stale].map(p=>snapshot(p.id))),result=await ok("/api/posts/bulk","POST",{ids:[good.id,forbidden.id,locked.id,stale.id,2147483600],versions:{[good.id]:good.version,[stale.id]:stale.version+1},changes:{status:"publish"}},author.cookie);assert.deepEqual(result.updated,[good.id]);const errors=new Map(result.errors.map((r:any)=>[r.id,r.status]));assert.equal(errors.get(forbidden.id),403);assert.equal(errors.get(locked.id),409);assert.equal(errors.get(stale.id),409);assert.equal(errors.get(2147483600),404);assert.equal(result.posts[0].status,"publish");for(const [i,p]of [forbidden,locked,stale].entries())assert.deepEqual(await snapshot(p.id),snapshots[i]);
  });
  await t.test("date/status-only transitions add no content revision and restore preserves current publication pair",async()=>{
   let p=await make({postDate:"2099-02-03T04:05:06"});const count=async()=>(await ok(`/api/posts/${p.id}/revisions`)).revisions.length;assert.equal(await count(),0);p=(await ok(`/api/posts/${p.id}`,"PUT",{status:"publish"})).post;assert.equal(p.status,"future");assert.equal(await count(),0);p=(await ok(`/api/posts/${p.id}`,"PUT",{status:"future",postDate:"2001-02-03T04:05:06"})).post;assert.equal(p.status,"publish");assert.equal(await count(),0);await ok(`/api/posts/${p.id}`,"PUT",{content:"<p>STATUS-CONTENT-B</p>"});const revision=(await ok(`/api/posts/${p.id}/revisions`)).revisions[0];assert.equal(await count(),1);p=(await ok(`/api/posts/${p.id}`,"PUT",{status:"future",postDate:"2100-03-04T05:06:07"})).post;const restored=(await ok(`/api/posts/${p.id}/revisions/${revision.id}/restore`,"POST",{version:p.version})).post;assert.equal(restored.status,p.status);assert.equal(restored.postDate,p.postDate);assert.equal(restored.postDateGmt,p.postDateGmt);assert.equal(restored.scheduledAt,p.scheduledAt);assert.equal(restored.publishedAt,p.publishedAt);assert.match(restored.rawContent,/STATUS-CONTENT-A/);
  });
  await t.test("direct scheduler keeps exact due minus1/exact/plus1 and one publication/outbox effect",async()=>{
   const p=await make({status:"future",scheduledAt:"2099-02-03T04:05:06.123Z"}),due=Date.parse(p.scheduledAt);assert.equal((await pool.query("SELECT count(*)::int n FROM outgoing_ping_jobs WHERE post_id=$1",[p.id])).rows[0].n,0);assert.deepEqual(await publishDuePosts(new Date(due-1),[p.id]),[]);assert.equal((await saved(p.id)).status,"future");assert.deepEqual(await publishDuePosts(new Date(due),[p.id]),[p.id]);const published=await saved(p.id),jobs=(await pool.query("SELECT id,generation,state FROM outgoing_ping_jobs WHERE post_id=$1 ORDER BY id",[p.id])).rows;assert.equal(published.version,p.version+1);assert.equal(published.publishedAt,p.scheduledAt);assert.equal(published.postDate,p.postDate);assert.equal(published.postDateGmt,p.postDateGmt);assert.equal(jobs.length,1);assert.equal(jobs[0].generation,1);assert.equal(jobs[0].state,"suppressed");assert.deepEqual(await publishDuePosts(new Date(due+1),[p.id]),[]);assert.equal((await saved(p.id)).version,published.version);assert.deepEqual((await pool.query("SELECT id,generation,state FROM outgoing_ping_jobs WHERE post_id=$1 ORDER BY id",[p.id])).rows,jobs);
  });
 }finally{if(posts.length)await pool.query("DELETE FROM posts WHERE id=ANY($1::int[])",[posts]);if(users.length)await pool.query("DELETE FROM users WHERE id=ANY($1::int[])",[users]);await pool.query("UPDATE settings SET data=$1 WHERE id=1",[original]);}
});
