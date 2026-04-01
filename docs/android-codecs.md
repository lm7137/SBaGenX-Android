# Android Codecs

## Purpose

This repo vendors Android codec archives so release builds do not depend on a
live sibling checkout of `SBaGenX`.

Those archives are build inputs for the native mix-input path used by
`sbx_mix_input_create_stdio(...)`.

## Protocol

The parent `SBaGenX` repo is the source of truth for Android codec build
recipes.

Use this workflow whenever the vendored Android codec archives are refreshed:

1. Choose a specific `SBaGenX` commit or tag.
2. Check out that exact revision in the parent repo.
3. Run `android-build-libs.sh` from that exact revision.
4. Copy the resulting Android codec archives into this repo.
5. Update the provenance note beside the vendored archives.

Do not build codec archives from an arbitrary dirty parent working tree and do
not make Android release builds depend on codec archives that live only in the
parent repo.

The Android project intentionally uses a snapshot/vendor model, not a live
shared-directory model.

## Current vendored codecs

Vendored archives live in:

- `native/sbagenxlib/libs/`

Currently vendored Android codec archives:

- `android-arm64-v8a-libogg.a`
- `android-arm64-v8a-libvorbisidec.a`
- `android-arm64-v8a-libmad.a`
- `android-x86_64-libogg.a`
- `android-x86_64-libvorbisidec.a`
- `android-x86_64-libmad.a`

ABIs covered:

- `arm64-v8a`
- `x86_64`

## Current provenance status

The current vendored codec archives were rebuilt from the pinned parent
`SBaGenX` tag:

- `v3.9.0-alpha.5`

Parent commit:

- `308f2b827ecba6e690d1881751b1709c1f1f6e9a`

Build script used:

- `android-build-libs.sh`

This is now a clean pinned refresh rather than a provisional local-working-tree
snapshot.

## Provenance note

The companion provenance note for the vendored archives lives at:

- `native/sbagenxlib/libs/UPSTREAM.md`

Update that note whenever the codec archives are refreshed.
