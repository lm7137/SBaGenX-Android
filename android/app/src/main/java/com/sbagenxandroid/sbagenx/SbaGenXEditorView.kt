package com.sbagenxandroid.sbagenx

import android.content.Context
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.text.Editable
import android.text.InputType
import android.text.Spannable
import android.text.Spanned
import android.text.TextPaint
import android.text.TextWatcher
import android.text.style.CharacterStyle
import android.text.style.UpdateAppearance
import android.util.TypedValue
import android.view.Gravity
import android.view.inputmethod.EditorInfo
import androidx.appcompat.widget.AppCompatEditText
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.ReactContext
import com.facebook.react.uimanager.events.RCTEventEmitter
import kotlin.math.max
import kotlin.math.min

data class EditorDiagnostic(
    val severity: String,
    val line: Int,
    val column: Int,
    val endLine: Int,
    val endColumn: Int,
)

private class DiagnosticUnderlineSpan(
    private val color: Int,
    private val thicknessPx: Float,
) : CharacterStyle(), UpdateAppearance {
  override fun updateDrawState(textPaint: TextPaint) {
    textPaint.isUnderlineText = true
    textPaint.underlineColor = color
    textPaint.underlineThickness = thicknessPx
  }
}

class SbaGenXEditorView(context: Context) : AppCompatEditText(context) {
  private val density = resources.displayMetrics.density
  private val scaledDensity = resources.displayMetrics.scaledDensity
  private val gutterWidthPx = dp(54f)
  private val contentPaddingHorizontalPx = dp(14f)
  private val contentPaddingVerticalPx = dp(14f)
  private val lineNumberInsetPx = dp(10f)
  private val underlineThicknessPx = dp(2.25f)

  private val gutterPaint =
      Paint(Paint.ANTI_ALIAS_FLAG).apply {
        color = Color.parseColor("#d8d8cf")
      }
  private val gutterDividerPaint =
      Paint(Paint.ANTI_ALIAS_FLAG).apply {
        color = Color.parseColor("#c8c8bf")
        strokeWidth = dp(1f)
      }
  private val currentLinePaint =
      Paint(Paint.ANTI_ALIAS_FLAG).apply {
        color = Color.parseColor("#12c5d7f2")
      }
  private val lineNumberPaint =
      Paint(Paint.ANTI_ALIAS_FLAG).apply {
        color = Color.parseColor("#777468")
        textAlign = Paint.Align.RIGHT
        textSize = sp(12f)
        typeface = Typeface.MONOSPACE
      }
  private val activeLineNumberPaint =
      Paint(Paint.ANTI_ALIAS_FLAG).apply {
        color = Color.parseColor("#3a7cff")
        textAlign = Paint.Align.RIGHT
        textSize = sp(12f)
        typeface = Typeface.create(Typeface.MONOSPACE, Typeface.BOLD)
      }

  private var suppressChangeEvent = false
  private var diagnostics: List<EditorDiagnostic> = emptyList()

  init {
    val chrome =
        GradientDrawable().apply {
          shape = GradientDrawable.RECTANGLE
          cornerRadius = dp(18f)
          setColor(Color.parseColor("#f0efe8"))
          setStroke(dp(1f).toInt(), Color.parseColor("#cfcfc7"))
        }

    background = chrome
    gravity = Gravity.TOP or Gravity.START
    imeOptions = EditorInfo.IME_FLAG_NO_ENTER_ACTION
    inputType =
        InputType.TYPE_CLASS_TEXT or
            InputType.TYPE_TEXT_FLAG_MULTI_LINE or
            InputType.TYPE_TEXT_FLAG_NO_SUGGESTIONS
    setHorizontallyScrolling(false)
    isVerticalScrollBarEnabled = true
    overScrollMode = OVER_SCROLL_IF_CONTENT_SCROLLS
    includeFontPadding = false
    setTextColor(Color.parseColor("#161616"))
    setHintTextColor(Color.parseColor("#8c897f"))
    setTextSize(TypedValue.COMPLEX_UNIT_SP, 15f)
    typeface = Typeface.MONOSPACE
    setLineSpacing(0f, 1.28f)
    setPadding(
        (gutterWidthPx + contentPaddingHorizontalPx).toInt(),
        contentPaddingVerticalPx.toInt(),
        contentPaddingHorizontalPx.toInt(),
        contentPaddingVerticalPx.toInt(),
    )

    addTextChangedListener(
        object : TextWatcher {
          override fun beforeTextChanged(
              s: CharSequence?,
              start: Int,
              count: Int,
              after: Int,
          ) = Unit

          override fun onTextChanged(
              s: CharSequence?,
              start: Int,
              before: Int,
              count: Int,
          ) = Unit

          override fun afterTextChanged(editable: Editable?) {
            applyDiagnosticSpans()
            invalidate()
            if (!suppressChangeEvent) {
              emitTextChange(editable?.toString().orEmpty())
            }
          }
        },
    )
  }

  fun setEditorText(value: String) {
    val nextText = value
    val currentText = text?.toString().orEmpty()
    if (currentText == nextText) {
      applyDiagnosticSpans()
      invalidate()
      return
    }

    suppressChangeEvent = true
    setTextKeepState(nextText)
    val safeSelection = selectionStart.coerceIn(0, nextText.length)
    setSelection(safeSelection)
    suppressChangeEvent = false

    applyDiagnosticSpans()
    invalidate()
  }

