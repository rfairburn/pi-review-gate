/**
 * Focused contracts for the rowless owner-create capability.
 *
 * These cases are pure: they import the fixed fact boundary, the one shared
 * workspace field rule, and the existing roster wire codec. They start no
 * listener, open no socket, write no file, and need no peer. Behavior against a
 * real owner provider and a real TLS pair is proven by the roster-bridge,
 * coordinator, and Main suites; this file pins the shapes those suites rely on.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  OWNER_CREATE_FACT_KINDS,
  OWNER_CREATE_WORKSPACE_MAX_BYTES,
  OWNER_CREATE_WORKSPACE_MAX_CODEPOINTS,
  isOwnerCreateFacts,
  isOwnerCreateRunStillCurrent,
  isOwnerCreateWorkspace,
} from "../src/session-host/network/peer-create";
import {
  DEFAULT_ROSTER_BRIDGE_BOUNDS,
  ROSTER_BRIDGE_CLOSE_CAPABILITY,
  ROSTER_BRIDGE_CREATE_CAPABILITY,
  ROSTER_BRIDGE_ROSTER_SLOT_CAPABILITY,
  ROSTER_BRIDGE_SAVED_CAPABILITY,
  ROSTER_BRIDGE_KNOWN_OPTIONAL_CAPABILITIES,
  ROSTER_BRIDGE_MAJOR,
  ROSTER_BRIDGE_MINOR,
  ROSTER_BRIDGE_REQUIRED_CAPABILITY,
  ROSTER_BRIDGE_SERVICE,
  decodeRosterBridgeFrame,
  encodeRosterBridgeFrame,
  isRosterBridgeProtocolError,
  negotiateRosterBridgeHello,
  resolveRosterBridgeBounds,
  type RosterBridgeCreateRequestFrame,
  type RosterBridgeCreateResultFrame,
} from "../src/session-host/network/roster-bridge-protocol";

const RUN_A = "11111111-1111-4111-8111-111111111111";
const RUN_B = "22222222-2222-4222-8222-222222222222";
/** One astral code point: 4 UTF-8 bytes but two UTF-16 code units. */
const ASTRAL = "\u{1f5c2}";

function createRequest(overrides: Partial<RosterBridgeCreateRequestFrame> = {}): RosterBridgeCreateRequestFrame {
  return { type: "create_request", requestId: "req-1", hostRunId: RUN_A, workspace: "/srv/owner/project", sequence: 1, ...overrides };
}

function createResult(requestId: string, outcome: RosterBridgeCreateResultFrame["outcome"]): RosterBridgeCreateResultFrame {
  return { type: "create_result", requestId, outcome };
}

/** Encode with the real codec; the decoder is what must refuse the wire shape. */
function encodeForWire(frame: unknown): Buffer {
  return Buffer.from(JSON.stringify(frame), "utf8");
}

/** True only for the protocol's own fixed refusal of a frame it cannot carry. */
function refusedFrame(frame: unknown): boolean {
  try {
    decodeRosterBridgeFrame(encodeForWire(frame));
    return false;
  } catch (error) {
    return isRosterBridgeProtocolError(error) && error.code === "bad_frame";
  }
}

test("owner-create facts are one closed shape and overstate nothing", () => {
  assert.deepEqual([...OWNER_CREATE_FACT_KINDS], ["started", "unconfirmed", "refused", "unknown"]);
  assert.equal(isOwnerCreateFacts({ kind: "started", hostRunId: RUN_A, rowId: "native-1" }), true);
  for (const facts of [{ kind: "unconfirmed" }, { kind: "refused" }, { kind: "unknown" }]) {
    assert.equal(isOwnerCreateFacts(facts), true);
  }
  for (const value of [
    {},
    { kind: "created" },
    { kind: "STARTED" },
    { kind: "started " },
    "started",
    [],
    null,
    undefined,
    7,
    // `started` must name exactly one owner run and one row, and nothing else.
    { kind: "started" },
    { kind: "started", hostRunId: RUN_A },
    { kind: "started", rowId: "native-1" },
    { kind: "started", hostRunId: "", rowId: "native-1" },
    { kind: "started", hostRunId: RUN_A, rowId: "" },
    { kind: "started", hostRunId: RUN_A, rowId: "native-1", confirmed: true },
    { kind: "started", hostRunId: RUN_A, rowId: "native-1", workspace: "/srv/x" },
    { kind: "started", hostRunId: RUN_A, rowId: "native-1", focus: "selected" },
    // A non-started fact carries one field and nothing more.
    { kind: "unconfirmed", hostRunId: RUN_A },
    { kind: "refused", rowId: "native-1" },
    { kind: "unknown", extra: 1 },
  ]) {
    assert.equal(isOwnerCreateFacts(value), false, `${JSON.stringify(value)} must never be a reportable fact`);
  }
});

