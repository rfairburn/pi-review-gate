/**
 * Read-only JSON-RPC observer transport for one HOST-OWNED native Codex
 * app-server endpoint (the native status slice's RPC lane).
 *
 * A hosted native Codex row can only be observed on an endpoint the host itself
 * created: the caller starts a private native backend and points the genuine
 * interactive TUI at that same endpoint with `--remote`. The backend multiplexes
 * clients over RFC6455 WebSockets, so this module attaches as one more client
 * and reads the provider's own thread metadata. The transport uses the existing
 * pinned `ws` dependency, with `node:net` for Unix sockets and bearer
 * authentication for loopback endpoints — no second WebSocket implementation,
 * new dependency, or stdio proxy.
 *
 * ## What the CALLER must already have proved (this module proves none of it)
 *
 * - `endpoint` is private and host-owned: a socket this process created under a
 *   directory only its own user can reach, or a loopback `ws` endpoint whose
 *   credential the caller owns. Filesystem ownership IS the authentication for
 *   the Unix form; nothing here reads, writes, or migrates provider credentials,
 *   configuration, or trust state.
 * - `expectedCodexHome` (when supplied) is the `CODEX_HOME` the host launched
 *   that exact backend with. It is compared in place and never retained.
 * - The bound ROOT thread id, its generation, and the workspace context are the
 *   caller's binding evidence. This transport never adopts a thread and never
 *   decides whether a thread belongs to the row.
 *
 * ## Non-subscribing, control-free invariant (structural, not conventional)
 *
 * Server-to-client REQUESTS (approvals, questions, permission requests, MCP
 * elicitation, auth refresh, attestation, `currentTime/read`) are targeted at
 * the connections SUBSCRIBED to the thread. A client that has not subscribed
 * never receives them, and any client that replies to one — with a result OR an
 * error — consumes the provider's single shared pending callback and resolves
 * the operator's live prompt. The native TUI must stay the only approval
 * authority, so this transport:
 *
 * - never sends `thread/resume`, `thread/fork`, `thread/queue/*`, `turn/*`,
 *   `command/exec*`, `process/*`, `thread/backgroundTerminals/terminate|clean`,
 *   `thread/archive|delete|unarchive`, `thread/goal/*`, `thread/name/set`,
 *   `config/*`, or `account/*`;
 * - exposes NO send, reply, respond, notify, or raw-frame method. The only
 *   outbound writers are the `initialize` request, the `initialized`
 *   notification, and requests whose ids this module minted itself;
 * - identifies an inbound server request (method, whether its params named a
 *   `threadId`, and its opaque id) and drops its payload before any callback,
 *   retention, or logging, sending ZERO bytes back;
 * - keeps inbound ids out of the pending map, so replying to a server-request
 *   id is not expressible.
 *
 * `requiredHumanApproval: false` is only the provider's narrow `HumanCommand`
 * approval gate. It is NOT an isolation guarantee, and the isolation here comes
 * from not subscribing and never replying.
 *
 * ## Privacy at the decode edge
 *
 * Only opaque ids, status enums, active flags, counts, and page cursors are
 * decoded out of a payload. Commands, cwds, paths, previews, names, prompts,
 * answers, model text, reasoning, token usage, diffs, outputs, and error
 * messages are never placed in a returned value, a callback argument, or an
 * error message. Failures cross the boundary as closed codes only.
 */

import net from "node:net";
import WebSocket from "ws";
import { isRecord } from "../record-guard";

/* ------------------------------------------------------------------ bounds */

/**
 * A Unix socket path longer than the platform `sockaddr_un` limit is silently
 * unusable (the backend never binds it and the client just hangs), so an
 * over-long endpoint is refused up front instead of being waited on.
 */
export const NATIVE_CODEX_RPC_MAX_SOCKET_PATH_CHARS = 104;

/** One JSON-RPC frame cap. A larger message is a foreign or corrupt stream. */
export const NATIVE_CODEX_RPC_MAX_MESSAGE_BYTES = 2 * 1024 * 1024;

/**
 * In-flight census requests for one observer. The observer above this transport
 * keeps exactly one census at a time, so a handful of concurrent page reads is
 * the whole working set; more means a caller is driving this client wrong.
 */
export const NATIVE_CODEX_RPC_MAX_PENDING_REQUESTS = 8;

export const NATIVE_CODEX_RPC_DEFAULT_REQUEST_TIMEOUT_MS = 5_000;
export const NATIVE_CODEX_RPC_DEFAULT_HANDSHAKE_TIMEOUT_MS = 5_000;

/** Opaque provider ids and cursors are short; a longer one is not an id. */
export const NATIVE_CODEX_RPC_MAX_ID_CHARS = 256;
export const NATIVE_CODEX_RPC_MAX_CURSOR_CHARS = 512;
export const NATIVE_CODEX_RPC_MAX_METHOD_CHARS = 128;

/** Server page size requested by the census. Bounded, never "no limit". */
export const NATIVE_CODEX_RPC_MAX_PAGE_LIMIT = 200;

/**
 * Non-originating client identity. The backend keeps a process-global originator
 * and may re-enable legacy automatic login for the first ORIGINATING client, so
 * an observer must identify as one of the provider's own non-originating names
 * and never as a new interactive product.
 */
export const NATIVE_CODEX_RPC_CLIENT_NAME = "codex-backend";

