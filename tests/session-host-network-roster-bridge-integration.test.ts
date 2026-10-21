/**
 * Paired loopback coverage for the roster metadata bridge (#478) over the real
 * transport and the real owning-host service.
 *
 * Every test here builds synthetic in-memory identities, binds an owned loopback
 * port, and pairs a real `PeerHost`/`PeerClient` WSS channel, then runs the real
 * `createRosterBridgeHost` owner against `createLocalOwningHostService`'s
 * authoritative inventory watch and the real `attachRosterBridgeViewer` viewer.
 * The session manager is a thin fake only because a real one owns PTYs: it holds
 * row state and fires the manager's own change hook, and every operation other
 * than `list()` is recorded so a test can prove the bridge never reaches for one.
 *
 * Nothing here touches a live host, a product listener, a filesystem path, a
 * process, or a clipboard.
 */

import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import type { InstanceManagerOptions, NativeInstanceView } from "../src/session-host/instances";
import type { SessionHostNativeSession } from "../src/session-host/protocol";
import {
  createLocalOwningHostService,
  type OwningHostManager,
  type OwningHostService,
} from "../src/session-host/owning-host-service";
import type { PeerByteChannel } from "../src/session-host/network/channel";
import {
  ROSTER_BRIDGE_MAJOR,
  ROSTER_BRIDGE_REQUIRED_CAPABILITY,
  attachRosterBridgeViewer,
  createRosterBridgeHost,
  decodeRosterBridgeFrame,
  isRosterBridgeViewerError,
  type PeerClient,
  type RosterBridgeBounds,
  type RosterBridgeChannelBinding,
  type RosterBridgeFrame,
  type RosterBridgeHost,
  type RosterBridgeInventorySource,
  type RosterBridgeViewer,
} from "../src/session-host/network/index";
import {
  newIdentity,
  startClient,
  startHost,
  withTimeout,
  type HostFixture,
} from "./session-host-network-helpers";

const SECRET_AGENT_DIR = "/Users/owner/.pi/agent";
const SECRET_WORKSPACE = "/srv/owner/日本語-work";

function nativeSession(id: string): SessionHostNativeSession {
  return { sessionId: `conversation-${id}`, epoch: 3, name: `Conversation ${id}` };
}

type MutableView = {
  -readonly [K in keyof NativeInstanceView]: NativeInstanceView[K] extends readonly (infer Item)[] ? Item[] : NativeInstanceView[K];
};

function rowView(id: string, overrides: Partial<NativeInstanceView> = {}): MutableView {
  return {
    id,
    label: `Row ${id}`,
    workspace: SECRET_WORKSPACE,
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
    ...overrides,
  } as MutableView;
}

/** A thin stand-in for the authoritative manager: rows plus its change hook. */
class TestManager {
  readonly rows: MutableView[] = [];
  readonly otherCalls: string[] = [];
  listCalls = 0;
  listThrows = false;
  listReturnsDetachedViews = true;
  /** Runs once after the rows are read and before `list()` returns. */
  listHook: (() => void) | undefined;
  #change: ((instanceId: string) => void) | undefined;

  openManager(options: InstanceManagerOptions): void {
    this.#change = options.onChange;
  }

  emitChange(instanceId: string): void {
    try {
      this.#change?.(instanceId);
    } catch {
      // The real manager contains host hook failures.
    }
  }

  list(): NativeInstanceView[] {
    this.listCalls += 1;
    if (this.listThrows) throw new Error("synthetic listing failure");
    const views = this.listReturnsDetachedViews
      ? this.rows.map((row) => Object.freeze({ ...row, activity: Object.freeze([...row.activity]) }))
      : [...this.rows];
    const hook = this.listHook;
    if (hook !== undefined) {
      this.listHook = undefined;
      hook();
    }
    return views;
  }

  addRow(id: string, overrides?: Partial<NativeInstanceView>): MutableView {
    const row = rowView(id, overrides);
    this.rows.push(row);
    return row;
  }

  rename(id: string, label: string): void {
    const row = this.rows.find((candidate) => candidate.id === id);
    if (row !== undefined) row.label = label;
  }

  setStatus(id: string, update: Partial<NativeInstanceView>): void {
    const row = this.rows.find((candidate) => candidate.id === id);
    if (row !== undefined) Object.assign(row, update);
  }

