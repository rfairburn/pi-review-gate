/**
 * Focused contract tests for the roster metadata bridge (#478).
 *
 * Everything here is pure: an in-memory loopback channel pair stands in for the
 * transport, and a thin fake inventory source stands in for the owning-host
 * service's read-only watch. No socket, listener, process, filesystem, or product
 * state is touched; the only timers are the bridge's own finite guards and the
 * test's own bounded, self-clearing observation windows, which never settle a
 * bridge promise on its behalf. The paired
 * TLS/WSS coverage lives in
 * `session-host-network-roster-bridge-integration.test.ts`.
 *
 * The assertions are about observable safety: nothing crosses before the hello,
 * nothing is published before a complete transfer, unknown facts stay unknown,
 * loss never becomes empty or idle, and no private owner field can be expressed.
 */

import assert from "node:assert/strict";
import test from "node:test";
import type { NativeInstanceView } from "../src/session-host/instances";
import type { SessionHostNativeSession } from "../src/session-host/protocol";
import type {
  OwningHostInventoryListener,
  OwningHostInventorySnapshot,
  OwningHostInventoryWatch,
} from "../src/session-host/owning-host-service";
import type { PeerByteChannel, PeerChannelClose } from "../src/session-host/network/channel";
import {
  attachRosterBridgeViewer,
  isRosterBridgeViewerError,
  type RosterBridgeProjection,
  type RosterBridgeViewer,
} from "../src/session-host/network/roster-bridge-client";
import {
  createRosterBridgeHost,
  type RosterBridgeChannelBinding,
  type RosterBridgeInventorySource,
} from "../src/session-host/network/roster-bridge-host";
import {
  DEFAULT_ROSTER_BRIDGE_BOUNDS,
  ROSTER_BRIDGE_MAJOR,
  ROSTER_BRIDGE_MINOR,
  ROSTER_BRIDGE_REQUIRED_CAPABILITY,
  ROSTER_BRIDGE_SERVICE,
  RosterBridgeProtocolError,
  buildRosterBridgeTransfer,
  decodeRosterBridgeFrame,
  encodeRosterBridgeFrame,
  isRosterBridgeProtocolError,
  negotiateRosterBridgeHello,
  packRosterBridgePages,
  resolveRosterBridgeBounds,
  reviewRosterBridgeHelloAck,
  rosterBridgeWireCodeForFailure,
  type RosterBridgeBounds,
  type RosterBridgeErrorCode,
  type RosterBridgeFrame,
  type RosterBridgeHelloFrame,
} from "../src/session-host/network/roster-bridge-protocol";
import { toRemoteSessionMetadata, type RemoteSessionMetadata } from "../src/session-host/network/roster-metadata";

const SECRET_AGENT_DIR = "/Users/owner/.pi/agent";
const SECRET_CURRENT_FILE = "/Users/owner/src/private/secret-file.ts";

function nativeSession(id: string): SessionHostNativeSession {
  return { sessionId: `conversation-${id}`, epoch: 2, name: `Conversation ${id}` };
}

/** A full owner row, including the private fields the boundary must never copy. */
function ownerRow(id: string, overrides: Partial<NativeInstanceView> = {}): NativeInstanceView {
  return {
    id,
    label: `Row ${id}`,
    workspace: `/srv/owner/work-${id}`,
    agentDir: SECRET_AGENT_DIR,
    lifecycle: "alive",
    busy: null,
    pendingInput: null,
    inputSurface: false,
    nativeSession: nativeSession(id),
    backgroundTasks: null,
    backgroundShells: null,
    activeTasks: null,
    activeShells: null,
    hasLiveProcess: true,
    activity: [],
    // A real owner row also carries the retained restart binding and the
    // current-file guard; neither is representable on the wire.
    ...overrides,
    lastNativeSession: nativeSession(id),
  } as NativeInstanceView & { lastNativeSession?: unknown };
}

function remoteRows(ids: readonly string[]): RemoteSessionMetadata[] {
  return ids.map((id) => toRemoteSessionMetadata(ownerRow(id)));
}

/**
 * One in-memory channel pair. Each `send` preserves message boundaries exactly
 * like the WebSocket transport, delivery is asynchronous, and every registration
 * and write is recorded in a shared ordered event log.
 */
class LoopbackChannel implements PeerByteChannel {
  readonly peerKey: { keyId: string; fingerprint: string };
  readonly label: string | null;
  readonly sent: Buffer[] = [];
  readonly events: string[];
  peer: LoopbackChannel | null = null;
  failNextSend = false;
  /** Hold writes pending: bytes are accepted, the write callback is not. */
  hold = false;
  /** Queue inbound delivery so a test can inspect the middle of a transfer. */
  holdDelivery = false;
  /** Hand the peer the next write's bytes but leave its send promise unsettled. */
  deferNextSend = false;
  /** Settle deferred send promises with this rejection instead of resolving. */
  deferFailure: Error | null = null;
  /** Whether closing this side also finishes the peer. */
  linkClose = true;
  closedCalls = 0;
  handlerCount = 0;
  #handlers = new Set<(bytes: Buffer) => void>();
  #held: { bytes: Buffer; settle: () => void }[] = [];
  #deferred: { settle: () => void }[] = [];
  #undelivered: Buffer[] = [];
  #closed: Promise<PeerChannelClose>;
  #resolveClosed!: (value: PeerChannelClose) => void;
  #settled = false;

