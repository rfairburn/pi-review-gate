/**
 * Issue #229: default-off UI preference for the task-ID prefix on subtask
 * activity lines.
 *
 * The wave progress pipeline records each activity message as
 * `${taskId}: ${message}`, and the expanded live panel renders each recent
 * event as `title · phase · message`, repeating the task identification already
 * supplied by the title. This preference hides only that redundant generated
 * leading prefix, and it is presentation-only: the durable activity event, the
 * task's identity in records and evidence, model-facing results, executor/model
 * labels, and notification delivery never change.
 *
 * These cases drive the actual production seams:
 * - the real widget renderer (`renderSubtaskWidget`) for the exact line text in
 *   the default-off / on / off sequence, including real-message content that
 *   merely looks like a task prefix;
 * - the real subtask indicator (`SubtaskIndicator`) reading the live config
 *   object a Save mutates, over a real durable task record whose activity came
 *   from the production `appendActivity` boundary, asserting the record's
 *   identity and data stay byte-identical across the toggle.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { normalizeConfig, type ReviewGateConfig } from "../src/config";
import type { BackgroundExecutionGroup } from "../src/execution/background-group-store";
import {
  appendActivity,
  newTask,
  type BackgroundActivityEvent,
  type BackgroundTaskKind,
  type BackgroundTaskRecord,
} from "../src/execution/task-state";
import { SubtaskIndicator } from "../src/execution/subtask-indicator";
import { renderSubtaskWidget, type SubtaskWidgetTaskSnapshot } from "../src/execution/subtask-widget";

/** Exactly the issue's example task: the wave pipeline prefixes every update. */
const EXAMPLE_TASK_ID = "task-12345678-1234-1234-1234-123456789abc";
const EXAMPLE_TITLE = "Diagnose full-suite hang";
const EXAMPLE_UPDATE = "model turn completed";
/** What the wave controller records, verbatim (`${taskId}: ${message}`). */
const EXAMPLE_RECORDED_MESSAGE = `${EXAMPLE_TASK_ID}: ${EXAMPLE_UPDATE}`;

function configWithUi(ui: { showSubtaskTaskIds?: boolean; subtasksViewExpanded?: boolean } | undefined): ReviewGateConfig {
  return normalizeConfig({
    enabled: true,
    review: { activeReviewers: [] },
    ...(ui ? { ui } : {}),
  });
}

const defaultConfig = configWithUi(undefined);
const showIdsConfig = configWithUi({ showSubtaskTaskIds: true });
const hideIdsConfig = configWithUi({ showSubtaskTaskIds: false });

function widgetTask(overrides: Partial<SubtaskWidgetTaskSnapshot> = {}): SubtaskWidgetTaskSnapshot {
  return {
    kind: "execute",
    taskId: EXAMPLE_TASK_ID,
    title: EXAMPLE_TITLE,
    state: "running",
    updatedAt: "2024-01-01T00:00:00.000Z",
    executorModel: "gpt-x",
    queuedExecutorAssigned: false,
    ...overrides,
  };
}

function activityEvent(sequence: number, message: string, phase = "working"): BackgroundActivityEvent {
  return { sequence, at: `2024-01-01T00:00:0${sequence}.000Z`, phase, message };
}

/** Render one expanded widget and return its lines. */
function expandedLines(recent: Array<{ taskId: string; title: string; event: BackgroundActivityEvent }>, config: ReviewGateConfig, tasks: SubtaskWidgetTaskSnapshot[] = [widgetTask()]): string[] {
  return renderSubtaskWidget({ expanded: true, tasks, recent }, config).component!().render(400);
}

function activityLines(lines: string[]): string[] {
  return lines.filter((line) => line.startsWith("    ") && !line.startsWith("    no activity"));
}

