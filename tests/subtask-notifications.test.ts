import assert from "node:assert/strict";
import test from "node:test";
import { normalizeConfig, type ReviewGateConfig } from "../src/config";
import {
  buildWakeFailureDiagnostic,
  boundDiagnosticText,
  capNotificationText,
  deliveryForLane,
  fitWakeFailureDiagnostic,
  completionNotificationGuidanceLine,
  formatExecutionEvent,
  formatResearchCompletion,
  formatWakeFailureDiagnostic,
  formatWakeFailurePreamble,
  formatWatchEvent,
  interactiveWakeStateList,
  isActionableWakeKind,
  isQuietSuppressedWake,
  isTurnWake,
  lifecycleWakeGuidanceLine,
  noActionResponseNotice,
  NOISY_INTERACTIVE_WAKE_STATES,
  notificationLane,
  notificationModeContractProse,
  passiveStateList,
  quietTurnWakeStateList,
  QUIET_TURN_WAKE_STATE_LABELS,
  stateTransitionNotice,
  subtaskNotificationMode,
  terminalWakeGuidanceLine,
  watchCheckpointDelivery,
  TRUNCATION_MARKER,
  WAKE_FAILURE_JSON_CAP,
  WAKE_FAILURE_NOTIFICATION_CAP,
  WAKE_FAILURE_MAX_ACTIVITY_EVENTS,
  WAKE_FAILURE_MAX_CONFLICT_PATHS,
  type SubtaskNotificationMode,
  type SubtaskWakeKind,
  type WakeFailureDiagnostic,
} from "../src/execution/subtask-notifications";
import * as controllerModule from "../src/execution/background-controller";
import { ExecutionToolManager } from "../src/execution/tool";
import { createState } from "../src/state";

// ── Fixtures ─────────────────────────────────────────────────────────────────

function emptyConfig(mode?: "quiet" | "noisy"): ReviewGateConfig {
  return normalizeConfig({
    enabled: true,
    review: { activeReviewers: [] },
    execution: mode ? { subtaskNotifications: mode } : undefined,
  });
}

function fixtureTask(overrides: Record<string, unknown> = {}): any {
  return {
    taskId: "task-1",
    generation: 0,
    state: "landed",
    createdAt: "2024-01-01T00:00:00.000Z",
    updatedAt: "2024-01-01T00:01:00.000Z",
    definition: { title: "First task", instructions: "do it", acceptanceCriteria: ["done"] },
    activity: [],
    commands: [],
    ...overrides,
  };
}

function fixtureGroup(overrides: Record<string, unknown> = {}): any {
  return {
    executionId: "exec-1",
    kind: "execute",
    revision: 5,
    cwd: "/tmp/exec-1",
    createdAt: "2024-01-01T00:00:00.000Z",
    updatedAt: "2024-01-01T00:01:00.000Z",
    tasks: [fixtureTask()],
    ...overrides,
  };
}

// ── Wake policy: quiet/noisy eligibility ─────────────────────────────────────

const WAKE_KINDS: SubtaskWakeKind[] = ["completion", "failure", "state"];

test("quiet mode keeps ordinary state transitions passive while terminal events stay actionable", () => {
  assert.equal(isQuietSuppressedWake("state", "quiet"), true, "quiet suppresses state transitions");
  for (const kind of ["completion", "failure"] as const) {
    assert.equal(isQuietSuppressedWake(kind, "quiet"), false, `${kind} wakes in quiet mode`);
    assert.equal(isTurnWake(kind, "quiet"), true);
  }
  for (const kind of WAKE_KINDS) {
    assert.equal(isTurnWake(kind, "noisy"), true, `${kind} wakes in noisy mode`);
    assert.equal(isQuietSuppressedWake(kind, "noisy"), false);
  }
});

