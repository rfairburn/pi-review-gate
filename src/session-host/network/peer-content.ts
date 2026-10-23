/**
 * Pure selected-content contracts for the ONE peer coordinator (#389 selection
 * phase).
 *
 * Importing this file allocates nothing and starts nothing: it declares the
 * display/controller DTOs behind the globally selected outgoing native viewport
 * stream, plus the composed coordinator interface the production factory
 * returns. Everything here is data plus method signatures; there is no runtime
 * code, callback registry, cache, or mutable state.
 *
 * Boundaries these contracts encode:
 *
 * - Exactly ONE target may be selected across all destinations at a time. The
 *   controller is a property of the existing coordinator, not a second manager:
 *   there is no content manager, listener, store, daemon, lease, or permission
 *   type here, and no incoming content lane needs any of its own — it is the
 *   same optional listener under the same directional receiving authority.
 * - A selection names a local saved destination plus the exact owner run and
 *   exact owner row observed in that destination's CURRENT roster metadata, and
 *   the caller's own monotonic selection generation. Rows of every other
 *   connected host stay metadata-only.
 * - {@link PeerSelectedContent.snapshot} is the content endpoint's own complete,
 *   immutable, codec-produced viewport, handed over unchanged. It is display
 *   data: no control, input, clipboard, transcript, authorization, or raw byte
 *   crosses this boundary, and a published view never means a first frame was
 *   written, rendered, or received.
 * - {@link PeerContentObservation} is honest: a deliberate target that cannot
 *   currently be streamed is reported as `unavailable` with a fixed reason and
 *   its preserved target, never as a different host's content, a local session,
 *   or a sibling row.
 * - Native input and text copies are optional and default-inert. The target,
 *   request, receipt, and callback types below describe ONE existing endpoint's
 *   own current stream; they add no second manager, listener, writer, lease,
 *   registry, or map, and supplying the callbacks grants nothing by itself.
 *   Authority stays with the caller's dynamic written-source proof plus the
 *   endpoint's existing peer, pin, run, row, and selection fences.
 */

import type { PeerCoordinator } from "../peer-ui-protocol";
import type { TerminalInputModes } from "../terminal-surface";
import type { NativeInputSendResult } from "./session-content-client";
import type {
	NativeIoCompletedCopy,
	NativeIoInputKind,
	NativeIoSource,
	SessionContentSnapshot,
} from "./session-content-protocol";

/** The one outgoing content selection: local destination plus exact owner facts. */
export interface PeerContentTarget {
	/** Local saved-destination handle. Never a native instance id or identity. */
	readonly hostId: string;
	/** Exact owner run id of that destination's current roster observation. */
	readonly hostRunId: string;
	/** Exact owner row id within that run's current roster. */
	readonly rowId: string;
	/** Caller's monotonic selection generation; a stale one never wins. */
	readonly selectionGeneration: number;
	/** This viewer's requested pane width; the owner reports its own geometry. */
	readonly cols: number;
	/** This viewer's requested pane height; never a guessed canonical size. */
	readonly rows: number;
}

/** One newest-only viewport change for the currently selected generation. */
export interface PeerContentViewport {
	/** Ignored unless it matches the current selection's generation. */
	readonly selectionGeneration: number;
	readonly cols: number;
	readonly rows: number;
}

/** One complete currently-valid remote viewport. */
export interface PeerSelectedContent {
	readonly hostId: string;
	readonly selectionGeneration: number;
	/** The endpoint's immutable published viewport, carried unchanged. */
	readonly snapshot: SessionContentSnapshot;
}

/** `current` only while one complete validated viewport is published. */
export type PeerContentState = "none" | "connecting" | "current" | "unavailable";

/**
 * Fixed, display-safe refusal codes. Never peer content, key material, a path,
 * a row label, or an exception detail.
 */