  constructor(name: string, events: string[], keyId: string) {
    this.events = events;
    this.label = name;
    this.peerKey = { keyId, fingerprint: `synthetic-${keyId}` };
    this.#closed = new Promise<PeerChannelClose>((resolve) => {
      this.#resolveClosed = resolve;
    });
  }

  get closed(): Promise<PeerChannelClose> {
    return this.#closed;
  }

  get bufferedAmount(): number {
    return 0;
  }

  /** Every decoded frame this channel wrote, in order. */
  frames(): RosterBridgeFrame[] {
    return this.sent.map((bytes) => decodeRosterBridgeFrame(bytes));
  }

  types(): string[] {
    return this.frames().map((frame) => frame.type);
  }

  send(bytes: Uint8Array): Promise<void> {
    if (this.#settled) return Promise.reject(new Error("channel closed"));
    if (this.failNextSend) {
      this.failNextSend = false;
      return Promise.reject(new Error("synthetic send failure"));
    }
    const copy = Buffer.from(bytes);
    this.sent.push(copy);
    this.events.push(`send:${this.label}`);
    if (this.hold) {
      return new Promise<void>((resolve) => {
        this.#held.push({ bytes: copy, settle: resolve });
      });
    }
    const peer = this.peer;
    if (peer !== null) queueMicrotask(() => peer.deliver(copy));
    if (this.deferNextSend) {
      this.deferNextSend = false;
      return new Promise<void>((resolve, reject) => {
        this.#deferred.push({
          settle: () => {
            if (this.deferFailure !== null) reject(this.deferFailure);
            else resolve();
          },
        });
      });
    }
    return Promise.resolve();
  }

  /** Owner writes whose send promise is still outstanding. */
  get deferredWrites(): number {
    return this.#deferred.length;
  }

  /** Settle every deferred send promise, as a socket that finally drains, or dies. */
  releaseDeferred(): void {
    const deferred = this.#deferred;
    this.#deferred = [];
    for (const entry of deferred) entry.settle();
  }

  /** Release held writes and hand their bytes to the peer. */
  release(): void {
    const held = this.#held;
    this.#held = [];
    this.hold = false;
    const peer = this.peer;
    for (const entry of held) {
      entry.settle();
      if (peer !== null) queueMicrotask(() => peer.deliver(entry.bytes));
    }
  }

  /** Deliver everything that arrived while inbound delivery was held. */
  flushDelivery(): void {
    const queued = this.#undelivered;
    this.#undelivered = [];
    this.holdDelivery = false;
    for (const bytes of queued) this.deliver(bytes);
  }

  close(): Promise<void> {
    this.closedCalls += 1;
    this.#finish(1000, "");
    const peer = this.peer;
    if (peer !== null && this.linkClose) queueMicrotask(() => peer.#finish(1000, ""));
    return Promise.resolve();
  }

  onMessage(handler: (bytes: Buffer) => void): () => void {
    this.events.push(`register:${this.label}`);
    this.#handlers.add(handler);
    this.handlerCount = this.#handlers.size;
    return () => {
      this.#handlers.delete(handler);
      this.handlerCount = this.#handlers.size;
      this.events.push(`detach:${this.label}`);
    };
  }

  deliver(bytes: Buffer): void {
    if (this.#settled) return;
    if (this.holdDelivery) {
      this.#undelivered.push(Buffer.from(bytes));
      return;
    }
    for (const handler of [...this.#handlers]) handler(bytes);
  }

  #finish(code: number, reason: string): void {
    if (this.#settled) return;
    this.#settled = true;
    this.#resolveClosed(Object.freeze({ code, reason }));
  }
}

interface Pair {
  readonly viewerSide: LoopbackChannel;
  readonly ownerSide: LoopbackChannel;
  readonly events: string[];
}

function channelPair(viewerKeyId = "viewer-key", ownerKeyId = "owner-key"): Pair {
  const events: string[] = [];
  // A channel reports the key of the peer on the other end, exactly as the real
  // transport does: the viewer's side carries the owner's verified key and the
  // owner's side carries the viewer's verified key.
  const viewerSide = new LoopbackChannel("viewer", events, ownerKeyId);
  const ownerSide = new LoopbackChannel("owner", events, viewerKeyId);
  viewerSide.peer = ownerSide;
  ownerSide.peer = viewerSide;
  return { viewerSide, ownerSide, events };
}

/**
 * A thin fake of the one capability the owner bridge uses. It is deliberately
 * not an authority: it owns no rendering, no sessions, and no second roster, and
 * it can publish a notification from inside `watchInventory` because the real
 * service can.
 */
class FakeInventory implements RosterBridgeInventorySource {
  revision = 0;
  hostRunId = "11111111-1111-4111-8111-111111111111";
  rows: NativeInstanceView[] = [];
  readonly watches: FakeWatch[] = [];
  /** Runs before `watchInventory` returns, as a retained source change would. */
  installHook: ((notify: (snapshot: OwningHostInventorySnapshot | undefined) => void) => void) | undefined;
  unavailable = false;

  watchInventory(listener: OwningHostInventoryListener): OwningHostInventoryWatch | undefined {
    if (this.unavailable) return undefined;
    const snapshot = this.#capture();
    const watch: FakeWatch = {
      snapshot,
      listener,
      unsubscribed: 0,
      unsubscribe: () => {
        watch.unsubscribed += 1;
      },
    };
    this.watches.push(watch);
    const hook = this.installHook;
    if (hook !== undefined) {
      this.installHook = undefined;
      hook((next) => listener(next));
    }
    return watch;
  }

  /** One live change to every installed watch, as the manager's hook would. */
  emit(): OwningHostInventorySnapshot {
    const snapshot = this.#capture();
    for (const watch of this.watches) if (watch.unsubscribed === 0) watch.listener(snapshot);
    return snapshot;
  }

  emitUnavailable(): void {
    for (const watch of this.watches) if (watch.unsubscribed === 0) watch.listener(undefined);
  }

  get liveWatchCount(): number {
    return this.watches.filter((watch) => watch.unsubscribed === 0).length;
  }

  #capture(): OwningHostInventorySnapshot {
    this.revision += 1;
    return Object.freeze({
      hostRunId: this.hostRunId,
      revision: this.revision,
      rows: Object.freeze([...this.rows]),
    });
  }
}

interface FakeWatch {
  readonly snapshot: OwningHostInventorySnapshot;
  readonly listener: OwningHostInventoryListener;
  unsubscribed: number;
  unsubscribe(): void;
}

/** A hand-driven owner peer that writes exactly the frames a test asks for. */
/**
 * A scripted peer that speaks one side of the loopback pair by hand. Constructed
 * with the side it speaks from, it records what that side wrote, collects what
 * arrives there, and acknowledges a hello the way a real owner does. Passing
 * `ownerSide` scripts the owner (snapshot frames driven into a real viewer);
 * passing `viewerSide` scripts the viewer (hello/subscribe driven into a real
 * owner).
 */
class ScriptedPeer {
  readonly channel: LoopbackChannel;
  received: RosterBridgeFrame[] = [];
  /** A scripted owner acknowledges a hello unless a test wants silence. */
  autoAck = true;
  #confirmUnsubscribes = false;
  #onHello: ((frame: RosterBridgeHelloFrame) => void) | undefined;

  constructor(channel: LoopbackChannel) {
    this.channel = channel;
    // The real side's close stays local to it, so one test can drive several
    // scenarios from the scripted side without a close silencing the wire.
    const peer = channel.peer as LoopbackChannel | null;
    if (peer !== null) peer.linkClose = false;
    channel.onMessage((bytes) => {
      const frame = decodeRosterBridgeFrame(bytes);
      this.received.push(frame);
      if (frame.type === "unsubscribe") {
        // The real owner confirms every unsubscribe idempotently once it is past
        // the hello, so a test that only needs an ordinary stop gets that answer
        // from the simulated owner instead of from a timer.
        if (this.#confirmUnsubscribes) {
          this.write({ type: "unsubscribed", subscriptionId: frame.subscriptionId });
        }
        return;
      }
      if (frame.type !== "hello") return;
      if (this.autoAck) {
        this.write({
          type: "hello_ack",
          service: ROSTER_BRIDGE_SERVICE,
          major: ROSTER_BRIDGE_MAJOR,
          minor: ROSTER_BRIDGE_MINOR,
          capabilities: [ROSTER_BRIDGE_REQUIRED_CAPABILITY],
        });
      }
      if (this.#onHello !== undefined) this.#onHello(frame);
    });
  }

  onHello(handler: (frame: RosterBridgeHelloFrame) => void): void {
    this.#onHello = handler;
  }

  /**
   * Confirm every `unsubscribe` this side has received, and every one that still
   * arrives, exactly as the real owner bridge's idempotent acknowledgement does.
   *
   * A test's own teardown calls this before stopping a viewer, so the retirement the
   * stop starts (and any retirement the test body left the viewer waiting on) settles
   * on a frame the simulated owner delivers. Without such an answer the only thing
   * that could settle the cleanup is the bridge's stop-acknowledgement guard, which is
   * finite and deliberately `unref()`'d: with no other work pending the event loop
   * resolves first, and the Node test runner reports the still-pending cleanup as
   * cancelled rather than letting the guard run. Tests that script the acknowledgement
   * themselves (a withheld or unwritable one) never call this and keep their silence.
   */
  confirmUnsubscribes(): void {
    for (const frame of this.received) {
      if (frame.type === "unsubscribe") this.write({ type: "unsubscribed", subscriptionId: frame.subscriptionId });
    }
    this.#confirmUnsubscribes = true;
  }

  write(frame: RosterBridgeFrame): void {
    this.channel.sent.push(encodeRosterBridgeFrame(frame));
    // Deliver without re-entering the viewer's own send accounting.
    this.peerChannel().deliver(encodeRosterBridgeFrame(frame));
  }

  private peerChannel(): LoopbackChannel {
    return this.channel.peer as LoopbackChannel;
  }
}

function helloFrame(capabilities: readonly string[] = [ROSTER_BRIDGE_REQUIRED_CAPABILITY]): RosterBridgeHelloFrame {
  return { type: "hello", service: ROSTER_BRIDGE_SERVICE, major: ROSTER_BRIDGE_MAJOR, minor: ROSTER_BRIDGE_MINOR, capabilities };
}

function helloAck(capabilities: readonly string[] = [ROSTER_BRIDGE_REQUIRED_CAPABILITY]): RosterBridgeFrame {
  return { type: "hello_ack", service: ROSTER_BRIDGE_SERVICE, major: ROSTER_BRIDGE_MAJOR, minor: ROSTER_BRIDGE_MINOR, capabilities };
}

function begin(subscriptionId: string, transferId: string, revision: number, totalRows: number, pageCount: number, hostRunId = "11111111-1111-4111-8111-111111111111"): RosterBridgeFrame {
  return { type: "snapshot_begin", subscriptionId, transferId, hostRunId, revision, totalRows, pageCount };
}

function page(subscriptionId: string, transferId: string, pageIndex: number, rows: readonly RemoteSessionMetadata[]): RosterBridgeFrame {
  return { type: "snapshot_page", subscriptionId, transferId, pageIndex, rows };
}

function end(subscriptionId: string, transferId: string, revision: number, totalRows: number): RosterBridgeFrame {
  return { type: "snapshot_end", subscriptionId, transferId, revision, totalRows };
}

async function settle(times = 4): Promise<void> {
  for (let index = 0; index < times; index += 1) await new Promise<void>((resolve) => setImmediate(resolve));
}

const FAST_BOUNDS: Partial<RosterBridgeBounds> = {
  handshakeTimeoutMs: 250,
  snapshotStartTimeoutMs: 250,
  transferIdleTimeoutMs: 250,
  stopAckTimeoutMs: 120,
  helloTimeoutMs: 250,
};

// --- pure protocol -----------------------------------------------------------

test("metadata bounds are finite, validated, and never treat zero as unlimited", () => {
  assert.equal(DEFAULT_ROSTER_BRIDGE_BOUNDS.maxFrameBytes, 65_536);
  assert.equal(DEFAULT_ROSTER_BRIDGE_BOUNDS.maxRowsPerPage, 32);
  assert.equal(DEFAULT_ROSTER_BRIDGE_BOUNDS.maxSnapshotRows, 4_096);
  assert.equal(resolveRosterBridgeBounds().maxFrameBytes, 65_536);
  assert.equal(resolveRosterBridgeBounds({ maxRowsPerPage: 4 }).maxRowsPerPage, 4);
  for (const overrides of [
    { maxFrameBytes: 0 },
    { maxFrameBytes: -1 },
    { maxFrameBytes: 1.5 },
    { maxFrameBytes: Number.NaN },
    { maxFrameBytes: Number.POSITIVE_INFINITY },
    { maxRowsPerPage: 0 },
    { maxSnapshotBytes: 0 },
    { handshakeTimeoutMs: 0 },
    { maxPageBytes: DEFAULT_ROSTER_BRIDGE_BOUNDS.maxFrameBytes + 1 },
    { maxRowsPerPage: 8, maxSnapshotRows: 4 },
  ]) {
    assert.throws(() => resolveRosterBridgeBounds(overrides), (error: unknown) => isRosterBridgeProtocolError(error),
      `${JSON.stringify(overrides)} must be refused`);
  }
  // The fixed ceilings are not overridable configuration.
  assert.equal((DEFAULT_ROSTER_BRIDGE_BOUNDS as unknown as Record<string, unknown>).maxSubscriptions, undefined);
});

test("one binary message carries exactly one frame and nothing outside the schema", () => {
  const bytes = encodeRosterBridgeFrame(helloFrame());
  assert.deepEqual(decodeRosterBridgeFrame(bytes), helloFrame());

  // A second JSON document in the same message is refused, not assembled.
  assert.throws(() => decodeRosterBridgeFrame(Buffer.concat([bytes, bytes])),
    (error: unknown) => isRosterBridgeProtocolError(error) && error.code === "bad_frame");
  // Not UTF-8, not JSON, and not an object.
  assert.throws(() => decodeRosterBridgeFrame(Buffer.from([0xff, 0xfe, 0xfd])),
    (error: unknown) => isRosterBridgeProtocolError(error) && error.code === "bad_frame");
  assert.throws(() => decodeRosterBridgeFrame(Buffer.from("not json")),
    (error: unknown) => isRosterBridgeProtocolError(error) && error.code === "bad_frame");
  assert.throws(() => decodeRosterBridgeFrame(Buffer.from("[]")),
    (error: unknown) => isRosterBridgeProtocolError(error) && error.code === "bad_frame");
  // Unknown keys are refused rather than passed through.
  assert.throws(() => decodeRosterBridgeFrame(Buffer.from(JSON.stringify({
    ...helloFrame(), agentDir: SECRET_AGENT_DIR,
  }))), (error: unknown) => isRosterBridgeProtocolError(error) && error.code === "bad_frame");
  assert.throws(() => decodeRosterBridgeFrame(Buffer.from(JSON.stringify({
    type: "subscribe", subscriptionId: "sub-1", capability: "everything",
  }))), (error: unknown) => isRosterBridgeProtocolError(error) && error.code === "bad_frame");
  // An unknown frame type and an unknown error code are both refused.
  assert.throws(() => decodeRosterBridgeFrame(Buffer.from(JSON.stringify({ type: "delta", subscriptionId: "sub-1" }))),
    (error: unknown) => isRosterBridgeProtocolError(error));
  assert.throws(() => decodeRosterBridgeFrame(Buffer.from(JSON.stringify({ type: "error", code: "tell_me_everything" }))),
    (error: unknown) => isRosterBridgeProtocolError(error) && error.code === "bad_frame");
  // Oversized frames fail closed instead of being truncated.
  assert.throws(() => decodeRosterBridgeFrame(Buffer.alloc(DEFAULT_ROSTER_BRIDGE_BOUNDS.maxFrameBytes + 1, 0x20)),
    (error: unknown) => isRosterBridgeProtocolError(error) && error.code === "frame_too_large");
  assert.throws(() => encodeRosterBridgeFrame(
    { type: "error", code: "bad_frame" },
    { ...DEFAULT_ROSTER_BRIDGE_BOUNDS, maxFrameBytes: 8 },
  ), (error: unknown) => isRosterBridgeProtocolError(error) && error.code === "frame_too_large");
  assert.equal(rosterBridgeWireCodeForFailure("frame_too_large"), "bad_frame");
  assert.equal(rosterBridgeWireCodeForFailure("snapshot_too_large"), "snapshot_too_large");
});

test("a page row cannot carry a private owner field onto the wire", () => {
  const row = remoteRows(["row-1"])[0] as unknown as Record<string, unknown>;
  const base = { subscriptionId: "sub-1", transferId: "transfer-1", pageIndex: 0 };
  for (const extra of [
    { agentDir: SECRET_AGENT_DIR },
    { currentFile: SECRET_CURRENT_FILE },
    { lastNativeSession: { sessionId: "conversation-row-1", epoch: 2, name: "kept" } },
    { prompt: "the user's prompt" },
    { transcript: "the transcript" },
    { env: { TOKEN: "secret" } },
    { pid: 4242 },
  ]) {
    const frame = { ...base, rows: [{ ...row, ...extra }] };
    assert.throws(() => decodeRosterBridgeFrame(encodeFrameOrThrow(frame)),
      (error: unknown) => isRosterBridgeProtocolError(error) && error.code === "bad_frame",
      `${JSON.stringify(extra)} must never decode`);
  }
});

function encodeFrameOrThrow(frame: unknown): Buffer {
  return Buffer.from(JSON.stringify(frame));
}

test("version and capability negotiation fails closed and grants nothing extra", () => {
  assert.deepEqual(negotiateRosterBridgeHello(helloFrame()), {
    ok: true, major: ROSTER_BRIDGE_MAJOR, minor: ROSTER_BRIDGE_MINOR, capabilities: [],
  });
  // An unknown optional capability is ignored, not trusted.
  const withUnknown = negotiateRosterBridgeHello(helloFrame([ROSTER_BRIDGE_REQUIRED_CAPABILITY, "future-power"]));
  assert.equal(withUnknown.ok, true);
  assert.deepEqual(withUnknown.ok ? withUnknown.capabilities : null, []);
  // A different service or major version, or a missing required capability, refuses.
  for (const hello of [
    { ...helloFrame(), service: "pi-peer-child-ipc" },
    { ...helloFrame(), major: ROSTER_BRIDGE_MAJOR + 1 },
    { ...helloFrame(), major: 0 },
    helloFrame([]),
    helloFrame(["future-power"]),
  ]) {
    const decision = negotiateRosterBridgeHello(hello);
    assert.equal(decision.ok, false);
    assert.ok(decision.ok === false && (decision.code === "unsupported_version" || decision.code === "missing_capability"));
  }
  // Minor differences change nothing about privileges.
  assert.equal(negotiateRosterBridgeHello({ ...helloFrame(), minor: 99 }).ok, true);

  assert.deepEqual(reviewRosterBridgeHelloAck(helloAck() as never, { capabilities: [ROSTER_BRIDGE_REQUIRED_CAPABILITY] }),
    { ok: true, minor: ROSTER_BRIDGE_MINOR, capabilities: [ROSTER_BRIDGE_REQUIRED_CAPABILITY] });
  assert.equal(reviewRosterBridgeHelloAck({ ...helloAck(), capabilities: [ROSTER_BRIDGE_REQUIRED_CAPABILITY, "future-power"] } as never,
    { capabilities: [ROSTER_BRIDGE_REQUIRED_CAPABILITY] }).ok, false,
  "an acknowledgement of a capability that was never offered is refused");
  assert.equal(reviewRosterBridgeHelloAck({ ...helloAck(), minor: ROSTER_BRIDGE_MINOR + 1 } as never,
    { capabilities: [ROSTER_BRIDGE_REQUIRED_CAPABILITY] }).ok, false);
  assert.equal(reviewRosterBridgeHelloAck({ ...helloAck(), service: "other" } as never,
    { capabilities: [ROSTER_BRIDGE_REQUIRED_CAPABILITY] }).ok, false);
  assert.equal(reviewRosterBridgeHelloAck(helloAck([]) as never,
    { capabilities: [ROSTER_BRIDGE_REQUIRED_CAPABILITY] }).ok, false);
});

test("pages are packed by actual encoded bytes and refuse to truncate or drop", () => {
  const bounds = resolveRosterBridgeBounds({ maxRowsPerPage: 2 });
  const rows = remoteRows(["a", "b", "c", "d", "e"]);
  const pages = packRosterBridgePages({ subscriptionId: "sub-1", transferId: "t-1", rows, bounds });
  assert.deepEqual(pages.map((entry) => entry.rows.map((row) => row.id)), [["a", "b"], ["c", "d"], ["e"]]);
  assert.deepEqual(pages.map((entry) => entry.frame.pageIndex), [0, 1, 2]);

  // A byte budget that cannot hold even one row is refused, never clipped.
  const tiny = resolveRosterBridgeBounds({ maxPageBytes: 96, maxSnapshotBytes: 4_096, maxFrameBytes: 96, maxSnapshotRows: 8, maxRowsPerPage: 2 });
  assert.throws(() => packRosterBridgePages({ subscriptionId: "sub-1", transferId: "t-1", rows, bounds: tiny }),
    (error: unknown) => isRosterBridgeProtocolError(error) && error.code === "row_unrepresentable");
  // An aggregate beyond the snapshot bound is refused rather than shortened.
  const aggregate = resolveRosterBridgeBounds({ maxRowsPerPage: 2, maxSnapshotRows: 4, maxSnapshotBytes: 65_536, maxPageBytes: 65_536, maxFrameBytes: 65_536 });
  assert.throws(() => packRosterBridgePages({ subscriptionId: "sub-1", transferId: "t-1", rows, bounds: aggregate }),
    (error: unknown) => isRosterBridgeProtocolError(error) && error.code === "snapshot_too_large");

  // Zero rows is a real empty roster, not an unknown one.
  const empty = packRosterBridgePages({ subscriptionId: "sub-1", transferId: "t-1", rows: [], bounds });
  assert.deepEqual(empty, []);

  const built = buildRosterBridgeTransfer({
    subscriptionId: "sub-1", transferId: "t-1", hostRunId: "11111111-1111-4111-8111-111111111111", revision: 7, rows, bounds,
  });
  assert.equal(built.pageCount, 3);
  assert.equal(built.totalRows, 5);
  assert.equal(built.frames.length, 5);
  const decoded = built.frames.map((bytes) => decodeRosterBridgeFrame(bytes, bounds));
  assert.deepEqual(decoded.map((frame) => frame.type), ["snapshot_begin", "snapshot_page", "snapshot_page", "snapshot_page", "snapshot_end"]);
  const announced = decoded[0];
  assert.ok(announced.type === "snapshot_begin");
  assert.equal(announced.revision, 7);
  assert.equal(announced.totalRows, 5);
  assert.equal(announced.pageCount, 3);
  const last = decoded[decoded.length - 1];
  assert.ok(last.type === "snapshot_end");
  assert.equal(last.totalRows, 5);
  assert.equal(last.revision, 7);
});

// --- owner/viewer over the loopback channel ---------------------------------

function harness(options: {
  bounds?: Partial<RosterBridgeBounds>;
  authorize?: (peerKey: { keyId: string; fingerprint: string }) => boolean;
  rows?: readonly string[];
} = {}) {
  const pair = channelPair();
  const inventory = new FakeInventory();
  inventory.rows = (options.rows ?? ["row-1", "row-2", "row-3"]).map((id) => ownerRow(id));
  const ownerDiagnostics: string[] = [];
  const viewerDiagnostics: string[] = [];
  const authorize = options.authorize ?? (() => true);
  const owner = createRosterBridgeHost({
    inventory,
    authorizePeer: authorize,
    bounds: { ...FAST_BOUNDS, ...options.bounds },
    onDiagnostic: (event) => {
      ownerDiagnostics.push(event.code);
    },
  });
  const binding = owner.attach(pair.ownerSide);
  const viewer = attachRosterBridgeViewer({
    channel: pair.viewerSide,
    bounds: { ...FAST_BOUNDS, ...options.bounds },
    onDiagnostic: (event) => {
      viewerDiagnostics.push(event.code);
    },
  });
  return {
    pair,
    inventory,
    owner,
    binding,
    viewer,
    ownerDiagnostics,
    viewerDiagnostics,
    async stop(): Promise<void> {
      await viewer.stop();
      await owner.stopAll();
    },
  };
}

test("the viewer registers its handler before its hello and the owner is never eager", async () => {
  const h = harness();
  try {
    // The owner is never eager: attaching writes nothing at all.
    assert.deepEqual(h.pair.ownerSide.types(), [], "the owner sends nothing before the hello");
    assert.equal(h.binding.subscribed, false);
    assert.deepEqual(h.inventory.watches, [], "no source watch exists before a subscribe");
    // Handler registration precedes the first write on the viewer side.
    await settle();
    const registerViewer = h.pair.events.indexOf("register:viewer");
    const sendViewer = h.pair.events.indexOf("send:viewer");
    assert.ok(registerViewer !== -1 && sendViewer !== -1 && registerViewer < sendViewer,
      `the handler is installed before the hello (${h.pair.events.join(",")})`);
    assert.equal(h.pair.events[0], "register:owner", "the owner installs its handler on attach");
    await h.viewer.hello;
    assert.deepEqual(h.pair.ownerSide.types(), ["hello_ack"]);
    assert.deepEqual(h.pair.viewerSide.types(), ["hello"]);
    await settle();
    assert.deepEqual(h.pair.ownerSide.types(), ["hello_ack"], "no metadata is queued before a subscription");

    const snapshot = await h.viewer.subscribe();
    assert.equal(snapshot.state, "current");
    assert.equal(h.binding.subscribed, true);
    assert.deepEqual(h.pair.viewerSide.types(), ["hello", "subscribe"]);
    assert.deepEqual(h.pair.ownerSide.types(), ["hello_ack", "snapshot_begin", "snapshot_page", "snapshot_end"]);
  } finally {
    await h.stop();
  }
});

test("an incompatible or unauthorized hello gets one fixed refusal and no metadata", async () => {
  const pair = channelPair();
  const inventory = new FakeInventory();
  inventory.rows = [ownerRow("row-1")];
  let allowed = false;
  const owner = createRosterBridgeHost({
    inventory,
    authorizePeer: () => allowed,
    bounds: FAST_BOUNDS,
  });
  const binding = owner.attach(pair.ownerSide);
  try {
    // Wrong major version.
    pair.ownerSide.deliver(encodeRosterBridgeFrame({ ...helloFrame(), major: ROSTER_BRIDGE_MAJOR + 3 }));
    await settle();
    assert.deepEqual(pair.ownerSide.types(), ["error"]);
    const refusal = pair.ownerSide.frames()[0];
    assert.ok(refusal.type === "error" && refusal.code === "unsupported_version");

    // The channel is fenced: a later valid hello gets the same refusal and no ack.
    allowed = true;
    pair.ownerSide.deliver(encodeRosterBridgeFrame(helloFrame()));
    await settle();
    assert.deepEqual(pair.ownerSide.types(), ["error"], "a fenced channel answers nothing further");
    assert.equal(pair.ownerSide.handlerCount, 0, "the refused binding detaches its handler");
    assert.equal(inventory.watches.length, 0, "a refused channel never subscribes the source");
    assert.equal(binding.subscribed, false);
    assert.equal(pair.ownerSide.closedCalls, 0, "a version refusal fences metadata without closing the transport");
  } finally {
    await owner.stopAll();
  }
});

test("a refused authorization at request time writes no metadata and stops nothing else", async () => {
  const pair = channelPair();
  const inventory = new FakeInventory();
  inventory.rows = [ownerRow("row-1")];
  const owner = createRosterBridgeHost({ inventory, authorizePeer: () => false, bounds: FAST_BOUNDS });
  const binding = owner.attach(pair.ownerSide);
  const scripted = new ScriptedPeer(pair.viewerSide);
  try {
    // Drive the viewer's own frames by hand so ordering is exact.
    scripted.write({ type: "hello", service: ROSTER_BRIDGE_SERVICE, major: ROSTER_BRIDGE_MAJOR, minor: ROSTER_BRIDGE_MINOR, capabilities: [ROSTER_BRIDGE_REQUIRED_CAPABILITY] });
    await settle();
    const types = pair.ownerSide.types();
    assert.deepEqual(types, ["error"]);
    const frame = pair.ownerSide.frames()[0];
    assert.ok(frame.type === "error" && frame.code === "not_authorized");
    assert.equal(inventory.watches.length, 0);
    assert.equal(binding.subscribed, false);
    assert.equal(pair.ownerSide.closedCalls, 0, "a refusal fences metadata without closing the transport");
  } finally {
    await owner.stopAll();
  }
});

test("authorization revoked between queued frames fences further metadata", async () => {
  const pair = channelPair();
  const inventory = new FakeInventory();
  inventory.rows = ["a", "b", "c", "d"].map((id) => ownerRow(id));
  let allowed = true;
  const owner = createRosterBridgeHost({
    inventory,
    authorizePeer: () => allowed,
    bounds: { ...FAST_BOUNDS, maxRowsPerPage: 1 },
  });
  owner.attach(pair.ownerSide);
  const viewer = attachRosterBridgeViewer({ channel: pair.viewerSide, bounds: FAST_BOUNDS });
  try {
    await viewer.hello;
    // Park the owner's first write so the revocation lands mid-transfer.
    pair.ownerSide.hold = true;
    const published = viewer.subscribe();
    await settle();
    // The transfer is mid-flight: the begin frame is written, nothing after it.
    const written = pair.ownerSide.types();
    assert.deepEqual(written, ["hello_ack", "snapshot_begin"], `got ${written.join(",")}`);
    allowed = false;
    pair.ownerSide.release();
    const outcome = await published.then(
      () => "published",
      (error: unknown) => (isRosterBridgeViewerError(error) ? `rejected:${error.code}` : "rejected"),
    );
    await settle();
    assert.equal(outcome, "rejected:refused");
    const after = pair.ownerSide.frames();
    const errorFrames = after.filter((frame) => frame.type === "error");
    assert.equal(errorFrames.length, 1, "exactly one fixed refusal is written");
    assert.ok(errorFrames[0]?.type === "error" && errorFrames[0].code === "not_authorized");
    const types = after.map((frame) => frame.type);
    assert.equal(types.includes("snapshot_end"), false, "no later frame of the interrupted transfer is written");
    assert.equal(inventory.liveWatchCount, 0, "the source watch is retired when authorization is lost");
    const projection = viewer.projection;
    assert.notEqual(projection.state, "current", "a revoked projection is never presented as current");
    assert.equal(projection.reason, "authorization-refused");
  } finally {
    await viewer.stop();
    await owner.stopAll();
  }
});

test("a three-page snapshot publishes atomically with exact approved fields", async () => {
  const h = harness({ bounds: { maxRowsPerPage: 1 }, rows: ["a", "b", "c"] });
  const seen: RosterBridgeProjection[] = [];
  h.viewer.onProjection((projection) => seen.push(projection));
  try {
    await h.viewer.hello;
    // Hold inbound delivery so no frame can be published early.
    h.pair.viewerSide.holdDelivery = true;
    const before = h.viewer.subscribe();
    await settle();
    // Mid-transfer the projection still has no rows: partial pages are never current.
    assert.equal(h.viewer.projection.rows.length, 0);
    assert.equal(h.viewer.projection.state, "empty");
    h.pair.viewerSide.flushDelivery();
    const snapshot = await before;
    assert.equal(snapshot.state, "current");
    assert.deepEqual(snapshot.rows.map((row) => row.id), ["a", "b", "c"]);
    assert.equal(h.pair.ownerSide.types().filter((type) => type === "snapshot_page").length, 3);
    const row = snapshot.rows[0];
    assert.ok(row);
    assert.equal(row.workspace, "/srv/owner/work-a", "the owner workspace path is carried exactly");
    assert.equal(row.lifecycle, "alive");
    assert.equal(row.busy, null, "unknown busy stays unknown, never idle");
    assert.equal(row.pendingInput, null);
    assert.equal(row.backgroundTasks, null, "unknown ownership count stays unknown, never zero");
    assert.equal(row.backgroundShells, null);
    assert.equal(row.activeTasks, null, "unknown activity-intent count stays unknown");
    assert.equal(row.activeShells, null);
    assert.equal("exitCode" in row, false, "an unobserved exit code is absent, not zero");
    assert.equal("error" in row, false);
    assert.deepEqual(row.activity, []);
    assert.equal(row.nativeSession?.sessionId, "conversation-a");
    assert.equal("agentDir" in row, false, "the private agent directory never crosses");
    assert.equal("lastNativeSession" in row, false, "the restart binding never crosses");
    assert.equal("currentFile" in row, false);
    // Nothing on the wire mentions private owner data.
    const wire = h.pair.ownerSide.sent.map((bytes) => bytes.toString("utf8")).join("\n");
    assert.equal(wire.includes(SECRET_AGENT_DIR), false);
    assert.equal(wire.includes("lastNativeSession"), false);
    assert.equal(wire.includes("agentDir"), false);
    assert.equal(wire.includes("currentFile"), false);
    assert.equal(seen[seen.length - 1]?.state, "current");
  } finally {
    await h.stop();
  }
});

test("observed facts keep their exact meaning across the bridge", async () => {
  const pair = channelPair();
  const inventory = new FakeInventory();
  inventory.rows = [{
    ...ownerRow("row-1", {
      label: "Ünïcødé 日本語",
      workspace: "/srv/öwner/日本語-wo\u200brk",
      busy: false,
      pendingInput: true,
      inputSurface: true,
      backgroundTasks: 0,
      backgroundShells: 3,
      activeTasks: 1,
      activeShells: 0,
      activity: ["step one"],
      lifecycle: "exited",
      hasLiveProcess: false,
      exitCode: 7,
      error: "spawn failed for /srv/öwner/日本語-work",
    }),
    nativeSession: null,
  } as NativeInstanceView];
  const owner = createRosterBridgeHost({ inventory, authorizePeer: () => true, bounds: FAST_BOUNDS });
  owner.attach(pair.ownerSide);
  const viewer = attachRosterBridgeViewer({ channel: pair.viewerSide, bounds: FAST_BOUNDS });
  try {
    await viewer.hello;
    const snapshot = await viewer.subscribe();
    const row = snapshot.rows[0];
    assert.ok(row);
    assert.equal(row.label, "Ünïcødé 日本語");
    assert.equal(row.workspace, "/srv/öwner/日本語-wo\u200brk", "workspace bytes are carried unchanged");
    assert.equal(row.busy, false, "an observed false is never rendered as unknown");
    assert.equal(row.pendingInput, true);
    assert.equal(row.inputSurface, true);
    assert.equal(row.backgroundTasks, 0, "an observed zero ownership count stays zero");
    assert.equal(row.backgroundShells, 3);
    assert.equal(row.activeTasks, 1, "activity-intent counts stay independent");
    assert.equal(row.activeShells, 0);
    assert.equal(row.lifecycle, "exited");
    assert.equal(row.hasLiveProcess, false);
    assert.equal(row.exitCode, 7, "an observed exit code is preserved");
    assert.equal(row.error, "spawn failed for /srv/öwner/日本語-work");
    assert.equal(row.nativeSession, null, "an unknown native binding stays null");
  } finally {
    await viewer.stop();
    await owner.stopAll();
  }
});

test("a later change replaces the projection with a newer complete snapshot", async () => {
  const h = harness({ rows: ["only"] });
  try {
    await h.viewer.hello;
    const first = await h.viewer.subscribe();
    assert.equal(first.revision, 1);
    h.inventory.rows = [ownerRow("only", { label: "Renamed" }), ownerRow("second")];
    h.inventory.emit();
    await settle();
    const projection = h.viewer.projection;
    assert.equal(projection.state, "current");
    assert.ok((projection.revision ?? 0) > (first.revision ?? 0));
    assert.deepEqual(projection.rows.map((row) => row.label), ["Renamed", "Row second"]);
    assert.equal(h.owner.activeSubscriptionCount, 1, "one subscription stays one subscription");
  } finally {
    await h.stop();
  }
});

test("an inconsistent transfer is discarded whole and a fresh one still works", async () => {
  const pair = channelPair();
  const viewer = attachRosterBridgeViewer({ channel: pair.viewerSide, bounds: FAST_BOUNDS });
  const scripted = new ScriptedPeer(pair.ownerSide);
  try {
    await viewer.hello;
    const subscription = viewer.subscribe();
    // The failing transfer rejects this promise; the handler is attached before
    // any frame is written so the rejection is always owned.
    const firstOutcome = subscription.then(
      () => "published",
      (error: unknown) => (isRosterBridgeViewerError(error) ? `rejected:${error.code}` : "rejected"),
    );
    await settle();
    const subscriptionId = viewer.subscriptionId;
    assert.ok(subscriptionId);
    const rows = remoteRows(["a", "b", "c"]);

    // End that contradicts the announced shape: the transfer fails and nothing lands.
    scripted.write(begin(subscriptionId, "t-bad", 5, 3, 1));
    scripted.write(page(subscriptionId, "t-bad", 0, rows));
    scripted.write(end(subscriptionId, "t-bad", 5, 2));
    await settle();
    assert.equal(viewer.projection.rows.length, 0, "an inconsistent transfer is discarded whole");
    assert.equal(viewer.projection.state, "empty");
    assert.equal(viewer.projection.reason, "transfer-failed");
    assert.equal(await firstOutcome, "rejected:transfer-failed");

    // A fresh subscription can still publish correctly afterwards, but only after
    // the abandoned subscription has been named to the owner and confirmed: the
    // viewer must not leave a watch running on the owner's side and then open a
    // second subscription the owner would refuse as too many.
    const retirement = pair.viewerSide.frames().find((frame) => frame.type === "unsubscribe");
    assert.equal(retirement?.subscriptionId, subscriptionId, "the abandoned subscription is named on the wire");
    const second = viewer.subscribe();
    scripted.write({ type: "unsubscribed", subscriptionId });
    await settle();
    const sub2 = viewer.subscriptionId;
    assert.ok(sub2 && sub2 !== subscriptionId);
    scripted.write(begin(sub2, "t-ok", 6, 3, 2));
    scripted.write(page(sub2, "t-ok", 0, rows.slice(0, 2)));
    scripted.write(page(sub2, "t-ok", 1, rows.slice(2)));
    scripted.write(end(sub2, "t-ok", 6, 3));
    const snapshot = await second;
    assert.equal(snapshot.state, "current");
    assert.deepEqual(snapshot.rows.map((row) => row.id), ["a", "b", "c"]);

    // A frame for the retired first subscription is dropped without disturbing
    // the live projection: it cannot be attributed to anything in progress.
    scripted.write(begin(subscriptionId, "t-late", 7, 1, 1));
    scripted.write(page(subscriptionId, "t-late", 0, rows.slice(0, 1)));
    scripted.write(end(subscriptionId, "t-late", 7, 1));
    await settle();
    assert.equal(viewer.projection.revision, 6, "a stale-subscription frame changes nothing");
    assert.equal(viewer.projection.state, "current");
  } finally {
    // The second subscription is still live, so the owner confirms the stop the
    // way the real bridge does instead of the test waiting on the stop guard.
    scripted.confirmUnsubscribes();
    await viewer.stop();
  }
});

test("a duplicated page index fails the transfer and closes only the metadata channel", async () => {
  const pair = channelPair();
  const viewerDiagnostics: string[] = [];
  const viewer = attachRosterBridgeViewer({
    channel: pair.viewerSide,
    bounds: FAST_BOUNDS,
    onDiagnostic: (event) => {
      viewerDiagnostics.push(event.code);
    },
  });
  const scripted = new ScriptedPeer(pair.ownerSide);
  try {
    await viewer.hello;
    const subscription = viewer.subscribe();
    const outcome = subscription.then(
      () => "published",
      (error: unknown) => (isRosterBridgeViewerError(error) ? `rejected:${error.code}` : "rejected"),
    );
    await settle();
    const subscriptionId = viewer.subscriptionId;
    assert.ok(subscriptionId);
    const rows = remoteRows(["a", "b"]);
    scripted.write(begin(subscriptionId, "t-dup", 6, 2, 2));
    scripted.write(page(subscriptionId, "t-dup", 0, rows.slice(0, 1)));
    scripted.write(page(subscriptionId, "t-dup", 0, rows.slice(0, 1)));
    await settle();
    assert.equal(await outcome, "rejected:protocol-violation");
    assert.equal(viewer.projection.rows.length, 0, "a duplicated page never publishes partially");
    assert.equal(viewer.projection.state, "empty");
    assert.ok(viewerDiagnostics.includes("protocol_violation"), "the violation is recorded where it happened");
    // Closing the metadata channel through its own bounded API is the guaranteed
    // observable; the best-effort error write is not claimed as delivered, and
    // the close is never delayed waiting for a peer that may never drain it.
    assert.equal(viewer.projection.reason, "channel-closed");
    assert.equal(pair.viewerSide.closedCalls, 1, "the viewer closes the metadata channel through its own API");
    await assert.rejects(viewer.subscribe(),
      (error: unknown) => isRosterBridgeViewerError(error) && error.code === "stopped");
  } finally {
    await viewer.stop();
  }
});

test("a revision jump is legitimate while a same-run regression is refused", async () => {
  const pair = channelPair();
  const viewer = attachRosterBridgeViewer({ channel: pair.viewerSide, bounds: FAST_BOUNDS });
  const scripted = new ScriptedPeer(pair.ownerSide);
  try {
    await viewer.hello;
    const started = viewer.subscribe();
    await settle();
    const subscriptionId = viewer.subscriptionId;
    assert.ok(subscriptionId);
    const rows = remoteRows(["a"]);
    scripted.write(begin(subscriptionId, "t-1", 4, 1, 1));
    scripted.write(page(subscriptionId, "t-1", 0, rows));
    scripted.write(end(subscriptionId, "t-1", 4, 1));
    const first = await started;
    await settle();
    assert.equal(viewer.projection.revision, 4, "the first snapshot at revision 4 lands");
    assert.equal(first.revision, 4);

    // A large jump within the same subscription is normal, not a missing delta.
    scripted.write(begin(subscriptionId, "t-2", 91, 1, 1));
    scripted.write(page(subscriptionId, "t-2", 0, rows));
    scripted.write(end(subscriptionId, "t-2", 91, 1));
    await settle();
    assert.equal(viewer.projection.revision, 91);
    assert.equal(viewer.projection.state, "current");

    // A regression against the same run cannot replace newer facts.
    scripted.write(begin(subscriptionId, "t-3", 12, 1, 1));
    await settle();
    assert.equal(viewer.projection.revision, 91, "a regressed revision never replaces newer rows");
    assert.equal(viewer.projection.state, "stale");
    assert.equal(viewer.projection.reason, "revision-regression");
    assert.equal(viewer.projection.rows.length, 1, "last-observed rows are kept, not cleared");
  } finally {
    scripted.confirmUnsubscribes();
    await viewer.stop();
  }
});

test("resync uses a fresh subscription after the stop acknowledgement and accepts the same revision", async () => {
  const pair = channelPair();
  const viewer = attachRosterBridgeViewer({ channel: pair.viewerSide, bounds: FAST_BOUNDS });
  const scripted = new ScriptedPeer(pair.ownerSide);
  try {
    await viewer.hello;
    const started = viewer.subscribe();
    await settle();
    const firstSub = viewer.subscriptionId;
    assert.ok(firstSub);
    const rows = remoteRows(["a", "b"]);
    scripted.write(begin(firstSub, "t-1", 9, 2, 1));
    scripted.write(page(firstSub, "t-1", 0, rows));
    scripted.write(end(firstSub, "t-1", 9, 2));
    const first = await started;
    await settle();
    assert.equal(first.revision, 9);
    assert.equal(first.state, "current");

    const resynced = viewer.resync();
    await settle();
    const unsubscribes = scripted.received.filter((frame) => frame.type === "unsubscribe");
    assert.equal(unsubscribes.length, 1);
    assert.equal(scripted.received.filter((frame) => frame.type === "subscribe").length, 1,
      "no new subscribe is sent before the stop acknowledgement");
    scripted.write({ type: "unsubscribed", subscriptionId: firstSub });
    await settle();
    const secondSub = viewer.subscriptionId;
    assert.ok(secondSub && secondSub !== firstSub, "resync uses a fresh subscription identifier");

    // The owner's current revision is unchanged: freshness must come back anyway.
    scripted.write(begin(secondSub, "t-2", 9, 2, 1));
    scripted.write(page(secondSub, "t-2", 0, rows));
    scripted.write(end(secondSub, "t-2", 9, 2));
    const snapshot = await resynced;
    assert.equal(snapshot.state, "current");
    assert.equal(snapshot.revision, 9, "an equal revision on a fresh subscription is accepted");
    assert.deepEqual(snapshot.rows.map((row) => row.id), ["a", "b"]);
    assert.equal(scripted.received.filter((frame) => frame.type === "subscribe").length, 2);
  } finally {
    scripted.confirmUnsubscribes();
    await viewer.stop();
  }
});

test("owner errors mark observations not current without inventing idle state", async () => {
  const pair = channelPair();
  const viewer = attachRosterBridgeViewer({ channel: pair.viewerSide, bounds: FAST_BOUNDS });
  const scripted = new ScriptedPeer(pair.ownerSide);
  try {
    await viewer.hello;
    assert.equal(viewer.subscriptionId, null, "no subscription existed before the first subscribe");
    const started = viewer.subscribe();
    await settle();
    const sub = viewer.subscriptionId;
    assert.ok(sub);
    const rows = remoteRows(["a"]);
    scripted.write(begin(sub, "t-1", 3, 1, 1));
    scripted.write(page(sub, "t-1", 0, rows));
    scripted.write(end(sub, "t-1", 3, 1));
    const first = await started;
    await settle();
    assert.equal(viewer.projection.state, "current");
    assert.equal(first.revision, 3);

    for (const [code, reason] of [
      ["unavailable", "source-unavailable"],
      ["run_changed", "run-changed"],
      ["snapshot_too_large", "transfer-failed"],
    ] as const) {
      // Each error arrives on a live subscription; the first one ends it, so the
      // next iteration re-subscribes first.
      let active = viewer.subscriptionId;
      if (active === null) {
        const again = viewer.subscribe();
        await settle();
        active = viewer.subscriptionId;
        assert.ok(active);
        scripted.write(begin(active, `t-${code}`, 3, 1, 1));
        scripted.write(page(active, `t-${code}`, 0, rows));
        scripted.write(end(active, `t-${code}`, 3, 1));
        await again;
        await settle();
      }
      assert.ok(active !== null, "a subscription is live before each error");
      scripted.write({ type: "error", code, subscriptionId: active });
      await settle();
      const projection = viewer.projection;
      assert.equal(projection.state, "stale", `${code} must not leave a current projection`);
      assert.equal(projection.reason, reason);
      assert.equal(projection.rows.length, 1, `${code} never clears last-observed rows`);
      assert.equal(projection.revision, 3, `${code} never claims a newer revision`);
    }
  } finally {
    scripted.confirmUnsubscribes();
    await viewer.stop();
  }
});

test("an unobservable inventory is a terminal error, never an empty roster", async () => {
  const h = harness();
  try {
    await h.viewer.hello;
    h.inventory.unavailable = true;
    await assert.rejects(h.viewer.subscribe(), (error: unknown) => isRosterBridgeViewerError(error) && error.code === "refused");
    assert.equal(h.viewer.projection.state, "empty");
    assert.equal(h.viewer.projection.reason, "source-unavailable");
    assert.equal(h.viewer.projection.rows.length, 0, "no rows are invented");
    assert.equal(h.viewer.subscriptionId, null);

    // Recovery is an explicit fresh subscription, not polling.
    h.inventory.unavailable = false;
    const snapshot = await h.viewer.subscribe();
    assert.equal(snapshot.state, "current");
    assert.equal(snapshot.rows.length, 3);
  } finally {
    await h.stop();
  }
});

test("a change delivered while the watch is installed lands after the install snapshot", async () => {
  const pair = channelPair();
  const inventory = new FakeInventory();
  inventory.rows = [ownerRow("row-1", { label: "Before" })];
  const owner = createRosterBridgeHost({ inventory, authorizePeer: () => true, bounds: FAST_BOUNDS });
  owner.attach(pair.ownerSide);
  const viewer = attachRosterBridgeViewer({ channel: pair.viewerSide, bounds: FAST_BOUNDS });
  const published: RosterBridgeProjection[] = [];
  viewer.onProjection((projection) => {
    if (projection.state === "current") published.push(projection);
  });
  try {
    await viewer.hello;
    // The source publishes a real change from inside the install, before the
    // install snapshot is handed back.
    inventory.installHook = (notify) => {
      inventory.rows = [ownerRow("row-1", { label: "During" })];
      notify(inventory.emit());
    };
    const first = await viewer.subscribe();
    await settle();
    assert.equal(first.rows[0]?.label, "Before", "the install snapshot is delivered as captured");
    assert.equal(published.length, 2, "the retained change follows instead of overwriting the install snapshot");
    assert.equal(published[1]?.rows[0]?.label, "During");
    assert.ok((published[1]?.revision ?? 0) > (published[0]?.revision ?? 0), "the newer observation is newer");
    assert.equal(viewer.projection.rows[0]?.label, "During", "the viewer ends on the newest state");
  } finally {
    await viewer.stop();
    await owner.stopAll();
  }
});

test("stop is idempotent, retires the source watch, and detaches every handler", async () => {
  const h = harness();
  try {
    await h.viewer.hello;
    await h.viewer.subscribe();
    assert.equal(h.inventory.liveWatchCount, 1);
    assert.equal(h.pair.ownerSide.handlerCount, 1);
    assert.equal(h.pair.viewerSide.handlerCount, 1);

    await h.viewer.stop();
    await h.viewer.stop();
    await settle();
    assert.deepEqual(h.pair.viewerSide.types(), ["hello", "subscribe", "unsubscribe"]);
    assert.equal(h.pair.viewerSide.handlerCount, 0, "the viewer detaches its handler exactly once");
    assert.equal(h.inventory.watches[0]?.unsubscribed, 1, "the owner retires the source watch once");
    assert.equal(h.inventory.liveWatchCount, 0);
    assert.equal(h.owner.activeSubscriptionCount, 0);
    assert.equal(h.binding.subscribed, false);
    assert.equal(h.owner.activeBindingCount, 1,
      "a metadata stop ends the subscription but keeps the binding on the open channel");
    const projection = h.viewer.projection;
    assert.equal(projection.state, "stale");
    assert.equal(projection.reason, "stopped");
    assert.equal(projection.rows.length, 3, "stopping never clears the roster to empty");

    // Owner-side retirement is likewise idempotent and never touches the channel.
    await h.owner.stopAll();
    await h.owner.stopAll();
    assert.equal(h.pair.ownerSide.handlerCount, 0);
    assert.equal(h.inventory.watches[0]?.unsubscribed, 1);
    assert.equal(h.pair.ownerSide.closedCalls, 0, "metadata teardown never closes the transport");
  } finally {
    await h.viewer.stop();
  }
});

test("channel loss marks the projection stale and the owner releases its watch", async () => {
  const h = harness();
  try {
    await h.viewer.hello;
    await h.viewer.subscribe();
    assert.equal(h.inventory.liveWatchCount, 1);
    await h.pair.viewerSide.close();
    await settle();
    assert.equal(h.viewer.projection.state, "stale");
    assert.equal(h.viewer.projection.reason, "channel-closed");
    assert.equal(h.viewer.projection.rows.length, 3, "a lost channel is never an empty roster");
    assert.equal(h.viewer.subscriptionId, null);
    assert.equal(h.inventory.watches[0]?.unsubscribed, 1);
    assert.equal(h.binding.subscribed, false);
    assert.equal(h.owner.activeBindingCount, 0);
    await assert.rejects(h.viewer.subscribe(), (error: unknown) => isRosterBridgeViewerError(error) && error.code === "stopped");
  } finally {
    await h.owner.stopAll();
  }
});

test("a failed write is owned, fenced, and never reported as remote delivery", async () => {
  const h = harness({ rows: ["a", "b", "c"] });
  try {
    await h.viewer.hello;
    const published = h.viewer.subscribe().then(
      () => "published",
      (error: unknown) => (isRosterBridgeViewerError(error) ? `rejected:${error.code}` : "rejected"),
    );
    await settle();
    // Break the owner's outbound path mid-transfer.
    h.pair.ownerSide.failNextSend = true;
    h.inventory.rows = ["a", "b", "c", "d"].map((id) => ownerRow(id));
    h.inventory.emit();
    const outcome = await published;
    await settle();
    assert.equal(outcome, "published", "the first subscription had already completed before the failure");
    assert.ok(h.ownerDiagnostics.includes("send_failed"), "the failed write is owned and recorded");
    assert.equal(h.viewer.projection.state, "stale");
    assert.ok(["transfer-failed", "channel-closed"].includes(String(h.viewer.projection.reason)),
      `a failed write leaves an explicitly stale projection, not a current one (${h.viewer.projection.reason})`);
    assert.equal(h.viewer.projection.rows.length, 3, "the last complete roster survives");
    assert.equal(h.inventory.liveWatchCount, 0, "a failed transfer retires the source watch");
    assert.equal(h.pair.ownerSide.closedCalls, 1, "the failed protocol channel is closed through its bounded API");
  } finally {
    await h.viewer.stop();
    await h.owner.stopAll();
  }
});

test("frames that cannot be represented fail the transfer instead of shipping a fake row", async () => {
  const pair = channelPair();
  const inventory = new FakeInventory();
  inventory.rows = [ownerRow("row-1"), ownerRow("row-2")];
  const owner = createRosterBridgeHost({
    inventory,
    authorizePeer: () => true,
    // A page budget far below one row: the snapshot cannot be built at all.
    bounds: { ...FAST_BOUNDS, maxPageBytes: 128, maxFrameBytes: 128, maxSnapshotBytes: 4_096, maxSnapshotRows: 4, maxRowsPerPage: 2 },
  });
  owner.attach(pair.ownerSide);
  const viewer = attachRosterBridgeViewer({
    channel: pair.viewerSide,
    bounds: { ...FAST_BOUNDS, maxPageBytes: 128, maxFrameBytes: 128, maxSnapshotBytes: 4_096, maxSnapshotRows: 4, maxRowsPerPage: 2 },
  });
  try {
    await viewer.hello;
    await assert.rejects(viewer.subscribe(), (error: unknown) => isRosterBridgeViewerError(error) && error.code === "transfer-failed");
    const types = pair.ownerSide.types();
    assert.deepEqual(types, ["hello_ack", "error"], "no partial page and no invented row is written");
    const frame = pair.ownerSide.frames()[1];
    assert.ok(frame.type === "error" && frame.code === "row_unrepresentable");
    assert.equal(inventory.liveWatchCount, 0, "the subscription is terminated, not left half-delivered");
    assert.equal(viewer.projection.rows.length, 0);
    assert.equal(viewer.projection.reason, "transfer-failed");
  } finally {
    await viewer.stop();
    await owner.stopAll();
  }
});

test("a stalled transfer fails its subscription on a finite guard without widening any deadline", async () => {
  const pair = channelPair();
  const viewer = attachRosterBridgeViewer({ channel: pair.viewerSide, bounds: { ...FAST_BOUNDS, transferIdleTimeoutMs: 120 } });
  const scripted = new ScriptedPeer(pair.ownerSide);
  try {
    await viewer.hello;
    const started = viewer.subscribe();
    await settle();
    const subscriptionId = viewer.subscriptionId;
    assert.ok(subscriptionId);
    scripted.write(begin(subscriptionId, "t-stall", 2, 4, 2));
    scripted.write(page(subscriptionId, "t-stall", 0, remoteRows(["a"])));
    // The rest of the transfer never arrives.
    // The idle guard is the bridge's own finite timer, which is unref'd: the bound
    // await keeps the loop alive long enough to observe it fail and names the
    // failure if it never does. No protocol deadline changes.
    await mustSettle(
      assert.rejects(started, (error: unknown) => isRosterBridgeViewerError(error) && error.code === "timeout"),
      "the stalled transfer failing its subscription",
    );
    assert.equal(viewer.projection.state, "empty");
    assert.equal(viewer.projection.rows.length, 0, "a stalled transfer never publishes its staged rows");
    assert.equal(viewer.subscriptionId, null);
  } finally {
    // The abandoned transfer named its subscription to the owner on the way out;
    // the scripted owner confirms that retirement so the teardown settles.
    scripted.confirmUnsubscribes();
    await viewer.stop();
  }
});

test("a control-send backlog is refused rather than queued without bound", async () => {
  const pair = channelPair();
  const viewer = attachRosterBridgeViewer({ channel: pair.viewerSide, bounds: FAST_BOUNDS });
  try {
    // Block the outbound path so nothing drains, then attempt more control sends
    // than the fixed queue bound.
    let release: () => void = () => undefined;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    pair.viewerSide.send = ((bytes: Uint8Array) => blocked.then(() => Promise.resolve())) as (bytes: Uint8Array) => Promise<void>;
    const attempts: Promise<void>[] = [];
    for (let index = 0; index < 8; index += 1) {
      attempts.push(viewer.resync().then(() => undefined));
    }
    // Only the bridge's own finite guards can settle an admitted attempt here, and
    // they are deliberately unref'd: bound the wait so those guards are actually
    // observed, and name the failure if an attempt never settles. No protocol
    // deadline changes and nothing here settles a resync on the bridge's behalf.
    await mustSettle(Promise.allSettled(attempts), "every control-send attempt settling");
    release();
    await settle();
    const sent = pair.viewerSide.sent.length;
    assert.ok(sent <= 4, `at most the queue bound is admitted (${sent})`);
  } finally {
    // Nothing owns the owner side of this pair, so only the bridge's own finite stop
    // guard can settle the teardown. Bounded observation of that guard, not a wider
    // deadline: an unconfirmed retirement still ends the session on its own timer.
    await mustSettle(viewer.stop(), "the viewer's bounded stop after a refused backlog");
  }
});

test("unknown frames from either peer are answered once and end the protocol", async () => {
  const pair = channelPair();
  const inventory = new FakeInventory();
  inventory.rows = [ownerRow("row-1")];
  const owner = createRosterBridgeHost({ inventory, authorizePeer: () => true, bounds: FAST_BOUNDS });
  owner.attach(pair.ownerSide);
  try {
    pair.ownerSide.deliver(Buffer.from("complete nonsense"));
    await settle();
    const types = pair.ownerSide.types();
    assert.deepEqual(types, ["error"], "one fixed refusal, no repeated replies to a flood");
    const frame = pair.ownerSide.frames()[0];
    assert.ok(frame.type === "error" && frame.code === "bad_frame");
    pair.ownerSide.deliver(encodeRosterBridgeFrame({ type: "error", code: "bad_frame" }));
    pair.ownerSide.deliver(encodeRosterBridgeFrame({ type: "error", code: "bad_frame" }));
    await settle();
    assert.deepEqual(pair.ownerSide.types(), ["error"], "a fenced channel stays silent");
    assert.equal(pair.ownerSide.closedCalls, 1, "the violating channel is closed once through its bounded API");
    assert.equal(inventory.watches.length, 0, "a violating peer never subscribes the inventory");
  } finally {
    await owner.stopAll();
  }
});

test("a subscribe that arrives before the hello is refused once and fences the channel", async () => {
  const pair = channelPair();
  const inventory = new FakeInventory();
  inventory.rows = [ownerRow("row-1")];
  const owner = createRosterBridgeHost({ inventory, authorizePeer: () => true, bounds: FAST_BOUNDS });
  const binding = owner.attach(pair.ownerSide);
  const scripted = new ScriptedPeer(pair.viewerSide);
  try {
    scripted.write({ type: "subscribe", subscriptionId: "sub-early" });
    await settle();
    assert.deepEqual(pair.ownerSide.types(), ["error"], "one fixed refusal and nothing else");
    assert.ok(pair.ownerSide.frames()[0]?.type === "error");
    assert.equal(inventory.watches.length, 0, "an out-of-order subscribe installs no watch");
    assert.equal(binding.subscribed, false);
    assert.equal(pair.ownerSide.closedCalls, 1, "the violating channel is closed once through its bounded API");

    // The fence is permanent for this channel: a later valid hello is not acked.
    scripted.autoAck = false;
    scripted.write(helloFrame());
    await settle();
    assert.deepEqual(pair.ownerSide.types(), ["error"], "a fenced channel never resumes metadata");
  } finally {
    await owner.stopAll();
  }
});

test("a second subscription on one channel is refused without a second watch", async () => {
  const pair = channelPair();
  const inventory = new FakeInventory();
  inventory.rows = [ownerRow("row-1")];
  const owner = createRosterBridgeHost({ inventory, authorizePeer: () => true, bounds: FAST_BOUNDS });
  const binding = owner.attach(pair.ownerSide);
  const scripted = new ScriptedPeer(pair.viewerSide);
  try {
    scripted.write(helloFrame());
    await settle();
    scripted.write({ type: "subscribe", subscriptionId: "sub-1" });
    await settle();
    assert.equal(binding.subscribed, true);
    scripted.write({ type: "subscribe", subscriptionId: "sub-2" });
    await settle();
    const codes = pair.ownerSide.frames()
      .filter((frame): frame is Extract<RosterBridgeFrame, { type: "error" }> => frame.type === "error")
      .map((frame) => frame.code);
    assert.ok(codes.includes("too_many_subscriptions"), `got ${codes.join(",")}`);
    assert.equal(inventory.watches.length, 1, "the refusal installs no second watch");
    assert.equal(binding.subscriptionId, "sub-1", "the owner tracks the viewer's own subscription identifier");
    assert.equal(binding.subscribed, true, "the refusal leaves the live subscription alone");
  } finally {
    await owner.stopAll();
  }
});

test("the owner never sends anything on a channel whose viewer stays silent", async () => {
  const pair = channelPair();
  const inventory = new FakeInventory();
  inventory.rows = [ownerRow("row-1")];
  const owner = createRosterBridgeHost({ inventory, authorizePeer: () => true, bounds: { ...FAST_BOUNDS, helloTimeoutMs: 120 } });
  owner.attach(pair.ownerSide);
  try {
    await new Promise<void>((resolve) => setTimeout(resolve, 200));
    assert.deepEqual(pair.ownerSide.types(), ["error"], "only the finite hello guard speaks, once");
    assert.equal(inventory.watches.length, 0);
    assert.equal(pair.ownerSide.closedCalls, 0, "a silent viewer is refused without closing the transport");
    assert.equal(owner.activeBindingCount, 0);
  } finally {
    await owner.stopAll();
  }
});

test("the owner's own stop tells the viewer its rows are no longer current", async () => {
  const h = harness();
  try {
    await h.viewer.hello;
    await h.viewer.subscribe();
    assert.equal(h.viewer.projection.state, "current");
    await h.binding.stop();
    await h.binding.stop();
    await settle();
    assert.equal(h.viewer.projection.state, "stale");
    assert.equal(h.viewer.projection.reason, "source-unavailable");
    assert.equal(h.viewer.projection.rows.length, 3, "an owner stop never empties the roster");
    assert.equal(h.inventory.watches[0]?.unsubscribed, 1);
    assert.equal(h.pair.ownerSide.closedCalls, 0, "stopping metadata leaves the channel and every session alone");
  } finally {
    await h.viewer.stop();
    await h.owner.stopAll();
  }
});

test("a throwing authorizer is an unavailable decision, not an open door", async () => {
  const pair = channelPair();
  const inventory = new FakeInventory();
  inventory.rows = [ownerRow("row-1")];
  const owner = createRosterBridgeHost({
    inventory,
    authorizePeer: () => {
      throw new Error("authorization backend down");
    },
    bounds: FAST_BOUNDS,
  });
  owner.attach(pair.ownerSide);
  const scripted = new ScriptedPeer(pair.viewerSide);
  try {
    scripted.write(helloFrame());
    await settle();
    const frame = pair.ownerSide.frames()[0];
    assert.ok(frame.type === "error" && frame.code === "not_authorized");
    assert.equal(inventory.watches.length, 0);
  } finally {
    await owner.stopAll();
  }
});

test("identity is the verified channel key, never a name or a claimed key", async () => {
  const pair = channelPair("peer-key-aaa", "host-key-zzz");
  const inventory = new FakeInventory();
  inventory.rows = [ownerRow("row-1")];
  const seenKeys: string[] = [];
  const owner = createRosterBridgeHost({
    inventory,
    authorizePeer: (peerKey) => {
      seenKeys.push(peerKey.keyId);
      return peerKey.keyId === "peer-key-aaa";
    },
    bounds: FAST_BOUNDS,
  });
  const binding = owner.attach(pair.ownerSide);
  const viewer = attachRosterBridgeViewer({ channel: pair.viewerSide, bounds: FAST_BOUNDS });
  try {
    await viewer.hello;
    await viewer.subscribe();
    assert.deepEqual([...new Set(seenKeys)], ["peer-key-aaa"], "only the exact channel key is ever consulted");
    assert.ok(seenKeys.length >= 3,
      `the key is re-checked on the request and before each protected write (${seenKeys.length} checks)`);
    assert.equal(binding.peerKey.keyId, "peer-key-aaa");
    assert.equal(viewer.peerKey.keyId, "host-key-zzz", "the viewer records the owner's verified key");
    assert.equal(binding.label, "owner", "the certificate label remains display data only");
    const wire = pair.ownerSide.sent.map((bytes) => bytes.toString("utf8")).join("\n");
    assert.equal(wire.includes("peer-key-aaa"), false, "identity is never echoed on the wire");
    assert.equal(wire.includes("host-key-zzz"), false);
  } finally {
    await viewer.stop();
    await owner.stopAll();
  }
});

test("the bridge constructor refuses to guess an authority or a channel", () => {
  assert.throws(() => createRosterBridgeHost({
    inventory: { watchInventory: () => undefined },
  } as never), /authorizer/);
  assert.throws(() => createRosterBridgeHost({
    inventory: {} as RosterBridgeInventorySource,
    authorizePeer: () => true,
  }), /inventory watch/);
  assert.throws(() => attachRosterBridgeViewer({ channel: {} as PeerByteChannel }), /peer byte channel/);
  assert.ok(new RosterBridgeProtocolError("bad_frame") instanceof Error);
});

// --- retirement, teardown, and run-pinning regressions -----------------------

/** Wait for an observable fact rather than a fixed number of turns. */
async function until(label: string, predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
}

/** Settle a viewer promise into a comparable string, owning its rejection. */
function outcome(promise: Promise<unknown>): Promise<string> {
  return promise.then(
    () => "resolved",
    (error: unknown) => (isRosterBridgeViewerError(error) ? `rejected:${error.code}` : "rejected"),
  );
}

/**
 * Fail with a named message instead of hanging when a promise never settles.
 *
 * The bound timer stays ref'd on purpose. Every bridge guard is finite and
 * deliberately `unref()`'d, so an in-memory test waiting on a guard-settled
 * promise would otherwise let the event loop resolve while that guard still has
 * time to run; the Node test runner then reports the test as cancelled instead of
 * observing the guard's own outcome. This window keeps the loop alive for a bounded
 * moment, clears itself, and rejects with a named timeout when the promise does not
 * settle, so a stranded promise is still a visible failure. It never settles the
 * awaited promise itself and changes no protocol deadline.
 */
async function mustSettle<T>(promise: Promise<T>, label: string, ms = 2_000): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`timed out waiting for ${label}`)), ms);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