test("completion, failure, conflict, and recovery-required events are actionable in both modes", () => {
  assert.equal(isActionableWakeKind("completion"), true);
  assert.equal(isActionableWakeKind("failure"), true, "failure/conflict/recovery-required is actionable");
  assert.equal(isActionableWakeKind("state"), false, "state transitions are not terminal-actionable");
});

test("notification mode resolution falls back to quiet and honors explicit configuration", () => {
  assert.equal(subtaskNotificationMode(emptyConfig()), "quiet");
  assert.equal(subtaskNotificationMode(emptyConfig("quiet")), "quiet");
  assert.equal(subtaskNotificationMode(emptyConfig("noisy")), "noisy");
});

// ── Delivery lanes and trigger-turn behavior ─────────────────────────────────

test("state and failure wakes deliver immediately; completion follows up; every wake triggers a turn", () => {
  assert.equal(notificationLane("state"), "now");
  assert.equal(notificationLane("failure"), "now");
  assert.equal(notificationLane("completion"), "soon");
  assert.deepEqual(deliveryForLane("now"), { deliverAs: "steer", triggerTurn: true });
  assert.deepEqual(deliveryForLane("soon"), { deliverAs: "followUp", triggerTurn: true });
  assert.deepEqual(watchCheckpointDelivery(), { deliverAs: "followUp", triggerTurn: true }, "watch checkpoints follow up with a turn and never steer");
});

// ── Model-facing lifecycle contract prose ────────────────────────────────────

test("shared lifecycle guidance is derived from the wake state tables", () => {
  const line = lifecycleWakeGuidanceLine();
  assert.ok(line.includes(`each ${quietTurnWakeStateList()}, or other recovery-required task`));
  assert.ok(line.includes("each LANDED, REPORTED, FAILED, CONFLICTED, or other recovery-required task"), "quiet guidance covers research REPORTED completion alongside execute LANDED");
  assert.ok(line.includes("Noisy mode additionally triggers RUNNING (steerable) and REVIEWING (steering can supersede review)."));
  assert.ok(line.includes(`${passiveStateList()} remain visible in SubtasksInspect and /subtasks-view but do not trigger turns.`));
  assert.equal(passiveStateList(), "CAPTURING, ACCEPTED, WAITING_TO_LAND, and LANDING");
  assert.ok(line.includes("DO NOT POLL for task-state changes"));
  assert.equal(quietTurnWakeStateList(), QUIET_TURN_WAKE_STATE_LABELS.join(", "));
  assert.equal(quietTurnWakeStateList(), "LANDED, REPORTED, FAILED, CONFLICTED");
  assert.equal(interactiveWakeStateList(), "RUNNING and REVIEWING");
});

test("completion guidance is kind-neutral and covers reported research completion", () => {
  const line = completionNotificationGuidanceLine();
  assert.ok(line.includes("Every task completion (an execute task landing or a research task reporting) triggers a notification"));
  assert.ok(line.includes("lists every sibling that has not completed, even in quiet mode"));
  assert.ok(line.includes("Do not verify aggregate outputs until the execution-complete notification."));
  assert.ok(!line.includes("Every task landing triggers"), "guidance no longer names only execute landings");
});

test("terminal wake guidance separates completion/failure/conflict turns from noisy-only transitions", () => {
  const line = terminalWakeGuidanceLine();
  assert.ok(line.includes("Each task completion, failure, and critical conflict triggers a model notification."));
  assert.ok(line.includes("Ordinary running/reviewing transitions do so only in noisy mode."));
  assert.ok(line.includes("avoid tight repetitive polling"));
});

test("notification mode prose is derived from the policy state lists", () => {
  const quiet = notificationModeContractProse("quiet", "lands");
  assert.equal(
    quiet,
    "Quiet notification mode is active: ordinary RUNNING and REVIEWING transitions remain passive UI telemetry. "
    + "Every task still triggers a turn when it lands, fails, conflicts, or requires recovery, and completion events "
    + "identify siblings that remain active.",
  );
  assert.ok(quiet.includes(interactiveWakeStateList()));
  const noisy = notificationModeContractProse("noisy", "reports");
  assert.equal(
    noisy,
    "Noisy notification mode is active: RUNNING and REVIEWING transitions trigger turns in addition to every "
    + "successful, failed, conflicted, or recovery-required task.",
  );
});

