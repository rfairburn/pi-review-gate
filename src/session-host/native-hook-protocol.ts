/**
 * Closed, native-only one-shot hook-event protocol for the local status broker.
 *
 * This is deliberately a separate wire family from the Pi reporter contract in
 * ./protocol. Provider command hooks run as short-lived child processes beside
 * one owned native CLI. Each relay invocation connects to the existing local
 * status broker, authenticates with the per-owned-launch token issued before
 * that child was spawned, sends exactly one bounded event (or one closed
 * failure reason), reads one fixed-size acknowledgement, and closes. Nothing
 * here can masquerade as a Pi reporter: a native source registration is issued
 * by the broker's native-only API, lives in its own record/token map, and never
 * touches Pi hello/status sequencing, the Pi active connection, reconnect
 * callbacks, or any Pi command authority.
 *
 * Privacy contract (closed field set):
 *
 * - Only the original provider hook field names named below may cross the wire,
 *   plus one closed derived projection: `background_counts` for a validated
 *   Claude Stop/SubagentStop `background_tasks` snapshot. Question text,
 *   answers, prompt text, tool arguments, tool results/response bodies,
 *   transcript lines, terminal output, task descriptions/commands/IDs, and
 *   arbitrary provider fields are never selected, stored, logged, or relayed.
 *   The relay selects these fields BEFORE it builds a frame, and the broker's
 *   strict decoder rebuilds the object from the same allowlist, so an extra
 *   field cannot reach a callback. The counts are native provider observations
 *   only; they are never Pi `backgroundTasks`/`backgroundShells`, ownership,
 *   Stop authority, or an inference from earlier events.
 * - Identifiers and paths are bounded, strict text: no C0/DEL/C1 controls, no
 *   line/paragraph separators, and a fixed UTF-8 byte cap. A transcript path is
 *   the provider's own path string, never the transcript's contents.
 * - Normal success/failure emits no stdout, no permission/control JSON, and no
 *   diagnostics. A provider hook observer never authorizes, denies, or blocks a
 *   native operation.
 *
 * Honest limitation: this lane is event observation only. If the provider never
 * runs the hook, the relay cannot connect, the process is killed before it
 * writes, or the broker is gone, that loss is NOT reported to the bound source.
 * There is no heartbeat, queue, retry, replay, or false liveness signal; absent
 * observations remain unknown and are never inferred from a normal close.
 */

import { isAbsolute, posix as posixPath } from "node:path";
import { isRecord } from "../record-guard";
import { isNativeCliBackend, type NativeCliBackend } from "./session-backend";

/**
 * Narrow child-environment marker carrying one owned launch's native hook
 * bootstrap JSON. The existing capability sanitizer strips it from inherited
 * provider/Pi child environments; source-specific wiring injects the fresh
 * per-launch value later. Keeping the secret in this environment marker (never
 * in provider hook command text) is what lets a Codex command string stay
 * byte-stable across rows so normal command-trust hashes can persist.
 */
export const NATIVE_HOOK_BOOTSTRAP_ENV = "PI_REVIEW_GATE_NATIVE_HOOK_BOOTSTRAP";

export const NATIVE_HOOK_PROTOCOL_VERSION = 1;

/** Maximum one-shot wire frame, including its newline, in raw UTF-8 bytes. */
export const MAX_NATIVE_HOOK_FRAME_BYTES = 4096;

/** Maximum fixed-size acknowledgement frame, including its newline. */
export const MAX_NATIVE_HOOK_ACK_BYTES = 128;

/** Maximum bootstrap JSON accepted from the child-environment marker. */
export const MAX_NATIVE_HOOK_BOOTSTRAP_ENV_BYTES = 4096;

/**
 * Maximum provider hook stdin document read by the relay. Native tool responses
 * can be large, so this is a deliberate one-megabyte observation bound: an
 * oversized document is reported as a closed failure reason instead of being
 * read without limit.
 */
export const MAX_NATIVE_HOOK_STDIN_BYTES = 1_048_576;

