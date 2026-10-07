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
 *   are swallowed (default deny). There is no graphical renderer here: the
 *   headless instance safely consumes image/graphics sequences without
 *   forwarding them, and no graphics or native menu parity is claimed.
 * - The Kitty keyboard handling uses typed parser hooks
 *   (parser.registerCsiHandler) because xterm 6 core has no kittyKeyboard
 *   support and no onRender callback. Snapshot invalidation happens only
 *   through the post-parse path (onWriteParsed / per-write parse callbacks),
 *   never synchronously inside write(), never inside parser hooks, and never
 *   on raw buffer-switch events; notification keys include the input-mode
 *   state so mode-only changes (bracketed paste, cursor keys/keypad, mouse
 *   tracking/encoding, modifyOtherKeys, kitty flags) notify the host after
 *   the parse completes.
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
	/** Bounded named scrollback lines (default 1000). */
	readonly scrollback?: number;
	/** Maximum bytes of not-yet-parsed queued write data (default 8 MiB). */
	readonly maxPendingBytes?: number;
}

interface PendingWrite {
	/** Queued UTF-8 byte size of the still-unparsed chunk. */
	readonly size: number;
	readonly done: Promise<void>;
	resolve: () => void;
}

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
const HIGH_WATERMARK_WRITES = 2048;
const LOW_WATERMARK_WRITES = 1024;
const MAX_DIMENSION = 1000;

const SGR_RESET = "\x1b[0m";
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
	private options: TerminalSurfaceOptions;
	private readonly maxPendingBytes: number;
	private readonly highWatermarkBytes: number;
	private readonly lowWatermarkBytes: number;

	private pendingBytes = 0;
	private cursorVisible = true;
	private modifyOtherKeys: 0 | 1 | 2 = 0;
	private mouseEncoding: TerminalInputModes["mouseEncoding"] = "default";
	private paused = false;
	private disposed = false;
	private lastInvalidateKey = "";

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
		this.terminal = new Terminal({
			cols,
			rows,
			scrollback,
			allowProposedApi: true,
		});
		const unicode11 = new Unicode11Addon();
		this.terminal.loadAddon(unicode11);
		this.terminal.unicode.activeVersion = "11";

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
			this.invalidate();
		}));

		// Hardware cursor visibility tracking. Handlers scan all private-mode
		// parameters (combined sequences like CSI ?1;5;25 h/l are valid) and
		// return false so the native builtin parser also processes them.
		this.attach(this.terminal.parser.registerCsiHandler({ prefix: "?", final: "h" }, (params) => {
			if (this.paramsContain(params, 25)) {
				this.cursorVisible = true;
			}
			this.observeMouseEncoding(params, true);
			return false;
		}));
		this.attach(this.terminal.parser.registerCsiHandler({ prefix: "?", final: "l" }, (params) => {
			if (this.paramsContain(params, 25)) {
				this.cursorVisible = false;
			}
			this.observeMouseEncoding(params, false);
			return false;
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
			this.resetObservedProtocolState();
			return false;
		}));
		this.attach(this.terminal.parser.registerCsiHandler({ intermediates: "!", final: "p" }, () => {
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

		// OSC 52 clipboard writes are swallowed and never exported; native
		// clipboard / app-input support is a separate Pi native concern, not
		// disabled by this class's text-only snapshots.
		this.attach(this.terminal.parser.registerOscHandler(52, () => true));
	}

	/** Queues a raw chunk of child output for parsing. Throws on limit overrun. */
	write(data: string): void {
		this.assertNotDisposed();
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
		const pending: PendingWrite = { size: incomingBytes, done, resolve };
		this.pendingWrites.push(pending);
		this.pendingBytes += incomingBytes;
		this.terminal.write(data, () => {
			if (this.disposed) {
				// Writes completing after dispose must not call into peers;
				// their promises were already settled by dispose().
				return;
			}
			const index = this.pendingWrites.indexOf(pending);
			if (index >= 0) {
				this.pendingWrites.splice(index, 1);
			}
			this.pendingBytes -= pending.size;
			pending.resolve();
			this.updateBackpressure();
		});
		this.updateBackpressure();
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
		// Let the async onWriteParsed invalidation land so callers can observe
		// frames/onChange deterministically after flush.
		await new Promise<void>((resolve) => setImmediate(resolve));
	}

	/** Applies a new size to the terminal. Throws on invalid dimensions. */
	resize(cols: number, rows: number): void {
		this.assertNotDisposed();
		validateDimension(cols, "cols");
		validateDimension(rows, "rows");
		this.terminal.resize(cols, rows);
		// Resize invalidates geometry deterministically: the underlying resize
		// is synchronous and buffers are reflowed immediately.
		this.invalidate();
	}

	/** Builds the current snapshot frame from the active buffer. */
	frame(): TerminalFrame {
		this.assertNotDisposed();
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
		if (styles.length > 0) {
			return { cols, rows, lines, cursor, styles };
		}
		return { cols, rows, lines, cursor };
	}

	/**
	 * The owning terminal's active input-protocol state (own VT state, not
	 * telemetry): effective Kitty flags of the active buffer mode, declared
	 * xterm 6 modes, and bounded typed-parser observations for modes xterm 6
	 * does not expose publicly.
	 */
	inputModes(): TerminalInputModes {
		this.assertNotDisposed();
		const modes = this.terminal.modes;
		return {
			kittyFlags: this.effectiveKittyFlags(),
			applicationCursorKeys: modes.applicationCursorKeysMode,
			applicationKeypad: modes.applicationKeypadMode,
			bracketedPaste: modes.bracketedPasteMode,
			mouseTracking: modes.mouseTrackingMode,
			modifyOtherKeys: this.modifyOtherKeys,
			mouseEncoding: this.mouseEncoding,
		};
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
		this.disposed = true;
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

	private paramsContain(params: (number | number[])[], value: number): boolean {
		return params.some((param) =>
			param === value || (Array.isArray(param) && param[0] === value)
		);
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
		const key = JSON.stringify(this.frame()) + "|" + JSON.stringify(this.inputModesState());
		if (key !== this.lastInvalidateKey) {
			this.lastInvalidateKey = key;
			this.safePeerInvoke(() => this.options.onChange?.());
		}
	}

	private inputModesState(): TerminalInputModes {
		const modes = this.terminal.modes;
		return {
			kittyFlags: this.effectiveKittyFlags(),
			applicationCursorKeys: modes.applicationCursorKeysMode,
			applicationKeypad: modes.applicationKeypadMode,
			bracketedPaste: modes.bracketedPasteMode,
			mouseTracking: modes.mouseTrackingMode,
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