/** Client version reported during `initialize`; a label, never host detail. */
export const NATIVE_CODEX_RPC_CLIENT_VERSION = "session-host";

/**
 * Delta and raw-response streams the connection opts out of at initialize time.
 * A non-subscribing observer cannot receive thread-scoped traffic anyway, and
 * opting out keeps the frame volume and the payload surface minimal.
 */
export const NATIVE_CODEX_RPC_OPT_OUT_NOTIFICATION_METHODS: readonly string[] = Object.freeze([
  "item/agentMessage/delta",
  "item/reasoning/textDelta",
  "item/reasoning/summaryTextDelta",
  "item/plan/delta",
  "command/exec/outputDelta",
  "item/commandExecution/outputDelta",
  "process/outputDelta",
  "rawResponseItem/completed",
  "rawResponse/completed",
]);

/**
 * The closed set of notification methods this transport decodes. Anything else
 * is dropped unread: an unlisted notification is not evidence, and the observer
 * must not become a general notification sink.
 */
export const NATIVE_CODEX_RPC_NOTIFICATION_METHODS: readonly string[] = Object.freeze([
  "thread/status/changed",
  "thread/started",
  "thread/deleted",
  "thread/archived",
  "thread/closed",
]);

/** The closed set of census requests this transport will ever send. */
export const NATIVE_CODEX_RPC_REQUEST_METHODS: readonly string[] = Object.freeze([
  "thread/read",
  "thread/loaded/list",
  "thread/list",
  "thread/backgroundTerminals/list",
]);

export type NativeCodexRpcRequestMethod =
  | "thread/read"
  | "thread/loaded/list"
  | "thread/list"
  | "thread/backgroundTerminals/list";

/* -------------------------------------------------------------- endpoint */

/**
 * The two endpoint forms the host can legitimately own.
 *
 * `unix` names a private socket the host created, authenticated by filesystem
 * ownership.
 *
 * `loopback-ws` is the same observation over the provider's own authenticated
 * loopback listener, for the portable/Windows case where a Unix socket is not
 * the natural endpoint. The backend lease producer starts
 * `codex app-server --listen ws://127.0.0.1:0 --ws-auth capability-token
 * --ws-token-sha256 <digest>`, reads the actual ephemeral nonzero port out of
 * that backend's own banner, and hands this module the port plus the private
 * bearer token through an explicit accessor. The token is therefore carried as a
 * callable, so it is never a plain enumerable string that a diagnostic dump,
 * `JSON.stringify`, or a log line could print, and it is only ever read at the
 * moment the `Authorization` header is written.
 *
 * Both forms are strictly host-owned. A public or DNS hostname, a non-loopback
 * address, a URL with embedded credentials or a query, a zero port, and above all
 * an UNAUTHENTICATED loopback endpoint are refused: there is no option that
 * dials a loopback listener without the caller's credential, because that
 * listener is other software on this machine's port space.
 */
export type NativeCodexRpcEndpoint =
  | { readonly kind: "unix"; readonly socketPath: string }
  | {
      readonly kind: "loopback-ws";
      /** Numeric IPv4 loopback only. Not `localhost`, which is a resolvable name. */
      readonly host: "127.0.0.1";
      /** The ephemeral port the backend itself reported. Never 0. */
      readonly port: number;
      readonly authorization: { readonly scheme: "bearer"; readonly token: () => string };
    };

/** Closed reasons one endpoint descriptor can be refused for. */
export type NativeCodexRpcEndpointRejectCode =
  | "shape"
  | "kind"
  | "socket-path"
  | "socket-path-too-long"
  | "host"
  | "port"
  | "authorization";

export type NativeCodexRpcEndpointRead =
  | { readonly status: "valid"; readonly endpoint: NativeCodexRpcEndpoint }
  | { readonly status: "invalid"; readonly code: NativeCodexRpcEndpointRejectCode };

function readBoundedText(value: unknown, maxChars: number): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > maxChars) return null;
  // A NUL or a control character is never part of an id, path, or cursor.
  if (/[\u0000-\u001F\u007F]/.test(trimmed)) return null;
  return trimmed;
}

/**
 * Validates one endpoint descriptor and returns a frozen copy. Nothing is
 * resolved, created, or connected here: the caller owns the socket's existence
 * and permissions, this only refuses endpoints that could not be private.
 */
export function readNativeCodexRpcEndpoint(value: unknown): NativeCodexRpcEndpointRead {
  if (!isRecord(value)) return { status: "invalid", code: "shape" };
  const kind = value.kind;
  if (kind === "unix") {
    const socketPath = typeof value.socketPath === "string" ? value.socketPath : "";
    if (socketPath.trim().length === 0 || socketPath.includes("\u0000")) {
      return { status: "invalid", code: "socket-path" };
    }
    if (socketPath.length > NATIVE_CODEX_RPC_MAX_SOCKET_PATH_CHARS) {
      return { status: "invalid", code: "socket-path-too-long" };
    }
    return { status: "valid", endpoint: Object.freeze({ kind, socketPath }) };
  }
  if (kind === "loopback-ws") {
    if (value.host !== "127.0.0.1") {
      // A LAN address, a DNS name, `localhost`, or `::1` is never accepted: the
      // lease producer only ever hands out a numeric IPv4 loopback endpoint.
      return { status: "invalid", code: "host" };
    }
    const port = value.port;
    if (typeof port !== "number" || !Number.isSafeInteger(port) || port < 1 || port > 65_535) {
      return { status: "invalid", code: "port" };
    }
    const rawAuth = value.authorization;
    if (!isRecord(rawAuth) || rawAuth.scheme !== "bearer" || typeof rawAuth.token !== "function") {
      // No unauthenticated fallback exists on this lane.
      return { status: "invalid", code: "authorization" };
    }
    const readToken = rawAuth.token as () => string;
    let token: unknown;
    try {
      token = readToken();
    } catch {
      return { status: "invalid", code: "authorization" };
    }
    const bounded = readBoundedText(token, 512);
    if (bounded === null) return { status: "invalid", code: "authorization" };
    return {
      status: "valid",
      endpoint: Object.freeze({
        kind,
        host: "127.0.0.1" as const,
        port,
        // The validated token is re-served through the same callable, so the
        // frozen endpoint still holds no printable credential field.
        authorization: Object.freeze({
          scheme: "bearer" as const,
          token: (): string => bounded,
        }),
      }),
    };
  }
  return { status: "invalid", code: "kind" };
}

