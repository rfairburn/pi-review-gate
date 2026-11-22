/**
 * Focused contract/codec tests for the optional Review-settings exchange
 * (issue #716 transport slice).
 *
 * These tests are pure: no socket, channel, timer, process, or configuration is
 * touched. They pin the closed envelope rules — bounded UTF-8 JSON, exact
 * fragment counts and SHA-256, canonical base64, explicit caps, and the
 * capability/negotiation surface — rather than any settings field meaning.
 */

import assert from "node:assert/strict";
import test from "node:test";
import {
  REVIEW_SETTINGS_EMPTY_SHA256,
  REVIEW_SETTINGS_FRAGMENT_BYTES,
  REVIEW_SETTINGS_MAX_BYTES,
  REVIEW_SETTINGS_MAX_CHUNKS,
  REVIEW_SETTINGS_MAX_RECEIPT_TASK_ID,
  REVIEW_SETTINGS_MAX_RECEIPT_TASK_IDS,
  REVIEW_SETTINGS_MAX_RECEIPT_TASKS,
  ReviewSettingsPayloadAssembler,
  buildReviewSettingsSaveReceipt,
  copyReviewSettingsPayload,
  encodeReviewSettingsEnvelope,
  isOwnerReviewSettingsFacts,
  isReviewSettingsJsonPayload,
  isReviewSettingsOutcome,
  isReviewSettingsSaveReceipt,
  reviewSettingsChunkSize,
  reviewSettingsPayloadLimit,
  reviewSettingsSha256,
  type OwnerReviewSettingsFacts,
} from "../src/session-host/network/peer-review-settings";
import {
  ROSTER_BRIDGE_KNOWN_OPTIONAL_CAPABILITIES,
  ROSTER_BRIDGE_MAJOR,
  ROSTER_BRIDGE_MINOR,
  ROSTER_BRIDGE_REQUIRED_CAPABILITY,
  ROSTER_BRIDGE_REVIEW_SETTINGS_CAPABILITY,
  ROSTER_BRIDGE_SERVICE,
  decodeRosterBridgeFrame,
  encodeRosterBridgeFrame,
  negotiateRosterBridgeHello,
  reviewRosterBridgeHelloAck,
  type RosterBridgeFrame,
  type RosterBridgeHelloAckFrame,
  type RosterBridgeHelloFrame,
} from "../src/session-host/network/roster-bridge-protocol";

const payload = (value: unknown): Uint8Array => new TextEncoder().encode(JSON.stringify(value));

test("Review-settings capability is optional, known, and never enabled by version", () => {
  assert.ok(ROSTER_BRIDGE_KNOWN_OPTIONAL_CAPABILITIES.includes(ROSTER_BRIDGE_REVIEW_SETTINGS_CAPABILITY));
  const hello: RosterBridgeHelloFrame = {
    type: "hello",
    service: ROSTER_BRIDGE_SERVICE,
    major: ROSTER_BRIDGE_MAJOR,
    minor: ROSTER_BRIDGE_MINOR,
    capabilities: [ROSTER_BRIDGE_REQUIRED_CAPABILITY, ROSTER_BRIDGE_REVIEW_SETTINGS_CAPABILITY, "future-review-settings"],
  };
  const decision = negotiateRosterBridgeHello(hello);
  assert.equal(decision.ok, true);
  assert.deepEqual(decision.ok ? decision.capabilities : null, [ROSTER_BRIDGE_REVIEW_SETTINGS_CAPABILITY],
    "unknown optional identifiers are ignored and the baseline is not repeated");
  const ack: RosterBridgeHelloAckFrame = {
    type: "hello_ack",
    service: ROSTER_BRIDGE_SERVICE,
    major: ROSTER_BRIDGE_MAJOR,
    minor: ROSTER_BRIDGE_MINOR,
    capabilities: [ROSTER_BRIDGE_REQUIRED_CAPABILITY, ROSTER_BRIDGE_REVIEW_SETTINGS_CAPABILITY],
  };
  assert.equal(reviewRosterBridgeHelloAck(ack, {
    capabilities: [ROSTER_BRIDGE_REQUIRED_CAPABILITY, ROSTER_BRIDGE_REVIEW_SETTINGS_CAPABILITY],
  }).ok, true);
  assert.equal(reviewRosterBridgeHelloAck(ack, { capabilities: [] }).ok, false,
    "an unoffered acknowledgement is a protocol violation");
});

