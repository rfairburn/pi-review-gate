/**
 * The closed per-row session backend identity (issue 277 core slice).
 *
 * One hosted session row belongs to exactly one backend. `pi` is the existing
 * review-gate-managed native Pi child; the remaining members are ordinary
 * provider CLI children hosted as plain PTY processes. This module owns ONLY
 * the identity, its validation, and its stable display label: no provider
 * discovery, no configuration parsing, no capability claims, and no
 * per-backend behavior live here.
 *
 * Absence of a backend on an older row or option means `pi`. That compatibility
 * rule is deliberately the only inference: an unknown value is never normalized
 * to a backend, and a native backend is never inferred from a row's state,
 * output, or the absence of Pi telemetry.
 */

/** Every backend one hosted row may belong to. */
export type SessionBackend = "pi" | "claude" | "codex";

/** The backends hosted as an ordinary provider CLI child (everything but Pi). */
export type NativeCliBackend = Exclude<SessionBackend, "pi">;

/** The closed backend set, in display order. */
export const SESSION_BACKENDS: readonly SessionBackend[] = Object.freeze(["pi", "claude", "codex"]);

/** The closed native CLI backend set, in display order. */
export const NATIVE_CLI_BACKENDS: readonly NativeCliBackend[] = Object.freeze(["claude", "codex"]);

/**
 * The upper bound for one native CLI launch-target id. Every surface that
 * accepts a target id shares this one bound: the host manager validates a
 * create against it, and the sidebar drops an offered target that fails it, so
 * a provider choice the New form can draw is never one the manager must refuse.
 */
export const MAX_NATIVE_CLI_TARGET_CHARS = 128;

/**
 * The one native target-id rule the whole host shares: a non-empty, bounded id
 * of printable single-line text. C0 and C1 control characters (including DEL)
 * are never part of a target id. The sidebar drops a target that fails this
 * instead of offering an un-launchable choice; the manager refuses one at
 * create. Neither place keeps its own copy of the bound or the character class.
 */
export function isNativeCliTargetId(value: unknown): value is string {
  return typeof value === "string"
    && value.length > 0
    && value.length <= MAX_NATIVE_CLI_TARGET_CHARS
    && !/[\u0000-\u001f\u007f-\u009f]/.test(value);
}

/** True only for a value from the closed {@linkcode SessionBackend} set. */
export function isSessionBackend(value: unknown): value is SessionBackend {
  return value === "pi" || value === "claude" || value === "codex";
}

/** True only for a value from the closed {@linkcode NativeCliBackend} set. */
export function isNativeCliBackend(value: unknown): value is NativeCliBackend {
  return value === "claude" || value === "codex";
}

/**
 * The upper bound for one operator-set native row display name, in UTF-16 code
 * units. It is the same bound the host's single-line row label already carries
 * (`MAX_LABEL_CHARS` in the session manager), so a name the sidebar can accept
 * is never a value the manager must refuse.
 */
export const MAX_NATIVE_DISPLAY_NAME_CHARS = 80;

/**
 * The one native ROW DISPLAY NAME rule the whole host shares: a non-empty,
 * bounded, single-line value with no control characters.
 *
 * This is deliberately NOT a conversation name. A native row has no observable
 * provider conversation name, so this is only a host-side caption the operator
 * chose for one sidebar row: it is never sent to the provider, never typed into
 * the child, never compared with, defaulted from, or stored as a Pi native
 * session identity, and it never renames anything outside this host's own row
 * presentation. Neither the sidebar nor the manager keeps its own copy of this
 * bound or its character class.
 */
export function isNativeDisplayName(value: unknown): value is string {
  return typeof value === "string"
    && value.trim().length > 0
    && value.trim() === value
    && value.length <= MAX_NATIVE_DISPLAY_NAME_CHARS
    && !/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/.test(value);
}

/**
 * Resolve an optional backend option. Absence is `pi` (compatibility with every
 * older caller and row); anything outside the closed set is a caller error and
 * throws rather than being guessed.
 */
export function resolveSessionBackend(value: unknown): SessionBackend {
  if (value === undefined) return "pi";
  if (!isSessionBackend(value)) {
    throw new Error("session-host: the session backend must be one of pi, claude, or codex");
  }
  return value;
}

/**
 * The stable provider display label for one backend. It names the backend and
 * nothing else: it is never a native conversation name, never derived from
 * child output, and never a claim about what the provider session is doing.
 */
export function sessionBackendDisplayLabel(backend: SessionBackend): string {
  switch (backend) {
    case "claude": return "Claude";
    case "codex": return "Codex";
    default: return "Pi";
  }
}
