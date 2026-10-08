import { sliceByColumn, visibleWidth } from "pi-session-host-tui";
import type { TerminalFrame } from "./terminal-surface";

const MAX_DIMENSION = 1000;
const SIDEBAR_WIDTH = 32;
const DIVIDER_WIDTH = 1;
const MIN_NATIVE_WIDTH = 20;
const SGR_RESET = "\x1b[0m";
const EMPTY_HOST_MESSAGE = "Welcome — select a session";

export type HostFocus = "main" | "sidebar" | "form" | "confirm";

export interface HostPaneRect {
	readonly column: number;
	readonly row: number;
	readonly cols: number;
	readonly rows: number;
}

/** Pure, outer-terminal geometry for the session-host frame. */
export interface HostLayout {
	readonly cols: number;
	readonly rows: number;
	readonly headerRows: number;
	readonly native: HostPaneRect;
	readonly sidebar?: HostPaneRect;
	readonly dividerColumn?: number;
	/**
	 * Present only while the New session form temporarily replaces the native
	 * pane in the wide (non-overlay) layout. It mirrors the native rect so the
	 * underlying child keeps its geometry underneath.
	 */
	readonly form?: HostPaneRect;
	readonly sidebarOverlay: boolean;
}

/** Structural result of a sidebar renderer; no sidebar implementation is required here. */
export interface RenderedSidebar {
	readonly lines: string[];
	readonly cursor?: { readonly column: number; readonly row: number };
}

export interface ComposeHostFrameOptions {
	readonly main?: TerminalFrame;
	readonly sidebar?: RenderedSidebar;
	/** New session form pane; composed into layout.form when present. */
	readonly form?: RenderedSidebar;
	/** Canonical title only, without status/prefix badges; control sequences are never trusted. */
	readonly header: string;
	readonly focus: HostFocus;
}

export interface ComposedHostFrame {
	readonly lines: string[];
	readonly cursor: { readonly column: number; readonly row: number; readonly visible: boolean };
}

/**
 * Compute the responsive frame without changing the ownership or dimensions
 * of either pane. Narrow sidebars are display overlays only.
 */
export function computeHostLayout(
	cols: number,
	rows: number,
	options: { readonly sidebarVisible: boolean; readonly focus: HostFocus },
): HostLayout {
	validateDimension(cols, "cols");
	validateDimension(rows, "rows");

	const headerRows = rows >= 2 ? 1 : 0;
	const contentRows = Math.max(1, rows - headerRows);
	const sidebarOverlay = options.sidebarVisible && cols < SIDEBAR_WIDTH + DIVIDER_WIDTH + MIN_NATIVE_WIDTH;
	const native: HostPaneRect = {
		column: sidebarOverlay || !options.sidebarVisible ? 0 : SIDEBAR_WIDTH + DIVIDER_WIDTH,
		row: headerRows,
		cols: sidebarOverlay || !options.sidebarVisible ? cols : cols - SIDEBAR_WIDTH - DIVIDER_WIDTH,
		rows: contentRows,
	};

	const layout: {
		cols: number;
		rows: number;
		headerRows: number;
		native: HostPaneRect;
		sidebar?: HostPaneRect;
		dividerColumn?: number;
		form?: HostPaneRect;
		sidebarOverlay: boolean;
	} = { cols, rows, headerRows, native, sidebarOverlay };

	if (options.sidebarVisible) {
		if (sidebarOverlay) {
			// Keep the native pane's full-width geometry stable. The overlay is
			// present only while a non-main owner is focused.
			if (options.focus !== "main") {
				layout.sidebar = { column: 0, row: headerRows, cols, rows: contentRows };
			}
		} else {
			layout.sidebar = { column: 0, row: headerRows, cols: SIDEBAR_WIDTH, rows: contentRows };
			layout.dividerColumn = SIDEBAR_WIDTH;
			if (options.focus === "form") {
				// The form temporarily replaces the native pane; the roster stays
				// in the left sidebar and the native child keeps its geometry.
				layout.form = { ...native };
			}
		}
	}

	return layout;
}

/**
 * Compose bounded, control-safe text from already-rendered panes. Only
 * generated SGR is allowed through pane rows; header content is text-only.
 */
