import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test from "node:test";

import {
  mintNativeViewerNativeCliScopeToken,
  mintNativeViewerScopeToken,
  mintNativeViewerStartupScopeToken,
  parseNativeViewerNativeCliScopeToken,
  parseNativeViewerScopeToken,
  parseNativeViewerStartupScopeToken,
  verifyNativeViewerNativeCliScopeToken,
  verifyNativeViewerScopeToken,
  verifyNativeViewerStartupScopeToken,
  type NativeViewerNativeCliScopeFacts,
} from "../src/session-host/native-input-origin";
import type { SessionHostBootstrap } from "../src/session-host/protocol";
import {
  readRemoteInputModes,
  readRemoteNativeIoSource,
  sameNativeIoReceipt,
  type WrittenRemoteNativeInput,
} from "../src/session-host/remote-native-input";
import {
  DEFAULT_SESSION_CONTENT_BOUNDS,
  SESSION_CONTENT_IMPLEMENTABLE_OPTIONAL_CAPABILITIES,
  SESSION_CONTENT_KNOWN_OPTIONAL_CAPABILITIES,
  SESSION_CONTENT_MAJOR,
  SESSION_CONTENT_MINOR,
  SESSION_CONTENT_NATIVE_INPUT_CLI_CAPABILITY,
  SESSION_CONTENT_NATIVE_INPUT_STARTUP_CAPABILITY,
  SESSION_CONTENT_NATIVE_IO_CAPABILITY,
  SESSION_CONTENT_REQUIRED_CAPABILITY,
  SESSION_CONTENT_SERVICE,
  buildNativeInputInline,
  decodeSessionContentFrame,
  encodeSessionContentFrame,
  isNativeIoNativeCliSource,
  isNativeIoStartupSource,
  nativeIoSourceEquals,
  negotiateSessionContentHello,
  reviewSessionContentHelloAck,
  type NativeIoInputSource,
  type NativeIoNativeCliSource,
  type SessionContentFrame,
  type SessionContentHelloAckFrame,
  type SessionContentHelloFrame,
} from "../src/session-host/network/session-content-protocol";

/**
 * Focused source, codec, capability, and receipt coverage for the native remote
 * input slice (issue 277): the separate `native-cli` input source, its own
 * process-incarnation commitment domain, and the optional
 * `native-input-cli-v1` content-lane capability.
 *
 * Pure and in-process: no PTY, no transport, no provider binary, no product
 * state. The manager tier lives in `session-host-native-cli-input.test.ts`; the
 * endpoint tier lives in `session-host-native-cli-content-lane.test.ts`.
 */

/* ------------------------------------------------------------------------- *
 * The `nvcli1` scope family: a separate domain under an owner-private key
 * ------------------------------------------------------------------------- */

const BOOTSTRAP = {
  version: 1,
  socketPath: "/nonexistent/native-cli-test.sock",
  token: "cd".repeat(32),
  instanceId: "0a1b2c3d-0000-4000-8000-00000000aaaa",
  generation: "0a1b2c3d-0000-4000-8000-00000000bbbb",
} as unknown as SessionHostBootstrap;

const SECRET = randomBytes(32);
const OTHER_SECRET = randomBytes(32);

const FACTS: NativeViewerNativeCliScopeFacts = Object.freeze({
  hostRunId: "run-1",
  viewerId: "viewer-1",
  viewerRevision: 2,
  rowId: "row-1",
  backend: "claude",
  cols: 80,
  rows: 24,
  geometryRevision: 3,
});

