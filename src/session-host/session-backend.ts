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

/**
 * The reserved default native launch-target id, one per native backend. This
 * is the ONE canonical source of those ids: the native CLI launcher derives its
 * default records from it, the manager defaults an untargeted native row to it,
 * and {@linkcode isNativeCliNewSessionTarget} derives the NEW-session choice
 * rule from it. No surface keeps its own copy.
 */
export const NATIVE_CLI_DEFAULT_TARGET_IDS: Readonly<Record<NativeCliBackend, string>> = Object.freeze({
  claude: "claude",
  codex: "codex",
});

/**
 * The id prefix of a configured shared external-agent CLI launch target
 * (`external:<id>`), so a configured id that reads `claude` never collides
 * with a default target. The native CLI launcher builds those ids with it, and
 * {@linkcode nativeCliRestoreTargetId} recognizes a remembered legacy one by it.
 */
export const NATIVE_CLI_EXTERNAL_TARGET_PREFIX = "external:";

/**
 * True only for the one native target a NEW session may launch for its
 * backend: that backend's reserved default id (issue #493). A NEW session's
 * choices are the three backend kinds — Pi (the ordinary create) and the
 * Claude and Codex defaults — never a configured named external worker profile
 * (`external:<id>`), so a profile configured for delegated review or execution
 * can never become a NEW interactive session choice.
 *
 * It is derived from {@linkcode NATIVE_CLI_DEFAULT_TARGET_IDS} rather than
 * stored beside any target list. The wire and remembered-identity parsers keep
 * accepting every well-formed target id; restoration maps a remembered id with
 * {@linkcode nativeCliRestoreTargetId}.
 */
export function isNativeCliNewSessionTarget(backend: unknown, targetId: unknown): boolean {
  return isNativeCliBackend(backend) && targetId === NATIVE_CLI_DEFAULT_TARGET_IDS[backend];
}

/**
 * The launch target a remembered native row restores with (issue #493), or
 * `undefined` when its remembered target id names no restorable target.
 *
 * Restoration uses the same normal backend defaults a NEW session does. A row
 * remembered with its backend's default id restores with that default
 * unchanged. A row remembered with a legacy configured external target
 * (`external:<id>`, whatever its id, configured now or not) is deliberately
 * restored with its BACKEND's default target — base Claude or base Codex —
 * never with that worker profile's command, args, or environment, and with no
 * lookup of the old entry. That is an approved compatibility decision, not a
 * fallback: the remembered provider conversation, workspace, and caption are
 * still the exact ones resumed, and a row whose identity cannot be restored is
 * still refused rather than started fresh. Any other id — another backend's
 * default, or a form no host ever produced — is not mapped and stays refused.
 */
export function nativeCliRestoreTargetId(backend: unknown, rememberedTargetId: unknown): string | undefined {
  if (!isNativeCliBackend(backend) || !isNativeCliTargetId(rememberedTargetId)) return undefined;
  const defaultId = NATIVE_CLI_DEFAULT_TARGET_IDS[backend];
  if (rememberedTargetId === defaultId) return defaultId;
  if (rememberedTargetId.startsWith(NATIVE_CLI_EXTERNAL_TARGET_PREFIX)
    && rememberedTargetId.length > NATIVE_CLI_EXTERNAL_TARGET_PREFIX.length) {
    return defaultId;
  }
  return undefined;
}

/**
 * The NEW-session projection of one native target list: exactly its entries
 * that {@linkcode isNativeCliNewSessionTarget} admits, in their original order,
 * as a fresh frozen array. It is a read-time view of a list some other owner
 * holds, never a second stored catalog.
 */
export function projectNativeCliNewSessionTargets<T extends { readonly id: string; readonly backend: NativeCliBackend }>(
  targets: readonly T[],
): readonly T[] {
  return Object.freeze(targets.filter((target) => isNativeCliNewSessionTarget(target.backend, target.id)));
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
 * The one MANUAL CAPTION rule the whole host shares: a non-empty, bounded,
 * single-line value with no control characters.
 *
 * This is the rule for text an OPERATOR typed: the caption they chose for one sidebar
 * row (durable, remembered on the row's slot). It is deliberately NOT a conversation
 * rename, and it is NOT the rule for a provider's own conversation title — an observed
 * provider title is display text this host neither invented nor could edit, so it is
 * measured against the canonical published-label bound it must survive travelling in
 * ({@linkcode isValidNativeDisplayName} in the status protocol, the bound a Pi row's
 * observed native name already satisfies), never against this input bound. Making the
 * narrower manual bound out to be a provider limit would silently discard valid
 * provider titles.
 *
 * Neither kind is ever sent to the provider, typed into the child, compared with,
 * defaulted from, or stored as a Pi native session identity, and neither renames
 * anything outside this host's own row presentation. Neither the sidebar nor the
 * manager keeps its own copy of this bound or its character class.
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
