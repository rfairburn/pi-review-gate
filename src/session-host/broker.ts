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
  type SessionHostBootstrap,
  type SessionHostHello,
  type SessionHostNativeSession,
  type SessionHostRenameAck,
  type SessionHostRenameRequest,
  type SessionHostShutdownAck,
  type SessionHostShutdownRequest,
  type SessionHostStatus,
  MAX_STATUS_FRAME_BYTES,
  PROTOCOL_VERSION,
  decodeFrame,
  encodeFrame,
  isValidNativeSessionId,
  isValidRenameName,
  parseBootstrap,
} from "./protocol";

/** Options accepted by {@link createStatusBroker}. */
export interface StatusBrokerOptions {
  /** Canonical existing POSIX directory for the private transport; unused by Windows named pipes. */
  socketRoot?: string;
}

/** Callbacks bound to one registration; always guard-wrapped by the broker. */
export interface StatusBrokerStatusHandlers {
  /** Bounded snapshot callback; arguments come only from the shared contract. */
  onStatus: (status: SessionHostStatus) => void;
  /** Fired only when a currently-owned authenticated connection actually disconnects. */
  onDisconnect: () => void;
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
  shutdown: () => Promise<StatusShutdownResult>;
  /** Releases the registration: closes its active connection silently, rejects later hellos. */
  release: () => void;
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

export type StatusShutdownStatus = "requested" | "rejected" | "unavailable" | "busy" | "timeout" | "disconnected";

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
  register(instanceId: string, handlers: StatusBrokerStatusHandlers): StatusRegistration;
  /** Idempotent final cleanup: timers, sockets, own socket file, and own empty directory. */
  dispose(): Promise<void>;
}

/** Maximum unauthenticated connections held in parallel (beyond the registered active connections). */
const MAX_PENDING_UNAUTH_CONNECTIONS = 32;

/** Short authentication deadline; later a connection without a valid hello is closed. */
const AUTH_DEADLINE_MS = 2000;
const RENAME_TIMEOUT_MS = 5000;
const SHUTDOWN_TIMEOUT_MS = 5000;
const WINDOWS_PIPE_LISTEN_TIMEOUT_MS = 5000;
const WINDOWS_PIPE_CLOSE_TIMEOUT_MS = 5000;
const MAX_PENDING_RENAMES = 4;
const MAX_PENDING_SHUTDOWNS = 1;
const MAX_PENDING_CONTROL_FRAMES = 4;
const MAX_COMPLETED_RENAME_IDS = 64;
const MAX_COMPLETED_SHUTDOWN_IDS = 64;

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
  shutdownResult: Promise<StatusShutdownResult> | undefined;
  active: ConnectionState | undefined;
  handlers: StatusBrokerStatusHandlers;
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
  /** At most four bounded rename/shutdown control frames are coalesced per socket write turn. */
  renameWriteQueue: string[];
  renameWriteScheduled: boolean;
}