test("the native CLI scope token is its own domain and never parses or verifies as a Pi scope", () => {
  const token = mintNativeViewerNativeCliScopeToken(SECRET, FACTS);
  assert.ok(token);
  assert.match(token, /^nvcli1\.viewer-1\.[0-9a-f]{32}$/);
  assert.equal(verifyNativeViewerNativeCliScopeToken(SECRET, token, FACTS), true);

  // The two Pi families and this one are mutually unparseable, so no Pi copy router
  // or Pi startup fence can ever be addressed by a hosted provider token.
  assert.equal(parseNativeViewerScopeToken(token), undefined);
  assert.equal(parseNativeViewerStartupScopeToken(token), undefined);
  assert.equal(parseNativeViewerNativeCliScopeToken("nvs1.viewer-1." + "0".repeat(32)), undefined);
  assert.equal(parseNativeViewerNativeCliScopeToken("nvst1.viewer-1." + "0".repeat(32)), undefined);
  assert.equal(verifyNativeViewerScopeToken(BOOTSTRAP, token, {
    hostRunId: FACTS.hostRunId,
    viewerId: FACTS.viewerId,
    viewerRevision: FACTS.viewerRevision,
    rowId: FACTS.rowId,
    registrationIdentity: (BOOTSTRAP as unknown as { instanceId: string }).instanceId,
    registrationGeneration: (BOOTSTRAP as unknown as { generation: string }).generation,
    nativeSessionId: "conversation-a",
    nativeSessionEpoch: 1,
    cols: FACTS.cols,
    rows: FACTS.rows,
    geometryRevision: FACTS.geometryRevision,
  }), false);
  assert.equal(verifyNativeViewerStartupScopeToken(BOOTSTRAP, token, {
    hostRunId: FACTS.hostRunId,
    viewerId: FACTS.viewerId,
    viewerRevision: FACTS.viewerRevision,
    rowId: FACTS.rowId,
    registrationIdentity: (BOOTSTRAP as unknown as { instanceId: string }).instanceId,
    registrationGeneration: (BOOTSTRAP as unknown as { generation: string }).generation,
    cols: FACTS.cols,
    rows: FACTS.rows,
    geometryRevision: FACTS.geometryRevision,
  }), false);
});

test("the incarnation key is the process fact: a replaced child invalidates every identical public fact", () => {
  const first = mintNativeViewerNativeCliScopeToken(SECRET, FACTS);
  const second = mintNativeViewerNativeCliScopeToken(OTHER_SECRET, FACTS);
  assert.ok(first && second);
  assert.notEqual(first, second, "the same facts under a different incarnation commit differently");
  assert.equal(verifyNativeViewerNativeCliScopeToken(SECRET, first, FACTS), true);
  assert.equal(verifyNativeViewerNativeCliScopeToken(OTHER_SECRET, first, FACTS), false);
  assert.equal(verifyNativeViewerNativeCliScopeToken(SECRET, second, FACTS), false);
  // Malformed key material mints and verifies nothing rather than falling back.
  assert.equal(mintNativeViewerNativeCliScopeToken(randomBytes(8), FACTS), undefined);
  assert.equal(verifyNativeViewerNativeCliScopeToken("not-a-buffer" as unknown as Buffer, first, FACTS), false);
});

test("every native CLI fact is part of the commitment, including the backend", () => {
  const token = mintNativeViewerNativeCliScopeToken(SECRET, FACTS);
  assert.ok(token);
  const changes: Array<Partial<NativeViewerNativeCliScopeFacts>> = [
    { hostRunId: "run-2" },
    { viewerRevision: 3 },
    { rowId: "row-2" },
    { backend: "codex" },
    { cols: 81 },
    { rows: 25 },
    { geometryRevision: 4 },
  ];
  for (const change of changes) {
    assert.equal(verifyNativeViewerNativeCliScopeToken(SECRET, token, { ...FACTS, ...change }), false,
      `changing ${Object.keys(change).join(",")} invalidates the native CLI commitment`);
  }
  // A different viewer handle in the token never names another surface.
  assert.equal(verifyNativeViewerNativeCliScopeToken(SECRET, token, { ...FACTS, viewerId: "viewer-2" }), false);
});

test("malformed native CLI facts mint and verify nothing", () => {
  const bad: unknown[] = [
    { ...FACTS, backend: "pi" },
    { ...FACTS, backend: undefined },
    { ...FACTS, nativeSession: null },
    { ...FACTS, registrationIdentity: "x" },
    { ...FACTS, viewerRevision: 0.5 },
    { ...FACTS, cols: 0 },
    { ...FACTS, geometryRevision: -1 },
    { ...FACTS, viewerId: "" },
    null,
    "nvcli1",
  ];
  for (const facts of bad) {
    assert.equal(mintNativeViewerNativeCliScopeToken(SECRET, facts as NativeViewerNativeCliScopeFacts), undefined);
    assert.equal(verifyNativeViewerNativeCliScopeToken(SECRET, "nvcli1.viewer-1." + "0".repeat(32), facts as NativeViewerNativeCliScopeFacts), false);
  }
});

