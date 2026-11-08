# Normalized full uploads and retained originals

Source references (read as data; no PHP executes):
`wp-admin/includes/image.php` `wp_create_image_subsizes()` and
`_wp_make_subsizes()`, `wp-includes/class-wp-image-editor.php`
`maybe_exif_rotate()`, the default `medium_large` options in
`wp-admin/includes/schema.php`, and `_wp_add_additional_image_sizes()` in
`wp-includes/media.php` registered by `default-filters.php`.

Regular supported raster uploads now generate a normalized full image when
either original axis exceeds the source's 2560-pixel threshold, or when a
smaller JPEG has EXIF orientation 2–8. The existing source geometry constrains
both full-image axes, including its one-pixel unchanged tolerance. For example,
3000×1500 becomes 2560×1280; 2561×1 retains the original because the source
resize helper declines an effectively identical intermediate. A declined
threshold resize also preserves the original rather than inventing a rotated
full image through a different source branch.

JPEG EXIF orientations apply consistently to full normalization, intermediate
sizes, and manual edits. PNG/WebP/AVIF/GIF EXIF orientation flags do not add an
unrequested rotation. JPEG/PNG/GIF/WebP/AVIF output preservation, alpha, color
profiles, source quality defaults, and first-frame behavior remain as documented
in `image-formats.md`. Ordinary smaller unrotated uploads remain byte-exact.
The full-image size/dimensions/MIME fields describe the current normalized file.

The uploaded bytes are retained as the fixed `derivatives["original-upload"]`
file when normalization created a distinct full image. Intermediate sizes use
the raw upload, with JPEG orientation, so they retain source quality and can
even exceed the normalized full when a configured size requests it. Source
registered `medium_large` (768×0), `1536x1536`, and `2048x2048` supplement the
three configured sizes; setting those three sizes to zero does not disable the
independently registered sizes.

The fixed raw-upload file is separate from `original_filename`, which remains
the manual-edit backup. A newly normalized upload has `canRestore:false` and
no manual original backup. Its first manual edit backs up the normalized full.
Restore Original returns to that normalized full, leaves raw uploaded bytes
available, and preserves all prior edited/sub-size URLs until their last
reference is permanently deleted. Existing attachment IDs, attached/featured
references, settings, and old records retain their existing contracts.

Ordinary media DTOs now expose optional nullable `originalUploadUrl` only for
the fixed sentinel and verified generated/imported path shape. Native REST
continues to use the current full image as `source_url` and `sizes.full`, with
the separate `original_image_url` and source-style
`media_details.original_image` basename when a retained upload exists. Unknown
derivative keys and traversal/arbitrary paths never become original links.
This retains the existing public-upload URL policy and adds no remote fetches.
UI handoff: offer **Download original** from `originalUploadUrl` when present;
do not replace the current image URL or infer `canRestore` from this field.
No visual UI changes are included here.

Every new raw, normalized, and sub-size write uses exclusive file creation.
Ownership is recorded after the exclusive open and before a possibly partial
write. Failure cleanup removes owned partial files while preserving an EEXIST
path. Upload and manual-edit full-file writes now sit within their cleanup
scope. Database failures use reference-aware cleanup after rollback so an
uncertain commit does not erase a referenced file. Pixel decoding remains
mandatory even when no intermediate can be produced. JSON archives already
copy and remap the full file graph, including the sentinel, and old archives
without a raw sentinel still import.

`tests/full-image-uploads.test.ts` uses real pixels/signatures and actual API
requests for large supported formats/alpha, JPEG orientations 2–8 with corner
checks, non-JPEG/untouched and one-pixel edge cases, source-quality sub-sizes,
public/native current full URLs, raw downloads, first edit/restore, shared-file
archive aliases and old archives, invalid original links, partial-write and
exclusive-collision injection, and upload/edit transaction rollback. Explicit
`FULL_IMAGE_ARCHIVE_STAGE=export|restore` phases verify checksums, raw links,
new local paths, and normalized restore across separate fresh databases.

No schema, upload MIME allowlist, output codec, native size-chooser labels, or
setting defaults are added by this batch. `stageImageUpload()` and
`writeNewMediaFile()` are internal staging helpers; callers own their database
transaction and must preserve the owned-file cleanup contract.
