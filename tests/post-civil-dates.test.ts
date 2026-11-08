import test,{after} from "./isolated-test.js";
import assert from "node:assert/strict";
import {randomBytes} from "node:crypto";
import {pool,getSettings,getPost} from "../server/db.js";
import {migratePostDates} from "../server/post-date-migration.js";
import {parsePostCivil,civilFromInstant,postCivilInstant,formatPostCivil,postPublicationKey} from "../shared/post-civil-date.js";
import {resolvePostDate,publicationPair} from "../server/post-date.js";
import {postPermalink} from "../server/permalinks.js";
import {publishDuePosts} from "../server/core.js";
import {parseHTML} from "linkedom";
import {XMLParser} from "fast-xml-parser";
after(()=>pool.end());
const base=process.env.TEST_API_URL!,origin=process.env.APP_ORIGIN!;

test("civil grammar, explicit-zone formatting and chosen fixed/floating pairs are host-independent",()=>{
 for(const value of ["0001-01-01T00:00:00","9999-12-31T23:59:59","2024-02-29T12:34:56"])assert.equal(parsePostCivil(value),value);
 for(const value of ["0000-01-01T00:00:00","10000-01-01T00:00:00","2023-02-29T00:00:00","2024-04-31T00:00:00","2024-01-01T24:00:00","2024-01-01T00:00:60","2024-01-01T00:00:00Z","2024-01-01T00:00:00.123"])assert.equal(parsePostCivil(value),null,value);
 assert.equal(civilFromInstant("2024-12-31T18:15:07.123Z","+05:45"),"2025-01-01T00:00:07");
 assert.equal(formatPostCivil("2024-02-29T23:30:07","Y-m-d H:i:s \\Y P","+05:45"),"2024-02-29 23:30:07 Y +05:45");
 assert.throws(()=>postCivilInstant("0001-01-01T00:00:00","+14:00"));
 assert.throws(()=>postCivilInstant("9999-12-31T23:59:59","-12:00"));
 const now=new Date("2026-01-01T00:00:00.123Z");
 assert.deepEqual(resolvePostDate({},undefined,"draft","America/Los_Angeles",now),{postDate:"2025-12-31T16:00:00",postDateGmt:null});
 const fixed={status:"publish",postDate:"2000-01-01T00:00:00",postDateGmt:"2000-01-01T08:00:00.123Z"};
 assert.deepEqual(resolvePostDate({},fixed,"publish","+05:45",now),{postDate:fixed.postDate,postDateGmt:fixed.postDateGmt});
 for(const bad of [undefined,3,{},"2024-01-01T00:00:00"]){assert.throws(()=>publicationPair("2024-01-01T00:00:00",bad),{status:400});}
 assert.throws(()=>civilFromInstant("2024-01-01T00:00:00","UTC"),/explicit UTC offset/);
 assert.throws(()=>civilFromInstant("2024-01-01T00:00:00Z","Unknown/Zone"),/timezone is invalid/);
 assert.equal(civilFromInstant("2024-01-01T00:00:00Z","+0545"),"2024-01-01T05:45:00");
 const chosen={...fixed,publishedAt:fixed.postDateGmt};assert.deepEqual(resolvePostDate({publishedAt:fixed.postDateGmt},chosen,"publish","+05:45",now),{postDate:fixed.postDate,postDateGmt:fixed.postDateGmt});
 const future={...fixed,status:"future",publishedAt:"1999-01-01T00:00:00Z",scheduledAt:fixed.postDateGmt};assert.equal(resolvePostDate({scheduledAt:fixed.postDateGmt},future,"future","+05:45",now).postDate,fixed.postDate);
 const float={status:"draft",postDate:"2000-01-01T00:00:00",postDateGmt:null};assert.deepEqual(resolvePostDate({postDate:float.postDate},float,"publish","UTC",now),{postDate:"2026-01-01T00:00:00",postDateGmt:now.toISOString()});
 assert.deepEqual(resolvePostDate({restDate:"2024-01-02T03:04:05.123"},undefined,"publish","+05:45",now),{postDate:"2024-01-02T03:04:05",postDateGmt:"2024-01-01T21:19:05.123Z"});
 assert.equal(postPublicationKey({id:1,postDate:fixed.postDate}),"post:1:2000-01-01T00:00:00");
});

