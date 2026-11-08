import test from "./isolated-test.js";
import "dotenv/config";
import assert from "node:assert/strict";
import { pool } from "../server/db.js";
const root = process.env.TEST_API_URL || "http://127.0.0.1:3001";
const origin = process.env.APP_ORIGIN || "http://127.0.0.1:5173";
async function request(path: string, method="GET", body?: unknown, cookie="", authorization="", from: string | null=origin) {
  const response = await fetch(root+path,{method,headers:{"Content-Type":"application/json",...(from?{Origin:from}:{}),...(cookie?{Cookie:cookie}:{}),...(authorization?{Authorization:authorization}:{})},...(body===undefined?{}:{body:JSON.stringify(body)})});
  return {response,data:await response.json()};
}
test("application passwords are shown once, obey roles, authenticate REST, track usage and revoke immediately",async()=>{
  const stamp=Date.now().toString(36);
  const login=await request("/api/auth/login","POST",{login:process.env.ADMIN_EMAIL,password:process.env.ADMIN_PASSWORD});
  assert.equal(login.response.status,200);
  const cookie=login.response.headers.get("set-cookie")!.split(";")[0];
  const keys:string[]=[];const posts:number[]=[];let userId:number|undefined;
  try {
    assert.equal((await request("/api/profile/application-passwords")).response.status,401);
    const created=await request("/api/profile/application-passwords","POST",{name:"QA app "+stamp},cookie);
    assert.equal(created.response.status,201);
    const record=created.data.applicationPassword;keys.push(record.uuid);
    assert.equal(created.data.password.replace(/ /g,"").length,32);
    assert.equal((await request("/api/profile/application-passwords","POST",{name:"qa APP "+stamp},cookie)).response.status,409);
    const basic="Basic "+Buffer.from(login.data.user.username+":"+created.data.password).toString("base64");
    assert.equal((await request("/wp-json/wp/v2/users/me","GET",undefined,"",basic.replace("Basic ","basic "),null)).response.status,200);
    const rest=await request("/wp-json/wp/v2/posts","POST",{title:"QA app post "+stamp,status:"draft"},"",basic,null);
    assert.equal(rest.response.status,201,JSON.stringify(rest.data));posts.push(rest.data.id);
    assert.equal(rest.response.headers.get("set-cookie"),null);
    const introspect=await request("/wp-json/wp/v2/users/me/application-passwords/introspect","GET",undefined,"",basic,null);
    assert.equal(introspect.data.uuid,record.uuid);
    assert.ok(introspect.data.last_used);assert.ok(introspect.data.last_ip);
    assert.equal(introspect.data.password,undefined);assert.equal(introspect.data.key_hash,undefined);
    const listing=await request("/api/profile/application-passwords","GET",undefined,cookie);
    assert.equal(listing.data.passwords.find((item:any)=>item.uuid===record.uuid).password,undefined);
    assert.equal(JSON.stringify(listing.data).includes(created.data.password.replace(/ /g,"")),false);
    const stored=await pool.query("SELECT key_hash FROM application_passwords WHERE uuid=$1",[record.uuid]);
    assert.match(stored.rows[0].key_hash,/^[a-f0-9]{64}$/);assert.notEqual(stored.rows[0].key_hash,created.data.password);
    assert.equal((await request("/wp-json/wp/v2/posts","POST",{title:"Forbidden"},"",basic,"https://foreign.invalid")).response.status,403);
    const accountPassword="Basic "+Buffer.from(login.data.user.username+":"+process.env.ADMIN_PASSWORD).toString("base64");
    assert.equal((await request("/wp-json/wp/v2/posts?context=edit","GET",undefined,"",accountPassword,null)).response.status,401);
    const user=await request("/api/users","POST",{username:"app-subscriber-"+stamp,email:"app-subscriber-"+stamp+"@example.test",displayName:"Application subscriber",role:"subscriber",password:"Temporary-app-"+stamp+"-password"},cookie);
    assert.equal(user.response.status,201);userId=user.data.user.id;
    const ownKey=await request(`/api/users/${userId}/application-passwords`,"POST",{name:"Subscriber client"},cookie);
    assert.equal(ownKey.response.status,201);
    const subscriber="Basic "+Buffer.from(user.data.user.username+":"+ownKey.data.password).toString("base64");
    assert.equal((await request("/wp-json/wp/v2/posts","POST",{title:"Forbidden subscriber"},"",subscriber,null)).response.status,403);
    assert.equal((await request(`/wp-json/wp/v2/users/${login.data.user.id}/application-passwords`,"GET",undefined,"",subscriber,null)).response.status,403);
    const changed=await request(`/api/profile/application-passwords/${record.uuid}`,"PUT",{name:"Renamed "+stamp},cookie);assert.equal(changed.response.status,200);
    assert.equal((await request(`/api/profile/application-passwords/${record.uuid}`,"DELETE",undefined,cookie)).response.status,200);
    assert.equal((await request("/wp-json/wp/v2/users/me/application-passwords/introspect","GET",undefined,"",basic,null)).response.status,401);
    await request(`/api/users/${userId}`,"DELETE",undefined,cookie);userId=undefined;
    assert.equal((await request("/wp-json/wp/v2/posts?context=edit","GET",undefined,"",subscriber,null)).response.status,401);
  } finally {
    for(const id of posts){await request(`/api/posts/${id}`,"PUT",{status:"trash"},cookie);await request(`/api/posts/${id}`,"DELETE",undefined,cookie);}
    for(const uuid of keys)await request(`/api/profile/application-passwords/${uuid}`,"DELETE",undefined,cookie);
    if(userId)await request(`/api/users/${userId}`,"DELETE",undefined,cookie);
    await request("/api/auth/logout","POST",undefined,cookie);
    await pool.end();
  }
});
