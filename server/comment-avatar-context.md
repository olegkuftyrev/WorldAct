# Source Avatar comment context

The supplied `wp-includes/blocks/avatar.php` and `get_avatar_data` / `is_avatar_comment_type` in `wp-includes/link-template.php` are reference data. No PHP is executed and rendering performs no remote avatar request.

`core/avatar` always gives comment context precedence over an explicit block `userId`, post author or author archive query. Allowed human comment/note context uses the actual comment user account's email if that account exists, otherwise the comment's stored private email. Alt text uses the stored comment name plus the source `Avatar` suffix. A linked human comment avatar points to the comment author's safe website, including for registered accounts; it does not point to a post/account author archive. Unsafe or empty websites leave the image unlinked. New-tab labels distinguish the comment website from an ordinary author archive.

Pingbacks, trackbacks and other non-avatar comment types return a harmless empty wrapper with no image or focusable link, before any account lookup. They cannot inherit the post author's avatar or account identity. Disabling avatars removes avatar markup and links. Ordinary explicit-user, post-author and author-query contexts keep their own account identity; empty, zero or missing non-comment users produce no invented account.

`tests/comment-avatar-context.test.ts` exercises real PostgreSQL comment-template rendering for all three stored comment types, anonymous/registered/deleted users, explicit wrong-user attributes, safe and unsafe links, empty emails, disabled avatars and ordinary non-comment contexts. A deterministic account deletion between the real comment-loop read and avatar account lookup verifies the stored-email fallback with a genuinely missing user. The actual bundled Twenty Twenty-Five public template HTTP endpoint is also checked, including against the production-built server; no browser or Gravatar/image download is needed.

Supplied source SHA-256:

- `wp-includes/blocks/avatar.php`: `d6e8344abc5c2fbf77ad0fa205cb8361cbebe083dda4ed87bc16da8168308dc6`
- `wp-includes/link-template.php`: `3e79919111e913b311343c498f30f0cb08b820ff80fd6005218d9e17a258867c`

This correction changes Avatar rendering semantics only. It adds no dependency, schema, stylesheet, asset or other widget change. Independent focused native review is a separate shipping gate.
