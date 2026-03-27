# SBaGenX Android

Separate Android frontend for `sbagenxlib`, built with React Native and a Kotlin/JNI native bridge.

## Current milestone

The repo is scaffolded as a plain React Native app and already includes:

- a vendored `sbagenxlib` snapshot in `native/sbagenxlib/`
- an Android NDK/CMake build that compiles `libsbagenxbridge.so`
- a Kotlin React Native module that calls into JNI
- a first validation workbench screen for `.sbg` and `.sbgf` text
- real `sbx_version()`, `sbx_api_version()`, `sbx_validate_sbg_text()`, and `sbx_validate_sbgf_text()` calls

What is not implemented yet:

- live audio playback
- document open/save flow
- `.sbgf` curve inspection
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

The initial UI is intentionally narrow: prove that Android can call the real `sbagenxlib` validation APIs and receive structured diagnostics with source spans.

## Snapshot provenance

The vendored `sbagenxlib` snapshot comes from the local `SBaGenX` repo on branch `gui-v3.0` at commit `5088272e38b11a762ec6e411a833f948db6f741e`.

See `native/sbagenxlib/SNAPSHOT.md` and `docs/android-native-bridge.md` for details.