// ── No-action acknowledgement wording (tested separately from transitions) ───

test("no-action acknowledgement wording stays separate from transition selection", () => {
  const notice = noActionResponseNotice({ taskId: "task-9", state: "reviewing" } as any);
  assert.ok(notice.startsWith("NO TOOL ACTION IS NECESSARY"));
  assert.ok(notice.includes("This notification triggered a harness turn, so do not return an empty response."));
  assert.ok(notice.includes("No action for task-9 at REVIEWING."));
  assert.ok(notice.includes("Do not call inspect merely to acknowledge this event."));
  assert.ok(!notice.includes("changed state"), "acknowledgement wording is not transition prose");
});

// ── Transition selection ─────────────────────────────────────────────────────

test("only steerable interactive transitions produce notice text; passive states never do", () => {
  const task = fixtureTask({ taskId: "task-2", state: "running" });
  assert.match(stateTransitionNotice(task, "capturing", "running")!, /changed state: CAPTURING -> RUNNING\. The task is ACTIVE\./);
  assert.match(stateTransitionNotice(fixtureTask({ state: "reviewing" }), "running", "reviewing")!, /changed state: RUNNING -> REVIEWING\. The task is REVIEWING\./);
  // Passive progress states never produce notification text.
  for (const [previous, next] of [
    ["queued", "capturing"],
    ["waiting_to_land", "accepted"],
    ["accepted", "waiting_to_land"],
    ["waiting_to_land", "landing"],
  ] as const) {
    assert.equal(stateTransitionNotice(fixtureTask({ state: next }), previous, next), undefined, `${previous} -> ${next} is passive`);
  }
  assert.equal(stateTransitionNotice(fixtureTask(), "landed", "landed"), undefined, "same-state transitions are not notified");
});

// ── Execution/research event formatting ──────────────────────────────────────

test("formatExecutionEvent reports full completion with top-off opportunity and no no-action wording", () => {
  const group = fixtureGroup({
    tasks: [fixtureTask({ state: "landed" }), fixtureTask({ taskId: "task-2", state: "landed" })],
  });
  const text = formatExecutionEvent(group, group.tasks[0], "completion", "Task task-1 landed.", {
    estimatedImmediatelyAvailableSlots: 3,
    globallyDispatchPending: 1,
  });
  assert.ok(text.includes("Top-off opportunity: up to 2 additional task(s) may be submitted with SubtasksAdd if planned work remains."));
  assert.ok(text.includes("Execution exec-1 COMPLETE: 2/2 tasks landed."));
  assert.ok(text.includes("aggregate verification is now appropriate."));
  assert.ok(!text.includes("NO TOOL ACTION IS NECESSARY"), "completion events carry no no-action acknowledgement");
  assert.ok(!text.includes("Execution revision:"), "completion omits the execution revision line");
});

test("formatExecutionEvent reports partial completions without overclaiming group success", () => {
  const group = fixtureGroup({
    tasks: [
      fixtureTask({ state: "landed" }),
      fixtureTask({ taskId: "task-2", state: "running", definition: { title: "Second task", instructions: "work", acceptanceCriteria: ["done"] } }),
    ],
  });
  const text = formatExecutionEvent(group, group.tasks[0], "completion", "Task task-1 landed.", undefined);
  assert.ok(text.includes("Execution exec-1 IN PROGRESS: 1/2 landed; 1 not landed."));
  assert.ok(text.includes("This is a partial task completion, not completion of the whole group."));
  assert.ok(text.includes("Tasks not yet landed:"));
  assert.ok(text.includes("- task-2 · Second task · running"));
});

