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

Setup starts PostgreSQL 17 on `127.0.0.1:54329`, migrates the schema, and seeds the administrator, Hello world! post, complete Sample Page, formatted sample comment, private Privacy Policy draft, inactive bundled plugins, and default site designs. Re-running setup preserves existing content, including deleted defaults. Copy and edit `.env.example` before first setup to choose your own configuration. Changing the environment password afterward does not replace an existing account password.

For a fresh site, use `npm run setup:browser` instead of `npm run setup` to choose the site title and administrator in the browser. Preparation migrates PostgreSQL without seeding and prints a private `/install#token=…` link. Start `npm run dev` and open that link; the installer clears the fragment immediately and keeps its token in memory only. Installation runs once, then directs you to normal login. An initialized site cannot be reset through the installer.

Vite runs at `127.0.0.1:5173`; the Node API runs at `127.0.0.1:3001`. PostgreSQL uses the persistent `worldact_pgdata` Docker volume. Uploaded files and generated image sizes live in the ignored `uploads/` directory. Back up **both the database and uploads**; content exports are not complete backups.

## Included workflows

- Posts and pages: categories, tags, hierarchical pages, featured images, excerpts, post-format classification, sticky posts, comment settings, drafts, pending review, publishing, scheduling, private/password-protected content, trash, revisions, autosave/recovery, author assignment, full bulk metadata editing, and version conflict protection.
  Fixed local publication dates and dated URLs survive site timezone changes; explicit edits use the current site zone.
  Publishing uses the selected date and the save-time minute boundary; bulk Publish Now resets drafts and scheduled posts to the actual save time. See the [publication policy](server/publication-status.md).
