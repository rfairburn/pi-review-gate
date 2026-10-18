/**
 * Session-host status protocol (issue #323).
 *
 * A separate session-host process spawns the Node-based Pi CLI directly with
 * a one-shot bootstrap environment variable (HOST_BOOTSTRAP_ENV) describing a
 * local stream endpoint it listens on (a POSIX Unix socket or Windows named
 * pipe). The companion reporter (reporter.ts),
 * loaded in the spawned child before the review gate extension, connects to
 * that endpoint, authenticates with a hello frame carrying the bootstrap token,
 * and then pushes bounded newline-delimited JSON status frames:
 * top-level busy/idle, pending-input presence, modal input surface, a
 * two-line generic activity summary, optional canonical native-session
 * identity/name metadata, and optional bounded owned background-work counts
 * (logical execution/review work and unconfirmed background shell jobs). The
 * host can also send narrowly scoped authenticated native rename and
 * graceful-shutdown requests and receive their observed results. A host that
 * observed the reporter's advertised `activity-census` capability can request
 * one complete freshly observed status from that exact live client; the
 * correlated reply is a full snapshot built from current readiness and owning
 * source state, not a cached aggregate. Status frames
 * still carry no tool arguments, prompts, or transcripts. A hosted child may
 * explicitly submit one bounded authenticated SessionSpawn command containing
 * its supplied workspace, title, and prompt; the host replies only with a
 * bounded launch outcome.
 *
 * Privacy contract: status frames carry no tool arguments, question text,
 * transcripts, or credentials. Owned-work counts are opaque numbers only.
 * Spawn commands intentionally carry the supplied workspace/title/prompt, but
 * the prompt is not copied into status snapshots or status/sidebar diagnostics.
 * The requested title appears through ordinary native conversation-name and
 * sidebar fields; the prompt is delivered to the new child's conversation.
 * The bootstrap token
 * appears in the hello and authenticated command frames only. Every
 * field is strictly bounded and MAX_STATUS_FRAME_BYTES caps each wire frame;
 * this module is the shared contract for both sides and performs no IO.
 */

import { isAbsolute, posix as posixPath } from "node:path";
import { isRecord } from "../record-guard";

export const HOST_BOOTSTRAP_ENV = "PI_REVIEW_GATE_SESSION_HOST_BOOTSTRAP";

/** Maximum size of a single newline-terminated wire frame, in bytes. */
export const MAX_STATUS_FRAME_BYTES = 16_384;

export const PROTOCOL_VERSION = 1;
export const MAX_ACTIVITY_LINES = 2;
export const MAX_ACTIVITY_LINE_LENGTH = 120;
/** Display metadata is clipped to this many Unicode code points. */
export const MAX_NATIVE_SESSION_NAME_LENGTH = 256;
/** Rename is never silently clipped: complete persisted input must fit this UTF-8 byte limit. */
export const MAX_RENAME_NAME_BYTES = 1024;
export const MAX_NATIVE_SESSION_ID_BYTES = 256;
/** Private native manager current-file observation bound; paths never enter presentation/roster data. */
export const MAX_NATIVE_SESSION_FILE_BYTES = 4096;
/** SessionSpawn fields have independent transport bounds; sidebar width is not a data limit. */
export const MAX_SESSION_SPAWN_WORKSPACE_BYTES = 4096;
export const MAX_SESSION_SPAWN_TITLE_BYTES = MAX_RENAME_NAME_BYTES;
export const MAX_SESSION_SPAWN_PROMPT_BYTES = 8192;

/** Complete observed inactivity; unknown or absent work/input state can never authorize an idle-only stop. */
export function hasCompleteSessionIdle(state: {
  busy: boolean | null;
  pendingInput: boolean | null;
  inputSurface: boolean;
  backgroundTasks?: number | null;
  backgroundShells?: number | null;
}): boolean {
  return state.busy === false && state.pendingInput === false && state.inputSurface === false
    && state.backgroundTasks === 0 && state.backgroundShells === 0;
}

const MAX_ID_LENGTH = 128;
const MAX_SOCKET_PATH_LENGTH = 2048;
/** Generated Windows pipe addresses have a fixed 48-character shape. */
const MAX_LOCAL_PIPE_ADDRESS_LENGTH = 48;
const LOCAL_PIPE_ADDRESS_PATTERN = /^\\\\\.\\pipe\\prg-st-[0-9a-f]{32}$/;
/** Cryptorandom hex token issued by the session host (32 random bytes). */
const TOKEN_PATTERN = /^[0-9a-f]{64}$/i;
/** UUID-like identifiers: hex digits and hyphens only, at least one hex digit. */
const ID_PATTERN = /^[0-9a-f-]*[0-9a-f][0-9a-f-]*$/i;

