/**
 * In-place-kind task lifecycle runners, extracted verbatim from the
 * background controller (#237). An in-place task writes directly inside its
 * selected workspace — no wave capture, candidate, landing, or rollbacks —
 * and needs no conflict-gate or parent-checkpoint authority: it receives only
 * the narrow lifecycle capabilities it uses. The durable artifact directory
 * stays controller-owned (the execution root's artifacts tree, outside the
 * workspace) and is passed in as a projection so the authoritative derivation
 * has one home.
 *
 * The controller keeps admission, dispatch, groups/task records (passed by
 * reference), runtimes/leases, save/steering tails, command transitions, and
 * fault-hook ownership; this module owns the in-place lifecycle sequencing
 * including its own progress pipeline (dispatch capture → transition →
 * activity → identity → save → persisted-snapshot sync → wake → indicator)
 * with its exact persistence-failure disclosure.
 */
import type { ExecutorPoolAssignment, ExecutorPoolLease } from "./executor-pool";
import type { BackgroundExecutionGroup } from "./background-group-store";
import {
  isStoppedForExit,
  transitionTaskState,
  type BackgroundTaskRecord,
} from "./task-state";
import { stateTransitionNotice } from "./subtask-notifications";
import { runInplaceLifecycle, type InPlaceLifecycleResult, type InPlaceLifecycleStatus } from "./inplace-worker";
import type { WaveResult, WaveTaskResult } from "./wave-controller";
import {
  applyExecutorIdentity,
  synchronizeEventSnapshot,
  transitionEventSnapshot,
} from "./task-lifecycle-helpers";
import type {
  LifecycleActivity,
  LifecycleConfig,
  LifecycleDispatch,
  LifecycleExecutor,
  LifecycleIndicator,
  LifecycleLiveControl,
  LifecycleNotify,
  LifecyclePersistence,
  LifecycleSteering,
  LifecycleWake,
} from "./task-lifecycle-services";

/**
 * Narrow in-place-runner dependencies. All capabilities are live
 * controller-backed projections; no per-kind mutable state is held here.
 */
export interface InPlaceLifecycleDeps {
  persistence: LifecyclePersistence;
  notify: LifecycleNotify;
  wake: LifecycleWake;
  activity: LifecycleActivity;
  dispatch: LifecycleDispatch;
  indicator: LifecycleIndicator;
  config: Pick<LifecycleConfig, "forGroup" | "scopedModels">;
  executor: Pick<LifecycleExecutor, "acquireAfterRoute" | "routeOf">;
  steering: Pick<LifecycleSteering, "prestart" | "continuation" | "claimDeferred" | "failUndelivered" | "acknowledgeInterrupt" | "flushQueued">;
  live: Pick<LifecycleLiveControl, "runtime">;
  /** The controller's authoritative durable artifact directory for this task. */
  artifactDir(group: BackgroundExecutionGroup, task: BackgroundTaskRecord): string;
}

export async function runInPlaceTaskFresh(
  group: BackgroundExecutionGroup,
  task: BackgroundTaskRecord,
  abort: AbortController,
  lease: ExecutorPoolLease,
  deps: InPlaceLifecycleDeps,
): Promise<void> {
  await deps.steering.prestart(group, task);
  task.generation += 1;
  const priorState = transitionTaskState(task, "running");
  deps.activity.add(task, "running", `In-place worker starting in ${group.cwd}: writes go directly to that workspace; there is no wave capture, candidate, or landing.`);
  await deps.persistence.save(group);
  const activation = stateTransitionNotice(task, priorState, task.state);
  if (activation) await deps.wake.wake(task, "state", activation);
  const artifactDir = deps.artifactDir(group, task);
  const result = await runInPlaceTaskWorker(group, task, abort, lease, artifactDir, false, deps, undefined);
  await finishInPlaceTask(group, task, result, artifactDir, deps);
}

