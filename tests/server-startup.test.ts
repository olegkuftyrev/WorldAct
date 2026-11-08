import test from "./isolated-test.js";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { rootDir } from "../server/db.js";

test("a busy API port exits with an error instead of reporting a false successful listen", {skip:process.env.NODE_ENV!=="test"},async()=>{
  const port=new URL(process.env.TEST_API_URL || "http://127.0.0.1:3001").port;
  const entry=process.env.ISOLATED_TEST_COMPILED==="true"?["dist-server/index.js"]:["--import","tsx","server/index.ts"];
  const child=spawn(process.execPath,entry,{cwd:rootDir,env:{...process.env,PORT:port},stdio:["ignore","pipe","pipe"]});
  let output="";
  for(const stream of [child.stdout,child.stderr])stream.on("data",data=>{output=(output+data.toString()).slice(-10000);});
  const timer=setTimeout(()=>child.kill("SIGKILL"),10000);
  try{
    const code=await new Promise<number|null>((resolve,reject)=>{child.once("error",reject);child.once("exit",resolve);});
    assert.equal(code,1,output);
    assert.match(output,/Could not start WorldAct API:.*EADDRINUSE/);
    assert.doesNotMatch(output,/WorldAct API listening on/);
  }finally{clearTimeout(timer);if(child.exitCode===null&&child.signalCode===null)child.kill("SIGKILL");}
});
