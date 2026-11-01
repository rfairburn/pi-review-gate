/**
 * Focused contract and codec tests for the owner-routed rename foundation
 * (issue #512, backend slice 1: pure contracts + wire codec only).
 *
 * Everything here is pure: no socket, listener, timer, channel, bridge host,
 * coordinator, manager, filesystem, or product state is touched. The assertions
 * cover what this slice actually owns —
 *
 * - the optional `roster-rename-v1` capability is known, optional, and can only
 *   ever narrow a negotiation, never widen one;
 * - `rename_request` / `rename_result` are closed-key bounded frames: exact
 *   arity, canonical native id/name/epoch rules, a positive monotonic sequence,
 *   and no path, workspace, saved-session file, current file, agent directory,
 *   alias, host, selection, viewer, or previous-name field is expressible;
 * - a rename result carries one fixed fact kind and never a name, an id, or an
 *   epoch, so no private owner text can ride back to a requester;
 * - the requester-side contract validators apply the SAME canonical native
 *   validators the local rename route uses, at exact arity;
 * - the finite rename patience bound exists, defaults to a positive value, and is
 *   overridable only within the same validation rules as the other bounds.
 *
 * Transport/coordinator behaviour (routing, re-authorization, no-replay
 * enforcement, metadata fan-out) is a later slice and is deliberately not
 * asserted here.
 */

import assert from "node:assert/strict";
import test from "node:test";
import {
  MAX_NATIVE_SESSION_ID_BYTES,
  MAX_RENAME_NAME_BYTES,
} from "../src/session-host/protocol";
import {
  OWNER_RENAME_FACT_KINDS,
  isOwnerRenameFacts,
  isOwnerRenameTupleStillCurrent,
  type OwnerRenameRequest,
} from "../src/session-host/network/peer-rename";
import {
  DEFAULT_ROSTER_BRIDGE_BOUNDS,
  ROSTER_BRIDGE_CLOSE_CAPABILITY,
  ROSTER_BRIDGE_CREATE_CAPABILITY,
  ROSTER_BRIDGE_KNOWN_OPTIONAL_CAPABILITIES,
  ROSTER_BRIDGE_MAJOR,
  ROSTER_BRIDGE_MINOR,
  ROSTER_BRIDGE_RENAME_CAPABILITY,
  ROSTER_BRIDGE_REQUIRED_CAPABILITY,
  ROSTER_BRIDGE_SAVED_CAPABILITY,
  ROSTER_BRIDGE_SERVICE,
  decodeRosterBridgeFrame,
  encodeRosterBridgeFrame,
  isRosterBridgeProtocolError,
  negotiateRosterBridgeHello,
  resolveRosterBridgeBounds,
  reviewRosterBridgeHelloAck,
  type RosterBridgeBounds,
  type RosterBridgeFrame,
  type RosterBridgeHelloAckFrame,
  type RosterBridgeHelloFrame,
  type RosterBridgeRenameRequestFrame,
  type RosterBridgeRenameResultFrame,
} from "../src/session-host/network/roster-bridge-protocol";

const REQUEST_KEYS = [
  "expectedSessionEpoch",
  "expectedSessionId",
  "hostRunId",
  "name",
  "requestId",
  "rowId",
  "sequence",
  "type",
] as const;

/** One valid rename request frame, rebuilt per case from an explicit override. */
function renameRequest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: "rename_request",
    requestId: "req-1",
    hostRunId: "run-2026",
    rowId: "row-7",
    expectedSessionId: "session-2f6c1a",
    expectedSessionEpoch: 3,
    name: "Deploy rehearsal",
    sequence: 1,
    ...overrides,
  };
}

function renameResult(kind: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { type: "rename_result", requestId: "req-1", outcome: { kind }, ...overrides };
}

function decode(value: unknown): RosterBridgeFrame {
  return decodeRosterBridgeFrame(Buffer.from(JSON.stringify(value), "utf8"));
}

function decodeFails(value: unknown, code = "bad_frame"): void {
  let caught: unknown;
  try {
    decodeRosterBridgeFrame(Buffer.from(JSON.stringify(value), "utf8"));
  } catch (error) {
    caught = error;
  }
  assert.ok(isRosterBridgeProtocolError(caught), `expected a ${code} refusal`);
  assert.equal((caught as { code: string }).code, code);
}

