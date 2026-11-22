/**
 * #682: stdio relay entry for the hosted native MCP tool lane.
 *
 * A native Claude or Codex CLI launches this compiled module as its own MCP
 * stdio server child:
 *
 *     node <dist>/session-host/native-mcp-relay.js --bootstrap-file <path>
 *
 * The relay serves MCP over its own stdin/stdout through the existing
 * {@link NativeMcpStdioSession} adapter. That adapter's tool endpoint is a
 * broker-backed lane: one authenticated connection to the host's existing
 * local status broker (./broker, family ./native-mcp-protocol), which
 * delivers each validated operation to the trusted endpoint the host
 * registered for this launch. The relay is pure transport: it holds no tool
 * schemas, decides no ownership, authorizes no tool, and passes no client
 * identity or metadata.
 *
 * Credential handling. Only the bootstrap file PATH appears in argv; the
 * token never appears in argv, the environment, stdout, stderr, or an
 * outcome. Before anything else the relay refuses to run when a delegated
 * worker-role marker is present. It then reads the bootstrap exactly once,
 * and only when:
 *
 * - the path is absolute and canonical, its parent is a real directory
 *   private to this user, and no component from `/` down to that parent can
 *   be replaced by another local user (the same walk as the broker socket
 *   check, {@link isProtectedNativeMcpSocketPath}), so the pathname cannot be
 *   swapped between validation, open, and unlink;
 * - the file is a regular file (never a symlink, FIFO, or device), has a
 *   single link, is owned by this user with no group/other bits (POSIX), is
 *   non-empty and at most {@link MAX_NATIVE_MCP_BOOTSTRAP_BYTES}, is opened
 *   without following links, and keeps the same identity across lstat, open,
 *   and read;
 * - its bytes are strict UTF-8 and exactly the canonical bootstrap encoding.
 *
 * A valid file is then consumed (unlinked after an identity re-check); if it
 * cannot be consumed the relay fails closed. An invalid file is left in place
 * for its owner's cleanup. On Windows the public Node API cannot establish
 * the file's owner or that its access control list is owner-only, and
 * consuming a readable file after the fact does not make it private, so the
 * reader refuses every Windows bootstrap (`platform_unverifiable`) without
 * opening it. None of this protects against other processes running as the
 * same user.
 *
 * Endpoint trust. The hello carries the token in the relay's first write, so
 * on POSIX the relay first verifies (see {@link isProtectedNativeMcpSocketPath})
 * that no other local user could have replaced any component of the socket
 * path, and otherwise refuses (`unprotected`) without connecting.
 *
 * Transport truthfulness. The relay connects once with a bounded connect and
 * ready deadline and never reconnects. Each MCP request is sent at most once
 * and never retried. The results distinguish:
 *
 * - not sent (lane closed, request unencodable, or broker `busy`): a fixed
 *   tool error saying nothing ran;
 * - delivered and answered: forwarded as the endpoint answered;
 * - delivered, result too large: a fixed tool error saying effects may have
 *   been applied;
 * - delivered, endpoint failed, or the lane closed while the request was in
 *   flight: a rejection, which the stdio adapter answers with its fixed
 *   "effects are unknown, not retried" error.
 *
 * MCP cancellation aborts locally and sends one `native_mcp_cancel`; the
 * request stays counted until the broker answers or the lane closes. After
 * the lane closes the relay keeps answering MCP with "not sent" errors until
 * its input ends. Startup failures and abnormal stdio closures (anything but
 * a clean input end or intentional disposal) write one closed code to stderr
 * and exit nonzero; nothing else is ever written to stderr.
 */

