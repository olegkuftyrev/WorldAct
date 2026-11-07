# WorldAct 0.2

A personal study project rebuilding familiar WordPress CMS workflows with **React, TypeScript, Node.js, and PostgreSQL**. The application runs without PHP or MySQL.

WorldAct now includes the official Gutenberg React editor, publishing workflows, site editing, navigation, native JavaScript extensions, media editing, and content portability. **Complete WordPress parity and exact pixel matching have not been established.** The four React theme presentations and local extension registry are WorldAct implementations; arbitrary PHP themes and plugins cannot run here. See the [parity tracker](docs/parity.md).

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

- Posts and pages: categories, tags, hierarchical pages, featured images, excerpts, post-format classification, sticky posts, comment settings, drafts, pending review, publishing, scheduling, private/password-protected content, trash, revisions, autosave/recovery, and version conflict protection.
- Official Gutenberg: 27 core block types, nested layouts, rich text, transforms, insertion, list view, block inspector, undo/redo, media selection, saved patterns, and YouTube/Vimeo embeds. Other embed providers are not enabled.
- Site design: editable templates, template parts, patterns, eight live site/post binding blocks, global colors/typography/layout, hierarchical navigation, and four limited React theme presentations.
- Extensions: install, activate, configure, deactivate, and remove Reading Time, Spam Shield, Site SEO, and Custom Footer from the local JavaScript registry.
- Administration: dashboard preferences, five roles, account/profile editing, admin color schemes, password recovery, seven settings sections, site health, a local mail outbox, and personal-data export.
- Media: uploads up to 32 MiB for supported images, audio, video, PDF, and Office formats; image crop/rotate/flip/resize/restore; configurable generated image sizes and year/month folders.
- Public site: archives/search, configured permalinks, static home/posts pages, comments, RSS/Atom and comment feeds, sitemap/robots output, and a supported subset of `/wp-json/wp/v2`.
- Portability: WorldAct JSON and WordPress XML (WXR) export/import. See the exact boundaries below.

## Portability and email

JSON import restores posts/pages, canonical Gutenberg data, terms, page/category hierarchy, and comments. JSON exports also include navigation, design, settings, and media reference data; these additional sections are **not restored by JSON import**. Media file bytes, account passwords, and sessions are excluded. Scheduled and password-protected imports become drafts for review. URLs are preserved when available and made unique on collision.

WXR supports the implemented content, taxonomy, hierarchy, and comment workflows. It does not download remote attachment files; the import response warns about skipped attachments and retains existing media URLs. Upload those files separately. The Tools interface accepts export files up to 8 MB.

Password recovery writes to **Tools → Mail** by default, with no external delivery. Optional SMTP uses `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASSWORD`, and `SMTP_FROM`. Without SMTP, an administrator can retrieve local reset messages from the mail outbox.

## Checks and compiled server

With the API and PostgreSQL running:

```sh
npm run typecheck
npm test
npm run build
```

The test suite runs sequentially and uses the administrator credentials in `.env`. Integration checks create temporary records, exercise real API/database workflows, and clean up afterward; platform checks temporarily change and restore settings. `TEST_API_URL` can override the default API test address.

To serve the compiled application locally:

```sh
npm run build
NODE_ENV=development APP_ORIGIN=http://127.0.0.1:3001 npm start
```

Open [the compiled application](http://127.0.0.1:3001). The server serves the built client, API, feeds, and uploads from one origin. Set `APP_ORIGIN` to the exact browser origin: writes from other origins are rejected. For an HTTPS reverse proxy, use `NODE_ENV=production` and the HTTPS origin so session cookies receive the Secure flag. Node binds to loopback. When moving the site to another origin, update Settings → General → Site URL for absolute feed and sitemap links.

Run migrations or seeding separately with `npm run db:migrate` and `npm run db:seed`. Stop/restart the local database with `docker compose stop db` / `docker compose up -d db`.

The current dependency audit reports **19 low-severity findings**, all propagated from the transitive `deepmerge@4.3.1` advisory [GHSA-gcqx-w48m-w2h4](https://github.com/advisories/GHSA-gcqx-w48m-w2h4). No fixed compatible release was available at verification time. The suggested forced downgrade of Gutenberg packages is not applied.

[Architecture](docs/architecture.md) · [Parity and verification](docs/parity.md) · [Screenshots](docs/screenshots/) · [Notices](NOTICE.md) · [GPL-2.0-or-later](LICENSE)
