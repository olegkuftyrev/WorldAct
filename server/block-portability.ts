import { parse } from "@wordpress/block-serialization-default-parser";
import { cleanBlocks, cleanContent, cleanRawContent, HttpError, type StoredBlock } from "./utils.js";
import { remapShortcodeReferences } from "./shortcode-portability.js";
import { contentPageURL } from "./legacy-content.js";

export type ImportedBodyPages = {
  target: string;
  totalPages: number;
  targetPost: { id: number; status: "publish" };
  permalinkStructure: string;
};

export type ImportedBlockEntity = {
  id: number;
  kind: "reusable" | "navigation";
};
export type BlockReferenceOptions = {
  documents?: ReadonlyMap<string, string>;
  documentTheme?: string;
  media?: ReadonlyMap<number, number>;
  posts?: ReadonlyMap<number, number>;
  terms?: ReadonlyMap<number, number>;
  authors?: ReadonlyMap<number, number>;
  urls?: ReadonlyMap<string, string>;
  bodyPages?: ReadonlyMap<string, ImportedBodyPages>;
  detachMissingShortcodeMediaURLs?: boolean;
  fontFamilies?: ReadonlyMap<string, string | null>;
  fontSlugs?: ReadonlyMap<string, string | null>;
  footnotes?: ReadonlyMap<string, string>;
  footnoteSelfURLs?: ReadonlySet<string>;
};

