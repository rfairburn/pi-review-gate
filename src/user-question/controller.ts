/**
 * Session-local pending questions (issue #95).
 *
 * The controller owns every question and notice registered through the user
 * input tools for one live Pi session: creation, presentation order, answers,
 * explicit notice requests/closure, and settlement. It is deliberately
 * in-memory and session-scoped — ordinary session scoping, no persistence
 * service:
 *
 * - Questions are created only while a session identity (the host's
 *   SessionManager object, stable for the AgentSession) is current, and they
 *   record that identity at creation time.
 * - Every presentation and submission rechecks the originating identity
 *   against the controller's current one. A session switch, /new, or fork
 *   begins a new session (beginSession resets all state), so a stale question
 *   can never be presented in, or answered into, another session; stale UI
 *   callbacks after shutdown are rejected the same way.
 * - Async questions resolve out-of-band: an answer is delivered through the
 *   host's ordinary user-message path — `deliverAs: "steer"` while the agent
 *   is busy, a plain immediate send when idle. More details consumes only the
 *   selected notice before using that same path; delivery failure never
 *   restores it. The optional feature gate applies only to admitting new
 *   notices; it never deletes pending notices or disables their More details/
 *   Close actions. Neither path aborts the run, and no reminder, deadline, or
 *   fabricated answer exists.
 * - Sync questions resolve through a waiter held by the tool execution; a
 *   decline resolves it with a terminating result, and session shutdown
 *   settles every remaining waiter so nothing can hang.
 */

import { isRecord } from "../record-guard";

export type QuestionMode = "async" | "sync";

/** How a pending question left the pending set. */
export type QuestionOutcome = "answered" | "declined" | "interrupted" | "settled";

export interface PendingQuestion {
  /** Stable per-session handle, e.g. "q1". */
  id: string;
  toolCallId: string;
  question: string;
  choices: string[];
  mode: QuestionMode;
  /** The SessionManager object of the session that created the question. */
  sessionIdentity: object;
}

/** A non-interactive notice that remains pending until explicitly closed. */
export interface PendingNotice {
  /** Stable per-session handle, e.g. "n1". */
  id: string;
  toolCallId: string;
  title: string;
  /** Full Markdown body; retained without truncation. */
  body: string;
  /** Optional full context included when the user requests more details. */
  context?: string;
  kind: "notice";
  /** The SessionManager object of the session that created the notice. */
  sessionIdentity: object;
}

export type PendingUserInput = PendingQuestion | PendingNotice;

export interface SyncWaitResult {
  outcome: QuestionOutcome;
  answer?: string;
  wasChoice?: boolean;
}

export type SubmitStatus = "delivered" | "declined" | "rejected";

export interface SubmitResult {
  status: SubmitStatus;
  /** True when no pending questions remain after the operation. */
  empty: boolean;
}

/** The host surface the controller needs for async answer delivery. */
export interface QuestionMessageHost {
  sendUserMessage(content: string, options?: { deliverAs?: "steer" | "followUp" }): Promise<void> | void;
}

/**
 * Live liveness probe captured from the extension context that opened the
 * question UI. The idle/busy decision is made at submission time through this
 * probe, never from a snapshot taken when the question was created.
 */
export interface QuestionSubmitSource {
  isIdle?: () => boolean;
}

export interface UserQuestionDependencies {
  /** The extension `pi` object; its session-bound actions are live-rebound by the host. */
  pi: unknown;
  /** Reports whether the question UI surface (shortcut) is available. */
  uiAvailable: () => boolean;
  /** Optional on-by-default gate for admitting new notices. */
  isNoticeFeatureEnabled?: () => boolean;
  /** Invoked after every state change so the caller can refresh the widget. */
  onStateChange?: () => void;
}

const MAX_QUESTION_CHARS = 2000;
const MAX_CHOICE_COUNT = 12;
const MAX_CHOICE_CHARS = 300;
/** Bound for quoting a question inside delivered answer messages. */
const DELIVERY_QUESTION_BOUND = 200;

export interface RegisterQuestionInput {
  toolCallId: string;
  question: string;
  choices?: readonly string[];
  mode: QuestionMode;
}

export interface RegisterNoticeInput {
  toolCallId: string;
  title: string;
  body: string;
  context?: string;
}

