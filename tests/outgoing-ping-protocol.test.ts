import test from './isolated-test.js';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {Readable} from 'node:stream';
import {gzipSync} from 'node:zlib';
import {createPublicHTTPTransport,PublicHTTPError,type PublicHTTPResult} from '../server/public-http.js';
import {createPingProtocol,pingRPC,parsePingReply,pingTargets} from '../server/ping-protocol.js';
import {pingEnvironment,pingServicesSchema} from '../server/outgoing-ping-settings.js';
const success=Buffer.from('<methodResponse><params><param><value><string>Registered</string></value></param></params></methodResponse>');
const fault=(code:number)=>Buffer.from(`<methodResponse><fault><value><struct><member><name>faultCode</name><value><int>${code}</int></value></member><member><name>faultString</name><value><string>SECRET REMOTE DETAIL</string></value></member></struct></value></fault></methodResponse>`);
const response=(url:string,body=success,headers:PublicHTTPResult['headers']={}):PublicHTTPResult=>({url,body,headers,status:200});
const publicDNS=async()=>[{address:'93.184.216.34',family:4}];
function fixture(replies:Array<{status?:number;body?:Buffer;headers?:Record<string,string>;remote?:string;holdClose?:boolean;never?:boolean}>){
 let index=0;const seen:any[]=[],requests:any[]=[];
 const request=((options:any,callback:any)=>{
  const reply=replies[index++] || {},req=new EventEmitter() as any;seen.push(options);requests.push(req);
  const close=()=>{if(!req.closed){req.closed=true;req.emit('close');req.physicalSocket?.emit('close');}};
  req.finishClose=close;req.destroy=()=>{req.destroyed=true;if(!reply.holdClose)setImmediate(close);return req;};req.setTimeout=()=>req;
  req.end=(body:any)=>{req.body=body;setImmediate(()=>{
   const socket=new EventEmitter() as any;socket.remoteAddress=reply.remote || '93.184.216.34';req.physicalSocket=socket;req.emit('socket',socket);socket.emit('connect');
   if(req.destroyed || reply.never)return;
   const message=Readable.from([reply.body || Buffer.alloc(0)]) as any;message.statusCode=reply.status || 200;message.complete=true;message.headers=reply.headers || {};
   message.once('close',()=>{if(!reply.holdClose)close();});callback(message);
  });};return req;
 }) as any;
 return {request,seen,requests};
}

test('environment and service configuration are bounded; source unset production, explicit invalid fails closed',()=>{
 const old=process.env.WORLDACT_ENVIRONMENT_TYPE;
 try{delete process.env.WORLDACT_ENVIRONMENT_TYPE;assert.equal(pingEnvironment(),'production');for(const type of ['local','development','staging','production']){process.env.WORLDACT_ENVIRONMENT_TYPE=type;assert.equal(pingEnvironment(),type);}process.env.WORLDACT_ENVIRONMENT_TYPE='typo';assert.equal(pingEnvironment(),'local');}
 finally{if(old===undefined)delete process.env.WORLDACT_ENVIRONMENT_TYPE;else process.env.WORLDACT_ENVIRONMENT_TYPE=old;}
 assert.deepEqual(pingServicesSchema.parse(['https://EXAMPLE.test/rpc#fragment','https://example.test/rpc']),['https://example.test/rpc']);
 for(const url of ['//example.test/rpc','file:///etc/passwd','http://user:secret@example.test/rpc','http://127.1/rpc','http://[::ffff:7f00:1]/rpc','http://example.test:22/rpc','http://private.local/rpc'])assert.equal(pingServicesSchema.safeParse([url]).success,false,url);
 assert.equal(pingServicesSchema.safeParse(Array(21).fill('https://example.test/')).success,false);
});

