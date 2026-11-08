import test,{after} from "./isolated-test.js";
import assert from "node:assert/strict";
import {pool,getPost,getSettings} from "../server/db.js";
import {formatPostCivil,civilFromInstant,postCivilZoned,postCivilInstant} from "../shared/post-civil-date.js";
import {postCivilBounds} from "../server/date-archives.js";
import {renderSiteDocument} from "../server/block-renderer.js";
const base=process.env.TEST_API_URL!,origin=process.env.APP_ORIGIN!;
after(()=>pool.end());

test('independent extreme civil calendars and both DST instants use explicit site semantics',async()=>{
 for(const host of ['Pacific/Auckland','America/New_York','UTC']){
 const old=process.env.TZ;process.env.TZ=host;
 try{
 for(const value of ['0001-02-03T04:05:06','0099-12-31T23:59:59','9999-12-31T23:59:59'])assert.equal(formatPostCivil(value,'Y-m-d H:i:s','UTC'),value.replace('T',' '));
 for(const zone of ['+05:45','+0545','+05'])assert.equal(formatPostCivil('2001-02-03T04:05:06','Y-m-d H:i:s',zone),'2001-02-03 04:05:06');
 assert.equal(civilFromInstant('2024-11-03T08:30:07Z','America/Los_Angeles'),'2024-11-03T01:30:07');
 assert.equal(civilFromInstant('2024-11-03T09:30:07Z','America/Los_Angeles'),'2024-11-03T01:30:07');
 assert.equal(postCivilInstant('2024-11-03T01:30:07','America/Los_Angeles'),'2024-11-03T08:30:07.000Z');
 assert.deepEqual(postCivilBounds({year:9999,month:12,day:31}),{start:'9999-12-31T00:00:00',end:'10000-01-01T00:00:00'});
 }finally{old===undefined?delete process.env.TZ:process.env.TZ=old;}
 }
 const db=await pool.connect();try{for(const zone of ['Pacific/Auckland','America/New_York','UTC']){await db.query("SELECT set_config('TimeZone',$1,false)",[zone]);const actual=await db.query("SELECT '0001-02-03T04:05:06'::text civil,worldact_valid_post_civil('9999-12-31T23:59:59') valid,worldact_valid_post_civil('1900-02-29T00:00:00') invalid");assert.equal(actual.rows[0].civil,'0001-02-03T04:05:06');assert.equal(actual.rows[0].valid,true);assert.equal(actual.rows[0].invalid,false);}}finally{await db.query("SET TIME ZONE 'UTC'");db.release();}
});

