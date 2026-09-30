/**
 * Wave (execute-kind) task lifecycle runners, extracted verbatim from the
 * background controller (#237). A wave task captures an independent base,
 * runs its worker, and lands into the source workspace (finding-13 kept: the
 * force-merge/mark-clean transactions remain in the controller). The runner
 * consumes the one authoritative parent-checkpoint ledger plus the narrow
 * lifecycle capabilities the wave lifecycle uses — landing-gate control and
 * tolerated landed bookkeeping included, admission and durable state excluded
 * (those never leave the controller).
 *
 * The controller keeps admission, dispatch, groups/task records (passed by
 * reference), runtimes/leases, save/steering tails, command transitions, gate
 * installation, and fault-hook ownership; this module owns the wave lifecycle
 * sequencing including its two progress pipelines, each verbatim with its own
 * save/error/activity/wake ordering (the continuation pipeline keeps its
 * swallowed persistence errors unchanged).
 */
import type { ExecutorPoolLease } from "./executor-pool";
import type { BackgroundExecutionGroup } from "./background-group-store";
import {
  isStoppedForExit,
  stateFromContinuationProgress,
  stateFromWaveProgress,
  transitionTaskState,
  type BackgroundTaskRecord,
  type BackgroundTaskState,
} from "./task-state";
import { stateTransitionNotice } from "./subtask-notifications";
import type { ContinuationProgressUpdate } from "./types";
import { type ConflictGate as BackgroundConflictGate } from "./conflict-gate-store";
import { executeWave, type WaveProgressUpdate } from "./wave-controller";
import { continueOperation } from "./operation-actions";
import { materializeLandingConflicts } from "./conflict-materialization";
import { createWorkspaceSnapshot } from "../capture";
import { activeExchangeBaseline, type ReviewGateState } from "../state";
import type { ParentCheckpointLedger } from "./parent-checkpoint-ledger";
import type { BackgroundFaultHooks } from "./background-controller";
import { landedReviewStatusOf, type LandedReviewStatus } from "./force-merge-salvage";
import {
  applyExecutorIdentity,
  applySettledExecutorIdentity,
  synchronizeEventSnapshot,
  transitionEventSnapshot,
} from "./task-lifecycle-helpers";
import type {
  LifecycleActivity,
  LifecycleBookkeeping,
  LifecycleConfig,
  LifecycleDispatch,
  LifecycleExecutor,
  LifecycleGates,
  LifecycleIndicator,
  LifecycleLiveControl,
  LifecycleNotify,
  LifecyclePersistence,
  LifecycleSteering,
  LifecycleWake,
  PersistedGroupRevision,
} from "./task-lifecycle-services";

/**
 * Narrow wave-runner dependencies: the common capabilities plus the
 * wave-only authority — the parent-checkpoint ledger object, landing-gate
 * control, tolerated post-landing bookkeeping, the live review state
 * projection, and the landing-conflict fault hook. No controller map is
 * exposed; groups/task records arrive by reference.
 */
export interface WaveLifecycleDeps {
  persistence: LifecyclePersistence;
  notify: LifecycleNotify;
  wake: LifecycleWake;
  activity: LifecycleActivity;
  dispatch: LifecycleDispatch;
  indicator: LifecycleIndicator;
  config: Pick<LifecycleConfig, "base" | "forGroup" | "scopedModels">;
  executor: Pick<LifecycleExecutor, "pool">;
  steering: Pick<LifecycleSteering, "prestart" | "continuation" | "claimDeferred" | "failUndelivered" | "acknowledgeInterrupt" | "flushQueued">;
  live: Pick<LifecycleLiveControl, "runtime">;
  gates: LifecycleGates;
  bookkeeping: LifecycleBookkeeping;
  /** The one authoritative parent-checkpoint ledger (guards, selective checkpointing). */
  ledger: ParentCheckpointLedger;
  /** Live review state projection (window id / baseline reads at the same points). */
  state(): ReviewGateState;
  /** Deterministic landing-conflict fault hook, read live at each use. */
  faults(): Pick<BackgroundFaultHooks, "materializeLandingConflicts"> | undefined;
}

