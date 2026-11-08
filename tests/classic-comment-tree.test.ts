import test from "./isolated-test.js";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { DOMParser } from "linkedom";
import { classicCommentTree, commentDisplayDepth, type ClassicCommentNode } from "../src/classicCommentTree.js";
import ClassicCommentThread from "../src/components/ClassicCommentThread.js";
import type { Comment } from "../src/api.js";
const comment=(id:number,parentId:number|null=null,extra:Partial<Comment>={}):Comment=>({id,parentId,authorName:"Visitor "+id,content:"<p>Body "+id+"</p>",status:"approved",postId:7,postTitle:"Thread",createdAt:"2026-01-01T00:00:00Z",...extra});
function walk<T>(roots:ClassicCommentNode<T>[]){const stack=[...roots].reverse(),out:ClassicCommentNode<T>[]=[];while(stack.length){const next=stack.pop()!;out.push(next);for(let i=next.children.length-1;i>=0;i--)stack.push(next.children[i])}return out;}

test("Classic thread order preserves supplied roots/chronological siblings and flattens at the configured source depth",()=>{
 const input=[comment(20),comment(10),comment(11,10),comment(21,20),comment(12,10),comment(22,21),comment(23,22),comment(24,23),comment(25,21)];
 const rendered=walk(classicCommentTree(input,true,3));assert.deepEqual(rendered.map(n=>n.comment.id),[20,21,22,23,24,25,10,11,12]);assert.deepEqual(rendered.map(n=>n.depth),[0,1,2,2,2,2,0,1,1]);
 assert.deepEqual(walk(classicCommentTree(input,false,3)).map(n=>[n.comment.id,n.depth]),input.map(c=>[c.id,0]));
 const malformed=[comment(1),comment(2,999),comment(3,4),comment(4,3),comment(1),comment(5,1)];assert.deepEqual(walk(classicCommentTree(malformed,true,5)).map(n=>n.comment.id),[1,5]);
 assert.equal(commentDisplayDepth(1),1);assert.equal(commentDisplayDepth(10),10);assert.equal(commentDisplayDepth(5000),10);
});

test("a complete 4000-record historical chain is visited once without recursive ancestry or omitted tails",()=>{
 const input=Array.from({length:4000},(_,i)=>comment(i+1,i?i:null));
 for(const depth of [1,5,10]){const result=walk(classicCommentTree(input,true,depth));assert.equal(result.length,4000);assert.equal(new Set(result.map(n=>n.comment.id)).size,4000);assert.equal(result.at(-1)!.comment.id,4000);assert.ok(result.every(n=>n.depth<depth));}
});

test("Classic markup renders deep tails, IDs and notification privacy with bounded source indentation",()=>{
 const input=Array.from({length:2500},(_,i)=>comment(i+1,i?i:null,i===2499?{content:"<p>FINAL HISTORICAL TAIL</p>"}:{}));input[0].avatarUrl="/api/avatars/human-fixture";input[0].authorEmail="hidden-email@example.test";input.push(comment(3000,null,{type:"pingback",authorName:"Notification source",authorUrl:"https://source.example.test/item",avatarUrl:"/forbidden-ping-avatar",content:"<p>Ping body</p>"}));
 const replyHref=(id:number)=>`/?p=7&page=2&commentPage=2&replytocom=${id}#respond`;
 const html=renderToStaticMarkup(createElement(ClassicCommentThread,{comments:input,displayDate:()=>"January 1",threaded:true,maxDepth:3,canReply:true,onReply:()=>{},replyHref})),dom=new DOMParser().parseFromString(html,"text/html");
 assert.equal(dom.querySelectorAll("article.public-comment").length,2501);assert.equal(dom.querySelectorAll("#comment-2500").length,1);assert.match(html,/FINAL HISTORICAL TAIL/);assert.equal(dom.querySelectorAll(".public-comment-children .public-comment-children .public-comment-children").length,0);assert.equal(dom.querySelectorAll(".public-comment-reply").length,2);assert.equal(dom.querySelector("#comment-1 .comment-reply-link")!.getAttribute("aria-label"),"Reply to Visitor 1");assert.equal(dom.querySelector("#comment-1 .comment-reply-link")!.getAttribute("href"),replyHref(1));assert.match(html,/Pingback:/);assert.doesNotMatch(html,/hidden-email|forbidden-ping-avatar/);assert.equal(dom.querySelectorAll("img").length,1);assert.equal(dom.querySelector("#comment-3000 .public-comment-reply"),null);
 const flat=renderToStaticMarkup(createElement(ClassicCommentThread,{comments:input,displayDate:()=>"",threaded:false,maxDepth:3,canReply:true,onReply:()=>{},replyHref}));assert.doesNotMatch(flat,/public-comment-children|public-comment-reply/);assert.match(flat,/FINAL HISTORICAL TAIL/);
});

test("Classic registration links are real login navigation only at the same eligible human depths",()=>{
 const input=[comment(1),comment(2,1),comment(3,2),comment(4,null,{type:"pingback"})],loginHref="/login?redirect_to=%2F%3Fp%3D7%26page%3D2%23respond";
 const html=renderToStaticMarkup(createElement(ClassicCommentThread,{comments:input,displayDate:()=>"",threaded:true,maxDepth:3,canReply:true,onReply:()=>{},replyHref:id=>`/?p=7&replytocom=${id}#respond`,loginHref})),dom=new DOMParser().parseFromString(html,"text/html");
 assert.equal(dom.querySelectorAll(".comment-reply-login").length,2);assert.equal(dom.querySelectorAll(".comment-reply-link,[data-classic-comment-reply]").length,0);
 for(const link of dom.querySelectorAll(".comment-reply-login")){assert.equal(link.textContent,"Log in to Reply");assert.equal(link.getAttribute("href"),loginHref);assert.equal(link.getAttribute("rel"),"nofollow");}
 assert.equal(dom.querySelector("#comment-3 .public-comment-reply,#comment-4 .public-comment-reply"),null);
});
