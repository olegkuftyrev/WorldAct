import test from "./isolated-test.js";
import assert from "node:assert/strict";
import {createElement} from "react";
import {renderToStaticMarkup} from "react-dom/server";
import {parseHTML} from "linkedom";
import type {NamedAuthorSelection,PublicArchive,PublicDocumentModel,PublicPost} from "../shared/public-document.js";
import {normalizePublicQuery} from "../shared/public-routing.js";
import {PublicDocumentView} from "../src/public/PublicDocumentView.js";
import {hasNamedAuthorParameter,shouldResolveNamedAuthorQuery,legacyPublicAuthorQuery,isNamedAuthorListing} from "../src/publicAuthorQuery.js";
import {shouldResolveStaticFrontPage} from "../src/plainPermalinkRouting.js";
import {publicArchivePageLocation,publicArchiveSearchPath} from "../src/publicArchiveLinks.js";

const settings={siteTitle:"Named listing fixture",theme:"classic" as const,permalinkStructure:"/journal/%postname%/"};
const author:NonNullable<NamedAuthorSelection["selected"]>={type:"author",name:"Selected Writer",authorId:7,slug:"selected-writer",permalink:"/journal/author/selected-writer/"};
function model(path:string,archive:PublicArchive|null,namedAuthor:NamedAuthorSelection,kind:PublicDocumentModel["route"]["kind"]="archive"):PublicDocumentModel{
 const query=normalizePublicQuery(new URL(path,"https://worldact.invalid").searchParams,{singular:false,archive,namedAuthor});
 return{schema:1,requestPath:path,status:200,viewer:null,post:null,comments:[],commentsPagination:null,
  route:{kind,detail:false,archive,query},site:{settings,archive,posts:[],pages:[],frontPage:null,postsPage:kind==="posts-page"?{title:"Journal listing"} as PublicPost:null,pagination:{page:2,totalPosts:6,totalPages:3}},
  design:{styles:{},templates:[],parts:[],menus:[],plugins:[]},presentation:{kind:"classic",slots:{}},head:{title:"Named listing",robots:null,canonical:null,seo:null,icons:[],tileImage:null},
  controls:{commentsOpen:false,replyParentId:0,replyParentName:null,commentReturnPath:path,loginHref:"/login",sensitive:false,dates:{}}};
}
const render=(fixture:PublicDocumentModel)=>parseHTML(renderToStaticMarkup(createElement(PublicDocumentView,{model:fixture}))).document;

test("named root paging and native search retain raw name, original numeric intersection and independent counters",()=>{
 const path="/?author=4&author_name=x%2FSelected.Writer%2F&page=2&query-4-page=3&commentPage=2",fixture=model(path,author,{selected:author,numericAuthor:4}),document=render(fixture);
 assert.equal(document.querySelector("h1.blog-heading")?.textContent,"Author: Selected Writer");
 const form=document.querySelector('form[role="search"]')!;assert.equal(form.getAttribute("action"),"/");assert.equal(form.querySelector('input[name="author"]')?.getAttribute("value"),"4");assert.equal(form.querySelector('input[name="author_name"]')?.getAttribute("value"),"x/Selected.Writer/");assert.equal(form.querySelector('input[name="page"]'),null);
 for(const link of document.querySelectorAll('nav[aria-label="Posts pagination"] a')){const next=new URL(link.getAttribute("href")!,"https://worldact.invalid");assert.equal(next.pathname,"/");assert.equal(next.searchParams.get("author"),"4");assert.equal(next.searchParams.get("author_name"),"x/Selected.Writer/");assert.equal(next.searchParams.get("query-4-page"),"3");assert.equal(next.searchParams.get("commentPage"),"2");}
 assert.equal(publicArchiveSearchPath(path,author,settings),"/");assert.equal(new URL(publicArchivePageLocation(path,author,settings,3),"https://worldact.invalid").searchParams.get("page"),"3");
});

test("a known empty named author remains an archive without rendering a configured front page",()=>{
 const fixture=model("/?author_name=selected-writer",author,{selected:author});fixture.site.settings={...settings,frontPageMode:"page",frontPageId:90};fixture.site.frontPage={title:"STATIC FRONT MUST NOT REPLACE NAMED LISTING"} as PublicPost;fixture.site.pagination={page:1,totalPosts:0,totalPages:0};const document=render(fixture);
 assert.equal(document.querySelector("h1.blog-heading")?.textContent,"Author: Selected Writer");assert.match(document.querySelector(".public-site")?.textContent||"",/No posts yet/);assert.doesNotMatch(document.querySelector(".public-site")?.textContent||"",/STATIC FRONT/);assert.equal([...document.querySelectorAll("a")].find(a=>a.textContent==="Show all posts")?.getAttribute("href"),"/");
});

