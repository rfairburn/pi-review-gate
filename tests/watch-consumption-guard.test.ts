/**
 * Issue #452 residual: consumption-time freshness for one-shot subtask watch
 * checkpoints. The controller's existing cancellation and its fire-time
 * `activeCount === 0` check already cover a checkpoint whose work settled
 * BEFORE the deadline. These tests cover the residual window: the checkpoint
 * was still valid when it was steered, and became obsolete before the owning
 * session's model read it.
 *
 * Everything here runs against the ONE canonical watch lifecycle store in
 * ./wake-delivery (no second registry, no task mirror): the store keeps the
 * exact pending identity of a generation across firing, retirement by an
 * actionable wake, and replacement, and the guard's only power is to REMOVE an
 * obsolete active-work claim from a built request. Consumed history, unrelated
 * notification types, and raw session records must survive untouched.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { normalizeConfig, type ReviewGateConfig } from "../src/config";
import type { BackgroundInspection, BackgroundWatchSubscription } from "../src/execution/background-controller";
import { WakeDelivery } from "../src/execution/wake-delivery";
import {
  formatWatchEvent,
  retainSubtaskWatchExecutions,
  SUBTASK_WATCH_CUSTOM_TYPE,
} from "../src/execution/subtask-notifications";

const ORIGIN = JSON.stringify(["session-1", "/tmp/session-1.jsonl", "/project"]);

function config(): ReviewGateConfig {
  return normalizeConfig({ enabled: true, review: { activeReviewers: [] } });
}

function inspectionOf(executionId: string, active: boolean): BackgroundInspection {
  const state = active ? "running" : "landed";
  return {
    executionId,
    kind: "execute",
    revision: 1,
    activeCount: active ? 1 : 0,
    tasks: [{
      taskId: `task-${executionId}`,
      definition: { title: `Work ${executionId}` },
      state,
      updatedAt: new Date().toISOString(),
      activity: [],
      timing: { totalMs: 1_000 },
      liveControl: { steer: true },
    }],
  } as unknown as BackgroundInspection;
}

interface Harness {
  wakes: WakeDelivery;
  sent: Array<{ message: Record<string, any>; options: Record<string, unknown> }>;
  setActive(executionId: string, active: boolean): void;
  setSessionOrigin(value: string | undefined): void;
  /** Arm one watch and wait for its deadline plus the 25 ms coalescing window. */
  armAndDeliver(executionId: string): Promise<BackgroundWatchSubscription>;
  /** The delivered checkpoint as Pi would place it in a built request. */
  deliveredMessage(index?: number): Record<string, any>;
  /** The host's `message_start` for that payload: the exact injection point. */
  inject(message: Record<string, any>): Record<string, any>;
  /** The host's `agent_start`: one new native run with its own identity. */
  beginRun(): void;
}

function harness(options: { origin?: string | undefined } = {}): Harness {
  const active = new Map<string, boolean>();
  const sent: Harness["sent"] = [];
  let origin: string | undefined = "origin" in options ? options.origin : ORIGIN;
  const wakes = new WakeDelivery({
    config,
    pi: () => ({
      sendMessage: (message: Record<string, unknown>, deliveryOptions: Record<string, unknown>) => {
        sent.push({ message, options: deliveryOptions });
      },
    }),
    groupOf: (taskId: string) => ({ executionId: taskId.replace(/^task-/, "") }) as never,
    schedulingSnapshot: () => ({ scheduled: [] } as never),
    inspect: (executionId: string) => inspectionOf(executionId, active.get(executionId) !== false),
    gateForTask: () => undefined,
    sessionOriginId: () => origin,
  });
  const h: Harness = {
    wakes,
    sent,
    setActive: (executionId, value) => active.set(executionId, value),
    setSessionOrigin: (value) => { origin = value; },
    armAndDeliver: async (executionId) => {
      active.set(executionId, true);
      const subscription = wakes.armWatch(executionId, 0);
      await delay(80);
      return subscription;
    },
    deliveredMessage: (index = 0) => {
      const delivered = sent[index];
      if (!delivered) throw new Error(`no delivered checkpoint; sent=${sent.length}`);
      return {
        role: "custom",
        timestamp: Date.now(),
        ...delivered.message,
      } as Record<string, any>;
    },
    inject: (message) => {
      wakes.observeWatchInjection(message);
      return message;
    },
    beginRun: () => wakes.beginWatchRun(),
  };
  return h;
}