export async function runInPlaceTaskContinuation(
  group: BackgroundExecutionGroup,
  task: BackgroundTaskRecord,
  abort: AbortController,
  lease: ExecutorPoolLease,
  deps: InPlaceLifecycleDeps,
): Promise<void> {
  const pending = task.pendingContinuation;
  if (!pending) throw new Error("In-place continuation was interrupted before executor dispatch.");
  pending.instructions = await deps.steering.continuation(group, task, pending.instructions);
  const command = task.commands.find((candidate) => candidate.instructionId === pending.instructionId);
  // An interrupt during preprocessing terminalizes the queued continuation
  // and clears pendingContinuation; never dispatch a failed continuation.
  if (!command || task.pendingContinuation !== pending || command.status !== "queued") {
    throw new Error("In-place continuation was interrupted before executor dispatch.");
  }
  task.pendingContinuation = undefined;
  task.generation += 1;
  const previous = transitionTaskState(task, "running");
  command.status = "delivered";
  command.deliveredAt = new Date().toISOString();
  deps.activity.add(task, "running", `Continuing in place in ${group.cwd} (${pending.instructionId}); prior writes remain and are not rolled back.`);
  await deps.persistence.save(group);
  const activation = stateTransitionNotice(task, previous, task.state);
  if (activation) await deps.wake.wake(task, "state", activation);
  try {
    const artifactDir = deps.artifactDir(group, task);
    const result = await runInPlaceTaskWorker(
      group,
      task,
      abort,
      lease,
      artifactDir,
      true,
      deps,
      pending.instructions,
    );
    command.status = "acknowledged";
    command.acknowledgedAt = new Date().toISOString();
    await finishInPlaceTask(group, task, result, artifactDir, deps);
  } catch (error) {
    command.status = "failed";
    command.error = messageOf(error);
    throw error;
  }
}

/** Drive one full in-place lifecycle (turns, review, correction) for one task. */
async function runInPlaceTaskWorker(
  group: BackgroundExecutionGroup,
  task: BackgroundTaskRecord,
  abort: AbortController,
  lease: ExecutorPoolLease,
  artifactDir: string,
  continuation: boolean,
  deps: InPlaceLifecycleDeps,
  feedback?: string,
): Promise<InPlaceLifecycleResult> {
  let currentLease = lease;
  try {
    return await runInplaceLifecycle({
      taskId: task.taskId,
      task: task.definition,
      workspaceRoot: group.cwd,
      artifactDir,
      config: deps.config.forGroup(group),
      scopedModels: deps.config.scopedModels(),
      signal: abort.signal,
      executorAssignment: currentLease,
      acquireFailover: async (currentAssignment: ExecutorPoolAssignment) => {
        currentLease.release();
        const next = await deps.executor.acquireAfterRoute(
          currentAssignment,
          () => deps.executor.routeOf(group),
          abort.signal,
        );
        if (next) currentLease = next;
        return next;
      },
      onLiveControl: (control) => {
        const runtime = deps.live.runtime(task.taskId);
        if (!runtime) return;
        runtime.control = control;
        runtime.controlStatus = control ? "registered" : "closed";
        if (control) void deps.steering.flushQueued(group, task, runtime, control).catch((error) => {
          void deps.notify(`review gate: queued in-place steering delivery failed: ${messageOf(error)}`);
        });
      },
      takeDeferredSteering: () => deps.steering.claimDeferred(group, task),
      onUpdate: (update) => inPlaceProgress(group, task, update, deps),
      ...(continuation ? {
        initialResult: task.inplaceResult,
        continuation: { instructions: feedback ?? "" },
      } : {}),
    });
  } finally {
    currentLease.release();
  }
}

