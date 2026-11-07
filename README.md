# WorldAct

A personal study project rebuilding the WordPress CMS experience with **React, TypeScript, Node.js, and PostgreSQL**. PHP and MySQL are not part of the application or development stack.

The supplied WordPress distribution (declared version 7.1.4) is the visual and behavior reference. Its original static admin styles and Dashicons are reused with attribution, and the product is branded WorldAct. The reference contains no configured database or site content to import.

**This is the first working milestone, not complete WordPress parity.** The initial implementation covers the admin shell, dashboard, posts/pages, a simplified content editor, media, comments, users, settings, and public publishing. See [the parity tracker](docs/parity.md) for exact scope and remaining work. Existing PHP plugins and PHP themes cannot execute in this stack; their behavior needs JavaScript implementations.

## Run locally

Requires Node.js 22 or later and Docker with Compose, running locally.

```sh
git clone https://github.com/olegkuftyrev/WorldAct.git
cd WorldAct
npm ci
npm run setup
npm run dev
```

Open **http://127.0.0.1:5173/admin**. Sign in with `ADMIN_EMAIL` and `ADMIN_PASSWORD` from the local `.env` file. Setup creates a unique local administrator password when `.env` is missing. `.env` is ignored by Git. The first administrator uses username `admin`.

Setup starts PostgreSQL on `127.0.0.1:54329`, applies the schema, and seeds the initial administrator, Hello world! post, Sample Page, and a sample comment. Re-running setup does not reset existing content. To customize before first setup, copy `.env.example` to `.env` and edit it. Once seeded, changing the environment password does not silently replace the database password.

The React dev server runs on port 5173 and forwards `/api` and `/uploads` to Node on port 3001. PostgreSQL stores content and sessions; media files live in the ignored local `uploads/` directory. A named Docker volume preserves the database across restarts. Back up both the PostgreSQL volume and uploads for content preservation.

## Commands

```sh
npm run typecheck
npm run build
npm test
```

`npm test` is an integration suite against the running API and PostgreSQL, using the administrator credentials in `.env`. It creates uniquely named test content and removes it afterward. It verifies authentication, draft visibility, publishing and HTML sanitization, comment moderation, uploads, roles, trash/restore, and session revocation.

To serve the compiled application locally:

```sh
npm run build
NODE_ENV=development APP_ORIGIN=http://127.0.0.1:3001 npm start
```

Open http://127.0.0.1:3001. A deployment behind HTTPS uses `NODE_ENV=production` and its HTTPS `APP_ORIGIN` so session cookies receive the Secure flag. The API serves the built React app and handles direct client-side route navigation. Set `APP_ORIGIN` to the exact address used in the browser; writes from other origins are rejected.

Stop the local database with `docker compose stop db`; restart it with `docker compose up -d db`. The schema migration and seed can also be run separately using `npm run db:migrate` and `npm run db:seed`.

## Project layout

- `src/`: React administration screens and public site.
- `server/`: Node API, authentication, SQL schema, migration, and seed.
- `public/vendor/wordpress/`: attributed WordPress static visual assets.
- `tests/`: real API/database workflow checks.
- `docs/`: architecture and parity tracking.

[Architecture](docs/architecture.md) · [Parity tracker](docs/parity.md) · [Asset notices](NOTICE.md) · [GPL-2.0-or-later license](LICENSE)
