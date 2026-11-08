# Configured image size semantics

This Node/Sharp implementation reads the supplied WordPress source as a
reference. No PHP executes. The relevant source is
`wp-admin/options-media.php` (the six inputs accept zero), and
`wp-includes/media.php`, `wp_constrain_dimensions()` and
`image_resize_dimensions()` (unconstrained axes, centered crop, rounding,
no enlargement, and skipping an unchanged intermediate within one pixel).

`thumbnailWidth`, `thumbnailHeight`, `mediumWidth`, `mediumHeight`,
`largeWidth`, and `largeHeight` accept whole numbers including zero. Existing
maximums remain 4096 for thumbnail axes and 8192 for medium/large axes.
Defaults remain 150×150, 300×300, and 1024×1024 when values are absent.

- Both dimensions zero disable that configured intermediate size.
- One zero dimension leaves that axis unconstrained, preserving aspect ratio.
- Thumbnail cropping uses source center-crop geometry. For example, a 600×300
  image with a 400×400 crop produces 400×300, while a non-cropped size produces
  400×200. Medium and large sizes constrain without cropping.
- Images are not enlarged. An unchanged result, including the source's one
  pixel tolerance, keeps the original without a duplicate intermediate.
- If an extremely thin crop rounds one side to zero, the intermediate is
  omitted and the original remains available.

The shared generator applies on new uploads, image edits, restore-original,
and extracted audio covers. Its geometry accounts for source-supported JPEG EXIF
orientation. Generated sizes preserve their supported verified raster format;
see `image-formats.md` for the source-derived encoder policy.
Changing settings does not regenerate existing attachments or remove historical
files; subsequent edit/restore uses the current settings. Permanent deletion
still removes all unreferenced original, edited, and historical size files.

JSON archives retain these zero settings and embed the existing verified image
bytes. Import does not invent disabled sizes or regenerate stored sub-sizes.
The supplied source also registers `medium_large` (768×0), `1536x1536`, and
`2048x2048` independently of these three configured sizes. They are generated
when source geometry permits a smaller size, including when the six configured
dimensions are zero. The default native size chooser still exposes Thumbnail,
Medium, Large, and Full; the additional sizes do not invent chooser labels.
The native media REST response always includes `media_details.sizes.full`.
The editor adapter and public featured-image, Latest Posts, and gallery paths
already fall back to the full image when a named intermediate is absent.

Frontend handoff: set all six Media settings input minimums to `0`, retaining
the current maximums. Explain that `0 × 0` disables a size and a single zero
leaves its axis unconstrained. Image-editor scale/crop dimensions remain
strictly positive; they are a separate contract. No UI is changed by this
backend batch.

Verification lives in `tests/media-zero-dimensions.test.ts`, with actual image
bytes, oriented JPEG geometry, source crop and rounding cases, missing settings,
upload/edit/restore, permissions, file history and deletion, public/native
fallbacks, archive checksums, invalid settings, and rollback cleanup. Tiny
artwork and fresh-site archive fixtures assert the valid full-image fallback.
