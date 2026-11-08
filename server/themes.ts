import type pg from "pg";
import { parse } from "@wordpress/block-serialization-default-parser";
import bundledData from "../src/theme-source/bundled.json";
import { compileThemeStyles, mergeThemeJSON, type ThemeJSON, type ThemeStyleOverrides } from "../src/themeStyles.js";
import { pool, getSettings } from "./db.js";
import { cleanContent, cleanRawContent, HttpError } from "./utils.js";
import { styleSchema } from "./site-validation.js";
import { injectFontLibrary } from "./fonts.js";
import { sourceTemplatePartArea } from "../shared/template-areas.js";

type Database = Pick<pg.Pool, "query"> | pg.PoolClient;
export const themeIds = ["twentytwentyfive", "twentytwentyfour", "twentytwentythree", "classic"] as const;
export type ThemeId = typeof themeIds[number];
export interface ThemeDocumentSource {
  slug: string; title: string; content: string; description: string;
  categories: string[]; blockTypes: string[]; inserter: boolean;
  source: string; sourceHash: string;
}
export interface BundledTheme {
  id: string; name: string; version: string; description: string;
  themeJSON: ThemeJSON;
  templates: ThemeDocumentSource[]; parts: ThemeDocumentSource[]; patterns: ThemeDocumentSource[];
  variations: Array<{slug: string; title: string; type: string; data: ThemeJSON}>;
  sourceFiles: Array<{path: string; sha256: string}>;
}
export const bundledThemes = bundledData as BundledTheme[];
export function getBundledTheme(id: string) {
  return bundledThemes.find((theme) => theme.id === id);
}
export function getThemeVariation(theme: string, slug: string) {
  if (!slug) return undefined;
  return getBundledTheme(theme)?.variations.find((variation) => variation.slug === slug && variation.type === "theme");
}
export function validateThemeDesign(theme: string, input: unknown) {
  if (!themeIds.includes(theme as ThemeId)) throw new HttpError(400, "Unknown theme.");
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new HttpError(400, "Invalid theme design.");
  const record = input as Record<string, unknown>;
  if (Object.keys(record).some((key) => !["theme", "variation", "styles", "updated_at", "updatedAt"].includes(key))) throw new HttpError(400, "Invalid theme design field.");
  const variation = record.variation === undefined ? "" : record.variation;
  if (typeof variation !== "string" || (variation && !getThemeVariation(theme, variation))) throw new HttpError(400, "Unknown style variation for this theme.");
  return {theme, variation, styles: styleSchema.parse(record.styles || {})};
}
export const bundledThemeRegistry = bundledThemes.map((theme) => ({
  id: theme.id, name: theme.name, version: theme.version, description: theme.description,
  templateCount: theme.templates.length, partCount: theme.parts.length, patternCount: theme.patterns.length,
  variations: theme.variations.filter((item) => item.type === "theme").map(({slug,title}) => ({slug,title})),
}));
export function resolveThemeJSON(theme: string, variation = "") {
  const bundled = getBundledTheme(theme);
  if (!bundled) return null;
  const selected = getThemeVariation(theme, variation);
  return selected ? mergeThemeJSON(bundled.themeJSON, selected.data) : bundled.themeJSON;
}
export async function readThemeDesign(theme?: string, database: Database = pool) {
  const active = theme || (await getSettings(database)).theme;
  const selected = await database.query("SELECT variation,styles FROM theme_designs WHERE theme=$1", [active]);
  const saved = selected.rows[0] || {variation: "", styles: {}};
  const sourceJSON = resolveThemeJSON(active, saved.variation);
  const fontJSON = await injectFontLibrary(sourceJSON || {settings:{typography:{fontFamilies:[]}}}, active, database);
  const themeJSON = sourceJSON ? fontJSON : null;
  const source = getBundledTheme(active);
  return {
    id: active, name: source?.name || "WorldAct Classic", version: source?.version || "1.0.0",
    variation: saved.variation, variations: source?.variations.filter((item) => item.type === "theme").map(({slug,title}) => ({slug,title})) || [],
    styles: saved.styles as ThemeStyleOverrides,
    themeJSON,
    css: compileThemeStyles(fontJSON, ".worldact-theme", saved.styles),
    fonts: (fontJSON.settings?.typography?.fontFamilies || []).filter((family:ThemeJSON) => String(family.slug).startsWith("worldact-font-")),
  };
}
function canonicalBlocks(content: string): unknown[] {
  const convert = (items: any[]): unknown[] => items.filter((item) => item.blockName).map((item) => ({name: item.blockName, attributes: item.attrs || {}, innerBlocks: convert(item.innerBlocks || [])}));
  return convert(parse(content));
}
const legacyDefaults = new Set([
  '<header class="site-header"><div class="site-title">{{siteTitle}}</div><nav>{{navigation}}</nav></header>',
  '<footer class="site-footer"><strong>{{siteTitle}}</strong><p>{{tagline}}</p><p>Designed with WorldAct</p></footer>',
  '<article class="single-post"><h1>{{postTitle}}</h1><p class="post-meta">{{postDate}} · {{postAuthor}}</p><div class="public-content">{{content}}</div></article>',
  '<article class="single-post"><h1>{{postTitle}}</h1><div class="public-content">{{content}}</div></article>',
  '<main class="site-main"><h1>Blog</h1>{{postList}}</main>',
]);
/** Called inside migrate's existing transaction. Does not overwrite edited content. */
export async function syncBundledThemes(database: Database = pool) {
  for (const theme of bundledThemes) {
    for (const [key, type] of [["templates", "template"], ["parts", "template-part"], ["patterns", "pattern"]] as const) {
      for (const source of theme[key]) {
        const canonical = cleanRawContent(source.content);
        // A few source filenames differ from their declared pattern slugs. Remove
        // only untouched rows created by the earlier filename-based importer.
        await database.query("DELETE FROM site_documents WHERE theme=$1 AND type=$2 AND slug<>$3 AND source_hash=$4 AND source_metadata->>'source'=$5 AND raw_content=source_content AND (type<>'template-part' OR area=COALESCE(source_metadata->>'area',area))",[theme.id,type,source.slug,source.sourceHash,source.source]);
        const previous = await database.query("SELECT id,content,raw_content,source_hash,source_content,source_metadata,area FROM site_documents WHERE theme=$1 AND type=$2 AND slug=$3", [theme.id,type,source.slug]);
        const row = previous.rows[0];
        const area=type==='template-part'?sourceTemplatePartArea(theme.themeJSON,source.slug):'uncategorized';
        // Introduce trusted source area metadata once, including edited source
        // content. Subsequent migrations preserve deliberate area changes.
        if(type==='template-part' && row?.source_hash && row.source_metadata?.area === undefined){
          await database.query("UPDATE site_documents SET area=$2::varchar,source_metadata=source_metadata || jsonb_build_object('area',$2::varchar) WHERE id=$1",[row.id,area]);
          row.area=area;row.source_metadata={...row.source_metadata,area};
        }
        if (row && row.source_hash === source.sourceHash) continue;
        if (row && !(row.source_content && row.raw_content === row.source_content) && !legacyDefaults.has(row.content)) continue;
        if(row && type==='template-part' && row.source_hash && row.area !== row.source_metadata?.area)continue;
        const metadata = {description:source.description,categories:source.categories,blockTypes:source.blockTypes,inserter:source.inserter,source:source.source,...(type==='template-part'?{area}: {})};
        await database.query(`INSERT INTO site_documents(theme,slug,title,type,content,raw_content,blocks,source_hash,source_content,source_metadata,area)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$6,$9,$10)
          ON CONFLICT(theme,type,slug) DO UPDATE SET title=excluded.title,content=excluded.content,raw_content=excluded.raw_content,blocks=excluded.blocks,source_hash=excluded.source_hash,source_content=excluded.source_content,source_metadata=excluded.source_metadata,area=excluded.area,version=site_documents.version+1,updated_at=now()`,
          [theme.id,source.slug,source.title,type,cleanContent(source.content),canonical,JSON.stringify(canonicalBlocks(canonical)),source.sourceHash,JSON.stringify(metadata),area]);
      }
    }
  }
}

