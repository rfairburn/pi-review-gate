/**
 * Authenticated bounded local status broker for independently owned native
 * instances (issue #323 POSIX and Windows IPC alpha).
 *
 * Each POSIX broker owns one private freshly-created Unix-socket transport
 * (mkdtemp directory, mode 0700; own socket file, mode 0600) beneath a
 * canonical caller-supplied socket root directory or the OS temp directory.
 * Windows brokers instead own one freshly generated public-Node named-pipe
 * endpoint; Windows default ACLs are used because the public Node API does
 * not expose a restrictive security descriptor or local-only option.
 * Independently owned native instances register themselves BEFORE their PTY
 * is spawned and receive a per-registration cryptorandom token to present in
 * the protocol hello frame (see ./protocol). The broker then accepts a
 * bounded stream of newline-delimited JSON status frames from each
 * authenticated reporter connection and forwards sanitized snapshot callbacks
 * to that registration's handlers. Registrations can issue bounded native
 * rename requests and process-scoped graceful-shutdown requests whose
 * acknowledgements are fenced to the live connection, unique request ID, and
 * expected native session ID/epoch. A
 * shutdown acknowledgement means only that public shutdown was requested;
 * the manager must still observe the owned PTY's actual onExit before treating
 * the process as exited.
 * A registration whose reporter advertised `activity-census` can also request
 * one complete freshly observed status; concurrent requests coalesce with one
 * bounded follow-up, stale/reordered replies cannot replace a newer accepted
 * snapshot, and a legacy reporter is never sent an unadvertised frame.
 *
 * SessionSpawn prompts do not travel in bounded control frames. Each
 * registration advertises one freshly-created private (0700) payload
 * namespace in its bootstrap; the reporter stages the exact prompt there and
 * the broker verifies the declared basename, size, digest, no-follow file
 * identity, and UTF-8 JSON value before invoking the host callback. Dedupe
 * happens before any read, so an exact replay of an already-consumed payload
 * still coalesces and always gets the same bounded launch outcome. A successful
 * read consumes only that verified file inode; the namespace is removed only
 * when its own identity still matches and it is empty.
 *
 * Routed SessionSpawn (optional `host`/`kind` selectors) is a separate
 * `spawn_routed_request` frame family. A registration advertises it in its
 * bootstrap (`spawnRouting`) only when the caller installed
 * `onRoutedSpawnRequest`; a routed request is delivered only to that handler
 * and is otherwise refused with a definite `failed` before any payload read.
 * The legacy Pi-only `onSpawnRequest` never receives a routed request.
 * A routed request carrying `createWorkspace: true` additionally requires the
 * registration's explicit `routedSpawnCreateWorkspace` declaration (advertised
 * as bootstrap `spawnCreateWorkspace`); without it the request is refused with a
 * definite `failed` before any payload read and no handler is invoked.
 *
 * Read-only SessionHosts discovery (issue #493) is advertised in the bootstrap
 * (`sessionHosts`) only when the caller installed BOTH `onSessionHostsRequest`
 * and `onRoutedSpawnRequest`. An authenticated `hosts_request` invokes that
 * handler once (bounded concurrency and deadline, abortable), validates its
 * snapshot with the shared canonical validator, and replies with ordered
 * token-authenticated `hosts_result` pages, or one `unavailable` page when the
 * handler throws, times out, or returns anything malformed. The broker keeps
 * no snapshot cache, registry, or second authority: every reply comes from the
 * handler's current answer. A request never launches, connects, pairs, or
 * probes anything on the broker's own behalf.
 *
 * A separate native-only one-shot family (see ./native-hook-protocol) lets
 * provider command hooks report closed lifecycle metadata on the same local
 * listener. A native source is registered before its provider child spawns and
 * gets its own token/record map; it never becomes a Pi reporter. Each hook
 * delivery is one bounded frame authenticated before any event handling, one
 * fixed-size ACK with no source data echoed, and a normal close. Native
 * deliveries cannot evict/supersede the active Pi reporter, advance the Pi
 * sequence, fire Pi reconnect/disconnect callbacks, or exercise any Pi command
 * authority. Wrong/stale/cross-family tokens and mismatched backends close
 * silently with no callback. Authenticated native concurrency has its own
 * post-auth bound; the existing 32-pending/2s pre-auth listener pool remains
 * honestly shared rather than being claimed as isolated. Stop/SubagentStop may
 * carry a relay-derived `background_counts` projection of a whole validated
 * provider snapshot; those are native provider observations only, never Pi
 * `backgroundTasks`/`backgroundShells`, host ownership, or Stop authority. This
 * lane is observation only: a hook that never runs or never reaches the broker
 * is an unreported unknown, never a heartbeat/liveness claim or a fabricated
 * state.
 *
 * A third separate family (see ./native-mcp-protocol, issue #682) carries the
 * hosted native MCP tool lane on this same listener. The host registers one
 * native MCP source per owned launch BEFORE the provider CLI spawns, with its
 * own token/record map and a trusted {@link NativeMcpToolEndpoint}; the
 * launch's stdio relay presents that token in a `native_mcp_hello` under the
 * shared pre-auth reader and deadline. Wrong, stale, released, cross-family,
 * and backend-mismatched hellos close silently and never reach the endpoint.
 * The lane is a pure transport: it forwards only validated `list`/`call`
 * operations (tool name, arguments object, abort signal), never client
 * identity or metadata, and decides no ownership or per-tool authority. Each
 * registration admits exactly one authenticated connection for its lifetime:
 * no takeover while it is live and no re-hello after it closes. After
 * authentication the connection leaves the pre-auth pool and uses the
 * family's own frame bounds plus per-connection and broker-wide in-flight
 * bounds; an over-bound request is answered `busy` without reaching the
 * endpoint. Cancel, close, release, and disposal abort in-flight endpoint
 * signals; a late endpoint result is dropped, and nothing is queued,
 * replayed, or retried. A broker-wide slot is returned only when its endpoint
 * promise settles, so aborted-but-still-running owner work keeps counting. A native MCP source may coexist with the same row's
 * hook source but never with a Pi registration.
 *
 * A fourth separate family (see ./native-review-hook-protocol, issue #736) is
 * the one family whose answer changes what the provider does with a turn. The
 * host registers one native review source per owned launch BEFORE the provider
 * child that runs its blocking hook spawns, with its own token/record map; the
 * hook's relay authenticates inside its single `native_review_request` line
 * under the shared pre-auth reader and deadline, and the connection is then
 * HELD open while the host reviews the turn. Wrong, stale, released,
 * cross-family, and backend-mismatched requests close silently and never reach
 * the host callback. That one line is the COMPLETE request, reviewed assistant
 * text included, so nothing is authenticated, counted, or held before the whole
 * line has decoded. Because that line is inherently larger than a legacy frame, a
 * broker hosting a review source buffers an unauthenticated line up to THIS
 * family's own bound; every legacy family's own frame limit and the pre-auth
 * deadline stay exactly as they were, and an over-bound legacy line is still
 * refused by its own decoder before any callback. The
 * broker calls one validated callback with the closed sanitized request and an
 * abort signal, and writes exactly one answer frame: a verdict, or the closed
 * `busy`/`unavailable`/`failed` code. There is deliberately no broker-side
 * deadline on the held verdict — the provider's own command-hook timeout ends
 * the wait, and a socket that closes first aborts the host's signal instead of
 * letting the review run for a listener that is gone. Socket close, source
 * release, and disposal abort every in-flight signal and drop any late verdict;
 * nothing is queued, replayed, or retried, and a rejected, thrown, or malformed
 * verdict is contained as `failed`, never as a block. Held requests count
 * against per-source and broker-wide bounds of their own, separate from every
 * other family's. Like the observer and MCP families, a review source may
 * coexist with the same row's other native sources — separation is the token
 * and the closed frame type, never the instance id — and it never becomes a Pi
 * reporter or gains any Pi command authority.
 *
 * Safety contract (fail closed):
 *
 * - Hello frames are authenticated FIRST, timing-safe on instance id, host
 *   generation, and token; malformed, stale, wrong-token, unknown-
 *   registration, and unauthenticated status frames are rejected by closing
 *   the offending connection without any snapshot callback.
 * - At most one active authenticated connection exists per registration: a
 *   fresh valid hello supersedes the old socket silently (no onDisconnect is
 *   fired for replacement; only a genuinely currently-owned connection going
 *   away reports a disconnect — intentional release/dispose never does, so
 *   the manager can mark its metadata unknown without false churn).
 * - Sequence numbers are positive safe integers and strictly monotonic per
 *   registration; the last accepted sequence is retained across reconnects
 *   and reporter reloads within one registration.
 * - Wire framing is bounded in raw UTF-8 bytes BEFORE any decoding or
 *   unbounded allocation: oversized or malformed frames (including frames
 *   carrying terminal controls the shared contract forbids — C0, DEL, and C1)
 *   close the connection once detected.
 * - Unauthenticated connection backlog is bounded (32 pending beyond the
 *   registered active connections) with a short auth deadline; there is no
 *   idle-TTL/heartbeat eviction, because a legitimate reporter may sit idle
 *   for hours.
 * - The broker never adopts or unlinks a pre-existing socket, never creates
 *   profile/catalog/child-process state, performs no global scans or
 *   telemetry, and its own cleanup removes only the socket file it created
 *   and its owned empty temp directory — unknown entries are preserved.
 * - Snapshot callbacks receive the decoded shared-contract object (never a
 *   raw frame, never the token) and are guard-wrapped: a throwing consumer
 *   can never crash the native process, and failures are silent (no secrets
 *   or frame contents in diagnostics). Native terminal traffic is fully
 *   independent of status-metadata failures.
 */

