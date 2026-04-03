package com.sbagenxandroid.sbagenx

import android.app.Activity
import android.content.Intent
import android.net.Uri
import android.provider.DocumentsContract
import android.provider.OpenableColumns
import com.facebook.react.bridge.BaseActivityEventListener
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.UiThreadUtil
import org.json.JSONObject

class SbaGenXModule(reactContext: ReactApplicationContext) :
    ReactContextBaseJavaModule(reactContext) {

  private val localDocumentStore = LocalDocumentStore(reactContext)
  private val nativeMixInputResolver = NativeMixInputResolver(reactContext, localDocumentStore)
  private val decodedMixInputResolver = MixInputResolver(reactContext, localDocumentStore)
  private val streamingMixInputResolver =
      StreamingMixInputResolver(reactContext, localDocumentStore)
  private val runtimeLoader =
      SbgRuntimeLoader(
          nativeMixInputResolver,
          decodedMixInputResolver,
          streamingMixInputResolver,
      )
  private val playbackController = PlaybackController(runtimeLoader)
  private var pendingMixPickerPromise: Promise? = null
  private var pendingLibraryFolderPromise: Promise? = null
  private var pendingDocumentPickerPromise: Promise? = null

  private val mixPickerListener =
      object : BaseActivityEventListener() {
        override fun onActivityResult(
            activity: Activity,
            requestCode: Int,
            resultCode: Int,
            data: Intent?,
        ) {
          when (requestCode) {
            REQUEST_PICK_MIX -> {
              val promise = pendingMixPickerPromise ?: return
              pendingMixPickerPromise = null

              if (resultCode != Activity.RESULT_OK) {
                promise.resolve(null)
                return
              }

              val uri = data?.data
              if (uri == null) {
                promise.resolve(null)
                return
              }

              takePersistableUriPermission(uri, data)
              val uriText = uri.toString()
              val displayName = queryDisplayName(uri).orEmpty()
              Thread(
                      {
                        val embeddedLooperSpec =
                            try {
                              streamingMixInputResolver.inspectEmbeddedLooper(uriText, "")
                            } catch (_: Throwable) {
                              null
                            }

                        promise.resolve(
                            buildPickedMixJson(
                                uri = uriText,
                                displayName = displayName,
                                embeddedLooperSpec = embeddedLooperSpec,
                            ),
                        )
                      },
                      "sbagenx-pick-mix-inspect",
                  )
                  .start()
            }
            REQUEST_PICK_LIBRARY -> {
              val promise = pendingLibraryFolderPromise ?: return
              pendingLibraryFolderPromise = null

              if (resultCode != Activity.RESULT_OK) {
                promise.resolve(localDocumentStore.getStoreInfo())
                return
              }

              val uri = data?.data
              if (uri == null) {
                promise.resolve(localDocumentStore.getStoreInfo())
                return
              }

              takePersistableUriPermission(uri, data)
              promise.resolve(localDocumentStore.setLibraryFolder(uri))
            }
            REQUEST_PICK_DOCUMENT -> {
              val promise = pendingDocumentPickerPromise ?: return
              pendingDocumentPickerPromise = null

              if (resultCode != Activity.RESULT_OK) {
                promise.resolve(null)
                return
              }

              val uri = data?.data
              if (uri == null) {
                promise.resolve(null)
                return
              }

              takePersistableUriPermission(uri, data)
              promise.resolve(localDocumentStore.loadPickedDocument(uri))
            }
          }
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
  fun validateCurveProgram(
      text: String,
      mainArg: String,
      sourceName: String?,
      promise: Promise,
  ) {
    resolveNativeCall(promise) {
      SbagenxBridge.nativeValidateCurveProgram(
          text,
          mainArg,
          sourceName ?: "scratch.sbgf",
      )
    }
  }

  @ReactMethod
  fun sampleBeatPreview(text: String, sourceName: String?, promise: Promise) {
    resolveNativeCall(promise) {
      SbagenxBridge.nativeSampleBeatPreview(text, sourceName ?: "scratch.sbg")
    }
  }

  @ReactMethod
  fun sampleProgramBeatPreview(
      programKind: String,
      mainArg: String,
      dropTimeSec: Int,
      holdTimeSec: Int,
      wakeTimeSec: Int,
      curveText: String?,
      sourceName: String?,
      mixPath: String?,
      promise: Promise,
  ) {
    resolveNativeCall(promise) {
      SbagenxBridge.nativeSampleProgramBeatPreview(
          programKind,
          mainArg,
          dropTimeSec,
          holdTimeSec,
          wakeTimeSec,
          curveText,
          sourceName ?: "program:$programKind",
          mixPath.orEmpty(),
      )
    }
  }

  @ReactMethod
  fun prepareSbgContext(
      text: String,
      sourceName: String?,
      mixPathOverride: String?,
      mixLooperSpec: String?,
      promise: Promise,
  ) {
    resolveNativeCall(promise) {
      runtimeLoader.prepare(
          text,
          sourceName ?: "scratch.sbg",
          mixPathOverride,
          mixLooperSpec,
      )
    }
  }

  @ReactMethod
  fun prepareProgramContext(
      programKind: String,
      mainArg: String,
      dropTimeSec: Int,
      holdTimeSec: Int,
      wakeTimeSec: Int,
      curveText: String?,
      sourceName: String?,
      mixPath: String?,
      mixLooperSpec: String?,
      promise: Promise,
  ) {
    resolveNativeCall(promise) {
      runtimeLoader.prepareProgram(
          ProgramRuntimeRequest(
              programKind = programKind,
              mainArg = mainArg,
              dropTimeSec = dropTimeSec,
              holdTimeSec = holdTimeSec,
              wakeTimeSec = wakeTimeSec,
              curveText = curveText,
              sourceName = sourceName ?: "program:$programKind",
              mixPath = mixPath,
              mixLooperSpec = mixLooperSpec,
          ),
      )
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
  fun startPlayback(
      text: String,
      sourceName: String?,
      mixPathOverride: String?,
      mixLooperSpec: String?,
      promise: Promise,
  ) {
    Thread(
            {
              resolveNativeCall(promise) {
                playbackController.startSequence(
                    text,
                    sourceName ?: "scratch.sbg",
                    mixPathOverride,
                    mixLooperSpec,
                )
              }
            },
            "sbagenx-start-playback",
        )
        .start()
  }

  @ReactMethod
  fun startProgramPlayback(
      programKind: String,
      mainArg: String,
      dropTimeSec: Int,
      holdTimeSec: Int,
      wakeTimeSec: Int,
      curveText: String?,
      sourceName: String?,
      mixPath: String?,
      mixLooperSpec: String?,
      promise: Promise,
  ) {
    Thread(
            {
              resolveNativeCall(promise) {
                playbackController.startProgram(
                    ProgramRuntimeRequest(
                        programKind = programKind,
                        mainArg = mainArg,
                        dropTimeSec = dropTimeSec,
                        holdTimeSec = holdTimeSec,
                        wakeTimeSec = wakeTimeSec,
                        curveText = curveText,
                        sourceName = sourceName ?: "program:$programKind",
                        mixPath = mixPath,
                        mixLooperSpec = mixLooperSpec,
                    ),
                )
              }
            },
            "sbagenx-start-playback",
        )
        .start()
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
  fun getDocumentStoreInfo(promise: Promise) {
    resolveNativeCall(promise) {
      localDocumentStore.getStoreInfo()
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
  fun pickDocumentToLoad(promise: Promise) {
    if (pendingDocumentPickerPromise != null) {
      promise.reject("SBX_DOCUMENT_PICK_BUSY", "A document picker request is already in progress.")
      return
    }

    val activity = reactApplicationContext.currentActivity
    if (activity == null) {
      promise.reject("SBX_DOCUMENT_PICK_NO_ACTIVITY", "No active Android activity is available.")
      return
    }

    val intent =
        Intent(Intent.ACTION_OPEN_DOCUMENT)
            .addCategory(Intent.CATEGORY_OPENABLE)
            .setType("*/*")
            .putExtra(Intent.EXTRA_MIME_TYPES, arrayOf("text/plain", "application/octet-stream"))
            .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
            .addFlags(Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION)

    localDocumentStore.getCurrentLibraryTreeUri()?.let { currentUri ->
      intent.putExtra(DocumentsContract.EXTRA_INITIAL_URI, currentUri)
    }

    pendingDocumentPickerPromise = promise

    UiThreadUtil.runOnUiThread {
      try {
        activity.startActivityForResult(intent, REQUEST_PICK_DOCUMENT)
      } catch (error: Throwable) {
        pendingDocumentPickerPromise = null
        promise.reject("SBX_DOCUMENT_PICK_LAUNCH", error.message, error)
      }
    }
  }

  @ReactMethod
  fun pickLibraryFolder(promise: Promise) {
    if (pendingLibraryFolderPromise != null) {
      promise.reject("SBX_LIBRARY_PICK_BUSY", "A library folder request is already in progress.")
      return
    }

    val activity = reactApplicationContext.currentActivity
    if (activity == null) {
      promise.reject("SBX_LIBRARY_NO_ACTIVITY", "No active Android activity is available.")
      return
    }

    val intent =
        Intent(Intent.ACTION_OPEN_DOCUMENT_TREE)
            .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
            .addFlags(Intent.FLAG_GRANT_WRITE_URI_PERMISSION)
            .addFlags(Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION)
            .addFlags(Intent.FLAG_GRANT_PREFIX_URI_PERMISSION)

    localDocumentStore.getCurrentLibraryTreeUri()?.let { currentUri ->
      intent.putExtra(DocumentsContract.EXTRA_INITIAL_URI, currentUri)
    }

    pendingLibraryFolderPromise = promise

    UiThreadUtil.runOnUiThread {
      try {
        activity.startActivityForResult(intent, REQUEST_PICK_LIBRARY)
      } catch (error: Throwable) {
        pendingLibraryFolderPromise = null
        promise.reject("SBX_LIBRARY_PICK_LAUNCH", error.message, error)
      }
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
            .setType("*/*")
            .putExtra(
                Intent.EXTRA_MIME_TYPES,
                arrayOf("audio/*", "application/ogg", "application/octet-stream"),
            )
            .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
            .addFlags(Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION)

    localDocumentStore.getCurrentLibraryTreeUri()?.let { currentUri ->
      intent.putExtra(DocumentsContract.EXTRA_INITIAL_URI, currentUri)
    }

    pendingMixPickerPromise = promise

    UiThreadUtil.runOnUiThread {
      try {
        activity.startActivityForResult(intent, REQUEST_PICK_MIX)
      } catch (error: Throwable) {
        pendingMixPickerPromise = null
        promise.reject("SBX_PICK_LAUNCH", error.message, error)
      }
    }
  }

  override fun invalidate() {
    pendingMixPickerPromise?.resolve(null)
    pendingMixPickerPromise = null
    pendingLibraryFolderPromise?.resolve(localDocumentStore.getStoreInfo())
    pendingLibraryFolderPromise = null
    pendingDocumentPickerPromise?.resolve(null)
    pendingDocumentPickerPromise = null
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

  private fun takePersistableUriPermission(uri: Uri, data: Intent?) {
    val grantedFlags =
        (data?.flags ?: 0) and
            (Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION)
    if (grantedFlags == 0) {
      return
    }

    try {
      reactApplicationContext.contentResolver.takePersistableUriPermission(uri, grantedFlags)
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

  private fun buildPickedMixJson(
      uri: String,
      displayName: String,
      embeddedLooperSpec: String?,
  ): String {
    return JSONObject()
        .put("uri", uri)
        .put("displayName", displayName)
        .put("embeddedLooperSpec", embeddedLooperSpec)
        .toString()
  }

  companion object {
    const val NAME = "SbaGenXModule"
    const val REQUEST_PICK_MIX = 40271
    const val REQUEST_PICK_LIBRARY = 40272
    const val REQUEST_PICK_DOCUMENT = 40273
  }
}
