/**
 * Pinned virtual terminal surface for optional per-instance custom terminal
 * sidebars (#323 alpha).
 *
 * Wraps a real @xterm/headless Terminal (pinned 6.0.0) plus the
 * @xterm/addon-unicode11 addon (pinned 0.9.0, same upstream commit as the
 * headless core: f447274f430fd22513f6adbf9862d19524471c04) so raw child PTY
 * output parses into bounded, sanitized snapshot frames. Boundaries:
 *
 * - No raw child escape sequences are ever forwarded to a real terminal.
 *   Frame lines are serializations of the snapshot: sanitized cell text plus
 *   only generated, allowlisted SGR sequences. Each row independently
 *   establishes default attribute state at its start and closes with an
 *   explicit reset at its boundary, so compositor/real-tty styling never
 *   bleeds through, while native cumulative styling is preserved within a
 *   row because every run is reconstructed from its cells. Any ESC byte
 *   inside a frame line comes from this serializer, never from the child.
 * - Query replies (headless built-in DA/DSR surfaced via onData, plus the
 *   bounded Kitty keyboard protocol handlers implemented here) go only to
 *   this instance's `onReply` owner; surfaces are per-instance isolated.
 * - Kitty keyboard protocol progressive enhancement
 *   (sw.kovidgoyal.net/kitty/keyboard-protocol/): enhancement flags have
 *   FIVE defined bits (1, 2, 4, 8, 16). This surface advertises at most
 *   flags 7 (bits 1+2+4: disambiguate escape codes, report event types,
 *   report alternate keys); bits 8 (all keys) and 16 (associated text) are
 *   not advertised.
 *   State is per screen mode independent for the normal and alternate
 *   buffers, exactly as the protocol requires; the stack of pushed states is
 *   bounded (cap 32 per buffer, newest push retained via FIFO eviction) and
 *   whenever pops empty the stack, ALL flags reset to zero, per protocol.
 * - Window operations (CSI t), OSC 52 clipboard writes, and title setting
 *   are swallowed (default deny). The only clipboard route is the host-owned
 *   native capsule OSC (`NATIVE_CLIPBOARD_OSC`, #466): its opaque payload is
 *   handed verbatim to `onNativeClipboardCapsule` and is never rendered,
 *   logged, forwarded, or turned into a clipboard action by this class — the
 *   owner's authenticated receiver decides. Unrelated OSC numbers keep the
 *   parser's default deny. A narrow native Kitty PNG subset is split
 *   before VT parsing, validated, and exposed only as typed image/placement
 *   and native-style fallback metadata; there is no renderer or host notice,
 *   and unsupported graphics commands are swallowed rather than forwarded.
 * - The Kitty keyboard handling uses typed parser hooks
 *   (parser.registerCsiHandler) because xterm 6 core has no kittyKeyboard
 *   support and no onRender callback. Snapshot invalidation happens only
 *   through the post-parse path (onWriteParsed / per-write parse callbacks),
 *   never synchronously inside write(), never inside parser hooks, and never
 *   on raw buffer-switch events; notification keys include the input-mode
 *   state so mode-only changes (bracketed paste, cursor keys/keypad, mouse
 *   tracking/encoding, modifyOtherKeys, kitty flags) notify the host after
 *   the parse completes.
 * - Native synchronized output (`CSI ? 2026 h` ... `CSI ? 2026 l`) is
 *   recognized only through the same typed parser hooks, so it follows the
 *   pinned parser exactly (string payloads, split Kitty APCs, and invalid or
 *   intermediate-bearing CSI never toggle it). While a frame is open,
 *   `frame()` and change notifications expose only the complete state
 *   captured at the frame's start; the frame's text, cursor, and graphics
 *   are published together when it ends. Alternate-buffer Kitty placements
 *   made inside the frame keep their exact event-time position/crop but are
 *   anchored against the completed frame's covered rows, and older anchors
 *   are validated (never re-anchored) against it. Destructive controls and
 *   scoped deletes still apply in order; their result simply becomes visible
 *   at commit. Holding is bounded (1 s, 8 MiB, 8192 child chunks); exceeding
 *   a bound or DECSTR ends the hold early and the rest is processed as
 *   unframed output, while resize, buffer switches, RIS, parse failure, and
 *   disposal drop the hold and discard not-yet-anchored placements. Image and
 *   placement leases referenced by a held snapshot stay charged to the shared
 *   graphics budget until the snapshot is released. Keyboard modes are always
 *   live; mouse reporting is withheld (`none`) from `inputModes()` while any
 *   frame is held (outer capture instead follows `requestedMouseReporting()`,
 *   the committed frame's request, so it stays stable mid-frame), and
 *   colon sub-parameter forms of 2026 are not frame markers. Facts published
 *   alongside a frame come from `publishedInputModes()`, which pairs the last
 *   complete committed frame with its own modes instead of exporting that
 *   temporary withholding; `redrawState()` plus `onRedrawSettled()` let an owner
 *   hold input until a redraw ends, including one that changes nothing visible.
 *   A pipeline that failed a parse reports `"unavailable"`, which is not
 *   `"clear"`: work waiting on it is cancelled, never written.
 *   A pipeline that failed a parse reports `redrawState() === "unavailable"`,
 *   which is not `"clear"`: work waiting on it is cancelled, never written.
 * - xterm's logger diagnostics never reach the host console (#428). Each
 *   surface hands xterm a private `ILogger` (see terminal-diagnostics.ts)
 *   instead of the default `console`, so a malformed child sequence such as
 *   an unterminated CSI followed by a non-ASCII character cannot paint
 *   `xterm.js: Parsing error` text onto the real terminal outside the
 *   composed frame. The log level and parser recovery are unchanged; bounded
 *   structured records reach the owner through `onDiagnostic` after the
 *   parse step, never inside a parser callback and never after disposal.
 * - Queued write data is bounded in UTF-8 bytes (not UTF-16 code units) and
 *   in queued-write count; overruns fail explicitly rather than silently
 *   truncating, and empty writes are no-ops so they cannot enqueue unbounded
 *   zero-byte parse promises. No kernel or child-process memory bound is
 *   claimed by this class beyond its own queue budget.
 *
 * This class performs no host UI: the future sidebar host phase owns frame
 * positioning, sidebar/footer composition, the real TTY cursor, the outer
 * `pi-session-host-tui` (npm-aliased @earendil-works/pi-tui) public
 * ProcessTerminal input path (raw chunk/paste/Kitty negotiation/restoration
 * plus matchesKey/parseKey), and the lazy @lydell/node-pty native process
 * plumbing. This module stays pure JS: no native addon imports, no root or
 * index imports, and no keyboard-parser invention — once the host pops the
 * outer process's negotiated kitty mode it should translate enhanced outer
 * input to legacy forms for external editors; `inputModes()` exposes this
 * terminal's own VT state for that router.
 */

import { Buffer } from "node:buffer";
import { IDisposable, Terminal } from "@xterm/headless";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import {
	KittyGraphicsSplitter,
	KittyGraphicsState,
	TerminalGraphicsBudget,
	TerminalGraphicsFrame,
	TerminalGraphicsPosition,
	createTerminalGraphicsBudget,
} from "./kitty-graphics";
import { XtermDiagnosticCollector, type TerminalDiagnosticEvent } from "./terminal-diagnostics";
import { NATIVE_CLIPBOARD_OSC } from "./native-clipboard";

/** A cell color as recorded by headless: default, 256-palette index, or RGB. */
export interface TerminalColorSpec {
	/** Color mode of the recorded color. */
	readonly mode: "default" | "palette" | "rgb";
	/** Palette index (0-255) or packed 0xRRGGBB value; 0 when default. */
	readonly value: number;
}

/** A contiguous run of cells sharing one attribute bundle within a row. */
export interface TerminalCellRun {
	/** Inclusive start column (0-based) of the run within the viewport row. */
	readonly startColumn: number;
	/** Sanitized text of the run (continuation cells skipped). */
	readonly text: string;
	/** Foreground color; omitted when the default foreground. */
	readonly fg?: TerminalColorSpec;
	/** Background color; omitted when the default background. */
	readonly bg?: TerminalColorSpec;
	readonly bold?: boolean;
	readonly dim?: boolean;
	readonly italic?: boolean;
	readonly underline?: boolean;
	readonly inverse?: boolean;
	readonly blink?: boolean;
	readonly invisible?: boolean;
	readonly strikethrough?: boolean;
	readonly overline?: boolean;
}

/** One row's style runs; rows made only of default attributes are omitted. */
export interface TerminalLineStyles {
	/** Frame row index (0-based). */
	readonly line: number;
	readonly runs: readonly TerminalCellRun[];
}

/**
 * Immutable snapshot of the terminal's visible state. `lines` are full-width
 * serialized rows: sanitized cell text plus only generated, allowlisted SGR
 * sequences, with an explicit leading and trailing `\x1b[0m` per row so no
 * row inherits host styling or a previous row's attributes. The SGR in
 * `lines` is generated by this serializer, never forwarded child bytes;
 * compositors that do not want SGR can strip it with the documented pattern
 * (`/\x1b\[[0-9;]*m/g`) or consume the structured `styles` runs instead.
 */
