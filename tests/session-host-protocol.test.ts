/**
 * Focused tests for the closed optional input-framing mode on the shared
 * bootstrap contract (src/session-host/protocol.ts).
 *
 * Only the shared contract is exercised: the marker is optional, its admitted
 * value is exactly the closed mode, a malformed or unknown value refuses the
 * whole bootstrap instead of guessing, and its presence changes nothing about
 * how any other bootstrap field validates.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { randomUUID } from "node:crypto";

import {
  INPUT_ORIGIN_FRAMING_MODE,
  parseBootstrap,
} from "../src/session-host/protocol";

function baseBootstrap(): Record<string, unknown> {
  return {
    version: 1,
    socketPath: "/tmp/prg-protocol-bootstrap.sock",
    token: "ab".repeat(32),
    instanceId: "11111111-1111-4111-8111-111111111111",
    generation: randomUUID(),
  };
}

describe("the closed input-framing bootstrap mode", () => {
  it("leaves a legacy bootstrap exactly as it was", () => {
    const parsed = parseBootstrap(baseBootstrap());
    assert.ok(parsed, "the legacy bootstrap still parses");
    assert.equal(Object.hasOwn(parsed, "inputOriginFraming"), false,
      "absence is the legacy mode and is never invented by the parser");
    assert.equal(JSON.parse(JSON.stringify(parsed)).inputOriginFraming, undefined,
      "a legacy bootstrap round-trips without acquiring the marker");
  });

  it("admits exactly the closed mode value and round-trips it", () => {
    assert.equal(INPUT_ORIGIN_FRAMING_MODE, 1);
    const parsed = parseBootstrap({ ...baseBootstrap(), inputOriginFraming: INPUT_ORIGIN_FRAMING_MODE });
    assert.ok(parsed, "the mode-carrying bootstrap parses");
    assert.equal(parsed.inputOriginFraming, INPUT_ORIGIN_FRAMING_MODE);
    const revived = parseBootstrap(JSON.parse(JSON.stringify(parsed)));
    assert.deepEqual(revived, parsed, "the marker survives the one-shot JSON env transport");
  });

  it("refuses the whole bootstrap for every other mode shape", () => {
    for (const mode of [0, 2, -1, 1.5, Number.NaN, "1", "", true, false, null, {}, [], [1], { value: 1 }]) {
      assert.equal(parseBootstrap({ ...baseBootstrap(), inputOriginFraming: mode }), undefined,
        `a known-mode field with the value ${JSON.stringify(mode)} refuses the bootstrap rather than guessing`);
    }
  });

  it("changes nothing else about bootstrap validation", () => {
    // ONE base bootstrap, parsed twice: the two results must differ only by the
    // mode marker, which requires the same generation/token on both sides.
    const base = baseBootstrap();
    const legacy = parseBootstrap(base);
    const framed = parseBootstrap({ ...base, inputOriginFraming: INPUT_ORIGIN_FRAMING_MODE });
    assert.ok(legacy && framed);
    assert.deepEqual({ ...legacy, inputOriginFraming: undefined }, { ...framed, inputOriginFraming: undefined },
      "the mode is the only difference between the two bootstraps");

    // A differently spelled or unrelated marker never fabricates the mode, and a
    // bootstrap that is invalid for any other reason stays invalid with the mode.
    assert.equal(Object.hasOwn(parseBootstrap({ ...baseBootstrap(), inputOriginFramingMode: 1 })!, "inputOriginFraming"), false);
    for (const broken of [
      { version: 2 },
      { socketPath: "relative.sock" },
      { token: "not-a-token" },
      { instanceId: "" },
      { payloadDir: "relative/namespace" },
    ]) {
      assert.equal(parseBootstrap({ ...baseBootstrap(), ...broken, inputOriginFraming: INPUT_ORIGIN_FRAMING_MODE }), undefined,
        `an otherwise invalid bootstrap (${Object.keys(broken)[0]}) stays refused with the mode present`);
    }
  });
});
