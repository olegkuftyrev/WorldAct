import { createHash } from "node:crypto";
import { builtinContentTypes, builtinTaxonomies } from "./content-registry.js";

type JSONValue = null | string | number | boolean | JSONValue[] | JSONObject;
type JSONObject = { [key: string]: JSONValue };
type CapabilityFamily = "post" | "page";
type Routing = Readonly<{ profile: string; rewrite?: false; queryVar?: false; hasArchive?: false }>;
type ContentRest = Readonly<{
  slug: string; name: string; labels: Readonly<{ name: string; singular_name: string }>;
  viewable: boolean; description: string; hierarchical: boolean; rest_base: string;
  rest_namespace: string; taxonomies: readonly string[]; supports: Readonly<Record<string, boolean>>;
}>;
type TaxonomyRest = Readonly<{
  slug: string; name: string; labels: Readonly<{ name: string; singular_name: string }>;
  visibility: Readonly<Record<string, boolean>>; show_cloud: boolean; description: string;
  hierarchical: boolean; types: readonly string[]; rest_base: string; rest_namespace: string;
}>;
type Visibility = Readonly<{
  hierarchical: boolean; public: boolean; publiclyQueryable: boolean; showInRest: boolean;
  showUI: boolean; showInNavigation: boolean;
}>;
type ContentPolicy = Visibility & Readonly<{
  excludeFromSearch: boolean; capabilityFamily: CapabilityFamily; mapMetaCap: true; routing: Routing;
}>;
type TaxonomyPolicy = Visibility & Readonly<{
  permissions: Readonly<{ managementProfile: "builtin-category" | "builtin-tag" | "managed-page"; assignmentFamily: CapabilityFamily }>;
  routing: Routing; defaultTerm: "configured-category" | null;
}>;
type Identity = Readonly<{ owner: string; integrityRevision: number }>;
export type RuntimeContentDefinition = Identity & Readonly<{
  key: string; storageAdapter: "posts"; rest: ContentRest; policy: ContentPolicy;
}>;
export type RuntimeTaxonomyDefinition = Identity & Readonly<{
  key: string; rest: TaxonomyRest; policy: TaxonomyPolicy;
}>;
export type RuntimeContentSnapshot = Readonly<{
  profileVersion: 1; profileFingerprint: string; sources: readonly Identity[];
  contentKeys: readonly string[]; taxonomyKeys: readonly string[];
  contentTypes: Readonly<Record<string, RuntimeContentDefinition>>;
  taxonomies: Readonly<Record<string, RuntimeTaxonomyDefinition>>;
  restContentTypes: Readonly<Record<string, ContentRest>>;
  restTaxonomies: Readonly<Record<string, TaxonomyRest>>;
}>;

const snapshotBrand = Symbol("compiled-content-runtime");
const snapshotToken = Object.freeze({});
const builtinOwner = "worldact/builtin";
const visibilityKeys = ["hierarchical", "public", "publiclyQueryable", "showInRest", "showUI", "showInNavigation"] as const;
const reservedKeys = ["__proto__", "prototype", "constructor", "attachment", "wp_block", "wp_navigation"];
const reservedCollections = ["media", "blocks", "navigation", "comments", "users", "themes", "settings", "types", "taxonomies", "statuses"];