/* --------------------------------------------------------------- failures */

/**
 * Every way this transport can fail, as a closed code. Server error objects,
 * messages, and any payload they carry never cross the boundary.
 */
export type NativeCodexRpcFailureCode =
  /** The descriptor was refused before any connection was attempted. */
  | "endpoint-invalid"
  /** The WebSocket handshake could not be completed (refused, 401, timeout). */
  | "handshake"
  /** The socket broke or closed while connected. */
  | "socket"
  /** The peer sent something that is not the expected JSON-RPC shape. */
  | "protocol"
  /** A frame exceeded the message cap. */
  | "oversize"
  /** One request did not answer in time. */
  | "timeout"
  /** One request was answered with a JSON-RPC error object. */
  | "rejected"
  /** The `initialize` result contradicted the caller's owned-endpoint claim. */
  | "binding"
  /** The observer was disposed. */
  | "closed";

/** The closed codes one census request can fail with. */
export type NativeCodexRpcRequestFailureCode = "timeout" | "rejected" | "malformed" | "closed";

/** A failure whose message is exactly its closed code: no payload can ride along. */
export class NativeCodexRpcError extends Error {
  readonly code: NativeCodexRpcFailureCode | NativeCodexRpcRequestFailureCode;

  constructor(code: NativeCodexRpcFailureCode | NativeCodexRpcRequestFailureCode) {
    super(`native-codex-rpc:${code}`);
    this.name = "NativeCodexRpcError";
    this.code = code;
  }
}

/* ------------------------------------------------------------------ data */

export type NativeCodexThreadStatusKind = "idle" | "active" | "systemError" | "notLoaded";
export type NativeCodexActiveFlag = "waitingOnApproval" | "waitingOnUserInput";

/** One decoded provider thread status. `activeFlags` is only meaningful for `active`. */
export interface NativeCodexThreadStatus {
  readonly kind: NativeCodexThreadStatusKind;
  readonly activeFlags: readonly NativeCodexActiveFlag[];
}

/**
 * One decoded thread row: identity, the parent relationship the ownership walk
 * needs, and live status. Everything else a provider row carries — preview, cwd,
 * path, model, nickname, role, git info, timestamps, originator — is dropped at
 * the decode edge and never reaches a caller.
 */
export interface NativeCodexThreadRow {
  readonly threadId: string;
  /** Parent thread id, or null when the provider reports none (a root). */
  readonly parentThreadId: string | null;
  readonly status: NativeCodexThreadStatus;
}

export interface NativeCodexLoadedPage {
  readonly threadIds: readonly string[];
  readonly nextCursor: string | null;
}

export interface NativeCodexThreadPage {
  readonly rows: readonly NativeCodexThreadRow[];
  readonly nextCursor: string | null;
}

/**
 * One background-terminal page. Only the process identity survives decoding:
 * `command`, `cwd`, `osPid`, cpu, and rss are dropped, so a count can be formed
 * and a duplicate across pages recognized without retaining what is running.
 */
export interface NativeCodexTerminalPage {
  readonly processIds: readonly string[];
  readonly nextCursor: string | null;
}

/** What the caller may learn from a successful handshake. Paths are never included. */
export interface NativeCodexInitializeInfo {
  /** True when the backend reported a user agent at all (never its content). */
  readonly userAgentPresent: boolean;
  readonly platformFamily: string | null;
}

/**
 * The only thing an inbound server request leaves behind: which protocol method
 * asked, whether its params named a thread, and its opaque id. The payload is
 * already gone when this is handed over, and there is no API that can turn it
 * into a reply.
 */
export interface NativeCodexServerRequestSignal {
  readonly method: string;
  readonly threadScoped: boolean;
  readonly requestId: string;
}

/** One decoded, allowlisted provider notification. */
export type NativeCodexRpcNotification =
  | { readonly method: "thread/status/changed"; readonly threadId: string; readonly status: NativeCodexThreadStatus }
  | { readonly method: "thread/started"; readonly row: NativeCodexThreadRow }
  | { readonly method: "thread/deleted" | "thread/archived" | "thread/closed"; readonly threadId: string };

/* -------------------------------------------------------------- decoding */

