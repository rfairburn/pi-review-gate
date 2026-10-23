/**
 * Pure owner-side session Close contracts (#389 owner Close phase).
 *
 * Importing this file allocates nothing, starts nothing, reads nothing, and
 * grants nothing: it declares the one request shape an owner host answers, the
 * fixed facts it may report back, and the fixed result a requester may see.
 * There is no frame, codec, timer, store, queue, retry, or permission type here,
 * and no capability is granted by any of these types: the authoritative close
 * stays where the only manager, the only roster, and the only removal path
 * already live, in Main. The transport that carries a request is the existing
 * roster metadata lane, which owns its own capability, framing, and bounds.
 *
 * Boundaries these contracts encode:
 *
 * - One request names THIS owner's current run and exactly one of that run's
 *   rows. Both ids are opaque identifiers validated by whoever carries them;
 *   nothing here carries a payload, an error, a path, a signal, a native
 *   conversation tuple, or any other private fact about the row, its
 *   conversation, its workspace, or its host.
 * - {@link OwnerCloseFacts} is only what the owner could positively observe.
 *   `removed` means this host's manager confirmed removing that row — after an
 *   exit this host actually saw, or under its own settled launch-error removal
 *   authority. It never claims a durable roster write, a saved-conversation or
 *   history deletion, or that any requester received a reply.
 *   `confirmation-required`, `unconfirmed`, `refused`, and `busy` all leave the
 *   row, its registration, and the owner's exclusive ownership untouched by this
 *   close. `unknown` claims nothing either way: the row may or may not have stopped,
 *   been removed, or been taken by teardown, and it establishes neither removal nor
 *   retention. No fact reports a sent signal, a `forced` flag, or an
 *   acknowledgement as an exit: only the manager's own observed exit is an exit.
 * - The handler is one call answered once. It is not a subscription, a command
 *   channel, a lease, or a controller: it needs no selected or displayed row, no
 *   viewer, and no local operator confirmation, and it grants no input,
 *   clipboard, resize, viewer, hosting, or trust authority. The transport that
 *   carries a request reauthorizes every request against the current TLS-proved
 *   peer key and the current directional receiving grant before this handler is
 *   ever reached.
 * - {@link PeerCloseController} is the requester's one entry point, and it is a
 *   property of the existing coordinator rather than a second manager: there is
 *   no close manager, listener, store, lease, queue, or replay log here, and no
 *   selection, display, viewer, or controller state is required to ask.
 */

import type { PeerCoordinator } from "../peer-ui-protocol";

/** One owner-routed close of exactly one row of one owner run. */
export interface OwnerCloseRequest {
	/** Exact owner run id the request was authorized against. */
	readonly hostRunId: string;
	/** Exact row id within that run's current inventory. */
	readonly rowId: string;
	/**
	 * True only when the requester deliberately confirmed a busy or unknown row.
	 * It authorizes the owner's EXISTING bounded stop ladder and nothing more: the
	 * same bounded graceful request, TERM, and owned-handle kill the local route
	 * already runs, never a force flag and never a second ladder. The owner
	 * revalidates the row's real state itself, and no rung of that ladder counts as
	 * an exit — only the manager's own observed exit does.
	 */
	readonly confirmed: boolean;
}

/**
 * The fixed facts one owner close established. Exactly one of these is ever
 * reported, and none of them is a retry, reconnect, or resubmit instruction.
 */
export type OwnerCloseFacts
	/** This host's manager confirmed removing the row: after an exit this host
	 * actually observed, or under its own settled launch-error removal authority. */
	= { readonly kind: "removed" }
	/** An exit this host actually observed on a row its manager cleanly refused to
	 * remove. Only an actually observed exit may report this fact; a removal
	 * authority that threw reports `unknown` rather than claiming the row's state. */
	| { readonly kind: "stopped-retained" }
	/** The row is not positively idle — real activity or unknown state — so the
	 * owner's stop ladder never started and confirmation is needed. Nothing was
	 * forced, and the child's state is not established either way. */
	| { readonly kind: "confirmation-required" }
	/** The existing bounded ladder ended without an observed exit. The row, its
	 * registration, and this host's ownership are retained; the child's actual state
	 * is unconfirmed, not a guarantee that it is still running. */
	| { readonly kind: "unconfirmed" }
	/** Nothing was stopped, signalled, or removed, and this was positively
	 * established before any stop was addressed: no manager, teardown already
	 * requested when the close arrived, a manager that cannot stop, another owner
	 * run, a row this run does not have, a row whose live state this host cannot
	 * read, or a settled error row whose own removal authority refused. An ambiguous
	 * result after a stop was addressed is never reported this way. */
	| { readonly kind: "refused" }
	/** This row already has an in-flight close; nothing was re-signalled or queued. */
	| { readonly kind: "busy" }
	/** The outcome is unobservable, so neither removal nor retention is
	 * established: a stop that reported an ambiguous or unrecognized result, a
	 * manager or removal authority that failed mid-await, an unobservable inventory,
	 * or teardown taking the row away. The row may or may not have stopped or been
	 * removed, and nothing may be re-sent on its behalf. */
	| { readonly kind: "unknown" };

