/**
 * Narrow per-kind lifecycle capability types for the extracted task runners
 * (research / in-place / wave), #237. Types only — every capability is
 * implemented live by the background controller, whose durable state
 * (groups/task records, runtimes and leases, save/steering tails, command
 * transitions, gate installation) never leaves it. Capability objects hold no
 * state and are never cached by the runners: the narrow interfaces exist so
 * each runner receives exactly the authority it uses (no universal host bag),
 * while all mutable truth stays in the controller and is passed by reference.
 */
import type { ExecutorPoolEntry, ReviewGateConfig } from "../config";
import type { ExecutorPoolAssignment, ExecutorPoolLease, ExecutorPoolScheduler } from "./executor-pool";
import type { BackgroundExecutionGroup } from "./background-group-store";
import type { BackgroundCommandRecord, BackgroundTaskRecord } from "./task-state";
import type { ConflictGate } from "./conflict-gate-store";
import type { ExecutorLiveControl, SubtaskDispatchRecord } from "./types";

/** The save() result shape the runners observe for persisted-snapshot sync. */
export interface PersistedGroupRevision {
  revision: number;
  updatedAt: string;
  peakConcurrency: number;
  integritySha256: string;
}

/** Result-notification kinds (completion states, failures, transitions). */
export type WakeKind = "completion" | "failure" | "state";

/** Persistence-aware event snapshot handed to state wakes. */
export interface EventSnapshot {
  group: BackgroundExecutionGroup;
  task: BackgroundTaskRecord;
}

/**
 * The controller's registered runtime handle for one dispatched task, passed
 * and mutated by reference (live-control bookkeeping happens on this object).
 */
export interface RuntimeTaskHandle {
  abort: AbortController;
  promise: Promise<void>;
  control?: ExecutorLiveControl;
  controlStatus: "pending" | "registered" | "closed";
}

/** Durable save and association publication (the controller's tail orderings). */
export interface LifecyclePersistence {
  save(group: BackgroundExecutionGroup): Promise<PersistedGroupRevision>;
  publishAssociations(): Promise<void>;
}

/** Best-effort parent notification (input.notify — optional behavior kept). */
export type LifecycleNotify = (message: string) => void | Promise<void>;

/** Task-activity recording (the controller's recent-task activity feed). */
export interface LifecycleActivity {
  add(task: BackgroundTaskRecord, phase: string, message: string): void;
}

/** Indicator/widget update. */
export interface LifecycleIndicator {
  update(): void;
}

/** #93 actual dispatch capture recording (controller-owned provenance). */
export interface LifecycleDispatch {
  record(group: BackgroundExecutionGroup, task: BackgroundTaskRecord, record: SubtaskDispatchRecord): void;
}

/** Result/state wake delivery (wake-delivery module sequencing). */
export interface LifecycleWake {
  wake(task: BackgroundTaskRecord, kind: WakeKind, content: string, eventSnapshot?: EventSnapshot): Promise<void>;
}

/** Live worker-launch configuration, read at each use (never captured). */
export interface LifecycleConfig {
  /** The controller's live base configuration. */
  base(): ReviewGateConfig;
  /** Live per-group derivation (scheduled review overrides / pins). */
  forGroup(group: BackgroundExecutionGroup): ReviewGateConfig;
  /** Live scoped-model projection for this controller. */
  scopedModels(): string[];
}

/** Live executor scheduling: the pool object and live route derivation. */
export interface LifecycleExecutor {
  /** Live dispatch route for one group (scheduled pin resolution). */
  routeOf(group: BackgroundExecutionGroup): ExecutorPoolEntry[];
  /** The controller's pool scheduling object (replaced on restore). */
  pool(): ExecutorPoolScheduler;
  /** Pool failover acquisition for worker-lifecycle runners. */
  acquireAfterRoute(current: ExecutorPoolAssignment, routeOf: () => ExecutorPoolEntry[], signal: AbortSignal): Promise<ExecutorPoolLease | undefined>;
}

/**
 * Steering/command-transition operations. The controller stays the one home
 * of the steering tails and command-record transitions (queued → delivered →
 * acknowledged/failed); runners only invoke these at their existing steps.
 */
export interface LifecycleSteering {
  prestart(group: BackgroundExecutionGroup, task: BackgroundTaskRecord): Promise<void>;
  continuation(group: BackgroundExecutionGroup, task: BackgroundTaskRecord, instructions: string): Promise<string>;
  claimDeferred(group: BackgroundExecutionGroup, task: BackgroundTaskRecord): Promise<Array<{ instruction: string; instructionId: string }>>;
  failUndelivered(task: BackgroundTaskRecord, reason: string): BackgroundCommandRecord[];
  failUndeliveredContinuation(task: BackgroundTaskRecord, reason: string): BackgroundCommandRecord[];
  acknowledgeInterrupt(task: BackgroundTaskRecord): Promise<void>;
  flushQueued(group: BackgroundExecutionGroup, task: BackgroundTaskRecord, runtime: RuntimeTaskHandle, control: ExecutorLiveControl): Promise<void>;
}

/** Live-control registry (the controller's runtime map, projected narrowly). */
export interface LifecycleLiveControl {
  runtime(taskId: string): RuntimeTaskHandle | undefined;
}

/**
 * Post-landing tolerated bookkeeping (finding 2): a failed step after a
 * successful landing can never regress the landed outcome; the failure is
 * recorded as activity/diagnostic instead.
 */
export interface LifecycleBookkeeping {
  tolerate(task: BackgroundTaskRecord, step: string, run: () => Promise<unknown>, outcome?: "landed" | "conflicted"): Promise<void>;
}

/** #25/#154 conflict-gate orchestration for wave landings (install stays the
 * single controller fence; gate reads project live store contents). */
export interface LifecycleGates {
  install(gate: ConflictGate): void;
  gateForTask(executionId: string, taskId: string): ConflictGate | undefined;
  criticalPrompt(gate?: ConflictGate): string | undefined;
}