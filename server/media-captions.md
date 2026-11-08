# Safe HTML attachment captions

Reference data: the supplied REST attachment controller's caption raw/rendered
fields and editable attachment fields; `wp-admin/includes/export.php` maps
attachment `post_excerpt` to `excerpt:encoded` and `post_content` to
`content:encoded`. No PHP or plugin code executes.

Ordinary Media `caption` and native REST `caption.raw` now contain canonical
sanitized HTML, as the source Image Details fields expect. Native
`caption.rendered` applies the installed source `autop` paragraph filter and
sanitizes the result. Bold/emphasis, safe links, literal escaped angles,
comparisons, entities and ampersands retain their visible meaning. Title and
alternative text retain their existing plain-text contracts. Every explicit
metadata or image-copy caption write uses the shared safe HTML sanitizer;
copy/update defaults retain the canonical source caption. No client workaround
or new visual UI is included. The native selection adapter and ordinary/Classic
caption textareas continue to receive the raw HTML string.

The additive `caption_is_html` boolean distinguishes preexisting plaintext from
new HTML. Migration runs under the existing atomic migration lock: add the
column with false for old rows, escape `&`, `<`, `>` exactly once, mark true,
and set the default true for new rows. Repeated migration does not escape again
or change file identity. Even tag-shaped/event-shaped old text and existing
entity spellings remain literal instead of becoming executable markup. No
existing caption is truncated.

Canonical captions allow at most 120000 JavaScript string characters on input
and after sanitization. This permits an old valid 20000-character plaintext
caption to expand through escaping (for example, 20000 ampersands become 100000
canonical characters) and still be saved/exported/restored unchanged. Oversize
new input or sanitized output fails explicitly. Empty captions are HTML too.

JSON archives keep version 3 and automatically export the fixed per-row marker.
Importer validates the marker as a boolean: absent/false means legacy
plaintext (old 20000 limit), true means HTML (120000 limit). Both paths sanitize
and produce canonical HTML with the destination marker true; a true marker
never bypasses sanitation. Invalid markers/data roll back records and copied
files. Fresh IDs/local paths, verified bytes, ownership and file graph behavior
remain unchanged. WXR emits the canonical caption in `excerpt:encoded` and the
separate description in `content:encoded`. Its existing attachment import policy
continues to skip attachments with a reported count and never download files.

Consumer audit: shortcode galleries already sanitize the stored caption and
now retain its HTML/literal distinction, including script-free/no-JS public
output. Media/native/Classic adapters consume the raw string. Renderer media
metadata queries do not interpolate an attachment caption elsewhere. Independent
block-local image/table/playlist captions are unchanged.

Guarded tests cover actual matching-ID metadata saves, inherited/explicit edit
copies, source bytes/rows retained for Undo, raw/rendered and public gallery DOM,
malicious handlers/SVG/protocols, real legacy-row migration twice, long values,
old/new/malformed archive markers, copied-file rollback, WXR field separation
and unchanged attachment skipping. Separate fresh export/restore phases remove
source rows/files before restoring rich/literal captions with checksums and
fresh IDs in another database. Related native REST/copy permissions/locks,
shortcodes, WXR and shared-file tests remain in their existing suites.

Media format, ownership, MIME, upload/file limits, sessions, and public-upload
policy are unchanged. There are no remote downloads or frontend changes. All
implementation and verification stayed in an isolated worktree/database; no main
checkout or live site was changed.
