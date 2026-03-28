package com.sbagenxandroid.sbagenx

import com.facebook.react.bridge.ReadableArray
import com.facebook.react.bridge.ReadableMap
import com.facebook.react.bridge.ReadableType
import com.facebook.react.uimanager.SimpleViewManager
import com.facebook.react.uimanager.ThemedReactContext
import com.facebook.react.uimanager.annotations.ReactProp

class SbaGenXEditorViewManager : SimpleViewManager<SbaGenXEditorView>() {
  override fun getName(): String = REACT_CLASS

  override fun createViewInstance(reactContext: ThemedReactContext): SbaGenXEditorView =
      SbaGenXEditorView(reactContext)

  @ReactProp(name = "text")
  fun setText(view: SbaGenXEditorView, text: String?) {
    view.setEditorText(text.orEmpty())
  }

  @ReactProp(name = "placeholder")
  fun setPlaceholder(view: SbaGenXEditorView, placeholder: String?) {
    view.hint = placeholder.orEmpty()
  }

  @ReactProp(name = "editable", defaultBoolean = true)
  fun setEditable(view: SbaGenXEditorView, editable: Boolean) {
    view.isEnabled = editable
    view.isFocusable = editable
    view.isFocusableInTouchMode = editable
    view.isCursorVisible = editable
    view.isLongClickable = true
  }

  @ReactProp(name = "diagnostics")
  fun setDiagnostics(view: SbaGenXEditorView, diagnostics: ReadableArray?) {
    view.setEditorDiagnostics(parseDiagnostics(diagnostics))
  }

  override fun getExportedCustomDirectEventTypeConstants(): MutableMap<String, Any> =
      mutableMapOf(
          EVENT_TEXT_CHANGE to mutableMapOf("registrationName" to "onTextChange"),
      )

  private fun parseDiagnostics(diagnostics: ReadableArray?): List<EditorDiagnostic> {
    if (diagnostics == null || diagnostics.size() == 0) {
      return emptyList()
    }

    val result = ArrayList<EditorDiagnostic>(diagnostics.size())
    for (index in 0 until diagnostics.size()) {
      if (diagnostics.getType(index) != ReadableType.Map) {
        continue
      }

      val map = diagnostics.getMap(index) ?: continue
      result.add(
          EditorDiagnostic(
              severity = map.getString("severity").orEmpty(),
              line = map.getIntOrDefault("line", 1),
              column = map.getIntOrDefault("column", 1),
              endLine = map.getIntOrDefault("endLine", map.getIntOrDefault("line", 1)),
              endColumn =
                  map.getIntOrDefault(
                      "endColumn",
                      map.getIntOrDefault("column", 1),
                  ),
          ),
      )
    }

    return result
  }

  companion object {
    const val REACT_CLASS = "SbaGenXEditorView"
    const val EVENT_TEXT_CHANGE = "topTextChange"
  }
}

private fun ReadableMap.getIntOrDefault(name: String, fallback: Int): Int {
  if (!hasKey(name) || isNull(name)) {
    return fallback
  }

  return getInt(name)
}
