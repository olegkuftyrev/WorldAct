import test, { after } from "./isolated-test.js";
import "dotenv/config";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import { gzipSync, deflateSync, brotliCompressSync } from "node:zlib";
import { createHash } from "node:crypto";
import { DOMParser } from "linkedom";
import { pool, defaultSettings } from "../server/db.js";
import { normalizeFeedURL, isPublicFeedAddress, createFeedTransport, FeedError, MAX_FEED_XML_BYTES, MAX_FEED_WIRE_BYTES } from "../server/rss-transport.js";
import { parseFeedDocument, createFeedService, type ParsedFeed } from "../server/rss.js";
import { renderSiteDocument, SUPPORTED_DYNAMIC_BLOCKS, type State } from "../server/block-renderer.js";
import { cleanContent } from "../server/utils.js";
const xml = `<?xml version="1.0"?><rss version="2.0" xmlns:dc="http://purl.org/dc/elements/1.1/"><channel><title>Fixture</title><item><title><![CDATA[ <b>RSS &amp; safe</b><script>injected()</script> ]]></title><link>https://articles.example.test/story?one=1&amp;two=2</link><dc:creator><![CDATA[Reader <b>Name</b>]]></dc:creator><pubDate>Sat, 07 Nov 2026 12:00:00 GMT</pubDate><description><![CDATA[<p>one two three &amp; four <img src="https://evil.invalid/x" onerror="bad()"></p>]]></description></item></channel></rss>`;
const atom = `<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom"><title>Atom</title><author><name>Feed Author</name></author><entry><title type="xhtml"><div xmlns="http://www.w3.org/1999/xhtml">Atom <strong>Title</strong></div></title><link rel="self" href="/feed-entry.xml" type="application/atom+xml"/><link rel="alternate" href="../story"/><updated>2026-11-07T12:00:00Z</updated><summary><![CDATA[<p>Atom summary</p>]]></summary></entry></feed>`;
const bytes = Buffer.from(xml);
const dom = (html: string) => new DOMParser().parseFromString("<!doctype html><html><body>" + html + "</body></html>", "text/html");
const state = (db: any = pool): State => ({ db, settings: { ...defaultSettings, siteUrl: "https://own.example.test" }, options: {}, nodes: 0, outputBytes: 0, queries: 0, cache: new Map() });
const block = (attrs: Record<string, unknown>) => `<!-- wp:rss ${JSON.stringify(attrs)} /-->`;
after(async () => { await pool.end(); });

test("link sanitization preserves bounded safe rel tokens without allowing attributes, opener or script schemes", () => {
  const parsed = dom(cleanContent('<a href="https://example.test/" rel="NOFOLLOW ugc nofollow opener javascript:bad() &quot; onclick=&quot;bad()">Safe</a><a href="javascript:bad()" rel="sponsored external">Unsafe</a><a href="/local" rel="' + 'x'.repeat(501) + ' ugc">Bounded</a>'));
  const links = parsed.querySelectorAll("a");
  assert.equal(links[0].getAttribute("rel"), "nofollow ugc noopener noreferrer");
  assert.equal(links[1].getAttribute("href"), null);
  assert.equal(links[1].getAttribute("rel"), "sponsored external noopener noreferrer");
  assert.equal(links[2].getAttribute("rel"), "noopener noreferrer");
  assert.equal(parsed.querySelector("[onclick]"), null);
});

