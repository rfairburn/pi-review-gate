import { Buffer } from "node:buffer";

/** Validated PNG bytes retained for a hosted terminal's current Kitty images. */
export interface TerminalGraphicsImage {
	/** Kitty's image id, or a surface-local id when the child omitted one. */
	readonly id: string;
	readonly mimeType: "image/png";
	readonly widthPx: number;
	readonly heightPx: number;
	/** Canonical base64 PNG; raw child escape/control bytes are never included. */
	readonly base64: string;
}

/** Pixel-space source rectangle within the PNG. */
export interface TerminalGraphicsCrop {
	readonly x: number;
	readonly y: number;
	readonly width: number;
	readonly height: number;
}

/** Cell-space clipping for an image placement at the viewport edge. */
export interface TerminalGraphicsClip {
	readonly leftColumns: number;
	readonly topRows: number;
	readonly rightColumns: number;
	readonly bottomRows: number;
}

/** Immutable placement expressed in original terminal-cell coordinates. */
export interface TerminalGraphicsPlacement {
	readonly id: string;
	readonly imageId: string;
	readonly column: number;
	readonly row: number;
	readonly columns: number;
	readonly rows: number;
	readonly crop: TerminalGraphicsCrop;
	readonly clip: TerminalGraphicsClip;
}

/**
 * Payload-free alternative for a visible Kitty placement, including when its
 * image data was rejected or the downstream renderer cannot use PNGs.
 * Downstream calls pinned `imageFallback(mimeType, widthPx, heightPx)` and
 * composes that safe text at these captured cell coordinates.
 */
export interface TerminalGraphicsFallback {
	readonly id: string;
	readonly mimeType: "image/png";
	readonly widthPx?: number;
	readonly heightPx?: number;
	readonly column: number;
	readonly row: number;
	readonly columns: number;
	readonly rows: number;
	readonly clip: TerminalGraphicsClip;
}

/** Typed image placements and payload-free fallback alternatives for one frame. */
export interface TerminalGraphicsFrame {
	readonly images: readonly TerminalGraphicsImage[];
	readonly placements: readonly TerminalGraphicsPlacement[];
	readonly fallbacks: readonly TerminalGraphicsFallback[];
}

/** Idempotent resource reservation owned by one retained image/placement. */
export interface TerminalGraphicsBudgetLease {
	release(): void;
}

/** Shared host-level bound; pass one instance to every hosted surface. */
export interface TerminalGraphicsBudget {
	reserveImage(encodedBytes: number, decodedBytes: number, pixels: number): TerminalGraphicsBudgetLease | undefined;
	reserveFallbackImage(): TerminalGraphicsBudgetLease | undefined;
	reservePlacement(fallback?: boolean): TerminalGraphicsBudgetLease | undefined;
	reservePendingTransfer(): TerminalGraphicsBudgetLease | undefined;
	reservePendingBytes(bytes: number): TerminalGraphicsBudgetLease | undefined;
}

/** Public xterm marker surface used only to retain normal-buffer scrollback anchors. */
export interface TerminalGraphicsMarker {
	readonly line: number;
	readonly isDisposed: boolean;
	dispose(): void;
}

/** Event-time position captured after xterm parses the bytes before one APC. */
export interface TerminalGraphicsPosition {
	readonly buffer: "normal" | "alternate";
	readonly column: number;
	/** Absolute buffer line (baseY + cursorY); markers replace it in normal mode. */
	readonly row: number;
	readonly marker?: TerminalGraphicsMarker;
	/** Read a bounded range of alternate-buffer cells through xterm's public API. */
	readonly alternateTextAt?: (row: number, column: number, width: number) => string;
	readonly cols: number;
	readonly rows: number;
}

export type KittyGraphicsPart =
	| { readonly kind: "terminal"; readonly data: string }
	| { readonly kind: "graphics"; readonly command: string }
	| { readonly kind: "discard" }
	| { readonly kind: "graphics-overflow" };

const MAX_APC_BYTES = 4 * 1024 * 1024 + 1024;
const MAX_APC_FRAGMENTS = 4096;
const MAX_GRAPHICS_EVENTS_PER_PUSH = 4096;
const MAX_IMAGE_BASE64_BYTES = 4 * 1024 * 1024;
const MAX_IMAGE_DECODED_BYTES = 3 * 1024 * 1024;
const MAX_IMAGE_CHUNKS = 1024;
const MAX_IMAGE_COUNT = 64;
const MAX_PLACEMENT_COUNT = 256;
const MAX_CACHED_IMAGE_BYTES = 8 * 1024 * 1024;
const MAX_IMAGE_DIMENSION = 8192;
const MAX_IMAGE_PIXELS = 8 * 1024 * 1024;
const MAX_TERMINAL_CELLS = 1000;
const MAX_SHARED_ENCODED_BYTES = 16 * 1024 * 1024;
const MAX_SHARED_DECODED_BYTES = 64 * 1024 * 1024;
const MAX_SHARED_PIXELS = 16 * 1024 * 1024;
const MAX_SHARED_IMAGES = 64;
const MAX_SHARED_FALLBACK_IMAGES = 64;
const MAX_SHARED_PLACEMENTS = 256;
const MAX_SHARED_FALLBACK_PLACEMENTS = 64;
const MAX_SHARED_PENDING_BYTES = 24 * 1024 * 1024;
const MAX_SHARED_PENDING_TRANSFERS = 8;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const PNG_CRC_TABLE = makePngCrcTable();

/**
 * Creates a fixed conservative host-wide budget for retained graphics. The
 * limits are implementation policy, not user configuration; leases make
 * replacement, deletion, and disposal releases explicit and idempotent.
 */
export function createTerminalGraphicsBudget(): TerminalGraphicsBudget {
	let encodedBytes = 0;
	let decodedBytes = 0;
	let pixels = 0;
	let images = 0;
	let fallbackImageCount = 0;
	let placements = 0;
	let fallbackPlacements = 0;
	let pendingBytes = 0;
	let pendingTransfers = 0;
	const lease = (release: () => void): TerminalGraphicsBudgetLease => {
		let active = true;
		return Object.freeze({
			release: () => {
				if (active) {
					active = false;
					release();
				}
			},
		});
	};
	return Object.freeze({
		reserveImage: (encoded: number, decoded: number, pixelCount: number) => {
			if (
				!Number.isSafeInteger(encoded) || encoded < 0
				|| !Number.isSafeInteger(decoded) || decoded < 0
				|| !Number.isSafeInteger(pixelCount) || pixelCount < 0
				|| images >= MAX_SHARED_IMAGES
				|| encodedBytes + encoded > MAX_SHARED_ENCODED_BYTES
				|| decodedBytes + decoded > MAX_SHARED_DECODED_BYTES
				|| pixels + pixelCount > MAX_SHARED_PIXELS
			) {
				return undefined;
			}
			encodedBytes += encoded;
			decodedBytes += decoded;
			pixels += pixelCount;
			images += 1;
			return lease(() => {
				encodedBytes -= encoded;
				decodedBytes -= decoded;
				pixels -= pixelCount;
				images -= 1;
			});
		},
		reserveFallbackImage: () => {
			if (fallbackImageCount >= MAX_SHARED_FALLBACK_IMAGES) {
				return undefined;
			}
			fallbackImageCount += 1;
			return lease(() => {
				fallbackImageCount -= 1;
			});
		},
		reservePlacement: (fallback = false) => {
			if (fallback ? fallbackPlacements >= MAX_SHARED_FALLBACK_PLACEMENTS : placements >= MAX_SHARED_PLACEMENTS) {
				return undefined;
			}
			if (fallback) {
				fallbackPlacements += 1;
			} else {
				placements += 1;
			}
			return lease(() => {
				if (fallback) {
					fallbackPlacements -= 1;
				} else {
					placements -= 1;
				}
			});
		},
		reservePendingTransfer: () => {
			if (pendingTransfers >= MAX_SHARED_PENDING_TRANSFERS) {
				return undefined;
			}
			pendingTransfers += 1;
			return lease(() => {
				pendingTransfers -= 1;
			});
		},
		reservePendingBytes: (bytes: number) => {
			if (
				!Number.isSafeInteger(bytes) || bytes < 0
				|| pendingBytes + bytes > MAX_SHARED_PENDING_BYTES
			) {
				return undefined;
			}
			pendingBytes += bytes;
			return lease(() => {
				pendingBytes -= bytes;
			});
		},
	});
}

