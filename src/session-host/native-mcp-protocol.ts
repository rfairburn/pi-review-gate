/**
 * #682: closed broker wire family for the hosted native MCP tool lane.
 *
 * A native Claude or Codex CLI launches the stdio relay (./native-mcp-relay)
 * as its own MCP server child. The relay connects to the host's ONE existing
 * local status broker (POSIX Unix socket or Windows named pipe; never a new
 * listener or address), authenticates with a per-launch bootstrap the host
 * issued before the CLI spawned, and forwards only validated tool operations
 * to the trusted {@link NativeMcpToolEndpoint} the host registered for that
 * launch. This module is the framing contract both ends share. It is a
 * separate family from the Pi reporter contract (./protocol) and from the
 * one-shot observation hooks (./native-hook-protocol): different frame types,
 * a different bootstrap record type, and an independent token.
 *
 * Wire shape (newline-delimited JSON, every field closed and strictly typed):
 *
 * - relay -> broker, first line, under the broker's shared 16 KiB pre-auth
 *   reader: `native_mcp_hello` {instanceId, generation, backend, token}.
 * - broker -> relay, once, only after authentication and admission:
 *   `native_mcp_ready`. Refusal of any kind is a silent close, never a reason.
 * - relay -> broker: `native_mcp_request` {seq, op:"list"} or
 *   {seq, op:"call", name, arguments, toolUseId?}; `native_mcp_cancel` {seq}.
 * - broker -> relay: exactly one `native_mcp_response` per accepted request
 *   seq, carrying either `result` or one closed error `code`.
 *
 * `seq` is a strictly increasing per-connection correlation number chosen by
 * the relay. It is never an owner call id, never authority, and never reused.
 * No client identity, MCP request id, `_meta`, `clientInfo`, or protocol
 * version crosses this wire: the endpoint sees only the operation, the tool
 * name, the arguments object, an abort signal, and — for a call whose client
 * sent one — the single bounded `toolUseId` matching key the stdio adapter
 * took from `_meta["claudecode/toolUseId"]` (#682). That key is never
 * authority; the trusted owner only compares it with its own authenticated
 * provider evidence.
 *
 * Delivery versus completion. The response codes distinguish what the
 * transport knows:
 *
 * - `busy`: refused before the endpoint was called; nothing ran.
 * - `unknown_tool`: the endpoint answered that no such tool exists.
 * - `failed`: the endpoint was called and threw or answered malformed; the
 *   owned operation's effects are unknown.
 * - `result_too_large`: the endpoint completed but its answer exceeded the
 *   response bound; the effects may have been applied.
 *
 * A connection that closes while a request is in flight leaves delivery and
 * completion both unknown. Neither end queues, replays, or retries anything.
 */

import { Buffer } from "node:buffer";
import { posix as posixPath } from "node:path";
import { MEBIBYTE } from "../jsonl";
import { isRecord } from "../record-guard";
import { NATIVE_MCP_MAX_TOOL_NAME_LENGTH, isValidNativeMcpToolUseId } from "./native-mcp-stdio";
import { isNativeCliBackend, type NativeCliBackend } from "./session-backend";

export const NATIVE_MCP_BROKER_PROTOCOL_VERSION = 1;

/** Largest accepted bootstrap file, in bytes (the canonical record is far smaller). */
export const MAX_NATIVE_MCP_BOOTSTRAP_BYTES = 4096;

/**
 * Largest hello line, newline included. It is far below the broker's shared
 * pre-auth frame bound, which still applies first.
 */
export const MAX_NATIVE_MCP_HELLO_BYTES = 1024;

/** Largest broker control frame (`native_mcp_ready`), newline included. */
export const MAX_NATIVE_MCP_CONTROL_FRAME_BYTES = 128;

/**
 * Largest relay -> broker frame after authentication, newline included. It
 * leaves headroom over the stdio adapter's default 4 MiB inbound frame so an
 * ordinary re-encoded request fits; a request that still does not fit is
 * refused by the relay before anything is sent.
 */
export const MAX_NATIVE_MCP_REQUEST_FRAME_BYTES = 4 * MEBIBYTE + 64 * 1024;

/** Largest broker -> relay response frame, newline included. */
export const MAX_NATIVE_MCP_RESPONSE_FRAME_BYTES = 16 * MEBIBYTE;

