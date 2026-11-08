# Ordinary public-comment flood admission

The fixed default policy follows the supplied read-only WordPress
`wp-includes/comment.php:909–954,2315–2322`. No PHP/MySQL or source callback code
executes. An actual current administrator/editor is exempt from this interval;
an author’s separate approval privilege on their own post is not an exemption.
Claimed account email never grants authority. Existing live actor/session and
application-password revalidation remains before admission.

After duplicate rejection, a human submission finds the newest comment within
the inclusive previous hour, globally across posts, parents, statuses and types.
Authenticated callers match their stable account ID **or** normalized submitted
email; guests match the retained actual submission IP **or** normalized email.
The source email comparison is unconditional, including optional empty email.
Pending, spam, trash and ping predecessors therefore participate. The signed-in
branch does not match unrelated visitors sharing an IP. UTC dates use integer
seconds: differences below15 reject, exactly15 permits, and future predecessors
reject. The one new timestamp is sampled after actual admission lock waits and
used for both comparison and storage.

The existing actor → comment hierarchy → post lock order serializes concurrent
admissions across processes. A duplicate remains409 before flooding. A distinct
rapid submission returns429, “You are posting comments too quickly. Slow down.”,
before moderation, external filtering, comment/IP insertion, preference-cookie
replacement and notification mail. Rejection does not extend the saved interval.
API, native form and authenticated REST share the handler. REST creation calls
it in process so the actual request IP/sign-in are preserved; its existing REST
error envelope remains. No forwarded-IP header or proxy-trust rule is added.

The independent process-local20/hour **attempt** cap still applies, including to
moderators and invalid submissions. This additional resource limit is not the
source15-second rule. General source callback/filter overrides remain a separate
extension continuation.

## Private metadata and lifecycle

`comment_flood_metadata` stores only comment ID, actual request IP and expiry.
Its additive repeatable schema does not rewrite/backfill existing comments or
infer historical IPs from Akismet. Existing user/email history works immediately;
predeployment guest-IP-only history is unavailable during the first prior hour.
The private table stays outside `comments` because ordinary site JSON archives
export that table’s columns. Public/admin comment DTOs, REST, WXR and general site
archives expose no flood metadata. Personal-data exports are the explicit private
exception and include only matching account/email-linked unexpired records.

Successful human comments, including exempt moderators’ comments, and newly
admitted verified pings store the record atomically. Incoming ping verification,
leases, identity and existing rate policy remain intact. **Ping flood enforcement
itself is separate**; their saved records can be predecessors for a later human
submission, as the source query requires. Imports and administrative creation do
not invent an unknown source IP. Akismet remains optional and independent.

Metadata logically expires after one hour and never affects admission after
expiry. A bounded500-record cleanup batch runs at startup and each scheduler
tick (normally30 seconds), with no overlapping local cleanup tasks. It takes
the same hierarchy lock. Expired bytes can remain while offline or until their
scheduled batch; expiry is enforced by the query rather than cleanup timing.
Permanent comment/post deletion cascades records. Spam/trash retains them until
expiry; deleting an account while retaining comments preserves their submitted
email/IP history and clears their existing account FK normally.

Confirmed personal export includes retained own IP/expiry, including old-email
comments linked to the account, in its size bound. Erasure removes active and
expired matching records before anonymizing comment identity and revokes earlier
snapshots. It takes the hierarchy lock before metadata deletion/anonymization,
so an in-flight admission cannot commit an IP between those statements and leave
a private association behind. Unrelated same-IP commenters are not exported or
erased merely because they share an address. Generated policy guidance explains
the actual retention and offline cleanup behavior.

Erasure acquires the page hierarchy **before** comment hierarchy, after the
existing privacy-request locks and without adding user row locks afterward.
This serializes permanent post/account deletion cascades before erasure takes
metadata/comment rows, including interleaved comment IDs across multiple posts.
Admission never acquires page hierarchy after comment hierarchy. Tests hold
actual first-row DELETE locks and cover both first-request orders for ordinary
post deletion and multi-post account deletion, checking both HTTP results and
the database deadlock counter.

## Verification

Guarded source/compiled coverage includes integer-second boundaries and all
source identity/status/type branches; actual API/native/REST rejection and no
side effects; two genuinely PostgreSQL-blocked distinct admissions; current
roles and revoked sign-in after actual waits; post-wait timestamp sampling;
private export/erasure and a held real admission→erasure fence; genuine IPv6
loopback REST IP preservation; bounded cleanup/cascade and repeated populated
migration without backfill. Existing approval, duplicate and Discussion cases
age only their own predecessor fixtures between independent setting/identity
cases; immediate duplicate/flood/concurrency assertions remain unaged. Final
gate counts and independent review are recorded in the implementation handoff.
