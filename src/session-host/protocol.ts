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
 * its supplied workspace/title and a reference to its private staged prompt;
 * the host replies only with a bounded launch outcome. A request carrying the
 * optional `host`/`kind` routing selectors travels as a distinct
 * `spawn_routed_request` frame, sent only when the registration's bootstrap
 * advertised routed-spawn support (`spawnRouting`), so an older or
 * not-yet-integrated host can never drop the selectors and launch a local Pi.
 * A request carrying `createWorkspace: true` also travels as the routed family,
 * and only when the bootstrap additionally advertised `spawnCreateWorkspace`
 * (the registration's declared creation support), so an older routed host can
 * never silently ignore it.
 * A registration whose bootstrap advertises `sessionHosts` (only together
 * with `spawnRouting`) also lets the child send one read-only `hosts_request`;
 * the host answers with one or more bounded, token-authenticated, ordered
 * `hosts_result` pages that the reporter reassembles into one complete
 * validated SessionHosts snapshot or reports as unavailable, never partial.
 * Discovery frames carry only closed backend names, existing opaque saved
 * destination ids, and each destination's existing saved friendly label (display
 * metadata, never identity or authority): no prompt, title, workspace, path,
 * address, or profile data.
 *
 * Privacy contract: status frames carry no tool arguments, question text,
 * transcripts, or credentials. Owned-work counts are opaque numbers only.
 * Spawn commands carry the supplied workspace/title plus only a bounded
 * private-payload reference (basename, exact byte size, SHA-256 digest); the
 * prompt text itself travels through the host-owned payload namespace and is
 * never copied into status snapshots or status/sidebar diagnostics. The
 * requested title appears through ordinary native conversation-name and
 * sidebar fields; the prompt is delivered to the new child's conversation.
 * The bootstrap token
 * appears in the hello and authenticated command frames only. Every
 * field is strictly bounded and MAX_STATUS_FRAME_BYTES caps each wire frame;
 * this module is the shared contract for both sides and performs no IO.
 */

import { isAbsolute, posix as posixPath } from "node:path";
import { isRecord } from "../record-guard";
import {
  MAX_PEER_DESTINATIONS,
  MAX_PEER_DESTINATION_ID_CHARS,
  MAX_PEER_DESTINATION_ID_UTF8_BYTES,
  isValidPeerDestinationId,
} from "./peer-destination-id";
import { SESSION_BACKENDS, isSessionBackend, type SessionBackend } from "./session-backend";
import { DEFAULT_PEER_TRANSPORT_BOUNDS, isValidPeerLabel } from "./network/protocol";

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
/**
 * Optional SessionSpawn host selector transport bound (UTF-8 bytes), derived
 * from the saved paired-destination id bound so every existing saved id fits;
 * the value is never clipped. The admitted shape is the saved-id contract
 * itself ({@link isValidSessionSpawnHost}).
 */
export const MAX_SESSION_SPAWN_HOST_BYTES = MAX_PEER_DESTINATION_ID_UTF8_BYTES;
/** Private staged-payload basenames are bounded, strict, and single-segment. */
export const MAX_SESSION_PAYLOAD_NAME_BYTES = 64;
/** Canonical absolute host-owned payload namespace path bound. */
export const MAX_SESSION_HOST_PAYLOAD_DIR_BYTES = 2048;

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
  /**
   * Private host-owned directory for automatically staged payload files.
   * Absent on an older/foreign bootstrap: the reporter then withholds the
   * long-prompt SessionSpawn capability instead of falling back to inline
   * prompt transport.
   */
  payloadDir?: string;
  /**
   * Closed opt-in child-side input-framing mode marker. Absence is the legacy
   * bootstrap exactly; the only admitted value is mode version 1, and any other
   * value (including a numeric string, `0`, `true`, or a future version) rejects
   * the whole bootstrap instead of degrading to a half-understood mode. The
   * marker states that the host registered this child in strict framing mode; it
   * grants no input, clipboard, trust, or permission, and an older child that
   * ignores it simply never signals readiness (so the host frames nothing).
   */
  inputOriginFraming?: 1;
  /**
   * Closed routed-SessionSpawn support marker. Present (only as mode version 1)
   * exactly when the host registration installed a routed spawn handler, so a
   * reporter may submit `spawn_routed_request` frames. Absence means the host
   * accepts only the legacy three-field own-host Pi request; the reporter then
   * refuses any request carrying `host` or `kind` before staging or sending
   * anything. Any other value rejects the whole bootstrap.
   */
  spawnRouting?: 1;
  /**
   * Closed read-only SessionHosts discovery marker. Present (only as mode
   * version 1, and only together with {@link spawnRouting}) exactly when the
   * host registration installed an actual discovery handler, so the reporter
   * may send `hosts_request` frames and expose the SessionHosts capability.
   * Absence means no inspection is available; any other value rejects the
   * whole bootstrap.
   */
  sessionHosts?: 1;
  /**
   * Closed SessionSpawn workspace-creation support marker (issue #493). Present
   * (only as mode version 1, and only together with {@link spawnRouting})
   * exactly when the host registration declared that its routed spawn handler
   * honors `createWorkspace`, so the reporter may send a routed request carrying
   * `createWorkspace: true`. Absence means the reporter refuses such a request
   * before staging or sending anything, so an older routed host can never
   * silently ignore it. Implementation support only, never a permission. Any
   * other value rejects the whole bootstrap.
   */
  spawnCreateWorkspace?: 1;
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

