# Public named-author query contract

WorldAct resolves public `author_name` through the persisted `users.nicename`. It does not derive identity from login/display names, import accounts, rename users, redirect numeric aliases, or add author feeds. Supplied WordPress PHP is source reference data; no PHP or MySQL runs here.

## Input, identity and status

Query parsing decodes once. Exactly empty `author_name` is absent; a nonempty value that normalizes empty is unknown. With slashes, select the last component unless it is exactly empty or literal `0`, then select the immediate previous component once. A slash-free `0` stays `0`. Reuse the existing ASCII query slug normalizer, including its doubled-hyphen quirk. No raw-slug-first shortcut, Unicode accent folding or account-save normalization is applied. The persisted nicename and ordinary generated author links remain unchanged.

Duplicate/nested/array recognized values, controls, backslashes, malformed escapes and out-of-range numeric authors are rejected before flattening at the established public pipeline. Encoded recognized keys have the same meaning as their decoded spelling. The full visible request path remains bounded; direct templates reject an overlong path rather than truncate it into another identity. Visible `requestPath` and explicit transport filters/counters must agree.

A positive numeric `author` and named author are independent intersected predicates. The selected presentation identity is the named account; a contradictory numeric filter yields no posts. Main counts, main rows and inherited Query Loops always retain both predicates. A block author override may narrow the result but cannot erase either request predicate. Custom non-inherited loops retain their own filters and may show their configured public posts on an otherwise empty listing.

An existing empty named account has first-page200 and empty/excessive page>1 404. Unknown alone is404. Unknown with nonempty trimmed search or a genuinely matched taxonomy object permits safe-empty first-page200, with an explicit no-match predicate and no invented author object. Empty/whitespace search does not grant this exception: supplied source uses `isset(s)`, but this bounded package deliberately retains WorldAct's nonempty search behavior. A selected configured posts-page also retains its existing first-page listing, including an empty result; excessive named pages are404.

Framework, explicit Plain identities and legacy singular routes keep their selected identity and ignore a valid name as a listing selector. Existing malformed/known404 pipeline behavior remains. Reserved unknown pretty routes remain404. Pretty author identity conflicts are400; a name cannot replace the path's actual account. Taxonomy/date/posts-page kind and archive identity remain selected while name is an additional filter. No broader arbitrary WP_Query precedence is claimed. `page`, `query-N-page` and `commentPage` remain independent; no `paged` alias is added.

## Shared presentation and server context

`NamedAuthorSelection` uses shared types only: `selected` is the author archive shape without `page`, or null; optional `numericAuthor` is the original numeric predicate. Optional `PublicQuery.namedAuthor` distinguishes absence from a resolved no-match. `query.author` may be the named presentation ID, but `query.values.author` and `.author_name` retain original validated visible spelling. Never use the presentation ID as a replacement SQL constraint.

`/api/public/resolve` returns `{archive,namedAuthor}` for a named listing. An unknown safe-empty result is exactly `{archive:null,namedAuthor:{selected:null,...}}`. Only an already resolved configured posts-page adds `kind:'posts-page'`; clients use their existing `site.postsPage` DTO. It reads no body solely to create that metadata. Fixed singular responses keep their existing post shape. Site/template reads still validate the full visible input independently.

`PublicListingContext` is server-only and passes resolved kind/archive/selection through site and renderer calls. No request field, serialized block attribute, saved document or client descriptor is deserialized as that authority. Source/Classic template choice, Query Title, breadcrumbs and avatar fallback use the retained listing identity. Navigation keeps the visible name/numeric/search/filter/counter spelling rather than converting a name query into a generated pretty route.

## Attempts and caller transactions

The owner closure pins the first actual ID plus persisted slug, or the unknown null selection, through the complete pending read and retries. A deleted/recreated account cannot replace it; an account created during an unknown request is visible only to a new request. Empty accounts are observed too. Public renderer entry points register their server-supplied selection before static/empty returns. Nested rendering shares the existing collector.

All author/count/render expressions finish before the existing final author validation and then the current post/publication/password-token statement. Nothing moves an author await after that grant fence. Metadata identity checks use the supplied DB and bounded NOWAIT rejection; explicit read-only repeatable snapshots intentionally retain their historical identity. Writable caller clients see their own uncommitted rows. No new broad transaction, settings lock, global-pool escape or claim of all-metadata atomicity is introduced.

No schema, raw-import/seed, scheduling, publication clock, ordering, modification-date or media policy changes are part of this package. JSON archive tests deliberately remap imported posts to the destination actor and query its destination nicename; accounts are not imported. Independent held-count, later-template, caller-renderer, unknown-creation/retry and final-token tests retain their explicit source-service versus actual HTTP scope. Broader CMS parity and exact pixel matching remain unestablished.
