/**
 * Codex idle-wake primitive (#682): put one wake message on one exact, already
 * owned Codex thread through the EXPERIMENTAL user-message queue, then start
 * exactly that queued row with Codex's own atomic idle check.
 *
 * This is a protocol-level step only. It does not open a connection, decide
 * when to wake, enable anything, steer a busy turn, or choose a retry or
 * redelivery policy. A later composition owns all of that.
 *
 * ## Experimental dependency (verified against Codex 0.171.0)
 *
 * 0.171.0 is the tested baseline. The owned callback admits newer stable Codex
 * releases at or above it (`CODEX_CALLBACK_MIN_CLI_VERSION`) without testing
 * them, on the assumption that they keep the same contract. The closed
 * response parsing below catches only wire-shape changes, not a release that
 * keeps the shape but changes its meaning.
 *
 * `thread/queue/add`, `thread/queue/start`, and `thread/queue/delete` are
 * `#[experimental]` app-server methods. The connection behind the injected
 * caller must have been initialized with `capabilities.experimentalApi: true`.
 * Facts below come from the public `rust-v0.171.0` tag of openai/codex:
 * `codex-rs/app-server-protocol/src/protocol/{common.rs,v2/thread.rs}`,
 * `codex-rs/app-server/src/request_processors/thread_queue_processor.rs`,
 * `codex-rs/ext/queue/src/service.rs`, `codex-rs/core/src/tasks/lifecycle.rs`,
 * `codex-rs/app-server/tests/suite/v2/thread_queue.rs`, and the TUI's own
 * unsupported-queue check in `codex-rs/tui/src/session_queue_commands.rs`.
 * A later Codex can change any of them. When it does, this module fails closed
 * to `uncertain` or `unsupported`. It never treats an unknown shape as success.
 *
 * - `thread/queue/add {threadId, input, clientUserMessageId}` returns
 *   `{queuedSubmission: {id, input, clientUserMessageId, ...}}`. Before it
 *   responds, Codex calls its idle hook, and that hook runs in line. On a
 *   loaded, idle thread that was NOT interrupted, Codex starts the HEAD queued
 *   row itself. The head may be our row or an older one. After a user
 *   interruption the hook skips auto-dispatch, so `thread/queue/start` is what
 *   starts the row. This module does not decide whether waking after a user
 *   interruption is wanted. The caller must make that choice before invoking.
 * - `thread/queue/start {threadId, queuedSubmissionId}` holds the per-thread
 *   dispatch lock and calls `start_turn_if_idle`. If a turn started, Codex
 *   deletes the row and returns `{turn: {id, status: "inProgress", ...}}`. If
 *   the thread is busy, it returns `-32600` with the message "thread already
 *   has an active or pending turn" and keeps the row. If the row is not there,
 *   it returns `-32600` with the message "queued submission not found: <id>".
 *   A failure to delete the row AFTER the turn started also comes back as an
 *   error, so an error never proves that no turn started.
 * - `thread/queue/delete {threadId, queuedSubmissionId}` returns
 *   `{deleted: boolean}`.
 * - Unsupported `thread/queue/add` (the same check the Codex TUI uses):
 *   `-32601`, or `-32600` with the message
 *   "thread/queue/add requires experimentalApi capability" or one starting
 *   with "Invalid request: unknown variant `thread/queue/add`". All of these
 *   are rejected before dispatch, so no row was created.
 *
 * ## What the CALLER must already have proved (this module proves none of it)
 *
 * - `threadId` is the current thread this host owns, on a connection this host
 *   owns. It is used exactly as given and never retargeted or rediscovered.
 * - `clientUserMessageId` is the caller's callback id for this one wake. It is
 *   not a reserved or minted id, and this module neither reuses nor alters it.
 * - Positive idle evidence existed at invocation. That evidence is only the
 *   reason to try. Safety does not rest on it, because `thread/queue/start`
 *   repeats the idle check atomically.
 * - The injected caller writes only the requests passed to it and answers no
 *   server request (approvals, questions, elicitation). This module sends no
 *   approval response and no reply to any provider-originated id.
 *
 * ## Outcome semantics (truthful, closed)
 *
 * - `started`: Codex answered our exact `thread/queue/start` saying it started
 *   a turn from our exact row. That is the provider's report that the turn
 *   began. It is not model acknowledgement, a read receipt, or completion.
 * - `busy-removed`: Codex refused the start as busy, and our exact row was then
 *   deleted (`deleted: true`). Our wake text did not start a turn from the
 *   queue. A composition may then use its own expected-turn steer. This module
 *   never steers and never calls `turn/start`.
 * - `unsupported`: add was rejected before dispatch (see above). Nothing was
 *   queued.
 * - `rejected-input`: local validation failed and nothing was sent.
 * - `uncertain`: everything else. That includes timeout, close, write failure,
 *   a thrown or invalid caller reply, any other error response, a malformed or
 *   mismatched result, our row being absent at start (`row-absent`), and
 *   `deleted: false` (`not-deleted`). In each case the wake may already have
 *   started, may still be queued (and Codex may dispatch it later on its own),
 *   or may have been removed by another client. An absent row can mean Codex
 *   auto-dispatched it or someone removed it. It never proves placement.
 *   An RPC receipt is not placement either.
 *
 * Each step runs at most once per invocation: one add, at most one start of
 * the exact returned row id, and at most one delete of that same id, only
 * after an explicit busy refusal. There is no retry, no `start` without an id
 * (which would start the queue head), no list, reorder, update, or queue
 * clear, and no recovery attempt after an uncertain step. A reply that arrives
 * after its deadline is treated as `timeout`, even if the timer callback has not
 * run yet. A late reply therefore cannot upgrade an `uncertain` result or lead
 * to a follow-up mutation.
 *
 * Privacy: outcomes carry only the caller's own ids, the provider's opaque row
 * and turn ids, and closed codes. Provider error messages are compared in
 * place and never returned.
 */

