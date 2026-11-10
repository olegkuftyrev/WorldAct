import test from "./isolated-test.js";
import assert from "node:assert/strict";
import { builtinContentTypes, builtinTaxonomies, builtinRestContentTypes, builtinRestTaxonomies, compileBuiltinContentRegistry } from "../server/content-registry.js";
import { compileRuntimeContentRegistry, isCompiledContentRuntime, runtimeContentType, runtimeTaxonomy } from "../server/runtime-content-registry.js";
import { createContentBootstrap, defaultContentBootstrap, assertBuiltinStorageBoundary } from "../server/content-runtime.js";

// SOURCE constructor assertions in both API modes: no HTTP, catalog or custom
// service authority is exercised by successfully compiling this fixture data.
type Fixture = Array<{ owner: string; integrityRevision: number; contentTypes: any[]; taxonomies: any[] }>;
function fixture(): Fixture {
  const flags = { public: true, publiclyQueryable: true, showInRest: true, showUI: true, showInNavigation: true };
  return [{ owner: "fixture-books", integrityRevision: 1, contentTypes: [{
    key: "book", storageAdapter: "posts",
    rest: { slug: "book", name: "Books", labels: { name: "Books", singular_name: "Book" }, viewable: true,
      description: "Constructor book policy only.", hierarchical: false, rest_base: "books", rest_namespace: "wp/v2",
      taxonomies: ["genre"], supports: { title: true, editor: true, excerpt: true, author: true, revisions: true } },
    policy: { hierarchical: false, ...flags, excludeFromSearch: false, capabilityFamily: "page", mapMetaCap: true,
      routing: { profile: "plain-custom", rewrite: false, queryVar: false, hasArchive: false } },
  }], taxonomies: [{
    key: "genre", rest: { slug: "genre", name: "Genres", labels: { name: "Genres", singular_name: "Genre" },
      visibility: { public: true, publicly_queryable: true, show_ui: true, show_in_nav_menus: true, show_admin_column: true, show_tagcloud: true },
      show_cloud: true, description: "Constructor genre policy only.", hierarchical: true, types: ["book"], rest_base: "genres", rest_namespace: "wp/v2" },
    policy: { hierarchical: true, ...flags, permissions: { managementProfile: "managed-page", assignmentFamily: "page" },
      routing: { profile: "plain-custom", rewrite: false, queryVar: false }, defaultTerm: null },
  }] }];
}

test("default runtime preserves closed builtin identities and metadata without widening existing authority", () => {
  const first = defaultContentBootstrap.snapshot, second = compileRuntimeContentRegistry([]);
  assert.equal(isCompiledContentRuntime(first), true);
  assert.notStrictEqual(first, second);
  assert.equal(first.profileVersion, 1);
  assert.match(first.profileFingerprint, /^[a-f0-9]{64}$/);
  assert.equal(first.profileFingerprint, second.profileFingerprint);
  assert.deepEqual(first.sources, [{ owner: "worldact/builtin", integrityRevision: 1 }]);
  assert.deepEqual(first.contentKeys, ["post", "page"]);
  assert.deepEqual(first.taxonomyKeys, ["category", "tag"]);
  assert.deepEqual(first.restContentTypes, builtinRestContentTypes);
  assert.deepEqual(first.restTaxonomies, builtinRestTaxonomies);
  assert.equal(Object.getPrototypeOf(first.restContentTypes), Object.prototype);
  assert.equal(Object.getPrototypeOf(first.contentTypes), null);
  assert.equal(first.contentTypes.post.policy.capabilityFamily, "post");
  assert.equal(first.contentTypes.page.policy.capabilityFamily, "page");
  assert.equal(first.contentTypes.post.policy.excludeFromSearch, false);
  assert.equal(first.contentTypes.page.policy.excludeFromSearch, true);
  assert.deepEqual(first.taxonomies.category.policy.permissions, { managementProfile: "builtin-category", assignmentFamily: "post" });
  assert.deepEqual(first.taxonomies.tag.policy.permissions, { managementProfile: "builtin-tag", assignmentFamily: "post" });
  assert.equal(first.taxonomies.category.policy.defaultTerm, "configured-category");
  assert.equal(first.taxonomies.tag.policy.defaultTerm, null);
  assert.strictEqual(runtimeContentType(first, "post"), first.contentTypes.post);
  assert.strictEqual(runtimeTaxonomy(first, "tag"), first.taxonomies.tag);
  let coercions = 0;
  const object = { toString() { coercions++; return "post"; } };
  for (const key of ["constructor", "toString", "__proto__", "prototype", "book", undefined, null, 0, false, ["post"], new String("post"), Symbol("post"), object]) {
    assert.equal(runtimeContentType(first, key), undefined);
    assert.equal(runtimeTaxonomy(first, key), undefined);
  }
  assert.equal(coercions, 0);
  assert.doesNotThrow(() => assertBuiltinStorageBoundary(defaultContentBootstrap));
  assert.doesNotThrow(() => assertBuiltinStorageBoundary(createContentBootstrap(second)));
  const book = structuredClone(builtinContentTypes.post);
  assert.throws(() => compileBuiltinContentRegistry([...Object.values(builtinContentTypes), { ...book, storageKey: "book", rest: { ...book.rest, slug: "book", rest_base: "books", taxonomies: [] } }], Object.values(builtinTaxonomies)),
    { message: "Invalid built-in content registry: CONTENT_IDENTITIES." });
});

