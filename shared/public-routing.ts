import type { PublicArchive, PublicPost, PublicQuery, PublicTemplateRef } from "./public-document.js";

export class PublicQueryError extends Error {}
const scalarKeys = /^(?:search|s|category|tag|author|year|monthnum|day|m|w|page|commentPage|replytocom|query-\d+-page)$/;
const positive = (value: string, key: string) => {
  if (!/^[1-9]\d{0,9}$/.test(value) || Number(value) > 2147483647)
    throw new PublicQueryError(`Use a positive ${key} within the supported range.`);
  return Number(value);
};

/** Normalize once, before flattening: duplicated/nested recognized parameters
 * must not become a different valid request through Object.fromEntries. */
export function normalizePublicQuery(query: URLSearchParams, options: {
  singular: boolean; contentPage?: number; archive?: PublicArchive | null;
}): PublicQuery {
  for (const [key] of query) {
    const base = key.split("[")[0];
    if (scalarKeys.test(base) && (key !== base || query.getAll(key).length !== 1))
      throw new PublicQueryError("Use a single scalar value for each public query parameter.");
  }
  const values: Record<string, string> = {};
  for (const [key, value] of query) if (scalarKeys.test(key) && value) values[key] = value;
  const search = (values.search || values.s || "").trim();
  if (search.length > 200) throw new PublicQueryError("Search exceeds the supported length.");
  const archive = options.archive;
  const category = archive && "taxonomy" in archive && archive.taxonomy === "category" ? archive.slug : values.category || "";
  const tag = archive && "taxonomy" in archive && archive.taxonomy === "tag" ? archive.slug : values.tag || "";
  if (category.length > 220 || tag.length > 220) throw new PublicQueryError("The taxonomy slug exceeds the supported length.");
  const date = archive && "type" in archive && archive.type === "date" ? archive : null;
  if (date) {
    delete values.m; values.year = String(date.year);
    for (const [key, value] of [["monthnum", date.month], ["day", date.day], ["w", date.week]] as const)
      if (value === undefined) delete values[key]; else values[key] = String(value);
  }
  if (search) values.search = search; else delete values.search;
  delete values.s;
  if (category) values.category = category; if (tag) values.tag = tag;
  const page = values.page ? positive(values.page, "page") : 1;
  const blockPages: Record<string, number> = {};
  for (const [key, value] of Object.entries(values)) if (/^query-\d+-page$/.test(key)) blockPages[key] = positive(value, key);
  const contentPage = options.singular ? options.contentPage ?? page : 1;
  values.page = String(options.singular ? 1 : page);
  const commentPage = values.commentPage ? positive(values.commentPage, "comment page") : undefined;
  return { search, category, tag, ...(values.author ? {author: positive(values.author,"author")} : {}), date,
    archivePage: options.singular ? 1 : page, contentPage, ...(commentPage ? {commentPage} : {}), blockPages, values };
}

/** Exact priority formerly owned by PublicSite.selectSourceTemplate. */
export function sourceTemplateCandidates(context: {
  notFound: boolean; single: boolean; post: Pick<PublicPost, "id" | "type" | "slug" | "templateSlug"> | null;
  frontPage: boolean; search: boolean; category?: string; tag?: string; author: boolean; date: boolean;
}) {
  return context.notFound ? ["404", "index"]
    : context.search ? ["search", "index"]
    : context.category ? [`category-${context.category}`, "category", "archive", "index"]
    : context.tag ? [`tag-${context.tag}`, "tag", "archive", "index"]
    : context.author ? ["author", "archive", "index"] : context.date ? ["date", "archive", "index"]
    : context.single && context.post ? [
      ...(context.frontPage ? ["front-page"] : []), ...(context.post.templateSlug ? [context.post.templateSlug] : []),
      ...(context.post.type === "page" ? [`page-${context.post.slug}`, `page-${context.post.id}`, "page"] : [`single-post-${context.post.slug}`, "single-post", "single"]), "singular", "index",
    ] : [...(context.frontPage ? ["front-page"] : []), "home", "index"];
}
export function selectPublicSourceTemplate<T extends PublicTemplateRef>(documents: T[], context: Parameters<typeof sourceTemplateCandidates>[0]): T | null {
  for (const slug of sourceTemplateCandidates(context)) { const document = documents.find(item => item.slug === slug); if (document) return document; }
  return null;
}
