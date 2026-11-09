import type { Request } from "express";
import type { PublicDocumentModel, FrameworkDocument, PublicPost, PublicSettings, PublicTemplateRef, PublicHead, PublicArchive } from "../shared/public-document.js";
import { normalizePublicQuery, PublicQueryError, selectPublicSourceTemplate } from "../shared/public-routing.js";
import { commentsOpen } from "../shared/comment-open.js";
import { commentReturnPath, commentLoginHref } from "../shared/comment-links.js";
import { type User } from "./db.js";
import { readCookieSessionUser } from "./auth.js";
import { postAccessReader, currentPublicPostPolicy } from "./post-passwords.js";
import {completePublicRead} from "./public-read-attempt.js";
import { resolvePublicDocumentRoute } from "./public-documents.js";
import { readPublicPath } from "./public-path.js";
import { readPublicSite, readPublishedPostById, type PublicReadContext } from "./public-read.js";
import { readDesign } from "./design.js";
import { renderPublicTemplateDocument, classicDefaultDocuments } from "./public-presentation.js";
import { publicReplyParent } from "./public-reply.js";
import { plainText, HttpError } from "./utils.js";
import { isInstalled } from "./installation-state.js";

export type PublicDocumentContext = { user?: User; canReadProtectedPost: PublicReadContext["canReadProtectedPost"]; sensitive: boolean };
export async function publicDocumentContext(req: Pick<Request,"headers">, options: {user?: User; cookieOnly?: boolean} = {}): Promise<PublicDocumentContext> {
  const user=options.cookieOnly ? await readCookieSessionUser(req) : options.user;
  return {user,canReadProtectedPost:postAccessReader(req),sensitive:Boolean(user || /(?:^|;)\s*worldact_post_[1-9]\d*=/.test(req.headers.cookie || ""))};
}

// Explicit presentation allowlists prevent new administrative fields from
// silently entering initial HTML when the database/API shapes grow.
const settingsKeys = ["siteTitle","tagline","siteUrl","usersCanRegister","siteLogoId","siteIconId","siteIconUrl","siteIconSizes","timezone","dateFormat","timeFormat","weekStartsOn","postsPerPage","discourageSearchEngines","theme","frontPageMode","frontPageId","postsPageId","requireCommentNameEmail","commentRegistration","commentsPerPage","threadComments","threadDepth","closeCommentsDays","commentOrder","permalinkStructure","categoryBase","tagBase","privacyPageId","paginateComments","commentCookieConsent","showAvatars"] as const;
import {formatPostCivil} from "./post-date.js";
import {postPublicationKey} from "../shared/post-civil-date.js";
const postKeys = ["postDate","postDateGmt","id","type","format","title","slug","content","permalink","excerpt","status","authorId","authorName","commentCount","approvedCommentCount","createdAt","updatedAt","publishedAt","scheduledAt","version","terms","categories","tags","categoryIds","tagIds","parentId","menuOrder","templateSlug","featuredMediaId","commentStatus","sticky","hasPassword","locked","readingTime","contentPagination","footnotes"] as const;
function pick(input: Record<string,any>, keys: readonly string[]) { return Object.fromEntries(keys.filter(key=>input[key]!==undefined).map(key=>[key,input[key]])); }
function safePost(post: any): PublicPost {
  const result=pick(post,postKeys);
  for(const key of ["createdAt","updatedAt","publishedAt","scheduledAt","postDateGmt"])if(result[key] instanceof Date)result[key]=result[key].toISOString();
  // Featured media presentation is safe; ownership/file bookkeeping is not.
  if(post.featuredMedia) result.featuredMedia=pick(post.featuredMedia,["id","url","title","alt","caption","mimeType","width","height"]);
  return result as PublicPost;
}
const templateRef = (document: any): PublicTemplateRef => ({...pick(document,["id","slug","title","type","version","updatedAt"]),isCustom:document.content!==classicDefaultDocuments[document.slug]}) as PublicTemplateRef;
function displayDate(value: string | Date | null, settings: PublicSettings) {
  if(!value)return "—";
  const date=new Date(value), options={timeZone:settings.timezone || "UTC",year:"numeric",month:"2-digit",day:"2-digit"} as const;
  try {
    const parts=new Intl.DateTimeFormat("en-US",options).formatToParts(date),part=(kind:string)=>parts.find(item=>item.type===kind)?.value || "";
    if(settings.dateFormat==="Y-m-d")return `${part("year")}-${part("month")}-${part("day")}`;
    if(settings.dateFormat==="m/d/Y")return `${part("month")}/${part("day")}/${part("year")}`;
    if(settings.dateFormat==="d/m/Y")return `${part("day")}/${part("month")}/${part("year")}`;
    return new Intl.DateTimeFormat("en-US",{...options,month:"long",day:"numeric"}).format(date);
  }catch{return date.toLocaleDateString("en-US");}
}
function publicHead(model: Pick<PublicDocumentModel,"post"|"site"|"route"|"status"|"design"|"requestPath">): PublicHead {
  const {post,site,route,design,status}=model,title=site.settings.siteTitle || "WorldAct",single=["singular","front-page"].includes(route.kind);
  const origin=new URL(site.settings.siteUrl || process.env.APP_ORIGIN || "http://127.0.0.1:5173").origin;
  const canonical=status===404?null:new URL(post?.contentPagination?.links.find(link=>link.current)?.url || post?.permalink || model.requestPath,origin).href;
  const plugin=design.plugins.find(item=>item.slug==="site-seo"),description=post && !post.locked ? (post.excerpt || plainText(post.content)).slice(0,300) : String(plugin?.settings.description || site.settings.tagline || "");
  const image=post && !post.locked ? post.featuredMedia?.url || String(plugin?.settings.siteImage || "") : String(plugin?.settings.siteImage || "");
  const icons:PublicHead["icons"]=[];
  if(site.settings.siteIconUrl){
    const sizes=site.settings.siteIconSizes || {};
    icons.push({rel:"icon",href:sizes["icon-16"]?.url || site.settings.siteIconUrl,sizes:"16x16"});
    for(const size of [32,192])if(sizes["icon-"+size])icons.push({rel:"icon",href:sizes["icon-"+size].url,sizes:`${size}x${size}`});
    if(sizes["icon-180"])icons.push({rel:"apple-touch-icon",href:sizes["icon-180"].url,sizes:"180x180"});
  }
  return {title:`${post && route.detail ? post.title+" – " : ""}${title}`,robots:site.settings.discourageSearchEngines?"noindex,nofollow":null,canonical,
    seo:plugin?{description,title:post?.title || title,type:route.detail?"article":"website",url:canonical || new URL(model.requestPath,origin).href,image:image?new URL(image,origin).href:null}:null,icons,tileImage:site.settings.siteIconSizes?.["icon-270"]?.url || null};
}

