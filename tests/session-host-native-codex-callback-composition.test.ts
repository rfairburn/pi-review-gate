/**
 * Codex callback route composition (#682), synthetic only.
 *
 * Injected host facts, a stub steer lane, and a scripted queue caller stand in
 * for the host-owned app-server. No live session, socket, setting, prompt, or
 * filesystem scratch is used. Covers busy and idle routing, unknown/stale/
 * revoked/user-stop declines, and the idle busy-race fence.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import {
  NATIVE_CODEX_CALLBACK_LANE_OWNERSHIP,
  classifyNativeCodexCallbackPlacement,
  type NativeCodexCallbackSteerLane,
  type NativeCodexCallbackSteerParams,
  type NativeCodexCallbackSteerWireOutcome,
  type NativeCodexCallbackSteerWriteEdge,
} from "../src/session-host/native-codex-callback-delivery";
import {
  NATIVE_CODEX_CALLBACK_QUEUE_LANE_OWNERSHIP,
  createNativeCodexCallbackComposer,
  type NativeCodexCallbackComposerOptions,
  type NativeCodexCallbackQueueLane,
  type NativeCodexCallbackQueueLaneReply,
  type NativeCodexCallbackQueueWriteEdge,
  type NativeCodexCallbackRootFacts,
} from "../src/session-host/native-codex-callback-composition";
import type {
  NativeCodexIdleWakeQueueMethod,
  NativeCodexIdleWakeReply,
} from "../src/session-host/native-codex-idle-wake";

const THREAD = "019a0000-0000-7000-8000-00000000c682";
const RUN = "run-generation-1";
const TURN_OLD = "turn-old-0";
const TURN_BUSY = "turn-busy-1";
const TURN_RACE = "turn-race-2";
const ROW = "queued-row-1";
const MSG_ID = "callback-record-0001";
const TEXT = "CALLBACK-TEXT-SENTINEL: worker finished";
const BUSY_MESSAGE = "thread already has an active or pending turn";

/* ------------------------------------------------------------------ fakes */

const busy = (turnId = TURN_BUSY, overrides: Partial<NativeCodexCallbackRootFacts> = {}): NativeCodexCallbackRootFacts => ({
  threadId: THREAD,
  runId: RUN,
  activity: { state: "busy", turnId },
  userStop: "none",
  ...overrides,
});

const idle = (lastTurnId: string | null = TURN_OLD, overrides: Partial<NativeCodexCallbackRootFacts> = {}): NativeCodexCallbackRootFacts => ({
  threadId: THREAD,
  runId: RUN,
  activity: { state: "idle", lastTurnId },
  userStop: "none",
  ...overrides,
});

/** A mutable host facts cell; tests change it to simulate the host's view moving. */
function factsCell(initial: unknown) {
  let value: unknown = initial;
  let reads = 0;
  return {
    set(next: unknown) {
      value = next;
    },
    reads: () => reads,
    read: (): NativeCodexCallbackRootFacts | null => {
      reads += 1;
      if (value instanceof Error) throw value;
      return value as NativeCodexCallbackRootFacts | null;
    },
  };
}

interface Log {
  readonly entries: string[];
}

function stubLane(
  log: Log,
  respond: (
    params: NativeCodexCallbackSteerParams,
    edge: NativeCodexCallbackSteerWriteEdge,
  ) => Promise<NativeCodexCallbackSteerWireOutcome> | NativeCodexCallbackSteerWireOutcome = (params) => ({
    kind: "result",
    result: { turnId: params.expectedTurnId },
  }),
) {
  const calls: NativeCodexCallbackSteerParams[] = [];
  const lane: NativeCodexCallbackSteerLane = {
    ownership: NATIVE_CODEX_CALLBACK_LANE_OWNERSHIP,
    endpoint: { kind: "unix", socketPath: "/tmp/pi-owned/codex.sock" },
    capability: { expectedTurnSteer: true },
    async steer(params, edge) {
      calls.push(params);
      log.entries.push(`turn/steer:${params.expectedTurnId}`);
      return respond(params, edge);
    },
  };
  return { lane, calls };
}

