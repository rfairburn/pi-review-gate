/**
 * Issue #222: the "orchestrator-turn" schedule destination, corrected for the
 * real Pi host. A due entry with this destination is delivered — instructions
 * and occurrence identity — as a NEW TURN to the EXISTING primary agent
 * instead of starting an isolated subtask. No second Pi process is spawned,
 * and no per-entry workspace/cwd override exists in this scope: the agent
 * acts in its current Pi launch workspace with its current tools, model, and
 * review behavior, and may act directly or start subtasks under their own
 * existing lifecycle.
 *
 * Host reality this correction encodes (verified against the installed Pi
 * runtime): `sendCustomMessage` invoked on an idle agent starts its turn
 * through the low-level run path and a busy agent queues the message as a
 * follow-up that the running turn's loop consumes — NEITHER path emits
 * `before_agent_start`, while `agent_start` precedes `message_start` for
 * every consuming run, `message_start` for the custom message precedes its
 * model request, and `agent_settled` fires once per submit-cycle. The
 * extension therefore:
 *
 * - arms the fail-closed review gate from the host's `message_start` for the
 *   scheduled custom message (the review gate's message_start observation in
 *   src/index.ts), so the review baseline is armed BEFORE the model request
 *   on the idle path, and a busy queued turn shares the exchange already
 *   armed by the running cycle's own before_agent_start;
 * - attributes actual scheduled-message processing through an opaque,
 *   per-occurrence identity carried in the message details and matched on
 *   the host's `message_start` — never through before_agent_start, whose
 *   runs include unrelated human turns a not-yet-processed delivery must
 *   never settle;
 * - counts an occurrence as executed only when the host's `message_start`
 *   observed THIS message being consumed (inside a run) AND the consuming
 *   run has ended (host `agent_end`) by the time an `agent_settled`
 *   settlement runs. Delivery, another run, and the end of optional work the
 *   turn started never complete an occurrence.
 *
 * Completion semantics: the scheduled occurrence completes when its
 * initiating turn ends — NOT when optional work the turn started settles,
 * and not when the delivery is merely accepted by the host. A send the host
 * never observed on message_start stays pending forever (never counted as
 * executed), and session boundaries clear all correlation so a different
 * session never completes an old occurrence.
 *
 * Delivery shape: a non-interrupting followUp that still triggers a turn — a
 * busy orchestrator is never steered or interrupted; the queued turn runs
 * after the current one. Delivery does not dispatch any task and never
 * starts tracking the work the turn may choose to do.
 */
import { randomUUID } from "node:crypto";
import { capNotificationText } from "../execution/subtask-notifications";
import { redactSensitiveText } from "../redaction";
import type { ScheduledTaskEntryConfig } from "../config";

/** The delivered message shape for one orchestrator-turn delivery. */
export interface ScheduledOrchestratorTurnMessage {
  customType: "pi-review-scheduled-orchestrator-turn";
  content: string;
  display: true;
  details: Record<string, unknown>;
}

/** One delivered scheduled orchestrator turn and its truthful lifecycle. */
export interface ScheduledOrchestratorTurnOccurrence {
  entryId: string;
  entryName: string;
  cron: string;
  /** The exact sampled due minute (the occurrence identity, not dispatch time). */
  dueAt: Date;
  /** When the delivery attempt began (the tracker records it before the send fires). */
  deliveredAt: Date;
  /**
   * The opaque per-occurrence identity carried in the message details. The
   * host's `message_start` observation matches this id — nothing else
   * (including any unrelated `before_agent_start`), never the model's own
   * output, and never the delivery, can settle the occurrence.
   */
  occurrenceId: string;
  /** When the host's message_start observed THIS message being consumed, if ever. */
  processedAt?: Date;
  /** When (and whether) the initiating turn was observed to settle. */
  settledAt?: Date;
}

/**
 * Triggering-turn identity of one delivery, created BEFORE the send fires so
 * a host that observes the custom message on message_start synchronously
 * (racing the dispatch function's own return) always finds the occurrence
 * already registered. A rejection or missing channel discards it; a timed-out
 * uncertain send keeps it pending for a later truthful arrival.
 */
