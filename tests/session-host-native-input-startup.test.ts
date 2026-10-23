import assert from "node:assert/strict";
import test from "node:test";

import {
  NATIVE_INPUT_RAW_FRAGMENT_BYTES,
  createNativeInputDecoder,
  createNativeInputEncoder,
  frameNativeInputBody,
  mintNativeViewerScopeToken,
  mintNativeViewerStartupScopeToken,
  parseNativeViewerScopeToken,
  parseNativeViewerStartupScopeToken,
  verifyNativeViewerScopeToken,
  verifyNativeViewerStartupScopeToken,
  type NativeInputOrigin,
  type NativeViewerScopeFacts,
  type NativeViewerStartupScopeFacts,
} from "../src/session-host/native-input-origin";
import {
  SESSION_CONTENT_IMPLEMENTABLE_OPTIONAL_CAPABILITIES,
  SESSION_CONTENT_KNOWN_OPTIONAL_CAPABILITIES,
  SESSION_CONTENT_MAJOR,
  SESSION_CONTENT_MINOR,
  SESSION_CONTENT_NATIVE_INPUT_STARTUP_CAPABILITY,
  SESSION_CONTENT_NATIVE_IO_CAPABILITY,
  SESSION_CONTENT_REQUIRED_CAPABILITY,
  SESSION_CONTENT_SERVICE,
  decodeSessionContentFrame,
  encodeSessionContentFrame,
  isNativeIoStartupSource,
  negotiateSessionContentHello,
  nativeIoSourceEquals,
  reviewSessionContentHelloAck,
  type NativeIoSource,
  type NativeIoStartupSource,
  type SessionContentFrame,
} from "../src/session-host/network/session-content-protocol";
import { __test as clipboardTest, armNativeClipboardStartup } from "../src/session-host/native-clipboard";
import type { SessionHostBootstrap } from "../src/session-host/protocol";
import type { TerminalInputModes } from "../src/session-host/terminal-surface";

/**
 * Focused source regressions for startup-phase native input (issue 389): the
 * authenticated codec fence, the separate startup token domain, and the optional
 * wire capability and its coherence rules. Pure, in-process, no PTY or socket.
 */

const BOOTSTRAP = {
  version: 1,
  socketPath: "/nonexistent/startup-test.sock",
  token: "ab".repeat(32),
  instanceId: "0a1b2c3d-0000-4000-8000-00000000aaaa",
  generation: "0a1b2c3d-0000-4000-8000-00000000bbbb",
} as unknown as SessionHostBootstrap;

const VIEWER: NativeInputOrigin = Object.freeze({ kind: "viewer", token: "nvst1.viewer-1.0123456789abcdef0123456789abcdef" });
const LOCAL: NativeInputOrigin = Object.freeze({ kind: "local" });
const NONE: NativeInputOrigin = Object.freeze({ kind: "none" });
const TUPLE = Object.freeze({ sessionId: "conversation-a", epoch: 1 });
const STARTUP = Object.freeze({ phase: "startup" as const });

/** One canonical authenticated frame for a hand-built body (key order is the caller's). */
function frameBody(body: Record<string, unknown>): string {
  return frameNativeInputBody(BOOTSTRAP, Buffer.from(JSON.stringify(body), "utf8").toString("base64url"));
}

function body(fields: {
  sequence: number;
  dispatchId: number;
  part: number;
  final: boolean;
  origin: NativeInputOrigin;
  fence?: Record<string, unknown>;
  payload: string;
}): Record<string, unknown> {
  return {
    v: 1,
    instanceId: (BOOTSTRAP as unknown as { instanceId: string }).instanceId,
    generation: (BOOTSTRAP as unknown as { generation: string }).generation,
    sequence: fields.sequence,
    dispatchId: fields.dispatchId,
    part: fields.part,
    final: fields.final,
    origin: fields.origin,
    ...(fields.fence ?? {}),
    encoded: Buffer.from(fields.payload, "utf8").toString("base64url"),
  };
}

