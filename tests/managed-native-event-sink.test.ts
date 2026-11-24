/**
 * #682: canonical managed outcome and one-shot Watch events reach an explicit
 * native owner sink (`nativeEventSink`) instead of Pi or the generic notify.
 *
 * EVIDENCE SCOPE: the real `BackgroundExecutionController` and its real
 * `WakeDelivery`, with no Pi transport (`pi: undefined`, as the native owner
 * constructs it). The completion tests run one real task through a
 * deterministic external fake executor that lands a file; the Watch,
 * payload-isolation, observation-failure, quiet, launch-notice, and parity tests use the no-dispatch bounded-scaling
 * configuration and drive the controller's own wake/watch entry points. No
 * native owner, provider, MCP transport, or host lane is exercised. Every
 * scratch repository is removed and every controller shut down on exit.
 */
import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { normalizeConfig } from "../src/config";
import { BackgroundExecutionController } from "../src/execution/background-controller";
import type { ManagedNativeEvent, ManagedNativeEventSink } from "../src/execution/wake-delivery";
import { createNativeManagedConversationOwner } from "../src/session-host/native-managed-conversation-owner";
import { createState } from "../src/state";
import { boundedScalingConfig, controllerInternals, initGitRepo, settleOldestUnsettled, waitFor } from "./helpers/background-controller-fixtures";

type Input = { pi: unknown; nativeEventSink?: ManagedNativeEventSink; config: { execution?: { subtaskNotifications?: string } } };
const inputOf = (controller: BackgroundExecutionController) => (controller as unknown as { input: Input }).input;
const wakesOf = (controller: BackgroundExecutionController) => (controller as unknown as {
  wakes: { watches: Map<string, unknown>; setLaunchNoticeGate(executionId: string, gate: Promise<void>): void };
}).wakes;
const flush = () => new Promise<void>((resolvePromise) => setImmediate(resolvePromise));

