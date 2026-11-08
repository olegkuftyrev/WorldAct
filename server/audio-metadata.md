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
and MIME type. Text passes through the shared plain-text sanitizer. Chapters,
arbitrary native tags and embedded cover art are excluded. Existing image
selection supplies playlist artwork; embedded artwork extraction remains work.

The additive `media.audio_metadata` column stores the object. Native REST
attachments expose it through `media_details`, including `length_formatted`.
The local Media API returns `audioMetadata`. Archive export includes the stored
record, but import recomputes metadata from verified restored bytes and ignores
injected metadata claims. Existing uploads receive metadata when reuploaded or
restored; the migration does not synchronously rescan the library.

Primary API reference checked during implementation:
[music-metadata buffer parsing and parser limits](https://github.com/Borewit/music-metadata).
