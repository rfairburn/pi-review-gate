import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { describe, it } from "node:test";

import {
  MAX_SESSION_SPAWN_PROMPT_BYTES,
  MAX_SESSION_SPAWN_TITLE_BYTES,
  MAX_SESSION_SPAWN_WORKSPACE_BYTES,
  decodeFrame,
  encodeFrame,
  parseSpawnAck,
  parseSpawnRequest,
  type SessionHostSpawnRequest,
} from "../src/session-host/protocol";

function request(overrides: Partial<SessionHostSpawnRequest> = {}): SessionHostSpawnRequest {
  return {
    version: 1,
    type: "spawn_request",
    instanceId: randomUUID(),
    generation: randomUUID(),
    token: "a".repeat(64),
    requestId: randomUUID(),
    workspace: "/tmp/explicit workspace",
    title: "New hosted session",
    prompt: "Start with the supplied request.",
    ...overrides,
  };
}

describe("session-host SessionSpawn wire protocol", () => {
  it("preserves exact bounded workspace, long title, and flag-looking multiline prompt", () => {
    const longTitle = "A title longer than the sidebar's display recommendation ".repeat(6);
    const prompt = "--session is user content, not a session-selection option\nKeep this exact.\n";
    const input = request({ title: longTitle, prompt });

    assert.deepEqual(parseSpawnRequest(input), input);
    assert.deepEqual(decodeFrame(encodeFrame(input)), input);

    const ack = {
      version: 1 as const,
      type: "spawn_result" as const,
      instanceId: input.instanceId,
      generation: input.generation,
      requestId: input.requestId,
      outcome: "started" as const,
    };
    assert.deepEqual(parseSpawnAck(ack), ack);
    const decodedAck = decodeFrame(encodeFrame(ack));
    assert.deepEqual(decodedAck, ack);
    assert.equal(JSON.stringify(decodedAck).includes(prompt), false);
    assert.equal(Object.hasOwn(decodedAck!, "token"), false);
  });

  it("rejects malformed credentials, empty fields, NUL injection, and field overflow", () => {
    const valid = request();
    assert.equal(parseSpawnRequest({ ...valid, token: "wrong" }), undefined);
    assert.equal(parseSpawnRequest({ ...valid, workspace: "" }), undefined);
    assert.equal(parseSpawnRequest({ ...valid, workspace: "/tmp/\0workspace" }), undefined);
    assert.equal(parseSpawnRequest({ ...valid, workspace: "x".repeat(MAX_SESSION_SPAWN_WORKSPACE_BYTES + 1) }), undefined);
    assert.equal(parseSpawnRequest({ ...valid, title: "  " }), undefined);
    assert.equal(parseSpawnRequest({ ...valid, title: "x".repeat(MAX_SESSION_SPAWN_TITLE_BYTES + 1) }), undefined);
    assert.equal(parseSpawnRequest({ ...valid, prompt: "" }), undefined);
    assert.equal(parseSpawnRequest({ ...valid, prompt: "x\0y" }), undefined);
    assert.equal(parseSpawnRequest({ ...valid, prompt: "x".repeat(MAX_SESSION_SPAWN_PROMPT_BYTES + 1) }), undefined);
    assert.equal(parseSpawnAck({ ...valid, type: "spawn_result", outcome: "attached" }), undefined);
  });

  it("keeps the shared frame byte limit authoritative after JSON escaping", () => {
    const escapeHeavy = request({ prompt: "\u0001".repeat(MAX_SESSION_SPAWN_PROMPT_BYTES) });
    assert.equal(parseSpawnRequest(escapeHeavy), undefined, "the canonical request must fit the shared byte bound after escaping");
    assert.throws(() => encodeFrame(escapeHeavy), RangeError, "the encoder remains authoritative for direct callers");
  });
});
