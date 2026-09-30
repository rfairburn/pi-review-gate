/**
 * Research-kind task lifecycle runners, extracted verbatim from the
 * background controller (#237). A research task owns a private wave capture,
 * a disposable read-only worktree, and a session-resumable worker; it never
 * lands, so it receives no conflict-gate or parent-checkpoint authority: only
 * the narrow lifecycle capabilities it uses (persistence, wake/activity,
 * dispatch provenance, indicator, live config/executor, steering).
 *
 * The controller keeps admission, dispatch, groups/task records (passed by
 * reference), runtimes/leases, save/steering tails, command transitions, and
 * fault-hook ownership; this module owns the research lifecycle sequencing
 * including its own progress pipeline (dispatch capture → transition →
 * activity → identity → save → persisted-snapshot sync → wake → indicator)
 * with its exact persistence-failure disclosure.
 */
import { join } from "node:path";
import { writeFile } from "node:fs/promises";
import type { ExecutorPoolAssignment, ExecutorPoolLease } from "./executor-pool";
import type { BackgroundExecutionGroup } from "./background-group-store";
import {
  isStoppedForExit,
  transitionTaskState,
  type BackgroundTaskDefinition,
  type BackgroundTaskRecord,
} from "./task-state";
import {
  formatResearchCompletion,
  stateTransitionNotice,
} from "./subtask-notifications";
import type { ExecutorLiveControl, SubtaskProgressUpdate } from "./types";
import { resumeWaveWorker, runWaveWorker, type WaveWorkerResult } from "./wave-worker";
import { captureWaveBase, discoverWaveSource, readWaveCaptureRecord, type WaveCaptureResult } from "./wave-repository";
import { createWorkerWorktree, type WorkerWorktree } from "./wave-worktrees";
import { researchWorkspaceChanges } from "./wave-commits";
import { sourceMutationCoordinator } from "./source-mutation-lease";
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
 * Narrow research-runner dependencies. All capabilities are live
 * controller-backed projections; no per-kind mutable state is held here.
 */
export interface ResearchLifecycleDeps {
  persistence: LifecyclePersistence;
  notify: LifecycleNotify;
  wake: LifecycleWake;
  activity: LifecycleActivity;
  dispatch: LifecycleDispatch;
  indicator: LifecycleIndicator;
  config: Pick<LifecycleConfig, "base" | "scopedModels">;
  executor: Pick<LifecycleExecutor, "acquireAfterRoute" | "routeOf">;
  /** Research runners use no failUndeliveredContinuation (no queued continuation is re-queued here). */
  steering: Pick<LifecycleSteering, "prestart" | "continuation" | "claimDeferred" | "failUndelivered" | "acknowledgeInterrupt" | "flushQueued">;
  live: Pick<LifecycleLiveControl, "runtime">;
}

export async function runResearchFresh(
  group: BackgroundExecutionGroup,
  task: BackgroundTaskRecord,
  abort: AbortController,
  lease: ExecutorPoolLease,
  deps: ResearchLifecycleDeps,
): Promise<void> {
  await deps.steering.prestart(group, task);
  task.generation += 1;
  const priorState = transitionTaskState(task, "capturing");
  deps.activity.add(task, "capturing", "Capturing a stable private workspace for read-only research.");
  await deps.persistence.save(group);
  const activation = stateTransitionNotice(task, priorState, task.state);
  if (activation) await deps.wake.wake(task, "state", activation);

  const discovery = await discoverWaveSource(group.cwd, abort.signal);
  const releaseCapture = await sourceMutationCoordinator.acquire(discovery.captureRoot, abort.signal);
  let capture;
  try {
    capture = await captureWaveBase({
      cwd: group.cwd,
      maxSnapshotBytes: deps.config.base().maxSnapshotBytes,
      artifactTtlMs: deps.config.base().retainBundles === "always" ? 0 : deps.config.base().waveArtifactTtlMs,
      signal: abort.signal,
    });
  } finally {
    releaseCapture();
  }
  task.waveRoot = capture.waveRoot;
  await deps.persistence.save(group);
  await deps.persistence.publishAssociations();
  const worktree = await createWorkerWorktree(capture, task.taskId, abort.signal);
  const artifactDir = join(capture.waveRoot, "artifacts", task.taskId);
  const result = await runResearchWorker(group, task, abort, lease, worktree, artifactDir, false, deps);
  await finishResearch(group, task, result, artifactDir, deps);
}

