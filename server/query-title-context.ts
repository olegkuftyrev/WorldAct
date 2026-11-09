/** Server-owned presentation provenance, never a public query/attribute flag. */
export type ArchiveTitleContext =
  | { readonly kind: "selected-singular" }
  | { readonly kind: "preserve" }
  | { readonly kind: "unfiltered-posts-home" };
export type ArchiveTitleRequestContext = ArchiveTitleContext
  | { readonly kind: "home-candidate"; readonly requestPath: string }
  | "resolved-path";
export type ArchiveTitlePostContext = ArchiveTitleContext | "resolved-path";
type QueryInput = Record<string, unknown> | URLSearchParams;
type HomeSettings = { frontPageMode?: unknown };
const excluded = /^(?:search|s|category|tag|author|author_name|year|month|monthnum|day|m|w|p|page_id|postId|preview)$/;
const counter = /^(?:page|commentPage|replytocom|query-\d+-page)$/;

function unfiltered(input: QueryInput): boolean {
  const seen = new Set<string>();
  for (const [key, value] of input instanceof URLSearchParams ? input : Object.entries(input)) {
    const base = key.split("[")[0];
    if (excluded.test(base)) return false;
    if (!counter.test(base)) continue;
    if (key !== base || seen.has(key) || !["string", "number"].includes(typeof value)
      || !/^[1-9]\d{0,9}$/.test(String(value)) || Number(value) > 2147483647) return false;
    seen.add(key);
  }
  return true;
}

/** Classification only: invalid/unsupported inputs preserve existing output,
 * without introducing validation errors, SQL, settings reads or awaits. */
export function finalizePostsHomeTitleContext(
  context: ArchiveTitleRequestContext, settings: HomeSettings,
  originalQuery: QueryInput, normalizedQuery: QueryInput,
): ArchiveTitleContext {
  if (context === "resolved-path") return { kind: "preserve" };
  if (context.kind !== "home-candidate") return context;
  if (settings.frontPageMode !== "posts") return { kind: "preserve" };
  const path = context.requestPath;
  if (typeof path !== "string" || path.length > 2000 || /[\\\0\r\n#]/.test(path)) return { kind: "preserve" };
  const at = path.indexOf("?"), pathname = at < 0 ? path : path.slice(0, at);
  if (pathname !== "/") return { kind: "preserve" };
  try {
    decodeURIComponent(path);
    const visible = new URLSearchParams(at < 0 ? "" : path.slice(at + 1));
    if (!unfiltered(visible) || !unfiltered(originalQuery) || !unfiltered(normalizedQuery)) return { kind: "preserve" };
  } catch { return { kind: "preserve" }; }
  return { kind: "unfiltered-posts-home" };
}

export function selectedBodyTitleContext(context: ArchiveTitleRequestContext | undefined): ArchiveTitlePostContext {
  if (context === undefined) return { kind: "selected-singular" };
  if (context !== "resolved-path" && context.kind === "home-candidate") return { kind: "preserve" };
  return context;
}

export function postTitleContext(
  context: ArchiveTitlePostContext | undefined,
  post: { type?: unknown; id?: unknown }, settings: HomeSettings & { postsPageId?: unknown },
): ArchiveTitleContext | undefined {
  return context === "resolved-path"
    ? { kind: post.type === "page" && settings.frontPageMode === "page" && post.id === settings.postsPageId
      ? "preserve" : "selected-singular" }
    : context;
}

export function excludesArchiveTitle(context: ArchiveTitleContext | undefined): boolean {
  return context?.kind === "selected-singular" || context?.kind === "unfiltered-posts-home";
}
