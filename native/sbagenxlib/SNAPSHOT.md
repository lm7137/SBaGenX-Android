# Vendored Snapshot

This directory contains a vendored `sbagenxlib` source snapshot copied from the
parent `SBaGenX` repo at a pinned revision.

## Source

- repo: `/home/magiktime/projects/SBaGenX`
- tag: `v3.9.0-alpha.5`
- commit: `308f2b827ecba6e690d1881751b1709c1f1f6e9a`
- short: `308f2b8`

## Files copied for the Android bridge

- `sbagenxlib.c`
- `sbagenxlib.h`
- `sbagenxlib_dsp.h`
- `sbagenxlib_curve_impl.h`
- `oggdec.c`
- `flacdec.c`
- `mp3dec.c`
- `libs/tinyexpr.c`
- `libs/tinyexpr.h`
- `libs/sndfile.h`
- `libs/dr_flac.h`
- `libs/ivorbiscodec.h`
- `libs/ivorbisfile.h`
- `libs/ogg.h`
- `libs/mad.h`
- `libs/config_types.h`
- `libs/os_types.h`
- `libs/_G_config.h`

## Scope

This snapshot is currently used for:

- validation and curve inspection
- `.sbg` / program runtime preparation
- JNI render/playback
- latest mix-input config surface from `SBaGenX` `v3.9.0-alpha.5`
- built-in program amplitude defaulting aligned with the Android app's current
  `1/99` program/mix balance rule
- MP3 `SBAGEN_LOOPER` support via embedded tag metadata or explicit override

Codec archive provenance is documented separately in `libs/UPSTREAM.md` and
`docs/android-codecs.md`.
