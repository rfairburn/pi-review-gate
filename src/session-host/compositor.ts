import { sliceByColumn, visibleWidth } from "pi-session-host-tui";
import type { HostGraphicsLayer } from "./graphics-output";
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
	/** Optional host-owned notification band; never native child content. */
	readonly banner?: HostPaneRect;
	readonly native: HostPaneRect;
	readonly sidebar?: HostPaneRect;
	readonly dividerColumn?: number;
	/**
	 * Present while a host form/picker or explicitly placed Saved-delete
	 * confirmation replaces the native pane in the wide layout. It mirrors the
	 * native rect; its presence does not imply that the native child changed
	 * geometry or that this pane owns input focus.
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
	/** Bounded notification rows in layout.banner; this never changes focus. */
	readonly banner?: RenderedSidebar;
	/** Host form/picker or explicitly placed Saved-delete confirmation for layout.form. */
	readonly form?: RenderedSidebar;
	/** Typed graphics from the actual live native owner; never child escape bytes. */
	readonly nativeGraphics?: HostGraphicsLayer;
	/** Canonical title only, without status/prefix badges; control sequences are never trusted. */
	readonly header: string;
	/**
	 * Optional host-owned notice (for example the clearable terminal
	 * diagnostics warning). It is drawn right-aligned on the header row and
	 * keeps priority over the title, which is clipped first. Text-only.
	 */
	readonly headerNotice?: string;
	readonly focus: HostFocus;
}

export interface ComposedHostFrame {
	readonly lines: string[];
	readonly cursor: { readonly column: number; readonly row: number; readonly visible: boolean };
	/** Present only when the corresponding live native pane is actually visible. */
	readonly graphics?: HostGraphicsLayer;
}

/**
 * Compute the responsive frame without changing the ownership or dimensions
 * of either pane. Narrow sidebars are display overlays only.
 */
export function computeHostLayout(
	cols: number,
	rows: number,
	options: {
		readonly sidebarVisible: boolean;
		readonly focus: HostFocus;
		/** Display-only placement; focus remains `confirm` and input stays host-owned. */
		readonly savedDeleteConfirmation?: boolean;
		/** Explicit security-sensitive host confirmation, such as peer consent. */
		readonly hostConfirmation?: boolean;
		/** Reserve visible notification space without taking the child's input focus. */
		readonly bannerRows?: number;
	},
): HostLayout {
	validateDimension(cols, "cols");
	validateDimension(rows, "rows");

	const titleRows = rows >= 2 ? 1 : 0;
	const requestedBannerRows = options.bannerRows ?? 0;
	if (!Number.isSafeInteger(requestedBannerRows) || requestedBannerRows < 0) {
		throw new Error("Host banner rows must be a nonnegative safe integer");
	}
	const bannerRows = Math.min(requestedBannerRows, Math.max(0, rows - titleRows - 1));
	const headerRows = titleRows + bannerRows;
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
		banner?: HostPaneRect;
		native: HostPaneRect;
		sidebar?: HostPaneRect;
		dividerColumn?: number;
		form?: HostPaneRect;
		sidebarOverlay: boolean;
	} = { cols, rows, headerRows, native, sidebarOverlay };
	if (bannerRows > 0) layout.banner = { column: 0, row: titleRows, cols, rows: bannerRows };

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
			if (options.focus === "form"
				|| (options.focus === "confirm" && (options.savedDeleteConfirmation === true || options.hostConfirmation === true))) {
				// Forms and only an explicitly selected host confirmation
				// replace the native pane; the roster stays left and the child keeps
				// its geometry. Placement never changes the actual focused owner.
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
		lines[0] = headerRow(options.header, options.headerNotice, layout.cols);
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
			// While a form or explicitly placed Saved-delete warning is open it
			// temporarily replaces the native pane; the child frame stays composed
			// only after that host-owned pane closes.
			const rightLines = layout.form !== undefined ? formLines : mainLines;
			const nativeRow = panelRow(rightLines[row], layout.native.cols);
			lines[outerRow] = `${sidebarRow}${divider}${nativeRow}`;
			continue;
		}

		lines[outerRow] = panelRow(mainLines[row], layout.native.cols);
	}

	if (layout.banner !== undefined) {
		for (let row = 0; row < layout.banner.rows; row += 1) {
			const outerRow = layout.banner.row + row;
			if (outerRow < 0 || outerRow >= layout.rows) continue;
			lines[outerRow] = panelRow(options.banner?.lines[row], layout.banner.cols);
		}
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

	let cursor: ComposedHostFrame["cursor"] = hiddenCursor();
	if (options.focus === "main" && options.main) {
		const mainCursor = cursorInFrame(options.main, layout.native);
		if (mainCursor) {
			cursor = {
				column: layout.native.column + mainCursor.column,
				row: layout.native.row + mainCursor.row,
				visible: true,
			};
		}
	} else if (options.focus === "form" && layout.form !== undefined && options.form?.cursor) {
		const formCursor = cursorInRect(options.form.cursor, layout.form);
		if (formCursor) {
			cursor = {
				column: layout.form.column + formCursor.column,
				row: layout.form.row + formCursor.row,
				visible: true,
			};
		}
	} else if (options.focus !== "main" && layout.sidebar && options.sidebar?.cursor) {
		const sidebarCursor = cursorInRect(options.sidebar.cursor, layout.sidebar);
		if (sidebarCursor) {
			cursor = {
				column: layout.sidebar.column + sidebarCursor.column,
				row: layout.sidebar.row + sidebarCursor.row,
				visible: true,
			};
		}
	}

	const graphics = options.nativeGraphics !== undefined
		&& options.main !== undefined
		&& drawnContentMatchesLayer(options.main, options.nativeGraphics.pane, layout.native)
		&& layout.form === undefined
		&& !(layout.sidebarOverlay && layout.sidebar !== undefined && options.focus !== "main")
		? options.nativeGraphics
		: undefined;
	return { lines, cursor, ...(graphics ? { graphics } : {}) };
}

