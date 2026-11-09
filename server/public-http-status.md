# Public document HTTP status and server rendering

The production Node server renders published public documents into the existing
built React index using a safe request-scoped model and the narrow shared public
view. Classic and the three bundled source themes have their actual content,
navigation, native forms and theme styling in the HTML response before JavaScript
runs. Browser controller integration and independent native hydration/history
acceptance are separate gates; server rendering alone does not certify them.
Vite development fallback status remains independent of production Node routing.

`public-documents.ts` retains metadata-only identity classification through the
shared permalink resolver, including Plain fixed IDs, selected static fronts,
hierarchical pages, numeric children and body-page aliases. It preserves actual
`/posts/:slug` and `/pages/:slug` aliases independently of permalink settings.
The selected immutable identity is rechecked by metadata; the subsequent body
read independently requires that same ID, type and current publish status.
Removing a body column leaves the direct metadata helper valid, while actual
full HTML correctly fails through the generic500 handler. It must not return a
successful empty shell when rendering fails.

Ordinary home/search/filter/archive paging stays200 even with empty results.
Selected static fronts require their actual public page; a stale private/missing
selection yields404. Invalid fixed IDs never become home. Category/tag archives
require existing terms, including empty terms; date directories require a
published record in the existing site-local civil-date bounds. Root date queries
retain `month`/`monthnum`/compact aliases and reject malformed or conflicting
values. Date paths remain authoritative over unrelated date query values.
Body, inherited Query Loop and comment paging retain independent counters;
body-page clamping remains the existing contract. Pretty author directories use
the configured static permalink front and persisted nicename. Existing accounts
may have an empty first page200; unknown authors and empty/excessive pretty
archive pages404. Numeric aliases retain their earlier empty/excessive200 policy.
See [author archive boundaries](pretty-author-archives.md) for namespace priority,
source query normalization and request identity validation.
Public paths stay bounded to2,000 characters before decoding/hierarchical work.

Framework routes retain their client authorization and framework bootstrap.
A genuinely unseeded migrated installation uses that bootstrap so the existing
installer can run; readiness is read-only and uses the existing durable markers.
No GET migrates/seeds or treats a database failure as successful installation
readiness. Legacy redirects, JSON APIs, static/uploads, feeds, robots, sitemaps
and notification handlers precede the HTML fallback as before.

HTML reads cookie sessions only. Valid or invalid Basic headers neither
authenticate the document nor update application-password usage. Public password
access requires the current matching request cookie grant, including for an
administrator. Locked body/excerpt/comments/footnotes never enter model, nested
render output or head. The model excludes administrative settings, raw blocks,
pending counts, account/comment email, hashes and session/grant credentials.
Remembered comment-author details remain a private browser request.

All documents keep `Cache-Control: no-cache, must-revalidate, max-age=0, no-store,
private` and `Expires: Wed, 11 Jan 1984 05:00:00 GMT`. Neither Last-Modified nor
ETag is emitted for assembled HTML. GET/HEAD and conditional requests retain
actual current-policy200/404 status; a conditional request cannot turn a newly
private body into304 reuse. Direct/encoded index.html openings use the same
classifier/private policy. Static JS/CSS/fonts and uploads keep their own cache
policies. HEAD has the equivalent headers and no body.

Production X-Pingback retains the published/open/unprotected singular policy,
computed from the final selected identity; ordinary root filters/paging,
archives and selected posts listings do not gain it. Local environments never
advertise receipt. No external notification service is contacted during reads.

The complete view, safe head and inert escaped JSON bootstrap are assembled
before response headers are committed. Existing renderer4,000-node/8MiB and
complete-comment-window budgets remain unchanged. The assembled document has a
64MiB bound counting compiler index, React markup, head and escaped JSON,
including escape expansion. Overflow is explicit413 without partial success;
genuine data/render errors preserve generic500. Missing built index retains its
specific Build the React application404 error. See public-document-ssr.md for
module, lifecycle and serialization boundaries.

`tests/public-http-status.test.ts` checks actual rendered model/presentation
instead of equality with an empty index, retaining prior identity/header/static/
framework/feed/missing-build tests. Its body-column fixture now separately tests
the body-free helper and actual SSR500. `tests/public-document-ssr.test.ts` proves
persisted content/native forms across all four themes, real generated-parent
POST, protected grants/current cookie-only identity, header/conditional/HEAD
behavior, hostile head/script/style/iframe/bootstrap boundaries and413 behavior.
Use `scripts/test-isolated.mjs` after production build for source and compiled
Node tests. Fresh compiled `tests/install.test.ts` with
ISOLATED_TEST_UNSEEDED=true covers uninstalled HTML/install readiness.

The earlier pre-SSR native history gate passed exactfc8e33e and later reviewed
source/Classic stages, including initially anonymous SPA login. That historical
proof is preserved; the new initial server bodies require a new independent
native held-HTML/account/grant/publication/BFCache/hydration gate before release.
PHP/MySQL are not used by this implementation.
