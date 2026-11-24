/**
 * Codex idle-wake queue primitive (#682), tested with mocks only.
 *
 * A scripted fake caller stands in for the host-owned, experimentalApi-enabled
 * app-server connection. No live session, prompt, setting, or socket is used.
 * The tests cover operations on our own row, how transport and protocol
 * uncertainty is preserved, the absence of retries or replays, and the
 * disclosed experimental contract.
 */

import assert from "node:assert/strict";
import test from "node:test";
import {
  NATIVE_CODEX_IDLE_WAKE_CONTRACT,
  NATIVE_CODEX_IDLE_WAKE_DEFAULT_TIMEOUT_MS,
  wakeIdleNativeCodexThread,
  type NativeCodexIdleWakeCaller,
  type NativeCodexIdleWakeQueueMethod,
  type NativeCodexIdleWakeReply,
  type NativeCodexIdleWakeTimers,
} from "../src/session-host/native-codex-idle-wake";

const THREAD = "019a0000-0000-7000-8000-00000000a682";
const CALLBACK_ID = "wake-callback-682";
const ROW = "queued-row-1";
const TEXT = "Background work finished; please review the result.";
const BUSY = "thread already has an active or pending turn";
const PROVIDER_SECRET = "provider-private-detail";

type Step = NativeCodexIdleWakeReply | "throw" | "reject" | "never" | "garbage";

interface RecordedCall {
  method: NativeCodexIdleWakeQueueMethod;
  params: Readonly<Record<string, unknown>>;
  timeoutMs: number;
}

function fakeCaller(script: Partial<Record<NativeCodexIdleWakeQueueMethod, Step>>) {
  const calls: RecordedCall[] = [];
  const late: Array<(reply: NativeCodexIdleWakeReply) => void> = [];
  const caller: NativeCodexIdleWakeCaller = {
    request(method, params, timeoutMs) {
      calls.push({ method, params, timeoutMs });
      const step = script[method];
      if (step === undefined) throw new Error(`unscripted ${method}`);
      if (step === "throw") throw new Error(PROVIDER_SECRET);
      if (step === "reject") return Promise.reject(new Error(PROVIDER_SECRET));
      if (step === "never") return new Promise((resolve) => late.push(resolve));
      if (step === "garbage") return Promise.resolve({ kind: "bogus" } as unknown as NativeCodexIdleWakeReply);
      return Promise.resolve(step);
    },
  };
  return { caller, calls, late };
}

/** Virtual clock and timers: time moves and timers fire only when the test says so. */
function virtualTimers() {
  const pending = new Map<number, () => void>();
  let next = 0;
  let clock = 1_000;
  const timers: NativeCodexIdleWakeTimers = {
    now: () => clock,
    set(callback) {
      const id = ++next;
      pending.set(id, callback);
      return id;
    },
    clear(handle) {
      pending.delete(handle as number);
    },
  };
  const fireAll = () => {
    const callbacks = [...pending.values()];
    pending.clear();
    for (const callback of callbacks) callback();
  };
  /** Advance the clock WITHOUT running timer callbacks (a delayed event loop). */
  const advance = (ms: number) => {
    clock += ms;
  };
  return { timers, pending, fireAll, advance };
}

const request = { threadId: THREAD, clientUserMessageId: CALLBACK_ID, text: TEXT };
const ok = (result: unknown): NativeCodexIdleWakeReply => ({ kind: "result", result });
const rpcError = (code: number, message: string): NativeCodexIdleWakeReply => ({ kind: "error", code, message });
const addOk = ok({
  queuedSubmission: {
    id: ROW,
    input: [{ type: "text", text: TEXT, text_elements: [] }],
    clientUserMessageId: CALLBACK_ID,
    responsesapiClientMetadata: null,
  },
});
const startOk = ok({ turn: { id: "turn-9", status: "inProgress", items: [], itemsView: "notLoaded" } });
const startBusy = rpcError(-32600, BUSY);

function methods(calls: RecordedCall[]): string[] {
  return calls.map((call) => call.method);
}

async function run(script: Partial<Record<NativeCodexIdleWakeQueueMethod, Step>>) {
  const fake = fakeCaller(script);
  const { timers } = virtualTimers();
  const outcome = await wakeIdleNativeCodexThread(request, { caller: fake.caller, timers });
  return { outcome, calls: fake.calls };
}

