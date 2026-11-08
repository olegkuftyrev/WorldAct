# Unavailable selected static front page

When a saved static-front page became private, draft, trashed or missing, Node correctly returned404, but React treated the absent public `frontPage` object as an ordinary posts home. The same fallback affected unpaginated root, body-page requests, and independent query/comment counters.

The adapter now treats the saved `frontPageMode` and `frontPageId` as the selected identity. If its public object is unavailable or does not match that identity, it uses the real public resolver and existing Classic/source404 rendering. Published selected fronts retain normal rendering/body pagination. Existing `notFound` handling prevents recursive delegation. No new settings preflight, polling, effect, or account state is introduced.

Only nonempty archive/filter values suppress static-front resolution, matching `server/public-documents.ts`. Empty `s`, category, author and date values therefore retain the selected front’s404 behavior; empty dates are also omitted from the existing public query so a published front remains a front page. Genuine filter archives, ordinary posts home and its page2, the selected posts page, and protected fronts keep their existing behavior. Source templates/assets and Classic404 markup are unchanged.

## Validation

- Production build passes, including TypeScript, Vite assets, and the compiled Node server.
- Guarded source and compiled-server suites each pass **16 checks across three files, zero failures/skips**:

```sh
ISOLATED_TEST_PORT=3043 npm test -- tests/plain-permalink-routing.test.ts tests/front-page-availability.test.ts tests/plain-permalinks.test.ts
ISOLATED_TEST_PORT=3043 ISOLATED_TEST_COMPILED=true npm test -- tests/plain-permalink-routing.test.ts tests/front-page-availability.test.ts tests/plain-permalinks.test.ts
```

The pure routing matrix includes null/loading site data, saved/mismatched/missing IDs, valid fronts, root/body/query/comment counters, empty and genuine filters, non-root pages, and ordinary posts home. The real HTTP test changes actual post statuses, verifies the saved-ID/public-object contract, calls the actual resolver, and covers deletion/stale selection, protected fronts, and archive separation. It restores its disposable database settings and content.

## Native production checks

[Safe recorded results](front-page-availability-native-checks.json) use synthetic data only. The frontend is the production build served directly by compiled Node through an owned local proxy, so HTTP status and hydrated React content are checked together. No PHP/MySQL, external DNS/mail/services, or mocked response bodies are used.

- Real Reading controls select and save a published front and a posts page in both Classic and Twenty Twenty-Five.
- **138 native404 rows** cover private/draft/trash/deleted/stale selected IDs at1440/768/375, with root, body2, and combined body/query/comment counters. All retain real HTTP404 and the actual404 UI, with no previous front body or blog listing and no horizontal overflow.
- Empty filter checks cover all eleven Node archive keys at root and body2, plus empty array-shaped filter values and counter-only roots. The stale-ID fixture is deliberately set in the owned database because the real Settings API correctly rejects a nonexistent page.
- **30 preserved rows** cover published root/body2, empty filters/dates, republishing recovery, actual search/category/author/year archives, a protected selected front unlocked on page2 using the native Enter action, selected posts pages without their editor body, and ordinary posts home/page2.
- In both themes, a previously displayed published front becomes private. An actual new public-site response is held while the UI loads; the previous body is absent. Native logout changes the account, the original responses are released, and the anonymous view remains404 without the old body or blog listing. The proxy buffers original backend responses without replacing content.

| Actual404 view | 1440 | 768 | 375 |
|---|---|---|---|
| Classic | [Desktop](screenshots/front-unavailable-classic-1440.png) | [Tablet](screenshots/front-unavailable-classic-768.png) | [Mobile](screenshots/front-unavailable-classic-375.png) |
| Twenty Twenty-Five | [Desktop](screenshots/front-unavailable-twentytwentyfive-1440.png) | [Tablet](screenshots/front-unavailable-twentytwentyfive-768.png) | [Mobile](screenshots/front-unavailable-twentytwentyfive-375.png) |

The screenshots use the existing source404 template and bundled assets or existing Classic404 layout; they are not redesigned fixtures. Independent review and integration remain separate.