test("every Review-settings frame round-trips through the closed codec", () => {
  const frames: RosterBridgeFrame[] = [
    {
      type: "review_settings_begin", requestId: "req-1", hostRunId: "run-1",
      operation: "load", sequence: 1, bytes: 0, sha256: REVIEW_SETTINGS_EMPTY_SHA256,
    },
    {
      type: "review_settings_begin", requestId: "req-2", hostRunId: "run-1",
      operation: "save", sequence: 2, bytes: 2, sha256: reviewSettingsSha256(payload({})),
    },
    { type: "review_settings_chunk", requestId: "req-2", index: 0, data: Buffer.from("{}").toString("base64") },
    { type: "review_settings_end", requestId: "req-2", chunks: 1 },
    { type: "review_settings_result", requestId: "req-2", outcome: { kind: "accepted" } },
    {
      type: "review_settings_result",
      requestId: "req-2",
      outcome: { kind: "accepted", receipt: { disabledTaskIds: ["task-1a2b3c4d"], additionalDisabledCount: 2 } },
    },
    { type: "review_settings_result", requestId: "req-2", outcome: { kind: "refused", reason: "policy" } },
    { type: "review_settings_result", requestId: "req-2", outcome: { kind: "unknown" } },
    {
      type: "review_settings_payload_begin", requestId: "req-1", hostRunId: "run-1",
      bytes: 2, sha256: reviewSettingsSha256(payload({})),
    },
    { type: "review_settings_payload_chunk", requestId: "req-1", index: 0, data: Buffer.from("{}").toString("base64") },
    { type: "review_settings_payload_end", requestId: "req-1", chunks: 1 },
    { type: "review_settings_policy", hostRunId: "run-1", enabled: true },
  ];
  for (const frame of frames) {
    const decoded = decodeRosterBridgeFrame(encodeRosterBridgeFrame(frame));
    assert.deepEqual(decoded, frame, `${frame.type} must round-trip exactly`);
  }
});

test("announcement constraints distinguish load from save and refuse malformed shapes", () => {
  const emptyHash = REVIEW_SETTINGS_EMPTY_SHA256;
  const base = {
    type: "review_settings_begin" as const,
    requestId: "req",
    hostRunId: "run",
    sequence: 1,
    bytes: 0,
    sha256: emptyHash,
  };
  assert.doesNotThrow(() => encodeRosterBridgeFrame({ ...base, operation: "load" }));
  for (const change of [
    { operation: "load", bytes: 1 },
    { operation: "load", sha256: reviewSettingsSha256(payload({})) },
    { operation: "save", bytes: 0 },
    { operation: "save", bytes: 1, sha256: "A".repeat(64) },
    { operation: "save", bytes: REVIEW_SETTINGS_MAX_BYTES + 1, sha256: emptyHash },
    { operation: "other" },
  ]) {
    assert.throws(() => encodeRosterBridgeFrame({ ...base, ...change } as RosterBridgeFrame),
      `${JSON.stringify(change)} must be refused`);
  }
});

test("fragments are non-empty canonical base64 within 16 KiB and the finite index cap", () => {
  const chunk = (data: string, index = 0): RosterBridgeFrame => ({
    type: "review_settings_chunk", requestId: "req", index, data,
  });
  const legal = Buffer.alloc(REVIEW_SETTINGS_FRAGMENT_BYTES, 0x61).toString("base64");
  assert.doesNotThrow(() => decodeRosterBridgeFrame(encodeRosterBridgeFrame(chunk(legal))));
  for (const data of ["", "!!!!", "YQ", `${Buffer.from("a").toString("base64")}\n`]) {
    assert.throws(() => encodeRosterBridgeFrame(chunk(data)), `${JSON.stringify(data)} must be refused`);
  }
  const tooLarge = Buffer.alloc(REVIEW_SETTINGS_FRAGMENT_BYTES + 1, 0x61).toString("base64");
  assert.throws(() => encodeRosterBridgeFrame(chunk(tooLarge)));
  assert.throws(() => encodeRosterBridgeFrame(chunk("YQ==", REVIEW_SETTINGS_MAX_CHUNKS)));
  assert.throws(() => encodeRosterBridgeFrame({
    type: "review_settings_result", requestId: "req",
    outcome: { kind: "refused", reason: "not-a-reason" },
  } as unknown as RosterBridgeFrame));
  assert.throws(() => encodeRosterBridgeFrame({
    type: "review_settings_result", requestId: "req",
    outcome: { kind: "accepted", extra: true },
  } as unknown as RosterBridgeFrame), "unknown outcome keys are refused");
});

