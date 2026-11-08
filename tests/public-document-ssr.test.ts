import test,{after} from "./isolated-test.js";
import assert from "node:assert/strict";
import {DOMParser} from "linkedom";
import {readFile} from "node:fs/promises";
import path from "node:path";
import {pool,rootDir} from "../server/db.js";
import {approvalFixture,base,origin} from "./comment-approval-fixtures.js";
import {renderPublicDocument,serializePublicDocument,MAX_PUBLIC_DOCUMENT_BYTES} from "../server/render-public-document.js";
import type {PublicDocumentModel} from "../shared/public-document.js";

after(()=>pool.end());
const parse=(html:string)=>new DOMParser().parseFromString(html,"text/html");
const bootstrap=(html:string)=>JSON.parse(parse(html).querySelector("#worldact-public-document")!.textContent!) as PublicDocumentModel;
async function get(route:string,headers:Record<string,string>={}){const response=await fetch(base+route,{headers});return {response,html:await response.text()};}

test("actual Node HTML has all four persisted presentations, selected bodies, native forms, counters and private HEAD/conditional semantics",async()=>{
  const f=await approvalFixture("public-ssr-html");
  try {
    await f.ok("/api/settings","PUT",{frontPageMode:"posts",frontPageId:null,postsPageId:null,permalinkStructure:"",threadComments:true,threadDepth:3,paginateComments:false,showAvatars:false,notifyComments:false,notifyModeration:false});
    const post=await f.post();await f.ok("/api/posts/"+post.id,"PUT",{content:"<p>SSR ACTUAL FIRST</p><!--nextpage--><p>SSR ACTUAL SECOND</p>"});
    const parent=(await pool.query("INSERT INTO comments(post_id,author_name,author_email,content,status) VALUES($1,'SSR Parent','PRIVATE-SSR@example.test','<p>SSR APPROVED COMMENT</p>','approved') RETURNING id",[post.id])).rows[0].id;
    const route=`/?p=${post.id}&page=2&query-4-page=2&commentPage=1&replytocom=${parent}`;
    let sourceHTML="";
    for(const theme of ["twentytwentythree","twentytwentyfour","twentytwentyfive","classic"]){
      await f.ok("/api/settings","PUT",{theme});
      const result=await get(route);assert.equal(result.response.status,200,theme);assert.match(result.response.headers.get("content-type") || "",/text\/html/);
      const document=parse(result.html),model=bootstrap(result.html),root=document.querySelector("#root")!;
      assert.equal(model.post!.id,post.id);assert.equal(model.route.query.contentPage,2);assert.equal(model.route.query.archivePage,1);assert.equal(model.route.query.blockPages["query-4-page"],2);assert.equal(model.controls.replyParentId,parent);
      assert.match(root.innerHTML,/SSR ACTUAL SECOND/);assert.doesNotMatch(result.html,/SSR ACTUAL FIRST|PRIVATE-SSR@example|Loading WorldAct|Loading…/);assert.match(root.innerHTML,/SSR APPROVED COMMENT/);
      assert.equal(document.querySelectorAll("title").length,1);assert.equal(document.querySelector("title")!.textContent,model.head.title);
      assert.ok(document.querySelector('link[rel="stylesheet"]'));assert.ok(document.querySelector("style[data-worldact-public-gate]"));assert.equal(document.querySelectorAll("#worldact-public-document").length,1);
      const form=document.querySelector('form[action="/wp-comments-post.php"]')!;assert.ok(form,theme);assert.equal(form.getAttribute("method"),"post");
      assert.equal(form.querySelector('[name="parentId"],[name="comment_parent"]')!.getAttribute("value"),String(parent));
      const back=new URL(model.controls.commentReturnPath,origin);assert.equal(back.searchParams.get("page"),"2");assert.equal(back.searchParams.get("query-4-page"),"2");assert.equal(back.searchParams.get("commentPage"),"1");
      if(theme!=="classic"){
        sourceHTML=result.html;const reply=new URL(document.querySelector("a[data-comment-reply]")!.getAttribute("href")!,origin);
        assert.equal(reply.searchParams.get("page"),"2");assert.equal(reply.searchParams.get("query-4-page"),"2");assert.equal(reply.searchParams.get("commentPage"),"1");
      }
      for(const headers of [{"If-Modified-Since":new Date(Date.now()+86400000).toUTCString()},{"If-None-Match":"*"}] as Record<string,string>[]){
        const conditional=await get(route,headers);assert.equal(conditional.response.status,200);assert.equal(conditional.response.headers.get("etag"),null);assert.equal(conditional.response.headers.get("last-modified"),null);assert.equal(bootstrap(conditional.html).post!.id,post.id);
      }
      const head=await fetch(base+route,{method:"HEAD"});assert.equal(head.status,200);assert.equal(await head.text(),"");assert.equal(Number(head.headers.get("content-length")),Buffer.byteLength(result.html));assert.match(head.headers.get("cache-control") || "",/no-store.*private/);
    }
    const form=parse(sourceHTML).querySelector('form[action="/wp-comments-post.php"]')!,body=new URLSearchParams();
    for(const input of form.querySelectorAll('input[type="hidden"]'))body.set(input.getAttribute("name")!,input.getAttribute("value") || "");
    body.set("authorName","Actual SSR Native");body.set("authorEmail",f.stamp+"@example.test");body.set("content","SSR Native "+f.stamp);
    const saved=await fetch(base+form.getAttribute("action"),{method:"POST",redirect:"manual",headers:{Origin:origin,Referer:origin+route,"Content-Type":"application/x-www-form-urlencoded"},body});assert.equal(saved.status,303);
    const rows=(await pool.query("SELECT parent_id FROM comments WHERE post_id=$1 AND content LIKE $2",[post.id,"%"+f.stamp+"%"])).rows;assert.equal(rows.length,1);assert.equal(rows[0].parent_id,parent);
    const unknown=await get("/missing-ssr-"+f.stamp);assert.equal(unknown.response.status,404);assert.equal(bootstrap(unknown.html).route.kind,"not-found");assert.match(parse(unknown.html).querySelector("#root")!.textContent!,/not found|found at this location/i);
  }finally{await f.dispose();}
});