/** Strict reference to one private staged payload file; never the payload text. */
export interface SessionHostPayloadRef {
  readonly name: string;
  readonly size: number;
  readonly sha256: string;
}

/**
 * Admits only the helper's strict single-segment payload basename shape. The
 * name contains no separators, traversal segment, or arbitrary extension, so
 * a confined join can never escape the host-owned namespace.
 */
export function isValidSessionHostPayloadName(value: unknown): value is string {
  return typeof value === "string"
    && value.length <= MAX_SESSION_PAYLOAD_NAME_BYTES
    && /^p-[0-9a-f]{32}\.json$/.test(value);
}

/** Validates a bounded private-payload reference without reading any file. */
export function parseSessionHostPayloadRef(value: unknown): SessionHostPayloadRef | undefined {
  if (!isRecord(value) || !isValidSessionHostPayloadName(value.name)) return undefined;
  if (!Number.isSafeInteger(value.size) || (value.size as number) < 1) return undefined;
  if (typeof value.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(value.sha256)) return undefined;
  return { name: value.name, size: value.size as number, sha256: value.sha256 };
}

/**
 * Explicit child request; the token is checked by the broker and never passed
 * to host/UI callbacks. The frame type is fixed by the routing selectors: a
 * request carrying `host` and/or `kind` is a `spawn_routed_request` (a family
 * older brokers do not decode, so they close the connection instead of
 * silently dropping the selectors); one carrying neither is the legacy
 * `spawn_request`. The parser rejects any mismatch.
 */