/* ------------------------------------------------------------------------- *
 * The optional capability
 * ------------------------------------------------------------------------- */

function hello(capabilities: readonly string[]): SessionContentHelloFrame {
  return { type: "hello", service: SESSION_CONTENT_SERVICE, major: SESSION_CONTENT_MAJOR, minor: SESSION_CONTENT_MINOR, capabilities };
}

function ack(capabilities: readonly string[]): SessionContentHelloAckFrame {
  return { type: "hello_ack", service: SESSION_CONTENT_SERVICE, major: SESSION_CONTENT_MAJOR, minor: SESSION_CONTENT_MINOR, capabilities };
}

const ALL_IO = [SESSION_CONTENT_REQUIRED_CAPABILITY, SESSION_CONTENT_NATIVE_IO_CAPABILITY,
  SESSION_CONTENT_NATIVE_INPUT_STARTUP_CAPABILITY, SESSION_CONTENT_NATIVE_INPUT_CLI_CAPABILITY];

test("the capability is implementable but never known, so nothing is negotiated without an opt-in", () => {
  assert.deepEqual([...SESSION_CONTENT_KNOWN_OPTIONAL_CAPABILITIES], []);
  assert.equal(SESSION_CONTENT_IMPLEMENTABLE_OPTIONAL_CAPABILITIES.includes(SESSION_CONTENT_NATIVE_INPUT_CLI_CAPABILITY), true);
  const baseline = negotiateSessionContentHello(hello([SESSION_CONTENT_REQUIRED_CAPABILITY]));
  assert.equal(baseline.ok && baseline.capabilities.length === 0, true,
    "the default decision acknowledges the required capability alone");
  const noOptIn = negotiateSessionContentHello(hello(ALL_IO));
  assert.equal(noOptIn.ok && noOptIn.capabilities.length === 0, true,
    "a peer offering the identifier is never an acknowledgement of it");
});

test("native CLI input negotiates only beside native IO on both sides", () => {
  const withAll = negotiateSessionContentHello(hello(ALL_IO), {
    supportedOptionalCapabilities: [
      SESSION_CONTENT_NATIVE_IO_CAPABILITY,
      SESSION_CONTENT_NATIVE_INPUT_STARTUP_CAPABILITY,
      SESSION_CONTENT_NATIVE_INPUT_CLI_CAPABILITY,
    ],
  });
  assert.equal(withAll.ok, true);
  assert.equal(withAll.ok && withAll.capabilities.includes(SESSION_CONTENT_NATIVE_INPUT_CLI_CAPABILITY), true);

  // Offering it without native IO yields nothing (never a partial extension).
  const noNativeIo = negotiateSessionContentHello(hello([
    SESSION_CONTENT_REQUIRED_CAPABILITY, SESSION_CONTENT_NATIVE_INPUT_CLI_CAPABILITY,
  ]), { supportedOptionalCapabilities: [SESSION_CONTENT_NATIVE_INPUT_CLI_CAPABILITY, SESSION_CONTENT_NATIVE_IO_CAPABILITY] });
  assert.equal(noNativeIo.ok, true);
  assert.equal(noNativeIo.ok && noNativeIo.capabilities.includes(SESSION_CONTENT_NATIVE_INPUT_CLI_CAPABILITY), false);

  // Enabling it alone is a malformed opt-in, refused rather than silently narrowed.
  assert.throws(() => negotiateSessionContentHello(hello(ALL_IO), {
    supportedOptionalCapabilities: [SESSION_CONTENT_NATIVE_INPUT_CLI_CAPABILITY],
  }));

  // Viewer side: an acknowledgement of it without native IO, or one this side never
  // offered, is a protocol violation.
  const offered = { capabilities: [SESSION_CONTENT_REQUIRED_CAPABILITY, SESSION_CONTENT_NATIVE_IO_CAPABILITY] };
  assert.deepEqual(reviewSessionContentHelloAck(ack([
    SESSION_CONTENT_REQUIRED_CAPABILITY, SESSION_CONTENT_NATIVE_IO_CAPABILITY, SESSION_CONTENT_NATIVE_INPUT_CLI_CAPABILITY,
  ]), offered), { ok: false, code: "protocol_violation" });
  assert.deepEqual(reviewSessionContentHelloAck(ack([
    SESSION_CONTENT_REQUIRED_CAPABILITY, SESSION_CONTENT_NATIVE_INPUT_CLI_CAPABILITY,
  ]), { capabilities: [SESSION_CONTENT_REQUIRED_CAPABILITY] }), { ok: false, code: "protocol_violation" });
  const both = { capabilities: ALL_IO };
  assert.equal(reviewSessionContentHelloAck(ack(ALL_IO), both).ok, true);
});

