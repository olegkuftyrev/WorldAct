import test, { after } from "./isolated-test.js";
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { pool } from "../server/db.js";

const stage = process.env.TIME_PERMALINK_ARCHIVE_STAGE, archivePath = process.env.TIME_PERMALINK_ARCHIVE_PATH;
const base = process.env.TEST_API_URL!, origin = process.env.APP_ORIGIN!;
after(() => pool.end());

test("time-token settings, chosen seconds and canonical self-links cross fresh archive databases", { skip: !stage || !archivePath }, async () => {
  let cookie = "";
  async function api(path: string, method = "GET", body?: unknown) {
    const response = await fetch(base + path, { method, headers: { Origin: origin, Cookie: cookie, "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
    const data = await response.json(); assert.ok(response.ok, `${path}: ${response.status} ${JSON.stringify(data)}`);
    return { response, data };
  }
  const signed = await api("/api/auth/login", "POST", { login: process.env.ADMIN_EMAIL, password: process.env.ADMIN_PASSWORD });
  cookie = signed.response.headers.get("set-cookie")!.split(";")[0];
  const structure = "/clock/%year%/%monthnum%/%day%/%hour%/%minute%/%second%/%post_id%/%postname%/";
  if (stage === "export") {
    await api("/api/settings", "PUT", { timezone: "+05:45", permalinkStructure: structure, pingServices: [] });
    const post = (await api("/api/posts", "POST", { title: "Time-token portable post", status: "publish", publishedAt: "2024-12-31T18:15:39Z", content: "<p>TIME-ARCHIVE-FIRST</p><!--nextpage--><p>TIME-ARCHIVE-SECOND</p>" })).data.post;
    assert.equal(post.permalink, `/clock/2025/01/01/00/00/39/${post.id}/${post.slug}/`);
    await api("/api/posts/" + post.id, "PUT", { content: `<p>TIME-ARCHIVE-FIRST <a href="${post.permalink}#keep">Canonical self-link</a></p><!--nextpage--><p>TIME-ARCHIVE-SECOND</p>` });
    const archive = (await api("/api/tools/export")).data;
    assert.equal(archive.settings.permalinkStructure, structure); assert.equal(archive.settings.timezone, "+05:45");
    assert.equal(archive.posts.find((row: any) => row.id === post.id).published_at, "2024-12-31T18:15:39.000Z");
    await writeFile(archivePath!, JSON.stringify({ archive, sourceId: post.id }), { mode: 0o600 });
  } else {
    assert.equal(stage, "restore");
    const fixture = JSON.parse(await readFile(archivePath!, "utf8"));
    const restored = (await api("/api/tools/import", "POST", { ...fixture.archive, replaceDesign: true })).data;
    assert.equal(restored.restoredDesign, true);
    const settings = (await api("/api/settings")).data.settings;
    assert.equal(settings.permalinkStructure, structure); assert.equal(settings.timezone, "+05:45");
    const row = (await pool.query("SELECT id FROM posts WHERE id=ANY($1::int[]) AND title='Time-token portable post'", [restored.postIds])).rows[0];
    assert.ok(row); assert.notEqual(row.id, fixture.sourceId);
    const post = (await api("/api/posts/" + row.id)).data.post;
    assert.equal(post.publishedAt, "2024-12-31T18:15:39.000Z");
    const expected = `/clock/2025/01/01/00/00/39/${post.id}/${post.slug}/`;
    assert.equal(post.permalink, expected); assert.ok(post.rawContent.includes(expected + "#keep"));
    const result = await api("/api/public/resolve?" + new URLSearchParams({ path: expected + "2/" }));
    assert.equal(result.data.post.id, post.id); assert.equal(result.data.contentPage, 2);
    assert.match(result.data.post.content, /TIME-ARCHIVE-SECOND/); assert.doesNotMatch(result.data.post.content, /TIME-ARCHIVE-FIRST/);
    assert.equal(result.data.post.contentPagination.links[1].url, expected + "2/");
    const exported = (await api("/api/tools/export")).data;
    assert.equal(exported.posts.find((record: any) => record.id === post.id).published_at, "2024-12-31T18:15:39.000Z");
  }
});