export type RegisterResult =
  | { ok: true; question: PendingQuestion }
  | { ok: false; reason: "unavailable" | "identity-mismatch" | "invalid"; message: string };

export type RegisterNoticeResult =
  | { ok: true; notice: PendingNotice }
  | { ok: false; reason: "unavailable" | "identity-mismatch" | "invalid" | "feature-disabled"; message: string };

interface Waiter {
  resolve: (result: SyncWaitResult) => void;
  signal?: AbortSignal;
  onAbort?: () => void;
}

export class UserQuestionController {
  private readonly pending = new Map<string, PendingUserInput>();
  private readonly waiters = new Map<string, Waiter>();
  /** Prevents reentrant More details requests for the same live notice. */
  private readonly noticeDetailsInFlight = new Map<string, PendingNotice>();
  private readonly stateListeners = new Set<() => void>();
  private currentIdentity: object | undefined;
  /** Separates reused IDs even when a host rebinds the same SessionManager object. */
  private sessionEpoch = 0;
  private nextId = 1;
  private nextNoticeId = 1;

  constructor(private readonly deps: UserQuestionDependencies) {}

  /**
   * Subscribe to pending-state changes (registration, answers, declines,
   * session switches). Returns an unsubscribe function. Listeners run in
   * addition to the dependency-level onStateChange hook.
   */
  addStateListener(listener: () => void): () => void {
    this.stateListeners.add(listener);
    return () => {
      this.stateListeners.delete(listener);
    };
  }

  private notifyState(): void {
    this.deps.onStateChange?.();
    for (const listener of [...this.stateListeners]) listener();
  }

  // ------------------------------------------------------------------
  // Session lifecycle
  // ------------------------------------------------------------------

  /** Begin (or re-begin after switch/new/fork/reload) a session. Returns false when the identity is unusable. */
  beginSession(identity: unknown): boolean {
    this.sessionEpoch += 1;
    if (!isObjectIdentity(identity)) {
      this.currentIdentity = undefined;
      return false;
    }
    // A new session never inherits another session's questions or waiters.
    for (const waiter of this.waiters.values()) {
      settleWaiter(waiter, { outcome: "settled" });
    }
    this.waiters.clear();
    this.pending.clear();
    this.noticeDetailsInFlight.clear();
    this.nextId = 1;
    this.nextNoticeId = 1;
    this.currentIdentity = identity;
    this.notifyState();
    return true;
  }

  /** End the current session: settle every waiter and drop all pending state. */
  endSession(): void {
    this.sessionEpoch += 1;
    for (const waiter of this.waiters.values()) {
      settleWaiter(waiter, { outcome: "settled" });
    }
    this.waiters.clear();
    this.pending.clear();
    this.noticeDetailsInFlight.clear();
    this.currentIdentity = undefined;
    this.notifyState();
  }

  /** The identity of the session currently bound to this controller. */
  currentSessionIdentity(): object | undefined {
    return this.currentIdentity;
  }

  /** True while a usable session identity is bound. */
  isSessionBound(identity?: unknown): boolean {
    if (!this.deps.uiAvailable() || this.currentIdentity === undefined) return false;
    if (identity === undefined) return true;
    return isObjectIdentity(identity) && identity === this.currentIdentity;
  }

  // ------------------------------------------------------------------
  // Question registration (from the tool)
  // ------------------------------------------------------------------

  register(input: RegisterQuestionInput, ctxIdentity: unknown): RegisterResult {
    if (!this.deps.uiAvailable()) {
      return {
        ok: false,
        reason: "unavailable",
        message: unavailableMessage(),
      };
    }
    if (this.currentIdentity === undefined) {
      return {
        ok: false,
        reason: "unavailable",
        message: "Question UI is not available until the session starts.",
      };
    }
    // The tool's own context must belong to the session this controller is
    // bound to; anything else would mean a stale or foreign context.
    if (!isObjectIdentity(ctxIdentity) || ctxIdentity !== this.currentIdentity) {
      return {
        ok: false,
        reason: "identity-mismatch",
        message: "Question was rejected: the calling context does not belong to the current session.",
      };
    }
    const question = input.question.trim();
    if (question.length === 0 || question.length > MAX_QUESTION_CHARS) {
      return {
        ok: false,
        reason: "invalid",
        message: `Invalid question: it must be 1-${MAX_QUESTION_CHARS} characters after trimming.`,
      };
    }
    const choices = normalizeChoices(input.choices);
    if (choices === undefined) {
      return {
        ok: false,
        reason: "invalid",
        message: `Invalid choices: at most ${MAX_CHOICE_COUNT} strings of 1-${MAX_CHOICE_CHARS} characters.`,
      };
    }
    const id = `q${this.nextId}`;
    this.nextId += 1;
    const record: PendingQuestion = {
      id,
      toolCallId: input.toolCallId,
      question,
      choices,
      mode: input.mode,
      sessionIdentity: this.currentIdentity,
    };
    this.pending.set(id, record);
    this.notifyState();
    return { ok: true, question: record };
  }

