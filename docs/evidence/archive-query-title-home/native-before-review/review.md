# Explicit archive QueryTitle on ordinary posts home — genuine BEFORE

**Bounded defect reproduced in SOURCE and ACTUAL COMPILED HTTP API modes.** Each mode consumed all6 anonymous GET/HEAD/model responses before aggregate assertions and counted3tests:1pass,2fail,0cancelled,0skipped. The ordinary unfiltered posts-home child fails, plus its parent. The real populated date-archive child passes.

No runtime/UI repair is implemented or authorized by this record. This is the next home eligibility investigation, separate from the accepted selected-singular title scope. Candidate attribution is exact `eba54f98188fe6752ad37380bd6e4cb7b18b82bc`, NOT a MAIN release certificate.

## Frozen test and independent build

Own physical worktree `<owned-home-before-worktree>`, branch `codex/archive-query-title-home-before`; test-only commit `f8a4d89f2bf221c09e765ef0c55a1170ee49f98d` adds only `tests/archive-query-title-home-before.test.ts` (179lines). Frozen/private-original/current test SHA256 is `af82c59144a210e3d9d6e3d070b88a3f9d8cc97631b5d35ff786154f9354a9cc`; no expectation or fixture adapter followed construction. Selector SHA256 `cecc70e5557a4f9e0b2ba3ca9e13b1126dc317f450f80a16e5d4c163a1a8be20` is unchanged. Construction freeze `5771fd8f4a338b67fbfc007a45bdd323b02d9d2a51eee254dd5b71e1b9a0daf4` remains a historical UNEXECUTED snapshot.

Independent own TSC, Vite `--configLoader runner`, and direct native darwin-arm64 esbuild all exited0. The own actual Node bundle matches expected `300199e4aebe00b526fee49af14904d50cacd20333b07c99c2ded6ba3ddf7070`. Built index/assets belong to this worktree; shared build output was not reused or overwritten. The earlier CBC build, correctedfa7 test, old private report/checks and immutable source comparison34b remain hash-unchanged.

Both guards used exactly `node scripts/test-isolated.mjs tests/archive-query-title-home-before.test.ts`, source5195 first and actualcompiled5195 second. Source explicitly sets `ISOLATED_TEST_COMPILED=false`; compiled sets true, so the latter's real HTTP API is `dist-server/index.js`. Tests themselves import TypeScript through the standard runner, not claimed compiled test bytes. No direct --test or fake isolation environment was used.

## Actual controls and observed failure

API setup selects TT25, UTC, posts front, /%postname%/. Existing home/date templates are snapshotted and version-restored, or missing documents are API-created/tracked/deleted. Both saved templates contain matching literal main IDs and comment anchors, independent marker paragraphs and one explicit `type:"archive"` QueryTitle unique anchor. Saved IDs/slugs/raw archive attributes and one public POST's exact civil2001-02-03T04:05:37/actual returned permalink are setup-validated. No QueryLoop, inner PostTitle, embedded body QueryTitle, or extra matrix was added.

Actual anonymous observations per mode:

* `/`: GET200, HEAD200 with empty body, `/api/public/document?path=%2F`200; model route.kind home; exact saved home template ID10/slug home; current independent home marker and literal container present. Both native presentation and separately parsed model presentation contain ONE actual `h1.wp-block-query-title` labeled `Blog`, retaining the explicit home title anchor. WordPress requires no element/wrapper here.
* `/?year=2001`: actual GET/HEAD/model200, HEAD empty, route.kind archive with actual date identity/year2001, exact saved date template ID215/slug date; independent date marker/container present; owned published post ID4 populates the actual date listing. Both rendered surfaces retain ONE explicit archive QueryTitle element/wrapper labeled `Year: 2001` and this positive child passes.

All6 responses are consumed before either semantic child. Native assertions select only `.wp-site-blocks[data-worldact-public-island="true"]` then the actual anchored main; model.presentation.html is separately parsed as markup. Bootstrap JSON is never treated as DOM. Exactly FOUR individual failed assertions per mode concern native/model home archive anchor absence and wrapper absence (actual1,expected0). Every HTTP/status/template identity/marker/container/positive-date check passes. There are no setup, transport, JSON parse, harness or missing-container errors.

