/**
 * #682 slice 3: SubtasksWatch through the canonical managed-tool boundary.
 *
 * Watch is the async case. The shared invocation returns only the arm
 * acknowledgement. The later one-shot checkpoint is delivered by the
 * controller's existing notification path (`pi.sendMessage`). The shared
 * boundary adds no callback transport and no Watch-specific handler.
 *
 * Verified here, in process, against the real manager, controller, and wake
 * delivery (see ./managed-tool-fixtures.ts for what is faked):
 * - The shared definition has Pi's schema and description, and both paths
 *   reach the same private handler.
 * - Validation, lookup, and inactive-execution errors match Pi.
 * - Arming from either path uses the controller's one-shot subscription for
 *   that execution: the arm is immediate, a later arm from either path
 *   replaces it, an actionable event cancels it, and once the deadline passes
 *   exactly one checkpoint is delivered. Nothing repeats until the watch is
 *   explicitly re-armed.
 * - Missing, other-call, other-tool, throwing, and policy-denied admissions
 *   fail closed before the handler runs and leave the armed subscription
 *   untouched. Stale owner scopes do the same.
 *
 * Deadlines use node:test mock timers, so these tests never race the real
 * clock. No MCP transport, real owner admission, or native-CLI behavior is
 * covered.
 */
import assert from "node:assert/strict";
import test, { mock } from "node:test";
import type { BackgroundExecutionController, BackgroundWatchSubscription } from "../src/execution/background-controller";
import type { ManagedToolAdmission } from "../src/execution/tool";
import {
  SUBTASK_TOOL_NAMES,
  assertEnvelopeParity,
  assertManagedEnvelope,
  managedToolFixture,
  queuedTask,
  type ManagedToolFixture,
  type ManagedToolFixtureOptions,
} from "./managed-tool-fixtures";
import { controllerInternals, settleOldestUnsettled } from "./helpers/background-controller-fixtures";

const WATCH = "SubtasksWatch";
const WATCH_EVENT = "[pi-review-subtask-watch]";
/** WakeDelivery batches due checkpoints for this long before delivering them. */
const DELIVERY_WINDOW_MS = 25;
const call = (toolCallId: string) => ({ toolCallId });

type SpyBinding = { toolCallId: string; host?: { ctx: unknown } };
type Handler = (action: string, toolName: string, params: unknown, binding: SpyBinding) => Promise<Record<string, unknown>>;
type SentMessage = { message: { customType: string; content: string; details?: Record<string, any> }; options?: Record<string, unknown> };

/** Records every call that reaches the private canonical handler. */
function spyHandler(manager: unknown): { calls: Array<{ action: string; toolName: string; params: unknown; binding: SpyBinding }>; restore(): void } {
  const instance = manager as { executeAction: Handler };
  const original = instance.executeAction.bind(manager);
  const calls: Array<{ action: string; toolName: string; params: unknown; binding: SpyBinding }> = [];
  instance.executeAction = async (action, toolName, params, binding) => {
    calls.push({ action, toolName, params, binding });
    return original(action, toolName, params, binding);
  };
  return { calls, restore: () => { instance.executeAction = original; } };
}

/** The real controller behind the fixture manager. */
function controllerOf(fixture: ManagedToolFixture): BackgroundExecutionController {
  return (fixture.manager as unknown as { controller: BackgroundExecutionController }).controller;
}

/** The controller's armed one-shot subscriptions, keyed by execution id. */
function armedWatches(fixture: ManagedToolFixture): Map<string, { subscription: BackgroundWatchSubscription }> {
  return (controllerOf(fixture) as unknown as { wakes: { watches: Map<string, { subscription: BackgroundWatchSubscription }> } }).wakes.watches;
}

/**
 * Gives the fixture's Pi stub the delivery method the controller already uses
 * for notifications, and records what it sends.
 */
