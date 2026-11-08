import test,{after} from './isolated-test.js';
import 'dotenv/config';
import assert from 'node:assert/strict';
import {pool} from '../server/db.js';
import {migrate} from '../server/migrate.js';
import {bundledThemes} from '../server/themes.js';
import {sourceTemplatePartArea} from '../shared/template-areas.js';
import {remapImportedBlockReferences} from '../server/block-portability.js';
after(async()=>{await pool.end();});
const root=process.env.TEST_API_URL||'http://127.0.0.1:3001',origin=process.env.APP_ORIGIN||'http://127.0.0.1:5173';
async function api(path:string,method='GET',body?:unknown,cookie=''){
  const response=await fetch(root+path,{method,headers:{Origin:origin,'Content-Type':'application/json',...(cookie?{Cookie:cookie}:{})},...(body===undefined?{}:{body:JSON.stringify(body)})});return {response,data:await response.json()};
}
const block=(name:string,attrs:unknown={})=>`<!-- wp:${name} ${JSON.stringify(attrs)} /-->`;

test('source template-part areas follow trusted theme.json declarations rather than filenames',()=>{
  const theme=bundledThemes.find(theme=>theme.id==='twentytwentyfive')!;
  assert.equal(sourceTemplatePartArea(theme.themeJSON,'vertical-header'),'header');
  assert.equal(sourceTemplatePartArea(theme.themeJSON,'header-large-title'),'header');
  assert.equal(sourceTemplatePartArea(theme.themeJSON,'footer-columns'),'footer');
  assert.equal(sourceTemplatePartArea(theme.themeJSON,'sidebar'),'uncategorized');
  assert.equal(sourceTemplatePartArea({templateParts:[{name:'x',area:'unsafe'}]},'x'),'uncategorized');
  const copied=remapImportedBlockReferences(block('navigation',{overlay:'twentytwentyfive//dialog'}),[{name:'core/navigation',attributes:{overlay:'twentytwentyfive//dialog'},innerBlocks:[]}],new Map(),{documents:new Map([['twentytwentyfive:template-part:dialog','dialog-copy']])});
  assert.match(copied.rawContent,/twentytwentyfive\/\/dialog-copy/);assert.equal(copied.blocks[0].attributes.overlay,'twentytwentyfive//dialog-copy');
  const missing=remapImportedBlockReferences(block('navigation',{overlay:'twentytwentyfive//missing',overlayMenu:'mobile'}),[],new Map(),{documents:new Map()});
  assert.doesNotMatch(missing.rawContent,/"overlay":/);assert.match(missing.rawContent,/"overlayMenu":"mobile"/);assert.equal(missing.warnings.length,1);
});