/** A real landing controller with no Pi transport and the given sink. */
async function landingScenario(sink: ManagedNativeEventSink): Promise<{
  controller: BackgroundExecutionController;
  executionId: string;
  taskId: string;
  notices: string[];
  cleanup(): Promise<void>;
}> {
  const root = await mkdtemp(join(tmpdir(), "pi-review-native-sink-"));
  let controller: BackgroundExecutionController | undefined;
  try {
    await initGitRepo(root);
    const executor = join(root, "executor.cjs");
    await writeFile(executor, [
      "#!/usr/bin/env node",
      "const fs=require('node:fs');process.stdin.resume();process.stdin.on('end',()=>{",
      "fs.writeFileSync('landed.txt','landed\\n');",
      "console.log(JSON.stringify({type:'session',sessionId:process.env.PI_REVIEW_EXECUTOR_SESSION_ID}));",
      "console.log(JSON.stringify({type:'assistant',text:'completed requested edit'}));",
      "});",
    ].join("\n"), "utf8");
    await chmod(executor, 0o755);
    const config = normalizeConfig({
      enabled: true,
      review: { activeReviewers: [] },
      externalAgents: { fake: { adapter: "run-as-binary", command: executor, execution: { protocol: "pi-review-executor-jsonl-v1" } } },
      execution: {
        maxWorkers: 1,
        workerResources: { default: { selection: { source: "external", id: "fake" }, maxConcurrent: 1 } },
        routes: { execute: [{ resourceId: "default" }], research: [] },
      },
    });
    const notices: string[] = [];
    controller = new BackgroundExecutionController({
      pi: undefined,
      config,
      state: createState(),
      cwd: () => root,
      notify: (message) => { notices.push(message); },
      nativeEventSink: sink,
    });
    const started = await controller.start([{ title: "sink landing", instructions: "write landed.txt", acceptanceCriteria: ["landed.txt exists"] }]);
    const owned = controller;
    return {
      controller: owned,
      executionId: started.executionId,
      taskId: started.tasks[0]!.taskId,
      notices,
      cleanup: async () => {
        try {
          await owned.shutdown();
        } finally {
          await rm(root, { recursive: true, force: true });
        }
      },
    };
  } catch (error) {
    try {
      await controller?.shutdown();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
    throw error;
  }
}

/** A no-dispatch controller (queued tasks stay active) with no Pi transport. */
async function boundedScenario(sink: ManagedNativeEventSink | undefined): Promise<{
  controller: BackgroundExecutionController;
  executionId: string;
  notices: string[];
  cleanup(): Promise<void>;
}> {
  const root = await mkdtemp(join(tmpdir(), "pi-review-native-sink-bounded-"));
  let controller: BackgroundExecutionController | undefined;
  try {
    await initGitRepo(root, {});
    const notices: string[] = [];
    controller = new BackgroundExecutionController({
      pi: undefined,
      config: boundedScalingConfig(),
      state: createState(),
      cwd: () => root,
      notify: (message) => { notices.push(message); },
      ...(sink === undefined ? {} : { nativeEventSink: sink }),
    });
    const started = await controller.start([
      { title: "one", instructions: "work", acceptanceCriteria: ["done"] },
      { title: "two", instructions: "work", acceptanceCriteria: ["done"] },
    ]);
    const owned = controller;
    return {
      controller: owned,
      executionId: started.executionId,
      notices,
      cleanup: async () => {
        try {
          await owned.shutdown();
        } finally {
          await rm(root, { recursive: true, force: true });
        }
      },
    };
  } catch (error) {
    try {
      await controller?.shutdown();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
    throw error;
  }
}

test("a real landed completion reaches the native sink once, with identity, and never the generic notify", async () => {
  const events: ManagedNativeEvent[] = [];
  const scenario = await landingScenario((event) => { events.push(event); });
  try {
    const { controller, executionId, taskId, notices } = scenario;
    await waitFor(() => controller.inspect(executionId).tasks[0]?.state === "landed");
    await waitFor(() => events.some((event) => event.customType === "pi-review-subtask-event" && event.kind === "completion"));
    // Quiet (default): ordinary state transitions are suppressed before the sink.
    assert.deepEqual(events.map((event) => event.customType === "pi-review-subtask-event" ? event.kind : event.customType), ["completion"]);
    const completion = events[0]!;
    assert.ok(completion.customType === "pi-review-subtask-event");
    assert.equal(completion.executionId, executionId);
    assert.equal(completion.taskId, taskId);
    assert.equal(completion.state, "landed");
    assert.equal(completion.diagnostic, undefined);
    assert.deepEqual(completion.delivery, { deliverAs: "steer", triggerTurn: true });
    assert.ok(completion.content.startsWith(`Task ${taskId} landed independently`));
    assert.match(completion.content, /All requested task outputs have landed/);
    assert.ok(Object.isFrozen(completion));
    assert.ok(notices.every((notice) => !notice.includes(taskId)), "the formatted event is not also sent as a generic notice");
  } finally {
    await scenario.cleanup();
  }
});

test("a throwing or rejecting sink leaves the landed outcome landed, is not retried, and reports one diagnostic", async () => {
  for (const failure of ["throw", "reject"] as const) {
    let calls = 0;
    const scenario = await landingScenario(() => {
      calls += 1;
      if (failure === "throw") throw new Error("sink offline");
      return Promise.reject(new Error("sink offline"));
    });
    try {
      const { controller, executionId, notices } = scenario;
      await waitFor(() => controller.inspect(executionId).tasks[0]?.state === "landed");
      await waitFor(() => notices.some((notice) => notice.includes("could not be delivered")));
      await flush();
      assert.equal(calls, 1, `${failure}: one delivery attempt, no retry`);
      assert.deepEqual(notices.filter((notice) => notice.includes("could not be delivered")),
        ["review gate: task notification could not be delivered: sink offline"]);
      const task = controller.inspect(executionId).tasks[0]!;
      assert.equal(task.state, "landed", `${failure}: sink failure never fails landed work`);
    } finally {
      await scenario.cleanup();
    }
  }
});

test("one-shot Watch checkpoints reach the sink once; re-arm supersedes and an actionable event cancels", async () => {
  const events: ManagedNativeEvent[] = [];
  const scenario = await boundedScenario((event) => { events.push(event); });
  try {
    const { controller, executionId, notices } = scenario;
    const watches = () => events.filter((event) => event.customType === "pi-review-subtask-watch");
    controller.watch(executionId, 60_000);
    const replaced = controller.watch(executionId, 30);
    assert.equal(replaced.replaced, true);
    await waitFor(() => watches().length === 1);
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 150));
    assert.equal(watches().length, 1, "one checkpoint; the superseded arm never fires and nothing repeats");
    const checkpoint = watches()[0]!;
    assert.ok(checkpoint.customType === "pi-review-subtask-watch");
    assert.match(checkpoint.content, /^\[pi-review-subtask-watch\]/);
    assert.deepEqual(checkpoint.executions.map((inspection) => inspection.executionId), [executionId]);
    assert.deepEqual(checkpoint.delivery, { deliverAs: "steer", triggerTurn: true });

    // An actionable outcome retires a pending watch before its own delivery.
    controller.watch(executionId, 60_000);
    assert.equal(wakesOf(controller).watches.size, 1);
    const landed = await settleOldestUnsettled(controller, executionId, "sink");
    await controllerInternals(controller).wake(landed, "completion", "Task landed.");
    assert.equal(wakesOf(controller).watches.size, 0, "the one-shot watch was cancelled");
    const outcome = events.at(-1)!;
    assert.ok(outcome.customType === "pi-review-subtask-event");
    assert.equal(outcome.kind, "completion");
    assert.equal(outcome.taskId, landed.taskId);
    assert.equal(watches().length, 1);
    assert.ok(notices.every((notice) => !notice.includes(executionId)), "nothing fell back to the generic notify");
  } finally {
    await scenario.cleanup();
  }
});