test("real server HTML uses cookie-only session identity and current protected grants without leaking protected model/head fields",async()=>{
  const f=await approvalFixture("public-ssr-grants");let uuid:string|undefined;
  try {
    const post=await f.post();await f.ok("/api/posts/"+post.id,"PUT",{password:"SSR HTML PRIVATE PASSWORD",content:"<p>SSR-HTML-PROTECTED-BODY</p>",excerpt:"SSR-HTML-PROTECTED-EXCERPT",footnotes:[{id:"protected-note",content:"SSR-HTML-PROTECTED-NOTE"}]});
    const created=await f.ok("/api/profile/application-passwords","POST",{name:"SSR HTML read-only"});uuid=created.applicationPassword.uuid;
    const authorization="Basic "+Buffer.from(f.adminUser.username+":"+created.password).toString("base64"),before=(await pool.query("SELECT last_used,last_ip FROM application_passwords WHERE uuid=$1",[uuid])).rows[0];
    for(const cookie of ["",f.admin,"worldact_session="+"f".repeat(64),"worldact_post_"+post.id+"="+"a".repeat(64)]){
      const result=await get("/?p="+post.id,{Cookie:cookie,Authorization:authorization});assert.equal(result.response.status,200);const model=bootstrap(result.html);assert.equal(model.post!.locked,true);
      assert.equal(model.viewer?.id || null,cookie===f.admin?f.adminUser.id:null);assert.doesNotMatch(result.html,/SSR-HTML-PROTECTED-(?:BODY|EXCERPT|NOTE)|SSR HTML PRIVATE PASSWORD|key_hash|token_hash/);
    }
    assert.deepEqual((await pool.query("SELECT last_used,last_ip FROM application_passwords WHERE uuid=$1",[uuid])).rows[0],before);
    const invalidBasic=await get("/?p="+post.id,{Authorization:"Basic invalid"});assert.equal(invalidBasic.response.status,200);
    const unlock=await f.api("/api/public/posts/"+post.slug+"/unlock","POST",{password:"SSR HTML PRIVATE PASSWORD"},"");assert.equal(unlock.response.status,200);const grant=unlock.response.headers.get("set-cookie")!.split(";")[0];
    const allowed=await get("/?p="+post.id,{Cookie:grant});assert.equal(bootstrap(allowed.html).post!.locked,false);assert.match(parse(allowed.html).querySelector("#root")!.textContent!,/SSR-HTML-PROTECTED-BODY/);
    await pool.query("UPDATE post_access_tokens SET expires_at=now()-interval '1 second' WHERE post_id=$1",[post.id]);
    const expired=await get("/?p="+post.id,{Cookie:grant});assert.equal(bootstrap(expired.html).post!.locked,true);assert.doesNotMatch(expired.html,/SSR-HTML-PROTECTED-BODY/);
  }finally{if(uuid)await f.api("/api/profile/application-passwords/"+uuid,"DELETE");await f.dispose();}
});

