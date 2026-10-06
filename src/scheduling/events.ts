/**
 * Issue #26: scheduled-dispatch event shaping — the task definition carried to
 * the ordinary subtask start path, and the actionable owner-wake text for the
 * three scheduler-only outcomes (overlap skip, overdue drop, dispatch
 * failure). Wording is curated here so every character delivered through the
 * wake channel is bounded and truthful: a skip never implies completion or
 * cancellation, and a dispatch failure names the entry, the due time, and
 * the exact error.
 */
import type { ScheduledTaskEntryConfig } from "../config";
import type { BackgroundTaskDefinition } from "../execution/task-state";

/** The subtask definition one scheduled run carries; identity is explicit. */
export function scheduledTaskDefinition(entryId: string, entry: ScheduledTaskEntryConfig): BackgroundTaskDefinition {
  return {
    title: `Scheduled ${entry.kind} task ${entryId}: ${entry.name}`,
    instructions: entry.instructions,
    acceptanceCriteria: ["The task instructions are completed as written."],
  };
}

export interface ScheduledRunView {
  executionId: string;
  kind: "execute" | "research" | "inplace";
  tasks: Array<{ taskId: string; title: string; state: string }>;
}

function dueTimeLabel(dueAt: Date): string {
  // Display the exact occurrence in the host's local timezone, as the cron
  // expression is interpreted. Include the offset so the two passes through
  // a repeated fall-back hour remain distinguishable without showing UTC.
  const pad = (value: number): string => String(value).padStart(2, "0");
  const offsetMinutes = -dueAt.getTimezoneOffset();
  const sign = offsetMinutes < 0 ? "-" : "+";
  const offset = `${sign}${pad(Math.floor(Math.abs(offsetMinutes) / 60))}:${pad(Math.abs(offsetMinutes) % 60)}`;
  return `${dueAt.getFullYear()}-${pad(dueAt.getMonth() + 1)}-${pad(dueAt.getDate())} `
    + `${pad(dueAt.getHours())}:${pad(dueAt.getMinutes())} ${offset} (local)`;
}

export { dueTimeLabel };

/**
 * Actionable overlap-skip wake: the schedule identity, the exact due time, and
 * every active execution with its task handles — enough for the owner to act
 * without implying that anything was completed, cancelled, or queued.
 */
export function formatScheduledSkipEvent(
  entryId: string,
  entry: ScheduledTaskEntryConfig,
  dueAt: Date,
  runs: readonly ScheduledRunView[],
): string {
  const lines = [
    `Scheduled task ${entryId} (${entry.name}) was due at ${dueTimeLabel(dueAt)} for cron "${entry.cron}", but a previous run of this entry is still active. The due occurrence was SKIPPED: nothing was dispatched, queued, interrupted, or completed.`,
    "Active executions of this scheduled task:",
  ];
  for (const run of runs) {
    lines.push(`- ${run.executionId} (${run.kind}):`);
    for (const task of run.tasks) {
      lines.push(`  - ${task.taskId} [${task.state}] ${task.title}`);
    }
  }
  lines.push(
    "Inspect the active executions before re-dispatching; every further due occurrence is skipped the same way while any of them remains unsettled.",
  );
  return lines.join("\n");
}

/**
 * Issue #306: one-shot orchestrator-turn pending-skip report. A due
 * occurrence of a one-shot entry whose previous delivery is still pending
 * (queued behind a busy agent, in flight, or observed but unsettled) must
 * not queue another execution of the same entry. The report states exactly
 * what is pending and that nothing new was dispatched; the pending turn is
 * counted only by its own message_start observation.
 */
export function formatScheduledOneShotPendingSkip(
  entryId: string,
  entry: ScheduledTaskEntryConfig,
  dueAt: Date,
): string {
  return [
    `Scheduled task ${entryId} (${entry.name}) was due at ${dueTimeLabel(dueAt)} for cron "${entry.cron}", but it is a one-shot entry whose previous orchestrator-turn delivery is still pending (queued, in flight, or observed but not yet settled).`,
    "The due occurrence was SKIPPED: no second turn was queued, dispatched, or executed. The pending turn counts as the entry's single execution only when the host's own message lifecycle observes it; until then the entry has NOT run.",
  ].join("\n");
}

/**
 * Bounded overdue-drop report: a due occurrence whose minute passed before it
 * could be dispatched while this entry's previous dispatch had not yet
 * settled, with no run of the entry active. It names the schedule identity
 * and the exact due time, states plainly that nothing ran, and promises no
 * catch-up — one report per dropped occurrence; it never implies completion or
 * cancellation.
 */
