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
