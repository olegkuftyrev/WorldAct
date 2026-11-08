import {Router} from "express";
import {z} from "zod";
import {randomBytes} from "node:crypto";
import {pool,getSettings,getPost} from "./db.js";
import {requireRole,type AuthRequest} from "./auth.js";
import {needUser,cleanContent,cleanRawContent,slugify,plainText,HttpError} from "./utils.js";
const router=Router(),admin=requireRole("administrator");
const esc=(value:string)=>value.replace(/[&<>"']/g,char=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"})[char]!);
async function policyGuide(){
 const settings=await getSettings();
 const akismet=Boolean((await pool.query("SELECT 1 FROM extensions WHERE slug='akismet' AND enabled AND settings @> '{\"sendComments\":true}'::jsonb")).rowCount);
 const sections=[
  {id:"identity",title:"Who we are",text:[`Our website address is: ${settings.siteUrl}.`,`[Add the organization or person responsible for this website and the privacy contact address.]`]},
  {id:"comments",title:"Comments",text:["When visitors leave comments, we collect the data shown in the comment form, including the name, email address, website address and comment text. Names, website links and approved comment text may be displayed publicly; email addresses are not displayed.",settings.showAvatars?"An anonymized email hash may be sent to Gravatar to display an avatar. Your browser contacts Gravatar when loading those images.":"Public avatars are disabled.","Comments may be reviewed by the site administrator and checked against configured moderation and spam rules. [Describe any additional moderation services used by this site.]"]},
  {id:"media",title:"Media",text:["Uploaded files may be publicly accessible. Avoid uploading images containing embedded location information (EXIF GPS), because visitors can download and extract that information.","[Describe who may upload files and any additional processing or external storage used by this site.]"]},
  {id:"cookies",title:"Cookies",text:["If you sign in, this website sets an authentication cookie lasting up to seven days. Logging out revokes that session.","Unlocking password-protected content can set a cookie lasting up to seven days.",settings.commentCookieConsent?"If you explicitly choose to save your comment details, an opaque cookie allows your name, email and website to be recalled for a future comment for up to 347 days. Declining this option does not prevent commenting. You can opt out on a later comment or remove the cookie from your browser.":"Comment-author details are not saved for future comments in a browser preference cookie.","[List any additional cookies introduced by your own services or extensions.]"]},
  {id:"embeds",title:"Embedded content from other websites",text:["Articles may include embedded videos or other external content. Embedded YouTube and Vimeo videos contact their providers and may collect data about you, use cookies or track your interaction according to those providers' settings and policies.","[List the external services actually used on this website, including analytics, payment or advertising services if applicable.]"]},
  {id:"accounts",title:"Accounts and email",text:[settings.usersCanRegister?"Registration is enabled. Account information includes the username, email address and any profile information you provide. Account passwords are stored as protected password hashes.":"Public account registration is disabled. Administrators may create accounts for authorized users.","Password-setting and recovery links expire after 30 minutes and are single use. [Identify the email provider used to deliver account or comment messages, if applicable.]"]},
  {id:"retention",title:"How long we retain your data",text:["Comments and their moderation records are retained until an administrator deletes them. Account information, authored content and uploaded files are retained until separately edited or deleted. [State your site's actual retention schedule and backup retention.]"]},
  {id:"rights",title:"Access and erasure requests",text:["You can contact the site administrator to request an export or erasure of personal data associated with your account or comments. Requests require confirmation. Export download links expire after three days.","Comment-author erasure removes matching names, email addresses, website addresses and account associations, and revokes earlier export snapshots. Account records, authored content and comment text are retained unless separately edited or deleted. [Describe additional data handling and any applicable exceptions for your organization.]"]},
 ];
 if(akismet){
  sections.find(section=>section.id==="comments")!.text.push("This site uses Akismet to reduce spam. Comment data, including the submitted name, email, website, comment text, IP address, browser user agent and referrer, may be sent to Akismet for processing. Learn more at https://akismet.com/privacy/.");
  sections.find(section=>section.id==="retention")!.text.push("Local Akismet submission metadata is retained for up to 30 days and then removed by scheduled cleanup while the server is running. Confirm the service provider's own data retention separately.");
 }
 return {siteTitle:settings.siteTitle,siteUrl:settings.siteUrl,generatedAt:new Date().toISOString(),sections,reviewRequired:["Replace every bracketed instruction with information about this site.","Review external services, contacts, retention periods and additional extensions.","Publish the reviewed page before displaying it as the site's privacy policy."]};
}
router.get("/tools/privacy/policy-guide",admin,async(_req,res)=>res.json(await policyGuide()));
router.post("/tools/privacy/policy-draft",admin,async(req:AuthRequest,res)=>{
 const input=z.object({title:z.string().trim().min(1).max(300).default("Privacy Policy"),setAsPolicy:z.boolean().default(true)}).strict().parse(req.body || {}),guide=await policyGuide();
 input.title=plainText(input.title).trim();if(!input.title)throw new HttpError(400,"Enter a page title containing text.");
 const raw=guide.sections.map(section=>`<!-- wp:heading --><h2>${esc(section.title)}</h2><!-- /wp:heading -->`+section.text.map(text=>`<!-- wp:paragraph --><p>${esc(text)}</p><!-- /wp:paragraph -->`).join("")).join("");
 const db=await pool.connect();let id:number;
 try{
  await db.query("BEGIN");const base=slugify(input.title).slice(0,170),slug=base+"-"+randomBytes(5).toString("hex");
  const inserted=await db.query("INSERT INTO posts(type,title,slug,content,raw_content,status,author_id,comment_status) VALUES('page',$1,$2,$3,$4,'draft',$5,'closed') RETURNING id",[input.title,slug,cleanContent(raw),cleanRawContent(raw),needUser(req).id]);id=inserted.rows[0].id;
  if(input.setAsPolicy)await db.query("UPDATE settings SET data=data || $1::jsonb WHERE id=1",[JSON.stringify({privacyPageId:id})]);await db.query("COMMIT");
 }catch(error){await db.query("ROLLBACK");throw error;}finally{db.release();}
 res.status(201).json({post:await getPost(id),reviewRequired:guide.reviewRequired});
});
export default router;
