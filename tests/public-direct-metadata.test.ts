import test,{after} from './isolated-test.js';
import assert from 'node:assert/strict';
import {pool} from '../server/db.js';
import {hashPassword} from '../server/auth.js';
const base=process.env.TEST_API_URL!,origin=process.env.APP_ORIGIN!,secret='DIRECT-METADATA-RETIRED-A';
after(()=>pool.end());
async function waitFor(sql:string){for(let i=0;i<500;i++){if((await pool.query(sql)).rows[0].ok)return;await new Promise(resolve=>setTimeout(resolve,15));}assert.fail('Missing bounded direct metadata SQL wait');}

test('direct metadata consumers share complete attempts without retiring current public identities',{timeout:180000},async t=>{
 const settings=(await pool.query('SELECT data FROM settings WHERE id=1')).rows[0].data,oldPosts=(await pool.query('SELECT id,status FROM posts')).rows;
 const documents=(await pool.query("SELECT id,theme,content,raw_content,blocks FROM site_documents WHERE slug='single' AND type='template' AND theme=ANY($1::text[])",[['classic','twentytwentyfive']])).rows;
 const people:number[]=[],posts:number[]=[],media:number[]=[],createdDocuments:number[]=[];let view=false,serial=0;
 async function api(path:string,method='GET',body?:unknown,cookie=''){const response=await fetch(base+path,{method,headers:{Origin:origin,'Content-Type':'application/json',...(cookie?{Cookie:cookie}:{})},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(20000)});return {response,text:await response.text()};}
 async function template(theme:string,blocks:any[]){const row=(await pool.query("SELECT id FROM site_documents WHERE slug='single' AND type='template' AND theme=$1",[theme])).rows[0];if(row)await pool.query("UPDATE site_documents SET content='',raw_content='',blocks=$2 WHERE id=$1",[row.id,JSON.stringify(blocks)]);else createdDocuments.push((await pool.query("INSERT INTO site_documents(slug,title,type,theme,content,raw_content,blocks) VALUES('single','Direct metadata','template',$1,'','',$2) RETURNING id",[theme,JSON.stringify(blocks)])).rows[0].id);}
 const block=(name:string,attributes:any={})=>({name:'core/'+name,attributes,innerBlocks:[]});
 try{
  await pool.query("UPDATE posts SET status='draft'");
  for(const username of ['direct_meta_a','direct_meta_b'])people.push((await pool.query("INSERT INTO users(username,email,display_name,password_hash,role,nicename) VALUES($1,$2,$1,'inert-direct-metadata-password','author',$1) RETURNING id",[username,username+'@example.test'])).rows[0].id);
  const columns=(await pool.query("SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name='users' ORDER BY ordinal_position")).rows.map(row=>row.column_name);
  const setup=await pool.connect();try{await setup.query('BEGIN');await setup.query('CREATE TABLE worldact_direct_gate(enabled boolean NOT NULL)');await setup.query('INSERT INTO worldact_direct_gate VALUES(false)');await setup.query('CREATE SEQUENCE worldact_direct_a_calls');await setup.query('CREATE SEQUENCE worldact_direct_b_calls');
   await setup.query(`CREATE FUNCTION worldact_direct_nicename(value varchar) RETURNS varchar LANGUAGE plpgsql STABLE AS $$ BEGIN IF (SELECT enabled FROM worldact_direct_gate) THEN IF value='direct_meta_a' THEN PERFORM nextval('worldact_direct_a_calls'); ELSIF value='direct_meta_b' AND nextval('worldact_direct_b_calls')=1 THEN PERFORM pg_advisory_xact_lock(hashtext('worldact-direct-metadata-wait')); END IF; END IF; RETURN value; END $$`);
   await setup.query('ALTER TABLE users RENAME TO worldact_direct_actual_users');await setup.query('CREATE VIEW users AS SELECT '+columns.map(column=>column==='nicename'?'worldact_direct_nicename(nicename) AS nicename':'"'+column+'"').join(',')+' FROM worldact_direct_actual_users');await setup.query('COMMIT');view=true;
  }catch(error){await setup.query('ROLLBACK');throw error;}finally{setup.release();}
  const scenes=[...['classic','twentytwentyfive'].flatMap(theme=>['breadcrumbs','page-item'].map(surface=>({theme,surface}))),...['sitemap','search','media'].map(surface=>({theme:'classic',surface}))];
  for(const {theme,surface}of scenes)for(const mutation of ['private','type','owner','stable'])await t.test(theme+' '+surface+' '+mutation+' at later different-author expression',async()=>{
   await pool.query('UPDATE worldact_direct_gate SET enabled=false');const n=++serial,own:number[]=[],ownMedia:number[]=[],page=['breadcrumbs','page-item'].includes(surface);
   async function post(author:number,label:string,type='post',password:string|null=null){const row=(await pool.query("INSERT INTO posts(type,title,slug,content,raw_content,excerpt,status,author_id,password_hash,published_at,sticky) VALUES($1,$2,$3,'<p>Public body</p>','<p>Public body</p>','public excerpt','publish',$4,$5,clock_timestamp()+interval '1 day',true) RETURNING id,slug",[type,label==='a'?secret:'safe-'+label,'direct-meta-'+n+'-'+label,author,password])).rows[0];own.push(row.id);posts.push(row.id);return row;}
   const a=await post(people[0],'a',page?'page':'post'),b=await post(people[1],'b'),c=await post(people[0],'c');
   await pool.query("UPDATE settings SET data=data || $1::jsonb WHERE id=1",[JSON.stringify({theme,siteUrl:origin,permalinkStructure:'/%author%/%post_id%/%postname%/',postsPerPage:1,frontPageMode:'page',frontPageId:null,postsPageId:page?a.id:null,pingServices:[],showAvatars:false})]);
   const blocks=[block('post-content'),page?block(surface==='breadcrumbs'?'breadcrumbs':'page-list-item',surface==='page-item'?{id:a.id}:{}):block('paragraph',{content:'unused'}),block('latest-posts',{postsToShow:1,selectedAuthor:people[1],displayPostContent:false})];
   await template(theme,blocks);
   let path='/api/public/templates/single?'+new URLSearchParams({postId:String(c.id),requestPath:'/?p='+c.id});
   const oldCanonical=page?'/'+a.slug+'/':'/direct_meta_a/'+a.id+'/'+a.slug+'/';
   if(surface==='sitemap')path='/sitemap.xml';
   if(surface==='search')path='/wp-json/wp/v2/search?'+new URLSearchParams({search:'',per_page:'100'});
   if(surface==='media'){
    for(const parent of [a,b]){const item=(await pool.query("INSERT INTO media(author_id,title,filename,mime_type,size,width,height,attached_post_id) VALUES($1,$2,$2,'image/png',1,1,1,$3) RETURNING id",[people[0],'direct-meta-'+n+'-media-'+parent.id+'.png',parent.id])).rows[0];ownMedia.push(item.id);media.push(item.id);}
    path='/wp-json/wp/v2/media?'+new URLSearchParams({include:ownMedia.join(','),orderby:'include',_embed:'wp:attached-to'});
   }
   const before=await api(path);assert.equal(before.response.status,200,before.text);assert.ok(before.text.includes(oldCanonical),'the acquired A canonical must actually be in baseline output');
   const control=await pool.connect();let pending:ReturnType<typeof api>|undefined;
   try{
    await pool.query('ALTER SEQUENCE worldact_direct_a_calls RESTART WITH 1');await pool.query('ALTER SEQUENCE worldact_direct_b_calls RESTART WITH 1');await pool.query('UPDATE worldact_direct_gate SET enabled=true');await control.query('BEGIN');await control.query("SELECT pg_advisory_xact_lock(hashtext('worldact-direct-metadata-wait'))");pending=api(path);
    await waitFor("SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event='advisory' AND position('SELECT u.nicename FROM posts p JOIN users u' in query)>0) AS ok");
    if(!page){await waitFor('SELECT is_called AS ok FROM worldact_direct_a_calls');await waitFor("SELECT NOT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid() AND state='active' AND wait_event IS DISTINCT FROM 'advisory') AS ok");}
    if(mutation==='private')await pool.query("UPDATE posts SET status='private' WHERE id=$1",[a.id]);else if(mutation==='type')await pool.query('UPDATE posts SET type=$2 WHERE id=$1',[a.id,page?'post':'page']);else if(mutation==='owner')await pool.query('UPDATE posts SET author_id=$2 WHERE id=$1',[a.id,people[1]]);
    await control.query('COMMIT');const result=await pending;assert.equal(result.response.status,200,result.text);
    const calls=Number((await pool.query('SELECT last_value FROM worldact_direct_b_calls')).rows[0].last_value);assert.equal(calls>=2,mutation!=='stable','only a changed accumulated policy should trigger complete reacquisition');
    if(mutation==='private'||page&&mutation==='type')assert.equal(result.text.includes(oldCanonical),false);
    if(mutation==='private'&&surface!=='sitemap')assert.equal(result.text.includes(secret),false,'private A title must not persist in output or embedding cache');
    if(!page&&['type','owner'].includes(mutation)){
     assert.equal(result.text.includes(oldCanonical),false);const expected=mutation==='type'?'/'+a.slug+'/':'/direct_meta_b/'+a.id+'/'+a.slug+'/';assert.ok(result.text.includes(expected),'current public identity must remain discoverable');
     if(surface==='search')assert.equal(JSON.parse(result.text).find((item:any)=>item.id===a.id).subtype,mutation==='type'?'page':'post');
     if(surface==='media'){const parent=JSON.parse(result.text).find((item:any)=>item.id===ownMedia[0])._embedded['wp:attached-to'][0];assert.equal(parent.id,a.id);assert.equal(parent.type,mutation==='type'?'page':'post');}
    }
    if(mutation==='stable')assert.ok(result.text.includes(oldCanonical));
   }finally{await control.query('ROLLBACK');control.release();if(pending)await pending.catch(()=>{});await pool.query('UPDATE worldact_direct_gate SET enabled=false');if(ownMedia.length)await pool.query('DELETE FROM media WHERE id=ANY($1::int[])',[ownMedia]);await pool.query('DELETE FROM posts WHERE id=ANY($1::int[])',[own]);}
  });
  for(const theme of ['classic','twentytwentyfive'])await t.test(theme+' local protected feed stays generic with a valid request grant and later expiry',async()=>{
   await pool.query('UPDATE worldact_direct_gate SET enabled=false');const n=++serial,own:number[]=[];
   async function post(author:number,label:string,password:string|null=null){const row=(await pool.query("INSERT INTO posts(type,title,slug,content,raw_content,excerpt,status,author_id,password_hash,published_at) VALUES('post',$1::text,$2,$1::text,$1::text,$1::text,'publish',$3,$4,clock_timestamp()+interval '1 day') RETURNING id,slug",[label==='a'?secret:'safe-'+label,'direct-protected-'+n+'-'+label,author,password])).rows[0];own.push(row.id);posts.push(row.id);return row;}
   const a=await post(people[0],'a',await hashPassword('Direct-feed-password')),b=await post(people[1],'b'),c=await post(people[0],'c');await pool.query("UPDATE posts SET title='Safe protected A' WHERE id=$1",[a.id]);
   await pool.query('UPDATE settings SET data=data || $1::jsonb WHERE id=1',[JSON.stringify({theme,siteUrl:origin,permalinkStructure:'/%author%/%post_id%/%postname%/',feedItems:3,frontPageMode:'posts',postsPageId:null,pingServices:[]})]);await template(theme,[block('post-content'),block('rss',{feedURL:origin+'/feed/',itemsToShow:3,displayExcerpt:true,excerptLength:100})]);
   const unlocked=await api('/api/public/posts/'+a.slug+'/unlock','POST',{password:'Direct-feed-password'});assert.equal(unlocked.response.status,200);const cookie=unlocked.response.headers.get('set-cookie')!.split(';')[0],path='/api/public/templates/single?'+new URLSearchParams({postId:String(c.id),requestPath:'/?p='+c.id});
   const before=await api(path,'GET',undefined,cookie);assert.equal(before.response.status,200,before.text);assert.equal(before.text.includes(secret),false);assert.match(before.text,/There is no excerpt because this is a protected post/);
   const control=await pool.connect();let pending:ReturnType<typeof api>|undefined;
   try{await pool.query('ALTER SEQUENCE worldact_direct_b_calls RESTART WITH 1');await pool.query('UPDATE worldact_direct_gate SET enabled=true');await control.query('BEGIN');await control.query("SELECT pg_advisory_xact_lock(hashtext('worldact-direct-metadata-wait'))");pending=api(path,'GET',undefined,cookie);await waitFor("SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event='advisory' AND position('SELECT u.nicename FROM posts p JOIN users u' in query)>0) AS ok");await pool.query("UPDATE post_access_tokens SET expires_at=clock_timestamp()-interval '1 second' WHERE post_id=$1",[a.id]);await control.query('COMMIT');const result=await pending;assert.equal(result.response.status,200,result.text);assert.equal(result.text.includes(secret),false);assert.match(result.text,/There is no excerpt because this is a protected post/);assert.equal(Number((await pool.query('SELECT last_value FROM worldact_direct_b_calls')).rows[0].last_value),1,'generic protected metadata does not compare an invented grant policy');}
   finally{await control.query('ROLLBACK');control.release();if(pending)await pending.catch(()=>{});await pool.query('UPDATE worldact_direct_gate SET enabled=false');await pool.query('DELETE FROM posts WHERE id=ANY($1::int[])',[own]);}
  });
 }finally{
  if(view){const restore=await pool.connect();try{await restore.query('BEGIN');await restore.query('DROP VIEW users');await restore.query('ALTER TABLE worldact_direct_actual_users RENAME TO users');await restore.query('DROP FUNCTION worldact_direct_nicename(varchar)');await restore.query('DROP TABLE worldact_direct_gate');await restore.query('DROP SEQUENCE worldact_direct_a_calls');await restore.query('DROP SEQUENCE worldact_direct_b_calls');await restore.query('COMMIT');}catch(error){await restore.query('ROLLBACK');throw error;}finally{restore.release();}}
  for(const doc of documents)await pool.query('UPDATE site_documents SET content=$2,raw_content=$3,blocks=$4 WHERE id=$1',[doc.id,doc.content,doc.raw_content,JSON.stringify(doc.blocks)]);if(createdDocuments.length)await pool.query('DELETE FROM site_documents WHERE id=ANY($1::int[])',[createdDocuments]);if(media.length)await pool.query('DELETE FROM media WHERE id=ANY($1::int[])',[media]);if(posts.length)await pool.query('DELETE FROM posts WHERE id=ANY($1::int[])',[posts]);if(people.length)await pool.query('DELETE FROM users WHERE id=ANY($1::int[])',[people]);await pool.query('UPDATE settings SET data=$1 WHERE id=1',[settings]);for(const post of oldPosts)await pool.query('UPDATE posts SET status=$2 WHERE id=$1',[post.id,post.status]);
 }
});
