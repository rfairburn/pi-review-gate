/**
 * Pure owner-side session Create contracts (rowless owner-create phase).
 *
 * Importing this file allocates nothing, starts nothing, reads nothing, and
 * grants nothing: it declares the one request shape an owner host answers, the
 * fixed facts it may report back, the fixed result a requester may see, and the
 * one workspace field rule shared by the wire and by the requester. There is no
 * frame, codec, timer, store, queue, retry, deduplication fence, or permission
 * type here, and no capability is granted by any of these types: the
 * authoritative create stays where the only manager, the only run identity, and
 * the only launch path already live, in Main. The transport that carries a
 * request is the existing roster metadata lane, which owns its own capability,
 * framing, and bounds.
 *
 * Boundaries these contracts encode:
 *
 * - One request names THIS owner's current run and the canonical workspace text
 *   a caller is creating a child in. Both are opaque to this contract; nothing
 *   here carries a payload, an error, a path decision, a signal, a native
 *   conversation tuple, a selected stream, a viewer, or any other private fact
 *   about the row, its conversation, or its host.
 * - A create is ROWLESS: no row id, roster row, display badge, native session
 *   tuple, epoch, input mode, or viewer is needed to ask. An owner whose current
 *   roster is empty is a perfectly valid first target, and no saved-duplicate
 *   fence, workspace deduplication, or path resolution exists on either side.
 * - {@link OwnerCreateFacts} is only what the owner could positively observe.
 *   `started` means this owner's manager created a row in the SAME owner run
 *   that is alive with a live process in the owner's own post-create inventory.
 *   It never claims a durable roster write, a native conversation binding, an
 *   acknowledgement from the requester, or that any UI was focused, activated,
 *   or selected — the owner's launch path is focus-free by construction.
 *   `unconfirmed` means the operation was addressed but nothing usable came up
 *   (a create that reported not-ready or failed may have left an error row).
 *   `refused` is reserved for authority this host positively established BEFORE
 *   any create was invoked. `unknown` claims nothing either way: the manager may
 *   have created a child that this host can no longer observe.
 * - The handler is one call answered once. It is not a subscription, a command
 *   channel, a lease, or a controller, and it grants no input, clipboard,
 *   resize, viewer, hosting, stop, or trust authority. The transport that
 *   carries a request reauthorizes every request against the current TLS-proved
 *   peer key and the current directional receiving grant, immediately before the
 *   invocation, and hands the handler a minimal re-proof to check once more
 *   immediately before it starts anything.
 * - {@link PeerCreateController} is the requester's one entry point, and it is a
 *   property of the existing coordinator rather than a second manager: there is
 *   no create manager, listener, store, lease, queue, replay log, or authority
 *   registry here, no on-demand connection, and no selection, display, viewer,
 *   or controller state is required to ask.
 */

import type { PeerCoordinator } from "../peer-ui-protocol";
import type { NativeCliTarget } from "../native-cli-launch";
import {
	isNativeCliBackend,
	isNativeCliTargetId,
	type NativeCliBackend,
} from "../session-backend";

/** One owner-routed create of one blank child in exactly one owner run. */
export interface OwnerCreateRequest {
	/** Exact owner run id the request was authorized against and must match. */
	readonly hostRunId: string;
	/**
	 * Canonical workspace text exactly as the requester's form held it. It is
	 * forwarded verbatim: this contract never trims, resolves, rewrites, or
	 * substitutes a cwd, and the owner applies its own existing launch semantics.
	 */
	readonly workspace: string;
}

/**
 * The fixed facts one owner create established. Exactly one of these is ever
 * reported, and none of them is a retry, reconnect, or resubmit instruction.
 */
