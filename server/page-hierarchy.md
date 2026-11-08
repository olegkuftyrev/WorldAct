# Page mutation and permanent deletion

Source reference (read-only data): supplied `wp-includes/post.php:3894–3908`
changes surviving hierarchical children to the deleted item's parent before
deletion. Thus G → P → C → GC becomes G → C → GC after permanently deleting P;
moving P to Trash alone does not change C's parent.

`page-hierarchy.ts` shares the existing transaction advisory hierarchy lock.
The lock order is **required user rows in ascending ID order → hierarchy →
existing post rows**. Ordinary core creation locks its actor/assigned author
before hierarchy; existing saves, bulk items, revisions, autosaves and permanent
deletion take hierarchy in `lockedPost` before their post row. This deliberately
also covers post/page type conversions without a racy unlocked type preflight.
Parent removal to null follows the same order as assigning a nonnull parent.
`validateParent` validates only after this order has been established.

The scheduler needs no user foreign key/authority locks but takes hierarchy
before its multi-row post update. Account deletion/reassignment locks actor,
target and replacement together, validates the live administrator/authentication,
then takes hierarchy before any media/post locks. It never acquires a new user
lock after hierarchy. Account bulk operations delegate to this same function;
the page REST force-delete bridge delegates to the core Trash/delete handlers.

Edit-lease acquisition remains users → one post: it never waits for hierarchy
or another post afterward. JSON/WXR imports build a tree exclusively from their
newly allocated IDs; Privacy Policy/installer creation inserts new roots. Those
paths do not connect to existing parents or subsequently wait for hierarchy,
and do not need an unrelated flow/authentication rewrite for this correction.

Before deleting, `reparentDeletedPages` selects surviving direct children and
the deletion set's page ancestor closure under hierarchy. It skips every deleted
ancestor, so account removal of several ancestors chooses the nearest surviving
one. Both the SQL `UNION` closure and iterative visited-ID walk terminate corrupt
historical cycles; an unavailable/non-page/cyclic ancestor chain falls back to
null rather than introducing a surviving cycle. Ordinary valid trees retain the
source grandparent relationship. The update predicates the child's *current*
parent on the deletion set, so an unrelated newer move cannot be overwritten.

Automatic repair changes **parent_id and version only**. Content, identity,
status, author, menu order, all timestamps and descendant links remain; changed
child versions reject a stale editor save. Existing edit leases are retained.
No revision/content rewrite, schema change or old-URL redirect history is added.

`tests/page-delete-reparent.test.ts` exercises actual PostgreSQL/HTTP persistence,
canonical descendants, source timestamp preservation, normal/REST and account
bulk/delete/reassign boundaries, live permissions/leases/versions, and both
concurrent child-move/delete orders. Actual blocked backend PIDs establish which
request owns hierarchy before releasing a held post row. A separate held
hierarchy test can still lock the affected rows with a short timeout, proving
writers have not acquired posts before hierarchy. The existing actor-first
suite remains in the compiled CI selector alongside this regression.
