import test,{after} from './isolated-test.js';
import assert from 'node:assert/strict';
import express from 'express';
import {createServer} from 'node:http';
import {EventEmitter} from 'node:events';
import {Readable} from 'node:stream';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {gzipSync} from 'node:zlib';
import {pool,getSettings,rootDir} from '../server/db.js';
import {parseIncomingPing,verifyPingHTML,IncomingPingError,createIncomingPings,createIncomingPingsRouter,pingsOpen,pingbackHeader} from '../server/incoming-pings.js';
import {pingRPC,parsePingReply} from '../server/ping-protocol.js';
import {akismetFields,createAkismetClient} from '../server/bundled-plugins.js';
import {createPublicHTTPTransport} from '../server/public-http.js';
const base=process.env.TEST_API_URL!,origin=process.env.APP_ORIGIN!,stamp='incoming-'+Date.now();let cookie='';const posts:number[]=[],users:number[]=[];
after(async()=>{await pool.end();});
async function api(path:string,method='GET',body?:unknown,auth=cookie){const response=await fetch(base+path,{method,headers:{Origin:origin,'Content-Type':'application/json',...(auth?{Cookie:auth}:{})},body:body===undefined?undefined:JSON.stringify(body)});return {response,data:await response.json()};}
async function ok(path:string,method='GET',body?:unknown,auth=cookie){const result=await api(path,method,body,auth);assert.ok(result.response.ok,`${path}: ${result.response.status} ${JSON.stringify(result.data)}`);return result.data;}
async function post(input:Record<string,unknown>={}){const p=(await ok('/api/posts','POST',{title:stamp,status:'publish',content:'<p>Safe public</p>',...input})).post;posts.push(p.id);return p;}
async function resetAdmission(){await pool.query('DELETE FROM incoming_ping_rates');await pool.query('DELETE FROM incoming_ping_leases');}
// Only unrelated protocol/policy cases age this file's owned predecessors.
// Immediate duplicates, concurrency, and lock/flood assertions stay unaged.
async function ageOwnedAdmissions(){await pool.query("UPDATE comments SET created_at=date_trunc('second',clock_timestamp())-interval '20 seconds' WHERE post_id=ANY($1::int[])",[posts]);}
const failCode=(code:number)=>(error:unknown)=>error instanceof IncomingPingError&&error.code===code;
const rpc=(s:string,t:string)=>Buffer.from(pingRPC('pingback.ping',[s,t]));
function fixture(body:Buffer,options:{remote?:string;status?:number;headers?:Record<string,string>;hold?:boolean}={}){
 const seen:any[]=[];let request:any;
 return {seen,get request(){return request;},requestFn:((opts:any,callback:any)=>{
  seen.push(opts);const req=new EventEmitter() as any;request=req;req.close=()=>{req.emit('close');req.socket?.emit('close');};req.destroy=()=>{if(!options.hold)setImmediate(req.close);return req;};req.setTimeout=()=>req;
  req.end=()=>setImmediate(()=>{const socket=new EventEmitter() as any;socket.remoteAddress=options.remote||'93.184.216.34';req.socket=socket;req.emit('socket',socket);socket.emit('connect');const response=Readable.from([body]) as any;response.statusCode=options.status||200;response.complete=true;response.headers=options.headers||{};response.once('close',()=>{if(!options.hold)req.close();});callback(response);});return req;
 }) as any};
}

test('fixed incoming XML and HTML parsing require real bounded strings/title/anchor and reject active false backlinks',()=>{
 const target='https://own.example.test/post/';assert.deepEqual(parseIncomingPing(rpc('https://source.example.test/?a=1&b=2',target)),['https://source.example.test/?a=1&b=2',target]);
 for(const xml of ['<!DOCTYPE a [<!ENTITY bad "x">]><methodCall/>','<methodCall>'+ '<x>'.repeat(10)+'</x>'.repeat(10)+'</methodCall>','<methodCall><methodName>system.multicall</methodName></methodCall>',pingRPC('pingback.ping',['x']),pingRPC('pingback.ping',['x','y']).replace('<string>x</string>','<int>1</int>'),'<methodCall x="x"/>','x'.repeat(16385)])assert.throws(()=>parseIncomingPing(Buffer.from(xml)));
 assert.throws(()=>parseIncomingPing(Buffer.from([255])));
 assert.equal(verifyPingHTML(Buffer.from('<title>É &amp; 标题</title><p>Before <a href="/post/">actual</a> after</p>'),'https://own.example.test/source',target).authorName,'É & 标题');
 for(const html of ['<title>Title</title><script><a href="'+target+'">fake</a></script>','<title>Title</title><style><a href="'+target+'">fake</a></style>','<title>Title</title><template><a href="'+target+'">fake</a></template>','<title>Title</title><div data-link="'+target+'">literal '+target+'</div>'])assert.throws(()=>verifyPingHTML(Buffer.from(html),'https://source.test/',target),failCode(17));
 assert.throws(()=>verifyPingHTML(Buffer.from('<a href="'+target+'">actual</a>'),'https://source.test/',target),failCode(32));
 assert.throws(()=>verifyPingHTML(Buffer.alloc(153601),'https://source.test/',target),failCode(16));
});

