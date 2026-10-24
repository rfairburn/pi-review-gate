/**
 * Sanitized storage diagnostics for the protected Network documents (Refs #494).
 *
 * The protected trust and preference stores keep their existing public errors
 * (`TRUST_STORE_FAILED`, `PEER_PREFERENCES_UNAVAILABLE`,
 * `PEER_PREFERENCES_WRITE_FAILED`). This module lets each refusal also carry one
 * fixed reason, assigned at the exact check that refused, and one fixed storage
 * object name, so a later UI can say *why* Network storage is unavailable and
 * which mitigation applies. A diagnostic is never a path, errno, mode, SID,
 * native output, key byte, or record content: both fields are closed string
 * vocabularies, and attaching one never changes the error's code or message.
 *
 * Diagnostics ride alongside the existing error objects in a module-private
 * `WeakMap`, so existing `instanceof`, `code`, and message checks are unchanged
 * and nothing new is serialized with an error.
 */

/**
 * Why storage was refused.
 *
 * - `unsafe-permissions`: owner/mode bits or a Windows DACL grant access that the
 *   required protection does not allow (or lack the owner's required rights);
 *   the explicit remediation backend can tighten this where it is supported.
 * - `extended-acl`: a macOS extended ACL grants another principal authority. It
 *   is never repaired automatically; the explicit remediation backend can
 *   remove it, through a held descriptor, from an object this account owns.
 * - `unsafe-object`: a symlink/reparse point, an unexpected object type, or an
 *   unexpected extra hard link.
 * - `foreign-owner`: owned by an account other than this one (never taken over).
 * - `protection-unsupported`: this platform, ACL shape, or protection helper
 *   cannot prove or establish protection.
 * - `unreadable`: the operating system refused access, or an IO failure occurred.
 * - `malformed`: empty, oversized, unparseable, unknown-version, or otherwise
 *   invalid document contents (judged only by the stores' strict read paths, or
 *   by size bounds metadata).
 * - `missing-initialized`: an initialized directory exists without its
 *   document; it stays unavailable and is never filled with defaults.
 * - `changed`: the object changed identity or disappeared during the operation.
 */
export type PeerStorageReason =
	| "unsafe-permissions"
	| "extended-acl"
	| "unsafe-object"
	| "foreign-owner"
	| "protection-unsupported"
	| "unreadable"
	| "malformed"
	| "missing-initialized"
	| "changed";

/**
 * The fixed Network storage objects, named for display instead of by path:
 * `session-host` (the shared state directory), `peers` and `peer-state`
 * (`peers/state.json`), `peer-preferences` and `preferences-document`
 * (`peer-preferences/preferences.json`).
 */
export type PeerStorageObject =
	| "session-host"
	| "peers"
	| "peer-state"
	| "peer-preferences"
	| "preferences-document";

export const PEER_STORAGE_REASONS: readonly PeerStorageReason[] = Object.freeze([
	"unsafe-permissions",
	"extended-acl",
	"unsafe-object",
	"foreign-owner",
	"protection-unsupported",
	"unreadable",
	"malformed",
	"missing-initialized",
	"changed",
]);

export const PEER_STORAGE_OBJECTS: readonly PeerStorageObject[] = Object.freeze([
	"session-host",
	"peers",
	"peer-state",
	"peer-preferences",
	"preferences-document",
]);

/** One sanitized refusal: a fixed reason and, when known, the fixed object. */
export interface PeerStorageDiagnostic {
	readonly reason: PeerStorageReason;
	readonly object: PeerStorageObject | null;
}

/**
 * Internal policy-level detail: whether a permission-policy refusal concerned
 * the target object itself or the containing directory the policy checked first.
 * Stores translate it into a {@link PeerStorageObject}.
 */
export type PeerStorageScope = "target" | "parent";

interface RecordedDiagnostic {
	readonly reason: PeerStorageReason;
	readonly object: PeerStorageObject | null;
	readonly scope: PeerStorageScope;
}

const recorded = new WeakMap<object, RecordedDiagnostic>();

function isReason(value: unknown): value is PeerStorageReason {
	return typeof value === "string" && (PEER_STORAGE_REASONS as readonly string[]).includes(value);
}

function isObject(value: unknown): value is PeerStorageObject {
	return typeof value === "string" && (PEER_STORAGE_OBJECTS as readonly string[]).includes(value);
}

/** Attach a fixed reason (and optional object/scope) to an existing sanitized error. */
export function withPeerStorageDiagnostic<E extends Error>(
	error: E,
	reason: PeerStorageReason,
	object: PeerStorageObject | null = null,
	scope: PeerStorageScope = "target",
): E {
	if (isReason(reason)) {
		recorded.set(error, Object.freeze({ reason, object: isObject(object) ? object : null, scope }));
	}
	return error;
}

/**
 * The sanitized diagnostic carried by an error from the Network storage
 * boundary, or `null` when the error carries none (for example an
 * `INVALID_ARGUMENT`, a caller's own exception, or an unrelated failure).
 */
export function peerStorageDiagnostic(error: unknown): PeerStorageDiagnostic | null {
	if (typeof error !== "object" || error === null) return null;
	const entry = recorded.get(error);
	return entry === undefined ? null : Object.freeze({ reason: entry.reason, object: entry.object });
}

/** Internal: the recorded reason and scope of a policy refusal, if any. */
export function peerStorageRefusalDetail(error: unknown): { reason: PeerStorageReason; scope: PeerStorageScope } | null {
	if (typeof error !== "object" || error === null) return null;
	const entry = recorded.get(error);
	return entry === undefined ? null : { reason: entry.reason, scope: entry.scope };
}
