import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { Writable } from "node:stream";
import test from "node:test";

import type { ComposedHostFrame } from "../src/session-host/compositor";
import type { InstanceManagerOptions, NativeInstanceView, ShutdownResult } from "../src/session-host/instances";
import type { SessionHostFrameWriterOptions } from "../src/session-host/frame-writer";
import type { KeyboardCapabilityObserverOptions } from "../src/session-host/input";
import type { StatusBroker } from "../src/session-host/broker";
import { NativeAgentRegistry, type ProfilePreparer } from "../src/session-host/profiles";
import type { TerminalFrame, TerminalInputModes } from "../src/session-host/terminal-surface";
import { SidebarController } from "../src/session-host/sidebar";
import { __test, type SessionHostOptions } from "../src/session-host/main";

const ESC = "\x1b";
const ALT_LEFT = `${ESC}[1;3D`;
const ENTER = "\r";
const DELETE = "\x1b[3~";

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
  readonly frames: { frame: ComposedHostFrame; cols: number; rows: number }[] = [];
  readonly order: string[];

  constructor(order: string[]) { this.order = order; }

  start(): void {
    this.order.push("writer.start");
    if (this.startError) throw this.startError;
    this.started = true;
  }

  submit(frame: ComposedHostFrame, cols: number, rows: number): void {
    this.frames.push({ frame, cols, rows });
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
  readonly createOptions: { label: string; workspace: string }[] = [];
  readonly order: string[];
  onChange?: (id: string) => void;
  nextId = 1;
  nextError = false;
  readonly shutdownResult: ShutdownResult = { forcedIds: [], remainingIds: [] };
  readonly pendingCreates = new Set<Promise<string>>();
  createGate?: Promise<void>;
  createGateEntered?: () => void;
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

  create(options: { label: string; workspace: string }): Promise<string> {
    this.createOptions.push({ ...options });
    const id = `native-${this.nextId++}`;
    const error = this.nextError;
    this.nextError = false;
    const surface = new FakeSurface(this.options.cols ?? 80, this.options.rows ?? 24, `frame:${options.label}`);
    this.surfaces.set(id, surface);
    this.views.push({
      id,
      label: options.label,
      workspace: options.workspace,
      agentDir: `/private-profile/${id}`,
      lifecycle: "starting",
      hasLiveProcess: false,
      busy: null,
      pendingInput: null,
      inputSurface: false,
      activity: [],
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
      this.views[index] = { ...view, lifecycle: "alive", hasLiveProcess: true };
    }
    this.onChange?.(id);
    return id;
  }

  write(id: string, data: string | Buffer): void { this.writes.push({ id, data }); }

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
    createWriter: (_output, _writerOptions?: SessionHostFrameWriterOptions) => { events.push("writer.construct"); return writer; },
    reportError: (message) => reports.push(message),
    ...dependencyOverrides,
  });
  harness = {
    options: options(overrides), stdin, stdout, signals, terminal, observer, writer, broker, reports, events, manager, sidebar, result,
    get brokerOptions() { return brokerOptions; },
  };
  // Manager and sidebar construction occur after the broker's first asynchronous boundary.
  void result.then(() => undefined);
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
  fillForm(harness.terminal, "first");
  await nextTurn();
  harness.terminal.emitInput("\x1b[B"); // first row -> New session
  harness.terminal.emitInput(ENTER);
  completeForm(harness.terminal, "second", "/another/workspace");
  await nextTurn();
  assert.deepEqual(manager.views.map((view) => view.id), ["native-1", "native-2"]);
  return manager;
}

function fillForm(terminal: FakeTerminal, label: string, workspace = "/explicit/workspace"): void {
  terminal.emitInput(ENTER); // New session
  completeForm(terminal, label, workspace);
}

