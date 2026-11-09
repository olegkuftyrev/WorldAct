import test, { after } from "./isolated-test.js";
import assert from "node:assert/strict";
import sharp from "sharp";
import { pool, getSettings } from "../server/db.js";
import { defaultUserNicename, requireDefaultUserNicename, userNicenameCandidate } from "../server/user-nicenames.js";
import { postPermalink, resolvePublicPath } from "../server/permalinks.js";
import { nativePostReturn } from "../server/native-post-return.js";
import { readPublishedPostById } from "../server/public-read.js";
import { postAccessReader } from "../server/post-passwords.js";
import { hashPassword } from "../server/auth.js";
import { createAkismetClient, reportAkismetTransition, type AkismetTransport } from "../server/bundled-plugins.js";

const base=process.env.TEST_API_URL!,origin=process.env.APP_ORIGIN!;
after(()=>pool.end());
test("source-default author identity rules truncate before sanitizing and preserve source collision spelling",()=>{
  for(const [input,expected] of [["A.B@C_D","a-bc_d"],["--A...B--","a-b"],["_","_"],["000","000"],["a".repeat(48)+"-x","a".repeat(48)+"-x"],["@".repeat(50)+"valid",""]])assert.equal(defaultUserNicename(input),expected);
  for(const input of ["0","@","---","...","@".repeat(50)+"valid"])assert.throws(()=>requireDefaultUserNicename(input));
  assert.equal(userNicenameCandidate("a".repeat(47)+"-xy",2),"a".repeat(47)+"--2");
  assert.equal(userNicenameCandidate("a".repeat(50),10),"a".repeat(47)+"-10");
});

