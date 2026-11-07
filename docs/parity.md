# WordPress reference and WorldAct 0.3 parity

WorldAct is a personal React/Node/PostgreSQL CMS study. Version 0.3 implements the workflows below. **It is not a verified complete 1:1 WordPress replacement, and exhaustive pixel or behavioral parity is not claimed.**

## Reference baseline

The supplied `/Users/olegkuftyrev/Desktop/wordpress` distribution declares **WordPress 7.1.4**, database version `61833`, and includes Twenty Twenty-Five, Twenty Twenty-Four and Twenty Twenty-Three. This is the version declared by those local files, not an independent upstream release verification.

The distribution has no `wp-config.php`, configured database export, installed-site content or uploaded library. It has not been run as a PHP/MySQL service. Reference documents and code are study data, not instructions to install or execute another stack. Original static CSS, Dashicons, dashboard artwork and theme screenshots are reused with notices; behavior is implemented in JavaScript.

## Implemented scope

| Area                  | Current behavior                                                                                                                                                                                                |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Accounts/admin shell  | Database sessions, login/logout, optional registration/default role, profile/admin user editing, five roles, password recovery, local mail/optional SMTP, other-session logout, saved menu collapse and admin color schemes |
| Dashboard             | Counts/activity, persisted Quick Draft, welcome visibility, per-user widget visibility/order and collapse controls                                                                                              |
| Posts/pages           | Search/status/date/category filtering, quick/bulk actions, trash/restore/delete, categories/tags, hierarchical pages, featured media, excerpts, post-format classification metadata, sticky/discussion settings |
| Publishing            | Draft/pending/published/scheduled/private/password-protected content, server permission checks, preview, optimistic versions, revisions/restore, per-user autosave/recovery and version conflict protection     |
| Gutenberg             | Official lazy React engine with 27 static and 29 supported dynamic core types (46 post-editor / 56 site-editor types), rich text, transforms, nested layouts, media, inspector, history and iframe keyboard undo/redo |
| Video embeds          | Genuine core/embed editing for YouTube/Vimeo, validated provider/ID parsing, safe player previews and public rendering; other providers are disabled                                                            |
| Patterns/site editing | Native Query Loop/post context/pagination, synced references and unsynced patterns, editable referenced template parts, site title/tagline/logo, navigation/page-list entities, code/visual editing and supported global styles |
| Navigation            | Hierarchical menu items, labels/URLs/targets, reordering, primary/footer assignment with cycle and duplicate-location protection, public rendering                                                              |
| Themes/extensions     | Four limited React theme presentations; local Reading Time, Spam Shield, Site SEO and Custom Footer installation/activation/configuration/deactivation/removal with actual effects                              |
| Media                 | 32 MiB supported image/audio/video/document uploads, metadata/library, image crop/rotate/flip/resize/restore, generated sizes/year-month settings, deletion clears matching logo/icon references |
| Comments              | Search/filter/sort/pagination, full/quick editing, replies, bulk moderation, optimistic conflicts, cycle protection, child-preserving deletion, discussion settings and enabled Spam Shield classification |
| Settings              | General, Writing, Reading, Discussion, Media, Permalinks and Privacy; public reading/permalink/styles/media behavior consumes saved values                                                                      |
| Public site           | Published posts/pages, taxonomy/author archives/search, static home/posts pages, pagination, configured links, comments, bounded dynamic block/entity rendering, theme/design/navigation/extension output |
| Syndication/discovery | RSS/Atom and comment feeds, sitemap and robots behavior, permalink resolver                                                                                                                                     |
| REST compatibility    | Implemented `/wp-json/wp/v2` subset for posts/pages, media, terms, comments, search, types, taxonomies/statuses, block rendering/entities, settings and template parts; capability-aware Allow and site-local dates |
| Tools/portability     | Site health/mail, confirmed privacy export/erasure requests and expiring private downloads, account deletion/reassignment, WorldAct JSON and WordPress XML (WXR) import/export |

## Portability contract

