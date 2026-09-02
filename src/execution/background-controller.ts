import { randomUUID } from "node:crypto";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DEFAULT_SUBTASK_NOTIFICATION_MODE, type ReviewGateConfig } from "../config";
import { resolvedWorkerResources, resolvedWorkerRoute } from "../config";
import { createWorkspaceSnapshot, type FileSnapshot, type WorkspaceSnapshot } from "../capture";
import { activeExchangeBaseline, checkpointReviewWindow, type ReviewGateState } from "../state";
import { configDigest, type ExecutionAssociationsSnapshot } from "../session-state";
import { materializeLandingConflicts, unresolvedConflictMarkers } from "./conflict-materialization";
import {
  GROUP_VERSION,
  readGroup,
  removeOwnedExecutionRoot,
  removeOwnedWaveRoot,
  serializeGroupSnapshot,
  writeGroupSnapshot,
  type BackgroundExecutionGroup,
} from "./background-group-store";
import { ExecutorPoolScheduler, type ExecutorPoolAssignment, type ExecutorPoolLease } from "./executor-pool";
import { continueOperation, inspectOperation } from "./operation-actions";
import type { ReattachmentBundle } from "./operation-record";
import { readOperationRecord } from "./operation-record";
import { sourceMutationCoordinator } from "./source-mutation-lease";
import {
  appendActivity,
  clipActivity,
  cloneTask,
  isActiveTaskState,
  isInterruptibleTaskState,
  MAX_ACTIVITY,
  newTask,
  stateFromContinuationProgress,
  stateFromWaveProgress,
  taskTiming,
  transitionTaskState,
  isStoppedForExit,
  type BackgroundActivityEvent,
  type BackgroundCommandRecord,
  type BackgroundTaskDefinition,
  type BackgroundTaskKind,
  type BackgroundTaskRecord,
  type BackgroundTaskState,
  type BackgroundTaskTimingSummary,
} from "./task-state";
import { executorDisplayLabel, renderSubtaskWidget } from "./subtask-widget";
import type { ContinuationProgressUpdate, ExecutorInteractionAcknowledgement, ExecutorLiveControl } from "./types";
import { executeWave, type WaveProgressUpdate } from "./wave-controller";
import { resumeWaveWorker, runWaveWorker, type WaveWorkerResult } from "./wave-worker";
import { captureWaveBase, discoverWaveSource, readWaveCaptureRecord, type WaveCaptureResult } from "./wave-repository";
import { executeWaveLanding, planWaveLanding } from "./wave-landing";
import { researchWorkspaceChanges } from "./wave-commits";
import { pinCommit } from "./wave-worktrees";
import { createWorkerWorktree, type WorkerWorktree } from "./wave-worktrees";

/**
 * Finding 13: the controller no longer owns pure task-state/timing
 * bookkeeping (./task-state), durable group/archive format mechanics
 * (./background-group-store), or widget view-model rendering
 * (./subtask-widget). The original public surface of this module is preserved
 * via the re-exports below; notification/event formatting (including the
 * watch-checkpoint event text) and scaling remain in the controller
 * (findings 14 and 15).
 */
export {
  BACKGROUND_TASK_STATES,
  isActiveTaskState,
  isForceMergeCandidateTaskState,
  isInterruptibleTaskState,
  stateFromContinuationProgress,
  stateFromWaveProgress,
} from "./task-state";
export type {
  BackgroundActivityEvent,
  BackgroundCommandRecord,
  BackgroundStateTransition,
  BackgroundTaskDefinition,
  BackgroundTaskKind,
  BackgroundTaskRecord,
  BackgroundTaskState,
  BackgroundTaskTimingSummary,
} from "./task-state";
export type { BackgroundExecutionGroup } from "./background-group-store";

const RECENT_ACTIVITY_LIMIT = 10;

/**
 * L8: wake failure notifications carry a curated, explicitly bounded diagnostic
 * subset — never a full inspect() clone. Every attacker/model-controlled field
 * is capped with a visible truncation marker, and the serialized diagnostic and
 * the final notification have hard character caps.
 */
const WAKE_FAILURE_MAX_TITLE = 200;
const WAKE_FAILURE_MAX_SUMMARY = 600;
const WAKE_FAILURE_MAX_ERROR = 800;
const WAKE_FAILURE_MAX_ACTIVITY_EVENTS = 8;
const WAKE_FAILURE_MAX_ACTIVITY_MESSAGE = 300;
const WAKE_FAILURE_MAX_PHASE = 100;
const WAKE_FAILURE_MAX_EXECUTOR_ENTRY = 120;
const WAKE_FAILURE_MAX_CONFLICT_PATHS = 10;
const WAKE_FAILURE_MAX_CONFLICT_PATH = 200;
const WAKE_FAILURE_MAX_CONFLICT_REASON = 300;
const WAKE_FAILURE_MAX_ACTION = 600;
const WAKE_FAILURE_JSON_CAP = 7_000;
const WAKE_FAILURE_NOTIFICATION_CAP = 16_000;
const TRUNCATION_MARKER = "…[truncated]";

export interface BackgroundForceMergeInput {
  executionId?: string;
  taskId?: string;
  mergeAnyhow: boolean;
  instructionId: string;
  actor: "model" | "user" | "system";
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

interface RecentBackgroundActivity {
  taskId: string;
  title: string;
  event: BackgroundActivityEvent;
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

/** A force-merge request that is not a runtime task but must stay cancellable. */
interface PendingForceMerge {
  abort: AbortController;
  /** Resolves once the force-merge settles and its durable outcome is saved. */
  done: Promise<void>;
  /** True once the source mutation lease has been acquired. */
  acquired: boolean;
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
  faults?: BackgroundFaultHooks;
}

/** Context passed to deterministic fault hooks (used by tests to inject failures). */
export interface BackgroundFaultContext {
  executionId?: string;
  taskId?: string;
  taskState?: BackgroundTaskState;
  taskStates?: BackgroundTaskState[];
  kind?: string;
}

/**
 * Deterministic fault seams. Each hook runs immediately before the corresponding
 * step; throwing from a hook simulates that step failing.
 */
export interface BackgroundFaultHooks {
  checkpointParent?: (context: BackgroundFaultContext) => unknown;
  save?: (context: BackgroundFaultContext) => unknown;
  publishAssociations?: (context: BackgroundFaultContext) => unknown;
  wake?: (context: BackgroundFaultContext) => unknown;
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

export interface BackgroundWatchSubscription {
  executionId: string;
  afterMs: number;
  armedAt: string;
  dueAt: string;
  replaced: boolean;
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
  private readonly pendingForceMerges = new Map<string, PendingForceMerge>();
  private readonly saveTails = new Map<string, Promise<void>>();
  private readonly steeringTails = new Map<string, Promise<void>>();
  private readonly archivedTasks = new Map<string, { updatedAt: string; integritySha256: string }>();
  private recentActivity: RecentBackgroundActivity[] = [];
  private pool: ExecutorPoolScheduler;
  private active = 0;
  private shuttingDown = false;
  /** Depth of in-flight detach() calls; > 0 fences group attachment. */
  private detaching = 0;
  private detachEpoch = 0;
  private pumping = false;
  private pumpRequested = false;
  private scopedModels: string[] = [];
  private conflictGate?: BackgroundConflictGate;
  private releaseConflictBlock?: () => void;
  private uiContext: unknown;
  private expandedView = false;
  private readonly watches = new Map<string, { timer: ReturnType<typeof setTimeout>; subscription: BackgroundWatchSubscription }>();
  private pendingWatchInspections: BackgroundInspection[] = [];
  private watchDeliveryTimer?: ReturnType<typeof setTimeout>;