type ScanState = "ground" | "escape" | "apc-start" | "opaque" | "kitty" | "kitty-overflow";

/**
 * Incremental escape-aware splitter for the hosted terminal's supported Kitty
 * APC subset. All other input remains an opaque VT stream. OSC, DCS, APC, PM,
 * and SOS envelopes are tracked so an apparent ESC_G inside another control
 * string is never mistaken for a graphics command.
 */
export class KittyGraphicsSplitter {
	private readonly kittyLeases: TerminalGraphicsBudgetLease[] = [];
	private state: ScanState = "ground";
	private pendingApcPrefix = "";
	private opaqueKind: "osc" | "string" = "string";
	private opaqueEscape = false;
	private kittyParts: string[] = [];
	private kittyBytes = 0;
	private kittyFragments = 0;
	private kittyMalformed = false;
	private kittyPendingEscape = false;

	constructor(private readonly budget: TerminalGraphicsBudget = createTerminalGraphicsBudget()) {}

	push(data: string): KittyGraphicsPart[] {
		const parts: KittyGraphicsPart[] = [];
		let terminal = "";
		let offset = 0;
		let graphicsEvents = 0;
		let graphicsOverflowed = false;
		const flushTerminal = () => {
			if (terminal.length > 0) {
				parts.push({ kind: "terminal", data: terminal });
				terminal = "";
			}
		};
		const emitGraphics = () => {
			if (graphicsEvents < MAX_GRAPHICS_EVENTS_PER_PUSH) {
				flushTerminal();
				this.emitKitty(parts);
			} else if (!graphicsOverflowed) {
				flushTerminal();
				parts.push({ kind: "graphics-overflow" });
				graphicsOverflowed = true;
			} else {
				// Keep xterm's parser state aligned while avoiding one queued object
				// per excess control. The source APC itself remains swallowed.
				terminal += "\x1b_G\x1b\\";
			}
			graphicsEvents += 1;
		};

		while (offset < data.length) {
			if (this.state === "kitty" || this.state === "kitty-overflow") {
				if (this.kittyPendingEscape) {
					if (data[offset] === "\\") {
						emitGraphics();
						this.clearKitty();
						this.state = "ground";
						this.kittyPendingEscape = false;
						offset += 1;
						continue;
					}
					this.kittyPendingEscape = false;
					this.appendKitty("\x1b");
				}
				const terminator = findApcTerminator(data, offset);
				if (terminator.start < 0) {
					const end = data.length > offset && data[data.length - 1] === "\x1b"
						? data.length - 1
						: data.length;
					this.appendKitty(data.slice(offset, end));
					if (end < data.length) {
						this.kittyPendingEscape = true;
					}
					offset = data.length;
					break;
				}
				this.appendKitty(data.slice(offset, terminator.start));
				emitGraphics();
				this.clearKitty();
				this.state = "ground";
				offset = terminator.end;
				continue;
			}

			if (this.state === "opaque") {
				const end = findOpaqueTerminator(data, offset, this.opaqueKind, this.opaqueEscape);
				terminal += data.slice(offset, end.end);
				this.opaqueEscape = end.pendingEscape;
				offset = end.end;
				if (end.terminated) {
					this.state = "ground";
					this.opaqueEscape = false;
				}
				continue;
			}

			if (this.state === "escape") {
				const next = data[offset] ?? "";
				if (next === "_") {
					this.pendingApcPrefix = "\x1b_";
					this.state = "apc-start";
					offset += 1;
					continue;
				}
				terminal += `\x1b${next}`;
				offset += 1;
				this.state = "ground";
				const kind = escapedStringKind(next);
				if (kind) {
					this.opaqueKind = kind;
					this.state = "opaque";
				}
				continue;
			}

			if (this.state === "apc-start") {
				const next = data[offset] ?? "";
				if (next === "G") {
					this.state = "kitty";
					this.startKitty();
					this.kittyFragments = 0;
					this.kittyMalformed = false;
					this.kittyPendingEscape = false;
					offset += 1;
					continue;
				}
				terminal += this.pendingApcPrefix + next;
				this.pendingApcPrefix = "";
				offset += 1;
				if (next === "\x9c") {
					this.state = "ground";
				} else {
					this.opaqueKind = "string";
					this.opaqueEscape = next === "\x1b";
					this.state = "opaque";
				}
				continue;
			}

			// Ground state: copy ordinary runs in one operation, and retain only
			// an incomplete ESC/APC prefix needed to identify a cross-write Kitty
			// command. C1 string introducers are recognized for envelope safety.
			const code = data.charCodeAt(offset);
			if (code === 0x1b) {
				offset += 1;
				if (offset < data.length) {
					const next = data[offset] as string;
					if (next === "_") {
						this.pendingApcPrefix = "\x1b_";
						this.state = "apc-start";
						offset += 1;
					} else {
						terminal += `\x1b${next}`;
						offset += 1;
						const kind = escapedStringKind(next);
						if (kind) {
							this.opaqueKind = kind;
							this.state = "opaque";
						}
					}
				} else {
					this.state = "escape";
				}
				continue;
			}
			if (code === 0x9f) {
				this.pendingApcPrefix = "\x9f";
				this.state = "apc-start";
				offset += 1;
				continue;
			}
			const c1Kind = c1StringKind(code);
			if (c1Kind) {
				terminal += data[offset] as string;
				offset += 1;
				this.opaqueKind = c1Kind;
				this.state = "opaque";
				continue;
			}
			const runStart = offset;
			offset += 1;
			while (offset < data.length) {
				const nextCode = data.charCodeAt(offset);
				if (nextCode === 0x1b || nextCode === 0x9f || c1StringKind(nextCode)) {
					break;
				}
				offset += 1;
			}
			terminal += data.slice(runStart, offset);
		}

		flushTerminal();
		return parts;
	}

	/** Forget incomplete control strings on shutdown without emitting them. */
	dispose(): void {
		this.state = "ground";
		this.pendingApcPrefix = "";
		this.opaqueEscape = false;
		this.clearKitty();
	}

	private appendKitty(fragment: string): void {
		if (this.state === "kitty-overflow" || fragment.length === 0) {
			return;
		}
		this.kittyFragments += 1;
		const bytes = Buffer.byteLength(fragment, "utf8");
		if (
			this.kittyFragments > MAX_APC_FRAGMENTS
			|| this.kittyBytes + bytes > MAX_APC_BYTES
		) {
			this.overflowKitty();
			return;
		}
		const lease = this.budget.reservePendingBytes(bytes * 2);
		if (!lease) {
			this.overflowKitty();
			return;
		}
		this.kittyLeases.push(lease);
		if (fragment.includes("\x1b")) {
			this.kittyMalformed = true;
		}
		this.kittyParts.push(fragment);
		this.kittyBytes += bytes;
	}

	private clearKitty(): void {
		for (const lease of this.kittyLeases.splice(0)) {
			lease.release();
		}
		this.kittyParts = [];
		this.kittyBytes = 0;
		this.kittyFragments = 0;
		this.kittyMalformed = false;
		this.kittyPendingEscape = false;
	}

	private startKitty(): void {
		const initialBytesLease = this.budget.reservePendingBytes(2);
		if (!initialBytesLease) {
			this.overflowKitty();
			return;
		}
		this.kittyLeases.push(initialBytesLease);
		this.kittyParts = ["G"];
		this.kittyBytes = 1;
	}