  // Everything else is recorded so a test can prove it was never used.
  create(): Promise<string> { this.otherCalls.push("create"); return Promise.resolve("never"); }
  write(): void { this.otherCalls.push("write"); }
  resize(): void { this.otherCalls.push("resize"); }
  surface(): undefined { this.otherCalls.push("surface"); return undefined; }
  closeExited(): boolean { this.otherCalls.push("closeExited"); return false; }
  hasLiveProcesses(): boolean { this.otherCalls.push("hasLiveProcesses"); return this.rows.some((row) => row.hasLiveProcess); }
  ownedLiveSessions(): readonly unknown[] { this.otherCalls.push("ownedLiveSessions"); return []; }
  openViewer(): undefined { this.otherCalls.push("openViewer"); return undefined; }
  viewerState(): undefined { this.otherCalls.push("viewerState"); return undefined; }
  sessionViewers(): readonly never[] { this.otherCalls.push("sessionViewers"); return []; }
  updateViewer(): never { this.otherCalls.push("updateViewer"); throw new Error("unreachable"); }
  closeViewer(): boolean { this.otherCalls.push("closeViewer"); return false; }
  instanceGeometry(): undefined { this.otherCalls.push("instanceGeometry"); return undefined; }
  setInitialGeometry(): void { this.otherCalls.push("setInitialGeometry"); }
  async shutdown(): Promise<{ forcedIds: string[]; remainingIds: string[] }> {
    this.otherCalls.push("shutdown");
    return { forcedIds: [], remainingIds: [] };
  }
  async dispose(): Promise<void> { this.otherCalls.push("dispose"); }

  asManager(): OwningHostManager {
    return this as unknown as OwningHostManager;
  }
}

/**
 * A pass-through tap on the owner's channel. It records every encoded frame that
 * leaves the owner and can hold writes pending, which is how a test produces
 * real backpressure and inspects the middle of a transfer.
 */
class WireTap implements PeerByteChannel {
  readonly sent: Buffer[] = [];
  held = false;
  closeCalls = 0;
  /** Refuse the next write outright, as a socket that will not take the bytes. */
  failNext = false;
  failedSends = 0;
  #queue: { bytes: Buffer; settle: () => void }[] = [];

  constructor(readonly inner: PeerByteChannel) {}

  get peerKey(): PeerByteChannel["peerKey"] {
    return this.inner.peerKey;
  }

  get label(): string | null {
    return this.inner.label;
  }

  get bufferedAmount(): number {
    return this.inner.bufferedAmount;
  }

  get closed(): Promise<{ code: number; reason: string }> {
    return this.inner.closed;
  }

  send(bytes: Uint8Array): Promise<void> {
    const copy = Buffer.from(bytes);
    if (this.failNext) {
      this.failNext = false;
      this.failedSends += 1;
      return Promise.reject(new Error("synthetic send failure"));
    }
    this.sent.push(copy);
    if (this.held) {
      return new Promise<void>((resolve) => {
        this.#queue.push({ bytes: copy, settle: resolve });
      });
    }
    return this.inner.send(bytes);
  }

  release(): void {
    const queued = this.#queue;
    this.#queue = [];
    this.held = false;
    for (const entry of queued) {
      entry.settle();
      void this.inner.send(entry.bytes).catch(() => undefined);
    }
  }

  close(): Promise<void> {
    this.closeCalls += 1;
    return this.inner.close();
  }

  onMessage(handler: (bytes: Buffer) => void): () => void {
    return this.inner.onMessage(handler);
  }

  frames(): RosterBridgeFrame[] {
    return this.sent.map((bytes) => decodeRosterBridgeFrame(bytes));
  }

  types(): string[] {
    return this.frames().map((frame) => frame.type);
  }

  text(): string {
    return this.sent.map((bytes) => bytes.toString("utf8")).join("\n");
  }
}

interface OwnerFixture {
  readonly host: HostFixture;
  readonly service: OwningHostService;
  readonly manager: TestManager;
  readonly roster: RosterBridgeHost;
  readonly taps: WireTap[];
  readonly bindings: RosterBridgeChannelBinding[];
  readonly diagnostics: string[];
  authorize(value: boolean | ((keyId: string) => boolean)): void;
}

async function startOwner(
  t: TestContext,
  options: {
    bounds?: Partial<RosterBridgeBounds>;
    rows?: readonly string[];
    authorize?: boolean | ((keyId: string) => boolean);
    source?: (service: OwningHostService) => RosterBridgeInventorySource;
  } = {},
): Promise<OwnerFixture> {
  const identity = await newIdentity("owner-host");
  const manager = new TestManager();
  for (const id of options.rows ?? ["row-1", "row-2", "row-3"]) manager.addRow(id);
  let teardown = false;
  const service = createLocalOwningHostService({
    createManager: (managerOptions) => {
      manager.openManager(managerOptions);
      return manager.asManager();
    },
    teardownRequested: () => teardown,
  });
  service.openManager({
    packageRoot: "/synthetic/package",
    piExecutable: "/synthetic/pi",
    statusRegistrar: { register: () => { throw new Error("the bridge never registers a reporter"); } },
    cols: 100,
    rows: 30,
    getSidebarTitleColumns: () => 42,
    onChange: () => undefined,
  } as InstanceManagerOptions);

  const bindings: RosterBridgeChannelBinding[] = [];
  const taps: WireTap[] = [];
  const diagnostics: string[] = [];
  let allowed: boolean | ((keyId: string) => boolean) = options.authorize ?? true;
  const roster = createRosterBridgeHost({
    inventory: options.source?.(service) ?? service,
    authorizePeer: (peerKey) => (typeof allowed === "function" ? allowed(peerKey.keyId) : allowed),
    bounds: options.bounds,
    onDiagnostic: (event) => {
      diagnostics.push(event.code);
    },
  });
  const host = await startHost(t, {
    identity,
    onPairingRequest: (request) => {
      request.approve();
    },
    onAppChannel: (channel) => {
      const tap = new WireTap(channel);
      taps.push(tap);
      bindings.push(roster.attach(tap));
    },
  });
  t.after(async () => {
    await roster.stopAll();
  });
  return {
    host,
    service,
    manager,
    roster,
    taps,
    bindings,
    diagnostics,
    authorize(value): void {
      allowed = value;
    },
  };
}