test("the create run proof matches only the exact observed owner run", () => {
  assert.equal(isOwnerCreateRunStillCurrent(RUN_A, RUN_A), true);
  assert.equal(isOwnerCreateRunStillCurrent(RUN_B, RUN_A), false);
  assert.equal(isOwnerCreateRunStillCurrent(null, RUN_A), false, "an unobserved run is never a match");
  assert.equal(isOwnerCreateRunStillCurrent("", RUN_A), false);
  assert.equal(isOwnerCreateRunStillCurrent(RUN_A, ""), false);
  assert.equal(isOwnerCreateRunStillCurrent(`${RUN_A} `, RUN_A), false, "no normalization or trimming");
});

test("the workspace bound is the New form's own 2048 code points and 8192 UTF-8 bytes", () => {
  assert.equal(OWNER_CREATE_WORKSPACE_MAX_CODEPOINTS, 2_048);
  assert.equal(OWNER_CREATE_WORKSPACE_MAX_BYTES, 8_192);
  // The widest legal form value: 2048 astral code points, i.e. exactly 8192 bytes.
  const astral = ASTRAL.repeat(OWNER_CREATE_WORKSPACE_MAX_CODEPOINTS);
  assert.equal(astral.length, 4_096, "the astral fixture is 4096 UTF-16 code units");
  assert.equal(Buffer.byteLength(astral, "utf8"), OWNER_CREATE_WORKSPACE_MAX_BYTES);
  assert.equal(isOwnerCreateWorkspace(astral), true, "a legal 2048-code-point form value must be carried");
  // One code point or one byte past the derivation is refused, never truncated.
  assert.equal(isOwnerCreateWorkspace(ASTRAL.repeat(OWNER_CREATE_WORKSPACE_MAX_CODEPOINTS + 1)), false);
  assert.equal(isOwnerCreateWorkspace("a".repeat(OWNER_CREATE_WORKSPACE_MAX_CODEPOINTS)), true);
  assert.equal(isOwnerCreateWorkspace("a".repeat(OWNER_CREATE_WORKSPACE_MAX_CODEPOINTS + 1)), false);
  // A coarser 4096-BYTES cap would reject legal input; the real bound does not.
  const overFourKilobytes = ASTRAL.repeat(1_025);
  assert.equal(Buffer.byteLength(overFourKilobytes, "utf8"), 4_100);
  assert.equal(isOwnerCreateWorkspace(overFourKilobytes), true);
  // Real path syntax is preserved exactly: spaces, slashes, backslashes, Unicode.
  for (const workspace of [
    "/srv/owner/日本語-work",
    "C:\\Users\\owner\\My Projects\\pi",
    "  /srv/padded /workspace  ",
    "/srv/owner/project with spaces/and:colons",
    "relative/child",
  ]) {
    assert.equal(isOwnerCreateWorkspace(workspace), true, `${workspace} is legal single-line path text`);
  }
  // Nothing is trimmed or normalized in place: the value survives byte for byte.
  const padded = "  /srv/padded /workspace  ";
  assert.equal(padded.trim() === padded, false, "the fixture really has surrounding spaces");
  assert.equal(isOwnerCreateWorkspace(padded) ? padded : null, padded);
  for (const value of [
    "",
    "\u0000",
    "/srv/\nnext",
    "/srv/\ttab",
    "/srv/\u001b[2J",
    "/srv/\u007f",
    "/srv/\u0090c1",
    "/srv/\u2028sep",
    // An unpaired surrogate can never be encoded as UTF-8.
    "/srv/\ud800lone",
    "/srv/\udcfflone",
    7,
    null,
    undefined,
    ["/srv/x"],
    { workspace: "/srv/x" },
  ]) {
    assert.equal(isOwnerCreateWorkspace(value), false, `${JSON.stringify(value)} must never be carried`);
  }
});

test("create frames are an optional capability that is never offered by default", () => {
  assert.deepEqual([...ROSTER_BRIDGE_KNOWN_OPTIONAL_CAPABILITIES],
    [ROSTER_BRIDGE_CLOSE_CAPABILITY, ROSTER_BRIDGE_CREATE_CAPABILITY, ROSTER_BRIDGE_SAVED_CAPABILITY,
      ROSTER_BRIDGE_ROSTER_SLOT_CAPABILITY]);
  const decision = negotiateRosterBridgeHello({
    type: "hello",
    service: ROSTER_BRIDGE_SERVICE,
    major: ROSTER_BRIDGE_MAJOR,
    minor: ROSTER_BRIDGE_MINOR,
    capabilities: [ROSTER_BRIDGE_REQUIRED_CAPABILITY, ROSTER_BRIDGE_CREATE_CAPABILITY],
  });
  assert.equal(decision.ok, true);
  assert.deepEqual(decision.ok ? decision.capabilities : null, [ROSTER_BRIDGE_CREATE_CAPABILITY]);
  // A minor version alone still grants nothing, and the wire version is unchanged.
  assert.equal(ROSTER_BRIDGE_MINOR, 0);
  assert.equal(ROSTER_BRIDGE_REQUIRED_CAPABILITY, "roster-v1");

  // The result deadline reuses the Close patience class and is a validated bound.
  assert.equal(DEFAULT_ROSTER_BRIDGE_BOUNDS.createResultTimeoutMs, 15_000);
  assert.equal(resolveRosterBridgeBounds({ createResultTimeoutMs: 1 }).createResultTimeoutMs, 1);
  assert.equal(resolveRosterBridgeBounds().maxFrameBytes, 65_536);
  for (const value of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.throws(() => resolveRosterBridgeBounds({ createResultTimeoutMs: value }),
      (error: unknown) => isRosterBridgeProtocolError(error) && error.code === "invalid_bounds");
  }
});

