import {renderedCommentContent} from "./comment-policy.js";
import {commentsOpen} from "../shared/comment-open.js";
import {commentReturnPath,commentLoginHref} from "../shared/comment-links.js";
import { date as formatDate } from "@wordpress/date";
import socialIcons from "../src/theme-source/social-icons.json";
import { MAX_RENDER_NODES, type Node, type Context, type State } from "./block-renderer.js";
import { postFields, postMetadataFields } from "./db.js";
import { postPermalink } from "./permalinks.js";
import {observePublicPost} from "./public-read-attempt.js";
import { cleanContent, plainText, HttpError } from "./utils.js";
import {avatarURL} from "./avatars.js";
import {canEditPostComments} from "./comment-access.js";
import {normalizeLoginRedirect} from "../shared/login-redirect.js";
import {publicPaginationLocation} from "./public-pagination.js";
import {publicCommentWindow} from "./comment-window.js";
import {publicReplyParent} from "./public-reply.js";

import { THEME_BLOCKS } from "../shared/dynamic-blocks.js";
export { THEME_BLOCKS };
const esc = (value: unknown) => String(value ?? "").replace(/[&<>"']/g, c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"})[c]!);
const int = (value: unknown, fallback: number, max=2147483647) => Number.isInteger(Number(value)) && Number(value)>0 ? Math.min(max,Number(value)) : fallback;
async function cached<T>(state: State,key:string,fn:()=>Promise<T>):Promise<T> {
  if(!state.cache.has(key))state.cache.set(key,fn());return state.cache.get(key)!;
}
function pageLink(state:State,page:number,anchor="comments") {
  const {path,query}=publicPaginationLocation(state.options.requestPath,state.options.query);
  query.set("commentPage",String(page));
  return `${path}?${query}#${anchor}`;
}
function safeUrl(value:unknown) {
  const input=String(value || "").trim();
  return /^(https?:\/\/|mailto:|tel:|\/(?!\/)|#)/i.test(input) && !/[\u0000-\u0020<>"']/.test(input) ? input : "";
}
async function comments(context:Context,state:State) {
  if(context.commentLoop)return context.commentLoop;
  const postId=context.post?.id;
  if(!postId || context.post?.locked)return {comments:[],total:0,page:1,perPage:state.settings.commentsPerPage,totalPages:0};
  const requested=int(state.options.query?.commentPage,0);
  return cached(state,`comments:${postId}:${requested}`,()=>publicCommentWindow(postId,requested || undefined,state.settings,state.db));
}
export async function renderThemeBlock(
  node:Node, context:Context, state:State,
  children:(nodes:Node[],context:Context)=>Promise<string>,
  attributes:(extra?:string)=>string,
):Promise<string|undefined> {
  const name=node.name,a=node.attrs,p=context.post,c=context.comment;
  const body=(next=context)=>children(node.children,next);
  if(name==="core/term-description") {
    if(context.term)return context.term.description?`<div${attributes()}>${cleanContent(context.term.description)}</div>`:"";
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
    // Source comment context always wins over explicit block/post user IDs.
    // Notifications are not avatar-bearing people and must not inherit an author.
    if(c && c.type && !["comment","note"].includes(c.type))return `<div${attributes()}></div>`;
    const id=c?int(c.userId,0):a.userId!=null?int(a.userId,0):int(p?.authorId ?? p?.author_id ?? state.options.query?.author,0);
    if(!c && !id)return "";
    const size=int(a.size,96,512);
    const account=id?await cached(state,`avatar:${id}`,async()=>(await state.db.query("SELECT display_name AS name,email FROM users WHERE id=$1",[id])).rows[0]):null;
    if(!c && !account)return "";
    const name=String(c?c.authorName || "":account.name || "");
    const email=account?account.email:c?._avatarEmail || "";
    const image=`<img src="${esc(avatarURL(email,state.settings,size))}" alt="${esc(name+" Avatar")}" width="${size}" height="${size}" class="avatar avatar-${size} photo wp-block-avatar__image" loading="lazy">`;
    const url=c?safeUrl(c.authorUrl):`/?author=${id}`;
    const newTab=a.linkTarget==="_blank";
    const linked=a.isLink && url?`<a href="${esc(url)}" class="wp-block-avatar__link"${newTab?` target="_blank" rel="noopener noreferrer" aria-label="${esc(`(${name} ${c?"website link":"author archive"}, opens in a new tab)`)}"`:""}>${image}</a>`:image;
    return `<div${attributes()}>${linked}</div>`;
  }
  if(name==="core/search") {
    const id="wp-search-"+state.nodes,label=plainText(String(a.label || "Search")),button=plainText(String(a.buttonText || "Search"));
    const style=a.width?` style="width:${int(a.width,100,2000)}${a.widthUnit==="%"?"%":"px"}"`:"";
    return `<form${attributes(`wp-block-search wp-block-search__button-${a.buttonPosition==="button-inside"?"inside":"outside"}`)} role="search" method="get" action="/">${a.showLabel===false?"":`<label class="wp-block-search__label" for="${id}">${esc(label)}</label>`}<div class="wp-block-search__inside-wrapper"${style}><input class="wp-block-search__input" id="${id}" type="search" name="s" value="${esc(state.options.query?.search || state.options.query?.s || "")}" placeholder="${esc(a.placeholder || "")}" required>${a.buttonPosition==="no-button"?"":`<button class="wp-block-search__button wp-element-button" type="submit">${esc(button)}</button>`}</div></form>`;
  }
  if(name==="core/post-navigation-link") {
    if(!p?.id)return "";
    const previous=a.type==="previous",operator=previous?"<":">",order=previous?"DESC":"ASC";
    const next=await cached(state,`post-navigation:${p.id}:${previous}:${a.taxonomy || ""}`,async()=>(await state.db.query(`SELECT ${postMetadataFields} FROM posts p WHERE p.type=$1 AND p.id<>$2 AND p.status='publish' AND (coalesce(p.published_at,p.created_at),p.id)${operator}(SELECT coalesce(current_post.published_at,current_post.created_at),current_post.id FROM posts current_post WHERE current_post.id=$2) ${a.taxonomy?"AND EXISTS(SELECT 1 FROM post_terms current JOIN post_terms related ON related.term_id=current.term_id JOIN terms t ON t.id=current.term_id WHERE current.post_id=$2 AND related.post_id=p.id AND t.taxonomy=$3)":""} ORDER BY coalesce(p.published_at,p.created_at) ${order},p.id ${order} LIMIT 1`,a.taxonomy?[p.type,p.id,a.taxonomy==="post_tag"?"tag":"category"]:[p.type,p.id])).rows[0]);
    if(!next)return "";
    if(!state.options.preview)observePublicPost(state.options.canReadProtectedPost,next,false);
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
    const visited=new Set<number>(),byParent=new Map<number,any[]>(),roots:any[]=[];
    for(const comment of loop.comments){
      if(!state.settings.threadComments || !comment.parentId || !ids.has(comment.parentId))roots.push(comment);
      else {const siblings=byParent.get(comment.parentId) || [];siblings.push(comment);byParent.set(comment.parentId,siblings);}
    }
    // Historical depth must not become JavaScript call-stack depth. Keep the
    // source depth-limit flattening and sibling order with an explicit stack.
    const stack:Array<string|{comment:any;depth:number;actualDepth:number}>=roots.map(comment=>({comment,depth:0,actualDepth:1})).reverse(),out:string[]=[];
    while(stack.length){
      const next=stack.pop()!;
      if(typeof next==="string"){out.push(next);continue;}
      const {comment,depth,actualDepth}=next;if(visited.has(comment.id))continue;visited.add(comment.id);
      const rendered=await body({...context,comment,commentDepth:actualDepth,commentLoop:loop});
      if(state.nodes>MAX_RENDER_NODES)throw new HttpError(413,"The complete comment window exceeds the rendering node limit. Reduce comments per page or simplify the comment template.");
      out.push(`<li id="comment-${comment.id}" class="${comment.type || "comment"} ${depth%2?"odd":"even"}">${rendered}`);
      const nested=state.settings.threadComments?byParent.get(comment.id) || []:[],atLimit=depth>=state.settings.threadDepth-1;
      if(!nested.length || atLimit)out.push("</li>");
      else {out.push('<ol class="children">');stack.push("</ol></li>");}
      for(let i=nested.length-1;i>=0;i--)stack.push({comment:nested[i],depth:atLimit?depth:depth+1,actualDepth:actualDepth+1});
    }
    return `<ol${attributes()}>${out.join("")}</ol>`;
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
  if(name==="core/comment-content")return c?`<div${attributes()}>${cleanContent(renderedCommentContent(c.content,c.type))}</div>`:"";
  if(name==="core/comment-edit-link")return c && p && state.options.user && canEditPostComments(state.options.user,{authorId:Number(p.authorId ?? p.author_id),type:p.type,status:p.status,preTrashStatus:p.preTrashStatus ?? p.pre_trash_status})?`<div${attributes()}><a href="/admin/comments?commentId=${c.id}">Edit</a></div>`:"";
  if(name==="core/comment-reply-link") {
    if(!c || c.type && c.type!=="comment" || !p || p.locked || state.options.preview || !commentsOpen(p,state.settings) || !state.settings.threadComments || context.commentDepth===undefined || context.commentDepth>=state.settings.threadDepth)return "";
    const current=commentReturnPath(state.options.requestPath,state.options.query),id=int(c.id,0);
    if(state.settings.commentRegistration && !state.options.user)return `<div${attributes()}><a rel="nofollow" class="comment-reply-login" href="${esc(commentLoginHref(current))}">Log in to Reply</a></div>`;
    const label="Reply to "+c.authorName;
    return `<div${attributes()}><a rel="nofollow" class="comment-reply-link" href="${esc(commentReturnPath(state.options.requestPath,state.options.query,id))}" data-commentid="${id}" data-postid="${p.id}" data-belowelement="comment-${id}" data-respondelement="respond" data-replyto="${esc(label)}" aria-label="${esc(label)}" data-comment-reply="${id}" data-comment-author="${esc(c.authorName)}">Reply</a></div>`;
  }
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
    if(!p?.id || p.locked || !commentsOpen(p,state.settings))return "";
    const user=state.options.user;
    if(state.settings.commentRegistration && !user)return `<div${attributes()} id="respond"><p>You must be <a href="${esc(commentLoginHref(commentReturnPath(state.options.requestPath,state.options.query)))}">logged in</a> to post a comment.</p></div>`;
    const required=state.settings.requireCommentNameEmail?" required":"";
    const replyParent=publicReplyParent(p.id,state.options.query?.replytocom ?? (()=>{try{return new URL(state.options.requestPath || "/","https://worldact.invalid").searchParams.get("replytocom");}catch{return null;}})(),(await comments(context,state)).comments,state.settings);
    const akismet=await cached(state,"akismet-processing-disclosure",async()=>Boolean((await state.db.query("SELECT 1 FROM extensions WHERE slug='akismet' AND enabled AND settings @> '{\"sendComments\":true}'::jsonb")).rowCount));
    const privacy=akismet?'<p class="akismet_comment_form_privacy_notice">This site uses Akismet to reduce spam. <a href="https://akismet.com/privacy/" target="_blank" rel="noopener noreferrer">Learn how your comment data is processed.</a></p>':"";
    return `<div${attributes()} id="respond"><h3 id="reply-title" class="comment-reply-title">Leave a Reply</h3><p class="worldact-native-comment-notice" role="status"></p><form class="worldact-native-comment-form comment-form" action="/wp-comments-post.php" method="post"><input type="hidden" name="postId" value="${p.id}"><input type="hidden" name="parentId" value="${replyParent?.id || ""}"><input type="hidden" name="redirect_to" value="${esc(commentReturnPath(state.options.requestPath,state.options.query))}"><p class="comment-form-comment"><label for="comment-text-${p.id}">Comment${state.settings.requireCommentNameEmail?" *":""}</label><textarea id="comment-text-${p.id}" name="content" rows="8" maxlength="20000" required></textarea></p>${user?`<p>Logged in as <a href="/admin/profile">${esc(user.displayName)}</a>.</p>`:`<p class="comment-notes">Your email address will not be published.</p><p class="comment-form-author"><label for="author-${p.id}">Name${required?" *":""}</label><input id="author-${p.id}" name="authorName" maxlength="160" autocomplete="name"${required}></p><p class="comment-form-email"><label for="email-${p.id}">Email${required?" *":""}</label><input id="email-${p.id}" name="authorEmail" type="email" maxlength="254" autocomplete="email"${required}></p><p class="comment-form-url"><label for="url-${p.id}">Website</label><input id="url-${p.id}" name="authorUrl" type="url" maxlength="2000" autocomplete="url"></p>`}${!user && state.settings.commentCookieConsent?'<p class="comment-form-cookies-consent"><input id="comment-cookie-'+p.id+'" type="checkbox" name="rememberAuthor"><label for="comment-cookie-'+p.id+'">Save my name, email, and website in this browser for the next time I comment.</label></p>':""}<p class="form-submit"><button type="submit" class="submit wp-element-button">Post Comment</button></p>${privacy}</form></div>`;
  }
  if(name==="core/categories") {
    const taxonomy=a.taxonomy==="post_tag"?"tag":"category";
    const terms=await cached(state,`categories-block:${taxonomy}`,async()=>(await state.db.query("SELECT t.id,t.name,t.slug,t.parent_id AS \"parentId\",(SELECT count(*)::int FROM post_terms pt JOIN posts p ON p.id=pt.post_id WHERE pt.term_id=t.id AND p.status='publish') AS count FROM terms t WHERE taxonomy=$1 ORDER BY name,id LIMIT 1000",[taxonomy])).rows);
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
  if(name==="core/loginout") {
    const origin=new URL(process.env.APP_ORIGIN || "http://127.0.0.1:5173").origin;
    const current=new URL(normalizeLoginRedirect(state.options.requestPath,origin) || "/",origin);
    // The rendering API also carries public query variables separately from the path.
    for(const [key,value] of Object.entries(state.options.query || {}))
      if(!["postId","post_id","requestPath","type","preview","templateSlug","context","attributes"].includes(key) &&
        (typeof value==="string" || typeof value==="number")) current.searchParams.set(key,String(value));
    const currentPath=normalizeLoginRedirect(current.pathname+current.search+current.hash,origin) || "/";
    const redirectToCurrent=a.redirectToCurrent !== false;
    if(state.options.user)return `<div${attributes("logged-in")}><form method="post" action="/logout"><input type="hidden" name="redirect_to" value="${esc(redirectToCurrent?currentPath:"/")}"><button type="submit">Log out</button></form></div>`;
    if(!a.displayLoginAsForm)return `<div${attributes("logged-out")}><a href="/login${redirectToCurrent?"?redirect_to="+esc(encodeURIComponent(currentPath)):""}">Log in</a></div>`;
    // wp_login_form defaults to the current request URL regardless of the link toggle.
    const id="wp-loginout-"+state.nodes;
    return `<div${attributes("logged-out has-login-form")}><form id="${id}" class="loginform" method="post" action="/public-login"><p class="login-username"><label for="${id}-user">Username or Email Address</label><input type="text" name="log" id="${id}-user" class="input" value="" autocomplete="username" maxlength="254" required></p><p class="login-password"><label for="${id}-password">Password</label><input type="password" name="pwd" id="${id}-password" class="input" value="" autocomplete="current-password" maxlength="1024" required></p><p class="login-remember"><label for="${id}-remember"><input name="rememberme" type="checkbox" id="${id}-remember" value="forever"> Remember Me</label></p><p class="login-submit"><input type="submit" name="wp-submit" class="button button-primary wp-block-button__link wp-element-button" value="Log In"><input type="hidden" name="redirect_to" value="${esc(currentPath)}"></p></form></div>`;
  }
  return undefined;
}