test("codec: a startup-fenced viewer dispatch round-trips with exactly the phase fence on every part", () => {
  const encoder = createNativeInputEncoder(BOOTSTRAP);
  const decoder = createNativeInputDecoder(BOOTSTRAP);
  const payload = Buffer.alloc(NATIVE_INPUT_RAW_FRAGMENT_BYTES * 2 + 7, 0x61);
  const fed = decoder.feed(encoder.encode(payload, VIEWER, STARTUP));
  assert.equal(fed.ok, true);
  assert.equal(fed.fragments.length, 3);
  for (const fragment of fed.fragments) {
    assert.equal(fragment.expectedNativePhase, "startup");
    assert.equal(fragment.expectedNativeTuple, undefined);
    assert.equal(fragment.origin.kind, "viewer");
  }
  assert.equal(Buffer.concat(fed.fragments.map((fragment) => fragment.payload)).equals(payload), true);
  // The ordinary tuple path is unchanged and carries no phase.
  const tupled = decoder.feed(encoder.encode(Buffer.from("x"), VIEWER, TUPLE));
  assert.equal(tupled.ok, true);
  assert.deepEqual(tupled.fragments[0]!.expectedNativeTuple, TUPLE);
  assert.equal(tupled.fragments[0]!.expectedNativePhase, undefined);
  // local/none carry neither fence.
  for (const origin of [LOCAL, NONE]) {
    const plain = decoder.feed(encoder.encode(Buffer.from("y"), origin));
    assert.equal(plain.ok, true);
    assert.equal(plain.fragments[0]!.expectedNativeTuple, undefined);
    assert.equal(plain.fragments[0]!.expectedNativePhase, undefined);
  }
});

test("codec: exactly one fence for viewer, none for local/none, and only the closed startup phase", () => {
  const encoder = createNativeInputEncoder(BOOTSTRAP);
  const bytes = Buffer.from("z");
  assert.throws(() => encoder.encode(bytes, VIEWER));
  assert.throws(() => encoder.encode(bytes, LOCAL, STARTUP));
  assert.throws(() => encoder.encode(bytes, NONE, STARTUP));
  assert.throws(() => encoder.encode(bytes, LOCAL, TUPLE));
  assert.throws(() => encoder.encode(bytes, VIEWER, { phase: "conversation" } as unknown as typeof STARTUP));
  assert.throws(() => encoder.encode(bytes, VIEWER, { phase: "startup", extra: 1 } as unknown as typeof STARTUP));
  assert.throws(() => encoder.encode(bytes, VIEWER, { ...TUPLE, phase: "startup" } as unknown as typeof STARTUP));
});

test("codec: mixed, unknown, and swapped fences are refused by the authenticated decoder", () => {
  const both = createNativeInputDecoder(BOOTSTRAP).feed(frameBody({
    v: 1,
    instanceId: (BOOTSTRAP as unknown as { instanceId: string }).instanceId,
    generation: (BOOTSTRAP as unknown as { generation: string }).generation,
    sequence: 1, dispatchId: 1, part: 0, final: true, origin: VIEWER,
    expectedNativeTuple: TUPLE, expectedNativePhase: "startup",
    encoded: Buffer.from("a").toString("base64url"),
  }));
  assert.equal(both.ok, false);

  const unknownPhase = createNativeInputDecoder(BOOTSTRAP).feed(frameBody(body({
    sequence: 1, dispatchId: 1, part: 0, final: true, origin: VIEWER,
    fence: { expectedNativePhase: "conversation" }, payload: "a",
  })));
  assert.deepEqual(unknownPhase.ok ? "ok" : unknownPhase.code, "malformed-frame");

  const localWithPhase = createNativeInputDecoder(BOOTSTRAP).feed(frameBody(body({
    sequence: 1, dispatchId: 1, part: 0, final: true, origin: LOCAL,
    fence: { expectedNativePhase: "startup" }, payload: "a",
  })));
  assert.deepEqual(localWithPhase.ok ? "ok" : localWithPhase.code, "invalid-origin");

  const swap = createNativeInputDecoder(BOOTSTRAP).feed(
    frameBody(body({
      sequence: 1, dispatchId: 1, part: 0, final: false, origin: VIEWER,
      fence: { expectedNativePhase: "startup" }, payload: "a",
    }))
    + frameBody(body({
      sequence: 2, dispatchId: 1, part: 1, final: true, origin: VIEWER,
      fence: { expectedNativeTuple: TUPLE }, payload: "b",
    })),
  );
  assert.equal(swap.ok, false);
  assert.equal(swap.ok ? "ok" : swap.code, "invalid-dispatch");
  assert.equal(swap.fragments.length, 1, "only the first, already authenticated part was decoded");
});

