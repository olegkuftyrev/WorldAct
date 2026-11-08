# Once-only fresh-site defaults

Reference data: the supplied WordPress `wp-admin/includes/upgrade.php`
`wp_install_defaults()` single-site English defaults, `schema.php`
`active_plugins`, and the two supplied default plugins. PHP is never executed.

Both CLI seed and browser installation use `seedInitialContent()` inside their
existing shared transaction and `initial-content-v1` marker. Only a successful
first initialization creates:

- Published **Hello world!** with the complete branded paragraph block.
- Published **Sample Page** with all five source top-level blocks: paragraph,
  quote containing a paragraph, paragraph, quote containing a paragraph, and
  paragraph. The dashboard link is local `/admin`; comments are closed.
- The complete branded approved example comment, including its original
  newline semantics and Gravatar instruction/link. The source text constant is
  preserved; this default is stored after the installed `autop` paragraph/line
  break formatter because public comments do not apply a global display filter.
  General user-comment rendering is unchanged. Its `.example` email is
  non-deliverable and no message or remote request is sent.
- An unpublished **Privacy Policy** page, comments closed, using the default
  template and honest WorldAct privacy guide. `privacyPageId` selects it on a
  fresh site. Bracketed review instructions remain; the page needs an owner's
  review before publication. Public page lists/content cannot expose its body.
- Installed, inactive **Hello Dolly** and **Akismet**. Akismet comment sending
  is disabled, there is no credential, and no spam-check request runs. Four
  extra catalog entries stay uninstalled.

Published items store safe canonical `raw_content` and corresponding sanitized
HTML; empty excerpt, default template and normal structural defaults remain.
The policy generator emits native heading/paragraph serialization, including
`wp-block-heading`. It reads newly initialized settings using the same client,
so browser installation uses the chosen site address in the draft.

Existing sites with the initial marker receive no changes or backfill. A
repeat seed does not recreate deliberately deleted content/plugins or overwrite
edits/settings. An already-present `privacy-policy` page is preserved rather
than duplicated; an existing explicit policy selection is retained. Marker,
posts, comment, policy setting and plugins all roll back together if a late
browser-install step fails. No schema or public API shape changes are needed.

`privacy-guide.ts` is a pure shared helper used by initialization and the
existing admin guide/explicit draft API. It retains optional Akismet, avatar,
registration and comment-consent disclosures. Its sign-in copy accurately
states two-day browser sessions, fourteen days with Remember Me, a session
cookie without Remember Me, and the seven-day supported direct-API default
when the remember option is omitted. Password-unlock cookies remain seven days;
comment preferences remain 347 days. Explicit guide/draft routes retain their
permission, review and unpublished behavior.

Verification uses only the guarded disposable runner/outbox. Fresh CLI and
browser installs verify source structure, private draft/selection, plugin
inventory, one-site concurrency, late rollback and permanent installer closure.
Rolled-back transaction fixtures prove repeat/delete/edit/slug preservation.
Actual API checks cover canonical editing, JSON/WXR copies, remapped draft
policy selection and public privacy. Session expiry is checked against the
actual issued database sessions. The bundled-plugin regression restores its
preexisting inactive baseline after exercising its own mutations.

No UI, main-tree/live database, migration, email delivery, plugin activation,
PHP/MySQL, multisite or classic-widget changes are part of this batch.