  fun setEditorDiagnostics(nextDiagnostics: List<EditorDiagnostic>) {
    diagnostics = nextDiagnostics
    applyDiagnosticSpans()
    invalidate()
  }

  override fun onDraw(canvas: Canvas) {
    drawCurrentLineHighlight(canvas)
    drawGutter(canvas)
    super.onDraw(canvas)
  }

  private fun drawCurrentLineHighlight(canvas: Canvas) {
    val layout = layout ?: return
    val selection = max(selectionStart, 0)
    val currentLine = layout.getLineForOffset(selection)
    val highlightTop = layout.getLineTop(currentLine).toFloat() + totalPaddingTop - scrollY
    val highlightBottom =
        layout.getLineBottom(currentLine).toFloat() + totalPaddingTop - scrollY
    canvas.drawRect(gutterWidthPx, highlightTop, width.toFloat(), highlightBottom, currentLinePaint)
  }

  private fun drawGutter(canvas: Canvas) {
    val layout = layout ?: return
    canvas.drawRect(0f, 0f, gutterWidthPx, height.toFloat(), gutterPaint)
    canvas.drawLine(gutterWidthPx, 0f, gutterWidthPx, height.toFloat(), gutterDividerPaint)

    val firstVisibleLine = layout.getLineForVertical(scrollY)
    val lastVisibleLine = layout.getLineForVertical(scrollY + height)
    val activeLine = layout.getLineForOffset(max(selectionStart, 0))
    val textRight = gutterWidthPx - lineNumberInsetPx

    for (lineIndex in firstVisibleLine..lastVisibleLine) {
      val baseline =
          layout.getLineBaseline(lineIndex).toFloat() + totalPaddingTop - scrollY
      val paint = if (lineIndex == activeLine) activeLineNumberPaint else lineNumberPaint
      canvas.drawText((lineIndex + 1).toString(), textRight, baseline, paint)
    }
  }

  private fun applyDiagnosticSpans() {
    val editable = text ?: return
    val spannable = editable as Spannable

    spannable
        .getSpans(0, spannable.length, DiagnosticUnderlineSpan::class.java)
        .forEach(spannable::removeSpan)

    if (diagnostics.isEmpty() || spannable.isEmpty()) {
      return
    }

    val lineStarts = buildLineStarts(spannable)
    diagnostics.forEach { diagnostic ->
      val start =
          positionToOffset(
              line = diagnostic.line,
              column = diagnostic.column,
              lineStarts = lineStarts,
              textLength = spannable.length,
              allowLineTerminator = false,
          )
      var end =
          positionToOffset(
              line = diagnostic.endLine,
              column = diagnostic.endColumn,
              lineStarts = lineStarts,
              textLength = spannable.length,
              allowLineTerminator = true,
          )
      if (end <= start) {
        end = min(spannable.length, start + 1)
      }
      if (start >= spannable.length || end <= 0) {
        return@forEach
      }

      spannable.setSpan(
          DiagnosticUnderlineSpan(colorForSeverity(diagnostic.severity), underlineThicknessPx),
          start,
          min(end, spannable.length),
          Spanned.SPAN_EXCLUSIVE_EXCLUSIVE,
      )
    }
  }

  private fun buildLineStarts(text: CharSequence): IntArray {
    val starts = ArrayList<Int>()
    starts.add(0)

    for (index in text.indices) {
      if (text[index] == '\n' && index + 1 <= text.length) {
        starts.add(index + 1)
      }
    }

    return starts.toIntArray()
  }

  private fun positionToOffset(
      line: Int,
      column: Int,
      lineStarts: IntArray,
      textLength: Int,
      allowLineTerminator: Boolean,
  ): Int {
    if (textLength == 0) {
      return 0
    }

    val lineIndex = (line - 1).coerceIn(0, max(0, lineStarts.size - 1))
    val lineStart = lineStarts[lineIndex]
    val nextLineStart = if (lineIndex + 1 < lineStarts.size) lineStarts[lineIndex + 1] else textLength
    val lineContentEndExclusive =
        if (nextLineStart > lineStart && nextLineStart - 1 < textLength) {
          if (text?.get(nextLineStart - 1) == '\n') nextLineStart - 1 else nextLineStart
        } else {
          nextLineStart
        }
    val maxOffset = if (allowLineTerminator) nextLineStart else lineContentEndExclusive
    val columnOffset = (column - 1).coerceAtLeast(0)
    return min(lineStart + columnOffset, maxOffset)
  }

  private fun colorForSeverity(severity: String): Int {
    return if (severity.equals("warning", ignoreCase = true)) {
      Color.parseColor("#bf7a00")
    } else {
      Color.parseColor("#c53a53")
    }
  }

  private fun emitTextChange(nextText: String) {
    val event = Arguments.createMap().apply {
      putString("text", nextText)
    }

    (context as? ReactContext)
        ?.getJSModule(RCTEventEmitter::class.java)
        ?.receiveEvent(id, SbaGenXEditorViewManager.EVENT_TEXT_CHANGE, event)
  }

  private fun dp(value: Float): Float = value * density

  private fun sp(value: Float): Float = value * scaledDensity
}
