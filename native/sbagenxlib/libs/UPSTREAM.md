# Vendored Android Codec Archives

These archives are vendored Android build inputs for `sbagenxlib` mix decoding.

## Protocol

They should be produced from a pinned revision of the parent `SBaGenX` repo by
running:

- `android-build-libs.sh`

Then copied into this directory as a snapshot.

This repo should not depend on the parent repo remaining present at build time.

## Current vendored snapshot

Parent repo:

- `/home/magiktime/projects/SBaGenX`

Parent tag:

- `v3.9.0-alpha.5`

Parent commit:

- `308f2b827ecba6e690d1881751b1709c1f1f6e9a`

ABIs:

- `arm64-v8a`
- `x86_64`

Archives:

- `android-arm64-v8a-libogg.a`
- `android-arm64-v8a-libvorbisidec.a`
- `android-arm64-v8a-libmad.a`
- `android-x86_64-libogg.a`
- `android-x86_64-libvorbisidec.a`
- `android-x86_64-libmad.a`

## Status

This snapshot was rebuilt from the pinned clean upstream tag above, using that
revision's `android-build-libs.sh`.