import { Buffer } from "node:buffer";
import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  unlinkSync,
  type BigIntStats,
} from "node:fs";
import { createConnection, type Socket } from "node:net";
import { dirname, isAbsolute, resolve as resolvePath } from "node:path";
import type { Readable, Writable } from "node:stream";
import { EXECUTOR_TOOL_CATALOG_ENV, RUNTIME_ROLE_ENV } from "./launch";
import {
  MAX_NATIVE_MCP_BOOTSTRAP_BYTES,
  MAX_NATIVE_MCP_CONTROL_FRAME_BYTES,
  MAX_NATIVE_MCP_IN_FLIGHT_PER_CONNECTION,
  MAX_NATIVE_MCP_REQUEST_FRAME_BYTES,
  MAX_NATIVE_MCP_RESPONSE_FRAME_BYTES,
  NativeMcpFrameReader,
  decodeNativeMcpBootstrap,
  decodeNativeMcpServerFrame,
  encodeNativeMcpClientFrame,
  encodeNativeMcpHello,
  type NativeMcpBootstrap,
  type NativeMcpRequestFrame,
  type NativeMcpResponseFrame,
} from "./native-mcp-protocol";
import {
  NativeMcpStdioSession,
  type NativeMcpCallToolRequest,
  type NativeMcpCallToolResult,
  type NativeMcpListToolsRequest,
  type NativeMcpStdioCloseReason,
  type NativeMcpToolDescriptor,
  type NativeMcpToolEndpoint,
} from "./native-mcp-stdio";

/** The only accepted argv shape is exactly this flag followed by one absolute path. */
export const NATIVE_MCP_RELAY_BOOTSTRAP_FLAG = "--bootstrap-file";

/** Upper bound for establishing the broker connection. */
export const NATIVE_MCP_RELAY_CONNECT_TIMEOUT_MS = 2000;

/** Upper bound for the broker's `ready` after the hello (the broker's own auth deadline is 2 s). */
export const NATIVE_MCP_RELAY_READY_TIMEOUT_MS = 2500;

/**
 * Upper bound for flushing output already accepted by stdout before the
 * process exits. A client that never reads cannot hold the relay alive.
 */
export const NATIVE_MCP_RELAY_FLUSH_TIMEOUT_MS = 5000;

/** Fixed MCP serverInfo; it carries no host, row, or launch identity. */
export const NATIVE_MCP_RELAY_SERVER_INFO = Object.freeze({ name: "pi-review-gate", version: "1" });

/** Unflushed request bytes the relay may hold toward the broker before refusing new requests as not sent. */
const MAX_RELAY_PENDING_OUTBOUND_BYTES = 2 * MAX_NATIVE_MCP_REQUEST_FRAME_BYTES;

const MAX_BOOTSTRAP_PATH_BYTES = 4096;

const NOT_SENT_CLOSED = "The host tool connection is closed; the call was not sent and nothing ran.";
const NOT_SENT_UNENCODABLE = "The call could not be encoded for the host transport; it was not sent and nothing ran.";
const NOT_SENT_BUSY = "The host is busy; the call was not run.";
const RESULT_WITHHELD = "Tool result withheld: it exceeded the host transport limit. The call was not retried and its effects may have been applied.";

export type NativeMcpBootstrapFileFailure =
  | "platform_unverifiable"
  | "path_invalid"
  | "parent_invalid"
  | "file_invalid"
  | "read_failed"
  | "record_invalid"
  | "consume_failed";

export type NativeMcpBootstrapFileResult =
  | { readonly ok: true; readonly bootstrap: NativeMcpBootstrap }
  | { readonly ok: false; readonly reason: NativeMcpBootstrapFileFailure };

export interface NativeMcpBootstrapFileOptions {
  /**
   * Focused-test seam for the ancestry walk only (it can describe a tree the
   * test cannot build); every file-level check, open, and unlink always uses
   * the real filesystem. Production never passes it.
   */
  readonly ancestryLstat?: (path: string) => NativeMcpPathStats;
  /** Test seam for the platform refusal; defaults to the running platform. */
  readonly platform?: NodeJS.Platform;
}

