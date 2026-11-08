# Public React document HTTP status

The production Node server serves the existing React `index.html` with status
404 when a public document identity is missing. Published posts and pages,
including password-protected records, keep status 200. This does not add server
rendering or a no-JavaScript content response. Vite development fallback status
is independent of this production Node behavior.

`public-documents.ts` classifies metadata through the shared permalink resolver,
including Plain fixed IDs, the selected static front page, hierarchical pages
and the existing content-page aliases. It also preserves the actual React
`/posts/:slug` and `/pages/:slug` routes independently of permalink settings.
Status does not depend on stored content, block data or a full-content internal
HTTP request. Body-page clamping remains the existing API contract.

Ordinary root home/search/filter/paging requests remain 200, including an empty
site or empty results. Selected static-front body paging still requires that
actual public page, even when a stale selection becomes private or disappears.
Invalid fixed IDs never become a home response. Framework
routes mirror `src/App.tsx` and keep their existing client authentication and
authorization; update that inventory when adding framework routes. The existing
legacy redirects, JSON API fallbacks, static/upload handlers, feeds, robots,
sitemaps and fixed incoming notification handlers run before document fallback.

`public-path.ts` shares archive identity between `/api/public/resolve` and Node:
existing category/tag terms are valid even when empty; a date directory requires
a published post within the existing site-local date bounds. It adds no author
directory route. Public path input is bounded to 2,000 characters before decoding
and hierarchical queries, with bounded malformed URI errors. Accepted category
canonicals retain all their ancestors within that bound.

The existing production pingback policy still requires a published, open,
unprotected post/page. Ordinary root filters/paging, archives and the configured
posts listing do not acquire a singular `X-Pingback` header. Local environments
never advertise receipt. No external notification service is contacted to choose
a document status or header.

Only a missing built index produces the existing “Build the React application”
error. Database/classification failures propagate to the ordinary generic 500
handler instead of being mislabeled as missing builds.

The supplied WordPress `wp-includes/class-wp.php::handle_404` (approximately
724–804), the actual React route inventory, existing archive helpers and reviewed
Plain permalink backend are reference inputs. PHP is not executed.

Validation uses the disposable local runner after a production build:

```sh
npm run build
ISOLATED_TEST_PORT=3021 node scripts/test-isolated.mjs tests/public-http-status.test.ts tests/plain-permalinks.test.ts tests/category-permalinks.test.ts tests/date-archives.test.ts tests/incoming-pings.test.ts tests/template-access.test.ts tests/legacy-routes.test.ts tests/server-startup.test.ts
ISOLATED_TEST_PORT=3021 ISOLATED_TEST_COMPILED=true node scripts/test-isolated.mjs tests/public-http-status.test.ts tests/plain-permalinks.test.ts tests/category-permalinks.test.ts tests/date-archives.test.ts tests/incoming-pings.test.ts tests/template-access.test.ts tests/legacy-routes.test.ts tests/server-startup.test.ts
```

The status tests compare real HTTP bodies with the actual built React index,
exercise HEAD and loopback production-header policy on source/compiled app
imports, temporarily make the body column unavailable to prove metadata-only
status, and separately test a missing index and an unavailable database relation.
All fixtures, databases, files and child listeners are owned by the isolated run;
mail uses its local outbox and imported production-policy apps start no workers.
