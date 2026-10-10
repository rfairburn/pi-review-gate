/**
 * Focused Main-controller regressions for the exited-row deliberate restart
 * (resume-row) wiring: Main consumes resume-row, reads a FRESH exact-binding
 * catalog, uses the retained current native binding (never launch/original or
 * newest guesses), starts an independent child, and replaces the old exited
 * placeholder only on actual ready success. Cancellation only fences the UI or
 * a pre-spawn listing; a started child keeps running and still replaces its old
 * row without stealing focus, visibility, or an active owner.
 *
 * Pure synthetic injection: real branded saved-session admission is NOT minted
 * here (the parent's native/SDK acceptance owns that path). The saved branch is
 * exercised through chooseExitedRestart's refusal rules; the successful saved
 * open path is proven by the existing saved-picker Main tests plus the manager's
 * branded admission tests. No real processes, Git, PTY, or filesystem fixtures
 * are used, and nothing is written or deleted by these tests.
 *
 * Environment: the harness inherits the runner's environment verbatim and then
 * refuses (loudly, without skipping) if a nonempty case-insensitive
 * PI_REVIEW_GATE_RUNTIME_ROLE or PI_REVIEW_GATE_EXECUTOR_TOOL_CATALOG marker is
 * present. It never clears those markers to make Main's fail-closed preflight
 * pass, so run this file in the same unmarked environment CI uses.
 */

import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import type { Writable } from "node:stream";
import test from "node:test";

import type { StatusBroker } from "../src/session-host/broker";
import type { ComposedHostFrame } from "../src/session-host/compositor";
import type { InstanceManagerOptions, NativeInstanceView, ShutdownResult } from "../src/session-host/instances";
import { DEFAULT_HOST_SHORTCUTS } from "../src/session-host/host-shortcuts";
import { EXECUTOR_TOOL_CATALOG_ENV, RUNTIME_ROLE_ENV } from "../src/session-host/launch";
import type { ProfilePreparer } from "../src/session-host/profiles";
import type { SessionHostNativeSession } from "../src/session-host/protocol";
import type { SavedSessionCatalog } from "../src/session-host/saved-sessions";
import { SidebarController } from "../src/session-host/sidebar";
import type { TerminalFrame, TerminalInputModes } from "../src/session-host/terminal-surface";
import { __test, type SessionHostOptions } from "../src/session-host/main";