test("trusted book genre data compiles as inert explicit policy and remains rejected by the current storage boundary", () => {
  const snapshot = compileRuntimeContentRegistry(fixture()), bootstrap = createContentBootstrap(snapshot);
  assert.deepEqual(snapshot.contentKeys, ["post", "page", "book"]);
  assert.deepEqual(snapshot.taxonomyKeys, ["category", "tag", "genre"]);
  assert.deepEqual(snapshot.sources[1], { owner: "fixture-books", integrityRevision: 1 });
  const book = runtimeContentType(snapshot, "book")!, genre = runtimeTaxonomy(snapshot, "genre")!;
  assert.equal(book.policy.capabilityFamily, "page"); assert.equal(book.policy.mapMetaCap, true);
  assert.equal(book.policy.hierarchical, false); assert.equal(book.policy.excludeFromSearch, false);
  assert.equal(book.policy.public, true); assert.equal(book.policy.publiclyQueryable, true);
  assert.equal(book.policy.showInRest, true); assert.equal(book.policy.showUI, true); assert.equal(book.policy.showInNavigation, true);
  assert.deepEqual(book.policy.routing, { profile: "plain-custom", rewrite: false, queryVar: false, hasArchive: false });
  assert.equal(genre.policy.hierarchical, true); assert.equal(genre.policy.defaultTerm, null);
  assert.deepEqual(genre.policy.permissions, { managementProfile: "managed-page", assignmentFamily: "page" });
  assert.deepEqual(book.rest.taxonomies, ["genre"]); assert.deepEqual(genre.rest.types, ["book"]);
  assert.strictEqual(snapshot.restContentTypes.book, book.rest);
  assert.strictEqual(snapshot.restTaxonomies.genre, genre.rest);
  for (const value of [snapshot.restContentTypes.book, snapshot.restTaxonomies.genre]) {
    for (const key of ["owner", "integrityRevision", "policy", "storageAdapter"]) assert.equal(Object.hasOwn(value, key), false);
  }
  assert.strictEqual(bootstrap.snapshot, snapshot);
  assert.throws(() => assertBuiltinStorageBoundary(bootstrap), { message: "Custom content storage is not enabled in this build." });
  const copy = JSON.parse(JSON.stringify(snapshot));
  assert.equal(isCompiledContentRuntime(copy), false);
  assert.throws(() => createContentBootstrap(copy), { message: "Invalid content bootstrap: SNAPSHOT_PROVENANCE." });
  assert.throws(() => assertBuiltinStorageBoundary(Object.freeze({ snapshot })), { message: "Invalid content bootstrap: SNAPSHOT_PROVENANCE." });
});