	private overflowKitty(): void {
		for (const lease of this.kittyLeases.splice(0)) {
			lease.release();
		}
		this.kittyParts = [];
		this.kittyBytes = 0;
		this.state = "kitty-overflow";
	}

	private emitKitty(parts: KittyGraphicsPart[]): void {
		if (this.state === "kitty-overflow" || this.kittyMalformed) {
			parts.push({ kind: "discard" });
		} else {
			parts.push({ kind: "graphics", command: this.kittyParts.join("") });
		}
	}
}

interface ParsedCommand {
	readonly params: ReadonlyMap<string, string>;
	readonly payload: string;
	readonly hasPayloadSeparator: boolean;
}

interface TerminalGraphicsCropSpec {
	readonly x?: number;
	readonly y?: number;
	readonly width?: number;
	readonly height?: number;
}

interface PendingTransfer {
	readonly id: string;
	readonly encoded: string[];
	encodedBytes: number;
	chunks: number;
	readonly leases: TerminalGraphicsBudgetLease[];
	pngPrefix: string;
	dimensions?: { readonly widthPx: number; readonly heightPx: number };
	readonly position: TerminalGraphicsPosition;
	readonly columns?: number;
	readonly rows?: number;
	readonly crop: TerminalGraphicsCropSpec;
}

interface AlternateRowSnapshot {
	readonly offset: number;
	readonly textHash: string;
}

interface StoredPlacement {
	readonly id: string;
	readonly imageId: string;
	readonly buffer: "normal" | "alternate";
	readonly column: number;
	readonly row: number;
	readonly marker?: TerminalGraphicsMarker;
	readonly columns: number;
	readonly rows: number;
	readonly crop?: TerminalGraphicsCrop;
	readonly fallbackWidthPx?: number;
	readonly fallbackHeightPx?: number;
	readonly fallbackOnly?: boolean;
	readonly alternateRows?: readonly AlternateRowSnapshot[];
	/**
	 * Alternate placement made inside an open synchronized frame. Its exact
	 * event-time cell position and crop are kept; its footprint text is
	 * anchored only when that frame completes (or is aborted).
	 */
	readonly provisional?: boolean;
	readonly geometryCols: number;
	readonly geometryRows: number;
}

interface ImageFallbackInfo {
	readonly widthPx?: number;
	readonly heightPx?: number;
	readonly columns?: number;
}

/**
 * Per-surface, bounded state for the native Pi Kitty PNG subset. It accepts
 * only direct base64 PNG transfer, payload-free placement/crop, and the three
 * local delete forms; unsupported Kitty commands fail closed and are swallowed
 * by the splitter rather than being passed through as terminal controls.
 */
export class KittyGraphicsState {
	private readonly images = new Map<string, TerminalGraphicsImage>();
	private readonly imageSizes = new Map<string, number>();
	private readonly imageLeases = new Map<string, TerminalGraphicsBudgetLease>();
	private readonly fallbackImages = new Map<string, ImageFallbackInfo>();
	private readonly placements = new Map<string, StoredPlacement>();
	private readonly fallbackLeases = new Map<string, TerminalGraphicsBudgetLease>();
	private readonly placementLeases = new Map<string, TerminalGraphicsBudgetLease>();
	private pending?: PendingTransfer;
	private nextImageId = 1;
	private revisionValue = 0;
	private deferAlternateAnchors = false;
	/** Image/placement identities referenced by the surface's held published snapshot. */
	private readonly publishedImages = new Map<string, TerminalGraphicsImage>();
	private readonly publishedPlacements = new Map<string, StoredPlacement>();
	/** Leases of removed state that the held published snapshot still references. */
	private readonly retainedLeases: TerminalGraphicsBudgetLease[] = [];

	constructor(private readonly budget: TerminalGraphicsBudget = createTerminalGraphicsBudget()) {}

	get revision(): number {
		return this.revisionValue;
	}

	/** Whether processing this Kitty command can create a placement anchor. */
	static needsPosition(command: string): boolean {
		const parsed = parseCommand(command);
		const action = parsed?.params.get("a");
		return action === "p"
			|| (action === "T" && parsed?.params.has("c") === true && parsed.params.has("r") === true);
	}

	process(command: string, position: TerminalGraphicsPosition): void {
		const parsed = parseCommand(command);
		if (!parsed) {
			this.rejectPendingTransfer();
			position.marker?.dispose();
			return;
		}
		const { params, payload, hasPayloadSeparator } = parsed;
		const action = params.get("a");
		if (action === "d") {
			this.cancelPending();
			this.processDelete(params, payload, hasPayloadSeparator, position.buffer);
			return;
		}
		if (action === "p") {
			this.rejectPendingTransfer();
			this.processPlacement(params, payload, hasPayloadSeparator, position);
			return;
		}
		if (action === "T") {
			this.processTransfer(params, payload, hasPayloadSeparator, position);
			return;
		}
		if (this.pending && onlyContinuationParams(params) && hasPayloadSeparator) {
			this.appendTransferChunk(payload, params.get("m") === "1");
			return;
		}
		this.rejectPendingTransfer();
		position.marker?.dispose();
	}

	/** Drop in-progress transfer state after an overlong/malformed APC. */
	discard(): void {
		this.rejectPendingTransfer();
	}

	/** Image assets survive screen/display switches, but geometry-bound placements do not. */
	invalidatePlacements(): void {
		for (const key of [...this.placements.keys()]) {
			this.removePlacement(key);
		}
		this.cancelPending();
	}

	clear(): void {
		this.invalidatePlacements();
		for (const [id, lease] of this.imageLeases) {
			this.releaseImageLease(id, lease);
		}
		for (const lease of this.fallbackLeases.values()) {
			lease.release();
		}
		this.images.clear();
		this.imageSizes.clear();
		this.imageLeases.clear();
		this.fallbackImages.clear();
		this.fallbackLeases.clear();
		this.cancelPending();
		this.revisionValue += 1;
	}

	/** Final teardown: release live state and anything a held snapshot retained. */
	dispose(): void {
		this.releasePublished();
		this.deferAlternateAnchors = false;
		this.clear();
	}

	/**
	 * Start deferring alternate anchor capture: placements made while a
	 * synchronized frame is open keep their exact event-time cell position and
	 * crop, but their footprint text is captured against the completed frame.
	 */
	beginDeferredAlternateAnchors(): void {
		this.deferAlternateAnchors = true;
	}

	/**
	 * Anchor every provisional alternate placement against `textAt` (the
	 * completed frame's alternate cells) and stop deferring. Without a readable
	 * alternate screen the provisional placements are removed, never guessed.
	 */
	finalizeDeferredAlternateAnchors(textAt: TerminalGraphicsPosition["alternateTextAt"]): void {
		this.deferAlternateAnchors = false;
		for (const [key, placement] of this.placements) {
			if (!placement.provisional) {
				continue;
			}
			const alternateRows = textAt === undefined
				? undefined
				: captureAlternateRows(
					textAt,
					placement.column,
					placement.row,
					placement.columns,
					placement.rows,
					placement.geometryRows,
				);
			if (alternateRows === undefined) {
				this.removePlacement(key);
				continue;
			}
			const { provisional, ...rest } = placement;
			void provisional;
			this.placements.set(key, Object.freeze({ ...rest, alternateRows }));
		}
	}

	/** Drop provisional alternate placements whose frame cannot be completed. */
	discardDeferredAlternateAnchors(): void {
		this.finalizeDeferredAlternateAnchors(undefined);
	}