/** A trusted source reset; imported metadata cannot designate arbitrary content as bundled. */
export async function resetBundledDocument(id: number, database: Database = pool) {
  const existing = await database.query("SELECT theme,type,slug FROM site_documents WHERE id=$1", [id]);
  const row = existing.rows[0];
  const theme = row ? getBundledTheme(String(row.theme)) : undefined;
  const sources = row?.type === "template" ? theme?.templates : row?.type === "template-part" ? theme?.parts : theme?.patterns;
  const source = sources?.find((item) => item.slug === row.slug);
  if (!source) throw new HttpError(404, "This design has no bundled original.");
  const canonical = cleanRawContent(source.content);
  const area=row.type==='template-part'?sourceTemplatePartArea(theme!.themeJSON,row.slug):'uncategorized';
  const metadata = {description:source.description,categories:source.categories,blockTypes:source.blockTypes,inserter:source.inserter,source:source.source,...(row.type==='template-part'?{area}: {})};
  const result = await database.query(`UPDATE site_documents SET title=$2,content=$3,raw_content=$4,blocks=$5::jsonb,source_hash=$6,source_content=$4,source_metadata=$7::jsonb,area=$8,version=version+1,updated_at=now() WHERE id=$1
    RETURNING id,slug,title,type,theme,area,content,raw_content AS "rawContent",blocks,source_metadata AS "sourceMetadata",version,updated_at AS "updatedAt"`,
    [id,source.title,cleanContent(source.content),canonical,JSON.stringify(canonicalBlocks(canonical)),source.sourceHash,JSON.stringify(metadata),area]);
  return result.rows[0];
}
