# WordPress XML content selection

The supplied `wp-admin/export.php` and `wp-admin/includes/export.php` provide the
reference behavior; they never execute. The administrator-only XML endpoint is
`GET /api/tools/export?format=wxr` with these optional query values:

| Value | Meaning |
| --- | --- |
| `content` | `all` (default), `posts`, `pages`, or `attachment` |
| `category` | Positive category ID, applied only to Posts; exact assignment |
| `author` | Positive account ID, applied to the selected content type |
| `startDate`, `endDate` | `YYYY-MM` local site months, inclusive |
| `status` | Fixed implemented publishing status, applied only to Posts/Pages |

All content ignores selection filters, preserving the whole-site XML contract.
JSON export remains the existing full archive. Invalid scalar, repeated, unknown
or out-of-range query values return 400. SQL values always use parameters.
The endpoint takes a repeatable-read, read-only snapshot of the selected records
and releases the connection before XML formatting. Publication/schedule/creation
fallback dates and upload creation dates are converted to the configured IANA or
fixed-offset site timezone before comparing civil month boundaries. The end
month ends at the first instant of the following local month.

Filtered Posts/Pages include their own comments, assigned terms and category
ancestors, attached uploads and featured attachments. Nested fixed `core/block`
and `core/navigation` references are included so WorldAct's existing shared
export namespace and fresh-ID import preserve those dependencies. Unrelated
posts, uploads, comments and entities are excluded. Kind mismatches do not bind
another entity type; a later valid request for the same ID still resolves.
Cycles terminate, with limits of 64 reference rounds, 10,000 entity IDs and 25,000
nodes per inspected block document. Media-only export uses upload date filters
and includes the relevant author declarations. Files remain external attachment
URLs in WXR; import still reports them without downloading.

`GET /api/tools/export/options` returns administrator-only safe author labels,
category hierarchy and available local months for the three selectable types.
It returns no account email, password or credential metadata. Native filter
controls are an independent frontend implementation and review step.
