package com.sbagenxandroid.sbagenx

import org.json.JSONObject

class SbgRuntimeLoader(private val mixInputResolver: MixInputResolver) {
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