/** Disclosure of the experimental provider contract this primitive targets. */
export const NATIVE_CODEX_IDLE_WAKE_CONTRACT = Object.freeze({
  codexVersion: "0.171.0",
  requiredCapability: "experimentalApi",
  methods: Object.freeze(["thread/queue/add", "thread/queue/start", "thread/queue/delete"] as const),
});

export type NativeCodexIdleWakeQueueMethod = (typeof NATIVE_CODEX_IDLE_WAKE_CONTRACT.methods)[number];

/** Transport failures the injected caller reports without an explicit JSON-RPC reply. */
export type NativeCodexIdleWakeTransportFailure = "timeout" | "closed" | "write";

/**
 * One reply from the injected trusted caller. `error` is an explicit JSON-RPC
 * error response. `failed` means no response was received.
 */
export type NativeCodexIdleWakeReply =
  | { readonly kind: "result"; readonly result: unknown }
  | { readonly kind: "error"; readonly code: number; readonly message: string }
  | { readonly kind: "failed"; readonly failure: NativeCodexIdleWakeTransportFailure };

/**
 * Narrow request seam onto an already initialized, host-owned app-server
 * connection that negotiated `experimentalApi`. The caller should honor
 * `timeoutMs`. This module also enforces it independently.
 */
export interface NativeCodexIdleWakeCaller {
  request(
    method: NativeCodexIdleWakeQueueMethod,
    params: Readonly<Record<string, unknown>>,
    timeoutMs: number,
  ): Promise<NativeCodexIdleWakeReply>;
}

/**
 * Injectable monotonic clock and timer pair, so deadlines are deterministic in
 * tests. `now()` is checked when a reply arrives. A reply that arrives at or
 * after its deadline counts as a timeout even if the timer callback has not
 * run yet, for example when the event loop is delayed.
 */
