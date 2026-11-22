/**
 * Trusted Codex callback write transport (#682): ONE authenticated WebSocket
 * to the exact host-owned app-server of ONE owned backend lease, exposing only
 * the two lanes the landed callback composer accepts
 * ({@linkcode NativeCodexCallbackSteerLane} and
 * {@linkcode NativeCodexCallbackQueueLane}) for ONE exact owned thread.
 *
 * ## Scope (what this module is and is not)
 *
 * - Its own connection. It never uses, wraps, or widens the read-only observer
 *   ({@linkcode NativeCodexRpcTransport} stays request-allowlisted and
 *   write-free) and never touches the native TUI relay. The endpoint is derived
 *   from the lease's OWN fulfilled readiness value with the existing certified
 *   grammar ({@linkcode readNativeCodexOwnedObserverEndpoint}): numeric IPv4
 *   loopback, bearer read through the lease's private accessor only when the
 *   `Authorization` header is written. There is no endpoint option, no
 *   fallback endpoint, no reconnect, and no retry.
 * - The only frames it can write are the `initialize` request, the
 *   `initialized` notification, and requests with ids it minted for exactly:
 *   `turn/steer` (expected-turn, through the steer lane) and
 *   `thread/queue/add`, `thread/queue/start`, `thread/queue/delete` (through
 *   the queue lane). Params are rebuilt from a closed shape and must name the
 *   bound thread. There is no generic `request(method, params)`, no
 *   `turn/start`, `thread/resume`, interrupt, or subscription.
 * - Server-to-client requests (approvals, questions, elicitation, auth refresh)
 *   are dropped unread and unanswered — zero bytes are written back — and their
 *   ids never enter the pending map. Notifications are dropped unread.
 *
 * ## Write edge (checked synchronously at the actual socket send)
 *
 * Immediately before `ws.send`, with no await in between, every lane write
 * re-proves, in order:
 *
 * 1. the transport is ready, not closed, not aborted, and its socket is OPEN;
 * 2. the lease is still the exact bound lease (same `leaseId` and
 *    `generation`), `ready`, in phase `ready`, not stop-requested, not exited,
 *    not settled, AND the host's own `isOwnedRunCurrent()` still holds (this
 *    lease generation still owns the bound thread and run);
 * 3. the request names the bound thread and is one of the closed shapes;
 * 4. the composer's own write-edge guard (`writeEdge.isTargetStillCurrent()`
 *    for steer, `writeEdge.mayWrite()` for queue);
 * 5. because that guard runs host code (which may retire the lease, revoke the
 *    run, abort, or close this transport), step 2 again (run predicate, then a
 *    fresh lease snapshot, then retirement), then step 1 on the SAME socket
 *    and the pending cap, and only then `ws.send`. The injected clock is
 *    sampled before the guard, so no host hook runs after the final fence.
 *
 * Any failure returns `not-sent` and writes nothing. A ready lane writes
 * synchronously inside the lane call; a lane that is not ready never waits.
 *
 * ## Settlement (unknown stays unknown)
 *
 * After a frame was handed to the socket, the only definitive answers are the
 * correlated JSON-RPC `result` or `error` in a well-formed envelope: exactly
 * one of the two, `jsonrpc` absent (as Codex omits it) or `"2.0"`, handled
 * before the request's monotonic deadline. An answer handled at or after the
 * deadline is a timeout even if the timer callback has not run yet. A timeout,
 * a socket close, a send error, an abort, or a contradictory or malformed
 * answer is reported as the composer's
 * uncertain shapes (`no-response` / `failed`, or an invalid reply the idle
 * primitive reads as `transport-error`), never as not-sent. A late answer after
 * the lane's own deadline is dropped, never adopted.
 *
 * ## What the CALLER must already have proved (this module proves none of it)
 *
 * - `lease` is the host's own retained lease for the run, and `owned` is the
 *   exact thread and run the host owns on it (from host state, never from a
 *   callback payload).
 * - `isOwnedRunCurrent` is the host's synchronous, nonblocking statement that
 *   this lease generation is still the current owner of `owned`.
 * - `attestation.expectedTurnSteer` is the host's own attestation that this
 *   backend build supports expected-turn steering with `clientUserMessageId`.
 * - Root-turn facts, user-stop tracking, and when (if ever) to deliver are the
 *   composer's and its host's concern. This module adds none of them.
 *
 * Privacy: failures are closed codes. The callback text crosses only into the
 * one serialized frame; provider error objects are passed to the composer's
 * classifiers unlogged and never retained here.
 */