export type PeerContentReason =
	/** The requested target was not a usable selection. */
	| "invalid-selection"
	/** No such saved destination, or it is not currently connected. */
	| "destination-unavailable"
	/** That destination has no complete current roster observation yet. */
	| "roster-unavailable"
	/** The exact row is not in that destination's current roster. */
	| "row-unavailable"
	/** The owner run changed; the deliberate target is kept, never rewritten. */
	| "run-changed"
	/** No remembered key for this destination, so nothing may be pinned. */
	| "key-unavailable"
	/** The remembered key is not the key the live metadata channel proved. */
	| "key-changed"
	/** This side's current local identity no longer matches the attempt. */
	| "identity-unavailable"
	/** The dedicated content channel could not be opened. */
	| "open-failed"
	/** The peer refused the content upgrade for this identity. */
	| "not-authorized"
	/** The owner refused this exact subscription request. */
	| "owner-refused"
	/** The owner did not answer the subscription within its finite window. */
	| "subscription-timeout"
	/** The published stream disagreed with this endpoint's own fenced tuple. */
	| "protocol-violation"
	/** A content control write could not be handed to the transport. */
	| "send-failed"
	/** A viewport transfer failed or was incomplete. */
	| "transfer-failed"
	/** The endpoint cleared its published view while still selected. */
	| "content-lost"
	/** The selected destination's connection went away. */
	| "connection-lost";

/** The single honest view of the globally selected content stream. */
export interface PeerContentObservation {
	/** The deliberate target, kept while `unavailable`, null only when none. */
	readonly target: PeerContentTarget | null;
	readonly state: PeerContentState;
	/** The complete current view, `undefined` the moment it stops being current. */
	readonly view: PeerSelectedContent | undefined;
	/** A fixed code whenever content is not available, otherwise null. */
	readonly reason: PeerContentReason | null;
}

/**
 * One whole, descriptive view of the native input target the currently selected
 * stream belongs to.
 *
 * It is a description, never authority: the source wire carries no host id, so
 * the local saved-destination handle, the caller's selection generation, and this
 * endpoint's own subscription id are carried beside the source and modes. A
 * matching target still needs the current TLS-proved peer, pin, run, row, local
 * identity, and the caller's own dynamic written-source proof before anything is
 * written.
 */
export interface PeerNativeInputTarget {
	/** Local saved-destination handle. Never a native instance id or identity. */
	readonly hostId: string;
	/** The exact selection generation this stream belongs to. */
	readonly selectionGeneration: number;
	/** This endpoint's own subscription id; never chosen by the caller. */
	readonly subscriptionId: string;
	/** The exact host-written source of the currently published view. */
	readonly source: NativeIoSource;
	/** The exact observed input modes of that same published view. */
	readonly inputModes: TerminalInputModes;
}

/**
 * One caller-normalized native input submission.
 *
 * Every target field is the caller's own expected value: `source` and
 * `inputModes` must be what the caller actually wrote a frame for, never a
 * re-read of the owner's current facts. `text` is canonical source-normalized
 * text (one keyboard packet, the UTF-8 body of a paste, or one canonical
 * content-space SGR mouse report); no translation, retargeting, or source
 * reinterpretation happens here.
 */
export interface PeerNativeInputRequest extends PeerNativeInputTarget {
	readonly kind: NativeIoInputKind;
	readonly text: string;
}

/**
 * One completed native text copy, bound to the endpoint that assembled it.
 *
 * The payload is carried unchanged: canonical base64 text or a fixed
 * unavailable reason, never a raw OSC 52 sequence, an image, another binding's
 * copy, or a terminal or clipboard write.
 */
export interface PeerNativeCopyReceipt extends NativeIoCompletedCopy {
	/** Local saved-destination handle this copy's stream belongs to. */
	readonly hostId: string;
	/** The exact selection generation this copy's stream belongs to. */
	readonly selectionGeneration: number;
}

/**
 * The live VIEWER-side remote native input/copy preference of this host.
 *
 * `enabled` is the current effective value (fail closed: an unavailable,
 * unloaded, or closing settings document is `false`). `generation` advances on
 * EVERY actual effective change, including an Off -> On return, so a proof or
 * written receipt captured under an older generation can never be revived by a
 * value that merely reads the same again. It grants nothing by itself and is
 * never a lease, token, or registry entry.
 */
export interface PeerViewerNativeInputPolicy {
	readonly enabled: boolean;
	readonly generation: number;
}

