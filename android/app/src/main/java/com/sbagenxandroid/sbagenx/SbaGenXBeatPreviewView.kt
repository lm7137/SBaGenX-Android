package com.sbagenxandroid.sbagenx

import android.content.Context
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.Path
import android.graphics.RectF
import android.util.TypedValue
import android.view.View
import kotlin.math.abs
import kotlin.math.ceil
import kotlin.math.floor
import kotlin.math.log10
import kotlin.math.max
import kotlin.math.pow

data class BeatPreviewPointModel(
    val tSec: Double,
    val beatHz: Double?,
)

data class BeatPreviewSeriesModel(
    val voiceIndex: Int,
    val label: String,
    val activeSampleCount: Int,
    val points: List<BeatPreviewPointModel>,
)

data class BeatPreviewModel(
    val durationSec: Double,
    val minHz: Double?,
    val maxHz: Double?,
    val timeLabel: String,
    val series: List<BeatPreviewSeriesModel>,
)

private data class AxisScale(
    val min: Double,
    val max: Double,
    val ticks: List<Double>,
)

class SbaGenXBeatPreviewView(context: Context) : View(context) {
  private val density = resources.displayMetrics.density
  private val chartPath = Path()
  private val chartRect = RectF()
  private val lineColors =
      intArrayOf(
          Color.parseColor("#3a7cff"),
          Color.parseColor("#ff2ea6"),
          Color.parseColor("#00a47a"),
          Color.parseColor("#7b61ff"),
      )

  private val frameFillPaint =
      Paint(Paint.ANTI_ALIAS_FLAG).apply {
        style = Paint.Style.FILL
      }
  private val frameStrokePaint =
      Paint(Paint.ANTI_ALIAS_FLAG).apply {
        style = Paint.Style.STROKE
        strokeWidth = dp(1f)
      }
  private val axisPaint =
      Paint(Paint.ANTI_ALIAS_FLAG).apply {
        style = Paint.Style.STROKE
        strokeWidth = dp(1.25f)
      }
  private val gridPaint =
      Paint(Paint.ANTI_ALIAS_FLAG).apply {
        style = Paint.Style.STROKE
        strokeWidth = dp(1f)
      }
  private val labelPaint =
      Paint(Paint.ANTI_ALIAS_FLAG).apply {
        textAlign = Paint.Align.RIGHT
        textSize = sp(11f)
      }
  private val labelPaintCenter =
      Paint(Paint.ANTI_ALIAS_FLAG).apply {
        textAlign = Paint.Align.CENTER
        textSize = sp(10.5f)
      }
  private val labelPaintEnd =
      Paint(Paint.ANTI_ALIAS_FLAG).apply {
        textAlign = Paint.Align.RIGHT
        textSize = sp(11f)
      }
  private val tickPaint =
      Paint(Paint.ANTI_ALIAS_FLAG).apply {
        style = Paint.Style.STROKE
        strokeWidth = dp(1.1f)
      }
  private val linePaint =
      Paint(Paint.ANTI_ALIAS_FLAG).apply {
        style = Paint.Style.STROKE
        strokeCap = Paint.Cap.ROUND
        strokeJoin = Paint.Join.ROUND
        strokeWidth = dp(2.6f)
      }

  private var preview: BeatPreviewModel? = null
  private var darkMode = false

  init {
    minimumHeight = dp(208f).toInt()
    setWillNotDraw(false)
    applyPalette()
  }

  fun setPreview(nextPreview: BeatPreviewModel?) {
    preview = nextPreview
    invalidate()
  }

  fun setDarkMode(nextDarkMode: Boolean) {
    if (darkMode == nextDarkMode) {
      return
    }
    darkMode = nextDarkMode
    applyPalette()
    invalidate()
  }

  override fun onMeasure(widthMeasureSpec: Int, heightMeasureSpec: Int) {
    val desiredWidth = dp(320f).toInt()
    val desiredHeight = dp(208f).toInt()
    setMeasuredDimension(
        resolveSize(desiredWidth, widthMeasureSpec),
        resolveSize(desiredHeight, heightMeasureSpec),
    )
  }

