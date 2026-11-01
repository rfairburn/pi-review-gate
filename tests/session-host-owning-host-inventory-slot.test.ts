/**
 * Focused coverage for the owning-host inventory projection of the host's
 * EXISTING durable roster slot (#477).
 *
 * Everything here is synthetic: a fake manager owns mutable rows and calls its
 * single change hook, and the service under test is the real local owning-host
 * service. No PTY, terminal, broker, listener, socket, filesystem, or product
 * state is touched.
 *
 * The contract being pinned down:
 * - the service stores no slot state of its own; it reads the host's slot
 *   accessor live, once per row of one capture, and nothing else;
 * - no accessor, a throwing accessor, an empty or non-string answer, and an
 *   unmapped row are all honest absence, and never an unreadable inventory;
 * - the slot is stable while the runtime row id, and the native conversation
 *   behind it, change underneath it;
 * - the row's own `id`, the manager listing calls, revisions, and watch
 *   behaviour are exactly what they were before.
 */

import assert from "node:assert/strict";
import test from "node:test";

import type {
  InstanceManagerOptions,
  NativeInstanceView,
  StatusRegistrar,
} from "../src/session-host/instances";
import type { SessionHostNativeSession } from "../src/session-host/protocol";
import {
  createLocalOwningHostService,
  type OwningHostInventorySnapshot,
  type OwningHostManager,
  type OwningHostService,
  type OwningHostServiceDependencies,
} from "../src/session-host/owning-host-service";

type MutableView = {
  -readonly [K in keyof NativeInstanceView]: NativeInstanceView[K] extends readonly (infer Item)[]
    ? Item[]
    : NativeInstanceView[K];
};

function nativeSession(id: string, epoch = 1): SessionHostNativeSession {
  return { sessionId: id, epoch, name: `Conversation ${id}` };
}

function rowView(overrides: Partial<NativeInstanceView> & { id: string }): MutableView {
  return {
    label: `Row ${overrides.id}`,
    workspace: "/synthetic/row-workspace",
    agentDir: "/synthetic/agent",
    lifecycle: "alive",
    busy: null,
    pendingInput: null,
    inputSurface: false,
    nativeSession: nativeSession(`conversation-${overrides.id}`),
    backgroundTasks: null,
    backgroundShells: null,
    activeTasks: null,
    activeShells: null,
    hasLiveProcess: true,
    activity: [],
    ...overrides,
  } as MutableView;
}

/** The synthetic authoritative manager: it owns rows and its one change hook. */
class SlotManager {
  readonly rows: MutableView[] = [];
  readonly otherCalls: string[] = [];
  listCalls = 0;
  #hostChange: ((instanceId: string) => void) | undefined;

  openManager(options: InstanceManagerOptions): void {
    this.#hostChange = options.onChange;
  }

  emitChange(instanceId: string): void {
    try {
      this.#hostChange?.(instanceId);
    } catch {
      // The real manager contains host change-hook failures; so does this fixture.
    }
  }

  list(): NativeInstanceView[] {
    this.listCalls += 1;
    return [...this.rows];
  }

  addRow(id: string, overrides?: Partial<NativeInstanceView>): MutableView {
    const row = rowView({ id, ...overrides });
    this.rows.push(row);
    return row;
  }

  replaceRow(oldId: string, newId: string): void {
    const index = this.rows.findIndex((row) => row.id === oldId);
    if (index >= 0) this.rows.splice(index, 1, rowView({ id: newId }));
  }

  setConversation(id: string, session: SessionHostNativeSession): void {
    const row = this.rows.find((candidate) => candidate.id === id);
    if (row) row.nativeSession = session;
  }