const RUN_A = "11111111-1111-4111-8111-111111111111";
const RUN_B = "22222222-2222-4222-8222-222222222222";

test("frames admitted before an unsubscribe are retirement noise, not a violation", async () => {
  const pair = channelPair();
  const viewerDiagnostics: string[] = [];
  const viewer = attachRosterBridgeViewer({
    channel: pair.viewerSide,
    bounds: FAST_BOUNDS,
    onDiagnostic: (event) => {
      viewerDiagnostics.push(event.code);
    },
  });
  const scripted = new ScriptedPeer(pair.ownerSide);
  try {
    await viewer.hello;
    const first = outcome(viewer.subscribe());
    await settle();
    const sub1 = viewer.subscriptionId;
    assert.ok(sub1);
    const rows = remoteRows(["a", "b", "c", "d"]);
    scripted.write(begin(sub1, "t-slow", 4, 4, 2, RUN_A));
    scripted.write(page(sub1, "t-slow", 0, rows.slice(0, 2)));
    await settle();

    // The viewer retires mid-transfer while the owner's remaining frames are
    // already admitted and on the wire.
    const resynced = viewer.resync();
    await settle();
    scripted.write(page(sub1, "t-slow", 1, rows.slice(2)));
    scripted.write(end(sub1, "t-slow", 4, 4));
    await settle();

    assert.equal(await first, "rejected:stopped", "the retired transfer settles as stopped, never as published");
    assert.equal(viewer.projection.state, "empty", "a retired transfer never publishes");
    assert.equal(viewer.projection.reason, "stopped", "the retirement is reported, not a violation");
    assert.ok(!viewerDiagnostics.includes("protocol_violation"),
      "ordinary in-flight traffic during a retirement is not a protocol violation");
    assert.equal(pair.viewerSide.closedCalls, 0, "a resync during paging does not tear down the channel");

    scripted.write({ type: "unsubscribed", subscriptionId: sub1 });
    await settle();
    const sub2 = viewer.subscriptionId;
    assert.ok(sub2 && sub2 !== sub1, "the resync starts a fresh subscription after the acknowledgement");
    scripted.write(begin(sub2, "t-new", 5, 2, 1, RUN_A));
    scripted.write(page(sub2, "t-new", 0, rows.slice(0, 2)));
    scripted.write(end(sub2, "t-new", 5, 2));
    const snapshot = await resynced;
    assert.equal(snapshot.state, "current", "the fresh subscription publishes normally");
    assert.equal(snapshot.rows.length, 2);
  } finally {
    scripted.confirmUnsubscribes();
    await viewer.stop();
  }
});

