import test, { before, after } from "./isolated-test.js";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { readFile, writeFile, readdir } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { parseHTML } from "linkedom";
import { XMLParser } from "fast-xml-parser";
import { pool, rootDir, uploadsDir } from "../server/db.js";
import { MAX_MEDIA_CAPTION_LENGTH } from "../server/media-captions.js";

const base=process.env.TEST_API_URL!,origin=process.env.APP_ORIGIN!,stamp="caption-"+randomBytes(5).toString("hex");
let cookie="";const media=new Set<number>(),posts=new Set<number>();
const document=(html:string)=>parseHTML(`<html><body><div id="caption">${html}</div></body></html>`).document;
const visible=(html:string)=>document(html).getElementById("caption")!.textContent;
const sha=(bytes:Buffer)=>createHash("sha256").update(bytes).digest("hex");
const inventory=async()=>(await readdir(uploadsDir,{recursive:true,withFileTypes:true})).filter(entry=>entry.isFile()).map(entry=>path.relative(uploadsDir,path.join(entry.parentPath,entry.name))).sort();
async function api(route:string,method="GET",body?:unknown,auth=cookie){const response=await fetch(base+route,{method,signal:AbortSignal.timeout(15_000),headers:{Origin:origin,"Content-Type":"application/json",...(auth?{Cookie:auth}:{})},...(body===undefined?{}:{body:JSON.stringify(body)})});return{response,data:await response.json()};}
async function ok(route:string,method="GET",body?:unknown,auth=cookie){const result=await api(route,method,body,auth);assert.ok(result.response.ok,`${route}: ${result.response.status} ${JSON.stringify(result.data)}`);return result.data;}
async function upload(){const bytes=await sharp({create:{width:24,height:12,channels:3,background:"#2685a4"}}).png().toBuffer(),form=new FormData();form.append("file",new Blob([new Uint8Array(bytes)],{type:"image/png"}),stamp+".png");const response=await fetch(base+"/api/media",{method:"POST",headers:{Origin:origin,Cookie:cookie},body:form});const data=await response.json();assert.equal(response.status,201,JSON.stringify(data));media.add(data.media.id);return{item:data.media,bytes};}
async function bytesAt(url:string){const response=await fetch(new URL(url,base));assert.equal(response.status,200);return Buffer.from(await response.arrayBuffer());}
function safe(html:string){const root=document(html).getElementById("caption")!;assert.equal(root.querySelectorAll("script,svg,iframe,object,embed").length,0);for(const node of root.querySelectorAll("*"))for(const attr of node.attributes){assert.ok(!/^on/i.test(attr.name),attr.name);if(["src","href"].includes(attr.name))assert.ok(!/^\s*(?:javascript|vbscript|data):/i.test(attr.value),attr.value);}return root;}
async function exportedRecord(id:number){const archive=await ok("/api/tools/export"),record=archive.media.find((item:any)=>item.id===id);assert.ok(record);const names=new Set([record.filename,record.original_filename,...Object.values(record.derivatives||{}),...Object.values(record.sizes||{}).map((size:any)=>size.filename)].filter(Boolean));return{record,files:archive.mediaFiles.filter((file:any)=>names.has(file.filename))};}
async function copyArchive(record:any,files:any[]){const result=await api("/api/tools/import","POST",{application:"WorldAct",version:3,posts:[],media:[record],mediaFiles:files});assert.equal(result.response.status,201,JSON.stringify(result.data));result.data.mediaIds.forEach((id:number)=>media.add(id));return(await ok("/api/media/"+result.data.mediaIds[0])).media;}
async function gallery(id:number){const post=(await ok("/api/posts","POST",{title:stamp+" gallery",status:"publish",content:`[gallery ids="${id}" link="none"]`})).post;posts.add(post.id);const publicPost=(await ok("/api/public/posts/"+post.slug,"GET",undefined,"")).post;const caption=document(publicPost.content).querySelector(".gallery-caption");assert.ok(caption);return caption;}
before(async()=>{const login=await api("/api/auth/login","POST",{login:process.env.ADMIN_EMAIL,password:process.env.ADMIN_PASSWORD},"");assert.equal(login.response.status,200);cookie=login.response.headers.get("set-cookie")!.split(";")[0];});
after(async()=>{for(const id of posts){await api("/api/posts/"+id,"PUT",{status:"trash"});await api("/api/posts/"+id,"DELETE");}for(const id of media)await api("/api/media/"+id,"DELETE");if(cookie)await api("/api/auth/logout","POST",{});await pool.end();});