/** One-shot bootstrap the session host injects into the spawned CLI child's environment. */
export interface SessionHostBootstrap {
  version: 1;
  /** Canonical absolute POSIX socket path or generated local Windows named-pipe address. */
  socketPath: string;
  /** Cryptorandom hex64 authentication token; never appears in status frames. */
  token: string;
  /** Stable identity of the session-host instance (UUID-like, <=128 chars). */
  instanceId: string;
  /** Host generation marker (UUID-like, <=128 chars). */
  generation: string;
}

/** First wire frame after connecting: authenticates the reporter to the host. */
export interface SessionHostHello {
  version: 1;
  type: "hello";
  instanceId: string;
  generation: string;
  token: string;
  /**
   * Optional bounded capability advertisement. Legacy reporters omit it; a host
   * must never send an unknown request frame to a peer that did not advertise
   * support, because the old reporter treats unknown frames as a protocol
   * violation and closes the connection.
   */
  capabilities?: string[];
}

/** Capability name for the authenticated fresh activity-census request. */
export const ACTIVITY_CENSUS_CAPABILITY = "activity-census";

/**
 * Pushed status snapshot. `busy`/`pendingInput` are null when unknown:
 * observation unavailable, or (for pendingInput) not yet observed this
 * session — the widget decorator only sees future setWidget calls and never
 * fabricates an idle/clear. `activity` holds at most two sanitized lines
 * (<=120 chars each, terminal controls stripped) with generic content only:
 * a top-level tool name or "Working"/"Ready".
 */
export interface SessionHostStatus {
  version: 1;
  type: "status";
  instanceId: string;
  generation: string;
  /** Positive integer, monotonically increasing across /reload in one process. */
  sequence: number;
  busy: boolean | null;
  pendingInput: boolean | null;
  inputSurface: boolean;
  activity: string[];
  /** Omitted by older reporters or null when public native session APIs are unavailable. */
  nativeSession?: SessionHostNativeSession | null;
  /**
   * Optional bounded owned background-work counts. Absent (older reporter),
   * null, or any non-nonnegative-safe-integer value means UNKNOWN (null),
   * never zero: cleared tracking is never published as "nothing running".
   * `backgroundTasks` counts logical owned work units (active/queued
   * execution tasks plus active automatic reviews), not OS processes.
   */
  backgroundTasks?: number | null;
  /** Owned background shell jobs whose actual settlement is not yet confirmed. */
  backgroundShells?: number | null;
  /**
   * Optional bounded activity-intent counts, independent of ownership.
   * `activeTasks` counts admitted/queued or actively running/reviewing/landing
   * logical work (including accepted continuations) plus in-flight force-merge
   * operations; a stopped
   * task that retains cleanup artifacts reads zero here. Absent (older
   * reporter), null, or any invalid value means UNKNOWN (null), never zero.
   */
  activeTasks?: number | null;
  /** Started/running owned background shell work; a retained cleanup-only job reads zero. */
  activeShells?: number | null;
}

/**
 * Host request for one complete, freshly observed activity census from the
 * exact authenticated live client. The request is fenced by the registration
 * token/generation, a unique request id, the host's last accepted status
 * sequence, and (when known) the exact native session tuple. A complete reply
 * must carry a strictly newer status sequence and a snapshot rebuilt from the
 * client's actual current readiness and owning-source state.
 */
export interface SessionHostActivityRequest {
  version: 1;
  type: "activity_request";
  instanceId: string;
  generation: string;
  token: string;
  requestId: string;
  /** Last status sequence accepted by the host; a complete reply must advance it. */
  afterSequence: number;
  /** Exact expected native session tuple, or null when the host has no observation. */
  expectedSessionId: string | null;
  expectedSessionEpoch: number | null;
}

export type SessionHostActivityOutcome = "complete" | "stale-session" | "unavailable";

/**
 * Correlated response to {@link SessionHostActivityRequest}. Only a complete
 * result carries a full fresh status snapshot. Stale-session and unavailable
 * results never carry a snapshot, so a host can never replace its row with an
 * old or fabricated census.
 */
export interface SessionHostActivityResult {
  version: 1;
  type: "activity_result";
  instanceId: string;
  generation: string;
  requestId: string;
  outcome: SessionHostActivityOutcome;
  /** Fresh complete snapshot; present only with outcome "complete". */
  status?: SessionHostStatus;
  observedSessionId: string | null;
  observedSessionEpoch: number | null;
}

