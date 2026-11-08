import {Router} from "express";
import type {PoolClient} from "pg";
import {z} from "zod";
import {createHash,randomBytes} from "node:crypto";
import {mkdir,readFile,stat,writeFile,unlink} from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import {pool,getSettings,uploadsDir} from "./db.js";
import {requireRole,type AuthRequest} from "./auth.js";
import {queueMail,deliverMail} from "./accounts.js";
import {safeStoredFile,uploadPrefix} from "./media-files.js";
import {HttpError,needUser} from "./utils.js";
const router=Router(),admin=requireRole("administrator"),hash=(token:string)=>createHash("sha256").update(token).digest("hex");
const tokenSchema=z.string().regex(/^[a-f0-9]{64}$/, "This confirmation link is invalid.");
export async function pendingAdminEmail(db:Pick<PoolClient,"query">=pool){
  return (await db.query('SELECT email,created_at AS "createdAt",expires_at AS "expiresAt",expires_at<=now() AS expired FROM site_email_changes WHERE id=1')).rows[0] || null;
}
/** Caller holds the settings row lock and commits the queued email atomically. */
export async function queueAdminEmailChange(db:PoolClient,email:string,userId:number,resend=false){
  const settings=await getSettings(db);email=email.toLowerCase();
  if(email===settings.adminEmail.toLowerCase())return null;
  const previous=await pendingAdminEmail(db);
  if(previous?.email===email && !previous.expired && !resend)return null;
  const token=randomBytes(32).toString("hex"),link=new URL("/confirm-admin-email?token="+token,process.env.APP_ORIGIN || "http://127.0.0.1:5173").href;
  await db.query("INSERT INTO site_email_changes(id,email,token_hash,requested_by,expires_at) VALUES(1,$1,$2,$3,now()+interval '24 hours') ON CONFLICT(id) DO UPDATE SET email=excluded.email,token_hash=excluded.token_hash,requested_by=excluded.requested_by,created_at=now(),expires_at=excluded.expires_at",[email,hash(token),userId]);
  return queueMail(db,email,`Confirm the administration email for ${settings.siteTitle}`,`A site administrator requested to change the administration email address for ${settings.siteTitle} to ${email}.\n\nReview and confirm within 24 hours:\n${link}\n\nOpening this link does not change the address. If you did not request this change, ignore this message.`);
}
router.get("/settings/admin-email",admin,async(_req,res)=>res.json({pending:await pendingAdminEmail()}));
router.delete("/settings/admin-email",admin,async(_req,res)=>{await pool.query("DELETE FROM site_email_changes WHERE id=1");res.json({ok:true});});
router.post("/settings/admin-email/resend",admin,async(req:AuthRequest,res)=>{
  z.object({}).strict().parse(req.body || {});const db=await pool.connect();let mail=null;
  try{await db.query("BEGIN");await db.query("SELECT id FROM settings WHERE id=1 FOR UPDATE");const pending=await pendingAdminEmail(db);if(!pending)throw new HttpError(404,"There is no pending email change.");mail=await queueAdminEmailChange(db,pending.email,needUser(req).id,true);await db.query("COMMIT");}catch(error){await db.query("ROLLBACK");throw error;}finally{db.release();}
  res.json({pending:await pendingAdminEmail(),delivery:await deliverMail(mail)});
});
router.get("/settings/admin-email/confirmation",async(req,res)=>{
  const token=tokenSchema.parse(req.query.token),row=(await pool.query('SELECT email,expires_at AS "expiresAt" FROM site_email_changes WHERE id=1 AND token_hash=$1 AND expires_at>now()',[hash(token)])).rows[0];
  if(!row)throw new HttpError(410,"This confirmation link has expired, was replaced, or was already used.");res.json({...row,siteTitle:(await getSettings()).siteTitle});
});
router.post("/settings/admin-email/confirmation",async(req,res)=>{
  const {token}=z.object({token:tokenSchema}).strict().parse(req.body),db=await pool.connect();let mail=null;
  try{await db.query("BEGIN");await db.query("SELECT id FROM settings WHERE id=1 FOR UPDATE");const pending=(await db.query("DELETE FROM site_email_changes WHERE id=1 AND token_hash=$1 AND expires_at>now() RETURNING email",[hash(token)])).rows[0];if(!pending)throw new HttpError(410,"This confirmation link has expired, was replaced, or was already used.");const previous=await getSettings(db);await db.query("UPDATE settings SET data=data || $1::jsonb WHERE id=1",[JSON.stringify({adminEmail:pending.email})]);mail=await queueMail(db,previous.adminEmail,`Administration email changed for ${previous.siteTitle}`,`The administration email address for ${previous.siteTitle} changed to ${pending.email}.\n\nIf this was unexpected, sign in as an administrator and review General settings.`);await db.query("COMMIT");}catch(error){await db.query("ROLLBACK");throw error;}finally{db.release();}
  res.json({ok:true,delivery:await deliverMail(mail)});
});
router.post("/settings/site-icon",admin,async(req:AuthRequest,res)=>{
  const input=z.object({mediaId:z.number().int().positive().max(2147483647),crop:z.object({left:z.number().int().min(0),top:z.number().int().min(0),width:z.number().int().min(512).max(20000),height:z.number().int().min(512).max(20000)}).strict().optional()}).strict().parse(req.body);
  const db=await pool.connect(),created:string[]=[];
  try{
    await db.query("BEGIN");const item=(await db.query("SELECT * FROM media WHERE id=$1 FOR SHARE",[input.mediaId])).rows[0];
    if(!item?.mime_type.startsWith("image/") || !safeStoredFile(item.filename))throw new HttpError(400,"Choose an existing image.");
    const source=path.join(uploadsDir,item.filename);if((await stat(source)).size>32*1024*1024)throw new HttpError(413,"The image exceeds the upload size limit.");
    const buffer=await readFile(source),metadata=await sharp(buffer,{limitInputPixels:80_000_000}).rotate().toBuffer({resolveWithObject:true});
    const width=metadata.info.width,height=metadata.info.height,side=Math.min(width,height);
    if(side<512)throw new HttpError(400,"Choose an image at least 512 by 512 pixels.");
    const crop=input.crop || {left:Math.floor((width-side)/2),top:Math.floor((height-side)/2),width:side,height:side};
    if(crop.width!==crop.height || crop.left+crop.width>width || crop.top+crop.height>height)throw new HttpError(400,"Choose a square crop inside the image.");
    const settings=await getSettings(db),prefix=uploadPrefix(settings),sizes:Record<string,any>={};await mkdir(path.join(uploadsDir,prefix),{recursive:true});
    let filename="",bytes=0;
    for(const size of [512,270,192,180,32,16]){
      const data=await sharp(metadata.data,{limitInputPixels:80_000_000}).extract(crop).resize(size,size).png().toBuffer(),name=prefix+randomBytes(20).toString("hex")+"-icon-"+size+".png";
      await writeFile(path.join(uploadsDir,name),data,{flag:"wx"});created.push(name);
      if(size===512){filename=name;bytes=data.length;}else sizes["icon-"+size]={filename:name,url:"/uploads/"+name,width:size,height:size,mimeType:"image/png"};
    }
    const row=(await db.query("INSERT INTO media(author_id,title,filename,mime_type,size,width,height,sizes) VALUES($1,$2,$3,'image/png',$4,512,512,$5::jsonb) RETURNING id",[needUser(req).id,("Site Icon — "+item.title).slice(0,300),filename,bytes,JSON.stringify(sizes)])).rows[0];
    await db.query("UPDATE settings SET data=data || $1::jsonb WHERE id=1",[JSON.stringify({siteIconId:row.id})]);await db.query("COMMIT");
    res.status(201).json({siteIconId:row.id,url:"/uploads/"+filename,sizes});
  }catch(error){await db.query("ROLLBACK");await Promise.all(created.map(name=>unlink(path.join(uploadsDir,name)).catch(()=>{})));throw error;}finally{db.release();}
});
export default router;
