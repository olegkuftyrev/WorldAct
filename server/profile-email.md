# Personal profile email confirmation

The supplied `wp-includes/user.php` personal-email confirmation function and
`wp-admin/user-edit.php` confirmation/cancellation/pending notice are reference
data only; no PHP executes. Changing one's own address now retains the active
address until confirmation. An administrator editing another account continues
to update that account immediately. Administration contact settings remain an
independent identity and are never changed by this flow.

All endpoints below require the same signed-in account, including confirmation:

| Endpoint | Result |
| --- | --- |
| `PUT /api/profile` | Existing profile input; changed email queues confirmation. Returns `{user,pendingEmail,delivery}` with the old active email. |
| `PUT/PATCH /api/users/:id` | Own admin edit uses confirmation; another account remains immediate. Same result shape. |
| `GET /api/profile` | Existing user/preferences plus top-level `pendingEmail`. |
| `GET /api/profile/email` | `{pending}`. |
| `DELETE /api/profile/email` | Cancel: `{ok:true,pending:null}`. |
| `POST /api/profile/email/resend` | Empty object; rotates token and expiry, returns `{pending,delivery}`. |
| `GET /api/profile/email/confirmation?token=…` | Read-only `{email,expiresAt,siteTitle}` preview. |
| `POST /api/profile/email/confirmation` | `{token}`; returns `{ok:true,user,pending:null,delivery}` after commit. |

Pending notices contain only `{email,createdAt,expiresAt,expired}`. The emailed
route is `/confirm-profile-email?token=…`; the React screen requires sign-in to
the matching account, preserves the return URL through normal login, shows the
preview, and offers explicit Confirm. Profile and the administrator's own-user
edit route show the active address plus pending, resend, cancellation and
delivery notices. Another-account editing remains immediate.
Email scanning/GET never updates an account. Invalid, expired, replaced, wrong-
account or used links return 410; missing sign-in returns 401; another actor is
rejected. A newly claimed destination email/username returns 409 and consumes
the unusable pending request. Same-origin mutation checks remain in the shared
API middleware. No endpoint returns a raw token or hash. The authorized local
mail outbox contains the actual delivered confirmation link, as with existing
reset and General-email mail.

Requests have random 256-bit tokens stored only as SHA256, expire after 24 hours,
and bind to the requesting user and previous active address. Replacing,
resending, canceling, account removal, another administrator changing the
address, and credential resets/changes invalidate older pending state. Re-saving
the same active address or unrelated profile fields preserves pending state.
A verified current-password change can request a fresh email in the same save.
Confirmation invalidates reset links sent to the former address but retains
existing sessions, matching the source's email-only change behavior. A notice
is sent to the former address after the successful commit.

Identity mutations lock actor/target users in ascending ID order, revalidate the
actor's role and credential, then take the shared account-identity advisory
lock. Registration and account creation take that advisory lock and only insert
fresh users. Login and forgotten-password requests revalidate their submitted
identifier under the existing user lock, so an old-email snapshot cannot create
a new session/reset after confirmation. Password reset and account removal use
the same user-first token/session order. Mail is queued transactionally and
delivered after commit and connection release.

The separate pending table is excluded from fixed archive/public DTOs, keeping
pending identities and token hashes out of exports. Integration checks run only
against disposable PostgreSQL/upload state with forced local mail delivery;
they cover ownership, every default role, replay/expiry/cancel, duplicate email
and username races, real login/reset interleavings, sorted admin locks, stale
sessions, deletion cleanup, and existing password/profile behavior.