/** Bounded native conversation identity and canonical display title. */
export interface SessionHostNativeSession {
  sessionId: string;
  /** Positive and monotonic across session changes and reporter reloads. */
  epoch: number;
  /** Canonical stored name, otherwise the native first-user-message fallback. */
  name: string;
  /** Last actual planned-file observation; missing on older reporters means unknown. */
  persistence?: "saved" | "unsaved" | "unknown";
  /** Authenticated public SessionManager.getSessionFile() observation; private to deletion/ownership guards. */
  currentFile?: string;
}

/** Broker-to-reporter command; the capability token is never forwarded to status/UI callbacks. */
export interface SessionHostRenameRequest {
  version: 1;
  type: "rename_request";
  instanceId: string;
  generation: string;
  token: string;
  requestId: string;
  expectedSessionId: string;
  expectedSessionEpoch: number;
  /** Full persisted name; UTF-8 length <= MAX_RENAME_NAME_BYTES, never truncated. */
  name: string;
}

/** Reporter acknowledgement, bound to the request's expected session tuple. */
export interface SessionHostRenameAck {
  version: 1;
  type: "rename_result";
  instanceId: string;
  generation: string;
  requestId: string;
  expectedSessionId: string;
  expectedSessionEpoch: number;
  sessionId: string | null;
  sessionEpoch: number | null;
  outcome: "renamed" | "rejected";
  reason: "none" | "stale-session" | "unavailable" | "invalid-name" | "setter-failed" | "verification-failed";
}

/** Host request to gracefully shut down this owned process, fenced to the observed session incarnation. */
export interface SessionHostShutdownRequest {
  version: 1;
  type: "shutdown_request";
  instanceId: string;
  generation: string;
  token: string;
  requestId: string;
  expectedSessionId: string;
  expectedSessionEpoch: number;
  /** Unconfirmed row deletion must re-establish complete idleness before invoking shutdown. */
  requireIdle?: boolean;
}

/** Acknowledges a public shutdown request, never process exit. */
export interface SessionHostShutdownAck {
  version: 1;
  type: "shutdown_result";
  instanceId: string;
  generation: string;
  requestId: string;
  expectedSessionId: string;
  expectedSessionEpoch: number;
  outcome: "requested" | "rejected";
  reason: "none" | "stale-session" | "unavailable" | "shutdown-failed" | "already-requested" | "not-idle";
}

/** Explicit child request; the token is checked by the broker and never passed to host/UI callbacks. */
export interface SessionHostSpawnRequest {
  version: 1;
  type: "spawn_request";
  instanceId: string;
  generation: string;
  token: string;
  requestId: string;
  workspace: string;
  /** Complete persisted native title input; bounded only for transport safety, never clipped to sidebar width. */
  title: string;
  /** Exact initial user prompt; bounded only for transport safety. */
  prompt: string;
}

/** Host acknowledgement is about launch, never model completion or prompt processing. */
export interface SessionHostSpawnAck {
  version: 1;
  type: "spawn_result";
  instanceId: string;
  generation: string;
  requestId: string;
  outcome: "started" | "failed" | "unknown";
}

/** Non-wire input passed from the broker to the owning host registration. */
export interface SessionSpawnInput {
  workspace: string;
  title: string;
  prompt: string;
}

export type SessionSpawnOutcome = SessionHostSpawnAck["outcome"];

export type SessionHostMessage = SessionHostHello | SessionHostStatus | SessionHostRenameRequest | SessionHostRenameAck
  | SessionHostShutdownRequest | SessionHostShutdownAck | SessionHostSpawnRequest | SessionHostSpawnAck
  | SessionHostActivityRequest | SessionHostActivityResult;

function isValidId(value: unknown): value is string {
  return typeof value === "string" && value.length >= 1 && value.length <= MAX_ID_LENGTH && ID_PATTERN.test(value);
}

function isValidToken(value: unknown): value is string {
  return typeof value === "string" && TOKEN_PATTERN.test(value);
}

/** Admits only canonical absolute POSIX sockets or this host's bounded local-pipe namespace. */
function isValidSocketPath(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0 || value.includes("\0")) return false;
  if (value.length <= MAX_LOCAL_PIPE_ADDRESS_LENGTH && LOCAL_PIPE_ADDRESS_PATTERN.test(value)) return true;
  return value.length <= MAX_SOCKET_PATH_LENGTH
    && value.startsWith("/")
    && value !== "/"
    && !value.endsWith("/")
    && posixPath.normalize(value) === value;
}