test("the envelope is valid bounded JSON and a private copy", () => {
  assert.equal(isReviewSettingsJsonPayload(payload({ a: 1 })), true);
  assert.equal(isReviewSettingsJsonPayload(Buffer.from("{}")), true);
  for (const value of [new Uint8Array(), new Uint8Array([0xff]), Buffer.from("not json"), "{}", null]) {
    assert.equal(isReviewSettingsJsonPayload(value), false);
  }
  const source = payload({ nested: "宇宙" });
  const copy = copyReviewSettingsPayload(source);
  assert.ok(copy);
  assert.notEqual(copy, source);
  const before = reviewSettingsSha256(copy);
  source[0] = 0x7b ^ 0xff;
  assert.equal(new TextDecoder().decode(copy).startsWith('{"nested"'), true);
  assert.equal(reviewSettingsSha256(copy), before, "the private copy never aliases caller bytes");
  assert.notEqual(reviewSettingsSha256(copy), reviewSettingsSha256(source));
});

test("chunk sizing and explicit payload limits follow the negotiated frame bound", () => {
  assert.equal(reviewSettingsChunkSize(65_536), REVIEW_SETTINGS_FRAGMENT_BYTES);
  assert.equal(reviewSettingsChunkSize(2_048), 1_152);
  assert.equal(reviewSettingsChunkSize(512), 0);
  assert.equal(reviewSettingsPayloadLimit(65_536), REVIEW_SETTINGS_MAX_BYTES);
  assert.ok(reviewSettingsPayloadLimit(1_024) > 0);
  assert.ok(reviewSettingsPayloadLimit(1_024) <= REVIEW_SETTINGS_MAX_BYTES);
  const envelope = encodeReviewSettingsEnvelope(payload({ catalog: "x".repeat(60 * 1024) }), 65_536);
  assert.ok(envelope);
  assert.ok(envelope.chunks.length > 1, "a payload above one chunk is fragmented, never clipped");
  assert.equal(Buffer.concat(envelope.chunks).toString("utf8"), new TextDecoder().decode(
    payload({ catalog: "x".repeat(60 * 1024) }),
  ));
  assert.equal(envelope.sha256, reviewSettingsSha256(Buffer.concat(envelope.chunks)));
  assert.equal(encodeReviewSettingsEnvelope(new Uint8Array(), 65_536), null);
  assert.equal(encodeReviewSettingsEnvelope(payload({}), 512), null,
    "a frame bound that cannot carry any fragment yields no transfer");
});

test("an over-limit envelope is refused before it is copied or fragmented", () => {
  const tinyFrame = 514;
  const limit = reviewSettingsPayloadLimit(tinyFrame);
  assert.ok(limit > 0 && limit < REVIEW_SETTINGS_MAX_BYTES);
  // This is valid JSON exactly one byte above the effective limit. A one-byte
  // fragment size must not turn it into a giant allocation before refusal.
  const over = payload({ x: "a".repeat(limit - 7) });
  assert.equal(over.length, limit + 1);
  assert.equal(encodeReviewSettingsEnvelope(over, tinyFrame), null);
  // The limit itself remains representable: exactly `limit` one-byte chunks.
  const exact = payload({ x: "a".repeat(limit - 8) });
  assert.equal(exact.length, limit);
  const envelope = encodeReviewSettingsEnvelope(exact, tinyFrame);
  assert.ok(envelope);
  assert.equal(envelope.chunks.length, limit);
  assert.equal(Buffer.concat(envelope.chunks).length, limit);
});