function decodeStatus(value: unknown): NativeCodexThreadStatus | null {
  if (!isRecord(value)) return null;
  const kind = value.type;
  if (kind === "idle" || kind === "systemError" || kind === "notLoaded") {
    return { kind, activeFlags: [] };
  }
  if (kind !== "active") return null;
  const rawFlags = value.activeFlags;
  if (rawFlags !== undefined && !Array.isArray(rawFlags)) return null;
  const flags: NativeCodexActiveFlag[] = [];
  for (const raw of Array.isArray(rawFlags) ? rawFlags : []) {
    if (raw === "waitingOnApproval" || raw === "waitingOnUserInput") {
      if (!flags.includes(raw)) flags.push(raw);
      continue;
    }
    // An unrecognized flag means the provider vocabulary moved; the whole
    // status is treated as undecodable rather than silently read as "no flags",
    // because "no flags" is a positive reported-none.
    return null;
  }
  return { kind: "active", activeFlags: Object.freeze(flags) };
}

/** Decodes one thread row, or null when it cannot be read as one. */
export function decodeNativeCodexThreadRow(value: unknown): NativeCodexThreadRow | null {
  if (!isRecord(value)) return null;
  const threadId = readBoundedText(value.id, NATIVE_CODEX_RPC_MAX_ID_CHARS);
  if (threadId === null) return null;
  const status = decodeStatus(value.status);
  if (status === null) return null;
  const rawParent = value.parentThreadId;
  let parentThreadId: string | null = null;
  if (rawParent !== undefined && rawParent !== null) {
    const parent = readBoundedText(rawParent, NATIVE_CODEX_RPC_MAX_ID_CHARS);
    // A present-but-unusable parent id makes the row's ownership unknowable.
    if (parent === null) return null;
    parentThreadId = parent;
  }
  return { threadId, parentThreadId, status };
}

/** Decodes one `thread/read` result: the row, or null when unreadable. */
export function decodeNativeCodexThreadReadResult(result: unknown): NativeCodexThreadRow | null {
  if (!isRecord(result)) return null;
  const nested = isRecord(result.thread) ? result.thread : result;
  return decodeNativeCodexThreadRow(nested);
}

/** Decodes one `thread/loaded/list` page. */
export function decodeNativeCodexLoadedPage(result: unknown): NativeCodexLoadedPage | null {
  if (!isRecord(result) || !Array.isArray(result.data)) return null;
  const threadIds: string[] = [];
  for (const raw of result.data) {
    const id = readBoundedText(raw, NATIVE_CODEX_RPC_MAX_ID_CHARS);
    if (id === null) return null;
    if (!threadIds.includes(id)) threadIds.push(id);
  }
  const nextIds = readCursor(result.nextCursor);
  if (!nextIds.complete) return null;
  return { threadIds, nextCursor: nextIds.cursor };
}

/** Decodes one `thread/list` page. */
export function decodeNativeCodexThreadPage(result: unknown): NativeCodexThreadPage | null {
  if (!isRecord(result) || !Array.isArray(result.data)) return null;
  const rows: NativeCodexThreadRow[] = [];
  for (const raw of result.data) {
    const row = decodeNativeCodexThreadRow(raw);
    if (row === null) return null;
    rows.push(row);
  }
  const nextPage = readCursor(result.nextCursor);
  if (!nextPage.complete) return null;
  return { rows, nextCursor: nextPage.cursor };
}

/** Decodes one `thread/backgroundTerminals/list` page to process ids only. */
export function decodeNativeCodexTerminalPage(result: unknown): NativeCodexTerminalPage | null {
  if (!isRecord(result) || !Array.isArray(result.data)) return null;
  const processIds: string[] = [];
  for (const raw of result.data) {
    if (!isRecord(raw)) return null;
    const id = readBoundedText(raw.processId, NATIVE_CODEX_RPC_MAX_ID_CHARS)
      ?? readBoundedText(raw.itemId, NATIVE_CODEX_RPC_MAX_ID_CHARS);
    if (id === null) return null;
    if (!processIds.includes(id)) processIds.push(id);
  }
  const nextTerminals = readCursor(result.nextCursor);
  if (!nextTerminals.complete) return null;
  return { processIds, nextCursor: nextTerminals.cursor };
}

/** Decodes one allowlisted notification payload, or null when unreadable. */
export function decodeNativeCodexNotification(
  method: string,
  params: unknown,
): NativeCodexRpcNotification | null {
  if (!isRecord(params)) return null;
  switch (method) {
    case "thread/status/changed": {
      const threadId = readBoundedText(params.threadId, NATIVE_CODEX_RPC_MAX_ID_CHARS);
      const status = decodeStatus(params.status);
      if (threadId === null || status === null) return null;
      return { method, threadId, status };
    }
    case "thread/started": {
      const row = decodeNativeCodexThreadRow(params.thread);
      if (row === null) return null;
      return { method, row };
    }
    case "thread/deleted":
    case "thread/archived":
    case "thread/closed": {
      const threadId = readBoundedText(params.threadId, NATIVE_CODEX_RPC_MAX_ID_CHARS);
      if (threadId === null) return null;
      return { method, threadId };
    }
    default:
      return null;
  }
}

type CursorRead =
  | { readonly complete: true; readonly cursor: string | null }
  | { readonly complete: false };

/**
 * Reads one page cursor without ever confusing "the provider says this is the
 * last page" with "this page is unusable".
 *
 * A missing or null cursor is a terminal page. A present cursor that is not a
 * usable text value is NOT a terminal page: treating it as one would silently
 * truncate pagination and let a census publish a low count, or even a false
 * zero, from a partial page walk. An invalid cursor therefore fails the whole
 * page, and the caller withdraws the aggregate it was building.
 */
