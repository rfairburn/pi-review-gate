import assert from "node:assert/strict";
import { access, chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  BackgroundExecutionController,
} from "../src/execution/background-controller";
import type { BackgroundConflictGate, BackgroundExecutionGroup, BackgroundInspection, BackgroundTaskRecord, BackgroundWatchSubscription } from "../src/execution/background-controller";
import { normalizeConfig } from "../src/config";
import { createState } from "../src/state";
import {
  SubtaskEventMessage,
  completionEvents,
  failureEvents,
  initGitRepo,
  renderWidget,
  setupInterruptedMergeTask,
  subtaskEvents,
  waitFor,
  waitForAsync,
  watchEvents,
} from "./helpers/background-controller-fixtures";

// ── #117: tool-result-confirmed completion notification deduplication ────────


test("noisy subtask notifications wake the orchestrator when active execution enters review", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-review-background-review-state-"));
  let controller: BackgroundExecutionController | undefined;
  try {
    await initGitRepo(root);
    const executor = join(root, "executor.cjs");
    await writeFile(executor, [
      "const fs=require('node:fs');",
      "fs.writeFileSync('reviewed.txt','ready\\n');",
      "console.log(JSON.stringify({type:'session',sessionId:process.env.PI_REVIEW_EXECUTOR_SESSION_ID||'review-state-session'}));",
      "console.log(JSON.stringify({type:'assistant',text:'done'}));",
    ].join("\n"), "utf8");
    const config = normalizeConfig({
enabled: true,
externalAgents: {
  "fake": {
    adapter: "run-as-binary",
    command: process.execPath,
    execution: { protocol: "pi-review-executor-jsonl-v1", args: [executor] }
  },
  "passing": {
    adapter: "generic-cli",
    command: process.execPath,
    args: [],
    review: {
      args: ["-e", "process.stdin.resume();process.stdin.on('end',()=>setTimeout(()=>process.stdout.write(JSON.stringify({verdict:'pass',summary:'ok',findings:[]})),100))"],
      timeoutMs: 5000,
    }
  }
},
execution: {
        workerResources: { "default": { selection: { source: "external", id: "fake" }, maxConcurrent: 1 } },
          routes: { execute: [{ resourceId: "default" }], research: [] },
        maxWorkers: 1,
        subtaskNotifications: "noisy",
      },
review: { activeReviewers: [
        { source: "external", id: "passing" }
      ] },
    });
    const messages: string[] = [];
    const widgets: unknown[] = [];
    controller = new BackgroundExecutionController({
      pi: { sendMessage: (message: { content: string }) => messages.push(message.content) },
      config,
      state: createState(),
      cwd: () => root,
    });
    await controller.toggleExpandedView({
      ui: { setWidget: (_key: string, content: unknown) => widgets.push(content) },
    });
    const started = await controller.start([{
      title: "review transition",
      instructions: "write reviewed.txt",
      acceptanceCriteria: ["reviewed.txt exists"],
    }]);
    await waitFor(() => controller!.inspect(started.executionId).tasks[0]?.state === "landed", 30_000);
    assert.ok(messages.some((message) => /CAPTURING -> RUNNING.*task is ACTIVE/s.test(message)));
    assert.ok(messages.some((message) => /(?:CAPTURING|RUNNING) -> REVIEWING.*task is REVIEWING/s.test(message)));
    assert.ok(messages.some((message) => /NO TOOL ACTION IS NECESSARY/.test(message)));
    assert.ok(messages.some((message) => new RegExp(`No action for ${started.tasks[0]!.taskId} at (?:RUNNING|REVIEWING)`).test(message)));
    assert.ok(messages.every((message) => !/-> (?:CAPTURING|ACCEPTED|WAITING_TO_LAND|LANDING)/.test(message)));
    assert.ok(messages.every((message) => !/interaction reported a failure/.test(message)));
    const inspection = controller.inspect(started.executionId);
    assert.deepEqual(inspection.tasks[0]?.reviewStatus?.reviewers, ["passing"]);
    assert.doesNotMatch(renderWidget(widgets.at(-1)).join("\n"), /reviewers passing \(accepted\)/, "inactive landed tasks leave the active summary");
    assert.ok(widgets.some((content) => /passing (?:started|finished)/.test(renderWidget(content).join("\n"))));
  } finally {
    await controller?.shutdown().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

const WAKE_FAILURE_SECRET_SENTINEL = "WAKE_FAILURE_SECRET_SENTINEL_9f2b";
const WAKE_FAILURE_ERROR_SENTINEL = "WAKE_FAILURE_ERROR_SENTINEL_start";

/** Harness with a deliberately unresponsive executor so task state can be injected deterministically. */
async function setupBlockingFailureHarness(options: { notifications: "quiet" | "noisy" }): Promise<{
  root: string;
  controller: BackgroundExecutionController;
  started: BackgroundInspection;
  messages: string[];
  sentMessages: Array<{ content: string; details?: { diagnostic?: unknown } }>;
  internals: {
    groups: Map<string, BackgroundExecutionGroup>;
    handleLaunchRejection: (group: BackgroundExecutionGroup, task: BackgroundTaskRecord, error: unknown) => Promise<void>;
    wake: (task: BackgroundTaskRecord, kind: "completion" | "failure" | "state", content: string, eventSnapshot?: unknown) => Promise<void>;
    setConflictGate: (gate: BackgroundConflictGate) => void;
  };
  cleanup: () => Promise<void>;
}> {
  const root = await mkdtemp(join(tmpdir(), "pi-review-background-wake-diag-"));
  let controller: BackgroundExecutionController | undefined;
  try {
    await initGitRepo(root);
    const executor = join(root, "blocking-executor.cjs");
    await writeFile(executor, [
      "#!/usr/bin/env node",
      "process.stdin.resume();",
    ].join("\n"), "utf8");
    await chmod(executor, 0o755);
    const config = normalizeConfig({
      enabled: true,
      review: { activeReviewers: [] },
      externalAgents: {
        "blocking-fake": {
          adapter: "run-as-binary",
          command: executor,
          execution: { protocol: "pi-review-executor-jsonl-v1" }
        }
      },
      execution: {
maxWorkers: 1,
subtaskNotifications: options.notifications,
workerResources: { "default": { selection: { source: "external", id: "blocking-fake" }, maxConcurrent: 1 } },
  routes: { execute: [{ resourceId: "default" }], research: [] },
      },
      retainBundles: "always",
    });
    const messages: string[] = [];
    const sentMessages: Array<{ content: string; details?: { diagnostic?: unknown } }> = [];
    controller = new BackgroundExecutionController({
      pi: { sendMessage: (message: { content: string; details?: { diagnostic?: unknown } }) => {
        messages.push(message.content);
        sentMessages.push(message);
      } },
      config,
      state: createState(),
      cwd: () => root,
      notify: (message) => {
        messages.push(message);
      },
    });
    const started = await controller.start([{
      title: "wake diagnostic target",
      instructions: "write draft.txt",
      acceptanceCriteria: ["draft.txt exists"],
    }]);
    // Gate at the authoritative launch boundary (issue 12): waiting only for
    // the "running" state resolves at the worker's first progress event
    // (phase "starting", "wave worker starting executor"), while the real
    // launch path keeps writing state asynchronously — its final launch-path
    // progress ("executor turn N running") lands later and
    // can regress an injected synthetic failure back to "running" inside
    // handleLaunchRejection's save/wake window. Waiting for that final
    // progress event guarantees the blocking executor has the turn parked and
    // no live fixture writer remains in flight, so the synthetic failure is
    // deterministic. The executor produces no stdout, so nothing is emitted
    // after this boundary until shutdown. (The wave controller relays worker
    // progress with phase "working" and the message "<taskId>: executor turn
    // N running", so the boundary is matched by message.)
    await waitFor(() => {
      const live = controller!.inspect(started.executionId).tasks[0];
      return live?.state === "running"
        && live.activity.some((event) => /executor turn \d+ running/.test(event.message));
    }, 30_000);
    const internals = controller as unknown as {
      groups: Map<string, BackgroundExecutionGroup>;
      handleLaunchRejection: (group: BackgroundExecutionGroup, task: BackgroundTaskRecord, error: unknown) => Promise<void>;
      wake: (task: BackgroundTaskRecord, kind: "completion" | "failure" | "state", content: string, eventSnapshot?: unknown) => Promise<void>;
      setConflictGate: (gate: BackgroundConflictGate) => void;
    };
    return {
      root,
      controller,
      started,
      messages,
      sentMessages,
      internals,
      cleanup: async () => {
        await controller?.shutdown().catch(() => undefined);
        // Release the conflict-gate lease block installed through the real
        // setConflictGate path so it cannot outlive this fixture's root.
        await controller?.detach().catch(() => undefined);
        await rm(root, { recursive: true, force: true });
      },
    };
  } catch (error) {
    await controller?.shutdown().catch(() => undefined);
    await controller?.detach().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
    throw error;
  }
}

function injectAdversarialTaskData(root: string, group: BackgroundExecutionGroup, task: BackgroundTaskRecord): void {
  const now = new Date().toISOString();
  task.bundle = {
    version: 1,
    operationId: "op-wake-diagnostic",
    waveId: "wave-wake-diagnostic",
    taskId: task.taskId,
    waveRoot: join(root, "wave-root"),
    expectedRevision: group.revision,
  };
  task.executorEntryId = `entry-${"x".repeat(5_000)}`;
  task.definition = {
    title: "t".repeat(5_000),
    instructions: WAKE_FAILURE_SECRET_SENTINEL.repeat(500),
    acceptanceCriteria: [WAKE_FAILURE_SECRET_SENTINEL.repeat(400)],
  } as unknown as BackgroundTaskRecord["definition"];
  task.summary = "s".repeat(90_000);
  task.error = `e${"e".repeat(90_000)} ${WAKE_FAILURE_SECRET_SENTINEL} ${"x".repeat(90_000)}`;
  task.result = { taskResults: [{ summary: WAKE_FAILURE_SECRET_SENTINEL.repeat(2_000) }] } as unknown as BackgroundTaskRecord["result"];
  task.commands = Array.from({ length: 60 }, (_unused, index) => ({
    instructionId: `steer-${index}`,
    action: "steer" as const,
    actor: "model" as const,
    text: WAKE_FAILURE_SECRET_SENTINEL.repeat(300),
    status: "queued" as const,
    createdAt: now,
  }));
  task.activity = Array.from({ length: 60 }, (_unused, index) => ({
    sequence: index + 1,
    at: now,
    // The last injected event survives the recent-activity window, so its
    // adversarial phase exercises the phase bound deterministically.
    phase: index === 59 ? "ph".repeat(5_000) : "executor",
    message: "a".repeat(2_000),
  }));
}

test("wake failure diagnostics are curated, bounded, and exclude secret task and command content", async () => {
  const scenario = await setupBlockingFailureHarness({ notifications: "noisy" });
  const { controller, started, messages, internals, cleanup } = scenario;
  try {
    const group = internals.groups.get(started.executionId)!;
    const task = group.tasks[0]!;
    injectAdversarialTaskData(scenario.root, group, task);
    // Real production gate installation (per-target conflictGates map plus its
    // source-mutation lease block), so the failure diagnostic reads the gate
    // back through the same lookup the live landing path uses.
    internals.setConflictGate({
      executionId: group.executionId,
      taskId: task.taskId,
      sourceRoot: scenario.root,
      paths: [...Array.from({ length: 24 }, (_unused, index) => `conflict-${index}-${"p".repeat(400)}`), "conflict-final.txt"],
      activatedAt: new Date().toISOString(),
      manifestPath: join(scenario.root, "conflict-manifest.json"),
      reason: `Forced task ${task.taskId} materialized conflicts.`,
    });
    const jsonEscapeTail = "\u0000".repeat(80_000);
    await internals.handleLaunchRejection(group, task, new Error(`${WAKE_FAILURE_ERROR_SENTINEL} worker exploded: ${jsonEscapeTail}`));

    const failureMessages = messages.filter((message) => message.includes("Failure recovery diagnostic"));
    assert.equal(failureMessages.length, 1, "exactly one failure wake with a curated diagnostic");
    const failureMessage = failureMessages[0]!;

    // The failure preamble is dedicated and bounded: no raw unbounded wake
    // content, no task-title or incomplete-task lists from the generic event.
    assert.match(failureMessage, /requires recovery attention at state FAILED/);
    assert.ok(!failureMessage.includes("Tasks not yet landed"), "the incomplete-task list is not part of failure notifications");
    assert.ok(!/t{500}/.test(failureMessage), "the adversarial task title run is truncated away");

    // Secret exclusion: instructions, acceptance criteria, command text, and
    // model output never reach the notification, even at field starts.
    for (const message of messages) {
      assert.ok(!message.includes(WAKE_FAILURE_SECRET_SENTINEL), "the secret sentinel must never appear in any notification");
      assert.ok(!/"instructions":/.test(message), "task instructions must not be serialized");
      assert.ok(!/"acceptanceCriteria":/.test(message), "acceptance criteria must not be serialized");
      assert.ok(!/"commands":/.test(message), "command records must not be serialized");
      assert.ok(!/"result":/.test(message), "model result output must not be serialized");
      assert.ok(!/"definition":/.test(message), "task definitions must not be serialized");
    }

    // The sentinel at the start of the worker error is allowed bounded error
    // content: it survives only inside per-field caps, never as a large run.
    const errorSentinelOccurrences = failureMessage.split(WAKE_FAILURE_ERROR_SENTINEL).length - 1;
    assert.ok(errorSentinelOccurrences >= 1, "the bounded worker error remains actionable");
    assert.ok(errorSentinelOccurrences <= 6, `the error sentinel appears only inside bounded fields, got ${errorSentinelOccurrences}`);
    assert.ok(!failureMessage.includes(jsonEscapeTail.slice(0, 1_000)), "the JSON-escaping error tail is truncated away");

    // Hard size bounds with visible truncation markers.
    assert.ok(failureMessage.length <= 16_100, `the final notification must stay under the cap, got ${failureMessage.length}`);
    const diagnosticJson = failureMessage.slice(failureMessage.indexOf("{", failureMessage.indexOf("Failure recovery diagnostic")));
    assert.ok(diagnosticJson.length <= 7_000, `the serialized diagnostic must stay under the JSON cap, got ${diagnosticJson.length}`);
    assert.ok(failureMessage.includes("…[truncated]"), "bounded fields carry a visible truncation marker");

    // The structured details payload is bounded by construction and identical
    // to the delivered (parseable) JSON text.
    const failureDetails = scenario.sentMessages.find((message) => message.content === failureMessage)?.details;
    assert.ok(failureDetails?.diagnostic, "the structured diagnostic is delivered via sendMessage details");
    const detailsJson = JSON.stringify(failureDetails.diagnostic);
    assert.ok(detailsJson.length <= 7_000, `the structured details diagnostic must stay bounded, got ${detailsJson.length}`);
    assert.ok(!detailsJson.includes(WAKE_FAILURE_SECRET_SENTINEL), "the secret sentinel never reaches the structured details");
    assert.deepEqual(JSON.parse(diagnosticJson), failureDetails.diagnostic, "the delivered JSON is parseable and matches the structured details");
    const detailsDiagnostic = failureDetails.diagnostic as {
      activity: Array<{ phase: string }>;
      recovery: { executorEntryId?: string };
    };
    for (const event of detailsDiagnostic.activity) {
      assert.ok(event.phase.length <= 113, `activity phases are field-bounded, got ${event.phase.length}`);
    }
    assert.ok((detailsDiagnostic.recovery.executorEntryId ?? "").length <= 133, "executorEntryId is field-bounded");

    // Positive controls: stable IDs, state, and recovery handles are present.
    assert.ok(failureMessage.includes(started.executionId), "the execution handle is present");
    assert.ok(failureMessage.includes(task.taskId), "the task handle is present");
    assert.match(failureMessage, /"taskState": "failed"/);
    assert.match(failureMessage, /"hasDurableBundle": true/);
    assert.ok(failureMessage.includes("SubtasksInspect"), "an inspect recovery action is present");
    assert.ok(failureMessage.includes("SubtasksContinue"), "a continue recovery action is present");
    assert.ok(failureMessage.includes("SubtasksForceMerge"), "a force-merge recovery action is present");
    assert.ok(failureMessage.includes("SubtasksInterrupt"), "an interrupt recovery action is present");
    assert.ok(failureMessage.includes("SubtasksMarkClean"), "the conflict-gate recovery action survives independent of the bounded message");
    assert.ok(
      detailsJson.includes("SubtasksMarkClean"),
      "the structured details carry the conflict-gate recovery action",
    );
    assert.ok(failureMessage.includes(join(scenario.root, "wave-root")), "the durable bundle wave root is present");
    assert.ok(failureMessage.includes("conflict-manifest.json"), "the conflict manifest path is present");
    assert.match(failureMessage, /"taskCount": 1/);

    // Bounded activity and conflict paths: counts, not full arrays, and each entry capped.
    const sequenceMatches = diagnosticJson.match(/"sequence":/g) ?? [];
    assert.ok(sequenceMatches.length <= 8, `activity is bounded to the most recent entries, got ${sequenceMatches.length}`);
    const pathMatches = diagnosticJson.match(/"conflict-\d+/g) ?? [];
    assert.ok(pathMatches.length <= 10, `conflict paths are bounded in count, got ${pathMatches.length}`);
  } finally {
    await cleanup();
  }
});

test("conflict-gate failure wakes keep SubtasksMarkClean recovery even when the bounded message truncates it away", async () => {
  const scenario = await setupBlockingFailureHarness({ notifications: "noisy" });
  const { controller, started, messages, internals, cleanup } = scenario;
  try {
    const group = internals.groups.get(started.executionId)!;
    const task = group.tasks[0]!;
    task.bundle = {
      version: 1,
      operationId: "op-conflict-wake",
      waveId: "wave-conflict-wake",
      taskId: task.taskId,
      waveRoot: join(scenario.root, "wave-root"),
      expectedRevision: group.revision,
    };
    // Real production gate installation so criticalPrompt() and the failure
    // diagnostic both read the gate from the per-target conflictGates map.
    internals.setConflictGate({
      executionId: group.executionId,
      taskId: task.taskId,
      sourceRoot: scenario.root,
      // ~320 chars of fixed prompt prose plus 8 x 70-char paths exceeds the
      // 600-char message budget, so the free-text prompt truncates before the
      // SubtasksMarkClean instruction — exactly the regression scenario.
      paths: Array.from({ length: 8 }, (_unused, index) => `deeply/nested/conflicted/path/number-${index}-of-eight/` + "p".repeat(40)),
      activatedAt: new Date().toISOString(),
      manifestPath: join(scenario.root, "conflict-manifest.json"),
      reason: `Forced task ${task.taskId} materialized conflicts.`,
    });
    const prompt = controller.criticalPrompt()!;
    assert.ok(prompt.includes("SubtasksMarkClean"), "the raw critical prompt names the recovery action");
    assert.ok(prompt.length > 600, "the critical prompt exceeds the message budget so its tail is truncated");
    await internals.wake(task, "failure", prompt);

    const failureMessage = messages.find((message) => message.includes("Failure recovery diagnostic"));
    assert.ok(failureMessage, "the conflict-gate failure wake delivers the curated diagnostic");
    const messageField = failureMessage!.match(/"message": "([^"]*)"/)?.[1] ?? "";
    assert.ok(!messageField.includes("SubtasksMarkClean"), "the prompt tail (and its MarkClean instruction) is truncated out of the message field");
    assert.ok(failureMessage.includes("SubtasksMarkClean"), "the rendered recovery actions still name SubtasksMarkClean");
    const failureDetails = scenario.sentMessages.find((message) => message.content === failureMessage)?.details;
    assert.ok(failureDetails?.diagnostic, "the structured diagnostic is delivered");
    const detailsJson = JSON.stringify(failureDetails.diagnostic);
    assert.ok(detailsJson.includes("SubtasksMarkClean"), "the structured details carry the conflict-gate recovery action");
    assert.ok(detailsJson.length <= 7_000, `the structured details stay bounded, got ${detailsJson.length}`);
    const diagnosticJson = failureMessage!.slice(failureMessage!.indexOf("{", failureMessage!.indexOf("Failure recovery diagnostic")));
    assert.doesNotThrow(() => JSON.parse(diagnosticJson), "the delivered diagnostic stays parseable JSON");
    assert.ok(failureMessage!.includes("conflict-manifest.json"), "the conflict manifest path is present");
  } finally {
    await cleanup();
  }
});

test("quiet and noisy subtask notification modes both retain actionable wake failure recovery information", async () => {
  for (const notifications of ["quiet", "noisy"] as const) {
    const scenario = await setupBlockingFailureHarness({ notifications });
    const { controller, started, messages, internals, cleanup } = scenario;
    try {
      const group = internals.groups.get(started.executionId)!;
      const task = group.tasks[0]!;
      injectAdversarialTaskData(scenario.root, group, task);
      await internals.handleLaunchRejection(group, task, new Error("deterministic synthetic launch failure"));
      const failureMessage = messages.find((message) => message.includes("Failure recovery diagnostic"));
      assert.ok(failureMessage, `the ${notifications} mode delivers the failure notification with the curated diagnostic`);
      assert.ok(!failureMessage!.includes(WAKE_FAILURE_SECRET_SENTINEL), "the sentinel never reaches the notification");
      assert.ok(failureMessage!.includes(started.executionId), "the execution handle survives in both modes");
      assert.ok(failureMessage!.includes(task.taskId), "the task handle survives in both modes");
      assert.match(failureMessage!, /"taskState": "failed"/);
      assert.ok(failureMessage!.includes("SubtasksContinue"), "a continue recovery action survives in both modes");
      assert.ok(failureMessage!.includes("SubtasksInspect"), "an inspect recovery action survives in both modes");
      assert.ok(failureMessage!.length <= 16_100, "the notification stays bounded in both modes");
      const failureDetails = scenario.sentMessages.find((message) => message.content === failureMessage)?.details;
      assert.ok(failureDetails?.diagnostic, "the structured diagnostic is delivered in both modes");
      assert.ok(JSON.stringify(failureDetails.diagnostic).length <= 7_000, "the structured details diagnostic stays bounded in both modes");
    } finally {
      await cleanup();
    }
  }
});

// Regression for issue 12: the hosted Linux run observed the failure
// diagnostic reporting "taskState": "running" with the live worker's
// "wave worker starting executor" activity landing after the synthetic
// failure — the fixture's "running" gate raced the real launch path's final
// progress write. The harness now gates at the authoritative launch boundary;
// this pins the cause deterministically.
test("regression: synthetic launch failure stays terminal because the fixture gate precedes any live launch writer", async () => {
  const scenario = await setupBlockingFailureHarness({ notifications: "quiet" });
  const { controller, started, messages, internals, cleanup } = scenario;
  try {
    const group = internals.groups.get(started.executionId)!;
    const task = group.tasks[0]!;
    // Cause evidence: the launch path's final progress write (relayed as
    // "executor turn N running") has already landed, so no in-flight launch
    // writer can regress the injected failure.
    assert.ok(
      task.activity.some((event) => /executor turn \d+ running/.test(event.message)),
      "the launch path emitted its final executor-turn progress before the fixture gate released",
    );
    injectAdversarialTaskData(scenario.root, group, task);
    await internals.handleLaunchRejection(group, task, new Error("issue 12 regression: synthetic launch failure must stay terminal"));
    assert.equal(task.state, "failed", "the synthetic failure must remain the terminal state");
    assert.equal(task.stateHistory?.at(-1)?.state, "failed", "no later transition regresses the failed state");
    const failureMessage = messages.find((message) => message.includes("Failure recovery diagnostic"));
    assert.ok(failureMessage, "the regression delivers the curated failure notification");
    assert.match(failureMessage!, /"taskState": "failed"/, "the diagnostic reports the failed state, never the racing live state");
    assert.ok(failureMessage!.includes(started.executionId), "the execution handle survives");
    assert.ok(failureMessage!.includes(task.taskId), "the task handle survives");
  } finally {
    await cleanup();
  }
});

/**
 * #117 harness: an execution whose landing genuinely conflicts with a
 * concurrent main-workspace change (the worker worktree and main both modify
 * shared.txt after capture). The conflicted failure wake is delivered through
 * the real pi.sendMessage seam and is awaited here so consumers never race its
 * delivery; the test then resolves the markers and drives markClean with the
 * actor under test. With `activeSibling`, a second task keeps the group active
 * (so a watch can be armed) and lands on its own a few seconds later.
 */
async function setupConflictedLanding(
  unique: string,
  options?: { notificationMode?: "quiet" | "noisy"; activeSibling?: boolean },
): Promise<{
  root: string;
  controller: BackgroundExecutionController;
  started: BackgroundInspection;
  taskId: string;
  siblingTaskId?: string;
  messages: SubtaskEventMessage[];
  cleanup: () => Promise<void>;
}> {
  const root = await mkdtemp(join(tmpdir(), `pi-review-background-dedupe-${unique}-`));
  await initGitRepo(root, { "base.txt": "base\n", "shared.txt": "base shared\n" });
  const sentinel = `${unique.toUpperCase()}_SENTINEL`;
  const siblingSentinel = `${unique.toUpperCase()}_B_SENTINEL`;
  const executor = join(root, `conflict-executor-${unique}.cjs`);
  await writeFile(executor, [
    "#!/usr/bin/env node",
    "const fs=require('node:fs');let prompt='';process.stdin.setEncoding('utf8');process.stdin.on('data',c=>prompt+=c);",
    "process.stdin.on('end',()=>{",
    // Active sibling: lands on its own a few seconds after dispatch so the
    // group stays active (watch-armable) and later completes distinctly.
    `if(prompt.includes('${siblingSentinel}')){fs.writeFileSync('b.txt','b landed\\n');setTimeout(()=>{console.log(JSON.stringify({type:'session',sessionId:process.env.PI_REVIEW_EXECUTOR_SESSION_ID}));console.log(JSON.stringify({type:'assistant',text:'completed requested edit'}));},2500);return;}`,
    `if(prompt.includes('${sentinel}')){`,
    "fs.writeFileSync('marker.txt','landed\\n');",
    // Candidate side: the worker worktree modifies shared.txt.
    "fs.writeFileSync('shared.txt','candidate shared\\n');",
    // Current side: main diverges on the same file while the turn is in
    // flight, so landing revalidation materializes a genuine conflict.
    `fs.writeFileSync(${JSON.stringify(join(root, "shared.txt"))},'current shared\\n');}`,
    "console.log(JSON.stringify({type:'session',sessionId:process.env.PI_REVIEW_EXECUTOR_SESSION_ID}));",
    "console.log(JSON.stringify({type:'assistant',text:'completed requested edit'}));",
    "});",
  ].join("\n"), "utf8");
  await chmod(executor, 0o755);
  const config = normalizeConfig({
    enabled: true,
    review: { activeReviewers: [] },
    externalAgents: {
      [`dedupe-${unique}`]: {
        adapter: "run-as-binary",
        command: executor,
        execution: { protocol: "pi-review-executor-jsonl-v1" }
      }
    },
    execution: {
      ...(options?.notificationMode ? { subtaskNotifications: options.notificationMode } : {}),
      maxWorkers: 1,
      workerResources: { "default": { selection: { source: "external", id: `dedupe-${unique}` }, maxConcurrent: 1 } },
      routes: { execute: [{ resourceId: "default" }], research: [] },
    },
    retainBundles: "always",
  });
  const messages: SubtaskEventMessage[] = [];
  const controller = new BackgroundExecutionController({
    pi: { sendMessage: (message: SubtaskEventMessage) => messages.push(message) },
    config,
    state: createState(),
    cwd: () => root,
  });
  const started = await controller.start(options?.activeSibling
    ? [
      { title: "conflict target", instructions: sentinel, acceptanceCriteria: ["marker.txt exists"] },
      { title: "sibling second", instructions: siblingSentinel, acceptanceCriteria: ["b.txt exists"] },
    ]
    : [{
      title: "conflict target",
      instructions: sentinel,
      acceptanceCriteria: ["marker.txt exists"],
    }]);
  const taskId = started.tasks[0]!.taskId;
  await waitFor(() => controller.inspect(started.executionId, taskId).tasks[0]?.state === "conflicted");
  // The conflicted failure wake is part of the established precondition: it
  // lands after the state transition's save/publish steps, so wait for it
  // instead of letting consumers race its delivery.
  await waitFor(() => failureEvents(messages).length === 1);
  return {
    root,
    controller,
    started,
    taskId,
    ...(options?.activeSibling ? { siblingTaskId: started.tasks[1]!.taskId } : {}),
    messages,
    cleanup: async () => {
      await controller.shutdown().catch(() => undefined);
      await rm(root, { recursive: true, force: true });
    },
  };
}

/**
 * #117 harness: a two-task execution with one worker slot — A runs first,
 * writes a.txt, then stalls; B waits in the queue (an active sibling) and,
 * once dispatched, lands on its own after a short delay. The fixture
 * interrupts A once its checkpoint file is visible so A becomes
 * force-mergeable while B remains active.
 */
async function setupInterruptedSiblingPair(
  unique: string,
  options?: { siblingDelayMs?: number },
): Promise<{
  root: string;
  controller: BackgroundExecutionController;
  started: BackgroundInspection;
  taskA: string;
  taskB: string;
  messages: SubtaskEventMessage[];
  cleanup: () => Promise<void>;
}> {
  const root = await mkdtemp(join(tmpdir(), `pi-review-background-dedupe-sibling-${unique}-`));
  await initGitRepo(root);
  const sentinelA = `${unique.toUpperCase()}_A_SENTINEL`;
  const sentinelB = `${unique.toUpperCase()}_B_SENTINEL`;
  const executor = join(root, `sibling-executor-${unique}.cjs`);
  await writeFile(executor, [
    "#!/usr/bin/env node",
    "const fs=require('node:fs');let prompt='';process.stdin.setEncoding('utf8');process.stdin.on('data',c=>prompt+=c);",
    "process.stdin.on('end',()=>{",
    `if(prompt.includes('${sentinelA}')){fs.writeFileSync('a.txt','a landed\\n');setTimeout(()=>console.log(JSON.stringify({type:'assistant',text:'late completion'})),30000);return;}`,
    // B lands on its own after `siblingDelayMs` (default 3000) following its
    // dispatch so it is still active well past any checkpoint deadline armed
    // during the test. A larger delay keeps the sibling active even through
    // slow merges in tests that never wait for B.
    `if(prompt.includes('${sentinelB}')){fs.writeFileSync('b.txt','b landed\\n');setTimeout(()=>{console.log(JSON.stringify({type:'session',sessionId:process.env.PI_REVIEW_EXECUTOR_SESSION_ID}));console.log(JSON.stringify({type:'assistant',text:'completed requested edit'}));},${options?.siblingDelayMs ?? 3000});return;}`,
    "});",
  ].join("\n"), "utf8");
  await chmod(executor, 0o755);
  const config = normalizeConfig({
    enabled: true,
    review: { activeReviewers: [] },
    externalAgents: {
      [`dedupe-sibling-${unique}`]: {
        adapter: "run-as-binary",
        command: executor,
        execution: { protocol: "pi-review-executor-jsonl-v1" }
      }
    },
    execution: {
      maxWorkers: 1,
      workerResources: { "default": { selection: { source: "external", id: `dedupe-sibling-${unique}` }, maxConcurrent: 1 } },
      routes: { execute: [{ resourceId: "default" }], research: [] },
    },
    retainBundles: "always",
  });
  const messages: SubtaskEventMessage[] = [];
  const controller = new BackgroundExecutionController({
    pi: { sendMessage: (message: SubtaskEventMessage) => messages.push(message) },
    config,
    state: createState(),
    cwd: () => root,
  });
  const started = await controller.start([
    { title: "interrupted first", instructions: sentinelA, acceptanceCriteria: ["a.txt exists"] },
    { title: "sibling second", instructions: sentinelB, acceptanceCriteria: ["b.txt exists"] },
  ]);
  const taskA = started.tasks[0]!.taskId;
  const taskB = started.tasks[1]!.taskId;
  await waitFor(() => controller.inspect(started.executionId, taskA).tasks[0]?.state === "running");
  await waitForAsync(async () => {
    const waveRoot = controller.inspect(started.executionId, taskA).tasks[0]?.waveRoot;
    if (!waveRoot) return false;
    return access(join(waveRoot, "workers", taskA, "a.txt")).then(() => true, () => false);
  });
  await controller.interrupt({
    executionId: started.executionId,
    taskId: taskA,
    mode: "interrupt_as_failure",
    instructionId: `sibling-interrupt-${unique}`,
    actor: "user",
  });
  return {
    root,
    controller,
    started,
    taskA,
    taskB,
    messages,
    cleanup: async () => {
      await controller.shutdown().catch(() => undefined);
      await rm(root, { recursive: true, force: true });
    },
  };
}

/**
 * #160: deterministic armed-watch seam for the suppressed-completion
 * regressions. Arming a real 1200 ms timer before an arbitrarily slow
 * production force-merge/mark-clean races the deadline against the completion:
 * under load the deadline can legitimately fire pre-completion, which makes
 * "zero total watch events" assertions vacuous or flaky. Instead the
 * production `controller.watch(...)` call is armed through a narrowly scoped
 * timer registration: the single deadline callback armed by this one watch
 * call is captured and never enters the real event loop, the test itself
 * advances the would-be deadline after the production completion has run the
 * real cancellation, and a clearTimeout interception observes the production
 * cancelWatch clearing the controlled handle (a pass-through for every other
 * timer in the process — nothing unrelated is frozen or mocked).
 *
 * With `captureDeliveryTimers`, the interception window additionally stays
 * open across the deadline fire, so the 25 ms delivery timer armed inside the
 * production `queueWatchDelivery` callback is captured too; tests can then
 * prove that a genuinely queued checkpoint snapshot was retired by the real
 * cancelWatch before its delivery window ran.
 *
 * The capture window between arming and firing the deadline must stay fully
 * synchronous (no awaits): an awaited step inside that window would silently
 * capture unrelated process timers and they would never fire. A timer-polling
 * await (e.g. waitFor) would capture its own poll timer and hang before
 * `fireDeadline` runs, so this synchronous-window rule — not the guard below —
 * is the binding constraint; the guard's assertion additionally fails fast
 * when an awaited step inside the window completed on its own and captured an
 * unrelated timer.
 */
interface ControlledWatchArm {
  armed: BackgroundWatchSubscription;
  /** `true` once production code cleared the controlled deadline handle (cancelWatch / clearWatches). */
  wasCleared(): boolean;
  /** Advance/release the would-be deadline by running the armed production delivery callback. */
  fireDeadline(): void;
  /** Timers captured after the deadline (e.g. the 25 ms delivery window), in capture order. */
  deliveryTimers: Array<{ handle: unknown; fire(): void }>;
  /** Restore the global timer functions. */
  release(): void;
}

function armControlledWatch(
  controller: BackgroundExecutionController,
  executionId: string,
  afterMs: number,
  options?: { captureDeliveryTimers?: boolean },
): ControlledWatchArm {
  const captureDeliveryTimers = options?.captureDeliveryTimers === true;
  const scope = globalThis as { setTimeout: typeof setTimeout; clearTimeout: typeof clearTimeout };
  const originalSetTimeout = scope.setTimeout;
  const originalClearTimeout = scope.clearTimeout;
  let deadlineCallback: (() => void) | undefined;
  let released = false;
  let captureActive = true;
  const capturedTimers: Array<{ handle: NodeJS.Timeout; callback: () => void; cleared: boolean }> = [];
  // Deliberately not a real Timeout: captured deadlines must never enter the
  // event loop before the test advances them.
  const release = () => {
    if (released) return;
    released = true;
    captureActive = false;
    scope.setTimeout = originalSetTimeout;
    scope.clearTimeout = originalClearTimeout;
  };
  // The interception window only covers timers armed by controller code: the
  // watch() deadline, plus (in capture mode) the delivery window armed inside
  // the fired deadline callback. Every other timer stays real.
  const endCapture = () => {
    captureActive = false;
    scope.setTimeout = originalSetTimeout;
  };
  const fireDeadline = () => {
    assert.ok(deadlineCallback, "the controlled watch never armed a deadline callback");
    // Guard against a future edit awaiting inside the capture window: any
    // unrelated process timer captured there would never fire and the test
    // would hang. Exactly the one watch deadline must have been captured.
    // (This guard only catches awaits whose work completes on its own; a
    // timer-polling await would hang before reaching it, so the
    // synchronous-window rule documented above remains binding.)
    assert.equal(capturedTimers.length, 1, "an unrelated timer entered the capture window; the window between arming and firing must stay synchronous");
    // Fired unconditionally, even after cancellation: this is exactly what a
    // timer implementation would run at the deadline, so the production
    // queueWatchDelivery armed-subscription guard — not test speed — must
    // suppress the stale delivery.
    deadlineCallback();
    if (captureDeliveryTimers) endCapture();
  };
  scope.setTimeout = ((callback: () => void, ms?: number, ...rest: unknown[]) => {
    if (!captureActive) return originalSetTimeout(callback, ms, ...rest);
    const entry = { handle: { controlledWatchTimer: true } as unknown as NodeJS.Timeout, callback, cleared: false };
    // The first captured timer is the watch deadline armed by controller.watch().
    deadlineCallback ??= callback;
    capturedTimers.push(entry);
    return entry.handle;
  }) as unknown as typeof setTimeout;
  scope.clearTimeout = ((timer?: NodeJS.Timeout) => {
    for (const entry of capturedTimers) {
      if (timer === entry.handle) {
        entry.cleared = true;
        return undefined;
      }
    }
    return originalClearTimeout(timer);
  }) as unknown as typeof clearTimeout;
  try {
    const armed = controller.watch(executionId, afterMs);
    assert.ok(deadlineCallback, "controller.watch did not arm a delivery timer");
    if (!captureDeliveryTimers) endCapture();
    return {
      armed,
      wasCleared: () => capturedTimers[0]?.cleared === true,
      fireDeadline,
      // Computed lazily: in capture mode the delivery timers are captured when
      // the deadline is fired, after this object was returned.
      get deliveryTimers() {
        return capturedTimers.slice(1).map((entry) => ({
          handle: entry.handle,
          // Fired unconditionally, like a real delivery timer would be; with
          // the queued snapshot retired by production code this delivers
          // nothing.
          fire: () => {
            assert.equal(entry.cleared, false, "the captured delivery window was already cleared");
            entry.callback();
          },
        }));
      },
      release,
    };
  } catch (error) {
    scope.setTimeout = originalSetTimeout;
    scope.clearTimeout = originalClearTimeout;
    throw error;
  }
}

test("#117 model-actor mark-clean suppresses the completion wake and folds in the group aggregate", async () => {
  for (const mode of ["quiet", "noisy"] as const) {
    const scenario = await setupConflictedLanding(`model-markclean-${mode}`, { notificationMode: mode });
    try {
      const { controller, started, taskId, messages } = scenario;
      // The conflicted failure wake is still delivered — suppression never
      // touches failures, conflicts, or recovery requirements.
      assert.equal(failureEvents(messages).length, 1, "the conflicted landing keeps its failure wake");
      assert.match(failureEvents(messages)[0]!.content, /requires recovery attention at state CONFLICTED/);

      await writeFile(join(scenario.root, "shared.txt"), "resolved\n", "utf8");
      const outcome = await controller.markClean({ actor: "model" });
      assert.equal(outcome.cleared, true);
      assert.deepEqual(outcome.paths, ["shared.txt"]);
      assert.equal(controller.inspect(started.executionId, taskId).tasks[0]?.state, "landed");

      // The validated landing is confirmed by the direct result itself: its
      // group aggregate is folded in and no completion notification follows.
      assert.equal(outcome.completionAggregates?.length, 1);
      assert.equal(outcome.completionAggregates![0]!.executionId, started.executionId);
      assert.equal(outcome.completionAggregates![0]!.taskId, taskId);
      assert.ok(outcome.completionAggregates![0]!.aggregate.includes(`Execution ${started.executionId} COMPLETE: 1/1 tasks landed.`));
      assert.ok(outcome.completionAggregates![0]!.aggregate.includes("All requested task outputs have landed; aggregate verification is now appropriate."));
      assert.equal(completionEvents(messages).length, 0, "no completion notification follows a model-confirmed validated landing");
    } finally {
      await scenario.cleanup();
    }
  }
});

test("#117 user-actor mark-clean keeps the completion wake and folds nothing in", async () => {
  for (const mode of ["quiet", "noisy"] as const) {
    const scenario = await setupConflictedLanding(`user-markclean-${mode}`, { notificationMode: mode });
    try {
      const { controller, started, messages } = scenario;

      await writeFile(join(scenario.root, "shared.txt"), "resolved\n", "utf8");
      const outcome = await controller.markClean({ actor: "user" });
      assert.equal(outcome.cleared, true);
      assert.deepEqual(outcome.paths, ["shared.txt"]);
      assert.equal(outcome.completionAggregates, undefined, "user invocations keep the wake and get no folded aggregate");

      await waitFor(() => completionEvents(messages).length === 1);
      const completion = completionEvents(messages)[0]!;
      assert.ok(completion.content.includes("conflict resolution was validated and landed"));
      assert.ok(completion.content.includes(`Execution ${started.executionId} COMPLETE: 1/1 tasks landed.`));
    } finally {
      await scenario.cleanup();
    }
  }
});

test("#117 model-actor force-merge suppresses the completion wake and folds the aggregate into the result", async () => {
  for (const mode of ["quiet", "noisy"] as const) {
    const messages: SubtaskEventMessage[] = [];
    const scenario = await setupInterruptedMergeTask(`model-force-${mode}`, {
      sendMessage: (message: SubtaskEventMessage) => messages.push(message),
    }, { notificationMode: mode });
    try {
      const { controller, started, taskId } = scenario;
      const landed = await controller.forceMerge({
        executionId: started.executionId,
        taskId,
        mergeAnyhow: false,
        instructionId: `dedupe-model-force-${mode}`,
        actor: "model",
      });
      assert.equal(landed.tasks[0]?.state, "landed");
      assert.ok(landed.completionAggregate, "the group aggregate is folded into the direct result");
      assert.ok(landed.completionAggregate!.includes(`Execution ${started.executionId} COMPLETE: 1/1 tasks landed.`));
      assert.ok(landed.completionAggregate!.includes("All requested task outputs have landed; aggregate verification is now appropriate."));
      assert.equal(completionEvents(messages).length, 0, "no completion notification follows a model-confirmed force-merge landing");
    } finally {
      await scenario.cleanup();
    }
  }
});

test("#117 user-actor force-merge keeps the completion wake and folds nothing in", async () => {
  for (const mode of ["quiet", "noisy"] as const) {
    const messages: SubtaskEventMessage[] = [];
    const scenario = await setupInterruptedMergeTask(`user-force-${mode}`, {
      sendMessage: (message: SubtaskEventMessage) => messages.push(message),
    }, { notificationMode: mode });
    try {
      const { controller, started, taskId } = scenario;
      const landed = await controller.forceMerge({
        executionId: started.executionId,
        taskId,
        mergeAnyhow: false,
        instructionId: `dedupe-user-force-${mode}`,
        actor: "user",
      });
      assert.equal(landed.tasks[0]?.state, "landed");
      assert.equal(landed.completionAggregate, undefined, "the wake still carries the aggregate, so nothing is folded in");

      await waitFor(() => completionEvents(messages).length === 1);
      const completion = completionEvents(messages)[0]!;
      assert.ok(completion.content.includes("force-merged and landed mechanically"));
      assert.ok(completion.content.includes(`Execution ${started.executionId} COMPLETE: 1/1 tasks landed.`));
    } finally {
      await scenario.cleanup();
    }
  }
});

test("#117 model interrupt_with_merge returns the folded aggregate without a duplicate completion", async () => {
  for (const mode of ["quiet", "noisy"] as const) {
    // Model actor: the delegated force-merge is confirmed by this same call's
    // direct result, so it folds the aggregate and suppresses the wake.
    {
      const messages: SubtaskEventMessage[] = [];
      const scenario = await setupInterruptedMergeTask(`model-intmerge-${mode}`, {
        sendMessage: (message: SubtaskEventMessage) => messages.push(message),
      }, { notificationMode: mode, interruptInSetup: false });
      try {
        const { controller, started, taskId } = scenario;
        const landed = await controller.interrupt({
          executionId: started.executionId,
          taskId,
          mode: "interrupt_with_merge",
          instructionId: `dedupe-intmerge-${mode}`,
          actor: "model",
        });
        assert.equal(landed.tasks[0]?.state, "landed");
        assert.ok(landed.completionAggregate, "the interrupt-with-merge result carries the folded aggregate");
        assert.ok(landed.completionAggregate!.includes(`Execution ${started.executionId} COMPLETE: 1/1 tasks landed.`));
        assert.equal(completionEvents(messages).length, 0, "no duplicate completion follows a model-confirmed interrupt-with-merge landing");
      } finally {
        await scenario.cleanup();
      }
    }
    // User actor: no model tool result confirms the landing, so the wake stays.
    {
      const messages: SubtaskEventMessage[] = [];
      const scenario = await setupInterruptedMergeTask(`user-intmerge-${mode}`, {
        sendMessage: (message: SubtaskEventMessage) => messages.push(message),
      }, { notificationMode: mode, interruptInSetup: false });
      try {
        const { controller, started, taskId } = scenario;
        const landed = await controller.interrupt({
          executionId: started.executionId,
          taskId,
          mode: "interrupt_with_merge",
          instructionId: `dedupe-intmerge-${mode}`,
          actor: "user",
        });
        assert.equal(landed.tasks[0]?.state, "landed");
        assert.equal(landed.completionAggregate, undefined, "the wake still carries the aggregate, so nothing is folded in");

        await waitFor(() => completionEvents(messages).length === 1);
        const completion = completionEvents(messages)[0]!;
        assert.ok(completion.content.includes("force-merged and landed mechanically"));
        assert.ok(completion.content.includes(`Execution ${started.executionId} COMPLETE: 1/1 tasks landed.`));
      } finally {
        await scenario.cleanup();
      }
    }
  }
});

test("#117 a later distinct sibling completion still notifies after a suppressed model landing", async () => {
  const scenario = await setupInterruptedSiblingPair("notify");
  try {
    const { controller, started, taskA, taskB, messages } = scenario;

    // The model-confirmed landing of A is suppressed; because B has not
    // completed, the folded aggregate must list it as a sibling.
    const landed = await controller.forceMerge({
      executionId: started.executionId,
      taskId: taskA,
      mergeAnyhow: false,
      instructionId: "dedupe-sibling-force",
      actor: "model",
    });
    assert.equal(landed.tasks[0]?.state, "landed");
    assert.ok(landed.completionAggregate, "the not-yet-complete aggregate is folded into the direct result");
    assert.ok(landed.completionAggregate!.includes("Tasks not yet landed:"), "the folded aggregate names the outstanding sibling");
    assert.ok(landed.completionAggregate!.includes(taskB));
    assert.equal(subtaskEvents(messages).length, 0, "the suppressed landing delivers nothing immediately");

    // B's own executor-driven completion is a distinct event and still wakes.
    await waitFor(() => controller.inspect(started.executionId).tasks.every((task) => task.state === "landed"));
    await waitFor(() => subtaskEvents(messages).length === 1);
    const siblingCompletion = subtaskEvents(messages)[0]!;
    assert.ok(siblingCompletion.content.includes(taskB), "the sibling completion names its own task");
    assert.ok(siblingCompletion.content.includes("Landed paths: b.txt"));
    assert.ok(!siblingCompletion.content.includes("force-merged and landed mechanically"), "the suppressed landing never arrives as a later notification");
  } finally {
    await scenario.cleanup();
  }
});

test("#117 a suppressed model force-merge cancels the group's armed watch instead of letting a stale checkpoint fire", async () => {
  const scenario = await setupInterruptedSiblingPair("watch-force");
  try {
    const { controller, started, taskA, taskB, messages } = scenario;
    // #160: arm the one-shot checkpoint with a controlled deadline so it is
    // genuinely armed across the production completion no matter how slow the
    // merge is, and the test — not timer/completion speed — advances the
    // deadline afterwards. The deadline is released only after the real
    // cancellation has run, so the suppression cannot be masked by a deadline
    // that fired before the landing.
    const arm = armControlledWatch(controller, started.executionId, 1_200);
    try {
      // Inside the try so arm.release() always runs on failure; an early
      // throw would otherwise leave the global timer shims installed.
      assert.equal(arm.armed.replaced, false);
      const landed = await controller.forceMerge({
        executionId: started.executionId,
        taskId: taskA,
        mergeAnyhow: false,
        instructionId: "dedupe-watch-force",
        actor: "model",
      });
      assert.equal(landed.tasks[0]?.state, "landed");
      assert.ok(landed.completionAggregate?.includes(taskB), "the direct result still names the outstanding sibling");
      assert.equal(completionEvents(messages).length, 0, "no completion notification follows the suppressed landing");

      // The real cancelWatch retired both watch representations: the armed
      // timer handle was cleared and the subscription plus any queued
      // checkpoint snapshot are gone.
      assert.equal(arm.wasCleared(), true, "production cancelWatch cleared the armed timer handle");
      const internals = controller as unknown as {
        watches: Map<string, unknown>;
        pendingWatchInspections: Array<{ executionId: string }>;
        watchDeliveryTimer?: unknown;
      };
      assert.equal(internals.watches.has(started.executionId), false, "the armed watch subscription was retired");
      assert.ok(!internals.pendingWatchInspections.some((entry) => entry.executionId === started.executionId), "no queued checkpoint snapshot survives the suppressed completion");

      // Advance/release the would-be deadline past its original schedule.
      // Even a firing deadline cannot deliver: the queueWatchDelivery
      // armed-subscription guard finds nothing to inspect, so no delivery
      // timer is scheduled and no stale checkpoint event arrives while B is
      // still active.
      arm.fireDeadline();
      assert.equal(internals.watchDeliveryTimer, undefined, "no delivery timer is scheduled for a retired watch");
      assert.equal(watchEvents(messages).length, 0, "no stale checkpoint fires after the direct-result-confirmed landing");
    } finally {
      arm.release();
    }

    // B's own executor-driven completion is a distinct event and still wakes.
    await waitFor(() => controller.inspect(started.executionId).tasks.every((task) => task.state === "landed"));
    await waitFor(() => completionEvents(messages).length === 1);
    const siblingCompletion = completionEvents(messages)[0]!;
    assert.ok(siblingCompletion.content.includes(taskB), "the sibling completion names its own task");
    assert.ok(!siblingCompletion.content.includes("force-merged and landed mechanically"), "the suppressed landing never arrives as a later notification");
  } finally {
    await scenario.cleanup();
  }
});

test("#117 a suppressed model mark-clean cancels the group's armed watch instead of letting a stale checkpoint fire", async () => {
  const scenario = await setupConflictedLanding("watch-markclean", { activeSibling: true });
  try {
    const { controller, started, taskId, siblingTaskId, messages } = scenario;
    assert.ok(siblingTaskId, "the active sibling started");
    // B keeps the group active after A's conflicted landing (whose failure
    // wake already delivered), so the one-shot checkpoint can be armed. #160:
    // the controlled deadline stays armed across the production mark-clean
    // however slow it is; the test itself releases the deadline afterwards.
    const arm = armControlledWatch(controller, started.executionId, 1_200);
    try {
      // Inside the try so arm.release() always runs on failure; an early
      // throw would otherwise leave the global timer shims installed.
      assert.equal(arm.armed.replaced, false);
      await writeFile(join(scenario.root, "shared.txt"), "resolved\n", "utf8");
      const outcome = await controller.markClean({ actor: "model" });
      assert.equal(outcome.cleared, true);
      assert.deepEqual(outcome.paths, ["shared.txt"]);
      assert.equal(controller.inspect(started.executionId, taskId).tasks[0]?.state, "landed");
      assert.equal(outcome.completionAggregates?.length, 1);
      assert.ok(outcome.completionAggregates![0]!.aggregate.includes(siblingTaskId), "the folded aggregate names the still-active sibling");
      assert.equal(completionEvents(messages).length, 0, "no completion notification follows the suppressed validated landing");

      // The real cancelWatch retired both watch representations: the armed
      // timer handle was cleared and the subscription plus any queued
      // checkpoint snapshot are gone.
      assert.equal(arm.wasCleared(), true, "production cancelWatch cleared the armed timer handle");
      const internals = controller as unknown as {
        watches: Map<string, unknown>;
        pendingWatchInspections: Array<{ executionId: string }>;
        watchDeliveryTimer?: unknown;
      };
      assert.equal(internals.watches.has(started.executionId), false, "the armed watch subscription was retired");
      assert.ok(!internals.pendingWatchInspections.some((entry) => entry.executionId === started.executionId), "no queued checkpoint snapshot survives the suppressed completion");

      // Advance/release the would-be deadline past its original schedule.
      // Even a firing deadline cannot deliver: the queueWatchDelivery
      // armed-subscription guard finds nothing to inspect, so no delivery
      // timer is scheduled and no stale checkpoint event arrives while B is
      // still active.
      arm.fireDeadline();
      assert.equal(internals.watchDeliveryTimer, undefined, "no delivery timer is scheduled for a retired watch");
      assert.equal(watchEvents(messages).length, 0, "no stale checkpoint fires after the direct-result-confirmed landing");
    } finally {
      arm.release();
    }

    // B's own executor-driven completion is a distinct event and still wakes.
    await waitFor(() => controller.inspect(started.executionId).tasks.every((task) => task.state === "landed"));
    await waitFor(() => completionEvents(messages).length === 1);
    const siblingCompletion = completionEvents(messages)[0]!;
    assert.ok(siblingCompletion.content.includes(siblingTaskId), "the sibling completion names its own task");
    assert.ok(!siblingCompletion.content.includes("conflict resolution was validated and landed"), "the suppressed landing never arrives as a later notification");
  } finally {
    await scenario.cleanup();
  }
});

test("#160 a checkpoint released before the suppressed landing is a legitimate pre-completion delivery, not a stale one", async () => {
  const scenario = await setupInterruptedSiblingPair("watch-precompletion");
  try {
    const { controller, started, taskA, taskB, messages } = scenario;
    // Boundary clarification from the #160 production probe: a deadline that
    // fires while the watch is still armed — before the suppressed landing —
    // is a legitimate checkpoint delivery, never classified as stale, and it
    // consumes the one-shot subscription itself.
    const arm = armControlledWatch(controller, started.executionId, 1_200);
    try {
      // Inside the try so arm.release() always runs on failure; an early
      // throw would otherwise leave the global timer shims installed.
      assert.equal(arm.armed.replaced, false);
      arm.fireDeadline();
      await waitFor(() => watchEvents(messages).length === 1);
      const checkpoint = watchEvents(messages)[0]!;
      assert.ok(checkpoint.content.includes(started.executionId), "the checkpoint names the execution");
      assert.ok(checkpoint.content.includes(taskB), "the checkpoint reports the still-active sibling");
      const internals = controller as unknown as { watches: Map<string, unknown> };
      assert.equal(internals.watches.has(started.executionId), false, "the one-shot subscription was consumed by its own firing");
      assert.equal(arm.wasCleared(), false, "the pre-completion firing was a legitimate delivery, not a cancellation");
      // A second release is inert: the consumed subscription cannot fire
      // again and cannot be resurrected by a later landing.
      arm.fireDeadline();
      assert.equal(watchEvents(messages).length, 1, "the one-shot checkpoint delivers once");
    } finally {
      arm.release();
    }

    // The suppressed force-merge still folds B into the direct result with no
    // duplicate completion and no second checkpoint.
    const landed = await controller.forceMerge({
      executionId: started.executionId,
      taskId: taskA,
      mergeAnyhow: false,
      instructionId: "dedupe-watch-precompletion",
      actor: "model",
    });
    assert.equal(landed.tasks[0]?.state, "landed");
    assert.ok(landed.completionAggregate?.includes(taskB), "the direct result still names the outstanding sibling");
    assert.equal(watchEvents(messages).length, 1, "the pre-completion checkpoint is the only watch delivery; the suppressed landing adds no stale one");
    assert.equal(completionEvents(messages).length, 0, "no completion notification follows the suppressed landing");

    // B's own executor-driven completion is a distinct event and still wakes.
    await waitFor(() => controller.inspect(started.executionId).tasks.every((task) => task.state === "landed"));
    await waitFor(() => completionEvents(messages).length === 1);
  } finally {
    await scenario.cleanup();
  }
});

test("#160 a queued checkpoint snapshot is retired by the suppressed completion instead of delivering after its window fires", async () => {
  const scenario = await setupInterruptedSiblingPair("watch-queued-snapshot");
  try {
    const { controller, started, taskA, taskB, messages } = scenario;
    // #160 non-vacuous queued-state proof: the deadline fires BEFORE the
    // suppressed landing, so a real checkpoint snapshot is queued with its
    // 25 ms delivery window captured; the merge's cancelWatch must retire
    // that queued snapshot before the window runs.
    const arm = armControlledWatch(controller, started.executionId, 1_200, { captureDeliveryTimers: true });
    try {
      // Inside the try so arm.release() always runs on failure; an early
      // throw would otherwise leave the global timer shims installed.
      assert.equal(arm.armed.replaced, false);
      arm.fireDeadline();
      assert.equal(arm.deliveryTimers.length, 1, "the production delivery window was captured");
      const internals = controller as unknown as {
        watches: Map<string, unknown>;
        pendingWatchInspections: Array<{ executionId: string }>;
        watchDeliveryTimer?: unknown;
      };
      assert.equal(internals.watches.has(started.executionId), false, "the firing consumed the one-shot subscription");
      assert.ok(internals.pendingWatchInspections.some((entry) => entry.executionId === started.executionId), "a checkpoint snapshot is genuinely queued before the landing");
      assert.equal(internals.watchDeliveryTimer, arm.deliveryTimers[0]!.handle, "the captured delivery window is the production watchDeliveryTimer");

      const landed = await controller.forceMerge({
        executionId: started.executionId,
        taskId: taskA,
        mergeAnyhow: false,
        instructionId: "dedupe-watch-queued",
        actor: "model",
      });
      assert.equal(landed.tasks[0]?.state, "landed");
      assert.ok(landed.completionAggregate?.includes(taskB), "the direct result still names the outstanding sibling");
      assert.equal(arm.wasCleared(), false, "the deadline was already consumed; cancellation retires the queued snapshot instead");
      assert.ok(!internals.pendingWatchInspections.some((entry) => entry.executionId === started.executionId), "the queued checkpoint snapshot was retired by the suppressed completion");
      assert.equal(completionEvents(messages).length, 0, "no completion notification follows the suppressed landing");

      // Release the captured delivery window after the retirement: the
      // production delivery runs over the emptied pending list and delivers
      // no stale checkpoint while B is still active.
      arm.deliveryTimers[0]!.fire();
      assert.equal(internals.watchDeliveryTimer, undefined, "the delivery window closed without scheduling anything");
      assert.equal(watchEvents(messages).length, 0, "the retired queued checkpoint never delivers");
    } finally {
      arm.release();
    }

    // B's own executor-driven completion is a distinct event and still wakes.
    await waitFor(() => controller.inspect(started.executionId).tasks.every((task) => task.state === "landed"));
    await waitFor(() => completionEvents(messages).length === 1);
  } finally {
    await scenario.cleanup();
  }
});

test("#160 without watch cancellation the released deadline delivers a stale checkpoint (negative control)", async () => {
  // A long sibling window keeps B active through even a slow merge, so the
  // stale checkpoint delivery in this test can only be suppressed by real
  // cancellation, never by B finishing first.
  const scenario = await setupInterruptedSiblingPair("watch-negative-control", { siblingDelayMs: 30_000 });
  try {
    const { controller, started, taskA, taskB, messages } = scenario;
    const arm = armControlledWatch(controller, started.executionId, 1_200);
    try {
      // Inside the try so arm.release() always runs on failure; an early
      // throw would otherwise leave the global timer shims installed.
      assert.equal(arm.armed.replaced, false);
      // Bounded private mutation, test-side only and never landed in
      // production: remove the cancellation to demonstrate that the
      // suppression tests above are genuinely sensitive to it.
      const internals = controller as unknown as { cancelWatch: (executionId: string) => boolean };
      const productionCancelWatch = internals.cancelWatch;
      internals.cancelWatch = () => false;
      try {
        const landed = await controller.forceMerge({
          executionId: started.executionId,
          taskId: taskA,
          mergeAnyhow: false,
          instructionId: "dedupe-watch-negative",
          actor: "model",
        });
        assert.equal(landed.tasks[0]?.state, "landed");

        // With the cancellation removed the armed subscription survives the
        // suppressed completion; releasing the deadline now delivers the
        // stale checkpoint the production cancelWatch would have retired.
        arm.fireDeadline();
        await waitFor(() => watchEvents(messages).length === 1);
        const stale = watchEvents(messages)[0]!;
        assert.ok(stale.content.includes(started.executionId), "the stale checkpoint names the execution");
        assert.ok(stale.content.includes(taskB), "the stale checkpoint fires while the sibling is still active");
      } finally {
        internals.cancelWatch = productionCancelWatch;
      }
    } finally {
      arm.release();
    }
  } finally {
    await scenario.cleanup();
  }
});

test("#117 a conflicted model force-merge keeps its failure wake and conflict gate", async () => {
  for (const mode of ["quiet", "noisy"] as const) {
    const messages: SubtaskEventMessage[] = [];
    const scenario = await setupInterruptedMergeTask(`conflict-force-${mode}`, {
      sendMessage: (message: SubtaskEventMessage) => messages.push(message),
    }, { notificationMode: mode });
    try {
      const { controller, started, taskId } = scenario;
      // Main diverges on the checkpoint's file, so the forced landing plan
      // conflicts and mergeAnyhow materializes the markers in main.
      await writeFile(join(scenario.root, "draft.txt"), "main diverged\n", "utf8");
      const inspection = await controller.forceMerge({
        executionId: started.executionId,
        taskId,
        mergeAnyhow: true,
        instructionId: `dedupe-conflict-force-${mode}`,
        actor: "model",
      });
      assert.equal(inspection.tasks[0]?.state, "conflicted");
      assert.equal(inspection.completionAggregate, undefined, "a conflicted landing is not a confirmed landing; nothing folds in");

      // Suppression is completion-only: the failure wake with the conflict
    // gate diagnostic is still delivered.
      await waitFor(() => failureEvents(messages).length === 1);
      const failure = failureEvents(messages)[0]!;
      assert.match(failure.content, /requires recovery attention at state CONFLICTED/);
      assert.ok(failure.content.includes("draft.txt"), "the gate names the conflicted path");
      assert.ok(failure.content.includes("SubtasksMarkClean"), "recovery still points at SubtasksMarkClean");
      assert.equal(completionEvents(messages).length, 0);

      // The gate stays active for subsequent landings.
      const prompt = controller.criticalPrompt();
      assert.ok(prompt?.includes("CRITICAL REVIEW-GATE WORKSPACE CONFLICT"));
      assert.ok(prompt?.includes("SubtasksMarkClean"));
    } finally {
      await scenario.cleanup();
    }
  }
});
