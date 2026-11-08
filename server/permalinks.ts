import { pool, getSettings } from "./db.js";
import type pg from "pg";
type Database = Pick<pg.Pool, "query"> | pg.PoolClient;
type Settings = Awaited<ReturnType<typeof getSettings>>;
const segment = (value: string) => encodeURIComponent(value);
export async function postPermalink(
  post: Record<string, any>,
  settings?: Settings,
  db: Database = pool,
): Promise<string> {
  settings ??= await getSettings(db);
  if (post.type === "page") {
    if (settings.frontPageMode === "page" && settings.frontPageId === post.id)
      return "/";
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
    return "/" + slugs.map(segment).join("/") + "/";
  }
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
    category: segment(
      post.categories?.[0]?.slug ??
        post.terms?.find((term: any) => term.taxonomy === "category")?.slug ??
        "uncategorized",
    ),
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
      return key === "category" || key === "postname" ? "([^/]+)" : "(\\d+)";
    },
  );
  const match = new RegExp("^" + pattern.replace(/\/$/, "/?") + "$").exec(
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
      const terms = await pool.query(
        "SELECT t.taxonomy,t.slug FROM terms t JOIN post_terms pt ON pt.term_id=t.id WHERE pt.post_id=$1 ORDER BY t.name,t.id",
        [row.id],
      );
      row.terms = terms.rows;
      if ((await postPermalink(row, settings)) === normalized) return row;
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
  const settings = await getSettings(), exact = await resolveExactPublicPath(path, settings);
  if (exact) return exact;
  const normalized = "/" + path.split("?")[0].replace(/^\/+|\/+$/g, "") + "/";
  const suffix = /^(.*\/)([1-9]\d{0,9})\/$/.exec(normalized);
  if (!suffix || Number(suffix[2]) > 2147483647) return null;
  const front = /^\/page\/[1-9]\d*\/$/.test(normalized) && settings.frontPageMode === "page" && settings.frontPageId;
  const post = await resolveExactPublicPath(front ? "/" : suffix[1], settings);
  return post ? { ...post, contentPage: Number(suffix[2]) } : null;
}
