# Site-icon failure cleanup

The site-icon handler creates six exclusive PNG files and commits their media
row and settings reference in the same PostgreSQL transaction. A rejected COMMIT
acknowledgement does not prove that PostgreSQL rolled the transaction back.
Unconditionally unlinking these files can leave the saved icon pointing at six
missing URLs.

Use `writeNewMediaFile` to record ownership immediately after exclusive creation,
including a potentially partial write. On failure, attempt rollback without
replacing the original error, release the transaction client, then call
`unlinkUnreferencedMediaFiles`. Its fresh reference lookup preserves files owned
by any surviving media row; an unavailable lookup conservatively retains files.
A true rollback leaves no media references and all staged files are removed.
Releasing first prevents cleanup queries from starving a full transaction pool.
The existing actor/hierarchy/source-row order, authentication checks, image
bounds, square crop and source-file handling remain unchanged.

`tests/site-icon-cleanup.test.ts` uses only the guarded disposable database and
uploads. Its acknowledgement case invokes the existing real Express route
middleware and handler directly in the isolated test process. A test-only client
wrapper executes and awaits a **real PostgreSQL COMMIT**, captures all six actual
file checksums and the committed row, then deliberately rejects. This is injected
fault coverage, not a claim of an observed network failure or an HTTP success.
A second case rejects the subsequent rollback acknowledgement too. Both retain
all six files, hashes, actual public URLs, media/settings references and unrelated
source attachments while propagating the original error.

Actual HTTP tests use disposable PostgreSQL trigger/advisory gates after all six
files exist: a real SQL insertion failure and an actual logout both roll back the
rows/settings and remove every staged file. A separate direct-handler test fills
all ten real pool clients (one INSERT gate and nine hierarchy waiters), causes ten
real SQL rollbacks, checks release-before-reference-read for every owner, verifies
all sixty staged files are removed and confirms the pool is reusable. No runtime
test hook or production injection option is added. In compiled runner mode the
HTTP cases target the production bundle; the direct-handler injected faults still
execute the imported source handler, as explicitly described above.
