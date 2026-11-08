import test from './isolated-test.js';
import 'dotenv/config';
import assert from 'node:assert/strict';
import {pool} from '../server/db.js';
const root=process.env.TEST_API_URL||'http://127.0.0.1:3001',origin=process.env.APP_ORIGIN||'http://127.0.0.1:5173';
async function api(path:string,method='GET',body?:unknown,cookie=''){
 const response=await fetch(root+path,{method,headers:{Origin:origin,'Content-Type':'application/json',...(cookie?{Cookie:cookie}:{})},...(body===undefined?{}:{body:JSON.stringify(body)})});return {response,data:await response.json()};
}
test('editing leases serialize takeovers, block competing saves and autosaves, expire and respect roles',async()=>{
 const stamp='lease-'+Date.now().toString(36),login=await api('/api/auth/login','POST',{login:process.env.ADMIN_EMAIL,password:process.env.ADMIN_PASSWORD});assert.equal(login.response.status,200);
 const admin=login.response.headers.get('set-cookie')!.split(';')[0],users:number[]=[],posts:number[]=[];
 try{
  const people:Record<string,{id:number;cookie:string}>={};
  for(const role of ['editor','author','subscriber']){const user=await api('/api/users','POST',{username:stamp+role,email:stamp+role+'@example.test',displayName:'Lease '+role,password:'Temporary-lease-'+stamp,role},admin);assert.equal(user.response.status,201);users.push(user.data.user.id);const signed=await api('/api/auth/login','POST',{login:stamp+role,password:'Temporary-lease-'+stamp});people[role]={id:user.data.user.id,cookie:signed.response.headers.get('set-cookie')!.split(';')[0]};}
  const created=await api('/api/posts','POST',{title:stamp,type:'post',status:'draft'},admin);const post=created.data.post;posts.push(post.id);const route='/api/posts/'+post.id;
  assert.equal((await api(route+'/lock')).response.status,401);assert.equal((await api(route+'/lock','PUT',{},people.subscriber.cookie)).response.status,403);assert.equal((await api(route+'/lock','PUT',{},people.author.cookie)).response.status,403);
  const acquired=await api(route+'/lock','PUT',{},admin);assert.equal(acquired.response.status,200);assert.equal(acquired.data.lock.owned,true);assert.equal(acquired.data.lock.userId,login.data.user.id);
  const blocked=await api(route+'/lock','PUT',{},people.editor.cookie);assert.equal(blocked.response.status,409);assert.equal(blocked.data.lock.owned,false);
  assert.equal((await api(route,'PUT',{title:'Should not save'},people.editor.cookie)).response.status,409);
  assert.equal((await api(route+'/autosave','PUT',{title:'Should not autosave'},people.editor.cookie)).response.status,409);
  assert.equal((await api(route+'/lock','DELETE',undefined,people.editor.cookie)).data.released,false);
  const taken=await api(route+'/lock','PUT',{takeover:true},people.editor.cookie);assert.equal(taken.response.status,200);assert.equal(taken.data.lock.userId,people.editor.id);
  assert.equal((await api(route,'PUT',{title:stamp+' accepted',version:post.version},people.editor.cookie)).response.status,200);
  assert.equal((await api(route,'PUT',{title:'Lost lease'},admin)).response.status,409);
  assert.equal((await api(route+'/lock','DELETE',undefined,people.editor.cookie)).data.released,true);
  const simultaneous=await Promise.all([api(route+'/lock','PUT',{},admin),api(route+'/lock','PUT',{},people.editor.cookie)]);assert.deepEqual(simultaneous.map(item=>item.response.status).sort(),[200,409]);
  await pool.query("UPDATE post_edit_locks SET expires_at=now()-interval '1 second' WHERE post_id=$1",[post.id]);
  assert.equal((await api(route+'/lock','GET',undefined,admin)).data.lock,null);assert.equal((await api(route+'/lock','PUT',{},admin)).response.status,200);
 }finally{
  for(const id of posts){await pool.query('DELETE FROM post_edit_locks WHERE post_id=$1',[id]);await api('/api/posts/'+id,'PUT',{status:'trash'},admin);await api('/api/posts/'+id,'DELETE',undefined,admin);}
  for(const id of users)await api('/api/users/'+id,'DELETE',undefined,admin);
  await api('/api/auth/logout','POST',undefined,admin);await pool.end();
 }
});
