import test,{after} from "./isolated-test.js";
import assert from "node:assert/strict";
import {DOMParser} from "linkedom";
import {pool} from "../server/db.js";
import {approvalFixture,base,origin} from "./comment-approval-fixtures.js";
after(()=>pool.end());
const parse=(html:string)=>new DOMParser().parseFromString(html,"text/html");
const model=(html:string)=>JSON.parse(parse(html).querySelector("#worldact-public-document")!.textContent!);
async function html(route:string,cookie=""){const response=await fetch(base+route,{headers:{Cookie:cookie}});return {response,html:await response.text()};}
function fields(form:Element){const values=new URLSearchParams();for(const node of form.querySelectorAll('input[type="hidden"]'))values.append(node.getAttribute("name")!,node.getAttribute("value")||"");return values;}
async function native(action:string,body:URLSearchParams,cookie="",referer?:string){const response=await fetch(base+action,{method:"POST",redirect:"manual",headers:{Origin:origin,Cookie:cookie,...(referer?{Referer:referer}:{})},body});const text=await response.text();return{response,text,location:response.headers.get("location")};}
async function fixture(label:string,threadComments=true,theme="twentytwentyfive",structure="",type="post",front=false){
 const f=await approvalFixture(label);await f.ok("/api/settings","PUT",{theme,frontPageMode:"posts",frontPageId:null,postsPageId:null,permalinkStructure:structure,threadComments,threadDepth:5,paginateComments:true,commentsPerPage:2,commentOrder:"desc",defaultCommentPage:"oldest",notifyComments:false,notifyModeration:false,showAvatars:false});
 const post=(await f.ok("/api/posts","POST",{title:f.stamp+" selected",type,status:"publish",commentStatus:"open",content:"<p>NATIVE-FIRST-"+f.stamp+"</p><!--nextpage--><p>NATIVE-SECOND-"+f.stamp+"</p>"})).post;const dispose=f.dispose;f.dispose=async()=>{await pool.query("DELETE FROM posts WHERE id=$1",[post.id]);await dispose();};
 const ids:number[]=[];for(let n=1;n<=4;n++)ids.push((await pool.query("INSERT INTO comments(post_id,author_name,author_email,content,status,created_at) VALUES($1,$2,$3,$4,'approved',$5) RETURNING id",[post.id,"Root "+n,"PRIVATE-ROOT@example.test","<p>ROOT-"+n+"</p>",`2025-01-0${n}T12:00:00Z`])).rows[0].id);
 let parent=ids[2];for(let n=5;n<=6;n++)parent=(await pool.query("INSERT INTO comments(post_id,parent_id,author_name,author_email,content,status,created_at) VALUES($1,$2,$3,$4,$5,'approved',$6) RETURNING id",[post.id,parent,"Deep "+n,"PRIVATE-DEEP@example.test","<p>DEEP-"+n+"</p>",`2025-01-0${n}T12:00:00Z`])).rows[0].id;
 if(front)await f.ok("/api/settings","PUT",{frontPageMode:"page",frontPageId:post.id});
 const route=front?"/?page=2&query-4-page=2&commentPage=2&replytocom="+parent:structure?post.permalink.replace(/\/$/,"")+"/2/?query-4-page=2&commentPage=2&replytocom="+parent:"/?"+(type==="page"?"page_id":"p")+"="+post.id+"&page=2&query-4-page=2&commentPage=2&replytocom="+parent;
 return{f,post,ids,parent,route};
}
async function saved(postId:number,token:string){const rows=(await pool.query("SELECT id,parent_id,status FROM comments WHERE post_id=$1 AND content LIKE $2",[postId,"%"+token+"%"])).rows;assert.equal(rows.length,1);return rows[0];}
function checkCounters(location:string,page:number=2){const u=new URL(location,origin);assert.equal(u.searchParams.get("page"),String(page));assert.equal(u.searchParams.get("query-4-page"),"2");return u;}