async function connectViewer(
  t: TestContext,
  owner: OwnerFixture,
  label = "viewer-laptop",
  bounds?: Partial<RosterBridgeBounds>,
): Promise<{ viewer: RosterBridgeViewer; channel: PeerByteChannel; client: PeerClient }> {
  const identity = await newIdentity(label);
  const client = startClient(t, identity);
  const paired = await client.client.pair({ port: owner.host.port, approveServerKey: () => "accept" });
  assert.equal(paired.ok, true);
  const channel = await client.client.connectApp({
    port: owner.host.port,
    approveServerKey: () => {
      throw new Error("the server key is already remembered");
    },
  });
  const viewer = attachRosterBridgeViewer({
    channel,
    ...(bounds === undefined ? {} : { bounds }),
  });
  t.after(async () => {
    await viewer.stop();
    await channel.close();
  });
  return { viewer, channel, client: client.client };
}

async function settle(times = 6): Promise<void> {
  for (let index = 0; index < times; index += 1) await new Promise<void>((resolve) => setImmediate(resolve));
}

/**
 * Wait for a condition across a real socket. A fixed number of microtask turns is
 * not a synchronization primitive when bytes travel through TLS, so each test
 * states the fact it is waiting for and fails with that name if it never arrives.
 */
async function until(label: string, predicate: () => boolean, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise<void>((resolve) => setTimeout(resolve, 2));
  }
}

test("a paired viewer sees the owner's live roster with exact approved fields and no private data", async (t) => {
  const owner = await startOwner(t, {
    rows: ["row-1", "row-2", "row-3"],
  });
  const { viewer, channel } = await connectViewer(t, owner);
  await viewer.hello;
  assert.equal(owner.roster.activeBindingCount, 1);
  assert.equal(owner.roster.activeSubscriptionCount, 0, "a hello alone subscribes nothing");

  const snapshot = await withTimeout(viewer.subscribe(), 5_000, "first snapshot");
  assert.equal(snapshot.state, "current");
  assert.deepEqual(snapshot.rows.map((row) => row.id), ["row-1", "row-2", "row-3"]);
  assert.equal(snapshot.rows[0]?.workspace, SECRET_WORKSPACE, "the approved owner workspace crosses exactly");
  assert.equal(snapshot.rows[0]?.busy, null, "unknown observations survive TLS intact");
  assert.equal(snapshot.rows[0]?.backgroundTasks, null);
  assert.equal(snapshot.rows[0]?.activeTasks, null);
  assert.equal(snapshot.rows[0]?.nativeSession?.sessionId, "conversation-row-1");
  assert.equal(owner.service.readInventorySnapshot()?.hostRunId, snapshot.hostRunId,
    "the projection carries the one manager's actual run identity");
  assert.deepEqual(owner.manager.otherCalls, [], "reading a roster touches no manager operation but list()");

  const tap = owner.taps[0];
  assert.ok(tap);
  const wire = tap.text();
  assert.equal(wire.includes(SECRET_AGENT_DIR), false, "the private agent directory never reaches the socket");
  assert.equal(wire.includes("agentDir"), false);
  assert.equal(wire.includes("currentFile"), false);
  assert.equal(wire.includes("lastNativeSession"), false);
  assert.equal(wire.includes(owner.host.identity.key.keyId), false, "identity is never echoed on the wire");
  assert.deepEqual(tap.types(), ["hello_ack", "snapshot_begin", "snapshot_page", "snapshot_end"]);

  // A live owner change moves the projection without a new subscription.
  owner.manager.rename("row-2", "Renamed");
  owner.manager.emitChange("row-2");
  await until("the renamed row on the viewer", () => viewer.projection.rows.find((row) => row.id === "row-2")?.label === "Renamed");
  assert.equal(viewer.projection.state, "current");
  assert.equal(viewer.subscriptionId, snapshot.subscriptionId, "the same subscription keeps streaming");

  await viewer.stop();
  await settle();
  assert.equal(owner.roster.activeSubscriptionCount, 0);
  assert.equal(channel.closed instanceof Promise, true);
});

