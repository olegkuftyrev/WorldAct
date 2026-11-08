import "dotenv/config";
import assert from "node:assert/strict";
import test, {after} from "node:test";
import {DOMParser} from "linkedom";
import {XMLParser} from "fast-xml-parser";
import {pool,defaultSettings,getPost} from "../server/db.js";
import {cleanRawContent,cleanContent,HttpError} from "../server/utils.js";
import {renderPublicContent,renderSiteDocument,type SerializedNode} from "../server/block-renderer.js";
import {canonicalLegacyMarker,legacyPageCount,selectLegacyContent,legacyExcerptSource,contentPageURL,parseContentPage} from "../server/legacy-content.js";
after(async()=>{await pool.end();});
const block=(name:string,attrs:Record<string,unknown>={},html="")=>`<!-- wp:${name} ${JSON.stringify(attrs)}${html?" -->"+html+`<!-- /wp:${name} -->`:" /-->"}`;
const paragraph=(value:string)=>block("paragraph",{},`<p>${value}</p>`);
const more=(label="",noTeaser=false)=>block("more",{customText:label,noTeaser},`<!--more${label?" "+label:""}-->${noTeaser?"<!--noteaser-->":""}`);
const next=block("nextpage",{},"<!--nextpage-->");
const raw=paragraph("First teaser")+more("Continue the story")+paragraph("First remainder")+next+paragraph("Second page");
const post=(rawContent=raw)=>({id:31,type:"post",status:"publish",title:"Story",slug:"story",rawContent:cleanRawContent(rawContent),content:cleanContent(rawContent),blocks:null,publishedAt:"2026-11-07T12:00:00Z"});
const db={query:async(sql:string)=>{assert.match(sql,/FROM settings/);return {rows:[{data:defaultSettings}]};}} as any;
const dom=(html:string)=>new DOMParser().parseFromString("<!doctype html><html><body>"+html+"</body></html>","text/html");

test("canonical and legacy separators survive saves without retaining arbitrary comments or attribute injection",()=>{
  const cleaned=cleanRawContent(raw);assert.match(cleaned,/<!--more Continue the story-->/);assert.match(cleaned,/<!--nextpage-->/);assert.match(cleanRawContent(more("",true)),/<!--noteaser-->/);
  assert.equal(cleanRawContent('<p>A</p><!--ordinary secret--><!--nextpage--><p>B</p>'),'<p>A</p><!--nextpage--><p>B</p>');
  assert.doesNotMatch(cleanRawContent('<p title="<!--nextpage-->">Text</p><script><!--more--></script><!--more bad--label-->'),/<!--|WORLDActBLOCK/);
  const attribute=block("paragraph",{content:"literal <!--more--> inside an attribute"},"<p>Actual text</p>");assert.doesNotMatch(cleanRawContent(attribute),/WORLDActBLOCK/);assert.match(cleanRawContent(attribute),/literal/);
  assert.equal(canonicalLegacyMarker("<!--more Continue &amp; learn-->"),"<!--more Continue & learn-->");assert.equal(canonicalLegacyMarker("<!--more bad--label-->"),null);
  assert.throws(()=>cleanRawContent("<!--nextpage-->".repeat(4001)),(error:unknown)=>error instanceof HttpError&&error.status===400);
  assert.doesNotMatch(cleanContent(cleaned),/<!--/);
});

