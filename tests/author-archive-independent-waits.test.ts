import test,{after} from './isolated-test.js';
import assert from 'node:assert/strict';
import {DOMParser} from 'linkedom';
import {pool} from '../server/db.js';
import {hashPassword} from '../server/auth.js';
const base=process.env.TEST_API_URL!,origin=process.env.APP_ORIGIN!;
after(()=>pool.end());
const secret='INDEPENDENT-ARCHIVE-SECRET-BODY';
async function waitFor(sql:string){for(let i=0;i<500;i++){if((await pool.query(sql)).rows[0].ok)return;await new Promise(r=>setTimeout(r,15));}assert.fail('bounded actual archive wait/finished-body observation absent');}
test('independent home/archive callers retire earlier post after a different post author wait',{timeout:120000},async t=>{
 const settings=(await pool.query('SELECT data FROM settings WHERE id=1')).rows[0].data;
 const oldPosts=(await pool.query('SELECT id,status FROM posts')).rows;
 const reading=(await pool.query("SELECT enabled,settings FROM extensions WHERE slug='reading-time'")).rows[0];
 const people:number[]=[],posts:number[]=[];let views=false,serial=0;
 async function api(path:string,method='GET',body?:unknown,cookie=''){const response=await fetch(base+path,{method,headers:{Origin:origin,'Content-Type':'application/json',...(cookie?{Cookie:cookie}:{})},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(20000)});return {response,text:await response.text()};}
 try{
  await pool.query("UPDATE posts SET status='draft'");await pool.query("INSERT INTO extensions(slug,enabled,settings) VALUES('reading-time',true,'{}') ON CONFLICT(slug) DO UPDATE SET enabled=true");assert.equal((await pool.query("SELECT count(*)::int AS n FROM extensions WHERE slug='reading-time' AND enabled")).rows[0].n,1);
  for(const name of ['independent_archive_a','independent_archive_b'])people.push((await pool.query("INSERT INTO users(username,email,display_name,password_hash,role,nicename) VALUES($1,$2,$1,'inert-test-password','author',$1) RETURNING id",[name,name+'@example.test'])).rows[0].id);
  const users=(await pool.query("SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name='users' ORDER BY ordinal_position")).rows.map(r=>r.column_name);
  const extensions=(await pool.query("SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name='extensions' ORDER BY ordinal_position")).rows.map(r=>r.column_name);
  const setup=await pool.connect();try{await setup.query('BEGIN');await setup.query('CREATE SEQUENCE worldact_archive_body_finished');await setup.query('CREATE TABLE worldact_archive_gate(enabled boolean NOT NULL)');await setup.query('INSERT INTO worldact_archive_gate VALUES(false)');
   await setup.query(`CREATE FUNCTION worldact_archive_nicename(value varchar) RETURNS varchar LANGUAGE plpgsql STABLE AS $$ BEGIN IF value='independent_archive_b' AND (SELECT enabled FROM worldact_archive_gate) THEN PERFORM pg_advisory_xact_lock(hashtext('worldact-independent-archive-wait')); END IF; RETURN value; END $$`);
   await setup.query(`CREATE FUNCTION worldact_archive_extension(name varchar,value jsonb) RETURNS jsonb LANGUAGE plpgsql STABLE AS $$ BEGIN IF name='reading-time' AND current_query()='SELECT settings FROM extensions WHERE slug=$1 AND enabled=true' THEN PERFORM nextval('worldact_archive_body_finished'); END IF; RETURN value; END $$`);
   await setup.query('ALTER TABLE users RENAME TO worldact_archive_actual_users');await setup.query('CREATE VIEW users AS SELECT '+users.map(c=>c==='nicename'?'worldact_archive_nicename(nicename) AS nicename':'"'+c+'"').join(',')+' FROM worldact_archive_actual_users');
   await setup.query('ALTER TABLE extensions RENAME TO worldact_archive_actual_extensions');await setup.query('CREATE VIEW extensions AS SELECT '+extensions.map(c=>c==='settings'?'worldact_archive_extension(slug,settings) AS settings':'"'+c+'"').join(',')+' FROM worldact_archive_actual_extensions');await setup.query('COMMIT');views=true;
  }catch(e){await setup.query('ROLLBACK');throw e;}finally{setup.release();}
  for(const theme of ['classic','twentytwentyfive'])for(const surface of ['legacy','model','html'])for(const mutation of ['expire','private'])await t.test(theme+' '+surface+' earlier post '+mutation+' during different post author expression',async()=>{
   await pool.query('UPDATE worldact_archive_gate SET enabled=false');await pool.query("UPDATE settings SET data=data || $1::jsonb WHERE id=1",[JSON.stringify({theme,permalinkStructure:'/%author%/%post_id%/%postname%/',postsPerPage:2,pingServices:[],frontPageMode:'posts',frontPageId:null,postsPageId:null,showAvatars:false})]);
   const own:number[]=[];const number=++serial;
   async function make(author:number,label:string,password=false){const content='<p>'+secret+'</p>',post=(await pool.query("INSERT INTO posts(type,title,slug,content,raw_content,excerpt,status,author_id,password_hash,published_at,sticky,post_date,post_date_gmt) VALUES('post',$1,$1,$2,$2,$3,'publish',$4,$5,clock_timestamp()+interval '1 day',true,to_char(CASE WHEN coalesce((SELECT data->>'timezone' FROM settings WHERE id=1),'America/Los_Angeles')~'^[+-]' THEN timezone(coalesce((SELECT data->>'timezone' FROM settings WHERE id=1),'America/Los_Angeles')::interval,coalesce(CASE WHEN 'publish'='future' THEN NULL::timestamptz END,(clock_timestamp()+interval '1 day')::timestamptz,NULL::timestamptz,clock_timestamp())) ELSE timezone(coalesce((SELECT data->>'timezone' FROM settings WHERE id=1),'America/Los_Angeles'),coalesce(CASE WHEN 'publish'='future' THEN NULL::timestamptz END,(clock_timestamp()+interval '1 day')::timestamptz,NULL::timestamptz,clock_timestamp())) END,'YYYY-MM-DD\"T\"HH24:MI:SS'),coalesce(CASE WHEN 'publish'='future' THEN NULL::timestamptz END,(clock_timestamp()+interval '1 day')::timestamptz,NULL::timestamptz,clock_timestamp())) RETURNING id,slug",['archive-'+number+'-'+label,label==='a'?content:'<p>Public sibling body</p>',label==='a'?secret:'Public sibling excerpt',author,password?await hashPassword('Archive-wait-password'):null])).rows[0];own.push(post.id);posts.push(post.id);return post;}
   const a=await make(people[0],'a',mutation==='expire'),b=await make(people[1],'b');let cookie='';if(mutation==='expire'){const unlock=await api('/api/public/posts/'+a.slug+'/unlock','POST',{password:'Archive-wait-password'});assert.equal(unlock.response.status,200,unlock.text);cookie=unlock.response.headers.get('set-cookie')!.split(';')[0];}
   const path=surface==='legacy'?'/api/public/site':surface==='model'?'/api/public/document?'+new URLSearchParams({path:'/'}):'/';
   const before=await api(path,'GET',undefined,cookie);assert.equal(before.response.status,200,before.text);assert.ok(before.text.includes(secret),'fixture must actually expose the granted earlier archive post before revocation');
   const control=await pool.connect();let pending:ReturnType<typeof api>|undefined;
   try{await pool.query('ALTER SEQUENCE worldact_archive_body_finished RESTART WITH 1');await pool.query('UPDATE worldact_archive_gate SET enabled=true');await control.query('BEGIN');await control.query("SELECT pg_advisory_xact_lock(hashtext('worldact-independent-archive-wait'))");pending=api(path,'GET',undefined,cookie);
    await waitFor("SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event='advisory' AND position('SELECT u.nicename FROM posts p JOIN users u' in query)>0) AS ok");
    // Only A can reach enhancePublicPost while B's author expression waits.
    // Its reading-time query occurs after its complete content was rendered and
    // after all local publicPost grant/metadata checks, giving a DB-observed
    // completion marker rather than a sleep-based assumption.
    await waitFor('SELECT is_called AS ok FROM worldact_archive_body_finished');
    if(mutation==='expire')await pool.query("UPDATE post_access_tokens SET expires_at=clock_timestamp()-interval '1 second' WHERE post_id=$1",[a.id]);else await pool.query("UPDATE posts SET status='private' WHERE id=$1",[a.id]);
    await control.query('COMMIT');const result=await pending;
    let model:any;try{model=surface==='html'?JSON.parse(new DOMParser().parseFromString(result.text,'text/html').querySelector('#worldact-public-document')!.textContent!):JSON.parse(result.text);}catch{}
    const post=(surface==='legacy'?model?.posts:model?.site?.posts)?.find((item:any)=>item.id===a.id);
    console.log('INDEPENDENT_ARCHIVE_OBSERVATION',JSON.stringify({theme,surface,mutation,status:result.response.status,secretPresent:result.text.includes(secret),oldPostPresent:Boolean(post),oldLocked:post?.locked,selected:model?.post?.id ?? null}));
    assert.equal(result.text.includes(secret),false,'retired/grant-invalid earlier archive body must not be emitted after later different-post author wait');
   }finally{await control.query('ROLLBACK');control.release();if(pending)await pending.catch(()=>{});await pool.query('UPDATE worldact_archive_gate SET enabled=false');await pool.query('DELETE FROM posts WHERE id=ANY($1::int[])',[own]);}
  });
 }finally{
  if(views){const restore=await pool.connect();try{await restore.query('BEGIN');await restore.query('DROP VIEW users');await restore.query('ALTER TABLE worldact_archive_actual_users RENAME TO users');await restore.query('DROP VIEW extensions');await restore.query('ALTER TABLE worldact_archive_actual_extensions RENAME TO extensions');await restore.query('DROP FUNCTION worldact_archive_nicename(varchar)');await restore.query('DROP FUNCTION worldact_archive_extension(varchar,jsonb)');await restore.query('DROP TABLE worldact_archive_gate');await restore.query('DROP SEQUENCE worldact_archive_body_finished');await restore.query('COMMIT');}catch(e){await restore.query('ROLLBACK');throw e;}finally{restore.release();}}
  await pool.query('UPDATE settings SET data=$1 WHERE id=1',[settings]);if(reading)await pool.query("UPDATE extensions SET enabled=$1,settings=$2 WHERE slug='reading-time'",[reading.enabled,reading.settings]);else await pool.query("DELETE FROM extensions WHERE slug='reading-time'");
  if(posts.length)await pool.query('DELETE FROM posts WHERE id=ANY($1::int[])',[posts]);if(people.length)await pool.query('DELETE FROM users WHERE id=ANY($1::int[])',[people]);for(const post of oldPosts)await pool.query('UPDATE posts SET status=$2 WHERE id=$1',[post.id,post.status]);
 }
});
