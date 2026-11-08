import { parse } from "@wordpress/block-serialization-default-parser";
import type pg from "pg";
import { pool, getSettings, postFields, postMetadataFields } from "./db.js";
import { postPermalink } from "./permalinks.js";
import { cleanContent, plainText, HttpError } from "./utils.js";
import { restDateToUTC } from "./date.js";
import { date as formatBlockDate, humanTimeDiff } from "@wordpress/date";
import { renderThemeBlock } from "./theme-blocks.js";
import { renderWidgetBlock } from "./widget-blocks.js";
import { renderRSSBlock } from "./rss-block.js";
import { renderTermBlock, type RenderTerm } from "./term-blocks.js";
import { appendDateArchiveSQL, dateArchiveTitle, parseDateArchiveQuery } from "./date-archives.js";
import { gridTemplateColumns, isResponsiveGrid } from "./block-layout.js";
import { backgroundStyles } from "./background-styles.js";
import { renderFootnotes } from "./footnotes.js";
import { excerptText } from "./excerpts.js";
import { renderInteractiveBlock, createInteractiveRenderState, reserveInteractiveId, type InteractiveRenderState, type AccordionContext, type AccordionItemContext, type TabsContext } from "./interactive-blocks.js";
import { postHasPassword, postNeedsPassword, postPasswordForm, protectedPostExcerpt, publicPostTitle } from "./post-passwords.js";
import { renderNavigationWithOverlay, renderNavigationOverlayClose, type NavigationOverlayContext } from "./navigation-overlays.js";
import { hasLegacyContent, legacyExcerptSource, selectLegacyContent, type ContentMode } from "./legacy-content.js";
import { CORE_DYNAMIC_BLOCKS, SUPPORTED_DYNAMIC_BLOCKS, hasDynamicBlocks } from "../shared/dynamic-blocks.js";
import { renderIconBlock } from "./icons.js";
import { renderPlaylistBlock, type PlaylistContext } from "./playlist-blocks.js";
import { prepareShortcodeDocument } from "./shortcodes.js";
import { hasShortcodes } from "./shortcode-parser.js";
import { applyBlockBindings, patternOverrides, type PatternOverrides } from "./block-bindings.js";
import { publicPaginationLocation } from "./public-pagination.js";

export type BlockDatabase = Pick<pg.Pool, "query"> | pg.PoolClient;
export type RenderPost = Record<string, any>;
export type SerializedNode = {
  name: string;
  attributes: Record<string, unknown>;
  innerBlocks: SerializedNode[];
};
export type RenderDocument = {
  id?: number | string;
  slug?: string;
  type?: string;
  theme?: string;
  content?: string;
  rawContent?: string;
  raw_content?: string;
  blocks?: SerializedNode[] | null;
};
export type RenderOptions = {
  post?: RenderPost | null;
  requestPath?: string;
  templateSlug?: string;
  instanceKey?: string;
  query?: Record<string, unknown>;
  page?: number;
  contentPage?: number;
  contentMode?: ContentMode;
  placeholderBindings?: boolean;
  preview?:boolean;
  db?: BlockDatabase;
  user?: { id: number; role: string; displayName: string };
  canReadProtectedPost?: (postId: number, db: BlockDatabase) => Promise<boolean>;
};
export type Node = {
  name: string | null;
  attrs: Record<string, any>;
  children: Node[];
  html?: string;
  fragments?: Array<string | null>;
};
type QueryResult = {
  posts: RenderPost[];
  total: number;
  page: number;
  perPage: number;
  totalPages: number;
  queryId: number;
};
export type Context = {
  post: RenderPost | null;
  loop?: QueryResult;
  depth: number;
  refs: Set<string>;
  contentIds: Set<number>;
  termQuery?: Record<string, any>;
  term?: RenderTerm;
  comment?: Record<string, any>;
  commentDepth?: number;
  commentLoop?: { comments: any[]; total: number; page: number; perPage: number; totalPages: number };
  social?: { openInNewTab: boolean; showLabels: boolean };
  queryDisplayLayout?: { type?: string; columns?: number };
  accordion?: AccordionContext;
  accordionItem?: AccordionItemContext;
  tabs?: TabsContext;
  navigationOverlay?: NavigationOverlayContext;
  playlist?: PlaylistContext;
  patternOverrides?: PatternOverrides;
};
export type State = {
  db: BlockDatabase;
  settings: Awaited<ReturnType<typeof getSettings>>;
  options: RenderOptions;
  nodes: number;
  outputBytes: number;
  queries: number;
  cache: Map<string, Promise<any>>;
  interactive?: InteractiveRenderState;
  rssRequests?: number;
};
export { CORE_DYNAMIC_BLOCKS, SUPPORTED_DYNAMIC_BLOCKS };
const esc = (value: unknown) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ]!,
  );
const integer = (value: unknown, fallback: number, min: number, max: number) =>
  Number.isFinite(Number(value))
    ? Math.max(min, Math.min(max, Math.trunc(Number(value))))
    : fallback;
const ids = (value: unknown): number[] =>
  (Array.isArray(value)
    ? value
    : typeof value === "string"
      ? value.split(",")
      : value === undefined || value === null
        ? []
        : [value]
  )
    .map((v) => Number(v))
    .filter((n) => Number.isSafeInteger(n) && n > 0 && n <= 2147483647)
    .slice(0, 200);
const slug = (value: unknown) =>
  String(value ?? "")
    .replace(/[^a-zA-Z0-9_-]/g, "")
    .slice(0, 100);
const safeTag = (value: unknown, fallback = "div") =>
  [
    "div",
    "main",
    "section",
    "article",
    "aside",
    "header",
    "footer",
    "nav",
    "p",
    "span",
    "h1",
    "h2",
    "h3",
    "h4",
    "h5",
    "h6",
    "ul",
    "ol",
    "li",
  ].includes(String(value))
    ? String(value)
    : fallback;
