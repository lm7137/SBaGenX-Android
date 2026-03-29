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
import android.view.MotionEvent
import android.view.inputmethod.EditorInfo
import android.widget.Scroller
import androidx.appcompat.widget.AppCompatEditText
import android.text.method.ScrollingMovementMethod
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
    isVerticalScrollBarEnabled = false
    overScrollMode = OVER_SCROLL_IF_CONTENT_SCROLLS
    movementMethod = ScrollingMovementMethod.getInstance()
    setScroller(Scroller(context))
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

  override fun onScrollChanged(l: Int, t: Int, oldl: Int, oldt: Int) {
    super.onScrollChanged(l, t, oldl, oldt)
    postInvalidateOnAnimation()
  }

  override fun onTouchEvent(event: MotionEvent): Boolean {
    when (event.actionMasked) {
      MotionEvent.ACTION_DOWN,
      MotionEvent.ACTION_MOVE -> parent?.requestDisallowInterceptTouchEvent(true)
      MotionEvent.ACTION_UP,
      MotionEvent.ACTION_CANCEL -> parent?.requestDisallowInterceptTouchEvent(false)
    }

    return super.onTouchEvent(event)
  }

  private fun drawCurrentLineHighlight(canvas: Canvas) {
    val layout = layout ?: return
    val selection = max(selectionStart, 0)
    val currentLine = layout.getLineForOffset(selection)
    val contentTop = totalPaddingTop.toFloat()
    val highlightTop = layout.getLineTop(currentLine).toFloat() + contentTop
    val highlightBottom = layout.getLineBottom(currentLine).toFloat() + contentTop
    canvas.drawRect(gutterWidthPx, highlightTop, width.toFloat(), highlightBottom, currentLinePaint)
  }

  private fun drawGutter(canvas: Canvas) {
    val layout = layout ?: return
    val content = text ?: return
    val lineStarts = buildLineStarts(content)
    val clipBounds = canvas.clipBounds
    val clipTop = clipBounds.top.toFloat()
    val clipBottom = clipBounds.bottom.toFloat()
    val contentTop = totalPaddingTop.toFloat()

    canvas.drawRect(0f, clipTop, gutterWidthPx, clipBottom, gutterPaint)
    canvas.drawLine(gutterWidthPx, clipTop, gutterWidthPx, clipBottom, gutterDividerPaint)

    val visibleLayoutTop = max(0, clipBounds.top - totalPaddingTop)
    val visibleLayoutBottom = max(visibleLayoutTop, clipBounds.bottom - totalPaddingTop)
    val firstVisibleLine = layout.getLineForVertical(visibleLayoutTop)
    val lastVisibleLine = layout.getLineForVertical(visibleLayoutBottom)
    val activeLogicalLine = logicalLineNumberAtOffset(lineStarts, max(selectionStart, 0))
    val textRight = gutterWidthPx - lineNumberInsetPx

    for (lineIndex in firstVisibleLine..lastVisibleLine) {
      val lineStartOffset = layout.getLineStart(lineIndex).coerceIn(0, content.length)
      if (!isDocumentLineStart(content, lineStartOffset)) {
        continue
      }

      val logicalLine = logicalLineNumberAtOffset(lineStarts, lineStartOffset)
      val lineTop = layout.getLineTop(lineIndex).toFloat() + contentTop
      val lineBottom = layout.getLineBottom(lineIndex).toFloat() + contentTop
      if (lineBottom < clipTop || lineTop > clipBottom) {
        continue
      }

      val baseline = layout.getLineBaseline(lineIndex).toFloat() + contentTop
      val paint =
          if (logicalLine == activeLogicalLine) activeLineNumberPaint else lineNumberPaint
      canvas.drawText(logicalLine.toString(), textRight, baseline, paint)
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

  private fun isDocumentLineStart(text: CharSequence, offset: Int): Boolean {
    return offset <= 0 || text[offset - 1] == '\n'
  }

  private fun logicalLineNumberAtOffset(lineStarts: IntArray, offset: Int): Int {
    if (lineStarts.isEmpty()) {
      return 1
    }

    var low = 0
    var high = lineStarts.size - 1
    var bestIndex = 0
    while (low <= high) {
      val mid = (low + high).ushr(1)
      if (lineStarts[mid] <= offset) {
        bestIndex = mid
        low = mid + 1
      } else {
        high = mid - 1
      }
    }

    return bestIndex + 1
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
