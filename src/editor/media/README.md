# Native Image media editor

This adapter hosts the installed official `@wordpress/media-editor` 0.22.0
modal, cropper, Details form, keyboard controls, history, notices and save hooks.
`@wordpress/media-fields` 0.24.0 supplies the attachment fields. The title field
and theme aspect-ratio conversion follow the supplied WordPress
`wp-includes/js/dist/editor.js`; their small host definitions are local because
loading the entire editor store would replace the host's current-document store.
The package/source licenses remain in the dependency and repository notices.

Image's own source `useOpenImageMediaEditorModal` remains responsible for block
metadata synchronization, selected-size fallback, attachment-derived links and
the exact Undo snapshot. We forward its callbacks unchanged. The backend's real
edit-context attachment REST and edit-copy endpoint supply authoritative records;
no local synthetic attachment record grants permissions or invents raw fields.

The installed block editor's private `ExperimentalBlockEditorProvider` preserves
its real Symbol-keyed image-edit callbacks. Its public wrapper strips Symbol
settings. The Vite alias resolves that installed package's actual lock/unlock
module, retaining the source private API identity. It does not make replacement
symbols or load a second block editor.

Each opening has genuine media-editor, notices and core-data stores in an
inheriting registry. Current document/block-editor ownership stays in the parent.
This isolates an old async save's unconditional close, notices and attachment
edit cleanup from a later opening, including reopening the same attachment.
The authorized preflight and ordinary-media refresh are aborted on retirement.
Accepted source onUpdate callbacks still return to the original Image hook,
which resolves fresh actual attachment records in the parent. Parent canvas and
block provider remain mounted while this modal is open.

The data package does not expose a child-registry destroy API. The narrow parent
subscription adapter in `openingRegistry.ts` records and releases only the
subscriptions acquired by that child registry. Completed source Undo notices
retain their own opening until the source dismisses them; retired documents
release every opening and cannot update a newer document.

The source conditional Restore original image action requires `edit_root`, which
is absent in the supplied PHP attachment contract. It remains conditional; the
host does not fabricate that newer-package feature. Ordinary media-library
manual Restore Original remains a separate existing operation.
