package com.sbagenxandroid.sbagenx

import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod

class SbaGenXModule(reactContext: ReactApplicationContext) :
    ReactContextBaseJavaModule(reactContext) {

  private val runtimeLoader = SbgRuntimeLoader(MixInputResolver(reactContext))
  private val playbackController = PlaybackController(runtimeLoader)
  private val localDocumentStore = LocalDocumentStore(reactContext)

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

  @ReactMethod
  fun prepareSbgContext(text: String, sourceName: String?, promise: Promise) {
    resolveNativeCall(promise) {
      runtimeLoader.prepare(text, sourceName ?: "scratch.sbg")
    }
  }

  @ReactMethod
  fun getContextState(promise: Promise) {
    resolveNativeCall(promise) {
      SbagenxBridge.nativeGetContextState()
    }
  }

  @ReactMethod
  fun renderPreview(frameCount: Int, sampleValueCount: Int, promise: Promise) {
    resolveNativeCall(promise) {
      SbagenxBridge.nativeRenderPreview(frameCount, sampleValueCount)
    }
  }

  @ReactMethod
  fun resetContext(promise: Promise) {
    resolveNativeCall(promise) {
      SbagenxBridge.nativeResetContext()
    }
  }

  @ReactMethod
  fun startPlayback(text: String, sourceName: String?, promise: Promise) {
    resolveNativeCall(promise) {
      playbackController.start(text, sourceName ?: "scratch.sbg")
    }
  }

  @ReactMethod
  fun stopPlayback(promise: Promise) {
    resolveNativeCall(promise) {
      playbackController.stop()
    }
  }

  @ReactMethod
  fun getPlaybackState(promise: Promise) {
    resolveNativeCall(promise) {
      playbackController.getStateJson()
    }
  }

  @ReactMethod
  fun listDocuments(promise: Promise) {
    resolveNativeCall(promise) {
      localDocumentStore.listDocuments()
    }
  }

  @ReactMethod
  fun saveDocument(name: String, text: String, promise: Promise) {
    resolveNativeCall(promise) {
      localDocumentStore.saveDocument(name, text)
    }
  }

  @ReactMethod
  fun loadDocument(name: String, promise: Promise) {
    resolveNativeCall(promise) {
      localDocumentStore.loadDocument(name)
    }
  }

  override fun invalidate() {
    playbackController.stop()
    SbagenxBridge.nativeReleaseContext()
    super.invalidate()
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
