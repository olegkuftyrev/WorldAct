import 'dotenv/config';
import assert from 'node:assert/strict';
import test from 'node:test';
import {pool} from '../server/db.js';
const root=process.env.TEST_API_URL||'http://127.0.0.1:3001',origin=process.env.APP_ORIGIN||'http://127.0.0.1:5173';
async function api(path:string,method='GET',body?:unknown,cookie=''){
 const response=await fetch(root+path,{method,headers:{Origin:origin,'Content-Type':'application/json',...(cookie?{Cookie:cookie}:{})},...(body===undefined?{}:{body:JSON.stringify(body)})});return {response,data:await response.json()};
}
test('native source comment and logout forms reuse access checks and redirect locally',async()=>{
 const stamp='form-'+Date.now().toString(36),login=await api('/api/auth/login','POST',{login:process.env.ADMIN_EMAIL,password:process.env.ADMIN_PASSWORD});assert.equal(login.response.status,200);
 const cookie=login.response.headers.get('set-cookie')!.split(';')[0];let postId:number|undefined;
 try{
  const post=await api('/api/posts','POST',{title:stamp,type:'post',status:'publish',commentStatus:'open'},cookie);assert.equal(post.response.status,201);postId=post.data.post.id;
  const form=new URLSearchParams({comment_post_ID:String(postId),author:'Native author',email:stamp+'@example.test',url:'https://example.test/',comment:'<p>Native body<script>bad()</script></p>'});
  const foreign=await fetch(root+'/wp-comments-post.php',{method:'POST',headers:{Origin:'https://foreign.invalid'},body:form,redirect:'manual'});assert.equal(foreign.status,403);
  const submitted=await fetch(root+'/wp-comments-post.php',{method:'POST',headers:{Origin:origin},body:form,redirect:'manual'});assert.equal(submitted.status,303,await submitted.text());assert.ok(submitted.headers.get('location')!.startsWith('/posts/'+post.data.post.slug+'/'));
  const comment=await pool.query('SELECT content,status FROM comments WHERE post_id=$1',[postId]);assert.equal(comment.rowCount,1);assert.equal(comment.rows[0].content,'<p>Native body</p>');
  const logout=await fetch(root+'/logout',{method:'POST',headers:{Origin:origin,Cookie:cookie},body:new URLSearchParams({redirect_to:'https://evil.invalid/'}),redirect:'manual'});assert.equal(logout.status,303);assert.equal(logout.headers.get('location'),'/');assert.match(logout.headers.get('set-cookie')!,/worldact_session=;/);assert.equal((await api('/api/session','GET',undefined,cookie)).data.user,null);
 }finally{
  const relogin=await api('/api/auth/login','POST',{login:process.env.ADMIN_EMAIL,password:process.env.ADMIN_PASSWORD});const cleanup=relogin.response.headers.get('set-cookie')!.split(';')[0];
  if(postId){await api('/api/posts/'+postId,'PUT',{status:'trash'},cleanup);await api('/api/posts/'+postId,'DELETE',undefined,cleanup);}
  await api('/api/auth/logout','POST',undefined,cleanup);await pool.end();
 }
});
