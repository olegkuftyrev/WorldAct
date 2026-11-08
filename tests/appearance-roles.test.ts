import 'dotenv/config';
import assert from 'node:assert/strict';
import test from 'node:test';
import {pool} from '../server/db.js';
const root=process.env.TEST_API_URL||'http://127.0.0.1:3001',origin=process.env.APP_ORIGIN||'http://127.0.0.1:5173';
async function api(path:string,method='GET',body?:unknown,cookie=''){
 const response=await fetch(root+path,{method,headers:{Origin:origin,'Content-Type':'application/json',...(cookie?{Cookie:cookie}:{})},...(body===undefined?{}:{body:JSON.stringify(body)})});return {response,data:await response.json()};
}
test('default role capabilities reserve theme options for admins and allow authors to manage their own patterns',async()=>{
 const stamp='appearance-'+Date.now().toString(36),login=await api('/api/auth/login','POST',{login:process.env.ADMIN_EMAIL,password:process.env.ADMIN_PASSWORD});assert.equal(login.response.status,200);
 const admin=login.response.headers.get('set-cookie')!.split(';')[0],users:number[]=[],entities:number[]=[];
 try{
  const people:Record<string,string>={};
  for(const role of ['editor','author','contributor']){const created=await api('/api/users','POST',{username:stamp+role,email:stamp+role+'@example.test',displayName:role,password:'Temporary-appearance-'+stamp,role},admin);users.push(created.data.user.id);const signed=await api('/api/auth/login','POST',{login:stamp+role,password:'Temporary-appearance-'+stamp});people[role]=signed.response.headers.get('set-cookie')!.split(';')[0];}
  for(const [role,cookie] of Object.entries(people)){
   for(const route of ['/api/site-editor','/api/menus','/wp-json/wp/v2/template-parts','/wp-json/wp/v2/navigation','/wp-json/wp/v2/menus'])assert.equal((await api(route,'GET',undefined,cookie)).response.status,403,role+' '+route);
   assert.equal((await api('/api/site-editor/documents','POST',{slug:stamp,title:stamp,type:'template',content:''},cookie)).response.status,403);
   assert.equal((await api('/wp-json/wp/v2/navigation','POST',{title:stamp},cookie)).response.status,403);
   assert.equal((await api('/wp-json/wp/v2/blocks','GET',undefined,cookie)).response.status,200);
   assert.equal((await api('/wp-json/wp/v2/block-types','GET',undefined,cookie)).response.status,200);
  }
  const mine=await api('/wp-json/wp/v2/blocks','POST',{title:stamp,content:'<!-- wp:paragraph --><p>Author reusable</p><!-- /wp:paragraph -->'},people.author);assert.equal(mine.response.status,201);entities.push(mine.data.id);
  assert.equal((await api('/wp-json/wp/v2/blocks/'+mine.data.id,'PUT',{title:'Author changed'},people.author)).response.status,200);
  const other=await api('/wp-json/wp/v2/blocks','POST',{title:stamp+' other'},admin);entities.push(other.data.id);
  assert.equal((await api('/wp-json/wp/v2/blocks/'+other.data.id,'PUT',{title:'Forbidden'},people.author)).response.status,403);
  assert.equal((await api('/wp-json/wp/v2/blocks/'+other.data.id+'?force=true','DELETE',undefined,people.author)).response.status,403);
  assert.equal((await api('/wp-json/wp/v2/blocks/'+other.data.id,'PUT',{title:stamp+' editor changed'},people.editor)).response.status,200);
  assert.equal((await api('/wp-json/wp/v2/blocks','POST',{title:stamp},people.contributor)).response.status,403);
 }finally{
  await pool.query('DELETE FROM block_entities WHERE id=ANY($1::int[])',[entities]);for(const id of users)await api('/api/users/'+id,'DELETE',undefined,admin);await api('/api/auth/logout','POST',undefined,admin);await pool.end();
 }
});