type Step =
  | NativeCodexCallbackQueueLaneReply
  | ((
      params: Readonly<Record<string, unknown>>,
      edge: NativeCodexCallbackQueueWriteEdge,
    ) => NativeCodexCallbackQueueLaneReply | Promise<NativeCodexCallbackQueueLaneReply>);

/**
 * A branded queue lane that models a ready lane: the frame is "written" (logged)
 * synchronously inside `request`. A step may instead model a deferred lane by
 * consulting the write edge itself and returning `not-sent`.
 */
function scriptedQueue(log: Log, script: Partial<Record<NativeCodexIdleWakeQueueMethod, Step>>) {
  const calls: Array<{ method: string; params: Readonly<Record<string, unknown>> }> = [];
  const edges: NativeCodexCallbackQueueWriteEdge[] = [];
  const lane: NativeCodexCallbackQueueLane = {
    ownership: NATIVE_CODEX_CALLBACK_QUEUE_LANE_OWNERSHIP,
    async request(method, params, _timeoutMs, edge) {
      edges.push(edge);
      const step = script[method];
      if (step === undefined) throw new Error(`unscripted ${method}`);
      if (typeof step !== "function") {
        calls.push({ method, params });
        log.entries.push(method);
        return step;
      }
      const reply = await step(params, edge);
      if (reply.kind !== "not-sent") {
        calls.push({ method, params });
        log.entries.push(method);
      }
      return reply;
    },
  };
  return { lane, calls, edges };
}

const added: NativeCodexIdleWakeReply = {
  kind: "result",
  result: { queuedSubmission: { id: ROW, clientUserMessageId: MSG_ID } },
};
const startedTurn = (turnId: string): NativeCodexIdleWakeReply => ({
  kind: "result",
  result: { turn: { id: turnId, status: "inProgress" } },
});
const busyRefusal: NativeCodexIdleWakeReply = { kind: "error", code: -32600, message: BUSY_MESSAGE };
const deletedTrue: NativeCodexIdleWakeReply = { kind: "result", result: { deleted: true } };

function setup(
  initialFacts: unknown,
  script: Partial<Record<NativeCodexIdleWakeQueueMethod, Step>> = {},
  respond?: Parameters<typeof stubLane>[1],
  overrides: Partial<NativeCodexCallbackComposerOptions> = {},
) {
  const log: Log = { entries: [] };
  const facts = factsCell(initialFacts);
  const steer = stubLane(log, respond);
  const queue = scriptedQueue(log, script);
  const composer = createNativeCodexCallbackComposer({
    owned: { threadId: THREAD, runId: RUN },
    readFacts: facts.read,
    steerLane: steer.lane,
    queueLane: queue.lane,
    ...overrides,
  });
  return { log, facts, steer, queue, composer };
}

const request = (overrides: Record<string, unknown> = {}) =>
  ({ clientUserMessageId: MSG_ID, text: TEXT, ...overrides }) as { clientUserMessageId: string; text: string };

/* ------------------------------------------------------------------- busy */

test("busy root turn uses only the expected-turn steer primitive", async () => {
  const { composer, steer, queue, log } = setup(busy());
  const outcome = await composer.deliver(request());

  assert.equal(outcome.route, "busy-steer");
  assert.equal(outcome.delivery, "sent-unconfirmed");
  assert.ok(outcome.route === "busy-steer" && outcome.steer.status === "accepted");
  assert.equal(outcome.steer.placement, "unconfirmed", "acceptance is not placement");
  assert.deepEqual(log.entries, [`turn/steer:${TURN_BUSY}`]);
  assert.equal(queue.calls.length, 0);
  assert.deepEqual(steer.calls[0], {
    threadId: THREAD,
    expectedTurnId: TURN_BUSY,
    clientUserMessageId: MSG_ID,
    input: [{ type: "text", text: TEXT }],
  });
  assert.doesNotMatch(JSON.stringify(outcome), /CALLBACK-TEXT-SENTINEL/);

  // Placement stays a separate, evidence-based verdict over the acceptance.
  const acceptance = outcome.steer.acceptance;
  assert.deepEqual(classifyNativeCodexCallbackPlacement(acceptance, {
    submission: acceptance,
    observedIn: [],
    acceptedTurnEnded: null,
  }), { verdict: "uncertain", reason: "pending" });
  assert.deepEqual(classifyNativeCodexCallbackPlacement(acceptance, {
    submission: acceptance,
    observedIn: [{ threadId: THREAD, turnId: TURN_BUSY, clientUserMessageId: MSG_ID }],
    acceptedTurnEnded: null,
  }), { verdict: "placed" });
});