test("formatExecutionEvent keeps failure wording truthful for conflicted and incomplete groups", () => {
  const tasks = [
    fixtureTask({ state: "landed" }),
    fixtureTask({ taskId: "task-2", state: "conflicted", definition: { title: "Second task", instructions: "work", acceptanceCriteria: ["done"] } }),
  ];
  const group = fixtureGroup({ tasks });
  const text = formatExecutionEvent(group, tasks[1], "failure", "Task task-2 failed: boom", undefined);
  assert.ok(text.includes("Task task-2 failed: boom"));
  assert.ok(text.includes("Execution revision: 5"));
  assert.ok(text.includes("The whole execution is not successfully complete. Use the task handles and states below to recover deliberately."));
  assert.ok(text.includes("Execution exec-1 INCOMPLETE: 1/2 landed; 1 not landed."));
  assert.ok(text.includes("- task-2 · Second task · conflicted"));
});

test("formatExecutionEvent appends the no-action acknowledgement only to state wakes", () => {
  const group = fixtureGroup();
  const stateText = formatExecutionEvent(group, group.tasks[0], "state", "Task task-1 changed state: QUEUED -> RUNNING.", undefined);
  assert.ok(stateText.includes("NO TOOL ACTION IS NECESSARY"));
  assert.ok(stateText.includes("This is an informational state update; rely on the separate completion or failure event for the execution outcome."));
  for (const kind of ["completion", "failure"] as const) {
    const text = formatExecutionEvent(group, group.tasks[0], kind, "content", undefined);
    assert.ok(!text.includes("NO TOOL ACTION IS NECESSARY"), `${kind} events never carry the no-action acknowledgement`);
  }
});

test("formatExecutionEvent lists landed paths once and formats research groups as reported", () => {
  const task = fixtureTask({
    state: "reported",
    result: {
      landing: { appliedPaths: ["a.txt"], alreadyAppliedPaths: ["a.txt", "b.txt"] },
    },
  });
  const group = fixtureGroup({ kind: "research", tasks: [task] });
  const text = formatExecutionEvent(group, task, "completion", "Research done.", undefined);
  assert.ok(text.includes("Landed paths: a.txt, b.txt"));
  assert.ok(text.includes("Research exec-1 COMPLETE: 1/1 tasks reported."));
  assert.ok(text.includes("Main was not modified by this research group."));
});

// ── Research completion formatting ───────────────────────────────────────────

test("formatResearchCompletion inlines short reports verbatim", () => {
  const text = formatResearchCompletion("task-r", "  findings\n", "/tmp/report.md");
  assert.ok(text.includes("Research task task-r completed without workspace changes."));
  assert.ok(text.includes("Full report: /tmp/report.md"));
  assert.ok(text.includes("Complete report:\nfindings"));
});

test("formatResearchCompletion caps long reports without excerpts and surfaces a declared summary", () => {
  const long = `${"x".repeat(1000)}\nSummary: bounded summary line\n${"y".repeat(2000)}`;
  const withSummary = formatResearchCompletion("task-r", long, "/tmp/report.md");
  assert.ok(withSummary.includes("The report is too long to inline completely; no partial report excerpt is included."));
  assert.ok(withSummary.includes("Summary: bounded summary line"));
  assert.ok(!withSummary.includes("x".repeat(100)), "no report excerpt leaks");
  const withoutSummary = formatResearchCompletion("task-r", "z".repeat(1000), "/tmp/report.md");
  assert.ok(withoutSummary.includes("No bounded standalone summary was supplied; read the full report when its details are needed for synthesis."));
});

// ── Watch-checkpoint formatting ──────────────────────────────────────────────

