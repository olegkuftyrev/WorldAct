import test, {after} from "./isolated-test.js";
import assert from "node:assert/strict";
import {DOMParser} from "linkedom";
import {pool} from "../server/db.js";
import {readPublicDocument,publicDocumentContext} from "../server/public-document-data.js";
import {publicDocumentIdentity,resolvePublicDocumentRoute} from "../server/public-documents.js";
import {readPublishedPostById} from "../server/public-read.js";
import {readCookieSessionUser} from "../server/auth.js";
import {normalizePublicQuery,sourceTemplateCandidates} from "../shared/public-routing.js";
import {approvalFixture} from "./comment-approval-fixtures.js";
import {base,origin} from "./comment-approval-fixtures.js";

after(()=>pool.end());
const dom=(html:string)=>new DOMParser().parseFromString(html,"text/html");
test("public request normalization preserves independent counters, path date authority and template priority",()=>{
  const query=normalizePublicQuery(new URLSearchParams("page=2&query-4-page=3&commentPage=4&s=term"),{singular:true});
  assert.equal(query.contentPage,2);assert.equal(query.archivePage,1);assert.equal(query.commentPage,4);assert.equal(query.blockPages["query-4-page"],3);assert.equal(query.values.page,"2");assert.equal(query.search,"term");
  for(const value of ["search=x&search=y","page[x]=2","query-4-page[]=2","commentPage=2&commentPage=3","query-4-page=2147483648"])assert.throws(()=>normalizePublicQuery(new URLSearchParams(value),{singular:false}));
  const date=normalizePublicQuery(new URLSearchParams("year=1901&m=190102&monthnum=2&day=4&w=2"),{singular:false,archive:{type:"date",year:2024,month:6,name:"June",permalink:"/2024/06/"}});
  assert.equal(date.values.year,"2024");assert.equal(date.values.monthnum,"6");for(const key of ["m","day","w"])assert.equal(date.values[key],undefined);
  const context={notFound:false,single:true,post:{id:9,type:"page" as const,slug:"story",templateSlug:"chosen"},frontPage:true,search:false,author:false,date:false};
  assert.deepEqual(sourceTemplateCandidates(context),["front-page","chosen","page-story","page-9","page","singular","index"]);
  assert.deepEqual(sourceTemplateCandidates({...context,search:true}),["search","index"]);
});

