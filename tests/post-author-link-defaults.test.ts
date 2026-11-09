import test,{after} from "./isolated-test.js";
import assert from "node:assert/strict";
import {DOMParser} from "linkedom";
import {pool} from "../server/db.js";
const base=process.env.TEST_API_URL!,origin=process.env.APP_ORIGIN!;
after(()=>pool.end());

test("serialized post-author applies the registered source link defaults without malformed truthiness",async t=>{
 const initial=(await pool.query("SELECT data FROM settings WHERE id=1")).rows[0].data,posts:number[]=[];let cookie="";
 async function api(path:string,method="GET",body?:unknown,auth=cookie){const response=await fetch(base+path,{method,headers:{Origin:origin,Cookie:auth,"Content-Type":"application/json"},body:body===undefined?undefined:JSON.stringify(body)}),data=await response.json();assert.ok(response.ok,`${path}: ${response.status} ${JSON.stringify(data)}`);return {response,data};}
 try{
  const signed=await api("/api/auth/login","POST",{login:process.env.ADMIN_EMAIL,password:process.env.ADMIN_PASSWORD});cookie=signed.response.headers.get("set-cookie")!.split(";")[0];
  await api("/api/settings","PUT",{permalinkStructure:"/journal/%postname%/",pingServices:[]});
  const nicename=(await pool.query("SELECT nicename FROM users WHERE id=$1",[signed.data.user.id])).rows[0].nicename,expected="/journal/author/"+nicename+"/";
  const cases:{label:string;attributes:Record<string,unknown>;target:string|null}[]=[
   {label:"omitted target uses registered _self",attributes:{isLink:true},target:"_self"},
   {label:"explicit self links",attributes:{isLink:true,linkTarget:"_self"},target:"_self"},
   {label:"explicit blank keeps safe rel",attributes:{isLink:true,linkTarget:"_blank"},target:"_blank"},
   {label:"explicit false stays unlinked",attributes:{isLink:false,linkTarget:"_blank"},target:null},
   {label:"omitted isLink defaults false",attributes:{linkTarget:"_self"},target:null},
   {label:"explicit empty target stays unlinked",attributes:{isLink:true,linkTarget:""},target:null},
   {label:"null target uses string schema default",attributes:{isLink:true,linkTarget:null},target:"_self"},
   {label:"numeric target uses string schema default",attributes:{isLink:true,linkTarget:7},target:"_self"},
   {label:"object target uses string schema default",attributes:{isLink:true,linkTarget:{unsafe:"_blank"}},target:"_self"},
   {label:"string false cannot enable isLink",attributes:{isLink:"false",linkTarget:"_blank"},target:null},
   {label:"object cannot enable isLink",attributes:{isLink:{enabled:true},linkTarget:"_blank"},target:null},
  ];
  for(const [index,entry] of cases.entries())await t.test(entry.label,async()=>{
   const created=(await api("/api/posts","POST",{title:"Post author defaults "+Date.now()+"-"+index,status:"publish",content:"<!-- wp:post-author "+JSON.stringify(entry.attributes)+" /-->"})).data.post;posts.push(created.id);
   const result=await api("/api/public/posts/"+created.slug,"GET",undefined,"");
   const document=new DOMParser().parseFromString(result.data.post.content,"text/html"),name=document.querySelector(".wp-block-post-author__name")!,link=name.querySelector("a");assert.ok(name);assert.equal(name.textContent,signed.data.user.displayName);
   if(entry.target===null)assert.equal(Boolean(link),false);
   else{assert.ok(link);assert.equal(link.getAttribute("href"),expected);assert.equal(link.getAttribute("target"),entry.target);if(entry.target==="_blank"){assert.match(link.getAttribute("rel") || "",/noopener/);assert.match(link.getAttribute("rel") || "",/noreferrer/);}}
  });
 }finally{if(posts.length)await pool.query("DELETE FROM posts WHERE id=ANY($1::int[])",[posts]);await pool.query("UPDATE settings SET data=$1 WHERE id=1",[initial]);}
});
