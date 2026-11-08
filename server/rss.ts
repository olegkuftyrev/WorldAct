import { createHash } from "node:crypto";
import { TextDecoder } from "node:util";
import { XMLParser, XMLValidator } from "fast-xml-parser";
import { DOMParser } from "linkedom";
import { z } from "zod";
import type { State } from "./block-renderer.js";
import { normalizeFeedURL, FeedError, fetchFeedDocument, MAX_FEED_XML_BYTES } from "./rss-transport.js";
import { legacyExcerptSource } from "./legacy-content.js";
import { excerptText } from "./excerpts.js";
import { postPermalink } from "./permalinks.js";
import { protectedPostExcerpt, publicPostTitle } from "./post-passwords.js";
import {observePublicPost,settledPublicReads} from "./public-read-attempt.js";
export { FeedError } from "./rss-transport.js";

export type FeedItem = { title: string; link: string; author: string; date: string | null; description: string };
export type ParsedFeed = { items: FeedItem[] };
const itemSchema = z.object({ title: z.string().max(2000), link: z.string().max(2048), author: z.string().max(500), date: z.string().max(64).nullable(), description: z.string().max(8192) }).strict();
const feedSchema = z.object({ items: z.array(itemSchema).max(200) }).strict();
const MAX_CACHE_BYTES = 256 * 1024;
const asArray = <T>(value: T | T[] | undefined): T[] => value === undefined ? [] : Array.isArray(value) ? value : [value];
const XML_TEXT = Symbol("ordered XML text");
const value = (input: any): string => typeof input === "string" || typeof input === "number" ? String(input) : Array.isArray(input) ? input.map(value).join(" ") : input && typeof input === "object" ? input[XML_TEXT] ?? "" : "";
function orderedXML(nodes: any[]): any {
  const result = Object.create(null); let text = "";
  for (const node of nodes) for (const [key, children] of Object.entries(node)) {
    if (key === ":@") continue;
    if (key === "#text") { text += String(children); continue; }
    if (["__proto__", "prototype", "constructor"].includes(key)) continue;
    const child = orderedXML(Array.isArray(children) ? children : []);
    Object.assign(child, node[":@"] || {});
    if (result[key] === undefined) result[key] = child;
    else result[key] = [...asArray(result[key]), child];
    text += value(child);
  }
  result[XML_TEXT] = text;
  return result;
}
/** Decode HTML entities and remove markup without loading any resource. */
export function feedText(input: string): string {
  let tags = 0;
  for (let at = input.indexOf("<"); at >= 0; at = input.indexOf("<", at + 1)) if (++tags > 2000) throw new FeedError("The feed text is too complex.");
  const document = new DOMParser().parseFromString("<!doctype html><html><body>" + input + "</body></html>", "text/html");
  for (const node of document.querySelectorAll("script,style,template,iframe,object,embed")) node.remove();
  return (document.body.textContent || "").replace(/\s+/gu, " ").trim();
}
function feedLink(input: unknown, base: string): string {
  const raw = value(input).trim();
  if (!raw || /[\u0000-\u0020\u007f\\]/.test(raw) || /^(?:javascript|data|file|ftp):/i.test(raw)) return "";
  try { const url = new URL(raw, base); if (!["https:", "http:"].includes(url.protocol) || url.username || url.password) return ""; return url.href.length <= 2048 ? url.href : ""; } catch { return ""; }
}
function xmlText(buffer: Buffer): string {
  try {
    let encoding = "utf-8", input = buffer;
    if (buffer[0] === 0xff && buffer[1] === 0xfe) { encoding = "utf-16le"; input = buffer.subarray(2); }
    else if (buffer[0] === 0xfe && buffer[1] === 0xff) { encoding = "utf-16be"; input = buffer.subarray(2); }
    else if (buffer[0] === 0x3c && buffer[1] === 0) encoding = "utf-16le";
    else if (buffer[0] === 0 && buffer[1] === 0x3c) encoding = "utf-16be";
    else {
      const declared = /^\s*<\?xml[^>]*encoding=["']([a-zA-Z0-9-]{1,40})["']/i.exec(buffer.subarray(0, 512).toString("latin1"))?.[1];
      if (declared) encoding = declared;
    }
    const text = new TextDecoder(encoding, { fatal: true }).decode(input);
    return text;
  } catch { throw new FeedError("The feed uses invalid or unsupported text encoding."); }
}
function boundXML(xml: string) {
  if (Buffer.byteLength(xml) > MAX_FEED_XML_BYTES || /<!DOCTYPE|<!ENTITY/i.test(xml)) throw new FeedError("The feed XML is unsafe or too large.");
  let depth = 0, nodes = 0, previous = 0;
  // Bound parsing before calling a tree parser, ignoring CDATA/comment text.
  const tags = /<!\[CDATA\[[\s\S]*?\]\]>|<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<\/?[^>]+>/g;
  for (const match of xml.matchAll(tags)) {
    if (xml.slice(previous, match.index).includes("<")) throw new FeedError("The feed XML is invalid.");
    previous = match.index! + match[0].length;
    if (/^<!\[CDATA\[|^<!--|^<\?/.test(match[0])) continue;
    if (/^<!/.test(match[0]) || ++nodes > 10000) throw new FeedError("The feed XML is too complex.");
    if (/^<\//.test(match[0])) depth--; else if (!/\/\s*>$/.test(match[0])) depth++;
    if (depth < 0 || depth > 40) throw new FeedError("The feed XML is too complex.");
  }
  if (xml.slice(previous).includes("<") || depth !== 0 || XMLValidator.validate(xml) !== true) throw new FeedError("The feed XML is invalid.");
}
export function parseFeedDocument(buffer: Buffer, base: string): ParsedFeed {
  if (buffer.length > MAX_FEED_XML_BYTES) throw new FeedError("The feed XML is too large.");
  const xml = xmlText(buffer); boundXML(xml);
  let source: any;
  try { source = orderedXML(new XMLParser({ preserveOrder: true, ignoreAttributes: false, parseTagValue: false, parseAttributeValue: false, trimValues: false, processEntities: true, removeNSPrefix: true, htmlEntities: false }).parse(xml)); } catch { throw new FeedError("The feed XML is invalid."); }
  const atom = source.feed, rss = source.rss?.channel, rdf = source.RDF;
  if (!atom && !rss && !rdf) throw new FeedError("This URL does not contain an RSS or Atom feed.");
  const entries = asArray<any>(atom ? atom.entry || atom["atom:entry"] : rss ? rss.item : rdf.item).slice(0, 200);
  const items: FeedItem[] = [];
  for (const entry of entries) {
    if (!entry || typeof entry !== "object") continue;
    const read = (key: string) => value(entry[key] ?? entry[key.split(":").at(-1)!]);
    const links = asArray<any>(entry.link || entry["atom:link"]);
    const alternate = links.find(link => typeof link === "object" && (!link["@_rel"] || link["@_rel"] === "alternate") && (!link["@_type"] || link["@_type"] === "text/html"));
    const rawLink = atom ? alternate?.["@_href"] || links.find(link => typeof link === "string") : entry.link || (entry.guid?.["@_isPermaLink"] !== "false" ? entry.guid : "");
    const author = atom ? asArray<any>(entry.author || atom.author)[0] : entry.creator ?? entry.author;
    const rawDate = atom ? read("published") || read("updated") : read("pubDate") || read("dc:date");
    const date = rawDate ? new Date(rawDate) : null;
    const item: FeedItem = { title: feedText(read("title")).slice(0, 2000) || "(no title)", link: feedLink(rawLink, base), author: feedText(atom ? value(author?.name || author?.["atom:name"]) : value(author)).slice(0, 500), date: date && Number.isFinite(date.valueOf()) && date.getUTCFullYear() >= 1 && date.getUTCFullYear() <= 9999 ? date.toISOString() : null, description: feedText(atom ? read("summary") || read("content") : read("description") || read("content:encoded")).slice(0, 8192) };
    items.push(item);
  }
  const result = { items };
  if (Buffer.byteLength(JSON.stringify(result)) > MAX_CACHE_BYTES) throw new FeedError("The feed contains too much text.");
  return result;
}
const internalPaths = new Set(["/feed", "/feed/", "/feed/rss2", "/feed/rss2/", "/feed/atom", "/feed/atom/", "/rss.xml", "/atom.xml"]);
export function ownFeedOrigins(settings: State["settings"]): Set<string> {
  const origins = new Set<string>();
  for (const input of [settings.siteUrl, process.env.APP_ORIGIN]) if (input) try { origins.add(normalizeFeedURL(input).origin); } catch { /* Invalid configuration has no privileged internal origin. */ }
  return origins;
}
export async function readInternalFeed(url: URL, state: State): Promise<ParsedFeed | null> {
  if (!ownFeedOrigins(state.settings).has(url.origin)) return null;
  const home = new URL(state.settings.siteUrl);
  if ((!url.search && url.pathname.replace(/\/$/, "") === home.pathname.replace(/\/$/, "")) || (!url.search && url.pathname === "/")) throw new FeedError("Adding an RSS feed to this site’s homepage is not supported, as it could lead to a loop that slows down your site.");
  const legacyQuery = url.pathname === "/" && url.searchParams.size === 1 && ["rss", "rss2", "atom"].includes(url.searchParams.get("feed") || "");
  if ((!internalPaths.has(url.pathname) || url.search) && !legacyQuery) throw new FeedError("This site URL is not a supported internal feed.");
  const rows = (await state.db.query(`SELECT p.id,p.type,p.title,p.slug,p.author_id AS "authorId",p.published_at AS "publishedAt",p.created_at AS "createdAt",p.parent_id AS "parentId",p.content,p.raw_content AS "rawContent",p.blocks,p.excerpt,(p.password_hash IS NOT NULL) AS "hasPassword",u.display_name AS "authorName",COALESCE((SELECT json_agg(json_build_object('taxonomy',t.taxonomy,'slug',t.slug) ORDER BY t.name,t.id) FROM post_terms pt JOIN terms t ON t.id=pt.term_id WHERE pt.post_id=p.id),'[]'::json) AS terms FROM posts p JOIN users u ON u.id=p.author_id WHERE p.type='post' AND p.status='publish' ORDER BY p.published_at DESC,p.id DESC LIMIT $1`, [Math.min(200, state.settings.feedItems)])).rows;
  return { items: await settledPublicReads(rows.map(async post => {
    // Local feeds never forward grants: protected entries expose only the
    // generic excerpt, while public excerpts carry their complete body policy.
    if(!state.options.preview)observePublicPost(state.options.canReadProtectedPost,{...post,locked:false},!post.hasPassword);
    return { title: String(publicPostTitle(post)), author: String(post.authorName || ""), link: new URL(await postPermalink(post, state.settings, state.db), state.settings.siteUrl).href, date: new Date(post.publishedAt || post.createdAt).toISOString(), description: post.hasPassword ? protectedPostExcerpt : String(post.excerpt || excerptText(legacyExcerptSource(post))).slice(0, 400) };
  })) };
}
const inflight = new Map<string, Promise<ParsedFeed>>();
export type FeedServiceOptions = { transport?: typeof fetchFeedDocument; now?: () => number };
export function createFeedService(options: FeedServiceOptions = {}) {
  const transport = options.transport || fetchFeedDocument, now = options.now || Date.now;
  return async (url: URL, state: State): Promise<ParsedFeed> => {
    const internal = await readInternalFeed(url, state); if (internal) return internal;
    const key = createHash("sha256").update(url.href).digest("hex");
    const cached = (await state.db.query("SELECT data,error FROM rss_feed_cache WHERE cache_key=$1 AND expires_at>now()", [key])).rows[0];
    if (cached?.error) throw new FeedError(String(cached.error).slice(0, 300));
    const parsed = feedSchema.safeParse(cached?.data); if (parsed.success) return parsed.data;
    const existing = inflight.get(url.href); if (existing) return existing;
    if ((state.rssRequests || 0) >= 4) throw new FeedError("This page has reached its feed request limit."); state.rssRequests = (state.rssRequests || 0) + 1;
    if (inflight.size >= 68) throw new FeedError("Feed requests are busy. Try again later.");
    // Keep the promise through its cache write: a second cache miss arriving
    // just after the download must not start another network request.
    const pending = (async () => {
      let feed: ParsedFeed | null = null, error = "";
      try { const response = await transport(url.href, ownFeedOrigins(state.settings)); feed = parseFeedDocument(response.body, response.url); } catch (reason) { error = (reason instanceof FeedError ? reason.message : "The feed could not be retrieved.").slice(0, 300); }
      const data = feed ? JSON.stringify(feed) : null, bytes = data ? Buffer.byteLength(data) : 0;
      await state.db.query("INSERT INTO rss_feed_cache(cache_key,url,data,error,bytes,expires_at) VALUES($1,$2,$3::jsonb,$4,$5,$6) ON CONFLICT(cache_key) DO UPDATE SET data=excluded.data,error=excluded.error,bytes=excluded.bytes,fetched_at=now(),expires_at=excluded.expires_at", [key, url.href, data, error, bytes, new Date(now() + (error ? 60000 : 12 * 60 * 60 * 1000))]);
      await state.db.query("DELETE FROM rss_feed_cache WHERE expires_at<=now() OR cache_key IN (SELECT cache_key FROM (SELECT cache_key,row_number() OVER(ORDER BY fetched_at DESC,cache_key) AS n,sum(bytes) OVER(ORDER BY fetched_at DESC,cache_key) AS size FROM rss_feed_cache) ranked WHERE n>256 OR size>33554432)");
      if (error) throw new FeedError(error);
      return feed!;
    })();
    inflight.set(url.href, pending); void pending.finally(() => { if (inflight.get(url.href) === pending) inflight.delete(url.href); }).catch(() => {});
    return pending;
  };
}
export const readFeed = createFeedService();
