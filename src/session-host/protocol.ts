/**
 * Session-host status protocol (issue #323).
 *
 * A separate session-host process spawns the Node-based Pi CLI directly with
 * a one-shot bootstrap environment variable (HOST_BOOTSTRAP_ENV) describing a
 * local stream socket it listens on. The companion reporter (reporter.ts),
 * loaded in the spawned child before the review gate extension, connects to
 * that socket, authenticates with a hello frame carrying the bootstrap token,
 * and then pushes bounded newline-delimited JSON status frames:
 * top-level busy/idle, pending-input presence, modal input surface, and a
 * two-line generic activity summary.
 *
 * Privacy contract: status frames carry no tool arguments, question text,
 * titles, transcripts, or credentials. The bootstrap token appears only in
 * the hello frame. Every field is strictly bounded and MAX_STATUS_FRAME_BYTES
 * caps each wire frame; the receiving host broker (a later phase) rejects
 * unauthenticated, stale, or oversized messages. This module is the shared
 * contract for both sides and performs no IO itself.
 */

export const HOST_BOOTSTRAP_ENV = "PI_REVIEW_GATE_SESSION_HOST_BOOTSTRAP";

/** Maximum size of a single newline-terminated wire frame, in bytes. */
export const MAX_STATUS_FRAME_BYTES = 16_384;

export const PROTOCOL_VERSION = 1;
export const MAX_ACTIVITY_LINES = 2;
export const MAX_ACTIVITY_LINE_LENGTH = 120;

const MAX_ID_LENGTH = 128;
const MAX_SOCKET_PATH_LENGTH = 2048;
/** Cryptorandom hex token issued by the session host (32 random bytes). */
const TOKEN_PATTERN = /^[0-9a-f]{64}$/i;
/** UUID-like identifiers: hex digits and hyphens only, at least one hex digit. */
const ID_PATTERN = /^[0-9a-f-]*[0-9a-f][0-9a-f-]*$/i;

/** One-shot bootstrap the session host injects into the spawned CLI child's environment. */
export interface SessionHostBootstrap {
  version: 1;
  /** Absolute POSIX local stream-socket path. */
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
}

export type SessionHostMessage = SessionHostHello | SessionHostStatus;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isValidId(value: unknown): value is string {
  return typeof value === "string" && value.length >= 1 && value.length <= MAX_ID_LENGTH && ID_PATTERN.test(value);
}

function isValidToken(value: unknown): value is string {
  return typeof value === "string" && TOKEN_PATTERN.test(value);
}

/** Absolute POSIX local stream-socket path (the only form the launch uses). */
function isValidSocketPath(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_SOCKET_PATH_LENGTH) return false;
  if (value.includes("\0")) return false;
  return value.startsWith("/");
}

function isValidActivityLine(value: unknown): value is string {
  if (typeof value !== "string") return false;
  if (Array.from(value).length > MAX_ACTIVITY_LINE_LENGTH) return false;
  // A compliant sender strips terminal controls; reject frames that carry
  // any C0, DEL, or C1 control (C1 includes CSI/OSC/ST lookalikes).
  return !/[\x00-\x1f\x7f\u0080-\u009f]/.test(value);
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
  return parsed.type === "hello" ? parseHello(parsed) : parseStatus(parsed);
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
