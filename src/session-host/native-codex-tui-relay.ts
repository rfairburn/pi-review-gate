/**
 * Private, authenticated relay between the genuine native Codex TUI and ONE
 * owned app-server backend, with a PASSIVE WebSocket frame metadata tap.
 *
 * ## Why a relay exists
 *
 * A hosted native Codex row needs correlated provider facts about its own live
 * TUI session: which thread that TUI actually started or resumed, which turn a
 * `turn/start` opened on which thread, which server approval or question is
 * pending and whether the TUI answered it, and which typed items started or
 * completed. The provider only exposes those facts on the connection that
 * produced them, and the read-only observer lane (`native-codex-rpc.ts`)
 * deliberately never subscribes, so it can never see them. This module puts a
 * private relay in front of ONE owned backend so the genuine TUI's own RPC
 * traffic passes a tap that reads metadata without ever becoming a participant.
 *
 * Nothing here patches the provider, installs a provider hook, changes provider
 * trust or configuration, or invents a codec. The TUI is launched with the
 * native `--remote <relay endpoint>` flag plus the SAME private auth environment
 * the backend lease already produces, so the provider speaks its own protocol
 * unchanged and the backend still receives the native auth secret.
 *
 * ## Ownership and authentication
 *
 * - The relay only ever dials the exact loopback endpoint of the
 *   {@link OwnedCodexBackendReady} capability the caller supplies. It never
 *   accepts a user URL, never adopts a shared or unauthenticated daemon, and
 *   never scans a port.
 * - The relay listens on `127.0.0.1:0`: numeric IPv4 loopback with an ephemeral
 *   port chosen by the operating system. It never binds a routable address.
 * - Every inbound handshake is authenticated by a constant-time comparison of
 *   the presented bearer against `backend.readObserverBearer()`, read only at
 *   the moment of comparison. The bearer never enters argv, a file, a log line,
 *   an error message, this module's status, or the process environment.
 * - At most ONE TUI connection is active at a time. A second concurrent
 *   handshake is refused at the HTTP layer. Each accepted handshake is a new
 *   connection generation with fresh correlation state, so ids and metadata
 *   never bleed across a reconnect.
 *
 * ## Unchanged-bytes invariant (transport authority is byte-level)
 *
 * The relay is an opaque TCP/HTTP-Upgrade forwarder with a read-only frame tap:
 *
 * - the client's request line, header order, header case, unknown headers, and
 *   WebSocket extension offers are forwarded verbatim. The ONLY rewrite is the
 *   `Host` header, replaced with the exact owned backend authority because the
 *   dial target differs from the address the TUI was given;
 * - after the handshake, bytes are copied chunk-by-chunk in both directions with
 *   real backpressure. Frames are never re-encoded, re-fragmented, coalesced,
 *   re-masked, reordered, or dropped. The provider's own ceilings (the 16 MiB
 *   advertised unfragmented-message bound and the 128 MiB frame/message caps)
 *   stay the provider's business: this module imposes no transport cap, and its
 *   metadata budgets only ever reduce what the TAP reads;
 * - a stateful compressed stream (a negotiated extension, or any frame carrying
 *   an RSV bit) is copied untouched and the tap withdraws its metadata with a
 *   closed reason. No compression feature is forced, disabled, downgraded, or
 *   re-implemented here;
 * - the relay generates ZERO application-layer bytes. It never emits a JSON-RPC
 *   request, response, error, `subscribe`, `resume`, `start`, `fork`, retry, or
 *   automatic approval. The only bytes it originates are the rewritten handshake
 *   head and the refused-handshake HTTP status lines. Every client control frame
 *   seen by the backend is a byte-forwarded frame the genuine TUI originated.
 *
 * ## Closed metadata projections
 *
 * The tap only ever emits the closed {@link NativeCodexTuiRelayMetadataEvent}
 * union: recognized projection keys carrying opaque ids, closed enums,
 * booleans, and counts. There is no raw-frame, send, reply, or generic message
 * callback.
 *
 * - Metadata is gated on the connection's own genuine `initialize`, which must
 *   carry BOTH the native TUI's client name and the human-approval capability.
 *   A client that omits the capability or sets it false is never treated as the
 *   native TUI, and frames from any other client on the relay produce no
 *   session metadata at all.
 * - `thread-candidate` and `turn-work-target` name a WORK TARGET: a thread or
 *   turn that this connection's own successful response named. They are NOT a
 *   root selection, NOT proof of the row's primary session, and NOT a claim that
 *   any thread is the root. Native helper request ids are labelled so a consumer
 *   can exclude them; nothing here infers a root from the last success. A
 *   resume/fork candidate also carries the request's own original
 *   `params.threadId` as `requestedThreadId`, so a consumer can compare what
 *   was asked for with what the success named; it is an id only.
 * - `input-request` / `input-response` cover only the allowlisted human-input
 *   and approval methods. Other backend requests (a clock read, a tool call,
 *   an auth refresh, any future method) are forwarded untouched and are never
 *   projected as operator input. The relay records only that the backend asked
 *   the TUI something, and whether the TUI's own reply carried an error. It
 *   never answers, never forwards an answer it did not see the TUI send, and
 *   never reads the question, its options, or the answer.
 * - Asynchronous questions are NOT server requests. `async-questions` projects a
 *   completed `agentMessage` item carrying `delivery: "async"` questions as its
 *   item id, envelope thread/turn ids, and question count only.
 *   `async-question-reply` projects a committed `userMessage` whose single text
 *   is the native reply envelope as the answered question identities only; the
 *   envelope is parsed transiently with the native parser's whole-shape rules,
 *   and its question and answer strings are dropped. `async-input-unreadable`
 *   reports a question or user item that could not be read in full, and
 *   `turn-terminal` projects a live `turn/completed` terminal status (the native
 *   TUI's own queue retirement point). `ordinary-input` reports that this
 *   connection's own client `turn/start`/`turn/steer` carried ordinary model
 *   input (anything but exactly the reply envelope), observed on the client
 *   frame itself: the native TUI clears its unanswered queue on such a
 *   submission, so earlier questions may have been dropped locally. None of
 *   these is a reply or a control.
 * - Turn lifecycle (#682): `turn-started` projects a live `turn/started`
 *   notification's thread and turn ids; `turn-interrupt-request` projects this
 *   connection's own client `turn/interrupt` REQUEST (its original
 *   `params.threadId`/`params.turnId` and id kind) at the moment the client
 *   frame is observed, before it is forwarded; and `turn-lifecycle-unreadable`
 *   reports a `turn/started` or `turn/completed` notification this tap could
 *   not read in full (including an unrecognized completion status), so a
 *   consumer never mistakes it for "nothing happened". A `turn-work-target`
 *   also carries `requestAfterSequence`, the generation's last event sequence
 *   when its `turn/start` request frame was observed, so a consumer can order
 *   the request against earlier and later events even when the reply is
 *   delayed. They are passive observations of traffic the relay already
 *   forwards: never a reply, a control, or a request the relay originates.
 * - Prompts, previews, thread names, cwds, rollout paths, model text, commands,
 *   diffs, outputs, error MESSAGES, questions, options, answers, auth headers,
 *   and secrets are never placed in an event, a status value, or an error. Raw
 *   bytes exist transiently inside the tap while it extracts bounded projection
 *   keys and are dropped immediately.
 *
 * ## Failure containment
 *
 * A metadata failure is never a transport failure. An unreadable, oversized, or
 * unknown projection withdraws metadata (per message, or for the whole
 * connection with its pending correlation retired) and always carries a closed
 * reason while forwarding continues. A throwing consumer is contained.
 * Detaching the tap removes observation only; it never disconnects the TUI or
 * the backend.
 *
 * ## Settlement
 *
 * `requestStop()` is idempotent and settles on real close events only: the
 * listener's own close completion and every socket this relay created's own
 * `close`. No acknowledgement, timer, or `destroyed` flag is treated as proof.
 */

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import net from "node:net";
import { isRecord } from "../record-guard";
import type { OwnedCodexBackendReady, OwnedCodexTuiConnection } from "./native-codex-backend";

/* ------------------------------------------------------------------ bounds */

/** Bounded client handshake head. A native handshake is small. */
export const NATIVE_CODEX_TUI_RELAY_MAX_REQUEST_HEADER_BYTES = 32 * 1024;
/** Bounded backend handshake response head. */
export const NATIVE_CODEX_TUI_RELAY_MAX_RESPONSE_HEADER_BYTES = 16 * 1024;
/** Bytes the client may queue while the relay dials the owned backend. */
export const NATIVE_CODEX_TUI_RELAY_MAX_PREFLIGHT_BYTES = 64 * 1024;

export const NATIVE_CODEX_TUI_RELAY_DEFAULT_HANDSHAKE_TIMEOUT_MS = 10_000;
export const NATIVE_CODEX_TUI_RELAY_MIN_HANDSHAKE_TIMEOUT_MS = 250;

/**
 * Metadata READ budget only. This is not a transport cap and never limits what
 * is forwarded: a larger message is simply not projected, and its bytes are
 * copied unchanged.
 */
export const NATIVE_CODEX_TUI_RELAY_METADATA_MAX_MESSAGE_BYTES = 4 * 1024 * 1024;
export const NATIVE_CODEX_TUI_RELAY_MIN_METADATA_MESSAGE_BYTES = 1_024;

/** Bounded pending correlation windows, per connection generation. */
export const NATIVE_CODEX_TUI_RELAY_MAX_PENDING_TUI_REQUESTS = 64;
export const NATIVE_CODEX_TUI_RELAY_MAX_PENDING_INPUT_REQUESTS = 32;

/** Provider ids are short; a longer one is not projected. */
export const NATIVE_CODEX_TUI_RELAY_MAX_ID_CHARS = 256;

/** The native interactive client's own `initialize` name. */
export const NATIVE_CODEX_TUI_RELAY_GENUINE_CLIENT_NAME = "codex-tui";

/**
 * Native helper traffic is identifiable by its request id prefix. Labelled, not
 * deleted: a consumer excludes helpers instead of this module guessing a root.
 */
export const NATIVE_CODEX_TUI_RELAY_HELPER_REQUEST_ID_PREFIXES: readonly string[] = Object.freeze([
  "temporary-structured-",
]);

/** Methods whose successful responses are projected. Everything else passes. */
const PROJECTED_TUI_REQUEST_METHODS: ReadonlyMap<string, PendingTuiRequestOrigin> = new Map([
  ["thread/start", "thread-start"],
  ["thread/resume", "thread-resume"],
  ["thread/fork", "thread-fork"],
  ["turn/start", "turn-start"],
]);

/** Closed item-type vocabulary (provider wire discriminator `item.type`). An
 * unlisted type is ignored, never guessed. */
const PROJECTED_ITEM_TYPES: ReadonlyMap<string, NativeCodexTuiRelayToolCategory | undefined> = new Map([
  ["agentMessage", undefined],
  ["reasoning", undefined],
  ["plan", undefined],
  ["todoList", undefined],
  ["userMessage", undefined],
  ["approvalRequest", undefined],
  ["error", undefined],
  ["commandExecution", "command"],
  ["fileChange", "file-change"],
  ["mcpToolCall", "mcp-tool"],
  ["dynamicToolCall", "dynamic-tool"],
  ["webSearch", "web-search"],
]);

/**
 * The closed set of backend requests that ask the operator something through
 * the TUI, using the provider's own wire spellings. Anything else the backend
 * may request — `currentTime/read`, `item/tool/call`,
 * `chatgptAuthTokens/refresh`, `attestation/generate`, and every future method
 * — is forwarded untouched, is never projected as an operator input request,
 * and its reply is never correlated.
 */
export const NATIVE_CODEX_TUI_RELAY_INPUT_REQUEST_METHODS: readonly NativeCodexTuiRelayInputRequestMethod[] = Object.freeze([
  "item/commandExecution/requestApproval",
  "item/fileChange/requestApproval",
  "item/permissions/requestApproval",
  "item/tool/requestUserInput",
  "mcpServer/elicitation/request",
]);

