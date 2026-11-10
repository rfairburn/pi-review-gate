package io.github.rfairburn.pireviewgate.core.input

import io.github.rfairburn.pireviewgate.core.protocol.content.TerminalGraphicsPlacement

/** One pixel rectangle. [right] and [bottom] are exclusive. */
data class PixelRect(val left: Int, val top: Int, val right: Int, val bottom: Int) {
	val width: Int get() = right - left
	val height: Int get() = bottom - top
	val isEmpty: Boolean get() = width <= 0 || height <= 0

	/** The overlap with [other], empty when they do not intersect. */
	fun intersect(other: PixelRect): PixelRect = PixelRect(
		left = maxOf(left, other.left),
		top = maxOf(top, other.top),
		right = minOf(right, other.right),
		bottom = minOf(bottom, other.bottom),
	)
}

/** One cell of a laid-out viewport. */
data class CellPosition(val column: Int, val row: Int)

/**
 * The pixel rectangle one laid-out viewport occupies, and the only mapping
 * between pointer coordinates and terminal cells.
 *
 * The rectangle covers the drawn content — never the padding a smaller canonical
 * frame leaves on a larger measured grid — so a tap outside it addresses nothing
 * and a mouse report is never generated for blank space.
 */
data class CellGeometry(
	val originX: Int,
	val originY: Int,
	val cellWidthPx: Int,
	val cellHeightPx: Int,
	val columns: Int,
	val rows: Int,
) {
	/** The drawn content rectangle in pixels; empty when nothing can be drawn. */
	val contentRect: PixelRect
		get() = if (cellWidthPx <= 0 || cellHeightPx <= 0 || columns <= 0 || rows <= 0) {
			PixelRect(0, 0, 0, 0)
		} else {
			PixelRect(originX, originY, originX + columns * cellWidthPx, originY + rows * cellHeightPx)
		}

	/** The cell under [xPx], or null when the point is outside drawn content. */
	fun columnOf(xPx: Float): Int? {
		if (cellWidthPx <= 0 || columns <= 0) return null
		val offset = xPx - originX
		if (offset < 0f || offset >= columns * cellWidthPx.toFloat()) return null
		return (offset / cellWidthPx).toInt().coerceIn(0, columns - 1)
	}

	/** The cell under [yPx], or null when the point is outside drawn content. */
	fun rowOf(yPx: Float): Int? {
		if (cellHeightPx <= 0 || rows <= 0) return null
		val offset = yPx - originY
		if (offset < 0f || offset >= rows * cellHeightPx.toFloat()) return null
		return (offset / cellHeightPx).toInt().coerceIn(0, rows - 1)
	}

	/** The cell under the point, or null when it is outside drawn content. */
	fun cellOf(xPx: Float, yPx: Float): CellPosition? {
		val column = columnOf(xPx) ?: return null
		val row = rowOf(yPx) ?: return null
		return CellPosition(column, row)
	}

	/** The pixel rectangle of the cell window starting at [column], [row]. */
	fun rectOf(column: Int, row: Int, spanColumns: Int, spanRows: Int): PixelRect = PixelRect(
		left = originX + column * cellWidthPx,
		top = originY + row * cellHeightPx,
		right = originX + (column + spanColumns) * cellWidthPx,
		bottom = originY + (row + spanRows) * cellHeightPx,
	)
}

/**
 * One image placement resolved into source and destination pixels.
 *
 * The source rectangle is in the original PNG's pixel coordinates and covers
 * exactly the visible part of the placement; a renderer holding a downsampled
 * bitmap scales it by decoded over original. The destination is already clipped
 * to the drawn content rectangle, and the two stay proportional.
 */
data class DrawableImage(
	val sourceLeft: Float,
	val sourceTop: Float,
	val sourceWidth: Float,
	val sourceHeight: Float,
	val destination: PixelRect,
)

/**
 * Placement geometry for a typed image placement.
 *
 * The placement's cell-space clip and the drawn content rectangle bound the
 * destination; the placement's pixel-space crop bounds the source. A crop that
 * cannot be honored — absent, zero-sized, or outside the decoded image — is
 * reported honestly by falling back to the whole image rather than by inventing
 * pixels, and a placement with no visible cell window yields null so the caller
 * draws its payload-free fallback instead.
 */
object TerminalGraphicsGeometry {
	/** Resolve [placement] against [geometry] and a decoded image of the given size. */
	fun placement(
		placement: TerminalGraphicsPlacement,
		imageWidthPx: Int,
		imageHeightPx: Int,
		geometry: CellGeometry,
	): DrawableImage? {
		if (imageWidthPx <= 0 || imageHeightPx <= 0) return null
		if (placement.columns <= 0 || placement.rows <= 0) return null
		if (placement.clip.leftColumns < 0 || placement.clip.topRows < 0 ||
			placement.clip.rightColumns < 0 || placement.clip.bottomRows < 0
		) {
			return null
		}
		val left = placement.column + placement.clip.leftColumns
		val top = placement.row + placement.clip.topRows
		val right = placement.column + placement.columns - placement.clip.rightColumns
		val bottom = placement.row + placement.rows - placement.clip.bottomRows
		if (left >= right || top >= bottom) return null

		// Clip in cells first, so the source rectangle shrinks with the
		// destination instead of stretching the whole image into a partial box.
		val visibleLeft = maxOf(left, 0)
		val visibleTop = maxOf(top, 0)
		val visibleRight = minOf(right, geometry.columns)
		val visibleBottom = minOf(bottom, geometry.rows)
		if (visibleLeft >= visibleRight || visibleTop >= visibleBottom) return null
		val destination = geometry.rectOf(
			visibleLeft,
			visibleTop,
			visibleRight - visibleLeft,
			visibleBottom - visibleTop,
		)
		if (destination.isEmpty) return null

		// Source pixels the whole placement window stands for.
		val wholeLeft: Double
		val wholeTop: Double
		val wholeWidth: Double
		val wholeHeight: Double
		val crop = placement.crop
		if (crop.width > 0L && crop.height > 0L &&
			crop.x >= 0L && crop.y >= 0L &&
			crop.x + crop.width <= imageWidthPx.toLong() &&
			crop.y + crop.height <= imageHeightPx.toLong()
		) {
			wholeLeft = crop.x.toDouble()
			wholeTop = crop.y.toDouble()
			wholeWidth = crop.width.toDouble()
			wholeHeight = crop.height.toDouble()
		} else {
			wholeLeft = 0.0
			wholeTop = 0.0
			wholeWidth = imageWidthPx.toDouble()
			wholeHeight = imageHeightPx.toDouble()
		}

		val columnsAcross = placement.columns.toDouble()
		val rowsAcross = placement.rows.toDouble()
		val sourceLeft = wholeLeft + (visibleLeft - placement.column) * wholeWidth / columnsAcross
		val sourceTop = wholeTop + (visibleTop - placement.row) * wholeHeight / rowsAcross
		val sourceRight = wholeLeft + (visibleRight - placement.column) * wholeWidth / columnsAcross
		val sourceBottom = wholeTop + (visibleBottom - placement.row) * wholeHeight / rowsAcross
		val sourceWidth = sourceRight - sourceLeft
		val sourceHeight = sourceBottom - sourceTop
		if (sourceWidth <= 0.0 || sourceHeight <= 0.0) return null

		return DrawableImage(
			sourceLeft = sourceLeft.toFloat(),
			sourceTop = sourceTop.toFloat(),
			sourceWidth = sourceWidth.toFloat(),
			sourceHeight = sourceHeight.toFloat(),
			destination = destination,
		)
	}
}