function roundTrip(frame: RosterBridgeFrame): RosterBridgeFrame {
  const bytes = encodeRosterBridgeFrame(frame);
  assert.ok(bytes.length <= DEFAULT_ROSTER_BRIDGE_BOUNDS.maxFrameBytes);
  return decodeRosterBridgeFrame(bytes);
}

// --------------------------------------------------------------- capability

test("roster-rename-v1 is an optional known capability that never replaces the baseline", () => {
  assert.equal(ROSTER_BRIDGE_RENAME_CAPABILITY, "roster-rename-v1");
  assert.notEqual(ROSTER_BRIDGE_RENAME_CAPABILITY, ROSTER_BRIDGE_REQUIRED_CAPABILITY);
  assert.ok(ROSTER_BRIDGE_KNOWN_OPTIONAL_CAPABILITIES.includes(ROSTER_BRIDGE_RENAME_CAPABILITY));
  // Still exactly the four optional lanes, each declared once, and the baseline is
  // never part of the optional set.
  assert.deepEqual(
    [...ROSTER_BRIDGE_KNOWN_OPTIONAL_CAPABILITIES].sort(),
    [
      ROSTER_BRIDGE_CLOSE_CAPABILITY,
      ROSTER_BRIDGE_CREATE_CAPABILITY,
      ROSTER_BRIDGE_RENAME_CAPABILITY,
      ROSTER_BRIDGE_SAVED_CAPABILITY,
    ].sort(),
  );
  assert.ok(!ROSTER_BRIDGE_KNOWN_OPTIONAL_CAPABILITIES.includes(ROSTER_BRIDGE_REQUIRED_CAPABILITY));
});

test("offering rename narrows negotiation to what both sides know and never widens it", () => {
  const hello: RosterBridgeHelloFrame = {
    type: "hello",
    service: ROSTER_BRIDGE_SERVICE,
    major: ROSTER_BRIDGE_MAJOR,
    minor: ROSTER_BRIDGE_MINOR,
    capabilities: [
      ROSTER_BRIDGE_REQUIRED_CAPABILITY,
      ROSTER_BRIDGE_RENAME_CAPABILITY,
      "roster-rename-v2",
      "roster-whatever-v9",
    ],
  };
  const decision = negotiateRosterBridgeHello(hello);
  assert.equal(decision.ok, true);
  assert.ok(decision.ok);
  assert.deepEqual([...decision.capabilities], [ROSTER_BRIDGE_RENAME_CAPABILITY],
    "an unknown identifier is ignored, never trusted, and the baseline is not repeated");
  assert.ok(!decision.capabilities.includes("roster-rename-v2" as never));

  // A viewer that never offered rename cannot be told it exists by the ack.
  const offered = { capabilities: [ROSTER_BRIDGE_CLOSE_CAPABILITY] };
  const ack: RosterBridgeHelloAckFrame = {
    type: "hello_ack",
    service: ROSTER_BRIDGE_SERVICE,
    major: ROSTER_BRIDGE_MAJOR,
    minor: ROSTER_BRIDGE_MINOR,
    capabilities: [ROSTER_BRIDGE_REQUIRED_CAPABILITY, ROSTER_BRIDGE_RENAME_CAPABILITY],
  };
  const verdict = reviewRosterBridgeHelloAck(ack, offered);
  assert.deepEqual(verdict, { ok: false, code: "protocol_violation" },
    "rename support can never be claimed for a channel that never offered it");

  // Offered and acknowledged is the only in-force combination.
  const agreed = reviewRosterBridgeHelloAck(
    { ...ack, capabilities: [ROSTER_BRIDGE_REQUIRED_CAPABILITY, ROSTER_BRIDGE_RENAME_CAPABILITY] },
    { capabilities: [ROSTER_BRIDGE_REQUIRED_CAPABILITY, ROSTER_BRIDGE_RENAME_CAPABILITY] },
  );
  assert.equal(agreed.ok, true);

  // A hello without the baseline is still refused even when rename is offered.
  const noBaseline = negotiateRosterBridgeHello({
    ...hello,
    capabilities: [ROSTER_BRIDGE_RENAME_CAPABILITY],
  });
  assert.deepEqual(noBaseline, { ok: false, code: "missing_capability" });
});