test('independent WXR pairs, all civil consumers, v4 and legacy import atomicity remain coherent',{timeout:120000},async t=>{
 const original=(await pool.query('SELECT data FROM settings WHERE id=1')).rows[0].data;let cookie='';const ids:number[]=[];
 async function api(path:string,method='GET',body?:unknown){const r=await fetch(base+path,{method,headers:{Origin:origin,Cookie:cookie,'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});return {r,data:await r.json()};}
 async function ok(path:string,method='GET',body?:unknown){const result=await api(path,method,body);assert.ok(result.r.ok,JSON.stringify({path,status:result.r.status,data:result.data}));return result.data;}
 const item=(id:number,local:string,gmt:string,status='publish')=>`<item><title>Civil independent ${id}</title><wp:post_id>${id}</wp:post_id><wp:post_type>post</wp:post_type><wp:status>${status}</wp:status><wp:post_date>${local}</wp:post_date><wp:post_date_gmt>${gmt}</wp:post_date_gmt><content:encoded><![CDATA[<p>CIVIL-INDEPENDENT-${id}</p>]]></content:encoded></item>`;
 const xml=(items:string)=>`<rss xmlns:wp="http://wordpress.org/export/1.2/" xmlns:content="http://purl.org/rss/1.0/modules/content/"><channel><wp:wxr_version>1.2</wp:wxr_version>${items}</channel></rss>`;
 try{
 const login=await api('/api/auth/login','POST',{login:process.env.ADMIN_EMAIL,password:process.env.ADMIN_PASSWORD});assert.equal(login.r.status,200);cookie=login.r.headers.get('set-cookie')!.split(';')[0];
 await ok('/api/settings','PUT',{timezone:'UTC',dateFormat:'Y-m-d H:i:s',permalinkStructure:'/%year%/%monthnum%/%day%/%hour%/%minute%/%second%/%post_id%/',pingServices:[],postsPerPage:50,frontPageMode:'posts',frontPageId:null,postsPageId:null,theme:'classic'});
 const result=await ok('/api/tools/import','POST',{format:'wxr',xml:xml(item(918001,'2001-02-03 04:05:06','2000-01-01 00:00:00')+item(918002,'2002-03-04 05:06:07','2000-01-01 00:00:00')+item(918003,'2011-12-30 12:34:56','0000-00-00 00:00:00','draft'))});ids.push(...result.postIds);
 const first=await getPost(ids[0]),second=await getPost(ids[1]),floating=await getPost(ids[2]);assert.equal(first.postDate,'2001-02-03T04:05:06');assert.equal(second.postDate,'2002-03-04T05:06:07');assert.equal(first.postDateGmt.toISOString(),second.postDateGmt.toISOString());assert.equal(floating.postDateGmt,null);
 for(const zone of ['+05:45','America/Los_Angeles','Pacific/Apia']){
 await ok('/api/settings','PUT',{timezone:zone});
 const model=await ok('/api/public/document?path=/');assert.equal(model.controls.dates['post:'+first.id+':'+first.postDate],'2001-02-03 04:05:06');assert.equal(model.controls.dates['post:'+second.id+':'+second.postDate],'2002-03-04 05:06:07');
 const selected=await ok('/api/public/site?m=20010203');assert.ok(selected.posts.some((p:any)=>p.id===first.id));assert.ok(!selected.posts.some((p:any)=>p.id===second.id));
 const page=await fetch(base+first.permalink);assert.equal(page.status,200);assert.match(await page.text(),/2001-02-03 04:05:06/);
 const post=await getPost(first.id),settings=await getSettings();
 const markup=await renderSiteDocument({rawContent:'<!-- wp:latest-posts {"displayPostDate":true,"postsToShow":100} /--><!-- wp:archives {"type":"daily"} /--><!-- wp:calendar {"year":2001,"month":2} /-->'},{post});
 assert.match(markup,/2001-02-03 04:05:06/);assert.match(markup,/2002-03-04 05:06:07/);assert.match(markup,/\/2001\/02\/03\//);
 }
 await t.test('partial-zero and invalid nonzero WXR dates roll back the entire multi-item import',async()=>{
 for(const [local,gmt] of [['2001-00-03 04:05:06','2000-01-01 00:00:00'],['2001-02-03 04:05:06','2000-02-30 00:00:00'],['2001-02-30 04:05:06','2000-01-01 00:00:00']]){
 const before=(await pool.query('SELECT count(*)::int n FROM posts')).rows[0].n;const r=await api('/api/tools/import','POST',{format:'wxr',xml:xml(item(919001,'2001-02-03 04:05:06','2000-01-01 00:00:00')+item(919002,local,gmt))});assert.equal(r.r.status,400,JSON.stringify(r.data));assert.equal((await pool.query('SELECT count(*)::int n FROM posts')).rows[0].n,before);
 }
 });
 await t.test('v4 invalid pairs roll back earlier inserted rows and old v3 derives before destination conversion',async()=>{
 const count=async()=>(await pool.query('SELECT count(*)::int n FROM posts')).rows[0].n;
 const raw={id:920001,type:'post',title:'Independent JSON pair',slug:'independent-json-pair',content:'<p>Independent JSON.</p>',status:'publish',created_at:'2000-01-01T00:00:00Z',published_at:'2000-01-01T00:00:00Z',post_date:'2001-02-03T04:05:06',post_date_gmt:'2000-01-01T00:00:00Z'};
 for(const change of [{post_date:'2001-02-30T00:00:00'},{post_date_gmt:'0000-01-01T00:00:00Z'},{post_date_gmt:undefined}]){const before=await count(),r=await api('/api/tools/import','POST',{application:'WorldAct',version:4,posts:[raw,{...raw,...change,id:920002}]});assert.equal(r.r.status,400,JSON.stringify(r.data));assert.equal(await count(),before);}
 await ok('/api/settings','PUT',{timezone:'+05:45'});const old={...raw,id:920003,status:'future',scheduled_at:'2100-01-01T07:30:09Z'};delete (old as any).post_date;delete (old as any).post_date_gmt;
 const imported=await ok('/api/tools/import','POST',{application:'WorldAct',version:3,settings:{timezone:'America/Los_Angeles'},posts:[old]});ids.push(...imported.postIds);const p=await getPost(imported.postIds[0]);assert.equal(p.status,'draft');assert.equal(p.postDate,'2099-12-31T23:30:09');assert.equal(p.postDateGmt.toISOString(),'2100-01-01T07:30:09.000Z');assert.ok(imported.warnings.some((s:string)=>s.includes('approximated')));
 });
 }finally{await pool.query('UPDATE settings SET data=$1 WHERE id=1',[original]);if(ids.length)await pool.query('DELETE FROM posts WHERE id=ANY($1::int[])',[ids]);}
});
