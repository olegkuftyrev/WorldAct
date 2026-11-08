import test, { after } from "./isolated-test.js";
import assert from "node:assert/strict";
import { DOMParser } from "linkedom";
import { pool, getSettings } from "../server/db.js";
import { postPermalink, resolvePublicPath } from "../server/permalinks.js";
import { readPlainPermalinkQuery } from "../shared/plain-permalink-query.js";
import { createIncomingPings, IncomingPingError } from "../server/incoming-pings.js";
import { createOutgoingPingWorker, enqueuePublicationPings } from "../server/outgoing-pings.js";
import { remapImportedBlockReferences, remapImportedURL } from "../server/block-portability.js";
import type { ImportedBodyPages } from "../server/block-portability.js";
const base=process.env.TEST_API_URL!,origin=process.env.APP_ORIGIN!;
after(async()=>{await pool.end();});

test("known imported body-page URLs retain identity, boundaries, counters and one-pass mapping", async t => {
  const metadata = (target:string,permalinkStructure="/%postname%/",totalPages=3):ImportedBodyPages => ({target,totalPages,targetPost:{id:90,status:"publish"},permalinkStructure});
  const mappings = [
    ["/parent/","/copy-parent/"], ["/parent/2/","/?page_id=80"],
    ["/story/","/copy-story/"], ["https://source.example.test/story/","https://destination.example.test/copy-story/"],
    ["/category/topic/","/destination-category/topic/"], ["/uploads/source.png","/uploads/copy.png"],
    ["/fonts/source.woff2","/fonts/copy.woff2"], ["/copy-story/2/","/must-not-cascade/"],
  ] as const;
  const bodyPages = new Map([
    ["/parent/",metadata("/copy-parent/")], ["/story/",metadata("/copy-story/")],
    ["https://source.example.test/story/",metadata("https://destination.example.test/copy-story/")],
  ]);
  const remap = (url:string) => remapImportedURL(url,mappings,bodyPages);
  await t.test("complete numeric child identity wins across the entire unsorted map", () => {
    assert.equal(remap("/parent/2/"),"/?page_id=80");
    assert.equal(remap("/parent/2/?query-4-page=3#child"),"/?page_id=80&query-4-page=3#child");
    const aliasMaps = [["/parent/","/copy-parent/"],["/parent/2","/?page_id=81"]] as const;
    assert.equal(remapImportedURL("/parent/2/",aliasMaps,bodyPages),"/parent/2/","An alternate child slash must not become parent body 2.");
  });
  await t.test("a valid known page preserves query/hash, canonical destination style and source origin", () => {
    assert.equal(remap("/story/2/?query-4-page=3&commentPage=2#keep"),"/copy-story/2/?query-4-page=3&commentPage=2#keep");
    assert.equal(remap("/story/3#keep"),"/copy-story/3/#keep");
    assert.equal(remap("https://source.example.test/story/2/?x=1#keep"),"https://destination.example.test/copy-story/2/?x=1#keep");
    assert.equal(remapImportedURL("/story/2/?x=1#keep",[["/story/","/destination/90"]],new Map([["/story/",metadata("/destination/90","/destination/%post_id%")]])),"/destination/90/2?x=1#keep");
  });
  await t.test("Plain destinations keep the body counter and join independent queries without two question marks", () => {
    const plain = new Map([["/story/",metadata("/?p=90","")]]), map = [["/story/","/?p=90"]] as const;
    assert.equal(remapImportedURL("/story/2/?query-4-page=3&commentPage=2#keep",map,plain),"/?p=90&page=2&query-4-page=3&commentPage=2#keep");
    assert.equal(remapImportedURL("/story/2/#keep",map,plain),"/?p=90&page=2#keep");
    for(const query of ["page=3","page[]=3","p=91","page_id=91","%70=91","x=1&amp;page=3"]){
      const source="/story/2/?"+query+"#keep";assert.equal(remapImportedURL(source,map,plain),source,query);
    }
    assert.equal(remapImportedURL("/?p=12&page=2#keep",[["/?p=1","/?p=2"],["/?p=12","/?p=1"]]),"/?p=1&page=2#keep");
    assert.equal(remapImportedURL("/?p=123&page=2",[["/?p=12","/?p=1"]]),"/?p=123&page=2");
  });
  await t.test("invalid or unexported body-page identities are never inferred from a path prefix", () => {
    for(const suffix of ["0/","1/","02/","+2/","-2/","2.0/","2147483648/","4/","2/extra/","2//","%32/","2%2F","2&x=1"]){
      const source="/story/"+suffix;assert.equal(remap(source),source,source);
    }
    for(const source of ["/stories/2/","/story-more/2/","/unknown/2/","//source.example.test/story/2/","http://source.example.test/story/2/","https://source.example.test.evil/story/2/","https://foreign.example.test/?next=/story/2/","https://foreign.example.test/https://source.example.test/story/2/"]){assert.equal(remap(source),source,source);}
    assert.equal(remapImportedURL("/story/2/",mappings),"/story/2/");
    assert.equal(remapImportedURL("/story/2/",[["/story/","/shadowing-term/"]],bodyPages),"/story/2/");
  });
  await t.test("mixed term, media and font mappings never authorize numeric body suffixes", () => {
    for(const source of ["/category/topic/2/?x=1#keep","/uploads/source.png/2/","/fonts/source.woff2/2/"]){assert.equal(remap(source),source,source);}
    assert.equal(remap("/category/topic/?x=1#keep"),"/destination-category/topic/?x=1#keep");
    assert.equal(remap("/uploads/source.png?size=2#keep"),"/uploads/copy.png?size=2#keep");
    assert.equal(remap("/story/2/"),"/copy-story/2/","A newly generated target must not be remapped again.");
  });
  await t.test("closing prose punctuation follows canonical boundaries in relative, absolute and Plain destinations", () => {
    for(const punctuation of [")","))", ").", ")),", ");"]){
      assert.equal(remap("/story/)"),"/copy-story/)");
      assert.equal(remap("/story/2/"+punctuation),"/copy-story/2/"+punctuation);
      assert.equal(remap("https://source.example.test/story/2/"+punctuation),"https://destination.example.test/copy-story/2/"+punctuation);
      const query="?query-4-page=3&commentPage=2#keep";
      assert.equal(remap("https://source.example.test/story/2/"+query+punctuation),"https://destination.example.test/copy-story/2/"+query+punctuation);
      const map=[["/story/","/?p=90"]] as const,plain=new Map([["/story/",metadata("/?p=90","")]]);
      assert.equal(remapImportedURL("/story/2/"+punctuation,map,plain),"/?p=90&page=2"+punctuation);
      assert.equal(remapImportedURL("/story/2/"+query+punctuation,map,plain),"/?p=90&page=2&query-4-page=3&commentPage=2#keep"+punctuation);
      const conflicting="/story/2/?page=3#keep"+punctuation;
      assert.equal(remapImportedURL(conflicting,map,plain),conflicting);
    }
  });
  await t.test("punctuation cannot bypass exact numeric child priority or alternate-slash guards", () => {
    for(const punctuation of [")","))", ").", ")),", ");"]){
      assert.equal(remap("/parent/2/"+punctuation),"/?page_id=80"+punctuation);
      assert.equal(remap("/parent/2/?x=1#child"+punctuation),"/?page_id=80&x=1#child"+punctuation);
      for(const [child,alias] of [["/parent/2","/parent/2/"],["/parent/2/","/parent/2"]]){
        const map=[["/parent/","/copy-parent/"],[child,"/?page_id=81"]] as const;
        for(const query of ["","?x=1#child"]){const source=alias+query+punctuation;assert.equal(remapImportedURL(source,map,bodyPages),source);}
      }
      const absoluteMap=[["https://source.example.test/parent/","https://destination.example.test/parent/"],["https://source.example.test/parent/2/","https://destination.example.test/?page_id=82"]] as const;
      const absolutePages=new Map([[absoluteMap[0][0],metadata(absoluteMap[0][1])]]);
      assert.equal(remapImportedURL(absoluteMap[1][0]+punctuation,absoluteMap,absolutePages),absoluteMap[1][1]+punctuation);
      const alias=absoluteMap[1][0].slice(0,-1)+punctuation;
      assert.equal(remapImportedURL(alias,absoluteMap,absolutePages),alias);
    }
  });
  await t.test("closing punctuation does not expand unknown, extra, invalid or mixed-entity eligibility", () => {
    for(const punctuation of [")","))", ").", ")),", ");"]){
      for(const source of ["/unknown/2/","/story/02/","/story/4/","/story/2/extra/","/category/topic/2/","/uploads/source.png/2/","/fonts/source.woff2/2/","https://foreign.example.test/story/2/","https://source.example.test.evil/story/2/"]){assert.equal(remap(source+punctuation),source+punctuation);}
    }
    for(const source of ["/story/2/.","/story/2/),;","/story/2/%29"]){assert.equal(remap(source),source);}
  });
  await t.test("raw/JSON links keep whole-URL boundaries and inert escaped text", () => {
    const foreign="https://foreign.example.test/?next=/story/2/",literal='&lt;!--nextpage--&gt; [gallery ids="5"]';
    const raw='<p><a href="/story/2/?query-4-page=3&amp;commentPage=2#keep">Second</a><a href="'+foreign+'">Foreign</a></p><pre>'+literal+'</pre>';
    const value=remapImportedBlockReferences(raw,[{name:"core/navigation-link",attributes:{url:"/story/2/?x=1#keep"},innerBlocks:[]}],new Map(),{urls:new Map(mappings),bodyPages});
    const document=new DOMParser().parseFromString(value.rawContent,"text/html");
    assert.equal(document.querySelector("a")!.getAttribute("href"),"/copy-story/2/?query-4-page=3&commentPage=2#keep");
    assert.equal(document.querySelectorAll("a")[1].getAttribute("href"),foreign);
    assert.ok(value.rawContent.includes(literal));assert.equal(value.blocks[0].attributes.url,"/copy-story/2/?x=1#keep");
    const prose="<p>Canonical (https://source.example.test/story/) Body (https://source.example.test/story/2/) Nested ((https://source.example.test/story/2/)), Relative (/story/2/).</p>";
    const rewritten=remapImportedBlockReferences(prose,[],new Map(),{urls:new Map(mappings),bodyPages}).rawContent;
    assert.ok(rewritten.includes("Canonical (https://destination.example.test/copy-story/)"));
    assert.ok(rewritten.includes("Body (https://destination.example.test/copy-story/2/)"));
    assert.ok(rewritten.includes("Nested ((https://destination.example.test/copy-story/2/)),"));
    assert.ok(rewritten.includes("Relative (/copy-story/2/)."));
  });
});

