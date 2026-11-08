import test, { after } from "./isolated-test.js";
import assert from "node:assert/strict";
import { DOMParser } from "linkedom";
import { pool } from "../server/db.js";
import { commentsOpen } from "../shared/comment-open.js";
import { commentReturnPath, commentLoginHref } from "../shared/comment-links.js";
import { approvalFixture } from "./comment-approval-fixtures.js";

after(() => pool.end());
const dom = (html: string) => new DOMParser().parseFromString(html, "text/html");

test("default source age closure is post-only and strictly greater than the day boundary, with undated drafts open", () => {
  const now = Date.parse("2026-06-20T12:00:00Z"), boundary = now - 14 * 86_400_000;
  for (const delta of [-1, 0, 1]) assert.equal(commentsOpen({type:"post",commentStatus:"open",publishedAt:new Date(boundary + delta)}, {closeCommentsDays:14}, now), delta >= 0);
  assert.equal(commentsOpen({type:"post",comment_status:"open",published_at:new Date(boundary - 1)}, {closeCommentsDays:14}, now), false);
  for (const type of ["page", "attachment", "custom"]) assert.equal(commentsOpen({type,commentStatus:"open",publishedAt:"2000-01-01"}, {closeCommentsDays:14}, now), true);
  for (const publishedAt of [null, undefined, "0000-00-00 00:00:00"]) assert.equal(commentsOpen({type:"post",commentStatus:"open",publishedAt}, {closeCommentsDays:14}, now), true);
  for (const closeCommentsDays of [0, -1, undefined]) assert.equal(commentsOpen({type:"post",commentStatus:"open",publishedAt:"2000-01-01"}, {closeCommentsDays}, now), true);
  for (const type of ["post", "page"]) assert.equal(commentsOpen({type,commentStatus:"closed",publishedAt:null}, {closeCommentsDays:0}, now), false);
});

test("public Reply and login returns retain visible Plain identity and independent counters without internal or moderation fields", () => {
  for (const identity of ["p", "page_id"]) {
    const path = commentReturnPath(`/?${identity}=71&page=2&query-4-page=2&commentPage=2&unapproved=5&moderation-hash=PRIVATE&postId=71&replytocom=4`, {contentPage:2,requestPath:"/wrong/",postId:71}, 19);
    const url = new URL(path, "https://worldact.invalid");
    for (const [key,value] of [[identity,"71"],["page","2"],["query-4-page","2"],["commentPage","2"],["replytocom","19"]]) assert.equal(url.searchParams.get(key), value);
    for (const key of ["postId","requestPath","contentPage","unapproved","moderation-hash"]) assert.equal(url.searchParams.has(key),false);
    assert.equal(url.hash,"#respond");
    const login = new URL(commentLoginHref(commentReturnPath(path)),"https://worldact.invalid"), returned=new URL(login.searchParams.get("redirect_to")!,"https://worldact.invalid");
    assert.equal(login.pathname,"/login");assert.equal(returned.searchParams.get(identity),"71");assert.equal(returned.searchParams.has("replytocom"),false);assert.equal(returned.hash,"#respond");
  }
  for (const unsafe of ["https://evil.example/", "//evil.example/", "/login?redirect_to=https://evil.example/"]) assert.equal(commentReturnPath(unsafe), "/#respond");
  assert.equal(commentReturnPath("/encoded/%E2%9C%93/?page=2",{"query-4-page":3,commentPage:2}),"/encoded/%E2%9C%93/?page=2&query-4-page=3&commentPage=2#respond");
});

