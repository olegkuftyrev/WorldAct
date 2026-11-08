# Private editor preferences

`PUT /api/preferences` accepts a fixed, optional `editor` object. Its partial
updates merge atomically with existing editor and list-table preferences.
Unknown keys, non-boolean switches and unsupported editor modes fail validation.
The authenticated account is always the target. Values remain outside public
author records and portable site archives.

The shared resolver supplies the supplied `wp-includes/js/dist/edit-post.js`
defaults: visual mode, floating block toolbar, fullscreen mode, visible block
breadcrumbs, icon buttons and closed List View. Spotlight, distraction-free and
caret containment start disabled. Missing or malformed legacy values use those
defaults. No existing preference row needs a migration.

The fixed keys are `editorMode` (`visual` or `text`), `fixedToolbar`,
`distractionFree`, `focusMode`, `fullscreenMode`, `showBlockBreadcrumbs`,
`showListViewByDefault`, `showIconLabels` and `keepCaretInsideBlock`.
They describe the forthcoming real editor integration; accepting a setting
alone is not a claim that its visual control has passed native review.

The guarded regression uses separate authenticated accounts and simultaneous
partial updates to verify privacy and preservation of unrelated preferences.