/**
 * Maximum entries admitted from a Claude Stop/SubagentStop `background_tasks`
 * snapshot. A longer array is reported as an authenticated overflow failure
 * rather than counted partially (which would undercount) or zeroed.
 */
export const MAX_NATIVE_HOOK_BACKGROUND_TASKS = 64;

const MAX_SOCKET_PATH_LENGTH = 2048;
const MAX_INSTANCE_ID_LENGTH = 128;
const MAX_NATIVE_HOOK_ID_BYTES = 256;
const MAX_NATIVE_HOOK_LABEL_BYTES = 128;
const MAX_NATIVE_HOOK_PATH_BYTES = 2048;
const MAX_NATIVE_HOOK_TASK_STATUS_BYTES = 64;

/** UUID-like host/instance identity: hex digits and hyphens, at least one hex digit. */
const ID_PATTERN = /^[0-9a-f-]*[0-9a-f][0-9a-f-]*$/i;
/** Cryptorandom hex token issued by the broker (32 random bytes). */
const TOKEN_PATTERN = /^[0-9a-f]{64}$/i;
/** Generated Windows named-pipe address shape owned by this broker family. */
const LOCAL_PIPE_ADDRESS_PATTERN = /^\\\\\.\\pipe\\prg-st-[0-9a-f]{32}$/;

/**
 * The complete admitted provider hook event-name set. Only names a source
 * integration has actually established are admitted; adding another event is a
 * protocol change, not a relay option.
 */
export const NATIVE_HOOK_EVENT_NAMES = Object.freeze([
  "SessionStart",
  "SessionEnd",
  "UserPromptSubmit",
  "PreToolUse",
  "PostToolUse",
  "PostToolUseFailure",
  "Stop",
  "StopFailure",
  "SubagentStart",
  "SubagentStop",
] as const);

export type NativeHookEventName = (typeof NATIVE_HOOK_EVENT_NAMES)[number];

/**
 * Closed failure reasons the relay can report for a validly authenticated
 * source. They describe the observation attempt only, never provider content or
 * an authorization decision.
 */
export const NATIVE_HOOK_FAILURE_REASONS = Object.freeze([
  "input-malformed",
  "input-too-large",
  "input-not-utf8",
  "input-invalid",
  "input-timeout",
  "input-unavailable",
  "unsupported-hook",
] as const);

export type NativeHookFailureReason = (typeof NATIVE_HOOK_FAILURE_REASONS)[number];

/**
 * Closed reason set a bound native source's failure callback may observe:
 * relay-reported wire reasons, or the host-local `delivery-refused` the broker
 * produces when this exact authenticated source's delivery is discarded by
 * post-auth admission. `delivery-refused` is deliberately absent from
 * NATIVE_HOOK_FAILURE_REASONS, so no relay can send it and no wire frame can
 * decode or select it.
 */
export type NativeHookCallbackFailureReason = NativeHookFailureReason | "delivery-refused";

/**
 * One owned launch's one-shot native hook bootstrap. It is returned before the
 * native child spawns and is invalidated by the owning registration's release
 * or the broker's disposal.
 */
export interface NativeHookBootstrap {
  version: 1;
  /** Existing broker endpoint (POSIX Unix socket or local Windows named pipe). */
  socketPath: string;
  generation: string;
  instanceId: string;
  backend: NativeCliBackend;
  token: string;
}

/**
 * Small sanitized projection of Claude's Stop/SubagentStop `background_tasks`
 * snapshot. It counts only the provider's running/pending and backgrounded
 * entries; `shell` is a shell and every other nonempty native type label is a
 * task. It is native provider observation only, never Pi/host ownership,
 * `backgroundTasks`/`backgroundShells`, or Stop-authority state. A SubagentStop
 * snapshot is that subagent hook's whole array, not proof of root scope; the
 * host may conservatively use only root Stop snapshots.
 */
export interface NativeHookBackgroundCounts {
  tasks: number;
  shells: number;
}

