import "dotenv/config";
import assert from "node:assert/strict";
import { test, after } from "node:test";
import { parse } from "@wordpress/block-serialization-default-parser";
import { DOMParser } from "linkedom";
import { pool, postFields, getSettings } from "../server/db.js";
import {
  renderPublicContent,
  renderSiteDocument,
  safeBlockURL,
} from "../server/block-renderer.js";
import { cleanContent, cleanRawContent } from "../server/utils.js";
const block = (name: string, attrs: Record<string, unknown> = {}, inner = "") =>
  `<!-- wp:${name.replace(/^core\//, "")} ${JSON.stringify(attrs)}${inner ? " -->" + inner + `<!-- /wp:${name.replace(/^core\//, "")} -->` : " /-->"}`;
const query = (
  attrs: Record<string, unknown>,
  inner = block("post-title", { level: 3, isLink: true }),
) =>
  block(
    "query",
    attrs,
    block("post-template", {}, inner) +
      block(
        "query-pagination",
        {},
        block("query-pagination-previous") +
          block("query-pagination-numbers") +
          block("query-pagination-next"),
      ) +
      block(
        "query-no-results",
        {},
        block("paragraph", {}, "<p>Nothing found</p>"),
      ),
  );

test("canonical block rendering, public isolation, pagination, nested context and resource limits", async (t) => {
  const db = await pool.connect();
  await db.query("BEGIN");
  try {
    const user = (
      await db.query(
        "SELECT id FROM users WHERE role='administrator' ORDER BY id LIMIT 1",
      )
    ).rows[0];
    assert.ok(user);
    const siteTitle = (await getSettings(db)).siteTitle;
    const stamp = "block-" + Date.now().toString(36);
    const posts: any[] = [];
    for (const [title, status, password] of [
      ["Alpha", "publish", null],
      ["Bravo", "publish", null],
      ["Charlie", "publish", null],
      ["Private secret", "private", null],
      ["Draft secret", "draft", null],
      ["Password secret", "publish", "secret"],
    ] as const) {
      const raw = block(
        "paragraph",
        {},
        `<p>Story ${title} <strong>original</strong></p>`,
      );
      const row = (
        await db.query(
          'INSERT INTO posts(type,title,slug,content,raw_content,status,password_hash,author_id,published_at) VALUES(\'post\',$1,$2,$3,$4,$5,$6,$7,now()) RETURNING id,title,slug,status,content,raw_content AS "rawContent",published_at AS "publishedAt",author_id AS "authorId",type',
          [
            stamp + " " + title,
            stamp + "-" + title.toLowerCase().replace(/ /g, "-"),
            cleanContent(raw),
            raw,
            status,
            password,
            user.id,
          ],
        )
      ).rows[0];
      posts.push(row);
    }
    const category = (
      await db.query(
        "INSERT INTO terms(taxonomy,name,slug) VALUES('category',$1,$1) RETURNING id,slug",
        [stamp],
      )
    ).rows[0];
    await db.query("INSERT INTO post_terms(post_id,term_id) VALUES($1,$2)", [
      posts[1].id,
      category.id,
    ]);
    const options = {
      db,
      placeholderBindings: false,
      requestPath: "/journal/",
      query: { search: stamp },
    };
    await t.test(
      "static legacy HTML is preserved instead of reconstructed from incomplete block attributes",
      async () => {
        const html =
          '<figure class="wp-block-image alignwide"><img src="/uploads/example.png" alt="Original" /></figure><p>Kept <em>formatting</em>.</p>';
        assert.equal(
          await renderPublicContent(
            {
              content: html,
              blocks: [
                {
                  name: "core/image",
                  attributes: { id: 123 },
                  innerBlocks: [],
                },
              ],
            },
            { db },
          ),
          cleanContent(html),
        );
      },
    );
    await t.test(
      "canonical nested static fragments survive dynamic rendering and sanitization",
      async () => {
        assert.equal(
          parse(cleanRawContent("<!-- wp:site-title /-->"))[0].blockName,
          "core/site-title",
        );
        const raw = cleanRawContent(
          block(
            "group",
            {},
            '<section class="preserved">' +
              block("site-title", { level: 2, isLink: false }) +
              "<p>Before <strong>and after</strong></p></section>",
          ),
        );
        const html = await renderSiteDocument({ rawContent: raw }, options);
        assert.ok(new DOMParser().parseFromString(html,"text/html").querySelector("section.preserved"));
        assert.equal(
          new DOMParser().parseFromString(html, "text/html").querySelector("h2")
            ?.textContent,
          siteTitle,
        );
        assert.match(html, /<strong>and after<\/strong>/);
        assert.doesNotMatch(html, /<!--/);
        const unsafe = await renderSiteDocument(
          {
            rawContent:
              block(
                "navigation",
                {},
                block("navigation-link", {
                  label: "<img src=x onerror=alert(1)>Name",
                  url: "javascript:alert(1)",
                  className: 'x" onmouseover="bad',
                }),
              ) +
              block(
                "paragraph",
                {},
                '<p onclick="bad()">Safe<script>alert(1)</script><img src=x onerror=bad()></p>',
              ),
          },
          options,
        );
        assert.doesNotMatch(
          unsafe,
          /javascript:|onmouseover=|onerror=|onclick=|<script/,
        );
        assert.match(unsafe, /Name/);
        assert.equal(safeBlockURL("//evil.example/x"), "");
        assert.equal(safeBlockURL("javascript:alert(1)"), "");
      },
    );
    await t.test(
      "query filters/order/pagination exclude protected and nonpublic records from data and totals",
      async () => {
        const html = await renderSiteDocument(
          {
            rawContent: query({
              queryId: 7,
              query: {
                search: stamp,
                perPage: 2,
                orderBy: "title",
                order: "asc",
              },
            }),
          },
          options,
        );
        assert.ok(html.indexOf("Alpha") < html.indexOf("Bravo"));
        assert.doesNotMatch(
          html,
          /Charlie|Private secret|Draft secret|Password secret/,
        );
        assert.match(html, /query-7-page=2/);
        const second = await renderSiteDocument(
          {
            rawContent: query({
              queryId: 7,
              query: {
                search: stamp,
                perPage: 2,
                orderBy: "title",
                order: "asc",
              },
            }),
          },
          { ...options, query: { "query-7-page": "2" } },
        );
        assert.match(second, /Charlie/);
        assert.doesNotMatch(
          second,
          /Alpha|Bravo|Private secret|Draft secret|Password secret/,
        );
        assert.match(second, /query-7-page=1/);
        assert.doesNotMatch(second, /query-7-page=3/);
        const limitedPages = await renderSiteDocument(
          {
            rawContent: query({
              queryId: 7,
              query: { search: stamp, perPage: 1, pages: 1 },
            }),
          },
          options,
        );
        assert.doesNotMatch(limitedPages, /query-7-page=2/);
        const beyondPages = await renderSiteDocument(
          {
            rawContent: query({
              queryId: 7,
              query: { search: stamp, perPage: 1, pages: 1 },
            }),
          },
          { ...options, query: { "query-7-page": "2" } },
        );
        assert.match(beyondPages, /Nothing found/);
        assert.doesNotMatch(beyondPages, /Charlie/);

        const filtered = await renderSiteDocument(
          {
            rawContent: query({
              query: {
                search: stamp,
                taxQuery: { include: { category: [category.id] } },
              },
            }),
          },
          options,
        );
        assert.match(filtered, /Bravo/);
        assert.doesNotMatch(filtered, /Alpha|Charlie/);
        const excluded = await renderSiteDocument(
          {
            rawContent: query({
              query: { search: stamp, exclude: [posts[0].id, posts[1].id] },
            }),
          },
          options,
        );
        assert.match(excluded, /Charlie/);
        assert.doesNotMatch(excluded, /Alpha|Bravo/);
        const empty = await renderSiteDocument(
          { rawContent: query({ query: { search: stamp + "missing" } }) },
          options,
        );
        assert.match(empty, /Nothing found/);
        assert.doesNotMatch(empty, /Next Page/);
      },
    );
    await t.test(
      "nested queries restore outer post context and independent query IDs",
      async () => {
        const inner = query(
          { queryId: 2, query: { include: [posts[1].id], perPage: 1 } },
          block("post-title", { level: 4, isLink: false }),
        );
        const raw = query(
          { queryId: 1, query: { include: [posts[0].id], perPage: 1 } },
          block("post-title", { level: 2 }) +
            inner +
            block("post-title", { level: 3 }),
        );
        const html = await renderSiteDocument({ rawContent: raw }, options);
        assert.match(
          html,
          new RegExp(
            `<h2[^>]*>${stamp} Alpha<\\/h2>[\\s\\S]*<h4[^>]*>${stamp} Bravo<\\/h4>[\\s\\S]*<h3[^>]*>${stamp} Alpha<\\/h3>`,
          ),
        );
        const same =
          query({ queryId: 11, query: { search: stamp, perPage: 1 } }) +
          query({ queryId: 22, query: { search: stamp, perPage: 1 } });
        const pages = await renderSiteDocument({ rawContent: same }, options);
        assert.match(pages, /query-11-page=2/);
        assert.match(pages, /query-22-page=2/);
        const self = await renderPublicContent(
          {
            ...posts[0],
            rawContent: query({
              queryId: 33,
              query: { search: stamp, perPage: 1 },
            }),
          },
          { db },
        );
        assert.match(
          self,
          new RegExp(`/posts/${posts[0].slug}/\\?query-33-page=2`),
        );
      },
    );
    await t.test(
      "actual post context renders content/terms/date safely and recursive reusable entities terminate",
      async () => {
        const post = (
          await db.query(
            `SELECT ${postFields} FROM posts p JOIN users u ON u.id=p.author_id WHERE p.id=$1`,
            [posts[1].id],
          )
        ).rows[0];
        const html = await renderSiteDocument(
          {
            rawContent:
              block("post-title", { isLink: true }) +
              block("post-content") +
              block("post-terms", { term: "category" }) +
              block("post-date", { format: "Y" }),
          },
          { ...options, post },
        );
        assert.match(html, /Story Bravo/);
        assert.match(html, /<strong>original<\/strong>/);
        assert.match(html, new RegExp("/category/" + stamp + "/"));
        assert.match(html, /<time datetime=/);
        const dates = await renderSiteDocument(
          {
            rawContent: block("post-date", {
              datetime: "2020-01-02T03:04:00",
              format: "Y/m/d g:i a",
            }),
          },
          options,
        );
        assert.match(dates, /2020\/01\/02 3:04 am/);
        assert.match(dates, /datetime="2020-01-02T11:04:00.000Z"/);
        const modified = await renderSiteDocument(
          {
            rawContent: block("post-date", {
              format: "Y",
              metadata: {
                bindings: {
                  datetime: {
                    source: "core/post-data",
                    args: { field: "modified" },
                  },
                },
              },
            }),
          },
          { ...options, post: { ...post, updatedAt: "2022-06-01T12:00:00Z" } },
        );
        assert.match(modified, />2022<\/time>/);
        const archive = await renderSiteDocument(
          { rawContent: block("query-title") },
          { ...options, query: { author: String(user.id) } },
        );
        assert.match(archive, /Author:/);
        assert.doesNotMatch(archive, /Blog/);

        const entity = (
          await db.query(
            "INSERT INTO block_entities(kind,title,slug,status,author_id) VALUES('reusable','Loop',$1,'publish',$2) RETURNING id",
            [stamp, user.id],
          )
        ).rows[0];
        await db.query("UPDATE block_entities SET raw_content=$1 WHERE id=$2", [
          block("paragraph", {}, "<p>Once</p>") +
            block("block", { ref: entity.id }),
          entity.id,
        ]);
        const loop = await renderSiteDocument(
          { rawContent: block("block", { ref: entity.id }) },
          options,
        );
        assert.equal((loop.match(/Once/g) || []).length, 1);
        await db.query("UPDATE block_entities SET status='draft' WHERE id=$1", [
          entity.id,
        ]);
        assert.equal(
          await renderSiteDocument(
            { rawContent: block("block", { ref: entity.id }) },
            options,
          ),
          "",
        );
      },
    );
    await t.test("deep trees and query work are bounded", async () => {
      let raw = block("post-title");
      for (let i = 0; i < 35; i++)
        raw = block("group", {}, "<div>" + raw + "</div>");
      const html = await renderSiteDocument({ rawContent: raw }, options);
      assert.ok(html.length < 2000);
      const requests = Array.from({ length: 300 }, (_, i) =>
        query({ queryId: i, query: { search: stamp + i, perPage: 1 } }),
      ).join("");
      let count = 0;
      const limited = {
        query: (...args: any[]) => {
          count++;
          return (db.query as any)(...args);
        },
      };
      await assert.rejects(
        renderSiteDocument(
          { rawContent: requests },
          { ...options, db: limited as any },
        ),
        /query limit/,
      );
      assert.ok(count <= 512, count + " calls exceeded budget");
    });
  } finally {
    await db.query("ROLLBACK");
    db.release();
  }
});

test("reusable expansion enforces its byte budget before recursive joins", async () => {
  const entity = { rawContent: "<p>" + "content ".repeat(32768) + "</p>" };
  let calls = 0;
  const db = {
    query: async (sql: string) => {
      calls++;
      if (sql.includes("FROM settings")) return { rows: [{ data: {} }] };
      if (sql.includes("FROM block_entities")) return { rows: [entity] };
      throw new Error("Unexpected query: " + sql);
    },
  };
  const raw = Array.from({ length: 40 }, () => block("block", { ref: 1 })).join(
    "",
  );
  await assert.rejects(
    renderSiteDocument({ rawContent: raw }, { db: db as any }),
    (error) =>
      error instanceof Error &&
      "status" in error &&
      error.status === 413 &&
      /8 MiB/.test(error.message),
  );
  assert.equal(
    calls,
    2,
    "Entity caching must not bypass the cumulative output budget",
  );
});

test("block entity REST permissions, canonical persistence and optimistic conflicts", async () => {
  const base = process.env.TEST_API_URL || "http://127.0.0.1:3001",
    origin = process.env.APP_ORIGIN || "http://127.0.0.1:5173";
  const request = async (
    path: string,
    method = "GET",
    data?: unknown,
    cookie = "",
  ) => {
    const response = await fetch(base + path, {
      method,
      headers: {
        Origin: origin,
        "Content-Type": "application/json",
        Cookie: cookie,
      },
      ...(data === undefined ? {} : { body: JSON.stringify(data) }),
    });
    return { response, data: await response.json() };
  };
  const login = await request("/api/auth/login", "POST", {
    login: process.env.ADMIN_EMAIL,
    password: process.env.ADMIN_PASSWORD,
  });
  assert.equal(login.response.status, 200);
  const cookie = (login.response.headers.get("set-cookie") || "").split(";")[0];
  const records: number[] = [],
    postRecords: number[] = [],
    documents: number[] = [];
  try {
    assert.equal((await request("/wp-json/wp/v2/blocks")).response.status, 401);
    const raw = block(
      "group",
      {},
      "<section>" +
        block("paragraph", {}, "<p>Synced <strong>content</strong></p>") +
        "</section>",
    );
    const created = await request(
      "/wp-json/wp/v2/blocks",
      "POST",
      { title: "&lt;img src=x onerror=alert(1)&gt;", content: raw },
      cookie,
    );
    assert.equal(created.response.status, 201, JSON.stringify(created.data));
    records.push(created.data.id);
    assert.equal(created.data.title.raw, "<img src=x onerror=alert(1)>");
    assert.equal(
      created.data.title.rendered,
      "&lt;img src=x onerror=alert(1)&gt;",
    );
    assert.match(created.data.content.raw, /<!-- wp:group/);
    const loaded = await request(
      "/wp-json/wp/v2/blocks/" + created.data.id,
      "GET",
      undefined,
      cookie,
    );
    assert.equal(loaded.data.content.raw, cleanRawContent(raw));
    const updated = await request(
      "/wp-json/wp/v2/blocks/" + created.data.id,
      "POST",
      { title: "Changed", version: created.data.version },
      cookie,
    );
    assert.equal(updated.response.status, 200);
    assert.equal(
      (
        await request(
          "/wp-json/wp/v2/blocks/" + created.data.id,
          "POST",
          { title: "Stale", version: created.data.version },
          cookie,
        )
      ).response.status,
      409,
    );
    assert.equal(
      (await request("/wp-json/wp/v2/blocks/" + created.data.id)).response
        .status,
      401,
    );
    const currentSettings = await request(
      "/api/settings",
      "GET",
      undefined,
      cookie,
    );
    const preview = await request(
      "/wp-json/wp/v2/block-renderer/core/site-title",
      "POST",
      { attributes: { level: 2, isLink: false } },
      cookie,
    );
    assert.equal(preview.response.status, 200, JSON.stringify(preview.data));
    assert.equal(
      new DOMParser()
        .parseFromString(preview.data.rendered, "text/html")
        .querySelector("h2")?.textContent,
      currentSettings.data.settings.siteTitle,
    );
    const options = await request(
      "/wp-json/wp/v2/settings",
      "OPTIONS",
      undefined,
      cookie,
    );
    assert.equal(options.response.status, 200);
    assert.match(options.response.headers.get("allow") || "", /POST/);
    assert.ok(options.data.schema.properties.title);
    const name = "qa-blocks-" + Date.now().toString(36);
    const part = await request(
      "/wp-json/wp/v2/template-parts",
      "POST",
      { title: "&lt;script&gt;Title&lt;/script&gt;", slug: name, content: raw },
      cookie,
    );
    assert.equal(part.response.status, 201, JSON.stringify(part.data));
    documents.push(part.data.wp_id);
    assert.equal(
      part.data.title.rendered,
      "&lt;script&gt;Title&lt;/script&gt;",
    );
    const nativePart = await request(
      "/wp-json/wp/v2/template-parts/" + part.data.id,
      "GET",
      undefined,
      cookie,
    );
    assert.equal(
      nativePart.response.status,
      200,
      JSON.stringify(nativePart.data),
    );
    assert.equal(nativePart.data.content.raw, cleanRawContent(raw));
    const nativeOptions = await request(
      "/wp-json/wp/v2/template-parts/" + part.data.id,
      "OPTIONS",
      undefined,
      cookie,
    );
    assert.equal(nativeOptions.response.status, 200);
    assert.match(nativeOptions.response.headers.get("allow") || "", /POST/);
    const partUpdate = await request(
      "/wp-json/wp/v2/template-parts/" + part.data.id,
      "POST",
      { content: raw, version: part.data.version },
      cookie,
    );
    assert.equal(
      partUpdate.response.status,
      200,
      JSON.stringify(partUpdate.data),
    );
    assert.equal(
      (
        await request(
          "/wp-json/wp/v2/template-parts/" + part.data.id,
          "POST",
          { content: raw, version: part.data.version },
          cookie,
        )
      ).response.status,
      409,
    );
    const document = await request(
      "/api/site-editor/documents",
      "POST",
      {
        slug: name,
        title: "QA private rendering",
        type: "template",
        content:
          block("post-content") + block("post-author-name", { isLink: true }),
        blocks: null,
      },
      cookie,
    );
    assert.equal(document.response.status, 201, JSON.stringify(document.data));
    documents.push(document.data.document.id);
    const createdPost = await request(
      "/api/posts",
      "POST",
      {
        type: "post",
        title: "QA protected " + name,
        content: "<p>Confidential " + name + "</p>",
        status: "publish",
        password: "QA password",
      },
      cookie,
    );
    assert.equal(
      createdPost.response.status,
      201,
      JSON.stringify(createdPost.data),
    );
    postRecords.push(createdPost.data.post.id);
    const templatePath =
      "/api/public/templates/" + name + "?postId=" + createdPost.data.post.id;
    for(const viewer of ["",cookie]){
      const locked=await request(templatePath,"GET",undefined,viewer);
      assert.equal(locked.response.status,200);
      assert.doesNotMatch(locked.data.content,new RegExp("Confidential "+name));
    }
    const unlock = await request(
      "/api/public/posts/" + createdPost.data.post.slug + "/unlock",
      "POST",
      { password: "QA password" },
    );
    assert.equal(unlock.response.status, 200);
    const access = (unlock.response.headers.get("set-cookie") || "").split(
      ";",
    )[0];
    const unlocked = await request(templatePath, "GET", undefined, access);
    assert.equal(unlocked.response.status, 200, JSON.stringify(unlocked.data));
    assert.match(unlocked.data.content, new RegExp("Confidential " + name));
    assert.match(unlocked.data.content, /href="\/\?author=\d+"/);
    const privatePost = await request(
      "/api/posts",
      "POST",
      {
        type: "post",
        title: "QA draft " + name,
        content: "Never public",
        status: "draft",
      },
      cookie,
    );
    assert.equal(privatePost.response.status, 201);
    postRecords.push(privatePost.data.post.id);
    assert.equal(
      (
        await request(
          "/api/public/templates/" +
            name +
            "?postId=" +
            privatePost.data.post.id,
          "GET",
          undefined,
          cookie,
        )
      ).response.status,
      404,
    );
    const another = await request(
      "/api/posts",
      "POST",
      {
        type: "post",
        title: "BBB " + name,
        content: "Another public story",
        status: "publish",
      },
      cookie,
    );
    assert.equal(another.response.status, 201);
    postRecords.push(another.data.post.id);
    const host = await request(
      "/api/posts",
      "POST",
      {
        type: "post",
        title: "AAA " + name,
        content: query({
          queryId: 9,
          query: { search: name, perPage: 1, orderBy: "title", order: "asc" },
        }),
        status: "publish",
      },
      cookie,
    );
    assert.equal(host.response.status, 201, JSON.stringify(host.data));
    postRecords.push(host.data.post.id);
    const firstPage = await request("/api/public/posts/" + host.data.post.slug);
    assert.equal(firstPage.response.status, 200);
    assert.match(firstPage.data.post.content, new RegExp("AAA " + name));
    assert.match(
      firstPage.data.post.content,
      new RegExp("/posts/" + host.data.post.slug + "/\\?query-9-page=2"),
    );
    const nextPage = await request(
      "/api/public/posts/" + host.data.post.slug + "?query-9-page=2",
    );
    assert.equal(nextPage.response.status, 200);
    assert.match(nextPage.data.post.content, new RegExp("BBB " + name));
    assert.doesNotMatch(nextPage.data.post.content, new RegExp("AAA " + name));
    assert.doesNotMatch(nextPage.data.post.content, /Confidential/);
    const metadata = await request(
      "/wp-json/wp/v2/block-types/core/query",
      "GET",
      undefined,
      cookie,
    );
    assert.equal(metadata.response.status, 200, JSON.stringify(metadata.data));
    assert.equal(metadata.data.name, "core/query");
    assert.equal(metadata.data.is_dynamic, true);
  } finally {
    for (const id of postRecords) {
      const current = await request(
        "/api/posts/" + id,
        "GET",
        undefined,
        cookie,
      );
      if (current.data.post)
        await request(
          "/api/posts/" + id,
          "PUT",
          { status: "trash", version: current.data.post.version },
          cookie,
        );
      await request("/api/posts/" + id, "DELETE", undefined, cookie);
    }
    for (const id of documents)
      await request(
        "/api/site-editor/documents/" + id,
        "DELETE",
        undefined,
        cookie,
      );
    for (const id of records)
      await request(
        "/wp-json/wp/v2/blocks/" + id + "?force=true",
        "DELETE",
        undefined,
        cookie,
      );
    await request("/api/auth/logout", "POST", undefined, cookie);
  }
});

after(async () => {
  await pool.end();
});