test("busy steer keeps the primitive's rejected and uncertain semantics; unknown is never replayed", async () => {
  const rejected = setup(busy(), {}, () => ({ kind: "error", error: { code: -32600, message: "no active turn" } }));
  const r = await rejected.composer.deliver(request());
  assert.equal(r.delivery, "not-delivered");
  assert.ok(r.route === "busy-steer" && r.steer.status === "rejected" && r.steer.reason === "no-active-turn");

  const lost = setup(busy(), {}, () => ({ kind: "no-response", reason: "timeout" }));
  const u = await lost.composer.deliver(request());
  assert.equal(u.delivery, "unknown");
  assert.ok(u.route === "busy-steer" && u.steer.status === "uncertain");
  const again = await lost.composer.deliver(request());
  assert.deepEqual(again, { route: "duplicate", delivery: "unknown" }, "a timeout never becomes not-delivered");
  for (const text of [" ", "a\u0000b"]) {
    assert.deepEqual(await lost.composer.deliver(request({ text })), {
      route: "duplicate",
      delivery: "unknown",
    }, "invalid text does not erase the earlier attempt's uncertainty");
  }
  assert.equal(lost.steer.calls.length, 1, "an unknown send is never resent");
  assert.equal(lost.queue.calls.length, 0, "and never rerouted to the queue");
});

test("busy revocation at the lane write edge writes nothing", async () => {
  let edgeSaw: boolean | undefined;
  const fixture = setup(busy(), {}, (_params, edge) => {
    fixture.facts.set(busy(TURN_BUSY, { runId: "run-generation-2" }));
    edgeSaw = edge.isTargetStillCurrent();
    return edgeSaw ? { kind: "result", result: { turnId: TURN_BUSY } } : { kind: "not-sent" };
  });
  const outcome = await fixture.composer.deliver(request());
  assert.equal(edgeSaw, false);
  assert.equal(outcome.delivery, "not-delivered");
  assert.ok(outcome.route === "busy-steer" && outcome.steer.status === "refused" && outcome.steer.code === "lane-not-sent");
});

/* ------------------------------------------------------------------- idle */

test("idle root uses only the atomic queue primitive on our exact row", async () => {
  const { composer, steer, queue, log } = setup(idle(), {
    "thread/queue/add": added,
    "thread/queue/start": startedTurn(TURN_RACE),
  });
  const outcome = await composer.deliver(request());

  assert.equal(outcome.route, "idle-queue");
  assert.equal(outcome.delivery, "turn-started");
  assert.ok(outcome.route === "idle-queue" && outcome.idle.kind === "started");
  assert.equal(outcome.raceDeclined, undefined);
  assert.deepEqual(log.entries, ["thread/queue/add", "thread/queue/start"]);
  assert.equal(steer.calls.length, 0);
  assert.equal(queue.calls[0]!.params.threadId, THREAD);
  assert.equal(queue.calls[0]!.params.clientUserMessageId, MSG_ID);
  assert.deepEqual(queue.calls[1]!.params, { threadId: THREAD, queuedSubmissionId: ROW });
  assert.doesNotMatch(JSON.stringify(outcome), /CALLBACK-TEXT-SENTINEL/);
});

test("idle unsupported queue is not delivered and never falls back to steer or turn/start", async () => {
  const { composer, steer, log } = setup(idle(), {
    "thread/queue/add": { kind: "error", code: -32601, message: "method not found" },
  });
  const outcome = await composer.deliver(request());
  assert.equal(outcome.delivery, "not-delivered");
  assert.ok(outcome.route === "idle-queue" && outcome.idle.kind === "unsupported");
  assert.deepEqual(log.entries, ["thread/queue/add"]);
  assert.equal(steer.calls.length, 0);
});

/* ---------------------------------------------------- unknown / revocation */