export type OwnerCreateFacts
	/** This owner's manager created a row in THIS run that is alive with a live
	 * process in the owner's own post-create inventory. Nothing is claimed about
	 * focus, activation, selection, display, or native conversation state. */
	= { readonly kind: "started"; readonly hostRunId: string; readonly rowId: string }
	/** The create was addressed and nothing usable came up: the manager reported
	 * not-ready or failed, or the row it named was not alive afterwards. A
	 * not-ready or failed create may have left an error row behind, and this fact
	 * neither removes it nor establishes its state. */
	| { readonly kind: "unconfirmed" }
	/** Nothing was created, and this was positively established before any create
	 * was invoked: no manager, teardown already requested, another owner run, a
	 * request this host cannot represent, a re-proof that no longer held, or a
	 * duplicate/out-of-order request already answered. An ambiguous result after a
	 * create was addressed is never reported this way. */
	| { readonly kind: "refused" }
	/** The outcome is unobservable, so neither a child nor its absence is
	 * established: an inventory that cannot be read, a manager that threw, a
	 * start this host can no longer attribute to its own run, or an unrecognized
	 * launch status. Nothing may be re-sent on its behalf. */
	| { readonly kind: "unknown" };

/** Every fact kind, in one fixed list. Nothing else is representable. */
export const OWNER_CREATE_FACT_KINDS: readonly OwnerCreateFacts["kind"][] = Object.freeze([
	"started",
	"unconfirmed",
	"refused",
	"unknown",
]);

/**
 * Runtime guard for one reported fact set: one of the fixed kinds, and for
 * `started` exactly one bounded owner run and row id and nothing else. Anything
 * else — a thrown provider, a partial object, an extra field, an invented kind —
 * is not a fact this side may report or forward.
 */
export function isOwnerCreateFacts(value: unknown): value is OwnerCreateFacts {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const record = value as Record<string, unknown>;
	const keys = Object.keys(record);
	const kind = record.kind;
	if (typeof kind !== "string") return false;
	if (!(OWNER_CREATE_FACT_KINDS as readonly string[]).includes(kind)) return false;
	if (kind !== "started") return keys.length === 1;
	if (keys.length !== 3) return false;
	if (!keys.includes("hostRunId") || !keys.includes("rowId")) return false;
	return isFactIdentifier(record.hostRunId) && isFactIdentifier(record.rowId);
}

/**
 * The metadata lane's fixed opaque-identifier shape, mirrored here so a fact this
 * module reports can always be carried by that lane without importing the wire
 * module (which would be circular). The wire still applies its own negotiated
 * `maxIdentifierBytes`; this is the same format at the default bound, not a second
 * or contradictory rule.
 */
const FACT_IDENTIFIER_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
const FACT_IDENTIFIER_MAX_BYTES = 64;

/**
 * A reported identifier must be one the existing lane could carry: a bounded,
 * non-empty, unremarkable token. Anything else — including a control character,
 * a leading separator, an empty string, or an over-bound value — is refused.
 */
function isFactIdentifier(value: unknown): value is string {
	return typeof value === "string"
		&& value.length > 0
		&& Buffer.byteLength(value, "utf8") <= FACT_IDENTIFIER_MAX_BYTES
		&& FACT_IDENTIFIER_RE.test(value);
}

/**
 * One reusable, synchronous re-proof handed to the owner's provider: `true` only
 * while the exact proved peer key, the current receiving grant, and the live
 * binding are still in force. It is a check and nothing else — not a lease, not a
 * capability, and not authority of its own — and a `false` or a throw means the
 * create must not be started. The owner checks it immediately before it starts
 * anything, after any callout.
 */
export type OwnerCreateAuthorizationGuard = () => boolean;

/**
 * The ONE owner-side provider shape: one request plus that minimal re-proof, and
 * one fixed fact set out. A provider needs no selected row, viewport, viewer,
 * roster entry, or local prompt, and it must never call the local interactive
 * create/activate/select path.
 */
export type OwnerCreateHandler = (
	request: OwnerCreateRequest,
	stillAuthorized: OwnerCreateAuthorizationGuard,
) => Promise<OwnerCreateFacts>;

