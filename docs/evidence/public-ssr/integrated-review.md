# Integrated public-document review

Reviewed runtime: `207a1fac28546285bb8322718567222c701e6335`.
Final regression fixture: `f2d7c94b4f1a1d4ce5b575bf6fbf68b7698b32ef`, changing only a required fixture email. Later evidence/documentation commits do not change runtime. This review is scoped to public documents, with no whole-CMS, exhaustive pixel-equivalence or performance claim.

## Root gates at final f2

| Actual gate | Passed | Conditional skips | Files |
| --- | ---: | ---: | ---: |
| Full guarded source | 789 | 6 | 154 |
| Actual compiled-server CI selector | 656 | 3 | 107 |
| Fresh Plain archive source export | 1 | 0 | 1 |
| Same archive, fresh compiled restore | 1 | 0 | 1 |
| Fresh unseeded compiled installation | 7 | 1 | 1 |

All invocations exited0 with no failures/cancellations. TypeScript and the production client/server builds passed. No schema migration, reseed or benchmark is required by this release. Matching Node22/24 remote CI remains a release gate and is recorded separately after push.

## Independent acceptance

The independent backend reviewer reproduced the original native continuation failure on exact226 using an immutable actual-HTTP PostgreSQL probe:32 cases,1 pass/31 fail per server mode (including two failed parent containers). The identical probe passes32/32 on runtime207 source and compiled. It is now the permanent CI-selected `tests/native-continuation.test.ts`. Four separately corrected boundary checks and nine related files passed at207; the two affected native/SSR files were rebuilt/rerun at final f2 (6/6 each mode). No backend finding remains in this scope. These split-version checks are not represented as a single fresh f2 invocation. The original mistaken null-versus-zero add-on assertion and the missing-email fixture failure remain preserved in the private review logs.

The independent native reviewer accepted final f2 with identical207 runtime. Own seven-file guards passed48 source/48 compiled, no skips. Across exact recorded stages, actual checks covered all four themes at1440/768/375; original-node hydration; one POST/history operation; held original HTML across account/publication/password changes; pending stylesheet masking; actual missing JS+CSS recovery with keyboard retry; model errors; stale draft/mutation ownership; and pagehide masking of explicitly visible navigation descendants.47 screenshots were directly inspected. Final genuine-script-disabled checks covered8 deep Replies,6 password returns,2 new roots and2 tampered return targets, plus actual source LoginOut/search and2 normal-JavaScript smoke rows. Saved rows, visible anchors, correct parent/account and independent body/query/comment counters were observed on the actual compiled Node server.

## Preserved failures and limits

The original3678 blank-viewport asset recovery failure,746 low-contrast Classic paging labels and226 native303 context loss were preserved; each received a scoped correction and actual rerun. Earlier functional screenshots do not certify the corrected Classic labels. The [frontend author record](README.md) maps its separate evidence to exact hashes and retains those failures. Author final guards passed42 source/42 compiled over7 files with no skips, and13 final no-JavaScript return screenshots were inspected; these are separate from the independent counts.

Actual full-document Back/Forward and pagehide/fresh-model policy passed. The browser reported `pageshow.persisted:false`; Page.backForwardCacheNotUsed named MainResourceHasCacheControlNoStore, JsNetworkRequestReceivedCacheControlNoStoreResource and BrowsingInstanceNotSwapped. **Genuine BFCache admission/restoration is not certified.** No cache-policy workaround or synthetic event is claimed as a substitute.

Every JavaScript-enabled initial public root, including anonymous openings, waits for one fresh owned model before exposure; this adds a validation request before first paint. True no-JavaScript requests receive authorized request-time HTML and native public forms. Delivered bytes are not retroactively revocable. Standalone React login/admin/editor remain JavaScript shells. Per-fragment8MiB and complete-document64MiB limits remain in force. External delivery was not exercised.

Both author and independent reviewers verified removal of their owned databases/uploads/private environments/fixture accounts/browser credentials/listeners. Lock-matching dependency owners and safe evidence remain. Main data preservation and exact remote CI are root release checks, separate from this pre-release acceptance.