test("runtime compiler fails deterministic shapes collisions and policy profiles without executing input data", () => {
  let getters = 0, coercions = 0;
  const cases: Array<[string, (input: Fixture) => void, string]> = [
    ["owner", d => { d[0].owner = "Bad Owner"; }, "OWNER"],
    ["reserved owner", d => { d[0].owner = "worldact/builtin"; }, "OWNER"],
    ["revision", d => { d[0].integrityRevision = 0; }, "REVISION"],
    ["duplicate owner", d => { d.push(structuredClone(d[0])); }, "DUPLICATE_OWNER"],
    ["canonical key", d => { d[0].contentTypes[0].key = "Book"; }, "CANONICAL_KEY"],
    ["reserved adapter key", d => { d[0].contentTypes[0].key = "wp_block"; }, "RESERVED_KEY"],
    ["metadata precedes duplicate", d => { d[0].contentTypes[0].key = "post"; d[0].contentTypes[0].rest.labels = null; }, "REST_SHAPE"],
    ["policy shape precedes duplicate", d => { d[0].contentTypes[0].key = "post"; d[0].contentTypes[0].policy.roles = ["author"]; }, "POLICY_SHAPE"],
    ["duplicate content identity", d => { d[0].contentTypes[0].key = "post"; }, "DUPLICATE_CONTENT_KEY"],
    ["duplicate taxonomy identity", d => { d[0].taxonomies[0].key = "tag"; }, "DUPLICATE_TAXONOMY_KEY"],
    ["duplicate REST slug", d => { d[0].contentTypes[0].rest.slug = "post"; }, "DUPLICATE_CONTENT_REST_SLUG"],
    ["reserved REST collection", d => { d[0].contentTypes[0].rest.rest_base = "media"; }, "REST_COLLECTION_COLLISION"],
    ["REST namespace", d => { d[0].contentTypes[0].rest.rest_namespace = "extension/v1"; }, "REST_IDENTITY"],
    ["separate adapter", d => { d[0].contentTypes[0].storageAdapter = "media"; }, "CONTENT_ADAPTER"],
    ["unsupported capability", d => { d[0].contentTypes[0].policy.capabilityFamily = "book"; }, "CAPABILITY_PROFILE"],
    ["no meta-cap fallback", d => { d[0].contentTypes[0].policy.mapMetaCap = false; }, "CAPABILITY_PROFILE"],
    ["rewrite not implemented", d => { d[0].contentTypes[0].policy.routing.rewrite = true; }, "ROUTING_PROFILE"],
    ["unknown routing profile", d => { d[0].contentTypes[0].policy.routing = { profile: "plugin" }; }, "ROUTING_PROFILE"],
    ["metadata hierarchy mismatch", d => { d[0].contentTypes[0].rest.hierarchical = true; }, "POLICY_REST_MISMATCH"],
    ["managed assignment mismatch", d => { d[0].taxonomies[0].policy.permissions.assignmentFamily = "post"; }, "CAPABILITY_PROFILE"],
    ["custom default term", d => { d[0].taxonomies[0].policy.defaultTerm = "configured-category"; }, "DEFAULT_TERM_PROFILE"],
    ["missing taxonomy", d => { d[0].contentTypes[0].rest.taxonomies = ["missing"]; }, "ASSOCIATION"],
    ["missing reciprocal association", d => { d[0].taxonomies[0].rest.types = []; }, "ASSOCIATION"],
    ["duplicate association", d => { d[0].contentTypes[0].rest.taxonomies.push("genre"); }, "DUPLICATE_ASSOCIATION"],
    ["getter", d => { Object.defineProperty(d[0].contentTypes[0].rest, "name", { enumerable: true, get() { getters++; return "Executed"; } }); }, "JSON_SHAPE"],
    ["no string coercion", d => { d[0].contentTypes[0].policy.capabilityFamily = { toString() { coercions++; return "page"; } }; }, "JSON_SHAPE"],
    ["sparse data", d => { delete d[0].taxonomies[0].rest.types[0]; }, "JSON_SHAPE"],
    ["cycle", d => { d[0].contentTypes[0].rest.labels.self = d[0].contentTypes[0].rest.labels; }, "JSON_SHAPE"],
    ["nonfinite data", d => { d[0].integrityRevision = Infinity; }, "JSON_SHAPE"],
    ["boolean coercion", d => { d[0].contentTypes[0].policy.public = "false"; }, "POLICY_SHAPE"],
  ];
  for (const [label, mutate, code] of cases) {
    const input = fixture(); mutate(input);
    assert.throws(() => compileRuntimeContentRegistry(input), { message: "Invalid runtime content registry: " + code + "." }, label);
  }
  assert.equal(getters, 0); assert.equal(coercions, 0);
});