const PROJECTED_INPUT_REQUEST_METHODS: ReadonlySet<string> = new Set<string>(
  NATIVE_CODEX_TUI_RELAY_INPUT_REQUEST_METHODS,
);

/* ------------------------------------------------------------------- types */

/** Closed reasons the relay itself can fail to start. */
export type NativeCodexTuiRelayFailureCode =
  | "backend-capability-invalid"
  | "backend-endpoint-invalid"
  | "listen-failed"
  | "stopped";

/** Closed reasons the tap stops projecting metadata. */
export type NativeCodexTuiRelayMetadataUnavailableReason =
  | "compressed-stream"
  | "frame-protocol-invalid"
  | "message-oversize"
  | "json-unreadable"
  | "correlation-overflow";

/** Closed reasons one connection generation ended. */
export type NativeCodexTuiRelayGenerationCloseReason =
  | "client-closed"
  | "backend-closed"
  | "backend-handshake-rejected"
  | "handshake-timeout"
  | "preflight-overflow"
  | "relay-stopped";

export type NativeCodexTuiRelayToolCategory =
  | "command"
  | "file-change"
  | "mcp-tool"
  | "dynamic-tool"
  | "web-search";

export type NativeCodexTuiRelayThreadOrigin = "thread-start" | "thread-resume" | "thread-fork";

/** The closed operator-input request surface (see the allowlist constant). */
export type NativeCodexTuiRelayInputRequestMethod =
  | "item/commandExecution/requestApproval"
  | "item/fileChange/requestApproval"
  | "item/permissions/requestApproval"
  | "item/tool/requestUserInput"
  | "mcpServer/elicitation/request";

/** The four projected request shapes; `turn-start` is not a thread origin. */
type PendingTuiRequestOrigin = NativeCodexTuiRelayThreadOrigin | "turn-start";

/**
 * `native-helper` marks a request id with a known native helper prefix. It is a
 * fact about the id, not a judgement about the session.
 */
export type NativeCodexTuiRelayRequestIdKind = "native" | "native-helper";

interface NativeCodexTuiRelayEventBase {
  /** Opaque id of one connection generation; the consumer's fence. */
  readonly connectionId: string;
  /** Strictly increasing within one generation. */
  readonly sequence: number;
}

/** The connection ran a genuine native TUI `initialize`. */
export interface NativeCodexTuiRelayGenuineInitializeEvent extends NativeCodexTuiRelayEventBase {
  readonly kind: "genuine-tui-initialize";
  readonly clientName: string;
  /** The `requiredHumanApproval` capability the TUI itself asked for. */
  readonly humanApprovalRequired: boolean;
}

/**
 * This connection's own successful thread RPC named a thread. A CANDIDATE only:
 * not a root selection and not proof of the row's primary session.
 */
export interface NativeCodexTuiRelayThreadCandidateEvent extends NativeCodexTuiRelayEventBase {
  readonly kind: "thread-candidate";
  readonly origin: NativeCodexTuiRelayThreadOrigin;
  readonly requestIdKind: NativeCodexTuiRelayRequestIdKind;
  readonly threadId: string;
  /**
   * For `thread-resume` and `thread-fork` only: the request's OWN original
   * `params.threadId` (the thread the TUI asked to resume, or forked from),
   * paired with this exact successful response. It is never copied from the
   * response and is absent when the request named no bounded id. An id only:
   * no other request parameter is retained or projected.
   */
  readonly requestedThreadId?: string;
  readonly parentThreadId?: string;
  readonly ephemeral?: boolean;
}

/**
 * This connection's own successful `turn/start` correlated the request's
 * ORIGINAL `params.threadId` with the returned turn id. A WORK TARGET only.
 */
export interface NativeCodexTuiRelayTurnWorkTargetEvent extends NativeCodexTuiRelayEventBase {
  readonly kind: "turn-work-target";
  readonly requestIdKind: NativeCodexTuiRelayRequestIdKind;
  readonly threadId: string;
  readonly turnId: string;
  /**
   * Request-order evidence (#682): the `sequence` of the last event this
   * generation emitted BEFORE the correlated `turn/start` request frame was
   * observed (0 when none). Any event with a greater sequence was observed
   * after the request, whatever order the replies arrive in. The relay always
   * supplies it; a consumer treats its absence as order not proven.
   */
  readonly requestAfterSequence?: number;
}

/** The backend asked the TUI something (approval, question, elicitation). */
export interface NativeCodexTuiRelayInputRequestEvent extends NativeCodexTuiRelayEventBase {
  readonly kind: "input-request";
  readonly requestId: string;
  readonly method: NativeCodexTuiRelayInputRequestMethod;
  readonly threadId?: string;
}

/**
 * The TUI itself replied to that server request. Only the presence of an error
 * is reported; the reply's content is never read.
 */
export interface NativeCodexTuiRelayInputResponseEvent extends NativeCodexTuiRelayEventBase {
  readonly kind: "input-response";
  readonly requestId: string;
  readonly method: NativeCodexTuiRelayInputRequestMethod;
  readonly hasError: boolean;
}

/** A typed item started or completed on this connection. */
export interface NativeCodexTuiRelayItemPhaseEvent extends NativeCodexTuiRelayEventBase {
  readonly kind: "item-phase";
  readonly phase: "started" | "completed";
  readonly itemKind: string;
  readonly itemId: string;
  readonly threadId?: string;
  readonly turnId?: string;
  readonly toolCategory?: NativeCodexTuiRelayToolCategory;
}

/**
 * A completed backend `agentMessage` item carrying asynchronous questions
 * (`delivery: "async"` plus a fully readable `questions` array, possibly empty:
 * the native queue ignores an empty list, which still completes that item's
 * question set). It is
 * NOT a server request and has no reply frame: the native TUI registers the
 * questions from the completed item under `itemId` and keys each one by its
 * index. Only the item id, the envelope's thread/turn ids, and the question count
 * are projected — never a title, an option, or any other text.
 */
export interface NativeCodexTuiRelayAsyncQuestionsEvent extends NativeCodexTuiRelayEventBase {
  readonly kind: "async-questions";
  readonly itemId: string;
  readonly questionCount: number;
  readonly threadId?: string;
  readonly turnId?: string;
}

/** One answered async question named by a committed native reply envelope. */
export interface NativeCodexTuiRelayAsyncQuestionAnswer {
  /** The asking `agentMessage` item id. */
  readonly itemId: string;
  /**
   * The question's index inside that item. Absent when the reply named the whole
   * item (the older native whole-message reply identity).
   */
  readonly index?: number;
}

/**
 * A committed backend `userMessage` item whose content is exactly the native
 * async-question reply envelope. Only the answered question identities are
 * projected; the question and answer strings are parsed transiently and dropped.
 */
export interface NativeCodexTuiRelayAsyncQuestionReplyEvent extends NativeCodexTuiRelayEventBase {
  readonly kind: "async-question-reply";
  readonly answers: readonly NativeCodexTuiRelayAsyncQuestionAnswer[];
  readonly threadId?: string;
  readonly turnId?: string;
}

/**
 * A completed item that could have published async questions (`questions`) or
 * committed a reply to them (`user-input`) could not be read in full. It is an
 * input-knowledge gap for that thread only, never a statement that nothing is
 * pending.
 */
export interface NativeCodexTuiRelayAsyncInputUnreadableEvent extends NativeCodexTuiRelayEventBase {
  readonly kind: "async-input-unreadable";
  readonly source: "questions" | "user-input";
  /**
   * For `questions` only: the asking item's bounded id when it was readable, so
   * the gap is scoped to that item. Absent when the id itself was unreadable.
   */
  readonly itemId?: string;
  readonly threadId?: string;
  readonly turnId?: string;
}

/**
 * This connection's own client `turn/start` or `turn/steer` REQUEST carried
 * non-empty model input that is NOT exactly the native async-question reply
 * envelope (an ordinary prompt), or input this tap could not read in full.
 *
 * The native TUI clears its unanswered async question queue when it submits an
 * ordinary model prompt, so this is emitted when the client frame is observed —
 * never on the backend's acknowledgement or error — and it means only that the
 * questions held BEFORE this submission may have been dropped locally. It is
 * not proof that any question was dropped (one still in flight toward the TUI
 * was not), not an answer, not a root selection, and not a reply or control.
 * Only the request's ORIGINAL `params.threadId` and its id kind are projected;
 * the input itself is read transiently and dropped.
 */
export interface NativeCodexTuiRelayOrdinaryInputEvent extends NativeCodexTuiRelayEventBase {
  readonly kind: "ordinary-input";
  readonly requestIdKind: NativeCodexTuiRelayRequestIdKind;
  readonly threadId?: string;
}

/**
 * A live `turn/completed` notification whose turn reached a terminal status.
 * The native TUI retires its remaining async questions on exactly this event; it
 * is a queue retirement, never a human answer.
 */
export interface NativeCodexTuiRelayTurnTerminalEvent extends NativeCodexTuiRelayEventBase {
  readonly kind: "turn-terminal";
  readonly threadId: string;
  readonly turnId: string;
  readonly status: "completed" | "interrupted" | "failed";
}

/**
 * A live `turn/started` notification named a thread and the turn that started
 * on it. Who started the turn is not claimed: it is thread activity, not a root
 * selection and not this connection's own work.
 */
export interface NativeCodexTuiRelayTurnStartedEvent extends NativeCodexTuiRelayEventBase {
  readonly kind: "turn-started";
  readonly threadId: string;
  readonly turnId: string;
}

/**
 * This connection's own client `turn/interrupt` REQUEST (a stop request),
 * projected when the client frame is observed — before the relay forwards it
 * and independent of the backend's acknowledgement or error. Only the request's
 * ORIGINAL bounded `params.threadId`/`params.turnId` and its id kind are
 * projected; either is absent when unreadable, never guessed.
 */
export interface NativeCodexTuiRelayTurnInterruptRequestEvent extends NativeCodexTuiRelayEventBase {
  readonly kind: "turn-interrupt-request";
  readonly requestIdKind: NativeCodexTuiRelayRequestIdKind;
  readonly threadId?: string;
  readonly turnId?: string;
}

/**
 * A `turn/started` or `turn/completed` notification could not be read in full
 * (missing or unbounded ids, or a completion status outside the known closed
 * set). A turn-lifecycle knowledge gap for that thread (or, without a readable
 * thread id, any thread), never a statement that nothing changed.
 */
export interface NativeCodexTuiRelayTurnLifecycleUnreadableEvent extends NativeCodexTuiRelayEventBase {
  readonly kind: "turn-lifecycle-unreadable";
  readonly method: "turn/started" | "turn/completed";
  readonly threadId?: string;
}

/** Metadata was withdrawn; forwarding is unaffected. */
export interface NativeCodexTuiRelayMetadataUnavailableEvent extends NativeCodexTuiRelayEventBase {
  readonly kind: "metadata-unavailable";
  readonly scope: "connection" | "message";
  readonly reason: NativeCodexTuiRelayMetadataUnavailableReason;
}

/** One connection generation ended. */
export interface NativeCodexTuiRelayGenerationClosedEvent extends NativeCodexTuiRelayEventBase {
  readonly kind: "generation-closed";
  readonly reason: NativeCodexTuiRelayGenerationCloseReason;
}

/** The complete closed metadata surface. There is no raw-frame callback. */
export type NativeCodexTuiRelayMetadataEvent =
  | NativeCodexTuiRelayGenuineInitializeEvent
  | NativeCodexTuiRelayThreadCandidateEvent
  | NativeCodexTuiRelayTurnWorkTargetEvent
  | NativeCodexTuiRelayInputRequestEvent
  | NativeCodexTuiRelayInputResponseEvent
  | NativeCodexTuiRelayItemPhaseEvent
  | NativeCodexTuiRelayAsyncQuestionsEvent
  | NativeCodexTuiRelayAsyncQuestionReplyEvent
  | NativeCodexTuiRelayAsyncInputUnreadableEvent
  | NativeCodexTuiRelayOrdinaryInputEvent
  | NativeCodexTuiRelayTurnTerminalEvent
  | NativeCodexTuiRelayTurnStartedEvent
  | NativeCodexTuiRelayTurnInterruptRequestEvent
  | NativeCodexTuiRelayTurnLifecycleUnreadableEvent
  | NativeCodexTuiRelayMetadataUnavailableEvent
  | NativeCodexTuiRelayGenerationClosedEvent;