/**
 * A graphics layer is projected only into the rectangle its own frame actually
 * filled. A session smaller than the native pane (#474) is drawn at the pane's
 * top-left corner and padded, so that content rectangle — not the whole pane —
 * bounds the layer, its images, and their fallback text. A layer claiming more
 * than the frame drew, a frame larger than the pane (which composition clips),
 * or malformed bounds keeps no image owner.
 */
function drawnContentMatchesLayer(main: TerminalFrame, layer: HostPaneRect, native: HostPaneRect): boolean {
	const drawn = drawnContentRect(main, native);
	return drawn !== undefined
		&& layer.column === native.column && layer.row === native.row
		&& layer.cols === drawn.cols && layer.rows === drawn.rows;
}

/**
 * The one rectangle a native frame actually drew inside the native pane: the
 * pane itself when the frame fills it, otherwise the frame's own drawn size at
 * the pane's top-left corner, whose remaining cells stay host-owned padding
 * (#474). The cursor and any image layer are both bounded by this same fact;
 * it is never a second copy of the child's size. A frame larger than the pane
 * (composition clips it) or malformed dimensions describe no trustworthy
 * drawn geometry and return undefined.
 */
function drawnContentRect(
	frame: { readonly cols: number; readonly rows: number },
	native: HostPaneRect,
): HostPaneRect | undefined {
	if (!Number.isSafeInteger(frame.cols) || !Number.isSafeInteger(frame.rows)) return undefined;
	if (frame.cols < 1 || frame.rows < 1) return undefined;
	if (frame.cols > native.cols || frame.rows > native.rows) return undefined;
	if (frame.cols === native.cols && frame.rows === native.rows) return native;
	return { column: native.column, row: native.row, cols: frame.cols, rows: frame.rows };
}

function validateDimension(value: number, label: "cols" | "rows"): void {
	if (!Number.isSafeInteger(value) || value < 1 || value > MAX_DIMENSION) {
		throw new Error(`Host compositor ${label} must be a safe integer between 1 and ${MAX_DIMENSION}`);
	}
}

const HEADER_NOTICE_SEPARATOR = " | ";

/** Title clipped first so a host notice stays visible; both are text-only. */
function headerRow(header: string, notice: string | undefined, cols: number): string {
	const title = sanitizeControls(typeof header === "string" ? header : "", false);
	const safeNotice = typeof notice === "string" ? sanitizeControls(notice, false) : "";
	if (safeNotice.length === 0) return fitText(title, cols);
	const noticeWidth = visibleWidth(safeNotice);
	const titleRoom = cols - noticeWidth - visibleWidth(HEADER_NOTICE_SEPARATOR);
	if (titleRoom < 1) return fitText(safeNotice, cols);
	return fitText(`${fitText(title, titleRoom)}${HEADER_NOTICE_SEPARATOR}${safeNotice}`, cols);
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
	// The cursor is projected from the rectangle this frame actually drew, so a
	// session smaller than the pane keeps its native cursor at its real position
	// instead of being hidden by the pane's padding (#553). A frame larger than
	// the pane, malformed dimensions, or an explicitly hidden cursor project
	// nothing; the frame's own drawn width still carries the wrap-pending cell.
	if (!frame.cursor?.visible) return undefined;
	const drawn = drawnContentRect(frame, rect);
	if (drawn === undefined) return undefined;
	return cursorInRect(frame.cursor, drawn, true);
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
