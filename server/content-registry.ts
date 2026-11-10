type JSONValue = null | string | number | boolean | JSONValue[] | JSONObject;
type JSONObject = { [key: string]: JSONValue };
type Frozen<T> = T extends object ? { readonly [K in keyof T]: Frozen<T[K]> } : T;
type Labels = { readonly name: string; readonly singular_name: string };
type ContentRest = {
  readonly slug: string;
  readonly name: string;
  readonly labels: Labels;
  readonly viewable: boolean;
  readonly description: string;
  readonly hierarchical: boolean;
  readonly rest_base: string;
  readonly rest_namespace: string;
  readonly taxonomies: readonly string[];
  readonly supports: Readonly<Record<string, boolean>>;
};
type TaxonomyRest = {
  readonly slug: string;
  readonly name: string;
  readonly labels: Labels;
  readonly visibility: Readonly<Record<string, boolean>>;
  readonly show_cloud: boolean;
  readonly description: string;
  readonly hierarchical: boolean;
  readonly types: readonly string[];
  readonly rest_base: string;
  readonly rest_namespace: string;
};
type ContentDefinition = { readonly storageKey: string; readonly storageAdapter: "posts"; readonly rest: ContentRest };
type TaxonomyDefinition = { readonly storageKey: string; readonly rest: TaxonomyRest };
type DefinitionKeys<T extends readonly { readonly storageKey: string }[]> = { readonly [K in keyof T]: T[K]["storageKey"] };

function invalid(code: string): never { throw new Error("Invalid built-in content registry: " + code + "."); }
const own = (value: object, key: string) => Object.hasOwn(value, key);

/** Read only own JSON data; never invoke accessors or retain the input tree. */
function* arrayValues(value: unknown): Generator<unknown> {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || Object.getOwnPropertySymbols(value).length) invalid("JSON_SHAPE");
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Object.keys(descriptors).some(key => key !== "length" && (!/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= value.length))) invalid("JSON_SHAPE");
  for (let i = 0; i < value.length; i++) {
    const descriptor = descriptors[String(i)];
    if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) invalid("JSON_SHAPE");
    yield descriptor.value;
  }
}
function copyJSON(value: unknown, ancestors = new Set<object>()): JSONValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "object" || ancestors.has(value)) invalid("JSON_SHAPE");
  const prototype = Object.getPrototypeOf(value);
  if (!Array.isArray(value) && prototype !== Object.prototype && prototype !== null) invalid("JSON_SHAPE");
  ancestors.add(value);
  try {
    if (Array.isArray(value)) return Array.from(arrayValues(value), item => copyJSON(item, ancestors));
    const result: JSONObject = {};
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== "string") invalid("JSON_SHAPE");
      const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
      if (!descriptor.enumerable || !("value" in descriptor)) invalid("JSON_SHAPE");
      Object.defineProperty(result, key, { value: copyJSON(descriptor.value, ancestors), enumerable: true, writable: true, configurable: true });
    }
    return result;
  } finally { ancestors.delete(value); }
}
function record(value: JSONValue): JSONObject {
  if (value === null || typeof value !== "object" || Array.isArray(value)) invalid("METADATA_SHAPE");
  return value;
}
function fields(value: JSONValue, required: readonly string[]): JSONObject {
  const result = record(value);
  if (required.some(key => !own(result, key)) || Object.keys(result).some(key => !required.includes(key))) invalid("METADATA_SHAPE");
  return result;
}
function typed(value: JSONObject, keys: readonly string[], type: "string" | "boolean") {
  if (keys.some(key => typeof value[key] !== type)) invalid("METADATA_SHAPE");
}
function strings(value: JSONValue) {
  if (!Array.isArray(value) || value.some(item => typeof item !== "string")) invalid("METADATA_SHAPE");
}
function labels(value: JSONValue) { typed(fields(value, ["name", "singular_name"]), ["name", "singular_name"], "string"); }
function contentRest(value: JSONValue): ContentRest {
  const rest = fields(value, ["slug", "name", "labels", "viewable", "description", "hierarchical", "rest_base", "rest_namespace", "taxonomies", "supports"]);
  typed(rest, ["slug", "name", "description", "rest_base", "rest_namespace"], "string");
  typed(rest, ["viewable", "hierarchical"], "boolean"); labels(rest.labels); strings(rest.taxonomies);
  if (Object.values(record(rest.supports)).some(flag => typeof flag !== "boolean")) invalid("METADATA_SHAPE");
  return rest as unknown as ContentRest;
}
function taxonomyRest(value: JSONValue): TaxonomyRest {
  const rest = fields(value, ["slug", "name", "labels", "visibility", "show_cloud", "description", "hierarchical", "types", "rest_base", "rest_namespace"]);
  typed(rest, ["slug", "name", "description", "rest_base", "rest_namespace"], "string");
  typed(rest, ["show_cloud", "hierarchical"], "boolean"); labels(rest.labels); strings(rest.types);
  const names = ["public", "publicly_queryable", "show_ui", "show_in_nav_menus", "show_admin_column", "show_tagcloud"];
  typed(fields(rest.visibility, names), names, "boolean");
  return rest as unknown as TaxonomyRest;
}
function storageKey(value: JSONValue, max: number): string {
  if (typeof value !== "string" || !value.length || value.length > max || !/^[a-z0-9_-]+$/.test(value)) invalid("CANONICAL_KEY");
  if (["__proto__", "prototype", "constructor", "attachment", "wp_block", "wp_navigation"].includes(value)) invalid("RESERVED_KEY");
  return value;
}
function freeze<T>(value: T): Frozen<T> {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value as Frozen<T>;
}