/**
 * Selected provider hook metadata using the provider's original field names.
 * Every field except `hook_event_name` is optional; absence is unknown and is
 * never filled in with a guessed value. `background_counts` is the only
 * derived field: the relay validates the whole native Stop/SubagentStop
 * `background_tasks` array and projects closed counts. It is absent when the
 * provider omitted the snapshot and is never reconstructed from event edges.
 */
export interface NativeHookEventMetadata {
  hook_event_name: NativeHookEventName;
  session_id?: string;
  transcript_path?: string;
  agent_id?: string;
  agent_type?: string;
  prompt_id?: string;
  turn_id?: string;
  source?: string;
  reason?: string;
  tool_name?: string;
  tool_use_id?: string;
  /** Present only for a validated Stop/SubagentStop snapshot; [] means real 0/0. */
  background_counts?: NativeHookBackgroundCounts;
}

/** Sanitized event delivered to a bound native source callback (no token/auth fields). */
export interface NativeHookEvent extends NativeHookEventMetadata {
  readonly backend: NativeCliBackend;
}

/**
 * Sanitized failure delivered to a bound native source callback (no provider
 * content). Relay-reported reasons come from the closed wire set. The
 * host-local `delivery-refused` is produced only by the broker after this exact
 * authenticated source's delivery was discarded by post-auth admission; it is
 * a known observation loss, never a relay input failure or a wire value.
 */
export interface NativeHookFailure {
  readonly backend: NativeCliBackend;
  readonly reason: NativeHookCallbackFailureReason;
}

/** Native event wire frame: one authenticated one-shot delivery. */
export interface NativeHookEventFrame extends NativeHookEvent {
  version: 1;
  type: "native_hook_event";
  instanceId: string;
  generation: string;
  token: string;
}

/** Native failure wire frame: one authenticated closed failure report. */
export interface NativeHookFailureFrame {
  version: 1;
  type: "native_hook_failure";
  instanceId: string;
  generation: string;
  backend: NativeCliBackend;
  token: string;
  reason: NativeHookFailureReason;
}

/** Fixed-size broker acknowledgement; it echoes no source data. */
export interface NativeHookAckFrame {
  version: 1;
  type: "native_hook_ack";
  accepted: boolean;
}

export type NativeHookFrame = NativeHookEventFrame | NativeHookFailureFrame;

export type DecodedNativeHookFrame =
  | {
    readonly kind: "event";
    readonly frame: NativeHookEventFrame;
    /** Sanitized callback value with all auth fields removed. */
    readonly event: NativeHookEvent;
  }
  | {
    readonly kind: "failure";
    readonly frame: NativeHookFailureFrame;
    /** Sanitized callback value with all auth fields removed. */
    readonly failure: NativeHookFailure;
  };

/** Provider stdin selection outcome: sanitized metadata or a closed failure reason. */
export type NativeHookProviderInputResult =
  | { readonly ok: true; readonly metadata: NativeHookEventMetadata }
  | { readonly ok: false; readonly reason: NativeHookFailureReason };

/** Whole-array background snapshot projection or a closed failure reason. */
export type NativeHookBackgroundCountsResult =
  | { readonly ok: true; readonly counts: NativeHookBackgroundCounts }
  | { readonly ok: false; readonly reason: "input-invalid" | "input-too-large" };

const METADATA_TEXT_LIMITS: Readonly<
  Record<Exclude<keyof NativeHookEventMetadata, "hook_event_name" | "background_counts">, number>
> = Object.freeze({
  session_id: MAX_NATIVE_HOOK_ID_BYTES,
  transcript_path: MAX_NATIVE_HOOK_PATH_BYTES,
  agent_id: MAX_NATIVE_HOOK_ID_BYTES,
  agent_type: MAX_NATIVE_HOOK_LABEL_BYTES,
  prompt_id: MAX_NATIVE_HOOK_ID_BYTES,
  turn_id: MAX_NATIVE_HOOK_ID_BYTES,
  source: MAX_NATIVE_HOOK_LABEL_BYTES,
  reason: MAX_NATIVE_HOOK_LABEL_BYTES,
  tool_name: MAX_NATIVE_HOOK_LABEL_BYTES,
  tool_use_id: MAX_NATIVE_HOOK_ID_BYTES,
});