/**
 * Requests one authenticated connection may have in flight. The relay
 * configures its stdio session with the same bound, so a well-behaved relay
 * never sees `busy` from this limit.
 */
export const MAX_NATIVE_MCP_IN_FLIGHT_PER_CONNECTION = 8;

/** Closed response error codes; see the module comment for their meaning. */
export const NATIVE_MCP_RESPONSE_ERROR_CODES = Object.freeze(["busy", "unknown_tool", "failed", "result_too_large"] as const);
export type NativeMcpResponseErrorCode = (typeof NATIVE_MCP_RESPONSE_ERROR_CODES)[number];

/**
 * One launch's native MCP bootstrap. The host issues it before the CLI spawns
 * and writes it to a private per-launch file; release of the registration (or
 * broker disposal) invalidates it. The `type` field keeps a hook or Pi
 * bootstrap from ever parsing as this record.
 */
export interface NativeMcpBootstrap {
  readonly version: 1;
  readonly type: "native_mcp_bootstrap";
  /** The existing broker endpoint (POSIX Unix socket or local Windows named pipe). */
  readonly socketPath: string;
  readonly generation: string;
  readonly instanceId: string;
  readonly backend: NativeCliBackend;
  readonly token: string;
}

export interface NativeMcpHelloFrame {
  readonly version: 1;
  readonly type: "native_mcp_hello";
  readonly instanceId: string;
  readonly generation: string;
  readonly backend: NativeCliBackend;
  readonly token: string;
}

export interface NativeMcpReadyFrame {
  readonly version: 1;
  readonly type: "native_mcp_ready";
}

export type NativeMcpRequestFrame =
  | { readonly version: 1; readonly type: "native_mcp_request"; readonly seq: number; readonly op: "list" }
  | {
    readonly version: 1;
    readonly type: "native_mcp_request";
    readonly seq: number;
    readonly op: "call";
    readonly name: string;
    readonly arguments: Record<string, unknown>;
    /** Optional bounded tool-use matching key (#682); never authority. */
    readonly toolUseId?: string;
  };

export interface NativeMcpCancelFrame {
  readonly version: 1;
  readonly type: "native_mcp_cancel";
  readonly seq: number;
}

export type NativeMcpClientFrame = NativeMcpRequestFrame | NativeMcpCancelFrame;

export type NativeMcpResponseFrame =
  | { readonly version: 1; readonly type: "native_mcp_response"; readonly seq: number; readonly outcome: "result"; readonly result: Record<string, unknown> }
  | { readonly version: 1; readonly type: "native_mcp_response"; readonly seq: number; readonly outcome: "error"; readonly code: NativeMcpResponseErrorCode };

export type NativeMcpServerFrame = NativeMcpReadyFrame | NativeMcpResponseFrame;

const MAX_INSTANCE_ID_LENGTH = 128;
const MAX_SOCKET_PATH_LENGTH = 2048;
/** Same UUID-like id shape the broker uses for Pi and hook registrations. */
const ID_PATTERN = /^[0-9a-f-]*[0-9a-f][0-9a-f-]*$/i;
const TOKEN_PATTERN = /^[0-9a-f]{64}$/i;
const LOCAL_PIPE_ADDRESS_PATTERN = /^\\\\\.\\pipe\\prg-st-[0-9a-f]{32}$/;

const BOOTSTRAP_KEYS: ReadonlySet<string> = new Set(["version", "type", "socketPath", "generation", "instanceId", "backend", "token"]);
const HELLO_KEYS: ReadonlySet<string> = new Set(["version", "type", "instanceId", "generation", "backend", "token"]);
const READY_KEYS: ReadonlySet<string> = new Set(["version", "type"]);
const LIST_KEYS: ReadonlySet<string> = new Set(["version", "type", "seq", "op"]);
const CALL_KEYS: ReadonlySet<string> = new Set(["version", "type", "seq", "op", "name", "arguments", "toolUseId"]);
const CANCEL_KEYS: ReadonlySet<string> = new Set(["version", "type", "seq"]);
const RESULT_KEYS: ReadonlySet<string> = new Set(["version", "type", "seq", "outcome", "result"]);
const ERROR_KEYS: ReadonlySet<string> = new Set(["version", "type", "seq", "outcome", "code"]);

