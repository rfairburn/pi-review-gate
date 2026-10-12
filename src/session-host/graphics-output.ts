import { sliceByColumn, visibleWidth, imageFallback } from "pi-session-host-tui";
import type { TerminalGraphicsFrame, TerminalGraphicsFallback, TerminalGraphicsPlacement } from "./kitty-graphics";
import type { ComposedHostFrame, HostPaneRect } from "./compositor";

/** One actual surface's graphics, projected only into its native pane. */
export interface HostGraphicsLayer {
	readonly ownerId: string;
	readonly pane: HostPaneRect;
	readonly frame: TerminalGraphicsFrame;
}

interface FallbackPlacement {
	readonly id: string;
	readonly mimeType: "image/png";
	readonly widthPx?: number;
	readonly heightPx?: number;
	readonly column: number;
	readonly row: number;
	readonly columns: number;
	readonly rows: number;
	readonly clip: {
		readonly leftColumns: number;
		readonly topRows: number;
		readonly rightColumns: number;
		readonly bottomRows: number;
	};
}

/**
 * Compose Pi's pinned native image fallback text at typed placement anchors.
 * Whole-layer fallback strips graphics, while mixed rendering can exclude the
 * successfully rendered placements and retain their validated layer.
 */
export function fallbackHostGraphics(
	frame: ComposedHostFrame,
	cols: number,
	rows: number,
	options: { readonly excludePlacementIds?: ReadonlySet<string>; readonly preserveGraphics?: boolean } = {},
): ComposedHostFrame {
	const layer = frame.graphics;
	if (!layer) return frame;
	try {
		const lines = [...frame.lines];
		const fallbacks = fallbackPlacements(layer.frame);
		for (const placement of fallbacks) {
			if (options.excludePlacementIds?.has(placement.id)) continue;
			const clipped = clipFallback(layer, placement, cols, rows);
			if (!clipped) continue;
			const dimensions = validPixel(placement.widthPx) && validPixel(placement.heightPx)
				? { widthPx: placement.widthPx, heightPx: placement.heightPx }
				: undefined;
			const safeFallback = safeText(imageFallback(placement.mimeType, dimensions));
			const clippedText = sliceByColumn(safeFallback, 0, clipped.columns, true);
			const textWidth = Math.min(clipped.columns, Math.max(0, visibleWidth(clippedText)));
			const fill = clippedText + " ".repeat(clipped.columns - textWidth);
			const line = lines[clipped.row] ?? "";
			const prefix = sliceByColumn(line, 0, clipped.column, true);
			const suffixWidth = Math.max(0, cols - clipped.column - clipped.columns);
			const suffix = sliceByColumn(line, clipped.column + clipped.columns, suffixWidth, true);
			lines[clipped.row] = `${prefix}\x1b[0m${fill}\x1b[0m${suffix}`;
		}
		if (options.preserveGraphics) return { ...frame, lines };
		const { graphics: _graphics, ...withoutGraphics } = frame;
		void _graphics;
		return { ...withoutGraphics, lines };
	} catch {
		// Malformed foreign metadata must never turn a valid text frame into a
		// host failure; mixed rendering may retain its separately validated layer.
		if (options.preserveGraphics) return { ...frame, lines: [...frame.lines] };
		const { graphics: _graphics, ...withoutGraphics } = frame;
		void _graphics;
		return { ...withoutGraphics, lines: [...frame.lines] };
	}
}

function fallbackPlacements(frame: TerminalGraphicsFrame): FallbackPlacement[] {
	if (!Array.isArray(frame?.fallbacks) || frame.fallbacks.length > 256) return [];
	const placements: FallbackPlacement[] = [];
	for (const item of frame.fallbacks) {
		if (!validFallback(item)) continue;
		placements.push(item);
	}
	// A fallback-only frame from an older producer can still use captured
	// placement anchors. Dimensions remain unknown rather than being inferred.
	if (placements.length === 0 && Array.isArray(frame?.placements) && frame.placements.length <= 256) {
		for (const item of frame.placements) {
			if (!validPlacement(item)) continue;
			placements.push({
				id: item.id,
				mimeType: "image/png",
				column: item.column,
				row: item.row,
				columns: item.columns,
				rows: item.rows,
				clip: item.clip,
			});
		}
	}
	return placements;
}