test("additive civil migration preserves every old column, backfills once and rejects unsupported assignments atomically",async t=>{
 const db=await pool.connect(),schema="civil_migration_"+randomBytes(6).toString("hex");
 try{
  await db.query(`CREATE SCHEMA ${schema}`);await db.query(`SET search_path TO ${schema},public`);
  await db.query(`CREATE TABLE settings(id integer PRIMARY KEY,data jsonb);INSERT INTO settings VALUES(1,'{"timezone":"America/Los_Angeles"}');
   CREATE TABLE posts(id integer PRIMARY KEY,status text,pre_trash_status text,published_at timestamptz,scheduled_at timestamptz,created_at timestamptz,updated_at timestamptz,content text);
   INSERT INTO posts VALUES(1,'publish',NULL,'2024-03-01T07:30:00.123456Z',NULL,'2025-01-01T00:00:00Z','2025-02-01T00:00:00Z','Old body'),(2,'future',NULL,'2000-01-01T00:00:00Z','2100-07-01T06:30:00.987654Z','2020-01-01T00:00:00Z','2021-01-01T00:00:00Z','Scheduled'),(3,'draft',NULL,NULL,NULL,'2024-01-01T07:30:00Z','2024-02-01T00:00:00Z','Floating');`);
  const snapshot=async()=>(await db.query("SELECT (to_jsonb(p)-'post_date'-'post_date_gmt')::text AS record FROM posts p ORDER BY id")).rows;
  const before=await snapshot();await db.query("BEGIN");await migratePostDates(db);await db.query("COMMIT");assert.deepEqual(await snapshot(),before);
  const pairs=(await db.query("SELECT id,post_date,post_date_gmt::text AS gmt FROM posts ORDER BY id")).rows;
  assert.deepEqual(pairs.map(row=>row.post_date),["2024-02-29T23:30:00","2100-06-30T23:30:00","2023-12-31T23:30:00"]);
  assert.match(pairs[0].gmt,/123456/);assert.match(pairs[1].gmt,/987654/);assert.equal(pairs[2].gmt,null);
  await db.query("UPDATE settings SET data='{"+'"timezone":"+05:45"'+"}'");
  await db.query("BEGIN");await migratePostDates(db);await db.query("COMMIT");assert.deepEqual((await db.query("SELECT id,post_date,post_date_gmt::text AS gmt FROM posts ORDER BY id")).rows,pairs);
  await db.query("BEGIN");await db.query("SET LOCAL TimeZone TO 'Pacific/Auckland'");assert.deepEqual((await db.query("SELECT post_date FROM posts ORDER BY id")).rows.map(row=>row.post_date),pairs.map(row=>row.post_date));assert.equal((await db.query("SELECT to_char(post_date::timestamp without time zone,'YYYY-MM') AS month FROM posts WHERE id=1")).rows[0].month,"2024-02");await db.query("ROLLBACK");
  for(const value of ["0000-01-01T00:00:00","2023-02-29T00:00:00","2024-01-01T24:00:00","2024-01-01T00:00:60","infinity","2024-01-01T00:00:00Z"]){
   await db.query("BEGIN");await assert.rejects(db.query("UPDATE posts SET post_date=$1 WHERE id=1",[value]),{code:"23514"});await db.query("ROLLBACK");
  }
  await db.query("ALTER TABLE posts DROP CONSTRAINT posts_civil_date_valid;ALTER TABLE posts ALTER COLUMN post_date DROP NOT NULL;UPDATE posts SET post_date='2024-02-30T00:00:00' WHERE id=1");
  const invalidBefore=await snapshot();await db.query("BEGIN");await assert.rejects(migratePostDates(db),/post IDs: 1/);await db.query("ROLLBACK");assert.deepEqual(await snapshot(),invalidBefore);
  assert.equal((await db.query("SELECT post_date FROM posts WHERE id=1")).rows[0].post_date,"2024-02-30T00:00:00");
  await db.query("UPDATE posts SET post_date=NULL,post_date_gmt=NULL,published_at='infinity' WHERE id=1");await db.query("BEGIN");await assert.rejects(migratePostDates(db),/post IDs: 1/);await db.query("ROLLBACK");
 }finally{await db.query("ROLLBACK");await db.query("SET search_path TO public");await db.query(`DROP SCHEMA ${schema} CASCADE`);db.release();}
});