test("discloses the experimental Codex 0.171.0 queue contract and nothing broader", () => {
  assert.equal(NATIVE_CODEX_IDLE_WAKE_CONTRACT.codexVersion, "0.171.0");
  assert.equal(NATIVE_CODEX_IDLE_WAKE_CONTRACT.requiredCapability, "experimentalApi");
  assert.deepEqual([...NATIVE_CODEX_IDLE_WAKE_CONTRACT.methods], ["thread/queue/add", "thread/queue/start", "thread/queue/delete"]);
  assert.ok(Object.isFrozen(NATIVE_CODEX_IDLE_WAKE_CONTRACT));
});

test("idle success: adds one row for our callback id, then atomically starts exactly that row", async () => {
  const { outcome, calls } = await run({ "thread/queue/add": addOk, "thread/queue/start": startOk });
  assert.deepEqual(outcome, { kind: "started", queuedSubmissionId: ROW, turnId: "turn-9" });
  assert.deepEqual(methods(calls), ["thread/queue/add", "thread/queue/start"]);
  assert.deepEqual(calls[0].params, {
    threadId: THREAD,
    input: [{ type: "text", text: TEXT, text_elements: [] }],
    clientUserMessageId: CALLBACK_ID,
  });
  // The exact provider-returned row id, never an id-less start of the queue head.
  assert.deepEqual(calls[1].params, { threadId: THREAD, queuedSubmissionId: ROW });
  for (const call of calls) assert.equal(call.timeoutMs, NATIVE_CODEX_IDLE_WAKE_DEFAULT_TIMEOUT_MS);
});

test("add-triggered auto-dispatch: our row absent at start stays uncertain, with no delete or replay", async () => {
  const { outcome, calls } = await run({
    "thread/queue/add": addOk,
    "thread/queue/start": rpcError(-32600, `queued submission not found: ${ROW}`),
  });
  assert.deepEqual(outcome, { kind: "uncertain", stage: "start", reason: "row-absent", queuedSubmissionId: ROW });
  assert.deepEqual(methods(calls), ["thread/queue/add", "thread/queue/start"]);
});

test("active refusal: deletes only our exact row and reports confirmed removal", async () => {
  const { outcome, calls } = await run({
    "thread/queue/add": addOk,
    "thread/queue/start": startBusy,
    "thread/queue/delete": ok({ deleted: true }),
  });
  assert.deepEqual(outcome, { kind: "busy-removed", queuedSubmissionId: ROW });
  assert.deepEqual(methods(calls), ["thread/queue/add", "thread/queue/start", "thread/queue/delete"]);
  assert.deepEqual(calls[2].params, { threadId: THREAD, queuedSubmissionId: ROW });
});

test("active refusal with deleted:false is uncertain: the row may have been auto-dispatched after the turn ended", async () => {
  const { outcome, calls } = await run({
    "thread/queue/add": addOk,
    "thread/queue/start": startBusy,
    "thread/queue/delete": ok({ deleted: false }),
  });
  assert.deepEqual(outcome, { kind: "uncertain", stage: "delete", reason: "not-deleted", queuedSubmissionId: ROW });
  assert.deepEqual(methods(calls), ["thread/queue/add", "thread/queue/start", "thread/queue/delete"]);
});

const AMBIGUOUS: Array<[string, Step, string]> = [
  ["timeout", { kind: "failed", failure: "timeout" }, "timeout"],
  ["close", { kind: "failed", failure: "closed" }, "closed"],
  ["write failure", { kind: "failed", failure: "write" }, "write"],
  ["thrown caller", "throw", "transport-error"],
  ["rejected caller", "reject", "transport-error"],
  ["invalid caller reply", "garbage", "transport-error"],
  ["unclassified error response", rpcError(-32603, PROVIDER_SECRET), "error-response"],
];

for (const [label, step, reason] of AMBIGUOUS) {
  test(`add ${label} is uncertain and never starts anything`, async () => {
    const { outcome, calls } = await run({ "thread/queue/add": step });
    assert.deepEqual(outcome, { kind: "uncertain", stage: "add", reason, queuedSubmissionId: null });
    assert.deepEqual(methods(calls), ["thread/queue/add"]);
  });

  test(`start ${label} is uncertain with no delete, retry, or retarget`, async () => {
    const { outcome, calls } = await run({ "thread/queue/add": addOk, "thread/queue/start": step });
    assert.deepEqual(outcome, { kind: "uncertain", stage: "start", reason, queuedSubmissionId: ROW });
    assert.deepEqual(methods(calls), ["thread/queue/add", "thread/queue/start"]);
  });

  test(`busy-path delete ${label} is uncertain with no second delete or start`, async () => {
    const { outcome, calls } = await run({
      "thread/queue/add": addOk,
      "thread/queue/start": startBusy,
      "thread/queue/delete": step,
    });
    assert.deepEqual(outcome, { kind: "uncertain", stage: "delete", reason, queuedSubmissionId: ROW });
    assert.deepEqual(methods(calls), ["thread/queue/add", "thread/queue/start", "thread/queue/delete"]);
  });
}