test("safe-empty unknown name with search keeps search identity and visible filters instead of not-found",()=>{
 const fixture=model("/?author=4&author_name=missing&search=needle",null,{selected:null,numericAuthor:4});fixture.site.pagination={page:1,totalPosts:0,totalPages:0};const document=render(fixture);
 assert.equal(document.querySelector("h1.blog-heading")?.textContent,"Search results for: needle");assert.equal(document.querySelector(".public-not-found"),null);assert.equal(document.querySelector('input[name="author"]')?.getAttribute("value"),"4");assert.equal(document.querySelector('input[name="author_name"]')?.getAttribute("value"),"missing");assert.match(document.querySelector(".public-site")?.textContent||"",/No posts yet/);
});

test("named filters keep a resolved date archive heading rather than replacing it with presentation author",()=>{
 const date:PublicArchive={type:"date",year:2026,month:11,name:"November 2026",permalink:"/2026/11/"};const document=render(model("/2026/11/?author_name=selected-writer",date,{selected:author}));assert.equal(document.querySelector("h1.blog-heading")?.textContent,"November 2026");
});

test("named filters keep posts-page title and expose Show all even for selected-null safe empty",()=>{
 for(const selected of[author,null]){const document=render(model("/journal/?author_name=missing",null,{selected},"posts-page"));assert.equal(document.querySelector("h1.blog-heading")?.textContent,"Journal listing");assert.equal([...document.querySelectorAll("a")].find(a=>a.textContent==="Show all posts")?.getAttribute("href"),"/");}
});

test("named filter on a taxonomy keeps taxonomy title while search retains its existing priority",()=>{
 const archive:PublicArchive={taxonomy:"category",slug:"news",name:"News archive"};const fixture=model("/category/news/?author_name=selected-writer",archive,{selected:author});assert.equal(render(fixture).querySelector("h1.blog-heading")?.textContent,"Category: News archive");fixture.route.query.search="needle";assert.equal(render(fixture).querySelector("h1.blog-heading")?.textContent,"Search results for: needle");
});


test("decoded recognized name keys resolve before flattening, including malformed nested and duplicate keys",()=>{
 for(const text of["author_name=writer","%61uthor_name=writer","author_name=%20","author_name=one&%61uthor_name=two","author_name=&author_name=","author_name%5B%5D=writer","%61uthor_name%5Bx%5D="]){const query=new URLSearchParams(text);assert.equal(hasNamedAuthorParameter(query),true,text);assert.equal(shouldResolveNamedAuthorQuery(query),true,text);}
 for(const text of["","author_name=","author_name_extra=writer","author_name.fake=writer"]){assert.equal(shouldResolveNamedAuthorQuery(new URLSearchParams(text)),false,text);}
});

test("legacy transport preserves original decoded name and numeric intersection rather than resolved identity",()=>{
 const raw=new URLSearchParams("%61uthor=4&%61uthor_name=x%2FSelected.Writer%2F&query-4-page=3&commentPage=2"),transport=legacyPublicAuthorQuery(raw,author);
 assert.equal(transport.get("author"),"4");assert.equal(transport.get("author_name"),"x/Selected.Writer/");assert.equal(transport.has("namedAuthor"),false);assert.equal(transport.has("selected"),false);assert.equal(transport.get("author"),raw.get("author"));
 assert.equal(legacyPublicAuthorQuery(new URLSearchParams(),author).get("author"),"7");
});

test("malformed recognized legacy name/numeric fields and exact-empty name reach server unchanged",()=>{
 for(const input of["author=4&author_name=a&%61uthor_name=b","author_name%5B%5D=a&author%5B%5D=4","author_name=&author=bad","author_name=&author_name=","author_name=writer&author=4&author=7"]){const query=new URLSearchParams(input);assert.deepEqual([...legacyPublicAuthorQuery(query,author)],[...query],input);}
 const query=new URLSearchParams("author_name=");assert.equal(hasNamedAuthorParameter(query),true);assert.equal(shouldResolveNamedAuthorQuery(query),false);assert.equal(legacyPublicAuthorQuery(query,author).has("author_name"),true);assert.equal(legacyPublicAuthorQuery(query,author).has("author"),false);
});

test("minimal selected-null descriptor denotes a safe-empty listing while no descriptor remains unresolved",()=>{
 assert.equal(isNamedAuthorListing({archive:null,namedAuthor:{selected:null,numericAuthor:4}}),true);assert.equal(isNamedAuthorListing({archive:null,namedAuthor:{selected:null},kind:"posts-page"}),true);assert.equal(isNamedAuthorListing({archive:author,namedAuthor:{selected:author}}),true);assert.equal(isNamedAuthorListing({archive:null}),false);assert.equal(isNamedAuthorListing(null),false);
});

test("named query does not restore a static front page; exactly-empty name retains absent behavior",()=>{
 const site={settings:{frontPageMode:"page" as const,frontPageId:90},frontPage:null};
 assert.equal(shouldResolveStaticFrontPage("/",new URLSearchParams("%61uthor_name=writer"),site),false);assert.equal(shouldResolveStaticFrontPage("/",new URLSearchParams("author_name=%20"),site),false);assert.equal(shouldResolveStaticFrontPage("/",new URLSearchParams("author_name="),site),true);
});
