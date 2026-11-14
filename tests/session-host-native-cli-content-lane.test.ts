import assert from "node:assert/strict";
import test from "node:test";

import type {
  NativeInstanceView,
  SessionGeometry,
  SessionViewerState,
  SessionViewerUpdate,
  SessionViewerUpdateResult,
} from "../src/session-host/instances";
import { isNativeViewerNativeCliInputSource } from "../src/session-host/instances";
import type {
  NativeViewerClipboardSink,
  NativeViewerInputRequest,
  NativeViewerInputResult,
  NativeViewerNativeCliClipboardReceipt,
  NativeViewerNativeCliInputSource,
  OwningHostInventorySnapshot,
  OwningHostSessionContentListener,
  OwningHostSessionContentSnapshot,
  OwningHostSessionContentWatch,
  OwningHostViewerOptions,
} from "../src/session-host/owning-host-service";
import type { TerminalFrame, TerminalInputModes } from "../src/session-host/terminal-surface";
import type { PeerByteChannel, PeerChannelClose } from "../src/session-host/network/channel";
import type { PeerKey } from "../src/session-host/network/identity";
import {
  createSessionContentHost,
  type SessionContentHostDiagnosticCode,
  type SessionContentSource,
} from "../src/session-host/network/session-content-host";
import {
  DEFAULT_SESSION_CONTENT_BOUNDS,
  SESSION_CONTENT_MAJOR,
  SESSION_CONTENT_MINOR,
  SESSION_CONTENT_NATIVE_INPUT_CLI_CAPABILITY,
  SESSION_CONTENT_NATIVE_COPY_CLI_CAPABILITY,
  SESSION_CONTENT_NATIVE_INPUT_STARTUP_CAPABILITY,
  SESSION_CONTENT_NATIVE_IO_CAPABILITY,
  SESSION_CONTENT_REQUIRED_CAPABILITY,
  SESSION_CONTENT_SERVICE,
  buildNativeInputInline,
  decodeSessionContentFrame,
  encodeSessionContentFrame,
  isNativeIoNativeCliSource,
  isNativeIoNativeCliCopyEvent,
  type NativeIoNativeCliSource,
  type SessionContentBounds,
  type SessionContentFrame,
  type SessionContentHelloFrame,
  type SessionContentSubscribeFrame,
} from "../src/session-host/network/session-content-protocol";

/**
 * Focused content-lane coverage for hosted native CLI input (issue 277 native
 * remote-input slice): what the owner endpoint publishes, what it accepts back,
 * and what it refuses.
 *
 * Everything is in-memory: a synthetic loopback content channel stands in for the
 * transport and a thin fake of the owning-host service stands in for the manager's
 * content watch, its per-surface scope, and its raw PTY handoff. No socket,
 * process, provider binary, or product state is touched. The assertions are about
 * observable safety: the capability is offered only beside native IO and only to a
 * peer that offered it; a tuple-less publish of a hosted row states the `native-cli`
 * source and nothing else; an echoed source is re-proved against the CURRENT owner
 * scope before the one raw handoff; and a channel that never negotiated this
 * variant treats it as a protocol violation and writes zero bytes.
 */

const RUN = "11111111-1111-4111-8111-111111111111";
const ROW = "row-native-1";
const PEER_KEY = { fingerprint: "AA:BB" } as unknown as PeerKey;

const MODES: TerminalInputModes = Object.freeze({
  kittyFlags: 0,
  applicationCursorKeys: false,
  applicationKeypad: false,
  bracketedPaste: true,
  mouseTracking: "none",
  modifyOtherKeys: 0,
  mouseEncoding: "default",
});

function revHex(revision: number): string {
  return revision.toString(16).padStart(4, "0").repeat(8).slice(0, 32);
}

function viewport(cols: number, rows: number): TerminalFrame {
  const lines: string[] = [];
  for (let row = 0; row < rows; row += 1) lines.push(`\x1b[0mrow ${row}\x1b[0m`);
  return { cols, rows, lines, cursor: { column: 0, row: 0, visible: true } };
}

