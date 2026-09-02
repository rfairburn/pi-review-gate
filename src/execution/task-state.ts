/**
 * Pure background-task state: types, lifecycle transitions, timing
 * accumulation, activity history, history normalization, and progress-phase
 * mapping (finding 13). Everything here is deterministic bookkeeping over a
 * single task record — no I/O, no persistence, no widget or notification
 * formatting. The controller owns scheduling, transactions, and delivery; the
 * group store owns durable format mechanics.
 */
import { randomUUID } from "node:crypto";
import type { ReattachmentBundle } from "./operation-record";
import type { ContinuationProgressUpdate, SubtaskProgressPhase } from "./types";
import type { WaveProgressUpdate, WaveResult } from "./wave-controller";
import type { WaveWorkerResult, WaveWorkerTask } from "./wave-worker";

/** Bounded per-task activity history retained durably and in memory. */
export const MAX_ACTIVITY = 200;
/** Bounded per-task state-transition history retained durably and in memory. */
export const MAX_STATE_HISTORY = 64;

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

export interface BackgroundTaskTimingAccumulator {
  queueMs: number;
  captureMs: number;
  executionMs: number;
  reviewMs: number;
  landingMs: number;
  stateEnteredAt: string;
  terminalAt?: string;
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
  timingAccumulator?: BackgroundTaskTimingAccumulator;
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

export function newTask(definition: BackgroundTaskDefinition): BackgroundTaskRecord {
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
    timingAccumulator: emptyTimingAccumulator(now),
    commands: [],
  };
}

export function transitionTaskState(task: BackgroundTaskRecord, next: BackgroundTaskState, at = new Date().toISOString()): BackgroundTaskState {
  const previous = task.state;
  task.updatedAt = at;
  if (previous === next) return previous;
  const timing = ensureTimingAccumulator(task);
  accumulateStateDuration(timing, previous, timing.stateEnteredAt, at);
  timing.stateEnteredAt = at;
  timing.terminalAt = isActiveTaskState(next) ? undefined : at;
  task.stateHistory ??= [{ sequence: 1, state: previous, at: task.createdAt, generation: task.generation }];
  task.nextStateSequence ??= (task.stateHistory.at(-1)?.sequence ?? 0) + 1;
  task.state = next;
  task.stateHistory.push({ sequence: task.nextStateSequence++, state: next, at, generation: task.generation });
  if (task.stateHistory.length > MAX_STATE_HISTORY) task.stateHistory.splice(0, task.stateHistory.length - MAX_STATE_HISTORY);
  return previous;
}

export function taskTiming(task: BackgroundTaskRecord, now = Date.now()): BackgroundTaskTimingSummary {
  const timing = ensureTimingAccumulator(task);
  const totals = {
    queueMs: timing.queueMs,
    captureMs: timing.captureMs,
    executionMs: timing.executionMs,
    reviewMs: timing.reviewMs,
    landingMs: timing.landingMs,
  };
  if (isActiveTaskState(task.state)) accumulateStateDuration(totals, task.state, timing.stateEnteredAt, now);
  const terminalAt = !isActiveTaskState(task.state) ? Date.parse(timing.terminalAt ?? task.updatedAt) : now;
  const createdAt = Date.parse(task.createdAt);
  return {
    ...totals,
    totalMs: Number.isFinite(createdAt) && Number.isFinite(terminalAt) ? Math.max(0, terminalAt - createdAt) : 0,
  };
}

function emptyTimingAccumulator(stateEnteredAt: string): BackgroundTaskTimingAccumulator {
  return { queueMs: 0, captureMs: 0, executionMs: 0, reviewMs: 0, landingMs: 0, stateEnteredAt };
}