function mappedContinuation(target:string,continuation:string):string|null {
  if(!target.includes("?")||!continuation.startsWith("?"))return target+continuation;
  const hash=continuation.indexOf("#"),query=continuation.slice(1,hash<0?undefined:hash);
  const decodeSeparators=(value:string)=>value.replace(/&(?:amp|#38|#x26);/gi,"&");
  const existing=new URLSearchParams(decodeSeparators(target.slice(target.indexOf("?")+1)));
  const params=new URLSearchParams(decodeSeparators(query));
  // Do not introduce a second fixed identity or a duplicate body-page counter.
  if([...params.keys()].some(key=>/^(?:p|page_id)(?:\[|$)/.test(key)||existing.has("page")&&/^page(?:\[|$)/.test(key)))return null;
  return target+"&"+query+(hash<0?"":continuation.slice(hash));
}

/** Apply one known identity mapping. Complete canonicals across the entire map
 * win before a numeric suffix can be interpreted as a singular body page. */
export function remapImportedURL(token:string,mappings:readonly (readonly [string,string])[],bodyPages?:ReadonlyMap<string,ImportedBodyPages>) {
  let complete: readonly [string,string] | undefined;
  for(const mapping of mappings){
    const [source]=mapping;
    if(!source)continue;
    if(token===source)return mapping[1];
    if(token.startsWith(source)&&(/^[?#&]/.test(token.slice(source.length))||/^\)+[,.;]?$/.test(token.slice(source.length)))&&(!complete||source.length>complete[0].length))complete=mapping;
  }
  if(complete)return mappedContinuation(complete[1],token.slice(complete[0].length))??token;
  if(!bodyPages?.size)return token;
  const match=/^([^?#]+\/)([1-9]\d{0,9})\/?((?:\?[^#]*)?(?:#.*)?)$/.exec(token);
  if(!match)return token;
  const page=Number(match[2]);
  if(page<2||page>2147483647)return token;
  const pathname=token.split(/[?#]/,1)[0];
  // A known numeric child's alternate trailing slash must not become its
  // parent's body page. Existing exact canonical matching remains authoritative.
  if(mappings.some(([source])=>source&&!/[?#]/.test(source)&&source.replace(/\/$/,"")===pathname.replace(/\/$/,"")))return token;
  const canonical=bodyPages.has(match[1])?match[1]:match[1].slice(0,-1), metadata=bodyPages.get(canonical);
  if(!metadata||page>metadata.totalPages||!mappings.some(([source,target])=>source===canonical&&target===metadata.target))return token;
  const target=contentPageURL(metadata.targetPost,metadata.target,page,false,metadata.permalinkStructure);
  return mappedContinuation(target,match[3])??token;
}

/** Imported references must resolve only inside the imported entity graph. */
export function remapImportedBlockReferences(
  rawContent: string,
  blocks: unknown,
  entities: ReadonlyMap<number, ImportedBlockEntity>,
  options: BlockReferenceOptions = {},
) {
  const warnings = new Set<string>();
  const warn = (message: string) => { if (warnings.size < 100) warnings.add(message); };
  const fontFamilies = new Map<string, string | null>();
  const fontSlugs = options.fontSlugs;
  for (const [source, target] of options.fontFamilies || []) {
    if (!/^[\p{L}\p{N}][\p{L}\p{N} ._'()-]{0,119}$/u.test(source) || (target !== null && !/^[\p{L}\p{N}][\p{L}\p{N} ._'()-]{0,119}$/u.test(target)))
      throw new HttpError(400, "Invalid imported font family mapping.");
    fontFamilies.set(source.toLowerCase(), target);
  }
  for (const [source, target] of fontSlugs || []) if (!/^[a-z0-9][a-z0-9-]{0,159}$/.test(source) || (target !== null && !/^[a-z0-9][a-z0-9-]{0,159}$/.test(target)))
    throw new HttpError(400, "Invalid imported font preset mapping.");
  const mapsFontSlug = (slug: string) => !!fontSlugs && (fontSlugs.has(slug) || /^worldact-font-\d+$/.test(slug));
  const rewriteFontVars = (value: string) => value
    .replace(/var\(--wp--preset--font-family--([a-z0-9-]+)\)/g, (original, slug) => {
      if (!mapsFontSlug(slug)) return original;
      const target = fontSlugs!.get(slug);
      if (target) return `var(--wp--preset--font-family--${target})`;
      warn(`Detached unavailable imported font preset ${slug}.`); return "inherit";
    })
    .replace(/var:preset\|font-family\|([a-z0-9-]+)/g, (original, slug) => {
      if (!mapsFontSlug(slug)) return original;
      const target = fontSlugs!.get(slug);
      if (target) return `var:preset|font-family|${target}`;
      warn(`Detached unavailable imported font preset ${slug}.`); return "inherit";
    });
  const rewriteFontFamily = (value: string) => rewriteFontVars(value).split(",").map(part => {
    const name = part.trim().replace(/&(?:quot|#34|#x22);/gi, '"').replace(/&(?:apos|#39|#x27);/gi, "'").replace(/^(['"])(.*)\1$/, "$2");
    if (!fontFamilies.has(name.toLowerCase())) return part;
    const target = fontFamilies.get(name.toLowerCase());
    if (target) return JSON.stringify(target);
    warn(`Detached unavailable imported font family ${name}.`); return "inherit";
  }).join(",");
  const rewriteFontClasses = (value: string) => value.replace(/\bhas-([a-z0-9-]+)-font-family\b/g, (original, slug) => {
    if (!mapsFontSlug(slug)) return original;
    const target = fontSlugs!.get(slug);
    if (target) return `has-${target}-font-family`;
    warn(`Detached unavailable imported font preset ${slug}.`); return "";
  }).trim();
  const urls = [...(options.urls || [])].sort((a, b) => b[0].length - a[0].length);
  for (const [source, target] of options.footnotes || []) if (!/^[a-z0-9_-]{1,100}$/.test(source) || !/^[a-z0-9_-]{1,100}$/.test(target))
    throw new HttpError(400, "Invalid imported footnote reference mapping.");
  const rewriteText = (value: string, shortcodes = true) => {
    if (shortcodes) value = remapShortcodeReferences(value, options, warn);
    // Match a whole URL, never a local-looking path or mapped origin nested
    // inside an unrelated URL's path/query. Apply each mapping only once.
    // CSS declarations (padding:..., etc.) are not URL schemes. Recognize
    // hierarchical URLs and the opaque schemes used by content separately.
    if (urls.length) value = value.replace(/(?:[a-z][a-z0-9+.-]*:\/\/|\/\/|(?:mailto|tel|data|blob|javascript):)[^\s"'<>]+|(^|[\s"'(=]|&(?:quot|apos|#34|#39|#x22|#x27);)(\/[^\s"'<>),]*)/gi, (match, prefix: string | undefined, local: string | undefined) => {
      const token = local === undefined ? match : local;
      const rewritten = remapImportedURL(token,urls,options.bodyPages);
      return local === undefined ? rewritten : prefix + rewritten;
    });
    if (options.media) value = value.replace(/\bwp-image-(\d+)\b/g, (_match, id) => options.media!.has(Number(id)) ? `wp-image-${options.media!.get(Number(id))}` : "wp-image-missing");
    if (options.footnotes?.size) value = value.replace(/<(?:sup|a)\b[^>]*>/gi, (tag) => tag.replace(/\b(data-fn|id|href)\s*=\s*(["'])([^"']*)\2/gi, (original, field: string, quote: string, input: string) => {
      let hash = "";
      if (field.toLowerCase() === "href") {
        const index = input.lastIndexOf("#");
        if (index < 0) return original;
        const prefix = input.slice(0, index);
        if (prefix && !options.footnoteSelfURLs?.has(prefix)) return original;
        hash = input.slice(0, index + 1);
      }
      const id = hash ? input.slice(hash.length) : input;
      const direct = options.footnotes!.get(id), back = id.endsWith("-link") ? options.footnotes!.get(id.slice(0, -5)) : undefined;
      const target = direct || (back ? back + "-link" : null);
      return target ? `${field}=${quote}${hash}${target}${quote}` : original;
    }));
    if (fontFamilies.size || fontSlugs) value = value
      .replace(/(\bclass\s*=\s*)(["'])([\s\S]*?)\2/gi, (_match, prefix, quote, classes) => prefix + quote + rewriteFontClasses(classes) + quote)
      .replace(/(\bstyle\s*=\s*)(["'])([\s\S]*?)\2/gi, (_match, prefix, quote, style) => prefix + quote + style.replace(/(\bfont-family\s*:\s*)((?:&(?:quot|apos|#39|#34|#x22|#x27);|[^;])*)/gi, (_declaration: string, property: string, family: string) => property + rewriteFontFamily(family).replace(/"/g, "&quot;").replace(/'/g, "&#39;")) + quote);
    return value;
  };
  const rewriteValues = (value: unknown, key = "", shortcodes = true): unknown => {
    if (typeof value === "string") {
      if (key === "className" && fontSlugs) return rewriteFontClasses(value);
      if (key === "fontFamily" && (fontFamilies.size || fontSlugs)) {
        if (mapsFontSlug(value)) {
          const target = fontSlugs!.get(value);
          if (target) return target;
          warn(`Detached unavailable imported font preset ${value}.`); return undefined;
        }
        return rewriteFontFamily(value);
      }
      return rewriteText(value, shortcodes);
    }
    if (Array.isArray(value)) return value.map(item => rewriteValues(item, "", shortcodes));
    if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, rewriteValues(item, key, shortcodes)]).filter(([, item]) => item !== undefined));
    return value;
  };
  const reference = (name: string, attributes: Record<string, unknown>) => {
    attributes = rewriteValues(attributes, "", !["core/math", "core/icon", "core/code", "core/preformatted", "core/verse"].includes(name)) as Record<string, unknown>;
    if(options.documents && name==='core/navigation' && typeof attributes.overlay==='string' && attributes.overlay){
      const overlay=attributes.overlay, separator=overlay.includes('//')?'//':'/';
      const pieces=overlay.split(separator), sourceSlug=pieces.pop() || '';
      const theme=pieces.join(separator) || String(attributes.theme || options.documentTheme || '');
      const target=options.documents.get(`${theme}:template-part:${sourceSlug}`) || (!theme?options.documents.get(`template-part:${sourceSlug}`):undefined);
      if(target)attributes.overlay=theme?`${theme}//${target}`:target;
      else {warn(`Detached navigation overlay ${sourceSlug}: its template part is not included in this import.`);delete attributes.overlay;}
    }
    if (options.documents && ["core/template-part", "core/pattern"].includes(name)) {
      const type = name === "core/template-part" ? "template-part" : "pattern";
      const sourceSlug = String(attributes.slug || "").split("/").pop() || "";
      const prefix = String(attributes.slug || "").split("/")[0];
      const theme = attributes.theme || (["twentytwentyfive", "twentytwentyfour", "twentytwentythree", "classic"].includes(prefix) ? prefix : options.documentTheme || "");
      const target = options.documents.get(`${theme}:${type}:${sourceSlug}`) || (!theme ? options.documents.get(`${type}:${sourceSlug}`) : undefined);
      if (!target) { warn(`Dropped ${name} reference ${sourceSlug}: its document is not included in this import.`); return null; }
      attributes.slug = name === "core/pattern" && theme ? `${theme}/${target}` : target;
      if (name === "core/template-part" && theme) attributes.theme = theme;
    }
    if (options.media) {
      if (name === "core/block") for (const field of ["content", "overrides"]) {
        const content = attributes[field];
        if (!content || typeof content !== "object" || Array.isArray(content)) continue;
        for (const values of Object.values(content)) {
          if (!values || typeof values !== "object" || Array.isArray(values)) continue;
          const item = values as Record<string, any>, target = item.values && typeof item.values === "object" && !Array.isArray(item.values) ? item.values : item;
          if (!Object.hasOwn(target, "id") || !["string", "number"].includes(typeof target.id) || !/^[1-9]\d{0,9}$/.test(String(target.id))) continue;
          const replacement = options.media.get(Number(target.id));
          if (replacement) target.id = replacement;
          else { target.id = 0; warn("Detached missing image id in imported pattern overrides."); }
        }
      }
      if (name === "core/gallery" && Array.isArray(attributes.ids)) attributes.ids = attributes.ids.map(Number).map(id => options.media!.get(id)).filter(Boolean);
      const fields = ["core/image", "core/audio", "core/video", "core/file", "core/cover", "core/playlist-track"].includes(name) ? ["id"] : name === "core/media-text" ? ["mediaId"] : [];
      for (const field of fields) if (attributes[field]) {
        const target = options.media.get(Number(attributes[field]));
        if (target) attributes[field] = target;
        else { warn(`Detached missing media reference ${attributes[field]} in ${name}.`); delete attributes[field]; }
      }
    }
    if (options.posts && name === "core/navigation-link" && attributes.kind === "post-type" && attributes.id) {
      const target = options.posts.get(Number(attributes.id));
      if (target) attributes.id = target;
      else { warn(`Detached missing post reference ${attributes.id} in navigation.`); delete attributes.id; }
    }
    if (name === "core/query" && attributes.query && typeof attributes.query === "object") {
      const query = { ...(attributes.query as Record<string, any>) };
      const mapIds = (value: unknown, map: ReadonlyMap<number, number>) => (Array.isArray(value) ? value : String(value).split(",")).map(Number).map(id => map.get(id)).filter((id): id is number => !!id);
      for (const field of ["include", "exclude", "parents"] as const) if (options.posts && query[field]) {
        if (Array.isArray(query[field]) && !query[field].length) continue;
        const mapped = mapIds(query[field], options.posts);
        if (!mapped.length && field !== "exclude") { warn(`Dropped query with unresolved ${field} post filters.`); return null; }
        query[field] = mapped;
      }
      if (options.authors && query.author) {
        if (Array.isArray(query.author) && !query.author.length) delete query.author;
        else {
        const mapped = mapIds(query.author, options.authors);
        if (!mapped.length) { warn("Dropped query with an unresolved author filter."); return null; }
        query.author = mapped;
        }
      }
      if (options.terms && query.taxQuery) {
        const tax = JSON.parse(JSON.stringify(query.taxQuery));
        for (const group of [tax, tax.include, tax.exclude].filter(Boolean)) for (const field of ["category", "post_tag", "tag"]) if (group[field]) {
          if (Array.isArray(group[field]) && !group[field].length) continue;
          const mapped = mapIds(group[field], options.terms);
          if (!mapped.length && group !== tax.exclude) { warn(`Dropped query with unresolved ${field} term filters.`); return null; }
          group[field] = mapped;
        }
        query.taxQuery = tax;
      }
      attributes.query = query;
    }
    const kind = name === "core/block" ? "reusable" : "navigation";
    if (name !== "core/block" && name !== "core/navigation") return attributes;
    if (name === "core/navigation" && !Object.hasOwn(attributes, "ref"))
      return attributes;
    const value = attributes.ref;
    const sourceId = typeof value === "number" ||
      (typeof value === "string" && /^\d+$/.test(value)) ? Number(value) : 0;
    const target = Number.isSafeInteger(sourceId) && sourceId > 0
      ? entities.get(sourceId)
      : undefined;
    if (target?.kind === kind) return { ...attributes, ref: target.id };
    warn(`Dropped ${name} reference ${sourceId || "without a valid ID"}: its ${kind} entity is not included in this import.`);
    return null;
  };
  const rewriteJSON = (nodes: StoredBlock[]): StoredBlock[] => nodes.flatMap(node => {
    const attributes = reference(node.name, node.attributes);
    return attributes ? [{ ...node, attributes, innerBlocks: rewriteJSON(node.innerBlocks) }] : [];
  });
  const serialize = (node: ReturnType<typeof parse>[number]): string => {
    if (!node.blockName) return rewriteText(node.innerHTML);
    const attributes = reference(node.blockName, node.attrs || {});
    if (!attributes) return "";
    let child = 0;
    const content = node.innerContent.map(fragment => fragment === null
      ? serialize(node.innerBlocks[child++])
      : rewriteText(fragment));
    while (child < node.innerBlocks.length) content.push(serialize(node.innerBlocks[child++]));
    const inner = content.join("");
    const name = node.blockName.replace(/^core\//, "");
    const encoded = Object.keys(attributes).length
      ? " " + JSON.stringify(attributes).replace(/--/g, "\\u002d\\u002d")
        .replace(/</g, "\\u003c").replace(/>/g, "\\u003e").replace(/&/g, "\\u0026")
      : "";
    return inner
      ? `<!-- wp:${name}${encoded} -->${inner}<!-- /wp:${name} -->`
      : `<!-- wp:${name}${encoded} /-->`;
  };
  const safeRaw = cleanRawContent(rawContent);
  const rewrittenRaw = safeRaw.includes("<!-- wp:")
    ? cleanRawContent(parse(safeRaw).map(serialize).join(""))
    : rewriteText(safeRaw);
  const rewrittenBlocks = rewriteJSON(cleanBlocks(blocks ?? []));
  return {
    rawContent: rewrittenRaw,
    content: cleanContent(rewrittenRaw),
    blocks: rewrittenBlocks,
    warnings: [...warnings],
  };
}