/**
 * Optional native input / text-copy callbacks of the ONE coordinator.
 *
 * Both functions are required for the extension to exist at all: omitting the
 * whole option keeps the exact legacy display-only coordinator, with no native
 * capability offered anywhere. Supplying them is not a permission — it is the
 * caller's dynamic proof seam, evaluated synchronously for every protected
 * input write and re-checked after it returns.
 */
export interface PeerNativeIoCallbacks {
	/**
	 * Caller's dynamic written-source/focus/coverage proof for one exact target.
	 * Only an explicit `true` allows that write; anything else (or a throw) refuses
	 * it. It is never a lease, token, cached verdict, or capability check.
	 */
	readonly authorizeInput: (target: PeerNativeInputTarget) => boolean;
	/**
	 * Called at most once per atomically assembled copy, and only while that copy's
	 * exact source is still this coordinator's current selected stream. It never
	 * emits OSC 52, reads the local clipboard, or falls back to another endpoint.
	 *
	 * An async copy that arrives after a later input's copy is still delivered: the
	 * copy emission sequence, not an input dispatch id, orders copies.
	 */
	readonly onCopy: (receipt: PeerNativeCopyReceipt) => void;
}

/**
 * The one selected-content controller owned by the existing coordinator. It
 * exists from construction: selecting nothing, selecting before startup, or a
 * coordinator with hosting disabled creates no channel, watch, viewer, identity,
 * file, or timer. Every selection method is synchronous and latest-intent-only.
 *
 * The two native IO members are optional so every existing metadata-only or
 * display-only controller implementation stays valid. They describe and submit
 * against the exact current stream; neither creates a channel, viewer, target,
 * or callback binding of its own.
 */
export interface PeerContentController {
	/**
	 * Replace the single global selection. `null` clears to none (local sessions
	 * and passive viewing select nothing). Replacing clears the current view and
	 * abandons a pending open synchronously; it never queues work per click, never
	 * pairs, never prompts for a key, and never connects a disconnected host.
	 */
	selectContent(target: PeerContentTarget | null): void;
	/**
	 * Newest-only viewport change for the current selection generation. A stale
	 * generation is ignored, and the endpoint keeps at most one pending request
	 * instead of accumulating writes.
	 */
	updateContentViewport(viewport: PeerContentViewport): void;
	/** Immutable copy of the current observation. Never a live view of state. */
	readContent(): PeerContentObservation;
	/**
	 * Descriptive facts of the exact native input target of the currently
	 * published stream, or `undefined` while no explicit native IO mode is
	 * configured, this viewer's remote input/copy preference is Off, nothing is
	 * selected, the stream is not current, the endpoint's own fences no longer
	 * hold, or the publisher offers no source. It never invokes the caller's proof
	 * callback and never selects or rewrites a target, so a caller may read it from
	 * inside that callback.
	 */
	readNativeInputTarget?(): PeerNativeInputTarget | undefined;
	/**
	 * The live viewer-side remote input/copy preference and its change generation.
	 * Pure description, safe to read from inside the caller's own proof callback.
	 * A controller without it offers no viewer forwarding at all.
	 */
	readViewerNativeInputPolicy?(): PeerViewerNativeInputPolicy;
	/**
	 * Submit one caller-normalized native input against the caller's own expected
	 * target. It re-proves the current selection, peer, run, row, subscription,
	 * source, and modes, calls the caller's dynamic proof, and only then hands the
	 * caller's expected source and modes to the existing viewer endpoint. It never
	 * retries, replays, reconnects, re-grants, pairs, stops an owner session, or
	 * claims a cancellation.
	 */
	sendNativeInput?(request: PeerNativeInputRequest): Promise<NativeInputSendResult>;
}

/**
 * The production coordinator interface: everything {@link PeerCoordinator}
 * already promised, plus the content controller. A coordinator that supplies no
 * content source simply never accepts an incoming content lane, and an existing
 * metadata-only implementation still satisfies {@link PeerCoordinator}.
 */
export interface PeerCoordinatorWithContent extends PeerCoordinator {
	readonly content: PeerContentController;
}
