import { pool, getSettings } from "./db.js";
import type pg from "pg";
import { readPlainPermalinkQuery } from "../shared/plain-permalink-query.js";
import { readPublicPath } from "./public-path.js";
type Database = Pick<pg.Pool, "query"> | pg.PoolClient;
type Settings = Awaited<ReturnType<typeof getSettings>>;
const segment = (value: string) => encodeURIComponent(value);
/** Select the source's lowest-ID assigned category and its ancestors in one
 * statement snapshot. Supplied DTO terms can be partial or stale. UNION visits
 * each persisted ancestor once, including malformed historical cycles. */
export async function categoryPermalinkPath(
  postId: number,
  settings: Settings,
  db: Database = pool,
): Promise<string> {
  const rows = (await db.query(`WITH RECURSIVE
    chosen AS (
      SELECT t.id,t.slug,t.parent_id FROM terms t JOIN post_terms pt ON pt.term_id=t.id
      WHERE pt.post_id=$1 AND t.taxonomy='category' ORDER BY t.id LIMIT 1
    ),
    fallback AS (
      SELECT t.id,t.slug,NULL::integer AS parent_id FROM terms t
      WHERE t.taxonomy='category' AND NOT EXISTS(SELECT 1 FROM chosen)
      ORDER BY (t.id=$2) DESC NULLS LAST,t.is_default DESC,t.id LIMIT 1
    ),
    selected AS (SELECT * FROM chosen UNION ALL SELECT * FROM fallback),
    ancestors AS (
      SELECT id,slug,parent_id FROM selected
      UNION
      SELECT t.id,t.slug,t.parent_id
      FROM terms t JOIN ancestors a ON t.id=a.parent_id
      WHERE t.taxonomy='category'
    ) SELECT ancestors.*,selected.id AS "selectedId" FROM ancestors CROSS JOIN selected`,[postId,settings.defaultCategoryId])).rows;
  const byId=new Map(rows.map(row=>[row.id,row])),seen=new Set<number>(),slugs:string[]=[];
  let current=rows.length?byId.get(rows[0].selectedId):undefined;
  while(current&&!seen.has(current.id)){
    seen.add(current.id);slugs.push(segment(current.slug));current=byId.get(current.parent_id);
  }
  return slugs.length ? slugs.reverse().join("/") : "uncategorized";
}
export async function postPermalink(
  post: Record<string, any>,
  settings?: Settings,
  db: Database = pool,
): Promise<string> {
  settings ??= await getSettings(db);
  if (post.type === "page") {
    if (settings.frontPageMode === "page" && settings.frontPageId === post.id)
      return "/";
    if (!settings.permalinkStructure) return "/?page_id="+post.id;
    const slugs = [post.slug],
      seen = new Set<number>([post.id]);
    let parent = post.parentId ?? post.parent_id;
    while (parent && slugs.length < 30 && !seen.has(parent)) {
      seen.add(parent);
      const result = await db.query(
        "SELECT id,slug,parent_id FROM posts WHERE id=$1 AND type='page'",
        [parent],
      );
      const row = result.rows[0];
      if (!row) break;
      slugs.unshift(row.slug);
      parent = row.parent_id;
    }
    return "/" + slugs.map(segment).join("/") + (settings.permalinkStructure.endsWith("/")?"/":"");
  }
  if (!settings.permalinkStructure) return "/?p="+post.id;
  const date = new Date(
    post.publishedAt ??
      post.published_at ??
      post.createdAt ??
      post.created_at ??
      Date.now(),
  );
  const parts = new Intl.DateTimeFormat("en", {
    timeZone: settings.timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const values: Record<string, string> = {
    postname: segment(post.slug),
    post_id: String(post.id),
    year: parts.find((p) => p.type === "year")!.value,
    monthnum: parts.find((p) => p.type === "month")!.value,
    day: parts.find((p) => p.type === "day")!.value,
    category: settings.permalinkStructure.includes("%category%")
      ? await categoryPermalinkPath(post.id,settings,db) : "",
  };
  return settings.permalinkStructure.replace(
    /%(postname|post_id|year|monthnum|day|category)%/g,
    (_match, key: string) => values[key],
  );
}
export async function withPermalink<T extends Record<string, any>>(
  post: T,
  settings?: Settings,
  db: Database = pool,
) {
  return { ...post, permalink: await postPermalink(post, settings, db) };
}
async function resolveExactPublicPath(path: string, settings: Settings) {
  const normalized = "/" + path.split("?")[0].replace(/^\/+|\/+$/g, "") + "/";
  if (normalized === "//" || normalized === "/") {
    if (settings.frontPageMode === "page" && settings.frontPageId) {
      const row = await pool.query(
        "SELECT id,slug FROM posts WHERE id=$1 AND type='page' AND status='publish'",
        [settings.frontPageId],
      );
      return row.rows[0] ?? null;
    }
    return null;
  }
  const escaped = settings.permalinkStructure.replace(
    /[.*+?^${}()|[\]\\]/g,
    "\\$&",
  );
  const tokens: string[] = [];
  const pattern = escaped.replace(
    /%(postname|post_id|year|monthnum|day|category)%/g,
    (_match, key: string) => {
      tokens.push(key);
      return key === "category" ? "(.+?)" : key === "postname" ? "([^/]+)" : "(\\d+)";
    },
  );
  const match = new RegExp("^" + (pattern.endsWith("/") ? pattern.slice(0,-1) : pattern) + "/?$").exec(
    normalized,
  );
  if (match) {
    const captures = Object.fromEntries(
      tokens.map((token, index) => [
        token,
        decodeURIComponent(match[index + 1]),
      ]),
    );
    let rows: any[] = [];
    if (
      captures.post_id &&
      (!/^[1-9]\d{0,9}$/.test(captures.post_id) ||
        Number(captures.post_id) > 2_147_483_647)
    )
      return null;
    if (captures.post_id)
      rows = (
        await pool.query(
          "SELECT id,slug,type,published_at AS \"publishedAt\",created_at AS \"createdAt\" FROM posts WHERE id=$1 AND type='post' AND status='publish'",
          [Number(captures.post_id)],
        )
      ).rows;
    else if (captures.postname)
      rows = (
        await pool.query(
          "SELECT id,slug,type,published_at AS \"publishedAt\",created_at AS \"createdAt\" FROM posts WHERE slug=$1 AND type='post' AND status='publish'",
          [captures.postname],
        )
      ).rows;
    for (const row of rows) {
      if ((await postPermalink(row, settings)).replace(/\/$/,"") === normalized.replace(/\/$/,"")) return row;
    }
  }
  // Page hierarchy is resolved segment by segment, never by an ambiguous final slug.
  let parent: number | null = null;
  let current: any;
  for (const part of normalized.split("/").filter(Boolean)) {
    const slug = decodeURIComponent(part);
    const rows = await pool.query(
      "SELECT id,slug,parent_id,status FROM posts WHERE type='page' AND slug=$1 AND parent_id IS NOT DISTINCT FROM $2",
      [slug, parent],
    );
    current = rows.rows[0];
    if (!current) return null;
    parent = current.id;
  }
  if (current?.status === "publish") return current;
  return null;
}
/** Exact post/page identities win before the source's numeric content-page suffix. */
export async function resolvePublicPath(path: string) {
  readPublicPath(path);
  let rootContentPage:number|undefined;
  const queryIndex=path.indexOf("?");
  if(queryIndex>=0){
    const identity=readPlainPermalinkQuery(new URLSearchParams(path.slice(queryIndex+1)));
    if(identity.kind!=="none"){
      if(path.slice(0,queryIndex)!=="/"||!("id" in identity))return null;
      const rows=(await pool.query("SELECT id,slug,type FROM posts WHERE id=$1 AND type=$2 AND status='publish'",[identity.id,identity.kind])).rows;
      const post=rows[0];if(!post)return null;
      return identity.contentPage?{...post,contentPage:identity.contentPage}:post;
    }
    if(path.slice(0,queryIndex)==="/"){
      const query=new URLSearchParams(path.slice(queryIndex+1));
      if([...query.keys()].some(key=>/^page(?:\[|$)/.test(key))){
        const pages=query.getAll("page");
        if(pages.length!==1||!pages[0]||!/^[1-9]\d{0,9}$/.test(pages[0])||Number(pages[0])>2147483647||[...query.keys()].some(key=>/^page\[/.test(key)))return null;
        rootContentPage=Number(pages[0]);
      }
    }
  }
  const settings = await getSettings(), exact = await resolveExactPublicPath(path, settings);
  if (exact) return rootContentPage ? {...exact,contentPage:rootContentPage} : exact;
  const normalized = "/" + path.split("?")[0].replace(/^\/+|\/+$/g, "") + "/";
  const suffix = /^(.*\/)([1-9]\d{0,9})\/$/.exec(normalized);
  if (!suffix || Number(suffix[2]) > 2147483647) return null;
  const front = /^\/page\/[1-9]\d*\/$/.test(normalized) && settings.frontPageMode === "page" && settings.frontPageId;
  const post = await resolveExactPublicPath(front ? "/" : suffix[1], settings);
  return post ? { ...post, contentPage: Number(suffix[2]) } : null;
}
