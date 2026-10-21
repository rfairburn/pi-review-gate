/**
 * Inert remote roster row boundary (issue #478).
 *
 * This module is a pure contract: one display-oriented projection from an
 * owner-side {@link NativeInstanceView} and one strict decoder for an
 * already-framed remote row. It performs no IO, reads no ambient configuration,
 * starts nothing, and is not imported by the extension entry point, session
 * host, sidebar, instances, or owning-host service.
 *
 * The row is deliberately narrower than `NativeInstanceView`. It carries only
 * the sidebar facts a remote client needs to "perform like local": the stable
 * row id, display title, literal owner-side workspace path, lifecycle and
 * process/input observations, generic activity, canonical native session
 * identity (never the current-file guard), both ownership and activity-intent
 * counts, a known exit code, and display-safe error text. Private owner data
 * (agent/account directories, credentials, provider/environment records,
 * prompts, transcripts, question bodies, hidden properties, and process/output
 * bytes) is never read or copied.
 *
 * Framing, protocol version, host/run/subscription identity, permissions,
 * actions, and transport authentication belong to other modules. This file
 * claims row authority only. Unknown and absent observations stay `null`:
 * they are never coerced to zero, `false`, or idle.
 *
 * Error text is the one redaction boundary here. It is stripped of terminal
 * control sequences, locally redacted for recognizable credentials, passed
 * through the shared `redactSensitiveText` helper (whose global behavior is
 * unchanged), then bounded. Unsafe multiline, unterminated-control,
 * private-key, or overlarge diagnostics fall back to a fixed useful generic
 * message. Workspace paths, activity lines, and native session-pane content are
 * not filtered or redacted by this module.
 */

import { isRecord } from "../../record-guard";
import { redactSensitiveText } from "../../redaction";
import type { InstanceLifecycle, NativeInstanceView } from "../instances";
import {
  MAX_ACTIVITY_LINE_LENGTH,
  MAX_ACTIVITY_LINES,
  MAX_NATIVE_SESSION_NAME_LENGTH,
  MAX_NATIVE_SESSION_ID_BYTES,
  MAX_SESSION_SPAWN_WORKSPACE_BYTES,
  isValidNativeSessionId,
} from "../protocol";

/**
 * Display labels follow the canonical native title bound: production rows take
 * `label` from `nativeSession.name`, not the smaller legacy explicit label.
 */
export const MAX_REMOTE_LABEL_CHARS = MAX_NATIVE_SESSION_NAME_LENGTH;
export const MAX_REMOTE_LABEL_BYTES = MAX_NATIVE_SESSION_NAME_LENGTH * 4;
/** Stable row ids are opaque and bounded; they are data, never a path. */
export const MAX_REMOTE_ROW_ID_BYTES = 256;
/** Exact owner-side workspace path bytes; oversized paths are unrepresentable. */
export const MAX_REMOTE_WORKSPACE_BYTES = MAX_SESSION_SPAWN_WORKSPACE_BYTES;
/** Generic activity follows the local status bound. */
export const MAX_REMOTE_ACTIVITY_LINES = MAX_ACTIVITY_LINES;
export const MAX_REMOTE_ACTIVITY_LINE_CHARS = MAX_ACTIVITY_LINE_LENGTH;
/** Canonical native display names follow the local protocol bound. */
export const MAX_REMOTE_NATIVE_NAME_CHARS = MAX_NATIVE_SESSION_NAME_LENGTH;
export const MAX_REMOTE_NATIVE_NAME_BYTES = MAX_NATIVE_SESSION_NAME_LENGTH * 4;
/** Raw error diagnostics larger than this are not inspected for display. */
export const MAX_REMOTE_ERROR_INPUT_BYTES = 4096;
/** Final display-safe error text bound (code points and UTF-8 bytes). */
export const MAX_REMOTE_ERROR_CHARS = 320;
export const MAX_REMOTE_ERROR_BYTES = 1024;
/** Fixed useful message used whenever diagnostic detail cannot be shown safely. */
export const REMOTE_ERROR_FALLBACK_TEXT = "Remote session failed; error details are unavailable";

