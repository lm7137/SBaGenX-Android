package com.sbagenxandroid.sbagenx

import android.app.Activity
import android.content.Intent
import android.net.Uri
import android.provider.OpenableColumns
import com.facebook.react.bridge.BaseActivityEventListener
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import org.json.JSONObject

class SbaGenXModule(reactContext: ReactApplicationContext) :
    ReactContextBaseJavaModule(reactContext) {

  private val runtimeLoader = SbgRuntimeLoader(MixInputResolver(reactContext))
  private val playbackController = PlaybackController(runtimeLoader)
  private val localDocumentStore = LocalDocumentStore(reactContext)
  private var pendingMixPickerPromise: Promise? = null

  private val mixPickerListener =
      object : BaseActivityEventListener() {
        override fun onActivityResult(
            activity: Activity,
            requestCode: Int,
            resultCode: Int,
            data: Intent?,
        ) {
          if (requestCode != REQUEST_PICK_MIX) {
            return
          }

          val promise = pendingMixPickerPromise ?: return
          pendingMixPickerPromise = null

          if (resultCode != Activity.RESULT_OK) {
            promise.resolve(buildPickedMixJson("", ""))
            return
          }

          val uri = data?.data
          if (uri == null) {
            promise.resolve(buildPickedMixJson("", ""))
            return
          }

          takePersistableReadPermission(uri, data)
          promise.resolve(
              buildPickedMixJson(
                  uri = uri.toString(),
                  displayName = queryDisplayName(uri).orEmpty(),
              ),
          )
        }
      }

  init {
    reactContext.addActivityEventListener(mixPickerListener)
  }

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

  @ReactMethod
  fun pickMixInput(promise: Promise) {
    if (pendingMixPickerPromise != null) {
      promise.reject("SBX_PICK_BUSY", "A mix picker request is already in progress.")
      return
    }

    val activity = reactApplicationContext.currentActivity
    if (activity == null) {
      promise.reject("SBX_PICK_NO_ACTIVITY", "No active Android activity is available.")
      return
    }

    val intent =
        Intent(Intent.ACTION_OPEN_DOCUMENT)
            .addCategory(Intent.CATEGORY_OPENABLE)
            .setType("audio/*")
            .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
            .addFlags(Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION)

    pendingMixPickerPromise = promise

    try {
      if (!reactApplicationContext.startActivityForResult(intent, REQUEST_PICK_MIX, null)) {
        pendingMixPickerPromise = null
        promise.reject("SBX_PICK_LAUNCH", "Unable to launch the Android file picker.")
      }
    } catch (error: Throwable) {
      pendingMixPickerPromise = null
      promise.reject("SBX_PICK_LAUNCH", error.message, error)
    }
  }

  override fun invalidate() {
    pendingMixPickerPromise?.resolve(buildPickedMixJson("", ""))
    pendingMixPickerPromise = null
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

  private fun takePersistableReadPermission(uri: Uri, data: Intent?) {
    val grantedFlags =
        (data?.flags ?: 0) and
            (Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION)
    val readFlag = grantedFlags and Intent.FLAG_GRANT_READ_URI_PERMISSION
    if (readFlag == 0) {
      return
    }

    try {
      reactApplicationContext.contentResolver.takePersistableUriPermission(uri, readFlag)
    } catch (_: Throwable) {
    }
  }

  private fun queryDisplayName(uri: Uri): String? {
    if (uri.scheme == "content") {
      reactApplicationContext.contentResolver
          .query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)
          ?.use { cursor ->
            if (cursor.moveToFirst()) {
              val columnIndex = cursor.getColumnIndex(OpenableColumns.DISPLAY_NAME)
              if (columnIndex >= 0) {
                return cursor.getString(columnIndex)
              }
            }
          }
    }

    return uri.lastPathSegment?.substringAfterLast('/')
  }

  private fun buildPickedMixJson(uri: String, displayName: String): String {
    return JSONObject()
        .put("uri", uri)
        .put("displayName", displayName)
        .toString()
  }

  companion object {
    const val NAME = "SbaGenXModule"
    const val REQUEST_PICK_MIX = 40271
  }
}
