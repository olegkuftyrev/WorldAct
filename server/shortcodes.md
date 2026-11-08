# Fixed legacy shortcode boundary

The supplied WordPress `wp-includes/shortcodes.php`, `media.php`,
`class-wp-embed.php`, `default-filters.php` and `blocks/shortcode.php` are source
references only. WorldAct never executes PHP, plugin callbacks or shortcode
expressions. The fixed registry is `gallery`, `audio`, `video`, `playlist`,
`caption`, `wp_caption` and `embed`.

Original classic HTML, canonical block bodies and JSON textual block fields are
prepared transiently, once, before rendering. Revisions, autosaves, storage and
exports keep the original text. Original code/preformatted/verse subtrees, HTML
attributes, comments and code/pre/script/style/textarea/xmp regions are inert.
Registered `[[escaped]]` forms lose one bracket layer without being expanded a
second time. Unknown plugin tags and malformed tokens stay literal. The official
`@wordpress/autop` formatter supplies the Shortcode block's paragraph callback.
Automatic excerpts strip registered shortcodes without querying media.

Gallery and playlist selection supports ordered `ids`, include/exclude,
parent/default attachments, fixed ordering choices, source display options and
metadata only. Explicit lists, including empty or detached lists, never fall
back to destination attachments. Gallery HTML5 captions, selected image sizes,
columns and file/none links are generated safely. WorldAct currently exposes
media files directly, so attachment/default links also use the public file URL;
there is no fabricated attachment detail page. Audio/video support fixed source
formats, native controls, fallback links, preload/loop/autoplay/muted, video
dimensions/poster and safe caption tracks. Audio playlists reuse the trusted
core playlist contract, with literal escaped row labels and separate stripped
player metadata. Video playlists provide a native video player and direct track
links; track switching can be added by the shared client runtime. Embedded album
art extraction is outside the metadata contract.

Known YouTube/Vimeo URLs use the existing fixed embed wrapper. Other valid
HTTP(S) embed URLs become links. There is no oEmbed discovery, server HTTP
request, remote attachment download or arbitrary iframe/SVG/script insertion.

The existing password gate precedes body preparation. Default attachment
selection cannot inspect a private/draft/password parent without the existing
preview/password permission. Explicit media IDs attached to such parents receive
the same filter, intentionally stricter than the supplied gallery's explicit
include branch. Parent queries never select post titles/content/password hashes.
Media queries select only safe attachment metadata. Lookups use the renderer's
request cache and bounded database wrapper; omitted-parent defaults are keyed
by actual context post, not identical source text.

Limits: 2 MiB per source fragment, 1,024 tokens, 8,192 characters per header,
64 attributes, 12 actual enclosing levels, 200 media IDs/rows, the existing
4,000-node/512-query render budgets and 8 MiB cumulative output. JSON preparation
also checks its aggregate expansion before joining a result. Malformed scanning
advances linearly rather than retrying an unclosed quoted header at every byte.

JSON/WXR portability remaps gallery/playlist lists and parent IDs, caption
attachment IDs, and known uploaded source/poster URLs. Missing list references
remain explicit `0`; missing uploaded URLs remain explicit empty sources. They
cannot bind unrelated local IDs or trigger a fallback attachment lookup.
Escaped literals, inert code and unknown plugin syntax remain unchanged.
WXR has no attachment byte importer, so its explicit empty media map detaches
unavailable attachment identities while retaining safe original content URLs.
Only JSON full-site restore opts into detaching unavailable uploaded shortcode
URLs; WXR retains those URLs because its attachment bytes are intentionally absent.
Invalid imported shortcode complexity rolls back records and copied files.