test("direct document models render all bundled themes with safe DTOs, selected bodies and exact native Reply context",async()=>{
  const f=await approvalFixture("public-documents");
  try {
    await f.ok("/api/settings","PUT",{permalinkStructure:"",frontPageMode:"posts",timezone:"UTC",dateFormat:"F j, Y",closeCommentsDays:0,threadComments:true,threadDepth:3,paginateComments:false,showAvatars:false,notifyComments:false,notifyModeration:false});
    const post=await f.post(),page=await f.post();
    await pool.query("UPDATE posts SET content=$2,raw_content=$2,published_at='2024-06-07T12:00:00Z' WHERE id=$1",[post.id,"<p>PUBLIC-SSR-ONE</p><!--nextpage--><p>PUBLIC-SSR-TWO</p>"]);
    await pool.query("UPDATE posts SET type='page',content='<p>NAVIGATION-BODY-ONLY</p>' WHERE id=$1",[page.id]);
    const root=(await pool.query("INSERT INTO comments(post_id,author_name,author_email,content,status) VALUES($1,'Safe Reader','PRIVATE-COMMENT@example.test','<p>VISIBLE-SSR-COMMENT</p>','approved') RETURNING id",[post.id])).rows[0].id;
    const child=(await pool.query("INSERT INTO comments(post_id,parent_id,author_name,author_email,content,status) VALUES($1,$2,'Child Reader','PRIVATE-CHILD@example.test','<p>CHILD COMMENT</p>','approved') RETURNING id",[post.id,root])).rows[0].id;
    const deep=(await pool.query("INSERT INTO comments(post_id,parent_id,author_name,author_email,content,status) VALUES($1,$2,'Deep Reader','','<p>DEEP COMMENT</p>','approved') RETURNING id",[post.id,child])).rows[0].id;
    const path=`/?p=${post.id}&page=2&query-4-page=2&commentPage=1&replytocom=${child}`;
    let sourceHTML="";
    for(const theme of ["twentytwentyfive","twentytwentyfour","twentytwentythree","classic"]){
      await f.ok("/api/settings","PUT",{theme});
      const response=await f.api("/api/public/document?"+new URLSearchParams({path}),"GET",undefined,"");assert.equal(response.response.status,200,JSON.stringify(response.data));
      const model=response.data;assert.equal(model.schema,1);assert.equal(model.post.id,post.id);assert.equal(model.route.kind,"singular");assert.equal(model.route.query.contentPage,2);assert.equal(model.route.query.blockPages["query-4-page"],2);assert.equal(model.route.query.archivePage,1);
      assert.equal(model.controls.replyParentId,child);assert.equal(model.controls.replyParentName,"Child Reader");assert.equal(model.commentsPagination.totalComments,3);assert.equal(model.viewer,null);assert.equal(model.controls.dates[model.post.publishedAt],"June 7, 2024");
      const encoded=JSON.stringify(model);assert.match(encoded,/PUBLIC-SSR-TWO/);assert.doesNotMatch(encoded,/PUBLIC-SSR-ONE|NAVIGATION-BODY-ONLY|PRIVATE-COMMENT|PRIVATE-CHILD|adminEmail|rawContent|pendingCommentCount|passwordHash|_passwordHash|api_key|_avatarEmail/);
      if(theme!=="classic"){
        sourceHTML=model.presentation.html;
        assert.equal(model.presentation.kind,"source");const document=dom(model.presentation.html);
        assert.equal(document.querySelector('form.worldact-native-comment-form [name="parentId"]')?.getAttribute("value"),String(child));
        assert.match(model.presentation.html,/PUBLIC-SSR-TWO/);assert.doesNotMatch(model.presentation.html,/PUBLIC-SSR-ONE/);
      }else assert.equal(model.presentation.kind,"classic");
    }
    for(const invalid of [String(deep),"2147483647","bad"]){
      const response=await f.api("/api/public/document?"+new URLSearchParams({path:`/?p=${post.id}&replytocom=${invalid}`}),"GET",undefined,"");assert.equal(response.response.status,200);assert.equal(response.data.controls.replyParentId,0);
    }
    const missing=await f.api("/api/public/document?"+new URLSearchParams({path:"/absent-document-"+f.stamp}),"GET",undefined,"");assert.equal(missing.response.status,404);assert.equal(missing.data.route.kind,"not-found");assert.equal(missing.data.post,null);
    const framework=await f.api("/api/public/document?"+new URLSearchParams({path:"/admin/posts"}),"GET",undefined,"");assert.equal(framework.response.status,400);
    // Submit the actual generated hidden parent through the native endpoint,
    // without a browser enhancer replacing its form values.
    const nativeForm=dom(sourceHTML).querySelector("form.worldact-native-comment-form")!,body=new URLSearchParams();
    for(const input of nativeForm.querySelectorAll("input[type=hidden]"))body.set(input.getAttribute("name")!,input.getAttribute("value") || "");
    body.set("authorName","Native Reply Reader");body.set("authorEmail",f.stamp+"@example.test");body.set("content","Native generated reply "+f.stamp);
    const saved=await fetch(base+nativeForm.getAttribute("action"),{method:"POST",redirect:"manual",headers:{Origin:origin,Referer:origin+path,"Content-Type":"application/x-www-form-urlencoded"},body});
    assert.equal(saved.status,303);const rows=(await pool.query("SELECT parent_id,user_id FROM comments WHERE post_id=$1 AND content LIKE $2",[post.id,"%"+f.stamp+"%"])).rows;
    assert.equal(rows.length,1);assert.equal(rows[0].parent_id,child);assert.equal(rows[0].user_id,null);
  }finally{await f.dispose();}
});

