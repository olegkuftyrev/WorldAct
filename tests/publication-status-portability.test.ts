import test,{after} from "./isolated-test.js";
import assert from "node:assert/strict";
import {readFile,writeFile} from "node:fs/promises";
import {pool} from "../server/db.js";
const stage=process.env.PUBLICATION_ARCHIVE_STAGE,file=process.env.PUBLICATION_ARCHIVE_PATH,base=process.env.TEST_API_URL!,origin=process.env.APP_ORIGIN!;
after(()=>pool.end());

test("publication results cross fresh IDs owners and zones without running save policy during raw restore",{skip:!stage||!file},async()=>{
 let cookie="";
 async function api(path:string,method="GET",body?:unknown){const response=await fetch(base+path,{method,headers:{Origin:origin,Cookie:cookie,"Content-Type":"application/json"},body:body===undefined?undefined:JSON.stringify(body)}),data=await response.json();assert.ok(response.ok,`${path}: ${response.status} ${JSON.stringify(data)}`);return {response,data};}
 async function login(login=process.env.ADMIN_EMAIL!,password=process.env.ADMIN_PASSWORD!){const r=await api("/api/auth/login","POST",{login,password});cookie=r.response.headers.get("set-cookie")!.split(";")[0];}
 await login();const password="Publication-archive-fixture-password-123",source=stage==="export";
 if(!source)await api("/api/users","POST",{username:"publication-padding",email:"publication-padding@example.test",displayName:"ID padding",role:"subscriber",password});
 const owner=(await api("/api/users","POST",{username:source?"Publication.Source@Author":"Publication.Destination@Admin",email:source?"publication-source@example.test":"publication-destination@example.test",displayName:source?"Publication source":"Publication destination",role:source?"author":"administrator",password})).data.user;
 const structure="/publication/%author%/%year%/%monthnum%/%day%/%hour%/%minute%/%second%/%post_id%/%postname%/";
 if(source){
  await api("/api/settings","PUT",{timezone:"UTC",pingServices:[],permalinkStructure:structure});const records:any[]=[];
  async function make(label:string,body:Record<string,unknown>={}){const p=(await api("/api/posts","POST",{title:"Publication portable "+label,status:"draft",authorId:owner.id,content:"<p>PUBLICATION-PORTABLE-"+label+"</p>",...body})).data.post;records.push(p);return p;}
  const scheduled=await make("scheduled",{status:"publish",postDate:"2099-02-03T04:05:06"});assert.equal(scheduled.status,"future");assert.equal(scheduled.scheduledAt,scheduled.postDateGmt);
  const published=await make("published",{status:"future",postDate:"2001-02-03T04:05:06"});assert.equal(published.status,"publish");assert.equal(published.publishedAt,published.postDateGmt);
  const draft=await make("bulk-now",{postDate:"2099-02-03T04:05:06"}),bulk=(await api("/api/posts/bulk","POST",{ids:[draft.id],changes:{status:"publish",postDate:"2100-01-02T03:04:05"}})).data;assert.equal(bulk.posts[0].status,"publish");assert.equal(bulk.posts[0].publishedAt,bulk.posts[0].postDateGmt);assert.equal(bulk.posts[0].scheduledAt,null);
  const divergent=await make("divergent-published");await pool.query("UPDATE posts SET status='publish',post_date='1984-02-29T01:02:03',post_date_gmt='2099-02-03T04:05:06Z',published_at='1999-01-01T00:00:00Z',scheduled_at='2100-01-01T00:00:00Z' WHERE id=$1",[divergent.id]);
  const pastFuture=await make("divergent-future");await pool.query("UPDATE posts SET status='future',post_date='2001-02-03T04:05:06',post_date_gmt='2001-02-03T04:05:06Z',published_at='1999-01-01T00:00:00Z',scheduled_at='2100-01-01T00:00:00Z' WHERE id=$1",[pastFuture.id]);
  const unfixed=await make("private-unfixed");await pool.query("UPDATE posts SET status='private',post_date='2024-03-10T02:30:00',post_date_gmt=NULL WHERE id=$1",[unfixed.id]);
  const archive=(await api("/api/tools/export")).data;assert.equal(archive.version,4);await writeFile(file!,JSON.stringify({archive,sourceOwner:owner.id,sourceIds:records.map(p=>p.id)}),{mode:0o600});return;
 }
 assert.equal(stage,"restore");const fixture=JSON.parse(await readFile(file!,"utf8"));assert.notEqual(owner.id,fixture.sourceOwner);await login(owner.email,password);for(let i=0;i<7;i++)await api("/api/posts","POST",{title:"Publication destination padding "+i,status:"draft"});
 const expected=fixture.archive.posts.filter((p:any)=>p.title.startsWith("Publication portable "));
 for(const replaceDesign of [false,true]){
  await api("/api/settings","PUT",{timezone:"+05:45",pingServices:[],permalinkStructure:structure.replace("/publication/","/destination/")});const restored=(await api("/api/tools/import","POST",{...fixture.archive,replaceDesign})).data;
  const records=(await pool.query("SELECT * FROM posts WHERE id=ANY($1::int[])",[restored.postIds])).rows,posts=new Map<string,any>();
  for(const old of expected){const row=records.find(p=>p.title===old.title);assert.ok(row,old.title);assert.ok(!fixture.sourceIds.includes(row.id));assert.equal(row.author_id,owner.id);assert.equal(row.status,old.status==="future"?"draft":old.status);assert.equal(row.post_date,old.post_date);assert.equal(row.post_date_gmt?.toISOString()??null,old.post_date_gmt);assert.equal(row.published_at?.toISOString()??null,old.published_at);assert.equal(row.scheduled_at?.toISOString()??null,old.scheduled_at);posts.set(old.title.replace("Publication portable ",""),(await api("/api/posts/"+row.id)).data.post);}
  assert.equal((await api("/api/settings")).data.settings.timezone,replaceDesign?"UTC":"+05:45");
  for(const [label,p]of posts){const response=await fetch(base+p.permalink);assert.equal(response.status,p.status==="publish"?200:404,label);const listed=(await api("/api/posts?"+new URLSearchParams({status:p.status,search:p.title,perPage:"100"}))).data.posts;assert.ok(listed.some((r:any)=>r.id===p.id),label);const rest=(await api("/wp-json/wp/v2/posts/"+p.id+"?context=edit")).data;assert.equal(rest.status,p.status);assert.equal(rest.date,p.postDate);}
  const outgoing=(await api("/api/tools/export")).data;for(const p of posts.values()){const row=outgoing.posts.find((r:any)=>r.id===p.id);assert.equal(row.status,p.status);assert.equal(row.post_date,p.postDate);assert.equal(row.post_date_gmt,p.postDateGmt);assert.equal(row.scheduled_at,p.scheduledAt);assert.equal(row.published_at,p.publishedAt);}
  const divergent=posts.get("divergent-published"),saved=(await api("/api/posts/"+divergent.id,"PUT",{title:divergent.title+" touched"})).data.post;assert.equal(saved.status,"future");assert.equal(saved.postDate,divergent.postDate);assert.equal(saved.postDateGmt,divergent.postDateGmt);assert.equal(saved.scheduledAt,saved.postDateGmt);assert.equal(saved.publishedAt,divergent.publishedAt);assert.equal((await fetch(base+saved.permalink)).status,404);
  const importedFuture=posts.get("divergent-future"),published=(await api("/api/posts/"+importedFuture.id,"PUT",{status:"publish"})).data.post;assert.equal(published.status,"publish");assert.equal(published.postDate,importedFuture.postDate);assert.equal(published.postDateGmt,importedFuture.postDateGmt);assert.equal(published.publishedAt,published.postDateGmt);assert.equal(published.scheduledAt,importedFuture.scheduledAt);assert.equal((await fetch(base+published.permalink)).status,200);
  const unfixed=posts.get("private-unfixed"),privateSaved=(await api("/api/posts/"+unfixed.id,"PUT",{title:unfixed.title+" untouched date"})).data.post;assert.equal(privateSaved.status,"private");assert.equal(privateSaved.postDate,unfixed.postDate);assert.equal(privateSaved.postDateGmt,null);
 }
 assert.equal((await pool.query("SELECT count(*)::int n FROM users WHERE username='Publication.Source@Author'")).rows[0].n,0);
});
