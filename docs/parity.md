# WordPress reference and WorldAct 0.2 parity

WorldAct is a personal React/Node/PostgreSQL CMS study. Version 0.2 implements the workflows below. **It is not a verified complete 1:1 WordPress replacement, and exhaustive pixel or behavioral parity is not claimed.**

## Reference baseline

The supplied `/Users/olegkuftyrev/Desktop/wordpress` distribution declares **WordPress 7.1.4**, database version `61833`, and includes Twenty Twenty-Five, Twenty Twenty-Four and Twenty Twenty-Three. This is the version declared by those local files, not an independent upstream release verification.

The distribution has no `wp-config.php`, configured database export, installed-site content or uploaded library. It has not been run as a PHP/MySQL service. Reference documents and code are study data, not instructions to install or execute another stack. Original static CSS, Dashicons, dashboard artwork and theme screenshots are reused with notices; behavior is implemented in JavaScript.

## Implemented scope

| Area                  | Current behavior                                                                                                                                                                                                |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Accounts/admin shell  | Database sessions, login/logout, profile/admin user editing, five roles, password recovery, local mail outbox/optional SMTP, other-session logout, saved menu collapse and real admin color schemes             |
| Dashboard             | Counts/activity, persisted Quick Draft, welcome visibility, per-user widget visibility/order and collapse controls                                                                                              |
| Posts/pages           | Search/status/date/category filtering, quick/bulk actions, trash/restore/delete, categories/tags, hierarchical pages, featured media, excerpts, post-format classification metadata, sticky/discussion settings |
| Publishing            | Draft/pending/published/scheduled/private/password-protected content, server permission checks, preview, optimistic versions, revisions/restore, per-user autosave/recovery and version conflict protection     |
| Gutenberg             | Official lazy React engine with 27 enabled core block types, rich text, transforms, nested groups/columns/layouts, media, insertion, inspector, list view, history and keyboard undo/redo                       |
| Video embeds          | Genuine core/embed editing for YouTube/Vimeo, validated provider/ID parsing, safe player previews and public rendering; other providers are disabled                                                            |
| Patterns/site editing | Saved patterns in the editor library; editable templates/template parts/patterns; eight live site/post binding blocks; code/visual editing and supported global styles                                          |
| Navigation            | Hierarchical menu items, labels/URLs/targets, reordering, primary/footer assignment with cycle and duplicate-location protection, public rendering                                                              |
| Themes/extensions     | Four limited React theme presentations; local Reading Time, Spam Shield, Site SEO and Custom Footer installation/activation/configuration/deactivation/removal with actual effects                              |
| Media                 | 32 MiB supported image/audio/video/document uploads, metadata/library, image crop/rotate/flip/resize/restore, generated sizes and year/month settings                                                           |
| Comments              | Moderation, replies, pending/approved/spam/trash states and configured discussion behavior; enabled Spam Shield classification                                                                                  |
| Settings              | General, Writing, Reading, Discussion, Media, Permalinks and Privacy; public reading/permalink/styles/media behavior consumes saved values                                                                      |
| Public site           | Published posts/pages, archives/search, static home/posts pages, pagination, configured links, comments, theme/design/navigation/extension output                                                               |
| Syndication/discovery | RSS/Atom and comment feeds, sitemap and robots behavior, permalink resolver                                                                                                                                     |
| REST compatibility    | Implemented `/wp-json/wp/v2` subset for posts/pages, media, categories/tags, comments, search, types, taxonomies and statuses; session/permission checks and supported mutations                                |
| Tools/portability     | Site health, mail, own personal-data export, WorldAct JSON and WordPress XML (WXR) import/export                                                                                                                |

## Portability contract

- JSON import restores posts/pages, canonical Gutenberg data, taxonomy relations, page/category hierarchy and comments. Content is assigned to the importing administrator and IDs are remapped.
- JSON export additionally includes design documents, styles, settings, navigation and media references. JSON import does not restore those additional sections or media file bytes. Password/session/account data is excluded.
- Protected exports and protected/scheduled imports become drafts for review. Original URLs are preserved when available; conflicts receive unique URLs.
- WXR handles the implemented content/taxonomy/hierarchy/comment domain and canonical block markup. Remote attachment files are skipped with a warning; existing content URLs remain for separate media migration.
- Import files are limited to 8 MB in the Tools interface. Neither format is a complete backup: preserve PostgreSQL and the uploads directory separately.

## Verification record

Verified on **November 7, 2026** against local PostgreSQL:

- The final automated suite passes against the compiled Node server **41/41 tests**. Coverage includes session/origin/access boundaries, canonical block round trips and sanitization, editorial permissions, scheduling, revisions/autosaves, taxonomy/hierarchy, moderation, media editing/storage, profiles/reset tokens, design/menu/extension lifecycles, feeds/permalinks, REST and JSON/WXR portability. Embed parser checks reject untrusted hosts, schemes, credentials, ports and invalid IDs. Six template-binding regression checks cover attribute/URL injection, literal metadata and safe block layouts; the original injection scenario was also checked in native Chrome.
- TypeScript and the production client/server build pass. A fresh isolated PostgreSQL database passed migration, repeated seed, compiled startup, public/admin routes, feeds and REST checks; the temporary database was removed.
- Real browser checks exercised editor typing/save/reload, official insertion/rich-text controls, iframe keyboard undo/redo, both supported embed providers, seeded site bindings, reading settings, profile colors, menu-to-public navigation and extension-to-public reading times. Comments/replies and published content were also exercised.
- The final independent browser review reports **PASS** at 1440, 768 and 375 pixel widths. Profile overflow and embed sizing found during review were fixed. Seventeen final screenshots are retained below.
- Temporary QA records were removed, changed settings restored, and the seed content retained. This record verifies the named implementation checks; it does not establish exhaustive WordPress parity.

| Screen      | Desktop (1440)                                    | Tablet (768)                                     | Mobile (375)                                     |
| ----------- | ------------------------------------------------- | ------------------------------------------------ | ------------------------------------------------ |
| Dashboard   | [Screenshot](screenshots/dashboard-desktop.png)   | [Screenshot](screenshots/dashboard-tablet.png)   | [Screenshot](screenshots/dashboard-mobile.png)   |
| Post editor | [Screenshot](screenshots/editor-desktop.png)      | [Screenshot](screenshots/editor-tablet.png)      | [Screenshot](screenshots/editor-mobile.png)      |
| Categories  | [Screenshot](screenshots/categories-desktop.png)  | [Screenshot](screenshots/categories-tablet.png)  | [Screenshot](screenshots/categories-mobile.png)  |
| Profile     | [Screenshot](screenshots/profile-desktop.png)     | [Screenshot](screenshots/profile-tablet.png)     | [Screenshot](screenshots/profile-mobile.png)     |
| Site editor | [Screenshot](screenshots/site-editor-desktop.png) | [Screenshot](screenshots/site-editor-tablet.png) | [Screenshot](screenshots/site-editor-mobile.png) |

| Public post | [Screenshot](screenshots/public-desktop.png) | — | [Screenshot](screenshots/public-mobile.png) |

Run the checks with the commands in [README](../README.md).

## Boundaries that remain

| Boundary                  | Meaning                                                                                                                                                                                                                                                                              |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Complete WordPress parity | Every core screen, state, keyboard command, accessibility detail and extension point has not been exhaustively reproduced or compared. No running reference installation or pixel-diff baseline was available.                                                                       |
| Themes                    | The four React presentations and editable supported templates do not reproduce every bundled PHP theme/template/variation. A familiar theme name does not imply arbitrary WordPress-theme compatibility.                                                                             |
| Gutenberg                 | A selected set of official blocks is enabled. WordPress-specific dynamic/query blocks, arbitrary third-party blocks, full synced/reusable entity semantics, every pattern source and every provider are not claimed. Eight WorldAct bindings support the implemented site templates. |
| PHP/extension ecosystem   | Arbitrary PHP plugins/themes, WordPress.org package downloads, installer/updater/recovery/filesystem-editor workflows and external plugin marketplaces are unsupported. The local JavaScript registry has four implemented modules.                                                  |
| REST/capabilities         | REST coverage is a subset. Full schemas, all query parameters/authentication modes, arbitrary plugin routes, custom capability registration and universal client compatibility are not claimed.                                                                                      |
| Content model             | Posts/pages and categories/tags are implemented. Arbitrary custom post types/taxonomies/fields, format-specific templates and archives and multisite/network administration are unsupported.                                                                                         |
| Operational services      | Scheduled publishing requires the Node process to be running. SMTP is optional; email otherwise stays in the local outbox. No hosted update/news/event service, trackback/pingback service or complete privacy-erasure workflow is implemented.                                      |
| Security/dependencies     | Tests are not a security certification. The recorded npm audit has 19 low findings from transitive `deepmerge@4.3.1`, no fixed compatible release, and no forced Gutenberg downgrade.                                                                                                |

The supplied default Modern admin scheme uses a `#1e1e1e` menu, approximately `#0c0c0c` submenus, `#f0f0f0` page background and `#3858e9` accent. Selected source color schemes are loaded per profile. Reference dimensions include a 160px expanded menu, 36px collapsed menu, 32px desktop toolbar and 46px mobile toolbar. These source-based targets guide the interface; they do not establish exact screen-for-screen equality.