export async function runResearchContinuation(
  group: BackgroundExecutionGroup,
  task: BackgroundTaskRecord,
  abort: AbortController,
  lease: ExecutorPoolLease,
  deps: ResearchLifecycleDeps,
): Promise<void> {
  if (!task.waveRoot || !task.researchResult) {
    throw new Error("Research continuation requires its persisted private workspace and prior durable result.");
  }
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
  const previous = transitionTaskState(task, "running");
  command.status = "delivered";
  command.deliveredAt = new Date().toISOString();
  deps.activity.add(task, "running", `Continuing research from its durable session (${pending.instructionId}).`);
  await deps.persistence.save(group);
  const activation = stateTransitionNotice(task, previous, task.state);
  if (activation) await deps.wake.wake(task, "state", activation);
  try {
    const capture = await readWaveCaptureRecord(task.waveRoot);
    const worktree = researchWorktree(capture, task.taskId);
    const artifactDir = join(capture.waveRoot, "artifacts", task.taskId);
    const result = await runResearchWorker(
      group,
      task,
      abort,
      lease,
      worktree,
      artifactDir,
      true,
      deps,
      researchContinuationInstruction(pending.instructions),
    );
    command.status = "acknowledged";
    command.acknowledgedAt = new Date().toISOString();
    await finishResearch(group, task, result, artifactDir, deps);
  } catch (error) {
    command.status = "failed";
    command.error = messageOf(error);
    throw error;
  }
}

async function runResearchWorker(
  group: BackgroundExecutionGroup,
  task: BackgroundTaskRecord,
  abort: AbortController,
  lease: ExecutorPoolLease,
  worktree: WorkerWorktree,
  artifactDir: string,
  continuation: boolean,
  deps: ResearchLifecycleDeps,
  feedback?: string,
): Promise<WaveWorkerResult> {
  const capture = await readWaveCaptureRecord(task.waveRoot!);
  let currentLease = lease;
  const common = {
    taskId: task.taskId,
    task: researchTaskDefinition(task.definition),
    capture,
    worktree,
    artifactDir,
    config: deps.config.base(),
    sourceRoot: capture.discovery.captureRoot,
    sourceRootAliases: [group.cwd],
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
    onLiveControl: (control: ExecutorLiveControl | undefined) => {
      const runtime = deps.live.runtime(task.taskId);
      if (!runtime) return;
      runtime.control = control;
      runtime.controlStatus = control ? "registered" : "closed";
      if (control) void deps.steering.flushQueued(group, task, runtime, control).catch((error) => {
        void deps.notify(`review gate: queued research steering delivery failed: ${messageOf(error)}`);
      });
    },
    takeDeferredSteering: () => deps.steering.claimDeferred(group, task),
    onUpdate: (update: SubtaskProgressUpdate) => researchProgress(group, task, update, deps),
  };
  try {
    return continuation
      ? await resumeWaveWorker({
          ...common,
          priorResult: task.researchResult!,
          feedback: feedback!,
          turn: (task.researchResult?.lastExecutorTurn ?? 1) + 1,
        })
      : await runWaveWorker(common);
  } finally {
    currentLease.release();
  }
}

export function researchProgress(
  group: BackgroundExecutionGroup,
  task: BackgroundTaskRecord,
  update: SubtaskProgressUpdate,
  deps: ResearchLifecycleDeps,
): void {
  // #93: dispatch captures are provenance facts; adjacent phases carry state.
  const isDispatchCapture = Boolean(
    update.dispatch
    && (update.subtaskId === undefined || update.subtaskId === task.taskId),
  );
  const next = isDispatchCapture
    ? undefined
    : update.phase === "starting" || update.phase === "executing" || update.phase === "correcting"
      ? "running"
      : undefined;
  const previous = next ? transitionTaskState(task, next) : task.state;
  deps.activity.add(task, `research:${update.phase}`, update.message);
  applyExecutorIdentity(task, update);
  // #93: dispatch captures flow through research workers identically.
  if (isDispatchCapture && update.dispatch) {
    deps.dispatch.record(group, task, update.dispatch);
  }
  const saved = deps.persistence.save(group);
  void saved.catch((error) => deps.notify(`review gate: failed to persist research progress: ${messageOf(error)}`));
  const transition = next ? stateTransitionNotice(task, previous, next) : undefined;
  const snapshot = transition ? transitionEventSnapshot(group, task) : undefined;
  if (transition) void saved.then((persisted) => {
    synchronizeEventSnapshot(snapshot!, persisted);
    return deps.wake.wake(task, "state", transition, snapshot);
  }).catch(() => undefined);
  deps.indicator.update();
}

