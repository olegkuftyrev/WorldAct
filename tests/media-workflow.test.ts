import 'dotenv/config';
import assert from 'node:assert/strict';
import test from 'node:test';
import sharp from 'sharp';
import {pool} from '../server/db.js';
const root=process.env.TEST_API_URL||'http://127.0.0.1:3001',origin=process.env.APP_ORIGIN||'http://127.0.0.1:5173';
async function api(path:string,method='GET',body?:unknown,cookie=''){
 const response=await fetch(root+path,{method,headers:{Origin:origin,'Content-Type':'application/json',...(cookie?{Cookie:cookie}:{})},...(body===undefined?{}:{body:JSON.stringify(body)})});return {response,data:await response.json()};
}
test('media lists use real pagination, attachment metadata, file deletion and ownership checks',async()=>{
 const stamp='media-'+Date.now().toString(36),login=await api('/api/auth/login','POST',{login:process.env.ADMIN_EMAIL,password:process.env.ADMIN_PASSWORD});assert.equal(login.response.status,200);
 const cookie=login.response.headers.get('set-cookie')!.split(';')[0],ids:number[]=[],posts:number[]=[];let authorId:number|undefined;
 try{
  const image=await sharp({create:{width:20,height:20,channels:3,background:'red'}}).png().toBuffer();
  for(let i=0;i<3;i++){
   const body=new FormData();body.append('file',new Blob([new Uint8Array(image)],{type:'image/png'}),stamp+'-'+i+'.png');
   const response=await fetch(root+'/api/media',{method:'POST',headers:{Origin:origin,Cookie:cookie},body});const data=await response.json();assert.equal(response.status,201,JSON.stringify(data));ids.push(data.media.id);
  }
  const post=await api('/api/posts','POST',{title:stamp+' post',type:'post',status:'draft'},cookie);assert.equal(post.response.status,201);posts.push(post.data.post.id);
  const attached=await api('/api/media/'+ids[0],'PUT',{attachedPostId:posts[0],description:'<p>Description<script>bad()</script></p>',commentStatus:'open'},cookie);assert.equal(attached.response.status,200);assert.equal(attached.data.media.attachedPostTitle,stamp+' post');assert.equal(attached.data.media.description,'<p>Description</p>');
  const page=await api('/api/media?search='+stamp+'&perPage=1&page=2&orderby=title&order=asc','GET',undefined,cookie);assert.equal(page.response.status,200,JSON.stringify(page.data));assert.equal(page.data.media[0].id,ids[1]);assert.equal(page.data.pagination.total,3);assert.ok(page.data.months.length);
  const unattached=await api('/api/media?search='+stamp+'&unattached=true&type=image','GET',undefined,cookie);assert.equal(unattached.data.media.length,2);
  const month=await api('/api/media?search='+stamp+'&month='+page.data.months[0],'GET',undefined,cookie);assert.equal(month.data.pagination.total,3);
  assert.equal((await api('/api/media/'+ids[0],'PUT',{attachedPostId:2147483647},cookie)).response.status,400);
  const author=await api('/api/users','POST',{username:stamp,email:stamp+'@example.test',displayName:'Media author',password:'Temporary-media-'+stamp,role:'author'},cookie);authorId=author.data.user.id;
  const authorLogin=await api('/api/auth/login','POST',{login:stamp,password:'Temporary-media-'+stamp});const authorCookie=authorLogin.response.headers.get('set-cookie')!.split(';')[0];
  assert.equal((await api('/api/media?search='+stamp,'GET',undefined,authorCookie)).data.media.length,0);
  const denied=await api('/api/media/bulk','POST',{ids:[ids[0]],action:'delete'},authorCookie);assert.equal(denied.data.updated,0);assert.equal(denied.data.errors[0].id,ids[0]);
  const linked=await api('/api/media/bulk','POST',{ids:ids.slice(1),action:'attach',postId:posts[0]},cookie);assert.equal(linked.data.updated,2);
  await api('/api/posts/'+posts[0],'PUT',{status:'trash'},cookie);await api('/api/posts/'+posts[0],'DELETE',undefined,cookie);
  assert.equal((await api('/api/media/'+ids[0],'GET',undefined,cookie)).data.media.attachedPostId,null);
  const files=(await api('/api/media/'+ids[0],'GET',undefined,cookie)).data.media;
  const deleted=await api('/api/media/bulk','POST',{ids:[...ids,2147483647],action:'delete'},cookie);assert.equal(deleted.data.updated,3);assert.equal(deleted.data.errors.length,1);
  assert.equal((await fetch(root+files.url)).status,404);
  for(const size of Object.values(files.sizes) as any[])assert.equal((await fetch(root+size.url)).status,404);
 }finally{
  for(const id of ids)await api('/api/media/'+id,'DELETE',undefined,cookie);
  for(const id of posts){await api('/api/posts/'+id,'PUT',{status:'trash'},cookie);await api('/api/posts/'+id,'DELETE',undefined,cookie);}
  if(authorId)await api('/api/users/'+authorId,'DELETE',undefined,cookie);
  await api('/api/auth/logout','POST',undefined,cookie);await pool.end();
 }
});