function hasOnlyKeys(value: Record<string, unknown>, allowed: ReadonlySet<string>): boolean {
  return Object.keys(value).every((key) => allowed.has(key));
}

/** Bounded instance/generation id shape shared with the broker registration API. */
export function isValidNativeMcpInstanceId(value: unknown): value is string {
  return typeof value === "string" && value.length >= 1 && value.length <= MAX_INSTANCE_ID_LENGTH && ID_PATTERN.test(value);
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

function isSeq(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1;
}

/** MCP tool name bound, identical to the stdio adapter's. */
export function isValidNativeMcpToolName(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= NATIVE_MCP_MAX_TOOL_NAME_LENGTH;
}

function isResponseErrorCode(value: unknown): value is NativeMcpResponseErrorCode {
  return typeof value === "string" && (NATIVE_MCP_RESPONSE_ERROR_CODES as readonly string[]).includes(value);
}

/** Parses one line as JSON only when it fits `maxBytes` (newline included). */
function parseBoundedLine(line: string, maxBytes: number): Record<string, unknown> | undefined {
  if (typeof line !== "string") return undefined;
  const body = line.endsWith("\n") ? line.slice(0, -1) : line;
  if (Buffer.byteLength(body, "utf8") + 1 > maxBytes) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return undefined;
  }
  return isRecord(parsed) ? parsed : undefined;
}

function encodeBounded(message: object, maxBytes: number): string {
  const frame = `${JSON.stringify(message)}\n`;
  if (Buffer.byteLength(frame, "utf8") > maxBytes) throw new RangeError(`native MCP frame exceeds ${maxBytes} bytes`);
  return frame;
}

/**
 * Validates one parsed bootstrap. Returns undefined (never throws) for any
 * missing, extra, or malformed field, so a foreign record can never
 * half-authenticate a relay.
 */
export function parseNativeMcpBootstrap(value: unknown): NativeMcpBootstrap | undefined {
  if (!isRecord(value) || !hasOnlyKeys(value, BOOTSTRAP_KEYS)) return undefined;
  if (value.version !== NATIVE_MCP_BROKER_PROTOCOL_VERSION || value.type !== "native_mcp_bootstrap") return undefined;
  if (!isNativeCliBackend(value.backend)) return undefined;
  if (!isValidSocketPath(value.socketPath)) return undefined;
  if (!isValidNativeMcpInstanceId(value.generation)) return undefined;
  if (!isValidNativeMcpInstanceId(value.instanceId)) return undefined;
  if (!isValidToken(value.token)) return undefined;
  return {
    version: 1,
    type: "native_mcp_bootstrap",
    socketPath: value.socketPath,
    generation: value.generation,
    instanceId: value.instanceId,
    backend: value.backend,
    token: value.token,
  };
}

/**
 * The one canonical bootstrap file encoding: fixed key order, no whitespace,
 * one trailing newline. A host writes exactly these bytes; the relay accepts
 * nothing else.
 */
export function encodeNativeMcpBootstrap(bootstrap: NativeMcpBootstrap): string {
  const parsed = parseNativeMcpBootstrap(bootstrap);
  if (!parsed) throw new TypeError("native MCP bootstrap is malformed");
  return encodeBounded(parsed, MAX_NATIVE_MCP_BOOTSTRAP_BYTES);
}

/**
 * Decodes bootstrap file text. The text must be byte-identical to the
 * canonical encoding of the record it parses as, so duplicate keys, extra
 * whitespace, reordering, or trailing data all fail closed.
 */
export function decodeNativeMcpBootstrap(text: string): NativeMcpBootstrap | undefined {
  const value = parseBoundedLine(text, MAX_NATIVE_MCP_BOOTSTRAP_BYTES);
  const bootstrap = parseNativeMcpBootstrap(value);
  if (!bootstrap) return undefined;
  let canonical: string;
  try {
    canonical = encodeNativeMcpBootstrap(bootstrap);
  } catch {
    return undefined;
  }
  return canonical === text ? bootstrap : undefined;
}