- Public named-author queries: persisted nicename selection, numeric intersections, independent listing counters, safe empty results and retained path identity. See the [bounded query contract](server/author-query.md).
- Official Gutenberg: static and dynamic core blocks, Query Loop and post metadata, nested layouts, rich text, footnotes with shared content/history/autosave, native Accordion and Tabs with keyboard/hash navigation, background images, transforms, insertion, list view, block inspector, undo/redo, media selection, synced and unsynced patterns, and YouTube/Vimeo embeds. Other embed providers are not enabled.
- Classic and Shortcode: the supplied TinyMCE editor, source links/image/media dialogs, galleries, Save/Cancel, conversion, Undo/Redo, autosave and revisions. Initial image selection uses the attachment's safe rich caption and canonical source caption shortcode; empty captions retain bare images. Literal caption shortcode text stays inert through editing and public rendering. Independent browser review passed rich/literal initial captions, second image edit/save, conversion, Undo/Redo, cancellation, delayed-upload ownership and responsive public output, alongside the earlier mixed-markup release. Broader legacy media-view adapters remain tracked separately.
- Site design: source templates, per-post/page template assignment, template parts, patterns, theme.json styles, original theme variations/fonts/assets, per-theme customizations and source reset; native site identity/navigation, Query Loops/totals, term loops/names/counts, breadcrumbs, page-list items, social links, search, comment blocks, Latest Posts/Comments, Archives, Calendar, Tag Cloud and reading time. Login/Out supports a real login form, Remember Me, logout and local return URLs. Date archive links retain site-local year/month/day/week filters. Font Library installs bundled fonts or uploads validated TTF, OTF, WOFF and WOFF2 files, with theme-specific activation and typography. A legacy WorldAct Classic presentation remains available.
- Extensions: install, activate, configure, deactivate, and remove Reading Time, Spam Shield, Site SEO, Custom Footer, and Node ports of the supplied Hello Dolly and Akismet plugins. Akismet processing requires explicit enablement, a configured key, and service verification; its credentials stay outside exported extension settings. Settings → Connectors shares the actual Akismet credential, processing consent and verification state with Plugins.
- Administration: persistent Screen Options/Help, dashboard preferences, five roles, searchable/paginated Users with bulk role/deletion actions, profile/application-password management, registration, account notification/reset links, admin color schemes, eight settings sections, confirmed administrator-email changes, a source-preserving site-icon cropper, custom date/time formats, week start, categorized Site Health information, a privacy-policy draft guide, local mail/optional SMTP, and confirmed privacy requests. Default theme/menu permissions are administrator-only.
- Comments: search, Mine, owner-aware author/contributor actions, full/quick editing, replies, moderator bulk/Empty controls, approval-preserving restore, optimistic conflicts, keyword/link/previous-approval rules, notifications, configurable paging/threads, Gravatar settings, and explicit remembered-author consent using an opaque HttpOnly cookie. Threaded pagination counts roots and retains their approved descendants; actual ancestry limits Reply independently of visual indentation. Duplicate retries are rejected before insertion or notifications, and human approval uses current account authority and source-style identity history. The fixed 15-second flood interval covers ordinary human comments and incoming pingbacks/trackbacks using persisted identity history and private one-hour IP metadata with personal export/erasure support; [flood policy and boundaries](server/comment-flood.md) describe moderator exceptions, separate attempt caps, and generic incoming protocol errors. Read-only rows and public DTOs omit personal email addresses.
- Media: 32 MiB supported uploads, server search/type/date/unattached filters and paging, persistent list/grid preferences, attachment detail routes, attach/detach/bulk deletion, metadata and image crop/rotate/flip/resize/restore, zero-compatible configured sizes and year/month folders. Verified JPEG/PNG/GIF/WebP/AVIF formats are preserved; large uploads get a normalized full image, retained raw download and source additional sizes. Manual Restore returns to the normalized original.
- Public site: archives/search, source Plain/Day and name/Month and name/Numeric/Post name permalink presets and supported custom structures (including hour/minute/second and author tags), static home/posts pages, typed comments, RSS/Atom and comment feeds, sitemap/robots output, and a supported subset of `/wp-json/wp/v2`. Pretty author archives use stored account nicenames, the configured permalink front, independent archive pagination and author-specific templates; Plain author links remain numeric. Production-only fixed pingback/trackback receivers use actual moderation, duplicate protection and public-only verification; outgoing publication services remain suppressed in the local study environment. The compiled Node server renders complete public HTML with native public forms and actual 200/404 status. JavaScript-enabled openings validate one fresh document model before revealing or hydrating the page; genuinely script-disabled requests retain their authorized initial HTML. Documents use private cache headers and explicit route/account/history ownership. See [server rendering](server/public-document-ssr.md), [routing/status](server/public-http-status.md), [author archive boundaries](server/pretty-author-archives.md), and [notification boundaries](server/incoming-pings.md).
- Additional server ports: safe MathML/LaTeX, 88 bundled icons, source More/Page Break pagination, custom Navigation overlays, bounded RSS/Atom feed blocks, playlists with script-free audio fallback, and fixed legacy media shortcodes. Native Playlist/RSS controls and public playback passed independent browser review; the [parity tracker](docs/parity.md) records remaining legacy media work. Audio uploads and restored files expose bounded artist/album/duration metadata and verified embedded artwork.
- Portability: WorldAct JSON and WordPress XML (WXR) export/import, including bounded rebasing of known published body-page links across fresh IDs and destination permalink settings. See the [body-page contract](server/body-page-portability.md) and exact boundaries below.

## Portability and email

JSON v4 archives preserve local publication dates and nullable selected GMT in a coherent snapshot, and embed supported uploads, original versions, generated image sizes and Font Library files, with MIME/signature, path, size and SHA-256 checks. Import copies posts/pages, comments, terms, synced patterns, navigation and design documents into new IDs and rewrites nested references, template assignments, font references and local URLs. Existing live settings/design stay active by default. The explicit **Replace site design and settings** checkbox activates the imported menus, supported settings/styles, extensions, fonts and theme variations while retaining the destination URL and administrator contact. Rollback removes staged files. Account, session and Akismet credentials are excluded; scheduled and password-protected imports become drafts for review. Limits: 32 MiB per media file, 8 MiB per font, 64 MiB combined decoded files, 96 MiB JSON.