/** Read-only observation of this relay's lifecycle and resource counts. */
export interface NativeCodexTuiRelayStatus {
  readonly phase: "starting" | "listening" | "stopping" | "stopped";
  readonly listening: boolean;
  readonly stopRequested: boolean;
  /** 0 or 1: one TUI connection at a time. */
  readonly activeConnections: number;
  /** Total accepted generations since start. */
  readonly connectionGenerations: number;
  /** Sockets this relay created that have not reported their own `close`. */
  readonly openSockets: number;
  readonly refusedUnauthenticated: number;
  readonly refusedBusy: number;
  readonly refusedMalformed: number;
  readonly metadataTapEnabled: boolean;
  readonly metadataCallbackErrors: number;
  /** Post-handshake payload bytes copied from the TUI toward the backend. */
  readonly forwardedBytesToBackend: number;
  /** Post-handshake payload bytes copied from the backend toward the TUI. */
  readonly forwardedBytesToClient: number;
}

/** Positive settlement proof: real close events, nothing else. */
export interface NativeCodexTuiRelaySettlement {
  readonly status: "settled";
  readonly listenerClosed: true;
  readonly socketsClosed: true;
  readonly connectionGenerations: number;
}

/** Owner-private readiness value: the relay endpoint plus TUI material. */
export interface NativeCodexTuiRelayReadiness {
  /** `ws://127.0.0.1:<ephemeral port>` — the only address the TUI is given. */
  readonly endpoint: string;
  readonly port: number;
  /**
   * Sensitive: fresh child-only TUI material whose `--remote` points at the
   * RELAY and whose auth environment is the backend lease's own private clone.
   * Never log or persist the returned environment.
   */
  createTuiConnection(): OwnedCodexTuiConnection;
}

export interface NativeCodexTuiRelayInput {
  /** The exact owned backend capability this relay may front. */
  readonly backend: OwnedCodexBackendReady;
  /** Closed metadata sink. A throw is contained and never affects forwarding. */
  readonly onMetadata: (event: NativeCodexTuiRelayMetadataEvent) => void;
  /** Narrow seams; both are clamped and neither weakens an invariant. */
  readonly handshakeTimeoutMs?: number;
  readonly metadataMaxMessageBytes?: number;
}

export interface NativeCodexTuiRelayLease {
  /** Fulfills only after the relay's own listener reports `listening`. */
  readonly readinessPromise: Promise<NativeCodexTuiRelayReadiness>;
  /** Never rejects; resolves only on real listener and socket close events. */
  readonly settlementPromise: Promise<NativeCodexTuiRelaySettlement>;
  status(): NativeCodexTuiRelayStatus;
  /** Idempotent. Requests the relay's own close; settles on real close. */
  requestStop(): void;
  /**
   * Removes the metadata tap ONLY. The native TUI connection, the backend
   * connection, and all forwarding keep running.
   */
  detachMetadataTap(): void;
}

/** Sanitized relay failure; no provider text, header, or secret is captured. */
export class NativeCodexTuiRelayError extends Error {
  readonly code: NativeCodexTuiRelayFailureCode;

  constructor(code: NativeCodexTuiRelayFailureCode) {
    super(`native Codex TUI relay failed: ${code}`);
    this.name = "NativeCodexTuiRelayError";
    this.code = code;
  }
}

/* --------------------------------------------------------------- utilities */

function sha256(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

/**
 * Constant-time bearer comparison. Both sides are digested first, so neither the
 * presented length nor a prefix match is observable, and the expected value is
 * read only at the moment of comparison.
 */
function bearerMatches(presented: string, expected: string): boolean {
  try {
    return timingSafeEqual(sha256(presented), sha256(expected));
  } catch {
    return false;
  }
}

/** Opaque provider ids: bounded, printable, no control characters. */
function readBoundedId(value: unknown): string | null {
  let text: string;
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) return null;
    text = String(value);
  } else if (typeof value === "string") {
    text = value;
  } else {
    return null;
  }
  if (text.length === 0 || text.length > NATIVE_CODEX_TUI_RELAY_MAX_ID_CHARS) return null;
  if (/[\u0000-\u001F\u007F]/.test(text)) return null;
  return text;
}

function isHelperRequestId(idText: string): boolean {
  return NATIVE_CODEX_TUI_RELAY_HELPER_REQUEST_ID_PREFIXES.some((prefix) => idText.startsWith(prefix));
}

/** One JSON-RPC id's correlation key (numeric and string ids never collide). */
function idKeyOf(value: unknown): { readonly key: string; readonly text: string } | null {
  const text = readBoundedId(value);
  if (text === null) return null;
  return typeof value === "number" ? { key: `n:${text}`, text } : { key: `s:${text}`, text };
}

/** Locate `\r\n\r\n` in a bounded buffer, or -1. */
function findHeaderEnd(buffer: Buffer): number {
  const limit = buffer.length - 3;
  for (let index = 0; index < limit; index += 1) {
    if (
      buffer[index] === 0x0d
      && buffer[index + 1] === 0x0a
      && buffer[index + 2] === 0x0d
      && buffer[index + 3] === 0x0a
    ) {
      return index;
    }
  }
  return -1;
}

function parseJsonMessage(text: string): Record<string, unknown> | null {
  if (text.length === 0) return null;
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  return isRecord(value) ? value : null;
}

function nestedValue(value: unknown, path: readonly string[]): unknown {
  let current = value;
  for (const key of path) {
    if (!isRecord(current)) return undefined;
    current = current[key];
  }
  return current;
}

/* ------------------------------------------------- async question metadata */

/** The native async-question tool name embedded in every question key. */
const ASYNC_QUESTION_TOOL_NAME = "request_user_input_async";
/** The native reply envelope markers (`AnsweredQuestion::type_markers`). */
const ASYNC_REPLY_START_MARKER = "<send_user_message_question_reply>";
const ASYNC_REPLY_END_MARKER = "</send_user_message_question_reply>";
/** The canonical IDE context prefix the native reply parser accepts. */
const IDE_CONTEXT_PREFIX = "# Context from my IDE setup:\n";
const IDE_REQUEST_DELIMITER = "\n## My request for Codex:\n";

/**
 * The native question key for one question: the exact string the provider UI
 * builds with `JSON.stringify([tool name, item id, question index])`.
 */
export function nativeCodexAsyncQuestionKey(itemId: string, index: number): string {
  return JSON.stringify([ASYNC_QUESTION_TOOL_NAME, itemId, index]);
}

/**
 * The number of questions in a fully readable native `questions` array (each a
 * `{ title: string, options?: string[] | null }`), or null when any part of the
 * shape is unreadable. Titles and options are inspected for type only and are
 * never retained.
 */
function readAsyncQuestionCount(value: unknown): number | null {
  if (!Array.isArray(value)) return null;
  for (const question of value) {
    if (!isRecord(question) || typeof question.title !== "string") return null;
    const options = question.options;
    if (options === undefined || options === null) continue;
    if (!Array.isArray(options) || !options.every((option) => typeof option === "string")) return null;
  }
  return value.length;
}

/**
 * The single text of a committed `userMessage` content list, following the
 * native reply reader: skill and mention attachments are ignored, and the
 * message qualifies only when exactly one text item remains. The result is
 * tagged, so no user text can ever be mistaken for the unreadable outcome.
 */
type UserTextRead =
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "not-reply" }
  | { readonly kind: "unreadable" };

const USER_TEXT_NOT_REPLY: UserTextRead = Object.freeze({ kind: "not-reply" as const });
const USER_TEXT_UNREADABLE: UserTextRead = Object.freeze({ kind: "unreadable" as const });

function readSingleUserText(content: unknown): UserTextRead {
  if (!Array.isArray(content)) return USER_TEXT_UNREADABLE;
  let text: string | null = null;
  let count = 0;
  for (const entry of content) {
    if (!isRecord(entry) || typeof entry.type !== "string") return USER_TEXT_UNREADABLE;
    if (entry.type === "skill" || entry.type === "mention") continue;
    count += 1;
    if (entry.type === "text") {
      if (typeof entry.text !== "string") return USER_TEXT_UNREADABLE;
      if (count === 1) text = entry.text;
    }
  }
  return count === 1 && text !== null ? { kind: "text", text } : USER_TEXT_NOT_REPLY;
}

/** Rust `str::trim`: Unicode `White_Space` on both ends. */
function trimWhiteSpace(value: string): string {
  return value.replace(/^\p{White_Space}+|\p{White_Space}+$/gu, "");
}

function isAsyncReplyRecord(value: unknown): value is Record<string, unknown> {
  return isRecord(value)
    && typeof value.questionItemId === "string"
    && typeof value.question === "string"
    && typeof value.answer === "string";
}

/**
 * Parse the canonical native reply envelope and project ONLY the answered
 * question identities. The whole envelope must have the native shape — the
 * markers around a non-empty array of (or one) `{questionItemId, question,
 * answer}` record(s) — or nothing is projected. The question and answer
 * strings are type-checked and discarded. An identity that is neither an exact
 * canonical question key nor a bounded whole-item id cannot equal any native
 * pending key, so it is skipped rather than guessed at.
 */
function parseAsyncQuestionReplyIds(text: string): NativeCodexTuiRelayAsyncQuestionAnswer[] | null {
  let body = trimWhiteSpace(text);
  if (body.startsWith(IDE_CONTEXT_PREFIX)) {
    const at = body.lastIndexOf(IDE_REQUEST_DELIMITER);
    if (at < 0) return null;
    body = trimWhiteSpace(body.slice(at + IDE_REQUEST_DELIMITER.length));
  }
  if (!body.startsWith(ASYNC_REPLY_START_MARKER) || !body.endsWith(ASYNC_REPLY_END_MARKER)) return null;
  const json = body.slice(ASYNC_REPLY_START_MARKER.length, body.length - ASYNC_REPLY_END_MARKER.length);
  if (json.length === 0) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return null;
  }
  const replies: unknown[] = Array.isArray(parsed) ? parsed : [parsed];
  if (replies.length === 0 || !replies.every(isAsyncReplyRecord)) return null;
  const answers: NativeCodexTuiRelayAsyncQuestionAnswer[] = [];
  const seen = new Set<string>();
  for (const reply of replies as Record<string, unknown>[]) {
    const id = reply.questionItemId as string;
    if (seen.has(id)) continue;
    seen.add(id);
    const answer = readAsyncQuestionIdentity(id);
    if (answer !== null) answers.push(answer);
  }
  return answers;
}

/** The native TUI's client requests that submit model input. */
const MODEL_INPUT_TUI_REQUEST_METHODS: ReadonlySet<string> = new Set(["turn/start", "turn/steer"]);

/**
 * Classify one client model-input list (the native `UserInput` items) without
 * retaining any of it: no model content at all, exactly the canonical native
 * reply envelope (the TUI's own question-answer submission, which never clears
 * its queue), ordinary model input, or input that could not be read in full.
 */
function classifyTuiModelInput(input: unknown): "none" | "question-answer" | "ordinary" | "unreadable" {
  const single = readSingleUserText(input);
  if (single.kind === "unreadable") return "unreadable";
  if (single.kind === "text") {
    if (single.text.length === 0) return "none";
    return parseAsyncQuestionReplyIds(single.text) === null ? "ordinary" : "question-answer";
  }
  // Not a single text: ordinary multi-part or non-text model content, or only
  // skill/mention attachments with no model content at all.
  const entries = input as readonly Record<string, unknown>[];
  return entries.some((entry) => entry.type !== "skill" && entry.type !== "mention") ? "ordinary" : "none";
}

