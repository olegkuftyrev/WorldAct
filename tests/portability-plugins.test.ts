import test, { after } from "./isolated-test.js";
import "dotenv/config";
import assert from "node:assert/strict";
import { pool } from "../server/db.js";
import { pluginRegistry } from "../server/design.js";
after(async () => { await pool.end(); });
const base = process.env.TEST_API_URL || "http://127.0.0.1:3001", origin = process.env.APP_ORIGIN || "http://127.0.0.1:5173";
// Explicitly opt in: this integration changes extension settings and therefore
// belongs on a disposable database, never a developer's current site.
test("complete archives omit Akismet secrets and strip injected credential or verification fields", { skip: process.env.ARCHIVE_PLUGIN_TEST !== "1" }, async () => {
 let cookie = "";
 const api = async (path: string, method = "GET", body?: unknown) => {
  const response = await fetch(base + "/api" + path, {method,headers:{Origin:origin,"Content-Type":"application/json",Cookie:cookie},...(body===undefined?{}:{body:JSON.stringify(body)})});
  return {response,data:await response.json()};
 };
 const signed = await api("/auth/login", "POST", {login:process.env.ADMIN_EMAIL,password:process.env.ADMIN_PASSWORD});
 assert.equal(signed.response.status,200); cookie=(signed.response.headers.get("set-cookie") || "").split(";")[0];
 const secret="archive-test-secret-must-never-leak";
 try {
  await pool.query("INSERT INTO extensions(slug,enabled,settings) VALUES('akismet',false,$1::jsonb) ON CONFLICT(slug) DO UPDATE SET enabled=false,settings=excluded.settings",[JSON.stringify({sendComments:false,apiKey:secret,api_key:secret,key:secret,keyHint:"INTERNAL-SECRET-HINT",verified:true,lastVerifiedAt:"INTERNAL-TIME",clearApiKey:true})]);
  const archive = await api("/tools/export"); assert.equal(archive.response.status,200,JSON.stringify(archive.data));
  const exported = archive.data.extensions.find((item:any)=>item.slug==="akismet");
  assert.deepEqual(exported.settings,{sendComments:false});
  assert.doesNotMatch(JSON.stringify(archive.data),/archive-test-secret|INTERNAL-SECRET-HINT|INTERNAL-TIME|apiKey|api_key|clearApiKey/);
  const extensions=pluginRegistry.map(item=>({slug:item.slug,enabled:false,settings:item.slug==='akismet'?{sendComments:true,apiKey:secret,api_key:secret,key:secret,clearApiKey:true,keyHint:'INTERNAL-SECRET-HINT',verified:true}:item.settings}));
  assert.equal(extensions.length,6);
  const restored = await api("/tools/import","POST",{application:"WorldAct",version:3,replaceDesign:true,posts:[],extensions});
  assert.equal(restored.response.status,201,JSON.stringify(restored.data));
  assert.ok(restored.data.warnings.some((message:string)=>message.includes("Akismet")&&message.includes("discarded")));
  const stored=(await pool.query("SELECT settings FROM extensions WHERE slug='akismet'")).rows[0].settings;
  assert.deepEqual(stored,{sendComments:true});
  assert.doesNotMatch(JSON.stringify(restored.data),/archive-test-secret|INTERNAL-SECRET-HINT/);
  assert.deepEqual((await api("/tools/export")).data.extensions.find((item:any)=>item.slug==="akismet").settings,{sendComments:true});
 }finally{await api("/auth/logout","POST",{});}
});
