import {normalizeLoginRedirect} from './login-redirect.js';
const origin = 'https://worldact.invalid';
/** Preserve visible current identity/paging; renderer-only and moderation values
 * never become login returns or ordinary source reply links. */
export function commentReturnPath(requestPath: string | undefined, values: Record<string, unknown> = {}, replyId?: number): string {
  const url = new URL(normalizeLoginRedirect(requestPath || '/', origin) || '/', origin);
  for (const [key,value] of Object.entries(values)) if (/^(?:p|page_id|page|commentPage|query-\d+-page)$/.test(key) && (typeof value === 'string' || typeof value === 'number')) url.searchParams.set(key,String(value).slice(0,300));
  for (const key of ['postId','requestPath','type','contentPage','unapproved','moderation-hash','replytocom']) url.searchParams.delete(key);
  if (replyId && Number.isSafeInteger(replyId) && replyId > 0 && replyId <= 2147483647) url.searchParams.set('replytocom',String(replyId));
  url.hash = 'respond';
  return url.pathname + url.search + url.hash;
}
export const commentLoginHref = (path: string) => '/login?' + new URLSearchParams({redirect_to:path});
