import test,{after} from "./isolated-test.js";
import assert from "node:assert/strict";
import {readFile,writeFile,readdir} from "node:fs/promises";
import {pool,uploadsDir} from "../server/db.js";
import {postPublicationKey} from "../shared/post-civil-date.js";
import {DOMParser} from "linkedom";
after(()=>pool.end());
const stage=process.env.CIVIL_ARCHIVE_STAGE,file=process.env.CIVIL_ARCHIVE_PATH,base=process.env.TEST_API_URL!,origin=process.env.APP_ORIGIN!;
test("civil JSON v4 pairs cross fresh IDs, owners and zones with exact body URLs and atomic invalid-pair rollback",{skip:!stage||!file},async()=>{
 let cookie="";
 async function request(path:string,method="GET",body?:unknown){const response=await fetch(base+path,{method,headers:{Origin:origin,Cookie:cookie,"Content-Type":"application/json"},body:body===undefined?undefined:JSON.stringify(body)});return {response,data:await response.json()};}
 async function ok(path:string,method="GET",body?:unknown){const r=await request(path,method,body);assert.ok(r.response.ok,`${path}: ${r.response.status} ${JSON.stringify(r.data)}`);return r.data;}
 async function login(login=process.env.ADMIN_EMAIL!,password=process.env.ADMIN_PASSWORD!){const r=await request("/api/auth/login","POST",{login,password});assert.equal(r.response.status,200);cookie=r.response.headers.get("set-cookie")!.split(";")[0];return r.data.user;}
 await login();
 if(stage==="export"){
  await ok("/api/settings","PUT",{timezone:"America/Los_Angeles",pingServices:[],siteUrl:"https://civil-source.example.invalid",permalinkStructure:"/%author%/%year%/%monthnum%/%day%/%hour%/%minute%/%second%/%post_id%/%postname%/"});
  const user=(await ok("/api/users","POST",{username:"Civil.Source@Author",email:"civil-source@example.test",displayName:"Civil source author",role:"author",password:"Civil-source-fixture-password"})).user;
  const make=async(body:Record<string,unknown>)=>(await ok("/api/posts","POST",{title:"Civil portable "+body.label,status:"publish",content:"<p>CIVIL-ARCHIVE-FIRST</p><!--nextpage--><p>CIVIL-ARCHIVE-SECOND</p>",...Object.fromEntries(Object.entries(body).filter(([key])=>key!=="label"))})).post;
  const post=await make({label:"main",authorId:user.id,publishedAt:"2024-03-01T07:30:07Z"});assert.equal(post.postDate,"2024-02-29T23:30:07");
  const parent=await make({label:"parent",type:"page"}),child=await make({label:"child",type:"page",parentId:parent.id,slug:"2"});
  const fixed=await make({label:"fixed draft",status:"draft",postDate:"1984-02-29T01:02:03"}),floating=await make({label:"floating draft",status:"draft"}),future=await make({label:"future",status:"future",postDate:"2100-01-02T03:04:05"});
  assert.ok(fixed.postDateGmt);assert.equal(floating.postDateGmt,null);assert.ok(future.scheduledAt);
  const xml=`<rss xmlns:wp="http://wordpress.org/export/1.2/" xmlns:content="http://purl.org/rss/1.0/modules/content/"><channel><wp:wxr_version>1.2</wp:wxr_version><item><title>Civil portable inconsistent</title><wp:post_id>998877</wp:post_id><wp:post_type>post</wp:post_type><wp:status>publish</wp:status><wp:post_date>2011-12-30 12:34:56</wp:post_date><wp:post_date_gmt>2024-03-01 07:30:07</wp:post_date_gmt><content:encoded><![CDATA[<p>Inconsistent civil body.</p>]]></content:encoded></item></channel></rss>`;
  const wxr=await ok("/api/tools/import","POST",{format:"wxr",xml}),inconsistent=(await ok("/api/posts/"+wxr.postIds[0])).post;
  const links={body:post.permalink+"2/?query-4-page=3&commentPage=2#keep",child:child.permalink+"?query-4-page=3#child",childBody:child.permalink+"2/#child-body"};
  await ok("/api/posts/"+post.id,"PUT",{content:`<p>CIVIL-ARCHIVE-FIRST <a href="${links.body.replace(/&/g,"&amp;")}">Body</a><a href="${links.child}">Child</a><a href="${links.childBody}">Child body</a></p><!--nextpage--><p>CIVIL-ARCHIVE-SECOND</p>`});
  const archive=await ok("/api/tools/export");assert.equal(archive.version,4);for(const row of archive.posts){assert.equal(typeof row.post_date,"string");assert.ok(Object.hasOwn(row,"post_date_gmt"));}
  await writeFile(file!,JSON.stringify({archive,sourcePostId:post.id,sourceAuthorId:user.id,inconsistentId:inconsistent.id,links}),{mode:0o600});
 }else{
  assert.equal(stage,"restore");const fixture=JSON.parse(await readFile(file!,"utf8")),archive=fixture.archive;
  await ok("/api/users","POST",{username:"civil-destination-pad",email:"civil-destination-pad@example.test",displayName:"Destination padding",role:"author",password:"Civil-destination-pad-password"});
  const owner=(await ok("/api/users","POST",{username:"civil-destination-admin",email:"civil-destination-admin@example.test",displayName:"Destination administrator",role:"administrator",password:"Civil-destination-admin-password"})).user;
  assert.notEqual(owner.id,fixture.sourceAuthorId);await login(owner.email,"Civil-destination-admin-password");
  await ok("/api/posts","POST",{title:"Destination ID padding",status:"draft"});
  const structure="/destination/%author%/%year%/%monthnum%/%day%/%hour%/%minute%/%second%/%post_id%/%postname%/";
  await ok("/api/settings","PUT",{timezone:"+05:45",permalinkStructure:structure,pingServices:[],dateFormat:"Y-m-d"});
  for(const replaceDesign of [false,true]){
   const restored=await ok("/api/tools/import","POST",{...archive,replaceDesign});assert.equal(restored.restoredDesign,replaceDesign);
   const sourceMain=archive.posts.find((p:any)=>p.id===fixture.sourcePostId),main=(await pool.query("SELECT id FROM posts WHERE id=ANY($1::int[]) AND title=$2",[restored.postIds,sourceMain.title])).rows[0];assert.ok(main);assert.notEqual(main.id,fixture.sourcePostId);
   const posts=(await pool.query("SELECT * FROM posts WHERE id=ANY($1::int[]) ORDER BY id",[restored.postIds])).rows;
   for(const source of archive.posts){const copy=posts.find(p=>p.title===source.title);assert.ok(copy,source.title);assert.equal(copy.author_id,owner.id);assert.equal(copy.post_date,source.post_date);assert.equal(copy.post_date_gmt?.toISOString() ?? null,source.post_date_gmt);if(source.scheduled_at)assert.equal(copy.scheduled_at.toISOString(),source.scheduled_at);if(source.published_at)assert.equal(copy.published_at.toISOString(),source.published_at);}
   const post=(await ok("/api/posts/"+main.id)).post;assert.equal(post.postDate,"2024-02-29T23:30:07");assert.match(post.permalink,/2024\/02\/29\/23\/30\/07/);assert.equal((await ok("/api/settings")).settings.timezone,replaceDesign?"America/Los_Angeles":"+05:45");
   const document=new DOMParser().parseFromString(post.rawContent,"text/html"),links=[...document.querySelectorAll("a")],href=(text:string)=>links.find(a=>a.textContent===text)!.getAttribute("href")!;
   assert.equal(href("Body"),post.permalink+"2/?query-4-page=3&commentPage=2#keep");
   const initial=await fetch(base+href("Body"),{headers:{Cookie:cookie}});assert.equal(initial.status,200);const html=await initial.text();assert.match(html,/CIVIL-ARCHIVE-SECOND/);assert.doesNotMatch(new DOMParser().parseFromString(html,"text/html").querySelector("#root")!.textContent!,/CIVIL-ARCHIVE-FIRST/);
   for(const label of ["Child","Child body"]){const response=await request("/api/public/resolve?"+new URLSearchParams({path:href(label).split("#")[0]}));assert.equal(response.response.status,200);assert.equal(response.data.post.type,"page");assert.equal(response.data.contentPage ?? 1,label==="Child"?1:2);}
   const model=await ok("/api/public/document?"+new URLSearchParams({path:post.permalink}));assert.ok(model.controls.dates[postPublicationKey(post)]);
   const second=posts.find(p=>p.title==="Civil portable inconsistent");assert.ok(second);assert.notEqual(postPublicationKey(post),postPublicationKey({id:second.id,postDate:second.post_date}));assert.equal(second.post_date_gmt.toISOString(),post.postDateGmt);assert.notEqual(model.controls.dates[postPublicationKey(post)],model.controls.dates[postPublicationKey({id:second.id,postDate:second.post_date})]);
   const exported=await ok("/api/tools/export");for(const copy of posts){const row=exported.posts.find((p:any)=>p.id===copy.id);assert.equal(row.post_date,copy.post_date);assert.equal(row.post_date_gmt,copy.post_date_gmt?.toISOString() ?? null);}
  }
  const before={posts:(await pool.query("SELECT to_jsonb(p)::text body FROM posts p ORDER BY id")).rows,settings:(await pool.query("SELECT data FROM settings WHERE id=1")).rows,files:(await readdir(uploadsDir,{recursive:true})).sort()};
  const invalid=structuredClone(archive);invalid.replaceDesign=true;invalid.posts[invalid.posts.length-1].post_date="2023-02-29T00:00:00";assert.equal((await request("/api/tools/import","POST",invalid)).response.status,400);
  assert.deepEqual((await pool.query("SELECT to_jsonb(p)::text body FROM posts p ORDER BY id")).rows,before.posts);assert.deepEqual((await pool.query("SELECT data FROM settings WHERE id=1")).rows,before.settings);assert.deepEqual((await readdir(uploadsDir,{recursive:true})).sort(),before.files);
  assert.equal((await pool.query("SELECT count(*)::int n FROM users WHERE username='Civil.Source@Author'")).rows[0].n,0);
 }
});