/* ------------------------------------------------------------------------- *
 * Child bridge: the strict framed stdin with the startup phase
 * ------------------------------------------------------------------------- */

/** Split one encoder output into its individual authenticated frames. */
function framesOf(framed: string): string[] {
  return framed.split("\n").filter((line) => line.length > 0).map((line) => `${line}\n`);
}

const CHILD_TUPLE = Object.freeze({ sessionId: TUPLE.sessionId, sessionEpoch: TUPLE.epoch });

function childBridge(state: { open: boolean; tuple: { sessionId: string; sessionEpoch: number } | undefined }) {
  return clipboardTest.framedStdin({
    decoder: createNativeInputDecoder(BOOTSTRAP),
    currentTuple: () => state.tuple,
    startupOpen: () => state.open,
    maxViewerPayloadBytes: NATIVE_INPUT_RAW_FRAGMENT_BYTES * 4,
  });
}

test("child: an unarmed or closed startup phase refuses a startup dispatch whole and stays usable", () => {
  const encoder = createNativeInputEncoder(BOOTSTRAP);
  const state = { open: false, tuple: undefined as { sessionId: string; sessionEpoch: number } | undefined };
  const bridge = childBridge(state);
  bridge.feed(encoder.encode(Buffer.from("refused"), VIEWER, STARTUP));
  assert.deepEqual(bridge.delivered, [] as typeof bridge.delivered, "an unarmed phase delivers nothing");
  // The decoder is not poisoned: local input still streams.
  bridge.feed(encoder.encode(Buffer.from("local"), LOCAL));
  assert.equal(bridge.delivered.length, 1);
  assert.equal(bridge.delivered[0]!.chunk.toString(), "local");
  assert.deepEqual(bridge.delivered[0]!.origin, LOCAL);
  assert.equal(bridge.delivered[0]!.expectedNativePhase, undefined);
});

test("child: an open startup phase delivers one whole viewer dispatch exactly once, at its final fragment", () => {
  const encoder = createNativeInputEncoder(BOOTSTRAP);
  const state = { open: true, tuple: undefined as { sessionId: string; sessionEpoch: number } | undefined };
  const bridge = childBridge(state);
  const payload = Buffer.alloc(NATIVE_INPUT_RAW_FRAGMENT_BYTES * 2 + 5, 0x62);
  const frames = framesOf(encoder.encode(payload, VIEWER, STARTUP));
  assert.equal(frames.length, 3);
  bridge.feed(frames[0]!);
  bridge.feed(frames[1]!);
  assert.deepEqual(bridge.delivered, [] as typeof bridge.delivered, "no prefix ever reaches a native listener");
  bridge.feed(frames[2]!);
  assert.equal(bridge.delivered.length, 1, "exactly one emit for the whole dispatch");
  const delivery = bridge.delivered[0]!;
  assert.equal(Buffer.isBuffer(delivery.chunk) && delivery.chunk.equals(payload), true, "byte-exact, untruncated");
  assert.deepEqual(delivery.origin, VIEWER, "explicit viewer origin, never local");
  assert.equal(delivery.expectedNativePhase, "startup");
  assert.equal(delivery.expectedNativeTuple, undefined);
  assert.equal(delivery.capturedTuple, undefined, "no tuple is captured or fabricated for startup work");
});