The source expectation is direct: supplied `wp-includes/blocks/query-title.php:21-33` returns an empty string before wrapper construction for explicit archive type when is_archive is false. Ordinary posts home has that false archive conditional (`class-wp-query.php:502-526,1051-1054`). Current WorldAct `block-renderer.ts:881-932` suppresses archive title only for selectedSingular true; unfiltered home is not selected singular, leaving the generic Blog label and wrapper. No global SQL/rawflags/canonical/body-selection change follows from this finding.

## Preserved private records

All records below are under `<private-evidence-root>/`, created exclusively0600; no originals were overwritten. Public raw proof shape is `{testBaseline,dispatches,fixture,groups[2]}`, each group carrying actual path and `{status,text,data,error?}` native GET/HEAD/model replies. Public fixture metadata is ID/slug/civil date/permalink. Setup/auth responses, cookies, passwords, DB URLs and config bytes are excluded. The full anonymous bootstrap-bearing responses remain PRIVATE, not a Git evidence package.

| Artifact | Filename | SHA256 |
| --- | --- | --- |
| source proof | `archive-query-title-home-before-source-proof.json` | `a9431ae7198f3e70acacad0ea416fec9a6487abbf8f0583db51c377ed29b7828` |
| source log | `archive-query-title-home-before-source.log` | `d20baa16a40e3ae565425962b8fd67fc345a22505dd71d459f9285100733e4e1` |
| source run | `archive-query-title-home-before-source-run.json` | `d501cd44c242b0b4e5a487598384939ac892416c81c6cf8441b1a940243346ec` |
| source preflight | `archive-query-title-home-before-source-preflight.json` | `bac8a7d674a2e246fad707f7d07519a528748c4cb6741794c0c37fb135dd9a91` |
| compiled proof | `archive-query-title-home-before-compiled-proof.json` | `c5471dcdc916c8c889ea0e1bbea964d1747554adf9d7f893c1eb73aaf93d810b` |
| compiled log | `archive-query-title-home-before-compiled.log` | `91b1d9e1c0d9e8c544900309cdf56e4b4b6450d84def4f010704bdbe7e151d0a` |
| compiled run | `archive-query-title-home-before-compiled-run.json` | `9e7cabfae398bf988cc8d25edec7b8046fb9323b7061f4118c80a90f962c0b1e` |
| compiled preflight | `archive-query-title-home-before-compiled-preflight.json` | `4c680a66384c0d95208b2697ca3efa29b92e64085cf85165984f747610ab97b2` |

Combined machine checks and small actual presentation fragments: `archive-query-title-home-before-checks.json`, SHA256 `5b54091b9b44cd9585dafacb66983abc1d43a196b7bb80d967ee01767db35ef1`.

Separate initial-preflight and build JSONs retain owner/lock/config and build attribution. Preflight checks are in the same gated launch path: an exception prevents spawning the runner; no failed auxiliary check can fall through to execution. Both recorded preflightPassed true.

## Exact owned cleanup and retained state

Before BOTH modes: own regular config UID501/mode0600 and exact originally constructed minimal bytes; own symlink to real MAIN dependency owner `<dependency-owner-workspace>/node_modules`; real owner nonsymlink UID501/mode0755; both lockfiles SHA `233888ed8f864581a8835aab0b4c33ccd7fbc391f2a98650b63fcf8db8814892`; exact300199 Node/af82 test; no listener5195; never-created anchor `worldact_archive_title_home_before_anchor` absent. No broad chmod, installation or shared-cache write occurred.

Normal runner finally completed with exact post-exit observations:

* Source disposable DB `worldact_test_1794239620337_585ead3f` absent; PGAPPNAME `worldact-archive-title-home-before-source-f8a` sessions0.
* Compiled disposable DB `worldact_test_1794239678745_575afdcc` absent; PGAPPNAME `worldact-archive-title-home-before-compiled-f8a` sessions0.
* Anchor absent after both phases. API fixture cleanup reports no failure: owned post/date document deleted, existing home document restored, settings restored and setup session logged out. Observer pools closed.5195 is free after both; no API remains active.

Exact upload paths were NOT journaled; claim normal runner-finally removal only, not independently verified guessed per-path absence. No backup/export/build archive was created. No persistent fixture, proxy, browser, vault, screenshot, other ports, full/fresh/fixed suites or external service was used.

Per ROOT instruction, own0600 `.env`, readonly dependency symlink and own build outputs are RETAINED pending review. No further cleanup or runtime implementation is inferred. MAIN/user tabs/data/config, other owners, current selected-singular release evidence, oldCBC/fa7 proofs and immutable34b source comparison were not changed.
