# Attribution and third-party notices

WorldAct is a personal educational CMS reimplementation using React, Node.js and PostgreSQL. It is an independent project and is not affiliated with or endorsed by WordPress or Automattic. WordPress and the bundled theme names identify the upstream references; WorldAct's native React presentations are limited implementations.

## Project license

WorldAct source is provided under **GPL-2.0-or-later**. The root [LICENSE](LICENSE) contains GNU GPL version 2. Dependency packages retain their own licenses and notices; this file does not replace those terms.

## WordPress reference assets

Selected static admin CSS/color schemes, Dashicons and its font files, dashboard artwork, and theme screenshots under `public/vendor/wordpress/` were copied from the user-supplied distribution at `/Users/olegkuftyrev/Desktop/wordpress`. Its version file declares WordPress **7.1.4**, and its readme identifies GNU GPL version 2 or later. Copyright belongs to the WordPress contributors and original asset authors. Source comments and available notices are retained.

The theme screenshots are from Twenty Twenty-Five, Twenty Twenty-Four and Twenty Twenty-Three. Their presence documents and illustrates the upstream theme references; it does not make WorldAct a complete port of those themes.

The Manrope variable font from Twenty Twenty-Five is copyright 2018 The Manrope Project Authors and licensed under SIL Open Font License 1.1. Its license is retained beside the font at `public/vendor/wordpress/wp-content/themes/twentytwentyfive/assets/fonts/manrope/OFL.txt`. Inter from Twenty Twenty-Four retains its original copyright and SIL Open Font License in the adjacent `inter/LICENSE.txt`. Other font choices use system fonts and fallbacks.

The copied dashboard SVG has a duplicate root XML attribute removed so it loads as an external image. The original reference distribution is unchanged. It is not configured or executed as a PHP/MySQL installation, and no existing WordPress user database or content dump is included.

## Gutenberg

The editor uses official `@wordpress/*` JavaScript/CSS packages from the WordPress Gutenberg project, including blocks, block editor/library, components, data/core-data, formatting, hooks and related dependencies. Copyright 2016–2026 belongs to the Gutenberg contributors.

The Gutenberg project is GPL version 2 or later. Its package license files also describe the GPL/MPL 2.0 dual license for contributions made on or after April 15, 2021. Preserve and consult the full `LICENSE.md` distributed in each installed Gutenberg package. WorldAct's app imports their JavaScript and CSS; it does not execute PHP from upstream package source data.

## Other dependencies and services

React, Express, PostgreSQL, Sharp, file-type, fast-xml-parser, Nodemailer, Vite, and other dependencies retain their respective upstream licenses and copyright notices in their distributions. Generated build outputs and installed dependency data are not a replacement for those notices.

Optional YouTube and Vimeo embeds load player resources from their respective providers. WorldAct constructs player URLs from validated provider/video IDs; those services and media remain subject to their owners' terms and rights. SMTP contacts the configured mail server only when configured; local development otherwise uses a database mail outbox.
