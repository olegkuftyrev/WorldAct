# WordPress parity tracker

WorldAct is a personal study project rebuilding WordPress workflows with React and PostgreSQL. The target is the supplied WordPress interface and behavior, with WorldAct branding. **The full rewrite and exact 1:1 parity are not complete.** This document separates the first usable slice from the remaining work.

## Reference baseline

The local reference is `/Users/olegkuftyrev/Desktop/wordpress`. Its `wp-includes/version.php` declares WordPress **7.1.4** and database version `61833`. This is the version reported by the supplied files, not an independently verified upstream release.

The folder is an unconfigured distribution: it has no `wp-config.php`, uploaded media library, or database export. It supplies screen definitions and static assets, rather than an installed site's content, users, active theme, or screen preferences. Bundled themes include Twenty Twenty-Five 1.5, Twenty Twenty-Four, and Twenty Twenty-Three. The initial WorldAct sample data is its own fixture.

Reference files are data for this study. Their installation instructions do not authorize running PHP, MySQL, or modifying the reference distribution.

## Status convention

- **Planned:** included in the initial implementation contract; functioning behavior has not yet been confirmed.
- **Implemented:** matching source exists; runtime verification may still be pending.
- **Verified:** the named behavior has been exercised successfully. This does not establish complete WordPress parity.
- **Deferred:** outside the first slice.

The first slice is implemented. The statuses below distinguish exercised workflows from screens whose code exists but has not had every interaction checked. None of these statuses establishes exact screen-for-screen or behavior-for-behavior WordPress parity.

## First-slice contract

| Screen or workflow | Initial behavior                                                                                          | Status                                                            |
| ------------------ | --------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| Login              | WorldAct branding, username/email and password, server session, logout, explicit failure states           | Verified (UI and API)                                             |
| Admin shell        | Toolbar, left navigation, active submenus, collapse, responsive layout, real navigation                   | Verified (desktop/mobile core navigation)                         |
| Dashboard          | Welcome panel and dismissal, At a Glance, Activity, persisted Quick Draft                                 | Verified (rendering, collapse, Quick Draft/reload)                |
| Posts and Pages    | Separate lists, status counts, search, draft/published/trash filters, bulk trash/restore/permanent delete | Verified (API); list UI implemented                               |
| Content editor     | Title and simple paragraph, heading, list, quote, and image blocks; save draft and publish                | Verified (UI draft/save/reload/publish); block subset implemented |
| Media              | File upload, library grid, attachment title/alt/caption editing, delete                                   | Verified (API upload/metadata/delete); UI implemented             |
| Comments           | List and moderation between pending, approved, spam, and trash; permanent delete                          | Verified (API moderation and public submission UI)                |
| Users              | User list, add user, assign supported role, remove user with safeguards                                   | Verified (API roles/create/delete); UI implemented                |
| Settings           | General and reading values backed by PostgreSQL                                                           | Implemented; API access controls verified                         |
| Public site        | Published post index, individual posts/pages, submitted comments awaiting moderation                      | Verified (publishing, detail, comment form, pagination API)       |
| Appearance         | Choice between two limited React presentations; not full original theme implementations                   | Implemented (two limited React presentations)                     |
| Route aliases      | `/wp-admin` redirects to `/admin`; `/wp-login.php` redirects to `/login`                                  | Verified (built-server HTTP redirects)                            |

Visible controls must perform their described action, navigate to implemented content, or explain the unavailable scope. Unsupported plugin installation and updates must not appear successful.

## Visual reference checklist

The supplied version defaults new users to the **Modern** color scheme. `wp-admin/css/colors/modern/colors.css` overrides the older base colors: the menu is `#1e1e1e`, its submenu is approximately `#0c0c0c`, the page background is `#f0f0f0`, and the accent is `#3858e9`. The base stylesheet's `#1d2327` menu and `#f0f0f1` page are not the full default appearance.

Use the reference to compare:

- System font stack, 13px base typography, heading weights, link colors, button states, field heights, notices, focus rings, and spacing.
- A 160px expanded menu, 36px folded menu, 32px desktop toolbar, and 46px toolbar at the mobile breakpoint.
- Dashboard cards and welcome panel with 8px corners, the supplied dark welcome background, widget headers, content padding, and column breakpoints.
- Posts/pages list headers, status links, row actions, checkboxes, bulk controls, search, empty states, and selection behavior.
- Keyboard focus, hover/flyout menus, collapsed navigation, loading states, error states, and narrow-screen layouts.

