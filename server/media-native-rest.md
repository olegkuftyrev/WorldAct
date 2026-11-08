# Native Media REST fields and collections

The official `@wordpress/media-editor`/`@wordpress/media-fields` controls read
attachment `title`, `caption` and `description` raw values in edit context. The
fixed native Media endpoints return `{raw,rendered}` for an authorized
`context=edit` GET and successful upload/metadata/edit-copy mutations. Public
view/embed GET keeps rendered fields only. Description uses existing sanitized
HTML; stored caption/title remain the existing text values, with escaped
rendered output. Alt/caption/description storage rules are unchanged.

Edit context requires an administrator, editor or author. Authors read only
their own attachments in edit context, including filtered collection totals;
administrator/editor reads use existing media authority. Public view access
continues to follow the existing public-upload policy. Native mutation origin,
cookie/application-password and ownership checks remain in the existing
adapter and ordinary Media routes.

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

Actual API checks cover raw/edit mutation roundtrips, escaped literal captions,
public versus author/subscriber reads, filters and bracket IDs, parent0,
include ordering, multiple real pages/headers, nested fields, malformed and
excessive selectors. Pure projection checks cover inherited/prototype data,
array shape, whole/nested overlaps and bounds. This is the implemented fixed
native subset, not an arbitrary attachment-query or schema interpreter.
