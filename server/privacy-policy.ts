import {Router} from "express";
import {z} from "zod";
import {randomBytes} from "node:crypto";
import {pool,getSettings,getPost} from "./db.js";
import {requireRole,type AuthRequest} from "./auth.js";
import {needUser,cleanContent,cleanRawContent,slugify,plainText,HttpError} from "./utils.js";
import {buildPrivacyPolicyGuide,privacyPolicyRawContent} from "./privacy-guide.js";
const router=Router(),admin=requireRole("administrator");
async function policyGuide(){
 const settings=await getSettings();
 const akismet=Boolean((await pool.query("SELECT 1 FROM extensions WHERE slug='akismet' AND enabled AND settings @> '{\"sendComments\":true}'::jsonb")).rowCount);
 return buildPrivacyPolicyGuide(settings,akismet);
}
router.get("/tools/privacy/policy-guide",admin,async(_req,res)=>res.json(await policyGuide()));
router.post("/tools/privacy/policy-draft",admin,async(req:AuthRequest,res)=>{
 const input=z.object({title:z.string().trim().min(1).max(300).default("Privacy Policy"),setAsPolicy:z.boolean().default(true)}).strict().parse(req.body || {}),guide=await policyGuide();
 input.title=plainText(input.title).trim();if(!input.title)throw new HttpError(400,"Enter a page title containing text.");
 const raw=privacyPolicyRawContent(guide);
 const db=await pool.connect();let id:number;
 try{
  await db.query("BEGIN");const base=slugify(input.title).slice(0,170),slug=base+"-"+randomBytes(5).toString("hex");
  const inserted=await db.query("INSERT INTO posts(type,title,slug,content,raw_content,status,author_id,comment_status) VALUES('page',$1,$2,$3,$4,'draft',$5,'closed') RETURNING id",[input.title,slug,cleanContent(raw),cleanRawContent(raw),needUser(req).id]);id=inserted.rows[0].id;
  if(input.setAsPolicy)await db.query("UPDATE settings SET data=data || $1::jsonb WHERE id=1",[JSON.stringify({privacyPageId:id})]);await db.query("COMMIT");
 }catch(error){await db.query("ROLLBACK");throw error;}finally{db.release();}
 res.status(201).json({post:await getPost(id),reviewRequired:guide.reviewRequired});
});
export default router;