  override fun onDraw(canvas: Canvas) {
    super.onDraw(canvas)

    val widthF = width.toFloat()
    val heightF = height.toFloat()
    if (widthF <= 0f || heightF <= 0f) {
      return
    }

    val chartLeft = dp(58f)
    val chartTop = dp(16f)
    val chartRight = widthF - dp(14f)
    val chartBottom = heightF - dp(40f)
    chartRect.set(chartLeft, chartTop, chartRight, chartBottom)

    canvas.drawRoundRect(chartRect, dp(18f), dp(18f), frameFillPaint)
    canvas.drawRoundRect(chartRect, dp(18f), dp(18f), frameStrokePaint)

    val model = preview
    if (model == null) {
      drawBasicAxes(canvas, chartLeft, chartTop, chartRight, chartBottom)
      return
    }

    val minHz = model.minHz
    val maxHz = model.maxHz
    val duration = max(model.durationSec, 0.001)
    val yAxisScale = buildYAxisScale(minHz ?: 0.0, maxHz ?: 1.0)
    val hzMin = yAxisScale.min
    val hzMax = yAxisScale.max
    val hzSpan = max(hzMax - hzMin, 0.001)
    val xTicks = buildXAxisTicks(duration, model.timeLabel)
    drawLabeledAxes(
        canvas,
        chartLeft,
        chartTop,
        chartRight,
        chartBottom,
        yAxisScale,
        duration,
        xTicks,
        model.timeLabel,
    )

    model.series.forEachIndexed { index, series ->
      chartPath.reset()
      var needsMove = true

      series.points.forEach { point ->
        val beatHz = point.beatHz
        if (beatHz == null) {
          needsMove = true
          return@forEach
        }

        val x =
            chartLeft + ((point.tSec / duration).toFloat().coerceIn(0f, 1f) * chartRect.width())
        val y =
            chartBottom -
                (((beatHz - hzMin) / hzSpan).toFloat().coerceIn(0f, 1f) * chartRect.height())

        if (needsMove) {
          chartPath.moveTo(x, y)
          needsMove = false
        } else {
          chartPath.lineTo(x, y)
        }
      }

      linePaint.color = lineColors[index % lineColors.size]
      canvas.drawPath(chartPath, linePaint)
    }
  }

  private fun formatHzLabel(value: Double?): String {
    if (value == null) {
      return "—"
    }
    val suffix = " Hz"
    return if (value >= 10.0) {
      "${String.format("%.1f", value)}$suffix"
    } else {
      "${String.format("%.2f", value)}$suffix"
    }
  }

  private fun drawBasicAxes(
      canvas: Canvas,
      chartLeft: Float,
      chartTop: Float,
      chartRight: Float,
      chartBottom: Float,
  ) {
    val midY = (chartTop + chartBottom) / 2f
    canvas.drawLine(chartLeft, chartTop, chartRight, chartTop, gridPaint)
    canvas.drawLine(chartLeft, midY, chartRight, midY, gridPaint)
    canvas.drawLine(chartLeft, chartBottom, chartRight, chartBottom, axisPaint)
    canvas.drawLine(chartLeft, chartTop, chartLeft, chartBottom, axisPaint)

    val tick = dp(5f)
    canvas.drawLine(chartLeft - tick, chartTop, chartLeft, chartTop, tickPaint)
    canvas.drawLine(chartLeft - tick, midY, chartLeft, midY, tickPaint)
    canvas.drawLine(chartLeft - tick, chartBottom, chartLeft, chartBottom, tickPaint)

    val midX = (chartLeft + chartRight) / 2f
    canvas.drawLine(chartLeft, chartBottom, chartLeft, chartBottom + tick, tickPaint)
    canvas.drawLine(midX, chartBottom, midX, chartBottom + tick, tickPaint)
    canvas.drawLine(chartRight, chartBottom, chartRight, chartBottom + tick, tickPaint)
  }