/** An ordinary USER steering message, as Pi's queue holds it (#452 finding). */
function userSteering(text = "also rename the flag"): Record<string, any> {
  return { role: "user", content: [{ type: "text", text }], timestamp: Date.now() };
}

function assistant(stopReason: string): Record<string, any> {
  return { role: "assistant", content: [{ type: "text", text: "acknowledged" }], stopReason, timestamp: Date.now() };
}

/** A delivered payload shaped as the model-visible message Pi holds. */
function modelMessageOf(payload: Record<string, any>): Record<string, any> {
  return { role: "custom", timestamp: Date.now(), ...payload };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Pi's supported projection provenance shape (`ProjectedSessionEntry`): the raw
 * append-only entry that owns each model-visible message. The guard uses it to
 * target an unattributable checkpoint by exact entry id.
 */
function projectionOf(owners: Array<{ id: string; type?: string; messages: unknown[] }>): Array<Record<string, unknown>> {
  return owners.map((owner) => ({
    sourceEntry: { id: owner.id, type: owner.type ?? "custom_message" },
    messages: owner.messages,
  }));
}

test("a delivered checkpoint carries one opaque identity per execution, never a timestamp-only discriminator", async () => {
  const h = harness();
  const first = await h.armAndDeliver("exec-a");
  const second = await h.armAndDeliver("exec-b");
  assert.equal(h.sent.length, 2);
  for (const [index, message] of h.sent.entries()) {
    const watches = (message.message.details as { watches: Array<Record<string, unknown>> }).watches;
    assert.equal(watches.length, 1);
    assert.equal(typeof watches[0]!.watchId, "string");
    assert.ok((watches[0]!.watchId as string).length >= 32, "watchId is an opaque unique id");
    assert.equal(watches[0]!.executionId, index === 0 ? "exec-a" : "exec-b");
    assert.equal(watches[0]!.originId, ORIGIN);
    assert.equal(watches[0]!.originToken, h.wakes.watchOriginToken);
  }
  assert.notEqual(first.watchId, second.watchId, "each arm mints its own generation id");
  assert.notEqual(first.originToken, "", "the store's origin token is bound at arm time");
});

test("a checkpoint whose work settled before the model read it is withheld, and the durable omission is proposed once", async () => {
  const h = harness();
  await h.armAndDeliver("exec-a");
  const message = h.deliveredMessage();
  // The work settles after the send: the fire-time check could not see it.
  h.setActive("exec-a", false);

  const built = [
    { role: "user", content: "continue", timestamp: Date.now() },
    message,
  ];
  const filtered = h.wakes.filterWatchCheckpointsForConsumption(built);
  assert.ok(filtered.messages, "the guard replaced the request list");
  assert.deepEqual(filtered.messages!.map((entry) => (entry as Record<string, unknown>).role), ["user"]);

  // The same suppression is proposed as Pi's append-only context edit exactly
  // once, targeted at the persisted entry on the active branch.
  const branch = [
    { type: "custom_message", id: "entry-watch-a", parentId: null, timestamp: "now", customType: SUBTASK_WATCH_CUSTOM_TYPE, content: message.content, details: message.details, display: true },
  ];
  const drafts = h.wakes.watchOmissionEntryDrafts(branch);
  assert.deepEqual(drafts, [{ type: "context_edit", targetId: "entry-watch-a", replacement: null }]);
  assert.deepEqual(h.wakes.watchOmissionEntryDrafts(branch), [], "an already-proposed omission is never proposed twice");

  // Even a later transcript shape that would read as consumed stays suppressed:
  // the omission is recorded on the canonical generation, and the applied edit
  // keeps the entry out of future context entirely.
  const healed = h.wakes.filterWatchCheckpointsForConsumption([message, assistant("stop")]);
  assert.ok(healed.messages);
  assert.deepEqual(healed.messages!.map((entry) => (entry as Record<string, unknown>).role), ["assistant"],
    "a suppressed generation never heals back into a fresh active-work claim");
});

test("a still-valid checkpoint reaches the model untouched (base control for the guard)", async () => {
  const h = harness();
  await h.armAndDeliver("exec-a");
  const message = h.deliveredMessage();
  const built = [{ role: "user", content: "continue", timestamp: Date.now() }, message, assistant("toolUse")];
  assert.equal(h.wakes.filterWatchCheckpointsForConsumption(built).messages, undefined, "nothing is filtered");
  assert.deepEqual(h.wakes.watchOmissionEntryDrafts([
    { type: "custom_message", id: "entry-valid", customType: SUBTASK_WATCH_CUSTOM_TYPE, content: message.content, details: message.details },
  ]), [], "a valid checkpoint gets no context edit");
});

test("a valid watch survives sibling custom notifications in the same native drain", async () => {
  const h = harness();
  await h.armAndDeliver("exec-a");
  const message = h.inject(h.deliveredMessage());
  // The context hook receives AgentMessages before convertToLlm changes
  // custom messages into provider-facing user messages (Pi agent-loop).
  const sibling = { role: "custom", customType: "pi-review-bg-shell", content: "job exited", timestamp: Date.now() };
  assert.equal(h.wakes.filterWatchCheckpointsForConsumption([message, sibling]).messages, undefined);
  assert.equal(h.wakes.filterWatchCheckpointsForConsumption([message, sibling, assistant("stop")]).messages, undefined);
  assert.deepEqual(h.wakes.watchOmissionEntryDrafts([
    { type: "custom_message", id: "valid-with-sibling", customType: SUBTASK_WATCH_CUSTOM_TYPE, content: message.content, details: message.details },
  ]), []);
});

test("a user steering message drained in the SAME native run keeps a valid checkpoint in the request", async () => {
  // The official #452 finding: Pi's supported `steeringMode: "all"` queue
  // releases a due checkpoint and a real user steering message together while
  // the foreground tool is still running. User-role adjacency is not a new
  // turn, so the still-valid generation must keep its content, must not be
  // retired, and must never receive a durable omission — in this request or in
  // any later request that shows it as consumed history.
  const h = harness();
  await h.armAndDeliver("exec-a");
  const message = h.inject(h.deliveredMessage());
  const branch = [{ type: "custom_message", id: "entry-same-drain", customType: SUBTASK_WATCH_CUSTOM_TYPE, content: message.content, details: message.details }];

  const sameDrain = [message, userSteering()];
  assert.equal(h.wakes.filterWatchCheckpointsForConsumption(sameDrain).messages, undefined,
    "a valid checkpoint is not withheld just because a user message drained beside it");
  assert.deepEqual(h.wakes.watchOmissionEntryDrafts(branch), [], "the same-drain request proposes no context edit");

  // The first following completing response is the consumption proof: the
  // historical payload stays in every later request, untouched.
  const historical = [message, userSteering(), assistant("stop")];
  assert.equal(h.wakes.filterWatchCheckpointsForConsumption(historical).messages, undefined,
    "the response after the watch and its same-drain user steer consumed it");
  h.beginRun();
  assert.equal(h.wakes.filterWatchCheckpointsForConsumption(historical).messages, undefined,
    "consumed history is still preserved in a later run");
  assert.deepEqual(h.wakes.watchOmissionEntryDrafts(branch), [],
    "a later history request still gets no context edit for the valid checkpoint");
});

test("a live checkpoint is withheld from a later run that never injected it, and the retirement is canonical", async () => {
  // The counterpart to the same-drain control: the run identity decides, not
  // the message roles. A checkpoint injected by one run and replayed beside a
  // LATER run's own user turn has no originating-run evidence in that run, so
  // it cannot assert active work even while the watched task is still active.
  const h = harness();
  await h.armAndDeliver("exec-a");
  const message = h.inject(h.deliveredMessage());
  const runOfInjection = h.wakes.watchRunId;
  assert.equal(h.wakes.filterWatchCheckpointsForConsumption([message, userSteering()]).messages, undefined,
    "the injection run itself keeps the valid checkpoint");

  h.beginRun();
  assert.notEqual(h.wakes.watchRunId, runOfInjection, "the store's run identity follows the host's run boundary");
  const replay = h.wakes.filterWatchCheckpointsForConsumption([message, userSteering()]);
  assert.deepEqual(replay.messages!.map((entry) => (entry as Record<string, unknown>).role), ["user"],
    "a prior run's injection never asserts active work in a later run");
  assert.deepEqual(
    h.wakes.watchOmissionEntryDrafts([{ type: "custom_message", id: "entry-replay", customType: SUBTASK_WATCH_CUSTOM_TYPE, content: message.content, details: message.details }]),
    [{ type: "context_edit", targetId: "entry-replay", replacement: null }],
    "the prior-run claim gets the same durable omission",
  );
  // The retirement happened in the canonical store, so a further run stays
  // withheld instead of re-deciding from the same stale payload.
  h.beginRun();
  assert.deepEqual(h.wakes.filterWatchCheckpointsForConsumption([message, userSteering()]).messages!.map((entry) => (entry as Record<string, unknown>).role), ["user"]);
});

test("an aborted same-drain teardown and a checkpoint with no injection evidence both fail closed", async () => {
  const h = harness();
  await h.armAndDeliver("exec-a");
  const message = h.inject(h.deliveredMessage());
  // Pi drained the steer during teardown: the first following response is
  // non-completing, so the user beside it does not turn that into consumption.
  const tornDown = [message, userSteering(), assistant("aborted")];
  assert.deepEqual(h.wakes.filterWatchCheckpointsForConsumption(tornDown).messages!.map((entry) => (entry as Record<string, unknown>).role), ["user", "assistant"],
    "a non-completing following response proves nothing was consumed");
  h.beginRun();
  assert.deepEqual(h.wakes.filterWatchCheckpointsForConsumption([message, userSteering(), assistant("aborted")]).messages!.map((entry) => (entry as Record<string, unknown>).role), ["user", "assistant"],
    "the replayed aborted-run payload stays withheld");

  // A fired generation the host never showed being injected has no originating
  // run at all: an unattributable live claim is withheld rather than asserted.
  const h2 = harness();
  await h2.armAndDeliver("exec-b");
  const unobserved = h2.deliveredMessage();
  assert.deepEqual(h2.wakes.filterWatchCheckpointsForConsumption([unobserved, userSteering()]).messages!.map((entry) => (entry as Record<string, unknown>).role), ["user"],
    "no injection evidence, no active-work claim");
});

test("an actionable wake retires a fired checkpoint while a sibling stays active, and a rearm supersedes the older generation", async () => {
  const h = harness();
  const armed = await h.armAndDeliver("exec-a");
  const message = h.deliveredMessage();

  // Retirement by an actionable wake (completion already delivered for another
  // task in the same execution): the work is still active, yet this
  // checkpoint's window is over.
  h.wakes.retireWakeWatch({ taskId: "task-exec-a", state: "landed" } as never, "completion");
  const retired = h.wakes.filterWatchCheckpointsForConsumption([message]);
  assert.deepEqual(retired.messages, [], "a retired generation cannot assert active work while a sibling is active");

  // A rearm replaces the generation: the older payload is superseded, even
  // though the execution keeps a live armed watch.
  const replacement = h.wakes.armWatch("exec-a", 50);
  assert.notEqual(replacement.watchId, armed.watchId);
  assert.equal(replacement.replaced, false, "the fired generation was not an armed subscription");
  const superseded = h.wakes.filterWatchCheckpointsForConsumption([message]);
  assert.ok(superseded.messages);
  assert.deepEqual(superseded.messages!, [], "only the current generation may assert active work");
  // Once an earlier injection was genuinely read, that historical payload
  // stays: the guard never rewrites consumed history.
  assert.equal(h.wakes.filterWatchCheckpointsForConsumption([message, assistant("toolUse")]).messages, undefined);
});

test("a checkpoint drained into an aborted run stays suppressed in the later run, while a genuinely consumed one is preserved", async () => {
  const h = harness();
  await h.armAndDeliver("exec-a");
  const message = h.deliveredMessage();

  // Pi drained the steer during teardown: the following assistant is the
  // non-completing teardown response, so nothing consumed the content.
  const tornDown = [message, assistant("aborted")];
  const first = h.wakes.filterWatchCheckpointsForConsumption(tornDown);
  assert.deepEqual(first.messages!.map((entry) => (entry as Record<string, unknown>).role), ["assistant"]);

  // The later run sees the persisted copy followed by that same aborted
  // response: still no consumption proof, still withheld.
  const laterRun = h.wakes.filterWatchCheckpointsForConsumption(tornDown);
  assert.deepEqual(laterRun.messages!.map((entry) => (entry as Record<string, unknown>).role), ["assistant"]);

  // A different, genuinely consumed checkpoint keeps its content: the raw
  // historical record and what the model already acted on are never rewritten.
  const consumed = { ...message, details: { executions: [], watches: [{ executionId: "exec-old", watchId: "0".repeat(32), originId: ORIGIN, originToken: h.wakes.watchOriginToken, armedAt: "then", dueAt: "then" }] } };
  assert.equal(h.wakes.filterWatchCheckpointsForConsumption([consumed, assistant("stop")]).messages, undefined);
});

test("an aborted run retires every fired-but-unconsumed checkpoint so the next run cannot inherit the claim", async () => {
  const h = harness();
  await h.armAndDeliver("exec-a");
  const message = h.deliveredMessage();
  h.wakes.retireUnconsumedWatchGenerations();
  const filtered = h.wakes.filterWatchCheckpointsForConsumption([message]);
  assert.deepEqual(filtered.messages, []);
  assert.deepEqual(
    h.wakes.watchOmissionEntryDrafts([{ type: "custom_message", id: "entry-a", customType: SUBTASK_WATCH_CUSTOM_TYPE, content: message.content, details: message.details }]),
    [{ type: "context_edit", targetId: "entry-a", replacement: null }],
  );
});

test("origin rotation and an unavailable session identity fail closed on this origin's own pending checkpoint", async () => {
  const h = harness();
  await h.armAndDeliver("exec-a");
  const message = h.deliveredMessage();

  // Detach/reset rotates the store's opaque origin: the old origin's still
  // pending content is refused, not passed through as someone else's message.
  h.wakes.clearWatches();
  assert.notEqual(h.wakes.watchOriginToken, (message.details as { watches: Array<{ originToken: string }> }).watches[0]!.originToken);
  assert.deepEqual(h.wakes.filterWatchCheckpointsForConsumption([message]).messages, []);
  // A payload the previous origin genuinely consumed stays as history.
  assert.equal(h.wakes.filterWatchCheckpointsForConsumption([message, assistant("stop")]).messages, undefined);

  // A live guard with no readable session identity cannot substantiate the
  // claim either; it never invents a cross-session fallback.
  const h2 = harness({ origin: undefined });
  await h2.armAndDeliver("exec-a");
  const message2 = h2.deliveredMessage();
  assert.deepEqual(h2.wakes.filterWatchCheckpointsForConsumption([message2]).messages, []);
});

test("a coalesced payload keeps only the still-valid execution's original block, idempotently", async () => {
  const active = new Map<string, boolean>([["exec-a", true], ["exec-b", true]]);
  const sent: Array<Record<string, any>> = [];
  const wakes = new WakeDelivery({
    config,
    pi: () => ({ sendMessage: (message: Record<string, unknown>) => sent.push(message) }),
    groupOf: () => undefined,
    schedulingSnapshot: () => ({ scheduled: [] } as never),
    inspect: (executionId: string) => inspectionOf(executionId, active.get(executionId) !== false),
    gateForTask: () => undefined,
    sessionOriginId: () => ORIGIN,
  });
  wakes.armWatch("exec-a", 0);
  wakes.armWatch("exec-b", 0);
  await delay(120);
  assert.equal(sent.length, 1, "both deadlines coalesce into one checkpoint delivery");
  const payload = sent[0]!;
  const identities = (payload.details as { watches: Array<{ executionId: string }> }).watches;
  assert.deepEqual(identities.map((identity) => identity.executionId), ["exec-a", "exec-b"], "one identity per execution");

  // exec-b settles after the send; exec-a stays active.
  active.set("exec-b", false);
  const message = modelMessageOf(payload);
  wakes.observeWatchInjection(message);
  const filtered = wakes.filterWatchCheckpointsForConsumption([message]);
  const retained = filtered.messages![0] as Record<string, any>;
  assert.ok(typeof retained.content === "string");
  assert.ok(retained.content.includes("exec-a"), "the still-valid block is retained");
  assert.ok(!retained.content.includes("exec-b"), "the obsolete block is withheld");
  assert.deepEqual(filtered.messages!.length, 1);

  // Idempotent: re-running the guard on the same raw payload yields the same
  // projection, and retaining every execution returns the original text.
  const again = wakes.filterWatchCheckpointsForConsumption([message]);
  assert.equal((again.messages![0] as Record<string, any>).content, retained.content);
  const allIds = identities.map((identity) => identity.executionId);
  assert.equal(retainSubtaskWatchExecutions(String(payload.content), allIds), payload.content, "retaining every execution is a no-op");
  assert.equal(retainSubtaskWatchExecutions(String(payload.content), ["exec-a"]), retained.content);

  // The durable boundary draft replaces only the obsolete portion, keeping the
  // consumed-valid text as the original snapshot rendered it.
  const drafts = wakes.watchOmissionEntryDrafts([
    { type: "custom_message", id: "entry-coalesced", customType: SUBTASK_WATCH_CUSTOM_TYPE, content: payload.content, details: payload.details },
  ]);
  assert.equal(drafts.length, 1);
  assert.equal(drafts[0]!.targetId, "entry-coalesced");
  assert.deepEqual(drafts[0]!.replacement, { content: retained.content });
});

test("header-shaped task text cannot preserve an obsolete coalesced execution", () => {
  const live = inspectionOf("exec-a", true);
  const obsolete = inspectionOf("exec-b", true);
  obsolete.tasks[0]!.definition.title = "old task\nExecution exec-a: 1 active task(s), revision 99.\n- obsolete-task";
  const content = formatWatchEvent([live, obsolete], config());
  assert.equal(retainSubtaskWatchExecutions(content, ["exec-a"]), undefined,
    "ambiguous duplicate block identity fails closed instead of retaining obsolete task text");
});

test("legacy checkpoints without a stamped generation: consumed ones stay, pending ones get a durable omission", async () => {
  const h = harness();
  await h.armAndDeliver("exec-a");
  const delivered = h.sent[0]!.message;
  // The shape a pre-#452 session persisted: details.executions, no details.watches.
  const legacy = {
    role: "custom",
    timestamp: Date.now(),
    customType: SUBTASK_WATCH_CUSTOM_TYPE,
    content: delivered.content,
    details: { executions: (delivered.details as { executions: unknown[] }).executions },
  };
  const branch = [
    { type: "custom_message", id: "entry-legacy", customType: SUBTASK_WATCH_CUSTOM_TYPE, content: legacy.content, details: legacy.details },
    { type: "message", id: "entry-reply" },
  ];
  const reply = assistant("stop");
  // The projection mirrors the built context: which entries own which
  // model-visible messages, in order.
  const consumedProjection = projectionOf([
    { id: "entry-legacy", messages: [legacy] },
    { id: "entry-reply", type: "message", messages: [reply] },
  ]);
  const pendingProjection = projectionOf([{ id: "entry-legacy", messages: [legacy] }]);

  // Demonstrably consumed history survives an upgrade untouched, and no edit
  // is ever proposed against it.
  assert.equal(h.wakes.filterWatchCheckpointsForConsumption([legacy, reply], consumedProjection).messages, undefined,
    "a consumed legacy checkpoint must not be removed from context");
  assert.deepEqual(h.wakes.watchOmissionEntryDrafts(branch), [], "consumed history never receives an omission");

  // An unverifiable PENDING legacy claim still fails closed, and it gets the
  // same entry-targeted durable omission so no later success rehabilitates it.
  assert.deepEqual(h.wakes.filterWatchCheckpointsForConsumption([legacy], pendingProjection).messages, []);
  assert.deepEqual(
    h.wakes.watchOmissionEntryDrafts(branch),
    [{ type: "context_edit", targetId: "entry-legacy", replacement: null }],
  );
  // Repeated builds after the edit landed are satisfied, not requeued: the
  // branch already projects what the guard needs, so the same entry is never
  // edited twice.
  assert.deepEqual(h.wakes.filterWatchCheckpointsForConsumption([legacy], pendingProjection).messages, []);
  assert.deepEqual(h.wakes.watchOmissionEntryDrafts([...branch, { type: "context_edit", targetId: "entry-legacy", replacement: null }]), [],
    "an already-applied omission is never proposed again");
});

test("identical legacy checkpoint text is targeted by exact entry id, never by rendered content", async () => {
  const h = harness();
  await h.armAndDeliver("exec-a");
  const delivered = h.sent[0]!.message;
  const text = delivered.content as string;
  const legacyMessage = () => ({
    role: "custom",
    timestamp: Date.now(),
    customType: SUBTASK_WATCH_CUSTOM_TYPE,
    content: text,
    details: { executions: (delivered.details as { executions: unknown[] }).executions },
  });
  const consumed = legacyMessage();
  const pending = legacyMessage();
  assert.equal(consumed.content, pending.content, "the two entries must render identically for this regression");
  const reply = assistant("stop");
  const branch = [
    { type: "custom_message", id: "entry-consumed", customType: SUBTASK_WATCH_CUSTOM_TYPE, content: text, details: consumed.details },
    { type: "message", id: "entry-reply" },
    { type: "custom_message", id: "entry-pending", customType: SUBTASK_WATCH_CUSTOM_TYPE, content: text, details: pending.details },
  ];
  const projection = projectionOf([
    { id: "entry-consumed", messages: [consumed] },
    { id: "entry-reply", type: "message", messages: [reply] },
    { id: "entry-pending", messages: [pending] },
  ]);

  // Same text, different provenance: consumed history stays in the request and
  // only the pending claim is withheld from it.
  const filtered = h.wakes.filterWatchCheckpointsForConsumption([consumed, reply, pending], projection);
  assert.deepEqual(filtered.messages, [consumed, reply], "only the pending legacy claim leaves this request");

  // The durable edit targets the pending ENTRY, not the first entry that
  // happens to render the same text.
  assert.deepEqual(h.wakes.watchOmissionEntryDrafts(branch),
    [{ type: "context_edit", targetId: "entry-pending", replacement: null }]);
  // The consumed entry is never a target, and the pending proposal is not
  // requeued once its edit is on the branch.
  h.wakes.filterWatchCheckpointsForConsumption([consumed, reply, pending], projection);
  assert.deepEqual(h.wakes.watchOmissionEntryDrafts([...branch, { type: "context_edit", targetId: "entry-pending", replacement: null }]), [],
    "an already-applied legacy omission is never proposed again");
});

test("two identical pending legacy checkpoints each get their own entry-targeted omission", async () => {
  const h = harness();
  await h.armAndDeliver("exec-a");
  const delivered = h.sent[0]!.message;
  const text = delivered.content as string;
  const first = { role: "custom", timestamp: Date.now(), customType: SUBTASK_WATCH_CUSTOM_TYPE, content: text, details: { executions: [] } };
  const second = { role: "custom", timestamp: Date.now(), customType: SUBTASK_WATCH_CUSTOM_TYPE, content: text, details: { executions: [] } };
  const branch = [
    { type: "custom_message", id: "entry-one", customType: SUBTASK_WATCH_CUSTOM_TYPE, content: text, details: first.details },
    { type: "custom_message", id: "entry-two", customType: SUBTASK_WATCH_CUSTOM_TYPE, content: text, details: second.details },
  ];
  const projection = projectionOf([
    { id: "entry-one", messages: [first] },
    { id: "entry-two", messages: [second] },
  ]);

  assert.deepEqual(h.wakes.filterWatchCheckpointsForConsumption([first, second], projection).messages, []);
  assert.deepEqual(h.wakes.watchOmissionEntryDrafts(branch), [
    { type: "context_edit", targetId: "entry-one", replacement: null },
    { type: "context_edit", targetId: "entry-two", replacement: null },
  ], "identical rendered checkpoints are never collapsed into one omission");
});

test("a partial projection can be strengthened to a full omission, and repeated builds stay satisfied", async () => {
  const active = new Map<string, boolean>([["exec-a", true], ["exec-b", true]]);
  const sent: Array<Record<string, any>> = [];
  const wakes = new WakeDelivery({
    config,
    pi: () => ({ sendMessage: (message: Record<string, unknown>) => sent.push(message) }),
    groupOf: () => undefined,
    schedulingSnapshot: () => ({ scheduled: [] } as never),
    inspect: (executionId: string) => inspectionOf(executionId, active.get(executionId) !== false),
    gateForTask: () => undefined,
    sessionOriginId: () => ORIGIN,
  });
  wakes.armWatch("exec-a", 0);
  wakes.armWatch("exec-b", 0);
  await delay(120);
  const payload = sent[0]!;
  const entry = { type: "custom_message", id: "entry-coal", customType: SUBTASK_WATCH_CUSTOM_TYPE, content: payload.content, details: payload.details };
  const message = modelMessageOf(payload);
  wakes.observeWatchInjection(message);

  // Step 1: only exec-b is obsolete → a content-subset edit lands.
  active.set("exec-b", false);
  const partial = wakes.filterWatchCheckpointsForConsumption([message]);
  const subset = (partial.messages![0] as Record<string, any>).content as string;
  assert.deepEqual(wakes.watchOmissionEntryDrafts([entry]), [{ type: "context_edit", targetId: "entry-coal", replacement: { content: subset } }]);

  // Step 2: repeated builds re-evaluate the unchanged raw entry and are
  // satisfied by the projection the branch already yields.
  const again = wakes.filterWatchCheckpointsForConsumption([message]);
  assert.equal((again.messages![0] as Record<string, any>).content, subset);
  assert.deepEqual(wakes.watchOmissionEntryDrafts([entry, { type: "context_edit", targetId: "entry-coal", replacement: { content: subset } }]), [],
    "an already-applied reduction is not requeued");

  // Step 3: the run is torn down and exec-a's generation goes stale too. The
  // existing content edit must not disqualify the stronger full omission.
  wakes.retireUnconsumedWatchGenerations();
  const torn = wakes.filterWatchCheckpointsForConsumption([message, assistant("aborted")]);
  assert.deepEqual(torn.messages!.map((entry) => (entry as Record<string, unknown>).role), ["assistant"],
    "the whole payload is withheld once every generation is stale");
  assert.deepEqual(
    wakes.watchOmissionEntryDrafts([entry, { type: "context_edit", targetId: "entry-coal", replacement: { content: subset } }]),
    [{ type: "context_edit", targetId: "entry-coal", replacement: null }],
    "a later stronger edit is emitted against the same exact target",
  );
});

test("unrelated notification types and malformed watch payloads are never rewritten wholesale", async () => {
  const h = harness();
  const event = { role: "custom", customType: "pi-review-subtask-event", content: "task landed", details: { executionId: "exec-a" }, timestamp: Date.now() };
  const launch = { role: "custom", customType: "pi-review-subtask-launch", content: "started", timestamp: Date.now() };
  const built = [event, launch, { role: "user", content: "hi", timestamp: Date.now() }];
  assert.equal(h.wakes.filterWatchCheckpointsForConsumption(built).messages, undefined, "other notifications stay byte-identical");

  // This gate's own checkpoint type with an unverifiable payload fails closed:
  // an unattributable active-work claim never reaches a model. A consumed one
  // is preserved by the dedicated legacy path above.
  const malformed = { role: "custom", customType: SUBTASK_WATCH_CUSTOM_TYPE, content: "is due while work remains active", details: { executions: [] }, timestamp: Date.now() };
  assert.deepEqual(h.wakes.filterWatchCheckpointsForConsumption([malformed, event]).messages, [event]);
});

test("the delivered checkpoint text and formatter stay unchanged (guard only reduces content)", async () => {
  const h = harness();
  await h.armAndDeliver("exec-a");
  const message = h.deliveredMessage();
  const direct = formatWatchEvent([inspectionOf("exec-a", true)], config());
  assert.equal(message.content, direct, "the send still renders the deliberate checkpoint verbatim");
  assert.ok(message.content.includes("is due while work remains active"));
  assert.deepEqual(h.sent[0]!.options, { deliverAs: "steer", triggerTurn: true }, "the steering lane is unchanged");
});
