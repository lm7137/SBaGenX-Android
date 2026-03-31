package com.sbagenxandroid.sbagenx

import org.json.JSONObject

data class PreparedPlaybackRuntime(
    val stateJson: String,
    val mixInput: PreparedStreamingMixInput?,
    val useNativeMixBackend: Boolean,
)

data class ProgramRuntimeRequest(
    val programKind: String,
    val mainArg: String,
    val dropTimeSec: Int,
    val holdTimeSec: Int,
    val wakeTimeSec: Int,
    val curveText: String?,
    val sourceName: String,
    val mixPath: String?,
    val mixLooperSpec: String?,
)

class SbgRuntimeLoader(
    private val nativeMixInputResolver: NativeMixInputResolver,
    private val mixInputResolver: MixInputResolver,
    private val streamingMixInputResolver: StreamingMixInputResolver,
) {
  fun prepare(text: String, sourceName: String): String = prepare(text, sourceName, null, null)

  fun prepare(
      text: String,
      sourceName: String,
      mixPathOverride: String?,
      mixLooperSpec: String?,
  ): String {
    val inspect = JSONObject(SbagenxBridge.nativeInspectSbgRuntimeConfig(text, sourceName))
    if (inspect.optInt("status", -1) != 0) {
      return inspect.toString()
    }

    val effectiveSourceName = inspect.optString("sourceName", sourceName)
    val documentMixPath = inspect.optString("mixPath").takeIf { it.isNotBlank() }
    val mixPath =
        mixPathOverride?.takeIf { it.isNotBlank() }
            ?: documentMixPath
    val sampleRate = inspect.optInt("sampleRate", 44_100)

    if (mixPath != null) {
      val nativeResolved =
          try {
            nativeMixInputResolver.resolve(mixPath, sourceName)
          } catch (error: Throwable) {
            return buildContextErrorJson(
                sourceName = effectiveSourceName,
                sampleRate = sampleRate,
                mixPath = mixPath,
                errorMessage = error.message ?: "Failed to resolve mix input.",
            )
          }

      val nativeStateJson =
          SbagenxBridge.nativePrepareSbgContextStdio(
              text,
              sourceName,
              mixPath,
              nativeResolved.filePath,
              nativeResolved.pathHint,
              nativeResolved.sourceName,
              nativeResolved.mixSection,
              mixLooperSpec.orEmpty(),
              nativeResolved.deleteOnRelease,
          )
      val nativeState = JSONObject(nativeStateJson)
      if (isPrepared(nativeState) || !shouldFallbackToPlatformMix(nativeState)) {
        return nativeStateJson
      }
    }

    val fallbackText =
        if (mixPath != null && documentMixPath == null) {
          withFallbackSequenceMixPath(text, mixPath)
        } else {
          text
        }

    val mixInput =
        try {
          mixPath?.let { mixInputResolver.resolve(it, sourceName, sampleRate, mixLooperSpec) }
        } catch (error: Throwable) {
          return buildContextErrorJson(
              sourceName = effectiveSourceName,
              sampleRate = sampleRate,
              mixPath = mixPath.orEmpty(),
              errorMessage = error.message ?: "Failed to resolve mix input.",
          )
        }

    return SbagenxBridge.nativePrepareSbgContext(
        fallbackText,
        sourceName,
        mixInput?.samples,
        mixInput?.sourceName.orEmpty(),
        mixInput?.looping ?: false,
    )
  }

  fun prepareForPlayback(text: String, sourceName: String): PreparedPlaybackRuntime {
    return prepareForPlayback(text, sourceName, null, null)
  }

  fun prepareForPlayback(
      text: String,
      sourceName: String,
      mixPathOverride: String?,
      mixLooperSpec: String?,
  ): PreparedPlaybackRuntime {
    val inspect = JSONObject(SbagenxBridge.nativeInspectSbgRuntimeConfig(text, sourceName))
    if (inspect.optInt("status", -1) != 0) {
      return PreparedPlaybackRuntime(inspect.toString(), null, false)
    }

    val effectiveSourceName = inspect.optString("sourceName", sourceName)
    val documentMixPath = inspect.optString("mixPath").takeIf { it.isNotBlank() }
    val mixPath =
        mixPathOverride?.takeIf { it.isNotBlank() }
            ?: documentMixPath
    val sampleRate = inspect.optInt("sampleRate", 44_100)

    if (mixPath != null) {
      val nativeResolved =
          try {
            nativeMixInputResolver.resolve(mixPath, sourceName)
          } catch (error: Throwable) {
            return PreparedPlaybackRuntime(
                buildContextErrorJson(
                    sourceName = effectiveSourceName,
                    sampleRate = sampleRate,
                    mixPath = mixPath,
                    errorMessage = error.message ?: "Failed to resolve mix input.",
                ),
                null,
                false,
            )
          }

      val nativeStateJson =
          SbagenxBridge.nativePrepareSbgContextStdio(
              text,
              sourceName,
              mixPath,
              nativeResolved.filePath,
              nativeResolved.pathHint,
              nativeResolved.sourceName,
              nativeResolved.mixSection,
              mixLooperSpec.orEmpty(),
              nativeResolved.deleteOnRelease,
          )
      val nativeState = JSONObject(nativeStateJson)
      if (isPrepared(nativeState) || !shouldFallbackToPlatformMix(nativeState)) {
        return PreparedPlaybackRuntime(
            nativeStateJson,
            null,
            nativeState.optString("mixBackend") == MIX_BACKEND_NATIVE,
        )
      }
    }

    val fallbackText =
        if (mixPath != null && documentMixPath == null) {
          withFallbackSequenceMixPath(text, mixPath)
        } else {
          text
        }

    val mixInput =
        try {
          mixPath?.let {
            streamingMixInputResolver.open(it, sourceName, sampleRate, mixLooperSpec)
          }
        } catch (error: Throwable) {
          return PreparedPlaybackRuntime(
              buildContextErrorJson(
                  sourceName = effectiveSourceName,
                  sampleRate = sampleRate,
                  mixPath = mixPath.orEmpty(),
                  errorMessage = error.message ?: "Failed to resolve mix input.",
              ),
              null,
              false,
          )
        }

    val stateJson =
        try {
          SbagenxBridge.nativePrepareSbgContextStreaming(
              fallbackText,
              sourceName,
              mixInput?.sourceName.orEmpty(),
              mixInput?.looping ?: false,
          )
        } catch (error: Throwable) {
          mixInput?.decoder?.close()
          throw error
        }

    val state = JSONObject(stateJson)
    if (!isPrepared(state)) {
      mixInput?.decoder?.close()
      return PreparedPlaybackRuntime(stateJson, null, false)
    }

    return PreparedPlaybackRuntime(stateJson, mixInput, false)
  }

  fun prepareProgram(request: ProgramRuntimeRequest): String {
    val sampleRate = 44_100
    val mixPath = request.mixPath?.takeIf { it.isNotBlank() }

    if (mixPath != null) {
      val nativeResolved =
          try {
            nativeMixInputResolver.resolve(mixPath, request.sourceName)
          } catch (error: Throwable) {
            return buildContextErrorJson(
                sourceName = request.sourceName,
                sampleRate = sampleRate,
                mixPath = mixPath,
                errorMessage = error.message ?: "Failed to resolve mix input.",
            )
          }

      val nativeStateJson =
          SbagenxBridge.nativePrepareProgramContextStdio(
              request.programKind,
              request.mainArg,
              request.dropTimeSec,
              request.holdTimeSec,
              request.wakeTimeSec,
              request.curveText,
              request.sourceName,
              mixPath,
              nativeResolved.filePath,
              nativeResolved.pathHint,
              nativeResolved.sourceName,
              nativeResolved.mixSection,
              request.mixLooperSpec.orEmpty(),
              nativeResolved.deleteOnRelease,
          )
      val nativeState = JSONObject(nativeStateJson)
      if (isPrepared(nativeState) || !shouldFallbackToPlatformMix(nativeState)) {
        return nativeStateJson
      }
    }

    val mixInput =
        try {
          mixPath?.let {
            mixInputResolver.resolve(
                it,
                request.sourceName,
                sampleRate,
                request.mixLooperSpec,
            )
          }
        } catch (error: Throwable) {
          return buildContextErrorJson(
              sourceName = request.sourceName,
              sampleRate = sampleRate,
              mixPath = mixPath.orEmpty(),
              errorMessage = error.message ?: "Failed to resolve mix input.",
          )
        }

    return SbagenxBridge.nativePrepareProgramContext(
        request.programKind,
        request.mainArg,
        request.dropTimeSec,
        request.holdTimeSec,
        request.wakeTimeSec,
        request.curveText,
        request.sourceName,
        mixPath.orEmpty(),
        mixInput?.samples,
        mixInput?.sourceName.orEmpty(),
        mixInput?.looping ?: false,
    )
  }

  fun prepareProgramForPlayback(request: ProgramRuntimeRequest): PreparedPlaybackRuntime {
    val sampleRate = 44_100
    val mixPath = request.mixPath?.takeIf { it.isNotBlank() }

    if (mixPath != null) {
      val nativeResolved =
          try {
            nativeMixInputResolver.resolve(mixPath, request.sourceName)
          } catch (error: Throwable) {
            return PreparedPlaybackRuntime(
                buildContextErrorJson(
                    sourceName = request.sourceName,
                    sampleRate = sampleRate,
                    mixPath = mixPath,
                    errorMessage = error.message ?: "Failed to resolve mix input.",
                ),
                null,
                false,
            )
          }

      val nativeStateJson =
          SbagenxBridge.nativePrepareProgramContextStdio(
              request.programKind,
              request.mainArg,
              request.dropTimeSec,
              request.holdTimeSec,
              request.wakeTimeSec,
              request.curveText,
              request.sourceName,
              mixPath,
              nativeResolved.filePath,
              nativeResolved.pathHint,
              nativeResolved.sourceName,
              nativeResolved.mixSection,
              request.mixLooperSpec.orEmpty(),
              nativeResolved.deleteOnRelease,
          )
      val nativeState = JSONObject(nativeStateJson)
      if (isPrepared(nativeState) || !shouldFallbackToPlatformMix(nativeState)) {
        return PreparedPlaybackRuntime(
            nativeStateJson,
            null,
            nativeState.optString("mixBackend") == MIX_BACKEND_NATIVE,
        )
      }
    }

    val mixInput =
        try {
          mixPath?.let {
            streamingMixInputResolver.open(
                it,
                request.sourceName,
                sampleRate,
                request.mixLooperSpec,
            )
          }
        } catch (error: Throwable) {
          return PreparedPlaybackRuntime(
              buildContextErrorJson(
                  sourceName = request.sourceName,
                  sampleRate = sampleRate,
                  mixPath = mixPath.orEmpty(),
                  errorMessage = error.message ?: "Failed to resolve mix input.",
              ),
              null,
              false,
          )
        }

    val stateJson =
        try {
          SbagenxBridge.nativePrepareProgramContextStreaming(
              request.programKind,
              request.mainArg,
              request.dropTimeSec,
              request.holdTimeSec,
              request.wakeTimeSec,
              request.curveText,
              request.sourceName,
              mixPath.orEmpty(),
              mixInput?.sourceName.orEmpty(),
              mixInput?.looping ?: false,
          )
        } catch (error: Throwable) {
          mixInput?.decoder?.close()
          throw error
        }

    val state = JSONObject(stateJson)
    if (!isPrepared(state)) {
      mixInput?.decoder?.close()
      return PreparedPlaybackRuntime(stateJson, null, false)
    }

    return PreparedPlaybackRuntime(stateJson, mixInput, false)
  }

  private fun isPrepared(state: JSONObject): Boolean {
    return state.optInt("status", -1) == 0 && state.optBoolean("prepared", false)
  }

  private fun shouldFallbackToPlatformMix(state: JSONObject): Boolean {
    val error = state.optString("error")
    if (error.isBlank()) {
      return false
    }

    return error.contains("was not compiled into this sbagenxlib build", ignoreCase = true) ||
        error.contains("Unsupported or unavailable mix input format", ignoreCase = true)
  }

  private fun buildContextErrorJson(
      sourceName: String,
      sampleRate: Int,
      mixPath: String,
      errorMessage: String,
  ): String {
    return JSONObject()
        .put("status", 1)
        .put("statusText", "invalid argument")
        .put("prepared", false)
        .put("sampleRate", sampleRate)
        .put("channels", 2)
        .put("timeSec", 0.0)
        .put("durationSec", 0.0)
        .put("sourceName", sourceName)
        .put("mixActive", false)
        .put("mixLooping", false)
        .put("mixBackend", "")
        .put("mixPath", mixPath)
        .put("mixSourceName", "")
        .put("error", errorMessage)
        .toString()
  }

  private fun withFallbackSequenceMixPath(text: String, mixPath: String): String {
    val lines = text.split('\n').toMutableList()
    if (lines.isNotEmpty() && lines[0].trimStart().startsWith("-SE")) {
      lines[0] = "${lines[0].trimEnd()} -m $mixPath"
      return lines.joinToString("\n")
    }

    return buildString(text.length + mixPath.length + 16) {
      append("-SE -m ")
      append(mixPath)
      append('\n')
      append(text)
    }
  }

  companion object {
    private const val MIX_BACKEND_NATIVE = "native"
  }
}
