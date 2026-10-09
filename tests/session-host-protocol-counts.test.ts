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
  decodeFrame,
  encodeFrame,
  parseStatus,
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
