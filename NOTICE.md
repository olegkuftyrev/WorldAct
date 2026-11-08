# Attribution and third-party notices

WorldAct is a personal educational CMS reimplementation using React, Node.js and PostgreSQL. It is an independent project and is not affiliated with or endorsed by WordPress or Automattic. WordPress and the bundled theme names identify the upstream references; WorldAct ports the supplied block themes into a React/Node renderer and retains a separate legacy Classic presentation.

## Project license

WorldAct source is provided under **GPL-2.0-or-later**. The root [LICENSE](LICENSE) contains GNU GPL version 2. Dependency packages retain their own licenses and notices; this file does not replace those terms.

## WordPress reference assets

Selected static admin CSS/color schemes, Dashicons and its font files, dashboard artwork, and theme screenshots under `public/vendor/wordpress/` were copied from the user-supplied distribution at `/Users/olegkuftyrev/Desktop/wordpress`. Its version file declares WordPress **7.1.4**, and its readme identifies GNU GPL version 2 or later. Copyright belongs to the WordPress contributors and original asset authors. Source comments and available notices are retained.

The Connectors Akismet mark in `public/vendor/wordpress/connectors/akismet.svg` is statically extracted from the supplied `wp-includes/build/routes/connectors-home/content.js` (`routes/connectors-home/logos.tsx`); its original SVG geometry and colors are retained. The Connectors card geometry follows that route's source stylesheet. Akismet's name and mark identify its service and remain the property of their respective owners.

The browser installer also uses the supplied `wp-admin/css/install.css` and `wp-includes/js/zxcvbn.min.js` without executing PHP. The latter identifies zxcvbn 4.4.1, copyright Dan Wheeler and Dropbox, Inc., under the MIT license; the upstream [versioned license](https://github.com/dropbox/zxcvbn/blob/v4.4.1/LICENSE.txt) is retained beside it as `zxcvbn-LICENSE.txt`. Password strength estimation loads locally and makes no external request.

Templates, parts, patterns, theme.json data, variations, original CSS, images and fonts from Twenty Twenty-Five, Twenty Twenty-Four and Twenty Twenty-Three are statically transformed and copied with source paths/hashes in `src/theme-source/bundled.json`. No PHP executes in the import or runtime. Theme readme/style notices accompany assets; each theme’s `FONT-NOTICES.txt` records font copyright/license provenance, with OFL or Apache 2.0 notices beside the applicable fonts. The Roboto Slab font embeds Apache 2.0 copyright information, which is preserved with that license.

Two Twenty Twenty-Four directory patterns declared by its theme metadata are retained with their canonical source/provenance in `src/theme-source/`. Social SVG icons are statically extracted from the supplied `wp-includes/blocks/social-link.php` into `src/theme-source/social-icons.json`; copyright belongs to the WordPress contributors and original service mark owners.

The copied dashboard SVG has a duplicate root XML attribute removed so it loads as an external image. The original reference distribution is unchanged. It is not configured or executed as a PHP/MySQL installation, and no existing WordPress user database or content dump is included.

## Gutenberg

The editor uses official `@wordpress/*` JavaScript/CSS packages from the WordPress Gutenberg project, including blocks, block editor/library, components, data/core-data, formatting, hooks and related dependencies. Copyright 2016–2026 belongs to the Gutenberg contributors.

The Gutenberg project is GPL version 2 or later. Its package license files also describe the GPL/MPL 2.0 dual license for contributions made on or after April 15, 2021. Preserve and consult the full `LICENSE.md` distributed in each installed Gutenberg package. WorldAct's app imports their JavaScript and CSS; it does not execute PHP from upstream package source data.

## Other dependencies and services

The supplied Hello Dolly 1.7.2 and Akismet 5.7.2 plugins are reimplemented as Node modules. Hello Dolly retains its source lyric data and Matt Mullenweg attribution; Akismet identifies Automattic and its anti-spam team. Original plugin code/notices are reference material, and the applicable GPL notices are retained in `src/plugins/`. No PHP plugin code executes. Akismet's optional external service requires separate operator configuration and is subject to its provider's terms.

React, Express, PostgreSQL, Sharp, fontkit, file-type, fast-xml-parser, Nodemailer, Vite, and other dependencies retain their respective upstream licenses and copyright notices in their distributions. Generated build outputs and installed dependency data are not a replacement for those notices.

Enabled public avatars load Gravatar URLs using the source-equivalent SHA-256 identity hash, rating and default style. Disabling avatars suppresses those images. Optional YouTube and Vimeo embeds load player resources from their respective providers. WorldAct constructs player URLs from validated provider/video IDs; those services and media remain subject to their owners' terms and rights. SMTP contacts the configured mail server only when configured; local development otherwise uses a database mail outbox.

## Classic block JavaScript

The Classic block lazily loads the supplied TinyMCE **4.9.11** JavaScript, themes, plugins, skins and fonts under `public/vendor/wordpress/wp-includes/js/tinymce/`. TinyMCE is copyright its original Moxiecode/Tiny Technologies authors and contributors and is distributed under LGPL 2.1; its complete supplied `license.txt` is preserved beside the assets. WordPress-specific editor/plugins/link scripts and CSS retain their WordPress contributor/source notices and GPL terms.

Copied jQuery **3.7.1** and jQuery UI **1.14.2** are copyright OpenJS Foundation and other contributors and distributed under the MIT license. Their source headers are retained, with the MIT permission notice in `public/vendor/wordpress/wp-includes/js/jquery/LICENSE-MIT.txt`. English legacy-editor strings and keyboard shortcut labels are statically extracted from the supplied WordPress editor reference; no PHP loader, interpreter or server executes.