test("native approved deep reply retains independent body/block state and the actual chronological root page",async()=>{
 const {f,post,parent,route}=await fixture("independent-native-reply");try{
  const source=await html(route,f.admin);assert.equal(source.response.status,200);const before=model(source.html);assert.equal(before.controls.replyParentId,parent);assert.equal(before.route.query.contentPage,2);
  const form=parse(source.html).querySelector('form[action="/wp-comments-post.php"]')!;assert.ok(form);const body=fields(form),token=f.stamp+"-SAVED-CHILD";body.set("content",token);body.set("authorName","Independent native");body.set("authorEmail","PRIVATE-SUBMIT@example.test");
  const result=await native("/wp-comments-post.php",body,f.admin,origin+route);assert.equal(result.response.status,303,result.text);const row=await saved(post.id,token);assert.equal(row.parent_id,parent);assert.equal(row.status,"approved");
  const u=checkCounters(result.location!);assert.equal(u.searchParams.get("commentPage"),"2");assert.equal(u.searchParams.get("replytocom"),null);assert.equal(u.hash,"#comment-"+row.id);
  const fresh=await html(result.location!,f.admin),next=model(fresh.html);assert.equal(fresh.response.status,200);assert.equal(next.post.id,post.id);assert.equal(next.route.query.contentPage,2);assert.equal(next.route.query.blockPages["query-4-page"],2);assert.ok(next.comments.some((c:any)=>c.id===row.id));assert.match(parse(fresh.html).querySelector("#root")!.textContent!,new RegExp(token));assert.doesNotMatch(fresh.html,/NATIVE-FIRST-|PRIVATE-(?:ROOT|DEEP|SUBMIT)@/);assert.ok(form.querySelector('input[name="redirect_to"]'),"the actual generated native form carries its return context");
 }finally{await f.dispose();}
});

for(const threaded of [true,false])test("new native root selects chronological "+(threaded?"thread-root":"flat-record")+" page independently of descending display",async()=>{
 const {f,post,route}=await fixture("independent-native-new-"+threaded,threaded);try{
  const sourceRoute=route.replace(/commentPage=2/,"commentPage=1").replace(/&replytocom=\d+/,""),source=await html(sourceRoute,f.admin),form=parse(source.html).querySelector('form[action="/wp-comments-post.php"]')!;const body=fields(form),token=f.stamp+"-NEW-ROOT";body.set("content",token);body.set("parentId","0");body.set("comment_parent","0");body.set("authorName","Independent root");body.set("authorEmail","PRIVATE-NEW@example.test");
  const result=await native("/wp-comments-post.php",body,f.admin,origin+sourceRoute);assert.equal(result.response.status,303,result.text);const row=await saved(post.id,token);assert.equal(row.parent_id,null);const u=checkCounters(result.location!);assert.equal(u.searchParams.get("commentPage"),threaded?"3":"4");assert.equal(u.hash,"#comment-"+row.id);
  const fresh=await html(result.location!,f.admin),next=model(fresh.html);assert.ok(next.comments.some((c:any)=>c.id===row.id));assert.equal(next.route.query.contentPage,2);assert.equal(next.route.query.blockPages["query-4-page"],2);
 }finally{await f.dispose();}
});

