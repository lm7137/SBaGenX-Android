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

Parent base commit at build time:

- `f64431572111c262acb140b7ff42d6c42160ce88`

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

This snapshot was created during Android bring-up, before the parent repo's
Android codec script and related amplitude changes were committed upstream.

Treat this provenance as provisional. The next codec refresh should rebuild
these archives from a pinned clean parent revision after those upstream changes
land.
