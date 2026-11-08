import test, { after } from "./isolated-test.js";
import assert from "node:assert/strict";
import { DOMParser } from "linkedom";
import { pool } from "../server/db.js";
import { hashPassword } from "../server/auth.js";
import { currentPublicPostPolicy, postAccessReader } from "../server/post-passwords.js";
import { fixtureUserNicename } from "./helpers/user-fixtures.js";

const base=process.env.TEST_API_URL!,origin=process.env.APP_ORIGIN!;
after(()=>pool.end());
const parse=(html:string)=>new DOMParser().parseFromString(html,"text/html");
const secret=/LATE-AUTHOR-SECRET-(FIRST|SECOND|COMMENT|EXCERPT)|LATE-AUTHOR-PRIVATE@example/;
const template='<!-- wp:post-content /--><!-- wp:post-title {"isLink":true} /--><!-- wp:comments --><div class="wp-block-comments"><!-- wp:comment-template --><!-- wp:comment-content /--><!-- /wp:comment-template --><!-- wp:post-comments-form /--></div><!-- /wp:comments -->';

test("complete source/Classic documents discard precomputed bodies across late author expression waits",{timeout:180000},async t=>{
  const initial=(await pool.query("SELECT data FROM settings WHERE id=1")).rows[0].data;
  const author=(await pool.query("SELECT id FROM users WHERE role='administrator' ORDER BY id LIMIT 1")).rows[0].id;
  const documents=(await pool.query("SELECT id,theme,content,raw_content,blocks FROM site_documents WHERE slug='single' AND type='template' AND theme=ANY($1::text[])",[["twentytwentyfive","classic"]])).rows;
  const ids:number[]=[],people:number[]=[],createdDocuments:number[]=[];let view=false,serial=0;
  async function api(path:string,method="GET",body?:unknown,cookie=""){const response=await fetch(base+path,{method,signal:AbortSignal.timeout(20000),headers:{Origin:origin,"Content-Type":"application/json",...(cookie?{Cookie:cookie}:{})},body:body===undefined?undefined:JSON.stringify(body)});return{response,text:await response.text()};}
  async function make(password=true){
    const slug="late-author-"+(++serial),content='<p>LATE-AUTHOR-SECRET-FIRST</p><!--nextpage--><p>LATE-AUTHOR-SECRET-SECOND</p>';
    const post=(await pool.query("INSERT INTO posts(type,title,slug,content,raw_content,excerpt,status,author_id,password_hash,published_at,sticky,comment_status,post_date,post_date_gmt) VALUES('post',$1,$1,$2,$2,'LATE-AUTHOR-SECRET-EXCERPT','publish',$3,$4,clock_timestamp()+interval '1 day',true,'open',to_char(CASE WHEN coalesce((SELECT data->>'timezone' FROM settings WHERE id=1),'America/Los_Angeles')~'^[+-]' THEN timezone(coalesce((SELECT data->>'timezone' FROM settings WHERE id=1),'America/Los_Angeles')::interval,coalesce(CASE WHEN 'publish'='future' THEN NULL::timestamptz END,clock_timestamp()+interval '1 day'::timestamptz,NULL::timestamptz,now())) ELSE timezone(coalesce((SELECT data->>'timezone' FROM settings WHERE id=1),'America/Los_Angeles'),coalesce(CASE WHEN 'publish'='future' THEN NULL::timestamptz END,clock_timestamp()+interval '1 day'::timestamptz,NULL::timestamptz,now())) END,'YYYY-MM-DD\"T\"HH24:MI:SS'),coalesce(CASE WHEN 'publish'='future' THEN NULL::timestamptz END,clock_timestamp()+interval '1 day'::timestamptz,NULL::timestamptz,now())) RETURNING id,slug",[slug,content,author,password?await hashPassword('Late-author-password'):null])).rows[0];ids.push(post.id);
    const parent=(await pool.query("INSERT INTO comments(post_id,author_name,author_email,content,status) VALUES($1,'Late parent','LATE-AUTHOR-PRIVATE@example.test','LATE-AUTHOR-SECRET-COMMENT','approved') RETURNING id",[post.id])).rows[0].id;
    let cookie="";if(password){const unlock=await api('/api/public/posts/'+slug+'/unlock','POST',{password:'Late-author-password'});assert.equal(unlock.response.status,200,unlock.text);cookie=unlock.response.headers.get('set-cookie')!.split(';')[0];}
    return{...post,parent,cookie,path:`/?p=${post.id}&page=2&query-4-page=3&commentPage=1&replytocom=${parent}`};
  }
  async function gate(calls:number[]){await pool.query("ALTER SEQUENCE worldact_late_author_calls RESTART WITH 1");await pool.query("UPDATE worldact_late_author_gate SET calls=$1",[calls]);const controls=[];for(const call of calls){const control=await pool.connect();await control.query('BEGIN');await control.query("SELECT pg_advisory_xact_lock(hashtext($1))",['worldact-late-author-'+call]);controls.push(control);}return controls;}
  async function observed(call:number){const until=Date.now()+10000;while(Date.now()<until){const row=await pool.query("SELECT 1 FROM pg_stat_activity a JOIN pg_locks l ON l.pid=a.pid WHERE a.datname=current_database() AND a.wait_event='advisory' AND position('SELECT u.nicename FROM posts p JOIN users u' in a.query)>0 AND l.locktype='advisory' AND NOT l.granted AND l.objid=(hashtext($1)::bigint&4294967295)::oid",['worldact-late-author-'+call]);if(row.rowCount)return;await new Promise(resolve=>setTimeout(resolve,15));}assert.fail('Missing exact late expression wait '+call);}
  async function measuredLast(post:any,surface:string){
    await pool.query("UPDATE worldact_late_author_gate SET calls='{}'");await pool.query("ALTER SEQUENCE worldact_late_author_calls RESTART WITH 1");
    const baseline=await api(surface==='model'?'/api/public/document?'+new URLSearchParams({path:post.path}):post.path,'GET',undefined,post.cookie);assert.equal(baseline.response.status,200);
    const model=surface==='model'?JSON.parse(baseline.text):JSON.parse(parse(baseline.text).querySelector('#worldact-public-document')!.textContent!);if(model.presentation.kind==='classic')assert.ok(model.presentation.slots.single,'the owned custom Classic single slot must actually render');
    const calls=Number((await pool.query('SELECT last_value FROM worldact_late_author_calls')).rows[0].last_value);assert.ok(calls>=4,'selected body, secondary site and custom template all executed');return calls;
  }
  async function mutate(kind:string,id:number){if(kind==='expire')await pool.query("UPDATE post_access_tokens SET expires_at=clock_timestamp()-interval '1 second' WHERE post_id=$1",[id]);else if(kind==='rotate'||kind==='add')await pool.query('UPDATE posts SET password_hash=$2 WHERE id=$1',[id,await hashPassword('Changed-late-author-password')]);else if(kind==='remove')await pool.query('UPDATE posts SET password_hash=NULL WHERE id=$1',[id]);else await pool.query(`UPDATE posts SET ${kind==='private'?"status='private'":"type='page'"} WHERE id=$1`,[id]);}
  try{
    await pool.query("UPDATE settings SET data=data || $1::jsonb WHERE id=1",[JSON.stringify({permalinkStructure:'/%author%/%post_id%/%postname%/',postsPerPage:1,pingServices:[],frontPageMode:'posts',frontPageId:null,postsPageId:null,threadComments:true,threadDepth:3,closeCommentsDays:0,commentRegistration:false,paginateComments:false,showAvatars:false})]);
    for(const document of documents)await pool.query('UPDATE site_documents SET content=$2,raw_content=$2,blocks=\'[]\'::jsonb WHERE id=$1',[document.id,template]);
    for(const theme of ['twentytwentyfive','classic'])if(!documents.some(document=>document.theme===theme)){
      const row=(await pool.query("INSERT INTO site_documents(slug,title,type,theme,content,raw_content,blocks) VALUES('single','Late author template','template',$1,$2,$2,'[]') RETURNING id",[theme,template])).rows[0];createdDocuments.push(row.id);
    }
    const columns=(await pool.query("SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name='users' ORDER BY ordinal_position")).rows.map(row=>row.column_name);
    const setup=await pool.connect();try{await setup.query('BEGIN');await setup.query('CREATE SEQUENCE worldact_late_author_calls');await setup.query('CREATE TABLE worldact_late_author_gate(calls int[] NOT NULL)');await setup.query("INSERT INTO worldact_late_author_gate VALUES('{}')");
      await setup.query(`CREATE FUNCTION worldact_late_author_name(value varchar) RETURNS varchar LANGUAGE plpgsql STABLE AS $$ DECLARE call bigint; gate int[]; BEGIN SELECT nextval('worldact_late_author_calls') INTO call; SELECT calls INTO gate FROM worldact_late_author_gate; IF call=ANY(gate) THEN PERFORM pg_advisory_xact_lock(hashtext('worldact-late-author-'||call)); END IF; RETURN value; END $$`);
      await setup.query('ALTER TABLE users RENAME TO worldact_late_actual_users');await setup.query('CREATE VIEW users AS SELECT '+columns.map(column=>column==='nicename'?'worldact_late_author_name(nicename) AS nicename':'"'+column+'"').join(',')+' FROM worldact_late_actual_users');await setup.query('COMMIT');view=true;
    }catch(error){await setup.query('ROLLBACK');throw error;}finally{setup.release();}
    for(const theme of ['twentytwentyfive','classic']){
      await pool.query("UPDATE settings SET data=data || $1::jsonb WHERE id=1",[JSON.stringify({theme})]);
      for(const surface of ['model','html'])for(const kind of ['expire','rotate','add','private','type'])await t.test(`${theme} ${surface}: ${kind} at template author read after selected body and archive`,async()=>{
        const post=await make(kind!=='add'),last=await measuredLast(post,surface),controls=await gate([last]);let pending:ReturnType<typeof api>|undefined;
        try{pending=api(surface==='model'?'/api/public/document?'+new URLSearchParams({path:post.path}):post.path,'GET',undefined,post.cookie);await observed(last);await mutate(kind,post.id);await controls[0].query('COMMIT');const result=await pending;
          const missing=['private','type'].includes(kind);assert.equal(result.response.status,missing?404:200,result.text);assert.doesNotMatch(result.text,secret);
          const document=surface==='html'?parse(result.text):null,model=surface==='model'?JSON.parse(result.text):JSON.parse(document!.querySelector('#worldact-public-document')!.textContent!);
          if(missing){assert.equal(model.post,null);assert.deepEqual(model.comments,[]);assert.equal(model.route.kind,'not-found');}
          else{assert.equal(model.post.locked,true);assert.equal(model.post.hasPassword,true);assert.deepEqual(model.comments,[]);assert.equal(model.controls.replyParentId,0);assert.equal(model.controls.commentsOpen,false);assert.equal(model.route.query.contentPage,2);assert.equal(model.route.query.blockPages['query-4-page'],3);if(theme==='classic')assert.equal(model.presentation.slots.single,undefined);else assert.match(model.presentation.html,/action="\/post-password"/);if(document)assert.ok(document.querySelector('form[action="/post-password"]'));}
        }finally{for(const control of controls){await control.query('ROLLBACK');control.release();}if(pending)await pending.catch(()=>{});}
      });
      await t.test(theme+' unchanged current grant retains selected second body and fresh eligible Reply',async()=>{
        const post=await make(),last=await measuredLast(post,'html'),controls=await gate([last]);let pending:ReturnType<typeof api>|undefined;
        try{pending=api(post.path,'GET',undefined,post.cookie);await observed(last);await controls[0].query('COMMIT');const result=await pending;assert.equal(result.response.status,200,result.text);const document=parse(result.text),model=JSON.parse(document.querySelector('#worldact-public-document')!.textContent!);assert.equal(model.post.locked,false);assert.equal(model.controls.replyParentId,post.parent);assert.ok(model.comments.some((comment:any)=>comment.id===post.parent));assert.match(document.querySelector('#root')!.textContent!,/LATE-AUTHOR-SECRET-SECOND/);assert.doesNotMatch(result.text,/LATE-AUTHOR-SECRET-FIRST|LATE-AUTHOR-PRIVATE@example/);const form=document.querySelector('form[action="/wp-comments-post.php"]')!;assert.ok(form);assert.equal(form.querySelector('[name="parentId"],[name="comment_parent"]')!.getAttribute('value'),String(post.parent));}
        finally{for(const control of controls){await control.query('ROLLBACK');control.release();}if(pending)await pending.catch(()=>{});}
      });
    }
    await t.test('second policy change during bounded rebuilt source template fails before output',async()=>{
      await pool.query("UPDATE settings SET data=data || '{\"theme\":\"twentytwentyfive\"}' WHERE id=1");
      const post=await make(),firstLast=await measuredLast(post,'html');
      // Calibrate the finite retry's LAST expression from a real stable locked
      // result, instead of guessing an index that might still be body loading.
      const calibration=await gate([firstLast]);let pendingCalibration:ReturnType<typeof api>|undefined;
      let secondLast:number;
      try{pendingCalibration=api(post.path,'GET',undefined,post.cookie);await observed(firstLast);await mutate('expire',post.id);await calibration[0].query('COMMIT');const result=await pendingCalibration;assert.equal(result.response.status,200);const model=JSON.parse(parse(result.text).querySelector('#worldact-public-document')!.textContent!);assert.equal(model.post.locked,true);secondLast=Number((await pool.query('SELECT last_value FROM worldact_late_author_calls')).rows[0].last_value);assert.ok(secondLast>firstLast);}
      finally{for(const control of calibration){await control.query('ROLLBACK');control.release();}if(pendingCalibration)await pendingCalibration.catch(()=>{});}
      await pool.query("UPDATE post_access_tokens SET expires_at=clock_timestamp()+interval '1 day' WHERE post_id=$1",[post.id]);
      const controls=await gate([firstLast,secondLast!]);let pending:ReturnType<typeof api>|undefined;
      try{pending=api(post.path,'GET',undefined,post.cookie);await observed(firstLast);await mutate('expire',post.id);await controls[0].query('COMMIT');await observed(secondLast!);await mutate('remove',post.id);await controls[1].query('COMMIT');const result=await pending;assert.equal(result.response.status,409);assert.doesNotMatch(result.text,secret);assert.doesNotMatch(result.text,/#worldact-public-document|<html/);}
      finally{for(const control of controls){await control.query('ROLLBACK');control.release();}if(pending)await pending.catch(()=>{});}
    });
    await t.test('actual native HTTP return rejects private/type/owner changes after comment commit at its expression wait',async()=>{
      await pool.query("UPDATE worldact_late_author_gate SET calls='{}'");
      const signed=await api('/api/auth/login','POST',{login:process.env.ADMIN_EMAIL,password:process.env.ADMIN_PASSWORD});assert.equal(signed.response.status,200);const session=signed.response.headers.get('set-cookie')!.split(';')[0];
      const username='late-native-other-author',other=(await pool.query("INSERT INTO worldact_late_actual_users(username,email,display_name,password_hash,role,nicename) VALUES($1,$2,'Other author','inert-test-password','author',$3) RETURNING id",[username,username+'@example.test',fixtureUserNicename(username)])).rows[0].id;people.push(other);
      async function native(post:any){const body=new URLSearchParams({postId:String(post.id),parentId:String(post.parent),content:'Late native reply '+post.id,redirect_to:post.path});const response=await fetch(base+'/wp-comments-post.php',{method:'POST',redirect:'manual',signal:AbortSignal.timeout(20000),headers:{Origin:origin,Cookie:session},body});return{response,text:await response.text()};}
      const calibration=await make(false);await pool.query('ALTER SEQUENCE worldact_late_author_calls RESTART WITH 1');const saved=await native(calibration);assert.equal(saved.response.status,303,saved.text);const last=Number((await pool.query('SELECT last_value FROM worldact_late_author_calls')).rows[0].last_value);assert.ok(last>=2);const returned=new URL(saved.response.headers.get('location')!,origin);assert.equal(returned.searchParams.get('page'),'2');assert.equal(returned.searchParams.get('query-4-page'),'3');assert.match(returned.hash,/^#comment-/);
      for(const kind of ['private','type','owner']){
        const post=await make(false),controls=await gate([last]);let pending:ReturnType<typeof native>|undefined;
        try{pending=native(post);await observed(last);
          // NOWAIT proves the admission transaction released its post row: this
          // is the later native return expression, not a pre-insert helper wait.
          await controls[0].query('SELECT id FROM posts WHERE id=$1 FOR UPDATE NOWAIT',[post.id]);
          if(kind==='owner')await controls[0].query('UPDATE posts SET author_id=$2 WHERE id=$1',[post.id,other]);
          else await controls[0].query(`UPDATE posts SET ${kind==='private'?"status='private'":"type='page'"} WHERE id=$1`,[post.id]);
          await controls[0].query('COMMIT');const result=await pending;assert.equal(result.response.status,404,result.text);assert.equal(result.response.headers.get('location'),null);assert.doesNotMatch(result.text,secret);
          assert.equal((await pool.query("SELECT count(*)::int AS n FROM comments WHERE post_id=$1 AND content LIKE 'Late native reply%'",[post.id])).rows[0].n,1,'the admitted native reply committed before continuation was rejected');
        }finally{for(const control of controls){await control.query('ROLLBACK');control.release();}if(pending)await pending.catch(()=>{});}
      }
      await api('/api/auth/logout','POST',undefined,session);
    });
    await t.test('final request policy uses the supplied transaction and keeps hashes server-only',async()=>{
      await pool.query("UPDATE worldact_late_author_gate SET calls='{}'");const post=await make(false),reader=postAccessReader({headers:{}}),client=await pool.connect();try{await client.query('BEGIN');await client.query('UPDATE posts SET password_hash=$2 WHERE id=$1',[post.id,await hashPassword('Transaction-policy-password')]);assert.deepEqual(await currentPublicPostPolicy(post.id,'post',reader,client),{hasPassword:true,locked:true});assert.deepEqual(await currentPublicPostPolicy(post.id,'post',reader),{hasPassword:false,locked:false});await client.query("UPDATE posts SET status='private' WHERE id=$1",[post.id]);assert.equal(await currentPublicPostPolicy(post.id,'post',reader,client),null);}finally{await client.query('ROLLBACK');client.release();}
    });
  }finally{
    if(view){const restore=await pool.connect();try{await restore.query('BEGIN');await restore.query('DROP VIEW users');await restore.query('ALTER TABLE worldact_late_actual_users RENAME TO users');await restore.query('DROP FUNCTION worldact_late_author_name(varchar)');await restore.query('DROP TABLE worldact_late_author_gate');await restore.query('DROP SEQUENCE worldact_late_author_calls');await restore.query('COMMIT');}catch(error){await restore.query('ROLLBACK');throw error;}finally{restore.release();}}
    for(const document of documents)await pool.query('UPDATE site_documents SET content=$2,raw_content=$3,blocks=$4 WHERE id=$1',[document.id,document.content,document.raw_content,JSON.stringify(document.blocks)]);
    if(createdDocuments.length)await pool.query('DELETE FROM site_documents WHERE id=ANY($1::int[])',[createdDocuments]);
    await pool.query('UPDATE settings SET data=$1 WHERE id=1',[initial]);if(ids.length)await pool.query('DELETE FROM posts WHERE id=ANY($1::int[])',[ids]);if(people.length)await pool.query('DELETE FROM users WHERE id=ANY($1::int[])',[people]);
  }
});
