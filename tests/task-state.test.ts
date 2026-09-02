import assert from "node:assert/strict";
import test from "node:test";
import {
  BACKGROUND_TASK_STATES,
  MAX_ACTIVITY,
  MAX_STATE_HISTORY,
  appendActivity,
  cloneTask,
  clipActivity,
  isActiveTaskState,
  isArchivableTaskState,
  isForceMergeCandidateTaskState,
  isInterruptibleTaskState,
  isStoppedForExit,
  newTask,
  normalizeTaskHistory,
  stateFromContinuationProgress,
  stateFromWaveProgress,
  taskTiming,
  transitionTaskState,
  type BackgroundTaskDefinition,
} from "../src/execution/task-state";

const definition: BackgroundTaskDefinition = {
  taskId: "fixture",
  title: "Fixture task",
  instructions: "Do the fixture work.",
  acceptanceCriteria: ["Fixture criteria"],
  backgroundKind: "execute",
} as unknown as BackgroundTaskDefinition;

const T0 = "2024-01-01T00:00:00.000Z";
const T1 = "2024-01-01T00:01:00.000Z";
const T2 = "2024-01-01T00:03:00.000Z";

function taskAtFixedTimes(): ReturnType<typeof newTask> {
  const task = newTask(definition);
  task.createdAt = T0;
  task.updatedAt = T0;
  task.stateHistory = [{ sequence: 1, state: "queued", at: T0, generation: 0 }];
  task.nextStateSequence = 2;
  task.timingAccumulator = undefined;
  return task;
}

test("newTask seeds a queued task with cloned definition and bounded bookkeeping", () => {
  const task = newTask(definition);
  assert.equal(task.state, "queued");
  assert.equal(task.generation, 0);
  assert.match(task.taskId, /^task-/);
  assert.notEqual(task.definition, definition);
  assert.deepEqual(task.definition.acceptanceCriteria, definition.acceptanceCriteria);
  assert.equal(task.activity.length, 0);
  assert.equal(task.nextActivitySequence, 1);
  assert.equal(task.commands.length, 0);
  assert.deepEqual(task.stateHistory, [{ sequence: 1, state: "queued", at: task.createdAt, generation: 0 }]);
  assert.equal(task.nextStateSequence, 2);
  assert.ok(task.timingAccumulator);
  assert.equal(task.timingAccumulator!.stateEnteredAt, task.createdAt);
});

test("state predicates partition all task states", () => {
  for (const state of BACKGROUND_TASK_STATES) {
    assert.equal(isInterruptibleTaskState(state), isActiveTaskState(state));
    assert.equal(isForceMergeCandidateTaskState(state), !isActiveTaskState(state));
  }
  assert.equal(isArchivableTaskState("landed"), true);
  assert.equal(isArchivableTaskState("reported"), true);
  assert.equal(isArchivableTaskState("failed"), false);
  assert.equal(isArchivableTaskState("running"), false);
  assert.equal(isStoppedForExit({ ...newTask(definition), state: "stopped_for_application_exit" }), true);
  assert.equal(isStoppedForExit({ ...newTask(definition), state: "failed" }), false);
});

test("transitionTaskState is a no-op for the same state apart from updatedAt", () => {
  const task = taskAtFixedTimes();
  const previous = transitionTaskState(task, "queued", T1);
  assert.equal(previous, "queued");
  assert.equal(task.state, "queued");
  assert.equal(task.updatedAt, T1);
  assert.equal(task.stateHistory!.length, 1);
  // A same-state transition returns before touching the timing accumulator.
  assert.equal(task.timingAccumulator, undefined);
});

test("transitionTaskState accumulates timing per state and prunes bounded history", () => {
  const task = taskAtFixedTimes();
  assert.equal(transitionTaskState(task, "running", T1), "queued");
  assert.equal(transitionTaskState(task, "landed", T2), "running");
  const timing = taskTiming(task, Date.parse(T2));
  assert.equal(timing.queueMs, 60_000);
  assert.equal(timing.executionMs, 120_000);
  assert.equal(timing.captureMs, 0);
  assert.equal(timing.reviewMs, 0);
  assert.equal(timing.landingMs, 0);
  assert.equal(timing.totalMs, 180_000);
  assert.equal(task.timingAccumulator!.terminalAt, T2);
  const baseNextSequence = task.nextStateSequence!;
  for (let index = 0; index < MAX_STATE_HISTORY + 10; index += 1) {
    transitionTaskState(task, index % 2 === 0 ? "paused_recoverable" : "queued", `2024-02-0${(index % 9) + 1}T00:00:00.000Z`);
  }
  assert.equal(task.stateHistory!.length, MAX_STATE_HISTORY);
  assert.equal(task.nextStateSequence, baseNextSequence + MAX_STATE_HISTORY + 10);
});

test("taskTiming accumulates a running task up to now", () => {
  const task = taskAtFixedTimes();
  transitionTaskState(task, "running", T1);
  const timing = taskTiming(task, Date.parse(T2));
  assert.equal(timing.executionMs, 120_000);
  assert.equal(timing.totalMs, 180_000);
});