/** The loopback content channel: it records writes and delivers inbound bytes. */
class ContentChannel implements PeerByteChannel {
  readonly peerKey = PEER_KEY;
  readonly lane = "content" as const;
  readonly label = "synthetic-peer";
  readonly bufferedAmount = 0;
  readonly sent: Buffer[] = [];
  closeCalls = 0;
  readonly #handlers = new Set<(bytes: Buffer) => void>();
  readonly #closed: Promise<PeerChannelClose>;
  #resolveClosed!: (close: PeerChannelClose) => void;
  #settled = false;

  constructor() {
    // Declared before assignment on purpose: a private field with an initializer
    // that writes another private field declared later rejects the promise, and a
    // rejected `closed` reads to the endpoint as a transport failure.
    this.#closed = new Promise<PeerChannelClose>((resolve) => { this.#resolveClosed = resolve; });
  }

  get closed(): Promise<PeerChannelClose> {
    return this.#closed;
  }

  async send(bytes: Uint8Array): Promise<void> {
    this.sent.push(Buffer.from(bytes));
  }

  async close(): Promise<void> {
    this.closeCalls += 1;
    this.#finish(1000, "");
  }

  onMessage(handler: (bytes: Buffer) => void): () => void {
    this.#handlers.add(handler);
    return () => { this.#handlers.delete(handler); };
  }

  deliver(frame: SessionContentFrame): void {
    this.deliverBytes(encodeSessionContentFrame(frame, DEFAULT_SESSION_CONTENT_BOUNDS));
  }

  deliverBytes(bytes: Buffer): void {
    if (this.#settled) return;
    for (const handler of [...this.#handlers]) handler(bytes);
  }

  frames(): SessionContentFrame[] {
    return this.sent.map((bytes) => decodeSessionContentFrame(bytes, DEFAULT_SESSION_CONTENT_BOUNDS));
  }

  framesOfType(type: SessionContentFrame["type"]): SessionContentFrame[] {
    return this.frames().filter((frame) => frame.type === type);
  }

  lose(code = 1006): void {
    this.#finish(code, "lost");
  }

  #finish(code: number, reason: string): void {
    if (this.#settled) return;
    this.#settled = true;
    this.#resolveClosed(Object.freeze({ code, reason }));
  }
}

/**
 * The fake owning-host service: one hosted provider row, its surfaces, and the one
 * raw handoff the endpoint may ask for. It is not an authority — it re-checks the
 * echoed source exactly as the manager does, and records every handoff it accepted.
 */
class FakeNativeSource implements SessionContentSource {
  readonly writes: Array<{ readonly viewerId: string; readonly request: NativeViewerInputRequest }> = [];
  readonly openViewerOptions: Array<OwningHostViewerOptions | undefined> = [];
  /** Each surface's own copy sink, exactly as the endpoint registered it. */
  readonly sinks: NativeViewerClipboardSink[] = [];
  geometry: SessionGeometry = { cols: 80, rows: 24, revision: 3 };
  viewers = new Map<string, { revision: number; sessionId: string | undefined }>();
  /** Set to undefined to model a row that is no longer an input target. */
  scopeAvailable = true;
  private nextViewer = 1;
  private sequence = 0;
  private listener: OwningHostSessionContentListener | undefined;

  snapshot(): OwningHostSessionContentSnapshot {
    return Object.freeze({
      hostRunId: RUN,
      sessionId: ROW,
      // A hosted provider child never reports a Pi native conversation.
      nativeSession: null,
      sequence: (this.sequence += 1),
      geometry: Object.freeze({ ...this.geometry }),
      frame: viewport(this.geometry.cols, this.geometry.rows),
      inputModes: MODES,
    });
  }

  watchSessionContent(_sessionId: string, listener: OwningHostSessionContentListener): OwningHostSessionContentWatch {
    this.listener = listener;
    const snapshot = this.snapshot();
    return {
      snapshot,
      unsubscribe: () => { if (this.listener === listener) this.listener = undefined; },
    };
  }

  notify(): void { this.listener?.(this.snapshot()); }

  readInventorySnapshot(): OwningHostInventorySnapshot {
    const row: NativeInstanceView = {
      id: ROW,
      label: "Claude",
      workspace: "/srv/owner/work",
      agentDir: "/srv/owner/.pi/agent",
      lifecycle: "alive",
      busy: null,
      pendingInput: null,
      inputSurface: false,
      nativeSession: null,
      backgroundTasks: null,
      backgroundShells: null,
      activeTasks: null,
      activeShells: null,
      hasLiveProcess: true,
      activity: [],
      backend: "claude",
    };
    return Object.freeze({ hostRunId: RUN, revision: 1, rows: Object.freeze([row]) });
  }

  openViewer(options?: OwningHostViewerOptions): SessionViewerState | undefined {
    this.openViewerOptions.push(options);
    if (options?.nativeClipboardSink !== undefined) this.sinks.push(options.nativeClipboardSink);
    const viewerId = `viewer-${this.nextViewer += 1}`;
    this.viewers.set(viewerId, { revision: 1, sessionId: undefined });
    return { viewerId, sessionId: undefined, cols: undefined, rows: undefined, revision: 1 };
  }

  readViewer(viewerId: string): SessionViewerState | undefined {
    const viewer = this.viewers.get(viewerId);
    if (viewer === undefined) return undefined;
    return { viewerId, sessionId: viewer.sessionId, cols: this.geometry.cols, rows: this.geometry.rows, revision: viewer.revision };
  }

  updateViewer(viewerId: string, update: SessionViewerUpdate = {}): SessionViewerUpdateResult {
    const viewer = this.viewers.get(viewerId);
    if (viewer === undefined) return { applied: false, reason: "unknown-viewer" };
    if (update.expectedRevision !== undefined && update.expectedRevision !== viewer.revision) {
      return { applied: false, reason: "stale" };
    }
    viewer.sessionId = update.sessionId === null ? undefined : update.sessionId ?? viewer.sessionId;
    viewer.revision += 1;
    return { applied: true, state: this.readViewer(viewerId)! };
  }

  closeViewer(viewerId: string): boolean {
    return this.viewers.delete(viewerId);
  }

  /** The CURRENT owner-private scope of one surface, in the manager's own shape. */
  readViewerInputSource(viewerId: string): NativeViewerNativeCliInputSource | undefined {
    const viewer = this.viewers.get(viewerId);
    if (viewer === undefined || !this.scopeAvailable || viewer.sessionId !== ROW) return undefined;
    return Object.freeze({
      hostRunId: RUN,
      viewerId,
      viewerRevision: viewer.revision,
      rowId: ROW,
      phase: "native-cli" as const,
      backend: "claude" as const,
      geometry: Object.freeze({ ...this.geometry }),
      // The owner's opaque handle commits to the surface revision, as the real
      // commitment does: a moved surface is a different handle, not a re-labelled one.
      sourceToken: `nvcli1.${viewerId}.${revHex(viewer.revision)}`,
    });
  }

  /** The one raw handoff, fenced on the exact current scope like the manager's. */
  writeViewerInput(viewerId: string, request: NativeViewerInputRequest): NativeViewerInputResult {
    const current = this.readViewerInputSource(viewerId);
    if (current === undefined) return { status: "refused", reason: "row-unavailable" };
    const expected = request.expectedSource;
    if (!isNativeViewerNativeCliInputSource(expected)
      || expected.hostRunId !== current.hostRunId
      || expected.rowId !== current.rowId
      || expected.backend !== current.backend
      || expected.viewerRevision !== current.viewerRevision
      || expected.sourceToken !== current.sourceToken
      || expected.geometry.cols !== current.geometry.cols
      || expected.geometry.rows !== current.geometry.rows
      || expected.geometry.revision !== current.geometry.revision) {
      return { status: "refused", reason: "stale-source" };
    }
    this.writes.push({ viewerId, request });
    return { status: "submitted" };
  }
}

type SessionContentHelloAckFrame = Extract<SessionContentFrame, { type: "hello_ack" }>;

interface Harness {
  channel: ContentChannel;
  source: FakeNativeSource;
  diagnostics: SessionContentHostDiagnosticCode[];
  binding: ReturnType<ReturnType<typeof createSessionContentHost>["attach"]>;
}

function createHarness(nativeIo: boolean | undefined): Harness {
  const source = new FakeNativeSource();
  const diagnostics: SessionContentHostDiagnosticCode[] = [];
  const host = createSessionContentHost({
    source,
    nativeIo,
    authorizePeer: () => true,
    timeouts: { helloTimeoutMs: 500, transferIdleTimeoutMs: 500, stopAckTimeoutMs: 500 },
    onDiagnostic: (event) => { diagnostics.push(event.code); },
  });
  const channel = new ContentChannel();
  const binding = host.attach(channel);
  return { channel, source, diagnostics, binding };
}

async function settle(times = 8): Promise<void> {
  for (let index = 0; index < times; index += 1) await new Promise<void>((resolve) => setImmediate(resolve));
}

function helloFrame(capabilities: readonly string[]): SessionContentHelloFrame {
  return { type: "hello", service: SESSION_CONTENT_SERVICE, major: SESSION_CONTENT_MAJOR, minor: SESSION_CONTENT_MINOR, capabilities };
}

const ALL_IO = [SESSION_CONTENT_REQUIRED_CAPABILITY, SESSION_CONTENT_NATIVE_IO_CAPABILITY,
  SESSION_CONTENT_NATIVE_INPUT_STARTUP_CAPABILITY, SESSION_CONTENT_NATIVE_INPUT_CLI_CAPABILITY];

function helloAck(frame: SessionContentFrame | undefined): SessionContentHelloAckFrame {
  assert.ok(frame !== undefined && frame.type === "hello_ack", "the channel answered the hello with an acknowledgement");
  return frame;
}

function subscribeFrame(): SessionContentSubscribeFrame {
  return { type: "subscribe", subscriptionId: "sub-1", hostRunId: RUN, sessionId: ROW, cols: 80, rows: 24 };
}

/** Hello and subscribe on a negotiated channel; returns the published source. */
async function openNativeSubscription(harness: Harness, capabilities: readonly string[]): Promise<NativeIoNativeCliSource | null> {
  harness.channel.deliver(helloFrame(capabilities));
  await settle();
  harness.channel.deliver(subscribeFrame());
  await settle();
  assert.equal(harness.binding.subscribed, true, `the content subscription is live (diagnostics: ${harness.diagnostics.join(",")}; sent: ${harness.channel.frames().map((frame) => frame.type).join(",")})`);
  const begin = harness.channel.framesOfType("content_begin").at(-1);
  assert.ok(begin !== undefined && begin.type === "content_begin");
  return (begin.inputSource ?? null) as NativeIoNativeCliSource | null;
}

test("the owner offers hosted native CLI input only beside native IO and only to a peer that offered it", async () => {
  const off = createHarness(false);
  off.channel.deliver(helloFrame(ALL_IO));
  await settle();
  assert.deepEqual(helloAck(off.channel.framesOfType("hello_ack")[0]).capabilities, [SESSION_CONTENT_REQUIRED_CAPABILITY],
    "without the explicit opt-in the acknowledgement keeps its exact legacy shape");
  assert.deepEqual(off.source.openViewerOptions, [], "a display-only channel registers no viewer at all");

  const on = createHarness(true);
  on.channel.deliver(helloFrame(ALL_IO));
  await settle();
  const ack = helloAck(on.channel.framesOfType("hello_ack")[0]);
  assert.equal(ack.capabilities.includes(SESSION_CONTENT_NATIVE_INPUT_CLI_CAPABILITY), true,
    "an explicit opt-in with a real provider acknowledges the peer's own offer");

  // A peer that does not offer this variant is never given it.
  const legacy = createHarness(true);
  legacy.channel.deliver(helloFrame([SESSION_CONTENT_REQUIRED_CAPABILITY, SESSION_CONTENT_NATIVE_IO_CAPABILITY]));
  await settle();
  const legacyAck = helloAck(legacy.channel.framesOfType("hello_ack")[0]);
  assert.equal(legacyAck.capabilities.includes(SESSION_CONTENT_NATIVE_INPUT_CLI_CAPABILITY), false);

  await settle();
});

test("a hosted row's tuple-less publish states the native CLI source and nothing else", async () => {
  const harness = createHarness(true);
  const published = await openNativeSubscription(harness, ALL_IO);
  assert.ok(published !== null, "a negotiated publish of a hosted row states its input source");
  assert.equal(published.phase, "native-cli");
  assert.equal(published.backend, "claude");
  assert.equal(published.hostRunId, RUN);
  assert.equal(published.sessionId, ROW);
  assert.deepEqual(published.geometry, harness.source.geometry);
  assert.equal(Object.hasOwn(published, "nativeSession"), false, "a hosted provider publish states no conversation tuple");
  assert.equal(Object.hasOwn(published, "registrationIdentity"), false);
  assert.equal(Object.hasOwn(published, "viewerId"), false, "the owner's private surface identity never crosses the wire");

  // Every surface change is a new source: the same row, a different viewer revision.
  const before = published.sourceToken;
  harness.source.notify();
  await settle();
  const again = await openSourceOf(harness);
  assert.equal(again?.sourceToken, before, "ordinary publication of unchanged facts keeps the same source");
});

async function openSourceOf(harness: Harness): Promise<NativeIoNativeCliSource | null> {
  const begin = harness.channel.framesOfType("content_begin").at(-1);
  assert.ok(begin !== undefined && begin.type === "content_begin");
  return (begin.inputSource ?? null) as NativeIoNativeCliSource | null;
}

test("current native CLI input reaches the one raw handoff; a stale echo writes nothing", async () => {
  const harness = createHarness(true);
  const published = await openNativeSubscription(harness, ALL_IO);
  assert.ok(published !== null);

  const keystroke = "\u001b[A";
  const built = buildNativeInputInline({
    subscriptionId: "sub-1",
    inputId: "input-1",
    ordinal: 1,
    source: published,
    inputModes: MODES,
    kind: "keyboard",
    data: keystroke,
  });
  for (const frame of built.frames) harness.channel.deliverBytes(frame);
  await settle();

  assert.equal(harness.source.writes.length, 1, "the current source produced exactly one handoff");
  const handoff = harness.source.writes[0]!;
  assert.equal(handoff.request.data, keystroke, "the bytes handed to the child are the viewer's own, unchanged");
  assert.equal(isNativeViewerNativeCliInputSource(handoff.request.expectedSource), true,
    "the owner seam is handed the CURRENT owner-private scope, in its own variant");
  assert.deepEqual(handoff.request.expectedInputModes, MODES);

  // A stale echo of the same facts after the surface moved is refused with zero bytes.
  const stale = published;
  assert.ok(harness.source.updateViewer(handoff.viewerId, {}).applied, "the owner surface moved");
  const moved = harness.source.readViewerInputSource(handoff.viewerId)!;
  assert.notEqual(moved.viewerRevision, stale.viewerRevision, "the surface revision moved");
  const staleBuilt = buildNativeInputInline({
    subscriptionId: "sub-1", inputId: "input-2", ordinal: 2,
    source: stale, inputModes: MODES, kind: "keyboard", data: "b",
  });
  for (const frame of staleBuilt.frames) harness.channel.deliverBytes(frame);
  await settle();
  assert.equal(harness.source.writes.length, 1, "a stale source writes nothing and poisons nothing after it");
  assert.equal(harness.diagnostics.filter((code) => code === "input_refused").length >= 1, true);

  // The CURRENT source still works: an ordinary refusal never disables the lane. The
  // viewer only learns a moved surface from a publish, so the owner publishes first.
  harness.source.notify();
  await settle();
  const fresh = await openSourceOf(harness);
  assert.notEqual(fresh?.sourceToken, stale.sourceToken, "the publish restated the moved surface");
  assert.ok(fresh !== null);
  const freshBuilt = buildNativeInputInline({
    subscriptionId: "sub-1", inputId: "input-3", ordinal: 3,
    source: fresh, inputModes: MODES, kind: "keyboard", data: "c",
  });
  for (const frame of freshBuilt.frames) harness.channel.deliverBytes(frame);
  await settle();
  assert.equal(harness.source.writes.length, 2, "the next current packet is unaffected by the earlier refusal");
});

test("a channel that never negotiated this variant treats its input as a protocol violation", async () => {
  // Native IO negotiated, hosted native CLI input NOT offered by the peer.
  const harness = createHarness(true);
  const published = await openNativeSubscription(harness, [
    SESSION_CONTENT_REQUIRED_CAPABILITY, SESSION_CONTENT_NATIVE_IO_CAPABILITY,
  ]);
  assert.equal(published, null, "a channel without this variant publishes no hosted input source");
  assert.equal(harness.source.writes.length, 0);

  // A peer that sends a native CLI source anyway is not stale: it is a violation, and
  // the child is never touched.
  const forged = harness.source.readViewerInputSource([...harness.source.viewers.keys()][0]!)!;
  const wire = {
    hostRunId: forged.hostRunId,
    sessionId: forged.rowId,
    phase: "native-cli" as const,
    backend: forged.backend,
    geometry: { ...forged.geometry },
    viewerRevision: forged.viewerRevision,
    sourceToken: forged.sourceToken,
  };
  const built = buildNativeInputInline({
    subscriptionId: "sub-1", inputId: "input-1", ordinal: 1,
    source: wire, inputModes: MODES, kind: "keyboard", data: "x",
  });
  for (const frame of built.frames) harness.channel.deliverBytes(frame);
  await settle();
  assert.equal(harness.source.writes.length, 0, "an un-negotiated variant writes zero bytes");
  assert.equal(harness.diagnostics.includes("protocol_violation"), true,
    "an extension this channel never negotiated is refused as a violation, not ignored");
});

test("a hosted row whose scope disappeared publishes no source and takes no input", async () => {
  const harness = createHarness(true);
  const published = await openNativeSubscription(harness, ALL_IO);
  assert.ok(published !== null);
  harness.source.scopeAvailable = false;
  harness.source.notify();
  await settle();
  const after = await openSourceOf(harness);
  assert.equal(after, null, "a row that is no longer an input target states no source");

  const built = buildNativeInputInline({
    subscriptionId: "sub-1", inputId: "input-1", ordinal: 1,
    source: published, inputModes: MODES, kind: "keyboard", data: "z",
  });
  for (const frame of built.frames) harness.channel.deliverBytes(frame);
  await settle();
  assert.equal(harness.source.writes.length, 0, "the retired target receives nothing");
});

/* ------------------------------------------------------------------------- *
 * Hosted provider TEXT copy OUT (optional native-copy-cli capability)
 * ------------------------------------------------------------------------- */

const ALL_IO_COPY = [...ALL_IO, SESSION_CONTENT_NATIVE_COPY_CLI_CAPABILITY];

/** The owner-private scope of the surface this endpoint registered, in one receipt. */
function cliCopyReceipt(
  harness: Harness,
  text: string,
  overrides: Partial<NativeViewerNativeCliClipboardReceipt> = {},
): NativeViewerNativeCliClipboardReceipt {
  const viewerId = [...harness.source.viewers.keys()].at(-1)!;
  const scope = harness.source.readViewerInputSource(viewerId);
  assert.ok(scope !== undefined, "the endpoint's own surface still has a current hosted scope");
  return Object.freeze({
    source: scope,
    event: Object.freeze({ kind: "copy" as const, encoded: Buffer.from(text, "utf8").toString("base64"), backend: "claude" as const }),
    dispatchId: 1,
    ...overrides,
  });
}

/** Deliver one receipt through the sink THIS channel registered. */
function deliverCopy(harness: Harness, receipt: NativeViewerNativeCliClipboardReceipt): void {
  assert.equal(harness.source.sinks.length, 1, "a negotiated content lane registers exactly one copy sink");
  harness.source.sinks[0]!(receipt);
}

test("the owner acknowledges hosted provider copy only beside hosted input and only to a peer that offered it", async () => {
  const peerWithoutCopy = createHarness(true);
  peerWithoutCopy.channel.deliver(helloFrame(ALL_IO));
  await settle();
  const ack = helloAck(peerWithoutCopy.channel.framesOfType("hello_ack")[0]);
  assert.equal(ack.capabilities.includes(SESSION_CONTENT_NATIVE_INPUT_CLI_CAPABILITY), true);
  assert.equal(ack.capabilities.includes(SESSION_CONTENT_NATIVE_COPY_CLI_CAPABILITY), false,
    "an identifier the peer never offered is never acknowledged");

  const peerWithCopy = createHarness(true);
  peerWithCopy.channel.deliver(helloFrame(ALL_IO_COPY));
  await settle();
  const withCopy = helloAck(peerWithCopy.channel.framesOfType("hello_ack")[0]);
  assert.equal(withCopy.capabilities.includes(SESSION_CONTENT_NATIVE_COPY_CLI_CAPABILITY), true,
    "an explicit opt-in plus a real peer offer negotiates provider copy");

  const displayOnly = createHarness(false);
  displayOnly.channel.deliver(helloFrame(ALL_IO_COPY));
  await settle();
  assert.deepEqual(helloAck(displayOnly.channel.framesOfType("hello_ack")[0]).capabilities,
    [SESSION_CONTENT_REQUIRED_CAPABILITY], "without the host opt-in nothing is acknowledged");
});

test("a hosted provider TEXT copy crosses as its own tuple-less family, to this lane only", async () => {
  const harness = createHarness(true);
  const published = await openNativeSubscription(harness, ALL_IO_COPY);
  assert.ok(published !== null);

  deliverCopy(harness, cliCopyReceipt(harness, "text the child copied out"));
  await settle();

  const copies = harness.channel.framesOfType("copy");
  assert.equal(copies.length, 1, "one whole inline copy emission");
  const frame = copies[0]!;
  assert.equal(frame.type, "copy");
  if (frame.type !== "copy") return;
  assert.equal(frame.subscriptionId, "sub-1");
  assert.equal(frame.dispatchId, 1);
  assert.equal(isNativeIoNativeCliSource(frame.source), true, "the frame names the hosted provider source");
  assert.equal(Object.hasOwn(frame.source, "nativeSession"), false, "no conversation tuple crosses for a provider copy");
  assert.deepEqual(frame.source, published, "the header names the exact source this viewer committed");
  assert.deepEqual(Object.keys(frame.event).sort(), ["backend", "encoded", "kind"]);
  // The discriminated boundary is explicit: a provider copy event is the hosted
  // family (backend, no tuple), never a Pi conversation event read through a cast.
  assert.equal(isNativeIoNativeCliCopyEvent(frame.event), true,
    "the frame carries the hosted provider copy event family");
  if (!isNativeIoNativeCliCopyEvent(frame.event)) return;
  assert.equal(frame.event.kind, "copy");
  assert.equal(frame.event.backend, "claude");
  assert.equal(Buffer.from(frame.event.encoded, "base64").toString("utf8"), "text the child copied out");
  assert.equal(harness.diagnostics.includes("copy_dropped"), false, "the copy was routed, not dropped");
});

test("a lane that never negotiated provider copy emits no copy frame, and a stale scope drops quietly", async () => {
  const withoutCapability = createHarness(true);
  await openNativeSubscription(withoutCapability, ALL_IO);
  deliverCopy(withoutCapability, cliCopyReceipt(withoutCapability, "not negotiated here"));
  await settle();
  assert.equal(withoutCapability.channel.framesOfType("copy").length, 0, "no frame is ever minted for an unnegotiated family");
  assert.equal(withoutCapability.diagnostics.includes("copy_dropped"), true, "the drop is recorded, never claimed as delivery");

  const harness = createHarness(true);
  await openNativeSubscription(harness, ALL_IO_COPY);
  // The surface moved: its current scope is a different commitment, so the receipt
  // that named the old one delivers nothing.
  const viewerId = [...harness.source.viewers.keys()].at(-1)!;
  const stale = cliCopyReceipt(harness, "made for the old revision");
  harness.source.updateViewer(viewerId, {});
  deliverCopy(harness, stale);
  await settle();
  assert.equal(harness.channel.framesOfType("copy").length, 0, "a stale provider scope is never delivered");

  // A backend the row never recorded is refused too.
  deliverCopy(harness, cliCopyReceipt(harness, "wrong backend", {
    event: Object.freeze({ kind: "copy", encoded: Buffer.from("wrong backend", "utf8").toString("base64"), backend: "codex" as const }),
  }));
  await settle();
  assert.equal(harness.channel.framesOfType("copy").length, 0, "the event backend must match the row's own backend");

  // The same surface's current facts still work: a drop never latches the lane.
  deliverCopy(harness, cliCopyReceipt(harness, "still deliverable"));
  await settle();
  assert.equal(harness.channel.framesOfType("copy").length, 1, "a current provider scope still delivers");
});
