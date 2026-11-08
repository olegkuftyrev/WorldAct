# WorldAct 0.4

A personal study project rebuilding familiar WordPress CMS workflows with **React, TypeScript, Node.js, and PostgreSQL**. The application runs without PHP or MySQL.

WorldAct includes the official Gutenberg React editor, publishing workflows, full-site content archives, application passwords, saved list preferences, user and media bulk controls, and source-based block themes. The three supplied block themes contribute **28 templates, 15 template parts, 164 patterns and 25 theme style variations**, with their original fonts and assets. **Complete WordPress parity and exact pixel matching have not been established.** Arbitrary PHP themes and plugins cannot execute in this stack. See the [parity tracker](docs/parity.md).

The supplied WordPress distribution declares version **7.1.4** and serves as a source and visual reference. It contains no configured site database or uploads. Its PHP/MySQL application has not been run for this project.

## Run locally

Requires **Node.js 22.13.0 or newer** and a running Docker installation with Compose.

```sh
git clone https://github.com/olegkuftyrev/WorldAct.git
cd WorldAct
npm ci
npm run setup
npm run dev
```

Open [WorldAct admin](http://127.0.0.1:5173/admin). Sign in with `ADMIN_EMAIL` and `ADMIN_PASSWORD` from the ignored local `.env` file. Setup generates a unique password when creating `.env`; the initial username is `admin`.

Setup starts PostgreSQL 17 on `127.0.0.1:54329`, migrates the schema, and seeds the administrator, Hello world! post, Sample Page, sample comment, and default site designs. Re-running setup preserves existing content. Copy and edit `.env.example` before first setup to choose your own configuration. Changing the environment password afterward does not replace an existing account password.

Vite runs at `127.0.0.1:5173`; the Node API runs at `127.0.0.1:3001`. PostgreSQL uses the persistent `worldact_pgdata` Docker volume. Uploaded files and generated image sizes live in the ignored `uploads/` directory. Back up **both the database and uploads**; content exports are not complete backups.

## Included workflows

- Posts and pages: categories, tags, hierarchical pages, featured images, excerpts, post-format classification, sticky posts, comment settings, drafts, pending review, publishing, scheduling, private/password-protected content, trash, revisions, autosave/recovery, author assignment, full bulk metadata editing, and version conflict protection.
- Official Gutenberg: static and dynamic core blocks, Query Loop and post metadata, nested layouts, rich text, footnotes with shared content/history/autosave, transforms, insertion, list view, block inspector, undo/redo, media selection, synced and unsynced patterns, and YouTube/Vimeo embeds. Other embed providers are not enabled.
- Site design: source templates, per-post/page template assignment, template parts, patterns, theme.json styles, original theme variations/fonts/assets, per-theme customizations and source reset; native site identity/navigation, Query Loops/totals, term loops/names/counts, breadcrumbs, page-list items, social links, search, comment blocks, Latest Posts/Comments, Archives, Calendar, Tag Cloud and reading time. Login/Out supports a real login form, Remember Me, logout and local return URLs. Date archive links retain site-local year/month/day/week filters. Font Library installs bundled fonts or uploads validated TTF, OTF, WOFF and WOFF2 files, with theme-specific activation and typography. A legacy WorldAct Classic presentation remains available.
- Extensions: install, activate, configure, deactivate, and remove Reading Time, Spam Shield, Site SEO, Custom Footer, and Node ports of the supplied Hello Dolly and Akismet plugins. Akismet processing requires explicit enablement, a configured key, and service verification; its credentials stay outside exported extension settings.
- Administration: persistent Screen Options/Help, dashboard preferences, five roles, searchable/paginated Users with bulk role/deletion actions, profile/application-password management, registration, account notification/reset links, admin color schemes, seven settings sections, confirmed administrator-email changes, a source-preserving site-icon cropper, custom date/time formats, week start, categorized Site Health information, a privacy-policy draft guide, local mail/optional SMTP, and confirmed privacy requests. Default theme/menu permissions are administrator-only.
- Comments: search, Mine, owner-aware author/contributor actions, full/quick editing, replies, moderator bulk/Empty controls, approval-preserving restore, optimistic conflicts, keyword/link/previous-approval rules, notifications, configurable paging/threads, Gravatar settings, and explicit remembered-author consent using an opaque HttpOnly cookie. Read-only rows and public DTOs omit personal email addresses.
- Media: 32 MiB supported uploads, server search/type/date/unattached filters and paging, persistent list/grid preferences, attachment detail routes, attach/detach/bulk deletion, metadata and image crop/rotate/flip/resize/restore, configurable generated sizes and year/month folders.
- Public site: archives/search, configured permalinks, static home/posts pages, comments, RSS/Atom and comment feeds, sitemap/robots output, and a supported subset of `/wp-json/wp/v2`.
- Portability: WorldAct JSON and WordPress XML (WXR) export/import. See the exact boundaries below.

## Portability and email

JSON v3 archives embed supported uploads, original versions, generated image sizes and Font Library files, with MIME/signature, path, size and SHA-256 checks. Import copies posts/pages, comments, terms, synced patterns, navigation and design documents into new IDs and rewrites nested references, template assignments, font references and local URLs. Existing live settings/design stay active by default. The explicit **Replace site design and settings** checkbox activates the imported menus, supported settings/styles, extensions, fonts and theme variations while retaining the destination URL and administrator contact. Rollback removes staged files. Account, session and Akismet credentials are excluded; scheduled and password-protected imports become drafts for review. Limits: 32 MiB per media file, 8 MiB per font, 64 MiB combined decoded files, 96 MiB JSON.

WXR carries implemented posts/pages, terms/hierarchy, threaded comments, synced patterns and block-navigation entities. It rewrites nested references, allocates a shared export ID space and rolls back failed imports. Remote attachment files are not downloaded; original URLs remain and warnings identify skipped files. WXR import is limited to 8 MB. Neither format replaces database and filesystem backups, user accounts, all history or unsupported extension data.

Password recovery writes to **Tools → Mail** by default, with no external delivery. Optional SMTP uses `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASSWORD`, and `SMTP_FROM`. Without SMTP, an administrator can retrieve local reset messages from the mail outbox.

Registration is disabled by default. Enable it in Settings → General and choose the default role. New users receive a single-use password-setting link through the configured mail channel. Privacy requests require email confirmation or explicit administrator confirmation. Export links expire after three days. Erasure anonymizes matching comment authors and revokes earlier exports; accounts, profile fields, authored content, comment text and request records are retained. Account deletion is a separate Users workflow.

## Checks and compiled server

With local PostgreSQL running:

```sh
npm run typecheck
npm run test:isolated
npm run build
```

The isolated runner creates a disposable local database, upload directory and API on port 3004, forces mail to the local outbox, and removes its database/files afterward. It restarts the API between test files so the production login limit remains unchanged. It does not change your configured site data. `ISOLATED_TEST_PORT` changes the test port; `ISOLATED_TEST_COMPILED=true` tests a fresh compiled build. `npm test` instead targets an already-running API and the database in the environment; those tests temporarily change and restore settings. `TEST_API_URL` overrides that API address.

The cross-site archive test has separate export/restore phases on fresh databases; see [verification](docs/parity.md).
The GitHub Actions workflow runs source and compiled checks on Node 22/24 with PostgreSQL 17, plus fresh-database site/font archive restores on Node 24. Test credentials and storage are disposable; SMTP is forced off.
To serve the compiled application locally:

```sh
npm run build
NODE_ENV=development APP_ORIGIN=http://127.0.0.1:3001 npm start
```

Open [the compiled application](http://127.0.0.1:3001). The server serves the built client, API, feeds, and uploads from one origin. Set `APP_ORIGIN` to the exact browser origin: writes from other origins are rejected. For an HTTPS reverse proxy, use `NODE_ENV=production` and the HTTPS origin so session cookies receive the Secure flag. Node binds to loopback. When moving the site to another origin, update Settings → General → Site URL for absolute feed and sitemap links.

Run migrations or seeding separately with `npm run db:migrate` and `npm run db:seed`. Stop/restart the local database with `docker compose stop db` / `docker compose up -d db`.

The current dependency audit reports **19 low-severity findings**, all propagated from the transitive `deepmerge@4.3.1` advisory [GHSA-gcqx-w48m-w2h4](https://github.com/advisories/GHSA-gcqx-w48m-w2h4). No fixed compatible release was available at verification time. The suggested forced downgrade of Gutenberg packages is not applied.

[Architecture](docs/architecture.md) · [Parity and verification](docs/parity.md) · [Screenshots](docs/screenshots/) · [Notices](NOTICE.md) · [GPL-2.0-or-later](LICENSE)