/** One request, direct services, no internal HTTP or Express response adapter. */
export function readPublicDocument(path:string,context:PublicDocumentContext):Promise<PublicDocumentModel|FrameworkDocument>{
  return completePublicRead(context.canReadProtectedPost,reader=>readPublicDocumentOnce(path,{...context,canReadProtectedPost:reader}));
}
async function readPublicDocumentOnce(path: string, context: PublicDocumentContext): Promise<PublicDocumentModel | FrameworkDocument> {
  let resolution=await resolvePublicDocumentRoute(path);
  if(resolution.kind==="framework")return {kind:"framework",status:200,requestPath:path};
  if(!await isInstalled())return {kind:"framework",status:resolution.status,requestPath:path};
  const rawQuery=readPublicPath(path).query;
  const selectedId=resolution.selectedId,selectedType=resolution.selectedType;
  const selected=selectedId!==undefined && selectedType!==undefined;
  let query:ReturnType<typeof normalizePublicQuery>;
  try { query=normalizePublicQuery(rawQuery,{singular:selected && resolution.kind!=="posts-page",contentPage:resolution.contentPage,archive:resolution.archive as PublicArchive | null}); }
  catch(error){if(error instanceof PublicQueryError){
    if(resolution.status===404)query=normalizePublicQuery(new URLSearchParams(),{singular:false});
    else throw new HttpError(400,error.message);
  }else throw error;}
  const readContext:PublicReadContext={query:{...query.values,page:query.archivePage},requestPath:path,user:context.user,canReadProtectedPost:context.canReadProtectedPost};
  // Metadata resolution above and body acquisition below are deliberately
  // independent. No later slug lookup can substitute another published row.
  let body: Awaited<ReturnType<typeof readPublishedPostById>> | null=null;
  if(selected)try { body=await readPublishedPostById(resolution.selectedId!,resolution.selectedType!,{...readContext,query:{...query.values,page:query.contentPage}}); }
  catch(error){if(!(error instanceof HttpError) || error.status!==404)throw error;resolution={status:404,kind:"not-found"};}
  let rawSite:Awaited<ReturnType<typeof readPublicSite>>,rawDesign:Awaited<ReturnType<typeof readDesign>>;
  try{[rawSite,rawDesign]=await Promise.all([readPublicSite(readContext),readDesign()]);}
  catch(error){
    if(!(error instanceof HttpError)||error.status!==404||!body||await currentPublicPostPolicy(selectedId!,selectedType!,context.canReadProtectedPost))throw error;
    // An author read in secondary site acquisition can itself observe that the
    // selected immutable identity disappeared. Reacquire safe404 surroundings.
    body=null;resolution={status:404,kind:"not-found"};
    [rawSite,rawDesign]=await Promise.all([readPublicSite(readContext),readDesign()]);
  }
  async function assemble():Promise<PublicDocumentModel>{
    const site:PublicDocumentModel["site"]={...rawSite,archive:rawSite.archive as PublicArchive | null,settings:pick(rawSite.settings,settingsKeys) as PublicSettings,
      posts:rawSite.posts.map(safePost),pages:rawSite.pages.map(post=>safePost({...post,content:"",excerpt:"",footnotes:[]})),frontPage:rawSite.frontPage?safePost({...rawSite.frontPage,content:"",excerpt:"",footnotes:[]}):null,postsPage:rawSite.postsPage?safePost({...rawSite.postsPage,content:"",excerpt:"",footnotes:[]}):null};
    if(resolution.status===404 && selected){site.frontPage=null;site.postsPage=null;site.pages=site.pages.filter(page=>page.id!==selectedId);}
    if(site.archive && "type" in site.archive && site.archive.type==="date")query.date=site.archive;
    const post=body?safePost(body.post):null,comments=(body?.comments || []).map(comment=>({...comment,createdAt:new Date(comment.createdAt).toISOString()}));
    const design:PublicDocumentModel["design"]={theme:rawDesign.theme,styles:rawDesign.styles,templates:rawDesign.templates.map(templateRef),parts:rawDesign.parts.map(templateRef),menus:rawDesign.menus,plugins:rawDesign.plugins};
    const route:PublicDocumentModel["route"]={kind:resolution.kind as PublicDocumentModel["route"]["kind"],detail:Boolean(body && (readPublicPath(path).pathname!=="/" || rawQuery.has("p") || rawQuery.has("page_id") || rawQuery.has("page"))),archive:resolution.archive as PublicArchive || site.archive || null,query,...(body?{selectedId:post!.id,selectedType:post!.type}:{})};
    const single=["singular","front-page"].includes(route.kind);
    if(single || resolution.status===404)site.posts=[];
    const renderOptions={requestPath:path,query:query.values,post:body?.rawPost || null,page:single?1:query.archivePage,contentPage:query.contentPage,user:context.user,canReadProtectedPost:context.canReadProtectedPost};
    let presentation:PublicDocumentModel["presentation"];
    const document=site.settings.theme!=="classic" ? selectPublicSourceTemplate(rawDesign.templates,{notFound:resolution.status===404,single,post,frontPage:route.kind==="front-page",search:Boolean(query.search),category:query.category,tag:query.tag,author:Boolean(query.author),date:Boolean(query.date || site.archive && "type" in site.archive && site.archive.type==="date")}) : null;
    if(document) presentation={kind:"source",document:templateRef(document),html:await renderPublicTemplateDocument(document,renderOptions)};
    else {
      const slots:Extract<PublicDocumentModel["presentation"],{kind:"classic"}>["slots"]={};
      for(const [slot,slug,type] of [["header","header","template-part"],["footer","footer","template-part"],["single",post?.type==="page"?"page":"single","template"],["index","index","template"]] as const){
        if(slot==="single" && (!single || post?.locked) || slot==="index" && (single || resolution.status===404))continue;
        const candidate=(type==="template-part"?rawDesign.parts:rawDesign.templates).find(item=>item.slug===slug && item.content!==classicDefaultDocuments[slug]);
        if(candidate)slots[slot]={document:templateRef(candidate),html:await renderPublicTemplateDocument(candidate,renderOptions)};
      }
      presentation={kind:"classic",slots};
    }
    const open=Boolean(single && post && !post.locked && commentsOpen(post,site.settings));
    const parent=open && (!site.settings.commentRegistration || context.user) ? publicReplyParent(post!.id,query.values.replytocom,comments,site.settings):null;
    const dates:Record<string,string>={};
    for(const item of [...site.posts,...site.pages,...(post?[post]:[])])if((item as any).postDate)dates[postPublicationKey(item as any)]=formatPostCivil((item as any).postDate,site.settings.dateFormat || "F j, Y",site.settings.timezone || "UTC");
    for(const item of comments)dates[String(item.createdAt)]=displayDate(item.createdAt,site.settings);
    const returnPath=commentReturnPath(path,query.values);
    const model:PublicDocumentModel={schema:1,requestPath:path,status:resolution.status,route,viewer:context.user?{id:context.user.id,displayName:context.user.displayName,role:context.user.role,showAdminBar:context.user.showAdminBar!==false}:null,
      site,post,comments,commentsPagination:body?.commentsPagination || null,design,presentation,head:null as any,
      controls:{commentsOpen:open,replyParentId:parent?.id || 0,replyParentName:parent?.authorName || null,commentReturnPath:returnPath,loginHref:commentLoginHref(returnPath),sensitive:context.sensitive,dates}};
    model.head=publicHead(model);
    model.head.pingback=model.status===200 ? resolution.pingback || null : null;
    return model;
  }
  return assemble();
}
