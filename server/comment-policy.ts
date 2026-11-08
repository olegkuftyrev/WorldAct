import {autop} from "@wordpress/autop";
import {normalizePublicURL} from "./public-http.js";
import {HttpError,cleanContent} from "./utils.js";
import type pg from 'pg';
import {pool,getSettings} from './db.js';
import {plainText} from './utils.js';
import {classifySpam} from './design.js';
export type CommentType='comment'|'pingback'|'trackback';
export function matchesCommentKeywords(keys:string,fields:string[]){
 const normalized=fields.map(field=>field.toLowerCase());
 return keys.split(/\r?\n/).map(key=>key.trim().toLowerCase()).filter(Boolean).some(key=>normalized.some(field=>field.includes(key)));
}
/** Shared pre-Akismet policy; a claimed ping identity never inherits human approval. */
export async function moderateComment(input:{type:CommentType;authorName:string;authorEmail:string;authorUrl:string;content:string;rawContent?:string;ip:string},db:Pick<pg.Pool,'query'>|pg.PoolClient=pool,settings?:Awaited<ReturnType<typeof getSettings>>){
 settings??=await getSettings(db);
 const fields=[input.authorName,input.authorEmail,input.authorUrl,input.rawContent??input.content,input.content,plainText(input.content),input.ip];
 const anchors=(input.content.match(/<a\b[^>]*\bhref\s*=/gi)||[]).length;
 const bare=(input.content.replace(/<a\b[^>]*>[\s\S]*?<\/a>/gi,' ').match(/https?:\/\//gi)||[]).length;
 const previous=settings.commentPreviouslyApproved && input.type==='comment' && input.authorEmail
  ? !!(await db.query("SELECT 1 FROM comments WHERE type='comment' AND lower(author_email)=$1 AND status='approved' LIMIT 1",[input.authorEmail])).rowCount:false;
 return matchesCommentKeywords(settings.disallowedCommentKeys,fields)?'trash':await classifySpam(input.content)?'spam':
  settings.commentModeration || matchesCommentKeywords(settings.commentModerationKeys,fields) ||
  (settings.commentMaxLinks>0 && anchors+bare>=settings.commentMaxLinks) || (settings.commentPreviouslyApproved && !previous)?'pending':'approved';
}

export function normalizePingSource(value:string){try{const url=normalizePublicURL(value);if(url.href.length>2000)throw new Error();return url.href;}catch{throw new HttpError(400,"Use an absolute HTTP or HTTPS ping source URL.");}}

/** Source stores ping text, then paragraph-formats it for display. Human behavior stays unchanged. */
export function renderedCommentContent(content:string,type?:string){return type && type!=="comment"?cleanContent(autop(content)):content;}