function recordDeliveries(fixture: ManagedToolFixture): { sent: SentMessage[]; checkpoints(): SentMessage[] } {
  const pi = (fixture.manager as unknown as { input: { pi: Record<string, unknown> } }).input.pi;
  const sent: SentMessage[] = [];
  pi.sendMessage = (message: SentMessage["message"], options?: Record<string, unknown>) => { sent.push({ message, options }); };
  return { sent, checkpoints: () => sent.filter(({ message }) => message.content.startsWith(WATCH_EVENT)) };
}

/** Queues one task through shared Start. maxWorkers = 0 keeps it active. */
async function startQueued(fixture: ManagedToolFixture, title: string): Promise<{ executionId: string; taskId: string }> {
  fixture.admission.admit(`start-${title}`, "SubtasksStart", { tasks: [queuedTask(title)] });
  const started = await fixture.shared("start").invoke(call(`start-${title}`));
  assertManagedEnvelope(started, false, "start");
  const details = started.details as Record<string, any>;
  assert.equal(details.tasks[0].state, "queued");
  return { executionId: details.executionId, taskId: details.tasks[0].taskId };
}

async function sharedWatch(fixture: ManagedToolFixture, toolCallId: string, params: unknown, admission?: ManagedToolAdmission): Promise<Record<string, any>> {
  fixture.admission.admit(toolCallId, WATCH, params);
  return fixture.shared("watch", admission).invoke(call(toolCallId));
}

function piWatch(fixture: ManagedToolFixture, toolCallId: string, params: unknown): Promise<Record<string, any>> {
  return fixture.piExecute(WATCH)(toolCallId, params, undefined, undefined, {});
}

/** Runs `body` with mocked setTimeout/clearTimeout, then restores real timers. */
async function withMockTimers<T>(body: () => Promise<T>): Promise<T> {
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    return await body();
  } finally {
    mock.timers.reset();
  }
}

/** Advances past a deadline and the delivery batching window. */
function elapse(ms: number): void {
  mock.timers.tick(ms);
  mock.timers.tick(DELIVERY_WINDOW_MS);
}

test("shared SubtasksWatch has Pi's schema and description and reaches the same canonical handler", async () => {
  const fixture = await managedToolFixture();
  const spy = spyHandler(fixture.manager);
  try {
    assert.deepEqual(fixture.tools.map((tool) => tool.name), SUBTASK_TOOL_NAMES, "Pi registration is unchanged");
    const definition = fixture.shared("watch");
    const tool = fixture.piTool(WATCH);
    assert.equal(definition.name, WATCH);
    assert.equal(definition.action, "watch");
    assert.deepEqual(definition.parameters, tool.parameters);
    assert.equal(definition.description, tool.description);
    assert.deepEqual(Object.keys(tool.parameters.properties), ["executionId", "after"]);

    const ctx = { marker: "pi-ctx" };
    const params = { executionId: "exec-missing-682", after: "30s" };
    await fixture.piExecute(WATCH)("pi-watch", params, undefined, undefined, ctx);
    await sharedWatch(fixture, "owner-watch", params);
    assert.deepEqual(spy.calls.map(({ action, toolName, params: p }) => [action, toolName, p]), [
      ["watch", WATCH, params],
      ["watch", WATCH, params],
    ]);
    assert.equal(spy.calls[0]!.binding.host?.ctx, ctx, "Pi keeps its tool call context");
    assert.equal(spy.calls[1]!.binding.toolCallId, "owner-watch");
    assert.equal(spy.calls[1]!.binding.host, undefined, "the shared binding carries no host context");
  } finally {
    spy.restore();
    await fixture.dispose();
  }
});

