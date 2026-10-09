import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import type { Writable } from "node:stream";
import test from "node:test";

import type { ComposedHostFrame } from "../src/session-host/compositor";
import type { InstanceManagerOptions, NativeInstanceView, ShutdownResult, StopInstanceResult } from "../src/session-host/instances";
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
  readRosterStore,
  writeRosterStore,
} from "../src/session-host/roster-store";
import { __test, type SessionHostOptions } from "../src/session-host/main";

/**
 * Focused hermetic Main-level tests for the global sidebar roster (#331).
 *
 * Main is driven through the internal `__test.runWithDependencies` seam with a
 * fake manager, but the roster store, exclusive ownership record, and saved
 * conversation catalog are the REAL implementations against a fresh temporary
 * Pi agent directory under node_modules/.cache. No real user agent data, lock,
 * or saved conversation is ever read, written, or removed.
 */

const ESC = "\x1b";
const ALT_LEFT = `${ESC}[1;3D`;
const ALT_RIGHT = `${ESC}[1;3C`;
const ENTER = "\r";
const DELETE = `${ESC}[3~`;
const UP = `${ESC}[A`;
const DOWN = `${ESC}[B`;
const SCRATCH_ROOT = join(process.cwd(), "node_modules", ".cache", "session-host-roster-main-tests");
const SESSION_TIMESTAMP = "2025-01-01T00:00:00.000Z";

function makeRoot(prefix: string): string {
  mkdirSync(SCRATCH_ROOT, { recursive: true });
  return realpathSync(mkdtempSync(join(SCRATCH_ROOT, `${prefix}-`)));
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

  resize(): void {}

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
    nodeVersion: "22.19.0",
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
    assert.deepEqual(roster?.entries.map((entry) => entry.sessionId), ["conv-ws-a", "conv-ws-b"]);
    assert.equal(roster?.activeSlotId, "row-2");
    assert.equal(roster?.entries.some((entry) => entry.sessionId === "conv-ws-c"), false);

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
      stored.status === "loaded" ? stored.roster.entries[1]?.persistence : undefined,
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
      afterRemoval.status === "loaded" ? afterRemoval.roster.entries.map((entry) => entry.sessionId) : undefined,
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
      stored.status === "loaded" ? stored.roster.entries.map((entry) => entry.sessionId) : undefined,
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
      afterSecond.status === "loaded" ? afterSecond.roster.entries.map((entry) => entry.slotId) : undefined,
      ["row-1", "row-2", "row-3"],
      "the persisted order is unchanged by a mid-list unavailable entry",
    );
    assert.deepEqual(
      afterSecond.status === "loaded" ? afterSecond.roster.entries.map((entry) => entry.sessionId) : undefined,
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
    const entries = stored.status === "loaded" ? stored.roster.entries : [];
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
    const entries = stored.status === "loaded" ? stored.roster.entries : [];
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
      stored.status === "loaded" ? stored.roster.entries.map((entry) => entry.slotId) : undefined,
      ["old", "other"],
      "the stable slot id is transferred into the old position",
    );
    assert.deepEqual(
      stored.status === "loaded" ? stored.roster.entries.map((entry) => entry.sessionId) : undefined,
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