test('fixed XML codec preserves arguments and rejects entity/size/depth/malformed replies without remote fault text',()=>{
 const request=pingRPC('pingback.ping',['https://source.test/?a=1&b=<two>','https://target.test/é']);assert.match(request,/&amp;b=&lt;two&gt;/);assert.match(request,/target.test\/é/);
 assert.equal(parsePingReply(success).fault,null);assert.equal(parsePingReply(fault(48)).fault,48);
 for(const xml of ['<!DOCTYPE x [<!ENTITY a "attack">]><methodResponse>&a;</methodResponse>','<methodResponse>'+ '<x>'.repeat(14)+'x'+'</x>'.repeat(14)+'</methodResponse>','<methodResponse><params/></methodResponse>','<methodResponse>broken','<methodResponse>'+ 'x'.repeat(65537)+'</methodResponse>'])assert.throws(()=>parsePingReply(Buffer.from(xml)));
 assert.throws(()=>parsePingReply(Buffer.from([0xff])));
 const targets=pingTargets('<a href="https://target.test/article?a=1&amp;b=2">link</a> https://target.test/article?a=1&amp;b=2 https://home.test/ https://own.test/uploads/a.png https://own.test/post/','https://own.test/post/','https://own.test/');
 assert.deepEqual(targets,['https://target.test/article?a=1&b=2']);
 assert.throws(()=>pingTargets(Array.from({length:101},(_,i)=>'https://target.test/'+i).join(' '),'https://own.test/post/','https://own.test/'));
});

