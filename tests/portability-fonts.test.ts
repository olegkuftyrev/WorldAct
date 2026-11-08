import "dotenv/config";
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, writeFile, readdir } from "node:fs/promises";
import path from "node:path";
import { parse } from "@wordpress/block-serialization-default-parser";
import { remapImportedBlockReferences } from "../server/block-portability.js";
import { exportFontLibrary, MAX_ARCHIVE_MEDIA_BYTES } from "../server/site-portability.js";
import { bundledFontCollection } from "../server/fonts.js";
import { pool, rootDir, uploadsDir } from "../server/db.js";
after(async () => { await pool.end(); });

const block = (attrs: Record<string, unknown>, html: string) => `<!-- wp:paragraph ${JSON.stringify(attrs)} -->${html}<!-- /wp:paragraph -->`;
const node = (attributes: Record<string, unknown>) => ({ name: "core/paragraph", attributes, innerBlocks: [] });

test("font portability remaps canonical and JSON presets, safe aliases, and unavailable library IDs", () => {
  const attrs = { fontFamily: "worldact-font-7", className: "kept has-worldact-font-7-font-family", style: { typography: { fontFamily: "var:preset|font-family|worldact-font-7" }, elements: { link: { typography: { fontFamily: "var(--wp--preset--font-family--worldact-font-7)" } } } } };
  const value = remapImportedBlockReferences(block(attrs, '<p class="has-worldact-font-7-font-family" style="font-family:var(--wp--preset--font-family--worldact-font-7)">Fira Code is ordinary text</p>') + block({ fontFamily: "worldact-font-999" }, '<p class="has-worldact-font-999-font-family has-manrope-font-family" style="font-family:var(--wp--preset--font-family--worldact-font-999)">Missing</p>'), [node(attrs), node({ style: { typography: { fontFamily: "\"Fira Code\", serif" } } }), node({ fontFamily: "worldact-font-999" })], new Map(), { fontFamilies: new Map([["Fira Code", "Fira Code Imported abcdef123456"]]), fontSlugs: new Map([["worldact-font-7", "worldact-font-70"]]) });
  assert.equal(parse(value.rawContent)[0].attrs!.fontFamily, "worldact-font-70");
  assert.equal(value.blocks[0].attributes.fontFamily, "worldact-font-70");
  assert.equal((value.blocks[0].attributes.style as any).typography.fontFamily, "var:preset|font-family|worldact-font-70");
  assert.equal((value.blocks[0].attributes.style as any).elements.link.typography.fontFamily, "var(--wp--preset--font-family--worldact-font-70)");
  assert.equal((value.blocks[1].attributes.style as any).typography.fontFamily, '"Fira Code Imported abcdef123456", serif');
  assert.match(value.rawContent, /has-worldact-font-70-font-family/);
  assert.match(value.rawContent, /Fira Code is ordinary text/);
  assert.match(value.rawContent, /has-manrope-font-family/);
  assert.doesNotMatch(value.rawContent + JSON.stringify(value.blocks), /worldact-font-999/);
  assert.ok(value.warnings.some(item => item.includes("worldact-font-999")));
  const direct = remapImportedBlockReferences('<p style="font-family:&quot;Fira Code&quot;,serif">Safe</p>', null, new Map(), { fontFamilies: new Map([["Fira Code", "Fira Code Imported abcdef123456"]]) });
  assert.match(direct.rawContent, /Fira Code Imported abcdef123456/);
  assert.throws(() => remapImportedBlockReferences("", [], new Map(), { fontFamilies: new Map([["Fira Code", "Font; color:red"]]) }), /mapping/);
  assert.throws(() => remapImportedBlockReferences("", [], new Map(), { fontSlugs: new Map([["worldact-font-7", "bad\" onclick=bad"]]) }), /mapping/);
});

