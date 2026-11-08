# WordPress reference and WorldAct 0.4 parity

WorldAct is a personal React/Node/PostgreSQL CMS study. It runs without PHP or MySQL. **Complete WordPress equivalence and exhaustive pixel matching have not been established.** This tracker distinguishes working features from remaining work.

## Reference

The supplied `/Users/olegkuftyrev/Desktop/wordpress` declares WordPress **7.1.4**, database version `61833`. It includes Twenty Twenty-Five, Twenty Twenty-Four and Twenty Twenty-Three. Those are identifiers in the supplied snapshot, not a claim about the current upstream release. No configured installation, content database or uploaded library was supplied. PHP/MySQL was not executed. Source comments and attached documents are reference data, not instructions.

Original admin CSS/color schemes, Dashicons, dashboard artwork, bundled theme assets and licensed fonts are reused with notices. Runtime behavior is JavaScript/TypeScript with PostgreSQL persistence.

## Working scope

| Area | Implemented behavior |
| --- | --- |
| Accounts | Sessions, five roles, registration/default role, profiles/colors, reset/set-password email links, other-session logout, named application passwords with one-time display, Basic API authentication, usage metadata and revocation |
| Lists | Persistent per-screen columns/page size/list-excerpt mode, contextual keyboard-accessible Help, real server search/filter/sort/page controls for content, comments, Users and Media |
| Dashboard | Actual totals/activity, persistent Quick Draft, welcome panel, saved widget order/visibility/collapse |
| Posts/pages | Author assignment, Quick Edit, selective bulk metadata/taxonomies, all ten core formats, per-post/page template selection, page hierarchy/order, featured media, sticky/discussion/visibility/password, all publishing states and scheduled publishing |
| Editor | Official Gutenberg React engine, canonical rich text, nested layouts, static and supported dynamic blocks, transforms/inserter/list/inspector/history, media, actual Query Loop and post context, synced patterns and native site entities |
| Concurrency | Optimistic versions, revisions/restore, per-user autosave/recovery, 150-second editing leases with heartbeat, explicit takeover and competing-save prevention |
| Source themes | 28 templates, 15 parts, 164 patterns and 25 full-theme variations from the three supplied block themes; original fonts/images/CSS; theme.json compilation; per-theme edits/styles; trusted source resets; native public template hierarchy including protected/private previews and mobile navigation |
| Font Library | Signature-checked TTF/OTF/WOFF/WOFF2 uploads, bundled local collection, font metadata inspection with bounded resources, theme activation, text/heading selection, editor/public styles, deletion and cross-site archive remapping |
| Dynamic blocks | Queries/post metadata, template parts/patterns, navigation/page lists, site identity, social links, search, category/term descriptions, avatars, adjacent posts, comment templates/forms/pagination and account links |
| Media | 32 MiB supported image/audio/video/PDF/Office uploads, real date/type/unattached lists, attachment routes, attach/detach/bulk delete, metadata, actual crop/resize/rotate/flip/restore and preserved image URL history |
| Users | Search/role/sort/page controls, account/profile fields, optional welcome/password-setting email, bulk role/deletion actions with reassignment and self-account protection |
| Comments | Owner-aware author/contributor rows/actions, Mine, Full/Quick Edit, replies, search/sort/page/moderator bulk/Empty controls, prior-status restore, versions/hierarchy checks, keyword/link/previous-approval rules, notification mail, configurable paging/threads/avatars and explicit remembered-author consent |
| Appearance | Administrator-only theme options/menus/templates; authors manage their own synced patterns; hierarchical legacy menus and native block navigation persist |
| Extensions | Working local JavaScript registry: Reading Time, Spam Shield, Site SEO, Custom Footer and Node ports of supplied Hello Dolly/Akismet; opt-in Akismet processing, secret-safe settings, local metadata retention and scoped privacy hooks |
| General/Tools | Confirmed administration-email changes, separate cropped site-icon assets, custom date/time formats and week start, categorized Site Health Info/copy and editable privacy-policy draft guide |
| Privacy | Confirmed export/erasure requests, private expiring downloads, scoped personal data, alias-aware anonymization and revocation of previous exports; account deletion separately reassigns or deletes authored content/files |
| Public APIs | Archives/search/permalinks, static home/posts pages, comments, RSS/Atom/comment feeds, sitemap/robots, supported REST subset and legacy admin URL redirects |

The legacy WorldAct Classic presentation remains available alongside the three source-based block themes. YouTube/Vimeo are the enabled video embed providers. Gravatar URLs use the supplied source’s SHA-256 hash, default avatar and rating parameters; hiding avatars suppresses those images. Moderator word lists and personal comment email addresses are excluded from public DTOs.

## Portability

