# Incoming ordinary flood admission

This is a scoped backend parity continuation on `c3d16da7f897f51806d79355ff9bae351586b023`. It adds the existing default15-second ordinary comment interval to anonymous incoming pingbacks and trackbacks. It does not change schema, retention, credentials, production-only receiving, verification, lease capacity, attempt buckets or public target fences.

The immutable regression was committed first at `b7f3164afc9342c7cf8d9e3af8c3a2312f58cabd`, with runtime unchanged from the base. Its SHA256 is `16963dc3d67a835b766cb12b893c89685952df19373e44e217a12af0348a578e`. On that baseline the same probe produced4 passed /20 failed of24 counted tests in both source and compiled-main guard modes. Counts include the failing parent container; they are not20 separate leaf regressions. The probe's bytes were not changed for the successor.

Runtime change: `ab3b85483322c0a87fbec8231eb8b18634edb341`. Final code/CI coverage: `d2f491f21ef4a3b650c4622a75b5b33d5058e00a`. The latter adds supplementary coverage only and has identical runtime sources. Final TypeScript, Vite (runner config loader), and esbuild checks pass. Node24.14.1 was used locally.

Final nonoverlapping guarded results, independently per mode:

| Scope | Files | Passed | Failed | Skipped |
| --- | ---: | ---: | ---: | ---: |
| Incoming unchanged probe, production entry, existing protocol suite |3|48|0|0|
| Human flood/approval/duplicate and outgoing ping regressions |12|76|0|0|
| Total |15|124|0|0|

The unchanged probe uses actual router HTTP, actual PostgreSQL history/locks, and actual human API requests. It covers global blank-email OR and actual guest-IP predecessors across every supported type/status and different posts; credentials never grant exemption. It tests concurrent distinct final admissions, same-source duplicate48, real post/settings waits, post-wait timestamps, one-hour metadata expiry, generic protocol errors, no rejected comment/private per-comment metadata/mail, and unchanged consumed attempts with lease cleanup/retry. The verification and Akismet adapters are controlled bounded transports, not successful document substitutions.

Those controlled helper calls execute source imports even under the compiled-main guard; that is not compiled helper-byte execution. Supplementary production coverage launches the selected real source/compiled Node entry and posts real trackbacks without DNS or external delivery, checking acceptance, subsequent rejection, cookie non-exemption, actual human API blocking, anonymous storage, consumed attempt buckets and lease removal. Supplementary direct-service tests additionally observe `IncomingPingError(0)`, preserve unrelated verifier error identity, and prove no pooled client during held Akismet I/O, duplicate48 under a real final race, and lease expiry after a final post-row wait.

An early known flood stops before moderation/Akismet. A final race can reject a notification whose external filtering already completed; its existing global connector-health update is not undone. No comment, retained per-comment IP/Akismet record or mail is created for that rejected notification. The final atomic check remains mandatory after the metadata precheck.

One initial parallel source attempt collided with the same owned router port3062 used by the compiled attempt and failed `EADDRINUSE`. That receipt is retained and excluded from the behavioral baseline; the source baseline was rerun sequentially. Source and compiled incoming groups are run sequentially because the scoped probes reserve3062. Original and successor receipts are identified by SHA256 in [checks.json](checks.json).

All11 owned guarded invocations returned and report no database-drop failure, including the expected failing baseline and invalid port-collision attempt. The never-created anchor remains absent; own `.env` and read-only dependency symlink were removed; shared dependencies were retained;3060/3061/3062 are free. No persistent fixture database or upload directory was created outside the guard. This evidence is not an independent review, visual certificate, benchmark, full repository suite, CI run, or whole-CMS completion claim.
