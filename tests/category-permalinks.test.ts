import test, { after } from "./isolated-test.js";
import assert from "node:assert/strict";
import { pool, getSettings } from "../server/db.js";
import { categoryPermalinkPath, postPermalink, resolvePublicPath } from "../server/permalinks.js";
import { createIncomingPings, IncomingPingError } from "../server/incoming-pings.js";
import { renderSiteDocument } from "../server/block-renderer.js";

const base=process.env.TEST_API_URL!,origin=process.env.APP_ORIGIN!;
after(async()=>{await pool.end();});

test("category canonical links share lowest-ID hierarchy across metadata, resolution, rendering and notification rechecks",async t=>{
  const initial=(await pool.query("SELECT data FROM settings WHERE id=1")).rows[0].data;
  const posts:number[]=[],terms:number[]=[],stamp="category-link-"+Date.now();
  const login=await fetch(base+"/api/auth/login",{method:"POST",headers:{Origin:origin,"Content-Type":"application/json"},body:JSON.stringify({login:process.env.ADMIN_EMAIL,password:process.env.ADMIN_PASSWORD})});
  assert.equal(login.status,200);const cookie=login.headers.get("set-cookie")!.split(";")[0];
  async function api(path:string,method="GET",body?:unknown){const r=await fetch(base+path,{method,headers:{Origin:origin,Cookie:cookie,"Content-Type":"application/json"},body:body===undefined?undefined:JSON.stringify(body)});const data=await r.json();assert.ok(r.ok,`${path}: ${r.status}`);return data;}
  async function term(label:string,parentId?:number){const row=(await api("/api/terms","POST",{taxonomy:"category",name:label,slug:stamp+"-"+terms.length,...(parentId?{parentId}:{})})).term;terms.push(row.id);return row;}
  try{
    await api("/api/settings","PUT",{permalinkStructure:"/%category%/%postname%/",closeCommentsDays:0,commentModeration:false,commentPreviouslyApproved:false});
    const root=await term("ZZZ root"),parent=await term("ZZZ parent",root.id),child=await term("ZZZ selected first",parent.id),later=await term("AAA later category");
    const post=(await api("/api/posts","POST",{title:stamp,status:"publish",pingStatus:"open",content:"<p>First</p><!--nextpage--><p>Second</p>",categoryIds:[later.id,child.id]})).post;posts.push(post.id);
    let expected=`/${root.slug}/${parent.slug}/${child.slug}/${post.slug}/`;
    await t.test("lowest category ID wins independently of supplied DTO/name order and includes every ancestor",async()=>{
      assert.equal(post.permalink,expected);
      assert.equal(await postPermalink({...post,categories:[later],terms:[later]}),expected);
      const site=await api("/api/public/site");assert.equal(site.posts.find((p:any)=>p.id===post.id).permalink,expected);
      assert.equal((await resolvePublicPath(expected))?.id,post.id);
      assert.equal((await resolvePublicPath(expected+"2/"))?.contentPage,2);
      for(const bad of [`/${child.slug}/${post.slug}/`,`/${later.slug}/${post.slug}/`,`/${root.slug}/${parent.slug}/foreign/${post.slug}/`])assert.equal(await resolvePublicPath(bad),null);
      const document=await renderSiteDocument({rawContent:`<!-- wp:navigation-link ${JSON.stringify({id:post.id,kind:"post-type",type:"post",label:"Canonical link"})} /-->`});
      assert.ok(document.includes(`href="${expected}"`));
      const sitemap=await(await fetch(base+"/sitemap.xml")).text(),feed=await(await fetch(base+"/feed/")).text();
      assert.ok(sitemap.includes(expected));assert.ok(feed.includes(expected));
      const malformed=await fetch(base+"/api/public/resolve?"+new URLSearchParams({path:"/%E0%A4%A/"}));
      assert.equal(malformed.status,400);assert.match((await malformed.json()).error,/malformed/);
    });
    await t.test("an ancestor rename is one coherent snapshot and invalidates a verified stale incoming target",async()=>{
      let release!:()=>void,started!:()=>void;const entered=new Promise<void>(resolve=>started=resolve),held=new Promise<void>(resolve=>release=resolve);
      const target=new URL(expected,(await getSettings()).siteUrl).href;
      const receive=createIncomingPings({environment:()=>"production",http:async url=>{started();await held;return {url,status:200,headers:{},body:Buffer.from(`<title>Source</title><a href="${target}">Actual backlink</a>`)};}});
      const receiving=receive({type:"pingback",source:"https://category-source.example.test/old",target,ip:"1.1.1.1"});
      const outcome=assert.rejects(receiving,(e:unknown)=>e instanceof IncomingPingError&&e.code===33);
      await entered;
      try{await api("/api/terms/"+root.id,"PUT",{slug:stamp+"-renamed"});}finally{release();}
      await outcome;
      assert.equal((await pool.query("SELECT count(*)::int AS n FROM comments WHERE post_id=$1",[post.id])).rows[0].n,0);
      assert.equal(await resolvePublicPath(expected),null);
      root.slug=stamp+"-renamed";expected=`/${root.slug}/${parent.slug}/${child.slug}/${post.slug}/`;
      assert.equal(await postPermalink(post),expected);assert.equal((await resolvePublicPath(expected))?.id,post.id);
      const client=await pool.connect();
      try{await client.query("BEGIN");await client.query("UPDATE terms SET slug=$1 WHERE id=$2",[stamp+"-uncommitted",parent.id]);assert.equal(await postPermalink(post),expected);await client.query("COMMIT");assert.equal(await postPermalink(post),expected.replace(parent.slug,stamp+"-uncommitted"));parent.slug=stamp+"-uncommitted";expected=await postPermalink(post);}finally{await client.query("ROLLBACK");client.release();}
    });
    await t.test("current default category supplies an unassigned post fallback without adopting its parents",async()=>{
      await api("/api/settings","PUT",{defaultCategoryId:child.id});
      const unassigned=(await pool.query("INSERT INTO posts(type,title,slug,status,author_id,post_date,post_date_gmt) VALUES('post',$1,$1,'draft',$2,to_char(CASE WHEN coalesce((SELECT data->>'timezone' FROM settings WHERE id=1),'America/Los_Angeles')~'^[+-]' THEN timezone(coalesce((SELECT data->>'timezone' FROM settings WHERE id=1),'America/Los_Angeles')::interval,coalesce(CASE WHEN 'draft'='future' THEN NULL::timestamptz END,NULL::timestamptz,NULL::timestamptz,now())) ELSE timezone(coalesce((SELECT data->>'timezone' FROM settings WHERE id=1),'America/Los_Angeles'),coalesce(CASE WHEN 'draft'='future' THEN NULL::timestamptz END,NULL::timestamptz,NULL::timestamptz,now())) END,'YYYY-MM-DD\"T\"HH24:MI:SS'),NULL) RETURNING id,type,slug",[stamp+"-unassigned",post.authorId])).rows[0];posts.push(unassigned.id);
      assert.equal(await postPermalink(unassigned),`/${child.slug}/${unassigned.slug}/`);
    });
    await t.test("valid hierarchies deeper than thirty categories keep every accepted ancestor",async()=>{
      const chain=[await term("Deep root")];
      for(let depth=1;depth<35;depth++)chain.push(await term("Deep "+depth,chain.at(-1)!.id));
      const deep=(await api("/api/posts","POST",{title:stamp+" deep",status:"publish",categoryIds:[chain.at(-1)!.id]})).post;posts.push(deep.id);
      const canonical="/"+chain.map(row=>row.slug).join("/")+"/"+deep.slug+"/";
      assert.equal(deep.permalink,canonical);assert.equal((await resolvePublicPath(canonical))?.id,deep.id);
    });
    await t.test("malformed historical category cycles are finite and never duplicate an ancestor",async()=>{
      const client=await pool.connect();
      try{await client.query("BEGIN");await client.query("UPDATE terms SET parent_id=$1 WHERE id=$2",[child.id,root.id]);const path=await categoryPermalinkPath(post.id,await getSettings(client),client);assert.equal(path,`${root.slug}/${parent.slug}/${child.slug}`);assert.equal(path.split("/").length,3);}finally{await client.query("ROLLBACK");client.release();}
      await api("/api/terms/"+parent.id,"DELETE");
      assert.equal(await postPermalink(post),`/${root.slug}/${child.slug}/${post.slug}/`);
    });
    await t.test("fresh-ID WXR categories retain the canonical parent chain",async()=>{
      const prefix=stamp+"-wxr",xml=`<rss xmlns:wp="http://wordpress.org/export/1.2/" xmlns:content="http://purl.org/rss/1.0/modules/content/"><channel><wp:wxr_version>1.2</wp:wxr_version><wp:category><wp:term_id>910001</wp:term_id><wp:category_nicename>${prefix}-parent</wp:category_nicename><wp:cat_name>Imported parent</wp:cat_name></wp:category><wp:category><wp:term_id>910002</wp:term_id><wp:category_nicename>${prefix}-child</wp:category_nicename><wp:category_parent>${prefix}-parent</wp:category_parent><wp:cat_name>Imported child</wp:cat_name></wp:category><item><title>${prefix}</title><wp:post_id>910003</wp:post_id><wp:post_type>post</wp:post_type><wp:post_name>${prefix}</wp:post_name><wp:status>draft</wp:status><content:encoded>Imported body</content:encoded><category domain="category" nicename="${prefix}-child">Child</category></item></channel></rss>`;
      const imported=await api("/api/tools/import","POST",{format:"wxr",xml});posts.push(...imported.postIds);
      const importedTerms=(await pool.query("SELECT id FROM terms WHERE slug=ANY($1::text[])",[[prefix+"-parent",prefix+"-child"]])).rows;terms.push(...importedTerms.map(row=>row.id));assert.equal(importedTerms.length,2);assert.ok(importedTerms.every(row=>![910001,910002].includes(row.id)));
      const copy=(await api("/api/posts/"+imported.postIds[0])).post;
      assert.equal(copy.permalink,`/${prefix}-parent/${prefix}-child/${prefix}/`);
    });
  }finally{
    await pool.query("DELETE FROM posts WHERE id=ANY($1::int[])",[posts]);
    await pool.query("UPDATE settings SET data=$1::jsonb WHERE id=1",[JSON.stringify(initial)]);
    await pool.query("DELETE FROM terms WHERE id=ANY($1::int[])",[terms]);
  }
});