/**
 * The existing New form's path bound, and therefore the only workspace bound this
 * contract enforces. The field is a bounded single-line path editor whose legal
 * input is up to 2048 Unicode CODE POINTS, so the widest representable value is
 * 2048 astral code points = 8192 UTF-8 bytes. Both limits are checked, nothing is
 * truncated, and the space/slash/backslash characters a real path contains are
 * preserved exactly.
 *
 * This is deliberately NOT a coarser 4096-byte cap: that would reject workspace
 * text the form itself accepts, and it is not the identifier rule either — a path
 * is not an identifier, so no character class is imposed beyond the single-line
 * safety rule the form already applies.
 */
export const OWNER_CREATE_WORKSPACE_MAX_CODEPOINTS = 2048;
/** Derived, not tunable: 2048 legal code points can occupy at most 4 UTF-8 bytes each. */
export const OWNER_CREATE_WORKSPACE_MAX_BYTES = OWNER_CREATE_WORKSPACE_MAX_CODEPOINTS * 4;

/** The same single-line safety rule the New form applies to its path field. */
const UNSAFE_WORKSPACE_RE = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;

/**
 * True only for canonical workspace text this contract can carry: a non-empty
 * string within the form's code-point bound and the derived byte bound, with no
 * control, line-breaking, or unpaired-surrogate character. Spaces, slashes, and
 * Windows backslashes are preserved; nothing is trimmed, normalized, resolved,
 * or truncated, and no path syntax is interpreted.
 */
export function isOwnerCreateWorkspace(value: unknown): value is string {
	if (typeof value !== "string" || value.length === 0) return false;
	if (UNSAFE_WORKSPACE_RE.test(value)) return false;
	let codePoints = 0;
	for (const character of value) {
		const point = character.codePointAt(0);
		// A lone surrogate survives the regex above but is not representable UTF-8.
		if (point === undefined || (point >= 0xd800 && point <= 0xdfff)) return false;
		codePoints += 1;
		if (codePoints > OWNER_CREATE_WORKSPACE_MAX_CODEPOINTS) return false;
	}
	return Buffer.byteLength(value, "utf8") <= OWNER_CREATE_WORKSPACE_MAX_BYTES;
}

/**
 * One deliberate create from a requester's own coordinator: the local
 * saved-destination handle plus the exact owner run its last written form
 * destination named, and the canonical workspace text that form held.
 *
 * `hostId` is this side's display/action handle and is never sent on the wire.
 * `hostRunId` is a REQUEST INPUT, not an observation this side may invent or
 * rewrite: a newer owner run is never substituted for it, and no row id is part
 * of the request at all.
 */
export interface PeerCreateTarget {
	/** Local saved-destination handle. Never a native instance id or identity. */
	readonly hostId: string;
	/** Exact owner run id the written form destination named. Never rewritten. */
	readonly hostRunId: string;
	/** Canonical workspace text exactly as the form held it. */
	readonly workspace: string;
}

/**
 * Fixed reasons a create was positively NEVER submitted to the transport.
 *
 * - `capability-unsupported`: the owner never acknowledged the optional create
 *   capability for this channel, so no create frame exists to send at all.
 * - `not-ready`: no eligible current channel (never acknowledged, stopped,
 *   detached, the viewer was already gone, or the bounded control-send window
 *   refused it) — nothing was written.
 * - `invalid-request`: the request or the caller's required proof could not be
 *   represented, so nothing was written.
 * - `target-unavailable`: no exact current destination/run/pin/identity to
 *   address — nothing was written.
 * - `busy`: a create is already in flight on this channel; nothing was queued,
 *   evicted, or retargeted.
 * - `limit`: this channel's monotonic anti-replay sequence is exhausted; nothing
 *   further can be submitted and nothing was written.
 */
export type PeerCreateNotSentReason =
	| "capability-unsupported"
	| "not-ready"
	| "invalid-request"
	| "target-unavailable"
	| "busy"
	| "limit";

