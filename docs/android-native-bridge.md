# Android Native Bridge

## Goal

Keep Android as a thin frontend over `sbagenxlib`.

The current bridge proves the minimum useful path:

- React Native UI
- Kotlin native module
- JNI
- vendored `sbagenxlib`
- structured validation diagnostics returned to JS

The current vendored snapshot is taken from the `SBaGenX` repo's `gui-v3.0` branch at commit `5088272e38b11a762ec6e411a833f948db6f741e`.

## Current native surface

- `getBridgeInfo()`
- `validateSbg(text, sourceName)`
- `validateSbgf(text, sourceName)`

The Kotlin module returns JSON strings from JNI and the JS wrapper parses them into typed objects. That keeps the first bridge simple while preserving the diagnostic structure from `sbagenxlib`.

## Build path

- Gradle config lives in `android/app/build.gradle`
- CMake entry point lives in `native/jni/CMakeLists.txt`
- JNI implementation lives in `native/jni/sbagenx_bridge.cpp`
- Vendored engine sources live in `native/sbagenxlib/`

The Android app currently builds native code for:

- `arm64-v8a`
- `x86_64`

## Why validation first

Validation is the right first milestone because it proves:

- the NDK toolchain can build the real engine
- JNI can call `sbagenxlib`
- diagnostics survive the bridge with line and column spans
- the React Native app can consume native editor feedback without duplicating parser logic

## Next native steps

1. Add a persistent runtime context wrapper around `SbxContext`.
2. Expose `startPlayback(text, sourceName)` and `stopPlayback()`.
3. Add an Android audio backend that pulls PCM from `sbagenxlib`.
4. Add optional `.sbgf` beat-preview and curve-inspection calls.
