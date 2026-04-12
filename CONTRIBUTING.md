# Contributing to SBaGenX Android

## Where to start

Use GitHub Discussions for:

- product ideas
- workflow questions
- UI and roadmap discussion
- feedback on alpha builds

Use GitHub Issues for:

- reproducible app bugs
- playback or validation regressions
- docs gaps
- concrete feature requests

## Good first contributions

- add or improve screenshots/GIFs for the README and release posts
- tighten install and tester instructions
- improve Android-specific docs
- verify behavior on additional Android devices and versions
- refine storage, import, or playback UX

## Important engineering rule

If a change belongs in the shared engine, land it in the parent `SBaGenX` repo first.

Then, when this repo vendors a new engine snapshot:

- update `native/sbagenxlib/SNAPSHOT.md`
- update `docs/android-codecs.md` if codec inputs changed
- update `native/sbagenxlib/libs/UPSTREAM.md` when codec archives are refreshed

Do not rely on an arbitrary dirty sibling checkout for release builds.

## Bug reports

Please include:

- Android version
- device model
- app version / tag
- whether playback, validation, or mix input is affected
- logs, screenshots, or sample files where possible

## Code of conduct

By participating in this project, you agree to follow [`CODE_OF_CONDUCT.md`](CODE_OF_CONDUCT.md).
