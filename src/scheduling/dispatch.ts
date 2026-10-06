/**
 * Issue #222: the per-entry schedule-destination dispatch route (moved here
 * from src/index.ts so both destinations are testable independently of the
 * extension entry point). The scheduler runtime (dispatcher.ts) admits one
 * due occurrence and calls the dispatched hook with the exact sampled due
 * minute; this layer routes it by the entry's destination:
 *
 * - "subtask" (default; absence means this): the existing isolated-subtask
 *   dispatch path through startScheduled, unchanged in kind/workspace/worker/
 *   review/one-unsettled-run-per-entry/quiet-noisy semantics, PLUS the shared
 *   non-model-initiated launch notice (issue #222, partial #215). The launch
 *   notice is delivered after a successful admission through the same shared
 *   abstraction a human /subtask-add rides, with its causal-ordering gate
 *   held by the controller so a fast completion can never precede the notice.
 * - "orchestrator-turn": delivery into the existing primary agent is the
 *   occurrence itself — no subprocess, no workspace override, and the
 *   occurrence completes when its initiating turn ends (host message_start
 *   observation of the occurrence's identity inside a run, followed by that
 *   run's end and a settlement). Later due occurrences are independent:
 *   nothing gates them on other work.
 *
 * Both destinations keep the existing in-process scheduler reporting exactly:
 * an overlap skip (subtask mode only) and an overdue drop are reported and
 * never catch up, and ordinary dispatch failures fail closed with an
 * actionable wake. Unsafe orchestrator admissions use console-only reporting
 * so the report itself cannot trigger model work on a host unable to arm it.
 */
import type { ScheduledTaskEntryConfig } from "../config";
import type { BackgroundInspection, ScheduledStartOptions } from "../execution/background-controller";
import type { BackgroundTaskDefinition } from "../execution/background-controller";
import type { BackgroundTaskKind } from "../execution/task-state";
import type { SubtaskLaunchNotice } from "../execution/launch-notice";
import { launchNoticeGate } from "../execution/launch-notice";
import {
  dueTimeLabel,
  formatScheduledDispatchFailure,
  formatScheduledOneShotPendingSkip,
  formatScheduledOrchestratorDeliveryFailure,
  formatScheduledOrchestratorDeliveryUncertain,
  formatScheduledOverdueDrop,
  formatScheduledSkipEvent,
  scheduledTaskDefinition,
} from "./events";
import { deliverScheduledOrchestratorTurn, type ScheduledOrchestratorTurnTracker } from "./orchestrator-turn";

export type ScheduledEntryDispatch = (
  entryId: string,
  entry: ScheduledTaskEntryConfig,
  dueAt: Date,
  overdue: boolean,
) => Promise<void>;

/**
 * Everything per-process the dispatcher needs, injected so src/index.ts keeps
 * only wiring. Ordinary failures fail closed through reportOwnerEvent — never
 * a silent success and never a duplicate dispatch attempt. An unsafe
 * orchestrator admission is the exception: its report is console-only because
 * the host may be unable to arm the model-facing wake itself.
 */
export interface ScheduledEntryDispatchHost {
  pi: unknown;
  /** Ordinary subtask dispatch surface (ExecutionToolManager, unchanged). */
  executionTools: {
    startScheduled(
      definition: BackgroundTaskDefinition,
      kind: BackgroundTaskKind,
      workspace: string | undefined,
      options: ScheduledStartOptions & { scheduledTaskId: string },
    ): Promise<BackgroundInspection>;
    scheduledRuns(scheduledTaskId: string): ReturnType<BackgroundInspectionHost["scheduledRuns"]>;
  };
  /** Owner wake for scheduler-only events (skip/overdue drop/failures), with honest fallback. */
  reportOwnerEvent(content: string): Promise<void>;
  /** Best-effort UI notice; must not throw. */
  uiNotice(message: string): Promise<void>;
  /** Best-effort console report; must not throw. */
  consoleWarn(message: string): void;
  /** Shared non-model-initiated launch-notice delivery; reports its honest, possibly-uncertain outcome. */
  deliverLaunchNotice(notice: SubtaskLaunchNotice): Promise<"delivered" | "unavailable" | "uncertain">;
  /** Managed scheduled-image asset verification, or a no-op (issue #26 contract). */
  checkScheduledImages(entry: ScheduledTaskEntryConfig): Promise<void>;
  /** Delivered orchestrator-turn occurrence lifecycle; attribution is host-message_start identity based. */
  orchestratorTurns: ScheduledOrchestratorTurnTracker;
  /**
   * Fail-closed orchestrator-turn admission guard: returns the exact reason
   * this host cannot safely deliver THIS occurrence (missing essential
   * run-lifecycle hooks, or a review gate blocked so the turn could never be
   * reviewed). Undefined only when the turn may run.
   */
  orchestratorTurnUnsafeReason(): string | undefined;
  /** Optional bound for the orchestrator send window (test seam; production default otherwise). */
  orchestratorDeliveryTimeoutMs?: number;
}

