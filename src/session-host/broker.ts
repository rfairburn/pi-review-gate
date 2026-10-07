/**
 * Authenticated bounded local status broker for independently owned native
 * instances (issue #323 optional POSIX alpha).
 *
 * Each broker owns one private freshly-created Unix-socket transport
 * (mkdtemp directory, mode 0700; own socket file, mode 0600) beneath a
 * canonical caller-supplied socket root directory or the OS temp directory.
 * Independently owned native instances register themselves BEFORE their PTY
 * is spawned and receive a per-registration cryptorandom token to present in
 * the protocol hello frame (see ./protocol). The broker then accepts a
 * bounded stream of newline-delimited JSON status frames from each
 * authenticated reporter connection and forwards sanitized snapshot callbacks
 * to that registration's handlers.
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
  type SessionHostStatus,
  MAX_STATUS_FRAME_BYTES,
  PROTOCOL_VERSION,
  decodeFrame,
  parseBootstrap,
} from "./protocol";

/** Options accepted by {@link createStatusBroker}. */
export interface StatusBrokerOptions {
  /** Canonical existing directory that will contain the broker's private transport directory. */
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
  /** Releases the registration: closes its active connection silently, rejects later hellos. */
  release: () => void;
}

/** The broker facade consumed by the future session-host manager. */
export interface StatusBroker {
  /** Absolute path of the broker-owned Unix socket (already bound). */
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

/**
 * Conservative cap on the broker socket path length in UTF-8 bytes. macOS
 * Unix-socket addressing (sun_path 104 bytes including the terminating NUL)
 * only fits ~100 real path characters even though Linux allows 107; the
 * protocol's 2048-byte path validation is never treated as an actual socket
 * limit here, and over-long roots fail with a clear diagnostic instead.
 */
const MAX_SOCKET_PATH_BYTES = 103;

/** Private temp directory name prefix for the broker transport (kept short: macOS sun_path is tiny). */
const TRANSPORT_DIR_PREFIX = "prg-st-";

/** Own socket filename inside the private transport directory (short: macOS sun_path is tiny). */
const SOCKET_FILENAME = "s.sock";

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
  active: ConnectionState | undefined;
  handlers: StatusBrokerStatusHandlers;
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
}

/** Verifies two strings are equal without content-dependent timing. */
function timingSafeTextEqual(left: string, right: string): boolean {
  return timingSafeEqual(
    createHash("sha256").update(left, "utf8").digest(),
    createHash("sha256").update(right, "utf8").digest(),
  );
}

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

  #transportDir: string;
  #transportIdentity: OwnedPathIdentity;
  #socketIdentity: OwnedPathIdentity | undefined;
  #server: Server | undefined;
  #registrations = new Map<string, RegistrationRecord>();
  #connections = new Set<ConnectionState>();
  #unauthCount = 0;
  #disposed = false;
  #disposal: Promise<void> | undefined;

  constructor(transportDir: string, socketPath: string, transportIdentity: OwnedPathIdentity) {
    this.#transportDir = transportDir;
    this.#transportIdentity = transportIdentity;
    this.socketPath = socketPath;
    this.generation = randomUUID();
  }

  /** Binds the server; resolves only once the socket exists with private permissions. */
  async listen(): Promise<void> {
    const server = createServer();
    this.#server = server;
    // A persistent error handler keeps server/listen failures controlled:
    // status-metadata failures must never affect the native PTY processes.
    server.on("error", () => {
      // Controlled: surfaced through listen/promise paths only, never thrown
      // into the native process, and nothing about it is logged.
    });
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
      release: () => this.#releaseRegistration(record),
    };
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
      removeOwnEmptyDirectory(this.#transportDir, this.#transportIdentity);
    });
  }

  /**
   * Stages the listen pathname so Node's automatic close-time unlink cannot
   * target an entry that replaced our socket. The unknown occupant is moved
   * only within our private directory and restored after server.close().
   */
  #stageSocketPathTeardown(): SocketPathTeardown {
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
        const quarantineDir = mkdtempSync(join(this.#transportDir, ".dispose-"));
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
    } else {
      this.#onStatus(conn, message);
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
    if (previous && previous !== conn && !previous.destroyed) {
      // A fresh valid hello supersedes the old socket silently: the replaced
      // connection never counts as a disconnect for the registration.
      previous.superseded = true;
      previous.registration = undefined;
      this.#destroyConnection(previous);
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
    // The decoded object is the shared-contract snapshot (extra fields were
    // dropped by the shared parser); guard callback errors so status-metadata
    // failures can never reach the native process, with no content logging.
    try {
      record.handlers.onStatus(status);
    } catch {
      // Contained: the broker keeps serving subsequent frames.
    }
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
      record.active.superseded = true;
      record.active.registration = undefined;
      this.#destroyConnection(record.active);
    }
    record.active = undefined;
    this.#registrations.delete(record.instanceId);
  }
}

/**
 * Creates the broker's private, freshly-created transport: a unique mkdtemp
 * directory (mode 0700) inside the canonical existing socket root
 * (or the OS temp directory), with the broker's own Unix socket (mode 0600).
 * POSIX only in this alpha; no daemon adoption, no pre-existing socket
 * unlinking, and no child-process or profile work.
 */
export async function createStatusBroker(options: StatusBrokerOptions = {}): Promise<StatusBroker> {
  if (process.platform === "win32") {
    throw new Error(
      `pi-review-gate: the native session-host status broker supports POSIX platforms only in this alpha; ${process.platform} must launch pi through the standard pi-review-gate wrapper`,
    );
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
  if (Buffer.byteLength(socketPath, "utf8") > MAX_SOCKET_PATH_BYTES) {
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
  const broker = new LocalStatusBroker(transportDir, socketPath, transportIdentity);
  try {
    await broker.listen();
  } catch (error) {
    await broker.dispose().catch(() => undefined);
    throw error;
  }
  return broker;
}