test("real admission and source Reply/form agree for old posts, old pages, undated publication, explicit closure and disabled age", async () => {
  const f = await approvalFixture("public-open");
  try {
    await f.ok("/api/settings","PUT",{theme:"twentytwentyfive",closeCommentsDays:14,threadComments:true,threadDepth:3,paginateComments:false,showAvatars:false,notifyComments:false,notifyModeration:false});
    for (const [label,type,date,status,days,open] of [
      ["old-post","post","2000-01-01","open",14,false],
      ["old-page","page","2000-01-01","open",14,true],
      ["future-post","post","2099-01-01","open",14,true],
      ["undated","post",null,"open",14,true],
      ["closed-page","page","2000-01-01","closed",0,false],
      ["disabled-age","post","2000-01-01","open",0,true],
    ] as const) {
      const post=await f.post();
      await pool.query("UPDATE posts SET type=$2,published_at=$3,comment_status=$4,created_at='1990-01-01' WHERE id=$1",[post.id,type,date,status]);
      await pool.query("INSERT INTO comments(post_id,author_name,author_email,content,status) VALUES($1,$2,'private@example.test','<p>Existing human</p>','approved')",[post.id,label]);
      await f.ok("/api/settings","PUT",{closeCommentsDays:days});
      const rendered=await f.api(`/api/public/templates/single?postId=${post.id}&requestPath=${encodeURIComponent(`/?${type==="page"?"page_id":"p"}=${post.id}`)}`,"GET",undefined,"");
      assert.equal(rendered.response.status,200,label);const document=dom(rendered.data.content);
      assert.equal(Boolean(document.querySelector("form.worldact-native-comment-form")),open,label+" form");
      assert.equal(Boolean(document.querySelector(".comment-reply-link[data-comment-reply]")),open,label+" Reply");
      const before=Number((await pool.query("SELECT count(*) FROM comments WHERE post_id=$1",[post.id])).rows[0].count),submitted=await f.submit(post.id,{content:"Actual admission "+label});
      assert.equal(submitted.response.status,open?201:409,label+" admission");
      assert.equal(Number((await pool.query("SELECT count(*) FROM comments WHERE post_id=$1",[post.id])).rows[0].count),before+(open?1:0),label+" rows");
      // Each row exercises a separate open-state policy. Age only its successful
      // guest admission before the next row; immediate flooding is tested separately.
      if (open) assert.equal((await pool.query("UPDATE comments SET created_at=date_trunc('second',clock_timestamp())-interval '20 seconds' WHERE id=$1 AND post_id=$2",[submitted.data.comment.id,post.id])).rowCount,1);
      assert.doesNotMatch(rendered.data.content,/private@example|_avatarEmail|_accountAvatarEmail/);
    }
    const draft=await f.post();await pool.query("UPDATE posts SET status='draft',published_at=NULL WHERE id=$1",[draft.id]);
    assert.equal((await f.submit(draft.id)).response.status,404,"undated drafts remain unpublished at admission");
  } finally {await f.dispose();}
});