/* ------------------------------------------------------------------------- *
 * Wire codecs
 * ------------------------------------------------------------------------- */

const GEOMETRY = Object.freeze({ cols: 80, rows: 24, revision: 3 });
const MODES = Object.freeze({
  kittyFlags: 0,
  applicationCursorKeys: false,
  applicationKeypad: false,
  bracketedPaste: true,
  mouseTracking: "none" as const,
  modifyOtherKeys: 0 as const,
  mouseEncoding: "default" as const,
});

function nativeCliWire(overrides: Partial<NativeIoNativeCliSource> = {}): NativeIoNativeCliSource {
  return {
    hostRunId: "run-1",
    sessionId: "row-1",
    phase: "native-cli",
    backend: "claude",
    geometry: { ...GEOMETRY },
    viewerRevision: 2,
    sourceToken: "nvcli1.viewer-1." + "ab".repeat(16),
    ...overrides,
  };
}

function decodeRoundTrip(frame: SessionContentFrame): SessionContentFrame {
  return decodeSessionContentFrame(encodeSessionContentFrame(frame), DEFAULT_SESSION_CONTENT_BOUNDS);
}

test("an input frame carrying a native CLI source round-trips exactly", () => {
  const source = nativeCliWire();
  const built = buildNativeInputInline({
    subscriptionId: "sub-1",
    inputId: "input-1",
    ordinal: 1,
    source,
    inputModes: MODES,
    kind: "keyboard",
    data: "a",
  });
  assert.equal(built.frames.length, 1, "one keyboard packet is one inline frame");
  const decoded = decodeSessionContentFrame(built.frames[0]!, DEFAULT_SESSION_CONTENT_BOUNDS);
  assert.equal(decoded.type, "input");
  const first = decoded as Extract<SessionContentFrame, { type: "input" }>;
  assert.equal(first.inputId, "input-1");
  assert.equal(first.data, Buffer.from("a").toString("base64"));
  assert.equal(isNativeIoNativeCliSource(first.source), true);
  assert.equal(isNativeIoStartupSource(first.source), false);
  assert.deepEqual(first.source, source, "the native CLI source survives one encode/decode cycle unchanged");
});

test("a native CLI source is malformed with a tuple, a registration field, or a missing or unknown backend", () => {
  const base = nativeCliWire();
  const { backend: _omittedBackend, ...withoutBackend } = base;
  const withTuple = { ...base, nativeSession: null } as unknown as NativeIoNativeCliSource;
  const withRegistration = { ...base, registrationIdentity: "reg" } as unknown as NativeIoNativeCliSource;
  const piBackend = { ...base, backend: "pi" } as unknown as NativeIoNativeCliSource;
  const startupPhaseWithBackend = { ...base, phase: "startup" } as unknown as NativeIoNativeCliSource;
  const cases: unknown[] = [withTuple, withRegistration, withoutBackend, piBackend, startupPhaseWithBackend];
  for (const source of cases) {
    assert.throws(() => buildNativeInputInline({
      subscriptionId: "sub-1", inputId: "input-1", ordinal: 1,
      source: source as NativeIoInputSource, inputModes: MODES, kind: "keyboard", data: "a",
    }), "the builder refuses a source outside the closed native CLI shape");
  }
});

