# One-time browser installation backend

The supplied `wp-admin/install.php` is reference material only. PostgreSQL is
configured locally and migrated before the Node API starts. The normal
`npm run setup` command retains its existing seeded CLI workflow.

`npm run setup:browser` prepares the local `.env` with a unique password and
mode 0600, rotates a random 256-bit `WORLDACT_INSTALL_TOKEN`, starts the configured
local PostgreSQL service and migrates without seeding. It prints a private
`/install#token=…` link for the server operator. The fragment keeps the token out
of HTTP paths/query logs and referrers. The React `/install` screen reads the
fragment into memory, clears it with replaceState, collects source-style site
title/username/password/email/search-visibility fields, and submits the token
only in the JSON body. It does not store the token in localStorage or send it to
third parties. Supplied install CSS and local zxcvbn provide the setup form and
password-strength display, with password generation/reveal and weak-password
confirmation. Success leads to normal login; initialized sites show an
already-installed screen. English is the implemented interface language.

- `GET /api/install` returns only `{installed,available,language}`. GET never
  creates or changes a site and returns no credential or account identity.
- `POST /api/install` accepts exactly `{token,siteTitle,username,email,password,
  discourageSearchEngines?}` from the configured site origin. Passwords require
  12–1024 characters. A missing/invalid secret cannot initialize a site.
- Installation uses the same advisory lock as CLI seed, then the account-identity
  lock. It rechecks that no account, initial-content/install marker, post or media
  exists before creating one administrator, configured settings and the shared
  once-only sample content. Everything, including the welcome outbox message,
  commits or rolls back together. Concurrent attempts yield one 201 and one 409.
- Welcome delivery occurs after commit and connection release. The message
  contains site/login/username information, never the password or setup token.
  The response returns safe account data, `/login`, and delivery mode; it does
  not create a session. Normal authentication follows installation.
- Durable markers keep the installer closed after account removal. A site with
  any existing account is also closed, including a site without an administrator.
  Running browser preparation again never resets an initialized account.

`tests/install.test.ts` checks the actual CLI preparation in a temporary copied
project with command stubs, secret-file permissions, fragment-only links, token
rotation, unchanged CLI seeding, rejected origins/inputs, late rollback,
concurrent installers, normal login, welcome secrecy and durable closure.
The API lifecycle needs a separate migrated but unseeded disposable database:

```
ISOLATED_TEST_UNSEEDED=true npm test -- tests/install.test.ts
ISOLATED_TEST_UNSEEDED=true ISOLATED_TEST_COMPILED=true npm test -- tests/install.test.ts
```

The runner refuses this mode for any other file selection. Normal regression
runs keep their seeded lifecycle and instead verify installer closure; neither
mode can point tests at the configured site database.
