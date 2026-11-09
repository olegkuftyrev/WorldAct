import test,{after} from "./isolated-test.js";
import assert from "node:assert/strict";
import {pool} from "../server/db.js";
after(()=>pool.end());
test("unknown named author keeps404 for bounded empty or whitespace search inputs",async t=>{
 const name="unassigned-named-search-"+Date.now();assert.equal((await pool.query("SELECT 1 FROM users WHERE nicename=$1",[name])).rowCount,0);
 for(const [key,value]of [["s",""],["s","   "],["search",""],["search","   "]])await t.test(key+"="+JSON.stringify(value),async()=>{const path="/?"+new URLSearchParams({author_name:name,[key]:value}),response=await fetch(process.env.TEST_API_URL!+"/api/public/document?"+new URLSearchParams({path}),{signal:AbortSignal.timeout(15000)});assert.equal(response.status,404);});
});