test("a five-row roster crosses as atomic pages and a mid-transfer change still lands newest", async (t) => {
  const owner = await startOwner(t, {
    rows: ["a", "b", "c", "d", "e"],
    bounds: { maxRowsPerPage: 2 },
  });
  const { viewer } = await connectViewer(t, owner);
  await viewer.hello;
  const tap = owner.taps[0];
  assert.ok(tap);
  tap.held = true;
  const published: number[] = [];
  viewer.onProjection((projection) => {
    if (projection.state === "current") published.push(projection.revision ?? -1);
  });
  const first = viewer.subscribe();
  await until("the owner begins the paged transfer", () => tap.types().includes("snapshot_begin"));
  // The owner is blocked inside its first transfer, so a real change now lands
  // while pages are queued.
  assert.deepEqual(tap.types(), ["hello_ack", "snapshot_begin"], "the transfer is genuinely mid-flight");
  owner.manager.rename("c", "Renamed during paging");
  owner.manager.emitChange("c");
  await settle();
  assert.equal(viewer.projection.rows.length, 0, "queued pages are never published early");

  tap.release();
  const snapshot = await withTimeout(first, 5_000, "first paged snapshot");
  await settle();
  assert.equal(snapshot.state, "current");
  assert.equal(snapshot.rows.length, 5);
  const types = tap.types();
  assert.equal(types.filter((type) => type === "snapshot_begin").length, 2,
    "the retained change is published as another complete snapshot");
  assert.equal(types.filter((type) => type === "snapshot_end").length, 2);
  assert.equal(types.lastIndexOf("snapshot_end") > types.lastIndexOf("snapshot_begin"), true);
  await until("the newest roster on the viewer", () => viewer.projection.rows.find((row) => row.id === "c")?.label === "Renamed during paging");
  assert.equal(published.length, 2, "exactly two atomic publications, no partial page in between");
  assert.ok(published[1] !== undefined && published[1] > published[0], "revisions only move forward");
});

test("many changes during one transfer collapse to the newest pending snapshot", async (t) => {
  const owner = await startOwner(t, { rows: ["a"] });
  const { viewer } = await connectViewer(t, owner);
  await viewer.hello;
  const tap = owner.taps[0];
  assert.ok(tap);
  tap.held = true;
  const first = viewer.subscribe();
  await until("the owner begins the first transfer", () => tap.types().includes("snapshot_begin"));
  for (let index = 0; index < 12; index += 1) {
    owner.manager.rename("a", `pass-${index}`);
    owner.manager.emitChange("a");
  }
  tap.release();
  await withTimeout(first, 5_000, "first snapshot");
  await until("the newest pass on the viewer", () => viewer.projection.rows[0]?.label === "pass-11");
  const types = tap.types();
  const begins = types.filter((type) => type === "snapshot_begin").length;
  assert.ok(begins <= 3, `one in-flight plus one newest pending bounds change pressure (${begins} transfers)`);
  assert.equal(viewer.projection.state, "current");
});

test("a change published while the watch is being installed lands as a second snapshot", async (t) => {
  const owner = await startOwner(t, { rows: ["row-1"] });
  owner.manager.rename("row-1", "Before");
  const { viewer } = await connectViewer(t, owner);
  await viewer.hello;
  // The manager's listing returns, a real change lands before the install
  // capture is handed back, and the viewer must see both, in order.
  owner.manager.listHook = () => {
    owner.manager.rename("row-1", "During");
    owner.manager.emitChange("row-1");
  };
  const published: string[] = [];
  viewer.onProjection((projection) => {
    if (projection.state === "current") published.push(String(projection.rows[0]?.label));
  });
  const first = await withTimeout(viewer.subscribe(), 5_000, "install snapshot");
  await until("the retained install-race change", () => published.includes("During"));
  assert.equal(first.rows[0]?.label, "Before", "the install snapshot is exactly what its listing read");
  assert.deepEqual(published, ["Before", "During"], "the retained change follows instead of overwriting it");
  assert.equal(viewer.projection.rows[0]?.label, "During");
});

