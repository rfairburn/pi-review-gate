/**
 * Shared pure helpers for the extracted task lifecycles (identity, review
 * status, event snapshots, and persisted-snapshot synchronization). These are
 * the controller's existing pure helpers — moved verbatim to one home so the
 * per-kind runner modules can import them without any controller dependency.
 * Nothing here owns mutable state: identity and review status are applied to
 * task records by reference, the event snapshot clones the group/task pair at
 * the call point, and the sync helper copies the actual persisted revision
 * into that same clone.
 */
import { join } from "node:path";
import type { ExecutorSelection } from "../config";
import { readOperationRecord } from "./operation-record";
import type { BackgroundExecutionGroup } from "./background-group-store";
import type { BackgroundTaskRecord } from "./task-state";
import type { EventSnapshot, PersistedGroupRevision } from "./task-lifecycle-services";

/**
 * Apply the live executor identity from a progress update before persistence,
 * transition snapshots, and indicator updates so widget/watch labels track
 * failovers while the task is still active — not only after it settles. The
 * model comes from the actual adapter invocation, which is immutable
 * identity: later catalog or settings changes can never relabel a task that
 * already ran.
 */
export function applyExecutorIdentity(
  task: BackgroundTaskRecord,
  update: { executorEntryId?: string; executorSelection?: ExecutorSelection; model?: string },
): void {
  if (update.executorEntryId) task.executorEntryId = update.executorEntryId;
  // An authoritative selection always re-establishes the model identity —
  // including clearing it: models are optional for external executors, so a
  // model-less successor must not keep displaying the predecessor's model.
  if (update.executorSelection) {
    task.executorSelection = update.executorSelection;
    task.executorModel = update.model;
  }
  if (update.model) task.executorModel = update.model;
}

/** Progress phases that count as review activity for the shared status projection. */
const REVIEW_ACTIVITY_PHASES = ["reviewing", "correcting", "confirming"];

/**
 * Project one progress update's reviewer labels and review phase into the
 * task's durable `reviewStatus` (#314) — the single record the subtask
 * indicator snapshot and the widget's `reviewers … (phase)` segment render,
 * so every kind's progress pipeline shares one presentation contract.
 * Reviewer labels are exactly what the worker emitted for this task (never
 * re-resolved from current configuration), a non-review phase never replaces
 * an established review phase, and an update carrying neither reviewers nor a
 * reviewing phase never creates review state at all. Pure presentation data:
 * nothing here drives lifecycle, routing, or outcome.
 */
export function applyReviewStatus(
  task: BackgroundTaskRecord,
  update: {
    message: string;
    /** Reviewer labels emitted with this update, when it carries any. */
    reviewers?: string[];
    /** Phase carried by the worker's own progress update, when it reports one. */
    workerPhase?: string;
    /** Latest phase from the update's aggregate per-task status record. */
    statusPhase?: string;
    /** The update settled the task as accepted (wave landing checkpoint). */
    accepted?: boolean;
  },
): void {
  const workerPhase = update.workerPhase;
  const isReviewActivity = workerPhase !== undefined && REVIEW_ACTIVITY_PHASES.includes(workerPhase);
  const phase = update.accepted
    ? "accepted"
    : isReviewActivity
      ? workerPhase
      : task.reviewStatus?.phase ?? update.statusPhase;
  if (!task.reviewStatus && !update.reviewers?.length && phase !== "reviewing") return;
  task.reviewStatus ??= {
    phase: phase ?? task.state,
    reviewers: [],
    activity: [],
    updatedAt: new Date().toISOString(),
  };
  if (update.reviewers?.length) task.reviewStatus.reviewers = [...update.reviewers];
  if (phase) task.reviewStatus.phase = phase;
  if (isReviewActivity || update.accepted) {
    if (task.reviewStatus.activity.at(-1) !== update.message) task.reviewStatus.activity.push(update.message);
    if (task.reviewStatus.activity.length > 20) task.reviewStatus.activity.splice(0, task.reviewStatus.activity.length - 20);
  }
  task.reviewStatus.updatedAt = new Date().toISOString();
}

/**
 * Stamp the authoritative final executor identity from the settled operation
 * record so display labels reflect failovers and settings changes instead of
 * the entry id captured at launch.
 */
export async function applySettledExecutorIdentity(task: BackgroundTaskRecord): Promise<void> {
  if (!task.waveRoot) return;
  try {
    const record = await readOperationRecord(join(task.waveRoot, "artifacts", task.taskId, "operation.json"));
    if (record.executorEntryId) task.executorEntryId = record.executorEntryId;
    // Same semantics as the live path: the recorded selection re-establishes
    // the model identity, clearing a stale value when the final executor has
    // no configured model.
    if (record.executorSelection) {
      task.executorSelection = record.executorSelection;
      task.executorModel = record.model;
    }
  } catch {
    // Best effort: the label falls back to the entry-id lookup.
  }
}

export function transitionEventSnapshot(
  group: BackgroundExecutionGroup,
  task: BackgroundTaskRecord,
): EventSnapshot {
  const tasks = group.tasks.map((candidate) => ({ ...candidate }));
  return {
    group: { ...group, tasks },
    task: tasks.find((candidate) => candidate.taskId === task.taskId)!,
  };
}

export function synchronizeEventSnapshot(
  snapshot: EventSnapshot,
  persisted: PersistedGroupRevision,
): void {
  snapshot.group.revision = persisted.revision;
  snapshot.group.updatedAt = persisted.updatedAt;
  snapshot.group.peakConcurrency = persisted.peakConcurrency;
  snapshot.group.integritySha256 = persisted.integritySha256;
}