import assert from "node:assert/strict";
import test from "node:test";

import type {
  CreateInstanceOptions,
  InstanceManagerOptions,
  NativeInstanceView,
  NativeViewerClipboardSink,
  NativeViewerInputRequest,
  NativeViewerInputResult,
  NativeViewerInputSource,
  SessionGeometry,
  SessionViewerState,
  SessionViewerUpdate,
  SessionViewerUpdateResult,
  ViewerOpenOptions,
} from "../src/session-host/instances";
import { FakeViewerSeam } from "./session-host-viewer-fakes";
import type { SessionHostNativeSession, SessionSpawnInput } from "../src/session-host/protocol";
import type { SavedSessionCatalog, SavedSessionRow } from "../src/session-host/saved-sessions";
import {
  createLocalOwningHostService,
  isDuplicateOwnedLaunchFailure,
  savedDeletionOwnedSessions,
  type OwningHostManager,
  type OwningHostService,
  type OwningHostViewerOptions,
} from "../src/session-host/owning-host-service";

/**
 * Focused unit coverage for the local owning-host service boundary (#473): the
 * UI-independent operations extracted out of the sidebar host. Everything here
 * is synthetic — no PTY, terminal, broker, listener, or real clipboard is ever
 * touched — and every assertion is about what the one manager was actually
 * asked to do and what the service was able to truthfully observe.
 */

function nativeSession(id: string): SessionHostNativeSession {
  return { sessionId: id, epoch: 1, name: `Conversation ${id}` };
}

function rowView(overrides: Partial<NativeInstanceView> & { id: string }): NativeInstanceView {
  return {
    label: `Row ${overrides.id}`,
    workspace: "/synthetic/row-workspace",
    agentDir: "/synthetic/agent",
    lifecycle: "alive",
    busy: null,
    pendingInput: null,
    inputSurface: false,
    nativeSession: nativeSession(`conversation-${overrides.id}`),
    hasLiveProcess: true,
    activity: [],
    ...overrides,
  };
}

/** A minimal synthetic manager surface: only facts and calls, never a process. */
class SyntheticManager {
  readonly receivedOptions: InstanceManagerOptions[] = [];
  views: NativeInstanceView[] = [];
  readonly createOptions: CreateInstanceOptions[] = [];
  nextId = 1;
  listThrows = false;
  listCalls = 0;
  /** Number of successful listings after which `list()` starts throwing. */
  listThrowsAfter = Number.POSITIVE_INFINITY;
  createError: Error | undefined;
  createGate: Promise<void> | undefined;
  /** When true, a successful create returns an id but publishes no row. */
  createPublishesRow = true;
  ownedThrows = false;
  hasLiveThrows = false;

  openManager(options: InstanceManagerOptions): void {
    this.receivedOptions.push(options);
  }

  list(): NativeInstanceView[] {
    this.listCalls += 1;
    if (this.listThrows || this.listCalls > this.listThrowsAfter) {
      throw new Error("synthetic listing failure");
    }
    return this.views.map((view) => ({ ...view, activity: [...view.activity] }));
  }

  async create(options: CreateInstanceOptions): Promise<string> {
    this.createOptions.push({ ...options });
    const id = `child-${this.nextId++}`;
    if (this.createGate) await this.createGate;
    if (this.createError !== undefined) throw this.createError;
    if (this.createPublishesRow) {
      this.views.push(rowView({ id, workspace: options.workspace, nativeSession: null, lifecycle: "alive" }));
    }
    return id;
  }

  ownedLiveSessions(): { id?: string }[] {
    if (this.ownedThrows) throw new Error("synthetic ownership failure");
    return [{ id: "owned-conversation" }];
  }

  hasLiveProcesses(): boolean {
    if (this.hasLiveThrows) throw new Error("synthetic liveness failure");
    return this.views.some((view) => view.hasLiveProcess);
  }

  surface(): undefined { return undefined; }
  write(): void { /* the service never writes child input */ }
  readonly resizeCalls: { cols: number; rows: number }[] = [];
  resize(cols: number, rows: number): void { this.resizeCalls.push({ cols, rows }); }
  closeExited(): boolean { return false; }

  /** #474 viewer seam: per-row geometry the fake actually holds, plus viewer facts. */
  readonly geometry = new Map<string, { cols: number; rows: number }>();
  readonly viewers = new FakeViewerSeam({
    isViewable: (id) => this.views.some((view) => view.id === id
      && view.hasLiveProcess
      && (view.lifecycle === "alive" || view.lifecycle === "starting")),
    read: (id) => this.geometry.get(id),
    apply: (id, cols, rows) => { this.geometry.set(id, { cols, rows }); },
  });

  openViewer(options?: ViewerOpenOptions): SessionViewerState {
    this.openViewerOptions.push(options);
    return this.viewers.openViewer();
  }

  /** What the strict viewer input seam was asked to do, in call order. */
  readonly openViewerOptions: (ViewerOpenOptions | undefined)[] = [];
  readonly viewerInputSources = new Map<string, NativeViewerInputSource>();
  readViewerInputSourceThrows = false;
  readViewerInputSourceCalls: string[] = [];
  readonly writeViewerInputCalls: { viewerId: string; request: NativeViewerInputRequest }[] = [];
  writeViewerInputResult: NativeViewerInputResult = { status: "submitted" };
  writeViewerInputThrows = false;

  readViewerInputSource(viewerId: string): NativeViewerInputSource | undefined {
    this.readViewerInputSourceCalls.push(viewerId);
    if (this.readViewerInputSourceThrows) throw new Error("synthetic input-source failure");
    return this.viewerInputSources.get(viewerId);
  }