function readCursor(value: unknown): CursorRead {
  if (value === undefined || value === null) return { complete: true, cursor: null };
  const text = readBoundedText(value, NATIVE_CODEX_RPC_MAX_CURSOR_CHARS);
  return text === null ? { complete: false } : { complete: true, cursor: text };
}

/* ------------------------------------------------------------- transport */

export interface NativeCodexRpcTransportOptions {
  readonly endpoint: NativeCodexRpcEndpoint;
  /**
   * The `CODEX_HOME` the caller launched this exact backend with. Compared for
   * equality against the `initialize` result and then dropped; a mismatch is a
   * `binding` failure and the connection is closed without any request.
   */
  readonly expectedCodexHome?: string;
  readonly requestTimeoutMs?: number;
  readonly handshakeTimeoutMs?: number;
  readonly maxMessageBytes?: number;
  readonly maxPendingRequests?: number;
  /** One decoded allowlisted notification. */
  readonly onNotification?: (notification: NativeCodexRpcNotification) => void;
  /** One inbound server request, payload already discarded. No reply path exists. */
  readonly onServerRequest?: (signal: NativeCodexServerRequestSignal) => void;
  /** One closed failure code. */
  readonly onFailure?: (code: NativeCodexRpcFailureCode) => void;
  /** Successful handshake and binding corroboration. */
  readonly onConnected?: (info: NativeCodexInitializeInfo) => void;
  /** The connection ended. `code` is closed; `undefined` means we disposed it. */
  readonly onClosed?: (code: NativeCodexRpcFailureCode | undefined) => void;
}

interface PendingRequest {
  readonly resolve: (result: unknown) => void;
  readonly reject: (error: NativeCodexRpcError) => void;
  timer: ReturnType<typeof setTimeout> | null;
}

type TransportState = "idle" | "connecting" | "ready" | "closed";

/**
 * One read-only connection to one host-owned native Codex app-server.
 *
 * The public surface is exactly: connect, the four allowlisted metadata reads,
 * dispose, and two read-only getters. There is no send, no reply, no notify, no
 * generic `request(method, params)`, and no way to address a frame to an id this
 * client did not mint, which is what makes "never answer the operator's approval
 * prompt" a structural property rather than a convention.
 */
export class NativeCodexRpcTransport {
  readonly #endpoint: NativeCodexRpcEndpoint;
  readonly #expectedCodexHome: string | null;
  readonly #requestTimeoutMs: number;
  readonly #handshakeTimeoutMs: number;
  readonly #maxMessageBytes: number;
  readonly #maxPendingRequests: number;
  readonly #onNotification: ((notification: NativeCodexRpcNotification) => void) | undefined;
  readonly #onServerRequest: ((signal: NativeCodexServerRequestSignal) => void) | undefined;
  readonly #onFailure: ((code: NativeCodexRpcFailureCode) => void) | undefined;
  readonly #onConnected: ((info: NativeCodexInitializeInfo) => void) | undefined;
  readonly #onClosed: ((code: NativeCodexRpcFailureCode | undefined) => void) | undefined;

  readonly #pending = new Map<string, PendingRequest>();
  #ws: WebSocket | null = null;
  #nextRequestId = 0;
  #state: TransportState = "idle";
  #disposed = false;
  #reportedProtocol = false;
  /** True once the peer exceeded the message cap, so the close is read as oversize. */
  #sawOversize = false;

