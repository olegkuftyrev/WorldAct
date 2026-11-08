import express, {type Response} from "express";
import {z} from "zod";
import {submitPublicComment,unlockPublicPost} from "./core.js";
import {destroySession,type AuthRequest} from "./auth.js";
import {nativePostReturn} from "./native-post-return.js";
import {HttpError} from "./utils.js";
import {authenticateLogin,loginRateLimit} from "./login.js";
import {normalizeLoginRedirect} from "../shared/login-redirect.js";
const router=express.Router();
const origin=()=>new URL(process.env.APP_ORIGIN || "http://127.0.0.1:5173").origin;
function localPath(value:unknown){return normalizeLoginRedirect(value,origin()) || "/";}
function nativeRedirectInput(input:Record<string,unknown>):unknown {
  if(Object.keys(input).some(key=>key.startsWith("redirect_to[")))return null;
  return Object.hasOwn(input,"redirect_to") ? input.redirect_to : undefined;
}
router.use(["/wp-comments-post.php","/logout","/post-password","/public-login"],(req,res,next)=>{
  if(req.method!=="POST"){next();return;}
  let valid=req.headers.origin===origin();
  if(!req.headers.origin && req.headers.referer){try{valid=new URL(req.headers.referer).origin===origin();}catch{}}
  if(!valid){next(new HttpError(403,"This request must come from the configured site origin."));return;}
  res.setHeader("Cache-Control","no-store");next();
},express.urlencoded({extended:false,limit:"128kb",parameterLimit:20}));
router.post("/wp-comments-post.php",async(req:AuthRequest,res)=>{
  const input=req.body || {};
  req.body={postId:Number(input.postId ?? input.comment_post_ID),
    ...(Number(input.parentId ?? input.comment_parent)?{parentId:Number(input.parentId ?? input.comment_parent)}:{}),
    ...(input.authorName!==undefined || input.author!==undefined?{authorName:input.authorName ?? input.author}:{}),
    ...(input.authorEmail!==undefined || input.email!==undefined?{authorEmail:input.authorEmail ?? input.email}:{}),
    ...(input.authorUrl!==undefined || input.url!==undefined?{authorUrl:input.authorUrl ?? input.url}:{}),
    content:input.content ?? input.comment,
    rememberAuthor:input.rememberAuthor==="on" || input.rememberAuthor==="true" || input["wp-comment-cookies-consent"]==="yes",
  };
  let result:any,status=200;
  // Reuse the public API handler, including its rate limiter and access checks.
  const response=new Proxy(res,{get(target,key){if(key==="status")return(code:number)=>{status=code;return response;};if(key==="json")return(value:unknown)=>{result=value;return response;};const value=Reflect.get(target,key,target);return typeof value==="function"?value.bind(target):value;}}) as Response;
  await submitPublicComment(req,response);
  if(status!==201 || !result?.comment)throw new HttpError(status,result?.error || "Unable to submit this comment.");
  res.redirect(303,await nativePostReturn(req.body.postId,nativeRedirectInput(input),req.headers.referer,{comment:result.comment}));
});
router.post("/public-login",loginRateLimit,async(req,res)=>{
  const input=z.object({
    log:z.string().trim().min(1).max(254),pwd:z.string().min(1).max(1024),
    rememberme:z.enum(["forever","on"]).optional(),
    redirect_to:z.string().max(2000).optional(),"wp-submit":z.string().max(100).optional(),
  }).strict().parse(req.body);
  const target=normalizeLoginRedirect(input.redirect_to,origin()) || "/admin";
  const user=await authenticateLogin(req,res,{login:input.log,password:input.pwd,remember:!!input.rememberme});
  if(!user){
    const query=new URLSearchParams({login_error:"1",redirect_to:target});
    res.redirect(303,"/login?"+query);return;
  }
  res.redirect(303,target);
});
router.post("/logout",async(req,res)=>{
  const input=z.object({redirect_to:z.string().max(2000).optional()}).parse(req.body);
  await destroySession(req,res);res.redirect(303,localPath(input.redirect_to));
});
router.post("/post-password",async(req,res)=>{
  const fields=req.body || {}, values=Object.fromEntries(Object.entries(fields).filter(([key])=>!key.startsWith("redirect_to[")));
  const input=z.object({postSlug:z.string().min(1).max(220),password:z.string().min(1).max(1024),redirect_to:z.unknown().optional()}).strict().parse(values);
  (req.params as Record<string,string>).slug=input.postSlug;req.body={password:input.password};let result:any;
  const response=new Proxy(res,{get(target,key){if(key==="json")return(value:unknown)=>{result=value;return response;};const value=Reflect.get(target,key,target);return typeof value==="function"?value.bind(target):value;}}) as Response;
  await unlockPublicPost(req,response);
  if(!result?.post)throw new HttpError(400,"Unable to unlock this post.");
  res.redirect(303,await nativePostReturn(result.post.id,nativeRedirectInput(fields),req.headers.referer));
});
export default router;