  writeViewerInput(viewerId: string, request: NativeViewerInputRequest): NativeViewerInputResult {
    this.writeViewerInputCalls.push({ viewerId, request });
    if (this.writeViewerInputThrows) throw new Error("synthetic viewer write failure");
    return this.writeViewerInputResult;
  }

  /** A manager fixture that offers no viewer input seam at all. */
  withoutViewerInputSeam(): this {
    // Own properties shadow the prototype methods, so the seam is genuinely absent
    // for the service's capability check rather than merely throwing.
    Object.defineProperty(this, "readViewerInputSource", { value: undefined });
    Object.defineProperty(this, "writeViewerInput", { value: undefined });
    return this;
  }

  viewerState(viewerId: string): SessionViewerState | undefined { return this.viewers.viewerState(viewerId); }

  sessionViewers(sessionId: string): SessionViewerState[] { return this.viewers.sessionViewers(sessionId); }

  updateViewer(viewerId: string, update: SessionViewerUpdate): SessionViewerUpdateResult {
    return this.viewers.updateViewer(viewerId, update);
  }

  closeViewer(viewerId: string): boolean { return this.viewers.closeViewer(viewerId); }

  instanceGeometry(id: string): SessionGeometry | undefined { return this.viewers.instanceGeometry(id); }

  setInitialGeometry(cols: number, rows: number): void { this.viewers.setInitialGeometry(cols, rows); }
  async shutdown(): Promise<{ forcedIds: string[]; remainingIds: string[] }> {
    return { forcedIds: [], remainingIds: [] };
  }
  async dispose(): Promise<void> { /* nothing is owned by this fixture */ }

  asManager(): OwningHostManager {
    return this as unknown as OwningHostManager;
  }
}

interface Fixture {
  readonly manager: SyntheticManager;
  readonly service: OwningHostService;
  readonly opened: OwningHostManager[];
  beginTeardown(): void;
}

function fixture(overrides?: { manager?: SyntheticManager; open?: boolean }): Fixture {
  const manager = overrides?.manager ?? new SyntheticManager();
  let teardown = false;
  const opened: OwningHostManager[] = [];
  const service = createLocalOwningHostService({
    createManager: (options) => {
      const created = manager.asManager();
      manager.openManager(options);
      opened.push(created);
      return created;
    },
    teardownRequested: () => teardown,
  });
  if (overrides?.open !== false) service.openManager({ packageRoot: "/synthetic/package" } as InstanceManagerOptions);
  return {
    manager,
    service,
    opened,
    beginTeardown: () => { teardown = true; },
  };
}

function spawnRequest(): SessionSpawnInput {
  return {
    workspace: "/requested/existing/workspace",
    title: "Exact sibling title",
    prompt: "@/literal\n--session is prompt content\n",
  };
}

test("the service opens exactly one authoritative manager and refuses a second", () => {
  const harness = fixture();
  assert.equal(harness.manager.receivedOptions.length, 1);
  assert.equal(harness.service.manager, harness.opened[0]);

  assert.throws(
    () => harness.service.openManager({ packageRoot: "/synthetic/other" } as InstanceManagerOptions),
    /already owns a session manager/,
  );
  assert.equal(harness.manager.receivedOptions.length, 1, "a refused second open constructs no second manager");
  assert.equal(harness.service.manager, harness.opened[0], "the first manager stays authoritative");
});

test("an unopened service reports no manager and admits nothing", async () => {
  const harness = fixture({ open: false });
  assert.equal(harness.service.manager, undefined);
  assert.equal(harness.service.readRow("child-1"), undefined);
  assert.equal(await harness.service.spawnRequestedChild("parent-1", spawnRequest()), "failed");
  assert.deepEqual(await harness.service.startSession({ workspace: "/synthetic/workspace" }), {
    status: "unavailable",
  });
  assert.deepEqual(harness.manager.createOptions, [], "an unopened service starts no child");
});

test("an authenticated background child gets the exact workspace, title, and prompt", async () => {
  const manager = new SyntheticManager();
  manager.views = [rowView({ id: "parent-1", workspace: "/parent/workspace" })];
  const harness = fixture({ manager });
  const request = spawnRequest();

  assert.equal(await harness.service.spawnRequestedChild("parent-1", request), "started");
  assert.deepEqual(manager.createOptions, [{
    workspace: request.workspace,
    initialRequest: { title: request.title, prompt: request.prompt },
  }], "the explicit workspace/title/prompt are forwarded unchanged, with no defaults");
  assert.deepEqual(manager.views.map((view) => view.id), ["parent-1", "child-1"],
    "the sibling is an independent new row appended after the parent");
  assert.deepEqual(manager.views[0], rowView({ id: "parent-1", workspace: "/parent/workspace" }),
    "the requesting parent row is untouched");
});

test("a background child is refused for any parent that is not a live alive row", async () => {
  const cases: readonly (readonly [string, NativeInstanceView[]])[] = [
    ["unknown parent", []],
    ["exited parent", [rowView({ id: "parent-1", lifecycle: "exited", hasLiveProcess: false })]],
    ["unconfirmed parent", [rowView({ id: "parent-1", hasLiveProcess: false })]],
    ["starting parent", [rowView({ id: "parent-1", lifecycle: "starting" })]],
  ];
  for (const [name, views] of cases) {
    const manager = new SyntheticManager();
    manager.views = [...views];
    const harness = fixture({ manager });
    assert.equal(await harness.service.spawnRequestedChild("parent-1", spawnRequest()), "failed", name);
    assert.deepEqual(manager.createOptions, [], `${name} spawns no child`);
  }
});