/**
 * The one fixed result a requester may observe.
 *
 * - `owner-result` carries the owner's own fixed facts and nothing more. It is
 *   never a claim that this side's projection or a local row changed: no
 *   optimistic row is created, nothing is selected, and nothing is focused.
 * - `not-sent` is only returned with positive proof that no bytes were ever
 *   handed to the transport. It never means "the owner did nothing".
 * - `unknown` means the outcome is unobservable: the write may have been
 *   accepted, the reply may have been lost, the deadline elapsed, the grant or
 *   channel went away, or the destination was replaced. It establishes neither a
 *   child nor its absence, and nothing is ever replayed, cancelled, or retried.
 */
export type PeerCreateResult =
	| { readonly kind: "owner-result"; readonly facts: OwnerCreateFacts }
	| { readonly kind: "not-sent"; readonly reason: PeerCreateNotSentReason }
	| { readonly kind: "unknown" };

/**
 * The create-specific run proof: this side's last observation of the destination
 * must still name the EXACT owner run the request was built for.
 *
 * It is used at admission and again at the transport write boundary, so a request
 * whose destination adopted another run — a fresh subscription after a reconnect
 * or resync — is never submitted for a run this side no longer observes, and a
 * newer run is never substituted for the requested one. A missing (never
 * observed) run is never a match.
 */
export function isOwnerCreateRunStillCurrent(
	observedHostRunId: string | null,
	requestedHostRunId: string,
): boolean {
	return typeof observedHostRunId === "string"
		&& observedHostRunId.length > 0
		&& observedHostRunId === requestedHostRunId;
}

/**
 * The caller's own last-instant proof, which is REQUIRED for every create: it
 * must still be the actual written New-form destination, owner run, and
 * workspace this request was built from, and it must still own that request.
 * It is evaluated synchronously inside the ordered write that is about to call
 * the transport, after this side's own current facts are proved, so an
 * admission-only check can never submit a stale create.
 */
export interface PeerCreateOptions {
	readonly stillCurrent: () => boolean;
}

/**
 * The one Create controller owned by the existing peer coordinator. It exists
 * from construction and needs no selection, no displayed row, no controller
 * lease, no native conversation tuple, and no on-demand connection: it uses the
 * destination's existing connected metadata channel and verified peer facts.
 */
export interface PeerCreateController {
	createSession(target: PeerCreateTarget, options: PeerCreateOptions): Promise<PeerCreateResult>;
	/**
	 * Ask the same owner to create one NATIVE child in exactly one of its runs,
	 * selecting one target that OWNER advertised.
	 *
	 * Optional so an older or fake controller that never learned the native lane
	 * stays representable: a caller must prove the method exists before asking,
	 * and its absence is never answered by a Pi create, a local create, or a
	 * default backend. Where it exists it shares the ONE in-flight create and the
	 * ONE monotonic per-channel attempt number with {@link
	 * PeerCreateController.createSession}, so a native create can never run beside
	 * a Pi create on the same destination or reuse an attempt number. The result
	 * union is the same three-way {@link PeerCreateResult}, and the owner's own
	 * authoritative roster stays the only thing that produces a row.
	 */
	createNativeSession?(
		target: PeerNativeCreateTarget,
		options: PeerCreateOptions,
	): Promise<PeerCreateResult>;
}

/**
 * The production coordinator interface for a host that also answers Create:
 * every existing promise, plus the one Create controller. A caller that never
 * supplies an owner provider observes exactly the previous behavior, because the
 * optional capability is then never acknowledged by either side.
 */
export interface PeerCoordinatorWithCreate extends PeerCoordinator {
	readonly ownerCreate: PeerCreateController;
}

// ------------------------------------------------------------- native create

/**
 * One owner-advertised native interactive CLI launch target.
 *
 * This is exactly the host's own {@link NativeCliTarget} descriptor shape —
 * `id`, `backend`, `label` — and nothing else. No command, argument,
 * environment, credential, working directory, executable path, or private
 * configuration is expressible in it: the requester selects an OWNER-advertised
 * target by its exact identity, and the owner resolves that identity against its
 * own configuration at launch time. A requester's own configured target ids are
 * never reinterpreted here, and a target this owner does not advertise is never
 * mapped onto a default, another backend, or Pi.
 */
