import test from './isolated-test.js';
import 'dotenv/config';
import assert from 'node:assert/strict';
import {pool} from '../server/db.js';
const root=process.env.TEST_API_URL||'http://127.0.0.1:3001',origin=process.env.APP_ORIGIN||'http://127.0.0.1:5173';
async function api(path:string,method='GET',body?:unknown,cookie=''){
 const response=await fetch(root+path,{method,headers:{Origin:origin,'Content-Type':'application/json',...(cookie?{Cookie:cookie}:{})},...(body===undefined?{}:{body:JSON.stringify(body)})});
 return {response,data:await response.json()};
}
test('user table filters, extended creation, notifications and bulk actions enforce account boundaries',async()=>{
 const stamp='users-'+Date.now().toString(36),login=await api('/api/auth/login','POST',{login:process.env.ADMIN_EMAIL,password:process.env.ADMIN_PASSWORD});
 assert.equal(login.response.status,200);const cookie=login.response.headers.get('set-cookie')!.split(';')[0],ids:number[]=[];
 try{
  for(let i=0;i<3;i++){
   const created=await api('/api/users','POST',{username:stamp+'-'+i,email:stamp+'-'+i+'@example.test',displayName:'User '+i,password:'Temporary-users-'+stamp,role:i===0?'editor':'subscriber',firstName:'First '+i,lastName:'Last',website:'https://example.test/',sendNotification:i===0},cookie);
   assert.equal(created.response.status,201,JSON.stringify(created.data));ids.push(created.data.user.id);assert.equal(created.data.user.firstName,'First '+i);
  }
  assert.equal((await api('/api/users','POST',{username:stamp+'-0',email:'other-'+stamp+'@example.test',displayName:'Duplicate',password:'Temporary-users-'+stamp,role:'subscriber'},cookie)).response.status,409);
  assert.equal((await api('/api/users','POST',{username:stamp+'-0@example.test',email:'cross-'+stamp+'@example.test',displayName:'Ambiguous identity',password:'Temporary-users-'+stamp,role:'subscriber'},cookie)).response.status,409);
  assert.equal((await api('/api/users/'+ids[1],'PUT',{email:stamp+'-0@example.test'},cookie)).response.status,409);
  const listing=await api('/api/users?search='+stamp+'&perPage=1&page=2&orderby=username&order=desc','GET',undefined,cookie);
  assert.equal(listing.response.status,200);assert.equal(listing.data.pagination.total,3);assert.equal(listing.data.pagination.totalPages,3);assert.equal(listing.data.users[0].id,ids[1]);assert.equal(listing.data.counts.editor,1);
  const roleList=await api('/api/users?search='+stamp+'&role=editor','GET',undefined,cookie);assert.equal(roleList.data.users.length,1);assert.equal(roleList.data.counts.all,3);
  const mail=await pool.query('SELECT body FROM mail_outbox WHERE recipient=$1',[stamp+'-0@example.test']);assert.equal(mail.rowCount,1);assert.match(mail.rows[0].body,/reset-password\?token=[a-f0-9]{64}/);assert.equal(mail.rows[0].body.includes('Temporary-users-'),false);
  const editorLogin=await api('/api/auth/login','POST',{login:stamp+'-0',password:'Temporary-users-'+stamp});const editorCookie=editorLogin.response.headers.get('set-cookie')!.split(';')[0];
  assert.equal((await api('/api/users','GET',undefined,editorCookie)).response.status,403);
  assert.equal((await api('/api/users/bulk','POST',{ids:[ids[1]],action:'role',role:'administrator'},editorCookie)).response.status,403);
  const change=await api('/api/users/bulk','POST',{ids:[ids[1],ids[2],login.data.user.id],action:'role',role:'author'},cookie);assert.equal(change.data.updated,2);assert.equal(change.data.errors.length,1);assert.equal(change.data.errors[0].id,login.data.user.id);
  const selectedTarget=await api('/api/users/bulk','POST',{ids:[ids[1],ids[2]],action:'delete',reassignTo:ids[1]},cookie);assert.equal(selectedTarget.response.status,400);
  const deleted=await api('/api/users/bulk','POST',{ids:[...ids,login.data.user.id],action:'delete',reassignTo:login.data.user.id},cookie);
  // Explicit selected reassignment is rejected before any deletion.
  assert.equal(deleted.response.status,400);
  const done=await api('/api/users/bulk','POST',{ids,action:'delete'},cookie);assert.equal(done.data.updated,3);assert.deepEqual(done.data.errors,[]);
 }finally{
  for(const id of ids)await api('/api/users/'+id,'DELETE',undefined,cookie);
  await pool.query('DELETE FROM mail_outbox WHERE recipient LIKE $1',[stamp+'%']);
  await api('/api/auth/logout','POST',undefined,cookie);await pool.end();
 }
});
