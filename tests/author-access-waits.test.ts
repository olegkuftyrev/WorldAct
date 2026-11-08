import test, { after } from "./isolated-test.js";
import assert from "node:assert/strict";
import { pool } from "../server/db.js";
import { hashPassword } from "../server/auth.js";

const base=process.env.TEST_API_URL!,origin=process.env.APP_ORIGIN!;
after(()=>pool.end());
test("actual HTTP author metadata waits retain current password, publication and type fences",{timeout:90000},async t=>{
  const initial=(await pool.query("SELECT data FROM settings WHERE id=1")).rows[0].data,ids:number[]=[];
  let cookie="",view=false;
  async function api(path:string,method="GET",body?:unknown,auth=cookie){const response=await fetch(base+path,{method,signal:AbortSignal.timeout(20000),headers:{Origin:origin,"Content-Type":"application/json",...(auth?{Cookie:auth}:{})},body:body===undefined?undefined:JSON.stringify(body)});return {response,data:await response.json()};}
  try{
    const signed=await api("/api/auth/login","POST",{login:process.env.ADMIN_EMAIL,password:process.env.ADMIN_PASSWORD},"");assert.equal(signed.response.status,200);cookie=signed.response.headers.get("set-cookie")!.split(";")[0];
    assert.equal((await api("/api/settings","PUT",{permalinkStructure:"/%author%/%post_id%/%postname%/",pingServices:[]})).response.status,200);
    const records:any[]=[];
    for(const kind of ["expire","rotate","add","private","type","unlock-expire"]){
      const created=await api("/api/posts","POST",{title:"Author HTTP wait "+kind,status:"publish",content:"<p>HTTP-AUTHOR-WAIT-FIRST</p><!--nextpage--><p>HTTP-AUTHOR-WAIT-SECOND</p>",...(kind==="add"?{}:{password:"HTTP-author-wait-password"})});assert.equal(created.response.status,201);const post=created.data.post;ids.push(post.id);
      await pool.query("INSERT INTO comments(post_id,author_name,author_email,content,status) VALUES($1,'Reader','PRIVATE-WAIT@example.test','HTTP-AUTHOR-WAIT-COMMENT','approved')",[post.id]);
      let grant="";
      if(kind!=="add"&&kind!=="unlock-expire"){
        const allowed=await api("/api/public/posts/"+post.slug+"/unlock","POST",{password:"HTTP-author-wait-password"},"");assert.equal(allowed.response.status,200);grant=allowed.response.headers.get("set-cookie")!.split(";")[0];
      }
      records.push({kind,post,grant});
    }
    // Own disposable DB only. The view leaves all real FKs on the renamed
    // table. Its stable identity expression is pruned from body/auth reads,
    // but performs a real advisory wait when the new nicename SELECT runs.
    // Thus HTTP source/compiled processes need no injected application hook.
    const columns=(await pool.query("SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name='users' ORDER BY ordinal_position")).rows.map(row=>row.column_name as string);
    const quote=(value:string)=>'"'+value.replace(/"/g,'""')+'"';
    const setup=await pool.connect();try{await setup.query("BEGIN");
      await setup.query(`CREATE FUNCTION worldact_test_author_nicename(value varchar) RETURNS varchar LANGUAGE plpgsql STABLE AS $$ BEGIN PERFORM pg_advisory_xact_lock(hashtext('worldact-test-author-metadata')); RETURN value; END $$`);
      await setup.query("ALTER TABLE users RENAME TO worldact_test_author_users");
      await setup.query("CREATE VIEW users AS SELECT "+columns.map(column=>column==="nicename"?"worldact_test_author_nicename(nicename) AS nicename":quote(column)).join(",")+" FROM worldact_test_author_users");
      await setup.query("COMMIT");view=true;
    }catch(error){await setup.query("ROLLBACK");throw error;}finally{setup.release();}
    for(const {kind,post,grant} of records)await t.test(kind+" occurs after selected body/grant and during actual nicename query wait",async()=>{
      const control=await pool.connect();let pending:ReturnType<typeof api>|undefined;
      try{await control.query("BEGIN");await control.query("SELECT pg_advisory_xact_lock(hashtext('worldact-test-author-metadata'))");
        // Plain identity avoids the earlier pretty-path resolver's author read;
        // this wait is in publicPost after the immutable body/grant selection.
        pending=kind==="unlock-expire"?api("/api/public/posts/"+post.slug+"/unlock?page=2","POST",{password:"HTTP-author-wait-password"},""):api("/api/public/resolve?"+new URLSearchParams({path:`/?p=${post.id}&page=2`}),"GET",undefined,grant);
        const deadline=Date.now()+10000;let observed=false;
        while(Date.now()<deadline){const result=await pool.query("SELECT query FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid() AND wait_event='advisory' AND position('SELECT u.nicename FROM posts p JOIN users u' in query)>0");if(result.rowCount){observed=true;break;}await new Promise(resolve=>setTimeout(resolve,15));}
        assert.equal(observed,true,"actual server author identity statement must reach its own PostgreSQL wait");
        if(kind==="expire"||kind==="unlock-expire")await pool.query("UPDATE post_access_tokens SET expires_at=now()-interval '1 second' WHERE post_id=$1",[post.id]);
        else if(kind==="rotate"||kind==="add")await pool.query("UPDATE posts SET password_hash=$2 WHERE id=$1",[post.id,await hashPassword("Rotated-HTTP-author-password")]);
        else await pool.query(`UPDATE posts SET ${kind==="private"?"status='private'":"type='page'"} WHERE id=$1`,[post.id]);
        await control.query("COMMIT");const result=await pending;
        assert.equal(result.response.status,["private","type"].includes(kind)?404:200,JSON.stringify(result.data));
        if(result.response.status===200){assert.equal(result.data.post.locked,true);assert.equal(result.data.post.hasPassword,true);assert.deepEqual(result.data.comments,[]);}
        assert.doesNotMatch(JSON.stringify(result.data),/HTTP-AUTHOR-WAIT-(FIRST|SECOND|COMMENT)|PRIVATE-WAIT|password_hash|Rotated-HTTP/);
      }finally{await control.query("ROLLBACK");control.release();if(pending)await pending.catch(()=>{});}
    });
  }finally{
    if(view){const restore=await pool.connect();try{await restore.query("BEGIN");await restore.query("DROP VIEW users");await restore.query("ALTER TABLE worldact_test_author_users RENAME TO users");await restore.query("DROP FUNCTION worldact_test_author_nicename(varchar)");await restore.query("COMMIT");}catch(error){await restore.query("ROLLBACK");throw error;}finally{restore.release();}}
    await pool.query("UPDATE settings SET data=$1 WHERE id=1",[initial]);if(ids.length)await pool.query("DELETE FROM posts WHERE id=ANY($1::int[])",[ids]);await api("/api/auth/logout","POST");
  }
});