test("pending native reply keeps valid context and a notice without exposing the unapproved body",async()=>{
 const {f,post,parent,route}=await fixture("independent-native-pending");try{
  await f.ok("/api/settings","PUT",{commentModeration:true});const source=await html(route),form=parse(source.html).querySelector('form[action="/wp-comments-post.php"]')!,body=fields(form),token=f.stamp+"-PRIVATE-PENDING";body.set("content",token);body.set("authorName","Pending native");body.set("authorEmail",f.stamp+"-pending@example.test");
  const result=await native("/wp-comments-post.php",body,"",origin+route);assert.equal(result.response.status,303,result.text);const row=await saved(post.id,token);assert.equal(row.parent_id,parent);assert.equal(row.status,"pending");const u=checkCounters(result.location!);assert.equal(u.searchParams.get("commentPage"),"2");assert.equal(u.searchParams.get("comment-status"),"pending");assert.equal(u.hash,"#respond");assert.equal(u.searchParams.get("replytocom"),null);
  const fresh=await html(result.location!);assert.equal(fresh.response.status,200);assert.equal(model(fresh.html).route.query.contentPage,2);assert.doesNotMatch(fresh.html,new RegExp(token));assert.match(parse(fresh.html).querySelector("#root")!.textContent!,/awaiting moderation|pending|submitted/i);
 }finally{await f.dispose();}
});

for(const [theme,structure,type,front] of [["twentytwentyfive","","post",false],["classic","","post",false],["twentytwentyfive","/native/%post_id%/","post",false],["classic","","page",true]] as const)test("native password returns to selected second body with independent counters and eligible reply: "+theme+structure+(front?" static-front":""),async()=>{
 const {f,post,parent,route}=await fixture("independent-native-password",true,theme,structure,type,front);try{
  const password="PRIVATE-PASSWORD-"+f.stamp;await f.ok("/api/posts/"+post.id,"PUT",{password});const source=await html(route);assert.equal(source.response.status,200);assert.equal(model(source.html).post.locked,true);assert.doesNotMatch(source.html,/NATIVE-SECOND-|PRIVATE-PASSWORD-/);const form=parse(source.html).querySelector('form[action="/post-password"]')!;assert.ok(form);const body=fields(form);body.set("password",password);
  const result=await native("/post-password",body,"",origin+route);assert.equal(result.response.status,303,result.text);const u=new URL(result.location!,origin);assert.equal(u.searchParams.get("query-4-page"),"2");assert.equal(u.searchParams.get("commentPage"),"2");assert.equal(u.searchParams.get("replytocom"),String(parent));assert.equal(u.hash,"");assert.doesNotMatch(result.location!,/password|email|PRIVATE-/);
  const grant=result.response.headers.get("set-cookie")!.split(";")[0],fresh=await html(result.location!,grant),next=model(fresh.html);assert.equal(fresh.response.status,200);assert.equal(next.post.id,post.id);assert.equal(next.post.locked,false);assert.equal(next.route.query.contentPage,2);assert.equal(next.route.query.blockPages["query-4-page"],2);assert.equal(next.controls.replyParentId,parent);assert.match(parse(fresh.html).querySelector("#root")!.textContent!,/NATIVE-SECOND-/);assert.doesNotMatch(fresh.html,/NATIVE-FIRST-|PRIVATE-(?:ROOT|DEEP)@|PRIVATE-PASSWORD-/);assert.ok(form.querySelector('input[name="redirect_to"]'));
 }finally{await f.dispose();}
});