	/**
	 * Mark the images and placements referenced by a held published snapshot.
	 * While held, removing them from live state moves their budget leases to a
	 * retained list instead of releasing them, so payload the snapshot still
	 * references stays charged to the shared budget. Re-pinning releases the
	 * previous snapshot's retained leases.
	 */
	retainPublished(frame: TerminalGraphicsFrame | undefined, buffer: "normal" | "alternate"): void {
		this.releasePublished();
		if (!frame) {
			return;
		}
		for (const image of frame.images) {
			if (this.images.get(image.id) === image) {
				this.publishedImages.set(image.id, image);
			}
		}
		for (const placement of [...frame.placements, ...frame.fallbacks]) {
			const key = `${buffer}:${placement.id}`;
			const stored = this.placements.get(key);
			if (stored) {
				this.publishedPlacements.set(key, stored);
			}
		}
	}

	/** The held snapshot is no longer referenced: release everything it retained. */
	releasePublished(): void {
		this.publishedImages.clear();
		this.publishedPlacements.clear();
		for (const lease of this.retainedLeases.splice(0)) {
			lease.release();
		}
	}

	/** Number of removed-state leases still charged for a held snapshot. */
	get retainedLeaseCount(): number {
		return this.retainedLeases.length;
	}

	/** Track alternate anchors by bounded footprint hashes; destructive controls clear them. */
	validateAlternateScreen(
		textAt: TerminalGraphicsPosition["alternateTextAt"],
		destructive: boolean,
	): void {
		if (destructive) {
			this.clearPlacements("alternate");
			return;
		}
		if (!textAt) {
			return;
		}
		for (const [key, placement] of this.placements) {
			if (placement.buffer !== "alternate" || placement.provisional) {
				continue;
			}
			const anchors = placement.alternateRows;
			const stillAnchored = anchors?.every((anchor) => {
				const row = placement.row + anchor.offset;
				return alternateTextHash(textAt(row, placement.column, placement.columns)) === anchor.textHash;
			}) === true;
			if (!stillAnchored) {
				this.removePlacement(key);
			}
		}
	}

	frame(
		buffer: "normal" | "alternate",
		viewportY: number,
		cols: number,
		rows: number,
	): TerminalGraphicsFrame | undefined {
		const visible: TerminalGraphicsPlacement[] = [];
		const fallbacks: TerminalGraphicsFallback[] = [];
		const usedImages = new Set<string>();
		for (const [key, stored] of this.placements) {
			if (stored.buffer !== buffer) {
				continue;
			}
			if (stored.geometryCols !== cols || stored.geometryRows !== rows) {
				this.removePlacement(key);
				continue;
			}
			if (stored.marker?.isDisposed) {
				this.removePlacement(key);
				continue;
			}
			const image = this.images.get(stored.imageId);
			const row = (stored.marker?.line ?? stored.row) - viewportY;
			const clip = clipPlacement(stored.column, row, stored.columns, stored.rows, cols, rows);
			if (!clip) {
				continue;
			}
			if (image && !stored.fallbackOnly) {
				visible.push(Object.freeze({
					id: stored.id,
					imageId: stored.imageId,
					column: stored.column,
					row,
					columns: stored.columns,
					rows: stored.rows,
					crop: Object.freeze({ ...(stored.crop ?? fullCrop(image.widthPx, image.heightPx)) }),
					clip: Object.freeze(clip),
				}));
				usedImages.add(stored.imageId);
			}
			fallbacks.push(Object.freeze({
				id: stored.id,
				mimeType: "image/png",
				...(stored.fallbackWidthPx === undefined ? {} : { widthPx: stored.fallbackWidthPx }),
				...(stored.fallbackHeightPx === undefined ? {} : { heightPx: stored.fallbackHeightPx }),
				column: stored.column,
				row,
				columns: stored.columns,
				rows: stored.rows,
				clip: Object.freeze(clip),
			}));
		}
		if (visible.length === 0 && fallbacks.length === 0) {
			return undefined;
		}
		const images = [...usedImages]
			.map((id) => this.images.get(id))
			.filter((image): image is TerminalGraphicsImage => image !== undefined);
		return Object.freeze({
			images: Object.freeze(images),
			placements: Object.freeze(visible),
			fallbacks: Object.freeze(fallbacks),
		});
	}

	private processTransfer(
		params: ReadonlyMap<string, string>,
		payload: string,
		hasPayloadSeparator: boolean,
		position: TerminalGraphicsPosition,
	): void {
		this.rejectPendingTransfer();
		if (
			!hasPayloadSeparator
			|| !allowedKeys(params, ["a", "f", "q", "C", "c", "r", "i", "m", "x", "y", "w", "h", "X", "Y"])
			|| params.get("f") !== "100"
			|| (params.has("q") && params.get("q") !== "2")
			|| params.get("C") !== "1"
			|| !validZeroOffset(params)
		) {
			position.marker?.dispose();
			return;
		}
		const idParam = params.get("i");
		const id = idParam === undefined ? `local-${this.nextImageId++}` : imageId(idParam);
		const columns = optionalCellDimension(params.get("c"));
		const rows = optionalCellDimension(params.get("r"));
		if (id === undefined || (params.has("c") && columns === undefined) || (params.has("r") && rows === undefined)) {
			position.marker?.dispose();
			return;
		}
		const more = params.get("m");
		if (more !== undefined && more !== "0" && more !== "1") {
			position.marker?.dispose();
			return;
		}
		const crop = parseCropSpec(params);
		if (!crop) {
			position.marker?.dispose();
			return;
		}
		this.removeCachedImage(id);
		this.removePlacementsForImage(id);
		const pending: PendingTransfer = {
			id,
			encoded: [payload],
			encodedBytes: Buffer.byteLength(payload, "utf8"),
			chunks: 1,
			leases: [],
			pngPrefix: "",
			position,
			...(columns === undefined ? {} : { columns }),
			...(rows === undefined ? {} : { rows }),
			crop,
		};
		this.captureTransferDimensions(pending, payload);
		if (!isBase64Fragment(payload) || pending.encodedBytes > MAX_IMAGE_BASE64_BYTES) {
			this.rejectTransfer(pending);
			return;
		}
		if (more === "1") {
			const transferLease = this.budget.reservePendingTransfer();
			const bytesLease = this.budget.reservePendingBytes(pending.encodedBytes * 2);
			if (!transferLease || !bytesLease) {
				transferLease?.release();
				bytesLease?.release();
				this.rejectTransfer(pending);
				return;
			}
			pending.leases.push(transferLease, bytesLease);
			this.pending = pending;
			return;
		}
		this.finishTransfer(pending);
	}

	private appendTransferChunk(payload: string, more: boolean): void {
		const pending = this.pending;
		if (!pending) {
			return;
		}
		const bytes = Buffer.byteLength(payload, "utf8");
		pending.chunks += 1;
		pending.encodedBytes += bytes;
		this.captureTransferDimensions(pending, payload);
		if (
			pending.chunks > MAX_IMAGE_CHUNKS
			|| pending.encodedBytes > MAX_IMAGE_BASE64_BYTES
			|| !isBase64Fragment(payload)
		) {
			this.pending = undefined;
			this.rejectTransfer(pending);
			return;
		}
		const bytesLease = this.budget.reservePendingBytes(bytes * 2);
		if (!bytesLease) {
			this.pending = undefined;
			this.rejectTransfer(pending);
			return;
		}
		pending.leases.push(bytesLease);
		pending.encoded.push(payload);
		if (!more) {
			this.pending = undefined;
			this.finishTransfer(pending);
		}
	}

