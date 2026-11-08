import { Router } from "express";
import { createHash, randomBytes } from "node:crypto";
import { z } from "zod";
import { pool, getSettings, userFields } from "./db.js";
import { requireRole, hashPassword, type AuthRequest } from "./auth.js";
import { HttpError, plainText } from "./utils.js";
import { queueMail, deliverMail } from "./accounts.js";
import { updateUser, deleteUser } from "./platform.js";

const router = Router(), admin = requireRole("administrator");
const roles = ["administrator", "editor", "author", "contributor", "subscriber"] as const;
const role = z.enum(roles);
const listQuery = z.object({
  search: z.string().trim().max(200).default(""), role: role.optional(),
  page: z.coerce.number().int().min(1).max(1_000_000).default(1),
  perPage: z.coerce.number().int().min(1).max(1000).default(1000),
  orderby: z.enum(["username","name","email","role","posts"]).default("username"),
  order: z.enum(["asc","desc"]).default("asc"),
}).strict();
router.get("/users", admin, async (req, res) => {
  const input = listQuery.parse(req.query), values: unknown[] = [], where: string[] = [];
  if(input.search) {
    values.push("%"+input.search.replace(/[\\%_]/g,"\\$&")+"%");
    where.push(`(u.username ILIKE $${values.length} OR u.email ILIKE $${values.length} OR u.display_name ILIKE $${values.length} OR u.profile->>'firstName' ILIKE $${values.length} OR u.profile->>'lastName' ILIKE $${values.length})`);
  }
  const searchWhere = where.length ? "WHERE "+where.join(" AND ") : "";
  const countsRows = await pool.query(`SELECT u.role,count(*)::int AS count FROM users u ${searchWhere} GROUP BY u.role`,values);
  const counts: Record<string,number> = {all:0,...Object.fromEntries(roles.map(r=>[r,0]))};
  for(const row of countsRows.rows){counts[row.role]=row.count;counts.all+=row.count;}
  if(input.role){values.push(input.role);where.push(`u.role=$${values.length}`);}
  const filteredWhere = where.length ? "WHERE "+where.join(" AND ") : "";
  const total = input.role ? counts[input.role] : counts.all;
  const totalPages=Math.max(1,Math.ceil(total/input.perPage)), page=Math.min(input.page,totalPages);
  values.push(input.perPage,(page-1)*input.perPage);
  const sort = {username:"lower(u.username)",name:"lower(u.display_name)",email:"lower(u.email)",role:"u.role",posts:'"postCount"'}[input.orderby];
  const result=await pool.query(`SELECT u.id,u.username,u.email,u.display_name AS "displayName",u.role,u.created_at AS "createdAt",coalesce(u.profile->>'firstName','') AS "firstName",coalesce(u.profile->>'lastName','') AS "lastName",coalesce(u.profile->>'website','') AS website,(SELECT count(*)::int FROM posts p WHERE p.author_id=u.id AND p.type='post' AND p.status<>'trash') AS "postCount" FROM users u ${filteredWhere} ORDER BY ${sort} ${input.order.toUpperCase()},u.id LIMIT $${values.length-1} OFFSET $${values.length}`,values);
  res.json({users:result.rows,counts,pagination:{page,perPage:input.perPage,total,totalPages}});
});
router.post("/users",admin,async(req,res)=>{
  const input=z.object({
    username:z.string().trim().min(1).max(60).regex(/^[a-zA-Z0-9_.@-]+$/),email:z.email().max(254),
    displayName:z.string().trim().min(1).max(160),password:z.string().min(12).max(1024),role,
    firstName:z.string().max(100).default(""),lastName:z.string().max(100).default(""),
    website:z.string().max(2000).refine(s=>!s||/^https?:\/\//i.test(s),"Use an HTTP(S) website URL.").default(""),
    sendNotification:z.boolean().default(false),
  }).strict().parse(req.body);
  const displayName=plainText(input.displayName).trim();
  if(!displayName)throw new HttpError(400,"Enter a display name containing text.");
  const passwordHash=await hashPassword(input.password),client=await pool.connect();
  let mail:Awaited<ReturnType<typeof queueMail>>|null=null, user:any;
  try{
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtext('worldact-account-identity'))");
    const collision=await client.query("SELECT id FROM users WHERE lower(username)=ANY($1::text[]) OR lower(email)=ANY($1::text[])",[[input.username.toLowerCase(),input.email.toLowerCase()]]);
    if(collision.rowCount)throw new HttpError(409,"That username or email address is already registered.");
    const profile={firstName:plainText(input.firstName),lastName:plainText(input.lastName),website:input.website,nickname:input.username};
    const inserted=await client.query(`INSERT INTO users(username,email,display_name,password_hash,role,profile) VALUES($1,$2,$3,$4,$5,$6) RETURNING ${userFields}`,[input.username,input.email.toLowerCase(),displayName,passwordHash,input.role,JSON.stringify(profile)]);
    user={...inserted.rows[0],...profile,postCount:0};
    if(input.sendNotification){
      const token=randomBytes(32).toString("hex"),settings=await getSettings(client);
      await client.query("INSERT INTO password_resets(token_hash,user_id,expires_at) VALUES($1,$2,now()+interval '30 minutes')",[createHash("sha256").update(token).digest("hex"),user.id]);
      const link=new URL("/reset-password?token="+token,process.env.APP_ORIGIN||"http://127.0.0.1:5173").href;
      mail=await queueMail(client,input.email.toLowerCase(),`Your account on ${settings.siteTitle}`,`Your account has been created.\n\nUsername: ${input.username}\n\nSet your password within 30 minutes:\n${link}\n\nIf the link expires, request a new one from the login page.`);
    }
    await client.query("COMMIT");
  }catch(error){await client.query("ROLLBACK");throw error;}finally{client.release();}
  const delivery=await deliverMail(mail);
  res.status(201).json({user,...(delivery?{delivery}:{})});
});
router.post("/users/bulk",admin,async(req:AuthRequest,res)=>{
  const input=z.discriminatedUnion("action",[
    z.object({ids:z.array(z.number().int().positive()).min(1).max(100),action:z.literal("role"),role}).strict(),
    z.object({ids:z.array(z.number().int().positive()).min(1).max(100),action:z.literal("delete"),reassignTo:z.number().int().positive().optional(),deleteContent:z.boolean().optional()}).strict(),
  ]).parse(req.body);
  let updated=0;const errors:{id:number;message:string}[]=[];
  // A reassignment target cannot also be removed by this operation.
  if(input.action==="delete"&&input.reassignTo&&input.ids.includes(input.reassignTo))throw new HttpError(400,"Choose a reassignment user outside the selected accounts.");
  for(const id of new Set(input.ids)){
    try{
      if(input.action==="role")await updateUser({...req,body:{role:input.role}} as AuthRequest,id);
      else await deleteUser(req,id,{reassignTo:input.reassignTo,deleteContent:input.deleteContent?"true":"false"});
      updated++;
    }catch(error){if(!(error instanceof HttpError))throw error;errors.push({id,message:error.message});}
  }
  res.json({updated,errors});
});
export default router;
