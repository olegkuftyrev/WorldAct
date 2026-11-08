# Closing-punctuation boundary successor

Code `57d2e2f31769954010e2e3fe4dc0ab6cb282578e`, based on
`4711b83d346fd8d26b3b0a2f7539cf46b3efa5bf`. Earlier code `82a61dc` and its
independent **NEEDS_REVISION** report/failing probe remain frozen and preserved.
These are author gates; independent successor review and release remain pending.

The independent P2 found that actual HTTP archive imports rebased a parenthesized
absolute canonical URL but left the adjacent known body-page URL on its source
origin/ID. The existing absolute URL scanner includes trailing `)`; canonical
continuations already accepted that boundary, while the new body regex did not.

The scoped successor separates the same closing-parenthesis/optional-punctuation
tail for body matching, checks the numeric-child alias guard against that URL,
and restores the exact tail after mapping. Complete mixed-map identity priority
still runs first. Rejected/unknown links keep their full original token. No
scanner, eligibility metadata, public resolver, status, schema or UI change.

| Check | Result |
| --- | --- |
| Typecheck and production browser/server builds | PASS |
| Related source selector, 15 files | 112 pass, 0 fail, 0 skip |
| Same selector with compiled API | 112 pass, 0 fail, 0 skip |
| Byte-identical independent punctuation probe on the same retained author archive | 1 source pass / 1 compiled pass |
| Original unchanged body-page archive probe on that retained archive | 1 source pass / 1 compiled pass |
| Expanded fresh boundary archive export/source restore/compiled restore | 1 pass per phase |

The immutable independent probe SHA256 is
`904f624b3d0da832777c410303f61dda24f18e14edd950f2a64d6a5a0d7c66a4`.
Both source and compiled successor HTTP runs use the same read-only retained
author archive, SHA256
`a25d68ee60af2d78cb54ee325138b9c64a2534d481e6da12333307263cf7e5a7`.
Probe/archive hashes were verified unchanged. Original independent FAIL logs
remain **0 pass / 1 fail each**; they were not overwritten or relabeled.

Permanent cases cover one/nested closing parentheses with comma/period/semicolon,
relative/absolute URLs, query/hash and Plain joins/collisions, exact numeric child
priority, alternate child slash with punctuation, and scoped unknown/extra-path,
other-origin, term/media/font negatives. Real fresh HTTP archive phases cover
those prose boundaries, new destination IDs and Plain/Numeric/source formats,
known children and child aliases, selected body content, preserved private and
protected denial, and the existing late rollback/retry checks. Source fixture
DB/uploads are gone before fresh restores. Pure helpers remain source imports
in either selector mode; the independent probe and staged imports exercise the
respective actual source/compiled HTTP servers.

The accepted exported-graph limit remains: an omitted numeric child can share a
valid parent body-page spelling, and the archive cannot establish that original
resolution without the missing identity. No complete absent-identity ambiguity
guarantee is claimed. No new manifest or source-Plain-to-Pretty conversion was
introduced.

All tests used guarded disposable local resources; no install, shared dependency
cache, PHP/MySQL, benchmark, main merge/push, or browser was used. Temporary probe
copies and the checkout environment were removed; owned ports 3056–3058 are free.
Original archives/failure evidence and the new private review archive are retained
until root finishes review and the matching release CI is green.