test("#229 default hides the owning-task prefix and the toggle restores then hides it again", () => {
  // A config with no ui block at all is the shipped default: off.
  assert.equal(defaultConfig.ui, undefined);
  const recent = [{ taskId: EXAMPLE_TASK_ID, title: EXAMPLE_TITLE, event: activityEvent(1, EXAMPLE_RECORDED_MESSAGE) }];

  const off = expandedLines(recent, defaultConfig);
  assert.deepEqual(activityLines(off), [`    ${EXAMPLE_TITLE} · working · ${EXAMPLE_UPDATE}`]);
  assert.ok(!off.join("\n").includes(EXAMPLE_TASK_ID), "the hidden line carries no task id");

  const on = expandedLines(recent, showIdsConfig);
  assert.deepEqual(activityLines(on), [`    ${EXAMPLE_TITLE} · working · ${EXAMPLE_RECORDED_MESSAGE}`]);

  // Turning it off again restores the shorter line.
  const offAgain = expandedLines(recent, hideIdsConfig);
  assert.deepEqual(activityLines(offAgain), activityLines(off));

  // Title, phase, and message are preserved apart from the displayed prefix,
  // and the active-task row (state and actual executor model) never changes.
  for (const lines of [off, on, offAgain]) {
    assert.ok(lines.some((line) => line.includes(`${EXAMPLE_TITLE} · working ·`)));
    assert.equal(lines[1], `  execute · ${EXAMPLE_TITLE} [running] · gpt-x`);
  }
});

test("#229 hides only the exact generated prefix of the event's own task", () => {
  const otherTaskId = "task-00000000-0000-0000-0000-000000000000";
  const recent = [
    // Another task's id at the start: never the owning task's prefix.
    { taskId: EXAMPLE_TASK_ID, title: "Foreign prefix", event: activityEvent(1, `${otherTaskId}: kept verbatim`) },
    // The owning id inside real content, including a colon after it.
    { taskId: EXAMPLE_TASK_ID, title: "Mid-string id", event: activityEvent(2, `retrying ${EXAMPLE_TASK_ID}: after the transport error`) },
    // The owning id without the generated `": "` separator.
    { taskId: EXAMPLE_TASK_ID, title: "Bare id", event: activityEvent(3, `${EXAMPLE_TASK_ID} reported no change`) },
    // A near-miss id that merely starts the same way.
    { taskId: EXAMPLE_TASK_ID, title: "Near miss", event: activityEvent(4, `${EXAMPLE_TASK_ID}b: not this task`) },
    // The prefix plus real content that itself starts with a task id.
    { taskId: EXAMPLE_TASK_ID, title: "Double id", event: activityEvent(5, `${EXAMPLE_TASK_ID}: ${otherTaskId}: nested reference`) },
    // A prefix-only message keeps text instead of rendering an empty segment.
    { taskId: EXAMPLE_TASK_ID, title: "Prefix only", event: activityEvent(6, `${EXAMPLE_TASK_ID}: `) },
  ];

  assert.deepEqual(activityLines(expandedLines(recent, defaultConfig)), [
    `    Foreign prefix · working · ${otherTaskId}: kept verbatim`,
    `    Mid-string id · working · retrying ${EXAMPLE_TASK_ID}: after the transport error`,
    `    Bare id · working · ${EXAMPLE_TASK_ID} reported no change`,
    `    Near miss · working · ${EXAMPLE_TASK_ID}b: not this task`,
    `    Double id · working · ${otherTaskId}: nested reference`,
    `    Prefix only · working · ${EXAMPLE_TASK_ID}:`,
  ]);

  // With the preference on, every line renders exactly as recorded.
  assert.deepEqual(activityLines(expandedLines(recent, showIdsConfig)), [
    `    Foreign prefix · working · ${otherTaskId}: kept verbatim`,
    `    Mid-string id · working · retrying ${EXAMPLE_TASK_ID}: after the transport error`,
    `    Bare id · working · ${EXAMPLE_TASK_ID} reported no change`,
    `    Near miss · working · ${EXAMPLE_TASK_ID}b: not this task`,
    `    Double id · working · ${EXAMPLE_TASK_ID}: ${otherTaskId}: nested reference`,
    // clipActivity compacts whitespace, so the retained prefix-only text is
    // shown trimmed rather than with a trailing space.
    `    Prefix only · working · ${EXAMPLE_TASK_ID}:`,
  ]);
});

