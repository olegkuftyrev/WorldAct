# Selected singular templates with date context

A resolved singular post or page keeps its assigned Source template when a date
parameter is also present. The production change is one condition in
`shared/public-routing.ts`: date candidates require
`context.date && !(context.single && context.post)`. Existing404, search,
category, tag and author priorities, the front/custom/page/single ladder and
ordinary date fallback remain unchanged. Server documents and the legacy
public helper share that selector. No authored UI or CSS changed.

The [contract](../../../server/source-template-priority.md) explains the source
inference and limits. Supplied WordPress query parsing classifies a selected
name/p/page identity before archive/date flags, with assigned templates leading
its page/single hierarchy. Raw date SQL predicates are a separate matter:
pretty requests can retain them, while ordinary `page_id` replaces the earlier
WHERE with ID selection. Tests use the matching civil year for pretty PAGE/POST
requests. The mismatching-year Plain-ID case exercises an existing WorldAct200
acquisition alias, without claiming upstream canonical redirect/status parity.

## Original and corrected before stages

Original test-only `22397ecc`, fixture SHA256
`09245817309e6e3ed98fada2592557b9194bc1aa2e00bf38a6c959766d2b105f`,
stopped at a fixture setup assumption: the seeded Source theme had no `date`
template. Both modes reported zero passes/one parent failure, with no policy
children or public dispatches. This is not the product regression certificate.
The initial wrong native-esbuild launcher failure also remains separate.

Root read the exact test-only `cb185dbb` adapter, eight additions/two removals:
create `date`/`404` through the actual tracked document API only if absent,
verify saved slugs and reread inventory. Existing documents are not overwritten;
all acquisition and policy assertion bytes remain unchanged. The corrected
fixture SHA256 is
`f15f083451c0890f9ecd1c77f2a6c0826ff1ee02847e8cbd5507eb0f9757cb07`.
It is distinct from the retained original.

That corrected fixture genuinely ran against released5ab/b801 in both modes:
one pass/five failures of six, with zero setup/transport errors or skips. Four
semantic children and their parent failed; the archive/404 child passed.
Matching-year PAGE/POST, the Plain-ID variant and the actual body-page2 counter
variant retained200 and their immutable singular identity but selected `date`
instead of the assigned custom template. Only the selected slug and native/model
custom-marker assertions failed. All eleven GET/HEAD/document groups,33 actual
requests per mode, completed before aggregate assertions. Actual body-page links
were used without fabricated fallbacks. See the
[corrected before report](independent-corrected-before-review.md).

## Frozen implementation and checks

Runtime freeze `2a06562b60fc67a22694b1ca42c1f2fb9f050c15` composes the already
released Search base `bf4204a`. The relevant selector/consumer fingerprints match
the earlier before baseline; this is not a claim that both entire Node bundles
are identical. The sole runtime difference from the immediate Search base is
the condition above. No query normalization, SQL, status, metadata/DTO, await,
grant observation or final policy fence changed.

Backend and independent reviewers each ran the unchanged corrected regression
first, followed by five unchanged affected files. Each measured36 passes in
source mode and36 under the actual compiled API guard, zero failures/skips.
Per-file counts were6,7,15,1,1,6. Both reviewed the same exact freeze and built
Node SHA256
`cbc6c17115bcc4d2529aa296460a0c460b200ea7a11033314f99bb756aec4cb7`;
root's independent integration build matches it.

The eleven actual request groups now preserve custom templates and selected
bodies/counters, while populated date archives and missing-page404 retain their
existing template priority. The other30 controls cover assignments, Plain body
and loop/comment paging, date aliases/path authority, named/numeric legacy
priorities and unavailable/protected static fronts. Direct TypeScript services,
React and pure helper imports remain SOURCE in both guard modes; only the stated
HTTP effects exercise the compiled API. Native HTML includes bootstrap data,
so these checks do not independently certify visible-browser body or pixels.
See the [backend report](backend-report.md),
[independent review](independent-review.md) and
[source audit](independent-source-audit.md).

All eight captured backend/independent databases and owned sessions are absent;
owned ports/configuration/dependency links are cleaned up. Uploads have normal
runner-finally cleanup, with no invented per-path inventory. Both original
fixtures, setup failures, genuine before logs and the411-file original b801 build
archive remain retained privately. No site archive or extra full/fresh/fixed/native
run was needed for this conditional change.

## Release and remaining scope

Released as `49caf8906acbe92ad2ace84818391b6e3f079d47` after a fresh
restore-verified backup, preservation of all39 tables/every field and uploads,
production build, restart and read-only smoke. No migration or reseed occurred.
[Exact-head CI](https://github.com/olegkuftyrev/WorldAct/actions/runs/42640964478)
passed both Node22 and Node24 jobs. Each actually completed230 source files
(1363pass/13skip),183 compiled-selector files (1230pass/10skip), and the unseeded
installation check (7pass/1skip), with no failures or cancellations. Node24 also
completed all29 existing fresh-archive phases without failure, cancellation or
skip. Both raw logs and parsed phase counters were independently retained and
verified. The root integration's own dependency symlink was then removed; all
failure evidence, original builds and verified backups remain retained.

Raw date/query/archive metadata and authored Query Title eligibility remain
separate continuations, as do broader mixed-query classification, SQL date
intersection and canonical redirects. The fix does not globally ignore year or
claim whole-CMS equivalence.