test("child: any session update during assembly discards the whole startup dispatch, even A to B to A", () => {
  const encoder = createNativeInputEncoder(BOOTSTRAP);
  const state = { open: true, tuple: undefined as { sessionId: string; sessionEpoch: number } | undefined };
  const bridge = childBridge(state);
  const payload = Buffer.alloc(NATIVE_INPUT_RAW_FRAGMENT_BYTES * 2 + 1, 0x63);
  const frames = framesOf(encoder.encode(payload, VIEWER, STARTUP));
  bridge.feed(frames[0]!);
  // setSession(undefined) closes the phase and notifies the pending dispatch.
  state.open = false;
  bridge.onTupleChange();
  // Even if the fence read "open" again, the latched refusal holds (A -> B -> A).
  state.open = true;
  bridge.feed(frames[1]!);
  bridge.feed(frames[2]!);
  assert.deepEqual(bridge.delivered, [] as typeof bridge.delivered, "the interrupted startup dispatch is never delivered");

  // The next dispatch is not poisoned: a fresh startup dispatch while open delivers.
  bridge.feed(encoder.encode(Buffer.from("next"), VIEWER, STARTUP));
  assert.equal(bridge.delivered.length, 1);
  assert.equal(bridge.delivered[0]!.chunk.toString(), "next");

  // The fence is re-checked immediately before the single emit, without any hook.
  const late = framesOf(encoder.encode(Buffer.alloc(NATIVE_INPUT_RAW_FRAGMENT_BYTES + 1, 0x64), VIEWER, STARTUP));
  bridge.feed(late[0]!);
  state.open = false;
  bridge.feed(late[1]!);
  assert.equal(bridge.delivered.length, 1, "a phase closed before the final fragment delivers nothing");

  // Once closed, a conversation tuple dispatch and local input are unchanged.
  state.tuple = CHILD_TUPLE;
  bridge.feed(encoder.encode(Buffer.from("tuple"), VIEWER, TUPLE));
  bridge.feed(encoder.encode(Buffer.from("local"), LOCAL));
  assert.deepEqual(bridge.delivered.slice(1).map((entry) => entry.chunk.toString()), ["tuple", "local"]);
  assert.deepEqual(bridge.delivered[1]!.expectedNativeTuple, TUPLE);
  assert.equal(bridge.delivered[1]!.expectedNativePhase, undefined);
  // A stale startup dispatch after the tuple exists is still refused.
  bridge.feed(encoder.encode(Buffer.from("stale"), VIEWER, STARTUP));
  assert.equal(bridge.delivered.length, 3);
});

test("child: arming without an installed bridge is an inert no-op", () => {
  assert.doesNotThrow(() => armNativeClipboardStartup());
});

const STARTUP_FACTS: NativeViewerStartupScopeFacts = Object.freeze({
  hostRunId: "run-1",
  viewerId: "viewer-1",
  viewerRevision: 2,
  rowId: "row-1",
  registrationIdentity: "0a1b2c3d-0000-4000-8000-00000000aaaa",
  registrationGeneration: "0a1b2c3d-0000-4000-8000-00000000bbbb",
  cols: 80,
  rows: 24,
  geometryRevision: 3,
});

const CONVERSATION_FACTS: NativeViewerScopeFacts = Object.freeze({
  hostRunId: STARTUP_FACTS.hostRunId,
  viewerId: STARTUP_FACTS.viewerId,
  viewerRevision: STARTUP_FACTS.viewerRevision,
  rowId: STARTUP_FACTS.rowId,
  registrationIdentity: STARTUP_FACTS.registrationIdentity,
  registrationGeneration: STARTUP_FACTS.registrationGeneration,
  nativeSessionId: "conversation-a",
  nativeSessionEpoch: 1,
  cols: STARTUP_FACTS.cols,
  rows: STARTUP_FACTS.rows,
  geometryRevision: STARTUP_FACTS.geometryRevision,
});

test("tokens: nvst1 is a separate commitment domain that never parses or verifies as nvs1", () => {
  const startup = mintNativeViewerStartupScopeToken(BOOTSTRAP, STARTUP_FACTS);
  const conversation = mintNativeViewerScopeToken(BOOTSTRAP, CONVERSATION_FACTS);
  assert.ok(startup);
  assert.ok(conversation);
  assert.match(startup, /^nvst1\.viewer-1\.[0-9a-f]{32}$/);
  assert.match(conversation, /^nvs1\.viewer-1\.[0-9a-f]{32}$/);
  assert.equal(parseNativeViewerScopeToken(startup), undefined, "the copy router cannot parse a startup token");
  assert.equal(parseNativeViewerStartupScopeToken(conversation), undefined);
  assert.equal(verifyNativeViewerScopeToken(BOOTSTRAP, startup, CONVERSATION_FACTS), false);
  assert.equal(verifyNativeViewerStartupScopeToken(BOOTSTRAP, conversation, STARTUP_FACTS), false);
  assert.equal(verifyNativeViewerStartupScopeToken(BOOTSTRAP, startup, STARTUP_FACTS), true);
  const changes: Array<Partial<NativeViewerStartupScopeFacts>> = [
    { hostRunId: "run-2" }, { viewerRevision: 3 }, { rowId: "row-2" },
    { cols: 81 }, { rows: 25 }, { geometryRevision: 4 },
  ];
  for (const change of changes) {
    assert.equal(verifyNativeViewerStartupScopeToken(BOOTSTRAP, startup, { ...STARTUP_FACTS, ...change }), false,
      `changing ${Object.keys(change).join(",")} invalidates the startup commitment`);
  }
  // A foreign registration generation mints and verifies nothing.
  assert.equal(mintNativeViewerStartupScopeToken(BOOTSTRAP, { ...STARTUP_FACTS, registrationGeneration: "ffff" }), undefined);
});

