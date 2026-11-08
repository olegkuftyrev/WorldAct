import dotenv from 'dotenv';
import pg from 'pg';
import {spawn} from 'node:child_process';
import {randomBytes} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import os from 'node:os';
import {mkdtemp,rm,readdir} from 'node:fs/promises';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
dotenv.config({path:path.join(root,'.env'),quiet:true});
if(!process.env.DATABASE_URL)throw new Error('Configure DATABASE_URL first.');
const original=new URL(process.env.DATABASE_URL);
if(!['127.0.0.1','localhost','[::1]'].includes(original.hostname))throw new Error('Isolated tests require a local PostgreSQL server.');
const adminURL=new URL(original);adminURL.pathname='/postgres';
const database='worldact_test_'+Date.now()+'_'+randomBytes(4).toString('hex');
const testURL=new URL(original);testURL.pathname='/'+database;
const port=Number(process.env.ISOLATED_TEST_PORT || 3004);
if(!Number.isInteger(port)||port<1||port>65535)throw new Error('ISOLATED_TEST_PORT must be an integer from 1 to 65535.');
const testUploads=await mkdtemp(path.join(os.tmpdir(),'worldact-test-uploads-'));
const env={...process.env,DATABASE_URL:testURL.href,ADMIN_EMAIL:'isolated-admin@example.test',ADMIN_PASSWORD:randomBytes(32).toString('base64url'),APP_ORIGIN:'http://127.0.0.1:5173',PORT:String(port),HOST:'127.0.0.1',TEST_API_URL:'http://127.0.0.1:'+port,WORLDACT_MAIL_MODE:'outbox',WORLDACT_UPLOADS_DIR:testUploads,ARCHIVE_PLUGIN_TEST:'1',NODE_ENV:'test'};
const admin=new pg.Pool({connectionString:adminURL.href,connectionTimeoutMillis:5000});
const processGroups=process.platform!=='win32',stops=new WeakMap();
let server,activeChild,cancelled=false;
const exited=child=>child.exitCode!==null||child.signalCode!==null;
function checkCancellation(){if(cancelled)throw new Error('Isolated regression cancelled.');}
function signalChild(child,signal){
 try{if(processGroups&&child.pid)process.kill(-child.pid,signal);else child.kill(signal);}
 catch(error){if(error.code!=='ESRCH')child.kill(signal);}
}
function stopChild(child){
 if(!child||exited(child))return Promise.resolve();
 if(stops.has(child))return stops.get(child);
 const stopping=new Promise(resolve=>{
  // Own process groups include node:test/tsx children and font workers.
  child.once('exit',()=>{clearTimeout(timer);if(processGroups)signalChild(child,'SIGKILL');resolve();});
  const timer=setTimeout(()=>signalChild(child,'SIGKILL'),3000);timer.unref();
  signalChild(child,'SIGTERM');
 });
 stops.set(child,stopping);return stopping;
}
function run(args){
 checkCancellation();
 return new Promise((resolve,reject)=>{
  const child=spawn(process.execPath,args,{cwd:root,env,stdio:'inherit',detached:processGroups});activeChild=child;
  child.once('error',error=>{if(activeChild===child)activeChild=undefined;reject(error);});
  child.once('exit',code=>{if(activeChild===child)activeChild=undefined;code===0&&!cancelled?resolve():reject(new Error(cancelled?'Isolated regression cancelled.':'Test command exited '+code));});
 });
}
async function stopServer(){
 const owned=server;await stopChild(owned);if(server===owned)server=undefined;
}
async function startServer(){
 checkCancellation();
 const entry=process.env.ISOLATED_TEST_COMPILED==="true"?['dist-server/index.js']:['--import','tsx','server/index.ts'];
 server=spawn(process.execPath,entry,{cwd:root,env,stdio:['ignore','pipe','pipe'],detached:processGroups});
 let serverLog='',startError;server.once('error',error=>{startError=error;});
 for(const stream of [server.stdout,server.stderr])stream.on('data',data=>{serverLog=(serverLog+data.toString()).slice(-10000);});
 let ready=false;
 for(let i=0;i<100;i++){
  checkCancellation();if(startError)throw startError;
  if(!server||exited(server))throw new Error('Isolated API exited. '+serverLog);
  // A busy port must never make a different listener look like this child.
  if(serverLog.includes('WorldAct API listening on ')){
   try{const response=await fetch(env.TEST_API_URL+'/api/health',{signal:AbortSignal.timeout(700)});if(response.ok&&server&&!exited(server)){ready=true;break;}}catch{}
  }
  await new Promise(resolve=>setTimeout(resolve,100));
 }
 if(!ready)throw new Error('Isolated API did not become ready. '+serverLog);
}
function cancel(signal){
 if(cancelled)return;cancelled=true;process.exitCode=signal==='SIGINT'?130:143;
 void stopChild(activeChild);void stopServer();
}
const interrupt=()=>cancel('SIGINT'),terminate=()=>cancel('SIGTERM');
process.on('SIGINT',interrupt);process.on('SIGTERM',terminate);
try{
 await admin.query('CREATE DATABASE '+database);
 await run(['--import','tsx','server/migrate.ts']);await run(['--import','tsx','server/seed.ts']);
 const files=process.argv.slice(2);
 const tests=files.length?files:(await readdir(path.join(root,'tests'))).filter(name=>name.endsWith('.test.ts')).sort().map(name=>'tests/'+name);
 console.log('Running against a disposable local database and upload directory; outgoing mail uses the local outbox.');
 for(const file of tests){
  await startServer();
  try{await run(['--import','tsx','--test',file]);}finally{await stopServer();}
 }
 checkCancellation();console.log('Isolated regression complete: '+tests.length+' test files passed.');
}catch(error){console.error(error instanceof Error?error.message:error);if(!cancelled)process.exitCode=1;}
finally{
 await stopChild(activeChild);
 await stopServer();
 await admin.query('DROP DATABASE IF EXISTS '+database+' WITH (FORCE)').catch(error=>{console.error('Could not drop disposable test database: '+error.message);process.exitCode=1;});await admin.end();
 await rm(testUploads,{recursive:true,force:true});
 process.off('SIGINT',interrupt);process.off('SIGTERM',terminate);
}
