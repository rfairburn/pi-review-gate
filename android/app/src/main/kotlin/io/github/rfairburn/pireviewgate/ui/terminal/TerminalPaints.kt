package io.github.rfairburn.pireviewgate.ui.terminal

import android.graphics.Paint
import android.graphics.Typeface
import io.github.rfairburn.pireviewgate.core.input.CellColorResolution
import io.github.rfairburn.pireviewgate.core.input.CellColors
import io.github.rfairburn.pireviewgate.core.input.SgrStyle
import io.github.rfairburn.pireviewgate.core.input.TerminalFontMetrics
import kotlin.math.ceil

/**
 * The Paints a laid-out viewport is drawn with.
 *
 * Color resolution lives in [CellColorResolution] so the rules — recorded
 * foreground and background each honoured on their own, inverse swapping them,
 * dim reducing the glyph only — are testable without a device. What stays here is
 * purely platform: a monospace face, a fill, and a rule for underlines, strike,
 * and overline.
 *
 * Blink is rendered as steady visible text; a phone viewport has no reason to
 * animate a cell the owner only marked as blinking. Invisible text is skipped
 * while its background still paints.
 */
internal class TerminalPaints {
	val textPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
		typeface = Typeface.MONOSPACE
		textSize = DEFAULT_TEXT_SIZE_PX
	}

	val blockPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
		style = Paint.Style.FILL
	}

	val rulePaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
		style = Paint.Style.STROKE
		strokeWidth = 1f
	}

	/** The text size in pixels; changing it changes every cell metric. */
	var textSizePx: Float
		get() = textPaint.textSize
		set(value) {
			textPaint.textSize = value
		}

	/** Stable base-face metrics, independent of the last drawn cell's style. */
	fun measureFont(size: Float): TerminalFontMetrics {
		textSizePx = size
		textPaint.isFakeBoldText = false
		textPaint.textSkewX = 0f
		val metrics = textPaint.fontMetricsInt
		return TerminalFontMetrics(ceil(textPaint.measureText("M")).toInt(), -metrics.ascent + metrics.descent + 1)
	}

	/**
	 * The colors one cell is drawn with.
	 *
	 * Resolved through a small cache: a viewport repeats the same handful of styles
	 * thousands of times per frame, and recomputing them cell by cell would be
	 * allocation the renderer does not need. The cache is dropped whenever the
	 * defaults change, since the same style then resolves to different colors.
	 */
	fun colors(style: SgrStyle, defaultForeground: Int, defaultBackground: Int): CellColors {
		if (cachedDefaults != defaultForeground to defaultBackground) {
			cachedDefaults = defaultForeground to defaultBackground
			cache.clear()
		}
		return cache.getOrPut(style) {
			CellColorResolution.resolve(style, defaultForeground, defaultBackground)
		}
	}

	private var cachedDefaults = 0 to 0
	private val cache = HashMap<SgrStyle, CellColors>()

	companion object {
		const val DEFAULT_TEXT_SIZE_PX = 42f
	}
}