test("a throwing parent listing refuses a background child without creating one", async () => {
  const manager = new SyntheticManager();
  manager.views = [rowView({ id: "parent-1" })];
  manager.listThrows = true;
  const harness = fixture({ manager });
  assert.equal(await harness.service.spawnRequestedChild("parent-1", spawnRequest()), "failed");
  assert.deepEqual(manager.createOptions, []);
});

test("teardown before or during a background create never claims a definite result", async () => {
  const manager = new SyntheticManager();
  manager.views = [rowView({ id: "parent-1" })];
  const harness = fixture({ manager });
  harness.beginTeardown();
  assert.equal(await harness.service.spawnRequestedChild("parent-1", spawnRequest()), "failed",
    "an admission request received after teardown starts is refused with no child");
  assert.deepEqual(manager.createOptions, []);

  const midManager = new SyntheticManager();
  midManager.views = [rowView({ id: "parent-1" })];
  let releaseCreate!: () => void;
  midManager.createGate = new Promise<void>((resolve) => { releaseCreate = resolve; });
  const mid = fixture({ manager: midManager });
  const pending = mid.service.spawnRequestedChild("parent-1", spawnRequest());
  mid.beginTeardown();
  releaseCreate();
  assert.equal(await pending, "unknown",
    "a create that completed while the host tore down may own a child; it is never reported as failed");
});

test("an unobservable background child is unknown, never a definite failure", async () => {
  const listingManager = new SyntheticManager();
  listingManager.views = [rowView({ id: "parent-1" })];
  listingManager.listThrowsAfter = 1;
  const listing = fixture({ manager: listingManager });
  assert.equal(await listing.service.spawnRequestedChild("parent-1", spawnRequest()), "unknown",
    "a create that succeeded but cannot be re-read is unknown");

  const vanishedManager = new SyntheticManager();
  vanishedManager.views = [rowView({ id: "parent-1" })];
  vanishedManager.createPublishesRow = false;
  const vanished = fixture({ manager: vanishedManager });
  assert.equal(await vanished.service.spawnRequestedChild("parent-1", spawnRequest()), "unknown",
    "a child id with no row is unknown, not a claimed failure");

  const refusedManager = new SyntheticManager();
  refusedManager.views = [rowView({ id: "parent-1" })];
  refusedManager.createError = new Error("synthetic launch refusal");
  const refused = fixture({ manager: refusedManager });
  assert.equal(await refused.service.spawnRequestedChild("parent-1", spawnRequest()), "failed",
    "a manager refusal is the only definite failure");

  const startingManager = new SyntheticManager();
  startingManager.views = [rowView({ id: "parent-1" })];
  startingManager.createPublishesRow = false;
  const starting = fixture({ manager: startingManager });
  startingManager.views.push(rowView({ id: "child-1", lifecycle: "starting", hasLiveProcess: false }));
  assert.equal(await starting.service.spawnRequestedChild("parent-1", spawnRequest()), "failed",
    "an unconfirmed launch is reported truthfully, not optimistically");

  const exitedManager = new SyntheticManager();
  exitedManager.views = [rowView({ id: "parent-1" })];
  exitedManager.createPublishesRow = false;
  const exited = fixture({ manager: exitedManager });
  exitedManager.views.push(rowView({
    id: "child-1", lifecycle: "exited", hasLiveProcess: false, exitCode: 2, nativeSession: null,
  }));
  assert.equal(await exited.service.spawnRequestedChild("parent-1", spawnRequest()), "started",
    "a positively confirmed exit is still a child that started");
});

test("startSession classifies what actually came up and never claims more", async () => {
  const started = fixture();
  assert.deepEqual(await started.service.startSession({ workspace: "/synthetic/workspace" }), {
    status: "started", id: "child-1",
  });
  assert.deepEqual(started.manager.createOptions, [{ workspace: "/synthetic/workspace" }]);

  for (const lifecycle of ["error", "starting"] as const) {
    const manager = new SyntheticManager();
    manager.createPublishesRow = false;
    const harness = fixture({ manager });
    manager.views.push(rowView({
      id: "child-1", lifecycle, hasLiveProcess: lifecycle === "starting", nativeSession: null,
    }));
    assert.deepEqual(await harness.service.startSession({ workspace: "/synthetic/workspace" }),
      { status: "not-ready" }, `a ${lifecycle} row is not a usable session`);
  }

  const missing = fixture();
  missing.manager.createPublishesRow = false;
  assert.deepEqual(await missing.service.startSession({ workspace: "/synthetic/workspace" }),
    { status: "not-ready" });

  const threw = fixture();
  threw.manager.createError = new Error("synthetic launch refusal");
  assert.deepEqual(await threw.service.startSession({ workspace: "/synthetic/workspace" }),
    { status: "failed" });

  const duplicate = fixture();
  duplicate.manager.createError = new Error("That saved conversation is already open in this host");
  assert.deepEqual(await duplicate.service.startSession({ workspace: "/synthetic/workspace" }),
    { status: "duplicate" });

  const unreadable = fixture();
  unreadable.manager.listThrowsAfter = 0;
  assert.deepEqual(await unreadable.service.startSession({ workspace: "/synthetic/workspace" }),
    { status: "failed" }, "an unreadable listing is never reported as a started session");

  const torn = fixture();
  let releaseCreate!: () => void;
  torn.manager.createGate = new Promise<void>((resolve) => { releaseCreate = resolve; });
  const pending = torn.service.startSession({ workspace: "/synthetic/workspace" });
  torn.beginTeardown();
  releaseCreate();
  assert.deepEqual(await pending, { status: "unavailable" },
    "a create that finished during teardown reports no result");

  const beforeStart = fixture();
  beforeStart.beginTeardown();
  assert.deepEqual(await beforeStart.service.startSession({ workspace: "/synthetic/workspace" }),
    { status: "unavailable" });
  assert.deepEqual(beforeStart.manager.createOptions, [], "teardown admits no new child");
});