test("the Watch sink payload is detached: mutating it cannot change later controller inspection", async () => {
  const events: ManagedNativeEvent[] = [];
  const scenario = await boundedScenario((event) => {
    events.push(event);
    if (event.customType !== "pi-review-subtask-watch") return;
    // A sink that redacts in place must only touch its own copy.
    const execution = event.executions[0] as unknown as { tasks: Array<{ activity: Array<{ message: string }> }> };
    for (const task of execution.tasks) {
      for (const entry of task.activity) entry.message = "REDACTED";
      task.activity.length = 0;
    }
  });
  try {
    const { controller, executionId } = scenario;
    const seeded = controllerInternals(controller).groups.get(executionId)!.tasks[0]!;
    (controller as unknown as { addActivity(task: unknown, phase: string, message: string): void }).addActivity(seeded, "progress", "original history");
    const before = structuredClone(controller.inspect(executionId));
    assert.ok(before.tasks.some((task) => task.activity.length > 0), "the inspected tasks carry activity entries to protect");
    controller.watch(executionId, 20);
    await waitFor(() => events.some((event) => event.customType === "pi-review-subtask-watch"));
    await flush();
    const after = controller.inspect(executionId);
    assert.deepEqual(after.tasks.map((task) => task.activity), before.tasks.map((task) => task.activity));
    const group = controllerInternals(controller).groups.get(executionId)!;
    assert.ok(group.tasks.every((task) => task.activity.every((entry) => entry.message !== "REDACTED")), "controller history is untouched");
  } finally {
    await scenario.cleanup();
  }
});

