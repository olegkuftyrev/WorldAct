import test,{after} from "./isolated-test.js";
import assert from"node:assert/strict";
import {pool,getSettings}from"../server/db.js";
import {applyOrdinaryListingPage}from"../server/public-listing-page.js";
const base=process.env.TEST_API_URL!,origin=process.env.APP_ORIGIN!;after(()=>pool.end());
test("ordinary direct site and supplied helper clients retain path, body and transaction boundaries",{timeout:90000},async t=>{
 const initial=(await pool.query("SELECT data FROM settings WHERE id=1")).rows[0].data,people:number[]=[],posts:number[]=[],terms:number[]=[];let cookie="";const stamp="ordinary-after-"+Date.now(),needle=stamp+"-excerpt";
 async function api(path:string,method="GET",body?:unknown,auth=false){const response=await fetch(base+path,{method,headers:{Origin:origin,Cookie:auth?cookie:"","Content-Type":"application/json"},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(18000)}),text=await response.text();let data:any;try{data=JSON.parse(text);}catch{}return {status:response.status,text,data,cookie:response.headers.get("set-cookie")?.split(";")[0]};}
 async function ok(path:string,method="GET",body?:unknown){const r=await api(path,method,body,true);assert.ok(r.status>=200&&r.status<300,path+" "+r.status+" "+r.text);return r.data;}
 async function user(label:string){const slug=stamp+"-"+label,row=(await pool.query("INSERT INTO users(username,nicename,email,display_name,password_hash,role) VALUES($1,$1,$2,$1,'unusable','author') RETURNING id",[slug,slug+"@example.test"])).rows[0];people.push(row.id);return row.id;}
 async function post(authorId:number,title:string,body:Record<string,unknown>={}){const p=(await ok("/api/posts","POST",{authorId,title,status:"publish",postDate:"2001-02-03T04:05:06",content:"<p>ORDINARY-AFTER-PUBLIC</p>",...body})).post;posts.push(p.id);return p;}
 const site=(path:string,more:Record<string,string>={})=>api("/api/public/site?"+new URLSearchParams({requestPath:path,...more}));
 try{
  const login=await api("/api/auth/login","POST",{login:process.env.ADMIN_EMAIL,password:process.env.ADMIN_PASSWORD});assert.equal(login.status,200);cookie=login.cookie!;await ok("/api/settings","PUT",{frontPageMode:"posts",frontPageId:null,postsPageId:null,postsPerPage:1,permalinkStructure:"",pingServices:[]});
  const a=await user("a"),b=await user("b"),local=await user("local"),term=(await ok("/api/terms","POST",{taxonomy:"category",slug:stamp,name:stamp})).term;terms.push(term.id);
  const one=await post(a,"Ordinary full predicate one",{categoryIds:[term.id],excerpt:needle}),two=await post(a,"Ordinary full predicate two",{categoryIds:[term.id],excerpt:needle});await post(a,"Ordinary other date",{categoryIds:[term.id],excerpt:needle,postDate:"2002-02-03T04:05:06"});await post(b,"Ordinary other owner",{categoryIds:[term.id],excerpt:needle});
  const path="/2001/02/03/?"+new URLSearchParams({category:term.slug,author:String(a),search:needle,page:"2"});
  await t.test("actual direct site path-only values preserve complete excerpt/date/taxonomy/numeric intersection",async()=>{const valid=await site(path),missing=await site(path.replace("page=2","page=3"));assert.equal(valid.status,200);assert.equal(valid.data.archive.type,"date");assert.equal(valid.data.pagination.totalPosts,2);assert.equal(valid.data.posts.length,1);assert.ok([one.id,two.id].includes(valid.data.posts[0].id));assert.equal(missing.status,404);});
  await t.test("direct ordinary scalar transport cannot contradict or flatten the visible page",async()=>{
   const paths=["/api/public/site?"+new URLSearchParams({requestPath:path,page:"3"}),"/api/public/site?"+new URLSearchParams({requestPath:path})+"&page=2&page=3","/api/public/site?"+new URLSearchParams({requestPath:path})+"&page[]=2","/api/public/site?"+new URLSearchParams({requestPath:"/?page[]=2"})];
   for(const target of paths)assert.equal((await api(target)).status,400,target);
  });
  const front=await post(a,"Ordinary direct front",{type:"page",content:"<p>FRONT-ONE</p><!--nextpage--><p>FRONT-TWO</p>"}),listing=await post(a,"Ordinary direct listing",{type:"page"}),body=await post(a,"Ordinary direct body",{type:"page",content:"<p>BODY-ONE</p><!--nextpage--><p>BODY-TWO</p>"});
  await ok("/api/settings","PUT",{frontPageMode:"page",frontPageId:front.id,postsPageId:listing.id,postsPerPage:100});
  await t.test("direct site skips Plain/static-front body counters but counts the configured Plain posts-page",async()=>{
   const fixed=await site("/?page_id="+body.id+"&page=2",{page:"2"}),selectedFront=await site("/?page=2",{page:"2"}),missingListing=await site("/?page_id="+listing.id+"&page=2",{page:"2"});
   assert.equal(fixed.status,200);assert.equal(selectedFront.status,200);assert.equal(selectedFront.data.frontPage.id,front.id);assert.equal(missingListing.status,404);
  });
  await ok("/api/settings","PUT",{frontPageMode:"posts",frontPageId:null,postsPageId:null,postsPerPage:1});
  await t.test("supplied writable helper client counts its uncommitted rows instead of the global pool",async()=>{
   const db=await pool.connect();try{await db.query("BEGIN");for(const n of[1,2])await db.query("INSERT INTO posts(type,title,slug,content,status,author_id,post_date,post_date_gmt,published_at) VALUES('post',$1,$1,'local transaction','publish',$2,'2001-02-03T04:05:06','2001-02-03T04:05:06Z','2001-02-03T04:05:06Z')",[stamp+"-local-"+n,local]);const query=new URLSearchParams({author:String(local),page:"2"}),settings={...await getSettings(db),postsPerPage:1};assert.equal((await pool.query("SELECT count(*)::int AS n FROM posts WHERE author_id=$1",[local])).rows[0].n,0);assert.equal((await applyOrdinaryListingPage({status:200,kind:"archive"},query,settings,db)).status,200);assert.equal((await applyOrdinaryListingPage({status:200,kind:"archive"},query,settings,pool)).status,404);}finally{await db.query("ROLLBACK");db.release();}
  });
  const snapshotOne=await post(local,"Ordinary snapshot one"),snapshotTwo=await post(local,"Ordinary snapshot two");assert.ok(snapshotTwo.id);
  await t.test("supplied read-only repeatable helper snapshot keeps its historical valid page after outside privatization",async()=>{
   const db=await pool.connect();try{await db.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");const settings={...await getSettings(db),postsPerPage:1},query=new URLSearchParams({author:String(local),page:"2"});assert.equal((await applyOrdinaryListingPage({status:200,kind:"archive"},query,settings,db)).status,200);await pool.query("UPDATE posts SET status='private' WHERE id=$1",[snapshotOne.id]);assert.equal((await applyOrdinaryListingPage({status:200,kind:"archive"},query,settings,db)).status,200);assert.equal((await applyOrdinaryListingPage({status:200,kind:"archive"},query,settings,pool)).status,404);}finally{await db.query("ROLLBACK");db.release();}
  });
 }finally{if(posts.length)await pool.query("DELETE FROM posts WHERE id=ANY($1::int[])",[posts]);if(terms.length)await pool.query("DELETE FROM terms WHERE id=ANY($1::int[])",[terms]);if(people.length)await pool.query("DELETE FROM users WHERE id=ANY($1::int[])",[people]);await pool.query("UPDATE settings SET data=$1 WHERE id=1",[initial]);}
});
