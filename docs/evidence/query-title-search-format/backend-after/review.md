# Explicit search QueryTitle formatting — backend AFTER review

The bounded formatting change passed both complete affected gates on the first execution: **68 passed, 0 failed, 0 skipped and 0 cancelled per mode**, across the same14 whole files. Source API used3046, followed by the actual frozen Node bundle on3047. Each mode completed all14 file summaries and the official runner completion line. No gate was rerun.

## Frozen implementation

Baseline: `172ce9326962fedd84884cf85d20005f1260cefe`. Immutable formatting regression original commit `92920c53964fe1573bb4aef98b943eb6420c14a1`, SHA `169be75223968724229540836b78237b1735923e78283fc6a6f881c23ee1b385`, remains unchanged. Runtime commit `24e1c37096c3ac2e33054e9b45c1870af8a7a35f` adds32 lines in exactly two existing server files. Final test head `a591eeea2def952cc80aeb593ca1af7c4a27bd3b`, tree `0079c008893eb6820baa1da34c4ebcb0aecf2bac`.

- Renderer SHA: `b8598357bdf4581537e9a49d4965f29c24091962340c943272eb8cad8b1a8d5e`.
- Search helper SHA: `ed93e2fc0fd95be7747cb8eeff61f3747baa06aa2d28183ea7ba908df6074bec`.
- Actual Node bundle SHA: `0773317bac6ebfb42323a6a5fef346ed1602e2d3e9d64841a94fae27c737aee2`.

Only exact type `search` plus the existing truthy final `State.options.query.search` enters the new formatter, after unchanged date-query validation and existing missing/empty/archive guards. Omitted showSearchTerm locally means true. Default/true headings are `Search results for: “<term>”`; valid false produces exactly `Search results` without serializing the term. Search ignores showPrefix. Current h1–h6 selection, attributes/classes/styles/anchor and all other fallback paths remain unchanged.

The string-only helper reuses the existing HTML401/numeric token walker. The hidden-field caller and all existing helper bytes outside the new export remain byte-identical. The caller reserves actual UTF8 bytes of its complete heading wrapper, prefix and numeric curly-quote markup. The helper counts the entire escaped term before chunked emission, rejects negative allowance even for an empty term, and does not mutate render state. Normal render remains the sole own-node output charge. Generic escaping and sanitization are unchanged.

## Historical failure and intentional expectation adapter

The genuine frozen BEFORE used baseline `f6f4dcda7ff0f8b7ef08ae43f7dac3422e510a07` and actual Node582d. It measured6 counted tests:1 pass and5 fail in each API mode. All12 targeted responses per mode were acquired; the raw-s `Blog` compatibility child passed. Four formatting children and their parent failed. Those original proofs, logs, test and411 baseline outputs remain intact; current audit rehashed all411 outputs.

Commit `2d765a4cc307200a441a5e0cea0e2149cd85afc2` is an **intentional expectation adapter**, not a fixture correction. The original existing missing-type test SHA5b240 is preserved privately and in the old BEFORE tree. Only its search-positive expected DOM-text expression changes to the quoted token; a child title and descriptive check label now describe that label accurately. This affects two source lines and one assertion expression. Inputs, metadata/default absence, IDs, wrappers, waits, cleanup and every other assertion remain unchanged. Current adapted SHA is `ec6e6351d2477ff6927fb45318cbf734b54ff4595c5a2e40b04b47656166de8f`.

The old missing-type artifact helper is unchanged. A separate root-created quoted-search AFTER helper verifies the new ec6 proof without rewriting historical5b interpretation.

## Measured gates and actual proof scope

Per-file counted tests, in frozen order: `[6,3,6,2,7,6,4,4,4,9,4,6,6,1]` =68. The complete selector and every file SHA/scope are in checks.json. New guarded helper tests contribute3 source tests; they cover complete UTF8 reserve equality/one byte less, invalid/nonfinite/negative empty-term budgets, and bounded leading-zero/entity boundaries. These are not a performance or memory-allocation certificate.

| Mode | Passed | Failed / skipped / cancelled | Whole files | Targeted responses |
| --- | ---: | --- | ---: | ---: |
| Source3046 |68|0 /0 /0|14|73|
| Actual compiled3047 |68|0 /0 /0|14|73|

Five fresh exclusive0600 proofs per mode cover: new formatting12, missing-type9, selected singular23, configured posts-page13 and Source/Classic home body16 =73. Artifact-only inspection verified all146 actual targeted responses and their owned DOM across both modes. This is not the total HTTP count made by the14 test files. New formatting proofs certify both public search GET/HEAD/model groups and six authenticated renderer API outputs, including exact curly quotes/default/false/showPrefix behavior, safe visible entity text and unchanged raw-s `Blog`. Previews persist only label/status/rendered output.

Direct helper, normalizer, renderer and supplied-database TypeScript imports remain **SOURCE assertions in both modes**. Compiled mode proves actual HTTP server behavior against the frozen bundle; it does not turn those direct imports into compiled service tests. Existing explicit Search form/entity and cumulative resource controls passed in the same selected gate.

TSC, Vite with runner config loader and direct native esbuild all passed on their first build. Current fingerprints rehash354 source files,243 **tracked test files** and411 produced outputs;243 is an inventory count, not an executed-test count. Only the usual Vite chunk-size advisory occurred.

## Resource closure and retained setup

Actual disposable DBs: `worldact_test_1794300576877_5538991c` and `worldact_test_1794300617692_0ca8be2b`. Final read-only SQL found neither DB, the never-created backend anchor, either phase application group or any recorded PostgreSQL session PID. All recorded owned OS PIDs ended. Ports3046–3048 were physically free. The journal pool ended.

The original regular UID501/mode0600 environment, exact owned read-only dependency link and all411 current outputs remain retained pending separate root cleanup authorization. Config bytes still match their creation SHA391116. MAIN dependency owner remains a real UID501/mode0755 directory with matching lock233. No archive was created. Exact generated upload/outbox paths were not independently journaled, so no exact per-path absence claim is made; the official runner performed its normal finally cleanup.

One artifact-audit tooling error is preserved separately: an invented search cleanup log tag found one summary instead of two. The actual immutable log uses `QUERY_TITLE_SEARCH_FIXTURE_CLEANUP` and records no cleanup failures. A new driver corrects that one tag; the original driver remains unchanged. No product, test, raw log or proof changed, and no build/API/HTTP/test reran.

## Evidence and limits

Private checks: `<private-evidence>/query-title-search-format-backend-checks.json`, SHA `8339256ca14b36aff94a8b992d4f9caf1c283764d33d0b118b9fca3f88ade226`. DOM audit: `<private-evidence>/query-title-search-format-backend-dom-audit.json`, SHA `0717dba9cd024dc9e6e73bb438b14f715311cefb2f59e7566aaafe56f064bccf`. Both original run receipts, raw logs, proof hashes, construction/build freezes and the tooling correction are linked in checks.

This review makes no browser/editor UI, eligibility/global search flag, alias/path-only transport, empty-search, level0, post-type registry, malformed raw attribute, general PHP invalid-UTF8, complete sanitizer, whole CMS, full/fresh/fixed3062, benchmark, production release or new CI claim. Numeric quote/entity wire spelling may be canonicalized by the unchanged sanitizer; the proof boundary is exact safe DOM text and separate raw helper normalization. No MAIN, CI or UI change was made by this backend gate. No evidence docs are published yet.