export interface ScheduledOrchestratorTurnSending {
  readonly occurrenceId: string;
  /** Resolves "observed" when the host's message_start consumes this message; "abandoned" after a session reset. */
  readonly observed: Promise<"observed" | "abandoned">;
  /** Synchronous probe: whether the host's message_start has already consumed this exact message. */
  observedSync(): boolean;
  /** Discard an UNOBSERVED sending after a definite non-delivery. Never removes an observed one. */
  discard(): void;
}

const OCCURRENCES_RETAINED = 32;
/** Number of still-unsettled delivered occurrences the tracker retains. */
const PENDING_OCCURRENCES_RETAINED = 32;

/** Bounded, redacted text for identity fields in the turn header/details. */
function clipTurnLabel(value: string, max: number): string {
  return capNotificationText(redactSensitiveText(value), max);
}

/**
 * Pure renderer for one scheduled orchestrator turn. The instructions are
 * carried VERBATIM (they are the request); the surrounding identity text is
 * bounded and redacted so a hostile entry label cannot smuggle unbounded
 * text through the header.
 */
export function formatScheduledOrchestratorTurnContent(
  entry: Pick<ScheduledTaskEntryConfig, "instructions">,
  identity: { entryId: string; entryName: string; cron: string; dueAt: Date; dueLabel: string },
): string {
  const header = [
    `Scheduled orchestrator turn for task ${identity.entryId} (${clipTurnLabel(identity.entryName, 160)}) was due at ${identity.dueLabel} for cron "${identity.cron}".`,
    "Perform the request below in this turn using your current tools, model, and review behavior, and with the current Pi launch workspace (no workspace override applies). You may act directly or start subtasks; any subtasks keep their own ordinary lifecycle and notifications and do not keep this scheduled occurrence open.",
    "This is a scheduled request, not a completed outcome or an outcome report.",
  ];
  return [...header, "", entry.instructions.trim()].join("\n");
}

/**
 * The custom message types this extension delivers with a triggering turn.
 * A host `message_start` for one of them, observed while an agent run is in
 * flight, means the model is about to act on a non-model-initiated delivery;
 * the review gate must be armed (before that message's model request) and,
 * for the orchestrator-turn identity, the occurrence becomes attributed.
 */
export const TRIGGERING_TURN_CUSTOM_TYPES: readonly string[] = [
  "pi-review-scheduled-orchestrator-turn",
  "pi-review-subtask-launch",
  "pi-review-scheduled-task-event",
  "pi-review-background-ready",
];

/**
 * Extract a triggering custom message out of a host `message_start` handler's
 * arguments. Real Pi dispatches `(event, ctx)` where event carries the
 * message; the tolerant search keeps the observation working for hosts that
 * pass the message directly. Only role "custom" messages are considered;
 * user/assistant/system message_starts are never attributed or armed.
 */
export function findTriggeringCustomMessage(args: unknown[]): { customType: string; content?: string; details: Record<string, unknown> | undefined } | undefined {
  for (const arg of args) {
    if (typeof arg !== "object" || arg === null) continue;
    const container = arg as { message?: unknown };
    const candidate: Record<string, unknown> | undefined = isRecord(container.message)
      ? container.message
      : (isCustomShape(arg) ? (arg as Record<string, unknown>) : undefined);
    if (!candidate || candidate.role !== "custom") continue;
    const customType = typeof candidate.customType === "string" ? candidate.customType : undefined;
    if (!customType || !TRIGGERING_TURN_CUSTOM_TYPES.includes(customType)) continue;
    return {
      customType,
      ...(customType === "pi-review-scheduled-orchestrator-turn" && typeof candidate.content === "string"
        ? { content: candidate.content }
        : {}),
      details: isRecord(candidate.details) ? candidate.details : undefined,
    };
  }
  return undefined;
}

