import assert from "node:assert/strict";
import test from "node:test";
import { hasCompleteSessionIdle, parseShutdownAck, parseShutdownRequest } from "../src/session-host/protocol";

const clear = { busy: false, pendingInput: false, inputSurface: false, backgroundTasks: 0, backgroundShells: 0 };
const request = { version: 1, type: "shutdown_request", instanceId: "a1", generation: "b2", token: "a".repeat(64), requestId: "c3", expectedSessionId: "current", expectedSessionEpoch: 1 };

test("pure complete inactivity requires positive clearance of turn, question/modal and both owned-work sources", () => {
  assert.equal(hasCompleteSessionIdle(clear), true);
  for (const state of [
    { ...clear, busy: true }, { ...clear, busy: null },
    { ...clear, pendingInput: true }, { ...clear, pendingInput: null },
    { ...clear, inputSurface: true },
    { ...clear, backgroundTasks: 1 }, { ...clear, backgroundTasks: null }, { ...clear, backgroundTasks: undefined },
    { ...clear, backgroundShells: 1 }, { ...clear, backgroundShells: null }, { ...clear, backgroundShells: undefined },
    { ...clear, backgroundTasks: -1 }, { ...clear, backgroundShells: Number.NaN },
  ]) assert.equal(hasCompleteSessionIdle(state), false);
});

test("pure idle-only shutdown wire guard preserves deliberate true and rejects malformed values", () => {
  assert.equal(parseShutdownRequest({ ...request, requireIdle: true })?.requireIdle, true);
  assert.equal(parseShutdownRequest({ ...request, requireIdle: false })?.requireIdle, false);
  assert.equal(parseShutdownRequest(request)?.requireIdle, undefined);
  for (const requireIdle of [0, 1, "true", null, {}]) assert.equal(parseShutdownRequest({ ...request, requireIdle }), undefined);
});

test("pure not-idle rejection is distinct from a requested shutdown and never constitutes process exit", () => {
  const ack = { ...request, type: "shutdown_result", outcome: "rejected", reason: "not-idle" };
  assert.equal(parseShutdownAck(ack)?.reason, "not-idle");
  assert.equal(parseShutdownAck({ ...ack, outcome: "requested" }), undefined);
});