export function encodeNativeMcpHello(bootstrap: NativeMcpBootstrap): string {
  const hello: NativeMcpHelloFrame = {
    version: 1,
    type: "native_mcp_hello",
    instanceId: bootstrap.instanceId,
    generation: bootstrap.generation,
    backend: bootstrap.backend,
    token: bootstrap.token,
  };
  return encodeBounded(hello, MAX_NATIVE_MCP_HELLO_BYTES);
}

/** Strict hello decode; any other shape (including every Pi or hook frame) is undefined. */
export function decodeNativeMcpHello(line: string): NativeMcpHelloFrame | undefined {
  const value = parseBoundedLine(line, MAX_NATIVE_MCP_HELLO_BYTES);
  if (!value || !hasOnlyKeys(value, HELLO_KEYS)) return undefined;
  if (value.version !== NATIVE_MCP_BROKER_PROTOCOL_VERSION || value.type !== "native_mcp_hello") return undefined;
  if (!isNativeCliBackend(value.backend)) return undefined;
  if (!isValidNativeMcpInstanceId(value.instanceId) || !isValidNativeMcpInstanceId(value.generation)) return undefined;
  if (!isValidToken(value.token)) return undefined;
  return {
    version: 1,
    type: "native_mcp_hello",
    instanceId: value.instanceId,
    generation: value.generation,
    backend: value.backend,
    token: value.token,
  };
}

/** Strict decode of one authenticated relay frame (request or cancel). */
export function decodeNativeMcpClientFrame(line: string): NativeMcpClientFrame | undefined {
  const value = parseBoundedLine(line, MAX_NATIVE_MCP_REQUEST_FRAME_BYTES);
  if (!value || value.version !== NATIVE_MCP_BROKER_PROTOCOL_VERSION || !isSeq(value.seq)) return undefined;
  if (value.type === "native_mcp_cancel") {
    if (!hasOnlyKeys(value, CANCEL_KEYS)) return undefined;
    return { version: 1, type: "native_mcp_cancel", seq: value.seq };
  }
  if (value.type !== "native_mcp_request") return undefined;
  if (value.op === "list") {
    if (!hasOnlyKeys(value, LIST_KEYS)) return undefined;
    return { version: 1, type: "native_mcp_request", seq: value.seq, op: "list" };
  }
  if (value.op === "call") {
    if (!hasOnlyKeys(value, CALL_KEYS) || !isValidNativeMcpToolName(value.name) || !isRecord(value.arguments)) return undefined;
    // A present key must be well formed; a malformed one is a protocol violation.
    if (value.toolUseId !== undefined && !isValidNativeMcpToolUseId(value.toolUseId)) return undefined;
    return {
      version: 1,
      type: "native_mcp_request",
      seq: value.seq,
      op: "call",
      name: value.name,
      arguments: value.arguments,
      ...(value.toolUseId === undefined ? {} : { toolUseId: value.toolUseId }),
    };
  }
  return undefined;
}

/**
 * Throws RangeError when the request cannot fit, and TypeError when it cannot
 * be encoded faithfully (a non-finite number, which JSON would silently turn
 * into `null`); callers treat both as "not sent".
 */
export function encodeNativeMcpClientFrame(frame: NativeMcpClientFrame): string {
  const body = JSON.stringify(frame, (_key, value: unknown) => {
    if (typeof value === "number" && !Number.isFinite(value)) throw new TypeError("native MCP request is not faithfully encodable");
    return value;
  });
  if (typeof body !== "string") throw new TypeError("native MCP request is not encodable");
  const encoded = `${body}\n`;
  if (Buffer.byteLength(encoded, "utf8") > MAX_NATIVE_MCP_REQUEST_FRAME_BYTES) {
    throw new RangeError(`native MCP frame exceeds ${MAX_NATIVE_MCP_REQUEST_FRAME_BYTES} bytes`);
  }
  return encoded;
}