export function inPlaceProgress(
  group: BackgroundExecutionGroup,
  task: BackgroundTaskRecord,
  update: import("./types").SubtaskProgressUpdate,
  deps: InPlaceLifecycleDeps,
): void {
  const isDispatchCapture = Boolean(
    update.dispatch
    && (update.subtaskId === undefined || update.subtaskId === task.taskId),
  );
  const next = isDispatchCapture
    ? undefined
    : update.phase === "reviewing"
      ? "reviewing"
      : ["starting", "executing", "correcting", "confirming", "completing"].includes(update.phase)
        ? "running"
        : undefined;
  const previous = next ? transitionTaskState(task, next) : task.state;
  deps.activity.add(task, `inplace:${update.phase}`, update.message);
  applyExecutorIdentity(task, update as import("./types").SubtaskProgressUpdate);
  if (isDispatchCapture && update.dispatch) {
    deps.dispatch.record(group, task, update.dispatch);
  }
  const saved = deps.persistence.save(group);
  void saved.catch((error) => deps.notify(`review gate: failed to persist in-place progress: ${messageOf(error)}`));
  const transition = next ? stateTransitionNotice(task, previous, next) : undefined;
  const snapshot = transition ? transitionEventSnapshot(group, task) : undefined;
  if (transition) void saved.then((persisted) => {
    synchronizeEventSnapshot(snapshot!, persisted);
    return deps.wake.wake(task, "state", transition, snapshot);
  }).catch(() => undefined);
  deps.indicator.update();
}

/** Settle one in-place task from its lifecycle result. No landing ever happens. */
export async function finishInPlaceTask(
  group: BackgroundExecutionGroup,
  task: BackgroundTaskRecord,
  result: InPlaceLifecycleResult,
  artifactDir: string,
  deps: InPlaceLifecycleDeps,
): Promise<void> {
  task.inplaceResult = {
    status: result.status === "cancelled" ? "cancelled" : result.status === "timeout" ? "timeout" : result.status === "executor_error" || result.status === "review_error" ? "executor_error" : "completed",
    taskId: task.taskId,
    title: task.definition.title,
    summary: result.summary,
    session: result.session,
    adapter: result.adapter,
    model: result.model,
    usage: result.usage,
    error: result.error,
    operationRecord: result.operationRecord,
    incidents: result.incidents ?? [],
    attempts: result.attempts ?? 0,
    lastExecutorTurn: result.lastExecutorTurn,
  };
  task.bundle = undefined;
  const undelivered = deps.steering.failUndelivered(task, "The in-place task ended before queued steering reached a verified transport.");
  // #220/PR226: model-facing completion prose is concise positive fact —
  // the recorded delta and the observed external paths as separate named
  // categories plus the actual review disposition. The full baseline,
  // observation evidence, limits, and review context stay durable in
  // result.json, the review cycle records, and the reviewer request.
  if (isStoppedForExit(task)) {
    task.summary = "In-place worker stopped for application shutdown; inspect the workspace and continue after restore.";
    task.updatedAt = new Date().toISOString();
    await deps.persistence.save(group);
    await deps.persistence.publishAssociations();
    return;
  }
  if (result.status === "reviewed" || result.status === "unreviewed" || result.status === "no_changes") {
    task.result = synthesizeInPlaceWaveResult(group, task, result, artifactDir);
    const completionLines = buildInPlaceCompletionLines(result);
    task.summary = completionLines.join("\n");
    task.report = result.summary;
    task.error = undefined;
    transitionTaskState(task, "reported");
    const snapshot = transitionEventSnapshot(group, task);
    const persisted = await deps.persistence.save(group);
    await deps.persistence.publishAssociations();
    synchronizeEventSnapshot(snapshot, persisted);
    const verdictLine = completionLines.join("\n");
    await deps.wake.wake(task, undelivered.length > 0 ? "failure" : "completion", undelivered.length > 0
      ? `${verdictLine}\n${undelivered.length} queued steering instruction(s) were not applied.`
      : verdictLine);
    deps.indicator.update();
    return;
  }
  if (result.status === "cancelled" || task.interruptionMode) {
    transitionTaskState(task, "interrupted");
    const externalLine = inPlaceExternalLine(result);
    task.summary = [
      `In-place worker was interrupted in ${result.workspaceRoot}; prior writes remain and were not rolled back.`,
      inPlaceChangedLine(result),
      ...(externalLine ? [externalLine] : []),
      ...inPlaceLimitLines(result),
    ].join("\n");
    await deps.steering.acknowledgeInterrupt(task);
  } else {
    transitionTaskState(task, "paused_recoverable");
    task.error = inPlaceFailureError(undelivered.length, result);
    const externalLine = inPlaceExternalLine(result);
    task.summary = [
      `In-place task ${task.taskId} stopped before settlement (${result.status}).`,
      inPlaceChangedLine(result),
      ...(externalLine ? [externalLine] : []),
      ...inPlaceLimitLines(result),
    ].join("\n");
    await deps.wake.wake(task, "failure", `In-place task ${task.taskId} stopped before settlement (${result.status}).`);
  }
  task.updatedAt = new Date().toISOString();
  await deps.persistence.save(group);
  await deps.persistence.publishAssociations();
  deps.indicator.update();
}

