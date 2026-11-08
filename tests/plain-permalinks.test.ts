import test, { after } from "./isolated-test.js";
import assert from "node:assert/strict";
import { DOMParser } from "linkedom";
import { pool, getSettings } from "../server/db.js";
import { postPermalink, resolvePublicPath } from "../server/permalinks.js";
import { readPlainPermalinkQuery } from "../shared/plain-permalink-query.js";
import { createIncomingPings, IncomingPingError } from "../server/incoming-pings.js";
import { createOutgoingPingWorker, enqueuePublicationPings } from "../server/outgoing-pings.js";
import { remapImportedBlockReferences, remapImportedURL } from "../server/block-portability.js";
const base=process.env.TEST_API_URL!,origin=process.env.APP_ORIGIN!;
after(async()=>{await pool.end();});

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
    const story=await post({pingStatus:"open"}),parent=await post({type:"page"}),child=await post({type:"page",parentId:parent.id}),protectedPost=await post({password:"Plain-password-123",content:"<p>PLAIN-PROTECTED-BODY</p>"});
    const draft=await post({status:"draft"}),privatePost=await post({status:"private"}),future=await post({status:"future",scheduledAt:new Date(Date.now()+86400000).toISOString()});
    await t.test("real settings persist empty structure and canonical post/page IDs keep content-page requests distinct",async()=>{
      assert.equal(story.permalink,"/?p="+story.id);assert.equal(parent.permalink,"/?page_id="+parent.id);assert.equal(child.permalink,"/?page_id="+child.id);
      const first=await resolve(story.permalink),second=await resolve(story.permalink+"&page=2");assert.equal(first.response.status,200);assert.equal(second.response.status,200);
      assert.equal(first.data.post.id,story.id);assert.match(first.data.post.content,/PLAIN-FIRST/);assert.doesNotMatch(first.data.post.content,/PLAIN-SECOND/);
      assert.equal(second.data.contentPage,2);assert.match(second.data.post.content,/PLAIN-SECOND/);assert.doesNotMatch(second.data.post.content,/PLAIN-FIRST/);
      assert.equal(second.data.post.contentPagination.links[1].url,story.permalink+"&page=2");
      assert.equal((await resolve(child.permalink)).data.post.id,child.id);
      for(const path of ["/?p="+parent.id,"/?page_id="+story.id,"/?p="+draft.id,"/?p="+privatePost.id,"/?p="+future.id])assert.equal((await resolve(path)).response.status,404,path);
      const locked=await resolve(protectedPost.permalink);assert.equal(locked.response.status,200);assert.equal(locked.data.post.locked,true);assert.doesNotMatch(JSON.stringify(locked.data),/PLAIN-PROTECTED-BODY|Plain-password/);
      const unlocked=await api("/api/public/posts/"+protectedPost.slug+"/unlock","POST",{password:"Plain-password-123"},"");const access=unlocked.response.headers.get("set-cookie")!.split(";")[0];
      assert.match((await resolve(protectedPost.permalink,access)).data.post.content,/PLAIN-PROTECTED-BODY/);
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
      const site=(await api("/api/public/site","GET",undefined,"")).data;assert.equal(site.frontPage.id,parent.id);assert.equal(site.postsPage.id,child.id);
      await api("/api/settings","PUT",{frontPageMode:"posts",frontPageId:null,postsPageId:null});
    });
    await t.test("numeric source structure supports its non-slash ending without breaking hierarchical pages or Plain aliases",async()=>{
      await api("/api/settings","PUT",{permalinkStructure:"/archives/%post_id%"});
      assert.equal(await postPermalink(story),"/archives/"+story.id);
      assert.equal((await resolve("/archives/"+story.id)).data.post.id,story.id);assert.equal((await resolve("/archives/"+story.id+"/")).data.post.id,story.id);
      assert.equal((await resolve("/archives/"+story.id+"/2/")).data.contentPage,2);
      assert.equal((await resolve(story.permalink)).data.post.id,story.id,"Plain ID links remain resolvable after enabling pretty links.");
      assert.equal(await postPermalink(child),`/${parent.slug}/${child.slug}/`);
      await api("/api/settings","PUT",{permalinkStructure:""});
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