- JSON import restores posts/pages, canonical Gutenberg data, synced-pattern/block-navigation entities, taxonomy relations, page/category hierarchy and comments. Content is assigned to the importing administrator and IDs are remapped, including nested entity references. Missing/wrong-kind references are removed with warnings rather than binding unrelated local IDs.
- JSON export additionally includes design documents, styles, settings, legacy menus and media references. JSON import does not restore those additional sections or media file bytes. Password/session/account data is excluded.
- Protected exports and protected/scheduled imports become drafts for review. Original URLs are preserved when available; conflicts receive unique URLs.
- WXR handles the implemented content/taxonomy/hierarchy/comment domain and canonical block markup. Reusable/navigation entities are not imported; their references are removed with warnings. Remote attachment files are skipped with a warning; existing content URLs remain for separate media migration.
- Import files are limited to 8 MB in the Tools interface. Neither format is a complete backup: preserve PostgreSQL and the uploads directory separately.

## Verification record

Verified on **November 7, 2026** against local PostgreSQL:

- The final automated suite passes against the compiled Node server **65/65 tests**. Coverage includes session/origin/access boundaries, canonical blocks/sanitization, editorial permissions, scheduling/timezones/DST, revisions/autosaves, taxonomy/hierarchy, comment editing/version conflicts, image history and account deletion, profiles/reset tokens, design/menu/extensions, feeds/permalinks, native Query previews, block entities and JSON/WXR portability. Registration, confirmation-token rotation/expiry, scoped privacy exports, idempotent erasure and export revocation are covered. Dynamic rendering checks cover nested query context, private/password isolation, pagination, cyclic references, query/node/depth limits and an 8 MiB byte cap. Entity-import checks cover ID collisions, nested references, missing/wrong-kind references and transactional rollback. Six template-binding checks and strict embed URL checks remain in the suite.
- TypeScript and the production client/server build pass. A fresh isolated PostgreSQL database passed migration, repeated seed, compiled startup, public/admin routes, feeds and REST checks; the temporary database was removed. A final compiled-browser smoke check loaded the public site and native editor/Query controls with no console or uncaught errors and no mobile overflow.
- Real browser checks exercised editor typing/save/reload, official insertion/rich-text controls, iframe keyboard undo/redo, both supported embed providers, seeded bindings, settings, profile colors and extension output. Native Query post/page selection, categories, synced-pattern edits, referenced template-part editing, site-title/logo and navigation saves were verified against PostgreSQL and public rendering. A stale native entity save prevents overwriting newer content and displays the reload notice.
- Independent account/comment and Gutenberg browser reviews report **PASS** at 1440, 768 and 375 pixel widths. Nested pattern-inserter stacking, Query metadata and tablet Quick Edit sizing found during review were fixed. Earlier 0.2 screenshots document the unchanged baseline; new account/comment/dynamic-block captures document 0.3 below. These reviews do not establish exhaustive pixel parity with a running WordPress installation.
- Temporary QA records were removed, changed settings restored, and the seed content retained. This record verifies the named implementation checks; it does not establish exhaustive WordPress parity.