  create(): Promise<string> { this.otherCalls.push("create"); return Promise.resolve("never"); }
  write(): void { this.otherCalls.push("write"); }
  resize(): void { this.otherCalls.push("resize"); }
  surface(): undefined { this.otherCalls.push("surface"); return undefined; }
  closeExited(): boolean { this.otherCalls.push("closeExited"); return false; }
  hasLiveProcesses(): boolean { return this.rows.some((row) => row.hasLiveProcess); }
  ownedLiveSessions(): readonly unknown[] { return []; }
  openViewer(): undefined { return undefined; }
  viewerState(): undefined { return undefined; }
  sessionViewers(): readonly never[] { return []; }
  updateViewer(): never { throw new Error("unreachable"); }
  closeViewer(): boolean { return false; }
  instanceGeometry(): undefined { return undefined; }
  setInitialGeometry(): void {}
  async shutdown(): Promise<{ forcedIds: string[]; remainingIds: string[] }> {
    return { forcedIds: [], remainingIds: [] };
  }
  async dispose(): Promise<void> {}

  asManager(): OwningHostManager {
    return this as unknown as OwningHostManager;
  }
}

interface Harness {
  readonly manager: SlotManager;
  readonly service: OwningHostService;
  /** Every row id the host's slot accessor was asked about, in order. */
  readonly slotReads: string[];
  beginTeardown(): void;
}

function harness(options: {
  readonly slotFor?: (rowId: string) => string | undefined;
  readonly open?: boolean;
} = {}): Harness {
  const manager = new SlotManager();
  const slotReads: string[] = [];
  let teardown = false;
  const dependencies: OwningHostServiceDependencies = {
    createManager: (managerOptions) => {
      manager.openManager(managerOptions);
      return manager.asManager();
    },
    teardownRequested: () => teardown,
    ...(options.slotFor === undefined
      ? {}
      : {
        rosterSlotIdFor: (rowId: string): string | undefined => {
          slotReads.push(rowId);
          return options.slotFor?.(rowId);
        },
      }),
  };
  const service = createLocalOwningHostService(dependencies);
  if (options.open !== false) {
    service.openManager({
      packageRoot: "/synthetic/package",
      piExecutable: "/synthetic/pi",
      statusRegistrar: { register: () => { throw new Error("never registers"); } } as unknown as StatusRegistrar,
      cols: 100,
      rows: 30,
      getSidebarTitleColumns: () => 42,
      onChange: () => {},
    } as InstanceManagerOptions);
  }
  return { manager, service, slotReads, beginTeardown: () => { teardown = true; } };
}

function slotsOf(snapshot: OwningHostInventorySnapshot | undefined): Record<string, string | undefined> {
  assert.ok(snapshot, "the inventory is observable");
  return Object.fromEntries(snapshot.rows.map((row) => [row.id, row.rosterSlotId]));
}

test("an inventory capture carries no slot metadata when the host offers no accessor", () => {
  const h = harness();
  h.manager.addRow("row-1");
  h.manager.addRow("row-2");
  const snapshot = h.service.readInventorySnapshot();
  assert.ok(snapshot);
  for (const row of snapshot.rows) {
    assert.equal(Object.prototype.hasOwnProperty.call(row, "rosterSlotId"), false,
      "no accessor means the row keeps its pre-#477 shape");
  }
  assert.deepEqual(h.slotReads, []);
});

test("each row carries the slot the host's authority already holds, read live per capture", () => {
  const slots = new Map<string, string | undefined>([["row-1", "slot-a"], ["row-2", "slot-b"], ["row-3", undefined]]);
  const h = harness({ slotFor: (rowId) => slots.get(rowId) });
  h.manager.addRow("row-1");
  h.manager.addRow("row-2");
  h.manager.addRow("row-3");
  const snapshot = h.service.readInventorySnapshot();
  assert.deepEqual(slotsOf(snapshot), { "row-1": "slot-a", "row-2": "slot-b", "row-3": undefined });
  assert.deepEqual(h.slotReads, ["row-1", "row-2", "row-3"],
    "one read per manager row, keyed by the manager's own row ids");
  assert.equal(h.manager.listCalls, 1, "the slot read never triggers a second listing");
  assert.deepEqual(snapshot?.rows.map((row) => row.id), ["row-1", "row-2", "row-3"],
    "row order and runtime row ids are untouched");
  assert.ok(snapshot?.rows.every((row) => Object.isFrozen(row)));
});

