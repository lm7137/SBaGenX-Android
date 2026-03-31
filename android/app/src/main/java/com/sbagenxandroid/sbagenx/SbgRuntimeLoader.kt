package com.sbagenxandroid.sbagenx

import org.json.JSONObject

data class PreparedPlaybackRuntime(
    val stateJson: String,
    val mixInput: PreparedStreamingMixInput?,
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
    private val mixInputResolver: MixInputResolver,
    private val streamingMixInputResolver: StreamingMixInputResolver,
) {
  fun prepare(text: String, sourceName: String): String {
    val inspect = JSONObject(SbagenxBridge.nativeInspectSbgRuntimeConfig(text, sourceName))
    if (inspect.optInt("status", -1) != 0) {
      return inspect.toString()
    }

    val mixPath = inspect.optString("mixPath").takeIf { it.isNotBlank() }
    val sampleRate = inspect.optInt("sampleRate", 44_100)

    val mixInput =
        try {
          mixPath?.let { mixInputResolver.resolve(it, sourceName, sampleRate) }
        } catch (error: Throwable) {
          return buildContextErrorJson(
              sourceName = inspect.optString("sourceName", sourceName),
              sampleRate = sampleRate,
              mixPath = mixPath.orEmpty(),
              errorMessage = error.message ?: "Failed to resolve mix input.",
          )
        }

    return SbagenxBridge.nativePrepareSbgContext(
        text,
        sourceName,
        mixInput?.samples,
        mixInput?.sourceName.orEmpty(),
        mixInput?.looping ?: false,
    )
  }

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

    val mixPath =
        mixPathOverride?.takeIf { it.isNotBlank() }
            ?: inspect.optString("mixPath").takeIf { it.isNotBlank() }
    val sampleRate = inspect.optInt("sampleRate", 44_100)

    val mixInput =
        try {
          mixPath?.let { mixInputResolver.resolve(it, sourceName, sampleRate, mixLooperSpec) }
        } catch (error: Throwable) {
          return buildContextErrorJson(
              sourceName = inspect.optString("sourceName", sourceName),
              sampleRate = sampleRate,
              mixPath = mixPath.orEmpty(),
              errorMessage = error.message ?: "Failed to resolve mix input.",
          )
        }

    return SbagenxBridge.nativePrepareSbgContext(
        text,
        sourceName,
        mixInput?.samples,
        mixInput?.sourceName.orEmpty(),
        mixInput?.looping ?: false,
    )
  }

  fun prepareForPlayback(text: String, sourceName: String): PreparedPlaybackRuntime {
    val inspect = JSONObject(SbagenxBridge.nativeInspectSbgRuntimeConfig(text, sourceName))
    if (inspect.optInt("status", -1) != 0) {
      return PreparedPlaybackRuntime(inspect.toString(), null)
    }

    val mixPath = inspect.optString("mixPath").takeIf { it.isNotBlank() }
    val sampleRate = inspect.optInt("sampleRate", 44_100)

    val mixInput =
        try {
          mixPath?.let { streamingMixInputResolver.open(it, sourceName, sampleRate) }
        } catch (error: Throwable) {
          return PreparedPlaybackRuntime(
              buildContextErrorJson(
                  sourceName = inspect.optString("sourceName", sourceName),
                  sampleRate = sampleRate,
                  mixPath = mixPath.orEmpty(),
                  errorMessage = error.message ?: "Failed to resolve mix input.",
              ),
              null,
          )
        }

    val stateJson =
        try {
          SbagenxBridge.nativePrepareSbgContextStreaming(
              text,
              sourceName,
              mixInput?.sourceName.orEmpty(),
              mixInput?.looping ?: false,
          )
        } catch (error: Throwable) {
          mixInput?.decoder?.close()
          throw error
        }

    val state = JSONObject(stateJson)
    if (state.optInt("status", -1) != 0 || !state.optBoolean("prepared", false)) {
      mixInput?.decoder?.close()
      return PreparedPlaybackRuntime(stateJson, null)
    }

    return PreparedPlaybackRuntime(stateJson, mixInput)
  }

  fun prepareForPlayback(
      text: String,
      sourceName: String,
      mixPathOverride: String?,
      mixLooperSpec: String?,
  ): PreparedPlaybackRuntime {
    val inspect = JSONObject(SbagenxBridge.nativeInspectSbgRuntimeConfig(text, sourceName))
    if (inspect.optInt("status", -1) != 0) {
      return PreparedPlaybackRuntime(inspect.toString(), null)
    }

    val mixPath =
        mixPathOverride?.takeIf { it.isNotBlank() }
            ?: inspect.optString("mixPath").takeIf { it.isNotBlank() }
    val sampleRate = inspect.optInt("sampleRate", 44_100)

    val mixInput =
        try {
          mixPath?.let {
            streamingMixInputResolver.open(it, sourceName, sampleRate, mixLooperSpec)
          }
        } catch (error: Throwable) {
          return PreparedPlaybackRuntime(
              buildContextErrorJson(
                  sourceName = inspect.optString("sourceName", sourceName),
                  sampleRate = sampleRate,
                  mixPath = mixPath.orEmpty(),
                  errorMessage = error.message ?: "Failed to resolve mix input.",
              ),
              null,
          )
        }

    val stateJson =
        try {
          SbagenxBridge.nativePrepareSbgContextStreaming(
              text,
              sourceName,
              mixInput?.sourceName.orEmpty(),
              mixInput?.looping ?: false,
          )
        } catch (error: Throwable) {
          mixInput?.decoder?.close()
          throw error
        }

    val state = JSONObject(stateJson)
    if (state.optInt("status", -1) != 0 || !state.optBoolean("prepared", false)) {
      mixInput?.decoder?.close()
      return PreparedPlaybackRuntime(stateJson, null)
    }

    return PreparedPlaybackRuntime(stateJson, mixInput)
  }

  fun prepareProgram(request: ProgramRuntimeRequest): String {
    val sampleRate = 44_100
    val mixPath = request.mixPath?.takeIf { it.isNotBlank() }

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
    if (state.optInt("status", -1) != 0 || !state.optBoolean("prepared", false)) {
      mixInput?.decoder?.close()
      return PreparedPlaybackRuntime(stateJson, null)
    }

    return PreparedPlaybackRuntime(stateJson, mixInput)
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
        .put("mixPath", mixPath)
        .put("mixSourceName", "")
        .put("error", errorMessage)
        .toString()
  }
}
