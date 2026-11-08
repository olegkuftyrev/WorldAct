# Dashboard data

`GET /api/dashboard` requires the existing administrator, editor, author or
contributor dashboard capability. It returns independent, bounded queries for
the source Dashboard widgets; a limit on recently modified content must never
hide publication activity or the current user's drafts.

- `recentPublished`: five published posts, newest publication date first (ID is
  the stable tie breaker). Readable metadata is available across authors;
  `canEdit` identifies whether the current actor may open the editor.
- `publishingSoon`: five editable future posts, earliest scheduled date first.
  Administrators/editors see all, authors see their own, contributors see none.
- `recentDrafts`: four of the current user's post drafts, newest modification
  first. The UI displays three and can use the fourth to show View all drafts.
  `preview` contains at most ten plain-text words, derived from at most 10,000
  characters of stored content, with a further 1,000-character output limit.
- `recentPosts`: the existing five recently modified, non-trash records, kept
  as a compatibility field and reduced to metadata. New activity/draft widgets
  should use the dedicated arrays above.
- `recentComments`: the existing five recent non-trash/non-spam comments in the
  actor's dashboard scope. Before applying the limit, retain only comments on
  editable posts or publicly readable published, unprotected posts. Account
  identity and email are removed when the actor cannot edit the underlying post.
  `canEdit` controls moderation affordances; `postPermalink` always points to the
  canonical public post. Its private intermediate post context is metadata-only
  and is removed from the returned comment DTO.
- `application`: the WorldAct name and the actual package version.
- `theme`: the active registered theme ID, name and version, including Classic.

Post metadata excludes content, canonical raw source, blocks, footnotes, excerpts
and password hashes. Existing count scoping remains unchanged. Canonical links
come from the shared permalink implementation. The endpoint does not make
unreadable drafts, private content or scheduled content public.

The matching Dashboard UI is a separate integration requirement. It should use
publication/scheduled timestamps, respect `canEdit`, and derive its version/theme
labels from these fields rather than hardcoded labels.

Regression coverage in `tests/dashboard.test.ts` creates more than five newer
pages/drafts, multiple authors, ordered future posts, protected publications and
a contributor-owned published comment; it also exercises all registered themes
and anonymous/subscriber denial through the actual API.