import WebSocket from "ws";
import { isRecord } from "../record-guard";
import type { OwnedCodexBackendLaunchIdentity, OwnedCodexBackendLease } from "./native-codex-backend";
import {
  NATIVE_CODEX_CALLBACK_QUEUE_LANE_OWNERSHIP,
  type NativeCodexCallbackOwnedRun,
  type NativeCodexCallbackQueueLane,
  type NativeCodexCallbackQueueLaneReply,
  type NativeCodexCallbackQueueWriteEdge,
} from "./native-codex-callback-composition";
import {
  NATIVE_CODEX_CALLBACK_LANE_OWNERSHIP,
  NATIVE_CODEX_CALLBACK_MAX_CLIENT_MESSAGE_ID_CHARS,
  NATIVE_CODEX_CALLBACK_MAX_TEXT_BYTES,
  NATIVE_CODEX_CALLBACK_STEER_METHOD,
  type NativeCodexCallbackSteerLane,
  type NativeCodexCallbackSteerParams,
  type NativeCodexCallbackSteerWireOutcome,
  type NativeCodexCallbackSteerWriteEdge,
} from "./native-codex-callback-delivery";
import { NATIVE_CODEX_IDLE_WAKE_MAX_TIMEOUT_MS, type NativeCodexIdleWakeQueueMethod } from "./native-codex-idle-wake";
import { readNativeCodexOwnedObserverEndpoint } from "./native-codex-owned-composite";
import {
  NATIVE_CODEX_RPC_CLIENT_NAME,
  NATIVE_CODEX_RPC_CLIENT_VERSION,
  NATIVE_CODEX_RPC_DEFAULT_HANDSHAKE_TIMEOUT_MS,
  NATIVE_CODEX_RPC_DEFAULT_REQUEST_TIMEOUT_MS,
  NATIVE_CODEX_RPC_MAX_ID_CHARS,
  NATIVE_CODEX_RPC_MAX_MESSAGE_BYTES,
  NATIVE_CODEX_RPC_OPT_OUT_NOTIFICATION_METHODS,
  type NativeCodexRpcEndpoint,
} from "./native-codex-rpc";

/* ------------------------------------------------------------------ bounds */

/** The closed set of methods the queue lane can write. */
export const NATIVE_CODEX_CALLBACK_TRANSPORT_QUEUE_METHODS: readonly NativeCodexIdleWakeQueueMethod[] = Object.freeze([
  "thread/queue/add",
  "thread/queue/start",
  "thread/queue/delete",
]);

/** In-flight lane requests. The composer is serial; more means misuse. */
export const NATIVE_CODEX_CALLBACK_TRANSPORT_MAX_PENDING = 4;

/** Longest provider error message passed to the idle primitive's in-place comparison. */
const MAX_ERROR_MESSAGE_CHARS = 4_096;
const CLIENT_MESSAGE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;

/* ------------------------------------------------------------------ inputs */

export interface NativeCodexCallbackTransportOptions {
  /** The host's own retained lease; its readiness value supplies the exact endpoint. */
  readonly lease: Pick<OwnedCodexBackendLease, "identity" | "readiness" | "status">;
  /** The exact thread and run the host owns on this lease. Never from a payload. */
  readonly owned: NativeCodexCallbackOwnedRun;
  /**
   * Synchronous, nonblocking ownership read: this lease generation still owns
   * `owned`. It must be a pure read and must not mutate the composer's root
   * facts; it is consulted at the final send fence.
   */
  readonly isOwnedRunCurrent: () => boolean;
  /** Host attestation that this backend build supports expected-turn steer. */
  readonly attestation: { readonly expectedTurnSteer: true };
  /** The `CODEX_HOME` the host launched the backend with; compared in place when supplied. */
  readonly expectedCodexHome?: string;
  /** Aborting closes the connection; no write is possible afterwards. */
  readonly signal?: AbortSignal;
  /** Bounds the WebSocket upgrade plus the `initialize` answer together. */
  readonly handshakeTimeoutMs?: number;
  /** Per-steer answer bound. Queue requests use the composer's own per-request bound. */
  readonly steerTimeoutMs?: number;
  /** Monotonic milliseconds for handshake and lane deadlines; defaults to `performance.now()`. */
  readonly clock?: { now(): number };
}

export type NativeCodexCallbackTransportUnavailableCode =
  /** Options are not a usable lease, owned run, predicate, and attestation. */
  | "options-invalid"
  /** The lease is not (or no longer) the current ready owner of the bound run. */
  | "lease-not-current"
  /** The lease's readiness rejected. */
  | "readiness-failed"
  /** The lease's endpoint is not a private loopback WebSocket with a bearer. */
  | "endpoint-invalid"
  /** The upgrade or socket failed before `initialize` was answered. */
  | "handshake"
  /** The handshake did not complete in time. */
  | "timeout"
  /** `initialize` was answered with an error. */
  | "rejected"
  /** The `initialize` result contradicted the expected `CODEX_HOME`. */
  | "binding"
  /** Aborted or closed before ready. */
  | "aborted";

export interface NativeCodexCallbackTransport {
  /** The existing busy-steer lane contract, bound to this connection. */
  readonly steerLane: NativeCodexCallbackSteerLane;
  /** The existing branded queue-lane contract, bound to this connection. */
  readonly queueLane: NativeCodexCallbackQueueLane;
  readonly state: "ready" | "closed";
  readonly pendingRequestCount: number;
  /** Resolves once the socket's own `close` event fired. Never rejects. */
  readonly socketClosed: Promise<void>;
  /** Idempotent. Pending requests settle as closed (uncertain), never as not-sent. */
  close(): void;
}