function isValidActivityLine(value: unknown): value is string {
  if (typeof value !== "string") return false;
  if (Array.from(value).length > MAX_ACTIVITY_LINE_LENGTH) return false;
  // A compliant sender strips terminal controls; reject frames that carry
  // any C0, DEL, or C1 control (C1 includes CSI/OSC/ST lookalikes).
  return !/[\x00-\x1f\x7f\u0080-\u009f]/.test(value);
}

/** Native session IDs are opaque public API values, bounded, path-free, and control-free. */
export function isValidNativeSessionId(value: unknown): value is string {
  return typeof value === "string"
    && value.length > 0
    && Buffer.byteLength(value, "utf8") <= MAX_NATIVE_SESSION_ID_BYTES
    && !/[\\/]/.test(value)
    && !/[\x00-\x1f\x7f\u0080-\u009f\u2028\u2029]/.test(value);
}

/** A bounded absolute native current-file path; no filesystem/workspace admission is performed. */
export function isValidNativeSessionFile(value: unknown): value is string {
  return typeof value === "string"
    && value.length > 0
    && Buffer.byteLength(value, "utf8") <= MAX_NATIVE_SESSION_FILE_BYTES
    && isAbsolute(value)
    && !/[\x00-\x1f\x7f-\x9f\u2028\u2029]/.test(value);
}

/** Validate user-supplied persisted rename input without clipping or normalization. */
export function isValidRenameName(value: unknown): value is string {
  return typeof value === "string"
    && value.trim().length > 0
    && Buffer.byteLength(value, "utf8") <= MAX_RENAME_NAME_BYTES
    && !/[\x00-\x1f\x7f\u0080-\u009f\u2028\u2029]/.test(value);
}

function isValidDisplayName(value: unknown): value is string {
  return typeof value === "string"
    && value.trim().length > 0
    && value.trim() === value
    && Array.from(value).length <= MAX_NATIVE_SESSION_NAME_LENGTH
    && Buffer.byteLength(value, "utf8") <= MAX_NATIVE_SESSION_NAME_LENGTH * 4
    && !/[\x00-\x1f\x7f\u0080-\u009f\u2028\u2029]/.test(value);
}

function parseNativeSession(value: unknown): SessionHostNativeSession | undefined {
  if (!isRecord(value)
    || !isValidNativeSessionId(value.sessionId)
    || !Number.isSafeInteger(value.epoch)
    || (value.epoch as number) < 1
    || !isValidDisplayName(value.name)) return undefined;
  const currentFile = value.currentFile;
  return {
    sessionId: value.sessionId,
    epoch: value.epoch as number,
    name: value.name,
    ...(value.persistence === "saved" || value.persistence === "unsaved" || value.persistence === "unknown"
      ? { persistence: value.persistence } : {}),
    ...(isValidNativeSessionFile(currentFile) ? { currentFile } : {}),
  };
}

/**
 * Tolerant owned-count parse: only a nonnegative safe integer is a real count.
 * Absence (an older reporter), explicit null, a fraction, a negative value,
 * a numeric string, NaN/Infinity, and any other type all mean UNKNOWN (null);
 * a cleared or unavailable tracker must never be published as zero.
 */
function parseOwnedCount(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) return null;
  return value === 0 ? 0 : value; // normalize -0
}

/**
 * Validates a parsed bootstrap value. Returns undefined (never throws) when
 * any field is missing, unbounded, or malformed.
 */
export function parseBootstrap(value: unknown): SessionHostBootstrap | undefined {
  if (!isRecord(value) || value.version !== PROTOCOL_VERSION) return undefined;
  if (!isValidSocketPath(value.socketPath)) return undefined;
  if (!isValidToken(value.token)) return undefined;
  if (!isValidId(value.instanceId)) return undefined;
  if (!isValidId(value.generation)) return undefined;
  return {
    version: 1,
    socketPath: value.socketPath,
    token: value.token,
    instanceId: value.instanceId,
    generation: value.generation,
  };
}