  /** Register a notice through the same session/UI admission boundary as questions. */
  registerNotice(input: RegisterNoticeInput, ctxIdentity: unknown): RegisterNoticeResult {
    if (!this.deps.uiAvailable()) {
      return { ok: false, reason: "unavailable", message: unavailableMessage() };
    }
    if (!this.noticeFeatureEnabled()) {
      return {
        ok: false,
        reason: "feature-disabled",
        message: "The YouShouldKnow notice feature is disabled; existing pending notices are unchanged.",
      };
    }
    if (this.currentIdentity === undefined) {
      return {
        ok: false,
        reason: "unavailable",
        message: "Question UI is not available until the session starts.",
      };
    }
    if (!isObjectIdentity(ctxIdentity) || ctxIdentity !== this.currentIdentity) {
      return {
        ok: false,
        reason: "identity-mismatch",
        message: "Notice was rejected: the calling context does not belong to the current session.",
      };
    }
    if (typeof input.title !== "string" || input.title.trim().length === 0
      || typeof input.body !== "string" || input.body.trim().length === 0
      || (input.context !== undefined && typeof input.context !== "string")) {
      return {
        ok: false,
        reason: "invalid",
        message: "Invalid notice: title and body must be non-empty strings; context must be a string when provided.",
      };
    }
    const notice: PendingNotice = {
      id: `n${this.nextNoticeId}`,
      toolCallId: input.toolCallId,
      title: input.title,
      body: input.body,
      ...(input.context !== undefined ? { context: input.context } : {}),
      kind: "notice",
      sessionIdentity: this.currentIdentity,
    };
    this.nextNoticeId += 1;
    this.pending.set(notice.id, notice);
    this.notifyState();
    return { ok: true, notice };
  }

  listPending(): readonly PendingUserInput[] {
    return [...this.pending.values()];
  }

  /** Question-only lookup retained for existing question flows. */
  get(id: string): PendingQuestion | undefined {
    const record = this.pending.get(id);
    return record && !isPendingNotice(record) ? record : undefined;
  }

  /** Shared lookup used by the question/notice list surface. */
  getPending(id: string): PendingUserInput | undefined {
    return this.pending.get(id);
  }

  // ------------------------------------------------------------------
  // User actions (from the question list UI)
  // ------------------------------------------------------------------

  /**
   * Submit an answer for a pending question. Rechecks the originating
   * session identity before acting; stale callbacks are rejected without
   * touching the host or the model.
   */
  submitAnswer(id: string, rawAnswer: string, source?: QuestionSubmitSource): SubmitResult {
    const record = this.pending.get(id);
    if (!record || isPendingNotice(record) || !this.belongsToCurrentSession(record)) {
      return { status: "rejected", empty: this.pending.size === 0 };
    }
    const answer = rawAnswer.trim();
    if (answer.length === 0) {
      // An empty answer is not an answer; the question stays pending.
      return { status: "rejected", empty: false };
    }
    const wasChoice = record.choices.includes(answer);
    this.remove(id);
    if (record.mode === "sync") {
      const waiter = this.waiters.get(id);
      if (!waiter) {
        // No waiting tool call can receive this answer (the wait was
        // interrupted before it could settle). Never claim delivery.
        return { status: "rejected", empty: this.pending.size === 0 };
      }
      settleWaiter(waiter, { outcome: "answered", answer, wasChoice });
      this.waiters.delete(id);
      return { status: "delivered", empty: this.pending.size === 0 };
    }
    void this.deliverAsyncAnswer(record, answer, source);
    return { status: "delivered", empty: this.pending.size === 0 };
  }

