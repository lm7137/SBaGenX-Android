# Android Native Bridge

## Goal

Keep Android as a thin frontend over `sbagenxlib`.

The current bridge proves the minimum useful path:

- React Native UI
- Kotlin native module
- JNI
- vendored `sbagenxlib`
- structured validation diagnostics returned to JS
- `.sbgf` curve-info metadata returned to JS after native prepare
- a persistent native `SbxContext` for `.sbg`
- preview PCM rendering from JNI
- live Android playback via `AudioTrack`
- safe `-SE` preamble parsing before `.sbg` runtime prepare
- Android-side mix-source resolution and decode for `.sbg` `-m` inputs
- app-local draft persistence through the React Native module

The current vendored snapshot matches the local `SBaGenX` repo's current `sbagenxlib` files. For upstream reference, prefer the `main` branch there.

## Current native surface

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

The Kotlin module returns JSON strings from JNI and the JS wrapper parses them into typed objects. That keeps the bridge simple while preserving the native diagnostic and runtime state structure from `sbagenxlib`.

## Runtime model

The JNI layer now owns a process-local runtime wrapper around `SbxContext`.

- `.sbg` text can be loaded into a persistent native context
- safe sequence preambles are parsed before the timing loader runs
- preview calls render PCM float blocks without committing to audio output
- decoded mix PCM is stored natively and applied through `sbx_context_mix_stream_sample()`
- playback reuses the same context model and pulls PCM into an Android `AudioTrack`
- the JS layer polls context and playback state rather than duplicating render logic

At the moment, `.sbgf` support includes validation plus curve-info inspection. Playback and preview are still intentionally limited to `.sbg` until the runtime surface for curves and beat generation is defined.

Current mix-input rules:

- bundled app assets like `river1.ogg` and `river2.ogg` resolve directly from `.sbg` `-m` lines
- absolute file paths and `file://` paths are supported
- `content://` URIs are supported when Android has permission to read them
- relative file paths are only resolved when the `.sbg` source name is itself a file path
- mix section suffixes like `#1` are not supported yet by the Android runtime

## Build path

- Gradle config lives in `android/app/build.gradle`
- CMake entry point lives in `native/jni/CMakeLists.txt`
- JNI implementation lives in `native/jni/sbagenx_bridge.cpp`
- Vendored engine sources live in `native/sbagenxlib/`

The Android app currently builds native code for:

- `arm64-v8a`
- `x86_64`

## Why validation first

Validation was the right first milestone because it proved:

- the NDK toolchain can build the real engine
- JNI can call `sbagenxlib`
- diagnostics survive the bridge with line and column spans
- the React Native app can consume native editor feedback without duplicating parser logic

The repo has now moved one step further by proving persistent context lifetime, native PCM rendering, and live playback.

## Next native steps

1. Replace app-local draft storage with Android Storage Access Framework document open/save.
2. Add waveform or transport-oriented playback UI around the current `AudioTrack` backend.
3. Add optional `.sbgf` beat-preview and runtime playback calls.
4. Evaluate whether the playback backend should remain `AudioTrack` or move to AAudio/Oboe for lower-latency control.
