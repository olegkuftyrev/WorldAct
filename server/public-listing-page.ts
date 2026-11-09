import {pool,getSettings} from "./db.js";
import {readPublicPath} from "./public-path.js";
import {normalizeListingQuery,publicListingWhere,type PublicListingContext} from "./author-query.js";
import type {PublicDocumentResolution} from "./public-documents.js";

/** Only main page intent can require ordinary route classification. Do not
 * flatten malformed/duplicate counters into a different successful request. */
export function ordinaryListingPageRequested(values:Record<string,unknown>,path?:string){
  if(values.page!==undefined&&values.page!=="1"&&values.page!==1)return true;
  if(Object.keys(values).some(key=>/^page\[/.test(key)))return true;
  if(!path)return false;
  const query=readPublicPath(path).query;
  return [...query.keys()].some(key=>/^page(?:\[|$)/.test(key)&&
    (key!=="page"||query.getAll(key).length!==1||query.get(key)!=="1"));
}

/** A retained404 may acquire surroundings, never another main listing. */
export function missingPublicListing(base:PublicDocumentResolution):PublicDocumentResolution{
  return {status:404,kind:"not-found",...(base.archive?{archive:base.archive}:{}),
    listing:{kind:"not-found",archive:base.archive || null}};
}

/** Metadata only. Every new count uses the supplied database and the same
 * normalized predicate used by the site's main count and row selection. */
export async function applyOrdinaryListingPage(base:PublicDocumentResolution,query:URLSearchParams,
  settings:Awaited<ReturnType<typeof getSettings>>,db:Pick<typeof pool,"query">,authenticated=false):Promise<PublicDocumentResolution>{
  if(base.status===404)return missingPublicListing(base);
  if(base.listing?.namedAuthor||base.archive&&"type" in base.archive&&base.archive.type==="author"||!["home","archive","posts-page"].includes(base.kind))return base;
  const normalized=normalizeListingQuery(query,{singular:false,archive:base.archive});
  const listing:PublicListingContext={kind:base.kind as PublicListingContext["kind"],archive:base.archive || null};
  if(normalized.archivePage===1)return {...base,listing};
  const predicate=publicListingWhere(normalized.values,settings,undefined,authenticated);
  const count=Number((await db.query(`SELECT count(*)::int AS n FROM posts p WHERE ${predicate.where.join(" AND ")}`,predicate.args)).rows[0].n);
  if((normalized.archivePage-1)*settings.postsPerPage>=count)return missingPublicListing(base);
  return {...base,listing};
}
