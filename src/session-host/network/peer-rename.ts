/**
 * Pure owner-side session Rename contracts (issue #512 owner-rename phase).
 *
 * Declares only: the one request shape an owner host answers, the fixed facts it
 * may report, the fixed result a requester may see, and one pure tuple
 * comparison. No frame, codec, timer, store, queue, retry, or permission type
 * lives here, and no capability is granted by these types. The authoritative
 * rename stays where it already lives: the one manager's authenticated
 * registration, its broker round trip, and the reporter's public
 * `setSessionName` with its own stored-name verification. The existing roster
 * metadata lane carries a request and owns its own capability, framing, and
 * bounds.
 *
 * Boundaries: one request names this owner's current run, exactly one row of
 * that run, that row's last observed native conversation id and epoch, and the
 * new name. No workspace, path, saved-session file, native current file, agent
 * directory, alias, host, endpoint, selection, viewer, or input mode is
 * expressible. There is no second name store and no caption write on either
 * side: a confirmed rename reaches observers only through the owner's next
 * complete authoritative roster snapshot.
 */

import type { PeerCoordinator } from "../peer-ui-protocol";

/** One owner-routed rename of exactly one row of one owner run. */
export interface OwnerRenameRequest {
	/** Exact owner run id the request was authorized against and must match. */
	readonly hostRunId: string;
	/** Exact row id within that run's current inventory. */
	readonly rowId: string;
	/** Canonical native conversation id observed for that row. */
	readonly expectedSessionId: string;
	/** Positive native session epoch observed with that id; never crosses one. */
	readonly expectedSessionEpoch: number;
	/**
	 * Exact requested name, forwarded verbatim: never trimmed, normalized, or
	 * truncated here. The native store applies its own documented storage rule and
	 * the reporter verifies what it actually stored.
	 */
	readonly name: string;
}

/**
 * The fixed facts one owner rename established. Exactly one is ever reported,
 * none carries a name, and none is a retry or resubmit instruction.
 */
export type OwnerRenameFacts
	/** This owner's existing verified rename authority confirmed the stored name
	 * for the exact native tuple the request named. Nothing is claimed about any
	 * requester receiving the reply, or about any view, selection, or focus. */
	= { readonly kind: "renamed" }
	/** The row's live native conversation is no longer the tuple the request
	 * named: the id or epoch moved, or the row reports no native conversation.
	 * This is NOT proof that nothing was renamed — the existing rename authority
	 * can report it after its broker round trip, when an earlier write may already
	 * have landed — so the row's current name stays unverified and is read from the
	 * next roster observation rather than assumed unchanged. */
	| { readonly kind: "stale-session" }
	/** Nothing was renamed, and this was positively established BEFORE any rename
	 * was addressed: no manager, teardown already requested, another owner run, a
	 * row this run does not have, no native conversation binding, the rename seam
	 * being unavailable here, a name or id this host cannot represent, or a
	 * re-proof that no longer held. An ambiguous result after a rename was
	 * addressed is never reported this way. */
	| { readonly kind: "refused" }
	/** The native operation or this channel's rename slot is busy; nothing was queued or replaced. */
	| { readonly kind: "busy" }
	/** Unobservable outcome, so neither a rename nor its absence is established:
	 * the rename seam timed out or disconnected, a setter or stored-name
	 * verification could not be trusted, an authority threw, the inventory is
	 * unreadable, or teardown took the row away. The name may or may not have
	 * changed, and nothing may be re-sent on its behalf. */
	| { readonly kind: "unknown" };

/** Every fact kind, in one fixed list. Nothing else is representable. */
export const OWNER_RENAME_FACT_KINDS: readonly OwnerRenameFacts["kind"][] = Object.freeze([
	"renamed",
	"stale-session",
	"refused",
	"busy",
	"unknown",
]);

/**
 * Runtime guard for one reported fact set: exactly one `kind` field of the fixed
 * kinds. A thrown provider, a partial object, an extra field (including a name),
 * or an invented kind is not a fact this side may report or forward.
 */
export function isOwnerRenameFacts(value: unknown): value is OwnerRenameFacts {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const record = value as Record<string, unknown>;
	const keys = Object.keys(record);
	if (keys.length !== 1 || keys[0] !== "kind") return false;
	const kind = record.kind;
	return typeof kind === "string" && (OWNER_RENAME_FACT_KINDS as readonly string[]).includes(kind);
}

