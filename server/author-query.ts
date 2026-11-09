import {pool,getSettings} from "./db.js";
import {readPublicPath} from "./public-path.js";
import {HttpError} from "./utils.js";
import {normalizeAuthorArchiveSlug,authorArchivePath} from "../shared/author-archive.js";
import {readNamedAuthorInput,normalizePublicQuery,PublicQueryError} from "../shared/public-routing.js";
import type {NamedAuthorSelection,PublicArchive,PublicRoute} from "../shared/public-document.js";
import {parseDateArchiveQuery,dateArchiveDTO,appendPostDateArchiveSQL} from "./date-archives.js";
export type PublicListingContext={kind:PublicRoute["kind"];archive:PublicArchive|null;namedAuthor?:NamedAuthorSelection};
export type NamedAuthorPin={value?:NamedAuthorSelection};
type Database=Pick<typeof pool,"query">;
type Settings=Awaited<ReturnType<typeof getSettings>>;
type Resolution={status:200|404;kind:PublicRoute["kind"]|"framework";archive?:PublicArchive|null;selectedId?:number;listing?:PublicListingContext};
export function normalizeListingQuery(query:URLSearchParams,options:Parameters<typeof normalizePublicQuery>[1]){try{return normalizePublicQuery(query,options);}catch(error){if(error instanceof PublicQueryError)throw new HttpError(400,error.message);throw error;}}
export function namedAuthorInput(query:URLSearchParams){try{return readNamedAuthorInput(query);}catch(error){if(error instanceof PublicQueryError)throw new HttpError(400,error.message);throw error;}}
/** Inspect decoded keys from the same validated path parser as documents. */
export function hasNamedAuthorQuery(values:Record<string,unknown>,path?:string){
  return Object.keys(values).some(key=>/^author_name(?:\[|$)/.test(key)) || Boolean(path&&[...readPublicPath(path).query.keys()].some(key=>/^author_name(?:\[|$)/.test(key)));
}
/** Express objects are validated before flattening; visible path values and
 * explicit transport values must agree, including the original numeric filter. */
export function listingRequestPath(path:string|undefined,values:Record<string,unknown>):string{
  const visible=path || "/",i=visible.indexOf("?"),pathname=i<0?visible:visible.slice(0,i),query=new URLSearchParams(i<0?"":visible.slice(i+1));
  if(visible.length>2000)throw new HttpError(414,"The URL exceeds the supported length.");
  try{decodeURIComponent(visible);}catch{throw new HttpError(400,"The URL path is malformed.");}
  for(const [key,value]of Object.entries(values)){
    const base=key.split("[")[0];
    if(!/^(?:author_name|author|page|search|s|category|tag|year|month|monthnum|day|m|w|commentPage|replytocom|query-\d+-page)$/.test(base))continue;
    if(typeof value!=="string"&&typeof value!=="number")throw new HttpError(400,"Use scalar public listing query values.");
    const text=String(value);if(text.length>2000)throw new HttpError(400,"The public listing query exceeds its supported length.");
    if(query.has(key)&&(query.getAll(key).length!==1||query.get(key)!==text))throw new HttpError(400,"The public listing inputs conflict.");
    if(!query.has(key))query.set(key,text);
  }
  namedAuthorInput(query);
  return pathname+(query.size?"?"+query:"");
}
/** Pure SQL predicates; only a server-resolved selection may enter here. */
export function appendNamedAuthorSQL(where:string[],args:unknown[],selection:NamedAuthorSelection){
  if(selection.numericAuthor){args.push(selection.numericAuthor);where.push(`p.author_id=$${args.length}`);}
  if(!selection.selected)where.push("FALSE");
  else{args.push(selection.selected.authorId);where.push(`p.author_id=$${args.length}`);}
}
export function publicListingWhere(values:Record<string,unknown>,settings:Settings,namedAuthor?:NamedAuthorSelection,authenticated=false){
  const args:unknown[]=[],where=["p.type='post'","p.status='publish'"];
  if(namedAuthor)appendNamedAuthorSQL(where,args,namedAuthor);
  else if(values.author!==undefined&&values.author!==""){const raw=String(values.author);if(!/^[1-9]\d{0,9}$/.test(raw)||Number(raw)>2147483647)throw new HttpError(400,"Use a valid author.");args.push(Number(raw));where.push(`p.author_id=$${args.length}`);}
  const search=String(values.search || values.s || "").trim();if(search.length>200)throw new HttpError(400,"Search exceeds the supported length.");
  if(search){args.push(`%${search}%`);where.push(`(p.title ILIKE $${args.length} OR p.content ILIKE $${args.length} OR p.excerpt ILIKE $${args.length})`);if(!authenticated)where.push("p.password_hash IS NULL");}
  for(const taxonomy of ["category","tag"] as const)if(values[taxonomy]){const slug=String(values[taxonomy]);if(slug.length>220)throw new HttpError(400,"The taxonomy slug exceeds its supported length.");args.push(slug);where.push(`EXISTS(SELECT 1 FROM post_terms pt JOIN terms t ON t.id=pt.term_id WHERE pt.post_id=p.id AND t.taxonomy='${taxonomy}' AND t.slug=$${args.length})`);}
  const date=parseDateArchiveQuery(values);appendPostDateArchiveSQL(where,args,"p.post_date::timestamp without time zone",date,settings.timezone,settings.weekStartsOn);
  return {where,args,search,date};
}
export function listingFilterValues(input:Record<string,unknown>,archive:PublicArchive|null){
  const values={...input};
  if(archive&&"taxonomy" in archive)values[archive.taxonomy]=archive.slug;
  if(archive&&"type" in archive&&archive.type==="date"){
    delete values.m;delete values.month;values.year=String(archive.year);
    for(const [key,value]of [["monthnum",archive.month],["day",archive.day],["w",archive.week]] as const)if(value===undefined)delete values[key];else values[key]=String(value);
  }
  return values;
}
export async function resolveNamedAuthor(query:URLSearchParams,settings:Settings,db:Database=pool,pin:NamedAuthorPin={}):Promise<NamedAuthorSelection|undefined>{
  const input=namedAuthorInput(query);if(!input)return undefined;
  if(pin.value)return pin.value;
  const parts=input.name.split("/"),component=parts.at(-1)||parts.at(-2)||"",slug=normalizeAuthorArchiveSlug(component);
  const person=slug?(await db.query("SELECT id,nicename,display_name AS name FROM users WHERE nicename=$1",[slug])).rows[0]:null;
  return pin.value={selected:person?{type:"author",authorId:person.id,slug:person.nicename,name:person.name,permalink:authorArchivePath(person,settings)}:null,...(input.numericAuthor?{numericAuthor:input.numericAuthor}:{})};
}
async function validateNamedIdentity(selection:NamedAuthorSelection,db:Database){
  const selected=selection.selected;if(!selected)return;
  const readonly=(await db.query("SHOW transaction_read_only")).rows[0].transaction_read_only==="on";
  try{if(!(await db.query("SELECT id FROM users WHERE id=$1 AND nicename=$2"+(readonly?"":" FOR SHARE NOWAIT"),[selected.authorId,selected.slug])).rowCount)throw new HttpError(404,"The selected named author identity retired.");}
  catch(error){if(["55P03","40001"].includes((error as {code:string}).code))throw new HttpError(409,"The named author changed while it was read.");throw error;}
}
/** Metadata/count only. The current route identity precedes a listing selector. */
export async function applyNamedAuthorListing<T extends Resolution>(path:string,base:T,query:URLSearchParams,settings:Settings,db:Database=pool,pin:NamedAuthorPin={},authenticated=false):Promise<T & {listing?:PublicListingContext}>{
  const input=namedAuthorInput(query);
  if(!input||base.kind==="framework"||base.kind==="singular"||base.kind==="front-page"||base.status===404)return base;
  const selection=await resolveNamedAuthor(query,settings,db,pin);if(!selection)return base;
  if(base.archive&&"type" in base.archive&&base.archive.type==="author"&&(!selection.selected||base.archive.authorId!==selection.selected.authorId||base.archive.slug!==selection.selected.slug))throw new HttpError(400,"The author archive identities conflict.");
  const values=normalizeListingQuery(query,{singular:false,archive:base.archive,namedAuthor:selection}).values;
  const rawPage=base.archive&&"type" in base.archive&&base.archive.type==="author"&&base.archive.page?String(base.archive.page):query.get("page")||"1";
  if(!/^[1-9]\d{0,9}$/.test(rawPage)||Number(rawPage)>2147483647||query.getAll("page").length>1||[...query.keys()].some(key=>/^page\[/.test(key)))throw new HttpError(400,"Use a single valid archive page.");
  let matchedTaxonomy:PublicArchive|null=base.archive&&"taxonomy" in base.archive?base.archive:null;
  for(const taxonomy of ["category","tag"] as const)if(values[taxonomy]){const row=(await db.query("SELECT taxonomy,slug,name FROM terms WHERE taxonomy=$1 AND slug=$2",[taxonomy,values[taxonomy]])).rows[0];if(row)matchedTaxonomy ||= row;}
  const predicate=publicListingWhere(values,settings,selection,authenticated),count=Number((await db.query(`SELECT count(*)::int AS n FROM posts p WHERE ${predicate.where.join(" AND ")}`,predicate.args)).rows[0].n),page=Number(rawPage);
  const archive=base.archive || (base.kind==="posts-page"?null:matchedTaxonomy || (predicate.date?dateArchiveDTO(predicate.date):selection.selected));
  const listing:PublicListingContext={kind:base.kind as PublicRoute["kind"],archive,namedAuthor:selection};
  const missing=page>1&&(page-1)*settings.postsPerPage>=count || !selection.selected&&!predicate.search&&!matchedTaxonomy&&base.kind!=="posts-page";
  await validateNamedIdentity(selection,db);
  return {...base,...(missing?{status:404 as const,kind:"not-found" as const}:{}),archive,...(!missing&&archive&&"type" in archive&&archive.type==="author"&&page>1?{archive:{...archive,page}}:{}),listing};
}