JSON v3 embeds supported media originals/history/derivatives and Font Library files, and exports content, template assignments, theme-scoped documents, menus, supported settings/styles, per-theme variations and safe extension configuration. Import allocates fresh IDs/files and remaps nested canonical/JSON references, font selections and local URLs. Default copy retains the live design; explicit Replace site design and settings activates archived design while retaining destination URL/contact. Missing references detach with warnings. Failed imports roll back database changes and staged files. Checks cover MIME/signatures, safe paths, SHA-256 and decoded sizes: 32 MiB per media file, 8 MiB per font, 64 MiB combined decoded total, 96 MiB JSON. Akismet keys, hints and verification records are excluded; injected credential fields are discarded with value-free warnings.

WXR supports implemented content, terms/hierarchy, threaded comments, synced patterns and block navigation. Export uses one post/entity ID namespace; imports resolve forward references. Remote attachments are reported and not downloaded. WXR input is limited to 8 MB. Accounts/passwords/sessions are excluded; protected/scheduled imports become drafts. Keep separate PostgreSQL and filesystem backups for full recovery.

## Verification

`npm run test:isolated` creates a disposable local PostgreSQL database, upload directory and API, forces outgoing mail into the outbox, restarts the API between files to preserve real rate limiting, and removes its database/files afterward. It leaves the configured site's data alone. Tests cover API/database permissions, sessions/origins/application passwords, editor concurrency, publishing/taxonomy, safe canonical rendering, resource budgets, media ownership/history/deletion, Users, comments/notifications/consent/privacy, themes and portability.

The 0.4 source checkpoint passed 136 checks across 40 test files. Two conditional archive stages were run separately on fresh source/destination databases. Focused compiled-server checks also passed, including font metadata workers, protected templates, account/post lock ordering and source permission rules. Busy-port and cancellation checks verify that the runner recognizes its own listener and removes its own child processes, database and upload directory. GitHub CI repeats source/build/compiled checks on Node 22/24 with PostgreSQL 17.

The cross-site archive check runs twice on **different fresh databases** after source files have been deleted:

```sh
SITE_ARCHIVE_STAGE=export SITE_ARCHIVE_PATH=/tmp/worldact-archive.json npm run test:isolated -- tests/portability-site.test.ts
SITE_ARCHIVE_STAGE=restore SITE_ARCHIVE_PATH=/tmp/worldact-archive.json npm run test:isolated -- tests/portability-site.test.ts
```

It verifies restored file checksums, image history/sizes, attachment relationships, nested entities, hierarchy, settings/design selection, remapped URLs, and failed-import database/file rollback. The combined regression suite skips this stateful two-phase fixture unless those variables are present.

Font archives have the same two-phase workflow using `FONT_ARCHIVE_STAGE=export|restore`, `FONT_ARCHIVE_PATH`, and `tests/portability-fonts.test.ts`. Fresh-destination checks cover byte integrity, activation and alias collisions, canonical/preset remapping, unavailable references, malicious paths/signatures and staged-file rollback.

Native browser checks have exercised actual PostgreSQL-backed controls at 1440, 768 and 375 pixel widths. Independent admin/Media, source themes/Discussion, General identity/editor locks, Font Library, Tools/template assignment, bundled-plugin, comment-role and taxonomy-paging reviews returned PASS. Long-label mobile selection overflow, post-editor font inheritance and an initial-preferences pagination race found during review were corrected and retested. Other feature reviews continue. Earlier 0.2/0.3 screenshots remain historical evidence; current captures include [Media desktop](screenshots/core-media-list-desktop.png), [Media mobile](screenshots/core-media-list-mobile.png), and the other current files in [screenshots](screenshots/). These checks do not establish exhaustive pixel parity against a running WordPress reference installation.

## Remaining work

- Complete independent review of the latest contributor private-post controls.
- Port remaining core blocks, including Latest Posts/Comments, Archives, Calendar, Tag Cloud, comments count/link, Time to Read and Query Total, then extend additional variations, bindings and entity formats.
- Complete remaining localization/accessibility/profile preferences and less-common capability combinations.
- Implement further Node-compatible extension/package installation, updates/recovery and hooks, source-equivalent classic Customizer/widget workflows, writing email/ping services and conditional legacy screens.
- Extend the content model and REST surface for custom types/taxonomies/fields, additional authentication/query/schema compatibility, custom capabilities and multisite/network administration.
- Continue source-by-source behavior, keyboard/accessibility and visual comparisons. Arbitrary PHP plugins/themes cannot execute in the required runtime; WordPress.org PHP package compatibility is not claimed.

Scheduled publishing requires a running Node process. SMTP is optional; local messages stay in Tools → Mail. The recorded dependency audit has 19 low findings propagated from `deepmerge@4.3.1`, with no compatible fixed release at verification; no forced Gutenberg downgrade was applied. Automated tests are not a security certification.