function readAsyncQuestionIdentity(id: string): NativeCodexTuiRelayAsyncQuestionAnswer | null {
  if (id.startsWith("[")) {
    let key: unknown;
    try {
      key = JSON.parse(id);
    } catch {
      key = undefined;
    }
    if (
      Array.isArray(key)
      && key.length === 3
      && key[0] === ASYNC_QUESTION_TOOL_NAME
      && typeof key[1] === "string"
      && typeof key[2] === "number"
      && Number.isSafeInteger(key[2])
      && key[2] >= 0
    ) {
      const itemId = readBoundedId(key[1]);
      // Only the exact native spelling matches; a re-spaced key never would.
      if (itemId !== null && nativeCodexAsyncQuestionKey(itemId, key[2]) === id) {
        return Object.freeze({ itemId, index: key[2] });
      }
    }
  }
  const whole = readBoundedId(id);
  return whole === null ? null : Object.freeze({ itemId: whole });
}

/* --------------------------------------------------- handshake header work */

interface ParsedUpgradeHead {
  readonly requestLine: Buffer;
  /** Raw header lines in original order and case, without their CRLF. */
  readonly headerLines: readonly Buffer[];
  readonly authorizationToken: string | null;
  readonly websocketUpgrade: boolean;
  readonly hasWebSocketKey: boolean;
  readonly hostCount: number;
}

/**
 * Parse the bounded client handshake head. Unknown headers, duplicate headers,
 * header order, and header case are retained as raw bytes; only the fields the
 * relay must act on are decoded.
 */
function parseUpgradeHead(head: Buffer): ParsedUpgradeHead | null {
  const lines = head.toString("latin1").split("\r\n");
  const requestLine = lines[0] as string;
  if (!/^GET [^\s]+ HTTP\/1\.1$/.test(requestLine)) return null;

  const headerLines: Buffer[] = [];
  let authorizationToken: string | null = null;
  let websocketUpgrade = false;
  let hasWebSocketKey = false;
  let hostCount = 0;

  for (let index = 1; index < lines.length; index += 1) {
    const line = lines[index] as string;
    if (line.length === 0) continue;
    // Obsolete line folding and a missing colon are never native handshakes.
    if (/^[ \t]/.test(line)) return null;
    const colon = line.indexOf(":");
    if (colon <= 0) return null;
    const name = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();
    headerLines.push(Buffer.from(line, "latin1"));
    if (name === "host") {
      hostCount += 1;
    } else if (name === "upgrade") {
      const tokens = value.toLowerCase().split(",").map((token) => token.trim());
      if (tokens.includes("websocket")) websocketUpgrade = true;
    } else if (name === "sec-websocket-key") {
      hasWebSocketKey = true;
    } else if (name === "authorization" && authorizationToken === null) {
      const match = /^Bearer[ \t]+(\S+)$/i.exec(value);
      if (match !== null) authorizationToken = match[1] as string;
    }
  }

  return {
    requestLine: Buffer.from(requestLine, "latin1"),
    headerLines,
    authorizationToken,
    websocketUpgrade,
    hasWebSocketKey,
    hostCount,
  };
}

/** Re-issue the client's handshake with ONLY the `Host` authority rewritten. */
function rebuildHeadForBackend(parsed: ParsedUpgradeHead, backendAuthority: string): Buffer {
  const parts: Buffer[] = [parsed.requestLine, Buffer.from("\r\n", "latin1")];
  let hostWritten = false;
  for (const line of parsed.headerLines) {
    const name = line.toString("latin1").slice(0, line.indexOf(":")).trim().toLowerCase();
    if (name === "host") {
      if (!hostWritten) {
        parts.push(Buffer.from(`Host: ${backendAuthority}\r\n`, "latin1"));
        hostWritten = true;
      }
      // A duplicate Host would be ambiguous for the backend, so it is dropped.
      continue;
    }
    parts.push(line, Buffer.from("\r\n", "latin1"));
  }
  if (!hostWritten) parts.push(Buffer.from(`Host: ${backendAuthority}\r\n`, "latin1"));
  parts.push(Buffer.from("\r\n", "latin1"));
  return Buffer.concat(parts);
}

interface ParsedResponseHead {
  readonly statusCode: number;
  readonly compressionNegotiated: boolean;
}

/** Decode only the status code and whether a stateful stream was negotiated. */
function parseResponseHead(head: Buffer): ParsedResponseHead | null {
  const lines = head.toString("latin1").split("\r\n");
  const match = /^HTTP\/1\.[01][ \t]+([0-9]{3})(?:[ \t]|$)/.exec(lines[0] as string);
  if (match === null) return null;
  let compressionNegotiated = false;
  for (let index = 1; index < lines.length; index += 1) {
    const line = lines[index] as string;
    if (line.length === 0) continue;
    const colon = line.indexOf(":");
    if (colon <= 0) continue;
    const name = line.slice(0, colon).trim().toLowerCase();
    if (line.slice(colon + 1).trim().length === 0) continue;
    if (name === "sec-websocket-extensions" || /compress|deflate|zstd/i.test(name)) {
      compressionNegotiated = true;
    }
  }
  return { statusCode: Number(match[1]), compressionNegotiated };
}

/**
 * Refuse a handshake at the HTTP layer. Never a JSON-RPC byte. The status line
 * is flushed before the socket is destroyed, so the peer always sees a real
 * transport refusal instead of a truncated read.
 */
function refuseHttp(socket: net.Socket, statusCode: number): void {
  const reason = statusCode === 401
    ? "Unauthorized"
    : statusCode === 400
      ? "Bad Request"
      : "Service Unavailable";
  const destroy = (): void => {
    try {
      socket.destroy();
    } catch {
      // Contained.
    }
  };
  if (!socket.writable) {
    destroy();
    return;
  }
  const timer = setTimeout(destroy, 250);
  timer.unref?.();
  try {
    socket.write(`HTTP/1.1 ${statusCode} ${reason}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`, () => {
      clearTimeout(timer);
      destroy();
    });
  } catch {
    clearTimeout(timer);
    destroy();
  }
}

/* ------------------------------------------------------------ frame scanner */

interface ScannedFrame {
  readonly opcode: number;
  readonly fin: boolean;
  readonly masked: boolean;
  readonly maskKey: Buffer | null;
  readonly length: number;
}

/**
 * Read-only RFC6455 frame scanner for ONE direction. It never mutates, buffers
 * for retransmission, or re-encodes anything: it walks the bytes it is handed,
 * accounts for every frame, and hands the projector the payload of a complete
 * uncompressed data message.
 *
 * When the stream is compressed, structurally invalid, or a message exceeds the
 * metadata read budget, the scanner withdraws metadata (per message or for the
 * whole direction) and stops parsing. The caller keeps copying bytes either way.
 */