test("revoking authorization before a queued page stops metadata without touching a session", async (t) => {
  const owner = await startOwner(t, { rows: ["a", "b", "c"], bounds: { maxRowsPerPage: 1 } });
  const { viewer } = await connectViewer(t, owner);
  await viewer.hello;
  const tap = owner.taps[0];
  assert.ok(tap);
  tap.held = true;
  const published = viewer.subscribe();
  await until("the owner begins before the revocation", () => tap.types().includes("snapshot_begin"));
  assert.deepEqual(tap.types(), ["hello_ack", "snapshot_begin"]);
  owner.authorize(false);
  tap.release();
  await assert.rejects(published, (error: unknown) => isRosterBridgeViewerError(error) && error.code === "refused");
  await until("the owner stops writing", () => owner.roster.activeSubscriptionCount === 0);
  const types = tap.types();
  assert.equal(types.includes("snapshot_end"), false, "no protected write happens after the revocation");
  assert.equal(types.filter((type) => type === "error").length, 1);
  const errorFrame = tap.frames().find((frame) => frame.type === "error");
  assert.ok(errorFrame?.type === "error" && errorFrame.code === "not_authorized");
  assert.equal(viewer.projection.state !== "current", true);
  assert.equal(viewer.projection.reason, "authorization-refused");
  assert.equal(owner.roster.activeSubscriptionCount, 0, "the subscription ended and the source watch was retired");
  assert.deepEqual(owner.manager.otherCalls, [], "no stop, close, shutdown, or write was ever attempted");
  assert.equal(owner.host.activeChannelCount, 1, "the transport keeps its own existing channel policy");
  assert.equal(tap.closeCalls, 0, "an authorization refusal does not close the channel here");
});

test("an unreadable inventory refuses the subscription and an explicit fresh one recovers", async (t) => {
  const owner = await startOwner(t, { rows: ["row-1"] });
  const { viewer } = await connectViewer(t, owner);
  await viewer.hello;
  owner.manager.listThrows = true;
  await assert.rejects(viewer.subscribe(), (error: unknown) => isRosterBridgeViewerError(error) && error.code === "refused");
  assert.equal(viewer.projection.state, "empty");
  assert.equal(viewer.projection.reason, "source-unavailable");
  assert.equal(viewer.projection.rows.length, 0, "an unreadable inventory is never reported as an empty roster");
  assert.equal(owner.roster.activeSubscriptionCount, 0);

  owner.manager.listThrows = false;
  const snapshot = await withTimeout(viewer.subscribe(), 5_000, "recovered subscription");
  assert.equal(snapshot.state, "current");
  assert.deepEqual(snapshot.rows.map((row) => row.id), ["row-1"]);
});

test("a source that becomes unreadable mid-subscription tells the viewer instead of going idle", async (t) => {
  const owner = await startOwner(t, { rows: ["row-1", "row-2"] });
  const { viewer } = await connectViewer(t, owner);
  await viewer.hello;
  const snapshot = await withTimeout(viewer.subscribe(), 5_000, "first snapshot");
  assert.equal(snapshot.rows.length, 2);
  owner.manager.listThrows = true;
  owner.manager.emitChange("row-1");
  await until("the unavailable notice", () => viewer.projection.state === "stale");
  assert.equal(viewer.projection.state, "stale");
  assert.equal(viewer.projection.reason, "source-unavailable");
  assert.equal(viewer.projection.rows.length, 2, "the last complete roster is retained as last-observed");
  assert.equal(viewer.subscriptionId, null);
  assert.equal(owner.roster.activeSubscriptionCount, 0);
});

test("an equal-revision resync recovers freshness without any owner mutation", async (t) => {
  const owner = await startOwner(t, { rows: ["a", "b"] });
  const { viewer } = await connectViewer(t, owner);
  await viewer.hello;
  const first = await withTimeout(viewer.subscribe(), 5_000, "first snapshot");
  assert.equal(first.state, "current");
  const firstRevision = first.revision;
  const firstSubscription = first.subscriptionId;
  assert.ok(firstRevision !== null && firstSubscription !== null);

  // No manager change at all: only an explicit resync.
  const resynced = await withTimeout(viewer.resync(), 5_000, "resync snapshot");
  assert.notEqual(resynced.subscriptionId, firstSubscription, "resync uses a fresh subscription identifier");
  assert.ok((resynced.revision ?? 0) >= (firstRevision ?? 0),
    "a fresh subscription never moves the roster backwards in the same run");
  assert.equal(resynced.hostRunId, first.hostRunId, "the resync stays on the one manager run");
  assert.deepEqual(owner.manager.otherCalls, [], "recovering freshness asked the owner to change nothing");
  assert.equal(resynced.state, "current");
  assert.deepEqual(resynced.rows.map((row) => row.id), ["a", "b"]);
  assert.equal(owner.roster.activeSubscriptionCount, 1, "the retired subscription left exactly one live");
  const tap = owner.taps[0];
  assert.ok(tap);
  const types = tap.types();
  const unsubscribeIndex = types.lastIndexOf("unsubscribed");
  const lastBegin = types.lastIndexOf("snapshot_begin");
  assert.ok(unsubscribeIndex !== -1 && lastBegin > unsubscribeIndex,
    "the fresh transfer starts only after the stop acknowledgement");
});

