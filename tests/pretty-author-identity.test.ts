import test,{after} from "./isolated-test.js";
import assert from "node:assert/strict";
import {DOMParser} from "linkedom";
import {pool} from "../server/db.js";
after(()=>pool.end());
const base=process.env.TEST_API_URL!,origin=process.env.APP_ORIGIN!;
async function held(){const deadline=Date.now()+10000;while(Date.now()<deadline){if((await pool.query("SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event='advisory' AND left(ltrim(query),11)='SELECT p.id'")).rowCount)return;await new Promise(r=>setTimeout(r,10));}assert.fail("actual later site user projection did not wait");}
test("an empty pretty author cannot retire or switch identity during a later actual site projection wait",{timeout:90000},async t=>{
 const original=(await pool.query("SELECT data FROM settings WHERE id=1")).rows[0].data,people:number[]=[],posts:number[]=[],fixtures:any[]=[];let cookie="",view=false;
 async function api(path:string,method="GET",body?:unknown,publicRequest=false){const response=await fetch(base+path,{method,headers:{Origin:origin,Cookie:publicRequest?"":cookie,"Content-Type":"application/json"},body:body===undefined?undefined:JSON.stringify(body)}),text=await response.text();let data:any;try{data=JSON.parse(text);}catch{}return {response,text,data};}
 async function ok(path:string,method="GET",body?:unknown){const r=await api(path,method,body);assert.ok(r.response.ok,`${path} ${r.response.status} ${r.text}`);return r.data;}
 try{
  const login=await api("/api/auth/login","POST",{login:process.env.ADMIN_EMAIL,password:process.env.ADMIN_PASSWORD});assert.equal(login.response.status,200);cookie=login.response.headers.get("set-cookie")!.split(";")[0];
  await ok("/api/settings","PUT",{permalinkStructure:"/%postname%/",pingServices:[]});
  for(const surface of ["document","native"]){const stamp="empty-author-wait-"+surface+"-"+Date.now(),person=(await ok("/api/users","POST",{username:stamp,email:stamp+"@example.test",displayName:"PUBLIC-EMPTY-AUTHOR",role:"author",password:"Empty-author-fixture-password"})).user;people.push(person.id);fixtures.push({surface,...person,slug:(await pool.query("SELECT nicename FROM users WHERE id=$1",[person.id])).rows[0].nicename});}
  posts.push((await ok("/api/posts","POST",{title:"Empty author wait public page",slug:"empty-author-wait-public-page",type:"page",status:"publish",content:"<p>PUBLIC-SITE-PAGE.</p>"})).post.id);
  const columns=(await pool.query("SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name='users' ORDER BY ordinal_position")).rows.map(r=>r.column_name);
  const setup=await pool.connect();try{await setup.query("BEGIN");await setup.query("CREATE SEQUENCE worldact_pretty_author_calls");await setup.query(`CREATE FUNCTION worldact_pretty_author_display(value varchar) RETURNS varchar LANGUAGE plpgsql STABLE AS $$ DECLARE call bigint; BEGIN IF position('FROM posts p JOIN users u' in current_query())>0 THEN SELECT nextval('worldact_pretty_author_calls') INTO call; IF call=1 THEN PERFORM pg_advisory_xact_lock(hashtext('worldact-pretty-author-wait')); END IF; END IF; RETURN value; END $$`);await setup.query("ALTER TABLE users RENAME TO worldact_pretty_actual_users");await setup.query('CREATE VIEW users AS SELECT '+columns.map(c=>c==='display_name'?'worldact_pretty_author_display(display_name) AS display_name':'"'+c+'"').join(',')+' FROM worldact_pretty_actual_users');await setup.query("COMMIT");view=true;}catch(e){await setup.query("ROLLBACK");throw e;}finally{setup.release();}
  for(const person of fixtures)await t.test(person.surface+" response keeps one current author identity or bounded rejection after retirement",async()=>{
   await pool.query("ALTER SEQUENCE worldact_pretty_author_calls RESTART WITH 1");const control=await pool.connect();let pending:ReturnType<typeof api>|undefined;
   try{await control.query("BEGIN");await control.query("SELECT pg_advisory_xact_lock(hashtext('worldact-pretty-author-wait'))");const path="/author/"+person.slug+"/";pending=api(person.surface==="document"?"/api/public/document?"+new URLSearchParams({path}):path,"GET",undefined,true);await held();assert.equal(Number((await pool.query("SELECT last_value FROM worldact_pretty_author_calls")).rows[0].last_value),1);
    await pool.query("DELETE FROM worldact_pretty_actual_users WHERE id=$1",[person.id]);const replacement=(await pool.query("INSERT INTO worldact_pretty_actual_users(username,email,display_name,password_hash,role,nicename) VALUES($1,$2,'PUBLIC-REPLACEMENT-AUTHOR','inert-fixture-hash','author',$3) RETURNING id",[person.username+"-replacement",person.id+"-replacement@example.test",person.slug])).rows[0];people.push(replacement.id);
    await control.query("COMMIT");const result=await pending;let model=result.data;if(person.surface==="native" && result.response.status===200)model=JSON.parse(new DOMParser().parseFromString(result.text,"text/html").querySelector("#worldact-public-document")!.textContent!);
    const fresh=result.response.status===200 && model.route.archive?.authorId===replacement.id && model.site.archive?.authorId===replacement.id && model.route.query.author===replacement.id;
    assert.ok([404,409].includes(result.response.status)||fresh,JSON.stringify({status:result.response.status,route:model?.route?.archive,site:model?.site?.archive,query:model?.route?.query?.author,replacement:replacement.id}));
   }finally{await control.query("ROLLBACK");control.release();if(pending)await pending.catch(()=>{});}
  });
 }finally{
  if(view){const db=await pool.connect();try{await db.query("BEGIN");await db.query("DROP VIEW users");await db.query("ALTER TABLE worldact_pretty_actual_users RENAME TO users");await db.query("DROP FUNCTION worldact_pretty_author_display(varchar)");await db.query("DROP SEQUENCE worldact_pretty_author_calls");await db.query("COMMIT");}catch(e){await db.query("ROLLBACK");throw e;}finally{db.release();}}
  if(posts.length)await pool.query("DELETE FROM posts WHERE id=ANY($1::int[])",[posts]);if(people.length)await pool.query("DELETE FROM users WHERE id=ANY($1::int[])",[people]);await pool.query("UPDATE settings SET data=$1 WHERE id=1",[original]);
 }
});