	private finishTransfer(pending: PendingTransfer): void {
		let joinedLease: TerminalGraphicsBudgetLease | undefined;
		let decodeLease: TerminalGraphicsBudgetLease | undefined;
		try {
			if (pending.leases.length > 0) {
				joinedLease = this.budget.reservePendingBytes(pending.encodedBytes * 2);
				decodeLease = joinedLease ? this.budget.reservePendingBytes(MAX_IMAGE_DECODED_BYTES) : undefined;
				if (!joinedLease || !decodeLease) {
					this.rejectTransfer(pending);
					return;
				}
			}
			const base64 = pending.encoded.join("");
			if (!isBase64WithinLimit(base64)) {
				this.rejectTransfer(pending);
				return;
			}
			const validated = decodePng(base64);
			if (!validated) {
				this.rejectTransfer(pending);
				return;
			}
			const crop = materializeCrop(pending.crop, validated.widthPx, validated.heightPx);
			if (!validCrop(crop, validated.widthPx, validated.heightPx)) {
				if (pending.columns !== undefined && pending.rows !== undefined) {
					this.rememberFallback(pending.id, {
						widthPx: validated.widthPx,
						heightPx: validated.heightPx,
						columns: pending.columns,
					});
					this.addFallbackPlacement(
						pending.id,
						pending.position,
						pending.columns,
						pending.rows,
						validated.widthPx,
						validated.heightPx,
					);
				} else {
					pending.position.marker?.dispose();
				}
				return;
			}
			const image: TerminalGraphicsImage = Object.freeze({
				id: pending.id,
				mimeType: "image/png",
				widthPx: validated.widthPx,
				heightPx: validated.heightPx,
				base64,
			});
			const pixels = validated.widthPx * validated.heightPx;
			const stored = this.storeImage(
				image,
				Buffer.byteLength(base64, "ascii"),
				validated.byteLength + pixels * 4,
				pixels,
				pending.columns,
			);
			if (stored && pending.columns !== undefined && pending.rows !== undefined) {
				this.addPlacement(pending.id, pending.position, pending.columns, pending.rows, crop);
			} else if (!stored && pending.columns !== undefined && pending.rows !== undefined) {
				this.rememberFallback(pending.id, {
					widthPx: validated.widthPx,
					heightPx: validated.heightPx,
					columns: pending.columns,
				});
				this.addFallbackPlacement(
					pending.id,
					pending.position,
					pending.columns,
					pending.rows,
					validated.widthPx,
					validated.heightPx,
				);
			} else {
				pending.position.marker?.dispose();
			}
		} finally {
			joinedLease?.release();
			decodeLease?.release();
			this.releasePending(pending);
		}
	}

	private processPlacement(
		params: ReadonlyMap<string, string>,
		payload: string,
		hasPayloadSeparator: boolean,
		position: TerminalGraphicsPosition,
	): void {
		if (
			hasPayloadSeparator
			|| payload.length > 0
			|| !allowedKeys(params, ["a", "i", "p", "c", "r", "x", "y", "w", "h", "X", "Y", "q", "C"])
			|| (params.has("q") && params.get("q") !== "2")
			|| (params.has("C") && params.get("C") !== "1")
			|| !validZeroOffset(params)
		) {
			position.marker?.dispose();
			return;
		}
		const id = imageId(params.get("i"));
		const image = id === undefined ? undefined : this.images.get(id);
		const prior = id === undefined
			? undefined
			: [...this.placements.values()].find((placement) => placement.imageId === id);
		const fallback = id === undefined
			? undefined
			: this.fallbackImages.get(id) ?? (prior ? {
				widthPx: prior.fallbackWidthPx,
				heightPx: prior.fallbackHeightPx,
				columns: prior.columns,
			} : undefined);
		if (!id || (!image && !fallback)) {
			position.marker?.dispose();
			return;
		}
		const columns = optionalCellDimension(params.get("c")) ?? fallback?.columns;
		const rows = optionalCellDimension(params.get("r"));
		if (columns === undefined || rows === undefined
			|| (params.has("c") && optionalCellDimension(params.get("c")) === undefined)) {
			position.marker?.dispose();
			return;
		}
		let crop: TerminalGraphicsCrop | undefined;
		if (image) {
			crop = parseCrop(params, image);
			if (!crop || !validCrop(crop, image.widthPx, image.heightPx)) {
				position.marker?.dispose();
				return;
			}
		} else if (!validFallbackCrop(params, fallback)) {
			position.marker?.dispose();
			return;
		}
		const placementIdValue = params.get("p");
		const placementId = placementIdValue === undefined
			? `image-${id}`
			: numericId(placementIdValue) === undefined ? undefined : `placement-${placementIdValue}`;
		if (!placementId) {
			position.marker?.dispose();
			return;
		}
		if (image && crop) {
			this.addPlacement(id, position, columns, rows, crop, placementId);
		} else {
			this.addFallbackPlacement(
				id,
				position,
				columns,
				rows,
				fallback?.widthPx,
				fallback?.heightPx,
				placementId,
			);
		}
	}

	private processDelete(
		params: ReadonlyMap<string, string>,
		payload: string,
		hasPayloadSeparator: boolean,
		buffer: "normal" | "alternate",
	): void {
		if (
			hasPayloadSeparator
			|| payload.length > 0
			|| !allowedKeys(params, ["a", "d", "i", "p", "q"])
			|| (params.has("q") && params.get("q") !== "2")
		) {
			return;
		}
		const deletion = params.get("d");
		if (deletion === "a") {
			this.clearPlacements(buffer);
			return;
		}
		if (deletion === "A") {
			this.clear();
			return;
		}
		if (deletion !== "I") {
			return;
		}
		const idValue = params.get("i");
		const placementValue = params.get("p");
		if (idValue !== undefined && imageId(idValue) !== undefined) {
			const id = imageId(idValue) as string;
			this.removeCachedImage(id);
			for (const [key, placement] of this.placements) {
				if (placement.imageId === id) {
					this.removePlacement(key);
				}
			}
			if (this.pending?.id === id) {
				this.cancelPending();
			}
			return;
		}
		if (placementValue !== undefined && numericId(placementValue) !== undefined) {
			this.removePlacement(`${buffer}:placement-${placementValue}`);
		}
	}

	private storeImage(
		image: TerminalGraphicsImage,
		encodedBytes: number,
		decodedBytes: number,
		pixels: number,
		columns?: number,
	): boolean {
		this.removeCachedImage(image.id);
		this.removePlacementsForImage(image.id);
		if (encodedBytes > MAX_CACHED_IMAGE_BYTES) {
			this.rememberFallback(image.id, {
				widthPx: image.widthPx,
				heightPx: image.heightPx,
				...(columns === undefined ? {} : { columns }),
			});
			return false;
		}
		let cachedBytes = [...this.imageSizes.values()].reduce((sum, size) => sum + size, 0);
		while (
			this.images.size >= MAX_IMAGE_COUNT
			|| cachedBytes + encodedBytes > MAX_CACHED_IMAGE_BYTES
		) {
			const oldest = this.images.keys().next().value as string | undefined;
			if (oldest === undefined) {
				return false;
			}
			cachedBytes -= this.imageSizes.get(oldest) ?? 0;
			this.removeCachedImage(oldest);
		}
		const lease = this.budget.reserveImage(encodedBytes * 2, decodedBytes, pixels);
		if (!lease) {
			this.rememberFallback(image.id, {
				widthPx: image.widthPx,
				heightPx: image.heightPx,
				...(columns === undefined ? {} : { columns }),
			});
			return false;
		}
		this.images.set(image.id, image);
		this.imageSizes.set(image.id, encodedBytes);
		this.imageLeases.set(image.id, lease);
		this.rememberFallback(image.id, {
			widthPx: image.widthPx,
			heightPx: image.heightPx,
			...(columns === undefined ? {} : { columns }),
		});
		this.revisionValue += 1;
		return true;
	}