function invalid(code: string): never { throw new Error("Invalid runtime content registry: " + code + "."); }
function copyJSON(value: unknown, ancestors = new Set<object>()): JSONValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "object" || ancestors.has(value)) invalid("JSON_SHAPE");
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null && !(Array.isArray(value) && prototype === Array.prototype)) invalid("JSON_SHAPE");
  ancestors.add(value);
  try {
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (Reflect.ownKeys(descriptors).some(key => typeof key !== "string")) invalid("JSON_SHAPE");
    if (Array.isArray(value)) {
      if (Object.keys(descriptors).some(key => key !== "length" && (!/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= value.length))) invalid("JSON_SHAPE");
      const result: JSONValue[] = [];
      for (let i = 0; i < value.length; i++) {
        const descriptor = descriptors[String(i)];
        if (!descriptor?.enumerable || !("value" in descriptor)) invalid("JSON_SHAPE");
        result.push(copyJSON(descriptor.value, ancestors));
      }
      return result;
    }
    const result: JSONObject = {};
    for (const key of Object.keys(descriptors)) {
      const descriptor = descriptors[key];
      if (!descriptor.enumerable || !("value" in descriptor)) invalid("JSON_SHAPE");
      Object.defineProperty(result, key, { value: copyJSON(descriptor.value, ancestors), enumerable: true, writable: true, configurable: true });
    }
    return result;
  } finally { ancestors.delete(value); }
}
function object(value: JSONValue, code: string): JSONObject {
  if (value === null || typeof value !== "object" || Array.isArray(value)) invalid(code);
  return value;
}
function fields(value: JSONValue, names: readonly string[], code: string): JSONObject {
  const result = object(value, code);
  if (names.some(key => !Object.hasOwn(result, key)) || Object.keys(result).some(key => !names.includes(key))) invalid(code);
  return result;
}
function string(value: JSONValue, code: string): string { if (typeof value !== "string") invalid(code); return value; }
function boolean(value: JSONValue, code: string): boolean { if (typeof value !== "boolean") invalid(code); return value; }
function array(value: JSONValue, code: string): JSONValue[] { if (!Array.isArray(value)) invalid(code); return value; }
function strings(value: JSONValue, code: string): string[] { return array(value, code).map(item => string(item, code)); }
function key(value: JSONValue, max: number): string {
  const result = string(value, "CANONICAL_KEY");
  if (!result.length || result.length > max || !/^[a-z0-9_-]+$/.test(result)) invalid("CANONICAL_KEY");
  if (reservedKeys.includes(result)) invalid("RESERVED_KEY");
  return result;
}
function labels(value: JSONValue) {
  const item = fields(value, ["name", "singular_name"], "REST_SHAPE");
  return { name: string(item.name, "REST_SHAPE"), singular_name: string(item.singular_name, "REST_SHAPE") };
}
function contentRest(value: JSONValue): ContentRest {
  const item = fields(value, ["slug", "name", "labels", "viewable", "description", "hierarchical", "rest_base", "rest_namespace", "taxonomies", "supports"], "REST_SHAPE");
  for (const name of ["slug", "name", "description", "rest_base", "rest_namespace"]) string(item[name], "REST_SHAPE");
  boolean(item.viewable, "REST_SHAPE"); boolean(item.hierarchical, "REST_SHAPE"); labels(item.labels); strings(item.taxonomies, "REST_SHAPE");
  for (const flag of Object.values(object(item.supports, "REST_SHAPE"))) boolean(flag, "REST_SHAPE");
  // Own JSON and every required field were validated; preserve declared field order.
  return item as unknown as ContentRest;
}
function taxonomyRest(value: JSONValue): TaxonomyRest {
  const item = fields(value, ["slug", "name", "labels", "visibility", "show_cloud", "description", "hierarchical", "types", "rest_base", "rest_namespace"], "REST_SHAPE");
  for (const name of ["slug", "name", "description", "rest_base", "rest_namespace"]) string(item[name], "REST_SHAPE");
  boolean(item.show_cloud, "REST_SHAPE"); boolean(item.hierarchical, "REST_SHAPE"); labels(item.labels); strings(item.types, "REST_SHAPE");
  const visibility = fields(item.visibility, ["public", "publicly_queryable", "show_ui", "show_in_nav_menus", "show_admin_column", "show_tagcloud"], "REST_SHAPE");
  for (const flag of Object.values(visibility)) boolean(flag, "REST_SHAPE");
  return item as unknown as TaxonomyRest;
}
function policyShape(value: JSONValue, taxonomy: boolean): JSONObject {
  const item = fields(value, [...visibilityKeys, ...(taxonomy ? ["permissions", "routing", "defaultTerm"] : ["excludeFromSearch", "capabilityFamily", "mapMetaCap", "routing"])], "POLICY_SHAPE");
  for (const name of visibilityKeys) boolean(item[name], "POLICY_SHAPE");
  if (taxonomy) {
    const permissions = fields(item.permissions, ["managementProfile", "assignmentFamily"], "POLICY_SHAPE");
    string(permissions.managementProfile, "POLICY_SHAPE"); string(permissions.assignmentFamily, "POLICY_SHAPE");
    if (item.defaultTerm !== null) string(item.defaultTerm, "POLICY_SHAPE");
  } else {
    boolean(item.excludeFromSearch, "POLICY_SHAPE"); string(item.capabilityFamily, "POLICY_SHAPE"); boolean(item.mapMetaCap, "POLICY_SHAPE");
  }
  const routing = object(item.routing, "POLICY_SHAPE"), profile = string(routing.profile, "POLICY_SHAPE");
  fields(routing, profile === "plain-custom" ? ["profile", "rewrite", "queryVar", ...(taxonomy ? [] : ["hasArchive"])] : ["profile"], "POLICY_SHAPE");
  if (profile === "plain-custom") for (const name of ["rewrite", "queryVar", ...(taxonomy ? [] : ["hasArchive"])]) boolean(routing[name], "POLICY_SHAPE");
  return item;
}
function family(value: JSONValue): CapabilityFamily {
  if (value !== "post" && value !== "page") invalid("CAPABILITY_PROFILE");
  return value;
}
function routing(value: JSONValue, expected: string | null, taxonomy: boolean): Routing {
  const item = object(value, "POLICY_SHAPE"), profile = string(item.profile, "POLICY_SHAPE");
  if (expected) { if (profile !== expected) invalid("ROUTING_PROFILE"); return { profile }; }
  if (profile !== "plain-custom" || item.rewrite !== false || item.queryVar !== false || (!taxonomy && item.hasArchive !== false)) invalid("ROUTING_PROFILE");
  return taxonomy ? { profile, rewrite: false, queryVar: false } : { profile, rewrite: false, queryVar: false, hasArchive: false };
}
function visibility(item: JSONObject): Visibility {
  return { hierarchical: boolean(item.hierarchical, "POLICY_SHAPE"), public: boolean(item.public, "POLICY_SHAPE"), publiclyQueryable: boolean(item.publiclyQueryable, "POLICY_SHAPE"), showInRest: boolean(item.showInRest, "POLICY_SHAPE"), showUI: boolean(item.showUI, "POLICY_SHAPE"), showInNavigation: boolean(item.showInNavigation, "POLICY_SHAPE") };
}
function freeze<T>(value: T): T {
  if (value !== null && typeof value === "object") { for (const child of Object.values(value)) freeze(child); Object.freeze(value); }
  return value;
}
function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") { const result = JSON.stringify(value); if (result === undefined) invalid("JSON_SHAPE"); return result; }
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  return "{" + Object.keys(value).sort().map(name => JSON.stringify(name) + ":" + canonical(Object.getOwnPropertyDescriptor(value, name)!.value)).join(",") + "}";
}
function baseVisibility(hierarchical: boolean): Visibility {
  return { hierarchical, public: true, publiclyQueryable: true, showInRest: true, showUI: true, showInNavigation: true };
}