// Structural alias avoiding an import cycle with the execution manager.
interface BackgroundInspectionHost {
  scheduledRuns(scheduledTaskId: string): Array<{
    executionId: string;
    kind: BackgroundTaskKind;
    tasks: Array<{ taskId: string; title: string; state: string }>;
  }>;
}

export function createScheduledEntryDispatcher(host: ScheduledEntryDispatchHost): ScheduledEntryDispatch {
  return (entryId, entry, dueAt, overdue) => dispatchScheduledEntry(host, entryId, entry, dueAt, overdue);
}

async function dispatchScheduledEntry(
  host: ScheduledEntryDispatchHost,
  entryId: string,
  entry: ScheduledTaskEntryConfig,
  dueAt: Date,
  overdue: boolean,
): Promise<void> {
  if ((entry.destination ?? "subtask") !== "subtask") {
    await dispatchScheduledOrchestratorTurn(host, entryId, entry, dueAt, overdue);
    return;
  }
  const activeRuns = host.executionTools.scheduledRuns(entryId);
  if (activeRuns.length > 0) {
    await host.reportOwnerEvent(formatScheduledSkipEvent(entryId, entry, dueAt, activeRuns));
    return;
  }
  if (overdue) {
    // No catch-up: the due minute passed before this entry's previous
    // dispatch settled and no run is active — report the drop instead of
    // launching a late run. The next due occurrence is evaluated independently.
    await host.reportOwnerEvent(formatScheduledOverdueDrop(entryId, entry, dueAt));
    return;
  }
  // Fail closed on the entry's own workspace contract before anything is
  // started: config load and Save both require a non-empty workspace for
  // subtask entries, so this guard is defense in depth — an empty override
  // must never silently start a subtask against the orchestrator's own cwd.
  if (!entry.workspace?.trim()) {
    await host.reportOwnerEvent(formatScheduledDispatchFailure(entryId, entry, dueAt, "the entry has no workspace"));
    return;
  }
  // Fail closed for managed scheduled-image assets: an entry whose
  // instructions reference a managed image (see
  // src/settings/scheduled-image-assets.ts) that no longer exists is an
  // actionable dispatch failure through the existing wake — never a silent
  // run against a dead path. The check sits inside the try so the failure
  // uses the standard dispatch-failure report; overlap/overdue semantics
  // above are unchanged.
  let inspection: BackgroundInspection;
  let definition: BackgroundTaskDefinition;
  // Issue #222: launch-notice causal-ordering gate, resolved after the
  // shared notice delivery attempt no matter its outcome, so result
  // notifications are held at most until this admission's notice resolves.
  const gate = launchNoticeGate();
  try {
    await host.checkScheduledImages(entry);
    definition = scheduledTaskDefinition(entryId, entry);
    inspection = await host.executionTools.startScheduled(definition, entry.kind, entry.workspace, {
      scheduledTaskId: entryId,
      launchNoticeGate: gate.pending,
      ...(entry.workerResourceId !== undefined ? { workerResourceId: entry.workerResourceId } : {}),
      ...(entry.review !== undefined ? { reviewOverride: entry.review } : {}),
    });
  } catch (error) {
    gate.resolve(); // Nothing was admitted; no notification can be gated.
    const message = error instanceof Error ? error.message : String(error);
    await host.reportOwnerEvent(formatScheduledDispatchFailure(entryId, entry, dueAt, message));
    return;
  }
  // Issue #222: the model-facing launch notice is delivered FIRST and
  // independently of the UI notice — a rejecting or hanging UI notification
  // can never skip the required model wake. The gate resolves only after the
  // bounded delivery attempt has settled (or been reported failed), so a fast
  // completion cannot precede the notice and nothing is ever stranded.
  const failureBase = `review gate: scheduled task ${entryId} (${entry.name}) dispatched as ${inspection.executionId}, but its launch notice could not be delivered; inspect that execution for its outcome`;
  let deliveryFailure: string | undefined;
  try {
    const outcome = await host.deliverLaunchNotice({
      origin: "scheduled",
      executionId: inspection.executionId,
      kind: entry.kind,
      tasks: [{ taskId: inspection.tasks[0]?.taskId ?? "unknown", title: definition.title }],
      scheduled: { entryId, entryName: entry.name, dueAt, cron: entry.cron },
    });
    if (outcome === "unavailable") {
      deliveryFailure = `${failureBase}: the model channel was unavailable or the send was rejected`;
    } else if (outcome === "uncertain") {
      deliveryFailure = `${failureBase}: the model send did not acknowledge within its bounded window; whether the notice was enqueued is UNKNOWN and it may still arrive`;
    }
  } catch (error) {
    deliveryFailure = `${failureBase} (${error instanceof Error ? error.message : String(error)})`;
  } finally {
    gate.resolve();
  }
  try {
    if (deliveryFailure !== undefined) host.consoleWarn(deliveryFailure);
  } catch {
    // Reporting must never take the dispatch down with it.
  }
  // A UI-notice failure after start() returned cannot turn a real execution
  // into a dispatch failure or suppress the model-facing notice above.
  try {
    await host.uiNotice(`review gate: scheduled task ${entryId} (${entry.name}) dispatched as ${inspection.executionId} (${entry.kind}); ordinary subtask notifications will report its outcome`);
  } catch {
    host.consoleWarn(`review gate: scheduled task ${entryId} dispatched as ${inspection.executionId}, but its start notice could not be delivered; inspect that execution for its outcome`);
  }
}

