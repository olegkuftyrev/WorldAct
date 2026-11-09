# Explicit archive Query Title on selected singular presentations

Selected posts and pages now omit an authored `core/query-title` block with
`type: "archive"`, including its wrapper. The supplied WordPress renderer returns
an empty string before wrapper generation when that explicit type is ineligible
on a singular request. Ordinary archive titles inside Query Loops and their post
bodies remain visible.

## Runtime and trusted context

Runtime `eba54f98188fe6752ad37380bd6e4cb7b18b82bc` changes five server files,
12 insertions and five deletions. Its actual Node bundle SHA256 is
`300199e4aebe00b526fee49af14904d50cacd20333b07c99c2ded6ba3ddf7070`.
Author, independent and root integration builds match after TypeScript, Vite's
runner loader and direct native esbuild completed successfully. No UI, CSS,
shared routing, schema or dependency change belongs to this runtime fix.

The strict predicate consults server-owned `selectedSingular`, before label
parsing, queries or wrapper generation. Document acquisition uses its held route
and final presentation additionally requires the actual body after404 handling.
The standalone body reader preserves an explicit false override; the direct
template endpoint uses only its successfully loaded root post. Generic site
sanitation never invents this context. Loop posts, parts and Post Content keep
the root presentation context.

Compat path resolution supplies the internal `resolved-path` sentinel. The
existing settings read normalizes it to false for an active configured posts
page and true for another selected body. The normalized property follows the
options spread. Explicit booleans stay unchanged. No SQL, await, path relookup,
authority, visibility policy, observer or final identity/password fence is
added. This is the existing settings moment, not an atomic snapshot of every
earlier route decision. See the [server contract](../../../server/query-title-selection.md).

## Preserved before evidence

The original test-only `a057812` / test hash `892f3ef9…` made23 source-mode reads
but counted0/6 because manually saved Group HTML lacked literal container IDs.
This was fixture-invalid, and its compiled version was never executed. The
approved `f5aa855` adapter adds only two IDs matching existing block anchors;
all assertions and other content stay unchanged. The corrected fixture hash is
`fa7f74eaab2edf81507422dc96015f823ee5a1de41e2a2f4bc9d902385966724`.

On historical date candidate `2a06562` / bundle `cbc6c171…`, that immutable
corrected fixture produced1pass/5fail in each source and actual compiled mode.
All23 responses were200 with empty HEAD bodies and correct selected identities,
markers and custom templates. Four singular-heading children plus their parent
failed only anchor/wrapper absence; the real archive outer/loop/body positive
passed. Neither history is relabeled as a measurement of the later49caf release.
[Before evidence](native-before-review/README.md) keeps the invalid original,
two-line correction, genuine failure and later owned-resource cleanup distinct.

## Final affected gates

Backend head `6ef21775` and independent head `887d8bb7` have the same production
runtime and complete test tree. Each passed47 checks in source mode and47 with
the actual compiled HTTP server, with no failures, cancellations or skips.
Nine files ran in the frozen order, with actual counts
`[6,4,9,4,7,1,6,4,6]`.

The corrected original runs first and consumes23 GET/HEAD/model/template/body
responses. The separate companion hash
`454a4bdce36dcf096e53fb670cde36a18220d05474505dd61a3dc492bf008820`
runs second and consumes13 responses. It protects configured posts-page path
and full-model body presentation, another selected page, and standalone body
acquisition of the configured page. Native/model posts-page presentation keeps
the chosen listing template; it need not display that page's body. These
positive controls preserve current non-singular behavior rather than certify
WordPress archive eligibility on a posts page.

Seven unchanged files contribute37 controls for renderer attributes/caller DBs,
budgets, dates, public bodies, Plain pagination, front-page availability,
author/count/password waits and singular/date template precedence. Direct
TypeScript imports remain source in both modes; actual HTTP calls in the
compiled mode reach the compiled API. Front-page coverage is in the existing
front-page fixture, not the new corrected singular fixture.

Root independently verified all four raw47-count logs, completion markers,
artifact hashes and all36 actual response bodies per mode. Rendered native
islands, model fragments and direct body fragments were parsed separately from
inert bootstrap JSON. Root also rehashed the independent352 source files,
nine fixtures and411 built files against their before/after fingerprints.
[Backend evidence](backend-README.md) and
[independent evidence](independent-README.md) preserve the scope and original
receipts. No browser, screenshot, full-suite, fresh-archive or benchmark result
is inferred from these affected gates.

## Tooling history and resources

The first backend source metadata receipt incorrectly summarized zero totals
because its regex lost an escape. The original receipt and wrapper remain
retained; the corrected metadata derives47 from the same immutable successful
raw log. No regression rerun or product edit was needed. An independent
inter-mode raw socket checker also reported address-in-use; that auxiliary
error is retained and is not called a passing recheck. Its cause is not proven.
The separately authorized compiled runner completed, and subsequent listener
and final cleanup checks passed.

Root independently confirmed all four journaled databases, two never-created
anchors and four application-session groups absent, no listeners on the six
owned ports, and removal of only the four owned config/link paths. Shared
dependencies retain their original owner/mode/lock hash. Upload cleanup is
limited to normal runner-finally completion because exact random paths were
not journaled. No archive was created; all original failures, builds and
verified backups remain retained.

## Release and remaining scope

Released as `0f7dd2f3d55a72a3b2b498a152a10332ef066c68` after a fresh
restore-verified backup, preservation of all39 tables/every field and uploads,
production build, restart and read-only smoke. No migration or reseed occurred.
[Exact-head CI](https://github.com/olegkuftyrev/WorldAct/actions/runs/42648565722)
passed both Node22 and Node24 jobs. Each actually completed232 source files
(1373pass/13skip),185 compiled-selector files (1240pass/10skip), and the unseeded
installation check (7pass/1skip), without failures or cancellations. Node24
completed all29 existing fresh-archive phases without failure, cancellation or
skip. Both raw logs and parsed phase counters were retained and independently
verified. Only the root integration's own dependency symlink was then removed;
failure evidence, original builds and verified backups remain retained.

This fix concerns explicit archive type on selected singular presentations.
Home/search/404 eligibility, omitted/other types, post-type labels, complete
query conditionals, raw date SQL/intersection and canonical redirects remain
separate work. Whole-WordPress behavior, pixel equivalence and performance are
not certified by this bounded change.