test('incoming typed notifications enforce public state, protocol, transaction, moderation, identity and portability',async t=>{
 const original=(await pool.query('SELECT data FROM settings WHERE id=1')).rows[0].data;
 const login=await api('/api/auth/login','POST',{login:process.env.ADMIN_EMAIL,password:process.env.ADMIN_PASSWORD},'');cookie=login.response.headers.get('set-cookie')!.split(';')[0];
 const beforeEnv=process.env.WORLDACT_ENVIRONMENT_TYPE;
 let calls=0,target='';let html='',throwTransport=false;
 const receive=createIncomingPings({environment:()=> 'production',http:async(url,input)=>{calls++;if(throwTransport)throw new Error('PRIVATE transport diagnostics');assert.equal(input?.redirects,0);assert.equal(input?.waitForPhysicalClose,true);assert.equal(input?.maxBodyBytes,153600);return {url,body:Buffer.from(html||`<title>Source &amp; title</title><p>Public context <a href="${target}">actual backlink</a> remainder</p>`),status:200,headers:{}};}});
 const app=express();app.use(createIncomingPingsRouter(receive));const server=createServer(app);await new Promise<void>(done=>server.listen(0,'127.0.0.1',done));const endpoint='http://127.0.0.1:'+(server.address() as any).port;
 const xml=async(source:string,destination=target)=>{const response=await fetch(endpoint+'/xmlrpc.php',{method:'POST',headers:{'Content-Type':'text/xml'},body:rpc(source,destination)});return {response,body:await response.text()};};
 try{
  await ok('/api/settings','PUT',{defaultPingStatus:'open',commentModeration:false,commentPreviouslyApproved:false,commentMaxLinks:0,notifyComments:false,notifyModeration:false,closeCommentsDays:0});
  const publicPost=await post();target=new URL(publicPost.permalink,(await getSettings()).siteUrl).href;
  await t.test('new post defaults are source open, pages closed, explicit fields and preexisting flags remain',async()=>{
   await ageOwnedAdmissions();
   assert.equal(publicPost.pingStatus,'open');assert.equal((await post({type:'page'})).pingStatus,'closed');const explicit=await post({pingStatus:'closed'});await ok('/api/settings','PUT',{defaultPingStatus:'closed'});assert.equal((await post()).pingStatus,'closed');assert.equal((await ok('/api/posts/'+publicPost.id)).post.pingStatus,'open');assert.equal((await ok('/api/posts/'+explicit.id)).post.pingStatus,'closed');await ok('/api/settings','PUT',{defaultPingStatus:'open'});
  });
  await t.test('local environment and closed, old, draft, private, protected or noncanonical targets never fetch',async()=>{
   await ageOwnedAdmissions();
   const local=createIncomingPings({environment:()=> 'local',http:async()=>{throw new Error('must not fetch');}});await assert.rejects(local({type:'pingback',source:'https://source.test/a',target,ip:'1.1.1.1'}),failCode(0));
   const count=calls;
   for(const input of [{pingStatus:'closed'},{status:'draft'},{status:'private'},{password:'protected-secret'}, {publishedAt:'2000-01-01T00:00:00Z'}]){
    const p=await post(input);if(input.publishedAt)await ok('/api/settings','PUT',{closeCommentsDays:1});await assert.rejects(receive({type:'pingback',source:'https://source.test/closed',target:new URL(p.permalink,(await getSettings()).siteUrl).href,ip:'1.1.1.1'}),failCode(33));await ok('/api/settings','PUT',{closeCommentsDays:0});
   }
   for(const bad of [target+'?secret=1',target.replace(/\/$/,'/2/'),'https://foreign.test/post/'])await assert.rejects(receive({type:'pingback',source:'https://source.test/a',target:bad,ip:'1.1.1.1'}),failCode(33));
   await assert.rejects(receive({type:'pingback',source:target,target,ip:'1.1.1.1'}),failCode(0));assert.equal(calls,count);
   const oldPage=await post({type:'page',pingStatus:'open',publishedAt:'2000-01-01T00:00:00Z'});assert.equal(pingsOpen({...oldPage,protected:false},{...await getSettings(),closeCommentsDays:1}),true);
   await ok('/api/settings','PUT',{closeCommentsDays:1});const pageTarget=new URL(oldPage.permalink,(await getSettings()).siteUrl).href;html=`<title>Old page source</title><a href="${pageTarget}">real</a>`;await receive({type:'pingback',source:'https://source.test/old-page',target:pageTarget,ip:'1.1.1.1'});html='';await ok('/api/settings','PUT',{closeCommentsDays:0});
   const localAPI=await fetch(base+'/xmlrpc.php',{method:'POST',body:rpc('https://source.test/local',target)});assert.equal(parsePingReply(Buffer.from(await localAPI.text())).fault,0);
  });
  await t.test('actual anonymous RPC response persists typed safe source identity and duplicates fault48',async()=>{
   await ageOwnedAdmissions();
   await resetAdmission();const result=await xml('https://SOURCE.example.test/one#fragment');assert.equal(result.response.status,200);assert.equal(parsePingReply(Buffer.from(result.body)).fault,null);assert.doesNotMatch(result.body,/Source &|private|protected-secret/);
   const c=(await pool.query('SELECT * FROM comments WHERE post_id=$1 AND type=$2',[publicPost.id,'pingback'])).rows[0];assert.equal(c.author_url,'https://source.example.test/one');assert.equal(c.author_email,'');assert.equal(c.user_id,null);assert.equal(c.author_name,'Source & title');assert.equal(c.status,'approved');assert.match(c.content,/actual backlink/);assert.equal(c.source_hash.length,64);
   assert.equal(parsePingReply(Buffer.from((await xml('https://source.example.test/one')).body)).fault,48);
   await ok('/api/comments','POST',{postId:publicPost.id,authorName:'Human URL',authorEmail:'human@example.test',authorUrl:'https://source.test/human-url',content:'Human',status:'approved'});assert.equal(parsePingReply(Buffer.from((await xml('https://source.test/human-url')).body)).fault,48);
   await ageOwnedAdmissions();const concurrent=await Promise.all([xml('https://source.example.test/race'),xml('https://source.example.test/race')]);assert.deepEqual(concurrent.map(r=>parsePingReply(Buffer.from(r.body)).fault).sort(),[48,null].sort());assert.equal((await pool.query("SELECT count(*)::int AS n FROM comments WHERE post_id=$1 AND author_url='https://source.example.test/race'",[publicPost.id])).rows[0].n,1);
  });
  await t.test('missing source title/backlink and a rolled-back insertion return only generic faults',async()=>{
   await ageOwnedAdmissions();
   await resetAdmission();
   for(const [page,code] of [[`<a href="${target}">No title</a>`,32],[`<title>Source</title><script><a href="${target}">fake</a></script>`,17]] as const){html=page;assert.equal(parsePingReply(Buffer.from((await xml('https://source.test/failure'+code)).body)).fault,code);}html='';
   throwTransport=true;const unavailable=(await xml('https://source.test/unavailable')).body;assert.equal(parsePingReply(Buffer.from(unavailable)).fault,0);assert.doesNotMatch(unavailable,/PRIVATE|transport diagnostics/);throwTransport=false;
   const count=(await pool.query('SELECT count(*)::int AS n FROM comments')).rows[0].n;
   await pool.query(`CREATE FUNCTION incoming_test_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.author_url='https://source.test/rollback' THEN RAISE EXCEPTION 'PRIVATE database detail'; END IF; RETURN NEW; END $$`);
   await pool.query('CREATE TRIGGER incoming_test_failure BEFORE INSERT ON comments FOR EACH ROW EXECUTE FUNCTION incoming_test_failure()');
   try{const response=await xml('https://source.test/rollback');assert.equal(parsePingReply(Buffer.from(response.body)).fault,0);assert.doesNotMatch(response.body,/PRIVATE|database detail/);assert.equal((await pool.query('SELECT count(*)::int AS n FROM comments')).rows[0].n,count);assert.equal((await pool.query('SELECT count(*)::int AS n FROM incoming_ping_leases')).rows[0].n,0);}finally{await pool.query('DROP TRIGGER incoming_test_failure ON comments');await pool.query('DROP FUNCTION incoming_test_failure()');}
  });
  await t.test('trackback protocol never fetches or authenticates claimed source identity and respects source excerpts',async()=>{
   await ageOwnedAdmissions();
   await resetAdmission();const before=calls;const response=await fetch(endpoint+'/wp-trackback.php?tb_id='+publicPost.id,{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded',Cookie:cookie},body:new URLSearchParams({url:'https://source.test/track',title:'<b>Title & caption</b>',excerpt:'<script>attack()</script> safe excerpt',blog_name:'Blog',charset:'UTF-8'})});assert.match(await response.text(),/<error>0<\/error>/);assert.equal(calls,before);
   const row=(await pool.query("SELECT * FROM comments WHERE post_id=$1 AND type='trackback'",[publicPost.id])).rows[0];assert.equal(row.author_name,'Blog');assert.equal(row.user_id,null);assert.equal(row.author_email,'');assert.doesNotMatch(row.content,/<script|<b>/);assert.match(row.content,/<strong>Title &amp; caption<\/strong>/);const rendered=await ok('/wp-json/wp/v2/comments/'+row.id);assert.match(rendered.content.rendered,/<p><strong>Title &amp; caption<\/strong><\/p>/);
   const flood=(await pool.query('SELECT author_ip,expires_at FROM comment_flood_metadata WHERE comment_id=$1',[row.id])).rows[0];assert.match(flood.author_ip,/127\.0\.0\.1/);assert.equal(flood.expires_at.getTime()-row.created_at.getTime(),3600000);assert.equal(row.updated_at.getTime(),row.created_at.getTime());
   await ageOwnedAdmissions();const pretty=await fetch(endpoint+publicPost.permalink+'trackback/',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({url:'https://source.test/pretty',title:'Pretty'})});assert.match(await pretty.text(),/<error>0<\/error>/);
  });
  await t.test('shared moderation, previous-human exclusion, disallowed trash and notification outbox apply',async()=>{
   await ageOwnedAdmissions();
   await resetAdmission();await ok('/api/settings','PUT',{commentPreviouslyApproved:true,notifyModeration:true});await receive({type:'pingback',source:'https://source.test/previous',target,ip:'1.1.1.1'});assert.equal((await pool.query("SELECT status FROM comments WHERE author_url='https://source.test/previous' AND post_id=$1",[publicPost.id])).rows[0].status,'pending');
   assert.ok((await pool.query("SELECT 1 FROM mail_outbox WHERE subject LIKE $1",['%'+stamp+'%'])).rowCount);
   await ageOwnedAdmissions();await ok('/api/settings','PUT',{commentPreviouslyApproved:false,notifyModeration:false,disallowedCommentKeys:'source.test/disallowed'});await receive({type:'trackback',source:'https://source.test/disallowed',title:'Title',target,ip:'1.1.1.1'});assert.equal((await pool.query("SELECT status FROM comments WHERE author_url='https://source.test/disallowed' AND post_id=$1",[publicPost.id])).rows[0].status,'trash');
   await ageOwnedAdmissions();await ok('/api/settings','PUT',{disallowedCommentKeys:'',commentModerationKeys:'source.test/moderate'});await receive({type:'trackback',source:'https://source.test/moderate',title:'Title',target,ip:'1.1.1.1'});assert.equal((await pool.query("SELECT status FROM comments WHERE author_url='https://source.test/moderate' AND post_id=$1",[publicPost.id])).rows[0].status,'pending');await ok('/api/settings','PUT',{commentModerationKeys:''});
   assert.equal(akismetFields({type:'pingback',userIP:'1.1.1.1',userAgent:'',referrer:'',authorName:'Source',authorEmail:'',authorURL:'https://source.test/',content:'context',permalink:target},'fake-key','https://site.test/').comment_type,'pingback');
  });
  await t.test('active Akismet receives the constrained ping type and its real verdict/metadata govern storage',async()=>{
   await ageOwnedAdmissions();
   await resetAdmission();const plugin=(await pool.query("SELECT * FROM extensions WHERE slug='akismet'")).rows[0],secret=(await pool.query("SELECT * FROM extension_secrets WHERE slug='akismet'")).rows[0];
   const settings=await getSettings();let fields:URLSearchParams|undefined;
   try{
    await pool.query("UPDATE extensions SET enabled=true,settings='{\"sendComments\":true}' WHERE slug='akismet'");
    await pool.query("INSERT INTO extension_secrets(slug,api_key,verified_site_url,verified_at) VALUES('akismet','fakeIncomingKey123',$1,now()) ON CONFLICT(slug) DO UPDATE SET api_key=excluded.api_key,verified_site_url=excluded.verified_site_url,verified_at=excluded.verified_at,updated_at=now()",[new URL(settings.siteUrl).href]);
    const receiveSpam=createIncomingPings({environment:()=> 'production',http:async url=>({url,status:200,headers:{},body:Buffer.from(`<title>Source</title><a href="${target}">real</a>`)}),akismet:createAkismetClient((async(_url,init)=>{fields=init?.body as URLSearchParams;return new Response('true');}) as typeof fetch)});
    await receiveSpam({type:'pingback',source:'https://source.test/akismet',target,ip:'1.1.1.7',userAgent:'Incoming mock agent'});assert.equal(fields?.get('comment_type'),'pingback');assert.equal(fields?.get('comment_author_email'),'');
    const row=(await pool.query("SELECT c.status,m.verdict,m.user_ip FROM comments c JOIN akismet_comment_checks m ON m.comment_id=c.id WHERE c.author_url='https://source.test/akismet' AND c.post_id=$1",[publicPost.id])).rows[0];assert.equal(row.status,'spam');assert.equal(row.verdict,'spam');assert.equal(row.user_ip,'1.1.1.7');
   }finally{
    await pool.query("UPDATE extensions SET enabled=$1,settings=$2 WHERE slug='akismet'",[plugin.enabled,plugin.settings]);await pool.query("DELETE FROM extension_secrets WHERE slug='akismet'");if(secret)await pool.query('INSERT INTO extension_secrets(slug,api_key,verified_site_url,verified_at,last_error_code,updated_at) VALUES($1,$2,$3,$4,$5,$6)',[secret.slug,secret.api_key,secret.verified_site_url,secret.verified_at,secret.last_error_code,secret.updated_at]);
   }
  });
  await t.test('no pooled client during verification; two pending slots and changed target/settings are fenced',async()=>{
   await ageOwnedAdmissions();
   await resetAdmission();let entered!:()=>void,release!:()=>void;const started=new Promise<void>(done=>entered=done),blocked=new Promise<void>(done=>release=done);
   const held=createIncomingPings({environment:()=> 'production',http:async url=>{entered();await blocked;return {url,status:200,headers:{},body:Buffer.from(`<title>Held</title><a href="${target}">link</a>`)};}});
   const pending=held({type:'pingback',source:'https://source.test/held',target,ip:'1.1.1.2'});const rejected=assert.rejects(pending,failCode(33));await started;
   const clients=await Promise.all(Array.from({length:10},()=>pool.connect()));clients.forEach(client=>client.release());await ok('/api/posts/'+publicPost.id,'PUT',{pingStatus:'closed'});release();await rejected;assert.equal((await pool.query('SELECT count(*)::int AS n FROM incoming_ping_leases')).rows[0].n,0);await ok('/api/posts/'+publicPost.id,'PUT',{pingStatus:'open'});
   let count=0,releaseAll!:()=>void,ready!:()=>void;const barrier=new Promise<void>(done=>releaseAll=done),both=new Promise<void>(done=>ready=done);const capacity=createIncomingPings({environment:()=> 'production',http:async url=>{if(++count===2)ready();await barrier;return {url,status:200,headers:{},body:Buffer.from(`<title>Capacity</title><a href="${target}">link</a>`)};}});
   const first=capacity({type:'pingback',source:'https://source.test/cap1',target,ip:'1.1.1.3'}),second=capacity({type:'pingback',source:'https://source.test/cap2',target,ip:'1.1.1.4'});await both;await assert.rejects(capacity({type:'pingback',source:'https://source.test/cap3',target,ip:'1.1.1.5'}),failCode(0));await ok('/api/settings','PUT',{commentModeration:true});releaseAll();const results=await Promise.allSettled([first,second]);assert.ok(results.every(r=>r.status==='rejected'));assert.equal(count,2);await ok('/api/settings','PUT',{commentModeration:false});
  });
  await t.test('expired admission never stores stale verification and pending admission cannot grow past sixteen',async()=>{
   await ageOwnedAdmissions();
   await resetAdmission();let started!:()=>void,release!:()=>void;const entered=new Promise<void>(done=>started=done),barrier=new Promise<void>(done=>release=done);const stale=createIncomingPings({environment:()=> 'production',http:async url=>{started();await barrier;return {url,status:200,headers:{},body:Buffer.from(`<title>Expired</title><a href="${target}">actual</a>`)};}});
   const pending=stale({type:'pingback',source:'https://source.test/stale-lease',target,ip:'1.1.1.12'}),rejected=assert.rejects(pending,failCode(0));await entered;await pool.query("UPDATE incoming_ping_leases SET expires_at=now()-interval '1 second'");release();await rejected;assert.equal((await pool.query("SELECT count(*)::int AS n FROM comments WHERE author_url='https://source.test/stale-lease'")).rows[0].n,0);
   const blocker=await pool.connect();let waiting:Promise<void>|undefined;
   try{
    await blocker.query('BEGIN');await blocker.query("SELECT pg_advisory_xact_lock(hashtext('worldact-comment-hierarchy'))");
    waiting=receive({type:'trackback',source:'https://source.test/lock-expiry',title:'Expired after lock',target,ip:'1.1.1.16'});const refused=assert.rejects(waiting,failCode(0));let waiter:number|undefined;
    for(let i=0;i<100;i++){const row=(await pool.query("SELECT pid FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid() AND wait_event_type='Lock' AND query LIKE '%worldact-comment-hierarchy%'")).rows[0];if(row){waiter=row.pid;break;}await new Promise(resolve=>setTimeout(resolve,10));}
    assert.ok(waiter,'receiver must reach its real final transaction lock wait');await pool.query('UPDATE incoming_ping_leases SET expires_at=clock_timestamp()');
    assert.equal((await pool.query('SELECT bool_and(l.expires_at>a.xact_start) AS expires_after_start FROM incoming_ping_leases l CROSS JOIN pg_stat_activity a WHERE a.pid=$1',[waiter])).rows[0].expires_after_start,true);
    await blocker.query('COMMIT');await refused;assert.equal((await pool.query("SELECT count(*)::int AS n FROM comments WHERE author_url='https://source.test/lock-expiry'")).rows[0].n,0);
   }finally{await blocker.query('ROLLBACK');blocker.release();await waiting?.catch(()=>{});}
   const clients=await Promise.all(Array.from({length:10},()=>pool.connect()));const requests=Array.from({length:16},(_,i)=>receive({type:'pingback' as const,source:'https://source.test/pending-'+i,target,ip:'1.1.1.13'}));const settled=Promise.allSettled(requests);
   try{
    await assert.rejects(receive({type:'pingback',source:'https://source.test/seventeenth',target,ip:'1.1.1.14'}),failCode(0));
    const rejectedTrackback=await fetch(endpoint+'/wp-trackback.php?tb_id='+publicPost.id,{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({url:'https://source.test/pending-trackback',title:'Bounded'}),signal:AbortSignal.timeout(2500)});assert.match(await rejectedTrackback.text(),/<error>1<\/error>/);
   }finally{clients.forEach(client=>client.release());await settled;}
   await ageOwnedAdmissions();await resetAdmission();await receive({type:'trackback',source:'https://source.test/after-pending',title:'Recovered',target,ip:'1.1.1.15'});assert.equal((await pool.query('SELECT count(*)::int AS n FROM incoming_ping_leases')).rows[0].n,0);
  });
  await t.test('target locking precedes settings and cannot cycle with content deletion image-setting cleanup',async()=>{
   await ageOwnedAdmissions();
   await resetAdmission();const p=await post(),destination=new URL(p.permalink,(await getSettings()).siteUrl).href,blocker=await pool.connect();let waiting:Promise<void>|undefined;
   try{
    await blocker.query('BEGIN');await blocker.query('SELECT id FROM posts WHERE id=$1 FOR UPDATE',[p.id]);
    waiting=receive({type:'trackback',source:'https://source.test/post-settings-lock',title:'Lock order',target:destination,ip:'1.1.1.17'});const refused=assert.rejects(waiting,failCode(33));let blocked=false;
    for(let i=0;i<100;i++){if((await pool.query("SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid() AND wait_event_type='Lock' AND query LIKE '%FROM posts WHERE id=$1 FOR SHARE'")).rowCount){blocked=true;break;}await new Promise(resolve=>setTimeout(resolve,10));}
    assert.ok(blocked,'receiver must wait for the actual target row before settings');
    await blocker.query('UPDATE settings SET data=data WHERE id=1');await blocker.query("UPDATE posts SET ping_status='closed' WHERE id=$1",[p.id]);await blocker.query('COMMIT');await refused;assert.equal((await pool.query("SELECT count(*)::int AS n FROM comments WHERE post_id=$1",[p.id])).rows[0].n,0);
   }finally{await blocker.query('ROLLBACK');blocker.release();await waiting?.catch(()=>{});}
  });
  await t.test('source and target rate buckets resist rotating IPs and prune bounded hashed history',async()=>{
   await ageOwnedAdmissions();
   await resetAdmission();const source='https://source.test/source-limit';await pool.query("INSERT INTO incoming_ping_rates(key,window_start,count) VALUES(encode(sha256(convert_to($1,'UTF8')),'hex'),date_trunc('hour',now()),9)",['source:'+source]);
   await receive({type:'trackback',source,title:'First',target,ip:'2.2.2.1'});const other=await post(),otherTarget=new URL(other.permalink,(await getSettings()).siteUrl).href;const before=calls;await assert.rejects(receive({type:'pingback',source,target:otherTarget,ip:'2.2.2.2'}),failCode(0));assert.equal(calls,before);
   await ageOwnedAdmissions();await resetAdmission();await pool.query("INSERT INTO incoming_ping_rates(key,window_start,count) VALUES(encode(sha256(convert_to($1,'UTF8')),'hex'),date_trunc('hour',now()),99)",['target:'+publicPost.id]);await receive({type:'trackback',source:'https://source.test/target-limit-1',title:'First',target,ip:'2.2.3.1'});await assert.rejects(receive({type:'pingback',source:'https://source.test/target-limit-2',target,ip:'2.2.3.2'}),failCode(0));assert.equal(calls,before);
   await ageOwnedAdmissions();await resetAdmission();await pool.query("INSERT INTO incoming_ping_rates(key,window_start,count) SELECT encode(sha256(convert_to('expired-'||n,'UTF8')),'hex'),now()-interval '2 hours',1 FROM generate_series(1,1000) n");await receive({type:'trackback',source:'https://source.test/prune',title:'Prune',target,ip:'2.2.4.1'});const rates=(await pool.query('SELECT key,window_start,count FROM incoming_ping_rates')).rows;assert.equal(rates.length,4);assert.ok(rates.every(row=>/^[a-f0-9]{64}$/.test(row.key)));assert.equal((await pool.query("SELECT count(*)::int AS n FROM incoming_ping_rates WHERE window_start<date_trunc('hour',now())")).rows[0].n,0);
  });
  await t.test('persistent rates, malformed/oversized protocol and human-forged types fail without private details',async()=>{
   await ageOwnedAdmissions();
   await resetAdmission();await pool.query("INSERT INTO incoming_ping_rates(key,window_start,count) VALUES(encode(sha256(convert_to('ip:1.1.1.6','UTF8')),'hex'),date_trunc('hour',now()),30)");const before=calls;await assert.rejects(receive({type:'pingback',source:'https://source.test/rate',target,ip:'1.1.1.6'}),failCode(0));assert.equal(calls,before);
   for(const body of [Buffer.from('<!DOCTYPE a><methodCall/>'),Buffer.alloc(17000,65),Buffer.from('<methodCall><methodName>system.multicall</methodName></methodCall>')]){const response=await fetch(endpoint+'/xmlrpc.php',{method:'POST',body});const text=await response.text();assert.match(text,/faultCode/);assert.doesNotMatch(text,/DOCTYPE|system.multicall|stack|127.0.0.1/);}
   const wrongMethod=await fetch(endpoint+'/xmlrpc.php');assert.equal(wrongMethod.status,405);assert.equal(wrongMethod.headers.get('allow'),'POST');assert.equal(parsePingReply(Buffer.from(await wrongMethod.text())).fault,-32600);
   const human=await api('/api/public/comments','POST',{postId:publicPost.id,authorName:'Human',authorEmail:'human@example.test',content:'Body',type:'pingback'},'');assert.equal(human.response.status,400);
   const native=await api('/wp-json/wp/v2/comments','POST',{post:publicPost.id,content:'Body',type:'pingback'});assert.equal(native.response.status,400);
  });
  await t.test('typed native/admin filters, public mixed counts and JSON/WXR fresh-ID copies agree',async()=>{
   await ageOwnedAdmissions();
   const human=await ok('/api/comments','POST',{postId:publicPost.id,authorName:'Human',authorEmail:'human@example.test',content:'Human body',status:'approved'});assert.equal(human.comment.type,'comment');
   const mixed=await ok('/api/public/posts/'+publicPost.slug,'GET',undefined,'');assert.ok(mixed.comments.some((c:any)=>c.type==='pingback'));assert.ok(mixed.comments.some((c:any)=>c.type==='trackback'));assert.equal(mixed.commentsPagination.totalComments,mixed.comments.length);
   const only=await ok('/api/comments?type=pingback&postId='+publicPost.id);assert.ok(only.comments.every((c:any)=>c.type==='pingback'));
   const native=await ok('/wp-json/wp/v2/comments?post='+publicPost.id);assert.ok(native.every((c:any)=>c.type==='comment'));assert.equal((await api('/wp-json/wp/v2/comments?type=pingback','GET',undefined,'')).response.status,401);const pings=await ok('/wp-json/wp/v2/comments?type=pingback&post='+publicPost.id);assert.ok(pings.every((c:any)=>c.type==='pingback'));
   const ping=pings[0];assert.equal((await api('/wp-json/wp/v2/comments/'+ping.id,'PUT',{type:'comment',content:'Cannot convert'})).response.status,400);assert.equal((await ok('/wp-json/wp/v2/comments/'+ping.id,'PUT',{type:'pingback',content:ping.content.rendered})).type,'pingback');
   const defaultEdit=await ok('/wp-json/wp/v2/comments?context=edit&post='+publicPost.id);assert.ok(defaultEdit.every((c:any)=>c.type==='comment'&&c.status==='approved'));
   const archive=await ok('/api/tools/export');const copy={application:'WorldAct',version:3,posts:archive.posts.filter((p:any)=>p.id===publicPost.id),comments:archive.comments.filter((c:any)=>c.post_id===publicPost.id)};const imported=await ok('/api/tools/import','POST',copy);posts.push(...imported.postIds);const rows=(await pool.query('SELECT type,author_email,user_id FROM comments WHERE post_id=$1',[imported.postIds[0]])).rows;assert.ok(rows.some(r=>r.type==='pingback'));assert.ok(rows.filter(r=>r.type!=='comment').every(r=>r.author_email===''&&r.user_id===null));
   const response=await fetch(base+'/api/tools/export?format=wxr',{headers:{Cookie:cookie}}),wxr=await response.text();assert.match(wxr,/<wp:comment_type>pingback<\/wp:comment_type>/);const copied=await ok('/api/tools/import','POST',{format:'wxr',xml:wxr});posts.push(...copied.postIds);assert.ok((await pool.query("SELECT 1 FROM comments WHERE post_id=ANY($1::int[]) AND type='trackback'",[copied.postIds])).rowCount);
   const before=(await pool.query('SELECT count(*)::int AS n FROM posts')).rows[0].n;const bad=await api('/api/tools/import','POST',{...copy,comments:[copy.comments.find((c:any)=>c.type==='pingback'),{...copy.comments.find((c:any)=>c.type==='pingback'),id:2147483000}]});assert.equal(bad.response.status,409);assert.equal((await pool.query('SELECT count(*)::int AS n FROM posts')).rows[0].n,before);
  });
  await t.test('typed moderation preserves owner permissions and keeps public and foreign account fields private',async()=>{
   await ageOwnedAdmissions();
   await resetAdmission();const people:Record<string,{id:number;cookie:string}>={};
   for(const role of ['author','subscriber']){const email=stamp+'-'+role+'@example.test',person=(await ok('/api/users','POST',{username:stamp+'-'+role,email,displayName:role,role,password:'Temporary-safe-password123!'})).user;users.push(person.id);const login=await api('/api/auth/login','POST',{login:email,password:'Temporary-safe-password123!'},'');people[role]={id:person.id,cookie:login.response.headers.get('set-cookie')!.split(';')[0]};}
   const own=await post({authorId:people.author.id}),ownTarget=new URL(own.permalink,(await getSettings()).siteUrl).href;html=`<title>Owned ping</title><a href="${ownTarget}">actual</a>`;await receive({type:'pingback',source:'https://source.test/author-owned',target:ownTarget,ip:'1.1.1.8'});html='';const owned=(await pool.query("SELECT id FROM comments WHERE post_id=$1 AND type='pingback'",[own.id])).rows[0];
   assert.equal((await api('/api/comments/'+owned.id,'PUT',{status:'pending'},people.author.cookie)).response.status,200);
   const foreign=(await pool.query("SELECT id FROM comments WHERE post_id=$1 AND type='pingback' AND status='approved' LIMIT 1",[publicPost.id])).rows[0];assert.equal((await api('/api/comments/'+foreign.id,'PUT',{status:'spam'},people.author.cookie)).response.status,403);
   const list=await ok('/api/comments?type=pingback&postId='+publicPost.id,'GET',undefined,people.author.cookie);assert.ok(list.comments.every((c:any)=>c.authorEmail===undefined&&c.userId===undefined&&!c.permissions.edit));
   assert.equal((await api('/wp-json/wp/v2/comments?type=pingback','GET',undefined,people.subscriber.cookie)).response.status,403);const publicList=await ok('/wp-json/wp/v2/comments?type=pingback&post='+publicPost.id,'GET',undefined,people.author.cookie);assert.ok(publicList.every((c:any)=>c.author_email===undefined));
  });
  await t.test('X-Pingback appears on real production singular HTTP responses only for public open unprotected targets',async()=>{
   await ageOwnedAdmissions();
   const settings=await getSettings(),directory=await mkdtemp(path.join(tmpdir(),'worldact-incoming-static-')),oldStatic=process.env.STATIC_DIR;
   await writeFile(path.join(directory,'index.html'),await readFile(path.join(rootDir,'dist','index.html')));process.env.STATIC_DIR=directory;
   const {app:actual}=await import('../server/index.js'),http=createServer(actual);await new Promise<void>(done=>http.listen(0,'127.0.0.1',done));const url='http://127.0.0.1:'+(http.address() as any).port;
   try{
    process.env.WORLDACT_ENVIRONMENT_TYPE='production';assert.equal(pingbackHeader(publicPost,settings),new URL('/xmlrpc.php',settings.siteUrl).href);
    for(const route of ['/api/public/posts/'+publicPost.slug,publicPost.permalink]){const response=await fetch(url+route);assert.equal(response.status,200,route);assert.equal(response.headers.get('x-pingback'),new URL('/xmlrpc.php',settings.siteUrl).href);}
    const protectedPost=await post({password:'protected-header'});assert.equal((await fetch(url+'/api/public/posts/'+protectedPost.slug)).headers.get('x-pingback'),null);
    for(const p of [{...publicPost,pingStatus:'closed'},{...publicPost,status:'private'},{...publicPost,hasPassword:true}])assert.equal(pingbackHeader(p,settings),null);
    process.env.WORLDACT_ENVIRONMENT_TYPE='local';assert.equal((await fetch(url+publicPost.permalink)).headers.get('x-pingback'),null);
   }finally{await new Promise<void>(done=>http.close(()=>done()));await rm(directory,{recursive:true,force:true});if(oldStatic===undefined)delete process.env.STATIC_DIR;else process.env.STATIC_DIR=oldStatic;process.env.WORLDACT_ENVIRONMENT_TYPE='local';}
  });
 }finally{await new Promise<void>(done=>server.close(()=>done()));if(beforeEnv===undefined)delete process.env.WORLDACT_ENVIRONMENT_TYPE;else process.env.WORLDACT_ENVIRONMENT_TYPE=beforeEnv;await pool.query('DELETE FROM posts WHERE id=ANY($1::int[])',[posts]);await pool.query('DELETE FROM users WHERE id=ANY($1::int[])',[users]);await resetAdmission();await pool.query('DELETE FROM mail_outbox WHERE subject LIKE $1',['%'+stamp+'%']);await pool.query('UPDATE settings SET data=$1::jsonb WHERE id=1',[JSON.stringify(original)]);await api('/api/auth/logout','POST',{});}
});

test('receiver pinned fetch rejects DNS/peer/redirect/decode attacks and waits through physical close',async()=>{
 const dns=async()=>[{address:'93.184.216.34',family:4}];
 for(const addresses of [[{address:'10.0.0.1',family:4}],[{address:'::ffff:127.0.0.1',family:6}],[{address:'93.184.216.34',family:4},{address:'127.0.0.1',family:4}]]){const f=fixture(Buffer.from('x'));await assert.rejects(createPublicHTTPTransport({resolve:async()=>addresses,request:f.requestFn})('https://source.test/',{redirects:0,waitForPhysicalClose:true}));assert.equal(f.seen.length,0);}
 for(const f of [fixture(Buffer.from('x'),{remote:'127.0.0.1'}),fixture(Buffer.from('x'),{status:302,headers:{location:'https://redirect.test/'}}),fixture(gzipSync(Buffer.alloc(153601)),{headers:{'content-encoding':'gzip'}})])await assert.rejects(createPublicHTTPTransport({resolve:dns,request:f.requestFn})('https://source.test/',{redirects:0,maxBodyBytes:153600,maxWireBytes:153600,waitForPhysicalClose:true}));
 const f=fixture(Buffer.from('<title>Done</title>'),{hold:true});let done=false;const pending=createPublicHTTPTransport({resolve:dns,request:f.requestFn})('https://source.test/',{waitForPhysicalClose:true}).then(()=>{done=true;});while(!f.request?.socket)await new Promise(resolve=>setImmediate(resolve));await new Promise(resolve=>setImmediate(resolve));assert.equal(done,false);f.request.close();await pending;assert.equal(done,true);
});
