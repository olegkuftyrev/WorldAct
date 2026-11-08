import moment from "moment-timezone";
import { date as phpDate, humanTimeDiff } from "@wordpress/date";

/** Normalize only supported fixed offsets; unknown named zones must not silently
 * fall back to the process clock or Moment's UTC default. */
export function publicationTimezone(value:string):string{
 if(typeof value!=="string")throw new Error("The publication timezone is invalid.");
 if(/^[+-]/.test(value)){
  const match=/^([+-])(\d{2})(?::?(\d{2}))?$/.exec(value);
  if(!match || Number(match[2])>23 || Number(match[3] ?? 0)>59)throw new Error("The publication timezone is invalid.");
  return `${match[1]}${match[2]}:${match[3] ?? "00"}`;
 }
 if(!moment.tz.zone(value))throw new Error("The publication timezone is invalid.");
 return value;
}
/** Publication civil text has no zone. Never feed it to host-local Date parsing. */
export function parsePostCivil(value: unknown): string | null {
  if(typeof value!=="string" || !/^(?!0000)\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d$/.test(value))return null;
  return moment.utc(value,"YYYY-MM-DDTHH:mm:ss",true).isValid()?value:null;
}
export function civilFromInstant(value: string | Date, timezone: string): string {
  if(!(value instanceof Date) && (typeof value!=="string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:?\d{2})$/i.test(value)))throw new Error("The publication instant requires an explicit UTC offset.");
  timezone=publicationTimezone(timezone);
  const date=moment(value,moment.ISO_8601,true);
  if(!date.isValid())throw new Error("The publication instant is invalid.");
  const civil=(/^[+-]\d{2}:\d{2}$/.test(timezone)?date.utcOffset(timezone):date.tz(timezone)).format("YYYY-MM-DDTHH:mm:ss");
  if(!parsePostCivil(civil))throw new Error("The publication date is outside years 0001–9999.");
  return civil;
}
/** Interprets historical civil fields in the current explicit site zone. Moment's
 * gap/fold normalization is presentation-only; new local writes reject gaps. */
export function postCivilMoment(civil: string, timezone: string) {
  timezone=publicationTimezone(timezone);
  if(!parsePostCivil(civil))throw new Error("The publication civil date is invalid.");
  return /^[+-]\d{2}:\d{2}$/.test(timezone)?moment.parseZone(civil+timezone,moment.ISO_8601,true):moment.tz(civil,moment.ISO_8601,true,timezone);
}
export function postCivilInstant(civil: string, timezone: string): string {
  const date=postCivilMoment(civil,timezone),value=date.toISOString();
  if(!date.isValid() || !/^\d{4}-/.test(value) || value.startsWith("0000"))throw new Error("The selected publication instant is outside years 0001–9999.");
  return value;
}
export function postCivilZoned(civil: string,timezone:string):string{return postCivilMoment(civil,timezone).format("YYYY-MM-DDTHH:mm:ssZ");}
export function formatPostCivil(civil: string, format: string, timezone: string): string {
  const date=postCivilMoment(civil,timezone);
  return format==="human-diff"?humanTimeDiff(date.toDate()):phpDate(format,date.toISOString(),timezone);
}
export function postPublicationKey(post: {id: number;postDate?:string|null}){return `post:${post.id}:${post.postDate || ""}`;}