function isCustomShape(value: unknown): boolean {
  return typeof value === "object" && value !== null && !Array.isArray(value) && "customType" in (value as Record<string, unknown>);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Deliver one due entry as a triggered turn to the existing primary agent.
 * The occurrence identity was registered by the caller (ScheduledOrchestratorTurnTracker.beginOccurrence)
 * BEFORE this send: a host that starts the run synchronously — message_start
 * racing the dispatch return — is still attributed. Returns "unavailable"
 * when the host has no message channel or definitively rejects the send (the
 * unobserved sending is discarded so nothing can later be counted), and
 * "uncertain" when the send neither acknowledged nor was observed within its
 * bounded window (it may still arrive; it stays pending and can only ever be
 * counted by the tracker's own message_start → settlement evidence).
 */
export async function deliverScheduledOrchestratorTurn(
  pi: unknown,
  request: {
    entryId: string;
    entryName: string;
    cron: string;
    instructions: string;
    dueAt: Date;
    dueLabel: string;
    /** The occurrence identity created before this send (opaque, unique per occurrence). */
    sending: ScheduledOrchestratorTurnSending;
  },
  options?: { timeoutMs?: number },
): Promise<"delivered" | "unavailable" | "uncertain"> {
  try {
    if (!isRecord(pi) || typeof pi.sendMessage !== "function") {
      request.sending.discard();
      return "unavailable";
    }
    const content = formatScheduledOrchestratorTurnContent(
      { instructions: request.instructions },
      { entryId: request.entryId, entryName: request.entryName, cron: request.cron, dueAt: request.dueAt, dueLabel: request.dueLabel },
    );
    const sent = (pi as { sendMessage: (message: unknown, delivery: unknown) => unknown }).sendMessage(
      {
        customType: "pi-review-scheduled-orchestrator-turn",
        content,
        display: true,
        details: {
          entryId: request.entryId,
          entryName: clipTurnLabel(request.entryName, 160),
          cron: request.cron,
          dueAt: request.dueAt.toISOString(),
          occurrenceId: request.sending.occurrenceId,
        },
      } satisfies ScheduledOrchestratorTurnMessage,
      // Non-interrupting and still turn-triggering: a busy orchestrator is
      // queued behind its current turn, never steered or interrupted.
      { deliverAs: "followUp", triggerTurn: true },
    );
    // A synchronous void send is accepted immediately; the host may already
    // have begun (or queued) the run — the identity was registered before
    // this call, so a message_start racing this return is attributed.
    if (!isPromiseLike(sent)) return "delivered";
    const outcome = await Promise.race([
      sent.then(() => "sent" as const, () => "rejected" as const),
      request.sending.observed.then(() => "observed" as const, () => "abandoned" as const),
      new Promise<"timeout">((resolve) => {
        const timer = setTimeout(() => resolve("timeout"), options?.timeoutMs ?? SCHEDULED_ORCHESTRATOR_TURN_DELIVERY_TIMEOUT_MS);
        timer.unref?.();
      }),
    ]);
    if (outcome === "sent" || outcome === "observed") {
      // Suppress the late settle so a long idle run (whose full cycles the
      // host's send promise may only resolve after) can never surface.
      Promise.resolve(sent).catch(() => undefined);
      return "delivered";
    }
    if (outcome === "rejected") {
      if (request.sending.observedSync()) {
        // The host observed the message despite a late promise rejection:
        // the message exists in the session and is tracked.
        Promise.resolve(sent).catch(() => undefined);
        return "delivered";
      }
      request.sending.discard();
      return "unavailable";
    }
    if (outcome === "abandoned") {
      // The occurrence was reset away (session boundary); nothing truthful
      // can be claimed or tracked for it in this session.
      return "uncertain";
    }
    // A timed-out send is UNCERTAIN, not failed: the host may still enqueue
    // or later acknowledge the message. It stays pending; only the tracker's
    // own observation of this exact message can ever complete it. Suppress
    // the late settle and let the caller report exactly what is and is not
    // known.
    Promise.resolve(sent).catch(() => undefined);
    return "uncertain";
  } catch {
    // A host may synchronously emit message_start and then throw from its
    // send wrapper. The observed identity proves the message entered the
    // conversation despite that late exception; do not discard or report it as
    // definitely unavailable.
    if (request.sending.observedSync()) return "delivered";
    request.sending.discard();
    return "unavailable";
  }
}

/** Longest wait for a host's send promise before an orchestrator delivery is reported failed. */
export const SCHEDULED_ORCHESTRATOR_TURN_DELIVERY_TIMEOUT_MS = 10_000;

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return typeof (value as PromiseLike<unknown> | undefined)?.then === "function";
}

interface PendingOccurrence {
  occurrence: ScheduledOrchestratorTurnOccurrence;
  processedRunSequence?: number;
  reviewArmed: boolean;
  resolveObserved: (next: "observed" | "abandoned") => void;
  observedPromise: Promise<"observed" | "abandoned">;
}

/**
 * In-process tracker for delivered scheduled orchestrator turns (corrected
 * for the real host): attribution is identity-based, NOT a plain run-start
 * sequence. Occurrences are marked complete only when
 *
 * 1. the host's `message_start` observed THIS occurrence's opaque identity
 *    being consumed inside an agent run (its processing), and
 * 2. review/auth re-arming succeeded for that message_start (an arming failure
 *    leaves it pending and the caller blocks tool calls fail-closed), and
 * 3. that consuming run has ended (host `agent_end`) and an `agent_settled`
 *    boundary has arrived (the submit-cycle settlement the review gate also
 *    observes, registered after the gate's own settlement).
 *
 * Delivery never completes an occurrence, an unrelated human turn never
 * completes a not-yet-processed occurrence, and a settlement that arrives
 * while another run is still in flight never completes what that run has not
 * yet consumed.
 */
export class ScheduledOrchestratorTurnTracker {
  /** Pending occurrences keyed by their opaque occurrenceId, in delivery order. */
  private readonly pending = new Map<string, PendingOccurrence>();
  private readonly settled: ScheduledOrchestratorTurnOccurrence[] = [];
  /** Monotonic sequence of observed run starts (host agent_start); 0 until any run begins. */
  private runSequence = 0;
  /** Runs that emitted agent_start but not yet agent_end (never more than one at a time). */
  private readonly inFlightRuns: number[] = [];
  /** Count of runs that have ended (host agent_end). */
  private endedRunCount = 0;
  private trackingStatus: "host-lifecycle-hooks" | "unavailable" = "unavailable";

  /** Live turn-end observability, updated after hook registration settles. */
  get turnEndTracking(): "host-lifecycle-hooks" | "unavailable" {
    return this.trackingStatus;
  }

  /**
   * The dispatch gate checks this availability (every essential hook must be
   * registered) BEFORE any delivery; deliveries recorded through a host that
   * cannot truthfully observe runs never happen — the unsafe dispatch is
   * rejected fail-closed instead of being sent unreviewed.
   */
  setTurnEndTracking(next: "host-lifecycle-hooks" | "unavailable"): void {
    this.trackingStatus = next;
  }

  /**
   * Register one delivery attempt BEFORE its send so a synchronous host
   * (message_start racing the dispatch return) is always attributable.
   * Returns the opaque per-occurrence identity plus the observation race
   * handles for the bounded delivery attempt.
   */
  beginOccurrence(record: {
    entryId: string;
    entryName: string;
    cron: string;
    dueAt: Date;
  }): ScheduledOrchestratorTurnSending {
    while (this.pending.size >= PENDING_OCCURRENCES_RETAINED) {
      // Bound the unbounded-uncertainty case: drop the OLDEST pending
      // occurrence (insertion order). A dropped occurrence stops tracking
      // (it can never be counted) instead of ever overcounting — the
      // fail-closed direction.
      const oldest = this.pending.keys().next();
      if (oldest.done) break;
      const dropped = this.pending.get(oldest.value);
      this.pending.delete(oldest.value);
      dropped?.resolveObserved("abandoned");
    }
    const occurrenceId = randomUUID();
    const occurrence: ScheduledOrchestratorTurnOccurrence = {
      ...record,
      deliveredAt: new Date(),
      occurrenceId,
    };
    let resolveObserved!: (next: "observed" | "abandoned") => void;
    const observedPromise = new Promise<"observed" | "abandoned">((resolve) => {
      resolveObserved = resolve;
    });
    this.pending.set(occurrenceId, { occurrence, reviewArmed: false, resolveObserved, observedPromise });
    return {
      occurrenceId,
      observed: observedPromise,
      observedSync: (): boolean => this.pending.get(occurrenceId)?.occurrence.processedAt !== undefined,
      discard: (): void => {
        this.discardOccurrence(occurrenceId);
      },
    };
  }

  /**
   * Definite non-delivery (rejected send or no channel): drop the pending
   * occurrence when its message was never observed to arrive. An OBSERVED
   * message is already in the host session — never removed. Delivery of a
   * rejected send therefore never implies the turn ran.
   */
  discardOccurrence(occurrenceId: string): boolean {
    const pending = this.pending.get(occurrenceId);
    if (!pending || pending.occurrence.processedAt !== undefined) return false;
    this.pending.delete(occurrenceId);
    pending.resolveObserved("abandoned");
    return true;
  }

  /**
   * The host's message_start observed a custom triggering-turn message.
   * Attributable only when it matches a tracked occurrence identity (this
   * message — not an unrelated custom message, not a human turn), and only
   * while a run is in flight (it was consumed as part of a model run). An
   * observation BEFORE the delivery bookkeeping arrives still resolves the
   * sending handle (host races the dispatch return); the recorded
   * processedRun then gates the later settlements.
   */
  noteMessageObserved(occurrenceId: unknown): boolean {
    if (typeof occurrenceId !== "string") return false;
    const pending = this.pending.get(occurrenceId);
    if (!pending) return false;
    if (pending.occurrence.processedAt !== undefined) return true;
    if (this.inFlightRuns.length === 0) return false;
    const consumingRun = this.inFlightRuns[this.inFlightRuns.length - 1]!;
    pending.occurrence.processedAt = new Date();
    pending.processedRunSequence = consumingRun;
    pending.reviewArmed = true;
    pending.resolveObserved("observed");
    return true;
  }

  /**
   * An observed message whose review/auth reassertion failed must never be
   * counted as a completed scheduled turn. The host cannot cancel a
   * message_start-triggered provider request, so the caller also blocks tool
   * calls for the session; this flag keeps lifecycle accounting fail-closed.
   */
  noteMessageArmingFailed(occurrenceId: unknown): void {
    if (typeof occurrenceId !== "string") return;
    const pending = this.pending.get(occurrenceId);
    if (pending?.occurrence.processedAt !== undefined) pending.reviewArmed = false;
  }

  /** A low-level agent run began (host agent_start): consumed runs bind to its sequence. */
  agentRunStarted(): void {
    this.runSequence += 1;
    this.inFlightRuns.push(this.runSequence);
  }

  /** A low-level agent run ended (host agent_end); runs are serial, so the oldest in-flight one ended. */
  agentRunEnded(): void {
    if (this.inFlightRuns.shift() === undefined) return;
    this.endedRunCount += 1;
  }

  /** True while some agent run has begun but not ended (the consuming-run predicate). */
  hasRunsInFlight(): boolean {
    return this.inFlightRuns.length > 0;
  }

  /**
   * A submit-cycle settlement (host agent_settled) — the boundary where Pi
   * guarantees no automatic retry, compaction retry, or queued continuation
   * remains, and registered after the review gate's own settlement handler.
   * Completes every pending occurrence whose message was OBSERVED inside a
   * run, whose review/auth arming succeeded, and whose run has already ended:
   * that boundary truthfully ends the initiating turn. An unrelated
   * settlement (no observation, failed arming, or still-streaming consuming
   * run) completes nothing. Returns the settled occurrences.
   */
  agentRunSettled(): ScheduledOrchestratorTurnOccurrence[] {
    const settled: ScheduledOrchestratorTurnOccurrence[] = [];
    for (const [occurrenceId, pending] of [...this.pending]) {
      const processedRun = pending.processedRunSequence;
      if (processedRun === undefined || !pending.reviewArmed) continue;
      if (this.endedRunCount < processedRun) continue;
      this.pending.delete(occurrenceId);
      pending.occurrence.settledAt = new Date();
      this.pushSettled(pending.occurrence);
      settled.push(pending.occurrence);
    }
    return settled;
  }

  /**
   * Session boundary: drop every correlation recorded for the previous
   * session. A new session's runs are never the predecessors' turns, so an
   * occurrence carried across a session switch can never be settled by (or
   * settle) unrelated run boundaries afterwards.
   */
  resetSession(): void {
    for (const pending of [...this.pending.values()]) pending.resolveObserved("abandoned");
    this.pending.clear();
    this.inFlightRuns.length = 0;
    this.runSequence = 0;
    this.endedRunCount = 0;
  }

  /** Delivered occurrences still awaiting their initiating turn's truthful end. */
  pendingOccurrences(): readonly ScheduledOrchestratorTurnOccurrence[] {
    return [...this.pending.values()].map((pending) => pending.occurrence);
  }

  /** Recently settled occurrences, newest last (bounded history). */
  settledOccurrences(): readonly ScheduledOrchestratorTurnOccurrence[] {
    return [...this.settled];
  }

  private pushSettled(occurrence: ScheduledOrchestratorTurnOccurrence): void {
    this.settled.push(occurrence);
    if (this.settled.length > OCCURRENCES_RETAINED) this.settled.shift();
  }
}