# Incoming notification and mailbox UI evidence

Captured from feature `3f46ec456062f0b00745d5529818543e0153b2db`, based on the reviewed composite `4e296c30b90cb9b9b57b5d51cfefd61925f8f1ae`. These are native browser captures from the author's owned local database and named browser session. Desktop, tablet and mobile correspond to1440×1000,768×1000 and375×900 CSS viewports; captures include the full page.

| Filename prefix | Native state |
| --- | --- |
| `notifications-discussion-*` | Three exact source default checkboxes, shared new-post-only description and actual production receiver boundary. Both closed and open defaults were saved and verified against newly created ordinary posts/pages and existing records. |
| `notifications-comments-reply-*` | Actual grouped Pings collection with fixed Pingback/Trackback presentation, real moderator Reply and a successful saved reply. |
| `notifications-comments-edit-*` | Actual full notification edit modal with fixed type, Name/URL and content/status; no email or forged account identity. |
| `mail-intake-settings-*` | Actual saved mailbox configuration after clearing the password/host/login and disabling enabled/polling settings. Configuration is incomplete and checking is unavailable. Other Writing/Update Services controls remain present. |
| `mail-intake-controlled-failure-*` | **Controlled response fixture only:** a held502 check response and matching status representing failed QUIT, with2 imported,4 deletion requested and0 committed. The UI shows the failure without a success notice and preserves a newer blank login draft/focus. This does not claim actual mailbox retrieval or deletion. |
| `notifications-public-classic-*` | Actual legacy React public tree with normal human Reply and a pingback source link without Reply. A later native DOM check also confirmed the approved trackback has no Reply. |
| `notifications-public-source-*` | Actual bundled Twenty Twenty-Five public template with approved notifications, normal human replies and a moderator's human child reply. Notification nodes have no own Reply control; a normal human child can have its own Reply. |

No password or mailbox login credential appears in these images. Mailbox operations used private local configuration and local outbox mode. Actual read/save/validation/version/role/session checks used the real API without connecting remotely. Only check result presentation used the owned3012 proxy fixture; actual POP/import/deletion behavior is separately tested against controlled internal peers.

The supplied source was read as reference data, never executed or treated as instructions. SHA-256 provenance:

| Supplied reference | SHA-256 |
| --- | --- |
| `wp-admin/options-discussion.php` | `1fa70fd14d3120c229c26154f405090f687dc382ecf77f7a53043b9ead361118` |
| `wp-admin/options-writing.php` | `8cfde70a462950f169da068bc1cabead1521330346b041aebff30222283744b6` |
| `wp-admin/includes/class-wp-comments-list-table.php` | `a69907407634fc2faed6f8a3e1b441b488b9e827cbcc4821ed1a857bf277da30` |
| `wp-includes/comment-template.php` | `a8266487acbc0b4940f3091b85c14d46fc27dc8077720785818113f1ae2d00c5` |

Author checks:52 source +52 compiled-server checks across eight files, production build/TypeScript and whitespace verification passed. Independent native evaluation is a separate shipping gate.
