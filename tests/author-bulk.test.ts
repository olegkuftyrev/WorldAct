import "dotenv/config";
import assert from "node:assert/strict";
import test from "node:test";
const base = process.env.TEST_API_URL || "http://127.0.0.1:3001";
const origin = process.env.APP_ORIGIN || "http://127.0.0.1:5173";
const cookieOf = (response: Response) => (response.headers.get("set-cookie") || "").split(";")[0];

test("author assignment and bulk editorial updates preserve permissions, versions and unrelated content", async t => {
  let admin = "";
  const stamp = "authors-" + Date.now().toString(36), password = "Author-safe-" + stamp;
  const users: number[] = [], posts: number[] = [], terms: number[] = [], sessions: string[] = [];
  const people: Record<string, any> = {};
  const call = async (url: string, method = "GET", body?: unknown, cookie = admin) => {
    const response = await fetch(base + "/api" + url, { method, headers: { Origin: origin, "Content-Type": "application/json", Cookie: cookie }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { response, data: await response.json() };
  };
  const ok = async (url: string, method = "GET", body?: unknown, cookie = admin) => {
    const result = await call(url, method, body, cookie);
    assert.ok(result.response.ok, `${url}: ${result.response.status} ${JSON.stringify(result.data)}`);
    return result.data;
  };
  const create = async (input: Record<string, unknown>, cookie = admin) => {
    const post = (await ok("/posts", "POST", { title: stamp, ...input }, cookie)).post;
    posts.push(post.id); return post;
  };
  try {
    const login = await call("/auth/login", "POST", { login: process.env.ADMIN_EMAIL, password: process.env.ADMIN_PASSWORD }, "");
    assert.equal(login.response.status, 200); admin = cookieOf(login.response); sessions.push(admin);
    for (const role of ["editor", "author", "contributor", "subscriber"]) {
      const person = (await ok("/users", "POST", { username: stamp + "-" + role, email: stamp + "-" + role + "@example.invalid", displayName: "Temporary " + role, role, password })).user;
      users.push(person.id);
      const signed = await call("/auth/login", "POST", { login: person.username, password }, "");
      assert.equal(signed.response.status, 200);
      people[role] = { ...person, cookie: cookieOf(signed.response) }; sessions.push(people[role].cookie);
    }
    let one: any, two: any, owned: any;
    await t.test("author lists expose safe eligible profiles and actual writing defaults", async () => {
      assert.equal((await call("/authors", "GET", undefined, "")).response.status, 401);
      assert.equal((await call("/authors", "GET", undefined, people.subscriber.cookie)).response.status, 403);
      for (const cookie of [admin, people.editor.cookie]) {
        const list = await ok("/authors", "GET", undefined, cookie);
        assert.ok(list.authors.some((person: any) => person.id === people.author.id));
        assert.ok(list.authors.some((person: any) => person.id === people.contributor.id));
        assert.ok(!list.authors.some((person: any) => person.id === people.subscriber.id));
        for (const person of list.authors) assert.deepEqual(Object.keys(person).sort(), ["displayName", "id", "role", "username"]);
        assert.equal(list.defaults.pingStatus, "closed"); assert.ok(list.defaults.format); assert.ok(list.defaults.commentStatus);
      }
      for (const role of ["author", "contributor"]) assert.deepEqual((await ok("/authors", "GET", undefined, people[role].cookie)).authors.map((person: any) => person.id), [people[role].id]);
    });
    await t.test("creation and reassignment restrict target roles and preserve ownership boundaries", async () => {
      one = await create({ authorId: people.author.id, content: '<!-- wp:paragraph --><p>Persistent body</p><!-- /wp:paragraph -->', blocks: [{ name: "core/paragraph", attributes: { content: "Persistent body" }, innerBlocks: [] }] }, people.editor.cookie);
      assert.equal(one.authorId, people.author.id);
      two = await create({ authorId: people.contributor.id });
      assert.equal(two.authorId, people.contributor.id);
      for (const authorId of [people.subscriber.id, 2147483600]) assert.equal((await call("/posts", "POST", { title: stamp + " invalid", authorId })).response.status, 400);
      assert.equal((await call("/posts", "POST", { title: stamp, authorId: people.editor.id }, people.author.cookie)).response.status, 403);
      assert.equal((await call(`/posts/${one.id}`, "PUT", { authorId: people.editor.id }, people.author.cookie)).response.status, 403);
      assert.equal((await call(`/posts/${one.id}`, "PUT", { type: "page" }, people.author.cookie)).response.status, 403);
      owned = await create({ title: stamp + " Own" }, people.author.cookie);
      assert.equal(owned.authorId, people.author.id);
      assert.equal(owned.pingStatus, "closed");
      assert.equal((await call(`/posts/${owned.id}`, "PUT", { sticky: true }, people.author.cookie)).response.status, 403);
      assert.equal((await call(`/posts/${one.id}`, "PUT", { authorId: people.subscriber.id })).response.status, 400);
    });
    let categoryA: any, categoryB: any, tagA: any, tagB: any;
    await t.test("bulk add keeps content while reporting stale and missing rows independently", async () => {
      for (const [taxonomy, label] of [["category", "A"], ["category", "B"], ["tag", "A"], ["tag", "B"]]) {
        const term = (await ok("/terms", "POST", { taxonomy, name: stamp + " " + taxonomy + label })).term; terms.push(term.id);
        if (taxonomy === "category" && label === "A") categoryA = term;
        else if (taxonomy === "category") categoryB = term;
        else if (label === "A") tagA = term; else tagB = term;
      }
      one = (await ok(`/posts/${one.id}`, "PUT", { categoryIds: [categoryA.id], tagIds: [tagA.id] })).post;
      const beforeRevisions = (await ok(`/posts/${one.id}/revisions`)).revisions.length;
      const result = await ok("/posts/bulk", "POST", { ids: [one.id, two.id, 2147483600], versions: { [one.id]: one.version, [two.id]: two.version + 1 }, changes: { authorId: people.editor.id, categoryIds: [categoryB.id], tagIds: [tagB.id], status: "publish", commentStatus: "closed", pingStatus: "open", sticky: true, format: "quote", password: "private-bulk-password" } });
      assert.deepEqual(result.updated, [one.id]);
      assert.deepEqual(result.errors.map((error: any) => [error.id, error.status]), [[two.id, 409], [2147483600, 404]]);
      const saved = result.posts[0];
      assert.equal(saved.version, one.version + 1); assert.equal(saved.authorId, people.editor.id);
      assert.equal(saved.content, one.content); assert.equal(saved.rawContent, one.rawContent); assert.deepEqual(saved.blocks, one.blocks);
      assert.deepEqual(saved.categoryIds.slice().sort(), [categoryA.id, categoryB.id].sort());
      assert.deepEqual(saved.tagIds.slice().sort(), [tagA.id, tagB.id].sort());
      assert.equal(saved.pingStatus, "open"); assert.equal(saved.commentStatus, "closed"); assert.equal(saved.sticky, true); assert.equal(saved.format, "quote"); assert.equal(saved.hasPassword, true);
      const revisions = (await ok(`/posts/${one.id}/revisions`)).revisions;
      assert.equal(revisions.length, beforeRevisions + 1); assert.equal(revisions[0].metadata.authorId, people.author.id); assert.equal(revisions[0].metadata.pingStatus, "closed");
      assert.equal((await call(`/posts/${one.id}`, "GET", undefined, people.author.cookie)).response.status, 403);
      assert.equal((await ok(`/posts/${two.id}`)).post.version, two.version);
      assert.equal((await ok(`/public/posts/${saved.slug}`, "GET", undefined, "")).post.locked, true);
      one = saved;
    });
    await t.test("bulk replacement, password clearing and permissions use the single-post rules", async () => {
      const replaced = await ok("/posts/bulk", "POST", { ids: [one.id], versions: { [one.id]: one.version }, categoryMode: "replace", tagMode: "replace", changes: { categoryIds: [categoryB.id], tagIds: [], password: "", sticky: false, pingStatus: "closed" } });
      one = replaced.posts[0]; assert.deepEqual(one.categoryIds, [categoryB.id]); assert.deepEqual(one.tagIds, []); assert.equal(one.hasPassword, false);
      assert.match((await ok(`/public/posts/${one.slug}`, "GET", undefined, "")).post.content, /Persistent body/);
      const scoped = await ok("/posts/bulk", "POST", { ids: [owned.id, one.id], changes: { commentStatus: "closed", pingStatus: "open" } }, people.author.cookie);
      assert.deepEqual(scoped.updated, [owned.id]); assert.equal(scoped.errors[0].status, 403);
      const forbidden = await ok("/posts/bulk", "POST", { ids: [owned.id], changes: { authorId: people.contributor.id } }, people.author.cookie); assert.equal(forbidden.errors[0].status, 403);
      const publish = await ok("/posts/bulk", "POST", { ids: [two.id], changes: { status: "publish" } }, people.contributor.cookie); assert.equal(publish.errors[0].status, 403);
      const invalidTerms = await ok("/posts/bulk", "POST", { ids: [owned.id], changes: { categoryIds: [tagA.id] } }); assert.equal(invalidTerms.errors[0].status, 400);
      assert.equal((await call("/posts/bulk", "POST", { ids: [owned.id], changes: {} })).response.status, 400);
      assert.equal((await call("/posts/bulk", "POST", { ids: [owned.id], changes: { content: "Must not change" } })).response.status, 400);
      assert.equal((await call("/posts/bulk", "POST", { ids: Array(101).fill(owned.id), changes: { status: "draft" } })).response.status, 400);
    });
    await t.test("bulk page parenting preserves hierarchy and scheduling requires a real date", async () => {
      const parent = await create({ type: "page", title: stamp + " Parent" }), child = await create({ type: "page", title: stamp + " Child" });
      const edited = await ok("/posts/bulk", "POST", { ids: [child.id, parent.id], changes: { parentId: parent.id, menuOrder: 9, pingStatus: "open" } });
      assert.deepEqual(edited.updated, [child.id]); assert.equal(edited.errors[0].status, 400);
      const saved = (await ok(`/posts/${child.id}`)).post; assert.equal(saved.parentId, parent.id); assert.equal(saved.menuOrder, 9); assert.equal(saved.pingStatus, "open");
      assert.equal((await call(`/posts/${parent.id}`, "PUT", { type: "post" })).response.status, 400);
      assert.equal((await ok("/posts/bulk", "POST", { ids: [parent.id], changes: { sticky: true } })).errors[0].status, 400);
      assert.equal((await ok("/posts/bulk", "POST", { ids: [owned.id], changes: { status: "future" } })).errors[0].status, 400);
      const scheduledAt = new Date(Date.now() + 86_400_000).toISOString();
      const future = await ok("/posts/bulk", "POST", { ids: [owned.id], changes: { status: "future", scheduledAt } });
      assert.equal(future.posts[0].status, "future"); assert.equal(future.posts[0].scheduledAt, scheduledAt);
    });
  } finally {
    for (const id of posts.reverse()) { await call(`/posts/${id}`, "PUT", { status: "trash" }); await call(`/posts/${id}`, "DELETE"); }
    for (const id of terms.reverse()) await call(`/terms/${id}`, "DELETE");
    for (const session of sessions) if (session !== admin) await call("/auth/logout", "POST", {}, session);
    for (const id of users) await call(`/users/${id}?deleteContent=true`, "DELETE");
    if (admin) await call("/auth/logout", "POST", {}, admin);
  }
});
