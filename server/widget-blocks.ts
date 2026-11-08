import moment from "moment-timezone";
import { date as formatDate } from "@wordpress/date";
import type { Context, Node, RenderPost, State } from "./block-renderer.js";
import { postPermalink } from "./permalinks.js";
import {observePublicPost} from "./public-read-attempt.js";
import { avatarURL } from "./avatars.js";
import { cleanContent, plainText, HttpError } from "./utils.js";
import { excerptText } from "./excerpts.js";
import { legacyExcerptSource } from "./legacy-content.js";
import { dateArchiveSQLBounds, dateArchiveLocalSQL, dateArchivePath, dateArchiveWeekSQL, parseDateArchiveQuery } from "./date-archives.js";
import { gridColumnCount } from "./block-layout.js";
import { postHasPassword, postNeedsPassword as protectedPost, publicPostTitle as titleOf } from "./post-passwords.js";

import { WIDGET_BLOCKS } from "../shared/dynamic-blocks.js";
export { WIDGET_BLOCKS };
const escape = (value: unknown) => String(value ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const number = (value: unknown, fallback: number, min = 1, max = 100) => Number.isFinite(Number(value)) ? Math.min(max, Math.max(min, Math.trunc(Number(value)))) : fallback;
const safeURL = (value: unknown) => /^(?:https?:\/\/|\/(?!\/)|#)/i.test(String(value ?? "")) && !/[\u0000-\u0020<>"']/.test(String(value)) ? String(value) : "";
const published = "p.type='post' AND p.status='publish'";
const publication = "coalesce(p.published_at,p.created_at)";
const widgetPostFields = `p.id,p.type,p.title,p.slug,p.parent_id AS "parentId",p.published_at AS "publishedAt",p.created_at AS "createdAt",p.author_id AS "authorId",u.display_name AS "authorName",p.featured_media_id AS "featuredMediaId",(p.password_hash IS NOT NULL) AS "hasPassword",COALESCE((SELECT json_agg(json_build_object('id',t.id,'taxonomy',t.taxonomy,'slug',t.slug) ORDER BY t.name,t.id) FROM post_terms pt JOIN terms t ON t.id=pt.term_id WHERE pt.post_id=p.id),'[]'::json) AS terms`;
const cached = <T>(state: State, key: string, read: () => Promise<T>): Promise<T> => {
  if (!state.cache.has(key)) state.cache.set(key, read());
  return state.cache.get(key)!;
};
const localMoment = (value: unknown, timezone: string) => /^[+-]\d\d:\d\d$/.test(timezone) ? moment(value as string).utcOffset(timezone) : moment(value as string).tz(timezone);
const postDate = (value: unknown, state: State) => {
  const date = localMoment(value, state.settings.timezone);
  return date.isValid() ? formatDate(state.settings.dateFormat, date.toISOString(), state.settings.timezone) : "";
};
const permalink = (post:RenderPost,state:State)=>{
  if(!state.options.preview)observePublicPost(state.options.canReadProtectedPost,post,false);
  return cached(state,`link:${post.id}`,()=>postPermalink(post,state.settings,state.db));
};
const excerpt = (value: string, limit: number) => {
  const words = plainText(value).trim().split(/\s+/).filter(Boolean);
  return { text: words.slice(0, limit).join(" "), trimmed: words.length > limit };
};

/** Mirrors the supplied core/post-time-to-read word counter, including connectors and HTML entities. */
export function countReadingWords(value: string) {
  if (!value.trim()) return 0;
  const text = (value + "\n")
    .replace(/<\/?[a-z][^>]*?>/gi, "\n")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/&nbsp;|&#160;/gi, " ")
    .replace(/&\S+?;/g, "")
    .replace(/--|\u2014/g, " ")
    .replace(/[\u0021-\u0040\u005b-\u0060\u007b-\u007e\u0080-\u00bf\u00d7\u00f7\u2000-\u2bff\u2e00-\u2e7f]/gu, "");
  return [...text.matchAll(/\S\s+/gu)].length;
}
export function readingTimeText(content: string, attrs: Record<string, unknown>) {
  const words = countReadingWords(content);
  if (attrs.displayMode === "words") return `${words.toLocaleString("en-US")} ${words === 1 ? "word" : "words"}`;
  if (attrs.displayMode !== undefined && attrs.displayMode !== "time") return "";
  const rate = number(attrs.averageReadingSpeed, 189, 1, 10000);
  if (attrs.displayAsRange !== false) {
    const low = Math.max(1, Math.round(words / rate * 0.8));
    const high = Math.max(low + 1, Math.round(words / rate * 1.2));
    return `${low}–${high} minutes`;
  }
  const minutes = Math.max(1, Math.round(words / rate));
  return `${minutes} ${minutes === 1 ? "minute" : "minutes"}`;
}

// Comments may be plain text or already contain canonical rich HTML. Preserve
// structural markup; add paragraph/line breaks only to text and inline markup.
export function formatCommentContent(value: string) {
  const html = cleanContent(value.replace(/\r\n?/g, "\n"));
  if (!html.trim() || /<(?:p|div|ul|ol|li|blockquote|pre|table|figure|details|h[1-6]|section|article)\b/i.test(html)) return html;
  let prefix = "WORLDActCOMMENTTAG";
  while (html.includes(prefix)) prefix += "X";
  const tags: string[] = [];
  const text = html.replace(/<[^>]+>/g, tag => `${prefix}${tags.push(tag) - 1}TOKEN`);
  const paragraphs = text.trim().split(/\n[ \t]*\n+/).map(paragraph => `<p>${paragraph.replace(/\n/g, "<br>")}</p>`).join("\n");
  return paragraphs.replace(new RegExp(prefix + "(\\d+)TOKEN", "g"), (_match, index) => tags[Number(index)]);
}

async function latestPosts(node: Node, context: Context, state: State, attributes: (extra?: string) => string, renderPostContent: RenderPostContent) {
  const a = node.attrs, limit = number(a.postsToShow, 5), args: unknown[] = [];
  const where = [published];
  const categories = [...new Set((Array.isArray(a.categories) ? a.categories.map(item => typeof item === "object" && item !== null ? item.id : item) : typeof a.categories === "string" ? a.categories.split(",") : []).map(Number).filter(id => Number.isInteger(id) && id > 0 && id <= 2147483647))].slice(0, 200);
  if (categories.length) { args.push(categories); where.push(`EXISTS(SELECT 1 FROM post_terms pt JOIN terms t ON t.id=pt.term_id WHERE pt.post_id=p.id AND t.taxonomy='category' AND t.id=ANY($${args.length}::int[]))`); }
  if (Number.isInteger(a.selectedAuthor) && a.selectedAuthor > 0 && a.selectedAuthor <= 2147483647) { args.push(a.selectedAuthor); where.push(`p.author_id=$${args.length}`); }
  const sort = ({ date: publication, modified: "p.updated_at", title: "p.title", id: "p.id", ID: "p.id", author: "u.display_name" } as Record<string, string>)[a.orderBy] || publication;
  const order = String(a.order).toLowerCase() === "asc" ? "ASC" : "DESC";
  const key = JSON.stringify([where, args, limit, sort, order, Boolean(a.displayPostContent)]);
  const posts: RenderPost[] = await cached(state, `widget-latest-posts:${key}`, async () => (await state.db.query(`SELECT ${widgetPostFields}${a.displayPostContent ? ",p.content,p.excerpt,p.raw_content AS \"rawContent\",p.blocks,p.footnotes" : ""} FROM posts p JOIN users u ON u.id=p.author_id WHERE ${where.join(" AND ")} ORDER BY ${sort} ${order},p.id ${order} LIMIT $${args.length + 1}`, [...args, limit])).rows);
  let images = new Map<number, any>();
  if (a.displayFeaturedImage) {
    const ids = [...new Set(posts.map(post => post.featuredMediaId).filter(Boolean))];
    if (ids.length) images = await cached(state, `widget-featured:${ids.join(",")}`, async () => new Map((await state.db.query("SELECT id,alt,width,height,sizes,'/uploads/'||filename AS url FROM media WHERE id=ANY($1::int[]) AND mime_type LIKE 'image/%'", [ids])).rows.map(row => [row.id, row])));
  }
  const items: string[] = [];
  for (const record of posts) {
    let post=record;
    if(a.displayPostContent && postHasPassword(post)){
      const sameUnlockedPost=state.options.post?.id===post.id && state.options.post?.locked===false;
      const granted=sameUnlockedPost || (state.options.canReadProtectedPost ? await cached(state,`post-access:${post.id}`,()=>state.options.canReadProtectedPost!(post.id,state.db)):false);
      post={...post,locked:!granted};
    }
    if(!state.options.preview)observePublicPost(state.options.canReadProtectedPost,{...post,locked:protectedPost(post)},Boolean(a.displayPostContent));
    const url = await permalink(post, state), title = titleOf(post); let item = "";
    const image = images.get(post.featuredMediaId);
    if (image) {
      const size = image.sizes?.[a.featuredImageSizeSlug || "thumbnail"] || image, src = safeURL(size.url || (size.filename ? "/uploads/" + size.filename : image.url));
      const style = [a.featuredImageSizeWidth ? `max-width:${number(a.featuredImageSizeWidth, 150, 1, 20000)}px` : "", a.featuredImageSizeHeight ? `max-height:${number(a.featuredImageSizeHeight, 150, 1, 20000)}px` : ""].filter(Boolean).join(";");
      const img = `<img src="${escape(src)}" alt="${escape(image.alt || "")}"${size.width ? ` width="${number(size.width, 150, 1, 20000)}"` : ""}${size.height ? ` height="${number(size.height, 150, 1, 20000)}"` : ""}${style ? ` style="${style}"` : ""} loading="lazy">`;
      item += `<div class="wp-block-latest-posts__featured-image${["left", "center", "right"].includes(a.featuredImageAlign) ? " align" + a.featuredImageAlign : ""}">${a.addLinkToFeaturedImage ? `<a href="${escape(url)}" aria-label="${escape(title)}">${img}</a>` : img}</div>`;
    }
    item += `<a class="wp-block-latest-posts__post-title" href="${escape(url)}">${escape(title)}</a>`;
    if (a.displayAuthor && post.authorName) item += `<div class="wp-block-latest-posts__post-author">by ${escape(post.authorName)}</div>`;
    const date = post.publishedAt || post.createdAt;
    if (a.displayPostDate) item += `<time class="wp-block-latest-posts__post-date" datetime="${escape(new Date(date).toISOString())}">${escape(postDate(date, state))}</time>`;
    if (a.displayPostContent) {
      if (a.displayPostContentRadio === "full_post") {
        const content = protectedPost(post) ? "This content is password protected." : context.contentIds.has(post.id) ? "" : await renderPostContent(post, { ...context, post, contentIds: new Set([...context.contentIds, post.id]) });
        item += `<div class="wp-block-latest-posts__post-full-content">${content}</div>`;
      } else {
        const manual = String(post.excerpt || "").trim();
        const text = manual ? { text: plainText(manual), trimmed: false } : excerpt(excerptText(legacyExcerptSource(post)), number(a.excerptLength, 55, 1, 1000));
        item += `<div class="wp-block-latest-posts__post-excerpt">${protectedPost(post) ? "This content is password protected." : escape(text.text) + (text.trimmed ? `… <a class="wp-block-latest-posts__read-more" href="${escape(url)}">Read more<span class="screen-reader-text">: ${escape(title)}</span></a>` : "")}</div>`;
      }
    }
    items.push(`<li>${item}</li>`);
  }
  const grid = a.layout?.type === "grid" || (!a.layout && a.postLayout === "grid"), classes = ["wp-block-latest-posts__list", grid ? "is-grid columns-" + (gridColumnCount(a.layout || {}) ?? number(a.columns, 3, 1, 1000)) : "", a.displayPostDate ? "has-dates" : "", a.displayAuthor ? "has-author" : ""].filter(Boolean).join(" ");
  return `<ul${attributes(classes)}>${items.join("\n")}</ul>`;
}

async function latestComments(node: Node, state: State, attributes: (extra?: string) => string) {
  const a = node.attrs, limit = number(a.commentsToShow, 5);
  const records = await cached(state, `widget-latest-comments:${limit}`, async () => (await state.db.query(`SELECT c.id,c.author_name AS "authorName",c.author_email AS "avatarEmail",c.author_url AS "authorUrl",c.user_id AS "userId",c.content AS "commentContent",c.created_at AS "commentDate",p.id AS "postId",p.author_id AS "authorId",p.title,p.slug,p.type,p.parent_id AS "parentId",p.published_at AS "publishedAt",p.created_at AS "createdAt",(p.password_hash IS NOT NULL) AS "hasPassword",${publication} AS "postDate",COALESCE((SELECT json_agg(json_build_object('id',t.id,'taxonomy',t.taxonomy,'slug',t.slug) ORDER BY t.name,t.id) FROM post_terms pt JOIN terms t ON t.id=pt.term_id WHERE pt.post_id=p.id),'[]'::json) AS terms FROM comments c JOIN posts p ON p.id=c.post_id WHERE c.status='approved' AND p.status='publish' ORDER BY c.created_at DESC,c.id DESC LIMIT $1`, [limit])).rows);
  const display = a.displayExcerpt !== undefined ? a.displayExcerpt ? "excerpt" : "none" : ["none", "excerpt", "full"].includes(a.displayContent) ? a.displayContent : "excerpt";
  const classes = [a.displayAvatar !== false ? "has-avatars" : "", a.displayDate !== false ? "has-dates" : "", display !== "none" ? "has-excerpts" : "", !records.length ? "no-comments" : ""].filter(Boolean).join(" ");
  if (!records.length) return `<div${attributes(classes)}>No comments to show.</div>`;
  const items: string[] = [];
  for (const record of records) {
    if(!state.options.preview)observePublicPost(state.options.canReadProtectedPost,{...record,id:record.postId,locked:false},!record.hasPassword);
    const url = await permalink({ ...record, id: record.postId }, state), authorURL = safeURL(record.authorUrl) || (record.userId ? "/?author=" + record.userId : "");
    const author = authorURL ? `<a class="wp-block-latest-comments__comment-author" href="${escape(authorURL)}">${escape(record.authorName)}</a>` : `<span class="wp-block-latest-comments__comment-author">${escape(record.authorName)}</span>`;
    const avatar = a.displayAvatar !== false ? avatarURL(record.avatarEmail, state.settings, 48) : null;
    let item = avatar ? `<img class="avatar avatar-48 photo wp-block-latest-comments__comment-avatar" src="${escape(avatar)}" alt="" width="48" height="48" loading="lazy">` : "";
    item += `<article><footer class="wp-block-latest-comments__comment-meta">${author} on <a class="wp-block-latest-comments__comment-link" href="${escape(url)}#comment-${record.id}">${escape(titleOf(record))}</a>`;
    if (a.displayDate !== false) item += `<time class="wp-block-latest-comments__comment-date" datetime="${escape(new Date(record.commentDate).toISOString())}">${escape(postDate(record.commentDate, state))}</time>`;
    item += "</footer>";
    if (display !== "none") {
      const summary = excerpt(record.commentContent, 20);
      item += `<div class="wp-block-latest-comments__comment-excerpt">${record.hasPassword ? "Password protected" : display === "full" ? formatCommentContent(record.commentContent) : `<p>${escape(summary.text)}${summary.trimmed ? "…" : ""}</p>`}</div>`;
    }
    items.push(`<li class="wp-block-latest-comments__comment">${item}</article></li>`);
  }
  return `<ol${attributes(classes)}>${items.join("")}</ol>`;
}

const sizeValue = (value: unknown, fallback: string): { value: number; unit: string } => {
  const match = /^(\d+(?:\.\d+)?)(pt|px|em|rem|%|vw|vh|ch|ex)$/i.exec(String(value || fallback));
  return match ? { value: Math.min(1000, Math.max(0.1, Number(match[1]))), unit: match[2].toLowerCase() } : sizeValue(fallback, "8pt");
};
async function tagCloud(node: Node, state: State, attributes: (extra?: string) => string) {
  const a = node.attrs, taxonomy = a.taxonomy === "category" ? "category" : a.taxonomy === undefined || a.taxonomy === "post_tag" || a.taxonomy === "tag" ? "tag" : null;
  if (!taxonomy) return "";
  const limit = number(a.numberOfTags, 45), rows = await cached(state, `widget-tag-cloud:${taxonomy}:${limit}`, async () => (await state.db.query(`SELECT t.id,t.name,t.slug,count(p.id)::int AS count FROM terms t JOIN post_terms pt ON pt.term_id=t.id JOIN posts p ON p.id=pt.post_id WHERE t.taxonomy=$1 AND ${published} GROUP BY t.id ORDER BY count(p.id) DESC,t.name,t.id LIMIT $2`, [taxonomy, limit])).rows);
  if (!rows.length) return "";
  const names = new Intl.Collator("en", { numeric: true, sensitivity: "base" });
  rows.sort((a, b) => names.compare(a.name, b.name) || a.id - b.id);
  const min = sizeValue(a.smallestFontSize, "8pt"), max = sizeValue(a.largestFontSize, "22pt"), counts = rows.map(row => Math.round(Math.log10(Number(row.count) + 1) * 100));
  const low = Math.min(...counts), spread = Math.max(...counts) - low || 1, fontSpread = max.value < min.value ? 1 : max.value - min.value;
  const links = rows.map((row, index) => {
    const count = Number(row.count), size = min.value + (Math.round(Math.log10(count + 1) * 100) - low) * fontSpread / spread;
    return `<a href="/${encodeURIComponent(taxonomy === "tag" ? state.settings.tagBase : state.settings.categoryBase)}/${encodeURIComponent(row.slug)}/" class="tag-cloud-link tag-link-${row.id} tag-link-position-${index + 1}" style="font-size:${Math.round(size * 100) / 100}${min.unit}" aria-label="${escape(row.name)} (${count} ${count === 1 ? "item" : "items"})">${escape(row.name)}${a.showTagCounts ? `<span class="tag-link-count"> (${count})</span>` : ""}</a>`;
  });
  return `<p${attributes()}>${links.join("\n")}</p>`;
}

async function archives(node: Node, state: State, attributes: (extra?: string) => string) {
  const a = node.attrs, type = ["yearly", "daily", "weekly", "postbypost", "alpha"].includes(a.type) ? a.type : "monthly";
  const args: unknown[] = [], local = dateArchiveLocalSQL(publication, args, state.settings.timezone), weekStart = state.settings.weekStartsOn || 0;
  const columns = type === "yearly" ? `extract(year FROM ${local})::int AS year` : type === "monthly" ? `extract(year FROM ${local})::int AS year,extract(month FROM ${local})::int AS month` : type === "daily" ? `extract(year FROM ${local})::int AS year,extract(month FROM ${local})::int AS month,extract(day FROM ${local})::int AS day` : type === "weekly" ? `extract(year FROM ${local})::int AS year,${dateArchiveWeekSQL(local, weekStart)} AS week` : "";
  // The archive list is finite even on a site imported with an extreme number
  // of old posts; the render output budget remains an additional global cap.
  const limit = 10001;
  const records = await cached(state, `widget-archives:${type}:${state.settings.timezone}:${weekStart}`, async () => columns ? (await state.db.query(`SELECT ${columns},count(*)::int AS count,min(${local})::text AS first FROM posts p WHERE ${published} GROUP BY ${type === "yearly" ? "1" : type === "monthly" || type === "weekly" ? "1,2" : "1,2,3"} ORDER BY min(${local}) DESC LIMIT ${limit}`, args)).rows : (await state.db.query(`SELECT ${widgetPostFields} FROM posts p JOIN users u ON u.id=p.author_id WHERE ${published} ORDER BY ${type === "alpha" ? "p.title ASC,p.id ASC" : publication + " DESC,p.id DESC"} LIMIT ${limit}`)).rows);
  if (records.length > 10000) throw new HttpError(413, "This archive has more than 10,000 entries. Choose a grouped archive type.");
  const entries: Array<{ url: string; label: string }> = [];
  for (const row of records) {
    let label: string, url: string;
    if (type === "alpha" || type === "postbypost") { label = row.title || String(row.id); url = await permalink(row, state); }
    else {
      const civil = moment.utc(`${String(row.year).padStart(4, "0")}-${String(row.month || 1).padStart(2, "0")}-${String(row.day || 1).padStart(2, "0")}`, "YYYY-MM-DD", true);
      label = type === "yearly" ? String(row.year) : type === "monthly" ? civil.format("MMMM YYYY") : type === "daily" ? formatDate(state.settings.dateFormat, civil.toISOString(), "UTC") : "";
      if (type === "weekly") {
        const first = moment.utc(row.first), offset = (first.day() - weekStart + 7) % 7, start = first.clone().subtract(offset, "days").startOf("day"), end = start.clone().add(6, "days");
        label = `${formatDate(state.settings.dateFormat, start.toISOString(), "UTC")}–${formatDate(state.settings.dateFormat, end.toISOString(), "UTC")}`;
      }
      url = dateArchivePath({ year: Number(row.year), ...(type === "weekly" ? { week: Number(row.week) } : row.month ? { month: Number(row.month), ...(row.day ? { day: Number(row.day) } : {}) } : {}) });
      if (a.showPostCounts) label += ` (${row.count})`;
    }
    entries.push({ url, label });
  }
  if (a.displayAsDropdown) {
    const id = "wp-block-archives-" + state.nodes;
    const label = type === "yearly" ? "Select Year" : type === "monthly" ? "Select Month" : type === "daily" ? "Select Day" : type === "weekly" ? "Select Week" : "Select Post";
    return `<div${attributes("wp-block-archives-dropdown")}><label for="${id}" class="wp-block-archives__label${a.showLabel === false ? " screen-reader-text" : ""}">Archives</label><select id="${id}" name="archive-dropdown"><option value="">${label}</option>${entries.map(entry => `<option value="${escape(entry.url)}">${escape(entry.label)}</option>`).join("")}</select></div>`;
  }
  return entries.length ? `<ul${attributes("wp-block-archives-list")}>${entries.map(entry => `<li><a href="${escape(entry.url)}">${escape(entry.label)}</a></li>`).join("")}</ul>` : `<div${attributes("wp-block-archives-list")}>No archives to show.</div>`;
}

async function calendar(node: Node, state: State, attributes: (extra?: string) => string) {
  const a = node.attrs, timezone = state.settings.timezone, query = parseDateArchiveQuery(state.options.query || {}), now = localMoment(new Date(), timezone);
  const weeklyMonth = query?.week ? moment.utc(`${String(query.year).padStart(4, "0")}-01-01`, "YYYY-MM-DD", true).add((query.week - 1) * 7 + 6, "days").month() + 1 : undefined;
  const year = number(a.year ?? query?.year, now.year(), 1, 9999), month = number(a.month ?? query?.month ?? weeklyMonth, query ? 1 : now.month() + 1, 1, 12);
  const archive = { year, month }, bounds = dateArchiveSQLBounds(archive, timezone), args: unknown[] = [bounds.start, bounds.end], local = dateArchiveLocalSQL(publication, args, timezone);
  const data = await cached(state, `widget-calendar:${year}:${month}:${timezone}`, async () => {
    const [days, neighbours] = await Promise.all([
      state.db.query(`SELECT DISTINCT extract(day FROM ${local})::int AS day FROM posts p WHERE ${published} AND ${publication}>=$1::timestamptz AND ${publication}<$2::timestamptz ORDER BY day`, args),
      state.db.query(`(SELECT ${local}::text AS date,'previous' AS direction FROM posts p WHERE ${published} AND ${publication}<$1::timestamptz ORDER BY ${publication} DESC,p.id DESC LIMIT 1) UNION ALL (SELECT ${local}::text AS date,'next' AS direction FROM posts p WHERE ${published} AND ${publication}>=$2::timestamptz ORDER BY ${publication},p.id LIMIT 1)`, args),
    ]);
    return { days: days.rows, neighbours: neighbours.rows };
  });
  if (!data.days.length && !data.neighbours.length) return state.options.user ? `<div${attributes()}>The calendar block is hidden because there are no published posts.</div>` : "";
  const start = moment.utc(`${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-01`, "YYYY-MM-DD", true), weekStart = state.settings.weekStartsOn || 0;
  const headings = Array.from({ length: 7 }, (_, index) => moment.utc("2023-01-01").add((weekStart + index) % 7, "days").format("dddd"));
  const byDay = new Set(data.days.map(row => Number(row.day))), cells: string[] = [];
  const padding = (start.day() - weekStart + 7) % 7;
  if (padding) cells.push(`<td colspan="${padding}" class="pad">&nbsp;</td>`);
  for (let day = 1; day <= start.daysInMonth(); day++) {
    if (day > 1 && (padding + day - 1) % 7 === 0) cells.push("</tr><tr>");
    const today = year === now.year() && month === now.month() + 1 && day === now.date(), hasPosts = byDay.has(day);
    cells.push(`<td${today ? ' id="today"' : ""}>${hasPosts ? `<a href="${escape(dateArchivePath({ year, month, day }))}" aria-label="${escape(`Posts published on ${start.clone().date(day).format("MMMM D, YYYY")}`)}">${day}</a>` : day}</td>`);
  }
  const trailing = (7 - (padding + start.daysInMonth()) % 7) % 7;
  if (trailing) cells.push(`<td colspan="${trailing}" class="pad">&nbsp;</td>`);
  const navigation = data.neighbours.map(row => {
    const date = moment.utc(row.date), previous = row.direction === "previous", link = dateArchivePath({ year: date.year(), month: date.month() + 1 });
    return `<span class="wp-calendar-nav-${previous ? "prev" : "next"}"><a href="${escape(link)}">${previous ? "« " : ""}${escape(date.format("MMM"))}${previous ? "" : " »"}</a></span>`;
  }).join(" ");
  return `<div${attributes()}><table id="wp-calendar" class="wp-calendar-table"><caption>${escape(start.format("MMMM YYYY"))}</caption><thead><tr>${headings.map(day => `<th scope="col" aria-label="${day}">${day[0]}</th>`).join("")}</tr></thead><tbody><tr>${cells.join("")}</tr></tbody></table><nav class="wp-calendar-nav" aria-label="Calendar navigation">${navigation}</nav></div>`;
}

type RenderPostContent = (post: RenderPost, context: Context) => Promise<string>;
export async function renderWidgetBlock(node: Node, context: Context, state: State, attributes: (extra?: string) => string, renderPostContent: RenderPostContent): Promise<string | undefined> {
  const name = node.name, a = node.attrs, post = context.post;
  if (name === "core/latest-posts") return latestPosts(node, context, state, attributes, renderPostContent);
  if (name === "core/latest-comments") return latestComments(node, state, attributes);
  if (name === "core/archives") return archives(node, state, attributes);
  if (name === "core/calendar") return calendar(node, state, attributes);
  if (name === "core/tag-cloud") return tagCloud(node, state, attributes);
  if (name === "core/query-total") {
    const loop = context.loop; if (!loop) return "";
    const start = loop.total === 0 ? 0 : (loop.page - 1) * loop.perPage + 1, end = Math.min(start + loop.perPage - 1, loop.total);
    const label = a.displayType === "range-display" ? start === end ? `Displaying ${start} of ${loop.total}` : `Displaying ${start} – ${end} of ${loop.total}` : `${loop.total} ${loop.total === 1 ? "result" : "results"} found`;
    return `<div${attributes()}>${label}</div>`;
  }
  if (name === "core/post-time-to-read") return post && !protectedPost(post) ? `<div${attributes()}>${readingTimeText(String(post.rawContent || post.raw_content || post.content || ""), a)}</div>` : "";
  if (name === "core/post-comments-count" || name === "core/post-comments-link") {
    if (!post?.id || protectedPost(post)) return "";
    const count = await cached(state, `widget-comment-count:${post.id}`, async () => Number((await state.db.query("SELECT count(*)::int AS count FROM comments WHERE post_id=$1 AND status='approved'", [post.id])).rows[0].count));
    if (name === "core/post-comments-count") return `<div${attributes()}>${count}</div>`;
    if ((post.commentStatus ?? post.comment_status) === "closed" || state.settings.closeCommentsDays > 0 && Date.now() - new Date(post.publishedAt || post.published_at || post.createdAt || post.created_at).getTime() > state.settings.closeCommentsDays * 86400000) return "";
    const label = count ? `${count} ${count === 1 ? "comment" : "comments"}` : "No comments";
    return `<div${attributes()}><a href="${escape(await permalink(post, state))}#comments">${label}<span class="screen-reader-text"> on ${escape(post.title)}</span></a></div>`;
  }
  return undefined;
}
