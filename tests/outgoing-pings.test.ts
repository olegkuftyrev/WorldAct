import test,{after} from './isolated-test.js';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {pool,getSettings} from '../server/db.js';
import {publishDuePosts} from '../server/core.js';
import {enqueuePublicationPings,claimOutgoingPings,finishOutgoingPing,createOutgoingPingWorker,pruneOutgoingPings} from '../server/outgoing-pings.js';
const base=process.env.TEST_API_URL!,origin=process.env.APP_ORIGIN!;
const stamp='outgoing-'+Date.now();let cookie='';const posts:number[]=[],terms:number[]=[];
const targetHash=(url:string)=>createHash('sha256').update(url).digest('hex');
after(async()=>{await pool.end();});
async function api(path:string,method='GET',body?:unknown,auth=cookie){const response=await fetch(base+path,{method,headers:{Origin:origin,'Content-Type':'application/json',...(auth?{Cookie:auth}:{})},body:body===undefined?undefined:JSON.stringify(body)});return {response,data:await response.json()};}
async function ok(path:string,method='GET',body?:unknown,auth=cookie){const result=await api(path,method,body,auth);assert.ok(result.response.ok,`${method} ${path}: ${result.response.status} ${JSON.stringify(result.data)}`);return result;}
async function post(input:Record<string,unknown>={}){const record=(await ok('/api/posts','POST',{title:stamp,content:'<p>No links</p>',status:'publish',...input})).data.post;posts.push(record.id);return record;}
async function enqueue(id:number,env:'production'|'local'|'development'|'staging'='production'){
 const client=await pool.connect();try{await client.query('BEGIN');await enqueuePublicationPings(client,id,env);await client.query('COMMIT');}catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
}
async function clearJobs(){await pool.query("DELETE FROM outgoing_ping_jobs WHERE post_id=ANY($1::int[]) OR (kind='service' AND target LIKE 'https://service%.example.test/%')",[posts]);}
const noNetwork={async pingback(){throw new Error('Unexpected network');},async service(){throw new Error('Unexpected network');}};