test('template-part areas persist through native/platform writes, migration, reset and copied design references',async t=>{
  const signed=await api('/api/auth/login','POST',{login:process.env.ADMIN_EMAIL,password:process.env.ADMIN_PASSWORD});assert.equal(signed.response.status,200);const cookie=signed.response.headers.get('set-cookie')!.split(';')[0];
  const stamp='area-'+Date.now().toString(36),docs:number[]=[],users:number[]=[];
  const request=async(path:string,method='GET',body?:unknown)=>{const r=await api(path,method,body,cookie);assert.ok(r.response.ok,`${path}: ${r.response.status} ${JSON.stringify(r.data)}`);return r;};
  try{
    await t.test('source variants expose correct areas and collection filters',async()=>{
      const header=(await request('/wp-json/wp/v2/template-parts?area=header&wp_theme=twentytwentyfive')).data;
      assert.deepEqual(header.map((p:any)=>p.slug).sort(),['header','header-large-title','vertical-header']);assert.ok(header.every((p:any)=>p.area==='header'&&p.source==='theme'&&!p.is_custom));
      const footer=(await request('/wp-json/wp/v2/template-parts?area=footer&wp_theme=twentytwentyfive')).data;assert.equal(footer.length,3);
      assert.equal((await api('/wp-json/wp/v2/template-parts?area=bad','GET',undefined,cookie)).response.status,400);
      const schema=(await request('/wp-json/wp/v2/template-parts','OPTIONS')).data;assert.ok(schema.schema.properties.area.enum.includes('navigation-overlay'));
      const themes=(await request('/wp-json/wp/v2/themes')).data;assert.ok(themes[0].default_template_part_areas.some((p:any)=>p.area==='navigation-overlay'));
    });
    await t.test('native area-only writes retain content, reject stale versions and preserve theme scope',async()=>{
      const created=await request('/wp-json/wp/v2/template-parts','POST',{slug:stamp,title:stamp,theme:'twentytwentyfour',area:'navigation-overlay',content:block('paragraph',{})});const part=created.data;docs.push(part.wp_id);
      assert.equal(part.area,'navigation-overlay');assert.equal(part.theme,'twentytwentyfour');
      const changed=(await request('/wp-json/wp/v2/template-parts/'+part.id,'POST',{area:'header',version:part.version})).data;
      assert.equal(changed.area,'header');assert.equal(changed.content.raw,part.content.raw);
      assert.equal((await api('/wp-json/wp/v2/template-parts/'+part.id,'POST',{area:'footer',version:part.version},cookie)).response.status,409);
      assert.equal((await api('/wp-json/wp/v2/template-parts/'+part.id,'POST',{area:'bad'},cookie)).response.status,400);
      assert.equal((await api('/wp-json/wp/v2/template-parts/'+part.id,'POST',{theme:'twentytwentyfive'},cookie)).response.status,400);
      assert.ok((await request('/wp-json/wp/v2/template-parts?area=header&wp_theme=twentytwentyfour')).data.some((p:any)=>p.wp_id===part.wp_id));
      assert.ok(!(await request('/wp-json/wp/v2/template-parts?area=header&wp_theme=twentytwentyfive')).data.some((p:any)=>p.wp_id===part.wp_id));
    });
    await t.test('platform omission preserves area, migration preserves edits and trusted reset restores source area',async()=>{
      const legacy=(await request('/wp-json/wp/v2/template-parts/twentytwentyfive//footer-columns')).data;
      await pool.query("UPDATE site_documents SET area='uncategorized',source_metadata=source_metadata-'area' WHERE id=$1",[legacy.wp_id]);
      await migrate();assert.equal((await request('/wp-json/wp/v2/template-parts/'+legacy.id)).data.area,'footer');
      const created=(await request('/api/site-editor/documents','POST',{slug:stamp+'-platform',title:stamp,type:'template-part',area:'navigation-overlay',content:'<p>Owned content</p>'})).data.document;docs.push(created.id);
      assert.equal(created.area,'navigation-overlay');
      const changed=(await request('/api/site-editor/documents/'+created.id,'PUT',{slug:created.slug,title:'Renamed title',type:'template-part',content:created.rawContent,version:created.version})).data.document;assert.equal(changed.area,'navigation-overlay');
      const source=(await request('/wp-json/wp/v2/template-parts/twentytwentyfive//vertical-header')).data;
      await request('/wp-json/wp/v2/template-parts/'+source.id,'POST',{area:'footer',version:source.version});
      await migrate();const customized=(await request('/wp-json/wp/v2/template-parts/'+source.id)).data;assert.equal(customized.area,'footer');assert.equal(customized.source,'custom');assert.equal(customized.is_custom,true);
      const reset=(await request('/api/site-editor/documents/'+source.wp_id+'/reset','POST')).data.document;assert.equal(reset.area,'header');
      assert.equal((await request('/wp-json/wp/v2/template-parts/'+source.id)).data.source,'theme');
      await migrate();assert.equal((await request('/wp-json/wp/v2/template-parts/'+source.id)).data.area,'header');
    });
    await t.test('archives preserve areas with fresh slugs and reject invalid metadata atomically',async()=>{
      const overlay={id:801,slug:stamp+'-dialog',title:'Portable overlay',theme:'twentytwentyfour',type:'template-part',area:'navigation-overlay',content:'<p>Dialog</p>'};
      const nav={id:802,slug:stamp+'-nav',title:'Portable navigation',theme:'twentytwentyfour',type:'template',content:block('navigation',{overlay:'twentytwentyfour//'+overlay.slug}),blocks:[{name:'core/navigation',attributes:{overlay:'twentytwentyfour//'+overlay.slug},innerBlocks:[]}]};
      const payload={application:'WorldAct',version:3,posts:[],documents:[overlay,nav]};
      for(let i=0;i<2;i++){
        const imported=(await request('/api/tools/import','POST',payload)).data;docs.push(...imported.documentIds);
        const records=(await pool.query('SELECT * FROM site_documents WHERE id=ANY($1::int[])',[imported.documentIds])).rows;
        const part=records.find(p=>p.type==='template-part')!,template=records.find(p=>p.type==='template')!;assert.equal(part.area,'navigation-overlay');assert.equal(part.theme,'twentytwentyfour');
        assert.ok(template.raw_content.includes('twentytwentyfour//'+part.slug));assert.equal(template.blocks[0].attributes.overlay,'twentytwentyfour//'+part.slug);
      }
      const exported=(await request('/api/tools/export')).data;assert.ok(exported.documents.some((d:any)=>docs.includes(d.id)&&d.area==='navigation-overlay'));
      const legacy=(await request('/api/tools/import','POST',{application:'WorldAct',version:3,posts:[],documents:[{id:803,slug:'footer-newsletter',title:'Legacy archive footer',type:'template-part',theme:'twentytwentyfive',content:'<p>Legacy</p>'}]})).data;
      docs.push(...legacy.documentIds);assert.equal((await pool.query('SELECT area FROM site_documents WHERE id=$1',[legacy.documentIds[0]])).rows[0].area,'footer');
      const count=(await pool.query('SELECT count(*)::int AS n FROM site_documents')).rows[0].n;
      const failed=await api('/api/tools/import','POST',{...payload,documents:[{...overlay,slug:stamp+'-bad1'},{...nav,slug:stamp+'-bad2',area:'unsafe'}]},cookie);assert.equal(failed.response.status,400);assert.equal((await pool.query('SELECT count(*)::int AS n FROM site_documents')).rows[0].n,count);
    });
    await t.test('renaming or changing a source document type detaches its old theme-file provenance',async()=>{
      const source=(await request('/wp-json/wp/v2/template-parts/twentytwentyfive//header-large-title')).data;
      docs.push(source.wp_id);
      const changed=(await request('/api/site-editor/documents/'+source.wp_id,'PUT',{slug:stamp+'-renamed-source',title:'Renamed source',type:'template-part',content:source.content.raw,version:source.version})).data.document;
      assert.equal(changed.sourceHash,null);assert.deepEqual(changed.sourceMetadata,{});assert.equal(changed.area,'header');
      const native=(await request('/wp-json/wp/v2/template-parts/twentytwentyfive//'+changed.slug)).data;
      assert.equal(native.has_theme_file,false);assert.equal(native.is_custom,true);
      assert.equal((await api('/api/site-editor/documents/'+source.wp_id+'/reset','POST',{},cookie)).response.status,404);
      await migrate();assert.equal((await request('/wp-json/wp/v2/template-parts/twentytwentyfive//header-large-title')).data.area,'header');
      const converted=(await request('/api/site-editor/documents/'+source.wp_id,'PUT',{slug:changed.slug,title:changed.title,type:'pattern',content:changed.rawContent,area:'header',version:changed.version})).data.document;
      assert.equal(converted.area,'uncategorized');assert.equal(converted.sourceHash,null);
    });
    await t.test('native deletion removes custom parts and clearing source customizations restores its file area',async()=>{
      const custom=(await request('/wp-json/wp/v2/template-parts','POST',{slug:stamp+'-delete',title:'Delete me',area:'navigation-overlay'})).data;docs.push(custom.wp_id);
      assert.equal((await api('/wp-json/wp/v2/template-parts/'+custom.id,'DELETE',undefined,cookie)).response.status,501);
      assert.equal((await api('/wp-json/wp/v2/template-parts/'+custom.id+'?force=true&version='+(custom.version+1),'DELETE',undefined,cookie)).response.status,409);
      const deleted=(await request('/wp-json/wp/v2/template-parts/'+custom.id+'?force=true','DELETE')).data;assert.equal(deleted.deleted,true);assert.equal(deleted.previous.area,'navigation-overlay');
      assert.equal((await api('/wp-json/wp/v2/template-parts/'+custom.id,'GET',undefined,cookie)).response.status,404);
      const source=(await request('/wp-json/wp/v2/template-parts/twentytwentyfive//footer-columns')).data;
      assert.equal((await api('/wp-json/wp/v2/template-parts/'+source.id+'?force=true','DELETE',undefined,cookie)).response.status,400);
      const titled=(await request('/wp-json/wp/v2/template-parts/'+source.id,'POST',{title:'Custom footer title'})).data;
      assert.equal(titled.is_custom,true);assert.equal(titled.source,'custom');
      await pool.query('UPDATE site_documents SET source_hash=$1 WHERE id=$2',['0'.repeat(64),source.wp_id]);
      await migrate();assert.equal((await request('/wp-json/wp/v2/template-parts/'+source.id)).data.title.raw,'Custom footer title');
      await request('/wp-json/wp/v2/template-parts/'+source.id+'?force=true','DELETE');
      const titleReset=(await request('/wp-json/wp/v2/template-parts/'+source.id)).data;assert.equal(titleReset.title.raw,source.title.raw);assert.equal(titleReset.is_custom,false);
      await request('/wp-json/wp/v2/template-parts/'+source.id,'POST',{area:'navigation-overlay'});
      const cleared=(await request('/wp-json/wp/v2/template-parts/'+source.id+'?force=true','DELETE')).data;assert.equal(cleared.previous.is_custom,true);
      const restored=(await request('/wp-json/wp/v2/template-parts/'+source.id)).data;assert.equal(restored.area,'footer');assert.equal(restored.source,'theme');assert.equal(restored.is_custom,false);
    });
    await t.test('area writes and private entity reads stay administrator only',async()=>{
      const user=(await request('/api/users','POST',{username:stamp+'-editor',email:stamp+'@example.test',displayName:'Area editor',password:'Area-editor-pass-'+stamp,role:'editor'})).data.user;users.push(user.id);
      const login=await api('/api/auth/login','POST',{login:stamp+'-editor',password:'Area-editor-pass-'+stamp});const editor=login.response.headers.get('set-cookie')!.split(';')[0];
      assert.equal((await api('/wp-json/wp/v2/template-parts','GET',undefined,editor)).response.status,403);
      assert.equal((await api('/api/site-editor/documents','POST',{slug:stamp+'-forbidden',title:stamp,type:'template-part',area:'header'},editor)).response.status,403);
      assert.equal((await api('/wp-json/wp/v2/template-parts')).response.status,401);
    });
  }finally{await pool.query('DELETE FROM site_documents WHERE id=ANY($1::int[])',[docs]);await pool.query('DELETE FROM users WHERE id=ANY($1::int[])',[users]);await api('/api/auth/logout','POST',undefined,cookie);}
});
