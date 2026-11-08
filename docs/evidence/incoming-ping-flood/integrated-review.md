# Incoming flood integration review

Runtime origin `ab3b85483322c0a87fbec8231eb8b18634edb341`, author final evidence `ded7f80c15c6cc2c63f7375575c5471c2542bd8a`. Root integrated the unchanged runtime onto the released time/body baseline and promoted an independent lease-wait probe without changing its bytes. Final root guard hash: `fab78f1d31ec895a9d975f5e49860c9485caeb81`. Later documentation does not change runtime or tests.

| Actual root gate | Pass | Conditional skip | Files |
| --- | ---: | ---: | ---: |
| Full guarded source | 850 | 7 | 159 |
| Actual compiled-server CI selector | 717 | 4 | 112 |
| Fresh Plain archive source export | 1 | 0 | 1 |
| Same archive, fresh compiled restore | 1 | 0 | 1 |
| Fresh unseeded compiled installation | 7 | 1 | 1 |

All invocations exited0 with no failures/cancellations. Source and compiled full guards ran sequentially because incoming regression fixtures own a fixed control port. TypeScript and the production client/server build passed. The compiled bundle is byte-identical to the independent reviewer's bundle: SHA256 `350946d241ead9e6fbe3cdd3ab354fab98f1a66974483a7f236dce81f004bdba`. No schema, seed, dependency or UI change is required by this release.

## Independent evidence

The original immutable probe SHA256 `16963dc3d67a835b766cb12b893c89685952df19373e44e217a12af0348a578e` independently reproduced4 passes/20 failures of24 counted results in both before modes at test-only `b7f3164afc9342c7cf8d9e3af8c3a2312f58cabd`. It passes24/24 unchanged after. Counts include the failed parent; these are19 failing leaves, not20 independent defects. Original before logs were preserved.

Fresh independent final checks at ded7 passed130 source/130 compiled-main results across16 files, no skips: original24, production supplement6, legacy18, independent6, related76. The actual production child selects `dist-server/index.js` in compiled mode, proving Trackback receiving, generic rejection and later actual human-IP history. Direct verifier/receiver/filter helper imports remain source in either guard mode; their byte execution is not mislabeled compiled.

The independent probe was promoted verbatim as `tests/incoming-ping-flood-leases.test.ts`, SHA256 `42ba9560dc5d71355ddcacc8062f7c827b348030006774ad34b4d73f925decdf`. It observes actual PostgreSQL lease-row blocking, new timestamp sampling, expiry and a new predecessor during the wait; future blank-email history and a same-source duplicate inserted during held verification are also covered. Normal helper/fixture cleanup restores settings/extensions/secrets and removes owned data. Root's additional full-suite counts are separate from independent130/130.

## Limits and cleanup

Existing receivers remain anonymous even with supplied cookies/Authorization, production-only and public-target scoped. Attempts remain consumed before verification/flood. Known floods stop before Akismet; a predecessor arriving during filtering can only be rejected by final admission. Completed external filter I/O and its existing global connector-health update cannot be undone. The guarantee is no rejected comment, retained per-comment IP/Akismet record or notification mail; it is not zero writes to all tables. Source callback overrides and broader extension parity remain separate work.

Author and independent reviewers verified their owned guard finalizers, absent anchors, removed private environments/links and free listener ports. Safe original probes/failure receipts and full dependency owners remain. Main data preservation and both exact Node22/24 CI jobs are separate root release gates. This is no native visual, performance or whole-CMS equivalence certificate.