test("unknown, malformed, stale, or user-stopped facts decline before any write", async () => {
  const cases: Array<[string, unknown, string]> = [
    ["no facts", null, "facts-unknown"],
    ["reader throws", new Error("reader failed"), "facts-unknown"],
    ["activity unknown", { threadId: THREAD, runId: RUN, activity: { state: "unknown" }, userStop: "none" }, "facts-unknown"],
    ["busy without turn", { threadId: THREAD, runId: RUN, activity: { state: "busy" }, userStop: "none" }, "facts-unknown"],
    ["idle with bad last turn", idle(" padded "), "facts-unknown"],
    ["unrecognized stop state", busy(TURN_BUSY, { userStop: "maybe" as never }), "facts-unknown"],
    ["other run (revoked)", busy(TURN_BUSY, { runId: "run-generation-2" }), "facts-stale"],
    ["other thread", idle(TURN_OLD, { threadId: "019a-other-thread" }), "facts-stale"],
    ["busy after user stop", busy(TURN_BUSY, { userStop: "stopped" }), "user-stopped"],
    ["idle after user stop", idle(TURN_OLD, { userStop: "stopped" }), "user-stopped"],
    ["stop unknown", idle(TURN_OLD, { userStop: "unknown" }), "user-stopped"],
  ];
  for (const [label, facts, reason] of cases) {
    const { composer, log } = setup(facts);
    const outcome = await composer.deliver(request());
    assert.deepEqual(outcome, { route: "declined", reason, delivery: "not-delivered" }, label);
    assert.deepEqual(log.entries, [], `${label}: nothing written`);
  }
});

test("invalid composer options or request input decline without touching either seam", async () => {
  const bad = setup(busy(), {}, undefined, { owned: { threadId: THREAD, runId: " " } });
  assert.deepEqual(await bad.composer.deliver(request()), { route: "declined", reason: "composer-invalid", delivery: "not-delivered" });
  assert.equal(bad.facts.reads(), 0);

  const generic = setup(idle(), {}, undefined, {
    queueLane: { request: async () => ({ kind: "result", result: {} }) } as unknown as NativeCodexCallbackQueueLane,
  });
  assert.deepEqual(await generic.composer.deliver(request()), { route: "declined", reason: "composer-invalid", delivery: "not-delivered" });
  assert.equal(generic.facts.reads(), 0, "an unbranded generic queue caller is not accepted");

  const ok = setup(busy());
  for (const input of [request({ clientUserMessageId: "has space" }), request({ text: "   " }), request({ text: "a\u0000b" })]) {
    assert.deepEqual(await ok.composer.deliver(input), { route: "declined", reason: "input-invalid", delivery: "not-delivered" });
  }
  assert.deepEqual(ok.log.entries, []);
});

test("revocation between the idle decision and the first queue write writes nothing", async () => {
  const fixture = setup(idle(), { "thread/queue/add": added });
  const realRead = fixture.facts.read;
  let reads = 0;
  const composer = createNativeCodexCallbackComposer({
    owned: { threadId: THREAD, runId: RUN },
    readFacts: () => (++reads === 1 ? realRead() : idle(TURN_OLD, { runId: "run-generation-2" })),
    steerLane: fixture.steer.lane,
    queueLane: fixture.queue.lane,
  });
  const outcome = await composer.deliver(request());
  assert.deepEqual(outcome, { route: "declined", reason: "queue-add-not-sent", delivery: "not-delivered" });
  assert.deepEqual(fixture.log.entries, []);
});

test("revocation after add stops the start; our possibly queued row is unknown and never replayed", async () => {
  const fixture = setup(idle(), {
    "thread/queue/add": () => {
      fixture.facts.set(idle(TURN_OLD, { runId: "run-generation-2" }));
      return added;
    },
  });
  const outcome = await fixture.composer.deliver(request());
  assert.equal(outcome.delivery, "unknown");
  assert.ok(outcome.route === "idle-queue" && outcome.idle.kind === "uncertain");
  assert.equal(outcome.idle.stage, "start");
  assert.deepEqual(fixture.log.entries, ["thread/queue/add"], "no start and no delete after revocation");

  fixture.facts.set(idle());
  assert.deepEqual(await fixture.composer.deliver(request()), { route: "duplicate", delivery: "unknown" });
  assert.deepEqual(fixture.log.entries, ["thread/queue/add"]);
});