/** The ONE owner-side provider shape: one request in, one fixed fact set out. */
export type OwnerCloseHandler = (request: OwnerCloseRequest) => Promise<OwnerCloseFacts>;

/** Every fact kind, in one fixed list. Nothing else is representable. */
export const OWNER_CLOSE_FACT_KINDS: readonly OwnerCloseFacts["kind"][] = Object.freeze([
	"removed",
	"stopped-retained",
	"confirmation-required",
	"unconfirmed",
	"refused",
	"busy",
	"unknown",
]);

/**
 * Runtime guard for one reported fact set: exactly one `kind` field and one of
 * the fixed kinds. Anything else — a thrown provider, a partial object, an extra
 * field, an invented kind — is not a fact this side may report or forward.
 */
export function isOwnerCloseFacts(value: unknown): value is OwnerCloseFacts {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const record = value as Record<string, unknown>;
	const keys = Object.keys(record);
	if (keys.length !== 1 || keys[0] !== "kind") return false;
	const kind = record.kind;
	return typeof kind === "string" && (OWNER_CLOSE_FACT_KINDS as readonly string[]).includes(kind);
}

/**
 * One deliberate Close request from a requester's own coordinator: the local
 * saved-destination handle plus the exact owner run and row the last roster
 * observation named, and the same explicit confirmation the local route takes.
 * `hostId` is this side's display/action handle and is never sent on the wire.
 */
export interface PeerCloseTarget {
	/** Local saved-destination handle. Never a native instance id or identity. */
	readonly hostId: string;
	/** Exact owner run id the request names. Never rewritten to a newer run. */
	readonly hostRunId: string;
	/** Exact owner row id within that run. */
	readonly rowId: string;
	/** True only when the operator deliberately confirmed a busy or unknown row. */
	readonly confirmed: boolean;
}

/**
 * Fixed reasons a Close was positively NEVER submitted to the transport.
 *
 * - `capability-unsupported`: the owner never acknowledged the optional Close
 *   capability for this channel, so no close frame exists to send at all.
 * - `not-ready`: no eligible current channel (never acknowledged, stopped,
 *   detached, or the viewer was already gone, or the bounded control-send window
 *   refused it) — nothing was written.
 * - `invalid-request`: the request could not be represented, so nothing was
 *   written.
 * - `target-unavailable`: no exact current destination/run/row/pin/identity to
 *   address — nothing was written.
 * - `busy`: this row already has an in-flight close here; nothing was queued.
 * - `row-limit`: the existing bounded close bookkeeping is full; nothing was
 *   queued, evicted, or retargeted.
 */
export type PeerCloseNotSentReason =
	| "capability-unsupported"
	| "not-ready"
	| "invalid-request"
	| "target-unavailable"
	| "busy"
	| "row-limit";

/**
 * The one fixed result a requester may observe.
 *
 * - `owner-result` carries the owner's own fixed facts and nothing more. It is
 *   never a claim that this side's projection changed: only a new roster
 *   observation can remove or retain a row, and no optimistic removal happens
 *   here.
 * - `not-sent` is only returned with positive proof that no bytes were ever
 *   handed to the transport. It never means "the owner did nothing".
 * - `unknown` means the outcome is unobservable: the write may have been
 *   accepted, the reply may have been lost, the deadline elapsed, the grant or
 *   channel went away, or the destination was replaced. It establishes neither
 *   removal nor retention, and nothing is ever replayed on its behalf.
 */
export type PeerCloseResult =
	| { readonly kind: "owner-result"; readonly facts: OwnerCloseFacts }
	| { readonly kind: "not-sent"; readonly reason: PeerCloseNotSentReason }
	| { readonly kind: "unknown" };

/**
 * The one Close controller owned by the existing peer coordinator. It exists
 * from construction and needs no selection, no displayed row, no controller
 * lease, no native conversation tuple, and no on-demand connection: it uses the
 * destination's existing connected metadata channel and verified peer facts.
 */
export interface PeerCloseController {
	closeSession(target: PeerCloseTarget): Promise<PeerCloseResult>;
}

/**
 * The production coordinator interface for a host that also answers Close: every
 * existing promise, plus the one Close controller. A caller that never supplies
 * an owner provider observes exactly the previous behavior, because the optional
 * capability is then never acknowledged by either side.
 */
export interface PeerCoordinatorWithClose extends PeerCoordinator {
	readonly ownerClose: PeerCloseController;
}
