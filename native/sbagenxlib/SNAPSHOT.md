# Vendored Snapshot

This directory contains a pinned `sbagenxlib` source snapshot copied from the local `SBaGenX` repo.

## Source

- repo: `/home/magiktime/projects/SBaGenX`
- branch: `main`
- commit: `519b5fc09a13afb45466981574fe5e9b215c4a8d`
- short: `519b5fc`

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

Android still uses the platform media stack for actual mix decoding, but the
vendored engine snapshot now matches the looper-override handoff baseline.
