import test from "./isolated-test.js";
import "dotenv/config";
import assert from "node:assert/strict";
import { writeFile, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import {createHash} from "node:crypto";
import {uploadsDir,pool} from "../server/db.js";
import {after} from "./isolated-test.js";
after(()=>pool.end());

const stage = process.env.SITE_ARCHIVE_STAGE;
const archivePath = process.env.SITE_ARCHIVE_PATH;
const base = process.env.TEST_API_URL || "http://127.0.0.1:3001";
const origin = process.env.APP_ORIGIN || "http://127.0.0.1:5173";
const block = (name: string, attributes: Record<string, unknown> = {}, body = "") => body
  ? `<!-- wp:${name} ${JSON.stringify(attributes)} -->${body}<!-- /wp:${name} -->`
  : `<!-- wp:${name} ${JSON.stringify(attributes)} /-->`;
const files = async () => (await readdir(uploadsDir, { recursive: true, withFileTypes: true })).filter(item => item.isFile()).map(item => path.join(item.parentPath, item.name)).sort();

// The two phases deliberately change a site's active design. Run only against
// disposable databases: export on one fresh API, restore on another fresh API.
test("complete site archive crosses fresh databases with media, design and settings integrity", { skip: !stage || !archivePath }, async () => {
  let cookie = "";
  const request = async (url: string, method = "GET", body?: unknown) => {
    const response = await fetch(base + url, { method, headers: { Origin: origin, "Content-Type": "application/json", Cookie: cookie }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { response, data: await response.json() };
  };
  const ok = async (url: string, method = "GET", body?: unknown) => {
    const result = await request(url, method, body);
    assert.ok(result.response.ok, `${url}: ${result.response.status} ${JSON.stringify(result.data)}`);
    return result.data;
  };
  const signed = await request("/api/auth/login", "POST", { login: process.env.ADMIN_EMAIL, password: process.env.ADMIN_PASSWORD });
  assert.equal(signed.response.status, 200);
  cookie = (signed.response.headers.get("set-cookie") || "").split(";")[0];
  const ownedMedia: number[] = [];
  try {
    if (stage === "export") {
      const stamp = "archive-" + Date.now().toString(36);
      await ok("/api/settings", "PUT", { siteTitle: "Portable source site", siteUrl: "https://archive-source.example.invalid", permalinkStructure: "/journal/%category%/%postname%/" });
      const png = await sharp({ create: { width: 12, height: 8, channels: 3, background: "#aa3344" } }).png().toBuffer();
      const form = new FormData(); form.append("file", new Blob([new Uint8Array(png)], { type: "image/png" }), "portable-image.png");
      const upload = await fetch(base + "/api/media", { method: "POST", headers: { Origin: origin, Cookie: cookie }, body: form });
      assert.equal(upload.status, 201);
      const image = (await upload.json()).media; ownedMedia.push(image.id);
      const edited = (await ok(`/api/media/${image.id}/edit`, "POST", { rotate: 90 })).media;
      const category = (await ok("/api/terms", "POST", { taxonomy: "category", name: stamp + " Category", slug: stamp + "-category" })).term;
      const childCategory = (await ok("/api/terms", "POST", { taxonomy: "category", name: stamp + " Child Category", slug: stamp + "-child-category", parentId: category.id })).term;
      const reusable = await ok("/wp-json/wp/v2/blocks", "POST", { title: stamp + " Reusable", status: "publish", content: block("paragraph", {}, "<p>Portable reusable payload</p>") });
      const nested = await ok("/wp-json/wp/v2/blocks", "POST", { title: stamp + " Nested", status: "publish", content: block("block", { ref: reusable.id }) });
      const nav = await ok("/wp-json/wp/v2/navigation", "POST", { title: stamp + " Navigation", status: "publish", content: block("navigation-link", { label: "Portable navigation payload", url: "/" }) });
      const part = (await ok("/api/site-editor/documents", "POST", { title: stamp + " Part", slug: stamp + "-part", type: "template-part", area: "navigation-overlay", content: block("group", {}, "<section>" + block("block", { ref: nested.id }) + "</section>") })).document;
      await ok("/api/site-editor/documents", "POST", { title: stamp + " Template", slug: stamp + "-template", type: "template", content: block("template-part", { slug: part.slug }) + block("post-content") });
      const background = { backgroundImage: { url: edited.url }, backgroundSize: "contain" };
      const raw = block("template-part", { slug: part.slug }) + block("navigation", { ref: nav.id }) + block("image", { id: image.id }, `<figure class="wp-block-image"><img class="wp-image-${image.id}" src="https://archive-source.example.invalid${edited.url}" alt="Portable image" /></figure>`) + block("group", { style: { background } }, `<div class="wp-block-group" style="padding:20px;background-image:url(&quot;${edited.url}&quot;);background-size:contain"><p>Portable background image</p></div>`);
      const post = (await ok("/api/posts", "POST", { title: stamp + " Main Post", status: "publish", content: raw, featuredMediaId: image.id, categoryIds: [childCategory.id], blocks: [{ name: "core/template-part", attributes: { slug: part.slug }, innerBlocks: [] }, { name: "core/image", attributes: { id: image.id, url: edited.url }, innerBlocks: [] }, { name: "core/group", attributes: { style: { background } }, innerBlocks: [] }] })).post;
      await ok(`/api/media/${image.id}`,"PUT",{attachedPostId:post.id,description:"<p>Portable attachment description</p>",commentStatus:"open"});
      const expanded = (await ok("/api/posts", "POST", { title: stamp + " Expanded text", status: "draft", content: "&".repeat(210000) })).post;
      assert.ok(expanded.content.length > 1_000_000);
      const pages = [];
      for (const label of ["Home", "Posts", "Privacy"]) pages.push((await ok("/api/posts", "POST", { type: "page", title: stamp + " " + label, status: "publish", content: `<p>Portable ${label} page</p>` })).post);
      const pageChild = (await ok("/api/posts", "POST", { type: "page", title: stamp + " Child", status: "publish", parentId: pages[0].id, content: "<p>Portable child page</p>" })).post;
      const parentComment = (await ok("/api/comments", "POST", { postId: post.id, authorName: "Portable reader", authorEmail: "reader@example.invalid", authorUrl: "https://reader.example.invalid", content: "<p>Portable parent comment</p>" })).comment;
      await ok("/api/comments", "POST", { postId: post.id, parentId: parentComment.id, content: "<p>Portable child comment</p>", status: "pending" });
      await ok("/api/menus", "POST", { name: stamp + " Legacy menu", location: "primary", items: [{ id: "home", label: "Portable main link", url: "https://archive-source.example.invalid" + post.permalink }, { id: "child", label: "Portable child link", url: pageChild.permalink, parentId: "home" }] });
      await ok("/api/settings", "PUT", { frontPageMode: "page", frontPageId: pages[0].id, postsPageId: pages[1].id, privacyPageId: pages[2].id, defaultCategoryId: childCategory.id, siteLogoId: image.id, siteIconId: image.id });
      await ok("/api/site-editor/styles", "PUT", { accentColor: "#aa3344", spacing: 33 });
      await ok("/api/plugins/custom-footer/install", "POST", {});
      await ok("/api/plugins/custom-footer", "PUT", { enabled: true, settings: { text: "Portable custom footer" } });
      const archive = await ok("/api/tools/export");
      assert.equal(archive.version, 3); assert.ok(archive.mediaFiles.length >= 5); assert.equal(archive.settings.adminEmail, undefined);
      assert.ok(archive.mediaFiles.every((item: any) => item.data && /^[a-f0-9]{64}$/.test(item.sha256)));
      assert.equal(archive.extensions.find((item: any) => item.slug === "custom-footer")?.settings.text, "Portable custom footer");
      assert.equal(archive.posts.find((item: any) => item.id === post.id).featured_media_id, image.id);
      await writeFile(archivePath!, JSON.stringify({ archive, stamp, postId: post.id, mediaId: image.id, partSlug: part.slug, homeId: pages[0].id, childPageId: pageChild.id, defaultCategoryId: childCategory.id }));
    } else {
      const fixture = JSON.parse(await readFile(archivePath!, "utf8")), archive = fixture.archive;
      const baseline = (await ok("/api/settings")).settings;
      const originalHeader = (await ok("/api/site-editor")).parts.find((item: any) => item.slug === "header");
      const copied = await ok("/api/tools/import", "POST", archive); ownedMedia.push(...copied.mediaIds);
      assert.equal(copied.restoredDesign, false);
      assert.equal((await ok("/api/settings")).settings.siteTitle, baseline.siteTitle);
      assert.ok(copied.warnings.some((message: string) => message.includes("retained")));
      assert.equal((await ok("/api/site-editor")).parts.find((item: any) => item.id === originalHeader.id).content, originalHeader.content);
      const modified = structuredClone(archive); modified.replaceDesign = true; modified.settings.adminEmail = "untrusted-contact@example.invalid";
      const restored = await ok("/api/tools/import", "POST", modified); ownedMedia.push(...restored.mediaIds);
      assert.equal(restored.restoredDesign, true);
      const exported = await ok("/api/tools/export");
      const post = exported.posts.find((item: any) => restored.postIds.includes(item.id) && item.title === fixture.stamp + " Main Post");
      const expanded = exported.posts.find((item: any) => restored.postIds.includes(item.id) && item.title === fixture.stamp + " Expanded text");
      assert.equal(expanded.content, archive.posts.find((item: any) => item.title === expanded.title).content);
      const media = exported.media.find((item: any) => item.id === post.featured_media_id);
      assert.ok(restored.mediaIds.includes(media.id)); assert.notEqual(media.filename, archive.media.find((item: any) => item.id === fixture.mediaId).filename);
      assert.ok(media.original_filename); assert.ok(Object.keys(media.derivatives).length); assert.ok(media.sizes.thumbnail);
      assert.equal(media.attached_post_id,post.id);assert.equal(media.description,"<p>Portable attachment description</p>");assert.equal(media.comment_status,"open");
      const settings = (await ok("/api/settings")).settings;
      assert.equal(settings.siteTitle, "Portable source site"); assert.equal(settings.siteUrl, baseline.siteUrl); assert.equal(settings.adminEmail, baseline.adminEmail);
      assert.equal(settings.siteLogoId, media.id); assert.equal(settings.siteIconId, media.id);
      const home = exported.posts.find((item: any) => item.id === settings.frontPageId); assert.equal(home.title, fixture.stamp + " Home");
      assert.equal(exported.posts.find((item: any) => restored.postIds.includes(item.id) && item.title === fixture.stamp + " Child").parent_id, home.id);
      assert.equal(exported.terms.find((item: any) => item.id === settings.defaultCategoryId).name, fixture.stamp + " Child Category");
      const restoredPart = (await ok("/api/site-editor")).parts.find((item: any) => item.title === fixture.stamp + " Part" && restored.documentIds.includes(item.id));
      assert.equal(restoredPart.area, "navigation-overlay");
      const background = post.blocks.find((item: any) => item.name === "core/group").attributes.style.background;
      assert.equal(background.backgroundImage.url, "/uploads/" + media.filename);
      assert.ok(post.raw_content.includes(`background-image:url(&quot;/uploads/${media.filename}&quot;)`));
      const comments = (await ok(`/api/comments?postId=${post.id}`)).comments; assert.equal(comments.length, 2); assert.ok(comments.some((item: any) => item.parentId));
      const rendered = (await ok(`/api/public/posts/${post.slug}`)).post.content;
      assert.match(rendered, /Portable reusable payload/); assert.match(rendered, /Portable navigation payload/); assert.doesNotMatch(rendered, /archive-source\.example\.invalid/);
      assert.match(rendered, new RegExp(`wp-image-${media.id}`));
      assert.ok(rendered.includes(`background-image:url(&quot;/uploads/${media.filename}&quot;)`));
      const imageResponse = await fetch(base + "/uploads/" + media.filename); assert.equal(imageResponse.status, 200); assert.match(imageResponse.headers.get("content-type") || "", /image\/png/);
      const sourceMedia=archive.media.find((item:any)=>item.id===fixture.mediaId);
      for(const [oldName,newName] of [[sourceMedia.filename,media.filename],[sourceMedia.original_filename,media.original_filename],...Object.keys(sourceMedia.sizes).map(key=>[sourceMedia.sizes[key].filename,media.sizes[key].filename])]){
        const response=await fetch(base+"/uploads/"+newName);assert.equal(response.status,200);
        assert.equal(createHash("sha256").update(Buffer.from(await response.arrayBuffer())).digest("hex"),archive.mediaFiles.find((item:any)=>item.filename===oldName).sha256);
      }
      const menu = exported.menus.find((item: any) => restored.menuIds.includes(item.id)); assert.equal(menu.location, "primary"); assert.doesNotMatch(menu.items[0].url, /archive-source\.example\.invalid/);
      assert.equal(exported.extensions.find((item: any) => item.slug === "custom-footer").settings.text, "Portable custom footer");
      const themedStyle = exported.themeDesigns.find((item: any) => item.theme === settings.theme)?.styles;
      assert.equal(themedStyle?.accentColor || exported.styles.accentColor, "#aa3344");

      const before = await files(), beforeMedia = exported.media.length;
      const invalid = { ...archive, replaceDesign: true, posts: [{ id: 1, type: "attachment", title: "Must fail", slug: "must-fail", content: "invalid" }] };
      assert.equal((await request("/api/tools/import", "POST", invalid)).response.status, 400);
      assert.deepEqual(await files(), before, "Rollback must remove staged uploaded files.");
      assert.equal((await ok("/api/tools/export")).media.length, beforeMedia);
      for (const mutate of [
        (value: any) => value.mediaFiles[0].filename = "../.env",
        (value: any) => value.mediaFiles[0].sha256 = "0".repeat(64),
        (value: any) => value.mediaFiles[0].mimeType = "application/pdf",
        (value: any) => value.styles.accentColor = "url(javascript:bad())",
        (value: any) => value.settings.defaultRole = "superadmin",
        (value: any) => value.menus[0].items = [{ id: "a", label: "Loop", url: "/", parentId: "a" }],
      ]) { const value = structuredClone(archive); mutate(value); assert.equal((await request("/api/tools/import", "POST", value)).response.status, 400); }
      assert.deepEqual(await files(), before);
    }
  } finally {
    for (const id of ownedMedia) await request(`/api/media/${id}`, "DELETE");
    await request("/api/auth/logout", "POST", {});
  }
});