test("stopping during paging settles on in-flight frames and never closes the channel", async () => {
  const pair = channelPair();
  const viewerDiagnostics: string[] = [];
  const viewer = attachRosterBridgeViewer({
    channel: pair.viewerSide,
    bounds: FAST_BOUNDS,
    onDiagnostic: (event) => {
      viewerDiagnostics.push(event.code);
    },
  });
  const scripted = new ScriptedPeer(pair.ownerSide);
  try {
    await viewer.hello;
    const first = outcome(viewer.subscribe());
    await settle();
    const sub1 = viewer.subscriptionId;
    assert.ok(sub1);
    const rows = remoteRows(["a", "b", "c", "d"]);
    scripted.write(begin(sub1, "t-stop", 4, 4, 2, RUN_A));
    scripted.write(page(sub1, "t-stop", 0, rows.slice(0, 2)));
    await settle();

    const stopping = viewer.stop();
    await settle();
    // Frames the owner had already admitted before its unsubscribe arrived.
    scripted.write(page(sub1, "t-stop", 1, rows.slice(2)));
    scripted.write(end(sub1, "t-stop", 4, 4));
    await settle();
    assert.ok(!viewerDiagnostics.includes("protocol_violation"),
      "in-flight frames during a stop are not a protocol violation");
    assert.equal(pair.viewerSide.closedCalls, 0, "a stop during paging is not a transport failure");

    scripted.write({ type: "unsubscribed", subscriptionId: sub1 });
    await stopping;
    assert.equal(await first, "rejected:stopped", "the interrupted subscription settles");
    assert.equal(viewer.projection.state, "empty", "nothing was ever published, which is not an empty roster claim");
    assert.equal(viewer.projection.reason, "stopped");
    assert.equal(pair.viewerSide.handlerCount, 0, "the viewer detached its handler");
  } finally {
    await viewer.stop();
  }
});

