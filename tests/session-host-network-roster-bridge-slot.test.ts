/**
 * Focused coverage for capability-negotiated owner roster-slot metadata on the
 * roster metadata bridge (#477).
 *
 * Everything here is pure: an in-memory loopback channel pair stands in for the
 * transport and a thin fake inventory source stands in for the owning-host
 * service's read-only watch. No socket, listener, process, filesystem, or
 * product state is touched.
 *
 * The contract being pinned down:
 * - `roster-slot-v1` is one more OPTIONAL capability of the existing
 *   negotiation: it grants nothing, and a peer that does not offer it is never
 *   acknowledged and never sent the field;
 * - an unnegotiated transfer is byte-compatible with the pre-#477 row shape, so
 *   an old strict decoder keeps working;
 * - a negotiated transfer carries the owner's durable slot through packing,
 *   encoding, and decoding unchanged;
 * - the runtime host/run/row tuple that selection, input, and actions route by
 *   is identical either way;
 * - the slot lane coexists with the owner rename lane (#512) on ONE channel and
 *   ONE negotiated capability set, without duplicating either contract.
 */

import assert from "node:assert/strict";
import test from "node:test";

import type { NativeInstanceView } from "../src/session-host/instances";
import type { SessionHostNativeSession } from "../src/session-host/protocol";
import type {
  OwningHostInventorySnapshot,
  OwningHostInventoryWatch,
} from "../src/session-host/owning-host-service";
import type { PeerByteChannel, PeerChannelClose } from "../src/session-host/network/channel";
import type { OwnerRenameHandler, OwnerRenameRequest } from "../src/session-host/network/peer-rename";
import {
  attachRosterBridgeViewer,
  type RosterBridgeViewer,
} from "../src/session-host/network/roster-bridge-client";
import {
  createRosterBridgeHost,
  type RosterBridgeHost,
  type RosterBridgeInventorySource,
} from "../src/session-host/network/roster-bridge-host";
import {
  DEFAULT_ROSTER_BRIDGE_BOUNDS,
  ROSTER_BRIDGE_MAJOR,
  ROSTER_BRIDGE_MINOR,
  ROSTER_BRIDGE_RENAME_CAPABILITY,
  ROSTER_BRIDGE_REQUIRED_CAPABILITY,
  ROSTER_BRIDGE_ROSTER_SLOT_CAPABILITY,
  ROSTER_BRIDGE_SERVICE,
  buildRosterBridgeTransfer,
  decodeRosterBridgeFrame,
  negotiateRosterBridgeHello,
  reviewRosterBridgeHelloAck,
  type RosterBridgeFrame,
  type RosterBridgeHelloFrame,
} from "../src/session-host/network/roster-bridge-protocol";
import { toRemoteSessionMetadata } from "../src/session-host/network/roster-metadata";

const OWNER_RUN = "owner-run-1";

function nativeSession(id: string): SessionHostNativeSession {
  return { sessionId: `conversation-${id}`, epoch: 2, name: `Conversation ${id}` };
}

/**
 * One owner inventory row as the owning-host service projects it: the manager's
 * own runtime row plus, when the host's roster authority holds one, that row's
 * durable slot (#477).
 */
type OwnerRow = NativeInstanceView & { readonly rosterSlotId?: string };

function ownerRow(id: string, rosterSlotId?: string): OwnerRow {
  return {
    id,
    ...(rosterSlotId === undefined ? {} : { rosterSlotId }),
    label: `Row ${id}`,
    workspace: `/srv/owner/work-${id}`,
    agentDir: "/Users/owner/.pi/agent",
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
  };
}

/** One in-memory channel pair with message boundaries preserved. */
class Loopback implements PeerByteChannel {
  readonly peerKey: { keyId: string; fingerprint: string };
  readonly lane = "app";
  readonly label: string;
  readonly sent: Buffer[] = [];
  peer: Loopback | null = null;
  #handlers = new Set<(bytes: Buffer) => void>();
  #closed: Promise<PeerChannelClose>;
  #resolveClosed!: (value: PeerChannelClose) => void;
  #settled = false;

