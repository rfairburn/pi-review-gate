import { randomUUID } from "node:crypto";
import { mkdtemp, readdir, realpath, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { ExecutorPoolEntry, ReviewGateConfig, ScheduledTaskReviewOverride } from "../config";
import {
  resolvedWorkerResource,
  resolvedWorkerResources,
  resolvedWorkerRoute,
  workerResourceSupportsResearch,
} from "../config";
import { expandHomePath } from "../apply-patch/paths";
import { createWorkspaceSnapshot, type WorkspaceSnapshot } from "../capture";
import { activeExchangeBaseline, type ReviewBaseline, type ReviewGateState } from "../state";
import { type ReviewCheckpointDescriptor } from "../review-checkpoint";
import { configDigest, type ExecutionAssociationsSnapshot } from "../session-state";
import { materializeLandingConflicts } from "./conflict-materialization";
import { ConflictGateStore, cloneConflictGate, type ConflictGate as BackgroundConflictGate } from "./conflict-gate-store";
import {
  GROUP_VERSION,
  INLINE_SETTLED_TASK_LIMIT,
  MAX_UNSETTLED_TASKS_PER_EXECUTION,
  readGroup,
  readOwnedTaskArchive,
  removeOwnedExecutionRoot,
  removeOwnedWaveRoot,
  serializeGroupSnapshot,
  writeGroupSnapshot,
  type BackgroundExecutionGroup,
  type PriorArchiveRecord,
} from "./background-group-store";
import { ExecutorPoolScheduler, type ExecutorPoolLease } from "./executor-pool";
import { inspectOperation, readVerifiedAcceptedResult, verifyInPlaceContinuation, verifyRecoveryCheckpoint } from "./operation-actions";
import type { OperationRecord, ReattachmentBundle } from "./operation-record";
import { createReattachmentBundle, operationOwnershipStatus, operationRecordPath, readOperationRecord } from "./operation-record";
import { resolveArtifactRoot } from "./evidence/sources";
import { buildSubtaskEvidence, readConfinedOperationRecord, readSubtaskEvidence, type SubtaskEvidenceRead, type SubtaskEvidenceSelector, type SubtaskEvidenceUnavailable } from "./subtask-evidence";
import { sourceMutationCoordinator } from "./source-mutation-lease";
import {
  registerOwnedActivitySource,
  type OwnedActivitySourceHandle,
} from "../session-host/owned-activity";
import {
  appendActivity,
  cloneTask,
  isActiveTaskState,
  isArchivableTaskState,
  isInPlaceKind,
  MAX_ACTIVITY,
  newTask,
  salvageEvidenceRequiresRetention,
  taskTiming,
  transitionTaskState,
  workerRouteKeyForKind,
  type BackgroundActivityEvent,
  type BackgroundCommandRecord,
  type BackgroundTaskDefinition,
  type BackgroundTaskKind,
  type BackgroundTaskRecord,
  type BackgroundTaskState,
  type BackgroundTaskTimingSummary,
} from "./task-state";
import {
  captureSalvageSource,
  describeSalvageSource,
  identifyWorkBeyondCheckpoint,
  landedReviewStatusOf,
  recordSalvageProvenanceIncident,
  resolveUnverifiedForceMergeBundle,
  salvageProvenanceFor,
  sameWorkspaceGate,
  type ForceMergeLandingSource,
  type LandedReviewStatus,
} from "./force-merge-salvage";
import { deriveGroupConfig, resolveGroupRoute } from "./scheduled-group-config";
import { ParentCheckpointLedger, type ParentCheckpointSaveResult } from "./parent-checkpoint-ledger";
import { WakeDelivery } from "./wake-delivery";
import { SubtaskIndicator } from "./subtask-indicator";
import { runResearchContinuation, runResearchFresh, researchWorktree } from "./research-task-lifecycle";
import { runInPlaceTaskContinuation, runInPlaceTaskFresh } from "./inplace-task-lifecycle";
import { runWaveTaskContinuation, runWaveTaskFresh } from "./wave-task-lifecycle";
import type {
  LifecycleActivity,
  LifecycleBookkeeping,
  LifecycleConfig,
  LifecycleDispatch,
  LifecycleExecutor,
  LifecycleGates,
  LifecycleIndicator,
  LifecycleLiveControl,
  LifecyclePersistence,
  LifecycleSteering,
  LifecycleWake,
  PersistedGroupRevision,
  RuntimeTaskHandle,
} from "./task-lifecycle-services";
import type { InPlaceLifecycleDeps } from "./inplace-task-lifecycle";
import type { ResearchLifecycleDeps } from "./research-task-lifecycle";
import type { WaveLifecycleDeps } from "./wave-task-lifecycle";
import {
  completionGroupAggregateLines,
  isToolResultConfirmedCompletionWake,
  type SubtaskWakeActor,
} from "./subtask-notifications";
import { notifyDispatchCards } from "./dispatch-cards";
import type { ExecutorInteractionAcknowledgement, ExecutorLiveControl, SubtaskDispatchRecord } from "./types";
import { readWaveCaptureRecord } from "./wave-repository";
import { executeWaveLanding, planWaveLanding } from "./wave-landing";
import { waveLineageOf } from "./wave-commits";
import { pinCommit } from "./wave-worktrees";
import type { StartLiveness } from "../tool-call-fingerprint";

/**
 * Finding 13: the controller no longer owns pure task-state/timing
 * bookkeeping (./task-state), durable group/archive format mechanics
 * (./background-group-store), or widget view-model rendering
 * (./subtask-widget). Finding 14 moves notification policy, event
 * formatting, and the L8 bounded failure diagnostic to ./subtask-notifications;
 * the original public surface of this module is preserved via the re-exports
 * below. Finding 15 bounds execution persistence and top-off scaling here:
 * unsettled tasks are capped per execution, settled tasks beyond a small
 * recent inline window are evicted to their independently addressed archives
 * after each durable save (aggregate counts keep completion notifications
 * truthful), restore hydrates only the bounded window, and exact historical
 * (executionId, taskId) inspection/recovery lazily loads and integrity-checks
 * the compacted archive. Routine save/widget work therefore stays
 * proportional to bounded live/recent state instead of lifetime tasks.
 */
export { formatWatchEvent } from "./subtask-notifications";
export type { WakeFailureDiagnostic } from "./subtask-notifications";
export {
  BACKGROUND_TASK_STATES,
  isActiveTaskState,
  isArchivableTaskState,
  isForceMergeCandidateTaskState,
  isInterruptibleTaskState,
  stateFromContinuationProgress,
  stateFromWaveProgress,
} from "./task-state";
export { INLINE_SETTLED_TASK_LIMIT, MAX_UNSETTLED_TASKS_PER_EXECUTION };
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
// #237: the parent-checkpoint ownership ledger lives in
// ./parent-checkpoint-ledger; the session writer's receipt protocol keeps its
// original public surface via the re-exports below.
export { acknowledgeOwnerRetiringSave } from "./parent-checkpoint-ledger";
export type { ParentCheckpointSaveResult } from "./parent-checkpoint-ledger";
// #237: the in-place completion prose helpers ship from their lifecycle home
// (./inplace-task-lifecycle); the original public surface is preserved here.
export {
  INPLACE_COMPLETION_MAX_NAMED_PATHS,
  buildInPlaceCompletionLines,
  formatInPlaceChangedPaths,
  formatInPlaceExternalPaths,
  inPlaceChangedLine,
  inPlaceExternalLine,
  inPlaceFailureError,
  inPlaceLimitLines,
  inPlaceReviewDisposition,
} from "./inplace-task-lifecycle";
// #154: conflict-gate storage/validation moved to ./conflict-gate-store; the
// original public surface of this module is preserved via the re-export below.
export type { ConflictGate as BackgroundConflictGate } from "./conflict-gate-store";

/** Durable forced-salvage provenance and landing-source identity live in
 *  ./force-merge-salvage; pure scheduled route/config derivations live in
 *  ./scheduled-group-config. The controller keeps consuming them at their
 *  existing call points. */
const RECENT_ACTIVITY_LIMIT = 10;

export interface BackgroundForceMergeInput {
  executionId?: string;
  taskId?: string;
  mergeAnyhow: boolean;
  instructionId: string;
  /** #117: the invoking actor decides completion-wake delivery (see isToolResultConfirmedCompletionWake). */
  actor: SubtaskWakeActor;
}

/** Per-landed-task aggregate folded into a mark-clean result (#117). */
export interface BackgroundMarkCleanAggregate {
  executionId: string;
  taskId: string;
  /** Group aggregate lines built by the shared completion formatter. */
  aggregate: string;
}

export interface BackgroundMarkCleanResult {
  cleared: boolean;
  paths: string[];
  /**
   * #117: group aggregates folded into this result for landed tasks whose
   * completion wakes were suppressed because the model's direct tool result
   * already confirms them. Absent when no aggregate is folded in (user-actor
   * invocations keep their per-task completion wakes).
   */
  completionAggregates?: BackgroundMarkCleanAggregate[];
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

/** A force-merge request that is not a runtime task but must stay cancellable. */
interface PendingForceMerge {
  abort: AbortController;
  /** Resolves once the force-merge settles and its durable outcome is saved. */
  done: Promise<void>;
  /** True once the source mutation lease has been acquired. */
  acquired: boolean;
}

/**
 * Issue #26 overlap semantics: a scheduled run blocks its entry's next
 * occurrence while any task is unsettled. Terminal outcomes are landed,
 * reported (research success), failed, and interrupted; every other state
 * — including conflicted, paused_recoverable, and
 * stopped_for_application_exit — keeps the entry occupied until it is
 * resolved or terminalized through the ordinary recovery paths.
 */
const SCHEDULED_SETTLED_STATES: ReadonlySet<BackgroundTaskState> = new Set([
  "landed",
  "reported",
  "failed",
  "interrupted",
]);

function isSettledScheduledState(state: BackgroundTaskState): boolean {
  return SCHEDULED_SETTLED_STATES.has(state);
}

interface BackgroundControllerInput {
  pi: unknown;
  config: ReviewGateConfig;
  state: ReviewGateState;
  cwd: () => string;
  notify?: (message: string) => void | Promise<void>;
  /** Only true or a save-and-retirement receipt confirms a durable parent sidecar write. */
  onAssociationsChanged?: (associations: ExecutionAssociationsSnapshot) => ParentCheckpointSaveResult | Promise<ParentCheckpointSaveResult>;
  onExpandedViewChanged?: (expanded: boolean) => void | Promise<void>;
  /**
   * #306: one-shot consumption observer at the existing dispatch-record
   * seam. Invoked for every actual transport-boundary dispatch record of a
   * SCHEDULED group (group.scheduledTaskId set), including retry/failover
   * turn deliveries of an already-consumed execution — the observer is
   * idempotent and decides eligibility itself. Never invoked for
   * non-scheduled groups or for failures before delivery.
   */
  onScheduledDispatchRecorded?: (scheduledTaskId: string) => void;
  faults?: BackgroundFaultHooks;
  /**
   * Deterministic test seam: when set, `launch` invokes this runner instead of
   * the per-kind lifecycle runner. The controller still owns every scheduling
   * responsibility — global/per-resource slot accounting, lease
   * acquisition/release, runtime registration, and rejection terminalization —
   * so tests can exercise the real pump/refill behavior at full worker counts
   * without dispatching a real process or provider call per task.
   */
  lifecycleRunner?: (
    group: BackgroundExecutionGroup,
    task: BackgroundTaskRecord,
    abort: AbortController,
    lease: ExecutorPoolLease,
  ) => Promise<void>;
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
  materializeLandingConflicts?: (context: BackgroundFaultContext) => unknown;
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
  /** Lifetime tasks ever admitted to this execution (truthful total). */
  historicalCount: number;
  /**
   * Finding 15: settled tasks persisted only in their per-task archives and
   * therefore omitted from `tasks` here; recover them by exact taskId.
   */
  archivedCount: number;
  scheduling: BackgroundSchedulingSnapshot;
  /** Issue #33: bounded evidence navigation result (only for evidence-mode inspect). */
  evidence?: SubtaskEvidenceRead;
  /**
   * #93: the exact task ids created by the add() call that produced this
   * inspection — `tasks` is the whole execution inventory, so original Add
   * cards select their own tasks by these ids (never by title or instruction
   * matching). Absent on start/inspect results.
   */
  addedTaskIds?: string[];
  /**
   * #117: group aggregate folded into the direct tool result when a
   * synchronous landing's completion wake is suppressed because the model's
   * own tool result already confirms it (force-merge / interrupt-with-merge).
   * Absent whenever a completion wake is still delivered for the landing.
   */
  completionAggregate?: string;
  conflictGate?: BackgroundConflictGate;
  tasks: Array<BackgroundTaskRecord & {
    timing: BackgroundTaskTimingSummary;
    dispatchState?: "waiting_for_capacity" | "assigned_starting";
    artifactDir?: string;
    liveControl?: { adapter: string; generation: number; protocol?: string; steer: boolean; interrupt: boolean };
  }>;
}

/**
 * In-memory dispatch provenance projection for original SubtasksStart/SubtasksAdd
 * tool cards (#93). Read directly from the authoritative task records at render
 * time: no inspection call, no filesystem I/O, no duplicate truth state.
 * Absent `dispatch`/`initialDispatch` means not yet sent — nothing fabricated.
 */
export interface SubtaskCardDispatchViewTask {
  taskId: string;
  /** Authoritative current state of the live task record. */
  state: BackgroundTaskState;
  /** Queued-only dispatch detail, mirroring inspection's dispatchState. */
  dispatchState?: "waiting_for_capacity" | "assigned_starting";
  initialDispatch?: SubtaskDispatchRecord;
  dispatch?: SubtaskDispatchRecord;
}

export interface SubtaskCardDispatchView {
  executionId: string;
  kind: BackgroundTaskKind;
  /** Target checkout the group captures from and lands into. */
  targetWorkspace: string;
  tasks: SubtaskCardDispatchViewTask[];
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

/**
 * Issue #26: scheduled-dispatch options. The controller only records and
 * validates them; the process-local scheduler runtime owns when they are
 * used. A pinned worker resource resolves against the CURRENT catalog at
 * dispatch time (live inheritance), and a review override is task-local:
 * `off` disables the subtask review stage without fabricating a PASS,
 * `selected` uses exactly the listed set, omitted inherits global settings.
 */
export interface ScheduledStartOptions {
  /** Stable scheduled-task entry id; persisted on the group for overlap detection across restarts. */
  scheduledTaskId?: string;
  /** Explicit worker resource id pinned for this run's tasks. */
  workerResourceId?: string;
  /** Task-local review choice frozen per run (execute groups only). */
  reviewOverride?: ScheduledTaskReviewOverride;
  /** Hashed SubtasksStart-equivalent input used to identify matching active groups. */
  startCallFingerprint?: string;
  /**
   * Issue #222 (partial #215): causal-ordering gate for the shared
   * non-model-initiated launch notice. The controller holds every result
   * notification for this execution behind this promise until the launch
   * notice resolves, so a subtask that settles milliseconds after admission
   * can never deliver its outcome before the notice naming it. The gate is
   * process-local, never persisted, and resolved by the dispatcher after its
   * bounded delivery attempt, including an uncertain or failed send.
   */
  launchNoticeGate?: Promise<void>;
}

/**
 * Owned-work observation for native session cards (the execution component of
 * `backgroundTasks`). The source is registered by the authoritative controller
 * lifecycle, not at module load, and starts UNCERTAIN: the category stays
 * unknown until `restore()` has accounted for this controller's owned set and
 * whenever restoration or ownership verification fails. Positive task-id
 * tokens track active/queued logical work plus every unsettled owned runtime
 * or unverified operation association, and are never released merely because
 * an in-memory task index was cleared. The registry stays inert (no IO, no
 * observation) until the authenticated session-host reporter opts in. This is
 * a count of logical owned work units, not of PIDs or processes.
 */

/**
 * Pure ownership predicate for one task (shared with focused synthetic tests).
 * A task still owns unsettled background work when it is queued/active, when a
 * live executor runtime or force-merge exists, or when it is non-archivable and
 * shows any evidence that it was started: a durable continuation bundle, a wave
 * root, an in-place operation record, or a non-zero lifecycle generation. A
 * missing continuation bundle is NOT proof of writer settlement (in-place
 * settlement clears it, and wave recovery can fail before it is assigned), so
 * started work is retained until an authoritative archivable outcome exists.
 * Undispatched tasks (generation 0, no anchors) release normally.
 */
export function taskOwnsUnsettledWork(
  task: {
    state: BackgroundTaskRecord["state"];
    generation?: number;
    waveRoot?: string;
    bundle?: { operationId?: string } | undefined;
    inplaceResult?: { operationRecord?: string } | undefined;
  },
  hasRuntime: boolean,
  hasForceMerge: boolean,
): boolean {
  if (isActiveTaskState(task.state)) return true;
  if (hasRuntime) return true;
  if (hasForceMerge) return true;
  return !isArchivableTaskState(task.state) && Boolean(
    task.bundle?.operationId
    || task.waveRoot
    || task.inplaceResult?.operationRecord
    || (task.generation ?? 0) > 0,
  );
}

/**
 * Pure ACTIVITY-INTENT predicate for one task (shared with focused synthetic
 * tests): true while the task is admitted/queued or actively capturing,
 * running, reviewing, accepted, waiting to land, or landing, or while it has an
 * in-flight force-merge operation. Unlike `taskOwnsUnsettledWork`, retained
 * cleanup/recovery anchors (a resumable continuation bundle, wave root, in-place
 * operation record, or a non-zero lifecycle generation) do NOT count: a
 * stopped/paused/failed task is not activity merely because its artifacts are
 * still owned. An actual force-merge operation is activity while it executes
 * even if the task's terminal state has not changed, and a queued task counts
 * immediately. A pending continuation admission validation does NOT count: only
 * the accepted, queued transition does. A conflict gate with no active writer
 * does not count.
 */
export function taskHasActiveIntent(
  task: { state: BackgroundTaskRecord["state"] },
  hasForceMerge: boolean,
): boolean {
  return isActiveTaskState(task.state) || hasForceMerge;
}

export class BackgroundExecutionController {
  private readonly groups = new Map<string, BackgroundExecutionGroup>();
  /** Owner of this controller incarnation's positive owned-work tokens. */
  private readonly ownedActivity: OwnedActivitySourceHandle;
  private readonly runtimes = new Map<string, RuntimeTaskHandle>();
  private readonly pendingForceMerges = new Map<string, PendingForceMerge>();
  /** Reserve command admission before recovery's first await, including bundle adoption. */
  private readonly continuationAdmissions = new Set<string>();
  private readonly saveTails = new Map<string, Promise<void>>();
  private readonly steeringTails = new Map<string, Promise<void>>();
  private readonly archivedTasks = new Map<string, { updatedAt: string; integritySha256: string; executionId?: string; legacy?: boolean }>();
  /**
   * Finding 15: authenticated membership handles for legacy settled stubs that
   * are archive-only (evicted from a legacy manifest or covered by the durable
   * membership index). Entries are scoped per execution so a copied or
   * colliding archive can never authenticate an old handle in another group.
   */
  private readonly legacyArchiveHandles = new Map<string, {
    entries: Map<string, { integritySha256: string; updatedAt: string }>;
    /** True once the membership index covering these handles is durably written. */
    persisted: boolean;
  }>();
  /** #175/#25: the one authoritative parent-checkpoint ledger (guards,
   * selective checkpointing, review disposition, two-owner composition and
   * receipt-gated retirement). Wave runners consume this same instance. */
  private readonly ledger: ParentCheckpointLedger;
  /** Issue #222/#117/#222: wake, watch, and launch-notice delivery state and
   *  sequencing (./wake-delivery); the controller keeps admission and every
   *  durable authority. */
  private readonly wakes: WakeDelivery;
  /**
   * Narrow lifecycle capabilities (./task-lifecycle-services) handed to the
   * extracted per-kind runners. Every durable authority — admission, the
   * group/task records, runtimes and leases, save/steering tails, command
   * transitions, gate installation, checkpoints, force-merge/markClean —
   * stays in this controller; each capability is a live projection.
   */
  private readonly caps: {
    persistence: LifecyclePersistence;
    notify: (message: string) => void | Promise<void>;
    wake: LifecycleWake;
    activity: LifecycleActivity;
    dispatch: LifecycleDispatch;
    indicator: LifecycleIndicator;
    config: LifecycleConfig;
    executor: LifecycleExecutor;
    steering: LifecycleSteering;
    live: LifecycleLiveControl;
    gates: LifecycleGates;
    bookkeeping: LifecycleBookkeeping;
  };
  private readonly researchDeps: ResearchLifecycleDeps;
  private readonly inplaceDeps: InPlaceLifecycleDeps;
  private readonly waveDeps: WaveLifecycleDeps;
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
  /**
   * #25 multi-target: one outstanding conflict gate per resolved source root.
   * Different targets keep independent gates and lease blocks, so concurrent
   * conflicts on separate repositories cannot overwrite, early-release, or
   * leak each other's block; landings into an already-gated root serialize
   * behind that root's block in the coordinator instead.
   * #154: the map, its root-keyed identity/lookups, lease blocking, and
   * unresolved-marker/sidecar validation live in ./conflict-gate-store; this
   * controller keeps the lifecycle orchestration (transitions, saves,
   * notifications, force-merge) and sequences the store.
   */
  private readonly conflictGates = new ConflictGateStore();
  /** Indicator presentation state (./subtask-indicator); the controller
   *  feeds live projections only. */
  private readonly indicator: SubtaskIndicator;

  constructor(private readonly input: BackgroundControllerInput) {
    // Register this controller incarnation as UNCERTAIN: the execution
    // category stays unknown until restore() has accounted for every owned
    // association (or established that there is none). The ACTIVITY-INTENT
    // channel has its own uncertainty flag: the admitted/running set is not
    // authoritative until the same restore completes, and is resolved
    // independently so retained cleanup never keeps activity unknown.
    this.ownedActivity = registerOwnedActivitySource("backgroundTasks", "execution", {
      uncertain: true,
      intentUncertain: true,
    });
    this.pool = new ExecutorPoolScheduler(resolvedWorkerResources(input.config));
    this.ledger = new ParentCheckpointLedger({
      config: () => this.input.config,
      state: () => this.input.state,
      cwd: () => this.input.cwd(),
      notify: (message) => this.input.notify?.(message),
      onAssociationsChanged: (associations) => this.input.onAssociationsChanged?.(associations),
      associationsSnapshot: () => this.associations(),
      addActivityContext: (context, phase, message) => {
        const group = context.executionId ? this.groups.get(context.executionId) : undefined;
        const task = context.taskId ? group?.tasks.find((candidate) => candidate.taskId === context.taskId) : undefined;
        if (task) this.addActivity(task, phase, message);
      },
      faults: () => this.input.faults,
    });
    this.wakes = new WakeDelivery({
      config: () => this.input.config,
      pi: () => this.input.pi,
      notify: (message) => this.input.notify?.(message),
      faults: () => this.input.faults,
      groupOf: (taskId) => [...this.groups.values()].find((group) => group.tasks.some((candidate) => candidate.taskId === taskId)),
      schedulingSnapshot: (group, releasingTask) => this.schedulingSnapshot(group, releasingTask),
      inspect: (executionId) => this.inspect(executionId),
      gateForTask: (executionId, taskId) => this.gateForTask(executionId, taskId),
    });
    // Narrow per-kind lifecycle capabilities (no host bag): the extracted
    // runners receive exactly the members their deps interfaces declare,
    // all evaluated live against this controller's state.
    this.caps = {
      persistence: { save: (group) => this.save(group), publishAssociations: () => this.publishAssociations() },
      notify: (message) => this.input.notify?.(message),
      wake: { wake: (task, kind, content, snapshot) => this.wake(task, kind, content, snapshot) },
      activity: { add: (task, phase, message) => this.addActivity(task, phase, message) },
      dispatch: { record: (group, task, record) => this.recordDispatch(group, task, record) },
      indicator: { update: () => this.updateIndicator() },
      config: {
        base: () => this.input.config,
        forGroup: (group) => this.groupConfig(group),
        scopedModels: () => this.scopedModels,
      },
      executor: {
        routeOf: (group) => this.routeForGroup(group),
        pool: () => this.pool,
        acquireAfterRoute: (current, routeOf, signal) => this.pool.acquireAfterRoute(current, routeOf, signal),
      },
      steering: {
        prestart: (group, task) => this.incorporatePrestartSteering(group, task),
        continuation: (group, task, instructions) => this.incorporateContinuationSteering(group, task, instructions),
        claimDeferred: (group, task) => this.takeDeferredSteering(group, task),
        failUndelivered: (task, reason) => this.failUndeliveredSteering(task, reason),
        failUndeliveredContinuation: (task, reason) => this.failUndeliveredContinuation(task, reason),
        acknowledgeInterrupt: (task) => this.acknowledgeInterrupt(task),
        flushQueued: (group, task, runtime, control) => this.flushQueuedSteering(group, task, runtime, control),
      },
      live: { runtime: (taskId) => this.runtimes.get(taskId) },
      gates: {
        install: (gate) => this.setConflictGate(gate),
        gateForTask: (executionId, taskId) => this.gateForTask(executionId, taskId),
        criticalPrompt: (gate) => this.criticalPrompt(gate),
      },
      bookkeeping: { tolerate: (task, step, run, outcome) => this.completeLandedBookkeeping(task, step, run, outcome) },
    };
    this.researchDeps = {
      persistence: this.caps.persistence,
      notify: this.caps.notify,
      wake: this.caps.wake,
      activity: this.caps.activity,
      dispatch: this.caps.dispatch,
      indicator: this.caps.indicator,
      config: { base: this.caps.config.base, scopedModels: this.caps.config.scopedModels },
      executor: { acquireAfterRoute: this.caps.executor.acquireAfterRoute, routeOf: this.caps.executor.routeOf },
      steering: {
        prestart: this.caps.steering.prestart,
        continuation: this.caps.steering.continuation,
        claimDeferred: this.caps.steering.claimDeferred,
        failUndelivered: this.caps.steering.failUndelivered,
        acknowledgeInterrupt: this.caps.steering.acknowledgeInterrupt,
        flushQueued: this.caps.steering.flushQueued,
      },
      live: this.caps.live,
    };
    this.inplaceDeps = {
      persistence: this.caps.persistence,
      notify: this.caps.notify,
      wake: this.caps.wake,
      activity: this.caps.activity,
      dispatch: this.caps.dispatch,
      indicator: this.caps.indicator,
      config: { forGroup: this.caps.config.forGroup, scopedModels: this.caps.config.scopedModels },
      executor: { acquireAfterRoute: this.caps.executor.acquireAfterRoute, routeOf: this.caps.executor.routeOf },
      steering: {
        prestart: this.caps.steering.prestart,
        continuation: this.caps.steering.continuation,
        claimDeferred: this.caps.steering.claimDeferred,
        failUndelivered: this.caps.steering.failUndelivered,
        acknowledgeInterrupt: this.caps.steering.acknowledgeInterrupt,
        flushQueued: this.caps.steering.flushQueued,
      },
      live: this.caps.live,
      artifactDir: (group, task) => this.inplaceArtifactDir(group, task),
    };
    this.waveDeps = {
      persistence: this.caps.persistence,
      notify: this.caps.notify,
      wake: this.caps.wake,
      activity: this.caps.activity,
      dispatch: this.caps.dispatch,
      indicator: this.caps.indicator,
      config: { base: this.caps.config.base, forGroup: this.caps.config.forGroup, scopedModels: this.caps.config.scopedModels },
      executor: { pool: this.caps.executor.pool },
      steering: {
        prestart: this.caps.steering.prestart,
        continuation: this.caps.steering.continuation,
        claimDeferred: this.caps.steering.claimDeferred,
        failUndelivered: this.caps.steering.failUndelivered,
        acknowledgeInterrupt: this.caps.steering.acknowledgeInterrupt,
        flushQueued: this.caps.steering.flushQueued,
      },
      live: this.caps.live,
      gates: this.caps.gates,
      bookkeeping: this.caps.bookkeeping,
      ledger: this.ledger,
      state: () => this.input.state,
      faults: () => this.input.faults,
    };
    this.indicator = new SubtaskIndicator({
      config: () => this.input.config,
      activeTaskEntries: () => [...this.activeTasks.values()],
      isRuntimeActive: (taskId) => this.runtimes.has(taskId),
      conflictGatePaths: () => this.conflictGates.size > 0
        ? this.conflictGates.list().flatMap((gate) => [...gate.paths])
        : undefined,
      recentActivity: () => this.recentActivity,
    }, input.config.ui?.subtasksViewExpanded === true);
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
    this.indicator.setContext(ctx);
  }

  async toggleExpandedView(ctx: unknown): Promise<boolean> {
    if (!isRecord(ctx) || !isRecord(ctx.ui) || typeof ctx.ui.setWidget !== "function") {
      throw new Error("The current harness does not provide a below-editor widget UI.");
    }
    // #25 presentation ownership: the adopted context renders only after the
    // persisted toggle completes, exactly one render, as before.
    this.indicator.useContext(ctx);
    const expanded = !this.indicator.expanded;
    await this.input.onExpandedViewChanged?.(expanded);
    this.indicator.setExpanded(expanded);
    return this.indicator.expanded;
  }

  refreshPool(): void {
    this.pool.reconfigure(resolvedWorkerResources(this.input.config));
    void this.pump();
  }

  syncUiPreferences(): void {
    this.indicator.setExpanded(this.input.config.ui?.subtasksViewExpanded === true);
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
    // #25 multi-target: every outstanding gate is persisted per source root.
    // The legacy singular field is no longer written (restored readers recover
    // it from conflictGates) and conflictGates stays absent when no gate is
    // active so the zero-gate snapshot keeps its exact prior shape.
    const gates = this.conflictGates.list().map(cloneConflictGate);
    return {
      waveRoots: [...new Set(waveRoots)],
      bundles,
      groupRoots: [...this.groups.values()].map((group) => group.root),
      conflictGate: undefined,
      ...(gates.length > 0 ? { conflictGates: gates } : {}),
    };
  }

  async restore(associations: ExecutionAssociationsSnapshot): Promise<void> {
    // Every restore invalidates prior completeness before its first await: the
    // owned set may be changing (or unresolved) until this restore authoritatively
    // accounts for it. A previously complete controller must not keep
    // advertising zero while a new restoration is in flight. The activity-intent
    // channel is invalidated independently of the ownership channel.
    this.ownedActivity.markUncertain();
    this.ownedActivity.markIntentUncertain();
    const initialDetach = this.detach();
    const restoreEpoch = this.detachEpoch;
    await initialDetach;
    // A detach superseding this restore must win: never reattach a group (or
    // register a save tail) after a later detach completed its quiescence.
    const restoreIsCurrent = () =>
      !this.shuttingDown && this.detaching === 0 && this.detachEpoch === restoreEpoch;
    const roots = associations.groupRoots ?? [];
    let restoreAccounted = true;
    // Activity completeness is tracked SEPARATELY from ownership recovery: a
    // task record that was read has an observed state (so its activity is
    // known), even when its retained cleanup association could not be
    // recovered and ownership must stay unknown.
    let restoreActivityAccounted = true;
    for (const root of roots) {
      if (!restoreIsCurrent()) return;
      try {
        const restored = await readGroup(root);
        if (!restoreIsCurrent()) return;
        const group = restored.group;
        // #25: session identity is anchored to the parent session's directory
        // at creation time, independently of the selected execution target.
        if (resolve(this.sessionCwdOf(group)) !== resolve(this.input.cwd())) {
          throw new Error(`execution session cwd ${this.sessionCwdOf(group)} does not match ${resolve(this.input.cwd())}`);
        }
        // Finding 15: seed archive-reuse metadata only for tasks that restored
        // inline (the bounded recent settled window); evicted settled tasks
        // stay archive-only and are recovered lazily per exact task handle, so
        // restore never eagerly hydrates every historical archive. Legacy
        // (version-1) archives are flagged for one-time migration on their
        // next archive write and authenticated via their manifest-covered
        // hashes until then.
        const inlineTaskIds = new Set(group.tasks.map((task) => task.taskId));
        for (const [taskId, archive] of restored.archives) {
          if (inlineTaskIds.has(taskId)) {
            this.archivedTasks.set(this.archiveHandleKey(group.executionId, taskId), {
              updatedAt: archive.updatedAt,
              integritySha256: archive.integritySha256,
              executionId: group.executionId,
              legacy: archive.legacy === true,
            });
          }
        }
        // Legacy evicted stubs (and any durable membership index from a prior
        // compaction) authenticate exact historical handles for this group.
        const legacyHandles = new Map<string, { integritySha256: string; updatedAt: string }>();
        for (const [taskId, entry] of restored.legacyArchives) {
          legacyHandles.set(taskId, { integritySha256: entry.archiveIntegritySha256, updatedAt: entry.updatedAt });
        }
        if (restored.archiveIndex) {
          for (const [taskId, entry] of Object.entries(restored.archiveIndex.entries)) {
            if (!legacyHandles.has(taskId)) legacyHandles.set(taskId, { integritySha256: entry.archiveIntegritySha256, updatedAt: entry.updatedAt });
          }
        }
        if (legacyHandles.size > 0) {
          // Review pass 3: the handles are durably persisted (no rewrite on
          // the next save) exactly when they match the durable membership
          // index restored above — comparing ids, hashes, and timestamps, not
          // just counts, so any divergence still forces a rewrite.
          const durableEntries = restored.archiveIndex?.entries;
          const alreadyPersisted = durableEntries !== undefined
            && legacyHandles.size === Object.keys(durableEntries).length
            && [...legacyHandles].every(([taskId, entry]) => {
              const durable = durableEntries[taskId];
              return durable?.archiveIntegritySha256 === entry.integritySha256
                && durable.updatedAt === entry.updatedAt;
            });
          this.legacyArchiveHandles.set(group.executionId, {
            entries: legacyHandles,
            // Handles sourced from the durable index are already persisted;
            // manifest-evicted legacy stubs still need their index write.
            persisted: alreadyPersisted,
          });
        }
        for (const task of group.tasks) {
          if (group.kind === "execute" && task.waveRoot && !isArchivableTaskState(task.state)) {
            try {
              await this.recoverTaskAssociation(group, task);
            } catch (error) {
              // An unresolved association is not settled ownership: the whole
              // restore cannot establish completeness.
              restoreAccounted = false;
              this.addActivity(task, "recovery", `Checkpoint backfill refused: ${messageOf(error)}`);
              if (task.state === "stopped_for_application_exit") {
                transitionTaskState(task, "paused_recoverable");
                task.summary = "Restart checkpoint verification failed; inspect before any executor is resumed.";
              }
            }
          }
          if (task.state === "stopped_for_application_exit" && task.result?.taskResults[0]?.acceptedCommitSha) {
            transitionTaskState(task, "paused_recoverable");
            task.summary = "Accepted checkpoint retained after restart; inspect and force-merge without rerunning the executor.";
          } else if (task.state === "stopped_for_application_exit" && task.bundle && await this.restoreAdmittedInPlaceContinuation(group, task)) {
            // #179 audit finding: an admitted-but-undispatched explicit
            // in-place continuation is authoritative. The helper either
            // re-verified it and re-queued the original instruction/flag, or
            // failed closed to paused_recoverable with the original command
            // preserved; in neither case is a strict system auto-resume
            // substituted for it.
          } else if (task.state === "stopped_for_application_exit" && task.bundle) {
            const instructionId = `application-resume-${randomUUID()}`;
            task.pendingContinuation = {
              instructions: group.kind === "inplace"
                ? "Resume after the owning application restarted. Reinspect the selected workspace in place and finish the original task without repeating completed work; writes already performed there were not rolled back."
                : "Resume after the owning application restarted. Reinspect the preserved worktree and finish the original task without repeating completed work.",
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
          } else if (task.state === "stopped_for_application_exit" && isInPlaceKind(group.kind) && task.inplaceResult?.session) {
            // #220: a stopped in-place task preserves its executor session and
            // workspace; resume it in place with a system continuation that
            // discloses that prior writes were performed and not rolled back.
            const instructionId = `application-resume-${randomUUID()}`;
            task.pendingContinuation = {
              instructions: "Resume after the owning application restarted. Reinspect the selected workspace in place and finish the original task without repeating completed work; writes already performed there were not rolled back.",
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
            task.summary = "Exact parent conversation restored; in-place continuation queued automatically.";
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
        restoreAccounted = false;
        restoreActivityAccounted = false;
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
        restoreAccounted = false;
        restoreActivityAccounted = false;
        await this.input.notify?.(`review gate: legacy execution bundle was not adopted (${bundle.operationId}): ${messageOf(error)}`);
      }
    }
    if (!restoreIsCurrent()) return;
    // #25 multi-target: recover every persisted outstanding gate — new
    // snapshots carry conflictGates (one per source root); legacy single-gate
    // snapshots fall back to conflictGate. Each gate re-blocks its own root.
    const persistedGates = associations.conflictGates
      ?? (associations.conflictGate ? [associations.conflictGate] : []);
    for (const persisted of persistedGates) {
      this.setConflictGate({ ...persisted, paths: [...persisted.paths] });
    }
    this.pool = new ExecutorPoolScheduler(resolvedWorkerResources(this.input.config));
    this.rebuildRecentActivity();
    this.updateIndicator();
    // Only an unbroken restore authoritatively accounts for this controller's
    // owned set. Any failed/unadopted association keeps execution OWNERSHIP
    // UNKNOWN (never zero) until an authoritative re-establishment. The
    // activity-intent channel is re-established from its own completeness: a
    // task record whose state was read is observed activity even when its
    // cleanup-association recovery failed, so a known stopped task reports zero
    // activity while ownership stays unknown; only a genuinely unreadable
    // group or unobserved admission keeps activity unknown.
    if (restoreAccounted) this.ownedActivity.resolveUncertainty();
    else this.ownedActivity.markUncertain();
    if (restoreActivityAccounted) this.ownedActivity.resolveIntentUncertainty();
    else this.ownedActivity.markIntentUncertain();
    void this.pump();
  }

  async start(
    tasks: BackgroundTaskDefinition[],
    kind: BackgroundTaskKind = "execute",
    workspace?: string,
    options?: ScheduledStartOptions,
  ): Promise<BackgroundInspection> {
    const detachEpoch = this.detachEpoch;
    if (this.shuttingDown || this.detaching > 0) throw new Error("Application shutdown or controller detach is in progress.");
    // #25: resolve the execution target exactly once, before any durable
    // group state exists; a rejected workspace never leaves a group behind.
    const cwd = await this.resolveExecutionTarget(workspace);
    if (options?.workerResourceId !== undefined) {
      // Issue #26: an explicit scheduled worker pin fails closed at creation
      // when it does not resolve against the CURRENT catalog — a group that
      // could never run must never be created silently.
      const pinned = resolvedWorkerResource(this.input.config, options.workerResourceId);
      if (!pinned) {
        throw new Error(`Scheduled worker resource ${options.workerResourceId} no longer exists in /review-settings; update the entry or its worker choice.`);
      }
      if (kind === "research" && !workerResourceSupportsResearch(this.input.config, pinned.selection)) {
        throw new Error(`Scheduled worker resource ${options.workerResourceId} cannot run research tasks; choose a research-capable resource for this entry.`);
      }
    } else if (resolvedWorkerRoute(this.input.config, workerRouteKeyForKind(kind)).length === 0) {
      throw new Error(
        kind === "inplace"
          ? "No execution worker route is configured for in-place tasks. Add at least one eligible resource to the execution priority in /review-settings."
          : `No ${kind} worker route is configured. Add at least one eligible resource in /review-settings.`,
      );
    }
    if (kind === "research" && options?.reviewOverride?.mode === "selected") {
      // Issue #26: research runs have no review stage, so a selected-reviewer
      // override could never take effect. Failing closed here keeps an
      // explicit user choice from being silently discarded; mode "off" is a
      // consistent no-op for research and stays allowed.
      throw new Error("Research tasks have no review stage; remove the selected-reviewer override from this research entry (mode off is fine).");
    }
    // Finding 15: fail closed at the unsettled admission cap before any
    // filesystem resources are created.
    if (tasks.length > MAX_UNSETTLED_TASKS_PER_EXECUTION) {
      throw new Error(
        `At most ${MAX_UNSETTLED_TASKS_PER_EXECUTION} unsettled tasks are admitted per execution; ${tasks.length} were requested. Split the work across sequential top-offs after tasks settle.`,
      );
    }
    // #220 pass-1: the in-place workspace may contain the system temp tree;
    // place the group's artifact root OUTSIDE the selected directory (or fail
    // closed at start when no writable outside location exists). The kind is
    // passed through; execute/research keep the default temp root.
    const { root, tempBase } = await createExecutionRoot(cwd, kind);
    // Group creation awaited the filesystem: a detach/shutdown may have begun
    // (and completed its quiescence) meanwhile. Never attach a group — and
    // // never register a save tail — after lifecycle completion; discard the
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
      ...(tempBase ? { tempBase } : {}),
      cwd,
      sessionCwd: resolve(this.input.cwd()),
      ...(options?.scheduledTaskId !== undefined ? { scheduledTaskId: options.scheduledTaskId } : {}),
      ...(options?.workerResourceId !== undefined ? { scheduledWorkerResourceId: options.workerResourceId } : {}),
      ...(options?.reviewOverride !== undefined ? { scheduledReviewOverride: options.reviewOverride } : {}),
      ...(options?.startCallFingerprint !== undefined ? { startCallFingerprint: options.startCallFingerprint } : {}),
      createdAt: now,
      updatedAt: now,
      peakConcurrency: 0,
      tasks: tasks.map((definition) => newTask(definition)),
      // Finding 15: truthful lifetime aggregates start here and grow with
      // admissions, independent of the bounded inline task window.
      totalTaskCount: tasks.length,
      settledArchivedCount: 0,
    };
    this.groups.set(executionId, group);
    // Issue #222: register the launch-notice gate before the group becomes
    // schedulable, so even a task that settles while this start call is still
    // finishing cannot deliver a result wake before the notice.
    if (options?.launchNoticeGate !== undefined) this.wakes.setLaunchNoticeGate(executionId, options.launchNoticeGate);
    await this.save(group);
    await this.publishAssociations();
    void this.pump();
    return this.inspect(executionId);
  }

  /**
   * #25: resolve the group's execution target once at creation. An omitted or
   * blank workspace defaults to the parent session's working directory,
   * preserving current behavior. A supplied workspace must be an existing,
   * accessible directory (an explicitly authorized development checkout or Git
   * worktree). A leading `~`/`~/...` home prefix expands against the user's
   * home through the shared Pi-native rule before any anchoring; every other
   * spelling — relative, absolute, `~user` — keeps its existing semantics,
   * with relative paths resolving against the parent session's working
   * directory like every other session-relative path in this feature. The
   * target is canonicalized through realpath so the persisted target is a
   * stable identity that later symlink redirection cannot move. The target
   * is the capture/landing destination, never worker scratch: every task still
   * receives its own isolated worktree captured from it. No directory creation,
   * cloning, or worktree management happens here.
   */
  private async resolveExecutionTarget(workspace?: string): Promise<string> {
    const parentCwd = resolve(this.input.cwd());
    if (workspace === undefined || workspace.trim() === "") return parentCwd;
    // #25: session-relative, never anchored at the process cwd, which can
    // diverge from the session's working directory. A leading `~`/`~/...`
    // (the Pi-native home prefix) expands against the user's home before the
    // anchor; every other spelling resolves exactly as before.
    const candidate = resolve(parentCwd, expandHomePath(workspace));
    let stats;
    try {
      stats = await stat(candidate);
    } catch {
      throw new Error(`Execution workspace ${workspace} does not exist or is not accessible.`);
    }
    if (!stats.isDirectory()) {
      throw new Error(`Execution workspace ${workspace} must be an existing directory (an authorized development checkout or Git worktree).`);
    }
    return realpath(candidate);
  }

  /**
   * #25: the parent session's working directory a group was created from.
   * Session-scoped identity checks compare against this value independently of
   * the selected target; legacy groups fall back to `cwd`, which always held
   * the parent session's directory before explicit workspaces existed.
   */
  private sessionCwdOf(group: BackgroundExecutionGroup): string {
    return group.sessionCwd ?? group.cwd;
  }

  /** Composite archive-handle key: archive metadata is scoped per execution. */
  private archiveHandleKey(executionId: string, taskId: string): string {
    return `${executionId}:${taskId}`;
  }

  /** Execution-scoped view of the archive-reuse metadata for one group. */
  private priorArchivesFor(group: BackgroundExecutionGroup): Map<string, PriorArchiveRecord> {
    // Review pass 4: inspect only the target group's bounded inline tasks via
    // composite-key lookups — routine save work never scales with the archive
    // metadata of unrelated attached executions.
    const priorArchives = new Map<string, PriorArchiveRecord>();
    for (const task of group.tasks) {
      const entry = this.archivedTasks.get(this.archiveHandleKey(group.executionId, task.taskId));
      if (entry?.executionId === group.executionId) {
        priorArchives.set(task.taskId, entry);
      }
    }
    return priorArchives;
  }

  /**
   * Finding 15: fail closed at the unsettled admission cap. Shared by
   * SubtasksAdd, archived-task reactivation, and recovery adoption into an
   * existing execution, so no path can push an execution past the cap.
   * Sequential top-offs after prior tasks settle remain supported without
   * limit.
   */
  private assertUnsettledAdmissionCapacity(group: BackgroundExecutionGroup, requested: number): void {
    const unsettled = group.tasks.filter((task) => !isArchivableTaskState(task.state)).length;
    if (unsettled + requested > MAX_UNSETTLED_TASKS_PER_EXECUTION) {
      throw new Error(
        `Execution ${group.executionId} already holds ${unsettled} unsettled task(s); at most ${MAX_UNSETTLED_TASKS_PER_EXECUTION} unsettled tasks are admitted per execution. `
        + "Wait for tasks to land or report (sequential settled top-offs remain supported), or start a new execution for the additional work.",
      );
    }
  }

  /** Authentication handles for lazily loading one of this group's archives. */
  private archivedTaskAuth(group: BackgroundExecutionGroup, taskId: string): {
    executionId: string;
    archiveIntegritySha256?: string;
    legacyArchiveIntegritySha256?: string;
  } {
    const bound = this.archivedTasks.get(this.archiveHandleKey(group.executionId, taskId));
    const legacy = this.legacyArchiveHandles.get(group.executionId)?.entries.get(taskId);
    // Finding 15 (review pass 2): the two hashes authenticate DIFFERENT
    // archive generations. A bound handle matches the current execution-bound
    // version-2 archive; a legacy handle matches only the superseded
    // version-1 document. Applying a legacy hash to a rewritten archive would
    // break a stable handle after re-admission and re-settlement.
    return {
      executionId: group.executionId,
      archiveIntegritySha256: bound?.integritySha256,
      legacyArchiveIntegritySha256: legacy?.integritySha256,
    };
  }

  /**
   * True when the task handle resolves to a settled record owned by one of
   * this controller's executions: inline settled, execution-bound archive, or
   * authenticated legacy membership. Used to refuse stale-bundle adoption of
   * this controller's own completed work without blocking legitimate
   * legacy-bundle continuation of genuinely lost operations.
   */
  private async settledArchiveOwner(taskId: string): Promise<string | undefined> {
    for (const group of this.groups.values()) {
      const inline = group.tasks.find((candidate) => candidate.taskId === taskId);
      if (inline && isArchivableTaskState(inline.state)) return group.executionId;
      try {
        if (await this.loadArchivedTask(group, taskId)) return group.executionId;
      } catch {
        // Not provably ours (tampered/foreign archive): adoption proceeds and
        // the archive integrity problem surfaces on exact inspection instead.
      }
    }
    return undefined;
  }

  /**
   * Lazily load and integrity-check a settled task archive for an exact
   * handle, authenticated against this execution's membership metadata.
   */
  private loadArchivedTask(group: BackgroundExecutionGroup, taskId: string): Promise<BackgroundTaskRecord | undefined> {
    return readOwnedTaskArchive(group.root, taskId, this.archivedTaskAuth(group, taskId));
  }

  async add(
    executionId: string | undefined,
    tasks: BackgroundTaskDefinition[],
    options?: { launchNoticeGate?: Promise<void> },
  ): Promise<BackgroundInspection> {
    const group = this.resolveGroup(executionId);
    // #25: SubtasksAdd inherits the group's selected target; only the parent
    // session identity is checked here.
    if (resolve(this.sessionCwdOf(group)) !== resolve(this.input.cwd())) throw new Error("Execution group belongs to a different workspace.");
    this.assertUnsettledAdmissionCapacity(group, tasks.length);
    const created = tasks.map((definition) => newTask(definition));
    group.tasks.push(...created);
    group.totalTaskCount = (group.totalTaskCount ?? group.tasks.length - created.length) + created.length;
    group.updatedAt = new Date().toISOString();
    // Issue #222: a non-model-initiated add registers its launch-notice gate
    // before the added tasks can be dispatched, so their result wakes stay
    // causally ordered behind the notice as with any other admission.
    if (options?.launchNoticeGate !== undefined) this.wakes.setLaunchNoticeGate(group.executionId, options.launchNoticeGate);
    await this.save(group);
    void this.pump();
    // The inspection carries the whole execution inventory; the exact newly
    // assigned ids let the original Add card identify its own tasks.
    return { ...this.inspect(group.executionId), addedTaskIds: created.map((task) => task.taskId) };
  }

  inspect(executionId?: string, taskId?: string, offset?: number, lines?: number): BackgroundInspection {
    const group = this.resolveGroup(executionId);
    const selected = taskId ? group.tasks.filter((task) => task.taskId === taskId) : group.tasks;
    if (taskId && selected.length === 0) throw new Error(`Unknown task ${taskId}.`);
    return this.buildInspection(group, selected, offset, lines);
  }

  /**
   * Finding 15: exact task inspection that also recovers settled tasks whose
   * records were evicted from the bounded inline window. The compacted task
   * archive is loaded lazily and integrity-checked; a missing archive keeps
   * the original unknown-task failure while a malformed or tampered archive
   * fails closed with its integrity diagnostic. Bounded list inspections stay
   * synchronous via inspect(); every list discloses archivedCount omissions.
   */
  async inspectTask(
    executionId?: string,
    taskId?: string,
    offset?: number,
    lines?: number,
    evidence?: SubtaskEvidenceSelector,
  ): Promise<BackgroundInspection> {
    const group = this.resolveGroup(executionId);
    // #61: an evidence read is read-only navigation. Resolve the exact task and
    // build its ONE coherent evidence read BEFORE any recovery mutation or save,
    // so a failing selector (mistyped entryId, unknown callId, malformed/expired
    // cursor, out-of-range index) throws without touching durable state. The
    // validated read is retained and returned below instead of being rebuilt:
    // a post-recovery rebuild could observe a different snapshot (source
    // replacement/retention by an external writer, or a backfilled result
    // changing the indexed sources) and raise a selector error only AFTER the
    // recovery writes — and it would double the bounded artifact construction on
    // every evidence read. Genuine (non-evidence) reads keep the recovery
    // behavior below unchanged.
    let evidenceRead: SubtaskEvidenceRead | undefined;
    if (evidence) {
      if (!taskId) throw new Error("Evidence inspection requires a known taskId.");
      const task = group.tasks.find((candidate) => candidate.taskId === taskId)
        ?? await this.loadArchivedTask(group, taskId);
      if (!task) throw new Error(`Unknown task ${taskId}.`);
      // One coherent read: confined artifact scan and selector navigation over
      // the same snapshot. Confinement and cursor checks are unchanged; any
      // scoped selector error is thrown before any mutation.
      evidenceRead = await this.buildEvidenceRead(group, task, evidence);
    }
    for (const task of group.tasks.filter((task) => !taskId || task.taskId === taskId)) {
      if (group.kind !== "execute" || !task.waveRoot || isArchivableTaskState(task.state)
        || isActiveTaskState(task.state) || this.runtimes.has(task.taskId) || this.pendingForceMerges.has(task.taskId)) continue;
      try {
        await this.recoverTaskAssociation(group, task);
      } catch (error) {
        this.addActivity(task, "recovery", `Checkpoint backfill refused: ${messageOf(error)}`);
      }
      await this.save(group);
    }
    let inspection: BackgroundInspection;
    let task: BackgroundTaskRecord | undefined;
    try {
      inspection = this.inspect(executionId, taskId, offset, lines);
      if (taskId) task = group.tasks.find((candidate) => candidate.taskId === taskId);
    } catch (error) {
      if (!taskId) throw error;
      const archived = await this.loadArchivedTask(group, taskId);
      if (!archived) throw error;
      inspection = this.buildInspection(group, [archived], offset, lines);
      task = archived;
    }
    if (evidence) {
      if (!taskId || !task || !evidenceRead) throw new Error("Evidence inspection requires a known taskId.");
      // Return the single pre-recovery read: its snapshot and context are
      // coherent, and no selector validation runs after the recovery writes
      // above. The accompanying inspection still reflects any backfilled state;
      // a follow-up evidence read picks up post-recovery changes.
      return { ...inspection, evidence: evidenceRead };
    }
    return inspection;
  }

  /**
   * Issue #33: bounded read-only evidence navigation for one task. Sources are
   * derived only from the task's durable artifacts (never caller-supplied
   * paths); all content is redacted before retention or display. Cursor and
   * navigation failures propagate as explicit errors.
   */
  private async buildEvidenceRead(
    group: BackgroundExecutionGroup,
    task: BackgroundTaskRecord,
    selector: SubtaskEvidenceSelector,
  ): Promise<SubtaskEvidenceRead> {
    const artifactDir = this.durableArtifactDirOf(group, task);
    let operation: OperationRecord | undefined;
    const contextUnavailable: SubtaskEvidenceUnavailable[] = [];
    if (artifactDir) {
      // Validate the artifact root against the authorized root (wave root for
      // execute/research, the execution root for in-place, #220) BEFORE reading
      // anything through it: a symlinked or moved artifact directory must not
      // become a read path outside the owned tree. Escapes throw (fail closed);
      // missing/non-directory roots are noted and skipped.
      const authorizedRoot = await resolveArtifactRoot(task.waveRoot ?? group.root, artifactDir, contextUnavailable);
      if (authorizedRoot) {
        // The operation record is optional evidence context. It is read through
        // the same bounded, confined regular-file reader as every other
        // evidence artifact and ownership-validated before use; refusals,
        // oversized or wrong-task records are reported explicitly and never used.
        const loaded = await readConfinedOperationRecord(authorizedRoot, task.taskId);
        operation = loaded.record;
        if (loaded.unavailable) contextUnavailable.push(loaded.unavailable);
      }
    }
    const bundle = await buildSubtaskEvidence({
      taskId: task.taskId,
      artifactDir,
      waveRoot: task.waveRoot,
      operation,
      contextUnavailable,
      result: task.result,
      state: task.state,
      commands: task.commands,
      executorSelection: task.executorSelection,
      updatedAt: task.updatedAt,
      worktreeRoot: operation?.worktreeRoot,
    });
    return readSubtaskEvidence(bundle, selector);
  }

  private buildInspection(
    group: BackgroundExecutionGroup,
    selected: BackgroundTaskRecord[],
    offset?: number,
    lines?: number,
  ): BackgroundInspection {
    const from = Math.max(0, offset ?? 0);
    const count = Math.max(1, Math.min(lines ?? MAX_ACTIVITY, 500));
    // #25 multi-target: at most one gate per group (same-root landings
    // serialize behind the coordinator), so a single optional field suffices.
    const conflictGate = this.gateForGroup(group);
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
      // Finding 15: truthful lifetime/aggregate counts instead of the bounded
      // inline window, plus explicit disclosure of archive-only omissions.
      historicalCount: group.totalTaskCount ?? group.tasks.length,
      archivedCount: group.settledArchivedCount ?? 0,
      scheduling: this.schedulingSnapshot(group),
      conflictGate: conflictGate
        ? cloneConflictGate(conflictGate)
        : undefined,
      tasks: selected.map((task) => ({
        ...cloneTask(task),
        timing: taskTiming(task),
        dispatchState: task.state === "queued"
          ? this.runtimes.has(task.taskId) ? "assigned_starting" : "waiting_for_capacity"
          : undefined,
        activity: task.activity.slice(offset === undefined ? Math.max(0, task.activity.length - count) : from, offset === undefined ? undefined : from + count),
        artifactDir: this.durableArtifactDirOf(group, task),
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

  /**
   * Liveness for the exact model-facing SubtasksStart request. A known active
   * group whose recorded start-call fingerprint matches returns active, even
   * when other legacy groups are present; known different active groups remain
   * nonblocking. #195: an older/restored active group without a trustworthy
   * fingerprint is unidentifiable rather than unknown — it cannot match the
   * submitted fingerprint and no longer makes the answer unknown, so it does
   * not by itself block an otherwise admissible start. The accepted duplicate
   * risk is disclosed, not hidden: because that legacy group's original
   * submitted identity is unavailable, an identical new start can duplicate its
   * still-active work; the new start is not proven distinct or safe. `unknown`
   * still fails closed at the preflight boundary when the liveness lookup
   * itself is unavailable or throws. Settled groups do not participate.
   */
  startLiveness(fingerprint: string): StartLiveness {
    for (const group of this.groups.values()) {
      if (!group.tasks.some((task) => isActiveTaskState(task.state))) continue;
      const recorded = group.startCallFingerprint;
      // Unidentifiable legacy groups cannot match; skipping them is the
      // accepted duplicate-risk tradeoff, not a liveness failure.
      if (typeof recorded !== "string" || !/^[0-9a-f]{64}$/.test(recorded)) continue;
      if (recorded === fingerprint) {
        return { state: "active", identity: group.executionId };
      }
    }
    return { state: "inactive" };
  }

  /**
   * #93: in-memory dispatch provenance projection for original SubtasksStart/
   * SubtasksAdd tool cards. Read directly from the authoritative live task
   * records: no inspection call, no filesystem I/O, no expansion fetch, and
   * no duplicated logical state. Unknown execution ids return undefined (the
   * card keeps its truthful static snapshot).
   */
  liveDispatchView(executionId: string): SubtaskCardDispatchView | undefined {
    const group = this.groups.get(executionId);
    if (!group) return undefined;
    return {
      executionId: group.executionId,
      kind: group.kind,
      targetWorkspace: group.cwd,
      tasks: group.tasks.map((task) => ({
        taskId: task.taskId,
        state: task.state,
        dispatchState: task.state === "queued"
          ? this.runtimes.has(task.taskId) ? "assigned_starting" : "waiting_for_capacity"
          : undefined,
        initialDispatch: task.initialDispatch,
        dispatch: task.dispatch,
      })),
    };
  }

  /**
   * #93: record an actual delivery-boundary dispatch capture on the durable
   * task record and fan the event out to rendered original cards. The first
   * capture stays in `initialDispatch`; `dispatch` always holds the latest
   * actual delivery. Records are published only when the adapter's transport
   * accepted the prompt write; failures before delivery publish nothing. Turn
   * ACK/compliance remain separate facts recorded elsewhere.
   */
  private recordDispatch(
    group: BackgroundExecutionGroup,
    task: BackgroundTaskRecord,
    record: SubtaskDispatchRecord,
  ): void {
    // #306: consumption is gated by the first delivery of the SCHEDULED
    // EXECUTION GROUP, not each task. add() retains scheduledTaskId while every
    // added task begins without initialDispatch — an added task's first prompt
    // delivery must not re-consume an entry the user manually re-armed. Archived
    // settled history suppresses consumption too: a group whose start already
    // settled (and was archived) has no live start signal to report.
    const firstDelivery = task.initialDispatch === undefined
      && (group.settledArchivedCount ?? 0) === 0
      && !group.tasks.some((candidate) => candidate !== task && candidate.initialDispatch !== undefined);
    task.initialDispatch ??= { ...record };
    task.dispatch = { ...record };
    task.updatedAt = new Date().toISOString();
    // #306: the transport accepted this prompt's write — but only the FIRST
    // actual delivery of this execution consumes a one-shot entry. Corrections,
    // retries, and continuations (including recovery re-dispatches, whose
    // initialDispatch survives) must not re-consume an entry the user manually
    // re-armed while this execution is still active or recoverable.
    if (
      firstDelivery
      && group.scheduledTaskId !== undefined
      && this.input.onScheduledDispatchRecorded !== undefined
    ) {
      try {
        this.input.onScheduledDispatchRecorded(group.scheduledTaskId);
      } catch {
        // Observer reporting is best-effort; the dispatch record itself is
        // already authoritative and stays recorded.
      }
    }
    // The settling check lets the fan-out sweep retire subscriptions for
    // executions that can no longer dispatch, while any execution with a live
    // (e.g. still-queued or paused-recoverable) card is never evicted.
    notifyDispatchCards(group.executionId, task.taskId, (executionId) => this.allTasksArchivable(executionId));
  }

  /** #93 card-sweep input: `true` only when this controller knows the
   * execution and every one of its tasks is ARCHIVABLE (permanently
   * terminal). Inactive but recoverable states — paused_recoverable, failed,
   * stopped — can be continued and dispatch again, so their original cards
   * keep their subscriptions. Unknown executions report `undefined`
   * (keep watching). */
  private allTasksArchivable(executionId: string): boolean | undefined {
    const group = this.groups.get(executionId);
    if (!group || group.tasks.length === 0) return undefined;
    return group.tasks.every((task) => isArchivableTaskState(task.state));
  }

  watch(executionId: string | undefined, afterMs: number): BackgroundWatchSubscription {
    const group = this.resolveGroup(executionId);
    // #25: session identity only; the selected target may differ from it.
    if (resolve(this.sessionCwdOf(group)) !== resolve(this.input.cwd())) throw new Error("Execution group belongs to a different workspace.");
    if (!group.tasks.some((task) => isActiveTaskState(task.state))) {
      throw new Error(`Execution ${group.executionId} has no active tasks to watch.`);
    }
    // The armed subscription, its timer, and queued checkpoint inspections
    // live in ./wake-delivery (Issue #222 sequencing owned there).
    return this.wakes.armWatch(group.executionId, afterMs);
  }

  reviewReadiness(): BackgroundReviewReadinessTask[] {
    // Review pass 4: readiness checks run repeatedly during orchestration —
    // read the controller-wide active-task index instead of traversing every
    // settled window in every attached group. The active-state filter stays
    // defensive so an unsynchronized transition can never surface.
    const readiness: BackgroundReviewReadinessTask[] = [...this.activeTasks.values()]
      .filter(({ task }) => isActiveTaskState(task.state))
      .map(({ group, task }) => ({
        executionId: group.executionId,
        kind: group.kind,
        taskId: task.taskId,
        title: task.definition.title,
        state: task.state,
      }));
    // #175: with the landed-change review policy on, a same-workspace conflict
    // gate keeps its task a review-readiness blocker until SubtasksMarkClean
    // resolves it: the materialized conflict markers sit in the primary review
    // window, so the model's idle review must not run against unresolved
    // markers. Only the final resolved diff becomes landed evidence, at the
    // ordinary next idle review. The policy off keeps the exact prior
    // behavior (conflicted tasks were not readiness blockers); foreign-target
    // gates never put markers in the parent window, and identity-resolution
    // errors fail closed to blocking.
    if (!this.reviewLandedChangesEnabled()) return readiness;
    for (const { gate } of this.conflictGates.entries()) {
      if (!sameWorkspaceGate(gate.sourceRoot, this.input.cwd())) continue;
      const group = this.groups.get(gate.executionId);
      const task = group?.tasks.find((candidate) => candidate.taskId === gate.taskId);
      if (!group || !task || task.state !== "conflicted") continue;
      readiness.push({
        executionId: group.executionId,
        kind: group.kind,
        taskId: task.taskId,
        title: task.definition.title,
        state: task.state,
      });
    }
    return readiness;
  }

  async continueTask(input: {
    executionId?: string;
    taskId?: string;
    bundle?: ReattachmentBundle;
    instructions: string;
    instructionId: string;
    actor: "model" | "user";
    /**
     * #179: explicit same-worktree continuation of a stopped execute task
     * without a verified checkpoint. Omitted/false keeps the strict
     * checkpoint-verified default unchanged.
     */
    inPlace?: boolean;
  }): Promise<BackgroundInspection> {
    const taskId = input.taskId ?? input.bundle?.taskId ?? this.resolveTask(input.executionId).task.taskId;
    if (this.shuttingDown || this.detaching > 0) throw new Error("Application shutdown or controller detach is in progress.");
    if (this.continuationAdmissions.has(taskId)) throw new Error(`Task ${taskId} has a continuation admission in progress.`);
    if (this.pendingForceMerges.has(taskId)) throw new Error(`Task ${taskId} has a force-merge in progress.`);
    const epoch = this.detachEpoch;
    this.continuationAdmissions.add(taskId);
    // The reservation is a concurrency guard only, never accepted activity: a
    // rejected or duplicate continuation must publish no positive intent. The
    // finally reconciles the exact record this admission observed — including an
    // archive-only task that was never inserted inline — so no token is stranded.
    let observedTarget: BackgroundTaskRecord | undefined;
    try {
      return await this.admitContinuation(input, epoch, (task) => { observedTarget = task; });
    } finally {
      this.continuationAdmissions.delete(taskId);
      const task = observedTarget ?? this.taskById(taskId);
      if (task) this.syncActiveIntent(task);
    }
  }

  private async admitContinuation(
    input: Parameters<BackgroundExecutionController["continueTask"]>[0],
    epoch: number,
    onTarget?: (task: BackgroundTaskRecord) => void,
  ): Promise<BackgroundInspection> {
    if (input.inPlace === true) return this.admitInPlaceContinuation(input, epoch, onTarget);
    const target = await this.resolveOrAdoptTask(input.executionId, input.taskId, input.bundle);
    const { group, task } = target;
    onTarget?.(task);
    const archiveOnly = target.archiveOnly === true;
    this.assertContinuationAdmission(task, epoch);
    // No activity is published here: intent is acquired only when the accepted
    // admission actually queues the task, synchronously inside save() before
    // dispatch can run. Every earlier refusal therefore stays at the prior state.
    // #220: an in-place task continues by resuming its retained session in the
    // same workspace — there is no wave bundle, capture, or checkpoint, so the
    // bundle-required strict path must never claim otherwise. Recovery for a
    // task that never dispatched stays bundle-less by design.
    if (isInPlaceKind(group.kind)) {
      const duplicate = task.commands.find((command) => command.instructionId === input.instructionId);
      if (duplicate) return this.inspect(group.executionId, task.taskId);
      if (isArchivableTaskState(task.state)) {
        throw new Error(`In-place continuation refused: task ${task.taskId} is ${task.state}; settled in-place work stays where the worker made it and cannot be re-run through this handle. Launch a new in-place task instead.`);
      }
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
      this.addActivity(task, "continue", `In-place continuation admitted (${input.instructionId}): the same workspace is reused without a captured base or checkpoint; prior writes remain.`);
      await this.save(group);
      void this.pump();
      return this.inspect(group.executionId, task.taskId);
    }
    if (group.kind === "execute" && (!task.bundle || input.bundle
      || (!isArchivableTaskState(task.state) && task.result?.taskResults[0]?.acceptedCommitSha))) {
      await this.recoverTaskAssociation(group, task, input.bundle);
    }
    // No await between this recheck and command/queue mutation. Recovery may
    // have yielded to shutdown, detach, or another lifecycle state transition.
    this.assertContinuationAdmission(task, epoch);
    const bundle = task.bundle;
    if (!bundle) throw new Error(`Task ${task.taskId} has no durable continuation bundle.`);
    const duplicate = task.commands.find((command) => command.instructionId === input.instructionId);
    if (duplicate) {
      if (duplicate.inPlace === true) {
        throw new Error(`Instruction ${input.instructionId} was already admitted as an explicit in-place continuation; retry with inPlace: true or use a new instructionId.`);
      }
      return archiveOnly
        ? this.buildInspection(group, [task])
        : this.inspect(group.executionId, task.taskId);
    }
    // Finding 15 (review pass 2): settled-task reactivation re-enters the
    // unsettled population — the shared admission cap applies to inline
    // settled and archive-only reactivation alike. Re-admission mutates
    // controller state only after bundle and duplicate validation, so a
    // bundle-less or duplicate continuation leaves counts and state exactly
    // as they were.
    if (isArchivableTaskState(task.state)) this.assertUnsettledAdmissionCapacity(group, 1);
    if (archiveOnly) {
      group.tasks.push(task);
      // The archive-only representation is being retired: re-admitting a
      // settled task moves it back inline, so the aggregate must follow.
      group.settledArchivedCount = Math.max(0, (group.settledArchivedCount ?? 0) - 1);
    }
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

  /**
   * #179: explicit in-place admission. Only an inline, stopped, unlanded
   * execute task owned by this controller qualifies; archived/adopted work
   * never does. Idempotency is decided before any verification so a replayed
   * instruction never re-runs gates against a folder the first run consumed.
   * Verification is read-only: nothing is created, copied, reset, checked
   * out, cleaned, or staged during admission.
   */
  private async admitInPlaceContinuation(
    input: Parameters<BackgroundExecutionController["continueTask"]>[0],
    epoch: number,
    onTarget?: (task: BackgroundTaskRecord) => void,
  ): Promise<BackgroundInspection> {
    const { group, task } = this.resolveTask(input.executionId, input.taskId ?? input.bundle?.taskId);
    onTarget?.(task);
    if (group.kind !== "execute") {
      throw new Error(`In-place continuation applies only to execute tasks; ${task.taskId} is a ${group.kind} task.`);
    }
    this.assertContinuationAdmission(task, epoch);
    const duplicate = task.commands.find((command) => command.instructionId === input.instructionId);
    if (duplicate) {
      if (duplicate.action !== "continue" || duplicate.inPlace !== true) {
        throw new Error(`Instruction ${input.instructionId} was already used for a ${duplicate.action} command without the in-place opt-in; use a new instructionId.`);
      }
      return this.inspect(group.executionId, task.taskId);
    }
    this.assertInPlaceTaskGates(group, task);
    await this.recoverTaskAssociation(group, task, input.bundle, { inPlace: true });
    // No await between this recheck and command/queue mutation.
    this.assertContinuationAdmission(task, epoch);
    this.assertInPlaceTaskGates(group, task);
    const bundle = task.bundle;
    if (!bundle) throw new Error(`Task ${task.taskId} has no durable continuation bundle.`);
    task.bundle = { ...bundle };
    task.pendingContinuation = { instructions: input.instructions, instructionId: input.instructionId };
    task.commands.push({
      instructionId: input.instructionId,
      action: "continue",
      actor: input.actor,
      inPlace: true,
      text: input.instructions,
      status: "queued",
      createdAt: new Date().toISOString(),
    });
    transitionTaskState(task, "queued");
    this.addActivity(task, "continue", `Explicit in-place continuation admitted (${input.instructionId}); the retained worktree is reused without a verified checkpoint.`);
    await this.save(group);
    void this.pump();
    return this.inspect(group.executionId, task.taskId);
  }

  /** #179 controller-side landing/conflict gates for in-place admission. */
  private assertInPlaceTaskGates(group: BackgroundExecutionGroup, task: BackgroundTaskRecord): void {
    if (isArchivableTaskState(task.state)) {
      throw new Error(`In-place continuation refused: task ${task.taskId} is ${task.state}; settled work has no retained worktree to reuse. Use SubtasksContinue without inPlace.`);
    }
    if (task.state === "conflicted" || this.gateForTask(group.executionId, task.taskId)) {
      throw new Error(`In-place continuation refused: task ${task.taskId} has an outstanding landing conflict gate. Resolve the conflict and call SubtasksMarkClean first.`);
    }
    if (!task.waveRoot) {
      throw new Error(`In-place continuation refused: task ${task.taskId} never captured a managed worktree.`);
    }
  }

  /**
   * #179 audit finding: an admitted-but-undispatched explicit in-place
   * continuation must survive an application restart as the authoritative
   * instruction. Restores the original pending instruction and in-place flag
   * by re-verifying the full read-only admission/dispatch guards (worktree
   * identity, detached HEAD, writer quiescence, landing gates, checkpoint
   * posture) and re-queuing on success; on any refusal the task fails closed
   * to paused_recoverable with the original command preserved and the
   * orchestrator notified — never a substituted strict auto-resume.
   *
   * Returns whether an admitted in-place continuation was found and handled.
   * When true, the caller must not run the ordinary auto-resume branch.
   */
  private async restoreAdmittedInPlaceContinuation(
    group: BackgroundExecutionGroup,
    task: BackgroundTaskRecord,
  ): Promise<boolean> {
    const pending = task.pendingContinuation;
    if (!pending) return false;
    const admitted = task.commands.find((command) => command.instructionId === pending.instructionId
      && command.action === "continue" && command.status === "queued");
    if (admitted?.inPlace !== true) return false;
    try {
      this.assertInPlaceTaskGates(group, task);
      // Read-only re-verification of the exact retained worktree, its
      // detached HEAD, writer quiescence, and landing gates — the same
      // admission guards the original explicit admission ran.
      await this.recoverTaskAssociation(group, task, undefined, { inPlace: true });
      this.assertInPlaceTaskGates(group, task);
    } catch (error) {
      transitionTaskState(task, "paused_recoverable");
      task.summary = "Admitted in-place continuation could not be re-verified after restart; the original instruction is preserved. Inspect before any resume.";
      this.addActivity(task, "recovery", `In-place continuation re-verification refused after restart: ${messageOf(error)}`);
      task.updatedAt = new Date().toISOString();
      await this.input.notify?.(
        `review gate: task ${task.taskId}: admitted in-place continuation was not resumed after restart (${messageOf(error)}); its original instruction is preserved for inspection.`,
      );
      return true;
    }
    transitionTaskState(task, "queued");
    task.summary = "Exact parent conversation restored; admitted in-place continuation re-verified and re-queued.";
    task.updatedAt = new Date().toISOString();
    this.addActivity(task, "recovery", `Admitted in-place continuation ${pending.instructionId} re-verified after restart and re-queued unchanged.`);
    return true;
  }

  private assertContinuationAdmission(task: BackgroundTaskRecord, epoch: number): void {
    if (this.shuttingDown || this.detaching > 0 || this.detachEpoch !== epoch) {
      throw new Error("Application shutdown or controller detach began during continuation admission.");
    }
    if (isActiveTaskState(task.state) || this.runtimes.has(task.taskId)) throw new Error(`Task ${task.taskId} is already active.`);
    if (this.pendingForceMerges.has(task.taskId)) throw new Error(`Task ${task.taskId} has a force-merge in progress.`);
  }

  /** Restore metadata from the task's already-owned wave, never from a guessed
   * operation id. Inspection verifies the checkpoint and supplies the current
   * revision; result evidence is separately tied to that exact checkpoint.
   *
   * #126: with `tolerateUnverifiedCheckpoint`, an explicit force-merge may
   * proceed past a missing or unverified checkpoint into salvage capture.
   * Only a *verified* checkpoint is then published as the task's continuation
   * bundle, so salvage never launders into ordinary continuation eligibility.
   */
  private async recoverTaskAssociation(
    group: BackgroundExecutionGroup,
    task: BackgroundTaskRecord,
    explicit?: ReattachmentBundle,
    options?: { tolerateUnverifiedCheckpoint?: boolean; inPlace?: boolean },
  ): Promise<void> {
    if (group.kind === "research") {
      if (options?.inPlace === true) throw new Error("In-place continuation applies only to execute tasks.");
      return this.recoverResearchTaskAssociation(group, task, explicit);
    }
    if (!task.waveRoot) {
      if (explicit) throw new Error("Recovery task has no durable wave ownership anchor.");
      return;
    }
    const epoch = this.detachEpoch;
    const ownedRoot = await realpath(task.waveRoot);
    const bundle = explicit ?? task.bundle ?? createReattachmentBundle(
      await readOperationRecord(join(ownedRoot, "artifacts", task.taskId, "operation.json")), ownedRoot,
    );
    if (bundle.taskId !== task.taskId || await realpath(bundle.waveRoot) !== ownedRoot
      || (task.bundle && (bundle.operationId !== task.bundle.operationId || bundle.waveId !== task.bundle.waveId))) {
      throw new Error("Recovery bundle does not match the task's durable wave/operation ownership.");
    }
    const inspection = await inspectOperation(bundle);
    const capture = await readWaveCaptureRecord(ownedRoot);
    // #25: the first clause is the parent-session identity check (the group's
    // creation-time session directory); the second keeps the target-identity
    // check — this wave must have been captured from the group's selected
    // target, which may be a different repository than the session's.
    if (await realpath(this.sessionCwdOf(group)) !== await realpath(this.input.cwd())
      || await realpath(capture.discovery.requestedCwd) !== await realpath(group.cwd)
      || await realpath(inspection.manifest.sourceRoot) !== await realpath(capture.discovery.captureRoot)
      || inspection.bundle.waveId !== capture.waveId
      || inspection.manifest.baseCommit !== capture.baseCommit
      || await realpath(inspection.manifest.repositoryPath) !== await realpath(capture.repositoryPath)
      || !inspection.manifest.task) {
      throw new Error("Recovery bundle source/task ownership does not match this execution.");
    }
    if (explicit && inspection.staleBundle) {
      throw new Error(`Stale reattachment bundle revision ${explicit.expectedRevision}; current operation revision is ${inspection.bundle.expectedRevision}. Inspect and retry with the returned bundle.`);
    }
    if (inspection.live) throw new Error("Recovery operation still has a live writer.");
    const verifiedCheckpoint = inspection.checkpointVerification.status === "verified";
    if (options?.inPlace === true) {
      // #179: the verified checkpoint is not required, but the retained
      // folder, HEAD, writer, failed_critical cause, and landing gates are
      // (read-only). The dispatch path re-verifies before any executor runs.
      await verifyInPlaceContinuation({ waveRoot: ownedRoot, record: inspection.record, capture, manifest: inspection.manifest });
    } else if ((!task.bundle || explicit) && !verifiedCheckpoint
      && options?.tolerateUnverifiedCheckpoint !== true) {
      throw new Error(`Recovery checkpoint is not verified: ${inspection.checkpointVerification.error ?? inspection.checkpointVerification.status}`);
    }
    const accepted = verifiedCheckpoint
      ? await readVerifiedAcceptedResult(inspection) : undefined;
    if (this.detachEpoch !== epoch || this.detaching > 0) throw new Error("Controller detached during recovery verification.");
    // A tolerated, unverified checkpoint is inspected for salvage but never
    // published as a durable continuation bundle. An in-place admission
    // publishes the identity-verified current bundle; the operation layer
    // still refuses any later default Continue without a verified checkpoint.
    if (verifiedCheckpoint || options?.tolerateUnverifiedCheckpoint !== true) {
      task.bundle = { ...inspection.bundle };
    }
    if (accepted && (!task.result || task.result.taskResults[0]?.acceptedCommitSha !== accepted.acceptedCommitSha)) {
      task.result = {
        waveId: inspection.bundle.waveId, waveRoot: ownedRoot, sourceRoot: inspection.manifest.sourceRoot,
        phase: "working", taskResults: [accepted],
      };
      task.summary ??= accepted.summary;
    }
    task.updatedAt = new Date().toISOString();
  }

  /** Research owns a capture and an operation, but deliberately no execute-wave
   * manifest. Validate that retained operation/session rather than adopting it
   * through inspectOperation's integration/landing protocol.
   */
  private async recoverResearchTaskAssociation(
    group: BackgroundExecutionGroup,
    task: BackgroundTaskRecord,
    explicit?: ReattachmentBundle,
  ): Promise<void> {
    const prior = task.researchResult;
    const owned = task.bundle ?? prior?.bundle;
    const bundle = explicit ?? owned;
    if (!task.waveRoot || !prior || !owned || !bundle) {
      throw new Error("Research continuation requires its owned operation and prior durable result.");
    }
    const epoch = this.detachEpoch;
    if (bundle.version !== 1 || bundle.taskId !== task.taskId || prior.taskId !== task.taskId
      || bundle.operationId !== owned.operationId || bundle.waveId !== owned.waveId
      || !Number.isSafeInteger(bundle.expectedRevision) || bundle.expectedRevision < 0) {
      throw new Error("Research bundle does not match the task's durable operation ownership.");
    }
    const waveRoot = await realpath(task.waveRoot);
    if (await realpath(bundle.waveRoot) !== waveRoot || await realpath(owned.waveRoot) !== waveRoot) {
      throw new Error("Research bundle does not match the task's durable wave ownership.");
    }
    const capture = await readWaveCaptureRecord(waveRoot);
    const artifactDir = await realpath(join(waveRoot, "artifacts", task.taskId));
    const record = await readOperationRecord(join(artifactDir, "operation.json"));
    const worktree = researchWorktree(capture, task.taskId);
    if (record.operationId !== bundle.operationId || record.taskId !== task.taskId
      || record.waveId !== bundle.waveId || capture.waveId !== bundle.waveId
      || await realpath(record.artifactDir) !== artifactDir
      || await realpath(record.worktreeRoot) !== await realpath(worktree.worktreeRoot)
      || await realpath(record.effectiveCwd) !== await realpath(worktree.effectiveCwd)
      // #25: parent-session identity (creation-time session directory), kept
      // independent of the selected target checked in the next clause.
      || await realpath(this.sessionCwdOf(group)) !== await realpath(this.input.cwd())
      || await realpath(capture.discovery.requestedCwd) !== await realpath(group.cwd)) {
      throw new Error("Research bundle source/task ownership does not match this execution.");
    }
    if (bundle.expectedRevision > record.revision) throw new Error("Research bundle revision is newer than its owned operation.");
    if (operationOwnershipStatus(record).processAlive || record.state === "failed_critical") {
      throw new Error("Research operation still has a live writer or requires critical recovery.");
    }
    await verifyRecoveryCheckpoint(waveRoot, record, capture);
    if (this.detachEpoch !== epoch || this.detaching > 0 || this.shuttingDown) {
      throw new Error("Controller detached or shut down during research recovery verification.");
    }
    // Worker owner-release bookkeeping may advance the returned bundle's
    // revision. Refresh only after validating its exact owned identity.
    task.bundle = createReattachmentBundle(record, waveRoot);
    task.updatedAt = new Date().toISOString();
  }

  private async resolveOrAdoptTask(
    executionId?: string,
    taskId?: string,
    bundle?: ReattachmentBundle,
  ): Promise<{ group: BackgroundExecutionGroup; task: BackgroundTaskRecord; archiveOnly?: boolean }> {
    if (bundle) {
      // Stable task handles select the existing record, not missing bundle metadata.
      // Verification happens before association; a failed check must never fall
      // through to legacy adoption and create a replacement task.
      const known = [...this.groups.values()].flatMap((group) => group.tasks
        .filter((task) => task.taskId === (taskId ?? bundle.taskId))
        .map((task) => ({ group, task })));
      if (known.length) {
        const matches = known.filter(({ group }) => !executionId || executionId === group.executionId);
        if (matches.length !== 1) throw new Error("Recovery bundle task/execution ownership mismatch or ambiguous target.");
        const target = matches[0]!;
        if (this.runtimes.has(target.task.taskId) || isActiveTaskState(target.task.state)
          || this.pendingForceMerges.has(target.task.taskId)) throw new Error("Recovery task still has a live or queued writer.");
        await this.recoverTaskAssociation(target.group, target.task, bundle);
        await this.save(target.group);
        return target;
      }
    }
    try {
      return this.resolveTask(executionId, taskId, bundle);
    } catch (error) {
      if (taskId) {
        // Finding 15: exact historical recovery for a stable task handle whose
        // settled record was evicted from the inline window. The compacted
        // archive is loaded lazily, integrity-checked and execution-bound.
        // The record is NOT re-admitted here: continueTask owns re-admission
        // after bundle and duplicate validation, so a bundle-less, failing, or
        // duplicate continuation never mutates bounded inline state or
        // aggregates.
        const group = this.resolveGroup(executionId);
        const archived = await this.loadArchivedTask(group, taskId);
        if (!archived) throw error;
        const existing = group.tasks.find((candidate) => candidate.taskId === taskId);
        if (bundle) await this.recoverTaskAssociation(group, existing ?? archived, bundle);
        if (existing) return { group, task: existing };
        return { group, task: archived, archiveOnly: true };
      }
      if (!bundle) throw error;
      const adoptionEpoch = this.detachEpoch;
      if (this.shuttingDown || this.detaching > 0) {
        throw new Error("Application shutdown or controller detach is in progress.");
      }
      const inspection = await inspectOperation(bundle);
      if (this.shuttingDown || this.detaching > 0 || this.detachEpoch !== adoptionEpoch) {
        throw new Error("Application shutdown or controller detach began while the execution bundle was being adopted.");
      }
      if (inspection.record.state === "landed" && await this.settledArchiveOwner(inspection.bundle.taskId)) {
        // Finding 15 (narrowed in review pass 2): settled work owned by one of
        // this controller's executions must never resurrect as recoverable
        // work when stale association bundles outlive a compaction. Deliberate
        // legacy-bundle continuation of a landed operation whose owning
        // execution is genuinely gone remains supported by the operation layer.
        throw new Error(`Recovery bundle ${bundle.operationId} already landed; re-adoption would duplicate completed work.`);
      }
      const definition = inspection.manifest.task?.task;
      if (!definition) throw new Error("Recovery bundle has no durable task definition and cannot be adopted automatically.");
      let group: BackgroundExecutionGroup;
      if (executionId) {
        group = this.resolveGroup(executionId);
        // #25: parent-session identity is checked against the group's creation-
        // time session directory, independently of its selected target.
        if (resolve(this.sessionCwdOf(group)) !== resolve(this.input.cwd())) {
          throw new Error("Execution group belongs to a different workspace.");
        }
        // #25: the bundle must have been captured from this group's persisted
        // target — the same target-identity clause recoverTaskAssociation
        // enforces — so a foreign-target group never adopts a parent-source
        // bundle (or vice versa) before its task is admitted.
        const capture = await readWaveCaptureRecord(inspection.bundle.waveRoot);
        if (await realpath(capture.discovery.requestedCwd) !== await realpath(group.cwd)) {
          throw new Error(
            `Recovery bundle was captured from ${capture.discovery.requestedCwd}, not execution ${group.executionId}'s workspace ${group.cwd}.`,
          );
        }
        // Adoption into an existing execution adds to its unsettled
        // population: the shared admission cap applies here too.
        this.assertUnsettledAdmissionCapacity(group, 1);
      } else {
        // #25: fresh adoption (no surviving group) keeps the fail-closed legacy
        // gate — the bundle's source must be the current session's workspace.
        if (resolve(inspection.manifest.sourceRoot) !== resolve(this.input.cwd())) {
          throw new Error(`Recovery bundle belongs to ${inspection.manifest.sourceRoot}, not ${resolve(this.input.cwd())}.`);
        }
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
          sessionCwd: resolve(this.input.cwd()),
          createdAt: now,
          updatedAt: now,
          peakConcurrency: 0,
          tasks: [],
          totalTaskCount: 0,
          settledArchivedCount: 0,
        };
        this.groups.set(group.executionId, group);
      }
      const task = newTask(definition);
      task.taskId = inspection.bundle.taskId;
      task.bundle = { ...inspection.bundle };
      task.waveRoot = inspection.bundle.waveRoot;
      transitionTaskState(task, "paused_recoverable");
      task.summary = `Adopted durable operation ${inspection.bundle.operationId} for triage-style continuation.`;
      this.addActivity(task, "recovery", task.summary);
      group.tasks.push(task);
      // Adoption into an existing execution adds to its unsettled population,
      // so the shared admission cap applies here; only adoption into a fresh
      // execution bypasses the check (it starts from an empty population).
      group.totalTaskCount = (group.totalTaskCount ?? group.tasks.length - 1) + 1;
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
    /** Turn-interrupt steering (issue #63): interrupt the active turn before delivery. */
    interrupt?: boolean;
  }): Promise<BackgroundInspection> {
    const { group, task } = this.resolveTask(input.executionId, input.taskId);
    const duplicate = task.commands.find((command) => command.instructionId === input.instructionId);
    if (duplicate) return this.inspect(group.executionId, task.taskId);
    const command: BackgroundCommandRecord = {
      instructionId: input.instructionId,
      action: "steer",
      actor: input.actor,
      ...(input.interrupt === true ? { interrupt: true } : {}),
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
    if (isInPlaceKind(group.kind) && input.mode === "interrupt_with_merge") {
      throw new Error("In-place tasks cannot use interrupt_with_merge: writes were performed directly in the workspace, so there is no captured checkpoint to merge and no rollback of what already ran. Use interrupt_as_failure.");
    }
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
    // #310: runtime settlement is not proof of quiescence. When the executor
    // could not verify its owned process shutdown, the operation keeps its
    // owner lease; never acknowledge quiescence or merge over a possibly
    // live writer.
    const unverifiedWriter = await this.unverifiedWriterAfterInterrupt(group, task);
    if (unverifiedWriter) {
      command.status = "failed";
      command.acknowledgedAt = undefined;
      command.error = `Writer quiescence was not verified: ${unverifiedWriter}`;
      task.error = command.error;
      task.summary = command.error;
      this.addActivity(task, "interrupt", `${command.error} ${transportMessage}`);
      task.interruptionMode = undefined;
      await this.save(group);
      return this.inspect(group.executionId, task.taskId);
    }
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

  /**
   * #310: after an interrupted runtime settles, report a writer whose owned
   * shutdown is unverified. The durable operation owner lease is the
   * authority: executor loops retain it when a started child never reported
   * a verified exit. A missing record means no executor operation started.
   */
  private async unverifiedWriterAfterInterrupt(group: BackgroundExecutionGroup, task: BackgroundTaskRecord): Promise<string | undefined> {
    const artifactDir = this.durableArtifactDirOf(group, task);
    if (!artifactDir) return undefined;
    let record: OperationRecord;
    try {
      record = await readOperationRecord(operationRecordPath(artifactDir));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      return `the operation record could not be read: ${messageOf(error)}`;
    }
    const ownership = operationOwnershipStatus(record);
    if (!ownership.processAlive) return undefined;
    const shutdown = [...record.incidents].reverse().find((incident) => incident.stage === "executor_shutdown" && !incident.resolvedAt);
    return shutdown?.message ?? ownership.message;
  }

  async forceMerge(input: BackgroundForceMergeInput): Promise<BackgroundInspection> {
    if (this.shuttingDown) throw new Error("Application shutdown is in progress.");
    const { group, task } = this.resolveTask(input.executionId, input.taskId);
    if (isInPlaceKind(group.kind)) {
      throw new Error("In-place tasks have no mergeable checkpoint: the worker wrote directly in its selected workspace, so there is nothing to land and no rollback of anything already written. Inspect that workspace directly.");
    }
    if (group.kind === "research") throw new Error("Research tasks have reports, not mergeable checkpoints; force-merge is unavailable.");
    if (this.continuationAdmissions.has(task.taskId)) throw new Error(`Task ${task.taskId} has a continuation admission in progress.`);
    if (this.runtimes.has(task.taskId) || isActiveTaskState(task.state)) {
      throw new Error(`Task ${task.taskId} still has a live or queued writer; interrupt and await acknowledgement before force-merge.`);
    }
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
    // An actual force-merge operation is activity the moment it is registered,
    // even if the task's durable state is already terminal and has not changed.
    this.syncActiveIntent(task);
    try {
      return await this.runForceMerge(input, group, task, pending);
    } finally {
      this.pendingForceMerges.delete(task.taskId);
      // The owned force-merge operation settled: reconcile this task's token.
      this.syncOwnedTask(task);
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
    // #126: an explicit force-merge is salvage-capable. Association recovery
    // tolerates a missing or unverified checkpoint; only a verified checkpoint
    // is published as the task's continuation bundle, so salvage never launders
    // into ordinary continuation eligibility.
    if (!task.waveRoot) {
      throw new Error(`Task ${task.taskId} has no durable wave ownership anchor; there is no recoverable work to force-merge.`);
    }
    await this.recoverTaskAssociation(group, task, undefined, { tolerateUnverifiedCheckpoint: true });
    const bundle = task.bundle ?? (await resolveUnverifiedForceMergeBundle(task));
    if (!bundle) throw new Error(`Task ${task.taskId} has no durable wave/operation anchor; there is no recoverable work to force-merge.`);
    // #126 correction: an explicit force-merge always merges all identified
    // work in one call, so the request carries no mode; `input.mergeAnyhow`
    // is accepted for caller compatibility but recorded nowhere and controls
    // nothing.
    const command: BackgroundCommandRecord = {
      instructionId: input.instructionId,
      action: "force_merge",
      actor: input.actor,
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
    // Real source authority is preserved regardless of salvage: a live or
    // uncertain writer must be interrupted and acknowledged first, and an
    // incomplete landing rollback blocks further mutation.
    if (inspection.live) {
      command.status = "failed";
      command.error = `Force-merge requires no live or uncertain writer on task ${task.taskId}; interrupt it and await acknowledgement before force-merging.`;
      await this.save(group);
      throw new Error(command.error);
    }
    if (inspection.manifest.sourceWorkspace.disposition === "recovery_required") {
      command.status = "failed";
      command.error = `Force-merge requires an unresolved landing recovery to be resolved first: inspect and complete the landing recovery for task ${task.taskId}.`;
      await this.save(group);
      throw new Error(command.error);
    }
    // #126: ordinary lifecycle gates no longer wall off explicit salvage. A
    // verified checkpoint still lands through the unchanged ordinary path; a
    // verified checkpoint under failed_critical is an explicit override of the
    // lifecycle refusal; anything else salvages an identified snapshot of the
    // worker's actual work (retained worktree first, surviving refs otherwise).
    const checkpoint = inspection.record.checkpoint;
    const verifiedCheckpoint = inspection.checkpointVerification.status === "verified" && Boolean(checkpoint?.commitSha);
    let source: ForceMergeLandingSource;
    if (verifiedCheckpoint) {
      // #126 correction: a verified checkpoint must not silently hide newer
      // retained work. The retained worktree is inspected for identified
      // content the checkpoint's tree does not carry; when it provably
      // subsumes the checkpoint it supersedes it, and anything that cannot be
      // ordered is surfaced rather than guessed. Surviving refs are excluded
      // as superseded review history (see identifyWorkBeyondCheckpoint). This
      // inspection is read-only (private repository + retained worktree) and
      // runs before the source-mutation lease.
      let supersession;
      try {
        supersession = await identifyWorkBeyondCheckpoint(task, inspection.record, checkpoint!);
      } catch (error) {
        command.status = "failed";
        command.error = messageOf(error);
        await this.save(group);
        throw error;
      }
      if (supersession.kind === "ambiguous") {
        command.status = "failed";
        command.error = supersession.message;
        task.summary = supersession.message;
        await this.save(group);
        throw new Error(supersession.message);
      }
      if (supersession.kind === "salvage") {
        source = {
          kind: "salvage",
          candidate: supersession.candidate,
          supersededCheckpoint: { commitSha: checkpoint!.commitSha, ref: checkpoint!.ref },
        };
      } else {
        source = inspection.record.state === "failed_critical"
          ? { kind: "forced_checkpoint", commitSha: checkpoint!.commitSha, ref: checkpoint!.ref, reason: "verified checkpoint despite failed_critical operation state" }
          : { kind: "checkpoint", commitSha: checkpoint!.commitSha, ref: checkpoint!.ref };
      }
    } else {
      // Salvage capture is read-only (private repository + retained worktree)
      // and runs before the source-mutation lease; a refusal marks the command
      // failed durably, matching the other pre-acquisition refusals.
      try {
        source = await captureSalvageSource(task, inspection.record, group.tasks.filter((candidate) => candidate.taskId !== task.taskId && candidate.waveRoot === task.waveRoot));
      } catch (error) {
        command.status = "failed";
        command.error = messageOf(error);
        await this.save(group);
        throw error;
      }
    }
    const commitSha = source.kind === "salvage" ? source.candidate.commitSha : source.commitSha;
    const originalCapture = await readWaveCaptureRecord(bundle.waveRoot);
    const lineage = waveLineageOf(originalCapture);
    const generation = inspection.record.generation;
    const capture = generation > 0 ? {
      ...originalCapture, waveId: `${lineage.rootWaveId}-g${generation}`,
      rootWaveId: lineage.rootWaveId, continuationGeneration: generation,
    } : originalCapture;
    const reviewWindowId = this.input.state.reviewWindow?.id;
    const parentBaseline = activeExchangeBaseline(this.input.state);
    const snapshotBaseline = parentBaseline?.kind === "snapshot" ? parentBaseline.snapshot : undefined;
    const preTaskSnapshot = parentBaseline?.kind === "checkpoint" ? await this.preTaskParentChanges(group.cwd)
      : snapshotBaseline ? await createWorkspaceSnapshot(group.cwd, {
      maxFileBytes: this.input.config.maxFileBytes,
      maxSnapshotBytes: this.input.config.maxSnapshotBytes,
      reuseUnchangedFrom: snapshotBaseline,
    }) : undefined;
    let landingGuard = preTaskSnapshot;
    let release: (() => void) | undefined;
    try {
      release = await sourceMutationCoordinator.acquire(group.cwd, pending.abort.signal);
      pending.acquired = true;
      command.status = "delivered";
      command.deliveredAt = new Date().toISOString();
      transitionTaskState(task, "waiting_to_land");
      this.addActivity(task, "force_merge", source.kind === "checkpoint"
        ? `Force-merge requested from ${commitSha}. This is a mechanical landing attempt; manual inspection of the main workspace is required afterward in every outcome.`
        : source.kind === "forced_checkpoint"
          ? `Forced force-merge requested from its verified checkpoint (candidate ${commitSha}) despite the operation lifecycle state (${source.reason}); no review success is asserted. Manual inspection of the main workspace is required in every outcome.`
          : source.supersededCheckpoint
            ? `Salvage force-merge requested from ${describeSalvageSource(source)} (candidate ${commitSha}); it supersedes the verified checkpoint ${source.supersededCheckpoint.ref} (${source.supersededCheckpoint.commitSha.slice(0, 12)}), which does not carry all identified retained work. No review success is asserted; manual inspection of the main workspace is required in every outcome.`
            : `Salvage force-merge requested from ${describeSalvageSource(source)} (candidate ${commitSha}); no ordinary verified checkpoint is being landed. Manual inspection of the main workspace is required in every outcome.`);
      await this.save(group);

      await pinCommit(capture, commitSha, { type: "integration" });
      const plan = await planWaveLanding(capture, commitSha, group.cwd);
      if (plan.conflicts.length > 0) {
        // #126 correction: an explicit force-merge merges ALL identified work
        // in one call for every source kind — clean paths apply and ordinary
        // text conflicts materialize standard diff3 markers here. There is no
        // clean-only refusal to retry; `input.mergeAnyhow` is accepted for
        // caller compatibility but controls nothing.
        await this.input.faults?.materializeLandingConflicts?.({ executionId: group.executionId, taskId: task.taskId, taskState: task.state });
        // #126 approved representation modes (explicit force-merge only):
        // binary conflicts keep their target in place with the worker version
        // saved alongside, and other unrepresentable conflicts are preserved —
        // available worker bytes alongside, deletions recorded — while the
        // remaining identified work still merges in this same call.
        landingGuard = await this.landingParentGuard(group.cwd, preTaskSnapshot) ?? (preTaskSnapshot instanceof Map ? undefined : preTaskSnapshot);
        const materialized = await materializeLandingConflicts(capture, plan, `forced subtask ${task.taskId}`, {
          binarySidecars: true,
          preserveUnrepresentable: true,
        });
        await this.checkpointParent(reviewWindowId, parentBaseline, landingGuard, group.cwd, materialized.appliedPaths, { executionId: group.executionId, taskId: task.taskId }, this.landedReviewStatus(task, source));
        // #126 approved: conflicts that cannot carry markers are preserved
        // instead of represented, so the preserved target and any worker
        // version saved alongside (or a recorded deletion) must both be named.
        // The gate reason is rendered by SubtasksInspect and the failure wake,
        // so it is the visible durable place for the pairing.
        const sidecarNote = materialized.sidecars.length > 0
          ? ` Unrepresentable conflict(s) preserved without markers: ${materialized.sidecars.map((sidecar) => sidecar.sidecarPath
              ? `${sidecar.path} -> worker version saved alongside at ${sidecar.sidecarPath}`
              : `${sidecar.path}: worker-side deletion recorded; the target is preserved and no worker version exists`).join("; ")} Resolve each path in the main workspace, remove any saved worker version you do not keep, then call SubtasksMarkClean; preservation is not resolution.`
          : "";
        const gateSidecars = materialized.sidecars.map((sidecar) => sidecar.sidecarPath
          ? { path: sidecar.path, sidecarPath: sidecar.sidecarPath }
          : { path: sidecar.path });
        const conflictGate: BackgroundConflictGate = {
          executionId: group.executionId,
          taskId: task.taskId,
          sourceRoot: group.cwd,
          paths: materialized.paths,
          activatedAt: new Date().toISOString(),
          manifestPath: materialized.manifestPath,
          reason: `Forced task ${task.taskId} materialized conflicts that require immediate resolution.${sidecarNote}`,
          ...(gateSidecars.length > 0 ? { sidecars: gateSidecars } : {}),
        };
        this.setConflictGate(conflictGate);
        transitionTaskState(task, "conflicted");
        const salvageConflictNote = source.kind === "salvage" && source.supersededCheckpoint
          ? `this snapshot supersedes the verified checkpoint ${source.supersededCheckpoint.ref} but carries no review behind it`
          : source.kind === "salvage"
            ? "salvaged content has no ordinary checkpoint or review behind it"
            : "force-merge does not verify the requested result";
        task.summary = (source.kind === "salvage"
          ? `Salvage force-merge from ${describeSalvageSource(source)} materialized conflicts in ${materialized.paths.join(", ")}. Resolve them and manually inspect the complete workspace; ${salvageConflictNote}.`
          : `Force-merge materialized conflicts in ${materialized.paths.join(", ")}. Resolve them and manually inspect the complete workspace; force-merge does not verify the requested result.`) + sidecarNote;
        command.status = "acknowledged";
        command.acknowledgedAt = new Date().toISOString();
        // #126: a conflicted salvage still transferred its non-conflicting
        // paths, so the forced-salvage provenance is recorded durably here as
        // well; it must survive the later markClean landing and never read
        // like an ordinary verified-checkpoint merge.
        command.salvage = salvageProvenanceFor(source, commitSha, checkpoint);
        await this.save(group);
        if (command.salvage) {
          const salvageProvenance = command.salvage;
          await this.completeLandedBookkeeping(task, "salvage provenance", () =>
            recordSalvageProvenanceIncident(task, salvageProvenance, {
              appliedPaths: materialized.appliedPaths,
              conflictPaths: materialized.paths,
            }), "conflicted");
        }
        await this.publishAssociations();
        await this.wake(task, "failure", this.criticalPrompt(conflictGate)!);
        return this.inspect(group.executionId, task.taskId);
      }
      transitionTaskState(task, "landing");
      landingGuard = await this.landingParentGuard(group.cwd, preTaskSnapshot) ?? (preTaskSnapshot instanceof Map ? undefined : preTaskSnapshot);
      const landing = await executeWaveLanding(plan, capture);
      if (landing.status !== "landed") throw new Error(`Force-merge landing ended in ${landing.status}.`);
      const paths = [...landing.appliedPaths, ...landing.alreadyAppliedPaths];
      // #126: durable forced-salvage provenance is recorded with the landed
      // state; it never implies review success or a normal checkpoint.
      command.salvage = salvageProvenanceFor(source, commitSha, checkpoint);
      task.summary = source.kind === "checkpoint"
        ? (paths.length > 0
            ? "Stopped task force-merged mechanically into the main workspace; manual workspace inspection is still required to confirm the requested changes are present and correct."
            : "Force-merge checkpoint contains no changes that remain to be landed; manual workspace inspection is still required to determine whether the requested changes are present.")
        : source.kind === "forced_checkpoint"
          ? (paths.length > 0
              ? `Verified checkpoint force-merged into the main workspace from ${describeSalvageSource(source)} despite the operation lifecycle state (${source.reason}); no review success was asserted, so manual inspection is still required to confirm what actually arrived.`
              : "Force-merge checkpoint contains no changes that remain to be landed; manual workspace inspection is still required to determine whether the requested changes are present.")
          : (paths.length > 0
              ? source.supersededCheckpoint
                ? `Salvage force-merge landed ${describeSalvageSource(source)} into the main workspace, superseding verified checkpoint ${source.supersededCheckpoint.ref}; no review success was asserted, so manual inspection is required to confirm what actually arrived.`
                : `Salvage force-merge landed ${describeSalvageSource(source)} into the main workspace without an ordinary checkpoint or review; manual inspection is required to confirm what actually arrived.`
              : "Salvage force-merge identified no remaining changes to land; manual inspection is still required to determine whether the requested changes are present.");
      command.status = "acknowledged";
      command.acknowledgedAt = new Date().toISOString();
      // The landing mutated main (finding 2): run the parent checkpoint as
      // tolerated bookkeeping (preserving the success-path ordering where the
      // checkpoint completes before the landed state becomes visible), then
      // transition to landed unconditionally; save/publish/wake stay tolerated
      // so the landed outcome survives any of them failing.
      await this.completeLandedBookkeeping(task, "parent checkpoint", async () => {
        await this.checkpointParent(reviewWindowId, parentBaseline, landingGuard, group.cwd, paths, { executionId: group.executionId, taskId: task.taskId }, this.landedReviewStatus(task, source));
      });
      if (command.salvage) {
        const salvageProvenance = command.salvage;
        await this.completeLandedBookkeeping(task, "salvage provenance", () =>
          recordSalvageProvenanceIncident(task, salvageProvenance));
      }
      transitionTaskState(task, "landed");
      await this.completeLandedBookkeeping(task, "durable save", async () => {
        await this.save(group);
      });
      await this.completeLandedBookkeeping(task, "association publish", () => this.publishAssociations());
      // #117: a model tool call's direct result already confirms this
      // synchronous landing, so the follow-up completion wake is suppressed
      // and its group aggregate is folded into the returned inspection instead.
      let completionAggregate: string | undefined;
      if (isToolResultConfirmedCompletionWake("completion", input.actor)) {
        // #117 review fix: suppression removes only the notification. The
        // actionable-completion watch housekeeping still runs so a stale
        // checkpoint can never fire after this direct-result-confirmed landing.
        this.wakes.retireWakeWatch(task, "completion", { group, task });
        completionAggregate = this.completionAggregateFor(group, task);
      } else {
        await this.completeLandedBookkeeping(task, "completion wake", () =>
          this.wake(task, "completion", source.kind === "checkpoint"
            ? `Task ${task.taskId} force-merged and landed mechanically. This does not verify that the requested changes are present or correct; inspect the main workspace manually before claiming success.`
            : source.kind === "forced_checkpoint"
              ? `Task ${task.taskId} landed its verified checkpoint despite the operation lifecycle state (${source.reason}); no review success was asserted. Inspect the main workspace manually before claiming success.`
              : source.supersededCheckpoint
                ? `Task ${task.taskId} was salvaged and landed from ${describeSalvageSource(source)}, superseding its verified checkpoint ${source.supersededCheckpoint.ref}; no review success was asserted. Inspect the main workspace manually before claiming success.`
                : `Task ${task.taskId} was salvaged and landed from ${describeSalvageSource(source)} without an ordinary checkpoint or review. Inspect the main workspace manually before claiming success.`));
      }
      // Always persist the landed state and any bookkeeping diagnostics recorded
      // after the initial save (e.g., when the first save failed).
      await this.completeLandedBookkeeping(task, "durable save", async () => {
        await this.save(group);
      });
      const inspection = this.inspect(group.executionId, task.taskId);
      return completionAggregate ? { ...inspection, completionAggregate } : inspection;
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

  /**
   * #117: `actor` decides whether the per-task completion wakes for landed
   * tasks are delivered (user commands) or folded into this result (model tool
   * calls). Omitted callers predate the model/user split and keep the
   * notifying default.
   */
  async markClean(input?: { actor?: SubtaskWakeActor }): Promise<BackgroundMarkCleanResult> {
    const actor: SubtaskWakeActor = input?.actor ?? "user";
    const entries = this.conflictGates.entries();
    if (entries.length === 0) return { cleared: false, paths: [] };
    // #25 multi-target: validate every outstanding gate before releasing any —
    // one unresolved target must never clear another target's block. The
    // single-gate message and behavior are unchanged; with several gates each
    // dirty root is named so the remaining work stays actionable. #154: the
    // unresolved-marker/sidecar scan itself lives in ./conflict-gate-store.
    const dirty = await this.conflictGates.unresolvedReasons();
    if (dirty.length > 0) {
      throw new Error(`Conflict markers remain in: ${dirty.join("; ")}`);
    }
    const clearedPaths: string[] = [];
    for (const { key, gate, release } of entries) {
      const group = this.groups.get(gate.executionId);
      const task = group?.tasks.find((candidate) => candidate.taskId === gate.taskId);
      if (task) {
        transitionTaskState(task, "landed");
        task.summary = "Conflict resolution was validated and marked landed.";
        task.updatedAt = new Date().toISOString();
        await this.save(group!);
      }
      // #25: same-directory identity guard as checkpointParent — a conflict
      // gate on a foreign target must not merge that repository's files into
      // the parent review baseline.
      // #175: with the landed-change review policy on (and automatic primary
      // review on), the resolved landed diff also remains in the primary
      // review window here (no selective checkpoint after clearance): the
      // resolution is unreviewed evidence, while the gate plus the #175
      // review-readiness blocker kept the unresolved markers out of review
      // until clearance. Only the post-resolution landed state is exposed.
      if (!this.reviewLandedChangesEnabled()) {
        const baseline = activeExchangeBaseline(this.input.state);
        await this.checkpointParent(this.input.state.reviewWindow?.id, baseline,
          baseline?.kind === "snapshot" ? baseline.snapshot : undefined,
          gate.sourceRoot, gate.paths, { executionId: gate.executionId, taskId: gate.taskId }, { reviewed: true }, true);
      }
      this.conflictGates.delete(key);
      release();
      clearedPaths.push(...gate.paths);
    }
    await this.publishAssociations();
    const completionAggregates: BackgroundMarkCleanAggregate[] = [];
    for (const { gate } of entries) {
      const group = this.groups.get(gate.executionId);
      const task = group?.tasks.find((candidate) => candidate.taskId === gate.taskId);
      if (task) {
        this.addActivity(task, "landed", "Conflict resolution validated; queued landing attempts released.");
        await this.save(group!);
        // #117: a model tool call's direct result already confirms each
        // validated landing, so its completion wake is suppressed and the group
        // aggregate is folded into this result instead.
        if (isToolResultConfirmedCompletionWake("completion", actor)) {
          // #117 review fix: same watch housekeeping as the delivered wake
          // path — folding the aggregate into this result never leaves a stale
          // checkpoint armed or queued for this group.
          this.wakes.retireWakeWatch(task, "completion", { group: group!, task });
          completionAggregates.push({
            executionId: group!.executionId,
            taskId: task.taskId,
            aggregate: this.completionAggregateFor(group!, task),
          });
        } else {
          await this.wake(task, "completion", `Task ${task.taskId} conflict resolution was validated and landed.`);
        }
      }
    }
    this.updateIndicator();
    return completionAggregates.length > 0
      ? { cleared: true, paths: clearedPaths, completionAggregates }
      : { cleared: true, paths: clearedPaths };
  }

  /**
   * #117: the group aggregate a suppressed completion wake would have
   * conveyed, built by the same shared formatter (subtask-notifications) the
   * wake path uses, so folded-in tool-result text and delivered wakes cannot
   * drift.
   */
  private completionAggregateFor(group: BackgroundExecutionGroup, task: BackgroundTaskRecord): string {
    return completionGroupAggregateLines(group, this.schedulingSnapshot(group, task)).join("\n");
  }

  /**
   * Builds the mandatory priority instruction for outstanding conflict gates.
   * Without an explicit gate it aggregates every active gate — one block per
   * source root naming its execution/task identity and conflicted paths — so
   * simultaneous conflicts on separate targets keep the recurring warning on
   * every turn and after restore; only a gate-free controller returns
   * undefined. Callers that just activated one gate pass it to wake exactly
   * that task's target, which names its own source root.
   */
  criticalPrompt(gate?: BackgroundConflictGate): string | undefined {
    const gates = gate ? [gate] : this.conflictGates.list();
    if (gates.length === 0) return undefined;
    return [
      "CRITICAL REVIEW-GATE WORKSPACE CONFLICT:",
      ...gates.flatMap((target) => [
        `Execution ${target.executionId}, task ${target.taskId} materialized merge conflicts in the source workspace ${target.sourceRoot}.`,
        `Conflicted paths: ${target.paths.join(", ")}.`,
        `Gate detail: ${target.reason}`,
      ]),
      "Automatic task landings into these targets are blocked. Resolve these files now, verify each workspace, then call SubtasksMarkClean.",
      "Do not claim any of these workspaces is clean or continue unrelated source mutations while a gate remains active.",
    ].join("\n");
  }

  async shutdown(): Promise<void> {
    this.shuttingDown = true;
    this.wakes.clearWatches();
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
    // Shutdown deliberately does NOT clear source uncertainty: settled runtime
    // promises are not proof that a recoverable operation's owned writer is
    // gone. Outstanding tokens stay owned and any uncertainty remains until an
    // authoritative re-establishment, so this cannot publish a false zero.
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
        // #126 correction: a landed salvage whose provenance names untransferred
        // ambiguous paths keeps its wave root so the source bytes — not merely
        // path names — survive cleanup and restart. Truly resolved work is
        // cleaned exactly as before.
        const retain = salvageEvidenceRequiresRetention(task);
        if (task.waveRoot && !retain) await removeOwnedWaveRoot(task.waveRoot);
        if (!retain) task.waveRoot = undefined;
        task.bundle = undefined;
        task.updatedAt = new Date().toISOString();
      }
      // Whole-group retirement is deferred while any settled task (inline or
      // archived) still anchors retained source evidence: removing the
      // execution root would destroy the durable reference to it.
      let archivedRetention = false;
      if (settled.length === group.tasks.length) {
        // Recover the wave roots recorded in the (evicted) task archives once,
        // shutdown-only, before the root is removed so sequential top-offs do
        // not leave their workspace artifacts behind. Every archive is loaded
        // through the integrity and execution-ownership checks before its
        // waveRoot is trusted — a malformed or tampered archive is skipped,
        // never acted on destructively. Recovery archives themselves are
        // deleted with the group exactly as before; this scan never deletes
        // them early.
        const archiveDir = join(group.root, "tasks");
        for (const entry of await readdir(archiveDir).catch(() => [] as string[])) {
          if (!entry.endsWith(".json") || entry === "index.json") continue;
          try {
            const archived = await this.loadArchivedTask(group, entry.slice(0, -".json".length));
            if (!archived) continue;
            if (salvageEvidenceRequiresRetention(archived)) {
              archivedRetention = true;
              continue;
            }
            if (archived.waveRoot) await removeOwnedWaveRoot(archived.waveRoot).catch(() => undefined);
          } catch {
            // Never act destructively on malformed, tampered, or foreign
            // archive contents. The execution root cleanup below remains
            // independently owned.
          }
        }
      }
      if (settled.length === group.tasks.length && !archivedRetention) {
        await removeOwnedExecutionRoot(group.root, group.tempBase);
        // Every task is terminal: release its owned-activity token before the
        // group bookkeeping is dropped so retirement cannot leave a stale
        // positive outstanding.
        this.reconcileOwnedActivity(group);
        this.groups.delete(executionId);
        this.dropActiveTasks(executionId);
        // Issue #222: the launch-notice gate retires with the group; every
        // notification that could be held behind it has already delivered.
        this.wakes.clearLaunchNoticeGate(executionId);
        // Finding 15: retire every archive handle owned by the removed group,
        // including handles for tasks whose records were already evicted to
        // their compacted archives, and its membership-index bookkeeping.
        this.legacyArchiveHandles.delete(executionId);
        for (const [taskId, entry] of this.archivedTasks) {
          if (entry.executionId === executionId || settled.some((task) => task.taskId === taskId)) {
            this.archivedTasks.delete(taskId);
          }
        }
      } else if (settled.length > 0) {
        await this.save(group);
      }
    }
    await this.publishAssociations();
  }

  async detach(): Promise<void> {
    this.detaching += 1;
    this.detachEpoch += 1;
    this.wakes.clearWatches();
    // L9: let in-flight save tails finish their durable writes (preserving
    // write ordering) before dropping the group state and tail bookkeeping, so
    // no stale save-tail entry survives detach and no later write can overtake
    // an earlier one. The clearing runs as the helper's synchronous finalizer,
    // in the same turn as its final empty-tail check; saves attempted through
    // detached groups are rejected by save()'s attachment guard.
    try {
      await this.quiesceSaveTails(() => {
        const outstandingOwnedWork = [...this.groups.values()]
          .some((group) => group.tasks.some((task) => this.taskOwnsUnsettledWork(task)))
          || [...this.activeTasks.values()].some(({ task }) => this.taskOwnsUnsettledWork(task));
        this.groups.clear();
        this.activeTasks.clear();
        this.runtimes.clear();
        this.pendingForceMerges.clear();
        this.archivedTasks.clear();
        this.legacyArchiveHandles.clear();
        // Issue #222: no pending launch-notice gate survives detach; a later
        // session's notifications are never held behind this session's notice.
        this.wakes.clearLaunchNoticeGates();
        this.recentActivity = [];
        this.active = 0;
        this.shuttingDown = false;
        this.pumpRequested = false;
        // #25 multi-target: release every outstanding root's block; the
        // persisted snapshot re-blocks each gate on restore.
        this.conflictGates.clear();
        this.updateIndicator();
        if (outstandingOwnedWork) {
          // The in-memory index is gone but its owned work is not proven
          // settled: the category stays UNKNOWN (never zero) until an
          // authoritative re-establishment, while the outstanding tokens stay
          // owned by this incarnation.
          this.ownedActivity.markUncertain();
        }
      });
    } finally {
      this.detaching -= 1;
    }
  }

  /**
   * Issue #26: the dispatch route for one group. A scheduled group with a
   * pinned worker resource resolves that single resource against the
   * CURRENT catalog (research capability enforced for research groups);
   * every other group keeps the existing global-role route, so ordinary
   * subtask behavior is byte-for-byte unchanged.
   */
  private routeForGroup(group: BackgroundExecutionGroup): ExecutorPoolEntry[] {
    return resolveGroupRoute(group, this.input.config);
  }

  /**
   * Issue #26: fail closed when a scheduled group's pinned worker resource
   * no longer resolves (removed or research-ineligible after dispatch).
   * Each queued task is terminalized exactly once with an actionable
   * failure wake; the skip never implies completion of skipped work.
   */
  private async failScheduledRoute(queued: { group: BackgroundExecutionGroup; task: BackgroundTaskRecord }): Promise<void> {
    const resource = queued.group.scheduledWorkerResourceId!;
    const message = `Scheduled task ${queued.group.scheduledTaskId ?? queued.group.executionId} cannot run: pinned worker resource ${resource} no longer resolves in /review-settings. The due occurrence was skipped; fix the entry or its worker choice, and inspect the active tasks before re-dispatching.`;
    for (const task of queued.group.tasks) {
      if (task.state !== "queued") continue;
      transitionTaskState(task, "failed");
      task.error = message;
      task.summary = message;
      this.addActivity(task, "scheduled_route_failure", message);
      await this.save(queued.group);
      await this.wake(task, "failure", message);
    }
  }

  /**
   * Issue #26: the effective configuration for one group's worker launch.
   * A scheduled write-capable group (execute or in-place, #220) with a
   * review override derives a
   * task-local config: `off` disables automatic subtask review (no PASS is
   * ever fabricated), `selected` replaces exactly the subtask reviewer set
   * while preserving the primary layer. The derivation is pure — the
   * controller's shared global config is never mutated, so concurrent
   * ordinary subtasks keep their own settings.
   */
  private groupConfig(group: BackgroundExecutionGroup): ReviewGateConfig {
    return deriveGroupConfig(group, this.input.config);
  }

  /**
   * Issue #26: scheduled runs of one entry that still have unsettled
   * tasks (queued through landing, conflicted, paused, or exit-stopped —
   * everything except the terminal landed/reported/failed/interrupted).
   * The scheduler uses this for overlap detection: while any of these
   * exist, every due occurrence of the entry is skipped and reported.
   */
  scheduledRuns(scheduledTaskId: string): Array<{
    executionId: string;
    kind: BackgroundTaskKind;
    tasks: Array<{ taskId: string; title: string; state: BackgroundTaskState }>;
  }> {
    return [...this.groups.values()]
      .filter((group) => group.scheduledTaskId === scheduledTaskId)
      .map((group) => ({
        executionId: group.executionId,
        kind: group.kind,
        tasks: group.tasks
          .filter((task) => !isSettledScheduledState(task.state))
          .map((task) => ({ taskId: task.taskId, title: task.definition.title, state: task.state })),
      }))
      .filter((run) => run.tasks.length > 0);
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
          const route = this.routeForGroup(queued.group);
          if (route.length === 0) {
            // Issue #26: an ordinary group with no global route keeps the
            // existing silent-skip behavior; a scheduled group with a PINNED
            // resource that no longer resolves fails closed instead of
            // queueing forever — each queued task gets one actionable failure.
            if (queued.group.scheduledWorkerResourceId !== undefined) {
              await this.failScheduledRoute(queued);
            }
            continue;
          }
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
    // #237: per-kind lifecycle runners (research/in-place/wave) receive only
    // their narrow capability slices; the controller keeps admission, runtime
    // registration, lease lifecycle, and handleLaunchRejection terminalization.
    // The optional lifecycleRunner seam substitutes only the runner itself.
    const lifecycle = this.input.lifecycleRunner
      ? this.input.lifecycleRunner(group, task, abort, lease)
      : group.kind === "research"
        ? task.pendingContinuation
          ? runResearchContinuation(group, task, abort, lease, this.researchDeps)
          : runResearchFresh(group, task, abort, lease, this.researchDeps)
        : isInPlaceKind(group.kind)
          ? task.pendingContinuation
            ? runInPlaceTaskContinuation(group, task, abort, lease, this.inplaceDeps)
            : runInPlaceTaskFresh(group, task, abort, lease, this.inplaceDeps)
          : task.pendingContinuation
            ? runWaveTaskContinuation(group, task, abort, lease, this.waveDeps)
            : runWaveTaskFresh(group, task, abort, lease, this.waveDeps);
    const promise = lifecycle
      .catch((error) => this.handleLaunchRejection(group, task, error))
      .finally(() => {
        // executeWave/continuation owns normal lease release. This is idempotent
        // and covers failures before ownership was handed down.
        lease.release();
        this.runtimes.delete(task.taskId);
        // The owned executor runtime actually settled: reconcile its token
        // against the remaining ownership (state, force-merge, operation).
        this.syncOwnedTask(task);
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

  // ── #220 in-place worker kind ──

  /** Durable artifact directory for an in-place task: the execution root's artifacts tree, kept OUTSIDE the workspace. */
  private inplaceArtifactDir(group: BackgroundExecutionGroup, task: BackgroundTaskRecord): string {
    return join(group.root, "artifacts", task.taskId);
  }

  /** Durable artifact directory of any task kind (wave root or execution root). */
  private durableArtifactDirOf(group: BackgroundExecutionGroup, task: BackgroundTaskRecord): string | undefined {
    return task.waveRoot ? join(task.waveRoot, "artifacts", task.taskId) : isInPlaceKind(group.kind) ? this.inplaceArtifactDir(group, task) : undefined;
  }

  /**
   * #25 multi-target: install one target's conflict gate and its lease block.
   * #154: the storage mechanics live in ./conflict-gate-store; this delegate
   * stays so every in-controller activation path (and the existing fixture
   * entry point) keeps a single install boundary.
   */
  private setConflictGate(gate: BackgroundConflictGate): void {
    this.conflictGates.install(gate);
  }

  /** The outstanding gate for one execution group, if any (at most one per group). */
  private gateForGroup(group: BackgroundExecutionGroup): BackgroundConflictGate | undefined {
    return this.conflictGates.forExecution(group.executionId);
  }

  /** The outstanding gate for one exact task, if any. */
  private gateForTask(executionId: string, taskId: string): BackgroundConflictGate | undefined {
    return this.conflictGates.forTask(executionId, taskId);
  }

  /** #175: the landed-change review policy ledger (./parent-checkpoint-ledger)
   *  owns the parent-checkpoint invariants; these remain the single delegate
   *  seam for the staying force-merge/mark-clean transactions and tests. */
  private reviewLandedChangesEnabled(): boolean {
    return this.ledger.reviewLandedChangesEnabled();
  }

  /** #175: establish the subtask-review status of this task's landing
   *  outcome from its settled result, optionally qualified by an explicit
   *  force-merge landing source. */
  private landedReviewStatus(
    task: BackgroundTaskRecord,
    forceMergeSource?: ForceMergeLandingSource,
  ): LandedReviewStatus {
    return landedReviewStatusOf(task.result?.taskResults[0], forceMergeSource);
  }

  private async preTaskParentChanges(sourceRoot: string): Promise<Map<ReviewCheckpointDescriptor, Set<string>>> {
    return this.ledger.preTaskParentChanges(sourceRoot);
  }

  private async landingParentGuard(
    sourceRoot: string,
    admission: WorkspaceSnapshot | Map<ReviewCheckpointDescriptor, Set<string>> | undefined,
  ): Promise<Map<ReviewCheckpointDescriptor, Set<string>> | undefined> {
    return this.ledger.landingParentGuard(sourceRoot, admission);
  }

  private async checkpointParent(
    reviewWindowId: number | undefined,
    taskBaseline: ReviewBaseline | undefined,
    before: WorkspaceSnapshot | Map<ReviewCheckpointDescriptor, Set<string>> | undefined,
    sourceRoot: string,
    landedPaths: string[],
    faultContext: BackgroundFaultContext = {},
    landedReview?: LandedReviewStatus,
    conflictResolution = false,
  ): Promise<void> {
    return this.ledger.checkpointParent(reviewWindowId, taskBaseline, before, sourceRoot, landedPaths, faultContext, landedReview, conflictResolution);
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
    /** What actually happened to the workspace when the tolerated step ran:
     * "landed" (default; every ordinary call site) or "conflicted" for the
     * mergeAnyhow salvage branch that materialized markers without landing. */
    outcome: "landed" | "conflicted" = "landed",
  ): Promise<void> {
    try {
      await run();
    } catch (error) {
      const message = messageOf(error);
      task.updatedAt = new Date().toISOString();
      this.addActivity(
        task,
        "bookkeeping",
        outcome === "landed"
          ? `Task ${task.taskId} landed in the main workspace, but post-landing ${step} failed; the landed outcome is preserved. ${message}`
          : `Task ${task.taskId} materialized conflicts in the main workspace, but post-conflict ${step} failed; the conflicted outcome is preserved. ${message}`,
      );
      try {
        await this.input.notify?.(outcome === "landed"
          ? `review gate: task ${task.taskId} landed, but ${step} failed afterward (landing preserved): ${message}`
          : `review gate: task ${task.taskId} materialized conflicts, but ${step} failed afterward (conflicts preserved): ${message}`);
      } catch {
        // Notification is best-effort; the outcome is already recorded.
      }
    }
  }

  private async acknowledgeInterrupt(task: BackgroundTaskRecord): Promise<void> {
    const command = [...task.commands].reverse().find((candidate) => candidate.action === "interrupt" && candidate.status === "delivered");
    if (!command) return;
    // #310: lifecycle settlement persists right after this; never record an
    // acknowledgement while the owned writer's shutdown is unverified.
    const group = [...this.groups.values()].find((candidate) => candidate.tasks.includes(task));
    const unverifiedWriter = group ? await this.unverifiedWriterAfterInterrupt(group, task) : undefined;
    if (unverifiedWriter) {
      command.status = "failed";
      command.acknowledgedAt = undefined;
      command.error = `Writer quiescence was not verified: ${unverifiedWriter}`;
      task.error = command.error;
      task.summary = command.error;
      return;
    }
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
    runtime: RuntimeTaskHandle,
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
        // Turn-interrupt steering (issue #63): the adapter's acknowledgement
        // is the truthful capability signal. A transport that cannot interrupt
        // an in-flight turn reports a concrete failed status here instead of a
        // pre-checked capability flag, and queued delivery is never relabelled
        // as an interruption.
        command.status = "delivered";
        command.deliveredAt = new Date().toISOString();
        await this.save(group);
        const generation = task.generation;
        try {
          const acknowledgement = await control.steer(command.text, command.instructionId, command.interrupt === true ? { interrupt: true } : undefined);
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

  /**
   * Finding 14: wake eligibility, lanes, and delivery shapes are policy owned
   * by ./subtask-notifications; ./wake-delivery sequences the fault seam,
   * watch housekeeping (retireWakeWatch), persistence-aware snapshots, and
   * delivery. This delegate keeps the single controller-side wake identity
   * used by every lifecycle and command path.
   */
  private async wake(
    task: BackgroundTaskRecord,
    kind: "completion" | "failure" | "state",
    content: string,
    eventSnapshot?: { group: BackgroundExecutionGroup; task: BackgroundTaskRecord },
  ): Promise<void> {
    return this.wakes.wake(task, kind, content, eventSnapshot);
  }

  /**
   * Finding 15 (review pass 3): controller-wide active-task index. Widget
   * updates and queued dispatch read this index instead of traversing every
   * inline task of every attached group, so neither scales with the number of
   * attached executions or their settled history. Synchronized in the
   * synchronous prefix of save() (every state mutation is followed by a
   * save), plus explicit clears on detach and group retirement; consumers
   * still filter by state, so a not-yet-synchronized transition can never
   * surface incorrectly.
   */
  private readonly activeTasks = new Map<string, {
    group: BackgroundExecutionGroup;
    task: BackgroundTaskRecord;
  }>();

  private activeTaskKey(group: BackgroundExecutionGroup, task: BackgroundTaskRecord): string {
    return `${group.executionId}:${task.taskId}`;
  }

  private syncActiveTasks(group: BackgroundExecutionGroup): void {
    for (const [key, entry] of this.activeTasks) {
      if (entry.group === group) this.activeTasks.delete(key);
    }
    for (const task of group.tasks) {
      if (isActiveTaskState(task.state)) {
        this.activeTasks.set(this.activeTaskKey(group, task), { group, task });
      }
    }
  }

  /**
   * Observation only (native session cards): publish each task's stable id as
   * a positive owned-work token while the task still owns unsettled work, and
   * release it only when no owned runtime, force-merge, or unverified operation
   * association remains. A cleared active-task index therefore never reads as
   * zero: only actual settlement (or a verified/archivable outcome) releases.
   * The registry is inert unless the authenticated session-host reporter opted
   * in.
   */
  private reconcileOwnedActivity(group: BackgroundExecutionGroup): void {
    for (const task of group.tasks) this.syncOwnedTask(task);
  }

  /**
   * True while this task still owns unsettled background work: queued/active
   * logical work, a live executor runtime, a live force-merge, or a terminal
   * but non-archivable task whose durable operation association could still
   * name a live or unverified writer. This is a count of owned work, not of
   * PIDs or processes.
   */
  private taskOwnsUnsettledWork(task: BackgroundTaskRecord): boolean {
    return taskOwnsUnsettledWork(task, this.runtimes.has(task.taskId), this.pendingForceMerges.has(task.taskId));
  }

  /** Acquire/release one task's owned-work token to match its unsettled ownership. */
  private syncOwnedTask(task: BackgroundTaskRecord): void {
    if (this.taskOwnsUnsettledWork(task)) this.ownedActivity.acquire(task.taskId);
    else this.ownedActivity.release(task.taskId);
    // The independent activity-intent channel is reconciled at exactly the same
    // lifecycle seams; a retained ownership anchor never forces it positive.
    this.syncActiveIntent(task);
  }

  /** True while this task is admitted/running activity (not merely unsettled cleanup). */
  private taskHasActiveIntent(task: BackgroundTaskRecord): boolean {
    return taskHasActiveIntent(task, this.pendingForceMerges.has(task.taskId));
  }

  /** Acquire/release one task's activity-intent token to match its admitted/running state. */
  private syncActiveIntent(task: BackgroundTaskRecord): void {
    if (this.taskHasActiveIntent(task)) this.ownedActivity.acquireIntent(task.taskId);
    else this.ownedActivity.releaseIntent(task.taskId);
  }

  /** Bounded lookup of one live task record by its stable id (observation only). */
  private taskById(taskId: string): BackgroundTaskRecord | undefined {
    for (const group of this.groups.values()) {
      const task = group.tasks.find((candidate) => candidate.taskId === taskId);
      if (task) return task;
    }
    return undefined;
  }

  private dropActiveTasks(executionId: string): void {
    for (const [key, entry] of this.activeTasks) {
      if (entry.group.executionId === executionId) this.activeTasks.delete(key);
    }
  }

  private queuedTasks(): Array<{ group: BackgroundExecutionGroup; task: BackgroundTaskRecord }> {
    return [...this.activeTasks.values()].filter(({ task }) =>
      task.state === "queued" && !this.runtimes.has(task.taskId));
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
    // save-tail ordering. Archive-reuse metadata is scoped per execution and
    // pending legacy membership handles are persisted via the authenticated
    // archive index before the manifest drops their references. State
    // mutations always precede save(), so the active-task index is
    // synchronized in this synchronous section: widget and scheduler reads
    // never traverse settled history.
    this.syncActiveTasks(group);
    // Owned-work observation: reflect this group's authoritative active set in
    // the process-local registry (inert unless the reporter opted in).
    this.reconcileOwnedActivity(group);
    const priorArchives = this.priorArchivesFor(group);
    const legacyHandles = this.legacyArchiveHandles.get(group.executionId);
    const pendingLegacyHandles = legacyHandles && !legacyHandles.persisted ? legacyHandles.entries : undefined;
    const serialized = serializeGroupSnapshot(group, priorArchives, pendingLegacyHandles);
    // Size of the pending legacy set serialized into this save's index body
    // (the map is live and may be retired further by earlier chained tails).
    const legacySizeAtSerialize = pendingLegacyHandles ? pendingLegacyHandles.size : -1;
    let returnedSnapshot = serialized.snapshot;
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
      // Review pass 2: a continuation may reactivate an evicted candidate
      // after this save was serialized but before its durable tail ran. Never
      // persist a manifest that evicts a task that is no longer settled: the
      // recomputation is bounded (inline state) and keeps the persisted
      // aggregates truthful.
      let effective = serialized;
      if (serialized.evictedTaskIds.some((taskId) => {
        const candidate = group.tasks.find((item) => item.taskId === taskId);
        return candidate !== undefined && !isArchivableTaskState(candidate.state);
      })) {
        effective = serializeGroupSnapshot(group, priorArchives, pendingLegacyHandles);
      }
      await writeGroupSnapshot(group.root, effective);
      for (const archive of effective.archiveWrites) {
        this.archivedTasks.set(this.archiveHandleKey(group.executionId, archive.taskId), {
          updatedAt: archive.updatedAt,
          integritySha256: archive.integritySha256,
          executionId: group.executionId,
        });
      }
      if (effective.archiveIndexWrite) {
        // The membership index now durably covers these legacy handles — as
        // long as the durable set still matches what this save serialized.
        // Review pass 4: a concurrent chained tail may retire entries this
        // tail's pre-captured index body still lists; a size drift (entries
        // only ever shrink) marks the index stale so the next save rewrites
        // it instead of leaving persisted=true over an inexact index.
        if (legacyHandles) {
          legacyHandles.persisted = legacyHandles.entries.size === legacySizeAtSerialize;
        }
      }
      // Review pass 3: retire the legacy handle of every task the manifest now
      // durably holds inline — AFTER the durable write, so a crash between the
      // index and manifest renames leaves the old index still vouching for the
      // (still archive-only) task. The retirement only marks the index stale;
      // the next save rewrites it without the retired entries, and stale
      // entries are harmless in the meantime because legacy hashes never
      // authenticate version-2 archives.
      if (legacyHandles) {
        for (const task of group.tasks) {
          if (legacyHandles.entries.delete(task.taskId)) legacyHandles.persisted = false;
        }
      }
      // Finding 15 compaction runs only after the durable write succeeded:
      // settled tasks evicted from the bounded inline window keep their
      // independently addressed, execution-bound archive files, their
      // archive-reuse handles are retired, and the live settledArchivedCount
      // advances by the number of records actually spliced out (a delta, so a
      // concurrent re-admission decrement between serialization and this tail
      // can never be clobbered). Recovery wave roots are deliberately kept:
      // the archived record retains its continuation bundle pointing into that
      // root, so exact-handle continuation must be able to rehydrate its
      // checkpoint; wave-root retirement stays with the explicit
      // cleanupSettledArtifacts lifecycle. A failed write leaves the inline
      // record untouched, so the next save recomputes the same eviction.
      if (effective.evictedTaskIds.length > 0) {
        let evictedNow = 0;
        for (const taskId of effective.evictedTaskIds) {
          const index = group.tasks.findIndex((candidate) => candidate.taskId === taskId);
          if (index < 0) continue;
          // A continuation may have reactivated this task after serialization:
          // never splice a task that is no longer settled.
          if (!isArchivableTaskState(group.tasks[index]!.state)) continue;
          evictedNow += 1;
          group.tasks.splice(index, 1);
          this.archivedTasks.delete(this.archiveHandleKey(group.executionId, taskId));
          // Retention note: the evicted record's wave root (and any research
          // report under it) intentionally outlives compaction so the archived
          // continuation bundle stays rehydratable; wave-root retirement stays
          // with the explicit cleanup lifecycle, never with compaction.
        }
        group.settledArchivedCount = (group.settledArchivedCount ?? 0) + evictedNow;
      }
      returnedSnapshot = effective.snapshot;
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
      // Review pass 3: reflects the snapshot actually durably written when the
      // tail had to re-serialize (a serialized eviction target was reactivated).
      revision: returnedSnapshot.revision,
      updatedAt: returnedSnapshot.updatedAt,
      peakConcurrency: returnedSnapshot.peakConcurrency ?? 0,
      integritySha256: returnedSnapshot.integritySha256,
    };
  }

  private async publishAssociations(): Promise<void> {
    await this.input.faults?.publishAssociations?.({
      taskStates: [...this.groups.values()].flatMap((group) => group.tasks.map((task) => task.state)),
    });
    await this.input.onAssociationsChanged?.(this.associations());
  }

  private updateIndicator(): void {
    this.indicator.render();
  }
}

/**
 * Create the durable execution group's root directory. Default storage stays
 * under the system temp directory. For the #220 in-place kind the selected
 * workspace may BE that temp tree (or contain it), so this resolves the
 * nearest writable directory OUTSIDE the workspace and creates the root
 * there, recording the non-default storage base on the group for guarded
 * cleanup. A workspace that contains every candidate location fails closed
 * before any group state exists.
 */
async function createExecutionRoot(workspace: string, kind: BackgroundTaskKind): Promise<{ root: string; tempBase?: string }> {
  const namePrefix = "pi-review-execution-";
  const tempRoot = await realpath(tmpdir());
  if (!isInPlaceKind(kind) || !isInsideDirectory(workspace, tempRoot)) {
    return { root: await realpath(await mkdtemp(join(tempRoot, namePrefix))), tempBase: undefined };
  }
  // Walk upward from the temp root: the nearest ancestor outside the selected
  // workspace that this process can create and write. Every owned path keeps
  // the pi-review-execution- name and is removed only through the guarded
  // execution-root cleanup.
  let candidate = tempRoot;
  for (;;) {
    const parent = dirname(candidate);
    if (parent === candidate) break;
    let parentReal: string | undefined;
    try {
      parentReal = await realpath(parent);
    } catch {
      parentReal = undefined;
    }
    if (parentReal === undefined) {
      candidate = dirname(candidate);
      continue;
    }
    if (isInsideDirectory(workspace, parentReal)) {
      candidate = parentReal;
      continue;
    }
    try {
      const root = await realpath(await mkdtemp(join(parentReal, namePrefix)));
      return { root, tempBase: parentReal };
    } catch {
      // Not a writable base: continue upward.
      candidate = parentReal;
      continue;
    }
  }
  throw new Error(
    `The in-place workspace ${workspace} contains every system temp location this extension can use for task artifacts; refusing to launch. Select a workspace that does not contain the system temp directory (in-place task artifacts must live outside the selected workspace).`,
  );
}

/** Relative containment: true when `candidate` is inside or equal to `directory`. */
function isInsideDirectory(directory: string, candidate: string): boolean {
  const rel = relative(resolve(directory), resolve(candidate));
  return !isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`);
}

async function continuationEntryId(task: BackgroundTaskRecord): Promise<string | undefined> {
  if (task.executorEntryId) return task.executorEntryId;
  if (!task.bundle) return undefined;
  const inspection = await inspectOperation(task.bundle);
  const operation = await readOperationRecord(inspection.record.artifactDir + "/operation.json");
  return operation.assignments.at(-1)?.entryId;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
