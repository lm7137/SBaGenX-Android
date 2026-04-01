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

The current vendored codec archives were produced during Android bring-up from
the local parent `SBaGenX` checkout based on commit:

- `f64431572111c262acb140b7ff42d6c42160ce88`

At the time those archives were built, the parent repo also contained local
uncommitted Android codec/amplitude work. That means the current provenance is
good enough to explain where the archives came from, but it is still
transitional.

Once the upstream parent repo commits:

- `android-build-libs.sh`
- the built-in program amplitude changes

the codec archives in this repo should be rebuilt from that pinned clean parent
revision and this note should be refreshed.

## Provenance note

The companion provenance note for the vendored archives lives at:

- `native/sbagenxlib/libs/UPSTREAM.md`

Update that note whenever the codec archives are refreshed.
