# Audio metadata boundary

Audio uploads and restored archive media use the JavaScript `music-metadata`
parser, pinned to 12.3.5. The source reference is the supplied
`wp_read_audio_metadata()` and the native playlist `getTrackAttributes()` helper.
The parser receives only already-sniffed upload bytes; it never receives a URL
or reads caller-selected files. There is no PHP/getID3 runtime.

Each parse runs in a separate worker with 64 MiB old-generation memory,
16 MiB young-generation memory, a 4 MiB stack, five seconds of wall time,
4 MiB per metadata allocation and 1,000 entries per metadata list. At most two
parsers run concurrently. Files retain the existing 32 MiB upload/archive bound.
Parser reservations remain held until physical worker exit; a message, error,
timeout or rejected termination cannot release a still-live worker's slot.
Worker failure or unsupported metadata yields an empty metadata object without
discarding an otherwise accepted media file. Excess concurrency returns 503.

Only bounded descriptive/technical fields cross the worker boundary: title,
artist, album, genre, year, rounded duration and formatted duration, codec,
container, sample rate, bitrate, channel/bit counts, lossless flag, file size
and MIME type. Text passes through the shared plain-text sanitizer. Chapters
and arbitrary native tags are excluded. The upload inspector can separately
return the first embedded artwork payload, bounded to 2 MiB. Cover bytes never
enter descriptive metadata or JSONB. A MIME hint is insufficient: storage
sniffs JPEG/PNG/GIF/WebP/AVIF bytes, checks a 20-million-pixel limit and creates
normal image sizes to verify complete decoding. Linked artwork is never fetched.

Verified artwork becomes an ordinary image attachment, with hash-based reuse
inside the uploader's ownership boundary. An advisory lock prevents concurrent
duplicate images. Upload inserts the cover and audio attachment in one database
transaction and removes newly created files on failure. Deleting audio retains
the reusable cover; deleting the image clears referencing audio pointers.

The additive `media.audio_metadata` column stores the object. Native REST
attachments expose it through `media_details`, including `length_formatted`.
The local Media API returns `audioMetadata`, `artworkMediaId` and the safe
`image` descriptor expected by playlist media selection. Archive export includes
the stored record, but import recomputes metadata from verified restored bytes
and ignores injected metadata claims. Cover references resolve only inside the
imported media graph and must point to restored images. Existing uploads receive
metadata when reuploaded or restored; the migration does not synchronously rescan
the library or extract new cover attachments while restoring older archives.

Primary API reference checked during implementation:
[music-metadata buffer parsing and parser limits](https://github.com/Borewit/music-metadata).
