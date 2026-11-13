/**
 * Focused coverage for the capability-gated owner NATIVE lane on the roster
 * metadata bridge: the advertised target catalog, the typed backend row identity,
 * and the rowless native create exchange.
 *
 * Everything here is pure: an in-memory loopback channel pair stands in for the
 * transport, a thin fake inventory source stands in for the owning-host service's
 * read-only watch, and the owner's native provider and target catalog are scripted
 * stand-ins for Main's injected pair. No socket, listener, process, filesystem,
 * provider CLI, or product state is touched.
 *
 * The contract being pinned down:
 * - `roster-native-v1` is one more OPTIONAL capability of the existing negotiation;
 *   it grants nothing, the owner acknowledges it only when it really holds BOTH a
 *   native create provider AND an explicit target catalog, and a peer that does not
 *   offer it is never acknowledged and never sent a new key or frame;
 * - an unnegotiated snapshot and row stay byte-compatible with the pre-native shape;
 * - a negotiated snapshot commits the catalog with its rows, and rows carry only the
 *   closed backend identity the owner itself reports;
 * - the catalog's ceiling is the transport's complete-frame byte bound, never the
 *   lane's per-page ROW bound: an owner with more targets than a page of rows is
 *   carried whole and stays usable, while a catalog that cannot fit one frame
 *   refuses the whole snapshot on both the encode and the decode side;
 * - a native create reaches the injected provider exactly once with the exact owner
 *   run, verbatim workspace, backend, and owner-advertised target id, plus the
 *   owner's final re-proof, and answers with the same closed fact set on the native
 *   result frame;
 * - an unknown or cross-backend target, a withdrawn catalog, a replayed or
 *   out-of-order attempt, or a second create while one is in flight refuse without
 *   ever reaching a provider, on either lane, with no fallback to a default target,
 *   the other backend, or a Pi create;
 * - a reply this side never learns is `unknown`, never "not sent".
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
import type {
  OwnerCreateFacts,
  OwnerNativeCreateHandler,
  OwnerNativeCreateRequest,
  RemoteNativeCliTarget,
} from "../src/session-host/network/peer-create";
import type {
  OwnerNativeRenameFacts,
  OwnerNativeRenameHandler,
  OwnerNativeRenameRequest,
} from "../src/session-host/network/peer-rename";
import {
  isRemoteNativeCliTarget,
  findRemoteNativeCliTarget,
  copyRemoteNativeCliTargets,
} from "../src/session-host/network/peer-create";
import {
  attachRosterBridgeViewer,
  type RosterBridgeViewer,
} from "../src/session-host/network/roster-bridge-client";
import {
  createRosterBridgeHost,
  type RosterBridgeHost,
  type RosterBridgeHostOptions,
  type RosterBridgeInventorySource,
} from "../src/session-host/network/roster-bridge-host";
import {
  DEFAULT_ROSTER_BRIDGE_BOUNDS,
  ROSTER_BRIDGE_CLOSE_CAPABILITY,
  ROSTER_BRIDGE_CREATE_CAPABILITY,
  ROSTER_BRIDGE_KNOWN_OPTIONAL_CAPABILITIES,
  ROSTER_BRIDGE_MAJOR,
  ROSTER_BRIDGE_MINOR,
  ROSTER_BRIDGE_NATIVE_CAPABILITY,
  ROSTER_BRIDGE_NATIVE_NAME_CAPABILITY,
  ROSTER_BRIDGE_RENAME_CAPABILITY,
  ROSTER_BRIDGE_REQUIRED_CAPABILITY,
  ROSTER_BRIDGE_ROSTER_SLOT_CAPABILITY,
  ROSTER_BRIDGE_SAVED_CAPABILITY,
  ROSTER_BRIDGE_SERVICE,
  buildRosterBridgeTransfer,
  decodeRosterBridgeFrame,
  encodeRosterBridgeFrame,
  isRosterBridgeProtocolError,
  negotiateRosterBridgeHello,
  readRosterBridgeNativeCliTargets,
  resolveRosterBridgeBounds,
  reviewRosterBridgeHelloAck,
  rosterBridgeNativeCatalogMaxEntries,
  type RosterBridgeBounds,
  type RosterBridgeFrame,
  type RosterBridgeProtocolError,
  type RosterBridgeHelloFrame,
} from "../src/session-host/network/roster-bridge-protocol";
import {
  parseRemoteSessionMetadata,
  toRemoteSessionMetadata,
} from "../src/session-host/network/roster-metadata";

const OWNER_RUN = "owner-run-1";

const CLAUDE_TARGET: RemoteNativeCliTarget = Object.freeze({ id: "claude", backend: "claude", label: "Claude Code (default)" });
const CODEX_TARGET: RemoteNativeCliTarget = Object.freeze({ id: "codex", backend: "codex", label: "Codex CLI (default)" });
const SHARED_TARGET: RemoteNativeCliTarget = Object.freeze({ id: "external:workhorse", backend: "claude", label: "workhorse (Claude)" });

/** N distinct owner-advertised targets, in one stable order. */
function manyTargets(count: number): RemoteNativeCliTarget[] {
  return Array.from({ length: count }, (_unused, index): RemoteNativeCliTarget => ({
    id: `target-${index}`,
    backend: index % 2 === 0 ? "claude" : "codex",
    label: `Target ${index}`,
  }));
}

/** Assert one boundary refuses with exactly this fixed local failure code. */
function expectFailureCode(action: () => unknown, code: RosterBridgeProtocolError["code"]): void {
  try {
    action();
  } catch (error) {
    assert.ok(isRosterBridgeProtocolError(error), `expected a protocol failure, got ${String(error)}`);
    assert.equal(error.code, code);
    return;
  }
  assert.fail("expected the boundary to refuse");
}

function nativeSession(id: string): SessionHostNativeSession {
  return { sessionId: `conversation-${id}`, epoch: 2, name: `Conversation ${id}` };
}