const METADATA_KEYS: ReadonlySet<string> = new Set([
  ...Object.keys(METADATA_TEXT_LIMITS),
  "background_counts",
]);
const BACKGROUND_COUNT_KEYS: ReadonlySet<string> = new Set(["tasks", "shells"]);
const EVENT_FRAME_KEYS: ReadonlySet<string> = new Set([
  "version",
  "type",
  "instanceId",
  "generation",
  "backend",
  "token",
  "hook_event_name",
  ...METADATA_KEYS,
]);
const FAILURE_FRAME_KEYS: ReadonlySet<string> = new Set([
  "version",
  "type",
  "instanceId",
  "generation",
  "backend",
  "token",
  "reason",
]);
const BOOTSTRAP_KEYS: ReadonlySet<string> = new Set([
  "version",
  "socketPath",
  "generation",
  "instanceId",
  "backend",
  "token",
]);
const ACK_KEYS: ReadonlySet<string> = new Set(["version", "type", "accepted"]);

/** True only for a value from the closed event-name set. */
export function isNativeHookEventName(value: unknown): value is NativeHookEventName {
  return typeof value === "string" && (NATIVE_HOOK_EVENT_NAMES as readonly string[]).includes(value);
}

/** True only for a value from the closed failure-reason set. */
export function isNativeHookFailureReason(value: unknown): value is NativeHookFailureReason {
  return typeof value === "string" && (NATIVE_HOOK_FAILURE_REASONS as readonly string[]).includes(value);
}

/** Bounded host/instance identity shape shared with the broker registration API. */
export function isValidNativeHookInstanceId(value: unknown): value is string {
  return typeof value === "string"
    && value.length >= 1
    && value.length <= MAX_INSTANCE_ID_LENGTH
    && ID_PATTERN.test(value);
}

function isValidGeneration(value: unknown): value is string {
  return isValidNativeHookInstanceId(value);
}

function isValidToken(value: unknown): value is string {
  return typeof value === "string" && TOKEN_PATTERN.test(value);
}

function isValidSocketPath(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0 || value.includes("\0")) return false;
  if (LOCAL_PIPE_ADDRESS_PATTERN.test(value)) return true;
  return value.length <= MAX_SOCKET_PATH_LENGTH
    && value.startsWith("/")
    && value !== "/"
    && !value.endsWith("/")
    && posixPath.normalize(value) === value;
}

function isBoundedText(value: unknown, maxBytes: number): value is string {
  return typeof value === "string"
    && value.length > 0
    && Buffer.byteLength(value, "utf8") <= maxBytes
    && !/[\x00-\x1f\x7f\u0080-\u009f\u2028\u2029]/.test(value);
}

function isBoundedTranscriptPath(value: unknown): value is string {
  return isBoundedText(value, MAX_NATIVE_HOOK_PATH_BYTES)
    && isAbsolute(value)
    && !value.includes("\0");
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: ReadonlySet<string>): boolean {
  return Object.keys(value).every((key) => allowed.has(key));
}

function parseBackend(value: unknown): NativeCliBackend | undefined {
  return isNativeCliBackend(value) ? value : undefined;
}

/**
 * Validates one parsed bootstrap. Returns undefined (never throws) for a
 * missing, extra, or malformed field, so an inherited/foreign marker can never
 * half-authenticate a relay.
 */
export function parseNativeHookBootstrap(value: unknown): NativeHookBootstrap | undefined {
  if (!isRecord(value) || !hasOnlyKeys(value, BOOTSTRAP_KEYS)) return undefined;
  if (value.version !== NATIVE_HOOK_PROTOCOL_VERSION) return undefined;
  const backend = parseBackend(value.backend);
  if (!backend) return undefined;
  if (!isValidSocketPath(value.socketPath)) return undefined;
  if (!isValidGeneration(value.generation)) return undefined;
  if (!isValidNativeHookInstanceId(value.instanceId)) return undefined;
  if (!isValidToken(value.token)) return undefined;
  return {
    version: 1,
    socketPath: value.socketPath,
    generation: value.generation,
    instanceId: value.instanceId,
    backend,
    token: value.token,
  };
}