test("wire: startup input is negotiated only beside native IO and acknowledged coherently", () => {
  assert.deepEqual([...SESSION_CONTENT_KNOWN_OPTIONAL_CAPABILITIES], [], "nothing is negotiated without an opt-in");
  assert.equal(SESSION_CONTENT_IMPLEMENTABLE_OPTIONAL_CAPABILITIES.includes(SESSION_CONTENT_NATIVE_INPUT_STARTUP_CAPABILITY), true);
  const hello = (capabilities: string[]) => ({
    type: "hello" as const, service: SESSION_CONTENT_SERVICE, major: SESSION_CONTENT_MAJOR,
    minor: SESSION_CONTENT_MINOR, capabilities,
  });
  const both = { supportedOptionalCapabilities: [SESSION_CONTENT_NATIVE_IO_CAPABILITY, SESSION_CONTENT_NATIVE_INPUT_STARTUP_CAPABILITY] };
  const full = negotiateSessionContentHello(hello([SESSION_CONTENT_REQUIRED_CAPABILITY, SESSION_CONTENT_NATIVE_IO_CAPABILITY,
    SESSION_CONTENT_NATIVE_INPUT_STARTUP_CAPABILITY]), both);
  assert.equal(full.ok, true);
  assert.deepEqual(full.ok ? [...full.capabilities] : [],
    [SESSION_CONTENT_NATIVE_IO_CAPABILITY, SESSION_CONTENT_NATIVE_INPUT_STARTUP_CAPABILITY]);
  const startupOnly = negotiateSessionContentHello(hello([SESSION_CONTENT_REQUIRED_CAPABILITY,
    SESSION_CONTENT_NATIVE_INPUT_STARTUP_CAPABILITY]), both);
  assert.deepEqual(startupOnly.ok ? [...startupOnly.capabilities] : null, [], "startup is never acknowledged alone");
  const legacyPeer = negotiateSessionContentHello(hello([SESSION_CONTENT_REQUIRED_CAPABILITY, SESSION_CONTENT_NATIVE_IO_CAPABILITY]), both);
  assert.deepEqual(legacyPeer.ok ? [...legacyPeer.capabilities] : null, [SESSION_CONTENT_NATIVE_IO_CAPABILITY]);
  const legacyOwner = negotiateSessionContentHello(hello([SESSION_CONTENT_REQUIRED_CAPABILITY, SESSION_CONTENT_NATIVE_IO_CAPABILITY,
    SESSION_CONTENT_NATIVE_INPUT_STARTUP_CAPABILITY]), { supportedOptionalCapabilities: [SESSION_CONTENT_NATIVE_IO_CAPABILITY] });
  assert.deepEqual(legacyOwner.ok ? [...legacyOwner.capabilities] : null, [SESSION_CONTENT_NATIVE_IO_CAPABILITY]);
  assert.throws(() => negotiateSessionContentHello(hello([SESSION_CONTENT_REQUIRED_CAPABILITY]),
    { supportedOptionalCapabilities: [SESSION_CONTENT_NATIVE_INPUT_STARTUP_CAPABILITY] }));

  const offered = { capabilities: [SESSION_CONTENT_REQUIRED_CAPABILITY, SESSION_CONTENT_NATIVE_IO_CAPABILITY,
    SESSION_CONTENT_NATIVE_INPUT_STARTUP_CAPABILITY] };
  const ack = (capabilities: string[]) => ({
    type: "hello_ack" as const, service: SESSION_CONTENT_SERVICE, major: SESSION_CONTENT_MAJOR,
    minor: SESSION_CONTENT_MINOR, capabilities,
  });
  assert.equal(reviewSessionContentHelloAck(ack([...offered.capabilities]), offered).ok, true);
  assert.equal(reviewSessionContentHelloAck(ack([SESSION_CONTENT_REQUIRED_CAPABILITY, SESSION_CONTENT_NATIVE_IO_CAPABILITY]), offered).ok, true,
    "an older owner that acknowledges native IO alone stays valid");
  const startupWithoutIo = reviewSessionContentHelloAck(
    ack([SESSION_CONTENT_REQUIRED_CAPABILITY, SESSION_CONTENT_NATIVE_INPUT_STARTUP_CAPABILITY]), offered);
  assert.deepEqual(startupWithoutIo.ok ? "ok" : startupWithoutIo.code, "protocol_violation");
});

