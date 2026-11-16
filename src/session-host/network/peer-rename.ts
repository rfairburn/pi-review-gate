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
import {
	isNativeCliBackend,
	isNativeDisplayName,
	type NativeCliBackend,
} from "../session-backend";

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
 * One owner-routed HOST ROW NAME of exactly one row of one owner run.
 *
 * This is the native sibling of {@link OwnerRenameRequest} and it is deliberately
 * NOT a Pi conversation rename: a native CLI row has no conversation identity to
 * name, so this request names the exact run, the exact row, the backend the
 * requester last OBSERVED on that row, and the bounded replacement caption. No
 * native session id, epoch, command, executable, argument, environment, workspace,
 * path, saved-session file, agent directory, selection, viewer, or input mode is
 * expressible, and no frame here carries or mirrors a previous name.
 *
 * `backend` is a fence, not a request to configure anything: the owner applies the
 * caption only to a row it still records as that same native backend, so a row
 * that was replaced by another backend (or by a Pi session) is never renamed by a
 * stale request.
 */
export interface OwnerNativeRenameRequest {
	/** Exact owner run id the request was authorized against and must match. */
	readonly hostRunId: string;
	/** Exact row id within that run's current inventory. */
	readonly rowId: string;
	/** Native backend this side last OBSERVED on that row; a fence, never a guess. */
	readonly backend: NativeCliBackend;
	/**
	 * Exact replacement caption, forwarded verbatim: never trimmed, normalized, or
	 * truncated here. The owner applies its own shared native display-name rule and
	 * reports what it actually did.
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

/**
 * The fixed facts one owner HOST ROW NAME established. Exactly one is ever
 * reported, none carries a name or any owner text, and none is a retry or resubmit
 * instruction.
 *
 * The two success kinds differ in ONE way the operator must be able to tell apart:
 * whether this host also got its own roster publication for THIS operation to
 * land. A native caption is a host-side label, so `renamed-in-memory` is a truthful
 * success for the running host while being honest that the name is NOT known to
 * survive a restart; nothing may upgrade it into a durable claim, and nothing may
 * downgrade `renamed-durable` into doubt.
 */
export type OwnerNativeRenameFacts
	/** This owner applied the caption to the exact row it named AND its roster
	 * publication for this operation reported the state durable. Nothing is claimed
	 * about any requester receiving the reply, or about any view, selection, or
	 * focus, and no provider was told anything. */
	= { readonly kind: "renamed-durable" }
	/** This owner applied the caption to the exact row it named, but its roster
	 * publication for this operation did not report durability (disabled, failed,
	 * deferred, overflowed, or a row with no remembered slot), or that publication
	 * could not be observed at all. The name is live on the owner now and is NOT
	 * claimed to survive a restart. */
	| { readonly kind: "renamed-in-memory" }
	/** Nothing was renamed, and this was positively established BEFORE any caption
	 * was applied: no manager, teardown already requested, another owner run, a row
	 * this run does not have, a row that is not a native row of the named backend,
	 * a caption this host cannot represent, the caption seam being unavailable
	 * here, or a re-proof that no longer held. An ambiguous result after a caption
	 * was applied is never reported this way. */
	| { readonly kind: "refused" }
	/** The outcome is unobservable, so neither a caption nor its absence is
	 * established: the caption seam threw, the inventory could not be read, the
	 * owner's own roster outcome could not be classified, or teardown took the row
	 * away mid-operation. The name may or may not have changed, and nothing may be
	 * re-sent on its behalf. */
	| { readonly kind: "unknown" };

/** Every native fact kind, in one fixed list. Nothing else is representable. */
export const OWNER_NATIVE_RENAME_FACT_KINDS: readonly OwnerNativeRenameFacts["kind"][] = Object.freeze([
	"renamed-durable",
	"renamed-in-memory",
	"refused",
	"unknown",
]);

/**
 * Runtime guard for one reported native fact set: exactly one `kind` field of the
 * fixed kinds. A thrown provider, a partial object, an extra field (including a
 * name, a row id, or a backend), or an invented kind is not a fact this side may
 * report or forward.
 */
export function isOwnerNativeRenameFacts(value: unknown): value is OwnerNativeRenameFacts {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const record = value as Record<string, unknown>;
	const keys = Object.keys(record);
	if (keys.length !== 1 || keys[0] !== "kind") return false;
	const kind = record.kind;
	return typeof kind === "string"
		&& (OWNER_NATIVE_RENAME_FACT_KINDS as readonly string[]).includes(kind);
}

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
 * The ONE owner-side HOST ROW NAME provider shape: one request naming one exact
 * native row plus the same minimal re-proof, and one fixed
 * {@link OwnerNativeRenameFacts} set out.
 *
 * It is the injected analogue of {@link OwnerRenameHandler} for a native row: the
 * owner's Main already owns the only manager label, the only stable-slot caption,
 * and the only roster publication, and it must reuse them. It never calls the Pi
 * conversation rename, never writes to the child or its input, and never reports a
 * durability it did not observe for THIS operation.
 */
export type OwnerNativeRenameHandler = (
	request: OwnerNativeRenameRequest,
	stillAuthorized: OwnerRenameAuthorizationGuard,
) => Promise<OwnerNativeRenameFacts>;

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
 * One deliberate HOST ROW NAME from a requester's own coordinator: the local
 * saved-destination handle plus the exact owner run, row, observed backend, and
 * replacement caption its last written Edit form named. `hostId` is this side's
 * display/action handle and is never sent on the wire. The run, row, and backend
 * are REQUEST INPUTS: a newer run, a sibling row, or a row that now records a
 * different backend is never substituted for the named one.
 */
export interface PeerNativeRenameTarget extends OwnerNativeRenameRequest {
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
 * Pure comparison for the requester's coordinator: true only while its current
 * roster observation of one row still names the SAME native backend the host-name
 * request was built for. A missing observation, an absent row, a row with no
 * reported backend, and a row that now reports another backend are all refusals —
 * the request is never quietly retargeted, and a backend is never inferred from a
 * label, a caption, or the absence of Pi telemetry.
 */
export function isOwnerNativeRenameRowStillCurrent(
	observed: { readonly backend?: unknown } | null | undefined,
	request: Pick<OwnerNativeRenameRequest, "backend">,
): boolean {
	if (observed === null || observed === undefined) return false;
	if (!isNativeCliBackend(request.backend)) return false;
	return observed.backend === request.backend;
}

/**
 * True only for one representable native host-name request: an exact run and row,
 * a closed native backend, and a caption that satisfies the owner's own shared
 * native display-name rule. Nothing is trimmed, normalized, or truncated, and an
 * unusable value is a refusal rather than a rewrite.
 */
export function isOwnerNativeRenameRequest(value: unknown): value is OwnerNativeRenameRequest {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const record = value as Record<string, unknown>;
	if (typeof record.hostRunId !== "string" || record.hostRunId.length === 0) return false;
	if (typeof record.rowId !== "string" || record.rowId.length === 0) return false;
	if (!isNativeCliBackend(record.backend)) return false;
	return isNativeDisplayName(record.name);
}

/**
 * The one Rename controller owned by the existing peer coordinator: no selection,
 * displayed row, controller lease, open form, or on-demand connection is needed,
 * because it uses the destination's existing connected metadata channel and
 * verified peer facts.
 */
export interface PeerRenameController {
	renameSession(target: PeerRenameTarget, options?: PeerRenameOptions): Promise<PeerRenameResult>;
	/**
	 * Ask the same owner to HOST-NAME one of its native rows.
	 *
	 * Optional so an older or fake controller that never learned the native name
	 * lane stays representable: a caller must prove the method exists before asking,
	 * and its absence is never answered by a Pi conversation rename, a local caption
	 * write, or a reconnect. Where it exists it owns its OWN single in-flight
	 * request and its OWN monotonic per-channel attempt number, separate from the Pi
	 * rename, so a host-name request never queues behind or reuses a Pi rename's
	 * number. The result union is the same three-way shape, and the owner's own
	 * authoritative roster stays the only thing that carries a renamed caption.
	 */
	renameNativeSession?(
		target: PeerNativeRenameTarget,
		options?: PeerRenameOptions,
	): Promise<PeerNativeRenameResult>;
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

/**
 * The one fixed result a requester may observe for one HOST ROW NAME.
 *
 * `owner-result` carries the owner's own fixed facts and nothing more; it is never
 * a claim that this side's projection or a local caption changed, because only the
 * owner's next complete roster observation can carry a renamed row and no
 * optimistic label update happens here. `not-sent` requires positive proof that no
 * bytes were handed to the transport. `unknown` establishes neither a rename nor
 * its absence, and nothing is replayed, cancelled, or retried.
 */
export type PeerNativeRenameResult =
	| { readonly kind: "owner-result"; readonly facts: OwnerNativeRenameFacts }
	| { readonly kind: "not-sent"; readonly reason: PeerRenameNotSentReason }
	| { readonly kind: "unknown" };