  constructor(name: string, keyId: string) {
    this.label = name;
    this.peerKey = { keyId, fingerprint: `synthetic-${keyId}` };
    this.#closed = new Promise<PeerChannelClose>((resolve) => { this.#resolveClosed = resolve; });
  }

  get closed(): Promise<PeerChannelClose> {
    return this.#closed;
  }

  get bufferedAmount(): number {
    return 0;
  }

  frames(): RosterBridgeFrame[] {
    return this.sent.map((bytes) => decodeRosterBridgeFrame(bytes));
  }

  send(bytes: Uint8Array): Promise<void> {
    if (this.#settled) return Promise.reject(new Error("synthetic channel closed"));
    const copy = Buffer.from(bytes);
    this.sent.push(copy);
    const peer = this.peer;
    if (peer !== null) queueMicrotask(() => peer.deliver(copy));
    return Promise.resolve();
  }

  close(): Promise<void> {
    if (!this.#settled) {
      this.#settled = true;
      this.#resolveClosed({ code: 1000, reason: "synthetic stop" });
    }
    const peer = this.peer;
    if (peer !== null && !peer.#settled) {
      peer.#settled = true;
      peer.#resolveClosed({ code: 1000, reason: "synthetic stop" });
    }
    return Promise.resolve();
  }

  onMessage(handler: (bytes: Buffer) => void): () => void {
    this.#handlers.add(handler);
    return () => { this.#handlers.delete(handler); };
  }

  deliver(bytes: Buffer): void {
    for (const handler of [...this.#handlers]) handler(bytes);
  }
}

/** A fake of the owning-host service's one read-only inventory watch. */
function fixedSource(rows: readonly OwnerRow[]): RosterBridgeInventorySource {
  let revision = 0;
  const capture = (): OwningHostInventorySnapshot => Object.freeze({
    hostRunId: OWNER_RUN,
    revision: (revision += 1),
    rows: Object.freeze(rows.map((row) => Object.freeze({ ...row, activity: Object.freeze([...row.activity]) }))),
  });
  return {
    watchInventory(): OwningHostInventoryWatch | undefined {
      const snapshot = capture();
      return { snapshot, unsubscribe(): void {} };
    },
  };
}

/**
 * The same fake, plus the owner's own re-observation push: the narrow path a
 * host uses when ITS roster authority settled after the manager change that
 * already published the rows (#477).
 */
interface PushSource {
  readonly source: RosterBridgeInventorySource;
  push(rows: readonly OwnerRow[]): void;
}

function pushableSource(initial: readonly OwnerRow[]): PushSource {
  let revision = 0;
  let listener: ((snapshot: OwningHostInventorySnapshot | undefined) => void) | undefined;
  const capture = (rows: readonly OwnerRow[]): OwningHostInventorySnapshot => Object.freeze({
    hostRunId: OWNER_RUN,
    revision: (revision += 1),
    rows: Object.freeze(rows.map((row) => Object.freeze({ ...row, activity: Object.freeze([...row.activity]) }))),
  });
  return {
    source: {
      watchInventory(notify: (snapshot: OwningHostInventorySnapshot | undefined) => void) {
        listener = notify;
        const snapshot = capture(initial);
        return {
          snapshot,
          unsubscribe(): void {
            if (listener !== undefined) listener = undefined;
          },
        };
      },
    },
    push(rows: readonly OwnerRow[]): void {
      listener?.(capture(rows));
    },
  };
}

function slotPairs(rows: readonly { readonly id: string; readonly rosterSlotId?: string }[]): string[] {
  return rows.map((row) => `${row.id}=${row.rosterSlotId ?? "<absent>"}`);
}

interface Harness {
  readonly host: RosterBridgeHost;
  readonly viewer: RosterBridgeViewer;
  readonly ownerSide: Loopback;
  stop(): Promise<void>;
}

function harness(
  source: RosterBridgeInventorySource,
  viewerCapabilities: readonly string[],
  provider: { readonly renameOwnedSession?: OwnerRenameHandler } = {},
): Harness {
  const host = createRosterBridgeHost({
    inventory: source,
    authorizePeer: () => true,
    ...provider,
  });
  const ownerSide = new Loopback("owner", "owner-key");
  const viewerSide = new Loopback("viewer", "viewer-key");
  ownerSide.peer = viewerSide;
  viewerSide.peer = ownerSide;
  host.attach(ownerSide);
  const viewer = attachRosterBridgeViewer({
    channel: viewerSide,
    ...(viewerCapabilities.length === 0 ? {} : { capabilities: viewerCapabilities }),
  });
  return {
    host,
    viewer,
    ownerSide,
    async stop(): Promise<void> {
      await viewer.stop().catch(() => undefined);
      await host.stopAll().catch(() => undefined);
      await ownerSide.close();
    },
  };
}

const negotiated = [ROSTER_BRIDGE_ROSTER_SLOT_CAPABILITY];

test("roster-slot is an optional capability the existing negotiation narrows", () => {
  const hello: RosterBridgeHelloFrame = {
    type: "hello",
    service: ROSTER_BRIDGE_SERVICE,
    major: ROSTER_BRIDGE_MAJOR,
    minor: ROSTER_BRIDGE_MINOR,
    capabilities: [ROSTER_BRIDGE_REQUIRED_CAPABILITY, ROSTER_BRIDGE_ROSTER_SLOT_CAPABILITY],
  };
  const decision = negotiateRosterBridgeHello(hello);
  assert.equal(decision.ok, true);
  assert.deepEqual(decision.ok ? decision.capabilities : null, [ROSTER_BRIDGE_ROSTER_SLOT_CAPABILITY]);

  // An acknowledgement may only confirm what this side offered.
  const ack = reviewRosterBridgeHelloAck(
    {
      type: "hello_ack",
      service: ROSTER_BRIDGE_SERVICE,
      major: ROSTER_BRIDGE_MAJOR,
      minor: ROSTER_BRIDGE_MINOR,
      capabilities: [ROSTER_BRIDGE_REQUIRED_CAPABILITY, ROSTER_BRIDGE_ROSTER_SLOT_CAPABILITY],
    },
    { capabilities: [ROSTER_BRIDGE_REQUIRED_CAPABILITY] },
  );
  assert.equal(ack.ok, false, "a slot capability this viewer never offered is a protocol violation");

  // A near-miss identifier is unknown and grants nothing.
  const unknown = negotiateRosterBridgeHello({
    ...hello,
    capabilities: [ROSTER_BRIDGE_REQUIRED_CAPABILITY, "roster-slot-v2", "roster-slots-v1"],
  });
  assert.equal(unknown.ok, true);
  assert.deepEqual(unknown.ok ? unknown.capabilities : null, []);
});

test("a negotiated channel carries the owner's durable slot and keeps the runtime tuple", async () => {
  const rows = [ownerRow("row-1", "slot-a"), ownerRow("row-2", "slot-b")];
  const h = harness(fixedSource(rows), negotiated);
  try {
    await h.viewer.hello;
    assert.deepEqual(h.viewer.capabilities, [ROSTER_BRIDGE_REQUIRED_CAPABILITY, ROSTER_BRIDGE_ROSTER_SLOT_CAPABILITY]);
    const projection = await h.viewer.subscribe();
    assert.equal(projection.hostRunId, OWNER_RUN);
    assert.deepEqual(projection.rows.map((row) => row.id), ["row-1", "row-2"],
      "the runtime row ids are untouched by the metadata");
    assert.deepEqual(projection.rows.map((row) => row.rosterSlotId), ["slot-a", "slot-b"]);
    assert.deepEqual(projection.rows.map((row) => row.workspace), ["/srv/owner/work-row-1", "/srv/owner/work-row-2"]);
  } finally {
    await h.stop();
  }
});

test("an unnegotiated channel receives the pre-#477 row shape byte for byte", async () => {
  const rows = [ownerRow("row-1", "slot-a"), ownerRow("row-2", "slot-b")];
  const h = harness(fixedSource(rows), []);
  try {
    await h.viewer.hello;
    assert.deepEqual(h.viewer.capabilities, [ROSTER_BRIDGE_REQUIRED_CAPABILITY],
      "no slot capability, no slot metadata");
    const projection = await h.viewer.subscribe();
    assert.deepEqual(projection.rows.map((row) => row.id), ["row-1", "row-2"]);
    for (const row of projection.rows) {
      assert.equal(Object.prototype.hasOwnProperty.call(row, "rosterSlotId"), false,
        "a strict old decoder never sees an unknown key");
      assert.equal(row.rosterSlotId, undefined);
    }
    // Byte-level proof: the owner never wrote the field into any frame.
    const pages = h.ownerSide.frames().filter((frame) => frame.type === "snapshot_page");
    assert.ok(pages.length >= 1);
    for (const frame of pages) {
      assert.equal(JSON.stringify(frame).includes("rosterSlotId"), false);
    }
    // And each row equals what the same owner row projects without the capability.
    assert.deepEqual(
      projection.rows.map((row) => JSON.stringify(row)),
      rows.map((row) => JSON.stringify(toRemoteSessionMetadata(row))),
    );
  } finally {
    await h.stop();
  }
});

test("a peer that offers an unknown slot identifier is never treated as negotiated", async () => {
  const rows = [ownerRow("row-1", "slot-a")];
  const h = harness(fixedSource(rows), ["roster-slot-v2"]);
  try {
    await h.viewer.hello;
    assert.deepEqual(h.viewer.capabilities, [ROSTER_BRIDGE_REQUIRED_CAPABILITY]);
    const projection = await h.viewer.subscribe();
    assert.equal(Object.prototype.hasOwnProperty.call(projection.rows[0] ?? {}, "rosterSlotId"), false);
  } finally {
    await h.stop();
  }
});

test("a row whose owner has no slot stays absent on a negotiated channel", async () => {
  const rows = [ownerRow("row-1", "slot-a"), ownerRow("row-2")];
  const h = harness(fixedSource(rows), negotiated);
  try {
    await h.viewer.hello;
    const projection = await h.viewer.subscribe();
    assert.equal(projection.rows[0]?.rosterSlotId, "slot-a");
    assert.equal(Object.prototype.hasOwnProperty.call(projection.rows[1] ?? {}, "rosterSlotId"), false,
      "an owner with no slot for a row reports absence, not a placeholder");
  } finally {
    await h.stop();
  }
});

test("a replacement's corrected slot reaches the viewer as a newer snapshot on one subscription", async () => {
  // Exactly the replacement moment: the manager change published the appended
  // replacement while the host's authority still carried its temporary slot.
  const temporary = [ownerRow("other", "other"), ownerRow("row-1", "row-1")];
  const transferred = [ownerRow("other", "other"), ownerRow("row-1", "old")];
  const pushed = pushableSource(temporary);
  const h = harness(pushed.source, negotiated);
  const current: Array<{ readonly revision: number | null; readonly rows: readonly string[] }> = [];
  let settleSecond!: () => void;
  const second = new Promise<void>((resolve) => { settleSecond = resolve; });
  try {
    await h.viewer.hello;
    const off = h.viewer.onProjection((projection) => {
      if (projection.state !== "current") return;
      current.push({ revision: projection.revision, rows: slotPairs(projection.rows) });
      if (current.length >= 2) settleSecond();
    });
    const first = await h.viewer.subscribe();
    assert.deepEqual(slotPairs(first.rows), ["other=other", "row-1=row-1"],
      "the first snapshot carries the temporary slot the manager change published");
    const firstRevision = first.revision;

    pushed.push(transferred);
    const timer = setTimeout(() => settleSecond(), 2_000);
    try {
      await second;
    } finally {
      clearTimeout(timer);
    }
    off();
    const latest = current[current.length - 1];
    assert.ok(latest);
    assert.deepEqual(latest.rows, ["other=other", "row-1=old"],
      "the host's re-observation publishes the transferred durable slot");
    assert.ok((latest.revision ?? 0) > (firstRevision ?? 0), "one subscription, a strictly newer revision");
  } finally {
    await h.stop();
  }
});

test("packing, encoding, and decoding preserve one durable slot", () => {
  const rows = [ownerRow("row-1", "slot-a"), ownerRow("row-2", "slot-b")]
    .map((row) => toRemoteSessionMetadata(row, { rosterSlotId: true }));
  const built = buildRosterBridgeTransfer({
    subscriptionId: "sub-1",
    transferId: "transfer-1",
    hostRunId: OWNER_RUN,
    revision: 7,
    rows,
    bounds: DEFAULT_ROSTER_BRIDGE_BOUNDS,
  });
  const pages = built.frames
    .map((bytes) => decodeRosterBridgeFrame(bytes))
    .filter((frame) => frame.type === "snapshot_page");
  assert.equal(pages.length, 1);
  const decoded = pages[0]?.type === "snapshot_page" ? pages[0].rows : [];
  assert.deepEqual(decoded.map((row) => [row.id, row.rosterSlotId]), [["row-1", "slot-a"], ["row-2", "slot-b"]]);
});

test("the slot lane and the owner rename lane negotiate on one channel without duplicating either", async () => {
  const requests: OwnerRenameRequest[] = [];
  const rows = [ownerRow("row-1", "slot-a"), ownerRow("row-2")];
  const h = harness(
    fixedSource(rows),
    [ROSTER_BRIDGE_ROSTER_SLOT_CAPABILITY, ROSTER_BRIDGE_RENAME_CAPABILITY],
    {
      renameOwnedSession: async (request) => {
        requests.push(request);
        return { kind: "renamed" };
      },
    },
  );
  try {
    await h.viewer.hello;
    // ONE negotiated capability set on the existing lane, each optional lane
    // named once: no second catalogue, no mirror of the rename or slot state.
    assert.deepEqual(h.viewer.capabilities, [
      ROSTER_BRIDGE_REQUIRED_CAPABILITY,
      ROSTER_BRIDGE_ROSTER_SLOT_CAPABILITY,
      ROSTER_BRIDGE_RENAME_CAPABILITY,
    ]);
    assert.equal(h.viewer.supportsRename, true, "the rename lane negotiated on the same channel");
    const projection = await h.viewer.subscribe();
    assert.deepEqual(slotPairs(projection.rows), ["row-1=slot-a", "row-2=<absent>"],
      "the slot metadata rides the same snapshot the rename lane is bound to");
    assert.deepEqual(await h.viewer.renameSession({
      hostRunId: OWNER_RUN,
      rowId: "row-1",
      expectedSessionId: "conversation-row-1",
      expectedSessionEpoch: 2,
      name: "Renamed row one",
    }), { kind: "owner-result", facts: { kind: "renamed" } });
    assert.deepEqual(requests, [{
      hostRunId: OWNER_RUN,
      rowId: "row-1",
      expectedSessionId: "conversation-row-1",
      expectedSessionEpoch: 2,
      name: "Renamed row one",
    }], "rename still names the exact run, row, and observed native tuple");
    // Neither lane changed the other's data: the runtime tuple and the durable
    // slot placement the owner published are exactly what they were before the
    // rename, and no rename reply wrote a name or a slot locally.
    assert.deepEqual(slotPairs(h.viewer.projection.rows), ["row-1=slot-a", "row-2=<absent>"]);
    assert.deepEqual(h.viewer.projection.rows.map((row) => row.id), ["row-1", "row-2"]);
    const frameTypes = h.ownerSide.frames().map((frame) => frame.type);
    assert.ok(frameTypes.includes("snapshot_begin") && frameTypes.includes("rename_result"),
      "one channel carried the slot-bearing snapshot and the rename result");
  } finally {
    await h.stop();
  }
});