test("user stop after add stops the start: the composition never wakes a stopped root", async () => {
  const fixture = setup(idle(), {
    "thread/queue/add": () => {
      fixture.facts.set(idle(TURN_OLD, { userStop: "stopped" }));
      return added;
    },
  });
  const outcome = await fixture.composer.deliver(request());
  assert.equal(outcome.delivery, "unknown");
  assert.deepEqual(fixture.log.entries, ["thread/queue/add"]);
});

test("a concurrent delivery on the same composer is refused while one is in flight", async () => {
  let release!: (value: NativeCodexCallbackSteerWireOutcome) => void;
  const fixture = setup(busy(), {}, () => new Promise((resolve) => { release = resolve; }));
  const first = fixture.composer.deliver(request());
  assert.deepEqual(await fixture.composer.deliver(request({ clientUserMessageId: "callback-record-0002" })), {
    route: "declined",
    reason: "in-flight",
    delivery: "not-delivered",
  });
  release({ kind: "result", result: { turnId: TURN_BUSY } });
  assert.equal((await first).delivery, "sent-unconfirmed");
  assert.equal(fixture.steer.calls.length, 1);
});

/* ------------------------------------------------------- idle busy race */

test("idle busy-race switches to steer only after our row is deleted and fresh facts prove a new turn", async () => {
  const fixture = setup(idle(TURN_OLD), {
    "thread/queue/add": added,
    "thread/queue/start": () => {
      fixture.facts.set(busy(TURN_RACE));
      return busyRefusal;
    },
    "thread/queue/delete": deletedTrue,
  });
  const outcome = await fixture.composer.deliver(request());

  assert.equal(outcome.route, "idle-race-steer");
  assert.equal(outcome.delivery, "sent-unconfirmed");
  assert.ok(outcome.route === "idle-race-steer");
  assert.deepEqual(outcome.idle, { kind: "busy-removed", queuedSubmissionId: ROW });
  assert.ok(outcome.steer.status === "accepted" && outcome.steer.placement === "unconfirmed");
  assert.deepEqual(fixture.log.entries, [
    "thread/queue/add",
    "thread/queue/start",
    "thread/queue/delete",
    `turn/steer:${TURN_RACE}`,
  ]);
  assert.deepEqual(fixture.queue.calls[2]!.params, { threadId: THREAD, queuedSubmissionId: ROW }, "deletes only our exact row");
  assert.equal(fixture.steer.calls[0]!.clientUserMessageId, MSG_ID, "same callback id, not a new submission");
  assert.equal(fixture.steer.calls[0]!.input[0].text, TEXT);
});

test("idle busy-race declines the steer without fresh current-run proof of a new busy turn", async () => {
  const cases: Array<[string, unknown, string]> = [
    ["still idle", idle(TURN_OLD), "not-busy"],
    ["same turn as the idle decision", busy(TURN_OLD), "turn-not-fresh"],
    ["run revoked", busy(TURN_RACE, { runId: "run-generation-2" }), "facts-stale"],
    ["facts unknown", null, "facts-unknown"],
    ["user stopped the racing turn", busy(TURN_RACE, { userStop: "stopped" }), "user-stopped"],
  ];
  for (const [label, afterStart, reason] of cases) {
    const fixture = setup(idle(TURN_OLD), {
      "thread/queue/add": added,
      "thread/queue/start": busyRefusal,
      "thread/queue/delete": () => {
        fixture.facts.set(afterStart);
        return deletedTrue;
      },
    });
    const outcome = await fixture.composer.deliver(request());
    assert.ok(outcome.route === "idle-queue", label);
    assert.equal(outcome.delivery, "not-delivered", label);
    assert.equal(outcome.raceDeclined, reason, label);
    assert.equal(outcome.idle.kind, "busy-removed", label);
    assert.equal(fixture.steer.calls.length, 0, `${label}: no steer`);
    assert.deepEqual(fixture.log.entries, ["thread/queue/add", "thread/queue/start", "thread/queue/delete"], label);
  }
});

