# Explicit Search query fields

Saved `core/search` query attributes now produce ordered hidden controls alongside
the visible `s` input. The action remains the site root and the method remains
native GET. An omitted query remains a global search; ambient request filters
are not inherited. This transports explicit values into existing public query
handling rather than implementing arbitrary WP_Query features.

## Source contract and implementation

The [contract](../../../server/search-query-fields.md) separates supplied
WordPress source behavior from project decisions and measured HTTP/browser
behavior. The helper accepts own enumerable JSON data fields, handles the stated
primitive/array coercions and performs the source-composed HTML401/numeric
reference escaping. Static comparison found the exact 252 named references:
the supplied 253-name KSES inventory minus `apos`, with no extras or duplicates.
It does not use recursive decoding or an HTML5 entity substitution table.
Arbitrary PHP floating-point spelling, invalid-byte/UTF-16 equivalence and
general save/preview sanitizer parity remain outside this bounded contract.

The backend runtime change is confined to `server/search-query-fields.ts` and
the Search branch of `server/theme-blocks.ts`. A shared count/emission transducer
preflights the complete escaped form against the remaining cumulative 8MiB
block-output budget before expanding hidden fields. Existing rendering remains
the sole budget charge. No database query, await, routing authority, generic
sanitizer, DTO or public-read fence was added or changed. Code inspection
supports the allocation bound; HTTP413 by itself would not establish it.

Browser testing then measured a separate client exception: saved fields named
`closest`, `matches` or `getAttribute` shadow form instance methods. All three
native requests already reached the correct URL with HTTP200, but the delegated
submit listener threw a TypeError. UI-only commit `9928f5d` replaces four method
lookups with `Element.prototype` calls using the same form receiver. The public
island guards, selectors, default-prevention positions and native Search
fallthrough remain unchanged. The
[independent UI source review](independent-ui-source-review.md) records that
scope; no failed navigation or privacy leak is relabeled from these exceptions.

## Preserved before and corrected fixture stages

The original test-only `ba1d421` fixture, SHA256
`b4a35c21bd472077f787e2c2a99f8ad90e40262d019b1fb5a962c37e346cf594`,
failed all six counted tests in both source and compiled modes against the old
renderer, without setup failures and with all 29 dispatch groups recorded.
The first backend candidate then passed one and failed five per mode.

Root review identified two fixture assumptions: JSONB canonical key ordering
and an oversized surrounding page published before the single-form resource
acquisition. The narrowly reviewed test-only `f89eb1d` adapter uses actual saved
key order with strict membership/count checks and unchanged manual values, and
captures the single request before publishing the repeated page. It does not
sort/drop fields, derive expected values from rendered controls, change statuses
or weaken entity/privacy assertions. The corrected fixture SHA256 is
`42352ea7c91847d2046220b8090dcf11a39616dc2efffb1b89cfcc001642b75c`.
It was rerun against the unchanged old renderer and again failed all six tests
in each mode before running against the implementation. Original and corrected
fixtures, failures, logs and original build archives remain distinct and retained.

## Backend checks

At exact backend commit `5a819ef`, the corrected six-test Search file passed in
both modes, including actual HTTP to the compiled API. All 29 groups were
observed: raw/JSON saves, explicit intersections and counters, default-global
controls, literal/property-looking names, coercions/entities, duplicate-scalar
400s, excessive-page404s, privacy and preview controls, and the single 60KiB
field200 followed by repeated-form controlled413 and empty HEAD.

Five existing affected files contributed another 25 passing checks per mode.
Both backend owner and independent reviewer therefore measured 31 passes in
each mode, zero failures/skips/cancellations. Direct renderer, normalizer and
binding imports still execute source in both modes; only the stated HTTP cases
exercise the compiled service. These historical certificates are not relabeled
as whole-project or post-UI browser certificates. The independent production
build and root integration build both produce Node SHA256
`af2177df906780e5c6f65554a1181d606cd337789d3cfa9d9bb8d87ffaf5fc33`.