/** Parses the narrow child-environment marker value without retaining it elsewhere. */
export function parseNativeHookBootstrapEnv(value: unknown): NativeHookBootstrap | undefined {
  if (typeof value !== "string" || value.length === 0
    || Buffer.byteLength(value, "utf8") > MAX_NATIVE_HOOK_BOOTSTRAP_ENV_BYTES) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return undefined;
  }
  return parseNativeHookBootstrap(parsed);
}

/** Serializes one already-typed bootstrap for the narrow child-environment marker. */
export function encodeNativeHookBootstrapEnv(bootstrap: NativeHookBootstrap): string {
  const encoded = JSON.stringify(bootstrap);
  if (Buffer.byteLength(encoded, "utf8") > MAX_NATIVE_HOOK_BOOTSTRAP_ENV_BYTES) {
    throw new RangeError(`native hook bootstrap exceeds ${MAX_NATIVE_HOOK_BOOTSTRAP_ENV_BYTES} bytes`);
  }
  return encoded;
}

/**
 * Validates a whole Claude Stop/SubagentStop `background_tasks` array and
 * projects only closed counts. Every entry is checked before any filtering so
 * a malformed/oversized/truncated snapshot becomes an explicit unknown failure
 * rather than a partial count, an undercount, or a fabricated zero.
 *
 * Filter: status is exactly `running` or `pending` AND `backgrounded === true`.
 * Classification for kept entries: `type === "shell"` is a shell; every other
 * nonempty native type label is a task. Extra provider fields (descriptions,
 * commands, IDs, output, crons) are intentionally ignored.
 */
export function deriveNativeHookBackgroundCounts(value: unknown): NativeHookBackgroundCountsResult {
  if (!Array.isArray(value)) return { ok: false, reason: "input-invalid" };
  if (value.length > MAX_NATIVE_HOOK_BACKGROUND_TASKS) return { ok: false, reason: "input-too-large" };
  let tasks = 0;
  let shells = 0;
  for (const entry of value) {
    if (!isRecord(entry)) return { ok: false, reason: "input-invalid" };
    const status = entry.status;
    if (!isBoundedText(status, MAX_NATIVE_HOOK_TASK_STATUS_BYTES)) {
      return typeof status === "string" && Buffer.byteLength(status, "utf8") > MAX_NATIVE_HOOK_TASK_STATUS_BYTES
        ? { ok: false, reason: "input-too-large" }
        : { ok: false, reason: "input-invalid" };
    }
    if (typeof entry.backgrounded !== "boolean") return { ok: false, reason: "input-invalid" };
    const type = entry.type;
    if (!isBoundedText(type, MAX_NATIVE_HOOK_LABEL_BYTES)) {
      return typeof type === "string" && Buffer.byteLength(type, "utf8") > MAX_NATIVE_HOOK_LABEL_BYTES
        ? { ok: false, reason: "input-too-large" }
        : { ok: false, reason: "input-invalid" };
    }
    if ((status === "running" || status === "pending") && entry.backgrounded) {
      if (type === "shell") shells += 1;
      else tasks += 1;
    }
  }
  return { ok: true, counts: { tasks, shells } };
}

/**
 * Selects only closed metadata from one already-parsed provider stdin value.
 * Unknown provider fields are ignored (never copied); a present allowlisted
 * field that is malformed or oversized is an explicit closed failure. Selection
 * happens BEFORE any wire encoding, so sensitive provider text has no path into
 * the frame. The optional `background_counts` projection is derived only for
 * the established Stop/SubagentStop snapshot field.
 */