/** Canonical native conversation identity that may cross the roster boundary. */
export interface RemoteNativeSession {
  readonly sessionId: string;
  /** Positive and monotonic across session changes and reporter reloads. */
  readonly epoch: number;
  /** Canonical stored name, otherwise the native first-message fallback. */
  readonly name: string;
  readonly persistence?: "saved" | "unsaved" | "unknown";
}

/**
 * Display-only roster row for one remote session. Field names match the local
 * `NativeInstanceView`/`SidebarItem` facts so a remote item can feed the same
 * renderer, minus the excluded private `agentDir`.
 */
export interface RemoteSessionMetadata {
  readonly id: string;
  readonly label: string;
  /** Exact owner-side workspace path; never resolved, rewritten, or redacted. */
  readonly workspace: string;
  readonly lifecycle: InstanceLifecycle;
  /** True only while the owner still owns a live native process handle. */
  readonly hasLiveProcess: boolean;
  /** `null` means unknown; never rendered as `false` or idle. */
  readonly busy: boolean | null;
  readonly pendingInput: boolean | null;
  readonly inputSurface: boolean;
  /** Generic top-level activity lines, unchanged from the owner observation. */
  readonly activity: readonly string[];
  readonly nativeSession: RemoteNativeSession | null;
  /** Observed OWNERSHIP counts; `null` means unknown, never zero. */
  readonly backgroundTasks: number | null;
  readonly backgroundShells: number | null;
  /** Observed ACTIVITY-INTENT counts; independent of the ownership pair. */
  readonly activeTasks: number | null;
  readonly activeShells: number | null;
  /** Present only when the owner observed a finite exit code. */
  readonly exitCode?: number;
  /** Bounded, terminal-safe, redacted diagnostic text; absent when none. */
  readonly error?: string;
}

export type RemoteSessionMetadataErrorCode = "ROSTER_ROW_INVALID" | "ROSTER_ROW_TOO_LARGE";

const REMOTE_SESSION_METADATA_ERROR_MESSAGES: Record<RemoteSessionMetadataErrorCode, string> = {
  ROSTER_ROW_INVALID: "remote session metadata row is invalid",
  ROSTER_ROW_TOO_LARGE: "remote session metadata row exceeds a bounded field limit",
};

/**
 * Fixed-code failure for an owner row this boundary cannot represent. The
 * message never contains field values, raw diagnostics, or a stack.
 */
export class RemoteSessionMetadataError extends Error {
  readonly code: RemoteSessionMetadataErrorCode;

  constructor(code: RemoteSessionMetadataErrorCode) {
    super(REMOTE_SESSION_METADATA_ERROR_MESSAGES[code]);
    this.name = "RemoteSessionMetadataError";
    this.code = code;
  }
}

export function isRemoteSessionMetadataError(value: unknown): value is RemoteSessionMetadataError {
  return value instanceof RemoteSessionMetadataError;
}

function invalidRow(): never {
  throw new RemoteSessionMetadataError("ROSTER_ROW_INVALID");
}

function oversizedRow(): never {
  throw new RemoteSessionMetadataError("ROSTER_ROW_TOO_LARGE");
}

function codePointCount(value: string): number {
  return Array.from(value).length;
}

// C0/C1/DEL plus Unicode line/paragraph separators are not representable in
// one display cell or in a bounded identity, label, or activity line.
const UNSAFE_TEXT_RE = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;
const LINE_BREAK_RE = /[\n\r\u000b\u000c\u0085\u2028\u2029]/;
const LIFECYCLES: ReadonlySet<string> = new Set(["starting", "alive", "exited", "error"]);

function requiredText(value: unknown, maxBytes: number, maxChars?: number): string {
  if (typeof value !== "string" || value.length === 0) invalidRow();
  if (maxChars !== undefined && codePointCount(value) > maxChars) oversizedRow();
  if (Buffer.byteLength(value, "utf8") > maxBytes) oversizedRow();
  if (UNSAFE_TEXT_RE.test(value)) invalidRow();
  return value;
}

