import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { describe, it } from "node:test";

import {
  MAX_SESSION_HOST_PAYLOAD_DIR_BYTES,
  MAX_SESSION_SPAWN_HOST_BYTES,
  MAX_SESSION_SPAWN_TITLE_BYTES,
  MAX_SESSION_SPAWN_WORKSPACE_BYTES,
  decodeFrame,
  encodeFrame,
  parseBootstrap,
  parseSessionHostPayloadRef,
  parseSpawnAck,
  parseSpawnRequest,
  hasSessionSpawnRouting,
  isValidSessionSpawnHost,
  SESSION_SPAWN_ROUTING_MODE,
  type SessionHostSpawnRequest,
} from "../src/session-host/protocol";

function payload(size = 47): SessionHostSpawnRequest["payload"] {
  return {
    name: `p-${"a".repeat(32)}.json`,
    size,
    sha256: "b".repeat(64),
  };
}

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
    payload: payload(),
    ...overrides,
  };
}

describe("session-host SessionSpawn wire protocol", () => {
  it("carries exact workspace/title plus only a bounded private payload reference", () => {
    const longTitle = "A title longer than the sidebar's display recommendation ".repeat(6);
    // The public prompt has no fixed length ceiling; the frame only names its
    // private staged file, so even an enormous exact payload size is admitted.
    const input = request({ title: longTitle, payload: payload(2_147_483_647) });

    assert.deepEqual(parseSpawnRequest(input), input);
    assert.deepEqual(decodeFrame(encodeFrame(input)), input);
    assert.equal(Object.hasOwn(input, "prompt"), false, "prompt text never travels in the wire request");

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
    assert.equal(Object.hasOwn(decodedAck!, "token"), false);
  });

  it("rejects malformed credentials, empty fields, NUL injection, field overflow, and malformed payload references", () => {
    const valid = request();
    assert.equal(parseSpawnRequest({ ...valid, token: "wrong" }), undefined);
    assert.equal(parseSpawnRequest({ ...valid, workspace: "" }), undefined);
    assert.equal(parseSpawnRequest({ ...valid, workspace: "/tmp/\0workspace" }), undefined);
    assert.equal(parseSpawnRequest({ ...valid, workspace: "x".repeat(MAX_SESSION_SPAWN_WORKSPACE_BYTES + 1) }), undefined);
    assert.equal(parseSpawnRequest({ ...valid, title: "  " }), undefined);
    assert.equal(parseSpawnRequest({ ...valid, title: "x".repeat(MAX_SESSION_SPAWN_TITLE_BYTES + 1) }), undefined);
    assert.equal(Object.hasOwn(parseSpawnRequest({ ...valid, prompt: "legacy inline prompt" })!, "prompt"), false,
      "an unknown legacy prompt field is never adopted as transport data");
    assert.equal(parseSpawnRequest({ ...valid, payload: undefined }), undefined);
    assert.equal(parseSpawnRequest({ ...valid, payload: { ...payload(), name: "../escape" } }), undefined);
    assert.equal(parseSpawnRequest({ ...valid, payload: { ...payload(), name: "not-a-payload" } }), undefined);
    assert.equal(parseSpawnRequest({ ...valid, payload: { ...payload(), size: 0 } }), undefined);
    assert.equal(parseSpawnRequest({ ...valid, payload: { ...payload(), size: 1.5 } }), undefined);
    assert.equal(parseSpawnRequest({ ...valid, payload: { ...payload(), sha256: "short" } }), undefined);
    assert.equal(parseSpawnAck({ ...valid, type: "spawn_result", outcome: "attached" }), undefined);
  });

  it("admits a bootstrap payload namespace only when it is a canonical absolute bounded path", () => {
    const base = {
      version: 1 as const,
      socketPath: `\\\\.\\pipe\\prg-st-${"a".repeat(32)}`,
      token: "a".repeat(64),
      instanceId: randomUUID(),
      generation: randomUUID(),
    };
    assert.ok(parseBootstrap({ ...base, payloadDir: "/tmp/prg-pl-payload" }));
    assert.equal(parseBootstrap({ ...base, payloadDir: "relative/payload" }), undefined);
    assert.equal(parseBootstrap({ ...base, payloadDir: "" }), undefined);
    assert.equal(parseBootstrap({ ...base, payloadDir: "/tmp/\0payload" }), undefined);
    assert.equal(parseBootstrap({ ...base, payloadDir: `/${"x".repeat(MAX_SESSION_HOST_PAYLOAD_DIR_BYTES)}` }), undefined);
    assert.ok(parseBootstrap(base), "absence is admitted for status-only legacy bootstraps");
  });

  it("carries exact routing selectors only in the distinct routed request family", () => {
    const host = "Büro laptop (2) — 日本";
    const routed = request({ type: "spawn_routed_request", host, kind: "claude" });
    assert.deepEqual(parseSpawnRequest(routed), routed);
    assert.deepEqual(decodeFrame(encodeFrame(routed)), routed, "selectors round-trip byte-exact through the wire");
    for (const selectors of [{ host }, { kind: "pi" as const }, { kind: "codex" as const }]) {
      const only = request({ type: "spawn_routed_request", ...selectors });
      assert.deepEqual(parseSpawnRequest(only), only, "either selector alone is a routed request; kind pi is kept explicit");
      assert.equal(hasSessionSpawnRouting(only), true);
    }
    const legacy = request();
    assert.equal(hasSessionSpawnRouting(legacy), false);
    assert.equal(Object.hasOwn(parseSpawnRequest(legacy)!, "host"), false, "the legacy frame gains no default selector");
    assert.equal(Object.hasOwn(parseSpawnRequest(legacy)!, "kind"), false, "the legacy frame gains no default selector");

    // The frame family is fixed by the selectors; a mismatch is never repaired.
    assert.equal(parseSpawnRequest({ ...legacy, kind: "pi" }), undefined,
      "a legacy frame can never smuggle a selector an older broker would drop");
    assert.equal(parseSpawnRequest({ ...legacy, host }), undefined);
    assert.equal(parseSpawnRequest({ ...legacy, type: "spawn_routed_request" }), undefined,
      "a routed frame must carry at least one selector");
    assert.equal(parseSpawnRequest({ ...legacy, type: "spawn_routed_request", host: undefined }), undefined,
      "a present-but-undefined selector key is malformed, not absent");
    assert.equal(decodeFrame(`${JSON.stringify({ ...legacy, host })}\n`), undefined);
  });

  it("rejects unknown backends and unsafe or over-bound host selectors without rewriting padded saved ids", () => {
    const valid = request({ type: "spawn_routed_request", host: "laptop" });
    for (const kind of ["Pi", "PI", "gemini", "", " pi", 1, null, true]) {
      assert.equal(parseSpawnRequest({ ...valid, kind }), undefined, `kind ${JSON.stringify(kind)} is refused`);
    }
    // The selector is the saved paired-destination id contract: at most 128
    // UTF-16 code units, matched raw, padding included; bytes derive from it.
    for (const atBound of ["h".repeat(128), "日".repeat(128), " ", " laptop", "laptop "]) {
      assert.ok(Buffer.byteLength(atBound, "utf8") <= MAX_SESSION_SPAWN_HOST_BYTES);
      assert.equal(isValidSessionSpawnHost(atBound), true);
      assert.equal(parseSpawnRequest({ ...valid, host: atBound })?.host, atBound);
    }
    for (const host of [
      "", "lap\ntop", "lap\ttop", "lap\u0000top", "lap\u0085top", "lap\u2028top",
      "h".repeat(129),
      "é".repeat(129),
      42, null,
    ]) {
      assert.equal(isValidSessionSpawnHost(host), false, `host ${JSON.stringify(host)} is refused`);
      assert.equal(parseSpawnRequest({ ...valid, host }), undefined, `host ${JSON.stringify(host)} is refused on the wire`);
    }
  });

  it("admits the routed-spawn bootstrap marker only as the closed mode version", () => {
    const base = {
      version: 1 as const,
      socketPath: `\\\\.\\pipe\\prg-st-${"a".repeat(32)}`,
      token: "a".repeat(64),
      instanceId: randomUUID(),
      generation: randomUUID(),
      payloadDir: "/tmp/prg-pl-payload",
    };
    assert.equal(parseBootstrap(base)?.spawnRouting, undefined, "absence is the legacy own-host Pi bootstrap");
    assert.equal(parseBootstrap({ ...base, spawnRouting: SESSION_SPAWN_ROUTING_MODE })?.spawnRouting, 1);
    for (const spawnRouting of [0, 2, true, "1", null]) {
      assert.equal(parseBootstrap({ ...base, spawnRouting }), undefined,
        `marker ${JSON.stringify(spawnRouting)} rejects the whole bootstrap rather than degrading`);
    }
  });

  it("validates strict single-segment payload names and digests without reading a file", () => {
    const name = `p-${"c".repeat(32)}.json`;
    assert.equal(parseSessionHostPayloadRef({ name, size: 1, sha256: "d".repeat(64) })?.name, name);
    for (const invalid of [
      { name: `${name}/x`, size: 1, sha256: "d".repeat(64) },
      { name: `/tmp/${name}`, size: 1, sha256: "d".repeat(64) },
      { name: `p-${"C".repeat(32)}.json`, size: 1, sha256: "d".repeat(64) },
      { name: `p-${"c".repeat(31)}.json`, size: 1, sha256: "d".repeat(64) },
      { name: `${name}.extra`, size: 1, sha256: "d".repeat(64) },
      { name, size: Number.MAX_SAFE_INTEGER + 1, sha256: "d".repeat(64) },
      { name, size: 1, sha256: "d".repeat(63) },
      { name, size: 1, sha256: "E".repeat(64) },
    ]) {
      assert.equal(parseSessionHostPayloadRef(invalid), undefined);
    }
  });
});