export function sanitizeNativeHookProviderInput(value: unknown): NativeHookProviderInputResult {
  if (!isRecord(value)) return { ok: false, reason: "input-invalid" };
  const name = value.hook_event_name;
  if (typeof name !== "string") return { ok: false, reason: "input-invalid" };
  if (!isNativeHookEventName(name)) return { ok: false, reason: "unsupported-hook" };
  const metadata: { -readonly [Key in keyof NativeHookEventMetadata]: NativeHookEventMetadata[Key] } = {
    hook_event_name: name,
  };
  for (const [key, limit] of Object.entries(METADATA_TEXT_LIMITS) as [keyof typeof METADATA_TEXT_LIMITS, number][]) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) continue;
    const field = value[key];
    if (key === "transcript_path") {
      if (!isBoundedTranscriptPath(field)) return { ok: false, reason: "input-invalid" };
    } else if (!isBoundedText(field, limit)) {
      return { ok: false, reason: "input-invalid" };
    }
    (metadata as Record<string, unknown>)[key] = field;
  }
  if (name === "Stop" || name === "SubagentStop") {
    if (Object.prototype.hasOwnProperty.call(value, "background_tasks")) {
      const derived = deriveNativeHookBackgroundCounts(value.background_tasks);
      if (!derived.ok) return { ok: false, reason: derived.reason };
      metadata.background_counts = derived.counts;
    }
  }
  return { ok: true, metadata };
}

function parseNativeHookBackgroundCounts(value: unknown): NativeHookBackgroundCounts | undefined {
  if (!isRecord(value) || !hasOnlyKeys(value, BACKGROUND_COUNT_KEYS)) return undefined;
  const tasks = value.tasks;
  const shells = value.shells;
  if (!Number.isSafeInteger(tasks) || (tasks as number) < 0 || (tasks as number) > MAX_NATIVE_HOOK_BACKGROUND_TASKS) return undefined;
  if (!Number.isSafeInteger(shells) || (shells as number) < 0 || (shells as number) > MAX_NATIVE_HOOK_BACKGROUND_TASKS) return undefined;
  if ((tasks as number) + (shells as number) > MAX_NATIVE_HOOK_BACKGROUND_TASKS) return undefined;
  return { tasks: tasks as number, shells: shells as number };
}

function parseEventFrame(value: Record<string, unknown>): NativeHookEventFrame | undefined {
  if (!hasOnlyKeys(value, EVENT_FRAME_KEYS)) return undefined;
  if (value.version !== NATIVE_HOOK_PROTOCOL_VERSION || value.type !== "native_hook_event") return undefined;
  const backend = parseBackend(value.backend);
  if (!backend) return undefined;
  if (!isValidNativeHookInstanceId(value.instanceId)) return undefined;
  if (!isValidGeneration(value.generation)) return undefined;
  if (!isValidToken(value.token)) return undefined;
  const selected = sanitizeNativeHookProviderInput(value);
  if (!selected.ok) return undefined;
  let backgroundCounts: NativeHookBackgroundCounts | undefined;
  if (Object.prototype.hasOwnProperty.call(value, "background_counts")) {
    // Only the established Stop-family snapshot projection may carry counts.
    if (value.hook_event_name !== "Stop" && value.hook_event_name !== "SubagentStop") return undefined;
    backgroundCounts = parseNativeHookBackgroundCounts(value.background_counts);
    if (!backgroundCounts) return undefined;
  }
  return {
    version: 1,
    type: "native_hook_event",
    instanceId: value.instanceId,
    generation: value.generation,
    backend,
    token: value.token,
    ...selected.metadata,
    ...(backgroundCounts === undefined ? {} : { background_counts: backgroundCounts }),
  };
}

function parseFailureFrame(value: Record<string, unknown>): NativeHookFailureFrame | undefined {
  if (!hasOnlyKeys(value, FAILURE_FRAME_KEYS)) return undefined;
  if (value.version !== NATIVE_HOOK_PROTOCOL_VERSION || value.type !== "native_hook_failure") return undefined;
  const backend = parseBackend(value.backend);
  if (!backend) return undefined;
  if (!isValidNativeHookInstanceId(value.instanceId)) return undefined;
  if (!isValidGeneration(value.generation)) return undefined;
  if (!isValidToken(value.token)) return undefined;
  if (!isNativeHookFailureReason(value.reason)) return undefined;
  return {
    version: 1,
    type: "native_hook_failure",
    instanceId: value.instanceId,
    generation: value.generation,
    backend,
    token: value.token,
    reason: value.reason,
  };
}