test("comment redirect controls bind to the current published identity and explicitly invalid fields never use Referer",async t=>{
 const {f,post,parent,route}=await fixture("independent-native-targets");try{
  const other=await f.post(),valid=route,canonical="/?p="+post.id;
  const cases:[string,string[][],boolean][]=[
   ["relative",[["redirect_to",valid]],true],["same-origin absolute",[["redirect_to",origin+valid]],true],["legacy absent",[],true],
   ["foreign",[["redirect_to","https://evil.invalid"+valid]],false],["protocol relative",[["redirect_to","//evil.invalid"+valid]],false],["cross post",[["redirect_to","/?p="+other.id+"&page=2"]],false],
   ["duplicate identity",[["redirect_to",canonical+"&p="+other.id+"&page=2"]],false],["nested identity",[["redirect_to","/?p%5B%5D="+post.id+"&page=2"]],false],["duplicate counter",[["redirect_to",valid+"&page=1"]],false],["nested counter",[["redirect_to",canonical+"&page%5B%5D=2"]],false],
   ["encoded login",[["redirect_to","/%6cogin?page=2"]],false],["duplicate field",[["redirect_to",valid],["redirect_to",valid]],false],["nested field",[["redirect_to[path]",valid]],false],["empty field",[["redirect_to",""]],false],["overlong",[["redirect_to","/"+"x".repeat(2001)]],false]
  ];
  for(const [label,extras,keeps] of cases)await t.test(label,async()=>{
   const token=f.stamp+"-TARGET-"+label,body=new URLSearchParams({postId:String(post.id),parentId:String(parent),content:token});for(const [k,v]of extras)body.append(k,v);const r=await native("/wp-comments-post.php",body,f.admin,origin+valid);assert.equal(r.response.status,303,r.text);const row=await saved(post.id,token),u=new URL(r.location!,origin);assert.equal(u.origin,new URL(origin).origin);assert.equal(u.pathname,"/");assert.equal(u.searchParams.get("p"),String(post.id));assert.equal(u.searchParams.get("page"),keeps?"2":null,label);assert.equal(u.searchParams.get("query-4-page"),keeps?"2":null,label);assert.equal(u.searchParams.get("replytocom"),null);assert.equal(u.searchParams.get("commentPage"),"2");assert.equal(u.hash,"#comment-"+row.id);assert.doesNotMatch(r.location!,/evil|login|redirect_to|PRIVATE-|@/);
  });
  await t.test("private renderer keys and credentials are not copied",async()=>{
   const token=f.stamp+"-RENDERER-KEYS",body=new URLSearchParams({postId:String(post.id),parentId:String(parent),content:token,redirect_to:valid+"&postId="+other.id+"&postType=page&requestPath=%2Fadmin&email=PRIVATE-RETURN%40example.test&password=PRIVATE-RETURN#PRIVATE-HASH"});const r=await native("/wp-comments-post.php",body,f.admin,origin+valid);assert.equal(r.response.status,303,r.text);const row=await saved(post.id,token),u=new URL(r.location!,origin);assert.equal(u.searchParams.get("p"),String(post.id));for(const key of ["postId","postType","requestPath","email","password"])assert.equal(u.searchParams.get(key),null);assert.equal(u.hash,"#comment-"+row.id);assert.doesNotMatch(r.location!,/PRIVATE-|admin|example\.test/);
  });
 }finally{await f.dispose();}
});

test("password invalid target fields fall back after a valid unlock and cannot borrow a valid Referer",async t=>{
 const {f,post,route}=await fixture("independent-native-password-targets");try{
  const password="PRIVATE-PASSWORD-TARGET-"+f.stamp;await f.ok("/api/posts/"+post.id,"PUT",{password});
  for(const [label,extras] of [["foreign",[["redirect_to","https://evil.invalid"+route]]],["duplicate",[["redirect_to",route],["redirect_to",route]]],["nested",[["redirect_to[path]",route]]],["nested body",[["redirect_to","/?p="+post.id+"&page%5B%5D=2"]]],["encoded login",[["redirect_to","/%6cogin?page=2"]]],["empty",[["redirect_to",""]]]] as [string,string[][]][])await t.test(label,async()=>{
   const body=new URLSearchParams({postSlug:post.slug,password});for(const[k,v]of extras)body.append(k,v);const r=await native("/post-password",body,"",origin+route);assert.equal(r.response.status,303,r.text);const u=new URL(r.location!,origin);assert.equal(u.origin,new URL(origin).origin);assert.equal(u.pathname,"/");assert.equal(u.searchParams.get("p"),String(post.id));assert.equal(u.searchParams.get("page"),null);assert.equal(u.searchParams.get("query-4-page"),null);assert.equal(u.hash,"");assert.doesNotMatch(r.location!,/evil|login|PRIVATE-|password|email|@/);assert.ok(r.response.headers.get("set-cookie"));
  });
 }finally{await f.dispose();}
});