test("shared Watch validation, lookup, and inactive-execution errors match Pi", async () => {
  const fixture = await managedToolFixture();
  try {
    const invalid: unknown[] = [
      "not an object",
      {},
      { executionId: "exec-x" },
      { executionId: "exec-x", after: 30 },
      { executionId: "exec-x", after: "0s" },
      { executionId: "exec-x", after: "169h" },
      { executionId: "exec-x", after: "30s", taskId: "task-x" },
    ];
    for (const [index, params] of invalid.entries()) {
      const viaPi = await piWatch(fixture, `pi-invalid-${index}`, params);
      const viaShared = await sharedWatch(fixture, `owner-invalid-${index}`, params);
      assertManagedEnvelope(viaShared, true, JSON.stringify(params));
      assert.match(viaPi.content[0].text, /^Invalid SubtasksWatch request: /);
      assert.deepEqual(viaShared, viaPi, JSON.stringify(params));
    }

    const live = await startQueued(fixture, "WATCH-LOOKUP-682");
    const settled = await startQueued(fixture, "WATCH-SETTLED-682");
    await settleOldestUnsettled(controllerOf(fixture), settled.executionId, "settled");
    const lookups: Array<[unknown, RegExp]> = [
      [{ executionId: "exec-unknown-682", after: "30s" }, /exec-unknown-682/],
      [{ executionId: settled.executionId, after: "30s" }, /has no active tasks to watch/],
    ];
    for (const [index, [params, expected]] of lookups.entries()) {
      // The same call id on both paths keeps the failure projection identical.
      const viaShared = await sharedWatch(fixture, `owner-lookup-${index}`, params);
      const viaPi = await piWatch(fixture, `owner-lookup-${index}`, params);
      assertManagedEnvelope(viaShared, true, JSON.stringify(params));
      assert.match(viaShared.content[0].text, /^SubtasksWatch failed: /);
      assert.match(viaShared.content[0].text, expected);
      assertEnvelopeParity(viaShared, viaPi, JSON.stringify(params));
      assert.doesNotMatch(JSON.stringify(viaShared), /WATCH-LOOKUP-682/, "an unrelated execution is not replayed");
    }
    assert.equal(armedWatches(fixture).size, 0, "no failed request armed anything");
    assert.ok(live.executionId);
    assert.deepEqual(fixture.observedErrors.map(([id]) => id), [
      ...invalid.map((_, index) => `pi-invalid-${index}`),
      ...lookups.map((_, index) => `owner-lookup-${index}`),
    ], "only Pi feeds the returned-error observer");
  } finally {
    await fixture.dispose();
  }
});

test("Pi and shared Watch arm, replace, and deliver one controller checkpoint", async () => {
  const fixture = await managedToolFixture();
  const deliveries = recordDeliveries(fixture);
  try {
    const { executionId } = await startQueued(fixture, "watched");
    await withMockTimers(async () => {
      // Immediate arm: the acknowledgement is the result, and the subscription
      // exists before any time passes.
      const first = await sharedWatch(fixture, "owner-watch-1", { executionId, after: "1h" });
      assertManagedEnvelope(first, false, "shared arm");
      assert.match(first.content[0].text, new RegExp(`^SubtasksWatch armed for ${executionId}; if work is still active after 1h, one checkpoint notification will trigger a turn\\. An earlier`));
      assert.deepEqual(
        { action: first.details.action, executionId: first.details.executionId, afterMs: first.details.afterMs, replaced: first.details.replaced },
        { action: "watch", executionId, afterMs: 3_600_000, replaced: false },
      );
      assert.equal(armedWatches(fixture).get(executionId)?.subscription.armedAt, first.details.armedAt);

      // Either path replaces the single per-execution subscription.
      const viaPi = await piWatch(fixture, "pi-watch-2", { executionId, after: "10s" });
      const viaShared = await sharedWatch(fixture, "owner-watch-3", { executionId, after: "10s" });
      assertManagedEnvelope(viaPi, false, "Pi replace");
      assertManagedEnvelope(viaShared, false, "shared replace");
      assert.equal(viaPi.details.replaced, true);
      assert.equal(viaShared.details.replaced, true);
      assert.match(viaShared.content[0].text, /It replaced the prior watch for this execution\./);
      assertEnvelopeParity(viaShared, viaPi, "arm result parity");
      assert.equal(armedWatches(fixture).size, 1);
      assert.equal(armedWatches(fixture).get(executionId)?.subscription.armedAt, viaShared.details.armedAt);

      mock.timers.tick(9_999);
      assert.equal(deliveries.sent.length, 0, "nothing is delivered before the deadline");
      elapse(1);
      assert.equal(deliveries.checkpoints().length, 1, "the deadline delivers one checkpoint");
      const [checkpoint] = deliveries.checkpoints();
      assert.equal(checkpoint!.message.customType, "pi-review-subtask-watch");
      assert.match(checkpoint!.message.content, new RegExp(`one-shot checkpoint for execution ${executionId} is due`));
      assert.deepEqual(checkpoint!.options, { deliverAs: "steer", triggerTurn: true });
      assert.equal(checkpoint!.message.details?.executions[0].executionId, executionId);
      assert.equal(armedWatches(fixture).size, 0, "the one-shot subscription is consumed");

      // The replaced 1h deadline and the fired one never deliver again.
      elapse(2 * 3_600_000);
      assert.equal(deliveries.sent.length, 1, "no repeat and no replaced deadline fires");

      // Another checkpoint needs an explicit re-arm, which is not a replacement.
      const rearmed = await sharedWatch(fixture, "owner-watch-4", { executionId, after: "5s" });
      assert.equal(rearmed.details.replaced, false);
      elapse(5_000);
      assert.equal(deliveries.checkpoints().length, 2);
    });
    assert.deepEqual(fixture.observedErrors, []);
  } finally {
    await fixture.dispose();
  }
});