/**
 * Strictly decodes one newline-framed native hook frame. Malformed, oversized,
 * extra-field, and unknown-type input returns undefined; the broker then closes
 * the connection without invoking any callback. A valid frame still has to
 * authenticate against the matching native registration before its event is
 * observable.
 */
export function decodeNativeHookFrame(line: string): DecodedNativeHookFrame | undefined {
  if (typeof line !== "string") return undefined;
  const body = line.endsWith("\n") ? line.slice(0, -1) : line;
  if (Buffer.byteLength(body + "\n", "utf8") > MAX_NATIVE_HOOK_FRAME_BYTES) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return undefined;
  }
  if (!isRecord(parsed)) return undefined;
  if (parsed.type === "native_hook_event") {
    const frame = parseEventFrame(parsed);
    if (!frame) return undefined;
    const { hook_event_name, session_id, transcript_path, agent_id, agent_type, prompt_id, turn_id, source, reason, tool_name, tool_use_id, background_counts } = frame;
    return {
      kind: "event",
      frame,
      event: {
        backend: frame.backend,
        hook_event_name,
        ...(session_id === undefined ? {} : { session_id }),
        ...(transcript_path === undefined ? {} : { transcript_path }),
        ...(agent_id === undefined ? {} : { agent_id }),
        ...(agent_type === undefined ? {} : { agent_type }),
        ...(prompt_id === undefined ? {} : { prompt_id }),
        ...(turn_id === undefined ? {} : { turn_id }),
        ...(source === undefined ? {} : { source }),
        ...(reason === undefined ? {} : { reason }),
        ...(tool_name === undefined ? {} : { tool_name }),
        ...(tool_use_id === undefined ? {} : { tool_use_id }),
        ...(background_counts === undefined ? {} : { background_counts }),
      },
    };
  }
  if (parsed.type === "native_hook_failure") {
    const frame = parseFailureFrame(parsed);
    if (!frame) return undefined;
    return { kind: "failure", frame, failure: { backend: frame.backend, reason: frame.reason } };
  }
  return undefined;
}

/** Validates one parsed broker acknowledgement. */
export function parseNativeHookAck(value: unknown): NativeHookAckFrame | undefined {
  if (!isRecord(value) || !hasOnlyKeys(value, ACK_KEYS)) return undefined;
  if (value.version !== NATIVE_HOOK_PROTOCOL_VERSION || value.type !== "native_hook_ack") return undefined;
  if (typeof value.accepted !== "boolean") return undefined;
  return { version: 1, type: "native_hook_ack", accepted: value.accepted };
}

/**
 * Decodes one bounded acknowledgement line. The relay accepts only this fixed
 * shape; no broker/source data is echoed and no other message type is admitted.
 */
export function decodeNativeHookAck(line: string): NativeHookAckFrame | undefined {
  if (typeof line !== "string") return undefined;
  const body = line.endsWith("\n") ? line.slice(0, -1) : line;
  if (Buffer.byteLength(body + "\n", "utf8") > MAX_NATIVE_HOOK_ACK_BYTES) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return undefined;
  }
  return parseNativeHookAck(parsed);
}

/**
 * Encodes one native frame as a newline-terminated wire message. Throws
 * RangeError if the bounded frame would exceed its own cap.
 */
export function encodeNativeHookFrame(message: NativeHookFrame | NativeHookAckFrame): string {
  const frame = `${JSON.stringify(message)}\n`;
  const limit = message.type === "native_hook_ack" ? MAX_NATIVE_HOOK_ACK_BYTES : MAX_NATIVE_HOOK_FRAME_BYTES;
  if (Buffer.byteLength(frame, "utf8") > limit) {
    throw new RangeError(`native hook frame exceeds ${limit} bytes`);
  }
  return frame;
}
