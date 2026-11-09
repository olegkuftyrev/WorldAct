# Publication status: scoped native review

Result: PASS for the publication controls and save acknowledgement scenes listed here. This is a bounded UI/native result, not a whole-CMS completion or backend release certificate.

## Exact stages

- Initial runtime `759a553bbd99bf46ee8360fb5b0d05cd5ab72710`, tree `5b65d99ae71754e83715ce2176d3ddf4b77a4e31`: Quick/Bulk native matrix passed; three measured Editor false-dirty failures were preserved.
- Backend final base `4ec2cdebebe8086966e27392cff8f4faf7d33b0f`: compared with759, production `src`, `shared`, server code, package/lock and scripts unchanged; server differences were Markdown documentation.
- UI correction `703251b07f0feb4ac0ada956e205a8abda447170`: only Editor, documentSnapshot helper and its regression file; no CSS/backend/shared changes.
- Final native composition `45e9cbccff6ac8ded4151e2fa430a3e4e2c44395`, tree `578c195e272188d78ec489131e3ab80d22f8753b`:4ec+703. This is the actual checkout used for final Editor/held/rights/lease scenes.
- Both runtime stages produced actual Node bundle SHA256 `6e3c50f4dc969b0d6389a20c1f2ee9215f49e8fb81bd19f9ed042a13d645e03f`. Own TSC, Vite runner and esbuild completed successfully.

These are independent owned review builds. The root integration and independent reviewer checks remain separate records.

## Guarded checks

The new ten-case snapshot regression was frozen before the fix:5passed/5failed, zero cancellation/skip. The identical test bytes are included here as `original-snapshot-regression.test.ts.txt`, SHA256 `60d2e4d15f423714674e252a133b66daf8b77e6e5c6237c139937f3c0247c6cb`. The behavior-preserving old helper compared the cached document against a submitted live snapshot. Failures cover a parsed raw-HTML canvas, newer live body before cached callback, and known draft creation acknowledgements. Final same ten pass.

Own final guarded selector:8files,59tests passed in source mode and59with the actual compiled API selected, zero failure/skip. Five UI/helper files still import source and are pure assertions even under the compiled runner; the three original HTTP suites use the selected compiled API. The predecessor44/44per mode is retained separately. No direct raw `node --test` or unguarded fixture mode was used.

Final selector:

- `tests/editor-document-snapshot.test.ts`
- `tests/editor-options-ui.test.ts`
- `tests/editor-publication-date.test.ts`
- `tests/editor-publication-status.test.ts`
- `tests/editor-publication-provenance.test.ts`
- `tests/publication-status-original.test.ts`
- `tests/publication-status-null-gmt-original.test.ts`
- `tests/publication-status-bulk-gap.test.ts`

## Actual browser results

32multi-step passing scene rows, including23at final45e9 and9unaffected Quick/Bulk rows at759.38selected PNGs were individually inspected:26final,9Quick/Bulk and3original failure captures. Screenshots are byte-identical copies. Proof JSONs retain method/path/status, selected fields, fixture data, clocks and observations; local evidence paths are sanitized. Copied logs also strip trailing whitespace; original log bytes remain unchanged.

At1440/768/375 the final real Editor:

- Crossed the actual wall-clock sixty-second boundary from Schedule to Publish. Native submission received200and saved `publish` with the selected GMT/seconds intact, including a chosen instant still ahead of the save clock but inside the minute window. No fake successful responses or clock replacement.
- Saved a fixed future draft, reloaded after changing the site zone from+05:45toUTC, and scheduled unchanged using stored selected GMT; unchanged payload omitted date fields. A changed civil value used the current explicit zone and retained seconds.
- Cleared a future date to immediate/draft, saved null, reloaded and published. A genuinely floating draft could not send an accidental future write without a chosen date.
- Saved a title-only existing future row with nullGMT and an old inactive due timestamp: submission reached the server, which derived the unchanged civil date in the current site zone and returned the authoritative published status. No invented date payload.
- Finished ordinary draft saves in Code and Visual cleanly. Code additionally saved a normalized future schedule cleanly. Actual reload beforeunload was not prevented; real Back to Posts required no unsaved confirmation.

The browser host zone was America/Los_Angeles; site zones were UTC and+05:45. Existing styles/layout were preserved. Responsive Settings was opened/closed through real controls where needed; segmented native datetime keys retained seconds.

At375 three actual SQL-wait cases on the final runtime:

1. A transaction held the post row while an actual final PUT was pending. The already-submitted title/body/date remained the saved server snapshot; newer native title/body/date/status edits stayed intact and dirty. Actual reload prevented unload and the native Restore Autosave action restored newer title/body.
2. A transaction held the actor row while automatic draft creation was pending. Save Draft awaited that same real POST; after release there was one201POST and one200PUT. With no newer edits, the new floating draft was clean and reloaded without a false warning.
3. Automatic creation began before the date was selected. Save captured dateD1; while creation waited, native edits selected D2 and newer title/body/status. After release the originalD1snapshot saved as future; newer values stayed intact and dirty. Native Restore Autosave restored newer title/body after reload.