test("front-page detail, date query, canonical body page and true404 models preserve existing route distinctions",async()=>{
  const f=await approvalFixture("public-model-routes");
  try {
    const front=await f.post(),postsPage=await f.post();
    await pool.query("UPDATE posts SET type='page',content='<p>FIRST FRONT</p><!--nextpage--><p>SECOND FRONT</p>',raw_content='<p>FIRST FRONT</p><!--nextpage--><p>SECOND FRONT</p>' WHERE id=ANY($1::int[])",[[front.id,postsPage.id]]);
    await f.ok("/api/settings","PUT",{frontPageMode:"page",frontPageId:front.id,postsPageId:postsPage.id,permalinkStructure:""});
    const get=async(path:string)=>f.api("/api/public/document?"+new URLSearchParams({path}),"GET",undefined,"");
    const home=await get("/");assert.equal(home.data.route.kind,"front-page");assert.equal(home.data.route.detail,false);assert.equal(home.data.head.title,home.data.site.settings.siteTitle);
    const paged=await get("/?page=2&query-4-page=3");assert.equal(paged.data.route.detail,true);assert.equal(paged.data.post.contentPagination.page,2);assert.match(paged.data.head.canonical,/\?page=2$/);assert.match(JSON.stringify(paged.data),/SECOND FRONT/);assert.doesNotMatch(JSON.stringify(paged.data),/FIRST FRONT/);
    const listing=await get("/?page_id="+postsPage.id);assert.equal(listing.data.route.kind,"posts-page");assert.equal(listing.data.route.detail,true);assert.equal(listing.data.post.id,postsPage.id);assert.ok(listing.data.site.posts.length>0);assert.match(listing.data.head.title,new RegExp(postsPage.title));
    const date=await get("/?year=1901&monthnum=2");assert.equal(date.response.status,200);assert.equal(date.data.route.query.date.type,"date");assert.equal(date.data.route.query.date.year,1901);
    const malformed=await get("/?p="+front.id+"&page[]=2");assert.equal(malformed.response.status,404);assert.equal(malformed.data.route.kind,"not-found");
    await pool.query("UPDATE posts SET status='private' WHERE id=$1",[front.id]);
    const stale=await get("/");assert.equal(stale.response.status,404);assert.equal(stale.data.post,null);assert.doesNotMatch(JSON.stringify(stale.data),/FIRST FRONT|SECOND FRONT/);
  }finally{await f.dispose();}
});

test("cookie-only document context ignores Basic and contains only current session presentation identity",async()=>{
  const f=await approvalFixture("public-cookie-read");
  try {
    const member=await f.account("Reader"),headers={cookie:member.auth,authorization:"Basic invalid"};
    const user=await readCookieSessionUser({headers});assert.equal(user?.id,member.id);
    const context=await publicDocumentContext({headers},{cookieOnly:true});assert.equal(context.user?.id,member.id);assert.equal(context.sensitive,true);
    const anon=await publicDocumentContext({headers:{authorization:"Basic invalid"}},{cookieOnly:true});assert.equal(anon.user,undefined);assert.equal(anon.sensitive,false);
    const path="/",model=await readPublicDocument(path,context);assert.ok(!("kind" in model));if("kind" in model)return;
    assert.deepEqual(model.viewer,{id:member.id,displayName:"Reader",role:"subscriber",showAdminBar:true});assert.doesNotMatch(JSON.stringify(model.viewer),/email|username|token|session/);
    await f.api("/api/auth/logout","POST",{},member.auth);
    assert.equal(await readCookieSessionUser({headers}),undefined);
  }finally{await f.dispose();}
});

test("protected document grants fence body, excerpt, comments, footnotes, head and nested templates for accounts too",async()=>{
  const f=await approvalFixture("public-protected-document");
  try {
    const post=await f.post();await f.ok("/api/posts/"+post.id,"PUT",{version:post.version,password:"SSR-PRIVATE-PASSWORD",content:"<p>SSR-PROTECTED-BODY</p>",excerpt:"SSR-PROTECTED-EXCERPT",footnotes:[{id:"note",content:"SSR-PROTECTED-NOTE"}]});
    await pool.query("INSERT INTO comments(post_id,author_name,author_email,content,status) VALUES($1,'Private commenter','','SSR-PROTECTED-COMMENT','approved')",[post.id]);
    for(const auth of ["",f.admin,"worldact_post_"+post.id+"="+"a".repeat(64)]){
      const result=await f.api("/api/public/document?"+new URLSearchParams({path:"/?p="+post.id}),"GET",undefined,auth);assert.equal(result.response.status,200);
      assert.equal(result.data.post.locked,true);assert.equal(result.data.comments.length,0);assert.equal(result.data.controls.commentsOpen,false);
      assert.doesNotMatch(JSON.stringify(result.data),/SSR-PROTECTED-(?:BODY|EXCERPT|NOTE|COMMENT)|SSR-PRIVATE-PASSWORD/);
    }
    const unlock=await f.api("/api/public/posts/"+post.slug+"/unlock","POST",{password:"SSR-PRIVATE-PASSWORD"},"");assert.equal(unlock.response.status,200);
    const grant=unlock.response.headers.get("set-cookie")!.split(";")[0],allowed=await f.api("/api/public/document?"+new URLSearchParams({path:"/?p="+post.id}),"GET",undefined,grant);
    assert.equal(allowed.response.status,200);assert.equal(allowed.data.post.locked,false);assert.match(JSON.stringify(allowed.data),/SSR-PROTECTED-BODY/);assert.equal(allowed.data.controls.sensitive,true);
    await pool.query("UPDATE post_access_tokens SET expires_at=now()-interval '1 second' WHERE post_id=$1",[post.id]);
    const expired=await f.api("/api/public/document?"+new URLSearchParams({path:"/?p="+post.id}),"GET",undefined,grant);assert.equal(expired.data.post.locked,true);assert.doesNotMatch(JSON.stringify(expired.data),/SSR-PROTECTED-BODY/);
  }finally{await f.dispose();}
});