export const safeBlockURL = (value: unknown) => {
  const url = String(value ?? "").trim();
  return /^(?:https?:\/\/|mailto:|#|\/(?!\/))/i.test(url) &&
    !/[\u0000-\u0020<>"']/.test(url)
    ? url
    : "";
};
function dateValue(post: RenderPost, modified = false) {
  return (
    post[modified ? "updatedAt" : "publishedAt"] ??
    post[modified ? "updated_at" : "published_at"] ??
    post.createdAt ??
    post.created_at
  );
}
function publicPost(post: RenderPost | undefined | null) {
  return (
    !!post &&
    post.status === "publish" &&
    !post.hasPassword &&
    !post.password_hash &&
    !post._passwordHash
  );
}
function classNames(name: string, attrs: Record<string, any>, extra = "") {
  return [
    name ? `wp-block-${name.replace(/^core\//, "").replace("/", "-")}` : "",
    typeof attrs.className === "string"
      ? attrs.className
          .split(/\s+/)
          .filter((name: string) => /^[a-zA-Z_-][a-zA-Z0-9_-]*$/.test(name))
          .join(" ")
      : "",
    attrs.align ? `align${slug(attrs.align)}` : "",
    attrs.textAlign ? `has-text-align-${slug(attrs.textAlign)}` : "",
    attrs.backgroundColor
      ? `has-${slug(attrs.backgroundColor)}-background-color has-background`
      : "",
    backgroundStyles(attrs.style?.background) ? "has-background" : "",
    attrs.textColor ? `has-${slug(attrs.textColor)}-color has-text-color` : "",
    attrs.fontSize ? `has-${slug(attrs.fontSize)}-font-size` : "",
    attrs.fontFamily ? `has-${slug(attrs.fontFamily)}-font-family` : "",
    attrs.layout?.type ? `is-layout-${slug(attrs.layout.type)}${attrs.layout.type === "constrained" ? " has-global-padding" : ""}` : ["core/columns", "core/buttons"].includes(name) ? "is-layout-flex" : "",
    attrs.layout?.type === "grid" ? `wp-block-${name.replace(/^core\//, "").replace("/", "-")}-is-layout-grid${isResponsiveGrid(attrs.layout) ? " has-native-responsive-grid" : ""}` : "",
    extra,
  ]
    .filter(Boolean)
    .join(" ");
}
function blockStyle(attrs: Record<string, any>) {
  const pairs: [string, unknown][] = [];
  const style = attrs.style || {};
  const push = (key: string, value: unknown) => {
    if (typeof value === "string" || typeof value === "number")
      pairs.push([key, value]);
  };
  const size = (value: unknown): unknown =>
    typeof value === "string" && value.startsWith("var:preset|")
      ? `var(--wp--preset--${value.slice(11).replace(/\|/g, "--")})`
      : value;
  for (const [key, value] of Object.entries(style.color || {}))
    if (["text", "background"].includes(key))
      push(key === "text" ? "color" : "background-color", size(value));
  for (const [key, value] of Object.entries(style.typography || {}))
    if (
      [
        "fontSize",
        "lineHeight",
        "fontStyle",
        "fontWeight",
        "fontFamily",
        "letterSpacing",
        "textDecoration",
        "textTransform",
      ].includes(key)
    )
      push(
        key.replace(/[A-Z]/g, (c) => "-" + c.toLowerCase()),
        size(value),
      );
  for (const key of ["margin", "padding"]) {
    const value = style.spacing?.[key];
    if (value && typeof value === "object")
      for (const side of ["top", "right", "bottom", "left"])
        push(`${key}-${side}`, size(value[side]));
    else push(key, size(value));
  }
  if (style.spacing?.blockGap) {
    const gap = style.spacing.blockGap;
    push("gap", typeof gap === "object" ? `${size(gap.top || "0")} ${size(gap.left || gap.top || "0")}` : size(gap));
  }
  if (style.layout?.selfStretch === "fixed" && style.layout.flexSize) {
    push("flex-basis", size(style.layout.flexSize)); push("flex-grow", "0");
  }
  if (style.layout?.selfStretch === "fill") { push("flex-basis", "0"); push("flex-grow", "1"); }
  if (style.layout?.columnSpan) push("grid-column", `span ${integer(style.layout.columnSpan, 1, 1, 12)}`);
  if (style.layout?.rowSpan) push("grid-row", `span ${integer(style.layout.rowSpan, 1, 1, 12)}`);
  for (const field of ["minHeight", "aspectRatio"]) if (style.dimensions?.[field])
    push(field === "minHeight" ? "min-height" : "aspect-ratio", size(style.dimensions[field]));
  for (const key of ["color", "radius", "style", "width"])
    push(
      key === "radius" ? "border-radius" : `border-${key}`,
      size(style.border?.[key]),
    );
  if (attrs.layout?.type === "flex") {
    push("display", "flex");
    push("flex-wrap", attrs.layout.flexWrap || "wrap");
    if (attrs.layout.orientation === "vertical")
      push("flex-direction", "column");
    if (attrs.layout.justifyContent) push("justify-content", ({left:"flex-start",right:"flex-end"} as Record<string,string>)[attrs.layout.justifyContent] || attrs.layout.justifyContent);
    if (attrs.layout.verticalAlignment) push("align-items", ({top:"flex-start",bottom:"flex-end"} as Record<string,string>)[attrs.layout.verticalAlignment] || attrs.layout.verticalAlignment);
  }
  if (attrs.layout?.type === "grid") {
    push("display", "grid");
    push(
      "grid-template-columns",
      gridTemplateColumns(attrs.layout, style.spacing?.blockGap),
    );
  }
  return [pairs.map(([key, value]) => `${key}:${String(value)}`).join(";"),backgroundStyles(style.background)].filter(Boolean).join(";");
}
function attrsHTML(node: Node, extra = "") {
  const classes = classNames(node.name || "", node.attrs, extra);
  const style = blockStyle(node.attrs);
  return `${classes ? ` class="${esc(classes)}"` : ""}${node.attrs.anchor ? ` id="${esc(slug(node.attrs.anchor))}"` : ""}${style ? ` style="${esc(style)}"` : ""}`;
}
function fromJSON(blocks: SerializedNode[], depth = 0): Node[] {
  if (depth > 20) return [];
  return blocks.slice(0, 2000).map((block) => ({
    name: block.name,
    attrs: block.attributes || {},
    children: fromJSON(block.innerBlocks || [], depth + 1),
  }));
}
export function parseRenderNodes(document: RenderDocument): Node[] {
  const raw =
    document.rawContent || document.raw_content || document.content || "";
  if (raw.includes("<!-- wp:") || !document.blocks?.length)
    return parse(raw).map(function convert(block): Node {
      return {
        name: block.blockName,
        attrs: block.attrs || {},
        html: block.innerHTML,
        fragments: block.innerContent,
        children: block.innerBlocks.map(convert),
      };
    });
  return fromJSON(document.blocks);
}
async function cached<T>(
  state: State,
  key: string,
  work: () => Promise<T>,
): Promise<T> {
  if (!state.cache.has(key)) {
    state.cache.set(key, work());
  }
  return state.cache.get(key)!;
}
async function postURL(post: RenderPost, state: State) {
  return cached(state, `link:${post.id}`, () =>
    postPermalink(post, state.settings, state.db),
  );
}
async function loadPublicPost(
  id: number,
  state: State,
): Promise<RenderPost | null> {
  if (!id) return null;
  return cached(
    state,
    `post:${id}`,
    async () =>
      (
        await state.db.query(
          `SELECT ${postMetadataFields} FROM posts p WHERE p.id=$1 AND p.status='publish'`,
          [id],
        )
      ).rows[0] || null,
  );
}
async function media(id: number, state: State) {
  if (!id) return null;
  return cached(
    state,
    `media:${id}`,
    async () =>
      (
        await state.db.query(
          "SELECT id,title,alt,caption,mime_type AS \"mimeType\",width,height,sizes,'/uploads/' || filename AS url FROM media WHERE id=$1",
          [id],
        )
      ).rows[0] || null,
  );
}
async function author(post: RenderPost, state: State) {
  const id = Number(post.authorId ?? post.author_id);
  return cached(
    state,
    `author:${id}`,
    async () =>
      (
        await state.db.query(
          "SELECT id,username,display_name AS name,profile FROM users WHERE id=$1",
          [id],
        )
      ).rows[0] || { id, name: post.authorName || "", profile: {} },
  );
}
async function postForRender(post: RenderPost | null | undefined, state: State): Promise<RenderPost | null> {
  if(!post)return null;
  let locked=postNeedsPassword(post);
  if(locked && post.locked !== true){
    const sameUnlockedPost=state.options.post?.id===post.id && state.options.post?.locked===false;
    const permitted=sameUnlockedPost || (state.options.canReadProtectedPost
      ? await cached(state,`post-access:${post.id}`,()=>state.options.canReadProtectedPost!(post.id,state.db)):false);
    locked=!permitted;
  }
  return locked?{...post,locked:true,content:"",rawContent:"",raw_content:"",blocks:[],excerpt:"",footnotes:[]}: {...post,locked:false};
}
async function queryPosts(
  attrs: Record<string, any>,
  context: Context,
  state: State,
): Promise<QueryResult> {
  const input =
    attrs.query && typeof attrs.query === "object" ? attrs.query : {};
  const inherited = input.inherit ? state.options.query || {} : {};
  const queryId = integer(attrs.queryId, 0, 0, 2147483647);
  const page = integer(
    state.options.query?.[`query-${queryId}-page`] ??
      (input.inherit
        ? (state.options.page ?? state.options.query?.page)
        : undefined),
    1,
    1,
    10000,
  );
  const perPage = integer(
    input.perPage ?? inherited.perPage ?? state.settings.postsPerPage,
    state.settings.postsPerPage,
    1,
    100,
  );
  const maxPages = integer(input.pages, 0, 0, 10000);
  const offset = integer(input.offset, 0, 0, 10000) + (page - 1) * perPage;
  const postType = ["post", "page"].includes(input.postType)
    ? input.postType
    : "post";
  const args: unknown[] = [postType];
  const where = ["p.type=$1", "p.status='publish'"];
  const dateArchive = input.inherit ? parseDateArchiveQuery(inherited) : null;
  appendDateArchiveSQL(where, args, "coalesce(p.published_at,p.created_at)", dateArchive, state.settings.timezone, state.settings.weekStartsOn);
  const add = (sql: string, value: unknown) => {
    args.push(value);
    where.push(sql.replace("?", "$" + args.length));
  };
  const search = String(input.search || inherited.search || "").slice(0, 200);
  if (search) add("(p.title ILIKE ? OR p.content ILIKE ?)", `%${search}%`);
  // Both placeholders refer to the same argument.
  if (search)
    where[where.length - 1] = where[where.length - 1].replace(
      "?",
      "$" + args.length,
    );
  if (search && !state.options.user) where.push("p.password_hash IS NULL");
  const authorIds = ids(input.author || inherited.author);
  if (authorIds.length) add("p.author_id=ANY(?::int[])", authorIds);
  const include = ids(input.include);
  if (include.length) add("p.id=ANY(?::int[])", include);
  const exclude = ids(input.exclude);
  if (input.excludeCurrent && context.post?.id) exclude.push(context.post.id);
  if (exclude.length) add("NOT(p.id=ANY(?::int[]))", exclude);
  const parents = ids(input.parents);
  if (parents.length) add("p.parent_id=ANY(?::int[])", parents);
  const formats = Array.isArray(input.format)
    ? input.format.filter((v: unknown) => typeof v === "string").slice(0, 10)
    : [];
  if (formats.length) add("p.format=ANY(?::text[])", formats);
  if (input.sticky === "only") where.push("p.sticky=true");
  if (input.sticky === "exclude") where.push("p.sticky=false");
  for (const [key, taxonomy] of [
    ["category", "category"],
    ["post_tag", "tag"],
    ["tag", "tag"],
  ] as const) {
    const filter = input.taxQuery?.include?.[key] ?? input.taxQuery?.[key];
    const values = ids(filter);
    if (values.length)
      add(
        `EXISTS(SELECT 1 FROM post_terms pt JOIN terms t ON t.id=pt.term_id WHERE pt.post_id=p.id AND t.taxonomy='${taxonomy}' AND t.id=ANY(?::int[]))`,
        values,
      );
    const excluded = ids(input.taxQuery?.exclude?.[key]);
    if (excluded.length)
      add(
        `NOT EXISTS(SELECT 1 FROM post_terms pt JOIN terms t ON t.id=pt.term_id WHERE pt.post_id=p.id AND t.taxonomy='${taxonomy}' AND t.id=ANY(?::int[]))`,
        excluded,
      );
    if (input.inherit && inherited[key === "category" ? "category" : "tag"])
      add(
        `EXISTS(SELECT 1 FROM post_terms pt JOIN terms t ON t.id=pt.term_id WHERE pt.post_id=p.id AND t.taxonomy='${taxonomy}' AND t.slug=?)`,
        String(inherited[key === "category" ? "category" : "tag"]).slice(
          0,
          220,
        ),
      );
  }
  const columns: Record<string, string> = {
    date: "coalesce(p.published_at,p.created_at)",
    modified: "p.updated_at",
    title: "p.title",
    id: "p.id",
    menu_order: "p.menu_order",
    slug: "p.slug",
  };
  const orderBy = columns[input.orderBy] || columns.date;
  const order = input.order === "asc" ? "ASC" : "DESC";
  const sticky =
    (input.sticky === "" || input.sticky === undefined) && !dateArchive && !inherited.search && !inherited.author && !inherited.category && !inherited.tag ? "p.sticky DESC," : "";
  const key = JSON.stringify({
    where,
    args,
    offset,
    perPage,
    orderBy,
    order,
    sticky,
    queryId,
    maxPages,
  });
  return cached(state, "query:" + key, async () => {
    const total = Number(
      (
        await state.db.query(
          `SELECT count(*)::int AS total FROM posts p WHERE ${where.join(" AND ")}`,
          args,
        )
      ).rows[0].total,
    );
    const rows = (
      await state.db.query(
        `SELECT ${postFields},p.raw_content AS "rawContent" FROM posts p JOIN users u ON u.id=p.author_id WHERE ${where.join(" AND ")} ORDER BY ${sticky}${orderBy} ${order},p.id ${order} LIMIT $${args.length + 1} OFFSET $${args.length + 2}`,
        [...args, perPage, offset],
      )
    ).rows;
    const posts = await Promise.all(rows.map(async post => (await postForRender(post,state))!));
    const mediaIds = [
      ...new Set(posts.map((post) => post.featuredMediaId).filter(Boolean)),
    ];
    if (mediaIds.length) {
      const images = (
        await state.db.query(
          "SELECT id,title,alt,caption,mime_type AS \"mimeType\",width,height,sizes,'/uploads/' || filename AS url FROM media WHERE id=ANY($1::int[])",
          [mediaIds],
        )
      ).rows;
      for (const image of images)
        state.cache.set(`media:${image.id}`, Promise.resolve(image));
      for (const id of mediaIds)
        if (!state.cache.has(`media:${id}`))
          state.cache.set(`media:${id}`, Promise.resolve(null));
    }
    const authorIds = [
      ...new Set(posts.map((post) => post.authorId).filter(Boolean)),
    ];
    if (authorIds.length) {
      const people = (
        await state.db.query(
          "SELECT id,username,display_name AS name,profile FROM users WHERE id=ANY($1::int[])",
          [authorIds],
        )
      ).rows;
      for (const person of people)
        state.cache.set(`author:${person.id}`, Promise.resolve(person));
    }
    return {
      posts: maxPages && page > maxPages ? [] : posts,
      total,
      page,
      perPage,
      totalPages: Math.min(
        maxPages || Infinity,
        Math.max(
          1,
          Math.ceil(
            Math.max(0, total - integer(input.offset, 0, 0, 10000)) / perPage,
          ),
        ),
      ),
      queryId,
    };
  });
}
function paginationURL(page: number, loop: QueryResult, state: State) {
  const {path,query}=publicPaginationLocation(state.options.requestPath,state.options.query);
  query.set(`query-${loop.queryId}-page`, String(page));
  return path + "?" + query.toString();
}
async function navigationItems(
  items: any[],
  state: State,
  parent: string | null = null,
  depth = 0,
): Promise<string> {
  if (depth > 15) return "";
  return (
    await Promise.all(
      items
        .filter((i) => (i.parentId || null) === parent)
        .map(async (item) => {
          const href = safeBlockURL(item.url),
            children = await navigationItems(items, state, item.id, depth + 1);
          const label = esc(item.label);
          const link=`<a class="wp-block-navigation-item__content" href="${esc(href || "#")}"${item.target === "_blank" ? ' target="_blank" rel="noopener noreferrer"' : ""}>${label}</a>`;
          return `<li class="wp-block-navigation-item">${children ? `<details><summary>${link}</summary><ul class="wp-block-navigation__submenu-container">${children}</ul></details>` : link}</li>`;
        }),
    )
  ).join("");
}
async function pageList(node: Node, context: Context, state: State) {
  const pages = await cached(
    state,
    "pages",
    async () =>
      (
        await state.db.query(
          `SELECT ${postMetadataFields} FROM posts p WHERE p.type='page' AND p.status='publish' ORDER BY p.menu_order,p.title,p.id LIMIT 200`,
        )
      ).rows,
  );
  const items = await Promise.all(
    pages.map(async (page: RenderPost) => ({
      id: String(page.id),
      parentId: page.parentId ? String(page.parentId) : null,
      label: page.title || "(no title)",
      url: await postURL(page, state),
    })),
  );
  return `<ul${attrsHTML(node)}>${await navigationItems(items, state, node.attrs.parentPageID ? String(node.attrs.parentPageID) : null)}</ul>`;
}
function postDate(
  post: RenderPost,
  format: string | undefined,
  modified: boolean,
  state: State,
) {
  const value = dateValue(post, modified);
  if (!value || Number.isNaN(new Date(value).valueOf())) return "";
  return format === "human-diff"
    ? humanTimeDiff(new Date(value))
    : formatBlockDate(
        format || state.settings.dateFormat,
        new Date(value),
        state.settings.timezone,
      );
}
async function staticHTML(
  node: Node,
  context: Context,
  state: State,
): Promise<string> {
  if (node.fragments) {
    let child = 0;
    const out: string[] = [];
    for (const fragment of node.fragments)
      out.push(
        fragment === null
          ? await render(node.children[child++], context, state)
          : fragment,
      );
    while (child < node.children.length)
      out.push(await render(node.children[child++], context, state));
    const html = out.join("");
    if (!node.name || !["core/group", "core/columns", "core/column", "core/buttons", "core/math"].includes(node.name)) return html;
    return html.replace(/^(\s*<[a-z][a-z\d-]*)([^>]*)(>)/i, (_match, tag, original, end) => {
      const classes = esc(classNames(node.name!, node.attrs));
      const style = esc(blockStyle(node.attrs));
      let attributes = String(original);
      if (classes) attributes = /\sclass=(["'])[^]*?\1/i.test(attributes)
        ? attributes.replace(/\sclass=(["'])([^]*?)\1/i, (_value, quote, existing) => ` class=${quote}${existing} ${classes}${quote}`)
        : attributes + ` class="${classes}"`;
      if (style) attributes = /\sstyle=(["'])[^]*?\1/i.test(attributes)
        ? attributes.replace(/\sstyle=(["'])([^]*?)\1/i, (_value, quote, existing) => ` style=${quote}${existing};${style}${quote}`)
        : attributes + ` style="${style}"`;
      return tag + attributes + end;
    });
  }
  if (!node.name) return node.html || "";
  const content = String(node.attrs.content ?? node.attrs.value ?? "");
  const inner = await renderChildren(node.children, context, state);
  const attr = attrsHTML(node);
  const tag = (
    {
      "core/paragraph": "p",
      "core/quote": "blockquote",
      "core/pullquote": "figure",
      "core/list-item": "li",
      "core/columns": "div",
      "core/column": "div",
      "core/group": safeTag(node.attrs.tagName),
      "core/buttons": "div",
      "core/button": "div",
      "core/verse": "pre",
    } as Record<string, string>
  )[node.name];
  if (tag) {
    if (node.name === "core/button") {
      const button = node.attrs.tagName === "button", element = button ? "button" : "a";
      const link = node.attrs.url === false ? "" : ` href="${esc(Object.hasOwn(node.attrs, "url") ? safeBlockURL(node.attrs.url) : "#")}"`;
      return `<${tag}${attr}><${element} class="wp-block-button__link wp-element-button"${button ? ` type="${["button", "submit", "reset"].includes(node.attrs.type) ? node.attrs.type : "button"}"` : link + (node.attrs.linkTarget ? ` target="${esc(node.attrs.linkTarget)}"` : "") + (node.attrs.rel ? ` rel="${esc(node.attrs.rel)}"` : "")}>${node.attrs.text || ""}</${element}></${tag}>`;
    }
    return `<${tag}${attr}>${content + inner}</${tag}>`;
  }
  if (node.name === "core/heading") {
    const tag = "h" + integer(node.attrs.level, 2, 1, 6);
    return `<${tag}${attr}>${content}</${tag}>`;
  }
  if (node.name === "core/list") {
    const tag = node.attrs.ordered ? "ol" : "ul";
    return `<${tag}${attr}>${inner || node.attrs.values || ""}</${tag}>`;
  }
  if (node.name === "core/html" || node.name === "core/freeform") return content;
  if (node.name === "core/shortcode") return String(node.attrs.text ?? content);
  if (node.name === "core/math") {
    const latex=typeof node.attrs.latex==='string'?node.attrs.latex:'';
    if(!latex)return '';
    const mathML=typeof node.attrs.mathML==='string'?cleanContent(node.attrs.mathML):'';
    return `<div${attr}><math display="block">${mathML || `<semantics><annotation encoding="application/x-tex">${esc(latex)}</annotation></semantics>`}</math></div>`;
  }
  if (node.name === "core/code" || node.name === "core/preformatted")
    return `<pre${attr}>${node.name === "core/code" ? `<code>${content}</code>` : content}</pre>`;
  if (node.name === "core/separator") return `<hr${attr}>`;
  if (node.name === "core/spacer")
    return `<div${attr} style="height:${esc(node.attrs.height || "100px")}"></div>`;
  if (node.name === "core/image")
    return `<figure${attr}><img${node.attrs.url === false ? "" : ` src="${esc(safeBlockURL(node.attrs.url))}"`}${node.attrs.alt === false ? "" : ` alt="${esc(node.attrs.alt || "")}"`}${node.attrs.title ? ` title="${esc(node.attrs.title)}"` : ""}${Number.isSafeInteger(Number(node.attrs.id)) && Number(node.attrs.id) > 0 ? ` class="wp-image-${Number(node.attrs.id)}"` : ""}${node.attrs["data-id"] !== undefined ? ` data-id="${integer(node.attrs.id || node.attrs["data-id"], 0, 0, 2147483647)}"` : ""}>${node.attrs.caption ? `<figcaption>${node.attrs.caption}</figcaption>` : ""}</figure>`;
  if (node.name === "core/gallery")
    return `<figure${attrsHTML(node, "has-nested-images is-layout-flex " + (node.attrs.imageCrop === false ? "" : "is-cropped") + " columns-" + integer(node.attrs.columns, 3, 1, 8))}>${inner}</figure>`;
  if (node.name === "core/audio" || node.name === "core/video") {
    const tag = node.name === "core/audio" ? "audio" : "video",
      url = safeBlockURL(node.attrs.src);
    return `<figure${attr}><${tag} src="${esc(url)}"${node.attrs.controls === false ? "" : " controls"}${node.attrs.autoplay ? " autoplay" : ""}${node.attrs.loop ? " loop" : ""}${node.attrs.muted ? " muted" : ""}${node.attrs.poster ? ` poster="${esc(safeBlockURL(node.attrs.poster))}"` : ""}></${tag}>${node.attrs.caption ? `<figcaption>${node.attrs.caption}</figcaption>` : ""}</figure>`;
  }
  if (node.name === "core/file")
    return `<div${attr}><a href="${esc(safeBlockURL(node.attrs.href) || "#")}">${node.attrs.fileName || "Download file"}</a>${node.attrs.showDownloadButton === false ? "" : ` <a class="wp-block-file__button wp-element-button" href="${esc(safeBlockURL(node.attrs.href) || "#")}" download>${node.attrs.downloadButtonText || "Download"}</a>`}</div>`;
  if (node.name === "core/embed")
    return `<figure${attrsHTML(node, "wp-block-embed is-type-video " + (node.attrs.providerNameSlug ? "is-provider-" + slug(node.attrs.providerNameSlug) : ""))}><div class="wp-block-embed__wrapper">${esc(safeBlockURL(node.attrs.url))}</div>${node.attrs.caption ? `<figcaption>${node.attrs.caption}</figcaption>` : ""}</figure>`;
  if (node.name === "core/cover")
    return `<div${attrsHTML(node, "has-background-dim")} style="min-height:${esc(node.attrs.minHeight ? String(node.attrs.minHeight) + (node.attrs.minHeightUnit || "px") : "300px")}">${node.attrs.url ? `<img class="wp-block-cover__image-background" src="${esc(safeBlockURL(node.attrs.url))}" alt="${esc(node.attrs.alt || "")}">` : ""}<div class="wp-block-cover__inner-container">${inner}</div></div>`;
  if (node.name === "core/media-text")
    return `<div${attr}><figure class="wp-block-media-text__media">${node.attrs.mediaType === "video" ? `<video src="${esc(safeBlockURL(node.attrs.mediaUrl))}" controls></video>` : `<img src="${esc(safeBlockURL(node.attrs.mediaUrl))}" alt="${esc(node.attrs.mediaAlt || "")}">`}</figure><div class="wp-block-media-text__content">${inner}</div></div>`;
  if (node.name === "core/table") {
    const rows = (items: any[]) =>
      items
        ?.slice(0, 1000)
        .map(
          (row) =>
            "<tr>" +
            (row.cells || [])
              .slice(0, 100)
              .map((cell: any) => {
                const tag = cell.tag === "th" ? "th" : "td";
                return `<${tag}${cell.align ? ` style="text-align:${esc(cell.align)}"` : ""}${cell.colspan ? ` colspan="${integer(cell.colspan, 1, 1, 100)}"` : ""}${cell.rowspan ? ` rowspan="${integer(cell.rowspan, 1, 1, 100)}"` : ""}>${cell.content || ""}</${tag}>`;
              })
              .join("") +
            "</tr>",
        )
        .join("") || "";
    return `<figure${attr}><table>${node.attrs.head?.length ? `<thead>${rows(node.attrs.head)}</thead>` : ""}<tbody>${rows(node.attrs.body)}</tbody>${node.attrs.foot?.length ? `<tfoot>${rows(node.attrs.foot)}</tfoot>` : ""}</table>${node.attrs.caption ? `<figcaption>${node.attrs.caption}</figcaption>` : ""}</figure>`;
  }
  if (node.name === "core/details")
    return `<details${attr}${node.attrs.showContent ? " open" : ""}><summary>${node.attrs.summary || "Details"}</summary>${inner}</details>`;
  return node.html || inner;
}
async function renderChildren(nodes: Node[], context: Context, state: State) {
  const out: string[] = [];
  for (const node of nodes) out.push(await render(node, context, state));
  return out.join("");
}
async function renderDocument(document: RenderDocument, context: Context, state: State) {
  return renderChildren(parseRenderNodes(await prepareShortcodeDocument(document, context, state)), context, state);
}
async function renderPostBody(post: RenderPost, context: Context, state: State, mode: ContentMode, page = 1) {
  const selected = selectLegacyContent(post, post, await postURL(post, state), mode, page, state.options.preview,state.settings.permalinkStructure);
  const body = await renderDocument(selected.document, context, state), extra = selected.moreLink + selected.navigation;
  const bytes = Buffer.byteLength(extra, "utf8");
  if (state.outputBytes + bytes > MAX_RENDER_BYTES) throw new HttpError(413, "Rendered content exceeds the 8 MiB limit. Reduce repeated patterns or query output.");
  state.outputBytes += bytes;
  return body + extra;
}
export const MAX_RENDER_BYTES = 8 * 1024 * 1024;
export const MAX_RENDER_NODES = 4000;
async function render(
  node: Node | undefined,
  context: Context,
  state: State,
): Promise<string> {
  const before = state.outputBytes;
  const html = await renderNode(node, context, state);
  // Descendants charge their output before it is appended to a sibling array.
  // Charge only this node's additional markup to avoid counting nested HTML twice.
  const ownBytes = Math.max(
    0,
    Buffer.byteLength(html, "utf8") - (state.outputBytes - before),
  );
  if (state.outputBytes + ownBytes > MAX_RENDER_BYTES)
    throw new HttpError(
      413,
      "Rendered content exceeds the 8 MiB limit. Reduce repeated patterns or query output.",
    );
  state.outputBytes += ownBytes;
  return html;
}
async function renderNode(
  node: Node | undefined,
  context: Context,
  state: State,
): Promise<string> {
  if (!node || ++state.nodes > MAX_RENDER_NODES || context.depth > 24) return "";
  context = { ...context, depth: context.depth + 1 };
  node = await applyBlockBindings(node, context, state);
  const name = node.name || "",
    a = node.attrs || {},
    p = context.post;
  const attr = (extra = "") => attrsHTML(node, extra);
  const overlayClose = renderNavigationOverlayClose(node, context, attr);
  if (overlayClose !== undefined) return overlayClose;
  if (name === "core/more" || name === "core/nextpage") return "";
  const interactiveBlock = await renderInteractiveBlock(node, context, state,
    (nodes, next) => renderChildren(nodes, next, state),
    (extra = "", override = a) => attrsHTML({ ...node, attrs: override }, extra), blockStyle);
  if (interactiveBlock !== undefined) return interactiveBlock;
  const iconBlock = renderIconBlock(node,
    (extra = "", override = a) => attrsHTML({ ...node, attrs: override }, extra), blockStyle);
  if (iconBlock !== undefined) return iconBlock;
  const playlistBlock = await renderPlaylistBlock(node, context, state,
    (nodes, next) => renderChildren(nodes, next, state),
    (extra = "", override = a) => attrsHTML({ ...node, attrs: override }, extra));
  if (playlistBlock !== undefined) return playlistBlock;
  const themeBlock = await renderThemeBlock(node, context, state,
    (nodes, next) => renderChildren(nodes, next, state), attr);
  if (themeBlock !== undefined) return themeBlock;
  const widgetBlock = await renderWidgetBlock(node, context, state, attr,
    (post, next) => renderPostBody(post, next, state, "complete"));
  if (widgetBlock !== undefined) return widgetBlock;
  const rssBlock = await renderRSSBlock(node, state, attr);
  if (rssBlock !== undefined) return rssBlock;
  if (name === "core/footnotes") return renderFootnotes(context.post, attr);
  const termBlock = await renderTermBlock(node, context, state,
    (nodes, next) => renderChildren(nodes, next, state), attr);
  if (termBlock !== undefined) return termBlock;
  const body = () => renderChildren(node.children, context, state);
  const wrap = async (tag = "div", extra = "") =>
    `<${safeTag(tag)}${attr(extra)}>${await body()}</${safeTag(tag)}>`;
  if (name === "core/query") {
    if (context.depth > 15) return "";
    const loop = await queryPosts(a, context, state);
    return `<${safeTag(a.tagName)}${attr()}>${await renderChildren(node.children, { ...context, loop,queryDisplayLayout:a.displayLayout }, state)}</${safeTag(a.tagName)}>`;
  }
  if (name === "core/post-template") {
    if (!context.loop) return "";
    const items = [];
    for (const post of context.loop.posts)
      items.push(
        `<li class="wp-block-post post-${integer(post.id, 0, 0, 2147483647)} type-${esc(post.type)}${postNeedsPassword(post) ? " post-password-required" : postHasPassword(post) ? " post-password-protected" : ""}">${await renderChildren(node.children, { ...context, post }, state)}</li>`,
      );
    const legacyGrid=!a.layout && context.queryDisplayLayout?.type === "flex";
    return `<ul${attr(a.layout?.type === "grid" ? `is-layout-grid columns-${integer(a.layout.columnCount, 3, 1, 1000)}` : legacyGrid?`is-flex-container columns-${integer(context.queryDisplayLayout?.columns,3,1,1000)}`:"is-layout-flow")}>${items.join("")}</ul>`;
  }
  if (name === "core/query-no-results")
    return context.loop && !context.loop.posts.length ? wrap() : "";
  if (name === "core/query-pagination")
    return context.loop && context.loop.totalPages > 1
      ? wrap("nav", "pagination")
      : "";
  if (name.startsWith("core/query-pagination-")) {
    const loop = context.loop;
    if (!loop || loop.totalPages <= 1) return "";
    if (name.endsWith("previous") || name.endsWith("next")) {
      const previous = name.endsWith("previous"),
        page = loop.page + (previous ? -1 : 1);
      if (page < 1 || page > loop.totalPages) return "";
      return `<a${attr()} href="${esc(paginationURL(page, loop, state))}">${esc(a.label || (previous ? "Previous Page" : "Next Page"))}</a>`;
    }
    const pages = new Set([
      1,
      loop.totalPages,
      loop.page - 2,
      loop.page - 1,
      loop.page,
      loop.page + 1,
      loop.page + 2,
    ]);
    let last = 0;
    const parts: string[] = [];
    for (const page of [...pages]
      .filter((n) => n > 0 && n <= loop.totalPages)
      .sort((a, b) => a - b)) {
      if (last && page > last + 1)
        parts.push('<span class="page-numbers dots">…</span>');
      parts.push(
        page === loop.page
          ? `<span class="page-numbers current" aria-current="page">${page}</span>`
          : `<a class="page-numbers" href="${esc(paginationURL(page, loop, state))}">${page}</a>`,
      );
      last = page;
    }
    return `<div${attr()}>${parts.join(" ")}</div>`;
  }
  if (name === "core/query-title") {
    const query = state.options.query || {};
    const dateArchive = parseDateArchiveQuery(query);
    let label = "Blog",
      prefix = "";
    if (query.search) {
      prefix = "Search results for: ";
      label = String(query.search);
    } else if (query.category || query.tag) {
      const taxonomy = query.category ? "category" : "tag",
        value = String(query.category || query.tag);
      prefix = taxonomy === "category" ? "Category: " : "Tag: ";
      const term = await cached(
        state,
        `archive-term:${taxonomy}:${value}`,
        async () =>
          (
            await state.db.query(
              "SELECT name FROM terms WHERE taxonomy=$1 AND slug=$2 LIMIT 1",
              [taxonomy, value.slice(0, 220)],
            )
          ).rows[0],
      );
      label = term?.name || value;
    } else if (query.author) {
      prefix = "Author: ";
      const id = integer(query.author, 0, 1, 2147483647),
        person = await cached(
          state,
          `archive-author:${id}`,
          async () =>
            (
              await state.db.query(
                "SELECT display_name AS name FROM users WHERE id=$1 AND EXISTS(SELECT 1 FROM posts p WHERE p.author_id=$1 AND p.status='publish')",
                [id],
              )
            ).rows[0],
        );
      label = person?.name || "Posts";
    }
    if (dateArchive && !query.search && !query.category && !query.tag && !query.author) {
      label = dateArchiveTitle(dateArchive, { showPrefix: a.showPrefix !== false });
      prefix = "";
    }
    const level = integer(a.level, 1, 1, 6);
    return `<h${level}${attr()}>${esc((a.showPrefix === false ? "" : prefix) + label)}</h${level}>`;
  }
  if (name === "core/site-title") {
    const tag = Number(a.level) === 0 ? "p" : "h" + integer(a.level, 1, 1, 6);
    const title = esc(state.settings.siteTitle);
    return `<${tag}${attr()}>${a.isLink === false ? title : `<a href="${esc(safeBlockURL(state.settings.siteUrl) || "/")}"${a.linkTarget === "_blank" ? ' target="_blank" rel="noopener noreferrer"' : ""}>${title}</a>`}</${tag}>`;
  }
  if (name === "core/site-tagline")
    return `<p${attr()}>${esc(state.settings.tagline)}</p>`;
  if (name === "core/site-logo") {
    const image = await media(
      Number((state.settings as any).siteLogoId || 0),
      state,
    );
    if (!image || !image.mimeType.startsWith("image/")) return "";
    const img = `<img class="custom-logo" src="${esc(safeBlockURL(image.url))}" alt="${esc(image.alt || state.settings.siteTitle)}"${a.width ? ` width="${integer(a.width, 120, 1, 4096)}"` : ""}>`;
    return `<div${attr()}>${a.isLink === false ? img : `<a href="${esc(safeBlockURL(state.settings.siteUrl) || "/")}" rel="home">${img}</a>`}</div>`;
  }
  if (name === "core/page-list") return pageList(node, context, state);
  if (name === "core/home-link")
    return `<li${attr("wp-block-navigation-item")}><a href="/">${esc(a.label || "Home")}</a></li>`;
  if (name === "core/navigation") {
    const renderItems = async () => {
      let inner = "";
      const ref = Number.isSafeInteger(a.ref) && a.ref > 0 && a.ref <= 2147483647 ? a.ref : 0;
      if (ref) {
        const entity = await cached(
          state,
          `entity:navigation:${ref}`,
          async () =>
            (
              await state.db.query(
                "SELECT raw_content AS \"rawContent\",content,blocks FROM block_entities WHERE id=$1 AND kind='navigation' AND status='publish'",
                [ref],
              )
            ).rows[0],
        );
        if (entity && !context.refs.has("nav:" + ref))
          inner = await renderDocument(entity, { ...context, refs: new Set([...context.refs, "nav:" + ref]) }, state);
      } else inner = await body();
      if (!inner) {
        const menus = await cached(
          state,
          "menus",
          async () =>
            (
              await state.db.query(
                "SELECT items FROM navigation_menus WHERE location='primary' ORDER BY id LIMIT 1",
              )
            ).rows,
        );
        inner = menus[0]
          ? await navigationItems(menus[0].items || [], state)
          : await pageList(
              { name: "core/page-list", attrs: {}, children: [] },
              context,
              state,
            );
      }
      return inner.replace(/^\s*<ul[^>]*>([\s\S]*)<\/ul>\s*$/, "$1");
    };
    const items = await renderItems();
    return renderNavigationWithOverlay(node, context, state, items, attr,
      (document, next) => renderDocument(document, next, state), renderItems);
  }
  if (name === "core/navigation-link" || name === "core/navigation-submenu") {
    let href = safeBlockURL(a.url);
    if (
      !href &&
      a.id &&
      a.kind === "post-type"
    ) {
      const post = await loadPublicPost(integer(a.id, 0, 1, 2147483647), state);
      if (post) href = await postURL(post, state);
    }
    const label = plainText(String(a.label || "Link"));
    const link = `<a class="wp-block-navigation-item__content" href="${esc(href || "#")}"${a.opensInNewTab ? ' target="_blank" rel="noopener noreferrer"' : ""}>${esc(label)}</a>`;
    return `<li${attr("wp-block-navigation-item")}>${node.children.length ? `<details><summary>${link}</summary><ul class="wp-block-navigation__submenu-container">${await body()}</ul></details>` : link}</li>`;
  }
  if (name === "core/template-part") {
    const theme = typeof a.theme === "string" ? a.theme : state.settings.theme;
    const key = "part:" + theme + ":" + String(a.slug);
    if (context.refs.has(key)) return "";
    const doc = await cached(
      state,
      key,
      async () =>
        (
          await state.db.query(
            "SELECT content,raw_content AS \"rawContent\",blocks FROM site_documents WHERE slug=$1 AND theme=$2 AND type='template-part' LIMIT 1",
            [String(a.slug || "").slice(0, 160), theme],
          )
        ).rows[0],
    );
    return doc
      ? `<${safeTag(a.tagName)}${attr()}>${await renderDocument(doc, { ...context, refs: new Set([...context.refs, key]) }, state)}</${safeTag(a.tagName)}>`
      : "";
  }
  if (name === "core/pattern") {
    const theme = String(a.slug || "").includes("/") ? String(a.slug).split("/")[0] : state.settings.theme;
    const key = "pattern:" + theme + ":" + String(a.slug);
    if (context.refs.has(key)) return "";
    const patternSlug = String(a.slug || "")
      .split("/")
      .pop();
    const doc = await cached(
      state,
      key,
      async () =>
        (
          await state.db.query(
            "SELECT content,raw_content AS \"rawContent\",blocks FROM site_documents WHERE slug=$1 AND theme=$2 AND type='pattern' LIMIT 1",
            [patternSlug, theme],
          )
        ).rows[0],
    );
    return doc
      ? renderDocument(doc, { ...context, refs: new Set([...context.refs, key]) }, state)
      : "";
  }
  if (name === "core/block") {
    const key = "reusable:" + a.ref;
    if (context.refs.has(key)) return "";
    const doc = await cached(
      state,
      key,
      async () =>
        (
          await state.db.query(
            "SELECT raw_content AS \"rawContent\",content,blocks FROM block_entities WHERE id=$1 AND kind='reusable' AND status='publish'",
            [integer(a.ref, 0, 1, 2147483647)],
          )
        ).rows[0],
    );
    return doc
      ? renderDocument(doc, { ...context, refs: new Set([...context.refs, key]), patternOverrides: patternOverrides(a) }, state)
      : "";
  }
  if (name.startsWith("worldact/")) {
    const key = name.slice(9);
    if (key === "site-title")
      return `<div${attr()}>${esc(state.settings.siteTitle)}</div>`;
    if (key === "tagline")
      return `<p${attr()}>${esc(state.settings.tagline)}</p>`;
    if (key === "navigation")
      return render({ ...node, name: "core/navigation" }, context, state);
    if (key === "post-list")
      return state.options.placeholderBindings
        ? "{{postList}}"
        : render(
            {
              name: "core/query",
              attrs: { query: { inherit: true } },
              children: [
                {
                  name: "core/post-template",
                  attrs: {},
                  children: [
                    {
                      name: "core/post-title",
                      attrs: { level: 2, isLink: true },
                      children: [],
                    },
                    { name: "core/post-excerpt", attrs: {}, children: [] },
                  ],
                },
              ],
            },
            context,
            state,
          );
    const names: Record<string, string> = {
      "post-title": "core/post-title",
      "post-content": "core/post-content",
      "post-date": "core/post-date",
      "post-author": "core/post-author-name",
    };
    if (names[key])
      return render({ ...node, name: names[key] }, context, state);
  }
  if (
    [
      "core/post-title",
      "core/post-content",
      "core/post-excerpt",
      "core/post-date",
      "core/post-author",
      "core/post-author-name",
      "core/post-author-biography",
      "core/post-featured-image",
      "core/post-terms",
      "core/read-more",
    ].includes(name)
  ) {
    if (name === "core/post-date") {
      let value = a.datetime;
      if (!value)
        return !Object.hasOwn(a, "datetime") && state.options.placeholderBindings
          ? `<div${attr()}>{{postDate}}</div>`
          : "";
      try {
        value = restDateToUTC(
          typeof value === "string" ? value : new Date(value).toISOString(),
          state.settings.timezone,
        );
      } catch {
        return "";
      }
      const time = `<time datetime="${esc(value)}">${esc(postDate({ publishedAt: value }, a.format, false, state))}</time>`;
      return `<div${attr()}>${a.isLink && p ? `<a href="${esc(await postURL(p, state))}">${time}</a>` : time}</div>`;
    }
    if (!p) {
      const tokens: Record<string, string> = {
        "core/post-title": "postTitle",
        "core/post-content": "content",
        "core/post-date": "postDate",
        "core/post-author": "postAuthor",
        "core/post-author-name": "postAuthor",
      };
      return state.options.placeholderBindings && tokens[name]
        ? `<div${attr()}>{{${tokens[name]}}}</div>`
        : "";
    }
    const url = await postURL(p, state);
    if (name === "core/post-title") {
      const tag = Number(a.level) === 0 ? "p" : "h" + integer(a.level, 2, 1, 6),
        title = esc(publicPostTitle(p));
      return `<${tag}${attr()}>${a.isLink ? `<a href="${esc(url)}"${a.linkTarget === "_blank" ? ' target="_blank" rel="noopener noreferrer"' : ""}>${title}</a>` : title}</${tag}>`;
    }
    if (name === "core/post-content") {
      if(postNeedsPassword(p))return `<div${attr()}>${postPasswordForm(p,reserveInteractiveId(state,"","post-password"))}</div>`;
      if (context.contentIds.has(p.id))
        return cleanContent(String(p.content || ""));
      const content = await renderPostBody(p, { ...context, contentIds: new Set([...context.contentIds, p.id]) }, state,
        context.loop ? "archive" : state.options.contentMode || "singular", context.loop ? 1 : state.options.contentPage || 1);
      return `<${safeTag(a.tagName)}${attr()}>${content}</${safeTag(a.tagName)}>`;
    }
    if (name === "core/post-excerpt") {
      if(postNeedsPassword(p))return `<div${attr()}><p>${protectedPostExcerpt}</p></div>`;
      const words = (p.excerpt ? plainText(String(p.excerpt)) : excerptText(legacyExcerptSource(p)))
          .trim()
          .split(/\s+/)
          .filter(Boolean),
        limit = integer(a.excerptLength, 55, 1, 1000),
        text =
          words.slice(0, limit).join(" ") + (words.length > limit ? "…" : "");
      return `<div${attr()}><p class="wp-block-post-excerpt__excerpt">${esc(text)}</p>${a.moreText ? `<p class="wp-block-post-excerpt__more-text"><a href="${esc(url)}" class="wp-block-post-excerpt__more-link">${esc(a.moreText)}</a></p>` : ""}</div>`;
    }
    if (name === "core/read-more")
      return `<a${attr()} href="${esc(url)}">${esc(a.content || "Read more")}<span class="screen-reader-text">: ${esc(p.title)}</span></a>`;
    if (name === "core/post-featured-image") {
      const image =
        p.featuredMedia ||
        (await media(
          Number(p.featuredMediaId ?? p.featured_media_id ?? 0),
          state,
        ));
      if (!image || !image.mimeType.startsWith("image/")) return "";
      const size = image.sizes?.[a.sizeSlug] || image,
        src = safeBlockURL(size.url);
      const img = `<img src="${esc(src)}" alt="${esc(image.alt || "")}"${size.width ? ` width="${integer(size.width, 1, 1, 20000)}"` : ""}${size.height ? ` height="${integer(size.height, 1, 1, 20000)}"` : ""} loading="lazy">`;
      return `<figure${attr()}>${a.isLink ? `<a href="${esc(url)}">${img}</a>` : img}</figure>`;
    }
    if (name === "core/post-terms") {
      const taxonomy = a.term === "post_tag" ? "tag" : "category";
      let terms = p.terms;
      if (!Array.isArray(terms))
        terms = await cached(
          state,
          `terms:${p.id}`,
          async () =>
            (
              await state.db.query(
                "SELECT t.id,t.taxonomy,t.name,t.slug FROM terms t JOIN post_terms pt ON pt.term_id=t.id WHERE pt.post_id=$1 ORDER BY t.name,t.id",
                [p.id],
              )
            ).rows,
        );
      const links = terms
        .filter((t: any) => t.taxonomy === taxonomy)
        .map(
          (t: any) =>
            `<a href="/${esc(encodeURIComponent(taxonomy === "category" ? state.settings.categoryBase : state.settings.tagBase))}/${esc(encodeURIComponent(t.slug))}/">${esc(t.name)}</a>`,
        );
      return links.length
        ? `<div${attr()}>${a.prefix ? `<span class="wp-block-post-terms__prefix">${esc(a.prefix)}</span>` : ""}${links.join(esc(a.separator ?? ", "))}${a.suffix ? `<span class="wp-block-post-terms__suffix">${esc(a.suffix)}</span>` : ""}</div>`
        : "";
    }
    const person = await author(p, state);
    const personName = esc(person.name || p.authorName || ""),
      profile = person.profile || {};
    if (name === "core/post-author-biography")
      return `<div${attr()}>${esc(profile.bio || "")}</div>`;
    if (name === "core/post-author-name")
      return `<div${attr()}>${a.isLink ? `<a href="/?author=${integer(person.id, 0, 1, 2147483647)}"${a.linkTarget === "_blank" ? ' target="_blank" rel="noopener noreferrer"' : ""}>${personName}</a>` : personName}</div>`;
    return `<div${attr()}>${a.byline ? `<p class="wp-block-post-author__byline">${esc(a.byline)}</p>` : ""}<div class="wp-block-post-author__content"><p class="wp-block-post-author__name">${personName}</p>${a.showBio ? `<p class="wp-block-post-author__bio">${esc(profile.bio || "")}</p>` : ""}</div></div>`;
  }
  return staticHTML(node, context, state);
}
async function createState(options: RenderOptions, document: RenderDocument = {}): Promise<State> {
  const source = options.db || pool;
  let count = 0;
  // The budget includes settings, permalink ancestry and entity lookups, not only query blocks.
  const db = {
    query: (...args: any[]) => {
      if (++count > 512)
        throw new Error("The block render query limit was reached.");
      return (source.query as any).apply(source, args);
    },
  } as BlockDatabase;
  const settings = await getSettings(db);
  return {
    db,
    settings,
    interactive: createInteractiveRenderState(document, options, settings.theme),
    options,
    nodes: 0,
    outputBytes: 0,
    queries: 0,
    cache: new Map(),
  };
}
function storedStaticHTML(document: RenderDocument): string | undefined {
  const raw =
    document.rawContent || document.raw_content || document.content || "";
  return !hasLegacyContent(document) && !hasShortcodes(raw) && !raw.includes("<!-- wp:") && !hasDynamicBlocks(document.blocks) && (raw.length>0 || !document.blocks?.length)
    ? cleanContent(raw)
    : undefined;
}
export async function renderSiteDocument(
  document: RenderDocument,
  options: RenderOptions = {},
): Promise<string> {
  const stored = storedStaticHTML(document);
  if (stored !== undefined) return stored;
  const state = await createState({
    placeholderBindings: !options.post,
    ...options,
  }, document);
  return cleanContent(
    await renderDocument(
      document,
      {
        post: await postForRender(options.post,state),
        depth: 0,
        refs: new Set(),
        contentIds: new Set(),
      },
      state,
    ), true,
  );
}
export async function renderPublicContent(
  post: RenderPost,
  options: RenderOptions = {},
): Promise<string> {
  let state:State|undefined;
  if(postNeedsPassword(post)){
    state=await createState({...options,placeholderBindings:false},post);
    post=(await postForRender(post,state))!;
    if(postNeedsPassword(post))return cleanContent(postPasswordForm(post,reserveInteractiveId(state,"","post-password")),true);
  }
  const stored = storedStaticHTML(post);
  if (stored !== undefined) return stored;
  state ||= await createState({ ...options, placeholderBindings: false }, post);
  if (!state.options.requestPath)
    state.options.requestPath = await postURL(post, state);
  return cleanContent(
    await renderPostBody(post, { post, depth: 0, refs: new Set(), contentIds: new Set([post.id]) }, state,
      options.contentMode || "singular", options.contentPage || 1), true,
  );
}
/** Render a single official dynamic block for authenticated editor previews. */
export async function renderBlock(
  name: string,
  attributes: Record<string, unknown>,
  options: RenderOptions = {},
): Promise<string> {
  if (!SUPPORTED_DYNAMIC_BLOCKS.has(name)) return "";
  const state = await createState({ ...options, placeholderBindings: false }, { blocks: [{ name, attributes, innerBlocks: [] }] });
  return cleanContent(
    await renderDocument(
      { blocks: [{ name, attributes, innerBlocks: [] }] },
      {
        post: await postForRender(options.post,state),
        depth: 0,
        refs: new Set(),
        contentIds: new Set(),
      },
      state,
    ), true,
  );
}