test("the cleanup delete of our row is still written when the user stops the racing turn", async () => {
  const fixture = setup(idle(TURN_OLD), {
    "thread/queue/add": added,
    "thread/queue/start": () => {
      fixture.facts.set(busy(TURN_RACE, { userStop: "stopped" }));
      return busyRefusal;
    },
    "thread/queue/delete": deletedTrue,
  });
  const outcome = await fixture.composer.deliver(request());
  assert.ok(outcome.route === "idle-queue");
  assert.equal(outcome.raceDeclined, "user-stopped");
  assert.equal(outcome.delivery, "not-delivered");
  assert.deepEqual(fixture.log.entries, ["thread/queue/add", "thread/queue/start", "thread/queue/delete"]);
});

test("the cleanup delete is not written on a revoked run; the row stays unknown", async () => {
  const fixture = setup(idle(TURN_OLD), {
    "thread/queue/add": added,
    "thread/queue/start": () => {
      fixture.facts.set(busy(TURN_RACE, { runId: "run-generation-2" }));
      return busyRefusal;
    },
  });
  const outcome = await fixture.composer.deliver(request());
  assert.equal(outcome.delivery, "unknown");
  assert.ok(outcome.route === "idle-queue" && outcome.idle.kind === "uncertain" && outcome.idle.stage === "delete");
  assert.deepEqual(fixture.log.entries, ["thread/queue/add", "thread/queue/start"]);
});

test("uncertain queue outcomes are never steered, retried, or replayed", async () => {
  const cases: Array<[string, Partial<Record<NativeCodexIdleWakeQueueMethod, Step>>, string[]]> = [
    ["row absent at start", {
      "thread/queue/add": added,
      "thread/queue/start": { kind: "error", code: -32600, message: `queued submission not found: ${ROW}` },
    }, ["thread/queue/add", "thread/queue/start"]],
    ["start timed out", {
      "thread/queue/add": added,
      "thread/queue/start": { kind: "failed", failure: "timeout" },
    }, ["thread/queue/add", "thread/queue/start"]],
    ["delete not confirmed", {
      "thread/queue/add": added,
      "thread/queue/start": busyRefusal,
      "thread/queue/delete": { kind: "result", result: { deleted: false } },
    }, ["thread/queue/add", "thread/queue/start", "thread/queue/delete"]],
    ["add closed", { "thread/queue/add": { kind: "failed", failure: "closed" } }, ["thread/queue/add"]],
  ];
  for (const [label, script, expected] of cases) {
    const fixture = setup(idle(TURN_OLD), script);
    // A busy turn is visible afterwards: still no steer on an unknown queue outcome.
    const outcome = await fixture.composer.deliver(request());
    fixture.facts.set(busy(TURN_RACE));
    assert.equal(outcome.delivery, "unknown", label);
    assert.ok(outcome.route === "idle-queue" && outcome.idle.kind === "uncertain", label);
    assert.equal(outcome.raceDeclined, undefined, label);
    assert.deepEqual(await fixture.composer.deliver(request()), {
      route: "duplicate",
      delivery: "unknown",
    }, `${label}: not replayed and never reported as not delivered`);
    assert.deepEqual(fixture.log.entries, expected, `${label}: no steer, retry, or turn/start`);
  }
});

test("a positively not-delivered race releases the id for the caller's own later attempt", async () => {
  const fixture = setup(idle(TURN_OLD), {
    "thread/queue/add": added,
    "thread/queue/start": busyRefusal,
    "thread/queue/delete": deletedTrue,
  });
  const first = await fixture.composer.deliver(request());
  assert.equal(first.delivery, "not-delivered");
  fixture.facts.set(busy(TURN_RACE));
  const second = await fixture.composer.deliver(request());
  assert.equal(second.route, "busy-steer");
  assert.equal(second.delivery, "sent-unconfirmed");
});

/* ------------------------------------------------------------ boundaries */

