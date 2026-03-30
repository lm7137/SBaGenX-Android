package com.sbagenxandroid.sbagenx

object SbagenxBridge {
  init {
    System.loadLibrary("sbagenxbridge")
  }

  external fun nativeGetBridgeInfo(): String

  external fun nativeValidateSbg(text: String, sourceName: String): String

  external fun nativeValidateSbgf(text: String, sourceName: String): String

  external fun nativeInspectSbgRuntimeConfig(text: String, sourceName: String): String

  external fun nativePrepareSbgContext(
      text: String,
      sourceName: String,
      mixSamples: ShortArray?,
      mixSourceName: String,
      mixLooping: Boolean,
  ): String

  external fun nativePrepareSbgContextStreaming(
      text: String,
      sourceName: String,
      mixSourceName: String,
      mixLooping: Boolean,
  ): String

  external fun nativePrepareProgramContext(
      programKind: String,
      mainArg: String,
      dropTimeSec: Int,
      holdTimeSec: Int,
      wakeTimeSec: Int,
      curveText: String?,
      sourceName: String,
      mixPath: String,
      mixSamples: ShortArray?,
      mixSourceName: String,
      mixLooping: Boolean,
  ): String

  external fun nativePrepareProgramContextStreaming(
      programKind: String,
      mainArg: String,
      dropTimeSec: Int,
      holdTimeSec: Int,
      wakeTimeSec: Int,
      curveText: String?,
      sourceName: String,
      mixPath: String,
      mixSourceName: String,
      mixLooping: Boolean,
  ): String

  external fun nativeGetContextState(): String

  external fun nativeRenderPreview(frameCount: Int, sampleValueCount: Int): String

  external fun nativeRenderIntoBuffer(buffer: FloatArray, frameCount: Int): Int

  external fun nativeRenderIntoBufferWithMix(
      buffer: FloatArray,
      frameCount: Int,
      mixSamples: ShortArray?,
      mixFrameCount: Int,
  ): Int

  external fun nativeResetContext(): String

  external fun nativeReleaseContext(): String
}
