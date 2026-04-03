package com.sbagenxandroid.sbagenx

import com.facebook.react.bridge.ReadableArray
import com.facebook.react.bridge.ReadableMap
import com.facebook.react.bridge.ReadableType
import com.facebook.react.uimanager.SimpleViewManager
import com.facebook.react.uimanager.ThemedReactContext
import com.facebook.react.uimanager.annotations.ReactProp

class SbaGenXBeatPreviewViewManager : SimpleViewManager<SbaGenXBeatPreviewView>() {
  override fun getName(): String = REACT_CLASS

  override fun createViewInstance(reactContext: ThemedReactContext): SbaGenXBeatPreviewView =
      SbaGenXBeatPreviewView(reactContext)

  @ReactProp(name = "preview")
  fun setPreview(view: SbaGenXBeatPreviewView, preview: ReadableMap?) {
    view.setPreview(preview?.toBeatPreviewModel())
  }

  companion object {
    const val REACT_CLASS = "SbaGenXBeatPreviewView"
  }
}

private fun ReadableMap.toBeatPreviewModel(): BeatPreviewModel {
  return BeatPreviewModel(
      durationSec = getDoubleOrDefault("durationSec", 0.0),
      minHz = getNullableDouble("minHz"),
      maxHz = getNullableDouble("maxHz"),
      timeLabel = getString("timeLabel").orEmpty(),
      series = getArray("series").toBeatPreviewSeriesList(),
  )
}

private fun ReadableArray?.toBeatPreviewSeriesList(): List<BeatPreviewSeriesModel> {
  if (this == null || size() == 0) {
    return emptyList()
  }

  val result = ArrayList<BeatPreviewSeriesModel>(size())
  for (index in 0 until size()) {
    if (getType(index) != ReadableType.Map) {
      continue
    }

    val map = getMap(index) ?: continue
    result.add(
        BeatPreviewSeriesModel(
            voiceIndex = map.getIntOrDefault("voiceIndex", index),
            label = map.getString("label").orEmpty(),
            activeSampleCount = map.getIntOrDefault("activeSampleCount", 0),
            points = map.getArray("points").toBeatPreviewPointList(),
        ),
    )
  }
  return result
}

private fun ReadableArray?.toBeatPreviewPointList(): List<BeatPreviewPointModel> {
  if (this == null || size() == 0) {
    return emptyList()
  }

  val result = ArrayList<BeatPreviewPointModel>(size())
  for (index in 0 until size()) {
    if (getType(index) != ReadableType.Map) {
      continue
    }

    val map = getMap(index) ?: continue
    result.add(
        BeatPreviewPointModel(
            tSec = map.getDoubleOrDefault("tSec", 0.0),
            beatHz = map.getNullableDouble("beatHz"),
        ),
    )
  }

  return result
}

private fun ReadableMap.getIntOrDefault(name: String, fallback: Int): Int {
  if (!hasKey(name) || isNull(name)) {
    return fallback
  }
  return getInt(name)
}

private fun ReadableMap.getDoubleOrDefault(name: String, fallback: Double): Double {
  if (!hasKey(name) || isNull(name)) {
    return fallback
  }
  return getDouble(name)
}

private fun ReadableMap.getNullableDouble(name: String): Double? {
  if (!hasKey(name) || isNull(name)) {
    return null
  }
  return getDouble(name)
}