	private addPlacement(
		imageIdValue: string,
		position: TerminalGraphicsPosition,
		columns: number,
		rows: number,
		crop: TerminalGraphicsCrop,
		requestedId?: string,
	): void {
		if (
			!this.images.has(imageIdValue)
			|| columns < 1 || columns > MAX_TERMINAL_CELLS
			|| rows < 1 || rows > MAX_TERMINAL_CELLS
			|| !Number.isSafeInteger(position.column)
			|| !Number.isSafeInteger(position.row)
		) {
			position.marker?.dispose();
			return;
		}
		const id = requestedId ?? `image-${imageIdValue}`;
		const key = `${position.buffer}:${id}`;
		this.removePlacement(key);
		while (this.placements.size >= MAX_PLACEMENT_COUNT) {
			const oldest = this.placements.keys().next().value as string | undefined;
			if (oldest === undefined) {
				return;
			}
			this.removePlacement(oldest);
		}
		if (position.buffer === "normal" && !position.marker) {
			return;
		}
		const placementLease = this.budget.reservePlacement();
		if (!placementLease) {
			const image = this.images.get(imageIdValue);
			if (image) {
				this.addFallbackPlacement(
					imageIdValue,
					position,
					columns,
					rows,
					image.widthPx,
					image.heightPx,
					id,
				);
			} else {
				position.marker?.dispose();
			}
			return;
		}
		const image = this.images.get(imageIdValue) as TerminalGraphicsImage;
		const provisional = position.buffer === "alternate" && this.deferAlternateAnchors;
		const alternateRows = position.buffer === "alternate" && !provisional
			? capturePositionAlternateRows(position, columns, rows)
			: undefined;
		this.placements.set(key, {
			id,
			imageId: imageIdValue,
			buffer: position.buffer,
			column: position.column,
			row: position.row,
			...(position.marker === undefined ? {} : { marker: position.marker }),
			columns,
			rows,
			crop: Object.freeze({ ...crop }),
			fallbackWidthPx: image.widthPx,
			fallbackHeightPx: image.heightPx,
			...(alternateRows === undefined ? {} : { alternateRows }),
			...(provisional ? { provisional } : {}),
			geometryCols: position.cols,
			geometryRows: position.rows,
		});
		this.placementLeases.set(key, placementLease);
		this.revisionValue += 1;
	}

	private addFallbackPlacement(
		imageIdValue: string,
		position: TerminalGraphicsPosition,
		columns: number,
		rows: number,
		widthPx?: number,
		heightPx?: number,
		requestedId?: string,
	): void {
		if (
			columns < 1 || columns > MAX_TERMINAL_CELLS
			|| rows < 1 || rows > MAX_TERMINAL_CELLS
			|| !Number.isSafeInteger(position.column)
			|| !Number.isSafeInteger(position.row)
		) {
			position.marker?.dispose();
			return;
		}
		const id = requestedId ?? `image-${imageIdValue}`;
		const key = `${position.buffer}:${id}`;
		this.removePlacement(key);
		while (this.placements.size >= MAX_PLACEMENT_COUNT) {
			const oldest = this.placements.keys().next().value as string | undefined;
			if (oldest === undefined) {
				position.marker?.dispose();
				return;
			}
			this.removePlacement(oldest);
		}
		if (position.buffer === "normal" && !position.marker) {
			return;
		}
		const placementLease = this.budget.reservePlacement(true);
		if (!placementLease) {
			position.marker?.dispose();
			return;
		}
		const provisional = position.buffer === "alternate" && this.deferAlternateAnchors;
		const alternateRows = position.buffer === "alternate" && !provisional
			? capturePositionAlternateRows(position, columns, rows)
			: undefined;
		this.placements.set(key, {
			id,
			imageId: imageIdValue,
			buffer: position.buffer,
			column: position.column,
			row: position.row,
			...(position.marker === undefined ? {} : { marker: position.marker }),
			columns,
			rows,
			...(widthPx === undefined ? {} : { fallbackWidthPx: widthPx }),
			...(heightPx === undefined ? {} : { fallbackHeightPx: heightPx }),
			fallbackOnly: true,
			...(alternateRows === undefined ? {} : { alternateRows }),
			...(provisional ? { provisional } : {}),
			geometryCols: position.cols,
			geometryRows: position.rows,
		});
		this.placementLeases.set(key, placementLease);
		this.revisionValue += 1;
	}

	private removePlacement(id: string): void {
		const placement = this.placements.get(id);
		if (!placement) {
			return;
		}
		this.placements.delete(id);
		const lease = this.placementLeases.get(id);
		this.placementLeases.delete(id);
		if (lease && this.publishedPlacements.get(id) === placement) {
			// The held snapshot still shows this placement; keep it charged.
			this.publishedPlacements.delete(id);
			this.retainedLeases.push(lease);
		} else {
			lease?.release();
		}
		placement.marker?.dispose();
		this.revisionValue += 1;
	}

	private releaseImageLease(id: string, lease: TerminalGraphicsBudgetLease): void {
		const image = this.images.get(id);
		if (image !== undefined && this.publishedImages.get(id) === image) {
			// The held snapshot still references this exact payload string.
			this.publishedImages.delete(id);
			this.retainedLeases.push(lease);
			return;
		}
		lease.release();
	}

	private clearPlacements(buffer?: "normal" | "alternate"): void {
		for (const [key, placement] of this.placements) {
			if (buffer === undefined || placement.buffer === buffer) {
				this.removePlacement(key);
			}
		}
	}

	private removeCachedImage(id: string): void {
		const existed = this.images.has(id)
			|| this.imageSizes.has(id)
			|| this.fallbackImages.has(id)
			|| this.imageLeases.has(id)
			|| this.fallbackLeases.has(id);
		const imageLease = this.imageLeases.get(id);
		if (imageLease) {
			this.releaseImageLease(id, imageLease);
		}
		this.images.delete(id);
		this.imageSizes.delete(id);
		this.imageLeases.delete(id);
		this.fallbackImages.delete(id);
		this.fallbackLeases.get(id)?.release();
		this.fallbackLeases.delete(id);
		if (existed) {
			this.revisionValue += 1;
		}
	}

	private removePlacementsForImage(id: string): void {
		for (const [key, placement] of this.placements) {
			if (placement.imageId === id) {
				this.removePlacement(key);
			}
		}
	}

	private rememberFallback(id: string, info: ImageFallbackInfo): boolean {
		if (!this.imageLeases.has(id) && !this.fallbackLeases.has(id)) {
			const lease = this.budget.reserveFallbackImage();
			if (!lease) {
				return false;
			}
			this.fallbackLeases.set(id, lease);
		}
		this.fallbackImages.set(id, Object.freeze({ ...info }));
		this.revisionValue += 1;
		return true;
	}

	private captureTransferDimensions(pending: PendingTransfer, fragment: string): void {
		if (pending.dimensions || pending.pngPrefix.length >= 44) {
			return;
		}
		const needed = 44 - pending.pngPrefix.length;
		pending.pngPrefix += fragment.slice(0, needed);
		if (pending.pngPrefix.length === 44) {
			pending.dimensions = inspectPngDimensions(pending.pngPrefix);
		}
	}

	private rejectTransfer(pending: PendingTransfer): void {
		try {
			const widthPx = pending.dimensions?.widthPx;
			const heightPx = pending.dimensions?.heightPx;
			if (pending.columns !== undefined && pending.rows !== undefined) {
				this.rememberFallback(pending.id, {
					...(widthPx === undefined ? {} : { widthPx }),
					...(heightPx === undefined ? {} : { heightPx }),
					columns: pending.columns,
				});
				this.addFallbackPlacement(
					pending.id,
					pending.position,
					pending.columns,
					pending.rows,
					widthPx,
					heightPx,
				);
			} else {
				pending.position.marker?.dispose();
			}
		} finally {
			this.releasePending(pending);
		}
	}

	private rejectPendingTransfer(): void {
		const pending = this.pending;
		if (!pending) {
			return;
		}
		this.pending = undefined;
		this.rejectTransfer(pending);
	}

	private cancelPending(): void {
		if (this.pending) {
			this.pending.position.marker?.dispose();
			this.releasePending(this.pending);
		}
		this.pending = undefined;
	}

	private releasePending(pending: PendingTransfer): void {
		for (const lease of pending.leases.splice(0)) {
			lease.release();
		}
	}
}