/** Validates a parsed hello frame. Returns undefined when malformed. */
export function parseHello(value: unknown): SessionHostHello | undefined {
  if (!isRecord(value) || value.version !== PROTOCOL_VERSION || value.type !== "hello") return undefined;
  if (!isValidId(value.instanceId)) return undefined;
  if (!isValidId(value.generation)) return undefined;
  if (!isValidToken(value.token)) return undefined;
  let capabilities: string[] | undefined;
  if (Object.prototype.hasOwnProperty.call(value, "capabilities")) {
    if (!Array.isArray(value.capabilities) || value.capabilities.length > 8) return undefined;
    for (const capability of value.capabilities) {
      if (typeof capability !== "string" || capability.length === 0 || capability.length > 64
        || !/^[a-z0-9][a-z0-9-]*$/.test(capability)) return undefined;
    }
    capabilities = [...(value.capabilities as string[])];
  }
  return {
    version: 1,
    type: "hello",
    instanceId: value.instanceId,
    generation: value.generation,
    token: value.token,
    ...(capabilities === undefined ? {} : { capabilities }),
  };
}

/** Validates a parsed status frame. Returns undefined when malformed. */
export function parseStatus(value: unknown): SessionHostStatus | undefined {
  if (!isRecord(value) || value.version !== PROTOCOL_VERSION || value.type !== "status") return undefined;
  if (!isValidId(value.instanceId)) return undefined;
  if (!isValidId(value.generation)) return undefined;
  if (!Number.isSafeInteger(value.sequence) || (value.sequence as number) < 1) return undefined;
  if (value.busy !== null && typeof value.busy !== "boolean") return undefined;
  if (value.pendingInput !== null && typeof value.pendingInput !== "boolean") return undefined;
  if (typeof value.inputSurface !== "boolean") return undefined;
  if (!Array.isArray(value.activity) || value.activity.length > MAX_ACTIVITY_LINES) return undefined;
  for (const line of value.activity) {
    if (!isValidActivityLine(line)) return undefined;
  }
  let nativeSession: SessionHostNativeSession | null | undefined;
  if (Object.prototype.hasOwnProperty.call(value, "nativeSession")) {
    if (value.nativeSession === null) nativeSession = null;
    else {
      const parsed = parseNativeSession(value.nativeSession);
      if (!parsed) return undefined;
      nativeSession = parsed;
    }
  }
  let backgroundTasks: number | null | undefined;
  if (Object.prototype.hasOwnProperty.call(value, "backgroundTasks")) {
    // Present but invalid is UNKNOWN (null), never a rejection: forward
    // compatibility must not let an odd count drop an otherwise valid frame.
    backgroundTasks = parseOwnedCount(value.backgroundTasks);
  }
  let backgroundShells: number | null | undefined;
  if (Object.prototype.hasOwnProperty.call(value, "backgroundShells")) {
    backgroundShells = parseOwnedCount(value.backgroundShells);
  }
  let activeTasks: number | null | undefined;
  if (Object.prototype.hasOwnProperty.call(value, "activeTasks")) {
    activeTasks = parseOwnedCount(value.activeTasks);
  }
  let activeShells: number | null | undefined;
  if (Object.prototype.hasOwnProperty.call(value, "activeShells")) {
    activeShells = parseOwnedCount(value.activeShells);
  }
  return {
    version: 1,
    type: "status",
    instanceId: value.instanceId,
    generation: value.generation,
    sequence: value.sequence as number,
    busy: value.busy as boolean | null,
    pendingInput: value.pendingInput as boolean | null,
    inputSurface: value.inputSurface,
    activity: [...(value.activity as string[])],
    ...(backgroundTasks === undefined ? {} : { backgroundTasks }),
    ...(backgroundShells === undefined ? {} : { backgroundShells }),
    ...(activeTasks === undefined ? {} : { activeTasks }),
    ...(activeShells === undefined ? {} : { activeShells }),
    ...(nativeSession === undefined ? {} : { nativeSession }),
  };
}

/** Validates a broker-to-reporter authoritative activity-census request. */
export function parseActivityRequest(value: unknown): SessionHostActivityRequest | undefined {
  if (!isRecord(value) || value.version !== PROTOCOL_VERSION || value.type !== "activity_request") return undefined;
  if (!isValidId(value.instanceId) || !isValidId(value.generation) || !isValidToken(value.token)) return undefined;
  if (!isValidId(value.requestId)) return undefined;
  if (!Number.isSafeInteger(value.afterSequence) || (value.afterSequence as number) < 0) return undefined;
  const expectedSessionId = value.expectedSessionId;
  const expectedSessionEpoch = value.expectedSessionEpoch;
  if (expectedSessionId !== null && !isValidNativeSessionId(expectedSessionId)) return undefined;
  if (expectedSessionEpoch !== null
    && (!Number.isSafeInteger(expectedSessionEpoch) || (expectedSessionEpoch as number) < 1)) return undefined;
  if ((expectedSessionId === null) !== (expectedSessionEpoch === null)) return undefined;
  return {
    version: 1,
    type: "activity_request",
    instanceId: value.instanceId,
    generation: value.generation,
    token: value.token,
    requestId: value.requestId,
    afterSequence: value.afterSequence as number,
    expectedSessionId: expectedSessionId as string | null,
    expectedSessionEpoch: expectedSessionEpoch as number | null,
  };
}

