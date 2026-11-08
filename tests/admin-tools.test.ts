import test from './isolated-test.js';
import 'dotenv/config';
import assert from 'node:assert/strict';
import {pool} from '../server/db.js';
const root=process.env.TEST_API_URL||'http://127.0.0.1:3001',origin=process.env.APP_ORIGIN||'http://127.0.0.1:5173';
async function api(path:string,method='GET',body?:unknown,cookie=''){
 const response=await fetch(root+path,{method,headers:{Origin:origin,'Content-Type':'application/json',...(cookie?{Cookie:cookie}:{})},...(body===undefined?{}:{body:JSON.stringify(body)})});return {response,data:await response.json()};
}
test('categorized diagnostics exclude credentials and policy drafts stay private for review',async()=>{
 const login=await api('/api/auth/login','POST',{login:process.env.ADMIN_EMAIL,password:process.env.ADMIN_PASSWORD});assert.equal(login.response.status,200);const cookie=login.response.headers.get('set-cookie')!.split(';')[0],before=(await pool.query('SELECT data FROM settings WHERE id=1')).rows[0].data;let postId:number|undefined;
 try{
  for(const route of ['/api/tools/health/info','/api/tools/privacy/policy-guide'])assert.equal((await api(route)).response.status,401);
  const info=await api('/api/tools/health/info','GET',undefined,cookie);assert.equal(info.response.status,200);assert.ok(info.data.sections.some((section:any)=>section.id==='database'));assert.ok(info.data.tables.some((table:any)=>table.name==='posts'));assert.equal(JSON.stringify(info.data).includes(process.env.ADMIN_PASSWORD!),false);assert.equal(JSON.stringify(info.data).includes(process.env.DATABASE_URL!),false);assert.equal(JSON.stringify(info.data).includes(login.data.user.email),false);
  await api('/api/settings','PUT',{commentCookieConsent:false,showAvatars:false},cookie);
  const guide=await api('/api/tools/privacy/policy-guide','GET',undefined,cookie);assert.equal(guide.response.status,200);assert.ok(guide.data.reviewRequired.length);assert.match(guide.data.sections.find((section:any)=>section.id==='cookies').text.join(' '),/not saved/);assert.match(guide.data.sections.find((section:any)=>section.id==='comments').text.join(' '),/avatars are disabled/);
  const draft=await api('/api/tools/privacy/policy-draft','POST',{title:'<b>Reviewed Privacy Policy</b>',setAsPolicy:true},cookie);assert.equal(draft.response.status,201);postId=draft.data.post.id;assert.equal(draft.data.post.type,'page');assert.equal(draft.data.post.title,'Reviewed Privacy Policy');assert.equal(draft.data.post.status,'draft');assert.equal(draft.data.post.commentStatus,'closed');assert.match(draft.data.post.rawContent,/<!-- wp:heading/);assert.match(draft.data.post.content,/\[Add/);assert.equal((await api('/api/settings','GET',undefined,cookie)).data.settings.privacyPageId,postId);assert.equal((await api('/api/public/posts/'+draft.data.post.slug)).response.status,404);
 }finally{if(postId){await api('/api/posts/'+postId,'PUT',{status:'trash'},cookie);await api('/api/posts/'+postId,'DELETE',undefined,cookie);}await pool.query('UPDATE settings SET data=$1::jsonb WHERE id=1',[JSON.stringify(before)]);await api('/api/auth/logout','POST',undefined,cookie);await pool.end();}
});