export type RemoteNativeCliTarget = NativeCliTarget;

/**
 * Bound for one advertised target label. A target label is an operator-facing
 * name only (the host composes it from its own configured entry), so it follows
 * the same single-line display-name discipline the roster row applies to labels;
 * the target ID itself is bounded by the host's one shared native target-id
 * rule in `session-backend.ts`, which this module never redefines.
 */
export const MAX_REMOTE_NATIVE_TARGET_LABEL_CHARS = 128;
/** Derived, not tunable: one code point occupies at most 4 UTF-8 bytes. */
export const MAX_REMOTE_NATIVE_TARGET_LABEL_BYTES = MAX_REMOTE_NATIVE_TARGET_LABEL_CHARS * 4;

/** A target label is bounded, non-empty, single-line display text. */
const UNSAFE_LABEL_RE = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;

function isRemoteNativeTargetLabel(value: unknown): value is string {
	if (typeof value !== "string" || value.length === 0) return false;
	if (UNSAFE_LABEL_RE.test(value)) return false;
	let codePoints = 0;
	for (const character of value) {
		const point = character.codePointAt(0);
		// A lone surrogate survives the regex but is not representable UTF-8.
		if (point === undefined || (point >= 0xd800 && point <= 0xdfff)) return false;
		codePoints += 1;
		if (codePoints > MAX_REMOTE_NATIVE_TARGET_LABEL_CHARS) return false;
	}
	return Buffer.byteLength(value, "utf8") <= MAX_REMOTE_NATIVE_TARGET_LABEL_BYTES;
}

/**
 * True only for one complete, closed target descriptor. The key set is exact:
 * an extra field (a command, an environment, a path, an auth record) is refused
 * rather than ignored, so private owner configuration cannot ride along inside a
 * descriptor this side believes it validated.
 */
export function isRemoteNativeCliTarget(value: unknown): value is RemoteNativeCliTarget {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const record = value as Record<string, unknown>;
	const keys = Object.keys(record);
	if (keys.length !== 3) return false;
	if (!isNativeCliTargetId(record.id)) return false;
	if (!isNativeCliBackend(record.backend)) return false;
	return isRemoteNativeTargetLabel(record.label);
}

/**
 * Validate and copy one advertised catalog: at most `maxTargets` entries, each a
 * closed descriptor, each id unique, every field copied into a fresh frozen
 * object. Anything this boundary cannot represent — an over-long catalog, a
 * duplicate id, a malformed or private-field-bearing entry — returns `null` so
 * the caller refuses whole rather than truncating into a different, shorter
 * choice list. Nothing is sorted, deduplicated, or dropped.
 *
 * `maxTargets` is supplied by the caller and is a transport-derived loop guard
 * (the most entries one complete frame could carry), never a product limit on how
 * many targets an owner may configure: this contract owns no target count of its
 * own, and whether a catalog can actually be sent is settled by the encoded frame
 * at the transport boundary.
 */
export function copyRemoteNativeCliTargets(
	value: unknown,
	maxTargets: number,
): readonly RemoteNativeCliTarget[] | null {
	if (!Array.isArray(value)) return null;
	if (!Number.isSafeInteger(maxTargets) || maxTargets < 0) return null;
	if (value.length > maxTargets) return null;
	const seen = new Set<string>();
	const copied: RemoteNativeCliTarget[] = [];
	for (const entry of value) {
		if (!isRemoteNativeCliTarget(entry)) return null;
		if (seen.has(entry.id)) return null;
		seen.add(entry.id);
		copied.push(Object.freeze({ id: entry.id, backend: entry.backend, label: entry.label }));
	}
	return Object.freeze(copied);
}

/**
 * The exact owner-advertised descriptor for one backend and id, or `null`.
 *
 * Matching is by BOTH fields: a configured id that exists under another backend
 * never matches, and no miss falls back to a default target, to the other
 * backend, or to Pi. This is the one lookup both the owner's admission/final
 * re-proof and a requester's own selection check use, so neither side keeps a
 * private variant of the rule.
 */
