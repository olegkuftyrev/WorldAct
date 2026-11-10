# Missing or empty QueryTitle type: bounded backend evidence

The production change adds one early condition in `server/block-renderer.ts`: missing (`undefined`) or exact empty-string QueryTitle type returns an empty string before the existing archive context, label queries and wrapper. No broader falsy test, type allowlist, normalization, default, query predicate, trusted context, label format, UI or authority change is included.

Runtime: `1fcc2cbe3bdb25d60331ec657c923bea6b685489`. Separate fixture adapter: `7a891113fbf5e96ee1c135e4d4b7b83001d2fdcf`. Node SHA-256: `582d1aa48ee69058e08be6406b86d604cf92010cf0e36a9e180e997b920da07b`.

The root-audited historical before belongs to a different owner on released HOME `d7c9`/Node `7f5e`: each mode had 6 counted tests, 2 passes and 4 expected semantic failures, with all 9 responses consumed and no fixture adapter or setup failure. The new regression from `8e97` retains exact test SHA `5b2406b78a9395fe252cdf3e318150babc9550da319e1b4cf5787c8cfcf44856`. This backend did not rerun or relabel that before stage.

Five archive fixture attributes were added separately across three existing test files: one in blocks, three in date archives and one in author identity. Every assertion and wait/instrumentation remains unchanged. Original fixture bytes and hashes are retained privately; these adapters preserve the old heading purposes while the new immutable regression tests omission and empty type.

The exact 10-file selector passed **52 tests in SOURCE mode and 52 against the actual compiled API**, with zero failures, skips or cancellations. Per-file counts are `[6,2,7,6,4,4,4,9,4,6]`. Four recorded proof groups consumed **61 targeted responses per mode**: 9 missing-type, 23 selected-singular, 13 posts-page and 16 HOME-body responses. Direct TypeScript normalization/service/renderer imports remain SOURCE in compiled-API mode. Build checks passed TypeScript, Vite SSR with runner loader and native esbuild. No reruns, whole-suite, fresh-archive, fixed-port, browser or release-CI claim is made.

The five payloads are exact copies of private originals with only the manifest's literal known path-prefix substitutions. Original/published hashes, byte counts, occurrence ledger, frozen source/test inputs, run-receipt hashes and raw-log hashes permit correspondence checks. Raw HTTP/bootstrap proofs, raw logs, credentials, configurations and archives are not published here.

`resource-audit.json` and the resource section of `checks.json` preserve the historical review-time retained environment/link state. The later `owned-cleanup.json` records their authorized removal after exact creation-time configuration hash, owner/mode, link target and shared dependency owner/lock checks. Owned databases, never-created anchor and phase sessions are absent; ports 3046–3048 are free; no archive was created. Standard runner finally cleanup completed, but exact upload paths were not journaled, so no independent per-upload-path absence claim is made. Builds, originals, before proofs and raw logs remain retained privately.

See [review](review.md), [checks](checks.json), [historical resource audit](resource-audit.json), [owned cleanup](owned-cleanup.json), [build checks](build-checks.json), and [manifest](manifest.json).
