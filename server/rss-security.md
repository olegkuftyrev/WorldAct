# RSS block behavior and transport boundaries

The renderer ports the supplied `wp-includes/blocks/rss.php` and block metadata:
five items, 55-word excerpts, list layout, two grid columns, optional dates,
authors and excerpts, new-tab links and `rel`, source placeholders and homepage
refusal. Native editing uses the existing `core/rss` block metadata and
ServerSideRender routes. RSS 2.0, RSS 1.0/RDF and Atom feeds are parsed as data.
No remote HTML, scripts or images are embedded in the resulting block.

Remote reads accept absolute HTTP(S) URLs without credentials, controls or
backslashes, on public ports 80, 443 or 8080. Fragments and terminal DNS dots are
normalized. Every DNS answer must be public. The actual Node connection uses a
fixed lookup callback returning the checked address, retains its original
hostname/TLS certificate verification, disables connection reuse, and verifies
the connected peer. Every redirect repeats validation. IPv4 private/reserved
ranges, IPv6 local/special/transitional ranges and mapped private IPv4 addresses
are refused. Requests forward no caller cookies, authorization or referrer.

The transport permits three redirects, eight seconds overall, two seconds per
DNS lookup, four seconds idle socket time, 1 MiB on the wire and 2 MiB after
gzip/deflate/Brotli decompression. Four active requests and 64 queued requests
are allowed per process. Timed-out OS lookups retain their four-slot reservation
until the OS operation actually settles. XML rejects DTDs/entities, over 40
levels, 10,000 nodes and oversized text; no PHP or shortcode evaluation occurs.

External parsed feeds persist for 12 hours in PostgreSQL, matching supplied
`wp_feed_cache_transient_lifetime`; failures cache for one minute. Cache writes
prune expired rows and retain at most 256 entries/32 MiB of declared normalized
payload after concurrent work settles. Individual values are limited to 256
KiB. Shared render state deduplicates URLs and permits four new external feeds;
its existing SQL/node/depth/output limits still apply. In-flight work stays
coalesced through the cache write.

Known feeds on the configured site/application origin are read directly from
published post data. They perform no HTTP request, interpret no nested blocks,
forward no password grants and bypass the persistent cache. Protected content
always becomes the standard protected excerpt, so adding a password cannot
leave an older local cache exposing the post. Automatic excerpts use the legacy
teaser/first-page selector and omit footnote references and note bodies. Other
URLs on those origins are refused.

Runtime API references checked during implementation:

- [Node HTTP request/lookup and connection options](https://nodejs.org/api/http.html)
- [Node DNS lookup with all answers](https://nodejs.org/api/dns.html)
- [Node bounded decompression options](https://nodejs.org/api/zlib.html)
- [IANA IPv4 special-purpose ranges](https://www.iana.org/assignments/iana-ipv4-special-registry/)
- [IANA IPv6 special-purpose ranges](https://www.iana.org/assignments/iana-ipv6-special-registry/)

Tests use injected transport/DNS fixtures and disposable PostgreSQL databases;
no external feed, mail or Akismet requests are made.