function sameIdentity(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function currentUid(): bigint | undefined {
  return typeof process.getuid === "function" ? BigInt(process.getuid()) : undefined;
}

function privateOwned(stats: BigIntStats, uid: bigint | undefined): boolean {
  return uid !== undefined && stats.uid === uid && (stats.mode & 0o077n) === 0n;
}

/**
 * Reads, validates, and consumes one private per-launch bootstrap file. Never
 * throws; every failure is a closed reason that carries no file content.
 */
export function readNativeMcpBootstrapFile(
  path: string,
  options: NativeMcpBootstrapFileOptions = {},
): NativeMcpBootstrapFileResult {
  // Owner-only access cannot be established for a Windows file through the
  // public Node API, so a Windows bootstrap is never read at all.
  if ((options.platform ?? process.platform) === "win32") return { ok: false, reason: "platform_unverifiable" };
  if (typeof path !== "string" || path.length === 0 || path.includes("\0") || !isAbsolute(path)
    || Buffer.byteLength(path, "utf8") > MAX_BOOTSTRAP_PATH_BYTES) {
    return { ok: false, reason: "path_invalid" };
  }
  const uid = currentUid();
  // Before the first file lookup: every directory component must be a real,
  // root/self-owned directory that no other local user can replace, ending in
  // a private parent. Only then do the separate lstat/open/unlink lookups
  // below all name the same file.
  if (uid === undefined || !isProtectedNativeMcpPath(path, { uid, lstat: options.ancestryLstat })) {
    return { ok: false, reason: "parent_invalid" };
  }
  let before: BigIntStats;
  try {
    before = lstatSync(path, { bigint: true });
  } catch {
    return { ok: false, reason: "file_invalid" };
  }
  if (!before.isFile() || before.nlink !== 1n || before.size < 1n || before.size > BigInt(MAX_NATIVE_MCP_BOOTSTRAP_BYTES)
    || !privateOwned(before, uid)) {
    return { ok: false, reason: "file_invalid" };
  }
  let bytes: Buffer;
  let fd: number | undefined;
  try {
    // No-follow and non-blocking, so a swapped-in symlink or FIFO can neither
    // redirect nor hang the read.
    fd = openSync(path, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0) | (fsConstants.O_NONBLOCK ?? 0));
    const opened = fstatSync(fd, { bigint: true });
    if (!opened.isFile() || !sameIdentity(before, opened) || opened.size !== before.size) return { ok: false, reason: "file_invalid" };
    const buffer = Buffer.alloc(MAX_NATIVE_MCP_BOOTSTRAP_BYTES + 1);
    let total = 0;
    for (;;) {
      const read = readSync(fd, buffer, total, buffer.length - total, null);
      if (read === 0) break;
      total += read;
      if (total > MAX_NATIVE_MCP_BOOTSTRAP_BYTES) return { ok: false, reason: "file_invalid" };
    }
    if (BigInt(total) !== before.size) return { ok: false, reason: "file_invalid" };
    bytes = buffer.subarray(0, total);
  } catch {
    return { ok: false, reason: "read_failed" };
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // The read outcome is already decided.
      }
    }
  }
  let text: string;
  try {
    // Keep a leading BOM so the canonical comparison refuses it.
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    return { ok: false, reason: "record_invalid" };
  }
  const bootstrap = decodeNativeMcpBootstrap(text);
  if (!bootstrap) return { ok: false, reason: "record_invalid" };
  // Read once: remove exactly the inode that was read, or fail closed.
  try {
    const after = lstatSync(path, { bigint: true });
    if (!sameIdentity(before, after)) return { ok: false, reason: "consume_failed" };
    unlinkSync(path);
  } catch {
    return { ok: false, reason: "consume_failed" };
  }
  return { ok: true, bootstrap };
}

/** True when any casing of a delegated worker-role marker is present, whatever its value. */
export function hasNativeMcpWorkerRoleMarker(env: NodeJS.ProcessEnv): boolean {
  for (const key of Object.keys(env)) {
    const upper = key.toUpperCase();
    if (upper === RUNTIME_ROLE_ENV || upper === EXECUTOR_TOOL_CATALOG_ENV) return true;
  }
  return false;
}

type LaneResponse =
  | { readonly kind: "response"; readonly frame: NativeMcpResponseFrame }
  | { readonly kind: "not_sent"; readonly reason: "closed" | "unencodable" | "busy" }
  | { readonly kind: "lost" };