test("RSS URL and public-address validation rejects private, encoded and transitional destinations", () => {
  for (const input of ["//example.com/feed", "file:///etc/passwd", "ftp://example.com/feed", "https://user:password@example.com/feed", "https://example.com/has space", "https://example.com/\\private", " https://example.com/feed", "https://[fe80::1%25lo0]/feed"]) assert.throws(() => normalizeFeedURL(input), FeedError);
  assert.equal(normalizeFeedURL("https://EXAMPLE.com/feed#section").href, "https://example.com/feed");
  assert.equal(normalizeFeedURL("https://EXAMPLE.com./feed#section").href, "https://example.com/feed");
  for (const address of ["0.1.2.3", "10.0.0.1", "100.64.1.1", "127.0.0.1", "169.254.169.254", "172.16.4.5", "192.0.0.1", "192.0.2.1", "192.88.99.1", "192.168.2.1", "198.18.0.1", "198.51.100.1", "203.0.113.1", "224.0.0.1", "255.255.255.255", "::", "::1", "::127.0.0.1", "::ffff:127.0.0.1", "::ffff:7f00:1", "fc00::1", "fe80::1", "ff02::1", "64:ff9b::7f00:1", "2001::1", "2001:db8::1", "2002:7f00:1::1", "2002:808:808::1", "3fff:1::1", "not-an-ip"]) assert.equal(isPublicFeedAddress(address), false, address);
  for (const address of ["8.8.8.8", "1.1.1.1", "93.184.216.34", "2606:4700:4700::1111", "2001:4860:4860::8888", "::ffff:8.8.8.8", "::ffff:808:808"]) assert.equal(isPublicFeedAddress(address), true, address);
});

type Reply = { status?: number; location?: string; body?: Buffer; encoding?: string; length?: string; remote?: string; chunks?: Buffer[]; never?: boolean };
function fakeRequest(replies: Reply[], inspect?: (options: any) => void) {
  let requests = 0;
  return { get requests() { return requests; }, request: ((options: any, callback: (response: any) => void) => {
    inspect?.(options); const reply = replies[requests++] || { body: bytes };
    const req = new EventEmitter() as any; req.setTimeout = () => req; req.destroy = () => { req.destroyed = true; }; req.end = () => {
      setImmediate(() => {
        if (req.destroyed) return;
        const socket = new EventEmitter() as any; socket.remoteAddress = reply.remote || "93.184.216.34"; req.emit("socket", socket); socket.emit("connect");
        if (req.destroyed || reply.never) return;
        const response = Readable.from(reply.chunks || [reply.body || Buffer.alloc(0)]) as any;
        response.statusCode = reply.status || 200; response.complete = true; response.headers = { ...(reply.location ? { location: reply.location } : {}), ...(reply.encoding ? { "content-encoding": reply.encoding } : {}), ...(reply.length ? { "content-length": reply.length } : {}) }; callback(response);
      });
    }; return req;
  }) as any };
}
const publicDNS = async () => [{ address: "93.184.216.34", family: 4 }];

test("actual request options pin DNS resolution while retaining host/TLS verification and no credentials", async () => {
  let lookups = 0; const observed: any[] = [];
  const fixture = fakeRequest([{ body: bytes }], options => {
    observed.push(options); assert.equal(options.hostname, "public-feed.example.test"); assert.equal(options.servername, "public-feed.example.test"); assert.equal(options.rejectUnauthorized, true); assert.equal(options.agent, false); assert.equal(options.autoSelectFamily, false);
    options.lookup(options.hostname, {}, (error: unknown, address: string, family: number) => { assert.equal(error, null); assert.equal(address, "93.184.216.34"); assert.equal(family, 4); });
    options.lookup(options.hostname, { all: true }, (error: unknown, addresses: unknown) => { assert.equal(error, null); assert.deepEqual(addresses, [{ address: "93.184.216.34", family: 4 }]); });
    assert.equal(options.headers.Cookie, undefined); assert.equal(options.headers.Authorization, undefined);
  });
  const fetch = createFeedTransport({ resolve: async () => { lookups++; return lookups === 1 ? publicDNS() : [{ address: "127.0.0.1", family: 4 }]; }, request: fixture.request });
  assert.equal((await fetch("https://public-feed.example.test/rss#fragment")).body.toString(), xml); assert.equal(lookups, 1); assert.equal(observed[0].path, "/rss");
  const wrongPeer = fakeRequest([{ remote: "127.0.0.1", body: bytes }]);
  await assert.rejects(createFeedTransport({ resolve: publicDNS, request: wrongPeer.request })("https://example.test/feed"), /connection could not be verified/);
});

