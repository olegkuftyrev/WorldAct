# Known body-page archive remapping

Author checks for code `82a61dc9764bd42bb4f7d9dc36cda4dff8d3e4df`, based on frozen
time-token draft `7eb8cc2d9d84598ff5b0e31b9ce742b0b7010cf2`. This is a separate
isolated draft. Independent review, SSR integration, and release gates are pending.
The earlier token draft and its original failed probes/archives remain preserved.

## Results

| Check | Result |
| --- | --- |
| Typecheck and production browser/server builds | PASS |
| Focused source: 15 files | 109 pass, 0 fail, 0 skip |
| Same 15 files with compiled API | 109 pass, 0 fail, 0 skip |
| Expanded fresh source archive export | 1 pass |
| Expanded fresh source restore | 1 pass |
| Expanded fresh compiled restore | 1 pass |
| Unchanged original probe: fresh source export/source restore/compiled restore | 1 pass per phase |
| Unchanged original probe: reuse exact preserved failing archive on source/compiled restores | 1 pass per runtime |

The original baseline source and compiled restore probes failed, **0 pass / 1 fail
each**. Those failure logs are not overwritten or relabeled. The after checks use
the byte-identical original test; the direct retained-archive comparison also
verifies that the original archive bytes stay unchanged.

The new remapper only uses explicit published post/page body metadata from the
current import instance. Its copied source page count bounds a single literal
numeric suffix. Exact canonical mappings across the mixed map win first, so a
known real numeric child wins over a parent's same body-page spelling. Ordinary
term/media links still remap, while their numeric lookalikes do not acquire
singular eligibility. The existing whole-URL scanner remains unchanged.

Permanent fresh-archive assertions cover:

- New destination post/child IDs; Plain, slashless Numeric, and restored source
  time-token settings; actual selected body content and canonical page links.
- Independent query/hash counters, absolute menu origins, complete numeric child
  identity and that child's own second body page.
- Positive ordinary term/media canonical remaps, actual copied media filenames,
  and unchanged term/media numeric lookalikes.
- Private/protected imports remaining unavailable publicly; preserved inert
  escaped markers/text.
- A duplicate primary-menu error after body mappings/rows/files are staged:
  exact existing post content, settings, row counts, and upload files survive
  rollback, then a new import uses its own fresh IDs successfully.

Direct boundary tests also cover unsorted exact mappings, alternate child slash
guards, source-origin/path boundaries, malformed/oversized/unexported page
suffixes, one-pass mapping, Plain fixed-ID prefixes and independent query joining,
and raw/JSON URL references.

## Scope

No UI/CSS, HTTP status, resolver publication/type/fixed-ID/password policy,
PHP/MySQL, benchmark, main data, or dependency install was changed. The only
production changes are `server/block-portability.ts` and the explicit eligibility
metadata in `server/site-portability.ts`. See the
[body-page contract](../../../server/body-page-portability.md).

If an omitted source child shares a valid parent body-page spelling, the archive
cannot prove which original entity that link resolved to. Known imported child
identities win; **no complete ambiguity guarantee is claimed for absent source
identities**, and those indistinguishable links are not described as provably
untouched. Root/static-front aliases, source records without exported canonicals,
nonpublic/draft imports, and source-Plain-to-Pretty body conversion remain outside
the new suffix metadata contract.

All checks used guarded disposable databases/uploads/outboxes and loopback ports.
Source fixture files/databases were removed by guard finalizers before fresh
restore phases. No browser or persistent service was needed. Temporary probe
copies and the checkout environment were removed after checks; private archives
and safe failure/pass evidence remain retained for review.