/**
 * Workspace paths are exact owner-side data. This boundary bounds their size
 * but never resolves, normalizes, rewrites, filters, or redacts them; rendering
 * sanitizes its own cell text. A path that cannot fit the row bound is refused
 * rather than truncated into a different target.
 */
function requiredExactText(value: unknown, maxBytes: number): string {
  if (typeof value !== "string" || value.length === 0) invalidRow();
  if (Buffer.byteLength(value, "utf8") > maxBytes) oversizedRow();
  return value;
}

/** Decoder rows and nested identities accept only plain or null-prototype records. */
function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!isRecord(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/** Reads only own data properties, so inherited observations are never facts. */
function ownField(record: Record<string, unknown>, key: string): unknown {
  return Object.prototype.hasOwnProperty.call(record, key) ? record[key] : undefined;
}

function readLifecycle(value: unknown): InstanceLifecycle {
  if (typeof value !== "string" || !LIFECYCLES.has(value)) invalidRow();
  return value as InstanceLifecycle;
}

function readBoolean(value: unknown): boolean {
  if (typeof value !== "boolean") invalidRow();
  return value;
}

/** Observed boolean or unknown; absent and `null` are both unknown. */
function readObservation(value: unknown): boolean | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "boolean") invalidRow();
  return value;
}

/** Nonnegative safe integer or unknown; a cleared tracker is never zero. */
function readCount(value: unknown): number | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) invalidRow();
  return value === 0 ? 0 : value; // normalize -0
}

function readExitCode(value: unknown): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value)) invalidRow();
  return value;
}

function readActivity(value: unknown): readonly string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) invalidRow();
  if (value.length > MAX_REMOTE_ACTIVITY_LINES) oversizedRow();
  return value.map((line) => {
    if (typeof line !== "string") invalidRow();
    if (codePointCount(line) > MAX_REMOTE_ACTIVITY_LINE_CHARS) oversizedRow();
    if (UNSAFE_TEXT_RE.test(line)) invalidRow();
    return line;
  });
}

/** Native current-file authority (and any other private key) never crosses. */
const NATIVE_SESSION_KEYS: ReadonlySet<string> = new Set(["sessionId", "epoch", "name", "persistence"]);

function readNativeSession(value: unknown, rejectUnknownKeys: boolean): RemoteNativeSession | null {
  if (value === undefined || value === null) return null;
  if (!isRecord(value)) invalidRow();
  if (rejectUnknownKeys && !isPlainRecord(value)) invalidRow();
  const record = value as Record<string, unknown>;
  if (rejectUnknownKeys && Object.keys(record).some((key) => !NATIVE_SESSION_KEYS.has(key))) invalidRow();
  const sessionId = ownField(record, "sessionId");
  if (typeof sessionId !== "string"
    || !isValidNativeSessionId(sessionId)) {
    if (typeof sessionId === "string" && Buffer.byteLength(sessionId, "utf8") > MAX_NATIVE_SESSION_ID_BYTES) {
      oversizedRow();
    }
    invalidRow();
  }
  const epoch = ownField(record, "epoch");
  if (typeof epoch !== "number" || !Number.isSafeInteger(epoch) || epoch < 1) invalidRow();
  const name = ownField(record, "name");
  if (typeof name !== "string" || name.length === 0 || name.trim() !== name) invalidRow();
  if (codePointCount(name) > MAX_REMOTE_NATIVE_NAME_CHARS
    || Buffer.byteLength(name, "utf8") > MAX_REMOTE_NATIVE_NAME_BYTES) oversizedRow();
  if (UNSAFE_TEXT_RE.test(name)) invalidRow();
  const persistence = ownField(record, "persistence");
  if (persistence !== undefined
    && persistence !== "saved" && persistence !== "unsaved" && persistence !== "unknown") invalidRow();
  return {
    sessionId,
    epoch,
    name,
    ...(persistence === undefined ? {} : { persistence }),
  };
}

