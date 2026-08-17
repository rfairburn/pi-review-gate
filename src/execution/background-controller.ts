import { createHash, randomUUID } from "node:crypto";
import { open, mkdir, mkdtemp, readFile, realpath, rename } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import type { ReviewGateConfig } from "../config";
import { externalAgentCatalog, resolvedExecutorPool } from "../config";
import { createWorkspaceSnapshot, type FileSnapshot, type WorkspaceSnapshot } from "../capture";
import { activeExchangeBaseline, checkpointReviewWindow, type ReviewGateState } from "../state";
import type { ExecutionAssociationsSnapshot } from "../session-state";
import { materializeLandingConflicts, unresolvedConflictMarkers } from "./conflict-materialization";
import { ExecutorPoolScheduler, type ExecutorPoolLease } from "./executor-pool";
import { continueOperation, inspectOperation } from "./operation-actions";
import type { ReattachmentBundle } from "./operation-record";
import { readOperationRecord } from "./operation-record";
import { sourceMutationCoordinator } from "./source-mutation-lease";
import { executeWave, type WaveProgressUpdate, type WaveResult } from "./wave-controller";
import type { WaveWorkerTask } from "./wave-worker";
import { readWaveCaptureRecord } from "./wave-repository";
import { executeWaveLanding, planWaveLanding } from "./wave-landing";
import { pinCommit } from "./wave-worktrees";
import type { ExecutorInteractionAcknowledgement, ExecutorLiveControl } from "./types";

const GROUP_VERSION = 1;
const MAX_ACTIVITY = 5_000;

export type BackgroundTaskState =
  | "queued"
  | "capturing"
  | "running"
  | "reviewing"
  | "accepted"
  | "waiting_to_land"
  | "landing"
  | "landed"
  | "failed"
  | "interrupted"
  | "conflicted"
  | "paused_recoverable"
  | "stopped_for_application_exit";

export type WakeLane = "now" | "soon" | "idle";

export interface TaskWakeRules {
  completion?: WakeLane;
  failure?: WakeLane;
  match?: string[];
}

