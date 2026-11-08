# Bundled block themes

`bundled.json` preserves the supplied Twenty Twenty-Five 1.5, Twenty Twenty-Four 1.6 and Twenty Twenty-Three 1.7 block templates, parts, patterns, theme.json files and style variations. The source was `/Users/olegkuftyrev/Desktop/wordpress/wp-content/themes` (WordPress 7.1.4 reference). Templates are parsed and rendered by the Node block renderer; PHP is never executed. Source SHA-256 hashes and relative source paths are included.

Regenerate the portable JSON and copy original assets:

```sh
python3 src/theme-source/import.py /path/to/wordpress/wp-content/themes
```

The importer's restricted static-expression reader resolves gettext strings, escaped text, template-directory URLs, concatenation and formatted strings. Unsupported PHP syntax stops import. The resulting site runs without the reference directory, Python or PHP. `tokens.json` contains the matching design tokens for the style editor.

Two additional canonical patterns are declared by Twenty Twenty-Four's theme.json and fetched from the official WordPress.org Pattern Directory: [Clients Section](https://wordpress.org/patterns/pattern/clients-section/) and [Three columns of services](https://wordpress.org/patterns/pattern/three-columns-of-services/), by Rich Tabor. Their public REST API records were retrieved on 2026-11-07 and are stored in `directory-patterns.json`. No runtime network request is required. The empty client logo placeholders are original pattern content. Directory patterns are CC0; supplied theme templates/styles are GPL-2.0-or-later. Original theme readmes preserve image and font attribution.

Original image/font files are served from `public/vendor/wordpress/wp-content/themes/<theme>/assets`. Supplied font licenses are retained. `font-attributions.json` and each theme's `FONT-NOTICES.txt` preserve copyright, license and license URL metadata read from every bundled font's own name table. Where the source omitted a separate font license, `FONT-LICENSE.txt` includes the embedded copyright notice and full license text (SIL OFL 1.1, or Apache 2.0 for the supplied Roboto Slab font). Font binaries are unchanged. The original theme readme labels Roboto Slab OFL; its embedded metadata identifies Apache 2.0, so that license is retained as well.
