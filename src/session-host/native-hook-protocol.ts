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
 *   Claude Stop/SubagentStop `background_tasks` snapshot, plus two further
 *   closed projections of that same validated snapshot and of an actual
 *   successful background launch: `background_members` (opaque member id +
 *   `task`/`shell` kind) and `background_started` (one confirmed launch id +
 *   kind, from a real `PostToolUse` result only). Question text,
 *   answers, prompt text, tool arguments, tool results/response bodies,
 *   transcript lines, terminal output, task descriptions/commands/IDs, and
 *   arbitrary provider fields are never selected, stored, logged, or relayed.
 *   The relay selects these fields BEFORE it builds a frame, and the broker's
 *   strict decoder rebuilds the object from the same allowlist, so an extra
 *   field cannot reach a callback. The counts are native provider observations
 *   only; they are never Pi `backgroundTasks`/`backgroundShells`, ownership,
 *   Stop authority, or an inference from earlier events.
 *   `background_members` is the whole-array membership form of the same
 *   snapshot (never a partial view: an entry that cannot be identified makes
 *   the projection absent rather than shrinking it), and `background_started`
 *   carries only an id and a kind — never a description, command, prompt, tool
 *   argument, or result body. A `PreToolUse` backgrounding intent is never a
 *   launch, and a foreground agent never produces one.
 *  `background_unidentified_kinds` names, for that same snapshot, only the
 *   closed `task`/`shell` categories it held an active member of WITHOUT a usable
 *   id — the categories whose membership this projection cannot key. It carries
 *   no id, no count, and no provider label text, is never present beside
 *   `background_members`, and never changes the counts, which stay exact.
 * - Identifiers and paths are bounded, strict text: no C0/DEL/C1 controls, no
 *   line/paragraph separators, and a fixed UTF-8 byte cap. A transcript path is
 *   the provider's own path string, never the transcript's contents.
 * - `cwd` is the provider's own generic hook base field, selected ONLY from a
 *   `SessionStart` and only as a bounded absolute path. It exists so the host can
 *   compare a root conversation boundary against the row's own selected
 *   workspace; it is never selected from any other event, never derived from a
 *   transcript path or filename, and never used to discover anything. An
 *   unusable value is omitted (unproven), not guessed, and a Codex frame never
 *   carries it to a callback.
 * - `claude_inbox_announcement` (#682) is the one relay-to-broker attachment that
 *   is not provider stdin metadata: the inbox socket path and hook token the
 *   relay selected from its own environment for a Claude root `SessionStart`
 *   via ./native-claude-inbox-announcement. It rides only inside the existing
 *   authenticated frame and its unchanged byte bound (the relay drops it rather
 *   than the event when it does not fit). The decoder stores it only when it has
 *   the closed shape (a malformed one is ignored, never costing the ordinary
 *   event) and keeps it out of the rebuilt frame and the callback event; the
 *   broker revalidates it with that helper only after authentication. This
 *   module deliberately does not import the helper, so the launcher's minimal
 *   dependency closure is unchanged.
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

/**
 * Maximum UTF-8 bytes of one opaque background member/launch id. The installed
 * provider issues 9-character ids (`Fw`/`Y1` ~287020178); this bound is wider
 * so a provider id-shape change cannot silently discard genuine membership,
 * while still refusing anything that is not an opaque bounded id.
 */
export const MAX_NATIVE_HOOK_MEMBER_ID_BYTES = 64;

/**
 * Aggregate UTF-8 byte budget for the ids of one projected membership set. It
 * keeps a maximum-size membership frame inside the fixed frame bound instead of
 * letting it fail only at encode time.
 */
export const MAX_NATIVE_HOOK_MEMBERS_ID_BYTES = 1024;

/** Closed member-kind set shared with the membership ledger. */
export const NATIVE_HOOK_BACKGROUND_KINDS = Object.freeze(["task", "shell"] as const);

/**
 * The only tool whose verified result can report a backgrounded SHELL: the
 * provider's Bash tool (name constant `Re = "Bash"` ~281330375; result schema
 * `$No` ~294172813; result key set `PIt` ~294083573; and the provider's own
 * result validator `vhi` ~294177345 accepts `backgroundTaskId` only when
 * `Y1("local_bash", id)` holds). No other tool's result field is treated as
 * shell-lifecycle evidence, even if it carries the same field name.
 */
export const NATIVE_HOOK_SHELL_LAUNCH_TOOL = "Bash";

/**
 * The only tools whose verified result can report a backgrounded TASK: the
 * provider's subagent tool (name constant `ou = "Task"` ~282970790, and the
 * provider's own name dispatch at ~282417100 accepts both `"Task"` and
 * `"Agent"` for it), whose async result schema `vo` ~298108731 states
 * `status: "async_launched"` together with `agentId`.
 */
export const NATIVE_HOOK_TASK_LAUNCH_TOOLS = Object.freeze(["Task", "Agent"] as const);

/** True only for the verified shell-launch tool name. */
export function isNativeHookShellLaunchTool(value: unknown): boolean {
  return value === NATIVE_HOOK_SHELL_LAUNCH_TOOL;
}

/** True only for a verified task-launch tool name. */
export function isNativeHookTaskLaunchTool(value: unknown): boolean {
  return typeof value === "string"
    && (NATIVE_HOOK_TASK_LAUNCH_TOOLS as readonly string[]).includes(value);
}

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
 * One identified member of a validated Stop/SubagentStop `background_tasks`
 * snapshot: the provider's own opaque task id plus the closed count kind. It
 * carries no description, command, prompt, tool argument, result, or timestamp.
 */
export interface NativeHookBackgroundMember {
  readonly id: string;
  readonly kind: NativeHookBackgroundKind;
}

/**
 * One positively observed background launch: the id the provider itself
 * returned from a successful tool result, plus its closed count kind. Absence
 * is unknown, never zero; presence is never inferred from a `PreToolUse`
 * backgrounding intent or from a foreground agent run.
 */
export interface NativeHookBackgroundStarted {
  readonly id: string;
  readonly kind: NativeHookBackgroundKind;
}

export type NativeHookBackgroundKind = (typeof NATIVE_HOOK_BACKGROUND_KINDS)[number];

/**
 * Selected provider hook metadata using the provider's original field names.
 * Every field except `hook_event_name` is optional; absence is unknown and is
 * never filled in with a guessed value. The `background_*` fields are the only
 * derived ones: the relay validates the whole native Stop/SubagentStop
 * `background_tasks` array once and projects closed counts plus, when every
 * active entry was identifiable, its membership form; a `PostToolUse` whose own
 * result actually launched background work projects one launch id and kind.
 * They are absent when the provider omitted the snapshot or launched nothing,
 * and are never reconstructed from other event edges.
 */
export interface NativeHookEventMetadata {
  hook_event_name: NativeHookEventName;
  session_id?: string;
  transcript_path?: string;
  /**
   * The named transcript of the CHILD whose turn a `SubagentStop` closed, selected
   * ONLY from that event and only when it validates as a bounded absolute path.
   * It is a bound path, nothing more: this projection never derives one from a
   * filename pattern, never searches for it, and never treats a path it was not
   * given as evidence of anything. Consumers treat an unreadable or replaced child
   * transcript as a coverage hole in the one agent it names, never as an end.
   */
  agent_transcript_path?: string;
  /**
   * The provider's own working directory for a `SessionStart`, selected ONLY from
   * that event and only when it validates as a bounded absolute path. It is
   * root-context proof material for an exact workspace comparison, nothing more:
   * it is never selected from another event, never derived from any other path,
   * and an absent value proves nothing. It is Claude-only on the callback side.
   */
  cwd?: string;
  agent_id?: string;
  /**
   * Descriptive provider label only: `agent_id`, never this label, defines
   * root/child scope. Claude's SubagentStop producer may emit `''`
   * (`contextType ?? mainAgentType ?? ''`), which selection normalizes to
   * absence before framing; it is neither identity nor liveness evidence.
   */
  agent_type?: string;
  prompt_id?: string;
  turn_id?: string;
  source?: string;
  reason?: string;
  tool_name?: string;
  tool_use_id?: string;
  /** Present only for a validated Stop/SubagentStop snapshot; [] means real 0/0. */
  background_counts?: NativeHookBackgroundCounts;
  /**
   * Membership form of the same validated Stop/SubagentStop snapshot, present
   * only when every active entry carried an identifiable opaque id. `[]` means
   * the provider positively reported an empty in-flight set. A SubagentStop
   * array is that hook's own whole array, never a claim of root scope.
   */
  background_members?: readonly NativeHookBackgroundMember[];
  /**
   * The closed count kinds the same validated snapshot held an active member of
   * WITHOUT a usable id. Present only when `background_members` is absent
   * because of such an entry, and never beside it: it names which categories
   * this projection could not key, so a consumer can withdraw exactly those and
   * keep the rest of its own census. It is never a count, an id, or a provider
   * label, and it never contradicts `background_counts`, which stay exact.
   */
  background_unidentified_kinds?: readonly NativeHookBackgroundKind[];
  /** Present only for a `PostToolUse` whose actual result launched background work. */
  background_started?: NativeHookBackgroundStarted;
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

/**
 * #682: optional relay-to-broker attachment carrying the native Claude inbox
 * announcement the relay selected from its own hook ENVIRONMENT (never stdin)
 * for a Claude root `SessionStart`. The session id is deliberately not
 * repeated: the broker binds the attachment to the same frame's own
 * `session_id`. It is never part of {@link NativeHookEvent} or the rebuilt
 * frame: the decoder keeps a well-formed attachment in a module-private
 * WeakMap keyed by the decoded result, so no serialization, inspection, or
 * property walk of decoded values can reveal it. Only the broker reads it,
 * through {@link readNativeHookClaudeInboxAttachment}, after authentication,
 * and immediately rebuilds the announcement helper's opaque candidate.
 */
export interface NativeHookClaudeInboxAttachment {
  readonly socket_path: string;
  readonly hook_token: string;
}

/**
 * Event wire frame with the optional inbox attachment. Only the relay builds
 * it, only for a Claude root `SessionStart` whose environment carried a valid
 * announcement, and only when the whole frame still fits the unchanged
 * {@link MAX_NATIVE_HOOK_FRAME_BYTES} bound; otherwise the relay sends the
 * ordinary frame without it.
 */
export interface NativeHookAnnouncedEventFrame extends NativeHookEventFrame {
  claude_inbox_announcement: NativeHookClaudeInboxAttachment;
}

export type NativeHookFrame = NativeHookEventFrame | NativeHookAnnouncedEventFrame | NativeHookFailureFrame;

export type DecodedNativeHookFrame =
  | {
    readonly kind: "event";
    /** Rebuilt auth/metadata frame; never carries the inbox attachment. */
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

/** Whole-array background snapshot projection: counts plus optional membership. */
export type NativeHookBackgroundSnapshotResult =
  | {
    readonly ok: true;
    readonly counts: NativeHookBackgroundCounts;
    /** Null when an active entry carried no identifiable id. Never partial. */
    readonly members: readonly NativeHookBackgroundMember[] | null;
    /**
     * The count kinds this snapshot held at least one active member of WITHOUT a
     * usable id, in first-seen order. Empty when every active member was
     * identifiable. This is the closed statement of WHICH category's membership
     * is unkeyable, so a consumer withdraws that category instead of the whole
     * census; it never carries an id, a count, or provider label text.
     */
    readonly unidentifiedKinds: readonly NativeHookBackgroundKind[];
  }
  | { readonly ok: false; readonly reason: "input-invalid" | "input-too-large" };

const METADATA_TEXT_LIMITS: Readonly<
  Record<
    Exclude<
      keyof NativeHookEventMetadata,
      "hook_event_name"
      | "background_counts"
      | "background_members"
      | "background_unidentified_kinds"
      | "background_started"
    >,
    number
  >
> = Object.freeze({
  session_id: MAX_NATIVE_HOOK_ID_BYTES,
  transcript_path: MAX_NATIVE_HOOK_PATH_BYTES,
  agent_transcript_path: MAX_NATIVE_HOOK_PATH_BYTES,
  cwd: MAX_NATIVE_HOOK_PATH_BYTES,
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
  "background_members",
  "background_unidentified_kinds",
  "background_started",
]);
const BACKGROUND_COUNT_KEYS: ReadonlySet<string> = new Set(["tasks", "shells"]);
const BACKGROUND_MEMBER_KEYS: ReadonlySet<string> = new Set(["id", "kind"]);
const BACKGROUND_STARTED_KEYS: ReadonlySet<string> = new Set(["id", "kind"]);
const CLAUDE_INBOX_ATTACHMENT_FIELD = "claude_inbox_announcement";
const CLAUDE_INBOX_ATTACHMENT_KEYS: ReadonlySet<string> = new Set(["socket_path", "hook_token"]);
const EVENT_FRAME_KEYS: ReadonlySet<string> = new Set([
  "version",
  "type",
  "instanceId",
  "generation",
  "backend",
  "token",
  "hook_event_name",
  ...METADATA_KEYS,
  CLAUDE_INBOX_ATTACHMENT_FIELD,
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

/** True only for a value from the closed background member-kind set. */
export function isNativeHookBackgroundKind(value: unknown): value is NativeHookBackgroundKind {
  return typeof value === "string" && (NATIVE_HOOK_BACKGROUND_KINDS as readonly string[]).includes(value);
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
 * Filter: status is exactly `running` or `pending`, AND `backgrounded` is not
 * `false`. The installed Claude Code 2.1.325 provider pre-filters this array
 * itself: `$Qn(taskRegistry.all())` (~292635600) emits
 * `{id, type, status, description}` entries selected by `ES` (~283507589),
 * which admits only `status ∈ {running, pending}` and never
 * `isBackgrounded === false`, and the published entry schema `aC` (~280531508)
 * has no `backgrounded` member at all. So an absent `backgrounded` is the
 * provider's normal shape, not missing data; an explicit `false` still excludes
 * the entry, which is what keeps foreground work out of the counts.
 *
 * Classification for kept entries: `type === "shell"` is a shell; every other
 * nonempty native type label is a task. The provider's label map `JIo`
 * (~283506226) yields `"shell"` only for `local_bash`, so agents, monitors,
 * workflows, teammates, and cloud sessions land in `tasks`. Extra provider
 * fields (descriptions, commands, output, crons) are intentionally ignored.
 *
 * Membership is the same validated pass: every kept entry that the provider
 * identified becomes `{id, kind}`. If any kept entry carries no id the
 * projection is `null` rather than a shortened set, and a present-but-malformed
 * or duplicated id anywhere in the array fails the whole snapshot. A `null`
 * membership says which kinds it could not key: `unidentifiedKinds` names the
 * closed categories of the kept entries that had no usable id, so the consumer
 * can withdraw exactly those categories of its own census and keep the rest.
 */
export function deriveNativeHookBackgroundSnapshot(value: unknown): NativeHookBackgroundSnapshotResult {
  if (!Array.isArray(value)) return { ok: false, reason: "input-invalid" };
  if (value.length > MAX_NATIVE_HOOK_BACKGROUND_TASKS) return { ok: false, reason: "input-too-large" };
  let tasks = 0;
  let shells = 0;
  const members: NativeHookBackgroundMember[] = [];
  const unidentifiedKinds: NativeHookBackgroundKind[] = [];
  const seenIds = new Set<string>();
  let memberIds = true;
  let idBytes = 0;
  for (const entry of value) {
    if (!isRecord(entry)) return { ok: false, reason: "input-invalid" };
    const status = entry.status;
    if (!isBoundedText(status, MAX_NATIVE_HOOK_TASK_STATUS_BYTES)) {
      return typeof status === "string" && Buffer.byteLength(status, "utf8") > MAX_NATIVE_HOOK_TASK_STATUS_BYTES
        ? { ok: false, reason: "input-too-large" }
        : { ok: false, reason: "input-invalid" };
    }
    const backgrounded = entry.backgrounded;
    if (backgrounded !== undefined && typeof backgrounded !== "boolean") {
      return { ok: false, reason: "input-invalid" };
    }
    const type = entry.type;
    if (!isBoundedText(type, MAX_NATIVE_HOOK_LABEL_BYTES)) {
      return typeof type === "string" && Buffer.byteLength(type, "utf8") > MAX_NATIVE_HOOK_LABEL_BYTES
        ? { ok: false, reason: "input-too-large" }
        : { ok: false, reason: "input-invalid" };
    }
    const id = entry.id;
    if (id !== undefined && !isBoundedText(id, MAX_NATIVE_HOOK_MEMBER_ID_BYTES)) {
      return { ok: false, reason: "input-invalid" };
    }
    if (typeof id === "string") {
      if (seenIds.has(id)) return { ok: false, reason: "input-invalid" };
      seenIds.add(id);
    }
    if ((status === "running" || status === "pending") && backgrounded !== false) {
      const kind: NativeHookBackgroundKind = type === "shell" ? "shell" : "task";
      if (kind === "shell") shells += 1;
      else tasks += 1;
      if (typeof id === "string") {
        idBytes += Buffer.byteLength(id, "utf8");
        if (idBytes > MAX_NATIVE_HOOK_MEMBERS_ID_BYTES) return { ok: false, reason: "input-too-large" };
        members.push({ id, kind });
      } else {
        memberIds = false;
        if (!unidentifiedKinds.includes(kind)) unidentifiedKinds.push(kind);
      }
    }
  }
  return {
    ok: true,
    counts: { tasks, shells },
    members: memberIds ? members : null,
    unidentifiedKinds,
  };
}

/**
 * Counts-only form of {@link deriveNativeHookBackgroundSnapshot}; the closed
 * counts semantics are identical because both come from the same single pass.
 */
export function deriveNativeHookBackgroundCounts(value: unknown): NativeHookBackgroundCountsResult {
  const derived = deriveNativeHookBackgroundSnapshot(value);
  return derived.ok ? { ok: true, counts: derived.counts } : derived;
}

/**
 * Selects the closed positive-launch projection from one already-parsed
 * provider value. Only the verified tool for that kind, on an actual
 * successful result of its own, can produce one:
 * - `tool_name === "Bash"` with a result carrying `backgroundTaskId` is a
 *   `shell`;
 * - `tool_name` in `{"Task","Agent"}` with a result whose own `status` is
 *   exactly `"async_launched"` and which carries `agentId` is a `task`.
 * An unrelated tool that happens to carry either field is not lifecycle
 * evidence and selects nothing, and a tool whose result belongs to the other
 * kind is not accepted either.
 * Both ids are the provider's task-registry keys, the same namespace the root
 * `Stop` snapshot reports as `background_tasks[].id`, so a launch id and a
 * later member id are directly comparable. A `PreToolUse` `run_in_background`
 * intent, a foreground agent, a failed tool, or an unusable id selects nothing:
 * absence is unknown, never zero and never a guessed member.
 */
function selectNativeHookBackgroundStarted(value: Record<string, unknown>): NativeHookBackgroundStarted | undefined {
  const toolName = value.tool_name;
  if (typeof toolName !== "string") return undefined;
  const response = value.tool_response;
  if (!isRecord(response)) return undefined;
  if (isNativeHookShellLaunchTool(toolName)) {
    const taskId = response.backgroundTaskId;
    return typeof taskId === "string" && isBoundedText(taskId, MAX_NATIVE_HOOK_MEMBER_ID_BYTES)
      ? { id: taskId, kind: "shell" }
      : undefined;
  }
  if (isNativeHookTaskLaunchTool(toolName)) {
    const agentId = response.agentId;
    if (response.status === "async_launched"
      && typeof agentId === "string"
      && isBoundedText(agentId, MAX_NATIVE_HOOK_MEMBER_ID_BYTES)) {
      return { id: agentId, kind: "task" };
    }
  }
  return undefined;
}

/**
 * Selects only closed metadata from one already-parsed provider stdin value.
 * Unknown provider fields are ignored (never copied); a present allowlisted
 * field that is malformed or oversized is an explicit closed failure. Selection
 * happens BEFORE any wire encoding, so sensitive provider text has no path into
 * the frame. The optional `background_counts` projection is derived only for
 * the established Stop/SubagentStop snapshot field, together with its
 * `background_members` form — or, when an active entry could not be keyed, the
 * closed `background_unidentified_kinds` categories instead of it — and
 * `background_started` is derived only from a `PostToolUse` result that actually
 * launched background work.
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
    // Claude 2.1.325's SubagentStop producer writes
    // `agent_type: contextType ?? mainAgentType ?? ''`, and the field's own
    // schema has no minimum length. The label is descriptive only, so exactly
    // the empty value is normalized to absence instead of failing the whole
    // event and discarding its identity/membership facts. A nonempty label
    // keeps the same bounded-text rule, and the strict wire decoder still
    // refuses a present-empty value because the trusted producer omits it.
    if (key === "agent_type" && field === "") continue;
    if (key === "cwd") {
      // Every provider hook carries `cwd` as a base field, but only a
      // `SessionStart` needs it: it is the one boundary whose root context the
      // host must compare against the row's selected workspace. Anywhere else it
      // is simply not selected. On a `SessionStart` an unusable value (relative,
      // oversized, control characters) proves nothing, so it is omitted rather
      // than failing the whole boundary: the scope rebind that event already
      // carried must not be lost to a field that only ever adds proof.
      if (name === "SessionStart" && isBoundedTranscriptPath(field)) metadata.cwd = field;
      continue;
    }
    if (key === "transcript_path") {
      if (!isBoundedTranscriptPath(field)) return { ok: false, reason: "input-invalid" };
    } else if (key === "agent_transcript_path") {
      // Selected only on the one event whose producer names it. Anywhere else it
      // is an unrecognised field on a trusted producer, and a path this projection
      // would have to guess at is worse than no path at all.
      if (name !== "SubagentStop" || !isBoundedTranscriptPath(field)) {
        return { ok: false, reason: "input-invalid" };
      }
    } else if (!isBoundedText(field, limit)) {
      return { ok: false, reason: "input-invalid" };
    }
    (metadata as Record<string, unknown>)[key] = field;
  }
  if (name === "Stop" || name === "SubagentStop") {
    if (Object.prototype.hasOwnProperty.call(value, "background_tasks")) {
      const derived = deriveNativeHookBackgroundSnapshot(value.background_tasks);
      if (!derived.ok) return { ok: false, reason: derived.reason };
      metadata.background_counts = derived.counts;
      if (derived.members !== null) metadata.background_members = derived.members;
      else if (derived.unidentifiedKinds.length > 0) {
        metadata.background_unidentified_kinds = derived.unidentifiedKinds;
      }
    }
  }
  if (name === "PostToolUse") {
    const started = selectNativeHookBackgroundStarted(value);
    if (started !== undefined) metadata.background_started = started;
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

/**
 * Strictly rebuilds one projected membership set from wire bytes: closed
 * `{id, kind}` objects only, bounded opaque ids, unique ids, and an aggregate
 * id byte budget. Any extra member field, duplicate id, unknown kind, or
 * oversize input refuses the whole frame.
 */
function parseNativeHookBackgroundMembers(value: unknown): readonly NativeHookBackgroundMember[] | undefined {
  if (!Array.isArray(value) || value.length > MAX_NATIVE_HOOK_BACKGROUND_TASKS) return undefined;
  const members: NativeHookBackgroundMember[] = [];
  const seen = new Set<string>();
  let idBytes = 0;
  for (const entry of value) {
    if (!isRecord(entry) || !hasOnlyKeys(entry, BACKGROUND_MEMBER_KEYS)) return undefined;
    const id = entry.id;
    const kind = entry.kind;
    if (!isBoundedText(id, MAX_NATIVE_HOOK_MEMBER_ID_BYTES)) return undefined;
    if (!isNativeHookBackgroundKind(kind)) return undefined;
    if (seen.has(id)) return undefined;
    seen.add(id);
    idBytes += Buffer.byteLength(id, "utf8");
    if (idBytes > MAX_NATIVE_HOOK_MEMBERS_ID_BYTES) return undefined;
    members.push({ id, kind });
  }
  return members;
}

/**
 * Strictly rebuilds the closed kind-gap projection from wire bytes: a nonempty
 * set of distinct closed count kinds, and nothing else. The whole frame is
 * refused for an unknown kind, a duplicate, an empty list, or a list wider than
 * the closed kind set — a gap nobody can attribute is not a smaller gap.
 */
function parseNativeHookBackgroundUnidentifiedKinds(
  value: unknown,
): readonly NativeHookBackgroundKind[] | undefined {
  if (!Array.isArray(value) || value.length === 0 || value.length > NATIVE_HOOK_BACKGROUND_KINDS.length) {
    return undefined;
  }
  const kinds: NativeHookBackgroundKind[] = [];
  for (const entry of value) {
    if (!isNativeHookBackgroundKind(entry)) return undefined;
    if (kinds.includes(entry)) return undefined;
    kinds.push(entry);
  }
  return kinds;
}

/**
 * Strictly rebuilds one projected launch id/kind pair from wire bytes, and
 * re-checks the pairing the selection is built on: a `shell` launch is only
 * credible from the shell-launch tool and a `task` launch only from a
 * task-launch tool. A frame that names no tool, or pairs a kind with the wrong
 * tool, is refused rather than trusted.
 */
function parseNativeHookBackgroundStarted(
  value: unknown,
  toolName: unknown,
): NativeHookBackgroundStarted | undefined {
  if (!isRecord(value) || !hasOnlyKeys(value, BACKGROUND_STARTED_KEYS)) return undefined;
  const id = value.id;
  const kind = value.kind;
  if (!isBoundedText(id, MAX_NATIVE_HOOK_MEMBER_ID_BYTES)) return undefined;
  if (!isNativeHookBackgroundKind(kind)) return undefined;
  if (kind === "shell" && !isNativeHookShellLaunchTool(toolName)) return undefined;
  if (kind === "task" && !isNativeHookTaskLaunchTool(toolName)) return undefined;
  return { id, kind };
}

function parseClaudeInboxAttachment(value: unknown): NativeHookClaudeInboxAttachment | undefined {
  if (!isRecord(value) || !hasOnlyKeys(value, CLAUDE_INBOX_ATTACHMENT_KEYS)) return undefined;
  const { socket_path: socketPath, hook_token: hookToken } = value;
  if (typeof socketPath !== "string" || typeof hookToken !== "string") return undefined;
  return { socket_path: socketPath, hook_token: hookToken };
}

/** Decoded results that carried a well-formed inbox attachment; never enumerable. */
const decodedClaudeInboxAttachments = new WeakMap<object, NativeHookClaudeInboxAttachment>();

/**
 * #682, broker-only: the well-formed (closed-shape-checked, NOT value-validated) inbox
 * attachment of one decoded event, or `undefined`. Call it only after the
 * decoded frame authenticated against its registration, and pass the values
 * straight to the announcement helper's own selection; nothing else may read
 * or retain them.
 */
export function readNativeHookClaudeInboxAttachment(
  decoded: DecodedNativeHookFrame,
): NativeHookClaudeInboxAttachment | undefined {
  return typeof decoded === "object" && decoded !== null ? decodedClaudeInboxAttachments.get(decoded) : undefined;
}

function parseEventFrame(value: Record<string, unknown>): NativeHookEventFrame | undefined {
  if (!hasOnlyKeys(value, EVENT_FRAME_KEYS)) return undefined;
  if (value.version !== NATIVE_HOOK_PROTOCOL_VERSION || value.type !== "native_hook_event") return undefined;
  const backend = parseBackend(value.backend);
  if (!backend) return undefined;
  if (!isValidNativeHookInstanceId(value.instanceId)) return undefined;
  if (!isValidGeneration(value.generation)) return undefined;
  if (!isValidToken(value.token)) return undefined;
  // The relay omits the provider's empty descriptive agent_type before framing,
  // so a wire frame that still carries it present-empty is not relay output.
  // Keep the strict wire shape refusing it rather than normalizing it here.
  if (value.agent_type === "") return undefined;
  // `cwd` is SessionStart-only proof material. The relay omits an unusable value
  // before framing, so a wire frame carrying one anywhere else, or carrying an
  // unusable one, is not relay output and is refused rather than normalized.
  if (Object.prototype.hasOwnProperty.call(value, "cwd")
    && (value.hook_event_name !== "SessionStart" || !isBoundedTranscriptPath(value.cwd))) {
    return undefined;
  }
  // The optional inbox attachment never decides whether the ordinary event is
  // admitted: every base field above and below keeps its strict validation, and
  // a malformed attachment is simply not stored by the decoder (no candidate).
  const selected = sanitizeNativeHookProviderInput(value);
  if (!selected.ok) return undefined;
  // The Claude restoration identity proof is the only consumer of `cwd`. The
  // relay frames whatever the shared selection produced, so a Codex frame may
  // carry it on the wire; it is dropped here so the Codex callback keeps its
  // exact pre-existing shape and no new path field rides into that projection.
  const { cwd: selectedCwd, ...selectedRest } = selected.metadata;
  const metadata: NativeHookEventMetadata = backend === "claude" || selectedCwd === undefined
    ? selected.metadata
    : selectedRest;
  let backgroundCounts: NativeHookBackgroundCounts | undefined;
  if (Object.prototype.hasOwnProperty.call(value, "background_counts")) {
    // Only the established Stop-family snapshot projection may carry counts.
    if (value.hook_event_name !== "Stop" && value.hook_event_name !== "SubagentStop") return undefined;
    backgroundCounts = parseNativeHookBackgroundCounts(value.background_counts);
    if (!backgroundCounts) return undefined;
  }
  let backgroundMembers: readonly NativeHookBackgroundMember[] | undefined;
  if (Object.prototype.hasOwnProperty.call(value, "background_members")) {
    // Membership is the same Stop-family snapshot, so it is admitted nowhere
    // else. A wire client cannot inject a membership set on an unrelated event.
    if (value.hook_event_name !== "Stop" && value.hook_event_name !== "SubagentStop") return undefined;
    // And it is Claude-only projection data: a Codex frame keeps its pre-existing
    // shape, so a new Claude-only field can never ride into that projection.
    if (backend !== "claude") return undefined;
    backgroundMembers = parseNativeHookBackgroundMembers(value.background_members);
    if (!backgroundMembers) return undefined;
    if (backgroundCounts !== undefined) {
      // Both forms of one snapshot must agree. A frame that claims 0/0 while
      // carrying members (or vice versa) is refused, not reconciled.
      let tasks = 0;
      let shells = 0;
      for (const member of backgroundMembers) {
        if (member.kind === "shell") shells += 1;
        else tasks += 1;
      }
      if (tasks !== backgroundCounts.tasks || shells !== backgroundCounts.shells) return undefined;
    }
  }
  let backgroundUnidentifiedKinds: readonly NativeHookBackgroundKind[] | undefined;
  if (Object.prototype.hasOwnProperty.call(value, "background_unidentified_kinds")) {
    // The kind gap is the same Stop-family snapshot, in its unkeyable form, and
    // it is Claude-only projection data like the membership set beside it.
    if (value.hook_event_name !== "Stop" && value.hook_event_name !== "SubagentStop") return undefined;
    if (backend !== "claude") return undefined;
    // A complete membership view and a kind gap are mutually exclusive
    // statements about one snapshot; a frame that claims both is refused.
    if (backgroundMembers !== undefined) return undefined;
    backgroundUnidentifiedKinds = parseNativeHookBackgroundUnidentifiedKinds(
      value.background_unidentified_kinds,
    );
    if (!backgroundUnidentifiedKinds) return undefined;
    if (backgroundCounts !== undefined) {
      // A gap claims an ACTIVE member of that kind the projection could not key,
      // so that kind's own count cannot be zero.
      for (const kind of backgroundUnidentifiedKinds) {
        const stated = kind === "shell" ? backgroundCounts.shells : backgroundCounts.tasks;
        if (stated < 1) return undefined;
      }
    }
  }
  let backgroundStarted: NativeHookBackgroundStarted | undefined;
  if (Object.prototype.hasOwnProperty.call(value, "background_started")) {
    // A launch edge exists only on the event that carries a real tool result,
    // and only for the backend whose result schema actually issues these ids.
    if (value.hook_event_name !== "PostToolUse" || backend !== "claude") return undefined;
    backgroundStarted = parseNativeHookBackgroundStarted(value.background_started, value.tool_name);
    if (!backgroundStarted) return undefined;
  }
  return {
    version: 1,
    type: "native_hook_event",
    instanceId: value.instanceId,
    generation: value.generation,
    backend,
    token: value.token,
    ...metadata,
    ...(backgroundCounts === undefined ? {} : { background_counts: backgroundCounts }),
    ...(backgroundMembers === undefined ? {} : { background_members: backgroundMembers }),
    ...(backgroundUnidentifiedKinds === undefined
      ? {}
      : { background_unidentified_kinds: backgroundUnidentifiedKinds }),
    ...(backgroundStarted === undefined ? {} : { background_started: backgroundStarted }),
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
    const {
      hook_event_name,
      session_id,
      transcript_path,
      agent_transcript_path,
      cwd,
      agent_id,
      agent_type,
      prompt_id,
      turn_id,
      source,
      reason,
      tool_name,
      tool_use_id,
      background_counts,
      background_members,
      background_unidentified_kinds,
      background_started,
    } = frame;
    const event: NativeHookEvent = {
      backend: frame.backend,
      hook_event_name,
      ...(session_id === undefined ? {} : { session_id }),
      ...(transcript_path === undefined ? {} : { transcript_path }),
      ...(agent_transcript_path === undefined ? {} : { agent_transcript_path }),
      ...(cwd === undefined ? {} : { cwd }),
      ...(agent_id === undefined ? {} : { agent_id }),
      ...(agent_type === undefined ? {} : { agent_type }),
      ...(prompt_id === undefined ? {} : { prompt_id }),
      ...(turn_id === undefined ? {} : { turn_id }),
      ...(source === undefined ? {} : { source }),
      ...(reason === undefined ? {} : { reason }),
      ...(tool_name === undefined ? {} : { tool_name }),
      ...(tool_use_id === undefined ? {} : { tool_use_id }),
      ...(background_counts === undefined ? {} : { background_counts }),
      ...(background_members === undefined ? {} : { background_members }),
      ...(background_unidentified_kinds === undefined ? {} : { background_unidentified_kinds }),
      ...(background_started === undefined ? {} : { background_started }),
    };
    const decoded: DecodedNativeHookFrame = { kind: "event", frame, event };
    const attachment = Object.prototype.hasOwnProperty.call(parsed, CLAUDE_INBOX_ATTACHMENT_FIELD)
      ? parseClaudeInboxAttachment(parsed[CLAUDE_INBOX_ATTACHMENT_FIELD])
      : undefined;
    if (attachment !== undefined) decodedClaudeInboxAttachments.set(decoded, Object.freeze(attachment));
    return decoded;
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
