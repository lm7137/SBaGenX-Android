# SBaGenX Android

Separate Android frontend for `sbagenxlib`, built with React Native and a Kotlin/JNI native bridge.

## Current milestone

The repo is scaffolded as a plain React Native app and already includes:

- a vendored `sbagenxlib` snapshot in `native/sbagenxlib/`
- an Android NDK/CMake build that compiles `libsbagenxbridge.so`
- a Kotlin React Native module that calls into JNI
- a first editor workbench screen for `.sbg` and `.sbgf` text
- real `sbx_version()`, `sbx_api_version()`, `sbx_validate_sbg_text()`, and `sbx_validate_sbgf_text()` calls
- `.sbgf` curve metadata inspection during validation, including solve-backed parameter values after native prepare
- a persistent native `SbxContext` for `.sbg` documents
- preview rendering of PCM float samples from JNI without audio output
- live Android playback for `.sbg` via `AudioTrack`
- safe `-SE` preamble handling during `.sbg` prepare/playback
- runtime mix support for `.sbg` `-m` inputs resolved from bundled app assets, file paths, or `content://` URIs
- app-local draft save/load inside Android app storage

What is not implemented yet:

- system document picker / external file open-save flow
- `.sbgf` beat preview and runtime playback
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
- `prepareSbgContext(text, sourceName)`
- `getContextState()`
- `renderPreview(frameCount, sampleValueCount)`
- `resetContext()`
- `startPlayback(text, sourceName)`
- `stopPlayback()`
- `getPlaybackState()`
- `listDocuments()`
- `saveDocument(name, text)`
- `loadDocument(name)`

The current editor workbench can validate both `.sbg` and `.sbgf`, inspect prepared `.sbgf` curve parameters from `sbagenxlib`, save drafts locally, prepare a persistent native render context for `.sbg`, preview rendered PCM samples, and start or stop live playback through the Android audio stack.

Bundled Android app assets now include:

- `river1.ogg`
- `river2.ogg`

That means desktop-style examples such as `-SE -m river1.ogg` can resolve inside the Android app without needing an external document picker first.

## Snapshot provenance

The vendored `sbagenxlib` snapshot comes from the local `SBaGenX` repo on branch `gui-v3.0` at commit `5088272e38b11a762ec6e411a833f948db6f741e`.

See `native/sbagenxlib/SNAPSHOT.md` and `docs/android-native-bridge.md` for details.
