import {pingsOpen} from "./incoming-ping-policy.js";
export {pingsOpen,pingbackHeader} from "./incoming-ping-policy.js";
import express from 'express';
import type {Request,Response} from 'express';
import type pg from 'pg';
import {randomUUID,createHash} from 'node:crypto';
import {Parser} from 'htmlparser2';
import {XMLParser,XMLValidator} from 'fast-xml-parser';
import {pool,getSettings} from './db.js';
import {normalizePublicURL,publicHTTP} from './public-http.js';
import {pingEnvironment,type PingEnvironment} from './outgoing-ping-settings.js';
import {resolvePublicPath,postPermalink} from './permalinks.js';
import {cleanContent,plainText} from './utils.js';
import {moderateComment,type CommentType} from './comment-policy.js';
import {checkAkismetComment,recordAkismetCheck,createAkismetClient,type AkismetComment} from './bundled-plugins.js';
import {queueCommentNotifications} from './core.js';
import {deliverMail} from './accounts.js';
import type {PingHTTP} from './ping-protocol.js';
import {commentAdmissionTime,recordCommentFloodMetadata} from './comment-flood.js';
const esc=(s:string)=>s.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll("'",'&apos;');
const hash=(s:string)=>createHash('sha256').update(s).digest('hex');
export class IncomingPingError extends Error{constructor(readonly code=0){super('Ping notification could not be accepted.');}}
export function pingFault(code:number){return '<?xml version="1.0" encoding="UTF-8"?><methodResponse><fault><value><struct><member><name>faultCode</name><value><int>'+code+'</int></value></member><member><name>faultString</name><value><string>Ping notification could not be accepted.</string></value></member></struct></value></fault></methodResponse>';}
export function parseIncomingPing(body:Buffer):[string,string]{
 if(!Buffer.isBuffer(body)||body.length>16384)throw new IncomingPingError(-32700);
 let xml:string;try{xml=new TextDecoder('utf-8',{fatal:true}).decode(body);}catch{throw new IncomingPingError(-32700);}
 if(/<!DOCTYPE|<!ENTITY/i.test(xml))throw new IncomingPingError(-32700);
 let depth=0,nodes=0;new Parser({onopentag(_tag,attrs){if(++depth>8||++nodes>24||Object.keys(attrs).length)throw new IncomingPingError(-32700);},onclosetag(){depth--;}},{xmlMode:true}).end(xml);
 if(depth||XMLValidator.validate(xml)!==true)throw new IncomingPingError(-32700);
 const parsed=new XMLParser({parseTagValue:false,ignoreAttributes:false,processEntities:true,htmlEntities:false}).parse(xml),call=parsed?.methodCall;
 if(!call||typeof call!=='object'||Array.isArray(call)||Object.keys(parsed).some(key=>!['?xml','methodCall'].includes(key))||Object.keys(call).some(key=>!['methodName','params'].includes(key)))throw new IncomingPingError(-32600);
 if(call.methodName!=='pingback.ping')throw new IncomingPingError(-32601);
 const params=call.params?.param;if(!Array.isArray(params)||params.length!==2||Object.keys(call.params).some(key=>key!=='param'))throw new IncomingPingError(-32602);
 return params.map(param=>{const v=param?.value;if(Object.keys(param||{}).length!==1||!v||typeof v!=='object'||Array.isArray(v)||Object.keys(v).length!==1||typeof v.string!=='string'||!v.string||v.string.length>2000)throw new IncomingPingError(-32602);return v.string;}) as [string,string];
}
/** Parse actual inert HTML anchors, never string/attribute/script matches. */
export function verifyPingHTML(body:Buffer,source:string,target:string){
 if(body.length>153600)throw new IncomingPingError(16);
 let html:string;try{html=new TextDecoder('utf-8',{fatal:true}).decode(body);}catch{throw new IncomingPingError(16);}
 const inert=new Set(['script','style','template','svg','math','iframe','object','noscript']);
 const stack:string[]=[];let nodes=0,title='',text='',hit=-1,skip=0;
 new Parser({onopentag(name,attrs){
  if(++nodes>10000||stack.length>=80)throw new IncomingPingError(16);stack.push(name);if(inert.has(name))skip++;
  if(!skip&&name==='a'&&attrs.href){try{if(normalizePublicURL(new URL(attrs.href,source).href).href===target&&hit<0)hit=text.length;}catch{}}
 },ontext(value){if(skip)return;if(stack.includes('title'))title+=value;text+=value+' ';},onclosetag(name){if(inert.has(name))skip--;stack.pop();}},{decodeEntities:true}).end(html);
 title=plainText(title).replace(/\s+/g,' ').trim().slice(0,160);if(!title)throw new IncomingPingError(32);if(hit<0)throw new IncomingPingError(17);
 const excerpt=text.slice(Math.max(0,hit-100),hit+200).replace(/\s+/g,' ').trim();
 return {authorName:title,content:cleanContent('[…] '+esc(excerpt)+' […]')};
}
const meta=`id,type,status,slug,parent_id AS "parentId",published_at AS "publishedAt",created_at AS "createdAt",ping_status AS "pingStatus",password_hash IS NOT NULL AS protected`;
async function configuration(db:Pick<pg.Pool,'query'>|pg.PoolClient=pool){
 const settings=await getSettings(db),plugin=(await db.query("SELECT e.enabled,e.settings,s.updated_at::text AS generation FROM extensions e LEFT JOIN extension_secrets s ON s.slug=e.slug WHERE e.slug='akismet'")).rows[0];
 return {settings,fingerprint:JSON.stringify({settings,plugin})};
}
async function targetPost(target:string,settings:Awaited<ReturnType<typeof getSettings>>){
 let url:URL;try{url=normalizePublicURL(target);}catch{throw new IncomingPingError(33);}
 if(url.origin!==new URL(settings.siteUrl).origin)throw new IncomingPingError(33);
 const resolved=await resolvePublicPath(url.pathname+url.search);if(!resolved)throw new IncomingPingError(33);
 const post=(await pool.query(`SELECT ${meta} FROM posts WHERE id=$1`,[resolved.id])).rows[0];
 if(!pingsOpen(post,settings))throw new IncomingPingError(33);
 post.terms=(await pool.query("SELECT t.taxonomy,t.slug FROM post_terms pt JOIN terms t ON t.id=pt.term_id WHERE pt.post_id=$1 ORDER BY t.name,t.id",[post.id])).rows;
 if(new URL(await postPermalink(post,settings),settings.siteUrl).href!==url.href)throw new IncomingPingError(33);
 return {post,url:url.href};
}
async function admission(ip:string,source:string,targetId:number){
 const client=await pool.connect(),token=randomUUID();
 try{await client.query('BEGIN');await client.query("SELECT pg_advisory_xact_lock(hashtext('worldact-incoming-pings'))");
  await client.query("DELETE FROM incoming_ping_rates WHERE window_start<date_trunc('hour',now())");
  for(const [key,max] of [[hash('ip:'+ip),30],[hash('source:'+source),10],[hash('target:'+targetId),100],[hash('global'),300]] as const){
   const result=await client.query("INSERT INTO incoming_ping_rates(key,window_start,count) VALUES($1,date_trunc('hour',now()),1) ON CONFLICT(key) DO UPDATE SET count=CASE WHEN incoming_ping_rates.window_start<date_trunc('hour',now()) THEN 1 ELSE incoming_ping_rates.count+1 END,window_start=date_trunc('hour',now()) WHERE incoming_ping_rates.window_start<date_trunc('hour',now()) OR incoming_ping_rates.count<$2 RETURNING key",[key,max]);
   if(!result.rowCount)throw new IncomingPingError(0);
  }
  await client.query("DELETE FROM incoming_ping_leases WHERE expires_at<=now()");
  if((await client.query("SELECT count(*)::int AS n FROM incoming_ping_leases")).rows[0].n>=2)throw new IncomingPingError(0);
  await client.query("INSERT INTO incoming_ping_leases(token,expires_at) VALUES($1,now()+interval '120 seconds')",[token]);await client.query('COMMIT');return token;
 }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
}
let activeIncoming=0;
export function createIncomingPings(options:{http?:PingHTTP;environment?:()=>PingEnvironment;akismet?:ReturnType<typeof createAkismetClient>}={}){
 const http=options.http||publicHTTP,environment=options.environment||pingEnvironment;
 return async(input:{type:'pingback'|'trackback';source:string;target:string;targetId?:number;targetPath?:string;title?:string;excerpt?:string;blogName?:string;ip:string;userAgent?:string})=>{
  if(environment()!=='production'||activeIncoming>=16)throw new IncomingPingError(0);
  activeIncoming++;
  try{
  const snapshot=await configuration();
  let targetURL=input.target;
  if(input.type==='trackback'&&!targetURL){
   if(input.targetPath){try{targetURL=new URL(input.targetPath,snapshot.settings.siteUrl).href;}catch{throw new IncomingPingError(33);}}
   else if(input.targetId){
    const post=(await pool.query(`SELECT ${meta} FROM posts WHERE id=$1`,[input.targetId])).rows[0];if(!pingsOpen(post,snapshot.settings))throw new IncomingPingError(33);
    post.terms=(await pool.query("SELECT t.taxonomy,t.slug FROM post_terms pt JOIN terms t ON t.id=pt.term_id WHERE pt.post_id=$1 ORDER BY t.name,t.id",[post.id])).rows;
    targetURL=new URL(await postPermalink(post,snapshot.settings),snapshot.settings.siteUrl).href;
   }else throw new IncomingPingError(33);
  }
  const target=await targetPost(targetURL,snapshot.settings);
  let source:URL;try{source=normalizePublicURL(input.source);if(source.href.length>2000)throw new Error();}catch{throw new IncomingPingError(0);}
  const own=new Set([new URL(snapshot.settings.siteUrl).origin]);try{own.add(new URL(process.env.APP_ORIGIN!).origin);}catch{}
  if(own.has(source.origin))throw new IncomingPingError(0);
  if((await pool.query("SELECT 1 FROM comments WHERE post_id=$1 AND ((type<>'comment' AND source_hash=$2) OR author_url=$3)",[target.post.id,hash(source.href),source.href])).rowCount)throw new IncomingPingError(48);
  const token=await admission(input.ip,source.href,target.post.id);
  let messages:Awaited<ReturnType<typeof queueCommentNotifications>>=[];
  try{
   const body=input.type==='pingback'?verifyPingHTML((await http(source.href,{method:'GET',representation:'html',redirects:0,maxWireBytes:153600,maxBodyBytes:153600,waitForPhysicalClose:true},own)).body,source.href,target.url):{
    authorName:plainText(input.blogName||input.title||'').trim().slice(0,160)||'Anonymous',
    content:cleanContent('<strong>'+esc(plainText(input.title||'').slice(0,250))+'</strong>\n\n'+esc(plainText(input.excerpt||'').slice(0,252))),
   };
   if(!plainText(body.content).trim())throw new IncomingPingError(0);
   const moderation={...body,type:input.type as CommentType,authorEmail:'',authorUrl:source.href,ip:input.ip};
   let status=await moderateComment(moderation,pool,snapshot.settings);
   const akismet:AkismetComment={type:input.type,userIP:input.ip,userAgent:input.userAgent||'',referrer:'',authorName:body.authorName,authorEmail:'',authorURL:source.href,content:body.content,permalink:target.url};
   const verdict=['trash','spam'].includes(status)?'skipped':await checkAkismetComment(akismet,pool,options.akismet);
   if(verdict==='spam')status='spam';else if(verdict==='unavailable')status='pending';
   const client=await pool.connect();
   try{
    await client.query('BEGIN');await client.query("SELECT pg_advisory_xact_lock(hashtext('worldact-comment-hierarchy'))");
    // Content/media deletion can update site image settings after locking posts.
    // Match post → settings so those transactions cannot form a lock cycle.
    const post=(await client.query(`SELECT ${meta} FROM posts WHERE id=$1 FOR SHARE`,[target.post.id])).rows[0];
    await client.query('SELECT id FROM settings WHERE id=1 FOR SHARE');
    if(environment()!=='production'||(await configuration(client)).fingerprint!==snapshot.fingerprint)throw new IncomingPingError(0);
    if(!pingsOpen(post,snapshot.settings))throw new IncomingPingError(33);
    post.terms=(await client.query("SELECT t.taxonomy,t.slug FROM post_terms pt JOIN terms t ON t.id=pt.term_id WHERE pt.post_id=$1 ORDER BY t.name,t.id",[post.id])).rows;
    if(new URL(await postPermalink(post,snapshot.settings,client),snapshot.settings.siteUrl).href!==target.url)throw new IncomingPingError(33);
    if((await client.query("SELECT 1 FROM comments WHERE post_id=$1 AND (source_hash=$2 OR author_url=$3) LIMIT 1",[post.id,hash(source.href),source.href])).rowCount)throw new IncomingPingError(48);
    if(!(await client.query("SELECT token FROM incoming_ping_leases WHERE token=$1 AND expires_at>clock_timestamp() FOR UPDATE",[token])).rowCount)throw new IncomingPingError(0);
    const admittedAt=await commentAdmissionTime(client);
    const result=await client.query("INSERT INTO comments(post_id,type,author_name,author_email,author_url,content,status,created_at) VALUES($1,$2,$3,'',$4,$5,$6,$7) RETURNING id",[post.id,input.type,body.authorName,source.href,body.content,status,admittedAt]);
    await recordCommentFloodMetadata(client,result.rows[0].id,input.ip,admittedAt);
    await recordAkismetCheck(result.rows[0].id,akismet,verdict,client);
    messages=await queueCommentNotifications(client,result.rows[0].id);
    if(!(await client.query('SELECT token FROM incoming_ping_leases WHERE token=$1 AND expires_at>clock_timestamp()',[token])).rowCount)throw new IncomingPingError(0);
    await client.query('COMMIT');
   }catch(error){await client.query('ROLLBACK');if((error as any).code==='23505')throw new IncomingPingError(48);throw error;}finally{client.release();}
  }finally{await pool.query('DELETE FROM incoming_ping_leases WHERE token=$1',[token]);}
  for(const message of messages)await deliverMail(message);
  }finally{activeIncoming--;}
 };
}
const receive=createIncomingPings();
export function createIncomingPingsRouter(service=receive){
 const router=express.Router();
 router.post('/xmlrpc.php',express.raw({type:()=>true,limit:'16kb'}),async(req,res)=>{
  try{const [source,target]=parseIncomingPing(req.body);await service({type:'pingback',source,target,ip:req.ip||'',userAgent:req.get('user-agent')});res.type('text/xml').send('<?xml version="1.0" encoding="UTF-8"?><methodResponse><params><param><value><string>Pingback registered.</string></value></param></params></methodResponse>');}
  catch(error){res.type('text/xml').send(pingFault(error instanceof IncomingPingError?error.code:0));}
 });
 const trackback=async(req:Request,res:Response)=>{
  try{
   if(!req.body||Object.keys(req.body).some(k=>!['url','title','excerpt','blog_name','charset'].includes(k))||Object.values(req.body).some(v=>typeof v!=='string'||v.length>4000)||!req.body.url||!req.body.title|| (req.body.charset&&!/^(UTF-8|ASCII)$/i.test(req.body.charset)))throw new IncomingPingError(0);
   const pretty=/\/trackback\/?$/.test(req.path),targetPath=pretty?req.path.replace(/trackback\/?$/,''):undefined;
   const raw:unknown=pretty?undefined:req.params.id??req.query.tb_id;
   if(!pretty&&(typeof raw!=='string'||!/^\d{1,10}$/.test(raw)||Number(raw)>2147483647))throw new IncomingPingError(33);
   await service({type:'trackback',source:req.body.url,target:'',targetId:pretty?undefined:Number(raw),targetPath,title:req.body.title,excerpt:req.body.excerpt,blogName:req.body.blog_name,ip:req.ip||'',userAgent:req.get('user-agent')});res.type('text/xml').send('<?xml version="1.0" encoding="UTF-8"?><response><error>0</error></response>');
  }catch{res.type('text/xml').send('<?xml version="1.0" encoding="UTF-8"?><response><error>1</error><message>Ping notification could not be accepted.</message></response>');}
 };
 router.post(['/wp-trackback.php','/wp-trackback.php/:id'],express.urlencoded({extended:false,limit:'16kb',parameterLimit:8}),trackback);
 router.post(/\/trackback\/?$/,express.urlencoded({extended:false,limit:'16kb',parameterLimit:8}),trackback);
 router.all('/xmlrpc.php',(_req,res)=>res.status(405).setHeader('Allow','POST').type('text/xml').send(pingFault(-32600)));
 router.all(['/wp-trackback.php','/wp-trackback.php/:id'],(_req,res)=>res.status(405).setHeader('Allow','POST').type('text/xml').send('<?xml version="1.0" encoding="UTF-8"?><response><error>1</error><message>Ping notification could not be accepted.</message></response>'));
 router.use((error:any,req:Request,res:Response,next:express.NextFunction)=>{if(!/\/trackback\/?$/.test(req.path)&&!['/xmlrpc.php','/wp-trackback.php'].some(path=>req.path===path||req.path.startsWith(path+'/'))){next(error);return;}res.type('text/xml').send(req.path==='/xmlrpc.php'?pingFault(-32700):'<?xml version="1.0" encoding="UTF-8"?><response><error>1</error><message>Ping notification could not be accepted.</message></response>');});
 return router;
}
export default createIncomingPingsRouter();