test("the saved-conversation ownership fence keeps its unknown-binding evidence", () => {
  const known = new SyntheticManager();
  known.views = [rowView({ id: "row-1" })];
  assert.deepEqual(savedDeletionOwnedSessions(known.asManager()), [{ id: "owned-conversation" }],
    "a live row with an authenticated binding adds no unknown evidence");

  const unknown = new SyntheticManager();
  unknown.views = [rowView({ id: "row-1", nativeSession: null })];
  const snapshot = savedDeletionOwnedSessions(unknown.asManager());
  assert.equal(snapshot.length, 2);
  assert.deepEqual(snapshot[0], { id: "owned-conversation" });
  assert.deepEqual(snapshot[1], {}, "a live child with no current binding adds binding-free evidence");

  const settled = new SyntheticManager();
  settled.views = [rowView({ id: "row-1", lifecycle: "exited", hasLiveProcess: false, nativeSession: null })];
  assert.deepEqual(savedDeletionOwnedSessions(settled.asManager()), [{ id: "owned-conversation" }]);
});

test("deletion and admission preflight refuse instead of guessing when ownership is unreadable", () => {
  const catalog = { agentDir: "/synthetic/agent", rows: [] } as unknown as SavedSessionCatalog;
  const row = { id: "conversation-1", file: "/synthetic/agent/sessions/x.jsonl" } as unknown as SavedSessionRow;

  const ownershipFailure = fixture();
  ownershipFailure.manager.ownedThrows = true;
  assert.equal(ownershipFailure.service.validateSavedConversationDeletion(catalog, row), "unknown-live-binding");

  const listingFailure = fixture();
  listingFailure.manager.listThrows = true;
  assert.equal(listingFailure.service.validateSavedConversationDeletion(catalog, row), "unknown-live-binding");

  const unopened = fixture({ open: false });
  assert.equal(unopened.service.validateSavedConversationDeletion(catalog, row), "unknown-live-binding");

  // A refusal never mints an admission, whatever the reason.
  const refused = ownershipFailure.service.admitSavedConversation(catalog, row);
  assert.equal(refused.status, "refused");
  if (refused.status === "refused") assert.equal(refused.reason, "unknown-row");
  const unopenedAdmission = unopened.service.admitSavedConversation(catalog, row);
  assert.equal(unopenedAdmission.status, "refused");
});

// --- Guarded saved Resume/Delete boundary (manager-owned atomic primitives). ---

const guardedCatalog = { agentDir: "/synthetic/agent", rows: [] } as unknown as SavedSessionCatalog;
const guardedRow = { id: "conversation-1", file: "/synthetic/agent/sessions/p/x.jsonl" } as unknown as SavedSessionRow;

/** Attach stub guarded primitives to a synthetic manager and record each invocation. */
function withGuardedPrimitives(
  manager: SyntheticManager,
  primitives: {
    readonly start?: (guard: () => boolean) => unknown;
    readonly remove?: (guard: () => boolean) => unknown;
  },
): { readonly calls: string[] } {
  const calls: string[] = [];
  Object.assign(manager, {
    startSavedSession: async (_catalog: unknown, _row: unknown, guard: () => boolean): Promise<unknown> => {
      calls.push("start");
      return primitives.start?.(guard);
    },
    deleteSavedSession: (_catalog: unknown, _row: unknown, guard: () => boolean): unknown => {
      calls.push("delete");
      return primitives.remove?.(guard);
    },
  });
  return { calls };
}

test("guarded saved primitives are unavailable without the manager seam and never fall back to the nonatomic methods", async () => {
  for (const harness of [fixture(), fixture({ open: false })]) {
    let authorizeCalls = 0;
    const authorize = (): boolean => {
      authorizeCalls += 1;
      return true;
    };
    assert.deepEqual(await harness.service.startSavedConversation(guardedCatalog, guardedRow, authorize),
      { status: "refused", reason: "unavailable" });
    assert.deepEqual(harness.service.deleteSavedConversation(guardedCatalog, guardedRow, authorize),
      { status: "refused", reason: "unavailable" });
    assert.equal(authorizeCalls, 0, "no authorization is consulted for an unavailable seam");
    assert.deepEqual(harness.manager.createOptions, [], "no fallback to the nonatomic create path");
    assert.equal(harness.manager.listCalls, 0, "no fallback listing or ownership read");
  }
});

