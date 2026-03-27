# Vendored Snapshot

This directory contains a pinned `sbagenxlib` source snapshot copied from the local `SBaGenX` repo.

## Source

- repo: `/home/magiktime/projects/SBaGenX`
- branch: `gui-v3.0`
- commit: `5088272e38b11a762ec6e411a833f948db6f741e`
- short: `5088272`

## Files copied for the initial Android bring-up

- `sbagenxlib.c`
- `sbagenxlib.h`
- `sbagenxlib_dsp.h`
- `sbagenxlib_curve_impl.h`
- `libs/tinyexpr.c`
- `libs/tinyexpr.h`
- `libs/sndfile.h`

## Scope

This snapshot is currently used for:

- `sbx_version()`
- `sbx_api_version()`
- `.sbg` validation
- `.sbgf` validation

Android phase 1 intentionally avoids optional export/codec packaging work.