function parseCommand(command: string): ParsedCommand | undefined {
	if (!command.startsWith("G") || !/^[\x20-\x7e]*$/.test(command)) {
		return undefined;
	}
	const separator = command.indexOf(";");
	const header = separator < 0 ? command.slice(1) : command.slice(1, separator);
	const payload = separator < 0 ? "" : command.slice(separator + 1);
	const params = new Map<string, string>();
	if (header.length === 0) {
		return undefined;
	}
	for (const field of header.split(",")) {
		const equals = field.indexOf("=");
		if (equals <= 0 || equals !== field.lastIndexOf("=")) {
			return undefined;
		}
		const key = field.slice(0, equals);
		const value = field.slice(equals + 1);
		if (!/^[a-zA-Z]$/.test(key) || value.length === 0 || params.has(key)) {
			return undefined;
		}
		params.set(key, value);
	}
	return { params, payload, hasPayloadSeparator: separator >= 0 };
}

function allowedKeys(params: ReadonlyMap<string, string>, allowed: readonly string[]): boolean {
	return [...params.keys()].every((key) => allowed.includes(key));
}

function onlyContinuationParams(params: ReadonlyMap<string, string>): boolean {
	return params.size === 1 && params.has("m") && ["0", "1"].includes(params.get("m") ?? "");
}

function isBase64Fragment(value: string): boolean {
	return /^[A-Za-z0-9+/]*={0,2}$/.test(value);
}

function isBase64WithinLimit(value: string): boolean {
	return value.length > 0
		&& value.length <= MAX_IMAGE_BASE64_BYTES
		&& value.length % 4 === 0
		&& /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value);
}

function decodePng(base64: string): {
	readonly widthPx: number;
	readonly heightPx: number;
	readonly byteLength: number;
} | undefined {
	if (!isBase64WithinLimit(base64)) {
		return undefined;
	}
	const bytes = Buffer.from(base64, "base64");
	if (
		bytes.length > MAX_IMAGE_DECODED_BYTES
		|| bytes.toString("base64") !== base64
		|| bytes.length < 45
		|| !bytes.subarray(0, 8).equals(PNG_SIGNATURE)
	) {
		return undefined;
	}
	let offset = 8;
	let widthPx = 0;
	let heightPx = 0;
	let sawHeader = false;
	let sawData = false;
	let sawEnd = false;
	while (offset < bytes.length) {
		if (offset + 12 > bytes.length) {
			return undefined;
		}
		const length = bytes.readUInt32BE(offset);
		if (length > bytes.length - offset - 12) {
			return undefined;
		}
		const type = bytes.toString("ascii", offset + 4, offset + 8);
		const dataStart = offset + 8;
		const crcOffset = dataStart + length;
		if (readPngCrc(bytes, offset + 4, crcOffset) !== bytes.readUInt32BE(crcOffset)) {
			return undefined;
		}
		if (!sawHeader) {
			if (type !== "IHDR" || length !== 13) {
				return undefined;
			}
			widthPx = bytes.readUInt32BE(dataStart);
			heightPx = bytes.readUInt32BE(dataStart + 4);
			const bitDepth = bytes[dataStart + 8] as number;
			const colorType = bytes[dataStart + 9] as number;
			if (
				widthPx < 1 || heightPx < 1
				|| widthPx > MAX_IMAGE_DIMENSION || heightPx > MAX_IMAGE_DIMENSION
				|| widthPx * heightPx > MAX_IMAGE_PIXELS
				|| !validPngDepth(bitDepth, colorType)
				|| bytes[dataStart + 10] !== 0
				|| bytes[dataStart + 11] !== 0
				|| (bytes[dataStart + 12] !== 0 && bytes[dataStart + 12] !== 1)
			) {
				return undefined;
			}
			sawHeader = true;
		} else if (type === "IHDR") {
			return undefined;
		}
		if (type === "acTL") {
			return undefined;
		}
		if (type === "IDAT") {
			sawData = true;
		}
		if (type === "IEND") {
			if (length !== 0 || crcOffset + 4 !== bytes.length || !sawData) {
				return undefined;
			}
			sawEnd = true;
			break;
		}
		offset = crcOffset + 4;
	}
	if (!sawHeader || !sawData || !sawEnd) {
		return undefined;
	}
	return { widthPx, heightPx, byteLength: bytes.length };
}

function inspectPngDimensions(base64Header: string): { readonly widthPx: number; readonly heightPx: number } | undefined {
	if (base64Header.length !== 44 || !isBase64WithinLimit(base64Header)) {
		return undefined;
	}
	const bytes = Buffer.from(base64Header, "base64");
	if (
		bytes.length !== 33
		|| bytes.toString("base64") !== base64Header
		|| !bytes.subarray(0, 8).equals(PNG_SIGNATURE)
		|| bytes.readUInt32BE(8) !== 13
		|| bytes.toString("ascii", 12, 16) !== "IHDR"
		|| readPngCrc(bytes, 12, 29) !== bytes.readUInt32BE(29)
	) {
		return undefined;
	}
	const widthPx = bytes.readUInt32BE(16);
	const heightPx = bytes.readUInt32BE(20);
	const bitDepth = bytes[24] as number;
	const colorType = bytes[25] as number;
	if (
		widthPx < 1 || heightPx < 1
		|| widthPx > MAX_IMAGE_DIMENSION || heightPx > MAX_IMAGE_DIMENSION
		|| widthPx * heightPx > MAX_IMAGE_PIXELS
		|| !validPngDepth(bitDepth, colorType)
		|| bytes[26] !== 0
		|| bytes[27] !== 0
		|| (bytes[28] !== 0 && bytes[28] !== 1)
	) {
		return undefined;
	}
	return { widthPx, heightPx };
}

function validPngDepth(bitDepth: number, colorType: number): boolean {
	if (colorType === 0) {
		return [1, 2, 4, 8, 16].includes(bitDepth);
	}
	if (colorType === 2 || colorType === 4 || colorType === 6) {
		return bitDepth === 8 || bitDepth === 16;
	}
	return colorType === 3 && [1, 2, 4, 8].includes(bitDepth);
}

function readPngCrc(bytes: Buffer, start: number, end: number): number {
	let crc = 0xffffffff;
	for (let index = start; index < end; index += 1) {
		crc = (PNG_CRC_TABLE[(crc ^ (bytes[index] as number)) & 0xff] as number) ^ (crc >>> 8);
	}
	return (crc ^ 0xffffffff) >>> 0;
}

function makePngCrcTable(): Uint32Array {
	const table = new Uint32Array(256);
	for (let index = 0; index < table.length; index += 1) {
		let value = index;
		for (let bit = 0; bit < 8; bit += 1) {
			value = (value & 1) ? (0xedb88320 ^ (value >>> 1)) : value >>> 1;
		}
		table[index] = value >>> 0;
	}
	return table;
}

function imageId(value: string | undefined): string | undefined {
	const numeric = value === undefined ? undefined : numericId(value);
	return numeric === undefined ? undefined : `kitty-${numeric}`;
}

function numericId(value: string): number | undefined {
	if (!/^(?:0|[1-9][0-9]{0,9})$/.test(value)) {
		return undefined;
	}
	const numeric = Number(value);
	return Number.isSafeInteger(numeric) && numeric <= 0xffffffff ? numeric : undefined;
}

function optionalCellDimension(value: string | undefined): number | undefined {
	if (value === undefined || !/^[1-9][0-9]{0,3}$/.test(value)) {
		return undefined;
	}
	const numeric = Number(value);
	return numeric <= MAX_TERMINAL_CELLS ? numeric : undefined;
}

function validZeroOffset(params: ReadonlyMap<string, string>): boolean {
	for (const key of ["X", "Y"]) {
		const value = params.get(key);
		if (value !== undefined && value !== "0") {
			return false;
		}
	}
	return true;
}