test("guarded saved primitives gate host teardown and the guard shape before any authorization", async () => {
  const manager = new SyntheticManager();
  const probe = withGuardedPrimitives(manager, {
    start: () => ({ status: "started", id: "child-1" }),
    remove: () => ({ status: "deleted", method: "trash" }),
  });
  const harness = fixture({ manager });
  const notCallable = undefined as unknown as () => boolean;
  assert.deepEqual(await harness.service.startSavedConversation(guardedCatalog, guardedRow, notCallable),
    { status: "refused", reason: "not-authorized" });
  assert.deepEqual(harness.service.deleteSavedConversation(guardedCatalog, guardedRow, notCallable),
    { status: "refused", reason: "not-authorized" });

  harness.beginTeardown();
  let authorizeCalls = 0;
  const authorize = (): boolean => {
    authorizeCalls += 1;
    return true;
  };
  assert.deepEqual(await harness.service.startSavedConversation(guardedCatalog, guardedRow, authorize),
    { status: "refused", reason: "unavailable" });
  assert.deepEqual(harness.service.deleteSavedConversation(guardedCatalog, guardedRow, authorize),
    { status: "refused", reason: "unavailable" });
  assert.equal(authorizeCalls, 0);
  assert.deepEqual(probe.calls, [], "neither primitive is invoked before the service's own gates pass");
});

test("the service guard wraps only its in-memory manager identity around the caller's exact authorization", async () => {
  const manager = new SyntheticManager();
  const seen: boolean[] = [];
  withGuardedPrimitives(manager, {
    start: (guard) => {
      seen.push(guard());
      return { status: "refused", reason: "not-authorized" };
    },
    remove: (guard) => {
      seen.push(guard());
      return { status: "refused", reason: "not-authorized" };
    },
  });
  const harness = fixture({ manager });
  await harness.service.startSavedConversation(guardedCatalog, guardedRow, () => true);
  await harness.service.startSavedConversation(guardedCatalog, guardedRow, () => false);
  await harness.service.startSavedConversation(guardedCatalog, guardedRow, () => {
    throw new Error("synthetic guard failure");
  });
  await harness.service.startSavedConversation(guardedCatalog, guardedRow, () => 1 as unknown as boolean);
  harness.service.deleteSavedConversation(guardedCatalog, guardedRow, () => true);
  harness.service.deleteSavedConversation(guardedCatalog, guardedRow, () => false);
  assert.deepEqual(seen, [true, false, false, false, true, false], "only an exact true authorizes; a throw refuses");
  assert.equal(manager.listCalls, 0, "the guard reads no listing or ownership callout");
  assert.deepEqual(manager.createOptions, []);
});

test("guarded saved outcomes are closed: malformed or throwing primitives are unknown, never refusals, and raw detail is dropped", async () => {
  const manager = new SyntheticManager();
  let nextStart: () => unknown = () => undefined;
  let nextRemove: () => unknown = () => undefined;
  withGuardedPrimitives(manager, { start: () => nextStart(), remove: () => nextRemove() });
  const harness = fixture({ manager });
  const startCases: readonly (readonly [() => unknown, unknown])[] = [
    [() => { throw new Error("raw /private/failure"); }, { status: "unknown" }],
    [() => undefined, { status: "unknown" }],
    [() => ({ status: "refused", reason: "bogus" }), { status: "unknown" }],
    [() => ({ status: "refused", reason: "replaced-file", error: "raw /private/path" }),
      { status: "refused", reason: "replaced-file" }],
    [() => ({ status: "started" }), { status: "unknown" }],
    [() => ({ status: "started", id: "child-9", error: "raw" }), { status: "started", id: "child-9" }],
    [() => ({ status: "duplicate", error: "raw" }), { status: "duplicate" }],
  ];
  for (const [result, expected] of startCases) {
    nextStart = result;
    assert.deepEqual(await harness.service.startSavedConversation(guardedCatalog, guardedRow, () => true), expected);
  }
  const removeCases: readonly (readonly [() => unknown, unknown])[] = [
    [() => { throw new Error("raw /private/failure"); }, { status: "unknown" }],
    [() => ({ status: "deleted", method: "rm" }), { status: "unknown" }],
    [() => ({ status: "deleted", method: "trash", error: "raw" }), { status: "deleted", method: "trash" }],
    [() => ({ status: "unconfirmed", trashInvoked: false, unlinkInvoked: false }), { status: "unknown" }],
    [() => ({ status: "unconfirmed", trashInvoked: true, unlinkInvoked: false, fallbackRefusal: "bogus" }),
      { status: "unknown" }],
    [() => ({ status: "unconfirmed", trashInvoked: true, unlinkInvoked: false, fallbackRefusal: "not-authorized", error: "raw" }),
      { status: "unconfirmed", trashInvoked: true, unlinkInvoked: false, fallbackRefusal: "not-authorized" }],
    [() => ({ status: "refused", reason: "unknown-live-binding", error: "raw" }),
      { status: "refused", reason: "unknown-live-binding" }],
  ];
  for (const [result, expected] of removeCases) {
    nextRemove = result;
    assert.deepEqual(harness.service.deleteSavedConversation(guardedCatalog, guardedRow, () => true), expected);
  }
});

test("a guarded Resume that started during teardown is unknown, while a guarded deletion is never suppressed", async () => {
  const startManager = new SyntheticManager();
  let startHarness!: Fixture;
  withGuardedPrimitives(startManager, {
    start: (guard) => {
      guard();
      startHarness.beginTeardown();
      return { status: "started", id: "child-1" };
    },
  });
  startHarness = fixture({ manager: startManager });
  assert.deepEqual(await startHarness.service.startSavedConversation(guardedCatalog, guardedRow, () => true),
    { status: "unknown" }, "a create that settled during teardown claims no result, as with startSession");

  const removeManager = new SyntheticManager();
  let removeHarness!: Fixture;
  withGuardedPrimitives(removeManager, {
    remove: (guard) => {
      guard();
      removeHarness.beginTeardown();
      return { status: "deleted", method: "unlink" };
    },
  });
  removeHarness = fixture({ manager: removeManager });
  assert.deepEqual(removeHarness.service.deleteSavedConversation(guardedCatalog, guardedRow, () => true),
    { status: "deleted", method: "unlink" }, "a completed native deletion is reported whatever changed afterwards");
});

