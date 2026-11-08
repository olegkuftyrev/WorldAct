# Public comment open state and Reply navigation

Author implementation evidence. Independent backend/native review remains required after freeze; this document does not mark the whole CMS complete.

Base: `d5acf53995324465deaa0adc8000a8a0788cea10` from the accepted source comment layout release. Feature commit: `275d0dea7f6faab4d19bf54cf8e537583afaa798`.

## Result and source provenance

One shared `commentsOpen` decision now serves real Node human-comment admission, source form and Reply rendering, and Classic form/Reply eligibility. The supplied default age filter applies to posts only, preserves explicit closure, closes strictly after the configured age, and leaves undated publication open without substituting creation time. An undated draft remains unpublished and cannot accept a public comment.

Reference PHP was read as data only, never executed:

- `/Users/olegkuftyrev/Desktop/wordpress/wp-includes/comment.php:3881–3912`: `_close_comments_for_old_post`, default post-type list, undated case and strict comparison. The related bulk helper is at 3841 onward.
- `/Users/olegkuftyrev/Desktop/wordpress/wp-includes/default-filters.php:321–323`: default comments/pings open filters. This change is bounded to existing human-comment admission/UI; incoming ping implementation is unchanged.
- `/Users/olegkuftyrev/Desktop/wordpress/wp-includes/comment-template.php:1750–1857`: depth/open eligibility, `Log in to Reply`, source anchor classes, ordinary `replytocom` href, Reply-to-author aria/data attributes, and stripping moderation query fields.

Registration-only anonymous Reply controls in both themes now navigate to the genuine local login. Returns preserve the supported current Plain `p`/`page_id` identity, body `page`, Query Loop counters and `commentPage`. Source ordinary links carry the source aria/data/class attributes; Classic keeps its established appearance while using real anchors. Unmodified clicks retain the existing focus/draft interaction. Modifier/new-tab links use the real current-route href, and an eligible direct `replytocom` route selects/focuses its actual form parent. Route changes retire a previous URL-selected parent and source Reply notice.

Source template GET content is associated with its request; account/role changes remount its owner so a retired authenticated response cannot restore a guest form. Protected/preview gates, actual ancestry eligibility, human-only Reply, notification/avatar privacy and existing pagination are retained.

Scope remains the existing UTC publication timestamp model and React-active public document. No persisted local-date redesign, complete PHP filter engine, full SSR/no-JavaScript Reply parity, flood rule, redesign, CSS, schema or dependency changes are claimed. The existing global HTML sanitizer preserves `nofollow` and appends `noopener noreferrer` to source anchors. Current-route login return context is intentionally retained per this brief rather than reduced to the source canonical login permalink.

## Tracked implementation scope

Eight code/test paths, 180 insertions and 25 deletions:

- `server/core.ts` — helper import and replacement of the existing open-state condition only; admission order/rate/flood logic untouched.
- `server/theme-blocks.ts` — shared open-state gate, real login/ordinary source anchors and form login return.
- `shared/comment-open.ts` — shared semantic rule using existing publication fields.
- `shared/comment-links.ts` — local current-context Reply/login links with internal/moderation stripping.
- `src/components/ClassicCommentThread.tsx` — genuine eligible login/ordinary anchors.
- `src/screens/PublicSite.tsx` — shared Classic gate, route focus/parent state and source request/account ownership.
- `tests/classic-comment-tree.test.ts` — retain complete/deep markup/depth/privacy checks and add registration anchor semantics.
- `tests/public-comment-open.test.ts` — exact boundary, source-type/default/undated behavior, local route safety, actual HTTP rendering/admission and actual registered reply persistence.

## Author gates

Typecheck, production Vite build using `--configLoader runner`, bundled Node build, and `git diff --check` pass. Existing large vendor-chunk build warnings remain.

Focused guarded source and compiled runs each pass 21 tests across 7 files, with 0 failures/skips:

```sh
ISOLATED_TEST_PORT=3013 npm test -- tests/public-comment-open.test.ts tests/classic-comment-tree.test.ts tests/theme-blocks.test.ts tests/comment-window.test.ts tests/plain-source-pagination.test.ts tests/login-redirect.test.ts tests/template-access.test.ts
ISOLATED_TEST_PORT=3013 ISOLATED_TEST_COMPILED=true npm test -- tests/public-comment-open.test.ts tests/classic-comment-tree.test.ts tests/theme-blocks.test.ts tests/comment-window.test.ts tests/plain-source-pagination.test.ts tests/login-redirect.test.ts tests/template-access.test.ts
```

Five newly authored tests comprise the four new open-state/link/HTTP tests and one Classic login-anchor test. The age HTTP matrix verifies actual accepted/rejected statuses and persisted row counts for old post/page, future/undated publication, explicit closure, disabled age and unpublished undated draft. Exact age ±1ms/equality uses the shared deterministic rule; it is not presented as a wall-clock HTTP equality experiment. Existing gates include protected source previews/password forms, independent body/Query Loop/comment paging and complete 2500-record historical ancestry.

## Native evidence

An owned disposable database/uploads/outbox, private environment with mode 600, actual Node 3010 and Vite 5180 served the tests. The isolated `agent-browser` session used a real disposable subscriber via credential-vault stdin. No real mail, DNS, POP, SMTP, Akismet or outgoing ping services were used.

- Source and Classic at 1440/768/375: logged-out eligible Reply login → genuine login → Plain post/body2/Query Loop4 page2/comment page2 return → draft-preserving focused Reply to the deepest eligible parent → real approved comment row with correct account/parent → reload showing that row. All 15 actual ancestry records remained positive-width, with exactly 2 eligible human controls, avatars disabled, no private metadata and no horizontal overflow.
- Both themes at 375: old-post closure, old-page openness, explicit closed page, disabled age; typed ping window without Reply/avatar; ordinary link new-tab navigation with actual selected/focused parent; old Plain page `page_id` login return and real Back/Forward preserving supported counters.
- Source at 375: a real authenticated template response was captured and held by an owned local proxy, then actual UI logout completed and guest content rendered. Releasing the old response left genuine guest login links and no authenticated form. A subsequent real login restored the current eligible form/context.
- Final unchanged code, both themes/all 3 widths: normal draft/focus, eligible `replytocom` route via browser history navigation, and Back clearing the URL-selected parent/notice, with full chain/context/privacy/geometry checked.

The initial source three-width and Classic 1440 save flows preceded only the final two route-reset UI hunks; subsequent final-code six-width route/focus/history checks cover those hunks, and all age/new-tab/page-login/history/ownership follow-ups used final code. No author code changed after the final native follow-up. Screenshots and structured captured observations are included with exact feature hash/file fingerprints in `proof.json`. These are author checks; root arranges independent frozen-candidate evaluation.

## Resource isolation and cleanup

No installs, dependency versions, migrations, main/frozen tracked files or reviewer 3035 resources were modified. Dependencies were reused through the existing owner's symlink, with Vite's runner loader. Setup correction: the first Vite start used the default optimization-cache location before browsing; it was stopped and an owned `/tmp` cacheDir was configured for every native flow. No `npm ci` or shared `.vite-temp` was used; existing owner caches were left in place after that correction.

Cleanup is complete: owned database/uploads/private environment/native config/cache removed; owned browser and fixture vault profile closed/deleted; ports 3010/5180/3012/3013 verified free. The dependency symlink and all screenshots are retained. No secrets, cookies, credential-vault records, environment files or database connection strings are committed.
