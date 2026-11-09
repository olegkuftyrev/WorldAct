import test,{after} from "./isolated-test.js";
import assert from "node:assert/strict";
import {pool,getSettings} from "../server/db.js";
import {postPermalink} from "../server/permalinks.js";
const base=process.env.TEST_API_URL!;
after(()=>pool.end());

async function held(){for(let i=0;i<400;i++){const r=await pool.query("SELECT query FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid() AND wait_event='advisory' AND position('SELECT post_date FROM posts WHERE' in query)>0");if(r.rowCount)return;await new Promise(r=>setTimeout(r,15));}assert.fail('final civil expression did not actually wait');}

test('independent final civil row fence rejects real row conflicts and persisted-owner/type/publication changes',{timeout:120000},async t=>{
 const original=(await pool.query('SELECT data FROM settings WHERE id=1')).rows[0].data,ids:number[]=[];let view=false;
 const owner=(await pool.query("SELECT id FROM users WHERE role='administrator' ORDER BY id LIMIT 1")).rows[0].id;
 const other=(await pool.query("INSERT INTO users(username,nicename,email,display_name,password_hash,role) VALUES('civil-final-owner','civil-final-owner','civil-final-owner@example.test','Civil final owner','unusable-fixture-hash','author') RETURNING id")).rows[0].id;
 async function make(label:string){const p=(await pool.query("INSERT INTO posts(type,title,slug,content,raw_content,status,author_id,published_at,post_date,post_date_gmt) VALUES('post',$1,$2,'<p>CIVIL-FINAL-FENCE-BODY</p>','<p>CIVIL-FINAL-FENCE-BODY</p>','publish',$3,'2001-02-03T04:05:06Z','2001-02-03T04:05:06','2001-02-03T04:05:06Z') RETURNING id,type,slug,status",['Civil final '+label,'civil-final-'+label,owner])).rows[0];ids.push(p.id);return p;}
 const conflict=await make('conflict'),ownerPost=await make('owner'),privatePost=await make('private'),typePost=await make('type');
 try{
 await pool.query("UPDATE settings SET data=data || $1::jsonb WHERE id=1",[JSON.stringify({timezone:'UTC',permalinkStructure:'/%author%/%year%/%monthnum%/%day%/%hour%/%minute%/%second%/%post_id%/',pingServices:[]})]);const settings=await getSettings();
 await t.test('a conflicting actual NO KEY UPDATE is rejected promptly as409 instead of waiting on a later writer',async()=>{
 const control=await pool.connect();try{await control.query('BEGIN');await control.query('SELECT id FROM posts WHERE id=$1 FOR NO KEY UPDATE',[conflict.id]);const started=Date.now();const result=await postPermalink(conflict,settings).then(value=>({value,status:0}),e=>({status:e.status}));assert.equal(result.status,409);assert.ok(Date.now()-started<3000);const response=await fetch(base+'/?p='+conflict.id,{signal:AbortSignal.timeout(5000)}),body=await response.text();assert.equal(response.status,409);assert.doesNotMatch(body,/CIVIL-FINAL-FENCE-BODY/);}finally{await control.query('ROLLBACK');control.release();}
 });
 const cols=(await pool.query("SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name='posts' ORDER BY ordinal_position")).rows.map(r=>r.column_name);
 const setup=await pool.connect();try{await setup.query('BEGIN');await setup.query('CREATE SEQUENCE worldact_civil_final_calls');await setup.query(`CREATE FUNCTION worldact_civil_final_date(value text) RETURNS text LANGUAGE plpgsql STABLE AS $$ DECLARE call bigint; BEGIN IF position('SELECT post_date FROM posts WHERE' in current_query())>0 THEN SELECT nextval('worldact_civil_final_calls') INTO call; IF call=1 THEN PERFORM pg_advisory_xact_lock(hashtext('worldact-civil-final-fence')); END IF; END IF; RETURN value; END $$`);await setup.query('ALTER TABLE posts RENAME TO worldact_civil_final_actual_posts');await setup.query('CREATE VIEW posts AS SELECT '+cols.map(c=>c==='post_date'?'worldact_civil_final_date(post_date) AS post_date':'"'+c+'"').join(',')+' FROM worldact_civil_final_actual_posts');await setup.query('COMMIT');view=true;}catch(e){await setup.query('ROLLBACK');throw e;}finally{setup.release();}
 for(const [label,post,sql,args] of [['owner',ownerPost,'author_id=$2',[ownerPost.id,other]],['publication',privatePost,"status='private'",[privatePost.id]],['type',typePost,"type='page'",[typePost.id]]] as const)await t.test('actual '+label+' change at final civil projection is rejected',async()=>{
 await pool.query('ALTER SEQUENCE worldact_civil_final_calls RESTART WITH 1');const control=await pool.connect();let pending:Promise<any>|undefined;try{await control.query('BEGIN');await control.query("SELECT pg_advisory_xact_lock(hashtext('worldact-civil-final-fence'))");pending=postPermalink(post,settings).then(value=>({value,status:0}),e=>({status:e.status}));await held();await pool.query('UPDATE worldact_civil_final_actual_posts SET '+sql+' WHERE id=$1',[...args]);await control.query('COMMIT');const result=await pending;assert.equal(result.status,404,JSON.stringify(result));}finally{await control.query('ROLLBACK');control.release();if(pending)await pending.catch(()=>{});}
 });
 }finally{
 if(view){const db=await pool.connect();try{await db.query('BEGIN');await db.query('DROP VIEW posts');await db.query('ALTER TABLE worldact_civil_final_actual_posts RENAME TO posts');await db.query('DROP FUNCTION worldact_civil_final_date(text)');await db.query('DROP SEQUENCE worldact_civil_final_calls');await db.query('COMMIT');}catch(e){await db.query('ROLLBACK');throw e;}finally{db.release();}}
 await pool.query('UPDATE settings SET data=$1 WHERE id=1',[original]);if(ids.length)await pool.query('DELETE FROM posts WHERE id=ANY($1::int[])',[ids]);await pool.query('DELETE FROM users WHERE id=$1',[other]);
 }
});