export interface BackgroundTaskDefinition extends WaveWorkerTask {
  wakeOn?: TaskWakeRules;
}

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
  result?: WaveResult;
  summary?: string;
  error?: string;
  activity: BackgroundActivityEvent[];
  nextActivitySequence: number;
  commands: BackgroundCommandRecord[];
  matchedWakePatterns: string[];
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
  root: string;
  cwd: string;
  createdAt: string;
  updatedAt: string;
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
  root: string;
  cwd: string;
  activeCount: number;
  historicalCount: number;
  conflictGate?: BackgroundConflictGate;
  tasks: Array<BackgroundTaskRecord & {
    artifactDir?: string;
    liveControl?: { adapter: string; generation: number; protocol?: string; steer: boolean; interrupt: boolean };
  }>;
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
  private scopedModels: string[] = [];
  private conflictGate?: BackgroundConflictGate;
  private releaseConflictBlock?: () => void;
  private uiContext: unknown;
  private expandedView = false;

  constructor(private readonly input: BackgroundControllerInput) {
    this.pool = new ExecutorPoolScheduler(resolvedExecutorPool(input.config));
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
    if (this.active !== 0) return;
    this.pool = new ExecutorPoolScheduler(resolvedExecutorPool(this.input.config));
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
            task.state = "queued";
            task.summary = "Exact parent conversation restored; durable continuation queued automatically.";
            task.updatedAt = new Date().toISOString();
          } else if (task.state === "stopped_for_application_exit" && !task.waveRoot) {
            task.state = "queued";
            task.summary = "Exact parent conversation restored; undispatched task queued automatically.";
            task.updatedAt = new Date().toISOString();
          } else if (isActiveState(task.state) && task.state !== "queued") {
            task.state = "paused_recoverable";
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
    this.pool = new ExecutorPoolScheduler(resolvedExecutorPool(this.input.config));
    this.updateIndicator();
    void this.pump();
  }

  async start(tasks: BackgroundTaskDefinition[]): Promise<BackgroundInspection> {
    if (this.shuttingDown) throw new Error("Application shutdown is in progress.");
    const root = await realpath(await mkdtemp(join(tmpdir(), "pi-review-execution-")));
    const executionId = `exec-${randomUUID()}`;
    const now = new Date().toISOString();
    const group: BackgroundExecutionGroup = {
      version: GROUP_VERSION,
      revision: 0,
      integritySha256: "",
      executionId,
      root,
      cwd: resolve(this.input.cwd()),
      createdAt: now,
      updatedAt: now,
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
      root: group.root,
      cwd: group.cwd,
      activeCount: group.tasks.filter((task) => isActiveState(task.state)).length,
      historicalCount: group.tasks.length,
      conflictGate: this.conflictGate && this.conflictGate.executionId === group.executionId
        ? { ...this.conflictGate, paths: [...this.conflictGate.paths] }
        : undefined,
      tasks: selected.map((task) => ({
        ...cloneTask(task),
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
    if (isActiveState(task.state)) throw new Error(`Task ${task.taskId} is already active.`);
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
    task.state = "queued";
    task.updatedAt = new Date().toISOString();
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
          root,
          cwd: resolve(this.input.cwd()),
          createdAt: now,
          updatedAt: now,
          tasks: [],
        };
        this.groups.set(group.executionId, group);
      }
      const task = newTask(definition);
      task.bundle = { ...inspection.bundle };
      task.waveRoot = inspection.bundle.waveRoot;
      task.state = "paused_recoverable";
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
      task.state = "interrupted";
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
    if (this.runtimes.has(task.taskId) || isActiveState(task.state)) {
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
      task.state = "waiting_to_land";
      addActivity(task, "force_merge", `Force-merge requested from ${commitSha}. This is a mechanical landing attempt; manual inspection of the main workspace is required afterward in every outcome.`);
      await this.save(group);

      await pinCommit(capture, commitSha, { type: "integration" });
      const plan = await planWaveLanding(capture, commitSha, group.cwd);
      if (plan.conflicts.length > 0) {
        if (!input.mergeAnyhow) {
          task.state = "paused_recoverable";
          task.summary = `Force-merge found ${plan.conflicts.length} conflict(s); main remains unchanged. Manual workspace inspection is required before choosing recovery.`;
          command.status = "failed";
          command.error = task.summary;
          await this.save(group);
          throw new Error(`${task.summary} Re-run force_merge with mergeAnyhow only if ordinary conflict markers should be materialized.`);
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
        task.state = "conflicted";
        task.summary = `Force-merge materialized conflict markers in ${materialized.paths.join(", ")}. Resolve them and manually inspect the complete workspace; force-merge does not verify the requested result.`;
        command.status = "acknowledged";
        command.acknowledgedAt = new Date().toISOString();
        await this.save(group);
        await this.publishAssociations();
        await this.wake(task, "failure", this.criticalPrompt()!);
        return this.inspect(group.executionId, task.taskId);
      }
      task.state = "landing";
      const landing = await executeWaveLanding(plan, capture);
      if (landing.status !== "landed") throw new Error(`Force-merge landing ended in ${landing.status}.`);
      task.state = "landed";
      const paths = [...landing.appliedPaths, ...landing.alreadyAppliedPaths];
      task.summary = paths.length > 0
        ? "Stopped task force-merged mechanically into the main workspace; manual workspace inspection is still required to confirm the requested changes are present and correct."
        : "Force-merge checkpoint contains no changes that remain to be landed; manual workspace inspection is still required to determine whether the requested changes are present.";
      command.status = "acknowledged";
      command.acknowledgedAt = new Date().toISOString();
      await this.checkpointParent(reviewWindowId, parentBaseline, preTaskSnapshot, group.cwd, paths);
      await this.save(group);
      await this.publishAssociations();
      await this.wake(task, "completion", `Task ${task.taskId} force-merged and landed mechanically. This does not verify that the requested changes are present or correct; inspect the main workspace manually before claiming success.`);
      return this.inspect(group.executionId, task.taskId);
    } catch (error) {
      if (command.status !== "failed") {
        command.status = "failed";
        command.error = messageOf(error);
      }
      if (task.state !== "conflicted") task.state = "paused_recoverable";
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
      task.state = "landed";
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
      checkpointReviewWindow(this.input.state, selectiveCheckpoint(baseline, baseline, resolved, gate.paths, gate.sourceRoot));
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
      "Automatic task landings are blocked. Resolve these files now, verify the workspace, then call ExecuteSubtasks with action mark_clean.",
      "Do not claim the workspace is clean or continue unrelated source mutations while this gate remains active.",
    ].join("\n");
  }

  async shutdown(): Promise<void> {
    this.shuttingDown = true;
    for (const group of this.groups.values()) {
      for (const task of group.tasks) {
        if (!isActiveState(task.state)) continue;
        task.state = "stopped_for_application_exit";
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
    this.updateIndicator();
  }

  async detach(): Promise<void> {
    this.groups.clear();
    this.runtimes.clear();
    this.active = 0;
    this.shuttingDown = false;
    this.conflictGate = undefined;
    this.releaseConflictBlock?.();
    this.releaseConflictBlock = undefined;
    this.updateIndicator();
  }

  private async pump(): Promise<void> {
    if (this.pumping || this.shuttingDown) return;
    this.pumping = true;
    try {
      const maxWorkers = this.input.config.execution?.maxWorkers ?? 4;
      while (this.active < maxWorkers) {
        let launched = false;
        for (const queued of this.queuedTasks()) {
          const requiredEntry = queued.task.pendingContinuation
            ? await continuationEntryId(queued.task).catch(() => undefined)
            : undefined;
          const lease = requiredEntry && this.pool.hasEntry(requiredEntry)
            ? this.pool.tryAcquireEntry(requiredEntry)
            : this.pool.tryAcquire();
          if (!lease) continue;
          this.launch(queued.group, queued.task, lease);
          launched = true;
          break;
        }
        if (!launched) break;
      }
    } finally {
      this.pumping = false;
    }
  }

  private launch(group: BackgroundExecutionGroup, task: BackgroundTaskRecord, lease: ExecutorPoolLease): void {
    const abort = new AbortController();
    this.active += 1;
    task.executorEntryId = lease.entry.entryId;
    const promise = (task.pendingContinuation
      ? this.runContinuation(group, task, abort, lease)
      : this.runFresh(group, task, abort, lease))
      .catch(async (error) => {
        if (task.interruptionMode) {
          this.failUndeliveredSteering(task, "Task was interrupted before the queued steering instruction was delivered.");
          task.state = "interrupted";
          task.error = undefined;
          task.summary = `Executor acknowledged ${task.interruptionMode} during startup or capture; its writer is quiesced.`;
          addActivity(task, "interrupt", task.summary);
        } else {
          this.failUndeliveredSteering(task, "Task failed before the queued steering instruction was delivered.");
          task.state = task.state === "stopped_for_application_exit" ? task.state : "failed";
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
    const priorState = task.state;
    task.state = "capturing";
    task.generation += 1;
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
        task.state = "conflicted";
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
      task.state = "landed";
      this.updateIndicator();
      const paths = [...(result.landing.appliedPaths ?? []), ...(result.landing.alreadyAppliedPaths ?? [])];
      await this.checkpointParent(reviewWindowId, parentBaseline, preTaskSnapshot, group.cwd, paths);
      await this.wake(
        task,
        undeliveredSteering.length > 0 ? "failure" : "completion",
        undeliveredSteering.length > 0
          ? `Task ${task.taskId} landed, but ${undeliveredSteering.length} queued steering instruction(s) were not applied.`
          : `Task ${task.taskId} landed independently in the main workspace.`,
      );
    } else if (result.landing?.status === "conflicted") {
      task.state = "conflicted";
      task.summary = this.conflictGate
        ? `Merge conflict requires immediate resolution: ${this.conflictGate.paths.join(", ")}.`
        : "Landing conflict could not be materialized automatically; inspect full diagnostics before modifying main.";
    } else if (result.phase === "aborted") {
      task.state = task.interruptionMode ? "interrupted" : "paused_recoverable";
      task.summary = task.interruptionMode
        ? `Executor acknowledged ${task.interruptionMode}.`
        : "Executor stopped with a recoverable checkpoint.";
      await this.acknowledgeInterrupt(task);
    } else {
      task.state = worker?.bundle ? "paused_recoverable" : "failed";
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
    const priorState = task.state;
    task.state = "running";
    task.generation += 1;
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
        onUpdate: (message) => this.progressMessage(group, task, message),
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
        task.state = "landed";
        this.updateIndicator();
        task.summary = "Continued task landed independently in the main workspace.";
        const paths = [...(result.landing.appliedPaths ?? []), ...(result.landing.alreadyAppliedPaths ?? [])];
        await this.checkpointParent(reviewWindowId, parentBaseline, preTaskSnapshot, group.cwd, paths);
        await this.wake(
          task,
          undeliveredSteering.length > 0 ? "failure" : "completion",
          undeliveredSteering.length > 0
            ? `Task ${task.taskId} continuation landed, but ${undeliveredSteering.length} queued steering instruction(s) were not applied.`
            : `Task ${task.taskId} continuation landed.`,
        );
      } else if (result.landing?.status === "conflicted") {
        task.state = "conflicted";
        task.summary = this.conflictGate
          ? `Merge conflict requires immediate resolution: ${this.conflictGate.paths.join(", ")}.`
          : "Continuation landing conflict could not be materialized automatically; inspect full diagnostics.";
      } else {
        task.state = result.lifecycle?.status === "cancelled" ? "interrupted" : "paused_recoverable";
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
    task.state = "conflicted";
  }

  private progress(group: BackgroundExecutionGroup, task: BackgroundTaskRecord, update: WaveProgressUpdate): void {
    const previous = task.state;
    const next = stateFromProgress(update);
    if (next) task.state = next;
    task.updatedAt = new Date().toISOString();
    this.updateReviewStatus(task, update, next);
    for (const message of update.activity ?? [update.message]) addActivity(task, update.phase, message);
    const saved = this.save(group);
    void saved.catch((error) => this.input.notify?.(`review gate: failed to persist task progress: ${messageOf(error)}`));
    const transition = next ? stateTransitionNotice(task, previous, next) : undefined;
    const snapshot = transition ? transitionEventSnapshot(group, task) : undefined;
    if (transition) void saved.then(() => this.wake(task, "state", transition, snapshot)).catch(() => undefined);
    for (const pattern of task.definition.wakeOn?.match ?? []) {
      if (task.matchedWakePatterns.includes(pattern)) continue;
      let matched = false;
      try { matched = new RegExp(pattern, "i").test(update.message); } catch { matched = update.message.includes(pattern); }
      if (!matched) continue;
      task.matchedWakePatterns.push(pattern);
      void this.wake(task, "match", `Task ${task.taskId} matched ${JSON.stringify(pattern)}: ${update.message}`);
    }
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

  private progressMessage(group: BackgroundExecutionGroup, task: BackgroundTaskRecord, message: string): void {
    const previous = task.state;
    task.state = /review/i.test(message) ? "reviewing" : /land|integrat/i.test(message) ? "landing" : "running";
    addActivity(task, task.state, message);
    task.updatedAt = new Date().toISOString();
    const saved = this.save(group);
    void saved.catch(() => undefined);
    const transition = stateTransitionNotice(task, previous, task.state);
    const snapshot = transition ? transitionEventSnapshot(group, task) : undefined;
    if (transition) void saved.then(() => this.wake(task, "state", transition, snapshot)).catch(() => undefined);
    this.updateIndicator();
  }

  private async checkpointParent(
    reviewWindowId: number | undefined,
    baseline: WorkspaceSnapshot | undefined,
    before: WorkspaceSnapshot | undefined,
    sourceRoot: string,
    landedPaths: string[],
  ): Promise<void> {
    if (!baseline || !before || reviewWindowId === undefined || this.input.state.reviewWindow?.id !== reviewWindowId || landedPaths.length === 0) return;
    const after = await createWorkspaceSnapshot(sourceRoot, {
      maxFileBytes: this.input.config.maxFileBytes,
      maxSnapshotBytes: this.input.config.maxSnapshotBytes,
      reuseUnchangedFrom: before,
    });
    checkpointReviewWindow(this.input.state, selectiveCheckpoint(baseline, before, after, landedPaths, sourceRoot));
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
    kind: "completion" | "failure" | "match" | "state",
    content: string,
    eventSnapshot?: { group: BackgroundExecutionGroup; task: BackgroundTaskRecord },
  ): Promise<void> {
    const lane = kind === "state"
      ? "now"
      : kind === "completion"
      ? task.definition.wakeOn?.completion ?? "soon"
      : kind === "failure"
        ? task.definition.wakeOn?.failure ?? "now"
        : "now";
    const owner = [...this.groups.values()].find((group) => group.tasks.some((candidate) => candidate.taskId === task.taskId));
    const eventOwner = eventSnapshot?.group ?? owner;
    const eventTask = eventSnapshot?.task ?? task;
    const eventContent = eventOwner ? formatExecutionEvent(eventOwner, eventTask, kind, content) : content;
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

  private async save(group: BackgroundExecutionGroup): Promise<void> {
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
  }

  private async publishAssociations(): Promise<void> {
    await this.input.onAssociationsChanged?.(this.associations());
  }

  private updateIndicator(): void {
    const ctx = this.uiContext;
    if (!isRecord(ctx) || !isRecord(ctx.ui) || typeof ctx.ui.setWidget !== "function") return;
    const live = [...this.groups.values()].flatMap((group) => group.tasks).filter((task) => isActiveState(task.state));
    try {
      if (this.expandedView) {
        const all = [...this.groups.values()]
          .flatMap((group) => group.tasks.map((task) => ({ group, task })))
          .sort((left, right) => right.task.updatedAt.localeCompare(left.task.updatedAt));
        const activeTasks = all.filter(({ task }) => isActiveState(task.state));
        const shown = activeTasks.slice(0, 16);
        const lines = [
          `⟳ ${live.length} active execution subtask${live.length === 1 ? "" : "s"} — expanded live view (/subtasks-view to collapse)`,
        ];
        if (this.conflictGate) lines.push(`CRITICAL conflict: ${this.conflictGate.paths.join(", ")}`);
        if (shown.length === 0) lines.push("  No active execution subtasks.");
        for (const { task } of shown) {
          const reviewers = task.reviewStatus
            ? ` · reviewers ${task.reviewStatus.reviewers.join(", ") || "none"} (${task.reviewStatus.phase})`
            : "";
          const command = task.commands.at(-1);
          const latestCommand = command ? ` · ${command.action} ${command.status}` : "";
          lines.push(`  ${task.definition.title} [${task.state}] · ${executorDisplayLabel(task, this.input.config)}${reviewers}${latestCommand}`);
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
            ...live.slice(0, 3).map((task) => `${task.definition.title} (${task.state === "queued" ? "queued: executor startup/capacity wait" : task.state})`),
            ...(live.length > 3 ? [`+${live.length - 3} more`] : []),
          ].join(", ");
      ctx.ui.setWidget("review-gate-subtasks", [`⟳ ${live.length} execution subtask${live.length === 1 ? "" : "s"} — ${detail}`], { placement: "belowEditor" });
    } catch {
      // UI surfaces are optional in print/headless harnesses.
    }
  }
}

function clipActivity(value: string, max = 180): string {
  const compact = value.replace(/\s+/g, " ").trim();
  return compact.length <= max ? compact : `${compact.slice(0, Math.max(1, max - 1))}…`;
}

function executorDisplayLabel(task: BackgroundTaskRecord, config: ReviewGateConfig): string {
  if (!task.executorEntryId) return "executor pending";
  const entry = resolvedExecutorPool(config).find((candidate) => candidate.entryId === task.executorEntryId);
  if (!entry) return task.executorEntryId;
  if (entry.selection.source === "little-coder") return entry.selection.model;
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
  kind: "completion" | "failure" | "match" | "state",
  content: string,
): string {
  const landed = group.tasks.filter((candidate) => candidate.state === "landed");
  const notLanded = group.tasks.filter((candidate) => candidate.state !== "landed");
  const active = group.tasks.filter((candidate) => isActiveState(candidate.state));
  const title = task.definition.title;
  const lines = [
    content,
    "",
    `Task: ${task.taskId} · ${title} · ${task.state}`,
  ];
  const landedPaths = [
    ...(task.result?.landing?.appliedPaths ?? []),
    ...(task.result?.landing?.alreadyAppliedPaths ?? []),
  ];
  if (landedPaths.length > 0) lines.push(`Landed paths: ${[...new Set(landedPaths)].join(", ")}`);
  if (notLanded.length === 0) {
    if (kind === "completion") {
      lines.push(`Execution ${group.executionId} COMPLETE: ${landed.length}/${group.tasks.length} tasks landed.`);
      lines.push("All requested task outputs have landed; aggregate verification is now appropriate.");
    } else if (kind === "failure") {
      lines.push(`Execution ${group.executionId} has ${landed.length}/${group.tasks.length} tasks landed, but this interaction reported a failure.`);
      lines.push("Inspect the failed command and verify the landed output before treating the execution as successful.");
    } else {
      lines.push(`Execution ${group.executionId} currently has ${landed.length}/${group.tasks.length} tasks landed.`);
      lines.push("This is an informational state update; rely on the separate completion or failure event for the execution outcome.");
    }
    if (kind === "state") lines.push(noActionNecessaryNotice);
    return lines.join("\n");
  }
  const disposition = active.length > 0 ? "IN PROGRESS" : "INCOMPLETE";
  lines.push(`Execution ${group.executionId} ${disposition}: ${landed.length}/${group.tasks.length} landed; ${notLanded.length} not landed.`);
  if (kind === "completion") {
    lines.push("This is a partial task completion, not completion of the whole execution. Do not verify or claim outputs from tasks that have not landed.");
  } else if (kind === "failure") {
    lines.push("The whole execution is not successfully complete. Use the task handles and states below to recover deliberately.");
  }
  lines.push("Tasks not yet landed:");
  for (const candidate of notLanded) {
    lines.push(`- ${candidate.taskId} · ${candidate.definition.title} · ${candidate.state}`);
  }
  if (kind === "state") lines.push(noActionNecessaryNotice);
  return lines.join("\n");
}

const noActionNecessaryNotice = "NO ACTION OR ACKNOWLEDGEMENT IS NECESSARY for this status update unless you want to steer the task or the reported state requires recovery. Do not call inspect merely to acknowledge it; if no action is needed, remain idle and wait for the next event.";

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
    commands: [],
    matchedWakePatterns: [],
  };
}

function addActivity(task: BackgroundTaskRecord, phase: string, message: string): void {
  if (task.activity.at(-1)?.message === message) return;
  task.activity.push({ sequence: task.nextActivitySequence++, at: new Date().toISOString(), phase, message });
  if (task.activity.length > MAX_ACTIVITY) task.activity.splice(0, task.activity.length - MAX_ACTIVITY);
}

function stateFromProgress(update: WaveProgressUpdate): BackgroundTaskState | undefined {
  if (update.phase === "capturing") return "capturing";
  if (update.phase === "integrating" || update.phase === "planning") return "waiting_to_land";
  if (update.phase === "landing") return "landing";
  if (update.phase === "completed" || update.phase === "aborted" || update.phase === "settling") return undefined;
  const phase = update.subtask?.phase ?? update.taskStatuses?.[0]?.phase;
  if (phase === "reviewing" || phase === "correcting" || phase === "confirming") return "reviewing";
  if (phase === "executing" || phase === "starting") return "running";
  if (update.phase === "working" && (phase === "accepted" || phase === "accepted_with_warnings" || phase === "completed_unreviewed" || phase === "no_changes")) return "accepted";
  return undefined;
}

function isActiveState(state: BackgroundTaskState): boolean {
  return ["queued", "capturing", "running", "reviewing", "accepted", "waiting_to_land", "landing"].includes(state);
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
  return parsed;
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
  baseline: WorkspaceSnapshot,
  before: WorkspaceSnapshot,
  after: WorkspaceSnapshot,
  paths: string[],
  sourceRoot: string,
): WorkspaceSnapshot {
  const absolute = new Set(paths.map((path) => resolve(sourceRoot, path)));
  const files = new Map(baseline.files);
  for (const [key, afterFile] of after.files) {
    if (!absolute.has(afterFile.absolutePath)) continue;
    if (!parentChanged(baseline.files.get(key), before.files.get(key))) files.set(key, afterFile);
  }
  for (const [key, baselineFile] of baseline.files) {
    if (!absolute.has(baselineFile.absolutePath) || after.files.has(key)) continue;
    if (!parentChanged(baselineFile, before.files.get(key))) files.delete(key);
  }
  return { cwd: baseline.cwd, capturedAt: after.capturedAt, files };
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