// One ESC/C1 control sequence consumer. Each returns the index just past the
// sequence, or -1 when the input ends inside an unterminated sequence.
function consumeCsi(raw: string, start: number): number {
  let end = start;
  while (end < raw.length) {
    const code = raw.charCodeAt(end);
    end += 1;
    if (code >= 0x40 && code <= 0x7e) return end;
  }
  return -1;
}

function consumeControlString(raw: string, start: number): number {
  let end = start;
  while (end < raw.length) {
    const code = raw.charCodeAt(end);
    if (code === 0x07 || code === 0x9c) return end + 1;
    if (code === 0x1b && raw.charCodeAt(end + 1) === 0x5c) return end + 2;
    end += 1;
  }
  return -1;
}

function consumeEscapeFunction(raw: string, start: number): number {
  let end = start;
  while (end < raw.length) {
    const code = raw.charCodeAt(end);
    if (code >= 0x20 && code <= 0x2f) {
      end += 1;
      continue;
    }
    if (code >= 0x30 && code <= 0x7e) return end + 1;
    return -1;
  }
  return -1;
}

/**
 * Removes terminal control sequences and non-display controls. Joining the
 * remaining fragments before redaction prevents an injected control from
 * hiding a recognizable credential pattern. Tab-bearing diagnostics are
 * rejected before stripping (a space would expose value fragments, while
 * joining could hide a scheme-prefixed credential); line breaks are rejected
 * earlier so fragments cannot be joined across lines. `unterminated` fails
 * closed instead of discarding a suspicious remainder.
 */
function stripTerminalControls(raw: string): { text: string; unterminated: boolean } {
  let text = "";
  let index = 0;
  let unterminated = false;
  while (index < raw.length) {
    const code = raw.charCodeAt(index);
    const next = raw[index + 1];
    if (code === 0x1b) {
      let end: number;
      if (next === "[") {
        end = consumeCsi(raw, index + 2);
      } else if (next === "]" || next === "P" || next === "_" || next === "^" || next === "X") {
        end = consumeControlString(raw, index + 2);
      } else {
        end = consumeEscapeFunction(raw, index + 1);
      }
      if (end < 0) {
        unterminated = true;
        break;
      }
      index = end;
      continue;
    }
    if (code === 0x9b) {
      const end = consumeCsi(raw, index + 1);
      if (end < 0) {
        unterminated = true;
        break;
      }
      index = end;
      continue;
    }
    if (code === 0x90 || code === 0x98 || code === 0x9d || code === 0x9e || code === 0x9f) {
      const end = consumeControlString(raw, index + 1);
      if (end < 0) {
        unterminated = true;
        break;
      }
      index = end;
      continue;
    }
    if (code < 0x20 || code === 0x7f || (code >= 0x80 && code <= 0x9f)) {
      index += 1;
      continue;
    }
    const char = String.fromCodePoint(raw.codePointAt(index) ?? code);
    text += char;
    index += char.length;
  }
  return { text, unterminated };
}

