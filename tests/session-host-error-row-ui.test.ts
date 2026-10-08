/**
 * Focused Main/Sidebar regressions for the normal `d` cleanup and
 * confirmation flow on errored session rows: a settled (no live process)
 * error row requests the same deliberate removal as an exited row, and Main
 * falls back to the manager's optional closeError only when closeExited
 * refuses and the exact current row is still in "error" lifecycle. The error
 * badge is never exit or force authority: resume replacements stay
 * closeExited-only, live error rows use the unchanged stop/confirmation
 * flow, and a missing method, refusal, or thrown closeError retains the row
 * with an honest bounded notice.
 *
 * Evidence scope (source-only, synthetic): every case drives the public
 * Main/Sidebar surface through `__test.runWithDependencies` with a fake
 * manager and protocol fakes only. This file is NOT native acceptance: it
 * does not prove real Pi runtime, PTY behavior, broker/protocol integration,
 * or the manager's own closeError authority (covered by the manager error
 * tests). No real processes, Git, PTY, or filesystem fixtures are used and
 * nothing is written or deleted by these tests.
 *
 * Environment: the harness inherits the runner's environment verbatim and
 * then refuses (loudly, without skipping) if any case-insensitive
 * PI_REVIEW_GATE_RUNTIME_ROLE or PI_REVIEW_GATE_EXECUTOR_TOOL_CATALOG marker
 * is present. It never clears those markers to make Main's fail-closed
 * preflight pass, so run this file in the same unmarked environment CI uses.
 */

import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import type { Writable } from "node:stream";
import test from "node:test";

import { isKittyProtocolActive, setKittyProtocolActive } from "pi-session-host-tui";
import type { StatusBroker } from "../src/session-host/broker";
import type { ComposedHostFrame } from "../src/session-host/compositor";
import type { InstanceManagerOptions, NativeInstanceView, ShutdownResult, StopInstanceResult } from "../src/session-host/instances";
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
const DELETE = "\x1b[3~";
const DELETE_REPEAT = "\x1b[127;1:2u";
const DELETE_RELEASE = "\x1b[127;1:3u";
const PASTE_WITH_D = "\x1b[200~d\x1b[201~";
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

/** How the fake manager's optional closeError behaves for a removable error row. */
type CloseErrorBehavior = "absent" | "true" | "throw";

class FakeManager {
  readonly options: InstanceManagerOptions;
  readonly views: NativeInstanceView[] = [];
  readonly surfaces = new Map<string, FakeSurface>();
  readonly writes: { id: string; data: string | Buffer }[] = [];
  readonly closeExitedCalls: string[] = [];
  readonly closeErrorCalls: string[] = [];
  readonly stopCalls: { id: string; confirmed: boolean }[] = [];
  readonly createOptions: { workspace: string; savedSession?: unknown }[] = [];
  /** Rows whose exact owned PTY has a confirmed exit (the strict closeExited path). */
  readonly exitedPtyIds = new Set<string>();
  /** Rows whose launch has not positively settled; closeError refuses them. */
  readonly pendingLaunchIds = new Set<string>();
  closeErrorBehavior: CloseErrorBehavior;
  stopOutcome: StopInstanceResult["status"] = "exited";
  ownedLiveSessionsData: { id?: string; file?: string }[] = [];
  onChange?: (id: string) => void;
  nextId = 1;
  stopping = false;
  shutdownCalls = 0;
  disposeCalls = 0;
  createGate?: Promise<void>;
  createGateEntered?: () => void;
  closeError?: (id: string) => boolean;

  constructor(options: InstanceManagerOptions, closeErrorBehavior: CloseErrorBehavior = "true") {
    this.options = options;
    this.onChange = options.onChange;
    this.closeErrorBehavior = closeErrorBehavior;
    // A legacy manager simply has no closeError method at all.
    if (closeErrorBehavior !== "absent") {
      this.closeError = (id: string): boolean => {
        this.closeErrorCalls.push(id);
        if (this.closeErrorBehavior === "throw") throw new Error("synthetic closeError failure");
        const index = this.views.findIndex((view) => view.id === id);
        const view = this.views[index];
        if (!view || view.lifecycle !== "error" || view.hasLiveProcess !== false) return false;
        if (this.pendingLaunchIds.has(id)) return false;
        // The exact original PTY exit stays on the strict closeExited path.
        if (this.exitedPtyIds.has(id)) return this.closeExited(id);
        this.views.splice(index, 1);
        this.surfaces.delete(id);
        this.onChange?.(id);
        return true;
      };
    }
  }

