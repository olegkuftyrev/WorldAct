import test, {after} from "./isolated-test.js";
import assert from "node:assert/strict";
import {pool,getSettings} from "../server/db.js";
import {resolvePrettyAuthorArchive} from "../server/author-archives.js";
after(()=>pool.end());
const base=process.env.TEST_API_URL!,origin=process.env.APP_ORIGIN!;
async function held(fragment:string){
 const end=Date.now()+10000;
 while(Date.now()<end){if((await pool.query("SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event='advisory' AND position($1 in query)>0",[fragment])).rowCount)return;await new Promise(r=>setTimeout(r,10));}
 assert.fail("The actual selected author projection did not wait: "+fragment);
}
test("independent author identity boundaries include direct endpoints, caller snapshots and numeric slugs",{timeout:90000},async t=>{
 const original=(await pool.query("SELECT data FROM settings WHERE id=1")).rows[0].data;
 let cookie="",view=false;const people:number[]=[],posts:number[]=[],documents:number[]=[];
 async function api(path:string,method="GET",body?:unknown,anonymous=false){const response=await fetch(base+path,{method,headers:{Origin:origin,Cookie:anonymous?"":cookie,"Content-Type":"application/json"},body:body===undefined?undefined:JSON.stringify(body)}),text=await response.text();let data:any;try{data=JSON.parse(text);}catch{}return {response,text,data};}
 async function ok(path:string,method="GET",body?:unknown){const r=await api(path,method,body);assert.ok(r.response.ok,`${path}: ${r.response.status} ${r.text}`);return r.data;}
 try{
  const signed=await api("/api/auth/login","POST",{login:process.env.ADMIN_EMAIL,password:process.env.ADMIN_PASSWORD});assert.equal(signed.response.status,200);cookie=signed.response.headers.get("set-cookie")!.split(";")[0];
  const admin=(await pool.query("SELECT id FROM users WHERE email=$1",[process.env.ADMIN_EMAIL])).rows[0];
  await ok("/api/settings","PUT",{permalinkStructure:"/%postname%/",frontPageMode:"posts",pingServices:[],showAvatars:true});
  const fixtures:Record<string,any>={};
  for(const name of ["site","template","snapshot","row","numeric"]){const username="pretty-independent-"+name+"-"+Date.now();const person=(await ok("/api/users","POST",{username,email:username+"@example.test",displayName:"PUBLIC-INDEPENDENT-"+name,password:"Independent-author-fixture-password",role:"author"})).user;person.nicename=(await pool.query("SELECT nicename FROM users WHERE id=$1",[person.id])).rows[0].nicename;fixtures[name]=person;people.push(person.id);}
  const page=(await ok("/api/posts","POST",{title:"Independent public surroundings",type:"page",status:"publish",content:"<p>PUBLIC-INDEPENDENT-PAGE.</p>"})).post;posts.push(page.id);
  documents.push((await ok("/api/site-editor/documents","POST",{type:"template",slug:"pretty-independent-boundary",title:"Independent boundary",content:`<!-- wp:avatar {"userId":${admin.id},"isLink":true} /-->`})).document.id);
  await t.test("numeric nicename selects its actual account under a static front page",async()=>{
   const person=fixtures.numeric;await pool.query("UPDATE users SET nicename='901337' WHERE id=$1",[person.id]);
   await ok("/api/settings","PUT",{frontPageMode:"page",frontPageId:page.id});
   const path="/author/901337/",r=await api("/api/public/document?"+new URLSearchParams({path}),"GET",undefined,true);
   assert.equal(r.response.status,200);assert.equal(r.data.route.kind,"archive");assert.equal(r.data.route.query.author,person.id);assert.equal(r.data.site.archive.slug,"901337");assert.notEqual(person.id,901337);assert.equal(r.data.post,null);
   const resolved=await api("/api/public/resolve?"+new URLSearchParams({path}),"GET",undefined,true);assert.equal(resolved.response.status,200);assert.equal(resolved.data.archive.authorId,person.id);
   assert.equal((await fetch(base+path,{method:"HEAD"})).status,200);
   assert.equal((await api("/api/public/document?"+new URLSearchParams({path:"/author/"+person.id+"/"}),"GET",undefined,true)).response.status,404);
   await ok("/api/settings","PUT",{frontPageMode:"posts",frontPageId:null});
  });
  const columns=(await pool.query("SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name='users' ORDER BY ordinal_position")).rows.map(r=>r.column_name);
  const setup=await pool.connect();try{
   await setup.query("BEGIN");await setup.query("CREATE TABLE worldact_pretty_independent_gate(mode text)");await setup.query("INSERT INTO worldact_pretty_independent_gate VALUES('off')");
   await setup.query(`CREATE FUNCTION worldact_pretty_independent_display(value varchar) RETURNS varchar LANGUAGE plpgsql STABLE AS $$ DECLARE mode text; BEGIN SELECT g.mode INTO mode FROM worldact_pretty_independent_gate g; IF (mode='site' AND position('FROM posts p JOIN users u' in current_query())>0) OR (mode='template' AND position('FROM users WHERE id=$1' in current_query())>0) OR (mode='snapshot' AND position('FROM users WHERE nicename=$1' in current_query())>0) THEN PERFORM pg_advisory_xact_lock(hashtext('worldact-pretty-independent-boundary')); END IF; RETURN value; END $$`);
   await setup.query("ALTER TABLE users RENAME TO worldact_pretty_independent_actual_users");await setup.query('CREATE VIEW users AS SELECT '+columns.map(c=>c==='display_name'?'worldact_pretty_independent_display(display_name) AS display_name':'"'+c+'"').join(',')+' FROM worldact_pretty_independent_actual_users');await setup.query("COMMIT");view=true;
  }catch(error){await setup.query("ROLLBACK");throw error;}finally{setup.release();}
  for(const surface of ["site","template"]){await t.test("direct "+surface+" rejects retirement without substituting a same-slug replacement",async()=>{
   const person=fixtures[surface],control=await pool.connect();let pending:ReturnType<typeof api>|undefined;
   try{
    await pool.query("UPDATE worldact_pretty_independent_gate SET mode=$1",[surface]);await control.query("BEGIN");await control.query("SELECT pg_advisory_xact_lock(hashtext('worldact-pretty-independent-boundary'))");
    const query=new URLSearchParams({requestPath:"/author/"+person.nicename+"/"});pending=api((surface==='site'?"/api/public/site":"/api/public/templates/pretty-independent-boundary")+"?"+query,"GET",undefined,true);
    await held(surface==='site'?"SELECT p.id":"FROM users WHERE id=$1");
    await pool.query("DELETE FROM worldact_pretty_independent_actual_users WHERE id=$1",[person.id]);
    const replacement=(await pool.query("INSERT INTO worldact_pretty_independent_actual_users(username,email,display_name,password_hash,role,nicename) VALUES($1,$2,'PUBLIC-INDEPENDENT-REPLACEMENT','inert-fixture-hash','author',$3) RETURNING id",[person.username+'-new',person.id+'-independent-new@example.test',person.nicename])).rows[0];people.push(replacement.id);
    await control.query("COMMIT");const result=await pending;assert.ok([404,409].includes(result.response.status),JSON.stringify({surface,status:result.response.status,data:result.data,replacement:replacement.id}));
   }finally{await control.query("ROLLBACK");control.release();if(pending)await pending.catch(()=>{});await pool.query("UPDATE worldact_pretty_independent_gate SET mode='off'");}
  });}
  await t.test("ordinary supplied client rejects a real non-key user row lock promptly",async()=>{
   const person=fixtures.row,settings=await getSettings(),control=await pool.connect(),reader=await pool.connect();
   try{await control.query("BEGIN");await control.query("SELECT id FROM worldact_pretty_independent_actual_users WHERE id=$1 FOR NO KEY UPDATE",[person.id]);await reader.query("SET statement_timeout='1500ms'");const error=await resolvePrettyAuthorArchive("/author/"+person.nicename+"/",settings,reader).then(()=>null,error=>error);assert.equal(error?.status,409,String(error));}
   finally{await reader.query("RESET statement_timeout");reader.release();await control.query("ROLLBACK");control.release();}
  });
  await t.test("supplied read-only repeatable snapshot retains its original account after an actual lookup wait",async()=>{
   const person=fixtures.snapshot,settings=await getSettings(),control=await pool.connect(),reader=await pool.connect();let pending:ReturnType<typeof resolvePrettyAuthorArchive>|undefined;
   try{await pool.query("UPDATE worldact_pretty_independent_gate SET mode='snapshot'");await control.query("BEGIN");await control.query("SELECT pg_advisory_xact_lock(hashtext('worldact-pretty-independent-boundary'))");await reader.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");pending=resolvePrettyAuthorArchive("/author/"+person.nicename+"/",settings,reader);await held("FROM users WHERE nicename=$1");await pool.query("DELETE FROM worldact_pretty_independent_actual_users WHERE id=$1",[person.id]);await control.query("COMMIT");const result=await pending;assert.equal(result.archive?.authorId,person.id);assert.equal(result.archive?.slug,person.nicename);await reader.query("ROLLBACK");await pool.query("UPDATE worldact_pretty_independent_gate SET mode='off'");assert.equal((await resolvePrettyAuthorArchive("/author/"+person.nicename+"/",settings)).archive,null);}
   finally{await control.query("ROLLBACK");control.release();if(pending)await pending.catch(()=>{});await reader.query("ROLLBACK");reader.release();await pool.query("UPDATE worldact_pretty_independent_gate SET mode='off'");}
  });
 }finally{
  if(view){const db=await pool.connect();try{await db.query("BEGIN");await db.query("DROP VIEW users");await db.query("ALTER TABLE worldact_pretty_independent_actual_users RENAME TO users");await db.query("DROP FUNCTION worldact_pretty_independent_display(varchar)");await db.query("DROP TABLE worldact_pretty_independent_gate");await db.query("COMMIT");}catch(error){await db.query("ROLLBACK");throw error;}finally{db.release();}}
  if(documents.length)await pool.query("DELETE FROM site_documents WHERE id=ANY($1::int[])",[documents]);
  if(posts.length)await pool.query("DELETE FROM posts WHERE id=ANY($1::int[])",[posts]);if(people.length)await pool.query("DELETE FROM users WHERE id=ANY($1::int[])",[people]);await pool.query("UPDATE settings SET data=$1 WHERE id=1",[original]);
 }
});