test('source header discovery wins; HTML fallback resolves relative endpoint; duplicate48 succeeds',async()=>{
 const calls:Array<[string,any]>=[];
 const protocol=createPingProtocol(async(url,input)=>{calls.push([url,input]);return input?.method==='HEAD'?response(url,Buffer.alloc(0),{pingback:'https://rpc.test/xmlrpc'}):response(url,fault(48));});
 assert.equal(await protocol.pingback('https://target.test/article','https://own.test/post/',new Set(['https://own.test'])),'sent');
 assert.deepEqual(calls.map(c=>c[1].method),['HEAD','POST_XML']);assert.equal(calls[0][1].representation,'html');assert.match(calls[1][1].body,/<methodName>pingback.ping<\/methodName>/);assert.match(calls[1][1].body,/https:\/\/own.test\/post\//);assert.equal(calls[1][1].redirects,0);
 calls.length=0;
 const html=createPingProtocol(async(url,input)=>{calls.push([url,input]);return input?.method==='HEAD'?response(url,Buffer.alloc(0),{contentType:'text/html'}):input?.method==='GET'?response('https://target.test/dir/article',Buffer.from('<html><head><link href="../rpc?one=1&amp;two=2" rel="PINGBACK alternate"></head></html>')):response(url);});
 assert.equal(await html.pingback('https://target.test/article','https://own.test/post/',new Set()),'sent');assert.equal(calls[2][0],'https://target.test/rpc?one=1&two=2');
 const binary=createPingProtocol(async url=>response(url,Buffer.alloc(0),{contentType:'image/png'}));assert.equal(await binary.pingback('https://target.test/image','https://own.test/post/',new Set()),'no_endpoint');
});

test('Update Services sends exact extended arguments and falls back on faults or failed transport',async()=>{
 const calls:string[]=[];
 const protocol=createPingProtocol(async(url,input)=>{calls.push(input!.body!);return response(url,calls.length===1?fault(1):success);});
 await protocol.service('https://service.test/rpc?secret=operator','Title & Name','https://own.test/','https://own.test/feed/',new Set());
 assert.match(calls[0],/weblogUpdates.extendedPing/);assert.match(calls[0],/Title &amp; Name/);assert.match(calls[0],/https:\/\/own.test\/feed\//);assert.match(calls[1],/weblogUpdates.ping/);assert.doesNotMatch(calls[1],/feed/);
 let attempts=0;await createPingProtocol(async url=>{if(!attempts++)throw new Error('SECRET NETWORK');return response(url);}).service('https://service.test/rpc','Title','https://own.test/','https://own.test/feed/',new Set());assert.equal(attempts,2);
});

test('shared actual transport pins method/TLS/peer; rejects all private DNS, redirect and discovered endpoints',async()=>{
 const head=fixture([{headers:{'content-encoding':'gzip','content-length':'1000000','x-pingback':'https://rpc.test/xmlrpc'}}]);assert.equal((await createPublicHTTPTransport({resolve:publicDNS,request:head.request})('https://target.test/',{method:'HEAD'})).headers.pingback,'https://rpc.test/xmlrpc');
 const f=fixture([{body:success}]);const http=createPublicHTTPTransport({resolve:publicDNS,request:f.request});
 await http('https://rpc.test/xmlrpc?secret=one',{method:'POST_XML',body:pingRPC('pingback.ping',['https://own.test/','https://target.test/post']),redirects:0});
 assert.equal(f.seen[0].method,'POST');assert.equal(f.seen[0].servername,'rpc.test');assert.equal(f.seen[0].rejectUnauthorized,true);assert.equal(f.seen[0].agent,false);assert.equal(f.seen[0].headers.Authorization,undefined);assert.equal(f.seen[0].headers.Cookie,undefined);assert.equal(f.seen[0].headers['Content-Type'],'text/xml; charset=UTF-8');assert.ok(f.requests[0].body.includes('pingback.ping'));
 for(const addresses of [[{address:'93.184.216.34',family:4},{address:'10.0.0.1',family:4}],[{address:'::ffff:7f00:1',family:6}],[{address:'2002:0808:0808::1',family:6}]]){const bad=fixture([]);await assert.rejects(createPublicHTTPTransport({resolve:async()=>addresses,request:bad.request})('https://rpc.test/rpc'),PublicHTTPError);assert.equal(bad.seen.length,0);}
 const peer=fixture([{body:success,remote:'127.0.0.1'}]);await assert.rejects(createPublicHTTPTransport({resolve:publicDNS,request:peer.request})('https://rpc.test/rpc'),/verified/);
 const redir=fixture([{status:302,headers:{location:'http://169.254.169.254/latest'}}]);await assert.rejects(createPublicHTTPTransport({resolve:publicDNS,request:redir.request})('https://rpc.test/rpc'),/public address/);assert.equal(redir.seen.length,1);
 for(const endpoint of ['http://127.0.0.1/rpc','https://user:secret@rpc.test/rpc','https://rpc.test:25/rpc']){
  const f=fixture([{headers:{'x-pingback':endpoint}}]);const protocol=createPingProtocol(createPublicHTTPTransport({resolve:publicDNS,request:f.request}));await assert.rejects(protocol.pingback('https://target.test/article','https://own.test/post/',new Set()));assert.equal(f.seen.length,1);
 }
 const postRedirect=fixture([{status:302,headers:{location:'https://other.test/rpc'}}]);await assert.rejects(createPublicHTTPTransport({resolve:publicDNS,request:postRedirect.request})('https://rpc.test/rpc',{method:'POST_XML',body:'x',redirects:0}));assert.equal(postRedirect.seen.length,1);
});

test('physical request reservations survive logical timeout/abort until actual close, with bounded bytes and DNS',async()=>{
 const f=fixture(Array.from({length:6},()=>({never:true,holdClose:true}))),http=createPublicHTTPTransport({resolve:publicDNS,request:f.request,concurrency:2,timeoutMs:20});
 const keep=setTimeout(()=>{},200);
 try{
  await Promise.allSettled([http('https://public.test/1'),http('https://public.test/2')]);assert.equal(f.seen.length,2);
  f.requests[0].emit('close');f.requests[1].emit('close');
  await assert.rejects(http('https://public.test/3'),/timed out/);assert.equal(f.seen.length,2);
  f.requests[0].finishClose();f.requests[1].finishClose();
  const next=http('https://public.test/4');await assert.rejects(next,/timed out/);assert.equal(f.seen.length,3);f.requests[2].finishClose();
 }finally{clearTimeout(keep);}
 for(const reply of [{body:gzipSync(Buffer.alloc(65537,65)),headers:{'content-encoding':'gzip'}},{body:Buffer.alloc(65537)}])await assert.rejects(createPublicHTTPTransport({resolve:publicDNS,request:fixture([reply]).request})('https://public.test/',{maxBodyBytes:65536,maxWireBytes:65536}));
 const dns=fixture([]);await assert.rejects(createPublicHTTPTransport({resolve:()=>new Promise(()=>{}),request:dns.request,dnsTimeoutMs:5})('https://public.test/'),/timed out/);assert.equal(dns.seen.length,0);
});
