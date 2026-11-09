import test,{after} from "./isolated-test.js";
import assert from "node:assert/strict";
import {pool} from "../server/db.js";
const base=process.env.TEST_API_URL!,origin=process.env.APP_ORIGIN!;
after(()=>pool.end());

test('independent unchanged fixed drafts can schedule their persisted selected instant after reload and zone changes',async t=>{
 const original=(await pool.query('SELECT data FROM settings WHERE id=1')).rows[0].data;let cookie='';const ids:number[]=[];
 async function api(path:string,method='GET',body?:unknown){const response=await fetch(base+path,{method,headers:{Origin:origin,Cookie:cookie,'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});return {response,data:await response.json()};}
 async function ok(path:string,method='GET',body?:unknown){const r=await api(path,method,body);assert.ok(r.response.ok,JSON.stringify({status:r.response.status,data:r.data,path}));return r.data;}
 try{
 const login=await api('/api/auth/login','POST',{login:process.env.ADMIN_EMAIL,password:process.env.ADMIN_PASSWORD});assert.equal(login.response.status,200);cookie=login.response.headers.get('set-cookie')!.split(';')[0];
 await ok('/api/settings','PUT',{timezone:'America/Los_Angeles',pingServices:[]});
 for(const zone of ['America/Los_Angeles','+05:45'])await t.test('unchanged fixed draft schedules retained GMT in '+zone,async()=>{
 await ok('/api/settings','PUT',{timezone:'America/Los_Angeles'});
 const draft=(await ok('/api/posts','POST',{title:'Independent fixed draft '+zone,status:'draft',postDate:'2100-01-02T03:04:05'})).post;ids.push(draft.id);assert.equal(draft.scheduledAt,null);assert.equal(draft.postDateGmt,'2100-01-02T11:04:05.000Z');
 await ok('/api/settings','PUT',{timezone:zone});const loaded=(await ok('/api/posts/'+draft.id)).post;
 const scheduled=await api('/api/posts/'+draft.id,'PUT',{status:'future',version:loaded.version});assert.equal(scheduled.response.status,200,JSON.stringify(scheduled.data));assert.equal(scheduled.data.post.scheduledAt,draft.postDateGmt);assert.equal(scheduled.data.post.postDate,draft.postDate);assert.equal(scheduled.data.post.postDateGmt,draft.postDateGmt);
 });
 }finally{await pool.query('UPDATE settings SET data=$1 WHERE id=1',[original]);if(ids.length)await pool.query('DELETE FROM posts WHERE id=ANY($1::int[])',[ids]);}
});