test("all DNS answers and every redirect are checked before connection, including IPv4-mapped private targets", async () => {
  for (const addresses of [[{ address: "93.184.216.34", family: 4 }, { address: "127.0.0.1", family: 4 }], [{ address: "::ffff:7f00:1", family: 6 }]]) {
    const fixture = fakeRequest([]); await assert.rejects(createFeedTransport({ resolve: async () => addresses, request: fixture.request })("https://public.example.test/feed"), /public address/); assert.equal(fixture.requests, 0);
  }
  const fixture = fakeRequest([{ status: 302, location: "http://127.0.0.1/private" }]); await assert.rejects(createFeedTransport({ resolve: publicDNS, request: fixture.request })("https://example.test/feed"), /public address/); assert.equal(fixture.requests, 1);
  for (const location of ["http://user:password@public.example.test/feed", "file:///etc/passwd", "https://public.example.test:8443/feed"]) {
    const fixture = fakeRequest([{ status: 301, location }]); await assert.rejects(createFeedTransport({ resolve: publicDNS, request: fixture.request })("https://example.test/feed"), FeedError); assert.equal(fixture.requests, 1);
  }
  const loop = fakeRequest([{ status: 301, location: "/feed" }]); await assert.rejects(createFeedTransport({ resolve: publicDNS, request: loop.request })("https://example.test/feed"), /loop/);
  const limit = fakeRequest([1, 2, 3, 4].map(index => ({ status: 302, location: "/page" + index }))); await assert.rejects(createFeedTransport({ resolve: publicDNS, request: limit.request })("https://example.test/feed"), /too many/); assert.equal(limit.requests, 4);
  const valid = fakeRequest([{ status: 301, location: "/new-feed" }, { body: bytes }]); let resolves = 0;
  assert.equal((await createFeedTransport({ resolve: async () => { resolves++; return publicDNS(); }, request: valid.request })("http://example.test:8080/feed")).url, "http://example.test:8080/new-feed"); assert.equal(resolves, 2);
});

test("transport bounds wire/decompressed bytes, compression formats, DNS/HTTP time and response failures", async () => {
  for (const [encoding, body] of [["gzip", gzipSync(bytes)], ["deflate", deflateSync(bytes)], ["br", brotliCompressSync(bytes)]] as const) assert.equal((await createFeedTransport({ resolve: publicDNS, request: fakeRequest([{ body, encoding }]).request })("https://example.test/feed")).body.toString(), xml);
  for (const reply of [{ body: gzipSync(Buffer.alloc(MAX_FEED_XML_BYTES + 1, 65)), encoding: "gzip" }, { body: Buffer.alloc(MAX_FEED_WIRE_BYTES + 1) }, { length: String(MAX_FEED_WIRE_BYTES + 1), body: bytes }, { body: bytes, encoding: "unknown" }, { status: 503, body: bytes }]) await assert.rejects(createFeedTransport({ resolve: publicDNS, request: fakeRequest([reply]).request })("https://example.test/feed"), FeedError);
  await assert.rejects(createFeedTransport({ resolve: () => new Promise(() => {}), request: fakeRequest([]).request, timeoutMs: 100, dnsTimeoutMs: 10 })("https://example.test/feed"), /timed out/);
  const keepAlive = setTimeout(() => {}, 150);
  try { await assert.rejects(createFeedTransport({ resolve: publicDNS, request: fakeRequest([{ never: true }]).request, timeoutMs: 20 })("https://example.test/feed"), /timed out/); } finally { clearTimeout(keepAlive); }
});

test("transport has a bounded shared connection pool and aborts queued work", async () => {
  const fixture = fakeRequest(Array.from({ length: 70 }, () => ({ never: true }))); let active = 0, maximum = 0;
  const request = ((options: any, callback: any) => { const req = fixture.request(options, callback) as any, end = req.end, destroy = req.destroy; let started = false; req.end = () => { started = true; active++; maximum = Math.max(maximum, active); end(); }; req.destroy = () => { if (started) { started = false; active--; } destroy(); }; return req; }) as any;
  const fetch = createFeedTransport({ resolve: publicDNS, request, timeoutMs: 40 }), keepAlive = setTimeout(() => {}, 150);
  try { const results = await Promise.allSettled(Array.from({ length: 70 }, (_, index) => fetch("https://example.test/feed/" + index))); assert.ok(maximum <= 4); assert.equal(active, 0); assert.ok(results.every(result => result.status === "rejected")); assert.ok(results.some(result => result.status === "rejected" && /busy/.test(result.reason.message))); } finally { clearTimeout(keepAlive); }
});