// ------------------------------------------------------------- request codec

test("rename_request round-trips whole, frozen, and with exactly its closed keys", () => {
  const frame = renameRequest() as unknown as RosterBridgeRenameRequestFrame;
  const decoded = roundTrip(frame);
  assert.deepEqual(decoded, frame, "the decoded frame is byte-for-byte the same request");
  assert.ok(Object.isFrozen(decoded));
  assert.deepEqual(Object.keys(decoded).sort(), [...REQUEST_KEYS]);
  const nested = decoded as unknown as RosterBridgeRenameRequestFrame;
  assert.equal(nested.expectedSessionEpoch, 3);
  assert.equal(nested.name, "Deploy rehearsal", "the requested name is forwarded verbatim");
});

test("rename_request carries no name history, path, workspace, native file, or display fact", () => {
  for (const smuggled of [
    "cwd",
    "workspace",
    "file",
    "currentFile",
    "agentDir",
    "previousName",
    "label",
    "host",
    "endpoint",
    "selected",
    "viewerId",
    "confirmed",
    "sequenceExtra",
  ]) {
    decodeFails(renameRequest({ [smuggled]: smuggled.startsWith("sequence") ? 9 : "private" }), "bad_frame");
  }
  // A missing field is refused rather than defaulted.
  for (const key of REQUEST_KEYS) {
    if (key === "type") continue;
    const partial = renameRequest();
    delete partial[key];
    decodeFails(partial, "bad_frame");
  }
  // Null instead of a value is refused too.
  decodeFails(renameRequest({ name: null }), "bad_frame");
  decodeFails(renameRequest({ expectedSessionId: null }), "bad_frame");
});

test("rename_request applies the canonical native id, name, and epoch rules", () => {
  // Valid: the widest canonical values are accepted whole, never clipped.
  const wideName = "x".repeat(MAX_RENAME_NAME_BYTES);
  const wideId = "s".repeat(MAX_NATIVE_SESSION_ID_BYTES);
  const accepted = decode(renameRequest({ name: wideName, expectedSessionId: wideId }));
  assert.equal((accepted as RosterBridgeRenameRequestFrame).name, wideName);
  assert.equal((accepted as RosterBridgeRenameRequestFrame).expectedSessionId, wideId);
  assert.equal(
    (decode(renameRequest({ expectedSessionEpoch: Number.MAX_SAFE_INTEGER })) as RosterBridgeRenameRequestFrame)
      .expectedSessionEpoch,
    Number.MAX_SAFE_INTEGER,
  );

  // Names the native rename field itself refuses are refused on the wire too.
  for (const name of [
    "",
    "   ",
    `${"x".repeat(MAX_RENAME_NAME_BYTES + 1)}`,
    "before\u0000after",
    "before\u001fafter",
    "line\u2028break",
    "line\u0085break",
    7,
    true,
    {},
  ]) {
    decodeFails(renameRequest({ name }), "bad_frame");
  }

  // A native session id is not a lane identifier: the native rule governs it.
  for (const sessionId of [
    "",
    "dir/session",
    "dir\\session",
    "bad\u0000id",
    "bad\u007fid",
    "s".repeat(MAX_NATIVE_SESSION_ID_BYTES + 1),
    42,
  ]) {
    decodeFails(renameRequest({ expectedSessionId: sessionId }), "bad_frame");
  }

  // An epoch is a positive safe integer: never 0, negative, fractional, or text.
  for (const epoch of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, "3", null, undefined]) {
    decodeFails(renameRequest({ expectedSessionEpoch: epoch }), "bad_frame");
  }
});

test("rename_request run and row ids obey the lane identifier rule", () => {
  for (const hostRunId of ["", "-run", "_run", ".run", "run\u0000", "run x", "r".repeat(65)]) {
    decodeFails(renameRequest({ hostRunId }), "bad_frame");
  }
  for (const rowId of ["", "/row", "row/id", "row\u0000", "r".repeat(65)]) {
    decodeFails(renameRequest({ rowId }), "bad_frame");
  }
  // The default lane bound is what applies, and a legal token inside it is kept.
  assert.equal(
    (decode(renameRequest({ rowId: "r".repeat(64) })) as RosterBridgeRenameRequestFrame).rowId.length,
    64,
  );
});

