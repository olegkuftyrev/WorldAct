# Explicit archive Query Title presentation

An explicit `core/query-title` block with `type: "archive"` produces no markup
in a selected singular presentation or an ordinary unfiltered posts home.
The supplied WordPress `blocks/query-title.php` returns before generating its
wrapper in these cases. Actual archives retain their headings. Omitted and
other types retain their existing behavior.

`archiveTitleContext` is server-owned presentation provenance. The final tags
are `selected-singular`, `unfiltered-posts-home` and `preserve`. Only the first
two suppress an explicit archive title, before label lookups or wrapper
generation. Request parameters and saved block attributes cannot set a tag.
The decision is independent of a Query Loop's current post, content mode and
public DTO fields. Final context survives template parts, loops and Post
Content without being reclassified from their current post.

Document acquisition supplies selected-singular context from its held route.
Final template presentation also requires the selected body, so a retired or
missing body cannot mark its fallback as singular. Standalone body reads default
to selected-singular and preserve an explicit preserve override. Direct
template reads give a successfully loaded root post this same priority.
Generic preview and public-post rendering do not infer a selected presentation.

The path resolver passes the internal `"resolved-path"` sentinel. The existing
settings read in `publicPostOnce` converts it to preserve for the active
configured posts page, and selected-singular for another selected body. This
neither reselects the post nor adds a lookup or await. It uses the settings
already held there, without promising an atomic settings snapshot with earlier
path resolution. The final tag is written after the options spread.

Home classification requires posts-front settings, an exact root pathname,
valid percent escapes and no recognized filtering or selection keys in either
the original visible URL or original transport query, as well as the normalized
query. Empty, nested and encoded filter keys still refuse home classification.
Malformed counters also preserve existing output. Valid independent counters
and unrelated keys are allowed. The pure helper performs no settings reads,
SQL, awaits or request validation; refusal produces preserve rather than a new
error or a fallback guess. Static-front mode, its configured posts page,
search, other archives, previews and missing routes do not gain home context.

The common site reader passes proven home context only to its main archive
post bodies. This covers Classic cards and `site.posts.content` in the document
model and public site API. Page, front-page and posts-page sanitation remain
generic. Source Post Content receives the final template context. The direct
template API checks both its visible requestPath and raw transport query; a
date key present in either preserves the existing label policy. In particular,
the path-only date transport quirk is not repaired by this change.

This contract does not implement every WordPress conditional. Label priority,
raw date SQL, query normalization, template selection, canonical URLs, response
status, publication/password fences, and omitted/other Query Title types keep
their existing behavior.
