import type { Settings } from "./api";

/** The saved front-page selection remains authoritative if its public object
 * is unavailable. The real resolver then supplies the ordinary 404 state. */
export function shouldResolveStaticFrontPage(path: string, query: URLSearchParams, site: {
  settings: Partial<Settings>;
  frontPage: { id: number } | null;
} | null): boolean {
  if (path !== "/" || site?.settings.frontPageMode !== "page" || !site.settings.frontPageId) return false;
  // Match Node's document classifier: an empty filter is not an archive.
  if ([...query].some(([key, value]) => value && /^(?:search|s|category|tag|author|year|month|monthnum|day|m|w)(?:\[|$)/.test(key))) return false;
  return site.frontPage?.id !== site.settings.frontPageId ||
    [...query.keys()].some(key => /^page(?:\[|$)/.test(key));
}