test("persisted author slugs coordinate creation, REST, exact public identity, metadata truth and body grants",async t=>{
  const initial=(await pool.query("SELECT data FROM settings WHERE id=1")).rows[0].data;
  const stamp="author-"+Date.now().toString(36),users:number[]=[],posts:number[]=[],media:number[]=[];
  let cookie="";
  async function api(path:string,method="GET",body?:unknown,auth=cookie,authorization=""){
    const response=await fetch(base+path,{method,headers:{Origin:origin,"Content-Type":"application/json",...(auth?{Cookie:auth}:{}),...(authorization?{Authorization:authorization}:{})},body:body===undefined?undefined:JSON.stringify(body)});
    return {response,data:await response.json()};
  }
  async function ok(path:string,method="GET",body?:unknown,auth=cookie){const result=await api(path,method,body,auth);assert.ok(result.response.ok,`${path}: ${result.response.status} ${JSON.stringify(result.data)}`);return result;}
  async function create(username:string,role="author"){const user=(await ok("/api/users","POST",{username,email:`${stamp}-${users.length}@example.test`,displayName:"Public author "+users.length,password:"Author-password-12345",role})).data.user;users.push(user.id);return {...user,nicename:(await pool.query("SELECT nicename FROM users WHERE id=$1",[user.id])).rows[0].nicename};}
  async function post(input:Record<string,unknown>={}){const value=(await ok("/api/posts","POST",{title:stamp+"-"+posts.length,status:"publish",content:"<p>AUTHOR-FIRST</p><!--nextpage--><p>AUTHOR-SECOND</p>",...input})).data.post;posts.push(value.id);return value;}
  const resolve=(path:string,auth="")=>api("/api/public/resolve?"+new URLSearchParams({path}),"GET",undefined,auth);
  try{
    const signed=await ok("/api/auth/login","POST",{login:process.env.ADMIN_EMAIL,password:process.env.ADMIN_PASSWORD},"");cookie=signed.response.headers.get("set-cookie")!.split(";")[0];
    await ok("/api/settings","PUT",{pingServices:[],frontPageMode:"posts",frontPageId:null,postsPageId:null,permalinkStructure:"/%postname%/"});
    const one=await create(stamp+".A@B_C"),two=await create(stamp+"-AB_C"),hidden=await create(stamp+"-unpublished");
    assert.equal(one.nicename,stamp+"-ab_c");assert.equal(two.nicename,one.nicename+"-2");
    const record=await post({authorId:one.id}),privateRecord=await post({authorId:hidden.id,status:"private",content:"<p>PRIVATE-AUTHOR-BODY</p>"});

    await t.test("admin and registration creators reject empty source defaults and persist collision allocation",async()=>{
      for(const username of ["0","@","---","@".repeat(50)+"valid"]){assert.equal((await api("/api/users","POST",{username,email:stamp+"-invalid@example.test",displayName:"Invalid",password:"Author-password-12345",role:"author"})).response.status,400);}
      await ok("/api/settings","PUT",{usersCanRegister:true,defaultRole:"subscriber"});
      for(const username of ["0","@"]){assert.equal((await api("/api/auth/register","POST",{username,email:stamp+"-register-invalid@example.test"},"")).response.status,400);}
      const username=stamp+".Registered@User",registered=await ok("/api/auth/register","POST",{username,email:stamp+"-registered@example.test"},"");assert.equal(registered.response.status,201);
      const row=(await pool.query("SELECT id,nicename FROM users WHERE username=$1",[username])).rows[0];users.push(row.id);assert.equal(row.nicename,stamp+"-registereduser");
      const long="L".repeat(50),a=await create(long+".A"),b=await create(long+".B");assert.equal(a.nicename,"l".repeat(50));assert.equal(b.nicename,"l".repeat(48)+"-2");
    });
    await t.test("only whole author segments with post name or ID save, and wrong authors never select bodies",async()=>{
      for(const invalid of ["/%author%/","/pre-%author%/%post_id%/","/%author%-post/%postname%/","/%author%/%author%/%postname%/"]){assert.equal((await api("/api/settings","PUT",{permalinkStructure:invalid})).response.status,400);}
      for(const structure of ["/%author%/%postname%/","/%author%/%post_id%/","/%category%/%author%/%year%/%monthnum%/%day%/%hour%/%minute%/%second%/%post_id%/%postname%/"]){
        await ok("/api/settings","PUT",{permalinkStructure:structure,timezone:"UTC"});
        const canonical=await postPermalink(record);assert.ok(canonical.includes("/"+one.nicename+"/"));assert.equal((await resolve(canonical)).data.post.id,record.id);
        const wrong=await resolve(canonical.replace("/"+one.nicename+"/","/"+two.nicename+"/"));assert.equal(wrong.response.status,404);assert.doesNotMatch(JSON.stringify(wrong.data),/AUTHOR-FIRST|AUTHOR-SECOND/);
        assert.equal(await resolvePublicPath(canonical.replace(one.nicename,one.nicename.toUpperCase())),null);
      }
    });
    await t.test("author DTOs are ignored and caller transactions see actual uncommitted post associations",async()=>{
      await ok("/api/settings","PUT",{permalinkStructure:"/%author%/%post_id%/%postname%/"});
      const canonical=await postPermalink(record),settings=await getSettings();
      for(const dto of [{...record,authorId:two.id,author:{nicename:"wrong"}},{id:record.id,type:"post",slug:record.slug,status:"publish"},{...record,authorId:undefined}])assert.equal(await postPermalink(dto,settings),canonical);
      const client=await pool.connect();try{await client.query("BEGIN");await client.query("UPDATE posts SET author_id=$1 WHERE id=$2",[two.id,record.id]);assert.equal(await postPermalink({...record,authorId:one.id},settings,client),canonical.replace(one.nicename,two.nicename));assert.equal(await postPermalink(record,settings),canonical);}finally{await client.query("ROLLBACK");client.release();}
      await assert.rejects(postPermalink({...record,id:2147483647},settings),/author identity/);
      assert.equal(await nativePostReturn(record.id,undefined,undefined),canonical);
    });
    await t.test("public REST user/me and post/media embeds expose the same nicename without unpublished identity or credentials",async()=>{
      const own=await ok("/wp-json/wp/v2/users/me");assert.equal(own.data.slug,(await pool.query("SELECT nicename FROM users WHERE id=$1",[signed.data.user.id])).rows[0].nicename);
      const person=await ok("/wp-json/wp/v2/users/"+one.id,"GET",undefined,"");assert.equal(person.data.slug,one.nicename);assert.equal(person.data.link,"/author/"+one.nicename+"/");
      const listed=await ok("/wp-json/wp/v2/users?include="+[one.id,hidden.id].join(","),"GET",undefined,"");assert.deepEqual(listed.data.map((row:any)=>row.id),[one.id]);assert.equal((await api("/wp-json/wp/v2/users/"+hidden.id,"GET",undefined,"")).response.status,404);
      const embedded=await ok(`/wp-json/wp/v2/posts/${record.id}?_embed=author`,"GET",undefined,"");assert.equal(embedded.data._embedded.author[0].slug,one.nicename);assert.doesNotMatch(JSON.stringify(embedded.data._embedded.author),/password|@example.test|key_hash|nicename/);
      const png=await sharp({create:{width:8,height:8,channels:3,background:"#123456"}}).png().toBuffer(),form=new FormData();form.append("file",new Blob([new Uint8Array(png)],{type:"image/png"}),"author-proof.png");
      const uploaded=await fetch(base+"/api/media",{method:"POST",headers:{Origin:origin,Cookie:cookie},body:form});assert.equal(uploaded.status,201);const image=(await uploaded.json()).media;media.push(image.id);await pool.query("UPDATE media SET author_id=$1 WHERE id=$2",[one.id,image.id]);
      const imageREST=await ok(`/wp-json/wp/v2/media/${image.id}?_embed=author`,"GET",undefined,"");assert.equal(imageREST.data._embedded.author[0].slug,one.nicename);assert.equal(imageREST.data._embedded.author[0].email,undefined);assert.equal(imageREST.data._embedded.author[0].link,new URL("/author/"+one.nicename+"/",(await getSettings()).siteUrl).href);
      const archive=await api("/api/public/document?"+new URLSearchParams({path:"/?author="+one.id}),"GET",undefined,"");assert.equal(archive.response.status,200);assert.ok(JSON.stringify(archive.data).includes(record.slug));
    });
    await t.test("profile changes preserve assigned identity and new associations use the actual current author",async()=>{
      await ok("/api/users/"+one.id,"PUT",{displayName:"Changed display",email:stamp+"-changed@example.test",role:"editor"});
      assert.equal((await pool.query("SELECT nicename FROM users WHERE id=$1",[one.id])).rows[0].nicename,one.nicename);
      const edited=(await ok("/api/posts/"+record.id,"PUT",{authorId:two.id})).data.post;assert.ok(edited.permalink.includes("/"+two.nicename+"/"));assert.equal((await resolve(edited.permalink)).data.post.id,record.id);await ok("/api/posts/"+record.id,"PUT",{authorId:one.id});
      const preview=await ok("/api/posts/"+privateRecord.id+"/preview");assert.match(preview.data.post.content,/PRIVATE-AUTHOR-BODY/);assert.ok(preview.data.post.permalink.includes("/"+hidden.nicename+"/"));
    });
    await t.test("moderation feedback uses actual private post status rather than the comment status for author metadata",async()=>{
      const previous=(await pool.query("SELECT enabled,settings FROM extensions WHERE slug='akismet'")).rows[0],secret=(await pool.query("SELECT * FROM extension_secrets WHERE slug='akismet'")).rows[0],site=new URL((await getSettings()).siteUrl).href;
      try{
        await pool.query("UPDATE extensions SET enabled=true,settings='{\"sendComments\":true}' WHERE slug='akismet'");
        await pool.query("INSERT INTO extension_secrets(slug,api_key,verified_site_url,verified_at) VALUES('akismet','fake-author-feedback-key',$1,now()) ON CONFLICT(slug) DO UPDATE SET api_key=excluded.api_key,verified_site_url=excluded.verified_site_url,verified_at=excluded.verified_at",[site]);
        const comment=(await pool.query("INSERT INTO comments(post_id,author_name,author_email,content,status) VALUES($1,'Author feedback','private-feedback@example.test','Feedback proof','approved') RETURNING id",[privateRecord.id])).rows[0].id;
        await pool.query("INSERT INTO akismet_comment_checks(comment_id,user_ip,verdict) VALUES($1,'203.0.113.42','ham')",[comment]);
        const fields:URLSearchParams[]=[];const client=createAkismetClient((async(_url,init)=>{fields.push(new URLSearchParams(String(init!.body)));return new Response('Thanks for making the web a better place.');}) as AkismetTransport);
        assert.equal(await reportAkismetTransition(comment,"approved","spam",pool,client),"sent");assert.equal(fields.length,1);assert.equal(fields[0].get("permalink"),new URL(await postPermalink(privateRecord),site).href);
      }finally{
        await pool.query("UPDATE extensions SET enabled=$1,settings=$2 WHERE slug='akismet'",[previous.enabled,previous.settings]);
        await pool.query("DELETE FROM extension_secrets WHERE slug='akismet'");
        if(secret)await pool.query("INSERT INTO extension_secrets(slug,api_key,verified_site_url,verified_at,last_error_code,updated_at) VALUES($1,$2,$3,$4,$5,$6)",[secret.slug,secret.api_key,secret.verified_site_url,secret.verified_at,secret.last_error_code,secret.updated_at]);
      }
    });
    await t.test("feeds, sitemap, WXR, dashboard and initial SSR share persisted URLs without broadening bootstrap metadata",async()=>{
      const canonical=await postPermalink(record);
      for(const path of ["/feed/","/feed/atom/","/sitemap.xml"]){const response=await fetch(base+path);assert.equal(response.status,200,path);assert.ok((await response.text()).includes(canonical),path);}
      const wxr=await fetch(base+"/api/tools/export?format=wxr",{headers:{Cookie:cookie}});assert.equal(wxr.status,200);assert.ok((await wxr.text()).includes(canonical));
      assert.equal((await api("/api/dashboard")).response.status,200);
      const response=await fetch(base+canonical+"2/?query-4-page=2&commentPage=1");assert.equal(response.status,200);const html=await response.text();
      assert.match(html,/AUTHOR-SECOND/);assert.doesNotMatch(html,/AUTHOR-FIRST|PRIVATE-AUTHOR-BODY|password_hash|token_hash/);assert.ok(!html.includes(one.username));assert.ok(!html.includes(stamp+"-changed@example.test"));
    });
    await t.test("published/type identity fences and password grants survive author metadata lookup",async()=>{
      assert.equal((await resolve(await postPermalink(privateRecord))).response.status,404);
      for(const status of ["draft","pending","future"]){const hidden=await post({authorId:one.id,status,...(status==="future"?{scheduledAt:"2100-01-01T00:00:00Z"}:{})});const result=await resolve(hidden.permalink);assert.equal(result.response.status,404);assert.doesNotMatch(JSON.stringify(result.data),/AUTHOR-FIRST/);}
      const protectedPost=await post({authorId:one.id,password:"Author-body-password",content:"<p>AUTHOR-SECRET-FIRST</p><!--nextpage--><p>AUTHOR-SECRET-SECOND</p>"});
      const locked=await resolve(protectedPost.permalink+"2/");assert.equal(locked.data.post.locked,true);assert.doesNotMatch(JSON.stringify(locked.data),/AUTHOR-SECRET|password_hash|Author-body-password/);
      const grant=await ok("/api/public/posts/"+protectedPost.slug+"/unlock?page=2","POST",{password:"Author-body-password"},"");const access=grant.response.headers.get("set-cookie")!.split(";")[0];
      const body=await resolve(protectedPost.permalink+"2/",access);assert.match(body.data.post.content,/AUTHOR-SECRET-SECOND/);assert.doesNotMatch(body.data.post.content,/AUTHOR-SECRET-FIRST/);
      const parent=await post({type:"page"}),child=await post({type:"page",parentId:parent.id,slug:"2",content:"<p>AUTHOR-NUMERIC-CHILD</p>"});assert.equal((await resolve(child.permalink)).data.post.id,child.id);
      assert.equal((await resolve(`/${one.nicename}/${parent.id}/${parent.slug}/`)).response.status,404);
      assert.equal((await resolve(`/?p=${record.id}&page=2`)).data.contentPage,2);assert.equal((await resolve(`/?page_id=${parent.id}&page=2`)).data.contentPage,2);
    });
    await t.test("waiting public author lookup rechecks current publication and type before returning metadata",async()=>{
      for(const change of ["status='private'","type='page'"]){
        const record=await post({authorId:one.id});const control=await pool.connect();
        try{await control.query("BEGIN");await control.query("LOCK TABLE users IN ACCESS EXCLUSIVE MODE");
          const pending=resolve(record.permalink),nativePending=nativePostReturn(record.id,undefined,undefined).then(value=>({value,error:undefined}),error=>({value:undefined,error}));
          await waitForQuery("%SELECT u.nicename FROM posts p JOIN users u%", "relation",2);
          await control.query(`UPDATE posts SET ${change},author_id=$2 WHERE id=$1`,[record.id,hidden.id]);await control.query("COMMIT");const response=await pending;assert.equal(response.response.status,404);assert.doesNotMatch(JSON.stringify(response.data),/AUTHOR-FIRST|AUTHOR-SECOND/);
          const continuation=await nativePending;assert.equal(continuation.error?.status,404);assert.equal(continuation.value,undefined);
          if(change.startsWith("status"))await assert.rejects(nativePostReturn(record.id,undefined,undefined),/Post not found|author identity/);
          else assert.equal(await nativePostReturn(record.id,undefined,undefined),"/"+record.slug+"/");
        }finally{await control.query("ROLLBACK");control.release();}
      }
    });
    for(const mutation of ["expire","rotate"] as const)await t.test(`a grant invalidated by ${mutation} during the author lookup wait cannot release a previously selected protected body`,async()=>{
      const protectedPost=await post({authorId:one.id,password:"Author-wait-password",content:"<p>AUTHOR-WAIT-SECRET-FIRST</p><!--nextpage--><p>AUTHOR-WAIT-SECRET-SECOND</p>"});
      const unlocked=await ok("/api/public/posts/"+protectedPost.slug+"/unlock","POST",{password:"Author-wait-password"},"");
      const grant=unlocked.response.headers.get("set-cookie")!.split(";")[0],reader=postAccessReader({headers:{cookie:grant}}),control=await pool.connect();
      let first=true;
      try{
        const pending=readPublishedPostById(protectedPost.id,"post",{query:{page:"2"},canReadProtectedPost:async(id,db)=>{
          const allowed=await reader(id,db);if(first){first=false;assert.equal(allowed,true);await control.query("BEGIN");await control.query("LOCK TABLE users IN ACCESS EXCLUSIVE MODE");}return allowed;
        }});
        await waitForQuery("%SELECT u.nicename FROM posts p JOIN users u%","relation");
        if(mutation==="expire")await pool.query("UPDATE post_access_tokens SET expires_at=now()-interval '1 second' WHERE post_id=$1",[protectedPost.id]);
        else await control.query("UPDATE posts SET password_hash=$2 WHERE id=$1",[protectedPost.id,await hashPassword("New-author-wait-password")]);
        await control.query("COMMIT");
        const result=await pending;assert.equal(result.post.locked,true);assert.doesNotMatch(JSON.stringify(result),/AUTHOR-WAIT-SECRET/);
      }finally{await control.query("ROLLBACK");control.release();}
    });
  }finally{
    await pool.query("UPDATE settings SET data=$1 WHERE id=1",[initial]);
    if(posts.length)await pool.query("DELETE FROM posts WHERE id=ANY($1::int[])",[posts]);
    for(const id of media)await api("/api/media/"+id,"DELETE");
    if(users.length)await pool.query("DELETE FROM users WHERE id=ANY($1::int[])",[users]);
    await pool.query("DELETE FROM mail_outbox WHERE recipient LIKE $1",[stamp+"%"]);
    await api("/api/auth/logout","POST");
  }
});

async function waitForQuery(pattern:string,event:string,count=1){
  for(let attempt=0;attempt<150;attempt++){
    const waiting=await pool.query("SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid() AND state='active' AND wait_event=$2 AND query LIKE $1",[pattern,event]);
    if((waiting.rowCount||0)>=count)return;await new Promise(resolve=>setTimeout(resolve,20));
  }
  assert.fail("Expected bounded database wait was not observed: "+event);
}