test("native metadata and edit-copy retain safe rich/literal HTML captions while source bytes and text fields stay intact",async()=>{
  const source=await upload(),before=sha(source.bytes);
  const caption='Literal <b>caption</b> <em>emphasis</em> <a href="/safe" onclick="bad()">link</a> & symbols. &lt;b&gt;literal&lt;/b&gt; 2 < 3 > 1<script>bad()</script><svg onload="bad()"><script>bad()</script></svg><img src="javascript:bad()" onerror="bad()">';
  const saved=await ok(`/wp-json/wp/v2/media/${source.item.id}`,"POST",{id:source.item.id,caption,title:"Image <b>title</b>",alt_text:"Alternative <i>text</i>",description:"<p>Image description</p>"});
  assert.equal(saved.title.raw,"Image title");assert.equal(saved.alt_text,"Alternative text");
  assert.match(saved.caption.raw,/<b>caption<\/b>/);assert.match(saved.caption.raw,/<em>emphasis<\/em>/);assert.match(saved.caption.raw,/&lt;b&gt;literal&lt;\/b&gt;/);assert.match(saved.caption.raw,/2 &lt; 3 &gt; 1/);
  const raw=safe(saved.caption.raw),rendered=safe(saved.caption.rendered);assert.equal(raw.querySelectorAll("b").length,1);assert.equal(raw.querySelector("em")!.textContent,"emphasis");assert.equal(raw.querySelector("a")!.getAttribute("href"),"/safe");assert.match(raw.textContent!,/<b>literal<\/b>/);assert.match(raw.textContent!,/2 < 3 > 1/);assert.ok(rendered.querySelector("p b"));
  const ordinary=(await ok("/api/media/"+source.item.id)).media;assert.equal(ordinary.caption,saved.caption.raw);assert.equal((await pool.query("SELECT caption_is_html FROM media WHERE id=$1",[ordinary.id])).rows[0].caption_is_html,true);
  const originalCaption=saved.caption.raw;
  const inherited=await ok(`/wp-json/wp/v2/media/${ordinary.id}/edit`,"POST",{src:saved.source_url,modifiers:[{type:"rotate",args:{angle:90}}]});media.add(inherited.id);assert.notEqual(inherited.id,ordinary.id);assert.equal(inherited.caption.raw,originalCaption);assert.ok(safe(inherited.caption.rendered).querySelector("p b"));
  const explicit=await ok(`/wp-json/wp/v2/media/${ordinary.id}/edit`,"POST",{src:saved.source_url,modifiers:[{type:"rotate",args:{angle:90}}],caption:"<strong>Copy</strong> &lt;script&gt;literal&lt;/script&gt;"});media.add(explicit.id);assert.equal(explicit.caption.raw,"<strong>Copy</strong> &lt;script&gt;literal&lt;/script&gt;");assert.equal(safe(explicit.caption.rendered).querySelector("p strong")!.textContent,"Copy");assert.match(visible(explicit.caption.raw)!,/<script>literal<\/script>/);
  assert.equal((await ok(`/wp-json/wp/v2/media/${ordinary.id}?context=edit`)).caption.raw,originalCaption);assert.equal(sha(await bytesAt(ordinary.url)),before);
  const publicCaption=await gallery(ordinary.id);assert.equal(publicCaption.querySelector("b")!.textContent,"caption");assert.equal(publicCaption.querySelectorAll("script,[onclick],[onerror]").length,0);assert.match(publicCaption.textContent!,/<b>literal<\/b>/);
  const viaOrdinary=(await ok(`/api/media/${ordinary.id}`,"PUT",{caption:"<em>Ordinary</em> & &lt;i&gt;literal&lt;/i&gt;"})).media;assert.equal(viaOrdinary.caption,"<em>Ordinary</em> &amp; &lt;i&gt;literal&lt;/i&gt;");
  const unchanged=viaOrdinary.caption;
  for(const value of ["&".repeat(MAX_MEDIA_CAPTION_LENGTH),"x".repeat(MAX_MEDIA_CAPTION_LENGTH+1),null,false])assert.equal((await api(`/wp-json/wp/v2/media/${ordinary.id}`,"POST",{id:ordinary.id,caption:value})).response.status,400);
  assert.equal((await ok(`/api/media/${ordinary.id}`)).media.caption,unchanged);
  const filesBefore=await inventory(),countBefore=(await pool.query("SELECT count(*)::int AS n FROM media")).rows[0].n;
  const rejectedCopy=await api(`/wp-json/wp/v2/media/${ordinary.id}/edit`,"POST",{src:saved.source_url,modifiers:[{type:"rotate",args:{angle:90}}],caption:"&".repeat(MAX_MEDIA_CAPTION_LENGTH)});assert.equal(rejectedCopy.response.status,400);assert.equal((await pool.query("SELECT count(*)::int AS n FROM media")).rows[0].n,countBefore);assert.deepEqual(await inventory(),filesBefore);
});