test("RSS/Atom parser decodes safe text, relative links and dates while rejecting XML entities and complexity", () => {
  const rss = parseFeedDocument(bytes, "https://feed.example.test/rss"); assert.equal(rss.items[0].title, "RSS & safe"); assert.equal(rss.items[0].author, "Reader Name"); assert.equal(rss.items[0].description, "one two three & four"); assert.equal(rss.items[0].link, "https://articles.example.test/story?one=1&two=2");
  const parsed = parseFeedDocument(Buffer.from(atom), "https://feed.example.test/directory/rss"); assert.equal(parsed.items[0].title, "Atom Title"); assert.equal(parsed.items[0].author, "Feed Author"); assert.equal(parsed.items[0].link, "https://feed.example.test/story");
  const namespaced = '<a:feed xmlns:a="http://www.w3.org/2005/Atom"><a:entry><a:title>Prefixed Atom</a:title><a:link href="/story"/></a:entry></a:feed>';
  assert.equal(parseFeedDocument(Buffer.from(namespaced), "https://feed.example.test/rss").items[0].title, "Prefixed Atom");
  const rdf = '<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#" xmlns="http://purl.org/rss/1.0/"><channel><title>RDF</title></channel><item><title>RSS One</title><link>/one</link></item></rdf:RDF>';
  assert.equal(parseFeedDocument(Buffer.from(rdf), "https://feed.example.test/rss").items[0].title, "RSS One");
  assert.equal(parseFeedDocument(Buffer.from('<rss><channel><item><title></title><link>javascript:bad()</link><description>Safe</description></item></channel></rss>'), "https://example.test/").items[0].link, "");
  const utf16 = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(xml.replace('version="1.0"', 'version="1.0" encoding="UTF-16"'), "utf16le")]); assert.equal(parseFeedDocument(utf16, "https://example.test/").items[0].title, "RSS & safe");
  const latin = Buffer.from('<?xml version="1.0" encoding="ISO-8859-1"?><rss><channel><item><title>Café</title></item></channel></rss>', "latin1"); assert.equal(parseFeedDocument(latin, "https://example.test/").items[0].title, "Café");
  assert.throws(() => parseFeedDocument(Buffer.from('<rss><channel><item><description><![CDATA[' + '<div>'.repeat(2001) + 'Text' + '</div>'.repeat(2001) + ']]></description></item></channel></rss>'), "https://example.test/"), FeedError);
  for (const invalid of ['<!DOCTYPE rss [<!ENTITY secret SYSTEM "file:///etc/passwd">]><rss><channel>&secret;</channel></rss>', '<!DOCTYPE rss [<!ENTITY a "&a;&a;">]><rss><channel>&a;</channel></rss>', '<rss><channel>' + '<deep>'.repeat(50) + '</deep>'.repeat(50) + '</channel></rss>', '<rss><channel>' + '<item/>'.repeat(10001) + '</channel></rss>', '<rss><channel></rss>', '<html><body>Not a feed</body></html>']) assert.throws(() => parseFeedDocument(Buffer.from(invalid), "https://example.test/"), FeedError);
});

