import test from "./isolated-test.js";
import assert from "node:assert/strict";
import {
  createAkismetClient,
  checkAkismetComment,
  akismetFields,
  safeServiceURL,
  setAkismetCredentials,
  helloDollyLyric,
  reportAkismetTransition,
  type AkismetTransport,
} from "../server/bundled-plugins.js";
const input = {
  userIP: "203.0.113.42",
  userAgent: "Test browser",
  referrer: "https://example.test/article?token=private#secret",
  authorName: "A reader",
  authorEmail: "reader@example.test",
  authorURL: "https://person.test/",
  content: "A test comment",
  permalink: "https://example.test/post/",
};
const transport = (
  work: (url: string, init: RequestInit) => Response | Promise<Response>,
) =>
  ((url: unknown, init: RequestInit) =>
    work(String(url), init)) as AkismetTransport;
test("Akismet API uses fixed HTTPS endpoints, form encoding, no redirects and bounded responses", async () => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const client = createAkismetClient(
    transport((url, init) => {
      calls.push({ url, init });
      return new Response(
        url.endsWith("verify-key")
          ? "valid"
          : url.endsWith("comment-check")
            ? "true"
            : "Thanks for making the web a better place.",
      );
    }),
  );
  assert.equal(
    await client.verify("fake-test-key", "https://example.test/"),
    "valid",
  );
  assert.equal(
    await client.check(
      akismetFields(input, "fake-test-key", "https://example.test/"),
    ),
    "spam",
  );
  assert.equal(await client.report("spam", {}), true);
  assert.equal(await client.report("ham", {}), true);
  assert.deepEqual(
    calls.map((call) => call.url),
    ["verify-key", "comment-check", "submit-spam", "submit-ham"].map(
      (path) => "https://rest.akismet.com/1.1/" + path,
    ),
  );
  for (const { init } of calls) {
    assert.equal(init.method, "POST");
    assert.equal(init.redirect, "error");
    assert.ok(init.signal);
    assert.ok(init.body instanceof URLSearchParams);
  }
  assert.equal(
    (calls[0].init.body as URLSearchParams).get("api_key"),
    "fake-test-key",
  );
  assert.equal(
    (calls[1].init.body as URLSearchParams).get("comment_author_email"),
    input.authorEmail,
  );
  assert.equal(
    (calls[1].init.body as URLSearchParams).get("referrer"),
    "https://example.test/article",
  );
  assert.equal(
    await createAkismetClient(
      transport(() => new Response("x".repeat(8193))),
    ).check({}),
    "unavailable",
  );
  assert.equal(
    await createAkismetClient(
      transport(() => new Response("false", { status: 503 })),
    ).check({}),
    "unavailable",
  );
  assert.equal(
    await createAkismetClient(
      transport(() => {
        throw new Error("must not echo credential");
      }),
    ).verify("fake", "https://example.test/"),
    "unavailable",
  );
  assert.equal(
    await createAkismetClient(transport(() => new Response("invalid"))).verify(
      "fake",
      "https://example.test/",
    ),
    "invalid",
  );
  assert.equal(
    await createAkismetClient(transport(() => new Response("false"))).check({}),
    "ham",
  );
});
test("unconfigured or disabled Akismet never calls the service; unavailable configured checks hold", async () => {
  let network = 0;
  const client = createAkismetClient(
    transport(() => {
      network++;
      return new Response("false");
    }),
  );
  const database = (config: any) =>
    ({
      query: async (sql: string) => ({
        rows: sql.includes("FROM extensions")
          ? [config]
          : sql.includes("FROM settings")
            ? [{ data: { siteUrl: "https://example.test/" } }]
            : [],
      }),
    }) as any;
  for (const config of [
    null,
    { enabled: false, settings: { sendComments: true }, api_key: "fake" },
    { enabled: true, settings: { sendComments: false }, api_key: "fake" },
    { enabled: true, settings: { sendComments: true }, api_key: null },
  ])
    assert.equal(
      await checkAkismetComment(input, database(config), client),
      "skipped",
    );
  assert.equal(network, 0);
  assert.equal(
    await checkAkismetComment(
      input,
      database({
        enabled: true,
        settings: { sendComments: true },
        api_key: "fake",
        verified_at: null,
      }),
      client,
    ),
    "unavailable",
  );
  assert.equal(network, 0);
  assert.equal(
    await checkAkismetComment(
      input,
      database({
        enabled: true,
        settings: { sendComments: true },
        api_key: "fake",
        verified_at: new Date(),
        verified_site_url: "https://old.test/",
      }),
      client,
    ),
    "unavailable",
  );
  assert.equal(network, 0);
  assert.equal(
    await checkAkismetComment(
      input,
      database({
        enabled: true,
        settings: { sendComments: true },
        api_key: "fake",
        verified_at: new Date(),
        verified_site_url: "https://example.test/",
      }),
      client,
    ),
    "ham",
  );
  assert.equal(network, 1);
});
test("credential updates retain blank keys and only explicit clear removes them", async () => {
  const calls: any[] = [];
  const database = {
    query: async (...args: unknown[]) => {
      calls.push(args);
      return { rows: [] };
    },
  } as any;
  await setAkismetCredentials(database, { apiKey: "" });
  assert.equal(calls.length, 0);
  await setAkismetCredentials(database, { apiKey: "fake123456" });
  assert.ok(calls[0][0].includes("extension_secrets"));
  assert.deepEqual(calls[0][1], ["fake123456"]);
  await setAkismetCredentials(database, { clearApiKey: true });
  assert.match(calls[1][0], /^DELETE FROM extension_secrets/);
  await assert.rejects(
    setAkismetCredentials(database, {
      apiKey: "fake123456",
      clearApiKey: true,
    }),
  );
  await assert.rejects(
    setAkismetCredentials(database, { apiKey: "secret\nheader" }),
  );
});
test("Hello Dolly and service URLs preserve source attribution without executable markup", () => {
  assert.equal(helloDollyLyric(0), "Hello, Dolly");
  assert.equal(typeof helloDollyLyric(), "string");
  assert.equal(
    safeServiceURL("https://user:pass@example.test/path?token=hidden#secret"),
    "https://example.test/path",
  );
  assert.equal(safeServiceURL("javascript:alert(1)"), "");
});