test("the composition expresses no provider method, transport, or reply path of its own", () => {
  const source = fs.readFileSync(
    path.join(__dirname, "..", "..", "src", "session-host", "native-codex-callback-composition.ts"),
    "utf8",
  );
  const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  for (const forbidden of [
    "\"turn/start\"", "\"turn/steer\"", "\"turn/interrupt\"", "\"thread/resume\"", "\"thread/fork\"",
    "\"thread/queue/list\"", "\"thread/queue/clear\"", "new WebSocket", "from \"ws\"", "node:net", "node:fs",
    "requestApproval", "elicitation/", "setInterval",
  ]) {
    assert.ok(!code.includes(forbidden), `composition must not contain ${forbidden}`);
  }
  // Provider methods appear only as the fence's per-method write predicate.
  const quotedMethods = [...code.matchAll(/"([a-z]+\/[A-Za-z/]+)"/g)].map((match) => match[1]);
  assert.deepEqual([...new Set(quotedMethods)].sort(), ["thread/queue/add", "thread/queue/delete", "thread/queue/start"]);
  const imports = [...code.matchAll(/from "([^"]+)"/g)].map((match) => match[1]).sort();
  assert.deepEqual(imports, ["../record-guard", "./native-codex-callback-delivery", "./native-codex-idle-wake"]);
});

/* --------------------------------------------- queue write edge (deferred) */

test("a queue lane that is not ready confirms non-delivery with unchanged idle facts", async () => {
  const { composer, log, steer } = setup(idle(), { "thread/queue/add": () => ({ kind: "not-sent" }) });
  assert.deepEqual(await composer.deliver(request()), {
    route: "declined",
    reason: "queue-add-not-sent",
    delivery: "not-delivered",
  });
  assert.deepEqual(log.entries, []);
  assert.equal(steer.calls.length, 0);
});

test("idle that turns busy before add declines with no queue write and no steer", async () => {
  const fixture = setup(idle(TURN_OLD), { "thread/queue/add": added });
  const realRead = fixture.facts.read;
  let reads = 0;
  const composer = createNativeCodexCallbackComposer({
    owned: { threadId: THREAD, runId: RUN },
    readFacts: () => (++reads === 1 ? realRead() : busy(TURN_RACE)),
    steerLane: fixture.steer.lane,
    queueLane: fixture.queue.lane,
  });
  assert.deepEqual(await composer.deliver(request()), {
    route: "declined",
    reason: "queue-add-not-sent",
    delivery: "not-delivered",
  });
  assert.deepEqual(fixture.log.entries, [], "no add and no direct steer");
});

test("idle whose last turn changed before add is a stale decision and declines", async () => {
  const fixture = setup(idle(TURN_OLD), { "thread/queue/add": added });
  const realRead = fixture.facts.read;
  let reads = 0;
  const composer = createNativeCodexCallbackComposer({
    owned: { threadId: THREAD, runId: RUN },
    readFacts: () => (++reads === 1 ? realRead() : idle(TURN_BUSY)),
    steerLane: fixture.steer.lane,
    queueLane: fixture.queue.lane,
  });
  const outcome = await composer.deliver(request());
  assert.equal(outcome.route, "declined");
  assert.deepEqual(fixture.log.entries, []);
});

test("a deferred lane's add write edge refuses after the root turns busy; nothing written", async () => {
  const fixture = setup(idle(TURN_OLD), {
    "thread/queue/add": (_params, edge) => {
      fixture.facts.set(busy(TURN_RACE));
      return edge.mayWrite() ? added : { kind: "not-sent" };
    },
  });
  const outcome = await fixture.composer.deliver(request());
  assert.deepEqual(outcome, { route: "declined", reason: "queue-add-not-sent", delivery: "not-delivered" });
  assert.deepEqual(fixture.log.entries, []);
  assert.equal(fixture.steer.calls.length, 0);
});

test("a deferred lane's start write edge refuses after a user stop or revocation", async () => {
  for (const [label, changed] of [
    ["user stop", idle(TURN_OLD, { userStop: "stopped" })],
    ["revocation", idle(TURN_OLD, { runId: "run-generation-2" })],
  ] as const) {
    let edgeSaw: boolean | undefined;
    const fixture = setup(idle(TURN_OLD), {
      "thread/queue/add": added,
      // Entered while still current; the change lands before the deferred write.
      "thread/queue/start": async (_params, edge) => {
        await Promise.resolve();
        fixture.facts.set(changed);
        edgeSaw = edge.mayWrite();
        return edgeSaw ? startedTurn(TURN_RACE) : { kind: "not-sent" };
      },
    });
    const outcome = await fixture.composer.deliver(request());
    assert.equal(edgeSaw, false, label);
    assert.deepEqual(fixture.log.entries, ["thread/queue/add"], `${label}: start never written`);
    assert.equal(outcome.delivery, "unknown", `${label}: our added row may still be queued`);
    assert.ok(outcome.route === "idle-queue" && outcome.idle.kind === "uncertain" && outcome.idle.stage === "start", label);
    assert.deepEqual(await fixture.composer.deliver(request()), { route: "duplicate", delivery: "unknown" }, label);
    assert.deepEqual(fixture.log.entries, ["thread/queue/add"], `${label}: never replayed`);
  }
});

