import {test,after} from './isolated-test.js';
import 'dotenv/config';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import {pool,getSettings} from '../server/db.js';
const root=process.env.TEST_API_URL||'http://127.0.0.1:3001',origin=process.env.APP_ORIGIN||'http://127.0.0.1:5173';
async function api(path:string,method='GET',body?:unknown,cookie=''){
 const response=await fetch(root+path,{method,headers:{Origin:origin,'Content-Type':'application/json',...(cookie?{Cookie:cookie}:{})},...(body===undefined?{}:{body:JSON.stringify(body)})});return {response,data:await response.json()};
}
test('administration email changes require single-use explicit confirmation with resend, expiry and cancellation',async()=>{
 const stamp='identity-'+Date.now().toString(36),login=await api('/api/auth/login','POST',{login:process.env.ADMIN_EMAIL,password:process.env.ADMIN_PASSWORD});assert.equal(login.response.status,200);
 const cookie=login.response.headers.get('set-cookie')!.split(';')[0],before=(await pool.query('SELECT data FROM settings WHERE id=1')).rows[0].data;
 const email=stamp+'@example.test';
 const latestToken=async()=>{const row=(await pool.query('SELECT body FROM mail_outbox WHERE recipient=$1 ORDER BY id DESC LIMIT 1',[email])).rows[0];return row.body.match(/confirm-admin-email\?token=([a-f0-9]{64})/)[1] as string;};
 try{
  assert.equal((await api('/api/settings/admin-email')).response.status,401);
  const changed=await api('/api/settings','PUT',{adminEmail:email,weekStartsOn:0,dateFormat:'Y-m-d',timeFormat:'H:i'},cookie);assert.equal(changed.response.status,200);assert.equal(changed.data.settings.adminEmail,before.adminEmail);assert.equal(changed.data.pendingAdminEmail.email,email);assert.equal(changed.data.settings.weekStartsOn,0);
  const token=await latestToken();assert.notEqual((await pool.query('SELECT token_hash FROM site_email_changes')).rows[0].token_hash,token);
  const preview=await api('/api/settings/admin-email/confirmation?token='+token);assert.equal(preview.response.status,200);assert.equal((await getSettings()).adminEmail,before.adminEmail);
  await api('/api/settings','PUT',{tagline:'Still pending',adminEmail:before.adminEmail},cookie);assert.equal((await api('/api/settings/admin-email','GET',undefined,cookie)).data.pending.email,email);
  await api('/api/settings/admin-email/resend','POST',{},cookie);const rotated=await latestToken();assert.notEqual(rotated,token);assert.equal((await api('/api/settings/admin-email/confirmation?token='+token)).response.status,410);
  assert.equal((await api('/api/settings/admin-email/confirmation','POST',{token:rotated})).response.status,200);assert.equal((await getSettings()).adminEmail,email);assert.equal((await api('/api/settings/admin-email/confirmation','POST',{token:rotated})).response.status,410);
  const notification=await pool.query('SELECT body FROM mail_outbox WHERE recipient=$1 AND body LIKE $2',[before.adminEmail,'%'+email+'%']);assert.ok(notification.rowCount);
  await api('/api/settings','PUT',{adminEmail:stamp+'-expired@example.test'},cookie);await pool.query("UPDATE site_email_changes SET expires_at=now()-interval '1 second'");assert.equal((await api('/api/settings/admin-email','GET',undefined,cookie)).data.pending.expired,true);
  const expired=(await pool.query('SELECT body FROM mail_outbox WHERE recipient=$1',[stamp+'-expired@example.test'])).rows[0].body.match(/token=([a-f0-9]{64})/)[1];assert.equal((await api('/api/settings/admin-email/confirmation?token='+expired)).response.status,410);
  assert.equal((await api('/api/settings/admin-email','DELETE',undefined,cookie)).response.status,200);assert.equal((await api('/api/settings/admin-email','GET',undefined,cookie)).data.pending,null);
  assert.equal((await api('/api/public/site')).data.settings.adminEmail,undefined);
 }finally{await pool.query('UPDATE settings SET data=$1::jsonb WHERE id=1',[JSON.stringify(before)]);await pool.query('DELETE FROM site_email_changes');await pool.query('DELETE FROM mail_outbox WHERE recipient LIKE $1 OR body LIKE $2',[stamp+'%','%'+stamp+'%']);await api('/api/auth/logout','POST',undefined,cookie);}
});
test('site icons generate real cropped PNG sizes without changing the source image',async()=>{
 const login=await api('/api/auth/login','POST',{login:process.env.ADMIN_EMAIL,password:process.env.ADMIN_PASSWORD});assert.equal(login.response.status,200);const cookie=login.response.headers.get('set-cookie')!.split(';')[0],ids:number[]=[];
 const before=(await pool.query('SELECT data FROM settings WHERE id=1')).rows[0].data;
 try{
  async function upload(width:number,height:number){const bytes=await sharp({create:{width,height,channels:3,background:'#3858e9'}}).png().toBuffer(),form=new FormData();form.append('file',new Blob([new Uint8Array(bytes)],{type:'image/png'}),'Site Icon fixture.png');const response=await fetch(root+'/api/media',{method:'POST',headers:{Origin:origin,Cookie:cookie},body:form});assert.equal(response.status,201);const media=(await response.json()).media;ids.push(media.id);return {bytes,media};}
  const small=await upload(64,64);assert.equal((await api('/api/settings/site-icon','POST',{mediaId:small.media.id},cookie)).response.status,400);
  const source=await upload(800,600);assert.equal((await api('/api/settings/site-icon','POST',{mediaId:source.media.id,crop:{left:400,top:0,width:512,height:512}},cookie)).response.status,400);
  const icon=await api('/api/settings/site-icon','POST',{mediaId:source.media.id,crop:{left:100,top:20,width:512,height:512}},cookie);assert.equal(icon.response.status,201,JSON.stringify(icon.data));ids.push(icon.data.siteIconId);assert.notEqual(icon.data.siteIconId,source.media.id);assert.equal((await getSettings()).siteIconId,icon.data.siteIconId);
  assert.deepEqual(Buffer.from(await (await fetch(root+source.media.url)).arrayBuffer()),source.bytes);
  for(const size of [16,32,180,192,270]){const response=await fetch(root+icon.data.sizes['icon-'+size].url);assert.equal(response.status,200);const metadata=await sharp(Buffer.from(await response.arrayBuffer())).metadata();assert.equal(metadata.width,size);assert.equal(metadata.height,size);}
  await api('/api/media/'+icon.data.siteIconId,'DELETE',undefined,cookie);assert.equal((await getSettings()).siteIconId,0);
 }finally{for(const id of ids)await api('/api/media/'+id,'DELETE',undefined,cookie);await pool.query('UPDATE settings SET data=$1::jsonb WHERE id=1',[JSON.stringify(before)]);await api('/api/auth/logout','POST',undefined,cookie);}
});
after(()=>pool.end());