test("an unusable slot answer is honest absence, never an unreadable inventory", () => {
  const h = harness({
    slotFor: (rowId) => {
      if (rowId === "throws") throw new Error("synthetic roster authority failure");
      if (rowId === "empty") return "";
      if (rowId === "wrong") return 42 as unknown as string;
      return undefined;
    },
  });
  for (const id of ["throws", "empty", "wrong", "plain"]) h.manager.addRow(id);
  const first = h.service.readInventorySnapshot();
  assert.ok(first, "a metadata read cannot make the inventory unreadable");
  for (const row of first.rows) {
    assert.equal(Object.prototype.hasOwnProperty.call(row, "rosterSlotId"), false,
      `${row.id} carries no invented slot`);
  }
  const second = h.service.readInventorySnapshot();
  assert.ok(second);
  assert.ok((second.revision) > first.revision, "the revision rule is unchanged by the slot read");
});

test("the same durable slot survives a regenerated runtime row id", () => {
  // The host's authority maps BOTH the retired row and its replacement to one
  // slot: the slot is the durable fact, the row id is the runtime fact.
  const slots = new Map<string, string | undefined>([["row-old", "slot-a"], ["row-new", "slot-a"]]);
  const h = harness({ slotFor: (rowId) => slots.get(rowId) });
  h.manager.addRow("row-old");
  h.manager.addRow("sibling");
  slots.set("sibling", "slot-b");
  const before = h.service.readInventorySnapshot();
  assert.deepEqual(slotsOf(before), { "row-old": "slot-a", sibling: "slot-b" });
  const beforeRun = before?.hostRunId;

  h.manager.replaceRow("row-old", "row-new");
  h.manager.emitChange("row-new");
  const watched = h.service.readInventorySnapshot();
  assert.deepEqual(slotsOf(watched), { "row-new": "slot-a", sibling: "slot-b" },
    "the replacement keeps the durable slot while the runtime row id changes");
  assert.equal(watched?.hostRunId, beforeRun, "one owner run throughout");
  assert.ok((watched?.revision ?? 0) > (before?.revision ?? 0));
});

test("conversation changes and replacements never move the slot", () => {
  const slots = new Map<string, string | undefined>([["row-1", "slot-a"]]);
  const h = harness({ slotFor: (rowId) => slots.get(rowId) });
  h.manager.addRow("row-1");
  assert.deepEqual(slotsOf(h.service.readInventorySnapshot()), { "row-1": "slot-a" });

  // An in-native /new changes the observed conversation identity of the SAME row.
  h.manager.setConversation("row-1", nativeSession("conversation-next", 2));
  h.manager.emitChange("row-1");
  const afterNew = h.service.readInventorySnapshot();
  assert.deepEqual(slotsOf(afterNew), { "row-1": "slot-a" });
  assert.deepEqual(afterNew?.rows[0]?.nativeSession, nativeSession("conversation-next", 2),
    "the conversation tuple is still the manager's own current fact");

  // A replacement row with a fresh id still reports the same slot.
  slots.set("row-2", "slot-a");
  h.manager.replaceRow("row-1", "row-2");
  h.manager.emitChange("row-2");
  assert.deepEqual(slotsOf(h.service.readInventorySnapshot()), { "row-2": "slot-a" });
});

test("a watch installed after a replacement sees the durable slot from its first snapshot", () => {
  const slots = new Map<string, string | undefined>([["row-2", "slot-a"], ["sibling", "slot-b"]]);
  const h = harness({ slotFor: (rowId) => slots.get(rowId) });
  h.manager.addRow("row-2");
  h.manager.addRow("sibling");
  const received: OwningHostInventorySnapshot[] = [];
  const watch = h.service.watchInventory((snapshot) => {
    if (snapshot !== undefined) received.push(snapshot);
  });
  assert.ok(watch);
  assert.deepEqual(slotsOf(watch.snapshot), { "row-2": "slot-a", sibling: "slot-b" });

  h.manager.setConversation("row-2", nativeSession("conversation-changed", 3));
  h.manager.emitChange("row-2");
  assert.ok(received.length >= 1, "the existing change hook still delivers");
  assert.deepEqual(slotsOf(received[received.length - 1]), { "row-2": "slot-a", sibling: "slot-b" });
  watch.unsubscribe();
  assert.deepEqual(h.service.readInventorySnapshot()?.rows.map((row) => row.rosterSlotId), ["slot-a", "slot-b"]);
});

