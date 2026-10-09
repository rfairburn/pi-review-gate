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
 * (logical execution/review work and unconfirmed background shell jobs). The host can also send narrowly scoped,
 * authenticated native rename and graceful-shutdown requests and receive their
 * observed results.
 *
 * Privacy contract: status frames carry no tool arguments, question text,
 * transcripts, or credentials. Owned-work counts are opaque numbers only.
 * The canonical native conversation name is
 * the sole intentionally allowed prompt-derived title. The bootstrap token
 * appears in the hello and authenticated command frames only. Every
 * field is strictly bounded and MAX_STATUS_FRAME_BYTES caps each wire frame;
 * this module is the shared contract for both sides and performs no IO.
 */

import { posix as posixPath } from "node:path";

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
}

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

/** Bounded native conversation identity and canonical display title. */
export interface SessionHostNativeSession {
  sessionId: string;
  /** Positive and monotonic across session changes and reporter reloads. */
  epoch: number;
  /** Canonical stored name, otherwise the native first-user-message fallback. */
  name: string;
  /** Last actual planned-file observation; missing on older reporters means unknown. */
  persistence?: "saved" | "unsaved" | "unknown";
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

export type SessionHostMessage = SessionHostHello | SessionHostStatus | SessionHostRenameRequest | SessionHostRenameAck
  | SessionHostShutdownRequest | SessionHostShutdownAck;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

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
  return {
    sessionId: value.sessionId,
    epoch: value.epoch as number,
    name: value.name,
    ...(value.persistence === "saved" || value.persistence === "unsaved" || value.persistence === "unknown"
      ? { persistence: value.persistence } : {}),
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
  return {
    version: 1,
    type: "hello",
    instanceId: value.instanceId,
    generation: value.generation,
    token: value.token,
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