export type BuiltinContentTypeKey = typeof contentDefinitions[number]["storageKey"];
export type BuiltinTaxonomyKey = typeof taxonomyDefinitions[number]["storageKey"];
type BuiltinTaxonomyRestKey = typeof taxonomyDefinitions[number]["rest"]["slug"];
type BuiltinRegistry = {
  readonly contentTypes: Frozen<Record<BuiltinContentTypeKey, ContentDefinition>>;
  readonly taxonomies: Frozen<Record<BuiltinTaxonomyKey, TaxonomyDefinition>>;
  readonly restContentTypes: Frozen<Record<BuiltinContentTypeKey, ContentRest>>;
  readonly restTaxonomies: Frozen<Record<BuiltinTaxonomyRestKey, TaxonomyRest>>;
  readonly contentKeys: DefinitionKeys<typeof contentDefinitions>;
  readonly taxonomyKeys: DefinitionKeys<typeof taxonomyDefinitions>;
};

/** Trusted construction only: every successful result has the same closed builtin identities. */
export function compileBuiltinContentRegistry(contentInput: readonly unknown[], taxonomyInput: readonly unknown[]): BuiltinRegistry {
  const content: ContentDefinition[] = [], taxonomies: TaxonomyDefinition[] = [];
  const contentKeys = new Set<string>(), taxonomyKeys = new Set<string>(), contentSlugs = new Set<string>(), taxonomySlugs = new Set<string>();
  const collections = new Set(["media", "blocks", "navigation", "comments", "users", "themes", "settings", "types", "taxonomies", "statuses"].map(base => "wp/v2\0" + base));
  const collection = (rest: ContentRest | TaxonomyRest) => {
    const pair = rest.rest_namespace + "\0" + rest.rest_base;
    if (collections.has(pair)) invalid("REST_COLLECTION_COLLISION");
    collections.add(pair);
  };
  for (const raw of arrayValues(contentInput)) {
    const entry = fields(copyJSON(raw), ["storageKey", "storageAdapter", "rest"]), key = storageKey(entry.storageKey, 20);
    if (entry.storageAdapter !== "posts") invalid("CONTENT_ADAPTER");
    const rest = contentRest(entry.rest);
    if (contentKeys.has(key)) invalid("DUPLICATE_CONTENT_KEY"); contentKeys.add(key);
    if (contentSlugs.has(rest.slug)) invalid("DUPLICATE_CONTENT_REST_SLUG"); contentSlugs.add(rest.slug); collection(rest);
    if (key !== "post" && key !== "page") invalid("CONTENT_IDENTITIES");
    if (rest.slug !== key || rest.rest_base !== (key === "post" ? "posts" : "pages") || rest.rest_namespace !== "wp/v2") invalid("CONTENT_IDENTITIES");
    content.push(entry as unknown as ContentDefinition);
  }
  for (const raw of arrayValues(taxonomyInput)) {
    const entry = fields(copyJSON(raw), ["storageKey", "rest"]), key = storageKey(entry.storageKey, 32);
    const rest = taxonomyRest(entry.rest);
    if (taxonomyKeys.has(key)) invalid("DUPLICATE_TAXONOMY_KEY"); taxonomyKeys.add(key);
    if (taxonomySlugs.has(rest.slug)) invalid("DUPLICATE_TAXONOMY_REST_SLUG"); taxonomySlugs.add(rest.slug); collection(rest);
    if (key !== "category" && key !== "tag") invalid("TAXONOMY_IDENTITIES");
    if (rest.slug !== (key === "tag" ? "post_tag" : "category") || rest.rest_base !== (key === "tag" ? "tags" : "categories") || rest.rest_namespace !== "wp/v2") invalid("TAXONOMY_IDENTITIES");
    taxonomies.push(entry as unknown as TaxonomyDefinition);
  }
  if (content.length !== 2 || content[0].storageKey !== "post" || content[1].storageKey !== "page") invalid("CONTENT_ORDER");
  if (taxonomies.length !== 2 || taxonomies[0].storageKey !== "category" || taxonomies[1].storageKey !== "tag") invalid("TAXONOMY_ORDER");
  const byContent = new Map(content.map(item => [item.storageKey, item])), byTaxonomy = new Map(taxonomies.map(item => [item.rest.slug, item]));
  for (const item of content) {
    const seen = new Set<string>();
    for (const slug of item.rest.taxonomies) {
      if (seen.has(slug)) invalid("DUPLICATE_ASSOCIATION"); seen.add(slug);
      const taxonomy = byTaxonomy.get(slug);
      if (!taxonomy || !taxonomy.rest.types.includes(item.storageKey)) invalid("ASSOCIATION");
    }
  }
  for (const item of taxonomies) {
    const seen = new Set<string>();
    for (const key of item.rest.types) {
      if (seen.has(key)) invalid("DUPLICATE_ASSOCIATION"); seen.add(key);
      const type = byContent.get(key);
      if (!type || !type.rest.taxonomies.includes(item.rest.slug)) invalid("ASSOCIATION");
    }
  }
  // These casts follow the exact closed identity/order checks above, never request data.
  return freeze({
    contentTypes: Object.fromEntries(content.map(item => [item.storageKey, item])),
    taxonomies: Object.fromEntries(taxonomies.map(item => [item.storageKey, item])),
    restContentTypes: Object.fromEntries(content.map(item => [item.storageKey, item.rest])),
    restTaxonomies: Object.fromEntries(taxonomies.map(item => [item.rest.slug, item.rest])),
    contentKeys: content.map(item => item.storageKey),
    taxonomyKeys: taxonomies.map(item => item.storageKey),
  }) as unknown as BuiltinRegistry;
}