test("the slot accessor is never consulted for a row the manager does not have", () => {
  const h = harness({ slotFor: () => "slot-a" });
  const empty = h.service.readInventorySnapshot();
  assert.ok(empty);
  assert.deepEqual(empty.rows, []);
  assert.deepEqual(h.slotReads, [], "a host with no rows reports no slots, not an empty slot for everything");
});

// ---------------------------------------------------------------------------
// The host-signalled re-observation (#477): a slot transfer settles in the
// HOST's authority after the manager change that already published the rows, so
// the host asks for one more guarded capture. No cache, no second listing path.
// ---------------------------------------------------------------------------

test("a host-signalled re-observation delivers the corrected slot to live watches", () => {
  const slots = new Map<string, string | undefined>([["row-1", "row-1"]]);
  const h = harness({ slotFor: (rowId) => slots.get(rowId) });
  h.manager.addRow("row-1");
  const delivered: OwningHostInventorySnapshot[] = [];
  const watch = h.service.watchInventory((snapshot) => {
    if (snapshot !== undefined) delivered.push(snapshot);
  });
  assert.ok(watch);
  const installed = watch.snapshot;
  assert.deepEqual(slotsOf(installed), { "row-1": "row-1" }, "the install snapshot carries the temporary slot");
  const listCallsBefore = h.manager.listCalls;

  // The host transfers the durable slot; no manager change follows.
  slots.set("row-1", "slot-a");
  const republished = h.service.notifyRosterAuthorityChange();
  assert.ok(republished, "the inventory is still observable");
  assert.deepEqual(slotsOf(republished), { "row-1": "slot-a" },
    "the re-observation re-reads the host's authority rather than replaying a cached row");
  assert.equal(republished.hostRunId, installed.hostRunId, "one owner run");
  assert.ok(republished.revision > installed.revision, "a strictly newer revision on the same run");
  assert.equal(delivered.length, 1, "the live watch receives exactly this one newer snapshot");
  assert.deepEqual(slotsOf(delivered[0]), { "row-1": "slot-a" });
  assert.equal(h.manager.listCalls, listCallsBefore + 1, "exactly one additional listing");
});

test("the re-observation captures nothing when no watch is live", () => {
  const slots = new Map<string, string | undefined>([["row-1", "slot-a"]]);
  const h = harness({ slotFor: (rowId) => slots.get(rowId) });
  h.manager.addRow("row-1");
  const listCallsBefore = h.manager.listCalls;
  assert.equal(h.service.notifyRosterAuthorityChange(), undefined);
  assert.equal(h.manager.listCalls, listCallsBefore, "no watcher means no listing and no revision");
  assert.deepEqual(h.slotReads, [], "and no slot read either");
});

test("the re-observation reports no inventory during teardown and never notifies", () => {
  const h = harness({ slotFor: () => "slot-a" });
  h.manager.addRow("row-1");
  const delivered: OwningHostInventorySnapshot[] = [];
  const watch = h.service.watchInventory((snapshot) => {
    if (snapshot !== undefined) delivered.push(snapshot);
  });
  assert.ok(watch);
  h.beginTeardown();
  assert.equal(h.service.notifyRosterAuthorityChange(), undefined);
  assert.deepEqual(delivered, [], "a closing host publishes no newer observation");
});

test("a retired watch is never notified by a later re-observation", () => {
  const slots = new Map<string, string | undefined>([["row-1", "slot-a"]]);
  const h = harness({ slotFor: (rowId) => slots.get(rowId) });
  h.manager.addRow("row-1");
  const delivered: OwningHostInventorySnapshot[] = [];
  const watch = h.service.watchInventory((snapshot) => {
    if (snapshot !== undefined) delivered.push(snapshot);
  });
  assert.ok(watch);
  watch.unsubscribe();
  watch.unsubscribe();
  assert.equal(h.service.notifyRosterAuthorityChange(), undefined, "no live watch is left");
  assert.deepEqual(delivered, []);
});
