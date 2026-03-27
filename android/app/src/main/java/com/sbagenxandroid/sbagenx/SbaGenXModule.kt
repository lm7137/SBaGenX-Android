package com.sbagenxandroid.sbagenx

import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod

class SbaGenXModule(reactContext: ReactApplicationContext) :
    ReactContextBaseJavaModule(reactContext) {

  override fun getName(): String = NAME

  @ReactMethod
  fun getBridgeInfo(promise: Promise) {
    resolveNativeCall(promise) {
      SbagenxBridge.nativeGetBridgeInfo()
    }
  }

  @ReactMethod
  fun validateSbg(text: String, sourceName: String?, promise: Promise) {
    resolveNativeCall(promise) {
      SbagenxBridge.nativeValidateSbg(text, sourceName ?: "scratch.sbg")
    }
  }

  @ReactMethod
  fun validateSbgf(text: String, sourceName: String?, promise: Promise) {
    resolveNativeCall(promise) {
      SbagenxBridge.nativeValidateSbgf(text, sourceName ?: "scratch.sbgf")
    }
  }

  private inline fun resolveNativeCall(promise: Promise, block: () -> String) {
    try {
      promise.resolve(block())
    } catch (error: Throwable) {
      promise.reject("SBX_NATIVE", error.message, error)
    }
  }

  companion object {
    const val NAME = "SbaGenXModule"
  }
}
