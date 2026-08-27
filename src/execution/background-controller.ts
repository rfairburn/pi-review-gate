import { createHash, randomUUID } from "node:crypto";
import { open, mkdir, mkdtemp, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { DEFAULT_SUBTASK_NOTIFICATION_MODE, type ReviewGateConfig } from "../config";
import { externalAgentCatalog, resolvedWorkerResources, resolvedWorkerRoute } from "../config";
import { createWorkspaceSnapshot, type FileSnapshot, type WorkspaceSnapshot } from "../capture";
import { activeExchangeBaseline, checkpointReviewWindow, type ReviewGateState } from "../state";
import { configDigest, type ExecutionAssociationsSnapshot } from "../session-state";
import { materializeLandingConflicts, unresolvedConflictMarkers } from "./conflict-materialization";
import { ExecutorPoolScheduler, type ExecutorPoolAssignment, type ExecutorPoolLease } from "./executor-pool";
import { continueOperation, inspectOperation } from "./operation-actions";
import type { ReattachmentBundle } from "./operation-record";
import { readOperationRecord } from "./operation-record";
import { sourceMutationCoordinator } from "./source-mutation-lease";
import type { ContinuationProgressUpdate, ExecutorInteractionAcknowledgement, ExecutorLiveControl, SubtaskProgressPhase } from "./types";
import { executeWave, type WaveProgressUpdate, type WaveResult } from "./wave-controller";
import { resumeWaveWorker, runWaveWorker, type WaveWorkerResult, type WaveWorkerTask } from "./wave-worker";
import { captureWaveBase, discoverWaveSource, readWaveCaptureRecord, type WaveCaptureResult } from "./wave-repository";
import { executeWaveLanding, planWaveLanding } from "./wave-landing";
import { researchWorkspaceChanges } from "./wave-commits";
import { pinCommit } from "./wave-worktrees";
import { createWorkerWorktree, type WorkerWorktree } from "./wave-worktrees";

const GROUP_VERSION = 1;
const MAX_ACTIVITY = 5_000;

export const BACKGROUND_TASK_STATES = [
  "queued",
  "capturing",
  "running",
  "reviewing",
  "accepted",
  "waiting_to_land",
  "landing",
  "landed",
  "reported",
  "failed",
  "interrupted",
  "conflicted",
  "paused_recoverable",
  "stopped_for_application_exit",
] as const;

export type BackgroundTaskState = typeof BACKGROUND_TASK_STATES[number];
export type BackgroundTaskKind = "execute" | "research";

const ACTIVE_TASK_STATES: ReadonlySet<BackgroundTaskState> = new Set([
  "queued",
  "capturing",
  "running",
  "reviewing",
  "accepted",
  "waiting_to_land",
  "landing",
]);

export function isActiveTaskState(state: BackgroundTaskState): boolean {
  return ACTIVE_TASK_STATES.has(state);
}

export function isInterruptibleTaskState(state: BackgroundTaskState): boolean {
  return isActiveTaskState(state);
}

export function isForceMergeCandidateTaskState(state: BackgroundTaskState): boolean {
  return !isActiveTaskState(state);
}

export type BackgroundTaskDefinition = WaveWorkerTask;

export interface BackgroundCommandRecord {
  instructionId: string;
  action: "continue" | "steer" | "interrupt" | "force_merge";
  actor: "model" | "user" | "system";
  text?: string;
  mode?: string;
  status: "queued" | "delivered" | "acknowledged" | "failed";
  createdAt: string;
  deliveredAt?: string;
  acknowledgedAt?: string;
  error?: string;
}

export interface BackgroundActivityEvent {
  sequence: number;
  at: string;
  phase: string;
  message: string;
}

export interface BackgroundStateTransition {
  sequence: number;
  state: BackgroundTaskState;
  at: string;
  generation: number;
}

export interface BackgroundTaskTimingSummary {
  queueMs: number;
  captureMs: number;
  executionMs: number;
  reviewMs: number;
  landingMs: number;
  totalMs: number;
}

export interface BackgroundSchedulingSnapshot {
  configuredWorkerLimit: number;
  configuredPoolCapacity: number;
  activeWorkers: number;
  activePoolLeases: number;
  availableWorkerSlots: number;
  availablePoolSlots: number;
  estimatedImmediatelyAvailableSlots: number;
  dispatchPending: number;
  dispatchAssigned: number;
  globallyDispatchPending: number;
}

export interface BackgroundTaskRecord {
  taskId: string;
  definition: BackgroundTaskDefinition;
  state: BackgroundTaskState;
  createdAt: string;
  updatedAt: string;
  generation: number;
  waveRoot?: string;
  bundle?: ReattachmentBundle;
  executorEntryId?: string;
  lastRuntimeConfigDigest?: string;
  result?: WaveResult;
  researchResult?: WaveWorkerResult;
  report?: string;
  reportPath?: string;
  summary?: string;
  error?: string;
  activity: BackgroundActivityEvent[];
  nextActivitySequence: number;
  stateHistory?: BackgroundStateTransition[];
  nextStateSequence?: number;
  commands: BackgroundCommandRecord[];
  pendingContinuation?: { instructions: string; instructionId: string };
  interruptionMode?: "interrupt_as_failure" | "interrupt_with_merge";
  reviewStatus?: {
    phase: string;
    reviewers: string[];
    activity: string[];
    updatedAt: string;
  };
}

export interface BackgroundExecutionGroup {
  version: 1;
  revision: number;
  integritySha256: string;
  executionId: string;
  kind: BackgroundTaskKind;
  root: string;
  cwd: string;
  createdAt: string;
  updatedAt: string;
  peakConcurrency?: number;
  tasks: BackgroundTaskRecord[];
}

export interface BackgroundConflictGate {
  executionId: string;
  taskId: string;
  sourceRoot: string;
  paths: string[];
  activatedAt: string;
  manifestPath: string;
  reason: string;
}

interface RuntimeTask {
  abort: AbortController;
  promise: Promise<void>;
  control?: ExecutorLiveControl;
  controlStatus: "pending" | "registered" | "closed";
}

interface PersistedGroupRevision {
  revision: number;
  updatedAt: string;
  peakConcurrency: number;
  integritySha256: string;
}

interface BackgroundControllerInput {
  pi: unknown;
  config: ReviewGateConfig;
  state: ReviewGateState;
  cwd: () => string;
  notify?: (message: string) => void | Promise<void>;
  onAssociationsChanged?: (associations: ExecutionAssociationsSnapshot) => void | Promise<void>;
  onExpandedViewChanged?: (expanded: boolean) => void | Promise<void>;
}

export interface BackgroundInspection {
  executionId: string;
  kind: BackgroundTaskKind;
  revision: number;
  root: string;
  cwd: string;
  createdAt: string;
  updatedAt: string;
  peakConcurrency: number;
  activeCount: number;
  historicalCount: number;
  scheduling: BackgroundSchedulingSnapshot;
  conflictGate?: BackgroundConflictGate;
  tasks: Array<BackgroundTaskRecord & {
    timing: BackgroundTaskTimingSummary;
    dispatchState?: "waiting_for_capacity" | "assigned_starting";
    artifactDir?: string;
    liveControl?: { adapter: string; generation: number; protocol?: string; steer: boolean; interrupt: boolean };
  }>;
}

export interface BackgroundReviewReadinessTask {
  executionId: string;
  kind: BackgroundTaskKind;
  taskId: string;
  title: string;
  state: BackgroundTaskState;
}

export class BackgroundExecutionController {
  private readonly groups = new Map<string, BackgroundExecutionGroup>();
  private readonly runtimes = new Map<string, RuntimeTask>();
  private readonly saveTails = new Map<string, Promise<void>>();
  private readonly steeringTails = new Map<string, Promise<void>>();
  private pool: ExecutorPoolScheduler;
  private active = 0;
  private shuttingDown = false;
  private pumping = false;
  private pumpRequested = false;
  private scopedModels: string[] = [];
  private conflictGate?: BackgroundConflictGate;
  private releaseConflictBlock?: () => void;
  private uiContext: unknown;
  private expandedView = false;

  constructor(private readonly input: BackgroundControllerInput) {
    this.pool = new ExecutorPoolScheduler(resolvedWorkerResources(input.config));
    this.expandedView = input.config.ui?.subtasksViewExpanded === true;
  }

  setScopedModels(models: readonly string[]): void {
    this.scopedModels = [...models];
  }

  setUiContext(ctx: unknown): void {
    this.uiContext = ctx;
    this.updateIndicator();
  }

  async toggleExpandedView(ctx: unknown): Promise<boolean> {
    if (!isRecord(ctx) || !isRecord(ctx.ui) || typeof ctx.ui.setWidget !== "function") {
      throw new Error("The current harness does not provide a below-editor widget UI.");
    }
    this.uiContext = ctx;
    const expanded = !this.expandedView;
    await this.input.onExpandedViewChanged?.(expanded);
    this.expandedView = expanded;
    this.updateIndicator();
    return this.expandedView;
  }

  refreshPool(): void {
    this.pool.reconfigure(resolvedWorkerResources(this.input.config));
    void this.pump();
  }

  syncUiPreferences(): void {
    this.expandedView = this.input.config.ui?.subtasksViewExpanded === true;
    this.updateIndicator();
  }

  associations(): ExecutionAssociationsSnapshot {
    const waveRoots: string[] = [];
    const bundles: ReattachmentBundle[] = [];
    for (const group of this.groups.values()) {
      for (const task of group.tasks) {
        if (task.waveRoot) waveRoots.push(task.waveRoot);
        if (task.bundle) bundles.push({ ...task.bundle });
      }
    }
    return {
      waveRoots: [...new Set(waveRoots)],
      bundles,
      groupRoots: [...this.groups.values()].map((group) => group.root),
      conflictGate: this.conflictGate ? { ...this.conflictGate, paths: [...this.conflictGate.paths] } : undefined,
    };
  }

  async restore(associations: ExecutionAssociationsSnapshot): Promise<void> {
    await this.detach();
    const roots = associations.groupRoots ?? [];
    for (const root of roots) {
      try {
        const group = await readGroup(root);
        if (resolve(group.cwd) !== resolve(this.input.cwd())) {
          throw new Error(`execution cwd ${group.cwd} does not match ${resolve(this.input.cwd())}`);
        }
        for (const task of group.tasks) {
          if (task.state === "stopped_for_application_exit" && task.bundle) {
            const instructionId = `application-resume-${randomUUID()}`;
            task.pendingContinuation = {
              instructions: "Resume after the owning application restarted. Reinspect the preserved worktree and finish the original task without repeating completed work.",
              instructionId,
            };
            task.commands.push({
              instructionId,
              action: "continue",
              actor: "system",
              text: task.pendingContinuation.instructions,
              status: "queued",
              createdAt: new Date().toISOString(),
            });
            transitionTaskState(task, "queued");
            task.summary = "Exact parent conversation restored; durable continuation queued automatically.";
            task.updatedAt = new Date().toISOString();
          } else if (task.state === "stopped_for_application_exit" && !task.waveRoot) {
            transitionTaskState(task, "queued");
            task.summary = "Exact parent conversation restored; undispatched task queued automatically.";
            task.updatedAt = new Date().toISOString();
          } else if (isActiveTaskState(task.state) && task.state !== "queued") {
            transitionTaskState(task, "paused_recoverable");
            task.summary = "The prior application ended without a verified clean shutdown; inspect writer ownership before continuing.";
            task.updatedAt = new Date().toISOString();
          }
        }
        this.groups.set(group.executionId, group);
        await this.save(group);
      } catch (error) {
        await this.input.notify?.(`review gate: background execution was not restored (${root}): ${messageOf(error)}`);
      }
    }
    const restoredOperations = new Set(
      [...this.groups.values()].flatMap((group) => group.tasks.map((task) => task.bundle?.operationId).filter((value): value is string => Boolean(value))),
    );
    for (const bundle of associations.bundles) {
      if (restoredOperations.has(bundle.operationId)) continue;
      try {
        await this.resolveOrAdoptTask(undefined, undefined, bundle);
        restoredOperations.add(bundle.operationId);
      } catch (error) {
        await this.input.notify?.(`review gate: legacy execution bundle was not adopted (${bundle.operationId}): ${messageOf(error)}`);
      }
    }
    if (associations.conflictGate) {
      const gate: BackgroundConflictGate = {
        ...associations.conflictGate,
        paths: [...associations.conflictGate.paths],
      };
      this.conflictGate = gate;
      this.releaseConflictBlock = sourceMutationCoordinator.block(
        gate.sourceRoot,
        gate.reason,
      );
    }
    this.pool = new ExecutorPoolScheduler(resolvedWorkerResources(this.input.config));
    this.updateIndicator();
    void this.pump();
  }

  async start(tasks: BackgroundTaskDefinition[], kind: BackgroundTaskKind = "execute"): Promise<BackgroundInspection> {
    if (this.shuttingDown) throw new Error("Application shutdown is in progress.");
    if (resolvedWorkerRoute(this.input.config, kind).length === 0) {
      throw new Error(`No ${kind} worker route is configured. Add at least one eligible resource in /review-settings.`);
    }
    const root = await realpath(await mkdtemp(join(tmpdir(), "pi-review-execution-")));
    const executionId = `exec-${randomUUID()}`;
    const now = new Date().toISOString();
    const group: BackgroundExecutionGroup = {
      version: GROUP_VERSION,
      revision: 0,
      integritySha256: "",
      executionId,
      kind,
      root,
      cwd: resolve(this.input.cwd()),
      createdAt: now,
      updatedAt: now,
      peakConcurrency: 0,
      tasks: tasks.map((definition) => newTask(definition)),
    };
    this.groups.set(executionId, group);
    await this.save(group);
    await this.publishAssociations();
    void this.pump();
    return this.inspect(executionId);
  }

  async add(executionId: string | undefined, tasks: BackgroundTaskDefinition[]): Promise<BackgroundInspection> {
    const group = this.resolveGroup(executionId);
    if (resolve(group.cwd) !== resolve(this.input.cwd())) throw new Error("Execution group belongs to a different workspace.");
    group.tasks.push(...tasks.map((definition) => newTask(definition)));
    group.updatedAt = new Date().toISOString();
    await this.save(group);
    void this.pump();
    return this.inspect(group.executionId);
  }

  inspect(executionId?: string, taskId?: string, offset?: number, lines?: number): BackgroundInspection {
    const group = this.resolveGroup(executionId);
    const selected = taskId ? group.tasks.filter((task) => task.taskId === taskId) : group.tasks;
    if (taskId && selected.length === 0) throw new Error(`Unknown task ${taskId}.`);
    const from = Math.max(0, offset ?? 0);
    const count = Math.max(1, Math.min(lines ?? MAX_ACTIVITY, 500));
    return {
      executionId: group.executionId,
      kind: group.kind,
      revision: group.revision,
      root: group.root,
      cwd: group.cwd,
      createdAt: group.createdAt,
      updatedAt: group.updatedAt,
      peakConcurrency: group.peakConcurrency ?? 0,
      activeCount: group.tasks.filter((task) => isActiveTaskState(task.state)).length,
      historicalCount: group.tasks.length,
      scheduling: this.schedulingSnapshot(group),
      conflictGate: this.conflictGate && this.conflictGate.executionId === group.executionId
        ? { ...this.conflictGate, paths: [...this.conflictGate.paths] }
        : undefined,
      tasks: selected.map((task) => ({
        ...cloneTask(task),
        timing: taskTiming(task),
        dispatchState: task.state === "queued"
          ? this.runtimes.has(task.taskId) ? "assigned_starting" : "waiting_for_capacity"
          : undefined,
        activity: task.activity.slice(offset === undefined ? Math.max(0, task.activity.length - count) : from, offset === undefined ? undefined : from + count),
        artifactDir: task.waveRoot ? join(task.waveRoot, "artifacts", task.taskId) : undefined,
        liveControl: this.runtimes.get(task.taskId)?.control
          ? {
              adapter: this.runtimes.get(task.taskId)!.control!.adapter,
              generation: this.runtimes.get(task.taskId)!.control!.generation,
              protocol: this.runtimes.get(task.taskId)!.control!.protocol,
              ...this.runtimes.get(task.taskId)!.control!.capabilities,
            }
          : undefined,
      })),
    };
  }

  list(): BackgroundInspection[] {
    return [...this.groups.values()].map((group) => this.inspect(group.executionId));
  }

  reviewReadiness(): BackgroundReviewReadinessTask[] {
    return [...this.groups.values()].flatMap((group) => group.tasks
      .filter((task) => isActiveTaskState(task.state))
      .map((task) => ({
        executionId: group.executionId,
        kind: group.kind,
        taskId: task.taskId,
        title: task.definition.title,
        state: task.state,
      })));
  }

  async continueTask(input: {
    executionId?: string;
    taskId?: string;
    bundle?: ReattachmentBundle;
    instructions: string;
    instructionId: string;
    actor: "model" | "user";
  }): Promise<BackgroundInspection> {
    const target = await this.resolveOrAdoptTask(input.executionId, input.taskId, input.bundle);
    const { group, task } = target;
    if (isActiveTaskState(task.state)) throw new Error(`Task ${task.taskId} is already active.`);
    const bundle = input.bundle ?? task.bundle;
    if (!bundle) throw new Error(`Task ${task.taskId} has no durable continuation bundle.`);
    const duplicate = task.commands.find((command) => command.instructionId === input.instructionId);
    if (duplicate) return this.inspect(group.executionId, task.taskId);
    task.bundle = { ...bundle };
    task.pendingContinuation = { instructions: input.instructions, instructionId: input.instructionId };
    task.commands.push({
      instructionId: input.instructionId,
      action: "continue",
      actor: input.actor,
      text: input.instructions,
      status: "queued",
      createdAt: new Date().toISOString(),
    });
    transitionTaskState(task, "queued");
    await this.save(group);
    void this.pump();
    return this.inspect(group.executionId, task.taskId);
  }

  private async resolveOrAdoptTask(
    executionId?: string,
    taskId?: string,
    bundle?: ReattachmentBundle,
  ): Promise<{ group: BackgroundExecutionGroup; task: BackgroundTaskRecord }> {
    try {
      return this.resolveTask(executionId, taskId, bundle);
    } catch (error) {
      if (!bundle || taskId) throw error;
      const inspection = await inspectOperation(bundle);
      if (resolve(inspection.manifest.sourceRoot) !== resolve(this.input.cwd())) {
        throw new Error(`Recovery bundle belongs to ${inspection.manifest.sourceRoot}, not ${resolve(this.input.cwd())}.`);
      }
      const definition = inspection.manifest.task?.task;
      if (!definition) throw new Error("Recovery bundle has no durable task definition and cannot be adopted automatically.");
      let group: BackgroundExecutionGroup;
      if (executionId) {
        group = this.resolveGroup(executionId);
      } else {
        const root = await realpath(await mkdtemp(join(tmpdir(), "pi-review-execution-")));
        const now = new Date().toISOString();
        group = {
          version: GROUP_VERSION,
          revision: 0,
          integritySha256: "",
          executionId: `exec-${randomUUID()}`,
          kind: definition.backgroundKind === "research" ? "research" : "execute",
          root,
          cwd: resolve(this.input.cwd()),
          createdAt: now,
          updatedAt: now,
          peakConcurrency: 0,
          tasks: [],
        };
        this.groups.set(group.executionId, group);
      }
      const task = newTask(definition);
      task.bundle = { ...inspection.bundle };
      task.waveRoot = inspection.bundle.waveRoot;
      transitionTaskState(task, "paused_recoverable");
      task.summary = `Adopted durable operation ${inspection.bundle.operationId} for triage-style continuation.`;
      addActivity(task, "recovery", task.summary);
      group.tasks.push(task);
      await this.save(group);
      await this.publishAssociations();
      return { group, task };
    }
  }

  async steer(input: {
    executionId?: string;
    taskId?: string;
    instructions: string;
    instructionId: string;
    actor: "model" | "user";
  }): Promise<BackgroundInspection> {
    const { group, task } = this.resolveTask(input.executionId, input.taskId);
    const duplicate = task.commands.find((command) => command.instructionId === input.instructionId);
    if (duplicate) return this.inspect(group.executionId, task.taskId);
    const command: BackgroundCommandRecord = {
      instructionId: input.instructionId,
      action: "steer",
      actor: input.actor,
      text: input.instructions,
      status: "queued",
      createdAt: new Date().toISOString(),
    };
    task.commands.push(command);
    addActivity(task, "steer", `Steering queued (${input.instructionId}).`);
    await this.save(group);
    const runtime = this.runtimes.get(task.taskId);
    const control = runtime?.control;
    if (!runtime || !control) {
      if (task.state === "queued" || (runtime && ["capturing", "running", "reviewing"].includes(task.state))) {
        return this.inspect(group.executionId, task.taskId);
      }
      command.status = "failed";
      command.error = `Task ${task.taskId} is ${task.state}; it has no executor startup or live turn that can accept steering.`;
      await this.save(group);
      throw new Error(command.error);
    }
    await this.flushQueuedSteering(group, task, runtime, control);
    if (command.status === "failed") throw new Error(command.error ?? "Steering was not acknowledged.");
    return this.inspect(group.executionId, task.taskId);
  }

  async interrupt(input: {
    executionId?: string;
    taskId?: string;
    mode: "interrupt_as_failure" | "interrupt_with_merge";
    instructionId: string;
    actor: "model" | "user";
  }): Promise<BackgroundInspection> {
    const { group, task } = this.resolveTask(input.executionId, input.taskId);
    if (group.kind === "research" && input.mode === "interrupt_with_merge") {
      throw new Error("Research tasks cannot use interrupt_with_merge because research workspaces are never eligible to land. Use interrupt_as_failure.");
    }
    const duplicate = task.commands.find((command) => command.instructionId === input.instructionId);
    if (duplicate) return this.inspect(group.executionId, task.taskId);
    const runtime = this.runtimes.get(task.taskId);
    if (!runtime && task.state !== "queued") throw new Error(`Task ${task.taskId} has no live or queued writer to interrupt.`);
    const command: BackgroundCommandRecord = {
      instructionId: input.instructionId,
      action: "interrupt",
      actor: input.actor,
      mode: input.mode,
      status: runtime ? "delivered" : "acknowledged",
      createdAt: new Date().toISOString(),
      deliveredAt: runtime ? new Date().toISOString() : undefined,
      acknowledgedAt: runtime ? undefined : new Date().toISOString(),
    };
    task.commands.push(command);
    if (!runtime) {
      for (const pending of task.commands) {
        if (pending.action !== "steer" || pending.status !== "queued") continue;
        pending.status = "failed";
        pending.error = "Task was interrupted before executor startup.";
      }
      transitionTaskState(task, "interrupted");
      task.summary = input.mode === "interrupt_with_merge"
        ? "Interrupted before executor startup; there was no task checkpoint to merge."
        : "Interrupted before executor startup; the source workspace is unchanged.";
      addActivity(task, "interrupt", task.summary);
      await this.save(group);
      await this.publishAssociations();
      this.updateIndicator();
      return this.inspect(group.executionId, task.taskId);
    }
    task.interruptionMode = input.mode;
    await this.save(group);
    let transportMessage = "No verified adapter interrupt was available; terminated the owned executor process group.";
    let transport: Promise<ExecutorInteractionAcknowledgement> | undefined;
    if (runtime.control?.capabilities.interrupt) {
      transport = runtime.control.interrupt();
    }
    runtime.abort.abort(new Error(input.mode));
    if (transport) {
      try {
        const acknowledgement = await transport;
        transportMessage = acknowledgement.message;
        addActivity(task, "interrupt", `Executor interrupt ${acknowledgement.status}: ${acknowledgement.message}`);
      } catch (error) {
        transportMessage = `Executor interrupt transport failed: ${messageOf(error)}; terminated the owned process group.`;
        addActivity(task, "interrupt", transportMessage);
      }
    }
    await runtime.promise;
    command.status = "acknowledged";
    command.acknowledgedAt = new Date().toISOString();
    command.error = undefined;
    addActivity(task, "interrupt", `Writer quiesced. ${transportMessage}`);
    task.interruptionMode = undefined;
    await this.save(group);
    if (input.mode === "interrupt_with_merge") {
      addActivity(task, "interrupt", "Interrupt-with-merge is attempting a mechanical checkpoint landing; workspace contents still require manual inspection afterward regardless of landing status.");
      await this.save(group);
      return this.forceMerge({
        executionId: group.executionId,
        taskId: task.taskId,
        mergeAnyhow: true,
        instructionId: `${input.instructionId}-force-merge`,
        actor: input.actor,
      });
    }
    return this.inspect(group.executionId, task.taskId);
  }

  async forceMerge(input: {
    executionId?: string;
    taskId?: string;
    mergeAnyhow: boolean;
    instructionId: string;
    actor: "model" | "user" | "system";
  }): Promise<BackgroundInspection> {
    const { group, task } = this.resolveTask(input.executionId, input.taskId);
    if (group.kind === "research") throw new Error("Research tasks have reports, not mergeable checkpoints; force-merge is unavailable.");
    if (this.runtimes.has(task.taskId) || isActiveTaskState(task.state)) {
      throw new Error(`Task ${task.taskId} still has a live or queued writer; interrupt and await acknowledgement before force-merge.`);
    }
    if (!task.bundle) throw new Error(`Task ${task.taskId} has no verified recovery bundle.`);
    const duplicate = task.commands.find((command) => command.instructionId === input.instructionId);
    if (duplicate) return this.inspect(group.executionId, task.taskId);
    const command: BackgroundCommandRecord = {
      instructionId: input.instructionId,
      action: "force_merge",
      actor: input.actor,
      mode: input.mergeAnyhow ? "merge_anyhow" : "clean_only",
      status: "queued",
      createdAt: new Date().toISOString(),
    };
    task.commands.push(command);
    await this.save(group);

    const inspection = await inspectOperation(task.bundle);
    const checkpoint = inspection.record.checkpoint;
    const accepted = task.result?.taskResults[0]?.acceptedCommitSha;
    const commitSha = accepted ?? checkpoint?.commitSha;
    if (!commitSha || (!accepted && !checkpoint?.verified)) {
      command.status = "failed";
      command.error = "No accepted commit or verified checkpoint is available.";
      await this.save(group);
      throw new Error(command.error);
    }
    const capture = await readWaveCaptureRecord(task.bundle.waveRoot);
    const reviewWindowId = this.input.state.reviewWindow?.id;
    const parentBaseline = activeExchangeBaseline(this.input.state);
    const preTaskSnapshot = parentBaseline ? await createWorkspaceSnapshot(group.cwd, {
      maxFileBytes: this.input.config.maxFileBytes,
      maxSnapshotBytes: this.input.config.maxSnapshotBytes,
      reuseUnchangedFrom: parentBaseline,
    }) : undefined;
    const release = await sourceMutationCoordinator.acquire(group.cwd);
    try {
      command.status = "delivered";
      command.deliveredAt = new Date().toISOString();
      transitionTaskState(task, "waiting_to_land");
      addActivity(task, "force_merge", `Force-merge requested from ${commitSha}. This is a mechanical landing attempt; manual inspection of the main workspace is required afterward in every outcome.`);
      await this.save(group);

      await pinCommit(capture, commitSha, { type: "integration" });
      const plan = await planWaveLanding(capture, commitSha, group.cwd);
      if (plan.conflicts.length > 0) {
        if (!input.mergeAnyhow) {
          transitionTaskState(task, "paused_recoverable");
          task.summary = `Force-merge found ${plan.conflicts.length} conflict(s); main remains unchanged. Manual workspace inspection is required before choosing recovery.`;
          command.status = "failed";
          command.error = task.summary;
          await this.save(group);
          throw new Error(`${task.summary} Re-run SubtasksForceMerge with mergeAnyhow only if ordinary conflict markers should be materialized.`);
        }
        const materialized = await materializeLandingConflicts(capture, plan, `forced subtask ${task.taskId}`);
        await this.checkpointParent(reviewWindowId, parentBaseline, preTaskSnapshot, group.cwd, materialized.appliedPaths);
        this.conflictGate = {
          executionId: group.executionId,
          taskId: task.taskId,
          sourceRoot: group.cwd,
          paths: materialized.paths,
          activatedAt: new Date().toISOString(),
          manifestPath: materialized.manifestPath,
          reason: `Forced task ${task.taskId} materialized conflicts that require immediate resolution.`,
        };
        this.releaseConflictBlock = sourceMutationCoordinator.block(group.cwd, this.conflictGate.reason);
        transitionTaskState(task, "conflicted");
        task.summary = `Force-merge materialized conflict markers in ${materialized.paths.join(", ")}. Resolve them and manually inspect the complete workspace; force-merge does not verify the requested result.`;
        command.status = "acknowledged";
        command.acknowledgedAt = new Date().toISOString();
        await this.save(group);
        await this.publishAssociations();
        await this.wake(task, "failure", this.criticalPrompt()!);
        return this.inspect(group.executionId, task.taskId);
      }
      transitionTaskState(task, "landing");
      const landing = await executeWaveLanding(plan, capture);
      if (landing.status !== "landed") throw new Error(`Force-merge landing ended in ${landing.status}.`);
      const paths = [...landing.appliedPaths, ...landing.alreadyAppliedPaths];
      task.summary = paths.length > 0
        ? "Stopped task force-merged mechanically into the main workspace; manual workspace inspection is still required to confirm the requested changes are present and correct."
        : "Force-merge checkpoint contains no changes that remain to be landed; manual workspace inspection is still required to determine whether the requested changes are present.";
      command.status = "acknowledged";
      command.acknowledgedAt = new Date().toISOString();
      await this.checkpointParent(reviewWindowId, parentBaseline, preTaskSnapshot, group.cwd, paths);
      transitionTaskState(task, "landed");
      await this.save(group);
      await this.publishAssociations();
      await this.wake(task, "completion", `Task ${task.taskId} force-merged and landed mechanically. This does not verify that the requested changes are present or correct; inspect the main workspace manually before claiming success.`);
      return this.inspect(group.executionId, task.taskId);
    } catch (error) {
      if (command.status !== "failed") {
        command.status = "failed";
        command.error = messageOf(error);
      }
      if (task.state !== "conflicted") transitionTaskState(task, "paused_recoverable");
      task.error = messageOf(error);
      await this.save(group);
      throw error;
    } finally {
      release();
      this.updateIndicator();
    }
  }

  async markClean(): Promise<{ cleared: boolean; paths: string[] }> {
    const gate = this.conflictGate;
    if (!gate) return { cleared: false, paths: [] };
    const unresolved = await unresolvedConflictMarkers(gate.sourceRoot, gate.paths);
    if (unresolved.length > 0) {
      throw new Error(`Conflict markers remain in: ${unresolved.join(", ")}`);
    }
    const group = this.groups.get(gate.executionId);
    const task = group?.tasks.find((candidate) => candidate.taskId === gate.taskId);
    if (task) {
      transitionTaskState(task, "landed");
      task.summary = "Conflict resolution was validated and marked landed.";
      task.updatedAt = new Date().toISOString();
      await this.save(group!);
    }
    const baseline = activeExchangeBaseline(this.input.state);
    if (baseline && gate.paths.length > 0) {
      const resolved = await createWorkspaceSnapshot(gate.sourceRoot, {
        maxFileBytes: this.input.config.maxFileBytes,
        maxSnapshotBytes: this.input.config.maxSnapshotBytes,
        reuseUnchangedFrom: baseline,
      });
      checkpointReviewWindow(this.input.state, selectiveCheckpoint(baseline, baseline, baseline, resolved, gate.paths, gate.sourceRoot));
    }
    this.conflictGate = undefined;
    this.releaseConflictBlock?.();
    this.releaseConflictBlock = undefined;
    await this.publishAssociations();
    if (task) {
      addActivity(task, "landed", "Conflict resolution validated; queued landing attempts released.");
      await this.save(group!);
      await this.wake(task, "completion", `Task ${task.taskId} conflict resolution was validated and landed.`);
    }
    this.updateIndicator();
    return { cleared: true, paths: [...gate.paths] };
  }

  criticalPrompt(): string | undefined {
    const gate = this.conflictGate;
    if (!gate) return undefined;
    return [
      "CRITICAL REVIEW-GATE WORKSPACE CONFLICT:",
      `Execution ${gate.executionId}, task ${gate.taskId} materialized merge-conflict markers in the main workspace.`,
      `Conflicted paths: ${gate.paths.join(", ")}.`,
      "Automatic task landings are blocked. Resolve these files now, verify the workspace, then call SubtasksMarkClean.",
      "Do not claim the workspace is clean or continue unrelated source mutations while this gate remains active.",
    ].join("\n");
  }

  async shutdown(): Promise<void> {
    this.shuttingDown = true;
    for (const group of this.groups.values()) {
      for (const task of group.tasks) {
        if (!isActiveTaskState(task.state)) continue;
        transitionTaskState(task, "stopped_for_application_exit");
        task.summary = this.runtimes.has(task.taskId)
          ? "Stopping executor for application shutdown."
          : "Queued task stopped before dispatch for application shutdown.";
        task.updatedAt = new Date().toISOString();
      }
      await this.save(group);
    }
    for (const runtime of this.runtimes.values()) {
      runtime.abort.abort(new Error("session_shutdown"));
    }
    await Promise.allSettled([...this.runtimes.values()].map((runtime) => runtime.promise));
    await Promise.all([...this.saveTails.values()].map((tail) => tail.catch(() => undefined)));
    await this.cleanupSettledArtifacts();
    this.updateIndicator();
  }

  async cleanupSettledArtifacts(): Promise<void> {
    for (const [executionId, group] of [...this.groups]) {
      const settled = group.tasks.filter((task) => task.state === "landed" || task.state === "reported");
      for (const task of settled) {
        if (task.waveRoot) await removeOwnedWaveRoot(task.waveRoot);
        task.waveRoot = undefined;
        task.bundle = undefined;
        task.result = undefined;
      }
      if (settled.length === group.tasks.length) {
        await removeOwnedExecutionRoot(group.root);
        this.groups.delete(executionId);
      } else if (settled.length > 0) {
        await this.save(group);
      }
    }
    await this.publishAssociations();
  }

  async detach(): Promise<void> {
    this.groups.clear();
    this.runtimes.clear();
    this.active = 0;
    this.shuttingDown = false;
    this.pumpRequested = false;
    this.conflictGate = undefined;
    this.releaseConflictBlock?.();
    this.releaseConflictBlock = undefined;
    this.updateIndicator();
  }

  private async pump(): Promise<void> {
    if (this.shuttingDown) return;
    if (this.pumping) {
      this.pumpRequested = true;
      return;
    }
    this.pumping = true;
    try {
      const maxWorkers = this.input.config.execution?.maxWorkers ?? 4;
      while (this.active < maxWorkers) {
        let launched = false;
        for (const queued of this.queuedTasks()) {
          const route = resolvedWorkerRoute(this.input.config, queued.group.kind);
          if (route.length === 0) continue;
          const requiredEntry = queued.task.pendingContinuation
            ? await continuationEntryId(queued.task).catch(() => undefined)
            : undefined;
          const lease = requiredEntry && route.some((entry) => entry.entryId === requiredEntry)
            ? this.pool.tryAcquireRouteEntry(requiredEntry, route)
            : this.pool.tryAcquireRoute(route);
          if (!lease) continue;
          const currentConfigDigest = configDigest(this.input.config);
          const settingsChanged = Boolean(
            queued.task.pendingContinuation
            && queued.task.lastRuntimeConfigDigest
            && queued.task.lastRuntimeConfigDigest !== currentConfigDigest,
          );
          const executorChanged = Boolean(requiredEntry && lease.entry.entryId !== requiredEntry);
          if (settingsChanged || executorChanged) {
            const warning = executorChanged
              ? `Current /review-settings no longer selects prior executor ${requiredEntry}; restarting ${queued.task.taskId} with ${lease.entry.entryId} from its durable checkpoint may change behavior.`
              : `Current /review-settings differ from the settings used by the prior ${queued.task.taskId} run; the restart will use the current values and may behave differently.`;
            queued.task.summary = warning;
            addActivity(queued.task, "configuration", warning);
            await this.save(queued.group);
            await this.input.notify?.(`review gate: ${warning}`);
          }
          queued.task.lastRuntimeConfigDigest = currentConfigDigest;
          this.launch(queued.group, queued.task, lease);
          launched = true;
          break;
        }
        if (!launched) break;
      }
    } finally {
      this.pumping = false;
      if (this.pumpRequested && !this.shuttingDown) {
        this.pumpRequested = false;
        void this.pump();
      }
    }
  }

  private launch(group: BackgroundExecutionGroup, task: BackgroundTaskRecord, lease: ExecutorPoolLease): void {
    const abort = new AbortController();
    this.active += 1;
    const executionActiveBeforeLaunch = group.tasks.filter((candidate) => this.runtimes.has(candidate.taskId)).length;
    group.peakConcurrency = Math.max(group.peakConcurrency ?? 0, executionActiveBeforeLaunch + 1);
    task.executorEntryId = lease.entry.entryId;
    const promise = (group.kind === "research"
      ? task.pendingContinuation
        ? this.runResearchContinuation(group, task, abort, lease)
        : this.runResearchFresh(group, task, abort, lease)
      : task.pendingContinuation
        ? this.runContinuation(group, task, abort, lease)
        : this.runFresh(group, task, abort, lease))
      .catch(async (error) => {
        if (task.interruptionMode) {
          this.failUndeliveredSteering(task, "Task was interrupted before the queued steering instruction was delivered.");
          transitionTaskState(task, "interrupted");
          task.error = undefined;
          task.summary = `Executor acknowledged ${task.interruptionMode} during startup or capture; its writer is quiesced.`;
          addActivity(task, "interrupt", task.summary);
        } else {
          this.failUndeliveredSteering(task, "Task failed before the queued steering instruction was delivered.");
          if (task.state !== "stopped_for_application_exit") transitionTaskState(task, "failed");
          task.error = messageOf(error);
          task.summary = `Background controller failure: ${task.error}`;
        }
        task.updatedAt = new Date().toISOString();
        await this.save(group);
        if (!task.interruptionMode) await this.wake(task, "failure", task.summary);
      })
      .finally(() => {
        // executeWave/continuation owns normal lease release. This is idempotent
        // and covers failures before ownership was handed down.
        lease.release();
        this.runtimes.delete(task.taskId);
        this.active = Math.max(0, this.active - 1);
        this.updateIndicator();
        void this.pump();
      });
    this.runtimes.set(task.taskId, { abort, promise, controlStatus: "pending" });
    this.updateIndicator();
  }

  private async runResearchFresh(
    group: BackgroundExecutionGroup,
    task: BackgroundTaskRecord,
    abort: AbortController,
    lease: ExecutorPoolLease,
  ): Promise<void> {
    await this.incorporatePrestartSteering(group, task);
    task.generation += 1;
    const priorState = transitionTaskState(task, "capturing");
    addActivity(task, "capturing", "Capturing a stable private workspace for read-only research.");
    await this.save(group);
    const activation = stateTransitionNotice(task, priorState, task.state);
    if (activation) await this.wake(task, "state", activation);

    const discovery = await discoverWaveSource(group.cwd, abort.signal);
    const releaseCapture = await sourceMutationCoordinator.acquire(discovery.captureRoot, abort.signal);
    let capture;
    try {
      capture = await captureWaveBase({
        cwd: group.cwd,
        maxSnapshotBytes: this.input.config.maxSnapshotBytes,
        artifactTtlMs: this.input.config.retainBundles === "always" ? 0 : this.input.config.waveArtifactTtlMs,
        signal: abort.signal,
      });
    } finally {
      releaseCapture();
    }
    task.waveRoot = capture.waveRoot;
    await this.save(group);
    await this.publishAssociations();
    const worktree = await createWorkerWorktree(capture, task.taskId, abort.signal);
    const artifactDir = join(capture.waveRoot, "artifacts", task.taskId);
    const result = await this.runResearchWorker(group, task, abort, lease, worktree, artifactDir, false);
    await this.finishResearch(group, task, result, artifactDir);
  }

  private async runResearchContinuation(
    group: BackgroundExecutionGroup,
    task: BackgroundTaskRecord,
    abort: AbortController,
    lease: ExecutorPoolLease,
  ): Promise<void> {
    if (!task.waveRoot || !task.researchResult?.candidate) {
      throw new Error("Research continuation requires its persisted private workspace and prior candidate checkpoint.");
    }
    const pending = task.pendingContinuation!;
    pending.instructions = await this.incorporateContinuationSteering(group, task, pending.instructions);
    const command = task.commands.find((candidate) => candidate.instructionId === pending.instructionId)!;
    task.pendingContinuation = undefined;
    task.generation += 1;
    const previous = transitionTaskState(task, "running");
    command.status = "delivered";
    command.deliveredAt = new Date().toISOString();
    addActivity(task, "running", `Continuing research from its durable session (${pending.instructionId}).`);
    await this.save(group);
    const activation = stateTransitionNotice(task, previous, task.state);
    if (activation) await this.wake(task, "state", activation);
    try {
      const capture = await readWaveCaptureRecord(task.waveRoot);
      const worktree = researchWorktree(capture, task.taskId);
      const artifactDir = join(capture.waveRoot, "artifacts", task.taskId);
      const result = await this.runResearchWorker(
        group,
        task,
        abort,
        lease,
        worktree,
        artifactDir,
        true,
        researchContinuationInstruction(pending.instructions),
      );
      command.status = "acknowledged";
      command.acknowledgedAt = new Date().toISOString();
      await this.finishResearch(group, task, result, artifactDir);
    } catch (error) {
      command.status = "failed";
      command.error = messageOf(error);
      throw error;
    }
  }

  private async runResearchWorker(
    group: BackgroundExecutionGroup,
    task: BackgroundTaskRecord,
    abort: AbortController,
    lease: ExecutorPoolLease,
    worktree: WorkerWorktree,
    artifactDir: string,
    continuation: boolean,
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
      config: this.input.config,
      sourceRoot: capture.discovery.captureRoot,
      sourceRootAliases: [group.cwd],
      scopedModels: this.scopedModels,
      signal: abort.signal,
      executorAssignment: currentLease,
      acquireFailover: async (currentAssignment: ExecutorPoolAssignment) => {
        currentLease.release();
        const next = await this.pool.acquireAfterRoute(
          currentAssignment,
          () => resolvedWorkerRoute(this.input.config, "research"),
          abort.signal,
        );
        if (next) currentLease = next;
        return next;
      },
      onLiveControl: (control: ExecutorLiveControl | undefined) => {
        const runtime = this.runtimes.get(task.taskId);
        if (!runtime) return;
        runtime.control = control;
        runtime.controlStatus = control ? "registered" : "closed";
        if (control) void this.flushQueuedSteering(group, task, runtime, control).catch((error) => {
          void this.input.notify?.(`review gate: queued research steering delivery failed: ${messageOf(error)}`);
        });
      },
      takeDeferredSteering: () => this.takeDeferredSteering(group, task),
      onUpdate: (update: import("./types").SubtaskProgressUpdate) => this.researchProgress(group, task, update),
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

  private researchProgress(
    group: BackgroundExecutionGroup,
    task: BackgroundTaskRecord,
    update: import("./types").SubtaskProgressUpdate,
  ): void {
    const next = update.phase === "starting" || update.phase === "executing" || update.phase === "correcting"
      ? "running"
      : undefined;
    const previous = next ? transitionTaskState(task, next) : task.state;
    addActivity(task, `research:${update.phase}`, update.message);
    const saved = this.save(group);
    void saved.catch((error) => this.input.notify?.(`review gate: failed to persist research progress: ${messageOf(error)}`));
    const transition = next ? stateTransitionNotice(task, previous, next) : undefined;
    const snapshot = transition ? transitionEventSnapshot(group, task) : undefined;
    if (transition) void saved.then((persisted) => {
      synchronizeEventSnapshot(snapshot!, persisted);
      return this.wake(task, "state", transition, snapshot);
    }).catch(() => undefined);
    this.updateIndicator();
  }

  private async finishResearch(
    group: BackgroundExecutionGroup,
    task: BackgroundTaskRecord,
    result: WaveWorkerResult,
    artifactDir: string,
  ): Promise<void> {
    task.researchResult = result;
    task.bundle = result.bundle;
    task.summary = result.summary;
    task.error = result.error;
    const undelivered = this.failUndeliveredSteering(task, "The research turn ended before queued steering reached a verified transport.");
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
      addActivity(task, "research:policy_failure", task.error);
      await this.wake(task, "failure", `Research task ${task.taskId} violated its read-only workspace contract. Its private changes were quarantined and main is unchanged.`);
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
      const persisted = await this.save(group);
      await this.publishAssociations();
      synchronizeEventSnapshot(snapshot, persisted);
      await this.wake(task, "completion", formatResearchCompletion(task.taskId, report, task.reportPath), snapshot);
      this.updateIndicator();
      return;
    } else if (result.status === "cancelled" || task.interruptionMode) {
      transitionTaskState(task, "interrupted");
      task.summary = "Research worker was interrupted; its private workspace was not landed.";
      await this.acknowledgeInterrupt(task);
    } else {
      transitionTaskState(task, result.bundle ? "paused_recoverable" : "failed");
      task.error = undelivered.length > 0
        ? `${undelivered.length} queued steering instruction(s) were not applied.`
        : result.error ?? "Research worker did not produce a usable report.";
      task.summary = task.error;
      await this.wake(task, "failure", `Research task ${task.taskId} stopped without a usable report: ${task.error}`);
    }
    task.updatedAt = new Date().toISOString();
    await this.save(group);
    await this.publishAssociations();
    this.updateIndicator();
  }

  private async runFresh(
    group: BackgroundExecutionGroup,
    task: BackgroundTaskRecord,
    abort: AbortController,
    lease: ExecutorPoolLease,
  ): Promise<void> {
    const reviewWindowId = this.input.state.reviewWindow?.id;
    const parentBaseline = activeExchangeBaseline(this.input.state);
    const preTaskSnapshot = parentBaseline ? await createWorkspaceSnapshot(group.cwd, {
      maxFileBytes: this.input.config.maxFileBytes,
      maxSnapshotBytes: this.input.config.maxSnapshotBytes,
      reuseUnchangedFrom: parentBaseline,
    }) : undefined;
    await this.incorporatePrestartSteering(group, task);
    task.generation += 1;
    const priorState = transitionTaskState(task, "capturing");
    addActivity(task, "capturing", "Capturing an independent task base from current main.");
    await this.save(group);
    const activation = stateTransitionNotice(task, priorState, task.state);
    if (activation) await this.wake(task, "state", activation);

    const result = await executeWave({
      cwd: group.cwd,
      tasks: [task.definition],
      taskIds: [task.taskId],
      config: this.input.config,
      scopedModels: this.scopedModels,
      maxWorkers: 1,
      independentLanding: true,
      signal: abort.signal,
      executorPool: this.pool,
      initialExecutorLeases: [lease],
      onWaveCreated: async (waveRoot) => {
        task.waveRoot = waveRoot;
        await this.save(group);
        await this.publishAssociations();
      },
      onProgress: (update) => this.progress(group, task, update),
      onLiveControl: (_taskId, control) => {
        const runtime = this.runtimes.get(task.taskId);
        if (!runtime) return;
        runtime.control = control;
        runtime.controlStatus = control ? "registered" : "closed";
        if (control) void this.flushQueuedSteering(group, task, runtime, control).catch((error) => {
          void this.input.notify?.(`review gate: queued steering delivery failed: ${messageOf(error)}`);
        });
      },
      takeDeferredSteering: () => this.takeDeferredSteering(group, task),
      onLandingConflict: async ({ capture, plan }) => {
        const materialized = await materializeLandingConflicts(capture, plan, `subtask ${task.taskId}`);
        await this.checkpointParent(reviewWindowId, parentBaseline, preTaskSnapshot, group.cwd, materialized.appliedPaths);
        this.conflictGate = {
          executionId: group.executionId,
          taskId: task.taskId,
          sourceRoot: group.cwd,
          paths: materialized.paths,
          activatedAt: new Date().toISOString(),
          manifestPath: materialized.manifestPath,
          reason: `Task ${task.taskId} requires immediate conflict resolution.`,
        };
        this.releaseConflictBlock = sourceMutationCoordinator.block(group.cwd, this.conflictGate.reason);
        transitionTaskState(task, "conflicted");
        addActivity(task, "conflicted", `Conflict markers materialized in ${materialized.paths.join(", ")}.`);
        await this.save(group);
        await this.publishAssociations();
        await this.wake(task, "failure", this.criticalPrompt()!);
      },
    });
    task.result = result;
    const undeliveredSteering = this.failUndeliveredSteering(task, "The executor turn ended before the queued steering instruction reached a verified transport.");
    const worker = result.taskResults[0];
    task.bundle = worker?.bundle;
    task.summary = worker?.summary;
    task.error = worker?.error;
    if (isStoppedForExit(task) && result.landing?.status !== "landed") {
      task.summary = "Executor stopped for application shutdown; the durable checkpoint must be verified before resume.";
      task.updatedAt = new Date().toISOString();
      await this.save(group);
      await this.publishAssociations();
      return;
    }
    if (result.landing?.status === "landed") {
      const paths = [...(result.landing.appliedPaths ?? []), ...(result.landing.alreadyAppliedPaths ?? [])];
      await this.checkpointParent(reviewWindowId, parentBaseline, preTaskSnapshot, group.cwd, paths);
      transitionTaskState(task, "landed");
      const completionSnapshot = transitionEventSnapshot(group, task);
      this.updateIndicator();
      const persisted = await this.save(group);
      await this.publishAssociations();
      synchronizeEventSnapshot(completionSnapshot, persisted);
      await this.wake(
        task,
        undeliveredSteering.length > 0 ? "failure" : "completion",
        undeliveredSteering.length > 0
          ? `Task ${task.taskId} landed, but ${undeliveredSteering.length} queued steering instruction(s) were not applied.`
          : `Task ${task.taskId} landed independently in the main workspace.`,
        completionSnapshot,
      );
    } else if (result.landing?.status === "conflicted") {
      transitionTaskState(task, "conflicted");
      task.summary = this.conflictGate
        ? `Merge conflict requires immediate resolution: ${this.conflictGate.paths.join(", ")}.`
        : "Landing conflict could not be materialized automatically; inspect full diagnostics before modifying main.";
    } else if (result.phase === "aborted") {
      transitionTaskState(task, task.interruptionMode ? "interrupted" : "paused_recoverable");
      task.summary = task.interruptionMode
        ? `Executor acknowledged ${task.interruptionMode}.`
        : "Executor stopped with a recoverable checkpoint.";
      await this.acknowledgeInterrupt(task);
    } else {
      transitionTaskState(task, worker?.bundle ? "paused_recoverable" : "failed");
      await this.wake(task, "failure", `Task ${task.taskId} failed: ${task.error ?? task.summary ?? "unknown failure"}`);
    }
    task.updatedAt = new Date().toISOString();
    await this.save(group);
    await this.publishAssociations();
    this.updateIndicator();
  }

  private async runContinuation(
    group: BackgroundExecutionGroup,
    task: BackgroundTaskRecord,
    abort: AbortController,
    lease: ExecutorPoolLease,
  ): Promise<void> {
    const reviewWindowId = this.input.state.reviewWindow?.id;
    const parentBaseline = activeExchangeBaseline(this.input.state);
    const preTaskSnapshot = parentBaseline ? await createWorkspaceSnapshot(group.cwd, {
      maxFileBytes: this.input.config.maxFileBytes,
      maxSnapshotBytes: this.input.config.maxSnapshotBytes,
      reuseUnchangedFrom: parentBaseline,
    }) : undefined;
    const pending = task.pendingContinuation!;
    pending.instructions = await this.incorporateContinuationSteering(group, task, pending.instructions);
    const command = task.commands.find((candidate) => candidate.instructionId === pending.instructionId)!;
    task.pendingContinuation = undefined;
    task.generation += 1;
    const priorState = transitionTaskState(task, "running");
    command.status = "delivered";
    command.deliveredAt = new Date().toISOString();
    addActivity(task, "running", `Continuing from durable checkpoint (${pending.instructionId}).`);
    await this.save(group);
    const activation = stateTransitionNotice(task, priorState, task.state);
    if (activation) await this.wake(task, "state", activation);
    try {
      const result = await continueOperation({
        bundle: task.bundle!,
        instructions: pending.instructions,
        instructionId: pending.instructionId,
        config: this.input.config,
        scopedModels: this.scopedModels,
        signal: abort.signal,
        executorAssignment: lease,
        executorPool: this.pool,
        onLiveControl: (control) => {
          const runtime = this.runtimes.get(task.taskId);
          if (!runtime) return;
          runtime.control = control;
          runtime.controlStatus = control ? "registered" : "closed";
          if (control) void this.flushQueuedSteering(group, task, runtime, control).catch((error) => {
            void this.input.notify?.(`review gate: queued steering delivery failed: ${messageOf(error)}`);
          });
        },
        takeDeferredSteering: () => this.takeDeferredSteering(group, task),
        onLandingConflict: async ({ capture, plan }) => {
          const materialized = await materializeLandingConflicts(capture, plan, `continued subtask ${task.taskId}`);
          await this.checkpointParent(reviewWindowId, parentBaseline, preTaskSnapshot, group.cwd, materialized.appliedPaths);
          this.activateConflictGate(group, task, materialized.paths, materialized.manifestPath, `Continued task ${task.taskId} requires immediate conflict resolution.`);
          addActivity(task, "conflicted", `Conflict markers materialized in ${materialized.paths.join(", ")}.`);
          await this.save(group);
          await this.publishAssociations();
          await this.wake(task, "failure", this.criticalPrompt()!);
        },
        onUpdate: (update) => this.continuationProgress(group, task, update),
      });
      task.bundle = result.inspection.bundle;
      const undeliveredSteering = this.failUndeliveredSteering(task, "The continuation ended before the queued steering instruction reached a verified transport.");
      command.status = "acknowledged";
      command.acknowledgedAt = new Date().toISOString();
      if (isStoppedForExit(task) && result.landing?.status !== "landed") {
        task.summary = "Continued executor stopped for application shutdown; inspect its checkpoint after restore.";
        return;
      }
      if (result.landing?.status === "landed") {
        task.summary = "Continued task landed independently in the main workspace.";
        const paths = [...(result.landing.appliedPaths ?? []), ...(result.landing.alreadyAppliedPaths ?? [])];
        await this.checkpointParent(reviewWindowId, parentBaseline, preTaskSnapshot, group.cwd, paths);
        transitionTaskState(task, "landed");
        const completionSnapshot = transitionEventSnapshot(group, task);
        this.updateIndicator();
        const persisted = await this.save(group);
        await this.publishAssociations();
        synchronizeEventSnapshot(completionSnapshot, persisted);
        await this.wake(
          task,
          undeliveredSteering.length > 0 ? "failure" : "completion",
          undeliveredSteering.length > 0
              ? `Task ${task.taskId} continuation landed, but ${undeliveredSteering.length} queued steering instruction(s) were not applied.`
              : `Task ${task.taskId} continuation landed.`,
          completionSnapshot,
        );
      } else if (result.landing?.status === "conflicted") {
        transitionTaskState(task, "conflicted");
        task.summary = this.conflictGate
          ? `Merge conflict requires immediate resolution: ${this.conflictGate.paths.join(", ")}.`
          : "Continuation landing conflict could not be materialized automatically; inspect full diagnostics.";
      } else {
        transitionTaskState(task, result.lifecycle?.status === "cancelled" ? "interrupted" : "paused_recoverable");
        task.summary = result.lifecycle?.summary ?? result.inspection.record.state;
        task.error = result.lifecycle?.error;
        if (task.state !== "interrupted") await this.wake(task, "failure", `Task ${task.taskId} continuation stopped: ${task.error ?? task.summary}`);
      }
    } catch (error) {
      command.status = "failed";
      command.error = messageOf(error);
      throw error;
    } finally {
      task.updatedAt = new Date().toISOString();
      await this.save(group);
      await this.publishAssociations();
      this.updateIndicator();
    }
  }

  private activateConflictGate(
    group: BackgroundExecutionGroup,
    task: BackgroundTaskRecord,
    paths: string[],
    manifestPath: string,
    reason: string,
  ): void {
    this.releaseConflictBlock?.();
    this.conflictGate = {
      executionId: group.executionId,
      taskId: task.taskId,
      sourceRoot: group.cwd,
      paths,
      activatedAt: new Date().toISOString(),
      manifestPath,
      reason,
    };
    this.releaseConflictBlock = sourceMutationCoordinator.block(group.cwd, reason);
    transitionTaskState(task, "conflicted");
  }

  private progress(group: BackgroundExecutionGroup, task: BackgroundTaskRecord, update: WaveProgressUpdate): void {
    const next = stateFromWaveProgress(update);
    const previous = next ? transitionTaskState(task, next) : task.state;
    if (!next) task.updatedAt = new Date().toISOString();
    this.updateReviewStatus(task, update, next);
    for (const message of update.activity ?? [update.message]) addActivity(task, update.phase, message);
    const saved = this.save(group);
    void saved.catch((error) => this.input.notify?.(`review gate: failed to persist task progress: ${messageOf(error)}`));
    const transition = next ? stateTransitionNotice(task, previous, next) : undefined;
    const snapshot = transition ? transitionEventSnapshot(group, task) : undefined;
    if (transition) void saved.then((persisted) => {
      synchronizeEventSnapshot(snapshot!, persisted);
      return this.wake(task, "state", transition, snapshot);
    }).catch(() => undefined);
    this.updateIndicator();
  }

  private updateReviewStatus(
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

  private continuationProgress(group: BackgroundExecutionGroup, task: BackgroundTaskRecord, update: ContinuationProgressUpdate): void {
    const next = stateFromContinuationProgress(update);
    const previous = transitionTaskState(task, next);
    addActivity(task, update.phase, update.message);
    task.updatedAt = new Date().toISOString();
    const saved = this.save(group);
    void saved.catch(() => undefined);
    const transition = stateTransitionNotice(task, previous, task.state);
    const snapshot = transition ? transitionEventSnapshot(group, task) : undefined;
    if (transition) void saved.then((persisted) => {
      synchronizeEventSnapshot(snapshot!, persisted);
      return this.wake(task, "state", transition, snapshot);
    }).catch(() => undefined);
    this.updateIndicator();
  }

  private async checkpointParent(
    reviewWindowId: number | undefined,
    taskBaseline: WorkspaceSnapshot | undefined,
    before: WorkspaceSnapshot | undefined,
    sourceRoot: string,
    landedPaths: string[],
  ): Promise<void> {
    if (!taskBaseline || !before || reviewWindowId === undefined || this.input.state.reviewWindow?.id !== reviewWindowId || landedPaths.length === 0) return;
    const after = await createWorkspaceSnapshot(sourceRoot, {
      maxFileBytes: this.input.config.maxFileBytes,
      maxSnapshotBytes: this.input.config.maxSnapshotBytes,
      reuseUnchangedFrom: before,
    });
    if (this.input.state.reviewWindow?.id !== reviewWindowId) return;
    const accumulatedBaseline = activeExchangeBaseline(this.input.state);
    if (!accumulatedBaseline) return;
    checkpointReviewWindow(this.input.state, selectiveCheckpoint(accumulatedBaseline, taskBaseline, before, after, landedPaths, sourceRoot));
  }

  private async acknowledgeInterrupt(task: BackgroundTaskRecord): Promise<void> {
    const command = [...task.commands].reverse().find((candidate) => candidate.action === "interrupt" && candidate.status === "delivered");
    if (!command) return;
    command.status = "acknowledged";
    command.acknowledgedAt = new Date().toISOString();
  }

  private async incorporatePrestartSteering(group: BackgroundExecutionGroup, task: BackgroundTaskRecord): Promise<void> {
    const pending = task.commands.filter((command) => command.action === "steer" && command.status === "queued" && command.text);
    if (pending.length === 0) return;
    const steering = pending.map((command) => `- ${command.text}`).join("\n");
    task.definition.instructions = `${task.definition.instructions}\n\nSteering received before executor startup (later instructions take precedence):\n${steering}`;
    const now = new Date().toISOString();
    for (const command of pending) {
      command.status = "acknowledged";
      command.deliveredAt = now;
      command.acknowledgedAt = now;
    }
    addActivity(task, "steer", `${pending.length} queued steering instruction(s) incorporated into the initial executor prompt.`);
    await this.save(group);
  }

  private async incorporateContinuationSteering(
    group: BackgroundExecutionGroup,
    task: BackgroundTaskRecord,
    instructions: string,
  ): Promise<string> {
    const pending = task.commands.filter((command) => command.action === "steer" && command.status === "queued" && command.text);
    if (pending.length === 0) return instructions;
    const steering = pending.map((command) => `- ${command.text}`).join("\n");
    const now = new Date().toISOString();
    for (const command of pending) {
      command.status = "acknowledged";
      command.deliveredAt = now;
      command.acknowledgedAt = now;
    }
    addActivity(task, "steer", `${pending.length} queued steering instruction(s) incorporated into continuation startup.`);
    await this.save(group);
    return `${instructions}\n\nSteering received before continuation startup (later instructions take precedence):\n${steering}`;
  }

  private failUndeliveredSteering(task: BackgroundTaskRecord, reason: string): BackgroundCommandRecord[] {
    const pending = task.commands.filter((command) => command.action === "steer" && command.status === "queued");
    for (const command of pending) {
      command.status = "failed";
      command.error = reason;
    }
    if (pending.length > 0) addActivity(task, "steer", `${pending.length} steering instruction(s) failed: ${reason}`);
    return pending;
  }

  private async takeDeferredSteering(
    group: BackgroundExecutionGroup,
    task: BackgroundTaskRecord,
  ): Promise<Array<{ instruction: string; instructionId: string }>> {
    const pending = task.commands.filter((command) => command.action === "steer" && command.status === "queued" && command.text);
    if (pending.length === 0) return [];
    const now = new Date().toISOString();
    for (const command of pending) {
      command.status = "acknowledged";
      command.deliveredAt = now;
      command.acknowledgedAt = now;
      command.error = undefined;
    }
    addActivity(task, "steer", `${pending.length} deferred steering instruction(s) claimed for the next executor turn.`);
    await this.save(group);
    return pending.map((command) => ({ instruction: command.text!, instructionId: command.instructionId }));
  }

  private async flushQueuedSteering(
    group: BackgroundExecutionGroup,
    task: BackgroundTaskRecord,
    runtime: RuntimeTask,
    control: ExecutorLiveControl,
  ): Promise<void> {
    const prior = this.steeringTails.get(task.taskId) ?? Promise.resolve();
    const next = prior.then(async () => {
      for (const command of task.commands) {
        if (command.action !== "steer" || command.status !== "queued" || !command.text) continue;
        if (!control.capabilities.steer) {
          command.error = undefined;
          addActivity(task, "steer", `The active ${control.adapter} turn cannot accept live steering; ${command.instructionId} remains queued for the next executor handoff.`);
          await this.save(group);
          continue;
        }
        command.status = "delivered";
        command.deliveredAt = new Date().toISOString();
        await this.save(group);
        const generation = task.generation;
        try {
          const acknowledgement = await control.steer(command.text, command.instructionId);
          if (task.generation !== generation || this.runtimes.get(task.taskId) !== runtime || task.state === "landed") {
            command.status = "failed";
            command.error = "Steering acknowledgement arrived after the targeted task generation ended.";
          } else {
            command.status = acknowledgement.status === "acknowledged" ? "acknowledged" : "failed";
            command.acknowledgedAt = acknowledgement.status === "acknowledged" ? new Date().toISOString() : undefined;
            command.error = acknowledgement.status === "acknowledged" ? undefined : acknowledgement.message;
            addActivity(task, "steer", `Steering ${acknowledgement.status}: ${acknowledgement.message}`);
          }
        } catch (error) {
          command.status = "failed";
          command.error = messageOf(error);
          addActivity(task, "steer", `Steering failed: ${command.error}`);
        }
        await this.save(group);
        if (command.status === "failed") {
          void this.wake(task, "failure", `Steering ${command.instructionId} was not applied: ${command.error ?? "unknown failure"}`);
        }
      }
    });
    this.steeringTails.set(task.taskId, next);
    try {
      await next;
    } finally {
      if (this.steeringTails.get(task.taskId) === next) this.steeringTails.delete(task.taskId);
    }
  }

  private async wake(
    task: BackgroundTaskRecord,
    kind: "completion" | "failure" | "state",
    content: string,
    eventSnapshot?: { group: BackgroundExecutionGroup; task: BackgroundTaskRecord },
  ): Promise<void> {
    if (kind === "state"
      && (this.input.config.execution?.subtaskNotifications ?? DEFAULT_SUBTASK_NOTIFICATION_MODE) === "quiet") {
      return;
    }
    const lane = kind === "state"
      ? "now"
      : kind === "completion"
        ? "soon"
        : "now";
    const owner = [...this.groups.values()].find((group) => group.tasks.some((candidate) => candidate.taskId === task.taskId));
    const eventOwner = eventSnapshot?.group ?? owner;
    const eventTask = eventSnapshot?.task ?? task;
    const scheduling = eventOwner
      ? this.schedulingSnapshot(eventOwner, kind === "completion" ? eventTask : undefined)
      : undefined;
    const eventContent = eventOwner ? formatExecutionEvent(eventOwner, eventTask, kind, content, scheduling) : content;
    const diagnostic = kind === "failure" && owner
      ? this.inspect(owner.executionId, task.taskId)
      : undefined;
    const deliveredContent = diagnostic
      ? `${eventContent}\n\nFull durable failure diagnostic:\n${JSON.stringify(diagnostic, null, 2)}`
      : eventContent;
    if (!isRecord(this.input.pi) || typeof this.input.pi.sendMessage !== "function") {
      await this.input.notify?.(deliveredContent);
      return;
    }
    const delivery = lane === "now"
      ? { deliverAs: "steer", triggerTurn: true }
      : lane === "soon"
        ? { deliverAs: "followUp", triggerTurn: true }
        : { deliverAs: "nextTurn" };
    try {
      this.input.pi.sendMessage({
        customType: "pi-review-subtask-event",
        content: deliveredContent,
        display: true,
        details: { executionId: eventOwner?.executionId, taskId: eventTask.taskId, state: eventTask.state, diagnostic },
      }, delivery);
    } catch (error) {
      await this.input.notify?.(`review gate: task notification could not be delivered: ${messageOf(error)}`);
    }
  }

  private queuedTasks(): Array<{ group: BackgroundExecutionGroup; task: BackgroundTaskRecord }> {
    const queued: Array<{ group: BackgroundExecutionGroup; task: BackgroundTaskRecord }> = [];
    for (const group of this.groups.values()) {
      for (const task of group.tasks) {
        if (task.state === "queued" && !this.runtimes.has(task.taskId)) queued.push({ group, task });
      }
    }
    return queued;
  }

  private schedulingSnapshot(group: BackgroundExecutionGroup, releasingTask?: BackgroundTaskRecord): BackgroundSchedulingSnapshot {
    const configuredWorkerLimit = this.input.config.execution?.maxWorkers ?? 4;
    const releasingEntryId = releasingTask && this.runtimes.has(releasingTask.taskId)
      ? releasingTask.executorEntryId
      : undefined;
    const releasingActiveWorker = releasingEntryId ? 1 : 0;
    const activeWorkers = Math.max(0, this.active - releasingActiveWorker);
    const pool = this.pool.capacitySnapshot(releasingEntryId);
    const availableWorkerSlots = Math.max(0, configuredWorkerLimit - activeWorkers);
    return {
      configuredWorkerLimit,
      configuredPoolCapacity: pool.totalCapacity,
      activeWorkers,
      activePoolLeases: pool.activeLeases,
      availableWorkerSlots,
      availablePoolSlots: pool.availableSlots,
      estimatedImmediatelyAvailableSlots: Math.min(availableWorkerSlots, pool.availableSlots),
      dispatchPending: group.tasks.filter((task) => task.state === "queued" && !this.runtimes.has(task.taskId)).length,
      dispatchAssigned: group.tasks.filter((task) => task.state === "queued" && this.runtimes.has(task.taskId)).length,
      globallyDispatchPending: this.queuedTasks().length,
    };
  }

  private resolveGroup(executionId?: string): BackgroundExecutionGroup {
    if (executionId) {
      const group = this.groups.get(executionId);
      if (!group) throw new Error(`Unknown execution group ${executionId}.`);
      return group;
    }
    if (this.groups.size !== 1) throw new Error(`Specify executionId; ${this.groups.size} execution groups are associated with this conversation.`);
    return [...this.groups.values()][0]!;
  }

  private resolveTask(executionId?: string, taskId?: string, bundle?: ReattachmentBundle): { group: BackgroundExecutionGroup; task: BackgroundTaskRecord } {
    const candidates: Array<{ group: BackgroundExecutionGroup; task: BackgroundTaskRecord }> = [];
    for (const group of this.groups.values()) {
      if (executionId && group.executionId !== executionId) continue;
      for (const task of group.tasks) {
        if (taskId && task.taskId !== taskId) continue;
        if (bundle && task.bundle?.operationId !== bundle.operationId) continue;
        candidates.push({ group, task });
      }
    }
    if (candidates.length !== 1) throw new Error(`Task target is ${candidates.length === 0 ? "unknown" : "ambiguous"}; supply stable executionId and taskId.`);
    return candidates[0]!;
  }

  private async save(group: BackgroundExecutionGroup): Promise<PersistedGroupRevision> {
    group.revision += 1;
    group.updatedAt = new Date().toISOString();
    const snapshot = JSON.parse(JSON.stringify(group)) as BackgroundExecutionGroup;
    const unsigned = { ...snapshot, integritySha256: undefined };
    snapshot.integritySha256 = createHash("sha256").update(JSON.stringify(unsigned)).digest("hex");
    group.integritySha256 = snapshot.integritySha256;
    const prior = this.saveTails.get(group.executionId) ?? Promise.resolve();
    const next = prior.then(() => atomicWrite(join(group.root, "execution.json"), `${JSON.stringify(snapshot, null, 2)}\n`));
    this.saveTails.set(group.executionId, next.catch(() => undefined));
    await next;
    return {
      revision: snapshot.revision,
      updatedAt: snapshot.updatedAt,
      peakConcurrency: snapshot.peakConcurrency ?? 0,
      integritySha256: snapshot.integritySha256,
    };
  }

  private async publishAssociations(): Promise<void> {
    await this.input.onAssociationsChanged?.(this.associations());
  }

  private updateIndicator(): void {
    const ctx = this.uiContext;
    if (!isRecord(ctx) || !isRecord(ctx.ui) || typeof ctx.ui.setWidget !== "function") return;
    const live = [...this.groups.values()].flatMap((group) => group.tasks).filter((task) => isActiveTaskState(task.state));
    try {
      if (this.expandedView) {
        const all = [...this.groups.values()]
          .flatMap((group) => group.tasks.map((task) => ({ group, task })))
          .sort((left, right) => right.task.updatedAt.localeCompare(left.task.updatedAt));
        const activeTasks = all.filter(({ task }) => isActiveTaskState(task.state));
        const shown = activeTasks.slice(0, 16);
        const lines = [
          `⟳ ${live.length} active background subtask${live.length === 1 ? "" : "s"} — expanded live view (/subtasks-view to collapse)`,
        ];
        if (this.conflictGate) lines.push(`CRITICAL conflict: ${this.conflictGate.paths.join(", ")}`);
        if (shown.length === 0) lines.push("  No active background subtasks.");
        for (const { group, task } of shown) {
          const reviewers = task.reviewStatus
            ? ` · reviewers ${task.reviewStatus.reviewers.join(", ") || "none"} (${task.reviewStatus.phase})`
            : "";
          const command = task.commands.at(-1);
          const latestCommand = command ? ` · ${command.action} ${command.status}` : "";
          lines.push(`  ${group.kind} · ${task.definition.title} [${task.state}] · ${executorDisplayLabel(task, this.input.config, group.kind)}${reviewers}${latestCommand}`);
        }
        if (activeTasks.length > shown.length) lines.push(`  … ${activeTasks.length - shown.length} additional active task${activeTasks.length - shown.length === 1 ? "" : "s"} omitted`);
        const recent = all
          .flatMap(({ task }) => task.activity.map((event) => ({ task, event })))
          .sort((left, right) => left.event.at.localeCompare(right.event.at))
          .slice(-10);
        lines.push("  Recent activity (10 newest events across all tasks):");
        if (recent.length === 0) lines.push("    no activity recorded yet");
        for (const { task, event } of recent) {
          lines.push(`    ${task.definition.title} · ${event.phase} · ${clipActivity(event.message)}`);
        }
        ctx.ui.setWidget("review-gate-subtasks", () => liveViewComponent(lines), { placement: "belowEditor" });
        return;
      }
      if (live.length === 0 && !this.conflictGate) {
        ctx.ui.setWidget("review-gate-subtasks", undefined, { placement: "belowEditor" });
        return;
      }
      const detail = this.conflictGate
        ? `CRITICAL conflict: ${this.conflictGate.paths.join(", ")}`
        : [
            ...live.slice(0, 3).map((task) => `${task.definition.title} (${task.state === "queued"
              ? this.runtimes.has(task.taskId) ? "queued: executor assigned/startup" : "queued: executor capacity wait"
              : task.state})`),
            ...(live.length > 3 ? [`+${live.length - 3} more`] : []),
          ].join(", ");
      ctx.ui.setWidget("review-gate-subtasks", [`⟳ ${live.length} background subtask${live.length === 1 ? "" : "s"} — ${detail}`], { placement: "belowEditor" });
    } catch {
      // UI surfaces are optional in print/headless harnesses.
    }
  }
}

function clipActivity(value: string, max = 180): string {
  const compact = value.replace(/\s+/g, " ").trim();
  return compact.length <= max ? compact : `${compact.slice(0, Math.max(1, max - 1))}…`;
}

const SHORT_RESEARCH_REPORT_MAX_CHARS = 900;
const RESEARCH_SUMMARY_MAX_CHARS = 240;

function formatResearchCompletion(taskId: string, report: string, reportPath: string): string {
  const trimmed = report.trim();
  const lines = [
    `Research task ${taskId} completed without workspace changes.`,
    `Full report: ${reportPath}`,
  ];
  if (trimmed.length <= SHORT_RESEARCH_REPORT_MAX_CHARS) {
    lines.push("Complete report:", trimmed);
    return lines.join("\n");
  }
  const declaredSummary = trimmed
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => /^Summary:\s+\S/i.test(line) && line.length <= RESEARCH_SUMMARY_MAX_CHARS + "Summary: ".length);
  lines.push("The report is too long to inline completely; no partial report excerpt is included.");
  if (declaredSummary) lines.push(declaredSummary);
  else lines.push("No bounded standalone summary was supplied; read the full report when its details are needed for synthesis.");
  return lines.join("\n");
}

function executorDisplayLabel(task: BackgroundTaskRecord, config: ReviewGateConfig, kind: BackgroundTaskKind = "execute"): string {
  if (!task.executorEntryId) return "executor pending";
  const entry = resolvedWorkerRoute(config, kind).find((candidate) => candidate.entryId === task.executorEntryId)
    ?? resolvedWorkerResources(config).find((candidate) => candidate.entryId === task.executorEntryId);
  if (!entry) return task.executorEntryId;
  if (entry.selection.source === "pi") return entry.selection.model;
  const externalId = entry.selection.id;
  const agent = externalAgentCatalog(config).find((candidate) => candidate.id === externalId);
  return agent && "model" in agent && typeof agent.model === "string" && agent.model
    ? agent.model
    : externalId;
}

function liveViewComponent(lines: readonly string[]): { render(width: number): string[]; invalidate(): void } {
  return {
    render: (width) => lines.map((line) => clipWidgetLine(line, Math.max(1, width))),
    invalidate() {},
  };
}

function clipWidgetLine(value: string, width: number): string {
  return value.length <= width ? value : `${value.slice(0, Math.max(1, width - 1))}…`;
}

function formatExecutionEvent(
  group: BackgroundExecutionGroup,
  task: BackgroundTaskRecord,
  kind: "completion" | "failure" | "state",
  content: string,
  scheduling?: BackgroundSchedulingSnapshot,
): string {
  const successState: BackgroundTaskState = group.kind === "research" ? "reported" : "landed";
  const successVerb = group.kind === "research" ? "reported" : "landed";
  const successful = group.tasks.filter((candidate) => candidate.state === successState);
  const incomplete = group.tasks.filter((candidate) => candidate.state !== successState);
  const active = group.tasks.filter((candidate) => isActiveTaskState(candidate.state));
  const title = task.definition.title;
  const lines = [
    content,
    "",
    `Task: ${task.taskId} · ${title} · ${task.state}`,
  ];
  if (kind !== "completion") lines.push(`Execution revision: ${group.revision}`);
  const landedPaths = [
    ...(task.result?.landing?.appliedPaths ?? []),
    ...(task.result?.landing?.alreadyAppliedPaths ?? []),
  ];
  if (landedPaths.length > 0) lines.push(`Landed paths: ${[...new Set(landedPaths)].join(", ")}`);
  if (kind === "completion") {
    if (scheduling) {
      const topOff = Math.max(0, scheduling.estimatedImmediatelyAvailableSlots - scheduling.globallyDispatchPending);
      lines.push(`Top-off opportunity: up to ${topOff} additional task(s) may be submitted with SubtasksAdd if planned work remains.`);
    }
  }
  if (incomplete.length === 0) {
    if (kind === "completion") {
      lines.push(`${group.kind === "research" ? "Research" : "Execution"} ${group.executionId} COMPLETE: ${successful.length}/${group.tasks.length} tasks ${successVerb}.`);
      lines.push(group.kind === "research"
        ? "All requested research reports are available; synthesis is now appropriate. Main was not modified by this research group."
        : "All requested task outputs have landed; aggregate verification is now appropriate.");
    } else if (kind === "failure") {
      lines.push(`${group.kind === "research" ? "Research" : "Execution"} ${group.executionId} has ${successful.length}/${group.tasks.length} tasks ${successVerb}, but this interaction reported a failure.`);
      lines.push(`Inspect the failed command and verify the ${group.kind === "research" ? "reports" : "landed output"} before treating the group as successful.`);
    } else {
      lines.push(`${group.kind === "research" ? "Research" : "Execution"} ${group.executionId} currently has ${successful.length}/${group.tasks.length} tasks ${successVerb}.`);
      lines.push("This is an informational state update; rely on the separate completion or failure event for the execution outcome.");
    }
    if (kind === "state") lines.push(noActionResponseNotice(task));
    return lines.join("\n");
  }
  const disposition = active.length > 0 ? "IN PROGRESS" : "INCOMPLETE";
  lines.push(`${group.kind === "research" ? "Research" : "Execution"} ${group.executionId} ${disposition}: ${successful.length}/${group.tasks.length} ${successVerb}; ${incomplete.length} not ${successVerb}.`);
  if (kind === "completion") {
    lines.push(`This is a partial task completion, not completion of the whole group. Do not claim outputs from tasks that have not ${successVerb}.`);
  } else if (kind === "failure") {
    lines.push("The whole execution is not successfully complete. Use the task handles and states below to recover deliberately.");
  }
  lines.push(`Tasks not yet ${successVerb}:`);
  for (const candidate of incomplete) {
    lines.push(`- ${candidate.taskId} · ${candidate.definition.title} · ${candidate.state}`);
  }
  if (kind === "state") lines.push(noActionResponseNotice(task));
  return lines.join("\n");
}

function noActionResponseNotice(task: BackgroundTaskRecord): string {
  return `NO TOOL ACTION IS NECESSARY unless you want to steer this task or the reported state requires recovery. This notification triggered a harness turn, so do not return an empty response. If no action is needed, reply briefly with: No action for ${task.taskId} at ${task.state.toUpperCase()}. Do not call inspect merely to acknowledge this event.`;
}

function transitionEventSnapshot(
  group: BackgroundExecutionGroup,
  task: BackgroundTaskRecord,
): { group: BackgroundExecutionGroup; task: BackgroundTaskRecord } {
  const tasks = group.tasks.map((candidate) => ({ ...candidate }));
  return {
    group: { ...group, tasks },
    task: tasks.find((candidate) => candidate.taskId === task.taskId)!,
  };
}

function synchronizeEventSnapshot(
  snapshot: { group: BackgroundExecutionGroup; task: BackgroundTaskRecord },
  persisted: PersistedGroupRevision,
): void {
  snapshot.group.revision = persisted.revision;
  snapshot.group.updatedAt = persisted.updatedAt;
  snapshot.group.peakConcurrency = persisted.peakConcurrency;
  snapshot.group.integritySha256 = persisted.integritySha256;
}

function stateTransitionNotice(
  task: BackgroundTaskRecord,
  previous: BackgroundTaskState,
  next: BackgroundTaskState,
): string | undefined {
  if (previous === next) return undefined;
  const transition = `Task ${task.taskId} changed state: ${previous.toUpperCase()} -> ${next.toUpperCase()}.`;
  if (next === "running") {
    return `${transition} The task is ACTIVE. Steering is available now; if live control is still starting or a long-running command is in progress, the instruction remains durably queued for the next executor handoff.`;
  }
  if (next === "reviewing") {
    return `${transition} The task is REVIEWING. A new steer takes priority: it interrupts the in-flight review and resumes the executor with the changed request before review restarts.`;
  }
  return undefined;
}

function newTask(definition: BackgroundTaskDefinition): BackgroundTaskRecord {
  const now = new Date().toISOString();
  return {
    taskId: `task-${randomUUID()}`,
    definition: JSON.parse(JSON.stringify(definition)) as BackgroundTaskDefinition,
    state: "queued",
    createdAt: now,
    updatedAt: now,
    generation: 0,
    activity: [],
    nextActivitySequence: 1,
    stateHistory: [{ sequence: 1, state: "queued", at: now, generation: 0 }],
    nextStateSequence: 2,
    commands: [],
  };
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

function researchWorktree(capture: WaveCaptureResult, taskId: string): WorkerWorktree {
  const worktreeRoot = join(capture.waveRoot, "workers", taskId);
  return {
    worktreeRoot,
    effectiveCwd: capture.discovery.relativeCwd === "."
      ? worktreeRoot
      : join(worktreeRoot, capture.discovery.relativeCwd),
  };
}

function transitionTaskState(task: BackgroundTaskRecord, next: BackgroundTaskState, at = new Date().toISOString()): BackgroundTaskState {
  const previous = task.state;
  task.updatedAt = at;
  if (previous === next) return previous;
  task.stateHistory ??= [{ sequence: 1, state: previous, at: task.createdAt, generation: task.generation }];
  task.nextStateSequence ??= (task.stateHistory.at(-1)?.sequence ?? 0) + 1;
  task.state = next;
  task.stateHistory.push({ sequence: task.nextStateSequence++, state: next, at, generation: task.generation });
  if (task.stateHistory.length > MAX_ACTIVITY) task.stateHistory.splice(0, task.stateHistory.length - MAX_ACTIVITY);
  return previous;
}

function taskTiming(task: BackgroundTaskRecord, now = Date.now()): BackgroundTaskTimingSummary {
  const history = task.stateHistory?.length
    ? task.stateHistory
    : [{ sequence: 1, state: task.state, at: task.createdAt, generation: task.generation }];
  const totals = { queueMs: 0, captureMs: 0, executionMs: 0, reviewMs: 0, landingMs: 0 };
  for (let index = 0; index < history.length; index += 1) {
    const transition = history[index]!;
    if (!isActiveTaskState(transition.state)) continue;
    const start = Date.parse(transition.at);
    const next = history[index + 1];
    const end = next ? Date.parse(next.at) : now;
    const elapsed = Number.isFinite(start) && Number.isFinite(end) ? Math.max(0, end - start) : 0;
    if (transition.state === "queued") totals.queueMs += elapsed;
    else if (transition.state === "capturing") totals.captureMs += elapsed;
    else if (transition.state === "running") totals.executionMs += elapsed;
    else if (transition.state === "reviewing") totals.reviewMs += elapsed;
    else totals.landingMs += elapsed;
  }
  const terminalAt = !isActiveTaskState(task.state) ? Date.parse(history.at(-1)?.at ?? task.updatedAt) : now;
  const createdAt = Date.parse(task.createdAt);
  return {
    ...totals,
    totalMs: Number.isFinite(createdAt) && Number.isFinite(terminalAt) ? Math.max(0, terminalAt - createdAt) : 0,
  };
}

function addActivity(task: BackgroundTaskRecord, phase: string, message: string): void {
  if (task.activity.at(-1)?.message === message) return;
  task.activity.push({ sequence: task.nextActivitySequence++, at: new Date().toISOString(), phase, message });
  if (task.activity.length > MAX_ACTIVITY) task.activity.splice(0, task.activity.length - MAX_ACTIVITY);
}

export function stateFromWaveProgress(update: WaveProgressUpdate): BackgroundTaskState | undefined {
  if (update.phase === "capturing") return "capturing";
  if (update.phase === "integrating" || update.phase === "planning") return "waiting_to_land";
  if (update.phase === "landing") return "landing";
  if (update.phase === "completed" || update.phase === "aborted" || update.phase === "settling") return undefined;
  const phase = update.subtask?.phase ?? update.taskStatuses?.[0]?.phase;
  const workerState = stateFromWorkerProgressPhase(phase);
  if (workerState) return workerState;
  if (update.phase === "working" && (phase === "accepted" || phase === "accepted_with_warnings" || phase === "completed_unreviewed" || phase === "no_changes")) return "accepted";
  return undefined;
}

export function stateFromContinuationProgress(update: ContinuationProgressUpdate): BackgroundTaskState {
  if (update.phase === "accepted") return "accepted";
  if (update.phase === "integrating") return "waiting_to_land";
  if (update.phase === "landing") return "landing";
  return stateFromWorkerProgressPhase(update.phase) ?? "running";
}

function stateFromWorkerProgressPhase(phase: SubtaskProgressPhase | string | undefined): BackgroundTaskState | undefined {
  if (phase === "reviewing") return "reviewing";
  if (phase === "starting" || phase === "executing" || phase === "correcting" || phase === "confirming" || phase === "completing") return "running";
  return undefined;
}

function isStoppedForExit(task: BackgroundTaskRecord): boolean {
  return task.state === "stopped_for_application_exit";
}

async function continuationEntryId(task: BackgroundTaskRecord): Promise<string | undefined> {
  if (task.executorEntryId) return task.executorEntryId;
  if (!task.bundle) return undefined;
  const inspection = await inspectOperation(task.bundle);
  const operation = await readOperationRecord(inspection.record.artifactDir + "/operation.json");
  return operation.assignments.at(-1)?.entryId;
}

async function readGroup(root: string): Promise<BackgroundExecutionGroup> {
  const resolved = await realpath(resolve(root));
  if (!basename(resolved).startsWith("pi-review-execution-")) throw new Error("Invalid background execution root.");
  const parsed = JSON.parse(await readFile(join(resolved, "execution.json"), "utf8")) as BackgroundExecutionGroup;
  if (parsed.version !== GROUP_VERSION || parsed.root !== resolved || !parsed.executionId || !Array.isArray(parsed.tasks)) {
    throw new Error("Invalid background execution manifest.");
  }
  const { integritySha256, ...unsigned } = parsed;
  const actual = createHash("sha256").update(JSON.stringify({ ...unsigned, integritySha256: undefined })).digest("hex");
  if (!integritySha256 || integritySha256 !== actual) throw new Error("Background execution manifest failed its integrity check.");
  for (const task of parsed.tasks) {
    delete (task as BackgroundTaskRecord & { matchedWakePatterns?: string[] }).matchedWakePatterns;
    delete (task.definition as BackgroundTaskDefinition & { wakeOn?: unknown }).wakeOn;
    if (!Array.isArray(task.stateHistory) || task.stateHistory.length === 0) {
      task.stateHistory = [{ sequence: 1, state: task.state, at: task.createdAt, generation: task.generation }];
    }
    task.nextStateSequence = Math.max(task.nextStateSequence ?? 1, (task.stateHistory.at(-1)?.sequence ?? 0) + 1);
  }
  parsed.kind ??= parsed.tasks.some((task) => task.definition.backgroundKind === "research") ? "research" : "execute";
  parsed.peakConcurrency ??= 0;
  return parsed;
}

async function removeOwnedWaveRoot(root: string): Promise<void> {
  const resolved = resolve(root);
  const temporaryRoot = await realpath(resolve(tmpdir()));
  if (!basename(resolved).startsWith("wave-") || dirname(resolved) !== temporaryRoot) {
    throw new Error(`Refusing to remove unrecognized wave root: ${resolved}`);
  }
  await rm(resolved, { recursive: true, force: true });
}

async function removeOwnedExecutionRoot(root: string): Promise<void> {
  const resolved = resolve(root);
  const temporaryRoot = await realpath(resolve(tmpdir()));
  if (!basename(resolved).startsWith("pi-review-execution-") || dirname(resolved) !== temporaryRoot) {
    throw new Error(`Refusing to remove unrecognized execution root: ${resolved}`);
  }
  await rm(resolved, { recursive: true, force: true });
}

async function atomicWrite(path: string, body: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.tmp.${randomUUID()}`;
  const file = await open(temporary, "wx", 0o600);
  try {
    await file.writeFile(body, "utf8");
    await file.sync();
  } finally {
    await file.close();
  }
  await rename(temporary, path);
  try {
    const directory = await open(dirname(path), "r");
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  } catch {
    // Some filesystems do not permit directory fsync; the atomic rename still
    // protects readers from partial manifests.
  }
}

function selectiveCheckpoint(
  accumulatedBaseline: WorkspaceSnapshot,
  taskBaseline: WorkspaceSnapshot,
  before: WorkspaceSnapshot,
  after: WorkspaceSnapshot,
  paths: string[],
  sourceRoot: string,
): WorkspaceSnapshot {
  const absolute = new Set(paths.map((path) => resolve(sourceRoot, path)));
  const files = new Map(accumulatedBaseline.files);
  for (const [key, afterFile] of after.files) {
    if (!absolute.has(afterFile.absolutePath)) continue;
    if (!parentChanged(taskBaseline.files.get(key), before.files.get(key))) files.set(key, afterFile);
  }
  for (const [key, baselineFile] of accumulatedBaseline.files) {
    if (!absolute.has(baselineFile.absolutePath) || after.files.has(key)) continue;
    if (!parentChanged(taskBaseline.files.get(key), before.files.get(key))) files.delete(key);
  }
  return { cwd: accumulatedBaseline.cwd, capturedAt: after.capturedAt, files };
}

function parentChanged(a: FileSnapshot | undefined, b: FileSnapshot | undefined): boolean {
  if (!a && !b) return false;
  if (!a || !b) return true;
  return a.content !== b.content || a.sha256 !== b.sha256 || a.isBinary !== b.isBinary;
}

function cloneTask(task: BackgroundTaskRecord): BackgroundTaskRecord {
  return JSON.parse(JSON.stringify(task)) as BackgroundTaskRecord;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
