# Public comment windows

`publicCommentWindow` supplies both the public post DTO (including the Classic
React view) and source `core/comments` rendering. One PostgreSQL statement takes
counts, selects the page and collects its approved descendants from the same
snapshot.

With threading enabled, comments with a null parent are the page units. Every
approved same-post descendant of a selected approved root stays in that window,
regardless of its date. A pending/spam/trash ancestor stops traversal. An
approved child whose parent belongs to another post, or an unattached historical
cycle, is not promoted to a new threaded root. The existing foreign-key deletion
behavior can set a surviving child's parent to null; that persisted child then
is a real root. This change does not alter deletion or comment admission.

`totalComments` counts all approved comments, including approved but unreachable
historical rows. `totalTopLevelComments` counts approved rows with null parents.
Threaded `totalPages` divides the latter count; flat pagination divides the
former. Page count remains at least one in the DTO. Protected locked responses
return empty comments and zero counts without fetching a comment window.
Unpaginated responses use one window. Page selection always uses ascending
creation date and ID, so explicit comment-page URLs identify the same roots
regardless of display direction. `oldest` defaults to page 1; `newest` defaults
to the last page, independently of ascending/descending display. Descending
reverses only the selected root display; child siblings remain chronological.
For flat output, all selected rows are displayed in reverse when descending.
This deliberately changes the old WorldAct descending URL-page contract, which
previously numbered the global descending order and reversed child siblings.
Out-of-range clamping is retained.

Recursive SQL uses `UNION` on IDs, never growing ancestry arrays. The selected
window admits at most 4000 records and an 8 MiB content/identity-text budget
(with a per-record allowance). An oversized complete window returns 413 in both
public surfaces; it is never truncated or split across pages. The renderer also
retains its existing global node and output budgets; exhausting the global node
budget while rendering a comment window produces 413 rather than successful
empty comment bodies. Its comment tree walk now
uses a parent map and explicit stack, retaining its existing markup and display
depth flattening without JavaScript recursion through historical depth.

Raw guest email and the separately selected current account email are internal
avatar inputs only. The DTO removes both; typed pingbacks/trackbacks have no
avatar. Source avatar rendering keeps its existing current-account lookup and
stored guest-email fallback, including an account deleted after window loading.
Body pagination, Query Loop pagination and comment pagination remain independent.

The helper returns flat rows: their null-parent subsequence is in display-root
order, and each parent's child subsequence is chronological. Every reachable
approved descendant is included, even beyond display depth. The source renderer
uses this contract with an iterative walk. Classic now builds its parent map,
tree and JSX iteratively as well, rendering every supplied descendant and
flattening indentation beyond the configured depth. Independent native review
on `9153e04` passed chronological root paging/order, source/Classic comparison,
a complete2500-comment tail, configured depths, real Reply/focus, privacy,
responsive controls and immediate protected body-page2 unlock in both themes.

Source Reply eligibility follows actual ancestry independently of presentation
flattening: a human comment at or beyond the configured maximum has no Reply
control. Supplied `wp-includes/blocks/comment-reply-link.php:31–49` computes
ancestry before passing depth/max_depth to the source reply-link helper.
The render walk carries that actual depth without per-comment SQL or recursion.
The focused follow-up build and36 source/36 compiled checks across seven files
pass; independent backend/native depth rechecks remain pending, separate from
the earlier native gate.

## Reference provenance

Read-only reference: `/Users/olegkuftyrev/Desktop/wordpress` (no PHP or MySQL
executed). `wp-includes/comment-template.php:1452–1502` chooses hierarchical
queries and top-level page counts. `wp-includes/class-wp-comment-query.php:825–831`
constrains the initial hierarchy to parent 0, and `:1078–1123` fetches approved
descendants without the initial limit. Consequently an unavailable/unapproved
ancestor does not admit its descendants. `wp-includes/comment.php:1071–1079`
uses root count for threaded pages. `wp-includes/blocks.php:3121–3180` applies
the same hierarchy and newest/oldest chronological page defaults to source
blocks; `wp-includes/blocks/comment-template.php:124–128` reverses only root
display. Its descendants retain the query's ascending order, including the
stable comment-ID tie breaker at `class-wp-comment-query.php:666–702`. The
template renderer flattens beyond configured display depth. The explicit
bounds and cycle termination above are deliberate runtime safeguards.

## Validation

`tests/comment-window.test.ts` exercises actual public DTO and bundled template
HTTP responses for interleaved roots/replies, deep replies, defaults/order,
threading and pagination toggles, hidden/deleted/cross-post parents, cycles,
typed notifications, avatar privacy, password grants, separate body/Query Loop
counters and links, complete-window size rejection, and a 2500-deep historical
thread. The compiled-server CI selector includes this test.