test("missing font families detach their styles without changing ordinary text or bundled presets", () => {
  const value = remapImportedBlockReferences('<p class="has-worldact-font-7-font-family" style="font-family:&quot;Fira Code&quot;,serif">Fira Code</p>', [node({ fontFamily: "worldact-font-7", style: { typography: { fontFamily: "Fira Code" } } })], new Map(), { fontFamilies: new Map([["Fira Code", null]]), fontSlugs: new Map([["worldact-font-7", null]]) });
  assert.equal(value.blocks[0].attributes.fontFamily, undefined);
  assert.equal((value.blocks[0].attributes.style as any).typography.fontFamily, "inherit");
  assert.doesNotMatch(value.rawContent, /has-worldact-font-7/);
  assert.match(value.rawContent, />Fira Code<\/p>/);
});

const stage = process.env.FONT_ARCHIVE_STAGE, archivePath = process.env.FONT_ARCHIVE_PATH;
const base = process.env.TEST_API_URL || "http://127.0.0.1:3001", origin = process.env.APP_ORIGIN || "http://127.0.0.1:5173";
const source = bundledFontCollection.find(item => item.key === "fira-code")!;
const bundled = bundledFontCollection.find(item => item.key === "beiruti")!;
const diskFiles = async () => {
  try { return (await readdir(path.join(uploadsDir, "fonts"))).sort(); } catch (error: any) { if (error.code === "ENOENT") return []; throw error; }
};