The proof records actual PostgreSQL blocking/wait observations and an actual request with no response status while held. Holds were released in finally. No runtime hooks, fabricated responses, SQL views or functions were used. Existing local recovery deliberately covers title/content/excerpt/blocks/footnotes: date/status preservation was checked before reload, and is not claimed as recovered after reload.

Contributor/lease final controls:

- At all three widths Contributor had Submit for Review, no publication date input and no Publish/Schedule controls. Actual submission returned pending with selected GMT retained; reload was clean.
- At375another actor's private Editor read returned403, private body was absent and Save was disabled.
- At375an actual admin-held editing lease paused the Contributor's editor, disabled Save and emitted no post PUT. The owned lease was released in finally.

The unaffected native Quick/Bulk results at759remain correctly attributed to that stage:

- Quick ordinary Published request on a fixed future draft returned future, retained selected pair, reloaded as Scheduled and used the returned result.
- Bulk Publish Now reset current draft/future dates to the item save clock while a pending row retained its chosen date and returned future.
- Bulk Scheduled with a valid chosen past civil date submitted and returned publish instead of being blocked by the old client future-only rule.

These were real native controls at all three widths;703does not change Quick/Bulk/CSS/backend code. They were not rerun and relabeled as final45e9.

## Original failure and correction

At759a fresh raw-HTML, null-block DTO saved successfully but remained Unsaved changes/then Autosaved, and a real reload was prevented. This occurred in a normalized Publish and in ordinary Draft-to-Draft saves in Code and Visual. All three original JSON/PNG receipts remain failures of759, not successes.

The final helper compares the same live Editor representation before server/footnote acknowledgement. It rebases only a known, post-ID-bound draft-creation response through the same transform on the submitted comparison baseline and current document/ref. The sent payload snapshot is unchanged. Genuine content, title, date intent/GMT/provenance, status and footnote differences are retained. Status/slug/date response acknowledgements are conditional; no blanket dirty reset or exclusion of metadata was added. Saved provenance remains absent from API payloads and local recovery. An independent read-only source audit and separate44/44guarded runs are outside this native count.

## Harness history and limits

Original invocation/selector/harness failures were retained privately and representative logs are included: native esbuild executable incorrectly invoked with node; native datetime fill did not update React segmented input; hidden row action needed hover; unsupported select form/ref parsing; responsive Settings overlay; a quoting error during held-PUT DOM observation; account menu initially targeted at mobile width. These are not product findings. The original datetime and dirty failures were kept distinct. Aborted SQL holds released in finally. No browser outcome_unknown or forced session recovery occurred. The cleanup guard initially rejected an assumed proxy cwd before any mutation; actual owned proxy cwd was independently verified and the guard corrected.

Browser: agent-browser0.41.2, Brave153.1.95.104/Chromium153, Node24.14.1. Agent-browser skill/core/commands/authentication/trust instructions were read; nondestructive doctor passed before launch and after selector/input issues. Its existing browser-version warning was retained; no install/upgrade/download was performed. Own session only, local allowed domains only, secrets via vault stdin. MAIN/user tabs were never used.

This does not certify full WordPress parity, every permission or concurrent route, no-JS/public privacy, exact live WordPress pixels, BFCache, benchmarks, migrations, external delivery or a complete CMS. Backend full and archive/import proofs are separate owner records. No new public-renderer code changed in703, so unrelated previously accepted public matrices were not repeated.

## Ownership and cleanup

One unique persistent native fixture database/upload directory was seeded once; MAIN was untouched. Guards used their own disposable fixtures and a never-created test anchor. Read-only dependency lock matched SHA256 `233888ed8f864581a8835aab0b4c33ccd7fbc391f2a98650b63fcf8db8814892`; no dependency install or shared cache/build write.

Cleanup receipt `cleanup.json`: native Contributor logged out, session read confirmed null, two own vault entries deleted, own browser closed; API/proxy listener PID and working-directory ownership checked;3035/3036/3037/5195free; no active native transactions before dropping only the unique database; unique uploads removed; never-created anchor verified absent; two own env files, credential configs and three dependency symlinks removed. Actual dependency owner, original receipts/builds/checkouts and other owners' archive fixtures/backups were preserved. No shared/main SQL or data cleanup.

`original-receipts.json` maps original and sanitized copy hashes. `checks.json` and `cleanup.json` are machine-readable. Only reviewed evidence is included; original private diagnostic PNGs/logs remain preserved without claiming they are passing scenes.
