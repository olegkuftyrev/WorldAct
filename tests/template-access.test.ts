import 'dotenv/config';
import assert from 'node:assert/strict';
import test from 'node:test';
import {pool} from '../server/db.js';
const root=process.env.TEST_API_URL||'http://127.0.0.1:3001',origin=process.env.APP_ORIGIN||'http://127.0.0.1:5173';
async function api(path:string,method='GET',body?:unknown,cookie=''){
 const response=await fetch(root+path,{method,headers:{Origin:origin,'Content-Type':'application/json',...(cookie?{Cookie:cookie}:{})},...(body===undefined?{}:{body:JSON.stringify(body)})});return {response,data:await response.json()};
}
test('source templates render protected forms and authorized previews without exposing hidden content',async()=>{
 const stamp='template-'+Date.now().toString(36),login=await api('/api/auth/login','POST',{login:process.env.ADMIN_EMAIL,password:process.env.ADMIN_PASSWORD});assert.equal(login.response.status,200);const cookie=login.response.headers.get('set-cookie')!.split(';')[0],posts:number[]=[];let authorId:number|undefined;
 try{
  const protectedPost=await api('/api/posts','POST',{title:stamp,type:'post',status:'publish',password:'source-passphrase',content:'<!-- wp:paragraph --><p>Hidden source template marker</p><!-- /wp:paragraph -->',excerpt:'Secret excerpt'},cookie);assert.equal(protectedPost.response.status,201);const post=protectedPost.data.post;posts.push(post.id);
  const route='/api/public/templates/single?postId='+post.id+'&requestPath='+encodeURIComponent(post.permalink);
  const locked=await api(route);assert.equal(locked.response.status,200,JSON.stringify(locked.data));assert.match(locked.data.content,/worldact-native-password-form/);assert.match(locked.data.content,/action="\/post-password"/);assert.doesNotMatch(locked.data.content,/Hidden source template marker|Secret excerpt|worldact-native-comment-form/);
  const wrong=await fetch(root+'/post-password',{method:'POST',headers:{Origin:origin},body:new URLSearchParams({postSlug:post.slug,password:'wrong'}),redirect:'manual'});assert.equal(wrong.status,403);
  const unlocked=await fetch(root+'/post-password',{method:'POST',headers:{Origin:origin},body:new URLSearchParams({postSlug:post.slug,password:'source-passphrase'}),redirect:'manual'});assert.equal(unlocked.status,303);const access=unlocked.headers.get('set-cookie')!.split(';')[0];const content=await api(route,'GET',undefined,access);assert.equal(content.response.status,200);assert.match(content.data.content,/Hidden source template marker/);assert.doesNotMatch(content.data.content,/worldact-native-password-form/);
  await api('/api/posts/'+post.id,'PUT',{password:'changed-source-password'},cookie);assert.doesNotMatch((await api(route,'GET',undefined,access)).data.content,/Hidden source template marker/);
  const draft=await api('/api/posts','POST',{title:stamp+' draft',type:'post',status:'draft',content:'<p>Private preview marker</p>'},cookie);posts.push(draft.data.post.id);const preview='/api/public/templates/single?postId='+draft.data.post.id;
  assert.equal((await api(preview)).response.status,404);assert.equal((await api(preview+'&preview=true')).response.status,401);
  const authorized=await api(preview+'&preview=true','GET',undefined,cookie);assert.equal(authorized.response.status,200);assert.match(authorized.data.content,/Private preview marker/);assert.doesNotMatch(authorized.data.content,/worldact-native-comment-form/);assert.match(authorized.response.headers.get('cache-control')!,/private/);assert.equal(authorized.response.headers.get('x-robots-tag'),'noindex, nofollow');
  const author=await api('/api/users','POST',{username:stamp,email:stamp+'@example.test',displayName:'Preview author',role:'author',password:'Temporary-preview-'+stamp},cookie);authorId=author.data.user.id;const signed=await api('/api/auth/login','POST',{login:stamp,password:'Temporary-preview-'+stamp});const authorCookie=signed.response.headers.get('set-cookie')!.split(';')[0];assert.equal((await api(preview+'&preview=true','GET',undefined,authorCookie)).response.status,403);
 }finally{for(const id of posts){await api('/api/posts/'+id,'PUT',{status:'trash'},cookie);await api('/api/posts/'+id,'DELETE',undefined,cookie);}if(authorId)await api('/api/users/'+authorId,'DELETE',undefined,cookie);await api('/api/auth/logout','POST',undefined,cookie);await pool.end();}
});