  list(): NativeInstanceView[] {
    return this.views.map((view) => ({ ...view, activity: [...view.activity] }));
  }
  surface(id: string): FakeSurface | undefined { return this.surfaces.get(id); }

  closeExited(id: string): boolean {
    this.closeExitedCalls.push(id);
    if (!this.exitedPtyIds.has(id)) return false;
    const index = this.views.findIndex((view) => view.id === id);
    if (index < 0) return false;
    this.views.splice(index, 1);
    this.surfaces.delete(id);
    this.onChange?.(id);
    return true;
  }

  async stop(id: string, options: { readonly confirmed: boolean }): Promise<StopInstanceResult> {
    this.stopCalls.push({ id, confirmed: options.confirmed });
    if (this.stopOutcome === "exited") {
      const index = this.views.findIndex((view) => view.id === id);
      const view = this.views[index];
      if (view) {
        // The exact owned PTY exits; the row becomes strictly closeExited-able.
        this.views[index] = { ...view, lifecycle: "exited", hasLiveProcess: false };
        this.exitedPtyIds.add(id);
        this.onChange?.(id);
      }
    }
    return { status: this.stopOutcome, forced: false };
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
    void pending.then(() => undefined, () => undefined);
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
    const nativeSession: SessionHostNativeSession = {
      sessionId: `conversation-${id}`,
      epoch: 1,
      name: `Native ${id}`,
    };
    this.views[index] = { ...view, label: nativeSession.name, nativeSession, lifecycle: "alive", hasLiveProcess: true };
    this.onChange?.(id);
    return id;
  }

  write(id: string, data: string | Buffer): void { this.writes.push({ id, data }); }
  resize(): void {}
  hasLiveProcesses(): boolean { return this.views.some((view) => view.hasLiveProcess); }

  async rename(): Promise<never> { throw new Error("rename is not exercised by these tests"); }

