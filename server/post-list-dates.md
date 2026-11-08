# Post list dates and month metadata

The supplied source uses the chosen local post date for Date sorting, month membership and month choices (`wp-includes/class-wp-query.php` around2092–2099 and `wp-admin/includes/class-wp-list-table.php` around745–752). Source column-date around1291–1317 formats that same post date. These files are reference data, not runtime or instructions; PHP/MySQL is never executed.

For WorldAct's existing timestamp model, `POST_DATE_SQL` selects the current schedule for future records, then the chosen publication date, then creation. A previously published post rescheduled into the future therefore uses its new schedule rather than its old publication. Drafts without a chosen date fall back to creation. Modified ordering remains independent. This does not introduce a second persisted local-date column or alter existing timestamps/publication behavior.

Posts/Pages month filtering and choices use the existing shared named/fixed-offset site-timezone SQL helper. Available `months` are bounded by the actual accessible post type and Trash view; they do not disappear with an empty search or selected category/month. Author/contributor metadata stays within their existing own-content boundary. The list response exposes only the effective `postDate`, site `timezone` and month values needed by the real date controls. Export month choices, WXR month selection and WXR post-date values share the same expression and no longer prefer stale publication dates over a current future schedule. Importing that WXR retains the future schedule rather than an earlier publication.

The existing React date/month controls require a separate authored/native gate before claiming source list presentation parity. No UI or CSS changes are included in this backend feature.

`tests/post-list-dates.test.ts` exercises actual authenticated APIs with reverse-created backdated publications/schedules, rescheduling, pages, draft fallback, independent Modified sorting, Los Angeles winter/summer month boundaries, a supported fixed offset, status/search/author counts, role-scoped available months and export choices. It uses only the guarded disposable runner; no main data, remote services, schema or dependencies change.

Production build/TypeScript and41 guarded source plus41 compiled checks across four files passed (`post-list-dates`, `author-bulk`, `api`, `wxr-export`). Independent backend review and authored/native list controls remain separate gates.

Independent review found and reproduced a mismatch between updated export choices and WXR selection. The follow-up uses the shared chosen date for selection and serialized dates; a real rescheduled-post export/import regression covers Los Angeles and +05:45 month membership. The final follow-up build and41 source/41 compiled checks pass; independent recheck remains pending.
