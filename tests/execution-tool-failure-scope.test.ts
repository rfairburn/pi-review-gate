/**
 * Issue #626: the shared ordinary-failure path behind every registered
 * `Subtasks*` action replays only the execution (and exact task) the request
 * actually targeted, with its historical arrays bounded in the model-visible
 * text AND in the structured details. Unrelated executions are never replayed.
 * What a failure view omits stays canonical on the durable record and is
 * retrieved with the existing read-only routes:
 * `SubtasksInspect {executionId, taskId, offset, lines}` for older activity rows
 * and `SubtasksInspect {executionId, taskId, evidence: {index, limit}}` for the
 * task's actual tool-call evidence.
 *
 * Everything here is a synthetic production path: durable groups restored
 * through the real controller and exercised only through the registered tools,
 * with a zero-capacity unstarted external agent so nothing ever dispatches and
 * no provider, executor, or real session data is involved.
 */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { normalizeConfig } from "../src/config";
import type { BackgroundExecutionController } from "../src/execution/background-controller";
import { serializeGroupSnapshot, writeGroupSnapshot, type BackgroundExecutionGroup } from "../src/execution/background-group-store";
import {
  newTask,
  type BackgroundActivityEvent,
  type BackgroundCommandRecord,
  type BackgroundTaskKind,
  type BackgroundTaskRecord,
  type BackgroundTaskState,
} from "../src/execution/task-state";
import { ExecutionToolManager } from "../src/execution/tool";
import { createState } from "../src/state";

type ToolExecute = (id: string, params: unknown, signal?: AbortSignal, update?: unknown, ctx?: unknown) => Promise<Record<string, any>>;

const SESSION_ID = "aaaaaaaa-2222-3333-4444-555555555555";
const TARGET_EXECUTION = "exec-target-626";
const TARGET_TASK = "task-target-626";
/** One early row of the target's own history: never shown by a bounded failure
 * view, and retrievable with the exact registered activity read. */
const OLD_ACTIVITY_MARKER = "OLD-TARGET-ACTIVITY-ROW-626";
/** Data belonging only to unrelated groups: absent from a scoped failure. */
const UNRELATED_MARKERS = [
  "UNRELATED-TITLE-A626",
  "UNRELATED-TITLE-B626",
  "UNRELATED-ACTIVITY-626",
  "task-unrelated-a1",
  "task-unrelated-b1",
  "exec-unrelated-a626",
  "exec-unrelated-b626",
  "exec-dup-626",
  "AMBIGUOUS-OWNER-TITLE-626",
];

function jsonlLines(...entries: unknown[]): string {
  return `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`;
}

/** A pi session with a real tool call + failed result, so evidence entries exist. */
function piSessionEntries(): unknown[] {
  return [
    { type: "session", version: 3, id: SESSION_ID, timestamp: "2025-06-01T10:00:00.000Z", cwd: "/tmp/wt" },
    {
      type: "message", id: "m-user-1", parentId: null, timestamp: "2025-06-01T10:00:01.000Z",
      message: { role: "user", content: [{ type: "text", text: "do the bounded thing" }] },
    },
    {
      type: "message", id: "m-asst-1", parentId: "m-user-1", timestamp: "2025-06-01T10:00:02.000Z",
      message: {
        role: "assistant",
        content: [{ type: "toolCall", id: "call-626", name: "bash", arguments: { command: "npm test" } }],
      },
    },
    {
      type: "message", id: "m-res-1", parentId: "m-asst-1", timestamp: "2025-06-01T10:00:03.000Z",
      message: {
        role: "toolResult", toolCallId: "call-626", toolName: "bash", isError: true, details: {}, usage: null,
        timestamp: "2025-06-01T10:00:03.000Z",
        content: [{ type: "text", text: "TARGET-TASK-EVIDENCE-MARKER-626" }],
      },
    },
  ];
}

interface TaskSpec {
  taskId: string;
  state: BackgroundTaskState;
  title: string;
  /** Number of seeded activity rows; the oldest carries OLD_ACTIVITY_MARKER. */
  activity?: number;
  summary?: string;
  error?: string;
  commands?: BackgroundCommandRecord[];
  /** Seed a durable review body so a failure snapshot must omit it. */
  reviewStatus?: { phase: string; reviewers: string[]; activity: string[]; updatedAt: string };
}

interface GroupSpec {
  executionId: string;
  kind?: BackgroundTaskKind;
  tasks: TaskSpec[];
}

function seededActivity(count: number, marker?: string): BackgroundActivityEvent[] {
  const rows: BackgroundActivityEvent[] = [];
  for (let index = 0; index < count; index += 1) {
    rows.push({
      sequence: index + 1,
      at: new Date(Date.UTC(2025, 5, 1, 10, 0, index % 60)).toISOString(),
      phase: index === 0 ? "capture" : "execution",
      message: index === 0 && marker
        ? `${marker} earliest retained durable activity row`
        : `seeded durable activity row ${index + 1}`,
    });
  }
  return rows;
}

/**
 * Restores durable v3 groups through the real controller and registers the
 * production tools against them. `unstarted` has zero capacity, so no task is
 * ever dispatched; every assertion runs on the registered tool boundary.
 */
async function managerWithGroups(
  base: string,
  sourceRoot: string,
  specs: GroupSpec[],
  options: { omitActiveToolSnapshot?: boolean } = {},
): Promise<{
  manager: ExecutionToolManager;
  controller: BackgroundExecutionController;
  tools: Record<string, Record<string, any>>;
  execute: (name: string) => ToolExecute;
}> {
  const now = new Date().toISOString();
  const groupRoots: string[] = [];
  for (const spec of specs) {
    const groupRoot = join(base, `pi-review-execution-${spec.executionId}`);
    await mkdir(groupRoot, { recursive: true });
    const records = spec.tasks.map((task): BackgroundTaskRecord => {
      const record = newTask({ title: task.title, instructions: `bounded instructions for ${task.taskId}`, acceptanceCriteria: ["done"] });
      record.taskId = task.taskId;
      record.state = task.state;
      record.activity = seededActivity(task.activity ?? 4, task.taskId === TARGET_TASK ? OLD_ACTIVITY_MARKER : undefined);
      record.nextActivitySequence = (task.activity ?? 4) + 1;
      if (task.summary !== undefined) record.summary = task.summary;
      if (task.error !== undefined) record.error = task.error;
      if (task.commands) record.commands = task.commands;
      if (task.reviewStatus) record.reviewStatus = task.reviewStatus;
      return record;
    });
    const group: BackgroundExecutionGroup = {
      version: 3,
      revision: 1,
      integritySha256: "",
      executionId: spec.executionId,
      kind: spec.kind ?? "execute",
      root: await realpath(groupRoot),
      cwd: sourceRoot,
      createdAt: now,
      updatedAt: now,
      peakConcurrency: 1,
      tasks: records,
    };
    await writeGroupSnapshot(group.root, serializeGroupSnapshot(group, new Map()));
    groupRoots.push(group.root);
  }
  const tools: Array<Record<string, any>> = [];
  const pi: Record<string, any> = {
    registerTool(tool: Record<string, any>) { tools.push(tool); },
    registerCommand() {},
    setToolActive() {},
  };
  if (!options.omitActiveToolSnapshot) {
    pi.getActiveTools = () => ["read", "bash"];
  }
  const config = normalizeConfig({
    enabled: true,
    review: { activeReviewers: [] },
    externalAgents: {
      unstarted: { adapter: "run-as-binary", command: process.execPath, execution: { protocol: "pi-review-executor-jsonl-v1", args: ["-e", ""] } },
    },
    execution: {
      workerResources: { default: { selection: { source: "external", id: "unstarted" }, maxConcurrent: 1 } },
      routes: { execute: [{ resourceId: "default" }], research: [] },
    },
  });
  // Nothing may ever dispatch in these fixtures: settlement is never needed.
  config.execution!.maxWorkers = 0;
  const manager = new ExecutionToolManager({ pi, config, state: createState(), cwd: () => sourceRoot });
  manager.sync();
  const controller = (manager as unknown as { controller: BackgroundExecutionController }).controller;
  await controller.restore({ waveRoots: [], bundles: [], groupRoots });
  const byName: Record<string, Record<string, any>> = {};
  for (const tool of tools) byName[tool.name] = tool;
  return {
    manager,
    controller,
    tools: byName,
    execute: (name: string) => byName[name].execute as ToolExecute,
  };
}