test("stop is idempotent, releases the source watch, and leaves the channel usable", async (t) => {
  const owner = await startOwner(t, { rows: ["a"] });
  const { viewer, channel, client } = await connectViewer(t, owner);
  await viewer.hello;
  await withTimeout(viewer.subscribe(), 5_000, "first snapshot");
  assert.equal(owner.roster.activeSubscriptionCount, 1);
  await viewer.stop();
  await viewer.stop();
  await until("the owner retires the watch", () => owner.roster.activeSubscriptionCount === 0);
  assert.equal(owner.roster.activeSubscriptionCount, 0);
  assert.equal(owner.roster.activeBindingCount, 1,
    "stopping metadata leaves the attached binding on the still-open channel");
  assert.equal(viewer.projection.state, "stale");
  assert.equal(viewer.projection.rows.length, 1, "stopping never fabricates an empty roster");
  const tap = owner.taps[0];
  assert.ok(tap);
  assert.equal(tap.types().filter((type) => type === "unsubscribed").length, 1, "one acknowledgement for repeated stops");
  assert.equal(tap.closeCalls, 0, "metadata teardown does not close the channel");
  assert.equal(channel.closed instanceof Promise, true);
  // The channel is still open and still authenticated: a fresh app channel from
  // the same paired client negotiates its own metadata session.
  const second = await client.connectApp({
    port: owner.host.port,
    approveServerKey: () => {
      throw new Error("the server key is already remembered");
    },
  });
  t.after(async () => {
    await second.close();
  });
  const revived = attachRosterBridgeViewer({ channel: second });
  t.after(async () => {
    await revived.stop();
  });
  await revived.hello;
  const again = await withTimeout(revived.subscribe(), 5_000, "re-subscribed snapshot");
  assert.equal(again.state, "current");
  assert.equal(owner.roster.activeSubscriptionCount, 1);
  assert.equal(owner.roster.activeBindingCount, 2, "each app channel carries its own metadata binding");
});

test("transport loss marks the projection not current and releases the owner's watch", async (t) => {
  const owner = await startOwner(t, { rows: ["a", "b"] });
  const { viewer, channel } = await connectViewer(t, owner);
  await viewer.hello;
  await withTimeout(viewer.subscribe(), 5_000, "first snapshot");
  assert.equal(owner.roster.activeSubscriptionCount, 1);
  await channel.close();
  await until("the viewer notices the lost channel", () => viewer.projection.reason === "channel-closed");
  await until("the owner notices the lost channel", () => owner.roster.activeSubscriptionCount === 0);
  assert.equal(viewer.projection.state, "stale");
  assert.equal(viewer.projection.reason, "channel-closed");
  assert.equal(viewer.projection.rows.length, 2, "a lost channel is never an empty roster");
  assert.equal(viewer.subscriptionId, null);
  assert.equal(owner.roster.activeSubscriptionCount, 0, "the owner retired its source watch");
  assert.equal(owner.roster.activeBindingCount, 0);
  assert.deepEqual(owner.manager.otherCalls, [], "losing a viewer never touches a session");
});

test("a manager run change is never blended into the existing roster", async (t) => {
  // A thin relabeling of the real service's snapshots stands in for the host
  // process restarting: the run identity changes underneath the live channel.
  const run: { label: string | null } = { label: null };
  const owner = await startOwner(t, {
    rows: ["a"],
    source: (service) => {
      const relabel = <T extends { hostRunId: string }>(snapshot: T): T =>
        run.label === null ? snapshot : Object.freeze({ ...snapshot, hostRunId: run.label });
      return {
        watchInventory: (listener) => {
          const watch = service.watchInventory((snapshot) => {
            listener(snapshot === undefined ? undefined : relabel(snapshot));
          });
          if (watch === undefined) return undefined;
          return Object.freeze({
            snapshot: relabel(watch.snapshot),
            unsubscribe: () => {
              watch.unsubscribe();
            },
          });
        },
      };
    },
  });
  const { viewer } = await connectViewer(t, owner);
  await viewer.hello;
  const first = await withTimeout(viewer.subscribe(), 5_000, "first snapshot");
  assert.equal(first.state, "current");
  const originalRun = first.hostRunId;
  assert.ok(originalRun);

  // Simulate the restart, then a change on the new run.
  owner.manager.addRow("b");
  run.label = "restart-run-2";
  const tap = owner.taps[0];
  assert.ok(tap);
  const before = tap.types().length;
  owner.manager.emitChange("b");
  await until("the run-change notice", () => viewer.projection.reason === "run-changed");
  assert.ok(tap.types().length > before, "the owner reacted to the change");
  assert.equal(viewer.projection.state, "stale");
  assert.equal(viewer.projection.reason, "run-changed");
  assert.equal(viewer.projection.rows.length, 1, "the previous run's rows stay last-observed, unblended");
  assert.equal(viewer.projection.hostRunId, originalRun);
  assert.equal(owner.roster.activeSubscriptionCount, 0);

  // A fresh subscription adopts the new run.
  const second = await withTimeout(viewer.subscribe(), 5_000, "post-restart snapshot");
  assert.equal(second.state, "current");
  assert.notEqual(second.hostRunId, originalRun);
  assert.deepEqual(second.rows.map((row) => row.id), ["a", "b"]);
});