/**
 * Validates a reporter activity-census result. A complete result must carry a
 * full status snapshot whose identity and observed native tuple agree with the
 * result envelope; non-complete results must not carry a snapshot at all.
 */
export function parseActivityResult(value: unknown): SessionHostActivityResult | undefined {
  if (!isRecord(value) || value.version !== PROTOCOL_VERSION || value.type !== "activity_result") return undefined;
  if (!isValidId(value.instanceId) || !isValidId(value.generation) || !isValidId(value.requestId)) return undefined;
  if (value.outcome !== "complete" && value.outcome !== "stale-session" && value.outcome !== "unavailable") return undefined;
  const observedSessionId = value.observedSessionId;
  const observedSessionEpoch = value.observedSessionEpoch;
  if (observedSessionId !== null && !isValidNativeSessionId(observedSessionId)) return undefined;
  if (observedSessionEpoch !== null
    && (!Number.isSafeInteger(observedSessionEpoch) || (observedSessionEpoch as number) < 1)) return undefined;
  if ((observedSessionId === null) !== (observedSessionEpoch === null)) return undefined;
  const hasStatus = Object.prototype.hasOwnProperty.call(value, "status");
  if (value.outcome !== "complete") {
    const parsed: SessionHostActivityResult = {
      version: 1,
      type: "activity_result",
      instanceId: value.instanceId,
      generation: value.generation,
      requestId: value.requestId,
      outcome: value.outcome,
      observedSessionId: observedSessionId as string | null,
      observedSessionEpoch: observedSessionEpoch as number | null,
    };
    return hasStatus ? undefined : parsed;
  }
  const status = parseStatus(value.status);
  if (!status) return undefined;
  if (status.instanceId !== value.instanceId || status.generation !== value.generation) return undefined;
  const statusSessionId = status.nativeSession?.sessionId ?? null;
  const statusSessionEpoch = status.nativeSession?.epoch ?? null;
  if (statusSessionId !== observedSessionId || statusSessionEpoch !== observedSessionEpoch) return undefined;
  return {
    version: 1,
    type: "activity_result",
    instanceId: value.instanceId,
    generation: value.generation,
    requestId: value.requestId,
    outcome: "complete",
    status,
    observedSessionId: observedSessionId as string | null,
    observedSessionEpoch: observedSessionEpoch as number | null,
  };
}

/** Validates a broker-to-reporter rename request. */
export function parseRenameRequest(value: unknown): SessionHostRenameRequest | undefined {
  if (!isRecord(value) || value.version !== PROTOCOL_VERSION || value.type !== "rename_request") return undefined;
  if (!isValidId(value.instanceId) || !isValidId(value.generation) || !isValidToken(value.token)) return undefined;
  if (!isValidId(value.requestId) || !isValidNativeSessionId(value.expectedSessionId)) return undefined;
  if (!Number.isSafeInteger(value.expectedSessionEpoch) || (value.expectedSessionEpoch as number) < 1) return undefined;
  if (!isValidRenameName(value.name)) return undefined;
  return {
    version: 1,
    type: "rename_request",
    instanceId: value.instanceId,
    generation: value.generation,
    token: value.token,
    requestId: value.requestId,
    expectedSessionId: value.expectedSessionId,
    expectedSessionEpoch: value.expectedSessionEpoch as number,
    name: value.name,
  };
}

