# AAC M4A fixture

`aac-tone.m4a` is a locally generated two-second, stereo AAC 440 Hz sine wave.
It contains no third-party recording or personal metadata. The source PCM
was mono 16-bit, 44,100 Hz, amplitude 1,200, generated mathematically, then encoded
using macOS `/usr/bin/afconvert -f m4af -d aac@44100 source.wav aac-tone.m4a`.

This tiny checked-in file lets Linux and macOS test the same genuine AAC
container without depending on a platform encoder during the test run.
`file-type` 22.3.0 identifies its M4A brand as `audio/x-m4a`; the media boundary
normalizes only that verified M4A pair to canonical `audio/mp4`.
