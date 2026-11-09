import test, { before, after } from "./isolated-test.js";
import assert from "node:assert/strict";
import { pool } from "../server/db.js";
import { fixtureUserNicename } from "./helpers/user-fixtures.js";
const base=process.env.TEST_API_URL!,origin=process.env.APP_ORIGIN!;
let adminCookie="",authorCookie="",authorId:number,publicId:number,privateId:number;
async function login(login:string){
  const response=await fetch(base+"/api/auth/login",{method:"POST",headers:{Origin:origin,"Content-Type":"application/json"},body:JSON.stringify({login,password:process.env.ADMIN_PASSWORD})});
  assert.equal(response.status,200);return response.headers.get("set-cookie")!.split(";")[0];
}
async function list(query:string,cookie=adminCookie){
  const response=await fetch(base+"/api/comments?"+query,{headers:{Cookie:cookie}});return {status:response.status,...await response.json()};
}
before(async()=>{
  adminCookie=await login(process.env.ADMIN_EMAIL!);
  const admin=(await pool.query("SELECT id,password_hash FROM users WHERE lower(email)=lower($1)",[process.env.ADMIN_EMAIL])).rows[0];
  const email="type-author-"+Date.now()+"@example.test";
  authorId=(await pool.query("INSERT INTO users(username,email,display_name,password_hash,role,nicename) VALUES($1,$1,'Type fixture author',$2,'author',$3) RETURNING id",[email,admin.password_hash,fixtureUserNicename(email)])).rows[0].id;
  authorCookie=await login(email);
  for(const status of ["publish","private"]){
    const post=(await pool.query("INSERT INTO posts(type,title,slug,status,author_id,post_date,post_date_gmt) VALUES('post',$1,$2,$3,$4,to_char(CASE WHEN coalesce((SELECT data->>'timezone' FROM settings WHERE id=1),'America/Los_Angeles')~'^[+-]' THEN timezone(coalesce((SELECT data->>'timezone' FROM settings WHERE id=1),'America/Los_Angeles')::interval,coalesce(CASE WHEN $3::varchar='future' THEN NULL::timestamptz END,NULL::timestamptz,NULL::timestamptz,now())) ELSE timezone(coalesce((SELECT data->>'timezone' FROM settings WHERE id=1),'America/Los_Angeles'),coalesce(CASE WHEN $3::varchar='future' THEN NULL::timestamptz END,NULL::timestamptz,NULL::timestamptz,now())) END,'YYYY-MM-DD\"T\"HH24:MI:SS'),coalesce(CASE WHEN $3::varchar='future' THEN NULL::timestamptz END,NULL::timestamptz,NULL::timestamptz,now())) RETURNING id",["Type fixture "+status,"type-fixture-"+status,status,admin.id])).rows[0].id;
    if(status==="publish")publicId=post;else privateId=post;
    for(const [index,type] of ["comment","pingback","trackback"].entries())await pool.query("INSERT INTO comments(post_id,type,author_name,author_email,author_url,content,status) VALUES($1,$2,$3,'private@example.test',$4,$5,$6)",[post,type,type+" fixture","https://"+type+".example.test/source/",index===1?"First ping marker":"Other fixture body",index===2?"pending":"approved"]);
  }
});
after(async()=>{try{await pool.query("DELETE FROM posts WHERE id=ANY($1::int[])",[[publicId,privateId]]);await pool.query("DELETE FROM users WHERE id=$1",[authorId]);}finally{await pool.end();}});

test("source Pings combines both notification types and retains type-scoped status counts/pagination",async()=>{
  const pings=await list(`postId=${publicId}&type=pings&perPage=1`);
  assert.equal(pings.status,200);assert.equal(pings.pagination.total,2);assert.equal(pings.pagination.totalPages,2);
  assert.deepEqual(pings.counts,{approved:1,pending:1,mine:0});assert.deepEqual(pings.typeCounts,{comment:1,pings:2});
  assert.ok(["pingback","trackback"].includes(pings.comments[0].type));
  const searched=await list(`postId=${publicId}&type=pings&search=First%20ping%20marker`);
  assert.equal(searched.pagination.total,1);assert.equal(searched.comments[0].type,"pingback");assert.deepEqual(searched.typeCounts,{comment:1,pings:2});
  const humans=await list(`postId=${publicId}&type=comment`);assert.deepEqual(humans.comments.map((row:any)=>row.type),["comment"]);assert.deepEqual(humans.typeCounts,{comment:1,pings:2});
  assert.equal((await list(`postId=${publicId}&type=unsupported`)).status,400);
});

test("type availability follows the existing visible-post boundary and does not reveal private records or email",async()=>{
  const denied=await list(`postId=${privateId}&type=pings`,authorCookie);
  assert.equal(denied.status,200);assert.equal(denied.pagination.total,0);assert.deepEqual(denied.typeCounts,{comment:0,pings:0});assert.deepEqual(denied.comments,[]);
  const allowed=await list(`postId=${publicId}&type=pings`,authorCookie);assert.deepEqual(allowed.typeCounts,{comment:1,pings:2});
  assert.equal(allowed.comments.length,2);for(const row of allowed.comments){assert.equal(row.authorEmail,undefined);assert.equal(row.permissions.edit,false);}
  const admin=await list(`postId=${privateId}&type=pings`);assert.deepEqual(admin.typeCounts,{comment:1,pings:2});assert.equal(admin.comments.length,2);
});