class WebSocketFrameScanner {
  readonly #expectMasked: boolean;
  readonly #budgetBytes: number;
  readonly #onMessage: (text: string) => void;
  readonly #onUnavailable: (
    scope: "connection" | "message",
    reason: NativeCodexTuiRelayMetadataUnavailableReason,
  ) => void;

  readonly #header = Buffer.alloc(14);
  #headerLength = 0;
  #frame: ScannedFrame | null = null;
  #frameRead = 0;
  #maskPosition = 0;
  #activeOpcode = 0;
  #messageChunks: Buffer[] = [];
  #messageBytes = 0;
  #messageDropped = false;
  #disabled = false;

  constructor(
    expectMasked: boolean,
    budgetBytes: number,
    onMessage: (text: string) => void,
    onUnavailable: (
      scope: "connection" | "message",
      reason: NativeCodexTuiRelayMetadataUnavailableReason,
    ) => void,
  ) {
    this.#expectMasked = expectMasked;
    this.#budgetBytes = budgetBytes;
    this.#onMessage = onMessage;
    this.#onUnavailable = onUnavailable;
  }

  /** Stop projecting; the caller keeps copying bytes unchanged. */
  disable(): void {
    this.#reset();
    this.#disabled = true;
  }

  observe(chunk: Buffer): void {
    if (this.#disabled) return;
    let position = 0;
    while (position < chunk.length) {
      let frame = this.#frame;
      if (frame === null) {
        this.#header[this.#headerLength] = chunk[position];
        this.#headerLength += 1;
        position += 1;
        if (this.#headerLength < 2) continue;
        const lengthFlag = this.#header[1] & 0x7f;
        const masked = (this.#header[1] & 0x80) !== 0;
        const extended = lengthFlag === 126 ? 2 : lengthFlag === 127 ? 8 : 0;
        const required = 2 + extended + (masked ? 4 : 0);
        if (this.#headerLength < required) continue;
        frame = this.#decodeFrame(extended, masked);
        if (this.#disabled) return;
        this.#frame = frame;
        if (frame === null) continue;
      }

      const take = Math.min(frame.length - this.#frameRead, chunk.length - position);
      if (take <= 0) continue;
      // Only data and continuation frames carry message bytes. RFC6455 permits
      // ping/pong/close between fragments, and a control-frame payload must
      // never join the reconstructed message.
      if (this.#activeOpcode !== 0 && frame.opcode <= 0x02 && !this.#messageDropped) {
        const copy = Buffer.from(chunk.subarray(position, position + take));
        const maskKey = frame.maskKey;
        if (frame.masked && maskKey !== null) {
          for (let index = 0; index < copy.length; index += 1) {
            copy[index] ^= maskKey[(this.#maskPosition + index) & 0x03];
          }
          this.#maskPosition = (this.#maskPosition + copy.length) & 0x03;
        }
        this.#messageChunks.push(copy);
        this.#messageBytes += copy.length;
        if (this.#messageBytes > this.#budgetBytes) {
          this.#messageDropped = true;
          this.#messageChunks = [];
          this.#messageBytes = 0;
          this.#onUnavailable("message", "message-oversize");
        }
      }
      this.#frameRead += take;
      position += take;
      if (this.#frameRead >= frame.length) {
        this.#frame = null;
        this.#headerLength = 0;
        this.#completeFrame(frame);
      }
    }
  }

  /** Decode one complete frame header; returns the frame to stream, or null. */
  #decodeFrame(extended: number, masked: boolean): ScannedFrame | null {
    const header = this.#header;
    const first = header[0];
    const opcode = first & 0x0f;
    const fin = (first & 0x80) !== 0;

    if ((first & 0x70) !== 0) {
      // A stateful compressed stream is copied untouched and never decoded here.
      this.#withdrawConnection("compressed-stream");
      return null;
    }
    if (masked !== this.#expectMasked) {
      this.#withdrawConnection("frame-protocol-invalid");
      return null;
    }
    if (!(opcode <= 0x02 || (opcode >= 0x08 && opcode <= 0x0b))) {
      this.#withdrawConnection("frame-protocol-invalid");
      return null;
    }

    let length: number;
    if (extended === 0) {
      length = header[1] & 0x7f;
    } else if (extended === 2) {
      length = ((header[2] << 8) | header[3]) >>> 0;
    } else {
      if (header[2] >= 0x80) {
        this.#withdrawConnection("frame-protocol-invalid");
        return null;
      }
      length = 0;
      for (let index = 2; index < 10; index += 1) length = length * 256 + header[index];
      if (!Number.isSafeInteger(length)) {
        this.#withdrawConnection("frame-protocol-invalid");
        return null;
      }
    }

    // Control frames are never fragmented, and a data frame must continue an
    // existing message or start a new one, never both.
    if (opcode >= 0x08 && (!fin || length > 125)) {
      this.#withdrawConnection("frame-protocol-invalid");
      return null;
    }
    if (opcode === 0x00 && this.#activeOpcode === 0) {
      this.#withdrawConnection("frame-protocol-invalid");
      return null;
    }
    if ((opcode === 0x01 || opcode === 0x02) && this.#activeOpcode !== 0) {
      this.#withdrawConnection("frame-protocol-invalid");
      return null;
    }

    const maskKey = masked ? Buffer.from(header.subarray(2 + extended, 2 + extended + 4)) : null;
    this.#headerLength = 0;
    this.#frameRead = 0;
    this.#maskPosition = 0;

    if (opcode === 0x01 || opcode === 0x02) {
      this.#activeOpcode = opcode;
      this.#messageChunks = [];
      this.#messageBytes = 0;
      this.#messageDropped = false;
      if (length > this.#budgetBytes) {
        this.#messageDropped = true;
        this.#onUnavailable("message", "message-oversize");
      }
    }

    const frame: ScannedFrame = { opcode, fin, masked, maskKey, length };
    if (length === 0) {
      // Nothing to stream: this frame is already complete.
      this.#completeFrame(frame);
      return null;
    }
    return frame;
  }

  #completeFrame(frame: ScannedFrame): void {
    if (frame.opcode > 0x02) return; // Control frames carry no projected metadata.
    if (!frame.fin) return;

    const chunks = this.#messageChunks;
    const dropped = this.#messageDropped;
    this.#messageChunks = [];
    this.#messageBytes = 0;
    this.#messageDropped = false;
    this.#activeOpcode = 0;
    if (dropped) return;
    this.#onMessage(Buffer.concat(chunks).toString("utf8"));
  }

  #reset(): void {
    this.#headerLength = 0;
    this.#frame = null;
    this.#frameRead = 0;
    this.#maskPosition = 0;
    this.#activeOpcode = 0;
    this.#messageChunks = [];
    this.#messageBytes = 0;
    this.#messageDropped = false;
  }

  #withdrawConnection(reason: NativeCodexTuiRelayMetadataUnavailableReason): void {
    this.#reset();
    this.#disabled = true;
    this.#onUnavailable("connection", reason);
  }
}

/* ------------------------------------------------------------- metadata tap */

interface PendingTuiRequest {
  readonly origin: PendingTuiRequestOrigin;
  readonly idText: string;
  readonly threadId: string | null;
  /** The generation's last emitted sequence when the request frame was observed. */
  readonly afterSequence: number;
}

/**
 * Turns one connection generation's decoded JSON-RPC messages into the closed
 * metadata union. It retains only bounded ids, method names, and flags, and it
 * is the only place in this module that reads a payload at all.
 */
class MetadataTap {
  readonly #emit: (event: Record<string, unknown>) => void;
  readonly #onOverflow: () => void;
  /** The generation's last emitted event sequence; read only, never advanced here. */
  readonly #currentSequence: () => number;
  readonly #pendingTuiRequests = new Map<string, PendingTuiRequest>();
  readonly #pendingInputRequests = new Map<string, NativeCodexTuiRelayInputRequestMethod>();
  #genuineInitializeObserved = false;

  constructor(emit: (event: Record<string, unknown>) => void, onOverflow: () => void, currentSequence: () => number) {
    this.#emit = emit;
    this.#onOverflow = onOverflow;
    this.#currentSequence = currentSequence;
  }

  observeClientToBackend(text: string): void {
    const message = parseJsonMessage(text);
    if (message === null) {
      // A decoded message this tap cannot read is a coverage loss. It is
      // reported with a fixed, payload-free reason; forwarding is unaffected.
      this.#emit({ kind: "metadata-unavailable", scope: "message", reason: "json-unreadable" });
      return;
    }
    const method = message.method;
    if (typeof method === "string") {
      if (!this.#genuineInitializeObserved) {
        // Until this connection identifies itself as the native TUI, nothing it
        // sends is metadata. Only the identifying frame is examined.
        if (method === "initialize") this.#handleInitialize(message);
        return;
      }
      if (message.id === undefined) return; // A TUI notification carries no projection.
      this.#handleTuiRequest(method, message);
      return;
    }
    if (!this.#genuineInitializeObserved) return;
    if (message.id !== undefined) this.#handleTuiReply(message);
  }

  observeBackendToClient(text: string): void {
    // Frames from a connection that never ran a genuine TUI `initialize` are
    // foreign: they are forwarded, but they are never metadata.
    if (!this.#genuineInitializeObserved) return;
    const message = parseJsonMessage(text);
    if (message === null) {
      this.#emit({ kind: "metadata-unavailable", scope: "message", reason: "json-unreadable" });
      return;
    }
    const method = message.method;
    if (typeof method === "string") {
      if (message.id === undefined) this.#handleServerNotification(method, message);
      else this.#handleServerRequest(method, message);
      return;
    }
    if (message.id === undefined) return;
    const key = idKeyOf(message.id);
    if (key === null) return;
    const pending = this.#pendingTuiRequests.get(key.key);
    if (pending === undefined) return;
    this.#pendingTuiRequests.delete(key.key);
    if (message.error !== undefined) return;

    if (pending.origin === "turn-start") {
      // The work target is the request's OWN threadId paired with the turn the
      // backend returned. It is not a root selection.
      if (pending.threadId === null) return;
      const turnId = readBoundedId(nestedValue(message.result, ["turn", "id"]));
      if (turnId === null) return;
      this.#emit({
        kind: "turn-work-target",
        requestIdKind: isHelperRequestId(pending.idText) ? "native-helper" : "native",
        threadId: pending.threadId,
        turnId,
        requestAfterSequence: pending.afterSequence,
      });
      return;
    }

    const threadId = readBoundedId(nestedValue(message.result, ["thread", "id"]));
    if (threadId === null) return;
    const event: Record<string, unknown> = {
      kind: "thread-candidate",
      origin: pending.origin,
      requestIdKind: isHelperRequestId(pending.idText) ? "native-helper" : "native",
      threadId,
    };
    // The requested thread is the request's own captured `params.threadId`,
    // correlated to THIS success only; an error response projected nothing
    // above. A thread/start carries no requested thread.
    if (pending.origin !== "thread-start" && pending.threadId !== null) event.requestedThreadId = pending.threadId;
    const parentThreadId = readBoundedId(nestedValue(message.result, ["parentThreadId"]))
      ?? readBoundedId(nestedValue(message.result, ["thread", "parentThreadId"]));
    if (parentThreadId !== null) event.parentThreadId = parentThreadId;
    const ephemeral = nestedValue(message.result, ["thread", "ephemeral"]);
    if (typeof ephemeral === "boolean") event.ephemeral = ephemeral;
    this.#emit(event);
  }

  #handleInitialize(message: Record<string, unknown>): void {
    // The genuine native TUI is identified by BOTH its client name and the
    // human-approval capability it asks for. A client that omits the capability
    // or sets it false stays unclassified: no gate, no session metadata.
    const params = isRecord(message.params) ? message.params : null;
    const clientInfo = params !== null && isRecord(params.clientInfo) ? params.clientInfo : null;
    const clientName = clientInfo !== null && typeof clientInfo.name === "string" ? clientInfo.name : null;
    if (clientName !== NATIVE_CODEX_TUI_RELAY_GENUINE_CLIENT_NAME) return;
    const capabilities = params !== null && isRecord(params.capabilities) ? params.capabilities : null;
    if (capabilities === null || capabilities.requiredHumanApproval !== true) return;
    this.#genuineInitializeObserved = true;
    this.#emit({
      kind: "genuine-tui-initialize",
      clientName,
      // Always true: the capability is part of what makes this initialize
      // genuine, and the event is only emitted when it was requested.
      humanApprovalRequired: true,
    });
  }

  #handleTuiRequest(method: string, message: Record<string, unknown>): void {
    if (method === "initialize") return;
    // Captured before this frame projects anything, so every event it emits,
    // and every later one, has a greater sequence.
    const afterSequence = this.#currentSequence();
    if (MODEL_INPUT_TUI_REQUEST_METHODS.has(method)) this.#handleModelInputRequest(message);
    if (method === "turn/interrupt") this.#handleInterruptRequest(message);
    const origin = PROJECTED_TUI_REQUEST_METHODS.get(method);
    if (origin === undefined) return;
    const key = idKeyOf(message.id);
    if (key === null) return;
    const params = isRecord(message.params) ? message.params : null;
    const threadId = params === null ? null : readBoundedId(params.threadId);
    if (this.#pendingTuiRequests.size >= NATIVE_CODEX_TUI_RELAY_MAX_PENDING_TUI_REQUESTS) {
      // Retire the oldest fact. It is never reported as having completed.
      const oldest = this.#pendingTuiRequests.keys().next();
      if (!oldest.done) this.#pendingTuiRequests.delete(oldest.value);
      this.#onOverflow();
    }
    this.#pendingTuiRequests.set(key.key, { origin, idText: key.text, threadId, afterSequence });
  }

  /**
   * Project an ordinary model-input submission at the moment the client frame
   * is observed. No correlation is registered: the backend's acknowledgement or
   * error never changes what the TUI already did to its local queue, and a
   * question arriving after this frame is a post-submission question.
   */
  #handleModelInputRequest(message: Record<string, unknown>): void {
    const key = idKeyOf(message.id);
    if (key === null) return;
    const params = isRecord(message.params) ? message.params : null;
    const input = classifyTuiModelInput(params === null ? undefined : params.input);
    if (input === "none" || input === "question-answer") return;
    const event: Record<string, unknown> = {
      kind: "ordinary-input",
      requestIdKind: isHelperRequestId(key.text) ? "native-helper" : "native",
    };
    const threadId = params === null ? null : readBoundedId(params.threadId);
    if (threadId !== null) event.threadId = threadId;
    this.#emit(event);
  }

  /**
   * Project a client stop request at the moment its frame is observed. No
   * correlation is registered and the acknowledgement adds nothing: the stop
   * was requested whether or not the backend later accepts it. An unbounded
   * request id is still a request; it is simply not labelled as a helper.
   */
  #handleInterruptRequest(message: Record<string, unknown>): void {
    const key = idKeyOf(message.id);
    const params = isRecord(message.params) ? message.params : null;
    const event: Record<string, unknown> = {
      kind: "turn-interrupt-request",
      requestIdKind: key !== null && isHelperRequestId(key.text) ? "native-helper" : "native",
    };
    const threadId = params === null ? null : readBoundedId(params.threadId);
    if (threadId !== null) event.threadId = threadId;
    const turnId = params === null ? null : readBoundedId(params.turnId);
    if (turnId !== null) event.turnId = turnId;
    this.#emit(event);
  }

  #handleTuiReply(message: Record<string, unknown>): void {
    // The TUI replying to a server request is the only reply this relay reports,
    // and only because it first observed that server request.
    const key = idKeyOf(message.id);
    if (key === null) return;
    const method = this.#pendingInputRequests.get(key.key);
    if (method === undefined) return;
    this.#pendingInputRequests.delete(key.key);
    this.#emit({
      kind: "input-response",
      requestId: key.text,
      method,
      hasError: message.error !== undefined,
    });
  }

  #handleServerRequest(method: string, message: Record<string, unknown>): void {
    // Only the allowlisted human-input/approval methods are operator input.
    // Everything else the backend may request is forwarded untouched and is
    // never projected or correlated.
    if (!PROJECTED_INPUT_REQUEST_METHODS.has(method)) return;
    const inputMethod = method as NativeCodexTuiRelayInputRequestMethod;
    const key = idKeyOf(message.id);
    if (key === null) return;
    const params = isRecord(message.params) ? message.params : null;
    const threadId = params === null ? null : readBoundedId(params.threadId);
    if (this.#pendingInputRequests.size >= NATIVE_CODEX_TUI_RELAY_MAX_PENDING_INPUT_REQUESTS) {
      const oldest = this.#pendingInputRequests.keys().next();
      if (!oldest.done) this.#pendingInputRequests.delete(oldest.value);
      this.#onOverflow();
    }
    this.#pendingInputRequests.set(key.key, inputMethod);
    const event: Record<string, unknown> = { kind: "input-request", requestId: key.text, method: inputMethod };
    if (threadId !== null) event.threadId = threadId;
    this.#emit(event);
  }

  #handleServerNotification(method: string, message: Record<string, unknown>): void {
    if (method === "turn/completed") {
      this.#handleTurnCompleted(message);
      return;
    }
    if (method === "turn/started") {
      this.#handleTurnStarted(message);
      return;
    }
    if (method !== "item/started" && method !== "item/completed") return;
    const params = isRecord(message.params) ? message.params : null;
    if (params === null) return;
    const item = isRecord(params.item) ? params.item : null;
    if (item === null) return;
    this.#handleItemPhase(method, params, item);
    // Async questions are registered by the native TUI from the COMPLETED item
    // only (a started item may already carry them but is not yet drawn), and
    // a reply is acknowledged only by the backend's committed user item.
    if (method === "item/completed") {
      if (item.type === "agentMessage") this.#handleAsyncQuestions(params, item);
      else if (item.type === "userMessage") this.#handleAsyncQuestionReply(params, item);
    }
  }

  #handleTurnCompleted(message: Record<string, unknown>): void {
    const params = isRecord(message.params) ? message.params : null;
    if (params === null) {
      this.#emitTurnLifecycleUnreadable("turn/completed", null);
      return;
    }
    const threadId = readBoundedId(params.threadId);
    const turn = isRecord(params.turn) ? params.turn : null;
    if (threadId === null || turn === null) {
      this.#emitTurnLifecycleUnreadable("turn/completed", threadId);
      return;
    }
    const turnId = readBoundedId(turn.id);
    const status = turn.status;
    if (turnId === null) {
      this.#emitTurnLifecycleUnreadable("turn/completed", threadId);
      return;
    }
    // `inProgress` and any unknown status are not terminal and retire nothing.
    // An unknown status is still a lifecycle gap: it might be a terminal.
    if (status !== "completed" && status !== "interrupted" && status !== "failed") {
      if (status !== "inProgress") this.#emitTurnLifecycleUnreadable("turn/completed", threadId);
      return;
    }
    this.#emit({ kind: "turn-terminal", threadId, turnId, status });
  }

  #handleTurnStarted(message: Record<string, unknown>): void {
    const params = isRecord(message.params) ? message.params : null;
    const threadId = params === null ? null : readBoundedId(params.threadId);
    const turnId = params === null ? null : readBoundedId(nestedValue(params.turn, ["id"]));
    if (threadId === null || turnId === null) {
      this.#emitTurnLifecycleUnreadable("turn/started", threadId);
      return;
    }
    this.#emit({ kind: "turn-started", threadId, turnId });
  }

  #emitTurnLifecycleUnreadable(method: "turn/started" | "turn/completed", threadId: string | null): void {
    this.#emit({ kind: "turn-lifecycle-unreadable", method, ...(threadId === null ? {} : { threadId }) });
  }

  #handleAsyncQuestions(params: Record<string, unknown>, item: Record<string, unknown>): void {
    const questions = item.questions;
    // An ordinary agent message carries no questions at all.
    if (questions === undefined || questions === null) return;
    const envelope: Record<string, unknown> = {};
    const threadId = readBoundedId(params.threadId);
    if (threadId !== null) envelope.threadId = threadId;
    const turnId = readBoundedId(params.turnId);
    if (turnId !== null) envelope.turnId = turnId;
    const count = readAsyncQuestionCount(questions);
    // The native question key embeds the item id verbatim, so only a bounded
    // string id can name a question.
    const itemId = typeof item.id === "string" ? readBoundedId(item.id) : null;
    if (item.delivery !== "async" || count === null || itemId === null) {
      // Question metadata this tap cannot read in full is a gap, never "none".
      // A readable item id scopes the gap to that one item.
      this.#emit({
        kind: "async-input-unreadable",
        source: "questions",
        ...(itemId === null ? {} : { itemId }),
        ...envelope,
      });
      return;
    }
    // A complete empty list is projected too: the native queue ignores it, but
    // it is authoritative evidence about that one item's question set.
    this.#emit({ kind: "async-questions", itemId, questionCount: count, ...envelope });
  }

  #handleAsyncQuestionReply(params: Record<string, unknown>, item: Record<string, unknown>): void {
    const envelope: Record<string, unknown> = {};
    const threadId = readBoundedId(params.threadId);
    if (threadId !== null) envelope.threadId = threadId;
    const turnId = readBoundedId(params.turnId);
    if (turnId !== null) envelope.turnId = turnId;
    const content = readSingleUserText(item.content);
    if (content.kind === "unreadable") {
      // An unreadable committed user item could have hidden a reply.
      this.#emit({ kind: "async-input-unreadable", source: "user-input", ...envelope });
      return;
    }
    if (content.kind === "not-reply") return;
    const answers = parseAsyncQuestionReplyIds(content.text);
    if (answers === null || answers.length === 0) return;
    this.#emit({ kind: "async-question-reply", answers: Object.freeze(answers), ...envelope });
  }

  #handleItemPhase(method: string, params: Record<string, unknown>, item: Record<string, unknown>): void {
    // The provider discriminates item payloads with the serde tag `type`; the
    // projection key stays the closed `itemKind`.
    const itemType = typeof item.type === "string" ? item.type : null;
    if (itemType === null || !PROJECTED_ITEM_TYPES.has(itemType)) return;
    const itemId = readBoundedId(item.id);
    if (itemId === null) return;
    const event: Record<string, unknown> = {
      kind: "item-phase",
      phase: method === "item/started" ? "started" : "completed",
      itemKind: itemType,
      itemId,
    };
    const threadId = readBoundedId(params.threadId);
    if (threadId !== null) event.threadId = threadId;
    const turnId = readBoundedId(params.turnId);
    if (turnId !== null) event.turnId = turnId;
    const category = PROJECTED_ITEM_TYPES.get(itemType);
    if (category !== undefined) event.toolCategory = category;
    this.#emit(event);
  }
}