export async function runWaveTaskFresh(
  group: BackgroundExecutionGroup,
  task: BackgroundTaskRecord,
  abort: AbortController,
  lease: ExecutorPoolLease,
  deps: WaveLifecycleDeps,
): Promise<void> {
  const reviewWindowId = deps.state().reviewWindow?.id;
  const parentBaseline = activeExchangeBaseline(deps.state());
  const snapshotBaseline = parentBaseline?.kind === "snapshot" ? parentBaseline.snapshot : undefined;
  const preTaskSnapshot = parentBaseline?.kind === "checkpoint" ? await deps.ledger.preTaskParentChanges(group.cwd)
    : snapshotBaseline ? await createWorkspaceSnapshot(group.cwd, {
    maxFileBytes: deps.config.base().maxFileBytes,
    maxSnapshotBytes: deps.config.base().maxSnapshotBytes,
    reuseUnchangedFrom: snapshotBaseline,
  }) : undefined;
  let landingGuard = preTaskSnapshot;
  await deps.steering.prestart(group, task);
  task.generation += 1;
  const priorState = transitionTaskState(task, "capturing");
  deps.activity.add(task, "capturing", "Capturing an independent task base from current main.");
  await deps.persistence.save(group);
  const activation = stateTransitionNotice(task, priorState, task.state);
  if (activation) await deps.wake.wake(task, "state", activation);

  const result = await executeWave({
    cwd: group.cwd,
    tasks: [task.definition],
    taskIds: [task.taskId],
    config: deps.config.forGroup(group),
    scopedModels: deps.config.scopedModels(),
    maxWorkers: 1,
    independentLanding: true,
    signal: abort.signal,
    executorPool: deps.executor.pool(),
    initialExecutorLeases: [lease],
    onWaveCreated: async (waveRoot) => {
      task.waveRoot = waveRoot;
      await deps.persistence.save(group);
      await deps.persistence.publishAssociations();
    },
    onWorkersSettled: async (result) => {
      task.result = result;
      task.bundle = result.taskResults[0]?.bundle;
      task.summary = result.taskResults[0]?.summary;
      await deps.persistence.save(group);
      await deps.persistence.publishAssociations();
      // The wave owns subsequent planning/clean landing; this is its last
      // awaited controller callback before that path. The landing planner
      // rejects a concurrently changed file as a whole (even disjoint
      // lines), while its conflict callback refreshes again before writes.
      landingGuard = await deps.ledger.landingParentGuard(group.cwd, preTaskSnapshot) ?? (preTaskSnapshot instanceof Map ? undefined : preTaskSnapshot);
    },
    onProgress: (update) => waveProgress(group, task, update, deps),
    onLiveControl: (_taskId, control) => {
      const runtime = deps.live.runtime(task.taskId);
      if (!runtime) return;
      runtime.control = control;
      runtime.controlStatus = control ? "registered" : "closed";
      if (control) void deps.steering.flushQueued(group, task, runtime, control).catch((error) => {
        void deps.notify(`review gate: queued steering delivery failed: ${messageOf(error)}`);
      });
    },
    takeDeferredSteering: () => deps.steering.claimDeferred(group, task),
    onLandingConflict: async ({ capture, plan }) => {
      await deps.faults()?.materializeLandingConflicts?.({ executionId: group.executionId, taskId: task.taskId, taskState: task.state });
      // Ordinary reviewed landing keeps the pre-#126 contract: every conflict
      // that cannot carry text markers refuses the whole transfer before any
      // mutation (materializeLandingConflicts throws). Only ordinary text
      // conflicts reach here and are materialized as diff3 markers in the
      // source workspace.
      landingGuard = await deps.ledger.landingParentGuard(group.cwd, preTaskSnapshot) ?? (preTaskSnapshot instanceof Map ? undefined : preTaskSnapshot);
      const materialized = await materializeLandingConflicts(capture, plan, `subtask ${task.taskId}`);
      await deps.ledger.checkpointParent(reviewWindowId, parentBaseline, landingGuard, group.cwd, materialized.appliedPaths, { executionId: group.executionId, taskId: task.taskId }, landedReviewStatus(task));
      const conflictGate: BackgroundConflictGate = {
        executionId: group.executionId,
        taskId: task.taskId,
        sourceRoot: group.cwd,
        paths: materialized.paths,
        activatedAt: new Date().toISOString(),
        manifestPath: materialized.manifestPath,
        reason: `Task ${task.taskId} requires immediate conflict resolution.`,
      };
      deps.gates.install(conflictGate);
      transitionTaskState(task, "conflicted");
      deps.activity.add(task, "conflicted", `Conflicts materialized in ${materialized.paths.join(", ")}.`);
      await deps.persistence.save(group);
      await deps.persistence.publishAssociations();
      await deps.wake.wake(task, "failure", deps.gates.criticalPrompt(conflictGate)!);
      return { materialized: true };
    },
  });
  task.result = result;
  await applySettledExecutorIdentity(task);
  const undeliveredSteering = deps.steering.failUndelivered(task, "The executor turn ended before the queued steering instruction reached a verified transport.");
  const worker = result.taskResults[0];
  task.bundle = worker?.bundle;
  // #25 settlement race: markClean may have already landed this task while
  // executeWave settled; keep its validated-resolution summary instead of
  // letting the executor's own turn summary overwrite it.
  if (task.state !== "landed") task.summary = worker?.summary;
  task.error = worker?.error;
  if (isStoppedForExit(task) && result.landing?.status !== "landed") {
    task.summary = "Executor stopped for application shutdown; the durable checkpoint must be verified before resume.";
    task.updatedAt = new Date().toISOString();
    await deps.persistence.save(group);
    await deps.persistence.publishAssociations();
    return;
  }
  if (result.landing?.status === "landed") {
    const paths = [...(result.landing.appliedPaths ?? []), ...(result.landing.alreadyAppliedPaths ?? [])];
    // The source workspace was mutated successfully (finding 2): run the parent
    // checkpoint as tolerated bookkeeping (preserving the success-path ordering
    // where the checkpoint completes before the landed state becomes visible),
    // then transition to landed unconditionally — a checkpoint/save/publish/wake
    // failure can neither prevent nor reclassify the landing.
    await deps.bookkeeping.tolerate(task, "parent checkpoint", async () => {
      await deps.ledger.checkpointParent(reviewWindowId, parentBaseline, landingGuard, group.cwd, paths, { executionId: group.executionId, taskId: task.taskId }, landedReviewStatus(task));
    });
    transitionTaskState(task, "landed");
    const completionSnapshot = transitionEventSnapshot(group, task);
    deps.indicator.update();
    let persisted: PersistedGroupRevision | undefined;
    await deps.bookkeeping.tolerate(task, "durable save", async () => {
      persisted = await deps.persistence.save(group);
    });
    await deps.bookkeeping.tolerate(task, "association publish", () => deps.persistence.publishAssociations());
    if (persisted) synchronizeEventSnapshot(completionSnapshot, persisted);
    await deps.bookkeeping.tolerate(task, "completion wake", () =>
      deps.wake.wake(
        task,
        undeliveredSteering.length > 0 ? "failure" : "completion",
        undeliveredSteering.length > 0
          ? `Task ${task.taskId} landed, but ${undeliveredSteering.length} queued steering instruction(s) were not applied.`
          : `Task ${task.taskId} landed independently in the main workspace.`,
        completionSnapshot,
      ));
  } else if (result.landing?.status === "conflicted") {
    // #25 settlement race: markClean may have validated the materialized
    // conflict and landed this task while executeWave was still settling;
    // its gate is then already removed. Never regress that resolved landing
    // back to conflicted — the durable landed outcome stays authoritative.
    if (task.state !== "landed") {
      transitionTaskState(task, "conflicted");
      // #25 multi-target: this task's own gate, never another target's.
      const conflictGate = deps.gates.gateForTask(group.executionId, task.taskId);
      task.summary = conflictGate
        ? `Merge conflict requires immediate resolution: ${conflictGate.paths.join(", ")}.`
        : "Landing conflict could not be materialized automatically; inspect full diagnostics before modifying main.";
    }
  } else if (result.phase === "aborted") {
    transitionTaskState(task, task.interruptionMode ? "interrupted" : "paused_recoverable");
    task.summary = task.interruptionMode
      ? `Executor acknowledged ${task.interruptionMode}.`
      : "Executor stopped with a recoverable checkpoint.";
    await deps.steering.acknowledgeInterrupt(task);
  } else {
    transitionTaskState(task, worker?.bundle ? "paused_recoverable" : "failed");
    await deps.wake.wake(task, "failure", `Task ${task.taskId} failed: ${task.error ?? task.summary ?? "unknown failure"}`);
  }
  task.updatedAt = new Date().toISOString();
  if (task.state === "landed") {
    await deps.bookkeeping.tolerate(task, "durable save", async () => {
      await deps.persistence.save(group);
    });
    await deps.bookkeeping.tolerate(task, "association publish", () => deps.persistence.publishAssociations());
  } else {
    await deps.persistence.save(group);
    await deps.persistence.publishAssociations();
  }
  deps.indicator.update();
}

