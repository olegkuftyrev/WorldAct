import test, { after } from "./isolated-test.js";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
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
    const path=`/?p=${post.id}&page=2&replytocom=${first}`;
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
      if(theme==="classic"){
        assert.ok(html.includes('class="site-header"'));
        assert.ok(html.includes('class="site-footer"'));
        assert.ok(html.includes('method="post"'));
      }else assert.ok(html.includes('class="wp-site-blocks"'));
    }
  } finally {await fixture.dispose();}
});