/** The standard fixture: one target group plus unrelated history. */
function standardSpecs(unrelatedGroups: number): GroupSpec[] {
  const specs: GroupSpec[] = [
    {
      executionId: TARGET_EXECUTION,
      tasks: [{
        taskId: TARGET_TASK,
        state: "paused_recoverable",
        title: "TARGET-TITLE-626",
        activity: 120,
        summary: "TARGET-CURRENT-OUTCOME-626: the checkpoint is retained and awaiting continuation.",
        reviewStatus: { phase: "reviewing", reviewers: ["reviewer-a"], activity: ["durable review body"], updatedAt: "2025-06-01T10:30:00.000Z" },
      }],
    },
    {
      executionId: "exec-research-626",
      kind: "research",
      tasks: [{ taskId: "task-research-626", state: "paused_recoverable", title: "RESEARCH-TITLE-626", activity: 3 }],
    },
  ];
  for (let index = 0; index < unrelatedGroups; index += 1) {
    const suffix = String.fromCharCode(97 + (index % 2));
    specs.push({
      executionId: `exec-unrelated-${suffix}626-${index}`,
      tasks: [
        { taskId: `task-unrelated-${suffix}1-${index}`, state: "interrupted", title: `UNRELATED-TITLE-${suffix.toUpperCase()}626-${index}`, activity: 30, summary: `UNRELATED-ACTIVITY-626-${index} interrupted outcome` },
        { taskId: `task-unrelated-${suffix}2-${index}`, state: "failed", title: `UNRELATED-TITLE-${suffix.toUpperCase()}626-${index}-b`, activity: 30 },
        { taskId: `task-unrelated-${suffix}3-${index}`, state: "conflicted", title: `UNRELATED-TITLE-${suffix.toUpperCase()}626-${index}-c`, activity: 30 },
      ],
    });
  }
  return specs;
}

/**
 * Measures the two surfaces separately: the emitted content-text bytes
 * (`textBytes`), the serialized structured-details bytes (`detailsBytes`), and
 * the whole serialized result envelope (`resultJsonBytes`). The component sum is
 * named for what it is — the sum of those two parts, not the serialized result.
 */
function measured(label: string, response: Record<string, any>, extra: Record<string, unknown> = {}): { textBytes: number; detailsBytes: number; resultJsonBytes: number } {
  const text = String(response.content?.[0]?.text ?? "");
  const details = JSON.stringify(response.details ?? null);
  const textBytes = Buffer.byteLength(text, "utf8");
  const detailsBytes = Buffer.byteLength(details, "utf8");
  const resultJsonBytes = Buffer.byteLength(JSON.stringify(response), "utf8");
  console.log(JSON.stringify({
    measurement: label,
    textBytes,
    detailsBytes,
    resultJsonBytes,
    textPlusDetailsBytes: textBytes + detailsBytes,
    isError: response.isError,
    unrelatedMarkerInText: UNRELATED_MARKERS.some((marker) => text.includes(marker)),
    unrelatedMarkerInDetails: UNRELATED_MARKERS.some((marker) => details.includes(marker)),
    ...extra,
  }));
  return { textBytes, detailsBytes, resultJsonBytes };
}

function assertNoUnrelatedLeaks(label: string, ...haystacks: string[]): void {
  for (const haystack of haystacks) {
    for (const marker of UNRELATED_MARKERS) {
      assert.ok(!haystack.includes(marker), `${label} must not replay unrelated data: ${marker}`);
    }
  }
}

test("a fixed-target failure keeps the same default payload whether the session holds 2 or 12 unrelated groups (matched fixture, measured)", async () => {
  const cases: Array<{ label: string; unrelatedGroups: number; toleranceBytes: number }> = [
    { label: "few-unrelated-groups", unrelatedGroups: 1, toleranceBytes: 0 },
    { label: "many-unrelated-groups", unrelatedGroups: 11, toleranceBytes: 0 },
  ];
  const results: Record<string, { textBytes: number; detailsBytes: number }> = {};
  for (const fixture of cases) {
    const base = await mkdtemp(join(tmpdir(), "pi-review-failure-scope-"));
    const sourceRoot = join(base, "source");
    await mkdir(sourceRoot, { recursive: true });
    const { manager, execute } = await managerWithGroups(base, sourceRoot, standardSpecs(fixture.unrelatedGroups));
    try {
      const response = await execute("SubtasksContinue")("scope-continue", {
        executionId: TARGET_EXECUTION,
        taskId: TARGET_TASK,
        instructions: "continue from the retained checkpoint",
      }, undefined, undefined, {});
      assert.equal(response.isError, true, `${fixture.label}: strict continuation without a verified checkpoint fails`);
      assert.equal(typeof response.details.diagnostic, "string");
      assert.equal(response.details.action, "continue");
      results[fixture.label] = measured(fixture.label, response, {
        unrelatedGroupCount: fixture.unrelatedGroups,
        restoredGroups: standardSpecs(fixture.unrelatedGroups).length,
        restoredTasks: standardSpecs(fixture.unrelatedGroups).reduce((total, spec) => total + spec.tasks.length, 0),
        targetActivityRows: 120,
      });
    } finally {
      await manager.shutdown();
      await rm(base, { recursive: true, force: true });
    }
  }
  const few = results["few-unrelated-groups"]!;
  const many = results["many-unrelated-groups"]!;
  // The unrelated inventory must not move the default failure payload at all:
  // the same target produces the same text and the same serialized details.
  assert.equal(many.textBytes, few.textBytes, "default failure TEXT size must not grow with unrelated executions");
  assert.equal(many.detailsBytes, few.detailsBytes, "default failure JSON details size must not grow with unrelated executions");
});