/** Verifies two strings are equal without content-dependent timing. */
function timingSafeTextEqual(left: string, right: string): boolean {
  return timingSafeEqual(
    createHash("sha256").update(left, "utf8").digest(),
    createHash("sha256").update(right, "utf8").digest(),
  );
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

/** Test-only override allows root-bound fixtures to express the same local path relatively. */
let socketPathLimitForTests: number | undefined;
let brokerPlatformForTests: NodeJS.Platform | undefined;
let createServerForTests: (() => Server) | undefined;
let windowsPipeListenTimeoutForTests: number | undefined;
let windowsPipeCloseTimeoutForTests: number | undefined;

/** Narrow seams for protocol policy tests and root-bound socket fixtures. */
export const __test = Object.freeze({
  classifyRenameAck,
  classifyShutdownAck,
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

class LocalStatusBroker implements StatusBroker {

  readonly socketPath: string;
  readonly generation: string;

  #transport: BrokerTransport;
  #socketIdentity: OwnedPathIdentity | undefined;
  #server: Server | undefined;
  #listenSucceeded = false;
  #listenHandleClosed = false;
  #latePipeCloseStarted = false;
  #registrations = new Map<string, RegistrationRecord>();
  #connections = new Set<ConnectionState>();
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

  register(instanceId: string, handlers: StatusBrokerStatusHandlers): StatusRegistration {
    if (this.#disposed) {
      throw new Error("pi-review-gate: the session-host status broker is disposed; no further registrations are accepted");
    }
    if (typeof handlers?.onStatus !== "function" || typeof handlers?.onDisconnect !== "function") {
      throw new Error("pi-review-gate: the session-host registration requires onStatus and onDisconnect callbacks");
    }
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

    const token = randomBytes(32).toString("hex");
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
      shutdownResult: undefined,
      active: undefined,
      handlers,
    };
    this.#registrations.set(instanceId, record);
    const bootstrap: SessionHostBootstrap = {
      version: PROTOCOL_VERSION,
      socketPath: this.socketPath,
      token,
      instanceId,
      generation: this.generation,
    };
    return {
      bootstrap,
      rename: (request) => this.#rename(record, request),
      shutdown: () => this.#shutdown(record),
      release: () => this.#releaseRegistration(record),
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

  #shutdown(record: RegistrationRecord): Promise<StatusShutdownResult> {
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
    return promise;
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

  async dispose(): Promise<void> {
    if (!this.#disposal) {
      this.#disposal = this.#performDispose();
    }
    return this.#disposal;
  }

  async #performDispose(): Promise<void> {
    this.#disposed = true;
    for (const record of this.#registrations.values()) {
      record.released = true;
      if (record.active) this.#failPendingRenames(record, record.active, "disconnected");
      record.active = undefined;
    }
    this.#registrations.clear();
    for (const conn of [...this.#connections]) {
      // Mark everything superseded so late close callbacks stay silent: an
      // intentional dispose never fires onDisconnect.
      conn.superseded = true;
      conn.registration = undefined;
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
    socket.on("error", () => {
      this.#destroyConnection(conn);
    });
    socket.on("close", () => this.#onClose(conn));
  }

  /** Newline-framed reading in raw UTF-8 bytes, strictly bounded before decoding. */
  #onData(conn: ConnectionState, chunk: Buffer): void {
    if (conn.destroyed || conn.superseded) return; // late/superseded frames are ignored
    let offset = 0;
    while (offset < chunk.length) {
      const newlineIndex = chunk.indexOf(0x0a, offset);
      if (newlineIndex === -1) {
        const remainingLength = chunk.length - offset;
        const frameLength = conn.buffered.length + remainingLength;
        if (frameLength + 1 > MAX_STATUS_FRAME_BYTES) {
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
      if (frameLength + 1 > MAX_STATUS_FRAME_BYTES) {
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
      if (!this.#handleLine(conn, lineBytes)) return;
    }
  }

  /** Routes one bounded line; false means the connection is no longer usable. */
  #handleLine(conn: ConnectionState, lineBytes: Buffer): boolean {
    let line: string;
    try {
      line = new TextDecoder("utf-8", { fatal: true }).decode(lineBytes);
    } catch {
      // Invalid UTF-8 is malformed wire data, not replacement-character text.
      this.#destroyConnection(conn);
      return false;
    }
    let message: ReturnType<typeof decodeFrame>;
    try {
      message = decodeFrame(line);
    } catch {
      // A parser failure is contained at the local transport boundary too.
      message = undefined;
    }
    if (message === undefined) {
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
    } else {
      this.#destroyConnection(conn); // Reporter processes may never issue host commands.
    }
    return !conn.destroyed && !conn.superseded;
  }

  #onHello(conn: ConnectionState, hello: SessionHostHello): void {
    if (conn.authed) {
      // A repeated hello is a protocol violation, never a re-authentication.
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
    // dropped by the shared parser); guard callback errors so status-metadata
    // failures can never reach the native process, with no content logging.
    try {
      record.handlers.onStatus(status);
    } catch {
      // Contained: the broker keeps serving subsequent frames.
    }
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
      status: classification === "stale-session" ? "rejected" : ack.outcome,
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
    record.active = undefined;
    this.#registrations.delete(record.instanceId);
  }
}

/**
 * Creates one fresh broker-owned local endpoint. POSIX uses a private mkdtemp
 * directory (0700) and its own Unix socket (0600); Windows uses only a
 * cryptorandom public-Node named pipe in the local `\\.\pipe\prg-st-` namespace.
 * No daemon adoption, foreign-endpoint cleanup, or child-process/profile work.
 */
export async function createStatusBroker(options: StatusBrokerOptions = {}): Promise<StatusBroker> {
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