export async function runWaveTaskContinuation(
  group: BackgroundExecutionGroup,
  task: BackgroundTaskRecord,
  abort: AbortController,
  lease: ExecutorPoolLease,
  deps: WaveLifecycleDeps,
): Promise<void> {
  const reviewWindowId = deps.state().reviewWindow?.id;
  const parentBaseline = activeExchangeBaseline(deps.state());
  const snapshotBaseline = parentBaseline?.kind === "snapshot" ? parentBaseline.snapshot : undefined;
  const preTaskSnapshot = parentBaseline?.kind === "checkpoint" ? await deps.ledger.preTaskParentChanges(group.cwd)
    : snapshotBaseline ? await createWorkspaceSnapshot(group.cwd, {
    maxFileBytes: deps.config.base().maxFileBytes,
    maxSnapshotBytes: deps.config.base().maxSnapshotBytes,
    reuseUnchangedFrom: snapshotBaseline,
  }) : undefined;
  let landingGuard = preTaskSnapshot;
  const pending = task.pendingContinuation;
  if (!pending) throw new Error("Continuation was interrupted before executor dispatch.");
  pending.instructions = await deps.steering.continuation(group, task, pending.instructions);
  const command = task.commands.find((candidate) => candidate.instructionId === pending.instructionId);
  // An interrupt during preprocessing terminalizes the queued continuation
  // and clears pendingContinuation; never dispatch a failed continuation.
  if (!command || task.pendingContinuation !== pending || command.status !== "queued") {
    throw new Error("Continuation was interrupted before executor dispatch.");
  }
  task.pendingContinuation = undefined;
  task.generation += 1;
  const priorState = transitionTaskState(task, "running");
  command.status = "delivered";
  command.deliveredAt = new Date().toISOString();
  const inPlace = command.inPlace === true;
  deps.activity.add(task, "running", inPlace
    ? `Continuing in place in the retained worktree (${pending.instructionId}).`
    : `Continuing from durable checkpoint (${pending.instructionId}).`);
  await deps.persistence.save(group);
  const activation = stateTransitionNotice(task, priorState, task.state);
  if (activation) await deps.wake.wake(task, "state", activation);
  try {
    const result = await continueOperation({
      bundle: task.bundle!,
      instructions: pending.instructions,
      instructionId: pending.instructionId,
      ...(inPlace ? { inPlace: true } : {}),
      config: deps.config.forGroup(group),
      scopedModels: deps.config.scopedModels(),
      signal: abort.signal,
      executorAssignment: lease,
      executorPool: deps.executor.pool(),
      onLiveControl: (control) => {
        const runtime = deps.live.runtime(task.taskId);
        if (!runtime) return;
        runtime.control = control;
        runtime.controlStatus = control ? "registered" : "closed";
        if (control) void deps.steering.flushQueued(group, task, runtime, control).catch((error) => {
          void deps.notify(`review gate: queued steering delivery failed: ${messageOf(error)}`);
        });
      },
      takeDeferredSteering: () => deps.steering.claimDeferred(group, task),
      onWorkerSettled: async (lifecycle) => {
        task.bundle = lifecycle.bundle ?? task.bundle;
        task.result = {
          waveId: task.bundle!.waveId, waveRoot: task.waveRoot!, sourceRoot: group.cwd,
          phase: "working", taskResults: [{
            taskId: lifecycle.taskId, title: lifecycle.title, status: lifecycle.status,
            summary: lifecycle.summary, error: lifecycle.error,
            acceptedRef: lifecycle.acceptedRef, acceptedCommitSha: lifecycle.acceptedCommitSha,
            unreviewed: lifecycle.unreviewed, reviewReport: lifecycle.reviewReport,
            reviewCycles: lifecycle.reviewCycles.map(({ cycle, baseCommit, candidateCommit, candidateTreeSha, candidateRef, verdict }) =>
              ({ cycle, baseCommit, candidateCommit, candidateTreeSha, candidateRef, verdict })),
            bundle: lifecycle.bundle, checkpoint: lifecycle.checkpoint,
            operationRecord: lifecycle.operationRecord, diagnostics: lifecycle.diagnostics,
            incidents: lifecycle.incidents, attempts: lifecycle.attempts,
          }],
        };
        if (task.state !== "landed") task.summary = lifecycle.summary;
        await applySettledExecutorIdentity(task);
        await deps.persistence.save(group);
        await deps.persistence.publishAssociations();
        landingGuard = await deps.ledger.landingParentGuard(group.cwd, preTaskSnapshot) ?? (preTaskSnapshot instanceof Map ? undefined : preTaskSnapshot);
      },
      onLandingConflict: async ({ capture, plan }) => {
        await deps.faults()?.materializeLandingConflicts?.({ executionId: group.executionId, taskId: task.taskId, taskState: task.state });
        // Ordinary reviewed continuation landing keeps the pre-#126 contract:
        // unrepresentable conflicts refuse the whole transfer before any
        // mutation; only text conflicts are materialized here.
        landingGuard = await deps.ledger.landingParentGuard(group.cwd, preTaskSnapshot) ?? (preTaskSnapshot instanceof Map ? undefined : preTaskSnapshot);
        const materialized = await materializeLandingConflicts(capture, plan, `continued subtask ${task.taskId}`);
        await deps.ledger.checkpointParent(reviewWindowId, parentBaseline, landingGuard, group.cwd, materialized.appliedPaths, { executionId: group.executionId, taskId: task.taskId }, landedReviewStatus(task));
        const conflictGate = activateConflictGate(
          group, task, materialized.paths, materialized.manifestPath, deps,
          `Continued task ${task.taskId} requires immediate conflict resolution.`,
        );
        deps.activity.add(task, "conflicted", `Conflicts materialized in ${materialized.paths.join(", ")}.`);
        await deps.persistence.save(group);
        await deps.persistence.publishAssociations();
        await deps.wake.wake(task, "failure", deps.gates.criticalPrompt(conflictGate)!);
        return { materialized: true };
      },
      onUpdate: (update) => waveContinuationProgress(group, task, update, deps),
    });
    task.bundle = result.inspection.bundle;
    const undeliveredSteering = deps.steering.failUndelivered(task, "The continuation ended before the queued steering instruction reached a verified transport.");
    command.status = "acknowledged";
    command.acknowledgedAt = new Date().toISOString();
    if (isStoppedForExit(task) && result.landing?.status !== "landed") {
      task.summary = "Continued executor stopped for application shutdown; inspect its checkpoint after restore.";
      return;
    }
    if (result.landing?.status === "landed") {
      task.summary = "Continued task landed independently in the main workspace.";
      const paths = [...(result.landing.appliedPaths ?? []), ...(result.landing.alreadyAppliedPaths ?? [])];
      // The source workspace was mutated successfully (finding 2): run the
      // parent checkpoint as tolerated bookkeeping (preserving the success-path
      // ordering where the checkpoint completes before the landed state becomes
      // visible), then transition to landed unconditionally.
      await deps.bookkeeping.tolerate(task, "parent checkpoint", async () => {
        await deps.ledger.checkpointParent(reviewWindowId, parentBaseline, landingGuard, group.cwd, paths, { executionId: group.executionId, taskId: task.taskId }, landedReviewStatus(task));
      });
      transitionTaskState(task, "landed");
      const completionSnapshot = transitionEventSnapshot(group, task);
      deps.indicator.update();
      let persisted: PersistedGroupRevision | undefined;
      await deps.bookkeeping.tolerate(task, "durable save", async () => {
        persisted = await deps.persistence.save(group);
      });
      await deps.bookkeeping.tolerate(task, "association publish", () => deps.persistence.publishAssociations());
      if (persisted) synchronizeEventSnapshot(completionSnapshot, persisted);
      await deps.bookkeeping.tolerate(task, "completion wake", () =>
        deps.wake.wake(
          task,
          undeliveredSteering.length > 0 ? "failure" : "completion",
          undeliveredSteering.length > 0
            ? `Task ${task.taskId} continuation landed, but ${undeliveredSteering.length} queued steering instruction(s) were not applied.`
            : `Task ${task.taskId} continuation landed.`,
          completionSnapshot,
        ));
    } else if (result.landing?.status === "conflicted") {
      // Same settlement race as runFresh: never regress a task that markClean
      // already landed while the continuation was still settling.
      if (task.state !== "landed") {
        transitionTaskState(task, "conflicted");
        // #25 multi-target: this task's own gate, never another target's.
        const conflictGate = deps.gates.gateForTask(group.executionId, task.taskId);
        task.summary = conflictGate
          ? `Merge conflict requires immediate resolution: ${conflictGate.paths.join(", ")}.`
          : "Continuation landing conflict could not be materialized automatically; inspect full diagnostics.";
      }
    } else {
      transitionTaskState(task, result.lifecycle?.status === "cancelled" ? "interrupted" : "paused_recoverable");
      task.summary = result.lifecycle?.summary ?? result.inspection.record.state;
      task.error = result.lifecycle?.error;
      if (task.state !== "interrupted") await deps.wake.wake(task, "failure", `Task ${task.taskId} continuation stopped: ${task.error ?? task.summary}`);
    }
  } catch (error) {
    command.status = "failed";
    command.error = messageOf(error);
    throw error;
  } finally {
    task.updatedAt = new Date().toISOString();
    if (task.state === "landed") {
      await deps.bookkeeping.tolerate(task, "durable save", async () => {
        await deps.persistence.save(group);
      });
      await deps.bookkeeping.tolerate(task, "association publish", () => deps.persistence.publishAssociations());
    } else {
      await deps.persistence.save(group);
      await deps.persistence.publishAssociations();
    }
    deps.indicator.update();
  }
}

