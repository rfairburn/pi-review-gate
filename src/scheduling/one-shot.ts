/**
 * Issue #306: one-shot scheduled-task consumption. A one-shot entry's single
 * execution is consumed exactly once, at its ACTUAL execution start — the
 * subtask destination's transport-boundary dispatch record (the existing
 * SubtaskDispatchRecord seam) or the orchestrator destination's in-run
 * message_start observation. Queueing, admission, overlap skips, overdue
 * drops, and pre-start failures never consume; refusal, failure, review, and
 * model outcomes after start never un-consume.
 *
 * Consumption has two effects: immediate live eligibility (the in-memory
 * catalog the scheduler samples gains alreadyRun=true now) and a targeted
 * durable record through the shared serialized config-write boundary (only
 * this entry's alreadyRun field; every other stored field and foreign entry
 * survives verbatim). A persistence failure is reported honestly — never
 * claimed as recorded — while the in-memory state keeps this process from
 * re-dispatching an execution that already started.
 */
import type { ReviewGateConfig } from "../config";
import { updateReviewGateConfig } from "../settings/persistence";

export interface OneShotConsumeOptions {
  /** The live in-memory config (the scheduler's catalog source). */
  config: ReviewGateConfig;
  /** The persistent config file path; absent when no file is loaded. */
  configPath?: string;
  /** Honest reporting for persistence failures; must not throw. */
  reportError?: (message: string) => void;
}

/**
 * Consume the one-shot entry's single execution now that it actually started.
 * No-op unless the LIVE entry is one-shot and not yet run: recurring and
 * removed entries are never touched, and duplicate observations are idempotent.
 * Disabling scheduling does not undo an execution that already started.
 */
export function consumeOneShotExecution(entryId: string, options: OneShotConsumeOptions): void {
  const entry = options.config.scheduledTasks?.[entryId];
  if (entry === undefined || entry.oneShot !== true || entry.alreadyRun === true) return;
  // Immediate live eligibility: the runtime samples this same in-memory
  // catalog, so no further due occurrence of this entry is admitted.
  entry.alreadyRun = true;
  if (options.configPath === undefined) {
    options.reportError?.(
      `review gate: scheduled task ${entryId} started its one-shot execution, but no persistent config file is loaded, so alreadyRun could not be durably recorded`,
    );
    return;
  }
  const path = options.configPath;
  void updateReviewGateConfig(path, (parsed) => {
    // Re-check the LIVE state at write time: a manual re-arm or entry removal
    // between the consumption and this serialized write wins — the durable
    // record must not resurrect a flag the user explicitly cleared.
    const live = options.config.scheduledTasks?.[entryId];
    if (live === undefined || live.oneShot !== true || live.alreadyRun !== true) return;
    // Targeted write against the LATEST disk state: record only when the
    // stored entry is still one-shot and not yet run. The live-state check
    // above preserves a re-arm installed in this process; a stored removal
    // or switch out of one-shot mode is also left untouched. Other processes
    // retain the existing config reload and write-order visibility semantics.
    const tasks = isRecord(parsed.scheduledTasks) ? parsed.scheduledTasks : undefined;
    const stored = tasks === undefined ? undefined : isRecord(tasks[entryId]) ? tasks[entryId] : undefined;
    if (stored === undefined || stored.oneShot !== true || stored.alreadyRun === true) return;
    stored.alreadyRun = true;
  }).catch((error: unknown) => {
    options.reportError?.(
      `review gate: scheduled task ${entryId} started its one-shot execution, but recording alreadyRun in the config file failed: ${messageOf(error)}`,
    );
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
