import { createHash, randomUUID } from 'node:crypto';
import { Router } from 'express';
import type { Pool, PoolClient } from 'pg';
import { pool, getSettings } from './db.js';
import { requireRole } from './auth.js';
import { HttpError } from './utils.js';
import { postPermalink } from './permalinks.js';
import { normalizePublicURL } from './public-http.js';
import { pingEnvironment, type PingEnvironment } from './outgoing-ping-settings.js';
import { createPingProtocol, pingTargets, PingProtocolError } from './ping-protocol.js';
const hash=(target:string)=>createHash('sha256').update(target).digest('hex');
export type PingJob={id:string;kind:'discover'|'pingback'|'service';post_id:number|null;target:string;generation:number;attempts:number;lease_token:string};
export type PingDatabase=Pick<Pool,'query'|'connect'>;
const terminal="('sent','failed','suppressed')";
/** Called only inside the publication transaction. JSON/WXR imports never call this helper. */
export async function enqueuePublicationPings(client:PoolClient,postId:number,environment:PingEnvironment=pingEnvironment()){
 const post=(await client.query("SELECT id,type,status,password_hash IS NOT NULL AS protected FROM posts WHERE id=$1",[postId])).rows[0];
 if(!post || post.type!=='post' || post.status!=='publish')return;
 const settings=await getSettings(client);
 await client.query("SELECT pg_advisory_xact_lock(hashtext('worldact-outgoing-queue'))");
 await pruneOutgoingPings(client);
 const state=environment==='production'?'pending':'suppressed';
 await upsert(client,'discover',post.id,'',state,environment!=='production'?'environment':!settings.defaultPingbackFlag?'preference':post.protected?'protected':'');
 for(const target of settings.pingServices)await upsert(client,'service',post.id,target,state,environment!=='production'?'environment':settings.discourageSearchEngines?'visibility':'');
 await pruneOutgoingPings(client);
}
async function upsert(client:PoolClient,kind:PingJob['kind'],postId:number,target:string,state:string,outcome=''){
 if(outcome)state='suppressed';
 const key=kind+':'+(kind==='service'?'':postId+':')+hash(target);
 await client.query(`INSERT INTO outgoing_ping_jobs(dedupe_key,kind,post_id,target,state,outcome) VALUES($1,$2,$3,$4,$5,$6)
 ON CONFLICT(dedupe_key) DO UPDATE SET post_id=excluded.post_id,generation=outgoing_ping_jobs.generation+1,
 state=CASE WHEN outgoing_ping_jobs.state='running' THEN 'running' ELSE excluded.state END,
 outcome=excluded.outcome,attempts=0,due_at=now(),updated_at=now()`,[key,kind,kind==='service'?null:postId,target,state,outcome]);
 // Bound both active backlog and terminal history. Rollback content as well if the durable outbox cannot accept it.
 if((await client.query("SELECT count(*)::int AS n FROM outgoing_ping_jobs WHERE state IN ('pending','running')")).rows[0].n>5000)throw new HttpError(503,'Publication notifications are busy. Please try again later.');
}
export async function pruneOutgoingPings(db:Pick<Pool,'query'>|PoolClient=pool){
 await db.query(`DELETE FROM outgoing_ping_jobs WHERE state IN ${terminal} AND (updated_at<now()-interval '30 days' OR id IN (SELECT id FROM outgoing_ping_jobs WHERE state IN ${terminal} ORDER BY updated_at DESC,id DESC OFFSET 10000))`);
}
export async function claimOutgoingPings(db:PingDatabase=pool,limit=2):Promise<PingJob[]>{
 const client=await db.connect();
 try{
  await client.query('BEGIN');
  // Coordinate the two dispatch slots across processes as well as ticks.
  await client.query("SELECT pg_advisory_xact_lock(hashtext('worldact-outgoing-workers'))");
  await client.query("UPDATE outgoing_ping_jobs SET state='failed',outcome='lease_exhausted',lease_token=NULL,lease_until=NULL,updated_at=now() WHERE state='running' AND lease_until<=now() AND attempts>=3");
  const running=(await client.query("SELECT count(*)::int AS n FROM outgoing_ping_jobs WHERE state='running' AND lease_until>now()")).rows[0].n;
  const capacity=Math.max(0,Math.min(2-running,limit));
  const token=randomUUID();
  const rows=await client.query<PingJob>(`UPDATE outgoing_ping_jobs j SET state='running',attempts=j.attempts+1,lease_token=$1,lease_until=now()+interval '90 seconds',updated_at=now() FROM
   (SELECT id FROM outgoing_ping_jobs WHERE attempts<3 AND ((state='pending' AND due_at<=now()) OR (state='running' AND lease_until<=now())) ORDER BY due_at,id FOR UPDATE SKIP LOCKED LIMIT $2) ready WHERE j.id=ready.id RETURNING j.*`,[token,capacity]);
  await client.query('COMMIT');return rows.rows;
 }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
}
export async function finishOutgoingPing(job:PingJob,state:'sent'|'suppressed'|'failed'|'pending',outcome:string,db:PingDatabase=pool){
 await db.query(`UPDATE outgoing_ping_jobs SET state=CASE WHEN generation<>$3 THEN 'pending' ELSE $4 END,
 outcome=CASE WHEN generation<>$3 THEN '' ELSE $5 END,attempts=CASE WHEN generation<>$3 THEN 0 ELSE attempts END,
 due_at=CASE WHEN generation<>$3 THEN now() ELSE now()+make_interval(secs=>least(3600,30*power(2,attempts)::int)) END,
 lease_token=NULL,lease_until=NULL,updated_at=now() WHERE id=$1 AND state='running' AND lease_token=$2`,[job.id,job.lease_token,job.generation,state,outcome]);
}
type Protocol=ReturnType<typeof createPingProtocol>;
export function createOutgoingPingWorker(options:{db?:PingDatabase;protocol?:Protocol;environment?:()=>PingEnvironment}={}){
 const db=options.db || pool,protocol=options.protocol || createPingProtocol(),environment=options.environment || pingEnvironment;
 // One singleton worker in the server; separate internal instances still share the two physical leases below.
 async function process(job:PingJob){
  try{
   if(environment()!=='production'){await finishOutgoingPing(job,'suppressed','environment',db);return;}
   const settings=await getSettings(db);
   const suppress=async(reason:string)=>finishOutgoingPing(job,'suppressed',reason,db);
   let home:URL;
   try{home=normalizePublicURL(settings.siteUrl);}catch{await suppress('site_url');return;}
   const origins=new Set([home.origin]);
   try{if(processEnvOrigin())origins.add(new URL(processEnvOrigin()!).origin);}catch{}
   if(job.kind==='service'){
    if(settings.discourageSearchEngines || !settings.pingServices.includes(job.target)){await suppress(settings.discourageSearchEngines?'visibility':'service_removed');return;}
    // Site-level coalescing cannot bind to the newest post: deleting that one
    // must not erase notification of another publication. Recheck the site's
    // current public post set without selecting any content or private title.
    if(!(await db.query("SELECT 1 FROM posts WHERE type='post' AND status='publish' LIMIT 1")).rowCount){await suppress('not_published');return;}
    await protocol.service(job.target,settings.siteTitle,new URL(home.pathname.replace(/\/$/,'')+'/',home).href,new URL('/feed/',home).href,origins);
    await finishOutgoingPing(job,'sent','delivered',db);return;
   }
   const row=(await db.query(`SELECT p.id,p.type,p.status,p.slug,p.parent_id AS "parentId",(p.password_hash IS NOT NULL) AS protected,
    CASE WHEN p.status='publish' AND p.password_hash IS NULL THEN p.raw_content ELSE '' END AS "rawContent",
    CASE WHEN p.status='publish' AND p.password_hash IS NULL THEN p.content ELSE '' END AS content,
    COALESCE((SELECT json_agg(json_build_object('taxonomy',t.taxonomy,'slug',t.slug) ORDER BY t.name,t.id) FROM post_terms pt JOIN terms t ON t.id=pt.term_id WHERE pt.post_id=p.id),'[]'::json) AS terms
    FROM posts p WHERE p.id=$1`,[job.post_id])).rows[0];
   if(!row || row.type!=='post' || row.status!=='publish'){await suppress('not_published');return;}
   if(!settings.defaultPingbackFlag){await suppress('preference');return;}
   // Stricter than source: never discover stored URLs or notify destinations from a protected body.
   if(row.protected){await suppress('protected');return;}
   const source=new URL(await postPermalink(row,settings,db),home).href;
   if(job.kind==='discover'){
    const targets=pingTargets(row.rawContent || row.content,source,home.href);
    const client=await db.connect();
    try{
     await client.query('BEGIN');
     // Writers lock the post before the queue; keep the same order for the FK
     // inserted by discovered jobs, avoiding post/queue advisory-lock inversion.
     await client.query('SELECT id FROM posts WHERE id=$1 FOR KEY SHARE',[row.id]);
     await client.query("SELECT pg_advisory_xact_lock(hashtext('worldact-outgoing-queue'))");
     // Do not let a reclaimed/stale discover lease create new work.
     if((await client.query("SELECT id FROM outgoing_ping_jobs WHERE id=$1 AND lease_token=$2 AND state='running' AND generation=$3 FOR UPDATE",[job.id,job.lease_token,job.generation])).rowCount){
      for(const target of targets){
       // Own-site pings need a dedicated internal public resolver; never loop back through HTTP.
       if(origins.has(new URL(target).origin))continue;
       if(!(await client.query('SELECT 1 FROM outgoing_ping_sent WHERE post_id=$1 AND target_hash=$2',[row.id,hash(target)])).rowCount)
        await upsert(client,'pingback',row.id,target,'pending');
      }
     }
     await client.query('COMMIT');
    }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
    await finishOutgoingPing(job,'sent','discovered',db);return;
   }
   if(job.kind==='pingback'){
    // Removed links and sent duplicates are checked against current canonical content before I/O.
    if(!pingTargets(row.rawContent || row.content,source,home.href).includes(job.target)){await suppress('link_removed');return;}
    if((await db.query('SELECT 1 FROM outgoing_ping_sent WHERE post_id=$1 AND target_hash=$2',[row.id,hash(job.target)])).rowCount){await finishOutgoingPing(job,'sent','already_sent',db);return;}
    const result=await protocol.pingback(job.target,source,origins);
    if(result==='no_endpoint'){await suppress('no_endpoint');return;}
    // A stale lease may have succeeded remotely; only its current owner can record local success.
    await db.query(`INSERT INTO outgoing_ping_sent(post_id,target_hash) SELECT post_id,$3 FROM outgoing_ping_jobs WHERE id=$1 AND state='running' AND lease_token=$2 ON CONFLICT DO NOTHING`,[job.id,job.lease_token,hash(job.target)]);
   }
   await finishOutgoingPing(job,'sent','delivered',db);
  }catch(error){
   const permanent=error instanceof PingProtocolError && ['invalid_endpoint','too_many_links'].includes(error.outcome);
   await finishOutgoingPing(job,permanent || job.attempts>=3?'failed':'pending',error instanceof PingProtocolError?error.outcome:'unavailable',db);
  }
 }
 return {
  async runOnce(){
   if(activeWorkers>=2)return 0;
   const reserved=Math.min(2,2-activeWorkers);activeWorkers+=reserved;
   try{const jobs=await claimOutgoingPings(db,reserved);const results=await Promise.allSettled(jobs.map(process));
    if(results.some(result=>result.status==='rejected'))throw new Error('Publication notification finalization failed.');
    await pruneOutgoingPings(db);return jobs.length;}finally{activeWorkers-=reserved;}
  },
 };
}
function processEnvOrigin(){return process.env.APP_ORIGIN;}
let activeWorkers=0;
export function startOutgoingPingWorker(intervalMs=5000){
 // Local enqueue/retry paths already create suppressed rows. Drain prior production
 // leases once on startup; there is no periodic network work in a local process.
 if(pingEnvironment()!=='production'){
  void pool.query("UPDATE outgoing_ping_jobs SET state='suppressed',outcome='environment',lease_token=NULL,lease_until=NULL,updated_at=now() WHERE state IN ('pending','running')").catch(()=>console.error('Publication notification suppression failed.'));
  return ()=>{};
 }
 const worker=createOutgoingPingWorker();let stopped=false;
 const run=()=>{if(!stopped)void worker.runOnce().catch(()=>console.error('Publication notification processing failed.'));};
 run();const timer=setInterval(run,intervalMs);timer.unref();return ()=>{stopped=true;clearInterval(timer);};
}
const router=Router();
router.get('/tools/outgoing-pings',requireRole('administrator'),async(_req,res)=>{
 res.setHeader('Cache-Control','no-store');
 const counts=(await pool.query('SELECT state,count(*)::int AS count FROM outgoing_ping_jobs GROUP BY state')).rows;
 const jobs=(await pool.query('SELECT id,kind,post_id AS "postId",state,outcome,attempts,updated_at AS "updatedAt" FROM outgoing_ping_jobs ORDER BY updated_at DESC,id DESC LIMIT 100')).rows;
 res.json({environment:pingEnvironment(),dispatchEnabled:pingEnvironment()==='production',counts,jobs});
});
export default router;
