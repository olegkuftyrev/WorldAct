import test, { after } from "./isolated-test.js";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { pool } from "../server/db.js";

const base=process.env.TEST_API_URL!,origin=process.env.APP_ORIGIN!;
after(()=>pool.end());
test("creation barrier and identity waits retain live role, credential, registration and collision semantics",async t=>{
  const stamp="creation-"+Date.now().toString(36),ids:number[]=[],initial=(await pool.query("SELECT data FROM settings WHERE id=1")).rows[0].data;
  let cookie="";
  async function api(path:string,method="GET",body?:unknown,auth=cookie,basic=""){
    const response=await fetch(base+path,{method,headers:{Origin:origin,"Content-Type":"application/json",...(auth?{Cookie:auth}:{}),...(basic?{Authorization:basic}:{})},body:body===undefined?undefined:JSON.stringify(body)});
    return {response,data:await response.json()};
  }
  async function ok(path:string,method="GET",body?:unknown,auth=cookie){const result=await api(path,method,body,auth);assert.ok(result.response.ok,`${path}: ${result.response.status} ${JSON.stringify(result.data)}`);return result;}
  function input(username:string,role="administrator"){return {username,email:username.replace(/[@.]/g,"x")+"@example.test",displayName:"Waiting creator",password:"Creation-password-12345",role};}
  async function actor(label:string,application=false){
    const person=(await ok("/api/users","POST",input(stamp+"-"+label))).data.user;ids.push(person.id);
    const login=await ok("/api/auth/login","POST",{login:person.username,password:"Creation-password-12345"},"");
    const ownCookie=login.response.headers.get("set-cookie")!.split(";")[0];
    if(!application)return {...person,cookie:ownCookie,basic:"",uuid:""};
    const key=(await ok("/api/profile/application-passwords","POST",{name:"Waiting creation"},ownCookie)).data;
    return {...person,cookie:"",basic:"Basic "+Buffer.from(person.username+":"+key.password).toString("base64"),uuid:key.applicationPassword.uuid};
  }
  async function blocked(lock:string,work:()=>Promise<any>,change:()=>Promise<void>){
    const control=await pool.connect();let pending:Promise<any>|undefined;
    try{await control.query("BEGIN");await control.query("SELECT pg_advisory_xact_lock(hashtext($1))",[lock]);pending=work();
      for(let attempt=0;;attempt++){
        const result=await pool.query("SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid() AND state='active' AND wait_event='advisory' AND query LIKE $1",["%"+lock+"%"]);
        if(result.rowCount)break;assert.ok(attempt<150,"Bounded advisory wait was not observed: "+lock);await new Promise(resolve=>setTimeout(resolve,20));
      }
      await change();await control.query("COMMIT");return await pending;
    }finally{await control.query("ROLLBACK");control.release();if(pending)await pending.catch(()=>{});}
  }
  try{
    const signed=await ok("/api/auth/login","POST",{login:process.env.ADMIN_EMAIL,password:process.env.ADMIN_PASSWORD},"");cookie=signed.response.headers.get("set-cookie")!.split(";")[0];
    const seeded=(await pool.query("SELECT nicename FROM users WHERE id=$1",[signed.data.user.id])).rows[0];assert.equal(seeded.nicename,"admin");
    await t.test("a role changed while an authenticated creator waits at the barrier denies creation",async()=>{
      const person=await actor("role"),username=stamp+"-role-denied";
      const response=await blocked("worldact-user-creation",()=>api("/api/users","POST",input(username),person.cookie),async()=>{await pool.query("UPDATE users SET role='subscriber' WHERE id=$1",[person.id]);});
      assert.equal(response.response.status,403);assert.equal((await pool.query("SELECT 1 FROM users WHERE username=$1",[username])).rowCount,0);
    });
    for(const lock of ["worldact-user-creation","worldact-account-identity"]){
      for(const application of [false,true])await t.test(`${application?"application password":"session"} revocation during ${lock} wait denies creation`,async()=>{
        const person=await actor((application?"key":"session")+"-"+(lock.endsWith("identity")?"identity":"barrier"),application),username=stamp+"-denied-"+ids.length;
        const response=await blocked(lock,()=>api("/api/users","POST",input(username),person.cookie,person.basic),async()=>{
          if(application)await pool.query("DELETE FROM application_passwords WHERE user_id=$1 AND uuid=$2",[person.id,person.uuid]);
          else await pool.query("DELETE FROM sessions WHERE user_id=$1 AND token_hash=$2",[person.id,createHash("sha256").update(person.cookie.split("=")[1]).digest("hex")]);
        });
        assert.equal(response.response.status,401);assert.equal((await pool.query("SELECT 1 FROM users WHERE username=$1",[username])).rowCount,0);
      });
    }
    await t.test("registration reads enabled/default-role settings after the creation barrier",async()=>{
      await ok("/api/settings","PUT",{usersCanRegister:true,defaultRole:"subscriber"});
      const denied=stamp+"-registration-denied";
      const result=await blocked("worldact-user-creation",()=>api("/api/auth/register","POST",{username:denied,email:denied+"@example.test"},""),async()=>{await pool.query("UPDATE settings SET data=data || '{\"usersCanRegister\":false}'::jsonb WHERE id=1");});
      assert.equal(result.response.status,403);assert.equal((await pool.query("SELECT 1 FROM users WHERE username=$1",[denied])).rowCount,0);
      await ok("/api/settings","PUT",{usersCanRegister:true,defaultRole:"subscriber"});
      const accepted=stamp+"-registration-current-role";
      const created=await blocked("worldact-user-creation",()=>api("/api/auth/register","POST",{username:accepted,email:accepted+"@example.test"},""),async()=>{await pool.query("UPDATE settings SET data=data || '{\"defaultRole\":\"author\"}'::jsonb WHERE id=1");});
      assert.equal(created.response.status,201);const row=(await pool.query("SELECT id,role,nicename FROM users WHERE username=$1",[accepted])).rows[0];ids.push(row.id);assert.equal(row.role,"author");assert.equal(row.nicename,accepted);
    });
    await t.test("simultaneous colliding creators allocate distinct first-free public identities",async()=>{
      const names=["Collision."+stamp,"Collision-"+stamp,"Collision@-"+stamp];
      const results=await Promise.all(names.map(name=>api("/api/users","POST",input(name,"author"))));
      for(const result of results){assert.equal(result.response.status,201,JSON.stringify(result.data));ids.push(result.data.user.id);}
      const rows=(await pool.query("SELECT nicename FROM users WHERE username=ANY($1::text[]) ORDER BY nicename",[names])).rows;
      assert.deepEqual(rows.map(row=>row.nicename),["collision-"+stamp,"collision-"+stamp+"-2","collision-"+stamp+"-3"]);
    });
  }finally{
    await pool.query("UPDATE settings SET data=$1 WHERE id=1",[initial]);
    if(ids.length)await pool.query("DELETE FROM users WHERE id=ANY($1::int[])",[ids]);
    await pool.query("DELETE FROM mail_outbox WHERE recipient LIKE $1",[stamp+"%"]);
    await api("/api/auth/logout","POST");
  }
});