  constructor(private readonly input: BackgroundControllerInput) {
    this.pool = new ExecutorPoolScheduler(resolvedWorkerResources(input.config));
    this.expandedView = input.config.ui?.subtasksViewExpanded === true;
  }

  /**
   * Install or clear deterministic fault hooks (testing seam). Hooks fire
   * immediately before the corresponding bookkeeping step; throwing simulates
   * that step failing.
   */
  setFaultHooks(hooks: BackgroundFaultHooks | undefined): void {
    this.input.faults = hooks;
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
    const initialDetach = this.detach();
    const restoreEpoch = this.detachEpoch;
    await initialDetach;
    // A detach superseding this restore must win: never reattach a group (or
    // register a save tail) after a later detach completed its quiescence.
    const restoreIsCurrent = () =>
      !this.shuttingDown && this.detaching === 0 && this.detachEpoch === restoreEpoch;
    const roots = associations.groupRoots ?? [];
    for (const root of roots) {
      if (!restoreIsCurrent()) return;
      try {
        const restored = await readGroup(root);
        if (!restoreIsCurrent()) return;
        const group = restored.group;
        if (resolve(group.cwd) !== resolve(this.input.cwd())) {
          throw new Error(`execution cwd ${group.cwd} does not match ${resolve(this.input.cwd())}`);
        }
        for (const [taskId, archive] of restored.archives) this.archivedTasks.set(taskId, archive);
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
      if (!restoreIsCurrent()) return;
      if (restoredOperations.has(bundle.operationId)) continue;
      try {
        await this.resolveOrAdoptTask(undefined, undefined, bundle);
        restoredOperations.add(bundle.operationId);
      } catch (error) {
        await this.input.notify?.(`review gate: legacy execution bundle was not adopted (${bundle.operationId}): ${messageOf(error)}`);
      }
    }
    if (!restoreIsCurrent()) return;
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
    this.rebuildRecentActivity();
    this.updateIndicator();
    void this.pump();
  }

  async start(tasks: BackgroundTaskDefinition[], kind: BackgroundTaskKind = "execute"): Promise<BackgroundInspection> {
    const detachEpoch = this.detachEpoch;
    if (this.shuttingDown || this.detaching > 0) throw new Error("Application shutdown or controller detach is in progress.");
    if (resolvedWorkerRoute(this.input.config, kind).length === 0) {
      throw new Error(`No ${kind} worker route is configured. Add at least one eligible resource in /review-settings.`);
    }
    const root = await realpath(await mkdtemp(join(tmpdir(), "pi-review-execution-")));
    // Group creation awaited the filesystem: a detach/shutdown may have begun
    // (and completed its quiescence) meanwhile. Never attach a group — and
    // never register a save tail — after lifecycle completion; discard the
    // unused root instead.
    if (this.shuttingDown || this.detaching > 0 || this.detachEpoch !== detachEpoch) {
      await rm(root, { recursive: true, force: true });
      throw new Error("Application shutdown or controller detach began while the execution group was being created.");
    }
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

  watch(executionId: string | undefined, afterMs: number): BackgroundWatchSubscription {
    const group = this.resolveGroup(executionId);
    if (resolve(group.cwd) !== resolve(this.input.cwd())) throw new Error("Execution group belongs to a different workspace.");
    if (!group.tasks.some((task) => isActiveTaskState(task.state))) {
      throw new Error(`Execution ${group.executionId} has no active tasks to watch.`);
    }
    const replaced = this.cancelWatch(group.executionId);
    const armedAt = new Date().toISOString();
    const subscription: BackgroundWatchSubscription = {
      executionId: group.executionId,
      afterMs,
      armedAt,
      dueAt: new Date(Date.parse(armedAt) + afterMs).toISOString(),
      replaced,
    };
    const timer = setTimeout(() => this.queueWatchDelivery(group.executionId, subscription), afterMs);
    timer.unref?.();
    this.watches.set(group.executionId, { timer, subscription });
    return subscription;
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
      const adoptionEpoch = this.detachEpoch;
      if (this.shuttingDown || this.detaching > 0) {
        throw new Error("Application shutdown or controller detach is in progress.");
      }
      const inspection = await inspectOperation(bundle);
      if (this.shuttingDown || this.detaching > 0 || this.detachEpoch !== adoptionEpoch) {
        throw new Error("Application shutdown or controller detach began while the execution bundle was being adopted.");
      }
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
        if (this.shuttingDown || this.detaching > 0 || this.detachEpoch !== adoptionEpoch) {
          await rm(root, { recursive: true, force: true });
          throw new Error("Application shutdown or controller detach began while the execution bundle was being adopted.");
        }
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
      this.addActivity(task, "recovery", task.summary);
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
    this.addActivity(task, "steer", `Steering queued (${input.instructionId}).`);
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
    // A force-merge waiting for source workspace access has no runtime, but it
    // must still be quiesceable: cancel it instead of blocking or failing.
    const pendingMerge = this.pendingForceMerges.get(task.taskId);
    if (pendingMerge && !pendingMerge.acquired && !this.runtimes.has(task.taskId)) {
      const command: BackgroundCommandRecord = {
        instructionId: input.instructionId,
        action: "interrupt",
        actor: input.actor,
        mode: input.mode,
        status: "delivered",
        createdAt: new Date().toISOString(),
        deliveredAt: new Date().toISOString(),
      };
      task.commands.push(command);
      pendingMerge.abort.abort(new Error(
        `Force-merge cancelled by a ${input.actor} interrupt while it waited for source workspace access; no checkpoint landed and the main workspace is unchanged.`,
      ));
      await pendingMerge.done;
      // pendingMerge.acquired is set synchronously right after the lease was
      // granted, so it is the authoritative signal for whether the merge had
      // already entered the source workspace before the interrupt landed.
      if (pendingMerge.acquired) {
        command.status = "failed";
        command.error = `The force-merge for task ${task.taskId} entered the source workspace before the interrupt could cancel it; inspect its durable outcome.`;
      } else {
        command.status = "acknowledged";
        command.acknowledgedAt = new Date().toISOString();
        this.addActivity(task, "interrupt", "Cancelled a force-merge that was waiting for source workspace access; no checkpoint landed and the main workspace is unchanged.");
      }
      await this.save(group);
      await this.publishAssociations();
      this.updateIndicator();
      return this.inspect(group.executionId, task.taskId);
    }
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
      this.failUndeliveredContinuation(task, "Task was interrupted before the queued continuation was dispatched to an executor.");
      transitionTaskState(task, "interrupted");
      task.summary = input.mode === "interrupt_with_merge"
        ? "Interrupted before executor startup; there was no task checkpoint to merge."
        : "Interrupted before executor startup; the source workspace is unchanged.";
      this.addActivity(task, "interrupt", task.summary);
      await this.save(group);
      await this.publishAssociations();
      this.updateIndicator();
      return this.inspect(group.executionId, task.taskId);
    }
    task.interruptionMode = input.mode;
    // A registered runtime does not imply the continuation was dispatched: a
    // restored/queued continuation may still be queued behind startup. Fail it
    // now so an interrupt during preprocessing cannot dispatch afterwards.
    this.failUndeliveredContinuation(task, "Task was interrupted before the queued continuation was dispatched to an executor.");
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
        this.addActivity(task, "interrupt", `Executor interrupt ${acknowledgement.status}: ${acknowledgement.message}`);
      } catch (error) {
        transportMessage = `Executor interrupt transport failed: ${messageOf(error)}; terminated the owned process group.`;
        this.addActivity(task, "interrupt", transportMessage);
      }
    }
    await runtime.promise;
    command.status = "acknowledged";
    command.acknowledgedAt = new Date().toISOString();
    command.error = undefined;
    this.addActivity(task, "interrupt", `Writer quiesced. ${transportMessage}`);
    task.interruptionMode = undefined;
    await this.save(group);
    if (input.mode === "interrupt_with_merge") {
      this.addActivity(task, "interrupt", "Interrupt-with-merge is attempting a mechanical checkpoint landing; workspace contents still require manual inspection afterward regardless of landing status.");
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

  async forceMerge(input: BackgroundForceMergeInput): Promise<BackgroundInspection> {
    if (this.shuttingDown) throw new Error("Application shutdown is in progress.");
    const { group, task } = this.resolveTask(input.executionId, input.taskId);
    if (group.kind === "research") throw new Error("Research tasks have reports, not mergeable checkpoints; force-merge is unavailable.");
    if (this.runtimes.has(task.taskId) || isActiveTaskState(task.state)) {
      throw new Error(`Task ${task.taskId} still has a live or queued writer; interrupt and await acknowledgement before force-merge.`);
    }
    if (!task.bundle) throw new Error(`Task ${task.taskId} has no verified recovery bundle.`);
    const duplicate = task.commands.find((command) => command.instructionId === input.instructionId);
    if (duplicate) return this.inspect(group.executionId, task.taskId);
    if (this.pendingForceMerges.has(task.taskId)) {
      throw new Error(`Task ${task.taskId} already has a force-merge in progress; await its outcome before retrying.`);
    }
    // Register before any await so shutdown or a later interrupt can always
    // cancel the request while it waits for source workspace access, instead
    // of blocking indefinitely behind another mutation or conflict gate.
    let signalDone!: () => void;
    const done = new Promise<void>((resolveDone) => { signalDone = resolveDone; });
    const pending: PendingForceMerge = { abort: new AbortController(), done, acquired: false };
    this.pendingForceMerges.set(task.taskId, pending);
    try {
      return await this.runForceMerge(input, group, task, pending);
    } finally {
      this.pendingForceMerges.delete(task.taskId);
      signalDone();
    }
  }

  /**
   * Finding-13 boundary: the conflict-gate/force-merge cluster intentionally
   * remains in the controller. runForceMerge is a single transaction over
   * controller-owned state — the source-mutation lease, conflict gate, durable
   * save-tail ordering (save), association publication, parent checkpoint,
   * tolerated landed-bookkeeping, and wake delivery. Extracting it behind
   * callbacks would move transaction ownership into a callback bag without
   * reducing coupling, so it stays here; the pure state/format mechanics it
   * touches live in task-state and background-group-store.
   */
  private async runForceMerge(
    input: BackgroundForceMergeInput,
    group: BackgroundExecutionGroup,
    task: BackgroundTaskRecord,
    pending: PendingForceMerge,
  ): Promise<BackgroundInspection> {
    const bundle = task.bundle;
    if (!bundle) throw new Error(`Task ${task.taskId} has no verified recovery bundle.`);
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

    // Never queue indefinitely behind an active conflict gate: refuse promptly
    // with an actionable durable outcome instead of waiting for a mark-clean
    // that may never arrive.
    const blocked = sourceMutationCoordinator.blocked(group.cwd);
    if (blocked.blocked) {
      command.status = "failed";
      command.error = `Force-merge refused: the source workspace is blocked by an active conflict gate (${blocked.reason ?? "unresolved conflicts"}). Resolve the conflicts and call SubtasksMarkClean before retrying force-merge.`;
      await this.save(group);
      throw new Error(command.error);
    }

    const inspection = await inspectOperation(bundle);
    const checkpoint = inspection.record.checkpoint;
    const accepted = task.result?.taskResults[0]?.acceptedCommitSha;
    const commitSha = accepted ?? checkpoint?.commitSha;
    if (!commitSha || (!accepted && !checkpoint?.verified)) {
      command.status = "failed";
      command.error = "No accepted commit or verified checkpoint is available.";
      await this.save(group);
      throw new Error(command.error);
    }
    const capture = await readWaveCaptureRecord(bundle.waveRoot);
    const reviewWindowId = this.input.state.reviewWindow?.id;
    const parentBaseline = activeExchangeBaseline(this.input.state);
    const preTaskSnapshot = parentBaseline ? await createWorkspaceSnapshot(group.cwd, {
      maxFileBytes: this.input.config.maxFileBytes,
      maxSnapshotBytes: this.input.config.maxSnapshotBytes,
      reuseUnchangedFrom: parentBaseline,
    }) : undefined;
    let release: (() => void) | undefined;
    try {
      release = await sourceMutationCoordinator.acquire(group.cwd, pending.abort.signal);
      pending.acquired = true;
      command.status = "delivered";
      command.deliveredAt = new Date().toISOString();
      transitionTaskState(task, "waiting_to_land");
      this.addActivity(task, "force_merge", `Force-merge requested from ${commitSha}. This is a mechanical landing attempt; manual inspection of the main workspace is required afterward in every outcome.`);
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
        await this.checkpointParent(reviewWindowId, parentBaseline, preTaskSnapshot, group.cwd, materialized.appliedPaths, { executionId: group.executionId, taskId: task.taskId });
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
      // The landing mutated main (finding 2): run the parent checkpoint as
      // tolerated bookkeeping (preserving the success-path ordering where the
      // checkpoint completes before the landed state becomes visible), then
      // transition to landed unconditionally; save/publish/wake stay tolerated
      // so the landed outcome survives any of them failing.
      await this.completeLandedBookkeeping(task, "parent checkpoint", async () => {
        await this.checkpointParent(reviewWindowId, parentBaseline, preTaskSnapshot, group.cwd, paths, { executionId: group.executionId, taskId: task.taskId });
      });
      transitionTaskState(task, "landed");
      await this.completeLandedBookkeeping(task, "durable save", async () => {
        await this.save(group);
      });
      await this.completeLandedBookkeeping(task, "association publish", () => this.publishAssociations());
      await this.completeLandedBookkeeping(task, "completion wake", () =>
        this.wake(task, "completion", `Task ${task.taskId} force-merged and landed mechanically. This does not verify that the requested changes are present or correct; inspect the main workspace manually before claiming success.`));
      // Always persist the landed state and any bookkeeping diagnostics recorded
      // after the initial save (e.g., when the first save failed).
      await this.completeLandedBookkeeping(task, "durable save", async () => {
        await this.save(group);
      });
      return this.inspect(group.executionId, task.taskId);
    } catch (error) {
      const cancelledWhileWaiting = !pending.acquired && pending.abort.signal.aborted;
      if (command.status !== "failed") {
        command.status = "failed";
        command.error = messageOf(error);
      }
      if (cancelledWhileWaiting) {
        // The request was cancelled before it ever entered the source
        // workspace: nothing landed, so keep the pre-merge state and record a
        // clear no-landing outcome instead of implying a merge or checkpoint.
        task.summary = "Force-merge was cancelled while waiting for source workspace access; no checkpoint landed and the main workspace is unchanged.";
        this.addActivity(task, "force_merge", task.summary);
        task.error = undefined;
      } else {
        if (task.state !== "conflicted" && task.state !== "landed") transitionTaskState(task, "paused_recoverable");
        task.error = messageOf(error);
      }
      await this.save(group);
      throw error;
    } finally {
      release?.();
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
      this.addActivity(task, "landed", "Conflict resolution validated; queued landing attempts released.");
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
    this.clearWatches();
    // Quiesce force-merges that are waiting for source workspace access so
    // shutdown cannot hang behind another mutation or conflict gate.
    for (const pending of this.pendingForceMerges.values()) {
      pending.abort.abort(new Error(
        "Force-merge cancelled: the application is shutting down while the merge waited for source workspace access; no checkpoint landed and the main workspace is unchanged.",
      ));
    }
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
    await Promise.allSettled([...this.pendingForceMerges.values()].map((pending) => pending.done));
    await this.quiesceSaveTails();
    await this.cleanupSettledArtifacts();
    // cleanupSettledArtifacts may itself save; quiesce again so shutdown alone
    // guarantees no save-tail entries remain (settled tails prune themselves,
    // but the prune callback can still be queued when cleanup returns).
    await this.quiesceSaveTails();
    this.updateIndicator();
  }

  /**
   * L9: wait for every pending save tail so all required durable writes have
   * quiesced (each settled tail also prunes itself), then drop any remaining
   * tail bookkeeping. Must only be called once no further saves for the
   * affected groups can be started, so clearing cannot strand an in-flight
   * write or let a later write overtake an earlier one.
   */
  private async quiesceSaveTails(onQuiesced?: () => void): Promise<void> {
    for (;;) {
      const entries = [...this.saveTails.entries()];
      if (entries.length === 0) break;
      await Promise.all(entries.map(([, tail]) => tail.catch(() => undefined)));
      // Delete each awaited tail by exact identity so the loop makes progress
      // even if a settled tail never ran its own self-prune callback.
      for (const [executionId, tail] of entries) {
        if (this.saveTails.get(executionId) === tail) this.saveTails.delete(executionId);
      }
    }
    this.saveTails.clear();
    // Run lifecycle finalization in the same synchronous turn as the final
    // empty check, leaving no gap in which an attached group could start a
    // save that would register a tail only after quiescence ended.
    onQuiesced?.();
  }

  async cleanupSettledArtifacts(): Promise<void> {
    for (const [executionId, group] of [...this.groups]) {
      const settled = group.tasks.filter((task) => task.state === "landed" || task.state === "reported");
      for (const task of settled) {
        if (task.waveRoot) await removeOwnedWaveRoot(task.waveRoot);
        task.waveRoot = undefined;
        task.bundle = undefined;
        task.updatedAt = new Date().toISOString();
      }
      if (settled.length === group.tasks.length) {
        await removeOwnedExecutionRoot(group.root);
        this.groups.delete(executionId);
        for (const task of settled) this.archivedTasks.delete(task.taskId);
      } else if (settled.length > 0) {
        await this.save(group);
      }
    }
    await this.publishAssociations();
  }

  async detach(): Promise<void> {
    this.detaching += 1;
    this.detachEpoch += 1;
    this.clearWatches();
    // L9: let in-flight save tails finish their durable writes (preserving
    // write ordering) before dropping the group state and tail bookkeeping, so
    // no stale save-tail entry survives detach and no later write can overtake
    // an earlier one. The clearing runs as the helper's synchronous finalizer,
    // in the same turn as its final empty-tail check; saves attempted through
    // detached groups are rejected by save()'s attachment guard.
    try {
      await this.quiesceSaveTails(() => {
        this.groups.clear();
        this.runtimes.clear();
        this.pendingForceMerges.clear();
        this.archivedTasks.clear();
        this.recentActivity = [];
        this.active = 0;
        this.shuttingDown = false;
        this.pumpRequested = false;
        this.conflictGate = undefined;
        this.releaseConflictBlock?.();
        this.releaseConflictBlock = undefined;
        this.updateIndicator();
      });
    } finally {
      this.detaching -= 1;
    }
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
          const pendingContinuation = queued.task.pendingContinuation;
          const requiredEntry = pendingContinuation
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
            this.addActivity(queued.task, "configuration", warning);
            await this.save(queued.group);
            await this.input.notify?.(`review gate: ${warning}`);
          }
          // Queue inspection and continuation routing can await. An interrupt
          // may have terminalized this task or replaced its pending work while
          // the scheduler was suspended; never launch the stale selection.
          if (
            queued.task.state !== "queued"
            || this.runtimes.has(queued.task.taskId)
            || queued.task.pendingContinuation !== pendingContinuation
          ) {
            lease.release();
            continue;
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
      .catch((error) => this.handleLaunchRejection(group, task, error))
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

  private async handleLaunchRejection(
    group: BackgroundExecutionGroup,
    task: BackgroundTaskRecord,
    error: unknown,
  ): Promise<void> {
    // Terminal successful/conflicted outcomes must never be regressed by a later
    // bookkeeping failure (finding 2): the landing already happened. This check
    // takes precedence over a concurrently pending interruption mode, which
    // interrupt() leaves set until the launch promise settles.
    const preserved = task.state === "landed" || task.state === "reported" || task.state === "conflicted";
    if (preserved) {
      this.failUndeliveredSteering(task, "Task reached a terminal state before the queued steering instruction was delivered; the terminal outcome is preserved.");
      this.failUndeliveredContinuation(task, "Task reached a terminal state before the queued continuation was dispatched to an executor; the terminal outcome is preserved.");
      task.error = messageOf(error);
      task.summary = `Task ${task.taskId} already reached ${task.state}; a later bookkeeping step failed and the ${task.state} outcome is preserved: ${task.error}`;
      this.addActivity(task, "bookkeeping", task.summary);
    } else if (task.interruptionMode) {
      this.failUndeliveredSteering(task, "Task was interrupted before the queued steering instruction was delivered.");
      this.failUndeliveredContinuation(task, "Task was interrupted before the queued continuation was dispatched to an executor.");
      transitionTaskState(task, "interrupted");
      task.error = undefined;
      task.summary = `Executor acknowledged ${task.interruptionMode} during startup or capture; its writer is quiesced.`;
      this.addActivity(task, "interrupt", task.summary);
    } else {
      this.failUndeliveredSteering(task, "Task failed before the queued steering instruction was delivered.");
      this.failUndeliveredContinuation(task, "Task failed before the queued continuation was dispatched to an executor.");
      if (task.state !== "stopped_for_application_exit") transitionTaskState(task, "failed");
      task.error = messageOf(error);
      task.summary = `Background controller failure: ${task.error}`;
    }
    task.updatedAt = new Date().toISOString();
    try {
      await this.save(group);
    } catch (saveError) {
      this.addActivity(task, "bookkeeping", `Durable save failed after launch failure: ${messageOf(saveError)}`);
    }
    if (preserved || !task.interruptionMode) {
      try {
        const wakeKind = task.state === "conflicted" ? "failure" : preserved ? "completion" : "failure";
        await this.wake(task, wakeKind, task.summary);
      } catch {
        // Best-effort; the failure is already recorded in durable activity.
      }
    }
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
    this.addActivity(task, "capturing", "Capturing a stable private workspace for read-only research.");
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
    const pending = task.pendingContinuation;
    if (!pending) throw new Error("Continuation was interrupted before executor dispatch.");
    pending.instructions = await this.incorporateContinuationSteering(group, task, pending.instructions);
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
    this.addActivity(task, "running", `Continuing research from its durable session (${pending.instructionId}).`);
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
    this.addActivity(task, `research:${update.phase}`, update.message);
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
      this.addActivity(task, "research:policy_failure", task.error);
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
    this.addActivity(task, "capturing", "Capturing an independent task base from current main.");
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
        await this.checkpointParent(reviewWindowId, parentBaseline, preTaskSnapshot, group.cwd, materialized.appliedPaths, { executionId: group.executionId, taskId: task.taskId });
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
        this.addActivity(task, "conflicted", `Conflict markers materialized in ${materialized.paths.join(", ")}.`);
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
      // The source workspace was mutated successfully (finding 2): run the parent
      // checkpoint as tolerated bookkeeping (preserving the success-path ordering
      // where the checkpoint completes before the landed state becomes visible),
      // then transition to landed unconditionally — a checkpoint/save/publish/wake
      // failure can neither prevent nor reclassify the landing.
      await this.completeLandedBookkeeping(task, "parent checkpoint", async () => {
        await this.checkpointParent(reviewWindowId, parentBaseline, preTaskSnapshot, group.cwd, paths, { executionId: group.executionId, taskId: task.taskId });
      });
      transitionTaskState(task, "landed");
      const completionSnapshot = transitionEventSnapshot(group, task);
      this.updateIndicator();
      let persisted: PersistedGroupRevision | undefined;
      await this.completeLandedBookkeeping(task, "durable save", async () => {
        persisted = await this.save(group);
      });
      await this.completeLandedBookkeeping(task, "association publish", () => this.publishAssociations());
      if (persisted) synchronizeEventSnapshot(completionSnapshot, persisted);
      await this.completeLandedBookkeeping(task, "completion wake", () =>
        this.wake(
          task,
          undeliveredSteering.length > 0 ? "failure" : "completion",
          undeliveredSteering.length > 0
            ? `Task ${task.taskId} landed, but ${undeliveredSteering.length} queued steering instruction(s) were not applied.`
            : `Task ${task.taskId} landed independently in the main workspace.`,
          completionSnapshot,
        ));
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
    if (task.state === "landed") {
      await this.completeLandedBookkeeping(task, "durable save", async () => {
        await this.save(group);
      });
      await this.completeLandedBookkeeping(task, "association publish", () => this.publishAssociations());
    } else {
      await this.save(group);
      await this.publishAssociations();
    }
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
    const pending = task.pendingContinuation;
    if (!pending) throw new Error("Continuation was interrupted before executor dispatch.");
    pending.instructions = await this.incorporateContinuationSteering(group, task, pending.instructions);
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
    this.addActivity(task, "running", `Continuing from durable checkpoint (${pending.instructionId}).`);
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
          await this.checkpointParent(reviewWindowId, parentBaseline, preTaskSnapshot, group.cwd, materialized.appliedPaths, { executionId: group.executionId, taskId: task.taskId });
          this.activateConflictGate(group, task, materialized.paths, materialized.manifestPath, `Continued task ${task.taskId} requires immediate conflict resolution.`);
          this.addActivity(task, "conflicted", `Conflict markers materialized in ${materialized.paths.join(", ")}.`);
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
        // The source workspace was mutated successfully (finding 2): run the
        // parent checkpoint as tolerated bookkeeping (preserving the success-path
        // ordering where the checkpoint completes before the landed state becomes
        // visible), then transition to landed unconditionally.
        await this.completeLandedBookkeeping(task, "parent checkpoint", async () => {
          await this.checkpointParent(reviewWindowId, parentBaseline, preTaskSnapshot, group.cwd, paths, { executionId: group.executionId, taskId: task.taskId });
        });
        transitionTaskState(task, "landed");
        const completionSnapshot = transitionEventSnapshot(group, task);
        this.updateIndicator();
        let persisted: PersistedGroupRevision | undefined;
        await this.completeLandedBookkeeping(task, "durable save", async () => {
          persisted = await this.save(group);
        });
        await this.completeLandedBookkeeping(task, "association publish", () => this.publishAssociations());
        if (persisted) synchronizeEventSnapshot(completionSnapshot, persisted);
        await this.completeLandedBookkeeping(task, "completion wake", () =>
          this.wake(
            task,
            undeliveredSteering.length > 0 ? "failure" : "completion",
            undeliveredSteering.length > 0
              ? `Task ${task.taskId} continuation landed, but ${undeliveredSteering.length} queued steering instruction(s) were not applied.`
              : `Task ${task.taskId} continuation landed.`,
            completionSnapshot,
          ));
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
      if (task.state === "landed") {
        await this.completeLandedBookkeeping(task, "durable save", async () => {
          await this.save(group);
        });
        await this.completeLandedBookkeeping(task, "association publish", () => this.publishAssociations());
      } else {
        await this.save(group);
        await this.publishAssociations();
      }
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
    for (const message of update.activity ?? [update.message]) this.addActivity(task, update.phase, message);
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
    this.addActivity(task, update.phase, update.message);
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
    faultContext: BackgroundFaultContext = {},
  ): Promise<void> {
    await this.input.faults?.checkpointParent?.(faultContext);
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

  /**
   * Runs a post-landing bookkeeping step, tolerating its failure: the task has
   * already mutated main successfully, so the landed outcome must be preserved
   * and the failure recorded as activity/diagnostic instead (finding 2).
   */
  private async completeLandedBookkeeping(
    task: BackgroundTaskRecord,
    step: string,
    run: () => Promise<unknown>,
  ): Promise<void> {
    try {
      await run();
    } catch (error) {
      const message = messageOf(error);
      task.updatedAt = new Date().toISOString();
      this.addActivity(
        task,
        "bookkeeping",
        `Task ${task.taskId} landed in the main workspace, but post-landing ${step} failed; the landed outcome is preserved. ${message}`,
      );
      try {
        await this.input.notify?.(`review gate: task ${task.taskId} landed, but ${step} failed afterward (landing preserved): ${message}`);
      } catch {
        // Notification is best-effort; the landed outcome is already recorded.
      }
    }
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
    this.addActivity(task, "steer", `${pending.length} queued steering instruction(s) incorporated into the initial executor prompt.`);
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
    this.addActivity(task, "steer", `${pending.length} queued steering instruction(s) incorporated into continuation startup.`);
    await this.save(group);
    return `${instructions}\n\nSteering received before continuation startup (later instructions take precedence):\n${steering}`;
  }

  private failUndeliveredSteering(task: BackgroundTaskRecord, reason: string): BackgroundCommandRecord[] {
    const pending = task.commands.filter((command) => command.action === "steer" && command.status === "queued");
    for (const command of pending) {
      command.status = "failed";
      command.error = reason;
    }
    if (pending.length > 0) this.addActivity(task, "steer", `${pending.length} steering instruction(s) failed: ${reason}`);
    return pending;
  }

  private failUndeliveredContinuation(task: BackgroundTaskRecord, reason: string): BackgroundCommandRecord[] {
    const pending = task.commands.filter((command) => command.action === "continue" && command.status === "queued");
    for (const command of pending) {
      command.status = "failed";
      command.error = reason;
    }
    if (pending.length > 0) this.addActivity(task, "continue", `${pending.length} queued continuation instruction(s) failed: ${reason}`);
    if (task.pendingContinuation) task.pendingContinuation = undefined;
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
    this.addActivity(task, "steer", `${pending.length} deferred steering instruction(s) claimed for the next executor turn.`);
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
          this.addActivity(task, "steer", `The active ${control.adapter} turn cannot accept live steering; ${command.instructionId} remains queued for the next executor handoff.`);
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
            this.addActivity(task, "steer", `Steering ${acknowledgement.status}: ${acknowledgement.message}`);
          }
        } catch (error) {
          command.status = "failed";
          command.error = messageOf(error);
          this.addActivity(task, "steer", `Steering failed: ${command.error}`);
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
    await this.input.faults?.wake?.({ taskId: task.taskId, taskState: task.state, kind });
    if (kind === "completion" || kind === "failure") {
      const owner = eventSnapshot?.group
        ?? [...this.groups.values()].find((group) => group.tasks.some((candidate) => candidate.taskId === task.taskId));
      if (owner) this.cancelWatch(owner.executionId);
    }
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
    // Failures never reuse the generic event body: it embeds raw wake content,
    // task titles, landed paths, and the incomplete-task list. Failures get a
    // dedicated preamble built only from the curated diagnostic, so every
    // model-controlled character passes through field-level bounding first.
    const diagnostic = kind === "failure" && owner
      ? this.wakeFailureDiagnostic(owner, eventTask, content)
      : undefined;
    const deliveredContent = diagnostic
      ? capNotificationText(
        `${formatWakeFailurePreamble(diagnostic)}\n\nFailure recovery diagnostic (curated and bounded; use SubtasksInspect for the full current snapshot):\n${formatWakeFailureDiagnostic(diagnostic)}`,
        WAKE_FAILURE_NOTIFICATION_CAP,
      )
      : eventOwner
        ? formatExecutionEvent(eventOwner, eventTask, kind, content, scheduling)
        : content;
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

  /**
   * Curated recovery subset for wake failure notifications (L8). Contains only
   * stable handles, current state, bounded summary/error/activity, and recovery
   * actions. Task instructions, acceptance criteria, command text, model
   * output, and full group/task arrays are never included.
   */
  private wakeFailureDiagnostic(
    group: BackgroundExecutionGroup,
    task: BackgroundTaskRecord,
    content: string,
  ): WakeFailureDiagnostic {
    const live = group.tasks.find((candidate) => candidate.taskId === task.taskId) ?? task;
    const conflictGate = this.conflictGate
      && this.conflictGate.executionId === group.executionId
      && this.conflictGate.taskId === task.taskId
      ? this.conflictGate
      : undefined;
    const successState: BackgroundTaskState = group.kind === "research" ? "reported" : "landed";
    const conflictManifestPath = conflictGate
      ? boundDiagnosticText(conflictGate.manifestPath, WAKE_FAILURE_MAX_CONFLICT_PATH) ?? ""
      : undefined;
    const suggestedActions = [
      `SubtasksInspect (executionId ${group.executionId}, taskId ${task.taskId}) for the current bounded snapshot`,
    ];
    if (conflictGate) {
      suggestedActions.push(`Resolve the conflict markers in recovery.conflictGate.paths (manifest: ${conflictManifestPath}), verify the workspace, then call SubtasksMarkClean (executionId ${group.executionId}, taskId ${task.taskId}); automatic landings stay blocked until then`);
    }
    if (live.bundle) {
      suggestedActions.push(`SubtasksContinue (executionId ${group.executionId}, taskId ${task.taskId}) to resume from the durable checkpoint`);
      if (group.kind === "execute" && !isActiveTaskState(live.state)) {
        suggestedActions.push(`SubtasksForceMerge (executionId ${group.executionId}, taskId ${task.taskId}) to land the checkpoint mechanically; manual workspace inspection is still required afterward`);
      }
    } else {
      suggestedActions.push("No durable continuation bundle is available; inspect the execution record and restart the task with SubtasksAdd if its outcome is still needed");
    }
    suggestedActions.push(`SubtasksInterrupt (executionId ${group.executionId}, taskId ${task.taskId}, interrupt_as_failure) to quiesce any live writer`);
    // Recovery handles are serialized first so any final JSON truncation hits
    // the verbose summary/error/activity tail, never the recovery block. Every
    // field is individually bounded so the structured object passed via
    // sendMessage details is bounded by construction, not only the rendered text.
    return fitWakeFailureDiagnostic({
      executionId: group.executionId,
      kind: group.kind,
      revision: group.revision,
      taskId: task.taskId,
      taskState: live.state,
      message: boundDiagnosticText(content, WAKE_FAILURE_MAX_SUMMARY) ?? "",
      groupSummary: {
        taskCount: group.tasks.length,
        settled: group.tasks.filter((candidate) => candidate.state === successState).length,
        active: group.tasks.filter((candidate) => isActiveTaskState(candidate.state)).length,
      },
      recovery: {
        hasDurableBundle: Boolean(live.bundle),
        bundleWaveRoot: live.bundle ? boundDiagnosticText(live.bundle.waveRoot, WAKE_FAILURE_MAX_CONFLICT_PATH) : undefined,
        executorEntryId: live.executorEntryId
          ? boundDiagnosticText(live.executorEntryId, WAKE_FAILURE_MAX_EXECUTOR_ENTRY)
          : undefined,
        conflictGate: conflictGate
          ? {
            paths: conflictGate.paths
              .slice(0, WAKE_FAILURE_MAX_CONFLICT_PATHS)
              .map((path) => boundDiagnosticText(path, WAKE_FAILURE_MAX_CONFLICT_PATH) ?? ""),
            manifestPath: conflictManifestPath ?? "",
            reason: boundDiagnosticText(conflictGate.reason, WAKE_FAILURE_MAX_CONFLICT_REASON) ?? "",
          }
          : undefined,
        suggestedActions: suggestedActions.map((action) => boundDiagnosticText(action, WAKE_FAILURE_MAX_ACTION) ?? ""),
      },
      title: boundDiagnosticText(task.definition.title, WAKE_FAILURE_MAX_TITLE) ?? "",
      summary: boundDiagnosticText(live.summary, WAKE_FAILURE_MAX_SUMMARY),
      error: boundDiagnosticText(live.error, WAKE_FAILURE_MAX_ERROR),
      activity: live.activity
        .slice(-WAKE_FAILURE_MAX_ACTIVITY_EVENTS)
        .map((event) => ({
          sequence: event.sequence,
          phase: boundDiagnosticText(event.phase, WAKE_FAILURE_MAX_PHASE) ?? "",
          message: boundDiagnosticText(event.message, WAKE_FAILURE_MAX_ACTIVITY_MESSAGE) ?? "",
        })),
    });
  }

  private cancelWatch(executionId: string): boolean {
    const current = this.watches.get(executionId);
    if (current) clearTimeout(current.timer);
    this.watches.delete(executionId);
    this.pendingWatchInspections = this.pendingWatchInspections.filter((inspection) => inspection.executionId !== executionId);
    return current !== undefined;
  }

  private clearWatches(): void {
    for (const watch of this.watches.values()) clearTimeout(watch.timer);
    this.watches.clear();
    this.pendingWatchInspections = [];
    if (this.watchDeliveryTimer) clearTimeout(this.watchDeliveryTimer);
    this.watchDeliveryTimer = undefined;
  }

  private queueWatchDelivery(executionId: string, expected: BackgroundWatchSubscription): void {
    const current = this.watches.get(executionId);
    if (!current || current.subscription !== expected) return;
    this.watches.delete(executionId);
    let inspection: BackgroundInspection;
    try {
      inspection = this.inspect(executionId);
    } catch {
      return;
    }
    if (inspection.activeCount === 0) return;
    this.pendingWatchInspections.push(inspection);
    if (this.watchDeliveryTimer) return;
    this.watchDeliveryTimer = setTimeout(() => {
      this.watchDeliveryTimer = undefined;
      const pending = this.pendingWatchInspections.splice(0);
      if (pending.length > 0) void this.deliverWatchInspections(pending);
    }, 25);
    this.watchDeliveryTimer.unref?.();
  }

  private async deliverWatchInspections(inspections: BackgroundInspection[]): Promise<void> {
    const content = formatWatchEvent(inspections, this.input.config);
    if (!isRecord(this.input.pi) || typeof this.input.pi.sendMessage !== "function") {
      await this.input.notify?.(content);
      return;
    }
    try {
      this.input.pi.sendMessage({
        customType: "pi-review-subtask-watch",
        content,
        display: true,
        details: { executions: inspections },
      }, { deliverAs: "followUp", triggerTurn: true });
    } catch (error) {
      await this.input.notify?.(`review gate: subtask watch notification could not be delivered: ${messageOf(error)}`);
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

  private addActivity(task: BackgroundTaskRecord, phase: string, message: string): void {
    const event = appendActivity(task, phase, message);
    if (!event) return;
    this.recentActivity.push({ taskId: task.taskId, title: task.definition.title, event });
    if (this.recentActivity.length > RECENT_ACTIVITY_LIMIT) {
      this.recentActivity.splice(0, this.recentActivity.length - RECENT_ACTIVITY_LIMIT);
    }
  }

  private rebuildRecentActivity(): void {
    this.recentActivity = [...this.groups.values()]
      .flatMap((group) => group.tasks.flatMap((task) => task.activity.map((event) => ({
        taskId: task.taskId,
        title: task.definition.title,
        event,
      }))))
      .sort((left, right) => left.event.at.localeCompare(right.event.at) || left.event.sequence - right.event.sequence)
      .slice(-RECENT_ACTIVITY_LIMIT);
  }

  private async save(group: BackgroundExecutionGroup): Promise<PersistedGroupRevision> {
    if (this.groups.get(group.executionId) !== group) {
      throw new Error(`Execution ${group.executionId} was detached before it could be saved.`);
    }
    // Everything up to the tail registration is synchronous: once save() has
    // been entered, its tail is registered before any other code can run, so
    // quiescing the tail map can never miss a save that is already in flight.
    group.revision += 1;
    group.updatedAt = new Date().toISOString();
    // Group/archive serialization (archive selection and reuse, integrity
    // hashing, exact JSON shapes) is delegated to the group store; this method
    // keeps the attachment guard, revision bookkeeping, fault seam, and L9
    // save-tail ordering.
    const serialized = serializeGroupSnapshot(group, this.archivedTasks);
    const snapshot = serialized.snapshot;
    // Freeze the hook context with the snapshot it guards; the hook itself
    // still runs inside the serialized chain so it can gate the write.
    const faultContext: BackgroundFaultContext = {
      executionId: group.executionId,
      taskStates: group.tasks.map((candidate) => candidate.state),
    };
    const prior = this.saveTails.get(group.executionId) ?? Promise.resolve();
    const next = prior.then(async () => {
      // The fault hook runs inside the serialized chain, immediately before
      // this save's durable writes; a throwing hook rejects `next` while the
      // registered tail (its caught twin) still settles and prunes itself.
      await this.input.faults?.save?.(faultContext);
      await writeGroupSnapshot(group.root, serialized);
      for (const archive of serialized.archiveWrites) {
        this.archivedTasks.set(archive.taskId, {
          updatedAt: archive.updatedAt,
          integritySha256: archive.integritySha256,
        });
      }
    });
    const tail = next.catch(() => undefined);
    this.saveTails.set(group.executionId, tail);
    // L9: prune the tail once it settles so the map stays bounded. The prune
    // fires only while this exact promise is still the registered tail, so an
    // older save can never delete a newer tail: the caller-visible `next`
    // promise still propagates failures, and later saves keep chaining on the
    // registered tail, preserving write ordering.
    void tail.then(() => {
      if (this.saveTails.get(group.executionId) === tail) this.saveTails.delete(group.executionId);
    });
    await next;
    return {
      revision: snapshot.revision,
      updatedAt: snapshot.updatedAt,
      peakConcurrency: snapshot.peakConcurrency ?? 0,
      integritySha256: snapshot.integritySha256,
    };
  }

  private async publishAssociations(): Promise<void> {
    await this.input.faults?.publishAssociations?.({
      taskStates: [...this.groups.values()].flatMap((group) => group.tasks.map((task) => task.state)),
    });
    await this.input.onAssociationsChanged?.(this.associations());
  }

  private updateIndicator(): void {
    const ctx = this.uiContext;
    if (!isRecord(ctx) || !isRecord(ctx.ui) || typeof ctx.ui.setWidget !== "function") return;
    // The controller only assembles the snapshot (active tasks, runtime
    // assignment, conflict gate, recent activity); all rendering details live
    // in the subtask-widget module.
    const tasks = [...this.groups.values()].flatMap((group) => group.tasks
      .filter((task) => isActiveTaskState(task.state))
      .map((task) => ({
        kind: group.kind,
        taskId: task.taskId,
        title: task.definition.title,
        state: task.state,
        updatedAt: task.updatedAt,
        executorEntryId: task.executorEntryId,
        reviewStatus: task.reviewStatus
          ? { phase: task.reviewStatus.phase, reviewers: [...task.reviewStatus.reviewers] }
          : undefined,
        latestCommand: task.commands.at(-1)
          ? { action: task.commands.at(-1)!.action, status: task.commands.at(-1)!.status }
          : undefined,
        queuedExecutorAssigned: this.runtimes.has(task.taskId),
      })));
    try {
      const rendered = renderSubtaskWidget({
        expanded: this.expandedView,
        conflictPaths: this.conflictGate ? [...this.conflictGate.paths] : undefined,
        tasks,
        recent: this.recentActivity.map((entry) => ({ title: entry.title, event: entry.event })),
      }, this.input.config);
      if (rendered.component) {
        ctx.ui.setWidget("review-gate-subtasks", rendered.component, { placement: "belowEditor" });
      } else {
        ctx.ui.setWidget("review-gate-subtasks", rendered.lines, { placement: "belowEditor" });
      }
    } catch {
      // UI surfaces are optional in print/headless harnesses.
    }
  }
}

/**
 * Watch-checkpoint event text (controller-owned; finding 14 keeps event
 * formatting here). Exported for focused regression tests only.
 */
export function formatWatchEvent(inspections: BackgroundInspection[], config: ReviewGateConfig): string {
  const lines = [
    "[pi-review-subtask-watch]",
    inspections.length === 1
      ? `The requested one-shot checkpoint for execution ${inspections[0]!.executionId} is due while work remains active.`
      : `${inspections.length} requested one-shot subtask checkpoints became due together while work remains active.`,
    "This is a deliberate checkpoint, not a completion or failure event. Act only if the snapshot warrants it; call SubtasksWatch again to request another checkpoint.",
  ];
  const now = Date.now();
  for (const inspection of inspections) {
    const active = inspection.tasks.filter((task) => isActiveTaskState(task.state));
    lines.push("", `${inspection.kind === "research" ? "Research" : "Execution"} ${inspection.executionId}: ${active.length} active task(s), revision ${inspection.revision}.`);
    for (const task of active) {
      const lastActivity = task.activity.at(-1);
      const lastAt = lastActivity?.at ?? task.updatedAt;
      const live = task.liveControl;
      lines.push(`- ${task.taskId} · ${task.definition.title} · ${task.state} · ${executorDisplayLabel(task, config, inspection.kind)}`);
      lines.push(`  elapsed ${formatElapsed(task.timing.totalMs)}; last recorded activity ${formatElapsedSince(lastAt, now)}; controls: inspect yes, steer yes (live ${live?.steer === true ? "yes" : "no"}), interrupt ${isInterruptibleTaskState(task.state) ? "yes" : "no"}`);
      lines.push(lastActivity
        ? `  recent: ${lastActivity.phase} · ${clipActivity(lastActivity.message, 240)}`
        : "  recent: no recorded activity yet");
    }
  }
  return lines.join("\n");
}

function formatElapsed(milliseconds: number): string {
  const seconds = Math.max(0, Math.round(milliseconds / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  if (minutes < 60) return remainingSeconds === 0 ? `${minutes}m` : `${minutes}m${remainingSeconds}s`;
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return remainingMinutes === 0 ? `${hours}h` : `${hours}h${remainingMinutes}m`;
}

function formatElapsedSince(at: string, now: number): string {
  const parsed = Date.parse(at);
  return Number.isFinite(parsed) ? `${formatElapsed(Math.max(0, now - parsed))} ago` : "unknown";
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

/** Curated, bounded failure diagnostic delivered with wake failure notifications (L8). */
export interface WakeFailureDiagnostic {
  executionId: string;
  kind: BackgroundTaskKind;
  revision: number;
  taskId: string;
  taskState: BackgroundTaskState;
  /** Bounded wake content (notice text); never the raw unbounded string. */
  message: string;
  groupSummary: { taskCount: number; settled: number; active: number };
  recovery: {
    hasDurableBundle: boolean;
    bundleWaveRoot?: string;
    executorEntryId?: string;
    conflictGate?: { paths: string[]; manifestPath: string; reason: string };
    suggestedActions: string[];
  };
  title: string;
  summary?: string;
  error?: string;
  activity: Array<{ sequence: number; phase: string; message: string }>;
}

/** JSON-encoded length of a string's content, excluding the surrounding quotes. */
function jsonEncodedTextLength(value: string): number {
  // Control characters, quotes, and backslashes expand during JSON.stringify;
  // field budgets apply to the encoded form so the serialized diagnostic cap
  // cannot be bypassed with escape-heavy adversarial content.
  return JSON.stringify(value).length - 2;
}

function boundDiagnosticText(value: string | undefined, max: number): string | undefined {
  if (value === undefined) return undefined;
  const flat = value.replace(/\s+/g, " ").trim();
  if (jsonEncodedTextLength(flat) <= max) return flat;
  // Binary-search the longest raw prefix whose JSON encoding (plus the visible
  // truncation marker) still fits the encoded budget.
  let low = 0;
  let high = flat.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (jsonEncodedTextLength(`${flat.slice(0, mid)}${TRUNCATION_MARKER}`) <= max) {
      low = mid;
    } else {
      high = mid - 1;
    }
  }
  return `${flat.slice(0, low)}${TRUNCATION_MARKER}`;
}

/**
 * Shed trailing activity entries until the serialized diagnostic fits the JSON
 * cap, so the delivered diagnostic (and the structured object sent via
 * sendMessage details) stays parseable JSON instead of a character-sliced tail.
 */
function fitWakeFailureDiagnostic(diagnostic: WakeFailureDiagnostic): WakeFailureDiagnostic {
  let payload = diagnostic;
  let text = JSON.stringify(payload, null, 2);
  while (text.length > WAKE_FAILURE_JSON_CAP && payload.activity.length > 0) {
    payload = { ...payload, activity: payload.activity.slice(0, -1) };
    text = JSON.stringify(payload, null, 2);
  }
  return payload;
}

function formatWakeFailureDiagnostic(diagnostic: WakeFailureDiagnostic): string {
  const text = JSON.stringify(diagnostic, null, 2);
  if (text.length <= WAKE_FAILURE_JSON_CAP) return text;
  return `${text.slice(0, Math.max(1, WAKE_FAILURE_JSON_CAP - TRUNCATION_MARKER.length))}${TRUNCATION_MARKER}`;
}

/** Dedicated bounded preamble for failure notifications; built only from the curated diagnostic. */
function formatWakeFailurePreamble(diagnostic: WakeFailureDiagnostic): string {
  const successVerb = diagnostic.kind === "research" ? "reported" : "landed";
  const lines = [
    `Task ${diagnostic.taskId} requires recovery attention at state ${diagnostic.taskState.toUpperCase()} in ${diagnostic.kind} execution ${diagnostic.executionId} (revision ${diagnostic.revision}).`,
    `Execution progress: ${diagnostic.groupSummary.settled}/${diagnostic.groupSummary.taskCount} task(s) ${successVerb}, ${diagnostic.groupSummary.active} active.`,
  ];
  if (diagnostic.message) lines.push(`Notice: ${diagnostic.message}`);
  if (diagnostic.summary) lines.push(`Summary: ${diagnostic.summary}`);
  if (diagnostic.error) lines.push(`Error: ${diagnostic.error}`);
  return lines.join("\n");
}

function capNotificationText(content: string, max: number): string {
  if (content.length <= max) return content;
  return `${content.slice(0, Math.max(1, max - TRUNCATION_MARKER.length))}${TRUNCATION_MARKER}`;
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

async function continuationEntryId(task: BackgroundTaskRecord): Promise<string | undefined> {
  if (task.executorEntryId) return task.executorEntryId;
  if (!task.bundle) return undefined;
  const inspection = await inspectOperation(task.bundle);
  const operation = await readOperationRecord(inspection.record.artifactDir + "/operation.json");
  return operation.assignments.at(-1)?.entryId;
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
  return { cwd: accumulatedBaseline.cwd, capturedAt: after.capturedAt, files, omissions: after.omissions, omissionsTruncated: after.omissionsTruncated };
}

function parentChanged(a: FileSnapshot | undefined, b: FileSnapshot | undefined): boolean {
  if (!a && !b) return false;
  if (!a || !b) return true;
  return a.content !== b.content || a.sha256 !== b.sha256 || a.isBinary !== b.isBinary;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