import {
  createHash,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import {
  chmodSync,
  linkSync,
  lstatSync,
  mkdirSync,
  renameSync,
  rmdirSync,
  statSync,
  unlinkSync,
  mkdtempSync,
  realpathSync,
} from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import os from "node:os";
import { isAbsolute, join } from "node:path";
import {
  ACTIVITY_CENSUS_CAPABILITY,
  INPUT_ORIGIN_FRAMING_MODE,
  SESSION_SPAWN_ROUTING_MODE,
  SESSION_HOSTS_DISCOVERY_MODE,
  SESSION_SPAWN_CREATE_WORKSPACE_MODE,
  encodeSessionHostsResultFrames,
  hasSessionSpawnCreateWorkspace,
  requiresRoutedSessionSpawn,
  type LegacySessionSpawnInput,
  type SessionHostActivityRequest,
  type SessionHostActivityResult,
  type SessionHostBootstrap,
  type SessionHostHostsRequest,
  type SessionHostsSnapshot,
  type SessionHostHello,
  type SessionHostNativeSession,
  type SessionHostRenameAck,
  type SessionHostRenameRequest,
  type SessionHostShutdownAck,
  type SessionHostShutdownRequest,
  type SessionHostSpawnAck,
  type SessionHostSpawnRequest,
  type SessionHostPayloadRef,
  type SessionSpawnInput,
  type SessionSpawnOutcome,
  type SessionHostStatus,
  MAX_STATUS_FRAME_BYTES,
  PROTOCOL_VERSION,
  decodeFrame,
  encodeFrame,
  isValidNativeSessionId,
  isValidRenameName,
  parseBootstrap,
} from "./protocol";
import {
  discardSessionHostPayload,
  decodeSessionHostPayloadJsonString,
  encodeSessionHostPayloadDirectoryIdentity,
  readSessionHostPayload,
  type SessionHostPayloadDirectoryIdentity,
} from "./payload";
import {
  decodeNativeHookFrame,
  encodeNativeHookFrame,
  isValidNativeHookInstanceId,
  readNativeHookClaudeInboxAttachment,
  type DecodedNativeHookFrame,
  type NativeHookAckFrame,
  type NativeHookBootstrap,
  type NativeHookEvent,
  type NativeHookFailure,
} from "./native-hook-protocol";
import {
  CLAUDE_INBOX_SOCKET_ENV,
  CLAUDE_INBOX_TOKEN_ENV,
  selectClaudeInboxAnnouncement,
  type ClaudeInboxAnnouncementCandidate,
} from "./native-claude-inbox-announcement";
import {
  MAX_NATIVE_MCP_IN_FLIGHT_PER_CONNECTION,
  MAX_NATIVE_MCP_REQUEST_FRAME_BYTES,
  MAX_NATIVE_MCP_RESPONSE_FRAME_BYTES,
  NativeMcpFrameReader,
  decodeNativeMcpClientFrame,
  decodeNativeMcpHello,
  encodeNativeMcpServerFrame,
  isValidNativeMcpInstanceId,
  type NativeMcpBootstrap,
  type NativeMcpHelloFrame,
  type NativeMcpRequestFrame,
  type NativeMcpResponseFrame,
} from "./native-mcp-protocol";
import {
  decodeNativeReviewRequestFrame,
  MAX_NATIVE_REVIEW_REQUEST_FRAME_BYTES,
  encodeNativeReviewServerFrame,
  isValidNativeReviewInstanceId,
  parseNativeReviewVerdict,
  type NativeReviewBootstrap,
  type NativeReviewRequest,
  type NativeReviewServerFrame,
  type NativeReviewVerdict,
} from "./native-review-hook-protocol";
import type { NativeMcpToolEndpoint } from "./native-mcp-stdio";
import { isNativeCliBackend, type NativeCliBackend } from "./session-backend";

/** Options accepted by {@link createStatusBroker}. */
export interface StatusBrokerOptions {
  /** Canonical existing POSIX directory for the private transport; unused by Windows named pipes. */
  socketRoot?: string;
}

/** Callbacks bound to one registration; always guard-wrapped by the broker. */
export interface StatusBrokerStatusHandlers {
  /**
   * Bounded snapshot callback; arguments come only from the shared contract.
   * The optional `backgroundTasks`/`backgroundShells` counts are forwarded
   * exactly as validated (a nonnegative safe integer, or null for unknown);
   * the broker never zeroes them on reconnect, replacement, release, or
   * disconnect, so a cleared tracker can never reach a consumer as "nothing
   * running".
   */
  onStatus: (status: SessionHostStatus) => void;
  /** Fired only when a currently-owned authenticated connection actually disconnects. */
  onDisconnect: () => void;
  /**
   * Fired after a valid hello supersedes or reconnects an already-observed
   * registration. The host may discard its cached ephemeral row understanding
   * and request a fresh authoritative census; this is never fired for the
   * first connection of a fresh registration.
   */
  onReconnect?: () => void;
  /**
   * Optional legacy own-host Pi spawn operation, invoked only by a valid
   * request on this registration's authenticated connection. It receives
   * exactly the three legacy fields; a request carrying `host` or `kind` is
   * never delivered here (it goes to {@link onRoutedSpawnRequest} or is
   * refused), so a Pi-only handler can never silently ignore a selector.
   */
  onSpawnRequest?: (request: LegacySessionSpawnInput) => Promise<SessionSpawnOutcome>;
  /**
   * Optional routed spawn operation. Supplying it is the registration's actual
   * routed-spawn support: only then does the bootstrap advertise
   * `spawnRouting`, letting the reporter send `spawn_routed_request`. It is
   * invoked only for a valid routed request (at least one of `host`/`kind`
   * present) and receives the exact {@link SessionSpawnInput}, selectors
   * unchanged. It must honor the selectors or settle without launching (never
   * a local Pi fallback), and must return `unknown` whenever a launch may have
   * happened but was not confirmed. Legacy requests never reach it.
   */
  onRoutedSpawnRequest?: (request: SessionSpawnInput) => Promise<SessionSpawnOutcome>;
  /**
   * Declared support (issue #493): `true` only when {@link onRoutedSpawnRequest}
   * honors `createWorkspace`. Only then, and only beside that handler, does the
   * bootstrap advertise `spawnCreateWorkspace`; a creation request on a
   * registration without the declaration is refused with a definite `failed`
   * before any payload read, so no handler can silently ignore it. It is
   * implementation support only, never a permission.
   */
  routedSpawnCreateWorkspace?: boolean;
  /**
   * Optional read-only SessionHosts discovery source for this registration's
   * own child. Supplying it together with {@link onRoutedSpawnRequest} is the
   * registration's actual inspection capability: only then does the bootstrap
   * advertise `sessionHosts`. It must answer from the host's existing owning
   * launch probe (`ownKinds`, the caller's own host) and existing paired-peer
   * projection (`hosts`, exact saved destination ids eligible for selection);
   * it must not connect, pair, regrant, spawn, or probe the requester's
   * workspace. Any throw, rejection, deadline expiry, or malformed snapshot is
   * reported to the child as unavailable; the signal aborts on deadline,
   * disconnect, release, or disposal.
   */
  onSessionHostsRequest?: (request: SessionHostsRequestContext) => Promise<SessionHostsSnapshot> | SessionHostsSnapshot;
}

/** Context passed to {@link StatusBrokerStatusHandlers.onSessionHostsRequest}; carries no user data. */
export interface SessionHostsRequestContext {
  /** Aborted when the broker stops waiting (deadline, disconnect, release, disposal). */
  readonly signal: AbortSignal;
}

/** True when a handler set carries the actual discovery capability the bootstrap may advertise. */
export function hasSessionHostsDiscoveryHandlers(handlers: StatusBrokerStatusHandlers): boolean {
  return typeof handlers.onSessionHostsRequest === "function" && typeof handlers.onRoutedSpawnRequest === "function";
}

/** True when a handler set carries the declared routed workspace-creation support the bootstrap may advertise. */
export function hasSessionSpawnCreateWorkspaceHandlers(handlers: StatusBrokerStatusHandlers): boolean {
  return typeof handlers.onRoutedSpawnRequest === "function" && handlers.routedSpawnCreateWorkspace === true;
}

/**
 * Closed per-registration options accepted by {@link StatusBroker.register}.
 * An unknown key or a non-boolean mode request is refused outright; the broker
 * never guesses at a half-understood option shape.
 */
export interface StatusRegistrationOptions {
  /**
   * Request the closed child-side input-framing mode (protocol mode version 1)
   * in this registration's one-shot bootstrap, recorded before the child is
   * spawned and never mutated afterwards. Absent/false keeps the legacy
   * bootstrap byte-for-byte. Recording the request grants nothing: the broker
   * opens no transport, observes no readiness, and trusts no input. The child
   * still has to install its decoder and signal readiness on this exact
   * registration before any host may frame a byte.
   */
  readonly inputOriginFraming?: boolean;
}

/** One per-instance registration issued before the native PTY is spawned. */
export interface StatusRegistration {
  /** One-shot bootstrap (socket path, cryptorandom token) handed to the reporter at spawn. */
  bootstrap: SessionHostBootstrap;
  /** Authenticated rename, fenced by the last observed native session ID and epoch. */
  rename: (request: StatusRenameRequest) => Promise<StatusRenameResult>;
  /**
   * Terminal/idempotent shutdown for this owned process registration, fenced
   * to its latest observed session tuple. `requested` is not process exit;
   * the manager must wait for the owned PTY's actual `onExit` result.
   */
  shutdown: (options?: { readonly requireIdle?: boolean }) => Promise<StatusShutdownResult>;
  /** Releases the registration: closes its active connection silently, rejects later hellos. */
  release: () => void;
  /**
   * Requests one bounded, coalesced fresh activity census from this exact
   * authenticated live client. A complete result is delivered through
   * `onStatus` before the returned promise resolves; no token or wire request
   * id is exposed to the caller.
   */
  requestActivity?: () => Promise<StatusActivityRefreshResult>;
}

/** Callbacks bound to one native hook source; always guard-wrapped by the broker. */
export interface NativeHookSourceHandlers {
  /**
   * One sanitized, closed-metadata hook event. The callback never receives a
   * token, provider prompt/answer text, tool arguments/results, transcript
   * lines, or arbitrary provider fields. A throwing consumer is contained.
   * Stop/SubagentStop may carry `background_counts`, a relay-derived whole-array
   * projection of native provider observations; those counts are never Pi
   * ownership, `backgroundTasks`/`backgroundShells`, or Stop authority, and a
   * SubagentStop snapshot is not proof of root scope.
   */
  onEvent: (event: NativeHookEvent) => void;
  /**
   * One closed failure reason for an authenticated delivery: a relay-reported
   * provider/input failure, or the host-local `delivery-refused` when this
   * exact current source's delivery was discarded by post-auth admission.
   * Supported observations stay unknown; a normal acknowledgement or socket
   * close is never reported here, and a discarded delivery never becomes an
   * event or a fabricated busy/idle value.
   */
  onFailure: (failure: NativeHookFailure) => void;
  /**
   * #682, optional trusted owner callback: the opaque native Claude inbox
   * announcement candidate for one authenticated Claude root `SessionStart`
   * whose relay attached a valid announcement. It is invoked only after this
   * exact registration authenticated the frame, only for a `claude` source,
   * only after `onEvent` already received the ordinary event, and never when
   * the registration was released meanwhile. It is read and validated once at
   * registration; replacing it on the handlers object later has no effect, and
   * the candidate is selected from the authenticated frame, not from the event
   * object `onEvent` received. The candidate never enters
   * `onEvent`, status, results, or logs; only the owner's own
   * `readClaudeInboxAnnouncement` reveals its values. An absent, invalid, or
   * oversized announcement simply yields no call, never a lost event. A
   * throwing consumer is contained.
   */
  onClaudeInboxAnnouncement?: (candidate: ClaudeInboxAnnouncementCandidate) => void;
}

/**
 * One owned launch's native hook registration. It is issued BEFORE the
 * corresponding native child spawns and belongs to exactly that launch: release
 * (or broker disposal) invalidates the bootstrap and every later delivery. The
 * parent binds the callbacks to its native status-capture row's exact
 * record/PTY/incarnation; the broker never binds, adopts, or reuses a row.
 */
export interface NativeHookRegistration {
  /** Separate native-family bootstrap, never a Pi reporter bootstrap. */
  readonly bootstrap: NativeHookBootstrap;
  /** Idempotent invalidation: later deliveries get no callback and no queue/retry. */
  release: () => void;
}

export type StatusActivityRefreshStatus = "complete" | "unavailable" | "stale" | "unsupported" | "busy" | "timeout" | "disconnected";

/** Observed outcome of one host-requested activity census; never a token or snapshot. */
export interface StatusActivityRefreshResult {
  requestId: string;
  status: StatusActivityRefreshStatus;
}

/** Native session tuple expected before a persisted rename. */
export interface StatusRenameRequest {
  expectedSessionId: string;
  expectedSessionEpoch: number;
  /** Complete persisted input, <= 1024 UTF-8 bytes; it is never clipped. */
  name: string;
}

export type StatusRenameStatus =
  | "renamed"
  | "stale-session"
  | "unavailable"
  | "invalid-name"
  | "setter-failed"
  | "verification-failed"
  | "busy"
  | "timeout"
  | "disconnected"
  | "invalid-request";

/** No capability token or requested name is exposed in this observed result. */
export interface StatusRenameResult {
  requestId: string;
  status: StatusRenameStatus;
  expectedSessionId?: string;
  expectedSessionEpoch?: number;
  observedSessionId: string | null;
  observedSessionEpoch: number | null;
}

export type StatusShutdownStatus = "requested" | "rejected" | "not-idle" | "unavailable" | "busy" | "timeout" | "disconnected";

/** No capability token, conversation content, tool data, or prompt-derived name is exposed. */
export interface StatusShutdownResult {
  requestId: string;
  status: StatusShutdownStatus;
}

/** The broker facade consumed by the future session-host manager. */
export interface StatusBroker {
  /** Broker-owned local IPC address (POSIX Unix socket or Windows named pipe; already bound). */
  readonly socketPath: string;
  /** Random host generation marker shared by every registration. */
  readonly generation: string;
  /** Registers one instance; duplicate active ids fail before any token is overwritten. */
  register(
    instanceId: string,
    handlers: StatusBrokerStatusHandlers,
    options?: StatusRegistrationOptions,
  ): StatusRegistration;
  /** Idempotent final cleanup: timers, sockets, own socket file, and own empty directory. */
  dispose(): Promise<void>;
}

/**
 * Broker facade including the separate native hook family. The production
 * broker returned by {@link createStatusBroker} always implements this; the
 * narrower {@link StatusBroker} type stays source-compatible with existing Pi
 * registration-only fakes and call sites.
 */
export interface NativeHookStatusBroker extends StatusBroker {
  /**
   * Registers one native hook source BEFORE its corresponding provider child
   * spawns. This is a separate closed family from {@link StatusBroker.register}:
   * its token authenticates only one-shot native hook frames, it never becomes
   * a Pi reporter, and a duplicate active id in either family is refused.
   */
  registerNativeHookSource(
    instanceId: string,
    backend: NativeCliBackend,
    handlers: NativeHookSourceHandlers,
  ): NativeHookRegistration;
}

/**
 * One owned launch's native MCP lane registration. It is issued BEFORE the
 * corresponding provider CLI spawns and belongs to exactly that launch:
 * release (or broker disposal) closes the lane, aborts every in-flight
 * endpoint signal, and invalidates the bootstrap for every later hello.
 */
export interface NativeMcpRegistration {
  /** Separate native-MCP-family bootstrap; never a Pi or hook bootstrap. */
  readonly bootstrap: NativeMcpBootstrap;
  /** Idempotent revocation: no later endpoint call, queue, replay, or retry. */
  release: () => void;
  /**
   * #682: broker-owned evidence of this registration's ONE authenticated relay
   * connection. It answers an opaque frozen object unique to that connection
   * while it is authenticated and open, and `undefined` before the first
   * hello, after the connection closed, and after release. Because a
   * registration admits exactly one authenticated connection for its whole
   * lifetime and never re-admits, the same object at two moments proves the
   * same live connection spanned both. It carries no token or connection
   * data. Optional so an existing registration shape stays valid; the broker
   * always supplies it, and an owner must treat its absence as no evidence.
   */
  readonly liveConnection?: () => object | undefined;
}

/** Broker facade including the separate native MCP tool lane. */
export interface NativeMcpStatusBroker extends NativeHookStatusBroker {
  /**
   * Registers one native MCP source BEFORE its provider CLI spawns. Its token
   * authenticates only `native_mcp_hello`; it is refused beside an active Pi
   * registration or another active native MCP source for the same id, and may
   * coexist with that row's native hook source. The endpoint is the trusted
   * owner delegate: the broker frames and bounds traffic but never decides
   * which tools exist or whether a call is authorized.
   */
  registerNativeMcpSource(
    instanceId: string,
    backend: NativeCliBackend,
    endpoint: NativeMcpToolEndpoint,
  ): NativeMcpRegistration;
}

/**
 * The one callback bound to a native review source. The broker calls it only
 * after this exact registration authenticated the request line, exactly once
 * per admitted request, and never for a refused or over-cap request.
 */
export interface NativeReviewSourceHandlers {
  /**
   * Produce the review verdict for one authenticated turn boundary. It receives
   * only the closed, sanitized {@link NativeReviewRequest}. Bounded provider
   * prompt text is allowed only on UserPromptSubmit; the callback never receives
   * a token, generation, transcript path, or tool payload. It also receives an
   * AbortSignal that fires when the provider hook's socket closes first (the
   * provider killed the hook, or the row was released). A rejection, a throw,
   * or a malformed verdict is contained as the closed `failed` answer; it never
   * crashes the broker and never becomes a block.
   */
  onReviewRequest: (request: NativeReviewRequest, signal: AbortSignal) => Promise<NativeReviewVerdict>;
}

/**
 * One owned launch's native review registration. It is issued BEFORE the
 * provider child that runs the hook spawns and belongs to exactly that launch:
 * release (or broker disposal) aborts every in-flight handler signal, destroys
 * the held sockets, and invalidates the bootstrap for every later request.
 */
export interface NativeReviewRegistration {
  /** Separate native-review-family bootstrap; never a Pi, hook, or MCP bootstrap. */
  readonly bootstrap: NativeReviewBootstrap;
  /** Idempotent revocation: no later endpoint call, queue, replay, or retry. */
  release: () => void;
}

/**
 * Broker facade including the separate blocking native review lane. The
 * production broker returned by {@link createStatusBroker} always implements it;
 * the narrower facades above stay source-compatible with existing fakes and
 * call sites that only register Pi, hook, or MCP sources.
 */
export interface NativeReviewStatusBroker extends NativeMcpStatusBroker {
  /**
   * Registers one native review source BEFORE its provider child spawns. This
   * is a separate closed family: its token authenticates only
   * `native_review_request`, it never becomes a Pi reporter, an observer hook
   * delivery, or an MCP lane, and a duplicate active id in ANY family is
   * refused — so one row's observer token can never be mistaken for verdict
   * authority, and vice versa.
   */
  registerNativeReviewSource(
    instanceId: string,
    backend: NativeCliBackend,
    handlers: NativeReviewSourceHandlers,
  ): NativeReviewRegistration;
}

/** Maximum unauthenticated connections held in parallel (beyond the registered active connections). */
const MAX_PENDING_UNAUTH_CONNECTIONS = 32;

/** Short authentication deadline; later a connection without a valid hello is closed. */
const AUTH_DEADLINE_MS = 2000;
const RENAME_TIMEOUT_MS = 5000;
const SHUTDOWN_TIMEOUT_MS = 5000;
const ACTIVITY_TIMEOUT_MS = 5000;
const SPAWN_TIMEOUT_MS = 60_000;
/** Broker-side deadline for one discovery answer; below the reporter's own caller deadline. */
const HOSTS_TIMEOUT_MS = 5000;
const WINDOWS_PIPE_LISTEN_TIMEOUT_MS = 5000;
const WINDOWS_PIPE_CLOSE_TIMEOUT_MS = 5000;
const MAX_PENDING_RENAMES = 4;
const MAX_PENDING_SHUTDOWNS = 1;
const MAX_PENDING_SPAWNS = 2;
const MAX_PENDING_HOSTS_REQUESTS = 2;
const MAX_COMPLETED_HOSTS_REQUEST_IDS = 64;
const MAX_PENDING_CONTROL_FRAMES = 4;
const MAX_COMPLETED_RENAME_IDS = 64;
const MAX_COMPLETED_SHUTDOWN_IDS = 64;
const MAX_COMPLETED_SPAWN_IDS = 64;
const MAX_COMPLETED_ACTIVITY_IDS = 64;

/**
 * Per-source simultaneous authenticated native hook deliveries. Native hooks
 * may overlap inside one launch, but each one-shot delivery occupies a bounded
 * authenticated slot until its acknowledgement close.
 */
const MAX_NATIVE_HOOK_DELIVERIES_PER_SOURCE = 8;

/**
 * Broker-wide simultaneous authenticated native hook deliveries. The existing
 * shared pre-auth listener pool (32 pending, 2s auth deadline) is unchanged and
 * honestly shared by both families; this separate bound is applied only AFTER
 * a native source authenticates.
 */
const MAX_NATIVE_HOOK_DELIVERIES = 32;

/** Bound on an authenticated native one-shot socket lingering after its ACK. */
const NATIVE_HOOK_CLOSE_TIMEOUT_MS = 2000;

/**
 * Separate bound for authenticated native deliveries refused by post-auth
 * admission. Each refused socket remains counted only until its fixed ACK is
 * flushed and the socket is destroyed; the cap prevents a half-open client
 * that never sends FIN from retaining connections outside both admission pools.
 */
const MAX_NATIVE_HOOK_REFUSED_CONNECTIONS = 8;
const NATIVE_HOOK_REFUSED_CLOSE_TIMEOUT_MS = 250;

/**
 * Broker-wide authenticated native MCP requests in flight, across every lane.
 * Applied only after authentication and beside the per-connection bound.
 */
const MAX_NATIVE_MCP_IN_FLIGHT = 32;

/**
 * Unflushed response bytes one native MCP connection may hold. A relay that
 * stops reading is closed (aborting its in-flight work) instead of growing
 * broker memory without bound.
 */
const MAX_NATIVE_MCP_PENDING_OUTBOUND_BYTES = 2 * MAX_NATIVE_MCP_RESPONSE_FRAME_BYTES;

/**
 * Per-source simultaneous held native review requests. A row can only have one
 * turn in flight in practice, but a provider may overlap a `Stop` with a queued
 * `UserPromptSubmit`; this bound admits that much and refuses anything wider as
 * `busy` instead of letting one row occupy the whole lane.
 */
const MAX_NATIVE_REVIEW_REQUESTS_PER_SOURCE = 2;

/**
 * Broker-wide held native review requests, across every row. Each held request
 * is an in-flight host callback, so this is the lane's real concurrency bound:
 * a host that cannot answer this many turns at once answers `busy` (and the
 * relay tells the user the turn was not reviewed) rather than queueing verdicts
 * behind each other past the provider's own hook timeout.
 */
const MAX_NATIVE_REVIEW_REQUESTS = 8;

/**
 * The shared pre-auth raw-frame bound. It is the widest admitted FIRST frame of
 * any family: the native review lane authenticates inside its single request
 * line, which legitimately carries a bounded assistant message, so it is wider
 * than the Pi/hook/MCP-hello bound. Every family's own strict decoder still
 * refuses anything above its own (much smaller) bound, so this only sizes the
 * bounded pre-auth buffer — it never widens what any family can authenticate.
 */
/**
 * The byte bound on ONE still-incomplete request line of every LEGACY family
 * (Pi, observer hook, native MCP) before it authenticates. Exported so a test can
 * pin that the native review family's larger line bound never becomes a
 * general-purpose larger frame allowance. See
 * {@link LocalStatusBroker.#requestLineBoundBytes}.
 */
export const MAX_PRE_AUTH_FRAME_BYTES = MAX_STATUS_FRAME_BYTES;

/**
 * Conservative cap on a POSIX broker socket path in UTF-8 bytes. macOS
 * Unix-socket addressing (sun_path 104 bytes including the terminating NUL)
 * only fits ~100 real path characters even though Linux allows 107; the
 * protocol's 2048-character bootstrap bound is never treated as an actual
 * socket limit here, and over-long roots fail with a clear diagnostic instead.
 */
const MAX_SOCKET_PATH_BYTES = 103;

/** Private temp directory name prefix for the broker transport (kept short: macOS sun_path is tiny). */
const TRANSPORT_DIR_PREFIX = "prg-st-";

/** Own socket filename inside the private transport directory (short: macOS sun_path is tiny). */
const SOCKET_FILENAME = "s.sock";

/** Per-registration private payload namespace beneath the broker's private parent. */
const PAYLOAD_DIR_PREFIX = "pl-";

/** Cryptorandom namespace for one public-Node Windows local named pipe. */
const WINDOWS_PIPE_PREFIX = "\\\\.\\pipe\\prg-st-";

/**
 * Fixture token used ONLY to reuse the shared bootstrap validator's id
 * (and other shape) checks; it never authenticates or leaves the process.
 */
const ID_VALIDATION_FIXTURE_TOKEN = "0".repeat(64);

/** A single registered instance's durable broker-side state. */
interface RegistrationRecord {
  instanceId: string;
  token: string;
  released: boolean;
  /** Last accepted status sequence (0 = none yet); strictly monotonic, retained across reconnects. */
  lastSequence: number;
  latestNativeSession: SessionHostNativeSession | null;
  pendingRenames: Map<string, PendingRename>;
  completedRenameIds: Set<string>;
  pendingShutdowns: Map<string, PendingShutdown>;
  completedShutdownIds: Set<string>;
  pendingSpawns: Map<string, PendingSpawn>;
  completedSpawns: Map<string, CompletedSpawn>;
  /** In-flight read-only discovery requests, keyed by request id. */
  pendingHosts: Map<string, PendingHostsRequest>;
  /** Bounded recently answered request ids; a reused id is a protocol violation. */
  completedHostsRequestIds: Set<string>;
  pendingActivity: PendingActivity | undefined;
  /** One bounded follow-up is admitted when a caller coalesces onto an in-flight request. */
  activityFollowUp: boolean;
  /** True only when the authenticated peer advertised the additive capability. */
  activityCensusSupported: boolean;
  /** Bounded completed requests retained only to validate a later complete reply. */
  completedActivityRequests: Map<string, Pick<SessionHostActivityRequest, "afterSequence" | "expectedSessionId" | "expectedSessionEpoch">>;
  shutdownResult: Promise<StatusShutdownResult> | undefined;
  active: ConnectionState | undefined;
  handlers: StatusBrokerStatusHandlers;
  /** Private namespace created by this broker for exactly this registration. */
  payloadDir: string;
  payloadDirIdentity: SessionHostPayloadDirectoryIdentity;
}

/** A single native hook source's broker-side state; separate from every Pi registration record. */
interface NativeHookSourceRecord {
  readonly instanceId: string;
  readonly backend: NativeCliBackend;
  readonly token: string;
  released: boolean;
  handlers: NativeHookSourceHandlers;
  /**
   * #682: the optional inbox announcement owner, read and validated exactly once
   * at registration. Delivery dispatches only to this stored function, so a
   * later change to the caller's handlers object cannot redirect a candidate.
   */
  readonly claudeInboxAnnouncementOwner: ((candidate: ClaudeInboxAnnouncementCandidate) => void) | undefined;
  /** Active one-shot deliveries counted until their acknowledgement closes. */
  activeDeliveries: number;
}

/** A single native MCP source's broker-side state; separate from every Pi and hook record. */
interface NativeMcpSourceRecord {
  readonly instanceId: string;
  readonly backend: NativeCliBackend;
  readonly token: string;
  readonly endpoint: NativeMcpToolEndpoint;
  released: boolean;
  /** The one authenticated connection, while it is open. */
  active: ConnectionState | undefined;
  /** True once an authenticated connection existed: the lane is never re-admitted. */
  spent: boolean;
}

/**
 * A single native review source's broker-side state; separate from every Pi,
 * hook, and MCP record. It owns its own token and its own in-flight count, so
 * releasing one family never touches another row's lane.
 */
interface NativeReviewSourceRecord {
  readonly instanceId: string;
  readonly backend: NativeCliBackend;
  readonly token: string;
  /** Read once at registration: dispatch goes only to this stored function. */
  readonly onReviewRequest: (request: NativeReviewRequest, signal: AbortSignal) => Promise<NativeReviewVerdict>;
  released: boolean;
  /** Held requests counted against this source's own bound. */
  activeRequests: number;
}

/** Post-authentication state of one held native review connection. */
interface NativeReviewConnectionState {
  readonly record: NativeReviewSourceRecord;
  /** Aborted when the socket closes WHILE the host is still reviewing. */
  readonly controller: AbortController;
  /** True once this connection's single answer frame was written (or skipped). */
  answered: boolean;
  /** True while this request occupies a counted in-flight slot. */
  slotted: boolean;
  /**
   * True once the host's promise has settled, whatever it settled to. From that
   * point on the socket is only carrying a reply, so closing it is never a
   * cancellation and must not abort the host's signal.
   */
  handlerSettled: boolean;
  /**
   * True once this connection's close has been observed. An admitted slot is held
   * until BOTH the host settled and the socket closed, so a peer that never reads
   * its verdict keeps counting against this family's own bound instead of
   * accumulating unread replies and descriptors outside every limit.
   */
  closed: boolean;
}

interface NativeMcpInFlight {
  readonly controller: AbortController;
  cancelled: boolean;
  /**
   * True once this entry's broker-wide slot was returned. That happens only
   * when the endpoint promise settles: closing a lane aborts the signal but
   * cannot prove the owner stopped, so the slot stays counted until then.
   */
  slotReleased: boolean;
}

/** Post-authentication state of one native MCP connection. */
interface NativeMcpConnectionState {
  readonly record: NativeMcpSourceRecord;
  readonly reader: NativeMcpFrameReader;
  /** Highest accepted request seq; a request must exceed it. */
  lastSeq: number;
  readonly inFlight: Map<number, NativeMcpInFlight>;
  closed: boolean;
  /** Opaque identity of this authenticated connection (#682); never wire data. */
  readonly identity: object;
}

interface PendingRename {
  connection: ConnectionState;
  request: SessionHostRenameRequest;
  timer: NodeJS.Timeout;
  resolve: (result: StatusRenameResult) => void;
}

interface PendingShutdown {
  connection: ConnectionState;
  request: SessionHostShutdownRequest;
  timer: NodeJS.Timeout;
  resolve: (result: StatusShutdownResult) => void;
}

interface PendingSpawn {
  readonly requestId: string;
  readonly fingerprint: string;
  readonly payload: SessionHostPayloadRef;
  connection: ConnectionState;
  timer: NodeJS.Timeout;
  /** True once the exact payload was verified and consumed by a successful read. */
  consumed: boolean;
}

interface PendingHostsRequest {
  readonly requestId: string;
  readonly connection: ConnectionState;
  readonly controller: AbortController;
  readonly timer: NodeJS.Timeout;
}

interface PendingActivity {
  connection: ConnectionState;
  request: SessionHostActivityRequest;
  timer: NodeJS.Timeout;
  promise: Promise<StatusActivityRefreshResult>;
  resolve: (result: StatusActivityRefreshResult) => void;
}

interface CompletedSpawn {
  readonly fingerprint: string;
  readonly outcome: SessionSpawnOutcome;
}

/** Per-socket connection state machine (awaiting hello -> active -> closed). */
interface ConnectionState {
  socket: Socket;
  /** Partial UTF-8 bytes of the next frame, strictly bounded below the frame cap. */
  buffered: Buffer;
  authed: boolean;
  /** True when replaced, released, or disposed: every callback is ignored. */
  superseded: boolean;
  destroyed: boolean;
  authTimer: NodeJS.Timeout | undefined;
  /** Set only after an authenticated hello binds the connection to its registration. */
  registration: RegistrationRecord | undefined;
  /** True while counted against the unauthenticated backlog bound. */
  pending: boolean;
  /** True once this connection's one native frame has been considered; never a second callback. */
  nativeHandled: boolean;
  /** Set only after a native frame authenticates; never a Pi registration/active connection. */
  native: NativeHookSourceRecord | undefined;
  /** True while this connection occupies an authenticated native delivery slot. */
  nativeSlotted: boolean;
  /** True while this authenticated native connection is a counted admission refusal. */
  nativeRefused: boolean;
  nativeCloseTimer: NodeJS.Timeout | undefined;
  /** Set only after a native MCP hello authenticates; never a Pi registration or hook delivery. */
  mcp: NativeMcpConnectionState | undefined;
  /**
   * Set only after a native review request line authenticates; never a Pi
   * registration, hook delivery, or MCP lane. While it is set the socket is
   * HELD open awaiting the host's single answer frame.
   */
  review: NativeReviewConnectionState | undefined;
  /** At most four bounded rename/shutdown control frames are coalesced per socket write turn. */
  renameWriteQueue: string[];
  renameWriteScheduled: boolean;
}

/**
 * Strict parse of {@link StatusRegistrationOptions}. Absence and an explicit
 * false both mean the legacy bootstrap; anything but a closed boolean request
 * fails closed before the broker creates any state.
 */
function parseRegistrationOptions(options: StatusRegistrationOptions | undefined): boolean {
  if (options === undefined) return false;
  if (typeof options !== "object" || options === null || Array.isArray(options)) {
    throw new Error("pi-review-gate: the session-host registration options must be a plain object or absent");
  }
  const keys = Object.keys(options);
  if (keys.length > 1 || (keys.length === 1 && keys[0] !== "inputOriginFraming")) {
    throw new Error("pi-review-gate: the session-host registration options accept only inputOriginFraming");
  }
  const requested: unknown = (options as { readonly inputOriginFraming?: unknown }).inputOriginFraming;
  if (requested !== undefined && typeof requested !== "boolean") {
    throw new Error("pi-review-gate: the session-host inputOriginFraming registration option must be a boolean");
  }
  return requested === true;
}

/** Verifies two strings are equal without content-dependent timing. */
function timingSafeTextEqual(left: string, right: string): boolean {
  return timingSafeEqual(
    createHash("sha256").update(left, "utf8").digest(),
    createHash("sha256").update(right, "utf8").digest(),
  );
}

/** Aborts an endpoint signal, containing any synchronous throw at the broker boundary. */
function abortQuietly(controller: AbortController): void {
  try {
    controller.abort();
  } catch {
    // Contained: owner abort handling never affects the transport.
  }
}

function isSpawnOutcome(value: unknown): value is SessionSpawnOutcome {
  return value === "started" || value === "failed" || value === "unknown";
}

type RenameAckClassification = "matching" | "stale-session" | "invalid";

/** Shared production/test predicate for response identity, request tuple, and current-session fencing. */
function classifyRenameAck(
  ack: SessionHostRenameAck,
  expected: Pick<SessionHostRenameRequest, "requestId" | "expectedSessionId" | "expectedSessionEpoch">,
  instanceId: string,
  generation: string,
  latestNativeSession: SessionHostNativeSession | null,
): RenameAckClassification {
  if (!timingSafeTextEqual(ack.instanceId, instanceId)
    || !timingSafeTextEqual(ack.generation, generation)
    || ack.requestId !== expected.requestId
    || ack.expectedSessionId !== expected.expectedSessionId
    || ack.expectedSessionEpoch !== expected.expectedSessionEpoch) return "invalid";
  if (ack.outcome === "renamed"
    && (!latestNativeSession
      || latestNativeSession.sessionId !== ack.expectedSessionId
      || latestNativeSession.epoch !== ack.expectedSessionEpoch)) return "stale-session";
  return "matching";
}

type ShutdownAckClassification = "matching" | "stale-session" | "invalid";

function classifyShutdownAck(
  ack: SessionHostShutdownAck,
  expected: Pick<SessionHostShutdownRequest, "requestId" | "expectedSessionId" | "expectedSessionEpoch">,
  instanceId: string,
  generation: string,
  latestNativeSession: SessionHostNativeSession | null,
): ShutdownAckClassification {
  if (!timingSafeTextEqual(ack.instanceId, instanceId)
    || !timingSafeTextEqual(ack.generation, generation)
    || ack.requestId !== expected.requestId
    || ack.expectedSessionId !== expected.expectedSessionId
    || ack.expectedSessionEpoch !== expected.expectedSessionEpoch) return "invalid";
  if (ack.outcome === "requested"
    && (!latestNativeSession
      || latestNativeSession.sessionId !== ack.expectedSessionId
      || latestNativeSession.epoch !== ack.expectedSessionEpoch)) return "stale-session";
  return "matching";
}

type ActivityResultClassification = "complete" | "unavailable" | "stale" | "invalid";

/**
 * Shared production/test predicate for activity-result identity, request
 * correlation, native tuple fencing, and monotonic sequence advancement.
 */
function classifyActivityResult(
  result: SessionHostActivityResult,
  expected: SessionHostActivityRequest,
  instanceId: string,
  generation: string,
  lastSequence: number,
): ActivityResultClassification {
  if (!timingSafeTextEqual(result.instanceId, instanceId)
    || !timingSafeTextEqual(result.generation, generation)
    || result.requestId !== expected.requestId) return "invalid";
  if (result.outcome === "unavailable") return "unavailable";
  if (result.outcome === "stale-session") return "stale";
  const status = result.status;
  if (!status) return "invalid";
  // A complete result must be a genuinely newer observation than both the
  // sequence the request was issued at and anything already accepted. A valid
  // concurrent status that already advanced the registration makes this reply
  // stale rather than a protocol failure.
  if (status.sequence <= expected.afterSequence || status.sequence <= lastSequence) return "stale";
  // When the host had a known native tuple, a complete reply must still be
  // about that exact session. A client that moved to another conversation
  // returns stale-session/unavailable instead, never a replaceable snapshot.
  if (expected.expectedSessionId !== null) {
    if (result.observedSessionId !== expected.expectedSessionId
      || result.observedSessionEpoch !== expected.expectedSessionEpoch) return "stale";
    const statusSessionId = status.nativeSession?.sessionId ?? null;
    const statusSessionEpoch = status.nativeSession?.epoch ?? null;
    if (statusSessionId !== expected.expectedSessionId
      || statusSessionEpoch !== expected.expectedSessionEpoch) return "stale";
  }
  return "complete";
}

/** Test-only override allows root-bound fixtures to express the same local path relatively. */
let socketPathLimitForTests: number | undefined;
let brokerPlatformForTests: NodeJS.Platform | undefined;
let createServerForTests: (() => Server) | undefined;
let windowsPipeListenTimeoutForTests: number | undefined;
let windowsPipeCloseTimeoutForTests: number | undefined;
let spawnTimeoutMsForTests: number | undefined;
let hostsTimeoutMsForTests: number | undefined;
let activityTimeoutMsForTests: number | undefined;
let nativeHookDeliveryLimitForTests: number | undefined;
let nativeMcpInFlightLimitForTests: number | undefined;
let nativeReviewInFlightLimitForTests: number | undefined;

/** Narrow seams for protocol policy tests and root-bound socket fixtures. */
export const __test = Object.freeze({
  classifyRenameAck,
  classifyShutdownAck,
  classifyActivityResult,
  setSocketPathLimitForTests(limit: number | undefined): void {
    socketPathLimitForTests = limit;
  },
  setPlatformForTests(platform: NodeJS.Platform | undefined): void {
    brokerPlatformForTests = platform;
  },
  setCreateServerForTests(factory: (() => Server) | undefined): void {
    createServerForTests = factory;
  },
  setWindowsPipeTimeoutsForTests(listenMs: number | undefined, closeMs: number | undefined): void {
    windowsPipeListenTimeoutForTests = listenMs;
    windowsPipeCloseTimeoutForTests = closeMs;
  },
  setSpawnTimeoutForTests(timeoutMs: number | undefined): void {
    spawnTimeoutMsForTests = timeoutMs;
  },
  setHostsTimeoutForTests(timeoutMs: number | undefined): void {
    hostsTimeoutMsForTests = timeoutMs;
  },
  setActivityTimeoutForTests(timeoutMs: number | undefined): void {
    activityTimeoutMsForTests = timeoutMs;
  },
  /** Focused native-lane admission test seam; absence keeps the production bound. */
  setNativeHookDeliveryLimitForTests(limit: number | undefined): void {
    nativeHookDeliveryLimitForTests = limit;
  },
  /** Focused native MCP broker-wide in-flight bound; absence keeps the production bound. */
  setNativeMcpInFlightLimitForTests(limit: number | undefined): void {
    nativeMcpInFlightLimitForTests = limit;
  },
  /** Focused native review broker-wide in-flight bound; absence keeps the production bound. */
  setNativeReviewInFlightLimitForTests(limit: number | undefined): void {
    nativeReviewInFlightLimitForTests = limit;
  },
});

type BrokerTransport =
  | { kind: "unix"; socketPath: string; transportDir: string; transportIdentity: OwnedPathIdentity }
  | { kind: "pipe"; socketPath: string };

/**
 * Canonicalizes the optional socket root: it must be an absolute, existing,
 * real directory. No creation, no adoption, no fallback ambiguity.
 */
function canonicalSocketRoot(socketRoot: string): string {
  if (!isAbsolute(socketRoot)) {
    throw new Error(
      `pi-review-gate: the session-host status socket root must be an absolute path: ${socketRoot}`,
    );
  }
  let stats;
  try {
    stats = statSync(socketRoot);
  } catch (error) {
    throw new Error(
      `pi-review-gate: the session-host status socket root must already exist as a directory: ${socketRoot} (${error instanceof Error ? error.message : String(error)})`,
    );
  }
  if (!stats.isDirectory()) {
    throw new Error(
      `pi-review-gate: the session-host status socket root must be a directory: ${socketRoot}`,
    );
  }
  return realpathSync(socketRoot);
}

interface OwnedPathIdentity {
  dev: number;
  ino: number;
}

interface QuarantinedSocketPath {
  path: string;
  directory: string;
  directoryIdentity: OwnedPathIdentity;
  identity: OwnedPathIdentity;
  ownedSocket: boolean;
  directoryEntry: boolean;
}

interface SocketPathTeardown {
  guardIdentity: OwnedPathIdentity | undefined;
  quarantined: QuarantinedSocketPath[];
}

/** Best-effort removal of the exact socket inode created by this broker. */
function removeOwnSocketFile(socketPath: string, identity: OwnedPathIdentity | undefined): void {
  if (!identity) return;
  try {
    const stats = lstatSync(socketPath);
    if (stats.isSocket() && stats.dev === identity.dev && stats.ino === identity.ino) {
      unlinkSync(socketPath);
    }
  } catch {
    // Already absent (or raced): the cleanup goal is already satisfied.
  }
}

/** Removes this broker's exact directory inode only when empty. */
function removeOwnEmptyDirectory(dir: string, identity: OwnedPathIdentity): void {
  try {
    const stats = lstatSync(dir);
    if (stats.isDirectory() && stats.dev === identity.dev && stats.ino === identity.ino) {
      rmdirSync(dir);
    }
  } catch {
    // ENOTEMPTY, a replacement, or an already absent directory stays untouched.
  }
}

interface OwnedPayloadNamespace {
  readonly path: string;
  readonly identity: SessionHostPayloadDirectoryIdentity;
}

/** Payload namespace cleanup uses the same exact identities as reads and startup handoff. */
function removeOwnEmptyPayloadDirectory(dir: string, identity: SessionHostPayloadDirectoryIdentity): void {
  try {
    const stats = lstatSync(dir, { bigint: true });
    if (stats.isDirectory() && !stats.isSymbolicLink()
      && stats.dev.toString() === identity.dev && stats.ino.toString() === identity.ino) {
      rmdirSync(dir);
    }
  } catch {
    // A changed, nonempty, unsafe, or missing namespace is never removed.
  }
}

/**
 * Creates one fresh private payload namespace beneath a canonical private
 * parent. POSIX re-asserts mode 0700; Windows uses the OS temp directory and
 * the existing default-ACL caveat (no custom ACL claim).
 */
function createOwnedPayloadNamespace(parent: string): OwnedPayloadNamespace {
  let created: string | undefined;
  let identity: SessionHostPayloadDirectoryIdentity | undefined;
  try {
    created = mkdtempSync(join(realpathSync(parent), PAYLOAD_DIR_PREFIX));
    const stats = lstatSync(created, { bigint: true });
    if (!stats.isDirectory()) throw new Error("payload namespace is not a directory");
    identity = encodeSessionHostPayloadDirectoryIdentity(stats);
    chmodSync(created, 0o700);
    return { path: created, identity };
  } catch (error) {
    if (created !== undefined && identity !== undefined) removeOwnEmptyPayloadDirectory(created, identity);
    throw error;
  }
}

class LocalStatusBroker implements NativeReviewStatusBroker {

  readonly socketPath: string;
  readonly generation: string;

  #transport: BrokerTransport;
  #socketIdentity: OwnedPathIdentity | undefined;
  #server: Server | undefined;
  #listenSucceeded = false;
  #listenHandleClosed = false;
  #latePipeCloseStarted = false;
  #registrations = new Map<string, RegistrationRecord>();
  #nativeSources = new Map<string, NativeHookSourceRecord>();
  #nativeDeliveries = 0;
  #nativeRefusedConnections = 0;
  #nativeMcpSources = new Map<string, NativeMcpSourceRecord>();
  #nativeMcpInFlight = 0;
  #nativeReviewSources = new Map<string, NativeReviewSourceRecord>();
  #nativeReviewInFlight = 0;
  #connections = new Set<ConnectionState>();
  #payloadCleanups = new Set<Promise<void>>();
  #unauthCount = 0;
  #disposed = false;
  #disposal: Promise<void> | undefined;

  constructor(transport: BrokerTransport) {
    this.#transport = transport;
    this.socketPath = transport.socketPath;
    this.generation = randomUUID();
  }

  /** Binds the endpoint; POSIX resolves after private socket permissions are verified. */
  async listen(): Promise<void> {
    const server = createServerForTests?.() ?? createServer();
    this.#server = server;
    // A persistent error handler keeps server/listen failures controlled:
    // status-metadata failures must never affect the native PTY processes.
    server.on("error", () => {
      // Controlled: surfaced through listen/promise paths only, never thrown
      // into the native process, and nothing about it is logged.
    });
    server.on("close", () => {
      this.#listenHandleClosed = true;
    });
    if (this.#transport.kind === "pipe") {
      // Install the owner before listening so a late success after the bounded
      // listen deadline can be closed without admitting untracked clients.
      server.on("connection", (socket) => this.#trackConnection(socket));
      await this.#listenWindowsPipe(server);
      return;
    }
    await new Promise<void>((resolve, reject) => {
      const onceError = (error: NodeJS.ErrnoException) => {
        reject(new Error(`pi-review-gate: the session-host status broker could not listen (code ${error.code ?? "unknown"})`));
      };
      server.once("error", onceError);
      server.listen(this.socketPath, () => {
        server.off("error", onceError);
        try {
          // The fresh private directory must contain only our socket; a
          // pre-existing entry at this path is an anomaly and is never adopted
          // or unlinked.
          const stats = lstatSync(this.socketPath);
          if (!stats.isSocket()) {
            throw new Error(
              "pi-review-gate: the session-host status broker did not create its own stream socket",
            );
          }
          this.#socketIdentity = { dev: stats.dev, ino: stats.ino };
          chmodSync(this.socketPath, 0o600);
          this.#listenSucceeded = true;
          resolve();
        } catch (error) {
          reject(
            error instanceof Error
              ? error
              : new Error("pi-review-gate: the session-host status broker socket could not be prepared"),
          );
        }
      });
    });
    server.on("connection", (socket) => this.#trackConnection(socket));
  }

  /** Bounded Windows listen; a late success is closed through this server handle only. */
  async #listenWindowsPipe(server: Server): Promise<void> {
    const timeoutMs = windowsPipeListenTimeoutForTests ?? WINDOWS_PIPE_LISTEN_TIMEOUT_MS;
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      let timer: NodeJS.Timeout;
      const settleError = (error: NodeJS.ErrnoException) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        server.off("error", onceError);
        reject(new Error(
          `pi-review-gate: the session-host named-pipe broker could not listen (code ${error.code ?? "unknown"})`,
        ));
      };
      const onceError = (error: NodeJS.ErrnoException) => settleError(error);
      timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        server.off("error", onceError);
        if (server.listening) this.#closeLatePipeListenHandle(server);
        reject(new Error(
          `pi-review-gate: the session-host named-pipe broker listen timed out after ${timeoutMs}ms`,
        ));
      }, timeoutMs);
      server.once("error", onceError);
      try {
        server.listen(this.socketPath, () => {
          server.off("error", onceError);
          if (settled) {
            if (!this.#listenSucceeded) this.#closeLatePipeListenHandle(server);
            return;
          }
          settled = true;
          clearTimeout(timer);
          this.#listenSucceeded = true;
          resolve();
        });
      } catch (error) {
        settleError(error instanceof Error ? error as NodeJS.ErrnoException : new Error("listen failed"));
      }
    });
  }

  /** Best-effort bounded close for a listen callback that arrived after its caller timed out. */
  #closeLatePipeListenHandle(server: Server): void {
    if (this.#latePipeCloseStarted || this.#listenHandleClosed) return;
    this.#latePipeCloseStarted = true;
    const timeoutMs = windowsPipeCloseTimeoutForTests ?? WINDOWS_PIPE_CLOSE_TIMEOUT_MS;
    let settled = false;
    const timer = setTimeout(() => { settled = true; }, timeoutMs);
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (!error) this.#listenHandleClosed = true;
    };
    try {
      server.close(finish);
    } catch (error) {
      finish(error instanceof Error ? error : new Error("close failed"));
    }
  }

  register(
    instanceId: string,
    handlers: StatusBrokerStatusHandlers,
    options?: StatusRegistrationOptions,
  ): StatusRegistration {
    if (this.#disposed) {
      throw new Error("pi-review-gate: the session-host status broker is disposed; no further registrations are accepted");
    }
    if (typeof handlers?.onStatus !== "function" || typeof handlers?.onDisconnect !== "function") {
      throw new Error("pi-review-gate: the session-host registration requires onStatus and onDisconnect callbacks");
    }
    // Refuse a malformed mode request before any token, namespace, or map entry
    // exists: an unknown option shape never half-registers a row.
    const inputOriginFraming = parseRegistrationOptions(options);
    // Reuse the shared bootstrap validator to enforce the admitted instance-id
    // (and bootstrap) shape; the fixture token/generation exist only for that
    // shape check and never authenticate anything.
    const shape = parseBootstrap({
      version: PROTOCOL_VERSION,
      socketPath: this.socketPath,
      token: ID_VALIDATION_FIXTURE_TOKEN,
      instanceId,
      generation: this.generation,
    });
    if (shape === undefined || shape.instanceId !== instanceId) {
      throw new Error(
        `pi-review-gate: the session-host instance id is malformed (UUID-like id, at most 128 characters): ${instanceId.length <= 64 ? instanceId : `${instanceId.slice(0, 64)}…`}`,
      );
    }
    // Fail closed BEFORE any token generation: a duplicate active id must
    // never overwrite the registered instance's cryptorandom token.
    const existing = this.#registrations.get(instanceId);
    if (existing && !existing.released) {
      throw new Error(
        `pi-review-gate: an active session-host registration already exists for instance id ${instanceId}`,
      );
    }
    const existingNative = this.#nativeSources.get(instanceId);
    if (existingNative && !existingNative.released) {
      // The same row may not carry a Pi reporter and a native hook source at the
      // same time: the two families have distinct tokens and semantics, and an
      // ambiguous id would make the owning launch unclear.
      throw new Error(
        `pi-review-gate: an active native hook source already exists for instance id ${instanceId}`,
      );
    }
    const existingMcp = this.#nativeMcpSources.get(instanceId);
    if (existingMcp && !existingMcp.released) {
      // A native MCP lane belongs to a native provider launch, never to a Pi
      // reporter row with the same id.
      throw new Error(
        `pi-review-gate: an active native MCP source already exists for instance id ${instanceId}`,
      );
    }

    const token = randomBytes(32).toString("hex");
    const payloadNamespace = createOwnedPayloadNamespace(
      this.#transport.kind === "unix" ? this.#transport.transportDir : os.tmpdir(),
    );
    const record: RegistrationRecord = {
      instanceId,
      token,
      released: false,
      lastSequence: 0,
      latestNativeSession: null,
      pendingRenames: new Map(),
      completedRenameIds: new Set(),
      pendingShutdowns: new Map(),
      completedShutdownIds: new Set(),
      pendingSpawns: new Map(),
      completedSpawns: new Map(),
      pendingHosts: new Map(),
      completedHostsRequestIds: new Set(),
      pendingActivity: undefined,
      activityFollowUp: false,
      activityCensusSupported: false,
      completedActivityRequests: new Map(),
      shutdownResult: undefined,
      active: undefined,
      handlers,
      payloadDir: payloadNamespace.path,
      payloadDirIdentity: payloadNamespace.identity,
    };
    this.#registrations.set(instanceId, record);
    const bootstrap: SessionHostBootstrap = {
      version: PROTOCOL_VERSION,
      socketPath: this.socketPath,
      token,
      instanceId,
      generation: this.generation,
      payloadDir: payloadNamespace.path,
      // The closed mode marker lives only here: it is composed into the actual
      // one-shot bootstrap before any child exists, and nothing mutates this
      // object (or its token/secret fields) after validation.
      ...(inputOriginFraming ? { inputOriginFraming: INPUT_ORIGIN_FRAMING_MODE } : {}),
      // Routed-spawn support is advertised only from an actually installed
      // routed handler; a host that forwards only the legacy handler (or none)
      // keeps the legacy bootstrap, and its reporter refuses selectors locally.
      ...(typeof handlers.onRoutedSpawnRequest === "function" ? { spawnRouting: SESSION_SPAWN_ROUTING_MODE } : {}),
      // Discovery is advertised only from an actually installed discovery
      // handler on a routed-spawn registration; otherwise the child exposes no
      // SessionHosts inspection at all.
      ...(hasSessionHostsDiscoveryHandlers(handlers) ? { sessionHosts: SESSION_HOSTS_DISCOVERY_MODE } : {}),
      // Workspace-creation support is advertised only from an explicit declaration
      // beside an installed routed handler; otherwise the reporter refuses it.
      ...(hasSessionSpawnCreateWorkspaceHandlers(handlers)
        ? { spawnCreateWorkspace: SESSION_SPAWN_CREATE_WORKSPACE_MODE }
        : {}),
    };
    return {
      bootstrap,
      rename: (request) => this.#rename(record, request),
      shutdown: (options) => this.#shutdown(record, options),
      release: () => this.#releaseRegistration(record),
      requestActivity: () => this.#requestActivity(record),
    };
  }

  /**
   * Registers one native hook source before its provider child exists. This
   * family owns a separate token/record map and a separate one-shot delivery
   * path; it never creates a Pi registration, active connection, status
   * sequence, reconnect callback, or command authority. Duplicate active ids in
   * either family are refused so one launch can never have two ambiguous
   * observers.
   */
  registerNativeHookSource(
    instanceId: string,
    backend: NativeCliBackend,
    handlers: NativeHookSourceHandlers,
  ): NativeHookRegistration {
    if (this.#disposed) {
      throw new Error("pi-review-gate: the session-host status broker is disposed; no further registrations are accepted");
    }
    if (typeof handlers?.onEvent !== "function" || typeof handlers?.onFailure !== "function") {
      throw new Error("pi-review-gate: the native hook source requires onEvent and onFailure callbacks");
    }
    // Read once: the validated function is what the record keeps and dispatches to.
    const claudeInboxAnnouncementOwner: unknown = handlers.onClaudeInboxAnnouncement;
    if (claudeInboxAnnouncementOwner !== undefined && typeof claudeInboxAnnouncementOwner !== "function") {
      throw new Error("pi-review-gate: the native hook source inbox announcement callback must be a function when provided");
    }
    if (!isNativeCliBackend(backend)) {
      throw new Error("pi-review-gate: the native hook source backend must be claude or codex");
    }
    const instanceIdValue: unknown = instanceId;
    if (!isValidNativeHookInstanceId(instanceIdValue)) {
      throw new Error(
        `pi-review-gate: the native hook source instance id is malformed (UUID-like id, at most 128 characters): ${instanceId.length <= 64 ? instanceId : `${instanceId.slice(0, 64)}…`}`,
      );
    }
    const existingNative = this.#nativeSources.get(instanceId);
    if (existingNative && !existingNative.released) {
      throw new Error(
        `pi-review-gate: an active native hook source already exists for instance id ${instanceId}`,
      );
    }
    const existingPi = this.#registrations.get(instanceId);
    if (existingPi && !existingPi.released) {
      throw new Error(
        `pi-review-gate: an active session-host registration already exists for instance id ${instanceId}; a native hook source is a separate family`,
      );
    }
    const record: NativeHookSourceRecord = {
      instanceId,
      backend,
      token: randomBytes(32).toString("hex"),
      released: false,
      handlers,
      claudeInboxAnnouncementOwner: claudeInboxAnnouncementOwner as
        | ((candidate: ClaudeInboxAnnouncementCandidate) => void)
        | undefined,
      activeDeliveries: 0,
    };
    this.#nativeSources.set(instanceId, record);
    return {
      bootstrap: {
        version: 1,
        socketPath: this.socketPath,
        generation: this.generation,
        instanceId,
        backend,
        token: record.token,
      },
      release: () => this.#releaseNativeHookSource(record),
    };
  }

  /**
   * Registers one native MCP source before its provider CLI exists. The family
   * owns a separate token/record map and a separate authenticated connection
   * path; it never creates a Pi registration, hook delivery, status sequence,
   * reconnect callback, or command authority. Validation and duplicate checks
   * all run before any token is generated.
   */
  registerNativeMcpSource(
    instanceId: string,
    backend: NativeCliBackend,
    endpoint: NativeMcpToolEndpoint,
  ): NativeMcpRegistration {
    if (this.#disposed) {
      throw new Error("pi-review-gate: the session-host status broker is disposed; no further registrations are accepted");
    }
    if (typeof endpoint?.listTools !== "function" || typeof endpoint?.callTool !== "function") {
      throw new Error("pi-review-gate: the native MCP source requires a tool endpoint with listTools and callTool");
    }
    if (!isNativeCliBackend(backend)) {
      throw new Error("pi-review-gate: the native MCP source backend must be claude or codex");
    }
    const instanceIdValue: unknown = instanceId;
    if (!isValidNativeMcpInstanceId(instanceIdValue)) {
      const shown = typeof instanceIdValue === "string" ? instanceIdValue.slice(0, 64) : typeof instanceIdValue;
      throw new Error(
        `pi-review-gate: the native MCP source instance id is malformed (UUID-like id, at most 128 characters): ${shown}`,
      );
    }
    const existingMcp = this.#nativeMcpSources.get(instanceId);
    if (existingMcp && !existingMcp.released) {
      throw new Error(`pi-review-gate: an active native MCP source already exists for instance id ${instanceId}`);
    }
    const existingPi = this.#registrations.get(instanceId);
    if (existingPi && !existingPi.released) {
      throw new Error(
        `pi-review-gate: an active session-host registration already exists for instance id ${instanceId}; a native MCP source is a separate family`,
      );
    }
    const record: NativeMcpSourceRecord = {
      instanceId,
      backend,
      token: randomBytes(32).toString("hex"),
      endpoint,
      released: false,
      active: undefined,
      spent: false,
    };
    this.#nativeMcpSources.set(instanceId, record);
    return {
      bootstrap: {
        version: 1,
        type: "native_mcp_bootstrap",
        socketPath: this.socketPath,
        generation: this.generation,
        instanceId,
        backend,
        token: record.token,
      },
      release: () => this.#releaseNativeMcpSource(record),
      liveConnection: () => {
        if (record.released) return undefined;
        const active = record.active;
        const mcp = active?.mcp;
        return active === undefined || active.destroyed || mcp === undefined || mcp.closed || mcp.record !== record
          ? undefined
          : mcp.identity;
      },
    };
  }

  /**
   * Registers one native review source before the provider child that runs its
   * blocking hook exists. The family owns a separate token/record map and a
   * separate held-connection path; it never creates a Pi registration, an
   * observer hook delivery, an MCP lane, a status sequence, a reconnect
   * callback, or command authority. Like the other native families it may share
   * an instance id with a Pi row, an observer hook source, or an MCP lane — one
   * owned launch legitimately has several — because separation is the token and
   * the closed frame type, never the id. Only a second live review source for
   * the same id is refused, and all validation runs before any token is
   * generated.
   */
  registerNativeReviewSource(
    instanceId: string,
    backend: NativeCliBackend,
    handlers: NativeReviewSourceHandlers,
  ): NativeReviewRegistration {
    if (this.#disposed) {
      throw new Error("pi-review-gate: the session-host status broker is disposed; no further registrations are accepted");
    }
    // Read once: the validated function is what the record keeps and dispatches
    // to, so a later change to the caller's handlers object cannot redirect a
    // turn's verdict request.
    const onReviewRequest: unknown = handlers?.onReviewRequest;
    if (typeof onReviewRequest !== "function") {
      throw new Error("pi-review-gate: the native review source requires an onReviewRequest callback");
    }
    if (!isNativeCliBackend(backend)) {
      throw new Error("pi-review-gate: the native review source backend must be claude or codex");
    }
    const instanceIdValue: unknown = instanceId;
    if (!isValidNativeReviewInstanceId(instanceIdValue)) {
      const shown = typeof instanceIdValue === "string" ? instanceIdValue.slice(0, 64) : typeof instanceIdValue;
      throw new Error(
        `pi-review-gate: the native review source instance id is malformed (UUID-like id, at most 128 characters): ${shown}`,
      );
    }
    const existingReview = this.#nativeReviewSources.get(instanceId);
    if (existingReview && !existingReview.released) {
      throw new Error(`pi-review-gate: an active native review source already exists for instance id ${instanceId}`);
    }
    const record: NativeReviewSourceRecord = {
      instanceId,
      backend,
      token: randomBytes(32).toString("hex"),
      onReviewRequest: onReviewRequest as (request: NativeReviewRequest, signal: AbortSignal) => Promise<NativeReviewVerdict>,
      released: false,
      activeRequests: 0,
    };
    this.#nativeReviewSources.set(instanceId, record);
    return {
      bootstrap: {
        version: 1,
        socketPath: this.socketPath,
        generation: this.generation,
        instanceId,
        backend,
        token: record.token,
      },
      release: () => this.#releaseNativeReviewSource(record),
    };
  }

  /**
   * Focused test introspection only: native MCP lane occupancy. It exposes no
   * token, request, argument, or result data.
   */
  __nativeMcpLaneCountsForTests(): { readonly inFlight: number; readonly activeConnections: number; readonly sources: number } {
    let activeConnections = 0;
    for (const conn of this.#connections) {
      if (conn.mcp !== undefined && !conn.mcp.closed && !conn.destroyed) activeConnections += 1;
    }
    return { inFlight: this.#nativeMcpInFlight, activeConnections, sources: this.#nativeMcpSources.size };
  }

  /**
   * Focused test introspection only: native review lane occupancy. It exposes
   * no token, request, or verdict data.
   */
  __nativeReviewLaneCountsForTests(): {
    readonly inFlight: number;
    readonly heldConnections: number;
    readonly sources: number;
  } {
    let heldConnections = 0;
    for (const conn of this.#connections) {
      if (conn.review !== undefined && !conn.destroyed && !conn.superseded) heldConnections += 1;
    }
    return { inFlight: this.#nativeReviewInFlight, heldConnections, sources: this.#nativeReviewSources.size };
  }

  /**
   * Focused test introspection only: broker-retained native one-shot state.
   * Production callers never use this; it exposes no token, event, or source data.
   */
  __nativeHookLaneCountsForTests(): {
    readonly refused: number;
    readonly deliveries: number;
    readonly activeConnections: number;
  } {
    let activeConnections = 0;
    for (const conn of this.#connections) {
      if (conn.native !== undefined && !conn.destroyed && !conn.superseded) activeConnections += 1;
    }
    return {
      refused: this.#nativeRefusedConnections,
      deliveries: this.#nativeDeliveries,
      activeConnections,
    };
  }

  #observedTuple(record: RegistrationRecord): Pick<StatusRenameResult, "observedSessionId" | "observedSessionEpoch"> {
    return {
      observedSessionId: record.latestNativeSession?.sessionId ?? null,
      observedSessionEpoch: record.latestNativeSession?.epoch ?? null,
    };
  }

  #rename(record: RegistrationRecord, input: StatusRenameRequest): Promise<StatusRenameResult> {
    const requestId = randomUUID();
    let expectedIdValue: unknown;
    let expectedEpochValue: unknown;
    let requestedName: unknown;
    try {
      expectedIdValue = input?.expectedSessionId;
      expectedEpochValue = input?.expectedSessionEpoch;
      requestedName = input?.name;
    } catch {
      return Promise.resolve({ requestId, status: "invalid-request", ...this.#observedTuple(record) });
    }
    const expectedSessionId = isValidNativeSessionId(expectedIdValue) ? expectedIdValue : undefined;
    const expectedSessionEpoch = Number.isSafeInteger(expectedEpochValue) && (expectedEpochValue as number) > 0
      ? expectedEpochValue as number
      : undefined;
    const name = isValidRenameName(requestedName) ? requestedName : undefined;
    const result = (status: StatusRenameStatus): StatusRenameResult => ({
      requestId,
      status,
      ...(expectedSessionId === undefined ? {} : { expectedSessionId }),
      ...(expectedSessionEpoch === undefined ? {} : { expectedSessionEpoch }),
      ...this.#observedTuple(record),
    });
    if (!expectedSessionId || expectedSessionEpoch === undefined || name === undefined) {
      return Promise.resolve(result(name === undefined ? "invalid-name" : "invalid-request"));
    }
    if (record.released || this.#disposed) return Promise.resolve(result("disconnected"));
    if (!record.latestNativeSession) return Promise.resolve(result("unavailable"));
    if (record.latestNativeSession.sessionId !== expectedSessionId
      || record.latestNativeSession.epoch !== expectedSessionEpoch) return Promise.resolve(result("stale-session"));
    const connection = record.active;
    if (!connection || !connection.authed || connection.destroyed || connection.superseded) {
      return Promise.resolve(result("disconnected"));
    }
    if (record.pendingRenames.size >= MAX_PENDING_RENAMES) return Promise.resolve(result("busy"));

    const command: SessionHostRenameRequest = {
      version: PROTOCOL_VERSION,
      type: "rename_request",
      instanceId: record.instanceId,
      generation: this.generation,
      token: record.token,
      requestId,
      expectedSessionId,
      expectedSessionEpoch,
      name,
    };
    return new Promise<StatusRenameResult>((resolve) => {
      const timer = setTimeout(() => {
        const pending = record.pendingRenames.get(requestId);
        if (pending) {
          this.#settleRename(record, pending, result("timeout"));
          // A silent peer may still have an unbounded kernel-side write queue;
          // retire that authenticated channel before accepting more commands.
          this.#destroyConnection(connection);
        }
      }, RENAME_TIMEOUT_MS);
      timer.unref?.();
      const pending: PendingRename = { connection, request: command, timer, resolve };
      record.pendingRenames.set(requestId, pending);
      try {
        this.#queueRenameFrame(connection, encodeFrame(command));
      } catch {
        this.#settleRename(record, pending, result("disconnected"));
        this.#destroyConnection(connection);
      }
    });
  }

  #shutdown(record: RegistrationRecord, options?: { readonly requireIdle?: boolean }): Promise<StatusShutdownResult> {
    if (record.shutdownResult) return record.shutdownResult;
    const requestId = randomUUID();
    const result = (status: StatusShutdownStatus): StatusShutdownResult => ({ requestId, status });
    if (record.released || this.#disposed) return Promise.resolve(result("disconnected"));
    const session = record.latestNativeSession;
    if (!session) return Promise.resolve(result("unavailable"));
    const connection = record.active;
    if (!connection || !connection.authed || connection.destroyed || connection.superseded) {
      return Promise.resolve(result("disconnected"));
    }
    if (record.pendingShutdowns.size >= MAX_PENDING_SHUTDOWNS
      || connection.renameWriteQueue.length >= MAX_PENDING_CONTROL_FRAMES) return Promise.resolve(result("busy"));

    const command: SessionHostShutdownRequest = {
      version: PROTOCOL_VERSION,
      type: "shutdown_request",
      instanceId: record.instanceId,
      generation: this.generation,
      token: record.token,
      requestId,
      expectedSessionId: session.sessionId,
      expectedSessionEpoch: session.epoch,
      ...(options?.requireIdle === true ? { requireIdle: true } : {}),
    };
    const promise = new Promise<StatusShutdownResult>((resolve) => {
      const timer = setTimeout(() => {
        const pending = record.pendingShutdowns.get(requestId);
        if (pending) {
          this.#settleShutdown(record, pending, result("timeout"));
          // A silent peer may still have an unbounded kernel-side write queue;
          // retire that authenticated channel before accepting more commands.
          this.#destroyConnection(connection);
        }
      }, SHUTDOWN_TIMEOUT_MS);
      timer.unref?.();
      const pending: PendingShutdown = { connection, request: command, timer, resolve };
      record.pendingShutdowns.set(requestId, pending);
      try {
        this.#queueRenameFrame(connection, encodeFrame(command));
      } catch {
        this.#settleShutdown(record, pending, result("disconnected"));
        this.#destroyConnection(connection);
      }
    });
    record.shutdownResult = promise;
    void promise.then((result) => {
      // A positively rejected idle-only preflight never invoked shutdown.
      // It must not poison a later deliberately confirmed stop or Quit.
      if (result.status === "not-idle" && record.shutdownResult === promise) record.shutdownResult = undefined;
    });
    return promise;
  }

  /**
   * One coalesced fresh-census request per registration. Concurrent callers
   * share the in-flight promise; one additional bounded follow-up is allowed
   * when that first reply is not complete, so a genuinely repeated unknown
   * episode gets one fresh attempt without a polling loop or unbounded queue.
   */
  #requestActivity(record: RegistrationRecord): Promise<StatusActivityRefreshResult> {
    const pending = record.pendingActivity;
    if (pending) {
      record.activityFollowUp = true;
      return pending.promise;
    }
    const requestId = randomUUID();
    const result = (status: StatusActivityRefreshStatus): StatusActivityRefreshResult => ({ requestId, status });
    if (record.released || this.#disposed) return Promise.resolve(result("disconnected"));
    if (!record.activityCensusSupported) {
      // A legacy reporter treats unknown frames as a protocol violation. It
      // stays a truthful unknown without reconnect churn or restart work; the
      // host never sends a request it did not advertise support for.
      return Promise.resolve(result("unsupported"));
    }
    const connection = record.active;
    if (!connection || !connection.authed || connection.destroyed || connection.superseded) {
      return Promise.resolve(result("disconnected"));
    }
    if (connection.renameWriteQueue.length >= MAX_PENDING_CONTROL_FRAMES) {
      return Promise.resolve(result("busy"));
    }
    const session = record.latestNativeSession;
    const command: SessionHostActivityRequest = {
      version: PROTOCOL_VERSION,
      type: "activity_request",
      instanceId: record.instanceId,
      generation: this.generation,
      token: record.token,
      requestId,
      afterSequence: record.lastSequence,
      expectedSessionId: session?.sessionId ?? null,
      expectedSessionEpoch: session?.epoch ?? null,
    };
    let resolve!: (value: StatusActivityRefreshResult) => void;
    const promise = new Promise<StatusActivityRefreshResult>((settle) => { resolve = settle; });
    const timer = setTimeout(() => {
      const current = record.pendingActivity;
      if (current?.request.requestId !== requestId) return;
      this.#settleActivity(record, current, result("timeout"));
      // A read-only census timeout settles as truthfully unknown and keeps the
      // authenticated channel. A later pushed status or complete reply is
      // still accepted, so a slow reply never forces reconnect churn or
      // clobbers a newer valid live observation.
    }, activityTimeoutMsForTests ?? ACTIVITY_TIMEOUT_MS);
    timer.unref?.();
    const operation: PendingActivity = {
      connection,
      request: command,
      timer,
      promise,
      resolve,
    };
    record.pendingActivity = operation;
    try {
      this.#queueRenameFrame(connection, encodeFrame(command));
    } catch {
      this.#settleActivity(record, operation, result("disconnected"));
      this.#destroyConnection(connection);
    }
    return promise;
  }

  #rememberCompletedActivity(record: RegistrationRecord, requestId: string): void {
    record.completedActivityRequests.delete(requestId);
    if (record.completedActivityRequests.size >= MAX_COMPLETED_ACTIVITY_IDS) {
      const oldest = record.completedActivityRequests.keys().next().value as string | undefined;
      if (oldest) record.completedActivityRequests.delete(oldest);
    }
  }

  #settleActivity(
    record: RegistrationRecord,
    pending: PendingActivity,
    result: StatusActivityRefreshResult,
  ): void {
    if (record.pendingActivity !== pending) return;
    record.pendingActivity = undefined;
    clearTimeout(pending.timer);
    this.#rememberCompletedActivity(record, pending.request.requestId);
    record.completedActivityRequests.set(pending.request.requestId, {
      afterSequence: pending.request.afterSequence,
      expectedSessionId: pending.request.expectedSessionId,
      expectedSessionEpoch: pending.request.expectedSessionEpoch,
    });
    try {
      pending.resolve(result);
    } catch {
      // A consumer's Promise machinery is outside the transport contract.
    }
    const followUp = record.activityFollowUp;
    record.activityFollowUp = false;
    if (followUp && result.status !== "complete" && !record.released && !this.#disposed) {
      // At most one additional read for a coalesced caller; its result is
      // delivered through onStatus and never recursively fans out.
      void this.#requestActivity(record).catch(() => undefined);
    }
  }

  #failPendingActivity(record: RegistrationRecord, connection: ConnectionState): void {
    const pending = record.pendingActivity;
    if (pending?.connection === connection) {
      this.#settleActivity(record, pending, {
        requestId: pending.request.requestId,
        status: "disconnected",
      });
    }
  }

  #queueRenameFrame(connection: ConnectionState, frame: string): void {
    if (connection.destroyed || connection.superseded || connection.renameWriteQueue.length >= MAX_PENDING_CONTROL_FRAMES) {
      throw new Error("control transport unavailable");
    }
    connection.renameWriteQueue.push(frame);
    if (connection.renameWriteScheduled) return;
    connection.renameWriteScheduled = true;
    queueMicrotask(() => {
      connection.renameWriteScheduled = false;
      if (connection.destroyed || connection.superseded) {
        connection.renameWriteQueue.length = 0;
        return;
      }
      const batch = connection.renameWriteQueue.splice(0).join("");
      if (!batch) return;
      try {
        // socket.write(false) still accepts the bounded coalesced batch.
        connection.socket.write(batch);
      } catch {
        this.#destroyConnection(connection);
      }
    });
  }

  #rememberCompletedRename(record: RegistrationRecord, requestId: string): void {
    record.completedRenameIds.add(requestId);
    if (record.completedRenameIds.size > MAX_COMPLETED_RENAME_IDS) {
      const oldest = record.completedRenameIds.values().next().value as string | undefined;
      if (oldest) record.completedRenameIds.delete(oldest);
    }
  }

  #settleRename(record: RegistrationRecord, pending: PendingRename, result: StatusRenameResult): void {
    if (record.pendingRenames.get(pending.request.requestId) !== pending) return;
    record.pendingRenames.delete(pending.request.requestId);
    clearTimeout(pending.timer);
    this.#rememberCompletedRename(record, pending.request.requestId);
    try {
      pending.resolve(result);
    } catch {
      // A consumer's Promise machinery is outside the transport contract.
    }
  }

  #rememberCompletedShutdown(record: RegistrationRecord, requestId: string): void {
    record.completedShutdownIds.add(requestId);
    if (record.completedShutdownIds.size > MAX_COMPLETED_SHUTDOWN_IDS) {
      const oldest = record.completedShutdownIds.values().next().value as string | undefined;
      if (oldest) record.completedShutdownIds.delete(oldest);
    }
  }

  #settleShutdown(record: RegistrationRecord, pending: PendingShutdown, result: StatusShutdownResult): void {
    if (record.pendingShutdowns.get(pending.request.requestId) !== pending) return;
    record.pendingShutdowns.delete(pending.request.requestId);
    clearTimeout(pending.timer);
    this.#rememberCompletedShutdown(record, pending.request.requestId);
    try {
      pending.resolve(result);
    } catch {
      // A consumer's Promise machinery is outside the transport contract.
    }
  }

  #failPendingRenames(record: RegistrationRecord, connection: ConnectionState, status: "disconnected"): void {
    connection.renameWriteQueue.length = 0;
    this.#failPendingActivity(record, connection);
    this.#abandonHostsRequests(record, connection);
    for (const pending of [...record.pendingRenames.values()]) {
      if (pending.connection === connection) {
        this.#settleRename(record, pending, {
          requestId: pending.request.requestId,
          status,
          expectedSessionId: pending.request.expectedSessionId,
          expectedSessionEpoch: pending.request.expectedSessionEpoch,
          ...this.#observedTuple(record),
        });
      }
    }
    for (const pending of [...record.pendingShutdowns.values()]) {
      if (pending.connection === connection) {
        this.#settleShutdown(record, pending, {
          requestId: pending.request.requestId,
          status,
        });
      }
    }
  }

  dispose(): Promise<void> {
    if (!this.#disposal) {
      // Publish the one disposal promise BEFORE teardown starts: teardown
      // aborts native MCP endpoint signals synchronously, and an abort
      // listener that re-enters dispose() must join this same teardown.
      let start!: () => void;
      this.#disposal = new Promise<void>((resolve, reject) => {
        start = () => { void this.#performDispose().then(resolve, reject); };
      });
      start();
    }
    return this.#disposal;
  }

  async #performDispose(): Promise<void> {
    this.#disposed = true;
    for (const nativeRecord of this.#nativeSources.values()) nativeRecord.released = true;
    this.#nativeSources.clear();
    // Native MCP lanes close FIRST, before anything below is awaited (Pi
    // payload cleanup can take a while): every registration is revoked before
    // any endpoint signal is aborted, so an abort listener sees a fully
    // revoked lane family. Broker-wide slots stay held until each endpoint
    // promise settles.
    const mcpRecords = [...this.#nativeMcpSources.values()];
    for (const mcpRecord of mcpRecords) mcpRecord.released = true;
    this.#nativeMcpSources.clear();
    for (const mcpRecord of mcpRecords) {
      if (mcpRecord.active) this.#destroyConnection(mcpRecord.active);
    }
    // Native review registrations are revoked beside the MCP lanes and before
    // any await below, so an abort listener sees a fully revoked lane family.
    // Broker-wide review slots stay held until each host promise settles.
    const reviewRecords = [...this.#nativeReviewSources.values()];
    for (const reviewRecord of reviewRecords) reviewRecord.released = true;
    this.#nativeReviewSources.clear();
    for (const reviewRecord of reviewRecords) {
      for (const conn of [...this.#connections]) {
        if (conn.review?.record === reviewRecord) this.#destroyConnection(conn);
      }
    }
    const records = [...this.#registrations.values()];
    for (const record of records) {
      record.released = true;
      if (record.active) this.#failPendingRenames(record, record.active, "disconnected");
      if (record.pendingActivity) {
        this.#settleActivity(record, record.pendingActivity, {
          requestId: record.pendingActivity.request.requestId,
          status: "disconnected",
        });
      }
      for (const pending of [...record.pendingSpawns.values()]) this.#settleSpawn(record, pending, "unknown");
      this.#abandonHostsRequests(record);
      this.#removePayloadNamespace(record);
      record.active = undefined;
    }
    // Settle every verified payload discard scheduled by release/rejection or
    // this disposal before removing the owned transport directories.
    if (this.#payloadCleanups.size > 0) {
      await Promise.allSettled([...this.#payloadCleanups]);
    }
    for (const record of records) this.#removePayloadNamespace(record);
    this.#registrations.clear();
    for (const conn of [...this.#connections]) {
      // Mark everything superseded so late close callbacks stay silent: an
      // intentional dispose never fires onDisconnect or a native failure.
      conn.superseded = true;
      conn.registration = undefined;
      conn.nativeHandled = true;
      this.#releaseNativeHookSlot(conn);
      this.#releaseNativeRefused(conn);
      this.#closeNativeMcpLane(conn);
      this.#closeNativeReviewLane(conn);
      conn.native = undefined;
      if (conn.nativeCloseTimer) {
        clearTimeout(conn.nativeCloseTimer);
        conn.nativeCloseTimer = undefined;
      }
      if (conn.authTimer) {
        clearTimeout(conn.authTimer);
        conn.authTimer = undefined;
      }
      conn.pending = false;
      try {
        conn.socket.destroy();
      } catch {
        // Best-effort teardown; the close handler is idempotent.
      }
    }
    this.#connections.clear();
    this.#nativeDeliveries = 0;
    this.#nativeRefusedConnections = 0;
    // #nativeMcpInFlight is left to settle with each aborted endpoint promise.
    // #nativeReviewInFlight is left the same way: an aborted host review keeps
    // its slot until that promise settles, so a later turn cannot exceed the
    // lane bound while abandoned review work is still running.
    this.#unauthCount = 0;
    if (this.#transport.kind === "pipe") {
      // A failed listen never owns the named-pipe endpoint. In particular, a
      // collision must not trigger cleanup or close a foreign server.
      if (!this.#listenSucceeded || this.#listenHandleClosed) return;
      const server = this.#server;
      if (!server) {
        throw new Error("pi-review-gate: the session-host named-pipe listen handle is unavailable during disposal");
      }
      const timeoutMs = windowsPipeCloseTimeoutForTests ?? WINDOWS_PIPE_CLOSE_TIMEOUT_MS;
      return new Promise<void>((resolve, reject) => {
        let settled = false;
        const timer = setTimeout(() => {
          if (settled) return;
          settled = true;
          reject(new Error(
            `pi-review-gate: the session-host named-pipe listen handle close timed out after ${timeoutMs}ms`,
          ));
        }, timeoutMs);
        const finish = (error?: unknown) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          if (!error || this.#listenHandleClosed) {
            if (!error) this.#listenHandleClosed = true;
            resolve();
            return;
          }
          const code = error instanceof Error ? (error as NodeJS.ErrnoException).code : undefined;
          reject(new Error(
            `pi-review-gate: the session-host named-pipe listen handle could not be closed (code ${code ?? "unknown"})`,
          ));
        };
        try {
          server.close((error) => finish(error));
        } catch (error) {
          finish(error);
        }
      });
    }
    // Node/libuv unlinks the pathname used by server.listen() when close
    // finishes. Move any current occupant aside and install a directory guard
    // at that pathname first, so close cannot unlink an unknown replacement.
    const pathTeardown = this.#stageSocketPathTeardown();
    const server = this.#server;
    return new Promise<void>((resolve) => {
      if (server) {
        try {
          server.close((error) => {
            // The error (if any) is a cleanup-only condition.
            void error;
            resolve();
          });
        } catch {
          // No runtime close is in flight, so the guarded pathname is safe to restore.
          resolve();
        }
      } else {
        resolve();
      }
    }).then(() => {
      this.#finishSocketPathTeardown(pathTeardown);
      if (this.#transport.kind === "unix") {
        removeOwnEmptyDirectory(this.#transport.transportDir, this.#transport.transportIdentity);
      }
    });
  }

  /**
   * Stages the listen pathname so Node's automatic close-time unlink cannot
   * target an entry that replaced our socket. The unknown occupant is moved
   * only within our private directory and restored after server.close().
   */
  #stageSocketPathTeardown(): SocketPathTeardown {
    if (this.#transport.kind !== "unix") {
      throw new Error("pi-review-gate: named-pipe cleanup cannot use filesystem path teardown");
    }
    const transportDir = this.#transport.transportDir;
    const quarantined: QuarantinedSocketPath[] = [];
    for (let attempt = 0; attempt < 8; attempt += 1) {
      let occupant: ReturnType<typeof lstatSync> | undefined;
      try {
        occupant = lstatSync(this.socketPath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      if (occupant?.isDirectory()) {
        // Node's close-time unlink cannot remove a directory, so preserve an
        // unknown directory exactly where it is instead of quarantining it.
        return { guardIdentity: undefined, quarantined };
      }
      const occupied = occupant !== undefined;

      if (occupied) {
        const quarantineDir = mkdtempSync(join(transportDir, ".dispose-"));
        const quarantineDirStats = lstatSync(quarantineDir);
        const quarantineDirIdentity = {
          dev: quarantineDirStats.dev,
          ino: quarantineDirStats.ino,
        };
        const quarantinePath = join(quarantineDir, "entry");
        try {
          renameSync(this.socketPath, quarantinePath);
        } catch (error) {
          removeOwnEmptyDirectory(quarantineDir, quarantineDirIdentity);
          if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
          throw error;
        }
        const stats = lstatSync(quarantinePath);
        quarantined.push({
          path: quarantinePath,
          directory: quarantineDir,
          directoryIdentity: quarantineDirIdentity,
          identity: { dev: stats.dev, ino: stats.ino },
          ownedSocket: stats.isSocket()
            && this.#socketIdentity !== undefined
            && stats.dev === this.#socketIdentity.dev
            && stats.ino === this.#socketIdentity.ino,
          directoryEntry: stats.isDirectory(),
        });
      }

      try {
        mkdirSync(this.socketPath, 0o700);
        const guard = lstatSync(this.socketPath);
        return {
          guardIdentity: { dev: guard.dev, ino: guard.ino },
          quarantined,
        };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") continue;
        this.#restoreQuarantinedPaths(quarantined, false);
        throw error;
      }
    }
    this.#restoreQuarantinedPaths(quarantined, false);
    throw new Error("pi-review-gate: could not safely stage the session-host socket path for cleanup");
  }

  /** Restores unknown occupants; the broker's own old socket is removed after close. */
  #finishSocketPathTeardown(teardown: SocketPathTeardown): void {
    if (teardown.guardIdentity) {
      removeOwnEmptyDirectory(this.socketPath, teardown.guardIdentity);
    }
    this.#restoreQuarantinedPaths(teardown.quarantined, true);
  }

  #restoreQuarantinedPaths(quarantined: QuarantinedSocketPath[], removeOwnedSocket: boolean): void {
    for (const entry of quarantined) {
      if (removeOwnedSocket && entry.ownedSocket) {
        removeOwnSocketFile(entry.path, entry.identity);
      }
    }
    for (const entry of quarantined) {
      if (removeOwnedSocket && entry.ownedSocket) continue;
      // Portable directory rename has no no-replace operation. If a directory
      // was observed only after the quarantine rename raced, leave it there.
      if (entry.directoryEntry) continue;
      try {
        // link is atomic and fails if the destination already exists; unlike
        // rename it can never replace a concurrent unknown entry.
        linkSync(entry.path, this.socketPath);
        const source = lstatSync(entry.path);
        const destination = lstatSync(this.socketPath);
        if (source.dev === entry.identity.dev
          && source.ino === entry.identity.ino
          && destination.dev === entry.identity.dev
          && destination.ino === entry.identity.ino) {
          unlinkSync(entry.path);
        }
      } catch {
        // Preserve the entry in quarantine if linking is unsupported or raced.
      }
    }
    for (const entry of quarantined) {
      removeOwnEmptyDirectory(entry.directory, entry.directoryIdentity);
    }
  }

  #trackConnection(socket: Socket): void {
    if (this.#disposed) {
      socket.destroy();
      return;
    }
    // Bound the unauthenticated backlog BEFORE tracking the new connection:
    // over-cap arrivals are destroyed immediately and never adopt any state.
    if (this.#unauthCount >= MAX_PENDING_UNAUTH_CONNECTIONS) {
      socket.destroy();
      return;
    }
    const conn: ConnectionState = {
      socket,
      buffered: Buffer.alloc(0),
      authed: false,
      superseded: false,
      destroyed: false,
      authTimer: undefined,
      registration: undefined,
      pending: false,
      nativeHandled: false,
      native: undefined,
      nativeSlotted: false,
      nativeRefused: false,
      nativeCloseTimer: undefined,
      mcp: undefined,
      review: undefined,
      renameWriteQueue: [],
      renameWriteScheduled: false,
    };
    this.#connections.add(conn);
    this.#unauthCount += 1;
    conn.pending = true;
    socket.setNoDelay(true);
    // Short auth deadline: the socket must present a valid hello promptly.
    // There is deliberately no idle-TTL/heartbeat eviction afterwards, since
    // a legitimate reporter may stay idle for hours.
    conn.authTimer = setTimeout(() => {
      this.#destroyConnection(conn);
    }, AUTH_DEADLINE_MS);
    socket.on("data", (chunk: Buffer) => this.#onData(conn, chunk));
    socket.on("end", () => {
      // An authenticated native MCP lane needs both directions: once the peer
      // ends its write side it can no longer cancel anything. Abort its work
      // now instead of waiting for `close`, which a backpressured reply can
      // delay indefinitely. Pi and hook connections keep their existing
      // behavior. Aborted endpoint work keeps its broker-wide slot until it
      // settles.
      if (conn.mcp !== undefined) this.#destroyConnection(conn);
      // A held native review connection needs both directions too: once the
      // provider hook ends its write side it can no longer receive a verdict,
      // so the host's in-flight review is aborted now rather than left running
      // for an answer nobody can read.
      if (conn.review !== undefined) this.#destroyConnection(conn);
    });
    socket.on("error", () => {
      this.#destroyConnection(conn);
    });
    socket.on("close", () => this.#onClose(conn));
  }

  /** Newline-framed reading in raw UTF-8 bytes, strictly bounded before decoding. */
  /**
   * The byte bound applied to ONE still-incomplete line while authentication is
   * still pending on that connection.
   *
   * The larger buffer exists for exactly one reason: a native review request line
   * carries the assistant text the host is asked to review, so it is inherently
   * bigger than any legacy frame. It is therefore widened only while this
   * connection is still unauthenticated AND the broker currently hosts a review
   * source — an authenticated Pi reporter, observer hook, or MCP lane never gets
   * it, and the pre-auth deadline is never extended.
   *
   * Widening the buffer does not widen any legacy family's frame limit, because
   * admitting a longer line and DISPATCHING it are separate decisions:
   * {@link LocalStatusBroker.#handleLine} re-checks the RAW byte count against
   * MAX_PRE_AUTH_FRAME_BYTES before it will even try a legacy decoder. That raw
   * check is what preserves the original limit — a decoded-string check would not,
   * because the shared decoder strips a leading UTF-8 BOM and would report a
   * padded frame as back-fitting. So no other family admits a larger frame, gains
   * a longer deadline, or reaches a callback.
   */
  #requestLineBoundBytes(conn: ConnectionState): number {
    return conn.pending
      && this.#nativeReviewSources.size > 0
      ? Math.max(MAX_PRE_AUTH_FRAME_BYTES, MAX_NATIVE_REVIEW_REQUEST_FRAME_BYTES)
      : MAX_PRE_AUTH_FRAME_BYTES;
  }

  #onData(conn: ConnectionState, chunk: Buffer): void {
    if (conn.destroyed || conn.superseded) return; // late/superseded frames are ignored
    if (conn.mcp !== undefined) {
      // An authenticated native MCP connection never re-enters Pi/hook framing.
      this.#onNativeMcpData(conn, chunk);
      return;
    }
    if (conn.review !== undefined) {
      // An authenticated native review connection carries exactly one request
      // line and then only ever reads its answer: any further byte is a protocol
      // violation, and it never re-enters Pi/hook/MCP framing.
      this.#destroyConnection(conn);
      return;
    }
    let offset = 0;
    while (offset < chunk.length) {
      // Recomputed per line: authenticating a hello inside this same chunk
      // removes the review allowance for every later byte on this connection.
      const lineBound = this.#requestLineBoundBytes(conn);
      const newlineIndex = chunk.indexOf(0x0a, offset);
      if (newlineIndex === -1) {
        const remainingLength = chunk.length - offset;
        const frameLength = conn.buffered.length + remainingLength;
        if (frameLength + 1 > lineBound) {
          // Reserve one byte for the required newline and reject before
          // allocating or retaining a partial frame that cannot fit on wire.
          this.#destroyConnection(conn);
          return;
        }
        if (conn.buffered.length === 0) {
          // Copy only the already-bounded partial frame; retaining a subarray
          // would pin the whole coalesced socket chunk until its delimiter.
          const bounded = Buffer.allocUnsafe(remainingLength);
          chunk.copy(bounded, 0, offset);
          conn.buffered = bounded;
        } else {
          // The combined partial frame is allocated only after its total byte
          // length plus its required newline fits the shared protocol bound.
          const bounded = Buffer.allocUnsafe(frameLength);
          conn.buffered.copy(bounded, 0);
          chunk.copy(bounded, conn.buffered.length, offset);
          conn.buffered = bounded;
        }
        return;
      }

      const segmentLength = newlineIndex - offset;
      const frameLength = conn.buffered.length + segmentLength;
      if (frameLength + 1 > lineBound) {
        this.#destroyConnection(conn);
        return;
      }
      let lineBytes: Buffer;
      if (conn.buffered.length === 0) {
        lineBytes = chunk.subarray(offset, newlineIndex);
      } else {
        lineBytes = Buffer.allocUnsafe(frameLength);
        conn.buffered.copy(lineBytes, 0);
        chunk.copy(lineBytes, conn.buffered.length, offset, newlineIndex);
        conn.buffered = Buffer.alloc(0);
      }
      offset = newlineIndex + 1;
      if (!this.#handleLine(conn, lineBytes, offset < chunk.length)) return;
      if (conn.mcp !== undefined) {
        // The hello just authenticated a native MCP lane: the rest of this
        // chunk belongs to that family's own post-auth framing and bounds.
        if (offset < chunk.length) this.#onNativeMcpData(conn, chunk.subarray(offset));
        return;
      }
    }
  }

  /**
   * Routes one bounded line; false means the connection is no longer usable.
   * `hasTrailingBytes` reports that this same socket chunk already carries more
   * data after this line's delimiter, which some families must reject before they
   * commit to anything.
   */
  #handleLine(conn: ConnectionState, lineBytes: Buffer, hasTrailingBytes: boolean): boolean {
    // The native family is strictly one-shot. Once a native frame has been
    // considered, no later byte on this socket may be decoded or dispatched as
    // either family: a coalesced Pi hello/status after a native event must never
    // supersede an active Pi reporter. Stop the current chunk and destroy on
    // any later input.
    if (conn.nativeHandled || conn.native !== undefined || conn.mcp !== undefined || conn.review !== undefined) {
      this.#destroyConnection(conn);
      return false;
    }
    let line: string;
    try {
      line = new TextDecoder("utf-8", { fatal: true }).decode(lineBytes);
    } catch {
      // Invalid UTF-8 is malformed wire data, not replacement-character text.
      this.#destroyConnection(conn);
      return false;
    }
    let message: ReturnType<typeof decodeFrame>;
    // Every legacy family keeps its OWN raw wire bound, measured on the bytes as
    // received. The wider buffer exists only to hold one review request line
    // while authentication is still pending, and a decoded-string check would not
    // preserve it: the shared decoder strips a leading UTF-8 BOM, so a legacy
    // frame padded to the old limit and then prefixed with a BOM would slip
    // through a widened reader that the old raw reader refused.
    const fitsLegacyBound = lineBytes.length + 1 <= MAX_PRE_AUTH_FRAME_BYTES;
    try {
      message = fitsLegacyBound ? decodeFrame(line) : undefined;
    } catch {
      // A parser failure is contained at the local transport boundary too.
      message = undefined;
    }
    if (message === undefined) {
      // The line may belong to the separate native hook family. Decode it with
      // that family's own strict parser (never inside Pi hello/status semantics)
      // and route it to the native-only path.
      let native: DecodedNativeHookFrame | undefined;
      try {
        native = fitsLegacyBound ? decodeNativeHookFrame(line) : undefined;
      } catch {
        native = undefined;
      }
      if (native !== undefined) {
        this.#onNativeHookFrame(conn, native);
        // Do not process any remaining coalesced frames from this chunk.
        return false;
      }
      // Finally, the separate native MCP family's hello (strict own decoder).
      // The shared pre-auth decoder strips a leading BOM; this family's
      // canonical framing never carries one, so such a line is not a hello.
      let mcpHello: NativeMcpHelloFrame | undefined;
      try {
        mcpHello = !fitsLegacyBound
          || (lineBytes[0] === 0xef && lineBytes[1] === 0xbb && lineBytes[2] === 0xbf)
          ? undefined
          : decodeNativeMcpHello(line);
      } catch {
        mcpHello = undefined;
      }
      if (mcpHello !== undefined) {
        this.#onNativeMcpHello(conn, mcpHello);
        return conn.mcp !== undefined && !conn.destroyed && !conn.superseded;
      }
      // Finally, the separate blocking native review family: its one request
      // line IS its authentication, decoded by this family's own strict decoder
      // and never inside Pi hello/status semantics.
      let review: ReturnType<typeof decodeNativeReviewRequestFrame>;
      try {
        review = lineBytes[0] === 0xef && lineBytes[1] === 0xbb && lineBytes[2] === 0xbf
          ? undefined
          : decodeNativeReviewRequestFrame(line);
      } catch {
        review = undefined;
      }
      if (review !== undefined) {
        if (hasTrailingBytes) {
          // Bytes already received after this line's delimiter make the stream
          // invalid. Rejecting before authentication and before any host callback
          // keeps the outcome identical however the provider's output happened to
          // be split across socket chunks.
          this.#destroyConnection(conn);
          return false;
        }
        this.#onNativeReviewRequest(conn, review);
        // One request line is the whole request: this socket never re-enters
        // shared line framing, and any further byte is handled by the review
        // branch above as a violation.
        return false;
      }

      // Malformed or oversized-on-decode frames (including forbidden terminal
      // controls) close the connection; no callback and no diagnostic output.
      this.#destroyConnection(conn);
      return false;
    }
    if (message.type === "hello") {
      this.#onHello(conn, message);
    } else if (message.type === "status") {
      this.#onStatus(conn, message);
    } else if (message.type === "rename_result") {
      this.#onRenameAck(conn, message);
    } else if (message.type === "shutdown_result") {
      this.#onShutdownAck(conn, message);
    } else if (message.type === "activity_result") {
      this.#onActivityResult(conn, message);
    } else if (message.type === "spawn_request" || message.type === "spawn_routed_request") {
      this.#onSpawnRequest(conn, message);
    } else if (message.type === "hosts_request") {
      this.#onHostsRequest(conn, message);
    } else {
      this.#destroyConnection(conn); // Reporters may only issue the explicitly admitted SessionSpawn request.
    }
    return !conn.destroyed && !conn.superseded;
  }

  /**
   * Authenticates and delivers exactly one native hook frame. This path never
   * touches a Pi registration's `active` connection, sequence, reconnect
   * callback, or command authority: native authentication sets only the
   * separate `conn.native` family marker, and the one-shot connection closes
   * after its fixed-size ACK. Unknown/stale/wrong-token/cross-family/backend
   * failures close silently with no callback, so they cannot disturb a valid
   * row. A normal ACK close is never reported as a failure.
   */
  #onNativeHookFrame(conn: ConnectionState, decoded: DecodedNativeHookFrame): void {
    if (conn.authed || conn.registration !== undefined || conn.nativeHandled || conn.mcp !== undefined
      || conn.review !== undefined) {
      // A Pi-authenticated socket can never switch families, and one connection
      // carries at most one native delivery.
      this.#destroyConnection(conn);
      return;
    }
    conn.nativeHandled = true;
    const frame = decoded.frame;
    const record = this.#nativeSources.get(frame.instanceId);
    if (!record || record.released) {
      this.#destroyConnection(conn);
      return;
    }
    // A Pi registration with the same id is a different family. Registration
    // refuses this overlap up front; keeping the check here makes any raced or
    // future ambiguity fail closed rather than authenticate by accident.
    const piRecord = this.#registrations.get(frame.instanceId);
    if (piRecord && !piRecord.released) {
      this.#destroyConnection(conn);
      return;
    }
    if (!timingSafeTextEqual(frame.instanceId, record.instanceId)
      || !timingSafeTextEqual(frame.generation, this.generation)
      || !timingSafeTextEqual(frame.token, record.token)
      || frame.backend !== record.backend) {
      // Wrong token, stale host generation, cross-family token, or mismatched
      // backend: close without any callback or row mutation.
      this.#destroyConnection(conn);
      return;
    }

    // Native authentication is committed only on this separate marker. It does
    // not set `conn.authed`, bind a registration, or become record.active.
    conn.native = record;
    if (conn.authTimer) {
      clearTimeout(conn.authTimer);
      conn.authTimer = undefined;
    }
    if (conn.pending) {
      conn.pending = false;
      this.#unauthCount -= 1;
    }

    if (!this.#reserveNativeHookSlot(record)) {
      // Authenticated but over the separate post-auth native bound. The
      // delivery is discarded, so this exact current source has a known
      // host-local observation loss: report it once through the callback-only
      // closed reason, then still answer the fixed rejection. The callback
      // carries no event data, is never a wire value, and a throwing consumer
      // is contained without accepting the discarded delivery.
      try {
        record.handlers.onFailure({ backend: record.backend, reason: "delivery-refused" });
      } catch {
        // Contained: a throwing consumer cannot change the refusal or Pi state.
      }
      this.#refuseNativeHookDelivery(conn);
      return;
    }
    conn.nativeSlotted = true;
    try {
      if (decoded.kind === "event") record.handlers.onEvent(decoded.event);
      else record.handlers.onFailure(decoded.failure);
    } catch {
      // Contained: a throwing consumer never crashes the native process or the broker.
    }
    if (decoded.kind === "event") this.#deliverClaudeInboxAnnouncement(record, decoded);
    // The callback is never invoked twice on this connection. A release inside
    // the callback may already have destroyed the socket, in which case the ACK
    // is simply skipped.
    this.#sendNativeHookAck(conn, true);
  }

  /**
   * #682: for one already-authenticated event frame, rebuilds the opaque inbox
   * candidate from its shape-checked attachment with the announcement helper's
   * own selection (Claude backend of THIS registration, root `SessionStart`,
   * exact conversation id, supported platform, sender socket-path/token rules)
   * and hands it to the owner callback stored at registration. Selection reads
   * the broker-owned authenticated `decoded.frame`, never the `decoded.event`
   * object `onEvent` received and may have mutated. Anything that does not
   * validate, no stored owner, or a release during `onEvent` yields no call.
   * Nothing is logged, retried, or reported on any other path.
   */
  #deliverClaudeInboxAnnouncement(
    record: NativeHookSourceRecord,
    decoded: Extract<DecodedNativeHookFrame, { kind: "event" }>,
  ): void {
    const deliverAnnouncement = record.claudeInboxAnnouncementOwner;
    if (record.released || record.backend !== "claude" || typeof deliverAnnouncement !== "function") return;
    let candidate: ClaudeInboxAnnouncementCandidate | undefined;
    try {
      const attachment = readNativeHookClaudeInboxAttachment(decoded);
      if (attachment === undefined) return;
      candidate = selectClaudeInboxAnnouncement(record.backend, decoded.frame, {
        [CLAUDE_INBOX_SOCKET_ENV]: attachment.socket_path,
        [CLAUDE_INBOX_TOKEN_ENV]: attachment.hook_token,
      });
    } catch {
      return;
    }
    if (candidate === undefined) return;
    try {
      // A `void`-typed callback may still be async. Observe its return value
      // without awaiting it so a rejection is discarded silently: it can neither
      // delay the ACK nor surface as an unhandled rejection or diagnostic.
      const returned: unknown = deliverAnnouncement(candidate);
      void Promise.resolve(returned).catch(() => undefined);
    } catch {
      // Contained: the ordinary event and fixed ACK are unaffected.
    }
  }

  /**
   * Counts one authenticated refusal until its fixed ACK is flushed and the
   * socket destroyed. The separate cap means a half-open client that never
   * sends FIN cannot retain refused sockets outside both admission pools, and
   * the Pi listener never accumulates unbounded refusal descriptors/timers.
   */
  #refuseNativeHookDelivery(conn: ConnectionState): void {
    if (conn.destroyed || conn.superseded) return;
    if (this.#nativeRefusedConnections >= MAX_NATIVE_HOOK_REFUSED_CONNECTIONS) {
      // Prompt refusal at the refusal bound: no ACK, no lingering socket.
      this.#destroyConnection(conn);
      return;
    }
    this.#nativeRefusedConnections += 1;
    conn.nativeRefused = true;
    this.#sendNativeHookAck(conn, false);
  }

  /** Idempotently frees a counted native admission refusal. */
  #releaseNativeRefused(conn: ConnectionState): void {
    if (!conn.nativeRefused) return;
    conn.nativeRefused = false;
    if (this.#nativeRefusedConnections > 0) this.#nativeRefusedConnections -= 1;
  }

  #reserveNativeHookSlot(record: NativeHookSourceRecord): boolean {
    const limit = nativeHookDeliveryLimitForTests ?? MAX_NATIVE_HOOK_DELIVERIES;
    if (limit < 1
      || this.#nativeDeliveries >= limit
      || record.activeDeliveries >= MAX_NATIVE_HOOK_DELIVERIES_PER_SOURCE) return false;
    this.#nativeDeliveries += 1;
    record.activeDeliveries += 1;
    return true;
  }

  /** Idempotently frees a native delivery slot; never touches Pi state. */
  #releaseNativeHookSlot(conn: ConnectionState): void {
    if (!conn.nativeSlotted) return;
    conn.nativeSlotted = false;
    const record = conn.native;
    if (record && record.activeDeliveries > 0) record.activeDeliveries -= 1;
    if (this.#nativeDeliveries > 0) this.#nativeDeliveries -= 1;
  }

  /** Writes one fixed-size ACK and bounds how long the one-shot socket may linger. */
  #sendNativeHookAck(conn: ConnectionState, accepted: boolean): void {
    if (conn.destroyed || conn.superseded) {
      this.#releaseNativeRefused(conn);
      return;
    }
    const ack: NativeHookAckFrame = { version: 1, type: "native_hook_ack", accepted };
    let frame: string;
    try {
      frame = encodeNativeHookFrame(ack);
    } catch {
      this.#destroyConnection(conn);
      return;
    }
    if (!accepted) {
      // Refusal is bounded separately: flush the fixed ACK, then destroy
      // promptly. A write callback normally runs as soon as the tiny frame is
      // flushed; the short timer is only a fallback for a stuck transport.
      if (conn.nativeCloseTimer) clearTimeout(conn.nativeCloseTimer);
      conn.nativeCloseTimer = setTimeout(
        () => this.#destroyConnection(conn),
        NATIVE_HOOK_REFUSED_CLOSE_TIMEOUT_MS,
      );
      conn.nativeCloseTimer.unref?.();
      try {
        conn.socket.write(frame, () => this.#destroyConnection(conn));
      } catch {
        this.#destroyConnection(conn);
      }
      return;
    }
    try {
      // `end` flushes the fixed ACK and then closes this one-shot socket; no
      // source data is echoed and no further frame is accepted.
      conn.socket.end(frame);
    } catch {
      this.#destroyConnection(conn);
      return;
    }
    if (conn.nativeCloseTimer) clearTimeout(conn.nativeCloseTimer);
    conn.nativeCloseTimer = setTimeout(() => this.#destroyConnection(conn), NATIVE_HOOK_CLOSE_TIMEOUT_MS);
    conn.nativeCloseTimer.unref?.();
  }

  /**
   * Authenticates one native MCP hello. Every refusal (unknown, released,
   * stale generation, wrong or cross-family token, backend mismatch, a lane
   * already live or already spent, a Pi registration with the same id) is a
   * silent close that touches no record and never reaches the endpoint. Only
   * success leaves the pre-auth pool, binds `conn.mcp`, and writes `ready`.
   */
  #onNativeMcpHello(conn: ConnectionState, hello: NativeMcpHelloFrame): void {
    if (conn.authed || conn.registration !== undefined || conn.nativeHandled || conn.native !== undefined
      || conn.mcp !== undefined || conn.review !== undefined) {
      this.#destroyConnection(conn);
      return;
    }
    const record = this.#nativeMcpSources.get(hello.instanceId);
    if (!record || record.released) {
      this.#destroyConnection(conn);
      return;
    }
    // Registration refuses this overlap up front; re-checking here keeps any
    // raced or future ambiguity fail closed.
    const piRecord = this.#registrations.get(hello.instanceId);
    if (piRecord && !piRecord.released) {
      this.#destroyConnection(conn);
      return;
    }
    if (!timingSafeTextEqual(hello.instanceId, record.instanceId)
      || !timingSafeTextEqual(hello.generation, this.generation)
      || !timingSafeTextEqual(hello.token, record.token)
      || hello.backend !== record.backend) {
      this.#destroyConnection(conn);
      return;
    }
    if (record.active !== undefined || record.spent) {
      // First authenticated connection wins for the registration's lifetime:
      // a second valid hello never takes over, and a closed lane is never
      // re-admitted. The live connection is untouched.
      this.#destroyConnection(conn);
      return;
    }
    if (conn.authTimer) {
      clearTimeout(conn.authTimer);
      conn.authTimer = undefined;
    }
    if (conn.pending) {
      conn.pending = false;
      this.#unauthCount -= 1;
    }
    conn.mcp = {
      record,
      reader: new NativeMcpFrameReader(MAX_NATIVE_MCP_REQUEST_FRAME_BYTES),
      lastSeq: 0,
      inFlight: new Map(),
      closed: false,
      identity: Object.freeze({}),
    };
    record.active = conn;
    record.spent = true;
    this.#writeNativeMcpFrame(conn, encodeNativeMcpServerFrame({ version: 1, type: "native_mcp_ready" }));
  }

  /** Bounded post-auth framing; overflow or invalid UTF-8 closes the lane. */
  #onNativeMcpData(conn: ConnectionState, chunk: Buffer): void {
    const mcp = conn.mcp;
    if (!mcp || mcp.closed || conn.destroyed) return;
    const result = mcp.reader.push(chunk, (line) => this.#onNativeMcpLine(conn, mcp, line));
    if (result === "overflow" || result === "invalid_utf8") this.#destroyConnection(conn);
  }

  /** One authenticated relay frame; false stops reading this chunk. */
  #onNativeMcpLine(conn: ConnectionState, mcp: NativeMcpConnectionState, line: string): boolean {
    if (mcp.closed || conn.destroyed || mcp.record.released) return false;
    let frame: ReturnType<typeof decodeNativeMcpClientFrame>;
    try {
      frame = decodeNativeMcpClientFrame(line);
    } catch {
      frame = undefined;
    }
    if (frame === undefined
      || (mcp.record.backend !== "claude" && frame.type === "native_mcp_request" && frame.op === "call"
        && frame.toolUseId !== undefined)) {
      // Malformed, unknown, or extra-field frames are protocol violations. The
      // Claude tool-use matching key (#682) is such an extra field on any other
      // backend's lane, exactly as before it existed.
      this.#destroyConnection(conn);
      return false;
    }
    if (frame.type === "native_mcp_cancel") {
      if (frame.seq > mcp.lastSeq) {
        // Cancelling a request that was never sent is a violation.
        this.#destroyConnection(conn);
        return false;
      }
      // A cancel crossing its response is normal and changes nothing.
      const entry = mcp.inFlight.get(frame.seq);
      if (entry && !entry.cancelled) {
        entry.cancelled = true;
        abortQuietly(entry.controller);
      }
      return !mcp.closed && !conn.destroyed;
    }
    if (frame.seq <= mcp.lastSeq) {
      // Correlation numbers are strictly increasing and never reused.
      this.#destroyConnection(conn);
      return false;
    }
    mcp.lastSeq = frame.seq;
    const limit = nativeMcpInFlightLimitForTests ?? MAX_NATIVE_MCP_IN_FLIGHT;
    if (mcp.inFlight.size >= MAX_NATIVE_MCP_IN_FLIGHT_PER_CONNECTION || this.#nativeMcpInFlight >= limit) {
      // Refused before delivery: the endpoint is never called for this seq.
      this.#sendNativeMcpResponse(conn, { version: 1, type: "native_mcp_response", seq: frame.seq, outcome: "error", code: "busy" });
      return !mcp.closed && !conn.destroyed;
    }
    this.#dispatchNativeMcp(conn, mcp, frame);
    return !mcp.closed && !conn.destroyed;
  }

  /** Calls the endpoint exactly once for one admitted request; never retried. */
  #dispatchNativeMcp(conn: ConnectionState, mcp: NativeMcpConnectionState, frame: NativeMcpRequestFrame): void {
    const entry: NativeMcpInFlight = { controller: new AbortController(), cancelled: false, slotReleased: false };
    mcp.inFlight.set(frame.seq, entry);
    this.#nativeMcpInFlight += 1;
    const endpoint = mcp.record.endpoint;
    const signal = entry.controller.signal;
    let promise: Promise<unknown>;
    try {
      promise = Promise.resolve(frame.op === "list"
        ? endpoint.listTools({ signal })
        // Only the validated name, the freshly decoded arguments object, and
        // (on a Claude lane) the optional validated tool-use matching key (#682;
        // never authority) cross; the endpoint owns that object from here on.
        : endpoint.callTool({
          name: frame.name,
          arguments: frame.arguments,
          ...(frame.toolUseId === undefined ? {} : { toolUseId: frame.toolUseId }),
          signal,
        }));
    } catch (error) {
      promise = Promise.reject(error);
    }
    promise.then(
      (value) => this.#settleNativeMcp(conn, mcp, frame, entry, { settled: "value", value }),
      () => this.#settleNativeMcp(conn, mcp, frame, entry, { settled: "failed" }),
    );
  }

  /** Answers one settled endpoint call, unless its lane closed meanwhile (then the result is dropped). */
  #settleNativeMcp(
    conn: ConnectionState,
    mcp: NativeMcpConnectionState,
    frame: NativeMcpRequestFrame,
    entry: NativeMcpInFlight,
    outcome: { readonly settled: "value"; readonly value: unknown } | { readonly settled: "failed" },
  ): void {
    // The owner's work is over: only now does the broker-wide slot return,
    // whether or not the lane is still open to hear the answer.
    if (!entry.slotReleased) {
      entry.slotReleased = true;
      if (this.#nativeMcpInFlight > 0) this.#nativeMcpInFlight -= 1;
    }
    if (mcp.inFlight.get(frame.seq) !== entry) return;
    mcp.inFlight.delete(frame.seq);
    if (mcp.closed || conn.destroyed || mcp.record.released) return;
    const seq = frame.seq;
    const error = (code: "unknown_tool" | "failed" | "result_too_large"): NativeMcpResponseFrame =>
      ({ version: 1, type: "native_mcp_response", seq, outcome: "error", code });
    let response: NativeMcpResponseFrame;
    if (outcome.settled === "failed") {
      response = error("failed");
    } else if (frame.op === "list") {
      response = Array.isArray(outcome.value)
        ? { version: 1, type: "native_mcp_response", seq, outcome: "result", result: { tools: outcome.value } }
        : error("failed");
    } else if (outcome.value === undefined) {
      response = error("unknown_tool");
    } else if (typeof outcome.value === "object" && outcome.value !== null && !Array.isArray(outcome.value)) {
      response = { version: 1, type: "native_mcp_response", seq, outcome: "result", result: outcome.value as Record<string, unknown> };
    } else {
      response = error("failed");
    }
    let encoded: string;
    try {
      encoded = encodeNativeMcpServerFrame(response);
    } catch (encodeError) {
      // An oversized completed call is reported as such (it ran); anything
      // else unencodable, and any oversized list, is a plain failure.
      const tooLarge = encodeError instanceof RangeError && frame.op === "call" && response.outcome === "result";
      encoded = encodeNativeMcpServerFrame(error(tooLarge ? "result_too_large" : "failed"));
    }
    this.#writeNativeMcpFrame(conn, encoded);
  }

  #sendNativeMcpResponse(conn: ConnectionState, response: NativeMcpResponseFrame): void {
    let encoded: string;
    try {
      encoded = encodeNativeMcpServerFrame(response);
    } catch {
      this.#destroyConnection(conn);
      return;
    }
    this.#writeNativeMcpFrame(conn, encoded);
  }

  /** Writes one frame; a relay that stops reading past the outbound bound is closed. */
  #writeNativeMcpFrame(conn: ConnectionState, frame: string): void {
    if (conn.destroyed || conn.mcp === undefined || conn.mcp.closed) return;
    // Queue UTF-8 bytes, never a string: net.Socket counts a queued string in
    // UTF-16 code units, so the byte cap would undercount multibyte replies.
    const bytes = Buffer.from(frame, "utf8");
    if (conn.socket.writableLength + bytes.length > MAX_NATIVE_MCP_PENDING_OUTBOUND_BYTES) {
      this.#destroyConnection(conn);
      return;
    }
    try {
      conn.socket.write(bytes);
    } catch {
      this.#destroyConnection(conn);
    }
  }

  /**
   * Authenticates one native review request line and holds the connection while
   * the host reviews it. Every refusal (unknown, released, stale generation,
   * wrong or cross-family token, backend mismatch, a Pi/hook/MCP registration
   * with the same id) is a silent close that touches no record and never reaches
   * the host callback — exactly like the other families, so a bad probe cannot
   * disturb a valid row. Only success leaves the pre-auth pool, binds
   * `conn.review`, and may produce one answer frame.
   *
   * There is deliberately NO timer on the held answer: the provider's own
   * command-hook timeout (or the user pressing Esc) is what ends a wait the
   * host cannot finish, and the broker must not answer a turn the provider has
   * already given up on with a synthetic verdict. A socket that closes first
   * aborts the host's signal, so the review stops rather than running on for a
   * listener that is gone.
   */
  #onNativeReviewRequest(conn: ConnectionState, decoded: NonNullable<ReturnType<typeof decodeNativeReviewRequestFrame>>): void {
    if (conn.authed || conn.registration !== undefined || conn.nativeHandled || conn.native !== undefined
      || conn.mcp !== undefined) {
      // A Pi-authenticated socket can never switch families, and one connection
      // carries at most one review request.
      this.#destroyConnection(conn);
      return;
    }
    conn.nativeHandled = true;
    const frame = decoded.frame;
    const record = this.#nativeReviewSources.get(frame.instanceId);
    if (!record || record.released) {
      this.#destroyConnection(conn);
      return;
    }
    if (!timingSafeTextEqual(frame.instanceId, record.instanceId)
      || !timingSafeTextEqual(frame.generation, this.generation)
      || !timingSafeTextEqual(frame.token, record.token)
      || frame.backend !== record.backend) {
      // Wrong token, stale host generation, cross-family token, or mismatched
      // backend: close without any callback and without an answer frame.
      this.#destroyConnection(conn);
      return;
    }

    // Native review authentication is committed only on this separate marker.
    // It does not set `conn.authed`, bind a Pi registration, or become any
    // record's active connection.
    const entry: NativeReviewConnectionState = {
      record,
      controller: new AbortController(),
      answered: false,
      slotted: false,
      handlerSettled: false,
      closed: false,
    };
    conn.review = entry;
    if (!this.#reserveNativeReviewSlot(record)) {
      // Admitted nowhere: this request is refused before it can hold anything.
      // The intake slot and the pre-auth deadline deliberately STAY armed here, so
      // a peer that leaves the small `busy` refusal unread — or leaves its socket
      // half-open — is still bounded by the existing bounded intake pool and its
      // deadline instead of drifting outside both limits. Nothing was reviewed:
      // the closed `busy` code tells the relay this turn was not reviewed, and the
      // refusal's flush callback destroys the socket the moment it has gone out.
      this.#answerNativeReview(conn, entry, { version: 1, type: "native_review_error", code: "busy" });
      return;
    }
    entry.slotted = true;
    // Only an ADMITTED request leaves the bounded intake pool, and only now:
    // admission is decided before the accounting that made it reachable is given
    // up, so a request is never counted by neither limit.
    if (conn.authTimer) {
      clearTimeout(conn.authTimer);
      conn.authTimer = undefined;
    }
    if (conn.pending) {
      conn.pending = false;
      this.#unauthCount -= 1;
    }
    // The complete request — reviewed text included — was already decoded and
    // authenticated above: the pre-auth deadline is cleared and the slot reserved
    // only for a whole line, so no partial request can hold either.
    this.#startNativeReview(conn, entry, decoded.request);
  }

  /**
   * Invokes the host's review callback exactly once for one fully decoded and
   * authenticated request. Only the closed, sanitized request crosses: never the
   * token, the generation, the routing id, or any provider field the decoder
   * dropped.
   */
  #startNativeReview(conn: ConnectionState, entry: NativeReviewConnectionState, request: NativeReviewRequest): void {
    if (conn.destroyed || conn.superseded || entry.answered || entry.record.released) {
      // The host was never reached, so no host work is abandoned and the
      // reserved slot returns now instead of waiting on a promise that will
      // never settle.
      this.#releaseNativeReviewSlot(entry);
      return;
    }
    const signal = entry.controller.signal;
    // An async wrapper always yields a fresh native promise owned by this
    // broker: a synchronous throw, a rejected promise, or a returned promise
    // or thenable whose own `then` accessor throws all become a rejection of
    // that wrapper (the resolve procedure catches the accessor), so attaching
    // the callbacks below can never throw out of the socket callback.
    const record = entry.record;
    const promise: Promise<NativeReviewVerdict> = (async () => record.onReviewRequest(request, signal))();
    promise.then(
      // Both fulfillment callbacks are guarded. Their return value is
      // deliberately not awaited, so anything thrown from inside one would
      // otherwise surface as an unhandled rejection and could take the host
      // process down over one row's misbehaving review callback.
      (verdict) => {
        try {
          this.#settleNativeReview(conn, entry, { settled: "value", verdict });
        } catch {
          this.#answerNativeReview(conn, entry, { version: 1, type: "native_review_error", code: "failed" });
          this.#destroyConnection(conn);
        }
      },
      () => {
        try {
          this.#settleNativeReview(conn, entry, { settled: "failed" });
        } catch {
          this.#destroyConnection(conn);
        }
      },
    );
  }

  /** Per-source and broker-wide admission for one held native review request. */
  #reserveNativeReviewSlot(record: NativeReviewSourceRecord): boolean {
    const limit = nativeReviewInFlightLimitForTests ?? MAX_NATIVE_REVIEW_REQUESTS;
    if (limit < 1
      || this.#nativeReviewInFlight >= limit
      || record.activeRequests >= MAX_NATIVE_REVIEW_REQUESTS_PER_SOURCE) return false;
    this.#nativeReviewInFlight += 1;
    record.activeRequests += 1;
    return true;
  }

  /** Idempotently frees one native review slot; never touches Pi or other-family state. */
  #releaseNativeReviewSlot(entry: NativeReviewConnectionState): void {
    if (!entry.slotted) return;
    entry.slotted = false;
    if (entry.record.activeRequests > 0) entry.record.activeRequests -= 1;
    if (this.#nativeReviewInFlight > 0) this.#nativeReviewInFlight -= 1;
  }

  /**
   * Answers one settled review request, unless its connection closed or its
   * source was released meanwhile (then the verdict is dropped: the provider
   * hook is already gone, and a late block must never be queued for a later
   * turn). A rejected, thrown, or malformed verdict is the closed `failed`
   * code — contained, never a crash, and never a block.
   */
  #settleNativeReview(
    conn: ConnectionState,
    entry: NativeReviewConnectionState,
    outcome: { readonly settled: "value"; readonly verdict: NativeReviewVerdict } | { readonly settled: "failed" },
  ): void {
    // The host's work is over, but an admitted slot is only returned once its
    // reply has also left the socket: a peer that never reads a verdict must keep
    // counting against this family's own bound rather than accumulating unread
    // replies and descriptors outside every limit. When the socket is already gone
    // there is no reply left to drain, so the slot returns now.
    entry.handlerSettled = true;
    if (entry.closed || conn.destroyed || conn.superseded || entry.record.released) {
      this.#releaseNativeReviewSlot(entry);
      return;
    }
    if (entry.answered) return;
    if (outcome.settled === "failed") {
      this.#answerNativeReview(conn, entry, { version: 1, type: "native_review_error", code: "failed" });
      return;
    }
    let verdict: NativeReviewVerdict | undefined;
    try {
      // A RESOLVED verdict is still caller-supplied data: a throwing `action` or
      // `reason` getter must become the closed `failed` code, never an exception
      // escaping this fulfillment callback.
      verdict = parseNativeReviewVerdict(outcome.verdict);
    } catch {
      verdict = undefined;
    }
    if (verdict === undefined) {
      this.#answerNativeReview(conn, entry, { version: 1, type: "native_review_error", code: "failed" });
      return;
    }
    this.#answerNativeReview(conn, entry, {
      version: 1,
      type: "native_review_response",
      action: verdict.action,
      ...(verdict.reason === undefined ? {} : { reason: verdict.reason }),
      ...(verdict.userMessage === undefined ? {} : { userMessage: verdict.userMessage }),
    });
  }

  /** Writes this connection's ONE answer frame and ends it. Never a second frame. */
  #answerNativeReview(
    conn: ConnectionState,
    entry: NativeReviewConnectionState,
    frame: NativeReviewServerFrame,
  ): void {
    if (entry.answered || conn.destroyed || conn.superseded) return;
    entry.answered = true;
    let encoded: string;
    try {
      encoded = encodeNativeReviewServerFrame(frame);
    } catch {
      // A verdict that cannot fit its own bound is a failed review, never a
      // truncated frame and never a block.
      try {
        encoded = encodeNativeReviewServerFrame({ version: 1, type: "native_review_error", code: "failed" });
      } catch {
        this.#destroyConnection(conn);
        return;
      }
    }
    try {
      if (frame.type === "native_review_error" && frame.code === "busy") {
        // A refusal was never admitted, so it must not linger holding a socket
        // outside both limits: write the small frame and destroy the connection as
        // soon as it has flushed. Until that flush lands the connection is still
        // inside the bounded intake pool and still under the pre-auth deadline, so
        // an unread refusal is bounded twice over rather than not at all.
        conn.socket.write(encoded, () => this.#destroyConnection(conn));
        return;
      }
      // `end` flushes the single answer frame and then closes this held socket;
      // no request data is echoed and no further frame is accepted.
      conn.socket.end(encoded);
    } catch {
      this.#destroyConnection(conn);
      return;
    }
    // This timer bounds only an ANSWERED socket that lingers half-closed; it is
    // never a deadline on the held verdict, which the provider's own hook
    // timeout governs.
    if (conn.nativeCloseTimer) clearTimeout(conn.nativeCloseTimer);
    conn.nativeCloseTimer = setTimeout(() => this.#destroyConnection(conn), NATIVE_HOOK_CLOSE_TIMEOUT_MS);
    conn.nativeCloseTimer.unref?.();
  }

  /**
   * Idempotently observes one native review connection's close.
   *
   * Two independent lifetimes end here:
   *
   * - **Cancellation.** The host's signal is aborted ONLY while its review is
   *   still in flight. Once the handler has settled, the socket is merely
   *   delivering a reply, and closing it must not look like cancellation: a host
   *   callback that registered an abort listener would otherwise be told to
   *   abandon a review it already decided, with no way to tell that signal apart
   *   from a real cancellation.
   * - **Admission.** An admitted slot returns only when BOTH the handler has
   *   settled and the socket has closed. If the handler is still running, aborting
   *   cannot prove the host stopped, so the slot stays counted until that promise
   *   settles; if the handler has settled, this close is the last half of the
   *   reply's lifecycle and frees the slot now.
   */
  #closeNativeReviewLane(conn: ConnectionState): void {
    const entry = conn.review;
    if (!entry || entry.closed) return;
    entry.closed = true;
    if (!entry.slotted) return;
    if (entry.handlerSettled) this.#releaseNativeReviewSlot(entry);
    else if (!entry.controller.signal.aborted) abortQuietly(entry.controller);
  }

  /** Idempotent native review revocation: closes held sockets and aborts in-flight work. */
  #releaseNativeReviewSource(record: NativeReviewSourceRecord): void {
    if (record.released) return;
    record.released = true;
    if (this.#nativeReviewSources.get(record.instanceId) === record) {
      this.#nativeReviewSources.delete(record.instanceId);
    }
    // Every held request of this exact launch is destroyed silently: its host
    // signal is aborted, its late verdict is dropped, and a later request line
    // with the same token is a stale close. No queue, replay, or retry.
    for (const conn of [...this.#connections]) {
      if (conn.review?.record === record) this.#destroyConnection(conn);
    }
  }

  /**
   * Idempotently closes one native MCP lane: aborts every in-flight endpoint
   * signal, detaches response delivery, and leaves the registration spent.
   * Broker-wide slots are NOT returned here: an endpoint may be slow to honor
   * its abort, so each slot stays counted until that endpoint promise settles
   * (see #settleNativeMcp), and a later lane cannot exceed the global bound
   * while the old owner work is still running. Late results are dropped.
   */
  #closeNativeMcpLane(conn: ConnectionState): void {
    const mcp = conn.mcp;
    if (!mcp || mcp.closed) return;
    mcp.closed = true;
    const pending = [...mcp.inFlight.values()];
    mcp.inFlight.clear();
    if (mcp.record.active === conn) mcp.record.active = undefined;
    for (const entry of pending) abortQuietly(entry.controller);
  }

  #onHello(conn: ConnectionState, hello: SessionHostHello): void {
    if (conn.authed || conn.nativeHandled || conn.native !== undefined || conn.mcp !== undefined
      || conn.review !== undefined) {
      // A repeated hello is a protocol violation, never a re-authentication. A
      // native-authenticated/one-shot socket must also never enter the Pi
      // family, even if a later dispatch path reaches this handler.
      this.#destroyConnection(conn);
      return;
    }
    const record = this.#registrations.get(hello.instanceId);
    if (!record || record.released) {
      // Unknown or stale registration: reject without any state change.
      this.#destroyConnection(conn);
      return;
    }
    if (!timingSafeTextEqual(hello.instanceId, record.instanceId)
      || !timingSafeTextEqual(hello.token, record.token)
      || !timingSafeTextEqual(hello.generation, this.generation)) {
      // Wrong token or wrong host generation: reject fail-closed.
      this.#destroyConnection(conn);
      return;
    }

    // Authenticate and bind this connection to its registration.
    conn.authed = true;
    record.activityCensusSupported = hello.capabilities?.includes(ACTIVITY_CENSUS_CAPABILITY) === true;
    if (conn.authTimer) {
      clearTimeout(conn.authTimer);
      conn.authTimer = undefined;
    }
    if (conn.pending) {
      conn.pending = false;
      this.#unauthCount -= 1;
    }
    const previous = record.active;
    if (previous && previous !== conn) {
      // A fresh valid hello supersedes the old socket silently: the replaced
      // connection never counts as a disconnect for the registration.
      this.#failPendingRenames(record, previous, "disconnected");
      previous.superseded = true;
      previous.registration = undefined;
      if (!previous.destroyed) this.#destroyConnection(previous);
    }
    record.active = conn;
    conn.registration = record;
    if ((previous !== undefined || record.lastSequence > 0)
      && typeof record.handlers.onReconnect === "function") {
      // The host may independently discard its cached ephemeral row
      // understanding and request a fresh exact-owner census. A first
      // connection for a fresh registration has no cached row to discard.
      try {
        record.handlers.onReconnect();
      } catch {
        // Contained: a host callback failure never breaks authentication.
      }
    }
  }

  #onStatus(conn: ConnectionState, status: SessionHostStatus): void {
    const record = conn.registration;
    if (!record || !conn.authed || conn.superseded || record.released) {
      // Status before an authenticated hello, or from a superseded/released
      // registration: ignore the frame and end the connection.
      this.#destroyConnection(conn);
      return;
    }
    if (!timingSafeTextEqual(status.instanceId, record.instanceId)
      || !timingSafeTextEqual(status.generation, this.generation)) {
      this.#destroyConnection(conn);
      return;
    }
    if (!Number.isSafeInteger(status.sequence)
      || status.sequence < 1
      || status.sequence <= record.lastSequence) {
      // Non-monotonic (stale/reload-duplicate) sequence: reject.
      this.#destroyConnection(conn);
      return;
    }
    record.lastSequence = status.sequence;
    record.latestNativeSession = status.nativeSession ?? null;
    // The decoded object is the shared-contract snapshot (extra fields were
    // dropped by the shared parser, and the optional owned-work counts were
    // already normalized to a nonnegative safe integer or null). They are
    // forwarded unchanged: the broker owns no inference of zero, and a fresh
    // reporter incarnation re-publishes its own observed counts.
    try {
      record.handlers.onStatus(status);
    } catch {
      // Contained: the broker keeps serving subsequent frames.
    }
  }

  #onSpawnRequest(conn: ConnectionState, request: SessionHostSpawnRequest): void {
    const record = conn.registration;
    if (!record || !conn.authed || conn.superseded || conn.destroyed || record.released || record.active !== conn) {
      this.#destroyConnection(conn);
      return;
    }
    if (!timingSafeTextEqual(request.instanceId, record.instanceId)
      || !timingSafeTextEqual(request.generation, this.generation)
      || !timingSafeTextEqual(request.token, record.token)) {
      this.#destroyConnection(conn);
      return;
    }

    // The digest lets the broker deduplicate exact replays without retaining
    // prompt text after a completed launch. It covers only the bounded
    // reference, never payload contents. Never include it in any result or
    // diagnostic.
    const fingerprint = createHash("sha256")
      .update(JSON.stringify([
        request.type,
        request.workspace,
        request.title,
        request.payload.name,
        request.payload.size,
        request.payload.sha256,
        request.host ?? null,
        request.kind ?? null,
        request.createWorkspace === true,
      ]), "utf8")
      .digest("hex");
    const completed = record.completedSpawns.get(request.requestId);
    if (completed) {
      if (completed.fingerprint !== fingerprint) {
        this.#destroyConnection(conn);
        return;
      }
      this.#sendSpawnAck(record, conn, request.requestId, completed.outcome);
      return;
    }
    const pending = record.pendingSpawns.get(request.requestId);
    if (pending) {
      if (pending.fingerprint !== fingerprint) {
        this.#destroyConnection(conn);
        return;
      }
      // A caller that explicitly replays the same request on the current
      // authenticated connection may receive the eventual result, but the
      // host callback is never invoked twice.
      pending.connection = conn;
      return;
    }
    if (record.shutdownResult !== undefined) {
      // A shutdown preflight/accepted Stop closes this parent's spawn authority.
      // Only the positive idle-only `not-idle` rejection clears that fence in
      // #shutdown; uncertain or accepted shutdowns remain fail closed.
      this.#rejectSpawn(record, request, fingerprint);
      this.#sendSpawnAck(record, conn, request.requestId, "failed");
      return;
    }
    if (record.pendingSpawns.size >= MAX_PENDING_SPAWNS) {
      this.#rejectSpawn(record, request, fingerprint);
      this.#sendSpawnAck(record, conn, request.requestId, "failed");
      return;
    }

    const timer = setTimeout(() => {
      const current = record.pendingSpawns.get(request.requestId);
      if (current) this.#settleSpawn(record, current, "unknown");
    }, spawnTimeoutMsForTests ?? SPAWN_TIMEOUT_MS);
    timer.unref?.();
    const operation: PendingSpawn = {
      requestId: request.requestId,
      fingerprint,
      payload: request.payload,
      connection: conn,
      timer,
      consumed: false,
    };
    record.pendingSpawns.set(request.requestId, operation);

    // A routed request is delivered only to the routed handler; the legacy
    // Pi-only handler never sees it. Without a routed handler the request is
    // refused before any payload read, so no child can be launched. Each
    // handler receives exactly the input shape it accepts, values unchanged.
    const legacyHandler = record.handlers.onSpawnRequest;
    const routedHandler = record.handlers.onRoutedSpawnRequest;
    // A creation request reaches only a routed handler whose registration declared
    // that it honors it; otherwise it is refused here, before any payload read.
    const createWorkspace = hasSessionSpawnCreateWorkspace(request);
    const invokeHost: ((prompt: string) => Promise<SessionSpawnOutcome>) | undefined = requiresRoutedSessionSpawn(request)
      ? typeof routedHandler === "function"
        && (!createWorkspace || hasSessionSpawnCreateWorkspaceHandlers(record.handlers))
        ? (prompt) => routedHandler({
          workspace: request.workspace,
          title: request.title,
          prompt,
          ...(request.host === undefined ? {} : { host: request.host }),
          ...(request.kind === undefined ? {} : { kind: request.kind }),
          ...(createWorkspace ? { createWorkspace: true } : {}),
        })
        : undefined
      : typeof legacyHandler === "function"
        ? (prompt) => legacyHandler({ workspace: request.workspace, title: request.title, prompt })
        : undefined;
    if (invokeHost === undefined) {
      this.#settleSpawn(record, operation, "failed");
      return;
    }
    // Dedupe and admission checks above ran before any read: an exact replay
    // of a completed or still-pending request never re-reads (or re-consumes)
    // the staged payload and never invokes the host callback twice.
    const payloadDir = record.payloadDir;
    void (async () => {
      let prompt: string;
      try {
        if (typeof payloadDir !== "string" || payloadDir.length === 0) {
          throw new Error("payload namespace unavailable");
        }
        const text = await readSessionHostPayload(payloadDir, request.payload, record.payloadDirIdentity);
        // The helper consumed the exact verified file even if the staged JSON
        // value later proves invalid; teardown must not try to re-discard it.
        operation.consumed = true;
        const decoded = decodeSessionHostPayloadJsonString(text);
        if (decoded === undefined) throw new Error("payload is not an exact prompt value");
        prompt = decoded;
      } catch {
        // Missing, tampered, replaced, or undecodable payload: no child is
        // requested and the caller receives a truthful failed launch outcome.
        this.#settleSpawn(record, operation, "failed");
        if (record.released || this.#disposed) this.#removePayloadNamespace(record);
        return;
      }
      if (record.pendingSpawns.get(request.requestId) !== operation
        || record.released || this.#disposed) {
        // Timed out/released while reading. A successful read consumed the
        // verified file; if this namespace is already released, retry its
        // empty-only cleanup now that the file is gone.
        if (record.released || this.#disposed) this.#removePayloadNamespace(record);
        return;
      }
      // Re-check immediately before invoking the host callback: a release or
      // timeout may have settled this operation after the read completed.
      void Promise.resolve().then(async () => {
        if (record.pendingSpawns.get(request.requestId) !== operation
          || record.released || this.#disposed) {
          if (record.released || this.#disposed) this.#removePayloadNamespace(record);
          return;
        }
        let outcome: SessionSpawnOutcome;
        try {
          outcome = await invokeHost(prompt);
        } catch {
          outcome = "unknown";
        }
        this.#settleSpawn(record, operation, isSpawnOutcome(outcome) ? outcome : "unknown");
      });
    })();
  }

  /**
   * One authenticated read-only discovery request. Never launches, connects,
   * pairs, or probes anything itself: it asks the installed handler once and
   * relays a validated canonical snapshot (or `unavailable`) as ordered pages.
   */
  #onHostsRequest(conn: ConnectionState, request: SessionHostHostsRequest): void {
    const record = conn.registration;
    if (!record || !conn.authed || conn.superseded || conn.destroyed || record.released || record.active !== conn) {
      this.#destroyConnection(conn);
      return;
    }
    if (!timingSafeTextEqual(request.instanceId, record.instanceId)
      || !timingSafeTextEqual(request.generation, this.generation)
      || !timingSafeTextEqual(request.token, record.token)) {
      this.#destroyConnection(conn);
      return;
    }
    // A reused request id is never coalesced or replayed: it is a protocol violation.
    if (record.pendingHosts.has(request.requestId) || record.completedHostsRequestIds.has(request.requestId)) {
      this.#destroyConnection(conn);
      return;
    }
    const handler = record.handlers.onSessionHostsRequest;
    if (!hasSessionHostsDiscoveryHandlers(record.handlers) || typeof handler !== "function"
      || record.pendingHosts.size >= MAX_PENDING_HOSTS_REQUESTS) {
      // Not advertised or over the bound: a definite read-only "unavailable".
      this.#rememberHostsRequest(record, request.requestId);
      this.#sendHostsResult(record, conn, request.requestId, undefined);
      return;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => {
      const current = record.pendingHosts.get(request.requestId);
      if (current) this.#settleHostsRequest(record, current, undefined);
    }, hostsTimeoutMsForTests ?? HOSTS_TIMEOUT_MS);
    timer.unref?.();
    const pending: PendingHostsRequest = { requestId: request.requestId, connection: conn, controller, timer };
    record.pendingHosts.set(request.requestId, pending);
    void (async () => {
      let snapshot: unknown;
      try {
        snapshot = await handler({ signal: controller.signal });
      } catch {
        snapshot = undefined;
      }
      this.#settleHostsRequest(record, pending, snapshot);
    })();
  }

  #rememberHostsRequest(record: RegistrationRecord, requestId: string): void {
    record.completedHostsRequestIds.add(requestId);
    while (record.completedHostsRequestIds.size > MAX_COMPLETED_HOSTS_REQUEST_IDS) {
      const oldest = record.completedHostsRequestIds.values().next().value as string | undefined;
      if (oldest === undefined) break;
      record.completedHostsRequestIds.delete(oldest);
    }
  }

  #settleHostsRequest(record: RegistrationRecord, pending: PendingHostsRequest, snapshot: unknown): void {
    if (record.pendingHosts.get(pending.requestId) !== pending) return;
    record.pendingHosts.delete(pending.requestId);
    clearTimeout(pending.timer);
    pending.controller.abort();
    this.#rememberHostsRequest(record, pending.requestId);
    this.#sendHostsResult(record, pending.connection, pending.requestId, snapshot);
  }

  /** Stops waiting without replying: the connection (or registration) is already gone. */
  #abandonHostsRequests(record: RegistrationRecord, connection?: ConnectionState): void {
    for (const pending of [...record.pendingHosts.values()]) {
      if (connection !== undefined && pending.connection !== connection) continue;
      record.pendingHosts.delete(pending.requestId);
      clearTimeout(pending.timer);
      pending.controller.abort();
      this.#rememberHostsRequest(record, pending.requestId);
    }
  }

  /**
   * Writes one complete ordered reply directly (bounded by the page bound and
   * the per-registration concurrency bound), never through the four-frame
   * control queue that could otherwise split or refuse a multi-page reply.
   * A missing or invalid snapshot becomes one `unavailable` page.
   */
  #sendHostsResult(
    record: RegistrationRecord,
    connection: ConnectionState,
    requestId: string,
    snapshot: unknown,
  ): void {
    if (connection.destroyed || connection.superseded || !connection.authed
      || record.released || this.#disposed || record.active !== connection) return;
    let batch: string;
    try {
      batch = encodeSessionHostsResultFrames({
        instanceId: record.instanceId,
        generation: this.generation,
        token: record.token,
        requestId,
      }, snapshot).join("");
    } catch {
      this.#destroyConnection(connection);
      return;
    }
    try {
      connection.socket.write(batch);
    } catch {
      this.#destroyConnection(connection);
    }
  }

  #rememberSpawnResult(
    record: RegistrationRecord,
    requestId: string,
    fingerprint: string,
    outcome: SessionSpawnOutcome,
  ): void {
    record.completedSpawns.delete(requestId);
    record.completedSpawns.set(requestId, { fingerprint, outcome });
    while (record.completedSpawns.size > MAX_COMPLETED_SPAWN_IDS) {
      const oldest = record.completedSpawns.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      record.completedSpawns.delete(oldest);
    }
  }

  #settleSpawn(record: RegistrationRecord, pending: PendingSpawn, outcome: SessionSpawnOutcome): void {
    if (record.pendingSpawns.get(pending.requestId) !== pending) return;
    record.pendingSpawns.delete(pending.requestId);
    clearTimeout(pending.timer);
    // A settled request that never successfully consumed its exact private
    // payload (definite rejection, timeout, or release) is cleaned through a
    // verified discard. Tampered/replaced entries fail verification and stay
    // preserved. A successful read already consumed the file.
    if (!pending.consumed) this.#discardPayload(record, pending.payload);
    this.#rememberSpawnResult(record, pending.requestId, pending.fingerprint, outcome);
    this.#sendSpawnAck(record, pending.connection, pending.requestId, outcome);
  }

  /** Definite pre-read rejection: acknowledge and discard only a verified payload. */
  #rejectSpawn(
    record: RegistrationRecord,
    request: SessionHostSpawnRequest,
    fingerprint: string,
  ): void {
    this.#rememberSpawnResult(record, request.requestId, fingerprint, "failed");
    this.#discardPayload(record, request.payload);
  }

  /**
   * Best-effort verified discard scheduled outside the frame path. Namespace
   * removal is retried only once the registration is released or the broker is
   * disposing, so an active registration keeps its capability.
   */
  #discardPayload(record: RegistrationRecord, payload: SessionHostPayloadRef): void {
    const task = discardSessionHostPayload(record.payloadDir, payload, record.payloadDirIdentity)
      .catch(() => undefined)
      .finally(() => {
        this.#payloadCleanups.delete(task);
        if (record.released || this.#disposed) this.#removePayloadNamespace(record);
      });
    this.#payloadCleanups.add(task);
  }

  #sendSpawnAck(
    record: RegistrationRecord,
    connection: ConnectionState,
    requestId: string,
    outcome: SessionSpawnOutcome,
  ): void {
    if (connection.destroyed || connection.superseded || !connection.authed
      || record.released || record.active !== connection) return;
    const ack: SessionHostSpawnAck = {
      version: PROTOCOL_VERSION,
      type: "spawn_result",
      instanceId: record.instanceId,
      generation: this.generation,
      requestId,
      outcome,
    };
    try {
      this.#queueRenameFrame(connection, encodeFrame(ack));
    } catch {
      this.#destroyConnection(connection);
    }
  }

  #onActivityResult(conn: ConnectionState, result: SessionHostActivityResult): void {
    const record = conn.registration;
    if (!record || !conn.authed || conn.superseded || record.released || record.active !== conn) {
      this.#destroyConnection(conn);
      return;
    }
    const pending = record.pendingActivity;
    const completed = record.completedActivityRequests.get(result.requestId);
    // A reply for a previously settled/timed-out request can arrive while the
    // bounded follow-up is pending. It never satisfies or disturbs that newer
    // request; a genuinely newer complete snapshot is still applied.
    if (!pending || pending.request.requestId !== result.requestId) {
      if (completed) {
        // A timed-out request may still produce one late COMPLETE reply. It is
        // applied only when it is a genuinely newer, exact-session snapshot;
        // stale sessions/incarnations and non-complete outcomes are ignored.
        const late: SessionHostActivityRequest = {
          version: PROTOCOL_VERSION,
          type: "activity_request",
          instanceId: record.instanceId,
          generation: this.generation,
          token: record.token,
          requestId: result.requestId,
          afterSequence: completed.afterSequence,
          expectedSessionId: completed.expectedSessionId,
          expectedSessionEpoch: completed.expectedSessionEpoch,
        };
        if (classifyActivityResult(result, late, record.instanceId, this.generation, record.lastSequence) === "complete") {
          const status = result.status!;
          record.lastSequence = status.sequence;
          record.latestNativeSession = status.nativeSession ?? null;
          record.completedActivityRequests.delete(result.requestId);
          try {
            record.handlers.onStatus(status);
          } catch {
            // Contained: the broker keeps serving subsequent frames.
          }
        }
        return;
      }
      this.#destroyConnection(conn);
      return;
    }
    if (pending.connection !== conn) {
      this.#destroyConnection(conn);
      return;
    }
    const classification = classifyActivityResult(
      result,
      pending.request,
      record.instanceId,
      this.generation,
      record.lastSequence,
    );
    if (classification === "invalid") {
      this.#destroyConnection(conn);
      return;
    }
    if (classification === "stale") {
      this.#settleActivity(record, pending, {
        requestId: result.requestId,
        status: "stale",
      });
      return;
    }
    if (classification === "unavailable") {
      this.#settleActivity(record, pending, {
        requestId: result.requestId,
        status: "unavailable",
      });
      return;
    }
    const status = result.status!;
    // Commit the fresh observation exactly as an ordinary status snapshot.
    // The registration keeps one monotonic sequence fence for both pushed
    // frames and requested replies, so neither path self-invalidates a valid
    // current snapshot from the other.
    record.lastSequence = status.sequence;
    record.latestNativeSession = status.nativeSession ?? null;
    try {
      record.handlers.onStatus(status);
    } catch {
      // Contained: the broker keeps serving subsequent frames.
    }
    this.#settleActivity(record, pending, {
      requestId: result.requestId,
      status: "complete",
    });
  }

  #onRenameAck(conn: ConnectionState, ack: SessionHostRenameAck): void {
    const record = conn.registration;
    if (!record || !conn.authed || conn.superseded || record.released || record.active !== conn) {
      this.#destroyConnection(conn);
      return;
    }
    const pending = record.pendingRenames.get(ack.requestId);
    if (!pending) {
      // A timed-out/settled request may produce one late response. It is
      // acknowledged only as stale and can never satisfy another request.
      if (record.completedRenameIds.has(ack.requestId)) return;
      this.#destroyConnection(conn);
      return;
    }
    if (pending.connection !== conn) {
      this.#destroyConnection(conn);
      return;
    }
    const classification = classifyRenameAck(
      ack,
      pending.request,
      record.instanceId,
      this.generation,
      record.latestNativeSession,
    );
    if (classification === "invalid") {
      this.#destroyConnection(conn);
      return;
    }
    if (classification === "stale-session") {
      this.#settleRename(record, pending, {
        requestId: ack.requestId,
        status: "stale-session",
        expectedSessionId: ack.expectedSessionId,
        expectedSessionEpoch: ack.expectedSessionEpoch,
        ...this.#observedTuple(record),
      });
      return;
    }
    const status: StatusRenameStatus = ack.outcome === "renamed"
      ? "renamed"
      : ack.reason === "stale-session" || ack.reason === "unavailable" || ack.reason === "invalid-name"
        || ack.reason === "setter-failed" || ack.reason === "verification-failed"
        ? ack.reason
        : "verification-failed";
    this.#settleRename(record, pending, {
      requestId: ack.requestId,
      status,
      expectedSessionId: ack.expectedSessionId,
      expectedSessionEpoch: ack.expectedSessionEpoch,
      observedSessionId: ack.sessionId,
      observedSessionEpoch: ack.sessionEpoch,
    });
  }

  #onShutdownAck(conn: ConnectionState, ack: SessionHostShutdownAck): void {
    const record = conn.registration;
    if (!record || !conn.authed || conn.superseded || record.released || record.active !== conn) {
      this.#destroyConnection(conn);
      return;
    }
    const pending = record.pendingShutdowns.get(ack.requestId);
    if (!pending) {
      // A timed-out/settled request may produce one late response. It can
      // never satisfy a later request or be interpreted as process exit.
      if (record.completedShutdownIds.has(ack.requestId)) return;
      this.#destroyConnection(conn);
      return;
    }
    if (pending.connection !== conn) {
      this.#destroyConnection(conn);
      return;
    }
    const classification = classifyShutdownAck(
      ack,
      pending.request,
      record.instanceId,
      this.generation,
      record.latestNativeSession,
    );
    if (classification === "invalid") {
      this.#destroyConnection(conn);
      return;
    }
    this.#settleShutdown(record, pending, {
      requestId: ack.requestId,
      status: classification === "stale-session" ? "rejected"
        : ack.outcome === "rejected" && ack.reason === "not-idle" ? "not-idle" : ack.outcome,
    });
  }

  /** Ends a connection; the close handler decides what (if anything) is reported. */
  #destroyConnection(conn: ConnectionState): void {
    if (conn.destroyed) return;
    conn.destroyed = true;
    if (conn.authTimer) {
      clearTimeout(conn.authTimer);
      conn.authTimer = undefined;
    }
    if (conn.nativeCloseTimer) {
      clearTimeout(conn.nativeCloseTimer);
      conn.nativeCloseTimer = undefined;
    }
    // Native delivery slots and bounded refusal accounting are independent of
    // the Pi connection lifecycle; free both before tearing the socket down.
    this.#releaseNativeHookSlot(conn);
    this.#releaseNativeRefused(conn);
    this.#closeNativeMcpLane(conn);
    this.#closeNativeReviewLane(conn);
    try {
      conn.socket.destroy();
    } catch {
      // Best-effort teardown.
    }
  }

  #onClose(conn: ConnectionState): void {
    this.#connections.delete(conn);
    if (conn.authTimer) {
      clearTimeout(conn.authTimer);
      conn.authTimer = undefined;
    }
    if (conn.nativeCloseTimer) {
      clearTimeout(conn.nativeCloseTimer);
      conn.nativeCloseTimer = undefined;
    }
    // A native one-shot close is normal after its ACK and never becomes a
    // failure or a Pi disconnect callback. Free only its separate slot and
    // refusal accounting.
    this.#releaseNativeHookSlot(conn);
    this.#releaseNativeRefused(conn);
    // A native MCP lane that closes for any reason aborts its in-flight work.
    this.#closeNativeMcpLane(conn);
    // A held native review request whose socket closed aborts its host signal.
    this.#closeNativeReviewLane(conn);
    if (conn.pending && !conn.authed) {
      conn.pending = false;
      this.#unauthCount -= 1;
    }
    const record = conn.registration;
    // Only a genuinely currently-owned authenticated connection counts as a
    // disconnect: replacements, releases, disposals, and unauthenticated or
    // superseded sockets stay silent so the manager can mark its metadata
    // unknown without false churn.
    if (!conn.superseded && conn.authed && record && !record.released
      && record.active === conn && !this.#disposed) {
      if (record.active === conn) {
        this.#failPendingRenames(record, conn, "disconnected");
        record.active = undefined;
      }
      try {
        record.handlers.onDisconnect();
      } catch {
        // Contained: never throw into the native process.
      }
    }
  }

  /** Idempotent native source invalidation; no adoption, queue, replay, or later callback. */
  #releaseNativeHookSource(record: NativeHookSourceRecord): void {
    if (record.released) return;
    record.released = true;
    this.#nativeSources.delete(record.instanceId);
    // Any authenticated one-shot socket still owned by this launch is closed
    // silently. Its callback (if any) already ran synchronously; late frames and
    // late closes can never invoke another callback or mutate a valid row.
    for (const conn of [...this.#connections]) {
      if (conn.native === record) this.#destroyConnection(conn);
    }
  }

  /** Idempotent native MCP revocation: closes the lane silently and aborts in-flight work. */
  #releaseNativeMcpSource(record: NativeMcpSourceRecord): void {
    if (record.released) return;
    record.released = true;
    if (this.#nativeMcpSources.get(record.instanceId) === record) this.#nativeMcpSources.delete(record.instanceId);
    const active = record.active;
    if (active) this.#destroyConnection(active);
  }

  #releaseRegistration(record: RegistrationRecord): void {
    if (record.released) return;
    record.released = true;
    // Intentional release: the active connection is closed silently (its
    // close callback is suppressed), and later hellos are rejected as stale.
    if (record.active && !record.active.destroyed) {
      this.#failPendingRenames(record, record.active, "disconnected");
      record.active.superseded = true;
      record.active.registration = undefined;
      this.#destroyConnection(record.active);
    }
    if (record.pendingActivity) {
      this.#settleActivity(record, record.pendingActivity, {
        requestId: record.pendingActivity.request.requestId,
        status: "disconnected",
      });
    }
    for (const pending of [...record.pendingRenames.values()]) {
      this.#settleRename(record, pending, {
        requestId: pending.request.requestId,
        status: "disconnected",
        expectedSessionId: pending.request.expectedSessionId,
        expectedSessionEpoch: pending.request.expectedSessionEpoch,
        ...this.#observedTuple(record),
      });
    }
    for (const pending of [...record.pendingShutdowns.values()]) {
      this.#settleShutdown(record, pending, {
        requestId: pending.request.requestId,
        status: "disconnected",
      });
    }
    for (const pending of [...record.pendingSpawns.values()]) this.#settleSpawn(record, pending, "unknown");
    this.#abandonHostsRequests(record);
    this.#removePayloadNamespace(record);
    record.active = undefined;
    this.#registrations.delete(record.instanceId);
  }

  /** Removes only this broker-created namespace, and only while it is empty and unchanged. */
  #removePayloadNamespace(record: RegistrationRecord): void {
    removeOwnEmptyPayloadDirectory(record.payloadDir, record.payloadDirIdentity);
  }
}

