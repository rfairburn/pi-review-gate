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
  type OwningHostInventoryWatch,
  type OwningHostManager,
  type OwningHostService,
} from "../src/session-host/owning-host-service";

/**
 * Focused coverage for the authoritative inventory snapshot and watch on the
 * local owning-host service (#478). Everything here is synthetic — no PTY,
 * terminal, broker, listener, socket, or timer is ever touched — and every
 * assertion is about what the ONE manager was actually asked to do, what the
 * service could truthfully observe, and what a watcher was able to see.
 */

/** Writable form of one live manager row, for mutating the fixture's state. */
type MutableView = {
  -readonly [K in keyof NativeInstanceView]: NativeInstanceView[K] extends readonly (infer Item)[]
    ? Item[]
    : NativeInstanceView[K];
};

function nativeSession(id: string): SessionHostNativeSession {
  return { sessionId: id, epoch: 1, name: `Conversation ${id}` };
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

/**
 * A synthetic manager that behaves like the authoritative one in exactly the two
 * ways this seam depends on: it owns mutable row state, and it calls its single
 * change hook once after each change. Its `list()` deliberately hands out its
 * own live row references, so any isolation a snapshot enjoys must come from the
 * service copying them. `listReturnsDetachedViews` switches it to the production
 * shape — frozen views built from the current records — which is what makes a
 * change landing mid-listing observable as a genuinely older listing result, and
 * `listHook` publishes one real change from inside a listing in flight.
 */
class InventoryManager {
  readonly receivedOptions: InstanceManagerOptions[] = [];
  /** The manager's own mutable rows — the authoritative state in this fixture. */
  readonly rows: MutableView[] = [];
  /** Every manager operation other than `list()` that anyone attempted. */
  readonly otherCalls: string[] = [];
  listCalls = 0;
  listThrows = false;
  /** True once `list()` has returned detached frozen views instead of live rows. */
  listReturnsDetachedViews = false;
  /** Runs once, after the rows were read and before `list()` returns. */
  listHook: (() => void) | undefined;
  #hostChange: ((instanceId: string) => void) | undefined;

  openManager(options: InstanceManagerOptions): void {
    this.receivedOptions.push(options);
    this.#hostChange = options.onChange;
  }

  /** Mirror the manager's own notification path, including its containment. */
  emitChange(instanceId: string): void {
    try {
      this.#hostChange?.(instanceId);
    } catch {
      // The real manager contains host change-hook failures; so does this fixture.
    }
  }

  list(): NativeInstanceView[] {
    this.listCalls += 1;
    if (this.listThrows) throw new Error("synthetic listing failure");
    // Live references by default: a snapshot must not alias them.
    const views: NativeInstanceView[] = this.listReturnsDetachedViews
      ? this.rows.map((row) => Object.freeze({ ...row, activity: Object.freeze([...row.activity]) }))
      : [...this.rows];
    const hook = this.listHook;
    if (hook !== undefined) {
      // The rows this listing reports were already read: a change published here
      // is newer than what the caller is about to receive.
      this.listHook = undefined;
      hook();
    }
    return views;
  }

  // Row mutations stand in for the manager's real rename/status/create/remove
  // transitions: mutate the authoritative row, then notify once.
  addRow(id: string, overrides?: Partial<NativeInstanceView>): MutableView {
    const row = rowView({ id, ...overrides });
    this.rows.push(row);
    return row;
  }

  rename(id: string, label: string): void {
    this.#row(id).label = label;
  }

  setStatus(id: string, update: Partial<NativeInstanceView>): void {
    Object.assign(this.#row(id), update);
  }

  pushActivity(id: string, activity: string): void {
    this.#row(id).activity.push(activity);
  }

  removeRow(id: string): void {
    const index = this.rows.findIndex((row) => row.id === id);
    if (index >= 0) this.rows.splice(index, 1);
  }

  #row(id: string): MutableView {
    const row = this.rows.find((candidate) => candidate.id === id);
    if (!row) throw new Error(`synthetic row ${id} is missing`);
    return row;
  }

  // Everything below is recorded and never needed by the inventory seam.
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

interface Harness {
  readonly manager: InventoryManager;
  readonly service: OwningHostService;
  /** Ids the host's own manager change hook actually received. */
  readonly hostChanges: string[];
  readonly opened: OwningHostManager[];
  readonly registrar: StatusRegistrar;
  /** Make the host's own change hook throw, as a buggy host callback would. */
  failHostChanges(): void;
  beginTeardown(): void;
}

function harness(options: { open?: boolean; manager?: InventoryManager } = {}): Harness {
  const manager = options.manager ?? new InventoryManager();
  const registrar: StatusRegistrar = {
    register: () => { throw new Error("the inventory seam never registers a reporter"); },
  };
  const sidebarTitleColumns = (): number => 42;
  let teardown = false;
  let hostThrows = false;
  const hostChanges: string[] = [];
  const opened: OwningHostManager[] = [];
  const service = createLocalOwningHostService({
    createManager: (managerOptions) => {
      const created = manager.asManager();
      manager.openManager(managerOptions);
      opened.push(created);
      return created;
    },
    teardownRequested: () => teardown,
  });
  if (options.open !== false) {
    service.openManager({
      packageRoot: "/synthetic/package",
      piExecutable: "/synthetic/pi",
      statusRegistrar: registrar,
      cols: 100,
      rows: 30,
      getSidebarTitleColumns: sidebarTitleColumns,
      onChange: (instanceId: string) => {
        hostChanges.push(instanceId);
        if (hostThrows) throw new Error("synthetic host change failure");
      },
    } as InstanceManagerOptions);
  }
  return {
    manager,
    service,
    hostChanges,
    opened,
    registrar,
    failHostChanges: () => { hostThrows = true; },
    beginTeardown: () => { teardown = true; },
  };
}

/** Rows of one delivered snapshot, or undefined when it reported unavailable. */
function rowIds(snapshot: OwningHostInventorySnapshot | undefined): string[] | undefined {
  return snapshot?.rows.map((row) => row.id);
}

/** Assert one watcher's delivered revisions only ever move forward. */
function assertForward(revisions: readonly number[], what: string): void {
  assert.ok(revisions.length > 0, `${what}: expected at least one delivery`);
  for (let index = 1; index < revisions.length; index += 1) {
    assert.ok(Number.isSafeInteger(revisions[index]) && revisions[index] > revisions[index - 1],
      `${what}: revision ${revisions[index]} was delivered after ${revisions[index - 1]}`);
  }
}

/** `label@revision` for one delivered snapshot, for ordering assertions. */
function stamped(snapshot: OwningHostInventorySnapshot | undefined): string {
  return `${snapshot?.rows[0]?.label}@${snapshot?.revision}`;
}

test("the inventory observes the one manager the service opened and keeps the host's own hook", () => {
  const h = harness();
  assert.equal(h.opened.length, 1);
  assert.equal(h.service.manager, h.opened[0], "the inventory reads the host's authoritative manager");
  assert.equal(h.manager.receivedOptions.length, 1, "the inventory never opens a second manager");

  const received = h.manager.receivedOptions[0];
  assert.equal(received.packageRoot, "/synthetic/package");
  assert.equal(received.piExecutable, "/synthetic/pi");
  assert.equal(received.statusRegistrar, h.registrar, "every other manager option is forwarded unchanged");
  assert.equal(received.cols, 100);
  assert.equal(received.rows, 30);
  assert.equal(typeof received.getSidebarTitleColumns, "function");

  h.manager.addRow("row-1");
  h.manager.emitChange("row-1");
  assert.deepEqual(h.hostChanges, ["row-1"], "the host's own change hook still runs exactly once per change");

  const snapshot = h.service.readInventorySnapshot();
  assert.ok(snapshot);
  assert.deepEqual(rowIds(snapshot), ["row-1"]);
  assert.equal(h.manager.listCalls, 1, "one read is one listing: no retry, no polling, no second path");
  assert.deepEqual(h.manager.otherCalls, [], "a read touches no other manager operation");
});

test("installing a watch captures the current state and loses no change around the capture boundary", () => {
  const h = harness();
  h.manager.addRow("row-1", { label: "Before" });
  h.manager.emitChange("row-1");

  const seen: (OwningHostInventorySnapshot | undefined)[] = [];
  const watch = h.service.watchInventory((snapshot) => { seen.push(snapshot); });
  assert.ok(watch);
  assert.deepEqual(rowIds(watch.snapshot), ["row-1"]);
  assert.equal(watch.snapshot.rows[0]?.label, "Before");
  assert.equal(seen.length, 0, "the initial snapshot is returned, not re-delivered as a duplicate callback");
  assert.equal(h.manager.listCalls, 1, "installing a watch is one listing and one registration at once");

  // Each change mutates the authoritative row and then notifies, exactly as the
  // manager does for a rename, a status report, a create, and a removal.
  h.manager.rename("row-1", "Renamed");
  h.manager.emitChange("row-1");
  h.manager.setStatus("row-1", { busy: true, pendingInput: false, activeTasks: 2 });
  h.manager.emitChange("row-1");
  h.manager.addRow("row-2");
  h.manager.emitChange("row-2");
  h.manager.removeRow("row-2");
  h.manager.emitChange("row-2");

  assert.deepEqual(seen.map(rowIds), [["row-1"], ["row-1"], ["row-1", "row-2"], ["row-1"]],
    "every change after the capture boundary is observed in order, none silently lost");
  assert.deepEqual(seen.map((snapshot) => snapshot?.revision), [2, 3, 4, 5]);
  assert.equal(seen[0]?.rows[0]?.label, "Renamed");
  assert.equal(seen[1]?.rows[0]?.busy, true);
  assert.equal(seen[1]?.rows[0]?.activeTasks, 2);
  assert.equal(watch.snapshot.rows[0]?.label, "Before",
    "the snapshot handed to the watcher at install time is not live state");
  assert.deepEqual(h.hostChanges, ["row-1", "row-1", "row-1", "row-2", "row-2"],
    "the host's own hook still sees every change exactly once");
});

test("an unobservable inventory is unavailable, never an empty or idle one", () => {
  const unopened = harness({ open: false });
  assert.equal(unopened.service.readInventorySnapshot(), undefined, "no manager means no inventory");
  assert.equal(unopened.service.watchInventory(() => { /* not installed */ }), undefined);
  assert.equal(unopened.manager.receivedOptions.length, 0, "an unopened host opens nothing on demand");

  const h = harness();
  h.manager.listThrows = true;
  assert.equal(h.service.readInventorySnapshot(), undefined, "a throwing listing is unknown, not empty");
  assert.equal(h.service.watchInventory(() => { /* not installed */ }), undefined,
    "an unreadable inventory installs no watch");

  h.manager.listThrows = false;
  const seen: (OwningHostInventorySnapshot | undefined)[] = [];
  const watch = h.service.watchInventory((snapshot) => { seen.push(snapshot); });
  assert.ok(watch);
  assert.equal(watch.snapshot.rows.length, 0, "a host with genuinely zero rows is a valid snapshot");
  assert.ok(Number.isSafeInteger(watch.snapshot.revision) && watch.snapshot.revision >= 1);

  h.manager.listThrows = true;
  h.manager.emitChange("row-1");
  assert.equal(seen.length, 1, "a later listing failure notifies once");
  assert.equal(seen[0], undefined, "a later listing failure notifies unavailable, not idle or empty");

  h.manager.listThrows = false;
  h.manager.addRow("row-1");
  h.manager.emitChange("row-1");
  assert.equal(seen.length, 2);
  assert.deepEqual(rowIds(seen[1]), ["row-1"], "a readable listing resumes real observations");
  const resumed = seen[1];
  assert.ok(resumed);
  assert.ok(resumed.revision > watch.snapshot.revision);
});

test("a closing host reports no inventory and tells an existing watch", () => {
  const h = harness();
  h.manager.addRow("row-1");
  const seen: (OwningHostInventorySnapshot | undefined)[] = [];
  const watch = h.service.watchInventory((snapshot) => { seen.push(snapshot); });
  assert.ok(watch);

  h.beginTeardown();
  assert.equal(h.service.readInventorySnapshot(), undefined, "a closing host inventories nothing");
  assert.equal(h.service.watchInventory(() => { /* not installed */ }), undefined,
    "a closing host installs no new watch");
  h.manager.emitChange("row-1");
  assert.equal(seen.length, 1, "the closing host notifies the watch once");
  assert.equal(seen[0], undefined, "an existing watch is told the inventory became unavailable");
});

test("each host run has its own identity and strictly increasing revisions", () => {
  const first = harness();
  const second = harness();
  const firstSnapshot = first.service.readInventorySnapshot();
  const secondSnapshot = second.service.readInventorySnapshot();
  assert.ok(firstSnapshot && secondSnapshot);
  assert.notEqual(firstSnapshot.hostRunId, secondSnapshot.hostRunId,
    "two host instances never share a run identity");
  assert.notEqual(firstSnapshot.hostRunId, "");

  const recreated = harness();
  const recreatedSnapshot = recreated.service.readInventorySnapshot();
  assert.ok(recreatedSnapshot);
  assert.notEqual(recreatedSnapshot.hostRunId, firstSnapshot.hostRunId,
    "a recreated host never reuses an earlier run identity");

  const revisions: number[] = [firstSnapshot.revision];
  const watch = first.service.watchInventory((snapshot) => {
    if (snapshot !== undefined) revisions.push(snapshot.revision);
  });
  assert.ok(watch);
  revisions.push(watch.snapshot.revision);
  for (let index = 0; index < 8; index += 1) {
    first.manager.addRow(`row-${index}`);
    const read = first.service.readInventorySnapshot();
    assert.ok(read);
    revisions.push(read.revision);
    first.manager.emitChange(`row-${index}`);
    assert.equal(read.hostRunId, firstSnapshot.hostRunId, "the run identity never changes mid-run");
  }
  watch.unsubscribe();

  assert.ok(revisions.every((revision) => Number.isSafeInteger(revision) && revision >= 1),
    "revisions are monotonic safe integers");
  assert.deepEqual(revisions, [...new Set(revisions)], "no revision is ever reused");
  for (let index = 1; index < revisions.length; index += 1) {
    assert.ok(revisions[index] > revisions[index - 1], "delivered revisions never regress");
  }
  assert.notEqual(second.service.readInventorySnapshot()?.hostRunId, firstSnapshot.hostRunId,
    "reads on another host never consume this run's revisions");
});

test("unknown facts stay unknown and ownership counts stay separate from activity counts", () => {
  const h = harness();
  h.manager.addRow("row-1");
  const unknown = h.service.readInventorySnapshot();
  assert.ok(unknown);
  const unknownRow = unknown.rows[0];
  assert.ok(unknownRow);
  for (const field of ["busy", "pendingInput", "backgroundTasks", "backgroundShells",
    "activeTasks", "activeShells"] as const) {
    assert.equal(unknownRow[field], null, `${field} stays unknown, never idle or zero`);
  }
  assert.equal("exitCode" in unknownRow, false, "an absent optional fact is not invented");
  assert.equal("error" in unknownRow, false);

  h.manager.setStatus("row-1", {
    busy: false,
    pendingInput: true,
    backgroundTasks: 1,
    backgroundShells: 0,
    activeTasks: 3,
    activeShells: 2,
  });
  const known = h.service.readInventorySnapshot();
  assert.ok(known);
  const knownRow = known.rows[0];
  assert.ok(knownRow);
  assert.equal(knownRow.busy, false);
  assert.equal(knownRow.pendingInput, true, "observed pending input is never flattened into busy");
  assert.equal(knownRow.backgroundTasks, 1, "OWNERSHIP counts keep their own values");
  assert.equal(knownRow.backgroundShells, 0, "an observed zero ownership count stays zero, distinct from unknown");
  assert.equal(knownRow.activeTasks, 3, "ACTIVITY counts stay independent of the ownership pair");
  assert.equal(knownRow.activeShells, 2);

  const exited = harness();
  exited.manager.addRow("row-9", {
    lifecycle: "exited", hasLiveProcess: false, exitCode: 3, nativeSession: null,
  });
  const exitedSnapshot = exited.service.readInventorySnapshot();
  assert.ok(exitedSnapshot);
  assert.equal(exitedSnapshot.rows[0]?.exitCode, 3, "an observed exit code is preserved");
  assert.equal(exitedSnapshot.rows[0]?.hasLiveProcess, false);
  assert.equal(exitedSnapshot.rows[0]?.nativeSession, null, "an unknown binding stays null");
});

test("snapshot rows are immutable copies isolated from later manager mutation", () => {
  const h = harness();
  h.manager.addRow("row-1", { label: "Original", activity: ["step-one"] });
  const snapshot = h.service.readInventorySnapshot();
  assert.ok(snapshot);

  h.manager.rename("row-1", "Mutated");
  h.manager.pushActivity("row-1", "later-step");

  assert.equal(snapshot.rows[0]?.label, "Original", "a delivered snapshot never aliases live manager rows");
  assert.deepEqual(snapshot.rows[0]?.activity, ["step-one"]);
  assert.ok(Object.isFrozen(snapshot) && Object.isFrozen(snapshot.rows));
  assert.ok(Object.isFrozen(snapshot.rows[0]) && Object.isFrozen(snapshot.rows[0]?.activity));
  assert.throws(() => { (snapshot.rows[0] as MutableView).label = "rewrite"; }, TypeError);
  assert.throws(() => { (snapshot.rows as NativeInstanceView[]).push(rowView({ id: "injected" })); }, TypeError);

  const later = h.service.readInventorySnapshot();
  assert.ok(later);
  assert.equal(later.rows[0]?.label, "Mutated", "a fresh read still sees the manager's real state");
  assert.deepEqual(later.rows[0]?.activity, ["step-one", "later-step"]);
  assert.ok(later.revision > snapshot.revision);
});

test("watcher failures never reach another watcher, the host hook, or a session", () => {
  const h = harness();
  h.manager.addRow("row-1");
  const seen: string[] = [];
  const throwing = h.service.watchInventory(() => { throw new Error("watcher failure"); });
  const survivor = h.service.watchInventory((snapshot) => { seen.push(snapshot === undefined ? "unavailable" : "snapshot"); });
  assert.ok(throwing && survivor);

  assert.doesNotThrow(() => h.manager.emitChange("row-1"));
  assert.deepEqual(seen, ["snapshot"], "a throwing watcher cannot starve another watcher");
  assert.deepEqual(h.hostChanges, ["row-1"], "a throwing watcher cannot skip the host's own hook");
  assert.deepEqual(h.manager.otherCalls, [], "losing a watch never stops, closes, or restarts a session");

  // A host hook that throws keeps the manager's own containment and still notifies.
  h.failHostChanges();
  const later: string[] = [];
  const third = h.service.watchInventory(() => { later.push("notified"); });
  assert.ok(third);
  assert.doesNotThrow(() => h.manager.emitChange("row-1"),
    "the host hook's exception stays contained by the manager, as before this seam existed");
  assert.deepEqual(later, ["notified"]);
  assert.deepEqual(h.hostChanges, ["row-1", "row-1"], "the host hook is still invoked, once per change");
});

test("unsubscribe is idempotent, immediate, and cannot resurrect a retired watch", () => {
  const h = harness();
  h.manager.addRow("row-1");
  const retired: number[] = [];
  const watch = h.service.watchInventory((snapshot) => { retired.push(snapshot?.revision ?? -1); });
  assert.ok(watch);
  h.manager.emitChange("row-1");
  assert.equal(retired.length, 1);

  watch.unsubscribe();
  watch.unsubscribe();
  h.manager.emitChange("row-1");
  assert.equal(retired.length, 1, "a retired watch is never notified again, and never revived");

  const kept: number[] = [];
  const other = h.service.watchInventory((snapshot) => { kept.push(snapshot?.revision ?? -1); });
  assert.ok(other);
  h.manager.emitChange("row-1");
  assert.equal(kept.length, 1);
  assert.ok(kept[0] > retired[0], "a watch installed later never reuses an earlier revision");

  other.unsubscribe();
  const quiet = h.manager.listCalls;
  h.manager.emitChange("row-1");
  assert.equal(h.manager.listCalls, quiet, "with no live watch left, change notifications capture nothing");
});

test("reentrant subscribe and unsubscribe during a delivery cannot duplicate or resurrect", () => {
  const h = harness();
  h.manager.addRow("row-1");
  const delivered: string[] = [];
  let late: OwningHostInventoryWatch | undefined;
  let second: OwningHostInventoryWatch | undefined;

  const first = h.service.watchInventory((snapshot) => {
    delivered.push(`first:${snapshot?.revision ?? "unavailable"}`);
    if (late === undefined) {
      late = h.service.watchInventory((next) => { delivered.push(`late:${next?.revision ?? "unavailable"}`); });
    }
    second?.unsubscribe();
  });
  second = h.service.watchInventory((snapshot) => {
    delivered.push(`second:${snapshot?.revision ?? "unavailable"}`);
  });
  assert.ok(first && second);

  h.manager.emitChange("row-1");
  // Revisions: first install, second install, this change, the watch created
  // inside the callback, then the next change.
  const base = first.snapshot.revision;
  assert.equal(second.snapshot.revision, base + 1);
  assert.deepEqual(delivered, [`first:${base + 2}`],
    "a watch retired mid-delivery is not emitted, and a watch created during delivery keeps only its own initial snapshot");
  assert.ok(late);
  assert.equal(late.snapshot.revision, base + 3, "a watch created inside a callback starts from a newer capture");

  delivered.length = 0;
  h.manager.emitChange("row-1");
  assert.deepEqual(delivered, [`first:${base + 4}`, `late:${base + 4}`],
    "later deliveries reach the live watches only, with one shared capture per change");
  first.unsubscribe();
  late.unsubscribe();
});

test("with no watchers, ordinary change notifications allocate no snapshot", () => {
  const h = harness();
  h.manager.addRow("row-1");
  const before = h.manager.listCalls;
  for (let index = 0; index < 25; index += 1) h.manager.emitChange("row-1");
  assert.equal(h.manager.listCalls, before, "terminal-output-style churn lists nothing while nobody watches");
  assert.equal(h.hostChanges.length, 25, "the host's own refresh path is unaffected");

  const watch = h.service.watchInventory(() => { /* observes one change */ });
  assert.ok(watch);
  h.manager.emitChange("row-1");
  const afterOneChange = h.manager.listCalls;
  assert.equal(afterOneChange, before + 2, "install plus one change is two listings, no more");
  watch.unsubscribe();
  h.manager.emitChange("row-1");
  assert.equal(h.manager.listCalls, afterOneChange, "a retired watch stops capturing");
});

test("the inventory seam reads rows and activates nothing else", () => {
  const h = harness();
  h.manager.addRow("row-1");
  const watch = h.service.watchInventory(() => { /* no assertions here */ });
  assert.ok(watch);
  h.manager.emitChange("row-1");
  h.service.readInventorySnapshot();
  watch.unsubscribe();

  assert.deepEqual(h.manager.otherCalls, [],
    "no create, write, resize, viewer, stop, shutdown, or dispose path is taken");
  assert.equal(h.opened.length, 1, "the inventory is an observation of the one manager, never a second authority");
});

test("a non-callable listener is refused instead of silently watching nothing", () => {
  const h = harness();
  h.manager.addRow("row-1");
  assert.throws(
    () => h.service.watchInventory(undefined as unknown as () => void),
    /requires a listener function/,
  );
  assert.equal(h.service.readInventorySnapshot()?.rows.length, 1,
    "the refusal installs no watch and leaves the real inventory readable");
});

test("a watcher that mutates the manager during delivery cannot hand a later watcher older rows", () => {
  const h = harness();
  h.manager.addRow("row-1", { label: "Initial" });
  const mutatingSeen: string[] = [];
  const observerSeen: string[] = [];
  let mutatedOnce = false;
  const mutating = h.service.watchInventory((snapshot) => {
    mutatingSeen.push(stamped(snapshot));
    if (mutatedOnce) return;
    mutatedOnce = true;
    // One guarded mutation: the manager publishes a real change synchronously
    // while the notification that delivered it is still in flight.
    h.manager.rename("row-1", "Nested");
    h.manager.emitChange("row-1");
  });
  const observer = h.service.watchInventory((snapshot) => {
    observerSeen.push(stamped(snapshot));
  });
  assert.ok(mutating && observer);

  h.manager.rename("row-1", "Outer");
  h.manager.emitChange("row-1");

  assert.deepEqual(mutatingSeen, ["Outer@3", "Nested@4"]);
  assert.deepEqual(observerSeen, ["Outer@3", "Nested@4"],
    "the nested change is retained and delivered after the in-flight notification, never over it");
  assertForward(mutatingSeen.map((entry) => Number(entry.split("@")[1])), "mutating watcher");
  assertForward(observerSeen.map((entry) => Number(entry.split("@")[1])), "observing watcher");
  assert.ok(observerSeen[observerSeen.length - 1]?.startsWith("Nested@"),
    "every watcher ends on the newest rows, not on the rows the in-flight delivery carried");
  assert.deepEqual(h.hostChanges, ["row-1", "row-1"],
    "each manager change still reaches the host's own hook exactly once, retained ones included");
  assert.equal(h.service.readInventorySnapshot()?.rows[0]?.label, "Nested");
});

test("a watcher that mutates on every notification stays bounded and never repeats a revision", () => {
  const h = harness();
  h.manager.addRow("row-1", { label: "Initial" });
  const storm: number[] = [];
  let mutations = 0;
  const pathological = h.service.watchInventory((snapshot) => {
    if (snapshot !== undefined) storm.push(snapshot.revision);
    // Pathological consumer: mutates the authoritative manager on every notice.
    mutations += 1;
    h.manager.setStatus("row-1", { label: `pass-${mutations}` });
    h.manager.emitChange("row-1");
  });
  assert.ok(pathological);
  assert.doesNotThrow(() => h.manager.emitChange("row-1"),
    "one manager change cannot trap the host inside watch delivery");

  assert.ok(mutations > 1, "the watcher-driven feedback really started");
  assert.ok(storm.length <= 9, `re-delivery stays bounded (${storm.length} deliveries)`);
  assert.equal(mutations, storm.length,
    "every delivery caused exactly one further mutation, so the bound is what stopped the loop");
  assertForward(storm, "pathological watcher");

  // The bounded drain stops with the newest change still retained, and that
  // retained observation is delivered forward rather than dropped.
  const retainedLabel = `pass-${mutations}`;
  pathological.unsubscribe();
  const catchUp: string[] = [];
  const settled: number[] = [];
  const watcher = h.service.watchInventory((snapshot) => {
    if (snapshot === undefined) return;
    settled.push(snapshot.revision);
    catchUp.push(String(snapshot.rows[0]?.label));
  });
  assert.ok(watcher);
  assert.deepEqual(catchUp, [retainedLabel],
    "the observation the bounded drain retained reaches the next watch instead of being lost");
  assert.ok(settled[0] > (storm[storm.length - 1] ?? 0), "and it is delivered as a newer capture");
  h.manager.setStatus("row-1", { label: "settled" });
  h.manager.emitChange("row-1");
  assert.equal(catchUp[catchUp.length - 1], "settled", "delivery keeps moving to the newest rows");
  assertForward(settled, "catch-up watcher");
});

test("a change published while the install capture is listing reaches the new watch", () => {
  const h = harness();
  h.manager.addRow("row-1", { label: "Before" });
  const existingSeen: string[] = [];
  const existing = h.service.watchInventory((snapshot) => {
    if (snapshot !== undefined) existingSeen.push(stamped(snapshot));
  });
  assert.ok(existing);

  // The listing reads its rows, a real change lands before it returns, and the
  // caller is about to receive rows that are already older.
  h.manager.listReturnsDetachedViews = true;
  const listingsBefore = h.manager.listCalls;
  h.manager.listHook = () => {
    h.manager.rename("row-1", "During");
    h.manager.emitChange("row-1");
  };
  const installedSeen: string[] = [];
  const installed = h.service.watchInventory((snapshot) => {
    if (snapshot !== undefined) installedSeen.push(stamped(snapshot));
  });
  assert.ok(installed);

  assert.equal(installed.snapshot.rows[0]?.label, "Before",
    "the install snapshot is exactly the state that listing read, not a later one");
  assert.equal(installed.snapshot.revision, existing.snapshot.revision + 1);
  assert.deepEqual(installedSeen, [`During@${installed.snapshot.revision + 1}`],
    "the retained change is the new watch's first notification, with a strictly newer revision and the newer rows");
  assert.deepEqual(existingSeen, [`During@${installed.snapshot.revision + 1}`],
    "the existing watch is told once, and never with rows older than what it already saw");
  assert.equal(h.manager.listCalls, listingsBefore + 2,
    "one listing for the install capture and one for the retained delivery: no retry loop");
  assert.deepEqual(h.hostChanges, ["row-1"], "the capture-time change reaches the host hook exactly once");
  assert.equal(h.service.readInventorySnapshot()?.rows[0]?.label, "During");
});

test("a capture attempted inside an unfinished listing is unavailable, never an overlapping observation", () => {
  const h = harness();
  h.manager.addRow("row-1", { label: "Before" });
  h.manager.listReturnsDetachedViews = true;
  const observed: string[] = [];
  let nestedReadAttempted = false;
  let nestedRead: OwningHostInventorySnapshot | undefined;
  let nestedWatchAttempted = false;
  let nestedWatch: OwningHostInventoryWatch | undefined;
  h.manager.listHook = () => {
    // The authoritative rows move forward while the outer listing is still in
    // flight, and that same listing is then asked for a second, overlapping
    // capture — mutation first, so the nested request would read newer rows.
    h.manager.rename("row-1", "During");
    h.manager.emitChange("row-1");
    nestedReadAttempted = true;
    nestedRead = h.service.readInventorySnapshot();
    nestedWatchAttempted = true;
    nestedWatch = h.service.watchInventory(() => {
      assert.fail("an unavailable nested watch must not be installed");
    });
  };
  const installed = h.service.watchInventory((snapshot) => {
    if (snapshot !== undefined) observed.push(stamped(snapshot));
  });
  assert.ok(installed);
  assert.ok(nestedReadAttempted && nestedWatchAttempted, "the nested requests really ran mid-listing");

  assert.equal(nestedRead, undefined, "a nested read reports transient unavailability, not overlapping rows");
  assert.equal(nestedWatch, undefined, "a nested watch installs nothing while a listing is in flight");
  assert.equal(installed.snapshot.revision, 1);
  assert.equal(installed.snapshot.rows[0]?.label, "Before",
    "the only published capture is the one that actually completed its listing");
  assert.deepEqual(observed, ["During@2"], "the retained change follows the install snapshot, never older rows stamped newer");

  const after = h.service.readInventorySnapshot();
  assert.ok(after);
  assert.equal(after.revision, 3, "exactly one revision per published capture, with none consumed by the refused attempts");
  assert.equal(after.rows[0]?.label, "During", "the run keeps reporting the newest state");
});

test("a change published during a plain read still notifies live watches", () => {
  const h = harness();
  h.manager.addRow("row-1", { label: "Before" });
  const seen: string[] = [];
  const watch = h.service.watchInventory((snapshot) => {
    if (snapshot !== undefined) seen.push(stamped(snapshot));
  });
  assert.ok(watch);

  h.manager.listReturnsDetachedViews = true;
  h.manager.listHook = () => {
    h.manager.rename("row-1", "During");
    h.manager.emitChange("row-1");
  };
  const read = h.service.readInventorySnapshot();
  assert.ok(read);
  assert.equal(read.rows[0]?.label, "Before", "the read reports exactly what its own listing read");
  assert.deepEqual(seen, [`During@${read.revision + 1}`],
    "the change retained during the read is delivered once the read unwinds, never as an older snapshot");
  assert.deepEqual(h.hostChanges, ["row-1"], "the retained change reaches the host hook exactly once");
  assert.equal(h.service.readInventorySnapshot()?.rows[0]?.label, "During");
});

test("a finite reentrant chain delivers its final change beyond the synchronous bound", async () => {
  const h = harness();
  h.manager.addRow("row-1", { label: "Initial" });
  const delivered: number[] = [];
  const labels: string[] = [];
  let mutations = 0;
  const mutator = h.service.watchInventory((snapshot) => {
    if (snapshot === undefined || mutations >= 9) return;
    mutations += 1;
    h.manager.rename("row-1", `pass-${mutations}`);
    h.manager.emitChange("row-1");
  });
  const observer = h.service.watchInventory((snapshot) => {
    if (snapshot === undefined) return;
    delivered.push(snapshot.revision);
    labels.push(String(snapshot.rows[0]?.label));
  });
  assert.ok(mutator && observer);
  try {
    h.manager.emitChange("row-1");
    assert.ok(delivered.length <= 9,
      `the synchronous bound still holds per manager event (${delivered.length} deliveries)`);
    assert.notEqual(labels[labels.length - 1], "pass-9",
      "the bounded pass stopped before the chain reached its end");

    // No further manager event, read, or subscription: the retained final change
    // arrives on its own one-shot continuation.
    await new Promise<void>((resolve) => setImmediate(resolve));

    assert.equal(mutations, 9, "the finite chain ran to its real end");
    assert.equal(labels[labels.length - 1], "pass-9",
      "the final observed change is delivered rather than stranded one mutation behind");
    assertForward(delivered, "finite-chain observer");
  } finally {
    mutator.unsubscribe();
    observer.unsubscribe();
  }
});
