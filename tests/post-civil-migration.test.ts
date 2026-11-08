import test,{after} from "./isolated-test.js";
import assert from "node:assert/strict";
import {createHash,randomBytes} from "node:crypto";
import {writeFile,readFile,unlink} from "node:fs/promises";
import path from "node:path";
import {pool,uploadsDir} from "../server/db.js";
import {migrate} from "../server/migrate.js";
after(()=>pool.end());

test('independent full old-column migration keeps all table rows and uploads, waits for users first and backfills once',async()=>{
 const original=(await pool.query('SELECT data FROM settings WHERE id=1')).rows[0].data;
 const fixture=path.join(uploadsDir,'independent-civil-migration-'+randomBytes(6).toString('hex')+'.bin'),blob=randomBytes(128);
 const control=await pool.connect();let pending:Promise<void>|undefined;
 async function snapshot(){const tables=(await pool.query("SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE' ORDER BY table_name")).rows.map(r=>r.table_name);const result:Record<string,string>={};for(const table of tables){assert.match(table,/^[a-z_][a-z0-9_]*$/);const rows=(await pool.query(`SELECT (to_jsonb(t)${table==='posts'?"-ARRAY['post_date','post_date_gmt']":''})::text record FROM "${table}" t ORDER BY record`)).rows;result[table]=createHash('sha256').update(JSON.stringify(rows)).digest('hex');}return result;}
 try{
 await writeFile(fixture,blob,{mode:0o600});await pool.query("UPDATE settings SET data=data || $1::jsonb WHERE id=1",[JSON.stringify({timezone:'America/Los_Angeles'})]);
 await pool.query('ALTER TABLE posts DROP COLUMN post_date, DROP COLUMN post_date_gmt');const before=await snapshot();
 await control.query('BEGIN');const pid=(await control.query('SELECT pg_backend_pid() pid')).rows[0].pid;await control.query('LOCK TABLE users IN ACCESS SHARE MODE');pending=migrate();
 let blocked=false;for(let i=0;i<200;i++){const activity=await pool.query("SELECT query FROM pg_stat_activity WHERE datname=current_database() AND $1=ANY(pg_blocking_pids(pid)) AND query='LOCK TABLE users IN ACCESS EXCLUSIVE MODE'",[pid]);if(activity.rowCount){blocked=true;break;}await new Promise(r=>setTimeout(r,15));}assert.equal(blocked,true);
 await pool.query('SELECT id FROM posts LIMIT 1 FOR UPDATE NOWAIT');assert.equal((await pool.query("SELECT count(*)::int n FROM information_schema.columns WHERE table_schema='public' AND table_name='posts' AND column_name='post_date'")).rows[0].n,0);
 await control.query('COMMIT');await pending;assert.deepEqual(await snapshot(),before);assert.deepEqual(await readFile(fixture),blob);
 const pairs=(await pool.query('SELECT id,post_date,post_date_gmt::text gmt FROM posts ORDER BY id')).rows;assert.ok(pairs.length>0);assert.ok(pairs.every(p=>typeof p.post_date==='string'));
 await pool.query("UPDATE settings SET data=data || $1::jsonb WHERE id=1",[JSON.stringify({timezone:'+05:45'})]);const secondBefore=await snapshot();await migrate();assert.deepEqual(await snapshot(),secondBefore);assert.deepEqual((await pool.query('SELECT id,post_date,post_date_gmt::text gmt FROM posts ORDER BY id')).rows,pairs);assert.deepEqual(await readFile(fixture),blob);
 }finally{await control.query('ROLLBACK');control.release();if(pending)await pending.catch(()=>{});await pool.query('UPDATE settings SET data=$1 WHERE id=1',[original]);await unlink(fixture).catch(()=>{});}
});
