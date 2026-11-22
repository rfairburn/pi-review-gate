/**
 * Busy-turn native Codex callback delivery primitive (issue #682).
 *
 * Every case drives the real sender against a synthetic in-process stub lane:
 * no provider is launched, no socket is opened, and no prompt reaches a model.
 * The focus is what the sender can put on the lane (exactly one expected-turn
 * `turn/steer` with exact fields, or nothing), how it separates RPC acceptance
 * from placement, and that stale, mismatched, duplicate, or ambiguous inputs
 * and answers fail closed without retry or retarget.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import {
  NATIVE_CODEX_CALLBACK_LANE_OWNERSHIP,
  NATIVE_CODEX_CALLBACK_MAX_REMEMBERED_SUBMISSIONS,
  NATIVE_CODEX_CALLBACK_MAX_TEXT_BYTES,
  classifyNativeCodexCallbackPlacement,
  classifyNativeCodexCallbackSteerError,
  createNativeCodexCallbackSteerSender,
  type NativeCodexCallbackSteerLane,
  type NativeCodexCallbackSteerParams,
  type NativeCodexCallbackSteerTarget,
  type NativeCodexCallbackSteerWireOutcome,
  type NativeCodexCallbackSteerWriteEdge,
} from "../src/session-host/native-codex-callback-delivery";

const THREAD = "11111111-1111-4111-8111-111111111111";
const TURN = "turn-aaaaaaaa";
const OTHER_TURN = "turn-bbbbbbbb";
const MSG_ID = "callback-record-0001";
const TEXT = "CALLBACK-TEXT-SENTINEL: worker finished";
const SECRET_MESSAGE = "PROVIDER-ERROR-SENTINEL /private/path token=xyz";

interface StubLane extends NativeCodexCallbackSteerLane {
  readonly calls: NativeCodexCallbackSteerParams[];
  readonly edges: NativeCodexCallbackSteerWriteEdge[];
}

function stubLane(
  respond: (
    params: NativeCodexCallbackSteerParams,
    writeEdge: NativeCodexCallbackSteerWriteEdge,
  ) => Promise<NativeCodexCallbackSteerWireOutcome> | NativeCodexCallbackSteerWireOutcome,
  overrides: Record<string, unknown> = {},
): StubLane {
  const calls: NativeCodexCallbackSteerParams[] = [];
  const edges: NativeCodexCallbackSteerWriteEdge[] = [];
  return {
    ownership: NATIVE_CODEX_CALLBACK_LANE_OWNERSHIP,
    endpoint: { kind: "unix", socketPath: "/tmp/pi-owned/codex.sock" },
    capability: { expectedTurnSteer: true },
    calls,
    edges,
    async steer(params, writeEdge) {
      calls.push(params);
      edges.push(writeEdge);
      return respond(params, writeEdge);
    },
    ...overrides,
  } as StubLane;
}

const accept = (params: NativeCodexCallbackSteerParams): NativeCodexCallbackSteerWireOutcome => ({
  kind: "result",
  result: { turnId: params.expectedTurnId },
});

function current(target: NativeCodexCallbackSteerTarget | null = { threadId: THREAD, turnId: TURN }) {
  return () => target;
}

const request = (overrides: Record<string, unknown> = {}) => ({
  target: { threadId: THREAD, turnId: TURN },
  clientUserMessageId: MSG_ID,
  text: TEXT,
  ...overrides,
}) as Parameters<ReturnType<typeof createNativeCodexCallbackSteerSender>["send"]>[0];

test("sends exactly one expected-turn steer with exact fields and reports acceptance, not placement", async () => {
  const lane = stubLane(accept);
  const sender = createNativeCodexCallbackSteerSender({ lane, readCurrentTarget: current() });
  const outcome = await sender.send(request());

  assert.equal(lane.calls.length, 1);
  const params = lane.calls[0];
  assert.deepEqual(Object.keys(params).sort(), ["clientUserMessageId", "expectedTurnId", "input", "threadId"]);
  assert.equal(params.threadId, THREAD);
  assert.equal(params.expectedTurnId, TURN);
  assert.equal(params.clientUserMessageId, MSG_ID);
  assert.deepEqual(params.input, [{ type: "text", text: TEXT }]);
  assert.ok(Object.isFrozen(params) && Object.isFrozen(params.input) && Object.isFrozen(params.input[0]));

  assert.deepEqual(outcome, {
    status: "accepted",
    sent: true,
    acceptance: { threadId: THREAD, turnId: TURN, clientUserMessageId: MSG_ID },
    placement: "unconfirmed",
  });
  assert.ok(!JSON.stringify(outcome).includes("CALLBACK-TEXT-SENTINEL"), "callback text never rides a result");
});

test("invalid input is refused before the lane is touched", async () => {
  const cases: Array<Record<string, unknown>> = [
    { target: { threadId: "", turnId: TURN } },
    { target: { threadId: ` ${THREAD}`, turnId: TURN } },
    { target: { threadId: THREAD, turnId: "turn\u0000x" } },
    { target: { threadId: THREAD, turnId: "x".repeat(257) } },
    { target: null },
    { clientUserMessageId: "" },
    { clientUserMessageId: "has space" },
    { clientUserMessageId: "-leading" },
    { clientUserMessageId: "x".repeat(129) },
    { clientUserMessageId: 42 },
    { text: "" },
    { text: "   \n" },
    { text: "a\u0000b" },
    { text: "x".repeat(NATIVE_CODEX_CALLBACK_MAX_TEXT_BYTES + 1) },
    { text: { toString: () => TEXT } },
  ];
  for (const overrides of cases) {
    const lane = stubLane(accept);
    const sender = createNativeCodexCallbackSteerSender({ lane, readCurrentTarget: current() });
    const outcome = await sender.send(request(overrides));
    assert.deepEqual(outcome, { status: "refused", code: "input-invalid", sent: false }, JSON.stringify(Object.keys(overrides)));
    assert.equal(lane.calls.length, 0);
  }
  const lane = stubLane(accept);
  const sender = createNativeCodexCallbackSteerSender({ lane, readCurrentTarget: current() });
  assert.equal((await sender.send(null as never)).status, "refused");
  assert.equal(lane.calls.length, 0);
});

test("unknown or stale trusted target is refused without send or retarget", async () => {
  const cases: Array<{ read: () => unknown; code: string }> = [
    { read: () => null, code: "target-unknown" },
    { read: () => { throw new Error("observer gone"); }, code: "target-unknown" },
    { read: () => ({ threadId: THREAD }), code: "target-unknown" },
    { read: () => ({ threadId: THREAD, turnId: OTHER_TURN }), code: "target-stale" },
    { read: () => ({ threadId: "22222222-2222-4222-8222-222222222222", turnId: TURN }), code: "target-stale" },
  ];
  for (const { read, code } of cases) {
    const lane = stubLane(accept);
    const sender = createNativeCodexCallbackSteerSender({
      lane,
      readCurrentTarget: read as () => NativeCodexCallbackSteerTarget | null,
    });
    assert.deepEqual(await sender.send(request()), { status: "refused", code, sent: false });
    assert.equal(lane.calls.length, 0, `${code} must not write and must not retarget to the current turn`);
  }
  const lane = stubLane(accept);
  const sender = createNativeCodexCallbackSteerSender({ lane, readCurrentTarget: undefined as never });
  assert.deepEqual(await sender.send(request()), { status: "refused", code: "target-unknown", sent: false });
});

test("the current target is re-read at send time, so a turn that moved on is refused", async () => {
  let target: NativeCodexCallbackSteerTarget | null = { threadId: THREAD, turnId: TURN };
  const lane = stubLane(accept);
  const sender = createNativeCodexCallbackSteerSender({ lane, readCurrentTarget: () => target });
  target = { threadId: THREAD, turnId: OTHER_TURN };
  assert.equal((await sender.send(request())).status, "refused");
  target = null;
  assert.equal((await sender.send(request())).status, "refused");
  assert.equal(lane.calls.length, 0);
});

test("untrusted, unsupported, or unattested lanes refuse every send", async () => {
  const cases: Array<{ overrides: Record<string, unknown>; code: string }> = [
    { overrides: { ownership: "observer" }, code: "lane-untrusted" },
    { overrides: { ownership: undefined }, code: "lane-untrusted" },
    { overrides: { steer: undefined }, code: "lane-untrusted" },
    { overrides: { endpoint: { kind: "unix", socketPath: "" } }, code: "endpoint-unsupported" },
    { overrides: { endpoint: { kind: "loopback-ws", host: "localhost", port: 4000, authorization: { scheme: "bearer", token: () => "t" } } }, code: "endpoint-unsupported" },
    { overrides: { endpoint: { kind: "loopback-ws", host: "127.0.0.1", port: 4000 } }, code: "endpoint-unsupported" },
    { overrides: { endpoint: { kind: "loopback-ws", host: "10.0.0.2", port: 4000, authorization: { scheme: "bearer", token: () => "t" } } }, code: "endpoint-unsupported" },
    { overrides: { endpoint: { kind: "tcp", host: "127.0.0.1", port: 4000 } }, code: "endpoint-unsupported" },
    { overrides: { capability: { expectedTurnSteer: false } }, code: "capability-unsupported" },
    { overrides: { capability: { expectedTurnSteer: "yes" } }, code: "capability-unsupported" },
    { overrides: { capability: undefined }, code: "capability-unsupported" },
  ];
  for (const { overrides, code } of cases) {
    let called = 0;
    const lane = stubLane((params) => {
      called += 1;
      return accept(params);
    }, overrides);
    const sender = createNativeCodexCallbackSteerSender({ lane, readCurrentTarget: current() });
    assert.deepEqual(await sender.send(request()), { status: "refused", code, sent: false }, code);
    assert.equal(called, 0);
  }
  const lane = stubLane(accept, {
    endpoint: { kind: "loopback-ws", host: "127.0.0.1", port: 41_234, authorization: { scheme: "bearer", token: () => "owned-token" } },
  });
  const sender = createNativeCodexCallbackSteerSender({ lane, readCurrentTarget: current() });
  assert.equal((await sender.send(request())).status, "accepted", "an authenticated owned loopback lane is supported");
});

test("provider error answers are definitive rejections with closed reasons and no message", async () => {
  const cases: Array<{ error: unknown; reason: string }> = [
    { error: { code: -32600, message: `expected active turn id \`${TURN}\` but found \`${OTHER_TURN}\` ${SECRET_MESSAGE}` }, reason: "turn-mismatch" },
    { error: { code: -32600, message: `no active turn to steer ${SECRET_MESSAGE}` }, reason: "no-active-turn" },
    { error: { code: -32600, message: SECRET_MESSAGE, data: { codexErrorInfo: { activeTurnNotSteerable: { turnKind: "review" } } } }, reason: "not-steerable" },
    { error: { code: -32600, message: `thread not found: ${SECRET_MESSAGE}` }, reason: "thread-not-found" },
    { error: { code: -32603, message: SECRET_MESSAGE }, reason: "unclassified" },
  ];
  for (const { error, reason } of cases) {
    assert.equal(classifyNativeCodexCallbackSteerError(error), reason);
    const lane = stubLane(() => ({ kind: "error", error }));
    const sender = createNativeCodexCallbackSteerSender({ lane, readCurrentTarget: current() });
    const outcome = await sender.send(request());
    assert.deepEqual(outcome, { status: "rejected", reason, sent: true });
    assert.equal(lane.calls.length, 1, "a rejection is never retried");
    assert.ok(!JSON.stringify(outcome).includes("SENTINEL"));
  }
});

test("a malformed error payload is not proof of refusal: uncertain, id stays burned", async () => {
  const malformed: unknown[] = [
    "garbage",
    null,
    undefined,
    {},
    { message: `no active turn to steer ${SECRET_MESSAGE}` },
    { code: "-32600", message: "no active turn to steer" },
    { code: -32600.5, message: "no active turn to steer" },
    { code: -32600 },
    { code: -32600, message: { text: SECRET_MESSAGE } },
  ];
  for (const error of malformed) {
    assert.equal(classifyNativeCodexCallbackSteerError(error), null);
    const lane = stubLane(() => ({ kind: "error", error }));
    const sender = createNativeCodexCallbackSteerSender({ lane, readCurrentTarget: current() });
    const outcome = await sender.send(request());
    assert.deepEqual(outcome, { status: "uncertain", reason: "malformed-error", sent: "unknown" }, JSON.stringify(error) ?? "undefined");
    assert.ok(!JSON.stringify(outcome).includes("SENTINEL"));
    assert.deepEqual(await sender.send(request()), { status: "refused", code: "duplicate-submission", sent: false });
    assert.equal(lane.calls.length, 1);
  }
});

test("missing or mismatched answers are uncertain, never retried, and the id stays burned", async () => {
  const cases: Array<{ respond: () => Promise<NativeCodexCallbackSteerWireOutcome> | NativeCodexCallbackSteerWireOutcome; reason: string }> = [
    { respond: () => ({ kind: "no-response", reason: "timeout" }), reason: "timeout" },
    { respond: () => ({ kind: "no-response", reason: "closed" }), reason: "closed-after-send" },
    { respond: () => Promise.reject(new Error(SECRET_MESSAGE)), reason: "lane-fault" },
    { respond: () => undefined as never, reason: "lane-fault" },
    { respond: () => ({ kind: "surprise" }) as never, reason: "lane-fault" },
    { respond: () => ({ kind: "result", result: {} }), reason: "malformed-acceptance" },
    { respond: () => ({ kind: "result", result: { turnId: ` ${TURN}` } }), reason: "malformed-acceptance" },
    { respond: () => ({ kind: "result", result: null }), reason: "malformed-acceptance" },
    { respond: () => ({ kind: "result", result: { turnId: OTHER_TURN } }), reason: "acceptance-turn-mismatch" },
  ];
  for (const { respond, reason } of cases) {
    const lane = stubLane(respond);
    const sender = createNativeCodexCallbackSteerSender({ lane, readCurrentTarget: current() });
    const outcome = await sender.send(request());
    assert.deepEqual(outcome, { status: "uncertain", reason, sent: "unknown" }, reason);
    assert.ok(!JSON.stringify(outcome).includes("SENTINEL"));
    assert.equal(lane.calls.length, 1);
    assert.deepEqual(
      await sender.send(request()),
      { status: "refused", code: "duplicate-submission", sent: false },
      `${reason}: an ambiguous submission must not be blindly resent`,
    );
    assert.equal(lane.calls.length, 1);
  }
});

test("duplicate submission after acceptance or rejection is refused; a fresh id is allowed", async () => {
  const lane = stubLane(accept);
  const sender = createNativeCodexCallbackSteerSender({ lane, readCurrentTarget: current() });
  assert.equal((await sender.send(request())).status, "accepted");
  assert.deepEqual(await sender.send(request()), { status: "refused", code: "duplicate-submission", sent: false });
  assert.equal((await sender.send(request({ clientUserMessageId: "callback-record-0002" }))).status, "accepted");
  assert.equal(lane.calls.length, 2);
});

test("a positively unsent frame releases the id for the caller's own policy", async () => {
  let notSent = true;
  const lane = stubLane((params) => (notSent ? { kind: "not-sent" } : accept(params)));
  const sender = createNativeCodexCallbackSteerSender({ lane, readCurrentTarget: current() });
  assert.deepEqual(await sender.send(request()), { status: "refused", code: "lane-not-sent", sent: false });
  notSent = false;
  assert.equal((await sender.send(request())).status, "accepted");
  assert.equal(lane.calls.length, 2, "only explicit caller re-offers reach the lane; the sender never retries by itself");
});

test("at capacity new ids are refused and no written id is ever evicted into a resend", async () => {
  const lane = stubLane(() => ({ kind: "no-response", reason: "timeout" }));
  const sender = createNativeCodexCallbackSteerSender({ lane, readCurrentTarget: current() });
  const id = (n: number) => `callback-${n}`;
  for (let n = 0; n < NATIVE_CODEX_CALLBACK_MAX_REMEMBERED_SUBMISSIONS; n += 1) {
    assert.equal((await sender.send(request({ clientUserMessageId: id(n) }))).status, "uncertain");
  }
  assert.equal(lane.calls.length, NATIVE_CODEX_CALLBACK_MAX_REMEMBERED_SUBMISSIONS);
  assert.deepEqual(
    await sender.send(request({ clientUserMessageId: id(NATIVE_CODEX_CALLBACK_MAX_REMEMBERED_SUBMISSIONS) })),
    { status: "refused", code: "submission-capacity", sent: false },
  );
  assert.deepEqual(
    await sender.send(request({ clientUserMessageId: id(0) })),
    { status: "refused", code: "duplicate-submission", sent: false },
    "the first uncertain id is still remembered and cannot be resent",
  );
  assert.equal(lane.calls.length, NATIVE_CODEX_CALLBACK_MAX_REMEMBERED_SUBMISSIONS, "no lane call after capacity");
});

test("positively unsent attempts never consume capacity", async () => {
  const lane = stubLane(() => ({ kind: "not-sent" }));
  const sender = createNativeCodexCallbackSteerSender({ lane, readCurrentTarget: current() });
  for (let n = 0; n < NATIVE_CODEX_CALLBACK_MAX_REMEMBERED_SUBMISSIONS + 5; n += 1) {
    assert.deepEqual(
      await sender.send(request({ clientUserMessageId: `unsent-${n}` })),
      { status: "refused", code: "lane-not-sent", sent: false },
    );
  }
});

test("write edge: a deferred write after a host rebind is refused even if the old turn would still match", async () => {
  let target: NativeCodexCallbackSteerTarget | null = { threadId: THREAD, turnId: TURN };
  let proceed!: () => void;
  const ready = new Promise<void>((resolve) => { proceed = resolve; });
  let wrote = false;
  const lane = stubLane(async (params, writeEdge) => {
    assert.equal(writeEdge.isTargetStillCurrent(), true, "current at the moment steer is called");
    await ready; // e.g. a lane that (against the contract) awaits connection setup
    if (!writeEdge.isTargetStillCurrent()) return { kind: "not-sent" };
    wrote = true;
    return accept(params);
  });
  const sender = createNativeCodexCallbackSteerSender({ lane, readCurrentTarget: () => target });
  const pending = sender.send(request());
  // The host rebinds the row while the provider's old turn is still active.
  target = { threadId: "22222222-2222-4222-8222-222222222222", turnId: "turn-new" };
  proceed();
  assert.deepEqual(await pending, { status: "refused", code: "lane-not-sent", sent: false });
  assert.equal(wrote, false);

  // Becoming idle (no trusted target) or a reader fault also closes the edge.
  for (const read of [() => null, () => { throw new Error("gone"); }]) {
    let flip!: () => void;
    const gate = new Promise<void>((resolve) => { flip = resolve; });
    let live = true;
    const guarded = stubLane(async (params, writeEdge) => {
      await gate;
      return writeEdge.isTargetStillCurrent() ? accept(params) : { kind: "not-sent" };
    });
    const s2 = createNativeCodexCallbackSteerSender({
      lane: guarded,
      readCurrentTarget: () => (live ? { threadId: THREAD, turnId: TURN } : (read as () => NativeCodexCallbackSteerTarget | null)()),
    });
    const p2 = s2.send(request());
    live = false;
    flip();
    assert.deepEqual(await p2, { status: "refused", code: "lane-not-sent", sent: false });
  }
});

test("write edge is permanently closed once steer settles", async () => {
  const lane = stubLane(accept);
  const sender = createNativeCodexCallbackSteerSender({ lane, readCurrentTarget: current() });
  assert.equal((await sender.send(request())).status, "accepted");
  assert.equal(lane.edges.length, 1);
  assert.equal(lane.edges[0].isTargetStillCurrent(), false, "a late write after settlement is never current");
});

test("one send at a time: a concurrent send is refused instead of queued", async () => {
  let release!: (outcome: NativeCodexCallbackSteerWireOutcome) => void;
  let held = false;
  const lane = stubLane((params) => {
    if (held) return accept(params);
    held = true;
    return new Promise((resolve) => { release = resolve; });
  });
  const sender = createNativeCodexCallbackSteerSender({ lane, readCurrentTarget: current() });
  const first = sender.send(request());
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(
    await sender.send(request({ clientUserMessageId: "callback-record-0002" })),
    { status: "refused", code: "in-flight", sent: false },
  );
  release({ kind: "result", result: { turnId: TURN } });
  assert.equal((await first).status, "accepted");
  assert.equal((await sender.send(request({ clientUserMessageId: "callback-record-0002" }))).status, "accepted");
  assert.equal(lane.calls.length, 2);
});

test("placement verdicts are separate from acceptance and default to uncertain", () => {
  const acceptance = { threadId: THREAD, turnId: TURN, clientUserMessageId: MSG_ID };
  const here = { threadId: THREAD, turnId: TURN, clientUserMessageId: MSG_ID };
  const later = { threadId: THREAD, turnId: OTHER_TURN, clientUserMessageId: MSG_ID };
  const evidence = (observedIn: unknown[], acceptedTurnEnded: unknown = null) =>
    ({ submission: acceptance, observedIn, acceptedTurnEnded }) as never;

  assert.deepEqual(classifyNativeCodexCallbackPlacement(acceptance, evidence([here])), { verdict: "placed" });
  assert.deepEqual(
    classifyNativeCodexCallbackPlacement(acceptance, evidence([here], { status: "interrupted", observationComplete: true })),
    { verdict: "placed" },
  );
  assert.deepEqual(classifyNativeCodexCallbackPlacement(acceptance, evidence([later])), { verdict: "mismatch" });
  assert.deepEqual(classifyNativeCodexCallbackPlacement(acceptance, evidence([here, later])), { verdict: "mismatch" });
  assert.deepEqual(
    classifyNativeCodexCallbackPlacement(acceptance, evidence([here, here])),
    { verdict: "uncertain", reason: "duplicate-observation" },
  );
  // Held until a tool boundary or approval: still pending, not missing.
  assert.deepEqual(classifyNativeCodexCallbackPlacement(acceptance, evidence([])), { verdict: "uncertain", reason: "pending" });
  // Dropped after an operator interrupt, seen under complete observation.
  assert.deepEqual(
    classifyNativeCodexCallbackPlacement(acceptance, evidence([], { status: "interrupted", observationComplete: true })),
    { verdict: "missing", turnStatus: "interrupted" },
  );
  assert.deepEqual(
    classifyNativeCodexCallbackPlacement(acceptance, evidence([], { status: "completed", observationComplete: false })),
    { verdict: "uncertain", reason: "observation-incomplete" },
  );
  for (const bad of [
    evidence([{ threadId: THREAD, turnId: TURN }]),
    evidence([{ threadId: THREAD }]),
    { submission: acceptance, observedIn: "nope", acceptedTurnEnded: null },
    { observedIn: [here], acceptedTurnEnded: null },
    evidence([], { status: "exploded", observationComplete: true }),
  ]) {
    assert.deepEqual(classifyNativeCodexCallbackPlacement(acceptance, bad as never), { verdict: "uncertain", reason: "evidence-invalid" });
  }
  assert.deepEqual(
    classifyNativeCodexCallbackPlacement({ ...acceptance, turnId: "" }, evidence([here])),
    { verdict: "uncertain", reason: "evidence-invalid" },
  );
  assert.deepEqual(
    classifyNativeCodexCallbackPlacement({ ...acceptance, clientUserMessageId: "" }, evidence([here])),
    { verdict: "uncertain", reason: "evidence-invalid" },
  );
});

test("evidence for one submission cannot establish placement for another accepted in the same turn", async () => {
  const lane = stubLane(accept);
  const sender = createNativeCodexCallbackSteerSender({ lane, readCurrentTarget: current() });
  const a = await sender.send(request({ clientUserMessageId: "callback-A" }));
  const b = await sender.send(request({ clientUserMessageId: "callback-B" }));
  assert.ok(a.status === "accepted" && b.status === "accepted");
  const evidenceForA = {
    submission: a.acceptance,
    observedIn: [{ threadId: THREAD, turnId: TURN, clientUserMessageId: "callback-A" }],
    acceptedTurnEnded: null,
  };
  assert.deepEqual(classifyNativeCodexCallbackPlacement(a.acceptance, evidenceForA), { verdict: "placed" });
  assert.deepEqual(
    classifyNativeCodexCallbackPlacement(b.acceptance, evidenceForA),
    { verdict: "uncertain", reason: "evidence-identity-mismatch" },
  );
  // Even relabelled as B's evidence, an observation of A is not about B.
  assert.deepEqual(
    classifyNativeCodexCallbackPlacement(b.acceptance, { ...evidenceForA, submission: b.acceptance }),
    { verdict: "uncertain", reason: "evidence-identity-mismatch" },
  );
  // And A's completed-turn silence cannot make B missing.
  assert.deepEqual(
    classifyNativeCodexCallbackPlacement(b.acceptance, {
      submission: a.acceptance,
      observedIn: [],
      acceptedTurnEnded: { status: "interrupted", observationComplete: true },
    }),
    { verdict: "uncertain", reason: "evidence-identity-mismatch" },
  );
});

test("the module cannot express other turn controls, subscription, or server-request replies", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "..", "src", "session-host", "native-codex-callback-delivery.ts"), "utf8");
  for (const forbidden of [
    "\"turn/start\"", "\"turn/interrupt\"", "\"thread/queue", "\"thread/resume\"", "\"thread/fork\"",
    "new WebSocket", "from \"ws\"", "node:net", "requestApproval", "elicitation/",
  ]) {
    assert.ok(!source.includes(forbidden), `delivery primitive must not contain ${forbidden}`);
  }
  const quotedMethods = [...source.matchAll(/"([a-z]+\/[A-Za-z/]+)"/g)].map((match) => match[1]);
  assert.deepEqual([...new Set(quotedMethods)], ["turn/steer"]);
});
