# Public comment duplicate admission

The supplied `wp-includes/comment.php::wp_allow_comment()` around752–816
rejects an already stored, non-trash comment before ordinary approval and
external filtering. These files are reference data; WorldAct runs Node and
PostgreSQL without executing PHP or MySQL.

All public human entry points share one transaction: `/api/public/comments`,
the native `/wp-comments-post.php` form and authenticated REST creation. After
the actual identity, post, password and parent checks, the existing comment
hierarchy advisory lock serializes duplicate detection and insertion across
application processes. The duplicate query matches post, null-or-actual parent,
stored author name and canonical sanitized content. A supplied email must also
match the normalized email; an omitted optional email follows the source's
name/content-only branch. Author URL and remember-author preferences do not make
a retry distinct. Approved, pending and spam predecessors block the retry;
trash permits a new comment.

A duplicate returns409 before Akismet checks, token replacement or creation,
insertion, notification queueing and delivery. The existing remembered-author
cookie remains valid. The REST bridge retains its existing message/data-status
error envelope; native forms return the real409 rather than a success redirect.
Administrative comment creation and fixed incoming-ping identity rules retain
their separate existing contracts.

The meaningful regression holds the real PostgreSQL hierarchy lock until both
concurrent HTTP requests are blocked, then proves exactly one201, one409, one
row, one preference and one notification set. Further actual HTTP checks cover
unchanged remembered preferences after rejection, distinct post/parent/name/
email/content, case-normalized email, optional empty email, URL-only retry,
pending/spam/trash, native form and authenticated REST creation. Discussion
fixtures now use distinct comment bodies when testing different policy states.

The existing process-local hourly attempt limit remains separate from this
persisted duplicate rule. Source15-second flood-interval parity remains a
separate continuation. No schema, dependency or UI change is required here.

Production build and52 source/52 compiled checks across nine files pass, with
no failures or skips. Independent backend review remains pending.