test("a locally abandoned subscription is named to the real owner and recovered after", async () => {
  // The long acknowledgement window is a test-only choice so that releasing
  // delivery, rather than a race, decides when the owner's confirmation lands.
  const h = harness({ bounds: { snapshotStartTimeoutMs: 150, stopAckTimeoutMs: 5_000 } });
  try {
    await h.viewer.hello;
    h.pair.viewerSide.holdDelivery = true;
    const first = outcome(h.viewer.subscribe());
    await until("the viewer gave up on a snapshot it could not see", () => h.viewer.projection.reason === "transfer-failed");

    const unsubscribes = h.pair.viewerSide.frames().filter((frame) => frame.type === "unsubscribe");
    assert.equal(unsubscribes.length, 1, "the abandoned subscription is named exactly once");
    await until("the owner retired the abandoned watch", () => h.inventory.liveWatchCount === 0);
    assert.equal(h.inventory.watches[0]?.unsubscribed, 1, "the owner retires its inventory watch once");
    assert.equal(h.owner.activeSubscriptionCount, 0, "no subscription survives on the owner's side");

    // Releasing delivery hands the viewer the frames of its own retired
    // subscription and then the owner's confirmation. The retired frames must never
    // publish; the confirmation is what lets a replacement start.
    h.pair.viewerSide.flushDelivery();
    await until("the owner's confirmation settled the retirement", () => h.viewerDiagnostics.includes("unsubscribed"));
    assert.equal(h.viewer.projection.state, "empty", "a retired subscription's frames never publish");

    const again = h.viewer.subscribe();
    await until("the replacement subscription started", () => h.viewer.subscriptionId !== null);
    const snapshot = await again;
    assert.equal(snapshot.state, "current", "freshness recovers against the actual owner bridge");
    assert.equal(snapshot.rows.length, 3);
    assert.equal(h.inventory.watches.length, 2, "the replacement installed one new watch");
    assert.equal(h.inventory.watches[0]?.unsubscribed, 1, "the abandoned watch stays retired");
    assert.equal(await first, "rejected:timeout");
  } finally {
    await h.stop();
  }
});