export interface SessionHostSpawnRequest {
  version: 1;
  type: "spawn_request" | "spawn_routed_request";
  instanceId: string;
  generation: string;
  token: string;
  requestId: string;
  workspace: string;
  /** Complete persisted native title input; bounded only for transport safety, never clipped to sidebar width. */
  title: string;
  /** Private staged prompt reference; the exact text is read and verified by the broker. */
  payload: SessionHostPayloadRef;
  /** Exact optional host selector (routed requests only); absence means the requesting child's own host. */
  host?: string;
  /** Exact optional child backend (routed requests only); absence means `pi`. */
  kind?: SessionBackend;
  /**
   * Opt-in destination workspace creation (routed requests only). Carried only as
   * `true`; absence (or an admitted explicit `false`, which the parser drops) is
   * the noncreating request exactly.
   */
  createWorkspace?: true;
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

/**
 * The one SessionSpawn input representation: model tool -> reporter
 * capability -> broker -> owning host handler. Every value is carried exactly
 * as supplied. `host` and `kind` are optional routing selectors: absent `host`
 * means the requesting child's own host (never the host currently selected or
 * viewed in any UI), and absent `kind` means `pi`. A present selector is never
 * dropped or defaulted away: it is honored by a routed handler or refused.
 */
export interface SessionSpawnInput {
  workspace: string;
  title: string;
  prompt: string;
  host?: string;
  kind?: SessionBackend;
  /**
   * Opt-in destination workspace creation (issue #493). Only `true` asks the
   * DESTINATION host (this host when `host` is omitted) to ensure the workspace
   * exists with one ordinary recursive directory creation before its normal
   * launch; it is never performed by a requester for a remote path. Absent or
   * `false` is the noncreating request exactly. A `true` value is never dropped:
   * it is honored by a handler that declared support or refused.
   */
  createWorkspace?: boolean;
}

/**
 * The legacy own-host Pi input shape: exactly the three original fields. The
 * broker passes only this shape to a legacy (Pi-only) spawn handler; a request
 * carrying any routing selector never reaches such a handler.
 */
export type LegacySessionSpawnInput = Omit<SessionSpawnInput, "host" | "kind" | "createWorkspace"> & {
  host?: never;
  kind?: never;
  createWorkspace?: never;
};

/** True when the input or request carries any routing selector (a present value, even `kind: "pi"`). */
export function hasSessionSpawnRouting(value: { readonly host?: unknown; readonly kind?: unknown }): boolean {
  return value.host !== undefined || value.kind !== undefined;
}

/** True only when the input or request asks for destination workspace creation (an exact `true`). */
export function hasSessionSpawnCreateWorkspace(value: { readonly createWorkspace?: unknown }): boolean {
  return value.createWorkspace === true;
}

/**
 * True when a request must travel as the routed family: any routing selector,
 * or a creation request. Older brokers either do not decode that family or route
 * it only to a handler whose registration declared what it honors.
 */
export function requiresRoutedSessionSpawn(
  value: { readonly host?: unknown; readonly kind?: unknown; readonly createWorkspace?: unknown },
): boolean {
  return hasSessionSpawnRouting(value) || hasSessionSpawnCreateWorkspace(value);
}

/**
 * Admits an exact host selector: precisely the existing saved paired-destination
 * id contract ({@link isValidPeerDestinationId}), matched raw with no trimming,
 * case folding, or other rewriting. Surrounding whitespace is part of an id, so
 * it is not refused here. Shape-only; it claims nothing about whether such a
 * host exists. There is no local alias: the caller's own host is selected by
 * omitting the selector.
 */
export function isValidSessionSpawnHost(value: unknown): value is string {
  return isValidPeerDestinationId(value);
}

export type SessionSpawnOutcome = SessionHostSpawnAck["outcome"];

/** One paired destination the caller may select with SessionSpawn `host`. */
export interface SessionHostsEntry {
  /** Exact existing opaque saved destination id; never an invented local alias. */
  readonly id: string;
  /**
   * The destination's existing saved friendly label, exactly as stored and
   * bounded by the existing peer label contract ({@link isValidPeerLabel}).
   * Descriptive only: labels may repeat across destinations and are never
   * accepted as a SessionSpawn `host` selector.
   */
  readonly label: string;
  /** Current kind observations for that destination, canonical order, no duplicates. */
  readonly kinds: readonly SessionBackend[];
}

/**
 * The canonical structured SessionHosts snapshot. `ownKinds` describes the
 * caller's own host (selected by omitting SessionSpawn `host`); `hosts` lists
 * existing paired destination ids eligible for selection. The snapshot is
 * descriptive only: it is neither a permission grant nor a launch receipt.
 */
export interface SessionHostsSnapshot {
  readonly ownKinds: readonly SessionBackend[];
  readonly hosts: readonly SessionHostsEntry[];
}

/** Read-only child-to-host discovery request; carries no user data. */
export interface SessionHostHostsRequest {
  version: 1;
  type: "hosts_request";
  instanceId: string;
  generation: string;
  token: string;
  requestId: string;
}

/**
 * One ordered page of a discovery result. A complete result is `parts` pages
 * with `part` 0..parts-1 in order; page 0 alone carries `ownKinds`, and every
 * page carries a nonempty slice of `hosts` when there is more than one page.
 * An unavailable result is exactly one page with neither field. Each page is
 * token-authenticated like other host-originated commands.
 */
export interface SessionHostHostsResult {
  version: 1;
  type: "hosts_result";
  instanceId: string;
  generation: string;
  token: string;
  requestId: string;
  outcome: "complete" | "unavailable";
  part: number;
  parts: number;
  ownKinds?: SessionBackend[];
  hosts?: SessionHostsEntry[];
}

/** Why an inspection could not produce a complete snapshot; never a claim that no hosts exist. */
export type SessionHostsUnavailableReason =
  | "not-connected"
  | "busy"
  | "cancelled"
  | "timeout"
  | "disconnected"
  | "host-unavailable"
  | "protocol";

/** Reporter-side inspection outcome: one complete validated snapshot, or unavailable. */
export type SessionHostsInspection =
  | { readonly outcome: "complete"; readonly snapshot: SessionHostsSnapshot }
  | { readonly outcome: "unavailable"; readonly reason: SessionHostsUnavailableReason };

export type SessionHostMessage = SessionHostHello | SessionHostStatus | SessionHostRenameRequest | SessionHostRenameAck
  | SessionHostShutdownRequest | SessionHostShutdownAck | SessionHostSpawnRequest | SessionHostSpawnAck
  | SessionHostActivityRequest | SessionHostActivityResult | SessionHostHostsRequest | SessionHostHostsResult;

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

/**
 * The canonical DISPLAY NAME rule for one hosted row's published label (issue #690).
 *
 * This is the bound a name that ARRIVES AT the host from elsewhere already satisfies:
 * a Pi row's `nativeSession.name`, and therefore the label a roster peer's decoder
 * accepts (`MAX_REMOTE_LABEL_CHARS` is this very bound). A value is refused whole —
 * never clipped, trimmed, or otherwise coerced — unless it is non-empty, exactly
 * trimmed, at most {@linkcode MAX_NATIVE_SESSION_NAME_LENGTH} code points and four
 * times that in UTF-8 bytes, and free of C0/C1 controls, DEL, and line or paragraph
 * separators.
 *
 * It is deliberately NOT the operator's manual caption rule, which is a narrower
 * input bound of its own: an observed provider conversation title is display text the
 * host neither invented nor can edit, so it is measured against the label it must
 * survive travelling in, not against what a rename prompt would accept.
 */
export function isValidNativeDisplayName(value: unknown): value is string {
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
    || !isValidNativeDisplayName(value.name)) return undefined;
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
 * The only admitted input-framing mode version. Exported so the host records
 * exactly this marker in a registration bootstrap and nothing else can invent a
 * mode value.
 */
export const INPUT_ORIGIN_FRAMING_MODE = 1 as const;

/** The only admitted routed-SessionSpawn bootstrap marker version. */
export const SESSION_SPAWN_ROUTING_MODE = 1 as const;

/** The only admitted read-only SessionHosts discovery bootstrap marker version. */
export const SESSION_HOSTS_DISCOVERY_MODE = 1 as const;

/** The only admitted SessionSpawn workspace-creation support bootstrap marker version. */
export const SESSION_SPAWN_CREATE_WORKSPACE_MODE = 1 as const;

/**
 * Validates a parsed bootstrap value. Returns undefined (never throws) when
 * any field is missing, unbounded, or malformed.
 */
/** Admits a canonical absolute private payload namespace, or absence. */
function isValidPayloadDirectory(value: unknown): value is string {
  return typeof value === "string"
    && value.length > 0
    && !value.includes("\0")
    && Buffer.byteLength(value, "utf8") <= MAX_SESSION_HOST_PAYLOAD_DIR_BYTES
    && isAbsolute(value);
}

export function parseBootstrap(value: unknown): SessionHostBootstrap | undefined {
  if (!isRecord(value) || value.version !== PROTOCOL_VERSION) return undefined;
  if (!isValidSocketPath(value.socketPath)) return undefined;
  if (!isValidToken(value.token)) return undefined;
  if (!isValidId(value.instanceId)) return undefined;
  if (!isValidId(value.generation)) return undefined;
  if (value.payloadDir !== undefined && !isValidPayloadDirectory(value.payloadDir)) return undefined;
  // Closed mode set: an unknown or malformed marker is a protocol-shape failure
  // for the whole bootstrap, never a silent downgrade to legacy framing.
  if (value.inputOriginFraming !== undefined && value.inputOriginFraming !== INPUT_ORIGIN_FRAMING_MODE) {
    return undefined;
  }
  if (value.spawnRouting !== undefined && value.spawnRouting !== SESSION_SPAWN_ROUTING_MODE) return undefined;
  // Discovery describes routed-spawn destinations, so it is meaningful (and
  // admitted) only alongside the routed-spawn marker.
  if (value.sessionHosts !== undefined
    && (value.sessionHosts !== SESSION_HOSTS_DISCOVERY_MODE || value.spawnRouting === undefined)) return undefined;
  // Creation support describes the routed handler, so it is admitted only beside it.
  if (value.spawnCreateWorkspace !== undefined
    && (value.spawnCreateWorkspace !== SESSION_SPAWN_CREATE_WORKSPACE_MODE || value.spawnRouting === undefined)) {
    return undefined;
  }
  return {
    version: 1,
    socketPath: value.socketPath,
    token: value.token,
    instanceId: value.instanceId,
    generation: value.generation,
    ...(value.payloadDir === undefined ? {} : { payloadDir: value.payloadDir }),
    ...(value.inputOriginFraming === undefined ? {} : { inputOriginFraming: INPUT_ORIGIN_FRAMING_MODE }),
    ...(value.spawnRouting === undefined ? {} : { spawnRouting: SESSION_SPAWN_ROUTING_MODE }),
    ...(value.sessionHosts === undefined ? {} : { sessionHosts: SESSION_HOSTS_DISCOVERY_MODE }),
    ...(value.spawnCreateWorkspace === undefined ? {} : { spawnCreateWorkspace: SESSION_SPAWN_CREATE_WORKSPACE_MODE }),
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
  if (!isRecord(value) || value.version !== PROTOCOL_VERSION
    || (value.type !== "spawn_request" && value.type !== "spawn_routed_request")) return undefined;
  // Own-property presence, not truthiness: a present selector key must carry a
  // valid value, and its presence fixes the frame family.
  const hasHost = Object.prototype.hasOwnProperty.call(value, "host");
  const hasKind = Object.prototype.hasOwnProperty.call(value, "kind");
  if (hasHost && !isValidSessionSpawnHost(value.host)) return undefined;
  if (hasKind && !isSessionBackend(value.kind)) return undefined;
  // A present creation flag must be a boolean; only `true` asks for creation, and
  // it fixes the routed family exactly like a selector does.
  const hasCreateWorkspace = Object.prototype.hasOwnProperty.call(value, "createWorkspace");
  if (hasCreateWorkspace && typeof value.createWorkspace !== "boolean") return undefined;
  const createWorkspace = value.createWorkspace === true;
  if ((value.type === "spawn_routed_request") !== (hasHost || hasKind || createWorkspace)) return undefined;
  if (!isValidId(value.instanceId) || !isValidId(value.generation) || !isValidToken(value.token)
    || !isValidId(value.requestId)) return undefined;
  if (typeof value.workspace !== "string" || value.workspace.length === 0
    || Buffer.byteLength(value.workspace, "utf8") > MAX_SESSION_SPAWN_WORKSPACE_BYTES
    || value.workspace.includes("\0")) return undefined;
  if (!isValidRenameName(value.title)
    || Buffer.byteLength(value.title, "utf8") > MAX_SESSION_SPAWN_TITLE_BYTES) return undefined;
  const payload = parseSessionHostPayloadRef(value.payload);
  if (!payload) return undefined;
  const parsed: SessionHostSpawnRequest = {
    version: 1,
    type: value.type,
    instanceId: value.instanceId,
    generation: value.generation,
    token: value.token,
    requestId: value.requestId,
    workspace: value.workspace,
    title: value.title,
    payload,
    ...(hasHost ? { host: value.host as string } : {}),
    ...(hasKind ? { kind: value.kind as SessionBackend } : {}),
    ...(createWorkspace ? { createWorkspace: true as const } : {}),
  };
  // The prompt text is out-of-band; the bounded reference and title must still
  // fit the shared raw-frame limit before the reporter attempts a write.
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

// ---------------------------------------------------------------------------
// SessionHosts discovery (issue #493)
// ---------------------------------------------------------------------------

/** Worst-case encoded bytes of one host entry plus its array separator. */
const WORST_HOSTS_ENTRY_BYTES = Buffer.byteLength(JSON.stringify({
  // An unpaired surrogate is the costliest admitted code unit once JSON-escaped (6 bytes).
  id: "\ud800".repeat(MAX_PEER_DESTINATION_ID_CHARS),
  // The existing label alphabet needs no JSON escaping, so the longest admitted
  // label costs exactly its existing byte bound.
  label: "x".repeat(DEFAULT_PEER_TRANSPORT_BOUNDS.maxLabelBytes),
  kinds: SESSION_BACKENDS,
}), "utf8") + 1;

/** Worst-case page envelope (largest ids/token/counters, `ownKinds`, empty `hosts`) plus newline. */
const WORST_HOSTS_ENVELOPE_BYTES = Buffer.byteLength(JSON.stringify({
  version: PROTOCOL_VERSION,
  type: "hosts_result",
  instanceId: "f".repeat(MAX_ID_LENGTH),
  generation: "f".repeat(MAX_ID_LENGTH),
  token: "f".repeat(64),
  requestId: "f".repeat(MAX_ID_LENGTH),
  outcome: "complete",
  part: 99,
  parts: 99,
  ownKinds: SESSION_BACKENDS,
  hosts: [],
}), "utf8") + 1;

/**
 * Upper bound on discovery pages, derived only from the existing frame cap and
 * the existing saved-destination bounds (never a separate host limit). Greedy
 * packing places at least floor(capacity / worst entry) entries on every page
 * but the last, so a valid snapshot never needs more pages than this.
 */
export const MAX_SESSION_HOSTS_RESULT_PARTS = Math.ceil(
  MAX_PEER_DESTINATIONS / Math.floor((MAX_STATUS_FRAME_BYTES - WORST_HOSTS_ENVELOPE_BYTES) / WORST_HOSTS_ENTRY_BYTES),
);

/**
 * Closed kind-list validation: an array of known backends with no duplicates.
 * Returns the canonical (display-order) list; with `requireCanonical` a list
 * that is not already canonical is refused instead of reordered.
 */
function parseSessionHostKinds(value: unknown, requireCanonical: boolean): SessionBackend[] | undefined {
  if (!Array.isArray(value) || value.length > SESSION_BACKENDS.length) return undefined;
  const seen = new Set<SessionBackend>();
  for (const kind of value) {
    if (!isSessionBackend(kind) || seen.has(kind)) return undefined;
    seen.add(kind);
  }
  const canonical = SESSION_BACKENDS.filter((kind) => seen.has(kind));
  if (requireCanonical && canonical.some((kind, index) => value[index] !== kind)) return undefined;
  return canonical;
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const own = Object.keys(value);
  return own.length === keys.length && keys.every((key) => Object.prototype.hasOwnProperty.call(value, key));
}

/**
 * Closed `{ id, label, kinds }` entry with an existing saved-destination id
 * shape and an existing saved-label shape. The label is required and kept
 * exactly; it is never compared, deduplicated, or used as identity.
 */
function parseSessionHostsEntry(value: unknown, requireCanonical: boolean): SessionHostsEntry | undefined {
  if (!isRecord(value) || !hasExactKeys(value, ["id", "label", "kinds"])) return undefined;
  if (!isValidPeerDestinationId(value.id) || !isValidPeerLabel(value.label)) return undefined;
  const kinds = parseSessionHostKinds(value.kinds, requireCanonical);
  if (!kinds) return undefined;
  return { id: value.id, label: value.label, kinds };
}

function parseSessionHostsEntries(
  value: unknown,
  requireCanonical: boolean,
  seen: Set<string> = new Set(),
): SessionHostsEntry[] | undefined {
  if (!Array.isArray(value) || value.length > MAX_PEER_DESTINATIONS) return undefined;
  const hosts: SessionHostsEntry[] = [];
  for (const raw of value) {
    const entry = parseSessionHostsEntry(raw, requireCanonical);
    // Ids are compared exactly as stored: no trimming or case folding.
    if (!entry || seen.has(entry.id)) return undefined;
    seen.add(entry.id);
    hosts.push(entry);
  }
  return hosts;
}

/**
 * The one canonical SessionHosts snapshot validator. Admits exactly
 * `{ ownKinds, hosts }` with closed kind lists (duplicates refused, order
 * canonicalized), closed `{ id, label, kinds }` entries whose ids satisfy the
 * existing saved-destination contract and whose labels satisfy the existing
 * saved-label contract, unique ids (labels may repeat), and at most the
 * existing saved destination bound. Returns a fresh frozen canonical copy, or undefined.
 */
export function parseSessionHostsSnapshot(value: unknown): SessionHostsSnapshot | undefined {
  if (!isRecord(value) || !hasExactKeys(value, ["ownKinds", "hosts"])) return undefined;
  const ownKinds = parseSessionHostKinds(value.ownKinds, false);
  const hosts = parseSessionHostsEntries(value.hosts, false);
  if (!ownKinds || !hosts) return undefined;
  return Object.freeze({
    ownKinds: Object.freeze(ownKinds),
    hosts: Object.freeze(hosts.map((entry) => Object.freeze({
      id: entry.id,
      label: entry.label,
      kinds: Object.freeze([...entry.kinds]),
    }))),
  });
}

/** Validates a child-to-host read-only discovery request. */
export function parseHostsRequest(value: unknown): SessionHostHostsRequest | undefined {
  if (!isRecord(value) || value.version !== PROTOCOL_VERSION || value.type !== "hosts_request") return undefined;
  if (!hasExactKeys(value, ["version", "type", "instanceId", "generation", "token", "requestId"])) return undefined;
  if (!isValidId(value.instanceId) || !isValidId(value.generation) || !isValidToken(value.token)
    || !isValidId(value.requestId)) return undefined;
  return {
    version: 1,
    type: "hosts_request",
    instanceId: value.instanceId,
    generation: value.generation,
    token: value.token,
    requestId: value.requestId,
  };
}

/**
 * Validates one discovery result page in isolation: envelope identity shapes,
 * part/parts counters within the transport-derived bound, outcome-specific
 * closed fields, canonical kind lists, and unique valid ids within the page.
 * Cross-page sequence, count, and uniqueness are checked by
 * {@link SessionHostsResultAssembler}.
 */
export function parseHostsResult(value: unknown): SessionHostHostsResult | undefined {
  if (!isRecord(value) || value.version !== PROTOCOL_VERSION || value.type !== "hosts_result") return undefined;
  if (!isValidId(value.instanceId) || !isValidId(value.generation) || !isValidToken(value.token)
    || !isValidId(value.requestId)) return undefined;
  if (!Number.isSafeInteger(value.parts) || (value.parts as number) < 1
    || (value.parts as number) > MAX_SESSION_HOSTS_RESULT_PARTS) return undefined;
  if (!Number.isSafeInteger(value.part) || (value.part as number) < 0
    || (value.part as number) >= (value.parts as number)) return undefined;
  const envelope = ["version", "type", "instanceId", "generation", "token", "requestId", "outcome", "part", "parts"];
  const base = {
    version: 1 as const,
    type: "hosts_result" as const,
    instanceId: value.instanceId,
    generation: value.generation,
    token: value.token,
    requestId: value.requestId,
    part: value.part as number,
    parts: value.parts as number,
  };
  if (value.outcome === "unavailable") {
    if (!hasExactKeys(value, envelope) || value.parts !== 1) return undefined;
    return { ...base, outcome: "unavailable" };
  }
  if (value.outcome !== "complete") return undefined;
  const first = value.part === 0;
  if (!hasExactKeys(value, first ? [...envelope, "ownKinds", "hosts"] : [...envelope, "hosts"])) return undefined;
  const hosts = parseSessionHostsEntries(value.hosts, true);
  if (!hosts) return undefined;
  // A page in a multi-page result always carries hosts; empty filler pages are malformed.
  if ((value.parts as number) > 1 && hosts.length === 0) return undefined;
  if (!first) return { ...base, outcome: "complete", hosts };
  const ownKinds = parseSessionHostKinds(value.ownKinds, true);
  if (!ownKinds) return undefined;
  return { ...base, outcome: "complete", ownKinds, hosts };
}

/** Correlation identity shared by every page of one discovery result. */
export interface SessionHostsResultIdentity {
  readonly instanceId: string;
  readonly generation: string;
  readonly token: string;
  readonly requestId: string;
}

/**
 * Encodes one discovery reply as ordered newline-terminated wire frames. A
 * snapshot is canonicalized and validated first; an invalid or absent snapshot
 * becomes one `unavailable` page, never a partial listing. Hosts are packed
 * greedily by measured encoded size, so the small common case is one frame and
 * large Unicode/long-id snapshots split across bounded frames without
 * truncation or any new total-host limit.
 */
export function encodeSessionHostsResultFrames(
  identity: SessionHostsResultIdentity,
  snapshot: unknown,
): string[] {
  const envelope = {
    version: 1 as const,
    type: "hosts_result" as const,
    instanceId: identity.instanceId,
    generation: identity.generation,
    token: identity.token,
    requestId: identity.requestId,
  };
  const unavailable = (): string[] => [encodeFrame({ ...envelope, outcome: "unavailable", part: 0, parts: 1 })];
  const canonical = parseSessionHostsSnapshot(snapshot);
  if (!canonical) return unavailable();
  const pageFrame = (part: number, parts: number, hosts: readonly SessionHostsEntry[]): string => `${JSON.stringify({
    ...envelope,
    outcome: "complete",
    part,
    parts,
    ...(part === 0 ? { ownKinds: canonical.ownKinds } : {}),
    hosts,
  })}\n`;
  const fits = (part: number, hosts: readonly SessionHostsEntry[]): boolean =>
    // Measure with the widest admitted counters so final numbering cannot grow a page.
    Buffer.byteLength(pageFrame(part === 0 ? 0 : MAX_SESSION_HOSTS_RESULT_PARTS - 1, MAX_SESSION_HOSTS_RESULT_PARTS, hosts), "utf8")
      <= MAX_STATUS_FRAME_BYTES;
  const pages: SessionHostsEntry[][] = [[]];
  for (const entry of canonical.hosts) {
    const current = pages[pages.length - 1]!;
    if (current.length > 0 && !fits(pages.length - 1, [...current, entry])) {
      pages.push([entry]);
    } else {
      current.push(entry);
    }
    if (!fits(pages.length - 1, pages[pages.length - 1]!)) return unavailable();
  }
  if (pages.length > MAX_SESSION_HOSTS_RESULT_PARTS) return unavailable();
  try {
    const frames = pages.map((hosts, part) => pageFrame(part, pages.length, hosts));
    for (const frame of frames) {
      if (Buffer.byteLength(frame, "utf8") > MAX_STATUS_FRAME_BYTES
        || !parseHostsResult(JSON.parse(frame.slice(0, -1)))) return unavailable();
    }
    return frames;
  } catch {
    return unavailable();
  }
}

/** One assembler step: more pages expected, a final outcome, or a protocol violation. */
export type SessionHostsAssemblyStep =
  | { readonly status: "pending" }
  | { readonly status: "complete"; readonly snapshot: SessionHostsSnapshot }
  | { readonly status: "unavailable" }
  | { readonly status: "invalid" };

/**
 * Reassembles one discovery result from its ordered pages. The caller has
 * already authenticated each page's instance, generation, and token and routed
 * it by request id. Pages must arrive strictly in order with a constant
 * `parts`/`outcome`; ids must be unique across pages; the final snapshot is
 * re-validated with {@link parseSessionHostsSnapshot}. Nothing is returned as
 * complete until every page arrived, and any deviation is `invalid`.
 */
export class SessionHostsResultAssembler {
  readonly #requestId: string;
  #parts: number | undefined;
  #ownKinds: SessionBackend[] | undefined;
  readonly #hosts: SessionHostsEntry[] = [];
  readonly #ids = new Set<string>();
  /** Pages accepted so far; the next page must carry exactly this index. */
  #accepted = 0;
  #finished = false;

  constructor(requestId: string) {
    this.#requestId = requestId;
  }

  accept(page: SessionHostHostsResult): SessionHostsAssemblyStep {
    if (this.#finished || page.requestId !== this.#requestId) return this.#fail();
    if (page.outcome === "unavailable") {
      if (this.#parts !== undefined || page.part !== 0 || page.parts !== 1) return this.#fail();
      this.#finished = true;
      return { status: "unavailable" };
    }
    if (page.part !== this.#accepted) return this.#fail();
    if (this.#parts === undefined) {
      if (page.ownKinds === undefined) return this.#fail();
      this.#parts = page.parts;
      this.#ownKinds = [...page.ownKinds];
    } else if (page.parts !== this.#parts || page.ownKinds !== undefined) {
      return this.#fail();
    }
    if (!page.hosts) return this.#fail();
    for (const entry of page.hosts) {
      // Exact-id uniqueness across pages, checked on arrival.
      if (this.#ids.has(entry.id)) return this.#fail();
      this.#ids.add(entry.id);
    }
    this.#hosts.push(...page.hosts);
    this.#accepted += 1;
    if (this.#hosts.length > MAX_PEER_DESTINATIONS) return this.#fail();
    if (this.#accepted < this.#parts) return { status: "pending" };
    this.#finished = true;
    const snapshot = parseSessionHostsSnapshot({ ownKinds: this.#ownKinds, hosts: this.#hosts });
    return snapshot ? { status: "complete", snapshot } : { status: "invalid" };
  }

  #fail(): SessionHostsAssemblyStep {
    this.#finished = true;
    return { status: "invalid" };
  }
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
    case "spawn_request":
    case "spawn_routed_request": return parseSpawnRequest(parsed);
    case "spawn_result": return parseSpawnAck(parsed);
    case "activity_request": return parseActivityRequest(parsed);
    case "activity_result": return parseActivityResult(parsed);
    case "hosts_request": return parseHostsRequest(parsed);
    case "hosts_result": return parseHostsResult(parsed);
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
