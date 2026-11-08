# Native image edit copies

`POST /wp-json/wp/v2/media/:id/edit` is the supplied Gutenberg attachment-copy
workflow. It forwards through the existing authenticated/same-origin adapter to
`POST /api/media/:id/edit-copy` and returns a **new attachment**, HTTP 201 and a
Location header. It does not mutate the source attachment, its files, or any
block. Source references are `class-wp-rest-attachments-controller.php`
`edit_media_item()` and the installed official image/media-editor controls.

The request requires `src` and one to eight fixed `modifiers`: clockwise
`rotate` with numeric `angle`; `flip` with boolean
`args.flip.horizontal/vertical`; or percentage `crop` with
`args.left/top/width/height`. Each operator applies to the immediately preceding
frame. Repeated operators retain their order. Legacy flip/rotation/x/y/width/
height fields are accepted with source ordering, and `modifiers` takes
precedence. Invalid, empty, out-of-frame or excessive edits fail before files
are committed. The existing 32 MiB source/final and 80-million-pixel bounds
remain; intermediate PNG frames avoid repeated lossy encoding and retain ICC
profiles. JPEG EXIF orientation is applied before the requested operations.
Only the existing verified JPEG/PNG/GIF/WebP/AVIF codecs are used, with the
existing format/quality/alpha rules and first-frame behavior.

`src` must match this attachment's current full, retained original-upload, or
current registered-size URL at the configured site origin. Query strings are
ignored. Arbitrary history files, foreign origins, credentials, executable
operators and unsafe paths are rejected. The actual image read always uses the
known local retained raw upload when present, otherwise the current full file.
The URL is never fetched. A missing retained original is a 404 even if the
normalized current image still exists.

The actor must have upload/edit permission. Authors may copy only their own
media and attach copies only to their own posts. Administrator/editor copies
are owned by the actor. Account credentials and current role are rechecked
under an actor lock; lock order is actor, source media, requested parent post,
matching existing attachment updates and account deletion. Source row locks
hold its immutable file graph while transformations finish.

Title, caption, description and alt text default to the source. Explicit string
values are sanitized through the existing media rules. Optional `post` selects
an authorized parent; its default is unattached, and comments default closed.
The new file graph uses the same normalized-full/raw-upload/sub-size pipeline
as ordinary uploads. Its `canRestore` is false until the first separate manual
Media edit. Crop Undo restores the old block attachment/URL, leaving both
attachments available. JSON exports/remapping and permanent deletion use the
existing complete-file-graph ownership rules. This fixed REST subset does not
yet expose the source's informational `media_details.parent_image` metadata.

Every staged write has exclusive ownership tracking. A failed transaction
rolls back, releases its connection, and checks all database references before
removing its files, including an uncertain COMMIT acknowledgement. This path
has no outgoing network request, PHP, MySQL or production-only test hook.

Meaningful checks use real decoded pixel matrices for ordered transformations,
all final codecs/alpha/ICC/EXIF, actual API new IDs/source byte preservation,
raw-original quality and missing files, permissions/origins/application
passwords, queued role/session changes, conflicting media/parent locks,
late INSERT rollback, archive graph copies and independent deletion.
