import test, { after } from "./isolated-test.js";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { parseHTML } from "linkedom";
import { pool } from "../server/db.js";
import { approvalFixture } from "./comment-approval-fixtures.js";
import { PublicDocumentView } from "../src/public/PublicDocumentView.js";
import type { PublicDocumentModel } from "../shared/public-document.js";

after(() => pool.end());
test("public views render persisted four-theme documents in Node without DOM globals and retain native forms", async () => {
  assert.equal(typeof window, "undefined");
  assert.equal(typeof DOMParser, "undefined");
  const fixture=await approvalFixture("public-view");
  try {
    const post=await fixture.post();
    await fixture.ok(`/api/posts/${post.id}`,"PUT",{content:"<p>VIEW FIRST BODY</p><!--nextpage--><p>VIEW SECOND BODY</p>"});
    await fixture.ok("/api/settings","PUT",{permalinkStructure:"",closeCommentsDays:0,threadComments:true,threadDepth:3});
    const first=(await pool.query("INSERT INTO comments(post_id,author_name,author_email,content,status) VALUES($1,'View Root','PRIVATE-VIEW@example.test','<p>VIEW ROOT CONTENT</p>','approved') RETURNING id",[post.id])).rows[0].id;
    const path=`/?p=${post.id}&page=2&query-4-page=2&commentPage=1&replytocom=${first}`;
    const continuation=(html:string,kind:"comment"|"password")=>{
      const {document}=parseHTML(html),form=document.querySelector(kind==="comment"?'form[action="/wp-comments-post.php"]':'form[action="/post-password"]');
      assert.ok(form,kind);
      const value=form.querySelector('input[name="redirect_to"]')?.getAttribute("value");
      assert.ok(value,"native forms carry explicit request context");
      const url=new URL(value,"https://worldact.invalid");
      assert.equal(url.pathname,"/");
      for(const [key,expected] of Object.entries({p:String(post.id),page:"2","query-4-page":"2",commentPage:"1"}))assert.equal(url.searchParams.get(key),expected,key);
      assert.equal(url.searchParams.get("replytocom"),kind==="password"?String(first):null,"only password continuation retains original Reply for fresh eligibility validation");
      assert.equal(url.hash,kind==="comment"?"#respond":"");
      for(const internal of ["postId","requestPath","type","contentPage","unapproved","moderation-hash"])assert.equal(url.searchParams.has(internal),false,internal);
    };
    for(const theme of ["twentytwentythree","twentytwentyfour","twentytwentyfive","classic"]){
      await fixture.ok("/api/settings","PUT",{theme});
      const model=await fixture.ok("/api/public/document?"+new URLSearchParams({path})) as PublicDocumentModel;
      const html=renderToString(createElement(PublicDocumentView,{model}));
      assert.ok(html.includes("VIEW SECOND BODY"),theme);
      assert.ok(!html.includes("VIEW FIRST BODY"),theme);
      assert.ok(html.includes('action="/wp-comments-post.php"'),theme);
      assert.match(html,new RegExp('name="(?:parentId|comment_parent)"[^>]*value="'+first+'"'),theme);
      assert.ok(!html.includes("PRIVATE-VIEW@example.test"),theme);
      assert.ok(!html.includes("Loading…"),theme);
      continuation(html,"comment");
      if(theme==="classic"){
        assert.ok(html.includes('class="site-header"'));
        assert.ok(html.includes('class="site-footer"'));
        assert.ok(html.includes('method="post"'));
      }else assert.ok(html.includes('class="wp-site-blocks"'));
      await fixture.ok(`/api/posts/${post.id}`,"PUT",{password:"view-native-return-fixture-secret"});
      const protectedModel=await fixture.ok("/api/public/document?"+new URLSearchParams({path})) as PublicDocumentModel;
      const protectedHTML=renderToString(createElement(PublicDocumentView,{model:protectedModel}));
      assert.ok(!protectedHTML.includes("VIEW SECOND BODY"),theme);
      continuation(protectedHTML,"password");
      await fixture.ok(`/api/posts/${post.id}`,"PUT",{password:""});
    }
  } finally {await fixture.dispose();}
});
