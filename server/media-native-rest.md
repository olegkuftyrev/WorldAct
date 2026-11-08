# Native Media REST fields and collections

The official `@wordpress/media-editor`/`@wordpress/media-fields` controls read
attachment `title`, `caption` and `description` raw values in edit context. The
fixed native Media endpoints return `{raw,rendered}` for an authorized
`context=edit` GET and successful upload/metadata/edit-copy mutations. Public
view/embed GET keeps rendered fields only. Description uses existing sanitized
HTML. Title and alternative text keep their plain-text contracts. Captions use
canonical safe HTML in `raw`, with source paragraph rendering in `rendered`.
The once-only format-marker migration preserves existing literal text and old
archives; see `media-captions.md` for sanitization, marker and 120000-character
canonical limits.

Edit context requires an administrator, editor or author. Authors read only
their own attachments in edit context, including filtered collection totals;
administrator/editor reads use existing media authority. Public view access
continues to follow the existing public-upload policy. Native mutation origin,
cookie/application-password and ownership checks remain in the existing
adapter and ordinary Media routes.
The native core-data metadata-save body may include its numeric `id`; it must
match the route ID and is not forwarded as an editable field. Mismatches fail
before changing either attachment.

The collection now performs real parameterized filtering before pagination for
`include`, `exclude`, `author`, `parent`, `search`, `media_type` and `mime_type`.
ID lists accept comma, repeated or bracketed query forms, deduplicate and stop
at100 IDs. Only nonnegative parent IDs may contain0, which means unattached.
Known media types and MIME tokens are fixed; search uses escaped literal SQL
patterns. Supported order keys are date, ID, title, author, parent and include;
include ordering retains the requested ID sequence. Native total/page/Link
headers reflect the filtered, permitted rows. Unknown or malformed selector
types fail without interpolating request data into SQL.

Shared native `_fields` projection understands nested own-property paths such
as `caption.raw` and object arrays, preserving existing top-level projections.
It uses a fixed bounded path tree:100 fields,4000 selector bytes,10 segments;
prototype/inherited properties are never followed. It projects only the DTO
already permitted by the endpoint and cannot expose edit-only raw values from
a view response. Empty selectors retain the whole permitted response.

The native Details fields request `_embed=author,wp:attached-to`. Media
collections, single records and native mutations now supply those real fixed
relations when explicitly requested. Empty/true/1 requests select both; false/0
select neither. The selector is bounded to 2000 characters and 20 names;
nested/array values fail. Authors contain public name/profile metadata and
source-compatible avatar URLs, never email, credentials or personal options.
Disabling avatars removes those URLs. Attached-post relations contain only
ID/type/slug/link/rendered title: published metadata is public, while other
states require that authenticated account's existing content authority. Bodies,
passwords and raw fields are never embedded. Per-request caching bounds repeated
relation reads, and embedding does not recurse through attached posts.

`media_details.filesize` uses the stored verified current file size. It does
not guess raw-original or historical backup sizes. Native mutations validate
embedding/field selectors before uploads, metadata writes or copy staging, so
a malformed projection cannot report an error after committing a change.

Actual API checks cover raw/edit mutation roundtrips, escaped literal captions,
public versus author/subscriber reads, filters and bracket IDs, parent0,
include ordering, multiple real pages/headers, nested fields, malformed and
excessive selectors. Pure projection checks cover inherited/prototype data,
array shape, whole/nested overlaps and bounds. This is the implemented fixed
native subset, not an arbitrary attachment-query or schema interpreter.