function completeForm(terminal: FakeTerminal, label: string, workspace = "/explicit/workspace"): void {
  terminal.emitInput("\x15"); // replace any retained label draft
  terminal.emitInput(label);
  terminal.emitInput(ENTER); // label -> workspace
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
  const root = mkdtempSync(join(process.cwd(), ".session-host-main-native-"));
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
    createSessionSetup: ({ env }) => ({
      nativeSetup: true,
      profileRegistry: new NativeAgentRegistry({ env }),
    }),
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
  assert.deepEqual(manager.createOptions[0], { label: "negotiated session", workspace: "/explicit/workspace" });
  assert.equal(manager.views[0]?.lifecycle, "alive");
  assert.equal(manager.options.getSupportedKeyboardFlags?.(), 0, "actual ProcessTerminal activation remains authoritative");
  harness.terminal.kittyProtocolActive = true;
  harness.observer.setFlags(13);
  assert.equal(manager.options.getSupportedKeyboardFlags?.(), 5, "observer flags are masked to 1+2+4 only after actual activation");
  assert.equal(await closeWithSignal(harness), 0);
});

test("highlighting a newly created row does not transfer active input ownership; explicit select does", async () => {
  const harness = createHarness();
  const manager = await ready(harness);

  fillForm(harness.terminal, "first");
  await nextTurn();
  assert.equal(manager.views[0]?.id, "native-1");
  assert.equal(manager.views[0]?.hasLiveProcess, true);
  harness.terminal.emitInput(ENTER); // Explicitly select first row; focus returns to Main.
  harness.terminal.emitInput(ALT_LEFT); // Hide picker, preserving active owner.
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
  harness.terminal.emitInput("\x1b[B"); // highlighted first -> New session
  harness.terminal.emitInput(ENTER); // Open New session
  completeForm(harness.terminal, "second", "/another/explicit/workspace");
  await nextTurn();
  assert.equal(manager.views[1]?.id, "native-2");
  assert.equal(harness.manager?.list()[1]?.label, "second");
  assert.equal(manager.writes.at(-1)?.id, "native-1", "late create/highlight did not steal the active owner");

  // The newly created row is highlighted in the picker. Enter is the explicit
  // ownership transfer; subsequent Main input goes only to native-2.
  assert.equal(harness.terminal.inputHandler !== undefined, true);
  harness.terminal.emitInput(ENTER);
  harness.terminal.emitInput(ALT_LEFT); // hide, resume the newly selected Main owner
  harness.terminal.emitInput("q");
  assert.equal(manager.writes.at(-1)?.id, "native-2");

  const activeIndex = manager.views.findIndex((view) => view.id === "native-2");
  const activeView = manager.views[activeIndex];
  assert.ok(activeView);
  manager.views[activeIndex] = { ...activeView, lifecycle: "error", hasLiveProcess: true };
  manager.notify();
  await nextTurn();
  assert.equal(harness.writer.frames.at(-1)?.frame.cursor.visible, false, "non-alive native frames never retain an owned cursor");

  assert.deepEqual(manager.createOptions[1], { label: "second", workspace: "/another/explicit/workspace" });
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

  harness.terminal.emitInput(ALT_LEFT); // hide, then reopen the sidebar on the exited owner
  harness.terminal.emitInput(ALT_LEFT);
  assert.equal(harness.sidebar?.focus, "sidebar");
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
  harness.terminal.emitInput("\x1b[B"); // select the last exited row
  harness.terminal.emitInput(DELETE);
  await nextTurn();
  assert.deepEqual(manager.views, []);
  assert.equal(harness.sidebar?.focus, "sidebar");
  assert.equal(harness.sidebar?.visible, true);
  harness.terminal.emitInput("\x1b[B"); // cleared selection -> New session
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

  harness.terminal.emitInput(ALT_LEFT); // hide/show to focus the picker on the active sibling
  harness.terminal.emitInput(ALT_LEFT);
  harness.terminal.emitInput("\x1b[B"); // second -> New session
  harness.terminal.emitInput(ENTER);
  harness.terminal.emitInput("retained draft");
  harness.terminal.emitInput(ALT_LEFT); // hide without discarding the form draft
  harness.terminal.emitInput(ALT_LEFT); // reopen with New session still selected
  harness.terminal.emitInput("\x1b[A"); // New -> second
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
  harness.terminal.emitInput(ENTER); // explicitly activate native-1
  const original = manager.views[0];
  assert.ok(original);
  manager.views[0] = { ...original, lifecycle: "exited", hasLiveProcess: false, busy: null, pendingInput: null };
  manager.refusedCloseIds.add("native-1"); // model a stale/failed backend removal
  manager.notify("confirmed-exit");
  await nextTurn();

  harness.terminal.emitInput(ALT_LEFT);
  harness.terminal.emitInput(ALT_LEFT);
  harness.terminal.emitInput(DELETE);
  await nextTurn();
  assert.deepEqual(manager.closeExitedCalls, ["native-1"]);
  assert.deepEqual(manager.views.map((view) => view.id), ["native-1"]);
  assert.equal(harness.sidebar?.selectedId, "native-1");
  let noticeText = (harness.sidebar?.render(32, 12).lines.join(" ").replace(/\x1b\[[0-9;]*m/g, "") ?? "").replace(/\s+/g, " ");
  assert.match(noticeText, /Session not removed; it may be live, unconfirmed, or no longer available/);

  manager.refusedCloseIds.delete("native-1");
  manager.views.splice(0, 1); // the sidebar snapshot now refers to a stale backend id
  harness.terminal.emitInput(DELETE);
  await nextTurn();
  assert.deepEqual(manager.closeExitedCalls, ["native-1", "native-1"]);
  assert.deepEqual(harness.sidebar?.items.map((view) => view.id), ["native-1"], "a stale refusal keeps the visible row");
  assert.equal(harness.sidebar?.selectedId, "native-1");

  manager.views.push({ ...original, lifecycle: "alive", hasLiveProcess: true });
  manager.notify("live-owner-restored");
  await nextTurn();
  harness.terminal.emitInput(DELETE); // closeExited refuses a live child
  await nextTurn();
  assert.deepEqual(manager.closeExitedCalls, ["native-1", "native-1", "native-1"]);
  assert.equal(manager.views[0]?.hasLiveProcess, true);

  manager.views[0] = { ...manager.views[0]!, lifecycle: "exited", hasLiveProcess: true };
  manager.notify("unconfirmed-exit");
  harness.terminal.emitInput(DELETE); // an exited badge is insufficient without confirmed process exit
  await nextTurn();
  assert.deepEqual(manager.closeExitedCalls, ["native-1", "native-1", "native-1", "native-1"]);
  assert.equal(manager.views[0]?.hasLiveProcess, true);
  noticeText = (harness.sidebar?.render(32, 12).lines.join(" ").replace(/\x1b\[[0-9;]*m/g, "") ?? "").replace(/\s+/g, " ");
  const notice = noticeText.match(/Session not removed; it may be live, unconfirmed, or no longer available/)?.[0] ?? "";
  assert.ok(notice.length > 0 && notice.length <= 300, "refusal is bounded and truthful");
  assert.equal(manager.shutdownCalls, 0);
  assert.equal(harness.terminal.stopCount, 0, "refusal never stops the process or terminal");

  manager.views[0] = { ...manager.views[0]!, lifecycle: "alive", hasLiveProcess: true };
  manager.notify("alive-again");
  harness.terminal.emitInput(ALT_LEFT); // hide the sidebar, return to native focus
  harness.terminal.emitInput(DELETE); // Delete is native in Main focus, not a closeExited request
  assert.equal(manager.closeExitedCalls.length, 4);
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
  harness.terminal.emitInput(ENTER); // explicit select -> main focus

  harness.terminal.emitInput(ALT_LEFT); // hide the picker (focus main)
  harness.terminal.emitInput(ALT_LEFT); // reopen -> sidebar focus on native-1
  await nextTurn();
  const resizesBeforeForm = manager.resizeCalls.length;
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
  assert.ok(!frame.lines.join("\n").includes("frame:first"), "the child frame is hidden, not destroyed, while the form is open");
  // The retained label draft ("first" + "draft label") puts the caret at
  // pane column 13 + 16 = 29, offset by the right pane origin.
  assert.deepEqual(frame.cursor, { column: 62, row: 2, visible: true }, "form caret offsets into the right pane");
  assert.equal(manager.resizeCalls.length, resizesBeforeForm, "opening the form never resizes the child");
  assert.deepEqual(manager.writes, [], "form input is never broadcast to the child");

  harness.terminal.emitInput(ESC); // cancel the form -> hide sidebar, focus main
  await nextTurn();
  assert.equal(harness.sidebar?.focus, "main");
  assert.equal(manager.views[0]?.hasLiveProcess, true, "cancelling the form leaves the child alive");
  assert.deepEqual(manager.resizeCalls.at(-1), { cols: 80, rows: 23, ids: ["native-1"] }, "hiding the sidebar restores the full-width native pane");
  const restored = harness.writer.frames.at(-1)?.frame;
  assert.ok(restored, "a composed frame exists after the form closes");
  assert.ok(plainLine(restored, 1).startsWith("frame:first"), "the same child frame returns");
  harness.terminal.emitInput("q"); // main input still routes to the same active child
  assert.deepEqual(manager.writes.at(-1), { id: "native-1", data: "q" });
  assert.equal(await closeWithSignal(harness), 0);
});

test("create error row reports only a generic message and preserves the editable draft", async () => {
  const harness = createHarness();
  const manager = await ready(harness);
  manager.nextError = true;
  fillForm(harness.terminal, "draft label", "/missing/workspace");
  await nextTurn();
  assert.equal(manager.views[0]?.lifecycle, "error");
  assert.equal(manager.views[0]?.error, "synthetic-secret-native-error", "the fixture confirms a private error existed");
  assert.ok(harness.sidebar);
  assert.equal(harness.sidebar.focus, "form");
  const formText = harness.sidebar.render(40, 8).lines.join("\n").replace(/\x1b\[[0-9;]*m/g, "");
  assert.match(formText, /draft label/);
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
  harness.terminal.emitInput(ENTER); // explicit select, switch to Main focus
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

  const beforeOverlay = harness.terminal.writes.length;
  harness.terminal.emitInput(ALT_LEFT); // hide: Main remains active, not an input reset
  harness.terminal.emitInput(ALT_LEFT); // reopen -> sidebar owns input, disable only our tracking/encoding
  assert.deepEqual(harness.terminal.writes.slice(beforeOverlay), ["\x1b[?1000l", "\x1b[?1006l"]);
  assert.equal(await closeWithSignal(harness), 0);
  assert.ok(harness.terminal.writes.includes("\x1b[?1000l"), "cleanup disables only the active owned tracking mode");
  assert.ok(harness.terminal.writes.includes("\x1b[?1006l"), "cleanup disables only owned cell-SGR encoding");
});

test("responsive resize resizes every owned child only when native geometry changes; overlays keep geometry stable", async () => {
  const harness = createHarness();
  const manager = await ready(harness);
  fillForm(harness.terminal, "first");
  await nextTurn();
  harness.terminal.emitInput("\x1b[B"); // next row is New session
  harness.terminal.emitInput(ENTER);
  completeForm(harness.terminal, "second", "/workspace-two");
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

test("outer source normalization uses ProcessTerminal.kittyProtocolActive, never observer flags", async () => {
  const harness = createHarness();
  const manager = await ready(harness, 7);
  fillForm(harness.terminal, "source kitty");
  await nextTurn();
  harness.terminal.emitInput(ENTER); // explicit Main selection
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
    hasLiveProcess: true, busy: null, pendingInput: null, inputSurface: false, activity: [],
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