export type NativeCodexCallbackTransportOpen =
  | { readonly status: "ready"; readonly transport: NativeCodexCallbackTransport }
  | {
      readonly status: "unavailable";
      readonly code: NativeCodexCallbackTransportUnavailableCode;
      /** Physical close proof for any socket the attempt created. Never rejects. */
      readonly socketClosed: Promise<void>;
    };

/* -------------------------------------------------------------- validation */

function exactId(value: unknown, maxChars: number): string | null {
  if (typeof value !== "string" || value.length === 0 || value.length > maxChars) return null;
  if (/[\s\u0000-\u001F\u007F]/.test(value)) return null;
  return value;
}

function readIdentity(value: unknown): OwnedCodexBackendLaunchIdentity | null {
  if (!isRecord(value)) return null;
  const leaseId = typeof value.leaseId === "string" && value.leaseId.length > 0 ? value.leaseId : null;
  const generation = Number.isSafeInteger(value.generation) ? (value.generation as number) : null;
  return leaseId === null || generation === null ? null : Object.freeze({ leaseId, generation });
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}

function readText(value: unknown): string | null {
  if (typeof value !== "string" || value.trim().length === 0 || value.includes("\u0000")) return null;
  return Buffer.byteLength(value, "utf8") > NATIVE_CODEX_CALLBACK_MAX_TEXT_BYTES ? null : value;
}

function readClientMessageId(value: unknown): string | null {
  const id = exactId(value, NATIVE_CODEX_CALLBACK_MAX_CLIENT_MESSAGE_ID_CHARS);
  return id !== null && CLIENT_MESSAGE_ID_PATTERN.test(id) ? id : null;
}

/** Exactly one text input item; `text_elements` (queue only) must be absent or empty. */
function readSingleTextInput(value: unknown, allowTextElements: boolean): Record<string, unknown>[] | null {
  if (!Array.isArray(value) || value.length !== 1) return null;
  const item: unknown = value[0];
  if (!isRecord(item) || item.type !== "text") return null;
  if (!hasOnlyKeys(item, allowTextElements ? ["type", "text", "text_elements"] : ["type", "text"])) return null;
  const text = readText(item.text);
  if (text === null) return null;
  if (item.text_elements === undefined) return [{ type: "text", text }];
  if (!Array.isArray(item.text_elements) || item.text_elements.length !== 0) return null;
  return [{ type: "text", text, text_elements: [] }];
}

/** Rebuild one steer frame's params from the closed shape, bound to `threadId`. */
function buildSteerParams(threadId: string, params: unknown): Record<string, unknown> | null {
  if (!isRecord(params) || !hasOnlyKeys(params, ["threadId", "expectedTurnId", "clientUserMessageId", "input"])) {
    return null;
  }
  if (params.threadId !== threadId) return null;
  const expectedTurnId = exactId(params.expectedTurnId, NATIVE_CODEX_RPC_MAX_ID_CHARS);
  const clientUserMessageId = readClientMessageId(params.clientUserMessageId);
  const input = readSingleTextInput(params.input, false);
  if (expectedTurnId === null || clientUserMessageId === null || input === null) return null;
  return { threadId, expectedTurnId, clientUserMessageId, input };
}

/** Rebuild one queue frame's params from the method's closed shape, bound to `threadId`. */
function buildQueueParams(threadId: string, method: unknown, params: unknown): Record<string, unknown> | null {
  if (!isRecord(params) || params.threadId !== threadId) return null;
  switch (method) {
    case "thread/queue/add": {
      if (!hasOnlyKeys(params, ["threadId", "input", "clientUserMessageId"])) return null;
      const clientUserMessageId = readClientMessageId(params.clientUserMessageId);
      const input = readSingleTextInput(params.input, true);
      if (clientUserMessageId === null || input === null) return null;
      return { threadId, input, clientUserMessageId };
    }
    case "thread/queue/start":
    case "thread/queue/delete": {
      if (!hasOnlyKeys(params, ["threadId", "queuedSubmissionId"])) return null;
      const queuedSubmissionId = exactId(params.queuedSubmissionId, NATIVE_CODEX_RPC_MAX_ID_CHARS);
      return queuedSubmissionId === null ? null : { threadId, queuedSubmissionId };
    }
    default:
      return null;
  }
}

function boundedMs(value: number | undefined, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 1) return fallback;
  return Math.min(Math.floor(value), 600_000);
}

/* ------------------------------------------------------------ connection */

const NOT_SENT = Object.freeze({ kind: "not-sent" as const });

/**
 * A reply the idle primitive's own validator refuses, so it reads as
 * `transport-error` (uncertain): a malformed answer is neither a result nor a
 * definitive provider refusal.
 */