test("formatWatchEvent renders a deliberate checkpoint for active tasks only", () => {
  const now = Date.now();
  const config = emptyConfig();
  const inspection = {
    executionId: "exec-w",
    kind: "execute" as const,
    revision: 3,
    tasks: [
      {
        taskId: "task-a",
        definition: { title: "Active" },
        state: "running" as const,
        updatedAt: new Date(now - 60_000).toISOString(),
        executorEntryId: "entry-1",
        activity: [{ sequence: 1, at: new Date(now - 30_000).toISOString(), phase: "executing", message: "working" }],
        timing: { queueMs: 0, captureMs: 0, executionMs: 65_000, reviewMs: 0, landingMs: 0, totalMs: 65_000 },
        liveControl: { steer: true },
      },
      {
        taskId: "task-b",
        definition: { title: "Settled" },
        state: "landed" as const,
        updatedAt: new Date(now - 60_000).toISOString(),
        activity: [],
        timing: { queueMs: 0, captureMs: 0, executionMs: 0, reviewMs: 0, landingMs: 0, totalMs: 0 },
      },
    ],
  };
  const text = formatWatchEvent([inspection], config);
  assert.ok(text.startsWith("[pi-review-subtask-watch]"));
  assert.ok(text.includes("The requested one-shot checkpoint for execution exec-w is due while work remains active."));
  assert.ok(text.includes("This is a deliberate checkpoint, not a completion or failure event."));
  assert.ok(text.includes("1 active task(s), revision 3."));
  assert.ok(text.includes("elapsed 1m5s;"));
  assert.ok(!text.includes("Settled"), "settled tasks are omitted from checkpoint text");
});

// ── L8 curated bounded failure diagnostic ────────────────────────────────────

test("boundDiagnosticText caps JSON-encoded content with a visible truncation marker", () => {
  const short = boundDiagnosticText("hello world", 100);
  assert.equal(short, "hello world");
  const long = boundDiagnosticText("a".repeat(5_000), 200);
  assert.ok(long!.length <= 200 + TRUNCATION_MARKER.length, "the raw text respects the encoded budget");
  assert.ok(long!.endsWith(TRUNCATION_MARKER));
  // Escape-amplification: control characters expand during JSON encoding, so
  // the encoded budget, not the raw length, governs the cap.
  const escapes = boundDiagnosticText("\u0000".repeat(5_000), 200);
  assert.ok(JSON.stringify(escapes).length - 2 <= 200 + TRUNCATION_MARKER.length);
  assert.equal(boundDiagnosticText(undefined, 100), undefined);
});

test("fitWakeFailureDiagnostic sheds activity entries until the serialized diagnostic fits the JSON cap", () => {
  const diagnostic: WakeFailureDiagnostic = {
    executionId: "exec-1",
    kind: "execute",
    revision: 1,
    taskId: "task-1",
    taskState: "failed",
    message: "m".repeat(500),
    groupSummary: { taskCount: 1, settled: 0, active: 0 },
    recovery: {
      hasDurableBundle: true,
      suggestedActions: ["SubtasksContinue (executionId exec-1, taskId task-1) to resume from the durable checkpoint"],
    },
    title: "t",
    error: "e".repeat(800),
    activity: Array.from({ length: WAKE_FAILURE_MAX_ACTIVITY_EVENTS }, (_unused, index) => ({
      sequence: index + 1,
      phase: "p",
      message: "a".repeat(2_000),
    })),
  };
  const fitted = fitWakeFailureDiagnostic(diagnostic);
  assert.ok(fitted.activity.length < WAKE_FAILURE_MAX_ACTIVITY_EVENTS, "trailing activity was shed");
  assert.ok(JSON.stringify(fitted, null, 2).length <= WAKE_FAILURE_JSON_CAP);
  assert.doesNotThrow(() => JSON.parse(formatWakeFailureDiagnostic(fitted)), "the rendered diagnostic stays parseable JSON");
  // Recovery actions survive activity shedding.
  assert.ok(fitted.recovery.suggestedActions.length > 0);
});

