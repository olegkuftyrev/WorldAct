# Explicit archive Query Title in selected singular renders

An explicit `core/query-title` block with `type: "archive"` produces no markup
when the server has selected a singular template or body presentation. This
matches the early return in the supplied WordPress `blocks/query-title.php` for
a singular request. Suppression happens before label lookups and before wrapper
generation, so an empty heading is not a valid substitute.

`RenderOptions.selectedSingular` is server-owned presentation context. It is
independent of raw date filters, current loop posts, content modes, permissions,
and public DTO fields. Document acquisition supplies an explicit boolean from
its held route; final presentation additionally requires the actual selected
body. A missing or retired body therefore cannot mark a fallback as singular.
The common site reader receives no such marker for its page/post sanitation.

The standalone body reader defaults to a selected singular presentation while
preserving an explicit false override. The direct template endpoint uses only
its successfully loaded root post. These choices persist through template
parts, nested Query Loops, and Post Content; a loop's current post does not
replace the root presentation context. Actual archive loops retain their
archive titles, including titles inside a loop post's body.

The path resolver passes the internal `"resolved-path"` sentinel. The existing
settings read in `publicPostOnce` resolves it to false for the active configured
posts page and true for another selected body. This introduces no additional
lookup or await and never reselects a post. It uses the settings already acquired
there; it does not promise an atomic settings snapshot with earlier path
resolution. Explicit document booleans are preserved. The normalized value is
written after the options spread, and only strict true suppresses a heading.
Neither a request parameter nor saved block attributes can set this option.

This change does not implement every WordPress query conditional. Omitted or
other Query Title types, home/search/404 eligibility, label priority, raw date
SQL, template selection, canonical URLs, response status, and publication or
password fences keep their existing contracts.
