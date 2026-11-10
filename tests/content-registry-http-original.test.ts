import test, { after } from "./isolated-test.js";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { writeFile } from "node:fs/promises";
import path from "node:path";

// GREEN equivalence control: no registry implementation or new registration API is assumed.
const baseline = "172ce9326962fedd84884cf85d20005f1260cefe";
const expectedBaselineNode = "582d1aa48ee69058e08be6406b86d604cf92010cf0e36a9e180e997b920da07b";
const requestContract = [
  {"key":"types-public","group":"metadata","method":"GET","path":"/wp-json/wp/v2/types","actor":"anonymous","expectedStatus":200},
  {"key":"taxonomies-public","group":"metadata","method":"GET","path":"/wp-json/wp/v2/taxonomies","actor":"anonymous","expectedStatus":200},
  {"key":"type-post","group":"metadata","method":"GET","path":"/wp-json/wp/v2/types/post","actor":"anonymous","expectedStatus":200},
  {"key":"type-page","group":"metadata","method":"GET","path":"/wp-json/wp/v2/types/page","actor":"anonymous","expectedStatus":200},
  {"key":"type-attachment","group":"metadata","method":"GET","path":"/wp-json/wp/v2/types/attachment","actor":"anonymous","expectedStatus":200},
  {"key":"taxonomy-category","group":"metadata","method":"GET","path":"/wp-json/wp/v2/taxonomies/category","actor":"anonymous","expectedStatus":200},
  {"key":"taxonomy-post_tag","group":"metadata","method":"GET","path":"/wp-json/wp/v2/taxonomies/post_tag","actor":"anonymous","expectedStatus":200},
  {"key":"types-admin","group":"metadata","method":"GET","path":"/wp-json/wp/v2/types","actor":"administrator","expectedStatus":200},
  {"key":"taxonomies-admin","group":"metadata","method":"GET","path":"/wp-json/wp/v2/taxonomies","actor":"administrator","expectedStatus":200},
  {"key":"anonymous-wp_block","group":"metadata","method":"GET","path":"/wp-json/wp/v2/types/wp_block","actor":"anonymous","expectedStatus":401},
  {"key":"anonymous-wp_navigation","group":"metadata","method":"GET","path":"/wp-json/wp/v2/types/wp_navigation","actor":"anonymous","expectedStatus":401},
  {"key":"anonymous-head-wp_block","group":"metadata","method":"HEAD","path":"/wp-json/wp/v2/types/wp_block","actor":"anonymous","expectedStatus":401},
  {"key":"anonymous-head-wp_navigation","group":"metadata","method":"HEAD","path":"/wp-json/wp/v2/types/wp_navigation","actor":"anonymous","expectedStatus":401},
  {"key":"admin-wp_block","group":"metadata","method":"GET","path":"/wp-json/wp/v2/types/wp_block","actor":"administrator","expectedStatus":200},
  {"key":"admin-wp_navigation","group":"metadata","method":"GET","path":"/wp-json/wp/v2/types/wp_navigation","actor":"administrator","expectedStatus":200},
  {"key":"contributor-wp_block","group":"metadata","method":"GET","path":"/wp-json/wp/v2/types/wp_block","actor":"contributor","expectedStatus":200},
  {"key":"contributor-wp_navigation","group":"metadata","method":"GET","path":"/wp-json/wp/v2/types/wp_navigation","actor":"contributor","expectedStatus":403},
  {"key":"subscriber-wp_block","group":"metadata","method":"GET","path":"/wp-json/wp/v2/types/wp_block","actor":"subscriber","expectedStatus":403},
  {"key":"subscriber-wp_navigation","group":"metadata","method":"GET","path":"/wp-json/wp/v2/types/wp_navigation","actor":"subscriber","expectedStatus":403},
  {"key":"unknown-type","group":"metadata","method":"GET","path":"/wp-json/wp/v2/types/book","actor":"anonymous","expectedStatus":404},
  {"key":"unknown-taxonomy","group":"metadata","method":"GET","path":"/wp-json/wp/v2/taxonomies/genre","actor":"anonymous","expectedStatus":404},
  {"key":"storage-tag-is-not-rest-taxonomy","group":"metadata","method":"GET","path":"/wp-json/wp/v2/taxonomies/tag","actor":"anonymous","expectedStatus":404},
  {"key":"types-head","group":"metadata","method":"HEAD","path":"/wp-json/wp/v2/types","actor":"anonymous","expectedStatus":200},
  {"key":"taxonomies-head","group":"metadata","method":"HEAD","path":"/wp-json/wp/v2/taxonomies","actor":"anonymous","expectedStatus":200},
  {"key":"create-category","group":"builtins","method":"POST","path":"/api/terms","actor":"administrator","expectedStatus":201},
  {"key":"create-tag","group":"builtins","method":"POST","path":"/api/terms","actor":"administrator","expectedStatus":201},
  {"key":"create-post","group":"builtins","method":"POST","path":"/api/posts","actor":"administrator","expectedStatus":201},
  {"key":"create-page","group":"builtins","method":"POST","path":"/api/posts","actor":"administrator","expectedStatus":201},
  {"key":"read-post","group":"builtins","method":"GET","path":"/api/posts/{postId}","actor":"administrator","expectedStatus":200},
  {"key":"read-page","group":"builtins","method":"GET","path":"/api/posts/{pageId}","actor":"administrator","expectedStatus":200},
  {"key":"read-category-rest","group":"builtins","method":"GET","path":"/wp-json/wp/v2/categories/{categoryId}","actor":"anonymous","expectedStatus":200},
  {"key":"read-tag-rest","group":"builtins","method":"GET","path":"/wp-json/wp/v2/tags/{tagId}","actor":"anonymous","expectedStatus":200},
  {"key":"list-category","group":"builtins","method":"GET","path":"/api/terms?taxonomy=category&search={stamp}&perPage=100","actor":"administrator","expectedStatus":200},
  {"key":"list-tag","group":"builtins","method":"GET","path":"/api/terms?taxonomy=tag&search={stamp}&perPage=100","actor":"administrator","expectedStatus":200},
  {"key":"reject-post-book","group":"builtins","method":"POST","path":"/api/posts","actor":"administrator","expectedStatus":400},
  {"key":"reject-post-attachment","group":"builtins","method":"POST","path":"/api/posts","actor":"administrator","expectedStatus":400},
  {"key":"reject-post-wp_block","group":"builtins","method":"POST","path":"/api/posts","actor":"administrator","expectedStatus":400},
  {"key":"reject-post-wp_navigation","group":"builtins","method":"POST","path":"/api/posts","actor":"administrator","expectedStatus":400},
  {"key":"reject-term-genre","group":"builtins","method":"POST","path":"/api/terms","actor":"administrator","expectedStatus":400},
  {"key":"reject-term-post_tag","group":"builtins","method":"POST","path":"/api/terms","actor":"administrator","expectedStatus":400},
  {"key":"reject-post-list","group":"builtins","method":"GET","path":"/api/posts?type=book","actor":"administrator","expectedStatus":400},
  {"key":"reject-public-terms","group":"builtins","method":"GET","path":"/api/public/terms?taxonomy=genre","actor":"anonymous","expectedStatus":400},
  {"key":"reject-templates","group":"builtins","method":"GET","path":"/api/posts/templates?type=book","actor":"administrator","expectedStatus":400},
  {"key":"reject-term-list","group":"builtins","method":"GET","path":"/api/terms?taxonomy=genre","actor":"administrator","expectedStatus":400},
  {"key":"invalid-import","group":"import","method":"POST","path":"/api/tools/import","actor":"administrator","expectedStatus":400},
  {"key":"invalid-import-terms","group":"import","method":"GET","path":"/api/terms?taxonomy=category&search={rollbackTerm}&perPage=100","actor":"administrator","expectedStatus":200},
  {"key":"invalid-import-posts","group":"import","method":"GET","path":"/api/posts?type=post&search={rollbackPost}&perPage=100","actor":"administrator","expectedStatus":200},
  {"key":"valid-import","group":"import","method":"POST","path":"/api/tools/import","actor":"administrator","expectedStatus":201},
  {"key":"valid-import-read","group":"import","method":"GET","path":"/api/posts/{importedId}","actor":"administrator","expectedStatus":200},
] as const;
type Actor = "anonymous" | "administrator" | "contributor" | "subscriber";
type Key = (typeof requestContract)[number]["key"];
type Reply = { status: number; text: string; data: any; error?: string };
type Observed = { key: Key; group: string; method: string; endpoint: string; actor: Actor; reply: Reply };
type Check = [string, () => void];
const base = process.env.TEST_API_URL!, origin = process.env.APP_ORIGIN!;
const stamp = "registry-" + Date.now().toString(36) + "-" + randomBytes(3).toString("hex");
const cookies: Record<Actor, string> = { anonymous: "", administrator: "", contributor: "", subscriber: "" };
const observed: Observed[] = [], replies = new Map<Key, Reply>();
const postIds = new Set<number>(), termIds = new Set<number>(), userIds = new Set<number>();
const setupErrors: string[] = [], cleanupFailures: string[] = [];
let aggregateStarted = false, proofWritten = false, cleaned = false;
const sha = (text: string) => createHash("sha256").update(text).digest("hex");
const positive = (value: unknown): value is number => typeof value === "number" && Number.isInteger(value) && value > 0;

