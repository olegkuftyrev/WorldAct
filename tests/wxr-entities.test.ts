import test from './isolated-test.js';
import 'dotenv/config';
import assert from 'node:assert/strict';
import {XMLParser} from 'fast-xml-parser';
import {parse} from '@wordpress/block-serialization-default-parser';
import {pool} from '../server/db.js';
const root=process.env.TEST_API_URL||'http://127.0.0.1:3001',origin=process.env.APP_ORIGIN||'http://127.0.0.1:5173';
async function api(path:string,method='GET',body?:unknown,cookie=''){
 const response=await fetch(root+path,{method,headers:{Origin:origin,'Content-Type':'application/json',...(cookie?{Cookie:cookie}:{})},...(body===undefined?{}:{body:JSON.stringify(body)})});return {response,data:await response.json()};
}
const block=(name:string,attrs:unknown)=>`<!-- wp:${name} ${JSON.stringify(attrs)} /-->`;
const item=(id:number,type:string,title:string,content:string)=>`<item><wp:post_id>${id}</wp:post_id><wp:post_type>${type}</wp:post_type><title>${title}</title><wp:post_name>${title}</wp:post_name><wp:status>publish</wp:status><content:encoded><![CDATA[${content}]]></content:encoded></item>`;
test('WXR synced patterns and navigation survive forward references, ID collisions, export and rollback',async()=>{
 const stamp='wxr-'+Date.now().toString(36),login=await api('/api/auth/login','POST',{login:process.env.ADMIN_EMAIL,password:process.env.ADMIN_PASSWORD});assert.equal(login.response.status,200);
 const cookie=login.response.headers.get('set-cookie')!.split(';')[0],posts:number[]=[],entities:number[]=[];
 const xml=`<rss xmlns:wp="http://wordpress.org/export/1.2/" xmlns:content="http://purl.org/rss/1.0/modules/content/"><channel><wp:wxr_version>1.2</wp:wxr_version>${item(1,'post',stamp+'-post',block('block',{ref:2})+block('navigation',{ref:3}))}${item(2,'wp_block',stamp+'-parent',block('block',{ref:4}))}${item(3,'wp_navigation',stamp+'-nav',block('navigation-link',{label:'Portable nav',url:'/portable'}))}${item(4,'wp_block',stamp+'-child','<!-- wp:paragraph --><p>Portable nested body</p><!-- /wp:paragraph -->')}</channel></rss>`;
 try{
  const imported=await api('/api/tools/import','POST',{format:'wxr',xml},cookie);assert.equal(imported.response.status,201,JSON.stringify(imported.data));posts.push(...imported.data.postIds);entities.push(...imported.data.blockEntityIds);assert.equal(entities.length,3);assert.equal(imported.data.skippedItems,0);assert.deepEqual(imported.data.warnings,[]);
  const post=(await api('/api/posts/'+posts[0],'GET',undefined,cookie)).data.post;assert.equal(parse(post.rawContent)[0].attrs!.ref,entities[0]);
  const rendered=(await api('/api/public/posts/'+post.slug)).data.post.content;assert.match(rendered,/Portable nested body/);assert.match(rendered,/Portable nav/);
  const exportedResponse=await fetch(root+'/api/tools/export?format=wxr',{headers:{Cookie:cookie}});assert.equal(exportedResponse.status,200);const exported=await exportedResponse.text();
  const doc=new XMLParser({ignoreAttributes:false,parseTagValue:false}).parse(exported);const items=doc.rss.channel.item;
  const original=items.find((entry:any)=>entry.title===stamp+'-post'),parent=items.find((entry:any)=>entry.title===stamp+'-parent'),nav=items.find((entry:any)=>entry.title===stamp+'-nav');
  assert.equal(parent['wp:post_type'],'wp_block');assert.equal(nav['wp:post_type'],'wp_navigation');assert.equal(parse(original['content:encoded'])[0].attrs!.ref,Number(parent['wp:post_id']));assert.equal(parse(original['content:encoded'])[1].attrs!.ref,Number(nav['wp:post_id']));
  assert.equal(new Set(items.map((entry:any)=>entry['wp:post_id'])).size,items.length);
  const failed=await api('/api/tools/import','POST',{format:'wxr',xml:xml.replace('<wp:post_type>post</wp:post_type>','<wp:post_type>page</wp:post_type>').replace('<wp:post_name>'+stamp+'-post</wp:post_name>','<wp:post_parent>1</wp:post_parent>')},cookie);assert.equal(failed.response.status,400);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM block_entities WHERE title LIKE $1',[stamp+'%'])).rows[0].n,3);
 }finally{
  for(const id of posts){await api('/api/posts/'+id,'PUT',{status:'trash'},cookie);await api('/api/posts/'+id,'DELETE',undefined,cookie);}
  await pool.query('DELETE FROM block_entities WHERE id=ANY($1::int[])',[entities]);await api('/api/auth/logout','POST',undefined,cookie);await pool.end();
 }
});
