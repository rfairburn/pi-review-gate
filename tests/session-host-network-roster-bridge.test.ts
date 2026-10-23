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
  ROSTER_BRIDGE_CLOSE_CAPABILITY,
  ROSTER_BRIDGE_CREATE_CAPABILITY,
  ROSTER_BRIDGE_KNOWN_OPTIONAL_CAPABILITIES,
  ROSTER_BRIDGE_MAJOR,
  ROSTER_BRIDGE_MINOR,
  ROSTER_BRIDGE_REQUIRED_CAPABILITY,
  ROSTER_BRIDGE_SAVED_CAPABILITY,
  ROSTER_BRIDGE_SERVICE,
  RosterBridgeProtocolError,
  buildRosterBridgeTransfer,
  decodeRosterBridgeFrame,
  encodeRosterBridgeFrame,
  isRosterBridgeIdentifier,
  isRosterBridgeProtocolError,
  negotiateRosterBridgeHello,
  packRosterBridgePages,
  resolveRosterBridgeBounds,
  reviewRosterBridgeHelloAck,
  rosterBridgeWireCodeForFailure,
  type RosterBridgeBounds,
  type RosterBridgeCloseRequestFrame,
  type RosterBridgeCloseResultFrame,
  type RosterBridgeCreateRequestFrame,
  type RosterBridgeCreateResultFrame,
  type RosterBridgeErrorCode,
  type RosterBridgeFrame,
  type RosterBridgeHelloFrame,
  type RosterBridgeSavedDeleteRequestFrame,
  type RosterBridgeSavedListRequestFrame,
  type RosterBridgeSavedResumeRequestFrame,
} from "../src/session-host/network/roster-bridge-protocol";
import type { OwnerCloseFacts, OwnerCloseHandler, OwnerCloseRequest } from "../src/session-host/network/peer-close";
import type { OwnerCreateFacts, OwnerCreateHandler, OwnerCreateRequest } from "../src/session-host/network/peer-create";
import type {
  OwnerSavedAuthorizationGuard,
  OwnerSavedCatalogView,
  OwnerSavedDeleteFacts,
  OwnerSavedDeleteRequest,
  OwnerSavedEntry,
  OwnerSavedListRequest,
  OwnerSavedPolicy,
  OwnerSavedResumeFacts,
  OwnerSavedResumeRequest,
  OwnerSavedSearchRequest,
  OwnerSavedWindowFacts,
  OwnerSavedWindowRequest,
} from "../src/session-host/network/peer-saved";
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
  readonly lane = "app";
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
  closeResultTimeoutMs: 200,
  createResultTimeoutMs: 200,
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
  close?: OwnerCloseHandler;
  create?: OwnerCreateHandler;
  capabilities?: readonly string[];
  /** Optional Saved provider; supplied together with `deletePolicy` (default Off). */
  saved?: FakeSavedProvider;
  deletePolicy?: () => boolean;
} = {}) {
  const pair = channelPair();
  const inventory = new FakeInventory();
  inventory.rows = (options.rows ?? ["row-1", "row-2", "row-3"]).map((id) => ownerRow(id));
  const ownerDiagnostics: string[] = [];
  const viewerDiagnostics: string[] = [];
  const savedPolicies: (OwnerSavedPolicy | undefined)[] = [];
  const authorize = options.authorize ?? (() => true);
  const owner = createRosterBridgeHost({
    inventory,
    authorizePeer: authorize,
    bounds: { ...FAST_BOUNDS, ...options.bounds },
    ...(options.close === undefined ? {} : { closeOwnedSession: options.close }),
    ...(options.create === undefined ? {} : { createOwnedSession: options.create }),
    ...(options.saved === undefined ? {} : {
      savedCatalogView: options.saved.factory,
      remoteHistoryDeleteExposed: options.deletePolicy ?? (() => false),
    }),
    onDiagnostic: (event) => {
      ownerDiagnostics.push(event.code);
    },
  });
  const binding = owner.attach(pair.ownerSide);
  const viewer = attachRosterBridgeViewer({
    channel: pair.viewerSide,
    bounds: { ...FAST_BOUNDS, ...options.bounds },
    ...(options.capabilities === undefined ? {} : { capabilities: options.capabilities }),
    onDiagnostic: (event) => {
      viewerDiagnostics.push(event.code);
    },
    onSavedPolicy: (policy) => {
      savedPolicies.push(policy);
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
    savedPolicies,
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

// --- owner Close RPC over the same roster lane -------------------------------

function closeRequest(overrides: Partial<RosterBridgeCloseRequestFrame> = {}): RosterBridgeCloseRequestFrame {
  return { type: "close_request", requestId: "req-1", hostRunId: RUN_A, rowId: "row-1", confirmed: false, ...overrides };
}

function closeResult(requestId: string, facts: OwnerCloseFacts): RosterBridgeCloseResultFrame {
  return { type: "close_result", requestId, outcome: facts };
}

/** True only for the protocol's own fixed refusal of a frame it cannot carry. */
function refusedFrame(frame: unknown): boolean {
  try {
    decodeRosterBridgeFrame(encodeFrameOrThrow(frame));
    return false;
  } catch (error) {
    return isRosterBridgeProtocolError(error) && error.code === "bad_frame";
  }
}

test("Close is an optional capability with fixed framing and no version or metadata meaning", () => {
  assert.deepEqual([...ROSTER_BRIDGE_KNOWN_OPTIONAL_CAPABILITIES],
    [ROSTER_BRIDGE_CLOSE_CAPABILITY, ROSTER_BRIDGE_CREATE_CAPABILITY, ROSTER_BRIDGE_SAVED_CAPABILITY]);
  const decision = negotiateRosterBridgeHello(helloFrame([ROSTER_BRIDGE_REQUIRED_CAPABILITY, ROSTER_BRIDGE_CLOSE_CAPABILITY]));
  assert.equal(decision.ok, true);
  assert.deepEqual(decision.ok ? decision.capabilities : null, [ROSTER_BRIDGE_CLOSE_CAPABILITY]);
  // A minor version alone still grants nothing, and the major version is unchanged.
  assert.equal(ROSTER_BRIDGE_MINOR, 0);
  assert.equal(negotiateRosterBridgeHello({ ...helloFrame([ROSTER_BRIDGE_REQUIRED_CAPABILITY]), minor: 99 }).ok, true);

  // The result deadline is one more validated finite bound, not a lifetime.
  assert.equal(DEFAULT_ROSTER_BRIDGE_BOUNDS.closeResultTimeoutMs, 15_000);
  assert.equal(resolveRosterBridgeBounds({ closeResultTimeoutMs: 1 }).closeResultTimeoutMs, 1);
  for (const value of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.throws(() => resolveRosterBridgeBounds({ closeResultTimeoutMs: value }),
      (error: unknown) => isRosterBridgeProtocolError(error) && error.code === "invalid_bounds");
  }

  const request = closeRequest({ confirmed: true });
  assert.deepEqual(decodeRosterBridgeFrame(encodeRosterBridgeFrame(request)), request);
  assert.deepEqual(decodeRosterBridgeFrame(encodeRosterBridgeFrame(closeResult("req-1", { kind: "stopped-retained" }))),
    { type: "close_result", requestId: "req-1", outcome: { kind: "stopped-retained" } });
  // The opaque identifier rule is the same 64-byte rule the metadata lane uses.
  assert.equal(isRosterBridgeIdentifier("row-1"), true);
  assert.equal(isRosterBridgeIdentifier("x".repeat(64)), true);
  assert.equal(isRosterBridgeIdentifier("x".repeat(65)), false);
});

test("close frames refuse any shape outside their closed schema", () => {
  for (const extra of [{ payload: "x" }, { error: "boom" }, { signal: "TERM" }, { path: "/tmp/x" }, { nativeSession: {} }, { force: true }]) {
    assert.equal(refusedFrame({ ...closeRequest(), ...extra }), true, `${JSON.stringify(extra)} must never decode`);
    assert.equal(refusedFrame({ ...closeResult("req-1", { kind: "removed" }), ...extra }), true);
  }
  for (const requestId of ["", "-lead", "has space", "x".repeat(65), 7, null]) {
    assert.equal(refusedFrame(closeRequest({ requestId: requestId as never })), true, `${String(requestId)} must never decode`);
  }
  for (const field of ["hostRunId", "rowId"] as const) {
    for (const value of ["", "x".repeat(65), 3, null]) {
      assert.equal(refusedFrame({ ...closeRequest(), [field]: value }), true, `${field}=${String(value)} must never decode`);
    }
  }
  for (const confirmed of [1, 0, "true", null, undefined]) {
    assert.equal(refusedFrame({ ...closeRequest(), confirmed }), true, `confirmed=${String(confirmed)} must never decode`);
  }
  for (const outcome of [
    {},
    { kind: "removed", extra: 1 },
    { kind: "forced" },
    { kind: "REMOVED" },
    { kind: "removed " },
    "removed",
    [],
    null,
  ]) {
    assert.equal(refusedFrame({ type: "close_result", requestId: "req-1", outcome }), true,
      `${JSON.stringify(outcome)} must never decode`);
  }
  // The encoder refuses the same closed schema for a frame this side built wrongly.
  assert.throws(() => encodeRosterBridgeFrame({ ...closeRequest(), confirmed: "yes" } as never),
    (error: unknown) => isRosterBridgeProtocolError(error) && error.code === "invalid_frame");
  assert.throws(() => encodeRosterBridgeFrame(closeResult("req-1", { kind: "forced" } as never)),
    (error: unknown) => isRosterBridgeProtocolError(error) && error.code === "invalid_frame");
});

test("a provider-less owner never acknowledges Close and an old viewer is never sent one", async () => {
  const h = harness({ rows: ["row-1"] });
  try {
    await h.viewer.hello;
    assert.equal(h.viewer.supportsClose, false);
    assert.deepEqual(h.viewer.capabilities, [ROSTER_BRIDGE_REQUIRED_CAPABILITY]);
    const refused = await h.viewer.closeSession({ hostRunId: h.inventory.hostRunId, rowId: "row-1", confirmed: false });
    assert.deepEqual(refused, { kind: "not-sent", reason: "capability-unsupported" });
    await settle();
    assert.deepEqual(h.pair.viewerSide.types(), ["hello"], "no close frame exists to send without the negotiation");
    assert.equal(h.binding.subscribed, false, "refusing a close changes no metadata state");
    // An ordinary subscription still works exactly as before.
    const snapshot = await h.viewer.subscribe();
    assert.equal(snapshot.state, "current");
  } finally {
    await h.stop();
  }
});

test("an old viewer that never offers Close is refused outside the negotiated protocol", async () => {
  const pair = channelPair();
  const inventory = new FakeInventory();
  inventory.rows = [ownerRow("row-1")];
  const calls: OwnerCloseRequest[] = [];
  const owner = createRosterBridgeHost({
    inventory,
    authorizePeer: () => true,
    bounds: FAST_BOUNDS,
    closeOwnedSession: async (request) => {
      calls.push(request);
      return { kind: "removed" };
    },
  });
  const binding = owner.attach(pair.ownerSide);
  const scripted = new ScriptedPeer(pair.viewerSide);
  try {
    scripted.write(helloFrame());
    await settle();
    const ack = pair.ownerSide.frames()[0];
    assert.ok(ack !== undefined && ack.type === "hello_ack");
    assert.deepEqual(ack.capabilities, [ROSTER_BRIDGE_REQUIRED_CAPABILITY],
      "a viewer that offered no Close support is acknowledged with the baseline only");
    scripted.write(closeRequest());
    await settle();
    assert.deepEqual(calls, [], "nothing outside the negotiated protocol reaches the provider");
    const frames = pair.ownerSide.frames();
    assert.ok(frames.some((frame) => frame.type === "error" && frame.code === "bad_frame"),
      "a close frame on a channel that never negotiated it is refused once");
    assert.equal(pair.ownerSide.frames().some((frame) => frame.type === "close_result"), false);
    assert.equal(binding.subscribed, false);
    assert.equal(pair.ownerSide.closedCalls, 1, "the violating channel is closed once through its bounded API");
  } finally {
    await owner.stopAll();
  }
});

test("only the exact requested run, row, and confirmation reach the owner provider", async () => {
  const calls: OwnerCloseRequest[] = [];
  const h = harness({
    close: async (request) => {
      calls.push(request);
      return { kind: "confirmation-required" };
    },
  });
  try {
    await h.viewer.hello;
    assert.equal(h.viewer.supportsClose, true);
    assert.deepEqual(h.viewer.capabilities, [ROSTER_BRIDGE_REQUIRED_CAPABILITY, ROSTER_BRIDGE_CLOSE_CAPABILITY]);
    await h.viewer.subscribe();
    const first = await h.viewer.closeSession({ hostRunId: h.inventory.hostRunId, rowId: "row-2", confirmed: false });
    assert.deepEqual(first, { kind: "owner-result", facts: { kind: "confirmation-required" } });
    const second = await h.viewer.closeSession({ hostRunId: h.inventory.hostRunId, rowId: "row-2", confirmed: true });
    assert.deepEqual(second, { kind: "owner-result", facts: { kind: "confirmation-required" } });
    assert.deepEqual(calls, [
      { hostRunId: h.inventory.hostRunId, rowId: "row-2", confirmed: false },
      { hostRunId: h.inventory.hostRunId, rowId: "row-2", confirmed: true },
    ]);
    // Every request has its own correlation id, and nothing else rides the wire.
    const requests = h.pair.viewerSide.frames().filter((frame) => frame.type === "close_request");
    assert.equal(requests.length, 2);
    const ids = requests.map((frame) => (frame.type === "close_request" ? frame.requestId : ""));
    assert.equal(new Set(ids).size, 2, "each request gets a fresh id");
    assert.deepEqual([...new Set(h.pair.viewerSide.types())].sort(), ["close_request", "hello", "subscribe"],
      "the requester writes only its own request frames");
    // The projection is untouched by a close: only a new owner snapshot changes rows.
    assert.deepEqual(h.viewer.projection.rows.map((row) => row.id), ["row-1", "row-2", "row-3"]);
    assert.equal(h.viewer.projection.state, "current");
  } finally {
    await h.stop();
  }
});

test("metadata acknowledgements and projections continue while the owner provider holds a close", async () => {
  let release: (facts: OwnerCloseFacts) => void = () => undefined;
  const calls: OwnerCloseRequest[] = [];
  const h = harness({
    close: (request) => {
      calls.push(request);
      return new Promise<OwnerCloseFacts>((resolve) => {
        release = resolve;
      });
    },
  });
  try {
    await h.viewer.hello;
    const first = await h.viewer.subscribe();
    const pending = h.viewer.closeSession({ hostRunId: h.inventory.hostRunId, rowId: "row-1", confirmed: false });
    // The provider call is what proves the request was admitted; `ownerSide.types()`
    // records frames the OWNER wrote, so it never shows the requester's request.
    await until("the close reaches the owner provider", () => calls.length === 1);
    assert.equal(h.pair.ownerSide.types().includes("close_request"), false,
      "the request is written by the requester, never echoed by the owner");
    // The ordered receive path is not blocked: a fresh authoritative snapshot is
    // still published while the owner provider owns the operation.
    h.inventory.rows = [ownerRow("row-1"), ownerRow("row-3")];
    h.inventory.emit();
    const refreshed = await until("a newer snapshot is published during the close", () => h.viewer.projection.rows.length === 2)
      .then(() => h.viewer.projection);
    assert.equal(refreshed.state, "current");
    assert.deepEqual(refreshed.rows.map((row) => row.id), ["row-1", "row-3"]);
    assert.notEqual(refreshed.revision, first.revision);
    assert.equal(h.pair.ownerSide.types().includes("close_result"), false, "no result exists before the provider answers");
    release({ kind: "removed" });
    assert.deepEqual(await mustSettle(pending, "the held close result"), { kind: "owner-result", facts: { kind: "removed" } });
  } finally {
    await h.stop();
  }
});

test("concurrent closes for different rows are independent and a duplicate row is busy", async () => {
  const held = new Map<string, (facts: OwnerCloseFacts) => void>();
  const calls: OwnerCloseRequest[] = [];
  const h = harness({
    rows: ["row-1", "row-2", "row-3"],
    close: (request) => {
      calls.push(request);
      return new Promise<OwnerCloseFacts>((resolve) => {
        held.set(request.rowId, resolve);
      });
    },
  });
  try {
    await h.viewer.hello;
    await h.viewer.subscribe();
    const run = h.inventory.hostRunId;
    const one = h.viewer.closeSession({ hostRunId: run, rowId: "row-1", confirmed: false });
    const two = h.viewer.closeSession({ hostRunId: run, rowId: "row-2", confirmed: false });
    await until("both closes reach the provider", () => calls.length === 2);
    // The requester's own per-row fence refuses a duplicate without submitting one.
    assert.deepEqual(await h.viewer.closeSession({ hostRunId: run, rowId: "row-1", confirmed: true }),
      { kind: "not-sent", reason: "busy" });
    assert.equal(calls.length, 2, "a duplicate row never reaches the provider");
    // Each answer settles its own row, in either order.
    held.get("row-2")?.({ kind: "refused" });
    held.get("row-1")?.({ kind: "stopped-retained" });
    assert.deepEqual(await mustSettle(two, "row-2 result"), { kind: "owner-result", facts: { kind: "refused" } });
    assert.deepEqual(await mustSettle(one, "row-1 result"), { kind: "owner-result", facts: { kind: "stopped-retained" } });
    assert.deepEqual(calls.map((call) => call.rowId).sort(), ["row-1", "row-2"]);
  } finally {
    await h.stop();
  }
});

test("the owner answers a duplicate request id or row busy without a second ladder", async () => {
  const pair = channelPair();
  const inventory = new FakeInventory();
  inventory.rows = [ownerRow("row-1"), ownerRow("row-2")];
  const calls: OwnerCloseRequest[] = [];
  const held = new Map<string, (facts: OwnerCloseFacts) => void>();
  const owner = createRosterBridgeHost({
    inventory,
    authorizePeer: () => true,
    // The owner's own in-flight close bookkeeping uses the same existing row bound.
    bounds: { ...FAST_BOUNDS, maxRowsPerPage: 2, maxSnapshotRows: 2 },
    closeOwnedSession: (request) => {
      calls.push(request);
      return new Promise<OwnerCloseFacts>((resolve) => {
        held.set(request.rowId, resolve);
      });
    },
  });
  const binding = owner.attach(pair.ownerSide);
  const scripted = new ScriptedPeer(pair.viewerSide);
  try {
    scripted.write(helloFrame([ROSTER_BRIDGE_REQUIRED_CAPABILITY, ROSTER_BRIDGE_CLOSE_CAPABILITY]));
    await settle();
    const run = inventory.hostRunId;
    scripted.write(closeRequest({ requestId: "req-1", hostRunId: run, rowId: "row-1" }));
    await until("the first close reaches the provider", () => calls.length === 1);
    scripted.write(closeRequest({ requestId: "req-1", hostRunId: run, rowId: "row-1" }));
    scripted.write(closeRequest({ requestId: "req-2", hostRunId: run, rowId: "row-1" }));
    await settle();
    const results = pair.ownerSide.frames().filter((frame) => frame.type === "close_result");
    assert.deepEqual(results.map((frame) => (frame.type === "close_result" ? [frame.requestId, frame.outcome.kind] : [])),
      [["req-1", "busy"], ["req-2", "busy"]]);
    assert.equal(calls.length, 1, "a duplicate never starts a second stop ladder");
    // A different row is still independent while the first is held.
    scripted.write(closeRequest({ requestId: "req-3", hostRunId: run, rowId: "row-2" }));
    await until("the second row reaches the provider", () => calls.length === 2);
    // The bound is now full: overflow is refused rather than queued or evicted.
    scripted.write(closeRequest({ requestId: "req-4", hostRunId: run, rowId: "row-9" }));
    await until("the overflow is refused", () => pair.ownerSide.frames()
      .filter((frame) => frame.type === "close_result").length === 3);
    assert.deepEqual(pair.ownerSide.frames()
      .filter((frame) => frame.type === "close_result")
      .map((frame) => (frame.type === "close_result" ? [frame.requestId, frame.outcome.kind] : [])),
    [["req-1", "busy"], ["req-2", "busy"], ["req-4", "refused"]]);
    assert.equal(calls.length, 2, "an overflow never reaches the provider");
    held.get("row-1")?.({ kind: "unconfirmed" });
    await until("the held result is written", () => pair.ownerSide.frames()
      .filter((frame) => frame.type === "close_result").length === 4);
    const written = pair.ownerSide.frames().filter((frame) => frame.type === "close_result");
    assert.deepEqual(written.map((frame) => (frame.type === "close_result" ? [frame.requestId, frame.outcome.kind] : [])),
      [["req-1", "busy"], ["req-2", "busy"], ["req-4", "refused"], ["req-1", "unconfirmed"]]);
    assert.equal(binding.subscribed, false, "close traffic never subscribes or unsubscribes metadata");
  } finally {
    await owner.stopAll();
  }
});

test("close bookkeeping is bounded by the existing row bound and refuses overflow", async () => {
  const held: (() => void)[] = [];
  const h = harness({
    rows: ["row-1", "row-2"],
    bounds: { maxRowsPerPage: 2, maxSnapshotRows: 2 },
    close: () => new Promise<OwnerCloseFacts>((resolve) => {
      held.push(() => resolve({ kind: "unknown" }));
    }),
  });
  try {
    await h.viewer.hello;
    await h.viewer.subscribe();
    const run = h.inventory.hostRunId;
    const one = h.viewer.closeSession({ hostRunId: run, rowId: "row-1", confirmed: false });
    const two = h.viewer.closeSession({ hostRunId: run, rowId: "row-2", confirmed: false });
    await until("both bounded closes are outstanding", () => held.length === 2);
    // The requester's pending map is full: nothing is queued, evicted, or retargeted.
    assert.deepEqual(await h.viewer.closeSession({ hostRunId: run, rowId: "row-3", confirmed: false }),
      { kind: "not-sent", reason: "row-limit" });
    for (const release of held) release();
    assert.deepEqual(await mustSettle(one, "row-1 bounded result"), { kind: "owner-result", facts: { kind: "unknown" } });
    assert.deepEqual(await mustSettle(two, "row-2 bounded result"), { kind: "owner-result", facts: { kind: "unknown" } });
    assert.equal(h.pair.viewerSide.frames().filter((frame) => frame.type === "close_request").length, 2);
  } finally {
    await h.stop();
  }
});

test("a close the owner never authorized calls no provider and writes no result", async () => {
  let allowed = true;
  const calls: OwnerCloseRequest[] = [];
  const h = harness({
    authorize: () => allowed,
    close: async (request) => {
      calls.push(request);
      return { kind: "removed" };
    },
  });
  try {
    await h.viewer.hello;
    await h.viewer.subscribe();
    allowed = false;
    const result = await mustSettle(
      h.viewer.closeSession({ hostRunId: h.inventory.hostRunId, rowId: "row-1", confirmed: true }),
      "an unauthorized close settles",
    );
    assert.deepEqual(result, { kind: "unknown" }, "an unanswered request is never a fabricated refusal");
    assert.deepEqual(calls, [], "the revoke is checked before the provider is reached");
    assert.equal(h.pair.ownerSide.frames().some((frame) => frame.type === "close_result"), false,
      "an unauthorized request produces no reply at all");
    assert.ok(h.ownerDiagnostics.includes("close_refused"));
  } finally {
    await h.stop();
  }
});

test("a revoke during an accepted close lets the operation finish but drops the reply", async () => {
  let allowed = true;
  let release: (facts: OwnerCloseFacts) => void = () => undefined;
  const calls: OwnerCloseRequest[] = [];
  const h = harness({
    authorize: () => allowed,
    close: (request) => {
      calls.push(request);
      return new Promise<OwnerCloseFacts>((resolve) => {
        release = resolve;
      });
    },
  });
  try {
    await h.viewer.hello;
    await h.viewer.subscribe();
    const pending = h.viewer.closeSession({ hostRunId: h.inventory.hostRunId, rowId: "row-1", confirmed: false });
    await until("the accepted close reaches the provider", () => calls.length === 1);
    // The receiving grant is revoked while Main still owns the operation. Nothing
    // cancels, rolls back, or reports an exit for work already accepted.
    allowed = false;
    release({ kind: "removed" });
    assert.deepEqual(await mustSettle(pending, "the late reply is dropped"), { kind: "unknown" });
    assert.equal(h.pair.ownerSide.frames().some((frame) => frame.type === "close_result"), false,
      "a reply after the revoke is dropped rather than written");
    assert.deepEqual(calls, [{ hostRunId: h.inventory.hostRunId, rowId: "row-1", confirmed: false }],
      "the accepted operation itself was neither re-run nor cancelled");
    assert.ok(h.ownerDiagnostics.includes("close_refused"));
  } finally {
    await h.stop();
  }
});

test("stopping the channel never cancels or awaits an accepted close", async () => {
  const calls: OwnerCloseRequest[] = [];
  let settled = false;
  const h = harness({
    close: (request) => {
      calls.push(request);
      return new Promise<OwnerCloseFacts>((resolve) => {
        setTimeout(() => {
          settled = true;
          resolve({ kind: "stopped-retained" });
        }, 40);
      });
    },
  });
  try {
    await h.viewer.hello;
    await h.viewer.subscribe();
    const pending = h.viewer.closeSession({ hostRunId: h.inventory.hostRunId, rowId: "row-1", confirmed: false });
    await until("the accepted close reaches the provider", () => calls.length === 1);
    // The binding's own stop is a network-delivery stop: it resolves without
    // waiting for the provider, and Main keeps owning the row.
    await h.owner.stopAll();
    assert.equal(settled, false, "stopAll does not wait for the owner's operation");
    // The requester settles honestly as unknown: the reply can no longer arrive.
    assert.deepEqual(await mustSettle(pending, "a stopped channel settles its close"), { kind: "unknown" });
    await until("the owner operation still completes on its own", () => settled);
    assert.deepEqual(calls.length, 1);
    assert.equal(h.pair.ownerSide.frames().some((frame) => frame.type === "close_result"), false,
      "a finished binding writes no close result");
  } finally {
    await h.stop();
  }
});

test("an unsolicited, foreign, or expired close result settles nothing", async () => {
  const pair = channelPair();
  // A wider deadline than FAST_BOUNDS so the scripted replies below can never race it.
  const viewer = attachRosterBridgeViewer({
    channel: pair.viewerSide,
    bounds: { ...FAST_BOUNDS, closeResultTimeoutMs: 800 },
  });
  const scripted = new ScriptedPeer(pair.ownerSide);
  scripted.autoAck = false;
  scripted.onHello(() => {
    scripted.write({
      type: "hello_ack",
      service: ROSTER_BRIDGE_SERVICE,
      major: ROSTER_BRIDGE_MAJOR,
      minor: ROSTER_BRIDGE_MINOR,
      capabilities: [ROSTER_BRIDGE_REQUIRED_CAPABILITY, ROSTER_BRIDGE_CLOSE_CAPABILITY],
    });
  });
  try {
    await mustSettle(viewer.hello, "the handshake");
    assert.equal(viewer.supportsClose, true);
    let settled: string | null = null;
    const pending = viewer.closeSession({ hostRunId: RUN_A, rowId: "row-1", confirmed: false });
    void pending.then((result) => {
      settled = JSON.stringify(result);
    });
    await until("the close frame is received by the owner", () => scripted.received.some((frame) => frame.type === "close_request"));
    const request = scripted.received.find((frame) => frame.type === "close_request");
    assert.ok(request !== undefined && request.type === "close_request");
    // A foreign request id and a duplicated copy of an unrelated id resolve nothing.
    scripted.write(closeResult("not-this-request", { kind: "removed" }));
    scripted.write(closeResult("00000000-0000-4000-8000-000000000000", { kind: "removed" }));
    await settle();
    assert.equal(settled, null, "an unsolicited reply can never settle another operation");
    // The owner's real answer for this id does.
    scripted.write(closeResult(request.requestId, { kind: "removed" }));
    await until("the matching result settles", () => settled !== null);
    assert.deepEqual(JSON.parse(settled ?? "null"), { kind: "owner-result", facts: { kind: "removed" } });
    // A duplicated copy of that same id after settlement resolves nothing again.
    scripted.write(closeResult(request.requestId, { kind: "refused" }));
    await settle();
    assert.deepEqual(JSON.parse(settled ?? "null"), { kind: "owner-result", facts: { kind: "removed" } });
  } finally {
    scripted.confirmUnsubscribes();
    await viewer.stop();
  }
});

test("a lost result is unknown after a finite deadline and is never replayed", async () => {
  const pair = channelPair();
  const viewer = attachRosterBridgeViewer({ channel: pair.viewerSide, bounds: FAST_BOUNDS });
  const scripted = new ScriptedPeer(pair.ownerSide);
  scripted.autoAck = false;
  scripted.onHello(() => {
    scripted.write({
      type: "hello_ack",
      service: ROSTER_BRIDGE_SERVICE,
      major: ROSTER_BRIDGE_MAJOR,
      minor: ROSTER_BRIDGE_MINOR,
      capabilities: [ROSTER_BRIDGE_REQUIRED_CAPABILITY, ROSTER_BRIDGE_CLOSE_CAPABILITY],
    });
  });
  try {
    await mustSettle(viewer.hello, "the handshake");
    const result = await mustSettle(
      viewer.closeSession({ hostRunId: RUN_A, rowId: "row-1", confirmed: false }),
      "a silent owner settles the close at its deadline",
    );
    assert.deepEqual(result, { kind: "unknown" });
    const requests = scripted.received.filter((frame) => frame.type === "close_request");
    assert.equal(requests.length, 1, "nothing is re-sent for an unanswered close");
    // A result that arrives after the deadline is dropped, not resurrected.
    const request = requests[0];
    assert.ok(request !== undefined && request.type === "close_request");
    scripted.write(closeResult(request.requestId, { kind: "removed" }));
    await settle();
    assert.equal(viewer.projection.rows.length, 0, "no late reply invents a roster or removes a row");
  } finally {
    scripted.confirmUnsubscribes();
    await viewer.stop();
  }
});

test("a submitted write that is refused is unknown, while pre-submission refusals are not-sent", async () => {
  const h = harness({ close: async () => ({ kind: "removed" }) });
  try {
    await h.viewer.hello;
    await h.viewer.subscribe();
    const run = h.inventory.hostRunId;
    // Invalid ids and non-boolean confirmation never become frames.
    assert.deepEqual(await h.viewer.closeSession({ hostRunId: "-bad", rowId: "row-1", confirmed: false }),
      { kind: "not-sent", reason: "invalid-request" });
    assert.deepEqual(await h.viewer.closeSession({ hostRunId: run, rowId: "row-1", confirmed: "yes" as never }),
      { kind: "not-sent", reason: "invalid-request" });
    assert.equal(h.pair.viewerSide.frames().filter((frame) => frame.type === "close_request").length, 0);
    // A transport that refuses the write after it was invoked cannot be claimed as
    // "never submitted": the owner may have accepted it.
    h.pair.viewerSide.failNextSend = true;
    assert.deepEqual(await mustSettle(h.viewer.closeSession({ hostRunId: run, rowId: "row-1", confirmed: false }),
      "a refused write settles"), { kind: "unknown" });
    assert.equal(h.pair.viewerSide.frames().filter((frame) => frame.type === "close_request").length, 0);
    // A stopped viewer is positively not-sent and never writes at all.
    await h.viewer.stop();
    assert.deepEqual(await h.viewer.closeSession({ hostRunId: run, rowId: "row-1", confirmed: false }),
      { kind: "not-sent", reason: "not-ready" });
  } finally {
    await h.owner.stopAll();
  }
});

test("a close result never removes a row on its own; only the owner's snapshot does", async () => {
  const h = harness({ close: async () => ({ kind: "removed" }) });
  try {
    await h.viewer.hello;
    const first = await h.viewer.subscribe();
    assert.deepEqual(first.rows.map((row) => row.id), ["row-1", "row-2", "row-3"]);
    const result = await h.viewer.closeSession({ hostRunId: h.inventory.hostRunId, rowId: "row-2", confirmed: false });
    assert.deepEqual(result, { kind: "owner-result", facts: { kind: "removed" } });
    assert.deepEqual(h.viewer.projection.rows.map((row) => row.id), ["row-1", "row-2", "row-3"],
      "an owner result is never an optimistic local removal");
    assert.equal(h.viewer.projection.state, "current");
    // The owner's next authoritative snapshot is what removes the row.
    h.inventory.rows = [ownerRow("row-1"), ownerRow("row-3")];
    h.inventory.emit();
    await until("the owner snapshot lands", () => h.viewer.projection.rows.length === 2);
    assert.deepEqual(h.viewer.projection.rows.map((row) => row.id), ["row-1", "row-3"]);
  } finally {
    await h.stop();
  }
});

test("a close queued behind a held write is never submitted after stop", async () => {
  const calls: OwnerCloseRequest[] = [];
  const h = harness({
    bounds: { stopAckTimeoutMs: 5_000 },
    close: async (request) => {
      calls.push(request);
      return { kind: "removed" };
    },
  });
  try {
    await h.viewer.hello;
    const snapshot = await h.viewer.subscribe();
    assert.equal(snapshot.state, "current");
    // Occupy the single ordered send slot so the next control write waits in the
    // queue and has NOT yet been handed to the transport.
    h.pair.viewerSide.hold = true;
    const resyncing = h.viewer.resync();
    void resyncing.catch(() => undefined);
    await settle();
    const closing = h.viewer.closeSession({ hostRunId: h.inventory.hostRunId, rowId: "row-1", confirmed: false });
    await settle();
    assert.equal(h.pair.viewerSide.types().filter((type) => type === "close_request").length, 0,
      "the queued close has not been submitted yet");
    // stop() latches synchronously and settles outstanding closes at once.
    const stopping = h.viewer.stop();
    assert.deepEqual(await mustSettle(closing, "a stopped viewer settles its queued close"), { kind: "unknown" });
    h.pair.viewerSide.release();
    await mustSettle(stopping, "the stop settles");
    await settle();
    assert.equal(h.pair.viewerSide.types().filter((type) => type === "close_request").length, 0,
      "a close whose lifetime ended while queued is discarded at dispatch");
    assert.deepEqual(calls, [], "no owner provider was ever reached");
  } finally {
    await h.owner.stopAll();
  }
});

test("a close that times out while queued is never submitted when the queue drains", async () => {
  const calls: OwnerCloseRequest[] = [];
  const h = harness({
    bounds: { stopAckTimeoutMs: 5_000 },
    close: async (request) => {
      calls.push(request);
      return { kind: "removed" };
    },
  });
  try {
    await h.viewer.hello;
    await h.viewer.subscribe();
    h.pair.viewerSide.hold = true;
    const resyncing = h.viewer.resync();
    void resyncing.catch(() => undefined);
    await settle();
    const closing = h.viewer.closeSession({ hostRunId: h.inventory.hostRunId, rowId: "row-1", confirmed: false });
    await settle();
    // Its own finite deadline elapses while it is still waiting to be written.
    assert.deepEqual(await mustSettle(closing, "a queued close settles at its deadline"), { kind: "unknown" });
    // Draining the queue must not deliver it late: its lifetime is over.
    h.pair.viewerSide.release();
    await settle();
    assert.equal(h.pair.viewerSide.types().filter((type) => type === "close_request").length, 0,
      "an expired queued close is invalidated, not delivered");
    assert.deepEqual(calls, [], "nothing reached the owner provider");
  } finally {
    await h.stop();
  }
});

test("a replaced destination at dispatch time refuses the queued close before submission", async () => {
  const calls: OwnerCloseRequest[] = [];
  const h = harness({
    bounds: { stopAckTimeoutMs: 5_000 },
    close: async (request) => {
      calls.push(request);
      return { kind: "removed" };
    },
  });
  try {
    await h.viewer.hello;
    await h.viewer.subscribe();
    h.pair.viewerSide.hold = true;
    const resyncing = h.viewer.resync();
    void resyncing.catch(() => undefined);
    await settle();
    // A caller fence standing in for the coordinator's captured destination, pin,
    // identity, channel, and epoch.
    let current = true;
    const closing = h.viewer.closeSession(
      { hostRunId: h.inventory.hostRunId, rowId: "row-1", confirmed: false },
      { stillCurrent: () => current },
    );
    await settle();
    assert.equal(h.pair.viewerSide.types().filter((type) => type === "close_request").length, 0);
    // The destination is replaced while the request is still queued.
    current = false;
    h.pair.viewerSide.release();
    assert.deepEqual(await mustSettle(closing, "the replaced destination settles the close"),
      { kind: "not-sent", reason: "target-unavailable" });
    await settle();
    assert.equal(h.pair.viewerSide.types().filter((type) => type === "close_request").length, 0,
      "a fence that no longer holds is checked before the transport write");
    assert.deepEqual(calls, [], "no provider was reached for a replaced destination");
  } finally {
    await h.stop();
  }
});

// --- rowless owner create over the existing roster channel -------------------

const ASTRAL = "\u{1f5c2}";
/** The one explicit opt-in a caller needs to offer the optional create exchange. */
const CREATE_CAPS: readonly string[] = [ROSTER_BRIDGE_CREATE_CAPABILITY];

function createFrame(overrides: Partial<RosterBridgeCreateRequestFrame> = {}): RosterBridgeCreateRequestFrame {
  return {
    type: "create_request",
    requestId: "create-1",
    hostRunId: RUN_A,
    workspace: "/srv/owner/new-child",
    sequence: 1,
    ...overrides,
  };
}

function createResult(requestId: string, facts: OwnerCreateFacts): RosterBridgeCreateResultFrame {
  return { type: "create_result", requestId, outcome: facts };
}

test("Create is an optional capability a provider-less owner never acknowledges and a caller must opt in", async () => {
  const h = harness();
  try {
    await h.viewer.hello;
    assert.equal(h.viewer.supportsCreate, false);
    // The default viewer does not even offer the exchange, so nothing changes.
    assert.deepEqual(h.viewer.capabilities, [ROSTER_BRIDGE_REQUIRED_CAPABILITY]);
    assert.deepEqual(await h.viewer.createSession({ hostRunId: h.inventory.hostRunId, workspace: "/srv/owner/x" }),
      { kind: "not-sent", reason: "capability-unsupported" });
    await settle();
    assert.deepEqual(h.pair.viewerSide.types(), ["hello"], "no create frame exists without the optional offer");
    // Ordinary metadata is completely unaffected.
    const snapshot = await h.viewer.subscribe();
    assert.equal(snapshot.state, "current");
  } finally {
    await h.stop();
  }
});

test("a provider-less owner refuses an offered create frame outside the negotiated protocol", async () => {
  const pair = channelPair();
  const inventory = new FakeInventory();
  inventory.rows = [ownerRow("row-1")];
  const owner = createRosterBridgeHost({ inventory, authorizePeer: () => true, bounds: FAST_BOUNDS });
  const binding = owner.attach(pair.ownerSide);
  const scripted = new ScriptedPeer(pair.viewerSide);
  try {
    scripted.write(helloFrame([ROSTER_BRIDGE_REQUIRED_CAPABILITY, ROSTER_BRIDGE_CREATE_CAPABILITY]));
    await settle();
    const ack = pair.ownerSide.frames()[0];
    assert.ok(ack !== undefined && ack.type === "hello_ack");
    assert.deepEqual(ack.capabilities, [ROSTER_BRIDGE_REQUIRED_CAPABILITY],
      "an owner without a create provider acknowledges the baseline only");
    scripted.write(createFrame({ hostRunId: inventory.hostRunId }));
    await settle();
    assert.equal(pair.ownerSide.frames().some((frame) => frame.type === "create_result"), false,
      "nothing outside the negotiated protocol reaches an authority");
    assert.ok(pair.ownerSide.frames().some((frame) => frame.type === "error" && frame.code === "bad_frame"));
    assert.equal(binding.subscribed, false);
  } finally {
    await owner.stopAll();
  }
});

test("only the exact requested owner run and canonical workspace reach the create provider", async () => {
  const calls: OwnerCreateRequest[] = [];
  let guardCalls = 0;
  const h = harness({
    capabilities: CREATE_CAPS,
    create: async (request, stillAuthorized) => {
      calls.push(request);
      guardCalls += 1;
      assert.equal(stillAuthorized(), true, "the provider is handed the owner's live re-proof");
      return { kind: "started", hostRunId: request.hostRunId, rowId: "native-9" };
    },
  });
  try {
    await h.viewer.hello;
    assert.equal(h.viewer.supportsCreate, true);
    assert.deepEqual(h.viewer.capabilities, [ROSTER_BRIDGE_REQUIRED_CAPABILITY, ROSTER_BRIDGE_CREATE_CAPABILITY]);
    const snapshot = await h.viewer.subscribe();
    const rowsBefore = snapshot.rows.map((row) => row.id);
    const workspace = "C:\\Users\\owner\\My Projects\\pi";
    const result = await h.viewer.createSession({ hostRunId: h.inventory.hostRunId, workspace });
    assert.deepEqual(result, {
      kind: "owner-result",
      facts: { kind: "started", hostRunId: h.inventory.hostRunId, rowId: "native-9" },
    });
    assert.deepEqual(calls, [{ hostRunId: h.inventory.hostRunId, workspace }]);
    assert.equal(guardCalls, 1, "the provider checks the owner's re-proof once");
    // A create result never creates, selects, removes, or retargets a projected row.
    assert.deepEqual(h.viewer.projection.rows.map((row) => row.id), rowsBefore);
    assert.equal(h.viewer.projection.state, "current");
    const requests = h.pair.viewerSide.frames().filter((frame) => frame.type === "create_request");
    assert.equal(requests.length, 1);
    assert.deepEqual(Object.keys(requests[0]!).sort(), ["hostRunId", "requestId", "sequence", "type", "workspace"],
      "nothing but the closed request schema rides the wire");
    assert.equal(new Set(requests.map((frame) => (frame.type === "create_request" ? frame.requestId : ""))).size, 1);
  } finally {
    await h.stop();
  }
});

test("an owner whose current roster is empty is a valid first create target", async () => {
  const calls: OwnerCreateRequest[] = [];
  const h = harness({
    rows: [],
    capabilities: CREATE_CAPS,
    create: async (request) => {
      calls.push(request);
      return { kind: "started", hostRunId: request.hostRunId, rowId: "native-1" };
    },
  });
  try {
    await h.viewer.hello;
    const snapshot = await h.viewer.subscribe();
    assert.deepEqual(snapshot.rows, [], "a complete snapshot with zero rows is a real observation");
    assert.equal(snapshot.state, "current");
    const result = await h.viewer.createSession({ hostRunId: h.inventory.hostRunId, workspace: "/srv/owner/first" });
    assert.deepEqual(result, {
      kind: "owner-result",
      facts: { kind: "started", hostRunId: h.inventory.hostRunId, rowId: "native-1" },
    });
    assert.deepEqual(calls.map((call) => call.hostRunId), [h.inventory.hostRunId]);
  } finally {
    await h.stop();
  }
});

test("a create is reauthorized before the provider and a revoke in that window starts nothing", async () => {
  let allowed = true;
  const calls: OwnerCreateRequest[] = [];
  const h = harness({
    capabilities: CREATE_CAPS,
    authorize: () => allowed,
    create: async (request) => {
      calls.push(request);
      return { kind: "started", hostRunId: request.hostRunId, rowId: "native-1" };
    },
  });
  try {
    await h.viewer.hello;
    await h.viewer.subscribe();
    allowed = false;
    const result = await mustSettle(
      h.viewer.createSession({ hostRunId: h.inventory.hostRunId, workspace: "/srv/owner/blocked" }),
      "a revoked create settles",
    );
    assert.deepEqual(result, { kind: "unknown" }, "an unanswered request is never a fabricated refusal");
    assert.deepEqual(calls, [], "the revoke is re-proved before the provider is reached");
    assert.equal(h.pair.ownerSide.frames().some((frame) => frame.type === "create_result"), false,
      "an unauthorized request produces no reply at all");
    assert.ok(h.ownerDiagnostics.includes("create_refused"));
  } finally {
    await h.stop();
  }
});

test("a throwing owner authorizer before the create is a closed door, not an open one", async () => {
  let mode: "allow" | "throw" = "allow";
  let providerCalls = 0;
  const h = harness({
    capabilities: CREATE_CAPS,
    authorize: () => {
      if (mode === "throw") throw new Error("synthetic authorizer failure");
      return true;
    },
    create: async (request) => {
      providerCalls += 1;
      return { kind: "started", hostRunId: request.hostRunId, rowId: "native-1" };
    },
  });
  try {
    await h.viewer.hello;
    await h.viewer.subscribe();
    mode = "throw";
    const result = await mustSettle(
      h.viewer.createSession({ hostRunId: h.inventory.hostRunId, workspace: "/srv/owner/denied" }),
      "a throwing authorizer settles the create",
    );
    assert.deepEqual(result, { kind: "unknown" });
    assert.equal(providerCalls, 0);
    assert.equal(h.pair.ownerSide.frames().some((frame) => frame.type === "create_result"), false);
  } finally {
    await h.stop();
  }
});

test("a duplicated sequence never starts a second child, even after the first completed", async () => {
  const pair = channelPair();
  const inventory = new FakeInventory();
  inventory.rows = [];
  const calls: OwnerCreateRequest[] = [];
  const owner = createRosterBridgeHost({
    inventory,
    authorizePeer: () => true,
    bounds: FAST_BOUNDS,
    createOwnedSession: async (request) => {
      calls.push(request);
      return { kind: "started", hostRunId: request.hostRunId, rowId: "native-1" };
    },
  });
  const binding = owner.attach(pair.ownerSide);
  const scripted = new ScriptedPeer(pair.viewerSide);
  scripted.autoAck = false;
  scripted.onHello(() => {
    scripted.write({
      type: "hello_ack",
      service: ROSTER_BRIDGE_SERVICE,
      major: ROSTER_BRIDGE_MAJOR,
      minor: ROSTER_BRIDGE_MINOR,
      capabilities: [ROSTER_BRIDGE_REQUIRED_CAPABILITY, ROSTER_BRIDGE_CREATE_CAPABILITY],
    });
  });
  try {
    scripted.write(helloFrame([ROSTER_BRIDGE_REQUIRED_CAPABILITY, ROSTER_BRIDGE_CREATE_CAPABILITY]));
    await until("the owner acknowledges the create capability", () => pair.ownerSide.frames()
      .some((frame) => frame.type === "hello_ack"));
    scripted.write(createFrame({ requestId: "create-1", hostRunId: inventory.hostRunId, sequence: 1 }));
    await until("the first create reaches the provider", () => calls.length === 1);
    await settle();
    // Replaying the same attempt number is refused before any provider call, even
    // though the first operation has already completed.
    scripted.write(createFrame({ requestId: "create-2", hostRunId: inventory.hostRunId, sequence: 1 }));
    await until("the replay is answered", () => pair.ownerSide.frames()
      .filter((frame) => frame.type === "create_result").length === 2);
    const results = pair.ownerSide.frames().filter((frame) => frame.type === "create_result");
    assert.deepEqual(results.map((frame) => (frame.type === "create_result" ? [frame.requestId, frame.outcome.kind] : [])),
      [["create-1", "started"], ["create-2", "refused"]]);
    assert.equal(calls.length, 1, "a replayed sequence never reaches the provider again");
    // A fresh, higher attempt number is a fresh attempt.
    scripted.write(createFrame({ requestId: "create-3", hostRunId: inventory.hostRunId, sequence: 2 }));
    await until("the fresh attempt reaches the provider", () => calls.length === 2);
    assert.equal(binding.subscribed, false, "create traffic never subscribes or unsubscribes metadata");
  } finally {
    await owner.stopAll();
  }
});

test("one create per channel: a second is refused while the first is held and metadata still flows", async () => {
  let release: (facts: OwnerCreateFacts) => void = () => undefined;
  const calls: OwnerCreateRequest[] = [];
  const h = harness({
    capabilities: CREATE_CAPS,
    create: (request) => {
      calls.push(request);
      return new Promise<OwnerCreateFacts>((resolve) => {
        release = resolve;
      });
    },
  });
  try {
    await h.viewer.hello;
    const firstSnapshot = await h.viewer.subscribe();
    const first = h.viewer.createSession({ hostRunId: h.inventory.hostRunId, workspace: "/srv/owner/one" });
    await until("the first create reaches the provider", () => calls.length === 1);
    // The requester's own one-in-flight rule refuses a second without submitting it.
    assert.deepEqual(await h.viewer.createSession({ hostRunId: h.inventory.hostRunId, workspace: "/srv/owner/two" }),
      { kind: "not-sent", reason: "busy" });
    assert.equal(calls.length, 1, "a second create never reaches the owner");
    // The ordered metadata path is not blocked while the owner provider holds it.
    h.inventory.rows = [ownerRow("row-1")];
    h.inventory.emit();
    await until("a newer snapshot is published during the create", () => h.viewer.projection.revision !== null
      && h.viewer.projection.rows.length === 1);
    assert.notEqual(h.viewer.projection.revision, firstSnapshot.revision);
    assert.equal(h.viewer.projection.state, "current");
    release({ kind: "unconfirmed" });
    assert.deepEqual(await mustSettle(first, "the held create result"),
      { kind: "owner-result", facts: { kind: "unconfirmed" } });
    // A later attempt after completion is a fresh number and reaches the owner.
    const second = h.viewer.createSession({ hostRunId: h.inventory.hostRunId, workspace: "/srv/owner/three" });
    await until("the second attempt reaches the provider", () => calls.length === 2);
    const requests = h.pair.viewerSide.frames().filter((frame) => frame.type === "create_request");
    assert.deepEqual(requests.map((frame) => (frame.type === "create_request" ? frame.sequence : -1)), [1, 2],
      "each attempt takes the next number from this channel's monotonic high-water");
    release({ kind: "refused" });
    assert.deepEqual(await mustSettle(second, "the second result"),
      { kind: "owner-result", facts: { kind: "refused" } });
    assert.deepEqual(calls.map((call) => call.workspace), ["/srv/owner/one", "/srv/owner/three"]);
  } finally {
    await h.stop();
  }
});

test("a lost create result is unknown after a finite deadline and is never replayed", async () => {
  const pair = channelPair();
  const viewer = attachRosterBridgeViewer({ channel: pair.viewerSide, bounds: FAST_BOUNDS, capabilities: CREATE_CAPS });
  const scripted = new ScriptedPeer(pair.ownerSide);
  scripted.autoAck = false;
  scripted.onHello(() => {
    scripted.write({
      type: "hello_ack",
      service: ROSTER_BRIDGE_SERVICE,
      major: ROSTER_BRIDGE_MAJOR,
      minor: ROSTER_BRIDGE_MINOR,
      capabilities: [ROSTER_BRIDGE_REQUIRED_CAPABILITY, ROSTER_BRIDGE_CREATE_CAPABILITY],
    });
  });
  try {
    await mustSettle(viewer.hello, "the handshake");
    const result = await mustSettle(
      viewer.createSession({ hostRunId: RUN_A, workspace: "/srv/owner/silent" }),
      "a silent owner settles the create at its deadline",
    );
    assert.deepEqual(result, { kind: "unknown" });
    const requests = scripted.received.filter((frame) => frame.type === "create_request");
    assert.equal(requests.length, 1, "nothing is re-sent, cancelled, or replayed for an unanswered create");
    const request = requests[0];
    assert.ok(request !== undefined && request.type === "create_request");
    // A reply that arrives after the deadline is dropped, never resurrected.
    scripted.write(createResult(request.requestId, { kind: "started", hostRunId: RUN_A, rowId: "native-1" }));
    await settle();
    assert.deepEqual(viewer.projection.rows, [], "no late reply invents a row");
  } finally {
    scripted.confirmUnsubscribes();
    await viewer.stop();
  }
});

test("a create result naming another owner run is never reported as this request's", async () => {
  const pair = channelPair();
  const viewer = attachRosterBridgeViewer({ channel: pair.viewerSide, bounds: FAST_BOUNDS, capabilities: CREATE_CAPS });
  const scripted = new ScriptedPeer(pair.ownerSide);
  scripted.autoAck = false;
  scripted.onHello(() => {
    scripted.write({
      type: "hello_ack",
      service: ROSTER_BRIDGE_SERVICE,
      major: ROSTER_BRIDGE_MAJOR,
      minor: ROSTER_BRIDGE_MINOR,
      capabilities: [ROSTER_BRIDGE_REQUIRED_CAPABILITY, ROSTER_BRIDGE_CREATE_CAPABILITY],
    });
  });
  try {
    await mustSettle(viewer.hello, "the handshake");
    const pending = viewer.createSession({ hostRunId: RUN_A, workspace: "/srv/owner/run-a" });
    await until("the create frame is received", () => scripted.received.some((frame) => frame.type === "create_request"));
    const request = scripted.received.find((frame) => frame.type === "create_request");
    assert.ok(request !== undefined && request.type === "create_request");
    // The same request id answered about a different run is unobservable.
    scripted.write(createResult(request.requestId, { kind: "started", hostRunId: RUN_B, rowId: "native-1" }));
    assert.deepEqual(await mustSettle(pending, "the mismatched run settles"), { kind: "unknown" });
  } finally {
    scripted.confirmUnsubscribes();
    await viewer.stop();
  }
});

test("a submitted create write that is refused is unknown, while pre-submission refusals are not-sent", async () => {
  const h = harness({
    capabilities: CREATE_CAPS,
    create: async (request) => ({ kind: "started", hostRunId: request.hostRunId, rowId: "native-1" }),
  });
  try {
    await h.viewer.hello;
    await h.viewer.subscribe();
    const run = h.inventory.hostRunId;
    // A request this contract cannot represent never becomes a frame.
    for (const request of [
      { hostRunId: "-bad", workspace: "/srv/owner/x" },
      { hostRunId: "x".repeat(65), workspace: "/srv/owner/x" },
      { hostRunId: run, workspace: "" },
      { hostRunId: run, workspace: "/srv/\u0000" },
      { hostRunId: run, workspace: ASTRAL.repeat(2_049) },
      { hostRunId: run },
      { hostRunId: run, workspace: 7 as never },
    ]) {
      assert.deepEqual(await h.viewer.createSession(request as never),
        { kind: "not-sent", reason: "invalid-request" }, `${JSON.stringify(request).slice(0, 40)} must be refused`);
    }
    assert.equal(h.pair.viewerSide.frames().filter((frame) => frame.type === "create_request").length, 0);
    // A transport that refuses the write after it was invoked cannot be claimed as
    // "never submitted": the owner may have created a child anyway.
    h.pair.viewerSide.failNextSend = true;
    assert.deepEqual(await mustSettle(
      h.viewer.createSession({ hostRunId: run, workspace: "/srv/owner/refused" }),
      "a refused write settles",
    ), { kind: "unknown" });
    assert.equal(h.pair.viewerSide.frames().filter((frame) => frame.type === "create_request").length, 0);
    // A stopped viewer is positively not-sent and never writes at all.
    await h.viewer.stop();
    assert.deepEqual(await h.viewer.createSession({ hostRunId: run, workspace: "/srv/owner/stopped" }),
      { kind: "not-sent", reason: "not-ready" });
  } finally {
    await h.owner.stopAll();
  }
});

test("a caller fence that no longer holds refuses the queued create before submission", async () => {
  const calls: OwnerCreateRequest[] = [];
  const h = harness({
    bounds: { stopAckTimeoutMs: 5_000 },
    capabilities: CREATE_CAPS,
    create: async (request) => {
      calls.push(request);
      return { kind: "started", hostRunId: request.hostRunId, rowId: "native-1" };
    },
  });
  try {
    await h.viewer.hello;
    await h.viewer.subscribe();
    // Occupy the single ordered send slot so the next control write waits in the
    // queue and has NOT yet been handed to the transport.
    h.pair.viewerSide.hold = true;
    const resyncing = h.viewer.resync();
    void resyncing.catch(() => undefined);
    await settle();
    // A caller fence standing in for the coordinator's written form, run, and
    // workspace proof.
    let current = true;
    const creating = h.viewer.createSession(
      { hostRunId: h.inventory.hostRunId, workspace: "/srv/owner/queued" },
      { stillCurrent: () => current },
    );
    await settle();
    assert.equal(h.pair.viewerSide.types().filter((type) => type === "create_request").length, 0,
      "the queued create has not been submitted yet");
    // The form is replaced while the request is still queued, and the queue drains.
    current = false;
    h.pair.viewerSide.release();
    assert.deepEqual(await mustSettle(creating, "the replaced form settles the create"),
      { kind: "not-sent", reason: "target-unavailable" });
    await settle();
    assert.equal(h.pair.viewerSide.types().filter((type) => type === "create_request").length, 0,
      "a fence that no longer holds is checked at the transport write boundary");
    assert.deepEqual(calls, [], "no owner provider was reached for a form that no longer owns the request");
  } finally {
    await h.stop();
  }
});

test("a channel whose create result cannot be written drops it instead of claiming a child", async () => {
  const h = harness({
    capabilities: CREATE_CAPS,
    create: async (request) => ({ kind: "started", hostRunId: request.hostRunId, rowId: "native-1" }),
  });
  try {
    await h.viewer.hello;
    await h.viewer.subscribe();
    h.pair.ownerSide.failNextSend = true;
    const result = await mustSettle(
      h.viewer.createSession({ hostRunId: h.inventory.hostRunId, workspace: "/srv/owner/unwritable" }),
      "an unwritable create result settles as unknown",
    );
    assert.deepEqual(result, { kind: "unknown" });
    assert.ok(h.ownerDiagnostics.includes("create_reply_dropped"));
  } finally {
    await h.stop();
  }
});

test("a channel that goes away between admission and the provider starts nothing", async () => {
  const pair = channelPair();
  const inventory = new FakeInventory();
  inventory.rows = [];
  const calls: OwnerCreateRequest[] = [];
  const owner = createRosterBridgeHost({
    inventory,
    authorizePeer: () => true,
    bounds: FAST_BOUNDS,
    createOwnedSession: async (request) => {
      calls.push(request);
      return { kind: "started", hostRunId: request.hostRunId, rowId: "native-1" };
    },
  });
  const binding = owner.attach(pair.ownerSide);
  const scripted = new ScriptedPeer(pair.viewerSide);
  scripted.autoAck = false;
  scripted.onHello(() => {
    scripted.write({
      type: "hello_ack",
      service: ROSTER_BRIDGE_SERVICE,
      major: ROSTER_BRIDGE_MAJOR,
      minor: ROSTER_BRIDGE_MINOR,
      capabilities: [ROSTER_BRIDGE_REQUIRED_CAPABILITY, ROSTER_BRIDGE_CREATE_CAPABILITY],
    });
  });
  try {
    scripted.write(helloFrame([ROSTER_BRIDGE_REQUIRED_CAPABILITY, ROSTER_BRIDGE_CREATE_CAPABILITY]));
    await until("the owner acknowledges the create capability", () => pair.ownerSide.frames()
      .some((frame) => frame.type === "hello_ack"));
    // The frame is admitted, then this binding retires before the provider
    // continuation runs: the owner re-proof fails and nothing is started.
    scripted.write(createFrame({ hostRunId: inventory.hostRunId }));
    await owner.stopAll();
    await settle();
    assert.deepEqual(calls, [], "a binding that retired after admission never reaches the provider");
    assert.equal(pair.ownerSide.frames().some((frame) => frame.type === "create_result"), false,
      "an abandoned request produces no reply that would claim a child");
    assert.equal(binding.subscribed, false);
  } finally {
    await owner.stopAll();
  }
});

test("independent peers create through their own channels without blocking each other", async () => {
  const inventory = new FakeInventory();
  inventory.rows = [];
  const released = new Map<string, (facts: OwnerCreateFacts) => void>();
  const workspaces: string[] = [];
  const owner = createRosterBridgeHost({
    inventory,
    authorizePeer: () => true,
    bounds: FAST_BOUNDS,
    createOwnedSession: (request) => new Promise<OwnerCreateFacts>((resolve) => {
      // Only the canonical workspace distinguishes these two independent peers.
      workspaces.push(request.workspace);
      released.set(request.workspace, resolve);
    }),
  });
  const first = channelPair("viewer-key-1", "owner-key-1");
  const second = channelPair("viewer-key-2", "owner-key-2");
  const firstViewer = attachRosterBridgeViewer({ channel: first.viewerSide, bounds: FAST_BOUNDS, capabilities: CREATE_CAPS });
  const secondViewer = attachRosterBridgeViewer({ channel: second.viewerSide, bounds: FAST_BOUNDS, capabilities: CREATE_CAPS });
  const firstBinding = owner.attach(first.ownerSide);
  const secondBinding = owner.attach(second.ownerSide);
  try {
    await Promise.all([firstViewer.hello, secondViewer.hello]);
    assert.equal(firstViewer.supportsCreate, true);
    assert.equal(secondViewer.supportsCreate, true);
    const firstRun = inventory.hostRunId;
    const one = firstViewer.createSession({ hostRunId: firstRun, workspace: "/srv/owner/peer-one" });
    const two = secondViewer.createSession({ hostRunId: firstRun, workspace: "/srv/owner/peer-two" });
    await until("both peers reach the provider", () => workspaces.length === 2);
    // One peer's in-flight create never blocks the other's channel.
    assert.deepEqual(workspaces.slice().sort(), ["/srv/owner/peer-one", "/srv/owner/peer-two"]);
    released.get("/srv/owner/peer-two")?.({ kind: "started", hostRunId: firstRun, rowId: "native-2" });
    assert.deepEqual(await mustSettle(two, "the second peer's result"),
      { kind: "owner-result", facts: { kind: "started", hostRunId: firstRun, rowId: "native-2" } });
    released.get("/srv/owner/peer-one")?.({ kind: "started", hostRunId: firstRun, rowId: "native-1" });
    assert.deepEqual(await mustSettle(one, "the first peer's result"),
      { kind: "owner-result", facts: { kind: "started", hostRunId: firstRun, rowId: "native-1" } });
    assert.equal(firstBinding.subscribed, false);
    assert.equal(secondBinding.subscribed, false);
  } finally {
    await firstViewer.stop();
    await secondViewer.stop();
    await owner.stopAll();
  }
});

test("an authorizer that retires the binding during the final re-proof starts nothing", async () => {
  let binding: RosterBridgeChannelBinding | undefined;
  let arming = false;
  let providerCalls = 0;
  let starts = 0;
  const pair = channelPair();
  const inventory = new FakeInventory();
  inventory.rows = [];
  const owner = createRosterBridgeHost({
    inventory,
    authorizePeer: () => {
      if (arming && binding !== undefined) {
        // The injected authorizer is arbitrary code: it may retire this very binding
        // (a Revoke that also drops the channel, teardown, replacement) and still
        // answer `true`.
        void binding.stop();
      }
      return true;
    },
    bounds: FAST_BOUNDS,
    createOwnedSession: async (request, stillAuthorized) => {
      providerCalls += 1;
      // Main's final re-proof, immediately before it starts anything.
      arming = true;
      const stillOk = stillAuthorized();
      arming = false;
      if (!stillOk) return { kind: "refused" };
      starts += 1;
      return { kind: "started", hostRunId: request.hostRunId, rowId: "native-1" };
    },
  });
  binding = owner.attach(pair.ownerSide);
  const scripted = new ScriptedPeer(pair.viewerSide);
  scripted.autoAck = false;
  scripted.onHello(() => {
    scripted.write({
      type: "hello_ack",
      service: ROSTER_BRIDGE_SERVICE,
      major: ROSTER_BRIDGE_MAJOR,
      minor: ROSTER_BRIDGE_MINOR,
      capabilities: [ROSTER_BRIDGE_REQUIRED_CAPABILITY, ROSTER_BRIDGE_CREATE_CAPABILITY],
    });
  });
  try {
    scripted.write(helloFrame([ROSTER_BRIDGE_REQUIRED_CAPABILITY, ROSTER_BRIDGE_CREATE_CAPABILITY]));
    await until("the owner acknowledges the create capability", () => pair.ownerSide.frames()
      .some((frame) => frame.type === "hello_ack"));
    scripted.write(createFrame({ hostRunId: inventory.hostRunId }));
    await until("the provider is reached", () => providerCalls === 1);
    await settle();
    assert.equal(starts, 0,
      "a binding that retired inside its own final re-proof never starts a child");
    assert.equal(pair.ownerSide.frames().some((frame) => frame.type === "create_result"), false,
      "no result is written for a binding that is already gone");
    assert.equal(binding?.subscribed, false);
  } finally {
    await owner.stopAll();
  }
});

test("a synchronous provider throw and a rejected provider both settle unknown and free the channel", async () => {
  let mode: "sync-throw" | "reject" | "ok" = "sync-throw";
  const h = harness({
    capabilities: CREATE_CAPS,
    create: (request): Promise<OwnerCreateFacts> => {
      if (mode === "sync-throw") throw new Error("synthetic synchronous provider throw");
      if (mode === "reject") return Promise.reject(new Error("synthetic rejected provider"));
      return Promise.resolve({ kind: "started", hostRunId: request.hostRunId, rowId: "native-1" });
    },
  });
  try {
    await h.viewer.hello;
    await h.viewer.subscribe();
    const run = h.inventory.hostRunId;
    for (const expected of ["sync-throw", "reject"] as const) {
      mode = expected;
      // A synchronous throw must not become an unhandled rejection, and neither
      // failure may leave this channel's one create slot occupied.
      const result = await mustSettle(
        h.viewer.createSession({ hostRunId: run, workspace: "/srv/owner/failure" }),
        `the ${expected} provider`,
      );
      assert.deepEqual(result, { kind: "owner-result", facts: { kind: "unknown" } },
        `a ${expected} provider establishes neither a child nor its absence`);
      await settle();
    }
    // The bookkeeping is released: a later request still reaches the owner.
    mode = "ok";
    assert.deepEqual(await mustSettle(
      h.viewer.createSession({ hostRunId: run, workspace: "/srv/owner/recovered" }),
      "the recovered create",
    ), { kind: "owner-result", facts: { kind: "started", hostRunId: run, rowId: "native-1" } });
    const requests = h.pair.viewerSide.frames().filter((frame) => frame.type === "create_request");
    assert.deepEqual(requests.map((frame) => (frame.type === "create_request" ? frame.sequence : -1)), [1, 2, 3],
      "each attempt consumes the next sequence and never reuses one");
  } finally {
    await h.stop();
  }
});

test("a retirement queued by the final authorizer cannot land before the provider call", async () => {
  let binding: RosterBridgeChannelBinding | undefined;
  let arming = false;
  let createAuthorizations = 0;
  let providerCalls = 0;
  let retiredAtInvocation = true;
  let retired = false;
  const pair = channelPair();
  const inventory = new FakeInventory();
  inventory.rows = [];
  const owner = createRosterBridgeHost({
    inventory,
    authorizePeer: () => {
      // Armed before admission: the first create authorization is admission, and
      // the SECOND is the detached continuation's final check immediately before
      // the provider call. Scheduling the retirement from that check is exactly the
      // gap an extra intervening microtask would open.
      if (arming && binding !== undefined && ++createAuthorizations === 2) {
        queueMicrotask(() => {
          retired = true;
          void binding?.stop();
        });
      }
      return true;
    },
    bounds: FAST_BOUNDS,
    createOwnedSession: async (request, stillAuthorized) => {
      providerCalls += 1;
      retiredAtInvocation = retired;
      const stillOk = stillAuthorized();
      if (!stillOk) return { kind: "refused" };
      return { kind: "started", hostRunId: request.hostRunId, rowId: "native-1" };
    },
  });
  binding = owner.attach(pair.ownerSide);
  const scripted = new ScriptedPeer(pair.viewerSide);
  scripted.autoAck = false;
  scripted.onHello(() => {
    scripted.write({
      type: "hello_ack",
      service: ROSTER_BRIDGE_SERVICE,
      major: ROSTER_BRIDGE_MAJOR,
      minor: ROSTER_BRIDGE_MINOR,
      capabilities: [ROSTER_BRIDGE_REQUIRED_CAPABILITY, ROSTER_BRIDGE_CREATE_CAPABILITY],
    });
  });
  try {
    scripted.write(helloFrame([ROSTER_BRIDGE_REQUIRED_CAPABILITY, ROSTER_BRIDGE_CREATE_CAPABILITY]));
    await until("the owner acknowledges the create capability", () => pair.ownerSide.frames()
      .some((frame) => frame.type === "hello_ack"));
    arming = true;
    scripted.write(createFrame({ hostRunId: inventory.hostRunId }));
    await until("the provider is reached", () => providerCalls === 1);
    await settle();
    assert.equal(retiredAtInvocation, false,
      "the provider is invoked while its authorization is still current, before the queued retirement");
    assert.equal(providerCalls, 1);
    assert.equal(retired, true, "the queued retirement did run afterwards");
    assert.equal(pair.ownerSide.frames().some((frame) => frame.type === "create_result"), false,
      "a binding retired before its reply writes nothing");
    assert.equal(binding?.subscribed, false);
  } finally {
    await owner.stopAll();
  }
});

// --- optional Saved catalog windows over the same roster lane -----------------

/** The one explicit opt-in a caller needs to offer the optional Saved exchange. */
const SAVED_CAPS: readonly string[] = [ROSTER_BRIDGE_SAVED_CAPABILITY];

/** One owner Saved entry carrying exactly what a local Saved picker row shows. */
function savedEntry(index: number, cwd = `/srv/owner/project ${index}`): OwnerSavedEntry {
  return {
    entryId: `entry-${index}`,
    sessionId: `0190a1b2-0000-7000-8000-${String(index).padStart(12, "0")}`,
    file: `/srv/owner/agent/sessions/--srv-owner--/2026-10-22T00-00-00-000Z_${index}.jsonl`,
    caption: `Saved ${index}`,
    cwd,
  };
}

type SavedWindow = Extract<OwnerSavedWindowFacts, { readonly kind: "window" }>;

/**
 * A thin fake of the owner's Saved view factory. Each view keeps its OWN current
 * catalog and result, as the real per-binding view must; the provider only
 * records calls. It reads no file, owns no native row, and grants nothing.
 */
class FakeSavedProvider {
  total = 10;
  searchTotal = 3;
  cwdFor: (index: number) => string = (index) => `/srv/owner/project ${index}`;
  /** The owner's native row at one result position. */
  entryFor: (index: number) => OwnerSavedEntry = (index) => savedEntry(index, this.cwdFor(index));
  views = 0;
  disposed = 0;
  serial = 0;
  readonly lists: OwnerSavedListRequest[] = [];
  readonly searches: OwnerSavedSearchRequest[] = [];
  readonly windows: OwnerSavedWindowRequest[] = [];
  readonly resumes: OwnerSavedResumeRequest[] = [];
  readonly removes: OwnerSavedDeleteRequest[] = [];
  readonly signals: AbortSignal[] = [];
  /** When set, every read waits on it before answering. */
  readGate: Promise<void> | null = null;
  /** Runs synchronously inside the factory, as arbitrary owner code may. */
  onCreate: (() => void) | null = null;
  /** Runs just before a read returns its window. */
  beforeAnswer: (() => void) | null = null;
  resume: (request: OwnerSavedResumeRequest, guard: OwnerSavedAuthorizationGuard) => Promise<OwnerSavedResumeFacts> =
    async (request) => ({ kind: "started", hostRunId: request.hostRunId, rowId: "native-resumed" });
  remove: (request: OwnerSavedDeleteRequest, guard: OwnerSavedAuthorizationGuard) => Promise<OwnerSavedDeleteFacts> =
    async (request, guard) => {
      if (!request.confirmed) return { kind: "confirmation-required" };
      return guard() ? { kind: "deleted", method: "trash" } : { kind: "refused", reason: "policy" };
    };

  readonly factory = (): OwnerSavedCatalogView => {
    this.views += 1;
    this.onCreate?.();
    const provider = this;
    let catalogId: string | null = null;
    let resultId: string | null = null;
    let resultTotal = 0;
    const slice = (hostRunId: string, offset: number, count: number): OwnerSavedWindowFacts => {
      const catalog = catalogId;
      const result = resultId;
      if (catalog === null || result === null) return { kind: "unavailable" };
      if (offset > resultTotal) return { kind: "refused", reason: "range" };
      const length = Math.min(count, resultTotal - offset);
      const entries = Array.from({ length }, (_unused, index) => provider.entryFor(offset + index));
      provider.beforeAnswer?.();
      return { kind: "window", hostRunId, catalogId: catalog, resultId: result, total: resultTotal, issueCount: 0, offset, entries };
    };
    return {
      async list(request, signal, guard) {
        provider.lists.push(request);
        provider.signals.push(signal);
        await provider.readGate;
        if (!guard()) return { kind: "unknown" };
        provider.serial += 1;
        catalogId = `cat-${provider.serial}`;
        resultId = `res-${provider.serial}`;
        resultTotal = provider.total;
        return slice(request.hostRunId, request.offset, request.count);
      },
      async search(request, signal, guard) {
        provider.searches.push(request);
        provider.signals.push(signal);
        await provider.readGate;
        if (!guard()) return { kind: "unknown" };
        if (request.catalogId !== catalogId) return { kind: "refused", reason: "stale" };
        provider.serial += 1;
        resultId = `res-${provider.serial}`;
        resultTotal = provider.searchTotal;
        return slice(request.hostRunId, request.offset, request.count);
      },
      async window(request, signal, guard) {
        provider.windows.push(request);
        provider.signals.push(signal);
        await provider.readGate;
        if (!guard()) return { kind: "unknown" };
        if (request.catalogId !== catalogId || request.resultId !== resultId) return { kind: "refused", reason: "stale" };
        return slice(request.hostRunId, request.offset, request.count);
      },
      resume(request, guard) {
        provider.resumes.push(request);
        return provider.resume(request, guard);
      },
      remove(request, guard) {
        provider.removes.push(request);
        return provider.remove(request, guard);
      },
      dispose() {
        provider.disposed += 1;
      },
    };
  };
}

function savedListFrame(overrides: Partial<RosterBridgeSavedListRequestFrame> = {}): RosterBridgeSavedListRequestFrame {
  return {
    type: "saved_list_request", requestId: "saved-list", hostRunId: RUN_A, query: "", offset: 0, count: 10, sequence: 1,
    ...overrides,
  };
}

function savedResumeFrame(overrides: Partial<RosterBridgeSavedResumeRequestFrame> = {}): RosterBridgeSavedResumeRequestFrame {
  return {
    type: "saved_resume_request", requestId: "saved-resume", hostRunId: RUN_A,
    catalogId: "cat-1", resultId: "res-1", entryId: "entry-0", sequence: 1,
    ...overrides,
  };
}

function savedDeleteFrame(overrides: Partial<RosterBridgeSavedDeleteRequestFrame> = {}): RosterBridgeSavedDeleteRequestFrame {
  return {
    type: "saved_delete_request", requestId: "saved-delete", hostRunId: RUN_A,
    catalogId: "cat-1", resultId: "res-1", entryId: "entry-0", confirmed: true, sequence: 1,
    ...overrides,
  };
}

/** Every fixed Saved result the owner wrote, as [requestId, outcome]. */
function savedResults(pair: Pair): [string, unknown][] {
  return pair.ownerSide.frames().flatMap((frame): [string, unknown][] => {
    if (frame.type === "saved_window_result" || frame.type === "saved_resume_result" || frame.type === "saved_delete_result") {
      return [[frame.requestId, frame.outcome]];
    }
    return [];
  });
}

/** A real owner with a Saved provider, driven by a scripted viewer that negotiated Saved. */
async function savedOwnerHarness(provider: FakeSavedProvider, options: {
  authorize?: () => boolean;
  deletePolicy?: () => boolean;
} = {}) {
  const pair = channelPair();
  const inventory = new FakeInventory();
  inventory.rows = [];
  const ownerDiagnostics: string[] = [];
  const owner = createRosterBridgeHost({
    inventory,
    authorizePeer: options.authorize ?? (() => true),
    bounds: FAST_BOUNDS,
    savedCatalogView: provider.factory,
    remoteHistoryDeleteExposed: options.deletePolicy ?? (() => false),
    onDiagnostic: (event) => {
      ownerDiagnostics.push(event.code);
    },
  });
  const binding = owner.attach(pair.ownerSide);
  const scripted = new ScriptedPeer(pair.viewerSide);
  scripted.write(helloFrame([ROSTER_BRIDGE_REQUIRED_CAPABILITY, ROSTER_BRIDGE_SAVED_CAPABILITY]));
  await until("the owner acknowledges Saved", () => pair.ownerSide.frames().some((frame) => frame.type === "hello_ack"));
  const subscribe = async (): Promise<void> => {
    scripted.write({ type: "subscribe", subscriptionId: "sub-saved" });
    await until("the owner publishes its roster", () => pair.ownerSide.types().includes("snapshot_end"));
  };
  return { pair, inventory, owner, binding, scripted, ownerDiagnostics, subscribe };
}

/** List through a real viewer and return the window, failing with a named message otherwise. */
async function listedWindow(viewer: RosterBridgeViewer, hostRunId: string, count = 5): Promise<SavedWindow> {
  const result = await mustSettle(viewer.saved!.list({ hostRunId, query: "", offset: 0, count }), "a Saved listing");
  assert.ok(result.kind === "owner-result" && result.outcome.kind === "window",
    `the listing produced ${JSON.stringify(result).slice(0, 160)}`);
  return result.outcome;
}

test("Saved is an optional, explicitly offered capability and a legacy lane is byte-for-byte unchanged", async () => {
  const legacy = harness();
  try {
    await legacy.viewer.hello;
    assert.equal(legacy.viewer.saved?.supported, false);
    assert.equal(legacy.viewer.saved?.policy, undefined, "policy starts unknown");
    assert.deepEqual(await legacy.viewer.saved?.list({ hostRunId: legacy.inventory.hostRunId, query: "", offset: 0, count: 1 }),
      { kind: "not-sent", reason: "capability-unsupported" });
    await legacy.viewer.subscribe();
    assert.deepEqual(legacy.pair.viewerSide.types(), ["hello", "subscribe"], "no Saved frame exists without negotiation");
    assert.deepEqual(legacy.pair.ownerSide.types(), ["hello_ack", "snapshot_begin", "snapshot_page", "snapshot_end"],
      "the legacy owner writes exactly its old frames");
    assert.deepEqual(legacy.savedPolicies, [], "no policy is described on a lane without Saved");
  } finally {
    await legacy.stop();
  }

  // An owner with a provider never acknowledges Saved to a viewer that did not offer it.
  const provider = new FakeSavedProvider();
  const unoffered = harness({ saved: provider });
  try {
    await unoffered.viewer.hello;
    assert.equal(unoffered.viewer.saved?.supported, false);
    assert.deepEqual(unoffered.viewer.capabilities, [ROSTER_BRIDGE_REQUIRED_CAPABILITY]);
    await unoffered.viewer.subscribe();
    assert.equal(unoffered.pair.ownerSide.types().includes("saved_policy"), false);
  } finally {
    await unoffered.stop();
  }

  // A provider-less owner acknowledges the baseline only.
  const providerless = harness({ capabilities: SAVED_CAPS });
  try {
    await providerless.viewer.hello;
    assert.deepEqual(providerless.viewer.capabilities, [ROSTER_BRIDGE_REQUIRED_CAPABILITY]);
    assert.equal(providerless.viewer.saved?.supported, false);
  } finally {
    await providerless.stop();
  }

  // Both sides: acknowledged, but nothing is created until an authorized request.
  const both = harness({ capabilities: SAVED_CAPS, saved: provider });
  try {
    await both.viewer.hello;
    assert.deepEqual(both.viewer.capabilities, [ROSTER_BRIDGE_REQUIRED_CAPABILITY, ROSTER_BRIDGE_SAVED_CAPABILITY]);
    assert.equal(both.viewer.saved?.supported, true);
    assert.equal(provider.views, 0, "the view is created lazily, never at negotiation");
  } finally {
    await both.stop();
  }

  const decision = negotiateRosterBridgeHello(helloFrame([ROSTER_BRIDGE_REQUIRED_CAPABILITY, ROSTER_BRIDGE_SAVED_CAPABILITY]));
  assert.deepEqual(decision.ok ? decision.capabilities : null, [ROSTER_BRIDGE_SAVED_CAPABILITY]);
});

test("a Saved provider configuration is all-or-nothing and has no permissive default", () => {
  const inventory = new FakeInventory();
  const provider = new FakeSavedProvider();
  assert.throws(() => createRosterBridgeHost({ inventory, authorizePeer: () => true, savedCatalogView: provider.factory }),
    /together/, "a view without a live delete policy is refused");
  assert.throws(() => createRosterBridgeHost({ inventory, authorizePeer: () => true, remoteHistoryDeleteExposed: () => true }),
    /together/, "a policy without a view is refused");
  assert.throws(() => createRosterBridgeHost({
    inventory, authorizePeer: () => true, savedCatalogView: provider.factory, remoteHistoryDeleteExposed: true as never,
  }), /together/, "a non-callable policy is refused rather than defaulted");
  // A legacy host's notification is a harmless no-op.
  const legacy = createRosterBridgeHost({ inventory, authorizePeer: () => true });
  assert.doesNotThrow(() => legacy.notifySavedPolicy?.());
});

test("a Saved frame on a channel that never negotiated it is refused and reaches no provider", async () => {
  const provider = new FakeSavedProvider();
  const pair = channelPair();
  const inventory = new FakeInventory();
  const owner = createRosterBridgeHost({
    inventory, authorizePeer: () => true, bounds: FAST_BOUNDS,
    savedCatalogView: provider.factory, remoteHistoryDeleteExposed: () => true,
  });
  owner.attach(pair.ownerSide);
  const scripted = new ScriptedPeer(pair.viewerSide);
  try {
    scripted.write(helloFrame());
    await settle();
    scripted.write(savedListFrame({ hostRunId: inventory.hostRunId }));
    await settle();
    assert.ok(pair.ownerSide.frames().some((frame) => frame.type === "error" && frame.code === "bad_frame"));
    assert.equal(provider.views, 0, "nothing outside the negotiated protocol reaches an owner view");
    assert.equal(pair.ownerSide.closedCalls, 1, "the violating channel is closed once through its bounded API");
  } finally {
    await owner.stopAll();
  }
});

test("a catalog larger than one transfer is browsed in full through bounded windows of ONE result", async () => {
  const provider = new FakeSavedProvider();
  provider.total = 5_000;
  // A wider requester patience than FAST_BOUNDS so a 4,096-row transfer never
  // races the test's own deadline; no protocol default changes.
  const h = harness({
    rows: [], capabilities: SAVED_CAPS, saved: provider,
    bounds: { createResultTimeoutMs: 2_000, transferIdleTimeoutMs: 2_000 },
  });
  try {
    await h.viewer.hello;
    const snapshot = await h.viewer.subscribe();
    assert.deepEqual(snapshot.rows, [], "an empty roster with its exact run is a valid Saved target");
    const run = h.inventory.hostRunId;
    const saved = h.viewer.saved!;
    const first = await listedWindow(h.viewer, run, 4_096);
    assert.equal(first.total, 5_000, "the window states the FULL total, beyond one transfer");
    assert.equal(first.offset, 0);
    assert.equal(first.entries.length, 4_096);
    assert.deepEqual(first.entries[0], savedEntry(0),
      "the owner's session id, saved file path, caption, and cwd arrive exactly as its local row holds them");
    const secondResult = await mustSettle(saved.window({
      hostRunId: run, catalogId: first.catalogId, resultId: first.resultId, offset: 4_096, count: 4_096,
    }), "the second window");
    assert.ok(secondResult.kind === "owner-result" && secondResult.outcome.kind === "window");
    const second = secondResult.outcome;
    assert.equal(second.total, 5_000);
    assert.equal(second.offset, 4_096);
    assert.equal(second.entries.length, 904);
    assert.equal(second.catalogId, first.catalogId, "a window never remints the catalog");
    assert.equal(second.resultId, first.resultId, "a window never remints the result");
    const ids = new Set([...first.entries, ...second.entries].map((entry) => entry.entryId));
    assert.equal(ids.size, 5_000, "every entry of the full total was reached, none twice");
    assert.equal(provider.lists.length, 1, "windows never relist");
    assert.equal(provider.windows.length, 1);

    // Past the end is an honest empty window that still states the full total.
    const past = await mustSettle(saved.window({
      hostRunId: run, catalogId: first.catalogId, resultId: first.resultId, offset: 5_000, count: 10,
    }), "the past-the-end window");
    assert.ok(past.kind === "owner-result" && past.outcome.kind === "window");
    assert.equal(past.outcome.entries.length, 0);
    assert.equal(past.outcome.total, 5_000);

    const pages = h.pair.ownerSide.frames().filter((frame) => frame.type === "saved_window_page");
    assert.ok(pages.every((frame) => frame.type === "saved_window_page"
      && frame.entries.length <= DEFAULT_ROSTER_BRIDGE_BOUNDS.maxRowsPerPage), "the existing per-page row bound holds");
    assert.equal(provider.views, 1, "one lazily created view served every window");
  } finally {
    await h.stop();
  }
});

test("a byte-limited window carries an honest contiguous prefix and browsing continues from it", async () => {
  const provider = new FakeSavedProvider();
  provider.total = 40;
  // Long but legal owner working directories: one window cannot carry all 40.
  provider.cwdFor = (index) => `/srv/owner/${"w".repeat(4_000)}-${index}`;
  const h = harness({
    rows: [], capabilities: SAVED_CAPS, saved: provider,
    bounds: { maxSnapshotBytes: 65_536, createResultTimeoutMs: 2_000, transferIdleTimeoutMs: 2_000 },
  });
  try {
    await h.viewer.hello;
    await h.viewer.subscribe();
    const run = h.inventory.hostRunId;
    const first = await listedWindow(h.viewer, run, 40);
    assert.equal(first.total, 40);
    assert.ok(first.entries.length > 0 && first.entries.length < 40,
      `the first window is a non-empty prefix (${first.entries.length})`);
    const seen = [...first.entries];
    let offset = first.entries.length;
    let windows = 1;
    while (offset < 40) {
      const next = await mustSettle(h.viewer.saved!.window({
        hostRunId: run, catalogId: first.catalogId, resultId: first.resultId, offset, count: 40,
      }), `the window at ${offset}`);
      assert.ok(next.kind === "owner-result" && next.outcome.kind === "window");
      assert.equal(next.outcome.offset, offset, "every window states its actual offset");
      assert.equal(next.outcome.total, 40, "and the full total");
      assert.ok(next.outcome.entries.length > 0, "a non-empty remainder always makes progress");
      seen.push(...next.outcome.entries);
      offset += next.outcome.entries.length;
      windows += 1;
    }
    assert.ok(windows >= 3, `several bounded windows were needed (${windows})`);
    assert.deepEqual(seen.map((entry) => entry.entryId), Array.from({ length: 40 }, (_unused, index) => `entry-${index}`),
      "no row was omitted or reordered to force a fit");
    assert.ok(seen.every((entry, index) => entry.cwd === provider.cwdFor(index)), "no path was clipped to force a fit");
    assert.equal(provider.lists.length, 1, "continuation never relists");
  } finally {
    await h.stop();
  }
});

test("a legal row larger than one frame is carried whole by fragments and published atomically", async () => {
  const provider = new FakeSavedProvider();
  provider.total = 3;
  // Exact native owner data far beyond one 64 KiB frame: a Windows owner path
  // (displayed as-is on any viewer) and an astral-heavy working directory.
  const oversized = (index: number): OwnerSavedEntry => ({
    entryId: `entry-${index}`,
    sessionId: `session-${index}`,
    file: `C:\\Users\\owner\\.pi\\agent\\sessions\\${"\\deep \"q\"".repeat(15_000)}\\${index}.jsonl`,
    caption: `Saved ${index}`,
    cwd: `/srv/owner/${"\u{1f5c2}".repeat(30_000)}`,
  });
  provider.entryFor = (index) => (index === 1 ? oversized(index) : savedEntry(index));
  const h = harness({
    rows: [], capabilities: SAVED_CAPS, saved: provider,
    bounds: { createResultTimeoutMs: 2_000, transferIdleTimeoutMs: 2_000 },
  });
  try {
    await h.viewer.hello;
    await h.viewer.subscribe();
    const listed = await listedWindow(h.viewer, h.inventory.hostRunId, 3);
    assert.equal(listed.entries.length, 3, "no legal row is omitted to force a fit");
    assert.deepEqual(listed.entries[1], oversized(1), "the oversized row arrives exactly, unclipped");
    assert.deepEqual(listed.entries[0], savedEntry(0));
    assert.deepEqual(listed.entries[2], savedEntry(2));
    const fragments = h.pair.ownerSide.frames().filter((frame) => frame.type === "saved_window_fragment");
    assert.ok(fragments.length >= 2, `the row needed several fragments (${fragments.length})`);
    assert.ok(h.pair.ownerSide.sent.every((bytes) => bytes.length <= DEFAULT_ROSTER_BRIDGE_BOUNDS.maxFrameBytes),
      "every frame still fits the existing frame bound");
  } finally {
    await h.stop();
  }
});

test("a malicious total allocates nothing and an incoherent window fails closed", async () => {
  const pair = channelPair();
  const viewer = attachRosterBridgeViewer({
    channel: pair.viewerSide,
    bounds: { ...FAST_BOUNDS, createResultTimeoutMs: 800, transferIdleTimeoutMs: 800 },
    capabilities: SAVED_CAPS,
  });
  const scripted = new ScriptedPeer(pair.ownerSide);
  scripted.autoAck = false;
  scripted.onHello(() => {
    scripted.write(helloAck([ROSTER_BRIDGE_REQUIRED_CAPABILITY, ROSTER_BRIDGE_SAVED_CAPABILITY]));
  });
  try {
    await mustSettle(viewer.hello, "the handshake");
    const started = viewer.subscribe();
    await settle();
    const subscriptionId = viewer.subscriptionId;
    assert.ok(subscriptionId);
    scripted.write(begin(subscriptionId, "t-empty", 1, 0, 0, RUN_A));
    scripted.write(end(subscriptionId, "t-empty", 1, 0));
    await started;

    const huge = viewer.saved!.list({ hostRunId: RUN_A, query: "", offset: 0, count: 2 });
    await until("the list request", () => scripted.received.some((frame) => frame.type === "saved_list_request"));
    const request = scripted.received.find((frame) => frame.type === "saved_list_request");
    assert.ok(request !== undefined && request.type === "saved_list_request");
    scripted.write({
      type: "saved_window_begin", requestId: request.requestId, hostRunId: RUN_A, catalogId: "cat-1", resultId: "res-1",
      total: Number.MAX_SAFE_INTEGER, issueCount: Number.MAX_SAFE_INTEGER, offset: 0, rows: 2, pageCount: 1,
    });
    scripted.write({ type: "saved_window_page", requestId: request.requestId, pageIndex: 0, entries: [savedEntry(0), savedEntry(1)] });
    scripted.write({ type: "saved_window_end", requestId: request.requestId, rows: 2, pageCount: 1 });
    const result = await mustSettle(huge, "the huge-total window");
    assert.ok(result.kind === "owner-result" && result.outcome.kind === "window");
    assert.equal(result.outcome.total, Number.MAX_SAFE_INTEGER, "the total is carried as a scalar, never allocated");
    assert.equal(result.outcome.entries.length, 2);

    // A non-empty result presented as an empty window is incoherent: fail closed.
    const fake = viewer.saved!.list({ hostRunId: RUN_A, query: "", offset: 0, count: 2 });
    await until("the second list request", () => scripted.received.filter((frame) => frame.type === "saved_list_request").length === 2);
    const second = scripted.received.filter((frame) => frame.type === "saved_list_request")[1];
    assert.ok(second !== undefined && second.type === "saved_list_request");
    scripted.write({
      type: "saved_window_begin", requestId: second.requestId, hostRunId: RUN_A, catalogId: "cat-2", resultId: "res-2",
      total: 5, issueCount: 0, offset: 0, rows: 0, pageCount: 0,
    });
    assert.deepEqual(await mustSettle(fake, "the incoherent window"), { kind: "unknown" });
    assert.equal(pair.viewerSide.closedCalls, 1, "incoherent owner data closes the channel through its bounded API");
  } finally {
    await viewer.stop();
  }
});

test("Saved names the exact current owner run of a live subscription and nothing else", async () => {
  const provider = new FakeSavedProvider();
  const s = await savedOwnerHarness(provider);
  try {
    // No live subscription yet: there is no current owner run to name.
    s.scripted.write(savedListFrame({ requestId: "early", sequence: 1 }));
    await until("the early refusal", () => savedResults(s.pair).length === 1);
    await s.subscribe();
    s.scripted.write(savedListFrame({ requestId: "other-run", hostRunId: RUN_B, sequence: 2 }));
    await until("the other-run refusal", () => savedResults(s.pair).length === 2);
    assert.deepEqual(savedResults(s.pair), [
      ["early", { kind: "refused", reason: "stale" }],
      ["other-run", { kind: "refused", reason: "stale" }],
    ]);
    assert.equal(provider.views, 0, "a refused run never creates a view");
    // The exact run of an EMPTY roster is a valid target: no row is needed.
    s.scripted.write(savedListFrame({ requestId: "exact", sequence: 3 }));
    await until("the exact-run window", () => s.pair.ownerSide.types().includes("saved_window_end"));
    assert.equal(provider.views, 1);
    assert.deepEqual(provider.lists, [{ hostRunId: RUN_A, query: "", offset: 0, count: 10 }]);
  } finally {
    await s.owner.stopAll();
  }
});

test("each binding lazily owns one view, and finishing disposes it without cancelling an accepted resume", async () => {
  const provider = new FakeSavedProvider();
  let releaseResume: (facts: OwnerSavedResumeFacts) => void = () => undefined;
  let resumeSettled = false;
  provider.resume = () => new Promise<OwnerSavedResumeFacts>((resolve) => {
    releaseResume = (facts) => {
      resumeSettled = true;
      resolve(facts);
    };
  });
  const inventory = new FakeInventory();
  inventory.rows = [];
  const owner = createRosterBridgeHost({
    inventory, authorizePeer: () => true, bounds: FAST_BOUNDS,
    savedCatalogView: provider.factory, remoteHistoryDeleteExposed: () => false,
  });
  const first = channelPair("viewer-key-1", "owner-key-1");
  const second = channelPair("viewer-key-2", "owner-key-2");
  const one = attachRosterBridgeViewer({ channel: first.viewerSide, bounds: FAST_BOUNDS, capabilities: SAVED_CAPS });
  const two = attachRosterBridgeViewer({ channel: second.viewerSide, bounds: FAST_BOUNDS, capabilities: SAVED_CAPS });
  owner.attach(first.ownerSide);
  owner.attach(second.ownerSide);
  try {
    await Promise.all([one.hello, two.hello]);
    await one.subscribe();
    await two.subscribe();
    assert.equal(provider.views, 0, "no view exists before an authorized request");
    const run = inventory.hostRunId;
    const windowOne = await listedWindow(one, run);
    const windowTwo = await listedWindow(two, run);
    assert.equal(provider.views, 2, "one independent view per binding");
    assert.notEqual(windowOne.resultId, windowTwo.resultId);
    // The first binding's view still holds ITS result after the other listed.
    const again = await mustSettle(one.saved!.window({
      hostRunId: run, catalogId: windowOne.catalogId, resultId: windowOne.resultId, offset: 2, count: 2,
    }), "the first binding's own window");
    assert.ok(again.kind === "owner-result" && again.outcome.kind === "window");
    assert.equal(provider.views, 2, "a window reuses the binding's existing view");

    const resumed = one.saved!.resume({
      hostRunId: run, catalogId: windowOne.catalogId, resultId: windowOne.resultId, entryId: "entry-0",
    });
    await until("the resume reaches the owner view", () => provider.resumes.length === 1);
    await owner.stopAll();
    assert.equal(provider.disposed, 2, "each binding disposed its one view when it finished");
    assert.equal(resumeSettled, false, "disposal never cancels or awaits an accepted resume");
    assert.deepEqual(await mustSettle(resumed, "the requester's patience"), { kind: "unknown" });
    releaseResume({ kind: "started", hostRunId: run, rowId: "native-9" });
    await settle();
    assert.equal(first.ownerSide.frames().some((frame) => frame.type === "saved_resume_result"), false,
      "a finished binding writes no result for work that outlived it");
  } finally {
    await one.stop();
    await two.stop();
    await owner.stopAll();
  }
});

test("authorization lost between window frames writes nothing further", async () => {
  let allowed = true;
  const provider = new FakeSavedProvider();
  provider.total = 6;
  const h = harness({
    rows: [], capabilities: SAVED_CAPS, saved: provider, authorize: () => allowed, bounds: { maxRowsPerPage: 1 },
  });
  try {
    await h.viewer.hello;
    await h.viewer.subscribe();
    await until("the initial policy description", () => h.viewer.saved?.policy !== undefined);
    await settle();
    const run = h.inventory.hostRunId;
    h.pair.ownerSide.hold = true;
    const pending = h.viewer.saved!.list({ hostRunId: run, query: "", offset: 0, count: 6 });
    await until("the window begin is written", () => h.pair.ownerSide.types().includes("saved_window_begin"));
    allowed = false;
    h.pair.ownerSide.release();
    assert.deepEqual(await mustSettle(pending, "the interrupted window"), { kind: "unknown" });
    const types = h.pair.ownerSide.types();
    assert.equal(types.includes("saved_window_page"), false, "no later page is written after the revoke");
    assert.equal(types.includes("saved_window_end"), false);
    assert.ok(h.ownerDiagnostics.includes("saved_reply_dropped"));
  } finally {
    await h.stop();
  }
});

test("a factory that revokes during creation reaches no provider operation and writes nothing", async () => {
  let allowed = true;
  const provider = new FakeSavedProvider();
  provider.onCreate = () => {
    allowed = false;
  };
  const h = harness({ rows: [], capabilities: SAVED_CAPS, saved: provider, authorize: () => allowed });
  try {
    await h.viewer.hello;
    await h.viewer.subscribe();
    const result = await mustSettle(
      h.viewer.saved!.list({ hostRunId: h.inventory.hostRunId, query: "", offset: 0, count: 5 }),
      "a list whose factory revoked",
    );
    assert.deepEqual(result, { kind: "unknown" }, "an unanswered request is never a fabricated refusal");
    assert.equal(provider.views, 1);
    assert.equal(provider.lists.length, 0, "the re-proof after the factory stops the operation");
    assert.equal(savedResults(h.pair).length, 0);
    assert.equal(h.pair.ownerSide.types().includes("saved_window_begin"), false);
  } finally {
    await h.stop();
  }
});

test("the delete policy starts unknown, follows the first snapshot and every notify, and Off always denies", async () => {
  let exposed = false;
  let throwing = false;
  const provider = new FakeSavedProvider();
  const h = harness({
    rows: [], capabilities: SAVED_CAPS, saved: provider,
    deletePolicy: () => {
      if (throwing) throw new Error("synthetic policy failure");
      return exposed;
    },
  });
  try {
    await h.viewer.hello;
    const saved = h.viewer.saved!;
    assert.equal(saved.policy, undefined, "unknown before any run is observed: Delete stays hidden");
    await h.viewer.subscribe();
    const run = h.inventory.hostRunId;
    await until("the first policy description", () => saved.policy !== undefined);
    assert.deepEqual(saved.policy, { hostRunId: run, deleteExposed: false });
    const listed = await listedWindow(h.viewer, run);
    const target = { hostRunId: run, catalogId: listed.catalogId, resultId: listed.resultId, entryId: listed.entries[0]!.entryId };

    assert.deepEqual(await saved.remove({ ...target, confirmed: false }),
      { kind: "owner-result", outcome: { kind: "refused", reason: "policy" } }, "Off denies even a prepare");
    assert.deepEqual(await saved.remove({ ...target, confirmed: true }),
      { kind: "owner-result", outcome: { kind: "refused", reason: "policy" } }, "a confirmation never overrides Off");
    assert.equal(provider.removes.length, 0, "no provider call while delete is not exposed");

    exposed = true;
    h.owner.notifySavedPolicy?.();
    await until("the On description", () => saved.policy?.deleteExposed === true);
    assert.deepEqual(await saved.remove({ ...target, confirmed: false }),
      { kind: "owner-result", outcome: { kind: "confirmation-required" } });
    assert.deepEqual(await saved.remove({ ...target, confirmed: true }),
      { kind: "owner-result", outcome: { kind: "deleted", method: "trash" } });
    assert.equal(provider.removes.length, 2, "Off -> On needed no disconnect, rebind, or relist");

    exposed = false;
    h.owner.notifySavedPolicy?.();
    await until("the Off description", () => saved.policy?.deleteExposed === false);
    assert.deepEqual(await saved.remove({ ...target, confirmed: true }),
      { kind: "owner-result", outcome: { kind: "refused", reason: "policy" } },
      "an earlier On description and confirmation cannot override the live Off");

    // The live server check is the authority, even when the description says On.
    exposed = true;
    throwing = true;
    assert.deepEqual(await saved.remove({ ...target, confirmed: true }),
      { kind: "owner-result", outcome: { kind: "refused", reason: "policy" } }, "a throwing policy is Off");
    assert.equal(provider.removes.length, 2);
    assert.deepEqual(h.savedPolicies.slice(0, 3), [
      { hostRunId: run, deleteExposed: false },
      { hostRunId: run, deleteExposed: true },
      { hostRunId: run, deleteExposed: false },
    ]);
  } finally {
    await h.stop();
  }
});

test("a reentrant notify cannot let a stale policy read overwrite the newer publication", async () => {
  let value = false;
  let reenter = true;
  let h: ReturnType<typeof harness> | undefined;
  h = harness({
    rows: [], capabilities: SAVED_CAPS, saved: new FakeSavedProvider(),
    deletePolicy: () => {
      const observed = value;
      if (reenter && h !== undefined) {
        // The policy callback is owner code: it changes the policy and notifies
        // from inside the publication that is reading it.
        reenter = false;
        value = true;
        h.owner.notifySavedPolicy?.();
      }
      return observed;
    },
  });
  const live = h;
  try {
    await live.viewer.hello;
    await live.viewer.subscribe();
    await until("a policy description", () => live.viewer.saved?.policy !== undefined);
    await settle();
    const published = live.pair.ownerSide.frames()
      .flatMap((frame) => (frame.type === "saved_policy" ? [frame.deleteExposed] : []));
    assert.deepEqual(published, [true], "only the newer publication reaches the wire");
    assert.deepEqual(live.viewer.saved?.policy, { hostRunId: live.inventory.hostRunId, deleteExposed: true });
  } finally {
    await live.stop();
  }
});

test("a delete that completed is reported truthfully after the policy turned Off, and the guard repeats the policy", async () => {
  let exposed = true;
  let release: () => void = () => undefined;
  let guardAfterOff: boolean | null = null;
  const provider = new FakeSavedProvider();
  provider.remove = (_request, guard) => new Promise<OwnerSavedDeleteFacts>((resolve) => {
    release = () => {
      guardAfterOff = guard();
      // The owner had already completed the removal before its last check.
      resolve({ kind: "deleted", method: "unlink" });
    };
  });
  const h = harness({ rows: [], capabilities: SAVED_CAPS, saved: provider, deletePolicy: () => exposed });
  try {
    await h.viewer.hello;
    await h.viewer.subscribe();
    const run = h.inventory.hostRunId;
    const listed = await listedWindow(h.viewer, run);
    const pending = h.viewer.saved!.remove({
      hostRunId: run, catalogId: listed.catalogId, resultId: listed.resultId, entryId: "entry-1", confirmed: true,
    });
    await until("the delete reaches the owner view", () => provider.removes.length === 1);
    exposed = false;
    release();
    assert.equal(guardAfterOff, false, "the provider's guard re-checks the live delete policy");
    assert.deepEqual(await mustSettle(pending, "the completed delete"),
      { kind: "owner-result", outcome: { kind: "deleted", method: "unlink" } },
      "an already-completed delete is reported, never re-gated on the current policy");
  } finally {
    await h.stop();
  }
});

test("the described policy returns to unknown when the channel is lost", async () => {
  const h = harness({ rows: [], capabilities: SAVED_CAPS, saved: new FakeSavedProvider(), deletePolicy: () => true });
  try {
    await h.viewer.hello;
    await h.viewer.subscribe();
    await until("the policy description", () => h.viewer.saved?.policy !== undefined);
    await h.pair.viewerSide.close();
    await settle();
    assert.equal(h.viewer.saved?.policy, undefined);
    assert.equal(h.savedPolicies[h.savedPolicies.length - 1], undefined, "the consumer is told it is unknown again");
  } finally {
    await h.owner.stopAll();
  }
});

test("busy and replayed requests never drop an older accepted result; a newer read supersedes only a read", async () => {
  const provider = new FakeSavedProvider();
  let releaseResume: () => void = () => undefined;
  provider.resume = (request) => new Promise<OwnerSavedResumeFacts>((resolve) => {
    releaseResume = () => resolve({ kind: "started", hostRunId: request.hostRunId, rowId: "native-7" });
  });
  const s = await savedOwnerHarness(provider, { deletePolicy: () => true });
  try {
    await s.subscribe();
    s.scripted.write(savedListFrame({ requestId: "list-1", sequence: 1 }));
    await until("the first window", () => s.pair.ownerSide.types().includes("saved_window_end"));
    const listedBegin = s.pair.ownerSide.frames().find((frame) => frame.type === "saved_window_begin");
    assert.ok(listedBegin !== undefined && listedBegin.type === "saved_window_begin");
    const ids = { catalogId: listedBegin.catalogId, resultId: listedBegin.resultId };

    s.scripted.write(savedResumeFrame({ requestId: "resume-2", sequence: 2, ...ids }));
    await until("the resume reaches the owner view", () => provider.resumes.length === 1);
    // Each refusal is answered before the next request arrives (the owner keeps at
    // most one refusal waiting for its single send slot).
    s.scripted.write(savedListFrame({ requestId: "replay", sequence: 2 }));
    await until("the replay refusal", () => savedResults(s.pair).length === 1);
    s.scripted.write(savedListFrame({ requestId: "busy-read", sequence: 3 }));
    await until("the busy-read refusal", () => savedResults(s.pair).length === 2);
    s.scripted.write(savedDeleteFrame({ requestId: "busy-delete", sequence: 4, ...ids }));
    await until("three refusals", () => savedResults(s.pair).length === 3);
    releaseResume();
    await until("the accepted resume's result", () => savedResults(s.pair).length === 4);
    assert.deepEqual(savedResults(s.pair), [
      ["replay", { kind: "refused", reason: "duplicate" }],
      ["busy-read", { kind: "refused", reason: "busy" }],
      ["busy-delete", { kind: "refused", reason: "busy" }],
      ["resume-2", { kind: "started", hostRunId: RUN_A, rowId: "native-7" }],
    ], "the older accepted operation still delivers its own correlated result");
    assert.equal(provider.lists.length, 1, "refused reads reached no provider");
    assert.equal(provider.removes.length, 0, "a busy delete reached no provider");

    // A newer read supersedes an older READ: its signal fires and it writes nothing.
    let openGate: () => void = () => undefined;
    provider.readGate = new Promise<void>((resolve) => {
      openGate = resolve;
    });
    s.scripted.write(savedListFrame({ requestId: "slow", sequence: 5 }));
    await until("the slow read reaches the view", () => provider.lists.length === 2);
    provider.readGate = null;
    s.scripted.write(savedListFrame({ requestId: "fast", sequence: 6 }));
    await until("the fast read completes", () => s.pair.ownerSide.frames()
      .some((frame) => frame.type === "saved_window_end" && frame.requestId === "fast"));
    openGate();
    await settle();
    assert.equal(provider.signals[1]?.aborted, true, "the superseded read was aborted");
    assert.equal(provider.signals[2]?.aborted, false);
    const touched = s.pair.ownerSide.frames().filter((frame) => "requestId" in frame && frame.requestId === "slow");
    assert.deepEqual(touched, [], "a superseded read writes nothing at all");
  } finally {
    await s.owner.stopAll();
  }
});

test("the viewer refuses a colliding request before submission and supersedes only an older read", async () => {
  const provider = new FakeSavedProvider();
  let releaseResume: () => void = () => undefined;
  provider.resume = (request) => new Promise<OwnerSavedResumeFacts>((resolve) => {
    releaseResume = () => resolve({ kind: "started", hostRunId: request.hostRunId, rowId: "native-3" });
  });
  const h = harness({ rows: [], capabilities: SAVED_CAPS, saved: provider, deletePolicy: () => true });
  try {
    await h.viewer.hello;
    await h.viewer.subscribe();
    const run = h.inventory.hostRunId;
    const saved = h.viewer.saved!;
    const listed = await listedWindow(h.viewer, run);
    const target = { hostRunId: run, catalogId: listed.catalogId, resultId: listed.resultId, entryId: "entry-0" };
    const resumed = saved.resume(target);
    await until("the resume reaches the owner view", () => provider.resumes.length === 1);
    assert.deepEqual(await saved.list({ hostRunId: run, query: "", offset: 0, count: 5 }), { kind: "not-sent", reason: "busy" });
    assert.deepEqual(await saved.remove({ ...target, confirmed: true }), { kind: "not-sent", reason: "busy" });
    releaseResume();
    assert.deepEqual(await mustSettle(resumed, "the resume"),
      { kind: "owner-result", outcome: { kind: "started", hostRunId: run, rowId: "native-3" } });

    let openGate: () => void = () => undefined;
    provider.readGate = new Promise<void>((resolve) => {
      openGate = resolve;
    });
    const older = saved.list({ hostRunId: run, query: "older", offset: 0, count: 5 });
    await until("the older read reaches the view", () => provider.lists.length === 2);
    provider.readGate = null;
    const newer = saved.list({ hostRunId: run, query: "newer", offset: 0, count: 5 });
    assert.deepEqual(await mustSettle(older, "the superseded read"), { kind: "unknown" });
    const fresh = await mustSettle(newer, "the newer read");
    assert.ok(fresh.kind === "owner-result" && fresh.outcome.kind === "window");
    openGate();
    await settle();
    assert.equal(h.pair.viewerSide.closedCalls, 0, "superseding a read is ordinary, never a violation");
    const sequences = h.pair.viewerSide.frames().flatMap((frame) =>
      (frame.type === "saved_list_request" || frame.type === "saved_resume_request" ? [frame.sequence] : []));
    assert.deepEqual(sequences, [1, 2, 3, 4], "refused-before-submission attempts consume no sequence");
  } finally {
    await h.stop();
  }
});

test("a late owner result after the requester's deadline is dropped and nothing is retried", async () => {
  const provider = new FakeSavedProvider();
  let releaseResume: () => void = () => undefined;
  provider.resume = (request) => new Promise<OwnerSavedResumeFacts>((resolve) => {
    releaseResume = () => resolve({ kind: "started", hostRunId: request.hostRunId, rowId: "native-late" });
  });
  const h = harness({ rows: [], capabilities: SAVED_CAPS, saved: provider });
  try {
    await h.viewer.hello;
    await h.viewer.subscribe();
    const run = h.inventory.hostRunId;
    const listed = await listedWindow(h.viewer, run);
    const resumed = h.viewer.saved!.resume({ hostRunId: run, catalogId: listed.catalogId, resultId: listed.resultId, entryId: "entry-2" });
    assert.deepEqual(await mustSettle(resumed, "the requester's deadline"), { kind: "unknown" });
    releaseResume();
    await until("the owner still reports its accepted work", () => h.pair.ownerSide.types().includes("saved_resume_result"));
    await settle();
    assert.equal(h.pair.viewerSide.frames().filter((frame) => frame.type === "saved_resume_request").length, 1,
      "nothing is re-sent, replayed, or cancelled for an unanswered resume");
    assert.equal(provider.resumes.length, 1);
    assert.equal(h.pair.viewerSide.closedCalls, 0, "a late correlated result is dropped, never a violation");
    // The channel stays healthy for the next request.
    await listedWindow(h.viewer, run);
  } finally {
    await h.stop();
  }
});

test("roster and Saved frames share one send slot and alternate fairly when both are waiting", async () => {
  const provider = new FakeSavedProvider();
  provider.total = 6;
  const rows = ["a", "b", "c", "d", "e", "f"];
  const h = harness({ rows, capabilities: SAVED_CAPS, saved: provider, bounds: { maxRowsPerPage: 1 } });
  try {
    await h.viewer.hello;
    const first = await h.viewer.subscribe();
    await until("the initial policy description", () => h.viewer.saved?.policy !== undefined);
    await settle();
    const run = h.inventory.hostRunId;
    const before = h.pair.ownerSide.sent.length;
    // Hold the slot with a fresh roster transfer, then queue a Saved window behind it.
    h.pair.ownerSide.hold = true;
    h.inventory.rows = rows.map((id) => ownerRow(id, { label: `Renamed ${id}` }));
    h.inventory.emit();
    const listing = h.viewer.saved!.list({ hostRunId: run, query: "", offset: 0, count: 6 });
    await until("the owner view answered", () => provider.lists.length === 1);
    await settle();
    h.pair.ownerSide.release();
    const listed = await mustSettle(listing, "the interleaved window");
    assert.ok(listed.kind === "owner-result" && listed.outcome.kind === "window" && listed.outcome.entries.length === 6);
    await until("the newer roster", () => (h.viewer.projection.revision ?? 0) > (first.revision ?? 0));
    const families = h.pair.ownerSide.types().slice(before)
      .filter((type) => type.startsWith("snapshot_") || type.startsWith("saved_window_"))
      .map((type) => (type.startsWith("snapshot_") ? "roster" : "saved"));
    assert.deepEqual(families, Array.from({ length: 16 }, (_unused, index) => (index % 2 === 0 ? "roster" : "saved")),
      "one frame from each transfer in turn, with no second queue and no starvation");
    assert.equal(h.viewer.projection.state, "current");
    assert.equal(h.viewer.projection.rows[0]?.label, "Renamed a");
  } finally {
    await h.stop();
  }
});

test("a Saved frame that cannot be written closes the channel exactly like a roster frame", async () => {
  const provider = new FakeSavedProvider();
  const h = harness({ rows: [], capabilities: SAVED_CAPS, saved: provider });
  provider.beforeAnswer = () => {
    h.pair.ownerSide.failNextSend = true;
  };
  try {
    await h.viewer.hello;
    await h.viewer.subscribe();
    const result = await mustSettle(
      h.viewer.saved!.list({ hostRunId: h.inventory.hostRunId, query: "", offset: 0, count: 5 }),
      "the unwritable window",
    );
    assert.deepEqual(result, { kind: "unknown" });
    assert.equal(h.pair.ownerSide.closedCalls, 1, "the failed protocol channel is closed through its bounded API");
    assert.ok(h.ownerDiagnostics.includes("send_failed"));
  } finally {
    await h.stop();
  }
});

test("a Saved query is exact, unclipped, and bounded only by one representable frame", async () => {
  const provider = new FakeSavedProvider();
  const h = harness({ rows: [], capabilities: SAVED_CAPS, saved: provider });
  try {
    await h.viewer.hello;
    await h.viewer.subscribe();
    const run = h.inventory.hostRunId;
    const saved = h.viewer.saved!;
    for (const query of ["  fix  the build  ", "\u{1f5c2} saved", "", "q".repeat(10_000)]) {
      const result = await mustSettle(saved.list({ hostRunId: run, query, offset: 0, count: 1 }), "an exact query");
      assert.equal(result.kind, "owner-result");
      assert.equal(provider.lists[provider.lists.length - 1]?.query, query, "the owner receives the exact query");
    }
    const before = h.pair.viewerSide.frames().length;
    for (const request of [
      { hostRunId: run, query: "q".repeat(70_000), offset: 0, count: 1 },
      { hostRunId: run, query: "\ud800", offset: 0, count: 1 },
      { hostRunId: run, query: "", offset: -1, count: 1 },
      { hostRunId: run, query: "", offset: 0, count: 0 },
      { hostRunId: run, query: "", offset: 0, count: 4_097 },
      { hostRunId: "-bad", query: "", offset: 0, count: 1 },
    ]) {
      assert.deepEqual(await saved.list(request), { kind: "not-sent", reason: "invalid-request" },
        `${JSON.stringify(request).slice(0, 60)} must be refused before submission`);
    }
    assert.deepEqual(await saved.list({ hostRunId: RUN_B, query: "", offset: 0, count: 1 }),
      { kind: "not-sent", reason: "target-unavailable" }, "another run is never guessed or substituted");
    assert.equal(h.pair.viewerSide.frames().length, before, "no refused request wrote anything");
  } finally {
    await h.stop();
  }
});

test("a multi-page Saved window completes while the roster stays idle after its first snapshot", async () => {
  const provider = new FakeSavedProvider();
  provider.total = 7;
  const h = harness({ rows: ["row-1"], capabilities: SAVED_CAPS, saved: provider, bounds: { maxRowsPerPage: 1 } });
  try {
    await h.viewer.hello;
    const first = await h.viewer.subscribe();
    await until("the initial policy description", () => h.viewer.saved?.policy !== undefined);
    await settle();
    // No inventory change follows: only Saved work is waiting for the slot.
    const listed = await listedWindow(h.viewer, h.inventory.hostRunId, 7);
    assert.equal(listed.entries.length, 7);
    assert.equal(h.pair.ownerSide.frames().filter((frame) => frame.type === "saved_window_page").length, 7,
      "every page of the window was written without any roster activity");
    const again = await mustSettle(h.viewer.saved!.window({
      hostRunId: h.inventory.hostRunId, catalogId: listed.catalogId, resultId: listed.resultId, offset: 3, count: 4,
    }), "a second window on the idle lane");
    assert.ok(again.kind === "owner-result" && again.outcome.kind === "window" && again.outcome.entries.length === 4);
    assert.equal(h.viewer.projection.revision, first.revision, "no roster change was needed to move Saved work");
  } finally {
    await h.stop();
  }
});

test("Saved policy publications and refusals wait for the one send slot and stay bounded", async () => {
  const provider = new FakeSavedProvider();
  let exposed = false;
  let releaseResume: () => void = () => undefined;
  provider.resume = (request) => new Promise<OwnerSavedResumeFacts>((resolve) => {
    releaseResume = () => resolve({ kind: "started", hostRunId: request.hostRunId, rowId: "native-held" });
  });
  const s = await savedOwnerHarness(provider, { deletePolicy: () => exposed });
  try {
    await s.subscribe();
    await until("the initial policy", () => s.pair.ownerSide.types().includes("saved_policy"));
    await settle();
    s.scripted.write(savedResumeFrame({ requestId: "accepted", sequence: 1 }));
    await until("the resume reaches the owner view", () => provider.resumes.length === 1);

    // A roster write that does not drain holds the channel's single send slot.
    s.pair.ownerSide.hold = true;
    s.inventory.emit();
    await until("the roster write holds the slot",
      () => s.pair.ownerSide.types().filter((type) => type === "snapshot_begin").length === 2);
    const held = s.pair.ownerSide.sent.length;
    for (const value of [true, false, true]) {
      exposed = value;
      s.owner.notifySavedPolicy?.();
    }
    s.scripted.write(savedListFrame({ requestId: "replay", sequence: 1 }));
    s.scripted.write(savedListFrame({ requestId: "busy-1", sequence: 2 }));
    s.scripted.write(savedDeleteFrame({ requestId: "busy-2", sequence: 3 }));
    await settle();
    assert.equal(s.pair.ownerSide.sent.length, held, "no Saved write bypasses the held slot");

    s.pair.ownerSide.release();
    await until("the bounded refusal and the coalesced policy", () =>
      s.pair.ownerSide.frames().filter((frame) => frame.type === "saved_policy").length === 2
      && savedResults(s.pair).length === 1);
    await settle();
    assert.deepEqual(savedResults(s.pair), [["replay", { kind: "refused", reason: "duplicate" }]],
      "one refusal waited for the slot; the excess was dropped, never accumulated");
    const policies = s.pair.ownerSide.frames().flatMap((frame) => (frame.type === "saved_policy" ? [frame.deleteExposed] : []));
    assert.deepEqual(policies, [false, true], "three notifications coalesced into one write of the live value");
    assert.ok(s.ownerDiagnostics.includes("saved_reply_dropped"));

    // The older accepted operation still delivers its own correlated result.
    releaseResume();
    await until("the accepted result", () => savedResults(s.pair).length === 2);
    assert.deepEqual(savedResults(s.pair)[1], ["accepted", { kind: "started", hostRunId: RUN_A, rowId: "native-held" }]);
  } finally {
    await s.owner.stopAll();
  }
});

test("a delete guard fails closed when its final authorizer turns exposure Off and notifies", async () => {
  let exposed = true;
  let mode: "off" | "off-then-on" | "none" = "off";
  let armed = false;
  let armedCalls = 0;
  const guardResults: boolean[] = [];
  let h: ReturnType<typeof harness> | undefined;
  const provider = new FakeSavedProvider();
  provider.remove = async (_request, guard) => {
    armed = true;
    armedCalls = 0;
    const ok = guard();
    armed = false;
    guardResults.push(ok);
    return ok ? { kind: "deleted", method: "trash" } : { kind: "refused", reason: "policy" };
  };
  h = harness({
    rows: [], capabilities: SAVED_CAPS, saved: provider,
    deletePolicy: () => exposed,
    authorize: () => {
      if (armed) {
        armedCalls += 1;
        // The FINAL authorizer callout inside the provider's last-instant guard
        // switches exposure Off and notifies, while still answering `true`.
        if (armedCalls === 2 && mode !== "none") {
          exposed = false;
          h?.owner.notifySavedPolicy?.();
          if (mode === "off-then-on") exposed = true;
        }
      }
      return true;
    },
  });
  const live = h;
  try {
    await live.viewer.hello;
    await live.viewer.subscribe();
    const run = live.inventory.hostRunId;
    const listed = await listedWindow(live.viewer, run);
    const target = (entryId: string) => ({
      hostRunId: run, catalogId: listed.catalogId, resultId: listed.resultId, entryId, confirmed: true,
    });

    assert.deepEqual(await mustSettle(live.viewer.saved!.remove(target("entry-0")), "an Off-during-proof delete"),
      { kind: "owner-result", outcome: { kind: "refused", reason: "policy" } });
    assert.deepEqual(guardResults, [false], "the guard never proves a delete the policy turned Off during");

    // Off and back On inside the same callout: the notification alone invalidates the proof.
    exposed = true;
    mode = "off-then-on";
    assert.deepEqual(await mustSettle(live.viewer.saved!.remove(target("entry-1")), "an Off-then-On delete"),
      { kind: "owner-result", outcome: { kind: "refused", reason: "policy" } });
    assert.deepEqual(guardResults, [false, false]);

    // Without interference the same guard proves an exposed delete.
    exposed = true;
    mode = "none";
    assert.deepEqual(await mustSettle(live.viewer.saved!.remove(target("entry-2")), "an undisturbed delete"),
      { kind: "owner-result", outcome: { kind: "deleted", method: "trash" } });
    assert.deepEqual(guardResults, [false, false, true]);
  } finally {
    await live.stop();
  }
});

test("an authorizer that notifies during a roster write never causes a second outstanding write", async () => {
  let exposed = false;
  let armed = false;
  let h: ReturnType<typeof harness> | undefined;
  h = harness({
    rows: ["a", "b", "c"], capabilities: SAVED_CAPS, saved: new FakeSavedProvider(),
    bounds: { maxRowsPerPage: 1 },
    deletePolicy: () => exposed,
    authorize: () => {
      if (armed) {
        // One-shot: the roster pump's own authorization callout publishes a
        // policy change, which reenters the pump while the outer pump is mid-check.
        armed = false;
        exposed = true;
        h?.owner.notifySavedPolicy?.();
      }
      return true;
    },
  });
  const live = h;
  try {
    await live.viewer.hello;
    const first = await live.viewer.subscribe();
    await until("the initial policy description", () => live.viewer.saved?.policy !== undefined);
    await settle();
    const before = live.pair.ownerSide.sent.length;
    live.pair.ownerSide.hold = true;
    armed = true;
    live.inventory.rows = ["a", "b", "c"].map((id) => ownerRow(id, { label: `Next ${id}` }));
    live.inventory.emit();
    await settle();
    assert.equal(armed, false, "the one-shot authorizer callout ran");
    assert.equal(live.pair.ownerSide.sent.length, before + 1, "exactly one write is outstanding on the held slot");

    live.pair.ownerSide.release();
    await until("the newer roster", () => (live.viewer.projection.revision ?? 0) > (first.revision ?? 0));
    await until("the newer policy", () => live.viewer.saved?.policy?.deleteExposed === true);
    const roster = live.pair.ownerSide.types().slice(before).filter((type) => type.startsWith("snapshot_"));
    assert.deepEqual(roster, ["snapshot_begin", "snapshot_page", "snapshot_page", "snapshot_page", "snapshot_end"],
      "the roster transfer completed once, with no duplicated frame");
    assert.equal(live.viewer.projection.state, "current");
    assert.deepEqual(live.viewer.projection.rows.map((row) => row.label), ["Next a", "Next b", "Next c"]);
    assert.equal(live.pair.viewerSide.closedCalls, 0, "the viewer never saw an incoherent transfer");
  } finally {
    await live.stop();
  }
});

test("an initial policy whose callback triggers a roster transfer is still published afterwards", async () => {
  let calls = 0;
  let h: ReturnType<typeof harness> | undefined;
  h = harness({
    rows: ["a"], capabilities: SAVED_CAPS, saved: new FakeSavedProvider(),
    deletePolicy: () => {
      calls += 1;
      if (calls === 1 && h !== undefined) {
        // The first policy read publishes one newer inventory snapshot, whose
        // roster write takes the slot before the policy can be written.
        h.inventory.rows = [ownerRow("a", { label: "Changed" })];
        h.inventory.emit();
      }
      return true;
    },
  });
  const live = h;
  try {
    await live.viewer.hello;
    const first = await live.viewer.subscribe();
    // No further notification or Saved request: the publication must survive on its own.
    await until("the current policy after the roster drains", () => live.viewer.saved?.policy?.deleteExposed === true);
    assert.deepEqual(live.viewer.saved?.policy, { hostRunId: live.inventory.hostRunId, deleteExposed: true });
    await until("the newer roster", () => (live.viewer.projection.revision ?? 0) > (first.revision ?? 0));
    assert.equal(live.viewer.projection.rows[0]?.label, "Changed");
    assert.ok(calls >= 2, "the policy was read again, fresh, when it was finally dispatched");
  } finally {
    await live.stop();
  }
});