function parseCrop(
	params: ReadonlyMap<string, string>,
	image: Pick<TerminalGraphicsImage, "widthPx" | "heightPx"> | undefined,
): TerminalGraphicsCrop | undefined {
	const xValue = optionalPixel(params.get("x"));
	const yValue = optionalPixel(params.get("y"));
	const widthValue = optionalPixel(params.get("w"));
	const heightValue = optionalPixel(params.get("h"));
	if (
		(params.has("x") && xValue === undefined)
		|| (params.has("y") && yValue === undefined)
		|| (params.has("w") && widthValue === undefined)
		|| (params.has("h") && heightValue === undefined)
	) {
		return undefined;
	}
	const x = xValue ?? 0;
	const y = yValue ?? 0;
	const width = widthValue ?? image?.widthPx;
	const height = heightValue ?? (image ? image.heightPx - y : undefined);
	if (width === undefined || height === undefined) {
		return image ? fullCrop(image.widthPx, image.heightPx) : undefined;
	}
	return { x, y, width, height };
}

function parseCropSpec(params: ReadonlyMap<string, string>): TerminalGraphicsCropSpec | undefined {
	const x = optionalPixel(params.get("x"));
	const y = optionalPixel(params.get("y"));
	const width = optionalPixel(params.get("w"));
	const height = optionalPixel(params.get("h"));
	if (
		(params.has("x") && x === undefined)
		|| (params.has("y") && y === undefined)
		|| (params.has("w") && width === undefined)
		|| (params.has("h") && height === undefined)
	) {
		return undefined;
	}
	return {
		...(x === undefined ? {} : { x }),
		...(y === undefined ? {} : { y }),
		...(width === undefined ? {} : { width }),
		...(height === undefined ? {} : { height }),
	};
}

function materializeCrop(spec: TerminalGraphicsCropSpec, widthPx: number, heightPx: number): TerminalGraphicsCrop {
	const x = spec.x ?? 0;
	const y = spec.y ?? 0;
	return {
		x,
		y,
		width: spec.width ?? widthPx - x,
		height: spec.height ?? heightPx - y,
	};
}

function optionalPixel(value: string | undefined): number | undefined {
	if (value === undefined || !/^(?:0|[1-9][0-9]{0,8})$/.test(value)) {
		return undefined;
	}
	const numeric = Number(value);
	return Number.isSafeInteger(numeric) ? numeric : undefined;
}

function fullCrop(width: number, height: number): TerminalGraphicsCrop {
	return { x: 0, y: 0, width, height };
}

function validCrop(crop: TerminalGraphicsCrop, width: number, height: number): boolean {
	return Number.isSafeInteger(crop.x)
		&& Number.isSafeInteger(crop.y)
		&& Number.isSafeInteger(crop.width)
		&& Number.isSafeInteger(crop.height)
		&& crop.x >= 0 && crop.y >= 0 && crop.width > 0 && crop.height > 0
		&& crop.x + crop.width <= width
		&& crop.y + crop.height <= height;
}

function validFallbackCrop(params: ReadonlyMap<string, string>, info: ImageFallbackInfo | undefined): boolean {
	const dimensions = info?.widthPx !== undefined && info.heightPx !== undefined
		? { widthPx: info.widthPx, heightPx: info.heightPx }
		: undefined;
	if (dimensions) {
		const crop = parseCrop(params, dimensions);
		return crop !== undefined && validCrop(crop, dimensions.widthPx, dimensions.heightPx);
	}
	for (const key of ["x", "y", "w", "h"]) {
		const value = params.get(key);
		if (value === undefined) {
			continue;
		}
		const pixels = optionalPixel(value);
		if (pixels === undefined || pixels > MAX_IMAGE_DIMENSION || ((key === "w" || key === "h") && pixels === 0)) {
			return false;
		}
	}
	return true;
}

function capturePositionAlternateRows(
	position: TerminalGraphicsPosition,
	columns: number,
	rows: number,
): readonly AlternateRowSnapshot[] | undefined {
	const textAt = position.alternateTextAt;
	if (!textAt) {
		return undefined;
	}
	return captureAlternateRows(textAt, position.column, position.row, columns, rows, position.rows);
}

function captureAlternateRows(
	textAt: (row: number, column: number, width: number) => string,
	column: number,
	topRow: number,
	columns: number,
	rows: number,
	screenRows: number,
): readonly AlternateRowSnapshot[] | undefined {
	const snapshots: AlternateRowSnapshot[] = [];
	const firstRow = Math.max(0, topRow);
	const endRow = Math.min(screenRows, topRow + rows);
	for (let row = firstRow; row < endRow; row += 1) {
		snapshots.push(Object.freeze({
			offset: row - topRow,
			textHash: alternateTextHash(textAt(row, column, columns)),
		}));
	}
	return snapshots.length === 0 ? undefined : Object.freeze(snapshots);
}

function alternateTextHash(text: string): string {
	let first = 0x811c9dc5;
	let second = 0x9e3779b9;
	for (let index = 0; index < text.length; index += 1) {
		const code = text.charCodeAt(index);
		first = Math.imul(first ^ code, 0x01000193);
		second = Math.imul(second ^ (code + index), 0x85ebca6b);
	}
	return `${first >>> 0}:${second >>> 0}`;
}

function clipPlacement(
	column: number,
	row: number,
	columns: number,
	rows: number,
	viewportCols: number,
	viewportRows: number,
): TerminalGraphicsClip | undefined {
	const clip: TerminalGraphicsClip = {
		leftColumns: Math.max(0, -column),
		topRows: Math.max(0, -row),
		rightColumns: Math.max(0, column + columns - viewportCols),
		bottomRows: Math.max(0, row + rows - viewportRows),
	};
	if (clip.leftColumns >= columns || clip.topRows >= rows
		|| clip.rightColumns >= columns || clip.bottomRows >= rows
		|| clip.leftColumns + clip.rightColumns >= columns
		|| clip.topRows + clip.bottomRows >= rows) {
		return undefined;
	}
	return clip;
}

function escapedStringKind(value: string): "osc" | "string" | undefined {
	if (value === "]") {
		return "osc";
	}
	if (value === "P" || value === "^" || value === "X") {
		return "string";
	}
	return undefined;
}

function c1StringKind(code: number): "osc" | "string" | undefined {
	if (code === 0x9d) {
		return "osc";
	}
	if (code === 0x90 || code === 0x9e || code === 0x98) {
		return "string";
	}
	return undefined;
}

function findApcTerminator(data: string, start: number): { readonly start: number; readonly end: number } {
	for (let index = start; index < data.length; index += 1) {
		const code = data.charCodeAt(index);
		if (code === 0x9c) {
			return { start: index, end: index + 1 };
		}
		if (code === 0x1b) {
			if (index + 1 < data.length && data[index + 1] === "\\") {
				return { start: index, end: index + 2 };
			}
			if (index + 1 < data.length) {
				// Escape bytes inside base64/control payloads are invalid, but the
				// candidate remains swallowed through its real string terminator.
				index += 1;
			}
		}
	}
	return { start: -1, end: data.length };
}

function findOpaqueTerminator(
	data: string,
	start: number,
	kind: "osc" | "string",
	pendingEscape: boolean,
): { readonly end: number; readonly terminated: boolean; readonly pendingEscape: boolean } {
	if (pendingEscape && start < data.length && data[start] === "\\") {
		return { end: start + 1, terminated: true, pendingEscape: false };
	}
	let index = start;
	while (index < data.length) {
		const code = data.charCodeAt(index);
		if (code === 0x9c || (kind === "osc" && code === 0x07)) {
			return { end: index + 1, terminated: true, pendingEscape: false };
		}
		if (code === 0x1b) {
			if (index + 1 < data.length) {
				if (data[index + 1] === "\\") {
					return { end: index + 2, terminated: true, pendingEscape: false };
				}
				index += 2;
			} else {
				return { end: index + 1, terminated: false, pendingEscape: true };
			}
		} else {
			index += 1;
		}
	}
	return { end: data.length, terminated: false, pendingEscape: false };
}
