import moment from "moment-timezone";
import type { BlockDatabase, Context, Node, RenderPost, State } from "./block-renderer.js";
import { postPermalink } from "./permalinks.js";
import { dateArchivePath, parseDateArchivePath, parseDateArchiveQuery } from "./date-archives.js";
import { cleanContent, plainText } from "./utils.js";

import { TERM_BLOCKS } from "../shared/dynamic-blocks.js";
export { TERM_BLOCKS };
export type RenderTerm = { id: number; taxonomy: "category" | "tag"; name: string; slug: string; description: string; parentId: number | null; count: number };
export type TermQueryOptions = {
  taxonomy: "category" | "tag";
  page?: number; perPage?: number; order?: "asc" | "desc";
  orderBy?: "name" | "slug" | "id" | "count" | "include" | "description" | "term_group" | "include_slugs";
  include?: number[]; exclude?: number[]; slugs?: string[]; search?: string; parent?: number; descendantOf?: number; postId?: number; hideEmpty?: boolean;
};
const escape = (value: unknown) => String(value ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const int = (value: unknown, fallback: number, min = 1, max = 2147483647) => Number.isFinite(Number(value)) ? Math.min(max, Math.max(min, Math.trunc(Number(value)))) : fallback;
const ids = (value: unknown) => [...new Set((Array.isArray(value) ? value : []).map(Number).filter(id => Number.isSafeInteger(id) && id > 0 && id <= 2147483647))].slice(0, 1000);
const cached = <T>(state: State, key: string, read: () => Promise<T>): Promise<T> => { if (!state.cache.has(key)) state.cache.set(key, read()); return state.cache.get(key)!; };
const taxonomyOf = (value: unknown): "category" | "tag" | null => value === "category" ? "category" : value === "tag" || value === "post_tag" ? "tag" : null;
const countSQL = "(SELECT count(*)::int FROM post_terms pt JOIN posts p ON p.id=pt.post_id WHERE pt.term_id=t.id AND p.type='post' AND p.status='publish')";
const termFields = `t.id,t.taxonomy,t.name,t.slug,t.description,t.parent_id AS "parentId",${countSQL} AS count`;
export const termLink = (term: RenderTerm, state: State) => `/${encodeURIComponent(term.taxonomy === "tag" ? state.settings.tagBase : state.settings.categoryBase)}/${encodeURIComponent(term.slug)}/`;

/** One source-equivalent term query shared by native REST previews and rendering. */
export async function readTermQuery(db: BlockDatabase, options: TermQueryOptions) {
  const args: unknown[] = [options.taxonomy], where = ["t.taxonomy=$1"];
  const parameter = (value: unknown) => { args.push(value); return "$" + args.length; };
  const include = ids(options.include), exclude = ids(options.exclude);
  if (include.length) where.push(`t.id=ANY(${parameter(include)}::int[])`);
  if (exclude.length) where.push(`NOT(t.id=ANY(${parameter(exclude)}::int[]))`);
  if (options.slugs?.length) where.push(`t.slug=ANY(${parameter(options.slugs.slice(0, 200))}::text[])`);
  if (options.search) { const value = parameter(`%${options.search.slice(0, 200).replace(/[\\%_]/g, "\\$&")}%`); where.push(`t.name ILIKE ${value}`); }
  if (options.parent !== undefined) where.push(options.parent ? `t.parent_id=${parameter(options.parent)}` : "t.parent_id IS NULL");
  if (options.descendantOf) where.push(`t.id IN(WITH RECURSIVE descendants(id) AS (SELECT id FROM terms WHERE parent_id=${parameter(options.descendantOf)} AND taxonomy='category' UNION SELECT child.id FROM terms child JOIN descendants d ON child.parent_id=d.id WHERE child.taxonomy='category') SELECT id FROM descendants)`);
  if (options.postId) where.push(`EXISTS(SELECT 1 FROM post_terms selected WHERE selected.term_id=t.id AND selected.post_id=${parameter(options.postId)})`);
  if (options.hideEmpty) where.push(options.taxonomy === "category"
    ? "t.id IN(WITH RECURSIVE populated(id,parent_id) AS (SELECT active.id,active.parent_id FROM terms active WHERE active.taxonomy='category' AND EXISTS(SELECT 1 FROM post_terms pt JOIN posts p ON p.id=pt.post_id WHERE pt.term_id=active.id AND p.type='post' AND p.status='publish') UNION SELECT parent.id,parent.parent_id FROM terms parent JOIN populated child ON child.parent_id=parent.id WHERE parent.taxonomy='category') SELECT id FROM populated)"
    : `${countSQL}>0`);
  const total = Number((await db.query(`SELECT count(*)::int AS total FROM terms t WHERE ${where.join(" AND ")}`, args)).rows[0].total);
  const direction = options.order === "desc" ? "DESC" : "ASC";
  let order = ({ name: "t.name", slug: "t.slug", id: "t.id", count: countSQL, description: "t.description", term_group: "t.id" } as Record<string, string>)[options.orderBy || "name"] || "t.name";
  if (options.orderBy === "include" && include.length) order = `array_position(${parameter(include)}::int[],t.id)`;
  if (options.orderBy === "include_slugs" && options.slugs?.length) order = `array_position(${parameter(options.slugs)}::text[],t.slug)`;
  const perPage = int(options.perPage, 10, 1, 100), page = int(options.page, 1, 1, 10000);
  const rows = await db.query(`SELECT ${termFields} FROM terms t WHERE ${where.join(" AND ")} ORDER BY ${order} ${direction},t.id ${direction} LIMIT ${parameter(perPage)} OFFSET ${parameter((page - 1) * perPage)}`, args);
  return { terms: rows.rows as RenderTerm[], total, page, perPage };
}
async function loadTerm(state: State, id: number): Promise<RenderTerm | null> {
  return cached(state, `context-term:${id}`, async () => (await state.db.query(`SELECT ${termFields} FROM terms t WHERE t.id=$1`, [id])).rows[0] || null);
}
export async function archiveTerm(context: Context, state: State): Promise<RenderTerm | null> {
  if (context.term) return context.term;
  const query = state.options.query || {}, taxonomy = query.tag ? "tag" : query.category ? "category" : null;
  if (!taxonomy) return null;
  const slug = String(query[taxonomy]).slice(0, 220);
  return cached(state, `archive-term:${taxonomy}:${slug}`, async () => (await state.db.query(`SELECT ${termFields} FROM terms t WHERE t.taxonomy=$1 AND t.slug=$2`, [taxonomy, slug])).rows[0] || null);
}
async function termAncestors(term: RenderTerm, state: State) {
  const ancestors: RenderTerm[] = [], seen = new Set<number>([term.id]); let parent = term.parentId;
  while (parent && ancestors.length < 30 && !seen.has(parent)) {
    seen.add(parent); const row = await loadTerm(state, parent);
    if (!row || row.taxonomy !== term.taxonomy) break;
    ancestors.unshift(row); parent = row.parentId;
  }
  return ancestors;
}
async function loadPage(id: number, state: State): Promise<RenderPost | null> {
  return cached(state, `breadcrumb-page:${id}`, async () => (await state.db.query('SELECT id,type,title,slug,parent_id AS "parentId",status,published_at AS "publishedAt",created_at AS "createdAt",(password_hash IS NOT NULL) AS "hasPassword" FROM posts WHERE id=$1 AND type=\'page\' AND status=\'publish\'', [id])).rows[0] || null);
}
const safeURL = (value: unknown) => /^(?:https?:\/\/|\/(?!\/)|#)/i.test(String(value ?? "")) && !/[\u0000-\u0020<>"']/.test(String(value)) ? String(value) : "";
type Crumb = { label: string; url?: string };
async function breadcrumbs(node: Node, context: Context, state: State, attributes: (extra?: string) => string) {
  const a = node.attrs, query = state.options.query || {}, path = (state.options.requestPath || "/").split("?")[0], template = state.options.templateSlug || "";
  const post = context.post, search = String(query.search || query.s || ""), date = parseDateArchiveQuery(query) || parseDateArchivePath(path);
  const term = await archiveTerm({ ...context, term: undefined }, state), authorId = int(query.author, 0);
  const paged = int(query.paged ?? query.page ?? state.options.page, 1), commentPage = int(query.commentPage ?? query.cpage, 1), is404 = template === "404" || query.notFound === "true";
  const archive = Boolean(search || date || term || authorId || is404), front = !archive && (path === "/" || template === "front-page") && (!post || post.id === state.settings.frontPageId || state.settings.frontPageMode === "posts");
  const postsIndex = !archive && state.settings.frontPageMode === "page" && state.settings.postsPageId && (post?.id === state.settings.postsPageId || template === "home");
  if (front && a.showOnHomePage !== true) return "";
  const crumbs: Crumb[] = a.showHomeItem === false ? [] : [{ label: "Home", ...(!front || paged > 1 ? { url: "/" } : {}) }];
  const current = (label: string, url = path) => ({ label, ...(paged > 1 ? { url } : {}) });
  if (is404) crumbs.push({ label: "Page not found" });
  else if (search) {
    const words=plainText(search).trim().split(/\s+/).filter(Boolean);
    crumbs.push(current(`Search results for: "${words.slice(0,10).join(" ")}${words.length>10?"…":""}"`, "/?s=" + encodeURIComponent(search)));
  } else if (date) {
    const year = String(date.year), month = date.month ? moment.utc(`${year.padStart(4, "0")}-${String(date.month).padStart(2, "0")}-01`).format("MMMM") : "";
    if (date.month) crumbs.push({ label: year, url: dateArchivePath({ year: date.year }) });
    else crumbs.push(current(year, dateArchivePath(date)));
    if (date.day) crumbs.push({ label: month, url: dateArchivePath({ year: date.year, month: date.month }) }, current(String(date.day), dateArchivePath(date)));
    else if (date.month) crumbs.push(current(month, dateArchivePath(date)));
  } else if (term) {
    for (const ancestor of await termAncestors(term, state)) crumbs.push({ label: ancestor.name, url: termLink(ancestor, state) });
    crumbs.push(current(term.name, termLink(term, state)));
  } else if (authorId) {
    const person = await cached(state, `breadcrumb-author:${authorId}`, async () => (await state.db.query("SELECT display_name AS name FROM users WHERE id=$1 AND EXISTS(SELECT 1 FROM posts WHERE author_id=$1 AND status='publish')", [authorId])).rows[0]);
    if (person) crumbs.push(current(person.name, "/?author=" + authorId));
  } else if (front) {
    // The configured front page is represented by Home; source adds only Page N.
  } else if (postsIndex) {
    const page = await loadPage(state.settings.postsPageId!, state);
    if (page) crumbs.push(current(page.title || "(no title)", await postPermalink(page, state.settings, state.db)));
  } else if (post) {
    if (post.type === "page") {
      const ancestors: RenderPost[] = [], seen = new Set<number>([post.id]); let parent = post.parentId ?? post.parent_id;
      while (parent && ancestors.length < 30 && !seen.has(parent)) { seen.add(parent); const row = await loadPage(parent, state); if (!row) break; ancestors.unshift(row); parent = row.parentId; }
      for (const page of ancestors) crumbs.push({ label: page.hasPassword ? "Protected: " + page.title : page.title || "(no title)", url: await postPermalink(page, state.settings, state.db) });
    } else {
      if (state.settings.frontPageMode === "page" && state.settings.postsPageId) {
        const page = await loadPage(state.settings.postsPageId, state); if (page) crumbs.push({ label: page.title || "(no title)", url: await postPermalink(page, state.settings, state.db) });
      }
      const assigned = Array.isArray(post.terms) ? post.terms : (await state.db.query(`SELECT ${termFields} FROM terms t JOIN post_terms pt ON pt.term_id=t.id WHERE pt.post_id=$1 ORDER BY t.name,t.id`, [post.id])).rows;
      const selected = assigned.find((item: RenderTerm) => item.taxonomy === "category") || assigned.find((item: RenderTerm) => item.taxonomy === "tag");
      if (selected) {
        const complete = selected.parentId !== undefined ? selected : await loadTerm(state, selected.id);
        if (complete) { for (const ancestor of await termAncestors(complete, state)) crumbs.push({ label: ancestor.name, url: termLink(ancestor, state) }); crumbs.push({ label: complete.name, url: termLink(complete, state) }); }
      }
    }
    const label = (post.hasPassword ? "Protected: " : "") + (post.title || "(no title)");
    const pagination = commentPage > 1 || paged > 1;
    crumbs.push({ label, ...(pagination ? { url: await postPermalink(post, state.settings, state.db) } : {}) });
    if (commentPage > 1) crumbs.push({ label: "Comments Page " + commentPage });
  } else if (state.settings.frontPageMode === "page" && state.settings.postsPageId) {
    const page = await loadPage(state.settings.postsPageId, state); if (page) crumbs.push(current(page.title || "(no title)", await postPermalink(page, state.settings, state.db)));
  }
  if (paged > 1 && commentPage <= 1) crumbs.push({ label: "Page " + paged });
  if (a.showCurrentItem === false) crumbs.pop();
  if (!crumbs.length) return "";
  const inputSeparator = plainText(String(a.separator ?? "/")).slice(0, 40);
  const separator = /["\\\u0000-\u001f]/u.test(inputSeparator) ? "/" : inputSeparator;
  const style = escape(`--separator:"${separator}"`), original = attributes();
  const wrapper = / style="/.test(original) ? original.replace(/ style="([^"]*)"/, (_match, value) => ` style="${value};${style}"`) : original + ` style="${style}"`;
  return `<nav${wrapper} aria-label="Breadcrumbs"><ol>${crumbs.map(crumb => `<li>${crumb.url ? `<a href="${escape(crumb.url)}">${escape(crumb.label)}</a>` : `<span aria-current="page">${escape(crumb.label)}</span>`}</li>`).join("")}</ol></nav>`;
}

export async function renderTermBlock(node: Node, context: Context, state: State, children: (nodes: Node[], context: Context) => Promise<string>, attributes: (extra?: string) => string): Promise<string | undefined> {
  const name = node.name, a = node.attrs;
  if (name === "core/terms-query") {
    const query = a.termQuery && typeof a.termQuery === "object" ? a.termQuery : {};
    const tag = ["div", "section", "main", "aside", "ul"].includes(a.tagName) ? a.tagName : "div";
    return `<${tag}${attributes()}>${await children(node.children, { ...context, termQuery: query })}</${tag}>`;
  }
  if (name === "core/term-template") {
    if (!context.termQuery) return "";
    const q = context.termQuery, current = q.inherit ? await archiveTerm({ ...context, term: undefined }, state) : null;
    const taxonomy = current?.taxonomy || taxonomyOf(q.taxonomy ?? "category"); if (!taxonomy) return "";
    const include = current ? [] : ids(q.include), orderBy = ["name", "slug", "id", "count", "description", "include"].includes(q.orderBy) ? q.orderBy : "name";
    const options: TermQueryOptions = { taxonomy, perPage: int(q.perPage, 10, 1, 100), order: include.length ? "asc" : q.order === "desc" ? "desc" : "asc", orderBy: include.length ? "include" : orderBy, include, hideEmpty: q.hideEmpty !== false,
      ...(!include.length && taxonomy === "category" ? current ? q.showNested ? { descendantOf: current.id } : { parent: current.id } : q.showNested ? {} : { parent: 0 } : {}),
    };
    const records = await cached(state, "context-term-query:" + JSON.stringify(options), () => readTermQuery(state.db, options));
    if (!records.terms.length) return "";
    const out: string[] = [];
    for (const term of records.terms) out.push(`<li class="wp-block-term term-${term.id} ${term.taxonomy === "tag" ? "post_tag" : "category"} taxonomy-${term.taxonomy === "tag" ? "post_tag" : "category"}">${await children(node.children, { ...context, term })}</li>`);
    return `<ul${attributes()}>${out.join("")}</ul>`;
  }
  if (name === "core/term-name" || name === "core/term-count") {
    const term = await archiveTerm(context, state); if (!term) return "";
    if (name === "core/term-count") {
      const brackets: Record<string, [string, string]> = { round: ["(", ")"], square: ["[", "]"], curly: ["{", "}"], angle: ["<", ">"] }, pair = brackets[a.bracketType === undefined ? "round" : a.bracketType] || ["", ""];
      return `<div${attributes()}>${escape(pair[0] + term.count + pair[1])}</div>`;
    }
    const level = int(a.level, 0, 0, 6), tag = level ? "h" + level : "p", text = escape(term.name);
    return `<${tag}${attributes()}>${a.isLink ? `<a href="${escape(termLink(term, state))}">${text}</a>` : text}</${tag}>`;
  }
  if (name === "core/breadcrumbs") return breadcrumbs(node, context, state, attributes);
  if (name === "core/page-list-item") {
    // Canonical serialized markup must retain its own structure and attributes.
    if (node.fragments) {
      const out: string[] = []; let child = 0;
      for (const fragment of node.fragments) out.push(fragment === null ? await children(node.children.slice(child, ++child), context) : fragment);
      if (child < node.children.length) out.push(await children(node.children.slice(child), context));
      return out.join("");
    }
    if (node.html?.trim() && !node.children.length) return cleanContent(node.html);
    const page = a.id ? await loadPage(int(a.id, 0), state) : null;
    if (a.id && !page) return "";
    const url = page ? await postPermalink(page, state.settings, state.db) : safeURL(a.link);
    if (!url) return "";
    const label = plainText(String(a.label || a.title || page?.title || "(no title)"));
    return `<li${attributes()}><a class="wp-block-navigation-item__content" href="${escape(url)}"><span class="wp-block-navigation-item__label">${escape(label)}</span></a>${node.children.length ? `<ul class="wp-block-navigation__submenu-container">${await children(node.children, context)}</ul>` : ""}</li>`;
  }
  return undefined;
}
