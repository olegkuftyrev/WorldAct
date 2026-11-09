import test,{after} from "./isolated-test.js";
import assert from "node:assert/strict";
import {XMLParser} from "fast-xml-parser";
import {pool,getSettings} from "../server/db.js";
import {readInternalFeed} from "../server/rss.js";
import type {State} from "../server/block-renderer.js";
after(()=>pool.end());
const base=process.env.TEST_API_URL!,origin=process.env.APP_ORIGIN!;
const xml=new XMLParser({parseTagValue:false,isArray:name=>name==="item"||name==="entry"||name==="url"});
test("selected GMT serializes publication feed and WXR timestamps independently of legacy UTC and current zone",async t=>{
 const original=(await pool.query("SELECT data FROM settings WHERE id=1")).rows[0].data,ids:number[]=[],stamp="selected-gmt-"+Date.now();let cookie="";
 async function api(path:string,method="GET",body?:unknown){return fetch(base+path,{method,headers:{Origin:origin,Cookie:cookie,"Content-Type":"application/json"},body:body===undefined?undefined:JSON.stringify(body)});}
 async function ok(path:string,method="GET",body?:unknown){const response=await api(path,method,body),data=await response.json();assert.ok(response.ok,`${path}: ${response.status} ${JSON.stringify(data)}`);return data;}
 const source=(id:number,status:string,gmt:string|null,published:string|null)=>({id,type:"post",title:stamp+"-"+id,slug:stamp+"-"+id,status,content:"<p>Selected GMT body.</p>",created_at:"1997-01-02T03:04:05.123Z",updated_at:"2005-06-07T08:09:10.456Z",published_at:published,scheduled_at:"2100-01-02T03:04:05.789Z",post_date:"2001-02-03T04:05:06",post_date_gmt:gmt});
 try{
  const login=await api("/api/auth/login","POST",{login:process.env.ADMIN_EMAIL,password:process.env.ADMIN_PASSWORD});assert.equal(login.status,200);cookie=login.headers.get("set-cookie")!.split(";")[0];
  await ok("/api/settings","PUT",{siteUrl:origin,timezone:"America/Los_Angeles",feedItems:100,pingServices:[],permalinkStructure:"/%year%/%monthnum%/%day%/%post_id%/%postname%/"});
  const imported=await ok("/api/tools/import","POST",{application:"WorldAct",version:4,posts:[source(41,"publish","2002-03-04T05:06:07.123Z","2000-04-05T06:07:08.234Z"),source(42,"publish","2003-04-05T06:07:08.345Z","1999-04-05T06:07:08.234Z"),source(43,"publish",null,"1998-04-05T06:07:08.234Z"),source(44,"draft",null,null)]});ids.push(...imported.postIds);
  const [fixed,older,empty,floating]=ids,gmt="2002-03-04T05:06:07.123Z",utc=new Date(gmt).toUTCString(),rows=async()=>(await pool.query("SELECT id,created_at::text,updated_at::text,published_at::text,scheduled_at::text,post_date,post_date_gmt::text FROM posts WHERE id=ANY($1::int[]) ORDER BY id",[ids])).rows,before=await rows();
  const snapshots:any[]=[];
  for(const zone of ["America/Los_Angeles","+05:45","Pacific/Apia"]){
   await ok("/api/settings","PUT",{timezone:zone});
   const rssResponse=await api("/feed/"),atomResponse=await api("/feed/atom/"),wxrResponse=await api("/api/tools/export?format=wxr&content=posts");assert.equal(rssResponse.status,200);assert.equal(atomResponse.status,200);assert.equal(wxrResponse.status,200);
   const rss=xml.parse(await rssResponse.text()).rss.channel.item,atom=xml.parse(await atomResponse.text()).feed.entry,wxr=xml.parse(await wxrResponse.text()).rss.channel.item;
   const state:State={db:pool,settings:await getSettings(),options:{},nodes:0,outputBytes:0,queries:0,cache:new Map()},local=await readInternalFeed(new URL(origin+"/feed/"),state);assert.ok(local);
   snapshots.push({zone,rss,atom,wxr,local:local.items});assert.deepEqual(await rows(),before,"changing zone must preserve every selected pair and legacy UTC field");
  }
  const rssItem=(s:any,id:number)=>s.rss.find((p:any)=>p.guid==="worldact:"+id),atomItem=(s:any,id:number)=>s.atom.find((p:any)=>p.id==="urn:worldact:post:"+id),wxrItem=(s:any,id:number)=>s.wxr.find((p:any)=>Number(p["wp:post_id"])===id),localItem=(s:any,id:number)=>s.local.find((p:any)=>p.title===stamp+"-"+(41+ids.indexOf(id)));
  await t.test("RSS pubDate uses selected GMT through zone changes",()=>{for(const s of snapshots)assert.equal(rssItem(s,fixed).pubDate,utc,s.zone);});
  await t.test("Atom published uses selected GMT and updated retains modification time",()=>{for(const s of snapshots){assert.equal(atomItem(s,fixed).published,gmt,s.zone);assert.equal(atomItem(s,fixed).updated,"2005-06-07T08:09:10.456Z");}});
  await t.test("internal RSS explicitly projects selected GMT",()=>{for(const s of snapshots)assert.equal(localItem(s,fixed).date,gmt,s.zone);});
  await t.test("WXR item pubDate uses selected GMT independently of civil and old publication",()=>{for(const s of snapshots){const p=wxrItem(s,fixed);assert.equal(p.pubDate,utc,s.zone);assert.equal(p["wp:post_date"],"2001-02-03 04:05:06");assert.equal(p["wp:post_date_gmt"],"2002-03-04 05:06:07");assert.equal(p["wp:post_modified_gmt"],"2005-06-07 08:09:10");}});
  await t.test("missing selected GMT produces empty public feed publication fields",()=>{for(const s of snapshots){assert.equal(rssItem(s,empty).pubDate,"");assert.equal(atomItem(s,empty).published,"");assert.equal(atomItem(s,empty).updated,"2005-06-07T08:09:10.456Z");}});
  await t.test("missing selected GMT remains null in internal RSS",()=>{for(const s of snapshots)assert.equal(localItem(s,empty).date,null);});
  await t.test("WXR floating draft and published null GMT have empty item pubDate",()=>{for(const s of snapshots)for(const id of [empty,floating]){const p=wxrItem(s,id);assert.equal(p.pubDate,"");assert.equal(p["wp:post_date_gmt"],"0000-00-00 00:00:00");}});
  await t.test("feed ordering and every old UTC column remain unchanged",async()=>{for(const s of snapshots){assert.deepEqual(s.rss.filter((p:any)=>[fixed,older,empty].some(id=>p.guid==="worldact:"+id)).map((p:any)=>p.guid),[fixed,older,empty].map(id=>"worldact:"+id));assert.deepEqual(s.local.filter((p:any)=>ids.some(id=>p.title===stamp+"-"+(41+ids.indexOf(id)))).map((p:any)=>p.title),[41,42,43].map(id=>stamp+"-"+id));}assert.deepEqual(await rows(),before);});
 }finally{if(ids.length)await pool.query("DELETE FROM posts WHERE id=ANY($1::int[])",[ids]);await pool.query("UPDATE settings SET data=$1 WHERE id=1",[original]);}
});