test("external cache survives service restart, coalesces work, expires, records errors briefly and bounds storage", async () => {
  const stamp = "rss-cache-" + Date.now().toString(36), url = normalizeFeedURL("https://" + stamp + ".example.test/feed"); let fetched = 0;
  const transport = async () => { fetched++; return { body: bytes, url: url.href }; };
  try {
    const service = createFeedService({ transport });
    const results = await Promise.all([service(url, state()), service(url, state())]); assert.equal(fetched, 1); assert.deepEqual(results[0], results[1]);
    const restart = createFeedService({ transport: async () => { throw new Error("Network must not run for a fresh cache hit"); } }); assert.deepEqual(await restart(url, state()), results[0]);
    const expires = Number((await pool.query("SELECT extract(epoch FROM expires_at-fetched_at) AS seconds FROM rss_feed_cache WHERE url=$1", [url.href])).rows[0].seconds); assert.ok(Math.abs(expires - 43200) < 5);
    await pool.query("UPDATE rss_feed_cache SET expires_at=now()-interval '1 second' WHERE url=$1", [url.href]); await service(url, state()); assert.equal(fetched, 2);
    const failedURL = normalizeFeedURL(url.href + "/error"), failed = createFeedService({ transport: async () => { fetched++; throw new FeedError("The feed server returned an error."); } });
    await assert.rejects(failed(failedURL, state()), /server returned/); await assert.rejects(failed(failedURL, state()), /server returned/); assert.equal(fetched, 3);
    assert.ok((await pool.query("SELECT expires_at-fetched_at < interval '61 seconds' AS short FROM rss_feed_cache WHERE url=$1", [failedURL.href])).rows[0].short);
    await pool.query("INSERT INTO rss_feed_cache(cache_key,url,data,bytes,expires_at) SELECT md5($1||g)||md5(g::text),$1||g,'{\"items\":[]}',0,now()+interval '1 hour' FROM generate_series(1,270) g", [url.href + "/bulk/"]);
    await service(normalizeFeedURL(url.href + "/prune"), state()); assert.ok((await pool.query("SELECT count(*)::int AS n FROM rss_feed_cache")).rows[0].n <= 256);
    const large = JSON.stringify({ items: Array.from({ length: 30 }, () => ({ title: "Large", description: "x".repeat(8192), link: "", author: "", date: null })) });
    await pool.query("INSERT INTO rss_feed_cache(cache_key,url,data,bytes,expires_at) SELECT md5($1||g)||md5(g::text),$1||g,$2::jsonb,$3,now()+interval '1 hour' FROM generate_series(1,140) g", [url.href + "/large/", large, Buffer.byteLength(large)]);
    await service(normalizeFeedURL(url.href + "/prune-bytes"), state()); assert.ok(Number((await pool.query("SELECT coalesce(sum(bytes),0) AS bytes FROM rss_feed_cache")).rows[0].bytes) <= 33554432);
    const budget = state(); for (let index = 0; index < 4; index++) await service(normalizeFeedURL(url.href + "/budget/" + index), budget); await assert.rejects(service(normalizeFeedURL(url.href + "/budget/4"), budget), /request limit/);
  } finally { await pool.query("DELETE FROM rss_feed_cache WHERE url LIKE $1", [url.href + "%"]); }
});

test("renderer uses source defaults/grid/options and escapes remote content without interpreting markup", async () => {
  const feed = parseFeedDocument(bytes, "https://feed.example.test/rss"), settings = { ...defaultSettings, timezone: "America/Los_Angeles" }, url = "https://feed.example.test/rss";
  const db = { query: async (sql: string) => ({ rows: sql.includes("FROM settings") ? [{ data: settings }] : [{ data: { items: [...feed.items, ...Array.from({ length: 7 }, (_, index) => ({ ...feed.items[0], title: "Item " + index }))] }, error: "" }] }) } as any;
  assert.ok(SUPPORTED_DYNAMIC_BLOCKS.has("core/rss")); const defaults = dom(await renderSiteDocument({ rawContent: block({ feedURL: url }) }, { db })); assert.equal(defaults.querySelectorAll("li").length, 5); assert.equal(defaults.querySelector("time"), null); assert.equal(defaults.querySelector(".wp-block-rss__item-excerpt"), null);
  const output = await renderSiteDocument({ rawContent: block({ feedURL: url, blockLayout: "grid", columns: 2, itemsToShow: 1, displayAuthor: true, displayDate: true, displayExcerpt: true, excerptLength: 3, openInNewTab: true, rel: 'nofollow \" onclick=\"bad()' }) }, { db });
  const parsed = dom(output); assert.ok(parsed.querySelector("ul.is-grid.columns-2.has-authors.has-dates.has-excerpts")); assert.equal(parsed.querySelector("a")!.getAttribute("target"), "_blank"); assert.equal(parsed.querySelector("[onclick]"), null); assert.equal(parsed.querySelector(".wp-block-rss__item-author")!.textContent, "by Reader Name"); assert.equal(parsed.querySelector(".wp-block-rss__item-excerpt")!.textContent, "one two three […]"); assert.match(parsed.querySelector("time")!.getAttribute("datetime")!, /-08:00$/); assert.doesNotMatch(output, /<img|<script|injected\(\)/);
  assert.equal(parsed.querySelector("a")!.getAttribute("rel"), "nofollow noopener noreferrer");
  const zero = dom(await renderSiteDocument({ rawContent: block({ feedURL: url, displayExcerpt: true, excerptLength: 0 }) }, { db })); assert.equal(zero.querySelector(".wp-block-rss__item-excerpt")!.textContent, " […]");
  const empty = { query: async (sql: string) => ({ rows: sql.includes("FROM settings") ? [{ data: settings }] : [{ data: { items: [] }, error: "" }] }) } as any;
  assert.match(await renderSiteDocument({ rawContent: block({ feedURL: url }) }, { db: empty }), /feed is down/);
  assert.match(await renderSiteDocument({ rawContent: block({ feedURL: "javascript:bad()" }) }, { db }), /RSS Error/);
});

