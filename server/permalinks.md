# Canonical category paths

When the configured structure contains `%category%`, permalink generation selects
the assigned category with the lowest term ID, then includes its ancestor slugs.
This follows the supplied `wp-includes/link-template.php` category selection and
parent composition, regardless of category name order or the order/contents of a
partial post DTO. Each slug is encoded independently so hierarchy separators stay
real path separators. Metadata-only DTO category selection uses the same ID order.

One recursive PostgreSQL statement reads selection and parents in one snapshot.
The recursive `UNION` visits each persisted ancestor ID once, and a linear map
walk preserves the full accepted chain without a depth cutoff. Cyclic/corrupt
historical relationships therefore terminate without quadratic visited arrays.
A missing parent ends the known chain. Normal term deletion reparents
children through the existing transactional term implementation. Category paths
are recomputed rather than cached, so renames/reparenting affect subsequent
canonical links without a stale process cache. No redirect from a former category
path is claimed by this change.

An unassigned post uses the current configured default category's leaf slug,
matching the supplied source fallback. If that setting is unavailable, the existing
default marker/lowest-ID category is used; an empty taxonomy uses `uncategorized`.
The assigned-category walk and default fallback remain destination-local after
archive IDs are remapped.

The exact public resolver accepts a category path spanning multiple segments and
compares the whole regenerated canonical permalink. A different/old/partial
category chain cannot select the same post. Exact identities still win before a
numeric content-page suffix. Existing password/private/readability rules remain
with the actual public endpoints. Malformed URI decoding fails without inventing
a post identity.

All consumers share this generator: core/native metadata, blocks, feeds, sitemap,
public navigation, outgoing source URLs, incoming target checks and archive link
rebasing. Incoming notifications re-read canonical identity after source HTTP
verification; a committed ancestor rename invalidates an old verified target.
No client or transaction is retained across remote I/O.

Regression checks cover lowest-ID versus name/DTO order, three-level ancestry,
metadata/render/feed/sitemap links, exact and content-page resolution, an actual
held incoming verification with concurrent rename, transaction visibility,
default fallback, cycles/deletion and fresh-ID WXR. Outgoing tests cover actual
worker source URLs with nested/multiple categories and timezone date tokens.
Two-stage site archive coverage asserts nested source/destination URLs and menu
rebasing on different fresh databases after source files are removed.

The Plain query-ID backend is described in [its separate contract](plain-permalinks.md).
Matching settings controls/React routing and additional source tokens remain
separate integration work.