test("a copy frame can never carry a native CLI source", () => {
  // The copy codec reads only the conversation shape, so a native CLI source is
  // malformed wire rather than a copy with an odd source.
  const frame = {
    type: "copy",
    subscriptionId: "sub-1",
    copyId: "copy-1",
    sequence: 1,
    source: nativeCliWire(),
    dispatchId: 1,
    event: { kind: "copy", encoded: Buffer.from("text").toString("base64"), sessionId: "conversation-a", sessionEpoch: 1 },
  } as unknown as SessionContentFrame;
  const bytes = Buffer.from(JSON.stringify(frame), "utf8");
  assert.throws(() => decodeSessionContentFrame(bytes, DEFAULT_SESSION_CONTENT_BOUNDS));
});

test("a publish states a native CLI source only for a viewport that names no conversation", () => {
  const begin = (nativeSession: { sessionId: string; epoch: number } | null, source: unknown): SessionContentFrame => ({
    type: "content_begin",
    subscriptionId: "sub-1",
    transferId: "transfer-1",
    hostRunId: "run-1",
    sessionId: "row-1",
    nativeSession,
    sequence: 1,
    geometry: { ...GEOMETRY },
    inputModes: MODES,
    inputSource: source,
    byteLength: 10,
    chunkCount: 1,
  } as SessionContentFrame);
  // Coherent: no tuple, this frame's own run, row, and geometry.
  assert.doesNotThrow(() => decodeRoundTrip(begin(null, nativeCliWire())));
  // Incoherent: a tuple-carrying publish never states a hosted provider source.
  assert.throws(() => decodeRoundTrip(begin({ sessionId: "conversation-a", epoch: 1 }, nativeCliWire())));
  // Incoherent: another row, another run, or another geometry revision.
  assert.throws(() => decodeRoundTrip(begin(null, nativeCliWire({ sessionId: "row-2" }))));
  assert.throws(() => decodeRoundTrip(begin(null, nativeCliWire({ hostRunId: "run-2" }))));
  assert.throws(() => decodeRoundTrip(begin(null, nativeCliWire({ geometry: { cols: 80, rows: 24, revision: 4 } }))));
});

test("native CLI source equality is variant-aware and backend-aware", () => {
  const source = nativeCliWire();
  const startup = {
    hostRunId: "run-1",
    sessionId: "row-1",
    phase: "startup" as const,
    geometry: { ...GEOMETRY },
    viewerRevision: 2,
    sourceToken: source.sourceToken,
  } satisfies NativeIoInputSource;
  const conversation = {
    hostRunId: "run-1",
    sessionId: "row-1",
    nativeSession: { sessionId: "conversation-a", epoch: 1 },
    geometry: { ...GEOMETRY },
    viewerRevision: 2,
    sourceToken: source.sourceToken,
  } satisfies NativeIoInputSource;
  assert.equal(nativeIoSourceEquals(source, { ...source }), true);
  assert.equal(nativeIoSourceEquals(source, nativeCliWire({ backend: "codex" })), false);
  assert.equal(nativeIoSourceEquals(source, startup), false);
  assert.equal(nativeIoSourceEquals(source, conversation), false);
  assert.equal(nativeIoSourceEquals(startup, conversation), false);
  // An A -> B -> A geometry return is not the original source: the revision differs.
  assert.equal(nativeIoSourceEquals(source, nativeCliWire({ geometry: { cols: 80, rows: 24, revision: 4 } })), false);
  assert.equal(nativeIoSourceEquals(source, nativeCliWire({ viewerRevision: 3 })), false);
});

/* ------------------------------------------------------------------------- *
 * The viewer's actual-written receipt
 * ------------------------------------------------------------------------- */