/** Validates a reporter acknowledgement without accepting mismatched tuple fields. */
export function parseRenameAck(value: unknown): SessionHostRenameAck | undefined {
  if (!isRecord(value) || value.version !== PROTOCOL_VERSION || value.type !== "rename_result") return undefined;
  if (!isValidId(value.instanceId) || !isValidId(value.generation) || !isValidId(value.requestId)) return undefined;
  if (!isValidNativeSessionId(value.expectedSessionId)
    || !Number.isSafeInteger(value.expectedSessionEpoch)
    || (value.expectedSessionEpoch as number) < 1) return undefined;
  const sessionId = value.sessionId === null ? null : isValidNativeSessionId(value.sessionId) ? value.sessionId : undefined;
  const sessionEpoch = value.sessionEpoch === null
    ? null
    : Number.isSafeInteger(value.sessionEpoch) && (value.sessionEpoch as number) >= 1
      ? value.sessionEpoch as number
      : undefined;
  if (sessionId === undefined || sessionEpoch === undefined || ((sessionId === null) !== (sessionEpoch === null))) return undefined;
  if (value.outcome !== "renamed" && value.outcome !== "rejected") return undefined;
  const reasons = ["none", "stale-session", "unavailable", "invalid-name", "setter-failed", "verification-failed"];
  if (!reasons.includes(value.reason as string)) return undefined;
  if (value.outcome === "renamed") {
    if (value.reason !== "none" || sessionId !== value.expectedSessionId || sessionEpoch !== value.expectedSessionEpoch) return undefined;
  } else if (value.reason === "none") return undefined;
  return {
    version: 1,
    type: "rename_result",
    instanceId: value.instanceId,
    generation: value.generation,
    requestId: value.requestId,
    expectedSessionId: value.expectedSessionId,
    expectedSessionEpoch: value.expectedSessionEpoch as number,
    sessionId,
    sessionEpoch,
    outcome: value.outcome,
    reason: value.reason as SessionHostRenameAck["reason"],
  };
}

/** Validates a broker-to-reporter graceful-shutdown request. */
export function parseShutdownRequest(value: unknown): SessionHostShutdownRequest | undefined {
  if (!isRecord(value) || value.version !== PROTOCOL_VERSION || value.type !== "shutdown_request") return undefined;
  if (value.requireIdle !== undefined && typeof value.requireIdle !== "boolean") return undefined;
  if (!isValidId(value.instanceId) || !isValidId(value.generation) || !isValidToken(value.token)) return undefined;
  if (!isValidId(value.requestId) || !isValidNativeSessionId(value.expectedSessionId)) return undefined;
  if (!Number.isSafeInteger(value.expectedSessionEpoch) || (value.expectedSessionEpoch as number) < 1) return undefined;
  return {
    version: 1,
    type: "shutdown_request",
    instanceId: value.instanceId,
    generation: value.generation,
    token: value.token,
    requestId: value.requestId,
    expectedSessionId: value.expectedSessionId,
    expectedSessionEpoch: value.expectedSessionEpoch as number,
    ...(value.requireIdle === undefined ? {} : { requireIdle: value.requireIdle }),
  };
}

/** Validates a reporter acknowledgement; it means only that public shutdown was requested. */
export function parseShutdownAck(value: unknown): SessionHostShutdownAck | undefined {
  if (!isRecord(value) || value.version !== PROTOCOL_VERSION || value.type !== "shutdown_result") return undefined;
  if (!isValidId(value.instanceId) || !isValidId(value.generation) || !isValidId(value.requestId)) return undefined;
  if (!isValidNativeSessionId(value.expectedSessionId)
    || !Number.isSafeInteger(value.expectedSessionEpoch)
    || (value.expectedSessionEpoch as number) < 1) return undefined;
  if (value.outcome !== "requested" && value.outcome !== "rejected") return undefined;
  const reasons = ["none", "stale-session", "unavailable", "shutdown-failed", "already-requested", "not-idle"];
  if (!reasons.includes(value.reason as string)) return undefined;
  if ((value.outcome === "requested") !== (value.reason === "none")) return undefined;
  return {
    version: 1,
    type: "shutdown_result",
    instanceId: value.instanceId,
    generation: value.generation,
    requestId: value.requestId,
    expectedSessionId: value.expectedSessionId,
    expectedSessionEpoch: value.expectedSessionEpoch as number,
    outcome: value.outcome,
    reason: value.reason as SessionHostShutdownAck["reason"],
  };
}

/** Validates a bounded host-mediated fresh-session request without normalizing any supplied data. */
export function parseSpawnRequest(value: unknown): SessionHostSpawnRequest | undefined {
  if (!isRecord(value) || value.version !== PROTOCOL_VERSION || value.type !== "spawn_request") return undefined;
  if (!isValidId(value.instanceId) || !isValidId(value.generation) || !isValidToken(value.token)
    || !isValidId(value.requestId)) return undefined;
  if (typeof value.workspace !== "string" || value.workspace.length === 0
    || Buffer.byteLength(value.workspace, "utf8") > MAX_SESSION_SPAWN_WORKSPACE_BYTES
    || value.workspace.includes("\0")) return undefined;
  if (!isValidRenameName(value.title)
    || Buffer.byteLength(value.title, "utf8") > MAX_SESSION_SPAWN_TITLE_BYTES) return undefined;
  if (typeof value.prompt !== "string" || value.prompt.length === 0
    || Buffer.byteLength(value.prompt, "utf8") > MAX_SESSION_SPAWN_PROMPT_BYTES
    || value.prompt.includes("\0")) return undefined;
  const parsed: SessionHostSpawnRequest = {
    version: 1,
    type: "spawn_request",
    instanceId: value.instanceId,
    generation: value.generation,
    token: value.token,
    requestId: value.requestId,
    workspace: value.workspace,
    title: value.title,
    prompt: value.prompt,
  };
  // Individual fields are independently bounded, but JSON escaping (for
  // example a prompt made of control characters) can expand them together.
  // Reject any request that cannot fit the shared raw-frame limit before the
  // reporter attempts a write or the broker receives user data.
  if (Buffer.byteLength(`${JSON.stringify(parsed)}\n`, "utf8") > MAX_STATUS_FRAME_BYTES) return undefined;
  return parsed;
}

