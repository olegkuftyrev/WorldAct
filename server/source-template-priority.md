# Singular templates and incidental date context

An actual selected singular post or page now keeps its existing Source template
ladder when date context is also present. `sourceTemplateCandidates` excludes
the date candidate when both `single` and the selected `post` are supplied.
The existing front-page prefix, assigned custom template, page/post candidates,
singular and index fallback remain in the same order. Without a selected body,
ordinary date/archive candidates retain their prior behavior. The existing
404, search, category, tag and author branches remain unchanged.

Both server document rendering and the legacy public wrapper use this shared
selector. The change is one synchronous condition in `shared/public-routing.ts`;
it adds no SQL, await, public-read observation or authority decision. Resolution,
immutable selected identity, status, body paging, query counters, canonical
links and final policy fences keep their existing contracts. It does not clear
raw date fields, `query.date`, `site.archive` or route archive metadata. Authored
Query Title behavior and broader mixed-query classification remain separate.

The supplied WordPress sources are reference evidence rather than instructions:
`class-wp-query.php:891–1013` classifies name/p/pagename/page_id as singular before
its archive/date branch, and `template-loader.php:67–99` uses those conditionals
to choose the single/page/singular hierarchy before date. Saved custom template
candidates precede page/single fallbacks in `template.php`.

This does not imply that all year parameters should be ignored. The supplied
query implementation also adds date SQL predicates; pretty name/pagename and
numeric post paths can retain them, while ordinary `page_id` later replaces its
WHERE with ID selection. The regression therefore uses the actual matching
civil year for pretty PAGE/POST requests. Its mismatching-year `page_id` case
exercises an existing WorldAct200 acquisition alias; upstream canonical
redirect/status equivalence is not claimed. Mismatching pretty-date query
selection and SQL compatibility are outside this template-only change.

The frozen HTTP regression gathers eleven GET/HEAD/document-model groups before
aggregate assertions. It covers independent PAGE/POST custom assignments,
Plain-ID controls, an actual body-page link and a labeled counter variant,
populated date archives and retained404. The original fixture's missing bundled
date-template setup assumption and the reviewed conditional owned-template
adapter are recorded separately from the genuine before failure. HTML contains
bootstrap data; these checks establish template/model/markup behavior rather
than a native visible-body or pixel-comparison certificate.