test("Plain and numeric permalinks preserve public identity, protected access, pagination, notifications and archive references",async t=>{
  const initial=(await pool.query("SELECT data FROM settings WHERE id=1")).rows[0].data,posts:number[]=[],menus:number[]=[],stamp="plain-"+Date.now();let cookie="";
  async function request(path:string,method="GET",body?:unknown,auth=cookie){const response=await fetch(base+path,{method,headers:{Origin:origin,"Content-Type":"application/json",...(auth?{Cookie:auth}:{})},body:body===undefined?undefined:JSON.stringify(body)});return {response,data:await response.json()};}
  async function api(path:string,method="GET",body?:unknown,auth=cookie){const r=await request(path,method,body,auth);assert.ok(r.response.ok,`${path}: ${r.response.status} ${JSON.stringify(r.data)}`);return r;}
  const resolve=(path:string,auth="")=>request("/api/public/resolve?"+new URLSearchParams({path}),"GET",undefined,auth);
  async function post(input:Record<string,unknown>={}){const p=(await api("/api/posts","POST",{title:stamp+"-"+posts.length,status:"publish",content:"<p>PLAIN-FIRST</p><!--nextpage--><p>PLAIN-SECOND</p>",...input})).data.post;posts.push(p.id);return p;}
  try{
    const login=await api("/api/auth/login","POST",{login:process.env.ADMIN_EMAIL,password:process.env.ADMIN_PASSWORD},"");cookie=login.response.headers.get("set-cookie")!.split(";")[0];
    await api("/api/settings","PUT",{permalinkStructure:"",commentModeration:false,commentPreviouslyApproved:false,closeCommentsDays:0,pingServices:[]});
    assert.equal((await getSettings()).permalinkStructure,"");
    const story=await post({pingStatus:"open"}),parent=await post({type:"page"}),child=await post({type:"page",parentId:parent.id}),protectedPost=await post({password:"Plain-password-123",content:"<p>PLAIN-PROTECTED-FIRST</p><!--nextpage--><p>PLAIN-PROTECTED-SECOND</p>"});
    const draft=await post({status:"draft"}),privatePost=await post({status:"private"}),future=await post({status:"future",scheduledAt:new Date(Date.now()+86400000).toISOString()});
    await t.test("real settings persist empty structure and canonical post/page IDs keep content-page requests distinct",async()=>{
      assert.equal(story.permalink,"/?p="+story.id);assert.equal(parent.permalink,"/?page_id="+parent.id);assert.equal(child.permalink,"/?page_id="+child.id);
      const first=await resolve(story.permalink),second=await resolve(story.permalink+"&page=2");assert.equal(first.response.status,200);assert.equal(second.response.status,200);
      assert.equal(first.data.post.id,story.id);assert.match(first.data.post.content,/PLAIN-FIRST/);assert.doesNotMatch(first.data.post.content,/PLAIN-SECOND/);
      assert.equal(second.data.contentPage,2);assert.match(second.data.post.content,/PLAIN-SECOND/);assert.doesNotMatch(second.data.post.content,/PLAIN-FIRST/);
      assert.equal(second.data.post.contentPagination.links[1].url,story.permalink+"&page=2");
      assert.equal((await resolve(child.permalink)).data.post.id,child.id);
      for(const path of ["/?p="+parent.id,"/?page_id="+story.id,"/?p="+draft.id,"/?p="+privatePost.id,"/?p="+future.id])assert.equal((await resolve(path)).response.status,404,path);
      const locked=await resolve(protectedPost.permalink);assert.equal(locked.response.status,200);assert.equal(locked.data.post.locked,true);assert.doesNotMatch(JSON.stringify(locked.data),/PLAIN-PROTECTED|Plain-password/);
      const invalidUnlock=await request("/api/public/posts/"+protectedPost.slug+"/unlock?page[]=2","POST",{password:"Plain-password-123"},"");assert.equal(invalidUnlock.response.status,400);assert.equal((await pool.query("SELECT count(*)::int AS n FROM post_access_tokens WHERE post_id=$1",[protectedPost.id])).rows[0].n,0);
      const unlocked=await api("/api/public/posts/"+protectedPost.slug+"/unlock?page=2","POST",{password:"Plain-password-123"},"");const access=unlocked.response.headers.get("set-cookie")!.split(";")[0];
      assert.equal(unlocked.data.post.contentPagination.page,2);assert.match(unlocked.data.post.content,/PLAIN-PROTECTED-SECOND/);assert.doesNotMatch(unlocked.data.post.content,/PLAIN-PROTECTED-FIRST/);
      assert.match((await resolve(protectedPost.permalink,access)).data.post.content,/PLAIN-PROTECTED-FIRST/);
    });
    await t.test("duplicate, array-shaped, mixed and oversized identities cannot silently become home or another post",async()=>{
      for(const query of ["p=0","p=-1","p=1.5","p=2147483648","p=999999999999999999999","p[]=1","p[x]=1","p=1&p=2","p=1&page_id=2","page_id=bad","p="+story.id+"&page=0","p="+story.id+"&page[]=2","p="+story.id+"&page=2&page=3"]){
        assert.equal(readPlainPermalinkQuery(new URLSearchParams(query)).kind,"invalid",query);
        assert.equal((await resolve("/?"+query)).response.status,404,query);
      }
      assert.equal((await resolve("/wrong/?p="+story.id)).response.status,404);
      assert.equal(readPlainPermalinkQuery(new URLSearchParams("search=ordinary&page=2")).kind,"none");
    });
    await t.test("front and posts page configuration retains source canonical identity",async()=>{
      await api("/api/settings","PUT",{frontPageMode:"page",frontPageId:parent.id,postsPageId:child.id});
      assert.equal(await postPermalink(parent),"/");assert.equal(await postPermalink(child),"/?page_id="+child.id);
      assert.equal((await resolvePublicPath("/"))?.id,parent.id);assert.equal((await resolve(parent.permalink)).data.post.id,parent.id);
      const frontSecond=await resolve("/?page=2&query-4-page=7");assert.equal(frontSecond.response.status,200);assert.equal(frontSecond.data.contentPage,2);assert.match(frontSecond.data.post.content,/PLAIN-SECOND/);assert.doesNotMatch(frontSecond.data.post.content,/PLAIN-FIRST/);assert.equal(frontSecond.data.post.contentPagination.links[1].url,"/?page=2");
      assert.ok(frontSecond.data.post.content.includes('href="/"'));assert.equal((await resolve("/?page[]=2")).response.status,404);
      const site=(await api("/api/public/site","GET",undefined,"")).data;assert.equal(site.frontPage.id,parent.id);assert.equal(site.postsPage.id,child.id);
      await api("/api/settings","PUT",{frontPageMode:"posts",frontPageId:null,postsPageId:null});
    });
    await t.test("numeric source structure supports its non-slash ending without breaking hierarchical pages or Plain aliases",async()=>{
      await api("/api/settings","PUT",{permalinkStructure:"/archives/%post_id%"});
      assert.equal(await postPermalink(story),"/archives/"+story.id);
      assert.equal((await resolve("/archives/"+story.id)).data.post.id,story.id);assert.equal((await resolve("/archives/"+story.id+"/")).data.post.id,story.id);
      assert.equal((await resolve("/archives/"+story.id+"/2/")).data.contentPage,2);
      assert.equal((await resolve("/archives/"+story.id+"/2")).data.post.contentPagination.links[1].url,"/archives/"+story.id+"/2");
      assert.equal((await resolve(story.permalink)).data.post.id,story.id,"Plain ID links remain resolvable after enabling pretty links.");
      assert.equal(await postPermalink(child),`/${parent.slug}/${child.slug}`);
      const childSecond=await resolve(`/${parent.slug}/${child.slug}/2`);assert.equal(childSecond.response.status,200);assert.equal(childSecond.data.post.contentPagination.links[1].url,`/${parent.slug}/${child.slug}/2`);
      await api("/api/settings","PUT",{frontPageMode:"page",frontPageId:parent.id});
      const numericFront=await resolve("/page/2");assert.equal(numericFront.response.status,200);assert.equal(numericFront.data.post.contentPagination.links[1].url,"/page/2");
      await api("/api/settings","PUT",{frontPageMode:"posts",frontPageId:null});
      await api("/api/settings","PUT",{permalinkStructure:""});
    });
    await t.test("a renamed and reused slug cannot replace a fixed-ID public body",async()=>{
      const other=await post({content:"<p>WRONG-FIXED-ID-BODY</p>"});
      await pool.query("UPDATE posts SET slug=$2 WHERE id=$1",[story.id,story.slug+"-renamed"]);
      await pool.query("UPDATE posts SET slug=$2 WHERE id=$1",[other.id,story.slug]);
      try {
        const result=await resolve(story.permalink);
        assert.equal(result.response.status,200);assert.equal(result.data.post.id,story.id);
        assert.match(result.data.post.content,/PLAIN-FIRST/);assert.doesNotMatch(JSON.stringify(result.data),/WRONG-FIXED-ID-BODY/);
      } finally {
        await pool.query("UPDATE posts SET slug=$2 WHERE id=$1",[other.id,other.slug]);
        await pool.query("UPDATE posts SET slug=$2 WHERE id=$1",[story.id,story.slug]);
      }
    });
    await t.test("real notification workers use query identities and reject a changed canonical target",async()=>{
      const target=new URL(story.permalink,(await getSettings()).siteUrl).href;
      const receive=createIncomingPings({environment:()=>"production",http:async url=>({url,status:200,headers:{},body:Buffer.from(`<title>Plain source</title><a href="${target}">Actual backlink</a>`)})});
      await receive({type:"pingback",source:"https://plain-source.example.test/one",target,ip:"1.1.1.1"});assert.equal((await pool.query("SELECT count(*)::int AS n FROM comments WHERE post_id=$1 AND type='pingback'",[story.id])).rows[0].n,1);
      await assert.rejects(receive({type:"pingback",source:"https://plain-source.example.test/bad",target:target+"&extra=1",ip:"1.1.1.1"}),(e:unknown)=>e instanceof IncomingPingError&&e.code===33);
      const document=(await api("/api/posts/"+story.id,"PUT",{content:'<a href="https://plain-target.example.test/one">Notify</a>'})).data.post;
      const client=await pool.connect();try{await client.query("BEGIN");await enqueuePublicationPings(client,document.id,"production");await client.query("COMMIT");}finally{client.release();}
      const sources:string[]=[],worker=createOutgoingPingWorker({environment:()=>"production",protocol:{async pingback(_target,source){sources.push(source);return "sent";},async service(){throw new Error("Unexpected service");}}});
      await worker.runOnce();await worker.runOnce();assert.deepEqual(sources,[target]);
    });
    await t.test("archive query links rebase IDs exactly once without prefix, embedded-host or cascade corruption",async()=>{
      const source="https://plain-source.example.test",input={application:"WorldAct",version:3,settings:{siteUrl:source,permalinkStructure:""},posts:[{id:910001,type:"post",title:stamp+" imported",slug:stamp+"-imported",status:"publish",content:'<p><a href="/?p=910001&page=2">Self</a><a href="/?p=9100012">Unrelated</a></p>',permalink:"/?p=910001"}],menus:[{name:stamp+" menu",location:"",items:[{id:"self",label:"Self",url:source+"/?p=910001#more"},{id:"foreign",label:"Foreign",url:"https://foreign.example.test/?next=/?p=910001"}]}]};
      const imported=(await api("/api/tools/import","POST",input)).data;posts.push(...imported.postIds);menus.push(...imported.menuIds);
      const copy=(await api("/api/posts/"+imported.postIds[0])).data.post;assert.notEqual(copy.id,910001);assert.ok(copy.rawContent.includes(`/?p=${copy.id}&amp;page=2`));assert.ok(copy.rawContent.includes('/?p=9100012'));
      const menu=(await pool.query("SELECT items FROM navigation_menus WHERE id=$1",[imported.menuIds[0]])).rows[0];assert.equal(menu.items[0].url,new URL(copy.permalink,(await getSettings()).siteUrl).href+"#more");assert.equal(menu.items[1].url,input.menus[0].items[1].url);
      const mappings=new Map([["/?p=12","/?p=1"],["/?p=1","/?p=2"]]);const ordered=[...mappings].sort((a,b)=>b[0].length-a[0].length);
      assert.equal(remapImportedURL("/?p=12&page=2",ordered),"/?p=1&page=2");assert.equal(remapImportedURL("/?p=123",ordered),"/?p=123");
      const rebased=remapImportedBlockReferences('<p><a href="/?p=12">Once</a></p>',[],new Map(),{urls:mappings}).rawContent;
      assert.equal(new DOMParser().parseFromString(rebased,"text/html").querySelector("a")!.getAttribute("href"),"/?p=1");
    });
  }finally{await pool.query("DELETE FROM navigation_menus WHERE id=ANY($1::int[])",[menus]);await pool.query("DELETE FROM posts WHERE id=ANY($1::int[])",[posts]);await pool.query("UPDATE settings SET data=$1::jsonb WHERE id=1",[JSON.stringify(initial)]);}
});
