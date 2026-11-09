# Independent civil-date backend review

**PASS at runtime `f7ba335415ff2878743291361fca047c2bc56342`.** The independent backend review found no remaining blocker in the bounded civil-publication-date package. The [checks summary](independent-checks.json) records exact stages, immutable probe hashes and exclusions.

This certificate covers the frozen f7ba runtime. Subsequent Classic preview UI work at `23355068f8207675d387a7ee2abbda8030978534` and later compositions are outside it; the native reviewer owns their browser and visual checks. Main migration preservation and remote Node 22/24 CI are separate release gates. No whole-CMS completion or pixel-equivalence claim is made.

## Frozen validation

The runtime tree was `690708e8dcb8207af2c171c5b963d8009d9d63ab`. Independent TypeScript, Vite runner and esbuild checks passed. The separately built Node bundle matched the author's SHA-256: `da76eac89167163ecca73f16cdd26ee642a5248c1e27c08f521cb64328dd8659`.

| Gate at f7ba | Passed | Conditional skips | Failed |
| --- | ---: | ---: | ---: |
| Full source, 184 files | 1,029 | 10 | 0 |
| Actual compiled HTTP server, 136 files | 896 | 6 | 0 |
| Fresh unseeded source installation | 7 | 1 | 0 |
| Fresh unseeded compiled installation | 7 | 1 | 0 |

The source selection includes two independent supplemental files. The compiled selection is the actual CI selection minus the three coordinated `incoming-ping-flood*.test.ts` files, plus the independent exporter-snapshot probe. Those three fixed-port files have separate author/root coverage and were not executed by this reviewer. Reported node:test totals include parent tests.

After these broad gates, test-only followup `d958b30f2fb82a441ca80be3635b4e1309754bde` was applied as reviewer commit `07c210e828a27ac079028a625317a95f922d2160`. It changes only migration-test teardown: wait for sessions belonging to the test's random database to close before ordinary DROP. Its nine cases passed in each mode, and typecheck passed. Production runtime stayed unchanged; these focused runs are not presented as another broad run.

## Preserved regressions

Original failing probes and private reports remain preserved. The final committed probes retain their exact frozen bytes:

- A waited civil-date projection previously returned an obsolete canonical or accepted its former route: 0 passed/4 failed in each original mode; the same probe passes 4/4 per final mode.
- A civil change during final native comment paging previously produced an obsolete 303 after the comment committed and released its post row: 0/3 originally, now 3/3 per mode.
- Scheduling an unchanged, reloaded fixed draft previously returned 400 in both the original and changed site zones: 0/3 originally, now 3/3 per mode.
- Stale schedule-intent handling passes the exact seven-case probe in each final mode. Its original 2-pass/5-fail certificate belongs to the author; this reviewer did not rerun that original stage.
- Selected-GMT serialization independently failed 1 passed/8 failed in each bc7 mode, including actual compiled RSS, Atom and WXR HTTP. Its unchanged nine-case probe now passes in each final mode. Missing selected GMT stays empty/null; old UTC values, ordering and modification clocks retain their separate behavior.

The five-case final-fence supplement also passes in each final broad gate. It measures a real row-lock conflict returning bounded 409 without an HTTP body, and actual final civil-projection waits whose persisted owner, type or publication changes return 404. No claim is made about changes after the final database statement or atomicity across every content, term and settings read.

## Fresh portability, snapshots and migration

Normal and extended v4 fixtures each passed source export, restore into a fresh source database and restore into a fresh compiled-server database. Source archive hashes were measured after export and remained identical through both restores. The fixtures cover changed IDs, destination administrator ownership, a different destination timezone and both design choices. Extended cases cover years 0001/9999, both DST fold instants, civil/GMT display-key collisions, protected, private and future visibility and actual native comment 303/follow preserving the second body and independent query/comment counters. Invalid imports roll back posts, settings and files.

An additional production-exporter probe holds a real row-projection wait while another transaction changes the selected pair and settings. Source and actual compiled HTTP exports retain one coherent old pair, canonical and settings snapshot; a subsequent read sees the changed values. This probe is included in the broad results.

Independent boundary, supplied-client and old-date-column migration probes cover strict calendars, explicit zones, invalid import rollback, caller transaction visibility, a measured post-wait clock/zone capture, users-first migration blocking, preservation of every old table projection and upload bytes, and stable assigned pairs on rerun. The migration fixture already contains the author identity schema and does not replace the actual main backup/migration preservation gate.

Direct imported service modules remain source imports even when the guarded HTTP server is compiled. Actual HTTP, native-form and exporter cases use the separately built compiled Node server. No production edits, main mutation, reseed, dependency installation or external delivery was performed by this reviewer.

## Cleanup and limits

All owned guards ended, ports 3068–3070 are free, and never-created anchors are absent. Owned environment files, dependency links and untracked review copies were removed after hash checks. Shared dependencies, main data, verified backups and original failure evidence remain untouched.

Four successful reviewer-owned archive fixtures remain private, with directory mode 0700 and file mode 0600, for root's release verification. Their private ownership inventory is retained separately. Cleanup is limited to those four successful fixtures after release verification; failed probes and verified main backups remain retained. No private filesystem paths, credentials or raw fixture payloads are included here.

Source 60-second/status/bulk behavior, ordinary civil ordering, historical local modification/media/comment dates, expanded-year UTC interchange, exact exotic PHP normalization, general canonical aliases, source-account import and pretty author archives remain documented followups.
