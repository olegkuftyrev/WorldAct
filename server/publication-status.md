# Publication save policy

Core/REST editorial saves resolve the publication pair after the existing actor,
author, hierarchy, post and slug waits, read settings through that transaction's
client, and capture one application clock. Effective `publish` and `future`
statuses use `floor(selectedGMT/1000) - floor(now/1000)`: at least60 seconds means
`future`, otherwise `publish`. Supported UTC fractions are retained. Other
statuses do not normalize. Both the original requested status and the result
must pass the existing capability checks.

The source reference is the supplied WordPress `wp-includes/post.php:4769–4808`
and `5357–5373`, `wp-admin/includes/post.php:707–719`, and REST posts controller
`1358–1387`. It was read as data; no PHP/MySQL execution is involved. WorldAct's
strict Gregorian civil dates, bounded years, explicit offsets, DST-gap errors,
lease/version rules and per-item errors remain its established contract.

Unchanged fixed pairs never rebase after a timezone change. Touched nonfloating
publish/future/private rows with NULL selected GMT keep their stored civil when
the requested/effective save is publish/future, deriving GMT in the late site
zone with a strict roundtrip check. This includes an explicitly unchanged local
date. Ordinary private saves retain NULL. Floating draft/pending dates retain
their existing current-clock refresh/fixation behavior. New/floating scheduling
without a chosen date and explicit `scheduledAt:null` alone remain400; an
independent valid local/REST date or explicit null reset remains date intent.

Every resulting future save synchronizes active `scheduledAt` to selected GMT.
An actual transition into publish sets active `publishedAt` to selected GMT.
Existing publish-to-publish without date intent preserves its legacy publication
clock. Inactive clocks retain existing behavior, including clearing due on an
explicit reset. These intentional publication actions do not promise unchanged
legacy UTC fields.

Bulk explicit `status:publish` on a locked current draft/future is Publish Now.
A private server-only Symbol intent resets the pair from the same late clock,
even when the payload supplied a valid different date. Original explicit dates
are validated first: a genuinely changed gap fails; an unchanged fixed pair
retains its exemption across zones; explicitly unchanged nonfloating NULL-GMT
civil must complete strict derivation before reset. No-date Publish Now can
reset an old unfixed gap. Floating unchanged civil and explicit null retain their
normal reset rules. Pending/private/already-published items do not get this bulk
reset. Clients cannot submit the internal intent, and mixed batches keep their
ordinary independent success/403/404/409 reporting.

| Entry point | Publication decision |
| --- | --- |
| Core create/update; REST adapter | Shared late `savePost` policy |
| Bulk | Same policy plus server-owned current draft/future Publish Now intent |
| Revision restore | Same inherited effective-status save policy; no historical date/status payload |
| Recognized publishing mail | Requests publish with its actual date; core decides after waits |
| Lower/unknown sender mail | Existing bounded pending authority; no expanded publishing rights |
| JSON/WXR import, installation/seed, privacy draft | Existing raw writer behavior; no save-time classification |
| Scheduler | Existing exact legacy due-time check and idempotent effects; no60-second early window |

Raw JSON restore keeps its existing future-to-draft and protected-to-draft safety
policy, exact v4 pair and legacy clock handling, destination ownership and design
options. Reading/exporting/importing a divergent row does not normalize it as an
editorial save. A later ordinary save of effective publish/future does. Scheduler
compatibility for deliberately inconsistent imported civil/GMT/due values remains
separate; no always-on timing guarantee or new global ordering is introduced.

Date/status-only changes do not create content revisions. Restoring content does
not replay a historical pair, status or schedule; the inherited current state
still follows this save-time policy. Modification, creation, comment and media
clocks retain their existing rules.

`shared/publication-status.ts` requires an explicit clock and resolved GMT. Editor
hints use that same whole-second threshold and retain saved status provenance
only from successful server DTOs. Unchanged NULL-GMT nonfloating dates may derive
strictly in the current site zone for hints; fixed GMT is never reinterpreted.
Valid chosen dates remain submit-able after the window elapses. Returned server
status remains authoritative after network/lock delay. Quick/Bulk updates retain
their per-item reload/error behavior; provenance is absent from payloads and
content-only recovery/autosave.