function activateConflictGate(
  group: BackgroundExecutionGroup,
  task: BackgroundTaskRecord,
  paths: string[],
  manifestPath: string,
  deps: WaveLifecycleDeps,
  reason: string,
): BackgroundConflictGate {
  // Ordinary reviewed landing never produces sidecars (unrepresentable
  // conflicts refuse before mutation), so no sidecar pairing is recorded.
  const gate: BackgroundConflictGate = {
    executionId: group.executionId,
    taskId: task.taskId,
    sourceRoot: group.cwd,
    paths,
    activatedAt: new Date().toISOString(),
    manifestPath,
    reason,
  };
  deps.gates.install(gate);
  transitionTaskState(task, "conflicted");
  return gate;
}

/** Settled-result review status for a wave landing checkpoint (#175). */
function landedReviewStatus(task: BackgroundTaskRecord): LandedReviewStatus {
  return landedReviewStatusOf(task.result?.taskResults[0]);
}

function waveProgress(group: BackgroundExecutionGroup, task: BackgroundTaskRecord, update: WaveProgressUpdate, deps: WaveLifecycleDeps): void {
  // #93: a dispatch capture is a provenance fact, not a lifecycle
  // transition. Adjacent progress events (starting/executing) already carry
  // the task state; letting the transport-boundary capture — which is the
  // LAST event of the dispatch sequence — drive a transition would regress
  // states set concurrently (for example an injected launch failure).
  const isDispatchCapture = Boolean(
    update.subtask?.dispatch
    && (update.subtask.subtaskId === undefined || update.subtask.subtaskId === task.taskId),
  );
  const next = isDispatchCapture ? undefined : stateFromWaveProgress(update);
  const previous = next ? transitionTaskState(task, next) : task.state;
  if (!next) task.updatedAt = new Date().toISOString();
  updateReviewStatus(task, update, next);
  for (const message of update.activity ?? [update.message]) deps.activity.add(task, update.phase, message);
  if (update.subtask) applyExecutorIdentity(task, update.subtask);
  // #93: actual transport-boundary dispatch capture drives the original
  // card update through the dispatch event path (no inspection needed).
  if (isDispatchCapture && update.subtask?.dispatch) {
    deps.dispatch.record(group, task, update.subtask.dispatch);
  }
  const saved = deps.persistence.save(group);
  void saved.catch((error) => deps.notify(`review gate: failed to persist task progress: ${messageOf(error)}`));
  const transition = next ? stateTransitionNotice(task, previous, next) : undefined;
  const snapshot = transition ? transitionEventSnapshot(group, task) : undefined;
  if (transition) void saved.then((persisted) => {
    synchronizeEventSnapshot(snapshot!, persisted);
    return deps.wake.wake(task, "state", transition, snapshot);
  }).catch(() => undefined);
  deps.indicator.update();
}