/** Thrown into the stdio adapter for a delivered-but-unknown outcome; its message never reaches the client. */
class NativeMcpLaneOutcomeUnknown extends Error {}

/**
 * The broker-backed endpoint behind the stdio adapter: one authenticated
 * connection, strictly increasing request seqs, at most one send per
 * request, and no reconnect.
 */
export class NativeMcpBrokerLane implements NativeMcpToolEndpoint {
  /** Settles once when the lane closes for any reason. */
  readonly closed: Promise<void>;
  readonly #socket: Socket;
  readonly #reader = new NativeMcpFrameReader(MAX_NATIVE_MCP_RESPONSE_FRAME_BYTES);
  readonly #pending = new Map<number, (response: LaneResponse) => void>();
  #nextSeq = 1;
  #closedFlag = false;
  #resolveClosed!: () => void;

  /** Takes ownership of a socket on which `ready` was already received and nothing else. */
  constructor(socket: Socket) {
    this.#socket = socket;
    this.closed = new Promise((resolve) => { this.#resolveClosed = resolve; });
    socket.on("data", (chunk: Buffer) => this.#onData(chunk));
    socket.on("error", () => this.close());
    socket.on("close", () => this.close());
    socket.on("end", () => this.close());
    if (socket.destroyed) queueMicrotask(() => this.close());
  }

  get isClosed(): boolean {
    return this.#closedFlag;
  }

  /** Requests whose broker answer has not arrived. */
  get pendingCount(): number {
    return this.#pending.size;
  }

  /** Closes the lane; every in-flight request becomes an unknown outcome. */
  close(): void {
    if (this.#closedFlag) return;
    this.#closedFlag = true;
    const pending = [...this.#pending.values()];
    this.#pending.clear();
    try {
      this.#socket.destroy();
    } catch {
      // Already closing.
    }
    for (const settle of pending) settle({ kind: "lost" });
    this.#resolveClosed();
  }

  async listTools(request: NativeMcpListToolsRequest): Promise<readonly NativeMcpToolDescriptor[]> {
    const response = await this.#request((seq) => ({ version: 1, type: "native_mcp_request", seq, op: "list" }), request.signal);
    if (response.kind === "response" && response.frame.outcome === "result" && Array.isArray(response.frame.result.tools)) {
      // The stdio adapter applies the generic tool shape check.
      return response.frame.result.tools as NativeMcpToolDescriptor[];
    }
    throw new NativeMcpLaneOutcomeUnknown("tool list unavailable");
  }

  async callTool(request: NativeMcpCallToolRequest): Promise<NativeMcpCallToolResult | undefined> {
    const { name, signal } = request;
    const args = request.arguments;
    const response = await this.#request(
      (seq) => ({ version: 1, type: "native_mcp_request", seq, op: "call", name, arguments: args }),
      signal,
    );
    if (response.kind === "not_sent") {
      const text = response.reason === "closed" ? NOT_SENT_CLOSED : response.reason === "busy" ? NOT_SENT_BUSY : NOT_SENT_UNENCODABLE;
      return { content: [{ type: "text", text }], isError: true };
    }
    if (response.kind === "lost") throw new NativeMcpLaneOutcomeUnknown("lane closed with the call in flight");
    const frame = response.frame;
    if (frame.outcome === "result") return frame.result as unknown as NativeMcpCallToolResult;
    switch (frame.code) {
      case "unknown_tool":
        return undefined;
      case "busy":
        return { content: [{ type: "text", text: NOT_SENT_BUSY }], isError: true };
      case "result_too_large":
        return { content: [{ type: "text", text: RESULT_WITHHELD }], isError: true };
      default:
        throw new NativeMcpLaneOutcomeUnknown("endpoint failed");
    }
  }

  #request(build: (seq: number) => NativeMcpRequestFrame, signal: AbortSignal): Promise<LaneResponse> {
    if (this.#closedFlag || this.#socket.destroyed) return Promise.resolve({ kind: "not_sent", reason: "closed" });
    if (signal.aborted) return Promise.resolve({ kind: "not_sent", reason: "closed" });
    // The per-lane bound holds at this endpoint boundary for every caller, not
    // only behind the stdio adapter: refused before a seq is used or a byte sent.
    if (this.#pending.size >= MAX_NATIVE_MCP_IN_FLIGHT_PER_CONNECTION) return Promise.resolve({ kind: "not_sent", reason: "busy" });
    const seq = this.#nextSeq;
    let line: string;
    try {
      line = encodeNativeMcpClientFrame(build(seq));
    } catch {
      return Promise.resolve({ kind: "not_sent", reason: "unencodable" });
    }
    if (this.#socket.writableLength + Buffer.byteLength(line, "utf8") > MAX_RELAY_PENDING_OUTBOUND_BYTES) {
      return Promise.resolve({ kind: "not_sent", reason: "busy" });
    }
    this.#nextSeq += 1;
    return new Promise<LaneResponse>((resolve) => {
      const onAbort = (): void => {
        // One cancel per request; the request stays pending until answered.
        if (!this.#closedFlag && this.#pending.has(seq)) this.#send(encodeNativeMcpClientFrame({ version: 1, type: "native_mcp_cancel", seq }));
      };
      this.#pending.set(seq, (response) => {
        signal.removeEventListener("abort", onAbort);
        resolve(response);
      });
      signal.addEventListener("abort", onAbort, { once: true });
      // From here on the request may have been delivered: a failure is "lost", never "not sent".
      this.#send(line);
    });
  }

  #send(line: string): void {
    if (this.#closedFlag) return;
    try {
      // UTF-8 bytes, never a string, so `writableLength` (checked before each
      // request) is measured in the same unit as the request cap.
      this.#socket.write(Buffer.from(line, "utf8"));
    } catch {
      this.close();
    }
  }

  #onData(chunk: Buffer): void {
    if (this.#closedFlag) return;
    const result = this.#reader.push(chunk, (line) => this.#onLine(line));
    if (result === "overflow" || result === "invalid_utf8") this.close();
  }

  #onLine(line: string): boolean {
    const frame = decodeNativeMcpServerFrame(line);
    if (!frame || frame.type !== "native_mcp_response") {
      this.close();
      return false;
    }
    const settle = this.#pending.get(frame.seq);
    if (!settle) {
      // An uncorrelated or duplicate answer means the stream is untrustworthy.
      this.close();
      return false;
    }
    this.#pending.delete(frame.seq);
    settle({ kind: "response", frame });
    return !this.#closedFlag;
  }
}

/**
 * `unprotected`: the POSIX socket path could be replaced by another local
 * user, so the hello (which carries the bearer token) was never sent.
 */
export type NativeMcpLaneOpenFailure = "unprotected" | "unreachable" | "refused" | "timeout" | "protocol";

/** The stat fields the socket-path walk reads; injectable for focused tests. */
export interface NativeMcpPathStats {
  readonly uid: bigint;
  readonly mode: bigint;
  isDirectory(): boolean;
  isSocket(): boolean;
}

export interface NativeMcpSocketPathCheckOptions {
  /** No-follow stat; defaults to `lstatSync(path, { bigint: true })`. */
  readonly lstat?: (path: string) => NativeMcpPathStats;
  /** Defaults to this process's uid. */
  readonly uid?: bigint;
}

/**
 * True only when no other local user can replace any component of a POSIX
 * broker socket path, so the token-bearing hello can only reach a socket this
 * user (or root) put there. Walking from `/` down to the socket's directory:
 *
 * - every component must be a real directory (never a symlink), owned by
 *   root or this user;
 * - a component must not sit in a parent that is group/other-writable unless
 *   that parent is sticky (others cannot rename entries they do not own) or an
 *   ancestor already shields it: once a component owned by this user grants
 *   no group/other permission at all, other users cannot search into it, so
 *   nothing beneath it can be renamed or replaced by them;
 * - the socket's own directory must be private to this user, and the socket
 *   must be a socket owned by this user.
 *
 * Root and this user are trusted by construction. Never throws.
 */
export function isProtectedNativeMcpSocketPath(socketPath: string, options: NativeMcpSocketPathCheckOptions = {}): boolean {
  return isProtectedNativeMcpPath(socketPath, options, (leaf, uid) => leaf.isSocket() && leaf.uid === uid);
}

/**
 * The shared root-to-parent walk behind both the socket check and the
 * bootstrap reader; `checkLeaf` adds the leaf rule (the reader applies its own
 * file-level checks afterwards). Never throws.
 */
function isProtectedNativeMcpPath(
  filePath: string,
  options: NativeMcpSocketPathCheckOptions,
  checkLeaf?: (leaf: NativeMcpPathStats, uid: bigint) => boolean,
): boolean {
  const uid = options.uid ?? currentUid();
  const lstat = options.lstat ?? ((path: string): NativeMcpPathStats => lstatSync(path, { bigint: true }));
  if (uid === undefined || typeof filePath !== "string" || !isAbsolute(filePath) || resolvePath(filePath) !== filePath) return false;
  const directories: string[] = [];
  for (let dir = dirname(filePath); ; dir = dirname(dir)) {
    directories.push(dir);
    if (dirname(dir) === dir) break;
  }
  directories.reverse();
  try {
    let parent: NativeMcpPathStats | undefined;
    let shielded = false;
    for (const dir of directories) {
      const stats = lstat(dir);
      if (!stats.isDirectory() || (stats.uid !== 0n && stats.uid !== uid)) return false;
      if (!shielded && parent && (parent.mode & 0o022n) !== 0n && (parent.mode & 0o1000n) === 0n) return false;
      if (stats.uid === uid && (stats.mode & 0o077n) === 0n) shielded = true;
      parent = stats;
    }
    if (!parent || parent.uid !== uid || (parent.mode & 0o077n) !== 0n) return false;
    return checkLeaf === undefined || checkLeaf(lstat(filePath), uid);
  } catch {
    return false;
  }
}

export interface NativeMcpLaneOpenOptions {
  readonly connect?: (socketPath: string) => Socket;
  readonly connectMs?: number;
  readonly readyMs?: number;
}

/**
 * Opens and authenticates one lane: connect (bounded), send the hello, and
 * wait (bounded) for exactly one `ready` with no trailing bytes. A broker
 * refusal is a silent close, reported only as `refused`.
 */
export function openNativeMcpBrokerLane(
  bootstrap: NativeMcpBootstrap,
  options: NativeMcpLaneOpenOptions = {},
): Promise<{ readonly ok: true; readonly lane: NativeMcpBrokerLane } | { readonly ok: false; readonly reason: NativeMcpLaneOpenFailure }> {
  // The hello carries the bearer token in its first write, before any broker
  // reply could prove anything: on POSIX, never connect to a path another
  // local user could have replaced. (Windows uses the validated local
  // named-pipe address, and its bootstraps are refused by the file reader.)
  if (process.platform !== "win32" && !isProtectedNativeMcpSocketPath(bootstrap.socketPath)) {
    return Promise.resolve({ ok: false, reason: "unprotected" });
  }
  let hello: string;
  try {
    hello = encodeNativeMcpHello(bootstrap);
  } catch {
    return Promise.resolve({ ok: false, reason: "protocol" });
  }
  let socket: Socket;
  try {
    socket = options.connect?.(bootstrap.socketPath) ?? createConnection({ path: bootstrap.socketPath });
  } catch {
    return Promise.resolve({ ok: false, reason: "unreachable" });
  }
  return new Promise((resolve) => {
    let settled = false;
    let connected = false;
    let received = Buffer.alloc(0);
    let timer: NodeJS.Timeout | undefined;
    const cleanup = (): void => {
      if (timer) clearTimeout(timer);
      timer = undefined;
      socket.removeListener("data", onData);
      socket.removeListener("error", onError);
      socket.removeListener("close", onClose);
      socket.removeListener("connect", onConnect);
    };
    const fail = (reason: NativeMcpLaneOpenFailure): void => {
      if (settled) return;
      settled = true;
      cleanup();
      socket.on("error", ignore);
      try {
        socket.destroy();
      } catch {
        // The outcome is already decided.
      }
      resolve({ ok: false, reason });
    };
    const onData = (chunk: Buffer): void => {
      if (settled) return;
      if (received.length + chunk.length > MAX_NATIVE_MCP_CONTROL_FRAME_BYTES) {
        fail("protocol");
        return;
      }
      received = Buffer.concat([received, chunk]);
      const newline = received.indexOf(0x0a);
      if (newline === -1) return;
      if (newline !== received.length - 1) {
        // Nothing may follow `ready` before the relay sends a request.
        fail("protocol");
        return;
      }
      let text: string;
      try {
        text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(received.subarray(0, newline));
      } catch {
        fail("protocol");
        return;
      }
      const frame = decodeNativeMcpServerFrame(text);
      if (!frame || frame.type !== "native_mcp_ready") {
        fail("protocol");
        return;
      }
      settled = true;
      cleanup();
      resolve({ ok: true, lane: new NativeMcpBrokerLane(socket) });
    };
    const onError = (): void => fail(connected ? "refused" : "unreachable");
    const onClose = (): void => fail(connected ? "refused" : "unreachable");
    const onConnect = (): void => {
      if (settled) return;
      connected = true;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => fail("timeout"), options.readyMs ?? NATIVE_MCP_RELAY_READY_TIMEOUT_MS);
      timer.unref?.();
      try {
        socket.write(hello);
      } catch {
        fail("refused");
      }
    };
    try {
      socket.setNoDelay?.(true);
    } catch {
      // Optional transport tuning only.
    }
    socket.on("data", onData);
    socket.on("error", onError);
    socket.on("close", onClose);
    socket.once("connect", onConnect);
    timer = setTimeout(() => fail("unreachable"), options.connectMs ?? NATIVE_MCP_RELAY_CONNECT_TIMEOUT_MS);
    timer.unref?.();
  });
}

export type NativeMcpRelayStartupFailure =
  | "worker_role"
  | "usage"
  | "bootstrap_invalid"
  | NativeMcpLaneOpenFailure
  | "error";

/** Observed relay outcome; it never carries a token, path, request, or result. */
export type NativeMcpRelayOutcome =
  | { readonly status: "ended"; readonly reason: NativeMcpStdioCloseReason; readonly laneClosedFirst: boolean }
  | { readonly status: NativeMcpRelayStartupFailure };

/** Injectable seams for focused tests; production uses process argv/env/stdio and net.connect. */
export interface NativeMcpRelayOptions {
  readonly argv?: readonly string[];
  readonly env?: NodeJS.ProcessEnv;
  readonly input?: Readable;
  readonly output?: Writable;
  readonly connect?: (socketPath: string) => Socket;
  readonly timeouts?: { readonly connectMs?: number; readonly readyMs?: number };
  readonly platform?: NodeJS.Platform;
  /** Observes the started session and lane (the process entry uses it for signal handling). */
  readonly onStarted?: (session: NativeMcpStdioSession, lane: NativeMcpBrokerLane) => void;
}

/**
 * Runs one relay: refuse worker roles, read the bootstrap once, open the lane,
 * then serve MCP stdio until the input ends or the session closes. The lane
 * is closed when the session ends.
 */
export async function runNativeMcpRelay(options: NativeMcpRelayOptions = {}): Promise<NativeMcpRelayOutcome> {
  try {
    if (hasNativeMcpWorkerRoleMarker(options.env ?? process.env)) return { status: "worker_role" };
    const argv = options.argv ?? process.argv.slice(2);
    if (argv.length !== 2 || argv[0] !== NATIVE_MCP_RELAY_BOOTSTRAP_FLAG || typeof argv[1] !== "string") return { status: "usage" };
    const read = readNativeMcpBootstrapFile(argv[1], { platform: options.platform });
    if (!read.ok) return { status: "bootstrap_invalid" };
    const opened = await openNativeMcpBrokerLane(read.bootstrap, {
      connect: options.connect,
      connectMs: options.timeouts?.connectMs,
      readyMs: options.timeouts?.readyMs,
    });
    if (!opened.ok) return { status: opened.reason };
    const lane = opened.lane;
    let laneClosedFirst = false;
    let sessionClosed = false;
    void lane.closed.then(() => { if (!sessionClosed) laneClosedFirst = true; });
    let session: NativeMcpStdioSession;
    try {
      session = new NativeMcpStdioSession({
        input: options.input ?? process.stdin,
        output: options.output ?? process.stdout,
        endpoint: lane,
        serverInfo: { ...NATIVE_MCP_RELAY_SERVER_INFO },
        limits: { maxInFlightRequests: MAX_NATIVE_MCP_IN_FLIGHT_PER_CONNECTION },
      });
    } catch {
      lane.close();
      return { status: "error" };
    }
    options.onStarted?.(session, lane);
    const reason = await session.closed;
    sessionClosed = true;
    lane.close();
    return { status: "ended", reason, laneClosedFirst };
  } catch {
    return { status: "error" };
  }
}

function ignore(): void {}

/**
 * Resolves true once every byte already accepted by `stream` has been handed
 * to the operating system. Writes are flushed in order, so an empty write's
 * callback is the barrier. Resolves false on a stream error, a stream that
 * can no longer write while bytes are still pending, or the deadline; nothing
 * is ever rewritten or retried.
 */
export function flushNativeMcpOutput(stream: Writable, timeoutMs: number = NATIVE_MCP_RELAY_FLUSH_TIMEOUT_MS): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    const finish = (flushed: boolean): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      stream.off("error", onError);
      stream.on("error", ignore);
      resolve(flushed);
    };
    const onError = (): void => finish(false);
    if (!stream.writable) {
      finish(stream.writableLength === 0 && !stream.errored);
      return;
    }
    stream.on("error", onError);
    // Deliberately referenced: a pending promise and a stuck stream do not keep
    // Node alive, so this deadline must, until finish() clears it on every path.
    timer = setTimeout(() => finish(false), timeoutMs);
    try {
      stream.write("", (error) => finish(!error));
    } catch {
      finish(false);
    }
  });
}

