# Custom permalink time-token draft

Code checked here: `b63c0beb8564a306216f5bca57f9fcaf6d86f5a1`, based on
`bcc5e1bce2b91844adf660be1efdaba8d7fb3ef9`. This is author evidence for an
isolated draft, not a claim of independent review or full WordPress parity.

The only settings presentation change is the existing help paragraph's supported
tag text. Its element, classes, input relationships, controls, and styles remain
unchanged. The shared server/browser inventory now includes `%hour%`, `%minute%`,
and `%second%`; a custom structure still needs `%postname%` or `%post_id%`.

## Automated checks

- Typechecking and production browser/server builds passed.
- Ten focused source files passed **71 tests, zero failures/skips**. The same
  ten files passed **71 tests, zero failures/skips** with the compiled API.
- The new time-token suite accounts for **15** of those tests. It exercises real
  saved settings, each token with name/ID, full timestamps, zero/nonzero seconds,
  midnight/day rollover, positive/negative fractional offsets, both repeated DST
  hours, exact wrong-time rejection, category/name/ID combinations, transaction
  ownership, status/type/password fences, numeric page/body identity, chosen-date
  edits, saved schedule publication, and WXR second precision.
- An additional source export and **fresh compiled database restore** passed
  **one test each**. They preserve the custom structure, timezone, chosen seconds,
  remapped canonical self-link with `#keep`, new destination ID, and independent
  body-page 2 resolution/content. The permanent staging test is conditional when
  neither archive-stage environment variable is supplied; CI runs both stages
  explicitly on Node 24.

## Real compiled browser check

An owned `agent-browser` session logged into a disposable compiled API through a
test-only loopback origin proxy. No Vite server or dependency cache was used.
The test guard supplied an isolated database/uploads/outbox and random disposable
administrator credentials; the password reached the browser vault through stdin.

1. Opened Permalink Settings, focused Custom Structure, and used Space then Tab
   to reach the correctly described input.
2. Used keyboard text entry for
   `/%year%/%monthnum%/%day%/%hour%/%minute%/%second%/%postname%/`.
3. Tabbed through the category/tag controls to Save Changes, pressed Enter, and
   waited for the actual success notice.
4. Reloaded and checked the exact persisted value, selected custom radio,
   unchanged `aria-describedby`, and all nine supported help tags.
5. Inspected desktop/mobile screenshots at widths **1440** and **375**. The help
   wraps inside its existing space; neither viewport has horizontal overflow.
6. Opened the real public home, inspected the generated title link, clicked it,
   and confirmed `/2024/01/02/03/04/05/time-token-native/` and the correct body.
   The browser reported no page errors.

Screenshots were opened and visually inspected:

- [Settings, desktop](settings-1440.png)
- [Settings, mobile](settings-375.png)
- [Generated link destination](public-link-1440.png)

The browser, vault entry, test-only proxy, disposable API/database/uploads/outbox
were cleaned after the test; ports 3056–3058 were free on the final check.

## Explicit limitations and separate failed probe

Date/time fields follow WorldAct's existing **current site timezone** conversion
of the chosen instant, with the existing creation fallback. Historical stored
local dates after a timezone change, `%author%`/nicename, timestamp-only
identities, additional extension tags, canonical aliases/redirects, and pagination
status policy are outside this draft.

A stronger archive probe first used a self-link ending in a **pretty body-page
suffix** (`.../SOURCE-ID/slug/2/#keep`). It failed on compiled restore because the
existing portable URL mapper does not remap that suffix. Source and compiled
reproductions of this known gap are preserved separately; those failures are
**not counted as green**. The passing canonical `#keep` case does not establish
pretty body-page self-link remapping. That existing mapper behavior requires a
separate portability change.
