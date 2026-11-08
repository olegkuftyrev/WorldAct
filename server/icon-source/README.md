# Bundled Icon registry

`core-icons.json` contains the 88 core icons from the supplied WordPress
`wp-includes/assets/icon-library-manifest.php` and
`wp-includes/images/icon-library/*.svg`. The manifest was parsed as text and the
SVG files read as data. No PHP was executed. `provenance.json` records the source
manifest checksum and license.

The registry is fixed at build time. Every icon is audited at server startup:
only a single `svg` root with direct `path` children is accepted. The bundled
attribute vocabulary is `xmlns`, `viewBox`, `fill`, `d`, `fill-rule`, and
`clip-rule`; their values are checked. Scripts, external resources, IDs,
entities, processing instructions, styles, and event attributes are rejected.
The registry does not accept uploads, paths, URLs, or runtime registration.

The renderer selects only `core/name` identifiers from this registry. Saved
block content never supplies SVG markup. Source `core/icon` styling separates
wrapper margins/alignment from SVG color, border, padding, width, flip classes,
and integer rotation. Other editor controls such as background images and
shadows remain outside the supplied PHP renderer's implemented style set.