test("the exited-row resume target is the exact confirmed exit and retained binding", () => {
  const manager = new SyntheticManager();
  manager.views = [rowView({
    id: "row-1",
    workspace: "/exited/workspace",
    lifecycle: "exited",
    hasLiveProcess: false,
    nativeSession: null,
    lastNativeSession: { sessionId: "retained-conversation", epoch: 4, name: "Retained", persistence: "saved" },
  })];
  const harness = fixture({ manager });
  assert.deepEqual(harness.service.readExitedResumeTarget("row-1"), {
    workspace: "/exited/workspace",
    binding: { sessionId: "retained-conversation", persistence: "saved" },
    epoch: 4,
  });

  const unknownPersistence = new SyntheticManager();
  unknownPersistence.views = [rowView({
    id: "row-1",
    lifecycle: "exited",
    hasLiveProcess: false,
    nativeSession: null,
    lastNativeSession: { sessionId: "retained-conversation", epoch: 1, name: "Retained" },
  })];
  const unknown = fixture({ manager: unknownPersistence });
  assert.deepEqual(unknown.service.readExitedResumeTarget("row-1"), {
    workspace: "/synthetic/row-workspace",
    binding: { sessionId: "retained-conversation", persistence: "unknown" },
    epoch: 1,
  }, "a missing persistence observation is unknown, never assumed unsaved");

  const live = fixture();
  live.manager.views = [rowView({
    id: "row-1",
    lastNativeSession: { sessionId: "retained-conversation", epoch: 1, name: "Retained" },
  })];
  assert.equal(live.service.readExitedResumeTarget("row-1"), undefined, "a live row is never a resume target");

  const unconfirmed = fixture();
  unconfirmed.manager.views = [rowView({
    id: "row-1",
    lifecycle: "exited",
    hasLiveProcess: true,
    nativeSession: null,
    lastNativeSession: { sessionId: "retained-conversation", epoch: 1, name: "Retained" },
  })];
  assert.equal(unconfirmed.service.readExitedResumeTarget("row-1"), undefined,
    "an exited row that still owns an unconfirmed process is never a resume target");

  const invalid = fixture();
  invalid.manager.views = [rowView({
    id: "row-1",
    lifecycle: "exited",
    hasLiveProcess: false,
    nativeSession: null,
    lastNativeSession: { sessionId: "retained-conversation", epoch: 0, name: "Retained" },
  })];
  assert.equal(invalid.service.readExitedResumeTarget("row-1"), undefined);

  const unreadable = fixture();
  unreadable.manager.views = [...invalid.manager.views];
  unreadable.manager.listThrows = true;
  assert.equal(unreadable.service.readExitedResumeTarget("row-1"), undefined,
    "a throwing listing is an unknown row, never a restart");
  assert.equal(unreadable.service.readRow("row-1"), undefined);
});

test("owned-child settlement requires a query that actually answered", () => {
  const settled = fixture();
  settled.manager.views = [
    rowView({ id: "row-1" }),
    rowView({ id: "row-2", lifecycle: "exited", hasLiveProcess: false }),
  ];
  assert.deepEqual(settled.service.observeOwnedChildSettlement(0), { settled: true, remaining: 1 },
    "a live-state listing that answered is positive evidence");

  const fallbackAnswered = fixture();
  fallbackAnswered.manager.listThrows = true;
  assert.deepEqual(fallbackAnswered.service.observeOwnedChildSettlement(0), { settled: true, remaining: 0 });
  fallbackAnswered.manager.views = [rowView({ id: "row-1" })];
  assert.deepEqual(fallbackAnswered.service.observeOwnedChildSettlement(0), { settled: true, remaining: 1 },
    "the fallback liveness answer turns an empty shutdown result into one unconfirmed child");
  assert.deepEqual(fallbackAnswered.service.observeOwnedChildSettlement(2), { settled: true, remaining: 2 },
    "the manager's own shutdown result is preserved when it already reported remainders");

  const unknown = fixture();
  unknown.manager.listThrows = true;
  unknown.manager.hasLiveThrows = true;
  assert.deepEqual(unknown.service.observeOwnedChildSettlement(1), { settled: false, remaining: 1 },
    "two unavailable queries give no positive settlement evidence");
  assert.deepEqual(unknown.service.observeOwnedChildSettlement(undefined), { settled: false, remaining: 0 });

  const noManager = fixture({ open: false });
  assert.deepEqual(noManager.service.observeOwnedChildSettlement(undefined), { settled: true, remaining: 0 },
    "a host that never opened a manager owns no child at all");
});