const MALFORMED_QUEUE_REPLY = Object.freeze({ kind: "malformed" }) as unknown as NativeCodexCallbackQueueLaneReply;

/**
 * How one correlated request ended. `result` and `error` come only from a
 * well-formed envelope (exactly one of the two, and `jsonrpc` absent or
 * `"2.0"`); a contradictory or foreign envelope is `malformed`.
 */
type Settlement =
  | { readonly kind: "result"; readonly result: unknown }
  | { readonly kind: "error"; readonly error: unknown }
  | { readonly kind: "malformed" }
  | { readonly kind: "timeout" }
  | { readonly kind: "closed" };

interface Pending {
  readonly settle: (settlement: Settlement) => void;
  /** Monotonic deadline; an answer handled at or after it is a timeout. */
  readonly deadline: number;
  timer: ReturnType<typeof setTimeout> | null;
}

/** Classify one correlated response envelope without interpreting its payload. */
function readEnvelope(frame: Record<string, unknown>): Settlement {
  if (Object.hasOwn(frame, "jsonrpc") && frame.jsonrpc !== "2.0") return { kind: "malformed" };
  const hasResult = Object.hasOwn(frame, "result");
  const hasError = Object.hasOwn(frame, "error");
  if (hasResult === hasError) return { kind: "malformed" };
  return hasResult ? { kind: "result", result: frame.result } : { kind: "error", error: frame.error };
}

type ConnectionState = "connecting" | "ready" | "closed";

class CallbackConnection {
  readonly #lease: NativeCodexCallbackTransportOptions["lease"];
  readonly #identity: OwnedCodexBackendLaunchIdentity;
  readonly #threadId: string;
  readonly #isOwnedRunCurrent: () => boolean;
  readonly #signal: AbortSignal | undefined;
  readonly #steerTimeoutMs: number;
  readonly #now: () => number;
  readonly #pending = new Map<string, Pending>();
  readonly #socketClosed: Promise<void>;
  #socketClosedResolve!: () => void;
  #socketClosedSettled = false;
  #ws: WebSocket | null = null;
  /** A WebSocket was constructed; from then on only its own `close` event proves closure. */
  #socketCreated = false;
  /** Latched by the first `close()`; makes teardown idempotent and re-entry a no-op. */
  #closed = false;
  #state: ConnectionState = "connecting";
  #nextId = 0;
  #onAbort: (() => void) | null = null;

