# Fixed core block bindings

The supplied `wp-includes/block-bindings.php`, `class-wp-block.php` binding
processing/replacement, `block-bindings/{pattern-overrides,post-data,term-data}.php`,
`blocks/block.php`, `blocks/block/block.json` and `blocks/image.php` are source
references only. WorldAct executes no PHP, saved expressions or callback registry.

The eight source-supported block/attribute sets are fixed in
`bindingAttributes`. `core/pattern-overrides` reads only the named block's own
supported attributes from its nearest `core/block` instance. `__default` expands
to those attributes while retaining explicit bindings. Missing/null values keep
the saved fallback, and false/empty values remain real overrides. Each nested
synced pattern supplies a fresh map, including `{}`; legacy `overrides` and v2
`content[name].values` receive the source compatibility normalization. Only the
immutable referenced entity is cached, never the instance's computed output.

`core/post-data` supports `date`, `modified` and `link`, including the old `key`
argument. Modified dates at/before publication return the source empty result.
Navigation uses its own post ID; other supported blocks use the current query
post. Metadata-only lookups select neither body/title nor password hashes.
Nonpublic entities require an authorized preview context, and password data
requires the existing request-bound grant. `core/term-data` supports exactly
id/name/link/slug/description/parent/count for the two built-in public taxonomies,
using the current term context or a navigation item's own taxonomy/ID. Plain
term labels remain escaped text; descriptions permit sanitized rich HTML.
Unregistered/meta/plugin sources and unsupported fields/attributes keep saved
fallbacks. There is no arbitrary custom-field model or invented post title,
excerpt, content or account-data binding.

Rendering clones attributes and saved fragments transiently. Canonical HTML
uses htmlparser2 source indices and UTF-16 slices consistently; rich-text
replacement stops at the first inner-block position, and child rendering remains
verbatim. Attribute values are escaped, URLs validated and final normal HTML
sanitization remains unconditional. Bound image IDs update existing wp-image-N
classes and gallery data-id values without loading arbitrary attachments.
JSON trees render computed attributes rather than stale saved HTML snapshots.

Freshly resolved rich-text bindings first pass through ordinary authored-content
sanitization, then expand the fixed shortcodes once. This preserves the supplied
block-before-shortcode ordering without expanding saved override maps twice.
Escaped and code literals remain inert, and authored attributes cannot impersonate
the trusted generated playlist configuration. Final rendered output still passes
through the generated-content sanitizer.

The existing request cache/query/node/depth/cycle/output budgets also cover
bindings. A single bound string additionally has a 2 MiB limit. Storage,
revisions and autosaves retain original binding metadata and source content.
JSON/WXR copying remaps synced-pattern refs and named image override IDs/URLs;
unavailable image IDs become zero with a warning rather than binding unrelated
destination attachments. No settings or design are overwritten by rendering.