test("viewer facts and per-session geometry go to the one manager and resize nothing else", () => {
  const manager = new SyntheticManager();
  manager.views = [rowView({ id: "row-1" }), rowView({ id: "row-2" })];
  manager.geometry.set("row-1", { cols: 80, rows: 24 });
  manager.geometry.set("row-2", { cols: 80, rows: 24 });
  const harness = fixture({ manager });

  const viewer = harness.service.openViewer();
  assert.ok(viewer);
  assert.equal(viewer.sessionId, undefined, "a new surface displays no session yet");
  assert.deepEqual(harness.service.readSessionViewers("row-1"), [], "an untargeted surface is in no session's roster");

  assert.deepEqual(harness.service.updateViewer(viewer.viewerId, { sessionId: "row-1", cols: 100, rows: 40 }), {
    applied: true,
    state: { viewerId: viewer.viewerId, sessionId: "row-1", cols: 100, rows: 40, revision: 2 },
  });
  assert.deepEqual(harness.service.readSessionGeometry("row-1"), { cols: 100, rows: 40, revision: 1 });
  assert.deepEqual(harness.service.readSessionGeometry("row-2"), { cols: 80, rows: 24, revision: 0 },
    "a session nobody views keeps its own size");
  assert.deepEqual(manager.resizeCalls, [], "per-session geometry never takes the host-wide resize path");
  assert.deepEqual(manager.createOptions, [], "sizing a session starts no child");

  // A second surface on the same row lowers the shared canonical size.
  const other = harness.service.openViewer();
  assert.ok(other);
  harness.service.updateViewer(other.viewerId, { sessionId: "row-1", cols: 90, rows: 50 });
  assert.deepEqual(harness.service.readSessionGeometry("row-1"), { cols: 90, rows: 40, revision: 2 });
  assert.deepEqual(harness.service.readSessionViewers("row-1").map((state) => state.viewerId).sort(),
    [other.viewerId, viewer.viewerId].sort());

  // Closing both keeps the last canonical size; the row is never reset.
  harness.service.closeViewer(other.viewerId);
  harness.service.closeViewer(viewer.viewerId);
  assert.deepEqual(harness.service.readSessionGeometry("row-1"), { cols: 100, rows: 40, revision: 3 });

  // Initial-geometry adoption is the manager's rule for later rows only.
  harness.service.setInitialGeometry(132, 43);
  assert.deepEqual(manager.viewers.initial, { cols: 132, rows: 43 });
  assert.deepEqual(harness.service.readSessionGeometry("row-2"), { cols: 80, rows: 24, revision: 0 });
});

test("viewer operations refuse instead of guessing when there is no usable manager", () => {
  const closed = fixture({ open: false });
  assert.equal(closed.service.openViewer(), undefined);
  assert.equal(closed.service.readViewer("viewer-1"), undefined);
  assert.deepEqual(closed.service.readSessionViewers("row-1"), []);
  assert.deepEqual(closed.service.updateViewer("viewer-1", { sessionId: "row-1" }), {
    applied: false, reason: "unknown-viewer",
  });
  assert.equal(closed.service.closeViewer("viewer-1"), false);
  assert.equal(closed.service.readSessionGeometry("row-1"), undefined);
  closed.service.setInitialGeometry(120, 40);

  // Teardown admits no new surface, and no surface can retarget a finished row.
  const torn = fixture();
  const viewer = torn.service.openViewer();
  assert.ok(viewer);
  torn.beginTeardown();
  assert.equal(torn.service.openViewer(), undefined, "a host that is closing gains no new viewer");
  const manager = torn.manager;
  manager.views = [rowView({ id: "row-1", lifecycle: "exited", hasLiveProcess: false })];
  assert.deepEqual(torn.service.updateViewer(viewer.viewerId, { sessionId: "row-1", cols: 90, rows: 30 }), {
    applied: false, reason: "unknown-session",
  }, "a finished row is not a displayable content target");
  assert.deepEqual(manager.resizeCalls, []);
});

test("only the manager's own duplicate refusal reads as an already-owned conversation", () => {
  assert.equal(isDuplicateOwnedLaunchFailure(new Error("That saved conversation is already open in this host")), true);
  assert.equal(isDuplicateOwnedLaunchFailure(new Error("synthetic secret launch error")), false);
  assert.equal(isDuplicateOwnedLaunchFailure("already open in this host"), false);
  assert.equal(isDuplicateOwnedLaunchFailure(undefined), false);
});

const viewerModes = {
  kittyFlags: 0,
  applicationCursorKeys: false,
  applicationKeypad: false,
  bracketedPaste: false,
  mouseTracking: "none",
  modifyOtherKeys: 0,
  mouseEncoding: "default",
} as const;

const viewerSource = (hostRunId: string): NativeViewerInputSource => ({
  hostRunId,
  viewerId: "viewer-1",
  viewerRevision: 2,
  rowId: "row-1",
  nativeSession: { sessionId: "conversation-row-1", epoch: 3 },
  geometry: { cols: 80, rows: 24, revision: 1 },
  registrationIdentity: "registration-1",
  registrationGeneration: "generation-1",
  sourceToken: "nvs1.viewer-1.00000000000000000000000000000000",
});

test("viewer registration carries only the caller's own sink and always this host's run identity", () => {
  const harness = fixture();
  const snapshot = harness.service.readInventorySnapshot();
  assert.ok(snapshot, "an open host reports its own run identity");
  const sink: NativeViewerClipboardSink = () => undefined;
  const bound = harness.service.openViewer({ nativeClipboardSink: sink });
  assert.ok(bound);
  assert.equal(harness.manager.openViewerOptions.length, 1, "the manager is asked once");
  const options = harness.manager.openViewerOptions[0]!;
  assert.deepEqual(Object.keys(options).sort(), ["hostRunId", "nativeClipboardSink"]);
  assert.equal(options.hostRunId, snapshot.hostRunId, "the run identity is always the service's own");
  assert.equal(options.nativeClipboardSink, sink, "the surface keeps exactly its own copy sink");

  // A caller cannot choose the run identity: a supplied one is never forwarded, and
  // a second surface of the same host gets the same run.
  const other: NativeViewerClipboardSink = () => undefined;
  const hijack = { nativeClipboardSink: other, hostRunId: "someone-elses-run" } as OwningHostViewerOptions;
  assert.ok(harness.service.openViewer(hijack));
  const second = harness.manager.openViewerOptions[1]!;
  assert.equal(second.hostRunId, snapshot.hostRunId, "a foreign run identity never reaches the manager");
  assert.equal(second.nativeClipboardSink, other);

  // The no-argument registration is unchanged: the manager sees no options object at
  // all, so an ordinary display surface gains no scope, sink, or input path.
  assert.ok(harness.service.openViewer());
  assert.equal(harness.manager.openViewerOptions[2], undefined);
});