test("assembly accepts only exact ordered fragments and exact digest/count", () => {
  const bytes = payload({ alpha: "β", list: [1, 2, 3] });
  const parts = [bytes.subarray(0, 5), bytes.subarray(5, 13), bytes.subarray(13)];
  const digest = reviewSettingsSha256(bytes);
  const build = (): ReviewSettingsPayloadAssembler => {
    const assembler = ReviewSettingsPayloadAssembler.begin(bytes.length, digest);
    assert.ok(assembler);
    return assembler;
  };

  const complete = build();
  parts.forEach((part, index) => {
    assert.equal(complete.add(index, Buffer.from(part).toString("base64")), true);
  });
  assert.deepEqual(complete.complete(parts.length), bytes);

  const wrongOrder = build();
  assert.equal(wrongOrder.add(1, Buffer.from(parts[0]).toString("base64")), false);
  assert.equal(wrongOrder.complete(0), null);

  const duplicate = build();
  assert.equal(duplicate.add(0, Buffer.from(parts[0]).toString("base64")), true);
  assert.equal(duplicate.add(0, Buffer.from(parts[1]).toString("base64")), false);
  assert.equal(duplicate.complete(1), null);

  const overflow = build();
  assert.equal(overflow.add(0, Buffer.concat([Buffer.from(bytes), Buffer.from([0x20])]).toString("base64")), false);

  const wrongDigest = ReviewSettingsPayloadAssembler.begin(bytes.length, "0".repeat(64));
  assert.ok(wrongDigest);
  parts.forEach((part, index) => {
    assert.equal(wrongDigest.add(index, Buffer.from(part).toString("base64")), true);
  });
  assert.equal(wrongDigest.complete(parts.length), null);

  const wrongCount = build();
  parts.forEach((part, index) => {
    assert.equal(wrongCount.add(index, Buffer.from(part).toString("base64")), true);
  });
  assert.equal(wrongCount.complete(parts.length + 1), null);

  const short = build();
  parts.slice(0, -1).forEach((part, index) => {
    assert.equal(short.add(index, Buffer.from(part).toString("base64")), true);
  });
  assert.equal(short.complete(parts.length - 1), null, "an announced byte total is not satisfied by prefix data");

  assert.equal(ReviewSettingsPayloadAssembler.begin(REVIEW_SETTINGS_MAX_BYTES + 1, digest), null);
  assert.equal(ReviewSettingsPayloadAssembler.begin(1, "not-a-digest"), null);
});

test("owner facts and outcome unions are closed", () => {
  const accepted: OwnerReviewSettingsFacts[] = [
    { kind: "accepted" },
    { kind: "accepted", payload: payload({ key: "value" }) },
    { kind: "refused", reason: "stale" },
    { kind: "unknown" },
  ];
  for (const fact of accepted) assert.equal(isOwnerReviewSettingsFacts(fact), true);
  for (const fact of [
    { kind: "accepted", payload: new Uint8Array([0xff]) },
    { kind: "accepted", payload: "{}" },
    { kind: "accepted", extra: true },
    { kind: "refused", reason: "nope" },
    { kind: "refused" },
    { kind: "other" },
  ]) {
    assert.equal(isOwnerReviewSettingsFacts(fact), false, `${JSON.stringify(fact)} must be refused`);
  }
  assert.equal(isReviewSettingsOutcome({ kind: "accepted" }), true);
  assert.equal(isReviewSettingsOutcome({ kind: "refused", reason: "policy" }), true);
  assert.equal(isReviewSettingsOutcome({ kind: "unknown" }), true);
  assert.equal(isReviewSettingsOutcome({ kind: "accepted", reason: "policy" }), false);
  assert.equal(isReviewSettingsOutcome({ kind: "refused", reason: "policy", extra: 1 }), false);
});