test("real registration-only source links navigate to local login, then authenticated human Reply has source accessible attributes and current-route href", async () => {
  const f=await approvalFixture("public-reply-login");
  try {
    await f.ok("/api/settings","PUT",{theme:"twentytwentyfive",permalinkStructure:"",commentRegistration:true,closeCommentsDays:0,threadComments:true,threadDepth:3,paginateComments:false,showAvatars:false,notifyComments:false,notifyModeration:false});
    const post=await f.post(),member=await f.account("Reader");
    await pool.query("UPDATE posts SET content=$2,raw_content=$2 WHERE id=$1",[post.id,"<p>BODY ONE</p><!--nextpage--><p>BODY TWO</p>"]);
    const ids:number[]=[];
    for(const [name,parent,type] of [["Root",null,"comment"],["Child",0,"comment"],["Deep",1,"comment"],["Ping",null,"pingback"]] as const) ids.push((await pool.query("INSERT INTO comments(post_id,parent_id,author_name,author_email,content,status,type) VALUES($1,$2,$3,'PRIVATE@example.test',$4,'approved',$5) RETURNING id",[post.id,parent===null?null:ids[parent],name,"<p>"+name+" body</p>",type])).rows[0].id);
    const current=`/?p=${post.id}&page=2&query-4-page=2&commentPage=2&unapproved=71&moderation-hash=PRIVATE`,params=new URLSearchParams({postId:String(post.id),requestPath:current,p:String(post.id),page:"2",contentPage:"2","query-4-page":"2",commentPage:"2"}),route="/api/public/templates/single?"+params;
    const guest=await f.api(route,"GET",undefined,"");assert.equal(guest.response.status,200);const guestDOM=dom(guest.data.content);
    assert.equal(guestDOM.querySelectorAll(".comment-reply-login").length,2);assert.equal(guestDOM.querySelectorAll(".comment-reply-link,[data-comment-reply],form.worldact-native-comment-form").length,0);
    const formLogin=guestDOM.querySelector("#respond a")!.getAttribute("href");
    for(const link of guestDOM.querySelectorAll(".comment-reply-login")) {
      assert.equal(link.textContent,"Log in to Reply");assert.ok(link.getAttribute("rel")!.split(" ").includes("nofollow"));assert.equal(link.getAttribute("href"),formLogin);
      const login=new URL(link.getAttribute("href")!,"https://worldact.invalid"),back=new URL(login.searchParams.get("redirect_to")!,"https://worldact.invalid");
      assert.equal(login.pathname,"/login");for(const [key,value] of [["p",String(post.id)],["page","2"],["query-4-page","2"],["commentPage","2"]])assert.equal(back.searchParams.get(key),value);
      assert.equal(back.hash,"#respond");for(const key of ["unapproved","moderation-hash","contentPage","postId","requestPath"])assert.equal(back.searchParams.has(key),false);
    }
    const rejected=await f.submit(post.id,{parentId:ids[0]});assert.equal(rejected.response.status,401);
    const authenticated=await f.api(route,"GET",undefined,member.auth);assert.equal(authenticated.response.status,200);const document=dom(authenticated.data.content),links=[...document.querySelectorAll(".comment-reply-link")];
    assert.equal(links.length,2);assert.equal(document.querySelectorAll(".comment-reply-login").length,0);assert.ok(document.querySelector("form.worldact-native-comment-form"));assert.match(authenticated.data.content,/BODY TWO/);assert.doesNotMatch(authenticated.data.content,/BODY ONE/);
    for(const [index,link] of links.entries()) {
      assert.equal(link.getAttribute("aria-label"),"Reply to "+["Root","Child"][index]);assert.equal(link.getAttribute("data-replyto"),link.getAttribute("aria-label"));assert.equal(link.getAttribute("data-commentid"),String(ids[index]));assert.equal(link.getAttribute("data-postid"),String(post.id));assert.equal(link.getAttribute("data-belowelement"),"comment-"+ids[index]);assert.equal(link.getAttribute("data-respondelement"),"respond");assert.ok(link.getAttribute("rel")!.split(" ").includes("nofollow"));
      const href=new URL(link.getAttribute("href")!,"https://worldact.invalid");assert.equal(href.searchParams.get("replytocom"),String(ids[index]));assert.equal(href.searchParams.get("p"),String(post.id));assert.equal(href.searchParams.get("page"),"2");assert.equal(href.searchParams.get("query-4-page"),"2");assert.equal(href.searchParams.get("commentPage"),"2");assert.equal(href.hash,"#respond");assert.equal(href.searchParams.has("moderation-hash"),false);
    }
    assert.equal(document.querySelector(`#comment-${ids[2]} [data-comment-reply],#comment-${ids[3]} [data-comment-reply],img`),null);
    assert.doesNotMatch(authenticated.data.content,/PRIVATE@example|_avatarEmail|_accountAvatarEmail/);
    const saved=await f.submit(post.id,{parentId:ids[1],content:"Actual registered reply"},member.auth);assert.equal(saved.response.status,201);
    const row=(await pool.query("SELECT parent_id,user_id FROM comments WHERE id=$1",[saved.data.comment.id])).rows[0];assert.equal(row.parent_id,ids[1]);assert.equal(row.user_id,member.id);
  } finally {await f.dispose();}
});