/** One owner inventory row, optionally typed by the owner's own backend field. */
function ownerRow(id: string, backend?: NativeInstanceView["backend"]): NativeInstanceView {
  return {
    id,
    ...(backend === undefined ? {} : { backend }),
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
  /**
   * Every write this side was ASKED to make, including one that arrived while the
   * side was already closing. A peer that fails closed may report the violation and
   * close in the same breath, so "what did it try to say" is a separate observation
   * from "what did the transport accept".
   */
  readonly attempted: Buffer[] = [];
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

  attemptedFrames(): RosterBridgeFrame[] {
    return this.attempted.map((bytes) => decodeRosterBridgeFrame(bytes));
  }

  /** Raw text of every frame this side wrote, for byte-level absence proofs. */
  raw(): string[] {
    return this.sent.map((bytes) => bytes.toString("utf8"));
  }

  send(bytes: Uint8Array): Promise<void> {
    this.attempted.push(Buffer.from(bytes));
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
function fixedSource(rows: readonly NativeInstanceView[]): RosterBridgeInventorySource {
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

/** The same fake plus a push, so one owner run can be replaced by another. */
interface PushSource {
  readonly source: RosterBridgeInventorySource;
  push(rows: readonly NativeInstanceView[], hostRunId?: string): void;
}

function pushableSource(initial: readonly NativeInstanceView[]): PushSource {
  let revision = 0;
  let run = OWNER_RUN;
  let listener: ((snapshot: OwningHostInventorySnapshot | undefined) => void) | undefined;
  const capture = (rows: readonly NativeInstanceView[]): OwningHostInventorySnapshot => Object.freeze({
    hostRunId: run,
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
    push(rows: readonly NativeInstanceView[], hostRunId?: string): void {
      if (hostRunId !== undefined) run = hostRunId;
      listener?.(capture(rows));
    },
  };
}

interface Harness {
  readonly host: RosterBridgeHost;
  readonly viewer: RosterBridgeViewer;
  readonly ownerSide: Loopback;
  readonly viewerSide: Loopback;
  stop(): Promise<void>;
}

function harness(options: {
  readonly inventory: RosterBridgeInventorySource;
  readonly viewerCapabilities?: readonly string[];
  readonly owner?: Partial<RosterBridgeHostOptions>;
  readonly bounds?: Partial<RosterBridgeBounds>;
}): Harness {
  const host = createRosterBridgeHost({
    inventory: options.inventory,
    authorizePeer: () => true,
    ...(options.bounds === undefined ? {} : { bounds: options.bounds }),
    ...(options.owner ?? {}),
  });
  const ownerSide = new Loopback("owner", "owner-key");
  const viewerSide = new Loopback("viewer", "viewer-key");
  ownerSide.peer = viewerSide;
  viewerSide.peer = ownerSide;
  host.attach(ownerSide);
  const viewer = attachRosterBridgeViewer({
    channel: viewerSide,
    ...(options.viewerCapabilities === undefined || options.viewerCapabilities.length === 0
      ? {}
      : { capabilities: options.viewerCapabilities }),
  });
  return {
    host,
    viewer,
    ownerSide,
    viewerSide,
    async stop(): Promise<void> {
      await viewer.stop().catch(() => undefined);
      await host.stopAll().catch(() => undefined);
      await ownerSide.close();
    },
  };
}

const NATIVE_OFFER = [ROSTER_BRIDGE_NATIVE_CAPABILITY];

/** The owner's injected pair, with the provider's calls recorded. */
function nativeOwner(options: {
  readonly targets?: () => readonly RemoteNativeCliTarget[];
  readonly create?: OwnerNativeCreateHandler;
  readonly createOwnedSession?: RosterBridgeHostOptions["createOwnedSession"];
} = {}): { readonly owner: Partial<RosterBridgeHostOptions>; readonly nativeCalls: OwnerNativeCreateRequest[]; readonly piCalls: unknown[] } {
  const nativeCalls: OwnerNativeCreateRequest[] = [];
  const piCalls: unknown[] = [];
  const owner: Partial<RosterBridgeHostOptions> = {
    nativeCliTargets: options.targets ?? (() => [CLAUDE_TARGET, CODEX_TARGET, SHARED_TARGET]),
    nativeCreateOwnedSession: options.create ?? (async (request, stillAuthorized) => {
      nativeCalls.push(request);
      assert.equal(stillAuthorized(), true, "the native provider is handed the owner's live re-proof");
      return { kind: "started", hostRunId: request.hostRunId, rowId: `native-${request.targetId}` };
    }),
    createOwnedSession: options.createOwnedSession ?? (async (request) => {
      piCalls.push(request);
      return { kind: "started", hostRunId: request.hostRunId, rowId: "pi-1" };
    }),
  };
  return { owner, nativeCalls, piCalls };
}

// --------------------------------------------------------------- capability

test("roster-native-v1 is one more optional lane of the same negotiation", () => {
  assert.equal(ROSTER_BRIDGE_NATIVE_CAPABILITY, "roster-native-v1");
  assert.ok(ROSTER_BRIDGE_KNOWN_OPTIONAL_CAPABILITIES.includes(ROSTER_BRIDGE_NATIVE_CAPABILITY));
  // Still exactly the known optional lanes, each declared once, baseline excluded.
  assert.deepEqual(
    [...ROSTER_BRIDGE_KNOWN_OPTIONAL_CAPABILITIES].sort(),
    [
      ROSTER_BRIDGE_CLOSE_CAPABILITY,
      ROSTER_BRIDGE_CREATE_CAPABILITY,
      ROSTER_BRIDGE_NATIVE_CAPABILITY,
      ROSTER_BRIDGE_NATIVE_NAME_CAPABILITY,
      ROSTER_BRIDGE_RENAME_CAPABILITY,
      ROSTER_BRIDGE_ROSTER_SLOT_CAPABILITY,
      ROSTER_BRIDGE_SAVED_CAPABILITY,
    ].sort(),
  );
  assert.ok(!ROSTER_BRIDGE_KNOWN_OPTIONAL_CAPABILITIES.includes(ROSTER_BRIDGE_REQUIRED_CAPABILITY));
  const hello: RosterBridgeHelloFrame = {
    type: "hello",
    service: ROSTER_BRIDGE_SERVICE,
    major: ROSTER_BRIDGE_MAJOR,
    minor: ROSTER_BRIDGE_MINOR,
    capabilities: [ROSTER_BRIDGE_REQUIRED_CAPABILITY, ROSTER_BRIDGE_NATIVE_CAPABILITY],
  };
  const decision = negotiateRosterBridgeHello(hello);
  assert.equal(decision.ok, true);
  assert.deepEqual(decision.ok ? decision.capabilities : null, [ROSTER_BRIDGE_NATIVE_CAPABILITY]);
  // A near-miss identifier is unknown and grants nothing.
  const near = negotiateRosterBridgeHello({
    ...hello,
    capabilities: [ROSTER_BRIDGE_REQUIRED_CAPABILITY, "roster-native-v2", "roster-natives-v1", "native-v1"],
  });
  assert.equal(near.ok, true);
  assert.deepEqual(near.ok ? near.capabilities : null, []);
  // An acknowledgement may only confirm what this side offered.
  const ack = reviewRosterBridgeHelloAck(
    {
      type: "hello_ack",
      service: ROSTER_BRIDGE_SERVICE,
      major: ROSTER_BRIDGE_MAJOR,
      minor: ROSTER_BRIDGE_MINOR,
      capabilities: [ROSTER_BRIDGE_REQUIRED_CAPABILITY, ROSTER_BRIDGE_NATIVE_CAPABILITY],
    },
    { capabilities: [ROSTER_BRIDGE_REQUIRED_CAPABILITY] },
  );
  assert.equal(ack.ok, false, "a native capability this viewer never offered is a protocol violation");
});

test("a half native pair is refused at construction, never defaulted", () => {
  const inventory = fixedSource([]);
  assert.throws(
    () => createRosterBridgeHost({
      inventory,
      authorizePeer: () => true,
      nativeCreateOwnedSession: async () => ({ kind: "refused" }),
    }),
    (error: unknown) => error instanceof TypeError,
  );
  assert.throws(
    () => createRosterBridgeHost({
      inventory,
      authorizePeer: () => true,
      nativeCliTargets: () => [CLAUDE_TARGET],
    }),
    (error: unknown) => error instanceof TypeError,
  );
});

test("an owner without the native pair never acknowledges it, and sees no native keys", async () => {
  const h = harness({ inventory: fixedSource([ownerRow("row-1", "claude")]), viewerCapabilities: NATIVE_OFFER });
  try {
    await h.viewer.hello;
    assert.deepEqual(h.viewer.capabilities, [ROSTER_BRIDGE_REQUIRED_CAPABILITY]);
    assert.equal(h.viewer.supportsNative, false);
    const projection = await h.viewer.subscribe();
    assert.equal(projection.nativeCliTargets, null);
    assert.equal(projection.rows[0]?.backend, undefined, "an unnegotiated owner never types a row");
    // Byte-level proof: no native key reached the peer in any frame.
    for (const text of h.ownerSide.raw()) {
      assert.equal(text.includes("nativeCliTargets"), false);
      assert.equal(text.includes("backend"), false);
    }
    assert.deepEqual(await h.viewer.createNativeSession({
      hostRunId: OWNER_RUN,
      workspace: "/srv/owner/work-row-1",
      backend: "claude",
      targetId: "claude",
    }), { kind: "not-sent", reason: "capability-unsupported" });
  } finally {
    await h.stop();
  }
});

// ------------------------------------------------------- catalog and typing

test("a negotiated snapshot commits the owner catalog and the typed backend rows", async () => {
  const rows = [ownerRow("pi-row"), ownerRow("claude-row", "claude"), ownerRow("codex-row", "codex")];
  const h = harness({
    inventory: fixedSource(rows),
    viewerCapabilities: NATIVE_OFFER,
    ...{ owner: nativeOwner().owner },
  });
  try {
    await h.viewer.hello;
    assert.deepEqual(h.viewer.capabilities, [ROSTER_BRIDGE_REQUIRED_CAPABILITY, ROSTER_BRIDGE_NATIVE_CAPABILITY]);
    assert.equal(h.viewer.supportsNative, true);
    const projection = await h.viewer.subscribe();
    assert.equal(projection.hostRunId, OWNER_RUN);
    assert.deepEqual(projection.rows.map((row) => [row.id, row.backend ?? "<absent>"]), [
      ["pi-row", "<absent>"],
      ["claude-row", "claude"],
      ["codex-row", "codex"],
    ], "only what the owner row reports is carried; absence stays the legacy Pi row");
    assert.deepEqual(projection.nativeCliTargets, [CLAUDE_TARGET, CODEX_TARGET, SHARED_TARGET]);
    // The catalog committed on the same frame as the rows it belongs to.
    const end = h.ownerSide.frames().find((frame) => frame.type === "snapshot_end");
    assert.ok(end && end.type === "snapshot_end" && end.nativeCliTargets !== undefined);
    assert.equal(end.totalRows, 3);
    // No descriptor carries anything beyond id/backend/label.
    for (const target of projection.nativeCliTargets ?? []) {
      assert.deepEqual(Object.keys(target).sort(), ["backend", "id", "label"]);
      assert.equal(isRemoteNativeCliTarget(target), true);
    }
  } finally {
    await h.stop();
  }
});

test("an unnegotiated channel receives the pre-native snapshot byte for byte", async () => {
  const rows = [ownerRow("row-1", "claude"), ownerRow("row-2", "codex")];
  const h = harness({ inventory: fixedSource(rows), viewerCapabilities: [] });
  try {
    await h.viewer.hello;
    assert.deepEqual(h.viewer.capabilities, [ROSTER_BRIDGE_REQUIRED_CAPABILITY]);
    const projection = await h.viewer.subscribe();
    for (const row of projection.rows) {
      assert.equal(Object.prototype.hasOwnProperty.call(row, "backend"), false,
        "a strict old decoder never sees an unknown key");
    }
    assert.deepEqual(
      projection.rows.map((row) => JSON.stringify(row)),
      rows.map((row) => JSON.stringify(toRemoteSessionMetadata(row))),
      "the unnegotiated row equals the same owner row projected without any option",
    );
    const end = h.ownerSide.frames().find((frame) => frame.type === "snapshot_end");
    assert.ok(end && end.type === "snapshot_end");
    assert.equal(Object.prototype.hasOwnProperty.call(end, "nativeCliTargets"), false);
    assert.equal(JSON.stringify(end).includes("nativeCliTargets"), false);
  } finally {
    await h.stop();
  }
});

test("a negotiated owner with an empty catalog publishes an honest empty choice list", async () => {
  const h = harness({
    inventory: fixedSource([ownerRow("row-1", "claude")]),
    viewerCapabilities: NATIVE_OFFER,
    owner: { ...nativeOwner().owner, nativeCliTargets: () => [] },
  });
  try {
    await h.viewer.hello;
    const projection = await h.viewer.subscribe();
    assert.deepEqual(projection.nativeCliTargets, []);
    // An empty catalog is a real fact, and it authorizes nothing.
    assert.deepEqual(await h.viewer.createNativeSession({
      hostRunId: OWNER_RUN,
      workspace: "/srv/owner/work-row-1",
      backend: "claude",
      targetId: "claude",
    }), { kind: "not-sent", reason: "invalid-request" });
  } finally {
    await h.stop();
  }
});

test("a native catalog that cannot fit one frame refuses the snapshot whole instead of clipping it", async () => {
  // The catalog's ceiling is the transport's complete-frame bound and nothing
  // else. These bounds leave room for this roster's one-row page but not for a
  // `snapshot_end` frame that carries this catalog.
  const bounds = { maxFrameBytes: 1024, maxPageBytes: 1024, maxSnapshotBytes: 1024 };
  // Case (a) is over the frame bound by itself; case (b) fits a frame as a bare
  // catalog but not once the end frame that carries it is encoded, so the
  // authoritative byte check is still the encoded frame.
  const cases = [
    ["over the frame bound on its own", manyTargets(20), "snapshot_too_large"],
    ["only over it once the end frame is encoded", manyTargets(17), "bad_frame"],
  ] as const;
  for (const [label, targets, code] of cases) {
    const h = harness({
      inventory: fixedSource([ownerRow("row-1")]),
      viewerCapabilities: NATIVE_OFFER,
      bounds,
      owner: { ...nativeOwner().owner, nativeCliTargets: () => targets },
    });
    try {
      await h.viewer.hello;
      // The owner refuses the transfer rather than publishing a shortened list, an
      // empty one, or rows with no catalog at all.
      await assert.rejects(() => h.viewer.subscribe(), label);
      assert.equal(h.viewer.projection.state !== "current", true, label);
      assert.equal(h.viewer.projection.nativeCliTargets, null, label);
      // Never a partial offer: not one frame of that snapshot reached the peer.
      assert.deepEqual(
        h.ownerSide.frames().filter((frame) => frame.type.startsWith("snapshot_")),
        [],
        `${label}: no partial snapshot is sent`,
      );
      const error = h.ownerSide.frames().find((frame) => frame.type === "error");
      assert.ok(error !== undefined && error.type === "error", `${label}: the owner states one fixed wire code`);
      assert.equal(error.type === "error" ? error.code : null, code, `${label}: the honest refusal code`);
    } finally {
      await h.stop();
    }
  }
});

test("a native catalog bigger than one page of rows is published whole and stays usable", async () => {
  // More advertised targets than the lane's row page bound, and comfortably
  // inside the frame bound: a page of ROWS says nothing about an owner's
  // configuration, so this catalog must be carried, not refused or clipped.
  const targets = manyTargets(DEFAULT_ROSTER_BRIDGE_BOUNDS.maxRowsPerPage + 8);
  assert.ok(targets.length > DEFAULT_ROSTER_BRIDGE_BOUNDS.maxRowsPerPage);
  const native = nativeOwner();
  const h = harness({
    inventory: fixedSource([ownerRow("row-1", "claude")]),
    viewerCapabilities: NATIVE_OFFER,
    owner: { ...native.owner, nativeCliTargets: () => targets },
  });
  try {
    await h.viewer.hello;
    const projection = await h.viewer.subscribe();
    assert.deepEqual(projection.nativeCliTargets, targets, "every advertised target survives the negotiated snapshot");
    // The owner published the whole catalog on the frame that commits the rows.
    const end = h.ownerSide.frames().find((frame) => frame.type === "snapshot_end");
    assert.ok(end !== undefined && end.type === "snapshot_end");
    assert.deepEqual(end.nativeCliTargets, targets);
    // A target far beyond one page of rows is a real, resolvable choice ...
    const last = targets[targets.length - 1]!;
    assert.deepEqual(findRemoteNativeCliTarget(projection.nativeCliTargets, last.backend, last.id), last);
    // ... and one deliberate create of it reaches the owner's provider exactly once.
    assert.deepEqual(await h.viewer.createNativeSession({
      hostRunId: OWNER_RUN,
      workspace: "/srv/owner/new child",
      backend: last.backend,
      targetId: last.id,
    }), { kind: "owner-result", facts: { kind: "started", hostRunId: OWNER_RUN, rowId: `native-${last.id}` } });
    assert.equal(native.nativeCalls.length, 1);
    assert.deepEqual(native.nativeCalls[0], {
      hostRunId: OWNER_RUN,
      workspace: "/srv/owner/new child",
      backend: last.backend,
      targetId: last.id,
    });
  } finally {
    await h.stop();
  }
});

test("shrinking the row page bound never changes native catalog acceptance", async () => {
  const rows = [ownerRow("row-1", "claude"), ownerRow("row-2", "codex"), ownerRow("row-3")];
  const targets = manyTargets(DEFAULT_ROSTER_BRIDGE_BOUNDS.maxRowsPerPage + 8);
  const wide = harness({
    inventory: fixedSource(rows),
    viewerCapabilities: NATIVE_OFFER,
    owner: { ...nativeOwner().owner, nativeCliTargets: () => targets },
  });
  const narrow = harness({
    inventory: fixedSource(rows),
    viewerCapabilities: NATIVE_OFFER,
    bounds: { maxRowsPerPage: 1 },
    owner: { ...nativeOwner().owner, nativeCliTargets: () => targets },
  });
  try {
    await wide.viewer.hello;
    await narrow.viewer.hello;
    const wideProjection = await wide.viewer.subscribe();
    const narrowProjection = await narrow.viewer.subscribe();
    assert.equal(narrowProjection.rows.length, rows.length, "the rows still arrive, one per page");
    assert.equal(
      narrow.ownerSide.frames().filter((frame) => frame.type === "snapshot_page").length,
      rows.length,
      "one row per page really is in effect",
    );
    assert.deepEqual(narrowProjection.nativeCliTargets, targets);
    assert.deepEqual(wideProjection.nativeCliTargets, narrowProjection.nativeCliTargets,
      "the same owner catalog is accepted whole at either page size");
  } finally {
    await wide.stop();
    await narrow.stop();
  }
});

test("a catalog this owner cannot read refuses the snapshot instead of offering nothing", async () => {
  const h = harness({
    inventory: fixedSource([ownerRow("row-1")]),
    viewerCapabilities: NATIVE_OFFER,
    owner: {
      ...nativeOwner().owner,
      nativeCliTargets: () => {
        throw new Error("synthetic owner catalog unavailable");
      },
    },
  });
  try {
    await h.viewer.hello;
    await assert.rejects(() => h.viewer.subscribe());
    assert.equal(h.viewer.projection.nativeCliTargets, null);
  } finally {
    await h.stop();
  }
});

test("a malformed or private-field-bearing descriptor is refused, never passed through", () => {
  const hostile = [
    { id: "claude", backend: "claude", label: "Claude", command: "/usr/bin/claude" },
    { id: "claude", backend: "claude" },
    { id: "", backend: "claude", label: "empty id" },
    { id: "x", backend: "pi", label: "pi is not a native target backend" },
    { id: "x", backend: "mystery", label: "unknown backend" },
    { id: "bad\nid", backend: "claude", label: "control character" },
    { id: "x", backend: "claude", label: "" },
    { id: "x", backend: "claude", label: "line\nbreak" },
  ];
  for (const entry of hostile) {
    assert.equal(isRemoteNativeCliTarget(entry), false, `${JSON.stringify(entry)} is not a descriptor`);
    assert.equal(copyRemoteNativeCliTargets([entry], 8), null, "a bad entry refuses the whole catalog");
  }
  // A duplicate id would silently collapse two choices into one apparent one.
  assert.equal(copyRemoteNativeCliTargets([CLAUDE_TARGET, { ...CLAUDE_TARGET, label: "other" }], 8), null);
  // Over the ceiling is a refusal, not a truncation.
  assert.equal(copyRemoteNativeCliTargets([CLAUDE_TARGET, CODEX_TARGET], 1), null);
  // The exact pair is the only match: no backend-only or id-only fallback exists.
  const catalog = copyRemoteNativeCliTargets([CLAUDE_TARGET, SHARED_TARGET], 8);
  assert.deepEqual(findRemoteNativeCliTarget(catalog, "claude", "claude"), CLAUDE_TARGET);
  assert.equal(findRemoteNativeCliTarget(catalog, "codex", "claude"), null);
  assert.equal(findRemoteNativeCliTarget(catalog, "claude", "codex"), null);
  assert.equal(findRemoteNativeCliTarget(catalog, "claude", "external:missing"), null);
  assert.equal(findRemoteNativeCliTarget(null, "claude", "claude"), null);
});

test("an unknown backend on a wire row is malformed, never re-typed or inferred", () => {
  const base = toRemoteSessionMetadata(ownerRow("row-1", "claude"), { backend: true });
  assert.equal(base.backend, "claude");
  assert.deepEqual(parseRemoteSessionMetadata(base)?.backend, "claude", "a typed row round-trips");
  for (const backend of [null, "Pi", "PI", "mystery", "", 7, { kind: "claude" }]) {
    const row = { ...base, backend };
    assert.equal(parseRemoteSessionMetadata(row), null, `${JSON.stringify(backend)} is never a backend`);
  }
  // Only ABSENCE preserves the legacy Pi row. A null is a present value outside the
  // closed set, not a spelling of "none": dropping it here would launder an
  // unnegotiated extension out of the row before the viewer can notice it.
  for (const absent of [undefined]) {
    const row = { ...base, backend: absent };
    assert.equal(parseRemoteSessionMetadata(row)?.backend, undefined, `${String(absent)} is honest absence`);
  }
  // Raw decoding is the boundary the unnegotiated guard depends on, so it is proved
  // here too: a wire page whose row carries backend:null is refused whole, while the
  // byte-identical page with the key removed decodes as the legacy row.
  const pageWith = JSON.stringify({
    type: "snapshot_page",
    subscriptionId: "sub-null",
    transferId: "transfer-null",
    pageIndex: 0,
    rows: [{ ...base, backend: null }],
  });
  assert.throws(
    () => decodeRosterBridgeFrame(Buffer.from(pageWith, "utf8")),
    "backend:null must not decode into absence before the negotiation check can see it",
  );
  const pageWithout = JSON.stringify({
    type: "snapshot_page",
    subscriptionId: "sub-null",
    transferId: "transfer-null",
    pageIndex: 0,
    rows: [{ ...base, backend: undefined }],
  });
  assert.equal(decodeRosterBridgeFrame(Buffer.from(pageWithout, "utf8")).type, "snapshot_page",
    "the same page without the key stays the accepted legacy shape");
  // A label that reads like a provider never changes the identity.
  const labelled = toRemoteSessionMetadata(ownerRow("row-2", "claude"), { backend: true });
  assert.notEqual(labelled.label, labelled.backend);
});

// ---------------------------------------------------------- native create

const CREATE_REQUEST = Object.freeze({
  hostRunId: OWNER_RUN,
  workspace: "/srv/owner/new child",
  backend: "claude" as const,
  targetId: "external:workhorse",
});

test("a native create reaches the injected provider once with the exact fields", async () => {
  const calls: OwnerNativeCreateRequest[] = [];
  const guards: boolean[] = [];
  const h = harness({
    inventory: fixedSource([]),
    viewerCapabilities: NATIVE_OFFER,
    owner: nativeOwner({
      create: async (request, stillAuthorized) => {
        calls.push(request);
        guards.push(stillAuthorized());
        return { kind: "started", hostRunId: request.hostRunId, rowId: "native-row-9" };
      },
    }).owner,
  });
  try {
    await h.viewer.hello;
    await h.viewer.subscribe();
    const result = await h.viewer.createNativeSession(CREATE_REQUEST);
    assert.deepEqual(result, {
      kind: "owner-result",
      facts: { kind: "started", hostRunId: OWNER_RUN, rowId: "native-row-9" },
    });
    assert.deepEqual(calls, [CREATE_REQUEST],
      "the exact owner run, verbatim workspace, backend, and owner-advertised target reach the provider");
    assert.deepEqual(guards, [true], "the provider is handed the owner's live re-proof");
    // The answer came on the native frame, and only one create frame was written.
    const sentByViewer = h.viewerSide.frames().map((frame) => frame.type);
    const sentByOwner = h.ownerSide.frames().map((frame) => frame.type);
    assert.deepEqual(sentByViewer.filter((type) => type === "create_native_request"), ["create_native_request"]);
    assert.deepEqual(sentByOwner.filter((type) => type === "create_native_result"), ["create_native_result"]);
    assert.deepEqual(sentByViewer.filter((type) => type === "create_request"), [], "no Pi create was submitted");
    assert.deepEqual(sentByOwner.filter((type) => type === "create_result"), []);
    // The projection is untouched: no optimistic row, selection, or focus change.
    assert.deepEqual(h.viewer.projection.rows, []);
  } finally {
    await h.stop();
  }
});

test("an unknown or cross-backend target is refused without reaching the provider", async () => {
  const calls: OwnerNativeCreateRequest[] = [];
  const h = harness({
    inventory: fixedSource([]),
    viewerCapabilities: NATIVE_OFFER,
    owner: nativeOwner({
      create: async (request) => {
        calls.push(request);
        return { kind: "started", hostRunId: request.hostRunId, rowId: "unexpected" };
      },
    }).owner,
  });
  try {
    await h.viewer.hello;
    await h.viewer.subscribe();
    // The requester's own configured target id is never addressable.
    assert.deepEqual(await h.viewer.createNativeSession({ ...CREATE_REQUEST, targetId: "my-local-claude" }),
      { kind: "not-sent", reason: "invalid-request" });
    // An id the owner advertised for the other backend never matches.
    assert.deepEqual(await h.viewer.createNativeSession({ ...CREATE_REQUEST, backend: "codex", targetId: "external:workhorse" }),
      { kind: "not-sent", reason: "invalid-request" });
    // And neither is a Pi backend or a malformed request shape.
    assert.deepEqual(await h.viewer.createNativeSession({ ...CREATE_REQUEST, backend: "pi" as never }),
      { kind: "not-sent", reason: "invalid-request" });
    assert.deepEqual(await h.viewer.createNativeSession({ ...CREATE_REQUEST, targetId: "bad\nid" }),
      { kind: "not-sent", reason: "invalid-request" });
    assert.deepEqual(await h.viewer.createNativeSession({ ...CREATE_REQUEST, workspace: "" }),
      { kind: "not-sent", reason: "invalid-request" });
    assert.deepEqual(calls, [], "no unusable request is ever forwarded, and nothing falls back to Pi");
  } finally {
    await h.stop();
  }
});

test("a target withdrawn between admission and invocation never launches", async () => {
  const calls: OwnerNativeCreateRequest[] = [];
  let reads = 0;
  const h = harness({
    inventory: fixedSource([]),
    viewerCapabilities: NATIVE_OFFER,
    owner: nativeOwner({
      targets: () => {
        reads += 1;
        // Admitted on the first read, gone by the final re-proof.
        return reads <= 1 ? [SHARED_TARGET] : [];
      },
      create: async (request) => {
        calls.push(request);
        return { kind: "started", hostRunId: request.hostRunId, rowId: "unexpected" };
      },
    }).owner,
  });
  try {
    await h.viewer.hello;
    await h.viewer.subscribe();
    assert.deepEqual(await h.viewer.createNativeSession(CREATE_REQUEST),
      { kind: "owner-result", facts: { kind: "refused" } });
    assert.deepEqual(calls, [], "the final re-proof stopped the provider before it was reached");
  } finally {
    await h.stop();
  }
});

test("a replayed or out-of-order attempt is refused without reaching either provider", async () => {
  const nativeCalls: OwnerNativeCreateRequest[] = [];
  const piCalls: unknown[] = [];
  const h = harness({
    inventory: fixedSource([]),
    viewerCapabilities: NATIVE_OFFER,
    owner: nativeOwner({
      create: async (request) => {
        nativeCalls.push(request);
        return { kind: "started", hostRunId: request.hostRunId, rowId: "native-1" };
      },
      createOwnedSession: async (request) => {
        piCalls.push(request);
        return { kind: "started", hostRunId: request.hostRunId, rowId: "pi-1" };
      },
    }).owner,
  });
  try {
    await h.viewer.hello;
    await h.viewer.subscribe();
    // A hand-built frame that replays an attempt number the owner already consumed.
    const first = await h.viewer.createNativeSession(CREATE_REQUEST);
    assert.equal(first.kind, "owner-result");
    const written = h.viewerSide.frames().filter((frame) => frame.type === "create_native_request");
    assert.equal(written.length, 1);
    const frame = written[0];
    assert.ok(frame.type === "create_native_request");
    const replay = { ...frame, requestId: "replay-correlation" };
    // Delivered on the OWNER's side, exactly as the transport would deliver what
    // this side sent: a frame the owner already answered, replayed verbatim.
    h.ownerSide.deliver(encodeRosterBridgeFrame(replay));
    // The owner answers the replay with a fixed refusal and never calls a provider.
    const frames = h.ownerSide.frames().filter((candidate) => candidate.type === "create_native_result");
    const last = frames[frames.length - 1];
    assert.ok(last && last.type === "create_native_result");
    assert.deepEqual(last.outcome, { kind: "refused" });
    assert.equal(nativeCalls.length, 1, "the replay never reached the native provider");
    assert.deepEqual(piCalls, [], "the replay never fell through to the Pi provider");
  } finally {
    await h.stop();
  }
});

test("one create is in flight per channel across BOTH lanes", async () => {
  const nativeCalls: OwnerNativeCreateRequest[] = [];
  const piCalls: unknown[] = [];
  let releaseNative: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => { releaseNative = resolve; });
  const h = harness({
    inventory: fixedSource([]),
    viewerCapabilities: [ROSTER_BRIDGE_NATIVE_CAPABILITY, ROSTER_BRIDGE_CREATE_CAPABILITY],
    owner: nativeOwner({
      create: async (request) => {
        nativeCalls.push(request);
        await gate;
        return { kind: "started", hostRunId: request.hostRunId, rowId: "native-1" };
      },
      createOwnedSession: async (request) => {
        piCalls.push(request);
        return { kind: "started", hostRunId: request.hostRunId, rowId: "pi-1" };
      },
    }).owner,
  });
  try {
    await h.viewer.hello;
    await h.viewer.subscribe();
    const native = h.viewer.createNativeSession(CREATE_REQUEST);
    // Wait until the owner really accepted the native create.
    for (let attempt = 0; attempt < 200 && nativeCalls.length === 0; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    assert.equal(nativeCalls.length, 1);
    // A Pi create while the native one is live is refused, not queued behind it.
    assert.deepEqual(await h.viewer.createSession({ hostRunId: OWNER_RUN, workspace: "/srv/owner/other" }),
      { kind: "not-sent", reason: "busy" });
    // And a second native create is refused the same way.
    assert.deepEqual(await h.viewer.createNativeSession({ ...CREATE_REQUEST, targetId: "claude" }),
      { kind: "not-sent", reason: "busy" });
    assert.deepEqual(piCalls, [], "the refused Pi create never reached the Pi provider");
    assert.equal(nativeCalls.length, 1, "the refused native create never reached the native provider");
    releaseNative();
    assert.deepEqual(await native, {
      kind: "owner-result",
      facts: { kind: "started", hostRunId: OWNER_RUN, rowId: "native-1" },
    });
    // After it settles, the next attempt is a fresh one on the same counter.
    assert.deepEqual(await h.viewer.createSession({ hostRunId: OWNER_RUN, workspace: "/srv/owner/other" }),
      { kind: "owner-result", facts: { kind: "started", hostRunId: OWNER_RUN, rowId: "pi-1" } });
    const sequences = h.viewerSide.frames()
      .filter((frame) => frame.type === "create_native_request" || frame.type === "create_request")
      .map((frame) => frame.sequence);
    assert.deepEqual(sequences, [1, 2], "one monotonic per-channel attempt number across both lanes");
  } finally {
    await h.stop();
  }
});

test("a lost reply is unknown, never \"not sent\"", async () => {
  const h = harness({
    inventory: fixedSource([]),
    viewerCapabilities: NATIVE_OFFER,
    owner: nativeOwner({ create: () => new Promise<OwnerCreateFacts>(() => undefined) }).owner,
  });
  try {
    await h.viewer.hello;
    await h.viewer.subscribe();
    const pending = h.viewer.createNativeSession(CREATE_REQUEST);
    // The owner's provider never answers; the channel then goes away under the
    // request. The only honest answer is that the outcome is unobservable.
    await h.ownerSide.close();
    assert.deepEqual(await pending, { kind: "unknown" });
  } finally {
    await h.stop();
  }
});

test("a replaced owner run invalidates the catalog for use", async () => {
  const pushed = pushableSource([ownerRow("row-1")]);
  const h = harness({
    inventory: pushed.source,
    viewerCapabilities: NATIVE_OFFER,
    owner: nativeOwner().owner,
  });
  try {
    await h.viewer.hello;
    const first = await h.viewer.subscribe();
    assert.deepEqual(first.nativeCliTargets, [CLAUDE_TARGET, CODEX_TARGET, SHARED_TARGET]);
    // The owner's manager is replaced by a new run, exactly as a restarted host's
    // would be. The old subscription ends and its catalog goes with it.
    pushed.push([ownerRow("row-1")], "owner-run-b");
    for (let attempt = 0; attempt < 400 && h.viewer.projection.state === "current"; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.notEqual(h.viewer.projection.state, "current");
    assert.equal(h.viewer.projection.nativeCliTargets, null,
      "a target list never survives the run that published it");
    assert.deepEqual(await h.viewer.createNativeSession(CREATE_REQUEST),
      { kind: "not-sent", reason: "invalid-request" },
      "the stale catalog cannot be addressed, and nothing is defaulted");
  } finally {
    await h.stop();
  }
});

// ------------------------------------------------- unnegotiated extensions

/**
 * A viewer on a bare channel with no real owner behind it, so a snapshot can be
 * written to it frame by frame exactly as it arrives on the wire. The owner here is
 * whatever the test says it is: a peer that acknowledged only the baseline, or one
 * that acknowledged the native lane too.
 */
function rawViewer(acknowledged: readonly string[]): { readonly viewer: RosterBridgeViewer; readonly channel: Loopback } {
  const channel = new Loopback("viewer-only", "viewer-key");
  const viewer = attachRosterBridgeViewer({
    channel,
    ...(acknowledged.includes(ROSTER_BRIDGE_NATIVE_CAPABILITY)
      ? { capabilities: [ROSTER_BRIDGE_NATIVE_CAPABILITY] }
      : {}),
  });
  channel.deliver(encodeRosterBridgeFrame({
    type: "hello_ack",
    service: ROSTER_BRIDGE_SERVICE,
    major: ROSTER_BRIDGE_MAJOR,
    minor: ROSTER_BRIDGE_MINOR,
    capabilities: acknowledged,
  }));
  return { viewer, channel };
}

/** The subscription id this viewer asked for, read off its own write. */
async function liveSubscriptionId(channel: Loopback): Promise<string> {
  await waitFor(() => channel.frames().some((frame) => frame.type === "subscribe"),
    "the viewer wrote its subscribe frame");
  const frames = channel.frames();
  for (let index = frames.length - 1; index >= 0; index -= 1) {
    const frame = frames[index];
    if (frame !== undefined && frame.type === "subscribe") return frame.subscriptionId;
  }
  assert.fail("the viewer never wrote a subscribe frame");
}

function snapshotFrames(options: {
  readonly subscriptionId: string;
  readonly transferId: string;
  readonly revision: number;
  readonly rows: readonly NativeInstanceView[];
  readonly backendOnRows: boolean;
  readonly nativeCliTargets?: readonly RemoteNativeCliTarget[];
}): readonly Buffer[] {
  return buildRosterBridgeTransfer({
    subscriptionId: options.subscriptionId,
    transferId: options.transferId,
    hostRunId: OWNER_RUN,
    revision: options.revision,
    rows: options.rows.map((row) => toRemoteSessionMetadata(row, options.backendOnRows ? { backend: true } : {})),
    ...(options.nativeCliTargets === undefined ? {} : { nativeCliTargets: options.nativeCliTargets }),
  }).frames;
}

test("an unnegotiated typed row fails the whole subscription closed, and legacy snapshots stay accepted", async () => {
  const r = rawViewer([ROSTER_BRIDGE_REQUIRED_CAPABILITY]);
  try {
    await r.viewer.hello;
    // First: an ordinary legacy snapshot, which must still be accepted after this
    // guard exists — the preserved behavior, proved on the same channel.
    const first = r.viewer.subscribe();
    for (const bytes of snapshotFrames({
      subscriptionId: await liveSubscriptionId(r.channel), transferId: "transfer-legacy", revision: 1, rows: [ownerRow("row-1")], backendOnRows: false,
    })) r.channel.deliver(bytes);
    const legacy = await first;
    assert.equal(legacy.state, "current");
    assert.deepEqual(legacy.rows.map((row) => row.id), ["row-1"]);
    assert.equal(legacy.nativeCliTargets, null);

    // Then the same owner, unasked, typing a row. The page is refused before any of
    // it is staged, so nothing about it is ever published.
    const second = r.viewer.subscribe();
    for (const bytes of snapshotFrames({
      subscriptionId: await liveSubscriptionId(r.channel),
      transferId: "transfer-typed",
      revision: 2,
      rows: [ownerRow("row-2", "claude")],
      backendOnRows: true,
    })) r.channel.deliver(bytes);
    await assert.rejects(() => second);
    const after = r.viewer.projection;
    assert.notEqual(after.state, "current", "an unnegotiated extension never becomes current");
    assert.deepEqual(after.rows.map((row) => row.id), ["row-1"], "the typed row was never staged");
    for (const row of after.rows) assert.equal(row.backend, undefined);
    assert.equal(after.nativeCliTargets, null);
    // And it fails CLOSED: this side says so on the channel instead of quietly
    // accepting an extension it never offered.
    await settle();
    assert.ok(r.channel.attemptedFrames().some((frame) => frame.type === "error"),
      "the viewer reports the unnegotiated extension as a protocol violation");
    // It also stops the channel rather than going on receiving from a peer that
    // widened the schema unasked.
    await r.channel.closed;
  } finally {
    await r.viewer.stop().catch(() => undefined);
  }
});

test("a backend:null page cannot slip past the unnegotiated guard into a current snapshot", async () => {
  const r = rawViewer([ROSTER_BRIDGE_REQUIRED_CAPABILITY]);
  try {
    await r.viewer.hello;
    const first = r.viewer.subscribe();
    const subscriptionId = await liveSubscriptionId(r.channel);
    // A real, accepted transfer's own begin and end frames, with only the page
    // replaced by the one the decoder used to launder into a legacy row: the key is
    // present and null, which is not a member of the closed backend set.
    const built = buildRosterBridgeTransfer({
      subscriptionId,
      transferId: "transfer-null-page",
      hostRunId: OWNER_RUN,
      revision: 1,
      rows: [toRemoteSessionMetadata(ownerRow("row-1"))],
    }).frames;
    const kinds = built.map((bytes) => decodeRosterBridgeFrame(bytes).type);
    const begin = built[kinds.indexOf("snapshot_begin")];
    const end = built[kinds.indexOf("snapshot_end")];
    assert.ok(begin !== undefined && end !== undefined, "the transfer really has a begin and an end");
    r.channel.deliver(begin);
    r.channel.deliver(Buffer.from(JSON.stringify({
      type: "snapshot_page",
      subscriptionId,
      transferId: "transfer-null-page",
      pageIndex: 0,
      rows: [{ ...toRemoteSessionMetadata(ownerRow("row-1")), backend: null }],
    }), "utf8"));
    r.channel.deliver(end);
    await assert.rejects(() => first);
    await settle();
    assert.notEqual(r.viewer.projection.state, "current",
      "a foreign null backend never becomes a current snapshot");
    assert.deepEqual(r.viewer.projection.rows, [], "and no row of it is published");
    assert.equal(r.viewer.projection.nativeCliTargets, null);
    assert.ok(r.channel.attemptedFrames().some((frame) => frame.type === "error"),
      "this side reports the malformed frame instead of accepting it");
  } finally {
    await r.viewer.stop().catch(() => undefined);
  }
});

test("an unnegotiated snapshot_end catalog fails the whole subscription closed", async () => {
  const r = rawViewer([ROSTER_BRIDGE_REQUIRED_CAPABILITY]);
  try {
    await r.viewer.hello;
    const first = r.viewer.subscribe();
    for (const bytes of snapshotFrames({
      subscriptionId: await liveSubscriptionId(r.channel),
      transferId: "transfer-catalog",
      revision: 1,
      rows: [ownerRow("row-1")],
      backendOnRows: false,
      nativeCliTargets: [CLAUDE_TARGET],
    })) r.channel.deliver(bytes);
    await assert.rejects(() => first);
    assert.equal(r.viewer.projection.state, "empty");
    assert.equal(r.viewer.projection.nativeCliTargets, null);
    await settle();
    assert.ok(r.channel.attemptedFrames().some((frame) => frame.type === "error"));
    // It also stops the channel rather than going on receiving from a peer that
    // widened the schema unasked.
    await r.channel.closed;
  } finally {
    await r.viewer.stop().catch(() => undefined);
  }
});

test("the identical frames are accepted once the native lane is negotiated", async () => {
  const r = rawViewer([ROSTER_BRIDGE_REQUIRED_CAPABILITY, ROSTER_BRIDGE_NATIVE_CAPABILITY]);
  try {
    await r.viewer.hello;
    assert.equal(r.viewer.supportsNative, true);
    const first = r.viewer.subscribe();
    for (const bytes of snapshotFrames({
      subscriptionId: await liveSubscriptionId(r.channel),
      transferId: "transfer-negotiated",
      revision: 1,
      rows: [ownerRow("row-1", "claude"), ownerRow("row-2")],
      backendOnRows: true,
      nativeCliTargets: [CLAUDE_TARGET],
    })) r.channel.deliver(bytes);
    const projection = await first;
    assert.equal(projection.state, "current");
    assert.deepEqual(projection.rows.map((row) => [row.id, row.backend ?? "<absent>"]), [
      ["row-1", "claude"],
      ["row-2", "<absent>"],
    ]);
    assert.deepEqual(projection.nativeCliTargets, [CLAUDE_TARGET]);
    assert.equal(r.channel.frames().some((frame) => frame.type === "error"), false);
  } finally {
    await r.viewer.stop().catch(() => undefined);
  }
});

// ------------------------------------------------ raw-frame owner fences

/** Let every queued continuation run. */
async function settle(rounds = 6): Promise<void> {
  for (let round = 0; round < rounds; round += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

async function waitFor(predicate: () => boolean, message: string): Promise<void> {
  for (let attempt = 0; attempt < 400 && !predicate(); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  assert.equal(predicate(), true, message);
}

/** One native create frame as it arrives on the wire, with a caller-chosen run. */
function rawNativeRequest(options: {
  readonly requestId: string;
  readonly hostRunId: string;
  readonly sequence: number;
  readonly backend?: "claude" | "codex";
  readonly targetId?: string;
  readonly workspace?: string;
}): Record<string, unknown> {
  return {
    type: "create_native_request",
    requestId: options.requestId,
    hostRunId: options.hostRunId,
    workspace: options.workspace ?? "/srv/owner/child",
    backend: options.backend ?? "claude",
    targetId: options.targetId ?? "external:workhorse",
    sequence: options.sequence,
  };
}

function nativeResultsOnOwner(side: Loopback): RosterBridgeFrame[] {
  return side.frames().filter((frame) => frame.type === "create_native_result");
}

test("a raw native request naming another owner run never reaches the provider", async () => {
  const calls: OwnerNativeCreateRequest[] = [];
  const h = harness({
    inventory: fixedSource([]),
    viewerCapabilities: NATIVE_OFFER,
    owner: nativeOwner({
      create: async (request) => {
        calls.push(request);
        return { kind: "started", hostRunId: request.hostRunId, rowId: "unexpected" };
      },
    }).owner,
  });
  try {
    await h.viewer.hello;
    await h.viewer.subscribe();
    // A hand-built frame naming a run this channel never observed. The admission
    // fence is the owner's own live subscription, not the requester's assertion.
    h.ownerSide.deliver(encodeRosterBridgeFrame(
      rawNativeRequest({ requestId: "raw-foreign-run", hostRunId: "some-other-run", sequence: 1 }) as never,
    ));
    await settle();
    assert.deepEqual(calls, [], "no provider is reached for a run this channel does not observe");
    assert.deepEqual(nativeResultsOnOwner(h.ownerSide), [],
      "and nothing is claimed about it either: an unauthorized run establishes nothing");
  } finally {
    await h.stop();
  }
});

test("an owner run replaced between admission and invocation never invokes the provider", async () => {
  const calls: OwnerNativeCreateRequest[] = [];
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const pushed = pushableSource([ownerRow("row-1")]);
  const h = harness({
    inventory: pushed.source,
    viewerCapabilities: NATIVE_OFFER,
    owner: nativeOwner({
      create: async (request) => {
        calls.push(request);
        await gate;
        return { kind: "started", hostRunId: request.hostRunId, rowId: "native-1" };
      },
    }).owner,
  });
  try {
    await h.viewer.hello;
    await h.viewer.subscribe();
    h.ownerSide.deliver(encodeRosterBridgeFrame(
      rawNativeRequest({ requestId: "raw-run-change", hostRunId: OWNER_RUN, sequence: 1 }) as never,
    ));
    // The owner's manager is replaced before the detached continuation runs, which
    // retires this exact subscription. The provider must never be reached.
    pushed.push([ownerRow("row-1")], "owner-run-b");
    await settle();
    release();
    await settle();
    assert.deepEqual(calls, [], "the run fence inside the continuation stopped it");
    assert.deepEqual(nativeResultsOnOwner(h.ownerSide), [],
      "and no result is written about a run this channel no longer observes");
  } finally {
    release();
    await h.stop();
  }
});

test("a catalog callback that revokes the grant still cannot reach the provider", async () => {
  const calls: OwnerNativeCreateRequest[] = [];
  let authorized = true;
  let reads = 0;
  const h = harness({
    inventory: fixedSource([]),
    viewerCapabilities: NATIVE_OFFER,
    owner: {
      authorizePeer: () => authorized,
      nativeCliTargets: () => {
        reads += 1;
        // The FINAL read — the one whose result the owner was about to act on —
        // revokes this peer while still returning a catalog naming the target.
        if (reads === 2) authorized = false;
        return [SHARED_TARGET];
      },
      createOwnedSession: async () => ({ kind: "refused" as const }),
      nativeCreateOwnedSession: async (request) => {
        calls.push(request);
        return { kind: "started", hostRunId: request.hostRunId, rowId: "unexpected" };
      },
    },
  });
  try {
    await h.viewer.hello;
    await h.viewer.subscribe();
    h.ownerSide.deliver(encodeRosterBridgeFrame(
      rawNativeRequest({ requestId: "raw-revoke", hostRunId: OWNER_RUN, sequence: 1 }) as never,
    ));
    await settle();
    assert.equal(reads >= 2, true, "the final catalog read really happened");
    assert.deepEqual(calls, [], "a grant revoked inside the owner's own callout is re-proved before invoking");
  } finally {
    await h.stop();
  }
});

test("a target-dependent refusal still consumes the shared attempt number", async () => {
  const nativeCalls: OwnerNativeCreateRequest[] = [];
  const piCalls: unknown[] = [];
  const catalog: RemoteNativeCliTarget[] = [];
  const h = harness({
    inventory: fixedSource([]),
    viewerCapabilities: [ROSTER_BRIDGE_NATIVE_CAPABILITY, ROSTER_BRIDGE_CREATE_CAPABILITY],
    owner: nativeOwner({
      targets: () => [...catalog],
      create: async (request) => {
        nativeCalls.push(request);
        return { kind: "started", hostRunId: request.hostRunId, rowId: "native-1" };
      },
      createOwnedSession: async (request) => {
        piCalls.push(request);
        return { kind: "started", hostRunId: request.hostRunId, rowId: "pi-1" };
      },
    }).owner,
  });
  try {
    await h.viewer.hello;
    await h.viewer.subscribe();
    const frame = rawNativeRequest({ requestId: "raw-later", hostRunId: OWNER_RUN, sequence: 5 });
    // Attempt 5 is refused because the target is not advertised (yet).
    h.ownerSide.deliver(encodeRosterBridgeFrame(frame as never));
    await settle();
    assert.deepEqual(nativeResultsOnOwner(h.ownerSide).map((f) => f.type === "create_native_result" && f.outcome),
      [{ kind: "refused" }]);
    // The very same frame, replayed now that the target exists, cannot succeed:
    // its attempt number was consumed by the first refusal.
    catalog.push(SHARED_TARGET);
    h.ownerSide.deliver(encodeRosterBridgeFrame(frame as never));
    await settle();
    assert.deepEqual(nativeCalls, [], "a refused attempt cannot be replayed into a launch");
    assert.equal(nativeResultsOnOwner(h.ownerSide).length, 2);
    // And the high-water is shared: a LOWER Pi attempt is inadmissible too.
    h.ownerSide.deliver(encodeRosterBridgeFrame({
      type: "create_request",
      requestId: "raw-pi-lower",
      hostRunId: OWNER_RUN,
      workspace: "/srv/owner/child",
      sequence: 4,
    } as never));
    await settle();
    assert.deepEqual(piCalls, [], "the Pi lane cannot use a number a native refusal already consumed");
    // A fresh higher number on the Pi lane is a fresh attempt, and works.
    h.ownerSide.deliver(encodeRosterBridgeFrame({
      type: "create_request",
      requestId: "raw-pi-fresh",
      hostRunId: OWNER_RUN,
      workspace: "/srv/owner/child",
      sequence: 6,
    } as never));
    await settle();
    assert.equal(piCalls.length, 1, "the shared counter keeps moving forward for both lanes");
  } finally {
    await h.stop();
  }
});

test("replaying the in-flight native frame never answers it with a competing refusal", async () => {
  const calls: OwnerNativeCreateRequest[] = [];
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const h = harness({
    inventory: fixedSource([]),
    viewerCapabilities: NATIVE_OFFER,
    owner: nativeOwner({
      create: async (request) => {
        calls.push(request);
        await gate;
        return { kind: "started", hostRunId: request.hostRunId, rowId: "native-1" };
      },
    }).owner,
  });
  try {
    await h.viewer.hello;
    await h.viewer.subscribe();
    const pending = h.viewer.createNativeSession(CREATE_REQUEST);
    await waitFor(() => calls.length === 1, "the owner accepted the native create");
    // Deliver the requester's own frame again, byte for byte, while its provider is
    // still running. This side has one answer for that correlation and it is owed
    // by the original operation.
    const raw = h.viewerSide.sent[h.viewerSide.sent.length - 1] as Buffer;
    assert.equal(decodeRosterBridgeFrame(raw).type, "create_native_request");
    h.ownerSide.deliver(raw);
    await settle();
    assert.deepEqual(nativeResultsOnOwner(h.ownerSide), [],
      "no `refused` may claim a child was not created while the provider may still create it");
    assert.equal(calls.length, 1, "and no second provider call either");
    // The requester is still waiting on its own operation, not on a stale refusal.
    const raced = await Promise.race([
      pending.then(() => "settled" as const),
      new Promise<"pending">((resolve) => setTimeout(() => resolve("pending"), 25)),
    ]);
    assert.equal(raced, "pending", "the requester stays pending until the real outcome arrives");
    release();
    assert.deepEqual(await pending, {
      kind: "owner-result",
      facts: { kind: "started", hostRunId: OWNER_RUN, rowId: "native-1" },
    }, "the original operation's own result is the only answer");
  } finally {
    release();
    await h.stop();
  }
});

// ------------------------------------------------------------- wire schema

test("native frames round-trip through the closed schema and refuse anything else", () => {
  const request = {
    type: "create_native_request" as const,
    requestId: "req-1",
    hostRunId: OWNER_RUN,
    workspace: "/srv/owner/astral-\u{1f600} path",
    backend: "codex" as const,
    targetId: "external:workhorse",
    sequence: 4,
  };
  assert.deepEqual(decodeRosterBridgeFrame(encodeRosterBridgeFrame(request)), request);
  const result = {
    type: "create_native_result" as const,
    requestId: "req-1",
    outcome: { kind: "started" as const, hostRunId: OWNER_RUN, rowId: "row-7" },
  };
  assert.deepEqual(decodeRosterBridgeFrame(encodeRosterBridgeFrame(result)), result);

  const rejects = (frame: Record<string, unknown>): boolean => {
    try {
      decodeRosterBridgeFrame(encodeRosterBridgeFrame(frame as never));
      return false;
    } catch {
      return true;
    }
  };
  // An arbitrary command, role, approval flag, or requester-side path cannot ride.
  assert.equal(rejects({ ...request, command: "/usr/bin/claude" }), true);
  assert.equal(rejects({ ...request, args: ["--dangerously-skip-permissions"] }), true);
  assert.equal(rejects({ ...request, env: { ANTHROPIC_API_KEY: "x" } }), true);
  assert.equal(rejects({ ...request, approved: true }), true);
  assert.equal(rejects({ ...request, backend: "pi" }), true);
  assert.equal(rejects({ ...request, backend: "mystery" }), true);
  assert.equal(rejects({ ...request, targetId: "" }), true);
  assert.equal(rejects({ ...request, targetId: "line\nbreak" }), true);
  assert.equal(rejects({ ...request, sequence: 0 }), true);
  assert.equal(rejects({ ...request, sequence: 1.5 }), true);
  // The Pi create's exact shape is unchanged: a new key is refused there too.
  const pi = {
    type: "create_request" as const,
    requestId: "req-2",
    hostRunId: OWNER_RUN,
    workspace: "/srv/owner/child",
    sequence: 1,
  };
  assert.deepEqual(decodeRosterBridgeFrame(encodeRosterBridgeFrame(pi)), pi);
  assert.equal(rejects({ ...pi, backend: "claude" }), true);
  assert.equal(rejects({ ...pi, targetId: "claude" }), true);
});

test("a snapshot end frame carries the catalog whole or not at all", () => {
  const built = buildRosterBridgeTransfer({
    subscriptionId: "sub-1",
    transferId: "transfer-1",
    hostRunId: OWNER_RUN,
    revision: 7,
    rows: [toRemoteSessionMetadata(ownerRow("row-1", "codex"), { backend: true })],
    bounds: DEFAULT_ROSTER_BRIDGE_BOUNDS,
    nativeCliTargets: [CODEX_TARGET],
  });
  const end = built.frames
    .map((bytes) => decodeRosterBridgeFrame(bytes))
    .find((frame) => frame.type === "snapshot_end");
  assert.ok(end && end.type === "snapshot_end");
  assert.deepEqual(end.nativeCliTargets, [CODEX_TARGET]);
  const page = built.frames
    .map((bytes) => decodeRosterBridgeFrame(bytes))
    .find((frame) => frame.type === "snapshot_page");
  assert.ok(page && page.type === "snapshot_page");
  assert.deepEqual(page.rows[0]?.backend, "codex");
  // Without the option the end frame is exactly the previous one.
  const plain = buildRosterBridgeTransfer({
    subscriptionId: "sub-1",
    transferId: "transfer-1",
    hostRunId: OWNER_RUN,
    revision: 7,
    rows: [toRemoteSessionMetadata(ownerRow("row-1"))],
  });
  const plainEnd = plain.frames.map((bytes) => decodeRosterBridgeFrame(bytes)).find((frame) => frame.type === "snapshot_end");
  assert.ok(plainEnd && plainEnd.type === "snapshot_end");
  assert.equal(Object.prototype.hasOwnProperty.call(plainEnd, "nativeCliTargets"), false);
});

test("the native catalog is bounded by the frame, and the encoded frame stays the authority", () => {
  // The entry guard is derived from `maxFrameBytes` alone: it cannot move when
  // only a row count changes, and it is a loop guard, never a product limit on
  // how many targets an owner may configure.
  assert.equal(
    rosterBridgeNativeCatalogMaxEntries(DEFAULT_ROSTER_BRIDGE_BOUNDS),
    DEFAULT_ROSTER_BRIDGE_BOUNDS.maxFrameBytes - 2,
  );
  assert.equal(
    rosterBridgeNativeCatalogMaxEntries(resolveRosterBridgeBounds({ maxRowsPerPage: 1, maxSnapshotRows: 1 })),
    rosterBridgeNativeCatalogMaxEntries(DEFAULT_ROSTER_BRIDGE_BOUNDS),
    "one row per page changes nothing about the catalog guard",
  );
  // More descriptors than one page of ROWS validate whole.
  const beyondOnePage = manyTargets(DEFAULT_ROSTER_BRIDGE_BOUNDS.maxRowsPerPage + 8);
  assert.deepEqual(readRosterBridgeNativeCliTargets(beyondOnePage, DEFAULT_ROSTER_BRIDGE_BOUNDS), beyondOnePage);
  // One descriptor past the frame-derived guard is refused, never truncated.
  const tiny = resolveRosterBridgeBounds({ maxFrameBytes: 128, maxPageBytes: 128, maxSnapshotBytes: 128 });
  assert.equal(rosterBridgeNativeCatalogMaxEntries(tiny), 126);
  expectFailureCode(() => readRosterBridgeNativeCliTargets(manyTargets(127), tiny), "bad_frame");
  // The reader also measures ACTUAL bytes, so a catalog that is inside the entry
  // guard but over the byte bound is refused here too, not only at the frame.
  const tinyOversized = manyTargets(30);
  assert.ok(tinyOversized.length <= rosterBridgeNativeCatalogMaxEntries(tiny));
  assert.ok(Buffer.byteLength(JSON.stringify(tinyOversized), "utf8") > tiny.maxFrameBytes);
  expectFailureCode(() => readRosterBridgeNativeCliTargets(tinyOversized, tiny), "bad_frame");
  // Acceptance by the reader is never a claim that a catalog can be sent: the
  // encoded `snapshot_end` frame is the authoritative byte boundary both ways.
  const tight = resolveRosterBridgeBounds({ maxFrameBytes: 1024, maxPageBytes: 1024, maxSnapshotBytes: 1024 });
  const targets = manyTargets(17); // inside the entry guard, outside a 1 KiB frame
  assert.deepEqual(readRosterBridgeNativeCliTargets(targets, tight), targets);
  // A catalog whose serialized array ALONE exceeds the frame bound is refused by
  // a direct reader call as well, while the 17-target catalog above stays accepted
  // because it only overflows once the frame's own fields are encoded.
  const oversizedAlone = manyTargets(20);
  assert.ok(Buffer.byteLength(JSON.stringify(oversizedAlone), "utf8") > tight.maxFrameBytes);
  expectFailureCode(() => readRosterBridgeNativeCliTargets(oversizedAlone, tight), "bad_frame");
  const end: RosterBridgeFrame = {
    type: "snapshot_end",
    subscriptionId: "sub-1",
    transferId: "transfer-1",
    revision: 3,
    totalRows: 1,
    nativeCliTargets: readRosterBridgeNativeCliTargets(targets, tight),
  };
  const bytes = encodeRosterBridgeFrame(end);
  assert.equal(decodeRosterBridgeFrame(bytes).type, "snapshot_end", "the same catalog is fine at the default bound");
  expectFailureCode(() => encodeRosterBridgeFrame(end, tight), "frame_too_large");
  expectFailureCode(() => decodeRosterBridgeFrame(bytes, tight), "frame_too_large");
  expectFailureCode(() => buildRosterBridgeTransfer({
    subscriptionId: "sub-1",
    transferId: "transfer-1",
    hostRunId: OWNER_RUN,
    revision: 3,
    rows: [toRemoteSessionMetadata(ownerRow("row-1", "claude"), { backend: true })],
    bounds: tight,
    nativeCliTargets: targets,
  }), "frame_too_large");
});

// ================================================================ native NAME

/**
 * The SEPARATE native HOST ROW NAME lane. It is negotiated apart from the native
 * create lane, carries no Pi conversation tuple, and answers only with the owner's
 * own per-operation persistence truth.
 */

const NAME_OFFER = [ROSTER_BRIDGE_NATIVE_CAPABILITY, ROSTER_BRIDGE_NATIVE_NAME_CAPABILITY];

/** One valid host-name request for `rowId` on the current owner run. */
function nameRequest(rowId = "row-1", over: Partial<OwnerNativeRenameRequest> = {}): OwnerNativeRenameRequest {
  return { hostRunId: OWNER_RUN, rowId, backend: "claude", name: "Renamed row", ...over };
}

/** The owner's native pair plus a scripted host-name provider, with calls recorded. */
function namingOwner(
  handler: OwnerNativeRenameHandler,
): Partial<RosterBridgeHostOptions> {
  return {
    ...nativeOwner().owner,
    renameNativeOwnedSession: handler,
  };
}

test("roster-native-name-v1 is its own optional lane, never implied by the create lane", () => {
  assert.equal(ROSTER_BRIDGE_NATIVE_NAME_CAPABILITY, "roster-native-name-v1");
  assert.notEqual(ROSTER_BRIDGE_NATIVE_NAME_CAPABILITY, ROSTER_BRIDGE_NATIVE_CAPABILITY);
  const offered = negotiateRosterBridgeHello({
    type: "hello",
    service: ROSTER_BRIDGE_SERVICE,
    major: ROSTER_BRIDGE_MAJOR,
    minor: ROSTER_BRIDGE_MINOR,
    capabilities: [ROSTER_BRIDGE_REQUIRED_CAPABILITY, ROSTER_BRIDGE_NATIVE_NAME_CAPABILITY],
  });
  assert.equal(offered.ok, true);
  assert.deepEqual(offered.ok ? offered.capabilities : null, [ROSTER_BRIDGE_NATIVE_NAME_CAPABILITY]);
  // Offering the CREATE lane alone never acknowledges the NAME lane.
  const createOnly = negotiateRosterBridgeHello({
    type: "hello",
    service: ROSTER_BRIDGE_SERVICE,
    major: ROSTER_BRIDGE_MAJOR,
    minor: ROSTER_BRIDGE_MINOR,
    capabilities: [ROSTER_BRIDGE_REQUIRED_CAPABILITY, ROSTER_BRIDGE_NATIVE_CAPABILITY],
  });
  assert.equal(createOnly.ok, true);
  assert.deepEqual(createOnly.ok ? createOnly.capabilities : null, [ROSTER_BRIDGE_NATIVE_CAPABILITY]);
});

test("the native name frames round-trip through the closed schema", () => {
  const request: RosterBridgeFrame = {
    type: "rename_native_request",
    requestId: "req-1",
    hostRunId: OWNER_RUN,
    rowId: "row-1",
    backend: "codex",
    name: "Kept  verbatim \u00e9",
    sequence: 7,
  };
  assert.deepEqual(decodeRosterBridgeFrame(encodeRosterBridgeFrame(request)), request);
  for (const outcome of [
    { kind: "renamed-durable" },
    { kind: "renamed-in-memory" },
    { kind: "refused" },
    { kind: "unknown" },
  ] as const) {
    const result: RosterBridgeFrame = { type: "rename_native_result", requestId: "req-2", outcome };
    assert.deepEqual(decodeRosterBridgeFrame(encodeRosterBridgeFrame(result)), result);
  }
  // No Pi conversation tuple, workspace, previous name, or owner text can ride
  // along: the encoder refuses the extra field, and the decoder refuses the extra
  // key on the wire. Neither side ever ignores an unknown field.
  const smuggled: readonly Record<string, unknown>[] = [
    { nativeSession: { sessionId: "s", epoch: 1, name: "n" } },
    { workspace: "/srv/owner/child" },
    { previousName: "Row row-1" },
    { command: "echo" },
    { args: ["--yolo"] },
    { env: { PI: "1" } },
  ];
  for (const extra of smuggled) {
    expectFailureCode(
      () => encodeRosterBridgeFrame({ ...request, ...extra } as unknown as RosterBridgeFrame),
      "invalid_frame",
    );
    expectFailureCode(
      () => decodeRosterBridgeFrame(Buffer.from(JSON.stringify({ ...request, ...extra }))),
      "bad_frame",
    );
  }
  // An unknown backend, an unusable caption, and a non-positive attempt are refused
  // on both sides, never defaulted or rewritten.
  for (const bad of [
    { backend: "pi" },
    { name: "" },
    { sequence: 0 },
    { backend: "claude;rm -rf" },
  ]) {
    const shaped = { ...request, ...bad } as unknown as RosterBridgeFrame;
    expectFailureCode(() => encodeRosterBridgeFrame(shaped), "invalid_frame");
    expectFailureCode(() => decodeRosterBridgeFrame(Buffer.from(JSON.stringify(shaped))), "bad_frame");
  }
  // A result fact set is closed: no name, row id, backend, or invented kind.
  for (const outcome of [
    { kind: "renamed-durable", name: "Renamed row" },
    { kind: "renamed-durable", rowId: "row-1" },
    { kind: "renamed-durable", backend: "claude" },
    { kind: "renamed" },
  ]) {
    const frame = {
      type: "rename_native_result",
      requestId: "req-3",
      outcome,
    } as unknown as RosterBridgeFrame;
    expectFailureCode(() => encodeRosterBridgeFrame(frame), "invalid_frame");
    expectFailureCode(() => decodeRosterBridgeFrame(Buffer.from(JSON.stringify(frame))), "bad_frame");
  }
});

test("a host name reaches the owner provider once with the exact fields and re-proof", async () => {
  const calls: OwnerNativeRenameRequest[] = [];
  const guards: boolean[] = [];
  const h = harness({
    inventory: fixedSource([ownerRow("row-1", "claude")]),
    viewerCapabilities: NAME_OFFER,
    owner: namingOwner(async (request, stillAuthorized) => {
      calls.push(request);
      guards.push(stillAuthorized());
      return { kind: "renamed-durable" };
    }),
  });
  try {
    await h.viewer.hello;
    await h.viewer.subscribe();
    assert.equal(h.viewer.supportsNativeName, true);
    const result = await h.viewer.renameNativeSession(nameRequest());
    assert.deepEqual(result, { kind: "owner-result", facts: { kind: "renamed-durable" } });
    assert.deepEqual(calls, [nameRequest()],
      "the exact owner run, row, recorded native backend, and verbatim caption reach the provider");
    assert.deepEqual(guards, [true], "the provider is handed the owner's live re-proof");
    const onViewer = h.viewerSide.frames().map((frame) => frame.type);
    const onOwner = h.ownerSide.frames().map((frame) => frame.type);
    assert.deepEqual(onViewer.filter((type) => type === "rename_native_request"), ["rename_native_request"]);
    assert.deepEqual(onOwner.filter((type) => type === "rename_native_result"), ["rename_native_result"]);
    // The Pi rename lane is never touched, and no caption is invented locally.
    assert.deepEqual(onViewer.filter((type) => type === "rename_request"), []);
    assert.deepEqual(onOwner.filter((type) => type === "rename_result"), []);
    assert.deepEqual(h.viewer.projection.rows.map((row) => row.label), ["Row row-1"],
      "the requester never optimistically rewrites the owner's caption");
  } finally {
    await h.stop();
  }
});

test("the owner's four persistence truths are answered distinctly, never collapsed", async () => {
  for (const kind of ["renamed-durable", "renamed-in-memory", "refused", "unknown"] as const) {
    const h = harness({
      inventory: fixedSource([ownerRow("row-1", "claude")]),
      viewerCapabilities: NAME_OFFER,
      owner: namingOwner(async () => ({ kind })),
    });
    try {
      await h.viewer.hello;
      await h.viewer.subscribe();
      const result = await h.viewer.renameNativeSession(nameRequest());
      assert.deepEqual(result, { kind: "owner-result", facts: { kind } }, `${kind} stays itself`);
    } finally {
      await h.stop();
    }
  }
});

test("an owner without a host-name provider never acknowledges it and fails a raw request closed", async () => {
  // The native CREATE pair is present; only the name provider is missing.
  const host = createRosterBridgeHost({
    inventory: fixedSource([ownerRow("row-1", "claude")]),
    authorizePeer: () => true,
    ...nativeOwner().owner,
  });
  const ownerSide = new Loopback("owner", "owner-key");
  const viewerSide = new Loopback("viewer", "viewer-key");
  ownerSide.peer = viewerSide;
  viewerSide.peer = ownerSide;
  host.attach(ownerSide);
  const viewer = attachRosterBridgeViewer({ channel: viewerSide, capabilities: NAME_OFFER });
  try {
    await viewer.hello;
    await viewer.subscribe();
    assert.equal(viewer.supportsNativeName, false,
      "the create lane alone never claims the name lane");
    const sent = ownerSide.frames().filter((frame) => frame.type === "hello_ack");
    assert.deepEqual(sent.length, 1);
    assert.ok(!(sent[0] as { capabilities: readonly string[] }).capabilities
      .includes(ROSTER_BRIDGE_NATIVE_NAME_CAPABILITY));
    // A request anyway is outside the negotiated protocol: the channel fails.
    const failed = viewerSide.closed;
    ownerSide.deliver(Buffer.from(JSON.stringify({
      type: "rename_native_request",
      requestId: "req-x",
      hostRunId: OWNER_RUN,
      rowId: "row-1",
      backend: "claude",
      name: "Whatever",
      sequence: 1,
    })));
    await failed;
  } finally {
    await viewer.stop().catch(() => undefined);
    await host.stopAll().catch(() => undefined);
    await ownerSide.close();
  }
});

test("a replayed, out-of-order, or second in-flight host name is refused without a second call", async () => {
  let calls = 0;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const h = harness({
    inventory: fixedSource([ownerRow("row-1", "claude")]),
    viewerCapabilities: NAME_OFFER,
    owner: namingOwner(async () => {
      calls += 1;
      await gate;
      return { kind: "renamed-durable" };
    }),
  });
  try {
    await h.viewer.hello;
    await h.viewer.subscribe();
    const first = h.viewer.renameNativeSession(nameRequest());
    await settle(2);
    // A second request while the first is in flight never reaches the provider.
    const second = await h.viewer.renameNativeSession(nameRequest("row-2"));
    assert.deepEqual(second, { kind: "not-sent", reason: "busy" });
    assert.equal(calls, 1);
    release();
    assert.deepEqual(await first, { kind: "owner-result", facts: { kind: "renamed-durable" } });
    // A replay of the SAME correlation is answered once; the accepted work is never
    // settled twice with a fabricated refusal.
    const before = h.ownerSide.frames().filter((f) => f.type === "rename_native_result").length;
    assert.equal(before, 1);
    assert.deepEqual(calls, 1);
  } finally {
    release();
    await h.stop();
  }
});

test("a raw out-of-order host name is refused and never reaches the provider", async () => {
  const calls: OwnerNativeRenameRequest[] = [];
  const host = createRosterBridgeHost({
    inventory: fixedSource([ownerRow("row-1", "claude")]),
    authorizePeer: () => true,
    ...namingOwner(async (request) => {
      calls.push(request);
      return { kind: "renamed-durable" };
    }),
  });
  const ownerSide = new Loopback("owner", "owner-key");
  const viewerSide = new Loopback("viewer", "viewer-key");
  ownerSide.peer = viewerSide;
  viewerSide.peer = ownerSide;
  host.attach(ownerSide);
  const viewer = attachRosterBridgeViewer({ channel: viewerSide, capabilities: NAME_OFFER });
  try {
    await viewer.hello;
    await viewer.subscribe();
    // Concede one real attempt so the owner's high-water is 1.
    await viewer.renameNativeSession(nameRequest());
    await settle(3);
    const resultsBefore = nameResultsOnOwner(ownerSide).length;
    ownerSide.deliver(Buffer.from(JSON.stringify({
      type: "rename_native_request",
      requestId: "req-old",
      hostRunId: OWNER_RUN,
      rowId: "row-1",
      backend: "claude",
      name: "Stale",
      sequence: 1,
    })));
    await settle(3);
    assert.deepEqual(calls.length, 1, "the stale attempt never reached the provider");
    const results = nameResultsOnOwner(ownerSide);
    assert.equal(results.length, resultsBefore + 1);
    assert.deepEqual((results[results.length - 1] as { outcome: unknown }).outcome, { kind: "refused" });
  } finally {
    await viewer.stop().catch(() => undefined);
    await host.stopAll().catch(() => undefined);
    await ownerSide.close();
  }
});

test("a host name whose row, backend, or run is no longer observed is never sent", async () => {
  const push = pushableSource([ownerRow("row-1", "claude")]);
  const h = harness({
    inventory: push.source,
    viewerCapabilities: NAME_OFFER,
    owner: namingOwner(async () => ({ kind: "renamed-durable" })),
  });
  try {
    await h.viewer.hello;
    await h.viewer.subscribe();
    // A row this side never observed.
    assert.deepEqual(await h.viewer.renameNativeSession(nameRequest("row-9")),
      { kind: "not-sent", reason: "target-unavailable" });
    // A backend the observed row does not report: never inferred from a caption.
    assert.deepEqual(await h.viewer.renameNativeSession(nameRequest("row-1", { backend: "codex" })),
      { kind: "not-sent", reason: "target-unavailable" });
    // The owner replaced its run: the old run's row is not a current target.
    push.push([ownerRow("row-1", "claude")], "owner-run-2");
    await settle(3);
    assert.deepEqual(await h.viewer.renameNativeSession(nameRequest("row-1")),
      { kind: "not-sent", reason: "target-unavailable" });
    // And the row's own backend moved out from under the request.
    push.push([ownerRow("row-1", "codex")], OWNER_RUN);
    await settle(3);
    assert.deepEqual(await h.viewer.renameNativeSession(nameRequest("row-1", { backend: "claude" })),
      { kind: "not-sent", reason: "target-unavailable" });
    assert.deepEqual(h.ownerSide.frames().filter((f) => f.type === "rename_native_request"), [],
      "none of these ever reached the transport");
  } finally {
    await h.stop();
  }
});

test("a channel that never acknowledged the name lane reports capability-unsupported", async () => {
  const h = harness({
    inventory: fixedSource([ownerRow("row-1", "claude")]),
    viewerCapabilities: NATIVE_OFFER,
    owner: namingOwner(async () => ({ kind: "renamed-durable" })),
  });
  try {
    await h.viewer.hello;
    await h.viewer.subscribe();
    assert.equal(h.viewer.supportsNativeName, false);
    assert.deepEqual(await h.viewer.renameNativeSession(nameRequest()),
      { kind: "not-sent", reason: "capability-unsupported" });
    assert.deepEqual(h.viewerSide.frames().filter((f) => f.type === "rename_native_request"), [],
      "no frame exists to send, and the Pi rename is never substituted");
    assert.deepEqual(h.viewerSide.frames().filter((f) => f.type === "rename_request"), []);
  } finally {
    await h.stop();
  }
});

test("a host name whose reply never arrives is unknown, never \"not sent\"", async () => {
  const h = harness({
    inventory: fixedSource([ownerRow("row-1", "claude")]),
    viewerCapabilities: NAME_OFFER,
    bounds: { renameResultTimeoutMs: 20 },
    owner: {
      ...nativeOwner().owner,
      // The owner accepts and never answers: the caption may still be applied.
      renameNativeOwnedSession: () => new Promise<OwnerNativeRenameFacts>(() => undefined),
    },
  });
  try {
    await h.viewer.hello;
    await h.viewer.subscribe();
    assert.deepEqual(await h.viewer.renameNativeSession(nameRequest()), { kind: "unknown" });
    // Nothing is replayed after the uncertainty.
    assert.deepEqual(h.viewerSide.frames().filter((f) => f.type === "rename_native_request").length, 1);
  } finally {
    await h.stop();
  }
});

function nameResultsOnOwner(side: Loopback): RosterBridgeFrame[] {
  return side.frames().filter((frame) => frame.type === "rename_native_result");
}