/* ------------------------------------------------------------------ relay */

/** Start one private relay in front of one owned backend capability. */
export function startNativeCodexTuiRelay(input: NativeCodexTuiRelayInput): NativeCodexTuiRelayLease {
  return new NativeCodexTuiRelayLeaseImpl(input);
}

interface OwnedBackendTarget {
  readonly host: "127.0.0.1";
  readonly port: number;
  readonly authority: string;
}

/** The only dial target this relay will ever accept: the owned loopback cap. */
function resolveOwnedBackendTarget(backend: OwnedCodexBackendReady): OwnedBackendTarget | null {
  if (!isRecord(backend)) return null;
  if (typeof backend.readObserverBearer !== "function") return null;
  if (typeof backend.createTuiConnection !== "function") return null;
  const endpoint = backend.endpoint;
  if (typeof endpoint !== "string") return null;
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return null;
  }
  if (url.protocol !== "ws:") return null;
  // Numeric IPv4 loopback only: no DNS name, no `localhost`, no `::1`, no host.
  if (url.hostname !== "127.0.0.1") return null;
  if (url.username.length > 0 || url.password.length > 0) return null;
  if (url.search.length > 0 || url.hash.length > 0) return null;
  if (url.pathname !== "" && url.pathname !== "/") return null;
  const port = Number(url.port);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) return null;
  return { host: "127.0.0.1", port, authority: `127.0.0.1:${port}` };
}

/**
 * Derive the backend lease's reserved TUI auth environment NAME from its own
 * connection material. The value is never retained by this module.
 */
function deriveAuthEnvName(backend: OwnedCodexBackendReady): string | null {
  let material: OwnedCodexTuiConnection;
  try {
    material = backend.createTuiConnection();
  } catch {
    return null;
  }
  if (!isRecord(material) || !Array.isArray(material.args) || !isRecord(material.env)) return null;
  const index = material.args.indexOf("--remote-auth-token-env");
  if (index < 0) return null;
  const name = material.args[index + 1];
  if (typeof name !== "string" || name.length === 0 || name.length > 256) return null;
  if (/[\u0000-\u001F\u007F]/.test(name)) return null;
  const value = material.env[name];
  if (typeof value !== "string" || value.length === 0) return null;
  return name;
}

/** Internal plumbing handed to one connection; never part of the public lease. */
interface RelayConnectionHooks {
  readonly deliver: (event: NativeCodexTuiRelayMetadataEvent) => void;
  readonly countForwardedBytes: (direction: "to-backend" | "to-client", bytes: number) => void;
  readonly registerSocket: (socket: net.Socket) => void;
  readonly releaseSocket: (socket: net.Socket) => void;
  readonly clearActive: (connection: RelayConnection) => void;
  readonly tapEnabled: () => boolean;
}

class NativeCodexTuiRelayLeaseImpl implements NativeCodexTuiRelayLease {
  readonly #backend: OwnedCodexBackendReady;
  readonly #onMetadata: (event: NativeCodexTuiRelayMetadataEvent) => void;
  readonly #handshakeTimeoutMs: number;
  readonly #metadataMaxMessageBytes: number;
  readonly #readiness: Promise<NativeCodexTuiRelayReadiness>;
  readonly #settlement: Promise<NativeCodexTuiRelaySettlement>;
  readonly #listener: net.Server;
  readonly #sockets = new Set<net.Socket>();
  readonly #hooks: RelayConnectionHooks;

  #readinessResolve!: (value: NativeCodexTuiRelayReadiness) => void;
  #readinessReject!: (error: Error) => void;
  #settlementResolve!: (value: NativeCodexTuiRelaySettlement) => void;
  #readinessState: "pending" | "fulfilled" | "rejected" = "pending";
  #settlementState: "pending" | "settled" = "pending";

  #phase: "starting" | "listening" | "stopping" | "stopped" = "starting";
  #stopRequested = false;
  #listening = false;
  #listenerClosed = false;
  #active: RelayConnection | null = null;
  #connectionGenerations = 0;
  #refusedUnauthenticated = 0;
  #refusedBusy = 0;
  #refusedMalformed = 0;
  #metadataTapEnabled = true;
  #metadataCallbackErrors = 0;
  #forwardedToBackend = 0;
  #forwardedToClient = 0;

