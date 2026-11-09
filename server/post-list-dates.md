# Post list dates and month metadata

Posts/Pages DTOs expose canonical stored `postDate` civil text and nullable selected `postDateGmt`. Date/month membership and available month choices use that stored calendar independently of later timezone changes. Date ordering retains the existing UTC effective publication/schedule expression; Modified ordering remains independent. Search/category filters do not erase month choices; accessible author/type/Trash boundaries remain enforced.

The React list formats civil fields using the site zone, while missed-schedule detection uses the actual `scheduledAt` UTC instant. Export options, WXR month selection and serialized local publication dates share the stored civil value; GMT and existing UTC schedule remain separate. See the [complete civil-date contract](post-civil-dates.md) for write rules, migration/deployment, portability and remaining source-order/status gaps.

`tests/post-list-dates.test.ts` deliberately covers stored-civil stability after a Los Angeles→fixed-offset zone change, backdating/rescheduling, fixed draft fixtures, role/Trash scope, independent instant/Modified order, available months and actual WXR export/import. Raw fixture timestamp changes explicitly supply civil metadata when they intend to change that chosen calendar.

## Earlier instant-model validation

The following records describe earlier bounded stages before persisted civil dates were added; their counts and timezone-shifting behavior are historical evidence, not certification of the current package.

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
