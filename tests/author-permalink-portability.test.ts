import test, { after } from "./isolated-test.js";
import assert from "node:assert/strict";
import { readFile, writeFile, readdir } from "node:fs/promises";
import { DOMParser } from "linkedom";
import sharp from "sharp";
import { pool, uploadsDir } from "../server/db.js";

const stage = process.env.AUTHOR_PERMALINK_ARCHIVE_STAGE, archivePath = process.env.AUTHOR_PERMALINK_ARCHIVE_PATH;
const base = process.env.TEST_API_URL!, origin = process.env.APP_ORIGIN!;
after(() => pool.end());

test("author identities and body-page links use fresh destination administrator associations across archive databases", { skip: !stage || !archivePath }, async () => {
  let cookie = "";
  async function api(path: string, method = "GET", body?: unknown) {
    const response = await fetch(base + path, { method, headers: { Origin: origin, Cookie: cookie, "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
    const data = await response.json(); assert.ok(response.ok, `${path}: ${response.status} ${JSON.stringify(data)}`);
    return { response, data };
  }
  const signed = await api("/api/auth/login", "POST", { login: process.env.ADMIN_EMAIL, password: process.env.ADMIN_PASSWORD });
  cookie = signed.response.headers.get("set-cookie")!.split(";")[0];
  const structure = "/clock/%author%/%year%/%monthnum%/%day%/%hour%/%minute%/%second%/%post_id%/%postname%/";
  const username=stage==="export"?"Archive.Source@Author":"Archive.Destination@Admin";
  if(stage!=="export")await api("/api/users","POST",{username:"Destination-identity-offset",email:"offset@example.test",displayName:"Offset",password:"Archive-author-password-123",role:"subscriber"});
  const person=(await api("/api/users","POST",{username,email:stage==="export"?"source-author@example.test":"destination-admin@example.test",displayName:"Archive author",password:"Archive-author-password-123",role:stage==="export"?"author":"administrator"})).data.user;
  const nicename=(await pool.query("SELECT nicename FROM users WHERE id=$1",[person.id])).rows[0].nicename;
  assert.equal(nicename,stage==="export"?"archive-sourceauthor":"archive-destinationadmin");
  if(stage!=="export"){
    const switched=await api("/api/auth/login","POST",{login:username,password:"Archive-author-password-123"});
    cookie=switched.response.headers.get("set-cookie")!.split(";")[0];
  }
  if (stage === "export") {
    await api("/api/settings", "PUT", { timezone: "+05:45", permalinkStructure: structure, siteUrl: "https://body-source.example.invalid", pingServices: [] });
    const post = (await api("/api/posts", "POST", { title: "Time-token portable post", authorId:person.id,status: "publish", publishedAt: "2024-12-31T18:15:39Z", content: "<p>TIME-ARCHIVE-FIRST</p><!--nextpage--><p>TIME-ARCHIVE-SECOND</p>" })).data.post;
    assert.equal(post.permalink, `/clock/${nicename}/2025/01/01/00/00/39/${post.id}/${post.slug}/`);
    const parent = (await api("/api/posts", "POST", { type: "page", title: "Body archive parent", status: "publish", content: "<p>BODY-PARENT-FIRST</p><!--nextpage--><p>BODY-PARENT-SECOND</p>" })).data.post;
    const child = (await api("/api/posts", "POST", { type: "page", parentId: parent.id, slug: "2", title: "Body archive numeric child", status: "publish", content: "<p>BODY-CHILD-FIRST</p><!--nextpage--><p>BODY-CHILD-SECOND</p>" })).data.post;
    assert.equal(child.permalink, parent.permalink + "2/");
    const privatePost = (await api("/api/posts", "POST", { title: "Body archive private", status: "private", content: "<p>BODY-PRIVATE-FIRST</p><!--nextpage--><p>BODY-PRIVATE-SECOND</p>" })).data.post;
    const protectedPost = (await api("/api/posts", "POST", { title: "Body archive protected", status: "publish", password: "Body-archive-password-123", content: "<p>BODY-PROTECTED-FIRST</p><!--nextpage--><p>BODY-PROTECTED-SECOND</p>" })).data.post;
    const term = (await api("/api/terms", "POST", { taxonomy: "category", name: "Body archive term", slug: "body-archive-term" })).data.term;
    const form = new FormData(), png = await sharp({create:{width:8,height:8,channels:3,background:"#445566"}}).png().toBuffer();
    form.append("file",new Blob([new Uint8Array(png)],{type:"image/png"}),"body-archive-source.png");
    const upload = await fetch(base+"/api/media",{method:"POST",headers:{Origin:origin,Cookie:cookie},body:form});
    assert.equal(upload.status,201);const media=(await upload.json()).media;
    const urls = {
      canonical:post.permalink+"#canonical",body:post.permalink+"2/?query-4-page=3&commentPage=2#keep",
      child:child.permalink+"?query-4-page=3#child",childBody:child.permalink+"2/#child-body",
      termCanonical:`/category/${term.slug}/`,mediaCanonical:media.url,
      termBody:`/category/${term.slug}/2/?x=1#term`,mediaBody:media.url+"/2/?x=1#media",
      privateBody:privatePost.permalink+"2/#private",protectedBody:protectedPost.permalink+"2/#protected",
      foreign:"https://foreign.example.test/?next="+post.permalink+"2/",
    };
    const links = Object.entries(urls).map(([label,url])=>`<a data-proof="${label}" href="${url.replace(/&/g,"&amp;")}">${label}</a>`).join("");
    const absolute="https://body-source.example.invalid",boundary=`<p>BOUNDARY-CANONICAL (${absolute+post.permalink}) BOUNDARY-BODY (${absolute+post.permalink}2/) BOUNDARY-NESTED ((${absolute+post.permalink}2/)), BOUNDARY-QUERY (${absolute+urls.body}); BOUNDARY-RELATIVE (${post.permalink}2/). BOUNDARY-CHILD (${absolute+child.permalink}) BOUNDARY-CHILD-ALIAS (${absolute+child.permalink.slice(0,-1)}) BOUNDARY-TERM (${absolute+urls.termBody}) BOUNDARY-MEDIA (${absolute+urls.mediaBody}) BOUNDARY-UNKNOWN (${absolute+post.permalink}2/extra/)</p>`;
    await api("/api/posts/" + post.id, "PUT", { content: `<p>TIME-ARCHIVE-FIRST ${links}</p>${boundary}<pre>&lt;!--nextpage--&gt; [php]inert[/php]</pre><!--nextpage--><p>TIME-ARCHIVE-SECOND</p>` });
    await api("/api/menus","POST",{name:"Body archive menu",location:"primary",items:[{id:"body",label:"Body second",url:"https://body-source.example.invalid"+urls.body},{id:"child",label:"Numeric child",url:"https://body-source.example.invalid"+urls.child}]});
    const archive = (await api("/api/tools/export")).data;
    assert.equal(archive.settings.permalinkStructure, structure); assert.equal(archive.settings.timezone, "+05:45");
    assert.equal(archive.posts.find((row: any) => row.id === post.id).published_at, "2024-12-31T18:15:39.000Z");
    await writeFile(archivePath!, JSON.stringify({ archive, sourceId: post.id, sourceAuthorId:person.id,sourceNicename:nicename, urls }), { mode: 0o600 });
  } else {
    assert.equal(stage, "restore");
    const fixture = JSON.parse(await readFile(archivePath!, "utf8"));
    async function inspect(restored:any,expectedStructure:string) {
      async function imported(title:string){const row=(await pool.query("SELECT id FROM posts WHERE id=ANY($1::int[]) AND title=$2",[restored.postIds,title])).rows[0];assert.ok(row);return (await api("/api/posts/"+row.id)).data.post;}
      const settings=(await api("/api/settings")).data.settings;
      assert.equal(settings.permalinkStructure,expectedStructure);
      const post=await imported("Time-token portable post"),child=await imported("Body archive numeric child");
      assert.notEqual(post.id,fixture.sourceId);assert.notEqual(person.id,fixture.sourceAuthorId);
      assert.equal((await pool.query("SELECT author_id FROM posts WHERE id=$1",[post.id])).rows[0].author_id,person.id);
      if(expectedStructure.includes("%author%")){assert.ok(post.permalink.includes("/"+nicename+"/"));assert.ok(!post.permalink.includes("/"+fixture.sourceNicename+"/"));}
      assert.equal((await pool.query("SELECT count(*)::int AS count FROM users WHERE username='Archive.Source@Author'")).rows[0].count,0);assert.equal(post.publishedAt,"2024-12-31T18:15:39.000Z");
      assert.notEqual(child.id,fixture.archive.posts.find((record:any)=>record.title==="Body archive numeric child").id);
      const bodyURL=(record:any,page=2)=>expectedStructure===""?record.permalink+"&page="+page:record.permalink.replace(/\/?$/,"/")+page+(expectedStructure.endsWith("/")?"/":"");
      const expectedBody=bodyURL(post), expectedChildBody=bodyURL(child);
      const dom=new DOMParser().parseFromString(post.rawContent,"text/html"),href=(label:string)=>[...dom.querySelectorAll("a")].find(link=>link.textContent===label)!.getAttribute("href");
      assert.equal(href("canonical"),post.permalink+"#canonical");
      assert.equal(href("body"),expectedBody+(expectedBody.includes("?")?"&":"?")+"query-4-page=3&commentPage=2#keep");
      assert.equal(href("child"),child.permalink+(child.permalink.includes("?")?"&":"?")+"query-4-page=3#child");
      assert.equal(href("childBody"),expectedChildBody+"#child-body");
      for(const label of ["termBody","mediaBody","privateBody","protectedBody","foreign"])assert.equal(href(label),fixture.urls[label],label);
      assert.ok(post.rawContent.includes('&lt;!--nextpage--&gt; [php]inert[/php]'));
      const boundary=[...dom.querySelectorAll("p")].find(paragraph=>paragraph.textContent.startsWith("BOUNDARY-CANONICAL"))!.textContent;
      const absoluteCanonical=new URL(post.permalink,settings.siteUrl).href,absoluteBody=new URL(expectedBody,settings.siteUrl).href;
      assert.ok(boundary.includes(`BOUNDARY-CANONICAL (${absoluteCanonical})`));
      assert.ok(boundary.includes(`BOUNDARY-BODY (${absoluteBody})`));
      assert.ok(boundary.includes(`BOUNDARY-NESTED ((${absoluteBody})),`));
      assert.ok(boundary.includes(`BOUNDARY-QUERY (${absoluteBody}${absoluteBody.includes("?")?"&":"?"}query-4-page=3&commentPage=2#keep);`));
      assert.ok(boundary.includes(`BOUNDARY-RELATIVE (${expectedBody}).`));
      assert.ok(boundary.includes(`BOUNDARY-CHILD (${new URL(child.permalink,settings.siteUrl).href})`));
      const sourceChild=fixture.archive.posts.find((record:any)=>record.title==="Body archive numeric child").permalink;
      assert.ok(boundary.includes(`BOUNDARY-CHILD-ALIAS (https://body-source.example.invalid${sourceChild.slice(0,-1)})`));
      for(const label of ["TERM","MEDIA"]){assert.ok(boundary.includes(`BOUNDARY-${label} (https://body-source.example.invalid${fixture.urls[label.toLowerCase()+"Body"]})`));}
      assert.ok(boundary.includes(`BOUNDARY-UNKNOWN (https://body-source.example.invalid${fixture.archive.posts.find((record:any)=>record.id===fixture.sourceId).permalink}2/extra/)`));
      const resolve=(href:string)=>{const url=new URL(href,base);return api("/api/public/resolve?"+new URLSearchParams({path:url.pathname+url.search}));};
      const result=await resolve(href("body")!);assert.equal(result.data.post.id,post.id);assert.equal(result.data.contentPage,2);
      assert.match(result.data.post.content,/TIME-ARCHIVE-SECOND/);assert.doesNotMatch(result.data.post.content,/TIME-ARCHIVE-FIRST|BODY-PRIVATE|BODY-PROTECTED/);
      assert.equal(result.data.post.contentPagination.links[1].url,expectedBody);
      const exactChild=await resolve(href("child")!);assert.equal(exactChild.data.post.id,child.id);assert.match(exactChild.data.post.content,/BODY-CHILD-FIRST/);assert.doesNotMatch(exactChild.data.post.content,/BODY-PARENT/);
      const childSecond=await resolve(href("childBody")!);assert.equal(childSecond.data.post.id,child.id);assert.match(childSecond.data.post.content,/BODY-CHILD-SECOND/);
      // Exercise the actual Node document and native continuation after fresh-ID
      // rebasing, rather than proving only the legacy JSON resolver in isolation.
      const previousTheme=settings.theme;
      try {
        for(const theme of ["twentytwentyfive","classic"]){
          await api("/api/settings","PUT",{theme});
          const documentFor=async(link:string,id:number,page:number,content:string)=>{
            const target=new URL(link,base),response=await fetch(base+target.pathname+target.search,{headers:{Cookie:cookie}});
            assert.equal(response.status,200,theme+" "+target.pathname+target.search);assert.match(response.headers.get("content-type") || "",/text\/html/);
            const html=await response.text(),document=new DOMParser().parseFromString(html,"text/html"),bootstrap=document.querySelector("#worldact-public-document");assert.ok(bootstrap);
            const model=JSON.parse(bootstrap.textContent!);assert.equal(model.post.id,id);assert.equal(model.route.query.contentPage,page);assert.ok(document.querySelector("#root")!.textContent!.includes(content));
            if(target.searchParams.has("query-4-page"))assert.equal(model.route.query.blockPages["query-4-page"],Number(target.searchParams.get("query-4-page")));
            assert.doesNotMatch(html,/BODY-PRIVATE-FIRST|BODY-PROTECTED-FIRST|Body-archive-password-123/);
            return {document,model};
          };
          const initial=await documentFor(href("body")!,post.id,2,"TIME-ARCHIVE-SECOND");
          await documentFor(href("child")!,child.id,1,"BODY-CHILD-FIRST");
          await documentFor(href("childBody")!,child.id,2,"BODY-CHILD-SECOND");
          const form=initial.document.querySelector('form[action="/wp-comments-post.php"]')!;assert.ok(form);assert.ok(form.querySelector('[name="redirect_to"]'));
          const fields=new URLSearchParams();for(const input of form.querySelectorAll('input[type="hidden"]'))fields.append(input.getAttribute("name")!,input.getAttribute("value") || "");
          const text="Time-body actual native "+post.id+" "+theme;fields.set("content",text);
          const saved=await fetch(base+form.getAttribute("action"),{method:"POST",redirect:"manual",headers:{Origin:origin,Cookie:cookie},body:fields});assert.equal(saved.status,303,await saved.text());
          const returned=new URL(saved.headers.get("location")!,base);assert.equal(returned.searchParams.get("query-4-page"),"3");assert.match(returned.hash,/^#comment-[1-9]\d*$/);
          const after=await documentFor(returned.pathname+returned.search,post.id,2,"TIME-ARCHIVE-SECOND");
          assert.ok(after.model.comments.some((record:any)=>record.content.includes(text)));assert.ok(after.document.querySelector(returned.hash));
        }
      }finally{await api("/api/settings","PUT",{theme:previousTheme});}
      for(const title of ["Body archive private","Body archive protected"]){const hidden=await imported(title);assert.equal(hidden.status,title.endsWith("private")?"private":"draft");const denied=await fetch(base+"/api/public/resolve?"+new URLSearchParams({path:bodyURL(hidden)}));assert.equal(denied.status,404);assert.doesNotMatch(await denied.text(),/BODY-PRIVATE|BODY-PROTECTED|Body-archive-password/);}
      const exported=(await api("/api/tools/export")).data;
      assert.equal(exported.posts.find((record:any)=>record.id===post.id).published_at,"2024-12-31T18:15:39.000Z");
      const copiedMedia=exported.media.find((record:any)=>restored.mediaIds.includes(record.id));assert.ok(copiedMedia);
      assert.notEqual(copiedMedia.filename,fixture.archive.media[0].filename);
      assert.equal(href("mediaCanonical"),"/uploads/"+copiedMedia.filename);
      const copiedTerm=exported.terms.find((record:any)=>restored.termIds.includes(record.id)&&record.name==="Body archive term");assert.ok(copiedTerm);
      assert.equal(href("termCanonical"),"/"+settings.categoryBase+"/"+copiedTerm.slug+"/");
      const menu=exported.menus.find((record:any)=>restored.menuIds.includes(record.id));assert.ok(menu);
      const absolute=new URL(expectedBody,settings.siteUrl).href;
      assert.equal(menu.items[0].url,absolute+(absolute.includes("?")?"&":"?")+"query-4-page=3&commentPage=2#keep");
      assert.equal(menu.items[1].url,new URL(child.permalink,settings.siteUrl).href+(child.permalink.includes("?")?"&":"?")+"query-4-page=3#child");
      return {post,settings};
    }
    // Retaining destination settings must use its actual Plain and slashless
    // Numeric canonicals, rather than append source-format pagination to them.
    for(const destination of ["","/destination/%author%/%post_id%"]){
      await api("/api/settings","PUT",{permalinkStructure:destination,categoryBase:"destination-category",timezone:"UTC"});
      const copied=(await api("/api/tools/import","POST",fixture.archive)).data;assert.equal(copied.restoredDesign,false);
      await inspect(copied,destination);
    }
    const restored=(await api("/api/tools/import","POST",{...fixture.archive,replaceDesign:true})).data;
    assert.equal(restored.restoredDesign,true);const checked=await inspect(restored,structure);assert.equal(checked.settings.timezone,"+05:45");
    const beforePosts=(await pool.query("SELECT id,raw_content,blocks FROM posts ORDER BY id")).rows;
    const beforeSettings=(await pool.query("SELECT data FROM settings WHERE id=1")).rows[0].data;
    const beforeFiles=(await readdir(uploadsDir,{recursive:true})).sort();
    const beforeCounts=(await pool.query("SELECT (SELECT count(*) FROM posts) posts,(SELECT count(*) FROM media) media,(SELECT count(*) FROM terms) terms,(SELECT count(*) FROM navigation_menus) menus")).rows[0];
    const invalid=structuredClone(fixture.archive);invalid.replaceDesign=true;
    invalid.menus.push({...invalid.menus[0],name:"Second conflicting primary menu",location:"primary"});
    const failed=await fetch(base+"/api/tools/import",{method:"POST",headers:{Origin:origin,Cookie:cookie,"Content-Type":"application/json"},body:JSON.stringify(invalid)});
    assert.equal(failed.status,400);assert.match((await failed.json()).error,/one menu|location/i);
    assert.deepEqual((await pool.query("SELECT id,raw_content,blocks FROM posts ORDER BY id")).rows,beforePosts);
    assert.deepEqual((await pool.query("SELECT data FROM settings WHERE id=1")).rows[0].data,beforeSettings);
    assert.deepEqual((await pool.query("SELECT (SELECT count(*) FROM posts) posts,(SELECT count(*) FROM media) media,(SELECT count(*) FROM terms) terms,(SELECT count(*) FROM navigation_menus) menus")).rows[0],beforeCounts);
    assert.deepEqual((await readdir(uploadsDir,{recursive:true})).sort(),beforeFiles);
    // A new import after the late transaction failure must allocate and use its
    // own fresh IDs, without retaining any rolled-back instance's body map.
    const retry=(await api("/api/tools/import","POST",fixture.archive)).data;
    await inspect(retry,structure);
  }
});
