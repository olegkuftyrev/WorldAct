import test from "./isolated-test.js";
import assert from "node:assert/strict";

test("Classic HTML and native Shortcode survive atomic saves, autosave preview, revision restore and JSON import", async () => {
  const base = process.env.TEST_API_URL!,
    origin = process.env.APP_ORIGIN!;
  let cookie = "";
  const ids: number[] = [];
  const api = async (path: string, method = "GET", body?: unknown) => {
    const response = await fetch(base + "/api" + path, {
      method,
      headers: {
        Origin: origin,
        "Content-Type": "application/json",
        ...(cookie ? { Cookie: cookie } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const data = await response.json();
    assert.ok(response.ok, JSON.stringify(data));
    return { response, data };
  };
  const html =
    '<h2>Classic &amp; rich</h2><p><strong>Bold</strong> and <em>italic</em> <a href="/posts/hello-world/" target="_blank" rel="noopener noreferrer">source link</a>.</p><ul><li>One</li><li>Two</li></ul><p>[unsupported-widget safe="literal"]</p>';
  const text =
    '[caption width="300"]<img src="/uploads/classic.png" alt="A &amp; B" />A caption[/caption]';
  const blocks = [
    { name: "core/freeform", attributes: { content: html }, innerBlocks: [] },
    { name: "core/shortcode", attributes: { text }, innerBlocks: [] },
  ];
  const raw =
    html + "\n\n<!-- wp:shortcode -->\n" + text + "\n<!-- /wp:shortcode -->";
  try {
    const login = await api("/auth/login", "POST", {
      login: process.env.ADMIN_EMAIL,
      password: process.env.ADMIN_PASSWORD,
    });
    cookie = login.response.headers.get("set-cookie")!.split(";")[0];
    let p = (
      await api("/posts", "POST", {
        title: "Classic persistence " + Date.now(),
        content: raw,
        blocks,
        status: "publish",
      })
    ).data.post;
    ids.push(p.id);
    assert.equal(p.blocks[0].name, "core/freeform");
    assert.equal(p.blocks[0].attributes.content, html);
    assert.equal(p.blocks[1].attributes.text, text);
    assert.match(p.rawContent, /wp:shortcode/);
    await api(`/posts/${p.id}/autosave`, "PUT", {
      title: p.title,
      content: raw.replace("Bold", "Unsaved classic"),
      blocks: [
        {
          ...blocks[0],
          attributes: { content: html.replace("Bold", "Unsaved classic") },
        },
        blocks[1],
      ],
      version: p.version,
    });
    const preview = (await api(`/posts/${p.id}/preview`)).data.post;
    assert.match(preview.content, /Unsaved classic/);
    assert.match(preview.content, /wp-caption/);
    assert.doesNotMatch(preview.content, /\[caption/);
    const saved = (await api(`/posts/${p.id}`)).data.post;
    assert.equal(
      saved.blocks[0].attributes.content,
      html,
      "preview does not replace canonical Classic buffer",
    );
    p = (
      await api(`/posts/${p.id}`, "PUT", {
        version: p.version,
        content: "<p>Changed</p>",
        blocks: [
          {
            name: "core/freeform",
            attributes: { content: "<p>Changed</p>" },
            innerBlocks: [],
          },
        ],
      })
    ).data.post;
    const revisions = (await api(`/posts/${p.id}/revisions`)).data.revisions;
    assert.ok(revisions.length);
    const restored = (
      await api(`/posts/${p.id}/revisions/${revisions[0].id}/restore`, "POST", {
        version: p.version,
      })
    ).data.post;
    assert.equal(restored.blocks[0].attributes.content, html);
    assert.equal(restored.blocks[1].attributes.text, text);
    const result = (
      await api("/tools/import", "POST", {
        application: "WorldAct",
        version: 1,
        posts: [
          {
            ...restored,
            slug: "classic-copy-" + Date.now(),
            title: "Imported Classic",
            status: "draft",
          },
        ],
      })
    ).data;
    assert.equal(result.imported, 1);
    const imported = (
      await api("/posts?search=Imported%20Classic")
    ).data.posts.find((item: any) => item.title === "Imported Classic");
    assert.ok(imported);
    ids.push(imported.id);
    const copy = (await api(`/posts/${imported.id}`)).data.post;
    assert.equal(copy.blocks[0].attributes.content, html);
    assert.equal(copy.blocks[1].attributes.text, text);
  } finally {
    for (const id of ids) {
      await api(`/posts/${id}`, "PUT", { status: "trash" });
      await api(`/posts/${id}`, "DELETE");
    }
  }
});