test("two viewers keep independent projections and one stop does not disturb the other", async (t) => {
  const owner = await startOwner(t, { rows: ["a", "b"] });
  const first = await connectViewer(t, owner, "viewer-one");
  const second = await connectViewer(t, owner, "viewer-two");
  await Promise.all([first.viewer.hello, second.viewer.hello]);
  const [firstSnapshot, secondSnapshot] = await Promise.all([
    withTimeout(first.viewer.subscribe(), 5_000, "first viewer"),
    withTimeout(second.viewer.subscribe(), 5_000, "second viewer"),
  ]);
  assert.equal(owner.roster.activeSubscriptionCount, 2);
  assert.notEqual(firstSnapshot.subscriptionId, secondSnapshot.subscriptionId);
  assert.equal(first.viewer.peerKey.keyId, owner.host.identity.key.keyId,
    "a viewer's identity is the owner's actual verified channel key");
  assert.equal(second.viewer.peerKey.keyId, owner.host.identity.key.keyId);
  assert.notEqual(owner.taps[0]?.peerKey.keyId, owner.taps[1]?.peerKey.keyId,
    "the owner authorizes each channel by its own verified viewer key");

  owner.manager.rename("a", "Renamed");
  owner.manager.emitChange("a");
  await until("both viewers see the rename", () => first.viewer.projection.rows[0]?.label === "Renamed"
    && second.viewer.projection.rows[0]?.label === "Renamed");

  await first.viewer.stop();
  await until("only one subscription remains", () => owner.roster.activeSubscriptionCount === 1);
  assert.equal(owner.roster.activeSubscriptionCount, 1, "one viewer's stop ends only its own subscription");
  assert.equal(second.viewer.projection.state, "current");
  owner.manager.rename("b", "Later");
  owner.manager.emitChange("b");
  await until("the surviving viewer keeps streaming", () => second.viewer.projection.rows[1]?.label === "Later");
  assert.equal(second.viewer.projection.rows[1]?.label, "Later", "the surviving viewer keeps streaming");
  assert.equal(first.viewer.projection.rows[0]?.label, "Renamed", "the stopped viewer's last snapshot stays frozen");
  assert.equal(first.viewer.projection.rows[1]?.label, "Row b",
    "a change that landed after its stop is not retroactively applied");
  assert.equal(first.viewer.projection.state, "stale");
});

test("an oversized frame bound fails the transfer instead of shipping a truncated roster", async (t) => {
  const owner = await startOwner(t, {
    rows: ["a", "b"],
    // A budget smaller than one approved row: the snapshot is unrepresentable, so
    // it must be refused whole rather than clipped into a fake roster.
    bounds: { maxFrameBytes: 256, maxPageBytes: 256, maxSnapshotBytes: 2_048, maxSnapshotRows: 4, maxRowsPerPage: 2 },
  });
  const identity = await newIdentity("small-frame-viewer");
  const client = startClient(t, identity);
  await client.client.pair({ port: owner.host.port, approveServerKey: () => "accept" });
  const channel = await client.client.connectApp({
    port: owner.host.port,
    approveServerKey: () => {
      throw new Error("remembered");
    },
  });
  const viewer = attachRosterBridgeViewer({
    channel,
    bounds: { maxFrameBytes: 256, maxPageBytes: 256, maxSnapshotBytes: 2_048, maxSnapshotRows: 4, maxRowsPerPage: 2 },
  });
  t.after(async () => {
    await viewer.stop();
    await channel.close();
  });
  await viewer.hello;
  await assert.rejects(viewer.subscribe(), (error: unknown) => isRosterBridgeViewerError(error));
  assert.equal(viewer.projection.rows.length, 0, "an unrepresentable snapshot is refused whole");
  assert.equal(viewer.projection.reason, "transfer-failed");
  assert.equal(owner.roster.activeSubscriptionCount, 0);
  const tap = owner.taps[0];
  assert.ok(tap);
  assert.deepEqual(tap.types(), ["hello_ack", "error"], "no partial page is written");
});