  constructor(options: NativeCodexRpcTransportOptions) {
    const read = readNativeCodexRpcEndpoint(options.endpoint);
    if (read.status === "invalid") {
      // Refused here, not retried later: an endpoint this module cannot certify
      // as private must never be dialed.
      throw new NativeCodexRpcError("endpoint-invalid");
    }
    this.#endpoint = read.endpoint;
    this.#expectedCodexHome = typeof options.expectedCodexHome === "string"
      && options.expectedCodexHome.trim().length > 0
      ? options.expectedCodexHome.trim()
      : null;
    this.#requestTimeoutMs = boundedMs(options.requestTimeoutMs, NATIVE_CODEX_RPC_DEFAULT_REQUEST_TIMEOUT_MS);
    this.#handshakeTimeoutMs = boundedMs(
      options.handshakeTimeoutMs,
      NATIVE_CODEX_RPC_DEFAULT_HANDSHAKE_TIMEOUT_MS,
    );
    this.#maxMessageBytes = positiveInt(options.maxMessageBytes, NATIVE_CODEX_RPC_MAX_MESSAGE_BYTES);
    this.#maxPendingRequests = positiveInt(options.maxPendingRequests, NATIVE_CODEX_RPC_MAX_PENDING_REQUESTS);
    this.#onNotification = options.onNotification;
    this.#onServerRequest = options.onServerRequest;
    this.#onFailure = options.onFailure;
    this.#onConnected = options.onConnected;
    this.#onClosed = options.onClosed;
  }

  get state(): TransportState {
    return this.#state;
  }

  /** In-flight request count; a leak or a stuck census is visible without content. */
  get pendingRequestCount(): number {
    return this.#pending.size;
  }

  /**
   * Opens the connection and completes the handshake: `initialize` with the
   * non-originating client identity and the negotiated capabilities, then the
   * `initialized` notification. Resolves only once the backend's own identity
   * has been corroborated against `expectedCodexHome` (when supplied).
   */
  connect(): Promise<void> {
    if (this.#disposed) return Promise.reject(new NativeCodexRpcError("closed"));
    if (this.#state !== "idle") return Promise.reject(new NativeCodexRpcError("protocol"));
    this.#state = "connecting";
    return new Promise<void>((resolve, reject) => {
      let settled = false;
      let ws: WebSocket;
      try {
        ws = this.#openSocket();
      } catch {
        this.#state = "closed";
        reject(new NativeCodexRpcError("handshake"));
        return;
      }
      this.#ws = ws;

      // Re-entrancy latch: failing during initialization closes the socket, and
      // closing rejects the pending initialize, which would otherwise report a
      // second code for the one failure.
      let failing = false;
      const fail = (code: NativeCodexRpcFailureCode): void => {
        if (failing) return;
        failing = true;
        try {
          if (settled) {
            this.#fail(code);
            return;
          }
          settled = true;
          this.#state = "closed";
          this.#fail(code);
          reject(new NativeCodexRpcError(code));
          // An initialization that never completed must never leave an upgraded
          // socket behind: the peer is closed and the transport is retired, so a
          // retrying observer cannot accumulate abandoned connections. This is
          // deliberately limited to the pre-ready phase — a break on a connection
          // that WAS ready is reported through the close handler instead, so the
          // observer still receives its `onClosed` reason and can back off.
          this.close();
        } finally {
          failing = false;
        }
      };

      ws.on("open", () => {
        if (settled) return;
        // The initialize request is minted like any other, so its id lives in
        // the pending map and its answer is correlated there.
        const id = this.#mintRequestId();
        const payload = {
          jsonrpc: "2.0",
          id,
          method: "initialize",
          params: {
            clientInfo: {
              name: NATIVE_CODEX_RPC_CLIENT_NAME,
              title: null,
              version: NATIVE_CODEX_RPC_CLIENT_VERSION,
            },
            capabilities: {
              experimentalApi: true,
              requiredHumanApproval: false,
              optOutNotificationMethods: [...NATIVE_CODEX_RPC_OPT_OUT_NOTIFICATION_METHODS],
            },
          },
        };
        this.#pending.set(id, {
          resolve: (result) => {
            const info = this.#acceptInitializeResult(result);
            if (info === null) {
              // A backend that is not the one the caller launched is refused:
              // the handshake promise rejects, no census request is ever sent,
              // and the connection is closed.
              fail("binding");
              return;
            }
            settled = true;
            this.#state = "ready";
            // `initialized` is the provider's own notification name and carries
            // no params. It is not a reply to anything.
            this.#write({ jsonrpc: "2.0", method: "initialized" });
            this.#emit(this.#onConnected, info);
            resolve();
          },
          reject: (error) => {
            // The RPC handshake itself is what failed here: a JSON-RPC error
            // answer is a refused handshake, and a torn-down connection is
            // `closed`. Neither may leave the socket open.
            fail(error.code === "closed" ? "closed" : error.code === "timeout" ? "timeout" : "handshake");
          },
          // The handshake is bounded like every other request. The socket's own
          // `handshakeTimeout` only covers the HTTP upgrade, so a peer that
          // upgrades and then stays silent would otherwise hold `connect()` —
          // and therefore the observer's `start()` — open forever.
          timer: setTimeout(() => {
            if (!this.#pending.delete(id)) return;
            fail("timeout");
          }, this.#requestTimeoutMs),
        });
        if (!this.#write(payload)) {
          this.#pending.delete(id);
          fail("handshake");
        }
      });

      ws.on("message", (data: WebSocket.RawData, isBinary: boolean) => {
        this.#handleFrame(data, isBinary);
      });
      ws.on("error", (error: Error) => {
        // The error object may contain endpoint detail; only a closed code
        // crosses the boundary. The one message-shaped classification that is
        // made here is against the WebSocket library's own constant for the
        // payload cap, so an oversize peer is reported as `oversize` rather
        // than as a generic socket break. The text itself is never stored or
        // propagated.
        const oversize = error instanceof RangeError
          && error.message.includes("Max payload size exceeded");
        if (oversize) {
          fail("oversize");
          return;
        }
        fail(this.#state === "ready" ? "socket" : "handshake");
      });
      ws.on("close", (code: number) => {
        const reason = code === 1009 || this.#sawOversize
          ? "oversize"
          : this.#disposed ? undefined : "socket";
        if (this.#state === "connecting" && !settled) {
          fail(reason ?? "socket");
          return;
        }
        if (settled && !this.#disposed) this.#fail(reason ?? "socket");
        this.#teardown(reason ?? "socket");
      });
    });
  }

  /** `thread/read` with history explicitly excluded. Null when unreadable. */
  readThread(threadId: string): Promise<NativeCodexThreadRow | null> {
    const id = readBoundedText(threadId, NATIVE_CODEX_RPC_MAX_ID_CHARS);
    if (id === null) return Promise.reject(new NativeCodexRpcError("malformed"));
    return this.#request("thread/read", { threadId: id, includeTurns: false })
      .then((result) => decodeNativeCodexThreadReadResult(result));
  }

  /** One `thread/loaded/list` page of bare loaded thread ids. */
  listLoadedThreadIds(cursor?: string | null): Promise<NativeCodexLoadedPage> {
    return this.#request("thread/loaded/list", pageParams(cursor)).then((result) => {
      const page = decodeNativeCodexLoadedPage(result);
      if (page === null) throw new NativeCodexRpcError("malformed");
      return page;
    });
  }

  /**
   * One `thread/list` page of spawned descendants of one ancestor. The ancestor
   * filter is the provider's own ownership filter and deliberately the ONLY
   * scoping here: no cwd filter, because an owned child legitimately runs in its
   * own worktree.
   */
  listDescendantThreads(ancestorThreadId: string, cursor?: string | null): Promise<NativeCodexThreadPage> {
    const ancestor = readBoundedText(ancestorThreadId, NATIVE_CODEX_RPC_MAX_ID_CHARS);
    if (ancestor === null) return Promise.reject(new NativeCodexRpcError("malformed"));
    return this.#request("thread/list", {
      ...pageParams(cursor),
      ancestorThreadId: ancestor,
      sourceKinds: [...NATIVE_CODEX_RPC_SUBAGENT_SOURCE_KINDS],
      useStateDbOnly: true,
      sortKey: "updated_at",
      sortDirection: "desc",
    }).then((result) => {
      const page = decodeNativeCodexThreadPage(result);
      if (page === null) throw new NativeCodexRpcError("malformed");
      return page;
    });
  }

  /** One `thread/backgroundTerminals/list` page, reduced to process identities. */
  listBackgroundTerminals(threadId: string, cursor?: string | null): Promise<NativeCodexTerminalPage> {
    const id = readBoundedText(threadId, NATIVE_CODEX_RPC_MAX_ID_CHARS);
    if (id === null) return Promise.reject(new NativeCodexRpcError("malformed"));
    return this.#request("thread/backgroundTerminals/list", { ...pageParams(cursor), threadId: id })
      .then((result) => {
        const page = decodeNativeCodexTerminalPage(result);
        if (page === null) throw new NativeCodexRpcError("malformed");
        return page;
      });
  }

  /**
   * Ends the connection and releases every pending request. Idempotent, and
   * after it returns no callback can fire again.
   */
  close(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    const ws = this.#ws;
    this.#teardown("closed");
    try {
      ws?.close();
    } catch {
      // Already gone.
    }
  }

  /* ---------------------------------------------------------- internals */

  #openSocket(): WebSocket {
    const maxPayload = this.#maxMessageBytes;
    const handshakeTimeout = this.#handshakeTimeoutMs;
    if (this.#endpoint.kind === "unix") {
      const socketPath = this.#endpoint.socketPath;
      // `ws://localhost/rpc` is only the handshake target the provider expects;
      // the actual bytes go to the caller's private socket, and no DNS or TCP
      // connection to `localhost` is ever attempted.
      return new WebSocket("ws://localhost/rpc", {
        maxPayload,
        handshakeTimeout,
        perMessageDeflate: false,
        createConnection: (_options?: unknown): net.Socket => net.connect({ path: socketPath }),
      });
    }
    const { host, port, authorization } = this.#endpoint;
    // The token is read exactly once, here, and only into the standard
    // `Authorization` header. It is never stored on this instance, never placed
    // in a failure code, and never part of any returned value.
    const token = authorization.token();
    if (token.length === 0) throw new NativeCodexRpcError("endpoint-invalid");
    return new WebSocket(`ws://${host}:${port}/rpc`, {
      maxPayload,
      handshakeTimeout,
      perMessageDeflate: false,
      headers: { authorization: `Bearer ${token}` },
    });
  }

  #request(method: NativeCodexRpcRequestMethod, params: Record<string, unknown>): Promise<unknown> {
    if (this.#disposed) return Promise.reject(new NativeCodexRpcError("closed"));
    if (this.#state !== "ready" || this.#ws === null) {
      return Promise.reject(new NativeCodexRpcError("closed"));
    }
    if (this.#pending.size >= this.#maxPendingRequests) {
      return Promise.reject(new NativeCodexRpcError("closed"));
    }
    const id = this.#mintRequestId();
    return new Promise<unknown>((resolve, reject) => {
      const entry: PendingRequest = {
        resolve: (value) => resolve(value),
        reject: (error) => reject(error),
        timer: null,
      };
      entry.timer = setTimeout(() => {
        if (!this.#pending.delete(id)) return;
        entry.timer = null;
        this.#fail("timeout");
        reject(new NativeCodexRpcError("timeout"));
      }, this.#requestTimeoutMs);
      this.#pending.set(id, entry);
      if (!this.#write({ jsonrpc: "2.0", id, method, params })) {
        this.#deletePending(id, new NativeCodexRpcError("closed"));
        reject(new NativeCodexRpcError("closed"));
      }
    });
  }

  /** Ids are minted here and nowhere else, so an inbound id can never be echoed. */
  #mintRequestId(): string {
    this.#nextRequestId += 1;
    return `obs-${this.#nextRequestId}`;
  }

  /** The ONLY socket writer. Every call site is initialize, initialized, or a minted request. */
  #write(payload: Record<string, unknown>): boolean {
    const ws = this.#ws;
    if (ws === null || ws.readyState !== WebSocket.OPEN) return false;
    try {
      ws.send(JSON.stringify(payload));
      return true;
    } catch {
      return false;
    }
  }

  #handleFrame(data: WebSocket.RawData, isBinary: boolean): void {
    if (this.#disposed) return;
    if (isBinary) {
      this.#reportProtocol();
      return;
    }
    const text = typeof data === "string" ? data : data.toString();
    if (text.length > this.#maxMessageBytes) {
      this.#fail("oversize");
      this.close();
      return;
    }
    let frame: unknown;
    try {
      frame = JSON.parse(text);
    } catch {
      this.#reportProtocol();
      return;
    }
    if (!isRecord(frame)) {
      this.#reportProtocol();
      return;
    }
    const method = typeof frame.method === "string"
      ? readBoundedText(frame.method, NATIVE_CODEX_RPC_MAX_METHOD_CHARS)
      : null;
    const frameId = normalizeFrameId(frame.id);

    if (method !== null) {
      if (frameId !== null) {
        // A server REQUEST (approval, question, permission, elicitation, auth
        // refresh, attestation, time read). Its payload is dropped here, before
        // anything can retain or log it, and NOTHING is written back: no result,
        // no error, no method-not-found. The id is never inserted into the
        // pending map, so it can never be addressed by an outbound frame either.
        const threadScoped = isRecord(frame.params) && frame.params.threadId !== undefined;
        this.#emit(this.#onServerRequest, { method, threadScoped, requestId: frameId });
        return;
      }
      // A notification: allowlisted methods only, and only their decoded subset.
      if (!NATIVE_CODEX_RPC_NOTIFICATION_METHODS.includes(method)) return;
      const notification = decodeNativeCodexNotification(method, frame.params);
      if (notification === null) {
        this.#reportProtocol();
        return;
      }
      this.#emit(this.#onNotification, notification);
      return;
    }

    if (frameId === null) {
      this.#reportProtocol();
      return;
    }
    const entry = this.#pending.get(frameId);
    if (entry === undefined) return; // late or unknown response id: dropped, never adopted
    if (entry.timer !== null) clearTimeout(entry.timer);
    this.#pending.delete(frameId);
    if (frame.error !== undefined) {
      // The error object may name a path or a token; it is dropped, and the
      // caller learns only that a request was refused.
      entry.reject(new NativeCodexRpcError("rejected"));
      return;
    }
    entry.resolve(frame.result);
  }

  #acceptInitializeResult(result: unknown): NativeCodexInitializeInfo | null {
    if (!isRecord(result)) return null;
    const codexHome = typeof result.codexHome === "string" ? result.codexHome.trim() : "";
    if (this.#expectedCodexHome !== null) {
      // Compare in place and drop: the path is never stored, returned, or logged.
      if (codexHome !== this.#expectedCodexHome) return null;
    }
    const family = readBoundedText(result.platformFamily, 32);
    return {
      userAgentPresent: typeof result.userAgent === "string" && result.userAgent.trim().length > 0,
      platformFamily: family,
    };
  }

  #deletePending(id: string, error: NativeCodexRpcError): void {
    const entry = this.#pending.get(id);
    if (entry === undefined) return;
    if (entry.timer !== null) clearTimeout(entry.timer);
    this.#pending.delete(id);
    entry.reject(error);
  }

  #fail(code: NativeCodexRpcFailureCode): void {
    if (code === "oversize") this.#sawOversize = true;
    if (code === "protocol") {
      this.#reportProtocol();
      return;
    }
    this.#emit(this.#onFailure, code);
  }

  /** One protocol anomaly per connection, so a chatty peer cannot flood the sink. */
  #reportProtocol(): void {
    if (this.#reportedProtocol) return;
    this.#reportedProtocol = true;
    this.#emit(this.#onFailure, "protocol");
  }

  #teardown(code: NativeCodexRpcFailureCode | undefined): void {
    this.#state = "closed";
    this.#reportedProtocol = false;
    this.#ws = null;
    for (const id of [...this.#pending.keys()]) {
      this.#deletePending(id, new NativeCodexRpcError("closed"));
    }
    if (code === "closed") return;
    this.#emit(this.#onClosed, code);
  }

  #emit<T>(callback: ((value: T) => void) | undefined, value: T): void {
    if (this.#disposed || callback === undefined) return;
    try {
      callback(value);
    } catch {
      // A host sink cannot corrupt this transport.
    }
  }
}

/** The sub-agent source kinds the descendant census asks the provider for. */
export const NATIVE_CODEX_RPC_SUBAGENT_SOURCE_KINDS: readonly string[] = Object.freeze([
  "subAgent",
  "subAgentThreadSpawn",
  "subAgentReview",
  "subAgentCompact",
  "subAgentOther",
]);

function normalizeFrameId(value: unknown): string | null {
  if (typeof value === "string") return readBoundedText(value, NATIVE_CODEX_RPC_MAX_ID_CHARS);
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return null;
}

function pageParams(cursor?: string | null): Record<string, unknown> {
  const params: Record<string, unknown> = { limit: NATIVE_CODEX_RPC_MAX_PAGE_LIMIT };
  const next = cursor === undefined || cursor === null ? null : readBoundedText(cursor, NATIVE_CODEX_RPC_MAX_CURSOR_CHARS);
  if (next !== null) params.cursor = next;
  return params;
}

function positiveInt(value: number | undefined, fallback: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) return fallback;
  return value;
}

function boundedMs(value: number | undefined, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 1) return fallback;
  return Math.min(Math.floor(value), 600_000);
}