function ensureTimingAccumulator(task: BackgroundTaskRecord): BackgroundTaskTimingAccumulator {
  if (task.timingAccumulator) return task.timingAccumulator;
  const history = task.stateHistory?.length
    ? task.stateHistory
    : [{ sequence: 1, state: task.state, at: task.createdAt, generation: task.generation }];
  const timing = emptyTimingAccumulator(history[0]?.at ?? task.createdAt);
  for (let index = 0; index < history.length - 1; index += 1) {
    const transition = history[index]!;
    accumulateStateDuration(timing, transition.state, transition.at, history[index + 1]!.at);
  }
  timing.stateEnteredAt = history.at(-1)?.at ?? task.updatedAt;
  timing.terminalAt = isActiveTaskState(task.state) ? undefined : timing.stateEnteredAt;
  task.timingAccumulator = timing;
  return timing;
}

function accumulateStateDuration(
  totals: Pick<BackgroundTaskTimingAccumulator, "queueMs" | "captureMs" | "executionMs" | "reviewMs" | "landingMs">,
  state: BackgroundTaskState,
  startAt: string,
  endAt: string | number,
): void {
  if (!isActiveTaskState(state)) return;
  const start = Date.parse(startAt);
  const end = typeof endAt === "number" ? endAt : Date.parse(endAt);
  const elapsed = Number.isFinite(start) && Number.isFinite(end) ? Math.max(0, end - start) : 0;
  if (state === "queued") totals.queueMs += elapsed;
  else if (state === "capturing") totals.captureMs += elapsed;
  else if (state === "running") totals.executionMs += elapsed;
  else if (state === "reviewing") totals.reviewMs += elapsed;
  else totals.landingMs += elapsed;
}

export function appendActivity(task: BackgroundTaskRecord, phase: string, message: string): BackgroundActivityEvent | undefined {
  if (task.activity.at(-1)?.message === message) return undefined;
  const event = { sequence: task.nextActivitySequence++, at: new Date().toISOString(), phase, message };
  task.activity.push(event);
  task.updatedAt = event.at;
  if (task.activity.length > MAX_ACTIVITY) task.activity.splice(0, task.activity.length - MAX_ACTIVITY);
  return event;
}

/**
 * Bounded single-line text shared by durable archived-task references and
 * widget/watch rendering: whitespace is compacted and long values are capped
 * with a visible ellipsis.
 */
export function clipActivity(value: string, max = 180): string {
  const compact = value.replace(/\s+/g, " ").trim();
  return compact.length <= max ? compact : `${compact.slice(0, Math.max(1, max - 1))}…`;
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

export function isStoppedForExit(task: BackgroundTaskRecord): boolean {
  return task.state === "stopped_for_application_exit";
}

export function isArchivableTaskState(state: BackgroundTaskState): state is "landed" | "reported" {
  return state === "landed" || state === "reported";
}

/**
 * Repair and re-bound task bookkeeping after a durable read (and before every
 * durable write): defaults missing collections, rebuilds derived sequence
 * counters, restores the timing accumulator from state history, and enforces
 * the bounded activity/history limits.
 */
export function normalizeTaskHistory(task: BackgroundTaskRecord): void {
  task.activity ??= [];
  task.commands ??= [];
  if (task.activity.length > MAX_ACTIVITY) task.activity.splice(0, task.activity.length - MAX_ACTIVITY);
  task.nextActivitySequence = Math.max(task.nextActivitySequence ?? 1, (task.activity.at(-1)?.sequence ?? 0) + 1);
  if (!Array.isArray(task.stateHistory) || task.stateHistory.length === 0) {
    task.stateHistory = [{ sequence: 1, state: task.state, at: task.createdAt, generation: task.generation }];
  }
  ensureTimingAccumulator(task);
  if (task.stateHistory.length > MAX_STATE_HISTORY) task.stateHistory.splice(0, task.stateHistory.length - MAX_STATE_HISTORY);
  task.nextStateSequence = Math.max(task.nextStateSequence ?? 1, (task.stateHistory.at(-1)?.sequence ?? 0) + 1);
}

export function cloneTask(task: BackgroundTaskRecord): BackgroundTaskRecord {
  return JSON.parse(JSON.stringify(task)) as BackgroundTaskRecord;
}
