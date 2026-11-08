import { date as formatDate } from "@wordpress/date";
import socialIcons from "../src/theme-source/social-icons.json";
import type { Node, Context, State } from "./block-renderer.js";
import { postFields } from "./db.js";
import { postPermalink } from "./permalinks.js";
import { cleanContent, plainText } from "./utils.js";
import {avatarURL} from "./avatars.js";
import {canEditPostComments} from "./comment-access.js";

export const THEME_BLOCKS = [
  "core/term-description", "core/social-links", "core/social-link", "core/avatar", "core/post-navigation-link", "core/search",
  "core/comments", "core/comments-title", "core/comment-template", "core/comment-date", "core/comment-author-name", "core/comment-content",
  "core/comment-edit-link", "core/comment-reply-link", "core/comments-pagination", "core/comments-pagination-previous",
  "core/comments-pagination-numbers", "core/comments-pagination-next", "core/post-comments-form", "core/categories", "core/loginout",
];
const esc = (value: unknown) => String(value ?? "").replace(/[&<>"']/g, c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"})[c]!);
const int = (value: unknown, fallback: number, max=2147483647) => Number.isInteger(Number(value)) && Number(value)>0 ? Math.min(max,Number(value)) : fallback;
async function cached<T>(state: State,key:string,fn:()=>Promise<T>):Promise<T> {
  if(!state.cache.has(key))state.cache.set(key,fn());return state.cache.get(key)!;
}
function pageLink(state:State,page:number,anchor="comments") {
  const query=new URLSearchParams();
  for(const [key,value] of Object.entries(state.options.query || {}))if(typeof value==="string" && !["postId","requestPath","type"].includes(key))query.set(key,value);
  query.set("commentPage",String(page));
  return `${state.options.requestPath || "/"}?${query}#${anchor}`;
}
function safeUrl(value:unknown) {
  const input=String(value || "").trim();
  return /^(https?:\/\/|mailto:|tel:|\/(?!\/)|#)/i.test(input) && !/[\u0000-\u0020<>"']/.test(input) ? input : "";
}
async function comments(context:Context,state:State) {
  if(context.commentLoop)return context.commentLoop;
  const postId=context.post?.id;
  if(!postId || context.post?.locked)return {comments:[],total:0,page:1,perPage:state.settings.commentsPerPage,totalPages:0};
  const requested=int(state.options.query?.commentPage,0),perPage=state.settings.commentsPerPage;
  return cached(state,`comments:${postId}:${requested}`,async()=>{
    const total=(await state.db.query("SELECT count(*)::int AS count FROM comments WHERE post_id=$1 AND status='approved'",[postId])).rows[0].count;
    const totalPages=state.settings.paginateComments?Math.max(1,Math.ceil(total/perPage)):1;
    const page=state.settings.paginateComments?Math.min(requested || ((state.settings.defaultCommentPage==="newest")===(state.settings.commentOrder==="asc")?totalPages:1),totalPages):1;
    const order=state.settings.commentOrder==="desc"?"DESC":"ASC";
    const records=(await state.db.query(`SELECT id,parent_id AS "parentId",author_name AS "authorName",author_email AS "_avatarEmail",author_url AS "authorUrl",user_id AS "userId",content,created_at AS "createdAt" FROM comments WHERE post_id=$1 AND status='approved' ORDER BY created_at ${order},id ${order}${state.settings.paginateComments?" LIMIT $2 OFFSET $3":""}`,state.settings.paginateComments?[postId,perPage,(page-1)*perPage]:[postId])).rows;
    return {comments:records,total,page,perPage:state.settings.paginateComments?perPage:Math.max(1,total),totalPages};
  });
}
export async function renderThemeBlock(
  node:Node, context:Context, state:State,
  children:(nodes:Node[],context:Context)=>Promise<string>,
  attributes:(extra?:string)=>string,
):Promise<string|undefined> {
  const name=node.name,a=node.attrs,p=context.post,c=context.comment;
  const body=(next=context)=>children(node.children,next);
  if(name==="core/term-description") {
    const query=state.options.query || {},taxonomy=query.tag?"tag":"category",slug=String(query.tag || query.category || "");
    if(!slug)return "";
    const term=await cached(state,`description:${taxonomy}:${slug}`,async()=>(await state.db.query("SELECT description FROM terms WHERE taxonomy=$1 AND slug=$2",[taxonomy,slug])).rows[0]);
    return term?.description?`<div${attributes()}>${cleanContent(term.description)}</div>`:"";
  }
  if(name==="core/social-links")return `<ul${attributes("is-layout-flex")}>${await body({...context,social:{openInNewTab:!!a.openInNewTab,showLabels:!!a.showLabels}})}</ul>`;
  if(name==="core/social-link") {
    const url=safeUrl(a.url);if(!url)return "";
    const service=String(a.service || "wordpress"),label=plainText(String(a.label || service)),icon=(socialIcons as Record<string,string>)[service] || (socialIcons as Record<string,string>).wordpress || "";
    return `<li${attributes("wp-social-link wp-social-link-"+service.replace(/[^a-z0-9-]/g,""))}><a href="${esc(url)}" aria-label="${esc(label)}"${context.social?.openInNewTab?' target="_blank" rel="noopener noreferrer"':''}>${icon}<span class="${context.social?.showLabels?"wp-block-social-link-label":"screen-reader-text"}">${esc(label)}</span></a></li>`;
  }
  if(name==="core/avatar") {
    if(!state.settings.showAvatars)return "";
    const id=int(a.userId,c?.userId || p?.authorId || 0),size=int(a.size,96,512);
    const account=id?await cached(state,`avatar:${id}`,async()=>(await state.db.query("SELECT display_name AS name,email,profile FROM users WHERE id=$1",[id])).rows[0]):null;
    const label=account?.name || c?.authorName || "Avatar";
    const image=`<img src="${esc(avatarURL(account?.email || c?._avatarEmail || "",state.settings,size))}" alt="${esc(label)}" width="${size}" height="${size}" class="avatar avatar-${size} photo" loading="lazy">`;
    return `<div${attributes()}>${a.isLink && id?`<a href="/?author=${id}"${a.linkTarget==="_blank"?' target="_blank" rel="noopener noreferrer"':''}>${image}</a>`:image}</div>`;
  }
  if(name==="core/search") {
    const id="wp-search-"+state.nodes,label=plainText(String(a.label || "Search")),button=plainText(String(a.buttonText || "Search"));
    const style=a.width?` style="width:${int(a.width,100,2000)}${a.widthUnit==="%"?"%":"px"}"`:"";
    return `<form${attributes(`wp-block-search wp-block-search__button-${a.buttonPosition==="button-inside"?"inside":"outside"}`)} role="search" method="get" action="/">${a.showLabel===false?"":`<label class="wp-block-search__label" for="${id}">${esc(label)}</label>`}<div class="wp-block-search__inside-wrapper"${style}><input class="wp-block-search__input" id="${id}" type="search" name="s" value="${esc(state.options.query?.search || state.options.query?.s || "")}" placeholder="${esc(a.placeholder || "")}" required>${a.buttonPosition==="no-button"?"":`<button class="wp-block-search__button wp-element-button" type="submit">${esc(button)}</button>`}</div></form>`;
  }
  if(name==="core/post-navigation-link") {
    if(!p?.id)return "";
    const previous=a.type==="previous",operator=previous?"<":">",order=previous?"DESC":"ASC";
    const next=await cached(state,`post-navigation:${p.id}:${previous}:${a.taxonomy || ""}`,async()=>(await state.db.query(`SELECT ${postFields} FROM posts p JOIN users u ON u.id=p.author_id WHERE p.type=$1 AND p.id<>$2 AND p.status='publish' AND p.password_hash IS NULL AND (coalesce(p.published_at,p.created_at),p.id)${operator}(SELECT coalesce(current_post.published_at,current_post.created_at),current_post.id FROM posts current_post WHERE current_post.id=$2) ${a.taxonomy?"AND EXISTS(SELECT 1 FROM post_terms current JOIN post_terms related ON related.term_id=current.term_id JOIN terms t ON t.id=current.term_id WHERE current.post_id=$2 AND related.post_id=p.id AND t.taxonomy=$3)":""} ORDER BY coalesce(p.published_at,p.created_at) ${order},p.id ${order} LIMIT 1`,a.taxonomy?[p.type,p.id,a.taxonomy==="post_tag"?"tag":"category"]:[p.type,p.id])).rows[0]);
    if(!next)return "";
    const url=await postPermalink(next,state.settings,state.db),title=esc(next.title || "(no title)"),label=esc(a.label || (previous?"Previous Post":"Next Post")),arrow=a.arrow && a.arrow!=="none"?(previous?"← ":" →"):"";
    return `<div${attributes()}>${a.showTitle && !a.linkLabel?`<span class="post-navigation-link__label">${label}</span>`:""}<a href="${esc(url)}" rel="${previous?"prev":"next"}">${previous?arrow:""}${a.showTitle?title:label}${previous?"":arrow}</a></div>`;
  }
  if(name==="core/comments") {
    if(!p || p.locked)return "";
    const loop=await comments(context,state),tag=["section","aside","div"].includes(a.tagName)?a.tagName:"div";
    return `<${tag}${attributes()} id="comments">${await body({...context,commentLoop:loop})}</${tag}>`;
  }
  if(name==="core/comments-title") {
    const loop=await comments(context,state);if(!loop.total)return "";
    const level=int(a.level,2,6),label=a.showCommentsCount===false?"Responses":`${loop.total} ${loop.total===1?"response":"responses"}`;
    return `<h${level}${attributes()}>${esc(label)}${a.showPostTitle===false?"":` to “${esc(p?.title || "") }”`}</h${level}>`;
  }
  if(name==="core/comment-template") {
    const loop=await comments(context,state),ids=new Set(loop.comments.map((item:any)=>item.id));
    const visited=new Set<number>();
    const renderList=async(parent:number|null,depth=0):Promise<string>=>{
      const records=loop.comments.filter((item:any)=>!visited.has(item.id) && (!state.settings.threadComments || parent===null?(!state.settings.threadComments || !item.parentId || !ids.has(item.parentId)):item.parentId===parent));
      const out=[];
      for(const comment of records){
        visited.add(comment.id);
        const atLimit=depth>=state.settings.threadDepth-1;
        const nested=state.settings.threadComments?await renderList(comment.id,atLimit?depth:depth+1):"";
        out.push(`<li id="comment-${comment.id}" class="comment ${depth%2?"odd":"even"}">${await body({...context,comment,commentLoop:loop})}${nested && !atLimit?`<ol class="children">${nested}</ol>`:""}</li>${atLimit?nested:""}`);
      }
      return out.join("");
    };
    return `<ol${attributes()}>${await renderList(null)}</ol>`;
  }
  if(name==="core/comment-author-name") {
    if(!c)return "";
    const label=esc(c.authorName),url=safeUrl(c.authorUrl);
    return `<div${attributes()}>${a.isLink!==false && url?`<a href="${esc(url)}"${a.linkTarget==="_blank"?' target="_blank" rel="noopener noreferrer nofollow"':' rel="nofollow"'}>${label}</a>`:label}</div>`;
  }
  if(name==="core/comment-date") {
    if(!c)return "";
    const date=formatDate(a.format || state.settings.dateFormat,new Date(c.createdAt),state.settings.timezone),time=`<time datetime="${esc(new Date(c.createdAt).toISOString())}">${esc(date)}</time>`;
    return `<div${attributes()}>${a.isLink===false?time:`<a href="#comment-${int(c.id,0)}">${time}</a>`}</div>`;
  }
  if(name==="core/comment-content")return c?`<div${attributes()}>${cleanContent(c.content)}</div>`:"";
  if(name==="core/comment-edit-link")return c && p && state.options.user && canEditPostComments(state.options.user,{authorId:Number(p.authorId ?? p.author_id),type:p.type,status:p.status,preTrashStatus:p.preTrashStatus ?? p.pre_trash_status})?`<div${attributes()}><a href="/admin/comments?commentId=${c.id}">Edit</a></div>`:"";
  if(name==="core/comment-reply-link")return c && p?.commentStatus!=="closed" && state.settings.threadComments?`<div${attributes()}><a href="#respond" data-comment-reply="${int(c.id,0)}" data-comment-author="${esc(c.authorName)}">Reply</a></div>`:"";
  if(name==="core/comments-pagination")return `<nav${attributes("is-layout-flex")} aria-label="Comments pagination">${await body({...context,commentLoop:await comments(context,state)})}</nav>`;
  if(name?.startsWith("core/comments-pagination-")) {
    const loop=await comments(context,state);if(loop.totalPages<=1)return "";
    if(name.endsWith("numbers")) {
      const out=[];
      for(let page=Math.max(1,loop.page-3);page<=Math.min(loop.totalPages,loop.page+3);page++)out.push(page===loop.page?`<span aria-current="page" class="page-numbers current">${page}</span>`:`<a class="page-numbers" href="${esc(pageLink(state,page))}">${page}</a>`);
      return `<div${attributes()}>${out.join(" ")}</div>`;
    }
    const previous=name.endsWith("previous"),page=loop.page+(previous?-1:1);
    return page<1 || page>loop.totalPages?"":`<a${attributes()} href="${esc(pageLink(state,page))}">${esc(a.label || (previous?"Older Comments":"Newer Comments"))}</a>`;
  }
  if(name==="core/post-comments-form") {
    if(state.options.preview)return "";
    if(!p?.id || p.locked || p.commentStatus==="closed" || (state.settings.closeCommentsDays>0 && new Date(p.publishedAt || p.createdAt).valueOf()+state.settings.closeCommentsDays*86400000<Date.now()))return "";
    const user=state.options.user;
    if(state.settings.commentRegistration && !user)return `<div${attributes()} id="respond"><p>You must be <a href="/login?redirect_to=${esc(encodeURIComponent(state.options.requestPath || "/"))}">logged in</a> to post a comment.</p></div>`;
    const required=state.settings.requireCommentNameEmail?" required":"";
    const akismet=await cached(state,"akismet-processing-disclosure",async()=>Boolean((await state.db.query("SELECT 1 FROM extensions WHERE slug='akismet' AND enabled AND settings @> '{\"sendComments\":true}'::jsonb")).rowCount));
    const privacy=akismet?'<p class="akismet_comment_form_privacy_notice">This site uses Akismet to reduce spam. <a href="https://akismet.com/privacy/" target="_blank" rel="noopener noreferrer">Learn how your comment data is processed.</a></p>':"";
    return `<div${attributes()} id="respond"><h3 id="reply-title" class="comment-reply-title">Leave a Reply</h3><p class="worldact-native-comment-notice" role="status"></p><form class="worldact-native-comment-form comment-form" action="/wp-comments-post.php" method="post"><input type="hidden" name="postId" value="${p.id}"><input type="hidden" name="parentId" value=""><p class="comment-form-comment"><label for="comment-text-${p.id}">Comment${state.settings.requireCommentNameEmail?" *":""}</label><textarea id="comment-text-${p.id}" name="content" rows="8" maxlength="20000" required></textarea></p>${user?`<p>Logged in as <a href="/admin/profile">${esc(user.displayName)}</a>.</p>`:`<p class="comment-notes">Your email address will not be published.</p><p class="comment-form-author"><label for="author-${p.id}">Name${required?" *":""}</label><input id="author-${p.id}" name="authorName" maxlength="160" autocomplete="name"${required}></p><p class="comment-form-email"><label for="email-${p.id}">Email${required?" *":""}</label><input id="email-${p.id}" name="authorEmail" type="email" maxlength="254" autocomplete="email"${required}></p><p class="comment-form-url"><label for="url-${p.id}">Website</label><input id="url-${p.id}" name="authorUrl" type="url" maxlength="2000" autocomplete="url"></p>`}${!user && state.settings.commentCookieConsent?'<p class="comment-form-cookies-consent"><input id="comment-cookie-'+p.id+'" type="checkbox" name="rememberAuthor"><label for="comment-cookie-'+p.id+'">Save my name, email, and website in this browser for the next time I comment.</label></p>':""}<p class="form-submit"><button type="submit" class="submit wp-element-button">Post Comment</button></p>${privacy}</form></div>`;
  }
  if(name==="core/categories") {
    const taxonomy=a.taxonomy==="post_tag"?"tag":"category";
    const terms=await cached(state,`categories-block:${taxonomy}`,async()=>(await state.db.query("SELECT t.id,t.name,t.slug,t.parent_id AS \"parentId\",(SELECT count(*)::int FROM post_terms pt JOIN posts p ON p.id=pt.post_id WHERE pt.term_id=t.id AND p.status='publish' AND p.password_hash IS NULL) AS count FROM terms t WHERE taxonomy=$1 ORDER BY name,id LIMIT 1000",[taxonomy])).rows);
    const visibleIds=new Set<number>(terms.filter((term:any)=>a.showEmpty || term.count>0).map((term:any)=>term.id));
    if(a.showHierarchy || a.showOnlyTopLevel)for(const term of terms.filter((term:any)=>visibleIds.has(term.id))){
      let parent=term.parentId;const seen=new Set<number>();
      while(parent && !seen.has(parent)){seen.add(parent);visibleIds.add(parent);parent=terms.find((item:any)=>item.id===parent)?.parentId;}
    }
    const shown=terms.filter((term:any)=>visibleIds.has(term.id) && (!a.showOnlyTopLevel || !term.parentId));
    const base=taxonomy==="tag"?state.settings.tagBase:state.settings.categoryBase,url=(term:any)=>`/${encodeURIComponent(base)}/${encodeURIComponent(term.slug)}/`;
    if(a.displayAsDropdown)return `<form${attributes()} action="/" method="get">${a.showLabel===false?"":`<label for="category-select-${state.nodes}">${esc(a.label || "Categories")}</label>`}<select id="category-select-${state.nodes}" name="${taxonomy}">${shown.map((term:any)=>`<option value="${esc(term.slug)}">${esc(term.name)}${a.showPostCounts?` (${term.count})`:""}</option>`).join("")}</select><button type="submit">View</button></form>`;
    const list=(parent:number|null,depth=0):string=>depth>20?"":shown.filter((term:any)=>!a.showHierarchy || depth===0?!a.showHierarchy || !term.parentId:term.parentId===parent).map((term:any)=>`<li class="cat-item cat-item-${term.id}"><a href="${esc(url(term))}">${esc(term.name)}</a>${a.showPostCounts?` (${term.count})`:""}${a.showHierarchy && shown.some((child:any)=>child.parentId===term.id)?`<ul class="children">${list(term.id,depth+1)}</ul>`:""}</li>`).join("");
    return `<ul${attributes()}>${list(null)}</ul>`;
  }
  if(name==="core/loginout")return `<div${attributes()}>${state.options.user?`<form method="post" action="/logout"><input type="hidden" name="redirect_to" value="${esc(state.options.requestPath || "/")}"><button type="submit">Log out</button></form>`:`<a href="/login?redirect_to=${esc(encodeURIComponent(state.options.requestPath || "/"))}">Log in</a>`}</div>`;
  return undefined;
}
