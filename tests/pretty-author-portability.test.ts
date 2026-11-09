import test, {after} from "./isolated-test.js";
import assert from "node:assert/strict";
import {readFile, writeFile} from "node:fs/promises";
import {DOMParser} from "linkedom";
import {pool} from "../server/db.js";
import {authorArchivePath} from "../shared/author-archive.js";

const stage=process.env.PRETTY_AUTHOR_ARCHIVE_STAGE,archivePath=process.env.PRETTY_AUTHOR_ARCHIVE_PATH;
const base=process.env.TEST_API_URL!,origin=process.env.APP_ORIGIN!;
after(()=>pool.end());

test("fresh imported author archives generate destination identity paths in retained and replaced designs",{skip:!stage || !archivePath},async()=>{
 let cookie="";
 async function api(path:string,method="GET",body?:unknown){
  const response=await fetch(base+path,{method,headers:{Origin:origin,Cookie:cookie,"Content-Type":"application/json"},body:body===undefined?undefined:JSON.stringify(body)}),data=await response.json();
  assert.ok(response.ok,`${path}: ${response.status} ${JSON.stringify(data)}`);return {response,data};
 }
 const signed=await api("/api/auth/login","POST",{login:process.env.ADMIN_EMAIL,password:process.env.ADMIN_PASSWORD});cookie=signed.response.headers.get("set-cookie")!.split(";")[0];
 const source=stage==="export",username=source?"Pretty.Source@Author":"Pretty.Destination@Administrator";
 if(!source)await api("/api/users","POST",{username:"Pretty-identity-offset",email:"pretty-offset@example.test",displayName:"Offset",password:"Pretty-archive-password-123",role:"subscriber"});
 const person=(await api("/api/users","POST",{username,email:source?"pretty-source@example.test":"pretty-destination@example.test",displayName:source?"Source archive author":"Destination archive author",password:"Pretty-archive-password-123",role:source?"author":"administrator"})).data.user;
 const nicename=(await pool.query("SELECT nicename FROM users WHERE id=$1",[person.id])).rows[0].nicename;
 assert.equal(nicename,source?"pretty-sourceauthor":"pretty-destinationadministrator");
 const sourceStructure="/journal/%year%/%postname%/";
 if(source){
  await api("/api/settings","PUT",{permalinkStructure:sourceStructure,postsPerPage:1,theme:"twentytwentyfive",pingServices:[]});
  const ids:number[]=[];
  for(const n of [1,2])ids.push((await api("/api/posts","POST",{title:"Pretty portable post "+n,status:"publish",authorId:person.id,content:'<p>PRETTY-PORTABLE-'+n+'</p><!-- wp:post-author-name {"isLink":true} /--><!-- wp:avatar {"isLink":true} /-->'})).data.post.id);
  await api("/api/posts","POST",{title:"Pretty portable private",status:"private",authorId:person.id,content:"<p>PRETTY-PORTABLE-PRIVATE-SECRET</p>"});
  for(const theme of ["twentytwentyfive","classic"]){await api("/api/settings","PUT",{theme});for(const [slug,marker] of [["author-"+nicename,"SOURCE-NICENAME-TEMPLATE"],["author","IMPORTED-GENERAL-AUTHOR-TEMPLATE"]])await api("/api/site-editor/documents","POST",{type:"template",slug,title:slug,content:"<p>"+marker+"</p><!-- wp:query-title /--><!-- wp:query {\"query\":{\"inherit\":true}} --><!-- wp:post-template --><!-- wp:post-title /--><!-- wp:post-author-name {\"isLink\":true} /--><!-- /wp:post-template --><!-- /wp:query -->"});
  }await api("/api/settings","PUT",{theme:"twentytwentyfive"});
  const archive=(await api("/api/tools/export")).data;
  await writeFile(archivePath!,JSON.stringify({archive,sourceAuthorId:person.id,sourceNicename:nicename,sourcePostIds:ids}),{mode:0o600});
  return;
 }
 assert.equal(stage,"restore");
 const fixture=JSON.parse(await readFile(archivePath!,"utf8"));
 const switched=await api("/api/auth/login","POST",{login:username,password:"Pretty-archive-password-123"});cookie=switched.response.headers.get("set-cookie")!.split(";")[0];
 assert.notEqual(person.id,fixture.sourceAuthorId);
 for(let i=0;i<5;i++)await api("/api/posts","POST",{title:"Destination post ID offset "+i,status:"draft"});
 const destinationDocuments:number[]=[];
 for(const theme of ["twentytwentyfive","classic"]){await api("/api/settings","PUT",{theme});destinationDocuments.push((await api("/api/site-editor/documents","POST",{type:"template",slug:"author-"+nicename,title:"Destination author template",content:"<p>DESTINATION-NICENAME-TEMPLATE</p><!-- wp:query-title /-->"})).data.document.id);}
 for(const [structure,replaceDesign] of [["",false],["/destination-%postname%",false],[sourceStructure,true]] as const){
  await api("/api/settings","PUT",{permalinkStructure:structure,postsPerPage:1});
  const restored=(await api("/api/tools/import","POST",{...fixture.archive,replaceDesign})).data,settings=(await api("/api/settings")).data.settings;
  assert.equal(restored.restoredDesign,replaceDesign);assert.equal(settings.permalinkStructure,structure);
  // Replacing design retains unrelated destination documents. Remove the more
  // specific destination overrides deliberately to exercise imported fallback.
  if(replaceDesign)await pool.query("DELETE FROM site_documents WHERE id=ANY($1::int[])",[destinationDocuments]);
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM users WHERE username='Pretty.Source@Author'")).rows[0].n,0);
  const rows=(await pool.query("SELECT id,author_id FROM posts WHERE id=ANY($1::int[]) AND title LIKE 'Pretty portable post %'",[restored.postIds])).rows;
  assert.equal(rows.length,2);for(const row of rows){assert.equal(row.author_id,person.id);assert.ok(!fixture.sourcePostIds.includes(row.id));}
  const canonical=authorArchivePath({id:person.id,nicename},settings);
  assert.equal((await api("/wp-json/wp/v2/users/"+person.id)).data.link,canonical);
  for(const row of rows){
   const post=(await api("/api/posts/"+row.id)).data.post,response=await fetch(base+"/api/public/posts/"+post.slug),data=await response.json();
   assert.equal(response.status,200);assert.equal(data.post.authorId,person.id);const dom=new DOMParser().parseFromString(data.post.content,"text/html");
   assert.equal(dom.querySelectorAll('a[href="'+canonical+'"]').length,2);assert.ok(!data.post.content.includes("/author/"+fixture.sourceNicename));
  }
  for(const theme of ["twentytwentyfive","classic"]){
   await api("/api/settings","PUT",{theme});
   const target=canonical.includes("?")?canonical+"&page=2&query-6-page=3&commentPage=4":canonical.replace(/\/$/,"")+"/page/2"+(canonical.endsWith("/")?"/":"")+"?query-6-page=3&commentPage=4";
   const response=await fetch(base+target);assert.equal(response.status,200);const html=await response.text(),dom=new DOMParser().parseFromString(html,"text/html"),model=JSON.parse(dom.querySelector("#worldact-public-document")!.textContent!);
   assert.equal(model.route.query.author,person.id);assert.equal(model.site.archive.slug,nicename);assert.equal(model.site.archive.permalink,canonical);assert.equal(model.route.query.archivePage,2);assert.equal(model.route.query.blockPages["query-6-page"],3);assert.equal(model.route.query.commentPage,4);
   assert.ok(model.site.posts.length>0);assert.ok(model.site.posts.every((post:any)=>post.authorId===person.id));assert.doesNotMatch(html,/PRETTY-PORTABLE-PRIVATE-SECRET|pretty-source@example.test|Pretty-archive-password-123/);
   const marker=replaceDesign?"IMPORTED-GENERAL-AUTHOR-TEMPLATE":"DESTINATION-NICENAME-TEMPLATE";assert.ok(dom.querySelector("#root")!.textContent!.includes(marker),JSON.stringify({structure,replaceDesign,theme,marker,selected:model.presentation.kind==="source"?model.presentation.document.slug:model.presentation.slots.index?.document.slug}));assert.ok(!dom.querySelector("#root")!.textContent!.includes("SOURCE-NICENAME-TEMPLATE"));
   const head=await fetch(base+target,{method:"HEAD"});assert.equal(head.status,200);assert.equal(await head.text(),"");
  }
  const excessive=canonical.includes("?")?canonical+"&page=999":canonical.replace(/\/$/,"")+"/page/999"+(canonical.endsWith("/")?"/":"");
  assert.equal((await fetch(base+excessive)).status,canonical.includes("?")?200:404);
 }
});
