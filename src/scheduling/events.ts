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
  kind: "execute" | "research";
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
