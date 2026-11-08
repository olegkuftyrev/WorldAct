import test,{after} from "./isolated-test.js";
import assert from "node:assert/strict";
import {pool,getSettings} from "../server/db.js";
import {postPermalink} from "../server/permalinks.js";
import {nativePostReturn} from "../server/native-post-return.js";
const base=process.env.TEST_API_URL!;
after(()=>pool.end());
async function held(){for(let i=0;i<400;i++){const r=await pool.query("SELECT query FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid() AND wait_event='advisory' AND position('posts' in query)>0");if(r.rowCount)return;await new Promise(r=>setTimeout(r,15));}assert.fail('actual civil projection expression did not block');}

test('independent current civil identity survives an actual post_date expression wait',{timeout:120000},async t=>{
 const old=(await pool.query('SELECT data FROM settings WHERE id=1')).rows[0].data;
 const author=(await pool.query("SELECT id FROM users WHERE role='administrator' ORDER BY id LIMIT 1")).rows[0].id;
 const ids:number[]=[];let view=false;
 async function make(label:string){const p=(await pool.query("INSERT INTO posts(type,title,slug,content,raw_content,status,author_id,published_at,post_date,post_date_gmt) VALUES('post',$1,$2,'<p>CIVIL-EXPRESSION-WAIT-BODY</p>','<p>CIVIL-EXPRESSION-WAIT-BODY</p>','publish',$3,'2001-02-03T04:05:06Z','2001-02-03T04:05:06','2001-02-03T04:05:06Z') RETURNING id,slug,type",['Civil expression '+label,'civil-expression-'+label,author])).rows[0];ids.push(p.id);return p;}
 const native=await make('native'),path=await make('path'),dto=await make('dto');
 async function gate(n:number){await pool.query('ALTER SEQUENCE worldact_civil_independent_calls RESTART WITH 1');await pool.query('UPDATE worldact_civil_independent_gate SET nth=$1',[n]);const c=await pool.connect();await c.query('BEGIN');await c.query("SELECT pg_advisory_xact_lock(hashtext('worldact-civil-expression-wait'))");return c;}
 try{
 await pool.query("UPDATE settings SET data=data || $1::jsonb WHERE id=1",[JSON.stringify({permalinkStructure:'/%year%/%monthnum%/%day%/%hour%/%minute%/%second%/%post_id%/',timezone:'UTC',pingServices:[]})]);
 const cols=(await pool.query("SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name='posts' ORDER BY ordinal_position")).rows.map(r=>r.column_name);
 const setup=await pool.connect();try{await setup.query('BEGIN');await setup.query('CREATE SEQUENCE worldact_civil_independent_calls');await setup.query('CREATE TABLE worldact_civil_independent_gate(nth int NOT NULL)');await setup.query('INSERT INTO worldact_civil_independent_gate VALUES(1)');await setup.query(`CREATE FUNCTION worldact_civil_independent_date(value text) RETURNS text LANGUAGE plpgsql STABLE AS $$ DECLARE call bigint; gate bigint; BEGIN SELECT nextval('worldact_civil_independent_calls') INTO call; SELECT nth INTO gate FROM worldact_civil_independent_gate; IF call=gate THEN PERFORM pg_advisory_xact_lock(hashtext('worldact-civil-expression-wait')); END IF; RETURN value; END $$`);await setup.query('ALTER TABLE posts RENAME TO worldact_civil_independent_actual_posts');await setup.query('CREATE VIEW posts AS SELECT '+cols.map(c=>c==='post_date'?'worldact_civil_independent_date(post_date) AS post_date':'"'+c+'"').join(',')+' FROM worldact_civil_independent_actual_posts');await setup.query('COMMIT');view=true;}catch(e){await setup.query('ROLLBACK');throw e;}finally{setup.release();}
 await t.test('native continuation returns current canonical or bounded conflict after selected civil changes',async()=>{
 const c=await gate(2);let pending:Promise<any>|undefined;
 try{pending=nativePostReturn(native.id,undefined,undefined).then(value=>({value}),error=>({status:error.status}));await held();await pool.query("UPDATE worldact_civil_independent_actual_posts SET post_date='2002-03-04T05:06:07' WHERE id=$1",[native.id]);await c.query('COMMIT');const result=await pending;assert.ok(result.status===404 || result.status===409 || result.value==='/2002/03/04/05/06/07/'+native.id+'/',JSON.stringify(result));}
 finally{await c.query('ROLLBACK');c.release();if(pending)await pending.catch(()=>{});}
 });
 await t.test('wrong former civil route does not release a body after its canonical expression waited',async()=>{
 const c=await gate(1);let pending:Promise<Response>|undefined;
 try{pending=fetch(base+'/2001/02/03/04/05/06/'+path.id+'/',{signal:AbortSignal.timeout(20000)});await held();await pool.query("UPDATE worldact_civil_independent_actual_posts SET post_date='2002-03-04T05:06:07' WHERE id=$1",[path.id]);await c.query('COMMIT');const response=await pending,body=await response.text();assert.ok([404,409].includes(response.status),JSON.stringify({status:response.status,bodyPresent:body.includes('CIVIL-EXPRESSION-WAIT-BODY')}));assert.doesNotMatch(body,/CIVIL-EXPRESSION-WAIT-BODY/);}
 finally{await c.query('ROLLBACK');c.release();if(pending)await pending.catch(()=>{});}
 });
 await t.test('authoritative permalink ignores a stale DTO civil date after a waited read',async()=>{
 const c=await gate(1);let pending:Promise<any>|undefined;
 try{pending=postPermalink({...dto,postDate:'1900-01-01T00:00:00'},await getSettings()).then(value=>({value}),error=>({status:error.status}));await held();await pool.query("UPDATE worldact_civil_independent_actual_posts SET post_date='2002-03-04T05:06:07' WHERE id=$1",[dto.id]);await c.query('COMMIT');const result=await pending;assert.ok(result.status===404 || result.status===409 || result.value==='/2002/03/04/05/06/07/'+dto.id+'/',JSON.stringify(result));}
 finally{await c.query('ROLLBACK');c.release();if(pending)await pending.catch(()=>{});}
 });
 }finally{
 if(view){const c=await pool.connect();try{await c.query('BEGIN');await c.query('DROP VIEW posts');await c.query('ALTER TABLE worldact_civil_independent_actual_posts RENAME TO posts');await c.query('DROP FUNCTION worldact_civil_independent_date(text)');await c.query('DROP TABLE worldact_civil_independent_gate');await c.query('DROP SEQUENCE worldact_civil_independent_calls');await c.query('COMMIT');}catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}}
 await pool.query('UPDATE settings SET data=$1 WHERE id=1',[old]);if(ids.length)await pool.query('DELETE FROM posts WHERE id=ANY($1::int[])',[ids]);
 }
});