const ALT_LEFT = "\x1b[1;3D";
const UP = "\x1b[A";
const DOWN = "\x1b[B";
const ENTER = "\r";
const SGR = /\x1b\[[0-9;]*m/g;

class FakeInput extends EventEmitter {
  readonly isTTY = true;
  readableEnded = false;
}

class FakeOutput extends EventEmitter {
  readonly isTTY = true;
  columns = 80;
  rows = 24;
  write(): boolean { return true; }
  end(): this { return this; }
  destroy(): this { return this; }
}

class FakeTerminal {
  kittyProtocolActive = false;
  modifyOtherKeysActive = false;
  columns = 80;
  rows = 24;
  started = false;
  inputHandler?: (data: string) => void;
  resizeHandler?: () => void;

  start(onInput: (data: string) => void, onResize: () => void): void {
    this.inputHandler = onInput;
    this.resizeHandler = onResize;
    this.started = true;
  }
  stop(): void { this.started = false; }
  write(): void {}
  async drainInput(): Promise<void> {}
  emitInput(data: string): void { this.inputHandler?.(data); }
}

class FakeObserver {
  flags = 0;
  disposed = false;
  waitCalls = 0;
  onChange?: (flags: number) => void;
  private resolveWait?: (flags: number) => void;

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
  readonly frames: ComposedHostFrame[] = [];

  start(): void { this.started = true; }
  submit(frame: ComposedHostFrame): void { this.frames.push(frame); }
  async close(): Promise<boolean> { this.closed = true; return true; }
}

class FakeSurface {
  readonly modes: TerminalInputModes = {
    kittyFlags: 0,
    modifyOtherKeys: 0,
    applicationCursorKeys: false,
    applicationKeypad: false,
    bracketedPaste: false,
    mouseTracking: "none",
    mouseEncoding: "default",
  };

  constructor(readonly cols: number, readonly rows: number, private readonly text: string) {}

  frame(): TerminalFrame {
    const lines = Array.from({ length: this.rows }, (_, index) => index === 0 ? this.text : "");
    return { cols: this.cols, rows: this.rows, lines, cursor: { column: 0, row: 0, visible: true } };
  }
  inputModes(): TerminalInputModes { return { ...this.modes }; }
}

class FakeManager {
  readonly options: InstanceManagerOptions;
  readonly views: NativeInstanceView[] = [];
  readonly surfaces = new Map<string, FakeSurface>();
  readonly writes: { id: string; data: string | Buffer }[] = [];
  readonly closeExitedCalls: string[] = [];
  readonly refusedCloseIds = new Set<string>();
  readonly createOptions: { workspace: string; savedSession?: unknown }[] = [];
  ownedLiveSessionsData: { id?: string; file?: string }[] = [];
  onChange?: (id: string) => void;
  nextId = 1;
  createMode: "alive" | "error" = "alive";
  /** When true, create resolves with an owned live process but no authenticated current conversation yet. */
  deferNativeSession = false;
  /** Number of upcoming list() calls that should throw (synthetic native metadata failure). */
  listThrowsRemaining = 0;
  /** Number of upcoming nativeSession metadata reads (via list()) that should throw. */
  nativeSessionReadThrowsRemaining = 0;
  /** Test-only hook fired after the replacement row's roster notification, before create() resolves. */
  onCreateReady?: () => void;
  createGate?: Promise<void>;
  createGateEntered?: () => void;
  stopping = false;
  shutdownCalls = 0;
  disposeCalls = 0;
  private readonly pendingCreates = new Set<Promise<string>>();

  constructor(options: InstanceManagerOptions) {
    this.options = options;
    this.onChange = options.onChange;
  }

  list(): NativeInstanceView[] {
    if (this.listThrowsRemaining > 0) {
      this.listThrowsRemaining -= 1;
      throw new Error("synthetic native metadata failure");
    }
    return this.views.map((view) => {
      const copy: NativeInstanceView = { ...view, activity: [...view.activity] };
      if (this.nativeSessionReadThrowsRemaining > 0) {
        // A throwing metadata getter on the returned row exercises readiness
        // evaluation exception containment without disturbing the source row.
        Object.defineProperty(copy, "nativeSession", {
          enumerable: true,
          configurable: true,
          get: () => {
            if (this.nativeSessionReadThrowsRemaining > 0) {
              this.nativeSessionReadThrowsRemaining -= 1;
              throw new Error("synthetic native metadata getter failure");
            }
            return view.nativeSession;
          },
        });
      }
      return copy;
    });
  }
  surface(id: string): FakeSurface | undefined { return this.surfaces.get(id); }

  closeExited(id: string): boolean {
    this.closeExitedCalls.push(id);
    if (this.refusedCloseIds.has(id)) return false;
    const index = this.views.findIndex((view) => view.id === id);
    const view = this.views[index];
    if (!view || view.lifecycle !== "exited" || view.hasLiveProcess !== false) return false;
    this.views.splice(index, 1);
    this.surfaces.delete(id);
    this.onChange?.(id);
    return true;
  }

  ownedLiveSessions(): { id?: string; file?: string }[] { return [...this.ownedLiveSessionsData]; }

  create(options: { workspace: string; savedSession?: unknown }): Promise<string> {
    this.createOptions.push({ ...options });
    const id = `native-${this.nextId++}`;
    this.surfaces.set(id, new FakeSurface(this.options.cols ?? 80, this.options.rows ?? 24, `frame:${id}`));
    this.views.push({
      id,
      label: "(session starting)",
      workspace: options.workspace,
      agentDir: `/agent/${id}`,
      lifecycle: "starting",
      hasLiveProcess: false,
      busy: null,
      pendingInput: null,
      inputSurface: false,
      activity: [],
      nativeSession: null,
    });
    this.onChange?.(id);
    const pending = this.finishCreate(id);
    this.pendingCreates.add(pending);
    void pending.then(() => this.pendingCreates.delete(pending), () => this.pendingCreates.delete(pending));
    return pending;
  }

  private async finishCreate(id: string): Promise<string> {
    await Promise.resolve();
    if (this.createGate) {
      this.createGateEntered?.();
      await this.createGate;
    }
    const index = this.views.findIndex((view) => view.id === id);
    const view = this.views[index];
    if (!view) throw new Error("missing synthetic create row");
    if (this.stopping || this.createMode === "error") {
      this.views[index] = { ...view, lifecycle: "error", hasLiveProcess: false, error: "synthetic-native-error" };
    } else if (this.deferNativeSession) {
      // Independently owned PTY is alive, but the native Pi child has not yet
      // reported an authenticated current conversation.
      this.views[index] = { ...view, lifecycle: "alive", hasLiveProcess: true, nativeSession: null };
    } else {
      const nativeSession: SessionHostNativeSession = {
        sessionId: `conversation-${id}`,
        epoch: 1,
        name: `Native ${id}`,
      };
      this.views[index] = { ...view, label: nativeSession.name, nativeSession, lifecycle: "alive", hasLiveProcess: true };
    }
    this.onChange?.(id);
    this.onCreateReady?.();
    return id;
  }

  /** Clears the current authenticated conversation without changing liveness. */
  clearNative(id: string): void {
    const index = this.views.findIndex((view) => view.id === id);
    const view = this.views[index];
    if (!view) return;
    this.views[index] = { ...view, nativeSession: null };
    this.onChange?.(id);
  }

  /** Reports an authenticated CURRENT conversation for one replacement child. */
  reportNative(id: string, sessionId: string, epoch = 1, name = `Native ${sessionId}`): void {
    const index = this.views.findIndex((view) => view.id === id);
    const view = this.views[index];
    if (!view) return;
    this.views[index] = { ...view, label: name, nativeSession: { sessionId, epoch, name } };
    this.onChange?.(id);
  }

  /** Retains a last-observed binding privately without reporting a live current one. */
  retainLastNative(id: string, sessionId: string, epoch = 1): void {
    const index = this.views.findIndex((view) => view.id === id);
    const view = this.views[index];
    if (!view) return;
    this.views[index] = { ...view, lastNativeSession: { sessionId, epoch, name: `Retained ${sessionId}` } };
    this.onChange?.(id);
  }

  /** Reports a confirmed actual exit or a fatal native error for one child. */
  reportLoss(id: string, lifecycle: "exited" | "error"): void {
    const index = this.views.findIndex((view) => view.id === id);
    const view = this.views[index];
    if (!view) return;
    this.views[index] = { ...view, lifecycle, hasLiveProcess: false, nativeSession: null };
    this.onChange?.(id);
  }

  write(id: string, data: string | Buffer): void { this.writes.push({ id, data }); }
  resize(): void {}
  hasLiveProcesses(): boolean { return this.views.some((view) => view.hasLiveProcess); }

  async shutdown(): Promise<ShutdownResult> {
    this.shutdownCalls += 1;
    this.stopping = true;
    await Promise.allSettled([...this.pendingCreates]);
    for (let index = 0; index < this.views.length; index += 1) {
      const view = this.views[index];
      if (view?.hasLiveProcess) this.views[index] = { ...view, lifecycle: "exited", hasLiveProcess: false };
    }
    return { forcedIds: [], remainingIds: [] };
  }

  async dispose(): Promise<void> { this.disposeCalls += 1; }
}

type MainTestDependencies = NonNullable<Parameters<typeof __test.runWithDependencies>[1]>;

interface Harness {
  options: SessionHostOptions;
  signals: EventEmitter;
  terminal: FakeTerminal;
  observer: FakeObserver;
  manager?: FakeManager;
  sidebar?: SidebarController;
  reports: string[];
  result: Promise<number>;
  savedCalls: { agentDir: string; piExecutable: string; expectedPiVersion: string; signal: AbortSignal }[];
}

const SAFE_EMPTY_CATALOG: SavedSessionCatalog = {
  agentDir: "/synthetic-agent",
  sessionsRoot: "/synthetic-agent/sessions",
  revision: 1,
  rows: [],
  issues: [],
  issueCount: 0,
};

/**
 * Authorization markers Main's preflight rejects. A synthetic harness must
 * never drop them from an inherited environment to make tests pass: that
 * strips the caller's worker authorization and lets tests run in an
 * environment Main must refuse. Detect them case-insensitively (Windows names
 * are case-insensitive) BEFORE any harness or fixture is constructed, and
 * refuse without mutating the input.
 */
const AUTHORIZATION_MARKER_NAMES: ReadonlySet<string> = new Set([
  RUNTIME_ROLE_ENV.toUpperCase(),
  EXECUTOR_TOOL_CATALOG_ENV.toUpperCase(),
]);

function refuseInheritedAuthorizationMarkers(env: NodeJS.ProcessEnv): void {
  for (const [name, value] of Object.entries(env)) {
    if (typeof value === "string" && value.length > 0 && AUTHORIZATION_MARKER_NAMES.has(name.toUpperCase())) {
      throw new Error(`refusing the synthetic Main harness under an inherited authorization marker: ${name}`);
    }
  }
}

function options(overrides: Partial<SessionHostOptions> = {}): SessionHostOptions {
  // Preserve the inherited environment verbatim, including authorization
  // markers; refuse before construction instead of clearing them. Other
  // inherited values (HOME, PATH, …) stay exactly as the runner supplied them.
  refuseInheritedAuthorizationMarkers(process.env);
  return {
    packageRoot: process.cwd(),
    stateRoot: "/synthetic/session-host-state",
    args: [],
    env: { ...process.env },
    ...overrides,
  };
}

function exitedView(input: {
  id: string;
  workspace: string;
  sessionId: string;
  epoch: number;
  persistence?: "saved" | "unsaved" | "unknown";
}): NativeInstanceView {
  const lastNativeSession: SessionHostNativeSession = {
    sessionId: input.sessionId,
    epoch: input.epoch,
    name: `Retained ${input.sessionId}`,
    ...(input.persistence === undefined ? {} : { persistence: input.persistence }),
  };
  return {
    id: input.id,
    label: lastNativeSession.name,
    workspace: input.workspace,
    agentDir: `/agent/${input.id}`,
    lifecycle: "exited",
    hasLiveProcess: false,
    busy: null,
    pendingInput: null,
    inputSurface: false,
    activity: [],
    nativeSession: null,
    lastNativeSession,
  };
}

function aliveView(id: string, workspace = `/ws/${id}`): NativeInstanceView {
  const nativeSession: SessionHostNativeSession = { sessionId: `live-${id}`, epoch: 1, name: `Live ${id}` };
  return {
    id,
    label: nativeSession.name,
    workspace,
    agentDir: `/agent/${id}`,
    lifecycle: "alive",
    hasLiveProcess: true,
    busy: false,
    pendingInput: false,
    inputSurface: false,
    activity: [],
    nativeSession,
  };
}

/** One immutable-shaped view for the pure readiness-decision regressions. */
function readinessView(
  id: string,
  nativeSession: SessionHostNativeSession | null,
  lifecycle: NativeInstanceView["lifecycle"] = "alive",
  hasLiveProcess = true,
): NativeInstanceView {
  return {
    id,
    label: nativeSession?.name ?? "(session starting)",
    workspace: `/ws/${id}`,
    agentDir: `/agent/${id}`,
    lifecycle,
    hasLiveProcess,
    busy: null,
    pendingInput: null,
    inputSurface: false,
    activity: [],
    nativeSession,
    ...(nativeSession ? { lastNativeSession: nativeSession } : {}),
  };
}

function createHarness(
  managerViews: NativeInstanceView[] = [],
  overrides: Partial<MainTestDependencies> = {},
): Harness {
  const stdin = new FakeInput();
  const stdout = new FakeOutput();
  const signals = new EventEmitter();
  const terminal = new FakeTerminal();
  const observer = new FakeObserver();
  const reports: string[] = [];
  const savedCalls: Harness["savedCalls"] = [];
  const broker = {
    register() { throw new Error("the fake manager never registers children"); },
    async dispose() {},
  } as unknown as StatusBroker;
  let manager: FakeManager | undefined;
  let sidebar: SidebarController | undefined;
  let harness!: Harness;
  const result = __test.runWithDependencies(options(), {
    platform: "linux",
    nodeVersion: "22.19.0",
    stdin,
    stdout: stdout as unknown as Writable & EventEmitter & { isTTY?: boolean; columns?: number; rows?: number },
    signals,
    resolvePi: () => ({ file: "/synthetic/pi", version: "1.0.4" }),
    createBroker: async () => broker,
    createManager: (managerOptions) => {
      manager = new FakeManager(managerOptions);
      manager.views.push(...managerViews);
      for (const view of managerViews) {
        if (view.hasLiveProcess) {
          manager.surfaces.set(view.id, new FakeSurface(managerOptions.cols ?? 80, managerOptions.rows ?? 24, `frame:${view.id}`));
        }
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
      nativeSetup: false,
      nativeAgentDir: "/synthetic-agent",
      profileRegistry: {
        prepare: () => { throw new Error("the fake Main manager must not prepare sessions"); },
      } satisfies ProfilePreparer,
    }),
    readHostShortcutConfig: (agentDir) => {
      assert.equal(agentDir, "/synthetic-agent");
      return { status: "absent", bindings: DEFAULT_HOST_SHORTCUTS };
    },
    writeHostShortcutConfig: () => {
      throw new Error("the synthetic row-resume harness must not write shortcut settings");
    },
    createObserver: (observerOptions) => {
      observer.onChange = observerOptions?.onChange;
      return observer;
    },
    createWriter: () => new FakeWriter(),
    listSavedCatalog: async (listOptions) => {
      savedCalls.push({ ...listOptions });
      return SAFE_EMPTY_CATALOG;
    },
    reportError: (message) => reports.push(message),
    ...overrides,
  });
  harness = { options: options(), signals, terminal, observer, manager, sidebar, reports, result, savedCalls };
  return harness;
}

async function nextTurn(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

async function ready(harness: Harness): Promise<FakeManager> {
  await nextTurn();
  const manager = harness.manager;
  assert.ok(manager, "manager constructed after preflight and broker setup");
  assert.equal(harness.observer.waitCalls, 1, "Main waits for keyboard negotiation before spawning children");
  harness.observer.settle(0);
  await nextTurn();
  return manager;
}

/** Highlights the single roster item from the default New-session selection. */
function highlightOnlyRow(harness: Harness): void {
  harness.terminal.emitInput(UP); // New session -> Saved conversations
  harness.terminal.emitInput(UP); // Saved conversations -> the row
}

function sidebarText(harness: Harness): string {
  return (harness.sidebar?.render(40, 20).lines ?? []).join(" ").replace(SGR, "").replace(/\s+/g, " ");
}

function activeRowIds(manager: FakeManager): string[] {
  return manager.views.map((view) => `${view.id}:${view.lifecycle}`);
}

// ---------------------------------------------------------------------------
// Inherited authorization markers are refused, never stripped
// ---------------------------------------------------------------------------

test("the harness refuses inherited authorization markers instead of clearing them", () => {
  assert.throws(
    () => refuseInheritedAuthorizationMarkers({ PATH: process.env.PATH, [RUNTIME_ROLE_ENV]: "worker" }),
    /authorization marker/,
    "an inherited runtime role is refused",
  );
  assert.throws(
    () => refuseInheritedAuthorizationMarkers({ [RUNTIME_ROLE_ENV.toLowerCase()]: "worker" }),
    /authorization marker/,
    "a case-variant runtime role is refused (Windows names are case-insensitive)",
  );
  assert.throws(
    () => refuseInheritedAuthorizationMarkers({ [EXECUTOR_TOOL_CATALOG_ENV.toUpperCase()]: "catalog" }),
    /authorization marker/,
    "an inherited executor tool catalog is refused",
  );
  assert.doesNotThrow(() => refuseInheritedAuthorizationMarkers({ PATH: "/usr/bin" }));
  assert.doesNotThrow(() => refuseInheritedAuthorizationMarkers({ [RUNTIME_ROLE_ENV]: "" }),
    "an empty marker is not authorization");

  // The refusal inspects only: the caller's environment is never mutated.
  const env: NodeJS.ProcessEnv = { [RUNTIME_ROLE_ENV]: "worker", HOME: "/inherited-home" };
  assert.throws(() => refuseInheritedAuthorizationMarkers(env));
  assert.deepEqual(env, { [RUNTIME_ROLE_ENV]: "worker", HOME: "/inherited-home" },
    "the harness refuses without clearing inherited markers");
});

// ---------------------------------------------------------------------------
// Successful fresh restart of the exact retained unsaved binding
// ---------------------------------------------------------------------------

test("Enter on an exited row restarts the exact retained unsaved binding in the same workspace", async () => {
  const harness = createHarness([exitedView({
    id: "old", workspace: "/ws/original", sessionId: "sess-current", epoch: 2, persistence: "unsaved",
  })]);
  const manager = await ready(harness);
  highlightOnlyRow(harness);
  assert.equal(harness.sidebar?.selectedId, "old");
  harness.terminal.emitInput(ENTER);
  await nextTurn();
  await nextTurn();

  assert.equal(manager.createOptions.length, 1, "exactly one independent child was created");
  assert.deepEqual(manager.createOptions[0], { workspace: "/ws/original" },
    "a known-unsaved binding starts fresh in exactly the same owned workspace, never a saved guess");
  assert.deepEqual(manager.closeExitedCalls, ["old"], "the old exited placeholder was replaced");
  assert.equal(manager.views.length, 1);
  assert.equal(manager.views[0]?.lifecycle, "alive");
  assert.equal(manager.views[0]?.hasLiveProcess, true, "the replacement child keeps running");
  assert.equal(harness.sidebar?.selectedId, "native-1", "the still-current deliberate intent activates the new child");
  assert.equal(harness.sidebar?.focus, "main");
  assert.deepEqual(harness.savedCalls.map((call) => ({
    agentDir: call.agentDir, piExecutable: call.piExecutable, expectedPiVersion: call.expectedPiVersion,
  })), [{ agentDir: "/synthetic-agent", piExecutable: "/synthetic/pi", expectedPiVersion: "1.0.4" }]);
  assert.equal(harness.savedCalls[0]?.signal.aborted, false, "a per-request listing signal is supplied");
  assert.equal(await closeWithSignal(harness), 0);
});

test("a fresh listing is read for every restart attempt and never cached", async () => {
  const harness = createHarness([
    exitedView({ id: "old", workspace: "/ws/one", sessionId: "sess-one", epoch: 1, persistence: "unsaved" }),
  ]);
  const manager = await ready(harness);
  highlightOnlyRow(harness);
  harness.terminal.emitInput(ENTER);
  await nextTurn();
  await nextTurn();
  assert.equal(harness.savedCalls.length, 1);
  assert.deepEqual(manager.createOptions.map((entry) => entry.workspace), ["/ws/one"]);

  // A second exited row restarts from its own fresh catalog read.
  manager.views.push(exitedView({ id: "old-two", workspace: "/ws/two", sessionId: "sess-two", epoch: 1, persistence: "unsaved" }));
  manager.onChange?.("old-two");
  await nextTurn();
  harness.terminal.emitInput(ALT_LEFT); // main -> sidebar focus
  harness.terminal.emitInput(DOWN); // the activated row -> the second exited row
  assert.equal(harness.sidebar?.selectedId, "old-two");
  harness.terminal.emitInput(ENTER);
  await nextTurn();
  await nextTurn();
  assert.equal(harness.savedCalls.length, 2, "each attempt lists the catalog fresh");
  assert.deepEqual(manager.createOptions.map((entry) => entry.workspace), ["/ws/one", "/ws/two"]);
  assert.equal(await closeWithSignal(harness), 0);
});

// ---------------------------------------------------------------------------
// Fail-closed refusals keep the old placeholder
// ---------------------------------------------------------------------------

test("a known-saved binding whose exact row is missing refuses instead of starting fresh", async () => {
  const harness = createHarness([
    exitedView({ id: "old", workspace: "/ws/old", sessionId: "sess-saved", epoch: 1, persistence: "saved" }),
  ]);
  const manager = await ready(harness);
  highlightOnlyRow(harness);
  harness.terminal.emitInput(ENTER);
  await nextTurn();
  await nextTurn();
  assert.equal(manager.createOptions.length, 0, "no silent fresh fallback for a missing known-saved conversation");
  assert.deepEqual(manager.closeExitedCalls, []);
  assert.deepEqual(activeRowIds(manager), ["old:exited"]);
  assert.ok(sidebarText(harness).includes("could not be restarted"));
  assert.equal(await closeWithSignal(harness), 0);
});

test("an unobserved persistence is treated as unknown and refuses instead of starting fresh", async () => {
  const harness = createHarness([
    exitedView({ id: "old", workspace: "/ws/old", sessionId: "sess-unknown", epoch: 1 }),
  ]);
  const manager = await ready(harness);
  highlightOnlyRow(harness);
  harness.terminal.emitInput(ENTER);
  await nextTurn();
  await nextTurn();
  assert.equal(manager.createOptions.length, 0, "missing persistence observation never becomes never-saved");
  assert.deepEqual(activeRowIds(manager), ["old:exited"]);
  assert.equal(await closeWithSignal(harness), 0);
});

test("a rebound binding between listing and spawn refuses without starting a child", async () => {
  let manager: FakeManager | undefined;
  const harness = createHarness([
    exitedView({ id: "old", workspace: "/ws/old", sessionId: "sess-before", epoch: 3, persistence: "unsaved" }),
  ], {
    listSavedCatalog: async (listOptions) => {
      void listOptions;
      // The child rebinds to a different conversation while the read-only
      // listing is in flight.
      if (manager?.views[0]?.lastNativeSession) {
        manager.views[0] = {
          ...manager.views[0],
          lastNativeSession: { sessionId: "sess-after", epoch: 3, name: "Rebound", persistence: "unsaved" },
        };
      }
      return SAFE_EMPTY_CATALOG;
    },
  });
  manager = await ready(harness);
  highlightOnlyRow(harness);
  harness.terminal.emitInput(ENTER);
  await nextTurn();
  await nextTurn();
  assert.equal(manager.createOptions.length, 0, "a rebound row never restarts the wrong conversation");
  assert.equal(manager.closeExitedCalls.length, 0);
  assert.ok(sidebarText(harness).includes("could not be restarted"));
  assert.equal(await closeWithSignal(harness), 0);
});

test("a failed listing keeps the old exited placeholder and starts nothing", async () => {
  const harness = createHarness([
    exitedView({ id: "old", workspace: "/ws/old", sessionId: "sess-x", epoch: 1, persistence: "unsaved" }),
  ], {
    listSavedCatalog: async () => { throw new Error("synthetic listing failure"); },
  });
  const manager = await ready(harness);
  highlightOnlyRow(harness);
  harness.terminal.emitInput(ENTER);
  await nextTurn();
  await nextTurn();
  assert.equal(manager.createOptions.length, 0);
  assert.deepEqual(activeRowIds(manager), ["old:exited"]);
  assert.ok(sidebarText(harness).includes("could not be restarted"));
  assert.equal(await closeWithSignal(harness), 0);
});

test("a new-row error keeps the old exited placeholder and never removes it", async () => {
  const harness = createHarness([
    exitedView({ id: "old", workspace: "/ws/old", sessionId: "sess-x", epoch: 1, persistence: "unsaved" }),
  ]);
  const manager = await ready(harness);
  manager.createMode = "error";
  highlightOnlyRow(harness);
  harness.terminal.emitInput(ENTER);
  await nextTurn();
  await nextTurn();
  assert.equal(manager.createOptions.length, 1);
  assert.equal(manager.closeExitedCalls.length, 0, "only an actual ready success replaces the placeholder");
  assert.ok(manager.views.some((view) => view.id === "old" && view.lifecycle === "exited"));
  assert.equal(await closeWithSignal(harness), 0);
});

test("a replacement tolerates a placeholder the user already removed", async () => {
  const harness = createHarness([
    exitedView({ id: "old", workspace: "/ws/old", sessionId: "sess-x", epoch: 1, persistence: "unsaved" }),
  ]);
  const manager = await ready(harness);
  const gate = deferredCreate(manager);
  highlightOnlyRow(harness);
  harness.terminal.emitInput(ENTER);
  await gate.entered;

  // The user removed the old placeholder while the replacement child started.
  manager.refusedCloseIds.add("old");
  const oldIndex = manager.views.findIndex((view) => view.id === "old");
  manager.views.splice(oldIndex, 1);
  manager.onChange?.("old");
  await nextTurn();

  gate.release();
  await nextTurn();
  await nextTurn();
  assert.deepEqual(manager.closeExitedCalls, ["old"], "the replacement attempts only its own old placeholder");
  assert.ok(manager.views.some((view) => view.id === "native-1" && view.lifecycle === "alive"),
    "the started replacement child stays running and listed");
  assert.ok(!sidebarText(harness).includes("Session not removed"), "an already-removed placeholder is tolerated silently");
  assert.equal(await closeWithSignal(harness), 0);
});

test("a vanished or non-exited target refuses before any spawn", async () => {
  const harness = createHarness([
    exitedView({ id: "old", workspace: "/ws/old", sessionId: "sess-x", epoch: 1, persistence: "unsaved" }),
  ]);
  const manager = await ready(harness);
  highlightOnlyRow(harness);
  // The row becomes a live child again before Enter is delivered.
  manager.views[0] = { ...manager.views[0]!, lifecycle: "alive", hasLiveProcess: true };
  harness.terminal.emitInput(ENTER);
  await nextTurn();
  await nextTurn();
  assert.equal(manager.createOptions.length, 0);
  assert.equal(await closeWithSignal(harness), 0);
});

// ---------------------------------------------------------------------------
// Replacement after cancel, duplicate fencing, and focus preservation
// ---------------------------------------------------------------------------

function deferredCreate(manager: FakeManager): { entered: Promise<void>; release: () => void } {
  let enteredResolve!: () => void;
  const entered = new Promise<void>((resolve) => { enteredResolve = resolve; });
  let releaseResolve!: () => void;
  manager.createGate = new Promise<void>((resolve) => { releaseResolve = resolve; });
  manager.createGateEntered = enteredResolve;
  return { entered, release: releaseResolve };
}

test("a successful replacement after a UI cancel keeps the child and does not steal hidden main focus", async () => {
  const harness = createHarness([
    exitedView({ id: "old", workspace: "/ws/old", sessionId: "sess-x", epoch: 1, persistence: "unsaved" }),
  ]);
  const manager = await ready(harness);
  const gate = deferredCreate(manager);
  highlightOnlyRow(harness);
  harness.terminal.emitInput(ENTER);
  await gate.entered; // the child has started (spawn fenced by the per-row map)

  harness.terminal.emitInput(ALT_LEFT); // hide the sidebar: focus main, cancel the intent
  assert.equal(harness.sidebar?.visible, false);
  assert.equal(harness.sidebar?.focus, "main");

  gate.release();
  await nextTurn();
  await nextTurn();

  assert.deepEqual(manager.closeExitedCalls, ["old"], "an already-started child still replaces its old placeholder");
  assert.equal(manager.views.length, 1);
  assert.equal(manager.views[0]?.lifecycle, "alive");
  assert.equal(manager.views[0]?.hasLiveProcess, true, "a started child is never canceled by a UI cancel");
  assert.equal(harness.sidebar?.visible, false, "the replacement removal does not reshow a hidden pane");
  assert.equal(harness.sidebar?.focus, "main", "the replacement removal does not steal the hidden main focus");
  assert.equal(harness.sidebar?.selectedId, undefined);
  assert.equal(harness.manager?.shutdownCalls, 0, "the replacement never shuts down or stops the child");
  assert.equal(await closeWithSignal(harness), 0);
});

test("a replacement after navigation does not change the newly selected row or active owner", async () => {
  const harness = createHarness([
    exitedView({ id: "old", workspace: "/ws/old", sessionId: "sess-x", epoch: 1, persistence: "unsaved" }),
    aliveView("other"),
  ]);
  const manager = await ready(harness);
  const gate = deferredCreate(manager);
  // entries: [old, other, Saved, New, Quit]; selection starts on New session.
  harness.terminal.emitInput(UP); // New session -> Saved conversations
  harness.terminal.emitInput(UP); // Saved conversations -> the live owner
  assert.equal(harness.sidebar?.selectedId, "other");
  harness.terminal.emitInput(ENTER); // activate the live owner
  assert.equal(harness.sidebar?.focus, "main");
  assert.deepEqual(manager.writes, []);

  // Now select "old" and start a restart, then navigate back to "other" while
  // the child starts.
  harness.terminal.emitInput(ALT_LEFT); // main -> sidebar focus
  harness.terminal.emitInput(UP); // other -> old
  assert.equal(harness.sidebar?.selectedId, "old");
  harness.terminal.emitInput(ENTER);
  await gate.entered;
  harness.terminal.emitInput(DOWN); // cancel: navigate back to "other"
  assert.equal(harness.sidebar?.selectedId, "other");
  gate.release();
  await nextTurn();
  await nextTurn();

  assert.deepEqual(manager.closeExitedCalls, ["old"]);
  assert.deepEqual(manager.views.map((view) => view.id), ["other", "native-1"]);
  assert.equal(harness.sidebar?.selectedId, "other", "a canceled intent never activates the replacement");
  assert.equal(harness.sidebar?.focus, "sidebar");
  assert.equal(await closeWithSignal(harness), 0);
});

test("a duplicate deliberate Enter while a child is already starting never starts a second child", async () => {
  const harness = createHarness([
    exitedView({ id: "old", workspace: "/ws/old", sessionId: "sess-x", epoch: 1, persistence: "unsaved" }),
  ]);
  const manager = await ready(harness);
  const gate = deferredCreate(manager);
  highlightOnlyRow(harness);
  harness.terminal.emitInput(ENTER);
  await gate.entered;

  harness.terminal.emitInput(DOWN); // cancel the UI intent (the child keeps starting)
  harness.terminal.emitInput(UP); // back to the old row
  harness.terminal.emitInput(ENTER); // duplicate request while the child starts
  assert.equal(manager.createOptions.length, 1, "an already-started replacement is never duplicated");
  assert.ok(sidebarText(harness).includes("already restarting"));

  gate.release();
  await nextTurn();
  await nextTurn();
  assert.equal(manager.createOptions.length, 1);
  assert.deepEqual(manager.closeExitedCalls, ["old"]);
  assert.equal(await closeWithSignal(harness), 0);
});

test("canceling before the child starts aborts the listing and allows a clean retry", async () => {
  let resolveListing!: (catalog: SavedSessionCatalog) => void;
  let listingSignal: AbortSignal | undefined;
  let listingCount = 0;
  const harness = createHarness([
    exitedView({ id: "old", workspace: "/ws/old", sessionId: "sess-x", epoch: 1, persistence: "unsaved" }),
  ], {
    listSavedCatalog: (listOptions) => {
      listingCount += 1;
      listingSignal = listOptions.signal;
      if (listingCount > 1) return Promise.resolve(SAFE_EMPTY_CATALOG);
      return new Promise<SavedSessionCatalog>((resolve, reject) => {
        resolveListing = resolve;
        listOptions.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      });
    },
  });
  const manager = await ready(harness);
  highlightOnlyRow(harness);
  harness.terminal.emitInput(ENTER);
  await nextTurn();
  assert.equal(manager.createOptions.length, 0);
  const firstSignal = listingSignal;
  harness.terminal.emitInput(DOWN); // cancel before any spawn
  assert.equal(firstSignal?.aborted, true, "the pre-spawn listing is aborted");

  // The aborted attempt ends cleanly and a fresh retry can start.
  resolveListing(SAFE_EMPTY_CATALOG);
  await nextTurn();
  await nextTurn();
  assert.equal(manager.createOptions.length, 0, "an aborted attempt never spawns");

  harness.terminal.emitInput(UP); // back to the old row
  harness.terminal.emitInput(ENTER);
  await nextTurn();
  await nextTurn();
  assert.equal(listingCount, 2, "a fresh deliberate retry reads the catalog again");
  assert.equal(listingSignal?.aborted, false, "the retry's own listing signal is live");
  assert.equal(manager.createOptions.length, 1);
  assert.equal(await closeWithSignal(harness), 0);
});

test("shutdown aborts an outstanding restart listing and exits cleanly", async () => {
  const harness = createHarness([
    exitedView({ id: "old", workspace: "/ws/old", sessionId: "sess-x", epoch: 1, persistence: "unsaved" }),
  ], {
    listSavedCatalog: (listOptions) => new Promise<SavedSessionCatalog>((_resolve, reject) => {
      listOptions.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    }),
  });
  const manager = await ready(harness);
  highlightOnlyRow(harness);
  harness.terminal.emitInput(ENTER);
  await nextTurn();
  assert.equal(manager.createOptions.length, 0);
  assert.equal(await closeWithSignal(harness), 0, "a pending read-only restart never blocks shutdown");
});

// ---------------------------------------------------------------------------
// Ordinary live-row Enter is unchanged
// ---------------------------------------------------------------------------

test("Enter on a live row still selects it and routes native input", async () => {
  const harness = createHarness([aliveView("live")]);
  const manager = await ready(harness);
  highlightOnlyRow(harness);
  harness.terminal.emitInput(ENTER);
  assert.equal(harness.sidebar?.focus, "main");
  assert.equal(manager.createOptions.length, 0, "activating a live row never creates a child");
  harness.terminal.emitInput("live input");
  assert.deepEqual(manager.writes.at(-1), { id: "live", data: "live input" });
  assert.equal(await closeWithSignal(harness), 0);
});

// ---------------------------------------------------------------------------
// Native-readiness fencing: PTY spawn alone never replaces the old row
// ---------------------------------------------------------------------------

/**
 * Starts a restart whose replacement is only PTY-alive with no authenticated
 * current conversation yet, and returns the independently owned child id.
 */
async function pendingRestartChild(harness: Harness, manager: FakeManager): Promise<string> {
  manager.deferNativeSession = true;
  highlightOnlyRow(harness);
  harness.terminal.emitInput(ENTER);
  await nextTurn();
  await nextTurn();
  const created = manager.views.find((view) => view.id.startsWith("native-"));
  assert.ok(created, "a replacement child was created");
  assert.equal(created.lifecycle, "alive");
  assert.equal(created.hasLiveProcess, true);
  assert.equal(created.nativeSession, null, "PTY alive alone is not authenticated conversation readiness");
  assert.deepEqual(manager.closeExitedCalls, [], "the old placeholder is retained while readiness is unknown");
  return created.id;
}

test("a replacement that is only PTY-alive keeps the old exited placeholder until a genuine conversation arrives", async () => {
  const harness = createHarness([
    exitedView({ id: "old", workspace: "/ws/old", sessionId: "sess-old", epoch: 1, persistence: "unsaved" }),
  ]);
  const manager = await ready(harness);
  const createdId = await pendingRestartChild(harness, manager);
  assert.deepEqual(activeRowIds(manager), ["old:exited", `${createdId}:alive`]);
  assert.equal(harness.sidebar?.selectedId, "old", "no completion happens before authenticated readiness");
  assert.equal(await closeWithSignal(harness), 0);
});

test("a later genuine current conversation replaces exactly the old exited row", async () => {
  const harness = createHarness([
    exitedView({ id: "old", workspace: "/ws/old", sessionId: "sess-old", epoch: 1, persistence: "unsaved" }),
  ]);
  const manager = await ready(harness);
  const createdId = await pendingRestartChild(harness, manager);
  manager.reportNative(createdId, "brand-new-conversation", 1);
  await nextTurn();
  await nextTurn();
  assert.deepEqual(manager.closeExitedCalls, ["old"], "actual native readiness replaces its exact old row");
  assert.deepEqual(manager.views.map((view) => view.id), [createdId]);
  assert.equal(harness.sidebar?.selectedId, createdId);
  assert.equal(harness.sidebar?.focus, "main");
  assert.equal(await closeWithSignal(harness), 0);
});

test("a confirmed exit before any conversation retains the old placeholder", async () => {
  const harness = createHarness([
    exitedView({ id: "old", workspace: "/ws/old", sessionId: "sess-old", epoch: 1, persistence: "unsaved" }),
  ]);
  const manager = await ready(harness);
  const createdId = await pendingRestartChild(harness, manager);
  manager.reportLoss(createdId, "exited");
  await nextTurn();
  await nextTurn();
  assert.deepEqual(manager.closeExitedCalls, []);
  assert.ok(manager.views.some((view) => view.id === "old" && view.lifecycle === "exited"));
  assert.ok(sidebarText(harness).includes("could not be restarted"));
  assert.equal(await closeWithSignal(harness), 0);
});

test("a fatal native error before any conversation retains the old placeholder", async () => {
  const harness = createHarness([
    exitedView({ id: "old", workspace: "/ws/old", sessionId: "sess-old", epoch: 1, persistence: "unsaved" }),
  ]);
  const manager = await ready(harness);
  const createdId = await pendingRestartChild(harness, manager);
  manager.reportLoss(createdId, "error");
  await nextTurn();
  await nextTurn();
  assert.deepEqual(manager.closeExitedCalls, []);
  assert.ok(manager.views.some((view) => view.id === "old" && view.lifecycle === "exited"));
  assert.equal(await closeWithSignal(harness), 0);
});

test("late conversation data after a settled readiness failure never removes the old row or seizes focus", async () => {
  const harness = createHarness([
    exitedView({ id: "old", workspace: "/ws/old", sessionId: "sess-old", epoch: 1, persistence: "unsaved" }),
  ]);
  const manager = await ready(harness);
  const createdId = await pendingRestartChild(harness, manager);
  manager.reportLoss(createdId, "exited");
  await nextTurn();
  await nextTurn();
  assert.deepEqual(manager.closeExitedCalls, []);
  const focusBefore = harness.sidebar?.focus;
  const selectedBefore = harness.sidebar?.selectedId;
  // A late authenticated binding for the already-failed child cannot reverse
  // the settled outcome: the old placeholder stays and focus is untouched.
  manager.reportNative(createdId, "late-conversation", 1);
  await nextTurn();
  await nextTurn();
  assert.deepEqual(manager.closeExitedCalls, []);
  assert.ok(manager.views.some((view) => view.id === "old" && view.lifecycle === "exited"));
  assert.equal(harness.sidebar?.focus, focusBefore);
  assert.equal(harness.sidebar?.selectedId, selectedBefore);
  assert.equal(await closeWithSignal(harness), 0);
});

test("a readiness success cleared before the completion fence retains the old placeholder", async () => {
  const harness = createHarness([
    exitedView({ id: "old", workspace: "/ws/old", sessionId: "sess-old", epoch: 1, persistence: "unsaved" }),
  ]);
  const manager = await ready(harness);
  const createdId = await pendingRestartChild(harness, manager);
  // A valid binding resolves readiness, then a second synchronous status frame
  // clears it before the awaiting completion fence can run.
  manager.reportNative(createdId, "transient-conversation", 1);
  manager.clearNative(createdId);
  await nextTurn();
  await nextTurn();
  assert.deepEqual(manager.closeExitedCalls, [], "a cleared current binding at the final fence is never a removal");
  assert.ok(manager.views.some((view) => view.id === "old" && view.lifecycle === "exited"));
  assert.ok(sidebarText(harness).includes("could not be restarted"));
  assert.equal(await closeWithSignal(harness), 0);
});

test("a roster listing failure immediately before completion retains the old placeholder", async () => {
  const harness = createHarness([
    exitedView({ id: "old", workspace: "/ws/old", sessionId: "sess-old", epoch: 1, persistence: "unsaved" }),
  ]);
  const manager = await ready(harness);
  const createdId = await pendingRestartChild(harness, manager);
  const originalList = manager.list.bind(manager);
  let reads = 0;
  manager.list = () => {
    reads += 1;
    if (reads === 4) throw new Error("synthetic completion roster failure");
    return originalList();
  };
  manager.reportNative(createdId, "ready-conversation", 1);
  assert.equal(await harness.result, 1, "ordinary roster failure still initiates cleanup");
  assert.ok(reads >= 4);
  assert.deepEqual(manager.closeExitedCalls, [], "failed synchronization never removes the old placeholder");
  assert.ok(manager.views.some((view) => view.id === "old" && view.lifecycle === "exited"));
});

test("a saved binding that changes to a different current id at the final fence is refused", () => {
  const exact: SessionHostNativeSession = { sessionId: "saved-conversation", epoch: 1, name: "Saved" };
  const changed: SessionHostNativeSession = { sessionId: "different-conversation", epoch: 2, name: "Changed" };
  assert.equal(__test.rowResumeReadiness(readinessView("native-1", exact), "saved-conversation"), "ready");
  assert.equal(__test.rowResumeReadiness(readinessView("native-1", changed), "saved-conversation"), "failed",
    "a genuinely different current conversation at the final fence is never the requested saved restart");
});

test("a throwing metadata getter during the initial readiness check fails closed and releases task ownership", async () => {
  const harness = createHarness([
    exitedView({ id: "old", workspace: "/ws/old", sessionId: "sess-old", epoch: 1, persistence: "unsaved" }),
  ]);
  const manager = await ready(harness);
  manager.deferNativeSession = true;
  // Arm the throwing getter after the create row's own roster notification so
  // only the readiness evaluation reads it.
  manager.onCreateReady = () => { manager.nativeSessionReadThrowsRemaining = 1; };
  highlightOnlyRow(harness);
  harness.terminal.emitInput(ENTER);
  await nextTurn();
  await nextTurn();
  assert.deepEqual(manager.closeExitedCalls, [], "a throwing metadata read is never readiness");
  assert.ok(manager.views.some((view) => view.id === "old" && view.lifecycle === "exited"));
  assert.ok(sidebarText(harness).includes("could not be restarted"));

  // The settled failure released the per-row duplicate fence: a clean retry
  // starts a fresh child instead of hanging on a leaked waiter.
  manager.onCreateReady = undefined;
  manager.deferNativeSession = false;
  harness.terminal.emitInput(DOWN);
  harness.terminal.emitInput(UP);
  harness.terminal.emitInput(ENTER);
  await nextTurn();
  await nextTurn();
  assert.equal(manager.createOptions.length, 2, "the failed attempt left no stuck task ownership");
  assert.deepEqual(manager.closeExitedCalls, ["old"]);
  assert.equal(await closeWithSignal(harness), 0);
});

test("a throwing metadata getter during a pending readiness wake fails closed and releases task ownership", async () => {
  const harness = createHarness([
    exitedView({ id: "old", workspace: "/ws/old", sessionId: "sess-old", epoch: 1, persistence: "unsaved" }),
  ]);
  const manager = await ready(harness);
  const createdId = await pendingRestartChild(harness, manager);
  manager.nativeSessionReadThrowsRemaining = 1;
  manager.reportNative(createdId, "late-conversation", 1);
  await nextTurn();
  await nextTurn();
  assert.deepEqual(manager.closeExitedCalls, [], "a throwing metadata read during a wake is a failure, not a success");
  assert.ok(manager.views.some((view) => view.id === "old" && view.lifecycle === "exited"));

  manager.nativeSessionReadThrowsRemaining = 0;
  manager.deferNativeSession = false;
  harness.terminal.emitInput(DOWN);
  harness.terminal.emitInput(UP);
  harness.terminal.emitInput(ENTER);
  await nextTurn();
  await nextTurn();
  assert.equal(manager.createOptions.length, 2, "a wake error settles the wait instead of leaving it pending");
  assert.deepEqual(manager.closeExitedCalls, ["old"]);
  assert.equal(await closeWithSignal(harness), 0);
});

test("a retained last-observed binding without a live current conversation never qualifies", async () => {
  const harness = createHarness([
    exitedView({ id: "old", workspace: "/ws/old", sessionId: "sess-old", epoch: 1, persistence: "unsaved" }),
  ]);
  const manager = await ready(harness);
  const createdId = await pendingRestartChild(harness, manager);
  // The manager may retain the old binding privately; it must never substitute
  // for the live current field.
  manager.retainLastNative(createdId, "sess-old", 1);
  await nextTurn();
  await nextTurn();
  assert.deepEqual(manager.closeExitedCalls, []);
  assert.ok(manager.views.some((view) => view.id === "old" && view.lifecycle === "exited"));
  assert.equal(harness.sidebar?.selectedId, "old");
  assert.equal(await closeWithSignal(harness), 0);
});

test("a genuine current conversation that is not the exact saved admission is never readiness", () => {
  const current: SessionHostNativeSession = { sessionId: "current-conversation", epoch: 1, name: "Current" };
  assert.equal(__test.rowResumeReadiness(readinessView("native-1", current), undefined), "ready",
    "a fresh restart accepts any safe current conversation");
  assert.equal(__test.rowResumeReadiness(readinessView("native-1", current), "current-conversation"), "ready",
    "a saved restart accepts exactly its requested admission");
  assert.equal(__test.rowResumeReadiness(readinessView("native-1", current), "other-conversation"), "failed",
    "a saved restart refuses a genuine but different current conversation");
  assert.equal(__test.rowResumeReadiness(readinessView("native-1", null), "current-conversation"), "pending",
    "no current conversation is pending startup, never readiness");
  const retainedOnly: NativeInstanceView = {
    ...readinessView("native-1", null),
    lastNativeSession: { sessionId: "current-conversation", epoch: 1, name: "Retained" },
  };
  assert.equal(__test.rowResumeReadiness(retainedOnly, "current-conversation"), "pending",
    "retained/launch metadata never substitutes for the live current field");
  assert.equal(__test.rowResumeReadiness(undefined, "current-conversation"), "failed",
    "a vanished replacement row fails closed");
  assert.equal(__test.rowResumeReadiness(readinessView("native-1", current, "error", false), undefined), "failed",
    "a fatal native error can never become ready");
  assert.equal(__test.rowResumeReadiness(readinessView("native-1", current, "exited", false), undefined), "failed",
    "a confirmed actual exit can never become ready");
  assert.equal(__test.rowResumeReadiness(readinessView("native-1", current, "starting", false), undefined), "pending",
    "a still-starting row is unknown, never a success");
});

test("a native metadata listing failure while readiness is pending fails closed and retains the old row", async () => {
  const harness = createHarness([
    exitedView({ id: "old", workspace: "/ws/old", sessionId: "sess-old", epoch: 1, persistence: "unsaved" }),
  ]);
  const manager = await ready(harness);
  const createdId = await pendingRestartChild(harness, manager);
  manager.listThrowsRemaining = 1;
  manager.reportNative(createdId, "late-conversation", 1);
  await nextTurn();
  await nextTurn();
  assert.deepEqual(manager.closeExitedCalls, [], "a listing failure is never a readiness success");
  assert.ok(manager.views.some((view) => view.id === "old" && view.lifecycle === "exited"));
  assert.equal(await closeWithSignal(harness), 0);
});

test("a pending readiness success after a UI cancel replaces the old row without stealing hidden main focus", async () => {
  const harness = createHarness([
    exitedView({ id: "old", workspace: "/ws/old", sessionId: "sess-old", epoch: 1, persistence: "unsaved" }),
  ]);
  const manager = await ready(harness);
  const createdId = await pendingRestartChild(harness, manager);
  harness.terminal.emitInput(ALT_LEFT); // hide the sidebar: focus main, cancel the intent
  assert.equal(harness.sidebar?.visible, false);
  assert.equal(harness.sidebar?.focus, "main");
  manager.reportNative(createdId, "late-conversation", 1);
  await nextTurn();
  await nextTurn();
  assert.deepEqual(manager.closeExitedCalls, ["old"], "an eventual readiness success still replaces the old row");
  assert.equal(manager.views.length, 1);
  assert.equal(manager.views[0]?.id, createdId);
  assert.equal(manager.views[0]?.lifecycle, "alive");
  assert.equal(harness.sidebar?.visible, false, "the replacement does not reshow a hidden pane");
  assert.equal(harness.sidebar?.focus, "main", "the replacement does not steal the hidden main focus");
  assert.equal(harness.sidebar?.selectedId, undefined);
  assert.equal(manager.shutdownCalls, 0, "the replacement never shuts down or stops the child");
  assert.equal(await closeWithSignal(harness), 0);
});

test("a pending readiness success after navigation keeps another active owner selected", async () => {
  const harness = createHarness([
    exitedView({ id: "old", workspace: "/ws/old", sessionId: "sess-old", epoch: 1, persistence: "unsaved" }),
    aliveView("other"),
  ]);
  const manager = await ready(harness);
  manager.deferNativeSession = true;
  // entries: [old, other, Saved, New, Quit]; selection starts on New session.
  harness.terminal.emitInput(UP); // New session -> Saved conversations
  harness.terminal.emitInput(UP); // Saved conversations -> the live owner
  harness.terminal.emitInput(UP); // the live owner -> the exited row
  assert.equal(harness.sidebar?.selectedId, "old");
  harness.terminal.emitInput(ENTER);
  await nextTurn();
  await nextTurn();
  const created = manager.views.find((view) => view.id.startsWith("native-"));
  assert.ok(created);
  assert.equal(created.nativeSession, null);

  harness.terminal.emitInput(DOWN); // cancel: navigate back to the live owner
  assert.equal(harness.sidebar?.selectedId, "other");
  manager.reportNative(created.id, "late-conversation", 1);
  await nextTurn();
  await nextTurn();
  assert.deepEqual(manager.closeExitedCalls, ["old"]);
  assert.deepEqual(manager.views.map((view) => view.id), ["other", created.id]);
  assert.equal(harness.sidebar?.selectedId, "other", "a canceled intent never activates the replacement");
  assert.equal(harness.sidebar?.focus, "sidebar");
  assert.equal(await closeWithSignal(harness), 0);
});

test("a duplicate deliberate Enter while native readiness is pending never starts a second child", async () => {
  const harness = createHarness([
    exitedView({ id: "old", workspace: "/ws/old", sessionId: "sess-old", epoch: 1, persistence: "unsaved" }),
  ]);
  const manager = await ready(harness);
  const createdId = await pendingRestartChild(harness, manager);
  harness.terminal.emitInput(DOWN); // cancel the UI intent (the child keeps starting)
  harness.terminal.emitInput(UP); // back to the old row
  harness.terminal.emitInput(ENTER); // duplicate request while readiness is pending
  assert.equal(manager.createOptions.length, 1, "a pending replacement is never duplicated");
  assert.ok(sidebarText(harness).includes("already restarting"));
  manager.reportNative(createdId, "late-conversation", 1);
  await nextTurn();
  await nextTurn();
  assert.equal(manager.createOptions.length, 1);
  assert.deepEqual(manager.closeExitedCalls, ["old"]);
  assert.equal(await closeWithSignal(harness), 0);
});

test("shutdown settles a pending native-readiness wait instead of waiting for the deadline", async () => {
  const harness = createHarness([
    exitedView({ id: "old", workspace: "/ws/old", sessionId: "sess-old", epoch: 1, persistence: "unsaved" }),
  ]);
  const manager = await ready(harness);
  const createdId = await pendingRestartChild(harness, manager);
  assert.ok(manager.views.some((view) => view.id === createdId && view.nativeSession === null));
  assert.equal(await closeWithSignal(harness), 0, "shutdown settles readiness rather than hanging for 60s");
  assert.deepEqual(manager.closeExitedCalls, [], "shutdown never removes the old row through a pending wait");
  assert.ok(manager.views.some((view) => view.id === "old" && view.lifecycle === "exited"));
});

async function closeWithSignal(harness: Harness, signal = "SIGTERM"): Promise<number> {
  harness.signals.emit(signal);
  return harness.result;
}
