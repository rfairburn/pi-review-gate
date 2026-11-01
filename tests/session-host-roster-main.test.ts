import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import type { Writable } from "node:stream";
import test from "node:test";

import type { ComposedHostFrame } from "../src/session-host/compositor";
import type {
  InstanceManagerOptions,
  NativeInstanceView,
  SessionGeometry,
  SessionViewerState,
  SessionViewerUpdate,
  SessionViewerUpdateResult,
  ShutdownResult,
  StopInstanceResult,
} from "../src/session-host/instances";
import { FakeViewerSeam } from "./session-host-viewer-fakes";
import type { SessionHostFrameWriterOptions } from "../src/session-host/frame-writer";
import type { StatusBroker } from "../src/session-host/broker";
import type { ProfilePreparer } from "../src/session-host/profiles";
import { SidebarController } from "../src/session-host/sidebar";
import { listSavedSessions, type SavedSessionCatalog } from "../src/session-host/saved-sessions";
import type { SessionHostNativeSession } from "../src/session-host/protocol";
import type { TerminalFrame, TerminalInputModes } from "../src/session-host/terminal-surface";
import {
  ROSTER_STORE_VERSION,
  hostOwnershipPath,
  isLocalRosterEntry,
  readRosterStore,
  writeRosterStore,
  type RosterEntry,
  type StoredRoster,
} from "../src/session-host/roster-store";
import { __test, type SessionHostOptions } from "../src/session-host/main";
import {
  createLocalOwningHostService,
  type OwningHostInventorySnapshot,
  type OwningHostService,
} from "../src/session-host/owning-host-service";
import { toRemoteSessionMetadata, type RemoteSessionMetadata } from "../src/session-host/network/roster-metadata";
import type { PeerCoordinator, PeerUiHost, PeerUiSnapshot } from "../src/session-host/peer-ui-protocol";
import type { PeerCoordinatorOptions } from "../src/session-host/network/peer-coordinator";

/**
 * Focused hermetic Main-level tests for the global sidebar roster (#331 and the
 * mixed local/remote order of #477).
 *
 * Main is driven through the internal `__test.runWithDependencies` seam with a
 * fake manager, but the roster store, exclusive ownership record, and saved
 * conversation catalog are the REAL implementations against a fresh temporary
 * Pi agent directory under an owned temporary root outside the checkout. No real
 * user agent data, lock, or saved conversation is ever read, written, or removed.
 */

const ESC = "\x1b";
const ALT_LEFT = `${ESC}[1;3D`;
const ALT_RIGHT = `${ESC}[1;3C`;
const ENTER = "\r";
const DELETE = `${ESC}[3~`;
const UP = `${ESC}[A`;
const DOWN = `${ESC}[B`;
const SCRATCH_ROOT = join(realpathSync(tmpdir()), "prg-session-host-roster-main-tests");
const SESSION_TIMESTAMP = "2025-01-01T00:00:00.000Z";

function makeRoot(prefix: string): string {
  mkdirSync(SCRATCH_ROOT, { recursive: true });
  return realpathSync(mkdtempSync(join(SCRATCH_ROOT, `${prefix}-`)));
}

/**
 * The remembered LOCAL slots of one persisted roster, in the document's one
 * ordered sequence (#477). Remote placement entries carry presentation identity
 * only and are deliberately excluded here.
 */
function rememberedSlots(roster: StoredRoster | undefined): RosterEntry[] {
  return roster === undefined ? [] : roster.entries.filter(isLocalRosterEntry);
}

function nextTurn(): Promise<void> {
  return new Promise<void>((resolve) => setImmediate(resolve));
}

class FakeInput extends EventEmitter {
  readonly isTTY = true;
  readableEnded = false;
}

class FakeOutput extends EventEmitter {
  readonly isTTY = true;
  columns = 80;
  rows = 24;
  write(): boolean { return true; }
}

class FakeTerminal {
  kittyProtocolActive = false;
  modifyOtherKeysActive = false;
  columns = 100;
  rows = 40;
  started = false;
  inputHandler?: (data: string) => void;
  resizeHandler?: () => void;

  start(onInput: (data: string) => void, onResize: () => void): void {
    this.inputHandler = onInput;
    this.resizeHandler = onResize;
    this.started = true;
  }

  emitInput(data: string): void { this.inputHandler?.(data); }
  write(): void {}
  async drainInput(): Promise<void> {}
  stop(): void { this.started = false; }
}

class FakeObserver {
  flags = 0;
  disposed = false;
  waitCalls = 0;
  onChange?: (flags: number) => void;
  private resolveWait?: (flags: number) => void;

  constructor(options: { onChange?: (flags: number) => void } = {}) { this.onChange = options.onChange; }
  feed(): void {}
  wait(): Promise<number> {
    this.waitCalls += 1;
    return new Promise((resolve) => { this.resolveWait = resolve; });
  }
  settle(flags = this.flags): void {
    this.flags = flags;
    this.resolveWait?.(flags);
  }
  dispose(): void {
    this.disposed = true;
    this.resolveWait?.(this.flags);
  }
}

class FakeWriter {
  started = false;
  closed = false;
  readonly frames: { frame: ComposedHostFrame; cols: number; rows: number }[] = [];
  start(): void { this.started = true; }
  submit(frame: ComposedHostFrame, cols: number, rows: number): void { this.frames.push({ frame, cols, rows }); }
  async close(): Promise<boolean> { this.closed = true; return true; }
}

interface FakeCreateOptions {
  workspace: string;
  savedSession?: { sessionId: string };
}

/** Minimal frame/input-mode surface so live rows can genuinely receive routed input. */
class FakeSurface {
  frame(): TerminalFrame {
    return { cols: 80, rows: 24, lines: Array.from({ length: 24 }, () => ""), cursor: { column: 0, row: 0, visible: false } };
  }

  inputModes(): TerminalInputModes {
    return {
      kittyFlags: 0,
      modifyOtherKeys: 0,
      applicationCursorKeys: false,
      applicationKeypad: false,
      bracketedPaste: false,
      mouseTracking: "none",
      mouseEncoding: "default",
    };
  }
}

class FakeManager {
  readonly options: InstanceManagerOptions;
  readonly views: NativeInstanceView[] = [];
  readonly createOptions: FakeCreateOptions[] = [];
  readonly writes: { id: string; data: string | Buffer }[] = [];
  readonly surfaces = new Map<string, FakeSurface>();
  onChange?: (id: string) => void;
  nextId = 1;
  shutdownCalls = 0;
  disposeCalls = 0;
  stopping = false;
  persistence: "saved" | "unsaved" | "unknown" = "saved";
  holdLiveOnShutdown = false;
  neverReportsIdentity = false;
  nextCreateError = false;
  /** Every owned-child state query fails while stopping (unconfirmable shutdown). */
  brokenStateQueries = false;
  createCallCount = 0;
  gateCreateCall?: number;
  createGate?: Promise<void>;
  createGateEntered?: () => void;
  readonly pendingCreates = new Set<Promise<string>>();

  constructor(options: InstanceManagerOptions) {
    this.options = options;
    this.onChange = options.onChange;
  }

  list(): NativeInstanceView[] {
    if (this.brokenStateQueries && this.stopping) throw new Error("synthetic list failure");
    return this.views.map((view) => ({ ...view, activity: [...view.activity] }));
  }

  surface(id: string): FakeSurface | undefined {
    if (this.brokenStateQueries && this.stopping) throw new Error("synthetic surface failure");
    return this.surfaces.get(id);
  }

  write(id: string, data: string | Buffer): void {
    this.writes.push({ id, data });
  }

  create(options: { workspace: string; savedSession?: { sessionId: string } }): Promise<string> {
    this.createOptions.push({ ...options });
    const id = `row-${this.nextId++}`;
    const workspace = realpathSync(options.workspace);
    const sessionId = options.savedSession?.sessionId ?? `conv-${basename(workspace)}`;
    this.views.push({
      id,
      label: "(session starting)",
      workspace,
      agentDir: "/synthetic-agent",
      lifecycle: "starting",
      hasLiveProcess: false,
      busy: null,
      pendingInput: null,
      inputSurface: false,
      activity: [],
      nativeSession: null,
    });
    this.onChange?.(id);
    const pending = this.finishCreate(id, sessionId, ++this.createCallCount);
    this.pendingCreates.add(pending);
    void pending.then(() => this.pendingCreates.delete(pending), () => this.pendingCreates.delete(pending));
    return pending;
  }

  private async finishCreate(id: string, sessionId: string, call: number): Promise<string> {
    if (this.createGate && this.gateCreateCall === call) {
      this.createGateEntered?.();
      await this.createGate;
    }
    const index = this.views.findIndex((view) => view.id === id);
    const view = this.views[index];
    if (!view) throw new Error("missing synthetic row");
    if (this.nextCreateError) {
      this.nextCreateError = false;
      this.views[index] = { ...view, lifecycle: "error", hasLiveProcess: false, error: "synthetic-launch-error" };
      this.onChange?.(id);
      return id;
    }
    if (this.neverReportsIdentity) {
      this.views[index] = { ...view, label: "(session name unavailable)", lifecycle: "alive", hasLiveProcess: true, nativeSession: null };
    } else {
      const nativeSession: SessionHostNativeSession = {
        sessionId,
        epoch: 1,
        name: `Name ${sessionId}`,
        persistence: this.persistence,
      };
      this.views[index] = {
        ...view,
        label: nativeSession.name,
        lifecycle: "alive",
        hasLiveProcess: true,
        nativeSession,
        lastNativeSession: nativeSession,
      };
    }
    this.surfaces.set(id, new FakeSurface());
    this.onChange?.(id);
    return id;
  }

  closeExited(id: string): boolean {
    const index = this.views.findIndex((view) => view.id === id);
    const view = this.views[index];
    if (!view || view.hasLiveProcess === true || view.lifecycle === "starting") return false;
    this.views.splice(index, 1);
    this.surfaces.delete(id);
    this.onChange?.(id);
    return true;
  }

  ownedLiveSessions(): { id?: string; file?: string }[] {
    return this.views
      .filter((view) => view.hasLiveProcess)
      .map((view) => (view.nativeSession ? { id: view.nativeSession.sessionId } : {}));
  }

  async stop(id: string, _options: { confirmed: boolean }): Promise<StopInstanceResult> {
    const index = this.views.findIndex((view) => view.id === id);
    if (index < 0) return { status: "unavailable", forced: false };
    const view = this.views[index]!;
    this.views[index] = {
      ...view,
      lifecycle: "exited",
      hasLiveProcess: false,
      ...(view.nativeSession ? { lastNativeSession: view.nativeSession } : {}),
    };
    this.onChange?.(id);
    return { status: "exited", forced: false };
  }

