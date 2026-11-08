# Plain permalinks and source controls

This change completes the five Settings → Permalinks choices and the public React request adapter for the separately tested Plain/Numeric backend. Existing custom settings are preserved exactly. Source references are data from the supplied WordPress tree; no PHP or MySQL runs.

## Source and behavior

- `wp-admin/options-permalink.php:243–272` defines Plain (`""`), Day and name, Month and name, Numeric (`/archives/%post_id%`, without a trailing slash), and Post name (`/%postname%/`). The controls reuse the application’s imported source form styles, system font at 13px, palette, and radio/field layout. The custom field remains editable and empty Plain is valid. Help lists the six supported tokens only.
- `shared/plain-permalink-query.ts` supplies the backend’s shared fixed-ID parser. The root adapter forwards valid and malformed identities to the public resolver, preserving the full query. Page-only requests use the existing actual site response to distinguish a selected static front page from the posts archive; ordinary home/search/archive requests require no extra settings request.
- A resolved immutable post ID is checked again after the existing slug fetch. A changed slug cannot substitute a different published post. A departed detail request cannot replace current detail data.
- A selected static front page retains its page-2 body and front-page template identity, including an explicit `page_id` alias. The selected posts page uses the posts list/home template and never its editor body. Classic and source themes render their actual 404 state for invalid/unreadable identities.
- Source password forms forward body/comment/Query Loop page context. Both source and Classic unlock preserve body page 2.
- Source template body selection and inherited Query Loop page selection are separate. Visible pagination merges query IDs from canonical Plain request paths exactly once, retains `p`/`page_id` and body `page`, and removes internal `contentPage`/renderer fields. Explicit `query-N-page` and `commentPage` remain independent. Raw controls and backslashes in request paths are rejected; legitimate encoded path segments and query text remain usable.

Backend prerequisites, authored separately: `62f26bd`, `9a181a3`, `37890f3`. Local equivalent prerequisite commits are `a4c7f99`, `ef2a19e`, `18095fa`; implementation starts after `18095fa` on base `dfb45ab`.

## Checks

`npm run build` passes, including TypeScript, Vite production assets, and the bundled Node server. The guarded runner passes **34 checks across seven files, zero failures/skips**, against source and again against the compiled server:

```sh
ISOLATED_TEST_PORT=3043 npm test -- tests/plain-permalink-routing.test.ts tests/plain-source-pagination.test.ts tests/plain-permalinks.test.ts tests/category-permalinks.test.ts tests/legacy-content.test.ts tests/password-listings.test.ts tests/theme-blocks.test.ts
ISOLATED_TEST_PORT=3043 ISOLATED_TEST_COMPILED=true npm test -- tests/plain-permalink-routing.test.ts tests/plain-source-pagination.test.ts tests/plain-permalinks.test.ts tests/category-permalinks.test.ts tests/legacy-content.test.ts tests/password-listings.test.ts tests/theme-blocks.test.ts
```

The two new tests cover the actual root-decision matrix and real HTTP source rendering: singular body2 with inherited Query Loop1, explicit Query Loop2, commentPage2, normal archive2, fixed post/page query identities, encoded paths, and rejected authority/control paths. Existing backend tests retain their normal isolated transport fixtures; no real notification service is called.

Native checks use an owned disposable local database, private uploads, outbox, browser, API/proxy/frontend ports, and synthetic content only. [Recorded results](plain-permalinks-native-checks.json) contain no credentials or real user content:

- Every preset was selected and saved through the actual UI, reloaded with the correct checked radio, and its real canonical URL opened in the production browser. The old `/posts/%postname%/` and another custom structure survived exact saves/reloads. Native radio arrows, Custom focus, Tab order, and Enter save work; radio changes do not save automatically.
- Forty public route checks span default source Twenty Twenty-Five and Classic: Plain posts/hierarchical pages, direct URLs and pagination links, body2, Back/Forward, draft/private/future and malformed ID 404 states, static-front and posts-page behavior, posts-home archive2, Numeric non-slash body/hierarchy2, and Plain aliases after pretty settings.
- Actual protected forms in both themes exclude all protected body text before submission and show only the second body after unlocking page2. Passwords were supplied privately and are absent from artifacts.
- The original source comment link is `/?p=4&page=2&commentPage=2#comments`; its native click preserves the second body and selects comments3–4. A disposable source-block template proved Query Loop1 → Query Loop2 independently. Disposable front-page/home marker templates proved the selected front/posts-page template identity; they are functional fixtures, not visual baselines.
- A production proxy held an actual successful fixed-ID resolver response. Real administrator APIs renamed that post and created another published post reusing its old slug. The later real slug GET returned200 for the other record; the frontend rejected the changed ID and rendered the source404 without either body. A later explicit fixed-ID open displayed the original post at its new slug. No response body was mocked.
- Settings, default source body2, and Classic body2 were checked at1440/768/375 CSS pixels with no horizontal overflow. Custom focus and subsequent field focus remained correct. Screenshots use the production build and original bundled source assets.

## Native screenshots

| View | 1440 | 768 | 375 |
|---|---|---|---|
| Permalink Settings | [Desktop](screenshots/plain-permalinks-settings-1440.png) | [Tablet](screenshots/plain-permalinks-settings-768.png) | [Mobile](screenshots/plain-permalinks-settings-375.png) |
| Source body2 | [Desktop](screenshots/plain-permalinks-source-body2-1440.png) | [Tablet](screenshots/plain-permalinks-source-body2-768.png) | [Mobile](screenshots/plain-permalinks-source-body2-375.png) |
| Classic body2 | [Desktop](screenshots/plain-permalinks-classic-body2-1440.png) | [Tablet](screenshots/plain-permalinks-classic-body2-768.png) | [Mobile](screenshots/plain-permalinks-classic-body2-375.png) |

[Held-response identity rejection](screenshots/plain-permalinks-held-identity.png) shows the real source404 state.

This is a bounded permalink/UI implementation. Independent review and integration are separate; it makes no whole-project completion or performance claim.
