# Private personal options

The supplied `wp-admin/user-edit.php` and `wp-includes/user.php` are reference
data. `showAdminBar` (default true) and `commentShortcuts` (default false) persist
as validated optional booleans in the existing private profile object through
the authenticated own-profile or authorized administrator-edit routes. Partial
saves preserve omitted flags and unrelated fields. No database migration is
needed. They are selected only for private login/session/application-password
authentication and profile responses; public author DTOs and site archives
continue to exclude account preferences.

The React Profile implements the source Personal Options checkbox labels “Show
Toolbar when viewing site” and “Enable keyboard shortcuts for comment
moderation.” The toolbar preference applies only to the public toolbar. The administrator shell toolbar
remains present. Comment shortcuts are opt-in and meaningful only where the
account can moderate; the profile source hides that checkbox on a self-profile
without edit-posts capability. The supplied `wp-admin/js/edit-comments.js` table-hotkeys section
and `wp-includes/js/jquery/jquery.table-hotkeys.js` define row navigation,
selection, per-row and shifted bulk actions, editable-field exclusions, paging
and focus behavior. Existing React comment mutations and permission checks must
remain authoritative. The client implements these keys through the existing
permission-bearing row actions, keeps modal and editable fields isolated, and
returns focus after Quick Edit/Reply. Native UI and keyboard behavior require
independent review.

`tests/profile-options.test.ts` exercises genuine profile writes, partial-save
preservation, default values, invalid data, other-account permissions, renewed
login, existing-cookie refresh, application passwords and public/export privacy.