export interface NativeCodexIdleWakeTimers {
  /** Monotonic milliseconds. */
  now(): number;
  set(callback: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

export interface NativeCodexIdleWakeRequest {
  /** Caller-validated id of the current thread this host owns. */
  readonly threadId: string;
  /** Caller's callback id for this one wake. */
  readonly clientUserMessageId: string;
  /** Wake text delivered as a single text input item. */
  readonly text: string;
}

export interface NativeCodexIdleWakeOptions {
  readonly caller: NativeCodexIdleWakeCaller;
  /** Per-request deadline. Defaults to {@link NATIVE_CODEX_IDLE_WAKE_DEFAULT_TIMEOUT_MS}. */
  readonly callTimeoutMs?: number;
  readonly timers?: NativeCodexIdleWakeTimers;
}

export const NATIVE_CODEX_IDLE_WAKE_DEFAULT_TIMEOUT_MS = 10_000;
export const NATIVE_CODEX_IDLE_WAKE_MAX_TIMEOUT_MS = 60_000;
const MAX_ID_LENGTH = 256;

export type NativeCodexIdleWakeStage = "add" | "start" | "delete";

export type NativeCodexIdleWakeUncertainReason =
  | NativeCodexIdleWakeTransportFailure
  /** The caller threw, rejected, or returned something that is not a reply. */
  | "transport-error"
  /** An explicit error response this module does not classify more narrowly. */
  | "error-response"
  /** A result whose shape does not match the pinned contract. */
  | "malformed-response"
  /** Add returned a row whose `clientUserMessageId` is not ours. */
  | "identity-mismatch"
  /** Start reported our exact row is not queued (auto-dispatched or removed). */
  | "row-absent"
  /** Delete after a busy refusal returned `deleted: false`. */
  | "not-deleted";

export type NativeCodexIdleWakeOutcome =
  | { readonly kind: "rejected-input" }
  | { readonly kind: "unsupported"; readonly stage: "add" }
  | { readonly kind: "started"; readonly queuedSubmissionId: string; readonly turnId: string }
  | { readonly kind: "busy-removed"; readonly queuedSubmissionId: string }
  | {
      readonly kind: "uncertain";
      readonly stage: NativeCodexIdleWakeStage;
      readonly reason: NativeCodexIdleWakeUncertainReason;
      /** Our row id once add returned it for our callback id; otherwise null. */
      readonly queuedSubmissionId: string | null;
    };

const JSONRPC_INVALID_REQUEST = -32600;
const JSONRPC_METHOD_NOT_FOUND = -32601;
const BUSY_MESSAGE = "thread already has an active or pending turn";
const ADD_EXPERIMENTAL_REQUIRED_MESSAGE = "thread/queue/add requires experimentalApi capability";
const ADD_UNKNOWN_VARIANT_PREFIX = "Invalid request: unknown variant `thread/queue/add`";

const DEFAULT_TIMERS: NativeCodexIdleWakeTimers = {
  now: () => performance.now(),
  set: (callback, ms) => setTimeout(callback, ms),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

type BoundedReply = NativeCodexIdleWakeReply | { readonly kind: "transport-error" };

/**
 * Queue one wake on the exact owned thread and atomically start exactly that
 * row. See the module documentation for the caller's obligations and what each
 * outcome does and does not prove.
 */
export async function wakeIdleNativeCodexThread(
  request: NativeCodexIdleWakeRequest,
  options: NativeCodexIdleWakeOptions,
): Promise<NativeCodexIdleWakeOutcome> {
  const timeoutMs = options.callTimeoutMs ?? NATIVE_CODEX_IDLE_WAKE_DEFAULT_TIMEOUT_MS;
  if (
    !isValidId(request?.threadId) ||
    !isValidId(request?.clientUserMessageId) ||
    typeof request?.text !== "string" ||
    request.text.trim().length === 0 ||
    typeof options?.caller?.request !== "function" ||
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs <= 0 ||
    timeoutMs > NATIVE_CODEX_IDLE_WAKE_MAX_TIMEOUT_MS
  ) {
    return { kind: "rejected-input" };
  }
  const { threadId, clientUserMessageId, text } = request;
  const call = (method: NativeCodexIdleWakeQueueMethod, params: Record<string, unknown>) =>
    boundedCall(options.caller, options.timers ?? DEFAULT_TIMERS, timeoutMs, method, params);

  // 1. Add our one row.
  const added = await call("thread/queue/add", {
    threadId,
    input: [{ type: "text", text, text_elements: [] }],
    clientUserMessageId,
  });
  if (added.kind === "error" && isUnsupportedAdd(added)) return { kind: "unsupported", stage: "add" };
  if (added.kind !== "result") return uncertain("add", added, null);
  const submission = record(record(added.result)?.queuedSubmission);
  const queuedSubmissionId = submission?.id;
  if (!isValidId(queuedSubmissionId)) return uncertainCode("add", "malformed-response", null);
  if (submission?.clientUserMessageId !== clientUserMessageId) {
    return uncertainCode("add", "identity-mismatch", null);
  }

  // 2. Atomically start exactly the row add returned (never the queue head).
  const started = await call("thread/queue/start", { threadId, queuedSubmissionId });
  if (started.kind === "result") {
    const turn = record(record(started.result)?.turn);
    const turnId = turn?.id;
    if (!isValidId(turnId) || turn?.status !== "inProgress") {
      return uncertainCode("start", "malformed-response", queuedSubmissionId);
    }
    return { kind: "started", queuedSubmissionId, turnId };
  }
  if (started.kind !== "error") return uncertain("start", started, queuedSubmissionId);
  if (started.code === JSONRPC_INVALID_REQUEST && started.message === `queued submission not found: ${queuedSubmissionId}`) {
    return uncertainCode("start", "row-absent", queuedSubmissionId);
  }
  if (started.code !== JSONRPC_INVALID_REQUEST || started.message !== BUSY_MESSAGE) {
    return uncertainCode("start", "error-response", queuedSubmissionId);
  }

  // 3. Explicit busy refusal: Codex kept the row. Remove only our exact row.
  const deleted = await call("thread/queue/delete", { threadId, queuedSubmissionId });
  if (deleted.kind !== "result") return uncertain("delete", deleted, queuedSubmissionId);
  const flag = record(deleted.result)?.deleted;
  if (flag === true) return { kind: "busy-removed", queuedSubmissionId };
  if (flag === false) return uncertainCode("delete", "not-deleted", queuedSubmissionId);
  return uncertainCode("delete", "malformed-response", queuedSubmissionId);
}

function isUnsupportedAdd(reply: { readonly code: number; readonly message: string }): boolean {
  return (
    reply.code === JSONRPC_METHOD_NOT_FOUND ||
    (reply.code === JSONRPC_INVALID_REQUEST &&
      (reply.message === ADD_EXPERIMENTAL_REQUIRED_MESSAGE || reply.message.startsWith(ADD_UNKNOWN_VARIANT_PREFIX)))
  );
}

function uncertain(
  stage: NativeCodexIdleWakeStage,
  reply: Exclude<BoundedReply, { kind: "result" }>,
  queuedSubmissionId: string | null,
): NativeCodexIdleWakeOutcome {
  const reason: NativeCodexIdleWakeUncertainReason =
    reply.kind === "failed" ? reply.failure : reply.kind === "error" ? "error-response" : "transport-error";
  return uncertainCode(stage, reason, queuedSubmissionId);
}

function uncertainCode(
  stage: NativeCodexIdleWakeStage,
  reason: NativeCodexIdleWakeUncertainReason,
  queuedSubmissionId: string | null,
): NativeCodexIdleWakeOutcome {
  return { kind: "uncertain", stage, reason, queuedSubmissionId };
}

/**
 * One request, bounded by this module's own deadline. A reply is accepted only
 * if it arrives before the deadline on the monotonic clock. A later reply
 * becomes `timeout`, so it can never lead to a follow-up start or delete.
 */
function boundedCall(
  caller: NativeCodexIdleWakeCaller,
  timers: NativeCodexIdleWakeTimers,
  timeoutMs: number,
  method: NativeCodexIdleWakeQueueMethod,
  params: Record<string, unknown>,
): Promise<BoundedReply> {
  return new Promise<BoundedReply>((resolve) => {
    let settled = false;
    let handle: unknown;
    const settle = (reply: BoundedReply) => {
      if (settled) return;
      settled = true;
      timers.clear(handle);
      resolve(reply);
    };
    const timeout: BoundedReply = { kind: "failed", failure: "timeout" };
    const deadline = timers.now() + timeoutMs;
    const beforeDeadline = (reply: BoundedReply): BoundedReply => (timers.now() < deadline ? reply : timeout);
    handle = timers.set(() => settle(timeout), timeoutMs);
    let pending: Promise<NativeCodexIdleWakeReply>;
    try {
      pending = Promise.resolve(caller.request(method, params, timeoutMs));
    } catch {
      settle(beforeDeadline({ kind: "transport-error" }));
      return;
    }
    pending.then(
      (reply) => settle(beforeDeadline(validReply(reply) ? reply : { kind: "transport-error" })),
      () => settle(beforeDeadline({ kind: "transport-error" })),
    );
  });
}

function validReply(value: unknown): value is NativeCodexIdleWakeReply {
  const reply = record(value);
  if (!reply) return false;
  switch (reply.kind) {
    case "result":
      return "result" in reply;
    case "error":
      return Number.isInteger(reply.code) && typeof reply.message === "string";
    case "failed":
      return reply.failure === "timeout" || reply.failure === "closed" || reply.failure === "write";
    default:
      return false;
  }
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function isValidId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= MAX_ID_LENGTH && !/[\s\u0000-\u001f\u007f]/.test(value);
}
