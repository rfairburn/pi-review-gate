import assert from "node:assert/strict";
import test from "node:test";

import type { NativeIoInputSource } from "../src/session-host/network/session-content-protocol";
import {
  readRemoteInputModes,
  readRemoteNativeIoSource,
  sameNativeIoReceipt,
  sameTerminalInputModes,
  type CanonicalSessionGeometry,
  type WrittenRemoteNativeInput,
} from "../src/session-host/remote-native-input";
import type { TerminalInputModes } from "../src/session-host/terminal-surface";

const INPUT_MODES: TerminalInputModes = Object.freeze({
  kittyFlags: 1,
  applicationCursorKeys: false,
  applicationKeypad: false,
  bracketedPaste: true,
  mouseTracking: "none",
  modifyOtherKeys: 0,
  mouseEncoding: "default",
});

const GEOMETRY: CanonicalSessionGeometry = Object.freeze({ cols: 100, rows: 30, revision: 7 });

const CONVERSATION_SOURCE = {
  hostRunId: "host-run-1",
  sessionId: "owner-row-1",
  nativeSession: { sessionId: "native-1", epoch: 2 },
  geometry: GEOMETRY,
  viewerRevision: 5,
  sourceToken: "token-1",
} as const;

const CONVERSATION_EXPECTED = {
  hostRunId: CONVERSATION_SOURCE.hostRunId,
  sessionId: CONVERSATION_SOURCE.sessionId,
  nativeSession: CONVERSATION_SOURCE.nativeSession,
  geometry: GEOMETRY,
} as const;

const STARTUP_SOURCE = {
  hostRunId: CONVERSATION_SOURCE.hostRunId,
  sessionId: CONVERSATION_SOURCE.sessionId,
  phase: "startup",
  geometry: GEOMETRY,
  viewerRevision: CONVERSATION_SOURCE.viewerRevision,
  sourceToken: CONVERSATION_SOURCE.sourceToken,
} as const;

const STARTUP_EXPECTED = {
  hostRunId: STARTUP_SOURCE.hostRunId,
  sessionId: STARTUP_SOURCE.sessionId,
  nativeSession: null,
  geometry: GEOMETRY,
} as const;

function conversationSource(): NativeIoInputSource {
  return Object.freeze({
    ...CONVERSATION_SOURCE,
    nativeSession: Object.freeze({ ...CONVERSATION_SOURCE.nativeSession }),
    geometry: Object.freeze({ ...GEOMETRY }),
  });
}

function startupSource(): NativeIoInputSource {
  return Object.freeze({
    ...STARTUP_SOURCE,
    geometry: Object.freeze({ ...GEOMETRY }),
  });
}

function receipt(overrides: Partial<WrittenRemoteNativeInput> = {}): WrittenRemoteNativeInput {
  return {
    hostId: "host-1",
    hostRunId: CONVERSATION_SOURCE.hostRunId,
    rowId: CONVERSATION_SOURCE.sessionId,
    selectionGeneration: 3,
    subscriptionId: "subscription-1",
    source: conversationSource(),
    inputModes: INPUT_MODES,
    geometry: GEOMETRY,
    nativeContent: { column: 0, row: 1, cols: 100, rows: 30 },
    resizeEpoch: 4,
    policyGeneration: 6,
    ...overrides,
  };
}

test("remote input modes accept only the closed observed shape", () => {
  const modes = readRemoteInputModes({ ...INPUT_MODES });
  assert.deepEqual(modes, INPUT_MODES);
  assert.ok(Object.isFrozen(modes), "accepted modes are an immutable copy");
  assert.deepEqual(readRemoteInputModes({ ...INPUT_MODES, extra: "ignored" }), INPUT_MODES);

  for (const malformed of [
    undefined,
    null,
    "none",
    [],
    { ...INPUT_MODES, kittyFlags: 8 },
    { ...INPUT_MODES, kittyFlags: 1.5 },
    { ...INPUT_MODES, modifyOtherKeys: 3 },
    { ...INPUT_MODES, applicationCursorKeys: "yes" },
    { ...INPUT_MODES, applicationKeypad: 0 },
    { ...INPUT_MODES, bracketedPaste: null },
    { ...INPUT_MODES, mouseTracking: "SGR" },
    { ...INPUT_MODES, mouseEncoding: "utf8" },
  ]) {
    assert.equal(readRemoteInputModes(malformed), undefined, `malformed modes yield no input capability: ${JSON.stringify(malformed)}`);
  }

  const withoutEncoding: Record<string, unknown> = { ...INPUT_MODES };
  delete withoutEncoding.mouseEncoding;
  assert.equal(readRemoteInputModes(withoutEncoding), undefined);
});