  constructor(input: NativeCodexTuiRelayInput) {
    if (typeof input?.onMetadata !== "function") {
      throw new NativeCodexTuiRelayError("backend-capability-invalid");
    }
    const target = resolveOwnedBackendTarget(input.backend);
    if (target === null) throw new NativeCodexTuiRelayError("backend-endpoint-invalid");

    this.#backend = input.backend;
    this.#onMetadata = input.onMetadata;
    const requestedTimeout = input.handshakeTimeoutMs ?? NATIVE_CODEX_TUI_RELAY_DEFAULT_HANDSHAKE_TIMEOUT_MS;
    this.#handshakeTimeoutMs = Number.isSafeInteger(requestedTimeout)
        && requestedTimeout >= NATIVE_CODEX_TUI_RELAY_MIN_HANDSHAKE_TIMEOUT_MS
      ? requestedTimeout
      : NATIVE_CODEX_TUI_RELAY_DEFAULT_HANDSHAKE_TIMEOUT_MS;
    const requestedBudget = input.metadataMaxMessageBytes ?? NATIVE_CODEX_TUI_RELAY_METADATA_MAX_MESSAGE_BYTES;
    this.#metadataMaxMessageBytes = Number.isSafeInteger(requestedBudget)
        && requestedBudget >= NATIVE_CODEX_TUI_RELAY_MIN_METADATA_MESSAGE_BYTES
      ? requestedBudget
      : NATIVE_CODEX_TUI_RELAY_METADATA_MAX_MESSAGE_BYTES;

    this.#readiness = new Promise<NativeCodexTuiRelayReadiness>((resolve, reject) => {
      this.#readinessResolve = resolve;
      this.#readinessReject = reject;
    });
    this.#settlement = new Promise<NativeCodexTuiRelaySettlement>((resolve) => {
      this.#settlementResolve = resolve;
    });

    this.#hooks = {
      deliver: (event) => this.#deliver(event),
      countForwardedBytes: (direction, bytes) => {
        if (direction === "to-backend") this.#forwardedToBackend += bytes;
        else this.#forwardedToClient += bytes;
      },
      registerSocket: (socket) => {
        this.#sockets.add(socket);
      },
      releaseSocket: (socket) => {
        if (!this.#sockets.delete(socket)) return;
        this.#maybeSettle();
      },
      clearActive: (connection) => {
        if (this.#active === connection) this.#active = null;
      },
      tapEnabled: () => this.#metadataTapEnabled,
    };

    this.#listener = net.createServer((socket) => this.#onClientSocket(socket, target));
    this.#listener.on("listening", () => this.#onListening());
    this.#listener.on("error", () => this.#onListenError());
    this.#listener.on("close", () => this.#markListenerClosed());

    // The lease is retained synchronously; the bind itself is asynchronous.
    this.#listener.listen(0, "127.0.0.1");
  }

  get readinessPromise(): Promise<NativeCodexTuiRelayReadiness> {
    return this.#readiness;
  }

  get settlementPromise(): Promise<NativeCodexTuiRelaySettlement> {
    return this.#settlement;
  }

  status(): NativeCodexTuiRelayStatus {
    return Object.freeze({
      phase: this.#phase,
      listening: this.#listening,
      stopRequested: this.#stopRequested,
      activeConnections: this.#active === null ? 0 : 1,
      connectionGenerations: this.#connectionGenerations,
      openSockets: this.#sockets.size,
      refusedUnauthenticated: this.#refusedUnauthenticated,
      refusedBusy: this.#refusedBusy,
      refusedMalformed: this.#refusedMalformed,
      metadataTapEnabled: this.#metadataTapEnabled,
      metadataCallbackErrors: this.#metadataCallbackErrors,
      forwardedBytesToBackend: this.#forwardedToBackend,
      forwardedBytesToClient: this.#forwardedToClient,
    });
  }

  requestStop(): void {
    if (this.#stopRequested) return;
    this.#stopRequested = true;
    if (this.#phase !== "stopped") this.#phase = "stopping";

    if (this.#readinessState === "pending") {
      this.#readinessState = "rejected";
      this.#readinessReject(new NativeCodexTuiRelayError("stopped"));
    }

    const active = this.#active;
    this.#active = null;
    try {
      active?.close("relay-stopped");
    } catch {
      // Contained: the socket's own `close` event still drives settlement.
    }
    for (const socket of [...this.#sockets]) {
      try {
        socket.destroy();
      } catch {
        // Contained: the socket's own `close` event still drives settlement.
      }
    }
    if (!this.#listenerClosed) {
      try {
        this.#listener.close(() => this.#markListenerClosed());
      } catch {
        this.#markListenerClosed();
      }
    }
    this.#maybeSettle();
  }

  detachMetadataTap(): void {
    if (!this.#metadataTapEnabled) return;
    this.#metadataTapEnabled = false;
    this.#active?.detachTap();
  }

  /* ------------------------------------------------------------ internals */

  #markListenerClosed(): void {
    if (this.#listenerClosed) return;
    this.#listenerClosed = true;
    this.#listening = false;
    this.#maybeSettle();
  }

  #onListenError(): void {
    if (this.#readinessState === "pending") {
      this.#readinessState = "rejected";
      this.#readinessReject(new NativeCodexTuiRelayError(this.#stopRequested ? "stopped" : "listen-failed"));
    }
    // A failed bind has no open listener: there is nothing to wait on.
    this.#markListenerClosed();
  }

  /** Settlement requires real closes AND a requested stop or a failed bind. */
  #maybeSettle(): void {
    if (this.#settlementState !== "pending") return;
    if (!this.#listenerClosed || this.#sockets.size !== 0) return;
    if (!this.#stopRequested && this.#readinessState !== "rejected") return;
    this.#settlementState = "settled";
    this.#phase = "stopped";
    this.#listening = false;
    this.#settlementResolve(Object.freeze({
      status: "settled" as const,
      listenerClosed: true as const,
      socketsClosed: true as const,
      connectionGenerations: this.#connectionGenerations,
    }));
  }

  #onListening(): void {
    if (this.#listening || this.#listenerClosed) return;
    this.#listening = true;
    if (this.#stopRequested || this.#readinessState !== "pending") return;
    this.#phase = "listening";

    const address = this.#listener.address();
    if (address === null || typeof address === "string" || address.address !== "127.0.0.1") {
      this.#readinessState = "rejected";
      this.#readinessReject(new NativeCodexTuiRelayError("listen-failed"));
      this.requestStop();
      return;
    }
    const authEnvName = deriveAuthEnvName(this.#backend);
    if (authEnvName === null) {
      this.#readinessState = "rejected";
      this.#readinessReject(new NativeCodexTuiRelayError("backend-capability-invalid"));
      this.requestStop();
      return;
    }

    const port = address.port;
    const endpoint = `ws://127.0.0.1:${port}`;
    const backend = this.#backend;
    this.#readinessState = "fulfilled";
    this.#readinessResolve(Object.freeze({
      endpoint,
      port,
      createTuiConnection: (): OwnedCodexTuiConnection => {
        const material = backend.createTuiConnection();
        if (!isRecord(material) || !Array.isArray(material.args) || !isRecord(material.env)) {
          throw new NativeCodexTuiRelayError("backend-capability-invalid");
        }
        if (material.args.indexOf("--remote-auth-token-env") < 0 || material.env[authEnvName] === undefined) {
          throw new NativeCodexTuiRelayError("backend-capability-invalid");
        }
        // The TUI is only ever given the RELAY address; the backend authority
        // stays inside this relay.
        return Object.freeze({
          endpoint,
          args: Object.freeze(["--remote", endpoint, "--remote-auth-token-env", authEnvName]),
          env: material.env,
        });
      },
    }));
  }

  #onClientSocket(socket: net.Socket, target: OwnedBackendTarget): void {
    if (this.#stopRequested) {
      try {
        socket.destroy();
      } catch {
        // Nothing else to do.
      }
      return;
    }
    this.#sockets.add(socket);
    socket.setNoDelay(true);
    socket.on("close", () => {
      if (!this.#sockets.delete(socket)) return;
      this.#maybeSettle();
    });
    socket.on("error", () => {
      // A refused or failed handshake socket is a transport fact, not metadata.
    });

    // Bounded handshake buffering, then the socket is handed to a generation.
    // Only bytes up to the header terminator count against the header bound: a
    // genuine handshake can arrive coalesced with the TUI's first frames.
    let buffered: Buffer = Buffer.alloc(0);
    let settled = false;
    const onData = (chunk: Buffer): void => {
      if (settled) return;
      buffered = buffered.length === 0 ? chunk : Buffer.concat([buffered, chunk]);
      const end = findHeaderEnd(buffered);
      if (end < 0) {
        // No terminator yet, so everything held so far is header bytes.
        if (buffered.length > NATIVE_CODEX_TUI_RELAY_MAX_REQUEST_HEADER_BYTES) {
          settled = true;
          socket.removeListener("data", onData);
          this.#refusedMalformed += 1;
          refuseHttp(socket, 400);
        }
        return;
      }

      settled = true;
      socket.removeListener("data", onData);
      if (end > NATIVE_CODEX_TUI_RELAY_MAX_REQUEST_HEADER_BYTES) {
        this.#refusedMalformed += 1;
        refuseHttp(socket, 400);
        return;
      }
      const headBytes = buffered.subarray(0, end);
      const preface = Buffer.from(buffered.subarray(end + 4));
      buffered = Buffer.alloc(0);
      const parsed = parseUpgradeHead(headBytes);
      if (parsed === null || !parsed.websocketUpgrade || !parsed.hasWebSocketKey || parsed.hostCount > 1) {
        this.#refusedMalformed += 1;
        refuseHttp(socket, 400);
        return;
      }

      let expectedBearer: string;
      try {
        expectedBearer = this.#backend.readObserverBearer();
        if (typeof expectedBearer !== "string" || expectedBearer.length === 0) {
          throw new NativeCodexTuiRelayError("backend-capability-invalid");
        }
      } catch {
        // The owned capability is unusable; refusing is the only safe answer.
        this.#refusedMalformed += 1;
        refuseHttp(socket, 503);
        return;
      }
      if (parsed.authorizationToken === null || !bearerMatches(parsed.authorizationToken, expectedBearer)) {
        this.#refusedUnauthenticated += 1;
        refuseHttp(socket, 401);
        return;
      }

      const connection = this.#acceptGeneration(socket, parsed, preface, target);
      if (connection === null) {
        // Transport-level refusal of a second concurrent TUI connection. No
        // JSON-RPC byte is produced, and the live generation is untouched.
        refuseHttp(socket, 503);
        return;
      }
      connection.start();
    };
    socket.on("data", onData);
  }

  /** Accept one authenticated handshake as a new connection generation. */
  #acceptGeneration(
    client: net.Socket,
    parsed: ParsedUpgradeHead,
    preface: Buffer,
    target: OwnedBackendTarget,
  ): RelayConnection | null {
    if (this.#active !== null || this.#stopRequested) {
      this.#refusedBusy += 1;
      return null;
    }
    this.#connectionGenerations += 1;
    const connection = new RelayConnection({
      hooks: this.#hooks,
      client,
      preface,
      head: rebuildHeadForBackend(parsed, target.authority),
      target,
      handshakeTimeoutMs: this.#handshakeTimeoutMs,
      metadataMaxMessageBytes: this.#metadataMaxMessageBytes,
      connectionId: randomBytes(12).toString("base64url"),
    });
    this.#active = connection;
    return connection;
  }

  /** Deliver one closed metadata event; a consumer throw is contained. */
  #deliver(event: NativeCodexTuiRelayMetadataEvent): void {
    if (!this.#metadataTapEnabled) return;
    try {
      this.#onMetadata(event);
    } catch {
      this.#metadataCallbackErrors += 1;
    }
  }
}

/** One accepted TUI connection and the owned backend connection it fronts. */
class RelayConnection {
  readonly #hooks: RelayConnectionHooks;
  readonly #client: net.Socket;
  readonly #target: OwnedBackendTarget;
  readonly #connectionId: string;
  readonly #metadataMaxMessageBytes: number;
  readonly #handshakeTimeoutMs: number;

  #head: Buffer;
  #preface: Buffer;
  #backendSocket: net.Socket | null = null;
  #backendHead: Buffer = Buffer.alloc(0);
  #pendingClientChunks: Buffer[] = [];
  #pendingClientBytes = 0;
  /**
   * Client bytes copied to the backend before the tap existed, kept for tapping.
   * Retention is bounded by the metadata read budget: once a whole chunk cannot
   * be retained, the retained bytes may end inside a frame, so no later replay
   * can be trusted and metadata is withdrawn for the whole generation.
   */
  #preTapClientBytes: Buffer[] = [];
  #preTapClientBytesLength = 0;
  #preTapClientOverflow = false;
  #timer: NodeJS.Timeout | undefined;
  #phase: "dialing" | "awaiting-response" | "forwarding" | "closed" = "dialing";
  #closed = false;
  #tapEnabled: boolean;
  #sequence = 0;
  #tap: MetadataTap | null = null;
  #clientScanner: WebSocketFrameScanner | null = null;
  #backendScanner: WebSocketFrameScanner | null = null;
  #metadataRetired = false;

  constructor(options: {
    readonly hooks: RelayConnectionHooks;
    readonly client: net.Socket;
    readonly preface: Buffer;
    readonly head: Buffer;
    readonly target: OwnedBackendTarget;
    readonly handshakeTimeoutMs: number;
    readonly metadataMaxMessageBytes: number;
    readonly connectionId: string;
  }) {
    this.#hooks = options.hooks;
    this.#client = options.client;
    this.#preface = options.preface;
    this.#head = options.head;
    this.#target = options.target;
    this.#handshakeTimeoutMs = options.handshakeTimeoutMs;
    this.#metadataMaxMessageBytes = options.metadataMaxMessageBytes;
    this.#connectionId = options.connectionId;
    this.#tapEnabled = options.hooks.tapEnabled();
  }