// These phases deliberately change theme font activations. Run them on two
// separate disposable databases, never on a developer's existing site.
test("font archive crosses fresh sites with verified bytes, collision mapping and atomic rollback", { skip: !stage || !archivePath }, async (t) => {
  let cookie = "";
  const owned = new Set<number>();
  const api = async (route: string, method = "GET", body?: unknown) => {
    const response = await fetch(base + "/api" + route, { method, headers: { Origin: origin, ...(cookie ? { Cookie: cookie } : {}), ...(body instanceof FormData ? {} : { "Content-Type": "application/json" }) }, ...(body === undefined ? {} : { body: body instanceof FormData ? body : JSON.stringify(body) }) });
    return { response, data: await response.json() };
  };
  const ok = async (route: string, method = "GET", body?: unknown) => {
    const result = await api(route, method, body);
    assert.ok(result.response.ok, `${route}: ${result.response.status} ${JSON.stringify(result.data)}`);
    for (const id of result.data.fontFamilyIds || []) owned.add(id);
    if (result.data.family) owned.add(result.data.family.id);
    return result.data;
  };
  const login = await api("/auth/login", "POST", { login: process.env.ADMIN_EMAIL, password: process.env.ADMIN_PASSWORD });
  assert.equal(login.response.status, 200); cookie = (login.response.headers.get("set-cookie") || "").split(";")[0];
  const upload = async () => { const bytes = await readFile(path.join(rootDir, "public", source.faces[0].url)); const form = new FormData(); form.append("file", new Blob([new Uint8Array(bytes)], { type: "font/woff2" }), "portable.woff2"); return (await ok("/fonts/upload", "POST", form)).family; };
  try {
    if (stage === "export") {
      const family = await upload(), installed = (await ok("/fonts/install", "POST", { collectionKey: bundled.key })).family;
      await ok(`/fonts/${family.id}/activation`, "PUT", { theme: "twentytwentyfive", active: true });
      await ok(`/fonts/${installed.id}/activation`, "PUT", { theme: "twentytwentyfour", active: true });
      await ok("/site-editor/styles", "PUT", { fontFamily: family.name, headingFont: family.name });
      const attrs = { fontFamily: `worldact-font-${family.id}`, style: { typography: { fontFamily: family.name } } };
      const raw = block(attrs, `<p class="has-worldact-font-${family.id}-font-family" style="font-family:&quot;${family.name}&quot;">Portable font paragraph</p>`);
      await ok("/site-editor/documents", "POST", { slug: "portable-font-template", title: "Portable font template", type: "template", content: "<!-- wp:post-content /-->" });
      const post = (await ok("/posts", "POST", { title: "Portable font post", status: "publish", templateSlug: "portable-font-template", content: raw, blocks: [node(attrs)] })).post;
      await ok("/site-editor/documents", "POST", { slug: "portable-font-pattern", title: "Portable font pattern", type: "pattern", content: raw, blocks: [node(attrs)] });
      const archive = await ok("/tools/export");
      assert.equal(archive.fontFamilies.length, 2); assert.equal(archive.fontFaces.length, 2); assert.equal(archive.fontFiles.length, 2);
      assert.equal(archive.themeFonts.length, 2);
      for (const file of archive.fontFiles) { const bytes = Buffer.from(file.data, "base64"); assert.equal(bytes.length, file.size); assert.equal(createHash("sha256").update(bytes).digest("hex"), file.sha256); assert.equal(file.mimeType, "font/woff2"); }
      assert.equal(archive.themeDesigns.find((item: any) => item.theme === "twentytwentyfive").styles.fontFamily, family.name);
      await assert.rejects(exportFontLibrary(pool, MAX_ARCHIVE_MEDIA_BYTES), /64 MiB|size limit/);
      await writeFile(archivePath!, JSON.stringify({ archive, familyId: family.id, familyName: family.name, bundledId: installed.id, postId: post.id }));
    } else {
      const fixture = JSON.parse(await readFile(archivePath!, "utf8")), archive = fixture.archive;
      const local = await upload();
      await ok(`/fonts/${local.id}/activation`, "PUT", { theme: "twentytwentyfive", active: true });
      await ok("/site-editor/styles", "PUT", { fontFamily: local.name, headingFont: local.name });
      await ok("/site-editor/documents", "POST", { slug: "portable-font-template", title: "Unrelated destination template", type: "template", content: "<p>Unrelated destination template</p>" });
      await ok("/site-editor/documents", "POST", { slug: "unrelated-local-template", title: "Unrelated missing template", type: "template", content: "<p>Unrelated local template</p>" });
      const before = await ok("/tools/export"), copy = await ok("/tools/import", "POST", archive);
      assert.equal(copy.restoredDesign, false); assert.equal(copy.fontFamilyIds.length, 2); assert.equal(copy.fontFaceIds.length, 2);
      assert.ok(copy.warnings.some((item: string) => item.includes("CSS family alias")));
      const after = await ok("/tools/export"), copiedFamily = after.fontFamilies.find((item: any) => copy.fontFamilyIds.includes(item.id) && item.source === "upload");
      assert.notEqual(copiedFamily.id, local.id); assert.notEqual(copiedFamily.name, fixture.familyName);
      assert.deepEqual(after.themeFonts, before.themeFonts);
      assert.deepEqual(after.themeDesigns, before.themeDesigns);
      const copiedPost = after.posts.find((item: any) => copy.postIds.includes(item.id) && item.title === "Portable font post");
      const copiedTemplate = after.documents.find((item: any) => copy.documentIds.includes(item.id) && item.title === "Portable font template");
      assert.notEqual(copiedTemplate.slug, "portable-font-template");
      assert.equal(copiedPost.template_slug, copiedTemplate.slug);
      assert.match(copiedPost.raw_content, new RegExp(`worldact-font-${copiedFamily.id}`));
      assert.equal(copiedPost.blocks[0].attributes.fontFamily, `worldact-font-${copiedFamily.id}`);
      assert.equal(copiedPost.blocks[0].attributes.style.typography.fontFamily, JSON.stringify(copiedFamily.name));
      assert.match(copiedPost.raw_content, new RegExp(copiedFamily.name));
      const copiedDoc = after.documents.find((item: any) => copy.documentIds.includes(item.id) && item.title === "Portable font pattern");
      assert.equal(copiedDoc.blocks[0].attributes.fontFamily, `worldact-font-${copiedFamily.id}`);
      for (const face of after.fontFaces.filter((item: any) => copy.fontFaceIds.includes(item.id))) {
        assert.match(face.filename, /^fonts\/[a-f0-9]{48}\.woff2$/);
        const response = await fetch(base + face.url); assert.equal(response.status, 200);
        assert.equal(createHash("sha256").update(Buffer.from(await response.arrayBuffer())).digest("hex"), face.sha256);
      }
      const replaced = await ok("/tools/import", "POST", { ...archive, replaceDesign: true });
      const active = await ok("/tools/export"), activeFamily = active.fontFamilies.find((item: any) => replaced.fontFamilyIds.includes(item.id) && item.source === "upload");
      assert.equal(active.posts.find((item: any) => replaced.postIds.includes(item.id) && item.title === "Portable font post").template_slug, "portable-font-template");
      assert.equal(active.themeDesigns.find((item: any) => item.theme === "twentytwentyfive").styles.fontFamily, activeFamily.name);
      assert.ok(active.themeFonts.some((item: any) => item.theme === "twentytwentyfive" && item.family_id === activeFamily.id));
      assert.ok(!active.themeFonts.some((item: any) => item.family_id === local.id));
      const uploadedFace = active.fontFaces.find((item: any) => item.family_id === activeFamily.id);
      assert.equal(uploadedFace.metadata.family, local.faces[0].metadata.family);

      await t.test("untrusted font metadata is ignored and failed later sections remove all new font files", async () => {
        const altered = structuredClone(archive); altered.fontFaces[0].metadata = { family: "Injected", license: "<script>bad()</script>" }; altered.fontFaces[0].style = "invalid-style"; altered.fontFaces[0].url = "/";
        const safe = await ok("/tools/import", "POST", altered), exported = await ok("/tools/export");
        const face = exported.fontFaces.find((item: any) => safe.fontFaceIds.includes(item.id));
        assert.notEqual(face.metadata.family, "Injected"); assert.notEqual(face.style, "invalid-style");
        assert.doesNotMatch(exported.posts.find((item: any) => safe.postIds.includes(item.id) && item.title === "Portable font post").raw_content, /uploads\/fonts.*uploads\/fonts/);
        const files = await diskFiles(), fontIds = exported.fontFamilies.map((item: any) => item.id);
        const result = await api("/tools/import", "POST", { ...archive, posts: [{ id: 1, type: "attachment", title: "Invalid post", slug: "invalid-post", content: "Invalid" }] });
        assert.equal(result.response.status, 400);
        assert.deepEqual(await diskFiles(), files);
        assert.deepEqual((await ok("/tools/export")).fontFamilies.map((item: any) => item.id), fontIds);
      });
      await t.test("missing files detach presets and active overrides instead of binding existing library IDs", async () => {
        const missing = structuredClone(archive); missing.fontFiles = []; missing.replaceDesign = true; missing.posts.find((item: any) => item.id === fixture.postId).template_slug = "unrelated-local-template";
        const result = await ok("/tools/import", "POST", missing); assert.deepEqual(result.fontFamilyIds, []);
        const exported = await ok("/tools/export"), post = exported.posts.find((item: any) => result.postIds.includes(item.id) && item.title === "Portable font post");
        assert.equal(post.template_slug, "");
        assert.ok(result.warnings.some((item: string) => item.includes("unrelated-local-template")));
        assert.doesNotMatch(post.raw_content + JSON.stringify(post.blocks), /worldact-font-\d+/);
        assert.ok(result.warnings.some((item: string) => item.includes("no embedded file")));
        assert.deepEqual(exported.themeFonts, []);
        assert.equal(exported.themeDesigns.find((item: any) => item.theme === "twentytwentyfive").styles.fontFamily, undefined);
      });
      await t.test("font path, format, checksum, signature and source validation reject atomically", async () => {
        const cases: Array<(input: any) => void> = [
          input => { input.fontFiles[0].filename = "../.env"; },
          input => { input.fontFiles[0].mimeType = "image/png"; },
          input => { input.fontFiles[0].sha256 = "0".repeat(64); },
          input => { input.fontFiles[0].size = 8 * 1024 * 1024 + 1; },
          input => { const file = input.fontFiles[0], bytes = Buffer.from("Not a font file"); Object.assign(file, { data: bytes.toString("base64"), size: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") }); },
          input => { input.fontFamilies.find((item: any) => item.source === "bundled").collection_key = "untrusted-remote-font"; },
        ];
        const before = await diskFiles();
        for (const mutate of cases) { const input = structuredClone(archive); mutate(input); const failed = await api("/tools/import", "POST", input); assert.equal(failed.response.status, 400, JSON.stringify(failed.data)); assert.deepEqual(await diskFiles(), before); }
      });
    }
  } finally {
    for (const id of owned) await api(`/fonts/${id}`, "DELETE");
    await api("/auth/logout", "POST", {});
  }
});