test("every queue write edge is permanently closed once the attempt ends", async () => {
  const fixture = setup(idle(TURN_OLD), {
    "thread/queue/add": added,
    "thread/queue/start": startedTurn(TURN_RACE),
  });
  const outcome = await fixture.composer.deliver(request());
  assert.equal(outcome.delivery, "turn-started");
  fixture.facts.set(idle(TURN_OLD));
  assert.equal(fixture.queue.edges.length, 2);
  for (const edge of fixture.queue.edges) assert.equal(edge.mayWrite(), false, "a late write is refused");
});

test("a lane still pending past the primitive deadline can never write afterwards", async () => {
  let lateEdge: NativeCodexCallbackQueueWriteEdge | undefined;
  let now = 0;
  const pending: Array<() => void> = [];
  const fixture = setup(idle(TURN_OLD), {
    "thread/queue/add": (_params, edge) => {
      lateEdge = edge;
      return new Promise<NativeCodexCallbackQueueLaneReply>(() => undefined);
    },
  }, undefined, {
    idleCallTimeoutMs: 5,
    idleTimers: {
      now: () => now,
      set: (callback) => {
        pending.push(callback);
        return pending.length;
      },
      clear: () => undefined,
    },
  });
  const delivery = fixture.composer.deliver(request());
  await Promise.resolve();
  assert.ok(lateEdge !== undefined);
  assert.equal(lateEdge.mayWrite(), true, "the edge is open before the deadline");
  now = 4;
  assert.equal(lateEdge.mayWrite(), true, "still open just before the deadline");
  now = 5;
  assert.equal(lateEdge.mayWrite(), false, "the deadline holds even before the timer runs");
  assert.equal(pending.length, 1);
  for (const fire of pending.splice(0)) fire();
  assert.equal(lateEdge.mayWrite(), false, "the timer closes the edge synchronously, before deliver settles");
  const outcome = await delivery;
  assert.equal(outcome.delivery, "unknown", "the primitive's timeout is preserved, never upgraded to not-delivered");
  assert.ok(outcome.route === "idle-queue" && outcome.idle.kind === "uncertain" && outcome.idle.reason === "timeout");
  assert.equal(lateEdge.mayWrite(), false, "the deferred add can no longer be written");
  assert.deepEqual(fixture.log.entries, []);
});

/* ---------------------------------------------------------- duplicates */

test("a duplicate id reports the earlier delivery, never not-delivered, and writes nothing", async () => {
  let release!: (value: NativeCodexCallbackSteerWireOutcome) => void;
  const fixture = setup(busy(), {}, () => new Promise((resolve) => { release = resolve; }));
  const first = fixture.composer.deliver(request());
  assert.deepEqual(await fixture.composer.deliver(request()), { route: "duplicate", delivery: "unknown" }, "in flight");
  release({ kind: "result", result: { turnId: TURN_BUSY } });
  assert.equal((await first).delivery, "sent-unconfirmed");
  assert.deepEqual(await fixture.composer.deliver(request()), { route: "duplicate", delivery: "sent-unconfirmed" });
  assert.equal(fixture.steer.calls.length, 1);

  const started = setup(idle(), { "thread/queue/add": added, "thread/queue/start": startedTurn(TURN_RACE) });
  assert.equal((await started.composer.deliver(request())).delivery, "turn-started");
  assert.deepEqual(await started.composer.deliver(request()), { route: "duplicate", delivery: "turn-started" });
  assert.deepEqual(started.log.entries, ["thread/queue/add", "thread/queue/start"]);
});