  constructor(
    lease: NativeCodexCallbackTransportOptions["lease"],
    identity: OwnedCodexBackendLaunchIdentity,
    threadId: string,
    isOwnedRunCurrent: () => boolean,
    signal: AbortSignal | undefined,
    steerTimeoutMs: number,
    now: () => number,
  ) {
    this.#lease = lease;
    this.#identity = identity;
    this.#threadId = threadId;
    this.#isOwnedRunCurrent = isOwnedRunCurrent;
    this.#signal = signal;
    this.#steerTimeoutMs = steerTimeoutMs;
    this.#now = now;
    this.#socketClosed = new Promise<void>((resolve) => {
      this.#socketClosedResolve = resolve;
    });
    if (signal !== undefined) {
      this.#onAbort = () => this.close();
      signal.addEventListener("abort", this.#onAbort, { once: true });
    }
  }

  get state(): ConnectionState {
    return this.#state;
  }

  get socketClosed(): Promise<void> {
    return this.#socketClosed;
  }

  get pendingRequestCount(): number {
    return this.#pending.size;
  }

  /**
   * The exact bound lease is still the ready owner of the bound run. `ready`
   * is required only once readiness resolved (`requireReady`).
   */
  leaseCurrent(requireReady: boolean): boolean {
    if (this.#isRetired()) return false;
    try {
      // The host's run predicate first, then a FRESH lease snapshot, then
      // retirement again: a hook that retires or aborts cannot be outrun.
      if (this.#isOwnedRunCurrent() !== true || this.#isRetired()) return false;
      const status: unknown = this.#lease.status();
      if (!isRecord(status) || !isRecord(status.identity)) return false;
      if (status.identity.leaseId !== this.#identity.leaseId || status.identity.generation !== this.#identity.generation) {
        return false;
      }
      if (status.stopRequested !== false || status.exitObserved !== false || status.settled !== false) return false;
      if (requireReady && (status.ready !== true || status.phase !== "ready")) return false;
      return !this.#isRetired();
    } catch {
      return false;
    }
  }

  /** Closed by this transport, or aborted by the host. */
  #isRetired(): boolean {
    return this.#closed || this.#state === "closed" || this.#signal?.aborted === true;
  }

  /** Dial and complete the handshake. Resolves with a closed code on failure. */
  open(
    endpoint: Extract<NativeCodexRpcEndpoint, { kind: "loopback-ws" }>,
    expectedCodexHome: string | null,
    handshakeTimeoutMs: number,
  ): Promise<NativeCodexCallbackTransportUnavailableCode | null> {
    return new Promise((resolve) => {
      // One absolute monotonic deadline bounds the upgrade AND the
      // `initialize` answer. The timer below handles a silent peer; this
      // deadline is enforced at every socket event, whichever runs first.
      let deadline = Number.NaN;
      try {
        deadline = this.#now() + handshakeTimeoutMs;
      } catch {
        // An unreadable clock cannot establish a handshake bound.
      }
      if (!Number.isFinite(deadline)) {
        this.close();
        resolve("handshake");
        return;
      }
      let done = false;
      const finish = (code: NativeCodexCallbackTransportUnavailableCode | null): void => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        if (code !== null) this.close();
        resolve(code);
      };
      const timer = setTimeout(() => finish("timeout"), handshakeTimeoutMs);
      if (this.#state === "closed") {
        finish("aborted");
        return;
      }
      let ws: WebSocket;
      try {
        // The bearer is read exactly once, here, into the standard header only.
        const token = endpoint.authorization.token();
        ws = new WebSocket(`ws://${endpoint.host}:${endpoint.port}/rpc`, {
          maxPayload: NATIVE_CODEX_RPC_MAX_MESSAGE_BYTES,
          handshakeTimeout: handshakeTimeoutMs,
          perMessageDeflate: false,
          headers: { authorization: `Bearer ${token}` },
        });
      } catch {
        this.#resolveSocketClosed();
        finish("handshake");
        return;
      }
      this.#socketCreated = true;
      this.#ws = ws;
      ws.on("close", () => {
        this.#resolveSocketClosed();
        // Retires the connection (pending settle as closed) and detaches the
        // abort listener; never reconnects.
        this.close();
        finish(this.#signal?.aborted === true ? "aborted" : "handshake");
      });
      ws.on("error", () => {
        // Error detail may carry endpoint text; only a closed code crosses.
        finish(this.#signal?.aborted === true ? "aborted" : "handshake");
      });
      ws.on("message", (data: WebSocket.RawData, isBinary: boolean) => this.#handleFrame(data, isBinary));
      ws.on("open", () => {
        if (done) return;
        if (!this.#beforeDeadline(deadline)) {
          finish(this.#signal?.aborted === true ? "aborted" : "timeout");
          return;
        }
        if (!this.leaseCurrent(true)) {
          finish(this.#signal?.aborted === true ? "aborted" : "lease-not-current");
          return;
        }
        const id = this.#mintId();
        this.#pending.set(id, {
          timer: null,
          // An answer handled at or after the handshake deadline is a timeout.
          deadline,
          settle: (settlement) => {
            if (settlement.kind === "timeout" || settlement.kind === "closed") {
              finish(settlement.kind === "timeout" ? "timeout" : this.#signal?.aborted === true ? "aborted" : "handshake");
              return;
            }
            if (settlement.kind === "error") {
              finish("rejected");
              return;
            }
            const result = settlement.kind === "result" ? settlement.result : undefined;
            if (!isRecord(result)) {
              finish("handshake");
              return;
            }
            if (expectedCodexHome !== null) {
              const home = typeof result.codexHome === "string" ? result.codexHome.trim() : "";
              // Compared in place and dropped.
              if (home !== expectedCodexHome) {
                finish("binding");
                return;
              }
            }
            if (!this.leaseCurrent(true)) {
              finish(this.#signal?.aborted === true ? "aborted" : "lease-not-current");
              return;
            }
            // The ownership hooks above are host code; the bound still holds.
            if (!this.#beforeDeadline(deadline)) {
              finish("timeout");
              return;
            }
            if (!this.#writeControl({ jsonrpc: "2.0", method: "initialized" })) {
              finish("handshake");
              return;
            }
            this.#state = "ready";
            finish(null);
          },
        });
        const initialize = {
          jsonrpc: "2.0",
          id,
          method: "initialize",
          params: {
            clientInfo: { name: NATIVE_CODEX_RPC_CLIENT_NAME, title: null, version: NATIVE_CODEX_RPC_CLIENT_VERSION },
            capabilities: {
              // `thread/queue/*` are experimental app-server methods.
              experimentalApi: true,
              requiredHumanApproval: false,
              optOutNotificationMethods: [...NATIVE_CODEX_RPC_OPT_OUT_NOTIFICATION_METHODS],
            },
          },
        };
        if (!this.#writeControl(initialize)) {
          this.#pending.delete(id);
          finish("handshake");
        }
      });
    });
  }

  /** The steer lane's single write. See the module's WRITE EDGE rule. */
  steer(params: NativeCodexCallbackSteerParams, writeEdge: NativeCodexCallbackSteerWriteEdge): Promise<NativeCodexCallbackSteerWireOutcome> {
    const built = buildSteerParams(this.#threadId, params);
    if (built === null || !isRecord(writeEdge) || typeof writeEdge.isTargetStillCurrent !== "function") {
      return Promise.resolve(NOT_SENT);
    }
    const guard = (): boolean => writeEdge.isTargetStillCurrent() === true;
    const sent = this.#send(NATIVE_CODEX_CALLBACK_STEER_METHOD, built, this.#steerTimeoutMs, guard);
    if (sent === null) return Promise.resolve(NOT_SENT);
    return sent.then((settlement): NativeCodexCallbackSteerWireOutcome => {
      switch (settlement.kind) {
        case "timeout":
          return Object.freeze({ kind: "no-response", reason: "timeout" });
        case "closed":
          return Object.freeze({ kind: "no-response", reason: "closed" });
        case "error":
          // Raw error; the steer primitive classifies it (non-JSON-RPC error → uncertain).
          return Object.freeze({ kind: "error", error: settlement.error });
        case "result":
          return Object.freeze({ kind: "result", result: settlement.result });
        default:
          // A contradictory or foreign envelope is not proof of refusal or
          // acceptance; a non-error-object error reads as `malformed-error`.
          return Object.freeze({ kind: "error", error: null });
      }
    });
  }

  /** The queue lane's single write. See the module's WRITE EDGE rule. */
  queue(
    method: NativeCodexIdleWakeQueueMethod,
    params: Readonly<Record<string, unknown>>,
    timeoutMs: number,
    writeEdge: NativeCodexCallbackQueueWriteEdge,
  ): Promise<NativeCodexCallbackQueueLaneReply> {
    const built = buildQueueParams(this.#threadId, method, params);
    if (
      built === null
      || !Number.isSafeInteger(timeoutMs)
      || timeoutMs < 1
      || timeoutMs > NATIVE_CODEX_IDLE_WAKE_MAX_TIMEOUT_MS
      || !isRecord(writeEdge)
      || typeof writeEdge.mayWrite !== "function"
    ) {
      return Promise.resolve(NOT_SENT);
    }
    const guard = (): boolean => writeEdge.mayWrite() === true;
    const sent = this.#send(method, built, timeoutMs, guard);
    if (sent === null) return Promise.resolve(NOT_SENT);
    return sent.then((settlement): NativeCodexCallbackQueueLaneReply => {
      switch (settlement.kind) {
        case "timeout":
          return Object.freeze({ kind: "failed", failure: "timeout" });
        case "closed":
          return Object.freeze({ kind: "failed", failure: "closed" });
        case "error": {
          const error = settlement.error;
          if (
            isRecord(error)
            && Number.isSafeInteger(error.code)
            && typeof error.message === "string"
            && error.message.length <= MAX_ERROR_MESSAGE_CHARS
          ) {
            return Object.freeze({ kind: "error", code: error.code as number, message: error.message });
          }
          return MALFORMED_QUEUE_REPLY;
        }
        case "result":
          return Object.freeze({ kind: "result", result: settlement.result });
        default:
          return MALFORMED_QUEUE_REPLY;
      }
    });
  }

  close(): void {
    // Latched first, so a re-entrant close (from a pending settlement, an
    // abort listener, or the socket's own close event) is a no-op.
    if (this.#closed) return;
    this.#closed = true;
    if (this.#onAbort !== null) {
      this.#signal?.removeEventListener("abort", this.#onAbort);
      this.#onAbort = null;
    }
    const ws = this.#ws;
    this.#teardown();
    if (!this.#socketCreated) {
      // Never dialed and now never can be: the close proof is complete.
      this.#resolveSocketClosed();
      return;
    }
    // A created socket's closure is proved only by its own `close` event.
    try {
      ws?.terminate();
    } catch {
      // The socket's own close event remains the only proof.
    }
  }

  /* ---------------------------------------------------------- internals */

  /**
   * The one lane writer. Returns null when nothing was written; otherwise the
   * frame was handed to the socket and the promise settles with its answer,
   * timeout, or close. Everything from the first check to `ws.send` is
   * synchronous.
   */
  #send(method: string, params: Record<string, unknown>, timeoutMs: number, writeEdge: () => boolean): Promise<Settlement> | null {
    const ws = this.#ws;
    if (this.#state !== "ready" || ws === null || ws.readyState !== WebSocket.OPEN) return null;
    if (!this.leaseCurrent(true)) return null;
    if (this.#pending.size >= NATIVE_CODEX_CALLBACK_TRANSPORT_MAX_PENDING) return null;
    const id = this.#mintId();
    let text: string;
    try {
      text = JSON.stringify({ jsonrpc: "2.0", id, method, params });
    } catch {
      return null;
    }
    if (Buffer.byteLength(text, "utf8") > NATIVE_CODEX_RPC_MAX_MESSAGE_BYTES) return null;
    // The injected clock is host code too: sample it BEFORE the guard and the
    // final fence, so nothing it does can follow the last ownership proof.
    let deadline: number;
    try {
      deadline = this.#now() + timeoutMs;
    } catch {
      return null;
    }
    if (!Number.isFinite(deadline)) return null;
    // The composer's own guard.
    let mayWrite: boolean;
    try {
      mayWrite = writeEdge();
    } catch {
      mayWrite = false;
    }
    if (!mayWrite) return null;
    // Final fence. The guard ran host code: re-prove the run and a fresh lease
    // snapshot (which may themselves run host code), and only THEN that the
    // same socket is still open and capacity remains (a guard can re-enter the
    // lane). No host code runs between these checks and `ws.send`.
    if (!this.leaseCurrent(true)) return null;
    if (this.#ws !== ws || this.#state !== "ready" || ws.readyState !== WebSocket.OPEN) return null;
    if (this.#pending.size >= NATIVE_CODEX_CALLBACK_TRANSPORT_MAX_PENDING) return null;

    return new Promise<Settlement>((resolve) => {
      const entry: Pending = { timer: null, deadline, settle: resolve };
      entry.timer = setTimeout(() => {
        if (this.#pending.get(id) !== entry) return;
        this.#pending.delete(id);
        resolve({ kind: "timeout" });
      }, timeoutMs);
      this.#pending.set(id, entry);
      try {
        ws.send(text, (error?: Error) => {
          // A failed write may have been partially flushed: uncertain, and the
          // connection is retired so nothing else is written on it.
          if (error !== undefined && error !== null) {
            this.#settlePending(id, { kind: "closed" });
            this.close();
          }
        });
      } catch {
        // Handed to the socket API and refused: not provably unwritten.
        this.#settlePending(id, { kind: "closed" });
        this.close();
      }
    });
  }

  /** `initialize` and `initialized` only. */
  #writeControl(payload: Record<string, unknown>): boolean {
    const ws = this.#ws;
    if (ws === null || ws.readyState !== WebSocket.OPEN) return false;
    try {
      ws.send(JSON.stringify(payload));
      return true;
    } catch {
      return false;
    }
  }

  #mintId(): string {
    this.#nextId += 1;
    return `cb-${this.#nextId}`;
  }

  #handleFrame(data: WebSocket.RawData, isBinary: boolean): void {
    if (this.#state === "closed" || isBinary) return;
    let frame: unknown;
    try {
      frame = JSON.parse(typeof data === "string" ? data : data.toString());
    } catch {
      return;
    }
    if (!isRecord(frame)) return;
    // A server request (approval, question, elicitation, auth refresh) or a
    // notification: dropped unread. Nothing is written back, and a server id
    // never enters the pending map.
    if (frame.method !== undefined) return;
    if (typeof frame.id !== "string") return;
    const entry = this.#pending.get(frame.id);
    if (entry === undefined) return; // late or unknown id: dropped, never adopted
    // Deadline on the monotonic clock, whatever order the timer callback runs in.
    this.#settlePending(frame.id, this.#beforeDeadline(entry.deadline) ? readEnvelope(frame) : { kind: "timeout" });
  }

  /** True only strictly before `deadline` on the monotonic clock; an unreadable clock is late. */
  #beforeDeadline(deadline: number): boolean {
    try {
      return this.#now() < deadline;
    } catch {
      return false;
    }
  }

  #settlePending(id: string, settlement: Settlement): void {
    const entry = this.#pending.get(id);
    if (entry === undefined) return;
    this.#pending.delete(id);
    if (entry.timer !== null) clearTimeout(entry.timer);
    entry.settle(settlement);
  }

  #teardown(): void {
    if (this.#state === "closed" && this.#ws === null && this.#pending.size === 0) return;
    this.#state = "closed";
    this.#ws = null;
    for (const id of [...this.#pending.keys()]) this.#settlePending(id, { kind: "closed" });
  }

  #resolveSocketClosed(): void {
    if (this.#socketClosedSettled) return;
    this.#socketClosedSettled = true;
    this.#socketClosedResolve();
  }
}

/* ----------------------------------------------------------------- opener */

function unavailable(
  code: NativeCodexCallbackTransportUnavailableCode,
  socketClosed: Promise<void> = Promise.resolve(),
): NativeCodexCallbackTransportOpen {
  return Object.freeze({ status: "unavailable", code, socketClosed });
}

/**
 * Open the one trusted callback transport for one exact owned lease and
 * thread. Never rejects. Ready only after the lease's own readiness, an
 * authenticated upgrade to that lease's exact endpoint, and an answered
 * `initialize` (with `CODEX_HOME` corroboration when supplied), each under a
 * re-proved current lease.
 */
export async function openNativeCodexCallbackTransport(
  options: NativeCodexCallbackTransportOptions,
): Promise<NativeCodexCallbackTransportOpen> {
  if (!isRecord(options) || !isRecord(options.lease)) return unavailable("options-invalid");
  const lease = options.lease;
  const identity = readIdentity(lease.identity);
  const owned = isRecord(options.owned) ? options.owned : null;
  const threadId = owned === null ? null : exactId(owned.threadId, NATIVE_CODEX_RPC_MAX_ID_CHARS);
  const runId = owned === null ? null : exactId(owned.runId, NATIVE_CODEX_RPC_MAX_ID_CHARS);
  if (
    identity === null
    || threadId === null
    || runId === null
    || typeof lease.status !== "function"
    || !isRecord(lease.readiness)
    || typeof (lease.readiness as { then?: unknown }).then !== "function"
    || typeof options.isOwnedRunCurrent !== "function"
    || !isRecord(options.attestation)
    || options.attestation.expectedTurnSteer !== true
    || (options.signal !== undefined && !(options.signal instanceof AbortSignal))
    || (options.clock !== undefined && (!isRecord(options.clock) || typeof options.clock.now !== "function"))
  ) {
    return unavailable("options-invalid");
  }
  const signal = options.signal;
  // A function, so a later abort is never narrowed away by an earlier check.
  const aborted = (): boolean => signal?.aborted === true;
  if (aborted()) return unavailable("aborted");
  const isOwnedRunCurrent = options.isOwnedRunCurrent;
  const clock = options.clock;
  const clockNow = clock === undefined ? () => performance.now() : () => clock.now();
  const connection = new CallbackConnection(
    lease,
    identity,
    threadId,
    () => isOwnedRunCurrent(),
    signal,
    boundedMs(options.steerTimeoutMs, NATIVE_CODEX_RPC_DEFAULT_REQUEST_TIMEOUT_MS),
    clockNow,
  );
  if (!connection.leaseCurrent(false)) {
    connection.close();
    return unavailable(aborted() ? "aborted" : "lease-not-current", connection.socketClosed);
  }

  // The endpoint comes ONLY from this lease's own readiness value.
  let ready: unknown;
  try {
    ready = await new Promise<unknown>((resolve, reject) => {
      const onAbort = () => reject(new Error("aborted"));
      signal?.addEventListener("abort", onAbort, { once: true });
      Promise.resolve(lease.readiness).then(
        (value) => {
          signal?.removeEventListener("abort", onAbort);
          resolve(value);
        },
        (error: unknown) => {
          signal?.removeEventListener("abort", onAbort);
          reject(error);
        },
      );
    });
  } catch {
    connection.close();
    return unavailable(aborted() ? "aborted" : "readiness-failed", connection.socketClosed);
  }
  if (connection.state === "closed" || aborted()) {
    connection.close();
    return unavailable("aborted", connection.socketClosed);
  }
  if (!connection.leaseCurrent(true)) {
    connection.close();
    return unavailable(aborted() ? "aborted" : "lease-not-current", connection.socketClosed);
  }
  let endpoint: NativeCodexRpcEndpoint;
  try {
    if (!isRecord(ready) || typeof ready.endpoint !== "string" || typeof ready.readObserverBearer !== "function") {
      throw new Error("ready value");
    }
    const readyValue = ready as unknown as Parameters<typeof readNativeCodexOwnedObserverEndpoint>[0];
    endpoint = readNativeCodexOwnedObserverEndpoint(readyValue);
  } catch {
    connection.close();
    return unavailable("endpoint-invalid", connection.socketClosed);
  }
  if (endpoint.kind !== "loopback-ws") {
    connection.close();
    return unavailable("endpoint-invalid", connection.socketClosed);
  }

  const expectedCodexHome = typeof options.expectedCodexHome === "string" && options.expectedCodexHome.trim().length > 0
    ? options.expectedCodexHome.trim()
    : null;
  const failure = await connection.open(
    endpoint,
    expectedCodexHome,
    boundedMs(options.handshakeTimeoutMs, NATIVE_CODEX_RPC_DEFAULT_HANDSHAKE_TIMEOUT_MS),
  );
  if (failure !== null) return unavailable(failure, connection.socketClosed);

  const steerLane: NativeCodexCallbackSteerLane = Object.freeze({
    ownership: NATIVE_CODEX_CALLBACK_LANE_OWNERSHIP,
    endpoint,
    capability: Object.freeze({ expectedTurnSteer: true as const }),
    steer: (params: NativeCodexCallbackSteerParams, writeEdge: NativeCodexCallbackSteerWriteEdge) =>
      connection.steer(params, writeEdge),
  });
  const queueLane: NativeCodexCallbackQueueLane = Object.freeze({
    ownership: NATIVE_CODEX_CALLBACK_QUEUE_LANE_OWNERSHIP,
    request: (
      method: NativeCodexIdleWakeQueueMethod,
      params: Readonly<Record<string, unknown>>,
      timeoutMs: number,
      writeEdge: NativeCodexCallbackQueueWriteEdge,
    ) => connection.queue(method, params, timeoutMs, writeEdge),
  });
  const transport: NativeCodexCallbackTransport = Object.freeze({
    steerLane,
    queueLane,
    get state(): "ready" | "closed" {
      return connection.state === "ready" ? "ready" : "closed";
    },
    get pendingRequestCount(): number {
      return connection.pendingRequestCount;
    },
    socketClosed: connection.socketClosed,
    close: () => connection.close(),
  });
  return Object.freeze({ status: "ready", transport });
}
