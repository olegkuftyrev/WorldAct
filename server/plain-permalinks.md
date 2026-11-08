# Plain query-ID permalinks

An empty `permalinkStructure` selects source Plain links: `/?p=ID` for a post and
`/?page_id=ID` for a page. A selected static front page keeps `/`. The source
Numeric form `/archives/%post_id%` also works without adding a trailing slash.
Its hierarchical page and singular content-page links follow that non-trailing
policy as well; slash aliases remain resolvable.
Existing configured structures are retained; this change performs no data or
configuration migration.

`resolvePublicPath` recognizes only one positive, bounded fixed identity at the
root path, with an optional positive `page` for singular content pagination.
Duplicate/mixed/array-shaped/oversized identities and invalid page values fail
closed. The shared query helper lets the React root adapter distinguish ordinary
home requests from invalid identities rather than silently showing home. Plain
ID aliases can resolve a public post after pretty links are enabled; canonical
links continue to use the configured structure. Redirects are separate behavior.

Resolution selects only the requested post/page type in published state. It then
uses the existing public endpoint, password token, comment and renderer paths.
No private/draft/future bodies become public through an ID. Source content-page
links use `&page=N`; previews retain the existing private preview routes. Static
front-page pagination uses `/?page=N` in Plain mode, `/page/N` in Numeric mode,
and `/page/N/` for a trailing-slash structure. Root `?page=N` resolves a selected
published static front page with its body-page context; ordinary posts-home
pagination remains a different client request. Static front and posts-page
presentation must also be verified in the matching React UI.

The public resolver verifies the immutable requested ID after its internal public
slug handoff. A rename/deletion and reuse of that slug cannot return another post
for a fixed-ID request; the handoff fails closed instead.

Outgoing notification URLs use the same canonical generator. Incoming target
resolution and the production document X-Pingback lookup include the query string;
final incoming canonical comparison still rejects unrelated query parameters.
Tests use controlled internal transports, never real remote traffic.

Site archive URL mapping accepts only fixed numeric Plain identity links in
addition to existing safe path links. Imported post IDs are remapped across raw
HTML/JSON/entities and legacy menus. Complete-URL boundary matching prevents a
source ID prefix from changing a different ID, a source-looking query inside a
foreign host from being rewritten, or a new destination from being mapped again.
Menu links now share this single-application mapping behavior with block content.

The backend batch includes actual settings/public/password/pagination/API,
notification worker and fresh-ID archive regressions. Settings controls and root
React routing are a required separate UI integration. Additional author/time
tokens, broader query compatibility and canonical redirects remain outside it.
Plain taxonomy/date archive URL spelling remains part of that broader query
compatibility work; existing functional archive routes are retained.