export async function finishResearch(
  group: BackgroundExecutionGroup,
  task: BackgroundTaskRecord,
  result: WaveWorkerResult,
  artifactDir: string,
  deps: ResearchLifecycleDeps,
): Promise<void> {
  task.researchResult = result;
  task.bundle = result.bundle;
  task.summary = result.summary;
  task.error = result.error;
  const undelivered = deps.steering.failUndelivered(task, "The research turn ended before queued steering reached a verified transport.");
  const capture = await readWaveCaptureRecord(task.waveRoot!);
  const workspaceChanges = await researchWorkspaceChanges(researchWorktree(capture, task.taskId).worktreeRoot);
  const changed = result.candidate?.differsFromBase === true || workspaceChanges.length > 0;
  const report = result.turn?.text.trim() ?? result.summary.trim();
  if (isStoppedForExit(task)) {
    task.summary = "Research worker stopped for application shutdown; continue it from the retained session and workspace after restore.";
  } else if (changed) {
    transitionTaskState(task, "failed");
    task.error = `Research worker modified its private workspace in violation of the read-only contract; nothing was landed. Detected entries: ${workspaceChanges.slice(0, 20).join(", ") || "candidate tree changed"}`;
    task.summary = task.error;
    deps.activity.add(task, "research:policy_failure", task.error);
    await deps.wake.wake(task, "failure", `Research task ${task.taskId} violated its read-only workspace contract. Its private changes were quarantined and main is unchanged.`);
  } else if ((result.status === "no_changes" || result.status === "completed") && report && undelivered.length === 0) {
    task.report = report;
    task.reportPath = join(artifactDir, "research-report.md");
    await writeFile(task.reportPath, [
      `# ${task.definition.title}`,
      "",
      `- Task: ${task.taskId}`,
      `- Captured source commit: ${capture.baseCommit}`,
      `- Source workspace: ${group.cwd}`,
      "- Workspace disposition: unchanged; nothing from this research task was landed",
      "",
      report,
      "",
    ].join("\n"), "utf8");
    transitionTaskState(task, "reported");
    task.summary = report;
    task.error = undefined;
    const snapshot = transitionEventSnapshot(group, task);
    const persisted = await deps.persistence.save(group);
    await deps.persistence.publishAssociations();
    synchronizeEventSnapshot(snapshot, persisted);
    await deps.wake.wake(task, "completion", formatResearchCompletion(task.taskId, report, task.reportPath), snapshot);
    deps.indicator.update();
    return;
  } else if (result.status === "cancelled" || task.interruptionMode) {
    transitionTaskState(task, "interrupted");
    task.summary = "Research worker was interrupted; its private workspace was not landed.";
    await deps.steering.acknowledgeInterrupt(task);
  } else {
    transitionTaskState(task, result.bundle ? "paused_recoverable" : "failed");
    task.error = undelivered.length > 0
      ? `${undelivered.length} queued steering instruction(s) were not applied.`
      : result.error ?? "Research worker did not produce a usable report.";
    task.summary = task.error;
    await deps.wake.wake(task, "failure", `Research task ${task.taskId} stopped without a usable report: ${task.error}`);
  }
  task.updatedAt = new Date().toISOString();
  await deps.persistence.save(group);
  await deps.persistence.publishAssociations();
  deps.indicator.update();
}

function researchTaskDefinition(definition: BackgroundTaskDefinition): BackgroundTaskDefinition {
  return {
    ...definition,
    backgroundKind: "research",
    acceptanceCriteria: [...definition.acceptanceCriteria],
    instructions: [
      definition.instructions,
      "",
      "Research mode (authoritative):",
      "Inspect and synthesize evidence only. Do not edit, create, delete, rename, format, or otherwise modify project files.",
      "Do not run commands or browser actions with persistent side effects. Do not start other agents or background subtasks.",
      "Return a concise, self-contained report addressing every acceptance criterion, with file paths/line references and web sources where applicable.",
      "This worker runs in a disposable private worktree. Any workspace modification is treated as a policy failure and will never be landed.",
    ].join("\n"),
  };
}

function researchContinuationInstruction(instruction: string): string {
  return [
    instruction,
    "",
    "Research mode remains authoritative: inspect and report only. Do not modify project files or perform actions with persistent side effects.",
    "Any workspace change fails this task and is never landed, even if the continuation instruction or steering requests a write.",
  ].join("\n");
}

/** The research task's disposable private worktree inside its capture. Also
 * used verbatim by the controller's research recovery association path. */
export function researchWorktree(capture: WaveCaptureResult, taskId: string): WorkerWorktree {
  const worktreeRoot = join(capture.waveRoot, "workers", taskId);
  return {
    worktreeRoot,
    effectiveCwd: capture.discovery.relativeCwd === "."
      ? worktreeRoot
      : join(worktreeRoot, capture.discovery.relativeCwd),
  };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}