test("a scoped failure keeps the current failure, ownership, recovery, and conflict facts and omits unrelated history", async () => {
  const base = await mkdtemp(join(tmpdir(), "pi-review-failure-scope-"));
  const sourceRoot = join(base, "source");
  await mkdir(sourceRoot, { recursive: true });
  const { manager, tools, execute } = await managerWithGroups(base, sourceRoot, standardSpecs(3));
  try {
    const response = await execute("SubtasksContinue")("scoped-continue", {
      executionId: TARGET_EXECUTION,
      taskId: TARGET_TASK,
      instructions: "continue from the retained checkpoint",
    }, undefined, undefined, {});
    assert.equal(response.isError, true);
    const text = String(response.content[0].text);
    const detailsJson = JSON.stringify(response.details);

    // The actual failure and its recovery/ownership/conflict facts stay present.
    assert.match(text, /SubtasksContinue failed: /);
    assert.match(text, /Source workspace: unchanged_or_independently_landed\./);
    assert.match(text, /Recovery guidance:/);
    assert.match(text, /SubtasksInspect: Inspect the execution\/task state/);
    assert.match(text, new RegExp(`Failure snapshot: execution ${TARGET_EXECUTION} · task ${TARGET_TASK}`));
    assert.match(text, /no other associated execution is replayed/);
    assert.match(text, /Bounded history:/);
    assert.match(text, /a retained cap, not the task's lifetime total/);
    assert.match(text, /"offset": 0, "lines": 3/);
    assert.match(text, /offset is an array index, not an activity sequence number/);
    // The target's own current facts survive the projection.
    assert.match(text, new RegExp(TARGET_TASK));
    assert.match(text, /TARGET-CURRENT-OUTCOME-626/);
    assert.match(text, /paused_recoverable/);

    // Exactly one execution is replayed, and it is the requested one.
    assert.ok(Array.isArray(response.details.executions));
    assert.equal(response.details.executions.length, 1);
    assert.equal(response.details.executions[0].executionId, TARGET_EXECUTION);
    assert.equal(response.details.executions[0].tasks.length, 1);
    assert.equal(response.details.executions[0].tasks[0].taskId, TARGET_TASK);
    // Historical arrays are bounded in the metadata too, and the disclosure is
    // truthful about what it retained and omitted.
    assert.equal(response.details.executions[0].tasks[0].activity.length, 3);
    assert.equal(response.details.failureScope.resolved, true);
    assert.equal(response.details.failureScope.included.activityRows, 3);
    assert.equal(response.details.failureScope.omitted.activityRows, 117);
    assert.equal(response.details.failureScope.omitted.nestedTaskFields.includes("stateHistory"), true);
    for (const field of ["result", "researchResult", "inplaceResult", "dispatch", "initialDispatch", "reviewStatus", "stateHistory", "timingAccumulator"]) {
      assert.equal(response.details.executions[0].tasks[0][field], undefined, `failure metadata must omit nested ${field}`);
    }

    // Unrelated executions are absent from every surface.
    assertNoUnrelatedLeaks("model-visible text", text);
    assertNoUnrelatedLeaks("structured details", detailsJson);
    const collapsed = tools.SubtasksInspect!.renderResult(response, { expanded: false }, { bold: (v: string) => v, fg: (_c: string, v: string) => v }).render(400).join("\n");
    const expanded = tools.SubtasksInspect!.renderResult(response, { expanded: true }, { bold: (v: string) => v, fg: (_c: string, v: string) => v }).render(400).join("\n");
    assertNoUnrelatedLeaks("collapsed render", collapsed);
    assertNoUnrelatedLeaks("expanded render", expanded);
    // The expanded error renderer still shows the failure's own facts.
    assert.match(expanded, /· failed/);
    assert.match(expanded, /Recovery guidance/);
    assert.match(expanded, new RegExp(TARGET_TASK));
    assert.match(expanded, /TARGET-CURRENT-OUTCOME-626/);
  } finally {
    await manager.shutdown();
    await rm(base, { recursive: true, force: true });
  }
});

test("a long target history is bounded in text and metadata while the canonical durable record stays intact", async () => {
  const base = await mkdtemp(join(tmpdir(), "pi-review-failure-scope-"));
  const sourceRoot = join(base, "source");
  await mkdir(sourceRoot, { recursive: true });
  const { manager, controller, execute } = await managerWithGroups(base, sourceRoot, standardSpecs(2));
  try {
    const canonicalBefore = controller.inspect(TARGET_EXECUTION, TARGET_TASK);
    assert.equal(canonicalBefore.tasks[0].activity.length, 120);

    const response = await execute("SubtasksSteer")("bounded-steer", {
      executionId: TARGET_EXECUTION,
      taskId: TARGET_TASK,
      instructions: "change direction",
    }, undefined, undefined, {});
    assert.equal(response.isError, true);
    const canonicalAfter = controller.inspect(TARGET_EXECUTION, TARGET_TASK);
    const text = String(response.content[0].text);
    const lines = text.split("\n");
    const header = lines.findIndex((line) => line.includes("recent historical activity"));
    assert.ok(header >= 0, "the failure text names its recent activity block");
    let shownRows = 0;
    for (const line of lines.slice(header + 1)) {
      if (!line.startsWith("  - ")) break;
      shownRows += 1;
    }
    assert.equal(shownRows, 3, "the failure text keeps only the recent activity tail");
    assert.ok(!text.includes(OLD_ACTIVITY_MARKER), "an old retained row is not replayed by the failure view");
    assert.equal(response.details.executions[0].tasks[0].activity.length, 3);
    assert.equal(
      response.details.failureScope.included.activityRows + response.details.failureScope.omitted.activityRows,
      canonicalAfter.tasks[0].activity.length,
      "the disclosure accounts for every row in the retained window",
    );

    // Nothing was trimmed durably by the failure view: the pre-existing rows are
    // byte-for-byte intact (the failed request itself may legitimately record
    // its own new activity).
    assert.ok(canonicalAfter.tasks[0].activity.length >= canonicalBefore.tasks[0].activity.length);
    assert.deepEqual(
      canonicalAfter.tasks[0].activity.slice(0, canonicalBefore.tasks[0].activity.length),
      canonicalBefore.tasks[0].activity,
    );
    assert.ok(canonicalAfter.tasks[0].activity.length >= 120);
  } finally {
    await manager.shutdown();
    await rm(base, { recursive: true, force: true });
  }
});

test("the registered Inspect activity route retrieves an omitted old row and the full owning record", async () => {
  const base = await mkdtemp(join(tmpdir(), "pi-review-failure-scope-"));
  const sourceRoot = join(base, "source");
  await mkdir(sourceRoot, { recursive: true });
  const { manager, execute } = await managerWithGroups(base, sourceRoot, standardSpecs(2));
  try {
    // The failure view omits the oldest retained row ...
    const failure = await execute("SubtasksWatch")("bounded-watch", { executionId: TARGET_EXECUTION, after: "30s" }, undefined, undefined, {});
    assert.equal(failure.isError, true, "a group with no active tasks cannot be watched");
    assert.ok(!String(failure.content[0].text).includes(OLD_ACTIVITY_MARKER));
    assert.equal(failure.details.executions.length, 1);
    // ... an execution-only scope still keeps a small task window and discloses it.
    assert.equal(failure.details.failureScope.resolved, true);
    assert.equal(failure.details.failureScope.executionId, TARGET_EXECUTION);
    assert.equal(failure.details.failureScope.taskId, undefined);
    assert.equal(failure.details.executions[0].tasks[0].activity.length, 3);

    // The exact follow-up call named in that failure returns the omitted row.
    const older = await execute("SubtasksInspect")("retrieve-old-row", {
      executionId: TARGET_EXECUTION,
      taskId: TARGET_TASK,
      offset: 0,
      lines: 3,
    }, undefined, undefined, {});
    assert.equal(older.isError, false);
    assert.match(String(older.content[0].text), new RegExp(OLD_ACTIVITY_MARKER));
    assert.deepEqual(older.details.tasks[0].activity.map((row: { sequence: number }) => row.sequence), [1, 2, 3]);
    // The same call returns the full current owning record, not a projection.
    assert.ok(Array.isArray(older.details.tasks[0].stateHistory));
    assert.notEqual(older.details.tasks[0].timingAccumulator, undefined);
    assert.equal(older.details.tasks[0].definition.instructions, `bounded instructions for ${TARGET_TASK}`);
    assert.equal(older.details.failureScope, undefined, "a successful inspection carries no failure scope");

    // A full read returns the whole retained window.
    const full = await execute("SubtasksInspect")("retrieve-full-record", { executionId: TARGET_EXECUTION, taskId: TARGET_TASK }, undefined, undefined, {});
    assert.equal(full.isError, false);
    assert.equal(full.details.tasks[0].activity.length, 120);
  } finally {
    await manager.shutdown();
    await rm(base, { recursive: true, force: true });
  }
});

test("unknown or ambiguous targets stay explicit failures and never replay another execution", async () => {
  const base = await mkdtemp(join(tmpdir(), "pi-review-failure-scope-"));
  const sourceRoot = join(base, "source");
  await mkdir(sourceRoot, { recursive: true });
  const specs = standardSpecs(2);
  // A duplicate handle owned by two executions, for the ambiguous-target case.
  specs.push({
    executionId: "exec-dup-626",
    tasks: [{ taskId: TARGET_TASK, state: "interrupted", title: "AMBIGUOUS-OWNER-TITLE-626", activity: 2 }],
  });
  const { manager, execute } = await managerWithGroups(base, sourceRoot, specs);
  try {
    // Unknown task inside a valid execution: the named execution stays in scope.
    const unknownTask = await execute("SubtasksInspect")("unknown-task", { executionId: TARGET_EXECUTION, taskId: "task-missing-626" }, undefined, undefined, {});
    assert.equal(unknownTask.isError, true);
    assert.match(String(unknownTask.content[0].text), /Unknown task task-missing-626/);
    assert.match(String(unknownTask.content[0].text), /Note: requested task task-missing-626 is not in execution/);
    assert.equal(unknownTask.details.executions.length, 1);
    assert.equal(unknownTask.details.executions[0].executionId, TARGET_EXECUTION);
    assert.equal(unknownTask.details.failureScope.note !== undefined, true);
    assertNoUnrelatedLeaks("unknown-task failure", String(unknownTask.content[0].text), JSON.stringify(unknownTask.details));

    // Unknown execution: no scoped snapshot exists, and none is fabricated.
    const unknownExecution = await execute("SubtasksContinue")("unknown-execution", {
      executionId: "exec-missing-626",
      taskId: TARGET_TASK,
      instructions: "continue",
    }, undefined, undefined, {});
    assert.equal(unknownExecution.isError, true);
    assert.match(String(unknownExecution.content[0].text), /exec-missing-626/);
    assert.match(String(unknownExecution.content[0].text), /No scoped durable snapshot:/);
    assert.deepEqual(unknownExecution.details.executions, []);
    assert.equal(unknownExecution.details.failureScope.resolved, false);
    assertNoUnrelatedLeaks("unknown-execution failure", String(unknownExecution.content[0].text), JSON.stringify(unknownExecution.details));

    // A handle owned by two executions is ambiguous, not silently selected.
    const ambiguous = await execute("SubtasksInterrupt")("ambiguous-task", {
      taskId: TARGET_TASK,
      interruptMode: "interrupt_as_failure",
    }, undefined, undefined, {});
    assert.equal(ambiguous.isError, true);
    assert.match(String(ambiguous.content[0].text), /No scoped durable snapshot:/);
    assert.equal(ambiguous.details.failureScope.resolved, false);
    assert.deepEqual(ambiguous.details.executions, []);
    assertNoUnrelatedLeaks("ambiguous-target failure", String(ambiguous.content[0].text), JSON.stringify(ambiguous.details));
  } finally {
    await manager.shutdown();
    await rm(base, { recursive: true, force: true });
  }
});

/** Exactly one associated execution: the paused target and nothing else. */
function soleTargetSpecs(): GroupSpec[] {
  return [{
    executionId: TARGET_EXECUTION,
    tasks: [{
      taskId: TARGET_TASK,
      state: "paused_recoverable",
      title: "TARGET-TITLE-626",
      activity: 120,
      summary: "TARGET-CURRENT-OUTCOME-626: the checkpoint is retained and awaiting continuation.",
    }],
  }];
}

test("a no-handle request against the sole associated execution keeps its safely resolvable owning snapshot", async () => {
  const base = await mkdtemp(join(tmpdir(), "pi-review-failure-scope-"));
  const sourceRoot = join(base, "source");
  await mkdir(sourceRoot, { recursive: true });
  const { manager, execute } = await managerWithGroups(base, sourceRoot, soleTargetSpecs());
  try {
    // The controller accepts omitted handles when exactly one task is known, so
    // this genuine strict-continuation failure must keep the sole group's state.
    const response = await execute("SubtasksContinue")("sole-group-no-handle", {
      instructions: "continue from the retained checkpoint",
    }, undefined, undefined, {});
    assert.equal(response.isError, true, "strict continuation without a verified checkpoint still fails");
    const text = String(response.content[0].text);
    assert.ok(!text.includes("No scoped durable snapshot:"), "a sole associated execution is safely resolvable, not an unowned request");
    assert.match(text, new RegExp(`Failure snapshot: execution ${TARGET_EXECUTION} — this request's target only`));
    assert.equal(response.details.failureScope.resolved, true);
    assert.equal(response.details.failureScope.executionId, TARGET_EXECUTION);
    assert.equal(response.details.failureScope.taskId, undefined, "no task handle is claimed for a request that named none");
    assert.equal(response.details.executions.length, 1);
    assert.equal(response.details.executions[0].executionId, TARGET_EXECUTION);
    assert.equal(response.details.executions[0].tasks[0].taskId, TARGET_TASK);
    assert.match(text, /TARGET-CURRENT-OUTCOME-626/);
  } finally {
    await manager.shutdown();
    await rm(base, { recursive: true, force: true });
  }
});

test("a no-handle request with several associated executions reports the real ambiguity, never a guess", async () => {
  const base = await mkdtemp(join(tmpdir(), "pi-review-failure-scope-"));
  const sourceRoot = join(base, "source");
  await mkdir(sourceRoot, { recursive: true });
  const { manager, execute } = await managerWithGroups(base, sourceRoot, standardSpecs(2));
  try {
    const response = await execute("SubtasksContinue")("multi-group-no-handle", {
      instructions: "continue from the retained checkpoint",
    }, undefined, undefined, {});
    assert.equal(response.isError, true);
    const text = String(response.content[0].text);
    assert.match(text, /No scoped durable snapshot:/);
    // The controller's own sole-group refusal is reported: nothing is guessed and
    // the whole session inventory is never replayed instead.
    assert.match(String(response.details.failureScope.reason), /Specify executionId/);
    assert.doesNotMatch(String(response.details.failureScope.reason), /no execution owns it/);
    assert.equal(response.details.failureScope.resolved, false);
    assert.deepEqual(response.details.executions, []);
    assertNoUnrelatedLeaks("no-handle ambiguity failure", text, JSON.stringify(response.details));
  } finally {
    await manager.shutdown();
    await rm(base, { recursive: true, force: true });
  }
});

test("start and mark_clean failures never infer an existing execution", async () => {
  const base = await mkdtemp(join(tmpdir(), "pi-review-failure-scope-"));
  const sourceRoot = join(base, "source");
  await mkdir(sourceRoot, { recursive: true });
  // One associated execution exists, so an inference would be possible — and wrong.
  // No native active-tool snapshot: SubtasksStart fails closed after validation.
  const { manager, controller, execute } = await managerWithGroups(base, sourceRoot, soleTargetSpecs(), { omitActiveToolSnapshot: true });
  const originalMarkClean = controller.markClean.bind(controller);
  (controller as unknown as { markClean: () => Promise<never> }).markClean = async () => {
    throw new Error("injected mark-clean failure");
  };
  try {
    const start = await execute("SubtasksStart")("noninference-start", {
      tasks: [{ title: "T", instructions: "I", acceptanceCriteria: ["A"] }],
    }, undefined, undefined, {});
    assert.equal(start.isError, true);
    assert.equal(start.details.failureScope.resolved, false, "a new-group request never infers an existing execution");
    assert.deepEqual(start.details.executions, []);
    assert.match(String(start.content[0].text), /No scoped durable snapshot:/);
    assert.match(String(start.details.failureScope.reason), /admits a new execution, so no existing execution owns this request/);
    assertNoUnrelatedLeaks("start non-inference", String(start.content[0].text), JSON.stringify(start.details));

    const markClean = await execute("SubtasksMarkClean")("noninference-mark-clean", {}, undefined, undefined, {});
    assert.equal(markClean.isError, true);
    assert.equal(markClean.details.failureScope.resolved, false, "a session-wide operation never infers one execution's state");
    assert.deepEqual(markClean.details.executions, []);
    assert.match(String(markClean.details.failureScope.reason), /session-wide/);
    assertNoUnrelatedLeaks("mark_clean non-inference", String(markClean.content[0].text), JSON.stringify(markClean.details));
  } finally {
    (controller as unknown as { markClean: typeof controller.markClean }).markClean = originalMarkClean;
    await manager.shutdown();
    await rm(base, { recursive: true, force: true });
  }
});

test("a recovery_required landing survives the bounded failure view even when its activity row is evicted", async () => {
  const base = await mkdtemp(join(tmpdir(), "pi-review-failure-scope-"));
  const sourceRoot = join(base, "source");
  await mkdir(sourceRoot, { recursive: true });
  const manifestPath = join(base, "wave-target-626", "landing", "recovery-626.json");
  // 40 durable rows: the landing warning is row 5, so the bounded three-row tail
  // never carries it — only the preserved current landing facts can.
  const activity = seededActivity(40).map((row) => row.sequence === 5
    ? { ...row, phase: "landing", message: `EARLY-LANDING-RECOVERY-ROW-626 rollback did not complete` }
    : row);
  const { manager, controller, execute } = await managerWithGroups(base, sourceRoot, [{
    executionId: TARGET_EXECUTION,
    tasks: [{
      taskId: TARGET_TASK,
      state: "failed",
      title: "TARGET-TITLE-626",
      // The worker's own success wording survives, and task.error stays unset —
      // exactly the case where only result.landing explains the unsafe workspace.
      summary: "Worker completed; all acceptance criteria met and the candidate was handed to landing.",
    }],
  }]);
  try {
    const groups = (controller as unknown as { groups: Map<string, { tasks: BackgroundTaskRecord[] }> }).groups;
    const seeded = groups.get(TARGET_EXECUTION)!.tasks[0]!;
    seeded.activity = activity;
    seeded.nextActivitySequence = activity.length + 1;
    seeded.result = {
      waveId: "wave-626",
      waveRoot: join(base, "wave-target-626"),
      sourceRoot,
      phase: "landing",
      taskResults: [],
      landing: {
        status: "recovery_required",
        failedAtPath: "draft.txt",
        failureReason: "injected landing failure",
        rollbackError: "injected rollback failure: backup restore refused",
        manifestPath,
      },
    };

    const response = await execute("SubtasksSteer")("recovery-required-steer", {
      executionId: TARGET_EXECUTION,
      taskId: TARGET_TASK,
      instructions: "change direction",
    }, undefined, undefined, {});
    assert.equal(response.isError, true);
    const text = String(response.content[0].text);

    // The current recovery warning is present even though its activity row is
    // outside the retained tail, and the worker-success summary cannot stand in
    // for it on its own.
    assert.match(text, new RegExp(`Landing recovery REQUIRED for ${TARGET_TASK}`));
    assert.match(text, /the source workspace may be partially modified and rollback did not complete/);
    assert.match(text, /landing failed at draft\.txt: injected landing failure/);
    assert.match(text, /rollback failed: injected rollback failure: backup restore refused/);
    assert.match(text, new RegExp(`recovery manifest: ${manifestPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
    assert.match(text, /recorded task summary is not proof that the workspace is clean/);
    assert.match(text, /Worker completed; all acceptance criteria met/);
    // Proof that the warning came from the preserved facts, not the tail.
    assert.ok(!text.includes("EARLY-LANDING-RECOVERY-ROW-626"), "the evicted activity row is not what carries the warning");

    // The structured snapshot keeps the current facts and still omits the
    // nested historical bodies.
    const projected = response.details.executions[0].tasks[0];
    assert.equal(projected.landing.status, "recovery_required");
    assert.equal(projected.landing.failureReason, "injected landing failure");
    assert.equal(projected.landing.failedAtPath, "draft.txt");
    assert.equal(projected.landing.rollbackError, "injected rollback failure: backup restore refused");
    assert.equal(projected.landing.manifestPath, manifestPath);
    assert.equal(projected.result, undefined, "the nested result body stays omitted");
    assert.equal(projected.stateHistory, undefined, "state history stays omitted");
    assert.equal(response.details.failureScope.included.landingFacts, 1);
    assert.equal(response.details.failureScope.omitted.nestedTaskFields.includes("result"), true);
    assert.ok(text.includes("the current landing status and failure/recovery facts are preserved"), "the disclosure names the preserved facts");

    // The canonical record is untouched: the full nested result is still there.
    const canonical = controller.inspect(TARGET_EXECUTION, TARGET_TASK);
    assert.equal(canonical.tasks[0].result?.landing?.status, "recovery_required");
    assert.equal(canonical.tasks[0].result?.landing?.manifestPath, manifestPath);

    // A successful inspection keeps its existing full shape, unchanged.
    const full = await execute("SubtasksInspect")("recovery-required-full-read", { executionId: TARGET_EXECUTION, taskId: TARGET_TASK }, undefined, undefined, {});
    assert.equal(full.isError, false);
    assert.equal(full.details.tasks[0].result.landing.status, "recovery_required");
    assert.equal(full.details.tasks[0].landing, undefined, "a successful read carries no failure-only projection field");
  } finally {
    await manager.shutdown();
    await rm(base, { recursive: true, force: true });
  }
});

test("an execution-only failure still warns about an older task's recovery_required landing that the task window omits", async () => {
  const base = await mkdtemp(join(tmpdir(), "pi-review-failure-scope-"));
  const sourceRoot = join(base, "source");
  await mkdir(sourceRoot, { recursive: true });
  const oldestTask = "task-oldest-626";
  const manifestPath = join(base, "wave-oldest-626", "landing", "recovery-oldest-626.json");
  const rollbackError = "injected old rollback failure: backup restore refused";
  const failureReason = "injected old landing failure";
  // One execution, six inactive tasks: the OLDEST owns the incomplete rollback,
  // and the five newer ones are the more recently updated tasks the bounded
  // failure snapshot keeps.
  const specs: GroupSpec[] = [{
    executionId: TARGET_EXECUTION,
    tasks: [
      { taskId: oldestTask, state: "failed", title: "OLDEST-RECOVERY-TITLE-626", activity: 6, summary: "Worker completed; the candidate was handed to landing." },
      ...Array.from({ length: 5 }, (_unused, index) => ({
        taskId: `task-newer-${index + 1}-626`,
        state: "paused_recoverable" as const,
        title: `NEWER-TITLE-${index + 1}-626`,
        activity: 4,
      })),
    ],
  }];
  const { manager, controller, execute } = await managerWithGroups(base, sourceRoot, specs);
  try {
    const groups = (controller as unknown as { groups: Map<string, { tasks: BackgroundTaskRecord[] }> }).groups;
    const tasks = groups.get(TARGET_EXECUTION)!.tasks;
    const oldest = tasks.find((task) => task.taskId === oldestTask)!;
    oldest.updatedAt = "2025-06-01T10:00:00.000Z";
    oldest.result = {
      waveId: "wave-oldest-626",
      waveRoot: join(base, "wave-oldest-626"),
      sourceRoot,
      phase: "landing",
      taskResults: [],
      landing: {
        status: "recovery_required",
        failedAtPath: "oldest.txt",
        failureReason,
        rollbackError,
        manifestPath,
      },
    };
    tasks.filter((task) => task.taskId !== oldestTask).forEach((task, index) => {
      task.updatedAt = new Date(Date.UTC(2025, 6, 1 + index)).toISOString();
    });

    // An execution-only failure: no task handle, so the snapshot keeps only the
    // bounded task window.
    const response = await execute("SubtasksWatch")("windowed-watch-recovery", { executionId: TARGET_EXECUTION, after: "30s" }, undefined, undefined, {});
    assert.equal(response.isError, true, "a group with no active tasks cannot be watched");
    const text = String(response.content[0].text);

    // The bounded snapshot really does omit the oldest task.
    assert.equal(response.details.failureScope.resolved, true);
    assert.equal(response.details.failureScope.included.tasks, 5);
    assert.equal(response.details.failureScope.omitted.tasks, 1);
    const snapshotIds: string[] = response.details.executions[0].tasks.map((task: { taskId: string }) => task.taskId);
    assert.equal(snapshotIds.length, 5);
    assert.ok(!snapshotIds.includes(oldestTask), "the older task is outside the retained task window");

    // Its CURRENT workspace-safety facts are still stated, with the source
    // workspace uncertainty they belong to.
    assert.match(text, new RegExp(`Landing recovery REQUIRED for ${oldestTask}`));
    assert.match(text, /the source workspace may be partially modified and rollback did not complete/);
    assert.match(text, /landing failed at oldest\.txt: injected old landing failure/);
    assert.match(text, new RegExp(`rollback failed: ${rollbackError.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
    assert.match(text, new RegExp(`recovery manifest: ${manifestPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
    assert.match(text, /Source workspace: unchanged_or_independently_landed\./);

    // Metadata limits are unchanged: no raw history and no nested result body is
    // smuggled into the details for the omitted task.
    const detailsJson = JSON.stringify(response.details);
    assert.ok(!detailsJson.includes(rollbackError), "the omitted task's nested result body stays out of the details");
    assert.ok(!detailsJson.includes(failureReason), "the omitted task's nested result body stays out of the details");
    for (const task of response.details.executions[0].tasks) {
      assert.equal(task.result, undefined, "nested result bodies stay omitted from the snapshot");
    }

    // Canonical records are untouched: the full landing outcome is still durable.
    const canonical = controller.inspect(TARGET_EXECUTION, oldestTask);
    assert.equal(canonical.tasks[0].result?.landing?.status, "recovery_required");
    assert.equal(canonical.tasks[0].result?.landing?.manifestPath, manifestPath);
  } finally {
    await manager.shutdown();
    await rm(base, { recursive: true, force: true });
  }
});

test("every registered Subtasks action's ordinary failure shares the same scoped contract", async () => {
  const base = await mkdtemp(join(tmpdir(), "pi-review-failure-scope-"));
  const sourceRoot = join(base, "source");
  await mkdir(sourceRoot, { recursive: true });
  // No native active-tool snapshot: SubtasksStart/SubtasksAdd then fail closed
  // after input validation at the same shared boundary, without launching work.
  const { manager, controller, execute } = await managerWithGroups(base, sourceRoot, standardSpecs(3), { omitActiveToolSnapshot: true });
  // mark_clean has no natural post-validation failure with no gate armed; inject
  // one at the controller boundary so the shared failure path is exercised.
  const originalMarkClean = controller.markClean.bind(controller);
  (controller as unknown as { markClean: () => Promise<never> }).markClean = async () => {
    throw new Error("injected mark-clean failure");
  };
  try {
    const requests: Array<{ tool: string; action: string; params: Record<string, unknown>; scoped: boolean }> = [
      { tool: "SubtasksStart", action: "start", params: { tasks: [{ title: "T", instructions: "I", acceptanceCriteria: ["A"] }] }, scoped: false },
      { tool: "SubtasksAdd", action: "add", params: { executionId: "exec-missing-626", tasks: [{ title: "T", instructions: "I", acceptanceCriteria: ["A"] }] }, scoped: false },
      { tool: "SubtasksInspect", action: "inspect", params: { executionId: TARGET_EXECUTION, taskId: "task-missing-626" }, scoped: true },
      { tool: "SubtasksWatch", action: "watch", params: { executionId: TARGET_EXECUTION, after: "30s" }, scoped: true },
      { tool: "SubtasksContinue", action: "continue", params: { executionId: TARGET_EXECUTION, taskId: TARGET_TASK, instructions: "continue" }, scoped: true },
      { tool: "SubtasksSteer", action: "steer", params: { executionId: TARGET_EXECUTION, taskId: TARGET_TASK, instructions: "change direction" }, scoped: true },
      { tool: "SubtasksInterrupt", action: "interrupt", params: { executionId: TARGET_EXECUTION, taskId: TARGET_TASK, interruptMode: "interrupt_as_failure" }, scoped: true },
      { tool: "SubtasksForceMerge", action: "force_merge", params: { executionId: "exec-research-626", taskId: "task-research-626" }, scoped: true },
      { tool: "SubtasksMarkClean", action: "mark_clean", params: {}, scoped: false },
    ];
    for (const request of requests) {
      const response = await execute(request.tool)(`all-actions-${request.tool}`, request.params, undefined, undefined, {});
      assert.equal(response.isError, true, `${request.tool} returns its explicit structured error`);
      assert.equal(typeof response.details.diagnostic, "string", `${request.tool} keeps the diagnostic`);
      assert.equal(response.details.action, request.action, `${request.tool} keeps its action key`);
      assert.ok(Array.isArray(response.details.executions), `${request.tool} keeps the executions key as an array`);
      assert.notEqual(response.details.failureScope, undefined, `${request.tool} discloses its failure scope`);
      assert.equal(response.details.failureScope.resolved, request.scoped, `${request.tool} scope resolution`);
      assert.equal(response.details.executions.length, request.scoped ? 1 : 0, `${request.tool} replays at most its own execution`);
      for (const inspection of response.details.executions) {
        if (typeof request.params.executionId === "string") {
          assert.equal(inspection.executionId, request.params.executionId, `${request.tool} replays only the requested execution`);
        }
        for (const task of inspection.tasks) {
          assert.ok(task.activity.length <= 3, `${request.tool} bounds activity rows in metadata`);
          assert.equal(task.stateHistory, undefined, `${request.tool} omits stateHistory`);
        }
      }
      const text = String(response.content[0].text);
      assert.match(text, /Recovery guidance:/, request.tool);
      assert.match(text, /Source workspace:/, request.tool);
      if (!request.scoped) assert.match(text, /No scoped durable snapshot:/, request.tool);
      assertNoUnrelatedLeaks(`${request.tool} failure`, text, JSON.stringify(response.details));
    }
  } finally {
    (controller as unknown as { markClean: typeof controller.markClean }).markClean = originalMarkClean;
    await manager.shutdown();
    await rm(base, { recursive: true, force: true });
  }
});

/** Give the target task real durable evidence artifacts (a pi session with one
 * tool call and its failed result) and bind the task's wave root to them. */
async function attachTargetEvidence(base: string, controller: BackgroundExecutionController): Promise<void> {
  const waveRoot = join(base, "wave-target-626");
  const artifactDir = join(waveRoot, "artifacts", TARGET_TASK);
  const sessionFile = join(base, "native-pi-store", `${SESSION_ID}.jsonl`);
  await mkdir(join(base, "native-pi-store"), { recursive: true });
  await mkdir(join(artifactDir, "executor", "0001"), { recursive: true });
  await writeFile(join(artifactDir, "executor", "0001", "process-result.json"), JSON.stringify({ adapter: "pi-model", code: 0, sessionId: SESSION_ID, sessionFile }));
  await writeFile(sessionFile, jsonlLines(...piSessionEntries()));
  const groups = (controller as unknown as { groups: Map<string, { tasks: BackgroundTaskRecord[] }> }).groups;
  groups.get(TARGET_EXECUTION)!.tasks[0]!.waveRoot = waveRoot;
}

test("the exact Inspect calls a scoped failure advertises are both valid registered reads", async () => {
  const base = await mkdtemp(join(tmpdir(), "pi-review-failure-scope-"));
  const sourceRoot = join(base, "source");
  await mkdir(sourceRoot, { recursive: true });
  const { manager, controller, execute } = await managerWithGroups(base, sourceRoot, standardSpecs(2));
  try {
    await attachTargetEvidence(base, controller);
    const failure = await execute("SubtasksSteer")("advertised-calls", {
      executionId: TARGET_EXECUTION,
      taskId: TARGET_TASK,
      instructions: "change direction",
    }, undefined, undefined, {});
    assert.equal(failure.isError, true);
    const text = String(failure.content[0].text);

    // The hint advertises two SEPARATE complete calls: evidence navigation is
    // mutually exclusive with offset/lines, so an additive hint would fail.
    assert.match(text, /two separate existing calls \(evidence navigation is mutually exclusive with offset\/lines\)/);
    assert.doesNotMatch(text, /add "evidence"/);
    const advertisedActivity = /"executionId": "([^"]+)", "taskId": "([^"]+)", "offset": (\d+), "lines": (\d+) \}/.exec(text);
    const advertisedEvidence = /"executionId": "([^"]+)", "taskId": "([^"]+)", "evidence": \{ "index": (\d+), "limit": (\d+) \} \}/.exec(text);
    assert.ok(advertisedActivity, "the failure names a complete activity read");
    assert.ok(advertisedEvidence, "the failure names a complete evidence read");
    const activityCall = {
      executionId: advertisedActivity![1]!,
      taskId: advertisedActivity![2]!,
      offset: Number(advertisedActivity![3]),
      lines: Number(advertisedActivity![4]),
    };
    const evidenceCall = {
      executionId: advertisedEvidence![1]!,
      taskId: advertisedEvidence![2]!,
      evidence: { index: Number(advertisedEvidence![3]), limit: Number(advertisedEvidence![4]) },
    };

    // Both advertised payloads run as registered SubtasksInspect calls.
    const activityRead = await execute("SubtasksInspect")("advertised-activity-read", activityCall, undefined, undefined, {});
    assert.equal(activityRead.isError, false, `the advertised activity read must succeed: ${String(activityRead.content?.[0]?.text)}`);
    assert.deepEqual(activityRead.details.tasks[0].activity.map((row: { sequence: number }) => row.sequence), [1, 2, 3]);
    assert.match(String(activityRead.content[0].text), new RegExp(OLD_ACTIVITY_MARKER));

    const evidenceRead = await execute("SubtasksInspect")("advertised-evidence-read", evidenceCall, undefined, undefined, {});
    assert.equal(evidenceRead.isError, false, `the advertised evidence read must succeed: ${String(evidenceRead.content?.[0]?.text)}`);
    assert.ok((evidenceRead.details.evidence.entries ?? []).length > 0, "the advertised evidence read returns real tool-call rows");
    assert.equal(evidenceRead.details.tasks[0].taskId, TARGET_TASK);

    // The combination the wording must never imply is rejected explicitly.
    const combined = await execute("SubtasksInspect")("advertised-combined", { ...activityCall, ...evidenceCall }, undefined, undefined, {});
    assert.equal(combined.isError, true);
    assert.match(String(combined.content[0].text), /mutually exclusive with offset\/lines activity paging/);
  } finally {
    await manager.shutdown();
    await rm(base, { recursive: true, force: true });
  }
});

test("#61 evidence selector failures stay concise and task-scoped beside the new scoped failures", async () => {
  const base = await mkdtemp(join(tmpdir(), "pi-review-failure-scope-"));
  const sourceRoot = join(base, "source");
  await mkdir(sourceRoot, { recursive: true });
  const { manager, controller, execute } = await managerWithGroups(base, sourceRoot, standardSpecs(2));
  try {
    // Give the target real evidence artifacts, then mistype one selector.
    await attachTargetEvidence(base, controller);

    const page = await execute("SubtasksInspect")("evidence-page", {
      executionId: TARGET_EXECUTION,
      taskId: TARGET_TASK,
      evidence: { index: 0, limit: 50 },
    }, undefined, undefined, {});
    assert.equal(page.isError, false);
    assert.ok((page.details.evidence.entries ?? []).length > 0, "the target task indexes real evidence");
    // The existing evidence route also retrieves the actual tool-call rows a
    // failure snapshot never carries.
    assert.match(JSON.stringify(page.details.evidence.entries), /TARGET-TASK-EVIDENCE-MARKER-626|bash/);

    const selectorFailure = await execute("SubtasksInspect")("evidence-selector", {
      executionId: TARGET_EXECUTION,
      taskId: TARGET_TASK,
      evidence: { entryId: "no-such-entry-626" },
    }, undefined, undefined, {});
    assert.equal(selectorFailure.isError, true);
    const text = String(selectorFailure.content[0].text);
    assert.match(text, /No evidence entry "no-such-entry-626"/);
    // Unchanged #61 contract: concise, task-scoped, no inventory, no recovery list.
    assert.equal(selectorFailure.details.executions, undefined);
    assert.equal(selectorFailure.details.recovery, undefined);
    assert.equal(selectorFailure.details.failureScope, undefined);
    assert.equal(selectorFailure.details.evidenceSelectorError, true);
    assert.ok(!text.includes("Failure snapshot:"));
    assert.ok(!text.includes("Task handles"));
    assertNoUnrelatedLeaks("evidence selector failure", text, JSON.stringify(selectorFailure.details));
  } finally {
    await manager.shutdown();
    await rm(base, { recursive: true, force: true });
  }
});

test("#191 an interrupt whose merge threw keeps its exact settlement in the scoped failure", async () => {
  const base = await mkdtemp(join(tmpdir(), "pi-review-failure-scope-"));
  const sourceRoot = join(base, "source");
  await mkdir(sourceRoot, { recursive: true });
  const mergeThrowActivity = [
    ...seededActivity(40),
    { sequence: 41, at: "2025-06-01T11:00:02.000Z", phase: "interrupt", message: "Writer quiesced. Executor interrupt acknowledged." },
    { sequence: 42, at: "2025-06-01T11:00:03.000Z", phase: "interrupt", message: "Interrupt-with-merge is attempting a mechanical checkpoint landing." },
  ];
  const mergeThrowCommands: BackgroundCommandRecord[] = [
    {
      instructionId: "merge-throw-626", action: "interrupt", actor: "model", mode: "interrupt_with_merge",
      status: "acknowledged", createdAt: "2025-06-01T11:00:00.000Z", deliveredAt: "2025-06-01T11:00:01.000Z", acknowledgedAt: "2025-06-01T11:00:02.000Z",
    },
    {
      instructionId: "merge-throw-626-force-merge", action: "force_merge", actor: "model", mode: "interrupt_with_merge",
      status: "failed", createdAt: "2025-06-01T11:00:02.000Z", error: "injected conflict materialization failure",
    },
  ];
  const specs: GroupSpec[] = [
    {
      executionId: TARGET_EXECUTION,
      tasks: [{ taskId: TARGET_TASK, state: "conflicted", title: "TARGET-TITLE-626", activity: 0, summary: "TARGET-MERGE-THROW-OUTCOME-626" }],
    },
    {
      executionId: "exec-unrelated-a626-0",
      tasks: [{ taskId: "task-unrelated-a1-0", state: "interrupted", title: "UNRELATED-TITLE-A626-0", activity: 20 }],
    },
  ];
  const { manager, controller, execute } = await managerWithGroups(base, sourceRoot, specs);
  try {
    // Seed the durable record with this request's own command and activity, so
    // the settlement is computed from the real owning record.
    const group = (controller as unknown as { groups: Map<string, { tasks: BackgroundTaskRecord[] }> }).groups;
    const seeded = group.get(TARGET_EXECUTION)!.tasks[0]!;
    seeded.commands = mergeThrowCommands;
    seeded.activity = mergeThrowActivity;
    seeded.nextActivitySequence = mergeThrowActivity.length + 1;

    // The merge throws after the stop was acknowledged (#191's shape).
    const originalInterrupt = controller.interrupt.bind(controller);
    (controller as unknown as { interrupt: () => Promise<never> }).interrupt = async () => {
      throw new Error("injected merge failure");
    };
    try {
      const response = await execute("SubtasksInterrupt")("merge-throw", {
        executionId: TARGET_EXECUTION,
        taskId: TARGET_TASK,
        interruptMode: "interrupt_with_merge",
        instructionId: "merge-throw-626",
      }, undefined, undefined, {});
      assert.equal(response.isError, true);
      const text = String(response.content[0].text);
      assert.match(text, /SubtasksInterrupt failed: injected merge failure/);
      assert.match(text, /Interrupt settlement for this request/);
      assert.match(text, /Stop: acknowledged\./);
      assert.match(text, /Merge: the mechanical merge failed: injected conflict materialization failure/);
      assert.match(text, /TARGET-MERGE-THROW-OUTCOME-626/);
      assert.match(text, new RegExp(`Failure snapshot: execution ${TARGET_EXECUTION} · task ${TARGET_TASK}`));
      assertNoUnrelatedLeaks("merge-throw interrupt failure", text, JSON.stringify(response.details));
      // The settlement saw the owning record's interrupt activity, not a
      // projected tail: the current state and outcome are still truthful.
      assert.equal(response.details.executions[0].tasks[0].state, "conflicted");
      assert.match(text, /Writer quiesced/);
    } finally {
      (controller as unknown as { interrupt: typeof controller.interrupt }).interrupt = originalInterrupt;
    }

    // A request with no recorded command reports the rejected stop, never a
    // claimed stop: the real controller refuses with no live writer.
    const rejected = await execute("SubtasksInterrupt")("no-writer", {
      executionId: TARGET_EXECUTION,
      taskId: TARGET_TASK,
      interruptMode: "interrupt_with_merge",
      instructionId: "never-recorded-626",
    }, undefined, undefined, {});
    assert.equal(rejected.isError, true);
    assert.match(String(rejected.content[0].text), /Interrupt settlement for this request/);
    assert.match(String(rejected.content[0].text), /not recorded for the task/);
    assert.match(String(rejected.content[0].text), /no merge was attempted/);
  } finally {
    await manager.shutdown();
    await rm(base, { recursive: true, force: true });
  }
});

test("successful results keep their existing full shapes and are untouched by the failure projection", async () => {
  const base = await mkdtemp(join(tmpdir(), "pi-review-failure-scope-"));
  const sourceRoot = join(base, "source");
  await mkdir(sourceRoot, { recursive: true });
  const { manager, execute } = await managerWithGroups(base, sourceRoot, standardSpecs(2));
  try {
    const inspect = await execute("SubtasksInspect")("success-inspect", { executionId: TARGET_EXECUTION, taskId: TARGET_TASK }, undefined, undefined, {});
    assert.equal(inspect.isError, false);
    assert.equal(inspect.details.action, "inspect");
    assert.equal(inspect.details.failureScope, undefined);
    assert.equal(inspect.details.executionId, TARGET_EXECUTION);
    assert.equal(inspect.details.tasks.length, 1);
    assert.equal(inspect.details.tasks[0].activity.length, 120);
    assert.ok(Array.isArray(inspect.details.tasks[0].stateHistory));
    assert.notEqual(inspect.details.tasks[0].timingAccumulator, undefined);
    assert.notEqual(inspect.details.tasks[0].reviewStatus, undefined);
    assert.notEqual(inspect.details.scheduling, undefined);
    assert.equal(inspect.details.archivedCount, 0);
    assert.equal(inspect.details.historicalCount, 1);
    assert.match(String(inspect.content[0].text), /Execution diagnostics: revision \d+; peak concurrency \d+\./);
    assert.match(String(inspect.content[0].text), /timing \(ms\): total \d+; queued \d+; capture \d+; execution \d+; review \d+; landing \d+/);

    const markClean = await execute("SubtasksMarkClean")("success-mark-clean", {}, undefined, undefined, {});
    assert.equal(markClean.isError, false);
    assert.match(String(markClean.content[0].text), /No workspace conflict gate is active\./);
    assert.equal(markClean.details.failureScope, undefined);
  } finally {
    await manager.shutdown();
    await rm(base, { recursive: true, force: true });
  }
});
