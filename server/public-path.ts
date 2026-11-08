import { pool, getSettings } from "./db.js";
import { appendDateArchiveSQL, dateArchiveDTO, parseDateArchivePath } from "./date-archives.js";
import { readPlainPermalinkQuery } from "../shared/plain-permalink-query.js";
import { HttpError } from "./utils.js";

/** Bound decoding, query parsing and hierarchical lookups before doing DB work. */
export function readPublicPath(path: string) {
  if (path.length > 2000) throw new HttpError(414, "The URL exceeds the supported length.");
  if (!path.startsWith("/") || path.startsWith("//") || /[\0\r\n#]/.test(path))
    throw new HttpError(400, "Use a site-relative path.");
  const queryIndex = path.indexOf("?");
  const pathname = queryIndex < 0 ? path : path.slice(0, queryIndex);
  const rawQuery = queryIndex < 0 ? "" : path.slice(queryIndex + 1);
  let segments: string[];
  try {
    segments = pathname.split("/").filter(Boolean).map(decodeURIComponent);
    // URLSearchParams tolerates malformed percent escapes; public paths do not.
    decodeURIComponent(rawQuery);
  } catch {
    throw new HttpError(400, "The URL path is malformed.");
  }
  if (segments.some(segment => /[\0\r\n]/.test(segment)))
    throw new HttpError(400, "The URL path is malformed.");
  return { pathname, segments, query: new URLSearchParams(rawQuery) };
}

/** The resolver API and Node HTML fallback must agree on archive existence. */
export async function resolvePublicArchive(path: string) {
  const { segments, query } = readPublicPath(path);
  if (readPlainPermalinkQuery(query).kind !== "none") return null;
  const settings = await getSettings();
  const taxonomy = segments[0] === settings.categoryBase ? "category"
    : segments[0] === settings.tagBase ? "tag" : null;
  if (taxonomy && segments.length === 2) {
    const term = (await pool.query(
      "SELECT id,taxonomy,slug,name FROM terms WHERE taxonomy=$1 AND slug=$2",
      [taxonomy, segments[1]],
    )).rows[0];
    if (term) return term;
  }
  const archive = parseDateArchivePath(path);
  if (!archive) return null;
  const args: unknown[] = [], where = ["p.type='post'", "p.status='publish'"];
  appendDateArchiveSQL(where, args, "coalesce(p.published_at,p.created_at)", archive, settings.timezone, settings.weekStartsOn);
  return (await pool.query(
    `SELECT 1 FROM posts p WHERE ${where.map(clause => `(${clause})`).join(" AND ")} LIMIT 1`, args,
  )).rowCount ? dateArchiveDTO(archive) : null;
}