/**
 * #220: synthesize the task's result view for an in-place settlement. There
 * is no wave capture or landing, so the result names the in-place source and
 * carries no landing outcome at all. Review cycle identity stays in the
 * artifact records (commit-identity fields are never invented here); the
 * settled verdict and reviewer evidence travel through the review report.
 */
function synthesizeInPlaceWaveResult(
  group: BackgroundExecutionGroup,
  task: BackgroundTaskRecord,
  result: InPlaceLifecycleResult,
  artifactDir: string,
): WaveResult {
  const status = statusMapping(result.status);
  return {
    waveId: `inplace-${group.executionId}`,
    waveRoot: group.root,
    sourceRoot: result.workspaceRoot,
    phase: "completed",
    taskResults: [{
      taskId: task.taskId,
      title: task.definition.title,
      status,
      summary: result.summary,
      error: result.error,
      unreviewed: result.status === "unreviewed",
      reviewReport: result.reviewReport,
      operationRecord: result.operationRecord,
      diagnostics: result.diagnostics,
      incidents: result.incidents,
      attempts: result.attempts,
      artifactDir,
      taskDefinition: task.definition,
    }],
  };
}

// ── #220/PR226: bounded, named in-place completion reporting ────────────────

/** Maximum number of paths named in one model-facing in-place completion line. */
export const INPLACE_COMPLETION_MAX_NAMED_PATHS = 10;

/** Bounded "status path" list for the recorded workspace delta since launch. */
export function formatInPlaceChangedPaths(changes: Array<{ status: string; path: string }>): string {
  if (changes.length === 0) return "no recorded workspace changes";
  const shown = changes.slice(0, INPLACE_COMPLETION_MAX_NAMED_PATHS);
  const more = changes.length - shown.length;
  const text = shown.map((change) => `${change.status} ${change.path}`).join(", ");
  return more > 0 ? `${text} (+${more} more)` : text;
}

/** Bounded list of observed external paths, or undefined when none were observed. */
export function formatInPlaceExternalPaths(paths: string[] | undefined): string | undefined {
  if (!paths || paths.length === 0) return undefined;
  const shown = paths.slice(0, INPLACE_COMPLETION_MAX_NAMED_PATHS);
  const more = paths.length - shown.length;
  const overflow = more > 0 ? ` (+${more} more)` : "";
  return `${shown.join(", ")}${overflow}`;
}

/**
 * The review disposition a settled in-place task actually has, derived from the
 * lifecycle result and its official review report/cycles — never invented. A
 * passing aggregate with partial reviewer failure keeps its warning; a no-delta
 * settlement after earlier cycles names those verdicts instead of claiming the
 * final state passed or that no review occurred.
 */