test("terminal input mode equality is exact, including an absent mode set", () => {
  assert.equal(sameTerminalInputModes(INPUT_MODES, { ...INPUT_MODES }), true);
  assert.equal(sameTerminalInputModes(undefined, undefined), true);
  assert.equal(sameTerminalInputModes(undefined, INPUT_MODES), false);
  assert.equal(sameTerminalInputModes(INPUT_MODES, undefined), false);
  for (const mode of [
    { kittyFlags: 0 },
    { applicationCursorKeys: true },
    { applicationKeypad: true },
    { bracketedPaste: false },
    { mouseTracking: "any" as const },
    { modifyOtherKeys: 2 as const },
    { mouseEncoding: "sgr" as const },
  ]) {
    assert.equal(sameTerminalInputModes(INPUT_MODES, { ...INPUT_MODES, ...mode }), false);
  }
});

test("a conversation source is admitted only when every owner and geometry fact is coherent", () => {
  const source = readRemoteNativeIoSource({ ...CONVERSATION_SOURCE }, CONVERSATION_EXPECTED);
  assert.deepEqual(source, CONVERSATION_SOURCE);
  assert.ok(source !== undefined && Object.isFrozen(source), "the accepted source is frozen");
  assert.ok(
    Object.isFrozen((source as { nativeSession: object }).nativeSession)
      && Object.isFrozen((source as { geometry: object }).geometry),
    "nested tuple and geometry are copied, never retained by reference",
  );
  assert.equal(Object.isFrozen({ ...CONVERSATION_SOURCE }.nativeSession), false);

  for (const malformed of [
    undefined,
    null,
    "source",
    [],
    { ...CONVERSATION_SOURCE, hostRunId: "" },
    { ...CONVERSATION_SOURCE, sessionId: "" },
    { ...CONVERSATION_SOURCE, hostRunId: "host-run-2" },
    { ...CONVERSATION_SOURCE, sessionId: "owner-row-2" },
    { ...CONVERSATION_SOURCE, hostRunId: "x".repeat(257) },
    { ...CONVERSATION_SOURCE, nativeSession: null },
    { ...CONVERSATION_SOURCE, nativeSession: { sessionId: "native-1", epoch: 0 } },
    { ...CONVERSATION_SOURCE, nativeSession: { sessionId: "native-1", epoch: 1.5 } },
    { ...CONVERSATION_SOURCE, nativeSession: { sessionId: "native-2", epoch: 2 } },
    { ...CONVERSATION_SOURCE, nativeSession: { sessionId: "native-1", epoch: 3 } },
    { ...CONVERSATION_SOURCE, nativeSession: { sessionId: "", epoch: 2 } },
    { ...CONVERSATION_SOURCE, geometry: null },
    { ...CONVERSATION_SOURCE, geometry: { cols: 99, rows: 30, revision: 7 } },
    { ...CONVERSATION_SOURCE, geometry: { cols: 100, rows: 29, revision: 7 } },
    { ...CONVERSATION_SOURCE, geometry: { cols: 100, rows: 30, revision: 6 } },
    { ...CONVERSATION_SOURCE, geometry: { cols: 0, rows: 30, revision: 7 } },
    { ...CONVERSATION_SOURCE, geometry: { cols: 100, rows: 30, revision: -1 } },
    { ...CONVERSATION_SOURCE, viewerRevision: 0 },
    { ...CONVERSATION_SOURCE, viewerRevision: 1.5 },
    { ...CONVERSATION_SOURCE, viewerRevision: "5" },
    { ...CONVERSATION_SOURCE, sourceToken: "" },
    { ...CONVERSATION_SOURCE, sourceToken: "has space" },
    { ...CONVERSATION_SOURCE, sourceToken: "x".repeat(129) },
    { ...CONVERSATION_SOURCE, sourceToken: 7 },
  ]) {
    assert.equal(
      readRemoteNativeIoSource(malformed, CONVERSATION_EXPECTED),
      undefined,
      `incoherent conversation facts are never an input source: ${JSON.stringify(malformed)}`,
    );
  }
});

