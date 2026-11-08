import { Parser } from 'htmlparser2';
import { XMLParser, XMLValidator } from 'fast-xml-parser';
import { normalizePublicURL, publicHTTP, type PublicHTTPInput, type PublicHTTPResult } from './public-http.js';
export type PingHTTP=(url:string,input?:PublicHTTPInput,ownOrigins?:ReadonlySet<string>)=>Promise<PublicHTTPResult>;
export class PingProtocolError extends Error{constructor(readonly outcome:'invalid_endpoint'|'invalid_reply'|'remote_fault'|'too_many_links'){super(outcome);}}
const escape=(value:string)=>value.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll("'",'&apos;');
export function pingRPC(method:'pingback.ping'|'weblogUpdates.extendedPing'|'weblogUpdates.ping',args:string[]):string{
 if(args.length>3 || args.some(value=>value.length>2048))throw new PingProtocolError('invalid_reply');
 return '<?xml version="1.0" encoding="UTF-8"?><methodCall><methodName>'+method+'</methodName><params>'+args.map(value=>'<param><value><string>'+escape(value)+'</string></value></param>').join('')+'</params></methodCall>';
}
export function parsePingReply(buffer:Buffer):{fault:number|null}{
 if(buffer.length>65536)throw new PingProtocolError('invalid_reply');
 const xml=new TextDecoder('utf-8',{fatal:true}).decode(buffer);
 if(/<!DOCTYPE|<!ENTITY/i.test(xml))throw new PingProtocolError('invalid_reply');
 let depth=0,nodes=0;
 const parser=new Parser({onopentag(){if(++depth>12 || ++nodes>128)throw new PingProtocolError('invalid_reply');},onclosetag(){depth--; }},{xmlMode:true});
 parser.end(xml);
 if(depth || XMLValidator.validate(xml)!==true)throw new PingProtocolError('invalid_reply');
 const value=new XMLParser({ignoreAttributes:false,parseTagValue:false,processEntities:true,htmlEntities:false}).parse(xml)?.methodResponse;
 if(!value || typeof value!=='object' || Array.isArray(value))throw new PingProtocolError('invalid_reply');
 if(value.fault!==undefined){
  const members=value.fault?.value?.struct?.member;
  const list=Array.isArray(members)?members:[members];
  const code=list.find(item=>item?.name==='faultCode')?.value;
  const number=code?.int ?? code?.i4;
  if(typeof number!=='string' || !/^-?\d{1,8}$/.test(number))throw new PingProtocolError('invalid_reply');
  return {fault:Number(number)};
 }
 if(!value.params || !value.params.param || Array.isArray(value.params.param) || value.params.param.value===undefined)throw new PingProtocolError('invalid_reply');
 return {fault:null};
}
function normalizedURL(input:string,base?:string):string{
 try{return normalizePublicURL(base?new URL(input,base).href:input).href;}catch{throw new PingProtocolError('invalid_endpoint');}
}
/** Stored URL tokens, like wp_extract_urls; HTML entity decoding is inert and bounded. */
export function pingTargets(content:string,permalink:string,siteURL:string):string[]{
 const targets=new Set<string>();
 for(const match of content.matchAll(/https?:\/\/[^\s<>"'`]+/giu)){
  let decoded='';new Parser({ontext(value){decoded+=value;}},{decodeEntities:true}).end(match[0].replace(/[.,;!\])}]+$/u,''));
  try{
   const url=normalizePublicURL(decoded),own=new URL(siteURL),source=new URL(permalink,own);
   if(url.href===source.href || (url.origin===own.origin && url.pathname.startsWith('/uploads/')) || (url.pathname==='/' && !url.search))continue;
   targets.add(url.href);
   if(targets.size>100)throw new PingProtocolError('too_many_links');
  }catch(error){if(error instanceof PingProtocolError)throw error;}
 }
 return [...targets];
}
export function createPingProtocol(http:PingHTTP=publicHTTP){
 async function rpc(url:string,method:Parameters<typeof pingRPC>[0],args:string[],origins:ReadonlySet<string>){
  return parsePingReply((await http(normalizedURL(url),{method:'POST_XML',body:pingRPC(method,args),redirects:0,maxWireBytes:65536,maxBodyBytes:65536},origins)).body);
 }
 return {
  async pingback(target:string,source:string,origins:ReadonlySet<string>){
   const head=await http(normalizedURL(target),{method:'HEAD',representation:'html',maxWireBytes:153600,maxBodyBytes:153600},origins);
   let endpoint=head.headers.pingback;
   if(!endpoint){
    if(/^(image|audio|video|model)\//i.test(head.headers.contentType || ''))return 'no_endpoint' as const;
    const page=await http(head.url,{method:'GET',representation:'html',maxWireBytes:153600,maxBodyBytes:153600},origins);
    let nodes=0,depth=0;
    const parser=new Parser({onopentag(name,attributes){
     if(++nodes>10000 || ++depth>80)throw new PingProtocolError('invalid_endpoint');
     if(!endpoint && name==='link' && attributes.rel?.toLowerCase().split(/\s+/).includes('pingback') && attributes.href)endpoint=normalizedURL(attributes.href,page.url);
    },onclosetag(){depth--; }},{decodeEntities:true});parser.end(page.body.toString('utf8'));
   }
   if(!endpoint)return 'no_endpoint' as const;
   const reply=await rpc(normalizedURL(endpoint,head.url),'pingback.ping',[source,target],origins);
   if(reply.fault!==null && reply.fault!==48)throw new PingProtocolError('remote_fault');
   return 'sent' as const;
  },
  async service(target:string,title:string,home:string,feed:string,origins:ReadonlySet<string>){
   // Source falls back on a failed extendedPing query (including HTTP/invalid-reply failures).
   try{if((await rpc(target,'weblogUpdates.extendedPing',[title,home,feed],origins)).fault===null)return;}catch{}
   if((await rpc(target,'weblogUpdates.ping',[title,home],origins)).fault!==null)throw new PingProtocolError('remote_fault');
  },
 };
}
