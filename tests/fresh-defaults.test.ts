import test, { after } from "./isolated-test.js";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { parse } from "@wordpress/block-serialization-default-parser";
import { autop } from "@wordpress/autop";
import { parseHTML } from "linkedom";
import { pool, getSettings } from "../server/db.js";
import { cleanContent, cleanRawContent } from "../server/utils.js";
import { seedInitialContent, initialHelloContent, initialSamplePageContent, initialCommentContent } from "../server/initial-content.js";
import { buildPrivacyPolicyGuide, privacyPolicyRawContent } from "../server/privacy-guide.js";

after(() => pool.end());
const base = process.env.TEST_API_URL!, origin = process.env.APP_ORIGIN!;
const names = (raw: string) => parse(raw).filter(block => block.blockName).map(block => block.blockName);
async function api(route: string, method = "GET", body?: unknown, cookie = "") {
  const response = await fetch(base + route, { method, signal: AbortSignal.timeout(10_000), headers: { Origin: origin, "Content-Type": "application/json", ...(cookie ? { Cookie: cookie } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { response, data: await response.json() };
}
async function login(remember?: boolean) {
  const result = await api("/api/auth/login", "POST", { login: process.env.ADMIN_EMAIL, password: process.env.ADMIN_PASSWORD, ...(remember === undefined ? {} : { remember }) });
  assert.equal(result.response.status, 200); return result.response.headers.get("set-cookie")!.split(";")[0];
}

test("CLI-seeded defaults keep full source native structure, closed sample pages and a private review policy", async () => {
  const rows = (await pool.query("SELECT * FROM posts ORDER BY id")).rows;
  assert.equal(rows.length, 3); const [hello, sample, policy] = rows;
  assert.deepEqual(rows.map(row => [row.slug,row.type,row.status]), [["hello-world","post","publish"],["sample-page","page","publish"],["privacy-policy","page","draft"]]);
  assert.equal(hello.raw_content, cleanRawContent(initialHelloContent)); assert.equal(hello.content, cleanContent(initialHelloContent));
  assert.equal(sample.raw_content, cleanRawContent(initialSamplePageContent)); assert.equal(sample.content, cleanContent(initialSamplePageContent));
  assert.deepEqual(names(hello.raw_content), ["core/paragraph"]);
  assert.deepEqual(names(sample.raw_content), ["core/paragraph","core/quote","core/paragraph","core/quote","core/paragraph"]);
  const quotes = parse(sample.raw_content).filter(block => block.blockName === "core/quote");
  assert.equal(quotes.length, 2); assert.ok(quotes.every(block => block.innerBlocks.length === 1 && block.innerBlocks[0].blockName === "core/paragraph"));
  assert.match(sample.content, /bike messenger by day/); assert.match(sample.content, /founded in 1971/); assert.match(sample.content, /href="\/admin"/);
  for (const row of [sample,policy]) { assert.equal(row.comment_status,"closed"); assert.equal(row.template_slug,""); assert.equal(row.excerpt,""); }
  assert.equal(policy.published_at,null); assert.equal((await getSettings()).privacyPageId, policy.id);
  assert.equal(policy.raw_content, cleanRawContent(privacyPolicyRawContent(buildPrivacyPolicyGuide(await getSettings()))));
  assert.ok(names(policy.raw_content).every(name => ["core/heading","core/paragraph"].includes(name!)));
  assert.match(policy.raw_content, /<h2 class="wp-block-heading">/); assert.match(policy.content, /\[Add the organization/);
  const comment = (await pool.query("SELECT * FROM comments WHERE post_id=$1", [hello.id])).rows[0];
  assert.equal(comment.author_name,"A WorldAct Commenter"); assert.match(comment.author_email,/\.example$/); assert.equal(comment.author_url,"/"); assert.equal(comment.content,cleanContent(autop(initialCommentContent))); assert.match(comment.content,/<br \/>\nTo get started/); assert.match(comment.content,/https:\/\/gravatar.com\//);
  assert.deepEqual((await pool.query("SELECT slug,enabled,settings FROM extensions ORDER BY slug")).rows,[{slug:"akismet",enabled:false,settings:{sendComments:false}},{slug:"hello-dolly",enabled:false,settings:{}}]);
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM extension_secrets")).rows[0].n,0);
  assert.equal((await api("/api/public/posts/privacy-policy")).response.status,404);
  const site=(await api("/api/public/site")).data; assert.deepEqual(site.posts.map((post:any)=>post.id),[hello.id]); assert.deepEqual(site.pages.map((page:any)=>page.id),[sample.id]);
  assert.ok(!JSON.stringify(site).includes("[Add the organization"));
  const publicPost=(await api("/api/public/posts/hello-world")).data;
  const visible=publicPost.comments.find((item:any)=>item.id===comment.id);assert.ok(visible);
  const commentDOM=parseHTML("<body>"+visible.content+"</body>").document;
  assert.equal(commentDOM.querySelectorAll("p").length,1);assert.equal(commentDOM.querySelectorAll("br").length,2);assert.equal(commentDOM.querySelector("a")!.getAttribute("href"),"https://gravatar.com/");
  const template=await api("/api/public/templates/single?postId="+hello.id);assert.equal(template.response.status,200);
  const renderedComment=parseHTML(template.data.content).document.querySelector(`#comment-${comment.id} .wp-block-comment-content`)!;assert.ok(renderedComment);
  assert.equal(renderedComment.querySelectorAll("p").length,1);assert.equal(renderedComment.querySelectorAll("br").length,2);assert.equal(renderedComment.querySelector("a")!.textContent,"Gravatar");
});

test("once-only sample initialization preserves edits, deleted drafts/plugins and existing policy slug content", async () => {
  const db=await pool.connect(), admin=(await pool.query("SELECT id FROM users WHERE role='administrator' ORDER BY id LIMIT 1")).rows[0].id;
  try {
    await db.query("BEGIN"); await db.query("SELECT pg_advisory_xact_lock(hashtext('worldact-seed'))");
    // Only a rolled-back fixture resets these seed rows; another test's site
    // never sees a committed content, plugin, marker or settings reset.
    await db.query("DELETE FROM posts; DELETE FROM extensions; DELETE FROM seed_markers WHERE name='initial-content-v1'");
    await db.query("UPDATE settings SET data=data || $1::jsonb WHERE id=1",[JSON.stringify({privacyPageId:null,siteTitle:"Fresh transaction",siteUrl:"https://fresh.example.invalid",showAvatars:false,commentCookieConsent:false})]);
    await seedInitialContent(db,admin);
    const policy=(await db.query("SELECT id,content FROM posts WHERE slug='privacy-policy'")).rows[0];
    assert.match(policy.content,/https:\/\/fresh.example.invalid/); assert.match(policy.content,/avatars are disabled/); assert.match(policy.content,/not saved for future comments/);
    assert.equal((await getSettings(db)).privacyPageId,policy.id);
    await db.query("UPDATE posts SET title='Deliberately edited' WHERE slug='hello-world'; DELETE FROM posts WHERE slug IN('sample-page','privacy-policy'); DELETE FROM extensions");
    await db.query("UPDATE settings SET data=data || '{\"privacyPageId\":null,\"siteTitle\":\"Keep this title\"}'::jsonb WHERE id=1");
    await seedInitialContent(db,admin);
    assert.deepEqual((await db.query("SELECT slug,title FROM posts")).rows,[{slug:"hello-world",title:"Deliberately edited"}]);
    assert.equal((await db.query("SELECT count(*)::int AS n FROM extensions")).rows[0].n,0); assert.equal((await getSettings(db)).privacyPageId,null); assert.equal((await getSettings(db)).siteTitle,"Keep this title");
    // Without a marker, an already-present expected slug is kept instead of
    // duplicated or overwritten by the default policy generator.
    await db.query("DELETE FROM posts; DELETE FROM seed_markers WHERE name='initial-content-v1'");
    const existing=(await db.query("INSERT INTO posts(type,title,slug,content,status,author_id) VALUES('page','Existing policy','privacy-policy','Existing reviewed content','publish',$1) RETURNING id",[admin])).rows[0];
    await seedInitialContent(db,admin);
    assert.equal((await db.query("SELECT count(*)::int AS n FROM posts WHERE slug='privacy-policy'")).rows[0].n,1);
    assert.deepEqual((await db.query("SELECT title,content,status FROM posts WHERE id=$1",[existing.id])).rows[0],{title:"Existing policy",content:"Existing reviewed content",status:"publish"});
    assert.equal((await getSettings(db)).privacyPageId,existing.id);
  } finally { await db.query("ROLLBACK"); db.release(); }
});

test("privacy guide reports the actual browser/API session lifetimes and keeps optional service disclosures", async () => {
  const guide=buildPrivacyPolicyGuide(await getSettings(),true,new Date("2026-01-01T00:00:00Z"));
  assert.equal(guide.generatedAt,"2026-01-01T00:00:00.000Z");
  const cookies=guide.sections.find(section=>section.id==="cookies")!.text.join(" ");
  assert.match(cookies,/two days/); assert.match(cookies,/fourteen days/); assert.match(cookies,/session cookie/); assert.match(cookies,/seven days/); assert.match(cookies,/347 days/);
  assert.match(guide.sections.find(section=>section.id==="comments")!.text.join(" "),/may be sent to Akismet/);
  for(const [remember,days] of [[false,2],[true,14],[undefined,7]] as const){
    const cookie=await login(remember);
    try{
      const token=cookie.slice(cookie.indexOf("=")+1),hash=createHash("sha256").update(token).digest("hex");
      const seconds=Number((await pool.query("SELECT extract(epoch FROM expires_at-now()) AS seconds FROM sessions WHERE token_hash=$1",[hash])).rows[0].seconds);
      assert.ok(Math.abs(seconds-days*86400)<10,`Expected ${days}-day session`);
    }finally{await api("/api/auth/logout","POST",{},cookie);}
  }
  const raw=privacyPolicyRawContent(buildPrivacyPolicyGuide({...await getSettings(),siteUrl:'https://safe.invalid/\"><script>bad()</script>'}));
  assert.doesNotMatch(raw,/<script>/); assert.match(raw,/&lt;script&gt;/);
});

test("default canonical content survives authenticated editing and JSON/WXR copies without publishing the policy", async () => {
  const cookie=await login(), owned:number[]=[], terms:number[]=[], stamp="fresh-copy-"+Date.now().toString(36), originalPolicyId=(await getSettings()).privacyPageId;
  try{
    const exported=await api("/api/tools/export","GET",undefined,cookie); assert.equal(exported.response.status,200);
    const originals=exported.data.posts.filter((post:any)=>["hello-world","sample-page","privacy-policy"].includes(post.slug)); assert.equal(originals.length,3);
    const comments=exported.data.comments.filter((comment:any)=>originals.some((post:any)=>post.id===comment.post_id));assert.equal(comments.length,1);assert.equal(comments[0].author_url,"/");
    const copied=await api("/api/tools/import","POST",{application:"WorldAct",version:3,posts:originals,comments,settings:{privacyPageId:originalPolicyId},replaceDesign:true},cookie);assert.equal(copied.response.status,201,JSON.stringify(copied.data));owned.push(...copied.data.postIds);
    assert.equal(copied.data.restoredDesign,true);const copiedPolicyId=copied.data.postIds[originals.findIndex((post:any)=>post.slug==="privacy-policy")];assert.equal((await getSettings()).privacyPageId,copiedPolicyId);assert.notEqual(copiedPolicyId,originalPolicyId);
    const copiedComment=(await pool.query("SELECT post_id,author_url,content FROM comments WHERE post_id=ANY($1::int[])",[owned])).rows;assert.equal(copiedComment.length,1);assert.equal(copiedComment[0].post_id,copied.data.postIds[originals.findIndex((post:any)=>post.slug==="hello-world")]);assert.equal(copiedComment[0].author_url,"/");assert.equal(copiedComment[0].content,comments[0].content.trim());
    const count=(await pool.query("SELECT count(*)::int AS n FROM posts")).rows[0].n;
    for(const author_url of ["//foreign.invalid/","/\\foreign.invalid/","javascript:bad()","data:text/html,bad","/unrecognized-relative"]){const rejected=await api("/api/tools/import","POST",{application:"WorldAct",version:3,posts:[originals[0]],comments:[{...comments[0],author_url}]},cookie);assert.equal(rejected.response.status,400);assert.equal((await pool.query("SELECT count(*)::int AS n FROM posts")).rows[0].n,count);}
    for(let index=0;index<owned.length;index++){
      const saved=await api("/api/posts/"+owned[index],"GET",undefined,cookie);assert.equal(saved.response.status,200);const post=saved.data.post, source=originals[index];
      assert.equal(post.rawContent,source.raw_content);assert.deepEqual(names(post.rawContent),names(source.raw_content));
      const edited=await api("/api/posts/"+post.id,"PUT",{title:stamp+"-"+index,version:post.version},cookie);assert.equal(edited.response.status,200);assert.equal(edited.data.post.rawContent,post.rawContent);assert.equal(edited.data.post.status,source.status);
      if(source.slug==="privacy-policy")assert.equal((await api("/api/public/posts/"+post.slug)).response.status,404);
    }
    const wxr=await fetch(base+"/api/tools/export?format=wxr",{headers:{Cookie:cookie,Origin:origin}});assert.equal(wxr.status,200);
    const xml=await wxr.text();const imported=await api("/api/tools/import","POST",{format:"wxr",xml},cookie);assert.equal(imported.response.status,201,JSON.stringify(imported.data));owned.push(...imported.data.postIds);terms.push(...imported.data.termIds);
    const policies=(await pool.query("SELECT slug,status,raw_content FROM posts WHERE id=ANY($1::int[]) AND title='Privacy Policy'",[imported.data.postIds])).rows;
    assert.equal(policies.length,1);assert.equal(policies[0].status,"draft");assert.deepEqual(names(policies[0].raw_content),names(originals.find((post:any)=>post.slug==="privacy-policy").raw_content));assert.equal((await api("/api/public/posts/"+policies[0].slug)).response.status,404);
  }finally{
    await api("/api/settings","PUT",{privacyPageId:originalPolicyId},cookie);
    for(const id of owned){await api("/api/posts/"+id,"PUT",{status:"trash"},cookie);await api("/api/posts/"+id,"DELETE",undefined,cookie);}
    for(const id of terms)await api("/api/terms/"+id,"DELETE",undefined,cookie);
    await api("/api/auth/logout","POST",{},cookie);
  }
});
