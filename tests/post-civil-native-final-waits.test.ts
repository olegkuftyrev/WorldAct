import test,{after} from "./isolated-test.js";
import assert from "node:assert/strict";
import {pool} from "../server/db.js";
import {nativePostReturn} from "../server/native-post-return.js";
const base=process.env.TEST_API_URL!,origin=process.env.APP_ORIGIN!;
after(()=>pool.end());
async function held(observed?:()=>any){for(let i=0;i<400;i++){const r=await pool.query("SELECT query FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid() AND wait_event='advisory' AND position('WITH RECURSIVE ancestry' in query)>0");if(r.rowCount)return;await new Promise(r=>setTimeout(r,15));}assert.fail('actual native comment-page expression did not block '+JSON.stringify(observed?.()));}

test('independent native continuation checks current civil after final chronological comment-page waits',{timeout:120000},async t=>{
 const old=(await pool.query('SELECT data FROM settings WHERE id=1')).rows[0].data;
 const author=(await pool.query("SELECT id FROM users WHERE role='administrator' ORDER BY id LIMIT 1")).rows[0].id;
 const ids:number[]=[];let view=false;
 async function make(label:string){const p=(await pool.query("INSERT INTO posts(type,title,slug,content,raw_content,status,author_id,published_at,comment_status,post_date,post_date_gmt) VALUES('post',$1,$2,'<p>CIVIL-NATIVE-FINAL-WAIT</p>','<p>CIVIL-NATIVE-FINAL-WAIT</p>','publish',$3,'2001-02-03T04:05:06Z','open','2001-02-03T04:05:06','2001-02-03T04:05:06Z') RETURNING id,slug,type",['Civil native final '+label,'civil-native-final-'+label,author])).rows[0];ids.push(p.id);return p;}
 const service=await make('service'),http=await make('http');
 const comment=(await pool.query("INSERT INTO comments(post_id,author_name,author_email,content,status) VALUES($1,'Civil final','civil-service@example.test','Civil native service','approved') RETURNING id",[service.id])).rows[0];
 async function gate(){await pool.query('ALTER SEQUENCE worldact_civil_native_calls RESTART WITH 1');const c=await pool.connect();await c.query('BEGIN');await c.query("SELECT pg_advisory_xact_lock(hashtext('worldact-civil-native-final-wait'))");return c;}
 try{
 await pool.query("UPDATE settings SET data=data || $1::jsonb WHERE id=1",[JSON.stringify({permalinkStructure:'/%year%/%monthnum%/%day%/%hour%/%minute%/%second%/%post_id%/',timezone:'UTC',pingServices:[],paginateComments:true,commentsPerPage:1,closeCommentsDays:0,requireCommentNameEmail:true,commentRegistration:false,commentModeration:false,previousCommentApproval:false})]);
 const cols=(await pool.query("SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name='comments' ORDER BY ordinal_position")).rows.map(r=>r.column_name);
 const setup=await pool.connect();try{await setup.query('BEGIN');await setup.query('CREATE SEQUENCE worldact_civil_native_calls');await setup.query(`CREATE FUNCTION worldact_civil_native_date(value timestamptz) RETURNS timestamptz LANGUAGE plpgsql STABLE AS $$ DECLARE call bigint; BEGIN IF position('WITH RECURSIVE ancestry' in current_query())>0 THEN SELECT nextval('worldact_civil_native_calls') INTO call; IF call=1 THEN PERFORM pg_advisory_xact_lock(hashtext('worldact-civil-native-final-wait')); END IF; END IF; RETURN value; END $$`);await setup.query('ALTER TABLE comments RENAME TO worldact_civil_native_actual_comments');await setup.query('CREATE VIEW comments AS SELECT '+cols.map(c=>c==='created_at'?'worldact_civil_native_date(created_at) AS created_at':'"'+c+'"').join(',')+' FROM worldact_civil_native_actual_comments');await setup.query(`CREATE FUNCTION worldact_civil_native_insert() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN INSERT INTO worldact_civil_native_actual_comments(post_id,author_name,author_email,content,status,parent_id,author_url,user_id,created_at,updated_at) VALUES(NEW.post_id,NEW.author_name,NEW.author_email,NEW.content,NEW.status,NEW.parent_id,NEW.author_url,NEW.user_id,NEW.created_at,NEW.updated_at) RETURNING * INTO NEW; RETURN NEW; END $$`);await setup.query('CREATE TRIGGER worldact_civil_native_insert INSTEAD OF INSERT ON comments FOR EACH ROW EXECUTE FUNCTION worldact_civil_native_insert()');await setup.query('COMMIT');view=true;}catch(e){await setup.query('ROLLBACK');throw e;}finally{setup.release();}
 await t.test('service return reflects a civil change committed after canonical generation',async()=>{
 const c=await gate();let pending:Promise<any>|undefined;
 try{pending=nativePostReturn(service.id,undefined,undefined,{comment:{id:comment.id,status:'approved'}}).then(value=>({value}),error=>({status:error.status}));await held();await pool.query("UPDATE posts SET post_date='2002-03-04T05:06:07' WHERE id=$1",[service.id]);await c.query('COMMIT');const result=await pending;assert.ok(result.status===404 || result.status===409 || result.value?.startsWith('/2002/03/04/05/06/07/'+service.id+'/'),JSON.stringify(result));}
 finally{await c.query('ROLLBACK');c.release();if(pending)await pending.catch(()=>{});}
 });
 await t.test('actual native HTTP return after accepted comment commit reflects the current civil canonical',async()=>{
 const c=await gate();let pending:Promise<Response>|undefined,diagnostic:any;
 try{
 pending=fetch(base+'/wp-comments-post.php',{method:'POST',redirect:'manual',headers:{Origin:origin,'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({postId:String(http.id),authorName:'Civil native visitor',authorEmail:'civil-native-http@example.test',content:'Civil native HTTP comment'}),signal:AbortSignal.timeout(20000)}).then(async response=>{diagnostic={status:response.status,location:response.headers.get('location'),body:await response.clone().text()};return response;});
 await held(()=>diagnostic);const accepted=await pool.query("SELECT id FROM worldact_civil_native_actual_comments WHERE post_id=$1 AND content LIKE '%Civil native HTTP comment%'",[http.id]);assert.equal(accepted.rowCount,1,'the native comment is already committed before this continuation wait');
 await pool.query('SELECT id FROM posts WHERE id=$1 FOR UPDATE NOWAIT',[http.id]);
 await pool.query("UPDATE posts SET post_date='2002-03-04T05:06:07' WHERE id=$1",[http.id]);await c.query('COMMIT');const response=await pending,location=response.headers.get('location'),body=await response.text();assert.ok([404,409].includes(response.status) || response.status===303 && location?.startsWith('/2002/03/04/05/06/07/'+http.id+'/'),JSON.stringify({status:response.status,location,body}));
 }finally{await c.query('ROLLBACK');c.release();if(pending)await pending.catch(()=>{});}
 });
 }finally{
 if(view){const c=await pool.connect();try{await c.query('BEGIN');await c.query('DROP VIEW comments');await c.query('ALTER TABLE worldact_civil_native_actual_comments RENAME TO comments');await c.query('DROP FUNCTION worldact_civil_native_date(timestamptz)');await c.query('DROP FUNCTION worldact_civil_native_insert()');await c.query('DROP SEQUENCE worldact_civil_native_calls');await c.query('COMMIT');}catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}}
 await pool.query('UPDATE settings SET data=$1 WHERE id=1',[old]);if(ids.length)await pool.query('DELETE FROM posts WHERE id=ANY($1::int[])',[ids]);
 }
});