export function findRemoteNativeCliTarget(
	targets: readonly RemoteNativeCliTarget[] | null | undefined,
	backend: unknown,
	targetId: unknown,
): RemoteNativeCliTarget | null {
	if (!Array.isArray(targets) || !isNativeCliBackend(backend) || !isNativeCliTargetId(targetId)) {
		return null;
	}
	for (const target of targets) {
		if (target.backend === backend && target.id === targetId) return target;
	}
	return null;
}

/**
 * One owner-routed native create: this owner's exact run, the canonical
 * workspace text forwarded verbatim, and the exact owner-advertised backend and
 * target id the requester selected.
 *
 * Like the Pi create it is ROWLESS and carries no arbitrary command, argument,
 * environment, role, approval, selection, or viewer fact. The backend and target
 * id are not a request to configure anything: they are an identity the owner
 * must find in its own current advertised catalog, immediately and again
 * immediately before it launches.
 */
export interface OwnerNativeCreateRequest {
	/** Exact owner run id the request was authorized against and must match. */
	readonly hostRunId: string;
	/** Canonical workspace text exactly as the requester's form held it. */
	readonly workspace: string;
	/** Backend of the exact owner-advertised target this request names. */
	readonly backend: NativeCliBackend;
	/** Exact owner-advertised target id; never a requester-side configured id. */
	readonly targetId: string;
}

/**
 * The owner's ONE live native target catalog reader.
 *
 * It is read at the moments that matter — when a snapshot is about to be
 * published, when a native create is admitted, and again immediately before the
 * create provider is invoked — so a withdrawn or replaced target is never
 * launched from a stale description. It is a read of the owner's own already
 * authoritative configuration, never a second catalog: this transport stores no
 * copy of it, refreshes it on no timer, and never resolves, expands, or launches
 * anything itself. A throw, a non-array, or one malformed entry means "this
 * owner cannot represent its native targets right now", which is a refusal, not
 * a partial offer.
 */
export type OwnerNativeCliTargetProvider = () => readonly RemoteNativeCliTarget[];

/**
 * The ONE owner-side native create provider: one request naming one exact
 * advertised target, plus the same minimal re-proof the Pi create hands over,
 * and one fixed {@link OwnerCreateFacts} set out.
 *
 * It is the injected analogue of {@link OwnerCreateHandler}: the owner's Main
 * already owns the only manager, run identity, and launch path, and it will
 * apply its own existing `startSession({ workspace, backend, nativeCliTarget })`
 * semantics. It must never call a local interactive create, prompt, select, or
 * focus path, and it reports the same fixed facts: nothing here invents a
 * status registration, a native conversation id, or a durable roster write.
 */
export type OwnerNativeCreateHandler = (
	request: OwnerNativeCreateRequest,
	stillAuthorized: OwnerCreateAuthorizationGuard,
) => Promise<OwnerCreateFacts>;

/**
 * One deliberate native create from a requester's own coordinator: the local
 * saved-destination handle, the exact owner run its written form named, the
 * canonical workspace text that form held, and the exact owner-ADVERTISED
 * backend and target id the operator chose.
 *
 * `hostId` is never sent on the wire. `hostRunId` is a request input, never a
 * value this side may rewrite to a newer run. The backend and target id must
 * come from this destination's current advertised catalog: a requester's own
 * configured native target is never addressed here, and nothing is defaulted.
 */
export interface PeerNativeCreateTarget {
	/** Local saved-destination handle. Never a native instance id or identity. */
	readonly hostId: string;
	/** Exact owner run id the written form destination named. Never rewritten. */
	readonly hostRunId: string;
	/** Canonical workspace text exactly as the form held it. */
	readonly workspace: string;
	/** Backend of the exact owner-advertised target that was selected. */
	readonly backend: NativeCliBackend;
	/** Exact owner-advertised target id. */
	readonly targetId: string;
}