test("an actionable controller event cancels a shared-armed Watch; a state event does not", async () => {
  const fixture = await managedToolFixture();
  const deliveries = recordDeliveries(fixture);
  try {
    const { executionId, taskId } = await startQueued(fixture, "cancelled");
    const controller = controllerOf(fixture);
    const task = controllerInternals(controller).groups.get(executionId)!.tasks.find((candidate) => candidate.taskId === taskId)!;
    await withMockTimers(async () => {
      for (const kind of ["completion", "failure"] as const) {
        const armed = await sharedWatch(fixture, `owner-cancel-${kind}`, { executionId, after: "10s" });
        assertManagedEnvelope(armed, false, kind);
        assert.equal(armed.details.replaced, false, "the previous watch was already cancelled or consumed");
        await controllerInternals(controller).wake(task, kind, `${kind} for ${taskId}`);
        assert.equal(armedWatches(fixture).size, 0, `${kind} cancels the armed watch`);
        elapse(10_000);
        assert.equal(deliveries.checkpoints().length, 0, `${kind}: the cancelled checkpoint never fires`);
      }
      // Quiet-mode state transitions are not actionable and leave the watch armed.
      await sharedWatch(fixture, "owner-cancel-state", { executionId, after: "10s" });
      await controllerInternals(controller).wake(task, "state", `state for ${taskId}`);
      assert.equal(armedWatches(fixture).size, 1);
      elapse(10_000);
      assert.equal(deliveries.checkpoints().length, 1, "exactly one later checkpoint");
      elapse(3_600_000);
      assert.equal(deliveries.checkpoints().length, 1);
    });
  } finally {
    await fixture.dispose();
  }
});