export function formatScheduledOverdueDrop(
  entryId: string,
  entry: ScheduledTaskEntryConfig,
  dueAt: Date,
): string {
  return [
    `Scheduled task ${entryId} (${entry.name}) was due at ${dueTimeLabel(dueAt)} for cron "${entry.cron}", but its dispatch was delayed past that minute while this entry's previous dispatch had not yet settled, and no run of this entry is active.`,
    "The occurrence was NOT RUN: nothing was dispatched, queued, interrupted, or completed, and no catch-up run is started. The next due occurrence is evaluated independently.",
  ].join("\n");
}

/** Actionable dispatch-failure wake: the entry, the due time, and the exact error. */
export function formatScheduledDispatchFailure(
  entryId: string,
  entry: ScheduledTaskEntryConfig,
  dueAt: Date,
  message: string,
): string {
  return [
    `Scheduled task ${entryId} (${entry.name}) was due at ${dueTimeLabel(dueAt)} for cron "${entry.cron}", but dispatch failed:`,
    message,
    "The occurrence was not run. Fix the entry or its worker/review choices in /review-settings; the next due occurrence is evaluated independently.",
  ].join("\n");
}

/**
 * Issue #222: truthful orchestrator-turn delivery-failure report. Delivery
 * is the admission for the orchestrator-turn destination, so an unavailable
 * host message channel never becomes a silently "delivered" occurrence:
 * nothing executed, nothing was queued as a subtask, and the turn was never
 * triggered.
 */
export function formatScheduledOrchestratorDeliveryFailure(
  entryId: string,
  entry: ScheduledTaskEntryConfig,
  dueAt: Date,
  message: string,
): string {
  return [
    `Scheduled task ${entryId} (${entry.name}) was due at ${dueTimeLabel(dueAt)} for cron "${entry.cron}", but its scheduled orchestrator turn could not be delivered to the existing agent:`,
    message,
    "The occurrence was NOT delivered: no model turn was triggered, no subtask was started, and nothing was queued or executed. Repair the delivery channel (or switch the entry to the subtask destination in /review-settings); the next due occurrence is evaluated independently.",
  ].join("\n");
}

/**
 * Issue #222: truthful report for an orchestrator turn whose send was
 * accepted but did not acknowledge within its bounded window. The outcome is
 * genuinely unknown — the host may still enqueue (or acknowledge) the turn —
 * so this never claims the turn was triggered, and it never claims it was
 * not: the owner is told exactly what is unknown and what to check, which is
 * what keeps a retry from dispatching a duplicate of a turn that may still
 * arrive. If the turn DOES arrive, the per-occurrence identity in its
 * details is observed by the host's message_start and only then tracked, so
 * it can never be counted on faith.
 */
export function formatScheduledOrchestratorDeliveryUncertain(
  entryId: string,
  entry: ScheduledTaskEntryConfig,
  dueAt: Date,
): string {
  return [
    `Scheduled task ${entryId} (${entry.name}) was due at ${dueTimeLabel(dueAt)} for cron "${entry.cron}" and its orchestrator-turn send was accepted by the host, but it did not acknowledge within its bounded delivery window.`,
    "Whether the host queued the turn is UNKNOWN: it may still arrive. This occurrence is NOT counted as executed, and no subtask was started by the scheduler. Should it arrive, the extension counts it only when the host's own message lifecycle shows this exact scheduled message was processed and its turn ended.",
    "Inspect the conversation before retrying; a manual retry could duplicate a turn that is still pending. The next due occurrence is evaluated independently.",
  ].join("\n");
}

/**
 * Deliver one scheduler owner event through the same steer-now lane the
 * controller uses for failure wakes (actionable in quiet and noisy modes).
 * Returns false when the host has no message channel so the caller falls back
 * to a plain notice — never a silent drop.
 */
export function deliverScheduledEvent(pi: unknown, content: string): boolean {
  const host = pi as {
    sendMessage?: (
      message: { customType: string; content: string; display: boolean; details?: Record<string, unknown> },
      delivery: { deliverAs: "steer"; triggerTurn: true },
    ) => void;
  } | null;
  if (!host || typeof host.sendMessage !== "function") return false;
  try {
    host.sendMessage(
      { customType: "pi-review-scheduled-task-event", content, display: true },
      { deliverAs: "steer", triggerTurn: true },
    );
    return true;
  } catch {
    return false;
  }
}