  /**
   * Decline a pending question. For sync questions this releases the wait;
   * for async questions it only removes the pending state — no message is
   * delivered to the model, so no answer is fabricated or implied.
   */
  submitDecline(id: string): SubmitResult {
    const record = this.pending.get(id);
    if (!record || isPendingNotice(record) || !this.belongsToCurrentSession(record)) {
      return { status: "rejected", empty: this.pending.size === 0 };
    }
    this.remove(id);
    if (record.mode === "sync") {
      const waiter = this.waiters.get(id);
      if (waiter) {
        settleWaiter(waiter, { outcome: "declined" });
        this.waiters.delete(id);
      }
    }
    return { status: "declined", empty: this.pending.size === 0 };
  }

  /** Close only one live notice; no request or explanatory message is sent. */
  closeNotice(id: string): boolean {
    const record = this.pending.get(id);
    if (!record || !isPendingNotice(record) || !this.belongsToCurrentSession(record)) return false;
    this.remove(id);
    return true;
  }

  /**
   * Consume the selected notice before checking delivery readiness or using
   * the current session's ordinary message path. `expectedNotice` is the
   * private record snapshot retained by the closing popup: it prevents a stale
   * callback from resolving a reused per-session ID to a replacement record.
   * Once the live selection is accepted, it is never restored after failure.
   */
  async requestNoticeDetails(
    id: string,
    source?: QuestionSubmitSource,
    expectedNotice?: PendingNotice,
  ): Promise<boolean> {
    const record = this.pending.get(id);
    if (!record || !isPendingNotice(record) || (expectedNotice !== undefined && record !== expectedNotice)
      || !this.isCurrentPending(record) || !this.isSessionBound(record.sessionIdentity)) return false;
    if (this.noticeDetailsInFlight.get(id) === record) return false;

    const epoch = this.sessionEpoch;
    this.noticeDetailsInFlight.set(id, record);
    try {
      const message = formatNoticeDetailsDelivery(record);
      // Consume as soon as this exact live selection is accepted. Even a
      // missing host sender or a failing idle probe must not resurrect it.
      if (!this.remove(id, record)) return false;
      if (this.sessionEpoch !== epoch || this.currentIdentity !== record.sessionIdentity
        || this.pending.has(id) || !this.isSessionBound(record.sessionIdentity)) return false;

      const host = this.deps.pi as Partial<QuestionMessageHost> | undefined;
      const send = isRecord(host) ? host.sendUserMessage : undefined;
      if (typeof send !== "function") return false;
      if (this.sessionEpoch !== epoch || this.currentIdentity !== record.sessionIdentity
        || this.pending.has(id) || !this.isSessionBound(record.sessionIdentity)) return false;

      const idle = source?.isIdle ? source.isIdle() : true;
      if (this.sessionEpoch !== epoch || this.currentIdentity !== record.sessionIdentity
        || this.pending.has(id) || !this.isSessionBound(record.sessionIdentity)) return false;

      if (!idle) {
        await send.call(host, message, { deliverAs: "steer" });
      } else {
        await send.call(host, message);
      }
      return true;
    } catch {
      return false;
    } finally {
      if (this.noticeDetailsInFlight.get(id) === record) this.noticeDetailsInFlight.delete(id);
    }
  }

  // ------------------------------------------------------------------
  // Synchronous waiting (from the tool execution)
  // ------------------------------------------------------------------

  /**
   * Wait for a sync question's answer or decline. Settles on user action, on
   * run abort (defensive; nothing here ever aborts the run), or on session
   * shutdown. Never resolves with a fabricated answer.
   */
  waitForAnswer(id: string, signal?: AbortSignal): Promise<SyncWaitResult> {
    const record = this.pending.get(id);
    if (!record || isPendingNotice(record) || record.mode !== "sync" || !this.belongsToCurrentSession(record)) {
      return Promise.resolve({ outcome: "settled" });
    }
    return new Promise<SyncWaitResult>((resolvePromise) => {
      const waiter: Waiter = { resolve: resolvePromise };
      this.waiters.set(id, waiter);
      if (signal) {
        if (signal.aborted) {
          // The model already gets the interrupted result; drop the record so
          // the list and panel cannot present a dead [waiting] row whose
          // answer could never reach the model.
          this.remove(id);
          settleWaiter(waiter, { outcome: "interrupted" });
          return;
        }
        waiter.signal = signal;
        waiter.onAbort = () => {
          this.waiters.delete(id);
          this.remove(id);
          settleWaiter(waiter, { outcome: "interrupted" });
        };
        signal.addEventListener("abort", waiter.onAbort, { once: true });
      }
    });
  }

