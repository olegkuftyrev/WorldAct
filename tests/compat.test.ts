import assert from "node:assert/strict";
import { test } from "node:test";
import { XMLParser, XMLValidator } from "fast-xml-parser";
import sharp from "sharp";
import { pool } from "../server/db.js";
import { cleanContent, cleanRawContent } from "../server/utils.js";
const base = process.env.TEST_API_URL || "http://127.0.0.1:3001",
  origin = process.env.APP_ORIGIN || "http://127.0.0.1:5173";
test("Gutenberg CSS and canonical comments remain safe and round-trip", () => {
  const styled = cleanContent(
    '<div style="background:linear-gradient(90deg,#f00 0%,rgb(0,0,255) 100%);padding:var(--wp--preset--spacing--20) var(--wp--preset--spacing--40);font-size:var(--wp--preset--font-size--large);box-shadow:0 2px 4px #000;object-position:50% 30%">Safe</div>',
  );
  assert.match(styled, /linear-gradient/);
  assert.match(
    styled,
    /padding:var\(--wp--preset--spacing--20\) var\(--wp--preset--spacing--40\)/,
  );
  assert.match(styled, /font-size:var/);
  assert.match(styled, /box-shadow/);
  assert.match(styled, /object-position/);
  const unsafe = cleanContent(
    '<div style="background:url(javascript:alert(1));box-shadow:expression(alert(1));background-image:url(//evil.test/x)" onclick="alert(1)">Safe<script>bad()</script></div>',
  );
  assert.doesNotMatch(unsafe, /url|expression|onclick|script|evil/);
  const raw = cleanRawContent(
    '<!-- wp:group {"style":{"spacing":{"padding":"20px"}}} --><div><!-- wp:paragraph --><p onclick="x()">Safe</p><!-- /wp:paragraph --></div><!-- /wp:group -->',
  );
  assert.match(raw, /<!-- wp:group/);
  assert.match(raw, /<!-- wp:paragraph -->/);
  assert.doesNotMatch(raw, /onclick/);
  assert.equal(cleanContent(raw), "<div><p>Safe</p></div>");
  assert.throws(
    () => cleanRawContent("<!-- wp:paragraph --><p>Unclosed</p>"),
    /balanced/,
  );
  assert.throws(
    () => cleanRawContent('<!-- wp:image {"url":"javascript:alert(1)"} /-->'),
    /safe/,
  );
});
test("portable WXR, feeds, sitemap, permalink resolver and WordPress REST workflows", async (t) => {
  const stamp = "compat-" + Date.now();
  let cookie = "";
  const posts: number[] = [],
    terms: number[] = [],
    media: number[] = [];
  let previousPattern: string | undefined;
  async function request(
    path: string,
    method = "GET",
    body?: unknown,
    c = cookie,
    foreignOrigin?: string,
  ) {
    const response = await fetch(base + path, {
      method,
      headers: {
        Origin: foreignOrigin || origin,
        "Content-Type": "application/json",
        ...(c ? { Cookie: c } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const raw = await response.text();
    let data: any;
    try {
      data = JSON.parse(raw);
    } catch {
      data = raw;
    }
    return { response, data, raw };
  }
  async function ok(path: string, method = "GET", body?: unknown, c = cookie) {
    const result = await request(path, method, body, c);
    assert.ok(
      result.response.ok,
      `${method} ${path}: ${result.response.status} ${result.raw}`,
    );
    return result;
  }
  try {
    const login = await ok(
      "/api/auth/login",
      "POST",
      { login: process.env.ADMIN_EMAIL, password: process.env.ADMIN_PASSWORD },
      "",
    );
    cookie = login.response.headers.get("set-cookie")!.split(";")[0];
    await t.test(
      "native Gutenberg markers are retained for authenticated editing and omitted publicly",
      async () => {
        const created = await ok("/api/posts", "POST", {
          title: stamp,
          slug: stamp,
          status: "publish",
          content:
            '<!-- wp:paragraph {"align":"center"} --><p class="has-text-align-center">Canonical content</p><!-- /wp:paragraph -->',
        });
        posts.push(created.data.post.id);
        assert.match(created.data.post.rawContent, /<!-- wp:paragraph/);
        assert.doesNotMatch(created.data.post.content, /<!--/);
        const pub = await ok(
          "/api/public/posts/" + stamp,
          "GET",
          undefined,
          "",
        );
        assert.equal(pub.data.post.rawContent, undefined);
        assert.equal(pub.data.post.blocks, undefined);
        assert.match(pub.data.post.permalink, new RegExp(stamp));
        await ok("/api/posts/" + posts[0] + "/autosave", "PUT", {
          content:
            "<!-- wp:paragraph --><p>Autosave markers</p><!-- /wp:paragraph -->",
        });
        assert.match(
          (await ok("/api/posts/" + posts[0] + "/autosave")).data.autosave
            .rawContent,
          /<!-- wp:paragraph/,
        );
      },
    );
    await t.test(
      "configurable date/id permalinks and hierarchical pages resolve without changing data",
      async () => {
        previousPattern = (await ok("/api/settings")).data.settings
          .permalinkStructure;
        await ok("/api/settings", "PUT", {
          permalinkStructure: "/%year%/%monthnum%/%day%/%post_id%/%postname%/",
        });
        const p = (await ok("/api/posts/" + posts[0])).data.post;
        assert.match(p.permalink, new RegExp("/" + p.id + "/" + stamp + "/$"));
        assert.equal(
          (
            await request(
              "/api/public/resolve?path=" +
                encodeURIComponent(
                  p.permalink.replace(
                    "/" + p.id + "/",
                    "/999999999999999999999999/",
                  ),
                ),
            )
          ).response.status,
          404,
        );
        assert.equal(
          (
            await ok(
              "/api/public/resolve?path=" + encodeURIComponent(p.permalink),
            )
          ).data.post.id,
          p.id,
        );
        const parent = (
          await ok("/api/posts", "POST", {
            type: "page",
            title: stamp + " parent",
            status: "publish",
          })
        ).data.post;
        posts.push(parent.id);
        const child = (
          await ok("/api/posts", "POST", {
            type: "page",
            title: stamp + " child",
            status: "publish",
            parentId: parent.id,
          })
        ).data.post;
        posts.push(child.id);
        assert.equal(
          child.permalink,
          "/" + parent.slug + "/" + child.slug + "/",
        );
        assert.equal(
          (
            await ok(
              "/api/public/resolve?path=" + encodeURIComponent(child.permalink),
            )
          ).data.post.id,
          child.id,
        );
        await ok("/api/settings", "PUT", {
          permalinkStructure: previousPattern,
        });
        previousPattern = undefined;
      },
    );
    await t.test(
      "RSS, Atom, sitemap and robots are actual escaped documents without protected content",
      async () => {
        const secret = (
          await ok("/api/posts", "POST", {
            title: stamp + " protected",
            content: "A very protected body " + stamp,
            password: "Secret-" + stamp,
            status: "publish",
          })
        ).data.post;
        posts.push(secret.id);
        const protectedRest = await ok(
          "/wp-json/wp/v2/posts/" + secret.id,
          "GET",
          undefined,
          "",
        );
        assert.equal(protectedRest.data.content.protected, true);
        assert.equal(protectedRest.data.content.rendered, "");
        assert.equal(protectedRest.data.content.raw, undefined);
        for (const path of [
          "/feed/",
          "/feed/atom/",
          "/comments/feed/",
          "/sitemap.xml",
        ]) {
          const result = await ok(path, "GET", undefined, "");
          assert.equal(XMLValidator.validate(result.raw), true, path);
          assert.doesNotMatch(
            result.raw,
            new RegExp("A very protected body " + stamp),
          );
          assert.doesNotMatch(result.raw, /scrypt:|password_hash/);
        }
        assert.match(
          (await ok("/feed/", "GET", undefined, "")).raw,
          new RegExp(stamp),
        );
        assert.match(
          (await ok("/robots.txt", "GET", undefined, "")).raw,
          /User-agent: \*/,
        );
      },
    );
    await t.test(
      "WordPress REST shapes, pagination, field selection and permissions are real",
      async () => {
        const result = await ok(
          "/wp-json/wp/v2/posts?slug=" + stamp + "&per_page=1",
          "GET",
          undefined,
          "",
        );
        assert.equal(result.response.headers.get("x-wp-total"), "1");
        assert.equal(result.data[0].id, posts[0]);
        assert.equal(typeof result.data[0].title.rendered, "string");
        assert.equal(result.data[0].content.raw, undefined);
        const fields = await ok(
          "/wp-json/wp/v2/posts?slug=" + stamp + "&_fields=id,slug",
          "GET",
          undefined,
          "",
        );
        assert.deepEqual(Object.keys(fields.data[0]).sort(), ["id", "slug"]);
        assert.match(
          (await ok("/wp-json/wp/v2/posts/" + posts[0] + "?context=edit")).data
            .content.raw,
          /<!-- wp:paragraph/,
        );
        assert.equal(
          (
            await request(
              "/wp-json/wp/v2/posts/" + posts[0] + "?context=edit",
              "GET",
              undefined,
              "",
            )
          ).response.status,
          401,
        );
        assert.equal(
          (
            await request(
              "/wp-json/wp/v2/posts",
              "POST",
              { title: "Forbidden" },
              "",
            )
          ).response.status,
          401,
        );
        assert.equal(
          (
            await request(
              "/wp-json/wp/v2/posts",
              "POST",
              { title: "Foreign" },
              cookie,
              "https://foreign.invalid",
            )
          ).response.status,
          403,
        );
        const created = (
          await ok("/wp-json/wp/v2/posts", "POST", {
            title: { raw: stamp + " REST" },
            content: {
              raw: '<p onclick="x()">REST body</p><script>bad()</script>',
            },
            status: "draft",
          })
        ).data;
        posts.push(created.id);
        assert.equal(created.status, "draft");
        assert.doesNotMatch(created.content.rendered, /onclick|script/);
        assert.equal(
          (
            await request(
              "/wp-json/wp/v2/posts/" + created.id,
              "GET",
              undefined,
              "",
            )
          ).response.status,
          401,
        );
        await ok("/wp-json/wp/v2/posts/" + created.id, "POST", {
          title: stamp + " changed",
          status: "publish",
        });
        assert.equal(
          (await ok("/wp-json/wp/v2/posts/" + created.id, "GET", undefined, ""))
            .data.title.rendered,
          stamp + " changed",
        );
        const removed = await ok(
          "/wp-json/wp/v2/posts/" + created.id + "?force=true",
          "DELETE",
        );
        assert.equal(removed.data.deleted, true);
        posts.splice(posts.indexOf(created.id), 1);
        const term = (
          await ok("/wp-json/wp/v2/tags", "POST", { name: stamp + " tag" })
        ).data;
        terms.push(term.id);
        assert.equal(term.taxonomy, "post_tag");
        assert.ok(
          (await ok("/wp-json/wp/v2/types", "GET", undefined, "")).data.post,
        );
        assert.ok(
          (await ok("/wp-json/wp/v2/taxonomies", "GET", undefined, "")).data
            .category,
        );
        assert.ok(
          (await ok("/wp-json/wp/v2/statuses", "GET", undefined, "")).data
            .publish,
        );
        assert.ok(
          (
            await ok(
              "/wp-json/wp/v2/search?search=" + stamp,
              "GET",
              undefined,
              "",
            )
          ).data.some((x: any) => x.id === posts[0]),
        );
        const comment = (
          await ok("/wp-json/wp/v2/comments", "POST", {
            post: posts[0],
            author_name: "Compat tester",
            author_email: "compat@example.com",
            content: "Compat comment",
          })
        ).data;
        assert.equal(comment.status, "hold");
        await ok("/wp-json/wp/v2/comments/" + comment.id, "POST", {
          status: "approve",
        });
        const comments = await ok(
          "/wp-json/wp/v2/comments?post=" + posts[0],
          "GET",
          undefined,
          "",
        );
        assert.ok(comments.data.some((c: any) => c.id === comment.id));
        assert.equal(comments.data[0].author_email, undefined);
      },
    );
    await t.test(
      "WordPress media upload forwards the binary stream with ownership checks",
      async () => {
        const form = new FormData();
        const image = await sharp({
          create: { width: 4, height: 3, channels: 4, background: "#3858e9" },
        })
          .png()
          .toBuffer();
        form.append(
          "file",
          new Blob([new Uint8Array(image)], { type: "image/png" }),
          stamp + ".png",
        );
        const response = await fetch(base + "/wp-json/wp/v2/media", {
          method: "POST",
          headers: { Origin: origin, Cookie: cookie },
          body: form,
        });
        const item = await response.json();
        assert.equal(response.status, 201, JSON.stringify(item));
        media.push(item.id);
        assert.equal(item.mime_type, "image/png");
        assert.match(item.source_url, /\/uploads\//);
        const updated = await ok("/wp-json/wp/v2/media/" + item.id, "POST", {
          title: stamp + " media",
          alt_text: "Accessible attachment",
        });
        assert.equal(updated.data.alt_text, "Accessible attachment");
        assert.equal(
          (
            await request(
              "/wp-json/wp/v2/media/" + item.id,
              "DELETE",
              undefined,
              "",
            )
          ).response.status,
          401,
        );
        await ok("/wp-json/wp/v2/media/" + item.id + "?force=true", "DELETE");
        media.splice(media.indexOf(item.id), 1);
      },
    );
    await t.test(
      "WXR import persists posts, terms, hierarchy, threaded comments, safe HTML and canonical Gutenberg",
      async () => {
        const xml = `<?xml version="1.0"?><rss version="2.0" xmlns:wp="http://wordpress.org/export/1.2/" xmlns:content="http://purl.org/rss/1.0/modules/content/" xmlns:excerpt="http://wordpress.org/export/1.2/excerpt/"><channel><title>Import fixture</title><wp:wxr_version>1.2</wp:wxr_version><wp:category><wp:term_id>101</wp:term_id><wp:category_nicename>${stamp}-parent</wp:category_nicename><wp:cat_name>${stamp} parent</wp:cat_name></wp:category><wp:category><wp:term_id>102</wp:term_id><wp:category_nicename>${stamp}-child</wp:category_nicename><wp:category_parent>${stamp}-parent</wp:category_parent><wp:cat_name>${stamp} child</wp:cat_name></wp:category><wp:tag><wp:term_id>103</wp:term_id><wp:tag_slug>${stamp}-wxr-tag</wp:tag_slug><wp:tag_name>WXR tag</wp:tag_name></wp:tag><item><title>${stamp} WXR</title><wp:post_id>501</wp:post_id><wp:post_type>post</wp:post_type><wp:post_name>${stamp}-wxr</wp:post_name><wp:status>draft</wp:status><content:encoded><![CDATA[<!-- wp:paragraph --><p onclick="x()">Imported safe body</p><!-- /wp:paragraph --><script>bad()</script>]]></content:encoded><excerpt:encoded>Imported excerpt</excerpt:encoded><category domain="post_format" nicename="post-format-aside">Aside</category><category domain="category" nicename="${stamp}-child">Child</category><category domain="post_tag" nicename="${stamp}-wxr-tag">WXR tag</category><wp:comment><wp:comment_id>601</wp:comment_id><wp:comment_author>Parent</wp:comment_author><wp:comment_author_email>parent@example.com</wp:comment_author_email><wp:comment_content>Parent comment</wp:comment_content><wp:comment_approved>1</wp:comment_approved></wp:comment><wp:comment><wp:comment_id>602</wp:comment_id><wp:comment_parent>601</wp:comment_parent><wp:comment_author>Reply</wp:comment_author><wp:comment_content>Reply body</wp:comment_content><wp:comment_approved>0</wp:comment_approved></wp:comment></item><item><title>${stamp} parent page</title><wp:post_id>502</wp:post_id><wp:post_type>page</wp:post_type><wp:post_name>${stamp}-parent-page</wp:post_name><wp:status>draft</wp:status><content:encoded>Parent page</content:encoded></item><item><title>${stamp} child page</title><wp:post_id>503</wp:post_id><wp:post_parent>502</wp:post_parent><wp:post_type>page</wp:post_type><wp:post_name>${stamp}-child-page</wp:post_name><wp:status>draft</wp:status><content:encoded>Child page</content:encoded></item><item><title>External attachment</title><wp:post_id>504</wp:post_id><wp:post_type>attachment</wp:post_type><wp:attachment_url>https://example.invalid/image.png</wp:attachment_url></item></channel></rss>`;
        const imported = (
          await ok("/api/tools/import", "POST", { format: "wxr", xml })
        ).data;
        posts.push(...imported.postIds);
        terms.push(...imported.termIds);
        assert.equal(imported.imported, 3);
        assert.equal(imported.skippedAttachments, 1);
        assert.equal(imported.commentIds.length, 2);
        const p = (await ok("/api/posts/" + imported.postIds[0])).data.post;
        assert.match(p.rawContent, /<!-- wp:paragraph/);
        assert.match(p.content, /Imported safe body/);
        assert.doesNotMatch(p.content, /onclick|script/);
        assert.equal(p.excerpt, "Imported excerpt");
        assert.equal(p.format, "aside");
        assert.equal(p.categories[0].slug, stamp + "-child");
        assert.equal(p.tags[0].slug, stamp + "-wxr-tag");
        assert.equal(
          (await ok("/api/posts/" + imported.postIds[2])).data.post.parentId,
          imported.postIds[1],
        );
        const cs = await pool.query(
          "SELECT id,parent_id,status FROM comments WHERE id=ANY($1::int[]) ORDER BY id",
          [imported.commentIds],
        );
        assert.equal(cs.rows[1].parent_id, cs.rows[0].id);
        assert.equal(cs.rows[1].status, "pending");
        const archive = (
          await ok(
            "/api/public/resolve?path=" +
              encodeURIComponent("/category/" + stamp + "-child/"),
          )
        ).data;
        assert.equal(archive.archive.taxonomy, "category");
        const exported = await ok("/api/tools/export?format=wxr");
        assert.equal(XMLValidator.validate(exported.raw), true);
        const parsed = new XMLParser().parse(exported.raw);
        assert.equal(parsed.rss.channel["wp:wxr_version"], 1.2);
        assert.match(exported.raw, /<!-- wp:paragraph/);
        assert.doesNotMatch(
          exported.raw,
          /scrypt:|password_hash|Secret-compat-/,
        );
        const unsafe = await request("/api/tools/import", "POST", {
          format: "wxr",
          xml: '<!DOCTYPE x [<!ENTITY xxe SYSTEM "file:///etc/passwd">]><rss><channel><wp:wxr_version>1.2</wp:wxr_version></channel></rss>',
        });
        assert.equal(unsafe.response.status, 400);
        const badCycle = xml.replace(
          "<wp:post_parent>502</wp:post_parent>",
          "<wp:post_parent>503</wp:post_parent>",
        );
        const before = Number(
          (
            await pool.query(
              "SELECT count(*) AS total FROM posts WHERE title LIKE $1",
              [stamp + "%"],
            )
          ).rows[0].total,
        );
        assert.equal(
          (
            await request("/api/tools/import", "POST", {
              format: "wxr",
              xml: badCycle,
            })
          ).response.status,
          400,
        );
        assert.equal(
          Number(
            (
              await pool.query(
                "SELECT count(*) AS total FROM posts WHERE title LIKE $1",
                [stamp + "%"],
              )
            ).rows[0].total,
          ),
          before,
        );
      },
    );
  } finally {
    if (previousPattern)
      await request("/api/settings", "PUT", {
        permalinkStructure: previousPattern,
      });
    if (posts.length)
      await pool.query("DELETE FROM posts WHERE id=ANY($1::int[])", [posts]);
    if (terms.length)
      await pool.query("DELETE FROM terms WHERE id=ANY($1::int[])", [terms]);
    for (const id of media)
      await request("/wp-json/wp/v2/media/" + id + "?force=true", "DELETE");
    await pool.end();
  }
});