test("rename_request sequence is a positive monotonic scalar with no local history implied", () => {
  for (const sequence of [0, -1, 1.5, Number.NaN, "2", null]) {
    decodeFails(renameRequest({ sequence }), "bad_frame");
  }
  assert.equal(
    (decode(renameRequest({ sequence: Number.MAX_SAFE_INTEGER })) as RosterBridgeRenameRequestFrame).sequence,
    Number.MAX_SAFE_INTEGER,
  );
  assert.equal(
    (decode(renameRequest({ sequence: 9_007 })) as RosterBridgeRenameRequestFrame).sequence,
    9_007,
    "a higher attempt number is simply the next attempt; nothing is deduplicated here",
  );
});

// ------------------------------------------------------------- result codec

test("rename_result round-trips every fixed fact kind and nothing else", () => {
  for (const kind of OWNER_RENAME_FACT_KINDS) {
    const frame = renameResult(kind) as unknown as RosterBridgeRenameResultFrame;
    const decoded = roundTrip(frame);
    assert.deepEqual(decoded, { type: "rename_result", requestId: "req-1", outcome: { kind } });
    assert.ok(Object.isFrozen(decoded));
    const outcome = (decoded as RosterBridgeRenameResultFrame).outcome;
    assert.ok(Object.isFrozen(outcome));
    assert.deepEqual(Object.keys(outcome), ["kind"]);
  }
});

test("rename_result can never carry a name, a native tuple, an id, or owner text", () => {
  for (const smuggled of [
    "name",
    "previousName",
    "expectedSessionId",
    "expectedSessionEpoch",
    "hostRunId",
    "rowId",
    "message",
    "reason",
    "path",
    "cwd",
    "detail",
  ]) {
    decodeFails(renameResult("renamed", { outcome: { kind: "renamed", [smuggled]: "private" } }), "bad_frame");
  }
  // An invented or missing fact kind is refused, as is a non-record outcome.
  for (const kind of ["removed", "started", "deleted", "confirmation-required", "", 7, null, undefined]) {
    decodeFails(renameResult(kind as unknown as string), "bad_frame");
  }
  for (const outcome of ["renamed", 4, [], null, undefined]) {
    decodeFails(renameResult("renamed", { outcome }), "bad_frame");
  }
  const missing = renameResult("renamed");
  delete missing.outcome;
  decodeFails(missing, "bad_frame");
  const missingId = renameResult("renamed");
  delete missingId.requestId;
  decodeFails(missingId, "bad_frame");
});

test("rename frames are refused on this side too, so no peer-incompatible frame is ever sent", () => {
  // A frame this side builds wrongly is a programming failure: `invalid_frame`.
  let caught: unknown;
  try {
    encodeRosterBridgeFrame(renameRequest({ expectedSessionEpoch: 0 }) as unknown as RosterBridgeFrame);
  } catch (error) {
    caught = error;
  }
  assert.ok(isRosterBridgeProtocolError(caught));
  assert.equal((caught as { code: string }).code, "invalid_frame");

  for (const frame of [
    renameRequest({ name: "" }),
    renameRequest({ expectedSessionId: "a/b" }),
    renameRequest({ sequence: 0 }),
    renameRequest({ cwd: "/tmp" }),
    renameResult("renamed", { outcome: { kind: "renamed", name: "x" } }),
    renameResult("nope"),
  ]) {
    let error: unknown;
    try {
      encodeRosterBridgeFrame(frame as unknown as RosterBridgeFrame);
    } catch (cause) {
      error = cause;
    }
    assert.ok(isRosterBridgeProtocolError(error), "encoding a malformed rename frame must fail closed");
    assert.equal((error as { code: string }).code, "invalid_frame");
  }

  // An over-bound rename frame is refused whole, never split or truncated.
  const tight: RosterBridgeBounds = resolveRosterBridgeBounds({
    maxFrameBytes: 256,
    maxPageBytes: 256,
    maxRowsPerPage: 1,
    maxSnapshotRows: 1,
    maxSnapshotBytes: 256,
  });
  let oversized: unknown;
  try {
    encodeRosterBridgeFrame(
      renameRequest({ name: "n".repeat(300) }) as unknown as RosterBridgeFrame,
      tight,
    );
  } catch (error) {
    oversized = error;
  }
  assert.ok(isRosterBridgeProtocolError(oversized));
  assert.equal((oversized as { code: string }).code, "frame_too_large");

  // The same content inside the bound still round-trips under that tight bound.
  const small = renameRequest({ name: "small" }) as unknown as RosterBridgeRenameRequestFrame;
  assert.deepEqual(decodeRosterBridgeFrame(encodeRosterBridgeFrame(small, tight), tight), small);
});

