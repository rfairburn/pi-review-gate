import assert from "node:assert/strict";
import type { ChildProcess, SpawnOptions } from "node:child_process";
import { execFileSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Writable } from "node:stream";
import test from "node:test";

import type { ComposedHostFrame } from "../src/session-host/compositor";
import type { CreateInstanceOptions, InstanceManagerOptions, NativeInstanceView, ShutdownResult } from "../src/session-host/instances";
import type { SessionHostFrameWriterOptions } from "../src/session-host/frame-writer";
import type { KeyboardCapabilityObserverOptions } from "../src/session-host/input";
import type { StatusBroker, StatusRenameRequest, StatusRenameResult } from "../src/session-host/broker";
import { NativeAgentRegistry, type ProfilePreparer } from "../src/session-host/profiles";
import { runNativeExternalEditor } from "../src/session-host/form-support";
import type { TerminalFrame, TerminalInputModes } from "../src/session-host/terminal-surface";
import { SidebarController } from "../src/session-host/sidebar";
import { isSavedSessionAdmission, listSavedSessions, type SavedSessionCatalog } from "../src/session-host/saved-sessions";
import type { SessionHostNativeSession } from "../src/session-host/protocol";
import { __test, type SessionHostOptions } from "../src/session-host/main";
import { sidebarNoticeRows } from "./helpers/session-host-notice-witness";

const ESC = "\x1b";
const ALT_LEFT = `${ESC}[1;3D`;
const ENTER = "\r";
const DELETE = "\x1b[3~";
const REMOVE_REFUSED_NOTICE = "Session not removed; it may be live, unconfirmed, or no longer available.";
const MAIN_TEST_SCRATCH_ROOT = join(process.cwd(), "node_modules", ".cache", "session-host-main-tests");

function makeMainTestDirectory(prefix: string): string {
  mkdirSync(MAIN_TEST_SCRATCH_ROOT, { recursive: true });
  return mkdtempSync(join(MAIN_TEST_SCRATCH_ROOT, `${prefix}-`));
}

class FakeInput extends EventEmitter {
  readonly isTTY = true;
  readableEnded = false;
}

class FakeOutput extends EventEmitter {
  readonly isTTY = true;
  columns = 80;
  rows = 24;
  readonly writes: string[] = [];
  ended = false;
  destroyed = false;

  write(chunk: Uint8Array | string): boolean {
    this.writes.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
    return true;
  }

  end(): this { this.ended = true; return this; }
  destroy(): this { this.destroyed = true; return this; }
}

class FakeTerminal {
  kittyProtocolActive = false;
  modifyOtherKeysActive = false;
  columns = 80;
  rows = 24;
  started = false;
  stopCount = 0;
  drainCalls: [number | undefined, number | undefined][] = [];
  readonly writes: string[] = [];
  order: string[] = [];
  inputHandler?: (data: string) => void;
  resizeHandler?: () => void;
  startError?: Error;
  stopError?: Error;
  writeError?: Error;
  drainGate?: Promise<void>;

  start(onInput: (data: string) => void, onResize: () => void): void {
    this.order.push("terminal.start");
    this.inputHandler = onInput;
    this.resizeHandler = onResize;
    if (this.startError) throw this.startError;
    this.started = true;
  }

  emitInput(data: string): void { this.inputHandler?.(data); }

  setSize(columns: number, rows: number): void {
    this.columns = columns;
    this.rows = rows;
    this.resizeHandler?.();
  }

  write(data: string): void {
    if (this.writeError) throw this.writeError;
    this.writes.push(data);
  }

  async drainInput(maxMs?: number, idleMs?: number): Promise<void> {
    this.order.push("terminal.drain");
    this.drainCalls.push([maxMs, idleMs]);
    await this.drainGate;
  }

  stop(): void {
    this.order.push("terminal.stop");
    if (this.stopError) throw this.stopError;
    this.stopCount += 1;
    this.started = false;
  }
}

class FakeObserver {
  flags = 0;
  disposed = false;
  waitCalls = 0;
  onChange?: (flags: number) => void;
  resolveWait?: (flags: number) => void;

  constructor(options: KeyboardCapabilityObserverOptions = {}) {
    this.onChange = options.onChange;
  }

  feed(_data: string | Buffer): void {}

  wait(): Promise<number> {
    this.waitCalls += 1;
    return new Promise((resolve) => { this.resolveWait = resolve; });
  }

  setFlags(flags: number): void {
    this.flags = flags;
    this.onChange?.(flags);
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
  closeResult = true;
  startError?: Error;
  closeGate?: Promise<void>;
  closeStarted = false;
  submitsAfterClose = 0;
  invalidateCalls = 0;
  readonly frames: { frame: ComposedHostFrame; cols: number; rows: number }[] = [];
  readonly order: string[];

  constructor(order: string[]) { this.order = order; }

  start(): void {
    this.order.push("writer.start");
    if (this.startError) throw this.startError;
    this.started = true;
  }

  submit(frame: ComposedHostFrame, cols: number, rows: number): void {
    if (this.closed) this.submitsAfterClose += 1;
    this.frames.push({ frame, cols, rows });
  }

  invalidate(): void {
    this.order.push("writer.invalidate");
    this.invalidateCalls += 1;
  }

  async close(): Promise<boolean> {
    this.order.push("writer.close");
    this.closed = true;
    this.closeStarted = true;
    await this.closeGate;
    return this.closeResult;
  }
}

class FakeSurface {
  cols: number;
  rows: number;
  readonly writesAsFrame: string[];
  frameCalls = 0;
  modes: TerminalInputModes = {
    kittyFlags: 0,
    modifyOtherKeys: 0,
    applicationCursorKeys: false,
    applicationKeypad: false,
    bracketedPaste: false,
    mouseTracking: "none",
    mouseEncoding: "default",
  };

  constructor(cols: number, rows: number, text: string) {
    this.cols = cols;
    this.rows = rows;
    this.writesAsFrame = [text];
  }

  frame(): TerminalFrame {
    this.frameCalls += 1;
    const lines = Array.from({ length: this.rows }, (_, index) => index === 0 ? this.writesAsFrame.join("") : "");
    return {
      cols: this.cols,
      rows: this.rows,
      lines,
      cursor: { column: 2, row: 0, visible: true },
    };
  }

  inputModes(): TerminalInputModes { return { ...this.modes }; }
}

class FakeManager {
  readonly options: InstanceManagerOptions;
  readonly views: NativeInstanceView[] = [];
  readonly staleListedViews: NativeInstanceView[] = [];
  readonly surfaces = new Map<string, FakeSurface>();
  readonly writes: { id: string; data: string | Buffer }[] = [];
  readonly closeExitedCalls: string[] = [];
  readonly refusedCloseIds = new Set<string>();
  readonly resizeCalls: { cols: number; rows: number; ids: string[] }[] = [];
  readonly createOptions: CreateInstanceOptions[] = [];
  /** Known-owned live session data served to deliberate saved-conversation admission. */
  ownedLiveSessionsData: { id?: string; file?: string }[] = [];
  readonly renameCalls: { id: string; request: StatusRenameRequest }[] = [];
  readonly order: string[];
  onChange?: (id: string) => void;
  nextId = 1;
  nextError = false;
  readonly shutdownResult: ShutdownResult = { forcedIds: [], remainingIds: [] };
  readonly pendingCreates = new Set<Promise<string>>();
  createGate?: Promise<void>;
  createGateEntered?: () => void;
  renameGate?: Promise<void>;
  renameGateEntered?: () => void;
  renameError = false;
  stopping = false;
  spawnCount = 0;
  shutdownCalls = 0;
  disposeCalls = 0;
  shutdownError = false;
  disposeError = false;

  constructor(options: InstanceManagerOptions, order: string[]) {
    this.options = options;
    this.order = order;
    this.onChange = options.onChange;
  }