function validFallback(value: TerminalGraphicsFallback): value is TerminalGraphicsFallback {
	return typeof value === "object" && value !== null
		&& validId(value.id)
		&& value.mimeType === "image/png"
		&& validCell(value.column) && validCell(value.row)
		&& validCell(value.columns) && value.columns > 0
		&& validCell(value.rows) && value.rows > 0
		&& validClip(value.clip)
		&& (value.widthPx === undefined || validPixel(value.widthPx))
		&& (value.heightPx === undefined || validPixel(value.heightPx));
}

function validPlacement(value: TerminalGraphicsPlacement): boolean {
	return typeof value === "object" && value !== null
		&& validId(value.id)
		&& validCell(value.column) && validCell(value.row)
		&& validCell(value.columns) && value.columns > 0
		&& validCell(value.rows) && value.rows > 0
		&& validClip(value.clip);
}

function validClip(value: FallbackPlacement["clip"]): boolean {
	return typeof value === "object" && value !== null
		&& validNonNegativeCell(value.leftColumns) && validNonNegativeCell(value.topRows)
		&& validNonNegativeCell(value.rightColumns) && validNonNegativeCell(value.bottomRows);
}

function validId(value: string): boolean {
	return typeof value === "string" && value.length > 0 && value.length <= 128
		&& !/[\x00-\x1f\x7f-\x9f]/.test(value);
}

function validCell(value: number): boolean {
	return Number.isSafeInteger(value) && Math.abs(value) <= 1000;
}

function validNonNegativeCell(value: number): boolean {
	return Number.isSafeInteger(value) && value >= 0 && value <= 1000;
}

function validPixel(value: number | undefined): value is number {
	return value !== undefined && Number.isSafeInteger(value) && value > 0 && value <= 8192;
}

function clipFallback(
	layer: HostGraphicsLayer,
	placement: FallbackPlacement,
	cols: number,
	rows: number,
): { readonly column: number; readonly row: number; readonly columns: number } | undefined {
	const pane = layer.pane;
	if (!validCell(pane.column) || !validCell(pane.row)
		|| !validCell(pane.cols) || pane.cols < 1 || !validCell(pane.rows) || pane.rows < 1
		|| !Number.isSafeInteger(cols) || !Number.isSafeInteger(rows)
		|| pane.column + pane.cols > cols || pane.row + pane.rows > rows) return undefined;
	const originalLeft = placement.column + placement.clip.leftColumns;
	const originalTop = placement.row + placement.clip.topRows;
	const originalRight = placement.column + placement.columns - placement.clip.rightColumns;
	const originalBottom = placement.row + placement.rows - placement.clip.bottomRows;
	const left = Math.max(0, originalLeft);
	const top = Math.max(0, originalTop);
	const right = Math.min(pane.cols, originalRight);
	const bottom = Math.min(pane.rows, originalBottom);
	if (left >= right || top >= bottom) return undefined;
	const column = pane.column + left;
	const row = pane.row + top;
	const visibleColumns = right - left;
	if (column < 0 || row < 0 || column >= cols || row >= rows || visibleColumns < 1) return undefined;
	return { column, row, columns: Math.min(visibleColumns, cols - column) };
}

function safeText(value: string): string {
	let result = "";
	for (const character of value) {
		const code = character.codePointAt(0) ?? 0;
		if (code < 0x20 || (code >= 0x7f && code <= 0x9f) || code === 0x2028 || code === 0x2029) continue;
		result += character;
	}
	return result;
}
