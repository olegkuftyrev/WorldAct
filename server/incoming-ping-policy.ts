import type {getSettings} from './db.js';
import {pingEnvironment} from './outgoing-ping-settings.js';
export function pingsOpen(post:any,settings:Awaited<ReturnType<typeof getSettings>>,now=Date.now()){
 return post?.status==='publish'&&['post','page'].includes(post.type)&&!post.protected&&post.pingStatus==='open'&&
 !(post.type==='post'&&settings.closeCommentsDays>0&&post.publishedAt&&new Date(post.publishedAt).getTime()+settings.closeCommentsDays*86400000<now);
}
export function pingbackHeader(post:any,settings:Awaited<ReturnType<typeof getSettings>>){
 return pingEnvironment()==='production'&&pingsOpen({...post,protected:post.hasPassword??post.protected},settings)?new URL('/xmlrpc.php',settings.siteUrl).href:null;
}