export function inPlaceReviewDisposition(result: {
  status: InPlaceLifecycleStatus;
  reviewReport?: InPlaceLifecycleResult["reviewReport"];
  reviewCycles: InPlaceLifecycleResult["reviewCycles"];
}): string {
  switch (result.status) {
    case "reviewed":
      return result.reviewReport?.aggregate === "pass_with_warnings"
        ? "passed with reviewer infrastructure warnings"
        : "passed";
    case "unreviewed": return "disabled";
    case "no_changes": {
      if (result.reviewCycles.length === 0) return "not run";
      const verdicts = [...new Set(result.reviewCycles.map((cycle) => cycle.verdict))].join(", ");
      return `not run on the final empty delta (earlier cycle verdicts: ${verdicts})`;
    }
    default: return result.status;
  }
}

/** Short factual limit lines for in-place completion prose; empty when no limits apply. */
export function inPlaceLimitLines(result: {
  toolObservationsTruncated?: boolean;
  baseline?: InPlaceLifecycleResult["baseline"];
}): string[] {
  const lines: string[] = [];
  if (result.toolObservationsTruncated === true) lines.push("Tool-event observations truncated.");
  const snapshot = result.baseline?.snapshot;
  const omissions = snapshot?.omissions.length ?? 0;
  if (omissions > 0) {
    lines.push(`Snapshot omissions recorded: ${omissions}${snapshot?.omissionsTruncated ? " (omission list truncated)" : ""}`);
  }
  return lines;
}

/**
 * The concise failure diagnostic for a stopped in-place task: the actual
 * lifecycle failure reason plus the undelivered-steering count, when both exist.
 */
export function inPlaceFailureError(undeliveredCount: number, result: {
  status: InPlaceLifecycleStatus;
  error?: string;
  summary: string;
}): string | undefined {
  const parts: string[] = [];
  if (undeliveredCount > 0) parts.push(`${undeliveredCount} queued steering instruction(s) were not applied.`);
  const reason = result.error ?? result.summary;
  if (reason) parts.push(reason);
  return parts.length > 0 ? parts.join("; ") : undefined;
}

/** The recorded-delta line for model-facing in-place prose. */
export function inPlaceChangedLine(result: {
  attributionError?: string;
  changedSinceLaunch: Array<{ status: string; path: string }>;
}): string {
  return `Workspace changes since launch: ${result.attributionError
    ? `could not be verified (${result.attributionError})`
    : formatInPlaceChangedPaths(result.changedSinceLaunch)}`;
}

/** The separate external-path category line, or undefined when nothing was observed. */
export function inPlaceExternalLine(result: {
  observedExternalPaths?: string[];
}): string | undefined {
  const text = formatInPlaceExternalPaths(result.observedExternalPaths);
  return text !== undefined ? `Additional observed paths outside workspace: ${text}` : undefined;
}

/**
 * The concise factual completion lines for a settled in-place task (#220/PR226):
 * identity/workspace plus the actual review disposition, then the recorded
 * delta and the observed external paths as separate named categories. No
 * rollback/attribution/observability narrative; the detailed evidence stays
 * durable in result.json, the review cycle records, and the reviewer request.
 */
export function buildInPlaceCompletionLines(result: InPlaceLifecycleResult): string[] {
  const externalLine = inPlaceExternalLine(result);
  return [
    `In-place task ${result.taskId} finished in place in ${result.workspaceRoot}. Review: ${inPlaceReviewDisposition(result)}.`,
    inPlaceChangedLine(result),
    ...(externalLine ? [externalLine] : []),
    ...inPlaceLimitLines(result),
  ];
}

/** In-place lifecycle status expressed through the shared task-result status vocabulary. */
function statusMapping(status: InPlaceLifecycleResult["status"]): WaveTaskResult["status"] {
  switch (status) {
    case "reviewed": return "accepted";
    case "unreviewed": return "completed_unreviewed";
    case "no_changes": return "no_changes";
    case "review_error": return "review_error";
    case "correction_cap": return "correction_cap";
    case "executor_error": return "executor_error";
    case "timeout": return "timeout";
    case "cancelled": return "cancelled";
    case "reviewer_blocked": return "reviewer_blocked";
  }
}


function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