export function composeHostFrame(layout: HostLayout, options: ComposeHostFrameOptions): ComposedHostFrame {
	validateDimension(layout.cols, "cols");
	validateDimension(layout.rows, "rows");

	const lines = Array.from({ length: layout.rows }, () => "");
	if (layout.headerRows > 0) {
		lines[0] = fitText(sanitizeControls(options.header, false), layout.cols);
	}

	const mainMissing = options.main === undefined;
	const fallbackInSidebar = mainMissing
		&& options.sidebar === undefined
		&& layout.sidebarOverlay
		&& layout.sidebar !== undefined;
	const mainLines = options.main
		? options.main.lines.slice(0, Number.isSafeInteger(options.main.rows) && options.main.rows > 0 ? options.main.rows : 0)
		: [EMPTY_HOST_MESSAGE];
	const sidebarLines = options.sidebar?.lines ?? (fallbackInSidebar ? [EMPTY_HOST_MESSAGE] : []);
	const formLines = options.form?.lines ?? [];

	for (let row = 0; row < layout.native.rows; row += 1) {
		const outerRow = layout.native.row + row;
		if (outerRow < 0 || outerRow >= layout.rows) continue;

		if (layout.sidebarOverlay && layout.sidebar !== undefined && options.focus !== "main") {
			lines[outerRow] = panelRow(sidebarLines[row], layout.sidebar.cols);
			continue;
		}

		if (layout.dividerColumn !== undefined && layout.sidebar !== undefined) {
			const sidebarRow = panelRow(sidebarLines[row], layout.sidebar.cols);
			const divider = `${SGR_RESET}│${SGR_RESET}`;
			// While the form is open it temporarily replaces the native pane;
			// the child frame stays composed only after the form closes.
			const rightLines = layout.form !== undefined ? formLines : mainLines;
			const nativeRow = panelRow(rightLines[row], layout.native.cols);
			lines[outerRow] = `${sidebarRow}${divider}${nativeRow}`;
			continue;
		}

		lines[outerRow] = panelRow(mainLines[row], layout.native.cols);
	}

	// Geometry produced by computeHostLayout covers every output column and
	// row. Keep even malformed externally supplied layouts bounded at output.
	for (let row = 0; row < lines.length; row += 1) {
		if (visibleWidth(lines[row]) > layout.cols) {
			lines[row] = `${sliceByColumn(lines[row], 0, layout.cols, true)}${SGR_RESET}`;
		}
		if (visibleWidth(lines[row]) < layout.cols) {
			lines[row] += " ".repeat(layout.cols - visibleWidth(lines[row]));
		}
	}

	const cursor = hiddenCursor();
	if (options.focus === "main" && options.main) {
		const mainCursor = cursorInFrame(options.main, layout.native);
		if (mainCursor) {
			return { lines, cursor: {
				column: layout.native.column + mainCursor.column,
				row: layout.native.row + mainCursor.row,
				visible: true,
			} };
		}
	}

	if (options.focus === "form" && layout.form !== undefined && options.form?.cursor) {
		const formCursor = cursorInRect(options.form.cursor, layout.form);
		if (formCursor) {
			return { lines, cursor: {
				column: layout.form.column + formCursor.column,
				row: layout.form.row + formCursor.row,
				visible: true,
			} };
		}
	}

	if (options.focus !== "main" && layout.sidebar && options.sidebar?.cursor) {
		const sidebarCursor = cursorInRect(options.sidebar.cursor, layout.sidebar);
		if (sidebarCursor) {
			return { lines, cursor: {
				column: layout.sidebar.column + sidebarCursor.column,
				row: layout.sidebar.row + sidebarCursor.row,
				visible: true,
			} };
		}
	}

	return { lines, cursor };
}

function validateDimension(value: number, label: "cols" | "rows"): void {
	if (!Number.isSafeInteger(value) || value < 1 || value > MAX_DIMENSION) {
		throw new Error(`Host compositor ${label} must be a safe integer between 1 and ${MAX_DIMENSION}`);
	}
}

function panelRow(source: string | undefined, width: number): string {
	const safe = sanitizeControls(typeof source === "string" ? source : "", true);
	return `${SGR_RESET}${fitText(safe, width)}${SGR_RESET}`;
}