  // ------------------------------------------------------------------
  // Internals
  // ------------------------------------------------------------------

  private belongsToCurrentSession(record: PendingUserInput): boolean {
    return this.currentIdentity !== undefined && record.sessionIdentity === this.currentIdentity;
  }

  private isCurrentPending(record: PendingUserInput): boolean {
    return this.pending.get(record.id) === record && this.belongsToCurrentSession(record);
  }

  /** Public, fail-closed gate for admitting new notices. */
  isNoticeFeatureEnabled(): boolean {
    return readEnabled(this.deps.isNoticeFeatureEnabled);
  }

  private noticeFeatureEnabled(): boolean {
    return this.isNoticeFeatureEnabled();
  }

  private remove(id: string, expected?: PendingUserInput): boolean {
    if (expected !== undefined && this.pending.get(id) !== expected) return false;
    if (!this.pending.delete(id)) return false;
    this.notifyState();
    return true;
  }

  private deliverAsyncAnswer(
    record: PendingQuestion,
    answer: string,
    source?: QuestionSubmitSource,
  ): void {
    const host = this.deps.pi as Partial<QuestionMessageHost> | undefined;
    const send = isRecord(host) ? host.sendUserMessage : undefined;
    if (typeof send !== "function") return;
    // Recheck identity at delivery time: the send must reach the session that
    // asked the question, never a session the user switched to meanwhile.
    if (!this.belongsToCurrentSession(record)) return;
    const message = formatAnswerDelivery(record.question, answer);
    void (async () => {
      try {
        const idle = source?.isIdle ? source.isIdle() : true;
        if (!idle) {
          // Ordinary non-interrupting steering while busy; never an abort.
          await send(message, { deliverAs: "steer" });
          return;
        }
        // Idle: the supported normal delivery path (immediate send, new turn).
        await send(message);
      } catch {
        // Delivery failure is reported by the host's own error surface; the
        // question is already out of the pending set and nothing is retried.
      }
    })();
  }
}

function settleWaiter(waiter: Waiter, result: SyncWaitResult): void {
  if (waiter.signal && waiter.onAbort) {
    waiter.signal.removeEventListener("abort", waiter.onAbort);
  }
  waiter.onAbort = undefined;
  waiter.resolve(result);
}

export function normalizeChoices(choices: readonly string[] | undefined): string[] | undefined {
  if (choices === undefined) return [];
  if (!Array.isArray(choices) || choices.length > MAX_CHOICE_COUNT) return undefined;
  const normalized: string[] = [];
  for (const value of choices) {
    if (typeof value !== "string") return undefined;
    const trimmed = value.trim();
    if (trimmed.length === 0 || trimmed.length > MAX_CHOICE_CHARS) return undefined;
    normalized.push(trimmed);
  }
  return normalized;
}

export function formatAnswerDelivery(question: string, answer: string): string {
  return `Answer to pending question "${boundQuestion(question)}": ${answer}`;
}

/** Full, unbounded request payload for the explicit More details action. */
export function formatNoticeDetailsDelivery(notice: Pick<PendingNotice, "title" | "body" | "context">): string {
  return `More details requested for "${notice.title}":\n\n${notice.body}`
    + (notice.context !== undefined ? `\n\nRelevant context:\n${notice.context}` : "")
    + "\n\nPlease elaborate on these details in your normal conversation reply.";
}

function boundQuestion(question: string): string {
  if (question.length <= DELIVERY_QUESTION_BOUND) return question;
  return `${question.slice(0, DELIVERY_QUESTION_BOUND - 1)}…`;
}

function unavailableMessage(): string {
  return "Question UI is not available in this session (the pending-question shortcut could not be registered).";
}

function isObjectIdentity(value: unknown): value is object {
  return typeof value === "object" && value !== null;
}

function isPendingNotice(record: PendingUserInput): record is PendingNotice {
  return "kind" in record && record.kind === "notice";
}

function readEnabled(getter: (() => boolean) | undefined): boolean {
  if (getter === undefined) return true;
  try {
    return getter() === true;
  } catch {
    return false;
  }
}