function waveContinuationProgress(group: BackgroundExecutionGroup, task: BackgroundTaskRecord, update: ContinuationProgressUpdate, deps: WaveLifecycleDeps): void {
  // #93: dispatch captures are provenance facts; adjacent phases carry state.
  const isDispatchCapture = Boolean(
    update.dispatch
    && (update.subtaskId === undefined || update.subtaskId === task.taskId),
  );
  const next = isDispatchCapture ? undefined : stateFromContinuationProgress(update);
  const previous = next ? transitionTaskState(task, next) : task.state;
  deps.activity.add(task, update.phase, update.message);
  applyExecutorIdentity(task, update);
  // #93: dispatch captures flow through continuations identically.
  if (isDispatchCapture && update.dispatch) {
    deps.dispatch.record(group, task, update.dispatch);
  }
  task.updatedAt = new Date().toISOString();
  const saved = deps.persistence.save(group);
  void saved.catch(() => undefined);
  const transition = stateTransitionNotice(task, previous, task.state);
  const snapshot = transition ? transitionEventSnapshot(group, task) : undefined;
  if (transition) void saved.then((persisted) => {
    synchronizeEventSnapshot(snapshot!, persisted);
    return deps.wake.wake(task, "state", transition, snapshot);
  }).catch(() => undefined);
  deps.indicator.update();
}