  private fun drawLabeledAxes(
      canvas: Canvas,
      chartLeft: Float,
      chartTop: Float,
      chartRight: Float,
      chartBottom: Float,
      yAxisScale: AxisScale,
      durationSec: Double,
      xTicks: List<Double>,
      timeLabel: String,
  ) {
    val tick = dp(5f)
    val hzMin = yAxisScale.min
    val hzMax = yAxisScale.max
    val hzSpan = max(hzMax - hzMin, 0.001)

    for ((index, tickValue) in yAxisScale.ticks.withIndex()) {
      val fraction = ((tickValue - hzMin) / hzSpan).toFloat().coerceIn(0f, 1f)
      val y = chartBottom - fraction * chartRect.height()
      val paint =
          if (index == 0 || index == yAxisScale.ticks.lastIndex) axisPaint else gridPaint
      canvas.drawLine(chartLeft, y, chartRight, y, paint)
      canvas.drawLine(chartLeft - tick, y, chartLeft, y, tickPaint)

      canvas.drawText(
          formatHzTickLabel(tickValue),
          chartLeft - dp(8f),
          centeredLabelBaseline(y, labelPaint),
          labelPaint,
      )
    }

    for ((index, tickValue) in xTicks.withIndex()) {
      val fraction = (tickValue / durationSec).toFloat().coerceIn(0f, 1f)
      val x = chartLeft + fraction * chartRect.width()
      if (index in 1 until xTicks.lastIndex) {
        canvas.drawLine(x, chartTop, x, chartBottom, gridPaint)
      }
      canvas.drawLine(x, chartBottom, x, chartBottom + tick, tickPaint)
      val baseline = chartBottom + tick + dp(12f)
      val label = formatTimeTickLabel(tickValue, timeLabel)
      when (index) {
        0 ->
            canvas.drawText(
                label,
                x + dp(1f),
                baseline,
                labelPaintCenter,
            )
        xTicks.lastIndex ->
            canvas.drawText(
                label,
                x,
                baseline,
                labelPaintCenter,
            )
        else -> canvas.drawText(label, x, baseline, labelPaintCenter)
      }
    }

    canvas.drawLine(chartLeft, chartBottom, chartRight, chartBottom, axisPaint)
    canvas.drawLine(chartLeft, chartTop, chartLeft, chartBottom, axisPaint)
    canvas.drawText("BEAT", chartLeft - dp(8f), chartTop - dp(6f), labelPaint)
    canvas.drawText(timeLabel, chartRight, chartTop - dp(6f), labelPaintEnd)
  }

  private fun centeredLabelBaseline(y: Float, paint: Paint): Float {
    return y - (paint.descent() + paint.ascent()) / 2f
  }

  private fun formatHzTickLabel(value: Double): String {
    return if (value >= 10.0) {
      String.format("%.1f", value)
    } else {
      String.format("%.2f", value)
    }
  }

  private fun formatTimeTickLabel(seconds: Double, timeLabel: String): String {
    if (timeLabel == "TIME MIN") {
      val minutes = seconds / 60.0
      return when {
        abs(minutes - minutes.toInt()) < 0.05 -> "${minutes.toInt()}m"
        minutes >= 10.0 -> "${String.format("%.0f", minutes)}m"
        minutes >= 1.0 -> "${String.format("%.1f", minutes)}m"
        else -> "${String.format("%.2f", minutes)}m"
      }
    }

    return when {
      abs(seconds - seconds.toInt()) < 0.05 -> "${seconds.toInt()}s"
      seconds >= 10.0 -> "${String.format("%.0f", seconds)}s"
      else -> "${String.format("%.1f", seconds)}s"
    }
  }

