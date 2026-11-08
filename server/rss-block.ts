import { date as formatDate } from "@wordpress/date";
import type { Node, State } from "./block-renderer.js";
import { normalizeFeedURL } from "./rss-transport.js";
import { readFeed, FeedError, type ParsedFeed } from "./rss.js";
const escape = (value: unknown) => String(value ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const integer = (value: unknown, fallback: number, max: number) => typeof value === "number" && Number.isFinite(value) ? Math.min(max, Math.max(1, Math.trunc(value))) : fallback;
export async function renderRSSBlock(node: Node, state: State, attributes: (extra?: string) => string): Promise<string | undefined> {
  if (node.name !== "core/rss") return undefined;
  const a = node.attrs;
  let feed: ParsedFeed;
  try {
    const url = normalizeFeedURL(a.feedURL), key = "rss:" + url.href;
    if (!state.cache.has(key)) state.cache.set(key, readFeed(url, state));
    feed = await state.cache.get(key)!;
  } catch (reason) {
    const message = reason instanceof FeedError ? reason.message : "The feed could not be retrieved.";
    const home = message.startsWith("Adding an RSS feed");
    return `<div class="components-placeholder"><div class="notice notice-error">${home ? escape(message) + ' Try using another block, like the <strong>Latest Posts</strong> block, to list posts from the site.' : '<strong>RSS Error:</strong> ' + escape(message)}</div></div>`;
  }
  if (!feed.items.length) return '<div class="components-placeholder"><div class="notice notice-error">An error has occurred, which probably means the feed is down. Try again later.</div></div>';
  const classes = [a.blockLayout === "grid" ? "is-grid columns-" + integer(a.columns, 2, 6) : "", a.displayDate ? "has-dates" : "", a.displayAuthor ? "has-authors" : "", a.displayExcerpt ? "has-excerpts" : ""].filter(Boolean).join(" ");
  const rel = typeof a.rel === "string" ? a.rel.trim().slice(0, 500) : "";
  const links = `${a.openInNewTab ? ' target="_blank"' : ""}${rel ? ` rel="${escape(rel)}"` : ""}`;
  const items = feed.items.slice(0, integer(a.itemsToShow, 5, 100)).map(item => {
    const title = escape(item.title || "(no title)"), words = item.description.trim().split(/\s+/u), limit = integer(a.excerptLength, 55, 1000);
    const excerpt = item.description ? words.slice(0, limit).join(" ") + (words.length > limit ? " […]" : "") : "";
    const date = item.date && Number.isFinite(Date.parse(item.date)) ? `<time datetime="${escape(formatDate("c", item.date, state.settings.timezone))}" class="wp-block-rss__item-publish-date">${escape(formatDate(state.settings.dateFormat, item.date, state.settings.timezone))}</time> ` : "";
    return `<li class="wp-block-rss__item"><div class="wp-block-rss__item-title">${item.link ? `<a href="${escape(item.link)}"${links}>${title}</a>` : title}</div>${a.displayDate ? date : ""}${a.displayAuthor && item.author ? `<span class="wp-block-rss__item-author">by ${escape(item.author)}</span>` : ""}${a.displayExcerpt && excerpt ? `<div class="wp-block-rss__item-excerpt">${escape(excerpt.replace(/\[\.\.\.\]$/, "[…]"))}</div>` : ""}</li>`;
  });
  return `<ul${attributes(classes)}>${items.join("")}</ul>`;
}
