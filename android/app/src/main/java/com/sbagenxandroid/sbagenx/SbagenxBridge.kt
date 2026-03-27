package com.sbagenxandroid.sbagenx

object SbagenxBridge {
  init {
    System.loadLibrary("sbagenxbridge")
  }

  external fun nativeGetBridgeInfo(): String

  external fun nativeValidateSbg(text: String, sourceName: String): String

  external fun nativeValidateSbgf(text: String, sourceName: String): String

  external fun nativePrepareSbgContext(text: String, sourceName: String): String

  external fun nativeGetContextState(): String

  external fun nativeRenderPreview(frameCount: Int, sampleValueCount: Int): String

  external fun nativeRenderIntoBuffer(buffer: FloatArray, frameCount: Int): Int

  external fun nativeResetContext(): String

  external fun nativeReleaseContext(): String
}