test("a Watch sink whose returned promise throws when observed reports one diagnostic and is not retried", async () => {
  class ThrowingObservation extends Promise<void> {
    override then(): never {
      throw new Error("observation failed");
    }
  }
  let calls = 0;
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => { unhandled.push(reason); };
  process.on("unhandledRejection", onUnhandled);
  const scenario = await boundedScenario((event) => {
    if (event.customType !== "pi-review-subtask-watch") return;
    calls += 1;
    return new ThrowingObservation(() => undefined);
  });
  try {
    const { controller, executionId, notices } = scenario;
    controller.watch(executionId, 20);
    await waitFor(() => notices.some((notice) => notice.includes("could not be delivered")));
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
    assert.equal(calls, 1, "one delivery attempt, no retry");
    assert.deepEqual(notices.filter((notice) => notice.includes("could not be delivered")),
      ["review gate: subtask watch notification could not be delivered: observation failed"]);
    assert.deepEqual(unhandled, [], "no rejection escapes the delivery boundary");
    assert.equal(controller.inspect(executionId).activeCount, 2, "the watched work is unaffected");
  } finally {
    process.off("unhandledRejection", onUnhandled);
    await scenario.cleanup();
  }
});

test("quiet suppression, noisy state wakes, and the launch-notice gate apply before the sink", async () => {
  const events: ManagedNativeEvent[] = [];
  const scenario = await boundedScenario((event) => { events.push(event); });
  try {
    const { controller, executionId } = scenario;
    const internals = controllerInternals(controller);
    const task = internals.groups.get(executionId)!.tasks[0]!;
    await internals.wake(task, "state", "RUNNING");
    assert.equal(events.length, 0, "quiet mode suppresses state wakes before the sink");

    inputOf(controller).config.execution!.subtaskNotifications = "noisy";
    let release!: () => void;
    wakesOf(controller).setLaunchNoticeGate(executionId, new Promise<void>((resolvePromise) => { release = resolvePromise; }));
    const pending = internals.wake(task, "state", "RUNNING");
    await flush();
    assert.equal(events.length, 0, "the sink waits behind the launch notice");
    release();
    await pending;
    assert.equal(events.length, 1);
    const state = events[0]!;
    assert.ok(state.customType === "pi-review-subtask-event");
    assert.equal(state.kind, "state");
    assert.equal(state.executionId, executionId);
    assert.equal(state.taskId, task.taskId);
  } finally {
    await scenario.cleanup();
  }
});

test("without a sink the Pi sendMessage path is unchanged and carries the same formatted content", async () => {
  const events: ManagedNativeEvent[] = [];
  const scenario = await boundedScenario((event) => { events.push(event); });
  try {
    const { controller, executionId } = scenario;
    const internals = controllerInternals(controller);
    const task = internals.groups.get(executionId)!.tasks[0]!;
    await internals.wake(task, "failure", "Task failed: synthetic");
    const input = inputOf(controller);
    const sent: Array<{ message: Record<string, any>; options: unknown }> = [];
    delete input.nativeEventSink;
    input.pi = { sendMessage: (message: Record<string, any>, options: unknown) => { sent.push({ message, options }); } };
    await internals.wake(task, "failure", "Task failed: synthetic");
    assert.equal(sent.length, 1);
    const [native] = events;
    assert.ok(native?.customType === "pi-review-subtask-event");
    assert.equal(sent[0]!.message.customType, native.customType);
    assert.equal(sent[0]!.message.content, native.content, "the sink receives the exact Pi content, not a reformatting");
    assert.deepEqual(sent[0]!.message.details, { executionId, taskId: task.taskId, state: task.state, diagnostic: native.diagnostic });
    assert.deepEqual(sent[0]!.options, native.delivery);
    assert.ok(native.diagnostic, "failures carry the curated diagnostic");
  } finally {
    await scenario.cleanup();
  }
});

test("the native owner rejects a malformed event sink before any restore", () => {
  assert.throws(() => createNativeManagedConversationOwner({
    run: { signal: new AbortController().signal, isCurrent: () => true } as never,
    identity: { rowId: "row", backend: "claude", workspace: "/nonexistent", conversationId: "c" } as never,
    stateRoot: "/nonexistent",
    settings: { env: {}, agentDir: "/nonexistent" },
    pi: { executable: "/nonexistent/pi", version: "0.0.0", launchArgs: [] },
    nativeEventSink: 42 as never,
  }), /event sink must be a function/);
});
