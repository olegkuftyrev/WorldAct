import test from "./isolated-test.js";
import assert from "node:assert/strict";
import {
  builtinContentTypes, builtinTaxonomies, builtinRestContentTypes, builtinRestTaxonomies,
  builtinContentTypeKeys, builtinTaxonomyKeys, isBuiltinContentType, compileBuiltinContentRegistry,
} from "../server/content-registry.js";

// These direct compiler/predicate imports remain SOURCE under a compiled API.
type Fixture = { content: any[]; taxonomies: any[] };
const fixture = (): Fixture => JSON.parse(JSON.stringify({ content: Object.values(builtinContentTypes), taxonomies: Object.values(builtinTaxonomies) }));

test("builtin identities stay closed and membership never coerces input", () => {
  assert.deepEqual(builtinContentTypeKeys, ["post", "page"]);
  assert.deepEqual(builtinTaxonomyKeys, ["category", "tag"]);
  assert.deepEqual(Object.keys(builtinRestContentTypes), ["post", "page"]);
  assert.deepEqual(Object.keys(builtinRestTaxonomies), ["category", "post_tag"]);
  assert.equal(builtinTaxonomies.tag.rest.slug, "post_tag"); assert.equal(builtinTaxonomies.tag.rest.rest_base, "tags");
  assert.strictEqual(builtinRestTaxonomies.post_tag, builtinTaxonomies.tag.rest);
  assert.strictEqual(builtinRestContentTypes.post, builtinContentTypes.post.rest);
  assert.equal(Object.getPrototypeOf(builtinRestContentTypes), Object.prototype);
  assert.equal(Object.getPrototypeOf(builtinRestTaxonomies), Object.prototype);
  assert.equal(Object.hasOwn(builtinRestContentTypes.post, "storageAdapter"), false);
  for (const key of ["attachment", "wp_block", "wp_navigation"]) assert.equal(Object.hasOwn(builtinContentTypes, key), false);
  assert.equal(isBuiltinContentType("post"), true); assert.equal(isBuiltinContentType("page"), true);
  let coercions = 0;
  const object = { toString() { coercions++; return "post"; }, valueOf() { coercions++; return "page"; } };
  for (const value of [undefined, null, false, 0, "", "Post", " post", "book", "attachment", "wp_block", "wp_navigation", ["post"], new String("post"), object])
    assert.equal(isBuiltinContentType(value), false);
  assert.equal(coercions, 0);
});

