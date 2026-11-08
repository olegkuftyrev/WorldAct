import "dotenv/config";
import assert from "node:assert/strict";
import test from "node:test";
import { parse } from "@wordpress/block-serialization-default-parser";
import { remapImportedBlockReferences } from "../server/block-portability.js";

const block = (name: string, attributes: Record<string, unknown> = {}, content = "") =>
  content
    ? `<!-- wp:${name} ${JSON.stringify(attributes)} -->${content}<!-- /wp:${name} -->`
    : `<!-- wp:${name} ${JSON.stringify(attributes)} /-->`;
const node = (name: string, attributes: Record<string, unknown> = {}, innerBlocks: unknown[] = []) =>
  ({ name: `core/${name}`, attributes, innerBlocks });
const references = (raw: string): number[] => {
  const visit = (nodes: ReturnType<typeof parse>): number[] => nodes.flatMap(item => [
    ...(item.blockName && ["core/block", "core/navigation"].includes(item.blockName) && item.attrs?.ref ? [Number(item.attrs.ref)] : []),
    ...visit(item.innerBlocks),
  ]);
  return visit(parse(raw));
};

test("block import remaps canonical and JSON references without binding missing local IDs", () => {
  const result = remapImportedBlockReferences(
    block("group", {}, '<section class="kept">' + block("block", { ref: 7 }) + '</section>') +
      block("navigation", { ref: 8 }) + block("block", { ref: 8 }) +
      block("block", { ref: 0 }) + block("navigation", {}, block("navigation-link", { label: "Inline", url: "/inline" })),
    [node("group", {}, [node("block", { ref: 7 })]), node("navigation", { ref: 8 }), node("block", { ref: 999 })],
    new Map([[7, { id: 70, kind: "reusable" }], [8, { id: 80, kind: "navigation" }]]),
  );
  assert.deepEqual(references(result.rawContent), [70, 80]);
  assert.equal(result.blocks[0].innerBlocks[0].attributes.ref, 70);
  assert.equal(result.blocks[1].attributes.ref, 80);
  assert.equal(result.blocks.length, 2);
  assert.match(result.rawContent, /<section class="kept">/);
  assert.match(result.rawContent, /Inline/);
  assert.ok(result.warnings.some(warning => warning.includes("999")));
  assert.ok(result.warnings.some(warning => warning.includes("valid ID")));
  const legacy = remapImportedBlockReferences('<p onclick="bad()">Legacy</p>' + block("block", { ref: 7 }), null, new Map());
  assert.equal(legacy.content, "<p>Legacy</p>");
  assert.deepEqual(legacy.blocks, []);
});

test("copied design references retain their source theme across a different active theme", () => {
  const result = remapImportedBlockReferences(
    block("template-part", { slug: "header" }) + block("pattern", { slug: "twentytwentythree/banner" }),
    [node("template-part", { slug: "header" }), node("pattern", { slug: "banner" })],
    new Map(),
    { documentTheme: "twentytwentythree", documents: new Map([
      ["twentytwentythree:template-part:header", "header-copy"],
      ["twentytwentythree:pattern:banner", "banner-copy"],
    ]) },
  );
  const parsed = parse(result.rawContent);
  assert.deepEqual(parsed[0].attrs, { slug: "header-copy", theme: "twentytwentythree" });
  assert.equal(parsed[1].attrs!.slug, "twentytwentythree/banner-copy");
  assert.deepEqual(result.blocks[0].attributes, parsed[0].attrs);
  assert.equal(result.blocks[1].attributes.slug, "twentytwentythree/banner-copy");
  assert.deepEqual(result.warnings, []);
});