// ----------------------------------------------------------- contract guards

test("owner rename facts are a closed set with no carried name", () => {
  for (const kind of OWNER_RENAME_FACT_KINDS) {
    assert.ok(isOwnerRenameFacts({ kind }));
  }
  assert.deepEqual(
    [...OWNER_RENAME_FACT_KINDS],
    ["renamed", "stale-session", "refused", "busy", "unknown"],
    "the reported fact set is exactly the settled closed vocabulary",
  );
  for (const value of [
    { kind: "renamed", name: "Deploy rehearsal" },
    { kind: "renamed", hostRunId: "run-2026", rowId: "row-7" },
    { kind: "stale-session", expectedSessionEpoch: 4 },
    { kind: "removed" },
    { kind: "started" },
    { status: "renamed" },
    {},
    null,
    undefined,
    "renamed",
    [],
    [{ kind: "renamed" }],
  ]) {
    assert.equal(isOwnerRenameFacts(value), false);
  }
});

test("the requester's tuple fence compares exactly and never matches a moved conversation", () => {
  const request: Pick<OwnerRenameRequest, "expectedSessionId" | "expectedSessionEpoch"> = {
    expectedSessionId: "session-2f6c1a",
    expectedSessionEpoch: 3,
  };
  assert.ok(isOwnerRenameTupleStillCurrent({ sessionId: "session-2f6c1a", epoch: 3 }, request));
  for (const observed of [
    null,
    undefined,
    { sessionId: "session-99", epoch: 3 },
    { sessionId: "session-2f6c1a", epoch: 4 },
    { sessionId: "session-2f6c1a", epoch: 2 },
    { sessionId: "session-2f6c1a", epoch: Number.NaN },
  ]) {
    assert.equal(isOwnerRenameTupleStillCurrent(observed, request), false,
      "a newer, older, or unreadable native tuple is never a substitute for the named one");
  }
});

// ------------------------------------------------------------------- bounds

test("rename patience is one finite bound with the same validation as the others", () => {
  const defaultBound = DEFAULT_ROSTER_BRIDGE_BOUNDS.renameResultTimeoutMs;
  assert.ok(Number.isSafeInteger(defaultBound) && defaultBound > 0);
  assert.equal(resolveRosterBridgeBounds({ renameResultTimeoutMs: 250 }).renameResultTimeoutMs, 250);
  assert.equal(resolveRosterBridgeBounds().renameResultTimeoutMs, defaultBound);
  for (const value of [0, -1, 1.5, Number.NaN, "1000", null]) {
    let caught: unknown;
    try {
      resolveRosterBridgeBounds({ renameResultTimeoutMs: value as unknown as number });
    } catch (error) {
      caught = error;
    }
    assert.ok(isRosterBridgeProtocolError(caught));
    assert.equal((caught as { code: string }).code, "invalid_bounds");
  }
  // Every declared bound is resolved and validated as one family; the rename
  // bound is not a hidden second knob.
  const resolved = resolveRosterBridgeBounds({ renameResultTimeoutMs: 4_000 });
  for (const key of Object.keys(DEFAULT_ROSTER_BRIDGE_BOUNDS) as (keyof RosterBridgeBounds)[]) {
    assert.ok(Number.isSafeInteger(resolved[key]) && resolved[key] > 0);
  }
  assert.notEqual(resolved.renameResultTimeoutMs, DEFAULT_ROSTER_BRIDGE_BOUNDS.renameResultTimeoutMs);
});