/**
 * Creates one fresh broker-owned local endpoint. POSIX uses a private mkdtemp
 * directory (0700) and its own Unix socket (0600); Windows uses only a
 * cryptorandom public-Node named pipe in the local `\\.\pipe\prg-st-` namespace.
 * No daemon adoption, foreign-endpoint cleanup, or child-process/profile work.
 *
 * The factory is typed with the WIDEST family set the real broker implements, so
 * a caller of `createStatusBroker()` can register any family — including a native
 * review source — without a cast. Callers and test fakes that use fewer families
 * keep naming the narrower interfaces (`StatusBroker`, `NativeHookStatusBroker`,
 * `NativeMcpStatusBroker`); every wider broker satisfies them.
 */
export async function createStatusBroker(options: StatusBrokerOptions = {}): Promise<NativeReviewStatusBroker> {
  const platform = brokerPlatformForTests ?? process.platform;
  if (platform === "win32") {
    const socketPath = `${WINDOWS_PIPE_PREFIX}${randomBytes(16).toString("hex")}`;
    const broker = new LocalStatusBroker({ kind: "pipe", socketPath });
    try {
      await broker.listen();
    } catch (error) {
      await broker.dispose().catch(() => undefined);
      throw error;
    }
    return broker;
  }
  const root = canonicalSocketRoot(options.socketRoot ?? os.tmpdir());
  // mkdtempSync creates a unique directory with mode 0700; re-assert the
  // private mode explicitly so the transport can never depend on a umask.
  const transportDir = mkdtempSync(join(root, TRANSPORT_DIR_PREFIX));
  const transportStats = lstatSync(transportDir);
  const transportIdentity: OwnedPathIdentity = {
    dev: transportStats.dev,
    ino: transportStats.ino,
  };
  chmodSync(transportDir, 0o700);
  const socketPath = join(transportDir, SOCKET_FILENAME);
  // macOS Unix-socket path length (~100 bytes of usable sun_path) is the
  // real limit, not the protocol's 2048-byte validation bound; fail clearly.
  if (Buffer.byteLength(socketPath, "utf8") > (socketPathLimitForTests ?? MAX_SOCKET_PATH_BYTES)) {
    removeOwnEmptyDirectory(transportDir, transportIdentity);
    throw new Error(
      `pi-review-gate: the session-host status socket path exceeds the ${MAX_SOCKET_PATH_BYTES}-byte OS Unix-socket limit; pass a shorter socketRoot`,
    );
  }
  let preexisting = false;
  try {
    lstatSync(socketPath);
    preexisting = true;
  } catch {
    // Expected: nothing exists yet in our fresh private directory.
  }
  if (preexisting) {
    // An anomaly in a dir we just created: never adopt or unlink it.
    removeOwnEmptyDirectory(transportDir, transportIdentity);
    throw new Error(
      `pi-review-gate: unexpected pre-existing entry at the session-host status socket path; refusing to adopt it`,
    );
  }
  const broker = new LocalStatusBroker({
    kind: "unix",
    transportDir,
    transportIdentity,
    socketPath,
  });
  try {
    await broker.listen();
  } catch (error) {
    await broker.dispose().catch(() => undefined);
    throw error;
  }
  return broker;
}