  // --- #474 per-session viewer seam: viewer facts and per-row geometry only. ---
  // This fixture's frames are size-independent, so the geometry it reports is its
  // own record of what the host asked each row to be, never a second process store.
  readonly geometry = new Map<string, { cols: number; rows: number }>();
  readonly viewers = new FakeViewerSeam({
    isViewable: (id) => {
      const view = this.views.find((candidate) => candidate.id === id);
      return view !== undefined && view.hasLiveProcess && (view.lifecycle === "alive" || view.lifecycle === "starting");
    },
    read: (id) => this.geometry.get(id) ?? { cols: this.options.cols ?? 80, rows: this.options.rows ?? 24 },
    apply: (id, cols, rows) => { this.geometry.set(id, { cols, rows }); },
  });

  resize(): void {}

  openViewer(): SessionViewerState { return this.viewers.openViewer(); }

  viewerState(viewerId: string): SessionViewerState | undefined { return this.viewers.viewerState(viewerId); }

  sessionViewers(sessionId: string): SessionViewerState[] { return this.viewers.sessionViewers(sessionId); }

  updateViewer(viewerId: string, update: SessionViewerUpdate): SessionViewerUpdateResult {
    return this.viewers.updateViewer(viewerId, update);
  }

  closeViewer(viewerId: string): boolean { return this.viewers.closeViewer(viewerId); }

  instanceGeometry(id: string): SessionGeometry | undefined { return this.viewers.instanceGeometry(id); }

  setInitialGeometry(cols: number, rows: number): void { this.viewers.setInitialGeometry(cols, rows); }

  hasLiveProcesses(): boolean {
    if (this.brokenStateQueries && this.stopping) throw new Error("synthetic liveness failure");
    return this.views.some((view) => view.hasLiveProcess);
  }

  async shutdown(): Promise<ShutdownResult> {
    this.shutdownCalls += 1;
    this.stopping = true;
    await Promise.allSettled([...this.pendingCreates]);
    if (this.brokenStateQueries) throw new Error("synthetic shutdown failure");
    if (this.holdLiveOnShutdown) {
      return { forcedIds: [], remainingIds: this.views.filter((view) => view.hasLiveProcess).map((view) => view.id) };
    }
    for (let index = 0; index < this.views.length; index += 1) {
      const view = this.views[index]!;
      if (view.hasLiveProcess) this.views[index] = { ...view, lifecycle: "exited", hasLiveProcess: false };
    }
    return { forcedIds: [], remainingIds: [] };
  }

  async dispose(): Promise<void> { this.disposeCalls += 1; }

  /** Test hooks: simulate a real child's confirmed exit and a native /new or /resume. */
  exitRow(id: string): void {
    const index = this.views.findIndex((view) => view.id === id);
    const view = this.views[index];
    if (!view) return;
    this.views[index] = {
      ...view,
      lifecycle: "exited",
      hasLiveProcess: false,
      ...(view.nativeSession ? { lastNativeSession: view.nativeSession } : {}),
    };
    this.onChange?.(id);
  }

  newConversation(id: string, sessionId: string): void {
    const index = this.views.findIndex((view) => view.id === id);
    const view = this.views[index];
    if (!view || !view.nativeSession) return;
    const nativeSession = {
      sessionId,
      epoch: view.nativeSession.epoch + 1,
      name: `Name ${sessionId}`,
      persistence: "saved" as const,
    };
    this.views[index] = { ...view, label: nativeSession.name, nativeSession, lastNativeSession: nativeSession };
    this.onChange?.(id);
  }
}

type MainTestDependencies = NonNullable<Parameters<typeof __test.runWithDependencies>[1]>;

interface Harness {
  options: SessionHostOptions;
  terminal: FakeTerminal;
  observer: FakeObserver;
  reports: string[];
  events: string[];
  manager?: FakeManager;
  sidebar?: SidebarController;
  result: Promise<number>;
}

function options(overrides: Partial<SessionHostOptions> = {}): SessionHostOptions {
  return {
    packageRoot: process.cwd(),
    stateRoot: "/synthetic/host-state",
    args: [],
    env: { PATH: process.env.PATH, HOME: "/synthetic-home" },
    ...overrides,
  };
}

/** One already-live owned row with an observed current conversation. */
function aliveView(id: string, workspace: string, sessionId: string): NativeInstanceView {
  const session: SessionHostNativeSession = { sessionId, epoch: 1, name: `Name ${sessionId}`, persistence: "saved" };
  return {
    id,
    label: session.name,
    workspace,
    agentDir: "/synthetic-agent",
    lifecycle: "alive",
    hasLiveProcess: true,
    busy: false,
    pendingInput: false,
    inputSurface: false,
    activity: [],
    nativeSession: session,
    lastNativeSession: session,
  };
}

/** One already-exited placeholder row with a retained current binding. */
function exitedView(
  id: string,
  workspace: string,
  sessionId: string,
  persistence: "saved" | "unsaved" | "unknown",
): NativeInstanceView {
  const session: SessionHostNativeSession = { sessionId, epoch: 1, name: `Name ${sessionId}`, persistence };
  return {
    id,
    label: session.name,
    workspace,
    agentDir: "/synthetic-agent",
    lifecycle: "exited",
    hasLiveProcess: false,
    busy: null,
    pendingInput: null,
    inputSurface: false,
    activity: [],
    nativeSession: null,
    lastNativeSession: session,
  };
}

function createHarness(
  agentDir: string,
  listCatalog: () => Promise<SavedSessionCatalog>,
  overrides: Partial<SessionHostOptions> = {},
  dependencyOverrides: MainTestDependencies = {},
  harnessOptions: { readonly seedViews?: readonly NativeInstanceView[] } = {},
): Harness {
  const stdin = new FakeInput();
  const stdout = new FakeOutput();
  const signals = new EventEmitter();
  const terminal = new FakeTerminal();
  const observer = new FakeObserver();
  const writer = new FakeWriter();
  const reports: string[] = [];
  const events: string[] = [];
  const broker = {
    register() { throw new Error("the fake manager never registers children"); },
    async dispose() {},
  } as unknown as StatusBroker;
  let manager: FakeManager | undefined;
  let sidebar: SidebarController | undefined;
  let harness!: Harness;
  const result = __test.runWithDependencies(options(overrides), {
    platform: "linux",
    nodeVersion: "22.23.4",
    stdin,
    stdout: stdout as unknown as Writable & EventEmitter & { isTTY?: boolean; columns?: number; rows?: number },
    signals,
    resolvePi: () => ({ file: "/synthetic/pi", version: "1.0.4" }),
    createBroker: async () => { events.push("broker.create"); return broker; },
    createManager: (managerOptions) => {
      events.push("manager.create");
      manager = new FakeManager(managerOptions);
      for (const view of harnessOptions.seedViews ?? []) {
        manager.views.push(view);
        if (view.hasLiveProcess) manager.surfaces.set(view.id, new FakeSurface());
      }
      if (harness) harness.manager = manager;
      return manager as never;
    },
    createSidebar: (sidebarOptions) => {
      sidebar = new SidebarController(sidebarOptions);
      if (harness) harness.sidebar = sidebar;
      return sidebar;
    },
    createTerminal: () => terminal,
    createSessionSetup: () => ({
      nativeSetup: true,
      nativeAgentDir: agentDir,
      profileRegistry: {
        prepare: () => { throw new Error("the fake Main manager must not prepare sessions"); },
      } satisfies ProfilePreparer,
    }),
    createObserver: (observerOptions) => {
      observer.onChange = observerOptions?.onChange;
      return observer;
    },
    createWriter: (_output, _writerOptions?: SessionHostFrameWriterOptions) => writer,
    listSavedCatalog: listCatalog,
    reportError: (message) => reports.push(message),
    ...dependencyOverrides,
  });
  harness = { options: options(overrides), terminal, observer, reports, events, manager, sidebar, result };
  return harness;
}

async function ready(harness: Harness): Promise<FakeManager> {
  await nextTurn();
  assert.ok(harness.manager, "manager constructed after preflight, ownership, and broker setup");
  assert.equal(harness.observer.waitCalls, 1, "Main waits for keyboard negotiation before restoring or spawning");
  harness.observer.settle(0);
  await nextTurn();
  await nextTurn();
  return harness.manager;
}

/** Submit the New form for a first session (the default selection is New). */
function submitFirstNew(harness: Harness, workspace: string): void {
  harness.terminal.emitInput(ENTER);
  harness.terminal.emitInput("\x15");
  harness.terminal.emitInput(workspace);
  harness.terminal.emitInput(ENTER);
}

/** Return to the sidebar, navigate past the roster rows to New session, and submit. */
function submitAnotherNew(harness: Harness, workspace: string): void {
  harness.terminal.emitInput(ALT_LEFT);
  harness.terminal.emitInput(DOWN);
  harness.terminal.emitInput(DOWN);
  harness.terminal.emitInput(ENTER);
  harness.terminal.emitInput("\x15");
  harness.terminal.emitInput(workspace);
  harness.terminal.emitInput(ENTER);
}

async function quit(harness: Harness): Promise<number> {
  if (harness.sidebar?.focus === "form") harness.terminal.emitInput(ESC);
  if (harness.sidebar?.focus === "main") harness.terminal.emitInput(ALT_LEFT);
  harness.terminal.emitInput("q");
  harness.terminal.emitInput("y");
  return harness.result;
}

function writeSavedConversation(agentDir: string, sessionId: string, cwd: string, name?: string): void {
  const projectDir = join(agentDir, "sessions", "project-1");
  mkdirSync(projectDir, { recursive: true });
  const header = JSON.stringify({ type: "session", version: 3, id: sessionId, timestamp: SESSION_TIMESTAMP, cwd });
  const meta = JSON.stringify({ type: "meta", name: name ?? `Name ${sessionId}` });
  writeFileSync(join(projectDir, `${sessionId}.jsonl`), `${header}\n${meta}\n`, "utf8");
}

async function catalogFor(
  agentDir: string,
  entries: { id: string; cwd: string; name?: string }[],
): Promise<SavedSessionCatalog> {
  return listSavedSessions({
    agentDir,
    listAll: async (sessionDir) => entries.map((entry) => ({
      path: join(sessionDir, `${entry.id}.jsonl`),
      id: entry.id,
      cwd: entry.cwd,
      name: entry.name ?? `Name ${entry.id}`,
    })),
  });
}

async function emptyCatalog(agentDir: string): Promise<SavedSessionCatalog> {
  return listSavedSessions({ agentDir, listAll: async () => [] });
}

/** Create A, B, and C as explicit workspace sessions, then leave the sidebar focused on C. */
async function createThreeSessions(harness: Harness, workspaces: readonly string[]): Promise<FakeManager> {
  const manager = await ready(harness);
  submitFirstNew(harness, workspaces[0]!);
  await nextTurn();
  submitAnotherNew(harness, workspaces[1]!);
  await nextTurn();
  submitAnotherNew(harness, workspaces[2]!);
  await nextTurn();
  assert.deepEqual(manager.views.map((view) => view.workspace), workspaces.map((workspace) => realpathSync(workspace)));
  return manager;
}