test("copied frozen snapshots keep deterministic fingerprints separate from per-bootstrap lifetime and source retirement", () => {
  const input = fixture(), before = JSON.stringify(input), first = compileRuntimeContentRegistry(input), bootstrap = createContentBootstrap(first);
  assert.equal(JSON.stringify(input), before);
  const reversed = fixture();
  reversed[0].contentTypes[0].policy = Object.fromEntries(Object.entries(reversed[0].contentTypes[0].policy).reverse());
  assert.equal(compileRuntimeContentRegistry(reversed).profileFingerprint, first.profileFingerprint);
  assert.deepEqual(first.contentKeys, ["post", "page", "book"]);
  assert.deepEqual(first.contentTypes.post.rest.taxonomies, ["category", "post_tag"]);
  const checkFrozen = (value: unknown): void => {
    if (value !== null && typeof value === "object") { assert.equal(Object.isFrozen(value), true); for (const child of Object.values(value)) checkFrozen(child); }
  };
  checkFrozen(first); checkFrozen(bootstrap);
  assert.equal(Object.isFrozen(input), false);
  assert.notStrictEqual(first.contentTypes.book.rest, input[0].contentTypes[0].rest);
  assert.equal(Reflect.set(first.contentTypes.book.rest.labels, "name", "Changed"), false);
  assert.equal(Reflect.set(first.contentKeys, "0", "book"), false);
  const saved = JSON.stringify(first);
  input[0].contentTypes[0].rest.labels.name = "Caller changed";
  input[0].taxonomies[0].rest.types.push("post");
  assert.equal(JSON.stringify(first), saved);
  const falseInput = fixture(), absentInput = fixture();
  falseInput[0].contentTypes[0].rest.supports.excerpt = false;
  delete absentInput[0].contentTypes[0].rest.supports.excerpt;
  const explicitFalse = compileRuntimeContentRegistry(falseInput), absent = compileRuntimeContentRegistry(absentInput);
  assert.equal(explicitFalse.contentTypes.book.rest.supports.excerpt, false);
  assert.equal(Object.hasOwn(absent.contentTypes.book.rest.supports, "excerpt"), false);
  assert.notEqual(explicitFalse.profileFingerprint, absent.profileFingerprint);
  const omitted = compileRuntimeContentRegistry([]), next = createContentBootstrap(omitted);
  assert.notStrictEqual(next, bootstrap);
  assert.equal(runtimeContentType(next.snapshot, "book"), undefined);
  assert.equal(runtimeTaxonomy(next.snapshot, "genre"), undefined);
  assert.strictEqual(runtimeContentType(bootstrap.snapshot, "book"), first.contentTypes.book);
  assert.equal(Object.hasOwn(bootstrap, "register"), false); assert.equal(Object.hasOwn(bootstrap, "reset"), false);
  assert.doesNotThrow(() => assertBuiltinStorageBoundary(next));
  assert.throws(() => assertBuiltinStorageBoundary(bootstrap), { message: "Custom content storage is not enabled in this build." });
});