/** Clip on grapheme/cell boundaries with the same pinned TUI width model. */
function fitText(source: string, width: number): string {
	if (width <= 0) return "";
	let clipped = sliceByColumn(source, 0, width, true);
	let used = visibleWidth(clipped);
	// Keep the output bounded even if the pinned helper encounters an
	// unsupported sequence or grapheme width; the retry uses the same
	// grapheme-aware helper and preserves the permitted SGR styling.
	if (used > width) {
		clipped = sliceByColumn(clipped, 0, width, true);
		used = visibleWidth(clipped);
	}
	if (used > width) {
		clipped = "";
		used = 0;
	}
	return clipped + " ".repeat(width - used);
}

/**
 * Remove terminal controls. Panel rows retain only the exact generated SGR
 * grammar; headers retain no escape sequences at all.
 */
function sanitizeControls(source: string, allowSgr: boolean): string {
	let result = "";
	let index = 0;
	while (index < source.length) {
		const code = source.codePointAt(index) ?? 0;
		const length = code > 0xffff ? 2 : 1;

		if (code === 0x1b) {
			const next = source.charCodeAt(index + 1);
			if (next === 0x5b) {
				if (allowSgr) {
					const sgr = /^\x1b\[[0-9;]*m/.exec(source.slice(index));
					if (sgr) {
						result += sgr[0];
						index += sgr[0].length;
						continue;
					}
				}
				index = consumeCsi(source, index + 2);
				continue;
			}
			if (next === 0x5d || next === 0x50 || next === 0x5e || next === 0x5f || next === 0x58) {
				index = consumeStringControl(source, index + 2, next === 0x5d);
				continue;
			}
			// Discard only the unrecognized ESC. Processing its follower on the
			// next iteration preserves supplementary Unicode code points intact.
			index += 1;
			continue;
		}

		if (code === 0x9b) {
			index = consumeCsi(source, index + length);
			continue;
		}
		if (code === 0x9d || code === 0x90 || code === 0x98 || code === 0x9e || code === 0x9f) {
			index = consumeStringControl(source, index + length, code === 0x9d);
			continue;
		}
		// Ill-formed UTF-16 surrogates become replacement characters when
		// encoded for a terminal; drop them so width accounting stays truthful.
		if ((code >= 0xd800 && code <= 0xdfff) || isControl(code) || code === 0x2028 || code === 0x2029) {
			index += length;
			continue;
		}

		result += source.slice(index, index + length);
		index += length;
	}
	return result;
}

function consumeCsi(source: string, start: number): number {
	let index = start;
	while (index < source.length) {
		const code = source.codePointAt(index) ?? 0;
		index += code > 0xffff ? 2 : 1;
		if (code >= 0x40 && code <= 0x7e) return index;
	}
	return source.length;
}

function consumeStringControl(source: string, start: number, bellTerminates: boolean): number {
	let index = start;
	while (index < source.length) {
		const code = source.codePointAt(index) ?? 0;
		if ((bellTerminates && code === 0x07) || code === 0x9c) {
			return index + (code > 0xffff ? 2 : 1);
		}
		if (code === 0x1b && source[index + 1] === "\\") return index + 2;
		index += code > 0xffff ? 2 : 1;
	}
	return source.length;
}

function isControl(code: number): boolean {
	return code < 0x20 || code === 0x7f || (code >= 0x80 && code <= 0x9f);
}

function cursorInFrame(frame: TerminalFrame, rect: HostPaneRect): { column: number; row: number } | undefined {
	// A resized or otherwise stale frame may still be clipped and padded for
	// display, but its cursor coordinates are not trusted for the new geometry.
	if (frame.cols !== rect.cols || frame.rows !== rect.rows || !frame.cursor?.visible) return undefined;
	return cursorInRect(frame.cursor, rect, true);
}

function cursorInRect(
	cursor: { readonly column: number; readonly row: number },
	rect: HostPaneRect,
	allowWrapPending = false,
): { column: number; row: number } | undefined {
	const { column, row } = cursor;
	if (!Number.isSafeInteger(column) || !Number.isSafeInteger(row) || row < 0 || row >= rect.rows) {
		return undefined;
	}
	const maxColumn = allowWrapPending ? rect.cols : rect.cols - 1;
	if (column < 0 || column > maxColumn) return undefined;
	return { column: Math.min(column, rect.cols - 1), row };
}

function hiddenCursor(): { column: number; row: number; visible: false } {
	return { column: 0, row: 0, visible: false };
}
