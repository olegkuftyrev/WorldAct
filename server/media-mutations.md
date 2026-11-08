# Media/post mutation ordering

Core page/post mutation and account content deletion share the transaction
hierarchy lock. Media mutation must join that lock **before owning a media row**:
otherwise post deletion can own P while its attachment SET NULL waits for M,
and media deletion can own M while featured-image SET NULL waits for P.
Attachment/copy can also need a post foreign-key lock after reading its source.

`lockMediaMutation` establishes **acting user → hierarchy → media/post rows**.
Its actor share lock precedes hierarchy and all actor foreign keys. It validates
the fresh permitted role and the existing authentication token; a changed role
requires a fresh request. The hierarchy lock is the same one used by core saves,
featured images, scheduling, automatic page reparenting and account delete/
reassignment. No media path first locks a media row and then takes hierarchy.
Inside hierarchy, media-before-post versus post-before-media cannot invert
across these writers because competing transactions are serialized first.

Covered existing paths: normal metadata/attach/detach, their bulk and REST
forwarders, permanent media deletion, Gutenberg edit-copy, ordinary upload/
embedded artwork, site-icon image copy, and final ordinary pixel-edit/Restore
commits. All-new-ID JSON/WXR archive graphs do not lock old media/post edges or
subsequently wait for hierarchy and are unchanged. No schema change or runtime
test hook is introduced.

Pixel decoding and staged size/file creation remain outside the short final
ordinary edit/Restore transaction. That transaction locks actor and hierarchy,
locks the current media row, rechecks current ownership and its existing filename
CAS token (Restore also checks its original filename), and writes only the pixel
fields. A changed/deleted image returns 409; a lost owner is denied. Final token
checks before COMMIT roll back a write whose session/application password was
revoked while waiting or doing image work. Failure cleanup runs after releasing
the transaction and retains the existing reference-aware file check, including
uncertain COMMIT acknowledgements. Successful old image URLs/backups stay valid
until their last actual owner is deleted. Copy retains its existing transaction/
source-file share lock; adding hierarchy preserves source-file/Undo semantics.

The normal global serialization tradeoff is deliberate: existing edit-copy and
icon work already happens inside a transaction and now also holds hierarchy.
Ordinary pixel/Restore processing stays outside it. No performance assertion or
benchmark is part of this correction.

`tests/media-post-locks.test.ts` imports the guarded test context before work.
Temporary PostgreSQL BEFORE triggers in its disposable database pause actual
HTTP writers *after* their first owned row lock; backend blocking PIDs establish
the other request's wait before releasing the gate. On the 203eea0 baseline, four
post/account versus media-delete cases (both orders) increment PostgreSQL's
deadlock counter once and return HTTP [200,500]. This identifies the 40P01
deadlock failure; the API intentionally does not expose raw database exceptions.
After the fix those same requests wait at hierarchy first and return [200,200] with zero new
deadlocks. Additional real gates cover attachment/metadata, featured-image saves,
account content deletion and reassignment versus pixel/Restore in both orders,
all media entry paths, actor-first role changes, actual logout during row waits,
filename CAS, current-owner checks, retained URLs and reference-complete staged
file cleanup. Existing pixel formats, copy, artwork, metadata/REST, upload cleanup,
account and page reparenting suites remain part of the author gate.

The ten-upload cleanup regression still occupies the complete server pool.
Its wait graph now verifies one blocked insert and nine hierarchy waiters rather
than ten simultaneous inserts, then checks every failed transaction releases its
client before reference-aware cleanup and leaves no files or rows behind.