test("an unconfirmed retirement closes the channel instead of opening a second subscription", async () => {
  const pair = channelPair();
  const viewer = attachRosterBridgeViewer({ channel: pair.viewerSide, bounds: FAST_BOUNDS });
  // A scripted owner that never answers an unsubscribe: this side must not assume
  // its abandoned subscription is gone.
  const scripted = new ScriptedPeer(pair.ownerSide);
  try {
    await viewer.hello;
    const first = outcome(viewer.subscribe());
    await settle();
    const sub1 = viewer.subscriptionId;
    assert.ok(sub1);
    const rows = remoteRows(["a"]);
    scripted.write(begin(sub1, "t-stall", 3, 4, 2, RUN_A));
    scripted.write(page(sub1, "t-stall", 0, rows));
    await until("the viewer named the stalled subscription",
      () => pair.viewerSide.frames().some((frame) => frame.type === "unsubscribe"));
    await until("the unconfirmed retirement ended the metadata session", () => pair.viewerSide.closedCalls > 0);

    assert.equal(await first, "rejected:timeout");
    assert.equal(pair.viewerSide.closedCalls, 1, "the channel is closed through its bounded API");
    assert.equal(viewer.subscriptionId, null, "no subscription is left claimed on a channel being closed");
    assert.equal(viewer.projection.state, "empty");
    assert.equal(viewer.projection.reason, "channel-closed",
      "an unconfirmed stop is reported as lost certainty, never as a clean stop");
    await assert.rejects(viewer.subscribe(),
      (error: unknown) => isRosterBridgeViewerError(error) && error.code === "stopped",
      "a resume is not offered after an unacknowledged retirement");
  } finally {
    await viewer.stop();
  }
});