Relevant sources are `wp-admin/index.php`, `wp-admin/menu.php`, `wp-admin/includes/dashboard.php`, `wp-admin/css/`, `wp-includes/css/admin-bar.css`, and `wp-includes/css/dist/base-styles/admin-schemes.css`. The welcome artwork is `wp-admin/images/dashboard-background.svg`. WordPress's complete stylesheet registry is in `wp-includes/script-loader.php`; `wp-admin/css/wp-admin.css` alone omits some dependencies.

Copy only required static CSS, icons, fonts, and artwork, retaining notices and attribution. Do not copy PHP runtime files into WorldAct. Matching static CSS is a useful foundation; it is not evidence that all screens or interactions match 1:1.

## Deliberate first-slice limitations

| Area                        | Remaining parity work                                                                                                                                                                                                                                                         |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Gutenberg and site editing  | Full block editor, block transforms, nested blocks, patterns, reusable/synced blocks, template editing, global styles, accessibility behavior, keyboard commands, and editor extensibility. The initial simple block editor is a subset.                                      |
| Plugins and themes          | PHP plugins and PHP themes cannot run in the required stack. Equivalent functionality needs JavaScript implementations and a defined WorldAct extension API. Limited theme selection is not arbitrary WordPress-theme compatibility.                                          |
| WordPress REST API          | WorldAct uses a custom `/api` contract. Full `/wp-json/wp/v2` endpoints, schemas, capabilities, authentication modes, extension behavior, and compatibility are deferred.                                                                                                     |
| Revisions and autosave      | Revision history, comparison/restore, server autosave, edit locks, recovery, and concurrent editing are deferred.                                                                                                                                                             |
| Publishing workflows        | Scheduling, private/password-protected content, pending review, sticky posts, post formats, and complete status-transition/permission behavior are deferred. Initial post/page states are published, draft, and trash.                                                        |
| Taxonomy and content types  | Categories, tags, custom taxonomies, custom fields, custom post types, hierarchical page controls, and permalink variations are deferred.                                                                                                                                     |
| Multisite                   | Network installation, sites, network administration, domain mapping, and per-site roles/settings are deferred.                                                                                                                                                                |
| Installation and updates    | WordPress's installer, self-update, plugin/theme downloads, update checks, recovery mode, and filesystem editor are deferred. Local migration and seed commands initialize WorldAct.                                                                                          |
| Syndication and portability | RSS/Atom feeds, trackbacks/pingbacks, WXR import/export, WordPress migration, and export/personal-data workflows are deferred.                                                                                                                                                |
| Media                       | Complete image editing, generated sizes, galleries, audio/video workflows, and WordPress's attachment selection modal are deferred.                                                                                                                                           |
| Users and settings          | Full profile management, password reset/email delivery, configurable user reassignment, application passwords, all settings pages, and the full WordPress capability model are deferred. Deleting another user currently reassigns their content to the acting administrator. |
| Dashboard services          | WordPress Events/News, comprehensive Site Health, persistent drag-and-drop widget arrangements, and all Screen Options/Help behavior are deferred unless separately confirmed.                                                                                                |
| Public themes               | Exact rendering of every bundled theme/template, archive/search views, advanced archive/permalink behavior, widgets, menus, SEO integrations, and multilingual behavior are deferred. Basic server-backed post pagination is implemented.                                     |

## Verification record

Verified on November 6, 2026 against the local PostgreSQL container:

- Setup, migration, and repeated seed succeeded without duplicating the initial content.
- The API integration suite passes all 15 workflow subtests (16 tests including the parent), covering session protection/revocation, origin checks, persisted drafts, partial-update preservation, publication/sanitization, pagination, moderation, image upload/metadata, rejected SVG, authorship/page restrictions, and trash/restore. Test records were removed afterward.
- A real browser created a draft in the React editor, saved/reloaded it, published it, opened the public post, and submitted a comment that remained pending. The temporary post/comment were removed.
- TypeScript and the client/server build pass. The built server serves public and nested admin routes, its database health endpoint, and the legacy URL redirects.
- Independent browser review passed for the bounded first slice at 1440px, 768px, and 375px widths after artwork, footer, column, search, and mobile editor fixes.
- Desktop/mobile dashboard screenshots are in screenshots/. Visual review is against source CSS/markup and browser behavior; no running original WordPress instance or exhaustive pixel comparison is claimed.

WordPress XML import/export remains deferred. Tools provides a basic JSON export of accessible non-trash posts/pages; it excludes media files and is not a full backup or WordPress WXR export.
