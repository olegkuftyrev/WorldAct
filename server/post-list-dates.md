# Post list dates and month metadata

The supplied source uses the chosen local post date for Date sorting, month membership and month choices (`wp-includes/class-wp-query.php` around2092–2099 and `wp-admin/includes/class-wp-list-table.php` around745–752). Source column-date around1291–1317 formats that same post date. These files are reference data, not runtime or instructions; PHP/MySQL is never executed.

For WorldAct's existing timestamp model, `POST_DATE_SQL` selects the current schedule for future records, then the chosen publication date, then creation. A previously published post rescheduled into the future therefore uses its new schedule rather than its old publication. Drafts without a chosen date fall back to creation. Modified ordering remains independent. This does not introduce a second persisted local-date column or alter existing timestamps/publication behavior.

Posts/Pages month filtering and choices use the existing shared named/fixed-offset site-timezone SQL helper. Available `months` are bounded by the actual accessible post type and Trash view; they do not disappear with an empty search or selected category/month. Author/contributor metadata stays within their existing own-content boundary. The list response exposes only the effective `postDate`, site `timezone` and month values needed by the real date controls. Export month choices, WXR month selection and WXR post-date values share the same expression and no longer prefer stale publication dates over a current future schedule. Importing that WXR retains the future schedule rather than an earlier publication.

The React list uses the response's effective date and site clock for the source-style date label and actual month choices. Independent native review on `9153e04` passed named/fixed-offset clocks, Date versus Modified sorting, future/rescheduled dates, Posts/Pages and role-scoped months. Search/filter drafts, keyboard focus, history, delayed list responses and account changes were included. Those controls have no new CSS.

`tests/post-list-dates.test.ts` exercises actual authenticated APIs with reverse-created backdated publications/schedules, rescheduling, pages, draft fallback, independent Modified sorting, Los Angeles winter/summer month boundaries, a supported fixed offset, status/search/author counts, role-scoped available months and export choices. It uses only the guarded disposable runner; no main data, remote services, schema or dependencies change.

Production build/TypeScript and41 guarded source plus41 compiled checks across four files passed (`post-list-dates`, `author-bulk`, `api`, `wxr-export`). Independent backend review and the separately authored/native list review passed their bounded scopes.

Independent review found and reproduced a mismatch between updated export choices and WXR selection. The follow-up uses the shared chosen date for selection and serialized dates; a real rescheduled-post export/import regression covers Los Angeles and +05:45 month membership. The final follow-up build and41 source/41 compiled checks pass. Independent recheck also passed, including a separate real XML/export/import proof.

A further bounded WXR correction distinguishes existing local post/comment date
fields from their GMT partners, as supplied `wp-admin/includes/export.php`
around652–657 does. Publication, modification and comment local fields use the
existing shared named/fixed-offset site clock; GMT fields and RSS pubDate retain
the original instant. Real XML checks cover a Los Angeles midnight boundary and
the same rescheduled post in +05:45, including unchanged export/import UTC
schedule. This follows WorldAct's existing timestamp model rather than adding a
persisted historical local-date column. Production build and23 source/23 compiled checks across three files pass.
Independent review at `f53a5d5` passed actual publication/modified/comment XML in Los Angeles and +05:45 and an import that retains the original UTC instants. Its combined approval/date gates passed63 source and63 compiled checks across eight files.