/** Validates a correlated host launch acknowledgement; it never carries user data or credentials. */
export function parseSpawnAck(value: unknown): SessionHostSpawnAck | undefined {
  if (!isRecord(value) || value.version !== PROTOCOL_VERSION || value.type !== "spawn_result") return undefined;
  if (!isValidId(value.instanceId) || !isValidId(value.generation) || !isValidId(value.requestId)) return undefined;
  if (value.outcome !== "started" && value.outcome !== "failed" && value.outcome !== "unknown") return undefined;
  return {
    version: 1,
    type: "spawn_result",
    instanceId: value.instanceId,
    generation: value.generation,
    requestId: value.requestId,
    outcome: value.outcome,
  };
}

/**
 * Validates a raw wire line (with or without the trailing newline): bounded
 * size, JSON syntax, and message shape. Returns undefined when malformed.
 */
export function decodeFrame(line: string): SessionHostMessage | undefined {
  if (typeof line !== "string") return undefined;
  const body = line.endsWith("\n") ? line.slice(0, -1) : line;
  if (Buffer.byteLength(body + "\n", "utf8") > MAX_STATUS_FRAME_BYTES) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return undefined;
  }
  if (!isRecord(parsed)) return undefined;
  switch (parsed.type) {
    case "hello": return parseHello(parsed);
    case "status": return parseStatus(parsed);
    case "rename_request": return parseRenameRequest(parsed);
    case "rename_result": return parseRenameAck(parsed);
    case "shutdown_request": return parseShutdownRequest(parsed);
    case "shutdown_result": return parseShutdownAck(parsed);
    case "spawn_request": return parseSpawnRequest(parsed);
    case "spawn_result": return parseSpawnAck(parsed);
    case "activity_request": return parseActivityRequest(parsed);
    case "activity_result": return parseActivityResult(parsed);
    default: return undefined;
  }
}

/**
 * Encodes a message as a newline-terminated wire frame. Throws RangeError if
 * the frame would exceed MAX_STATUS_FRAME_BYTES (impossible with compliant
 * bounded fields; callers treat it as a drop).
 */
export function encodeFrame(message: SessionHostMessage): string {
  const frame = `${JSON.stringify(message)}\n`;
  if (Buffer.byteLength(frame, "utf8") > MAX_STATUS_FRAME_BYTES) {
    throw new RangeError(`session-host frame exceeds ${MAX_STATUS_FRAME_BYTES} bytes`);
  }
  return frame;
}

/**
 * Removes terminal control sequences (OSC, CSI, Fe/Fn) and all C0/DEL
 * controls from a string. Used to sanitize activity lines before they enter
 * a status frame.
 */
export function stripTerminalControls(text: string): string {
  return text
    .replace(/\x1b\][^\x1b\x07]*(?:\x07|\x1b\\)?/g, "") // OSC (BEL or ST terminated)
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "") // CSI
    .replace(/\x1b[@-Z\\-_]/g, "") // Fe/Fn single-character escapes
    .replace(/\x1b/g, "") // any remaining bare ESC
    .replace(/[\x00-\x1f\x7f\u0080-\u009f]/g, ""); // remaining C0, DEL, and C1 controls
}

/**
 * Sanitizes one activity line: strips terminal controls and truncates to
 * MAX_ACTIVITY_LINE_LENGTH characters (code points).
 */
export function sanitizeActivityLine(value: string): string {
  const stripped = stripTerminalControls(value);
  if (Array.from(stripped).length <= MAX_ACTIVITY_LINE_LENGTH) return stripped;
  return Array.from(stripped).slice(0, MAX_ACTIVITY_LINE_LENGTH).join("");
}