test("buildWakeFailureDiagnostic is curated, recovery-complete, and excludes task content", () => {
  const live = fixtureTask({
    state: "failed",
    summary: "s".repeat(1_000),
    error: "e".repeat(2_000),
    executorEntryId: "entry-7",
    bundle: {
      version: 1,
      operationId: "op-1",
      waveId: "wave-1",
      taskId: "task-1",
      waveRoot: "/tmp/wave-root",
      expectedRevision: 4,
    },
    activity: Array.from({ length: 40 }, (_unused, index) => ({
      sequence: index + 1,
      at: "2024-01-01T00:00:00.000Z",
      phase: "executor",
      message: "a".repeat(500),
    })),
  });
  const group = fixtureGroup({ tasks: [live] });
  const diagnostic = buildWakeFailureDiagnostic({
    group,
    task: live,
    content: "Task task-1 failed: boom",
    conflictGate: {
      paths: Array.from({ length: 20 }, (_unused, index) => `conflict-${index}.txt`),
      manifestPath: "/tmp/conflict-manifest.json",
      reason: "Forced merge materialized conflicts.",
    },
  });
  // Curated handles and state only.
  assert.equal(diagnostic.executionId, "exec-1");
  assert.equal(diagnostic.taskId, "task-1");
  assert.equal(diagnostic.taskState, "failed");
  assert.equal(diagnostic.recovery.hasDurableBundle, true);
  assert.equal(diagnostic.recovery.bundleWaveRoot, "/tmp/wave-root");
  // Bounded counts, arrays, and fields.
  assert.ok(JSON.stringify(diagnostic).length <= WAKE_FAILURE_JSON_CAP);
  assert.ok(diagnostic.activity.length <= WAKE_FAILURE_MAX_ACTIVITY_EVENTS);
  assert.equal(diagnostic.recovery.conflictGate!.paths.length, WAKE_FAILURE_MAX_CONFLICT_PATHS);
  assert.ok(diagnostic.message.length <= 600 + TRUNCATION_MARKER.length);
  // Task instructions/acceptance criteria/definition content never appear.
  const serialized = JSON.stringify(diagnostic);
  assert.ok(!serialized.includes("do it"), "instructions are excluded");
  assert.ok(!/"definition"/.test(serialized));
  assert.ok(!/"commands"/.test(serialized));
  assert.ok(!/"result"/.test(serialized));
  // Recovery actions are complete and parseable, including conflict recovery.
  const actions = diagnostic.recovery.suggestedActions.join("\n");
  assert.ok(actions.includes("SubtasksInspect"));
  assert.ok(actions.includes("SubtasksMarkClean"));
  assert.ok(actions.includes("SubtasksContinue"));
  assert.ok(actions.includes("SubtasksForceMerge"));
  assert.ok(actions.includes("SubtasksInterrupt"));
  assert.ok(actions.includes("conflict-manifest.json"));
  for (const action of diagnostic.recovery.suggestedActions) {
    assert.ok(action.length <= 600 + TRUNCATION_MARKER.length, "every recovery action is field-bounded");
  }
  // Research groups use reported success accounting and never force-merge.
  const researchLive = fixtureTask({
    state: "failed",
    summary: "s".repeat(1_000),
    error: "e".repeat(2_000),
    activity: [],
  });
  const researchGroup = fixtureGroup({ kind: "research", tasks: [researchLive] });
  const researchDiagnostic = buildWakeFailureDiagnostic({ group: researchGroup, task: researchLive, content: "stopped" });
  assert.ok(researchDiagnostic.recovery.suggestedActions.join("\n").includes("SubtasksAdd if its outcome is still needed"));
  assert.ok(!researchDiagnostic.recovery.suggestedActions.join("\n").includes("SubtasksForceMerge"), "research tasks are never force-merged");
});

