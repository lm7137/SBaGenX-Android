package com.sbagenxandroid.sbagenx

object SbagenxBridge {
  init {
    System.loadLibrary("sbagenxbridge")
  }

  external fun nativeGetBridgeInfo(): String

  external fun nativeValidateSbg(text: String, sourceName: String): String

  external fun nativeValidateSbgf(text: String, sourceName: String): String
}