test("a startup source is admitted only for a publish that names no conversation", () => {
  const source = readRemoteNativeIoSource({ ...STARTUP_SOURCE }, STARTUP_EXPECTED);
  assert.deepEqual(source, STARTUP_SOURCE);
  assert.ok(source !== undefined && Object.isFrozen(source));

  assert.equal(readRemoteNativeIoSource({ ...STARTUP_SOURCE }, CONVERSATION_EXPECTED), undefined);
  assert.equal(
    readRemoteNativeIoSource({ ...CONVERSATION_SOURCE }, STARTUP_EXPECTED),
    undefined,
    "a tuple source never stands in for a startup source",
  );
  assert.equal(
    readRemoteNativeIoSource({ ...STARTUP_SOURCE, nativeSession: { sessionId: "native-1", epoch: 2 } }, STARTUP_EXPECTED),
    undefined,
    "a startup source never carries a tuple key",
  );
  assert.equal(
    readRemoteNativeIoSource({ ...STARTUP_SOURCE, phase: "conversation" }, STARTUP_EXPECTED),
    undefined,
  );
  assert.equal(
    readRemoteNativeIoSource({ ...STARTUP_SOURCE, geometry: { cols: 80, rows: 24, revision: 7 } }, STARTUP_EXPECTED),
    undefined,
  );
  assert.equal(
    readRemoteNativeIoSource({ ...STARTUP_SOURCE, viewerRevision: 0 }, STARTUP_EXPECTED),
    undefined,
  );
  assert.equal(
    readRemoteNativeIoSource({ ...STARTUP_SOURCE, sourceToken: "not printable" }, STARTUP_EXPECTED),
    undefined,
  );
});

test("receipt identity survives ordinary repaints and changes with any written fact", () => {
  const first = receipt();
  assert.equal(sameNativeIoReceipt(first, receipt()), true, "a repaint of the same written facts keeps identity");
  assert.equal(sameNativeIoReceipt(undefined, undefined), true);
  assert.equal(sameNativeIoReceipt(undefined, first), false);
  assert.equal(sameNativeIoReceipt(first, undefined), false);

  for (const changed of [
    receipt({ inputModes: { ...INPUT_MODES, kittyFlags: 2 } }),
    receipt({ inputModes: { ...INPUT_MODES, mouseTracking: "any" } }),
    receipt({ source: Object.freeze({ ...CONVERSATION_SOURCE, sourceToken: "token-2" }) }),
    receipt({ source: Object.freeze({ ...CONVERSATION_SOURCE, viewerRevision: 6 }) }),
    receipt({ source: Object.freeze({ ...CONVERSATION_SOURCE, geometry: Object.freeze({ cols: 100, rows: 30, revision: 8 }) }) }),
    receipt({ source: startupSource() }),
    receipt({ nativeContent: { column: 0, row: 1, cols: 99, rows: 30 } }),
    receipt({ resizeEpoch: 5 }),
    receipt({ policyGeneration: 7 }),
    receipt({ selectionGeneration: 4 }),
    receipt({ subscriptionId: "subscription-2" }),
  ]) {
    assert.equal(sameNativeIoReceipt(first, changed), false, "any different written fact is a writer boundary");
    assert.equal(sameNativeIoReceipt(changed, first), false);
  }

  const startup = receipt({ source: startupSource() });
  assert.equal(sameNativeIoReceipt(startup, receipt({ source: startupSource() })), true);
});
