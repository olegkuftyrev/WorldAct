import { isIP } from 'node:net';
import { z } from 'zod';
import { normalizePublicURL, isPublicAddress } from './public-http.js';
export const pingServiceURL=z.string().max(2048).transform((value,context)=>{
 try{
  const url=normalizePublicURL(value),host=url.hostname.replace(/^\[|\]$/g,'');
  if((url.port && !['80','443','8080'].includes(url.port)) || host==='localhost' || /\.(localhost|local|internal)$/.test(host) || (isIP(host) && !isPublicAddress(host)))throw new Error();
  return url.href;
 }catch{context.addIssue({code:'custom',message:'Use a public HTTP(S) service URL on port 80, 443 or 8080, without credentials.'});return z.NEVER;}
});
export const pingServicesSchema=z.array(pingServiceURL).max(20).transform(values=>[...new Set(values)]);
export type PingEnvironment='local'|'development'|'staging'|'production';
export function pingEnvironment():PingEnvironment{
 const value=process.env.WORLDACT_ENVIRONMENT_TYPE;
 // Source defaults to production when genuinely unset. Invalid explicit configuration fails closed.
 return value===undefined ? 'production' : ['local','development','staging','production'].includes(value) ? value as PingEnvironment : 'local';
}