const PRIVATE_KEY_FRAGMENT_RE = /-----BEGIN[\s\S]{0,96}?PRIVATE KEY-----|PRIVATE KEY-----/i;
// Match sensitive key suffixes like the shared redactor. Its value delimiters
// can leave credential tails visible; ambiguous diagnostics fail closed.
const AMBIGUOUS_SECRET_ASSIGNMENT_RE = /(?:api[_-]?key|access[_-]?token|refresh[_-]?token|session[_-]?token|auth[_-]?token|token|auth(?:orization)?|bearer|password|passwd|secret|cookie)["']?\s*[:=]\s*\S*[,"'\]}]/i;

// Local, bounded recognizers for credentials that the shared generic helper
// leaves partially visible (for example an `Authorization: Basic` value or a
// cookie header with several pairs). Global redaction behavior is unchanged.
const COOKIE_HEADER_RE = /\b(Cookie|Set-Cookie)\s*:\s*[^\n]*=[^\n]*/gi;
// Authorization values may contain comma-separated credential parameters or
// schemes this boundary does not enumerate; consume the remaining bounded
// single-line header value rather than only its first component.
const AUTHORIZATION_HEADER_RE = /\b(Authorization\s*:\s*)[^\r\n]*/gi;
const AUTH_CREDENTIAL_RE = /\b(?:Basic|Bearer)\s+[A-Za-z0-9._~+/=-]+/gi;
const URL_USERINFO_RE = /\b([a-z][a-z0-9+.-]*:\/\/)[^\s/?#@]*@/gi;

/** Redacts recognizable error-text credentials; never claimed as exhaustive. */
function redactRecognizableErrorSecrets(text: string): string {
  let redacted = text.replace(COOKIE_HEADER_RE, "$1: [REDACTED]");
  redacted = redacted.replace(AUTHORIZATION_HEADER_RE, "$1[REDACTED]");
  redacted = redacted.replace(AUTH_CREDENTIAL_RE, "[REDACTED]");
  redacted = redacted.replace(URL_USERINFO_RE, "$1[REDACTED]@");
  return redactSensitiveText(redacted);
}

/** Truncates to the error bound without emitting a partial generated marker. */
function boundErrorText(value: string): string {
  let text = "";
  let chars = 0;
  let bytes = 0;
  let truncated = false;
  for (const char of value) {
    const size = Buffer.byteLength(char, "utf8");
    if (chars >= MAX_REMOTE_ERROR_CHARS || bytes + size > MAX_REMOTE_ERROR_BYTES) {
      truncated = true;
      break;
    }
    text += char;
    chars += 1;
    bytes += size;
  }
  if (!truncated) return text;
  const markerStart = text.lastIndexOf("[");
  if (markerStart !== -1
    && text.length - markerStart < "[REDACTED]".length
    && "[REDACTED]".startsWith(text.slice(markerStart))) {
    return text.slice(0, markerStart).trimEnd();
  }
  return text;
}

/**
 * Produces bounded, display-safe error text. Redaction runs after control
 * stripping (so splitting a credential with controls cannot unmask it) and
 * before truncation (so a secret straddling the output bound is already
 * replaced). Uninspectable or unsafe detail fails closed to a fixed message.
 */
function displaySafeErrorText(raw: string): string {
  if (raw.trim().length === 0) return REMOTE_ERROR_FALLBACK_TEXT;
  if (LINE_BREAK_RE.test(raw)) return REMOTE_ERROR_FALLBACK_TEXT;
  // A tab inside a credential key or value would otherwise survive as an
  // unrecognized fragment under any whitespace normalization; fail closed.
  if (raw.includes("\t")) return REMOTE_ERROR_FALLBACK_TEXT;
  if (PRIVATE_KEY_FRAGMENT_RE.test(raw)) return REMOTE_ERROR_FALLBACK_TEXT;
  if (Buffer.byteLength(raw, "utf8") > MAX_REMOTE_ERROR_INPUT_BYTES) return REMOTE_ERROR_FALLBACK_TEXT;
  const stripped = stripTerminalControls(raw);
  if (stripped.unterminated) return REMOTE_ERROR_FALLBACK_TEXT;
  // Control stripping can reconstruct a private-key header that was split by
  // an injected control; detect it again before the shared redactor runs.
  if (PRIVATE_KEY_FRAGMENT_RE.test(stripped.text)) return REMOTE_ERROR_FALLBACK_TEXT;
  if (AMBIGUOUS_SECRET_ASSIGNMENT_RE.test(stripped.text)) return REMOTE_ERROR_FALLBACK_TEXT;
  let redacted: string;
  try {
    redacted = redactRecognizableErrorSecrets(stripped.text);
  } catch {
    return REMOTE_ERROR_FALLBACK_TEXT;
  }
  if (redacted.replace(/\[REDACTED\]/g, "").trim().length === 0) return REMOTE_ERROR_FALLBACK_TEXT;
  const bounded = boundErrorText(redacted).trim();
  return bounded.length === 0 ? REMOTE_ERROR_FALLBACK_TEXT : bounded;
}

function readError(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") invalidRow();
  return displaySafeErrorText(value);
}

const ALLOWED_ROW_KEYS: ReadonlySet<string> = new Set([
  "id",
  "label",
  "workspace",
  "lifecycle",
  "hasLiveProcess",
  "busy",
  "pendingInput",
  "inputSurface",
  "activity",
  "nativeSession",
  "backgroundTasks",
  "backgroundShells",
  "activeTasks",
  "activeShells",
  "exitCode",
  "error",
]);

const REQUIRED_ROW_KEYS: readonly string[] = [
  "id",
  "label",
  "workspace",
  "lifecycle",
  "hasLiveProcess",
  "inputSurface",
];

/**
 * Reads the allowlisted fields from a row-shaped record. Additional owner
 * fields are ignored here (the projection deliberately accepts the full local
 * view); {@link parseRemoteSessionMetadata} additionally rejects them.
 */
function buildRow(row: object, rejectUnknownNativeKeys: boolean): RemoteSessionMetadata {
  const record = row as Record<string, unknown>;
  const exitCode = readExitCode(ownField(record, "exitCode"));
  const error = readError(ownField(record, "error"));
  return {
    id: requiredText(ownField(record, "id"), MAX_REMOTE_ROW_ID_BYTES),
    label: requiredText(ownField(record, "label"), MAX_REMOTE_LABEL_BYTES, MAX_REMOTE_LABEL_CHARS),
    workspace: requiredExactText(ownField(record, "workspace"), MAX_REMOTE_WORKSPACE_BYTES),
    lifecycle: readLifecycle(ownField(record, "lifecycle")),
    hasLiveProcess: readBoolean(ownField(record, "hasLiveProcess")),
    busy: readObservation(ownField(record, "busy")),
    pendingInput: readObservation(ownField(record, "pendingInput")),
    inputSurface: readBoolean(ownField(record, "inputSurface")),
    activity: readActivity(ownField(record, "activity")),
    nativeSession: readNativeSession(ownField(record, "nativeSession"), rejectUnknownNativeKeys),
    backgroundTasks: readCount(ownField(record, "backgroundTasks")),
    backgroundShells: readCount(ownField(record, "backgroundShells")),
    activeTasks: readCount(ownField(record, "activeTasks")),
    activeShells: readCount(ownField(record, "activeShells")),
    ...(exitCode === undefined ? {} : { exitCode }),
    ...(error === undefined ? {} : { error }),
  };
}

/**
 * Owner-side projection: copies only the approved local-equivalent sidebar
 * facts. The private native current file, `agentDir`, restart binding, and any
 * hidden/extra properties are never spread. Malformed or oversized owner rows
 * throw a fixed-code error rather than being silently truncated into a
 * different identity, workspace, or target.
 */
export function toRemoteSessionMetadata(view: NativeInstanceView): RemoteSessionMetadata {
  try {
    return buildRow(view, false);
  } catch (error) {
    if (error instanceof RemoteSessionMetadataError) throw error;
    // A hostile/odd property read must not leak raw exception detail.
    throw new RemoteSessionMetadataError("ROSTER_ROW_INVALID");
  }
}

/**
 * Strict decoder for an already-framed remote row. Unknown top-level or nested
 * native-session keys (including `currentFile`) are rejected so private owner
 * fields cannot ride along. Every invalid shape returns `null`; raw values and
 * exception details are never returned or logged. Optional/absent observations
 * decode as unknown (`null`) or empty activity, never as fabricated values.
 */
export function parseRemoteSessionMetadata(value: unknown): RemoteSessionMetadata | null {
  try {
    if (!isPlainRecord(value)) return null;
    const record = value;
    const keys = Object.keys(record);
    if (keys.some((key) => !ALLOWED_ROW_KEYS.has(key))) return null;
    for (const key of REQUIRED_ROW_KEYS) {
      if (!Object.prototype.hasOwnProperty.call(record, key)) return null;
    }
    return buildRow(record, true);
  } catch {
    return null;
  }
}
