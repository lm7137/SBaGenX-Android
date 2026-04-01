# Vendored Snapshot

This directory contains a vendored `sbagenxlib` source snapshot copied from the
local `SBaGenX` repo.

## Source

- repo: `/home/magiktime/projects/SBaGenX`
- branch: `main`
- base commit: `f64431572111c262acb140b7ff42d6c42160ce88`
- short: `f644315`
- note: the latest refresh also included local upstream changes that had not yet
  been committed in the parent repo at the time of vendoring

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
- latest mix-input config surface from `SBaGenX/main`
- built-in program amplitude defaulting aligned with the Android app's current
  `1/99` program/mix balance rule

Codec archive provenance is documented separately in `libs/UPSTREAM.md` and
`docs/android-codecs.md`.