test("#229 each activity line is judged against its own task, across mixed tasks", () => {
  const secondTaskId = "task-87654321-4321-4321-4321-cba987654321";
  const tasks = [
    widgetTask(),
    widgetTask({
      taskId: secondTaskId,
      title: "Audit search exclusions",
      state: "reviewing",
      updatedAt: "2024-01-01T00:00:01.000Z",
      executorModel: "claude-external",
      reviewStatus: { phase: "reviewing", reviewers: ["reviewer-a"] },
      latestCommand: { action: "steer", status: "queued" },
    }),
  ];
  const recent = [
    { taskId: EXAMPLE_TASK_ID, title: EXAMPLE_TITLE, event: activityEvent(1, `${EXAMPLE_TASK_ID}: model turn completed`) },
    { taskId: secondTaskId, title: "Audit search exclusions", event: activityEvent(2, `${secondTaskId}: reviewer verdict received`, "reviewing") },
  ];

  assert.deepEqual(activityLines(expandedLines(recent, defaultConfig, tasks)), [
    `    ${EXAMPLE_TITLE} · working · model turn completed`,
    "    Audit search exclusions · reviewing · reviewer verdict received",
  ]);
  assert.deepEqual(activityLines(expandedLines(recent, showIdsConfig, tasks)), [
    `    ${EXAMPLE_TITLE} · working · ${EXAMPLE_TASK_ID}: model turn completed`,
    `    Audit search exclusions · reviewing · ${secondTaskId}: reviewer verdict received`,
  ]);

  // Representative current state, executor/model identity, reviewer status,
  // and the latest command stay rendered identically either way. Rows are
  // ordered newest-first by the widget's own sort.
  const off = expandedLines(recent, defaultConfig, tasks);
  const on = expandedLines(recent, showIdsConfig, tasks);
  for (const lines of [off, on]) {
    assert.equal(lines[1], "  execute · Audit search exclusions [reviewing] · claude-external · reviewers reviewer-a (reviewing) · steer queued");
    assert.equal(lines[2], "  execute · Diagnose full-suite hang [running] · gpt-x");
  }
});

test("#229 the live panel toggles against the live config while the durable record and identity stay unchanged", () => {
  // A real durable task record, fed by the production activity boundary.
  const task = newTask({ title: EXAMPLE_TITLE, instructions: "find the hang", acceptanceCriteria: ["root cause named"] });
  const recorded = `${task.taskId}: model turn completed`;
  const event = appendActivity(task, "working", recorded);
  assert.ok(event);
  task.state = "reviewing";
  task.executorModel = "gpt-x";
  task.reviewStatus = { phase: "reviewing", reviewers: ["reviewer-a"], activity: [], updatedAt: task.updatedAt };

  const group: BackgroundExecutionGroup = {
    version: 3,
    revision: 0,
    integritySha256: "0".repeat(64),
    executionId: "exec-229-synthetic",
    kind: "execute" as BackgroundTaskKind,
    root: "/synthetic/execution-root",
    cwd: "/synthetic/workspace",
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    tasks: [task],
  };
  const durableBefore = structuredClone(task.activity);
  const identityBefore = { taskId: task.taskId, title: task.definition.title, executorModel: task.executorModel };

  // The live config object is what a settings Save or session-only apply
  // mutates; the indicator reads it at every render.
  const liveConfig = configWithUi(undefined);
  const frames: string[][] = [];
  const indicator = new SubtaskIndicator({
    config: () => liveConfig,
    activeTaskEntries: () => [{ group, task }],
    isRuntimeActive: () => false,
    conflictGatePaths: () => undefined,
    recentActivity: () => [{ taskId: task.taskId, title: task.definition.title, event }],
  }, true);
  indicator.setContext({ ui: { setWidget: (_name: string, content: unknown) => {
    if (typeof content === "function") frames.push((content as () => { render(width: number): string[] })().render(400));
    else frames.push((content as string[] | undefined) ?? []);
  } } });

  const first = frames.at(-1)!;
  liveConfig.ui = { ...liveConfig.ui, showSubtaskTaskIds: true };
  indicator.render();
  const second = frames.at(-1)!;
  liveConfig.ui = { ...liveConfig.ui, showSubtaskTaskIds: false };
  indicator.render();
  const third = frames.at(-1)!;

  assert.deepEqual(activityLines(first), [`    ${EXAMPLE_TITLE} · working · model turn completed`]);
  assert.deepEqual(activityLines(second), [`    ${EXAMPLE_TITLE} · working · ${recorded}`]);
  assert.deepEqual(activityLines(third), activityLines(first));

  // The task row keeps the durable state and the actual invocation's model.
  for (const lines of [first, second, third]) {
    assert.equal(lines[1], `  execute · ${EXAMPLE_TITLE} [reviewing] · gpt-x · reviewers reviewer-a (reviewing)`);
  }

  // Canonical record data and identity are untouched by any render.
  assert.deepEqual(task.activity, durableBefore);
  assert.deepEqual(
    { taskId: task.taskId, title: task.definition.title, executorModel: task.executorModel },
    identityBefore,
  );
  assert.equal(task.activity[0]!.message, recorded);
  assert.equal(task.activity[0]!.sequence, 1);
  assert.equal(task.activity[0]!.phase, "working");
});