test("singular, archive, complete and feed modes use source More and page-selection semantics",async()=>{
  const singular=await renderPublicContent(post(),{db});assert.match(singular,/First teaser|First remainder/);assert.doesNotMatch(singular,/Second page/);assert.ok(dom(singular).getElementById("more-31"));assert.match(singular,/href="[^\"]*\/story\/2\/"/);
  const second=await renderPublicContent(post(),{db,contentPage:2});assert.match(second,/Second page/);assert.doesNotMatch(second,/First teaser|First remainder/);assert.equal(dom(second).querySelector('[aria-current="page"]')!.textContent,"2");
  const archive=await renderPublicContent(post(),{db,contentMode:"archive"});assert.match(archive,/First teaser/);assert.doesNotMatch(archive,/First remainder|Second page/);assert.equal(dom(archive).querySelector("a.more-link")!.textContent,"Continue the story");assert.match(dom(archive).querySelector("a.more-link")!.getAttribute("href")!,/\/story\/#more-31$/);assert.equal(dom(archive).querySelector('[aria-current="page"]'),null);
  const complete=await renderPublicContent(post(),{db,contentMode:"complete"});assert.match(complete,/First teaser/);assert.match(complete,/First remainder/);assert.match(complete,/Second page/);assert.doesNotMatch(complete,/more-link|post-nav-links|<!--/);
  const feed=await renderPublicContent(post(),{db,contentMode:"feed"});assert.match(feed,/First teaser/);assert.match(feed,/First remainder/);assert.doesNotMatch(feed,/Second page|post-nav-links|more-link/);
  const hidden=await renderPublicContent(post(paragraph("Hidden teaser")+more("",true)+paragraph("Visible remainder")),{db});assert.doesNotMatch(hidden,/Hidden teaser/);assert.match(hidden,/Visible remainder/);assert.ok(dom(hidden).getElementById("more-31"));
  const laterNoteaser=post(paragraph("First scoped teaser")+more()+paragraph("First scoped remainder")+next+paragraph("Second scoped teaser")+more("",true)+paragraph("Second scoped remainder"));
  const firstWithLaterMarker=await renderPublicContent(laterNoteaser,{db});assert.doesNotMatch(firstWithLaterMarker,/First scoped teaser/);assert.match(firstWithLaterMarker,/First scoped remainder/);
  const secondWithLaterMarker=await renderPublicContent(laterNoteaser,{db,contentPage:2});assert.match(secondWithLaterMarker,/Second scoped teaser/);assert.match(secondWithLaterMarker,/Second scoped remainder/);assert.doesNotMatch(secondWithLaterMarker,/First scoped/);
  const defaultLabel=dom(await renderPublicContent(post(paragraph("Teaser")+more()+paragraph("Remainder")),{db,contentMode:"archive"}));assert.equal(defaultLabel.querySelector("a.more-link span")!.getAttribute("aria-label"),"Continue reading Story");
});

test("legacy raw comments and native JSON separators have equivalent page/teaser behavior",async()=>{
  const legacy=post('<p>Legacy teaser</p><!--more Read it--><!--noteaser--><p>Legacy rest</p>\n<!--nextpage-->\n<p>Legacy second</p>');
  assert.equal(legacyPageCount(legacy),2);assert.doesNotMatch(await renderPublicContent(legacy,{db}),/Legacy teaser|Legacy second/);assert.match(await renderPublicContent(legacy,{db,contentPage:2}),/Legacy second/);
  const withOldStructuralJSON={...legacy,blocks:[{name:"core/paragraph",attributes:{content:"Stale structural content"},innerBlocks:[]}]};assert.match(await renderPublicContent(withOldStructuralJSON,{db,contentPage:2}),/Legacy second/);assert.doesNotMatch(await renderPublicContent(withOldStructuralJSON,{db}),/Stale structural content/);
  assert.equal(legacyPageCount({rawContent:"\n<!--nextpage-->\n<p>First</p><!--nextpage--><p>Second</p>"}),2);
  const json=(name:string,attributes:Record<string,unknown>={},innerBlocks:SerializedNode[]=[]):SerializedNode=>({name:"core/"+name,attributes,innerBlocks});
  const value={...post(""),blocks:[json("group",{className:"kept-group"},[json("paragraph",{content:"JSON teaser"}),json("more",{customText:"JSON continue"}),json("paragraph",{content:"JSON rest"}),json("nextpage"),json("paragraph",{content:"JSON second"})])]};
  const archive=await renderPublicContent(value,{db,contentMode:"archive"});assert.match(archive,/JSON teaser|JSON continue/);assert.doesNotMatch(archive,/JSON rest|JSON second/);assert.ok(dom(archive).querySelector(".kept-group"));
  const second=await renderPublicContent(value,{db,contentPage:2});assert.match(second,/JSON second/);assert.doesNotMatch(second,/JSON teaser|JSON rest/);assert.ok(dom(second).querySelector(".kept-group"));
  assert.match(legacyExcerptSource(value),/JSON teaser/);assert.doesNotMatch(legacyExcerptSource(value),/JSON rest|JSON second/);
});

test("page parsing, URLs, clamping and nested canonical wrappers remain bounded and safe",async()=>{
  for(const value of ["0","-1","2.5","no",["2"],{},"2147483648"])assert.throws(()=>parseContentPage(value));assert.equal(parseContentPage(undefined),1);assert.equal(parseContentPage("2"),2);
  assert.equal(contentPageURL(post(),"/story/",2),"/story/2/");assert.equal(contentPageURL(post(),"/",2),"/page/2/");assert.equal(contentPageURL(post(),"/?p=31",2),"/?p=31&page=2");assert.equal(contentPageURL({...post(),status:"draft"},"/story/",2),"/preview/31?page=2");
  const selected=selectLegacyContent(post(),post(),"/story/","singular",999);assert.equal(selected.pagination.page,2);assert.match(selected.document.rawContent!,/Second page/);
  const nested=post(block("group",{},'<section class="nested-source">'+raw+'</section>'));
  const first=await renderPublicContent(nested,{db,contentMode:"archive"}),second=await renderPublicContent(nested,{db,contentPage:2});assert.match(first,/First teaser/);assert.doesNotMatch(first,/First remainder|Second page/);assert.match(second,/Second page/);assert.doesNotMatch(second,/First teaser|First remainder/);
  const code=await renderPublicContent(post('<pre>&lt;!--nextpage--&gt;</pre><p>[php]never execute[/php]</p>'),{db});assert.match(code,/&lt;!--nextpage--&gt;/);assert.match(code,/\[php\]never execute/);
});

test("template Post Content respects main content-page selection and archive query context",async()=>{
  const template={rawContent:block("post-content")};
  const second=await renderSiteDocument(template,{db,post:post(),contentPage:2});assert.match(second,/Second page/);assert.doesNotMatch(second,/First teaser|First remainder/);
  const archive=await renderSiteDocument(template,{db,post:post(),contentMode:"archive"});assert.match(archive,/First teaser/);assert.doesNotMatch(archive,/First remainder|Second page/);
  const protectedPage=await renderSiteDocument(template,{db,post:{...post(),locked:true},contentPage:2});assert.doesNotMatch(protectedPage,/First teaser|First remainder|Second page|post-nav-links/);assert.match(protectedPage,/password protected/);
});

test("post page links and More markup share the cumulative output budget",async()=>{
  let calls=0;
  const bounded={query:async(sql:string)=>{calls++;return {rows:sql.includes("FROM settings")?[{data:defaultSettings}]:[{rawContent:paragraph("x".repeat(285000))}]};}} as any;
  const content=block("block",{ref:7}).repeat(29)+"<!--nextpage-->".repeat(3500);
  await assert.rejects(()=>renderPublicContent(post(content),{db:bounded}),(error:unknown)=>error instanceof HttpError&&error.status===413);assert.equal(calls,2);
});

test("public APIs preserve pagination and excerpts across save/history/restore/import without exposing protected structure",async t=>{
  const base=process.env.TEST_API_URL||"http://127.0.0.1:3001",origin=process.env.APP_ORIGIN||"http://127.0.0.1:5173";let cookie="";const ids:number[]=[],termIds:number[]=[],documentIds:number[]=[];
  const api=async(path:string,method="GET",body?:unknown,auth=cookie)=>{const response=await fetch(base+path,{method,headers:{Origin:origin,"Content-Type":"application/json",...(auth?{Cookie:auth}:{})},...(body===undefined?{}:{body:JSON.stringify(body)})});return {response,data:await response.json()};};
  try{
    const login=await api("/api/auth/login","POST",{login:process.env.ADMIN_EMAIL,password:process.env.ADMIN_PASSWORD},"");assert.equal(login.response.status,200);cookie=login.response.headers.get("set-cookie")!.split(";")[0];
    const stamp="legacy-"+Date.now().toString(36),created=await api("/api/posts","POST",{title:stamp,content:raw,status:"publish"});assert.equal(created.response.status,201,JSON.stringify(created.data));const p=created.data.post;ids.push(p.id);
    const template=await api("/api/site-editor/documents","POST",{title:stamp,slug:stamp,type:"template",content:block("post-content")});assert.equal(template.response.status,201,JSON.stringify(template.data));documentIds.push(template.data.document.id);
    const renderedTemplate=(postId:number,requestPath:string,extra="")=>api("/api/public/templates/"+template.data.document.slug+"?postId="+postId+"&requestPath="+encodeURIComponent(requestPath)+extra,"GET",undefined,"");
    await t.test("single/resolve/archive/REST routes use their respective content modes",async()=>{
      const first=await api("/api/public/posts/"+p.slug,"GET",undefined,"");assert.equal(first.response.status,200);assert.equal(first.data.post.contentPagination.totalPages,2);assert.doesNotMatch(first.data.post.content,/Second page/);assert.equal(first.data.post.rawContent,undefined);
      const second=await api("/api/public/posts/"+p.slug+"?page=2","GET",undefined,"");assert.match(second.data.post.content,/Second page/);assert.doesNotMatch(second.data.post.content,/First teaser|First remainder/);assert.equal(second.data.post.contentPagination.page,2);
      const resolved=await api("/api/public/resolve?path="+encodeURIComponent(p.permalink+"2/"),"GET",undefined,"");assert.equal(resolved.response.status,200);assert.equal(resolved.data.contentPage,2);assert.match(resolved.data.post.content,/Second page/);
      const sourceTemplate=await renderedTemplate(p.id,p.permalink+"2/");assert.equal(sourceTemplate.response.status,200,JSON.stringify(sourceTemplate.data));assert.match(sourceTemplate.data.content,/Second page/);assert.doesNotMatch(sourceTemplate.data.content,/First teaser|First remainder/);
      const explicitFirst=await renderedTemplate(p.id,p.permalink+"2/","&contentPage=1");assert.match(explicitFirst.data.content,/First teaser/);assert.doesNotMatch(explicitFirst.data.content,/Second page/);
      const archive=await api("/api/public/site?search="+stamp,"GET",undefined,"");assert.match(archive.data.posts[0].content,/First teaser/);assert.doesNotMatch(archive.data.posts[0].content,/First remainder|Second page/);
      const rest=await api("/wp-json/wp/v2/posts/"+p.id,"GET",undefined,"");assert.match(rest.data.content.rendered,/First remainder/);assert.match(rest.data.content.rendered,/Second page/);assert.doesNotMatch(rest.data.excerpt.rendered,/First remainder|Second page/);
      assert.equal((await api("/api/public/posts/"+p.slug+"?page[]=2","GET",undefined,"")).response.status,400);
    });
    await t.test("RSS and Atom expose the first full content page without singular page navigation",async()=>{
      for(const path of ["/feed/","/feed/atom/"]){
        const response=await fetch(base+path);assert.equal(response.status,200);
        const parsed=new XMLParser({parseTagValue:false}).parse(await response.text());
        const values=parsed.rss?parsed.rss.channel.item:parsed.feed.entry,items=Array.isArray(values)?values:[values];
        const item=items.find((item:any)=>parsed.rss?item.guid==="worldact:"+p.id:item.id==="urn:worldact:post:"+p.id);assert.ok(item);
        const body=parsed.rss?item["content:encoded"]:item.content;
        assert.match(body,/First teaser/);assert.match(body,/First remainder/);assert.doesNotMatch(body,/Second page|post-nav-links|post-page-numbers/);
      }
    });
    await t.test("stored HTML survives incomplete structural JSON in excerpts, widgets and REST",async()=>{
      const content="<p>Visible stored paragraph.</p>",blocks=[{name:"core/paragraph",attributes:{},innerBlocks:[]}];
      assert.equal(legacyExcerptSource({rawContent:content,content,blocks}),content);
      const dynamicSnapshot={rawContent:"<h2>Old title snapshot</h2>",blocks:[{name:"core/post-title",attributes:{},innerBlocks:[]}]};
      const dynamic=await renderPublicContent({...post(),...dynamicSnapshot,title:"Current live title"},{db});
      assert.match(dynamic,/Current live title/);assert.doesNotMatch(dynamic,/Old title snapshot/);
      const created=await api("/api/posts","POST",{title:stamp+" structural",status:"publish",content,blocks});assert.equal(created.response.status,201);const legacy=created.data.post;ids.push(legacy.id);
      const excerpt=await api("/wp-json/wp/v2/block-renderer/core/post-excerpt?post_id="+legacy.id);assert.match(excerpt.data.rendered,/Visible stored paragraph/);
      const rest=await api("/wp-json/wp/v2/posts/"+legacy.id,"GET",undefined,"");assert.match(rest.data.excerpt.rendered,/Visible stored paragraph/);assert.match(rest.data.content.rendered,/Visible stored paragraph/);
      const attributes=encodeURIComponent(JSON.stringify({postsToShow:100,displayPostContent:true,displayPostContentRadio:"full_post"}));
      const widget=await api("/wp-json/wp/v2/block-renderer/core/latest-posts?attributes="+attributes);assert.match(widget.data.rendered,/Visible stored paragraph/);
    });
    await t.test("raw separators persist through revisions, autosave recovery and JSON/WXR export/import",async()=>{
      const edit=(await api("/api/posts/"+p.id)).data.post;assert.match(edit.rawContent,/<!--more Continue the story-->/);assert.match(edit.rawContent,/<!--nextpage-->/);
      const saved=await api("/api/posts/"+p.id,"PUT",{title:stamp+" edited",version:edit.version});assert.equal(saved.response.status,200);
      const autosave=await api("/api/posts/"+p.id+"/autosave","PUT",{content:raw,title:stamp,version:saved.data.post.version});assert.equal(autosave.response.status,200,JSON.stringify(autosave.data));
      const history=await api("/api/posts/"+p.id+"/revisions");assert.ok(history.data.revisions.length);const revision=history.data.revisions[0];assert.match(revision.rawContent,/<!--nextpage-->/);
      const recovered=await api("/api/posts/"+p.id+"/autosave");assert.match(recovered.data.autosave.rawContent,/<!--nextpage-->/);
      const restore=await api("/api/posts/"+p.id+"/revisions/"+revision.id+"/restore","POST",{version:saved.data.post.version});assert.equal(restore.response.status,200,JSON.stringify(restore.data));assert.match(restore.data.post.rawContent,/<!--nextpage-->/);
      const exported=await api("/api/tools/export");const item=exported.data.posts.find((row:any)=>row.id===p.id);assert.match(item.raw_content,/<!--nextpage-->/);
      const imported=await api("/api/tools/import","POST",{application:"WorldAct",version:3,posts:[item],terms:exported.data.terms});assert.equal(imported.response.status,201,JSON.stringify(imported.data));ids.push(...imported.data.postIds);termIds.push(...imported.data.termIds);const copy=await getPost(imported.data.postIds[0]);assert.match(copy.rawContent,/<!--nextpage-->/);
      const wxr=await fetch(base+"/api/tools/export?format=wxr",{headers:{Cookie:cookie}});assert.equal(wxr.status,200);assert.match(await wxr.text(),/<!--nextpage-->/);
      const xml=`<rss xmlns:wp="http://wordpress.org/export/1.2/" xmlns:content="http://purl.org/rss/1.0/modules/content/"><channel><wp:wxr_version>1.2</wp:wxr_version><item><title>${stamp}-wxr</title><wp:post_id>999999</wp:post_id><wp:post_type>post</wp:post_type><wp:post_name>${stamp}-wxr</wp:post_name><wp:status>draft</wp:status><content:encoded><![CDATA[${raw}]]></content:encoded></item></channel></rss>`;
      const fromWXR=await api("/api/tools/import","POST",{format:"wxr",xml});assert.equal(fromWXR.response.status,201,JSON.stringify(fromWXR.data));ids.push(...fromWXR.data.postIds);assert.match((await getPost(fromWXR.data.postIds[0])).rawContent,/<!--more Continue the story-->/);assert.match((await getPost(fromWXR.data.postIds[0])).rawContent,/<!--nextpage-->/);
    });
    await t.test("exact numeric child pages win over fallback; private page metadata stays redacted",async()=>{
      const parent=await api("/api/posts","POST",{type:"page",title:stamp+" parent",status:"publish",content:raw});ids.push(parent.data.post.id);
      const child=await api("/api/posts","POST",{type:"page",title:"Numeric child",slug:"2",parentId:parent.data.post.id,status:"publish",content:paragraph("Actual numeric child")});assert.equal(child.response.status,201);ids.push(child.data.post.id);
      const resolved=await api("/api/public/resolve?path="+encodeURIComponent(child.data.post.permalink),"GET",undefined,"");assert.equal(resolved.data.post.id,child.data.post.id);assert.match(resolved.data.post.content,/Actual numeric child/);
      const exactChild=await renderedTemplate(parent.data.post.id,child.data.post.permalink);assert.equal(exactChild.response.status,200);assert.match(exactChild.data.content,/First teaser/);assert.doesNotMatch(exactChild.data.content,/Second page/);
      const previous=(await pool.query("SELECT data FROM settings WHERE id=1")).rows[0].data;
      try{await pool.query("UPDATE settings SET data=data || $1::jsonb WHERE id=1",[JSON.stringify({frontPageMode:"page",frontPageId:parent.data.post.id})]);const front=await api("/api/public/resolve?path=%2Fpage%2F2%2F","GET",undefined,"");assert.equal(front.response.status,200);assert.equal(front.data.post.id,parent.data.post.id);assert.match(front.data.post.content,/Second page/);assert.equal(front.data.post.contentPagination.links[1].url,"/page/2/");const frontTemplate=await renderedTemplate(parent.data.post.id,"/page/2/");assert.equal(frontTemplate.response.status,200);assert.match(frontTemplate.data.content,/Second page/);assert.doesNotMatch(frontTemplate.data.content,/First teaser|First remainder/);}finally{await pool.query("UPDATE settings SET data=$1::jsonb WHERE id=1",[JSON.stringify(previous)]);}
      const locked=await api("/api/posts","POST",{title:stamp+" protected",status:"publish",content:raw,password:"Private-page-pass"});ids.push(locked.data.post.id);
      const response=await api("/api/public/posts/"+locked.data.post.slug+"?page=2","GET",undefined,"");assert.equal(response.data.post.locked,true);assert.equal(response.data.post.contentPagination,undefined);assert.equal(response.data.post.content,"");
      const preview=await api("/api/posts/"+p.id+"/preview?page=2");assert.match(preview.data.post.content,/Second page/);assert.equal(preview.data.post.contentPagination.links[1].url,"/preview/"+p.id+"?page=2");
    });
  }finally{for(const id of documentIds)await api("/api/site-editor/documents/"+id,"DELETE");for(const id of ids.reverse()){await api("/api/posts/"+id,"PUT",{status:"trash"});await api("/api/posts/"+id,"DELETE");}if(termIds.length)await pool.query("DELETE FROM terms WHERE id=ANY($1::int[])",[termIds]);if(cookie)await api("/api/auth/logout","POST",{});}
});