test("unsupported add (method missing or experimentalApi not negotiated) is closed and creates nothing", async () => {
  for (const reply of [
    rpcError(-32601, "Method not found"),
    rpcError(-32600, "thread/queue/add requires experimentalApi capability"),
    rpcError(-32600, "Invalid request: unknown variant `thread/queue/add`, expected one of ..."),
  ]) {
    const { outcome, calls } = await run({ "thread/queue/add": reply });
    assert.deepEqual(outcome, { kind: "unsupported", stage: "add" });
    assert.deepEqual(methods(calls), ["thread/queue/add"]);
  }
  // A look-alike invalid request is not proof that nothing was queued.
  const { outcome } = await run({ "thread/queue/add": rpcError(-32600, "thread not found: x") });
  assert.deepEqual(outcome, { kind: "uncertain", stage: "add", reason: "error-response", queuedSubmissionId: null });
});

test("malformed or foreign add results are uncertain and never started", async () => {
  const cases: Array<[unknown, string]> = [
    [{}, "malformed-response"],
    [{ queuedSubmission: { id: "", clientUserMessageId: CALLBACK_ID } }, "malformed-response"],
    [{ queuedSubmission: { id: 7, clientUserMessageId: CALLBACK_ID } }, "malformed-response"],
    [{ queuedSubmission: { id: ROW, clientUserMessageId: "someone-else" } }, "identity-mismatch"],
    [{ queuedSubmission: { id: ROW } }, "identity-mismatch"],
  ];
  for (const [result, reason] of cases) {
    const { outcome, calls } = await run({ "thread/queue/add": ok(result) });
    assert.deepEqual(outcome, { kind: "uncertain", stage: "add", reason, queuedSubmissionId: null });
    assert.deepEqual(methods(calls), ["thread/queue/add"]);
  }
});

test("start refusals other than the exact busy message never trigger a delete", async () => {
  for (const reply of [
    rpcError(-32001, "server is draining"),
    rpcError(-32603, BUSY), // busy text under the wrong code
    rpcError(-32600, "queued submission not found: some-other-row"),
    rpcError(-32600, `${BUSY}.`),
  ]) {
    const { outcome, calls } = await run({ "thread/queue/add": addOk, "thread/queue/start": reply });
    assert.deepEqual(outcome, { kind: "uncertain", stage: "start", reason: "error-response", queuedSubmissionId: ROW });
    assert.deepEqual(methods(calls), ["thread/queue/add", "thread/queue/start"]);
  }
});

test("malformed start or delete results are uncertain, never success", async () => {
  for (const result of [{}, { turn: { status: "inProgress" } }, { turn: { id: "t", status: "completed" } }, { turn: { id: "t" } }]) {
    const { outcome } = await run({ "thread/queue/add": addOk, "thread/queue/start": ok(result) });
    assert.deepEqual(outcome, { kind: "uncertain", stage: "start", reason: "malformed-response", queuedSubmissionId: ROW });
  }
  for (const result of [{}, { deleted: "true" }, null]) {
    const { outcome } = await run({ "thread/queue/add": addOk, "thread/queue/start": startBusy, "thread/queue/delete": ok(result) });
    assert.deepEqual(outcome, { kind: "uncertain", stage: "delete", reason: "malformed-response", queuedSubmissionId: ROW });
  }
});

test("own deadline bounds a silent caller, and a late success cannot upgrade the uncertain outcome", async () => {
  const fake = fakeCaller({ "thread/queue/add": addOk, "thread/queue/start": "never" });
  const clock = virtualTimers();
  const pendingOutcome = wakeIdleNativeCodexThread(request, { caller: fake.caller, timers: clock.timers, callTimeoutMs: 1_500 });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(methods(fake.calls), ["thread/queue/add", "thread/queue/start"]);
  assert.equal(clock.pending.size, 1, "the in-flight start carries exactly one deadline");
  clock.fireAll();
  const outcome = await pendingOutcome;
  assert.deepEqual(outcome, { kind: "uncertain", stage: "start", reason: "timeout", queuedSubmissionId: ROW });
  fake.late[0](startOk);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(methods(fake.calls), ["thread/queue/add", "thread/queue/start"]);
  assert.ok(fake.calls.every((call) => call.timeoutMs === 1_500));
  assert.equal(clock.pending.size, 0, "settled calls leave no timer behind");
});