WXR carries implemented posts/pages, terms/hierarchy, threaded comments, synced patterns and block-navigation entities. It rewrites nested references, allocates a shared export ID space and rolls back failed imports. Post date filters use stored local publication fields, and local XML dates remain distinct from selected GMT. Remote attachment files are not downloaded; original URLs remain and warnings identify skipped files. WXR import is limited to 8 MB. Neither format replaces database and filesystem backups, user accounts, all history or unsupported extension data.

Password recovery writes to **Tools → Mail** by default, with no external delivery. Optional SMTP uses `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASSWORD`, and `SMTP_FROM`. Without SMTP, an administrator can retrieve local reset messages from the mail outbox.

**Settings → Writing** has separate **Save Mail Settings** and **Check Mail Now** controls for the optional mailbox importer. Checks use the saved enabled configuration; blank passwords retain the write-only secret and explicit clearing disables checks. Automatic polling is an optional production setting. Mailbox intake starts disabled; ordinary site settings do not save mailbox drafts.

Profile email changes also require confirmation while signed in to the account that requested the change. The active email remains in use until confirmation; Profile shows the pending address, expiry, resend and cancel controls. An administrator editing another account updates that address immediately. Personal Options control the public toolbar and opt-in comment keyboard shortcuts; the administration toolbar remains visible. Tools → Export offers filtered Posts, Pages and Media XML separately from the full JSON archive. Settings → Media accepts zero to disable a configured size or leave one axis unconstrained.

Registration is disabled by default. Enable it in Settings → General and choose the default role. New users receive a single-use password-setting link through the configured mail channel. Privacy requests require email confirmation or explicit administrator confirmation. Export links expire after three days. Erasure anonymizes matching comment authors and revokes earlier exports; accounts, profile fields, authored content, comment text and request records are retained. Account deletion is a separate Users workflow.

## Checks and compiled server

With local PostgreSQL running:

```sh
npm run typecheck
npm run build
npm run test:isolated
```

Both `npm test` and `npm run test:isolated` create a disposable local database, upload directory and API on port 3004, force mail to the local outbox, and remove their database/files afterward. The runner restarts the API between test files so the production login limit remains unchanged. It leaves your configured site's data alone. `ISOLATED_TEST_PORT` changes the test port; `ISOLATED_TEST_COMPILED=true` tests a fresh compiled build. Use `npm test -- tests/example.test.ts` for selected files. Every test imports a guard before application modules; direct test invocations without the runner's disposable database, upload directory, API and outbox context stop before fixtures run.

Build before the full suite: public HTTP status checks compare responses with the actual built React document and verify its assets.

The cross-site archive test has separate export/restore phases on fresh databases; see [verification](docs/parity.md).
The GitHub Actions workflow runs source and compiled checks on Node 22/24 with PostgreSQL 17, plus fresh-database site/font archive restores on Node 24. Test credentials and storage are disposable; SMTP is forced off.
To serve the compiled application locally:

```sh
npm run build
NODE_ENV=development APP_ORIGIN=http://127.0.0.1:3001 npm start
```

Open [the compiled application](http://127.0.0.1:3001). The server serves the built client, API, feeds, and uploads from one origin. Set `APP_ORIGIN` to the exact browser origin: writes from other origins are rejected. For an HTTPS reverse proxy, use `NODE_ENV=production` and the HTTPS origin so session cookies receive the Secure flag. Node binds to loopback. When moving the site to another origin, update Settings → General → Site URL for absolute feed and sitemap links.

Run migrations or seeding separately with `npm run db:migrate` and `npm run db:seed`. Stop/restart the local database with `docker compose stop db` / `docker compose up -d db`.

The current dependency audit reports **22 low-severity findings**, all propagated from the transitive `deepmerge@4.3.1` advisory [GHSA-gcqx-w48m-w2h4](https://github.com/advisories/GHSA-gcqx-w48m-w2h4). No fixed compatible release was available at verification time. The suggested forced downgrade of Gutenberg packages is not applied.

[Architecture](docs/architecture.md) · [Parity and verification](docs/parity.md) · [Screenshots](docs/screenshots/) · [Notices](NOTICE.md) · [GPL-2.0-or-later](LICENSE)
