/**
 * Pure selected-content contracts for the ONE peer coordinator (#389 selection
 * phase).
 *
 * Importing this file allocates nothing and starts nothing: it declares the
 * display/controller DTOs behind the globally selected outgoing native viewport
 * stream, plus the composed coordinator interface the production factory
 * returns. Everything here is data plus three method signatures.
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
 */

import type { PeerCoordinator } from "../peer-ui-protocol";
import type { SessionContentSnapshot } from "./session-content-protocol";

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
 * The one selected-content controller owned by the existing coordinator. It
 * exists from construction: selecting nothing, selecting before startup, or a
 * coordinator with hosting disabled creates no channel, watch, viewer, identity,
 * file, or timer. Every method is synchronous and latest-intent-only.
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
