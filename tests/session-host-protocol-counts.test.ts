/**
 * Focused tests for the optional owned-work counts on the status protocol
 * (src/session-host/protocol.ts).
 *
 * Only the shared contract is exercised: a malformed or absent count must
 * degrade to UNKNOWN and must never make an otherwise valid frame look like
 * "nothing running".
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { randomUUID } from "node:crypto";

import {
  ACTIVITY_CENSUS_CAPABILITY,
  decodeFrame,
  encodeFrame,
  parseActivityRequest,
  parseActivityResult,
  parseHello,
  parseStatus,
  type SessionHostActivityResult,
  type SessionHostStatus,
} from "../src/session-host/protocol";

function baseStatus(): Record<string, unknown> {
  return {
    version: 1,
    type: "status",
    instanceId: randomUUID(),
    generation: randomUUID(),
    sequence: 3,
    busy: true,
    pendingInput: null,
    inputSurface: false,
    activity: ["Working"],
  };
}

describe("session-host status owned-work counts", () => {
  it("accepts bounded nonnegative safe integers and normalizes -0", () => {
    const parsed = parseStatus({ ...baseStatus(), backgroundTasks: 2, backgroundShells: 0 });
    assert.ok(parsed);
    assert.equal(parsed.backgroundTasks, 2);
    assert.equal(parsed.backgroundShells, 0);

    const negativeZero = parseStatus({ ...baseStatus(), backgroundTasks: -0, backgroundShells: 5 });
    assert.ok(negativeZero);
    assert.equal(Object.is(negativeZero.backgroundTasks, 0), true, "-0 is normalized to +0");
    assert.equal(negativeZero.backgroundShells, 5);
  });

  it("omits counts for an older reporter and decodes absence as unknown", () => {
    const parsed = parseStatus(baseStatus());
    assert.ok(parsed);
    assert.equal(Object.hasOwn(parsed, "backgroundTasks"), false, "absence stays absent on the wire");
    assert.equal(Object.hasOwn(parsed, "backgroundShells"), false);
    // Consumers normalize absence to null: never a fabricated zero.
    assert.equal(parsed.backgroundTasks ?? null, null);
    assert.equal(parsed.backgroundShells ?? null, null);

    const frame = encodeFrame({ ...baseStatus(), sequence: 4 } as SessionHostStatus);
    const decoded = decodeFrame(frame);
    assert.ok(decoded && decoded.type === "status");
    assert.equal(Object.hasOwn(decoded, "backgroundTasks"), false);
  });

  it("degrades every invalid count to null without rejecting the frame", () => {
    const invalid = [
      null,
      -1,
      1.5,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.MAX_SAFE_INTEGER + 1,
      "3",
      true,
      {},
    ] as const;
    for (const value of invalid) {
      const parsed = parseStatus({ ...baseStatus(), backgroundTasks: value, backgroundShells: value });
      assert.ok(parsed, `frame with count ${String(value)} stays valid`);
      assert.equal(parsed.backgroundTasks, null, `backgroundTasks for ${String(value)} is unknown`);
      assert.equal(parsed.backgroundShells, null, `backgroundShells for ${String(value)} is unknown`);
    }
  });

  it("round-trips explicit counts through encode/decode and drops unknown fields", () => {
    const message: SessionHostStatus = {
      ...(baseStatus() as unknown as SessionHostStatus),
      backgroundTasks: 1,
      backgroundShells: 3,
    };
    const decoded = decodeFrame(encodeFrame(message));
    assert.ok(decoded && decoded.type === "status");
    assert.equal(decoded.backgroundTasks, 1);
    assert.equal(decoded.backgroundShells, 3);

    const withExtra = decodeFrame(`${JSON.stringify({ ...message, transcript: "never exposed" })}\n`);
    assert.ok(withExtra && withExtra.type === "status");
    assert.equal(Object.hasOwn(withExtra, "transcript"), false);
  });
});

describe("session-host authoritative activity census contract", () => {
  function baseRequest(): Record<string, unknown> {
    return {
      version: 1,
      type: "activity_request",
      instanceId: randomUUID(),
      generation: randomUUID(),
      token: "a".repeat(64),
      requestId: randomUUID(),
      afterSequence: 7,
      expectedSessionId: "native-session",
      expectedSessionEpoch: 2,
    };
  }

  it("round-trips an authenticated bounded request and accepts a null native tuple", () => {
    const parsed = parseActivityRequest(baseRequest());
    assert.ok(parsed);
    const decoded = decodeFrame(encodeFrame(parsed));
    assert.ok(decoded && decoded.type === "activity_request");
    assert.equal(decoded.afterSequence, 7);
    assert.equal(decoded.expectedSessionId, "native-session");
    assert.equal(decoded.expectedSessionEpoch, 2);

    const unknownTuple = parseActivityRequest({
      ...baseRequest(),
      expectedSessionId: null,
      expectedSessionEpoch: null,
    });
    assert.ok(unknownTuple);
    assert.equal(unknownTuple.expectedSessionId, null);
    assert.equal(unknownTuple.expectedSessionEpoch, null);
  });

  it("rejects malformed identity, sequence, and partial native tuples", () => {
    for (const override of [
      { token: "short" },
      { requestId: "bad id!" },
      { afterSequence: -1 },
      { afterSequence: 1.5 },
      { expectedSessionId: "native-session", expectedSessionEpoch: null },
      { expectedSessionId: null, expectedSessionEpoch: 2 },
      { expectedSessionId: "bad/id", expectedSessionEpoch: 2 },
    ]) {
      assert.equal(parseActivityRequest({ ...baseRequest(), ...override }), undefined, JSON.stringify(override));
    }
  });

  it("accepts only a complete result with a matching fresh status snapshot", () => {
    const request = parseActivityRequest(baseRequest())!;
    const snapshot = parseStatus({
      ...baseStatus(),
      instanceId: request.instanceId,
      generation: request.generation,
      sequence: 8,
      nativeSession: { sessionId: "native-session", epoch: 2, name: "Activity" },
      activeTasks: 0,
      activeShells: 0,
    })!;
    const result: SessionHostActivityResult = {
      version: 1,
      type: "activity_result",
      instanceId: request.instanceId,
      generation: request.generation,
      requestId: request.requestId,
      outcome: "complete",
      status: snapshot,
      observedSessionId: "native-session",
      observedSessionEpoch: 2,
    };
    const parsed = parseActivityResult(result);
    assert.ok(parsed);
    assert.equal(parsed.outcome, "complete");
    assert.equal(parsed.status?.activeTasks, 0);
    const decoded = decodeFrame(encodeFrame(parsed));
    assert.ok(decoded && decoded.type === "activity_result");
    assert.equal(decoded.status?.sequence, 8);

    // A contradictory observed tuple, mismatched identity, and a non-complete
    // result carrying a snapshot are all rejected.
    assert.equal(parseActivityResult({ ...result, observedSessionId: "other-session" }), undefined);
    assert.equal(parseActivityResult({ ...result, instanceId: randomUUID() }), undefined);
    assert.equal(parseActivityResult({
      version: 1,
      type: "activity_result",
      instanceId: request.instanceId,
      generation: request.generation,
      requestId: request.requestId,
      outcome: "unavailable",
      status: snapshot,
      observedSessionId: "native-session",
      observedSessionEpoch: 2,
    }), undefined);
  });

  it("advertises the additive capability without changing legacy hello acceptance", () => {
    const legacy = {
      version: 1,
      type: "hello",
      instanceId: randomUUID(),
      generation: randomUUID(),
      token: "b".repeat(64),
    };
    const parsedLegacy = parseHello(legacy);
    assert.ok(parsedLegacy);
    assert.equal(Object.hasOwn(parsedLegacy, "capabilities"), false);
    const parsed = parseHello({ ...legacy, capabilities: [ACTIVITY_CENSUS_CAPABILITY] });
    assert.ok(parsed);
    assert.deepEqual(parsed.capabilities, [ACTIVITY_CENSUS_CAPABILITY]);
    assert.equal(parseHello({ ...legacy, capabilities: ["Bad Cap"] }), undefined);
    assert.equal(parseHello({ ...legacy, capabilities: [1] }), undefined);
  });
});
