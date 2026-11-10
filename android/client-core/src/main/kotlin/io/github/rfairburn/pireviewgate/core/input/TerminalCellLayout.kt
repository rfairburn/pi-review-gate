package io.github.rfairburn.pireviewgate.core.input

import io.github.rfairburn.pireviewgate.core.protocol.content.TerminalCellRun
import io.github.rfairburn.pireviewgate.core.protocol.content.TerminalFrame
import io.github.rfairburn.pireviewgate.core.protocol.content.TerminalLineStyles

/** One drawn cell: its text, its style, and the cells it spans. */
data class TerminalCell(val column: Int, val text: String, val style: SgrStyle, val span: Int)

/** One drawn row of a laid-out viewport. */
data class TerminalLayoutRow(val row: Int, val cells: List<TerminalCell>)

/** The cursor position inside the drawn content rectangle. */
data class TerminalCursorLayout(val column: Int, val row: Int)

/**
 * One frame laid out into cells for one requested grid.
 *
 * The owner's frame is canonical: it may be larger or smaller than the grid the
 * phone measured. [drawnColumns] and [drawnRows] are the intersection, and they
 * are the only cells this layout contains. Everything outside them is padding on
 * a larger grid and clipped content on a smaller one, so pointer coordinates and
 * mouse reports can be confined to content that is actually drawn.
 */
data class TerminalLayout(
	val frameCols: Int,
	val frameRows: Int,
	val requestedCols: Int,
	val requestedRows: Int,
	val drawnColumns: Int,
	val drawnRows: Int,
	val rows: List<TerminalLayoutRow>,
	val cursor: TerminalCursorLayout?,
) {
	/** True when [column] and [row] fall inside the drawn content rectangle. */
	fun containsCell(column: Int, row: Int): Boolean =
		column >= 0 && row >= 0 && column < drawnColumns && row < drawnRows
}

/**
 * Canonical cell layout of a native viewport frame.
 *
 * Column placement comes from [UnicodeCellWidths] — the pinned owner's Unicode
 * 11 model — never from a glyph measurement, so a wide cell always occupies two
 * columns and a combining mark never starts one. Where the frame carries
 * structured style runs they anchor each run's first column, and the row's
 * generated SGR text must agree with them; where they are absent the SGR spans
 * themselves are laid out end to end.
 *
 * Any disagreement fails closed: a row count that does not match the frame, a
 * non-native row, a structured run whose text differs from the row's text, a run
 * that starts before the previous run ends, or a run that overruns the frame
 * width yields null for the whole frame rather than a partially drawn guess.
 */
object TerminalCellLayout {
	/** The owner's own viewport dimension bound. */
	const val MAX_DIMENSION: Int = 1_000

	/** Lay out [frame] for a [requestedCols] by [requestedRows] grid, or null. */
	fun layout(frame: TerminalFrame, requestedCols: Int, requestedRows: Int): TerminalLayout? {
		if (requestedCols <= 0 || requestedRows <= 0) return null
		if (requestedCols > MAX_DIMENSION || requestedRows > MAX_DIMENSION) return null
		val frameCols = frame.cols
		val frameRows = frame.rows
		if (frameCols <= 0 || frameRows <= 0) return null
		if (frameCols > MAX_DIMENSION || frameRows > MAX_DIMENSION) return null
		if (frame.lines.size != frameRows) return null

		val drawnColumns = minOf(frameCols, requestedCols)
		val drawnRows = minOf(frameRows, requestedRows)

		val structuredByRow = HashMap<Int, TerminalLineStyles>()
		for (entry in frame.styles ?: emptyList()) {
			if (entry.line < 0 || entry.line >= frameRows) return null
			if (structuredByRow.put(entry.line, entry) != null) return null
		}

		val layoutRows = ArrayList<TerminalLayoutRow>(drawnRows)
		for (row in 0 until drawnRows) {
			val spans = GeneratedSgrStyles.parse(frame.lines[row]) ?: return null
			val structured = structuredByRow[row]
			if (structured != null && !structuredTextMatches(structured, spans)) return null
			val cells = layoutRuns(spans, structured, drawnColumns) ?: return null
			layoutRows.add(TerminalLayoutRow(row, cells))
		}

		val cursor = frame.cursor
		val cursorLayout = if (
			cursor.visible &&
			cursor.row in 0 until drawnRows &&
			cursor.column in 0 until drawnColumns
		) {
			TerminalCursorLayout(cursor.column, cursor.row)
		} else {
			null
		}
		return TerminalLayout(
			frameCols = frameCols,
			frameRows = frameRows,
			requestedCols = requestedCols,
			requestedRows = requestedRows,
			drawnColumns = drawnColumns,
			drawnRows = drawnRows,
			rows = layoutRows,
			cursor = cursorLayout,
		)
	}

	private fun structuredTextMatches(structured: TerminalLineStyles, spans: List<SgrSpan>): Boolean {
		val structuredText = StringBuilder()
		for (run in structured.runs) structuredText.append(run.text)
		val lineText = StringBuilder()
		for (span in spans) lineText.append(span.text)
		return structuredText.toString() == lineText.toString()
	}

	/** Place one row's runs into cells clipped at [clipColumns], or null. */
	private fun layoutRuns(
		spans: List<SgrSpan>,
		structured: TerminalLineStyles?,
		clipColumns: Int,
	): List<TerminalCell>? {
		val cells = ArrayList<TerminalCell>()
		var column = 0
		if (structured != null) {
			for (run in structured.runs) {
				if (run.startColumn < column) return null
				column = run.startColumn
				if (column >= clipColumns) break
				val end = appendRun(cells, run.text, styleOf(run), column, clipColumns) ?: return null
				column = end
			}
			return cells
		}
		for (span in spans) {
			if (column >= clipColumns) break
			val end = appendRun(cells, span.text, span.style, column, clipColumns) ?: return null
			column = end
		}
		return cells
	}

	private fun styleOf(run: TerminalCellRun): SgrStyle = SgrStyle(
		fg = run.fg,
		bg = run.bg,
		bold = run.bold,
		dim = run.dim,
		italic = run.italic,
		underline = run.underline,
		blink = run.blink,
		inverse = run.inverse,
		invisible = run.invisible,
		strikethrough = run.strikethrough,
		overline = run.overline,
	)

	/**
	 * Append one run's cells from [startColumn] and report the column after the
	 * last placed cell. A cell that would straddle [clipColumns] ends the row:
	 * half a cell outside the drawn content rectangle is never drawn. A zero-width
	 * mark with no base cell inside the clipped window is dropped and shifts
	 * nothing.
	 */
	private fun appendRun(
		cells: MutableList<TerminalCell>,
		text: String,
		style: SgrStyle,
		startColumn: Int,
		clipColumns: Int,
	): Int? {
		var column = startColumn
		for (cluster in UnicodeCellWidths.clusters(text)) {
			if (cluster.advance == 0) continue
			if (column + cluster.advance > clipColumns) return column
			cells.add(TerminalCell(column, cluster.text, style, cluster.advance))
			column += cluster.advance
		}
		return column
	}
}