export interface TerminalFrame {
	readonly cols: number;
	readonly rows: number;
	readonly lines: string[];
	/** 0-based hardware cursor position within the viewport frame. */
	readonly cursor: {
		readonly column: number;
		readonly row: number;
		readonly visible: boolean;
	};
	/** Structured style runs for rows containing non-default attributes. */
	readonly styles?: readonly TerminalLineStyles[];
	/** Validated Kitty PNG placements and payload-free fallback metadata visible in this buffer. */
	readonly graphics?: TerminalGraphicsFrame;
}

/**
 * The owning terminal's active input-protocol state for the future host input
 * router: effective Kitty keyboard flags, exact public xterm 6 modes, and
 * bounded observations of modifyOtherKeys and mouse encoding. This is this
 * terminal's own VT state (not worker/controller telemetry); the host uses it
 * to know when enhanced outer input must be translated to legacy form.
 */
export interface TerminalInputModes {
	/** Effective Kitty keyboard enhancement flags of the active buffer (max 7). */
	readonly kittyFlags: number;
	/** DECCKM (`CSI ?1 h`): xterm 6 `modes.applicationCursorKeysMode`. */
	readonly applicationCursorKeys: boolean;
	/** DECNKM: xterm 6 `modes.applicationKeypadMode` (ESC = / ESC >, ?66 h/l). */
	readonly applicationKeypad: boolean;
	/** `CSI ?2004 h`: xterm 6 `modes.bracketedPasteMode`. */
	readonly bracketedPaste: boolean;
	/** Mouse tracking mode: xterm 6 `modes.mouseTrackingMode`. */
	readonly mouseTracking: "none" | "x10" | "vt200" | "drag" | "any";
	/** Xterm modifyOtherKeys mode: 0 disabled, 1 or 2 as set by CSI >4;N m. */
	readonly modifyOtherKeys: 0 | 1 | 2;
	/** Mouse report encoding observed from DECSET/DECRST 1006 and 1016. */
	readonly mouseEncoding: "default" | "sgr" | "sgr-pixels";
}

/**
 * The child's requested mouse reporting, used only to configure the outer
 * terminal's mouse capture. It is never packet-forwarding authorization:
 * forwarding uses `inputModes()`, which withholds mouse reporting while a
 * synchronized frame is held. While a frame is held this reports the last
 * committed frame's request, so outer capture neither drops nor churns
 * mid-frame; changes made inside the frame apply when it ends.
 */
export interface TerminalMouseReportingRequest {
	readonly mouseTracking: TerminalInputModes["mouseTracking"];
	readonly mouseEncoding: TerminalInputModes["mouseEncoding"];
}

/**
 * What {@linkcode TerminalSurface.redrawState} reports about a synchronized
 * redraw: see that method.
 */
export type TerminalRedrawState = "clear" | "held" | "unavailable";

export interface TerminalSurfaceOptions {
	/** Called with replies this instance generates for its child (owner only). */
	readonly onReply?: (data: string) => void;
	/** Called after a parsed write changed the visible snapshot or input modes. */
	readonly onChange?: () => void;
	/** Called with the new pause state when the queued-data watermark crosses. */
	readonly onBackpressure?: (paused: boolean) => void;
	/**
	 * Kitty keyboard enhancement flags this surface's owner supports
	 * (protocol bits 1+2+4 = 7; valid range 0..7). Applied to push/set/query
	 * so unsupported flags are never advertised. A bad callback (throw,
	 * non-number, non-integer, out of 0..7) fails safe to 0. Default: 7 for
	 * the virtual input encoder; a future host returns its outer
	 * ProcessTerminal's actively negotiated flag mask (0..7).
	 */
	readonly getSupportedKeyboardFlags?: () => number;
	/**
	 * Called after a parse step with bounded xterm logger diagnostics (#428).
	 * xterm's logger never writes to the host console; its log-service output
	 * (all levels) arrives only here. A few xterm internals that call the
	 * console directly (listener-leak/disposal/option warnings) bypass any
	 * per-terminal logger and are outside this path.
	 */
	readonly onDiagnostic?: (event: TerminalDiagnosticEvent) => void;
	/**
	 * Called with the opaque payload of one parsed native clipboard capsule
	 * (#466) — the host-authenticated route by which Pi's own copy request can
	 * reach the outer terminal. This class never interprets, renders, logs,
	 * stores, or forwards the capsule: the owner's receiver authenticates it and
	 * decides. A bad callback (throw) is contained like every other peer
	 * callback; the payload stays out of frame text either way.
	 */
	readonly onNativeClipboardCapsule?: (capsule: string) => void;
	/** Optional budget shared by the host's surfaces; omitted means private. */
	readonly graphicsBudget?: TerminalGraphicsBudget;
	/** Bounded named scrollback lines (default 1000). */
	readonly scrollback?: number;
	/** Maximum bytes of not-yet-parsed queued write data (default 8 MiB). */
	readonly maxPendingBytes?: number;
}

interface PendingWrite {
	/** Queued UTF-8 byte size of the still-unparsed chunk. */
	readonly size: number;
	/** Raw child chunk, scanned incrementally before entering xterm. */
	readonly data: string;
	readonly done: Promise<void>;
	resolve: () => void;
}

/**
 * A held native synchronized-output frame (`CSI ? 2026 h` ... `CSI ? 2026 l`).
 * While held, `frame()` and change notifications expose only `committed`, the
 * complete state captured when the frame opened.
 */
interface SyncFrame {
	readonly committed: TerminalFrame;
	readonly committedRevision: number;
	readonly committedModes: TerminalInputModes;
	readonly timer: ReturnType<typeof setTimeout>;
	bytes: number;
	writes: number;
}

type GraphicsPreflightState =
	| "ground"
	| "escape"
	| "apc-start"
	| "kitty"
	| "kitty-escape"
	| "opaque-osc"
	| "opaque-string"
	| "opaque-osc-escape"
	| "opaque-string-escape";

/** Per-screen-mode Kitty keyboard state (independent normal vs alternate). */
interface KittyState {
	/** Current effective flags of this buffer's mode (already masked). */
	current: number;
	/** Bounded stack of states saved by pushes (newest retained at cap). */
	stack: number[];
}

interface CellAttributes {
	fg?: TerminalColorSpec;
	bg?: TerminalColorSpec;
	bold?: boolean;
	dim?: boolean;
	italic?: boolean;
	underline?: boolean;
	inverse?: boolean;
	blink?: boolean;
	invisible?: boolean;
	strikethrough?: boolean;
	overline?: boolean;
}

interface ReadableCell {
	getWidth(): number;
	getChars(): string;
	isFgDefault(): boolean;
	isFgPalette(): boolean;
	isFgRGB(): boolean;
	getFgColor(): number;
	isBgDefault(): boolean;
	isBgPalette(): boolean;
	isBgRGB(): boolean;
	getBgColor(): number;
	isBold(): number;
	isDim(): number;
	isItalic(): number;
	isUnderline(): number;
	isBlink(): number;
	isInverse(): number;
	isInvisible(): number;
	isStrikethrough(): number;
	isOverline(): number;
}

interface WritableRun {
	startColumn: number;
	text: string;
	attrsKey: string;
	attrs: CellAttributes;
}

// Bounded Kitty keyboard stack per screen mode: at most this many saved
// states, with the newest push retained (FIFO eviction of the oldest save)
// so the effective flags never go stale at capacity.
const KITTY_STACK_CAP = 32;
// Kitty progressive-enhancement flags define five bits (1, 2, 4, 8, 16).
// This surface supports/advertises at most 7 (bits 1+2+4); bit 16 is never
// accepted or advertised.
const KITTY_MAX_SUPPORTED_FLAGS = 7;
const HIGH_WATERMARK_BYTES = 1024 * 1024;
const LOW_WATERMARK_BYTES = 256 * 1024;
// Queued writes are also bounded by count: pause above the high watermark
// and hard-fail at this cap so tiny chunks cannot enqueue unbounded promises.
const MAX_QUEUED_WRITES = 4096;
// Keep each parse batch bounded while allowing xterm's WriteBuffer to coalesce
// adjacent text-only chunks into one event-loop cycle.
const MAX_TERMINAL_BATCH_WRITES = 64;
const MAX_TERMINAL_BATCH_BYTES = 256 * 1024;
const HIGH_WATERMARK_WRITES = 2048;
const LOW_WATERMARK_WRITES = 1024;
const MAX_DIMENSION = 1000;
// Bounds for holding one native synchronized-output frame. Exceeding any of
// them ends the hold early (fail-closed: the live state is published and the
// rest of that frame is processed exactly like unframed output).
const MAX_SYNC_FRAME_MS = 1000;
const MAX_SYNC_FRAME_BYTES = 8 * 1024 * 1024;
const MAX_SYNC_FRAME_WRITES = 8192;
const SYNCHRONIZED_OUTPUT_MODE = 2026;
const BUFFER_SWITCH_MODES = [47, 1047, 1049] as const;