const base = process.env.TEST_API_URL || "http://127.0.0.1:3001";
const origin = process.env.APP_ORIGIN || "http://127.0.0.1:5173";
async function api(path: string, method = "GET", body?: unknown, cookie = "") {
  const response = await fetch(base + path, {
    method,
    headers: { Origin: origin, "Content-Type": "application/json", ...(cookie ? { Cookie: cookie } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { response, data: await response.json() };
}

test("JSON tools port nested block entities through ID collisions, sanitization and transactional failure", async () => {
  const stamp = `port-${Date.now().toString(36)}`;
  const login = await api("/api/auth/login", "POST", { login: process.env.ADMIN_EMAIL, password: process.env.ADMIN_PASSWORD });
  assert.equal(login.response.status, 200);
  const admin = (login.response.headers.get("set-cookie") || "").split(";")[0];
  const entities = new Map<number, "blocks" | "navigation">();
  const posts: number[] = [];
  const remember = (result: { data: any }) => {
    for (const id of result.data.postIds || []) posts.push(id);
    for (const id of result.data.blockEntityIds || []) entities.set(id, "blocks");
  };
  try {
    const collisions: number[] = [];
    for (const [route, title] of [["blocks", "UNRELATED REUSABLE"], ["navigation", "UNRELATED NAVIGATION"], ["blocks", "UNRELATED OMITTED"]] as const) {
      const created = await api(`/wp-json/wp/v2/${route}`, "POST", {
        title: `${stamp} ${title}`, content: block("paragraph", {}, `<p>${title}</p>`), status: "publish",
      }, admin);
      assert.equal(created.response.status, 201, JSON.stringify(created.data));
      collisions.push(created.data.id);
      entities.set(created.data.id, route);
    }
    const [parentId, navigationId, missingId] = collisions;
    const childId = 2147000001, draftId = 2147000002;
    const imported = await api("/api/tools/import", "POST", {
      application: "WorldAct", version: 2,
      blockEntities: [
        { id: parentId, kind: "reusable", title: `${stamp} Parent`, slug: `${stamp}-parent`, status: "publish", content: "", raw_content: block("group", {}, '<div class="imported-parent">' + block("block", { ref: childId }) + '</div>'), blocks: [node("group", {}, [node("block", { ref: childId })])] },
        { id: navigationId, kind: "navigation", title: `${stamp} Navigation`, status: "publish", content: "", raw_content: block("navigation-link", { label: "Imported safe menu", url: "/safe" }), blocks: [node("navigation-link", { label: "Imported safe menu", url: "/safe" })] },
        { id: childId, kind: "reusable", title: `${stamp} Child`, status: "publish", content: "", raw_content: block("paragraph", {}, '<p onclick="bad()">Imported nested child<script>bad()</script></p>'), blocks: [node("paragraph", { content: '<strong onclick="bad()">Safe JSON text</strong><script>bad()</script>' })] },
        { id: draftId, kind: "reusable", title: `${stamp} Draft`, status: "draft", content: "<p>Draft pattern retained</p>" },
      ],
      posts: [{ id: 1, type: "post", title: `${stamp} imported`, slug: `${stamp}-imported`, status: "publish", content: "", raw_content: '<p onclick="bad()">Imported post</p>' + block("block", { ref: parentId }) + block("navigation", { ref: navigationId }) + block("block", { ref: missingId }) + block("block", { ref: navigationId }), blocks: [node("block", { ref: parentId }), node("navigation", { ref: navigationId }), node("block", { ref: missingId }), node("block", { ref: navigationId })] }],
    }, admin);
    remember(imported);
    assert.equal(imported.response.status, 201, JSON.stringify(imported.data));
    assert.equal(imported.data.blockEntityIds.length, 4);
    assert.ok(imported.data.warnings.some((warning: string) => warning.includes(String(missingId))));
    const exported = (await api("/api/tools/export", "GET", undefined, admin)).data;
    assert.ok(Array.isArray(exported.blockEntities));
    const importedEntities = exported.blockEntities.filter((item: any) => imported.data.blockEntityIds.includes(item.id));
    const parent = importedEntities.find((item: any) => item.title === `${stamp} Parent`);
    const child = importedEntities.find((item: any) => item.title === `${stamp} Child`);
    const navigation = importedEntities.find((item: any) => item.title === `${stamp} Navigation`);
    const draft = importedEntities.find((item: any) => item.title === `${stamp} Draft`);
    entities.set(navigation.id, "navigation");
    assert.notEqual(parent.id, parentId);
    assert.notEqual(navigation.id, navigationId);
    assert.equal(parent.author_id, login.data.user.id);
    assert.equal(draft.status, "draft");
    assert.match(parent.slug, /-import-/);
    assert.deepEqual(references(parent.raw_content), [child.id]);
    assert.equal(parent.blocks[0].innerBlocks[0].attributes.ref, child.id);
    assert.doesNotMatch(child.raw_content + JSON.stringify(child.blocks), /onclick|<script/);
    const post = (await api(`/api/posts/${posts[0]}`, "GET", undefined, admin)).data.post;
    assert.deepEqual(references(post.rawContent), [parent.id, navigation.id]);
    assert.deepEqual(post.blocks.map((item: any) => item.attributes.ref), [parent.id, navigation.id]);
    assert.doesNotMatch(post.rawContent, /onclick/);
    const rendered = (await api(`/api/public/posts/${post.slug}`)).data.post.content;
    assert.match(rendered, /Imported nested child/);
    assert.match(rendered, /Imported safe menu/);
    assert.doesNotMatch(rendered, /UNRELATED|onclick|<script|Draft pattern retained/);

    const rollbackTitle = `${stamp} Rollback entity`;
    const failed = await api("/api/tools/import", "POST", {
      application: "WorldAct", version: 2,
      blockEntities: [{ id: 1, kind: "reusable", title: rollbackTitle, status: "publish", content: "<p>Must roll back</p>" }],
      posts: [{ id: 1, type: "attachment", title: `${stamp} Invalid`, slug: `${stamp}-invalid`, content: "Invalid post type" }],
    }, admin);
    assert.equal(failed.response.status, 400);
    const afterFailure = (await api("/api/tools/export", "GET", undefined, admin)).data;
    assert.equal(afterFailure.blockEntities.some((item: any) => item.title === rollbackTitle), false);
    const invalidStatus = await api("/api/tools/import", "POST", {
      application: "WorldAct", version: 2, posts: [],
      blockEntities: [{ id: 1, kind: "reusable", title: rollbackTitle, status: "private", content: "Invalid entity status" }],
    }, admin);
    assert.equal(invalidStatus.response.status, 400);

    const legacy = await api("/api/tools/import", "POST", {
      application: "WorldAct", version: 1,
      posts: [{ id: 1, type: "post", title: `${stamp} Legacy`, slug: `${stamp}-legacy`, content: '<p>Legacy body remains</p>' + block("block", { ref: parentId }), blocks: null }],
    }, admin);
    remember(legacy);
    assert.equal(legacy.response.status, 201, JSON.stringify(legacy.data));
    assert.deepEqual(legacy.data.blockEntityIds, []);
    const legacyPost = (await api(`/api/posts/${legacy.data.postIds[0]}`, "GET", undefined, admin)).data.post;
    assert.equal(legacyPost.content, "<p>Legacy body remains</p>");
    assert.deepEqual(references(legacyPost.rawContent), []);
  } finally {
    for (const post of posts) {
      await api(`/api/posts/${post}`, "PUT", { status: "trash" }, admin);
      await api(`/api/posts/${post}`, "DELETE", undefined, admin);
    }
    for (const [id, route] of entities) {
      const removed = await api(`/wp-json/wp/v2/${route}/${id}?force=true`, "DELETE", undefined, admin);
      if (removed.response.status === 404)
        await api(`/wp-json/wp/v2/${route === "blocks" ? "navigation" : "blocks"}/${id}?force=true`, "DELETE", undefined, admin);
    }
    await api("/api/auth/logout", "POST", {}, admin);
  }
});
