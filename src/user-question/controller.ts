/**
 * Session-local pending questions (issue #95).
 *
 * The controller owns every question a model asks through the AskUserQuestion
 * tool for one live Pi session: creation, presentation order, answers,
 * declines, and settlement. It is deliberately in-memory and session-scoped —
 * ordinary session scoping, no persistence service:
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
 *   is busy, a plain immediate send when idle. The run is never aborted to
 *   deliver an answer, and no reminder, deadline, or fabricated answer exists.
 * - Sync questions resolve through a waiter held by the tool execution; a
 *   decline resolves it with a terminating result, and session shutdown
 *   settles every remaining waiter so nothing can hang.
 */

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

export type RegisterResult =
  | { ok: true; question: PendingQuestion }
  | { ok: false; reason: "unavailable" | "identity-mismatch" | "invalid"; message: string };

interface Waiter {
  resolve: (result: SyncWaitResult) => void;
  signal?: AbortSignal;
  onAbort?: () => void;
}

export class UserQuestionController {
  private readonly pending = new Map<string, PendingQuestion>();
  private readonly waiters = new Map<string, Waiter>();
  private readonly stateListeners = new Set<() => void>();
  private currentIdentity: object | undefined;
  private nextId = 1;

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
    this.nextId = 1;
    this.currentIdentity = identity;
    this.notifyState();
    return true;
  }

  /** End the current session: settle every waiter and drop all pending state. */
  endSession(): void {
    for (const waiter of this.waiters.values()) {
      settleWaiter(waiter, { outcome: "settled" });
    }
    this.waiters.clear();
    this.pending.clear();
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

  listPending(): readonly PendingQuestion[] {
    return [...this.pending.values()];
  }

  get(id: string): PendingQuestion | undefined {
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
    if (!record || !this.belongsToCurrentSession(record)) {
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
    if (!record || !this.belongsToCurrentSession(record)) {
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
    if (!record || record.mode !== "sync" || !this.belongsToCurrentSession(record)) {
      return Promise.resolve({ outcome: "settled" });
    }
    return new Promise<SyncWaitResult>((resolvePromise) => {
      const waiter: Waiter = { resolve: resolvePromise };
      this.waiters.set(id, waiter);
      if (signal) {
        if (signal.aborted) {
          // The model already gets the interrupted result; drop the record so
          // the list and indicator cannot present a dead [waiting] row whose
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

  private belongsToCurrentSession(record: PendingQuestion): boolean {
    return this.currentIdentity !== undefined && record.sessionIdentity === this.currentIdentity;
  }

  private remove(id: string): void {
    this.pending.delete(id);
    this.notifyState();
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
