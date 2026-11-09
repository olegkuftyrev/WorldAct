import test from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { parseHTML } from "linkedom";
import { PublicDocumentView } from "../src/public/PublicDocumentView.js";
import { publicArchivePageLocation, publicArchiveSearchPath } from "../src/publicArchiveLinks.js";
import { normalizePublicQuery } from "../shared/public-routing.js";
import type { PublicArchive, PublicDocumentModel } from "../shared/public-document.js";

const settings = {siteTitle:"Archive fixture",permalinkStructure:"/journal/%postname%/",theme:"classic" as const};
const author: Extract<PublicArchive,{type:"author"}> = {type:"author",name:"Resolved Public Writer",authorId:7,slug:"public-writer",permalink:"/journal/author/public-writer/",page:2};
const path = "/journal/author/public-writer/page/2/?query-4-page=3&commentPage=2";

test("pretty author main paging replaces the suffix and preserves independent visible counters",()=>{
  const next = new URL(publicArchivePageLocation(path,author,settings,3),"https://worldact.invalid");
  assert.equal(next.pathname,"/journal/author/public-writer/page/3/");
  assert.equal(next.searchParams.get("query-4-page"),"3");
  assert.equal(next.searchParams.get("commentPage"),"2");
  assert.equal(next.searchParams.has("page"),false);
  assert.equal(next.searchParams.has("author"),false);
  const first = new URL(publicArchivePageLocation(path+"&page=2",author,settings,1),"https://worldact.invalid");
  assert.equal(first.pathname,author.permalink);
  assert.equal(first.searchParams.has("page"),false);
  assert.equal(first.searchParams.get("query-4-page"),"3");
});

test("slashless author paths and explicit visible identity retain their own URL policy",()=>{
  const archive={...author,permalink:"/journal/author/public-writer"};
  const target=new URL(publicArchivePageLocation("/journal/author/public-writer/page/2?author=7&commentPage=2",archive,{...settings,permalinkStructure:"/journal/%postname%"},3),"https://worldact.invalid");
  assert.equal(target.pathname,"/journal/author/public-writer/page/3");
  assert.equal(target.searchParams.get("author"),"7");
  assert.equal(target.searchParams.get("commentPage"),"2");
  assert.equal(target.searchParams.has("page"),false);
});

test("numeric aliases, Plain and ordinary archives retain query pagination",()=>{
  for(const [current,archive,configuration] of [
    ["/?author=7&page=2&query-4-page=3",author,settings],
    ["/?author=7&page=2&query-4-page=3",{...author,permalink:"/?author=7"},{...settings,permalinkStructure:""}],
    ["/category/news/?page=2&query-4-page=3",{taxonomy:"category",slug:"news"},settings],
  ] as const){
    const target=new URL(publicArchivePageLocation(current,archive,configuration,3),"https://worldact.invalid");
    assert.equal(target.pathname,new URL(current,"https://worldact.invalid").pathname);
    assert.equal(target.searchParams.get("page"),"3");
    assert.equal(target.searchParams.get("query-4-page"),"3");
  }
});

test("search resets only a recognized pretty author archive to its canonical base",()=>{
  assert.equal(publicArchiveSearchPath(path,author,settings),author.permalink);
  assert.equal(publicArchiveSearchPath("/?author=7&page=2",author,settings),"/");
  assert.equal(publicArchiveSearchPath("/category/news/?page=2",{taxonomy:"category",slug:"news"},settings),"/category/news/");
  // Keep the source's query-context normalization result: the resolved archive
  // permalink may differ from the visible raw nicename spelling.
  assert.equal(publicArchiveSearchPath("/journal/author/public--writer/page/2/",author,settings),author.permalink);
});

function model(requestPath:string):PublicDocumentModel {
  const query=normalizePublicQuery(new URL(requestPath,"https://worldact.invalid").searchParams,{singular:false,archive:author});
  return {schema:1,requestPath,status:200,viewer:null,post:null,comments:[],commentsPagination:null,
    route:{kind:"archive",detail:false,archive:author,query},
    site:{settings,archive:author,posts:[],pages:[],frontPage:null,postsPage:null,pagination:{page:2,totalPosts:6,totalPages:3}},
    design:{styles:{},templates:[],parts:[],menus:[],plugins:[]},presentation:{kind:"classic",slots:{}},
    head:{title:"Archive fixture",robots:null,canonical:null,seo:null,icons:[],tileImage:null},
    controls:{commentsOpen:false,replyParentId:0,replyParentName:null,commentReturnPath:requestPath,loginHref:"/login",sensitive:false,dates:{}}};
}

test("Classic SSR uses normalized author identity with native pretty paging and search context",()=>{
  const fixture=model(path),html=renderToStaticMarkup(createElement(PublicDocumentView,{model:fixture})),{document}=parseHTML(html);
  assert.equal(document.querySelector("h1.blog-heading")?.textContent,"Author: Resolved Public Writer");
  assert.equal([...document.querySelectorAll("a")].find(a=>a.textContent==="Show all posts")?.getAttribute("href"),"/");
  const form=document.querySelector('form[role="search"]')!;
  assert.equal(form.getAttribute("action"),author.permalink);
  assert.equal(form.getAttribute("method"),"get");
  assert.equal(form.querySelector('input[name="author"]'),null);
  assert.equal(form.querySelector('input[name="page"]'),null);
  assert.equal(form.querySelector('input[name="query-4-page"]')?.getAttribute("value"),"3");
  assert.equal(form.querySelector('input[name="commentPage"]')?.getAttribute("value"),"2");
  const links=[...document.querySelectorAll('nav[aria-label="Posts pagination"] a')].map(a=>new URL(a.getAttribute("href")!,"https://worldact.invalid"));
  assert.deepEqual(links.map(a=>a.pathname),[author.permalink,"/journal/author/public-writer/page/3/"]);
  for(const link of links){assert.equal(link.searchParams.get("query-4-page"),"3");assert.equal(link.searchParams.get("commentPage"),"2");assert.equal(link.searchParams.has("author"),false);assert.equal(link.searchParams.has("page"),false);}
});

test("Classic SSR numeric alias keeps its actual author field and query page links",()=>{
  const fixture=model("/?author=7&page=2&commentPage=2"),{document}=parseHTML(renderToStaticMarkup(createElement(PublicDocumentView,{model:fixture})));
  assert.equal(document.querySelector("h1.blog-heading")?.textContent,"Author: Resolved Public Writer");
  assert.equal(document.querySelector('form[role="search"]')?.getAttribute("action"),"/");
  assert.equal(document.querySelector('input[name="author"]')?.getAttribute("value"),"7");
  const next=new URL([...document.querySelectorAll('nav[aria-label="Posts pagination"] a')].at(-1)!.getAttribute("href")!,"https://worldact.invalid");
  assert.equal(next.pathname,"/");assert.equal(next.searchParams.get("author"),"7");assert.equal(next.searchParams.get("page"),"3");assert.equal(next.searchParams.get("commentPage"),"2");
});