const base = process.env.TEST_API_URL || "http://127.0.0.1:3001", origin = process.env.APP_ORIGIN || "http://127.0.0.1:5173";
test("actual native SSR/public persistence and internal own feeds never recurse, expose protected data or require network", async () => {
  let cookie = ""; const posts: number[] = [], stamp = "rss-api-" + Date.now().toString(36), fixtureURL = "https://" + stamp + ".example.test/feed";
  const api = async (path: string, method = "GET", body?: unknown, auth = cookie) => { const response = await fetch(base + path, { method, headers: { Origin: origin, "Content-Type": "application/json", ...(auth ? { Cookie: auth } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }); return { response, data: await response.json() }; };
  const ok = async (path: string, method = "GET", body?: unknown, auth = cookie) => { const value = await api(path, method, body, auth); assert.ok(value.response.ok, `${path}: ${value.response.status} ${JSON.stringify(value.data)}`); return value; };
  try {
    const login = await ok("/api/auth/login", "POST", { login: process.env.ADMIN_EMAIL, password: process.env.ADMIN_PASSWORD }, ""); cookie = login.response.headers.get("set-cookie")!.split(";")[0];
    const data = parseFeedDocument(bytes, fixtureURL); await pool.query("INSERT INTO rss_feed_cache(cache_key,url,data,bytes,expires_at) VALUES($1,$2,$3,$4,now()+interval '12 hours')", [createHash("sha256").update(fixtureURL).digest("hex"), fixtureURL, JSON.stringify(data), Buffer.byteLength(JSON.stringify(data))]);
    const metadata = (await ok("/wp-json/wp/v2/block-types/core/rss")).data; assert.equal(metadata.attributes.itemsToShow.default, 5); assert.equal(metadata.is_dynamic, true);
    const preview = (await ok("/wp-json/wp/v2/block-renderer/core/rss", "POST", { attributes: { feedURL: fixtureURL, displayAuthor: true, rel: 'nofollow ugc \" onclick=\"bad() javascript:bad()', openInNewTab: true } })).data.rendered; assert.match(preview, /RSS &amp; safe/); assert.match(preview, /by Reader Name/); assert.equal(dom(preview).querySelector("a")!.getAttribute("rel"), "nofollow ugc noopener noreferrer"); assert.equal(dom(preview).querySelector("[onclick]"), null);
    const typed = { feedURL: fixtureURL, itemsToShow: 1, blockLayout: "grid", columns: 3, displayExcerpt: true, excerptLength: 1, displayAuthor: false, displayDate: false, openInNewTab: false };
    const query = new URLSearchParams(); for (const [key, value] of Object.entries(typed)) query.set(`attributes[${key}]`, String(value));
    const getPreview = (await ok("/wp-json/wp/v2/block-renderer/core/rss?" + query)).data.rendered;
    const postPreview = (await ok("/wp-json/wp/v2/block-renderer/core/rss", "POST", { attributes: typed })).data.rendered;
    assert.equal(getPreview, postPreview, "Native bracket-query transport and JSON produce the same preview");
    const typedPreview = dom(getPreview); assert.equal(typedPreview.querySelectorAll("li").length, 1); assert.ok(typedPreview.querySelector("ul.is-grid.columns-3"));
    assert.equal(typedPreview.querySelector(".wp-block-rss__item-excerpt")!.textContent, "one […]");
    assert.equal(typedPreview.querySelector("time, .wp-block-rss__item-author, a[target]"), null, "False query-string booleans remain false");
    assert.equal((await ok("/wp-json/wp/v2/block-renderer/core/rss?attributes=" + encodeURIComponent(JSON.stringify(Object.fromEntries(Object.entries(typed).map(([key, value]) => [key, String(value)])))))).data.rendered, postPreview);
    query.set("attributes[itemsToShow]", "invalid"); assert.equal((await api("/wp-json/wp/v2/block-renderer/core/rss?" + query)).response.status, 400);
    assert.equal((await api("/wp-json/wp/v2/block-renderer/core/rss", "POST", { attributes: { feedURL: fixtureURL } }, "")).response.status, 401);
    const settings = (await ok("/api/settings")).data.settings, localURL = new URL("/feed/", settings.siteUrl).href;
    for (const [title, status, extra] of [["Public", "publish", {}], ["Protected", "publish", { password: "Safe-RSS-password" }], ["Draft", "draft", {}]] as const) {
      const content = '<p>' + stamp + '-' + title + '-teaser</p><!--more--><p>CONFIDENTIAL-' + title + '-after-more</p><!--nextpage--><p>CONFIDENTIAL-' + title + '-page-two</p><!-- wp:rss ' + JSON.stringify({ feedURL: localURL }) + ' /-->';
      const post = (await ok("/api/posts", "POST", { title: stamp + title, status, content, ...extra })).data.post; posts.push(post.id);
    }
    const internal = (await ok("/wp-json/wp/v2/block-renderer/core/rss", "POST", { attributes: { feedURL: localURL, itemsToShow: 100, displayExcerpt: true } })).data.rendered;
    assert.match(internal, new RegExp(stamp + "-Public-teaser")); assert.match(internal, new RegExp("Protected: " + stamp + "Protected")); assert.match(internal, /There is no excerpt because this is a protected post/); assert.doesNotMatch(internal, /CONFIDENTIAL|Draft-teaser|scrypt:|password_hash|rawContent|author_email/);
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM rss_feed_cache WHERE url=$1", [localURL])).rows[0].n, 0);
    const home = (await ok("/wp-json/wp/v2/block-renderer/core/rss", "POST", { attributes: { feedURL: settings.siteUrl + "/#ignored" } })).data.rendered; assert.match(home, /homepage is not supported/);
    const external = (await ok("/api/posts", "POST", { title: stamp + " embedded", status: "publish", content: block({ feedURL: fixtureURL, displayExcerpt: true, rel: "nofollow ugc", openInNewTab: true }) })).data.post; posts.push(external.id);
    const publicResponse = (await ok("/api/public/posts/" + external.slug, "GET", undefined, "")).data.post; assert.match(publicResponse.content, /wp-block-rss/); assert.match(publicResponse.content, /RSS &amp; safe/);
    assert.equal(dom(publicResponse.content).querySelector("a")!.getAttribute("rel"), "nofollow ugc noopener noreferrer");
    const changed = await ok("/api/posts/" + posts[0], "PUT", { password: "New-protection-password" }); assert.ok(changed.data.post.hasPassword);
    const nowLocked = (await ok("/wp-json/wp/v2/block-renderer/core/rss", "POST", { attributes: { feedURL: localURL, displayExcerpt: true, itemsToShow: 100 } })).data.rendered; assert.doesNotMatch(nowLocked, new RegExp(stamp + "-Public-teaser"));
  } finally {
    for (const id of posts) { await api("/api/posts/" + id, "PUT", { status: "trash" }); await api("/api/posts/" + id, "DELETE"); }
    await pool.query("DELETE FROM rss_feed_cache WHERE url=$1", [fixtureURL]); if (cookie) await api("/api/auth/logout", "POST", {});
  }
});