test("another owner run cannot be adopted mid-subscription and needs a fresh subscription", async () => {
  const pair = channelPair();
  const viewer = attachRosterBridgeViewer({ channel: pair.viewerSide, bounds: FAST_BOUNDS });
  const scripted = new ScriptedPeer(pair.ownerSide);
  try {
    await viewer.hello;
    const firstPromise = viewer.subscribe();
    const first = outcome(firstPromise);
    await settle();
    const sub1 = viewer.subscriptionId;
    assert.ok(sub1);
    const rows = remoteRows(["a", "b"]);
    scripted.write(begin(sub1, "t-run-a", 100, 2, 1, RUN_A));
    scripted.write(page(sub1, "t-run-a", 0, rows));
    scripted.write(end(sub1, "t-run-a", 100, 2));
    const published = await firstPromise;
    assert.equal(published.state, "current");
    assert.equal(published.hostRunId, RUN_A);

    // A second run arriving on the same subscription is refused outright: accepting
    // it would let a peer present a stale run as current.
    scripted.write(begin(sub1, "t-run-b", 1, 1, 1, RUN_B));
    await settle();
    assert.equal(viewer.projection.state, "stale", "the run change cannot publish over the pinned run");
    assert.equal(viewer.projection.reason, "run-changed");
    assert.equal(viewer.projection.revision, 100, "the last authoritative revision is retained");
    assert.equal(viewer.projection.hostRunId, RUN_A);
    assert.equal(viewer.projection.rows.length, 2, "a refusal never clears the rows");
    assert.ok(pair.viewerSide.frames().some((frame) => frame.type === "unsubscribe"),
      "the refused subscription is released rather than forgotten");
    scripted.write({ type: "unsubscribed", subscriptionId: sub1 });
    await settle();

    // Only a fresh subscription adopts another run, and a lower revision is then a
    // legitimate fact about a different roster.
    const resynced = viewer.resync();
    await settle();
    const sub2 = viewer.subscriptionId;
    assert.ok(sub2 && sub2 !== sub1);
    scripted.write(begin(sub2, "t-run-b2", 1, 1, 1, RUN_B));
    scripted.write(page(sub2, "t-run-b2", 0, rows.slice(0, 1)));
    scripted.write(end(sub2, "t-run-b2", 1, 1));
    const adopted = await resynced;
    assert.equal(adopted.state, "current", "a fresh subscription adopts the new run");
    assert.equal(adopted.hostRunId, RUN_B);
    assert.equal(adopted.revision, 1, "a lower revision is legitimate in another run");

    // Replaying the previously observed run on this subscription is refused too.
    scripted.write(begin(sub2, "t-run-a-replay", 1, 1, 1, RUN_A));
    await settle();
    assert.equal(viewer.projection.hostRunId, RUN_B, "a replayed older run never becomes current");
    assert.equal(viewer.projection.reason, "run-changed");
    assert.equal(viewer.projection.rows.length, 1);
    void first;
  } finally {
    scripted.confirmUnsubscribes();
    await viewer.stop();
  }
});