/** Resolve a held reply only after the clock passes its deadline, with the timer callback never run. */
async function lateReplyBeforeTimerFires(
  script: Partial<Record<NativeCodexIdleWakeQueueMethod, Step>>,
  heldReply: NativeCodexIdleWakeReply,
  expectedCalls: number,
) {
  const fake = fakeCaller(script);
  const clock = virtualTimers();
  const pendingOutcome = wakeIdleNativeCodexThread(request, { caller: fake.caller, timers: clock.timers, callTimeoutMs: 1_500 });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(fake.calls.length, expectedCalls);
  assert.equal(fake.late.length, 1);
  clock.advance(1_500);
  fake.late[0](heldReply);
  const outcome = await pendingOutcome;
  await new Promise((resolve) => setImmediate(resolve));
  return { outcome, calls: fake.calls, clock };
}

test("a successful add that arrives after its deadline, before the timer runs, is a timeout and never starts", async () => {
  const { outcome, calls, clock } = await lateReplyBeforeTimerFires({ "thread/queue/add": "never" }, addOk, 1);
  assert.deepEqual(outcome, { kind: "uncertain", stage: "add", reason: "timeout", queuedSubmissionId: null });
  assert.deepEqual(methods(calls), ["thread/queue/add"]);
  assert.equal(clock.pending.size, 0);
});

test("a busy refusal that arrives after its deadline, before the timer runs, is a timeout and never deletes", async () => {
  const { outcome, calls } = await lateReplyBeforeTimerFires(
    { "thread/queue/add": addOk, "thread/queue/start": "never" },
    startBusy,
    2,
  );
  assert.deepEqual(outcome, { kind: "uncertain", stage: "start", reason: "timeout", queuedSubmissionId: ROW });
  assert.deepEqual(methods(calls), ["thread/queue/add", "thread/queue/start"]);
});

test("a deleted:true that arrives after its deadline, before the timer runs, is a timeout, not confirmed removal", async () => {
  const { outcome, calls } = await lateReplyBeforeTimerFires(
    { "thread/queue/add": addOk, "thread/queue/start": startBusy, "thread/queue/delete": "never" },
    ok({ deleted: true }),
    3,
  );
  assert.deepEqual(outcome, { kind: "uncertain", stage: "delete", reason: "timeout", queuedSubmissionId: ROW });
  assert.deepEqual(methods(calls), ["thread/queue/add", "thread/queue/start", "thread/queue/delete"]);
});

test("a reply just inside the deadline is accepted", async () => {
  const fake = fakeCaller({ "thread/queue/add": "never", "thread/queue/start": startOk });
  const clock = virtualTimers();
  const pendingOutcome = wakeIdleNativeCodexThread(request, { caller: fake.caller, timers: clock.timers, callTimeoutMs: 1_500 });
  await new Promise((resolve) => setImmediate(resolve));
  clock.advance(1_499);
  fake.late[0](addOk);
  assert.deepEqual(await pendingOutcome, { kind: "started", queuedSubmissionId: ROW, turnId: "turn-9" });
  assert.deepEqual(methods(fake.calls), ["thread/queue/add", "thread/queue/start"]);
});

test("invalid local inputs send nothing", async () => {
  const bad: Array<[Record<string, unknown>, number | undefined]> = [
    [{ ...request, threadId: "" }, undefined],
    [{ ...request, threadId: "has space" }, undefined],
    [{ ...request, clientUserMessageId: "" }, undefined],
    [{ ...request, clientUserMessageId: "x".repeat(257) }, undefined],
    [{ ...request, text: "   " }, undefined],
    [{ ...request, text: 42 }, undefined],
    [request, 0],
    [request, 60_001],
    [request, 1.5],
  ];
  for (const [input, callTimeoutMs] of bad) {
    const fake = fakeCaller({});
    const outcome = await wakeIdleNativeCodexThread(input as never, { caller: fake.caller, callTimeoutMs });
    assert.deepEqual(outcome, { kind: "rejected-input" });
    assert.equal(fake.calls.length, 0);
  }
});

test("outcomes never carry provider error text", async () => {
  const outcomes = [
    (await run({ "thread/queue/add": rpcError(-32603, PROVIDER_SECRET) })).outcome,
    (await run({ "thread/queue/add": addOk, "thread/queue/start": "throw" })).outcome,
    (await run({ "thread/queue/add": addOk, "thread/queue/start": startBusy, "thread/queue/delete": rpcError(-32603, PROVIDER_SECRET) })).outcome,
  ];
  for (const outcome of outcomes) assert.ok(!JSON.stringify(outcome).includes(PROVIDER_SECRET));
});