test("the service forwards the viewer input seam and adds only its own run fence", () => {
  const manager = new SyntheticManager();
  const harness = fixture({ manager });
  const runId = harness.service.readInventorySnapshot()!.hostRunId;
  const source = viewerSource(runId);
  manager.viewerInputSources.set("viewer-1", source);
  assert.deepEqual(harness.service.readViewerInputSource("viewer-1"), source,
    "the manager's own description is handed back unchanged");
  assert.deepEqual(manager.readViewerInputSourceCalls, ["viewer-1"]);

  const request: NativeViewerInputRequest = { expectedSource: source, expectedInputModes: viewerModes, data: "ls\r" };
  assert.deepEqual(harness.service.writeViewerInput("viewer-1", request), { status: "submitted" });
  assert.deepEqual(manager.writeViewerInputCalls, [{ viewerId: "viewer-1", request }],
    "the observed facts are forwarded unchanged, exactly once");

  // Only the run that minted a source may spend it, and the refusal happens before
  // the manager is consulted at all.
  assert.deepEqual(harness.service.writeViewerInput("viewer-1",
    { ...request, expectedSource: { ...source, hostRunId: "another-host-run" } }),
  { status: "refused", reason: "stale-source" }, "another host run's source is not spendable here");
  for (const bad of [
    {}, null, 7, "ls\r",
    { expectedSource: source },
    { expectedInputModes: viewerModes, data: "ls\r" },
    { expectedSource: source, expectedInputModes: viewerModes },
  ]) {
    assert.deepEqual(harness.service.writeViewerInput("viewer-1", bad as unknown as NativeViewerInputRequest),
      { status: "refused", reason: "invalid-input" }, `${JSON.stringify(bad)} is not a closed request`);
  }
  assert.equal(manager.writeViewerInputCalls.length, 1, "nothing refused here reached the manager");

  // The manager's own truthful outcomes pass through unchanged, and a handoff whose
  // result cannot be observed is an unknown outcome — never a claimed refusal, and
  // never retried.
  manager.writeViewerInputResult = { status: "refused", reason: "stale-input-modes" };
  assert.deepEqual(harness.service.writeViewerInput("viewer-1", request),
    { status: "refused", reason: "stale-input-modes" });
  manager.writeViewerInputResult = { status: "unknown" };
  assert.deepEqual(harness.service.writeViewerInput("viewer-1", request), { status: "unknown" });
  manager.writeViewerInputThrows = true;
  assert.deepEqual(harness.service.writeViewerInput("viewer-1", request), { status: "unknown" },
    "a throwing handoff is unknown, not a refusal");
  assert.equal(manager.writeViewerInputCalls.length, 4, "one call per attempt, never a retry");

  // A manager without the seam, a throwing read, a closing host, or no manager at
  // all is simply not an input path: nothing is inferred and no provider is invented.
  const bare = fixture({ manager: new SyntheticManager().withoutViewerInputSeam() });
  assert.equal(bare.service.readViewerInputSource("viewer-1"), undefined);
  assert.deepEqual(bare.service.writeViewerInput("viewer-1", request), { status: "refused", reason: "unavailable" });

  const throwingManager = new SyntheticManager();
  throwingManager.readViewerInputSourceThrows = true;
  const throwing = fixture({ manager: throwingManager });
  assert.equal(throwing.service.readViewerInputSource("viewer-1"), undefined,
    "a manager that cannot answer has no source, never a fabricated one");
  // This service owns its own host run, so its caller observes its own source.
  const throwingRequest: NativeViewerInputRequest = {
    expectedSource: viewerSource(throwing.service.readInventorySnapshot()!.hostRunId),
    expectedInputModes: viewerModes,
    data: "ls\r",
  };
  assert.deepEqual(throwing.service.writeViewerInput("viewer-1", throwingRequest), { status: "submitted" },
    "a read that cannot answer does not close the write seam, which stays the manager's to answer");
  assert.equal(throwingManager.writeViewerInputCalls.length, 1, "the write seam was consulted once");

  const torn = fixture();
  torn.beginTeardown();
  assert.equal(torn.service.readViewerInputSource("viewer-1"), undefined);
  assert.deepEqual(torn.service.writeViewerInput("viewer-1", request), { status: "refused", reason: "unavailable" },
    "a closing host takes no viewer input");
  assert.equal(torn.manager.writeViewerInputCalls.length, 0);

  const closed = fixture({ open: false });
  assert.equal(closed.service.readViewerInputSource("viewer-1"), undefined);
  assert.deepEqual(closed.service.writeViewerInput("viewer-1", request), { status: "refused", reason: "unavailable" });
  assert.equal(closed.service.openViewer({ nativeClipboardSink: () => undefined }), undefined);
});