/** Writes one closed code to stderr (when given), flushes stdout and stderr, then exits. */
async function exitAfterFlush(code: number, closedCode?: string): Promise<never> {
  let exitCode = code;
  if (closedCode !== undefined) {
    try {
      process.stderr.write(`pi-review-gate native MCP relay: ${closedCode}\n`);
    } catch {
      // Nothing else may be written; the exit code still reports the failure.
    }
  }
  // A reply already handed to stdout must not be cut short by exit; failing
  // to flush it is never reported as a clean exit.
  if (!(await flushNativeMcpOutput(process.stdout))) exitCode = exitCode === 0 ? 1 : exitCode;
  await flushNativeMcpOutput(process.stderr);
  process.exit(exitCode);
}

/**
 * The provider CLI runs this compiled module as its MCP stdio server. When the
 * session ends the broker lane is closed at once (aborting any in-flight
 * request), then output already accepted by stdout is flushed (bounded). The
 * process exits zero only after a clean closure (input end, or SIGTERM/SIGINT
 * disposal) AND a successful flush. An abnormal closure (output failure or
 * overflow, invalid encoding, oversized frame, unsendable reply) may have
 * dropped replies the flush cannot recover, so, like a startup failure, it
 * writes one fixed code to stderr and exits nonzero.
 */
if (require.main === module) {
  let started: NativeMcpStdioSession | undefined;
  const stop = (): void => {
    if (started) started.dispose();
    else void exitAfterFlush(0);
  };
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
  void runNativeMcpRelay({ onStarted: (session) => { started = session; } }).then(
    (outcome) => {
      if (outcome.status !== "ended") return exitAfterFlush(1, outcome.status);
      if (outcome.reason === "input_ended" || outcome.reason === "disposed") return exitAfterFlush(0);
      return exitAfterFlush(1, outcome.reason);
    },
    () => exitAfterFlush(1, "error"),
  );
}