test("create frames round-trip through the closed schema with exact facts", () => {
  const request = createRequest();
  assert.deepEqual(decodeRosterBridgeFrame(encodeRosterBridgeFrame(request)), request);
  // The form's widest legal workspace round-trips unchanged.
  const widest = { ...createRequest(), workspace: ASTRAL.repeat(OWNER_CREATE_WORKSPACE_MAX_CODEPOINTS) };
  assert.deepEqual(decodeRosterBridgeFrame(encodeRosterBridgeFrame(widest)), widest);
  // Real path syntax survives encoding and decoding exactly.
  const windows = { ...createRequest(), workspace: "C:\\Users\\owner\\My Projects\\pi" };
  assert.deepEqual(decodeRosterBridgeFrame(encodeRosterBridgeFrame(windows)), windows);

  assert.deepEqual(
    decodeRosterBridgeFrame(encodeRosterBridgeFrame(createResult("req-1", { kind: "started", hostRunId: RUN_A, rowId: "native-1" }))),
    { type: "create_result", requestId: "req-1", outcome: { kind: "started", hostRunId: RUN_A, rowId: "native-1" } },
  );
  for (const kind of ["unconfirmed", "refused", "unknown"] as const) {
    assert.deepEqual(decodeRosterBridgeFrame(encodeRosterBridgeFrame(createResult("req-1", { kind }))),
      { type: "create_result", requestId: "req-1", outcome: { kind } });
  }
});

test("create frames refuse any shape outside their closed schema", () => {
  for (const extra of [
    { payload: "x" },
    { error: "boom" },
    { rowId: "native-1" },
    { confirmed: true },
    { nativeSession: {} },
    { path: "/tmp/x" },
    { cwd: "/tmp/x" },
    { focus: "main" },
    { viewer: 1 },
  ]) {
    assert.equal(refusedFrame({ ...createRequest(), ...extra }), true, `${JSON.stringify(extra)} must never decode`);
    assert.equal(refusedFrame({ ...createResult("req-1", { kind: "unknown" }), ...extra }), true);
  }
  for (const requestId of ["", "-lead", "has space", "x".repeat(65), 7, null]) {
    assert.equal(refusedFrame(createRequest({ requestId: requestId as never })), true, `${String(requestId)} must never decode`);
    assert.equal(refusedFrame({ type: "create_result", requestId, outcome: { kind: "unknown" } }), true);
  }
  for (const hostRunId of ["", "-lead", "x".repeat(65), 3, null]) {
    assert.equal(refusedFrame(createRequest({ hostRunId: hostRunId as never })), true, `${String(hostRunId)} must never decode`);
  }
  for (const sequence of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, "1", null, undefined, true]) {
    assert.equal(refusedFrame({ ...createRequest(), sequence }), true, `sequence=${String(sequence)} must never decode`);
  }
  for (const workspace of ["", "/srv/\u0000", "/srv/\nnext", "/srv/\ud800lone", ASTRAL.repeat(2_049), 7, null, undefined]) {
    assert.equal(refusedFrame({ ...createRequest(), workspace }), true, `workspace=${String(workspace).slice(0, 20)} must never decode`);
  }
  for (const outcome of [
    {},
    { kind: "created" },
    { kind: "started" },
    { kind: "started", hostRunId: RUN_A, rowId: "" },
    { kind: "started", hostRunId: "-bad", rowId: "native-1" },
    { kind: "started", hostRunId: RUN_A, rowId: "native-1", extra: 1 },
    { kind: "removed" },
    "unknown",
    [],
    null,
  ]) {
    assert.equal(refusedFrame({ type: "create_result", requestId: "req-1", outcome }), true,
      `${JSON.stringify(outcome)} must never decode`);
  }
  // The encoder refuses the same closed schema for a frame this side built wrongly.
  assert.throws(() => encodeRosterBridgeFrame({ ...createRequest(), sequence: 0 } as never),
    (error: unknown) => isRosterBridgeProtocolError(error) && error.code === "invalid_frame");
  assert.throws(() => encodeRosterBridgeFrame(createResult("req-1", { kind: "created" } as never)),
    (error: unknown) => isRosterBridgeProtocolError(error) && error.code === "invalid_frame");
  assert.throws(() => encodeRosterBridgeFrame({ ...createRequest(), extra: 1 } as never),
    (error: unknown) => isRosterBridgeProtocolError(error) && error.code === "invalid_frame");
});
