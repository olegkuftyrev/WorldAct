# Raster output preservation

The supplied WordPress `WP_Image_Editor::get_output_format()`, GD/Imagick
`_save()` methods, and `wp_save_image_file()` are reference data, never executed.
Their default behavior keeps the supported source format. The only built-in
conversion mapping is HEIC/HEIF to JPEG, which is outside WorldAct's existing
upload allowlist and this implementation.

Generated Media Library sizes and image edits now preserve the verified JPEG,
PNG, GIF, WebP, or AVIF format. Selection uses the local byte signature, Sharp's
matching decoder, and its encoder capability. Request MIME, filename suffix,
and stale stored MIME never select a codec. Unsupported formats are rejected;
they do not silently convert to PNG or broaden the upload policy.

JPEG uses the source's default quality 82 and non-progressive output. WebP uses
quality 86; VP8L source files retain lossless output. AVIF uses quality 82 and
Sharp effort 2 for a fast encoder configuration (the source Imagick backend
uses HEIC speed 7). The codec engines are different, so compressed bytes need
not match WordPress's GD/Imagick output. PNG remains PNG, with alpha retained;
WebP/AVIF alpha and GIF transparency remain supported. Derived GIFs and other
animated inputs use the first frame, matching the supplied Imagick editor's
explicit frame-zero selection. Original uploaded bytes remain unchanged.

Generated files carry their actual extension and MIME in Media API/REST sizes.
Edits normalize supported JPEG EXIF orientation before crop, manual rotation, and scaling;
derived files retain color profiles while dropping private EXIF/IPTC metadata
and stale orientation. Uploaded originals remain byte-for-byte, including their
metadata. Full-image upload scaling and JPEG orientation normalization are
described in `image-uploads.md`. A manual edit backs up the current full image;
Restore Original returns to that full image and rebuilds its registered sizes.
This does not add new image formats, plugin format filters, or animated editing.
Site Icon's dedicated PNG pipeline is a separate existing contract.

Existing original, current, and previous size URLs remain available after edits
and restore. Their reference-aware permanent deletion policy is unchanged.
Old archives with JPEG originals and PNG edited files or PNG sub-sizes continue
to import. Each embedded file already receives a fresh extension from its
verified signature; sub-size MIME and dimensions now also come from decoded
bytes rather than untrusted archive metadata. A non-image sub-size rejects the
transaction and removes copied files. No image bytes are downloaded remotely.

No API request shape, UI, schema migration, or setting default changes. The
existing Media Library controls and native REST adapters consume the corrected
MIME/extension metadata directly.

Omitting all intermediate sizes still requires a full first-frame pixel decode,
so a truncated tiny image with readable header dimensions cannot be uploaded.
Embedded archive images and legacy local-file copies receive that same full
decode validation before any staged copy. A rejected image leaves records and
files unchanged; original compressed bytes are otherwise preserved.

`tests/media-format-preservation.test.ts` checks real output signatures and
decoded geometry for all five raster formats, alpha, lossless pixels, frame
selection, misleading MIME hints, EXIF/manual rotation, crops/scaling, restore,
permissions, retained history and reference-aware deletion, mixed old PNG
archives, metadata corrections and failed-import file rollback. Its explicit
`IMAGE_FORMAT_ARCHIVE_STAGE=export|restore` phases verify byte checksums and
MIME metadata across two fresh disposable databases.