/** Source data only. Nothing in this unwired snapshot authorizes an operation. */
export function compileRuntimeContentRegistry(contributions: readonly unknown[]): RuntimeContentSnapshot {
  const input = array(copyJSON(contributions), "CONTRIBUTION_SHAPE"), sources: Identity[] = [{ owner: builtinOwner, integrityRevision: 1 }];
  const content: Array<{ identity: Identity; key: string; storageAdapter: JSONValue; rest: ContentRest; policy: JSONObject }> = [];
  const taxonomies: Array<{ identity: Identity; key: string; rest: TaxonomyRest; policy: JSONObject }> = [];
  const owners = new Set([builtinOwner]);
  for (const raw of input) {
    const contribution = fields(raw, ["owner", "integrityRevision", "contentTypes", "taxonomies"], "CONTRIBUTION_SHAPE"), owner = string(contribution.owner, "OWNER");
    if (!owner.length || owner.length > 100 || !/^[a-z][a-z0-9]*(?:[._/-][a-z0-9]+)*$/.test(owner) || owner === builtinOwner) invalid("OWNER");
    const revision = contribution.integrityRevision;
    if (typeof revision !== "number" || !Number.isInteger(revision) || revision < 1 || revision > 2147483647) invalid("REVISION");
    const identity = { owner, integrityRevision: revision }; sources.push(identity);
    for (const rawContent of array(contribution.contentTypes, "CONTRIBUTION_SHAPE")) {
      const entry = fields(rawContent, ["key", "storageAdapter", "rest", "policy"], "CONTENT_SHAPE");
      string(entry.storageAdapter, "CONTENT_SHAPE");
      content.push({ identity, key: key(entry.key, 20), storageAdapter: entry.storageAdapter, rest: contentRest(entry.rest), policy: policyShape(entry.policy, false) });
    }
    for (const rawTaxonomy of array(contribution.taxonomies, "CONTRIBUTION_SHAPE")) {
      const entry = fields(rawTaxonomy, ["key", "rest", "policy"], "TAXONOMY_SHAPE");
      taxonomies.push({ identity, key: key(entry.key, 32), rest: taxonomyRest(entry.rest), policy: policyShape(entry.policy, true) });
    }
  }
  const contentTypes: Record<string, RuntimeContentDefinition> = Object.create(null), taxonomyTypes: Record<string, RuntimeTaxonomyDefinition> = Object.create(null);
  const contentDefinitions: RuntimeContentDefinition[] = [], taxonomyDefinitions: RuntimeTaxonomyDefinition[] = [];
  const contentKeys: string[] = [], taxonomyKeys: string[] = [];
  for (const name of ["post", "page"] as const) {
    contentTypes[name] = { key: name, owner: builtinOwner, integrityRevision: 1, storageAdapter: "posts", rest: contentRest(copyJSON(builtinContentTypes[name].rest)), policy: { ...baseVisibility(name === "page"), excludeFromSearch: name !== "post", capabilityFamily: name, mapMetaCap: true, routing: { profile: "builtin-" + name } } };
    contentDefinitions.push(contentTypes[name]); contentKeys.push(name);
  }
  for (const name of ["category", "tag"] as const) {
    // These references preserve operation-specific legacy gates: authors may
    // create tags, but update/delete remain admin/editor; assignment still
    // follows the actual post mutation gate, including contributor cases.
    taxonomyTypes[name] = { key: name, owner: builtinOwner, integrityRevision: 1, rest: taxonomyRest(copyJSON(builtinTaxonomies[name].rest)), policy: { ...baseVisibility(name === "category"), permissions: { managementProfile: name === "category" ? "builtin-category" : "builtin-tag", assignmentFamily: "post" }, routing: { profile: "builtin-" + name }, defaultTerm: name === "category" ? "configured-category" : null } };
    taxonomyDefinitions.push(taxonomyTypes[name]); taxonomyKeys.push(name);
  }
  for (const identity of sources.slice(1)) {
    if (owners.has(identity.owner)) invalid("DUPLICATE_OWNER"); owners.add(identity.owner);
  }
  const contentKeySet = new Set(contentKeys), taxonomyKeySet = new Set(taxonomyKeys);
  const contentSlugs = new Set(contentDefinitions.map(item => item.rest.slug)), taxonomySlugs = new Set(taxonomyDefinitions.map(item => item.rest.slug));
  const collections = new Set(reservedCollections.map(base => "wp/v2\0" + base));
  for (const item of [...contentDefinitions, ...taxonomyDefinitions]) collections.add(item.rest.rest_namespace + "\0" + item.rest.rest_base);
  function collision(rest: ContentRest | TaxonomyRest, slugs: Set<string>, code: string) {
    if (slugs.has(rest.slug)) invalid(code); slugs.add(rest.slug);
    const pair = rest.rest_namespace + "\0" + rest.rest_base;
    if (collections.has(pair)) invalid("REST_COLLECTION_COLLISION"); collections.add(pair);
  }
  function restIdentity(rest: ContentRest | TaxonomyRest, storageKey: string) {
    if (rest.slug !== storageKey || rest.rest_namespace !== "wp/v2" || !/^[a-z0-9][a-z0-9_-]*$/.test(rest.rest_base)) invalid("REST_IDENTITY");
  }
  for (const item of content) {
    if (contentKeySet.has(item.key)) invalid("DUPLICATE_CONTENT_KEY"); contentKeySet.add(item.key); contentKeys.push(item.key);
    collision(item.rest, contentSlugs, "DUPLICATE_CONTENT_REST_SLUG");
  }
  for (const item of taxonomies) {
    if (taxonomyKeySet.has(item.key)) invalid("DUPLICATE_TAXONOMY_KEY"); taxonomyKeySet.add(item.key); taxonomyKeys.push(item.key);
    collision(item.rest, taxonomySlugs, "DUPLICATE_TAXONOMY_REST_SLUG");
  }
  for (const item of content) {
    restIdentity(item.rest, item.key);
    if (item.storageAdapter !== "posts") invalid("CONTENT_ADAPTER");
    const flags = visibility(item.policy);
    if (flags.hierarchical !== item.rest.hierarchical || flags.publiclyQueryable !== item.rest.viewable) invalid("POLICY_REST_MISMATCH");
    const capabilityFamily = family(item.policy.capabilityFamily);
    if (item.policy.mapMetaCap !== true) invalid("CAPABILITY_PROFILE");
    contentTypes[item.key] = { ...item.identity, key: item.key, storageAdapter: "posts", rest: item.rest, policy: { ...flags, excludeFromSearch: boolean(item.policy.excludeFromSearch, "POLICY_SHAPE"), capabilityFamily, mapMetaCap: true, routing: routing(item.policy.routing, null, false) } };
    contentDefinitions.push(contentTypes[item.key]);
  }
  for (const item of taxonomies) {
    restIdentity(item.rest, item.key);
    const flags = visibility(item.policy), permissions = object(item.policy.permissions, "POLICY_SHAPE"), managementProfile = permissions.managementProfile;
    if (managementProfile !== "builtin-category" && managementProfile !== "builtin-tag" && managementProfile !== "managed-page") invalid("CAPABILITY_PROFILE");
    if (flags.hierarchical !== item.rest.hierarchical || flags.public !== item.rest.visibility.public || flags.publiclyQueryable !== item.rest.visibility.publicly_queryable || flags.showUI !== item.rest.visibility.show_ui || flags.showInNavigation !== item.rest.visibility.show_in_nav_menus) invalid("POLICY_REST_MISMATCH");
    if (item.policy.defaultTerm !== null) invalid("DEFAULT_TERM_PROFILE");
    const assignmentFamily = family(permissions.assignmentFamily);
    if (managementProfile === "managed-page" && assignmentFamily !== "page") invalid("CAPABILITY_PROFILE");
    taxonomyTypes[item.key] = { ...item.identity, key: item.key, rest: item.rest, policy: { ...flags, permissions: { managementProfile, assignmentFamily }, routing: routing(item.policy.routing, null, true), defaultTerm: null } };
    taxonomyDefinitions.push(taxonomyTypes[item.key]);
  }
  const byRestTaxonomy = new Map(taxonomyDefinitions.map(item => [item.rest.slug, item]));
  for (const item of contentDefinitions) {
    const seen = new Set<string>();
    for (const slug of item.rest.taxonomies) { if (seen.has(slug)) invalid("DUPLICATE_ASSOCIATION"); seen.add(slug); const taxonomy = byRestTaxonomy.get(slug); if (!taxonomy || !taxonomy.rest.types.includes(item.key)) invalid("ASSOCIATION"); }
  }
  for (const item of taxonomyDefinitions) {
    const seen = new Set<string>();
    for (const name of item.rest.types) { if (seen.has(name)) invalid("DUPLICATE_ASSOCIATION"); seen.add(name); const type = contentTypes[name]; if (!type || !type.rest.taxonomies.includes(item.rest.slug)) invalid("ASSOCIATION"); }
  }
  // The arrays retain registration order, including numeric keys. JavaScript
  // record enumeration sorts integer-like keys in lookup and REST projections.
  const data = {
    profileVersion: 1 as const, sources, contentKeys, taxonomyKeys, contentTypes, taxonomies: taxonomyTypes,
    restContentTypes: Object.fromEntries(contentDefinitions.filter(item => item.policy.showInRest).map(item => [item.rest.slug, item.rest])),
    restTaxonomies: Object.fromEntries(taxonomyDefinitions.filter(item => item.policy.showInRest).map(item => [item.rest.slug, item.rest])),
  };
  const snapshot: RuntimeContentSnapshot = { ...data, profileFingerprint: createHash("sha256").update(canonical(data)).digest("hex") };
  Object.defineProperty(snapshot, snapshotBrand, { value: snapshotToken });
  return freeze(snapshot);
}

/** Provenance only; never a permission or database registration check. */
export function isCompiledContentRuntime(value: unknown): value is RuntimeContentSnapshot {
  return value !== null && typeof value === "object" && Object.isFrozen(value) && Object.getOwnPropertyDescriptor(value, snapshotBrand)?.value === snapshotToken;
}
export function runtimeContentType(snapshot: RuntimeContentSnapshot, value: unknown): RuntimeContentDefinition | undefined {
  if (!isCompiledContentRuntime(snapshot)) invalid("SNAPSHOT_PROVENANCE");
  return typeof value === "string" && Object.hasOwn(snapshot.contentTypes, value) ? snapshot.contentTypes[value] : undefined;
}
export function runtimeTaxonomy(snapshot: RuntimeContentSnapshot, value: unknown): RuntimeTaxonomyDefinition | undefined {
  if (!isCompiledContentRuntime(snapshot)) invalid("SNAPSHOT_PROVENANCE");
  return typeof value === "string" && Object.hasOwn(snapshot.taxonomies, value) ? snapshot.taxonomies[value] : undefined;
}
