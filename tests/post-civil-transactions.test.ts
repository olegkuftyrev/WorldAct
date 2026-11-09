import test,{after} from "./isolated-test.js";
import assert from "node:assert/strict";
import {pool,getSettings,getPost} from "../server/db.js";
import {postPermalink} from "../server/permalinks.js";
import {civilFromInstant,postCivilInstant} from "../shared/post-civil-date.js";
const base=process.env.TEST_API_URL!,origin=process.env.APP_ORIGIN!;
after(()=>pool.end());

test('independent readonly and caller transaction canonical queries see their own coherent civil settings',async()=>{
 const author=(await pool.query("SELECT id FROM users WHERE role='administrator' ORDER BY id LIMIT 1")).rows[0].id;
 const p=(await pool.query("INSERT INTO posts(type,title,slug,content,raw_content,status,author_id,published_at,post_date,post_date_gmt) VALUES('post','Civil caller','civil-caller','<p>Civil caller.</p>','<p>Civil caller.</p>','publish',$1,'2001-02-03T04:05:06Z','2001-02-03T04:05:06','2001-02-03T04:05:06Z') RETURNING id,type,slug,status",[author])).rows[0];
 const db=await pool.connect();
 try{
 await db.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');const settings={...await getSettings(db),permalinkStructure:'/%year%/%monthnum%/%day%/%hour%/%minute%/%second%/%post_id%/'};
 assert.equal(await postPermalink({...p,postDate:'1900-01-01T00:00:00'},settings,db),'/2001/02/03/04/05/06/'+p.id+'/');
 await pool.query("UPDATE posts SET post_date='2002-03-04T05:06:07' WHERE id=$1",[p.id]);
 assert.equal(await postPermalink(p,settings,db),'/2001/02/03/04/05/06/'+p.id+'/');await db.query('COMMIT');
 await db.query('BEGIN');await db.query("UPDATE posts SET post_date='2003-04-05T06:07:08' WHERE id=$1",[p.id]);
 assert.equal(await postPermalink(p,settings,db),'/2003/04/05/06/07/08/'+p.id+'/');await db.query('ROLLBACK');
 assert.equal((await getPost(p.id)).postDate,'2002-03-04T05:06:07');
 }finally{await db.query('ROLLBACK');db.release();await pool.query('DELETE FROM posts WHERE id=$1',[p.id]);}
});

test('independent chosen clock and site zone are captured after a measured slug allocator wait',async()=>{
 const original=(await pool.query('SELECT data FROM settings WHERE id=1')).rows[0].data;let cookie='',id:number|undefined;
 const control=await pool.connect();let pending:Promise<Response>|undefined;
 try{
 const login=await fetch(base+'/api/auth/login',{method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},body:JSON.stringify({login:process.env.ADMIN_EMAIL,password:process.env.ADMIN_PASSWORD})});assert.equal(login.status,200);cookie=login.headers.get('set-cookie')!.split(';')[0];
 await pool.query("UPDATE settings SET data=data || $1::jsonb WHERE id=1",[JSON.stringify({timezone:"America/Los_Angeles",pingServices:[]})]);
 await control.query('BEGIN');const pid=(await control.query('SELECT pg_backend_pid() pid')).rows[0].pid;await control.query("SELECT pg_advisory_xact_lock(hashtext('worldact-post-slug'))");
 pending=fetch(base+'/api/posts',{method:'POST',headers:{Origin:origin,Cookie:cookie,'Content-Type':'application/json'},body:JSON.stringify({title:'Independent civil after slug wait',status:'draft'})});
 let blocked=false;for(let i=0;i<200;i++){if((await pool.query("SELECT query FROM pg_stat_activity WHERE datname=current_database() AND $1=ANY(pg_blocking_pids(pid)) AND position('worldact-post-slug' in query)>0",[pid])).rowCount){blocked=true;break;}await new Promise(r=>setTimeout(r,15));}assert.equal(blocked,true);
 await pool.query("UPDATE settings SET data=data || $1::jsonb WHERE id=1",[JSON.stringify({timezone:"+05:45"})]);const beforeRelease=Date.now();await control.query('COMMIT');const response=await pending,data=await response.json();assert.equal(response.status,201,JSON.stringify(data));id=data.post.id;
 const instant=Date.parse(postCivilInstant(data.post.postDate,'+05:45'));assert.ok(instant>=Math.floor(beforeRelease/1000)*1000 && instant<=Date.now(),JSON.stringify({civil:data.post.postDate,beforeRelease,instant}));assert.equal(data.post.postDateGmt,null);
 assert.equal(civilFromInstant(new Date(instant),'+05:45'),data.post.postDate);
 }finally{await control.query('ROLLBACK');control.release();if(pending)await pending.catch(()=>{});await pool.query('UPDATE settings SET data=$1 WHERE id=1',[original]);if(id)await pool.query('DELETE FROM posts WHERE id=$1',[id]);}
});
