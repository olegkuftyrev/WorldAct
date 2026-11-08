import type { Settings } from "./api";

/** A page-only root query is ambiguous until the real site response identifies
 * a selected static front page. Archive and Query Loop paging stay separate. */
export function shouldResolveStaticFrontPage(path: string, query: URLSearchParams, site: {
  settings: Partial<Settings>;
  frontPage: { id: number } | null;
} | null): boolean {
  if (path !== "/" || site?.settings.frontPageMode !== "page" || !site.frontPage) return false;
  if (![...query.keys()].some(key => /^page(?:\[|$)/.test(key))) return false;
  return !["search", "s", "category", "tag", "author", "year", "monthnum", "day", "m", "w"].some(key => query.has(key));
}