  private fun buildYAxisScale(rawMin: Double, rawMax: Double): AxisScale {
    var minValue = rawMin
    var maxValue = rawMax
    if (!minValue.isFinite() || !maxValue.isFinite()) {
      minValue = 0.0
      maxValue = 1.0
    }
    if (abs(maxValue - minValue) < 0.000001) {
      minValue -= 0.5
      maxValue += 0.5
    }

    val roughStep = max((maxValue - minValue) / 4.0, 0.05)
    val step = choosePreferredStep(roughStep)
    val tickStart = floor(minValue / step) * step
    val tickEnd = ceil(maxValue / step) * step

    val ticks = ArrayList<Double>()
    var tick = tickStart
    var guard = 0
    while (tick <= tickEnd + step * 0.25 && guard < 32) {
      ticks.add(normalizeTick(tick))
      tick += step
      guard += 1
    }

    return AxisScale(
        min = ticks.firstOrNull() ?: tickStart,
        max = ticks.lastOrNull() ?: tickEnd,
        ticks = ticks,
    )
  }

  private fun buildXAxisTicks(durationSec: Double, timeLabel: String): List<Double> {
    val candidatesSec =
        if (timeLabel == "TIME MIN") {
          listOf(1.0, 2.0, 5.0, 10.0, 15.0, 20.0, 30.0, 60.0).map { it * 60.0 }
        } else {
          listOf(5.0, 10.0, 15.0, 20.0, 30.0, 60.0, 90.0, 120.0)
        }

    val roughStep = max(durationSec / 5.0, 1.0)
    val step = candidatesSec.firstOrNull { it >= roughStep } ?: candidatesSec.last()

    val ticks = ArrayList<Double>()
    var tick = 0.0
    var guard = 0
    while (tick <= durationSec + step * 0.1 && guard < 32) {
      ticks.add(tick)
      tick += step
      guard += 1
    }

    if (ticks.isEmpty() || ticks.first() != 0.0) {
      ticks.add(0, 0.0)
    }

    return ticks
  }

  private fun choosePreferredStep(roughStep: Double): Double {
    val safeRough = max(roughStep, 0.000001)
    val magnitude = 10.0.pow(floor(log10(safeRough)))
    val multipliers = listOf(0.5, 1.0, 2.0, 5.0, 10.0)

    for (powerOffset in -1..1) {
      val base = magnitude * 10.0.pow(powerOffset.toDouble())
      for (multiplier in multipliers) {
        val candidate = base * multiplier
        if (candidate >= safeRough) {
          return candidate
        }
      }
    }

    return magnitude * 10.0
  }

  private fun normalizeTick(value: Double): Double {
    return if (abs(value) < 0.0000001) 0.0 else value
  }

  private fun dp(value: Float): Float = value * density

  private fun sp(value: Float): Float =
      TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_SP, value, resources.displayMetrics)

  private fun applyPalette() {
    if (darkMode) {
      frameFillPaint.color = Color.parseColor("#1affffff")
      frameStrokePaint.color = Color.parseColor("#36ffffff")
      axisPaint.color = Color.parseColor("#b8dbe8ff")
      gridPaint.color = Color.parseColor("#2effffff")
      labelPaint.color = Color.parseColor("#d8f2f6ff")
      labelPaintCenter.color = Color.parseColor("#d8f2f6ff")
      labelPaintEnd.color = Color.parseColor("#d8f2f6ff")
      tickPaint.color = Color.parseColor("#8fdbe8ff")
      return
    }

    frameFillPaint.color = Color.parseColor("#14ffffff")
    frameStrokePaint.color = Color.parseColor("#38ffffff")
    axisPaint.color = Color.parseColor("#9f4f4d44")
    gridPaint.color = Color.parseColor("#30545249")
    labelPaint.color = Color.parseColor("#cc2c2a25")
    labelPaintCenter.color = Color.parseColor("#cc2c2a25")
    labelPaintEnd.color = Color.parseColor("#cc2c2a25")
    tickPaint.color = Color.parseColor("#8a4f4d44")
  }
}