test("appendActivity deduplicates consecutive messages and bounds history", () => {
  const task = newTask(definition);
  const first = appendActivity(task, "phase", "message");
  assert.ok(first);
  assert.equal(first.sequence, 1);
  assert.equal(appendActivity(task, "phase", "message"), undefined);
  const second = appendActivity(task, "phase", "different");
  assert.equal(second!.sequence, 2);
  assert.equal(task.updatedAt, second!.at);
  for (let index = 0; index < MAX_ACTIVITY + 10; index += 1) {
    appendActivity(task, "phase", `event-${index}`);
  }
  assert.equal(task.activity.length, MAX_ACTIVITY);
  assert.equal(task.activity[0]!.message, "event-10");
  assert.equal(task.activity.at(-1)!.message, `event-${MAX_ACTIVITY + 9}`);
  assert.equal(task.nextActivitySequence, MAX_ACTIVITY + 13);
});

test("clipActivity compacts whitespace and bounds with a visible ellipsis", () => {
  assert.equal(clipActivity("  a\n\n b\t c  "), "a b c");
  assert.equal(clipActivity("x".repeat(180)), "x".repeat(180));
  const clipped = clipActivity("x".repeat(181));
  assert.equal(clipped.length, 180);
  assert.equal(clipped.endsWith("…"), true);
  assert.equal(clipActivity("x".repeat(500), 20).length, 20);
});

test("normalizeTaskHistory repairs missing bookkeeping and rebuilds timing", () => {
  const task = taskAtFixedTimes();
  const sparse = task as unknown as Record<string, unknown>;
  sparse.timingAccumulator = undefined;
  delete sparse.activity;
  delete sparse.commands;
  delete sparse.nextActivitySequence;
  delete sparse.nextStateSequence;
  normalizeTaskHistory(task);
  assert.deepEqual(task.activity, []);
  assert.deepEqual(task.commands, []);
  assert.equal(task.nextActivitySequence, 1);
  assert.equal(task.nextStateSequence, 2);
  assert.ok(task.timingAccumulator);
  assert.equal(task.timingAccumulator!.stateEnteredAt, T0);
  assert.equal(task.nextStateSequence, (task.stateHistory!.at(-1)?.sequence ?? 0) + 1);
});

test("normalizeTaskHistory prunes oversized activity and history and advances sequences", () => {
  const task = taskAtFixedTimes();
  task.activity = Array.from({ length: MAX_ACTIVITY + 5 }, (_, index) => ({
    sequence: index + 1,
    at: T0,
    phase: "p",
    message: `m${index}`,
  }));
  task.stateHistory = Array.from({ length: MAX_STATE_HISTORY + 5 }, (_, index) => ({
    sequence: index + 1,
    state: "queued" as const,
    at: T0,
    generation: 0,
  }));
  normalizeTaskHistory(task);
  assert.equal(task.activity.length, MAX_ACTIVITY);
  assert.equal(task.stateHistory!.length, MAX_STATE_HISTORY);
  assert.equal(task.nextActivitySequence, MAX_ACTIVITY + 6);
  assert.equal(task.nextStateSequence, MAX_STATE_HISTORY + 6);
});

test("stateFromWaveProgress maps wave phases to task states", () => {
  const update = (phase: string, extra: Record<string, unknown> = {}) =>
    stateFromWaveProgress({ phase, message: "m", ...extra } as never);
  assert.equal(update("capturing"), "capturing");
  assert.equal(update("integrating"), "waiting_to_land");
  assert.equal(update("planning"), "waiting_to_land");
  assert.equal(update("landing"), "landing");
  assert.equal(update("completed"), undefined);
  assert.equal(update("aborted"), undefined);
  assert.equal(update("settling"), undefined);
  assert.equal(update("working", { subtask: { phase: "reviewing", message: "m" } }), "reviewing");
  assert.equal(update("working", { subtask: { phase: "correcting", message: "m" } }), "running");
  assert.equal(update("working", { subtask: { phase: "starting", message: "m" } }), "running");
  assert.equal(update("working", { taskStatuses: [{ taskId: "t", phase: "accepted" }] }), "accepted");
  assert.equal(update("working", { taskStatuses: [{ taskId: "t", phase: "accepted_with_warnings" }] }), "accepted");
  assert.equal(update("working", { taskStatuses: [{ taskId: "t", phase: "no_changes" }] }), "accepted");
  assert.equal(update("working", { taskStatuses: [{ taskId: "t", phase: "unknown-phase" }] }), undefined);
});

test("stateFromContinuationProgress maps continuation phases to task states", () => {
  const update = (phase: string) => stateFromContinuationProgress({ phase, message: "m" } as never);
  assert.equal(update("accepted"), "accepted");
  assert.equal(update("integrating"), "waiting_to_land");
  assert.equal(update("landing"), "landing");
  assert.equal(update("reviewing"), "reviewing");
  assert.equal(update("executing"), "running");
  assert.equal(update("mystery"), "running");
});

test("cloneTask produces a deep structural copy", () => {
  const task = newTask(definition);
  appendActivity(task, "phase", "message");
  const clone = cloneTask(task);
  assert.deepEqual(clone, task);
  assert.notEqual(clone, task);
  assert.notEqual(clone.activity, task.activity);
  clone.activity[0]!.message = "mutated";
  assert.equal(task.activity[0]!.message, "message");
});
