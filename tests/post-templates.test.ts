import test from './isolated-test.js';
import 'dotenv/config';
import assert from 'node:assert/strict';
import {pool} from '../server/db.js';
const root=process.env.TEST_API_URL||'http://127.0.0.1:3001',origin=process.env.APP_ORIGIN||'http://127.0.0.1:5173';
async function api(path:string,method='GET',body?:unknown,cookie=''){
 const response=await fetch(root+path,{method,headers:{Origin:origin,'Content-Type':'application/json',...(cookie?{Cookie:cookie}:{})},...(body===undefined?{}:{body:JSON.stringify(body)})});return {response,data:await response.json()};
}
test('per-post templates respect theme content types and persist through single, bulk and REST writes',async()=>{
 const stamp='assigned-'+Date.now().toString(36),login=await api('/api/auth/login','POST',{login:process.env.ADMIN_EMAIL,password:process.env.ADMIN_PASSWORD});assert.equal(login.response.status,200);const cookie=login.response.headers.get('set-cookie')!.split(';')[0],posts:number[]=[];let documentId:number|undefined;
 try{
  assert.equal((await api('/api/posts/templates')).response.status,401);
  const templates=await api('/api/posts/templates?type=page','GET',undefined,cookie);assert.equal(templates.response.status,200);assert.ok(templates.data.templates.some((entry:any)=>entry.slug==='page-no-title'));
  assert.equal((await api('/api/posts/templates?type=post','GET',undefined,cookie)).data.templates.some((entry:any)=>entry.slug==='page-no-title'),false);
  const page=await api('/api/posts','POST',{title:stamp,type:'page',templateSlug:'page-no-title'},cookie);assert.equal(page.response.status,201);posts.push(page.data.post.id);assert.equal(page.data.post.templateSlug,'page-no-title');
  assert.equal((await api('/api/posts','POST',{title:stamp,type:'post',templateSlug:'page-no-title'},cookie)).response.status,400);
  assert.equal((await api('/api/posts/'+page.data.post.id,'PUT',{templateSlug:'missing-template'},cookie)).response.status,400);
  const created=await api('/api/site-editor/documents','POST',{slug:stamp,title:stamp,type:'template',content:'<!-- wp:post-content /-->'},cookie);assert.equal(created.response.status,201);documentId=created.data.document.id;
  const post=await api('/api/posts','POST',{title:stamp+' post',type:'post'},cookie);posts.push(post.data.post.id);
  const changed=await api('/api/posts/bulk','POST',{ids:posts,changes:{templateSlug:stamp}},cookie);assert.equal(changed.response.status,200);assert.deepEqual(changed.data.updated,posts);assert.ok(changed.data.posts.every((entry:any)=>entry.templateSlug===stamp));
  const restored=await api('/wp-json/wp/v2/posts/'+post.data.post.id,'POST',{template:''},cookie);assert.equal(restored.response.status,200);assert.equal(restored.data.template,'');
  assert.equal((await api('/api/posts/'+page.data.post.id,'GET',undefined,cookie)).data.post.templateSlug,stamp);
 }finally{for(const id of posts){await api('/api/posts/'+id,'PUT',{status:'trash'},cookie);await api('/api/posts/'+id,'DELETE',undefined,cookie);}if(documentId)await api('/api/site-editor/documents/'+documentId,'DELETE',undefined,cookie);await api('/api/auth/logout','POST',undefined,cookie);await pool.end();}
});
