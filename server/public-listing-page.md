# Ordinary listing page availability

WorldAct's existing `page=N` main counter returns 404 when an eligible ordinary
listing requests a page beyond its matching rows. This applies to the home
listing, search, numeric-author filters, taxonomy/date archives and the configured
posts page, including a Plain `page_id` posts page. The count uses the same
normalized publish/post, author, taxonomy, civil-date and title/content/excerpt
predicate as the main row query. Anonymous protected-search exclusions remain.

The gate runs only for a normalized main page greater than one. Existing empty
first-page behavior, pretty-author archive counting and named-author rules retain
their own contracts. Singular/fixed/static-front bodies, previews and templates
with a selected post ID keep their content-page policy. Independent Query Loop
and comment counters never choose the main listing's status.

A rejected listing carries a server-only not-found context into safe surroundings.
Main and inherited queries remain empty; independently configured custom loops
retain their existing queries. No client or saved block field grants listing
authority. Resource-bearing `/resolve` responses retain their existing shapes;
ordinary root/search/numeric `/resolve` remains 404.

New counts use the explicitly supplied database client. Separate count and row
statements do not promise one atomic metadata snapshot. Initial canonical post
and pretty-author identities are retained through later lookups and complete
read retries. All added work precedes the existing final author/post/password
checks; this package adds no statement after the final grant decision.

This is a bounded compatibility rule. It does not add `paged` aliases, redirects,
author feeds, broader first-page rules or arbitrary WP_Query compatibility. See
the [integrated evidence](../docs/evidence/public-listing-pagination/integrated-review.md)
for exact tests, preserved failures, native checks and limits.
