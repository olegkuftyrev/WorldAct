import test, { after } from "./isolated-test.js";
import "dotenv/config";
import assert from "node:assert/strict";
import { DOMParser } from "linkedom";
import { pool, postMetadataFields } from "../server/db.js";
import { renderSiteDocument } from "../server/block-renderer.js";
import { postPermalink } from "../server/permalinks.js";

const block = (name: string, attributes: Record<string, unknown> = {}) => `<!-- wp:${name} ${JSON.stringify(attributes)} /-->`;
const dom = (html: string) => new DOMParser().parseFromString("<!doctype html><html><body>" + html + "</body></html>", "text/html");
after(async () => { await pool.end(); });

test("published protected metadata remains discoverable while private records and protected bodies stay hidden", async t => {
  const base = process.env.TEST_API_URL || "http://127.0.0.1:3001", stamp = "protected-meta-" + Date.now().toString(36);
  const ids: number[] = [], terms: number[] = []; let userId: number | undefined;
  try {
    userId = (await pool.query("INSERT INTO users(username,email,display_name,password_hash,role) VALUES($1,$2,$3,'inert-fixture-hash','author') RETURNING id", [stamp, stamp + "@example.test", "Protected-only public author"])).rows[0].id;
    const create = async (label: string, type: string, status: string, password: boolean, date = "2000-01-02T00:00:00Z") => {
      const row = (await pool.query("INSERT INTO posts(type,title,slug,status,password_hash,author_id,published_at,content,raw_content,excerpt,footnotes) VALUES($1,$2,$3,$4,$5,$6,$7,'<p>SECRET-METADATA-BODY</p>','<p>SECRET-METADATA-RAW</p>','SECRET-METADATA-EXCERPT',$8::jsonb) RETURNING id,type,title,slug,status,parent_id AS \"parentId\",published_at AS \"publishedAt\",created_at AS \"createdAt\"", [type, label, stamp + "-" + ids.length, status, password ? "inert-post-password" : null, userId, date, JSON.stringify([{ id: "secret-note", content: "SECRET-METADATA-NOTE" }])])).rows[0]; ids.push(row.id); return row;
    };
    const protectedPage = await create("Protected public page", "page", "publish", true);
    const protectedPost = await create("Protected public post", "post", "publish", true);
    const privatePage = await create("Private hidden page", "page", "private", false);
    const draftPost = await create("Draft hidden post", "post", "draft", false);
    const admin = (await pool.query("SELECT id FROM users WHERE role='administrator' LIMIT 1")).rows[0].id;
    const current = (await pool.query("INSERT INTO posts(type,title,slug,status,author_id,published_at) VALUES('post','Current public post',$1,'publish',$2,'2000-01-01T00:00:00Z') RETURNING id,type,title,slug,status,published_at AS \"publishedAt\"", [stamp + "-current", admin])).rows[0]; ids.push(current.id);
    const category = (await pool.query("INSERT INTO terms(taxonomy,name,slug) VALUES('category','Protected-only category',$1) RETURNING id", [stamp])).rows[0]; terms.push(category.id);
    await pool.query("INSERT INTO post_terms(post_id,term_id) VALUES($1,$2)", [protectedPost.id, category.id]);
    await pool.query("INSERT INTO comments(post_id,author_name,author_email,content,status) VALUES($1,'Reader','reader@example.test','SECRET-METADATA-COMMENT','approved')", [protectedPost.id]);
    const protectedURL = await postPermalink(protectedPost), protectedPageURL = await postPermalink(protectedPage);
    await t.test("page lists and bound navigation keep published protected links with source labels", async () => {
      const output = await renderSiteDocument({ rawContent: block("page-list") + block("navigation-link", { id: protectedPost.id, kind: "post-type", type: "post", label: "Bound protected link" }) });
      const document = dom(output), page = [...document.querySelectorAll("a")].find(link => link.getAttribute("href") === protectedPageURL)!;
      assert.ok(page); assert.equal(page.textContent, protectedPage.title);
      assert.ok([...document.querySelectorAll("a")].some(link => link.getAttribute("href") === protectedURL && link.textContent === "Bound protected link"));
      assert.doesNotMatch(output, /SECRET-METADATA|Private hidden page|Draft hidden post|inert-post-password/);
    });
    await t.test("category counts, author archives and adjacent links include protected published objects", async () => {
      const categories = dom(await renderSiteDocument({ rawContent: block("categories", { showPostCounts: true }) }));
      const categoryRow = categories.querySelector(".cat-item-" + category.id)!; assert.ok(categoryRow); assert.match(categoryRow.textContent!, /Protected-only category \(1\)/);
      const title = await renderSiteDocument({ rawContent: block("query-title", { type: "archive", showPrefix: false }) }, { query: { author: String(userId) } });
      assert.match(title, /Protected-only public author/);
      const adjacent = dom(await renderSiteDocument({ rawContent: block("post-navigation-link", { type: "next", showTitle: true }) }, { post: current }));
      assert.equal(adjacent.querySelector("a")!.getAttribute("href"), protectedURL); assert.equal(adjacent.querySelector("a")!.textContent, protectedPost.title);
      assert.doesNotMatch(categories.body.textContent! + title + adjacent.body.textContent!, /SECRET-METADATA|Private hidden|Draft hidden/);
    });
    await t.test("public author selectors and sitemap expose metadata while direct bodies and comment feeds remain locked", async () => {
      const response = await fetch(base + `/wp-json/wp/v2/users?include=${userId}&has_published_posts=post`); assert.equal(response.status, 200);
      const authors = await response.json(); assert.equal(authors.length, 1); assert.equal(authors[0].id, userId); assert.equal(authors[0].name, "Protected-only public author");
      assert.doesNotMatch(JSON.stringify(authors), /password|@example\.test|SECRET-METADATA/);
      const sitemap = await (await fetch(base + "/sitemap.xml")).text(); assert.ok(sitemap.includes(protectedURL)); assert.ok(sitemap.includes(protectedPageURL));
      assert.ok(!sitemap.includes(await postPermalink(privatePage))); assert.ok(!sitemap.includes(await postPermalink(draftPost))); assert.doesNotMatch(sitemap, /SECRET-METADATA|inert-post-password/);
      const locked = await (await fetch(base + "/api/public/posts/" + protectedPost.slug)).json(); assert.equal(locked.post.locked, true); assert.equal(locked.post.content, ""); assert.deepEqual(locked.post.footnotes, []);
      assert.doesNotMatch(await (await fetch(base + "/comments/feed/")).text(), /SECRET-METADATA/);
    });
    await t.test("metadata-only links retain the canonical category permalink for protected and ordinary posts", async () => {
      const originalSettings = (await pool.query("SELECT data FROM settings WHERE id=1")).rows[0].data;
      try {
        await pool.query("UPDATE settings SET data=jsonb_set(data,'{permalinkStructure}',$1::jsonb) WHERE id=1", [JSON.stringify("/%category%/%postname%/")]);
        const first = (await pool.query("INSERT INTO terms(taxonomy,name,slug) VALUES('category','AAA first canonical category',$1) RETURNING id,slug", [stamp + "-first"])).rows[0]; terms.push(first.id);
        await pool.query("INSERT INTO post_terms(post_id,term_id) VALUES($1,$2),($3,$4)", [protectedPost.id, first.id, current.id, category.id]);
        const expectedProtected = `/${first.slug}/${protectedPost.slug}/`, expectedOrdinary = `/${stamp}/${current.slug}/`;
        const rows = (await pool.query(`SELECT ${postMetadataFields} FROM posts p WHERE p.id=ANY($1::int[])`, [[protectedPost.id, current.id]])).rows;
        for (const row of rows) {
          assert.equal(row.categories.length, 1); assert.deepEqual(Object.keys(row.categories[0]), ["slug"]);
          assert.equal(await postPermalink(row), row.id === protectedPost.id ? expectedProtected : expectedOrdinary);
          for (const key of ["content", "rawContent", "excerpt", "footnotes", "password_hash", "_passwordHash"]) assert.equal(row[key], undefined);
        }
        const navigation = dom(await renderSiteDocument({ rawContent: block("navigation-link", { id: protectedPost.id, kind: "post-type", type: "post", label: "Protected category link" }) + block("navigation-link", { id: current.id, kind: "post-type", type: "post", label: "Ordinary category link" }) }));
        assert.deepEqual([...navigation.querySelectorAll("a")].map(link => link.getAttribute("href")), [expectedProtected, expectedOrdinary]);
        const adjacent = dom(await renderSiteDocument({ rawContent: block("post-navigation-link", { type: "next", showTitle: true }) }, { post: current }));
        assert.equal(adjacent.querySelector("a")!.getAttribute("href"), expectedProtected);
        const sitemap = await (await fetch(base + "/sitemap.xml")).text(); assert.ok(sitemap.includes(expectedProtected)); assert.ok(sitemap.includes(expectedOrdinary));
        assert.ok(!sitemap.includes(`/uncategorized/${protectedPost.slug}/`)); assert.ok(!sitemap.includes(`/uncategorized/${current.slug}/`));
        assert.doesNotMatch(sitemap + navigation.body.innerHTML + adjacent.body.innerHTML, /SECRET-METADATA|inert-post-password/);
      } finally { await pool.query("UPDATE settings SET data=$1::jsonb WHERE id=1", [JSON.stringify(originalSettings)]); }
    });
  } finally {
    await pool.query("DELETE FROM posts WHERE id=ANY($1::int[])", [ids]);
    await pool.query("DELETE FROM terms WHERE id=ANY($1::int[])", [terms]);
    if (userId) await pool.query("DELETE FROM users WHERE id=$1", [userId]);
  }
});