test('transactional publication hooks, durable two-worker delivery, leases, suppression, privacy and retention',async t=>{
 const original=(await pool.query('SELECT data FROM settings WHERE id=1')).rows[0].data;
 const login=await ok('/api/auth/login','POST',{login:process.env.ADMIN_EMAIL,password:process.env.ADMIN_PASSWORD},'');cookie=login.response.headers.get('set-cookie')!.split(';')[0];
 try{
  await t.test('real create/update/import/scheduled hooks are atomic, repeated published saves enqueue and pages do not',async()=>{
   assert.equal(process.env.WORLDACT_ENVIRONMENT_TYPE,'local');
   await ok('/api/settings','PUT',{defaultPingbackFlag:true,pingServices:['https://services.example.test/rpc?OPERATOR_SECRET=value']});
   const first=await post({content:'<a href="https://target.example.test/first">First</a>',pingStatus:'open'});
   let rows=(await pool.query("SELECT * FROM outgoing_ping_jobs WHERE post_id=$1 OR (kind='service' AND target LIKE 'https://services.example.test/%')",[first.id])).rows;assert.equal(rows.length,2);assert.ok(rows.every(row=>row.state==='suppressed' && row.outcome==='environment'));
   const generation=rows.find(row=>row.kind==='discover').generation;
   const changed=(await ok('/api/posts/'+first.id,'PUT',{content:'<a href="https://target.example.test/first">First</a><a href="https://target.example.test/second">Second</a>'})).data.post;
   assert.equal(changed.pingStatus,'open');rows=(await pool.query("SELECT * FROM outgoing_ping_jobs WHERE post_id=$1 OR (kind='service' AND target LIKE 'https://services.example.test/%')",[first.id])).rows;assert.equal(rows.find(row=>row.kind==='discover').generation,generation+1);
   const page=await post({type:'page'}),draft=await post({status:'draft'});assert.equal((await pool.query('SELECT count(*)::int AS n FROM outgoing_ping_jobs WHERE post_id=ANY($1::int[])',[[page.id,draft.id]])).rows[0].n,0);
   const imported=await ok('/api/tools/import','POST',{application:'WorldAct',version:3,posts:[{id:991,type:'post',title:stamp+' import',slug:stamp+'-import',content:'<p>Imported published</p>',status:'publish'}],replaceDesign:true,settings:{defaultPingbackFlag:false,pingServices:['https://untrusted.example.test/restore?secret=one']}});posts.push(...imported.data.postIds);assert.ok(imported.data.warnings.some((message:string)=>message.includes('outgoing')));assert.equal((await pool.query('SELECT count(*)::int AS n FROM outgoing_ping_jobs WHERE post_id=ANY($1::int[])',[imported.data.postIds])).rows[0].n,0);assert.equal((await getSettings()).defaultPingbackFlag,true);
   const future=await post({status:'future',scheduledAt:new Date(Date.now()+86400000).toISOString()});assert.equal((await pool.query('SELECT count(*)::int AS n FROM outgoing_ping_jobs WHERE post_id=$1',[future.id])).rows[0].n,0);
   await pool.query(`CREATE FUNCTION outgoing_test_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF (SELECT title FROM posts WHERE id=NEW.post_id) LIKE '${stamp} rollback%' THEN RAISE EXCEPTION 'controlled queue write failure'; END IF; RETURN NEW; END $$`);
   await pool.query('CREATE TRIGGER outgoing_test_fail BEFORE INSERT ON outgoing_ping_jobs FOR EACH ROW EXECUTE FUNCTION outgoing_test_fail()');
   const failed=await api('/api/posts','POST',{title:stamp+' rollback create',status:'publish',content:'<p>Must rollback</p>'});assert.equal(failed.response.status,500);assert.equal((await pool.query('SELECT count(*)::int AS n FROM posts WHERE title=$1',[stamp+' rollback create'])).rows[0].n,0);
   await pool.query('UPDATE posts SET title=$1 WHERE id=$2',[stamp+' rollback scheduled',future.id]);await assert.rejects(publishDuePosts(new Date(Date.now()+2*86400000),[future.id]));assert.equal((await pool.query('SELECT status FROM posts WHERE id=$1',[future.id])).rows[0].status,'future');
   await pool.query('DROP TRIGGER outgoing_test_fail ON outgoing_ping_jobs');await pool.query('DROP FUNCTION outgoing_test_fail()');
   assert.deepEqual(await publishDuePosts(new Date(Date.now()+2*86400000),[future.id]),[future.id]);assert.equal((await pool.query('SELECT count(*)::int AS n FROM outgoing_ping_jobs WHERE post_id=$1',[future.id])).rows[0].n,1);
   const publicData=(await ok('/api/public/site','GET',undefined,'')).data;assert.equal(publicData.settings.pingServices,undefined);assert.equal(publicData.settings.defaultPingbackFlag,undefined);assert.doesNotMatch(JSON.stringify(publicData),/OPERATOR_SECRET/);
   const archive=(await ok('/api/tools/export')).data;assert.equal(archive.settings.pingServices,undefined);assert.equal(archive.settings.defaultPingbackFlag,undefined);assert.doesNotMatch(JSON.stringify(archive),/OPERATOR_SECRET|outgoing_ping_jobs|lease_token/);
   assert.equal((await api('/api/tools/outgoing-pings','GET',undefined,'')).response.status,401);const statusResponse=await ok('/api/tools/outgoing-pings');assert.equal(statusResponse.response.headers.get('cache-control'),'no-store');const status=statusResponse.data;assert.equal(status.dispatchEnabled,false);assert.doesNotMatch(JSON.stringify(status),/OPERATOR_SECRET|services.example.test|target|lease_token/);
  });
  await t.test('source discovery creates real target jobs; sent targets survive repeat/new links and protected/removed links suppress',async()=>{
   await clearJobs();await ok('/api/settings','PUT',{pingServices:[],defaultPingbackFlag:true});
   const document=await post({content:'<a href="https://target.example.test/a">A</a> <a href="https://target.example.test/b">B</a>'});await enqueue(document.id);
   let active=0,maximum=0,calls=0,releaseBoth!:()=>void;const both=new Promise<void>(done=>releaseBoth=done);const worker=createOutgoingPingWorker({environment:()=> 'production',protocol:{async pingback(){active++;maximum=Math.max(maximum,active);calls++;await pool.query('SELECT 1');if(calls<=2){if(calls===2)releaseBoth();await both;}active--;return 'sent';},async service(){throw new Error('not expected');}}});
   assert.equal(await worker.runOnce(),1);assert.equal(await worker.runOnce(),2);assert.equal(calls,2);assert.equal(maximum,2);assert.equal((await pool.query('SELECT count(*)::int AS n FROM outgoing_ping_sent WHERE post_id=$1',[document.id])).rows[0].n,2);
   await ok('/api/posts/'+document.id,'PUT',{content:'<a href="https://target.example.test/a">A</a> <a href="https://target.example.test/c">C</a>'});await enqueue(document.id);await worker.runOnce();await worker.runOnce();assert.equal(calls,3);
   await enqueue(document.id);await worker.runOnce();assert.equal(await worker.runOnce(),0);assert.equal(calls,3);
   await ok('/api/posts/'+document.id,'PUT',{content:'<a href="https://target.example.test/new">New</a>'});await enqueue(document.id);await worker.runOnce();await ok('/api/posts/'+document.id,'PUT',{password:'Secret-protection-password'});await worker.runOnce();assert.equal(calls,3);
   const protectedRows=(await pool.query("SELECT state,outcome FROM outgoing_ping_jobs WHERE post_id=$1 AND kind='pingback' AND target LIKE '%/new'",[document.id])).rows;assert.equal(protectedRows[0].outcome,'protected');
   await ok('/api/posts/'+document.id,'PUT',{password:'',content:'<a href="https://target.example.test/removed">Remove</a>'});await enqueue(document.id);await worker.runOnce();await ok('/api/posts/'+document.id,'PUT',{content:'<p>Link removed</p>'});await worker.runOnce();assert.equal(calls,3);assert.equal((await pool.query("SELECT outcome FROM outgoing_ping_jobs WHERE post_id=$1 AND target LIKE '%/removed'",[document.id])).rows[0].outcome,'link_removed');
  });
  await t.test('worker source URLs match core historical category/date permalinks in the site timezone and creation fallback',async()=>{
   await clearJobs();const before=await getSettings();
   try{
    await ok('/api/settings','PUT',{pingServices:[],defaultPingbackFlag:true,timezone:'America/Los_Angeles',permalinkStructure:'/%year%/%monthnum%/%day%/%category%/%postname%/'});
    const category=(await ok('/api/terms','POST',{taxonomy:'category',name:stamp+' dated category'})).data.term;terms.push(category.id);
    const document=await post({publishedAt:'2012-01-01T07:30:00Z',categoryIds:[category.id],content:'<a href="https://target.example.test/historical">Historical</a>'});
    assert.match(document.permalink,new RegExp('^/2011/12/31/'+category.slug+'/'));
    const sources:string[]=[];const worker=createOutgoingPingWorker({environment:()=> 'production',protocol:{...noNetwork,async pingback(_target,source){sources.push(source);return 'sent';}}});
    await enqueue(document.id);await worker.runOnce();await worker.runOnce();assert.equal(sources[0],new URL(document.permalink,before.siteUrl).href);
    await pool.query("UPDATE posts SET published_at=NULL,created_at='2010-06-01T06:30:00Z',content=$1,raw_content=$1 WHERE id=$2",['<a href="https://target.example.test/creation">Fallback</a>',document.id]);
    const fallback=(await ok('/api/posts/'+document.id)).data.post;assert.match(fallback.permalink,new RegExp('^/2010/05/31/'+category.slug+'/'));
    await enqueue(document.id);await worker.runOnce();await worker.runOnce();assert.equal(sources[1],new URL(fallback.permalink,before.siteUrl).href);
   }finally{await ok('/api/settings','PUT',{timezone:before.timezone,permalinkStructure:before.permalinkStructure});}
  });
  await t.test('leases are SKIP LOCKED, stale completion cannot win and restarted work retries at most three times',async()=>{
   await clearJobs();const documents=await Promise.all([post(),post(),post()]);for(const item of documents)await enqueue(item.id);
   const [a,b]=await Promise.all([claimOutgoingPings(pool,2),claimOutgoingPings(pool,2)]);assert.equal(new Set([...a,...b].map(job=>job.id)).size,2,JSON.stringify({a:a.map(job=>job.id),b:b.map(job=>job.id),rows:(await pool.query("SELECT id,state,attempts,lease_until,now() AS current_time FROM outgoing_ping_jobs WHERE post_id=ANY($1::int[])",[documents.map(item=>item.id)])).rows}));assert.ok(a.length===0 || b.length===0);await pool.query("UPDATE outgoing_ping_jobs SET state='suppressed' WHERE post_id=ANY($1::int[]) AND state='pending'",[documents.map(item=>item.id)]);
   for(let round=0;round<20;round++){
    await pool.query("UPDATE outgoing_ping_jobs SET state='pending',attempts=0,lease_token=NULL,lease_until=NULL WHERE post_id=ANY($1::int[])",[documents.map(item=>item.id)]);
    const claims=await Promise.all([claimOutgoingPings(pool,2),claimOutgoingPings(pool,2)]);assert.equal(claims.flat().length,2);
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM outgoing_ping_jobs WHERE state='running' AND post_id=ANY($1::int[])",[documents.map(item=>item.id)])).rows[0].n,2);
   }
   await pool.query("UPDATE outgoing_ping_jobs SET state='pending',attempts=0,lease_token=NULL,lease_until=NULL WHERE post_id=ANY($1::int[])",[documents.map(item=>item.id)]);
   const current=await claimOutgoingPings(pool,2);await pool.query("UPDATE outgoing_ping_jobs SET state='suppressed' WHERE post_id=ANY($1::int[]) AND state='pending'",[documents.map(item=>item.id)]);
   const old=current[0];await pool.query("UPDATE outgoing_ping_jobs SET lease_until=now()-interval '1 second' WHERE id=$1",[old.id]);const [replacement]=await claimOutgoingPings(pool,1);assert.equal(replacement.id,old.id);assert.notEqual(replacement.lease_token,old.lease_token);assert.equal(replacement.attempts,2);
   await finishOutgoingPing(old,'sent','delivered');assert.equal((await pool.query('SELECT lease_token FROM outgoing_ping_jobs WHERE id=$1',[old.id])).rows[0].lease_token,replacement.lease_token);
   await pool.query("UPDATE outgoing_ping_jobs SET lease_until=now()-interval '1 second' WHERE id=$1",[old.id]);const [third]=await claimOutgoingPings(pool,1);assert.equal(third.attempts,3);await pool.query("UPDATE outgoing_ping_jobs SET lease_until=now()-interval '1 second' WHERE id=$1",[old.id]);await claimOutgoingPings(pool,1);assert.equal((await pool.query('SELECT state,outcome FROM outgoing_ping_jobs WHERE id=$1',[old.id])).rows[0].outcome,'lease_exhausted');
   const live=current.find(job=>job.id!==old.id)!;await enqueue(live.post_id!);await finishOutgoingPing(live,'sent','delivered');const coalesced=(await pool.query('SELECT state,attempts,lease_token FROM outgoing_ping_jobs WHERE id=$1',[live.id])).rows[0];assert.deepEqual(coalesced,{state:'pending',attempts:0,lease_token:null});
   // A fresh publication during a third leased attempt must survive a process crash.
   const [crashing]=await claimOutgoingPings(pool,1);await pool.query("UPDATE outgoing_ping_jobs SET attempts=3 WHERE id=$1",[crashing.id]);await enqueue(crashing.post_id!);await pool.query("UPDATE outgoing_ping_jobs SET lease_until=now()-interval '1 second' WHERE id=$1",[crashing.id]);const recovered=await claimOutgoingPings(pool,2);assert.ok(recovered.some(job=>job.id===crashing.id && job.attempts===1));
  });
  await t.test('local/staging, preferences, current status and service visibility independently suppress with zero protocol calls',async()=>{
   await clearJobs();const document=await post();let calls=0;const protocol={async pingback(){calls++;return 'sent' as const;},async service(){calls++;}};
   for(const environment of ['local','development','staging'] as const){await enqueue(document.id);await createOutgoingPingWorker({environment:()=>environment,protocol}).runOnce();assert.equal((await pool.query("SELECT outcome FROM outgoing_ping_jobs WHERE post_id=$1 AND kind='discover'",[document.id])).rows[0].outcome,'environment');}
   await ok('/api/settings','PUT',{defaultPingbackFlag:true,pingServices:['https://service.example.test/rpc?operator=SECRET']});await enqueue(document.id);await ok('/api/settings','PUT',{defaultPingbackFlag:false});await createOutgoingPingWorker({environment:()=> 'production',protocol}).runOnce();assert.equal(calls,1);
   await ok('/api/settings','PUT',{defaultPingbackFlag:true,discourageSearchEngines:true});await enqueue(document.id);await createOutgoingPingWorker({environment:()=> 'production',protocol}).runOnce();assert.equal(calls,1);assert.equal((await pool.query("SELECT outcome FROM outgoing_ping_jobs WHERE kind='service' AND target LIKE 'https://service.example.test/%'",[])).rows[0].outcome,'visibility');
   await ok('/api/settings','PUT',{discourageSearchEngines:false});await enqueue(document.id);await ok('/api/posts/'+document.id,'PUT',{status:'draft'});await createOutgoingPingWorker({environment:()=> 'production',protocol}).runOnce();assert.equal(calls,2);assert.equal((await pool.query("SELECT outcome FROM outgoing_ping_jobs WHERE kind='discover' AND post_id=$1",[document.id])).rows[0].outcome,'not_published');
  });
  await t.test('no transaction connection is held during delivery; physical worker cap remains two across concurrent ticks',async()=>{
   await clearJobs();await ok('/api/settings','PUT',{defaultPingbackFlag:true,pingServices:['https://service.example.test/rpc']});const document=await post();await enqueue(document.id);await pool.query("UPDATE outgoing_ping_jobs SET state='sent' WHERE post_id=$1 AND kind='discover'",[document.id]);
   // Only service requires I/O. A one-connection adapter makes holding its claim client observable.
   let held=0,checked=0;const db={query:(...args:any[])=>{assert.equal(held,0,'pooled query while claim connection held');return (pool.query as any)(...args);},connect:async()=>{const client=await pool.connect();held++;const release=client.release.bind(client);return new Proxy(client,{get(target,key){if(key==='release')return()=>{held--;release();};const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;}});}} as any;
   let unblock!:()=>void,entered!:()=>void;const ready=new Promise<void>(done=>entered=done),barrier=new Promise<void>(done=>unblock=done);
   const worker=createOutgoingPingWorker({db,environment:()=> 'production',protocol:{...noNetwork,async service(){assert.equal(held,0);checked++;entered();await barrier;}}});
   const pending=worker.runOnce();await ready;assert.equal(await worker.runOnce(),0);unblock();await pending;assert.equal(checked,1);
  });
  await t.test('a failed finalization retains worker reservations until its sibling delivery physically settles',async()=>{
   await clearJobs();await ok('/api/settings','PUT',{pingServices:['https://service.example.test/failure-a','https://service.example.test/failure-b']});const document=await post();await enqueue(document.id);await pool.query("UPDATE outgoing_ping_jobs SET state='sent' WHERE post_id=$1 AND kind='discover'",[document.id]);
   let release!:()=>void,entered!:()=>void;const waiting=new Promise<void>(done=>release=done),ready=new Promise<void>(done=>entered=done);let starts=0;
   const db={connect:()=>pool.connect(),query:(sql:any,args:any[])=>{if(typeof sql==='string' && sql.startsWith('UPDATE outgoing_ping_jobs SET state=CASE'))return Promise.reject(new Error('controlled finalization failure'));return (pool.query as any)(sql,args);}} as any;
   const worker=createOutgoingPingWorker({db,environment:()=> 'production',protocol:{...noNetwork,async service(){starts++;if(starts===2){entered();await waiting;}}}});
   const pending=worker.runOnce();const handled=pending.catch(()=>{});await ready;assert.equal(await worker.runOnce(),0);assert.equal(starts,2);release();await assert.rejects(pending,/finalization/);await handled;
  });
  await t.test('coalesced site notifications survive deletion of the most recent contributing post',async()=>{
   await clearJobs();await ok('/api/settings','PUT',{pingServices:['https://service.example.test/coalesce']});
   const first=await post(),latest=await post();await enqueue(first.id);await enqueue(latest.id);await pool.query('DELETE FROM posts WHERE id=$1',[latest.id]);
   assert.equal((await pool.query("SELECT count(*)::int AS n FROM outgoing_ping_jobs WHERE kind='service' AND target='https://service.example.test/coalesce'")).rows[0].n,1);
   let calls=0;const worker=createOutgoingPingWorker({environment:()=> 'production',protocol:{...noNetwork,async service(){calls++;}}});await worker.runOnce();assert.equal(calls,1);
  });
  await t.test('durable backlog and history caps are enforced transactionally without deleting sent hashes',async()=>{
   await clearJobs();await ok('/api/settings','PUT',{pingServices:[]});const document=await post();const client=await pool.connect();
   try{
    await client.query('BEGIN');await client.query("INSERT INTO outgoing_ping_jobs(dedupe_key,kind,post_id,state) SELECT $1||n,'discover',$2,'pending' FROM generate_series(1,5000) n",[stamp+'-cap-',document.id]);
    await assert.rejects(enqueuePublicationPings(client,document.id,'production'),/busy/);await client.query('ROLLBACK');
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM outgoing_ping_jobs WHERE dedupe_key LIKE $1",[stamp+'-cap-%'])).rows[0].n,0);
    await client.query('BEGIN');await client.query("INSERT INTO outgoing_ping_jobs(dedupe_key,kind,post_id,state) SELECT $1||n,'discover',$2,'sent' FROM generate_series(1,10005) n",[stamp+'-history-',document.id]);
    await client.query('INSERT INTO outgoing_ping_sent(post_id,target_hash) VALUES($1,$2)',[document.id,targetHash('https://target.example.test/retained')]);await pruneOutgoingPings(client);
    assert.ok((await client.query("SELECT count(*)::int AS n FROM outgoing_ping_jobs WHERE state IN ('sent','failed','suppressed')")).rows[0].n<=10000);assert.equal((await client.query('SELECT count(*)::int AS n FROM outgoing_ping_sent WHERE post_id=$1',[document.id])).rows[0].n,1);
   }finally{await client.query('ROLLBACK');client.release();}
  });
  await t.test('terminal history pruning preserves durable sent targets and safe retry errors never contain remote text',async()=>{
   await clearJobs();await ok('/api/settings','PUT',{pingServices:[]});const document=await post({content:'https://target.example.test/post'});await enqueue(document.id);const protocol={...noNetwork,async pingback(){throw new Error('https://secret.example.test/?operator=VERY_SECRET');}};const worker=createOutgoingPingWorker({environment:()=> 'production',protocol});await worker.runOnce();
   for(let i=0;i<3;i++){await pool.query("UPDATE outgoing_ping_jobs SET due_at=now() WHERE post_id=$1 AND state='pending'",[document.id]);await worker.runOnce();}
   const failed=(await pool.query("SELECT state,outcome,attempts FROM outgoing_ping_jobs WHERE post_id=$1 AND kind='pingback'",[document.id])).rows[0];assert.deepEqual(failed,{state:'failed',outcome:'unavailable',attempts:3});
   await pool.query('INSERT INTO outgoing_ping_sent(post_id,target_hash) VALUES($1,$2) ON CONFLICT DO NOTHING',[document.id,targetHash('https://target.example.test/old')]);await pool.query("UPDATE outgoing_ping_jobs SET updated_at=now()-interval '31 days' WHERE post_id=$1",[document.id]);await pruneOutgoingPings();assert.equal((await pool.query('SELECT count(*)::int AS n FROM outgoing_ping_jobs WHERE post_id=$1',[document.id])).rows[0].n,0);assert.equal((await pool.query('SELECT count(*)::int AS n FROM outgoing_ping_sent WHERE post_id=$1',[document.id])).rows[0].n,1);
   assert.doesNotMatch(JSON.stringify((await ok('/api/tools/outgoing-pings')).data),/VERY_SECRET|secret.example.test/);
  });
 }finally{
  await pool.query('DROP TRIGGER IF EXISTS outgoing_test_fail ON outgoing_ping_jobs');await pool.query('DROP FUNCTION IF EXISTS outgoing_test_fail()');
  await clearJobs();await pool.query('DELETE FROM posts WHERE id=ANY($1::int[])',[posts]);await pool.query('DELETE FROM terms WHERE id=ANY($1::int[])',[terms]);await pool.query('UPDATE settings SET data=$1::jsonb WHERE id=1',[JSON.stringify(original)]);await api('/api/auth/logout','POST',{});
 }
});