test("a save receipt is closed, bounded, and only ever accompanies an acceptance", () => {
  const receipt = { disabledTaskIds: ["task-1", "task-2"], additionalDisabledCount: 3 };
  assert.equal(isReviewSettingsSaveReceipt(receipt), true);
  assert.equal(isReviewSettingsOutcome({ kind: "accepted", receipt }), true);
  assert.equal(isOwnerReviewSettingsFacts({ kind: "accepted", receipt }), true);

  for (const invalid of [
    { disabledTaskIds: ["task-1"] },
    { disabledTaskIds: [], additionalDisabledCount: 0 },
    { disabledTaskIds: ["task-1", "task-1"], additionalDisabledCount: 0 },
    { disabledTaskIds: [""], additionalDisabledCount: 0 },
    { disabledTaskIds: ["."], additionalDisabledCount: 0 },
    { disabledTaskIds: [".."], additionalDisabledCount: 0 },
    { disabledTaskIds: ['a"b'], additionalDisabledCount: 0 },
    { disabledTaskIds: ["a b"], additionalDisabledCount: 0 },
    { disabledTaskIds: ["a\nb"], additionalDisabledCount: 0 },
    { disabledTaskIds: ["a".repeat(REVIEW_SETTINGS_MAX_RECEIPT_TASK_ID + 1)], additionalDisabledCount: 0 },
    { disabledTaskIds: Array.from({ length: REVIEW_SETTINGS_MAX_RECEIPT_TASK_IDS + 1 }, (_, index) => `task-${index}`), additionalDisabledCount: 0 },
    { disabledTaskIds: ["task-1"], additionalDisabledCount: -1 },
    { disabledTaskIds: ["task-1"], additionalDisabledCount: 1.5 },
    { disabledTaskIds: ["task-1"], additionalDisabledCount: 0, extra: true },
    { disabledTaskIds: "task-1", additionalDisabledCount: 0 },
  ]) {
    assert.equal(isReviewSettingsSaveReceipt(invalid), false, `${JSON.stringify(invalid)} must be refused`);
  }
  assert.equal(isReviewSettingsOutcome({ kind: "accepted", receipt: { disabledTaskIds: [] } }), false);
  assert.equal(isReviewSettingsOutcome({ kind: "accepted", payload: payload({}) }), false,
    "a result outcome never carries a load payload");
  assert.equal(isOwnerReviewSettingsFacts({
    kind: "accepted",
    payload: payload({}),
    receipt,
  }), false, "a payload and a receipt are never the same acceptance");

  // The builder derives only proven identities: repeats are the same task,
  // and identities the bounded list cannot carry are counted, never dropped.
  assert.equal(buildReviewSettingsSaveReceipt([]), undefined);
  assert.deepEqual(buildReviewSettingsSaveReceipt(["task-1", "task-1"]), {
    disabledTaskIds: ["task-1"],
    additionalDisabledCount: 0,
  });
  const many = Array.from({ length: REVIEW_SETTINGS_MAX_RECEIPT_TASK_IDS + 2 }, (_, index) => `task-${index}`);
  assert.deepEqual(buildReviewSettingsSaveReceipt(many), {
    disabledTaskIds: many.slice(0, REVIEW_SETTINGS_MAX_RECEIPT_TASK_IDS),
    additionalDisabledCount: 2,
  });
  assert.deepEqual(buildReviewSettingsSaveReceipt(["ok", "x".repeat(REVIEW_SETTINGS_MAX_RECEIPT_TASK_ID + 1)]), {
    disabledTaskIds: ["ok"],
    additionalDisabledCount: 1,
  });
  assert.deepEqual(buildReviewSettingsSaveReceipt(["ok", 'bad"id']), {
    disabledTaskIds: ["ok"],
    additionalDisabledCount: 1,
  }, "an identity that cannot appear in a fixed notice is counted, never shown");

  // The total ceiling is finite but covers every accepted Save envelope, so a
  // 2,049-entry disable is reported exactly instead of being clamped.
  const manyIds = Array.from({ length: 2_049 }, (_unused, index) => `task-${index}`);
  const builtMany = buildReviewSettingsSaveReceipt(manyIds);
  assert.ok(builtMany);
  assert.equal(builtMany.disabledTaskIds.length, REVIEW_SETTINGS_MAX_RECEIPT_TASK_IDS);
  assert.equal(builtMany.additionalDisabledCount, 2_049 - REVIEW_SETTINGS_MAX_RECEIPT_TASK_IDS);
  assert.equal(builtMany.disabledTaskIds.length + builtMany.additionalDisabledCount, 2_049);
  assert.equal(isReviewSettingsSaveReceipt(builtMany), true);
  assert.equal(REVIEW_SETTINGS_MAX_RECEIPT_TASKS >= 2_049, true);
  assert.equal(isReviewSettingsSaveReceipt({
    disabledTaskIds: ["task-1"],
    additionalDisabledCount: REVIEW_SETTINGS_MAX_RECEIPT_TASKS,
  }), false, "a total above the finite count ceiling is refused");
});
