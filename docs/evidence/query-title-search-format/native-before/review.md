# Search QueryTitle formatting: genuine BEFORE

Both SOURCE and actual COMPILED modes reproduced the same formatting defects: **6 counted tests, 1 pass, 5 fail**, with no cancelled/skipped tests. The four formatting children fail, together with the parent; the raw-URL-`s` preview compatibility control passes. This is a genuine failure record, not a release acceptance result.

Frozen candidate baseline: `f6f4dcda7ff0f8b7ef08ae43f7dac3422e510a07`; new test-only commit: `92920c53964fe1573bb4aef98b943eb6420c14a1`. Test SHA256: `169be75223968724229540836b78237b1735923e78283fc6a6f881c23ee1b385`; renderer: `6002a966d9a69b2dc1805f1144957c87ee9e036304d313cef87426672e5fc95c`; actual independently built Node bundle: `582d1aa48ee69058e08be6406b86d604cf92010cf0e36a9e180e997b920da07b`. Worktree: `<owned-search-format-before-worktree>`.

The build-only stage passed TSC, Vite `--configLoader runner`, and DIRECT native esbuild on the first attempt. All411 output hashes were frozen and rechecked before each guard and afterward. No binary-as-Node invocation error, count-parser correction, adapter or retry occurred in this stage. Prior missing-type test5b240 and its old4117f5e outputs remain unchanged.

The official command was `node scripts/test-isolated.mjs tests/query-title-search-format-original.test.ts`, sequentially on5195 in source mode then `ISOLATED_TEST_COMPILED=true`. Observed API process commands were `--import tsx server/index.ts` and `dist-server/index.js`, respectively.

| Mode | Counted/pass/fail | Actual responses | DOM title observations | Exact-text failures |
| --- | --- | --- | --- | --- |
| SOURCE | 6 / 1 / 5 | 12 | 22 | 21 |
| ACTUAL COMPILED | 6 / 1 / 5 | 12 | 22 | 21 |

Every response was consumed before feature assertions. Each mode acquired two anonymous public GET/HEAD/model groups plus six authenticated renderer POST controls. All12 statuses were200 and both HEAD bodies empty. Native Source islands and presentation fragments were parsed separately from bootstrap data. Actual search template14/slug`search`/type`template`/version2, literal main/case IDs, independent markers, normalized search terms and safe wrapper structures were valid. Setup rereads verified raw attributes: default absence, booleantrue/false, and showPrefixfalse. The preview string`false` exercises existing metadata normalization. Ordinary owned post4 populated the ordinary search; entity search is permitted to have no matches.

| Case | Observed current behavior | Supplied-source expectation |
| --- | --- | --- |
| Omitted/default and explicittrue showSearchTerm | Unquoted `Search results for: <term>` | `Search results for: “<term>”` |
| showSearchTermfalse | Includes prefix and term | Exactly `Search results` |
| showPrefixfalse | Removes the prefix | Keeps the full quoted search label |
| Literal entity term | Visible `A&amp;B &#00065;` spelling retained | Visible `A&B A`, with the full quoted label |
| Auth renderer URL `?s=<token>` | Exactly `Blog` | Preserved compatibility control: PASS |

All feature failures were exact-text differences. H1 tag, anchor, wrapper count/class and no active child markup remained valid. Authenticated preview proof stores only label/status/rendered output, not raw setup/auth responses. These are API controls, not client editor UI or browser interaction coverage.

Disposable phase resources closed normally. Anchor `worldact_query_title_search_format_before_anchor` and actual databases `worldact_test_1794298851348_e270d1f7` / `worldact_test_1794298905414_e631d811` were absent in the final audit; all owned-prefix sessions and observed OS process identities were absent;5195 had no listener. Fixture cleanup reported postIds[4], restoredDocumentId14, settings restoration attempted, and no failures in each mode. Exact upload/outbox paths were not journaled: only standard runner-finally cleanup is claimed for them, with no independent per-path absence claim. No archive was created.

Own `.env` remains UID501/mode0600 with contemporaneous original SHA256 `d15b469029368c1780595723c94430c3b823f90e707ab55baa07b410131d4571`; no URL application-name override was added. Own dependency symlink still targets readonly MAIN dependencies, real owner UID501/mode0755/nonsymlink, matching lock233888. All411 build files remain intact. These resources are deliberately retained pending root review and separate cleanup authorization. No further tests or resource changes followed the completed runs.

Construction/build/execution attribution remains candidatef6f4/929. Root explicitly authorized this immutable isolated BEFORE while missing172 exactCI42780547646 was pending. Historical CI status is not rewritten, and no next-production-release/CI-green claim is made here. Runtime, UI, existing test expectations, CI and MAIN were unchanged. Formatting eligibility, aliases/path-only quirks, level0, registry, generic esc/sanitizer behavior and broad/full/fresh/fixed3062 suites remain outside scope. Any later5b240 unquoted-positive expectation adapter is a separate root-reviewed step after this genuine BEFORE record.

Detailed observations and exact process/resource journals remain in the immutable DOM audit and run receipts. The checks file below indexes every construction, build, execution, log, proof and audit hash without duplicating full journals.

Checks: `<private-evidence-root>/query-title-search-format-before-checks.json`; SHA256 `c59e443a645fc132473f93068b557540a1aff9995a293110f1b7383b5b473203`.

- `<private-evidence-root>/query-title-search-format-before-build-only.json` — `7844204aafed4a258ccb1c0ecf25d10c461c2a02aba30db3af3095daa594e6be`
- `<private-evidence-root>/query-title-search-format-before-build-only-manifest.json` — `54aae04bdb14a74836436469a556d0120d4299fffcb062cc8e0a79bb57f3a4c9`
- `<private-evidence-root>/query-title-search-format-before-ownership.json` — `267964ed52d1d9d2801977e525c809d405e7f0f218b831ad2168b70c9d733a61`
- `<private-evidence-root>/query-title-search-format-before-source-run.json` — `e3d884a113936cbb6153a48fb5b3b393235916ea696c6d07f52660d911756962`
- `<private-evidence-root>/query-title-search-format-before-source.log` — `351612b60eb7d6d7480bb4b26134fbe3d57afc7fb472ceda8e3cfd9533e3ac77`
- `<private-evidence-root>/query-title-search-format-before-source-proof.json` — `7ac3238ce46094a3e8c6e8c4b4905ebc77037d38457deb51dad15edf88f70a47`
- `<private-evidence-root>/query-title-search-format-before-compiled-run.json` — `c2259c691c66a5ec6313ffe083a3216896a6d2c4f52d4b2888601151d8465073`
- `<private-evidence-root>/query-title-search-format-before-compiled.log` — `36dba89fdde508c9a4984ff4dd3403eec04c27aa9c43251d403458f251c170f9`
- `<private-evidence-root>/query-title-search-format-before-compiled-proof.json` — `cc3c442dddadc6fdbed3e01d44d5bb8b7336ead7d4e562177126e7a1b91d5fb8`
- `<private-evidence-root>/query-title-search-format-before-dom-audit.json` — `1c1e54d51f6e1f5f2fedee6376a7b0ee497e2f444a0b79772f9cf4aa87316edb`