test("denied and wrong-owner Watch calls fail closed before the handler and leave the armed watch untouched", async () => {
  let liveAllowed = new Set(SUBTASK_TOOL_NAMES);
  const options: ManagedToolFixtureOptions = { liveToolCallAllowed: (name) => liveAllowed.has(name) };
  const fixture = await managedToolFixture(options);
  const deliveries = recordDeliveries(fixture);
  const spy = spyHandler(fixture.manager);
  try {
    const { executionId } = await startQueued(fixture, "guarded");
    const params = { executionId, after: "10s" };
    await withMockTimers(async () => {
      const armed = await piWatch(fixture, "pi-armed", { executionId, after: "1h" });
      assertManagedEnvelope(armed, false, "Pi arm");
      const subscription = armedWatches(fixture).get(executionId)!.subscription;
      fixture.admission.admit("owner-inspect-only", "SubtasksInspect", params);
      const throwing: ManagedToolAdmission = { resolveCall: () => { throw new Error("admission store unavailable"); } };
      const otherTool: ManagedToolAdmission = { resolveCall: (_id, toolName) => toolName === "SubtasksStart" ? { params } : undefined };
      const refusals: Array<[string, () => Promise<Record<string, any>>, RegExp]> = [
        ["no admission record", () => fixture.shared("watch").invoke(call("owner-never-admitted")), /no owner admission for this call and tool/],
        ["admitted for another tool", () => fixture.shared("watch").invoke(call("owner-inspect-only")), /no owner admission for this call and tool/],
        ["resolver for another tool", () => fixture.shared("watch", otherTool).invoke(call("owner-other")), /no owner admission for this call and tool/],
        ["admission throws", () => fixture.shared("watch", throwing).invoke(call("owner-throws")), /owner call admission could not be verified/],
        ["empty call id", () => fixture.shared("watch").invoke(call("")), /missing owner-assigned call id/],
        ["live policy denies Watch", async () => {
          liveAllowed = new Set(SUBTASK_TOOL_NAMES.filter((name) => name !== WATCH));
          try {
            return await sharedWatch(fixture, "owner-denied", params);
          } finally {
            liveAllowed = new Set(SUBTASK_TOOL_NAMES);
          }
        }, /not allowed by this owner's live call policy/],
      ];
      for (const [label, invoke, expected] of refusals) {
        const before = spy.calls.length;
        const response = await invoke();
        assertManagedEnvelope(response, true, label);
        assert.match(response.content[0].text, /^SubtasksWatch failed closed: /, label);
        assert.match(response.content[0].text, expected, label);
        assert.equal(spy.calls.length, before, `${label}: refused before the handler`);
        assert.equal(armedWatches(fixture).get(executionId)?.subscription, subscription, `${label}: the armed watch is not replaced or cancelled`);
      }
      elapse(10_000);
      assert.equal(deliveries.sent.length, 0, "no refused 10s request armed a checkpoint");
      elapse(3_600_000);
      assert.equal(deliveries.checkpoints().length, 1, "only the Pi-armed checkpoint fires, once");
    });
    assert.deepEqual(fixture.observedErrors, [], "refusals never touch Pi preflight accounting");
  } finally {
    spy.restore();
    await fixture.dispose();
  }
});

test("a Watch call admitted by one owner cannot be invoked through another owner's definition", async () => {
  const ownerA = await managedToolFixture();
  const ownerB = await managedToolFixture();
  const deliveriesA = recordDeliveries(ownerA);
  const deliveriesB = recordDeliveries(ownerB);
  const spyA = spyHandler(ownerA.manager);
  const spyB = spyHandler(ownerB.manager);
  try {
    const a = await startQueued(ownerA, "owner-a");
    const b = await startQueued(ownerB, "owner-b");
    await withMockTimers(async () => {
      assertManagedEnvelope(await piWatch(ownerA, "pi-a", { executionId: a.executionId, after: "1h" }), false, "owner A arm");
      assertManagedEnvelope(await piWatch(ownerB, "pi-b", { executionId: b.executionId, after: "1h" }), false, "owner B arm");
      const subscriptionA = armedWatches(ownerA).get(a.executionId)!.subscription;
      const subscriptionB = armedWatches(ownerB).get(b.executionId)!.subscription;
      const unchanged = (label: string) => {
        assert.equal(armedWatches(ownerA).size, 1, label);
        assert.equal(armedWatches(ownerB).size, 1, label);
        assert.equal(armedWatches(ownerA).get(a.executionId)?.subscription, subscriptionA, `${label}: owner A's watch is untouched`);
        assert.equal(armedWatches(ownerB).get(b.executionId)?.subscription, subscriptionB, `${label}: owner B's watch is untouched`);
      };

      // A valid Watch admission held by owner A, for owner A's execution.
      ownerA.admission.admit("owner-a-watch", WATCH, { executionId: a.executionId, after: "10s" });
      const handlerCalls = [spyA.calls.length, spyB.calls.length];
      const crossed = await ownerB.shared("watch").invoke(call("owner-a-watch"));
      assertManagedEnvelope(crossed, true, "owner A's call through owner B");
      assert.match(crossed.content[0].text, /^SubtasksWatch failed closed: no owner admission for this call and tool/);
      assert.deepEqual([spyA.calls.length, spyB.calls.length], handlerCalls, "refused before either handler");
      unchanged("owner A's call through owner B");

      // A request owner B admits itself runs only against owner B's controller,
      // which has no record of owner A's execution.
      ownerB.admission.admit("owner-b-targets-a", WATCH, { executionId: a.executionId, after: "10s" });
      const foreign = await ownerB.shared("watch").invoke(call("owner-b-targets-a"));
      assertManagedEnvelope(foreign, true, "owner B targeting owner A's execution");
      assert.match(foreign.content[0].text, /^SubtasksWatch failed: /);
      assert.equal(spyA.calls.length, handlerCalls[0], "owner A's handler never ran for owner B");
      unchanged("foreign execution");

      // The same admitted call is valid through its own owner's definition.
      const own = await ownerA.shared("watch").invoke(call("owner-a-watch"));
      assertManagedEnvelope(own, false, "owner A's own definition");
      assert.equal(own.details.replaced, true);
      assert.equal(armedWatches(ownerB).get(b.executionId)?.subscription, subscriptionB, "owner B's watch is still untouched");

      elapse(10_000);
      assert.equal(deliveriesA.checkpoints().length, 1, "owner A's replacement fires once");
      assert.equal(deliveriesB.sent.length, 0, "owner B received nothing");
      elapse(3_600_000);
      assert.equal(deliveriesA.checkpoints().length, 1);
      assert.equal(deliveriesB.checkpoints().length, 1, "owner B's own Pi watch fires once");
    });
  } finally {
    spyA.restore();
    spyB.restore();
    await ownerA.dispose();
    await ownerB.dispose();
  }
});

test("Watch is refused when not exposed at launch or when its owner scope is stale", async () => {
  const notLaunched = await managedToolFixture({
    activeTools: ["read", "bash", "SubtasksStart", "SubtasksInspect"],
    liveToolCallAllowed: () => true,
  });
  try {
    const { executionId } = await startQueued(notLaunched, "not-launched");
    const refused = await sharedWatch(notLaunched, "owner-not-launched", { executionId, after: "10s" });
    assertManagedEnvelope(refused, true, "not launched");
    assert.match(refused.content[0].text, /SubtasksWatch is not currently exposed by this owner/);
    assert.equal(armedWatches(notLaunched).size, 0);
  } finally {
    await notLaunched.dispose();
  }

  const fixture = await managedToolFixture();
  const spy = spyHandler(fixture.manager);
  try {
    const { executionId } = await startQueued(fixture, "stale");
    const params = { executionId, after: "10s" };
    fixture.admission.admit("owner-stale", WATCH, params);
    const before = spy.calls.length;
    const bound = fixture.shared("watch");
    // Records the execution root for dispose() before detach drops the group map.
    assert.equal(fixture.groupCount(), 1);
    await fixture.manager.detach();
    assert.throws(() => fixture.shared("watch"), /only while its owner session is live/);
    const stale = await bound.invoke(call("owner-stale"));
    assertManagedEnvelope(stale, true, "stale scope");
    assert.match(stale.content[0].text, /owner session that bound this tool is no longer live/);
    assert.equal(spy.calls.length, before, "a stale binding never reaches the handler");
    assert.equal(armedWatches(fixture).size, 0);
  } finally {
    spy.restore();
    await fixture.dispose();
  }
});