test("concurrent resyncs and a stop racing a resync settle on one unsubscribe", async () => {
  const pair = channelPair();
  const viewer = attachRosterBridgeViewer({ channel: pair.viewerSide, bounds: FAST_BOUNDS });
  const scripted = new ScriptedPeer(pair.ownerSide);
  try {
    await viewer.hello;
    const first = outcome(viewer.subscribe());
    await settle();
    const sub1 = viewer.subscriptionId;
    assert.ok(sub1);
    const rows = remoteRows(["a", "b", "c", "d"]);
    scripted.write(begin(sub1, "t-mid", 4, 4, 2, RUN_A));
    scripted.write(page(sub1, "t-mid", 0, rows.slice(0, 2)));
    await settle();

    const firstResync = outcome(viewer.resync());
    const secondResync = outcome(viewer.resync());
    const stopping = viewer.stop();
    await settle();
    const unsubscribes = (): number => pair.viewerSide.frames().filter((frame) => frame.type === "unsubscribe").length;
    assert.equal(unsubscribes(), 1, "overlapping retirements send exactly one unsubscribe");

    scripted.write({ type: "unsubscribed", subscriptionId: sub1 });
    await stopping;
    assert.equal(await first, "rejected:stopped", "the interrupted subscription settles");
    assert.equal(await firstResync, "rejected:stopped", "a resync cannot survive a stop");
    assert.equal(await secondResync, "rejected:stopped", "every overlapping caller settles");
    assert.equal(unsubscribes(), 1, "stop joined the outstanding retirement instead of starting a second one");
    assert.equal(viewer.subscriptionId, null, "no subscription survives stop");
    assert.equal(viewer.projection.state, "empty");
    assert.equal(viewer.projection.reason, "stopped");
    await assert.rejects(viewer.subscribe(),
      (error: unknown) => isRosterBridgeViewerError(error) && error.code === "stopped");
  } finally {
    await viewer.stop();
  }
});

test("stopping after the channel was lost keeps the loss as the terminal reason", async () => {
  const h = harness();
  try {
    await h.viewer.hello;
    await h.viewer.subscribe();
    await h.pair.viewerSide.close();
    await settle();
    assert.equal(h.viewer.projection.reason, "channel-closed");
    await h.viewer.stop();
    assert.equal(h.viewer.projection.reason, "channel-closed",
      "a stop cannot relabel lost certainty as a clean unsubscribe");
    assert.equal(h.viewer.projection.state, "stale");
    assert.equal(h.viewer.projection.rows.length, 3, "rows are never cleared by teardown");
  } finally {
    await h.owner.stopAll();
  }
});

test("a resync whose unsubscribe cannot be written closes the channel instead of replacing", async () => {
  const pair = channelPair();
  const viewer = attachRosterBridgeViewer({ channel: pair.viewerSide, bounds: FAST_BOUNDS });
  const scripted = new ScriptedPeer(pair.ownerSide);
  try {
    await viewer.hello;
    const firstPromise = viewer.subscribe();
    await settle();
    const sub1 = viewer.subscriptionId;
    assert.ok(sub1);
    const rows = remoteRows(["a", "b", "c"]);
    scripted.write(begin(sub1, "t-one", 3, 3, 1, RUN_A));
    scripted.write(page(sub1, "t-one", 0, rows));
    scripted.write(end(sub1, "t-one", 3, 3));
    const first = await firstPromise;
    assert.equal(first.state, "current");

    // The retirement notice itself is unwritable: this side cannot know whether the
    // owner still holds the subscription, so it must not open another one.
    pair.viewerSide.failNextSend = true;
    const resynced = outcome(viewer.resync());
    await until("the unconfirmed resync closed the channel", () => pair.viewerSide.closedCalls > 0);
    assert.equal(await resynced, "rejected:stopped", "the resync settles rather than hanging");
    assert.equal(pair.viewerSide.closedCalls, 1, "the channel is closed through its bounded API");
    const types = pair.viewerSide.types();
    assert.equal(types.filter((type) => type === "subscribe").length, 1,
      "no replacement subscription is attempted on a channel the owner may still be serving");
    assert.equal(viewer.projection.state, "stale", "observations are retained, never emptied");
    assert.equal(viewer.projection.reason, "channel-closed",
      "an unconfirmed stop is lost certainty, not a clean stop");
    assert.equal(viewer.projection.rows.length, 3);
    await assert.rejects(viewer.subscribe(),
      (error: unknown) => isRosterBridgeViewerError(error) && error.code === "stopped");
  } finally {
    await viewer.stop();
  }
});

test("a resync whose acknowledgement is withheld closes the channel instead of replacing", async () => {
  const pair = channelPair();
  const viewer = attachRosterBridgeViewer({ channel: pair.viewerSide, bounds: FAST_BOUNDS });
  // A scripted owner that never answers an unsubscribe at all.
  const scripted = new ScriptedPeer(pair.ownerSide);
  try {
    await viewer.hello;
    const firstPromise = viewer.subscribe();
    await settle();
    const sub1 = viewer.subscriptionId;
    assert.ok(sub1);
    const rows = remoteRows(["a", "b", "c"]);
    scripted.write(begin(sub1, "t-two", 3, 3, 1, RUN_A));
    scripted.write(page(sub1, "t-two", 0, rows));
    scripted.write(end(sub1, "t-two", 3, 3));
    const first = await firstPromise;
    assert.equal(first.state, "current");

    const resynced = outcome(viewer.resync());
    await until("the withheld acknowledgement closed the channel", () => pair.viewerSide.closedCalls > 0);
    assert.equal(await resynced, "rejected:stopped");
    assert.equal(pair.viewerSide.closedCalls, 1);
    assert.equal(pair.viewerSide.types().filter((type) => type === "subscribe").length, 1,
      "an unacknowledged retirement is never followed by a second subscription");
    assert.equal(viewer.projection.state, "stale");
    assert.equal(viewer.projection.reason, "channel-closed");
    assert.equal(viewer.projection.rows.length, 3);
  } finally {
    await viewer.stop();
  }
});

test("a stop whose acknowledgement is withheld closes the channel and reports the loss", async () => {
  const pair = channelPair();
  const viewer = attachRosterBridgeViewer({ channel: pair.viewerSide, bounds: FAST_BOUNDS });
  const scripted = new ScriptedPeer(pair.ownerSide);
  try {
    await viewer.hello;
    const firstPromise = viewer.subscribe();
    await settle();
    const sub1 = viewer.subscriptionId;
    assert.ok(sub1);
    const rows = remoteRows(["a", "b", "c"]);
    scripted.write(begin(sub1, "t-three", 3, 3, 1, RUN_A));
    scripted.write(page(sub1, "t-three", 0, rows));
    scripted.write(end(sub1, "t-three", 3, 3));
    const first = await firstPromise;
    assert.equal(first.state, "current");

    const stopping = viewer.stop();
    await until("the withheld acknowledgement closed the channel", () => pair.viewerSide.closedCalls > 0);
    await stopping;
    assert.equal(pair.viewerSide.closedCalls, 1,
      "a watch the owner was never told to release cannot be left behind silently");
    assert.equal(viewer.projection.state, "stale");
    assert.equal(viewer.projection.reason, "channel-closed",
      "stop reports the loss of certainty rather than a clean stop the owner never saw");
    assert.equal(viewer.projection.rows.length, 3, "stopping never clears the roster to empty");
    assert.equal(pair.viewerSide.handlerCount, 0);
  } finally {
    await viewer.stop();
  }
});

test("a replacement subscription is not stranded by an old write that settles late", async () => {
  // One row per page so the owner's first frame is a snapshot_begin whose send
  // promise can be held open while the subscription it belonged to is replaced.
  const h = harness({ bounds: { maxRowsPerPage: 1 } });
  try {
    await h.viewer.hello;
    h.pair.ownerSide.deferNextSend = true;
    const first = outcome(h.viewer.subscribe());
    await until("the first subscription was installed", () => h.viewer.subscriptionId !== null);
    assert.equal(h.pair.ownerSide.deferredWrites, 1, "one owner write is still outstanding");

    // Retire it and install a replacement while that write is still pending. The
    // acknowledgement travels normally; only the old data write is unsettled.
    const resyncPromise = h.viewer.resync();
    const resynced = outcome(resyncPromise);
    await until("the replacement subscription was installed", () => h.inventory.watches.length === 2);
    assert.equal(h.inventory.watches[0]?.unsubscribed, 1, "the retired watch was released once");

    // The old write finally settles. Its completion is what frees the channel's
    // single send slot, so it has to hand work to the replacement.
    h.pair.ownerSide.releaseDeferred();
    const snapshot = await mustSettle(resyncPromise, "the replacement published after the old write settled");
    assert.equal(snapshot.state, "current");
    assert.equal(snapshot.rows.length, 3);
    assert.equal(await first, "rejected:stopped", "the replaced subscription settled");
    assert.equal(await resynced, "resolved");
  } finally {
    await h.stop();
  }
});

test("a replacement subscription survives an old write that finally rejects", async () => {
  const h = harness({ bounds: { maxRowsPerPage: 1 } });
  try {
    await h.viewer.hello;
    h.pair.ownerSide.deferNextSend = true;
    const first = outcome(h.viewer.subscribe());
    await until("the first subscription was installed", () => h.viewer.subscriptionId !== null);
    const resyncPromise = h.viewer.resync();
    const resynced = outcome(resyncPromise);
    await until("the replacement subscription was installed", () => h.inventory.watches.length === 2);

    // The old write dies instead of draining. That failure belongs to a cancelled
    // transfer and must not end the replacement that is now waiting to send.
    h.pair.ownerSide.deferFailure = new Error("synthetic late send failure");
    h.pair.ownerSide.releaseDeferred();
    const snapshot = await mustSettle(resyncPromise, "the replacement published after the old write failed");
    assert.equal(snapshot.state, "current");
    assert.equal(snapshot.rows.length, 3, "the replacement roster is complete");
    assert.equal(h.pair.ownerSide.closedCalls, 0,
      "a late failure of a cancelled transfer does not close the live channel");
    assert.equal(await first, "rejected:stopped");
  } finally {
    await h.stop();
  }
});

test("stopping before the acknowledgement settles the hello and everything waiting on it", async () => {
  const pair = channelPair();
  const viewer = attachRosterBridgeViewer({ channel: pair.viewerSide, bounds: FAST_BOUNDS });
  const scripted = new ScriptedPeer(pair.ownerSide);
  scripted.autoAck = false;
  const subscribed = outcome(viewer.subscribe());
  await settle();
  await viewer.stop();
  await assert.rejects(viewer.hello,
    (error: unknown) => isRosterBridgeViewerError(error) && error.code === "stopped",
    "a hello that never got its acknowledgement must not hang a stopped viewer");
  assert.equal(await subscribed, "rejected:stopped", "everything chained to the hello settles too");
  assert.equal(viewer.projection.reason, "stopped");
  assert.equal(pair.viewerSide.handlerCount, 0, "the handler is released");
});

test("an owner whose terminal frame cannot be written closes the channel instead of going quiet", async () => {
  const h = harness({ rows: ["a", "b", "c"] });
  try {
    await h.viewer.hello;
    const first = await h.viewer.subscribe();
    assert.equal(first.state, "current");

    // The source goes away and the owner's only way to say so is unwritable.
    h.pair.ownerSide.failNextSend = true;
    h.inventory.emitUnavailable();
    await settle();
    assert.equal(h.pair.ownerSide.closedCalls, 1,
      "an unwritable abort ends the metadata session through the channel's bounded API");
    assert.equal(h.inventory.liveWatchCount, 0, "the watch is retired whether or not the write landed");
    assert.equal(h.viewer.projection.state, "stale", "the viewer cannot stay current on a session that ended");
    assert.equal(h.viewer.projection.reason, "channel-closed");
    assert.equal(h.viewer.projection.rows.length, 3, "an unwritable notification never becomes an empty roster");
    assert.ok(h.ownerDiagnostics.includes("send_failed"), "the failed write is recorded where it happened");
  } finally {
    await h.stop();
  }
});

test("an owner stop whose notification cannot be written still ends the channel", async () => {
  const h = harness({ rows: ["a", "b", "c"] });
  try {
    await h.viewer.hello;
    const first = await h.viewer.subscribe();
    assert.equal(first.state, "current");

    h.pair.ownerSide.failNextSend = true;
    await h.owner.stopAll();
    await settle();
    assert.equal(h.pair.ownerSide.closedCalls, 1, "an unwritable stop notification closes the metadata channel");
    assert.equal(h.inventory.liveWatchCount, 0, "the owner keeps no watch for a session it stopped");
    assert.equal(h.viewer.projection.state, "stale", "silence is never freshness");
    assert.equal(h.viewer.projection.reason, "channel-closed");
    assert.equal(h.viewer.projection.rows.length, 3);
  } finally {
    await h.stop();
  }
});