function receiptOf(source: NativeIoInputSource): WrittenRemoteNativeInput {
  return {
    hostId: "host-1",
    hostRunId: "run-1",
    rowId: "row-1",
    selectionGeneration: 4,
    subscriptionId: "sub-1",
    source,
    inputModes: MODES,
    geometry: { ...GEOMETRY },
    nativeContent: { column: 20, row: 1, cols: 80, rows: 24 },
    resizeEpoch: 2,
    policyGeneration: 6,
  };
}

test("the viewer accepts a coherent native CLI drawn source and rejects an incoherent one", () => {
  const expected = {
    hostRunId: "run-1",
    sessionId: "row-1",
    nativeSession: null,
    geometry: { cols: 80, rows: 24, revision: 3 },
  };
  const read = readRemoteNativeIoSource(nativeCliWire(), expected);
  assert.ok(read !== undefined);
  assert.equal(isNativeIoNativeCliSource(read), true);
  assert.equal((read as NativeIoNativeCliSource).backend, "claude");
  assert.deepEqual(Object.keys(read).sort(), [
    "backend", "geometry", "hostRunId", "phase", "sessionId", "sourceToken", "viewerRevision",
  ]);

  // A publish that names a conversation can never be described by this source.
  assert.equal(readRemoteNativeIoSource(nativeCliWire(), { ...expected, nativeSession: { sessionId: "a", epoch: 1 } }), undefined);
  // Unknown backend, a smuggled tuple, an unknown phase, a zero viewer revision, or
  // geometry that is not this publish's own.
  assert.equal(readRemoteNativeIoSource({ ...nativeCliWire(), backend: "pi" }, expected), undefined);
  assert.equal(readRemoteNativeIoSource({ ...nativeCliWire(), nativeSession: null }, expected), undefined);
  assert.equal(readRemoteNativeIoSource({ ...nativeCliWire(), phase: "other" }, expected), undefined);
  assert.equal(readRemoteNativeIoSource({ ...nativeCliWire(), viewerRevision: 0 }, expected), undefined);
  assert.equal(readRemoteNativeIoSource({ ...nativeCliWire(), geometry: { cols: 80, rows: 24, revision: 4 } }, expected), undefined);
  // The receipt keeps the closed fact set only: a stray key is never carried into a
  // later comparison or a later write.
  const withStray = readRemoteNativeIoSource({ ...nativeCliWire(), registrationGeneration: "g" }, expected);
  assert.ok(withStray !== undefined);
  assert.deepEqual(Object.keys(withStray).sort(), Object.keys(read).sort());
  assert.equal(Object.hasOwn(withStray, "registrationGeneration"), false);
});

test("written receipts keep claude, codex, startup, and conversation sources separate", () => {
  const claude = receiptOf(nativeCliWire());
  assert.equal(sameNativeIoReceipt(claude, receiptOf(nativeCliWire())), true);
  assert.equal(sameNativeIoReceipt(claude, receiptOf(nativeCliWire({ backend: "codex" }))), false);
  assert.equal(sameNativeIoReceipt(claude, receiptOf(nativeCliWire({ sourceToken: "nvcli1.viewer-1." + "0".repeat(32) }))), false);
  assert.equal(sameNativeIoReceipt(claude, receiptOf({
    hostRunId: "run-1", sessionId: "row-1", phase: "startup",
    geometry: { ...GEOMETRY }, viewerRevision: 2, sourceToken: nativeCliWire().sourceToken,
  })), false);
  assert.equal(sameNativeIoReceipt(claude, receiptOf({
    hostRunId: "run-1", sessionId: "row-1",
    nativeSession: { sessionId: "conversation-a", epoch: 1 },
    geometry: { ...GEOMETRY }, viewerRevision: 2, sourceToken: nativeCliWire().sourceToken,
  })), false);
  // The observed modes and the drawn rectangle remain part of the same proof.
  assert.equal(sameNativeIoReceipt(claude, { ...claude, inputModes: { ...MODES, bracketedPaste: false } }), false);
  assert.equal(sameNativeIoReceipt(claude, { ...claude, policyGeneration: 7 }), false);
  assert.equal(sameNativeIoReceipt(claude, { ...claude, resizeEpoch: 3 }), false);
  assert.deepEqual(readRemoteInputModes(MODES), MODES);
});