test("HTML/bootstrap/head/style boundaries resist script, style and iframe terminators and assembly rejects escaped-byte overflow",async()=>{
  const f=await approvalFixture("public-ssr-escaping");
  try {
    const post=await f.post(),hostile='Literal </script><script id="ssr-breakout">x</script><iframe id="ssr-frame"></iframe> & " < > \u2028\u2029';
    await pool.query("UPDATE posts SET title=$2 WHERE id=$1",[post.id,hostile]);
    const result=await get("/?p="+post.id);assert.equal(result.response.status,200);const document=parse(result.html),model=bootstrap(result.html);
    assert.equal(model.post!.title,hostile);assert.equal(document.querySelector("#ssr-breakout,#ssr-frame"),null);assert.equal(document.querySelector("title")!.textContent,model.head.title);
    const raw=document.querySelector("#worldact-public-document")!.textContent!;assert.doesNotMatch(raw,/[<>&\u2028\u2029]/);assert.equal(JSON.parse(raw).post.title,hostile);
    const index=await readFile(path.join(rootDir,"dist/index.html"),"utf8"),copy=structuredClone(model);
    copy.design.theme!.css+='/* </style><script id="ssr-css-breakout">x</script> */';
    copy.head.seo={description:hostile,title:hostile,type:"article",url:"https://example.test/?x=\"&<>",image:null};copy.head.tileImage='/uploads/icon.png?x="&<>';
    const escapedHTML=renderPublicDocument(index,copy),parsed=parse(escapedHTML);assert.equal(parsed.querySelector("#ssr-css-breakout,#ssr-breakout,#ssr-frame"),null);
    assert.equal(parsed.querySelector('meta[name="description"]')!.getAttribute("content"),hostile);assert.equal(parsed.querySelectorAll('meta[name="description"]').length,1);
    const oversized=structuredClone(model);oversized.presentation={kind:"source",document:{id:1,slug:"index",title:"Budget",type:"template"},html:"<".repeat(Math.floor(MAX_PUBLIC_DOCUMENT_BYTES/6)+1)};
    assert.throws(()=>serializePublicDocument(oversized),error=>Boolean(error && typeof error==="object" && "status" in error && error.status===413));
    assert.throws(()=>renderPublicDocument(index.replace("<!--worldact-public-root-->",""),model),/markers/);
  }finally{await f.dispose();}
});

test("actual SSR keeps renderer overflow as bounded413 without partial successful HTML",async()=>{
  const f=await approvalFixture("public-ssr-render-budget");
  try {
    const post=await f.post(),content="<p>"+"b".repeat(8*1024*1024+1)+"</p>";
    await pool.query("UPDATE posts SET content=$2,raw_content=$2 WHERE id=$1",[post.id,content]);
    const result=await get("/?p="+post.id);assert.equal(result.response.status,413);assert.match(result.response.headers.get("content-type") || "",/application\/json/);assert.doesNotMatch(result.html,/<!doctype|worldact-public-document|bbbbbbbbbbbb/);assert.match(JSON.parse(result.html).error,/8 MiB/);
  }finally{await f.dispose();}
});
