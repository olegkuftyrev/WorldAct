/** RSS compatibility wrapper around the shared pinned public HTTP transport. */
import { createPublicHTTPTransport, normalizePublicURL, isPublicAddress, PublicHTTPError, MAX_HTTP_BODY_BYTES, MAX_HTTP_WIRE_BYTES, type PublicHTTPOptions } from "./public-http.js";
export const MAX_FEED_WIRE_BYTES = MAX_HTTP_WIRE_BYTES;
export const MAX_FEED_XML_BYTES = MAX_HTTP_BODY_BYTES;
export class FeedError extends PublicHTTPError {}
export type FeedAddress = import("./public-http.js").PublicAddress;
export type FeedTransportOptions = PublicHTTPOptions;
const feedError=(error:unknown)=>new FeedError(error instanceof PublicHTTPError ? error.message.replace(/remote/g,"feed") : "The feed could not be retrieved.");
export function normalizeFeedURL(input:unknown):URL{try{return normalizePublicURL(input);}catch(error){throw feedError(error);}}
export const isPublicFeedAddress=isPublicAddress;
export function createFeedTransport(options:FeedTransportOptions={}){
 const transport=createPublicHTTPTransport(options);
 return async(input:string,ownOrigins:ReadonlySet<string>=new Set())=>{
  try{const {body,url}=await transport(input,{},ownOrigins);return {body,url};}catch(error){throw feedError(error);}
 };
}
export const fetchFeedDocument=createFeedTransport();
