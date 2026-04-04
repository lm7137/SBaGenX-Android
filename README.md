# SBaGenX Android

Separate Android frontend for `sbagenxlib`, built with React Native and a Kotlin/JNI native bridge.

Upstream project: [SBaGenX](https://github.com/lm7137/SBaGenX).

Release APKs bundle the native Android codec archives needed for `sbx_mix_input_create_stdio(...)`, so OGG, MP3, and FLAC mix playback works without a sibling checkout of the upstream repo.

## Current milestone

The repo is scaffolded as a plain React Native app and already includes:

- a vendored `sbagenxlib` snapshot in `native/sbagenxlib/`
- an Android NDK/CMake build that compiles `libsbagenxbridge.so`
- a Kotlin React Native module that calls into JNI
- a native Android editor workbench for `.sbg` sequence files and `.sbgf` curve files
- real `sbx_version()`, `sbx_api_version()`, `sbx_validate_sbg_text()`, and `sbx_validate_sbgf_text()` calls
- `.sbgf` curve metadata inspection during validation, including solve-backed parameter values after native prepare
- built-in program mode for `drop`, `sigmoid`, `slide`, and `curve`
- a persistent native `SbxContext` for `.sbg` documents
- preview rendering of PCM float samples from JNI without audio output
- live Android playback for sequence files and built-in programs via `AudioTrack`
- safe `-SE` preamble handling during `.sbg` prepare/playback
- runtime mix support for `.sbg` `-m` inputs and program-mode mixes resolved from bundled app assets, file paths, or `content://` URIs
- native stdio-backed mix inputs via `sbx_mix_input_create_stdio(...)` for WAV/raw, FLAC, OGG, and MP3 using bundled Android codec archives
- `SBAGEN_LOOPER` override state for loaded mixes, with Android keeping mix/looper settings outside the edited `.sbg` text
- mix metadata inspection that prepopulates `SBAGEN_LOOPER` when present in the selected file
- live beat preview plotting sampled directly from `sbagenxlib`
- user-chosen document library storage with Android folder/document pickers and sandbox fallback

What is not implemented yet:

- full plot coverage beyond beat preview, such as mix-amplitude or isochronic-cycle inspectors
- standalone `.sbgf` runtime outside built-in `curve` program mode
- export workflows
- iOS native bridge parity

## Local toolchain

- Node `22.x` via `nvm`
- Java 17
- Android SDK with NDK support

Example shell setup:

```sh
source ~/.nvm/nvm.sh
nvm use 22
```

## Run the app

Start Metro:

```sh
npm start
```

In another terminal, build and deploy Android:

```sh
source ~/.nvm/nvm.sh
nvm use 22
npm run android
```

To build the Android app without deploying:

```sh
cd android
./gradlew :app:assembleDebug
```

## Repo layout

- `src/`: React Native UI and JS bridge wrappers
- `android/`: Android app, Kotlin native module registration, Gradle config
- `native/jni/`: JNI and CMake entry point
- `native/sbagenxlib/`: vendored engine snapshot for Android bring-up
- `docs/`: Android-specific notes

## Bridge surface today

- `getBridgeInfo()`
- `validateSbg(text, sourceName)`
- `validateSbgf(text, sourceName)`
- `validateCurveProgram(text, mainArg, sourceName)`
- `sampleBeatPreview(text, sourceName)`
- `sampleProgramBeatPreview(programKind, mainArg, dropTimeSec, holdTimeSec, wakeTimeSec, curveText?, sourceName?, mixPath?)`
- `prepareSbgContext(text, sourceName, mixPathOverride?, mixLooperSpec?)`
- `prepareProgramContext(programKind, mainArg, dropTimeSec, holdTimeSec, wakeTimeSec, curveText?, sourceName?, mixPath?, mixLooperSpec?)`
- `getContextState()`
- `renderPreview(frameCount, sampleValueCount)`
- `resetContext()`
- `startPlayback(text, sourceName, mixPathOverride?, mixLooperSpec?)`
- `startProgramPlayback(programKind, mainArg, dropTimeSec, holdTimeSec, wakeTimeSec, curveText?, sourceName?, mixPath?, mixLooperSpec?)`
- `stopPlayback()`
- `getPlaybackState()`
- `listDocuments()`
- `getDocumentStoreInfo()`
- `saveDocument(name, text)`
- `loadDocument(name)`
- `pickLibraryFolder()`
- `pickDocumentToLoad()`
- `pickMixInput()`

The current editor workbench can validate both `.sbg` and `.sbgf`, inspect prepared `.sbgf` curve parameters from `sbagenxlib`, run built-in programs, sample live beat previews for sequence and program modes, save documents into a chosen library folder, prepare persistent native render contexts, preview rendered PCM samples, and start or stop live playback through the Android audio stack. Mix playback now prefers `sbx_mix_input_create_stdio(...)`, using bundled native codec archives for OGG, MP3, and FLAC.

Bundled Android app assets now include:

- `river1.ogg`
- `river2.ogg`

That means desktop-style examples such as `-SE -m river1.ogg` can resolve inside the Android app without needing an external document picker first.

The parent [SBaGenX](https://github.com/lm7137/SBaGenX) repo now includes [android-build-libs.sh](/home/magiktime/projects/SBaGenX/android-build-libs.sh), which rebuilds the Android `libogg`, Tremor `libvorbisidec`, and `libmad` static archives with the Android NDK and drops them into `SBaGenX/libs/` for vendoring into this repo.

Codec vendoring is documented separately in [android-codecs.md](/home/magiktime/projects/SBaGenX-Android/docs/android-codecs.md). The rule is to build codec archives from a pinned parent `SBaGenX` revision, then vendor snapshot copies into this repo rather than depending on a live sibling checkout.

## Snapshot provenance

The vendored `sbagenxlib` sources and Android codec archives in this repo are
currently pinned to parent `SBaGenX` tag `v3.9.0-alpha.7` at commit
`b1e2ee998c76bb7882100ebf197d29db6d66a54f`.

See [SNAPSHOT.md](/home/magiktime/projects/SBaGenX-Android/native/sbagenxlib/SNAPSHOT.md),
[android-native-bridge.md](/home/magiktime/projects/SBaGenX-Android/docs/android-native-bridge.md),
and [android-codecs.md](/home/magiktime/projects/SBaGenX-Android/docs/android-codecs.md)
for details.