test("caption migration escapes actual legacy rows once without changing literal text, files or identity",async()=>{
  const first=await upload(),second=await upload(),schema=await readFile(path.join(rootDir,"server/media-captions-schema.sql"),"utf8");
  const fixtures=[{id:first.item.id,text:'Tag <b>literal</b> <img src=x onerror="bad()"> &amp; & "quotes"\nnext line'},{id:second.item.id,text:"&".repeat(20_000)}];
  const snapshots=(await pool.query("SELECT * FROM media WHERE id=ANY($1::int[]) ORDER BY id",[fixtures.map(item=>item.id)])).rows;
  const db=await pool.connect();
  try{await db.query("BEGIN");for(const fixture of fixtures)await db.query("UPDATE media SET caption=$1,caption_is_html=false WHERE id=$2",[fixture.text,fixture.id]);
    await db.query(schema);const once=(await db.query("SELECT * FROM media WHERE id=ANY($1::int[]) ORDER BY id",[fixtures.map(item=>item.id)])).rows;
    once.forEach((row,index)=>{assert.equal(row.caption_is_html,true);assert.equal(visible(row.caption),fixtures[index].text);assert.equal(document(row.caption).querySelectorAll("b,img").length,0);const {caption:_caption,caption_is_html:_marker,...same}=row;const {caption:_old,caption_is_html:_oldMarker,...original}=snapshots[index];assert.deepEqual(same,original);});
    assert.equal(once[1].caption.length,100_000);await db.query(schema);assert.deepEqual((await db.query("SELECT * FROM media WHERE id=ANY($1::int[]) ORDER BY id",[fixtures.map(item=>item.id)])).rows,once);
  }finally{await db.query("ROLLBACK");db.release();}
  assert.deepEqual(await bytesAt(first.item.url),first.bytes);assert.deepEqual(await bytesAt(second.item.url),second.bytes);
  const third=await upload();assert.equal((await pool.query("SELECT caption_is_html FROM media WHERE id=$1",[third.item.id])).rows[0].caption_is_html,true);
});

test("old/new JSON caption markers preserve literals and sanitize HTML, including long legacy values and rollback",async()=>{
  const source=await upload(),fixture=await exportedRecord(source.item.id),old={...fixture.record,caption:'Old <b>literal</b> &amp; & "quotes"\nnext line'};delete old.caption_is_html;
  const literal=await copyArchive(old,fixture.files);assert.notEqual(literal.id,source.item.id);assert.equal(visible(literal.caption),old.caption);assert.equal(document(literal.caption).querySelectorAll("b").length,0);assert.equal((await pool.query("SELECT caption_is_html FROM media WHERE id=$1",[literal.id])).rows[0].caption_is_html,true);assert.deepEqual(await bytesAt(literal.url),source.bytes);
  const falseMarker=await copyArchive({...old,caption_is_html:false},fixture.files);assert.equal(falseMarker.caption,literal.caption);
  const rich=await copyArchive({...fixture.record,caption_is_html:true,caption:'<b>Imported</b> &lt;b&gt;literal&lt;/b&gt;<script>bad()</script><a href="javascript:bad()" onclick="bad()">safe</a>'},fixture.files);
  const richDOM=safe(rich.caption);assert.equal(richDOM.querySelector("b")!.textContent,"Imported");assert.match(richDOM.textContent!,/<b>literal<\/b>/);assert.equal(richDOM.querySelector("a")!.hasAttribute("href"),false);
  const long=await copyArchive({...old,caption:"&".repeat(20_000)},fixture.files);assert.equal(long.caption.length,100_000);assert.equal(visible(long.caption),"&".repeat(20_000));
  const saved=await ok(`/wp-json/wp/v2/media/${long.id}`,"POST",{id:long.id,caption:long.caption});assert.equal(saved.caption.raw,long.caption);assert.equal(visible(saved.caption.rendered),"&".repeat(20_000)+"\n");
  const longArchive=await exportedRecord(long.id);assert.equal(longArchive.record.caption_is_html,true);const restored=await copyArchive(longArchive.record,longArchive.files);assert.equal(restored.caption,long.caption);
  const richCaption=await gallery(rich.id);assert.equal(richCaption.querySelector("b")!.textContent,"Imported");assert.equal(richCaption.querySelectorAll("script,[onclick]").length,0);
  const beforeFiles=await inventory(),beforeCount=(await pool.query("SELECT count(*)::int AS n FROM media")).rows[0].n;
  for(const marker of [1,"true",null,{}]){
    const result=await api("/api/tools/import","POST",{application:"WorldAct",version:3,posts:[],media:[{...fixture.record,id:2147483001},{...fixture.record,id:2147483002,caption_is_html:marker}],mediaFiles:fixture.files});assert.equal(result.response.status,400);assert.equal((await pool.query("SELECT count(*)::int AS n FROM media")).rows[0].n,beforeCount);assert.deepEqual(await inventory(),beforeFiles);
  }
});