test("persisted civil dates survive zones, REST edits, real post waits, revisions, schedules and portable pairs",async t=>{
 const original=(await pool.query("SELECT data FROM settings WHERE id=1")).rows[0].data,ids:number[]=[],stamp="civil-"+Date.now();let cookie="";
 async function api(path:string,method="GET",body?:unknown){const response=await fetch(base+path,{method,headers:{Origin:origin,Cookie:cookie,"Content-Type":"application/json"},body:body===undefined?undefined:JSON.stringify(body)});return {response,data:await response.json()};}
 async function ok(path:string,method="GET",body?:unknown){const r=await api(path,method,body);assert.ok(r.response.ok,`${path}: ${r.response.status} ${JSON.stringify(r.data)}`);return r.data;}
 async function make(body:Record<string,unknown>={}){const post=(await ok("/api/posts","POST",{title:stamp+"-"+ids.length,status:"publish",content:"<p>CIVIL-FIRST</p><!--nextpage--><p>CIVIL-SECOND</p>",...body})).post;ids.push(post.id);return post;}
 try{
  const sign=await api("/api/auth/login","POST",{login:process.env.ADMIN_EMAIL,password:process.env.ADMIN_PASSWORD});assert.equal(sign.response.status,200);cookie=sign.response.headers.get("set-cookie")!.split(";")[0];
  await ok("/api/settings","PUT",{timezone:"America/Los_Angeles",pingServices:[],permalinkStructure:"/%year%/%monthnum%/%day%/%hour%/%minute%/%second%/%post_id%/"});
  const fixed=await make({publishedAt:"2024-03-01T07:30:07.123Z"});assert.equal(fixed.postDate,"2024-02-29T23:30:07");const canonical=fixed.permalink;
  for(const zone of ["+05:45","UTC","Pacific/Apia"]){
   await ok("/api/settings","PUT",{timezone:zone});const current=(await ok("/api/posts/"+fixed.id)).post;assert.equal(current.permalink,canonical);assert.equal(current.postDate,fixed.postDate);assert.equal(current.publishedAt,fixed.publishedAt);assert.equal(current.postDateGmt,fixed.postDateGmt);
   assert.equal((await ok("/wp-json/wp/v2/posts/"+fixed.id)).date,fixed.postDate);
   const archive=await ok("/api/public/site?m=202402&search="+stamp);assert.equal(archive.posts[0].id,fixed.id);
   const head=await fetch(base+canonical,{method:"HEAD"});assert.equal(head.status,200);
  }
  await t.test("unchanged local/GMT and content-only edits preserve fixed pairs; local input wins",async()=>{
   const unchanged=await ok("/wp-json/wp/v2/posts/"+fixed.id,"POST",{date:fixed.postDate,date_gmt:"1999-01-01T00:00:00",content:"<p>Same fixed date.</p>"});assert.equal(unchanged.date_gmt,"2024-03-01T07:30:07.123");
   const changed=await ok("/wp-json/wp/v2/posts/"+fixed.id,"POST",{date:"2024-05-06T07:08:09",date_gmt:"1999-01-01T00:00:00"});assert.equal(changed.date,"2024-05-06T07:08:09");
   const invalid=await api("/api/posts/"+fixed.id,"PUT",{postDate:"2024-02-30T00:00:00"});assert.equal(invalid.response.status,400);
   const conflict=await api("/api/posts/"+fixed.id,"PUT",{postDate:"2024-01-01T00:00:00",version:1});assert.equal(conflict.response.status,409);
  });
  await t.test("floating drafts refresh without fixing GMT; explicit/null and DST boundaries are validated",async()=>{
   const draft=await make({status:"draft"});assert.equal(draft.postDateGmt,null);
   await pool.query("UPDATE posts SET post_date='2000-01-01T00:00:00' WHERE id=$1",[draft.id]);const refreshed=(await ok("/api/posts/"+draft.id,"PUT",{content:"<p>Floating save.</p>"})).post;assert.notEqual(refreshed.postDate,"2000-01-01T00:00:00");assert.equal(refreshed.postDateGmt,null);
   const chosen=(await ok("/api/posts/"+draft.id,"PUT",{postDate:"2020-01-02T03:04:05"})).post;assert.ok(chosen.postDateGmt);const cleared=await ok("/wp-json/wp/v2/posts/"+draft.id,"POST",{date:null});assert.equal((await getPost(draft.id)).postDateGmt,null);assert.notEqual(cleared.date,chosen.postDate);
   await ok("/api/settings","PUT",{timezone:"America/Los_Angeles"});assert.equal((await api("/api/posts/"+draft.id,"PUT",{postDate:"2026-03-08T02:30:00"})).response.status,400);
  });
  await t.test("a measured existing-post row wait captures the new settings zone after release",async()=>{
   const db=await pool.connect();await db.query("BEGIN");const pid=(await db.query("SELECT pg_backend_pid() pid")).rows[0].pid;
   await db.query("SELECT id FROM posts WHERE id=$1 FOR UPDATE",[fixed.id]);let pending:ReturnType<typeof api>|undefined;
   try{
    pending=api("/api/posts/"+fixed.id,"PUT",{postDate:"2024-01-02T03:04:05"});let blocked=false;
    for(let attempt=0;attempt<100;attempt++){if((await pool.query("SELECT 1 FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid))",[pid])).rowCount){blocked=true;break;}await new Promise(r=>setTimeout(r,20));}
    assert.equal(blocked,true);await pool.query("UPDATE settings SET data=data || '{\"timezone\":\"+05:45\"}' WHERE id=1");await db.query("COMMIT");const result=await pending;assert.equal(result.response.status,200,JSON.stringify(result.data));assert.equal(result.data.post.postDateGmt,"2024-01-01T21:19:05.000Z");
   }finally{await db.query("ROLLBACK");db.release();if(pending)await pending;}
  });
  await t.test("revision restore and autosave preview retain the current publication pair",async()=>{
   const post=await make({postDate:"2001-02-03T04:05:06"});
   await ok("/api/posts/"+post.id,"PUT",{content:"<p>Revision body replacement.</p>",postDate:"2002-03-04T05:06:07"});
   const revisions=await ok("/api/posts/"+post.id+"/revisions"),current=(await ok("/api/posts/"+post.id)).post;
   const restored=(await ok(`/api/posts/${post.id}/revisions/${revisions.revisions[0].id}/restore`,"POST",{version:current.version})).post;
   assert.equal(restored.postDate,current.postDate);assert.equal(restored.postDateGmt,current.postDateGmt);
   await ok(`/api/posts/${post.id}/autosave`,"PUT",{version:restored.version,content:"<p>CIVIL AUTOSAVE PREVIEW</p>"});
   const preview=(await ok(`/api/posts/${post.id}/preview`)).post;assert.equal(preview.postDate,restored.postDate);assert.equal(preview.postDateGmt,restored.postDateGmt);assert.match(preview.content,/CIVIL AUTOSAVE PREVIEW/);
  });
  await t.test("future status without an explicitly chosen date keeps the existing missing-date rejection",async()=>{
   const before=(await pool.query("SELECT count(*)::int n FROM posts")).rows[0].n;
   for(const input of [{status:"future"},{status:"future",publishedAt:"2100-01-01T00:00:00Z"},{status:"future",scheduledAt:null}])assert.equal((await api("/api/posts","POST",{title:stamp+"-missing-future",...input})).response.status,400);
   assert.equal((await pool.query("SELECT count(*)::int n FROM posts")).rows[0].n,before);
   const draft=await make({status:"draft"});assert.equal((await api(`/api/posts/${draft.id}`,"PUT",{status:"future"})).response.status,400);const current=await getPost(draft.id);assert.equal(current.status,"draft");assert.equal(current.postDateGmt,null);
  });
  await t.test("date-only reschedules create no content revision and restoring content retains the current schedule",async()=>{
   const post=await make({status:"future",postDate:"2100-02-03T04:05:06"});
   const before=(await ok(`/api/posts/${post.id}/revisions`)).revisions.length;
   const first=(await ok(`/api/posts/${post.id}`,"PUT",{postDate:"2101-03-04T05:06:07",version:post.version})).post;
   assert.equal((await ok(`/api/posts/${post.id}/revisions`)).revisions.length,before);
   await ok(`/api/posts/${post.id}`,"PUT",{content:"<p>Scheduled content revision.</p>"});
   const revision=(await ok(`/api/posts/${post.id}/revisions`)).revisions[0];
   const metadata=(await pool.query("SELECT metadata FROM post_revisions WHERE id=$1",[revision.id])).rows[0].metadata;
   for(const field of ["postDate","postDateGmt","publishedAt","scheduledAt"])assert.equal(Object.hasOwn(metadata,field),false);
   const current=(await ok(`/api/posts/${post.id}`,"PUT",{postDate:"2102-04-05T06:07:08"})).post;
   const restored=(await ok(`/api/posts/${post.id}/revisions/${revision.id}/restore`,"POST",{version:current.version})).post;
   assert.equal(restored.postDate,current.postDate);assert.equal(restored.postDateGmt,current.postDateGmt);assert.equal(restored.scheduledAt,current.scheduledAt);assert.notEqual(restored.scheduledAt,first.scheduledAt);
   const draft=await make({status:"draft"});await ok(`/api/posts/${draft.id}`,"PUT",{content:"<p>Floating content revision.</p>"});const draftRevision=(await ok(`/api/posts/${draft.id}/revisions`)).revisions[0];await pool.query("UPDATE posts SET post_date='2000-01-01T00:00:00' WHERE id=$1",[draft.id]);
   const floated=(await ok(`/api/posts/${draft.id}/revisions/${draftRevision.id}/restore`,"POST",{})).post;assert.equal(floated.postDateGmt,null);assert.notEqual(floated.postDate,"2000-01-01T00:00:00");
  });
  await t.test("initial SSR and native password continuation retain stored date, body page and query counters",async()=>{
   const post=await make({password:"Civil native password",postDate:"2003-04-05T06:07:08"});
   await ok("/api/settings","PUT",{timezone:"Pacific/Apia",theme:"classic"});
   const path=post.permalink+"2/?query-3-page=4&commentPage=2",page=await fetch(base+path);assert.equal(page.status,200);
   const markup=await page.text();assert.doesNotMatch(markup,/CIVIL-FIRST|CIVIL-SECOND/);
   const document=parseHTML(markup).document,form=document.querySelector('form[action="/post-password"]')!;assert.ok(form);
   const body=new URLSearchParams();for(const input of form.querySelectorAll("input")){const name=input.getAttribute("name");if(name)body.set(name,input.getAttribute("value") || "");}body.set("password","Civil native password");
   const unlocked=await fetch(base+form.getAttribute("action"),{method:"POST",redirect:"manual",headers:{Origin:origin,"Content-Type":"application/x-www-form-urlencoded"},body});assert.equal(unlocked.status,303);
   const location=unlocked.headers.get("location")!;assert.match(location,/2003\/04\/05\/06\/07\/08\//);assert.match(location,/query-3-page=4/);assert.match(location,/commentPage=2/);
   const grant=unlocked.headers.get("set-cookie")!.split(";")[0],follow=await fetch(base+location,{headers:{Cookie:grant}});assert.equal(follow.status,200);const html=await follow.text();assert.match(html,/CIVIL-SECOND/);assert.doesNotMatch(html,/CIVIL-FIRST/);
  });
  await t.test("scheduler retains the selected civil/GMT pair across a timezone change",async()=>{
   const scheduled=await make({status:"future",postDate:"2100-01-02T03:04:05"});await ok("/api/settings","PUT",{timezone:"UTC"});assert.deepEqual(await publishDuePosts(new Date("2101-01-01T00:00:00Z"),[scheduled.id]),[scheduled.id]);const published=await getPost(scheduled.id);assert.equal(published.postDate,scheduled.postDate);assert.equal(published.postDateGmt.toISOString(),scheduled.postDateGmt);assert.equal(published.publishedAt.toISOString(),scheduled.scheduledAt);
  });
  await t.test("JSON v4 rejects missing pairs atomically and preserves inconsistent WXR local/GMT independently",async()=>{
   const archive=await ok("/api/tools/export");assert.equal(archive.version,4);const source=archive.posts.find((p:any)=>p.id===fixed.id);assert.equal(source.post_date,"2024-01-02T03:04:05");
   const before=(await pool.query("SELECT count(*)::int n FROM posts")).rows[0].n;const missing={...source};delete missing.post_date;
   assert.equal((await api("/api/tools/import","POST",{application:"WorldAct",version:4,posts:[missing]})).response.status,400);assert.equal((await pool.query("SELECT count(*)::int n FROM posts")).rows[0].n,before);
   const xml=`<rss xmlns:wp="http://wordpress.org/export/1.2/" xmlns:content="http://purl.org/rss/1.0/modules/content/"><channel><wp:wxr_version>1.2</wp:wxr_version><item><title>${stamp}-inconsistent</title><wp:post_id>987654</wp:post_id><wp:post_type>post</wp:post_type><wp:status>publish</wp:status><wp:post_date>2011-12-30 12:34:56</wp:post_date><wp:post_date_gmt>2000-01-01 01:02:03</wp:post_date_gmt><content:encoded><![CDATA[<p>WXR civil.</p>]]></content:encoded></item></channel></rss>`;
   const copied=await ok("/api/tools/import","POST",{format:"wxr",xml});ids.push(...copied.postIds);const post=await getPost(copied.postIds[0]);assert.equal(post.postDate,"2011-12-30T12:34:56");assert.equal(post.postDateGmt.toISOString(),"2000-01-01T01:02:03.000Z");assert.match(post.permalink,/2011\/12\/30\/12\/34\/56/);
   const exported=await fetch(base+"/api/tools/export?format=wxr&content=posts&startDate=2011-12&endDate=2011-12",{headers:{Cookie:cookie}});const parsed=new XMLParser({parseTagValue:false,isArray:n=>n==="item"}).parse(await exported.text());const item=parsed.rss.channel.item.find((p:any)=>Number(p["wp:post_id"])===post.id);assert.equal(item["wp:post_date"],"2011-12-30 12:34:56");assert.equal(item["wp:post_date_gmt"],"2000-01-01 01:02:03");
   const malformed=xml.replace("2011-12-30 12:34:56","2011-02-30 12:34:56");const count=(await pool.query("SELECT count(*)::int n FROM posts")).rows[0].n;
   assert.equal((await api("/api/tools/import","POST",{format:"wxr",xml:malformed})).response.status,400);assert.equal((await pool.query("SELECT count(*)::int n FROM posts")).rows[0].n,count);
   const legacy=await ok("/api/tools/import","POST",{application:"WorldAct",version:3,settings:{timezone:" America/Los_Angeles "},posts:[{id:987653,type:"post",title:stamp+"-legacy",slug:stamp+"-legacy",content:"<p>Old archive.</p>",status:"publish",published_at:"2024-03-01T07:30:07Z"}]});ids.push(...legacy.postIds);assert.equal((await getPost(legacy.postIds[0])).postDate,"2024-02-29T23:30:07");
   const db=await pool.connect();try{await db.query("BEGIN");await db.query("UPDATE posts SET post_date='1999-12-31T23:59:59' WHERE id=$1",[post.id]);assert.match(await postPermalink({...post,postDate:"LYING"},await getSettings(db),db),/^\/1999\/12\/31\/23\/59\/59\//);await db.query("ROLLBACK");}finally{db.release();}
  });
 }finally{await pool.query("DELETE FROM posts WHERE id=ANY($1::int[])",[ids]);await pool.query("UPDATE settings SET data=$1::jsonb WHERE id=1",[JSON.stringify(original)]);}
});