/**
 * Synchronous re-proof handed to the owner's provider: `true` only while the exact
 * proved peer key, the current receiving grant, and the live binding still hold.
 * It is a check and nothing else — not a lease, not a capability — and `false` or
 * a throw means the rename must not start.
 */
export type OwnerRenameAuthorizationGuard = () => boolean;

/** The ONE owner-side provider shape: one request plus that re-proof, one fact set out. */
export type OwnerRenameHandler = (
	request: OwnerRenameRequest,
	stillAuthorized: OwnerRenameAuthorizationGuard,
) => Promise<OwnerRenameFacts>;

/**
 * One deliberate rename from a requester's own coordinator: the local
 * saved-destination handle plus the exact owner run, row, and native tuple its
 * last written roster observation named, and the new name. `hostId` is this
 * side's display/action handle and is never sent on the wire. The run, row, id,
 * and epoch are REQUEST INPUTS: a newer run, a sibling row, or a newer native
 * tuple is never substituted for the named one.
 */
export interface PeerRenameTarget extends OwnerRenameRequest {
	/** Local saved-destination handle. Never a native instance id or identity. */
	readonly hostId: string;
}

/**
 * Fixed reasons a rename was positively NEVER submitted to the transport:
 * `capability-unsupported` (no acknowledged capability, so no frame exists to
 * send), `not-ready` (no eligible current channel), `invalid-request` (not
 * representable), `target-unavailable` (no exact current destination/run/row/
 * native-tuple/pin/identity — a stale observation is refused, never retargeted),
 * `busy` (this channel already owns an in-flight rename), and `limit` (this
 * channel's monotonic anti-replay sequence is exhausted).
 */
export type PeerRenameNotSentReason =
	| "capability-unsupported"
	| "not-ready"
	| "invalid-request"
	| "target-unavailable"
	| "busy"
	| "limit";

/**
 * The one fixed result a requester may observe. `owner-result` carries the owner's
 * facts and never a name, and is never a claim that this side's projection
 * changed: only a new complete roster observation can carry a renamed row, and no
 * optimistic label update happens here. `not-sent` requires positive proof that no
 * bytes were handed to the transport and never means "the owner did nothing".
 * `unknown` means the outcome is unobservable: it establishes neither a rename nor
 * its absence, and nothing is replayed, cancelled, or retried.
 */
export type PeerRenameResult =
	| { readonly kind: "owner-result"; readonly facts: OwnerRenameFacts }
	| { readonly kind: "not-sent"; readonly reason: PeerRenameNotSentReason }
	| { readonly kind: "unknown" };

/**
 * The caller's last-instant proof, evaluated synchronously inside the ordered
 * write about to call the transport, after this side's independent owner facts are
 * re-proved. It must still name the actual destination, run, row, and native tuple
 * this request was built from, and still own that request.
 */
export interface PeerRenameOptions {
	readonly stillCurrent?: () => boolean;
}

/**
 * Pure comparison for the requester's coordinator: true only while its current
 * roster observation of one row still names the exact native tuple the rename was
 * built for. A missing observation, an absent row, no native conversation, a
 * different id, or a moved epoch is never a match — the request is refused rather
 * than quietly retargeted.
 */
export function isOwnerRenameTupleStillCurrent(
	observed: { readonly sessionId: string; readonly epoch: number } | null | undefined,
	request: Pick<OwnerRenameRequest, "expectedSessionId" | "expectedSessionEpoch">,
): boolean {
	if (observed === null || observed === undefined) return false;
	return observed.sessionId === request.expectedSessionId
		&& observed.epoch === request.expectedSessionEpoch;
}

/**
 * The one Rename controller owned by the existing peer coordinator: no selection,
 * displayed row, controller lease, open form, or on-demand connection is needed,
 * because it uses the destination's existing connected metadata channel and
 * verified peer facts.
 */
export interface PeerRenameController {
	renameSession(target: PeerRenameTarget, options?: PeerRenameOptions): Promise<PeerRenameResult>;
}

/**
 * The coordinator interface for a host that also answers Rename: every existing
 * promise plus the one Rename controller. Without an owner provider this host
 * never acknowledges inbound rename support; outbound use independently requires
 * the remote owner's negotiated support.
 */
export interface PeerCoordinatorWithRename extends PeerCoordinator {
	readonly ownerRename: PeerRenameController;
}