function updateReviewStatus(
  task: BackgroundTaskRecord,
  update: WaveProgressUpdate,
  next: BackgroundTaskState | undefined,
): void {
  const taskStatus = update.taskStatuses?.find((candidate) => candidate.taskId === task.taskId);
  const reviewers = update.subtask?.reviewers
    ?? taskStatus?.reviewer?.split(",").map((reviewer) => reviewer.trim()).filter(Boolean);
  const subtaskPhase = update.subtask?.phase;
  const isReviewActivity = subtaskPhase !== undefined
    && ["reviewing", "correcting", "confirming"].includes(subtaskPhase);
  const phase = next === "accepted"
    ? "accepted"
    : isReviewActivity
      ? subtaskPhase
      : task.reviewStatus?.phase ?? taskStatus?.phase;
  if (!task.reviewStatus && !reviewers?.length && phase !== "reviewing") return;
  task.reviewStatus ??= {
    phase: phase ?? task.state,
    reviewers: [],
    activity: [],
    updatedAt: new Date().toISOString(),
  };
  if (reviewers?.length) task.reviewStatus.reviewers = [...reviewers];
  if (phase) task.reviewStatus.phase = phase;
  if (isReviewActivity || next === "accepted") {
    if (task.reviewStatus.activity.at(-1) !== update.message) task.reviewStatus.activity.push(update.message);
    if (task.reviewStatus.activity.length > 20) task.reviewStatus.activity.splice(0, task.reviewStatus.activity.length - 20);
  }
  task.reviewStatus.updatedAt = new Date().toISOString();
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}