/**
 * Issue #222 orchestrator-turn destination (corrected lifecycle). Delivery is
 * the admission: the occurrence identity is registered BEFORE the send, the
 * review gate arms from the host's message_start for the scheduled custom
 * message (before its model request, idle run; shared window for a busy
 * queued run), and the occurrence completes only at a message_start-observed
 * consuming-run end followed by a settlement. Later due occurrences are
 * independent (no per-entry subtask overlap gate exists here — the existing
 * agent's own subtasks are theirs, not this entry's runs). Overdue
 * occurrences still follow the shared no-catch-up report. A host that cannot
 * arm/settle truthfully is rejected BEFORE any send, never allowed an
 * unreviewed turn.
 */
async function dispatchScheduledOrchestratorTurn(
  host: ScheduledEntryDispatchHost,
  entryId: string,
  entry: ScheduledTaskEntryConfig,
  dueAt: Date,
  overdue: boolean,
): Promise<void> {
  // Issue #306: a one-shot entry whose previous delivery is still pending
  // (queued behind a busy agent, in flight, or observed but unsettled) must
  // not accumulate a second queued execution. alreadyRun is still false —
  // only the actual in-run observation consumes — so this narrow guard keyed
  // to the tracker's existing pending occurrences is what keeps a busy
  // orchestrator from queueing several due minutes' worth of the same turn.
  // The existing delivery lifecycle releases it: definite non-delivery
  // discards the occurrence, settlement removes it, and a session reset
  // clears it. Recurring entries keep independent occurrences unchanged.
  if (entry.oneShot === true && host.orchestratorTurns.hasPendingOccurrence(entryId)) {
    const report = formatScheduledOneShotPendingSkip(entryId, entry, dueAt);
    if (host.orchestratorTurnUnsafeReason() !== undefined) {
      // A host that cannot safely arm a scheduled turn must not be woken
      // with one for the skip either: console-only, like the unsafe
      // rejection itself.
      try {
        host.consoleWarn(report);
      } catch {
        // Safety reporting must not turn a skipped dispatch into another path.
      }
    } else {
      await host.reportOwnerEvent(report);
    }
    return;
  }
  if (overdue) {
    await host.reportOwnerEvent(formatScheduledOverdueDrop(entryId, entry, dueAt));
    return;
  }
  // Fail closed for managed scheduled-image assets exactly like the subtask
  // path: the orchestrator turn carries the same instructions, so a missing
  // managed image must not be silently handed to the agent as a dead path.
  try {
    await host.checkScheduledImages(entry);
  } catch (error) {
    await host.reportOwnerEvent(formatScheduledOrchestratorDeliveryFailure(
      entryId,
      entry,
      dueAt,
      `the entry's instructions reference an unavailable managed image: ${error instanceof Error ? error.message : String(error)}`,
    ));
    return;
  }
  // Fail closed BEFORE anything is sent: a host whose lifecycle hooks are
  // unavailable can never arm review before a scheduled turn's model request
  // or attribute the occurrence truthfully, and a blocked review restart
  // cannot settle reviews. The unsafe turn is never delivered.
  const unsafeReason = host.orchestratorTurnUnsafeReason();
  if (unsafeReason !== undefined) {
    const report = formatScheduledOrchestratorDeliveryFailure(entryId, entry, dueAt, unsafeReason);
    // Do not route this limitation through reportOwnerEvent: its ordinary
    // scheduler wake is a triggerTurn custom message, which would itself start
    // unreviewed model work on precisely the host rejected above.
    try {
      host.consoleWarn(report);
    } catch {
      // Safety reporting must not turn a rejected dispatch into another path.
    }
    return;
  }
  // The occurrence identity is registered BEFORE the send: a host that
  // starts (or queues) the run synchronously and observes the custom message
  // on message_start while this dispatch is still in flight is attributed —
  // and the delivery can never count anything by itself.
  const sending = host.orchestratorTurns.beginOccurrence(
    {
      entryId,
      entryName: entry.name,
      cron: entry.cron,
      dueAt,
    },
    // #306: a one-shot entry's pending identity must survive tracker-capacity
    // eviction so the busy-queue guard and actual-start consumption keep
    // working no matter how much recurring traffic intervenes.
    { oneShot: entry.oneShot === true },
  );
  const outcome = await deliverScheduledOrchestratorTurn(host.pi, {
    entryId,
    entryName: entry.name,
    cron: entry.cron,
    instructions: entry.instructions,
    dueAt,
    dueLabel: dueTimeLabel(dueAt),
    sending,
  }, host.orchestratorDeliveryTimeoutMs !== undefined ? { timeoutMs: host.orchestratorDeliveryTimeoutMs } : undefined);
  if (outcome === "uncertain") {
    // The send was accepted but never acknowledged (nor observed on
    // message_start) within its bound: the turn MAY still arrive. Never
    // claim delivery or execution; the registered occurrence stays pending
    // and can only ever be completed by the tracker's own
    // message_start → settlement evidence for this exact message. The report
    // keeps a manual retry from dispatching a duplicate.
    await host.reportOwnerEvent(formatScheduledOrchestratorDeliveryUncertain(entryId, entry, dueAt));
    return;
  }
  if (outcome === "unavailable") {
    // The send never happened or was definitively rejected: the unobserved
    // sending was discarded, so nothing can later be counted as executed.
    await host.reportOwnerEvent(formatScheduledOrchestratorDeliveryFailure(
      entryId,
      entry,
      dueAt,
      "the host has no model message channel, or the delivery was definitively rejected",
    ));
    return;
  }
  // Best-effort UI notice; visibility only, never a completion or failure claim.
  try {
    await host.uiNotice(`review gate: scheduled task ${entryId} (${entry.name}) delivered as an orchestrator turn; the occurrence completes when its initiating turn ends`);
  } catch {
    host.consoleWarn(`review gate: scheduled task ${entryId} was delivered as an orchestrator turn, but its start notice could not be delivered`);
  }
}