test("metadata helper remains body-free and subsequent immutable body read rejects private/type/slug replacements",async()=>{
  const f=await approvalFixture("public-identity-fences");
  try {
    const post=await f.post(),replacement=await f.post();
    const resolution=await resolvePublicDocumentRoute("/?p="+post.id);assert.equal(resolution.selectedId,post.id);assert.equal(resolution.selectedType,"post");
    const originalQuery=pool.query.bind(pool),sql:string[]=[];
    (pool as any).query=async(...args:any[])=>{sql.push(String(args[0]));return (originalQuery as any)(...args);};
    try{assert.deepEqual(await publicDocumentIdentity("/?p="+post.id),{status:200});}finally{(pool as any).query=originalQuery;}
    assert.ok(sql.length>0);for(const statement of sql)assert.doesNotMatch(statement,/raw_content|p\.content|\bblocks\b|password_hash AS/);
    await pool.query("UPDATE posts SET status='private',slug=$2 WHERE id=$1",[post.id,post.slug+"-private"]);
    await pool.query("UPDATE posts SET slug=$2 WHERE id=$1",[replacement.id,post.slug]);
    const context=await publicDocumentContext({headers:{}});
    await assert.rejects(readPublishedPostById(resolution.selectedId!,"post",{query:{},canReadProtectedPost:context.canReadProtectedPost}),/Post not found/);
    await pool.query("UPDATE posts SET status='publish',type='page' WHERE id=$1",[post.id]);
    await assert.rejects(readPublishedPostById(post.id,"post",{query:{},canReadProtectedPost:context.canReadProtectedPost}),/Post not found/);
  }finally{await f.dispose();}
});

test("document date aliases and scalar validation match the actual legacy site API, while date paths remain authoritative",async()=>{
  const f=await approvalFixture("public-month-alias");
  try {
    await f.ok("/api/settings","PUT",{frontPageMode:"posts",frontPageId:null,postsPageId:null,timezone:"UTC"});
    const june=await f.post(),july=await f.post();
    await pool.query("UPDATE posts SET published_at='2024-06-15T12:00:00Z' WHERE id=$1",[june.id]);
    await pool.query("UPDATE posts SET published_at='2024-07-15T12:00:00Z' WHERE id=$1",[july.id]);
    const rows=[
      ["year=2024&month=6",200],["year=2024&monthnum=6",200],["year=2024&month=06&monthnum=6",200],
      ["m=202406&month=6",200],["year=2024&month=6&day=15",200],
      ["year=2024&month=6&month=7",400],["year=2024&month[]=6",400],["year=2024&month[x]=6",400],
      ["year=2024&month=6&monthnum=7",400],["year=2024&month=13",400],["month=6",400],
      ["m=202407&month=6",400],["year=2024&month=6&w=2",400],
    ] as const;
    for(const [query,status] of rows){
      const legacy=await f.api("/api/public/site?"+query,"GET",undefined,"");
      const document=await f.api("/api/public/document?"+new URLSearchParams({path:"/?"+query}),"GET",undefined,"");
      assert.equal(legacy.response.status,status,"legacy "+query);assert.equal(document.response.status,status,"document "+query);
      if(status===200){
        assert.deepEqual(document.data.site.posts.map((post:any)=>post.id),legacy.data.posts.map((post:any)=>post.id),query);
        assert.deepEqual(document.data.route.query.date,legacy.data.archive,query);
        assert.ok(document.data.site.posts.some((post:any)=>post.id===june.id));assert.ok(!document.data.site.posts.some((post:any)=>post.id===july.id));
      }
    }
    const path=await f.api("/api/public/document?"+new URLSearchParams({path:"/2024/06/?year=1901&month=7&monthnum=8&m=190102&day=2&w=3"}),"GET",undefined,"");
    assert.equal(path.response.status,200);assert.equal(path.data.route.query.date.year,2024);assert.equal(path.data.route.query.date.month,6);
    assert.ok(path.data.site.posts.some((post:any)=>post.id===june.id));assert.ok(!path.data.site.posts.some((post:any)=>post.id===july.id));
    assert.equal(path.data.route.query.values.month,undefined);assert.equal(path.data.route.query.values.monthnum,"6");
  }finally{await f.dispose();}
});