test("moderation feedback uses original submission metadata and sends only real spam/ham transitions", async () => {
  const calls: any[] = [];
  const client = createAkismetClient(
    transport((url, init) => {
      calls.push({ url, fields: new URLSearchParams(String(init.body)) });
      return new Response("Thanks for making the web a better place.");
    }),
  );
  const updates: any[] = [];
  const database = {
    query: async (sql: string, args: unknown[]) => {
      if (sql.includes("FROM extensions"))
        return {
          rows: [
            {
              enabled: true,
              settings: { sendComments: true },
              api_key: "fake-feedback-key",
              verified_at: new Date(),
              verified_site_url: "https://example.test/",
            },
          ],
        };
      if (sql.includes("FROM settings"))
        return { rows: [{ data: { siteUrl: "https://example.test/" } }] };
      if (sql.includes("FROM comments"))
        return {
          rows: [
            {
              post_id: 10,
              type: "post",
              slug: "original-post",
              post_parent_id: null,
              published_at: "2024-01-01T12:00:00Z",
              created_at: "2024-01-02T12:00:00Z",
              author_name: input.authorName,
              author_email: input.authorEmail,
              author_url: input.authorURL,
              content: input.content,
              user_ip: input.userIP,
              user_agent: input.userAgent,
              referrer: input.referrer,
            },
          ],
        };
      updates.push({ sql, args });
      return { rows: [] };
    },
  } as any;
  assert.equal(
    await reportAkismetTransition(5, "pending", "spam", database, client),
    "sent",
  );
  assert.equal(
    await reportAkismetTransition(5, "spam", "approved", database, client),
    "sent",
  );
  assert.equal(
    await reportAkismetTransition(5, "spam", "trash", database, client),
    "skipped",
  );
  assert.equal(calls.length, 2);
  assert.ok(calls[0].url.endsWith("submit-spam"));
  assert.ok(calls[1].url.endsWith("submit-ham"));
  assert.equal(calls[0].fields.get("user_ip"), input.userIP);
  assert.equal(calls[0].fields.get("comment_author_email"), input.authorEmail);
  assert.ok(
    updates.some(
      (item) => item.sql.includes("feedback_status") && item.args[2] === "sent",
    ),
  );
});
