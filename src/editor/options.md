# Post and page editor options

The Options sections, labels, menu choice behavior and Preferences composition
follow supplied `wp-includes/js/dist/editor.js` MoreMenu, ModeSwitcher,
PreferencesModalContents and PostTextEditor; source `edit-post.js` supplies the
shared defaults and fullscreen relationship. Public WordPress DropdownMenu,
MenuGroup, MenuItemsChoice, Modal, TabPanel, Navigator and ToggleControl own
keyboard, focus and responsive controls. Public TabPanel replaces the source
private Tabs/editor-store composition. Preference section and modal CSS follows
supplied `css/dist/preferences/style.css`. No PHP, private core/editor store or
browser persistence layer is mounted.

A single account queue owns initialization and ordered partial PostgreSQL
writes. Pending choices overlay confirmed server values; failed writes rebase
remaining intent. Retirement stops unsent operations before a later account's
cookies can be used. Errors retain their originating editor route. Native
`showIconLabels` uses the public preferences store without its optional local
persistence adapter. Other canvas settings go directly to the existing native
provider. Its identity and entity/media ownership stay intact across modes and
view changes.

Code source, native block records, metadata and history share the existing
Gutenberg session. The native parser keeps validation/recovery fields and client
IDs; durable attribute filtering and Date binding adaptation remain separate.
Raw source is emitted on every input, including before blur, and snapshots feed
save, recovery, autosave and unsaved preview. The canvas remains mounted while
hidden in code mode. Undo/Redo retain raw source with blocks and footnotes.
Fullscreen uses the existing admin shell and hides actual chrome from layout
and accessibility navigation. Distraction free closes inserter/List View, uses
fixed tools and hides chrome while native typing; pointer movement or F6 reveals
tools, and the source keyboard shortcut exits directly.

The installed native editable-root writing flow can let the browser move between
RichText siblings after its own arrow handler honors `keepCaretInsideBlock`.
`caretContainment.ts` uses public `@wordpress/dom` native edge/RTL utilities to
contain only the unmodified, collapsed caret at those edges. It leaves ordinary
movement, selection, composition, dialogs and Classic's own fields to their
native owners. The public DOM package is pinned to supplied source version 5.1.0.

Document identity includes account, content type, route and replacement session.
Failed route loads never render the preceding record or enable its save actions;
departing dirty canonical content gets an immediate, credential-free browser
recovery copy. Late saves, autosaves, revision responses and retired canvas
callbacks cannot replace the next document. A revision restore rebases its
version while retaining newer typing entered after its dialog was closed.
Preferences errors remain visible inside the source modal. Header and title
measurements follow viewport, label and fullscreen layout changes without
remounting the provider or changing the document.

Implemented Preferences are General (List View default, breadcrumbs), Appearance
(top toolbar, distraction free, spotlight) and Accessibility (native caret
containment, text labels). Broader source collaboration, starter patterns,
pre-publish, block visibility and document-panel preferences are not displayed.
Site Editor retains its existing independent entity canvas behavior.

Source viewport conditions are retained: the post editor's Fullscreen menu
choice appears at the native large breakpoint (960px); breadcrumbs and their
preference appear at medium (782px), and are hidden during Distraction free.

Independent native evaluation is required after the implementation freeze.