  list(): NativeInstanceView[] {
    return [...this.views, ...this.staleListedViews].map((view) => ({ ...view, activity: [...view.activity] }));
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

  create(options: CreateInstanceOptions): Promise<string> {
    this.createOptions.push({ ...options });
    const id = `native-${this.nextId++}`;
    const error = this.nextError;
    this.nextError = false;
    const surface = new FakeSurface(this.options.cols ?? 80, this.options.rows ?? 24, `frame:${id}`);
    this.surfaces.set(id, surface);
    this.views.push({
      id,
      label: "(session starting)",
      workspace: options.workspace,
      agentDir: `/private-profile/${id}`,
      lifecycle: "starting",
      hasLiveProcess: false,
      busy: null,
      pendingInput: null,
      inputSurface: false,
      activity: [],
      nativeSession: null,
    });
    this.onChange?.(id);
    const pending = this.finishCreate(id, error);
    this.pendingCreates.add(pending);
    void pending.then(
      () => this.pendingCreates.delete(pending),
      () => this.pendingCreates.delete(pending),
    );
    return pending;
  }

  private async finishCreate(id: string, error: boolean): Promise<string> {
    if (this.createGate) {
      this.createGateEntered?.();
      await this.createGate;
    }
    const index = this.views.findIndex((view) => view.id === id);
    const view = this.views[index];
    if (!view) throw new Error("missing synthetic create row");
    if (this.stopping) {
      this.views[index] = { ...view, lifecycle: "error", hasLiveProcess: false, error: "synthetic-aborted-create" };
    } else if (error) {
      this.views[index] = { ...view, lifecycle: "error", hasLiveProcess: false, error: "synthetic-secret-native-error" };
    } else {
      this.spawnCount += 1;
      const nativeSession: SessionHostNativeSession = {
        sessionId: `conversation-${id}`,
        epoch: 1,
        name: `Native ${id}`,
      };
      this.views[index] = { ...view, label: nativeSession.name, nativeSession, lifecycle: "alive", hasLiveProcess: true };
    }
    this.onChange?.(id);
    return id;
  }

  write(id: string, data: string | Buffer): void { this.writes.push({ id, data }); }

  async rename(id: string, request: StatusRenameRequest): Promise<StatusRenameResult> {
    this.renameCalls.push({ id, request: { ...request } });
    if (this.renameError) throw new Error("synthetic-secret-rename-error");
    if (this.renameGate) {
      this.renameGateEntered?.();
      await this.renameGate;
    }
    const index = this.views.findIndex((view) => view.id === id);
    const view = this.views[index];
    if (!view?.nativeSession) {
      return { requestId: "synthetic", status: "unavailable", expectedSessionId: request.expectedSessionId,
        expectedSessionEpoch: request.expectedSessionEpoch, observedSessionId: null, observedSessionEpoch: null };
    }
    if (view.nativeSession.sessionId !== request.expectedSessionId || view.nativeSession.epoch !== request.expectedSessionEpoch) {
      return { requestId: "synthetic", status: "stale-session", expectedSessionId: request.expectedSessionId,
        expectedSessionEpoch: request.expectedSessionEpoch, observedSessionId: view.nativeSession.sessionId,
        observedSessionEpoch: view.nativeSession.epoch };
    }
    const nativeSession = { ...view.nativeSession, name: request.name };
    this.views[index] = { ...view, label: request.name, nativeSession };
    this.onChange?.(id);
    return { requestId: "synthetic", status: "renamed", expectedSessionId: request.expectedSessionId,
      expectedSessionEpoch: request.expectedSessionEpoch, observedSessionId: nativeSession.sessionId,
      observedSessionEpoch: nativeSession.epoch };
  }

  resize(cols: number, rows: number): void {
    const liveIds: string[] = [];
    for (const view of this.views) {
      if (!view.hasLiveProcess) continue;
      liveIds.push(view.id);
      const surface = this.surfaces.get(view.id);
      if (surface) { surface.cols = cols; surface.rows = rows; }
    }
    this.resizeCalls.push({ cols, rows, ids: liveIds });
  }

  hasLiveProcesses(): boolean { return this.views.some((view) => view.hasLiveProcess); }

  async shutdown(): Promise<ShutdownResult> {
    this.order.push("manager.shutdown");
    this.shutdownCalls += 1;
    this.stopping = true;
    if (this.shutdownError) throw new Error("synthetic-secret-shutdown-error");
    await Promise.allSettled([...this.pendingCreates]);
    const remaining = new Set(this.shutdownResult.remainingIds);
    for (let index = 0; index < this.views.length; index += 1) {
      const view = this.views[index];
      if (view?.hasLiveProcess && !remaining.has(view.id)) {
        this.views[index] = { ...view, lifecycle: "exited", hasLiveProcess: false };
      }
    }
    return this.shutdownResult;
  }

  async dispose(): Promise<void> {
    this.order.push("manager.dispose");
    this.disposeCalls += 1;
    if (this.disposeError) throw new Error("synthetic-secret-dispose-error");
  }

  notify(id = "changed-without-frame-bytes"): void { this.onChange?.(id); }
}

type MainTestDependencies = NonNullable<Parameters<typeof __test.runWithDependencies>[1]>;

interface Harness {
  options: SessionHostOptions;
  stdin: FakeInput;
  stdout: FakeOutput;
  signals: EventEmitter;
  terminal: FakeTerminal;
  observer: FakeObserver;
  writer: FakeWriter;
  writers: FakeWriter[];
  broker: StatusBroker & { disposeCalls: number; order: string[] };
  manager?: FakeManager;
  sidebar?: SidebarController;
  brokerOptions?: { socketRoot?: string };
  reports: string[];
  events: string[];
  result: Promise<number>;
}

function options(overrides: Partial<SessionHostOptions> = {}): SessionHostOptions {
  return {
    packageRoot: process.cwd(),
    stateRoot: "/synthetic/session-host-state",
    args: [],
    env: { PATH: process.env.PATH, HOME: "/synthetic-home" },
    ...overrides,
  };
}

function syntheticExternalEditor(result: string | ((text: string) => string)): typeof runNativeExternalEditor {
  return (text, options) => runNativeExternalEditor(text, {
    env: { EDITOR: "synthetic-editor" },
    cwd: options.cwd,
    signal: options.signal,
    tempRoot: MAIN_TEST_SCRATCH_ROOT,
    spawn: ((_command: string, args: string[], _options: SpawnOptions) => {
      writeFileSync(args.at(-1)!, typeof result === "string" ? result : result(text), "utf8");
      const child = new EventEmitter() as ChildProcess;
      Object.assign(child, { pid: 12350, exitCode: null, signalCode: null, killed: false, kill: () => true });
      queueMicrotask(() => {
        child.emit("spawn");
        child.emit("close", 0, null);
      });
      return child;
    }) as unknown as typeof import("node:child_process").spawn,
  });
}

function createHarness(
  overrides: Partial<SessionHostOptions> = {},
  dependencyOverrides: MainTestDependencies = {},
): Harness {
  const stdin = new FakeInput();
  const stdout = new FakeOutput();
  const signals = new EventEmitter();
  const terminal = new FakeTerminal();
  const observer = new FakeObserver();
  const events: string[] = [];
  terminal.order = events;
  const writer = new FakeWriter(events);
  const writers: FakeWriter[] = [];
  const defaultAgentDir = makeMainTestDirectory("agent");
  writeFileSync(join(defaultAgentDir, "keybindings.json"), "{}", "utf8");
  const reports: string[] = [];
  let brokerDisposals = 0;
  const broker = {
    socketPath: "/synthetic/socket",
    generation: "synthetic-generation",
    get disposeCalls() { return brokerDisposals; },
    order: events,
    register() { throw new Error("fake manager does not register children"); },
    async dispose() { events.push("broker.dispose"); brokerDisposals += 1; },
  } as unknown as StatusBroker & { readonly disposeCalls: number; order: string[] };
  let manager: FakeManager | undefined;
  let sidebar: SidebarController | undefined;
  let brokerOptions: { socketRoot?: string } | undefined;
  let harness!: Harness;
  const result = __test.runWithDependencies(options(overrides), {
    platform: "linux",
    nodeVersion: "22.19.0",
    stdin,
    stdout: stdout as unknown as Writable & EventEmitter & { isTTY?: boolean; columns?: number; rows?: number },
    signals,
    resolvePi: ({ executable, env }) => {
      events.push("resolve");
      assert.equal(env.PI_REVIEW_GATE_RUNTIME_ROLE, undefined);
      return { file: executable ?? "/synthetic/pi", version: "1.0.4" };
    },
    createBroker: async (brokerSetup) => { brokerOptions = brokerSetup; events.push("broker.create"); return broker; },
    createManager: (managerOptions) => {
      events.push("manager.create");
      manager = new FakeManager(managerOptions, events);
      if (harness) harness.manager = manager;
      return manager as never;
    },
    createSidebar: (sidebarOptions) => {
      events.push("sidebar.construct");
      sidebar = new SidebarController(sidebarOptions);
      if (harness) harness.sidebar = sidebar;
      return sidebar;
    },
    createTerminal: () => { events.push("terminal.construct"); return terminal; },
    createSessionSetup: () => {
      events.push("setup.construct");
      return {
        nativeSetup: false,
        nativeAgentDir: defaultAgentDir,
        profileRegistry: {
          prepare: () => { throw new Error("the fake Main manager must not prepare sessions"); },
        } satisfies ProfilePreparer,
      };
    },
    createObserver: (observerOptions) => {
      events.push("observer.construct");
      observer.onChange = observerOptions?.onChange;
      return observer;
    },
    createWriter: (_output, _writerOptions?: SessionHostFrameWriterOptions) => {
      events.push("writer.construct");
      const created = writers.length === 0 ? writer : new FakeWriter(events);
      writers.push(created);
      if (harness) {
        harness.writer = created;
        harness.writers = writers;
      }
      return created;
    },
    reportError: (message) => reports.push(message),
    ...dependencyOverrides,
  });
  harness = {
    options: options(overrides), stdin, stdout, signals, terminal, observer, writer, writers, broker, reports, events, manager, sidebar, result,
    get brokerOptions() { return brokerOptions; },
  };
  // Manager and sidebar construction occur after the broker's first asynchronous boundary.
  void result.then(() => undefined);
  void result.then(() => rmSync(defaultAgentDir, { recursive: true, force: true }));
  return harness;
}

async function nextTurn(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

async function started(harness: Harness): Promise<FakeManager> {
  await nextTurn();
  assert.ok(harness.manager, "manager initialized after Pi preflight and broker setup");
  return harness.manager;
}

async function ready(harness: Harness, flags = 0): Promise<FakeManager> {
  const manager = await started(harness);
  assert.equal(harness.observer.waitCalls, 1, "Main waits for actual keyboard negotiation before spawning children");
  assert.ok(harness.events.indexOf("resolve") < harness.events.indexOf("observer.construct"), "Pi entry/version probe precedes the observer constructor");
  assert.ok(harness.events.indexOf("resolve") < harness.events.indexOf("terminal.construct"), "Pi entry/version probe precedes the public terminal constructor");
  harness.observer.settle(flags);
  await nextTurn();
  return manager;
}

async function startTwoSessions(harness: Harness): Promise<FakeManager> {
  const manager = await ready(harness);
  fillForm(harness.terminal, "/first/workspace");
  await nextTurn();
  // A successful New made native-1 the Main owner; return to the visible
  // sidebar roster before navigating to New again.
  harness.terminal.emitInput(ALT_LEFT);
  harness.terminal.emitInput("\x1b[B"); // first row -> Saved conversations
  harness.terminal.emitInput("\x1b[B"); // -> New session
  harness.terminal.emitInput(ENTER);
  completeForm(harness.terminal, "/another/workspace");
  await nextTurn();
  assert.deepEqual(manager.views.map((view) => view.id), ["native-1", "native-2"]);
  // Leave the caller in sidebar focus with native-2 (the last created owner)
  // highlighted, matching the pre-activation roster state.
  harness.terminal.emitInput(ALT_LEFT);
  return manager;
}

function fillForm(terminal: FakeTerminal, workspace = "/explicit/workspace"): void {
  terminal.emitInput(ENTER); // New session
  completeForm(terminal, workspace);
}

function completeForm(terminal: FakeTerminal, workspace = "/explicit/workspace"): void {
  terminal.emitInput("\x15"); // replace any retained workspace draft
  terminal.emitInput(workspace);
  terminal.emitInput(ENTER); // submit
}

async function closeWithSignal(harness: Harness, signal = "SIGTERM"): Promise<number> {
  harness.signals.emit(signal);
  return harness.result;
}

function plain(frame: ComposedHostFrame | undefined): string {
  return frame?.lines.join("\n").replace(/\x1b\[[0-9;]*m/g, "") ?? "";
}

function plainLine(frame: ComposedHostFrame | undefined, row: number): string {
  return frame?.lines[row]?.replace(/\x1b\[[0-9;]*m/g, "") ?? "";
}

test("Main module import is inert: no ProcessTerminal, native PTY, terminal listeners, or timers are constructed", () => {
  const entry = join(process.cwd(), "dist-test", "src", "session-host", "main.js");
  const script = `
    const Module = require('node:module');
    const before = { stdin: process.stdin.listenerCount('data'), resize: process.stdout.listenerCount('resize'),
      signals: ['SIGTERM','SIGHUP','SIGINT'].map((s) => process.listenerCount(s)), handles: process._getActiveHandles().length };
    let terminals = 0; let observers = 0; let ptys = 0;
    const load = Module._load;
    Module._load = function(request, parent, isMain) {
      const value = load.call(this, request, parent, isMain);
      if (request === '@lydell/node-pty') ptys += 1;
      if (request === './input') return new Proxy(value, { get(target, key, receiver) {
        if (key === 'KeyboardCapabilityObserver') return class extends target.KeyboardCapabilityObserver { constructor(...args) { observers += 1; super(...args); } };
        return Reflect.get(target, key, receiver);
      }});
      if (request === 'pi-session-host-tui') return new Proxy(value, { get(target, key, receiver) {
        if (key === 'ProcessTerminal') return class extends target.ProcessTerminal { constructor(...args) { terminals += 1; super(...args); } };
        return Reflect.get(target, key, receiver);
      }});
      return value;
    };
    require(${JSON.stringify(entry)});
    const after = { stdin: process.stdin.listenerCount('data'), resize: process.stdout.listenerCount('resize'),
      signals: ['SIGTERM','SIGHUP','SIGINT'].map((s) => process.listenerCount(s)), handles: process._getActiveHandles().length };
    if (JSON.stringify(before) !== JSON.stringify(after) || terminals !== 0 || observers !== 0 || ptys !== 0) {
      throw new Error(JSON.stringify({ before, after, terminals, observers, ptys }));
    }
  `;
  execFileSync(process.execPath, ["-e", script], { cwd: process.cwd(), stdio: "pipe" });
});

test("the actual startup-options helper rejects before probe, socket, setup, terminal, or listeners", async () => {
  const harness = createHarness({ args: ["--session", "/credential-like-secret.jsonl"] });
  assert.equal(await harness.result, 1);
  assert.deepEqual(harness.events, [], "startup admission precedes all injected runtime dependencies");
  assert.equal(harness.stdin.listenerCount("data"), 0);
  assert.equal(harness.stdout.listenerCount("error"), 0);
  assert.deepEqual(harness.reports, ["Session host startup options were rejected."]);
  assert.doesNotMatch(harness.reports.join(""), /credential-like-secret|jsonl/);
});

test("nonempty PI_CODING_AGENT_SESSION_DIR rejects before dependency construction", async () => {
  const harness = createHarness({
    env: {
      PATH: process.env.PATH,
      HOME: "/synthetic-home",
      PI_CODING_AGENT_SESSION_DIR: "/synthetic-session-dir-secret",
    },
  });
  assert.equal(await harness.result, 1);
  assert.deepEqual(harness.events, [], "the inherited storage override is rejected before any runtime factory");
  assert.equal(harness.stdin.listenerCount("data"), 0);
  assert.equal(harness.stdout.listenerCount("error"), 0);
  assert.deepEqual(harness.reports, ["Session host startup options were rejected."]);
  assert.doesNotMatch(harness.reports.join(""), /synthetic-session-dir-secret/);
});

test("missing package-root helper fails closed without searching an ancestor helper", async () => {
  const harness = createHarness({ packageRoot: join(process.cwd(), "src", "session-host") });
  assert.equal(await harness.result, 1);
  assert.deepEqual(harness.events, [], "the helper is loaded only from the exact canonical package root");
  assert.deepEqual(harness.reports, ["Session host startup options were rejected."]);
});

test("synthetic Windows Main admission canonicalizes env names and reaches the injected public-host path", async () => {
  const originalEnv: NodeJS.ProcessEnv = {
    Path: "/synthetic/bin",
    node_options: "--no-warnings --require=trusted-loader",
    Anthropic_Api_Key: "provider-secret",
    pi_review_gate_session_host_bootstrap: "stale-host-capability",
  };
  const harness = createHarness({ env: originalEnv }, { platform: "win32" });
  const manager = await ready(harness);
  assert.ok(harness.events.includes("resolve"), "Windows passes platform/Node/TTY admission and reaches Pi resolution");
  assert.equal(manager.options.env?.PATH, "/synthetic/bin");
  assert.equal(manager.options.env?.NODE_OPTIONS, "--no-warnings --require=trusted-loader");
  assert.equal(manager.options.env?.ANTHROPIC_API_KEY, "provider-secret");
  assert.equal(manager.options.env?.PI_REVIEW_GATE_SESSION_HOST_BOOTSTRAP, undefined);
  assert.deepEqual(originalEnv, {
    Path: "/synthetic/bin",
    node_options: "--no-warnings --require=trusted-loader",
    Anthropic_Api_Key: "provider-secret",
    pi_review_gate_session_host_bootstrap: "stale-host-capability",
  }, "Windows normalization and stale-capability removal use only the detached snapshot");
  assert.equal(await closeWithSignal(harness), 0);
});

test("Windows role casing and ambiguous ordinary env aliases fail before Pi resolution", async () => {
  const role = createHarness({
    env: { PI_REVIEW_GATE_RUNTIME_ROLE: "", pi_review_gate_runtime_role: "private-role-secret" },
  }, { platform: "win32" });
  assert.equal(await role.result, 1);
  assert.deepEqual(role.events, []);
  assert.deepEqual(role.reports, ["Session host preflight failed."]);
  assert.doesNotMatch(role.reports.join(""), /private-role-secret/);

  const ambiguous = createHarness({ env: { PATH: "/one", Path: "/two" } }, { platform: "win32" });
  assert.equal(await ambiguous.result, 1);
  assert.deepEqual(ambiguous.events, []);
  assert.deepEqual(ambiguous.reports, ["Session host preflight failed."]);
});

test("Windows-cased parent session storage override rejects before any dependency", async () => {
  const harness = createHarness({ env: { pi_coding_agent_session_dir: "/synthetic-storage-secret" } }, { platform: "win32" });
  assert.equal(await harness.result, 1);
  assert.deepEqual(harness.events, []);
  assert.deepEqual(harness.reports, ["Session host startup options were rejected."]);
  assert.doesNotMatch(harness.reports.join(""), /synthetic-storage-secret/);
});

test("direct Main preflight rejects role input before native Pi probing", async () => {
  const harness = createHarness({ env: { PATH: process.env.PATH, PI_REVIEW_GATE_RUNTIME_ROLE: "role-secret" } });
  assert.equal(await harness.result, 1);
  assert.deepEqual(harness.events, [], "role preflight rejects before Pi entry resolution or resource setup");
  assert.deepEqual(harness.reports, ["Session host preflight failed."]);
  assert.doesNotMatch(harness.reports.join(""), /role-secret/);
});

test("snapshotted args/env survive caller mutation after startup admission and reach each manager unchanged", async () => {
  const args = ["--model", "--session", "--tools", "read,edit"];
  const env: NodeJS.ProcessEnv = { PATH: "/synthetic/path", PI_CODING_AGENT_SESSION_DIR: undefined, ANTHROPIC_API_KEY: "original-secret" };
  const supplied = options({ args, env });
  const harness = createHarness({ args, env });
  // Change the original option objects after the controller's synchronous snapshot.
  args.splice(0, args.length, "--continue");
  env.PI_CODING_AGENT_SESSION_DIR = "/late/session/override";
  env.PI_REVIEW_GATE_RUNTIME_ROLE = "late-role";
  const manager = await ready(harness);
  assert.deepEqual(manager.options.args, ["--model", "--session", "--tools", "read,edit"]);
  assert.equal(manager.options.env?.PI_CODING_AGENT_SESSION_DIR, undefined);
  assert.equal(manager.options.env?.PI_REVIEW_GATE_RUNTIME_ROLE, undefined);
  assert.equal(manager.options.env?.ANTHROPIC_API_KEY, "original-secret");
  assert.equal(Object.isFrozen(manager.options.args), true, "the controller passes its immutable startup snapshot");
  assert.equal(supplied.env, env, "the caller's original environment object is not replaced or mutated");
  assert.equal(env.PI_CODING_AGENT_SESSION_DIR, "/late/session/override");
  assert.equal(env.PI_REVIEW_GATE_RUNTIME_ROLE, "late-role");
  const status = await closeWithSignal(harness);
  assert.equal(status, 0);
});

test("Main native mode binds the captured Pi environment, not --state-root, to the shared agent directory", async () => {
  const root = makeMainTestDirectory("native");
  const home = join(root, "home");
  const agentDir = join(root, "native-agent");
  const workspace = join(root, "workspace");
  const hostStateRoot = join(root, "host-state");
  for (const directory of [home, agentDir, workspace, hostStateRoot]) {
    mkdirSync(directory, { recursive: true });
  }
  const nativeEnv: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    HOME: home,
    PI_CODING_AGENT_DIR: agentDir,
    ANTHROPIC_API_KEY: "synthetic-provider-key",
  };
  const harness = createHarness({ env: nativeEnv, stateRoot: hostStateRoot }, {
    createSessionSetup: ({ env }) => {
      const registry = new NativeAgentRegistry({ env });
      return { nativeSetup: true, profileRegistry: registry, nativeAgentDir: registry.agentDir };
    },
  });
  try {
    const manager = await started(harness);
    assert.equal(manager.options.nativeSetup, true);
    assert.deepEqual(harness.brokerOptions, { socketRoot: hostStateRoot }, "--state-root scopes transient broker state only");
    assert.equal(manager.options.env?.PI_CODING_AGENT_DIR, agentDir);
    assert.equal(manager.options.env?.ANTHROPIC_API_KEY, "synthetic-provider-key");
    const prepared = manager.options.profileRegistry?.prepare({ workspace });
    assert.ok(prepared);
    assert.equal(prepared.agentDir, realpathSync(agentDir));
    assert.equal(prepared.created, false);
    assert.notEqual(prepared.agentDir, hostStateRoot, "private host state is not a Pi agent/profile selector");
    assert.equal(readdirSync(hostStateRoot).length, 0, "the fake broker did not turn host state into a profile tree");
    assert.ok(readFileSync(join(agentDir, "review-gate.json"), "utf8").includes('"enabled"'));
    prepared.release();
    assert.equal(await closeWithSignal(harness), 0);
  } finally {
    harness.signals.emit("SIGTERM");
    await harness.result;
    rmSync(root, { recursive: true, force: true });
  }
});

test("forms may be edited during keyboard negotiation but no native create starts until observed capabilities settle", async () => {
  const harness = createHarness();
  const manager = await started(harness);
  fillForm(harness.terminal, "negotiated session");
  assert.equal(manager.createOptions.length, 0);
  assert.deepEqual(manager.options.args, []);
  harness.observer.settle(5);
  await nextTurn();
  assert.equal(manager.createOptions.length, 1);
  assert.deepEqual(manager.createOptions[0], { workspace: "negotiated session" });
  assert.equal(manager.views[0]?.lifecycle, "alive");
  assert.equal(manager.options.getSupportedKeyboardFlags?.(), 0, "actual ProcessTerminal activation remains authoritative");
  harness.terminal.kittyProtocolActive = true;
  harness.observer.setFlags(13);
  assert.equal(manager.options.getSupportedKeyboardFlags?.(), 5, "observer flags are masked to 1+2+4 only after actual activation");
  assert.equal(await closeWithSignal(harness), 0);
});

test("a successful New submission activates the created row as the Main input owner without a second Enter", async () => {
  const harness = createHarness();
  const manager = await ready(harness);

  fillForm(harness.terminal, "first");
  await nextTurn();
  assert.equal(manager.views[0]?.id, "native-1");
  assert.equal(manager.views[0]?.hasLiveProcess, true);
  assert.equal(harness.sidebar?.focus, "main", "the completed New child becomes the active input owner");
  assert.equal(harness.sidebar?.selectedId, "native-1", "the created row is highlighted as the active owner");
  // Two deliberate F8 presses: the first only focuses the visible sidebar, and
  // the second hides it back to Main, so these native packets really start in Main.
  harness.terminal.emitInput(ALT_LEFT);
  harness.terminal.emitInput(ALT_LEFT); // hide, preserving the active owner
  // These Main packets must still route only to native-1.
  harness.terminal.emitInput(ESC);
  harness.terminal.emitInput("q");
  harness.terminal.emitInput("Q");
  harness.terminal.emitInput("\x03");
  assert.deepEqual(manager.writes.map((entry) => [entry.id, entry.data]), [
    ["native-1", ESC], ["native-1", "q"], ["native-1", "Q"], ["native-1", "\x03"],
  ]);
  assert.equal(manager.shutdownCalls, 0, "native Ctrl+C and q do not quit the host");

  // Reopen the picker and open New session while native-1 remains active.
  harness.terminal.emitInput(ALT_LEFT);
  await nextTurn(); // the complete reopened roster is drawn before targeted navigation
  harness.terminal.emitInput("\x1b[B"); // highlighted first -> Saved conversations
  harness.terminal.emitInput("\x1b[B"); // -> New session
  harness.terminal.emitInput(ENTER); // Open New session
  completeForm(harness.terminal, "/another/explicit/workspace");
  await nextTurn();
  assert.equal(manager.views[1]?.id, "native-2");
  assert.equal(harness.manager?.list()[1]?.label, "Native native-2");
  assert.equal(harness.sidebar?.focus, "main", "the second completed New child is active without another Enter");
  assert.equal(harness.sidebar?.selectedId, "native-2");
  assert.equal(manager.writes.at(-1)?.id, "native-1", "completing New wrote no native input");

  // Subsequent Main input goes only to the newly active native-2.
  assert.equal(harness.terminal.inputHandler !== undefined, true);
  harness.terminal.emitInput("q");
  assert.equal(manager.writes.at(-1)?.id, "native-2");

  const activeIndex = manager.views.findIndex((view) => view.id === "native-2");
  const activeView = manager.views[activeIndex];
  assert.ok(activeView);
  manager.views[activeIndex] = { ...activeView, lifecycle: "error", hasLiveProcess: true };
  manager.notify();
  await nextTurn();
  assert.equal(harness.writer.frames.at(-1)?.frame.cursor.visible, false, "non-alive native frames never retain an owned cursor");

  assert.deepEqual(manager.createOptions[1], { workspace: "/another/explicit/workspace" });
  assert.equal(await closeWithSignal(harness), 0);
});

test("authenticated SessionSpawn adds a sibling without changing selection, focus, Main owner, or visibility", async () => {
  const harness = createHarness();
  const manager = await startTwoSessions(harness);
  const sidebar = harness.sidebar;
  assert.ok(sidebar);
  assert.equal(sidebar.focus, "sidebar");
  assert.equal(sidebar.selectedId, "native-2");
  const before = {
    selectedId: sidebar.selectedId,
    focus: sidebar.focus,
    activeMainOwnerID: sidebar.activeMainOwnerID,
    visible: sidebar.visible,
  };
  const spawn = manager.options.onSpawnRequest;
  assert.equal(typeof spawn, "function", "the host routes only broker-authenticated child requests to its manager");
  const request = {
    workspace: "/requested/existing/workspace",
    title: "Exact sibling title",
    prompt: "@/literal\n--session is prompt content\n",
  };
  assert.equal(await spawn!("native-2", request), "started");
  assert.deepEqual(manager.createOptions.at(-1), {
    workspace: request.workspace,
    initialRequest: { title: request.title, prompt: request.prompt },
  }, "the explicit workspace/title/prompt are forwarded unchanged, with no defaults");
  assert.equal(manager.views.length, 3, "the new row appears in the top-level sidebar roster");
  assert.deepEqual({
    selectedId: sidebar.selectedId,
    focus: sidebar.focus,
    activeMainOwnerID: sidebar.activeMainOwnerID,
    visible: sidebar.visible,
  }, before, "the background child does not alter any host presentation or Main ownership state");
  assert.equal(await spawn!("missing-parent", request), "failed", "a request cannot create a row for an unknown parent child");
  assert.equal(manager.views.length, 3);
  assert.equal(await closeWithSignal(harness), 0);
});

test("unchanged Main input forwards every packet without speculative frames; child changes draw the latest surface", async () => {
  const harness = createHarness();
  const manager = await ready(harness);
  fillForm(harness.terminal, "main-input-redraw");
  await nextTurn();
  const surface = manager.surface("native-1");
  assert.ok(surface);
  surface.modes = { ...surface.modes, mouseTracking: "any", mouseEncoding: "sgr" };
  manager.notify("native-input-modes");
  await nextTurn();

  const inputs: ReadonlyArray<readonly [string, string]> = [
    ["\x1b[<64;35;2M", "\x1b[<64;2;1M"], // wheel up
    ["\x1b[<64;36;2M", "\x1b[<64;3;1M"], // another wheel packet, a separate turn
    ["\x1b[<65;35;2M", "\x1b[<65;2;1M"], // reverse wheel direction
    ["k", "k"],
    ["\x1b[200~pasted text\x1b[201~", "pasted text"],
    ["\x1b[<0;35;2M", "\x1b[<0;2;1M"], // click
  ];
  const writesBefore = manager.writes.length;
  const frameCallsBefore = surface.frameCalls;
  const submissionsBefore = harness.writer.frames.length;
  const resizesBefore = manager.resizeCalls.length;
  let forwardedCount = 0;
  for (const [input, expected] of inputs) {
    harness.terminal.emitInput(input);
    forwardedCount += 1;
    assert.equal(manager.writes.length, writesBefore + forwardedCount, "each packet is forwarded synchronously");
    assert.equal(manager.writes.at(-1)?.id, "native-1");
    assert.equal(manager.writes.at(-1)?.data, expected, `forwarded packet ${JSON.stringify(input)}`);
    await nextTurn(); // prove separate turns do not schedule stale frames
  }
  assert.deepEqual(manager.writes.slice(writesBefore).map(({ id, data }) => [id, data]),
    inputs.map(([, expected]) => ["native-1", expected]), "all packets retain their original order");
  assert.equal(manager.writes.length, writesBefore + inputs.length, "no packet is dropped or coalesced");
  assert.equal(surface.frameCalls, frameCallsBefore, "unchanged native state is never extracted for plain Main input");
  assert.equal(harness.writer.frames.length, submissionsBefore, "plain Main input submits no speculative host frame");
  assert.equal(manager.resizeCalls.length, resizesBefore, "plain Main input never reconciles or resizes layout");

  surface.writesAsFrame.splice(0, surface.writesAsFrame.length, "latest native output");
  manager.notify("native-output-changed");
  await nextTurn();
  assert.equal(surface.frameCalls, frameCallsBefore + 1, "the authoritative child change extracts one fresh native frame");
  assert.equal(harness.writer.frames.length, submissionsBefore + 1);
  assert.ok(plain(harness.writer.frames.at(-1)?.frame).includes("latest native output"),
    "the next composed frame contains the latest parsed child state");
  assert.equal(manager.resizeCalls.length, resizesBefore);
  assert.equal(await closeWithSignal(harness), 0);
});

test("pending Main input stays draw-free until focus or resize changes the host presentation", async () => {
  const harness = createHarness();
  const manager = await ready(harness);
  fillForm(harness.terminal, "main-input-boundaries");
  await nextTurn();
  const surface = manager.surface("native-1");
  assert.ok(surface);
  surface.modes = { ...surface.modes, mouseTracking: "any", mouseEncoding: "sgr" };
  manager.notify("native-input-modes");
  await nextTurn();

  const baselineFrames = harness.writer.frames.length;
  const baselineResizes = manager.resizeCalls.length;
  harness.terminal.emitInput("pending Main input");
  harness.terminal.emitInput(ALT_LEFT); // Main -> sidebar focus still updates owned mouse modes and redraws
  await nextTurn();
  assert.equal(harness.writer.frames.length, baselineFrames + 1,
    "the actual focus change draws once rather than first submitting a stale input-triggered frame");
  assert.equal(manager.resizeCalls.length, baselineResizes, "focus-only changes preserve child geometry");
  assert.deepEqual(harness.terminal.writes.slice(-2), ["\x1b[?1003l", "\x1b[?1006l"],
    "focus change synchronously disables only the mouse modes Main enabled");

  const beforeHideFrames = harness.writer.frames.length;
  harness.terminal.emitInput(ALT_LEFT); // hide the sidebar and return to Main
  await nextTurn();
  assert.equal(harness.writer.frames.length, beforeHideFrames + 1, "a deliberate toggle still produces a complete frame");
  assert.equal(manager.resizeCalls.length, baselineResizes + 1, "visibility still resizes the native child layout");

  const beforeResizeFrames = harness.writer.frames.length;
  const beforeResizeCalls = manager.resizeCalls.length;
  const beforeInvalidations = harness.writer.invalidateCalls;
  harness.terminal.emitInput("input before outer resize");
  harness.terminal.setSize(70, 24);
  await nextTurn();
  assert.equal(harness.writer.frames.length, beforeResizeFrames + 1, "the resize boundary submits one full redraw");
  assert.equal(manager.resizeCalls.length, beforeResizeCalls + 1, "the real resize still propagates changed native geometry");
  assert.equal(harness.writer.invalidateCalls, beforeInvalidations + 1, "the resize still invalidates the writer baseline");
  const resizedFrame = harness.writer.frames.at(-1);
  assert.deepEqual({ cols: resizedFrame?.cols, rows: resizedFrame?.rows }, { cols: 70, rows: 24 });
  assert.equal(await closeWithSignal(harness), 0);
});

test("native Edit persists a rename without activating the row or routing input to it", async () => {
  const harness = createHarness();
  const manager = await ready(harness);
  fillForm(harness.terminal, "/rename/workspace");
  await nextTurn();
  assert.equal(manager.views[0]?.nativeSession?.epoch, 1);

  harness.terminal.emitInput(ALT_LEFT); // return from the auto-activated child to the visible sidebar
  harness.terminal.emitInput("e");
  assert.equal(harness.sidebar?.focus, "form");
  harness.terminal.emitInput("Renamed title");
  harness.terminal.emitInput(ENTER);
  await nextTurn();
  assert.deepEqual(manager.renameCalls, [{
    id: "native-1",
    request: {
      expectedSessionId: "conversation-native-1",
      expectedSessionEpoch: 1,
      name: "Renamed title",
    },
  }]);
  assert.equal(manager.views[0]?.label, "Renamed title");
  assert.equal(manager.views[0]?.nativeSession?.name, "Renamed title");
  assert.equal(harness.sidebar?.focus, "sidebar");
  assert.equal(harness.sidebar?.selectedId, "native-1");
  assert.deepEqual(manager.writes, [], "editing and saving never activates the session or sends it input");
  assert.equal(await closeWithSignal(harness), 0);
});

test("rename refusal uses set/verify wording, never persistence claims", async () => {
  const harness = createHarness();
  const manager = await ready(harness);
  fillForm(harness.terminal, "/rename/workspace");
  await nextTurn();

  harness.terminal.emitInput(ALT_LEFT); // return from the auto-activated child to the visible sidebar
  harness.terminal.emitInput("e");
  harness.terminal.emitInput("Renamed title");
  manager.renameError = true;
  harness.terminal.emitInput(ENTER);
  await nextTurn();
  const text = plain(harness.writer.frames.at(-1)?.frame).replace(/\s+/g, " ");
  // The narrow form pane may ellipsize the tail; the set/verify wording is
  // what must be present (and no persistence claim).
  assert.ok(text.includes("Pi could not set or verify"), `refusal notice: ${text}`);
  assert.ok(!text.toLowerCase().includes("persist"), "no persistence claim on refusal");
  assert.equal(await closeWithSignal(harness), 0);
});

test("external editor handoff settles the frame writer, applies a normal editor newline, and restores a fresh screen", async () => {
  let captured: { text: string; cwd: string; signalAborted: boolean } | undefined;
  const fakeEditor = syntheticExternalEditor((text) => `${text}/edited-in-native-editor\n`);
  const harness = createHarness({}, {
    runExternalEditor: async (text, editorOptions) => {
      harness.events.push("external-editor.run");
      captured = { text, cwd: editorOptions.cwd, signalAborted: editorOptions.signal?.aborted ?? false };
      assert.equal(harness.terminal.started, false, "the host terminal is stopped while VISUAL/EDITOR owns the real tty");
      return fakeEditor(text, editorOptions);
    },
  });
  await ready(harness);
  const initialWriter = harness.writer;
  harness.terminal.emitInput(ENTER); // New session
  harness.terminal.emitInput("/original/workspace");
  harness.terminal.emitInput("\x07"); // Ctrl+G from the current native keybinding
  await nextTurn();
  assert.deepEqual(captured, {
    text: "/original/workspace",
    cwd: process.cwd(),
    signalAborted: false,
  });
  assert.equal(harness.terminal.started, true, "the host terminal is restarted after the editor exits");
  assert.equal(harness.terminal.stopCount, 1);
  assert.equal(initialWriter.closed, true, "the old frame writer exits its alternate screen before the editor starts");
  assert.equal(harness.writers.length, 2, "the host gets a fresh frame writer after editor ownership ends");
  assert.equal(harness.writer.started, true, "the fresh frame writer re-enters the host screen");
  assert.ok(harness.events.indexOf("terminal.stop") < harness.events.indexOf("external-editor.run"));
  assert.ok(harness.events.indexOf("external-editor.run") < harness.events.lastIndexOf("terminal.start"));
  assert.ok(harness.events.indexOf("writer.close") < harness.events.indexOf("external-editor.run"));
  assert.ok(harness.events.lastIndexOf("writer.start") > harness.events.indexOf("external-editor.run"));
  const form = harness.sidebar?.renderForm(80, 24).lines.join("\n") ?? "";
  assert.match(form, /edited-in-native-editor/);
  assert.equal(await closeWithSignal(harness), 0);
});

test("external-editor writer close is a barrier and no host frames are submitted while the editor owns the tty", async () => {
  let releaseWriterClose!: () => void;
  const writerCloseGate = new Promise<void>((resolve) => { releaseWriterClose = resolve; });
  let editorEntered!: () => void;
  const editorStarted = new Promise<void>((resolve) => { editorEntered = resolve; });
  let finishEditor!: (result: string) => void;
  const harness = createHarness({}, {
    runExternalEditor: (text) => new Promise<string>((resolve) => {
      harness.events.push("external-editor.run");
      editorEntered();
      finishEditor = resolve;
      assert.equal(harness.terminal.started, false);
      assert.ok(text.startsWith("/"));
    }),
  });
  await ready(harness);
  const initialWriter = harness.writer;
  initialWriter.closeGate = writerCloseGate;
  harness.terminal.emitInput(ENTER);
  harness.terminal.emitInput("/synthetic/workspace");
  harness.terminal.emitInput("\x07"); // Ctrl+G
  await nextTurn();
  assert.equal(initialWriter.closeStarted, true, "pending output settlement begins before the editor is spawned");
  assert.equal(harness.events.includes("external-editor.run"), false, "the editor waits for the writer close barrier");
  harness.manager?.notify("during-writer-close");
  await nextTurn();
  assert.equal(initialWriter.submitsAfterClose, 0);

  releaseWriterClose();
  await editorStarted;
  assert.equal(harness.writers.length, 1, "the replacement writer is not created while the editor owns stdout");
  const framesBeforeEditorMutation = initialWriter.frames.length;
  harness.manager?.notify("during-editor");
  await nextTurn();
  assert.equal(initialWriter.frames.length, framesBeforeEditorMutation);
  assert.equal(initialWriter.submitsAfterClose, 0);

  finishEditor("/synthetic/edited");
  await nextTurn();
  assert.equal(harness.writers.length, 2);
  assert.equal(harness.writer.started, true);
  assert.equal(harness.terminal.started, true);
  assert.ok(harness.events.lastIndexOf("writer.start") > harness.events.indexOf("external-editor.run"));
  assert.ok(harness.events.lastIndexOf("writer.start") < harness.events.lastIndexOf("terminal.start"));
  assert.equal(await closeWithSignal(harness), 0);
});

test("external editor is not spawned when the frame writer cannot settle safely", async () => {
  let editorSpawned = false;
  const harness = createHarness({}, {
    runExternalEditor: async () => {
      editorSpawned = true;
      return "should-not-be-read";
    },
  });
  await ready(harness);
  harness.writer.closeResult = false;
  harness.terminal.emitInput(ENTER);
  harness.terminal.emitInput("/synthetic/workspace");
  harness.terminal.emitInput("\x07"); // Ctrl+G
  assert.equal(await harness.result, 1, "incomplete output settlement fails the host closed");
  assert.equal(editorSpawned, false);
  assert.equal(harness.terminal.stopCount, 1);
});

test("external-editor field application preserves edge spaces and truthfully rejects multiline output", async () => {
  let result = "  replacement title  \n";
  const harness = createHarness({}, {
    runExternalEditor: syntheticExternalEditor(() => result),
  });

  await ready(harness);
  harness.terminal.emitInput(ENTER);
  harness.terminal.emitInput("/original/workspace");
  harness.terminal.emitInput("\x07");
  await nextTurn();
  const first = harness.sidebar?.renderForm(80, 24).lines.join("\n") ?? "";
  assert.ok(first.includes("  replacement title  "), first);

  result = "first line\nsecond line\n";
  harness.terminal.emitInput("\x07");
  await nextTurn();
  const rejected = harness.sidebar?.renderForm(80, 24).lines.join("\n") ?? "";
  assert.ok(rejected.includes("Unsafe terminal text was rejected"), rejected);
  assert.ok(rejected.includes("replacement title"), "the previous valid value remains after multiline rejection");
  assert.equal(await closeWithSignal(harness), 0);
});

test("Main applies native app.clear and app.interrupt bindings and reloads them when a form is reopened", async () => {
  const agentDir = makeMainTestDirectory("keybindings");
  const keybindingsPath = join(agentDir, "keybindings.json");
  const writeKeybindings = (clear: string, interrupt: string): void => {
    writeFileSync(keybindingsPath, JSON.stringify({ "app.clear": clear, "app.interrupt": interrupt }), "utf8");
  };
  try {
    writeKeybindings("ctrl+l", "ctrl+x");
    const harness = createHarness({}, {
      createSessionSetup: () => ({
        nativeSetup: false,
        nativeAgentDir: agentDir,
        profileRegistry: { prepare: () => { throw new Error("synthetic profile preparation is not expected"); } } satisfies ProfilePreparer,
      }),
    });
    await ready(harness);
    harness.terminal.emitInput(ENTER);
    const initialHints = harness.sidebar?.renderForm(80, 24).lines.join("\n") ?? "";
    assert.ok(initialHints.includes("ctrl+l clear"), initialHints);
    assert.ok(initialHints.includes("ctrl+x cancel"), initialHints);
    harness.terminal.emitInput("/first/workspace");
    harness.terminal.emitInput("\x0c"); // configured app.clear = Ctrl+L
    assert.ok(!(harness.sidebar?.renderForm(80, 24).lines.join("\n") ?? "").includes("/first/workspace"));
    harness.terminal.emitInput("draft");
    harness.terminal.emitInput("\x18"); // configured app.interrupt = Ctrl+X
    assert.equal(harness.sidebar?.visible, true,
      "the configured interrupt cancels New locally and leaves the roster visible");
    assert.equal(harness.sidebar?.focus, "sidebar");

    writeKeybindings("ctrl+u", "ctrl+z");
    await nextTurn(); // Draw the restored roster before another targeted action.
    harness.terminal.emitInput(ENTER);
    const reopenedHints = harness.sidebar?.renderForm(80, 24).lines.join("\n") ?? "";
    assert.ok(reopenedHints.includes("ctrl+u clear"), reopenedHints);
    assert.ok(reopenedHints.includes("ctrl+z cancel"), reopenedHints);
    harness.terminal.emitInput("/second/workspace");
    harness.terminal.emitInput("\x0c"); // old binding is no longer clear
    assert.ok((harness.sidebar?.renderForm(80, 24).lines.join("\n") ?? "").includes("/second/workspace"));
    harness.terminal.emitInput("\x15"); // new app.clear = Ctrl+U
    assert.ok(!(harness.sidebar?.renderForm(80, 24).lines.join("\n") ?? "").includes("/second/workspace"));
    harness.terminal.emitInput("\x18"); // old interrupt no longer cancels
    assert.equal(harness.sidebar?.visible, true);
    harness.terminal.emitInput("\x1a"); // new app.interrupt = Ctrl+Z
    assert.equal(harness.sidebar?.visible, true,
      "the reloaded interrupt also cancels New locally instead of hiding the roster");
    assert.equal(harness.sidebar?.focus, "sidebar");
    assert.equal(await closeWithSignal(harness), 0);
  } finally {
    rmSync(agentDir, { recursive: true, force: true });
  }
});

test("pending create uses the configured interrupt and ignores its late result after reopening New", async () => {
  const agentDir = makeMainTestDirectory("pending-create-keys");
  writeFileSync(join(agentDir, "keybindings.json"), JSON.stringify({ "app.clear": "ctrl+l", "app.interrupt": "ctrl+x" }), "utf8");
  try {
    const harness = createHarness({}, {
      createSessionSetup: () => ({
        nativeSetup: false,
        nativeAgentDir: agentDir,
        profileRegistry: { prepare: () => { throw new Error("synthetic profile preparation is not expected"); } } satisfies ProfilePreparer,
      }),
    });
    const manager = await ready(harness);
    let releaseCreate!: () => void;
    let enterCreate!: () => void;
    const createEntered = new Promise<void>((resolve) => { enterCreate = resolve; });
    manager.createGate = new Promise<void>((resolve) => { releaseCreate = resolve; });
    manager.createGateEntered = enterCreate;

    harness.terminal.emitInput(ENTER);
    harness.terminal.emitInput("/pending/workspace");
    harness.terminal.emitInput(ENTER);
    await createEntered;
    assert.equal(harness.sidebar?.focus, "form");
    harness.terminal.emitInput(ESC);
    assert.equal(harness.sidebar?.focus, "form", "unbound Escape does not abandon the pending form");
    assert.equal(harness.sidebar?.visible, true);
    harness.terminal.emitInput("\x18");
    assert.equal(harness.sidebar?.visible, true,
      "the configured Ctrl+X interrupt abandons the pending form locally and leaves the roster visible");
    assert.equal(harness.sidebar?.focus, "sidebar");

    await nextTurn(); // Draw the restored roster before another targeted action.
    harness.terminal.emitInput(ENTER);
    assert.equal(harness.sidebar?.focus, "form");
    harness.terminal.emitInput("\x0c"); // Clear the retained draft with app.clear.
    harness.terminal.emitInput("/reopened/workspace");
    releaseCreate();
    await nextTurn();
    await nextTurn();
    const reopened = harness.sidebar?.renderForm(80, 24).lines.join("\n") ?? "";
    assert.equal(harness.sidebar?.visible, true);
    assert.equal(harness.sidebar?.focus, "form");
    assert.ok(reopened.includes("/reopened/workspace"), reopened);
    assert.equal(await closeWithSignal(harness), 0);
  } finally {
    rmSync(agentDir, { recursive: true, force: true });
  }
});

test("pending rename uses the configured interrupt and ignores its late result after reopening Edit", async () => {
  const agentDir = makeMainTestDirectory("pending-rename-keys");
  writeFileSync(join(agentDir, "keybindings.json"), JSON.stringify({ "app.clear": "ctrl+l", "app.interrupt": "ctrl+x" }), "utf8");
  try {
    const harness = createHarness({}, {
      createSessionSetup: () => ({
        nativeSetup: false,
        nativeAgentDir: agentDir,
        profileRegistry: { prepare: () => { throw new Error("synthetic profile preparation is not expected"); } } satisfies ProfilePreparer,
      }),
    });
    const manager = await ready(harness);
    fillForm(harness.terminal, "/pending-rename/workspace");
    await nextTurn();

    let releaseRename!: () => void;
    let enterRename!: () => void;
    const renameEntered = new Promise<void>((resolve) => { enterRename = resolve; });
    manager.renameGate = new Promise<void>((resolve) => { releaseRename = resolve; });
    manager.renameGateEntered = enterRename;
    harness.terminal.emitInput(ALT_LEFT); // return from the auto-activated child to the visible sidebar
    harness.terminal.emitInput("e");
    harness.terminal.emitInput("Delayed rename");
    harness.terminal.emitInput(ENTER);
    await renameEntered;
    assert.equal(harness.sidebar?.focus, "form");
    harness.terminal.emitInput(ESC);
    assert.equal(harness.sidebar?.focus, "form", "unbound Escape does not abandon the pending rename");
    harness.terminal.emitInput("\x18");
    assert.equal(harness.sidebar?.visible, true, "Edit cancellation preserves the visible roster");
    assert.equal(harness.sidebar?.focus, "sidebar");

    await nextTurn(); // Draw the restored roster before another targeted action.
    harness.terminal.emitInput("e");
    assert.equal(harness.sidebar?.focus, "form");
    harness.terminal.emitInput("Reopened replacement");
    releaseRename();
    await nextTurn();
    await nextTurn();
    const reopened = harness.sidebar?.renderForm(80, 24).lines.join("\n") ?? "";
    assert.equal(harness.sidebar?.visible, true);
    assert.equal(harness.sidebar?.focus, "form");
    assert.ok(reopened.includes("Reopened replacement"), reopened);
    assert.equal(reopened.includes("Saving native name"), false);
    assert.equal(await closeWithSignal(harness), 0);
  } finally {
    rmSync(agentDir, { recursive: true, force: true });
  }
});

test("absent native keybindings are silent with real defaults while unavailable/unsupported notices render in narrow forms and clear after valid reopen", async () => {
  const root = makeMainTestDirectory("keybinding-notices");
  const absentDir = join(root, "absent-agent");
  const unavailablePath = join(root, "not-an-agent-directory");
  const unsupportedDir = join(root, "unsupported-agent");
  mkdirSync(absentDir);
  writeFileSync(unavailablePath, "not a directory", "utf8");
  mkdirSync(unsupportedDir);
  const unsupportedKeybindings = join(unsupportedDir, "keybindings.json");
  writeFileSync(unsupportedKeybindings, "{invalid json", "utf8");
  const createConfiguredHarness = (nativeAgentDir: string): Harness => createHarness({}, {
    createSessionSetup: () => ({
      nativeSetup: false,
      nativeAgentDir,
      profileRegistry: { prepare: () => { throw new Error("synthetic profile preparation is not expected"); } } satisfies ProfilePreparer,
    }),
  });
  const noticeInForm = (harness: Harness): string => {
    const rendered = harness.sidebar?.render(40, 24).lines.join("\n") ?? "";
    assert.equal(harness.sidebar?.focus, "form");
    assert.ok(!rendered.includes("too small"), rendered);
    return rendered.replace(/\x1b\[[0-9;]*m/g, "").replace(/\s+/g, " ");
  };
  try {
    const absent = createConfiguredHarness(absentDir);
    await ready(absent);
    absent.terminal.columns = 40;
    absent.terminal.emitInput(ENTER);
    const absentForm = noticeInForm(absent);
    assert.equal(absentForm.includes("Native keybindings.json"), false,
      "a genuinely absent optional keybindings file renders no warning");
    for (const hint of ["enter create", "escape cancel", "tab complete", "ctrl+c clear", "ctrl+g external editor"]) {
      assert.ok(absentForm.includes(hint),
        `absent keybindings silently use Pi's real default ${hint} hint\n${absentForm}`);
    }
    absent.terminal.emitInput("/default-bound/workspace");
    assert.ok((absent.sidebar?.renderForm(40, 24).lines.join("\n") ?? "").includes("/default-bound/workspace"));
    absent.terminal.emitInput("\x03"); // the real default app.clear binding is Ctrl+C
    assert.equal((absent.sidebar?.renderForm(40, 24).lines.join("\n") ?? "").includes("/default-bound/workspace"), false,
      "an absent keybindings file silently uses Pi's real default clear binding");
    assert.equal(await closeWithSignal(absent), 0);

    const unavailable = createConfiguredHarness(unavailablePath);
    await ready(unavailable);
    unavailable.terminal.columns = 40;
    unavailable.terminal.emitInput(ENTER);
    const unavailableForm = noticeInForm(unavailable);
    assert.ok(unavailableForm.includes("Native keybindings.json is unavailable"), unavailableForm);
    assert.equal(await closeWithSignal(unavailable), 0);

    const unsupported = createConfiguredHarness(unsupportedDir);
    const manager = await ready(unsupported);
    const tuple = { sessionId: "conversation-notice", epoch: 1, name: "Observed" };
    manager.views.push({
      id: "notice-session", label: tuple.name, workspace: "/workspace", agentDir: unsupportedDir,
      lifecycle: "alive", busy: false, pendingInput: false, inputSurface: false,
      nativeSession: tuple, hasLiveProcess: true, activity: [],
    });
    manager.notify("notice-session");
    await nextTurn();
    unsupported.terminal.columns = 40;
    assert.equal(unsupported.sidebar?.openEdit({ id: "notice-session", nativeSession: tuple, currentName: tuple.name }), true);
    assert.ok(noticeInForm(unsupported).includes("Native keybindings.json has an unsupported format"));

    unsupported.terminal.emitInput(ESC);
    assert.equal(unsupported.sidebar?.visible, true);
    assert.equal(unsupported.sidebar?.focus, "sidebar");
    writeFileSync(unsupportedKeybindings, JSON.stringify({ "app.clear": "ctrl+u", "app.interrupt": "ctrl+x" }), "utf8");
    assert.equal(unsupported.sidebar?.openEdit({ id: "notice-session", nativeSession: tuple, currentName: tuple.name }), true);
    const valid = noticeInForm(unsupported);
    assert.ok(valid.includes("ctrl+u clear"), valid);
    assert.ok(valid.includes("ctrl+x cancel"), valid);
    assert.equal(valid.includes("unsupported format"), false);
    assert.equal(await closeWithSignal(unsupported), 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Main carries the observed tuple into Edit and leaves a stale rename unconfirmed", async () => {
  const harness = createHarness();
  const manager = await ready(harness);
  fillForm(harness.terminal, "/stale-rename/workspace");
  await nextTurn();
  harness.terminal.emitInput(ALT_LEFT); // return from the auto-activated child to the visible sidebar
  harness.terminal.emitInput("e");
  assert.equal(harness.sidebar?.focus, "form");

  const current = manager.views[0]!;
  const changed = {
    sessionId: current.nativeSession!.sessionId,
    epoch: current.nativeSession!.epoch + 1,
    name: "New conversation title",
  };
  manager.views[0] = { ...current, label: changed.name, nativeSession: changed };
  manager.notify("native-1");
  await nextTurn();
  harness.terminal.emitInput("Replacement");
  harness.terminal.emitInput(ENTER);
  await nextTurn();
  assert.equal(manager.renameCalls[0]?.request.expectedSessionEpoch, 1, "the request keeps the Edit-time epoch");
  assert.equal(manager.views[0]?.label, "New conversation title", "the stale form cannot overwrite a newer name");
  assert.equal(harness.sidebar?.focus, "form");
  const text = harness.sidebar?.render(48, 10).lines.join("\n") ?? "";
  assert.match(text, /conversation changed/i);
  assert.deepEqual(manager.writes, []);
  assert.equal(await closeWithSignal(harness), 0);
});

test("removing the active exited row clears ownership to the picker and stale snapshots cannot revive it", async () => {
  const harness = createHarness();
  const manager = await startTwoSessions(harness);

  harness.terminal.emitInput("\x1b[A"); // second -> first
  harness.terminal.emitInput(ENTER); // explicitly make first the active owner
  const firstIndex = manager.views.findIndex((view) => view.id === "native-1");
  const first = manager.views[firstIndex];
  assert.ok(first);
  const exitedFirst = { ...first, lifecycle: "exited" as const, hasLiveProcess: false, busy: null, pendingInput: null };
  manager.views[firstIndex] = exitedFirst;
  manager.notify("native-1");
  await nextTurn();

  harness.terminal.emitInput(ALT_LEFT); // focus the displayed sidebar roster on the exited owner
  await nextTurn(); // the complete sidebar-focused roster owns the Delete action
  assert.equal(harness.sidebar?.focus, "sidebar");
  assert.equal(harness.sidebar?.visible, true);
  assert.equal(harness.sidebar?.selectedId, "native-1");
  harness.terminal.emitInput(DELETE);
  await nextTurn();

  assert.deepEqual(manager.closeExitedCalls, ["native-1"]);
  assert.deepEqual(manager.views.map((view) => view.id), ["native-2"]);
  assert.deepEqual(harness.sidebar?.items.map((view) => view.id), ["native-2"]);
  assert.equal(harness.sidebar?.selectedId, undefined, "removing the owner must not auto-select its sibling");
  assert.equal(harness.sidebar?.focus, "sidebar");
  assert.equal(harness.sidebar?.visible, true, "the dead Main surface returns to the visible picker");
  assert.equal(manager.views[0]?.hasLiveProcess, true, "the live sibling remains untouched");
  assert.ok(plain(harness.writer.frames.at(-1)?.frame).includes("New session"), "the picker remains usable");

  // Simulate a delayed stale roster snapshot for the same id. The Main
  // tombstone keeps that successful removal from being rendered again.
  manager.staleListedViews.push(exitedFirst);
  manager.notify("late-old-snapshot");
  await nextTurn();
  assert.deepEqual(harness.sidebar?.items.map((view) => view.id), ["native-2"]);
  assert.equal(plain(harness.writer.frames.at(-1)?.frame).includes("label-native-1"), false);

  harness.terminal.emitInput(ESC); // no active owner remains after hiding the picker
  harness.terminal.emitInput("must not reach the sibling");
  assert.deepEqual(manager.writes, []);
  assert.equal(manager.shutdownCalls, 0, "removal never uses host shutdown");

  const sibling = manager.views[0];
  assert.ok(sibling);
  manager.views[0] = { ...sibling, lifecycle: "exited", hasLiveProcess: false, busy: null, pendingInput: null };
  manager.notify("last-row-exited");
  await nextTurn();
  harness.terminal.emitInput(ALT_LEFT); // reopen the picker with no selection
  await nextTurn(); // the complete reopened roster is drawn before the Delete action
  harness.terminal.emitInput("\x1b[B"); // select the last exited row
  harness.terminal.emitInput(DELETE);
  await nextTurn();
  assert.deepEqual(manager.views, []);
  assert.equal(harness.sidebar?.focus, "sidebar");
  assert.equal(harness.sidebar?.visible, true);
  harness.terminal.emitInput("\x1b[B"); // cleared selection -> Saved conversations
  harness.terminal.emitInput("\x1b[B"); // -> New session
  harness.terminal.emitInput(ENTER);
  assert.equal(harness.sidebar?.focus, "form");
  assert.match(harness.sidebar?.render(40, 8).lines.join("\n") ?? "", /New session/);
  assert.equal(await closeWithSignal(harness), 0);
});

test("removing an inactive exited row preserves the live owner, status, surface, and New-session draft", async () => {
  const harness = createHarness();
  const manager = await startTwoSessions(harness);
  harness.terminal.emitInput(ENTER); // second row remains highlighted; explicitly activate it
  assert.equal(harness.sidebar?.focus, "main");

  const firstIndex = manager.views.findIndex((view) => view.id === "native-1");
  const first = manager.views[firstIndex];
  assert.ok(first);
  manager.views[firstIndex] = { ...first, lifecycle: "exited", hasLiveProcess: false, busy: null, pendingInput: null };
  const secondIndex = manager.views.findIndex((view) => view.id === "native-2");
  const second = manager.views[secondIndex];
  assert.ok(second);
  const inputStatus = {
    ...second,
    busy: true,
    pendingInput: true,
    inputSurface: true,
    activity: ["Waiting for input"],
  };
  manager.views[secondIndex] = inputStatus;
  const secondSurface = manager.surface("native-2");
  assert.ok(secondSurface);
  manager.notify("status-update");
  await nextTurn();

  harness.terminal.emitInput(ALT_LEFT); // focus the visible picker on the active sibling
  assert.equal(harness.sidebar?.focus, "sidebar");
  assert.equal(harness.sidebar?.visible, true);
  await nextTurn(); // the complete roster is drawn before any targeted navigation
  harness.terminal.emitInput("\x1b[B"); // second -> Saved conversations
  harness.terminal.emitInput("\x1b[B"); // -> New session
  harness.terminal.emitInput(ENTER);
  harness.terminal.emitInput("retained draft");
  harness.terminal.emitInput(ALT_LEFT); // hide without discarding the form draft
  harness.terminal.emitInput(ALT_LEFT); // reopen with New session still selected
  await nextTurn(); // the complete reopened roster is drawn before navigation
  harness.terminal.emitInput("\x1b[A"); // New -> Saved conversations
  harness.terminal.emitInput("\x1b[A"); // Saved -> second
  harness.terminal.emitInput("\x1b[A"); // second -> exited first
  assert.equal(harness.sidebar?.selectedId, "native-1");
  harness.terminal.emitInput(DELETE);
  await nextTurn();

  assert.deepEqual(manager.closeExitedCalls, ["native-1"]);
  assert.deepEqual(manager.views.map((view) => view.id), ["native-2"]);
  assert.equal(harness.sidebar?.selectedId, undefined, "the removed inactive row is not replaced by a guessed selection");
  assert.equal(harness.sidebar?.focus, "sidebar");
  assert.equal(manager.surface("native-2"), secondSurface, "the active sibling keeps the same terminal surface");
  const preserved = manager.views[0];
  assert.equal(preserved?.busy, true);
  assert.equal(preserved?.pendingInput, true);
  assert.equal(preserved?.inputSurface, true);
  assert.deepEqual(preserved?.activity, ["Waiting for input"]);

  harness.terminal.emitInput("\x1b[B"); // no selection -> second row
  harness.terminal.emitInput("\x1b[B"); // -> Saved conversations
  harness.terminal.emitInput("\x1b[B"); // -> New session
  harness.terminal.emitInput(ENTER);
  const formText = harness.sidebar?.render(48, 8).lines.join("\n").replace(/\x1b\[[0-9;]*m/g, "") ?? "";
  assert.match(formText, /retained draft/, "removing another row does not reset the New-session draft");
  harness.terminal.emitInput(ALT_LEFT); // return to Main without changing the active owner
  harness.terminal.emitInput("still owned by second");
  assert.deepEqual(manager.writes.at(-1), { id: "native-2", data: "still owned by second" });
  assert.equal(await closeWithSignal(harness), 0);
});

test("failed, live, and unconfirmed removals leave the row and owner in place with a bounded notice", async () => {
  const harness = createHarness();
  const manager = await ready(harness);
  fillForm(harness.terminal, "removal refusal");
  await nextTurn();
  const original = manager.views[0];
  assert.ok(original);
  manager.views[0] = { ...original, lifecycle: "exited", hasLiveProcess: false, busy: null, pendingInput: null };
  manager.refusedCloseIds.add("native-1"); // model a stale/failed backend removal
  manager.notify("confirmed-exit");
  await nextTurn();

  harness.terminal.emitInput(ALT_LEFT); // focus the displayed sidebar roster
  await nextTurn(); // the selected exited card is completely drawn before Delete
  harness.terminal.emitInput(DELETE);
  await nextTurn();
  assert.deepEqual(manager.closeExitedCalls, ["native-1"]);
  assert.deepEqual(manager.views.map((view) => view.id), ["native-1"]);
  assert.equal(harness.sidebar?.selectedId, "native-1");
  const refusedFrame = harness.writer.frames.at(-1);
  assert.ok(refusedFrame?.frame, "the refused removal renders a composed frame");
  const refusedNoticeText = plain(refusedFrame.frame);
  const refusedNotice = sidebarNoticeRows(refusedNoticeText, REMOVE_REFUSED_NOTICE);
  assert.ok(refusedNotice !== undefined,
    `the complete refusal notice is rendered wrapped in the sidebar: ${JSON.stringify(refusedNoticeText)}`);

  manager.refusedCloseIds.delete("native-1");
  manager.views.splice(0, 1); // the sidebar snapshot now refers to a stale backend id
  harness.terminal.emitInput(DELETE);
  await nextTurn();
  assert.deepEqual(manager.closeExitedCalls, ["native-1", "native-1"]);
  assert.deepEqual(harness.sidebar?.items.map((view) => view.id), ["native-1"], "a stale refusal keeps the visible row");
  assert.equal(harness.sidebar?.selectedId, "native-1");

  // Restore only the manager's authoritative row to a live child while the
  // sidebar still displays the previously rendered exited card: Delete takes
  // the exited-row path, and the manager's closeExited refuses the live row.
  manager.views.push({ ...original, lifecycle: "alive", hasLiveProcess: true });
  harness.terminal.emitInput(DELETE);
  await nextTurn();
  assert.deepEqual(manager.closeExitedCalls, ["native-1", "native-1", "native-1"]);
  assert.equal(manager.views[0]?.hasLiveProcess, true);
  assert.equal(harness.sidebar?.items.length, 1, "the refused removal keeps the displayed row");

  manager.views[0] = { ...original, lifecycle: "exited", hasLiveProcess: true };
  manager.notify("unconfirmed-exit");
  harness.terminal.emitInput(DELETE); // an exited badge is insufficient without confirmed process exit
  await nextTurn();
  assert.deepEqual(manager.closeExitedCalls, ["native-1", "native-1", "native-1", "native-1"]);
  assert.equal(manager.views[0]?.hasLiveProcess, true);
  const unconfirmedFrame = harness.writer.frames.at(-1);
  assert.ok(unconfirmedFrame?.frame, "the unconfirmed refusal renders a composed frame");
  const unconfirmedNoticeText = plain(unconfirmedFrame.frame);
  const notice = sidebarNoticeRows(unconfirmedNoticeText, REMOVE_REFUSED_NOTICE);
  assert.ok(notice !== undefined,
    `the complete refusal notice is rendered wrapped in the sidebar: ${JSON.stringify(unconfirmedNoticeText)}`);
  assert.ok(notice.join(" ").length <= 300, "refusal is bounded and truthful");
  assert.equal(manager.shutdownCalls, 0);
  assert.equal(harness.terminal.stopCount, 0, "refusal never stops the process or terminal");

  // A currently rendered LIVE card must never reach closeExited: Delete enters
  // the guarded stop confirmation for the frozen row instead.
  manager.views[0] = { ...original, lifecycle: "alive", hasLiveProcess: true };
  manager.notify("live-card-rendered");
  await nextTurn();
  const closeCallsBeforeGuardedStop = manager.closeExitedCalls.length;
  harness.terminal.emitInput(DELETE);
  await nextTurn();
  assert.equal(manager.closeExitedCalls.length, closeCallsBeforeGuardedStop,
    "a rendered live card never reaches closeExited directly");
  assert.equal(harness.sidebar?.focus, "confirm", "a rendered live card enters the guarded stop confirmation");
  const stopConfirmText = plain(harness.writer.frames.at(-1)?.frame);
  assert.ok(stopConfirmText.includes("Stop session?"), `the guarded stop confirmation is drawn: ${stopConfirmText}`);
  assert.ok(stopConfirmText.includes("esc/n = cancel"), "the confirmation exposes its cancel binding before any stop");
  assert.equal(manager.shutdownCalls, 0);
  assert.equal(harness.terminal.stopCount, 0);

  // Cancelling the confirmation preserves the displayed row, the owner, and
  // every process; nothing was stopped or removed.
  harness.terminal.emitInput(ESC);
  await nextTurn();
  assert.equal(harness.sidebar?.focus, "sidebar");
  assert.equal(harness.sidebar?.visible, true);
  assert.equal(harness.sidebar?.selectedId, "native-1");
  assert.equal(manager.closeExitedCalls.length, closeCallsBeforeGuardedStop);

  harness.terminal.emitInput(ALT_LEFT); // hide the sidebar, return to native focus
  harness.terminal.emitInput(DELETE); // Delete is native in Main focus, not a closeExited request
  assert.equal(manager.closeExitedCalls.length, closeCallsBeforeGuardedStop);
  assert.deepEqual(manager.writes.at(-1), { id: "native-1", data: DELETE });
  harness.terminal.emitInput("owner is preserved");
  assert.deepEqual(manager.writes.at(-1), { id: "native-1", data: "owner is preserved" });
  assert.equal(await closeWithSignal(harness), 0);
});

test("wide form temporarily replaces the right pane; the child stays alive, unresized, and unrouted", async () => {
  const harness = createHarness();
  const manager = await ready(harness);

  fillForm(harness.terminal, "first");
  await nextTurn();
  assert.equal(manager.views[0]?.id, "native-1");
  assert.equal(manager.views[0]?.hasLiveProcess, true);

  harness.terminal.emitInput(ALT_LEFT); // focus the visible sidebar roster on native-1
  await nextTurn();
  assert.equal(harness.sidebar?.focus, "sidebar");
  assert.equal(harness.sidebar?.visible, true);
  const resizesBeforeForm = manager.resizeCalls.length;
  harness.terminal.emitInput("\x1b[B"); // -> Saved conversations
  harness.terminal.emitInput("\x1b[B"); // -> New session row
  harness.terminal.emitInput(ENTER); // open the form
  harness.terminal.emitInput("draft label"); // form field input
  await nextTurn();
  assert.equal(harness.sidebar?.focus, "form");

  const frame = harness.writer.frames.at(-1)?.frame;
  assert.ok(frame, "a composed frame exists while the form is open");
  const left = plainLine(frame, 1).slice(0, 32);
  const right = plainLine(frame, 1).slice(33);
  assert.ok(left.includes("Sessions (1)"), `roster stays in the left pane: ${JSON.stringify(left)}`);
  assert.ok(right.trimStart().startsWith("New session"), `form owns the right pane: ${JSON.stringify(right)}`);
  assert.ok(!frame.lines.join("\n").includes("frame:native-1"), "the child frame is hidden, not destroyed, while the form is open");
  // The retained workspace draft ("first" + "draft label") puts the caret at
  // pane column 13 + 16 = 29, offset by the right pane origin.
  assert.deepEqual(frame.cursor, { column: 62, row: 3, visible: true }, "form caret offsets into the right pane and native Editor completion viewport");
  assert.equal(manager.resizeCalls.length, resizesBeforeForm, "opening the form never resizes the child");
  assert.deepEqual(manager.writes, [], "form input is never broadcast to the child");

  harness.terminal.emitInput(ESC); // cancel New locally: the visible roster returns, still sidebar-focused
  await nextTurn();
  assert.equal(harness.sidebar?.focus, "sidebar", "New cancellation returns ownership to the visible roster");
  assert.equal(harness.sidebar?.visible, true, "New cancellation never hides the sidebar");
  assert.equal(manager.views[0]?.hasLiveProcess, true, "cancelling the form leaves the child alive");
  assert.equal(manager.resizeCalls.length, resizesBeforeForm, "cancelling the form does not resize the child either");
  const restored = harness.writer.frames.at(-1)?.frame;
  assert.ok(restored, "a composed frame exists after the form closes");
  assert.ok(plainLine(restored, 1).slice(0, 32).includes("Sessions (1)"),
    `the visible roster remains in the left pane: ${JSON.stringify(plainLine(restored, 1).slice(0, 32))}`);
  assert.ok(plainLine(restored, 1).slice(33).startsWith("frame:native-1"),
    `the same child frame returns to the right pane: ${JSON.stringify(plainLine(restored, 1).slice(33))}`);
  harness.terminal.emitInput(ALT_LEFT); // deliberate hide: full-width native pane
  await nextTurn();
  assert.equal(harness.sidebar?.focus, "main");
  assert.equal(harness.sidebar?.visible, false);
  assert.deepEqual(manager.resizeCalls.at(-1), { cols: 80, rows: 23, ids: ["native-1"] }, "hiding the sidebar restores the full-width native pane");
  harness.terminal.emitInput("q"); // main input still routes to the same active child
  assert.deepEqual(manager.writes.at(-1), { id: "native-1", data: "q" });
  assert.equal(await closeWithSignal(harness), 0);
});

test("create error row reports only a generic message and preserves the editable draft", async () => {
  const harness = createHarness();
  const manager = await ready(harness);
  manager.nextError = true;
  fillForm(harness.terminal, "/missing/workspace");
  await nextTurn();
  assert.equal(manager.views[0]?.lifecycle, "error");
  assert.equal(manager.views[0]?.error, "synthetic-secret-native-error", "the fixture confirms a private error existed");
  assert.ok(harness.sidebar);
  assert.equal(harness.sidebar.focus, "form");
  const formText = harness.sidebar.render(40, 8).lines.join("\n").replace(/\x1b\[[0-9;]*m/g, "");
  assert.match(formText, /missing\/workspace/);
  assert.match(formText, /Session could not be started/);
  assert.doesNotMatch(formText, /profile/i, "create errors do not ask for a removed Profile field");
  assert.doesNotMatch(formText, /synthetic-secret-native-error/);
  assert.equal(harness.writer.frames.some(({ frame }) => plain(frame).includes("synthetic-secret-native-error")), false);
  assert.equal(harness.reports.some((message) => message.includes("synthetic-secret")), false);
  assert.equal(await closeWithSignal(harness), 0);
});

test("late create after form abandonment may finish but cannot steal focus or auto-activate", async () => {
  const harness = createHarness();
  const manager = await started(harness);
  fillForm(harness.terminal, "late draft");
  assert.equal(manager.createOptions.length, 0, "create waits during initial negotiation");
  harness.terminal.emitInput(ESC); // abandon the form while its create is still deferred
  assert.equal(manager.createOptions.length, 0);
  harness.observer.settle(0);
  await nextTurn();
  assert.equal(manager.createOptions.length, 1, "abandoning UI ownership does not cancel an already submitted native launch");
  assert.equal(manager.views[0]?.hasLiveProcess, true);
  harness.terminal.emitInput(ESC);
  harness.terminal.emitInput("q");
  harness.terminal.emitInput("Q");
  harness.terminal.emitInput("\x03");
  assert.equal(manager.writes.length, 0, "late completion neither steals Main focus nor creates an active owner");
  assert.equal(manager.shutdownCalls, 0, "native Main keys do not become a host-wide quit fallback");
  assert.equal(await closeWithSignal(harness), 0);
});

test("mouse routing uses active live child modes, mode-only changes, native viewport clipping, and owned resets", async () => {
  const harness = createHarness();
  const manager = await ready(harness);
  fillForm(harness.terminal, "mouse owner");
  await nextTurn();
  const surface = manager.surface("native-1");
  assert.ok(surface);
  surface.modes = { ...surface.modes, mouseTracking: "drag", mouseEncoding: "sgr" };
  // The completed New already made native-1 the active Main owner; a roster
  // notification re-syncs the host's owned mouse modes for its live surface.
  manager.notify();
  assert.ok(harness.terminal.writes.includes("\x1b[?1002h"));
  assert.ok(harness.terminal.writes.includes("\x1b[?1006h"));

  const beforeModeOnly = harness.terminal.writes.length;
  surface.modes = { ...surface.modes, mouseTracking: "vt200" };
  manager.notify(); // no frame bytes changed; mode-only owner callback still reconfigures input
  assert.deepEqual(harness.terminal.writes.slice(beforeModeOnly), ["\x1b[?1002l", "\x1b[?1000h"]);

  const beforeMouse = manager.writes.length;
  harness.terminal.emitInput("\x1b[<0;35;2M"); // absolute (35,2) => native pane origin + (1,0)
  harness.terminal.emitInput("\x1b[<0;33;2M"); // left of native pane: clipped, never edge-clamped
  assert.deepEqual(manager.writes.slice(beforeMouse).map((entry) => entry.data), ["\x1b[<0;2;1M"]);

  const beforeFocusReset = harness.terminal.writes.length;
  // Main -> Sidebar focus is focus-only: the layout and native geometry are
  // untouched, and the host disables only its own tracking/encoding.
  harness.terminal.emitInput(ALT_LEFT);
  assert.deepEqual(harness.terminal.writes.slice(beforeFocusReset), ["\x1b[?1000l", "\x1b[?1006l"]);
  assert.equal(harness.sidebar?.focus, "sidebar");
  assert.equal(harness.sidebar?.visible, true);
  const beforeFocusReenable = harness.terminal.writes.length;
  // Sidebar -> hide/Main is the deliberate visibility change that re-enables
  // exactly the active child's own observed modes.
  harness.terminal.emitInput(ALT_LEFT);
  assert.deepEqual(harness.terminal.writes.slice(beforeFocusReenable), ["\x1b[?1000h", "\x1b[?1006h"]);
  assert.equal(harness.sidebar?.focus, "main");
  assert.equal(harness.sidebar?.visible, false);
  assert.equal(await closeWithSignal(harness), 0);
  assert.ok(harness.terminal.writes.includes("\x1b[?1000l"), "cleanup disables only the active owned tracking mode");
  assert.ok(harness.terminal.writes.includes("\x1b[?1006l"), "cleanup disables only owned cell-SGR encoding");
});

test("responsive resize resizes every owned child only when native geometry changes; overlays keep geometry stable", async () => {
  const harness = createHarness();
  const manager = await ready(harness);
  fillForm(harness.terminal, "first");
  await nextTurn();
  harness.terminal.emitInput(ALT_LEFT); // return to the visible sidebar with native-1 highlighted
  harness.terminal.emitInput("\x1b[B"); // -> Saved conversations
  harness.terminal.emitInput("\x1b[B"); // next row is New session
  harness.terminal.emitInput(ENTER);
  completeForm(harness.terminal, "/workspace-two");
  await nextTurn();
  assert.equal(manager.views.length, 2);

  harness.terminal.setSize(60, 10); // wide: 32 + divider + 27 native, nine content rows
  assert.deepEqual(manager.resizeCalls.at(-1), { cols: 27, rows: 9, ids: ["native-1", "native-2"] });
  const beforeNarrow = manager.resizeCalls.length;
  harness.terminal.setSize(52, 10); // overlay: full-width native viewport
  assert.deepEqual(manager.resizeCalls.at(-1), { cols: 52, rows: 9, ids: ["native-1", "native-2"] });
  const afterNarrow = manager.resizeCalls.length;
  assert.equal(afterNarrow, beforeNarrow + 1);
  harness.terminal.emitInput(ALT_LEFT); // focus Main then hide
  harness.terminal.emitInput(ALT_LEFT); // show and focus sidebar; native dimensions remain 52x9
  assert.equal(manager.resizeCalls.length, afterNarrow, "focus changes in narrow overlay do not resize children");
  await nextTurn();
  assert.ok(harness.writer.frames.some(({ cols, rows }) => cols === 52 && rows === 10));
  assert.equal(await closeWithSignal(harness), 0);
});

test("an actual outer resize notification invalidates the writer baseline even when final geometry is unchanged", async () => {
  const harness = createHarness();
  await ready(harness);
  fillForm(harness.terminal, "resize");
  await nextTurn();
  const invalidationsBefore = harness.writer.invalidateCalls;
  const framesBefore = harness.writer.frames.length;
  const frameBefore = harness.writer.frames.at(-1)!;

  harness.terminal.setSize(80, 24); // a real notification that changes nothing
  assert.equal(harness.writer.invalidateCalls, invalidationsBefore + 1,
    "a same-geometry resize still invalidates the known baseline");

  // One coalesced redraw spanning 80 -> 40 -> 80: the final geometry matches the
  // baseline exactly, but each real notification must still invalidate so the
  // next frame is a complete repaint of the reflowed screen.
  harness.terminal.columns = 40;
  harness.terminal.resizeHandler?.();
  harness.terminal.columns = 80;
  harness.terminal.resizeHandler?.();
  assert.equal(harness.writer.invalidateCalls, invalidationsBefore + 3,
    "every coalesced resize notification invalidates before layout reconciliation");

  await nextTurn();
  assert.ok(harness.writer.frames.length > framesBefore, "the coalesced resize still submits the next frame");
  const frameAfter = harness.writer.frames.at(-1)!;
  assert.equal(frameAfter.cols, frameBefore.cols);
  assert.equal(frameAfter.rows, frameBefore.rows);
  assert.equal(frameAfter.cols, 80);
  assert.equal(frameAfter.rows, 24);
  assert.equal(await closeWithSignal(harness), 0);
});

test("a writer seam without invalidation still handles resize notifications", async () => {
  const plainWriter = {
    started: false,
    start(): void { this.started = true; },
    submit(_frame: ComposedHostFrame, _cols: number, _rows: number): void {},
    async close(): Promise<boolean> { return true; },
  };
  const harness = createHarness({}, { createWriter: () => plainWriter });
  await ready(harness);
  assert.doesNotThrow(() => harness.terminal.setSize(70, 20),
    "the injected writer seam may omit the optional invalidate method");
  await nextTurn();
  assert.equal(await closeWithSignal(harness), 0);
});

test("outer source normalization uses ProcessTerminal.kittyProtocolActive, never observer flags", async () => {
  const harness = createHarness();
  const manager = await ready(harness, 7);
  fillForm(harness.terminal, "source kitty");
  await nextTurn();
  const count = manager.writes.length;
  const surface = manager.surface("native-1");
  assert.ok(surface);
  surface.modes = { ...surface.modes, kittyFlags: 7 };
  harness.terminal.kittyProtocolActive = true;
  harness.observer.setFlags(0);
  harness.terminal.emitInput("\n");
  assert.equal(manager.writes.length, count + 1);
  assert.equal(manager.writes.at(-1)?.data, "\x1b[13;2u", "actual active source Kitty mode normalizes LF as Shift+Enter");

  harness.terminal.kittyProtocolActive = false;
  harness.observer.setFlags(5);
  harness.terminal.emitInput("\n");
  assert.equal(manager.writes.at(-1)?.data, "\r", "passive capability observation does not override actual source mode");
  assert.equal(await closeWithSignal(harness), 0);
});

test("confirmed Quit is the only sidebar path that shuts down owned children", async () => {
  const harness = createHarness();
  const manager = await ready(harness);
  fillForm(harness.terminal, "confirmed quit");
  await nextTurn();
  harness.terminal.emitInput(ALT_LEFT); // focus the visible sidebar roster
  harness.terminal.emitInput("q");
  assert.equal(harness.terminal.stopCount, 0);
  assert.equal(manager.shutdownCalls, 0, "a live child requires SidebarController confirmation");
  harness.terminal.emitInput("y");
  assert.equal(await harness.result, 0);
  assert.equal(manager.shutdownCalls, 1);
  assert.equal(manager.disposeCalls, 1);
  assert.equal(harness.broker.disposeCalls, 1);
});

test("signal during broker startup cleans the acquired broker without constructing or restarting the terminal", async () => {
  let finishBroker!: (broker: StatusBroker) => void;
  const harness = createHarness({}, {
    createBroker: () => new Promise<StatusBroker>((resolve) => { finishBroker = resolve; }),
  });
  await nextTurn();
  assert.deepEqual(harness.events, ["resolve"], "the controller is waiting at the broker await boundary");
  harness.signals.emit("SIGTERM");
  finishBroker(harness.broker);
  assert.equal(await harness.result, 0);
  assert.equal(harness.broker.disposeCalls, 1);
  assert.equal(harness.events.includes("manager.create"), false);
  assert.equal(harness.events.includes("terminal.construct"), false);
  assert.equal(harness.events.includes("observer.construct"), false);
  assert.equal(harness.signals.listenerCount("SIGTERM"), 0);
});

test("signal closes manager admission before delayed terminal cleanup and aborts a pending native create", async () => {
  const harness = createHarness();
  const manager = await ready(harness);

  let releaseCreate!: () => void;
  let enterCreate!: () => void;
  const createEntered = new Promise<void>((resolve) => { enterCreate = resolve; });
  manager.createGate = new Promise<void>((resolve) => { releaseCreate = resolve; });
  manager.createGateEntered = enterCreate;

  let releaseDrain!: () => void;
  harness.terminal.drainGate = new Promise<void>((resolve) => { releaseDrain = resolve; });
  let releaseClose!: () => void;
  harness.writer.closeGate = new Promise<void>((resolve) => { releaseClose = resolve; });

  fillForm(harness.terminal, "pending launch");
  await createEntered;
  assert.equal(manager.spawnCount, 0);
  assert.ok(harness.sidebar);
  const focusBeforeShutdown = harness.sidebar.focus;

  harness.signals.emit("SIGTERM");
  assert.equal(manager.stopping, true, "manager admission closes synchronously at shutdown request");
  assert.equal(manager.shutdownCalls, 1);
  await nextTurn();
  assert.equal(harness.terminal.drainCalls.length, 1, "terminal drain is held behind its gate");

  releaseCreate();
  await nextTurn();
  assert.equal(manager.spawnCount, 0, "the pending create observes manager shutdown before its spawn checkpoint");
  assert.equal(harness.sidebar.focus, focusBeforeShutdown, "late create completion cannot change picker focus");
  assert.equal(harness.writer.closeStarted, false, "the frame writer is still waiting for terminal drain");

  releaseDrain();
  await nextTurn();
  assert.equal(harness.writer.closeStarted, true);
  assert.equal(manager.spawnCount, 0);
  assert.equal(harness.sidebar.focus, focusBeforeShutdown);
  releaseClose();

  assert.equal(await harness.result, 0);
  assert.equal(manager.views[0]?.hasLiveProcess, false);
  assert.equal(manager.spawnCount, 0);
  assert.equal(harness.sidebar.focus, focusBeforeShutdown);
});

test("signals and stdin end clean up only owned listeners, drains, terminal, writer, manager, and broker", async () => {
  const harness = createHarness();
  await ready(harness);
  const baselineSignalCounts = ["SIGTERM", "SIGHUP", "SIGINT"].map((signal) => harness.signals.listenerCount(signal));
  assert.deepEqual(baselineSignalCounts, [1, 1, 1]);
  assert.equal(harness.stdin.listenerCount("data"), 1, "only Main's passive observer listener is added before terminal startup");
  assert.equal(harness.stdout.listenerCount("error"), 1, "Main owns one output-error listener");
  const status = await closeWithSignal(harness, "SIGHUP");
  assert.equal(status, 0);
  assert.deepEqual(["SIGTERM", "SIGHUP", "SIGINT"].map((signal) => harness.signals.listenerCount(signal)), [0, 0, 0]);
  assert.equal(harness.stdin.listenerCount("data"), 0);
  assert.equal(harness.stdin.listenerCount("end"), 0);
  assert.equal(harness.stdout.listenerCount("error"), 0);
  assert.equal(harness.observer.disposed, true);
  assert.deepEqual(harness.terminal.drainCalls, [[250, 50]]);
  assert.equal(harness.terminal.stopCount, 1);
  assert.equal(harness.writer.closed, true);
  assert.equal(harness.stdout.ended, false);
  assert.equal(harness.stdout.destroyed, false);
  assert.deepEqual(harness.events.slice(-6), [
    "manager.shutdown", "terminal.drain", "terminal.stop", "writer.close", "manager.dispose", "broker.dispose",
  ]);
  assert.ok(harness.terminal.order.indexOf("terminal.drain") < harness.terminal.order.indexOf("terminal.stop"));
});

test("stdin end, output error, startup failure, forced termination, and incomplete writer cleanup return truthful status", async () => {
  const stdinEnd = createHarness();
  await ready(stdinEnd);
  stdinEnd.stdin.emit("end");
  assert.equal(await stdinEnd.result, 0);

  const outputFailure = createHarness();
  await ready(outputFailure);
  outputFailure.stdout.emit("error", new Error("credential-looking-output-error"));
  assert.equal(await outputFailure.result, 1);
  assert.equal(outputFailure.reports.join(""), "Session host could not complete startup or cleanup.");
  assert.doesNotMatch(outputFailure.reports.join(""), /credential-looking/);

  const startFailure = createHarness();
  startFailure.terminal.startError = new Error("native-startup-secret");
  assert.equal(await startFailure.result, 1);
  assert.equal(startFailure.writer.closed, true);
  assert.equal(startFailure.terminal.stopCount, 1, "a partially-started public terminal is stopped to restore state");
  assert.equal(startFailure.reports.join(""), "Session host could not complete startup or cleanup.");
  assert.equal(startFailure.stdin.listenerCount("data"), 0);

  const forced = createHarness();
  await ready(forced);
  const forcedManager = await started(forced);
  forcedManager.views.push({
    id: "owned-live-id", label: "safe", workspace: "/workspace", agentDir: "/profile", lifecycle: "alive",
    hasLiveProcess: true, busy: null, pendingInput: null, inputSurface: false, activity: [], nativeSession: null,
  });
  Object.assign(forcedManager.shutdownResult, { forcedIds: ["owned-live-id"], remainingIds: ["owned-live-id"] });
  assert.equal(await closeWithSignal(forced), 1);
  assert.match(forced.reports.join(""), /1 owned process\(es\) required forced termination; 1 remain unconfirmed/);
  assert.doesNotMatch(forced.reports.join(""), /owned-live-id/);

  const writerFailure = createHarness();
  await ready(writerFailure);
  writerFailure.writer.closeResult = false;
  assert.equal(await closeWithSignal(writerFailure), 1, "an unconfirmed frame-writer cleanup is not reported as success");
});

// --- Deliberate saved-conversation picker (issue 323). ---
//
// The synthetic listSavedCatalog override records exactly what Main passes
// (agentDir, piExecutable, expectedPiVersion, signal) and serves real branded
// catalogs minted by the landed read-only API against own-root fixtures.

interface SavedMainFixture {
  root: string;
  agentDir: string;
  workspace: string;
  file: string;
  sessionId: string;
}

function makeSavedMainFixture(prefix: string): SavedMainFixture {
  const root = makeMainTestDirectory(`saved-${prefix}`);
  const agentDir = join(root, "agent");
  const workspace = join(root, "workspace");
  mkdirSync(join(agentDir, "sessions", "proj"), { recursive: true });
  mkdirSync(workspace, { recursive: true });
  const sessionId = `saved-main-${prefix}`;
  const file = join(agentDir, "sessions", "proj", "saved.jsonl");
  writeFileSync(
    file,
    [
      JSON.stringify({ type: "session", version: 3, id: sessionId, timestamp: "2025-01-01T00:00:00.000Z", cwd: workspace }),
      JSON.stringify({ type: "message", id: "m1", message: { role: "user", content: [{ type: "text", text: `First conversation ${prefix}` }] } }),
    ].join("\n") + "\n",
    "utf8",
  );
  return { root, agentDir, workspace, file, sessionId };
}

function makeSavedListAll() {
  return async (sessionDir: string, _onProgress?: (progress: Readonly<Record<string, unknown>>) => void, signal?: AbortSignal) => {
    if (signal?.aborted) {
      const error = new Error("aborted");
      error.name = "AbortError";
      throw error;
    }
    const rows: { path: string; id: string; cwd: string }[] = [];
    for (const entry of readdirSync(sessionDir, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
      const file = join(sessionDir, entry.name);
      let text: string;
      try {
        text = readFileSync(file, "utf8");
      } catch {
        continue;
      }
      const first = text.split("\n").find((line) => line.trim() !== "");
      if (!first) continue;
      let header: Record<string, unknown>;
      try {
        header = JSON.parse(first) as Record<string, unknown>;
      } catch {
        continue;
      }
      if (typeof header.id !== "string" || typeof header.cwd !== "string") continue;
      // Mirror the public SDK's first user message extraction for captions.
      let firstMessage: string | undefined;
      for (const line of text.split("\n")) {
        if (line.trim() === "") continue;
        try {
          const entry = JSON.parse(line) as { type?: unknown; message?: { role?: unknown; content?: unknown } };
          if (entry.type !== "message" || entry.message?.role !== "user") continue;
          const content = Array.isArray(entry.message.content) ? entry.message.content : [];
          const firstText = content.find((part): part is { type: string; text: string } =>
            typeof part === "object" && part !== null && (part as { type?: unknown }).type === "text"
            && typeof (part as { text?: unknown }).text === "string");
          if (typeof firstText?.text === "string") firstMessage = firstText.text;
          break;
        } catch {
          continue;
        }
      }
      rows.push({ path: file, id: header.id, cwd: header.cwd, ...(firstMessage !== undefined ? { firstMessage } : {}) });
    }
    return rows;
  };
}

function savedFixtureDependencies(fixture: SavedMainFixture, listing?: (options: {
  agentDir: string;
  piExecutable: string;
  expectedPiVersion: string;
  signal: AbortSignal;
}) => Promise<SavedSessionCatalog>) {
  const savedCalls: { agentDir: string; piExecutable: string; expectedPiVersion: string; signal: AbortSignal }[] = [];
  return {
    savedCalls,
    overrides: {
      createSessionSetup: () => ({
        nativeSetup: false,
        nativeAgentDir: fixture.agentDir,
        profileRegistry: {
          prepare: () => { throw new Error("the fake Main manager must not prepare sessions"); },
        } satisfies ProfilePreparer,
      }),
      listSavedCatalog: listing ?? (async (options) => {
        savedCalls.push({ ...options });
        return listSavedSessions({ agentDir: options.agentDir, listAll: makeSavedListAll(), signal: options.signal });
      }),
    },
  };
}

/** Opens the saved picker from the default roster selection. */
function openSavedPicker(terminal: FakeTerminal): void {
  terminal.emitInput("\x1b[A"); // New session -> Saved conversations
  terminal.emitInput(ENTER);
}

test("saved picker lists the shared catalog and opens a new independent child with exact branded admission", async () => {
  const fixture = makeSavedMainFixture("open");
  const { savedCalls, overrides } = savedFixtureDependencies(fixture);
  try {
    const harness = createHarness({}, overrides);
    const manager = await ready(harness);

    openSavedPicker(harness.terminal);
    await nextTurn();
    await nextTurn();
    // The listing used the captured Pi identity and the shared native root.
    assert.equal(savedCalls.length, 1);
    assert.deepEqual(savedCalls[0], {
      agentDir: fixture.agentDir,
      piExecutable: "/synthetic/pi",
      expectedPiVersion: "1.0.4",
      signal: savedCalls[0].signal,
    });
    const frame = harness.writer.frames.at(-1)?.frame;
    assert.ok(plain(frame).includes("First conversation open"), "the canonical caption is listed");

    // Deliberate Enter opens the highlighted conversation as a new child.
    harness.terminal.emitInput(ENTER);
    await nextTurn();
    await nextTurn();
    assert.equal(manager.createOptions.length, 1, "exactly one new child was created");
    const created = manager.createOptions[0];
    assert.equal(created.workspace, realpathSync(fixture.workspace), "the exact saved header cwd is the workspace");
    assert.ok(isSavedSessionAdmission(created.savedSession), "the admission receipt stays branded");
    assert.equal((created.savedSession as { sessionId: string }).sessionId, fixture.sessionId);
    assert.equal((created.savedSession as { file: string }).file, fixture.file);

    // A successful Saved open activates the restored child as the Main owner.
    assert.equal(harness.sidebar?.focus, "main");
    assert.equal(harness.sidebar?.selectedId, "native-1", "the restored row becomes the active owner");
    assert.ok(plainLine(harness.writer.frames.at(-1)?.frame, 0).includes("Native native-1"), "the restored child's header is the active view");
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("saved picker cancel aborts the listing and shows no failure notice", async () => {
  const fixture = makeSavedMainFixture("cancel");
  try {
    const { overrides } = savedFixtureDependencies(fixture, async (options) => {
      // Never resolves unless its signal is aborted.
      return new Promise<never>((resolve, reject) => {
        void resolve;
        options.signal.addEventListener("abort", () => {
          const error = new Error("aborted");
          error.name = "AbortError";
          reject(error);
        }, { once: true });
      });
    });
    const harness = createHarness({}, overrides);
    await ready(harness);

    openSavedPicker(harness.terminal);
    await nextTurn();
    assert.ok(plain(harness.writer.frames.at(-1)?.frame).includes("Loading saved conversations..."));
    harness.terminal.emitInput(ESC); // dismiss while the listing is pending
    await nextTurn();
    await nextTurn();
    const frame = plain(harness.writer.frames.at(-1)?.frame);
    assert.ok(!frame.includes("unavailable"), "an aborted listing never renders as a failure");
    assert.equal(harness.sidebar?.focus, "sidebar", "dismiss restores the roster display");

    // Shutdown with the (already rejected) listing is clean.
    assert.equal(await closeWithSignal(harness), 0);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("saved picker fences a late listing completion after dismissal", async () => {
  const fixture = makeSavedMainFixture("stale");
  try {
    const resolvers: Array<(catalog: SavedSessionCatalog) => void> = [];
    const { overrides } = savedFixtureDependencies(fixture, async (options) => {
      return new Promise((resolve) => {
        resolvers.push(resolve);
      });
    });
    const harness = createHarness({}, overrides);
    await ready(harness);

    openSavedPicker(harness.terminal); // listing R1 pending
    harness.terminal.emitInput(ESC); // dismiss before it completes
    assert.equal(resolvers.length, 1);
    resolvers[0](await listSavedSessions({ agentDir: fixture.agentDir, listAll: makeSavedListAll() }));
    await nextTurn();
    await nextTurn();
    assert.equal(harness.sidebar?.focus, "sidebar", "the late completion never reopens the pane");
    assert.ok(!plain(harness.writer.frames.at(-1)?.frame).includes("First conversation stale"), "stale rows never appear");

    // A fresh listing for the reopened pane is still accepted (selection
    // stayed on the Saved conversations entry after dismissal).
    harness.terminal.emitInput(ENTER);
    resolvers[1](await listSavedSessions({ agentDir: fixture.agentDir, listAll: makeSavedListAll() }));
    await nextTurn();
    await nextTurn();
    assert.ok(plain(harness.writer.frames.at(-1)?.frame).includes("First conversation stale"), "the fresh listing is shown");
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("saved picker refuses a known-owned duplicate without creating", async () => {
  const fixture = makeSavedMainFixture("duplicate");
  try {
    const { overrides } = savedFixtureDependencies(fixture);
    const harness = createHarness({}, overrides);
    const manager = await ready(harness);
    manager.ownedLiveSessionsData = [{ id: fixture.sessionId }];

    openSavedPicker(harness.terminal);
    await nextTurn();
    await nextTurn();
    harness.terminal.emitInput(ENTER);
    await nextTurn();
    assert.equal(manager.createOptions.length, 0, "a known-owned duplicate spawns no child");
    const frame = plain(harness.writer.frames.at(-1)?.frame);
    assert.ok(frame.includes("! That saved conversation is already"), `refusal notice is truthful: ${frame}`);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("saved-open before keyboard negotiation is deferred until ready", async () => {
  const fixture = makeSavedMainFixture("deferred");
  try {
    const { overrides } = savedFixtureDependencies(fixture);
    const harness = createHarness({}, overrides);
    const manager = await started(harness); // negotiation not settled yet

    openSavedPicker(harness.terminal);
    await nextTurn();
    await nextTurn();
    harness.terminal.emitInput(ENTER); // deliberate open while negotiation is pending
    await nextTurn();
    assert.equal(manager.createOptions.length, 0, "no child before keyboard negotiation");

    harness.observer.settle(0);
    await nextTurn();
    await nextTurn();
    assert.equal(manager.createOptions.length, 1, "the deferred saved-open launches after ready");
    assert.ok(isSavedSessionAdmission(manager.createOptions[0].savedSession));
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("shutdown while a saved listing is pending aborts it and exits cleanly", async () => {
  const fixture = makeSavedMainFixture("shutdown");
  try {
    const { overrides } = savedFixtureDependencies(fixture, async (options) => {
      return new Promise<never>((resolve, reject) => {
        void resolve;
        options.signal.addEventListener("abort", () => {
          const error = new Error("aborted");
          error.name = "AbortError";
          reject(error);
        }, { once: true });
      });
    });
    const harness = createHarness({}, overrides);
    await ready(harness);

    openSavedPicker(harness.terminal);
    await nextTurn();
    assert.equal(await closeWithSignal(harness), 0, "a pending read-only listing never blocks shutdown");
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});