  start(): void {
    this.#client.setNoDelay(true);
    this.#client.on("data", (chunk: Buffer) => this.#onClientData(chunk));
    this.#client.on("end", () => {
      const backendSocket = this.#backendSocket;
      if (backendSocket !== null && backendSocket.writable) backendSocket.end();
    });
    this.#client.on("error", () => this.#fail("client-closed"));
    this.#client.on("close", () => this.#onSocketClose(
      this.#client,
      this.#backendSocket,
      "client-closed",
    ));

    let backendSocket: net.Socket;
    try {
      // The exact owned backend endpoint, and nothing else. No port scan.
      backendSocket = net.connect({ host: this.#target.host, port: this.#target.port });
    } catch {
      this.#fail("backend-closed");
      return;
    }
    this.#backendSocket = backendSocket;
    this.#hooks.registerSocket(backendSocket);
    backendSocket.setNoDelay(true);
    backendSocket.on("connect", () => this.#onBackendConnect());
    backendSocket.on("data", (chunk: Buffer) => this.#onBackendData(chunk));
    backendSocket.on("end", () => {
      if (this.#client.writable) this.#client.end();
    });
    backendSocket.on("error", () => this.#fail("backend-closed"));
    backendSocket.on("close", () => {
      this.#hooks.releaseSocket(backendSocket);
      this.#onSocketClose(backendSocket, this.#client, "backend-closed");
    });

    this.#timer = setTimeout(() => this.#fail("handshake-timeout"), this.#handshakeTimeoutMs);
    this.#timer.unref?.();
  }

  /**
   * A source socket's `close` does not prove that the opposite socket flushed
   * what it queued. After an orderly EOF, the final forwarded bytes can still
   * be sitting in the destination's writable queue, so destroying it there
   * would drop them: this drains the destination first and only then closes the
   * generation. Errors, aborted handshakes, and an explicit stop keep destroying
   * immediately.
   */
  #onSocketClose(
    source: net.Socket,
    destination: net.Socket | null,
    reason: NativeCodexTuiRelayGenerationCloseReason,
  ): void {
    if (this.#closed) return;
    if (
      this.#phase !== "forwarding"
      || !source.readableEnded
      || destination === null
      || destination.destroyed
      || destination.writableFinished
    ) {
      this.#fail(reason);
      return;
    }
    const finish = (): void => {
      destination.removeListener("finish", finish);
      destination.removeListener("close", finish);
      this.#fail(reason);
    };
    destination.once("finish", finish);
    destination.once("close", finish);
    // The orderly-EOF handler already half-closed the destination when it could;
    // never call `end()` twice, just wait for the queue to drain.
    if (!destination.writableEnded) destination.end();
  }

  /** Close this generation. Real `close` events still drive settlement. */
  close(reason: NativeCodexTuiRelayGenerationCloseReason): void {
    this.#fail(reason);
  }

  detachTap(): void {
    if (!this.#tapEnabled) return;
    this.#tapEnabled = false;
    this.#clientScanner?.disable();
    this.#backendScanner?.disable();
    this.#tap = null;
  }

  /* ------------------------------------------------------------ internals */

  #onBackendConnect(): void {
    if (this.#closed) return;
    this.#phase = "awaiting-response";
    const backendSocket = this.#backendSocket;
    if (backendSocket === null) return;
    backendSocket.write(this.#head);
    this.#head = Buffer.alloc(0);
    const queued = this.#pendingClientChunks;
    this.#pendingClientChunks = [];
    this.#pendingClientBytes = 0;
    if (this.#preface.length > 0) {
      this.#hooks.countForwardedBytes("to-backend", this.#preface.length);
      this.#retainForTap(this.#preface);
      this.#write(backendSocket, this.#preface, this.#client);
      this.#preface = Buffer.alloc(0);
    }
    // Bytes the TUI sent while dialing are re-issued in their original order.
    for (const chunk of queued) {
      this.#hooks.countForwardedBytes("to-backend", chunk.length);
      this.#retainForTap(chunk);
      this.#write(backendSocket, chunk, this.#client);
    }
  }

  /**
   * Client bytes copied to the backend before the backend's 101 (the handshake
   * preface and anything sent while dialing) are still part of the tapped
   * stream. Copies are retained under the metadata read budget and fed to the
   * scanner the moment it exists. If any whole chunk had to be omitted, the
   * retained bytes can end mid-frame, so metadata is withdrawn for the whole
   * connection instead of resuming on a possibly desynchronized stream.
   * Forwarding never waits for this.
   */
  #retainForTap(chunk: Buffer): void {
    if (!this.#tapEnabled || chunk.length === 0 || this.#preTapClientOverflow) return;
    if (this.#preTapClientBytesLength + chunk.length > this.#metadataMaxMessageBytes) {
      this.#preTapClientOverflow = true;
      return;
    }
    this.#preTapClientBytes.push(Buffer.from(chunk));
    this.#preTapClientBytesLength += chunk.length;
  }

  #onClientData(chunk: Buffer): void {
    if (this.#closed) return;
    if (this.#phase === "forwarding") {
      const backendSocket = this.#backendSocket;
      if (backendSocket === null) return;
      this.#clientScanner?.observe(chunk);
      this.#hooks.countForwardedBytes("to-backend", chunk.length);
      this.#write(backendSocket, chunk, this.#client);
      return;
    }
    if (this.#phase === "awaiting-response") {
      // Connected, but the tap does not start until the backend's 101 was seen:
      // these bytes are copied now and tapped as soon as the tap exists.
      const backendSocket = this.#backendSocket;
      if (backendSocket === null) return;
      this.#retainForTap(chunk);
      this.#hooks.countForwardedBytes("to-backend", chunk.length);
      this.#write(backendSocket, chunk, this.#client);
      return;
    }
    // The backend dial is still pending: queue under a bounded window so the
    // genuine byte order is preserved without unbounded buffering. The same
    // copies are retained for the tap when the handshake completes.
    this.#pendingClientBytes += chunk.length;
    if (this.#pendingClientBytes > NATIVE_CODEX_TUI_RELAY_MAX_PREFLIGHT_BYTES) {
      this.#fail("preflight-overflow");
      return;
    }
    this.#pendingClientChunks.push(Buffer.from(chunk));
  }

  #onBackendData(chunk: Buffer): void {
    if (this.#closed) return;
    if (this.#phase === "forwarding") {
      this.#backendScanner?.observe(chunk);
      const backendSocket = this.#backendSocket;
      if (backendSocket === null) return;
      this.#hooks.countForwardedBytes("to-client", chunk.length);
      this.#write(this.#client, chunk, backendSocket);
      return;
    }
    if (this.#phase !== "awaiting-response") return;

    this.#backendHead = Buffer.concat([this.#backendHead, chunk]);
    const end = findHeaderEnd(this.#backendHead);
    if (end < 0) {
      // No terminator yet: everything held so far is header bytes, and only
      // those count against the header bound. Trailing frame bytes that share
      // this read are not a violation.
      if (this.#backendHead.length > NATIVE_CODEX_TUI_RELAY_MAX_RESPONSE_HEADER_BYTES) {
        this.#fail("backend-handshake-rejected");
      }
      return;
    }
    if (end > NATIVE_CODEX_TUI_RELAY_MAX_RESPONSE_HEADER_BYTES) {
      this.#fail("backend-handshake-rejected");
      return;
    }
    const headBytes = this.#backendHead.subarray(0, end + 4);
    const rest = this.#backendHead.subarray(end + 4);
    this.#backendHead = Buffer.alloc(0);

    const parsed = parseResponseHead(headBytes);
    if (parsed === null || parsed.statusCode !== 101) {
      // The backend's own refusal is copied to the TUI exactly, flushed, and
      // only then is the generation closed. The armed handshake timeout stays
      // as a backstop if the flush callback never lands.
      try {
        this.#client.write(headBytes, () => this.#fail("backend-handshake-rejected"));
      } catch {
        this.#fail("backend-handshake-rejected");
      }
      return;
    }

    // A successful upgrade reaches the TUI exactly as the backend produced it.
    if (this.#client.writable) this.#client.write(headBytes);

    this.#clearTimer();
    this.#phase = "forwarding";
    if (this.#tapEnabled) {
      this.#tap = new MetadataTap(
        (event) => this.#emit(event),
        () => this.#emit({ kind: "metadata-unavailable", scope: "connection", reason: "correlation-overflow" }),
        () => this.#sequence,
      );
      this.#clientScanner = new WebSocketFrameScanner(
        true,
        this.#metadataMaxMessageBytes,
        (text) => this.#tap?.observeClientToBackend(text),
        (scope, reason) => this.#routeUnavailable(scope, reason),
      );
      this.#backendScanner = new WebSocketFrameScanner(
        false,
        this.#metadataMaxMessageBytes,
        (text) => this.#tap?.observeBackendToClient(text),
        (scope, reason) => this.#routeUnavailable(scope, reason),
      );
      if (parsed.compressionNegotiated) this.#withdrawConnectionMetadata("compressed-stream");
      // Omitted pre-tap bytes can split a frame, so the retained bytes and all
      // later traffic are no longer a valid stream to project from.
      if (this.#preTapClientOverflow) this.#withdrawConnectionMetadata("message-oversize");
      // Client bytes that were forwarded before the 101 are tapped now, in
      // stream order ahead of any later client data.
      for (const chunk of this.#preTapClientBytes) {
        this.#clientScanner?.observe(chunk);
      }
    }
    this.#preTapClientBytes = [];
    this.#preTapClientBytesLength = 0;
    this.#preTapClientOverflow = false;
    if (rest.length > 0) this.#onBackendData(rest);
  }

  /** Message-scope notices keep the tap alive; connection-scope retires it. */
  #routeUnavailable(scope: "connection" | "message", reason: NativeCodexTuiRelayMetadataUnavailableReason): void {
    if (scope === "connection") {
      this.#withdrawConnectionMetadata(reason);
      return;
    }
    this.#emit({ kind: "metadata-unavailable", scope: "message", reason });
  }

  /**
   * Retire metadata for the whole connection generation: an undecodable stream
   * or a frame the scanner could not follow means later messages can no longer
   * be correlated, so the tap stops projecting and its pending correlation state
   * is dropped. Only the closed reason crosses the boundary, and forwarding is
   * never affected.
   */
  #withdrawConnectionMetadata(reason: NativeCodexTuiRelayMetadataUnavailableReason): void {
    if (this.#metadataRetired || !this.#tapEnabled) return;
    this.#metadataRetired = true;
    this.#tap = null;
    this.#clientScanner?.disable();
    this.#backendScanner?.disable();
    this.#emit({ kind: "metadata-unavailable", scope: "connection", reason });
  }

  #write(destination: net.Socket, chunk: Buffer, source: net.Socket): void {
    if (destination.destroyed || !destination.writable) return;
    if (destination.write(chunk)) return;
    source.pause();
    destination.once("drain", () => {
      if (!this.#closed && !source.destroyed) source.resume();
    });
  }

  #emit(event: Record<string, unknown>): void {
    if (!this.#tapEnabled) return;
    this.#sequence += 1;
    // Frozen: a consumer cannot mutate a delivered projection.
    this.#hooks.deliver(Object.freeze({
      ...event,
      connectionId: this.#connectionId,
      sequence: this.#sequence,
    }) as NativeCodexTuiRelayMetadataEvent);
  }

  #clearTimer(): void {
    if (this.#timer === undefined) return;
    clearTimeout(this.#timer);
    this.#timer = undefined;
  }

  #fail(reason: NativeCodexTuiRelayGenerationCloseReason): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#phase = "closed";
    this.#clearTimer();
    this.#hooks.clearActive(this);
    if (this.#tapEnabled) this.#emit({ kind: "generation-closed", reason });
    this.#tap = null;
    this.#clientScanner = null;
    this.#backendScanner = null;
    this.#pendingClientChunks = [];
    this.#pendingClientBytes = 0;
    this.#preTapClientBytes = [];
    this.#preTapClientBytesLength = 0;
    this.#head = Buffer.alloc(0);
    this.#preface = Buffer.alloc(0);

    const backendSocket = this.#backendSocket;
    this.#backendSocket = null;
    try {
      this.#client.destroy();
    } catch {
      // Contained.
    }
    if (backendSocket !== null) {
      try {
        backendSocket.destroy();
      } catch {
        // Contained.
      }
    }
  }
}