test("WXR puts canonical media caption in source excerpt and description in content without downloading attachments",async()=>{
  const source=await upload(),caption='<b>WXR caption</b> &lt;em&gt;literal&lt;/em&gt;',description="<p>Distinct image description</p>";
  const saved=await ok(`/wp-json/wp/v2/media/${source.item.id}`,"POST",{id:source.item.id,caption,description});
  const response=await fetch(base+"/api/tools/export?format=wxr&content=attachment",{headers:{Cookie:cookie,Origin:origin}});assert.equal(response.status,200);const xml=await response.text();
  const channel=new XMLParser({ignoreAttributes:false,parseTagValue:false,trimValues:false}).parse(xml).rss.channel;const entries=Array.isArray(channel.item)?channel.item:[channel.item];const item=entries.find((item:any)=>item["wp:post_id"]===String(source.item.id+2147483648));assert.ok(item);assert.equal(item["excerpt:encoded"],saved.caption.raw);assert.equal(item["content:encoded"],description);assert.notEqual(item["content:encoded"],item["excerpt:encoded"]);
  const before=(await pool.query("SELECT count(*)::int AS n FROM media")).rows[0].n;const imported=await ok("/api/tools/import","POST",{format:"wxr",xml});assert.equal(imported.skippedAttachments,entries.length);assert.equal((await pool.query("SELECT count(*)::int AS n FROM media")).rows[0].n,before);
});

test("caption formats and literal/rich HTML cross fresh databases after source files are removed",{skip:!process.env.CAPTION_ARCHIVE_STAGE||!process.env.CAPTION_ARCHIVE_PATH},async()=>{
  const file=process.env.CAPTION_ARCHIVE_PATH!;
  if(process.env.CAPTION_ARCHIVE_STAGE==="export"){
    const records=[];for(const caption of ['<b>Portable rich</b> &lt;b&gt;literal&lt;/b&gt; & symbols',"&".repeat(20_000)]){const source=await upload();await ok(`/api/media/${source.item.id}`,"PUT",{caption});records.push({source:source.item,...await exportedRecord(source.item.id),hash:sha(source.bytes)});}
    const payload={application:"WorldAct",version:3,posts:[],media:records.map(entry=>entry.record),mediaFiles:records.flatMap(entry=>entry.files)};await writeFile(file,JSON.stringify({payload,hashes:records.map(entry=>entry.hash),captions:records.map(entry=>entry.record.caption)}),{mode:0o600});
    for(const entry of records){await ok(`/api/media/${entry.source.id}`,"DELETE");media.delete(entry.source.id);assert.equal((await fetch(base+entry.source.url)).status,404);}
  }else{
    const occupied=await upload(),fixture=JSON.parse(await readFile(file,"utf8"));assert.equal(occupied.item.id,fixture.payload.media[0].id,"Destination already occupies the first source attachment ID");const result=await ok("/api/tools/import","POST",fixture.payload);result.mediaIds.forEach((id:number)=>media.add(id));assert.equal(result.mediaIds.length,2);
    for(const [index,id]of result.mediaIds.entries()){assert.notEqual(id,fixture.payload.media[index].id);const current=(await ok(`/api/media/${id}`)).media;assert.equal(current.caption,fixture.captions[index]);assert.equal((await pool.query("SELECT caption_is_html FROM media WHERE id=$1",[id])).rows[0].caption_is_html,true);assert.equal(sha(await bytesAt(current.url)),fixture.hashes[index]);const native=await ok(`/wp-json/wp/v2/media/${id}?context=edit`);assert.equal(native.caption.raw,current.caption);safe(native.caption.rendered);}
    const rich=await gallery(result.mediaIds[0]);assert.equal(rich.querySelector("b")!.textContent,"Portable rich");assert.match(rich.textContent!,/<b>literal<\/b>/);assert.equal(sha(await bytesAt(occupied.item.url)),sha(occupied.bytes));
  }
});