const SGR_RESET = "\x1b[0m";
const SAFE_EMPTY_APC = "\x1b_G\x1b\\";
const GENERATED_SGR_PATTERN = /\x1b\[[0-9;]*m/g;

function validateDimension(value: number, label: "cols" | "rows"): void {
	if (!Number.isSafeInteger(value) || value < 1 || value > MAX_DIMENSION) {
		throw new Error(
			`TerminalSurface ${label} must be a safe integer between 1 and ${MAX_DIMENSION}, got ${value}`,
		);
	}
}

function validateScrollback(value: number): void {
	if (!Number.isSafeInteger(value) || value < 0 || value > 100_000) {
		throw new Error(
			`TerminalSurface scrollback must be a safe integer between 0 and 100000, got ${value}`,
		);
	}
}

function getParam(value: number | number[] | undefined): number | undefined {
	if (typeof value === "number") {
		return value;
	}
	if (Array.isArray(value) && typeof value[0] === "number") {
		return value[0];
	}
	return undefined;
}

function sanitizeText(chars: string): string {
	let result = "";
	for (const char of chars) {
		const code = char.codePointAt(0) ?? 0;
		// C0 controls, DEL, and C1 controls must never survive into frame
		// text: they would give the compositing host an escape-injection
		// channel through a rendered snapshot.
		if (code < 0x20 || code === 0x7f || (code >= 0x80 && code <= 0x9f)) {
			continue;
		}
		result += char;
	}
	return result;
}

function colorSpec(
	isDefault: boolean,
	isPalette: boolean,
	isRgb: boolean,
	color: number,
): TerminalColorSpec | undefined {
	if (isDefault) {
		return undefined;
	}
	if (isPalette) {
		return { mode: "palette", value: Math.min(Math.max(color, 0), 255) };
	}
	if (isRgb) {
		return { mode: "rgb", value: color & 0xffffff };
	}
	return { mode: "default", value: 0 };
}

function cellAttributes(cell: ReadableCell): CellAttributes {
	const attrs: CellAttributes = {};
	const fg = colorSpec(cell.isFgDefault(), cell.isFgPalette(), cell.isFgRGB(), cell.getFgColor());
	const bg = colorSpec(cell.isBgDefault(), cell.isBgPalette(), cell.isBgRGB(), cell.getBgColor());
	if (fg) {
		attrs.fg = fg;
	}
	if (bg) {
		attrs.bg = bg;
	}
	if (cell.isBold()) {
		attrs.bold = true;
	}
	if (cell.isDim()) {
		attrs.dim = true;
	}
	if (cell.isItalic()) {
		attrs.italic = true;
	}
	if (cell.isUnderline()) {
		attrs.underline = true;
	}
	if (cell.isBlink()) {
		attrs.blink = true;
	}
	if (cell.isInverse()) {
		attrs.inverse = true;
	}
	if (cell.isInvisible()) {
		attrs.invisible = true;
	}
	if (cell.isStrikethrough()) {
		attrs.strikethrough = true;
	}
	if (cell.isOverline()) {
		attrs.overline = true;
	}
	return attrs;
}

/** Generated color SGR params for a palette/RGB spec; default yields none. */
function colorParams(spec: TerminalColorSpec | undefined, foreground: boolean): string[] {
	if (!spec) {
		return [];
	}
	const base = foreground ? 30 : 40;
	if (spec.mode === "palette") {
		if (spec.value < 8) {
			return [String(base + spec.value)];
		}
		if (spec.value < 16) {
			return [String(base + 60 + (spec.value - 8))];
		}
		return [foreground ? "38" : "48", "5", String(spec.value)];
	}
	if (spec.mode === "rgb") {
		return [
			foreground ? "38" : "48",
			"2",
			String((spec.value >> 16) & 0xff),
			String((spec.value >> 8) & 0xff),
			String(spec.value & 0xff),
		];
	}
	// Default color mode (only reachable before an explicit reset).
	return [];
}

/**
 * Serialize one generated, allowlisted SGR sequence for a run's attributes.
 * Output is only `\x1b[<digits;...>m` built from the attribute allowlist.
 */
function generateSgr(attrs: CellAttributes): string {
	const params: string[] = [];
	if (attrs.bold) {
		params.push("1");
	}
	if (attrs.dim) {
		params.push("2");
	}
	if (attrs.italic) {
		params.push("3");
	}
	if (attrs.underline) {
		params.push("4");
	}
	if (attrs.blink) {
		params.push("5");
	}
	if (attrs.inverse) {
		params.push("7");
	}
	if (attrs.invisible) {
		params.push("8");
	}
	if (attrs.strikethrough) {
		params.push("9");
	}
	if (attrs.overline) {
		params.push("53");
	}
	params.push(...colorParams(attrs.fg, true));
	params.push(...colorParams(attrs.bg, false));
	if (params.length === 0) {
		return "";
	}
	return `\x1b[${params.join(";")}m`;
}

/** Strip serializer-generated SGR from a frame line (documented pattern). */
export function stripGeneratedSgr(line: string): string {
	return line.replace(GENERATED_SGR_PATTERN, "");
}

export class TerminalSurface {
	private readonly terminal: Terminal;
	private readonly disposables: IDisposable[] = [];
	private readonly pendingWrites: PendingWrite[] = [];
	private readonly kittyNormal: KittyState = { current: 0, stack: [] };
	private readonly kittyAlternate: KittyState = { current: 0, stack: [] };
	private readonly graphicsSplitter: KittyGraphicsSplitter;
	private readonly graphics: KittyGraphicsState;
	private readonly diagnostics: XtermDiagnosticCollector;
	private graphicsPreflightState: GraphicsPreflightState = "ground";
	private options: TerminalSurfaceOptions;
	private readonly maxPendingBytes: number;
	private readonly highWatermarkBytes: number;
	private readonly lowWatermarkBytes: number;

	private pendingBytes = 0;
	private pendingAlternateGraphicsInvalidation = false;
	private cursorVisible = true;
	private modifyOtherKeys: 0 | 1 | 2 = 0;
	private mouseEncoding: TerminalInputModes["mouseEncoding"] = "default";
	private paused = false;
	private disposed = false;
	private drainingWrites = false;
	private processingWrite = false;
	private activeTerminalWriteResolve?: () => void;
	private parseFailed = false;
	private lastInvalidateKey = "";
	private syncFrame?: SyncFrame;
	/** Observers of the end of a held synchronized frame (#500). */
	private readonly redrawObservers = new Set<() => void>();
	/**
	 * A held frame ended during a parse. The wake-up is latched here and drained
	 * only from a post-parse, post-observation point, never from inside a parser
	 * hook, so a mode change, RIS, or reset later in the same chunk is always
	 * observed before a waiter re-reads the surface.
	 */
	private redrawSettledPending = false;

	constructor(cols: number, rows: number, options: TerminalSurfaceOptions = {}) {
		validateDimension(cols, "cols");
		validateDimension(rows, "rows");
		const scrollback = options.scrollback ?? 1000;
		validateScrollback(scrollback);
		this.maxPendingBytes = options.maxPendingBytes ?? 8 * 1024 * 1024;
		if (!Number.isSafeInteger(this.maxPendingBytes) || this.maxPendingBytes <= 0) {
			throw new Error(
				`TerminalSurface maxPendingBytes must be a positive safe integer, got ${this.maxPendingBytes}`,
			);
		}
		// Byte watermarks shrink relative to a configured small budget so the
		// source pauses before the hard limit is reached.
		this.highWatermarkBytes = Math.min(HIGH_WATERMARK_BYTES, Math.floor(this.maxPendingBytes * 0.75));
		this.lowWatermarkBytes = Math.min(LOW_WATERMARK_BYTES, Math.floor(this.maxPendingBytes * 0.25));
		this.options = options;
		const graphicsBudget = options.graphicsBudget ?? createTerminalGraphicsBudget();
		this.graphics = new KittyGraphicsState(graphicsBudget);
		this.graphicsSplitter = new KittyGraphicsSplitter(graphicsBudget);
		// A per-surface logger replaces xterm's default console logger. The log
		// level stays at xterm's default; delivery is post-parse and contained.
		this.diagnostics = new XtermDiagnosticCollector({
			deliver: (event) => {
				if (!this.disposed) this.safePeerInvoke(() => this.options.onDiagnostic?.(event));
			},
			context: () => ({
				cols: this.terminal.cols,
				rows: this.terminal.rows,
				buffer: this.terminal.buffer.active.type === "alternate" ? "alternate" : "normal",
				synchronizedFrameHeld: this.syncFrame !== undefined,
			}),
		});
		this.terminal = new Terminal({
			cols,
			rows,
			scrollback,
			allowProposedApi: true,
			logger: this.diagnostics.logger,
		});
		const unicode11 = new Unicode11Addon();
		this.terminal.loadAddon(unicode11);
		this.terminal.unicode.activeVersion = "11";

		const noteAlternateGraphicsInvalidation = () => {
			if (this.terminal.buffer.active.type === "alternate") {
				this.pendingAlternateGraphicsInvalidation = true;
			}
		};
		this.attach(this.terminal.onScroll(noteAlternateGraphicsInvalidation));
		for (const final of ["J", "S", "T", "L", "M", "@", "P", "X"]) {
			this.attach(this.terminal.parser.registerCsiHandler({ final }, () => {
				noteAlternateGraphicsInvalidation();
				return false;
			}));
		}
		this.attach(this.terminal.parser.registerEscHandler({ final: "M" }, () => {
			noteAlternateGraphicsInvalidation();
			return false;
		}));

		// Headless-generated replies (built-in DA/DSR and friends) go to this
		// instance's owner via onData; never to any other surface.
		this.attach(this.terminal.onData((data) => {
			this.reply(data);
		}));

		// Snapshot invalidation happens only after the asynchronous parse —
		// not on write, not in parser hooks, and not on raw buffer-switch
		// events. xterm 6 has no onRender callback; onWriteParsed is the
		// sanctioned "everything queued so far has been parsed" signal, so
		// owner notifications never expose intermediate mid-chunk states.
		this.attach(this.terminal.onWriteParsed(() => {
			this.applyPendingAlternateGraphicsInvalidation();
			if (!this.processingWrite) {
				this.invalidate();
				// Readiness follows the SAME ownership rule as invalidation. While a
				// batch is in flight this parser callback fires before the awaiting
				// continuation publishes the observation, and a graphics-sensitive chunk
				// reaches it between its several `writeToTerminal` parts. Delivering from
				// here would expose a state whose rest of the chunk is unparsed, so the
				// whole-chunk completion path owns the delivery instead.
				this.settleRedrawObservation();
			}
		}));

		// Hardware cursor visibility tracking. Handlers scan all private-mode
		// parameters (combined sequences like CSI ?1;5;25 h/l are valid) and
		// return false so the native builtin parser also processes them.
		//
		// The same typed hooks recognize native synchronized output (?2026)
		// only as a real parsed DECSET/DECRST, so look-alike bytes inside
		// OSC/DCS/APC/PM/SOS strings, Kitty APC payloads (split before xterm),
		// or invalid/intermediate-bearing CSI never open or close a frame.
		// Parameters are applied in order, matching xterm's own handling.
		this.attach(this.terminal.parser.registerCsiHandler({ prefix: "?", final: "h" }, (params) => {
			this.observePrivateModes(params, true);
			this.observeMouseEncoding(params, true);
			return false;
		}));
		this.attach(this.terminal.parser.registerCsiHandler({ prefix: "?", final: "l" }, (params) => {
			this.observePrivateModes(params, false);
			this.observeMouseEncoding(params, false);
			return false;
		}));
		// Backstop: any buffer switch the mode hooks did not already settle
		// (for example RIS) ends a held frame without guessing anchors.
		this.attach(this.terminal.buffer.onBufferChange(() => {
			if (this.syncFrame) {
				this.endSyncFrame("discard");
			}
		}));

		// xterm 6 does not expose modifyOtherKeys in its public mode object.
		// Observe only the exact CSI > 4 ; N m shape used by Pi's
		// ProcessTerminal fallback. Missing/zero N disables; 1 and 2 are the
		// only recognized modes. Unknown values and malformed parameter shapes
		// are ignored, preserving the last supported mode; unrelated CSI > ... m
		// commands also leave this state alone. Return false so the native parser
		// remains authoritative for any supported action.
		this.attach(this.terminal.parser.registerCsiHandler({ prefix: ">", final: "m" }, (params) => {
			if (params[0] !== 4) {
				return false;
			}
			const mode = params.length === 1 ? 0 : params.length === 2 ? params[1] : undefined;
			if (mode === 0 || mode === 1 || mode === 2) {
				this.modifyOtherKeys = mode;
			}
			return false;
		}));

		// Supported reset sequences restore native cursor visibility; handlers
		// observe and return false so the builtin parser still processes them.
		this.attach(this.terminal.parser.registerEscHandler({ final: "c" }, () => {
			// RIS clears both buffers and synchronized output: a held frame
			// cannot complete, so its provisional anchors are discarded.
			if (this.syncFrame) {
				this.endSyncFrame("discard");
			}
			this.resetObservedProtocolState();
			return false;
		}));
		this.attach(this.terminal.parser.registerCsiHandler({ intermediates: "!", final: "p" }, () => {
			// DECSTR resets xterm's synchronized-output mode: end the hold early.
			if (this.syncFrame) {
				this.endSyncFrame("abort");
			}
			this.cursorVisible = true;
			return false;
		}));

		// Bounded Kitty keyboard protocol stack, independent per screen mode
		// (xterm 6 core has none). Progressive enhancement defines five flag
		// bits (1, 2, 4, 8, 16); this surface masks everything to the
		// owner-supported 0..7 range and never advertises unsupported flags.
		// Push:  CSI > flags u — saves the current state, applies the given
		// flags; at capacity the oldest saved state is evicted (FIFO) so the
		// newest push is retained.
		this.attach(this.terminal.parser.registerCsiHandler({ prefix: ">", final: "u" }, (params) => {
			const state = this.kittyBranch();
			if (state.stack.length >= KITTY_STACK_CAP) {
				state.stack.shift();
			}
			state.stack.push(state.current);
			state.current = (getParam(params[0]) ?? 0) & this.supportedFlags();
			return true;
		}));
		// Set/query: CSI = flags ; mode u
		//   mode 1: set current flags to the given value (flags 0 sets zero)
		//   mode 2: add the given flags
		//   mode 3: remove the given flags
		// These modify only the current flags of this screen mode (masked to the
		// owner's supported flags, so unsupported bits are never stored); the
		// pushed stack beneath is preserved. Replies happen solely for `CSI ? u`.
		this.attach(this.terminal.parser.registerCsiHandler({ prefix: "=", final: "u" }, (params) => {
			const state = this.kittyBranch();
			const flags = (getParam(params[0]) ?? 0) & this.supportedFlags();
			const mode = getParam(params[1]) ?? 1;
			if (mode === 1) {
				state.current = flags & this.supportedFlags();
			} else if (mode === 2) {
				state.current = (state.current | flags) & this.supportedFlags();
			} else if (mode === 3) {
				state.current = (state.current & ~flags) & this.supportedFlags();
			}
			return true;
		}));
		// Pop: CSI < count u — restores the most recent saved state per pop;
		// over-popping beyond the stack drains it silently (no unsolicited
		// reply). Per protocol, whenever pops empty the stack — whether the
		// requested count exhausts it exactly or the stack was already empty —
		// ALL flags reset to zero, including after bounded FIFO eviction of
		// older saves. The parser hands an omitted count as 0, which normalizes
		// to the protocol default of 1 (native pi ProcessTerminal emits `CSI < u`).
		this.attach(this.terminal.parser.registerCsiHandler({ prefix: "<", final: "u" }, (params) => {
			const state = this.kittyBranch();
			const count = getParam(params[0]) || 1;
			for (let i = 0; i < count; i += 1) {
				if (state.stack.length === 0) {
					break;
				}
				state.current = (state.stack.pop() as number) & this.supportedFlags();
			}
			if (state.stack.length === 0) {
				state.current = 0;
			}
			return true;
		}));
		// Query: CSI ? u -> current effective flags of this screen mode, always
		// masked against the owner's currently supported flags (a shrinking or
		// broken owner mask stops advertising immediately).
		// (Built-in DA/DSR requests are answered by headless through onData.)
		this.attach(this.terminal.parser.registerCsiHandler({ prefix: "?", final: "u" }, () => {
			this.reply(`\x1b[?${this.effectiveKittyFlags()}u`);
			return true;
		}));

		// Default-deny window operations: no window pixel metrics, title
		// commands, or other CSI t traffic is interpreted or exported.
		this.attach(this.terminal.parser.registerCsiHandler({ final: "t" }, () => true));

		// Raw OSC 52 remains denied, including from an active child's output.
		// Native Pi's client-bound copy previously disappeared here along with
		// untrusted controls. Only the authenticated native-producer capsule
		// below can now reach the owner's separate clipboard route; reconstructed
		// screen text and arbitrary PTY bytes grant no clipboard authority.
		this.attach(this.terminal.parser.registerOscHandler(52, () => true));
		// The host's private capsule OSC (#466) is always claimed, so a capsule —
		// verified or not — can never fall through to the parser's default OSC
		// handling (icon/title side effects, diagnostics) or reach frame text.
		// The payload is passed through verbatim to the owner's receiver and is
		// never used, copied into a frame, or reported by this class.
		this.attach(this.terminal.parser.registerOscHandler(NATIVE_CLIPBOARD_OSC, (data) => {
			if (!this.disposed) {
				this.safePeerInvoke(() => this.options.onNativeClipboardCapsule?.(data));
			}
			return true;
		}));
	}

	/** Queues a raw chunk of child output for parsing. Throws on limit overrun. */
	write(data: string): void {
		this.assertNotDisposed();
		if (this.parseFailed) {
			throw new Error("TerminalSurface parse pipeline failed");
		}
		if (typeof data !== "string") {
			throw new Error("TerminalSurface.write expects a string of raw child output");
		}
		// Empty writes are no-ops: they must not enqueue unbounded zero-byte
		// parse promises that count-limit or backpressure accounting would
		// otherwise have to track forever.
		if (data.length === 0) {
			return;
		}
		// Budget in UTF-8 bytes, not UTF-16 code units: CJK/emoji chunks are
		// several wire bytes each and the queue must reflect the child's wire
		// volume truthfully.
		const incomingBytes = Buffer.byteLength(data, "utf8");
		if (
			this.pendingBytes + incomingBytes > this.maxPendingBytes
			|| this.pendingWrites.length + 1 > MAX_QUEUED_WRITES
		) {
			throw new Error(
				`TerminalSurface queued write data exceeds its budget `
				+ `(maxPendingBytes ${this.maxPendingBytes}, max queued writes ${MAX_QUEUED_WRITES}); `
				+ "the child output source must be paused or drained before queueing more",
			);
		}
		let resolve!: () => void;
		const done = new Promise<void>((res) => {
			resolve = res;
		});
		const pending: PendingWrite = { size: incomingBytes, data, done, resolve };
		this.pendingWrites.push(pending);
		this.pendingBytes += incomingBytes;
		this.updateBackpressure();
		this.drainPendingWrites();
	}

	/**
	 * Resolves once every write already queued at call time has been parsed.
	 * A flush started before dispose settles (resolved) when dispose cancels
	 * the queued work; no peer callbacks fire after disposal.
	 */
	async flush(): Promise<void> {
		this.assertNotDisposed();
		const snapshot = [...this.pendingWrites];
		await Promise.all(snapshot.map((pending) => pending.done));
		if (this.parseFailed) {
			throw new Error("TerminalSurface parse pipeline failed");
		}
		// Let the async onWriteParsed invalidation land so callers can observe
		// frames/onChange deterministically after flush.
		await new Promise<void>((resolve) => setImmediate(resolve));
	}

	/** Applies a new size to the terminal. Throws on invalid dimensions. */
	resize(cols: number, rows: number): void {
		this.assertNotDisposed();
		validateDimension(cols, "cols");
		validateDimension(rows, "rows");
		// A held frame was captured at the old geometry: drop it so frame()
		// never reports stale cols/rows, then invalidate geometry-bound state.
		this.cancelSyncFrame();
		this.graphics.invalidatePlacements();
		this.terminal.resize(cols, rows);
		// Resize invalidates geometry deterministically: the underlying resize
		// is synchronous and buffers are reflowed immediately.
		this.invalidate();
		this.settleRedrawObservation();
	}

	/**
	 * Builds the current snapshot frame from the active buffer. While a native
	 * synchronized frame is held, returns the last complete committed state
	 * instead, so unrelated host redraws never observe a half-drawn frame.
	 */
	frame(): TerminalFrame {
		this.assertNotDisposed();
		const held = this.syncFrame?.committed;
		if (held) {
			return { ...held, lines: [...held.lines] };
		}
		return this.liveFrame();
	}

	private liveFrame(): TerminalFrame {
		const buffer = this.terminal.buffer.active;
		const cols = this.terminal.cols;
		const rows = this.terminal.rows;
		const lines: string[] = [];
		const styles: TerminalLineStyles[] = [];
		const reusableCell = buffer.getNullCell();
		for (let row = 0; row < rows; row += 1) {
			const bufferLine = buffer.getLine(buffer.viewportY + row);
			const runs: WritableRun[] = [];
			let currentRun: WritableRun | undefined;
			for (let x = 0; x < cols; x += 1) {
				const cell = bufferLine?.getCell(x, reusableCell) ?? reusableCell;
				const width = cell.getWidth();
				if (width === 0) {
					// Continuation cell of a wide character; skipping avoids
					// duplicated text while run columns stay in frame space.
					continue;
				}
				const content = sanitizeText(cell.getChars()) || " ";
				const attrs = cellAttributes(cell);
				const attrsKey = JSON.stringify(attrs);
				if (currentRun && currentRun.attrsKey === attrsKey) {
					currentRun.text += content;
				} else {
					const next: WritableRun = {
						startColumn: x,
						text: content,
						attrsKey,
						attrs,
					};
					runs.push(next);
					currentRun = next;
				}
			}
			// Serialize the row: sanitized text plus only generated SGR. Each
			// row independently establishes default attribute state at its
			// start (explicit leading reset — the compositor's real-tty styling
			// must not bleed through) and closes with an explicit trailing
			// reset at the row boundary, so rows never inherit attributes from
			// the host or a previous row. Native cumulative styling is
			// preserved within a row because every run is reconstructed from
			// its cells.
			let serialized = SGR_RESET;
			const defaultKey = JSON.stringify({});
			let currentKey = defaultKey;
			for (const run of runs) {
				if (run.attrsKey !== currentKey) {
					if (currentKey !== defaultKey) {
						serialized += SGR_RESET;
					}
					serialized += generateSgr(run.attrs);
					currentKey = run.attrsKey;
				}
				serialized += run.text;
			}
			serialized += SGR_RESET;
			lines.push(serialized);
			if (runs.length > 0) {
				styles.push({
					line: row,
					runs: runs.map((run) => {
						const { attrsKey, ...rest } = run;
						void attrsKey;
						return { startColumn: rest.startColumn, text: rest.text, ...rest.attrs };
					}),
				});
			}
		}
		// The cursor lives at viewport-relative buffer.cursorY; map it into
		// the frame's viewport window (scrollback-aware, alternates use the
		// alternate buffer's own baseY/viewportY of 0). cursorX === cols is
		// the wrap-pending position the pinned API permits after a row is
		// filled; the cursor stays visible at the clamped last column.
		const bufferCursorLine = buffer.baseY + buffer.cursorY;
		const rawCursorRow = bufferCursorLine - buffer.viewportY;
		const cursorRow = Math.min(Math.max(rawCursorRow, 0), rows - 1);
		const visible = this.cursorVisible
			&& rawCursorRow >= 0
			&& rawCursorRow < rows;
		const cursor = {
			column: Math.min(buffer.cursorX, cols - 1),
			row: cursorRow,
			visible,
		};
		const graphics = this.graphics.frame(buffer.type, buffer.viewportY, cols, rows);
		if (styles.length > 0) {
			return { cols, rows, lines, cursor, styles, ...(graphics ? { graphics } : {}) };
		}
		return { cols, rows, lines, cursor, ...(graphics ? { graphics } : {}) };
	}

	/**
	 * The owning terminal's active input-protocol state (own VT state, not
	 * telemetry): effective Kitty flags of the active buffer mode, declared
	 * xterm 6 modes, and bounded typed-parser observations for modes xterm 6
	 * does not expose publicly.
	 */
	inputModes(): TerminalInputModes {
		this.assertNotDisposed();
		return this.inputModesState();
	}

	/**
	 * Input-mode facts that belong with the last COMPLETE committed frame —
	 * what an observer publishing this surface's content must pair with
	 * `frame()` (#500). While a synchronized frame is held this is the state
	 * captured when the hold opened, exactly like `frame()`, so a mid-frame
	 * mode change is never published beside the frame the viewer is still
	 * being shown, and the temporary mouse withholding of `inputModes()` is
	 * never exported as a mode fact. Outside a hold this is the live parsed
	 * state, which IS the committed frame's state. The returned object is a
	 * fresh copy the caller may keep.
	 *
	 * This is not a per-packet input authorization: local packet routing
	 * keeps using `inputModes()`, which withholds mouse reporting for the
	 * whole time a frame is held.
	 */
	publishedInputModes(): TerminalInputModes {
		this.assertNotDisposed();
		const held = this.syncFrame;
		if (held !== undefined) {
			return { ...held.committedModes };
		}
		return this.inputModesState();
	}

	/**
	 * The surface's synchronized-redraw state for an owner that must not hand
	 * input to a half-drawn screen ({@linkcode onRedrawSettled}): `"held"` while
	 * a frame is in flight OR its completion is still owed to an owner (a parsed
	 * end marker whose chunk has not finished parsing and been observed),
	 * `"clear"` only when the parsed state IS the committed frame, and
	 * `"unavailable"` when this pipeline can no longer be trusted about anything
	 * — a failed parse (sticky here) or disposal. Unavailable is deliberately NOT
	 * clear: bytes handed to a grounded parser have no defined effect, so an
	 * owner cancels waiting work and refuses new work instead.
	 *
	 * Never a per-packet authorization; readiness only orders a redraw. Unlike
	 * the other accessors this never throws after disposal, because a waiter has
	 * to be able to learn that the surface is gone.
	 */
	redrawState(): TerminalRedrawState {
		if (this.disposed || this.parseFailed) {
			// A grounded pipeline is not a healthy surface with no hold: whatever was
			// waiting for it must be cancelled, not written.
			return "unavailable";
		}
		// A parsed end marker is not readiness on its own. Until the whole-chunk
		// completion path has delivered its observation, the rest of the child's chunk
		// may not have parsed at all — a graphics-split chunk reaches this point between
		// its separate parser writes — so an owner polling here must still wait.
		return this.syncFrame === undefined && !this.redrawSettledPending ? "clear" : "held";
	}

	/**
	 * Observe the end of every held native synchronized frame. The listener
	 * fires when a hold ends for ANY reason — a parsed end marker, a bound
	 * (time/bytes/chunks), DECSTR, a buffer switch or RIS discard, and
	 * disposal — and it fires even when the completed frame is visually and
	 * mode-identical to the committed one, which the change notification
	 * alone would not report. It is a wake-up only: it carries no facts, and
	 * the listener re-reads `redrawState()` and `publishedInputModes()`.
	 *
	 * The returned unsubscribe is idempotent, a retired observer is never
	 * called again, and one throwing observer never reaches another observer or
	 * the parser. Disposal wakes every observer once — a waiter must learn that
	 * no hold can outlive this surface — and releases them, with no invocation
	 * afterwards.
	 *
	 * The wake-up is delivered from the surface's post-parse, post-observation
	 * path, never from inside a parser hook: a frame that ends and is followed in
	 * the SAME chunk by a mode change, a reset, or a new frame is reported with
	 * the state the whole chunk left behind, so a waiter never reads an
	 * intermediate state the child never displayed.
	 */
	onRedrawSettled(listener: () => void): () => void {
		this.assertNotDisposed();
		if (typeof listener !== "function") {
			throw new TypeError("TerminalSurface.onRedrawSettled requires a listener function");
		}
		this.redrawObservers.add(listener);
		let active = true;
		return () => {
			if (!active) {
				return;
			}
			active = false;
			this.redrawObservers.delete(listener);
		};
	}

	/**
	 * Mouse reporting the child requested, for outer-terminal capture only
	 * (see `TerminalMouseReportingRequest`). Never use this to forward a
	 * mouse packet: `inputModes()` is the per-packet authorization. While a
	 * frame is held this is the committed frame's request (captured before
	 * the hold began, so not withheld); otherwise it is the live parsed
	 * state. Any difference between the two at commit changes the
	 * invalidation key, so the owner is notified and a real revocation
	 * reaches the outer terminal when the frame ends.
	 */
	requestedMouseReporting(): TerminalMouseReportingRequest {
		this.assertNotDisposed();
		const committed = this.syncFrame?.committedModes;
		if (committed) {
			return { mouseTracking: committed.mouseTracking, mouseEncoding: committed.mouseEncoding };
		}
		return { mouseTracking: this.terminal.modes.mouseTrackingMode, mouseEncoding: this.mouseEncoding };
	}

	/**
	 * Dispose the underlying terminal. Deterministic lifecycle: pending write
	 * promises are settled (resolved, cancelled) so in-flight flush() calls
	 * never hang; owner callbacks never fire after disposal.
	 */
	dispose(): void {
		if (this.disposed) {
			return;
		}
		// Hand over diagnostics already collected before owner callbacks are
		// dropped; nothing is delivered after disposal.
		this.diagnostics.flushNow();
		this.disposed = true;
		this.diagnostics.dispose();
		this.activeTerminalWriteResolve?.();
		this.cancelSyncFrame();
		// Release redraw observers too: a waiter must learn that no hold can
		// outlive this surface, whether or not a frame was held at disposal.
		// Nothing re-subscribes afterwards (the surface is disposed), and no
		// observer is invoked after this point.
		this.redrawSettledPending = false;
		this.notifyRedrawSettled();
		this.redrawObservers.clear();
		this.graphicsSplitter.dispose();
		this.graphicsPreflightState = "ground";
		this.graphics.dispose();
		this.kittyNormal.current = 0;
		this.kittyNormal.stack.length = 0;
		this.kittyAlternate.current = 0;
		this.kittyAlternate.stack.length = 0;
		this.modifyOtherKeys = 0;
		this.mouseEncoding = "default";
		this.cursorVisible = true;
		this.lastInvalidateKey = "";
		this.paused = false;
		// Drop owner callback/support closures as part of teardown as well as
		// disposing every xterm event/parser subscription below.
		this.options = {};
		for (const disposable of this.disposables.splice(0)) {
			disposable.dispose();
		}
		// Settle every pending write before clearing the queue: previously
		// started flush() calls must not wait forever on writes whose parse
		// callbacks were cancelled by the underlying dispose.
		for (const pending of this.pendingWrites.splice(0)) {
			pending.resolve();
		}
		this.pendingBytes = 0;
		this.terminal.dispose();
	}

	private drainPendingWrites(): void {
		if (this.disposed || this.drainingWrites) {
			return;
		}
		this.drainingWrites = true;
		void Promise.resolve().then(() => this.processPendingWrites());
	}

	/** Detect splitter mutations that must wait for preceding xterm callbacks. */
	private preflightGraphicsChunk(data: string): boolean {
		let state = this.graphicsPreflightState;
		let sensitive = state === "escape" || state === "apc-start" || state === "kitty" || state === "kitty-escape";
		let offset = 0;
		while (offset < data.length) {
			switch (state) {
				case "ground": {
					const control = this.nextGraphicsPreflightControl(data, offset);
					if (control < 0) {
						offset = data.length;
						break;
					}
					offset = control;
					const code = data.charCodeAt(offset);
					if (code === 0x1b) {
						if (offset + 1 >= data.length) {
							state = "escape";
							sensitive = true;
							offset += 1;
						} else {
							const next = data[offset + 1] as string;
							if (next === "_") {
								state = "apc-start";
								sensitive = true;
							} else if (next === "]") {
								state = "opaque-osc";
							} else if (next === "P" || next === "^" || next === "X") {
								state = "opaque-string";
							} else {
								state = "ground";
							}
							offset += 2;
						}
					} else if (code === 0x9f) {
						state = "apc-start";
						sensitive = true;
						offset += 1;
					} else if (code === 0x9d) {
						state = "opaque-osc";
						offset += 1;
					} else {
						state = "opaque-string";
						offset += 1;
					}
					break;
				}
				case "escape": {
					const next = data[offset] as string;
					if (next === "_") {
						state = "apc-start";
						sensitive = true;
					} else if (next === "]") {
						state = "opaque-osc";
					} else if (next === "P" || next === "^" || next === "X") {
						state = "opaque-string";
					} else {
						state = "ground";
					}
					offset += 1;
					break;
				}
				case "apc-start": {
					const next = data[offset] as string;
					if (next === "G") {
						state = "kitty";
						sensitive = true;
					} else if (next === "\x9c") {
						state = "ground";
					} else if (next === "\x1b") {
						state = "opaque-string-escape";
					} else {
						state = "opaque-string";
					}
					offset += 1;
					break;
				}
				case "kitty": {
					const c1Terminator = data.indexOf("\x9c", offset);
					const escape = data.indexOf("\x1b", offset);
					if (c1Terminator >= 0 && (escape < 0 || c1Terminator < escape)) {
						state = "ground";
						offset = c1Terminator + 1;
					} else if (escape < 0) {
						offset = data.length;
					} else if (escape + 1 >= data.length) {
						state = "kitty-escape";
						offset = escape + 1;
					} else if (data[escape + 1] === "\\") {
						state = "ground";
						offset = escape + 2;
					} else {
						offset = escape + 2;
					}
					break;
				}
				case "kitty-escape":
					if (data[offset] === "\\") {
						state = "ground";
						offset += 1;
					} else {
						state = "kitty";
					}
					break;
				case "opaque-osc-escape":
				case "opaque-string-escape":
					if (data[offset] === "\\") {
						state = "ground";
						offset += 1;
					} else {
						state = state === "opaque-osc-escape" ? "opaque-osc" : "opaque-string";
					}
					break;
				case "opaque-osc":
				case "opaque-string": {
					const isOsc = state === "opaque-osc";
					let terminator = data.indexOf("\x9c", offset);
					const escape = data.indexOf("\x1b", offset);
					const bell = isOsc ? data.indexOf("\x07", offset) : -1;
					if (escape >= 0 && (terminator < 0 || escape < terminator)) {
						terminator = escape;
					}
					if (bell >= 0 && (terminator < 0 || bell < terminator)) {
						terminator = bell;
					}
					if (terminator < 0) {
						if (data[data.length - 1] === "\x1b") {
							state = isOsc ? "opaque-osc-escape" : "opaque-string-escape";
						}
						offset = data.length;
					} else if (data[terminator] === "\x9c" || data[terminator] === "\x07") {
						state = "ground";
						offset = terminator + 1;
					} else if (terminator + 1 < data.length && data[terminator + 1] === "\\") {
						state = "ground";
						offset = terminator + 2;
					} else if (terminator + 1 < data.length) {
						offset = terminator + 2;
					} else {
						state = isOsc ? "opaque-osc-escape" : "opaque-string-escape";
						offset = terminator + 1;
					}
					break;
				}
			}
		}
		this.graphicsPreflightState = state;
		return sensitive;
	}

	private nextGraphicsPreflightControl(data: string, start: number): number {
		for (let index = start; index < data.length; index += 1) {
			const code = data.charCodeAt(index);
			if (code === 0x1b || code === 0x9f || code === 0x90 || code === 0x9e || code === 0x98 || code === 0x9d) {
				return index;
			}
		}
		return -1;
	}

	private async processPendingWrites(): Promise<void> {
		try {
			while (!this.disposed && this.pendingWrites.length > 0) {
				this.processingWrite = true;
				const maxBatchWrites = this.hasAlternateGraphicsPlacements()
					? 1
					: MAX_TERMINAL_BATCH_WRITES;
				const batch: PendingWrite[] = [];
				let batchBytes = 0;
				for (const pending of this.pendingWrites) {
					if (batch.length >= maxBatchWrites) {
						break;
					}
					if (batch.length > 0 && batchBytes + pending.size > MAX_TERMINAL_BATCH_BYTES) {
						break;
					}
					batch.push(pending);
					batchBytes += pending.size;
					if (batchBytes >= MAX_TERMINAL_BATCH_BYTES) {
						break;
					}
				}
				const terminalParts: string[] = [];
				const textPending: PendingWrite[] = [];

				for (const pending of batch) {
					if (this.disposed) {
						return;
					}
					if (this.preflightGraphicsChunk(pending.data)) {
						// Preflight before mutating the splitter: it can reserve shared
						// pending-byte budget even when this APC continues in a later
						// child chunk and emits no typed event yet.
						await this.flushTerminalBatch(terminalParts, textPending);
						terminalParts.length = 0;
						textPending.length = 0;
						if (this.disposed) {
							return;
						}
						const parts = this.graphicsSplitter.push(pending.data);
						for (const part of parts) {
							if (this.disposed) {
								return;
							}
							if (part.kind === "terminal") {
								await this.writeToTerminal(part.data);
								if (this.disposed) {
									return;
								}
								this.afterTerminalWrite();
							} else if (part.kind === "graphics") {
								// Let xterm consume a generated empty APC before the typed event.
								// This returns a parser left mid-CSI/ESC to ground without ever
								// forwarding the child's payload or changing cursor position.
								await this.writeToTerminal(SAFE_EMPTY_APC);
								if (this.disposed) {
									return;
								}
								this.graphics.process(part.command, this.graphicsPosition(part.command));
							} else if (part.kind === "discard") {
								await this.writeToTerminal(SAFE_EMPTY_APC);
								if (this.disposed) {
									return;
								}
								this.graphics.discard();
							} else {
								await this.writeToTerminal(SAFE_EMPTY_APC);
								if (this.disposed) {
									return;
								}
								this.graphics.clear();
							}
						}
						this.completePendingWrites([pending]);
						if (!this.disposed) {
							this.invalidate();
							this.settleRedrawObservation();
						}
						// Potential graphics chunks are batch boundaries, including
						// incomplete prefixes and payload continuations. The next chunk
						// must not mutate the splitter until these bytes have parsed.
						break;
					}
					const parts = this.graphicsSplitter.push(pending.data);
					if (parts.some((part) => part.kind !== "terminal")) {
						throw new Error("TerminalSurface graphics preflight missed a splitter barrier");
					}
					for (const part of parts) {
						if (part.kind === "terminal") {
							terminalParts.push(part.data);
						}
					}
					textPending.push(pending);
				}

				if (textPending.length > 0) {
					await this.flushTerminalBatch(terminalParts, textPending);
				}
			}
		} catch {
			// A parser or protocol helper failure must not strand flush callers
			// or silently accept later child output as if it had parsed.
			this.parseFailed = true;
			this.cancelSyncFrame();
			this.graphics.discard();
			for (const pending of this.pendingWrites.splice(0)) {
				pending.resolve();
			}
			this.pendingBytes = 0;
			this.updateBackpressure();
			// The surface is grounded (parse failed, hold cancelled, graphics
			// discarded) before any waiter is woken, so a failed parse releases
			// waiting input as `redrawState() === "unavailable"` — cancelled, never
			// written — rather than as a healthy surface with no hold in flight.
			this.settleRedrawObservation();
		} finally {
			this.processingWrite = false;
			this.drainingWrites = false;
			if (!this.disposed && this.pendingWrites.length > 0) {
				this.drainPendingWrites();
			}
		}
	}

	/** Parse a bounded run of adjacent text chunks with one xterm write. */
	private async flushTerminalBatch(parts: string[], pending: PendingWrite[]): Promise<void> {
		if (this.disposed) {
			return;
		}
		if (parts.length > 0) {
			await this.writeToTerminal(parts.join(""));
			if (this.disposed) {
				return;
			}
			this.afterTerminalWrite();
		}
		if (this.disposed) {
			return;
		}
		this.completePendingWrites(pending);
		if (!this.disposed && parts.length > 0) {
			this.invalidate();
		}
		// One batch is one parse: a synchronized frame that ended anywhere in it,
		// and anything that followed it in the same chunk, is settled here.
		this.settleRedrawObservation();
	}

	private afterTerminalWrite(): void {
		this.applyPendingAlternateGraphicsInvalidation();
		if (this.syncFrame) {
			// Destructive controls inside a frame still apply at once; anchor
			// validation waits for the completed frame's covered rows.
			return;
		}
		const screen = this.alternateScreenState();
		this.graphics.validateAlternateScreen(screen.textAt, false);
	}

	private completePendingWrites(pending: readonly PendingWrite[]): void {
		for (const item of pending) {
			if (this.disposed) {
				return;
			}
			if (this.pendingWrites.shift() !== item) {
				throw new Error("TerminalSurface pending-write order was corrupted");
			}
			this.pendingBytes -= item.size;
			item.resolve();
			this.updateBackpressure();
			this.accountSyncFrameWrite(item.size);
		}
	}

	/** Bound a held frame by child bytes and chunks; overflow ends the hold. */
	private accountSyncFrameWrite(size: number): void {
		const frame = this.syncFrame;
		if (!frame || this.disposed) {
			return;
		}
		frame.bytes += size;
		frame.writes += 1;
		if (frame.bytes > MAX_SYNC_FRAME_BYTES || frame.writes > MAX_SYNC_FRAME_WRITES) {
			this.endSyncFrame("abort");
		}
	}

	/**
	 * Apply typed DECSET/DECRST observations in parameter order. A frame
	 * marker must be the exact numeric parameter 2026: colon sub-parameter
	 * forms (for example `CSI ? 2026 : 1 h`) are not a supported marker and
	 * never open or close a held frame. Cursor visibility and buffer-switch
	 * observation keep following xterm, which acts on the leading value.
	 */
	private observePrivateModes(params: (number | number[])[], set: boolean): void {
		for (let index = 0; index < params.length; index += 1) {
			const mode = params[index];
			if (typeof mode !== "number") {
				// xterm delivers a parameter's colon sub-parameters as the
				// following array entry; they are never mode numbers themselves.
				continue;
			}
			const exact = !Array.isArray(params[index + 1]);
			if (mode === 25) {
				this.cursorVisible = set;
			} else if (mode === SYNCHRONIZED_OUTPUT_MODE) {
				if (!exact) {
					continue;
				}
				if (set) {
					this.openSyncFrame();
				} else if (this.syncFrame) {
					this.endSyncFrame("complete");
				}
			} else if ((BUFFER_SWITCH_MODES as readonly number[]).includes(mode) && this.syncFrame) {
				// Runs before xterm switches buffers: provisional anchors of the
				// buffer being left can never be completed, so they are dropped.
				this.endSyncFrame("discard");
			}
		}
	}

	/**
	 * Open a held frame (parser-hook time, exact stream position). Repeated
	 * begin markers are idempotent like DECSET; the hold stays bounded by the
	 * first open's timer and byte/count limits.
	 */
	private openSyncFrame(): void {
		if (this.syncFrame || this.disposed || this.parseFailed) {
			return;
		}
		// Settle everything parsed before the marker exactly as a write
		// boundary would, so the committed snapshot is a coherent state.
		this.applyPendingAlternateGraphicsInvalidation();
		this.graphics.validateAlternateScreen(this.alternateScreenState().textAt, false);
		const committed = this.liveFrame();
		// Captured before `syncFrame` is set, so its mouse fields are the
		// child's actual request (see requestedMouseReporting()).
		const committedModes = this.inputModesState();
		this.graphics.retainPublished(committed.graphics, this.terminal.buffer.active.type);
		this.graphics.beginDeferredAlternateAnchors();
		const timer = setTimeout(() => this.expireSyncFrame(), MAX_SYNC_FRAME_MS);
		timer.unref?.();
		this.syncFrame = {
			committed,
			committedRevision: this.graphics.revision,
			committedModes,
			timer,
			bytes: 0,
			writes: 0,
		};
	}

	/**
	 * Stop holding. `complete` (a parsed end marker) and `abort` (time/byte/
	 * count bound, DECSTR) anchor provisional placements against the alternate
	 * cells as they are now and validate older anchors against them; `discard`
	 * (buffer switch, RIS) removes provisional placements instead. Notification
	 * is left to the caller's post-parse path.
	 */
	private endSyncFrame(mode: "complete" | "abort" | "discard"): void {
		const frame = this.syncFrame;
		if (!frame) {
			return;
		}
		this.syncFrame = undefined;
		clearTimeout(frame.timer);
		this.applyPendingAlternateGraphicsInvalidation();
		if (mode === "discard") {
			this.graphics.discardDeferredAlternateAnchors();
		} else {
			const textAt = this.alternateScreenState().textAt;
			this.graphics.finalizeDeferredAlternateAnchors(textAt);
			this.graphics.validateAlternateScreen(textAt, false);
		}
		this.graphics.releasePublished();
		// A hold ending is a lifecycle fact even when nothing visible changed:
		// the change notification dedupes on the committed key, so waiters get
		// their own wake-up (never inferred from a delay or a frame). It is
		// latched, not delivered: the caller's post-parse path delivers it after
		// the rest of the chunk has parsed and the committed state is observed.
		this.redrawSettledPending = true;
	}

	/**
	 * Wake every redraw observer. Each is isolated like the other peer
	 * callbacks: one throw reaches neither the parser nor another observer.
	 */
	private notifyRedrawSettled(): void {
		if (this.redrawObservers.size === 0) {
			return;
		}
		for (const listener of [...this.redrawObservers]) {
			this.safePeerInvoke(listener);
		}
	}

	/**
	 * Deliver a latched "the held frame ended" wake-up. Call this only after the
	 * parse of the chunk that ended the frame is finished and the resulting state
	 * has been observed (`invalidate()`), including a frame that completed with
	 * nothing visually changed. Never call it from a parser hook: an intermediate
	 * end marker followed by another mode change in the same chunk would expose a
	 * state the child never displayed.
	 */
	private settleRedrawObservation(): void {
		if (!this.redrawSettledPending) {
			return;
		}
		this.redrawSettledPending = false;
		if (this.disposed) {
			return;
		}
		this.notifyRedrawSettled();
	}

	/** Drop a held frame without anchoring (resize, parse failure, disposal). */
	private cancelSyncFrame(): void {
		if (this.syncFrame) {
			this.endSyncFrame("discard");
		}
	}

	private expireSyncFrame(): void {
		if (this.disposed || !this.syncFrame) {
			return;
		}
		// xterm parses each write synchronously, so a timer always observes a
		// write boundary. The in-flight pipeline notifies after its own write.
		this.endSyncFrame("abort");
		if (!this.processingWrite) {
			this.invalidate();
			this.settleRedrawObservation();
		}
	}

	/** Alternate anchors require per-chunk validation, including across buffer switches. */
	private hasAlternateGraphicsPlacements(): boolean {
		const buffer = this.terminal.buffer.alternate;
		const graphics = this.graphics.frame("alternate", buffer.viewportY, this.terminal.cols, this.terminal.rows);
		return (graphics?.placements.length ?? 0) > 0 || (graphics?.fallbacks.length ?? 0) > 0;
	}

	private writeToTerminal(data: string): Promise<void> {
		if (this.disposed || data.length === 0) {
			return Promise.resolve();
		}
		return new Promise<void>((resolve, reject) => {
			let settled = false;
			const settle = () => {
				if (settled) {
					return;
				}
				settled = true;
				if (this.activeTerminalWriteResolve === settle) {
					this.activeTerminalWriteResolve = undefined;
				}
				resolve();
			};
			const fail = () => {
				if (settled) {
					return;
				}
				settled = true;
				if (this.activeTerminalWriteResolve === settle) {
					this.activeTerminalWriteResolve = undefined;
				}
				reject(new Error("TerminalSurface terminal parser failed"));
			};
			this.activeTerminalWriteResolve = settle;
			try {
				this.terminal.write(data, settle);
			} catch {
				fail();
			}
		});
	}

	private applyPendingAlternateGraphicsInvalidation(): void {
		if (!this.pendingAlternateGraphicsInvalidation) {
			return;
		}
		this.pendingAlternateGraphicsInvalidation = false;
		this.graphics.validateAlternateScreen(undefined, true);
	}

	private graphicsPosition(command: string): TerminalGraphicsPosition {
		const buffer = this.terminal.buffer.active;
		const alternateScreen = buffer.type === "alternate" ? this.alternateScreenState() : undefined;
		const marker = KittyGraphicsState.needsPosition(command) && buffer.type === "normal"
			? this.terminal.registerMarker(0)
			: undefined;
		return {
			buffer: buffer.type,
			column: buffer.cursorX,
			row: buffer.baseY + buffer.cursorY,
			...(alternateScreen === undefined ? {} : {
				alternateTextAt: alternateScreen.textAt,
			}),
			cols: this.terminal.cols,
			rows: this.terminal.rows,
			...(marker === undefined ? {} : { marker }),
		};
	}

	private alternateScreenState(): {
		readonly textAt: (row: number, column: number, width: number) => string;
	} {
		const buffer = this.terminal.buffer.alternate;
		return {
			textAt: (row, column, width) => buffer.getLine(buffer.viewportY + row)
				?.translateToString(false, column, column + width) ?? "",
		};
	}

	private assertNotDisposed(): void {
		if (this.disposed) {
			throw new Error("TerminalSurface is disposed");
		}
	}

	private attach(disposable: IDisposable): void {
		this.disposables.push(disposable);
	}

	/**
	 * Kitty keyboard state of the active screen mode: the protocol keeps
	 * keyboard state independent for the normal and alternate buffers, so it
	 * is selected from the real `buffer.active.type` at sequence-parse time.
	 */
	private kittyBranch(): KittyState {
		return this.terminal.buffer.active.type === "alternate" ? this.kittyAlternate : this.kittyNormal;
	}

	/**
	 * Owner-supported enhancement flags, masked to the protocol's advertised
	 * range (at most 7; bit 16 unsupported). A missing callback defaults to
	 * 7 for the virtual input encoder; a bad callback (throw, non-number,
	 * non-integer, out of 0..7) fails safe to 0 — no unsupported flags are
	 * ever advertised.
	 */
	private supportedFlags(): number {
		if (!this.options.getSupportedKeyboardFlags) {
			// No option: virtual input encoder default advertises at most 7.
			return KITTY_MAX_SUPPORTED_FLAGS;
		}
		try {
			const provided = this.options.getSupportedKeyboardFlags();
			if (
				typeof provided !== "number"
				|| !Number.isSafeInteger(provided)
				|| provided < 0
				|| provided > KITTY_MAX_SUPPORTED_FLAGS
			) {
				return 0;
			}
			return provided & KITTY_MAX_SUPPORTED_FLAGS;
		} catch {
			// A throwing support callback fails safe: nothing is advertised.
			return 0;
		}
	}

	private reply(data: string): void {
		if (!this.disposed) {
			this.safePeerInvoke(() => this.options.onReply?.(data));
		}
	}

	/**
	 * Peer callbacks are the host's responsibility, but a throwing callback
	 * must never strand the parser's per-write promise or the parse lifecycle:
	 * bookkeeping runs before, and peer exceptions are contained here.
	 */
	private safePeerInvoke(invoke: () => void): void {
		try {
			invoke();
		} catch {
			// Contained; hosts are responsible for callback safety.
		}
	}

	/**
	 * Tracks only xterm's actual DECSET/DECRST mouse encodings. DECSET uses
	 * the last relevant parameter (1006 = SGR, 1016 = SGR pixels); DECRST of
	 * either parameter resets to default. Legacy 1005/1015 encodings are not
	 * emulated. Keep this outside parser callbacks' peer-notification path:
	 * onWriteParsed observes the updated state after the complete write.
	 */
	private observeMouseEncoding(params: (number | number[])[], set: boolean): void {
		for (const param of params) {
			if (typeof param !== "number") {
				continue;
			}
			if (set) {
				if (param === 1006) {
					this.mouseEncoding = "sgr";
				} else if (param === 1016) {
					this.mouseEncoding = "sgr-pixels";
				}
			} else if (param === 1006 || param === 1016) {
				// Upstream DECRST of either encoding resets to DEFAULT, even if
				// another supported encoding had been active.
				this.mouseEncoding = "default";
			}
		}
	}

	/**
	 * ESC c (RIS) resets the protocol-observation state. DECSTR is deliberately
	 * not treated as a mouse-encoding reset: pinned xterm InputHandler.softReset
	 * does not reset its CoreMouseService encoding.
	 */
	private resetObservedProtocolState(): void {
		this.cursorVisible = true;
		this.kittyNormal.current = 0;
		this.kittyNormal.stack.length = 0;
		this.kittyAlternate.current = 0;
		this.kittyAlternate.stack.length = 0;
		this.modifyOtherKeys = 0;
		this.mouseEncoding = "default";
	}

	private invalidate(): void {
		if (this.disposed) {
			return;
		}
		// The invalidation key covers the frame and the input-mode state, so
		// mode-only changes (bracketed paste, cursor keys, mouse tracking,
		// kitty flags) still notify the host — after the parse completes.
		const frame = this.frame();
		const revision = this.syncFrame?.committedRevision ?? this.graphics.revision;
		const { graphics, ...textFrame } = frame;
		const graphicsKey = graphics
			? {
				revision,
				images: graphics.images.map(({ id, mimeType, widthPx, heightPx }) => ({ id, mimeType, widthPx, heightPx })),
				placements: graphics.placements,
				fallbacks: graphics.fallbacks,
			}
			: { revision };
		// While a frame is held the key is the committed state only, so mode
		// changes inside an incomplete frame do not notify until it commits.
		const modes = this.syncFrame?.committedModes ?? this.inputModesState();
		const key = JSON.stringify(textFrame) + "|" + JSON.stringify(graphicsKey)
			+ "|" + JSON.stringify(modes);
		if (key !== this.lastInvalidateKey) {
			this.lastInvalidateKey = key;
			this.safePeerInvoke(() => this.options.onChange?.());
		}
	}

	/**
	 * Keyboard protocol state is always the child's latest parsed state (the
	 * child already switched; delaying would mis-encode keys). Mouse reporting
	 * is withheld (`none`) for the whole time a synchronized frame is held:
	 * the displayed committed frame and the child's partially redrawn screen
	 * may disagree about what is under any cell, so no click is forwarded
	 * until the frame commits (or a bound ends the hold). Revocation therefore
	 * also takes effect immediately.
	 */
	private inputModesState(): TerminalInputModes {
		const modes = this.terminal.modes;
		const mouseHeldBack = this.syncFrame !== undefined;
		return {
			kittyFlags: this.effectiveKittyFlags(),
			applicationCursorKeys: modes.applicationCursorKeysMode,
			applicationKeypad: modes.applicationKeypadMode,
			bracketedPaste: modes.bracketedPasteMode,
			mouseTracking: mouseHeldBack ? "none" : modes.mouseTrackingMode,
			modifyOtherKeys: this.modifyOtherKeys,
			mouseEncoding: this.mouseEncoding,
		};
	}

	/**
	 * Effective flags of the active screen mode, masked against the owner's
	 * currently validated supported mask: used consistently for queries,
	 * inputModes(), and post-parse invalidation so a support change (to 0 or
	 * a throwing callback) stops advertising at once, while set/add/remove
	 * and pop-restore keep only supported bits stored at write time.
	 */
	private effectiveKittyFlags(): number {
		return this.kittyBranch().current & this.supportedFlags();
	}

	private updateBackpressure(): void {
		if (this.disposed || !this.options.onBackpressure) {
			return;
		}
		const overHigh = this.pendingBytes > this.highWatermarkBytes
			|| this.pendingWrites.length > HIGH_WATERMARK_WRITES;
		const atOrBelowLow = this.pendingBytes <= this.lowWatermarkBytes
			&& this.pendingWrites.length <= LOW_WATERMARK_WRITES;
		if (!this.paused && overHigh) {
			this.paused = true;
			this.safePeerInvoke(() => this.options.onBackpressure?.(true));
		} else if (this.paused && atOrBelowLow) {
			this.paused = false;
			this.safePeerInvoke(() => this.options.onBackpressure?.(false));
		}
	}
}