test("a restart from a different launch configuration restores the remembered roster in order with the prior active entry", async () => {
  const root = makeRoot("restore");
  const agentDir = join(root, "agent");
  mkdirSync(agentDir);
  const workspaceA = join(root, "ws-a");
  const workspaceB = join(root, "ws-b");
  const workspaceC = join(root, "ws-c");
  for (const workspace of [workspaceA, workspaceB, workspaceC]) mkdirSync(workspace);
  try {
    // Host 1: A, B, C in explicit workspaces; remove C; activate B; Quit.
    const first = createHarness(agentDir, () => emptyCatalog(agentDir));
    const firstManager = await createThreeSessions(first, [workspaceA, workspaceB, workspaceC]);
    first.terminal.emitInput(ALT_LEFT);
    first.terminal.emitInput(UP); // row-3 -> row-2
    first.terminal.emitInput(ENTER); // activate B
    first.terminal.emitInput(ALT_LEFT);
    first.terminal.emitInput(DOWN); // row-2 -> row-3
    assert.equal(first.sidebar?.activeMainOwnerID, "row-2");
    firstManager.exitRow("row-3");
    first.terminal.emitInput(DELETE); // explicit removal of C
    await nextTurn();
    assert.deepEqual(firstManager.views.map((view) => view.workspace), [realpathSync(workspaceA), realpathSync(workspaceB)]);
    assert.equal(await quit(first), 0);

    // Quit retained the roster: A, B in order with B remembered as active.
    const stored = readRosterStore(agentDir);
    assert.equal(stored.status, "loaded");
    const roster = stored.status === "loaded" ? stored.roster : undefined;
    assert.deepEqual(rememberedSlots(roster).map((entry) => entry.sessionId), ["conv-ws-a", "conv-ws-b"]);
    assert.equal(roster?.activeSlotId, "row-2");
    assert.equal(rememberedSlots(roster).some((entry) => entry.sessionId === "conv-ws-c"), false);

    // Host 2 shares the same canonical agent directory but a different transient
    // host state root and cwd-independent options; it restores A and B in order.
    writeSavedConversation(agentDir, "conv-ws-a", realpathSync(workspaceA));
    writeSavedConversation(agentDir, "conv-ws-b", realpathSync(workspaceB));
    const second = createHarness(
      agentDir,
      () => catalogFor(agentDir, [
        { id: "conv-ws-b", cwd: realpathSync(workspaceB) },
        { id: "conv-ws-a", cwd: realpathSync(workspaceA) },
      ]),
      { stateRoot: "/synthetic/other-host-state" },
    );
    const secondManager = await ready(second);
    assert.deepEqual(
      secondManager.views.map((view) => view.nativeSession?.sessionId),
      ["conv-ws-a", "conv-ws-b"],
      "restored rows keep the remembered order, not the catalog's newest-first order",
    );
    assert.deepEqual(
      secondManager.createOptions.map((options) => options.savedSession?.sessionId),
      ["conv-ws-a", "conv-ws-b"],
      "every restored row is a freshly admitted saved conversation",
    );
    assert.equal(secondManager.views[0]?.workspace, realpathSync(workspaceA));
    assert.equal(secondManager.views[1]?.workspace, realpathSync(workspaceB));
    assert.equal(second.sidebar?.activeMainOwnerID, "row-2", "the remembered active entry is restored by row identity");
    assert.equal(secondManager.views.length, 2, "the explicitly removed entry is not restored");
    assert.equal(await quit(second), 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an unsaved or unavailable remembered conversation stays a bounded error row and never starts a fresh session", async () => {
  const root = makeRoot("unavailable");
  const agentDir = join(root, "agent");
  mkdirSync(agentDir);
  const workspaceA = join(root, "ws-a");
  const workspaceB = join(root, "ws-b");
  for (const workspace of [workspaceA, workspaceB]) mkdirSync(workspace);
  try {
    const first = createHarness(agentDir, () => emptyCatalog(agentDir));
    await ready(first);
    submitFirstNew(first, workspaceA);
    await nextTurn();
    assert.ok(first.manager);
    first.manager.persistence = "unsaved";
    submitAnotherNew(first, workspaceB);
    await nextTurn();
    assert.equal(await quit(first), 0);

    const stored = readRosterStore(agentDir);
    assert.equal(stored.status, "loaded");
    assert.equal(
      stored.status === "loaded" ? rememberedSlots(stored.roster)[1]?.persistence : undefined,
      "unsaved",
      "the store records the observed unsaved binding",
    );

    // Host 2: A is now saved; B was never saved. B must remain visible as an
    // error row and must NOT be replaced by a fresh session.
    writeSavedConversation(agentDir, "conv-ws-a", realpathSync(workspaceA));
    const second = createHarness(agentDir, () => catalogFor(agentDir, [
      { id: "conv-ws-a", cwd: realpathSync(workspaceA) },
    ]));
    const secondManager = await ready(second);
    assert.equal(secondManager.views.length, 1, "only the freshly admitted conversation is started");
    assert.deepEqual(secondManager.createOptions.map((options) => options.savedSession?.sessionId), ["conv-ws-a"]);
    assert.equal(
      secondManager.createOptions.every((options) => options.savedSession !== undefined),
      true,
      "restoration never launches a session that is not a freshly admitted saved conversation",
    );
    const errorRow = second.sidebar?.items.find((item) => item.id === "roster-error:row-2");
    assert.ok(errorRow, "the unavailable remembered conversation stays visible as an error row");
    assert.equal(errorRow?.lifecycle, "error");
    assert.equal(errorRow?.hasLiveProcess, false);
    assert.match(errorRow?.activity.join(" ") ?? "", /never saved/);

    // Explicit removal of that error entry removes it from the persisted roster.
    second.terminal.emitInput(UP); // New session -> Saved conversations
    second.terminal.emitInput(UP); // -> the remembered error row
    second.terminal.emitInput(DELETE);
    await nextTurn();
    const afterRemoval = readRosterStore(agentDir);
    assert.equal(afterRemoval.status, "loaded");
    assert.deepEqual(
      afterRemoval.status === "loaded" ? rememberedSlots(afterRemoval.roster).map((entry) => entry.sessionId) : undefined,
      ["conv-ws-a"],
    );
    assert.equal(second.sidebar?.items.some((item) => item.id === "roster-error:row-2"), false);
    assert.equal(await quit(second), 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an in-native /new conversation change updates the remembered identity that is restored later", async () => {
  const root = makeRoot("identity");
  const agentDir = join(root, "agent");
  mkdirSync(agentDir);
  const workspace = join(root, "ws-a");
  mkdirSync(workspace);
  try {
    const first = createHarness(agentDir, () => emptyCatalog(agentDir));
    const firstManager = await ready(first);
    submitFirstNew(first, workspace);
    await nextTurn();
    firstManager.newConversation("row-1", "conv-ws-a-renamed");
    await nextTurn();
    assert.equal(await quit(first), 0);

    const stored = readRosterStore(agentDir);
    assert.equal(stored.status, "loaded");
    assert.deepEqual(
      stored.status === "loaded" ? rememberedSlots(stored.roster).map((entry) => entry.sessionId) : undefined,
      ["conv-ws-a-renamed"],
      "the remembered identity follows the CURRENT native conversation, not the original launch binding",
    );

    writeSavedConversation(agentDir, "conv-ws-a-renamed", realpathSync(workspace));
    const second = createHarness(agentDir, () => catalogFor(agentDir, [
      { id: "conv-ws-a-renamed", cwd: realpathSync(workspace) },
    ]));
    const secondManager = await ready(second);
    assert.deepEqual(secondManager.createOptions.map((options) => options.savedSession?.sessionId), ["conv-ws-a-renamed"]);
    assert.equal(secondManager.views.length, 1);
    assert.equal(await quit(second), 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a second host sharing the canonical agent directory is refused before any launch, and ownership is released only after settled shutdown", async () => {
  const root = makeRoot("exclusive");
  const agentDir = join(root, "agent");
  mkdirSync(agentDir);
  const workspace = join(root, "ws-a");
  mkdirSync(workspace);
  try {
    const first = createHarness(agentDir, () => emptyCatalog(agentDir));
    await ready(first);
    assert.equal(existsSync(hostOwnershipPath(agentDir)), true, "exclusive ownership is held before any launch");
    const second = createHarness(agentDir, () => emptyCatalog(agentDir));
    assert.equal(await second.result, 1);
    assert.equal(second.events.includes("manager.create"), false, "ownership refusal precedes any manager or child construction");
    assert.match(second.reports.join("\n"), /another session host already owns/);
    assert.doesNotMatch(second.reports.join("\n"), /roster\.json/);

    assert.equal(await quit(first), 0);
    assert.equal(existsSync(hostOwnershipPath(agentDir)), false, "settled shutdown releases exclusive ownership");
    const third = createHarness(agentDir, () => emptyCatalog(agentDir));
    const thirdManager = await ready(third);
    assert.equal(thirdManager.views.length, 0);

    // An unsettled shutdown (an owned process whose exit was never confirmed)
    // retains ownership fail closed and refuses a later host.
    const manager = thirdManager;
    submitFirstNew(third, workspace);
    await nextTurn();
    manager.holdLiveOnShutdown = true;
    assert.equal(await quit(third), 1);
    assert.equal(existsSync(hostOwnershipPath(agentDir)), true, "unsettled shutdown retains ownership fail closed");
    assert.deepEqual(
      third.reports.some((message) => /ownership is retained/.test(message)),
      true,
      "the retained ownership is reported truthfully",
    );
    const refused = createHarness(agentDir, () => emptyCatalog(agentDir));
    assert.equal(await refused.result, 1);
    assert.match(refused.reports.join("\n"), /another session host already owns/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("restoration never launches a conversation in a workspace other than the one remembered", async () => {
  const root = makeRoot("workspace-mismatch");
  const agentDir = join(root, "agent");
  mkdirSync(agentDir);
  const remembered = join(root, "ws-remembered");
  const other = join(root, "ws-other");
  for (const workspace of [remembered, other]) mkdirSync(workspace);
  try {
    writeRosterStore(agentDir, {
      version: ROSTER_STORE_VERSION,
      entries: [{
        slotId: "slot-a",
        sessionId: "conv-moved",
        workspace: realpathSync(remembered),
        persistence: "saved",
      }],
    });
    // The saved conversation's own header now records a different workspace.
    writeSavedConversation(agentDir, "conv-moved", realpathSync(other));
    const harness = createHarness(agentDir, () => catalogFor(agentDir, [
      { id: "conv-moved", cwd: realpathSync(other) },
    ]));
    const manager = await ready(harness);
    assert.equal(manager.createOptions.length, 0, "a conversation whose recorded workspace changed is never restarted there");
    assert.equal(manager.views.length, 0);
    const errorRow = harness.sidebar?.items.find((item) => item.id === "roster-error:slot-a");
    assert.ok(errorRow);
    assert.equal(errorRow?.lifecycle, "error");
    assert.match(errorRow?.activity.join(" ") ?? "", /recorded workspace changed/);
    assert.equal(await quit(harness), 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an unavailable entry keeps its remembered position across two restarts instead of being reordered", async () => {
  const root = makeRoot("order");
  const agentDir = join(root, "agent");
  mkdirSync(agentDir);
  const workspaces = [join(root, "ws-a"), join(root, "ws-b"), join(root, "ws-c")];
  for (const workspace of workspaces) mkdirSync(workspace);
  try {
    const first = createHarness(agentDir, () => emptyCatalog(agentDir));
    await createThreeSessions(first, workspaces);
    assert.equal(await quit(first), 0);
    for (const [id, workspace] of [["conv-ws-a", workspaces[0]!], ["conv-ws-b", workspaces[1]!], ["conv-ws-c", workspaces[2]!]] as const) {
      writeSavedConversation(agentDir, id, realpathSync(workspace));
    }

    // Second host: the middle conversation is temporarily missing from the catalog.
    const second = createHarness(agentDir, () => catalogFor(agentDir, [
      { id: "conv-ws-a", cwd: realpathSync(workspaces[0]!) },
      { id: "conv-ws-c", cwd: realpathSync(workspaces[2]!) },
    ]));
    const secondManager = await ready(second);
    assert.deepEqual(secondManager.views.map((view) => view.nativeSession?.sessionId), ["conv-ws-a", "conv-ws-c"]);
    const ids = second.sidebar?.items.map((item) => item.id) ?? [];
    assert.equal(ids.length, 3, "the unavailable entry is drawn alongside the two restored rows");
    assert.equal(ids[0], secondManager.views[0]?.id, "A keeps the first remembered position");
    assert.equal(ids[1], "roster-error:row-2", "B keeps its remembered position between A and C");
    assert.equal(ids[2], secondManager.views[1]?.id, "C keeps the last remembered position");
    assert.equal(second.sidebar?.items[1]?.lifecycle, "error");
    const afterSecond = readRosterStore(agentDir);
    assert.equal(afterSecond.status, "loaded");
    assert.deepEqual(
      afterSecond.status === "loaded" ? rememberedSlots(afterSecond.roster).map((entry) => entry.slotId) : undefined,
      ["row-1", "row-2", "row-3"],
      "the persisted order is unchanged by a mid-list unavailable entry",
    );
    assert.deepEqual(
      afterSecond.status === "loaded" ? rememberedSlots(afterSecond.roster).map((entry) => entry.sessionId) : undefined,
      ["conv-ws-a", "conv-ws-b", "conv-ws-c"],
    );
    assert.equal(await quit(second), 0);

    // Third host: every conversation is available again and the order is stable.
    const third = createHarness(agentDir, () => catalogFor(agentDir, [
      { id: "conv-ws-a", cwd: realpathSync(workspaces[0]!) },
      { id: "conv-ws-b", cwd: realpathSync(workspaces[1]!) },
      { id: "conv-ws-c", cwd: realpathSync(workspaces[2]!) },
    ]));
    const thirdManager = await ready(third);
    assert.deepEqual(
      thirdManager.createOptions.map((options) => options.savedSession?.sessionId),
      ["conv-ws-a", "conv-ws-b", "conv-ws-c"],
    );
    assert.deepEqual(third.sidebar?.items.map((item) => item.lifecycle), ["alive", "alive", "alive"]);
    assert.equal(await quit(third), 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a row that never reports a conversation stays a remembered unavailable entry instead of disappearing", async () => {
  const root = makeRoot("identity-unavailable");
  const agentDir = join(root, "agent");
  mkdirSync(agentDir);
  const workspaceA = join(root, "ws-a");
  const workspaceB = join(root, "ws-b");
  for (const workspace of [workspaceA, workspaceB]) mkdirSync(workspace);
  try {
    const first = createHarness(agentDir, () => emptyCatalog(agentDir));
    const manager = await ready(first);
    manager.neverReportsIdentity = true;
    submitFirstNew(first, workspaceA);
    await nextTurn();
    manager.neverReportsIdentity = false;
    manager.nextCreateError = true;
    submitAnotherNew(first, workspaceB);
    await nextTurn();
    assert.deepEqual(manager.views.map((view) => view.lifecycle), ["alive", "error"]);
    assert.equal(await quit(first), 0);

    const stored = readRosterStore(agentDir);
    assert.equal(stored.status, "loaded");
    const entries = stored.status === "loaded" ? rememberedSlots(stored.roster) : [];
    assert.equal(entries.length, 2, "a live child without metadata and a failed launch are both remembered");
    assert.deepEqual(entries.map((entry) => entry.sessionId), [undefined, undefined]);
    assert.deepEqual(entries.map((entry) => entry.workspace), [realpathSync(workspaceA), realpathSync(workspaceB)]);

    // They restore only as bounded error entries: no session is invented for them.
    const second = createHarness(agentDir, () => emptyCatalog(agentDir));
    const secondManager = await ready(second);
    assert.equal(secondManager.createOptions.length, 0, "an unobserved identity never starts a fresh session");
    assert.deepEqual(second.sidebar?.items.map((item) => item.lifecycle), ["error", "error"]);
    assert.equal(second.sidebar?.items.every((item) => item.unavailable === true), true);
    assert.equal(await quit(second), 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a deliberate activation during a slow restore is never overridden by the late remembered active entry", async () => {
  const root = makeRoot("restore-fence");
  const agentDir = join(root, "agent");
  mkdirSync(agentDir);
  const workspaceA = join(root, "ws-a");
  const workspaceB = join(root, "ws-b");
  for (const workspace of [workspaceA, workspaceB]) mkdirSync(workspace);
  try {
    writeRosterStore(agentDir, {
      version: ROSTER_STORE_VERSION,
      entries: [
        { slotId: "slot-a", sessionId: "conv-ws-a", workspace: realpathSync(workspaceA), persistence: "saved" },
        { slotId: "slot-b", sessionId: "conv-ws-b", workspace: realpathSync(workspaceB), persistence: "saved" },
      ],
      // The remembered active entry is the SURVIVING sibling, so only the
      // deliberate-action fence can stop it being activated at completion.
      activeSlotId: "slot-b",
    });
    writeSavedConversation(agentDir, "conv-ws-a", realpathSync(workspaceA));
    writeSavedConversation(agentDir, "conv-ws-b", realpathSync(workspaceB));
    const harness = createHarness(agentDir, () => catalogFor(agentDir, [
      { id: "conv-ws-a", cwd: realpathSync(workspaceA) },
      { id: "conv-ws-b", cwd: realpathSync(workspaceB) },
    ]));
    await nextTurn();
    const manager = harness.manager;
    assert.ok(manager);
    // Hold the SECOND restored child so the restore is still in flight while the
    // user acts on the first one.
    let releaseCreate!: () => void;
    let enterCreate!: () => void;
    const entered = new Promise<void>((resolve) => { enterCreate = resolve; });
    manager.gateCreateCall = 2;
    manager.createGate = new Promise<void>((resolve) => { releaseCreate = resolve; });
    manager.createGateEntered = enterCreate;
    harness.observer.settle(0);
    await entered;

    harness.terminal.emitInput(UP); // New session -> Saved conversations
    harness.terminal.emitInput(UP); // -> the still-starting B row
    harness.terminal.emitInput(UP); // -> the restored A row
    assert.equal(harness.sidebar?.items.length, 2);
    harness.terminal.emitInput(ENTER); // deliberate activation of A
    assert.equal(harness.sidebar?.focus, "main");
    assert.equal(harness.sidebar?.activeMainOwnerID, "row-1");
    harness.terminal.emitInput(ALT_LEFT);
    manager.exitRow("row-1");
    harness.terminal.emitInput(DELETE); // explicit removal of the activated row
    await nextTurn();
    assert.equal(harness.sidebar?.activeMainOwnerID, undefined);

    releaseCreate();
    await nextTurn();
    await nextTurn();
    assert.deepEqual(manager.views.map((view) => view.id), ["row-2"]);
    assert.equal(
      harness.sidebar?.activeMainOwnerID,
      undefined,
      "the late remembered active entry never re-establishes an input owner after a later user action",
    );
    assert.equal(await quit(harness), 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("activating a remembered-but-unavailable row never hands input to a sibling child", async () => {
  const root = makeRoot("unavailable-activation");
  const agentDir = join(root, "agent");
  mkdirSync(agentDir);
  const workspaceA = join(root, "ws-a");
  const workspaceB = join(root, "ws-b");
  for (const workspace of [workspaceA, workspaceB]) mkdirSync(workspace);
  try {
    writeRosterStore(agentDir, {
      version: ROSTER_STORE_VERSION,
      entries: [
        { slotId: "slot-a", sessionId: "conv-ws-a", workspace: realpathSync(workspaceA), persistence: "unsaved" },
        { slotId: "slot-b", sessionId: "conv-ws-b", workspace: realpathSync(workspaceB), persistence: "saved" },
      ],
      activeSlotId: "slot-b",
    });
    writeSavedConversation(agentDir, "conv-ws-b", realpathSync(workspaceB));
    const harness = createHarness(agentDir, () => catalogFor(agentDir, [
      { id: "conv-ws-b", cwd: realpathSync(workspaceB) },
    ]));
    const manager = await ready(harness);
    assert.deepEqual(harness.sidebar?.items.map((item) => item.lifecycle), ["error", "alive"]);
    const activeRow = manager.views[0]!.id;
    assert.equal(harness.sidebar?.activeMainOwnerID, activeRow);

    harness.terminal.emitInput(UP); // New session -> Saved conversations
    harness.terminal.emitInput(UP); // -> the live restored row
    harness.terminal.emitInput(UP); // -> the remembered unavailable row
    harness.terminal.emitInput(ENTER);
    assert.equal(harness.sidebar?.focus, "sidebar", "an unavailable row never moves input focus to Main");
    assert.equal(harness.sidebar?.activeMainOwnerID, activeRow, "the current owner is unchanged");
    harness.terminal.emitInput("z");
    assert.deepEqual(manager.writes, [], "no child receives input meant for an unavailable conversation");
    assert.equal(await quit(harness), 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("ownership is retained fail closed when no owned-child state can be confirmed", async () => {
  const root = makeRoot("unconfirmable");
  const agentDir = join(root, "agent");
  mkdirSync(agentDir);
  const workspace = join(root, "ws-a");
  mkdirSync(workspace);
  try {
    const harness = createHarness(agentDir, () => emptyCatalog(agentDir));
    const manager = await ready(harness);
    submitFirstNew(harness, workspace);
    await nextTurn();
    manager.brokenStateQueries = true;
    assert.equal(await quit(harness), 1);
    assert.equal(existsSync(hostOwnershipPath(agentDir)), true, "unconfirmed child state never authorizes releasing ownership");
    assert.equal(
      harness.reports.some((message) => /ownership is retained/.test(message)),
      true,
      "the retained ownership is reported truthfully",
    );
    const refused = createHarness(agentDir, () => emptyCatalog(agentDir));
    assert.equal(await refused.result, 1);
    assert.match(refused.reports.join("\n"), /another session host already owns/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a failed exited-row restart keeps both the placeholder and the replacement remembered", async () => {
  const root = makeRoot("failed-restart-retention");
  const agentDir = join(root, "agent");
  mkdirSync(agentDir);
  const workspace = join(root, "ws-a");
  mkdirSync(workspace);
  try {
    const harness = createHarness(agentDir, () => emptyCatalog(agentDir), {}, {}, {
      seedViews: [exitedView("old", realpathSync(workspace), "conv-old", "unsaved")],
    });
    const manager = await ready(harness);
    harness.terminal.emitInput(UP); // New session -> Saved conversations
    harness.terminal.emitInput(UP); // -> the exited placeholder
    assert.equal(harness.sidebar?.selectedId, "old");
    manager.nextCreateError = true;
    harness.terminal.emitInput(ENTER); // deliberate restart that fails readiness
    await nextTurn();
    await nextTurn();
    assert.equal(manager.createOptions.length, 1);
    assert.deepEqual(manager.views.map((view) => view.id), ["old", "row-1"], "the failed restart retains both rows");
    assert.equal(await quit(harness), 0);

    const stored = readRosterStore(agentDir);
    assert.equal(stored.status, "loaded");
    const entries = stored.status === "loaded" ? rememberedSlots(stored.roster) : [];
    assert.equal(entries.length, 2, "neither retained row is silently lost when the host quits");
    assert.equal(entries[0]?.sessionId, "conv-old");

    // Both remembered rows come back as bounded error entries, never as fresh sessions.
    const second = createHarness(agentDir, () => emptyCatalog(agentDir));
    const secondManager = await ready(second);
    assert.equal(secondManager.createOptions.length, 0, "the never-saved placeholder is not restarted as a fresh session");
    assert.deepEqual(second.sidebar?.items.map((item) => item.lifecycle), ["error", "error"]);
    assert.equal(await quit(second), 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a successful exited-row restart keeps the replaced row's roster slot and order", async () => {
  const root = makeRoot("restart-order");
  const agentDir = join(root, "agent");
  mkdirSync(agentDir);
  const workspaceA = join(root, "ws-a");
  const workspaceB = join(root, "ws-b");
  for (const workspace of [workspaceA, workspaceB]) mkdirSync(workspace);
  try {
    const harness = createHarness(agentDir, () => emptyCatalog(agentDir), {}, {}, {
      seedViews: [
        exitedView("old", realpathSync(workspaceA), "conv-old", "unsaved"),
        aliveView("other", realpathSync(workspaceB), "conv-ws-other"),
      ],
    });
    const manager = await ready(harness);
    harness.terminal.emitInput(UP); // New session -> Saved conversations
    harness.terminal.emitInput(UP); // -> the live sibling
    harness.terminal.emitInput(UP); // -> the exited placeholder
    assert.equal(harness.sidebar?.selectedId, "old");
    harness.terminal.emitInput(ENTER); // a successful restart of the first row
    await nextTurn();
    await nextTurn();
    assert.deepEqual(manager.views.map((view) => view.id), ["other", "row-1"], "the manager appends the replacement");
    assert.deepEqual(
      harness.sidebar?.items.map((item) => item.id),
      ["row-1", "other"],
      "the roster keeps the replaced row's position instead of reordering to B,A",
    );
    assert.equal(harness.sidebar?.activeMainOwnerID, "row-1");
    const stored = readRosterStore(agentDir);
    assert.equal(stored.status, "loaded");
    assert.deepEqual(
      stored.status === "loaded" ? rememberedSlots(stored.roster).map((entry) => entry.slotId) : undefined,
      ["old", "other"],
      "the stable slot id is transferred into the old position",
    );
    assert.deepEqual(
      stored.status === "loaded" ? rememberedSlots(stored.roster).map((entry) => entry.sessionId) : undefined,
      ["conv-ws-a", "conv-ws-other"],
    );
    assert.equal(
      stored.status === "loaded" ? stored.roster.activeSlotId : undefined,
      "old",
      "the remembered active slot follows the transferred slot",
    );
    assert.equal(await quit(harness), 0);

    // The next start restores the same order from the same transferred slot.
    writeSavedConversation(agentDir, "conv-ws-a", realpathSync(workspaceA));
    writeSavedConversation(agentDir, "conv-ws-other", realpathSync(workspaceB));
    const second = createHarness(agentDir, () => catalogFor(agentDir, [
      { id: "conv-ws-a", cwd: realpathSync(workspaceA) },
      { id: "conv-ws-other", cwd: realpathSync(workspaceB) },
    ]));
    const secondManager = await ready(second);
    assert.deepEqual(
      secondManager.createOptions.map((options) => options.savedSession?.sessionId),
      ["conv-ws-a", "conv-ws-other"],
      "a successful restart never reorders the persisted roster",
    );
    assert.equal(second.sidebar?.activeMainOwnerID, "row-1", "the transferred active slot still maps to its row");
    assert.equal(await quit(second), 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("returning to Main during a slow restore is never overridden by the remembered active entry", async () => {
  const root = makeRoot("focus-fence");
  const agentDir = join(root, "agent");
  mkdirSync(agentDir);
  const workspaceA = join(root, "ws-a");
  const workspaceB = join(root, "ws-b");
  for (const workspace of [workspaceA, workspaceB]) mkdirSync(workspace);
  try {
    writeRosterStore(agentDir, {
      version: ROSTER_STORE_VERSION,
      entries: [
        { slotId: "slot-a", sessionId: "conv-ws-a", workspace: realpathSync(workspaceA), persistence: "saved" },
        { slotId: "slot-b", sessionId: "conv-ws-b", workspace: realpathSync(workspaceB), persistence: "saved" },
      ],
      activeSlotId: "slot-a",
    });
    writeSavedConversation(agentDir, "conv-ws-a", realpathSync(workspaceA));
    writeSavedConversation(agentDir, "conv-ws-b", realpathSync(workspaceB));
    const harness = createHarness(agentDir, () => catalogFor(agentDir, [
      { id: "conv-ws-a", cwd: realpathSync(workspaceA) },
      { id: "conv-ws-b", cwd: realpathSync(workspaceB) },
    ]));
    await nextTurn();
    const manager = harness.manager;
    assert.ok(manager);
    let releaseCreate!: () => void;
    let enterCreate!: () => void;
    const entered = new Promise<void>((resolve) => { enterCreate = resolve; });
    manager.gateCreateCall = 2;
    manager.createGate = new Promise<void>((resolve) => { releaseCreate = resolve; });
    manager.createGateEntered = enterCreate;
    harness.observer.settle(0);
    await entered;
    // Let the roster redraw so the focus-only chord is fully drawn and honoured.
    await nextTurn();
    harness.terminal.emitInput(ALT_RIGHT);
    assert.equal(harness.sidebar?.focus, "main", "the focus-only host action is honoured during restoration");

    releaseCreate();
    await nextTurn();
    await nextTurn();
    assert.equal(
      harness.sidebar?.activeMainOwnerID,
      undefined,
      "completion never establishes an input owner after a deliberate focus-only action",
    );
    harness.terminal.emitInput("z");
    assert.deepEqual(manager.writes, [], "typing after the refusal reaches no child");
    assert.equal(await quit(harness), 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// The existing durable roster slot as read-only presentation metadata (#477).
//
// Main already owns the durable sidebar slot of every row. These tests pin the
// substrate that lets the owning-host service project that EXISTING fact: one
// narrow read-only accessor over Main's own maps (no second slot store, no
// mirror), the service's inventory rows carrying it, and the remote row
// boundary exposing it as metadata while the manager row id stays the runtime
// identity that selection, input, and actions route by.
// ---------------------------------------------------------------------------

test("Main exposes each row's existing durable roster slot to the owning-host service read-only", async () => {
  const root = makeRoot("slot-source");
  const agentDir = join(root, "agent");
  mkdirSync(agentDir);
  const workspaceA = join(root, "ws-a");
  const workspaceB = join(root, "ws-b");
  for (const workspace of [workspaceA, workspaceB]) mkdirSync(workspace);
  let slotSource: ((rowId: string) => string | undefined) | undefined;
  let service: OwningHostService | undefined;
  try {
    const harness = createHarness(agentDir, () => emptyCatalog(agentDir), {}, {
      createOwningHostService: (dependencies) => {
        slotSource = dependencies.rosterSlotIdFor;
        service = createLocalOwningHostService(dependencies);
        return service;
      },
    }, {
      seedViews: [
        exitedView("old", realpathSync(workspaceA), "conv-old", "unsaved"),
        aliveView("other", realpathSync(workspaceB), "conv-ws-other"),
      ],
    });
    const manager = await ready(harness);
    assert.equal(typeof slotSource, "function", "Main wires one narrow read-only slot accessor");
    const slotOf = (rowId: string): string | undefined => slotSource?.(rowId);

    assert.equal(slotOf("old"), "old");
    assert.equal(slotOf("other"), "other");
    // ONE deterministic rule (#477): a listed row with no binding yet answers
    // with its own id, which is exactly the slot Main mints and persists for it,
    // so the first negotiated observation is already coherent. The accessor is
    // only ever asked about a row the manager itself just listed, and it never
    // answers with a DIFFERENT row's slot.
    assert.equal(slotOf("a-row-not-listed-yet"), "a-row-not-listed-yet");

    const before = service?.readInventorySnapshot();
    assert.ok(before, "the open manager makes the inventory observable");
    assert.deepEqual(
      before.rows.map((row) => [row.id, row.rosterSlotId]),
      [["old", "old"], ["other", "other"]],
      "the inventory carries Main's own slots, read live, with the manager's row order intact",
    );

    // Replace the exited row: the manager appends a fresh runtime row id while
    // Main transfers the durable slot into the same remembered position.
    harness.terminal.emitInput(UP); // New session -> Saved conversations
    harness.terminal.emitInput(UP); // -> the live sibling
    harness.terminal.emitInput(UP); // -> the exited placeholder
    assert.equal(harness.sidebar?.selectedId, "old");
    harness.terminal.emitInput(ENTER);
    await nextTurn();
    await nextTurn();
    assert.deepEqual(manager.views.map((view) => view.id), ["other", "row-1"],
      "the replacement row carries a regenerated runtime id");

    assert.equal(slotOf("row-1"), "old", "the same durable slot survives a regenerated runtime row id");
    // The retired runtime row left the manager's listing, so the real consumer
    // never asks about it again; the inventory below carries no such row.

    const after = service?.readInventorySnapshot();
    assert.ok(after);
    assert.equal(after.hostRunId, before.hostRunId, "one owner run throughout");
    assert.ok(after.revision > before.revision, "the revision rule is unchanged");
    assert.deepEqual(
      after.rows.map((row) => [row.id, row.rosterSlotId]),
      [["other", "other"], ["row-1", "old"]],
    );

    const stored = readRosterStore(agentDir);
    assert.equal(stored.status, "loaded");
    assert.deepEqual(
      stored.status === "loaded" ? rememberedSlots(stored.roster).map((entry) => entry.slotId) : undefined,
      ["old", "other"],
      "the projected slots are Main's persisted roster slots, not a parallel set",
    );

    // The remote boundary carries the slot as metadata only: the runtime row id
    // stays the identity selection, input, and actions use.
    const replacement = after.rows.find((row) => row.id === "row-1");
    assert.ok(replacement);
    const remote = toRemoteSessionMetadata(replacement, { rosterSlotId: true });
    assert.equal(remote.id, "row-1");
    assert.equal(remote.rosterSlotId, "old");
    assert.equal(toRemoteSessionMetadata(replacement).rosterSlotId, undefined,
      "an unnegotiated projection keeps the legacy row shape");

    assert.equal(await quit(harness), 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a live inventory watch is re-observed when Main transfers the durable slot to a replacement", async () => {
  const root = makeRoot("slot-transfer-watch");
  const agentDir = join(root, "agent");
  mkdirSync(agentDir);
  const workspaceA = join(root, "ws-a");
  const workspaceB = join(root, "ws-b");
  for (const workspace of [workspaceA, workspaceB]) mkdirSync(workspace);
  let service: OwningHostService | undefined;
  try {
    const harness = createHarness(agentDir, () => emptyCatalog(agentDir), {}, {
      createOwningHostService: (dependencies) => {
        service = createLocalOwningHostService(dependencies);
        return service;
      },
    }, {
      seedViews: [
        exitedView("old", realpathSync(workspaceA), "conv-old", "unsaved"),
        aliveView("other", realpathSync(workspaceB), "conv-ws-other"),
      ],
    });
    const manager = await ready(harness);
    assert.ok(service, "Main wired the owning-host service");

    // Count every manager change notification, so a later inventory delivery can
    // be told apart from a manager-driven one.
    const managerChanges: string[] = [];
    const hostChange = manager.onChange;
    manager.onChange = (id: string): void => {
      managerChanges.push(id);
      hostChange?.(id);
    };

    interface Delivery {
      readonly revision: number;
      readonly changes: number;
      readonly pairs: string[];
      readonly snapshot: OwningHostInventorySnapshot;
    }
    const deliveries: Delivery[] = [];
    const watch = service.watchInventory((snapshot) => {
      if (snapshot === undefined) return;
      deliveries.push({
        revision: snapshot.revision,
        changes: managerChanges.length,
        pairs: snapshot.rows.map((row) => `${row.id}=${row.rosterSlotId ?? "<absent>"}`),
        snapshot,
      });
    });
    assert.ok(watch, "the inventory watch installs");
    // Installation returns its own snapshot instead of also calling the
    // listener, so record that first observation exactly as delivered.
    deliveries.push({
      revision: watch.snapshot.revision,
      changes: managerChanges.length,
      pairs: watch.snapshot.rows.map((row) => `${row.id}=${row.rosterSlotId ?? "<absent>"}`),
      snapshot: watch.snapshot,
    });
    assert.deepEqual(deliveries.at(-1)?.pairs, ["old=old", "other=other"],
      "the install snapshot carries each row's current durable slot");

    // Replace the exited row, then do NOTHING ELSE to the manager.
    harness.terminal.emitInput(UP); // New session -> Saved conversations
    harness.terminal.emitInput(UP); // -> the live sibling
    harness.terminal.emitInput(UP); // -> the exited placeholder
    assert.equal(harness.sidebar?.selectedId, "old");
    harness.terminal.emitInput(ENTER);
    await nextTurn();
    await nextTurn();
    assert.deepEqual(manager.views.map((view) => view.id), ["other", "row-1"],
      "the replacement row carries a regenerated runtime id");

    const created = deliveries.find((delivery) => delivery.pairs.includes("row-1=row-1"));
    assert.ok(created, "the replacement's FIRST publication already carries the deterministic slot Main mints for a new row");
    assert.equal(deliveries.some((delivery) => delivery.pairs.includes("row-1=<absent>")), false,
      "the shared authority rule never publishes an invented absence for a row the manager lists");
    const stale = [...deliveries].reverse().find((delivery) => delivery.pairs.includes("row-1=row-1"));
    assert.ok(stale, "the manager's own change published that temporary slot before the transfer");

    const latest = deliveries.at(-1);
    assert.ok(latest);
    assert.deepEqual(latest.pairs, ["other=other", "row-1=old"],
      "the live watcher receives the transferred durable slot with no later manager change");
    assert.equal(latest.changes, stale.changes,
      "the correction came from the host's re-observation, not from a later manager change");
    assert.equal(managerChanges.length, stale.changes,
      "nothing else happened to the manager after that change");
    assert.ok(latest.revision > stale.revision, "one owner run, a strictly newer revision");
    assert.deepEqual(
      deliveries.filter((delivery) => delivery.revision >= created.revision).map((delivery) => delivery.revision),
      [...deliveries].filter((delivery) => delivery.revision >= created.revision)
        .map((delivery) => delivery.revision).sort((a, b) => a - b),
      "deliveries never hand a watcher an older revision",
    );

    // The negotiated bridge projection of that DELIVERED observation is
    // coherent: the runtime row id routes, the durable slot only describes
    // placement. No fresh read is needed to see the corrected slot.
    const deliveredReplacement = latest.snapshot.rows.find((row) => row.id === "row-1");
    assert.ok(deliveredReplacement);
    const remote = toRemoteSessionMetadata(deliveredReplacement, { rosterSlotId: true });
    assert.deepEqual([remote.id, remote.rosterSlotId], ["row-1", "old"]);

    watch.unsubscribe();
    assert.equal(await quit(harness), 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the first negotiated observation of a brand-new row already carries the slot Main persists, and it stays stable", async () => {
  const root = makeRoot("first-create-slot");
  const agentDir = join(root, "agent");
  mkdirSync(agentDir);
  const workspaceA = join(root, "ws-a");
  mkdirSync(workspaceA);
  let service: OwningHostService | undefined;
  try {
    const harness = createHarness(agentDir, () => emptyCatalog(agentDir), {}, {
      createOwningHostService: (dependencies) => {
        service = createLocalOwningHostService(dependencies);
        return service;
      },
    });
    const manager = await ready(harness);
    assert.ok(service, "Main wired the owning-host service");
    assert.equal(manager.views.length, 0, "no row exists before the deliberate create");

    // The watch is installed BEFORE the create, so the very first publication of
    // the new row is observed, before any later status change of that row.
    const deliveries: string[][] = [];
    const watch = service.watchInventory((snapshot) => {
      if (snapshot === undefined) return;
      deliveries.push(snapshot.rows.map((row) => `${row.id}=${row.rosterSlotId ?? "<absent>"}`));
    });
    assert.ok(watch, "the inventory watch installs");

    submitFirstNew(harness, workspaceA);
    await nextTurn();
    const first = deliveries.find((pairs) => pairs.some((pair) => pair.startsWith("row-1=")));
    assert.ok(first, "the watcher observed the newly created row");
    assert.deepEqual(first, ["row-1=row-1"],
      "the first publication already carries the deterministic durable slot this host adopts and persists");

    await nextTurn();
    const latestPairs = deliveries.at(-1);
    assert.ok(latestPairs);
    assert.ok(latestPairs.includes("row-1=row-1"),
      "the same slot survives the row's later status change: no invented absence, no second position");

    // The persisted roster holds that same single slot.
    const stored = readRosterStore(agentDir);
    assert.equal(stored.status, "loaded");
    assert.deepEqual(
      rememberedSlots(stored.roster).map((entry) => entry.slotId),
      ["row-1"],
      "the observed slot is the persisted slot, not a parallel one",
    );

    // And the negotiated bridge projection of a DELIVERED row carries it as
    // placement metadata while the runtime row id stays the routing identity.
    const inventory = service?.readInventorySnapshot();
    assert.ok(inventory);
    const deliveredRow = inventory.rows.find((row) => row.id === "row-1");
    assert.ok(deliveredRow);
    const remote = toRemoteSessionMetadata(deliveredRow, { rosterSlotId: true });
    assert.deepEqual([remote.id, remote.rosterSlotId], ["row-1", "row-1"]);

    watch.unsubscribe();
    assert.equal(await quit(harness), 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// #477: the ONE canonical mixed local/remote presentation order, integrated
// into production Main. The roster store, ownership record, and saved-catalog
// revalidation are real; the coordinator supplies only the remote DTOs an owner
// would report. There is no physical-terminal or mouse-mode proof here.
// ---------------------------------------------------------------------------

const SGR_PATTERN = /\x1b\[[0-9;]*m/g;
const MOVE_KEY = "m";

/** The coordinator Main owns: the snapshot it publishes is this viewer's only remote fact. */
class FakePeerCoordinator implements PeerCoordinator {
  options: PeerCoordinatorOptions | undefined;
  snapshot: PeerUiSnapshot = {
    revision: 1,
    status: "ready",
    identityFingerprint: null,
    settings: {
      hostingEnabled: false, bindHost: "", bindPort: null, autoReconnect: false, bellEnabled: true,
      viewerNativeInputEnabled: true, remoteHistoryDeleteEnabled: true,
    },
    listener: { state: "off", host: null, port: null, message: null },
    hosts: [], trustedPeers: [], consents: [], notice: null,
  };
  read(): PeerUiSnapshot { return this.snapshot; }
  async start(): Promise<void> {}
  async perform(): Promise<void> {}
  decideConsent(): boolean { return false; }
  async close(): Promise<void> {}
  publish(hosts: readonly PeerUiHost[]): void {
    this.snapshot = { ...this.snapshot, hosts, revision: this.snapshot.revision + 1 };
    this.options?.onChange(this.snapshot);
  }
}

/** One owner-side remote card, projected through the real owner roster boundary. */
function remoteCard(options: {
  rowId: string;
  workspace: string;
  conversation: string;
  rosterSlotId?: string;
}): RemoteSessionMetadata {
  const view = {
    ...aliveView(options.rowId, options.workspace, options.conversation),
    ...(options.rosterSlotId === undefined ? {} : { rosterSlotId: options.rosterSlotId }),
  };
  return toRemoteSessionMetadata(view, { rosterSlotId: options.rosterSlotId !== undefined });
}

function peerHost(options: {
  id: string;
  rows: readonly RemoteSessionMetadata[] | null;
  hostRunId: string | null;
  rosterState?: "never" | "current" | "stale";
}): PeerUiHost {
  return {
    id: options.id,
    label: `host ${options.id}`,
    host: "127.0.0.1",
    port: 8443,
    state: "connected",
    fingerprint: null,
    message: null,
    reconnectSuppressed: false,
    previouslyConnected: true,
    roster: { state: options.rosterState ?? "current", rows: options.rows, hostRunId: options.hostRunId },
  };
}

/** The roster pane exactly as this host draws it, with no presentation bytes. */
function drawnRoster(sidebar: SidebarController): string[] {
  return sidebar.renderRoster(44, 34).lines.map((line) => line.replace(SGR_PATTERN, ""));
}

/** The given card labels in the vertical order the sidebar actually draws them. */
function drawnOrder(sidebar: SidebarController, labels: readonly string[]): string[] {
  const lines = drawnRoster(sidebar);
  const placed = labels
    .map((label) => ({ label, index: lines.findIndex((line) => line.includes(label)) }))
    .filter((entry) => entry.index >= 0)
    .sort((left, right) => left.index - right.index);
  assert.equal(placed.length, labels.length, `every named card must be drawn: ${JSON.stringify(lines)}`);
  return placed.map((entry) => entry.label);
}

/** Walks the roster highlight to the card whose title line belongs to the highlighted card block. */
function highlightCard(harness: Harness, sidebar: SidebarController, label: string): void {
  for (let attempt = 0; attempt < 14; attempt += 1) {
    const lines = drawnRoster(sidebar);
    const marker = lines.findIndex((line) => line.startsWith("> ") || line.startsWith(">>"));
    if (marker >= 0) {
      // A card block is its title line, then (for a remote card) its owner-host
      // line, then the status line that carries the selection marker.
      const block = lines.slice(Math.max(0, marker - 3), marker + 1).join("\n");
      if (block.includes(label)) return;
    }
    harness.terminal.emitInput(DOWN);
  }
  assert.fail(`the roster never highlighted ${label}: focus=${sidebar.focus} selected=${sidebar.selectedId} ${JSON.stringify(drawnRoster(sidebar))}`);
}

/** The persisted ordered sequence, one string per entry, in document order. */
function persistedSequence(agentDir: string): string[] {
  const read = readRosterStore(agentDir);
  assert.equal(read.status, "loaded");
  if (read.status !== "loaded") return [];
  assert.equal(read.roster.version, ROSTER_STORE_VERSION, "the published document is the single current version");
  return read.roster.entries.map((entry) => entry.kind === "remote"
    ? `remote:${entry.hostId}:${entry.owner.kind}:${entry.owner.id}`
    : `local:${entry.slotId}`);
}

test("a committed keyboard reorder interleaves local and remote cards, and the mixed order survives viewer and owner restarts", async () => {
  const root = makeRoot("mixed-order");
  const agentDir = join(root, "agent");
  mkdirSync(agentDir);
  const workspaceA = join(root, "ws-a");
  const workspaceC = join(root, "ws-c");
  for (const workspace of [workspaceA, workspaceC]) mkdirSync(workspace);
  const all = ["Name conv-b", "Name conv-ws-a", "Name conv-ws-c", "Name conv-d"];
  const hostsFor = (hostRunId: string): PeerUiHost[] => [
    peerHost({ id: "h1", hostRunId, rows: [remoteCard({ rowId: "rb", workspace: "/remote/ws/b", conversation: "conv-b", rosterSlotId: "slot-b" })] }),
    peerHost({ id: "h2", hostRunId, rows: [remoteCard({ rowId: "rd", workspace: "/remote/ws/d", conversation: "conv-d", rosterSlotId: "slot-d" })] }),
  ];
  try {
    const peer = new FakePeerCoordinator();
    const first = createHarness(agentDir, () => emptyCatalog(agentDir), {}, {
      createPeerCoordinator: (coordinatorOptions) => {
        peer.options = coordinatorOptions;
        return peer as never;
      },
    });
    const manager = await ready(first);
    submitFirstNew(first, workspaceA);
    await nextTurn();
    submitAnotherNew(first, workspaceC);
    await nextTurn();
    assert.deepEqual(manager.views.map((view) => view.id), ["row-1", "row-2"]);
    peer.publish(hostsFor("run-1"));
    await nextTurn();
    const sidebar = first.sidebar;
    assert.ok(sidebar);
    assert.deepEqual(
      drawnOrder(sidebar, ["Name conv-ws-a", "Name conv-ws-c", "Name conv-b", "Name conv-d"]),
      ["Name conv-ws-a", "Name conv-ws-c", "Name conv-b", "Name conv-d"],
      "new remote identities append in first-observed order and never displace a local card",
    );

    // The agreed example: A local, B host1, C local, D host2 -> B, A, C, D.
    first.terminal.emitInput(ALT_LEFT); // focus the roster
    highlightCard(first, sidebar, "Name conv-b");
    first.terminal.emitInput(MOVE_KEY);
    first.terminal.emitInput(UP);
    first.terminal.emitInput(UP);
    first.terminal.emitInput(ENTER); // commits the move, activates nothing
    await nextTurn();
    assert.deepEqual(drawnOrder(sidebar, all), all, "one committed reorder interleaves both hosts");
    assert.equal(sidebar.activeMainOwnerID, "row-2", "the reorder activated nothing and kept the displayed owner");

    // The saved document is that same single ordered sequence: remote entries
    // carry durable presentation identity only, local entries their own payload.
    assert.deepEqual(persistedSequence(agentDir), [
      "remote:h1:slot:slot-b",
      "local:row-1",
      "local:row-2",
      "remote:h2:slot:slot-d",
    ]);
    assert.equal(await quit(first), 0);

    // Viewer restart AND owner restart: new host, new local rows, new owner run,
    // the SAME durable owner slots. The mixed order is restored, not re-derived.
    writeSavedConversation(agentDir, "conv-ws-a", realpathSync(workspaceA));
    writeSavedConversation(agentDir, "conv-ws-c", realpathSync(workspaceC));
    const restartedPeer = new FakePeerCoordinator();
    restartedPeer.publish(hostsFor("run-2"));
    const second = createHarness(agentDir, () => catalogFor(agentDir, [
      { id: "conv-ws-c", cwd: realpathSync(workspaceC) },
      { id: "conv-ws-a", cwd: realpathSync(workspaceA) },
    ]), { stateRoot: "/synthetic/other-host-state" }, {
      createPeerCoordinator: (coordinatorOptions) => {
        restartedPeer.options = coordinatorOptions;
        return restartedPeer as never;
      },
    });
    const secondManager = await ready(second);
    assert.ok(second.sidebar);
    assert.deepEqual(
      drawnOrder(second.sidebar, all),
      all,
      "the mixed order survives a viewer restart and a new owner run over the same durable slots",
    );
    assert.equal(secondManager.views.length, 2, "restoration started exactly the two remembered local conversations");
    assert.equal(await quit(second), 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a refused network rebuild does not spend a new remote identity's first observation; the accepted one persists it once", async () => {
  const root = makeRoot("refused-observation");
  const agentDir = join(root, "agent");
  mkdirSync(agentDir);
  try {
    const peer = new FakePeerCoordinator();
    const harness = createHarness(agentDir, () => emptyCatalog(agentDir), {}, {
      createPeerCoordinator: (coordinatorOptions) => {
        peer.options = coordinatorOptions;
        return peer as never;
      },
    });
    await ready(harness);
    const sidebar = harness.sidebar;
    assert.ok(sidebar);
    // The sidebar's own rebuild can refuse a snapshot (a thrown projection). The
    // host restores the previous display for that case; what it must NOT do is
    // claim the identity as already observed, because then the identical
    // snapshot accepted afterwards would draw the card without ever saving it.
    const accept = sidebar.setPeerUiSnapshot.bind(sidebar);
    let refused = 0;
    sidebar.setPeerUiSnapshot = (snapshot: PeerUiSnapshot): void => {
      if (refused === 0 && (snapshot.hosts?.length ?? 0) > 0) {
        refused += 1;
        throw new Error("synthetic sidebar rebuild failure");
      }
      accept(snapshot);
    };
    const hosts = [
      peerHost({ id: "h1", hostRunId: "run-1", rows: [remoteCard({ rowId: "rb", workspace: "/remote/ws/b", conversation: "conv-b", rosterSlotId: "slot-b" })] }),
    ];
    peer.publish(hosts);
    await nextTurn();
    assert.equal(refused, 1, "the first rebuild really was refused");
    assert.equal(readRosterStore(agentDir).status, "absent",
      "a refused snapshot publishes no order and spends no first observation");

    // The SAME observation accepted afterwards is still a first observation: it
    // is remembered and published exactly once, with no local session and no
    // reorder action behind it.
    peer.publish(hosts);
    await nextTurn();
    assert.deepEqual(persistedSequence(agentDir), ["remote:h1:slot:slot-b"],
      "the accepted snapshot persists the new identity once, with no extra or missing entry");
    assert.deepEqual(drawnOrder(sidebar, ["Name conv-b"]), ["Name conv-b"],
      "the accepted card sits where the source order places it, as it did before the observation");
    assert.equal(harness.manager?.views.length, 0, "the observation created no local session");
    assert.equal(await quit(harness), 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a remote card that disappears keeps its remembered position and returns to it without a duplicate card", async () => {
  const root = makeRoot("mixed-absence");
  const agentDir = join(root, "agent");
  mkdirSync(agentDir);
  const workspaceA = join(root, "ws-a");
  const workspaceC = join(root, "ws-c");
  for (const workspace of [workspaceA, workspaceC]) mkdirSync(workspace);
  const interleaved = ["Name conv-b", "Name conv-ws-a", "Name conv-ws-c", "Name conv-d"];
  try {
    const peer = new FakePeerCoordinator();
    const harness = createHarness(agentDir, () => emptyCatalog(agentDir), {}, {
      createPeerCoordinator: (coordinatorOptions) => {
        peer.options = coordinatorOptions;
        return peer as never;
      },
    });
    await ready(harness);
    submitFirstNew(harness, workspaceA);
    await nextTurn();
    submitAnotherNew(harness, workspaceC);
    await nextTurn();
    peer.publish([
      peerHost({ id: "h1", hostRunId: "run-1", rows: [remoteCard({ rowId: "rb", workspace: "/remote/ws/b", conversation: "conv-b", rosterSlotId: "slot-b" })] }),
      peerHost({ id: "h2", hostRunId: "run-1", rows: [remoteCard({ rowId: "rd", workspace: "/remote/ws/d", conversation: "conv-d", rosterSlotId: "slot-d" })] }),
    ]);
    await nextTurn();
    const sidebar = harness.sidebar;
    assert.ok(sidebar);
    harness.terminal.emitInput(ALT_LEFT);
    highlightCard(harness, sidebar, "Name conv-b");
    harness.terminal.emitInput(MOVE_KEY);
    harness.terminal.emitInput(UP);
    harness.terminal.emitInput(UP);
    harness.terminal.emitInput(ENTER);
    await nextTurn();
    assert.deepEqual(drawnOrder(sidebar, interleaved), interleaved);

    // Positive loss: no complete roster names those cards any more. Nothing is
    // invented for them, no extra card appears, and the local cards stay put.
    peer.publish([peerHost({ id: "h1", hostRunId: "run-1", rows: [] }), peerHost({ id: "h2", hostRunId: "run-1", rows: [] })]);
    await nextTurn();
    const lines = drawnRoster(sidebar).join("\n");
    assert.equal(lines.includes("Name conv-b"), false, "an unobserved remote card draws no placeholder");
    assert.equal(lines.includes("Name conv-d"), false, "an unobserved remote card draws no placeholder");
    assert.deepEqual(
      drawnOrder(sidebar, ["Name conv-ws-a", "Name conv-ws-c"]),
      ["Name conv-ws-a", "Name conv-ws-c"],
      "the local cards keep their own relative order through the owner's absence",
    );

    // Reconnect over the SAME durable slots: each card reclaims its position.
    peer.publish([
      peerHost({ id: "h1", hostRunId: "run-9", rows: [remoteCard({ rowId: "rb2", workspace: "/remote/ws/b", conversation: "conv-b", rosterSlotId: "slot-b" })] }),
      peerHost({ id: "h2", hostRunId: "run-9", rows: [remoteCard({ rowId: "rd2", workspace: "/remote/ws/d", conversation: "conv-d", rosterSlotId: "slot-d" })] }),
    ]);
    await nextTurn();
    assert.deepEqual(drawnOrder(sidebar, interleaved), interleaved,
      "a matching durable identity reclaims its remembered position instead of appending");
    assert.equal(await quit(harness), 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an owner without a negotiated slot is identified by its exact run and row, so a new owner run appends instead of aliasing", async () => {
  const root = makeRoot("mixed-legacy-run");
  const agentDir = join(root, "agent");
  mkdirSync(agentDir);
  const workspaceA = join(root, "ws-a");
  mkdirSync(workspaceA);
  try {
    const peer = new FakePeerCoordinator();
    const harness = createHarness(agentDir, () => emptyCatalog(agentDir), {}, {
      createPeerCoordinator: (coordinatorOptions) => {
        peer.options = coordinatorOptions;
        return peer as never;
      },
    });
    await ready(harness);
    submitFirstNew(harness, workspaceA);
    await nextTurn();
    peer.publish([peerHost({
      id: "h1",
      hostRunId: "run-1",
      rows: [remoteCard({ rowId: "r1", workspace: "/remote/ws/old", conversation: "conv-old-run" })],
    })]);
    await nextTurn();
    const sidebar = harness.sidebar;
    assert.ok(sidebar);
    assert.deepEqual(drawnOrder(sidebar, ["Name conv-ws-a", "Name conv-old-run"]), ["Name conv-ws-a", "Name conv-old-run"]);

    // Move the legacy card above the local one.
    harness.terminal.emitInput(ALT_LEFT);
    highlightCard(harness, sidebar, "Name conv-old-run");
    harness.terminal.emitInput(MOVE_KEY);
    harness.terminal.emitInput(UP);
    harness.terminal.emitInput(ENTER);
    await nextTurn();
    assert.deepEqual(drawnOrder(sidebar, ["Name conv-old-run", "Name conv-ws-a"]), ["Name conv-old-run", "Name conv-ws-a"]);
    assert.deepEqual(persistedSequence(agentDir), [
      `remote:h1:runtime:${JSON.stringify(["run-1", "r1"])}`,
      "local:row-1",
    ], "the legacy identity names BOTH the observed owner run and the row id");

    // A new owner run reuses the same row id. It is a NEW identity: it appends,
    // and the old position is never guessed at or reused.
    peer.publish([peerHost({
      id: "h1",
      hostRunId: "run-2",
      rows: [remoteCard({ rowId: "r1", workspace: "/remote/ws/new", conversation: "conv-new-run" })],
    })]);
    await nextTurn();
    assert.deepEqual(
      drawnOrder(sidebar, ["Name conv-ws-a", "Name conv-new-run"]),
      ["Name conv-ws-a", "Name conv-new-run"],
      "a reused row id on a new owner run is a different card and appends",
    );
    assert.equal(await quit(harness), 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("first-observed remote positions are saved with no reorder and no local change, and survive a viewer restart with reversed arrival", async () => {
  const root = makeRoot("mixed-observe-persist");
  const agentDir = join(root, "agent");
  mkdirSync(agentDir);
  const workspaceA = join(root, "ws-a");
  mkdirSync(workspaceA);
  const cardB = () => remoteCard({ rowId: "rb", workspace: "/remote/ws/b", conversation: "conv-b", rosterSlotId: "slot-b" });
  const cardD = () => remoteCard({ rowId: "rd", workspace: "/remote/ws/d", conversation: "conv-d", rosterSlotId: "slot-d" });
  const remembered = ["local:row-1", "remote:h1:slot:slot-b", "remote:h2:slot:slot-d"];
  try {
    const peer = new FakePeerCoordinator();
    const first = createHarness(agentDir, () => emptyCatalog(agentDir), {}, {
      createPeerCoordinator: (coordinatorOptions) => {
        peer.options = coordinatorOptions;
        return peer as never;
      },
    });
    await ready(first);
    submitFirstNew(first, workspaceA);
    await nextTurn();
    peer.publish([
      peerHost({ id: "h1", hostRunId: "run-1", rows: [cardB()] }),
      peerHost({ id: "h2", hostRunId: "run-1", rows: [cardD()] }),
    ]);
    await nextTurn();
    assert.deepEqual(persistedSequence(agentDir), remembered,
      "a first observation is published at once, with no reorder and no later local roster change");

    // Positive loss changes nothing in the saved sequence: the positions are
    // retained, not dropped, and an empty-roster observation rewrites nothing.
    peer.publish([
      peerHost({ id: "h1", hostRunId: "run-1", rows: [] }),
      peerHost({ id: "h2", hostRunId: "run-1", rows: [] }),
    ]);
    await nextTurn();
    assert.deepEqual(persistedSequence(agentDir), remembered, "absence never prunes a remembered position");
    assert.equal(await quit(first), 0);

    // Viewer restart: the same durable slots arrive in the OPPOSITE host order.
    // The remembered mixed sequence, not this arrival order, is what draws.
    writeSavedConversation(agentDir, "conv-ws-a", realpathSync(workspaceA));
    const restartedPeer = new FakePeerCoordinator();
    restartedPeer.publish([
      peerHost({ id: "h2", hostRunId: "run-2", rows: [cardD()] }),
      peerHost({ id: "h1", hostRunId: "run-2", rows: [cardB()] }),
    ]);
    const second = createHarness(agentDir, () => catalogFor(agentDir, [
      { id: "conv-ws-a", cwd: realpathSync(workspaceA) },
    ]), { stateRoot: "/synthetic/other-host-state" }, {
      createPeerCoordinator: (coordinatorOptions) => {
        restartedPeer.options = coordinatorOptions;
        return restartedPeer as never;
      },
    });
    await ready(second);
    assert.ok(second.sidebar);
    assert.deepEqual(
      drawnOrder(second.sidebar, ["Name conv-ws-a", "Name conv-b", "Name conv-d"]),
      ["Name conv-ws-a", "Name conv-b", "Name conv-d"],
      "a reversed arrival order cannot re-derive the remembered mixed order",
    );
    assert.deepEqual(persistedSequence(agentDir), remembered, "the restarted host republishes the same sequence");
    assert.equal(await quit(second), 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a maximum-length legacy row id with quotes and backslashes still gets a placement binding and reorders", async () => {
  const root = makeRoot("mixed-legacy-max-id");
  const agentDir = join(root, "agent");
  mkdirSync(agentDir);
  const workspaceA = join(root, "ws-a");
  mkdirSync(workspaceA);
  // The protocol-valid maximum: 256 bytes of quote and backslash characters
  // beside a 64-byte owner run, which escaped is far larger than either part.
  const maximumRowId = `${'"'.repeat(128)}${"\\".repeat(128)}`;
  const maximumRunId = "r".repeat(64);
  try {
    const peer = new FakePeerCoordinator();
    const harness = createHarness(agentDir, () => emptyCatalog(agentDir), {}, {
      createPeerCoordinator: (coordinatorOptions) => {
        peer.options = coordinatorOptions;
        return peer as never;
      },
    });
    await ready(harness);
    submitFirstNew(harness, workspaceA);
    await nextTurn();
    peer.publish([peerHost({
      id: "h1",
      hostRunId: maximumRunId,
      rows: [remoteCard({ rowId: maximumRowId, workspace: "/remote/ws/max", conversation: "conv-max" })],
    })]);
    await nextTurn();
    const sidebar = harness.sidebar;
    assert.ok(sidebar);
    assert.deepEqual(drawnOrder(sidebar, ["Name conv-ws-a", "Name conv-max"]), ["Name conv-ws-a", "Name conv-max"]);

    harness.terminal.emitInput(ALT_LEFT);
    highlightCard(harness, sidebar, "Name conv-max");
    harness.terminal.emitInput(MOVE_KEY);
    harness.terminal.emitInput(UP);
    harness.terminal.emitInput(ENTER);
    await nextTurn();
    assert.deepEqual(
      drawnOrder(sidebar, ["Name conv-max", "Name conv-ws-a"]),
      ["Name conv-max", "Name conv-ws-a"],
      "a maximum-length escaped legacy identity keeps an unambiguous placement binding",
    );
    assert.deepEqual(persistedSequence(agentDir), [
      `remote:h1:runtime:${JSON.stringify([maximumRunId, maximumRowId])}`,
      "local:row-1",
    ], "and its exact identity is what persists");
    assert.equal(await quit(harness), 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("two visible rows naming the same durable slot refuse an ambiguous placement binding while both live cards keep working", async () => {
  const root = makeRoot("mixed-ambiguous");
  const agentDir = join(root, "agent");
  mkdirSync(agentDir);
  const workspaceA = join(root, "ws-a");
  mkdirSync(workspaceA);
  try {
    const peer = new FakePeerCoordinator();
    const harness = createHarness(agentDir, () => emptyCatalog(agentDir), {}, {
      createPeerCoordinator: (coordinatorOptions) => {
        peer.options = coordinatorOptions;
        return peer as never;
      },
    });
    const manager = await ready(harness);
    submitFirstNew(harness, workspaceA);
    await nextTurn();
    peer.publish([peerHost({
      id: "h1",
      hostRunId: "run-1",
      rows: [
        remoteCard({ rowId: "r1", workspace: "/remote/ws/one", conversation: "conv-dup-one", rosterSlotId: "dup-slot" }),
        remoteCard({ rowId: "r2", workspace: "/remote/ws/two", conversation: "conv-dup-two", rosterSlotId: "dup-slot" }),
      ],
    })]);
    await nextTurn();
    const sidebar = harness.sidebar;
    assert.ok(sidebar);
    const before = drawnOrder(sidebar, ["Name conv-ws-a", "Name conv-dup-one", "Name conv-dup-two"]);
    harness.terminal.emitInput(ALT_LEFT);
    highlightCard(harness, sidebar, "Name conv-dup-one");
    harness.terminal.emitInput(MOVE_KEY);
    harness.terminal.emitInput(UP);
    harness.terminal.emitInput(ENTER);
    await nextTurn();
    assert.deepEqual(
      drawnOrder(sidebar, ["Name conv-ws-a", "Name conv-dup-one", "Name conv-dup-two"]),
      before,
      "an ambiguous durable slot is never guessed, converted, or used to retarget a move",
    );
    assert.ok(drawnRoster(sidebar).join(" ").includes("Session order change refused"),
      "the refusal is surfaced instead of silently doing something else");
    assert.deepEqual(manager.views.map((view) => view.id), ["row-1"], "the local session is untouched");
    assert.equal(sidebar.activeMainOwnerID, "row-1", "the displayed local owner is untouched");
    assert.equal(await quit(harness), 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