| Screen      | Desktop (1440)                                    | Tablet (768)                                     | Mobile (375)                                     |
| ----------- | ------------------------------------------------- | ------------------------------------------------ | ------------------------------------------------ |
| Dashboard   | [Screenshot](screenshots/dashboard-desktop.png)   | [Screenshot](screenshots/dashboard-tablet.png)   | [Screenshot](screenshots/dashboard-mobile.png)   |
| Post editor | [Screenshot](screenshots/editor-desktop.png)      | [Screenshot](screenshots/editor-tablet.png)      | [Screenshot](screenshots/editor-mobile.png)      |
| Categories  | [Screenshot](screenshots/categories-desktop.png)  | [Screenshot](screenshots/categories-tablet.png)  | [Screenshot](screenshots/categories-mobile.png)  |
| Profile     | [Screenshot](screenshots/profile-desktop.png)     | [Screenshot](screenshots/profile-tablet.png)     | [Screenshot](screenshots/profile-mobile.png)     |
| Site editor | [Screenshot](screenshots/site-editor-desktop.png) | [Screenshot](screenshots/site-editor-tablet.png) | [Screenshot](screenshots/site-editor-mobile.png) |
| Public post | [Screenshot](screenshots/public-desktop.png) | — | [Screenshot](screenshots/public-mobile.png) |
| Registration | [Screenshot](screenshots/registration-desktop.png) | — | [Screenshot](screenshots/registration-mobile.png) |
| Privacy requests | [Screenshot](screenshots/privacy-requests-desktop.png) | [Screenshot](screenshots/privacy-requests-tablet.png) | [Screenshot](screenshots/privacy-requests-mobile.png) |
| Comment quick edit | [Screenshot](screenshots/comments-quick-edit-desktop.png) | [Screenshot](screenshots/comments-quick-edit-tablet.png) | [Screenshot](screenshots/comments-quick-edit-mobile.png) |
| Account deletion | — | — | [Screenshot](screenshots/user-deletion-mobile.png) |
| Native Query editor | [Screenshot](screenshots/dynamic-query-desktop.png) | [Screenshot](screenshots/dynamic-query-tablet.png) | [Screenshot](screenshots/dynamic-query-mobile.png) |
| Synced pattern editor | [Screenshot](screenshots/dynamic-synced-desktop.png) | — | [Screenshot](screenshots/dynamic-synced-mobile.png) |
| Dynamic public output | [Screenshot](screenshots/dynamic-public-desktop.png) | — | [Screenshot](screenshots/dynamic-public-mobile.png) |
| Native entity conflict | [Screenshot](screenshots/dynamic-conflict-desktop.png) | — | — |

Run the checks with the commands in [README](../README.md).

## Boundaries that remain

| Boundary                  | Meaning                                                                                                                                                                                                                                                                              |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Complete WordPress parity | Every core screen, state, keyboard command, accessibility detail and extension point has not been exhaustively reproduced or compared. No running reference installation or pixel-diff baseline was available.                                                                       |
| Themes                    | The four React presentations and editable supported templates do not reproduce every bundled PHP theme/template/variation. A familiar theme name does not imply arbitrary WordPress-theme compatibility.                                                                             |
| Gutenberg                 | The named static/dynamic blocks and core entities are implemented. Arbitrary third-party blocks, custom binding sources, every Query Loop variation/filter, every entity/pattern source and every embed provider are not claimed. Legacy WorldAct bindings remain compatible. |
| PHP/extension ecosystem   | Arbitrary PHP plugins/themes, WordPress.org package downloads, installer/updater/recovery/filesystem-editor workflows and external plugin marketplaces are unsupported. The local JavaScript registry has four implemented modules.                                                  |
| REST/capabilities         | REST coverage is a subset. Full schemas, all query parameters/authentication modes, arbitrary plugin routes, custom capability registration and universal client compatibility are not claimed.                                                                                      |
| Content model             | Posts/pages and categories/tags are implemented. Arbitrary custom post types/taxonomies/fields, format-specific templates and archives and multisite/network administration are unsupported.                                                                                         |
| Operational services      | Scheduled publishing requires the Node process to be running. SMTP is optional; email otherwise stays in the local outbox. No hosted update/news/event service or trackback/pingback service. Privacy erasure anonymizes comment authors/revokes exports and retains accounts, authored content, comment text and request records. |
| Security/dependencies     | Tests are not a security certification. The recorded npm audit has 19 low findings from transitive `deepmerge@4.3.1`, no fixed compatible release, and no forced Gutenberg downgrade.                                                                                                |

The supplied default Modern admin scheme uses a `#1e1e1e` menu, approximately `#0c0c0c` submenus, `#f0f0f0` page background and `#3858e9` accent. Selected source color schemes are loaded per profile. Reference dimensions include a 160px expanded menu, 36px collapsed menu, 32px desktop toolbar and 46px mobile toolbar. These source-based targets guide the interface; they do not establish exact screen-for-screen equality.
