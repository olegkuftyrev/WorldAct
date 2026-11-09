import moment from "moment-timezone";
import { HttpError } from "./utils.js";
import { civilFromInstant as rawCivilFromInstant,parsePostCivil,postCivilInstant as rawPostCivilInstant } from "../shared/post-civil-date.js";
export {parsePostCivil,formatPostCivil,postCivilZoned} from "../shared/post-civil-date.js";
export function civilFromInstant(value:string|Date,timezone:string){try{return rawCivilFromInstant(value,timezone);}catch(error){throw new HttpError(400,(error as Error).message);}}
export function postCivilInstant(value:string,timezone:string){try{return rawPostCivilInstant(value,timezone);}catch(error){throw new HttpError(400,(error as Error).message);}}
/** Existing instant ordering and due-time semantics remain independent. */
export const POST_DATE_SQL = "COALESCE(CASE WHEN p.status='future' THEN p.scheduled_at END,p.published_at,p.created_at)";
export function postCivilSQL(alias="p"){if(!/^[a-z_][a-z0-9_]*$/i.test(alias))throw new Error("Invalid SQL alias.");return `${alias}.post_date::timestamp without time zone`;}
export function publicationPair(civil:unknown,gmt:unknown){
 if(!parsePostCivil(civil))throw new HttpError(400,"Use a real publication civil date in YYYY-MM-DDTHH:mm:ss format (years 0001–9999).");
 if(gmt!==null && (!(gmt instanceof Date) && (typeof gmt!=="string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:?\d{2})$/i.test(gmt))))throw new HttpError(400,"The selected publication GMT requires a UTC offset or null.");
 const date=gmt===null?null:moment(gmt as string,moment.ISO_8601,true);
 if(date && (!date.isValid() || !/^\d{4}-/.test(date.toISOString()) || date.toDate().getUTCFullYear()<1))throw new HttpError(400,"The selected publication GMT is invalid or outside years 0001–9999.");
 return {postDate:civil as string,postDateGmt:gmt===null?null:new Date(gmt as string).toISOString()};
}
export function resolvePostDate(input:Record<string,any>,existing:Record<string,any>|undefined,status:string,timezone:string,now:Date){
 const floating=["draft","pending","auto-draft"].includes(status);
 const old=existing?.postDate?publicationPair(existing.postDate,existing.postDateGmt ?? null):null;
 const reset=input.postDate===null || (status==="future"?input.scheduledAt===null:input.publishedAt===null) || input.restDate===null || input.restDateGmt===null;
 const current=()=>({postDate:civilFromInstant(now,timezone),postDateGmt:floating?null:now.toISOString()});
 if(reset)return current();
 // Nonfloating saved rows have a chosen civil date even when an imported GMT
 // is null. Keep that civil for the save-time publication policy to fix in its
 // late zone; a floating draft's unchanged date still refreshes from now.
 const keepUnfixedCivil=["publish","future"].includes(status) && ["publish","future","private"].includes(existing?.status);
 const unchanged=()=>old!.postDateGmt===null&&!floating&&!keepUnfixedCivil?current():old!;
 // REST resolution is deferred until after actor/hierarchy/post waits and uses
 // this one settings snapshot. A nonempty local input wins over GMT.
 let civil=input.postDate,restFraction=0;
 let instant=status==="future"?input.scheduledAt:input.publishedAt;
 if(input.restDate || input.restDateGmt){
  const local=input.restDate;
  if(local && !/(?:Z|[+-]\d{2}:?\d{2})$/i.test(local)){
    if(!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?$/.test(local))throw new HttpError(400,"Use an ISO publication date.");
    const fraction=/\.(\d{1,3})$/.exec(local);restFraction=fraction?Number("0."+fraction[1])*1000:0;
    civil=local.length===16?local+":00":local.slice(0,19);
  }
  else {const raw=local || input.restDateGmt;instant=/(?:Z|[+-]\d{2}:?\d{2})$/i.test(raw)?raw:raw+"Z";}
  if(old && (civil===old.postDate || instant && old.postDateGmt && new Date(instant).valueOf()===new Date(old.postDateGmt).valueOf()))return unchanged();
 }
 if(civil!==undefined){
  if(!parsePostCivil(civil))throw new HttpError(400,"Use a real publication civil date in YYYY-MM-DDTHH:mm:ss format (years 0001–9999).");
  if(old && civil===old.postDate)return unchanged();
  let gmt:string;try{gmt=postCivilInstant(civil,timezone);}catch(error){throw new HttpError(400,(error as Error).message);}
  if(civilFromInstant(gmt,timezone)!==civil)throw new HttpError(400,"This local time does not exist in the selected timezone. Choose another time.");
  if(restFraction)gmt=new Date(new Date(gmt).valueOf()+restFraction).toISOString();
  return publicationPair(civil,gmt);
 }
 if(instant!==undefined && instant!==null){
  if(old && (new Date(instant).valueOf()===new Date(existing?.[status==="future"?"scheduledAt":"publishedAt"]).valueOf() || old.postDateGmt && new Date(instant).valueOf()===new Date(old.postDateGmt).valueOf()))return unchanged();
  if(typeof instant!=="string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:?\d{2})$/i.test(instant))throw new HttpError(400,"The publication instant requires an explicit UTC offset.");
  const parsed=moment.parseZone(instant,moment.ISO_8601,true),date=parsed.toDate();if(!parsed.isValid() || !/^\d{4}-/.test(parsed.toISOString()) || date.getUTCFullYear()<1)throw new HttpError(400,"The publication date is invalid.");
  return publicationPair(civilFromInstant(date,timezone),date);
 }
 if(old && (old.postDateGmt!==null || floating===false && ["publish","private","future"].includes(existing!.status)))return old;
 return current();
}