/** Strict decode of one broker frame (ready or response). */
export function decodeNativeMcpServerFrame(line: string): NativeMcpServerFrame | undefined {
  const value = parseBoundedLine(line, MAX_NATIVE_MCP_RESPONSE_FRAME_BYTES);
  if (!value || value.version !== NATIVE_MCP_BROKER_PROTOCOL_VERSION) return undefined;
  if (value.type === "native_mcp_ready") {
    return hasOnlyKeys(value, READY_KEYS) ? { version: 1, type: "native_mcp_ready" } : undefined;
  }
  if (value.type !== "native_mcp_response" || !isSeq(value.seq)) return undefined;
  if (value.outcome === "result") {
    if (!hasOnlyKeys(value, RESULT_KEYS) || !isRecord(value.result)) return undefined;
    return { version: 1, type: "native_mcp_response", seq: value.seq, outcome: "result", result: value.result };
  }
  if (value.outcome === "error") {
    if (!hasOnlyKeys(value, ERROR_KEYS) || !isResponseErrorCode(value.code)) return undefined;
    return { version: 1, type: "native_mcp_response", seq: value.seq, outcome: "error", code: value.code };
  }
  return undefined;
}

/** Throws RangeError (or a serialization error) when the frame cannot be sent. */
export function encodeNativeMcpServerFrame(frame: NativeMcpServerFrame): string {
  return encodeBounded(frame, frame.type === "native_mcp_ready" ? MAX_NATIVE_MCP_CONTROL_FRAME_BYTES : MAX_NATIVE_MCP_RESPONSE_FRAME_BYTES);
}

export type NativeMcpFrameReadResult = "ok" | "stopped" | "overflow" | "invalid_utf8";

/**
 * Newline framing over raw bytes, bounded BEFORE decoding: a partial frame is
 * held in one growable buffer bounded by `maxFrameBytes` minus the required
 * newline, and every complete line must be strict UTF-8.
 * `overflow` and `invalid_utf8` are terminal: the caller must close, since the
 * byte stream can no longer be trusted. Bytes after a `false` from `onLine`
 * are never decoded.
 */
export class NativeMcpFrameReader {
  /** One growable partial-frame buffer; never more than `maxFrameBytes - 1` bytes. */
  #partial: Buffer | undefined;
  #bytes = 0;
  #failed = false;
  readonly #maxFrameBytes: number;

  constructor(maxFrameBytes: number) {
    if (!Number.isSafeInteger(maxFrameBytes) || maxFrameBytes < 2) throw new RangeError("maxFrameBytes must be an integer of at least 2");
    this.#maxFrameBytes = maxFrameBytes;
  }

  push(chunk: Buffer, onLine: (line: string) => boolean): NativeMcpFrameReadResult {
    if (this.#failed) return "overflow";
    let offset = 0;
    while (offset < chunk.length) {
      const newline = chunk.indexOf(0x0a, offset);
      const end = newline === -1 ? chunk.length : newline;
      const segment = end - offset;
      if (this.#bytes + segment + 1 > this.#maxFrameBytes) return this.#fail("overflow");
      let lineBytes: Buffer;
      if (newline !== -1 && this.#bytes === 0) {
        // A whole frame inside this chunk: decode it in place.
        lineBytes = chunk.subarray(offset, newline);
      } else {
        // A split frame is copied into ONE buffer that grows geometrically up
        // to the frame bound, so a byte-at-a-time sender retains a single
        // bounded allocation, never one object per read, and a large
        // coalesced chunk is never pinned by a small view.
        const size = this.#bytes + segment;
        let partial = this.#partial;
        if (!partial || partial.length < size) {
          const capacity = Math.min(this.#maxFrameBytes - 1, Math.max(size, (partial?.length ?? 128) * 2));
          const grown = Buffer.allocUnsafe(capacity);
          partial?.copy(grown, 0, 0, this.#bytes);
          this.#partial = partial = grown;
        }
        chunk.copy(partial, this.#bytes, offset, end);
        this.#bytes = size;
        if (newline === -1) return "ok";
        lineBytes = partial.subarray(0, size);
      }
      this.#partial = undefined;
      this.#bytes = 0;
      offset = newline + 1;
      let line: string;
      try {
        // A leading BOM is kept (and then refused by the strict JSON parse),
        // never silently stripped into an accepted frame.
        line = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(lineBytes);
      } catch {
        return this.#fail("invalid_utf8");
      }
      if (!onLine(line)) return "stopped";
    }
    return "ok";
  }

  #fail(result: "overflow" | "invalid_utf8"): NativeMcpFrameReadResult {
    this.#failed = true;
    this.#partial = undefined;
    this.#bytes = 0;
    return result;
  }
}