const contentDefinitions = [
  { storageKey: "post", storageAdapter: "posts", rest: {
    slug: "post",
    name: "Posts",
    labels: { name: "Posts", singular_name: "Post" },
    viewable: true,
    description: "Posts published in the site blog.",
    hierarchical: false,
    rest_base: "posts",
    rest_namespace: "wp/v2",
    taxonomies: ["category", "post_tag"],
    supports: {
      title: true,
      editor: true,
      excerpt: true,
      author: true,
      thumbnail: true,
      "custom-fields": true,
      "post-formats": true,
      comments: true,
      revisions: true,
    },
  } },
  { storageKey: "page", storageAdapter: "posts", rest: {
    slug: "page",
    name: "Pages",
    labels: { name: "Pages", singular_name: "Page" },
    viewable: true,
    description: "Hierarchical site pages.",
    hierarchical: true,
    rest_base: "pages",
    rest_namespace: "wp/v2",
    taxonomies: [],
    supports: {
      title: true,
      editor: true,
      excerpt: true,
      author: true,
      thumbnail: true,
      "custom-fields": true,
      comments: true,
      revisions: true,
      "page-attributes": true,
    },
  } },
] as const satisfies readonly ContentDefinition[];

const taxonomyDefinitions = [
  { storageKey: "category", rest: {
    slug: "category",
    name: "Categories",
    labels: { name: "Categories", singular_name: "Category" },
    visibility: { public: true, publicly_queryable: true, show_ui: true, show_in_nav_menus: true, show_admin_column: true, show_tagcloud: true },
    show_cloud: true,
    description: "Hierarchical post categories.",
    hierarchical: true,
    types: ["post"],
    rest_base: "categories",
    rest_namespace: "wp/v2",
  } },
  { storageKey: "tag", rest: {
    slug: "post_tag",
    name: "Tags",
    labels: { name: "Tags", singular_name: "Tag" },
    visibility: { public: true, publicly_queryable: true, show_ui: true, show_in_nav_menus: true, show_admin_column: true, show_tagcloud: true },
    show_cloud: true,
    description: "Post tags.",
    hierarchical: false,
    types: ["post"],
    rest_base: "tags",
    rest_namespace: "wp/v2",
  } },
] as const satisfies readonly TaxonomyDefinition[];

const builtins = compileBuiltinContentRegistry(contentDefinitions, taxonomyDefinitions);
export const builtinContentTypes = builtins.contentTypes;
export const builtinTaxonomies = builtins.taxonomies;
export const builtinRestContentTypes = builtins.restContentTypes;
export const builtinRestTaxonomies = builtins.restTaxonomies;
export const builtinContentTypeKeys = builtins.contentKeys;
export const builtinTaxonomyKeys = builtins.taxonomyKeys;
export function isBuiltinContentType(value: unknown): value is BuiltinContentTypeKey {
  return typeof value === "string" && builtinContentTypeKeys.includes(value as BuiltinContentTypeKey);
}