  async shutdown(): Promise<ShutdownResult> {
    this.shutdownCalls += 1;
    this.stopping = true;
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
  for (const name of Object.keys(env)) {
    if (AUTHORIZATION_MARKER_NAMES.has(name.toUpperCase())) {
      throw new Error(`refusing the synthetic Main harness under an inherited authorization marker: ${name}`);
    }
  }
}

function options(overrides: Partial<SessionHostOptions> = {}): SessionHostOptions {
  // Preserve the inherited environment verbatim, including authorization
  // markers; refuse before construction instead of clearing them.
  refuseInheritedAuthorizationMarkers(process.env);
  return {
    packageRoot: process.cwd(),
    stateRoot: "/synthetic/session-host-state",
    args: [],
    env: { ...process.env },
    ...overrides,
  };
}

function errorView(id: string, overrides: Partial<NativeInstanceView> = {}): NativeInstanceView {
  return {
    id,
    label: `Error ${id}`,
    workspace: `/ws/${id}`,
    agentDir: `/agent/${id}`,
    lifecycle: "error",
    hasLiveProcess: false,
    busy: null,
    pendingInput: null,
    inputSurface: false,
    activity: [],
    nativeSession: null,
    error: "synthetic-native-error",
    ...overrides,
  };
}

function aliveView(id: string): NativeInstanceView {
  const nativeSession: SessionHostNativeSession = { sessionId: `live-${id}`, epoch: 1, name: `Live ${id}` };
  return {
    id,
    label: nativeSession.name,
    workspace: `/ws/${id}`,
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

function exitedView(input: { id: string; workspace: string; sessionId: string; epoch: number; persistence?: "saved" | "unsaved" }): NativeInstanceView {
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

function createHarness(
  managerViews: NativeInstanceView[] = [],
  overrides: Partial<MainTestDependencies> & { optionOverrides?: Partial<SessionHostOptions>; closeErrorBehavior?: CloseErrorBehavior } = {},
): Harness {
  const { optionOverrides, closeErrorBehavior, ...dependencyOverrides } = overrides;
  const stdin = new FakeInput();
  const stdout = new FakeOutput();
  const signals = new EventEmitter();
  const terminal = new FakeTerminal();
  const observer = new FakeObserver();
  const reports: string[] = [];
  const broker = {
    register() { throw new Error("the fake manager never registers children"); },
    async dispose() {},
  } as unknown as StatusBroker;
  let manager: FakeManager | undefined;
  let sidebar: SidebarController | undefined;
  let harness!: Harness;
  const result = __test.runWithDependencies(options(optionOverrides), {
    platform: "linux",
    nodeVersion: "22.19.0",
    stdin,
    stdout: stdout as unknown as Writable & EventEmitter & { isTTY?: boolean; columns?: number; rows?: number },
    signals,
    resolvePi: () => ({ file: "/synthetic/pi", version: "1.0.4" }),
    createBroker: async () => broker,
    createManager: (managerOptions) => {
      manager = new FakeManager(managerOptions, closeErrorBehavior);
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
    createObserver: (observerOptions) => {
      observer.onChange = observerOptions?.onChange;
      return observer;
    },
    createWriter: () => new FakeWriter(),
    listSavedCatalog: async () => SAFE_EMPTY_CATALOG,
    reportError: (message) => reports.push(message),
    ...dependencyOverrides,
  });
  harness = { options: options(optionOverrides), signals, terminal, observer, manager, sidebar, reports, result };
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

/** Moves the default New-session selection up to the given roster row. */
function highlightRow(harness: Harness, ups: number): void {
  for (let index = 0; index < ups; index += 1) harness.terminal.emitInput(UP);
}

function sidebarText(harness: Harness): string {
  return (harness.sidebar?.render(40, 20).lines ?? []).join(" ").replace(SGR, "").replace(/\s+/g, " ");
}

async function closeWithSignal(harness: Harness, signal = "SIGTERM"): Promise<number> {
  harness.signals.emit(signal);
  return harness.result;
}

// ---------------------------------------------------------------------------
// Settled no-child error rows use the normal d removal flow
// ---------------------------------------------------------------------------

test("error UI harness refuses original authorization names including empty case aliases", () => {
  for (const name of [RUNTIME_ROLE_ENV, EXECUTOR_TOOL_CATALOG_ENV]) {
    for (const alias of [name, name.toLowerCase()]) {
      for (const value of ["", "executor"]) {
        const env = { [alias]: value, NODE_OPTIONS: "--no-warnings" };
        assert.throws(() => refuseInheritedAuthorizationMarkers(env), /inherited authorization marker/);
        assert.equal(env[alias], value);
        assert.equal(env.NODE_OPTIONS, "--no-warnings");
      }
    }
  }
});

test("d on a settled no-child error row removes it through the manager's closeError", async () => {
  const harness = createHarness([errorView("err")]);
  const manager = await ready(harness);
  highlightRow(harness, 2); // New session -> Saved conversations -> err
  assert.equal(harness.sidebar?.selectedId, "err");
  harness.terminal.emitInput("d");
  await nextTurn();

  assert.deepEqual(manager.views, [], "the settled error row is removed");
  assert.deepEqual(manager.closeExitedCalls, ["err"], "closeExited is tried first and refuses");
  assert.deepEqual(manager.closeErrorCalls, ["err"], "the optional closeError closes the exact row");
  assert.ok(!sidebarText(harness).includes("not removed"), "no refusal or failure notice on success");
  assert.equal(await closeWithSignal(harness), 0);
});

test("d on a settled error row with a legacy manager without closeError retains the row with the bounded refusal", async () => {
  const harness = createHarness([errorView("err")], { closeErrorBehavior: "absent" });
  const manager = await ready(harness);
  assert.equal(manager.closeError, undefined, "the legacy fake has no closeError method");
  highlightRow(harness, 2);
  harness.terminal.emitInput("d");
  await nextTurn();

  assert.deepEqual(manager.views.map((view) => view.id), ["err"], "the row is retained");
  assert.deepEqual(manager.closeExitedCalls, ["err"]);
  assert.deepEqual(manager.closeErrorCalls, []);
  assert.ok(sidebarText(harness).includes("Session not removed; it may be live, unconfirmed, or no longer available."),
    "the bounded refusal notice is shown");
  assert.equal(await closeWithSignal(harness), 0);
});

test("d on a pending-launch error row is refused by the manager and retained", async () => {
  const harness = createHarness([errorView("err")]);
  const manager = await ready(harness);
  manager.pendingLaunchIds.add("err"); // the launch has not positively settled
  highlightRow(harness, 2);
  harness.terminal.emitInput("d");
  await nextTurn();

  assert.deepEqual(manager.closeErrorCalls, ["err"], "closeError was attempted on the exact row");
  assert.deepEqual(manager.views.map((view) => view.id), ["err"], "the unsettled row is retained");
  assert.ok(sidebarText(harness).includes("Session not removed; it may be live, unconfirmed, or no longer available."),
    "the bounded refusal notice is shown");
  assert.equal(await closeWithSignal(harness), 0);
});

test("a throwing closeError keeps the row with the generic failure notice", async () => {
  const harness = createHarness([errorView("err")], { closeErrorBehavior: "throw" });
  const manager = await ready(harness);
  highlightRow(harness, 2);
  harness.terminal.emitInput("d");
  await nextTurn();

  assert.deepEqual(manager.closeErrorCalls, ["err"]);
  assert.deepEqual(manager.views.map((view) => view.id), ["err"], "the row is retained after a thrown closeError");
  assert.ok(sidebarText(harness).includes("Session was not removed; its state could not be confirmed."),
    "the honest generic failure notice is shown");
  assert.equal(await closeWithSignal(harness), 0);
});

test("an error row whose exact owned PTY exited removes through the strict closeExited path only", async () => {
  const harness = createHarness([errorView("err")]);
  const manager = await ready(harness);
  manager.exitedPtyIds.add("err"); // the original child's confirmed exit
  highlightRow(harness, 2);
  harness.terminal.emitInput("d");
  await nextTurn();

  assert.deepEqual(manager.views, [], "the row is removed through its exact owned exit");
  assert.deepEqual(manager.closeExitedCalls, ["err"]);
  assert.deepEqual(manager.closeErrorCalls, [], "closeError is never consulted once closeExited succeeds");
  assert.equal(await closeWithSignal(harness), 0);
});

// ---------------------------------------------------------------------------
// Live error rows keep the unchanged stop and confirmation flow
// ---------------------------------------------------------------------------

test("d on a live completely-idle error row stops it directly without confirmation", async () => {
  const harness = createHarness([errorView("err", {
    lifecycle: "error",
    hasLiveProcess: true,
    busy: false,
    pendingInput: false,
    inputSurface: false,
    backgroundTasks: 0,
    backgroundShells: 0,
  })]);
  const manager = await ready(harness);
  highlightRow(harness, 2);
  harness.terminal.emitInput("d");
  await nextTurn();

  assert.deepEqual(manager.stopCalls, [{ id: "err", confirmed: false }], "complete idleness authorizes the direct stop");
  assert.equal(harness.sidebar?.focus, "sidebar", "no confirmation pane was opened");
  assert.deepEqual(manager.views, [], "the actual owned exit precedes removal");
  assert.deepEqual(manager.closeErrorCalls, [], "removal after an owned exit never consults closeError");
  assert.equal(await closeWithSignal(harness), 0);
});

test("d on a live unknown-state error row opens the frozen confirmation; Enter stops and removes", async () => {
  const harness = createHarness([errorView("err", { lifecycle: "error", hasLiveProcess: true, busy: null })]);
  const manager = await ready(harness);
  highlightRow(harness, 2);
  harness.terminal.emitInput("d");
  assert.equal(harness.sidebar?.focus, "confirm", "unknown activity requires explicit confirmation");
  await nextTurn(); // the complete warning must be drawn before a stop

  harness.terminal.emitInput(ENTER);
  await nextTurn();

  assert.deepEqual(manager.stopCalls, [{ id: "err", confirmed: true }]);
  assert.deepEqual(manager.views, []);
  assert.deepEqual(manager.closeErrorCalls, []);
  assert.equal(await closeWithSignal(harness), 0);
});

test("the live-error stop confirmation can be cancelled without any stop or removal", async () => {
  const harness = createHarness([errorView("err", { lifecycle: "error", hasLiveProcess: true, busy: null })]);
  const manager = await ready(harness);
  highlightRow(harness, 2);
  harness.terminal.emitInput("d");
  assert.equal(harness.sidebar?.focus, "confirm");
  await nextTurn();

  harness.terminal.emitInput("n");
  await nextTurn();

  assert.deepEqual(manager.stopCalls, [], "cancellation sends no stop");
  assert.deepEqual(manager.views.map((view) => view.id), ["err"], "the row is retained");
  assert.equal(harness.sidebar?.focus, "sidebar", "sidebar input ownership is preserved");
  assert.equal(harness.sidebar?.selectedId, "err", "the highlighted row is preserved");
  assert.deepEqual(manager.closeErrorCalls, []);
  assert.equal(await closeWithSignal(harness), 0);
});

test("a vanished live-error target refuses the frozen confirmation without touching a sibling", async () => {
  const harness = createHarness([
    errorView("err", { lifecycle: "error", hasLiveProcess: true, busy: null }),
    aliveView("sib"),
  ]);
  const manager = await ready(harness);
  highlightRow(harness, 3); // New -> Saved -> sib -> err
  assert.equal(harness.sidebar?.selectedId, "err");
  harness.terminal.emitInput("d");
  assert.equal(harness.sidebar?.focus, "confirm");
  await nextTurn();

  // The target exits and is detached while the confirmation is open.
  manager.views.splice(0, 1);
  manager.onChange?.("err");
  await nextTurn();

  harness.terminal.emitInput(ENTER);
  await nextTurn();

  assert.deepEqual(manager.stopCalls, [], "the frozen vanished target is never stopped");
  assert.ok(sidebarText(harness).includes("Session no longer exists"));
  assert.deepEqual(manager.views.map((view) => view.id), ["sib"], "the sibling is untouched and not activated");
  assert.equal(harness.sidebar?.focus, "sidebar");
  assert.equal(await closeWithSignal(harness), 0);
});

test("a live-error row that exits on its own before confirmation is refused, then removes via the exact exit", async () => {
  const harness = createHarness([errorView("err", { lifecycle: "error", hasLiveProcess: true, busy: null })]);
  const manager = await ready(harness);
  highlightRow(harness, 2);
  harness.terminal.emitInput("d");
  assert.equal(harness.sidebar?.focus, "confirm");
  await nextTurn();

  // The child exits on its own while the confirmation is open.
  const view = manager.views[0];
  assert.ok(view);
  manager.views[0] = { ...view, hasLiveProcess: false };
  manager.exitedPtyIds.add("err");
  manager.onChange?.("err");
  await nextTurn();

  harness.terminal.emitInput(ENTER);
  await nextTurn();

  assert.deepEqual(manager.stopCalls, [], "a no-longer-live target is refused, never stopped");
  assert.ok(sidebarText(harness).includes("Session is no longer live"));
  assert.deepEqual(manager.views.map((view) => view.id), ["err"], "the row stays until the actual-exit removal");

  // The same d flow now removes it through its exact owned exit.
  harness.terminal.emitInput("d");
  await nextTurn();

  assert.deepEqual(manager.views, []);
  assert.deepEqual(manager.closeExitedCalls, ["err"], "removal uses the strict exact-exit path only");
  assert.deepEqual(manager.closeErrorCalls, []);
  assert.equal(await closeWithSignal(harness), 0);
});

// ---------------------------------------------------------------------------
// Resume replacement stays closeExited-only
// ---------------------------------------------------------------------------

function deferredCreate(manager: FakeManager): { entered: Promise<void>; release: () => void } {
  let enteredResolve!: () => void;
  const entered = new Promise<void>((resolve) => { enteredResolve = resolve; });
  let releaseResolve!: () => void;
  manager.createGate = new Promise<void>((resolve) => { releaseResolve = resolve; });
  manager.createGateEntered = enteredResolve;
  return { entered, release: releaseResolve };
}

test("resume replacement never calls closeError even when the old row becomes a removable error", async () => {
  const harness = createHarness([exitedView({
    id: "old", workspace: "/ws/old", sessionId: "sess-current", epoch: 2, persistence: "unsaved",
  })]);
  const manager = await ready(harness);
  const gate = deferredCreate(manager);
  highlightRow(harness, 2);
  harness.terminal.emitInput(ENTER); // deliberate restart of the exited row
  await gate.entered;

  // The old placeholder becomes a settled no-child error while the replacement
  // child starts: closeError would succeed on it, but the replacement must
  // stay closeExited-only (its closeExited refuses: no confirmed PTY exit).
  const oldIndex = manager.views.findIndex((view) => view.id === "old");
  const oldView = manager.views[oldIndex];
  assert.ok(oldView);
  manager.views[oldIndex] = {
    ...oldView,
    lifecycle: "error",
    hasLiveProcess: false,
    nativeSession: null,
    lastNativeSession: undefined,
    error: "synthetic-native-error",
  };
  manager.onChange?.("old");

  gate.release();
  await nextTurn();
  await nextTurn();

  assert.deepEqual(manager.closeErrorCalls, [], "a resume replacement is closeExited-only, never closeError");
  assert.deepEqual(manager.closeExitedCalls, ["old"]);
  assert.ok(manager.views.some((view) => view.id === "native-1" && view.lifecycle === "alive"),
    "the started replacement child keeps running");
  assert.ok(manager.views.some((view) => view.id === "old" && view.lifecycle === "error"),
    "the old error row is retained, never force-closed by the replacement");
  assert.equal(await closeWithSignal(harness), 0);
});

// ---------------------------------------------------------------------------
// Active and inactive owner behavior on error-row removal
// ---------------------------------------------------------------------------

test("removing the active error row clears ownership without activating a sibling", async () => {
  const harness = createHarness([aliveView("sib"), errorView("err")]);
  const manager = await ready(harness);
  highlightRow(harness, 2); // New -> Saved -> err
  assert.equal(harness.sidebar?.selectedId, "err");
  harness.terminal.emitInput(ENTER); // explicitly make the error row the active owner
  assert.equal(harness.sidebar?.focus, "main");
  harness.terminal.emitInput(ALT_LEFT); // main -> sidebar focus
  assert.equal(harness.sidebar?.focus, "sidebar");
  assert.equal(harness.sidebar?.selectedId, "err");

  harness.terminal.emitInput("d");
  await nextTurn();

  assert.deepEqual(manager.views.map((view) => view.id), ["sib"], "only the selected error row is removed");
  assert.deepEqual(manager.closeErrorCalls, ["err"]);
  assert.equal(harness.sidebar?.selectedId, undefined, "the vanished selection is cleared");

  harness.terminal.emitInput(ALT_LEFT); // hide -> main focus
  harness.terminal.emitInput("q");
  await nextTurn();
  assert.deepEqual(manager.writes, [], "no sibling is activated and nothing is forwarded");
  assert.equal(await closeWithSignal(harness), 0);
});

test("removing an inactive error row preserves the live owner and input routing", async () => {
  const harness = createHarness([aliveView("sib"), errorView("err")]);
  const manager = await ready(harness);
  highlightRow(harness, 3); // New -> Saved -> err -> sib
  assert.equal(harness.sidebar?.selectedId, "sib");
  harness.terminal.emitInput(ENTER); // explicitly make the live sibling the active owner
  assert.equal(harness.sidebar?.focus, "main");
  harness.terminal.emitInput(ALT_LEFT); // main -> sidebar focus
  harness.terminal.emitInput(DOWN); // sib -> err
  assert.equal(harness.sidebar?.selectedId, "err");

  harness.terminal.emitInput("d");
  await nextTurn();

  assert.deepEqual(manager.views.map((view) => view.id), ["sib"], "only the selected error row is removed");
  assert.deepEqual(manager.closeErrorCalls, ["err"]);

  harness.terminal.emitInput(ALT_LEFT); // hide -> main focus
  harness.terminal.emitInput("q");
  await nextTurn();
  assert.deepEqual(manager.writes.at(-1), { id: "sib", data: "q" }, "the live owner keeps input routing");
  assert.equal(await closeWithSignal(harness), 0);
});

// ---------------------------------------------------------------------------
// Aliases and deliberate-press guards
// ---------------------------------------------------------------------------

test("d, D, and Delete all drive the same settled error-row removal", async () => {
  for (const key of ["d", "D", DELETE] as const) {
    const harness = createHarness([errorView("err")]);
    const manager = await ready(harness);
    highlightRow(harness, 2);
    harness.terminal.emitInput(key);
    await nextTurn();
    assert.deepEqual(manager.views, [], `${JSON.stringify(key)} removes the settled error row`);
    assert.deepEqual(manager.closeErrorCalls, ["err"]);
    assert.equal(await closeWithSignal(harness), 0);
  }
});

test("held Delete repeats and releases never remove an error row", async () => {
  const previous = isKittyProtocolActive();
  setKittyProtocolActive(true);
  try {
    const harness = createHarness([errorView("err")]);
    const manager = await ready(harness);
    highlightRow(harness, 2);
    harness.terminal.emitInput(DELETE_REPEAT);
    assert.deepEqual(manager.views.map((view) => view.id), ["err"], "a held Delete repeat never removes");
    harness.terminal.emitInput(DELETE_RELEASE);
    assert.deepEqual(manager.views.map((view) => view.id), ["err"], "a held Delete release never removes");
    assert.deepEqual(manager.closeErrorCalls, []);
    harness.terminal.emitInput(DELETE); // a deliberate initial press removes
    await nextTurn();
    assert.deepEqual(manager.views, []);
    assert.equal(await closeWithSignal(harness), 0);
  } finally {
    setKittyProtocolActive(previous);
  }
});

test("a bracketed paste containing d never removes an error row", async () => {
  const harness = createHarness([errorView("err")]);
  const manager = await ready(harness);
  highlightRow(harness, 2);
  harness.terminal.emitInput(PASTE_WITH_D);
  await nextTurn();

  assert.deepEqual(manager.views.map((view) => view.id), ["err"], "paste content is opaque to host actions");
  assert.deepEqual(manager.closeErrorCalls, []);
  assert.equal(await closeWithSignal(harness), 0);
});

test("a not-fully-displayed error row selection cannot be removed before the roster redraws", async () => {
  const harness = createHarness([errorView("err")]);
  const manager = await ready(harness);
  highlightRow(harness, 2);
  assert.equal(harness.sidebar?.selectedId, "err");

  // The roster changes after the last full render; the redraw is still queued.
  manager.views.push(aliveView("sib"));
  manager.onChange?.("sib");
  harness.terminal.emitInput("d");
  assert.deepEqual(manager.views.map((view) => view.id), ["err", "sib"], "the stale display fences the removal");
  assert.deepEqual(manager.closeErrorCalls, []);
  assert.deepEqual(manager.closeExitedCalls, []);

  await nextTurn(); // the roster redraws with the new row set
  harness.terminal.emitInput("d");
  await nextTurn();
  assert.deepEqual(manager.views.map((view) => view.id), ["sib"], "the same deliberate press removes after the full display");
  assert.deepEqual(manager.closeErrorCalls, ["err"]);
  assert.equal(await closeWithSignal(harness), 0);
});

test("the reserved-Delete x fallback drives the same error-row removal", async () => {
  const harness = createHarness([errorView("err")], { optionOverrides: { toggleKey: "delete" } });
  const manager = await ready(harness);
  highlightRow(harness, 2);
  harness.terminal.emitInput("x");
  await nextTurn();

  assert.deepEqual(manager.views, [], "x removes the settled error row when Delete is reserved");
  assert.deepEqual(manager.closeErrorCalls, ["err"]);
  assert.equal(await closeWithSignal(harness), 0);
});