test("wake failure preamble and notification cap keep the delivered text bounded and truthful", () => {
  const diagnostic = buildWakeFailureDiagnostic({
    group: fixtureGroup({ tasks: [fixtureTask({ state: "conflicted" })] }),
    task: fixtureTask({ state: "conflicted", error: "conflict markers present" }),
    content: "conflicted",
  });
  const preamble = formatWakeFailurePreamble(diagnostic);
  assert.match(preamble, /requires recovery attention at state CONFLICTED in execute execution exec-1 \(revision 5\)\./);
  assert.match(preamble, /Execution progress: 0\/1 task\(s\) landed, 0 active\./);
  const rendered = formatWakeFailureDiagnostic(diagnostic);
  assert.doesNotThrow(() => JSON.parse(rendered));
  const capped = capNotificationText(`${preamble}\n\nFailure recovery diagnostic:\n${rendered}`, WAKE_FAILURE_NOTIFICATION_CAP);
  assert.ok(capped.length <= WAKE_FAILURE_NOTIFICATION_CAP);
  const oversized = capNotificationText("x".repeat(WAKE_FAILURE_NOTIFICATION_CAP + 1_000), WAKE_FAILURE_NOTIFICATION_CAP);
  assert.ok(oversized.length === WAKE_FAILURE_NOTIFICATION_CAP);
  assert.ok(oversized.endsWith(TRUNCATION_MARKER));
});

// ── Controller / tool regressions ────────────────────────────────────────────

test("background-controller re-exports the shared watch formatter (source compatibility)", () => {
  assert.equal(controllerModule.formatWatchEvent, formatWatchEvent);
});

test("SubtasksStart derives its notification contract prose from the shared policy", async () => {
  const registered: Array<Record<string, any>> = [];
  const mkManager = (mode: "quiet" | "noisy" | undefined) => {
    const config = normalizeConfig({
      enabled: true,
      review: { activeReviewers: [] },
      externalAgents: [{
        id: "fake",
        adapter: "run-as-binary",
        command: process.execPath,
        execution: { protocol: "pi-review-executor-jsonl-v1" as const },
      }],
      execution: {
        activeExecutor: { source: "external" as const, id: "fake" },
        ...(mode ? { subtaskNotifications: mode } : {}),
      },
    });
    const manager = new ExecutionToolManager({
      pi: { registerTool: (tool: Record<string, any>) => registered.push(tool), getActiveTools: () => ["read", "bash"] },
      config,
      state: createState(),
      cwd: () => process.cwd(),
    });
    manager.sync();
    return manager;
  };

  // Registered guidance is the shared derived prose.
  const manager = mkManager(undefined);
  const start = registered.find((tool) => tool.name === "SubtasksStart");
  assert.ok(start, "SubtasksStart registered");
  assert.ok(start.promptGuidelines.includes(lifecycleWakeGuidanceLine()), "guidance prose is the shared derived line");
  assert.ok(start.promptGuidelines.includes(terminalWakeGuidanceLine()));

  const execute = start.execute as (id: string, params: unknown, signal?: unknown, update?: unknown, ctx?: unknown) => Promise<Record<string, any>>;

  // Quiet (default) prose on the start result.
  const quietResult = await execute("quiet-1", {
    tasks: [{ title: "Work", instructions: "work", acceptanceCriteria: ["done"] }],
  }, undefined, undefined, {});
  assert.ok(quietResult.content[0].text.includes(notificationModeContractProse("quiet", "lands")));
  await manager.shutdown();

  // Noisy prose for an explicitly noisy configuration.
  registered.length = 0;
  const noisyManager = mkManager("noisy");
  const noisyStart = registered.find((tool) => tool.name === "SubtasksStart")!;
  const noisyExecute = noisyStart.execute as (id: string, params: unknown, signal?: unknown, update?: unknown, ctx?: unknown) => Promise<Record<string, any>>;
  const noisyResult = await noisyExecute("noisy-1", {
    tasks: [{ title: "Work", instructions: "work", acceptanceCriteria: ["done"] }],
  }, undefined, undefined, {});
  assert.ok(noisyResult.content[0].text.includes(notificationModeContractProse("noisy", "lands")));
  assert.ok(!noisyResult.content[0].text.includes("Quiet notification mode is active"));
  await noisyManager.shutdown();
});