test("builtin compiler rejects collisions, invalid definitions and broken associations deterministically", () => {
  const cases: Array<[string, (input: Fixture) => void, string]> = [
    ["content required metadata precedes duplicate", d => { d.content[1].storageKey = "post"; d.content[1].rest.labels = null; }, "METADATA_SHAPE"],
    ["taxonomy required metadata precedes duplicate", d => { d.taxonomies[1].storageKey = "category"; d.taxonomies[1].rest.labels = null; }, "METADATA_SHAPE"],
    ["content adapter precedes duplicate", d => { d.content[1].storageKey = "post"; d.content[1].storageAdapter = "media"; }, "CONTENT_ADAPTER"],
    ["content duplicate precedes its identity mismatch", d => { d.content[1].storageKey = "post"; d.content[1].rest.slug = "wrong"; }, "DUPLICATE_CONTENT_KEY"],
    ["taxonomy duplicate", d => { d.taxonomies[1].storageKey = "category"; }, "DUPLICATE_TAXONOMY_KEY"],
    ["content REST slug", d => { d.content[1].rest.slug = "post"; }, "DUPLICATE_CONTENT_REST_SLUG"],
    ["taxonomy REST slug", d => { d.taxonomies[1].rest.slug = "category"; }, "DUPLICATE_TAXONOMY_REST_SLUG"],
    ["same-family collection", d => { d.content[1].rest.rest_base = "posts"; }, "REST_COLLECTION_COLLISION"],
    ["cross-family collection", d => { d.taxonomies[0].rest.rest_base = "posts"; }, "REST_COLLECTION_COLLISION"],
    ["reserved wp/v2 collection", d => { d.content[1].rest.rest_base = "media"; }, "REST_COLLECTION_COLLISION"],
    ["content order", d => { d.content.reverse(); }, "CONTENT_ORDER"],
    ["taxonomy order", d => { d.taxonomies.reverse(); }, "TAXONOMY_ORDER"],
    ["unknown content key", d => { d.content[1].storageKey = "book"; }, "CONTENT_IDENTITIES"],
    ["tag REST mapping", d => { d.taxonomies[1].rest.slug = "tag"; }, "TAXONOMY_IDENTITIES"],
    ["separate adapter", d => { d.content[0].storageAdapter = "media"; }, "CONTENT_ADAPTER"],
    ["duplicate content association", d => { d.content[0].rest.taxonomies.push("category"); }, "DUPLICATE_ASSOCIATION"],
    ["duplicate taxonomy association", d => { d.taxonomies[0].rest.types.push("post"); }, "DUPLICATE_ASSOCIATION"],
    ["missing taxonomy", d => { d.content[0].rest.taxonomies = ["genre"]; }, "ASSOCIATION"],
    ["nonreciprocal association", d => { d.taxonomies[0].rest.types = []; }, "ASSOCIATION"],
    ["missing required metadata", d => { delete d.content[0].rest.description; }, "METADATA_SHAPE"],
    ["boolean coercion forbidden", d => { d.content[0].rest.hierarchical = "false"; }, "METADATA_SHAPE"],
    ["nonfinite JSON", d => { d.content[0].rest.supports.title = Infinity; }, "JSON_SHAPE"],
    ["custom object prototype", d => { d.content[0].rest.labels = new Date(0); }, "JSON_SHAPE"],
    ["cycle", d => { d.content[0].rest.labels.self = d.content[0].rest.labels; }, "JSON_SHAPE"],
    ["sparse array", d => { delete d.content[0].rest.taxonomies[0]; }, "JSON_SHAPE"],
  ];
  for (const key of ["", "Post", "x".repeat(21)]) cases.push(["canonical content key", d => { d.content[0].storageKey = key; }, "CANONICAL_KEY"]);
  for (const key of ["__proto__", "prototype", "constructor", "attachment", "wp_block", "wp_navigation"]) cases.push(["reserved content key", d => { d.content[0].storageKey = key; }, "RESERVED_KEY"]);
  cases.push(["taxonomy key length", d => { d.taxonomies[0].storageKey = "x".repeat(33); }, "CANONICAL_KEY"]);
  let getterCalls = 0;
  cases.push(["accessor is not executed", d => { Object.defineProperty(d.content[0].rest, "name", { enumerable: true, get() { getterCalls++; return "Getter"; } }); }, "JSON_SHAPE"]);
  for (const [label, mutate, code] of cases) {
    const input = fixture(); mutate(input);
    assert.throws(() => compileBuiltinContentRegistry(input.content, input.taxonomies),
      (error: unknown) => error instanceof Error && error.message === "Invalid built-in content registry: " + code + ".", label);
  }
  assert.equal(getterCalls, 0);
});

test("builtin compiler copies before deep freeze and preserves explicit false and feature absence", () => {
  const input = fixture(); input.content[0].rest.supports.excerpt = false; delete input.content[0].rest.supports["custom-fields"];
  const original = JSON.stringify(input), compiled = compileBuiltinContentRegistry(input.content, input.taxonomies);
  assert.equal(JSON.stringify(input), original);
  assert.equal(compiled.contentTypes.post.rest.supports.excerpt, false);
  assert.equal(Object.hasOwn(compiled.contentTypes.post.rest.supports, "custom-fields"), false);
  for (const [copy, caller] of [
    [compiled.contentTypes.post, input.content[0]], [compiled.contentTypes.post.rest.labels, input.content[0].rest.labels],
    [compiled.contentTypes.post.rest.supports, input.content[0].rest.supports], [compiled.contentTypes.post.rest.taxonomies, input.content[0].rest.taxonomies],
    [compiled.taxonomies.category.rest.visibility, input.taxonomies[0].rest.visibility], [compiled.taxonomies.category.rest.types, input.taxonomies[0].rest.types],
  ]) { assert.notStrictEqual(copy, caller); assert.equal(Object.isFrozen(caller), false); }
  const frozen = (value: unknown): void => { if (value !== null && typeof value === "object") { assert.equal(Object.isFrozen(value), true); for (const child of Object.values(value)) frozen(child); } };
  frozen(compiled); frozen(builtinContentTypes); frozen(builtinTaxonomies); frozen(builtinContentTypeKeys); frozen(builtinTaxonomyKeys);
  assert.equal(Reflect.set(compiled.contentTypes.post.rest.labels, "name", "Changed"), false);
  assert.equal(Reflect.set(compiled.contentKeys, "0", "book"), false);
  assert.equal(Reflect.set(compiled.contentTypes, "book", {}), false);
  const snapshot = JSON.stringify(compiled);
  input.content[0].rest.labels.name = "Caller changed"; input.content[0].rest.taxonomies.push("caller-only"); input.taxonomies[0].rest.visibility.public = false;
  assert.equal(JSON.stringify(compiled), snapshot); assert.equal(Object.isFrozen(input.content), false);
});