test("an unknown optional capability is ignored while the required baseline still negotiates", async (t) => {
  const owner = await startOwner(t, { rows: ["a"] });
  const identity = await newIdentity("capability-viewer");
  const client = startClient(t, identity);
  await client.client.pair({ port: owner.host.port, approveServerKey: () => "accept" });
  const channel = await client.client.connectApp({
    port: owner.host.port,
    approveServerKey: () => {
      throw new Error("remembered");
    },
  });
  // "roster-v2-maybe" is an optional capability this owner never implemented; the
  // required roster-v1 baseline is still offered and still refused nothing.
  const viewer = attachRosterBridgeViewer({
    channel,
    capabilities: ["roster-v2-maybe", ROSTER_BRIDGE_REQUIRED_CAPABILITY],
  });
  t.after(async () => {
    await viewer.stop();
    await channel.close();
  });
  await viewer.hello;
  const tap = owner.taps[0];
  assert.ok(tap);
  // The owner's whole pre-subscription output is one acknowledgement: it states
  // the set in force, which is the baseline alone, never an unimplemented
  // capability the viewer asked for.
  assert.deepEqual(tap.types(), ["hello_ack"], "an unknown optional capability earns no extra behaviour");
  const ack = tap.frames()[0];
  assert.ok(ack?.type === "hello_ack");
  assert.equal(ack.major, ROSTER_BRIDGE_MAJOR);
  assert.deepEqual(ack.capabilities, [ROSTER_BRIDGE_REQUIRED_CAPABILITY],
    "the ack states the set in force: the baseline only, never an unimplemented capability");
  const snapshot = await withTimeout(viewer.subscribe(), 5_000, "baseline snapshot");
  assert.equal(snapshot.state, "current");
});

test("a viewer that gives up mid-transfer releases the real owner's watch before resyncing", async (t) => {
  const watches: { unsubscribed: number }[] = [];
  const owner = await startOwner(t, {
    rows: ["a", "b"],
    bounds: { stopAckTimeoutMs: 5_000 },
    source: (service) => ({
      watchInventory: (listener) => {
        const watch = service.watchInventory(listener);
        if (watch === undefined) return undefined;
        const record = { unsubscribed: 0 };
        watches.push(record);
        return Object.freeze({
          snapshot: watch.snapshot,
          unsubscribe: () => {
            record.unsubscribed += 1;
            watch.unsubscribe();
          },
        });
      },
    }),
  });
  // The long acknowledgement window is deliberate: the owner's confirmation, not a
  // race, decides when the retirement settles.
  const { viewer } = await connectViewer(t, owner, "viewer-laptop", {
    snapshotStartTimeoutMs: 250,
    transferIdleTimeoutMs: 250,
    stopAckTimeoutMs: 5_000,
  });
  await viewer.hello;
  const tap = owner.taps[0];
  assert.ok(tap);
  // Nothing the owner says reaches the viewer, so this side has to give up on its
  // own. Its unsubscribe still travels: only the owner's outbound direction is held.
  tap.held = true;
  const first = viewer.subscribe().then(
    () => "published",
    (error: unknown) => (isRosterBridgeViewerError(error) ? `rejected:${error.code}` : "rejected"),
  );
  await until("the viewer gave up on a snapshot it could not see", () => viewer.projection.reason === "transfer-failed");
  await until("the real owner retired the abandoned watch", () => (watches[0]?.unsubscribed ?? 0) === 1);
  assert.equal(watches.length, 1, "one subscription installed exactly one inventory watch");
  assert.equal(owner.roster.activeSubscriptionCount, 0, "no subscription survives on the owner's side");
  assert.equal(viewer.subscriptionId, null, "the viewer no longer claims the abandoned subscription");
  assert.equal(tap.closeCalls, 0, "a retirement the owner confirms never tears down the transport");

  // Releasing the held bytes delivers the abandoned subscription's own frames and
  // then the owner's confirmation. The frames must never publish, and the
  // confirmation is what lets a replacement start.
  tap.release();
  const again = viewer.subscribe();
  const recovered = await withTimeout(again, 5_000, "recovery snapshot after the owner's confirmation");
  assert.equal(recovered.state, "current", "freshness recovers over the real channel");
  assert.equal(recovered.rows.length, 2);
  assert.equal(viewer.projection.rows.length, 2, "the abandoned transfer published nothing of its own");
  assert.equal(watches.length, 2, "the replacement installed exactly one new watch");
  assert.equal(watches[0]?.unsubscribed, 1, "the abandoned watch is never unsubscribed twice");
  assert.equal(await first, "rejected:timeout");
});

test("an owner whose terminal notification cannot be written closes the real channel", async (t) => {
  const owner = await startOwner(t, { rows: ["a", "b", "c"] });
  const { viewer } = await connectViewer(t, owner);
  await viewer.hello;
  const first = await withTimeout(viewer.subscribe(), 5_000, "first snapshot");
  assert.equal(first.state, "current");
  const tap = owner.taps[0];
  assert.ok(tap);

  // The owner stops the session and its only way of saying so is unwritable.
  tap.failNext = true;
  await owner.roster.stopAll();
  await until("the viewer stopped believing it was current", () => viewer.projection.state === "stale");
  assert.equal(tap.closeCalls, 1,
    "an unwritable notification ends the metadata session through the channel's bounded API");
  assert.equal(viewer.projection.reason, "channel-closed");
  assert.equal(viewer.projection.rows.length, 3, "an unwritable notification never becomes an empty roster");
  assert.ok(owner.diagnostics.includes("send_failed"), "the failed write is recorded where it happened");
});
