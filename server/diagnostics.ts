import {Router} from "express";
import {access,stat} from "node:fs/promises";
import {constants} from "node:fs";
import os from "node:os";
import {pool,getSettings,uploadsDir} from "./db.js";
import {requireRole} from "./auth.js";
import {bundledThemeRegistry} from "./themes.js";
import {pluginRegistry} from "./design.js";
import {version} from "../package.json";
const router=Router();
router.get("/tools/health/info",requireRole("administrator"),async(_req,res)=>{
 const [settings,database,tables,counts,extensions,queue]=await Promise.all([
  getSettings(),pool.query("SELECT current_setting('server_version') AS version,current_setting('server_encoding') AS encoding,current_setting('TimeZone') AS timezone,current_setting('max_connections')::int AS max_connections,pg_database_size(current_database())::text AS bytes"),
  pool.query("SELECT relname AS name,n_live_tup::text AS estimated_rows,pg_total_relation_size(relid)::text AS bytes FROM pg_stat_user_tables WHERE schemaname='public' ORDER BY relname"),
  pool.query("SELECT (SELECT count(*)::int FROM posts) AS posts,(SELECT count(*)::int FROM media) AS media,(SELECT count(*)::int FROM comments) AS comments,(SELECT count(*)::int FROM users) AS users,(SELECT count(*)::int FROM site_documents) AS documents"),
  pool.query("SELECT slug,enabled FROM extensions ORDER BY slug"),pool.query("SELECT count(*) FILTER(WHERE NOT delivered)::int AS queued,count(*) FILTER(WHERE delivered)::int AS delivered FROM mail_outbox"),
 ]);
 let writable=false;try{await access(uploadsDir,constants.W_OK);writable=(await stat(uploadsDir)).isDirectory();}catch{}
 const sections=[
  {id:"application",label:"WorldAct",fields:{Version:version,"React CMS":"React + TypeScript + Node.js","Database driver":"pg","PHP runtime":"Not used","MySQL runtime":"Not used",Theme:settings.theme,"Site timezone":settings.timezone,"Site language":"English","Public registration":settings.usersCanRegister?"Enabled":"Disabled","Search indexing":settings.discourageSearchEngines?"Discouraged":"Allowed"}},
  {id:"server",label:"Server",fields:{Node:process.version,V8:process.versions.v8,OpenSSL:process.versions.openssl,Platform:process.platform,Architecture:process.arch,CPUs:os.availableParallelism(),"Memory bytes":os.totalmem(),"Environment":process.env.NODE_ENV || "development"}},
  {id:"database",label:"Database",fields:{Engine:"PostgreSQL",...database.rows[0],"Application pool maximum":pool.options.max,...counts.rows[0]}},
  {id:"storage",label:"Media and storage",fields:{"Upload directory writable":writable,"Per-file upload bytes":32*1024*1024,"Image decode pixel limit":80_000_000,"Storage":"Local files + PostgreSQL metadata","Date directories":settings.uploadsYearMonth,"Generated thumbnail":`${settings.thumbnailWidth} × ${settings.thumbnailHeight}`,"Generated medium":`${settings.mediumWidth} × ${settings.mediumHeight}`,"Generated large":`${settings.largeWidth} × ${settings.largeHeight}`}},
  {id:"mail",label:"Mail",fields:{Transport:process.env.SMTP_HOST && process.env.WORLDACT_MAIL_MODE!=="outbox"?"Configured SMTP":"Local outbox",...queue.rows[0],"Comment notifications":settings.notifyComments,"Moderation notifications":settings.notifyModeration}},
  {id:"themes",label:"Bundled themes",fields:Object.fromEntries(bundledThemeRegistry.map(theme=>[theme.name,`${theme.version}; ${theme.templateCount} templates, ${theme.partCount} parts, ${theme.patternCount} patterns`]))},
  {id:"extensions",label:"Extensions",fields:Object.fromEntries(extensions.rows.map(extension=>[pluginRegistry.find(item=>item.slug===extension.slug)?.name || extension.slug,extension.enabled?"Active":"Inactive"]))},
 ];
 res.json({generatedAt:new Date().toISOString(),sections,tables:tables.rows,redacted:["Database connection string and credentials","Account emails and password hashes","Sessions and application-password keys","Mail bodies and recipients","Confirmation/download/reset tokens","SMTP server credentials","Absolute user filesystem paths"]});
});
export default router;