See the [backend evidence](../search-explicit-query/backend-stage.md),
[independent review](independent-review.md) and
[independent checks](independent-checks.json) for exact inputs and scopes.

## Native browser checks and release

Final native review at UI commit `9928f5d`, using the new client asset and the
unchanged Node bundle above, passed the frozen 48-submission selector. Each
theme exercised all eleven controls with JavaScript at1440px and genuine
pre-navigation script disabling at375px; ordinary Enter submissions also ran
with JavaScript at375/768px. The 28 real button and20 real Enter submissions
each produced exactly one document GET:40 successful200s and eight expected
duplicate-s400s, with zero flushed page errors. Eight real empty-required-input
clicks produced no navigation. Method-name controls still shadow as objects;
empty names are omitted on the wire and `_charset_` submits UTF-8. JavaScript
retains the original form node; script-disabled scenes make no model request.

Two narrow existing-interaction smokes additionally passed: a delegated Source
password form made one unlock POST200 and revealed the protected body; a
delegated Classic opaque-body comment form made one POST201 and saved exactly
one pending comment with visible feedback. No new accounts, synthetic submits,
flood bypass or broader private-race certificate was introduced.

All original stages remain separate: the first unflushed CDP measurement is
not no-error acceptance; the repaired partial nine-row run stopped on raw empty
`name` attribute versus logical input-name measurement; the next partial
24-row run stopped when an ambient year selected a surrounding Source date
template. Narrow harness adapters preserve the raw attribute separately and
remove only the starting URL's year, retaining main/query counters and an
unknown ambient marker. They change no fixture/product field or submission
expectation. Original errors, HTML, partial receipts and build files remain
preserved. Singular/date template priority is a separate continuation.

The owner individually viewed35 final images and three original-before images;
all57 preserved paths were rehashed, with the remaining19 byte-identical to
viewed images. Six separately labeled read-only GET/scroll captures show mobile
Classic controls/results below the fixture's long navigation. Root checked all
48 selector/wire rows, both smokes, all image hashes, all24 original build files
and eight critical images. No horizontal overflow was measured; pixel parity
or cross-browser equivalence is not claimed.

The once-seeded browser fixture's exact database/uploads, owned services,
configuration, secret fixture records and two dependency links are removed.
Root verified exact database/filesystem absence and all owned ports free;
shared dependency owners remain unchanged. Backend and independent guard
cleanup remain separately scoped, including their stated unenumerated upload
path limitation. See the [native review](../search-explicit-query/native-review/review.md)
for original/copy evidence and exact stage provenance.

Before release, a new backup of current MAIN was restored and all39 tables and
uploads matched. No schema migration or reseed belongs to this package. Final
production build, all-field preservation before restart, read-only smoke and
exact released-head CI remain release gates. CI registers the new regression
once:229 source files and182 compiled-selector files; the existing29 fresh
archive phases remain unchanged. These are expected selector inventories, not
yet a claim of final remote results or whole-CMS completion at that checkpoint.

### Completed Search release

Released head `bf4204aa1ade5eb604f34909846039ffb3f1e9af` subsequently passed
[exact-head run42635099125](https://github.com/olegkuftyrev/WorldAct/actions/runs/42635099125).
Both Node22/24 jobs and the overall run succeeded. Each actual source selector
completed229 files/1357 passes/13 conditional skips; each compiled selector
completed182 files/1224 passes/ten skips. Installation passed seven checks with
one conditional skip. Node24 completed all29 fresh phases without failure,
cancellation or skip; Node22 did not run those conditional phases.

The new restore-verified current-site backup, all39-table/all-field preservation
before restart, production build and read-only GET/HEAD/model smoke checks all
passed. No migration or reseed ran. Root's own dependency link was removed only
after exact CI success; root created no environment, fixture database or site
export for this package. Backups and all original failure/build evidence remain
preserved. This completes the bounded Search release gates above.