async function call(endpoint: string, method = "GET", body?: unknown, cookie = ""): Promise<Reply> {
  try {
    const response = await fetch(base + endpoint, { method, redirect: "manual", signal: AbortSignal.timeout(15000),
      headers: { Origin: origin, "Content-Type": "application/json", ...(cookie ? { Cookie: cookie } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const text = await response.text(); let data: any = null, error: string | undefined;
    if (text) try { data = JSON.parse(text); } catch { error = "Control response was not JSON"; }
    return { status: response.status, text, data, ...(error ? { error } : {}) };
  } catch (error) { return { status: 0, text: "", data: null, error: String(error) }; }
}
function remember(data: any) {
  for (const row of [data?.post, ...(Array.isArray(data?.posts) ? data.posts : [])])
    if (positive(row?.id) && typeof row.title === "string" && row.title.startsWith(stamp)) postIds.add(row.id);
  for (const row of [data?.term, ...(Array.isArray(data?.terms) ? data.terms : [])])
    if (positive(row?.id) && typeof row.slug === "string" && row.slug.startsWith(stamp)) termIds.add(row.id);
  // Import response IDs belong to our submitted archive; cleanup rechecks actual ownership before any mutation.
  for (const id of Array.isArray(data?.postIds) ? data.postIds : []) if (positive(id)) postIds.add(id);
  for (const id of Array.isArray(data?.termIds) ? data.termIds : []) if (positive(id)) termIds.add(id);
}
async function observe(key: Key, endpoint?: string, body?: unknown) {
  const spec = requestContract.find(item => item.key === key)!;
  assert.equal(requestContract[observed.length]?.key, key, "Construction request order prerequisite");
  const target = endpoint ?? spec.path;
  assert.ok(!/[{}]/.test(target), "Resolve the actual supported control path before dispatch");
  const reply = await call(target, spec.method, body, cookies[spec.actor]);
  remember(reply.data); replies.set(key, reply);
  observed.push({ key, group: spec.group, method: spec.method, endpoint: target, actor: spec.actor, reply });
  console.log("CONTENT_REGISTRY_CONTROL " + JSON.stringify({ key, actor: spec.actor, method: spec.method, endpoint: target,
    status: reply.status, bytes: Buffer.byteLength(reply.text), sha256: sha(reply.text), error: reply.error }));
  return reply;
}
async function signIn(login: string, password: string) {
  // Authentication/setup responses and headers are never persisted in the control proof.
  const response = await fetch(base + "/api/auth/login", { method: "POST", signal: AbortSignal.timeout(15000),
    headers: { Origin: origin, "Content-Type": "application/json" }, body: JSON.stringify({ login, password }) });
  await response.text(); assert.equal(response.status, 200, "Sign-in setup prerequisite");
  const cookie = (response.headers.get("set-cookie") || "").split(";")[0];
  assert.ok(cookie.startsWith("worldact_session="), "Session setup prerequisite"); return cookie;
}
async function createRole(role: "contributor" | "subscriber") {
  const username = stamp + "-" + role, password = "Registry-" + randomBytes(24).toString("hex");
  const result = await call("/api/users", "POST", { username, email: username + "@example.test", displayName: "Registry " + role,
    password, role, sendNotification: false }, cookies.administrator);
  if (positive(result.data?.user?.id)) userIds.add(result.data.user.id);
  assert.equal(result.status, 201, "Role fixture setup prerequisite");
  assert.ok(positive(result.data?.user?.id), "Role fixture identity prerequisite");
  cookies[role] = await signIn(username, password);
}
function safeControl(data: any) {
  const post = (row: any) => row && ({ id: row.id, type: row.type, title: row.title, slug: row.slug, status: row.status,
    version: row.version, categoryIds: row.categoryIds, tagIds: row.tagIds });
  const term = (row: any) => row && ({ id: row.id, taxonomy: row.taxonomy, name: row.name, slug: row.slug, parentId: row.parentId });
  return { ...(typeof data?.error === "string" ? { error: data.error } : {}), ...(data?.post ? { post: post(data.post) } : {}),
    ...(data?.term ? { term: term(data.term) } : {}), ...(Array.isArray(data?.posts) ? { posts: data.posts.map(post) } : {}),
    ...(Array.isArray(data?.terms) ? { terms: data.terms.map(term) } : {}), ...(positive(data?.id) ? { id: data.id, taxonomy: data.taxonomy, name: data.name, slug: data.slug } : {}),
    ...(Array.isArray(data?.postIds) ? { postIds: data.postIds, termIds: data.termIds, imported: data.imported } : {}) };
}
async function writeProof() {
  if (proofWritten) return;
  const proofPath = process.env.CONTENT_REGISTRY_HTTP_PROOF_PATH;
  if (proofPath) {
    assert.ok(path.isAbsolute(proofPath), "Proof path must be absolute");
    const proof = { schemaVersion: 1, purpose: "BUILTIN_GREEN_EQUIVALENCE_CONTROL", baseline, expectedBaselineNode,
      dispatches: observed.length, declaredDispatches: requestContract.length, requestContract, setupErrors,
      metadataRawBodyScope: "Metadata routes only; no authentication/setup responses, headers, cookies or credentials.",
      observations: observed.map(({ reply, ...request }) => ({ ...request, status: reply.status, bytes: Buffer.byteLength(reply.text),
        sha256: sha(reply.text), ...(reply.error ? { error: reply.error } : {}), ...(request.group === "metadata"
          ? { text: reply.text, json: reply.data } : { safeControl: safeControl(reply.data) }) })),
      ownedFixtureIds: { posts: [...postIds], terms: [...termIds], users: [...userIds] },
      cleanup: "Normal owned API finally follows this immutable pre-assertion proof; no completed cleanup claim here." };
    await writeFile(proofPath, JSON.stringify(proof, null, 2) + "\n", { flag: "wx", mode: 0o600 });
  }
  proofWritten = true;
}
function verify(checks: Check[]) {
  const failures: string[] = [];
  for (const [label, check] of checks) try { check(); } catch (error) { failures.push(label + ": " + (error instanceof Error ? error.message : String(error))); }
  assert.equal(failures.length, 0, failures.join("\n"));
}
function common(group: string): Check[] {
  return requestContract.filter(item => item.group === group).flatMap(item => [
    [item.key + " consumed", () => assert.ok(replies.has(item.key))],
    [item.key + " transport/JSON", () => assert.equal(replies.get(item.key)?.error, undefined)],
    [item.key + " HTTP", () => assert.equal(replies.get(item.key)?.status, item.expectedStatus)],
    ...(item.method === "HEAD" ? [[item.key + " HEAD empty", () => assert.equal(replies.get(item.key)?.text, "")] as Check] : []),
  ] as Check[]);
}
function enumError(key: Key, field: string, values: string[]) {
  const data = replies.get(key)?.data;
  assert.deepEqual(Object.keys(data || {}), ["error"]);
  assert.equal(data.error, field + ': Invalid option: expected one of ' + values.map(value => JSON.stringify(value)).join("|"));
}
async function cleanup() {
  if (cleaned) return; cleaned = true;
  const note = (label: string, reply: Reply, expected: number) => { if (reply.status !== expected) cleanupFailures.push(label + " HTTP" + reply.status); };
  for (const id of [...postIds].reverse()) try {
    const found = await call("/api/posts/" + id, "GET", undefined, cookies.administrator); if (found.status === 404) continue;
    if (found.status !== 200 || !String(found.data?.post?.title || "").startsWith(stamp)) { cleanupFailures.push("Refused unowned post cleanup " + id); continue; }
    if (found.data.post.status !== "trash") {
      const trashed = await call("/api/posts/" + id, "PUT", { status: "trash", version: found.data.post.version }, cookies.administrator);
      note("Trash owned post " + id, trashed, 200); if (trashed.status !== 200) continue;
    }
    note("Delete owned post " + id, await call("/api/posts/" + id, "DELETE", undefined, cookies.administrator), 200);
  } catch { cleanupFailures.push("Owned post cleanup failed " + id); }
  for (const id of [...termIds].reverse()) try {
    const found = await call("/api/terms/" + id, "GET", undefined, cookies.administrator); if (found.status === 404) continue;
    if (found.status !== 200 || !String(found.data?.term?.slug || "").startsWith(stamp)) { cleanupFailures.push("Refused unowned term cleanup " + id); continue; }
    note("Delete owned term " + id, await call("/api/terms/" + id, "DELETE", undefined, cookies.administrator), 200);
  } catch { cleanupFailures.push("Owned term cleanup failed " + id); }
  for (const role of ["contributor", "subscriber"] as const) if (cookies[role]) await call("/api/auth/logout", "POST", undefined, cookies[role]);
  for (const id of userIds) try {
    const found = await call("/api/users/" + id, "GET", undefined, cookies.administrator); if (found.status === 404) continue;
    if (found.status !== 200 || !String(found.data?.user?.username || "").startsWith(stamp)) { cleanupFailures.push("Refused unowned account cleanup " + id); continue; }
    note("Delete owned account " + id, await call("/api/users/" + id + "?deleteContent=false", "DELETE", undefined, cookies.administrator), 200);
  } catch { cleanupFailures.push("Owned account cleanup failed " + id); }
  if (cookies.administrator) await call("/api/auth/logout", "POST", undefined, cookies.administrator);
  console.log("CONTENT_REGISTRY_CLEANUP " + JSON.stringify({ ownedPosts: postIds.size, ownedTerms: termIds.size, ownedUsers: userIds.size, failures: cleanupFailures }));
}
after(async () => { await cleanup(); assert.deepEqual(cleanupFailures, []); });

test("built-in content metadata, closed validators and import controls retain current projections and authority", { timeout: 120000 }, async t => {
  try {
    cookies.administrator = await signIn(process.env.ADMIN_EMAIL!, process.env.ADMIN_PASSWORD!);
    await createRole("contributor"); await createRole("subscriber");
    for (const item of requestContract.filter(item => item.group === "metadata")) await observe(item.key);

    const category = await observe("create-category", undefined, { taxonomy: "category", name: stamp + " category", slug: stamp + "-category" });
    assert.equal(category.status, 201, "Category fixture prerequisite"); assert.ok(positive(category.data?.term?.id), "Category ID prerequisite");
    const tag = await observe("create-tag", undefined, { taxonomy: "tag", name: stamp + " tag", slug: stamp + "-tag" });
    assert.equal(tag.status, 201, "Tag fixture prerequisite"); assert.ok(positive(tag.data?.term?.id), "Tag ID prerequisite");
    const post = await observe("create-post", undefined, { type: "post", title: stamp + " post", content: "<p>Registry builtin post control.</p>", status: "draft", categoryIds: [category.data.term.id], tagIds: [tag.data.term.id] });
    assert.equal(post.status, 201, "Post fixture prerequisite"); assert.ok(positive(post.data?.post?.id), "Post ID prerequisite");
    const page = await observe("create-page", undefined, { type: "page", title: stamp + " page", content: "<p>Registry builtin page control.</p>", status: "draft" });
    assert.equal(page.status, 201, "Page fixture prerequisite"); assert.ok(positive(page.data?.post?.id), "Page ID prerequisite");
    await observe("read-post", "/api/posts/" + post.data.post.id); await observe("read-page", "/api/posts/" + page.data.post.id);
    await observe("read-category-rest", "/wp-json/wp/v2/categories/" + category.data.term.id); await observe("read-tag-rest", "/wp-json/wp/v2/tags/" + tag.data.term.id);
    await observe("list-category", "/api/terms?" + new URLSearchParams({ taxonomy: "category", search: stamp, perPage: "100" }));
    await observe("list-tag", "/api/terms?" + new URLSearchParams({ taxonomy: "tag", search: stamp, perPage: "100" }));
    for (const type of ["book", "attachment", "wp_block", "wp_navigation"] as const)
      await observe(("reject-post-" + type) as Key, undefined, { type, title: stamp + " rejected " + type, status: "draft" });
    for (const taxonomy of ["genre", "post_tag"] as const)
      await observe(("reject-term-" + taxonomy) as Key, undefined, { taxonomy, name: stamp + " rejected " + taxonomy, slug: stamp + "-rejected-" + taxonomy });
    await observe("reject-post-list"); await observe("reject-public-terms"); await observe("reject-templates"); await observe("reject-term-list");

    const rollbackTerm = stamp + "-rollback-term", rollbackPost = stamp + " rollback post";
    await observe("invalid-import", undefined, { application: "WorldAct", version: 2,
      terms: [{ id: 1900000001, taxonomy: "category", name: rollbackTerm, slug: rollbackTerm }],
      posts: [{ id: 1900000002, type: "post", title: rollbackPost, slug: stamp + "-rollback-post", content: "<p>Must roll back.</p>", status: "draft" },
        { id: 1900000003, type: "book", title: stamp + " unsupported imported book", slug: stamp + "-bad-book", content: "", status: "draft" }] });
    await observe("invalid-import-terms", "/api/terms?" + new URLSearchParams({ taxonomy: "category", search: rollbackTerm, perPage: "100" }));
    await observe("invalid-import-posts", "/api/posts?" + new URLSearchParams({ type: "post", search: rollbackPost, perPage: "100" }));
    const imported = await observe("valid-import", undefined, { application: "WorldAct", version: 2,
      posts: [{ id: 1900000004, type: "page", title: stamp + " imported page", slug: stamp + "-imported-page", content: "<p>Registry import control.</p>", status: "draft" }] });
    assert.equal(imported.status, 201, "Valid import fixture prerequisite");
    const importedId = imported.data?.postIds?.[0]; assert.ok(positive(importedId), "Valid imported ID prerequisite");
    await observe("valid-import-read", "/api/posts/" + importedId);
    await writeProof(); aggregateStarted = true;

    await t.test("public metadata and protected narrow adapter details retain distinct status, shape and visibility", () => {
      const types = replies.get("types-public")?.data, taxonomies = replies.get("taxonomies-public")?.data;
      const narrow = (name: "wp_block" | "wp_navigation") => ({ slug: name, name: name === "wp_block" ? "Patterns" : "Navigation",
        rest_base: name === "wp_block" ? "blocks" : "navigation", rest_namespace: "wp/v2", supports: { title: true, editor: true }, viewable: false, taxonomies: [], hierarchical: false });
      const checks: Check[] = [...common("metadata"), ["all declared controls consumed before policy assertions", () => assert.equal(observed.length, 49)],
        ["current public type key order", () => assert.deepEqual(Object.keys(types || {}), ["post", "page", "attachment", "wp_block", "wp_navigation"])],
        ["current public taxonomy key order", () => assert.deepEqual(Object.keys(taxonomies || {}), ["category", "post_tag"])],
        ["admin types match public collection", () => assert.deepEqual(replies.get("types-admin")?.data, types)],
        ["admin taxonomies match public collection", () => assert.deepEqual(replies.get("taxonomies-admin")?.data, taxonomies)],
        ["post label and formats", () => { assert.equal(types.post.labels.singular_name, "Post"); assert.equal(types.post.supports["post-formats"], true); }],
        ["page hierarchy/attributes", () => { assert.equal(types.page.hierarchical, true); assert.equal(types.page.supports["page-attributes"], true); }],
        ["attachment supports stays absent", () => assert.equal(Object.hasOwn(types.attachment, "supports"), false)],
        ["collection reusable support stays present", () => assert.equal(types.wp_block.supports.reusable, true)],
        ["collection navigation false support stays present", () => assert.equal(types.wp_navigation.supports.inserter, false)],
        ["category visibility and tag alias", () => { assert.equal(taxonomies.category.visibility.publicly_queryable, true); assert.equal(taxonomies.post_tag.rest_base, "tags"); assert.equal(taxonomies.post_tag.labels.singular_name, "Tag"); }]];
      for (const name of ["post", "page", "attachment"] as const) checks.push([name + " detail equals collection member", () => { assert.deepEqual(replies.get(("type-" + name) as Key)?.data, types[name]); assert.deepEqual(Object.keys(replies.get(("type-" + name) as Key)?.data || {}), Object.keys(types[name])); }]);
      for (const name of ["category", "post_tag"] as const) checks.push([name + " detail equals collection member", () => { assert.deepEqual(replies.get(("taxonomy-" + name) as Key)?.data, taxonomies[name]); assert.deepEqual(Object.keys(replies.get(("taxonomy-" + name) as Key)?.data || {}), Object.keys(taxonomies[name])); }]);
      for (const name of ["wp_block", "wp_navigation"] as const) {
        checks.push([name + " anonymous sign-in error", () => assert.deepEqual(replies.get(("anonymous-" + name) as Key)?.data, { error: "Please log in to continue." })],
          [name + " admin exact narrow projection", () => { const value = replies.get(("admin-" + name) as Key)?.data; assert.deepEqual(value, narrow(name)); assert.deepEqual(Object.keys(value || {}), Object.keys(narrow(name))); }],
          [name + " subscriber role error", () => assert.deepEqual(replies.get(("subscriber-" + name) as Key)?.data, { error: "You do not have permission to perform this action." })]);
      }
      checks.push(["contributor block uses narrow reader projection", () => assert.deepEqual(replies.get("contributor-wp_block")?.data, narrow("wp_block"))],
        ["contributor navigation remains restricted", () => assert.deepEqual(replies.get("contributor-wp_navigation")?.data, { error: "You do not have permission to perform this action." })]);
      verify(checks);
    });
    await t.test("built-in control writes and readbacks retain exact internal versus REST keys and reject all unregistered storage keys", () => {
      const checks: Check[] = [...common("builtins"),
        ["post readback", () => { const value = replies.get("read-post")?.data.post; assert.equal(value.id, post.data.post.id); assert.equal(value.type, "post"); assert.equal(value.status, "draft"); assert.deepEqual(value.categoryIds, [category.data.term.id]); assert.deepEqual(value.tagIds, [tag.data.term.id]); }],
        ["page readback", () => { const value = replies.get("read-page")?.data.post; assert.equal(value.id, page.data.post.id); assert.equal(value.type, "page"); assert.equal(value.status, "draft"); }],
        ["category REST identity", () => { const value = replies.get("read-category-rest")?.data; assert.equal(value.id, category.data.term.id); assert.equal(value.taxonomy, "category"); }],
        ["tag REST identity", () => { const value = replies.get("read-tag-rest")?.data; assert.equal(value.id, tag.data.term.id); assert.equal(value.taxonomy, "post_tag"); }],
        ["internal category list", () => assert.deepEqual(replies.get("list-category")?.data.terms.map((row: any) => [row.id, row.taxonomy]), [[category.data.term.id, "category"]])],
        ["internal tag list", () => assert.deepEqual(replies.get("list-tag")?.data.terms.map((row: any) => [row.id, row.taxonomy]), [[tag.data.term.id, "tag"]])]];
      for (const key of ["reject-post-book", "reject-post-attachment", "reject-post-wp_block", "reject-post-wp_navigation", "reject-post-list"] as const) checks.push([key + " exact enum error", () => enumError(key, "type", ["post", "page"])]);
      for (const key of ["reject-term-genre", "reject-term-post_tag", "reject-term-list"] as const) checks.push([key + " exact enum error", () => enumError(key, "taxonomy", ["category", "tag"])]);
      // These two endpoints parse the scalar itself, so the existing error path is Request, not an object field.
      checks.push(["template scalar exact enum error", () => enumError("reject-templates", "Request", ["post", "page"])],
        ["public terms scalar exact enum error", () => enumError("reject-public-terms", "Request", ["category", "tag"])]);
      verify(checks);
    });
    await t.test("invalid unregistered import rolls back preceding builtin records while an ordinary builtin import still allocates readable content", () => verify([
      ...common("import"), ["unsupported imported type uses same enum", () => enumError("invalid-import", "type", ["post", "page"])],
      ["preceding imported term rolled back", () => assert.deepEqual(replies.get("invalid-import-terms")?.data.terms, [])],
      ["preceding imported post rolled back", () => assert.deepEqual(replies.get("invalid-import-posts")?.data.posts, [])],
      ["valid import creates one builtin row", () => { assert.equal(imported.data.imported, 1); assert.equal(imported.data.postIds.length, 1); }],
      ["valid imported page readback", () => { const value = replies.get("valid-import-read")?.data.post; assert.equal(value.id, importedId); assert.equal(value.type, "page"); assert.equal(value.status, "draft"); assert.equal(value.title, stamp + " imported page"); }],
    ]));
  } catch (error) {
    if (!aggregateStarted) setupErrors.push(error instanceof Error ? error.message : String(error));
    throw error;
  } finally { await writeProof(); await cleanup(); }
});