const MODES: TerminalInputModes = Object.freeze({
  kittyFlags: 0, applicationCursorKeys: false, applicationKeypad: false, bracketedPaste: false,
  mouseTracking: "none", modifyOtherKeys: 0, mouseEncoding: "default",
});
const GEOMETRY = Object.freeze({ cols: 80, rows: 24, revision: 3 });
const STARTUP_SOURCE: NativeIoStartupSource = Object.freeze({
  hostRunId: "run-1", sessionId: "row-1", phase: "startup", geometry: GEOMETRY, viewerRevision: 2,
  sourceToken: "nvst1.viewer-1.0123456789abcdef0123456789abcdef",
});
const CONVERSATION_SOURCE: NativeIoSource = Object.freeze({
  hostRunId: "run-1", sessionId: "row-1", nativeSession: Object.freeze({ sessionId: "conversation-a", epoch: 1 }),
  geometry: GEOMETRY, viewerRevision: 2, sourceToken: "nvs1.viewer-1.0123456789abcdef0123456789abcdef",
});

function beginFrame(nativeSession: { sessionId: string; epoch: number } | null, inputSource: unknown): SessionContentFrame {
  return {
    type: "content_begin", subscriptionId: "sub-1", transferId: "tr-1", hostRunId: "run-1", sessionId: "row-1",
    nativeSession, sequence: 1, geometry: GEOMETRY, inputModes: MODES, byteLength: 1, chunkCount: 1,
    inputSource,
  } as unknown as SessionContentFrame;
}

test("wire: a startup source is input-only, tuple-free, and coherent only with a null-tuple publish", () => {
  const input = decodeSessionContentFrame(encodeSessionContentFrame({
    type: "input", subscriptionId: "sub-1", inputId: "in-1", ordinal: 1, source: STARTUP_SOURCE,
    inputModes: MODES, kind: "keyboard", data: Buffer.from("\x1b").toString("base64"),
  }));
  assert.equal(input.type, "input");
  if (input.type !== "input") return;
  assert.equal(isNativeIoStartupSource(input.source), true);
  assert.equal(Object.hasOwn(input.source, "nativeSession"), false);
  assert.equal(nativeIoSourceEquals(input.source, STARTUP_SOURCE), true);
  assert.equal(nativeIoSourceEquals(STARTUP_SOURCE, CONVERSATION_SOURCE), false);

  // A startup source with a (null or real) tuple key is not a startup source.
  assert.throws(() => encodeSessionContentFrame({
    type: "input", subscriptionId: "sub-1", inputId: "in-2", ordinal: 2,
    source: { ...STARTUP_SOURCE, nativeSession: null } as unknown as NativeIoStartupSource,
    inputModes: MODES, kind: "keyboard", data: Buffer.from("a").toString("base64"),
  }));
  // Copy frames never carry a startup source.
  assert.throws(() => encodeSessionContentFrame({
    type: "copy_begin", subscriptionId: "sub-1", copyId: "c-1", sequence: 1,
    source: STARTUP_SOURCE as unknown as NativeIoSource, dispatchId: 1, byteLength: 4, chunkCount: 1,
  }));

  assert.doesNotThrow(() => encodeSessionContentFrame(beginFrame(null, STARTUP_SOURCE)));
  assert.throws(() => encodeSessionContentFrame(beginFrame({ sessionId: "conversation-a", epoch: 1 }, STARTUP_SOURCE)));
  assert.throws(() => encodeSessionContentFrame(beginFrame(null, CONVERSATION_SOURCE)));
  assert.throws(() => encodeSessionContentFrame(beginFrame(null, { ...STARTUP_SOURCE, geometry: { ...GEOMETRY, revision: 4 } })));
});
