import assert from "node:assert/strict";
import type { ChildProcess, SpawnOptions } from "node:child_process";
import { execFileSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { Buffer } from "node:buffer";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { deflateSync } from "node:zlib";
import type { Writable } from "node:stream";
import test from "node:test";
import { isKittyProtocolActive, setKittyProtocolActive } from "pi-session-host-tui";

import type { ComposedHostFrame } from "../src/session-host/compositor";
import type { CreateInstanceOptions, InstanceManagerOptions, NativeInstanceView, ShutdownResult } from "../src/session-host/instances";
import {
  createSessionHostFrameWriter,
  type SessionHostFrameDisposition,
  type SessionHostFrameWriterOptions,
} from "../src/session-host/frame-writer";
import type { KeyboardCapabilityObserverOptions } from "../src/session-host/input";
import type { StatusBroker, StatusRenameRequest, StatusRenameResult } from "../src/session-host/broker";
import { NativeAgentRegistry, type ProfilePreparer } from "../src/session-host/profiles";
import { createNativeSavedQueryInput, runNativeExternalEditor } from "../src/session-host/form-support";
import { TerminalSurface, type TerminalFrame, type TerminalInputModes, type TerminalMouseReportingRequest } from "../src/session-host/terminal-surface";
import { TerminalDiagnosticsLog } from "../src/session-host/terminal-diagnostics-log";
import type { TerminalGraphicsFrame } from "../src/session-host/kitty-graphics";
import { SidebarController, type SidebarAction } from "../src/session-host/sidebar";
import { isSavedSessionAdmission, listSavedSessions, type SavedSessionCatalog } from "../src/session-host/saved-sessions";
import { deleteSavedSessionFile, type SavedSessionDeletionOptions } from "../src/session-host/saved-deletion";
import type { SessionHostNativeSession } from "../src/session-host/protocol";
import type { NativeClipboardEvent } from "../src/session-host/native-clipboard";
import type { PeerCoordinatorOptions } from "../src/session-host/network/peer-coordinator";
import type { PeerCoordinator, PeerUiCommand, PeerUiConsent, PeerUiSnapshot } from "../src/session-host/peer-ui-protocol";
import { __test, type SessionHostOptions } from "../src/session-host/main";
import {
  createLocalOwningHostService,
  type OwningHostService,
  type OwningHostServiceDependencies,
} from "../src/session-host/owning-host-service";
import { FakeViewerSeam } from "./session-host-viewer-fakes";
import type {
  SessionGeometry,
  SessionViewerState,
  SessionViewerUpdate,
  SessionViewerUpdateResult,
} from "../src/session-host/instances";
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

class QueuedFrameOutput extends EventEmitter {
  readonly writes: Buffer[] = [];
  private readonly queued: Array<{ readonly bytes: Buffer; readonly callback?: (error?: Error | null) => void }> = [];
  private queueNext = false;
  private queuedWriteAccepted = false;

  get queuedCount(): number { return this.queued.length; }
  get queuedTexts(): string[] { return this.queued.map(({ bytes }) => bytes.toString("utf8")); }

  refuseNextWrite(accepted = false): void {
    this.queueNext = true;
    this.queuedWriteAccepted = accepted;
  }

  write(chunk: Uint8Array | string, callback?: (error?: Error | null) => void): boolean {
    const bytes = Buffer.from(chunk);
    if (this.queueNext) {
      this.queueNext = false;
      this.queued.push({ bytes, callback });
      return this.queuedWriteAccepted;
    }
    this.writes.push(bytes);
    callback?.();
    return true;
  }

  completeQueuedWrites(): void {
    for (const item of this.queued.splice(0)) {
      this.writes.push(item.bytes);
      item.callback?.();
    }
  }

  drain(): void {
    this.completeQueuedWrites();
    this.emit("drain");
  }

  end(): this { return this; }
  destroy(): this { return this; }
}

class FakeOutput extends EventEmitter {
  readonly isTTY = true;
  columns = 80;
  rows = 24;
  readonly writes: string[] = [];
  ended = false;
  destroyed = false;

  write(chunk: Uint8Array | string, callback?: (error?: Error | null) => void): boolean {
    this.writes.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
    callback?.();
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
  settlementDisposition: SessionHostFrameDisposition = "written";
  readonly frames: { frame: ComposedHostFrame; cols: number; rows: number }[] = [];
  readonly order: string[];

  constructor(order: string[]) { this.order = order; }

  start(): void {
    this.order.push("writer.start");
    if (this.startError) throw this.startError;
    this.started = true;
  }

  submit(
    frame: ComposedHostFrame,
    cols: number,
    rows: number,
    onSettled?: (disposition: SessionHostFrameDisposition) => void,
  ): void {
    if (this.closed) this.submitsAfterClose += 1;
    this.frames.push({ frame, cols, rows });
    if (this.holdWrites) {
      this.heldSubmits += 1;
      this.pendingSettle = onSettled; // the superseded candidate is dropped, unsettled
      return;
    }
    onSettled?.(this.settlementDisposition);
  }

  invalidate(): void {
    this.order.push("writer.invalidate");
    this.invalidateCalls += 1;
  }

  /**
   * Block the sink (#474 backpressure tests). Like the real writer, only the
   * newest candidate is retained; a superseded candidate never settles, and no
   * submitted frame is reported as written until the sink drains.
   */
  holdWrites = false;
  heldSubmits = 0;
  private pendingSettle: ((disposition: SessionHostFrameDisposition) => void) | undefined;

  /** Drain the blocked sink: the newest retained candidate is written. */
  drainHeldWrites(): void {
    const settle = this.pendingSettle;
    this.pendingSettle = undefined;
    this.holdWrites = false;
    settle?.("written");
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
  graphics?: TerminalGraphicsFrame;
  frameCalls = 0;
  cursorVisible = true;
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

  resize(cols: number, rows: number): void {
    this.cols = cols;
    this.rows = rows;
  }

  frame(): TerminalFrame {
    this.frameCalls += 1;
    const lines = Array.from({ length: this.rows }, (_, index) => index === 0 ? this.writesAsFrame.join("") : "");
    return {
      cols: this.cols,
      rows: this.rows,
      lines,
      cursor: { column: 2, row: 0, visible: this.cursorVisible },
      ...(this.graphics ? { graphics: this.graphics } : {}),
    };
  }

  inputModes(): TerminalInputModes { return { ...this.modes }; }

  // This fake never holds a synchronized frame, so the child's request equals
  // its live modes; held-frame behavior is covered with a real TerminalSurface.
  requestedMouseReporting(): TerminalMouseReportingRequest {
    return { mouseTracking: this.modes.mouseTracking, mouseEncoding: this.modes.mouseEncoding };
  }
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
  // --- #474 per-session viewer seam: viewer facts and per-row geometry only. ---
  // The geometry this fake reports is its own record of what the host asked each
  // row to be, so it stays correct when a test swaps in a real terminal surface.
  readonly geometry = new Map<string, { cols: number; rows: number }>();
  readonly viewers = new FakeViewerSeam({
    isViewable: (id) => {
      const view = this.views.find((candidate) => candidate.id === id);
      return view !== undefined && view.hasLiveProcess && (view.lifecycle === "alive" || view.lifecycle === "starting");
    },
    // The row's own canonical record: seeded when the row is created and updated
    // only when the host asks for a size, exactly like the manager's own fact. It
    // deliberately does not read the terminal surface, so a test that swaps in a
    // real surface cannot lose or invent the row's authoritative size.
    read: (id) => this.geometry.get(id),
    apply: (id, cols, rows) => {
      this.geometry.set(id, { cols, rows });
      const surface = this.surfaces.get(id);
      if (surface === undefined) return;
      surface.resize(cols, rows);
      this.resizeCalls.push({ cols, rows, ids: [id] });
    },
  });
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
    this.geometry.delete(id);
    this.onChange?.(id);
    return true;
  }

  ownedLiveSessions(): { id?: string; file?: string }[] { return [...this.ownedLiveSessionsData]; }

  create(options: CreateInstanceOptions): Promise<string> {
    this.createOptions.push({ ...options });
    const id = `native-${this.nextId++}`;
    const error = this.nextError;
    this.nextError = false;
    const initial = this.initialGeometry
      ?? { cols: this.options.cols ?? 80, rows: this.options.rows ?? 24 };
    const surface = new FakeSurface(initial.cols, initial.rows, `frame:${id}`);
    this.surfaces.set(id, surface);
    this.geometry.set(id, { cols: initial.cols, rows: initial.rows });
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
      // A host-wide resize of a live row moves that row's own canonical record too,
      // exactly like the manager's addressed resize (#474).
      this.geometry.set(view.id, { cols, rows });
      this.viewers.record(view.id, cols, rows);
    }
    this.resizeCalls.push({ cols, rows, ids: liveIds });
  }

  openViewer(): SessionViewerState {
    return this.viewers.openViewer();
  }

  viewerState(viewerId: string): SessionViewerState | undefined {
    return this.viewers.viewerState(viewerId);
  }

  sessionViewers(sessionId: string): SessionViewerState[] {
    return this.viewers.sessionViewers(sessionId);
  }

  updateViewer(viewerId: string, update: SessionViewerUpdate): SessionViewerUpdateResult {
    return this.viewers.updateViewer(viewerId, update);
  }

  closeViewer(viewerId: string): boolean {
    return this.viewers.closeViewer(viewerId);
  }

  instanceGeometry(id: string): SessionGeometry | undefined {
    if (this.geometryReadThrows) throw new Error("synthetic canonical geometry read failure");
    return this.viewers.instanceGeometry(id);
  }

  /** When true, the canonical-geometry read itself fails (the service reports none). */
  geometryReadThrows = false;

  /** The host's adopted initial-sizing rule (#474); rows created later start here. */
  initialGeometry: { cols: number; rows: number } | undefined;

  setInitialGeometry(cols: number, rows: number): void {
    this.initialGeometry = { cols, rows };
    this.viewers.setInitialGeometry(cols, rows);
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
  agentDir: string;
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
    options: options(overrides), stdin, stdout, signals, terminal, observer, writer, writers, broker, reports, events, agentDir: defaultAgentDir, manager, sidebar, result,
    get brokerOptions() { return brokerOptions; },
  };
  // Manager and sidebar construction occur after the broker's first asynchronous boundary.
  void result.then(() => undefined);
  void result.then(() => rmSync(defaultAgentDir, { recursive: true, force: true }));
  return harness;
}

class FakePeerCoordinator implements PeerCoordinator {
  options: PeerCoordinatorOptions | undefined;
  readonly decisions: Array<{ id: string; decision: "approve" | "deny" }> = [];
  readonly commands: PeerUiCommand[] = [];
  closeCalls = 0;
  closeFailure = false;
  startGate: Promise<void> | undefined;
  performGate: Promise<void> | undefined;
  now: () => number = Date.now;
  snapshot: PeerUiSnapshot = {
    revision: 1, status: "ready", identityFingerprint: null,
    settings: { hostingEnabled: false, bindHost: "", bindPort: null, autoReconnect: false, bellEnabled: true },
    listener: { state: "off", host: null, port: null, message: null },
    hosts: [], trustedPeers: [], consents: [], notice: null,
  };
  async start(): Promise<void> { this.options?.onChange(this.snapshot); if (this.startGate) await this.startGate; }
  read(): PeerUiSnapshot { return this.snapshot; }
  async perform(command: PeerUiCommand): Promise<void> { this.commands.push(command); if (this.performGate) await this.performGate; }
  decideConsent(id: string, decision: "approve" | "deny"): boolean {
    if (!this.snapshot.consents.some((consent) => consent.id === id)) return false;
    this.decisions.push({ id, decision });
    this.publish({ consents: this.snapshot.consents.filter((consent) => consent.id !== id) });
    return true;
  }
  async close(): Promise<void> {
    this.closeCalls++;
    if (this.closeFailure) throw new Error("synthetic unconfirmed network cleanup");
  }
  publish(patch: Partial<PeerUiSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...patch, revision: this.snapshot.revision + 1 };
    this.options?.onChange(this.snapshot);
  }
  incoming(consent: PeerUiConsent): void {
    this.publish({ consents: [...this.snapshot.consents, consent] });
    this.options?.onIncomingConsentArrival(consent.id);
  }
}

function syntheticPeerConsent(id: string, requestedAt = Date.now()): PeerUiConsent {
  return { id, kind: "incoming", label: "Expected peer", fingerprint: "A".repeat(43), endpoint: null,
    requestedAt, expiresAt: requestedAt + 120_000 };
}

async function peerMainHarness(
  t: { after(callback: () => void): void },
  configure?: (peer: FakePeerCoordinator) => void,
  extraDependencies: MainTestDependencies = {},
): Promise<{
  harness: Harness; peer: FakePeerCoordinator; dispatch(action: SidebarAction): void; releases(): number;
}> {
  const agentDir = makeMainTestDirectory("peer-ui-agent");
  writeFileSync(join(agentDir, "keybindings.json"), "{}", "utf8");
  t.after(() => rmSync(agentDir, { recursive: true, force: true }));
  const peer = new FakePeerCoordinator();
  configure?.(peer);
  const controllers: SidebarController[] = [];
  let releaseCalls = 0;
  let dispatch = (_action: SidebarAction): void => { assert.fail("Main did not install its sidebar action handler"); };
  const harness = createHarness({}, {
    createSessionSetup: () => ({ nativeSetup: true, nativeAgentDir: agentDir,
      profileRegistry: { prepare: () => { throw new Error("fake manager must not prepare a native profile"); } } }),
    openHostState: ({ agentDir: ownedDir, hostId }) => ({ status: "opened", state: {
      agentDir: ownedDir, hostId, ownershipPath: join(ownedDir, "synthetic-owner"), roster: undefined, problem: undefined,
      persist: () => true, release: () => { releaseCalls++; return true; },
    } }),
    createSidebar: (options) => {
      if (!options?.onAction) throw new Error("Main did not supply a sidebar handler");
      dispatch = options.onAction;
      const controller = new SidebarController({ ...options, now: peer.now }); controllers.push(controller); return controller;
    },
    createPeerCoordinator: (options) => { peer.options = options; return peer; },
    ...extraDependencies,
  });
  await ready(harness);
  const controller = controllers[0];
  assert.ok(controller, "capture Main's actual controller, not a detached fixture");
  harness.sidebar = controller;
  assert.ok(peer.options, "network coordinator is owned under the acquired native agent directory");
  return { harness, peer, dispatch: (action) => dispatch(action), releases: () => releaseCalls };
}

async function reviewOldestPeerConsent(harness: Harness): Promise<void> {
  harness.sidebar!.openPeerMenu();
  await nextTurn();
  for (let step = 0; step < 40; step++) {
    const frame = harness.writer.frames.at(-1)?.frame;
    const selected = frame?.lines.map((line) => line.replace(/\x1b\[[0-9;]*m/g, "").slice(33))
      .find((line) => line.startsWith("> "));
    // The narrow form can truncate the trailing countdown; the fixture's
    // unique consent label remains visible before that bounded truncation.
    if (selected?.startsWith("> ! Expected peer")) {
      harness.terminal.emitInput(ENTER);
      await nextTurn();
      assert.equal(harness.sidebar!.peerConsentConfirmationActive, true);
      return;
    }
    harness.terminal.emitInput("\x1b[B");
    await nextTurn();
  }
  assert.fail("the actual rendered network pane never offered its pending consent row");
}

/** Rendered heading of the pending-consent notice (band or roster alert). */
const INCOMING_ALERT = "Incoming connection request";
/** Rows the pending-consent notice occupies; Main reserves the same fixed band height. */
const PEER_ALERT_ROWS = 6;

/** Activates the roster row whose complete rendered label is selected, with real host input only. */
async function activateRosterRow(harness: Harness, label: string): Promise<void> {
  for (let step = 0; step <= 12; step += 1) {
    const selected = harness.writer.frames.at(-1)?.frame.lines
      .map((line) => line.replace(/\x1b\[[0-9;]*m/g, ""))
      .find((line) => line.startsWith("> "));
    if (selected?.includes(label)) {
      harness.terminal.emitInput(ENTER);
      await nextTurn();
      return;
    }
    harness.terminal.emitInput("\x1b[B");
    await nextTurn();
  }
  assert.fail(`the actual rendered roster never offered its ${label} row`);
}

/** Mutes the arrival bell first, so only the visual alert can prove the request is visible. */
async function deliverMutedIncomingRequest(peer: FakePeerCoordinator, id: string): Promise<void> {
  peer.publish({ settings: { ...peer.snapshot.settings!, bellEnabled: false } });
  await nextTurn();
  peer.incoming(syntheticPeerConsent(id));
  await nextTurn();
}

/** Opens the latched consent dialog from the narrow (full-width) Network pane. */
async function reviewOldestPeerConsentNarrow(harness: Harness): Promise<void> {
  harness.sidebar!.openPeerMenu();
  await nextTurn();
  for (let step = 0; step < 40; step++) {
    const selected = harness.writer.frames.at(-1)?.frame?.lines
      .map((line) => line.replace(/\x1b\[[0-9;]*m/g, ""))
      .find((line) => line.startsWith("> "));
    if (selected?.startsWith("> ! Expected peer")) {
      harness.terminal.emitInput(ENTER);
      await nextTurn();
      assert.equal(harness.sidebar!.peerConsentConfirmationActive, true);
      return;
    }
    harness.terminal.emitInput("\x1b[B");
    await nextTurn();
  }
  assert.fail("the actual rendered narrow network pane never offered its pending consent row");
}

/** Selected-row text of the last written frame, with generated SGR removed. */
function selectedScreenRow(harness: Harness): string {
  return harness.writer.frames.at(-1)?.frame.lines
    .map((line) => line.replace(/\x1b\[[0-9;]*m/g, ""))
    .find((line) => line.startsWith("> ")) ?? "";
}

/**
 * Opens the Add-destination field menu in the actual narrow Network pane with
 * real host input only, and waits for the frame that actually wrote it.
 */
async function openAddMenuInNarrowNetwork(harness: Harness): Promise<void> {
  for (let step = 0; step <= 12; step += 1) {
    if (selectedScreenRow(harness).includes("Add destination")) {
      harness.terminal.emitInput(ENTER);
      await nextTurn();
      const frame = harness.writer.frames.at(-1)?.frame;
      assert.ok(plain(frame).includes("Add destination (enter to add)"),
        "the actual Add-destination field menu is open and written");
      assert.equal(screenRowOfHeader(frame, "Add destination"), 1,
        "the open menu owns every content row before the request arrives");
      return;
    }
    harness.terminal.emitInput("\x1b[B");
    await nextTurn();
  }
  assert.fail("the actual rendered network pane never offered its Add destination row");
}

/**
 * Opens exactly one Add-destination field editor (by row label) from the open
 * Add menu, again with real host input and a real written receipt.
 */
async function openOneAddFieldEditor(harness: Harness, label: string): Promise<void> {
  for (let step = 0; step <= 8; step += 1) {
    if (selectedScreenRow(harness).includes(label)) {
      harness.terminal.emitInput(ENTER);
      await nextTurn();
      const frame = harness.writer.frames.at(-1)?.frame;
      assert.ok(plain(frame).includes(`> ${label}`), `the actual ${label} field editor is open and written`);
      assert.equal(screenRowOfHeader(frame, "Add destination"), 1,
        "the open editor owns every content row before the request arrives");
      return;
    }
    harness.terminal.emitInput("\x1b[B");
    await nextTurn();
  }
  assert.fail(`the actual rendered Add menu never offered its ${label} row`);
}

function emptySavedCatalog(agentDir: string): SavedSessionCatalog {
  return {
    agentDir,
    sessionsRoot: join(agentDir, "sessions"),
    revision: 1,
    rows: [],
    issues: [],
    issueCount: 0,
  };
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

function screenRowContaining(frame: ComposedHostFrame | undefined, text: string, fromRow = 1): number {
  return frame?.lines.findIndex((line, row) => row >= fromRow
    && line.replace(/\x1b\[[0-9;]*m/g, "").includes(text)) ?? -1;
}

/** Row of a pane header alone on its line, matched exactly so band text cannot shadow it. */
function screenRowOfHeader(frame: ComposedHostFrame | undefined, header: string): number {
  return frame?.lines.findIndex((line, row) => row >= 1
    && line.replace(/\x1b\[[0-9;]*m/g, "").trim() === header) ?? -1;
}

function graphicsPngBase64(seed: number): string {
  const width = 4;
  const height = 4;
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 6;
  const raw = Buffer.alloc(height * (width * 4 + 1));
  for (let row = 0; row < height; row += 1) {
    raw[row * (width * 4 + 1)] = 0;
    raw.fill(seed, row * (width * 4 + 1) + 1, (row + 1) * (width * 4 + 1));
  }
  const chunk = (type: string, data: Buffer): Buffer => {
    const typeBytes = Buffer.from(type, "ascii");
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(graphicsPngCrc32(Buffer.concat([typeBytes, data])));
    return Buffer.concat([length, typeBytes, data, crc]);
  };
  return Buffer.concat([
    signature,
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]).toString("base64");
}

function graphicsPngCrc32(input: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of input) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function fakeGraphicsFrame(base64: string): TerminalGraphicsFrame {
  return {
    images: [{ id: "kitty-7", mimeType: "image/png", widthPx: 4, heightPx: 4, base64 }],
    placements: [{
      id: "placement-7",
      imageId: "kitty-7",
      column: 2,
      row: 1,
      columns: 3,
      rows: 2,
      crop: { x: 0, y: 0, width: 4, height: 4 },
      clip: { leftColumns: 0, topRows: 0, rightColumns: 0, bottomRows: 0 },
    }],
    fallbacks: [{
      id: "placement-7",
      mimeType: "image/png",
      widthPx: 4,
      heightPx: 4,
      column: 2,
      row: 1,
      columns: 3,
      rows: 2,
      clip: { leftColumns: 0, topRows: 0, rightColumns: 0, bottomRows: 0 },
    }],
  };
}

function assertSavedDeleteConfirmationRightPanel(frame: { readonly lines: readonly string[] }, expectedFile: string): void {
  const body = frame.lines.slice(1).map((line) => line.replace(/\x1b\[[0-9;]*m/g, ""));
  const left = body.map((line) => line.slice(0, 32)).join("\n");
  const right = body.map((line) => line.slice(33)).join("\n");
  const normalize = (value: string): string => value.replace(/\s+/g, " ");
  const rightText = normalize(right);
  const leftText = normalize(left);
  assert.equal(body[0]?.[32], "│", "the right/main panel begins at column 33 after the divider");
  assert.ok(leftText.includes("Sessions"), "the roster remains in columns 0..31");
  for (const text of ["Delete saved conversation?", "Conversation:", "Only this saved file is removed", "If trash fails"])
    assert.equal(leftText.includes(text), false, `left roster must not contain confirmation text: ${text}`);
  assert.equal(left.replace(/\s/g, "").includes(expectedFile.replace(/\s/g, "")), false,
    "the exact target path is absent from the left roster");
  for (const text of [
    "Delete saved conversation?",
    "Conversation:",
    "Only this saved file is removed; the host will not stop any child.",
    "If trash fails, this file is permanently unlinked.",
    "enter confirm",
    "cancel",
  ]) assert.ok(rightText.includes(text), `right pane retains complete confirmation text: ${text}`);
  assert.match(rightText, /(?:esc|escape|ctrl\+c).*cancel/, "the native cancel binding is visible with its label");
  assert.ok(right.replace(/\s/g, "").includes(expectedFile.replace(/\s/g, "")),
    "the exact selected file path is wholly in the right pane");
}

function assertSavedPickerRightPanel(
  frame: { readonly lines: readonly string[] },
  query: string,
  selectedCaption: string,
): void {
  const body = frame.lines.slice(1).map((line) => line.replace(/\x1b\[[0-9;]*m/g, ""));
  const left = body.map((line) => line.slice(0, 32)).join("\n");
  const right = body.map((line) => line.slice(33)).join("\n");
  assert.ok(left.includes("Sessions"), "the roster returns to the left pane");
  assert.ok(right.includes("Saved conversations"), "the same Saved picker returns to the right pane");
  assert.ok(right.includes(query), "the query draft remains displayed in the picker");
  assert.ok(right.includes(`> ${selectedCaption}`), "the same Saved row remains selected after cancel");
}

async function emittedTerminalFrame(
  output: QueuedFrameOutput,
  cols: number,
  rows: number,
  includeQueued = false,
): Promise<TerminalFrame> {
  const surface = new TerminalSurface(cols, rows);
  try {
    const writes = [...output.writes, ...(includeQueued ? output.queuedTexts.map((text) => Buffer.from(text)) : [])];
    for (const bytes of writes) surface.write(bytes.toString("utf8"));
    await surface.flush();
    return surface.frame();
  } finally {
    surface.dispose();
  }
}

function emitMouse(
  terminal: FakeTerminal,
  column: number,
  row: number,
  button = 0,
  final: "M" | "m" = "M",
): void {
  terminal.emitInput(`${ESC}[<${button};${column + 1};${row + 1}${final}`);
}

function emitX10Mouse(terminal: FakeTerminal, column: number, row: number, button = 0): void {
  terminal.emitInput(`${ESC}[M${String.fromCharCode(button + 32, column + 33, row + 33)}`);
}

test("Main refuses a non-local selection target without changing its selected native owner", async () => {
  let dispatch = (_action: SidebarAction): void => { assert.fail("sidebar action handler was not captured"); };
  const controllers: SidebarController[] = [];
  const harness = createHarness({}, {
    createSidebar: (options) => {
      if (!options?.onAction) throw new Error("Main did not supply its sidebar action handler");
      dispatch = options.onAction;
      const controller = new SidebarController(options);
      controllers.push(controller);
      return controller;
    },
  });
  try {
    const manager = await startTwoSessions(harness);
    const controller = controllers[0];
    assert.ok(controller, "the injected factory captured Main's actual sidebar");
    const owner = controller.activeMainOwnerID;
    assert.equal(owner, "native-2");
    dispatch({ type: "select", id: "remote-host:foreign-row" });
    await nextTurn();
    assert.equal(controller.activeMainOwnerID, owner);
    assert.equal(manager.views.length, 2);
    assert.ok(sidebarNoticeRows(plain(harness.writer.frames.at(-1)?.frame), "That local session is no longer available") !== undefined);
  } finally {
    assert.equal(await closeWithSignal(harness), 0);
  }
});

test("incoming peer alert and optional bell never steal native focus; hidden sidebar has a visible alert band", async (t) => {
  const { harness, peer } = await peerMainHarness(t);
  try {
    fillForm(harness.terminal, "/peer-alert-native-owner");
    await nextTurn();
    const owner = harness.sidebar!.activeMainOwnerID;
    assert.ok(owner);
    assert.equal(harness.sidebar!.focus, "main");
    harness.terminal.emitInput(ALT_LEFT);
    harness.terminal.emitInput(ALT_LEFT);
    await nextTurn();
    assert.equal(harness.sidebar!.visible, false);
    const a = syntheticPeerConsent("incoming-A");
    peer.incoming(a);
    await nextTurn();
    assert.equal(harness.sidebar!.focus, "main");
    assert.equal(harness.sidebar!.visible, false, "arrival does not toggle visibility/focus preferences");
    assert.equal(harness.sidebar!.activeMainOwnerID, owner);
    assert.ok(plain(harness.writer.frames.at(-1)?.frame).includes("Incoming connection request"));
    assert.equal(harness.terminal.writes.filter((value) => value === "\x07").length, 1);
    peer.publish({ notice: "Unrelated metadata update" });
    peer.options!.onIncomingConsentArrival(a.id);
    await nextTurn();
    assert.equal(harness.terminal.writes.filter((value) => value === "\x07").length, 1, "redraw/replay is not a new arrival");
    peer.publish({ settings: { ...peer.snapshot.settings!, bellEnabled: false } });
    peer.incoming(syntheticPeerConsent("incoming-B"));
    await nextTurn();
    assert.equal(harness.terminal.writes.filter((value) => value === "\x07").length, 1);
    assert.ok(plain(harness.writer.frames.at(-1)?.frame).includes("Incoming connection request"));
  } finally { assert.equal(await closeWithSignal(harness), 0); }
});

test("a muted request arriving above an open narrow New session form keeps focus and reserves its rows", async (t) => {
  const { harness, peer } = await peerMainHarness(t);
  try {
    fillForm(harness.terminal, "/narrow-form");
    await nextTurn();
    const owner = harness.sidebar!.activeMainOwnerID;
    assert.ok(owner, "a live native owner exists before the request arrives");
    harness.terminal.emitInput(ALT_LEFT);
    await nextTurn();
    harness.terminal.setSize(40, 24); // narrow: the sidebar rectangle is a full-width overlay
    await nextTurn();
    await activateRosterRow(harness, "New session");
    assert.equal(harness.sidebar!.focus, "form", "the narrow New session form opened before the request arrived");

    // Capture the open pane's ownership and geometry before the asynchronous arrival.
    const selection = harness.sidebar!.selectedId;
    const opened = harness.writer.frames.at(-1)?.frame;
    assert.equal(screenRowContaining(opened, "New session"), 1, "the open form owns every content row");
    assert.equal(plain(opened).includes(INCOMING_ALERT), false, "nothing is pending yet");
    const resizesBeforeArrival = harness.manager!.resizeCalls.length;

    await deliverMutedIncomingRequest(peer, "narrow-new");

    const frame = harness.writer.frames.at(-1)?.frame;
    assert.ok(plain(frame).includes("New session"), "the form still owns the sidebar pane");
    assert.equal(screenRowContaining(frame, INCOMING_ALERT), 1,
      "an arrival while the form is open still reserves its rows above the pane");
    assert.equal(screenRowContaining(frame, "New session"), 1 + PEER_ALERT_ROWS,
      "the form pane starts below genuinely reserved rows instead of under an overlay");
    assert.deepEqual(harness.manager!.resizeCalls.at(-1), { cols: 40, rows: 24 - 1 - PEER_ALERT_ROWS, ids: [owner] },
      "the band takes real compositor rows rather than covering geometry the child still claims");
    assert.ok(harness.manager!.resizeCalls.length > resizesBeforeArrival,
      "the arrival reflowed the child to the reduced native pane");
    assert.equal(harness.sidebar!.focus, "form", "arrival never takes focus from the open form");
    assert.equal(harness.sidebar!.selectedId, selection, "arrival never changes the roster selection");
    assert.equal(harness.sidebar!.visible, true, "arrival never toggles sidebar visibility");
    assert.equal(harness.sidebar!.activeMainOwnerID, owner, "arrival never changes the native owner");
    assert.equal(harness.sidebar!.capturePeerConsentPresentation(), undefined,
      "the notification band grants no approval authority");
    assert.equal(harness.terminal.writes.filter((value) => value === "\x07").length, 0,
      "the muted bell is never written and the alert does not depend on it");

    peer.publish({ notice: "Unrelated metadata update" });
    await nextTurn();
    assert.equal(screenRowContaining(harness.writer.frames.at(-1)?.frame, INCOMING_ALERT), 1,
      "the band persists across an unrelated redraw while the request stays pending");

    peer.publish({ consents: [] });
    await nextTurn();
    const settled = harness.writer.frames.at(-1)?.frame;
    assert.equal(plain(settled).includes(INCOMING_ALERT), false, "the band dismisses when the request settles");
    assert.equal(screenRowContaining(settled, "New session"), 1, "the form pane regains the reserved rows");
    assert.deepEqual(harness.manager!.resizeCalls.at(-1), { cols: 40, rows: 23, ids: [owner] },
      "the child regains its full native height");
  } finally { assert.equal(await closeWithSignal(harness), 0); }
});

test("a muted request arriving above an open narrow Saved conversations picker stays visible", async (t) => {
  const { harness, peer } = await peerMainHarness(t, undefined, {
    listSavedCatalog: async ({ agentDir }) => emptySavedCatalog(agentDir),
  });
  try {
    fillForm(harness.terminal, "/narrow-saved");
    await nextTurn();
    const owner = harness.sidebar!.activeMainOwnerID;
    harness.terminal.emitInput(ALT_LEFT);
    await nextTurn();
    harness.terminal.setSize(40, 24);
    await nextTurn();
    await activateRosterRow(harness, "Saved conversations");
    assert.equal(harness.sidebar!.focus, "form", "the narrow Saved picker opened before the request arrived");
    const selection = harness.sidebar!.selectedId;
    assert.equal(screenRowContaining(harness.writer.frames.at(-1)?.frame, "Saved conversations"), 1,
      "the open picker owns every content row");

    await deliverMutedIncomingRequest(peer, "narrow-saved");

    const frame = harness.writer.frames.at(-1)?.frame;
    assert.equal(screenRowContaining(frame, INCOMING_ALERT), 1,
      "an arrival while the picker is open cannot hide the pending request");
    assert.equal(screenRowContaining(frame, "Saved conversations"), 1 + PEER_ALERT_ROWS);
    assert.equal(harness.sidebar!.focus, "form", "arrival never takes focus from the open picker");
    assert.equal(harness.sidebar!.selectedId, selection, "arrival never changes the roster selection");
    assert.equal(harness.sidebar!.activeMainOwnerID, owner, "arrival never changes the native owner");
    assert.equal(harness.terminal.writes.filter((value) => value === "\x07").length, 0);
  } finally { assert.equal(await closeWithSignal(harness), 0); }
});

test("a muted request arriving above the open narrow Network pane stays visible", async (t) => {
  const { harness, peer } = await peerMainHarness(t);
  try {
    fillForm(harness.terminal, "/narrow-network");
    await nextTurn();
    const owner = harness.sidebar!.activeMainOwnerID;
    harness.terminal.emitInput(ALT_LEFT);
    await nextTurn();
    harness.terminal.setSize(40, 24);
    await nextTurn();
    await activateRosterRow(harness, "Network");
    assert.equal(harness.sidebar!.focus, "form", "the narrow Network pane opened before the request arrived");
    const selection = harness.sidebar!.selectedId;
    assert.equal(screenRowOfHeader(harness.writer.frames.at(-1)?.frame, "Network"), 1,
      "the open network pane owns every content row");

    await deliverMutedIncomingRequest(peer, "narrow-network");

    const frame = harness.writer.frames.at(-1)?.frame;
    assert.equal(screenRowContaining(frame, INCOMING_ALERT), 1,
      "an arrival while the list is open keeps its identity and review hint above it");
    assert.equal(screenRowOfHeader(frame, "Network"), 1 + PEER_ALERT_ROWS,
      "the network pane moves down the reserved rows instead of under an overlay");
    assert.equal(harness.sidebar!.focus, "form", "arrival never takes focus from the open network pane");
    assert.equal(harness.sidebar!.selectedId, selection, "arrival never changes the roster selection");
    assert.equal(harness.sidebar!.activeMainOwnerID, owner, "arrival never changes the native owner");
    assert.equal(harness.sidebar!.capturePeerConsentPresentation(), undefined,
      "neither the band nor the list grants approval authority without the written dialog");
    assert.equal(harness.terminal.writes.filter((value) => value === "\x07").length, 0);
  } finally { assert.equal(await closeWithSignal(harness), 0); }
});

test("a muted request arriving while the Add destination menu is open stays visible and grants nothing", async (t) => {
  const { harness, peer } = await peerMainHarness(t);
  try {
    fillForm(harness.terminal, "/narrow-add-menu");
    await nextTurn();
    const owner = harness.sidebar!.activeMainOwnerID;
    assert.ok(owner, "a live native owner exists before the request arrives");
    harness.terminal.emitInput(ALT_LEFT);
    await nextTurn();
    harness.terminal.setSize(40, 40); // narrow: below the 53-column split, tall enough for the band
    await nextTurn();
    await activateRosterRow(harness, "Network");
    assert.equal(harness.sidebar!.focus, "form", "the narrow Network pane opened before the request arrived");
    await openAddMenuInNarrowNetwork(harness);

    // Capture the open menu's ownership and geometry before the asynchronous arrival.
    const selection = harness.sidebar!.selectedId;
    const commandsBeforeArrival = peer.commands.length;
    const resizesBeforeArrival = harness.manager!.resizeCalls.length;

    await deliverMutedIncomingRequest(peer, "narrow-add-menu");

    const frame = harness.writer.frames.at(-1)?.frame;
    assert.ok(plain(frame).includes("Add destination (enter to add)"), "the open Add menu survives the arrival");
    assert.equal(screenRowContaining(frame, INCOMING_ALERT), 1,
      "an arrival while the Add menu is open still reserves its rows above the pane");
    assert.equal(screenRowOfHeader(frame, "Add destination"), 1 + PEER_ALERT_ROWS,
      "the Add menu moves down genuinely reserved rows instead of under an overlay");
    assert.deepEqual(harness.manager!.resizeCalls.at(-1), { cols: 40, rows: 40 - 1 - PEER_ALERT_ROWS, ids: [owner] },
      "the band takes real compositor rows rather than covering geometry the child still claims");
    assert.ok(harness.manager!.resizeCalls.length > resizesBeforeArrival,
      "the arrival reflowed the child to the reduced native pane");
    assert.equal(harness.sidebar!.focus, "form", "arrival never takes focus from the open Add menu");
    assert.equal(harness.sidebar!.selectedId, selection, "arrival never changes the roster selection");
    assert.equal(harness.sidebar!.visible, true, "arrival never toggles sidebar visibility");
    assert.equal(harness.sidebar!.activeMainOwnerID, owner, "arrival never changes the native owner");
    assert.equal(harness.sidebar!.peerConsentConfirmationActive, false,
      "the notification band is not a consent dialog");
    assert.equal(harness.sidebar!.capturePeerConsentPresentation(), undefined,
      "the Add menu grants no approval authority");
    assert.equal(peer.commands.length, commandsBeforeArrival, "an arrival performs no network command");
    assert.equal(harness.terminal.writes.filter((value) => value === "\x07").length, 0,
      "the muted bell is never written and the alert does not depend on it");

    peer.publish({ notice: "Unrelated metadata update" });
    await nextTurn();
    const redrawn = harness.writer.frames.at(-1)?.frame;
    assert.equal(screenRowContaining(redrawn, INCOMING_ALERT), 1,
      "the band persists across an unrelated redraw while the request stays pending");
    assert.ok(plain(redrawn).includes("Add destination (enter to add)"),
      "the unrelated redraw keeps the operator's open menu");
  } finally { assert.equal(await closeWithSignal(harness), 0); }
});

test("a muted request arriving with one Add destination field editor open stays visible and grants nothing", async (t) => {
  const { harness, peer } = await peerMainHarness(t);
  try {
    fillForm(harness.terminal, "/narrow-add-field");
    await nextTurn();
    const owner = harness.sidebar!.activeMainOwnerID;
    assert.ok(owner, "a live native owner exists before the request arrives");
    harness.terminal.emitInput(ALT_LEFT);
    await nextTurn();
    harness.terminal.setSize(40, 40); // narrow: below the 53-column split, tall enough for the band
    await nextTurn();
    await activateRosterRow(harness, "Network");
    await openAddMenuInNarrowNetwork(harness);
    await openOneAddFieldEditor(harness, "Host:");
    assert.equal(harness.sidebar!.focus, "form", "the single-field editor opened before the request arrived");

    const selection = harness.sidebar!.selectedId;
    const commandsBeforeArrival = peer.commands.length;

    await deliverMutedIncomingRequest(peer, "narrow-add-field");

    const frame = harness.writer.frames.at(-1)?.frame;
    assert.ok(plain(frame).includes("> Host:"), "the open field editor survives the arrival");
    assert.equal(screenRowContaining(frame, INCOMING_ALERT), 1,
      "an arrival while one Add field is open still reserves its rows above the editor");
    assert.equal(screenRowOfHeader(frame, "Add destination"), 1 + PEER_ALERT_ROWS,
      "the editor moves down genuinely reserved rows instead of under an overlay");
    assert.deepEqual(harness.manager!.resizeCalls.at(-1), { cols: 40, rows: 40 - 1 - PEER_ALERT_ROWS, ids: [owner] },
      "the band takes real compositor rows rather than covering geometry the child still claims");
    assert.equal(harness.sidebar!.focus, "form", "arrival never takes focus from the open editor");
    assert.equal(harness.sidebar!.selectedId, selection, "arrival never changes the roster selection");
    assert.equal(harness.sidebar!.activeMainOwnerID, owner, "arrival never changes the native owner");
    assert.equal(harness.sidebar!.peerConsentConfirmationActive, false,
      "the notification band is not a consent dialog");
    assert.equal(harness.sidebar!.capturePeerConsentPresentation(), undefined,
      "an open destination editor grants no approval authority");
    assert.equal(peer.commands.length, commandsBeforeArrival, "an arrival performs no network command");
    assert.equal(harness.terminal.writes.filter((value) => value === "\x07").length, 0);

    peer.publish({ notice: "Unrelated metadata update" });
    await nextTurn();
    const redrawn = harness.writer.frames.at(-1)?.frame;
    assert.equal(screenRowContaining(redrawn, INCOMING_ALERT), 1,
      "the band persists across an unrelated redraw while the request stays pending");
    assert.ok(plain(redrawn).includes("> Host:"), "the unrelated redraw keeps the operator's open editor");
  } finally { assert.equal(await closeWithSignal(harness), 0); }
});

test("a muted request arriving above an open ordinary confirmation stays visible in narrow and wide layouts", async (t) => {
  const { harness, peer } = await peerMainHarness(t);
  try {
    fillForm(harness.terminal, "/narrow-confirm");
    await nextTurn();
    const owner = harness.sidebar!.activeMainOwnerID;
    harness.terminal.emitInput(ALT_LEFT);
    await nextTurn();
    harness.terminal.setSize(40, 24);
    await nextTurn();
    harness.terminal.emitInput("q"); // the ordinary Quit host confirmation, not a consent dialog
    await nextTurn();
    assert.equal(harness.sidebar!.focus, "confirm", "the ordinary confirmation opened before the request arrived");
    assert.equal(harness.sidebar!.peerConsentConfirmationActive, false);
    const selection = harness.sidebar!.selectedId;
    assert.equal(screenRowContaining(harness.writer.frames.at(-1)?.frame, "Quit host?"), 1,
      "the open confirmation owns every content row");

    await deliverMutedIncomingRequest(peer, "narrow-confirm");

    const narrow = harness.writer.frames.at(-1)?.frame;
    assert.ok(plain(narrow).includes("Quit host?"), "the confirmation stays open through the arrival");
    assert.equal(screenRowContaining(narrow, INCOMING_ALERT), 1,
      "an arrival while an ordinary confirmation is open still reserves its rows");
    assert.equal(screenRowContaining(narrow, "Quit host?"), 1 + PEER_ALERT_ROWS);
    assert.equal(harness.sidebar!.focus, "confirm", "arrival never takes focus from the open confirmation");
    assert.equal(harness.sidebar!.selectedId, selection, "arrival never changes the roster selection");
    assert.equal(harness.sidebar!.activeMainOwnerID, owner, "arrival never changes the native owner");
    assert.equal(harness.terminal.writes.filter((value) => value === "\x07").length, 0);

    harness.terminal.setSize(80, 24);
    await nextTurn();
    const wide = harness.writer.frames.at(-1)?.frame;
    assert.ok(plain(wide).includes("Quit host?"), "the same confirmation stays open in the wide sidebar pane");
    assert.equal(screenRowContaining(wide, INCOMING_ALERT), 1,
      "a wide confirmation that replaces the roster also loses the hidden alert without the band");
    assert.equal(harness.sidebar!.focus, "confirm");
    assert.equal(harness.sidebar!.activeMainOwnerID, owner);

    peer.publish({ consents: [] });
    await nextTurn();
    const settled = harness.writer.frames.at(-1)?.frame;
    assert.equal(plain(settled).includes(INCOMING_ALERT), false, "the band dismisses when the request settles");
    assert.equal(screenRowContaining(settled, "Quit host?"), 1, "the confirmation regains the reserved rows");
    assert.equal(harness.sidebar!.focus, "confirm", "settlement never takes focus either");
  } finally { assert.equal(await closeWithSignal(harness), 0); }
});

test("a physically insufficient consent dialog refuses its own action while the alert band persists", async (t) => {
  const { harness, peer, dispatch } = await peerMainHarness(t);
  try {
    fillForm(harness.terminal, "/narrow-consent");
    await nextTurn();
    const owner = harness.sidebar!.activeMainOwnerID;
    harness.terminal.emitInput(ALT_LEFT);
    await nextTurn();
    harness.terminal.setSize(40, 40); // below the 53-column split; tall enough for the dialog plus alert
    await nextTurn();
    await deliverMutedIncomingRequest(peer, "narrow-consent");
    await reviewOldestPeerConsentNarrow(harness);

    const frame = harness.writer.frames.at(-1)?.frame;
    assert.ok(plain(frame).includes("Approve incoming connection?"), "the narrow consent dialog is open");
    assert.equal(screenRowContaining(frame, INCOMING_ALERT), 1,
      "the roster was replaced, so the reserved band keeps the request visible");
    const candidate = harness.sidebar!.capturePeerConsentPresentation();
    assert.ok(candidate && candidate.consentId === "narrow-consent",
      "the complete dialog written beside the band keeps its own authority");

    // A terminal too short for both is the dialog's problem to refuse, never a
    // reason to drop the pending alert: the band stays and the partial frame
    // revokes its token through the existing complete-written-frame fence.
    harness.terminal.setSize(40, 8);
    await nextTurn();
    const tiny = harness.writer.frames.at(-1)?.frame;
    assert.equal(screenRowContaining(tiny, INCOMING_ALERT), 1,
      "the pending request is never traded away for pane comfort");
    assert.equal(harness.sidebar!.capturePeerConsentPresentation(), undefined,
      "a dialog that cannot show its full frame mints no candidate");
    dispatch({
      type: "peer-consent",
      consentId: candidate.consentId,
      renderToken: candidate.renderToken,
      decision: candidate.decision,
    });
    assert.deepEqual(peer.decisions, [], "the revoked frame authorizes nothing, even with its own captured decision");
    assert.equal(harness.sidebar!.focus, "confirm", "the band never takes focus");
    assert.equal(harness.sidebar!.activeMainOwnerID, owner);
    assert.equal(harness.terminal.writes.filter((value) => value === "\x07").length, 0);
  } finally { assert.equal(await closeWithSignal(harness), 0); }
});

test("a wide roster beside an open form keeps its own alert and gains no redundant band", async (t) => {
  const { harness, peer } = await peerMainHarness(t);
  try {
    fillForm(harness.terminal, "/wide-form");
    await nextTurn();
    const owner = harness.sidebar!.activeMainOwnerID;
    const resizesBeforeForm = harness.manager!.resizeCalls.length;
    harness.terminal.emitInput(ALT_LEFT);
    await nextTurn();
    await deliverMutedIncomingRequest(peer, "wide-form");

    await activateRosterRow(harness, "New session");
    assert.equal(harness.sidebar!.focus, "form");
    const frame = harness.writer.frames.at(-1)?.frame;
    const body = frame!.lines.slice(1).map((line) => line.replace(/\x1b\[[0-9;]*m/g, ""));
    const left = body.map((line) => line.slice(0, 32)).join("\n");
    const right = body.map((line) => line.slice(33)).join("\n");
    assert.ok(left.includes("Sessions"), "the roster stays in the left pane");
    assert.ok(left.includes(INCOMING_ALERT), "the roster keeps announcing the pending request");
    assert.ok(right.includes("New session"), "the form stays in the right pane");
    assert.ok(body[0]?.startsWith(" Sessions"), "the roster header keeps row 1 — no rows were reserved");
    assert.equal(harness.manager!.resizeCalls.length, resizesBeforeForm,
      "the visible roster case never resizes the child for a band");
    assert.equal(harness.sidebar!.focus, "form");
    assert.equal(harness.sidebar!.activeMainOwnerID, owner);
    assert.equal(harness.terminal.writes.filter((value) => value === "\x07").length, 0);
  } finally { assert.equal(await closeWithSignal(harness), 0); }
});

test("Main independently refuses queued peer approval until the exact confirmation is actually written", async (t) => {
  const { harness, peer, dispatch } = await peerMainHarness(t);
  try {
    peer.incoming(syntheticPeerConsent("request-A"));
    await nextTurn();
    harness.writer.holdWrites = true;
    await reviewOldestPeerConsent(harness);
    harness.terminal.emitInput("y");
    await nextTurn();
    const candidate = harness.sidebar!.capturePeerConsentPresentation();
    assert.ok(candidate, "the queued complete dialog has only a candidate token");
    assert.equal(candidate.decision, "approve");
    dispatch({ type: "peer-consent", consentId: candidate.consentId, renderToken: candidate.renderToken, decision: "approve" });
    assert.deepEqual(peer.decisions, [], "UI DTO/candidate alone is never approval authority");
    await nextTurn();
    harness.writer.drainHeldWrites();
    const written = harness.sidebar!.capturePeerConsentPresentation();
    assert.ok(written);
    dispatch({ type: "peer-consent", consentId: written.consentId, renderToken: written.renderToken, decision: "approve" });
    assert.deepEqual(peer.decisions, [{ id: "request-A", decision: "approve" }]);
  } finally { harness.writer.holdWrites = false; assert.equal(await closeWithSignal(harness), 0); }
});

test("expired A and new B cannot turn a stale consent action into approval of B", async (t) => {
  const { harness, peer, dispatch } = await peerMainHarness(t);
  try {
    peer.incoming(syntheticPeerConsent("request-A"));
    await nextTurn();
    await reviewOldestPeerConsent(harness);
    const a = harness.sidebar!.capturePeerConsentPresentation();
    assert.ok(a);
    assert.equal(a.decision, "deny");
    dispatch({ type: "peer-consent", consentId: a.consentId, renderToken: a.renderToken, decision: "approve" });
    assert.deepEqual(peer.decisions, [], "a written Deny target is not an Approve receipt");
    harness.terminal.emitInput("y");
    await nextTurn();
    const approvedTarget = harness.sidebar!.capturePeerConsentPresentation();
    assert.ok(approvedTarget && approvedTarget.decision === "approve", "A's positive target has now actually rendered");
    peer.publish({ consents: [syntheticPeerConsent("request-B")] });
    await nextTurn();
    dispatch({ type: "peer-consent", consentId: approvedTarget.consentId, renderToken: approvedTarget.renderToken, decision: "approve" });
    assert.deepEqual(peer.decisions, []);
    assert.equal(peer.snapshot.consents[0]?.id, "request-B");
  } finally { assert.equal(await closeWithSignal(harness), 0); }
});

test("an unchanged receipt only preserves an already-written peer consent target", async (t) => {
  const now = Date.now();
  const { harness, peer, dispatch } = await peerMainHarness(t, (fixture) => { fixture.now = () => now; });
  try {
    peer.incoming(syntheticPeerConsent("unchanged-existing", now));
    await nextTurn();
    await reviewOldestPeerConsent(harness);
    harness.terminal.emitInput("y");
    await nextTurn();
    const written = harness.sidebar!.capturePeerConsentPresentation();
    assert.ok(written && written.decision === "approve");
    const before = harness.writer.frames.at(-1)!.frame;
    harness.writer.settlementDisposition = "unchanged";
    peer.publish({ notice: "An unrelated metadata observation" });
    await nextTurn();
    assert.deepEqual(harness.writer.frames.at(-1)!.frame, before, "the unchanged witness really has identical composed bytes/cursor");
    assert.equal(harness.sidebar!.capturePeerConsentPresentation()?.renderToken, written.renderToken);
    dispatch({ type: "peer-consent", consentId: written.consentId, renderToken: written.renderToken, decision: "approve" });
    assert.deepEqual(peer.decisions, [{ id: written.consentId, decision: "approve" }]);
  } finally { assert.equal(await closeWithSignal(harness), 0); }
});

test("a new handshake with identical visible consent bytes cannot inherit an unchanged receipt", async (t) => {
  const now = Date.now();
  const { harness, peer, dispatch } = await peerMainHarness(t, (fixture) => { fixture.now = () => now; });
  try {
    peer.incoming(syntheticPeerConsent("identical-A", now));
    await nextTurn();
    await reviewOldestPeerConsent(harness);
    harness.terminal.emitInput("y");
    await nextTurn();
    const a = harness.sidebar!.capturePeerConsentPresentation();
    assert.ok(a && a.decision === "approve");
    const aFrame = harness.writer.frames.at(-1)!.frame;
    harness.terminal.emitInput(ENTER);
    await nextTurn();
    assert.deepEqual(peer.decisions, [{ id: "identical-A", decision: "approve" }]);
    peer.incoming(syntheticPeerConsent("identical-B", now));
    await nextTurn();
    const invalidations = harness.writer.invalidateCalls;
    harness.writer.settlementDisposition = "unchanged";
    await reviewOldestPeerConsent(harness);
    harness.terminal.emitInput("y");
    await nextTurn();
    const b = harness.sidebar!.capturePeerConsentPresentation();
    assert.ok(b && b.decision === "approve");
    assert.notEqual(b.renderToken, a.renderToken);
    assert.deepEqual(harness.writer.frames.at(-1)!.frame, aFrame, "new immutable handshake identity is deliberately not a display label");
    assert.ok(harness.writer.invalidateCalls > invalidations, "semantic identity change forces the real writer to repaint");
    dispatch({ type: "peer-consent", consentId: b.consentId, renderToken: b.renderToken, decision: "approve" });
    assert.deepEqual(peer.decisions, [{ id: "identical-A", decision: "approve" }], "unchanged alone never settles the new request");
  } finally { assert.equal(await closeWithSignal(harness), 0); }
});

test("tiny and resized consent frames revoke Main proof until a complete replacement is written", async (t) => {
  const { harness, peer, dispatch } = await peerMainHarness(t);
  try {
    peer.incoming(syntheticPeerConsent("resize-A"));
    await nextTurn();
    await reviewOldestPeerConsent(harness);
    harness.terminal.emitInput("y");
    await nextTurn();
    const old = harness.sidebar!.capturePeerConsentPresentation();
    assert.ok(old && old.decision === "approve");
    harness.writer.holdWrites = true;
    harness.terminal.setSize(20, 4);
    assert.equal(harness.sidebar!.capturePeerConsentPresentation(), undefined, "resize revokes synchronously before rendering");
    await nextTurn();
    assert.equal(harness.sidebar!.capturePeerConsentPresentation(), undefined, "tiny dialog cannot mint a candidate");
    dispatch({ type: "peer-consent", consentId: old.consentId, renderToken: old.renderToken, decision: "approve" });
    assert.deepEqual(peer.decisions, []);
    harness.terminal.setSize(90, 24);
    await nextTurn();
    const next = harness.sidebar!.capturePeerConsentPresentation();
    assert.ok(next && next.decision === "approve");
    assert.notEqual(next.renderToken, old.renderToken);
    dispatch({ type: "peer-consent", consentId: next.consentId, renderToken: next.renderToken, decision: "approve" });
    assert.deepEqual(peer.decisions, [], "complete but queued replacement is still not written");
    await nextTurn();
    harness.writer.drainHeldWrites();
    const written = harness.sidebar!.capturePeerConsentPresentation();
    assert.ok(written);
    dispatch({ type: "peer-consent", consentId: written.consentId, renderToken: written.renderToken, decision: "approve" });
    assert.deepEqual(peer.decisions, [{ id: "resize-A", decision: "approve" }]);
  } finally { harness.writer.holdWrites = false; assert.equal(await closeWithSignal(harness), 0); }
});

test("peer destination actions never target a local session even when opaque ids collide", async (t) => {
  const { harness, peer, dispatch } = await peerMainHarness(t);
  try {
    fillForm(harness.terminal, "/peer-action-local-owner");
    await nextTurn();
    const owner = harness.sidebar!.activeMainOwnerID;
    assert.ok(owner);
    for (const command of [
      { type: "peer-connect", hostId: owner }, { type: "peer-disconnect", hostId: owner },
      { type: "peer-remove", hostId: owner }, { type: "peer-revoke", peerId: owner },
    ] as const) dispatch(command);
    await nextTurn();
    assert.deepEqual(peer.commands.map((command) => command.type), ["peer-connect", "peer-disconnect", "peer-remove", "peer-revoke"]);
    assert.equal(harness.sidebar!.activeMainOwnerID, owner);
    assert.equal(harness.manager!.views.length, 1);
    assert.equal(harness.manager!.views[0]?.lifecycle, "alive");
  } finally { assert.equal(await closeWithSignal(harness), 0); }
});

test("a failed advisory bell attempt never retries or shuts down a healthy Main", async (t) => {
  const { harness, peer } = await peerMainHarness(t);
  const write = harness.terminal.write.bind(harness.terminal);
  let attempts = 0;
  harness.terminal.write = (value) => {
    if (value === "\x07") { attempts++; throw new Error("synthetic suppressed bell"); }
    write(value);
  };
  try {
    const consent = syntheticPeerConsent("bell-failure");
    peer.incoming(consent);
    peer.options!.onIncomingConsentArrival(consent.id);
    await nextTurn();
    assert.equal(attempts, 1);
    assert.equal(harness.terminal.started, true);
    assert.equal(peer.closeCalls, 0);
  } finally {
    harness.terminal.write = write;
    assert.equal(await closeWithSignal(harness), 0);
  }
});

test("unconfirmed owned network cleanup retains the host ownership record even after children settle", async (t) => {
  const { harness, peer, releases } = await peerMainHarness(t);
  peer.closeFailure = true;
  assert.equal(await closeWithSignal(harness), 1);
  assert.equal(peer.closeCalls, 1);
  assert.equal(releases(), 0);
  assert.ok(harness.reports.some((message) => message.includes("Network cleanup did not settle")));
});

for (const pending of ["start", "action"] as const) {
  test(`a failed coordinator barrier does not hang Main on abandoned ${pending} work`, async (t) => {
    let finishPending!: () => void;
    const gate = new Promise<void>((resolve) => { finishPending = resolve; });
    const { harness, peer, dispatch, releases } = await peerMainHarness(t, (fixture) => {
      if (pending === "start") fixture.startGate = gate;
      else fixture.performGate = gate;
    });
    if (pending === "action") {
      dispatch({ type: "peer-bell", enabled: false });
      await nextTurn();
      assert.equal(peer.commands.length, 1, "the operation was actually admitted before shutdown");
    }
    peer.closeFailure = true;
    let deadline: ReturnType<typeof setTimeout> | undefined;
    try {
      // The fake close rejects immediately; the finite referenced guard reports
      // an actual regression instead of cancelling when no real socket exists.
      const guard = new Promise<never>((_resolve, reject) => {
        deadline = setTimeout(() => reject(new Error("Main waited past a failed coordinator barrier")), 2000);
      });
      assert.equal(await Promise.race([closeWithSignal(harness), guard]), 1);
      assert.equal(peer.closeCalls, 1);
      assert.equal(releases(), 0);
      assert.ok(harness.reports.some((message) => message.includes("Network cleanup did not settle")));
    } finally {
      if (deadline) clearTimeout(deadline);
      finishPending();
      await harness.result;
    }
  });
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

test("host shortcut editor persists F8/F9, applies them immediately, and preserves active Main identity", async () => {
  const harness = createHarness();
  const manager = await ready(harness);
  fillForm(harness.terminal, "/shortcut-owner");
  await nextTurn();
  assert.equal(harness.sidebar?.activeMainOwnerID, "native-1");
  harness.terminal.emitInput(ALT_LEFT); // focus the visible roster without resizing
  for (let index = 0; index < 4; index += 1) harness.terminal.emitInput("\x1b[B"); // row -> Saved -> New -> Quit -> Host shortcuts
  harness.terminal.emitInput(ENTER);
  assert.equal(harness.sidebar?.focus, "form");

  harness.terminal.emitInput("\x15");
  harness.terminal.emitInput("f8");
  harness.terminal.emitInput("\t");
  harness.terminal.emitInput("\x15");
  harness.terminal.emitInput("f9");
  harness.terminal.emitInput(ENTER); // Save through the host-owned form
  await nextTurn();

  const configPath = join(harness.agentDir, "session-host", "keybindings.json");
  assert.deepEqual(JSON.parse(readFileSync(configPath, "utf8")), {
    version: 1,
    toggle: "f8",
    returnToMain: "f9",
  });
  assert.equal(harness.sidebar?.focus, "sidebar");
  assert.equal(harness.sidebar?.visible, true);
  assert.equal(harness.sidebar?.activeMainOwnerID, "native-1", "saving does not change active Main identity");
  assert.equal(manager.writes.length, 0, "editor input is never sent to the active native child");

  harness.terminal.emitInput("\x1b[19~"); // configured F8 hides from roster focus
  assert.equal(harness.sidebar?.visible, false);
  harness.terminal.emitInput("\x1b[19~"); // hidden F8 shows and focuses the roster
  await nextTurn();
  assert.equal(harness.sidebar?.visible, true);
  assert.equal(harness.sidebar?.focus, "sidebar");
  harness.terminal.emitInput("\x1b[20~"); // configured F9 returns to Main only
  assert.equal(harness.sidebar?.visible, true);
  assert.equal(harness.sidebar?.focus, "main");
  assert.equal(harness.sidebar?.activeMainOwnerID, "native-1");
  harness.terminal.emitInput("\x1b[20~"); // fresh F9 in Main remains native input
  harness.terminal.emitInput(ALT_LEFT); // the old default toggle is native input now
  assert.deepEqual(manager.writes.slice(-2).map(({ id }) => id), ["native-1", "native-1"]);
  assert.equal(await closeWithSignal(harness), 0);
});

test("Main loads the dedicated host shortcut file without changing native Pi keybindings", async () => {
  const harness = createHarness();
  const hostDir = join(harness.agentDir, "session-host");
  mkdirSync(hostDir, { recursive: true });
  writeFileSync(join(hostDir, "keybindings.json"), JSON.stringify({
    version: 1,
    toggle: "f8",
    returnToMain: "f9",
  }), "utf8");

  await ready(harness);
  harness.terminal.emitInput("\x1b[19~"); // loaded F8 toggles the sidebar
  assert.equal(harness.sidebar?.visible, false);
  harness.terminal.emitInput("\x1b[19~"); // hidden F8 restores and focuses it
  await nextTurn();
  assert.equal(harness.sidebar?.visible, true);
  assert.equal(harness.sidebar?.focus, "sidebar");
  harness.terminal.emitInput("\x1b[20~"); // loaded F9 returns to Main
  assert.equal(harness.sidebar?.focus, "main");
  harness.terminal.emitInput("\x1b[19~"); // visible Main only transfers focus to roster
  await nextTurn();
  assert.equal(harness.sidebar?.visible, true);
  assert.equal(harness.sidebar?.focus, "sidebar");
  harness.terminal.emitInput("\x1b[20~");
  assert.equal(harness.sidebar?.focus, "main");
  assert.equal(readFileSync(join(harness.agentDir, "keybindings.json"), "utf8"), "{}",
    "host shortcut loading never modifies native Pi keybindings");
  assert.equal(await closeWithSignal(harness), 0);
});

test("legacy --sidebar-key overrides configured toggle and the editor identifies the override", async () => {
  const harness = createHarness({ toggleKey: "f7" });
  await ready(harness);
  harness.terminal.emitInput("\x1b[B"); // New -> Quit host
  harness.terminal.emitInput("\x1b[B"); // -> Host shortcuts
  harness.terminal.emitInput(ENTER);
  const formText = harness.sidebar?.renderForm(80, 24).lines.join(" ").replace(/\x1b\[[0-9;]*m/g, "") ?? "";
  assert.match(formText, /Legacy --sidebar-key override active: F7/);

  harness.terminal.emitInput("\x15");
  harness.terminal.emitInput("f8");
  harness.terminal.emitInput("\t");
  harness.terminal.emitInput("\x15");
  harness.terminal.emitInput("f9");
  harness.terminal.emitInput(ENTER);
  await nextTurn();
  assert.deepEqual(JSON.parse(readFileSync(join(harness.agentDir, "session-host", "keybindings.json"), "utf8")), {
    version: 1,
    toggle: "f8",
    returnToMain: "f9",
  }, "the editor persists the configured binding, not the CLI override");
  harness.terminal.emitInput("\x1b[19~"); // configured F8 is not effective under --sidebar-key
  assert.equal(harness.sidebar?.visible, true);
  harness.terminal.emitInput("\x1b[18~"); // legacy F7 remains the active toggle
  assert.equal(harness.sidebar?.visible, false);
  assert.equal(await closeWithSignal(harness), 0);
});

test("failed host shortcut write keeps the editor open and the previous active toggle", async () => {
  const harness = createHarness({}, {
    writeHostShortcutConfig: () => { throw new Error("synthetic settings write failure"); },
  });
  await ready(harness);
  harness.terminal.emitInput("\x1b[B");
  harness.terminal.emitInput("\x1b[B");
  harness.terminal.emitInput(ENTER);
  harness.terminal.emitInput("\x15");
  harness.terminal.emitInput("f8");
  harness.terminal.emitInput("\t");
  harness.terminal.emitInput("\x15");
  harness.terminal.emitInput("f9");
  harness.terminal.emitInput(ENTER);
  assert.equal(harness.sidebar?.focus, "form");
  const errorText = harness.sidebar?.renderForm(80, 24).lines.join(" ").replace(/\x1b\[[0-9;]*m/g, "") ?? "";
  assert.match(errorText, /synthetic settings write failure/);
  harness.terminal.emitInput("\x1b"); // Cancel does not commit the draft
  assert.equal(harness.sidebar?.focus, "sidebar");
  harness.terminal.emitInput(ALT_LEFT);
  assert.equal(harness.sidebar?.visible, false, "the previous Alt+Left toggle remains active after failed Save");
  assert.equal(await closeWithSignal(harness), 0);
});

test("invalid existing host shortcut file refuses startup even with --sidebar-key", async () => {
  const harness = createHarness({ toggleKey: "f8" }, {
    readHostShortcutConfig: () => ({
      status: "unavailable",
      message: "Session host refused: host shortcut settings contain malformed JSON. The file was left untouched; fix or move it before restarting.",
    }),
  });
  assert.equal(await harness.result, 1);
  assert.equal(harness.manager, undefined, "invalid settings refuse before manager or child construction");
  assert.ok(harness.reports.some((message) => message.includes("file was left untouched")));
});

test("legacy toggle override and file return chord aliases are refused at startup", async () => {
  for (const [toggleKey, returnToMain] of [["f9", "f9"], ["ctrl+-", "ctrl+_"], ["ctrl+alt+-", "ctrl+alt+_"], ["alt+f", "alt+right"]] as const) {
    const harness = createHarness({ toggleKey }, {
      readHostShortcutConfig: () => ({
        status: "loaded",
        bindings: { toggle: "f8", returnToMain },
      }),
    });
    assert.equal(await harness.result, 1, `${toggleKey} / ${returnToMain}`);
    assert.equal(harness.manager, undefined);
    assert.ok(harness.reports.some((message) => message.includes("effective toggle and return-to-Main shortcuts conflict")));
  }
});

test("Save refuses a configured return chord that conflicts with the active legacy override", async () => {
  let writes = 0;
  const harness = createHarness({ toggleKey: "f9" }, {
    writeHostShortcutConfig: () => {
      writes += 1;
      return { toggle: "f8", returnToMain: "f9" };
    },
  });
  await ready(harness);
  harness.terminal.emitInput("\x1b[B");
  harness.terminal.emitInput("\x1b[B");
  harness.terminal.emitInput(ENTER);
  harness.terminal.emitInput("\x15");
  harness.terminal.emitInput("f8");
  harness.terminal.emitInput("\t");
  harness.terminal.emitInput("\x15");
  harness.terminal.emitInput("f9");
  harness.terminal.emitInput(ENTER);

  assert.equal(writes, 0, "the effective collision is refused before persistence");
  assert.equal(harness.sidebar?.focus, "form", "the validation error keeps the editor open");
  const text = harness.sidebar?.renderForm(80, 24).lines.join(" ").replace(/\x1b\[[0-9;]*m/g, "") ?? "";
  assert.match(text, /different shortcut chords/);
  harness.terminal.emitInput("\x1b");
  assert.equal(harness.sidebar?.focus, "sidebar");
  harness.terminal.emitInput("\x1b[20~"); // legacy F9 remains the active toggle
  assert.equal(harness.sidebar?.visible, false);
  assert.equal(await closeWithSignal(harness), 0);
});

test("Save refuses matcher-overlapping legacy/file pairs before calling persistence", async () => {
  for (const [legacyToggle, returnToMain] of [
    ["ctrl+-", "ctrl+_"],
    ["ctrl+alt+-", "ctrl+alt+_"],
    ["alt+f", "alt+right"],
  ] as const) {
    let writes = 0;
    const harness = createHarness({ toggleKey: legacyToggle }, {
      readHostShortcutConfig: () => ({
        status: "loaded",
        bindings: { toggle: "f8", returnToMain: "f9" },
      }),
      writeHostShortcutConfig: () => {
        writes += 1;
        return { toggle: "f8", returnToMain };
      },
    });
    await ready(harness);
    harness.terminal.emitInput("\x1b[B");
    harness.terminal.emitInput("\x1b[B");
    harness.terminal.emitInput(ENTER);
    harness.terminal.emitInput("\x15");
    harness.terminal.emitInput("f8");
    harness.terminal.emitInput("\t");
    harness.terminal.emitInput("\x15");
    harness.terminal.emitInput(returnToMain);
    harness.terminal.emitInput(ENTER);

    assert.equal(writes, 0, `${legacyToggle} / ${returnToMain} must be rejected before persistence`);
    assert.equal(harness.sidebar?.focus, "form");
    const text = harness.sidebar?.renderForm(80, 24).lines.join(" ").replace(/\x1b\[[0-9;]*m/g, "") ?? "";
    assert.match(text, /different shortcut chords/);
    assert.equal(await closeWithSignal(harness), 0);
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
  assert.deepEqual(harness.terminal.writes.slice(-2), ["\x1b[?1003l", "\x1b[?1000h"],
    "focus change hands tracking to the visible host pane without releasing its cell-SGR mode");

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
  // Two baseline discards, one submitted redraw: the outer resize physically
  // reflowed the screen, and the displayed session's own drawn content and
  // canonical size moved (#474), so positional authority must cross a written
  // boundary before the new geometry authorizes anything.
  assert.equal(harness.writer.invalidateCalls, beforeInvalidations + 2,
    "the resize and the per-session geometry change each discard the writer baseline");
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
  assert.deepEqual(harness.terminal.writes.slice(-4), [
    "\x1b[?1000l", "\x1b[?1006l", "\x1b[?1000h", "\x1b[?1006h",
  ], "external-editor handoff releases and restores only the host-owned mouse modes");
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
    readHostShortcutConfig: () => ({
      status: "absent",
      bindings: { toggle: "alt+left", returnToMain: "alt+right" },
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
  const stopConfirmFrame = harness.writer.frames.at(-1)!.frame;
  const stopConfirmText = plain(stopConfirmFrame);
  assert.ok(stopConfirmText.includes("Stop session?"), `the guarded stop confirmation is drawn: ${stopConfirmText}`);
  assert.ok(stopConfirmText.includes("esc/n = cancel"), "the confirmation exposes its cancel binding before any stop");
  const stopBody = stopConfirmFrame.lines.slice(1).map((line) => line.replace(/\x1b\[[0-9;]*m/g, ""));
  assert.ok(stopBody.map((line) => line.slice(0, 32)).join("\n").includes("Stop session?"),
    "stop/remove confirmation stays in the left pane");
  assert.ok(stopBody.map((line) => line.slice(33)).join("\n").includes("frame:native-1"),
    "stop/remove confirmation does not replace the native right pane");
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

test("visible host panes own clicks while native Main mouse keeps child modes and viewport clipping", async () => {
  const empty = createHarness();
  const emptyManager = await ready(empty);
  assert.ok(empty.terminal.writes.includes("\x1b[?1000h"), "a visible sidebar enables host button reports without a child");
  assert.ok(empty.terminal.writes.includes("\x1b[?1006h"), "host hit testing uses bounded cell-coordinate SGR packets");
  const welcome = empty.writer.frames.at(-1)?.frame;
  const welcomeNew = screenRowContaining(welcome, "New session");
  assert.ok(welcomeNew > 0);
  emitMouse(empty.terminal, 1, 0); // header: host-owned but not an entry
  assert.equal(empty.sidebar?.focus, "sidebar");
  emitX10Mouse(empty.terminal, 1, welcomeNew); // legacy X10 click shares the bounded decoder
  assert.equal(empty.sidebar?.focus, "form", "one click opens the existing New form");
  assert.equal(emptyManager.createOptions.length, 0, "opening New does not submit it");
  assert.equal(await closeWithSignal(empty), 0);
  assert.ok(empty.terminal.writes.includes("\x1b[?1000l"), "shutdown disables the host-owned tracking mode");
  assert.ok(empty.terminal.writes.includes("\x1b[?1006l"), "shutdown disables the host-owned SGR mode");

  const fixture = makeSavedMainFixture("mouse-open");
  const { overrides } = savedFixtureDependencies(fixture);
  try {
    const harness = createHarness({}, overrides);
    const manager = await ready(harness);
    const initialFrame = harness.writer.frames.at(-1)?.frame;
    const newRow = screenRowContaining(initialFrame, "New session");
    emitMouse(harness.terminal, 1, newRow);
    assert.equal(harness.sidebar?.focus, "form", "New action works on the initial visible sidebar");
    completeForm(harness.terminal, fixture.workspace);
    await nextTurn();
    assert.equal(harness.sidebar?.focus, "main", "New completion retains its existing Main activation");
    assert.equal(manager.createOptions.length, 1);

    const rosterFrame = harness.writer.frames.at(-1)?.frame;
    const savedActionRow = screenRowContaining(rosterFrame, "Saved conversations");
    assert.ok(savedActionRow > 0);
    emitMouse(harness.terminal, 1, savedActionRow);
    assert.equal(harness.sidebar?.focus, "form", "Saved action opens the existing picker");
    await nextTurn();
    await nextTurn();
    const savedFrame = harness.writer.frames.at(-1)?.frame;
    const savedRow = screenRowContaining(savedFrame, "First conversation");
    assert.ok(savedRow > 0, "the admitted catalog row was drawn in the right-hand Saved pane");
    emitMouse(harness.terminal, 35, savedRow);
    emitMouse(harness.terminal, 35, savedRow); // duplicate click while the first open is pending
    await nextTurn();
    await nextTurn();
    assert.equal(manager.createOptions.length, 2, "pending-click fencing admits exactly one Saved open");
    assert.ok(isSavedSessionAdmission(manager.createOptions[1]?.savedSession), "the existing exact admission guard remains in force");
    assert.equal(harness.sidebar?.focus, "main", "successful Saved open activates Main without Enter");
    assert.equal(harness.sidebar?.selectedId, "native-2");
    assert.equal(manager.views[0]?.hasLiveProcess, true, "the previously active sibling stays live");

    // A later click uses the same live-catalog duplicate admission fence as
    // Enter; the visible row cannot spawn an already-owned conversation.
    manager.ownedLiveSessionsData = [{ id: fixture.sessionId }];
    harness.terminal.emitInput(ALT_LEFT); // Main -> visible sidebar
    await nextTurn();
    const reopenedRoster = harness.writer.frames.at(-1)?.frame;
    const savedAgain = screenRowContaining(reopenedRoster, "Saved conversations");
    emitMouse(harness.terminal, 1, savedAgain);
    assert.equal(harness.sidebar?.focus, "form", "the reopened Saved roster entry opens its picker");
    await nextTurn();
    await nextTurn();
    const duplicateRow = screenRowContaining(harness.writer.frames.at(-1)?.frame, "First");
    assert.ok(duplicateRow > 0);
    emitMouse(harness.terminal, 35, duplicateRow);
    await nextTurn();
    assert.equal(manager.createOptions.length, 2, "known-owned catalog duplicate starts no child");
    const duplicateFrame = plain(harness.writer.frames.at(-1)?.frame).replace(/\s+/g, " ");
    assert.ok(duplicateFrame.includes("already open in") && duplicateFrame.includes("this host"), duplicateFrame);
    assert.equal(await closeWithSignal(harness), 0);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("a click on the displayed native Main pane returns focus without forwarding the activating click", async () => {
  const harness = createHarness();
  const manager = await startTwoSessions(harness);

  harness.terminal.emitInput("\x1b[A"); // Select A without changing B's active Main ownership.
  harness.terminal.emitInput(ENTER); // Explicitly make A the Main owner.
  const surfaceA = manager.surface("native-1");
  assert.ok(surfaceA);
  surfaceA.modes = { ...surfaceA.modes, mouseTracking: "any", mouseEncoding: "sgr" };
  manager.notify("native-a-mouse-mode");
  harness.terminal.emitInput(ALT_LEFT); // Keep the visible roster open and return its focus.
  harness.terminal.emitInput("\x1b[B"); // Highlight B while A remains the Main owner.
  await nextTurn();

  assert.equal(harness.sidebar?.focus, "sidebar");
  assert.equal(harness.sidebar?.visible, true);
  assert.equal(harness.sidebar?.selectedId, "native-2");
  assert.equal(harness.sidebar?.activeMainOwnerID, "native-1");
  assert.ok(plainLine(harness.writer.frames.at(-1)?.frame, 1).slice(33).startsWith("frame:native-1"),
    "the visible right pane is A's complete native frame");

  const selectedBefore = harness.sidebar?.selectedId;
  const ownerBefore = harness.sidebar?.activeMainOwnerID;
  const visibilityBefore = harness.sidebar?.visible;
  const resizeCountBefore = manager.resizeCalls.length;
  const viewStateBefore = manager.views.map(({ id, lifecycle, hasLiveProcess }) => [id, lifecycle, hasLiveProcess]);
  const writesBeforeClick = manager.writes.length;
  emitMouse(harness.terminal, 33, 1); // Native pane origin: focus only, never a Pi mouse press.
  assert.equal(harness.sidebar?.focus, "main");
  assert.equal(manager.writes.length, writesBeforeClick, "the activating click is consumed before Pi sees it");
  emitMouse(harness.terminal, 33, 1, 0, "m"); // Its matching release is consumed as part of the same click.
  assert.equal(manager.writes.length, writesBeforeClick, "the activating click's release is not replayed to Pi");
  assert.equal(harness.sidebar?.selectedId, selectedBefore, "returning focus does not move the sidebar selection");
  assert.equal(harness.sidebar?.activeMainOwnerID, ownerBefore, "the existing Main owner remains A");
  assert.equal(harness.sidebar?.visible, visibilityBefore, "the sidebar remains visible");
  assert.equal(manager.resizeCalls.length, resizeCountBefore, "focus-only transfer preserves native geometry");
  assert.deepEqual(manager.views.map(({ id, lifecycle, hasLiveProcess }) => [id, lifecycle, hasLiveProcess]), viewStateBefore,
    "neither A nor its live sibling is started, stopped, or otherwise changed");

  harness.terminal.emitInput("typed-after-native-focus");
  assert.deepEqual(manager.writes.slice(writesBeforeClick), [
    { id: "native-1", data: "typed-after-native-focus" },
  ], "subsequent typing is routed only to the unchanged active owner A");

  const writesBeforeFocusedMouse = manager.writes.length;
  emitMouse(harness.terminal, 33, 1); // Once Main is focused, keep the existing native Pi behavior.
  emitMouse(harness.terminal, 33, 1, 0, "m");
  assert.deepEqual(manager.writes.slice(writesBeforeFocusedMouse), [
    { id: "native-1", data: `${ESC}[<0;1;1M` },
    { id: "native-1", data: `${ESC}[<0;1;1m` },
  ], "a later click is translated and delivered unchanged through A's native mouse mode");
  assert.equal(harness.sidebar?.focus, "main");
  assert.equal(harness.sidebar?.selectedId, selectedBefore);
  assert.equal(manager.views[1]?.hasLiveProcess, true, "B remains live and receives no input");

  harness.terminal.emitInput(ALT_LEFT); // Existing keyboard focus control still returns to the roster.
  assert.equal(harness.sidebar?.focus, "sidebar");
  assert.equal(harness.sidebar?.visible, true);
  assert.equal(harness.sidebar?.selectedId, selectedBefore);
  assert.equal(harness.sidebar?.activeMainOwnerID, ownerBefore);
  assert.equal(await closeWithSignal(harness), 0);
});

/** Any host-authored per-copy clipboard status, including the removed #466 notices. */
const HOST_CLIPBOARD_STATUS = /clipboard|paste on client|copied/i;

test("native clipboard routes only the displayed Main owner; success and refusals add no host status", async () => {
  const harness = createHarness({ env: { PATH: process.env.PATH, HOME: "/synthetic-home", TERM: "xterm-ghostty" } });
  try {
    const manager = await startTwoSessions(harness);
    const event: NativeClipboardEvent = { kind: "copy", encoded: Buffer.from("Unicode α\n雪").toString("base64"),
      sessionId: "conversation-native-2", sessionEpoch: 1 };
    const copies = (): string[] => harness.terminal.writes.filter((write) => write.startsWith("\x1b]52;"));
    const assertQuiet = (label: string): void => {
      const frame = plain(harness.writer.frames.at(-1)?.frame);
      assert.doesNotMatch(frame, HOST_CLIPBOARD_STATUS, `${label}: no host clipboard status is rendered`);
      assert.ok(!frame.includes("Terminal diagnostics"), `${label}: no diagnostic is recorded`);
      assert.equal(harness.sidebar?.terminalDiagnosticsWarning, undefined, `${label}: no diagnostic warning`);
    };
    manager.options.onNativeClipboard?.("native-2", event); // roster focus cannot copy
    manager.options.onNativeClipboard?.("native-2", { kind: "unavailable", reason: "unverified-native-origin", sessionId: event.sessionId, sessionEpoch: 1 });
    await nextTurn();
    assert.deepEqual(copies(), []);
    assertQuiet("roster focus");
    harness.terminal.emitInput(ENTER);
    await nextTurn();
    assert.equal(harness.sidebar?.focus, "main");
    const framesBeforeCopy = harness.writer.frames.length;
    manager.options.onNativeClipboard?.("native-2", event);
    assert.deepEqual(copies(), [`\x1b]52;c;${event.encoded}\x07`], "the native producer's exact bytes are submitted once");
    await nextTurn();
    assert.equal(harness.writer.frames.length, framesBeforeCopy, "a successful copy schedules no host status redraw");
    assertQuiet("successful copy");
    manager.options.onNativeClipboard?.("native-1", { ...event, sessionId: "conversation-native-1" });
    manager.options.onNativeClipboard?.("native-1", { kind: "unavailable", reason: "unsupported-runtime", sessionId: "conversation-native-1", sessionEpoch: 1 });
    manager.options.onNativeClipboard?.("native-2", { ...event, sessionEpoch: 2 });
    manager.options.onNativeClipboard?.("native-2", { kind: "unavailable", reason: "unsupported-runtime", sessionId: event.sessionId, sessionEpoch: 2 });
    await nextTurn();
    assert.equal(copies().length, 1, "sibling and stale session cannot copy");
    assertQuiet("sibling and stale refusals");
    harness.terminal.emitInput(ALT_LEFT); // focus roster
    harness.terminal.emitInput(ALT_LEFT); // hide sidebar and return to same Main
    await nextTurn();
    manager.options.onNativeClipboard?.("native-2", event);
    assert.equal(copies().length, 2, "hidden sidebar does not disable visible Main copying");
    assert.equal(copies()[1], `\x1b]52;c;${event.encoded}\x07`);
    harness.terminal.emitInput(ALT_LEFT);
    await nextTurn();
    harness.terminal.emitInput("\x1b[B");
    await nextTurn();
    harness.terminal.emitInput("\x1b[B");
    await nextTurn();
    harness.terminal.emitInput(ENTER);
    await nextTurn();
    assert.equal(harness.sidebar?.focus, "form", plain(harness.writer.frames.at(-1)?.frame));
    manager.options.onNativeClipboard?.("native-2", event);
    manager.options.onNativeClipboard?.("native-2", { kind: "unavailable", reason: "unverified-native-origin", sessionId: event.sessionId, sessionEpoch: 1 });
    await nextTurn();
    assert.equal(copies().length, 2, "host form covers Main and cannot authorize copying");
    assertQuiet("covered by a host form");
  } finally { await closeWithSignal(harness); }
});

test("native clipboard rejects undrawn/changed geometry quietly and logs only actual eligible-owner failures with fixed codes", async (t) => {
  const owned = ownedAgentSetup();
  t.after(() => rmSync(owned.agentDir, { recursive: true, force: true }));
  const output = new QueuedFrameOutput();
  output.refuseNextWrite();
  const harness = createHarness({ env: { PATH: process.env.PATH, HOME: "/synthetic-home", TERM: "xterm-ghostty" } }, {
    ...owned.overrides,
    createWriter: (_stdout, writerOptions) => createSessionHostFrameWriter(output as unknown as Writable, { ...writerOptions, redrawIntervalMs: 0 }),
  });
  harness.agentDir = owned.agentDir;
  const secretText = "controlled clipboard secret";
  const event: NativeClipboardEvent = { kind: "copy", encoded: Buffer.from(secretText).toString("base64"), sessionId: "conversation-native-2", sessionEpoch: 1 };
  const exceptionText = `synthetic output failure at ${owned.agentDir}`;
  try {
    const manager = await startTwoSessions(harness);
    harness.terminal.emitInput(ENTER);
    await nextTurn();
    const count = (): number => harness.terminal.writes.filter((write) => write.startsWith("\x1b]52;")).length;
    const warnings = (): number => harness.sidebar?.terminalDiagnosticsWarning?.count ?? 0;
    manager.options.onNativeClipboard?.("native-2", event);
    manager.options.onNativeClipboard?.("native-2", { kind: "unavailable", reason: "unsupported-runtime", sessionId: event.sessionId, sessionEpoch: 1 });
    await nextTurn();
    assert.equal(count(), 0, "queued frame is not displayed ownership");
    assert.equal(warnings(), 0, "an undisplayed owner is an ordinary quiet refusal");
    output.drain();
    await nextTurn();
    manager.options.onNativeClipboard?.("native-2", event);
    assert.equal(count(), 1);
    await nextTurn();
    assert.equal(warnings(), 0, "a successful copy records no diagnostic");
    output.refuseNextWrite();
    harness.terminal.setSize(90, 24);
    await nextTurn();
    manager.options.onNativeClipboard?.("native-2", event);
    await nextTurn();
    assert.equal(count(), 1, "a resized but undrawn pane cannot authorize a clipboard operation");
    assert.equal(warnings(), 0, "changed geometry is an ordinary quiet refusal");
    output.drain();
    await nextTurn();
    harness.terminal.writeError = new Error(exceptionText);
    manager.options.onNativeClipboard?.("native-2", event);
    assert.equal(count(), 1, "failed write is not successful delivery");
    harness.terminal.writeError = undefined;
    manager.options.onNativeClipboard?.("native-2", { kind: "unavailable", reason: "unsupported-runtime", sessionId: event.sessionId, sessionEpoch: 1 });
    manager.options.onNativeClipboard?.("native-2", { kind: "unavailable", reason: "unverified-native-origin", sessionId: event.sessionId, sessionEpoch: 1 });
    assert.equal(count(), 1, "unavailable runtime or provenance does not emit clipboard bytes");
    // Sibling or stale reports are not the eligible owner's errors.
    manager.options.onNativeClipboard?.("native-1", { kind: "unavailable", reason: "unsupported-runtime", sessionId: "conversation-native-1", sessionEpoch: 1 });
    manager.options.onNativeClipboard?.("native-2", { kind: "unavailable", reason: "unsupported-runtime", sessionId: event.sessionId, sessionEpoch: 2 });
    await nextTurn();
    assert.equal(warnings(), 3, "actual eligible-owner failures enter the existing Terminal diagnostics warning");
    const shown = output.writes.map((bytes) => bytes.toString("utf8")).join("");
    assert.ok(shown.includes("Terminal diagnostics"), "the existing generic diagnostics indicator is drawn");
    assert.doesNotMatch(shown.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, ""), HOST_CLIPBOARD_STATUS, "no per-copy host clipboard status is drawn");
    await waitFor(() => existsSync(diagnosticsLogPath(owned.agentDir))
      && readFileSync(diagnosticsLogPath(owned.agentDir), "utf8").split("\"kind\":\"diagnostic\"").length === 4, "three diagnostic lines");
  } finally {
    harness.signals.emit("SIGTERM");
    output.drain();
    assert.equal(await harness.result, 0);
  }
  const logged = readFileSync(diagnosticsLogPath(owned.agentDir), "utf8");
  for (const forbidden of [secretText, event.encoded, exceptionText, owned.agentDir, "synthetic output failure", "\\u001b]52"]) {
    assert.ok(!logged.includes(forbidden), `persisted diagnostics never include ${JSON.stringify(forbidden)}`);
  }
  const entries = logged.trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
  assert.deepEqual(entries.map((entry) => entry.kind), ["host-run", "diagnostic", "diagnostic", "diagnostic", "host-run-end"]);
  const diagnostics = entries.filter((entry) => entry.kind === "diagnostic");
  assert.deepEqual(diagnostics.map((entry) => [entry.instance, entry.level, entry.category, entry.messageId]), [
    ["native-2", "error", "host-clipboard", "clipboard-terminal-write-failed"],
    ["native-2", "warn", "host-clipboard", "clipboard-unsupported-runtime"],
    ["native-2", "warn", "host-clipboard", "clipboard-provenance-unavailable"],
  ]);
  for (const entry of diagnostics) {
    assert.equal(entry.originatingStack, "not-captured", "no xterm parser cause or stack is fabricated");
    for (const absent of ["stack", "parser", "errorName", "context"]) assert.equal(entry[absent], undefined, `no ${absent}`);
  }
  // TERM is a terminal label, not evidence of OSC 52 capability. Under the same
  // verified Main-owner conditions, a dumb, empty, or absent TERM submits the
  // native copy request exactly once and adds no host status.
  for (const term of ["dumb", "", undefined] as const) {
    const label = term === undefined ? "absent" : term === "" ? "empty" : term;
    const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, HOME: "/synthetic-home" };
    if (term !== undefined) env.TERM = term;
    const variant = createHarness({ env });
    try {
      const manager = await startTwoSessions(variant);
      variant.terminal.emitInput(ENTER);
      await nextTurn();
      assert.equal(variant.sidebar?.focus, "main", `TERM ${label} still verifies the displayed Main owner`);
      const event: NativeClipboardEvent = {
        kind: "copy", encoded: "QQ==", sessionId: "conversation-native-2", sessionEpoch: 1,
      };
      manager.options.onNativeClipboard?.("native-2", event);
      assert.deepEqual(variant.terminal.writes.filter((write) => write.startsWith("\x1b]52;")),
        [`\x1b]52;c;${event.encoded}\x07`], `TERM ${label} submits the native request exactly once`);
      await nextTurn();
      const frame = plain(variant.writer.frames.at(-1)?.frame);
      assert.doesNotMatch(frame, HOST_CLIPBOARD_STATUS, `TERM ${label} adds no host clipboard status`);
      assert.equal(variant.sidebar?.terminalDiagnosticsWarning, undefined, `TERM ${label} records no diagnostic`);
    } finally { await closeWithSignal(variant); }
  }
});

test("native Main click focus requires a written frame for the current owner and geometry", async () => {
  const output = new QueuedFrameOutput();
  output.refuseNextWrite(); // The first frame is not displayed until this sink drains.
  const harness = createHarness({}, {
    createWriter: (_stdout, writerOptions) => createSessionHostFrameWriter(
      output as unknown as Writable,
      { ...writerOptions, redrawIntervalMs: 0 },
    ),
  });
  let shutDown = false;
  try {
    const manager = await startTwoSessions(harness);
    assert.equal(harness.sidebar?.focus, "sidebar");
    assert.equal(output.queuedCount, 1, "the composed host frame is still waiting for output acceptance");
    const writesBeforeUndisplayedClick = manager.writes.length;
    emitMouse(harness.terminal, 33, 1);
    emitMouse(harness.terminal, 33, 1, 0, "m");
    assert.equal(harness.sidebar?.focus, "sidebar", "an undisplayed native pane cannot claim Main focus");
    assert.equal(manager.writes.length, writesBeforeUndisplayedClick, "no click is routed through a speculative frame");

    output.drain();
    for (let attempt = 0; attempt < 10 && !output.writes.some((bytes) => bytes.toString("utf8").includes("Native native-2")); attempt += 1) {
      await nextTurn();
    }
    assert.ok(output.writes.some((bytes) => bytes.toString("utf8").includes("Native native-2")),
      "the real frame writer emitted the current active-owner frame");
    const writesBeforeDisplayedClick = manager.writes.length;
    emitMouse(harness.terminal, 33, 1);
    emitMouse(harness.terminal, 33, 1, 0, "m");
    assert.equal(harness.sidebar?.focus, "main", "the current displayed owner can receive focus");
    assert.equal(manager.writes.length, writesBeforeDisplayedClick, "the accepted activating click is still consumed");

    harness.terminal.emitInput(ALT_LEFT);
    harness.terminal.emitInput("\x1b[A"); // Select A while B remains the owner.
    harness.terminal.emitInput(ENTER); // Make A the active owner.
    harness.terminal.emitInput(ALT_LEFT);
    await nextTurn();
    assert.equal(harness.sidebar?.focus, "sidebar");
    assert.equal(harness.sidebar?.activeMainOwnerID, "native-1");

    output.refuseNextWrite();
    harness.terminal.emitInput("\x1b[B"); // Select B.
    await nextTurn();
    harness.terminal.emitInput(ENTER); // Change the actual Main owner to B while A's frame is still displayed.
    await nextTurn();
    harness.terminal.emitInput(ALT_LEFT); // Keep the sidebar focused while B's new frame remains pending.
    await nextTurn();
    assert.equal(output.queuedCount, 1);
    assert.equal(harness.sidebar?.focus, "sidebar");
    assert.equal(harness.sidebar?.activeMainOwnerID, "native-2");
    const writesBeforeStaleOwnerClick = manager.writes.length;
    emitMouse(harness.terminal, 33, 1);
    emitMouse(harness.terminal, 33, 1, 0, "m");
    assert.equal(harness.sidebar?.focus, "sidebar", "A's still-displayed frame cannot authorize focus for active B");
    assert.equal(manager.writes.length, writesBeforeStaleOwnerClick, "the stale-owner click reaches neither child");

    output.drain();
    await nextTurn();
    const writesBeforeCurrentOwnerClick = manager.writes.length;
    emitMouse(harness.terminal, 33, 1);
    emitMouse(harness.terminal, 33, 1, 0, "m");
    assert.equal(harness.sidebar?.focus, "main", "B can receive focus after its own frame is emitted");
    assert.equal(manager.writes.length, writesBeforeCurrentOwnerClick);

    harness.terminal.emitInput(ALT_LEFT);
    await nextTurn();
    output.refuseNextWrite();
    harness.terminal.setSize(90, 24); // Same native pane origin, but new native geometry is not yet displayed.
    await nextTurn();
    assert.equal(output.queuedCount, 1);
    assert.equal(harness.sidebar?.focus, "sidebar");
    const writesBeforeStaleGeometryClick = manager.writes.length;
    emitMouse(harness.terminal, 33, 1);
    emitMouse(harness.terminal, 33, 1, 0, "m");
    assert.equal(harness.sidebar?.focus, "sidebar", "old displayed geometry cannot authorize the resized pane");
    assert.equal(manager.writes.length, writesBeforeStaleGeometryClick);

    output.drain();
    await nextTurn();
    emitMouse(harness.terminal, 33, 1);
    assert.equal(harness.sidebar?.focus, "main", "the resized pane becomes eligible only after its frame is emitted");
    emitMouse(harness.terminal, 33, 1, 0, "m");
    assert.equal(await closeWithSignal(harness), 0);
    shutDown = true;
  } finally {
    if (!shutDown) {
      harness.signals.emit("SIGTERM");
      if (output.queuedCount > 0) output.drain();
      await harness.result.catch(() => undefined);
    }
  }
});

test("Main paints only the actual live Ghostty owner and cleans scoped graphics across sidebar, form, resize, and overlay changes", async () => {
  const env = {
    PATH: process.env.PATH,
    HOME: "/synthetic-home",
    TERM_PROGRAM: "ghostty",
    TERM: "xterm-ghostty",
  };
  let harness!: Harness;
  harness = createHarness({ env }, {
    createSessionSetup: () => ({
      nativeSetup: true,
      nativeAgentDir: harness.agentDir,
      profileRegistry: { prepare: () => { throw new Error("the fake Main manager never prepares a profile"); } },
    }),
    createWriter: (output, writerOptions) => createSessionHostFrameWriter(
      output as unknown as Writable,
      { ...writerOptions, redrawIntervalMs: 0 },
    ),
  });
  let shutDown = false;
  try {
    const manager = await startTwoSessions(harness);
    const imageA = graphicsPngBase64(41);
    const imageB = graphicsPngBase64(173);
    const surfaceA = manager.surface("native-1");
    const surfaceB = manager.surface("native-2");
    assert.ok(surfaceA && surfaceB);
    surfaceA.graphics = fakeGraphicsFrame(imageA);
    surfaceB.graphics = fakeGraphicsFrame(imageB);
    const beforeFirstGraphics = harness.stdout.writes.length;
    manager.notify("typed-graphics");
    await nextTurn();
    const firstGraphics = harness.stdout.writes.slice(beforeFirstGraphics).join("");
    assert.ok(firstGraphics.includes(`;${imageB}\x1b\\`), "active native-2's typed image is generated to the outer terminal");
    assert.equal(firstGraphics.includes(`;${imageA}\x1b\\`), false, "inactive native-1's same-numbered child image is not exposed");
    assert.match(firstGraphics, /\x1b_Ga=t,f=100,q=2,i=1;/, "the host assigns its own image id");
    assert.ok(firstGraphics.includes("\x1b[3;36H"), "the image placement is offset into the actual native pane");

    const beforeSelection = harness.stdout.writes.length;
    harness.terminal.emitInput("\x1b[A"); // Highlight A without changing the actual Main owner.
    await nextTurn();
    const selectionOnly = harness.stdout.writes.slice(beforeSelection).join("");
    assert.equal(selectionOnly.includes("\x1b_Ga=t"), false, "sidebar selection alone never retargets images");
    assert.equal(selectionOnly.includes("\x1b_Ga=d"), false, "the visible active owner's graphics remain in place");
    assert.equal(harness.sidebar?.activeMainOwnerID, "native-2");

    const beforeOwnerSwitch = harness.stdout.writes.length;
    harness.terminal.emitInput(ENTER); // Activate A, whose child deliberately reuses Kitty image id 7.
    await nextTurn();
    const ownerSwitch = harness.stdout.writes.slice(beforeOwnerSwitch).join("");
    const deleteOldImage = ownerSwitch.indexOf("\x1b_Ga=d,d=I,i=1,q=2\x1b\\");
    const uploadNewImage = ownerSwitch.indexOf("\x1b_Ga=t,f=100,q=2,i=2;");
    assert.ok(deleteOldImage >= 0 && uploadNewImage > deleteOldImage, "B's writer-owned image is deleted before A's namespaced generation is uploaded");
    assert.ok(ownerSwitch.includes(`;${imageA}\x1b\\`));
    assert.equal(ownerSwitch.includes(`;${imageB}\x1b\\`), false);

    harness.terminal.emitInput(ALT_LEFT); // Focus the wide roster while A remains the owner.
    harness.terminal.emitInput("\x1b[B");
    harness.terminal.emitInput("\x1b[B");
    harness.terminal.emitInput("\x1b[B"); // New session.
    harness.terminal.emitInput(ENTER);
    await nextTurn();
    assert.equal(harness.sidebar?.focus, "form");
    const formOutput = harness.stdout.writes.slice(beforeOwnerSwitch + 1).join("");
    assert.ok(formOutput.includes("\x1b_Ga=d,d=I,i=2,q=2\x1b\\"), "the form clears only A's owned image before replacing the native pane");
    assert.equal(formOutput.includes("\x1b_Ga=d,d=a"), false, "no terminal-global deletion is emitted");

    const beforeRestore = harness.stdout.writes.length;
    harness.terminal.emitInput("\x1b"); // Cancel the form: the wide roster already exposes the same Main owner.
    await nextTurn();
    const restored = harness.stdout.writes.slice(beforeRestore).join("");
    assert.ok(restored.includes("\x1b_Ga=t,f=100,q=2,i=3;"), "restoring the released image uploads a later writer-owned generation");
    assert.ok(restored.includes(`;${imageA}\x1b\\`), "the restored payload still belongs to actual owner A");
    assert.equal(restored.includes(`;${imageB}\x1b\\`), false, "restoration never exposes the inactive owner's payload");
    const restoredPlacement = /\x1b_Ga=p,q=2,C=1,i=3,p=(\d+),/.exec(restored);
    assert.ok(restoredPlacement, "restoration places the new generation using a writer-owned placement ID");
    const placementID = restoredPlacement[1]!;

    const beforeFocus = harness.stdout.writes.length;
    harness.terminal.emitInput(ALT_LEFT);
    await nextTurn();
    const focusOnly = harness.stdout.writes.slice(beforeFocus).join("");
    assert.equal(focusOnly.includes("\x1b_Ga=t"), false, "focusing the already-visible owner does not retransmit PNG bytes");
    assert.equal(focusOnly.includes("\x1b_Ga=d,d=I"), false, "focus alone does not discard resident image data");

    const beforeResize = harness.stdout.writes.length;
    harness.terminal.setSize(90, 24);
    await nextTurn();
    const resizeOutput = harness.stdout.writes.slice(beforeResize).join("");
    const deletePlacement = resizeOutput.indexOf(`\x1b_Ga=d,d=i,i=3,p=${placementID},q=2\x1b\\`);
    const replacePlacement = resizeOutput.indexOf(`\x1b_Ga=p,q=2,C=1,i=3,p=${placementID},`);
    assert.ok(deletePlacement >= 0 && replacePlacement > deletePlacement, "resize cleans the exact owned placement before repainting its geometry");
    assert.equal(resizeOutput.includes("\x1b_Ga=d,d=I"), false, "same-owner resize retains the resident PNG");
    assert.equal(resizeOutput.includes("\x1b_Ga=t"), false, "same-owner resize does not retransmit image data");

    harness.terminal.emitInput(ALT_LEFT); // Wide roster focus still shows the native pane.
    await nextTurn();
    const beforeOverlay = harness.stdout.writes.length;
    harness.terminal.setSize(52, 24); // Sidebar becomes a narrow overlay over the native pane.
    await nextTurn();
    const overlayOutput = harness.stdout.writes.slice(beforeOverlay).join("");
    assert.ok(overlayOutput.includes("\x1b_Ga=d,d=I,i=3,q=2\x1b\\"), "narrow overlay visibility change removes the previous native image");
    assert.equal(overlayOutput.includes("\x1b_Ga=t"), false, "covered native graphics are not painted over the overlay");
    assert.equal(await closeWithSignal(harness), 0);
    shutDown = true;
  } finally {
    if (!shutDown) {
      harness.signals.emit("SIGTERM");
      await harness.result.catch(() => undefined);
    }
  }
});

test("real writer settles identical Main and too-small roster frames before native click focus", async () => {
  const output = new QueuedFrameOutput();
  const submissions: Array<{ frame: ComposedHostFrame; disposition?: SessionHostFrameDisposition }> = [];
  const harness = createHarness({}, {
    createWriter: (_stdout, writerOptions) => {
      const realWriter = createSessionHostFrameWriter(
        output as unknown as Writable,
        { ...writerOptions, redrawIntervalMs: 0 },
      );
      return {
        start: () => realWriter.start(),
        submit: (frame, cols, rows, onSettled) => {
          const submission: { frame: ComposedHostFrame; disposition?: SessionHostFrameDisposition } = { frame };
          submissions.push(submission);
          realWriter.submit(frame, cols, rows, (disposition) => {
            submission.disposition = disposition;
            onSettled?.(disposition);
          });
        },
        invalidate: () => realWriter.invalidate(),
        close: () => realWriter.close(),
      };
    },
  });
  let shutDown = false;
  try {
    const manager = await ready(harness);
    fillForm(harness.terminal, "/tiny-native-pane/workspace");
    await nextTurn();
    assert.equal(harness.sidebar?.focus, "main");
    const owner = harness.sidebar?.activeMainOwnerID;
    assert.equal(owner, "native-1");
    assert.ok(owner);
    const surface = manager.surface(owner);
    assert.ok(surface);
    surface.cursorVisible = false;

    harness.terminal.setSize(80, 2);
    await nextTurn();
    const mainSubmission = submissions.at(-1);
    assert.ok(mainSubmission);
    assert.equal(mainSubmission.disposition, "written");
    assert.equal(mainSubmission.frame.cursor.visible, false, "the native cursor is hidden");
    assert.ok(plain(mainSubmission.frame).includes("pane 32x1 too small"), "the one-row roster uses its too-small fallback");

    const ownerBefore = harness.sidebar?.activeMainOwnerID;
    const selectionBefore = harness.sidebar?.selectedId;
    const writesBeforeFocus = output.writes.length;
    harness.terminal.emitInput(ALT_LEFT); // Main -> roster; the composed bytes and hidden cursor are unchanged.
    await nextTurn();
    assert.equal(harness.sidebar?.focus, "sidebar");
    const rosterSubmission = submissions.at(-1);
    assert.ok(rosterSubmission);
    assert.deepEqual(rosterSubmission.frame, mainSubmission.frame, "focus changes without changing the composed frame");
    assert.equal(rosterSubmission.disposition, "written", "authorization changes still cross the real writer boundary");
    assert.ok(output.writes.length > writesBeforeFocus, "the invalidated byte-identical frame is emitted");

    const writesBeforeClick = manager.writes.length;
    emitMouse(harness.terminal, 33, 1);
    assert.equal(harness.sidebar?.focus, "main");
    assert.equal(manager.writes.length, writesBeforeClick, "the activating press is consumed");
    emitMouse(harness.terminal, 33, 1, 0, "m");
    assert.equal(manager.writes.length, writesBeforeClick, "the matching release is consumed");
    assert.equal(harness.sidebar?.activeMainOwnerID, ownerBefore);
    assert.equal(harness.sidebar?.selectedId, selectionBefore);

    harness.terminal.emitInput("typing-after-identical-focus-frame");
    assert.deepEqual(manager.writes.slice(writesBeforeClick), [
      { id: "native-1", data: "typing-after-identical-focus-frame" },
    ], "subsequent typing reaches the unchanged Main owner");
    assert.equal(await closeWithSignal(harness), 0);
    shutDown = true;
  } finally {
    if (!shutDown) {
      harness.signals.emit("SIGTERM");
      if (output.queuedCount > 0) output.drain();
      await harness.result.catch(() => undefined);
    }
  }
});

test("native Main focus clicks stay unavailable without an owner and on host-owned surfaces", async () => {
  const empty = createHarness();
  await ready(empty);
  emitMouse(empty.terminal, 33, 1);
  assert.equal(empty.sidebar?.focus, "sidebar", "the welcome pane is not an active native Main owner");
  assert.equal(await closeWithSignal(empty), 0);

  const harness = createHarness();
  const manager = await ready(harness);
  fillForm(harness.terminal, "/native-click-guard/workspace");
  await nextTurn();
  assert.equal(harness.sidebar?.focus, "main");
  const owner = harness.sidebar?.activeMainOwnerID;
  assert.equal(owner, "native-1");

  harness.terminal.emitInput(ALT_LEFT);
  harness.terminal.emitInput("\x1b[B"); // Saved conversations.
  harness.terminal.emitInput("\x1b[B"); // New session.
  harness.terminal.emitInput(ENTER);
  await nextTurn();
  assert.equal(harness.sidebar?.focus, "form");
  const writesBeforeFormClick = manager.writes.length;
  emitMouse(harness.terminal, 33, 1); // The right pane belongs to the New form, not native Main.
  emitMouse(harness.terminal, 33, 1, 0, "m");
  assert.equal(harness.sidebar?.focus, "form");
  assert.equal(manager.writes.length, writesBeforeFormClick, "form clicks remain host-owned");

  harness.terminal.emitInput(ESC); // Cancel the form to the roster.
  harness.terminal.emitInput("q"); // Open the existing Quit confirmation.
  await nextTurn();
  assert.equal(harness.sidebar?.focus, "confirm");
  const writesBeforeConfirmClick = manager.writes.length;
  emitMouse(harness.terminal, 33, 1); // Main is visible, but the confirmation owns keyboard focus.
  emitMouse(harness.terminal, 33, 1, 0, "m");
  assert.equal(harness.sidebar?.focus, "confirm", "a confirmation is not a native Main click-focus surface");
  assert.equal(manager.writes.length, writesBeforeConfirmClick, "confirmation-owned clicks do not reach Pi");

  harness.terminal.emitInput("n"); // Return to the roster without quitting.
  assert.equal(harness.sidebar?.focus, "sidebar");
  harness.terminal.setSize(52, 24); // Narrow layout overlays the native geometry with the sidebar.
  await nextTurn();
  const selectedBeforeOverlayClick = harness.sidebar?.selectedId;
  const writesBeforeOverlayClick = manager.writes.length;
  emitMouse(harness.terminal, 33, 22); // Blank lower overlay row, not a roster card.
  emitMouse(harness.terminal, 33, 22, 0, "m");
  assert.equal(harness.sidebar?.focus, "sidebar", "an overlay-covered coordinate cannot focus hidden native Main");
  assert.equal(harness.sidebar?.selectedId, selectedBeforeOverlayClick);
  assert.equal(harness.sidebar?.activeMainOwnerID, owner);
  assert.equal(manager.writes.length, writesBeforeOverlayClick, "overlay clicks remain host-owned");
  assert.equal(await closeWithSignal(harness), 0);
});

test("visible roster mouse activates a clicked live owner; host gestures stay fenced and native Main gestures remain routed", async () => {
  const harness = createHarness();
  const manager = await startTwoSessions(harness);
  await nextTurn();
  const surfaceA = manager.surface("native-1");
  assert.ok(surfaceA);
  surfaceA.modes = { ...surfaceA.modes, mouseTracking: "drag", mouseEncoding: "sgr" };
  manager.notify("native-a-mouse-mode");
  await nextTurn();
  const initialFrame = harness.writer.frames.at(-1)?.frame;
  const aRow = screenRowContaining(initialFrame, "Native native-1");
  const bRow = screenRowContaining(initialFrame, "Native native-2");
  assert.ok(aRow > 0 && bRow > aRow, "both live rows were drawn in roster order");
  const initialFocus = harness.sidebar?.focus;
  for (const button of [2, 4]) {
    emitMouse(harness.terminal, 1, aRow, button, "M");
    assert.equal(harness.sidebar?.focus, initialFocus, "right/modified presses never activate an entry");
    emitMouse(harness.terminal, 1, aRow, button, "m");
  }
  for (const [button, final] of [[0, "m"], [32, "M"], [64, "M"]] as const) {
    emitMouse(harness.terminal, 1, aRow, button, final);
    assert.equal(harness.sidebar?.focus, initialFocus, "release/motion/wheel never activate an entry");
  }
  emitMouse(harness.terminal, 1, 0); // header is host-owned and inert
  assert.equal(harness.sidebar?.focus, initialFocus);

  emitMouse(harness.terminal, 1, aRow);
  assert.equal(harness.sidebar?.focus, "main");
  assert.equal(harness.sidebar?.selectedId, "native-1", "the clicked A row becomes Main owner");
  assert.equal(manager.views[1]?.hasLiveProcess, true, "B remains live after A activation");
  // The newly activated owner must be drawn before its cells carry positional
  // authority (#474): the host renders and writes the owner's frame first, then
  // native gestures in that pane are translated.
  await nextTurn();
  const beforeNativeWhileHostHeld = manager.writes.length;
  emitMouse(harness.terminal, 33, 1, 1); // independent native middle-button press
  emitMouse(harness.terminal, 34, 2, 33); // its motion remains native while host-left is held
  emitMouse(harness.terminal, 34, 2, 1, "m");
  assert.deepEqual(manager.writes.slice(beforeNativeWhileHostHeld).map(({ id, data }) => [id, data]), [
    ["native-1", "\x1b[<1;1;1M"],
    ["native-1", "\x1b[<33;2;2M"],
    ["native-1", "\x1b[<1;2;2m"],
  ], "independently started native buttons are not hidden by the host-left fence");
  const beforeHostDrag = manager.writes.length;
  emitMouse(harness.terminal, 33, 1, 32); // host press followed by Main-pane drag motion
  emitMouse(harness.terminal, 34, 2, 0, "m"); // release also lands over Main
  assert.equal(manager.writes.length, beforeHostDrag, "host-originated motion and release never leak to A");
  harness.terminal.emitInput("a-input");
  assert.equal(manager.writes.at(-1)?.id, "native-1");

  harness.terminal.emitInput(ALT_LEFT); // Main -> visible sidebar
  await nextTurn();
  const bVisibleRow = screenRowContaining(harness.writer.frames.at(-1)?.frame, "Native native-2");
  assert.ok(bVisibleRow > 0);
  emitMouse(harness.terminal, 1, bVisibleRow);
  assert.equal(harness.sidebar?.focus, "main");
  assert.equal(harness.sidebar?.selectedId, "native-2", "one click activates B");
  emitMouse(harness.terminal, 1, bVisibleRow, 0, "m"); // finish the host-owned click
  const surface = manager.surface("native-2");
  assert.ok(surface);
  surface.modes = { ...surface.modes, mouseTracking: "any", mouseEncoding: "sgr" };
  manager.notify("native-mouse-mode");
  // The newly activated owner is drawn before its cells carry positional authority (#474).
  await nextTurn();
  const beforeNativeGesture = manager.writes.length;
  emitMouse(harness.terminal, 33, 1); // native press: local (0,0)
  emitMouse(harness.terminal, 34, 2, 32); // native drag motion: local (1,1)
  emitMouse(harness.terminal, 34, 2, 0, "m"); // native release
  assert.deepEqual(manager.writes.slice(beforeNativeGesture).map(({ id, data }) => [id, data]), [
    ["native-2", "\x1b[<0;1;1M"],
    ["native-2", "\x1b[<32;2;2M"],
    ["native-2", "\x1b[<0;2;2m"],
  ], "independently started Main gestures preserve press/motion/release routing");
  harness.terminal.emitInput("b-input");
  assert.equal(manager.writes.at(-1)?.id, "native-2", "subsequent input follows B");
  assert.equal(manager.views[0]?.hasLiveProcess, true, "A stays live beside the new owner");
  assert.equal(await closeWithSignal(harness), 0);
});

test("clicking an exited row from Main transfers only the recovery intent and activates its ready replacement", async () => {
  const fixture = makeSavedMainFixture("mouse-resume");
  const { overrides } = savedFixtureDependencies(fixture);
  try {
    const harness = createHarness({}, overrides);
    const manager = await startTwoSessions(harness);
    await nextTurn();

    const firstRow = screenRowContaining(harness.writer.frames.at(-1)?.frame, "Native native-1");
    emitMouse(harness.terminal, 1, firstRow);
    assert.equal(harness.sidebar?.focus, "main");
    assert.equal(harness.sidebar?.selectedId, "native-1", "A owns Main before B exits");
    emitMouse(harness.terminal, 1, firstRow, 0, "m");

    const bIndex = manager.views.findIndex((view) => view.id === "native-2");
    const b = manager.views[bIndex];
    assert.ok(b);
    manager.views[bIndex] = {
      ...b,
      lifecycle: "exited",
      hasLiveProcess: false,
      nativeSession: null,
      lastNativeSession: {
        sessionId: "conversation-native-2",
        epoch: 1,
        name: "Native native-2",
        persistence: "unsaved",
      },
    };
    manager.notify("native-2-exited");
    await nextTurn();
    const exitedRow = screenRowContaining(harness.writer.frames.at(-1)?.frame, "Native native-2");
    assert.ok(exitedRow > 0);
    emitMouse(harness.terminal, 1, exitedRow);
    assert.equal(harness.sidebar?.focus, "sidebar", "the exited-row restart is a sidebar-owned intent");
    assert.equal(harness.sidebar?.selectedId, "native-2");

    for (let attempt = 0; attempt < 10 && harness.sidebar?.focus !== "main"; attempt += 1) {
      await nextTurn();
    }
    assert.equal(harness.sidebar?.focus, "main", "a ready replacement returns focus to Main");
    assert.equal(harness.sidebar?.selectedId, "native-3");
    assert.deepEqual(manager.views.map((view) => view.id), ["native-1", "native-3"]);
    assert.equal(manager.views[0]?.hasLiveProcess, true, "A remains live while B is replaced");
    assert.equal(manager.views[1]?.hasLiveProcess, true);
    harness.terminal.emitInput("replacement-input");
    assert.equal(manager.writes.at(-1)?.id, "native-3", "subsequent Main input belongs to the replacement");
    assert.equal(await closeWithSignal(harness), 0);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("wide equal-sized panes dispatch Saved hit tests only in the right form", async () => {
  const fixture = makeSavedMainFixture("mouse-pane-identity");
  const { overrides } = savedFixtureDependencies(fixture);
  const plainRow = (frame: ComposedHostFrame | undefined, row: number): string =>
    plainLine(frame, row).slice(0, 32);
  const leftRow = (frame: ComposedHostFrame | undefined, text: string): number =>
    frame?.lines.findIndex((line, row) => row >= 1
      && line.replace(/\x1b\[[0-9;]*m/g, "").slice(0, 32).includes(text)) ?? -1;
  const rightRow = (frame: ComposedHostFrame | undefined, text: string): number =>
    frame?.lines.findIndex((line, row) => row >= 1
      && line.replace(/\x1b\[[0-9;]*m/g, "").slice(33).includes(text)) ?? -1;
  const rightText = (frame: ComposedHostFrame | undefined): string =>
    (frame?.lines.slice(1) ?? []).map((line) => line.replace(/\x1b\[[0-9;]*m/g, "").slice(33)).join("\n");
  try {
    const harness = createHarness({}, overrides);
    harness.terminal.columns = 65; // sidebar and Saved form are both exactly 32 columns
    harness.stdout.columns = 65;
    const manager = await ready(harness);
    const initial = harness.writer.frames.at(-1)?.frame;
    const savedAction = screenRowContaining(initial, "Saved conversations");
    emitMouse(harness.terminal, 1, savedAction);
    emitMouse(harness.terminal, 1, savedAction, 0, "m");
    await nextTurn();
    await nextTurn();
    assert.equal(harness.sidebar?.focus, "form");
    const savedFrame = harness.writer.frames.at(-1)?.frame;
    const savedRow = rightRow(savedFrame, "First");
    assert.ok(savedRow > 0, rightText(savedFrame));
    assert.equal(manager.createOptions.length, 0);
    const sharedLeftRow = plainRow(savedFrame, savedRow).trim();
    assert.ok(sharedLeftRow.includes("New session"),
      `the first Saved result must share its row with another left roster entry: ${JSON.stringify(sharedLeftRow)}`);

    // The left New row shares the first Saved result's local row. Pane
    // identity must still prevent it from hitting the right-hand Saved row's
    // hit region, and the click performs the LEFT row's own ordinary action:
    // it cancels the open Saved picker first (#486), admits nothing, and then
    // opens New exactly once.
    emitMouse(harness.terminal, 1, savedRow);
    emitMouse(harness.terminal, 1, savedRow, 0, "m");
    for (let attempt = 0; attempt < 10; attempt += 1) {
      await nextTurn();
      if (rightText(harness.writer.frames.at(-1)?.frame).includes("Workspace")) break;
    }
    await nextTurn(); // the cancelling frame settles before the next host click
    assert.equal(manager.createOptions.length, 0, "left-pane rows cannot hit Saved rows in the right form");
    assert.equal(harness.sidebar?.savedPickerRequestId, undefined,
      "the left click cancelled the picker instead of activating the shared right-hand row");
    assert.equal(harness.sidebar?.focus, "form", "the clicked left row opened its own ordinary form");
    const cancelled = harness.writer.frames.at(-1)?.frame;
    assert.ok(rightText(cancelled).includes("Workspace"), rightText(cancelled));
    assert.equal(rightRow(cancelled, "Saved conversations"), -1,
      "no hidden Saved picker survives in the right-hand pane");

    // Reopen Saved from the newly written roster, await its listing, then
    // click the actual right-hand Saved result at its own current row.
    const reopenRow = leftRow(cancelled, "Saved conversations");
    assert.ok(reopenRow > 0, JSON.stringify(cancelled?.lines.map((line) => line.replace(/\x1b\[[0-9;]*m/g, "")) ?? []));
    emitMouse(harness.terminal, 1, reopenRow);
    emitMouse(harness.terminal, 1, reopenRow, 0, "m");
    for (let attempt = 0; attempt < 10; attempt += 1) {
      await nextTurn();
      if (rightText(harness.writer.frames.at(-1)?.frame).includes("First")) break;
    }
    await nextTurn();
    const reopened = harness.writer.frames.at(-1)?.frame;
    assert.equal(harness.sidebar?.focus, "form");
    assert.ok(rightText(reopened).includes("Saved conversations"), rightText(reopened));
    const reopenedSavedRow = rightRow(reopened, "First");
    assert.ok(reopenedSavedRow > 0, rightText(reopened));

    emitMouse(harness.terminal, 34, reopenedSavedRow); // the actual right-hand Saved row
    emitMouse(harness.terminal, 34, reopenedSavedRow, 0, "m");
    await nextTurn();
    await nextTurn();
    assert.equal(manager.createOptions.length, 1);
    assert.ok(isSavedSessionAdmission(manager.createOptions[0]?.savedSession));
    assert.equal(harness.sidebar?.focus, "main");
    assert.equal(harness.sidebar?.selectedId, "native-1");
    assert.equal(await closeWithSignal(harness), 0);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

for (const identicalCaptions of [false, true]) for (const acceptedWhileQueued of [false, true]) for (const returnToOriginal of [false, true]) test(
  `real frame-writer preserves Saved clickability across a pending target change (identical captions: ${identicalCaptions}, accepted while queued: ${acceptedWhileQueued}, return to original: ${returnToOriginal})`,
  async () => {
  const fixture = makeSavedMainFixture("mouse-frame-boundary");
  const secondFile = join(fixture.agentDir, "sessions", "proj", "scroll-second.jsonl");
  writeFileSync(secondFile, [
    JSON.stringify({ type: "session", version: 3, id: "saved-scroll-second", timestamp: "2025-02-01T00:00:00.000Z", cwd: fixture.workspace }),
    JSON.stringify({ type: "message", id: "m2", message: { role: "user", content: [{ type: "text", text: identicalCaptions ? "First conversation mouse-frame-boundary" : "Second conversation mouse-frame-boundary" }] } }),
  ].join("\n") + "\n", "utf8");
  let catalog: SavedSessionCatalog | undefined;
  const { overrides } = savedFixtureDependencies(fixture, async (options) => {
    catalog = await listSavedSessions({
      agentDir: options.agentDir,
      listAll: makeSavedListAll(),
      signal: options.signal,
    });
    return catalog;
  });
  const output = new QueuedFrameOutput();
  let harnessForCleanup: Harness | undefined;
  let shutDown = false;
  try {
    const harness = createHarness({}, {
      ...overrides,
      createWriter: (_stdout, writerOptions) => createSessionHostFrameWriter(
        output as unknown as Writable,
        { ...writerOptions, redrawIntervalMs: 0 },
      ),
    });
    harnessForCleanup = harness;
    harness.terminal.rows = 10; // one Saved list row: scrolling replaces its hit target at the same coordinate
    harness.stdout.rows = 10;
    const manager = await ready(harness);
    openSavedPicker(harness.terminal);
    for (let attempt = 0; attempt < 10 && catalog?.rows.length !== 2; attempt += 1) await nextTurn();
    assert.ok(catalog);
    assert.equal(catalog.rows.length, 2, "the catalog has the initially displayed row and its scroll replacement");
    const savedA = catalog.rows[0]!;
    const savedB = catalog.rows[1]!;
    if (identicalCaptions) {
      assert.equal(savedA.caption, savedB.caption);
      assert.equal(savedA.cwd, savedB.cwd);
    }
    for (let attempt = 0; attempt < 10 && !output.writes.some((bytes) => bytes.toString("utf8").includes(savedA.caption)); attempt += 1) {
      await nextTurn();
    }
    assert.ok(output.writes.some((bytes) => bytes.toString("utf8").includes(savedA.caption)),
      "the actual frame writer has emitted the first Saved row");
    const emittedA = await emittedTerminalFrame(output, harness.terminal.columns, harness.terminal.rows);
    const emittedARight = emittedA.lines.slice(1).map((line) => line.replace(/\x1b\[[0-9;]*m/g, "").slice(33)).join("\n");
    assert.ok(emittedARight.includes("Saved conversations") && emittedARight.includes(savedA.caption),
      "the emitted Saved picker and selected row occupy the right/main pane");

    output.refuseNextWrite(acceptedWhileQueued);
    harness.terminal.emitInput("\x1b[B"); // Scroll the one-row window from A to B.
    await nextTurn();
    assert.equal(output.queuedCount, 1, "the real frame writer submitted B to a delayed Writable");
    const coalescedCandidate = await emittedTerminalFrame(output, harness.terminal.columns, harness.terminal.rows, true);
    const candidateRight = coalescedCandidate.lines.slice(1)
      .map((line) => line.replace(/\x1b\[[0-9;]*m/g, "").slice(33)).join("\n");
    assert.ok(candidateRight.includes("Saved conversations") && candidateRight.includes(savedB.caption),
      "the coalesced candidate is still a right-pane Saved picker, not a left-only render");

    // A is still the only row on the sink's emitted surface. Even though Main's
    // render has already built B's newer mutable hit map, the pending map must
    // not authorize the same coordinate as B, even when write() returned true.
    // The native query field shifts the first result down one screen row.
    emitMouse(harness.terminal, 34, 3);
    assert.equal(manager.createOptions.length, 0, "a click before callback completion cannot open undisplayed B");
    emitMouse(harness.terminal, 34, 3, 0, "m");

    if (returnToOriginal) {
      harness.terminal.emitInput("\x1b[A"); // Return from B to A while B's write is still pending.
      await nextTurn();
      assert.equal(output.queuedCount, 1, "the pending A frame stays behind the incomplete B write");
    }

    output.completeQueuedWrites();
    if (!acceptedWhileQueued) {
      assert.equal(manager.createOptions.length, 0,
        "a successful callback alone cannot settle a write() that returned false");
      output.emit("drain");
    }
    emitMouse(harness.terminal, 34, 3);
    for (let attempt = 0; attempt < 10 && manager.createOptions.length === 0; attempt += 1) await nextTurn();
    assert.equal(manager.createOptions.length, 1,
      "the final emitted Saved row is clickable after its callback and any required drain settle the frame");
    const admission = manager.createOptions[0]?.savedSession;
    assert.ok(isSavedSessionAdmission(admission));
    assert.equal((admission as { sessionId: string }).sessionId, returnToOriginal ? savedA.id : savedB.id,
      "the same coordinate opens the row actually emitted by the frame writer");
    assert.notEqual(savedA.id, savedB.id);
    assert.equal(await closeWithSignal(harness), 0);
    shutDown = true;
  } finally {
    if (harnessForCleanup && !shutDown) {
      harnessForCleanup.signals.emit("SIGTERM");
      if (output.queuedCount > 0) output.drain();
      await harnessForCleanup.result.catch(() => undefined);
    }
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("real frame-writer backpressure cannot redirect the Main owner through a scrolled roster row", async () => {
  const output = new QueuedFrameOutput();
  const submittedFrames: Array<{ readonly frame: ComposedHostFrame; readonly cols: number; readonly rows: number }> = [];
  const harness = createHarness({}, {
    createWriter: (_stdout, writerOptions) => {
      const driver = createSessionHostFrameWriter(output as unknown as Writable, {
        ...writerOptions,
        redrawIntervalMs: 0,
      });
      return {
        start: () => driver.start(),
        submit: (frame, cols, rows, onSettled) => {
          submittedFrames.push({ frame, cols, rows });
          driver.submit(frame, cols, rows, onSettled);
        },
        invalidate: () => driver.invalidate(),
        close: () => driver.close(),
      };
    },
  });
  let shutDown = false;
  try {
    harness.terminal.rows = 14; // sidebar viewport fits one expanded card, so Down scrolls B into A's row
    harness.stdout.rows = 14;
    const manager = await startTwoSessions(harness);
    harness.terminal.emitInput("\x1b[A"); // Select A while leaving B as the active Main owner.
    await nextTurn();
    let oldFrame = submittedFrames.at(-1)?.frame;
    let rowA = screenRowContaining(oldFrame, "Native native-1");
    assert.ok(rowA > 0, "the emitted roster has A at the coordinate that will be reused");

    const viewIndex = manager.views.findIndex((view) => view.id === "native-1");
    assert.ok(viewIndex >= 0);
    const activeTasksBeforeMetadata = manager.views[viewIndex]!.activeTasks;
    const writesBeforeUnchangedFrame = output.writes.length;
    manager.views[viewIndex] = { ...manager.views[viewIndex]!, backgroundTasks: 3 };
    assert.equal(manager.views[viewIndex]!.activeTasks, activeTasksBeforeMetadata,
      "the activity-intent count stays unchanged while ownership metadata updates");
    manager.notify("background-task-metadata-only");
    await nextTurn();
    assert.equal(output.writes.length, writesBeforeUnchangedFrame,
      "background ownership metadata changes without changing the rendered frame bytes");
    emitMouse(harness.terminal, 1, rowA); // An unchanged submission must not permanently disable clicks.
    emitMouse(harness.terminal, 1, rowA, 0, "m");
    assert.equal(harness.sidebar?.selectedId, "native-1",
      "the prior emitted hit map remains usable after an identical frame is skipped");
    assert.equal(harness.sidebar?.focus, "main", "clicking A activates it using the last emitted map");
    await nextTurn();
    harness.terminal.emitInput(ALT_LEFT); // Return to the visible roster without changing Main ownership.
    await nextTurn();
    oldFrame = submittedFrames.at(-1)?.frame;
    rowA = screenRowContaining(oldFrame, "Native native-1");
    assert.ok(rowA > 0, "A is still the displayed roster row before the scroll");

    output.refuseNextWrite();
    harness.terminal.emitInput("\x1b[B"); // Select/scroll B into A's previous row while A remains Main owner.
    await nextTurn();
    assert.equal(output.queuedCount, 1, "the real writer has the scrolled B-first frame queued behind backpressure");
    const pendingFrame = submittedFrames.at(-1)?.frame;
    assert.equal(screenRowContaining(pendingFrame, "Native native-2"), rowA,
      "the undisplayed render has already placed B at A's old coordinate");

    emitMouse(harness.terminal, 1, rowA);
    emitMouse(harness.terminal, 1, rowA, 0, "m");
    assert.equal(harness.sidebar?.focus, "sidebar",
      "an old displayed coordinate cannot activate B from the newer mutable hit map");
    harness.terminal.emitInput("\x1b[1;3C"); // Alt+Right returns input ownership to Main without hiding the roster.
    await nextTurn(); // The Main-focus candidate coalesces behind B's refused write.
    harness.terminal.emitInput("while-frame-pending");
    assert.equal(manager.writes.at(-1)?.id, "native-1", "the pending row cannot redirect Main input ownership");

    output.drain();
    emitMouse(harness.terminal, 1, rowA);
    assert.equal(harness.sidebar?.selectedId, "native-2",
      "after the B-first frame settles, the same coordinate activates its emitted owner");
    emitMouse(harness.terminal, 1, rowA, 0, "m");
    harness.terminal.emitInput("after-frame-emitted");
    assert.equal(manager.writes.at(-1)?.id, "native-2", "Main ownership changes only after B's frame is emitted");
    assert.equal(manager.views.find((view) => view.id === "native-1")?.hasLiveProcess, true,
      "A remains live while the emitted B row becomes Main owner");
    assert.equal(await closeWithSignal(harness), 0);
    shutDown = true;
  } finally {
    if (!shutDown) {
      harness.signals.emit("SIGTERM");
      await harness.result.catch(() => undefined);
    }
  }
});

test("native-only output pending at the default redraw cadence keeps the emitted roster clickable", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const output = new QueuedFrameOutput();
  const submittedFrames: Array<{ readonly frame: ComposedHostFrame; readonly cols: number; readonly rows: number }> = [];
  const harness = createHarness({}, {
    createWriter: (_stdout, writerOptions) => {
      // Preserve the production default redraw interval (16 ms).
      const driver = createSessionHostFrameWriter(output as unknown as Writable, writerOptions);
      return {
        start: () => driver.start(),
        submit: (frame, cols, rows, onSettled) => {
          submittedFrames.push({ frame, cols, rows });
          driver.submit(frame, cols, rows, onSettled);
        },
        invalidate: () => driver.invalidate(),
        close: () => driver.close(),
      };
    },
  });
  let shutDown = false;
  try {
    const manager = await startTwoSessions(harness);
    harness.terminal.emitInput("\x1b[A"); // Highlight A without changing the active Main owner.
    harness.terminal.emitInput(ENTER); // Make A the Main owner.
    harness.terminal.emitInput(ALT_LEFT); // Keep the roster visible with B as a mouse target.
    await nextTurn();
    t.mock.timers.tick(100); // Settle startup/coalesced output using the writer's default 16 ms cadence.
    await nextTurn();

    const emittedFrame = submittedFrames.at(-1)?.frame;
    const rowB = screenRowContaining(emittedFrame, "Native native-2");
    assert.ok(rowB > 0, "the emitted roster contains B before native-only output changes");
    assert.ok(output.writes.some((bytes) => bytes.toString("utf8").includes("Native native-2")));
    const writesBeforeNativeOutput = output.writes.length;

    const activeSurface = manager.surface("native-1");
    assert.ok(activeSurface);
    activeSurface.writesAsFrame.push(" native-only-output");
    manager.notify("native-only-output");
    await nextTurn();
    const pendingFrame = submittedFrames.at(-1)?.frame;
    assert.notEqual(plain(pendingFrame), plain(emittedFrame), "the pending frame contains changed native-pane output");
    assert.equal(output.writes.length, writesBeforeNativeOutput,
      "the default redraw interval has not emitted the native-only candidate yet");

    emitMouse(harness.terminal, 1, rowB);
    emitMouse(harness.terminal, 1, rowB, 0, "m");
    assert.equal(harness.sidebar?.focus, "main", "B remains clickable through an unrelated pending Main update");
    harness.terminal.emitInput("verify-native-only-hit");
    assert.equal(manager.writes.at(-1)?.id, "native-2", "the emitted B row takes Main ownership");

    t.mock.timers.tick(16);
    await nextTurn();
    assert.ok(output.writes.length > writesBeforeNativeOutput, "the pending native update is emitted at the cadence boundary");
    assert.equal(await closeWithSignal(harness), 0);
    shutDown = true;
  } finally {
    if (!shutDown) {
      harness.signals.emit("SIGTERM");
      if (output.queuedCount > 0) output.drain();
      await harness.result.catch(() => undefined);
    }
  }
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
  // untouched, while visible host panes continue to own button tracking.
  harness.terminal.emitInput(ALT_LEFT);
  assert.deepEqual(harness.terminal.writes.slice(beforeFocusReset), [],
    "the still-visible host pane keeps button tracking and SGR enabled beside the native pane");
  assert.equal(harness.sidebar?.focus, "sidebar");
  assert.equal(harness.sidebar?.visible, true);
  const beforeFocusReenable = harness.terminal.writes.length;
  // Sidebar -> hide/Main is the deliberate visibility change that re-enables
  // exactly the active child's own observed modes.
  harness.terminal.emitInput(ALT_LEFT);
  assert.deepEqual(harness.terminal.writes.slice(beforeFocusReenable), [],
    "the active child's own tracking and cell-SGR mode remain enabled after hiding the host pane");
  assert.equal(harness.sidebar?.focus, "main");
  assert.equal(harness.sidebar?.visible, false);
  assert.equal(await closeWithSignal(harness), 0);
  assert.ok(harness.terminal.writes.includes("\x1b[?1000l"), "cleanup disables only the active owned tracking mode");
  assert.ok(harness.terminal.writes.includes("\x1b[?1006l"), "cleanup disables only owned cell-SGR encoding");
});

test("held synchronized frames keep outer mouse capture stable while native packets stay fenced (real TerminalSurface)", async () => {
  const BEGIN = "\x1b[?2026h";
  const END = "\x1b[?2026l";
  const CLICK = "\x1b[<0;35;2M"; // absolute (35,2) => native pane origin + (1,0)
  const FORWARDED_CLICK = "\x1b[<0;2;1M";
  const harness = createHarness();
  const manager = await ready(harness);
  fillForm(harness.terminal, "held-frame mouse owner");
  await nextTurn();
  const fake = manager.surface("native-1");
  assert.ok(fake);
  assert.equal(harness.sidebar?.focus, "main");
  assert.equal(harness.sidebar?.visible, true);
  // Swap in a real surface at the fake's current native geometry; its owner
  // callback is the manager change notification, as in the real manager.
  const surface = new TerminalSurface(fake.cols, fake.rows, { onChange: () => manager.notify("native-1") });
  manager.surfaces.set("native-1", surface as unknown as FakeSurface);
  const child = async (data: string): Promise<void> => {
    surface.write(data);
    await surface.flush();
    await nextTurn();
  };
  const outerWrites = (): number => harness.terminal.writes.length;
  try {
    await child("\x1b[?1049h\x1b[1;1Hcommitted row\x1b[?1002h\x1b[?1006h");
    assert.deepEqual(harness.terminal.writes.slice(-2), ["\x1b[?1000l", "\x1b[?1002h"],
      "the child's drag mode replaces the visible host pane's button reports");
    assert.ok(harness.terminal.writes.includes("\x1b[?1006h"), "cell-SGR reports are enabled");
    const before = manager.writes.length;
    harness.terminal.emitInput(CLICK);
    assert.deepEqual(manager.writes.slice(before).map((entry) => entry.data), [FORWARDED_CLICK],
      "an authorized click is forwarded before any hold");

    // Held frame: keyboard mode changes, no text/graphics/mouse change.
    const heldStart = outerWrites();
    await child(`${BEGIN}\x1b[1;1H\x1b[2Kcommitted row\x1b[?1h`);
    assert.equal(surface.inputModes().mouseTracking, "none", "packet authorization is withheld while held");
    assert.equal(surface.inputModes().applicationCursorKeys, true, "keyboard modes stay live while held");
    assert.deepEqual(surface.requestedMouseReporting(), { mouseTracking: "drag", mouseEncoding: "sgr" });
    manager.notify("sibling-roster-update"); // a sibling/roster change synchronizes outer modes mid-hold
    await nextTurn();
    assert.deepEqual(harness.terminal.writes.slice(heldStart), [],
      "a mid-hold roster sync neither disables nor downgrades the child's outer capture");
    const heldPackets = manager.writes.length;
    harness.terminal.emitInput(CLICK);
    assert.equal(manager.writes.length, heldPackets, "native mouse packets stay fenced during the hold");
    harness.terminal.emitInput("\x1b[A");
    assert.deepEqual(manager.writes.slice(heldPackets).map((entry) => entry.data), ["\x1bOA"],
      "keyboard input uses the live application-cursor mode during the hold");

    // Commit without any text, graphics, or mouse-mode change: no change
    // notification is required for capture to remain correct.
    await child(END);
    manager.notify("sibling-roster-update");
    await nextTurn();
    assert.deepEqual(harness.terminal.writes.slice(heldStart), [],
      "outer capture is unchanged across the hold and its no-change commit");
    const resumed = manager.writes.length;
    harness.terminal.emitInput(CLICK);
    assert.deepEqual(manager.writes.slice(resumed).map((entry) => entry.data), [FORWARDED_CLICK],
      "post-commit packets resume for the same authorized owner");

    // A real revocation inside a held frame applies when the frame ends,
    // without mid-frame off/on churn from roster syncs.
    const revokeStart = outerWrites();
    await child(`${BEGIN}\x1b[?1002l`);
    manager.notify("sibling-roster-update");
    await nextTurn();
    assert.deepEqual(harness.terminal.writes.slice(revokeStart), [], "no churn while the revocation is uncommitted");
    await child(END);
    assert.deepEqual(harness.terminal.writes.slice(revokeStart), ["\x1b[?1002l", "\x1b[?1000h"],
      "the committed revocation notifies and leaves only the visible host pane's button reports");
    const revoked = manager.writes.length;
    harness.terminal.emitInput(CLICK);
    assert.equal(manager.writes.length, revoked, "no packet is forwarded after the child revoked reporting");

    // Re-grant unframed, then hold again: focus changes are real owner
    // changes and still reconfigure capture during a hold.
    const regrantStart = outerWrites();
    await child("\x1b[?1002h");
    assert.deepEqual(harness.terminal.writes.slice(regrantStart), ["\x1b[?1000l", "\x1b[?1002h"]);
    await child(BEGIN);
    const focusStart = outerWrites();
    harness.terminal.emitInput(ALT_LEFT); // Main -> sidebar focus
    await nextTurn();
    assert.equal(harness.sidebar?.focus, "sidebar");
    assert.deepEqual(harness.terminal.writes.slice(focusStart), ["\x1b[?1002l", "\x1b[?1000h"],
      "leaving Main during a hold still drops the child's mode to host button reports");
    // A left click on the displayed native pane is a host-owned focus
    // gesture (geometry unchanged, so the hold is not dropped by a resize).
    const focusClickPackets = manager.writes.length;
    harness.terminal.emitInput(CLICK);
    harness.terminal.emitInput("\x1b[<0;35;2m");
    await nextTurn();
    assert.equal(harness.sidebar?.focus, "main");
    assert.equal(harness.sidebar?.visible, true);
    assert.equal(manager.writes.length, focusClickPackets, "the focus gesture's press and release stay host-owned");
    assert.deepEqual(harness.terminal.writes.slice(focusStart),
      ["\x1b[?1002l", "\x1b[?1000h", "\x1b[?1000l", "\x1b[?1002h"],
      "returning to Main mid-hold restores the committed request, not the withheld packet mode");
    const focusedHeld = manager.writes.length;
    harness.terminal.emitInput(CLICK);
    assert.equal(manager.writes.length, focusedHeld, "the native fence still holds after the focus round trip");
    await child(END);
    assert.deepEqual(harness.terminal.writes.slice(focusStart),
      ["\x1b[?1002l", "\x1b[?1000h", "\x1b[?1000l", "\x1b[?1002h"], "the no-change commit adds no outer writes");
    const focusedResumed = manager.writes.length;
    harness.terminal.emitInput(CLICK);
    assert.deepEqual(manager.writes.slice(focusedResumed).map((entry) => [entry.id, entry.data]),
      [["native-1", FORWARDED_CLICK]], "the committed frame re-authorizes the same owner");

    // Shutdown during a hold disables exactly the owned modes.
    await child(BEGIN);
    const shutdownStart = outerWrites();
    assert.equal(await closeWithSignal(harness), 0);
    const cleanup = harness.terminal.writes.slice(shutdownStart);
    assert.ok(cleanup.includes("\x1b[?1002l"), "shutdown disables the child's owned tracking mode");
    assert.ok(cleanup.includes("\x1b[?1006l"), "shutdown disables owned cell-SGR encoding");
  } finally {
    surface.dispose();
  }
});

test("responsive resize sizes the displayed session only when native geometry changes; overlays keep geometry stable", async () => {
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
  // native-2 is the displayed Main owner; native-1 is a background sibling with no viewer.
  const hiddenGeometryBefore = manager.geometry.get("native-1");
  const hiddenSurfaceBefore = { cols: manager.surfaces.get("native-1")?.cols, rows: manager.surfaces.get("native-1")?.rows };

  harness.terminal.setSize(60, 10); // wide: 32 + divider + 27 native, nine content rows
  assert.deepEqual(manager.resizeCalls.at(-1), { cols: 27, rows: 9, ids: ["native-2"] },
    "only the session the host actually displays is resized; each session is sized for its own viewers");
  assert.deepEqual(manager.geometry.get("native-1"), hiddenGeometryBefore,
    "a session nobody is displaying keeps its last canonical size");
  assert.deepEqual({ cols: manager.surfaces.get("native-1")?.cols, rows: manager.surfaces.get("native-1")?.rows },
    hiddenSurfaceBefore, "an unviewed sibling's terminal is untouched");
  const beforeNarrow = manager.resizeCalls.length;
  harness.terminal.setSize(52, 10); // overlay: full-width native viewport
  assert.deepEqual(manager.resizeCalls.at(-1), { cols: 52, rows: 9, ids: ["native-2"] });
  const afterNarrow = manager.resizeCalls.length;
  assert.equal(afterNarrow, beforeNarrow + 1);
  harness.terminal.emitInput(ALT_LEFT); // focus Main then hide
  harness.terminal.emitInput(ALT_LEFT); // show and focus sidebar; native dimensions remain 52x9
  assert.equal(manager.resizeCalls.length, afterNarrow, "focus changes in narrow overlay do not resize children");
  await nextTurn();
  assert.ok(harness.writer.frames.some(({ cols, rows }) => cols === 52 && rows === 10));
  assert.equal(await closeWithSignal(harness), 0);
});

test("a second surface displaying a background session sizes only that session", async () => {
  const harness = createHarness();
  const manager = await startTwoSessions(harness);
  const displayedBefore = { cols: manager.surfaces.get("native-2")?.cols, rows: manager.surfaces.get("native-2")?.rows };
  const displayedGeometryBefore = manager.geometry.get("native-2");
  const writesBefore = manager.writes.length;

  const viewer = manager.openViewer();
  assert.equal(manager.updateViewer(viewer.viewerId, { sessionId: "native-1", cols: 40, rows: 12 }).applied, true);

  const sized = manager.instanceGeometry("native-1");
  assert.deepEqual({ cols: sized?.cols, rows: sized?.rows }, { cols: 40, rows: 12 },
    "the addressed session takes the size of the surface that displays it");
  assert.deepEqual({ cols: manager.surfaces.get("native-1")?.cols, rows: manager.surfaces.get("native-1")?.rows },
    { cols: 40, rows: 12 });
  assert.deepEqual(manager.geometry.get("native-2"), displayedGeometryBefore,
    "the session the local surface displays keeps its own size");
  assert.deepEqual({ cols: manager.surfaces.get("native-2")?.cols, rows: manager.surfaces.get("native-2")?.rows },
    displayedBefore);

  // Two surfaces on two sessions create no exclusive lease: each session stays
  // writable through the one manager.
  manager.write("native-2", "still addressed input");
  assert.deepEqual(manager.writes.slice(writesBefore), [{ id: "native-2", data: "still addressed input" }]);
  assert.equal(await closeWithSignal(harness), 0);
});

test("a missing or malformed canonical size fails positional input closed while keyboard input continues", async () => {
  const harness = createHarness();
  const manager = await ready(harness);
  fillForm(harness.terminal, "geometry-fenced mouse");
  await nextTurn();
  const surface = manager.surface("native-1");
  assert.ok(surface);
  surface.modes = { ...surface.modes, mouseTracking: "any", mouseEncoding: "sgr" };
  manager.notify("native-input-modes");
  await nextTurn();
  assert.equal(harness.sidebar?.focus, "main");

  const CLICK = "\x1b[<0;35;2M"; // inside the displayed native pane
  const forwarded = manager.writes.length;
  harness.terminal.emitInput(CLICK);
  assert.deepEqual(manager.writes.slice(forwarded).map((entry) => entry.data), ["\x1b[<0;2;1M"],
    "an authoritative canonical size translates the packet normally");

  // The manager no longer has an authoritative size for the displayed row. Both
  // the seam's own record and this fixture's row record are cleared, so the read
  // has no fact left to return.
  manager.geometry.delete("native-1");
  manager.viewers.geometry.delete("native-1");
  const afterValid = manager.writes.length;
  harness.terminal.emitInput(CLICK);
  assert.equal(manager.writes.length, afterValid,
    "without an authoritative canonical size, a positional packet is dropped rather than authorized against the padded pane");
  harness.terminal.emitInput("k");
  assert.deepEqual(manager.writes.slice(afterValid).map((entry) => entry.data), ["k"],
    "keyboard input makes no positional claim and keeps its ordinary path");

  // A malformed canonical size is equally no authority.
  manager.geometry.set("native-1", { cols: 0, rows: 0 });
  manager.viewers.geometry.set("native-1", { cols: 0, rows: 0, revision: 1 });
  const afterKeyboard = manager.writes.length;
  harness.terminal.emitInput(CLICK);
  assert.equal(manager.writes.length, afterKeyboard,
    "a malformed canonical size cannot authorize padded or stale positional input");
  harness.terminal.emitInput("k");
  assert.deepEqual(manager.writes.slice(afterKeyboard).map((entry) => entry.data), ["k"]);

  // An unavailable canonical-geometry read is no authority either: the service
  // reports no geometry, and a failed read never widens what may reach the child.
  manager.geometryReadThrows = true;
  const afterMalformed = manager.writes.length;
  harness.terminal.emitInput(CLICK);
  assert.equal(manager.writes.length, afterMalformed,
    "a failed canonical-geometry read drops positional input instead of guessing a viewport");
  harness.terminal.emitInput("k");
  assert.deepEqual(manager.writes.slice(afterMalformed).map((entry) => entry.data), ["k"]);
  manager.geometryReadThrows = false;

  // A valid size restores ordinary translation for the same packet — once a frame
  // has actually been drawn from it (#474 binds positional authority to the drawn
  // snapshot, so a size nobody has drawn yet authorizes nothing).
  manager.geometry.set("native-1", { cols: surface.cols, rows: surface.rows });
  manager.viewers.geometry.set("native-1", { cols: surface.cols, rows: surface.rows, revision: 2 });
  manager.notify("native-1");
  await nextTurn();
  const afterUnavailable = manager.writes.length;
  harness.terminal.emitInput(CLICK);
  assert.deepEqual(manager.writes.slice(afterUnavailable).map((entry) => entry.data), ["\x1b[<0;2;1M"],
    "the written frame drawn from the restored size re-authorizes the same packet");
  assert.equal(await closeWithSignal(harness), 0);
});

test("a queued per-session resize authorizes neither newly exposed padding nor the not-yet-drawn size", async () => {
  const INSIDE = "\x1b[<0;35;2M"; // one cell inside the drawn content
  const PAD = "\x1b[<0;70;2M";    // inside the pane, outside a 30-column session
  const harness = createHarness();
  const manager = await ready(harness);
  fillForm(harness.terminal, "backpressure geometry owner");
  await nextTurn();
  const surface = manager.surface("native-1");
  assert.ok(surface);
  surface.modes = { ...surface.modes, mouseTracking: "any", mouseEncoding: "sgr" };
  manager.notify("native-input-modes");
  await nextTurn();
  assert.equal(harness.sidebar?.focus, "main");

  const first = manager.writes.length;
  harness.terminal.emitInput(INSIDE);
  harness.terminal.emitInput(PAD);
  const [INSIDE_FORWARDED, PAD_FORWARDED] = manager.writes.slice(first).map((entry) => entry.data);
  assert.equal(INSIDE_FORWARDED, "\x1b[<0;2;1M");
  assert.ok(PAD_FORWARDED !== undefined && PAD_FORWARDED !== INSIDE_FORWARDED,
    "a full-pane session owns every native cell it drew");

  // A second surface displays the same session in a smaller pane, and the local
  // replacement frame is queued behind a blocked sink: nothing new is on screen.
  harness.writer.holdWrites = true;
  const other = manager.viewers.openViewer();
  manager.viewers.updateViewer(other.viewerId, { sessionId: "native-1", cols: 30, rows: 20 });
  manager.notify("native-1");
  await nextTurn();
  assert.ok(harness.writer.heldSubmits > 0, "the replacement frame is queued, not written");
  assert.deepEqual({ cols: surface.cols, rows: surface.rows }, { cols: 30, rows: 20 },
    "the addressed row shrank to the independent minimum");

  const queued = manager.writes.length;
  harness.terminal.emitInput(INSIDE);
  harness.terminal.emitInput(PAD);
  assert.equal(manager.writes.length, queued,
    "an undrawn replacement frame authorizes neither its new size nor the padding it exposes");
  harness.terminal.emitInput("k");
  assert.deepEqual(manager.writes.slice(queued).map((entry) => entry.data), ["k"],
    "keyboard input is unaffected by a queued geometry change");

  harness.writer.drainHeldWrites();
  const drained = manager.writes.length;
  harness.terminal.emitInput(INSIDE);
  assert.deepEqual(manager.writes.slice(drained).map((entry) => entry.data), [INSIDE_FORWARDED],
    "the written padded frame keeps translating cells it actually drew");
  const afterInside = manager.writes.length;
  harness.terminal.emitInput(PAD);
  assert.equal(manager.writes.length, afterInside,
    "a padded pane cell stays host-owned once the smaller session is actually drawn");

  // Growing back: the last other viewer leaves and the session returns to the
  // local pane. Again nothing is authorized until that frame is written.
  harness.writer.holdWrites = true;
  assert.equal(manager.viewers.closeViewer(other.viewerId), true);
  manager.notify("native-1");
  await nextTurn();
  const growing = manager.writes.length;
  harness.terminal.emitInput(PAD);
  assert.equal(manager.writes.length, growing,
    "padding exposed only by a queued grow cannot reach the child");
  harness.writer.drainHeldWrites();
  const grown = manager.writes.length;
  harness.terminal.emitInput(PAD);
  assert.deepEqual(manager.writes.slice(grown).map((entry) => entry.data), [PAD_FORWARDED],
    "the written grown frame owns the cells it now draws");
  assert.equal(await closeWithSignal(harness), 0);
});

test("a row activated by creation follows the native pane without a deliberate selection", async () => {
  const harness = createHarness();
  const manager = await ready(harness);
  fillForm(harness.terminal, "created row sizing");
  await nextTurn();
  const surface = manager.surface("native-1");
  assert.ok(surface);
  const created = { cols: surface.cols, rows: surface.rows };
  assert.deepEqual(manager.geometry.get("native-1"), created,
    "the displayed row carries the size this host's own surface displays");

  harness.terminal.setSize(70, 24);
  await nextTurn();
  const resized = manager.geometry.get("native-1");
  assert.ok(resized !== undefined && resized.cols < created.cols,
    `a real pane change re-registers the displayed row (${JSON.stringify(resized)} vs ${JSON.stringify(created)})`);
  assert.deepEqual({ cols: surface.cols, rows: surface.rows }, resized,
    "only that row's own surface moved with it");
  assert.equal(manager.views.length, 1, "nothing else was created or removed");
  assert.equal(await closeWithSignal(harness), 0);
});

test("a narrow overlay-capable layout keeps Main mouse input and waits to uncover Main", async () => {
  const CLICK = "\x1b[<0;6;3M"; // inside the full-width native pane
  const harness = createHarness();
  const manager = await ready(harness);
  fillForm(harness.terminal, "narrow overlay mouse owner");
  await nextTurn();
  const surface = manager.surface("native-1");
  assert.ok(surface);
  surface.modes = { ...surface.modes, mouseTracking: "any", mouseEncoding: "sgr" };
  manager.notify("native-input-modes");
  await nextTurn();
  assert.equal(harness.sidebar?.focus, "main");

  // Narrow terminal: the sidebar becomes an overlay *capability*, but with Main
  // focused nothing is drawn over the native pane, so Main owns it.
  harness.terminal.setSize(52, 24);
  await nextTurn();
  assert.equal(harness.sidebar?.visible, true);
  assert.equal(harness.sidebar?.focus, "main");
  const narrow = manager.writes.length;
  harness.terminal.emitInput(CLICK);
  assert.equal(manager.writes.length, narrow + 1,
    "an overlay-capable layout with Main focused still forwards native mouse input");
  assert.match(String(manager.writes[narrow]?.data ?? ""), /^\x1b\[<0;\d+;\d+M$/, "the packet is translated, not dropped");

  // Focus the drawn overlay, then uncover Main behind a blocked writer: the
  // uncovered frame must be written before its cells authorize anything.
  harness.terminal.emitInput(ALT_LEFT); // Main -> roster focus; the overlay is actually drawn
  await nextTurn();
  assert.equal(harness.sidebar?.focus, "sidebar");
  harness.writer.holdWrites = true;
  harness.terminal.emitInput(ENTER); // display the same row again: the overlay uncovers Main
  await nextTurn();
  assert.equal(harness.sidebar?.focus, "main");
  assert.ok(harness.writer.heldSubmits > 0, "the uncovered frame is queued, not written");
  const refused = manager.writes.length;
  harness.terminal.emitInput(CLICK);
  assert.equal(manager.writes.length, refused,
    "a still-covered written frame cannot authorize input for a frame nobody has drawn");
  harness.terminal.emitInput("k");
  assert.deepEqual(manager.writes.slice(refused).map((entry) => entry.data), ["k"],
    "keyboard input keeps its ordinary path");

  harness.writer.drainHeldWrites();
  const written = manager.writes.length;
  harness.terminal.emitInput(CLICK);
  assert.equal(manager.writes.length, written + 1,
    "the written uncovered frame re-authorizes the content it draws");
  assert.match(String(manager.writes[written]?.data ?? ""), /^\x1b\[<0;\d+;\d+M$/);
  assert.equal(await closeWithSignal(harness), 0);
});

test("a narrow overlay-capable layout copies only when Main is actually uncovered", async () => {
  const harness = createHarness({ env: { PATH: process.env.PATH, HOME: "/synthetic-home", TERM: "xterm-ghostty" } });
  const event: NativeClipboardEvent = {
    kind: "copy",
    encoded: Buffer.from("narrow overlay copy").toString("base64"),
    sessionId: "conversation-native-1",
    sessionEpoch: 1,
  };
  const expected = `\x1b]52;c;${event.encoded}\x07`;
  try {
    const manager = await ready(harness);
    fillForm(harness.terminal, "narrow overlay clipboard owner");
    await nextTurn();
    assert.equal(harness.sidebar?.focus, "main");
    const copies = (): string[] => harness.terminal.writes.filter((write) => write.startsWith("\x1b]52;"));

    // Narrow terminal: `sidebarOverlay` is only a *capability*. With Main focused
    // the host draws no sidebar rectangle, so the visible owner's verified copy is
    // authorized by what is actually on screen, exactly like native mouse input.
    harness.terminal.setSize(52, 24);
    await nextTurn();
    assert.equal(harness.sidebar?.visible, true);
    assert.equal(harness.sidebar?.focus, "main");
    assert.ok(plain(harness.writer.frames.at(-1)?.frame).includes("frame:native-1"),
      "the narrow Main-focused layout actually draws the owner's content across the pane");
    manager.options.onNativeClipboard?.("native-1", event);
    assert.deepEqual(copies(), [expected],
      "an overlay-capable layout with Main actually uncovered forwards the verified copy");
    await nextTurn();
    assert.doesNotMatch(plain(harness.writer.frames.at(-1)?.frame), HOST_CLIPBOARD_STATUS,
      "a successful narrow copy renders no host clipboard status");
    assert.equal(harness.sidebar?.terminalDiagnosticsWarning, undefined,
      "a successful narrow copy records no diagnostic");

    // The existing authentication fences stay in force in the narrow layout.
    manager.options.onNativeClipboard?.("native-1", { ...event, sessionEpoch: 2 });
    manager.options.onNativeClipboard?.("native-1", { ...event, sessionId: "conversation-native-2" });
    await nextTurn();
    assert.equal(copies().length, 1, "a stale epoch and a changed session tuple cannot copy in a narrow layout");

    // Now the overlay is actually drawn over Main: the same row owns Main but its
    // content is covered, so neither the copy nor its unavailable report is forwarded.
    harness.terminal.emitInput(ALT_LEFT);
    await nextTurn();
    assert.equal(harness.sidebar?.focus, "sidebar");
    const covered = plain(harness.writer.frames.at(-1)?.frame);
    assert.ok(!covered.includes("frame:native-1"), "the drawn sidebar overlay really covers the native pane");
    assert.ok(covered.includes("New session"), "the roster overlay is the content on screen");
    manager.options.onNativeClipboard?.("native-1", event);
    manager.options.onNativeClipboard?.("native-1", { kind: "unavailable", reason: "unsupported-runtime", sessionId: event.sessionId, sessionEpoch: 1 });
    await nextTurn();
    assert.equal(copies().length, 1, "an actually drawn sidebar covering Main cannot authorize a copy");
    assert.equal(harness.sidebar?.terminalDiagnosticsWarning, undefined,
      "a covered copy is an ordinary quiet refusal");

    // Returning to Main behind a blocked writer queues the uncovering frame. Until
    // that frame is written, the displayed content is still the covered overlay.
    harness.writer.holdWrites = true;
    harness.terminal.emitInput(ENTER); // display the same row again: the overlay uncovers Main
    await nextTurn();
    assert.equal(harness.sidebar?.focus, "main");
    assert.ok(harness.writer.heldSubmits > 0, "the uncovered frame is queued, not written");
    manager.options.onNativeClipboard?.("native-1", event);
    await nextTurn();
    assert.equal(copies().length, 1,
      "a queued, undrawn uncovering frame cannot authorize a copy of content nobody has drawn");

    // Once the matching uncovered frame is actually written, the same verified copy works.
    harness.writer.drainHeldWrites();
    await nextTurn();
    assert.ok(plain(harness.writer.frames.at(-1)?.frame).includes("frame:native-1"),
      "the written frame uncovers the owner's content again");
    manager.options.onNativeClipboard?.("native-1", event);
    assert.deepEqual(copies(), [expected, expected],
      "the written uncovered frame authorizes the verified copy again");
  } finally {
    await closeWithSignal(harness);
  }
});

test("a fully drawn padded session keeps copying, click-to-focus, and its image owner while padding stays host-owned", async () => {
  const INSIDE = "\x1b[<0;35;2M";
  const INSIDE_RELEASE = "\x1b[<0;35;2m";
  const PAD = "\x1b[<0;70;2M";
  const PAD_RELEASE = "\x1b[<0;70;2m";
  const harness = createHarness({ env: { PATH: process.env.PATH, HOME: "/synthetic-home", TERM: "xterm-ghostty" } });
  try {
    const manager = await ready(harness);
    fillForm(harness.terminal, "padded session owner");
    await nextTurn();
    const surface = manager.surface("native-1");
    assert.ok(surface);
    surface.writesAsFrame.splice(0, surface.writesAsFrame.length, "padded child content");
    surface.graphics = {
      images: [],
      placements: [],
      fallbacks: [{
        id: "padded-image",
        mimeType: "image/png",
        widthPx: 320,
        heightPx: 160,
        column: 2,
        row: 1,
        columns: 4,
        rows: 2,
        clip: { leftColumns: 0, topRows: 0, rightColumns: 0, bottomRows: 0 },
      }],
    };
    // Another surface with a smaller pane makes this session smaller than the
    // local pane: its frame is drawn at the pane's top-left corner and padded.
    const other = manager.viewers.openViewer();
    manager.viewers.updateViewer(other.viewerId, { sessionId: "native-1", cols: 30, rows: 20 });
    manager.notify("native-1");
    await nextTurn();
    assert.deepEqual({ cols: surface.cols, rows: surface.rows }, { cols: 30, rows: 20 });

    const frame = harness.writer.frames.at(-1)?.frame;
    assert.ok(frame, "the padded session still renders a host frame");
    assert.ok(plain(frame).includes("padded child content"), "the drawn content stays visible");
    assert.ok(frame.graphics, "a padded session keeps its image owner instead of losing graphics");
    assert.deepEqual({ cols: frame.graphics.pane.cols, rows: frame.graphics.pane.rows }, { cols: 30, rows: 20 },
      "the image layer is bounded by the drawn content, not by the padded pane");
    // The layer pane starts on the native pane's first output row; the padded
    // rows below the 20-row content are host space, not child content.
    const belowContent = frame.graphics.pane.row + 20;
    if (belowContent < frame.lines.length) {
      // Slice from the native pane's own column so the roster divider is not
      // mistaken for child content.
      const paddedRow = plainLine(frame, belowContent).slice(frame.graphics.pane.column);
      assert.equal(paddedRow.trim(), "",
        "the first padded row below the drawn content stays blank host space");
    }

    // A copy is a claim about content the user saw: the padded owner still copies.
    const copies = (): string[] => harness.terminal.writes.filter((write) => write.startsWith("\x1b]52;"));
    const event: NativeClipboardEvent = {
      kind: "copy",
      encoded: Buffer.from("padded copy").toString("base64"),
      sessionId: "conversation-native-1",
      sessionEpoch: 1,
    };
    manager.options.onNativeClipboard?.("native-1", event);
    assert.deepEqual(copies(), [`\x1b]52;c;${event.encoded}\x07`],
      "a fully drawn padded owner still submits its native copy");

    // Click-to-focus follows the drawn content, and stops at it.
    harness.terminal.emitInput(ALT_LEFT);
    await nextTurn();
    assert.equal(harness.sidebar?.focus, "sidebar");
    const packets = manager.writes.length;
    harness.terminal.emitInput(PAD);
    harness.terminal.emitInput(PAD_RELEASE);
    await nextTurn();
    assert.equal(harness.sidebar?.focus, "sidebar", "a padded cell is not a focus gesture");
    assert.equal(manager.writes.length, packets, "a padded cell never reaches the child");
    harness.terminal.emitInput(INSIDE);
    harness.terminal.emitInput(INSIDE_RELEASE);
    await nextTurn();
    assert.equal(harness.sidebar?.focus, "main",
      "a click on drawn content still focuses Main even when the session is padded");
    assert.equal(manager.writes.length, packets, "the host-owned focus gesture stays out of the child");
  } finally {
    await closeWithSignal(harness);
  }
});

test("n displays no session without stopping, creating, or feeding anything", async () => {
  const harness = createHarness();
  const manager = await startTwoSessions(harness);
  const sidebar = harness.sidebar;
  assert.ok(sidebar);
  assert.equal(sidebar.focus, "sidebar");
  assert.equal(sidebar.activeMainOwnerID, "native-2");
  const selectedBefore = sidebar.selectedId;
  const createsBefore = manager.createOptions.length;
  const shutdownsBefore = manager.shutdownCalls;
  const writesBefore = manager.writes.length;

  harness.terminal.emitInput("n");
  await nextTurn();

  assert.equal(sidebar.activeMainOwnerID, undefined, "no session is the displayed Main owner any more");
  assert.equal(sidebar.selectedId, selectedBefore, "the roster keeps its rows, order, and highlight");
  assert.equal(sidebar.visible, true, "the roster stays open");
  const detached = plain(harness.writer.frames.at(-1)?.frame);
  assert.ok(detached.includes("No session is displayed"), detached);
  assert.equal(manager.shutdownCalls, shutdownsBefore, "detaching the local view never stops or quits a child");
  assert.equal(manager.createOptions.length, createsBefore, "detaching starts nothing");
  assert.deepEqual(manager.views.map((view) => view.hasLiveProcess), [true, true], "both children keep running");
  assert.equal(manager.writes.length, writesBefore, "nothing is fed to a child while nothing is displayed");

  // An inert keystroke while detached still reaches no child.
  harness.terminal.emitInput(" ");
  await nextTurn();
  assert.equal(manager.writes.length, writesBefore);

  // A second press says so truthfully and changes nothing else.
  harness.terminal.emitInput("n");
  await nextTurn();
  const again = plain(harness.writer.frames.at(-1)?.frame);
  assert.ok(again.includes("No session is displayed") && again.includes("already"), again);
  assert.equal(manager.shutdownCalls, shutdownsBefore);
  assert.equal(manager.createOptions.length, createsBefore);

  // Enter on the highlighted row displays that session again, with no restart.
  harness.terminal.emitInput(ENTER);
  await nextTurn();
  assert.equal(sidebar.activeMainOwnerID, selectedBefore, "the same session is displayed again");
  assert.equal(manager.createOptions.length, createsBefore, "re-displaying a running session never restarts it");
  harness.terminal.emitInput("back to the child");
  assert.deepEqual(manager.writes.slice(writesBefore), [{ id: selectedBefore ?? "native-2", data: "back to the child" }]);

  // Quit still shuts every owned child down.
  assert.equal(await closeWithSignal(harness), 0);
  assert.equal(manager.shutdownCalls, shutdownsBefore + 1);
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

test("Saved picker uses native Input and private-catalog search without leaking indexed session fields", async () => {
  const fixture = makeSavedMainFixture("native-query");
  const secondFile = join(fixture.agentDir, "sessions", "proj", "second.jsonl");
  const secondId = "saved-main-native-query-second";
  const nameSuffix = "PrivateNativeNameSuffix";
  const transcriptNeedle = "private-regex-needle-729";
  writeFileSync(secondFile, [
    JSON.stringify({ type: "session", version: 3, id: secondId, timestamp: "2025-02-01T00:00:00.000Z", cwd: fixture.workspace }),
    JSON.stringify({ type: "message", id: "m2", message: { role: "user", content: [{ type: "text", text: `Second conversation native-query ${fixture.sessionId}` }] } }),
  ].join("\n") + "\n", "utf8");
  writeFileSync(join(fixture.agentDir, "keybindings.json"), JSON.stringify({
    "tui.select.down": "ctrl+n",
    "app.session.delete": "ctrl+x",
    "app.session.deleteNoninvasive": "ctrl+backspace",
  }), "utf8");
  const { overrides } = savedFixtureDependencies(fixture, (options) => listSavedSessions({
    agentDir: options.agentDir,
    signal: options.signal,
    listAll: async () => [
      {
        path: fixture.file,
        id: fixture.sessionId,
        cwd: fixture.workspace,
        name: `Deep Blue Phrase ${"N".repeat(300)}${nameSuffix}`,
        allMessagesText: "private indexed transcript for phrase and fuzzy searching",
        firstMessage: "First conversation native-query",
        modified: new Date("2025-02-02T00:00:00.000Z"),
      },
      {
        path: secondFile,
        id: secondId,
        cwd: fixture.workspace,
        allMessagesText: `search-only ${transcriptNeedle}`,
        firstMessage: "Second conversation native-query",
        modified: new Date("2025-02-01T00:00:00.000Z"),
      },
    ],
  }));
  const harness = createHarness({}, overrides);
  let closed = false;
  try {
    const manager = await ready(harness);
    openSavedPicker(harness.terminal);
    for (let attempt = 0; attempt < 10; attempt += 1) {
      await nextTurn();
      const frame = plain(harness.writer.frames.at(-1)?.frame);
      if (frame.includes("Deep Blue Phrase") && frame.includes("Second conversatio")) break;
    }
    let frame = plain(harness.writer.frames.at(-1)?.frame);
    assert.ok(frame.includes("Deep Blue Phrase") && frame.includes("Second conversatio"), JSON.stringify(frame));
    assert.ok(!frame.includes(nameSuffix), "native name remains private until the user searches for it");
    assert.ok(!frame.includes(transcriptNeedle), "full transcript search text never enters the picker display");

    harness.terminal.emitInput("\x0e"); // remapped native tui.select.down = Ctrl+N
    await nextTurn();
    frame = plain(harness.writer.frames.at(-1)?.frame);
    assert.ok(frame.includes("> Second conversatio"), "Pi's remapped navigation binding moves the highlight: " + frame);

    harness.terminal.emitInput("d"); // ordinary d is query text, not deletion
    await nextTurn();
    assert.equal(harness.sidebar?.savedQuery, "d");
    assert.equal(harness.sidebar?.focus, "form");
    assert.equal(manager.createOptions.length, 0);
    assert.ok(existsSync(fixture.file));

    const clearQuery = async (): Promise<void> => {
      harness.terminal.emitInput("\x15"); // native Input's Ctrl+U delete-to-line-start action
      await nextTurn();
    };
    await clearQuery();
    harness.terminal.emitInput('"Deep Blue Phrase"');
    await nextTurn();
    frame = plain(harness.writer.frames.at(-1)?.frame);
    assert.ok(frame.includes("> Deep Blue Phrase"), "quoted native phrase search includes the full native name index");
    assert.ok(!frame.includes("Second conversation native-query"));
    assert.ok(!frame.includes(nameSuffix), "only the user's query, not the unsearched name suffix, is displayed");

    await clearQuery();
    harness.terminal.emitInput(`re:${transcriptNeedle}`);
    await nextTurn();
    frame = plain(harness.writer.frames.at(-1)?.frame);
    assert.ok(frame.includes("Second conversation native-query"), "native regex search includes private full-message text");
    assert.ok(!frame.includes("First conversation native-query"));
    assert.equal(frame.split(transcriptNeedle).length - 1, 1, "the regex token appears only as the user's query, not as an indexed result field");

    await clearQuery();
    harness.terminal.emitInput("re:[");
    await nextTurn();
    assert.ok(plain(harness.writer.frames.at(-1)?.frame).includes("No matching saved conversations"),
      "invalid native regex is an empty result, not a thrown UI error");

    await clearQuery();
    harness.terminal.emitInput("privateword");
    await nextTurn();
    harness.terminal.emitInput("\x1b[127;5u"); // Ctrl+Backspace: noninvasive delete only for an empty query
    await nextTurn();
    assert.equal(harness.sidebar?.savedQuery, "privateword", "with a nonempty query native Input receives and ignores Ctrl+Backspace");
    assert.equal(harness.sidebar?.focus, "form");
    assert.ok(existsSync(fixture.file));

    await clearQuery();
    harness.terminal.emitInput("\x1b[127;5u");
    await nextTurn();
    assert.equal(harness.sidebar?.focus, "confirm", "the native noninvasive chord deletes only while the query is empty");
    frame = plain(harness.writer.frames.at(-1)?.frame);
    assert.ok(frame.includes("Delete saved conversation?"), JSON.stringify(frame));
    harness.terminal.emitInput("\x03"); // native tui.select.cancel = Ctrl+C
    await nextTurn();
    assert.equal(harness.sidebar?.focus, "form", "native cancel returns to the same picker");

    harness.terminal.emitInput("Deep");
    await nextTurn();
    const pickerBeforeCancel = harness.sidebar?.savedPickerRequestId;
    harness.terminal.emitInput("\x18"); // remapped app.session.delete = Ctrl+X
    await nextTurn();
    assert.equal(harness.sidebar?.focus, "confirm", "the configured native delete chord opens confirmation");
    frame = plain(harness.writer.frames.at(-1)?.frame);
    assert.ok(frame.includes("Delete saved conversation?"));
    harness.terminal.emitInput("\x03");
    await nextTurn();
    assert.equal(harness.sidebar?.focus, "form");
    assert.equal(harness.sidebar?.savedQuery, "Deep", "cancel preserves the native search draft");
    assert.equal(harness.sidebar?.savedPickerRequestId, pickerBeforeCancel, "cancel keeps the same picker owner");
    assert.ok(existsSync(fixture.file), "cancel never mutates the selected file");
    assert.equal(manager.createOptions.length, 0, "query/edit/delete/cancel never changes Main ownership");
    assert.equal(await closeWithSignal(harness), 0);
    closed = true;
  } finally {
    if (!closed) await closeWithSignal(harness).catch(() => undefined);
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("production Saved picker preserves native Kitty editing repeats and fences repeated actions", async () => {
  const fixture = makeSavedMainFixture("kitty-query-repeats");
  writeFileSync(join(fixture.agentDir, "keybindings.json"), JSON.stringify({ "app.session.delete": "ctrl+x" }), "utf8");
  const { overrides } = savedFixtureDependencies(fixture);
  let deletionCalls = 0;
  const harness = createHarness({}, {
    ...overrides,
    deleteSavedFile: (_file, options) => {
      deletionCalls += 1;
      const refusal = options.validate();
      return refusal === undefined
        ? { ok: false, method: "unlink", error: "synthetic no-op deletion" }
        : { ok: false, method: "unlink", refusal };
    },
  });
  const previousKittyProtocol = isKittyProtocolActive();
  setKittyProtocolActive(true);
  let referenceInput: ReturnType<typeof createNativeSavedQueryInput> | undefined;
  let closed = false;
  try {
    await ready(harness);
    harness.terminal.kittyProtocolActive = true;
    openSavedPicker(harness.terminal);
    for (let attempt = 0; attempt < 10 && !plain(harness.writer.frames.at(-1)?.frame).includes("First conversation kitty-query-repeats"); attempt += 1) {
      await nextTurn();
    }
    referenceInput = createNativeSavedQueryInput(fixture.agentDir);
    const sendEditingPacket = (packet: string): void => {
      // The native TUI dispatches Kitty releases as key-state events, not to Input;
      // mirror that boundary while still asserting releases do not edit the picker.
      if (!/:3(?:u|[A-Z])$/.test(packet)) referenceInput!.handleInput(packet);
      harness.terminal.emitInput(packet);
      assert.equal(harness.sidebar?.savedQuery, referenceInput!.getValue(),
        `the production picker follows native Input for ${JSON.stringify(packet)}`);
    };

    sendEditingPacket("d");
    sendEditingPacket("\x1b[100;1:2u"); // printable d repeat
    sendEditingPacket("\x1b[100;1:3u"); // release
    assert.equal(harness.sidebar?.savedQuery, "dd");

    sendEditingPacket("\x1b[127;1:1u"); // Backspace press
    sendEditingPacket("\x1b[127;1:2u"); // Backspace repeat
    sendEditingPacket("\x1b[127;1:3u"); // release
    assert.equal(harness.sidebar?.savedQuery, "", "Backspace repeats delete exactly as native Input does");

    sendEditingPacket("d");
    sendEditingPacket("d");
    sendEditingPacket("\x1b[1;1:1D"); // Left press
    sendEditingPacket("\x1b[1;1:2D"); // Left repeat
    sendEditingPacket("\x1b[1;1:3D"); // release
    sendEditingPacket("x");
    assert.equal(harness.sidebar?.savedQuery, "xdd", "repeated Left moves the insertion point like native Input");
    sendEditingPacket("\x1b[1;1:1C"); // Right press
    sendEditingPacket("\x1b[1;1:2C"); // Right repeat
    sendEditingPacket("\x1b[1;1:3C"); // release
    sendEditingPacket("y");
    assert.equal(harness.sidebar?.savedQuery, "xddy", "repeated Right moves the insertion point like native Input");

    sendEditingPacket("\x15"); // Native Input Ctrl+U clears the query.
    await nextTurn();
    await nextTurn(); // redraws the displayed Saved row after filtering
    assert.equal(harness.sidebar?.savedQuery, "");
    assert.ok(plain(harness.writer.frames.at(-1)?.frame).includes("First conversation kitty-query-repeats"));

    const ctrlXPress = "\x1b[120;5:1u";
    const ctrlXRepeat = "\x1b[120;5:2u";
    const ctrlXRelease = "\x1b[120;5:3u";
    harness.terminal.emitInput(ctrlXPress); // app.session.delete
    assert.equal(harness.sidebar?.focus, "confirm");
    harness.terminal.emitInput(ctrlXRepeat);
    harness.terminal.emitInput(ctrlXRelease);
    assert.equal(harness.sidebar?.focus, "confirm", "delete repeat/release cannot start another action or reach Input");
    assert.equal(deletionCalls, 0);

    const ctrlCPress = "\x1b[99;5:1u";
    harness.terminal.emitInput(ctrlCPress); // tui.select.cancel
    assert.equal(harness.sidebar?.focus, "form");
    harness.terminal.emitInput("\x1b[99;5:2u");
    harness.terminal.emitInput("\x1b[99;5:3u");
    assert.equal(harness.sidebar?.focus, "form", "cancel repeat/release cannot dismiss or otherwise reactivate the picker");
    assert.equal(harness.sidebar?.savedQuery, "");
    assert.equal(deletionCalls, 0);
    await nextTurn(); // redraws the Saved row before the next deliberate delete press

    harness.terminal.emitInput(ctrlXPress);
    assert.equal(harness.sidebar?.focus, "confirm");
    harness.terminal.emitInput(ctrlXRepeat);
    harness.terminal.emitInput(ctrlXRelease);
    await nextTurn(); // settle the exact confirmation frame
    harness.terminal.emitInput("\x1b[13;1:1u"); // tui.select.confirm
    assert.equal(deletionCalls, 1);
    harness.terminal.emitInput("\x1b[13;1:2u");
    harness.terminal.emitInput("\x1b[13;1:3u");
    assert.equal(deletionCalls, 1, "confirm repeat/release cannot start a second deletion");
    assert.equal(harness.sidebar?.focus, "form");
    assert.equal(harness.sidebar?.savedQuery, "");
    assert.ok(existsSync(fixture.file), "the test deletion seam never mutates the saved file");
    assert.equal(await closeWithSignal(harness), 0);
    closed = true;
  } finally {
    referenceInput?.dispose();
    setKittyProtocolActive(previousKittyProtocol);
    if (!closed) await closeWithSignal(harness).catch(() => undefined);
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("confirmed Saved deletion uses shell-free trash fallback for only the displayed file and preserves Main owner", async () => {
  const fixture = makeSavedMainFixture("delete-confirmed");
  const siblingFile = join(fixture.agentDir, "sessions", "proj", "sibling.jsonl");
  writeFileSync(siblingFile, [
    JSON.stringify({ type: "session", version: 3, id: "saved-delete-sibling", timestamp: "2025-02-01T00:00:00.000Z", cwd: fixture.workspace }),
    JSON.stringify({ type: "message", id: "sibling", message: { role: "user", content: [{ type: "text", text: "Sibling conversation stays" }] } }),
  ].join("\n") + "\n", "utf8");
  writeFileSync(join(fixture.agentDir, "keybindings.json"), JSON.stringify({ "app.session.delete": "ctrl+x" }), "utf8");
  const { overrides } = savedFixtureDependencies(fixture);
  const trashCalls: Array<{ command: string; args: readonly string[] }> = [];
  const trashFailure = ((command: string, args: readonly string[]) => {
    trashCalls.push({ command, args: [...args] });
    return { pid: 9, output: [null, "", "trash unavailable"], stdout: "", stderr: "trash unavailable", status: 1, signal: null };
  }) as NonNullable<SavedSessionDeletionOptions["spawnSync"]>;
  const dependencies: MainTestDependencies = {
    ...overrides,
    deleteSavedFile: (file, options) => deleteSavedSessionFile(file, { ...options, spawnSync: trashFailure }),
  };
  const harness = createHarness({}, dependencies);
  let closed = false;
  try {
    const manager = await ready(harness);
    fillForm(harness.terminal, "/saved-delete-owner");
    await nextTurn();
    assert.equal(harness.sidebar?.activeMainOwnerID, "native-1");
    const ownerBefore = harness.sidebar?.activeMainOwnerID;
    const createsBefore = manager.createOptions.length;

    harness.terminal.emitInput(ALT_LEFT); // focus the roster without changing owner
    await nextTurn();
    harness.terminal.emitInput("\x1b[B"); // active owner -> Saved conversations
    await nextTurn();
    harness.terminal.emitInput(ENTER);
    for (let attempt = 0; attempt < 10; attempt += 1) {
      await nextTurn();
      const current = plain(harness.writer.frames.at(-1)?.frame);
      if (current.includes("First conversation delete-confirmed") && current.includes("Sibling conversati")) break;
    }
    assert.equal(harness.sidebar?.focus, "form");
    assert.ok(plain(harness.writer.frames.at(-1)?.frame).includes("Sibling conversati"), JSON.stringify(plain(harness.writer.frames.at(-1)?.frame)));
    const selectionBefore = harness.sidebar?.selectedId;
    const savedQuery: string = "First conversation delete-confirmed";
    harness.terminal.emitInput(savedQuery);
    for (let attempt = 0; attempt < 10; attempt += 1) {
      await nextTurn();
      const frame = harness.writer.frames.at(-1)?.frame;
      if (plain(frame).includes(savedQuery) && plain(frame).includes("> First convers")
        && !plain(frame).includes("Sibling conversation stays")) break;
    }
    assert.equal(harness.sidebar?.savedQuery, savedQuery);
    assertSavedPickerRightPanel(harness.writer.frames.at(-1)!.frame, savedQuery, "First convers");
    const pickerBeforeCancel = harness.sidebar?.savedPickerRequestId;
    const surface = manager.surface(ownerBefore!);
    assert.ok(surface);
    const childBefore = {
      cols: surface.cols,
      rows: surface.rows,
      frame: [...surface.writesAsFrame],
      resizeCalls: manager.resizeCalls.length,
    };

    harness.terminal.emitInput("\x18"); // user-configured Ctrl+X delete action
    await nextTurn();
    assert.equal(harness.sidebar?.focus, "confirm");
    const confirmationFrame = harness.writer.frames.at(-1)!.frame;
    assertSavedDeleteConfirmationRightPanel(confirmationFrame, fixture.file);
    const confirmation = plain(confirmationFrame);
    assert.ok(confirmation.includes("Delete saved conversation?"));
    assert.ok(confirmation.includes("Conversation:"), "the confirmation labels its bounded caption hint");
    assert.ok(!confirmation.includes(fixture.sessionId), "private session id is not shown in the confirmation");
    assert.deepEqual(trashCalls, [], "no mutation process starts before confirmation");

    const leftSavedRow = screenRowContaining(confirmationFrame, "Saved conversations");
    assert.ok(leftSavedRow > 0 && plainLine(confirmationFrame, leftSavedRow).slice(0, 32).includes("Saved conversations"),
      "the visible left roster is present beside the right-pane confirmation");
    const writesBeforeDialogInput = manager.writes.length;
    // The click lands on the row that already holds the LEFT highlight while
    // the confirmation is open: a pure no-op that keeps the dialog, its
    // picker, and the query draft exactly as they were (#486). A different
    // left row would cancel the UI first; a press inside the confirmation
    // pane stays dialog-owned either way.
    emitMouse(harness.terminal, 2, leftSavedRow);
    emitMouse(harness.terminal, 2, leftSavedRow, 0, "m");
    emitMouse(harness.terminal, 34, 1); // or the right/main confirmation pane
    emitMouse(harness.terminal, 34, 1, 0, "m");
    harness.terminal.emitInput("x"); // confirmation owns all keyboard input; arbitrary text is not forwarded
    assert.equal(harness.sidebar?.focus, "confirm");
    assert.equal(harness.sidebar?.savedDeleteConfirmationActive, true,
      "the same-row click keeps the confirmation open and confirmable");
    assert.equal(harness.sidebar?.savedPickerRequestId, pickerBeforeCancel);
    assert.equal(harness.sidebar?.savedQuery, savedQuery);
    assert.equal(manager.writes.length, writesBeforeDialogInput);
    assert.deepEqual(trashCalls, [], "dialog pointer and nonconfirm keyboard input cannot start deletion");
    assert.ok(existsSync(fixture.file));
    assert.deepEqual(manager.resizeCalls.length, childBefore.resizeCalls, "dialog input never resizes the native child");
    assert.equal(surface.cols, childBefore.cols);
    assert.equal(surface.rows, childBefore.rows);
    assert.deepEqual(surface.writesAsFrame, childBefore.frame, "the native child's retained viewport content is unchanged");

    harness.terminal.emitInput(ESC);
    await nextTurn();
    assert.equal(harness.sidebar?.focus, "form");
    assert.equal(harness.sidebar?.savedPickerRequestId, pickerBeforeCancel, "cancel restores the same picker owner");
    assert.equal(harness.sidebar?.savedQuery, savedQuery, "cancel restores the same query draft");
    assert.equal(harness.sidebar?.selectedId, selectionBefore, "cancel leaves roster selection unchanged");
    assert.equal(harness.sidebar?.activeMainOwnerID, ownerBefore, "cancel keeps the same native Main owner");
    assertSavedPickerRightPanel(harness.writer.frames.at(-1)!.frame, savedQuery, "First convers");
    assert.equal(manager.writes.length, writesBeforeDialogInput, "the child draft/input stream remains untouched");

    harness.terminal.emitInput("\x15"); // clear only for the subsequent successful refresh assertion
    for (let attempt = 0; attempt < 10; attempt += 1) {
      await nextTurn();
      if (harness.sidebar?.savedQuery === ""
        && plain(harness.writer.frames.at(-1)?.frame).includes("First conversation delete-confirmed")
        && plain(harness.writer.frames.at(-1)?.frame).includes("Sibling conversati")) break;
    }
    let pickerFrame = harness.writer.frames.at(-1)!.frame;
    if (!plain(pickerFrame).includes("> First convers")) {
      harness.terminal.emitInput("\x1b[B");
      await nextTurn();
      pickerFrame = harness.writer.frames.at(-1)!.frame;
    }
    assert.ok(plain(pickerFrame).includes("> First convers"), "the exact intended saved row is selected before re-confirming");

    harness.terminal.emitInput("\x18");
    await nextTurn();
    assertSavedDeleteConfirmationRightPanel(harness.writer.frames.at(-1)!.frame, fixture.file);
    harness.terminal.emitInput(ENTER);
    for (let attempt = 0; attempt < 10; attempt += 1) {
      await nextTurn();
      const current = plain(harness.writer.frames.at(-1)?.frame);
      if (!existsSync(fixture.file) && current.includes("Sibling conversation stays")) break;
    }
    assert.deepEqual(trashCalls, [{ command: "trash", args: [fixture.file] }],
      "the native trash command receives only the exact selected absolute path, without a shell");
    assert.equal(existsSync(fixture.file), false, "failed trash falls back to unlink of the selected file");
    assert.equal(existsSync(siblingFile), true, "the sibling saved file is untouched");
    assert.equal(harness.sidebar?.focus, "form");
    assert.equal(harness.sidebar?.savedQuery, "", "successful refresh preserves the query draft");
    assert.equal(harness.sidebar?.activeMainOwnerID, ownerBefore, "deletion never changes the active Main owner");
    assert.equal(harness.sidebar?.selectedId, selectionBefore, "deletion never changes roster selection");
    assert.equal(manager.createOptions.length, createsBefore, "deletion never creates a replacement Pi child");
    const refreshed = plain(harness.writer.frames.at(-1)?.frame);
    assert.ok(refreshed.includes("Sibling conversation stays"), "the global catalog refresh shows the surviving sibling");
    assert.ok(!refreshed.includes("First conversation delete-confirmed"));
    assert.equal(await closeWithSignal(harness), 0);
    closed = true;
  } finally {
    if (!closed) await closeWithSignal(harness).catch(() => undefined);
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("a different left-roster row cancels the open Saved-delete confirmation and its picker without deleting", async () => {
  const fixture = makeSavedMainFixture("left-click-cancel");
  writeFileSync(join(fixture.agentDir, "keybindings.json"), JSON.stringify({ "app.session.delete": "ctrl+x" }), "utf8");
  const { overrides } = savedFixtureDependencies(fixture);
  const trashCalls: Array<{ command: string; args: readonly string[] }> = [];
  const trashFailure = ((command: string, args: readonly string[]) => {
    trashCalls.push({ command, args: [...args] });
    return { pid: 13, output: [null, "", "trash unavailable"], stdout: "", stderr: "trash unavailable", status: 1, signal: null };
  }) as NonNullable<SavedSessionDeletionOptions["spawnSync"]>;
  const harness = createHarness({}, {
    ...overrides,
    deleteSavedFile: (file, options) => deleteSavedSessionFile(file, { ...options, spawnSync: trashFailure }),
  });
  let closed = false;
  try {
    const manager = await ready(harness);
    openSavedPicker(harness.terminal); // the Saved row takes the left highlight
    for (let attempt = 0; attempt < 10; attempt += 1) {
      await nextTurn();
      if (plain(harness.writer.frames.at(-1)?.frame).includes("First conversation left-click-cancel")) break;
    }
    assert.equal(harness.sidebar?.focus, "form");
    const pickerBefore = harness.sidebar?.savedPickerRequestId;
    assert.ok(pickerBefore !== undefined, "the picker owns its own id");
    harness.terminal.emitInput("\x18"); // user-configured Saved delete action
    await nextTurn();
    assert.equal(harness.sidebar?.focus, "confirm");
    const confirmationFrame = harness.writer.frames.at(-1)!.frame;
    assertSavedDeleteConfirmationRightPanel(confirmationFrame, fixture.file);
    const leftNewRow = screenRowContaining(confirmationFrame, "New session");
    const confirmationRow = screenRowContaining(confirmationFrame, "Delete saved conversation?");
    assert.ok(leftNewRow > 0, "the visible left roster is present beside the right-pane confirmation");
    assert.ok(confirmationRow > 0);
    const writesBefore = manager.writes.length;
    const resizeBefore = manager.resizeCalls.length;

    // Pointer ownership and the dialog's own pane stay inert.
    emitMouse(harness.terminal, 2, leftNewRow, 0, "m"); // release without its press
    emitMouse(harness.terminal, 2, leftNewRow, 32); // drag motion across the row
    emitMouse(harness.terminal, 2, leftNewRow, 2); // right-button press
    emitMouse(harness.terminal, 34, confirmationRow); // a press inside the confirmation
    emitMouse(harness.terminal, 34, confirmationRow, 0, "m");
    await nextTurn();
    assert.equal(harness.sidebar?.focus, "confirm", "only a left press on another written row acts");
    assert.equal(harness.sidebar?.savedPickerRequestId, pickerBefore);
    assert.equal(harness.sidebar?.savedDeleteConfirmationActive, true);
    assert.deepEqual(trashCalls, [], "no mutation process starts before confirmation");
    assert.equal(existsSync(fixture.file), true);

    // A different left row closes the confirmation AND its picker, then
    // performs the clicked row's ordinary action once.
    emitMouse(harness.terminal, 2, leftNewRow);
    for (let attempt = 0; attempt < 10; attempt += 1) {
      await nextTurn();
      if (plain(harness.writer.frames.at(-1)?.frame).includes("Workspace")) break;
    }
    assert.equal(harness.sidebar?.focus, "form", "the clicked New row opened its ordinary form");
    assert.equal(harness.sidebar?.savedDeleteConfirmationActive, false, "the confirmation closed");
    assert.equal(harness.sidebar?.savedPickerRequestId, undefined, "its picker closed with it");
    assert.equal(harness.sidebar?.savedQuery, "", "the dismissed picker keeps no query ownership");
    const after = plain(harness.writer.frames.at(-1)?.frame);
    assert.ok(after.includes("Workspace"), after);
    assert.equal(after.includes("Delete saved conversation?"), false, "the confirmation cannot resurrect itself");
    assert.deepEqual(trashCalls, [], "a pointer gesture never confirms a deletion");
    assert.equal(existsSync(fixture.file), true, "the saved file is untouched");
    assert.equal(manager.createOptions.length, 0, "cancelling and re-activating starts no child");
    assert.equal(manager.writes.length, writesBefore, "no mouse packet reaches the native child");
    assert.equal(manager.resizeCalls.length, resizeBefore, "no native child is resized");
    assert.equal(await closeWithSignal(harness), 0);
    closed = true;
  } finally {
    if (!closed) await closeWithSignal(harness).catch(() => undefined);
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("a left-roster click beside the live network pane closes it and decides nothing", async (t) => {
  const { harness, peer } = await peerMainHarness(t);
  const plainRow = (frame: ComposedHostFrame, row: number): string =>
    frame.lines[row]?.replace(/\x1b\[[0-9;]*m/g, "") ?? "";
  const leftRow = (frame: ComposedHostFrame, text: string): number =>
    frame.lines.findIndex((line, row) => row >= 1 && line.replace(/\x1b\[[0-9;]*m/g, "").slice(0, 32).includes(text));
  const rightText = (frame: ComposedHostFrame): string =>
    frame.lines.slice(1).map((line) => line.replace(/\x1b\[[0-9;]*m/g, "").slice(33)).join("\n");
  try {
    assert.ok(harness.manager !== undefined, "Main created its single session manager");
    const manager = harness.manager!;
    fillForm(harness.terminal, "/left-click-network");
    await nextTurn();
    const ownerBefore = harness.sidebar?.activeMainOwnerID;
    harness.terminal.emitInput(ALT_LEFT);
    await nextTurn();
    await activateRosterRow(harness, "Network");
    assert.equal(harness.sidebar?.focus, "form", "the Network pane owns the right-hand slot");
    const networkFrame = harness.writer.frames.at(-1)!.frame;
    assert.ok(rightText(networkFrame).includes("Network"), rightText(networkFrame));
    const writesBefore = manager.writes.length;
    const createsBefore = manager.createOptions.length;
    const commandsBefore = peer.commands.length;

    // The highlighted Network row is a pure no-op while its own pane is open.
    emitMouse(harness.terminal, 2, leftRow(networkFrame, "Network"));
    await nextTurn();
    assert.equal(harness.sidebar?.focus, "form", "the highlighted row keeps the pane open");
    assert.equal(peer.commands.length, commandsBefore, "the no-op sends nothing");
    assert.ok(rightText(harness.writer.frames.at(-1)!.frame).includes("Network"));

    // A different left row closes the whole pane first, then acts normally.
    emitMouse(harness.terminal, 2, leftRow(networkFrame, "New session"));
    for (let attempt = 0; attempt < 10; attempt += 1) {
      await nextTurn();
      const frame = harness.writer.frames.at(-1);
      if (frame !== undefined && rightText(frame.frame).includes("Workspace")) break;
    }
    const closedFrame = harness.writer.frames.at(-1)!.frame;
    assert.equal(harness.sidebar?.focus, "form", "the clicked New row opened its ordinary form");
    assert.ok(rightText(closedFrame).includes("Workspace"), rightText(closedFrame));
    assert.equal(rightText(closedFrame).includes("Network"), false, "the network pane is really closed");
    assert.equal(peer.commands.length, commandsBefore, "closing the network pane sends no command");
    assert.equal(manager.createOptions.length, createsBefore, "no destination or session was added");
    assert.equal(manager.writes.length, writesBefore, "no mouse packet reaches the native child");
    assert.equal(harness.sidebar?.activeMainOwnerID, ownerBefore, "the native Main owner is unchanged");
    assert.ok(plainRow(closedFrame, leftRow(closedFrame, "Network")).slice(0, 32).includes("Network"),
      "the Network row is still drawn for a later deliberate visit");

    // Its own row performs its ordinary action again afterwards.
    emitMouse(harness.terminal, 2, leftRow(closedFrame, "Network"));
    for (let attempt = 0; attempt < 10; attempt += 1) {
      await nextTurn();
      const frame = harness.writer.frames.at(-1);
      if (frame !== undefined && rightText(frame.frame).includes("Network")) break;
    }
    assert.equal(harness.sidebar?.focus, "form");
    assert.ok(rightText(harness.writer.frames.at(-1)!.frame).includes("Network"),
      "the clicked row reopens its ordinary pane");
    assert.equal(peer.commands.length, commandsBefore, "reopening the pane sends nothing either");
  } finally {
    assert.equal(await closeWithSignal(harness), 0);
  }
});

test("real frame-writer settlement gates Saved file deletion before callback, before drain, and after drain", async () => {
  const fixture = makeSavedMainFixture("delete-writer-settlement");
  writeFileSync(join(fixture.agentDir, "keybindings.json"), JSON.stringify({ "app.session.delete": "ctrl+x" }), "utf8");
  const { overrides } = savedFixtureDependencies(fixture);
  const output = new QueuedFrameOutput();
  const trashCalls: Array<{ command: string; args: readonly string[] }> = [];
  const trashFailure = ((command: string, args: readonly string[]) => {
    trashCalls.push({ command, args: [...args] });
    return { pid: 11, output: [null, "", "trash unavailable"], stdout: "", stderr: "trash unavailable", status: 1, signal: null };
  }) as NonNullable<SavedSessionDeletionOptions["spawnSync"]>;
  const harness = createHarness({}, {
    ...overrides,
    deleteSavedFile: (file, options) => deleteSavedSessionFile(file, { ...options, spawnSync: trashFailure }),
    createWriter: (_stdout, writerOptions) => createSessionHostFrameWriter(
      output as unknown as Writable,
      { ...writerOptions, redrawIntervalMs: 0 },
    ),
  });
  let closed = false;
  try {
    await ready(harness);
    openSavedPicker(harness.terminal);
    for (let attempt = 0; attempt < 10 && !output.writes.some((bytes) => bytes.toString("utf8").includes("First conversation delete-writer-settlement")); attempt += 1) {
      await nextTurn();
    }
    assert.ok(output.writes.some((bytes) => bytes.toString("utf8").includes("First conversation delete-writer-settlement")),
      "the current Saved picker frame settled before opening its confirmation");

    output.refuseNextWrite(false);
    harness.terminal.emitInput("\x18"); // Configured Saved delete action.
    for (let attempt = 0; attempt < 10 && output.queuedCount === 0; attempt += 1) await nextTurn();
    assert.equal(harness.sidebar?.focus, "confirm");
    assert.equal(output.queuedCount, 1, "the exact confirmation frame is held behind output backpressure");
    assertSavedDeleteConfirmationRightPanel(
      await emittedTerminalFrame(output, harness.terminal.columns, harness.terminal.rows, true),
      fixture.file,
    );
    harness.terminal.emitInput(ENTER);
    assert.deepEqual(trashCalls, [], "rendering and queueing the warning do not grant confirmation authority");
    assert.ok(existsSync(fixture.file));

    output.completeQueuedWrites(); // callback succeeds, but write() returned false and drain is still pending
    assertSavedDeleteConfirmationRightPanel(
      await emittedTerminalFrame(output, harness.terminal.columns, harness.terminal.rows),
      fixture.file,
    );
    harness.terminal.emitInput(ENTER);
    assert.deepEqual(trashCalls, [], "a callback without the required drain still cannot authorize deletion");
    assert.ok(existsSync(fixture.file));

    output.drain();
    await nextTurn();
    assertSavedDeleteConfirmationRightPanel(
      await emittedTerminalFrame(output, harness.terminal.columns, harness.terminal.rows),
      fixture.file,
    );
    harness.terminal.emitInput(ENTER);
    assert.deepEqual(trashCalls, [{ command: "trash", args: [fixture.file] }],
      "only the exact settled confirmation permits the shell-free trash attempt");
    assert.equal(existsSync(fixture.file), false, "failed trash falls back to unlink after the exact frame settles");
    assert.equal(await closeWithSignal(harness), 0);
    closed = true;
  } finally {
    if (!closed) {
      harness.signals.emit("SIGTERM");
      if (output.queuedCount > 0) output.drain();
      await harness.result.catch(() => undefined);
    }
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("real writer resize revokes a queued Saved warning until the complete exact target is redrawn", async () => {
  const fixture = makeSavedMainFixture("delete-resize-writer");
  writeFileSync(join(fixture.agentDir, "keybindings.json"), JSON.stringify({ "app.session.delete": "ctrl+x" }), "utf8");
  const { overrides } = savedFixtureDependencies(fixture);
  const output = new QueuedFrameOutput();
  let trashCalls = 0;
  const trashFailure = ((command: string, args: readonly string[]) => {
    trashCalls += 1;
    assert.equal(command, "trash");
    assert.deepEqual(args, [fixture.file]);
    return { pid: 12, output: [null, "", "trash unavailable"], stdout: "", stderr: "trash unavailable", status: 1, signal: null };
  }) as NonNullable<SavedSessionDeletionOptions["spawnSync"]>;
  const harness = createHarness({}, {
    ...overrides,
    deleteSavedFile: (file, options) => deleteSavedSessionFile(file, { ...options, spawnSync: trashFailure }),
    createWriter: (_stdout, writerOptions) => createSessionHostFrameWriter(
      output as unknown as Writable,
      { ...writerOptions, redrawIntervalMs: 0 },
    ),
  });
  let closed = false;
  try {
    await ready(harness);
    openSavedPicker(harness.terminal);
    for (let attempt = 0; attempt < 10 && !output.writes.some((bytes) => bytes.toString("utf8").includes("First conversation delete-resize-writer")); attempt += 1) {
      await nextTurn();
    }
    assert.ok(output.writes.some((bytes) => bytes.toString("utf8").includes("First conversation delete-resize-writer")));

    output.refuseNextWrite(false);
    harness.terminal.emitInput("\x18");
    for (let attempt = 0; attempt < 10 && output.queuedCount === 0; attempt += 1) await nextTurn();
    assert.equal(harness.sidebar?.focus, "confirm");
    assert.equal(output.queuedCount, 1);
    assertSavedDeleteConfirmationRightPanel(
      await emittedTerminalFrame(output, harness.terminal.columns, harness.terminal.rows, true),
      fixture.file,
    );
    harness.terminal.setSize(11, 3); // synchronous invalidation precedes the coalesced too-small redraw
    harness.terminal.emitInput(ENTER);
    assert.equal(trashCalls, 0, "Enter immediately after Main receives resize cannot use the old displayed warning");
    assert.ok(existsSync(fixture.file));
    await nextTurn(); // the tiny fallback is now the newest writer candidate

    output.completeQueuedWrites(); // obsolete full-warning bytes arrive after the resize
    harness.terminal.emitInput(ENTER);
    assert.equal(trashCalls, 0, "a stale confirmation callback cannot restore authority after geometry changed");
    output.drain();
    await nextTurn();
    const tinyOutputFrame = await emittedTerminalFrame(output, 11, 3);
    const tinyOutputText = tinyOutputFrame.lines.join("\n").replace(/\x1b\[[0-9;]*m/g, "");
    assert.ok(tinyOutputText.includes("too small"), "the emitted narrow overlay contains only its bounded tiny fallback");
    assert.equal(tinyOutputText.includes("Saved file:"), false, "the clipped/stale warning is absent after the tiny redraw");
    harness.terminal.emitInput(ENTER);
    assert.equal(trashCalls, 0, "the too-small frame itself never enables confirmation");
    assert.ok(existsSync(fixture.file));

    harness.terminal.setSize(80, 24);
    harness.terminal.emitInput(ENTER);
    assert.equal(trashCalls, 0, "restoring geometry does not reuse the old settlement before a new complete frame");
    await nextTurn();
    const restoredWarning = await emittedTerminalFrame(output, 80, 24);
    assertSavedDeleteConfirmationRightPanel(restoredWarning, fixture.file);

    harness.terminal.emitInput(ENTER);
    assert.equal(trashCalls, 1, "a fresh Enter succeeds after the restored exact warning settles");
    assert.equal(existsSync(fixture.file), false);
    assert.equal(await closeWithSignal(harness), 0);
    closed = true;
  } finally {
    if (!closed) {
      harness.signals.emit("SIGTERM");
      if (output.queuedCount > 0) output.drain();
      await harness.result.catch(() => undefined);
    }
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("an incomplete wide right-pane Saved warning cannot authorize deletion", async () => {
  const fixture = makeSavedMainFixture("delete-clipped-right-pane");
  writeFileSync(join(fixture.agentDir, "keybindings.json"), JSON.stringify({ "app.session.delete": "ctrl+x" }), "utf8");
  const { overrides } = savedFixtureDependencies(fixture);
  const output = new QueuedFrameOutput();
  let deleteCalls = 0;
  const harness = createHarness({}, {
    ...overrides,
    deleteSavedFile: () => {
      deleteCalls += 1;
      return { ok: false, method: "unlink", error: "synthetic refusal" };
    },
    createWriter: (_stdout, writerOptions) => createSessionHostFrameWriter(
      output as unknown as Writable,
      { ...writerOptions, redrawIntervalMs: 0 },
    ),
  });
  let closed = false;
  try {
    await ready(harness);
    openSavedPicker(harness.terminal);
    for (let attempt = 0; attempt < 10 && !output.writes.some((bytes) => bytes.toString("utf8").includes("First conversation delete-clipped-right-pane")); attempt += 1) {
      await nextTurn();
    }
    assert.ok(output.writes.some((bytes) => bytes.toString("utf8").includes("First conversation delete-clipped-right-pane")));

    harness.terminal.emitInput("\x18");
    await nextTurn();
    assert.equal(harness.sidebar?.focus, "confirm");
    harness.terminal.setSize(53, 2); // still wide: 20-column right pane, one content row
    harness.terminal.emitInput(ENTER); // resize synchronously revokes the previously settled wide warning
    assert.equal(deleteCalls, 0);
    await nextTurn();

    const clipped = await emittedTerminalFrame(output, 53, 2);
    const body = clipped.lines.slice(1).map((line) => line.replace(/\x1b\[[0-9;]*m/g, ""));
    const right = body.map((line) => line.slice(33)).join("\n");
    assert.ok(right.includes("too small"), "the actual right/main pane emits its too-small refusal");
    assert.equal(right.includes("Delete saved conversation?"), false);
    assert.equal(right.includes("Saved file:"), false, "an incomplete exact target is not displayed as a confirmation");
    harness.terminal.emitInput(ENTER);
    assert.equal(deleteCalls, 0, "the emitted clipped right-pane fallback cannot authorize deletion");
    assert.ok(existsSync(fixture.file));
    assert.equal(await closeWithSignal(harness), 0);
    closed = true;
  } finally {
    if (!closed) {
      harness.signals.emit("SIGTERM");
      if (output.queuedCount > 0) output.drain();
      await harness.result.catch(() => undefined);
    }
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("Saved deletion refuses an unavailable current live binding despite unrelated historical evidence", async () => {
  for (const phase of ["preparation", "confirmation", "fallback"] as const) {
    const fixture = makeSavedMainFixture(`delete-unavailable-binding-${phase}`);
    writeFileSync(join(fixture.agentDir, "keybindings.json"), JSON.stringify({ "app.session.delete": "ctrl+x" }), "utf8");
    const { overrides } = savedFixtureDependencies(fixture);
    let manager: FakeManager | undefined;
    let trashCalls = 0;
    let unlinkCalls = 0;
    const addUnavailableLiveBinding = (): void => {
      assert.ok(manager);
      manager.ownedLiveSessionsData = [{ id: "historical-unrelated-conversation" }];
      if (manager.views.some((view) => view.id === "unknown-current-binding")) return;
      manager.views.push({
        id: "unknown-current-binding",
        label: "Unavailable live binding",
        workspace: "/unknown-binding-workspace",
        agentDir: "/unknown-binding-agent",
        lifecycle: "alive",
        hasLiveProcess: true,
        busy: null,
        pendingInput: null,
        inputSurface: false,
        activity: [],
        nativeSession: null,
      });
    };
    const trashFailure = ((command: string, args: readonly string[]) => {
      trashCalls += 1;
      assert.equal(command, "trash");
      assert.deepEqual(args, [fixture.file]);
      if (phase === "fallback") addUnavailableLiveBinding();
      return { pid: 13, output: [null, "", "trash unavailable"], stdout: "", stderr: "trash unavailable", status: 1, signal: null };
    }) as NonNullable<SavedSessionDeletionOptions["spawnSync"]>;
    const harness = createHarness({}, {
      ...overrides,
      deleteSavedFile: (file, options) => deleteSavedSessionFile(file, {
        ...options,
        spawnSync: trashFailure,
        unlink: (path) => { unlinkCalls += 1; unlinkSync(path); },
      }),
    });
    let closed = false;
    try {
      manager = await ready(harness);
      if (phase === "preparation") addUnavailableLiveBinding();
      openSavedPicker(harness.terminal);
      for (let attempt = 0; attempt < 10 && !plain(harness.writer.frames.at(-1)?.frame).includes("First conversation delete-"); attempt += 1) {
        await nextTurn();
      }
      assert.ok(plain(harness.writer.frames.at(-1)?.frame).includes("First conversation delete-"));

      harness.terminal.emitInput("\x18");
      await nextTurn();
      if (phase === "preparation") {
        assert.equal(harness.sidebar?.focus, "form", "unknown current binding refuses before confirmation opens");
        assert.ok(plain(harness.writer.frames.at(-1)?.frame).includes("Close the Pi session using this conversation"));
        assert.equal(trashCalls, 0);
        assert.equal(unlinkCalls, 0);
        assert.ok(existsSync(fixture.file));
      } else {
        assert.equal(harness.sidebar?.focus, "confirm");
        await nextTurn(); // settle the exact warning before changing current live-binding state
        if (phase === "confirmation") addUnavailableLiveBinding();
        harness.terminal.emitInput(ENTER);
        await nextTurn();
        assert.equal(harness.sidebar?.focus, "form");
        assert.ok(plain(harness.writer.frames.at(-1)?.frame).includes("Close the Pi session using this conversation"),
          `${phase}: current-binding uncertainty produces the close-first warning`);
        assert.equal(trashCalls, phase === "fallback" ? 1 : 0,
          `${phase}: no trash attempt follows an uncertainty detected before that mutation stage`);
        assert.equal(unlinkCalls, 0, `${phase}: no unlink follows the newly unknown live binding`);
        assert.ok(existsSync(fixture.file), `${phase}: the selected saved file remains intact`);
      }
      assert.equal(await closeWithSignal(harness), 0);
      closed = true;
    } finally {
      if (!closed) await closeWithSignal(harness).catch(() => undefined);
      rmSync(fixture.root, { recursive: true, force: true });
    }
  }
});

test("Saved deletion cancellation and current live/unknown bindings fail closed", async () => {
  const fixture = makeSavedMainFixture("delete-live-guard");
  writeFileSync(join(fixture.agentDir, "keybindings.json"), JSON.stringify({ "app.session.delete": "ctrl+x" }), "utf8");
  const { overrides } = savedFixtureDependencies(fixture);
  let mutationCalls = 0;
  const fakeTrash = ((..._args: unknown[]) => {
    mutationCalls += 1;
    return { pid: 1, output: [null, "", ""], stdout: "", stderr: "", status: 0, signal: null };
  }) as NonNullable<SavedSessionDeletionOptions["spawnSync"]>;
  const harness = createHarness({}, {
    ...overrides,
    deleteSavedFile: (file, options) => deleteSavedSessionFile(file, { ...options, spawnSync: fakeTrash }),
  });
  let closed = false;
  try {
    const manager = await ready(harness);
    openSavedPicker(harness.terminal);
    await nextTurn();
    await nextTurn();

    harness.terminal.emitInput("\x18");
    await nextTurn();
    assert.equal(harness.sidebar?.focus, "confirm");
    harness.terminal.emitInput(ESC);
    await nextTurn();
    assert.equal(harness.sidebar?.focus, "form", "cancel restores the picker instead of dismissing it");
    assert.equal(harness.sidebar?.savedQuery, "", "cancel preserves the query");
    assert.ok(existsSync(fixture.file));
    assert.equal(mutationCalls, 0);

    manager.ownedLiveSessionsData = [{}]; // unknown binding is never treated as definitely unrelated
    harness.terminal.emitInput("\x18");
    await nextTurn();
    assert.equal(harness.sidebar?.focus, "form", "unknown live ownership refuses before confirmation");
    assert.ok(plain(harness.writer.frames.at(-1)?.frame).includes("Close the Pi session using this conversation"));
    assert.ok(existsSync(fixture.file));
    assert.equal(mutationCalls, 0);

    manager.ownedLiveSessionsData = [];
    harness.terminal.emitInput("\x18");
    await nextTurn();
    assert.equal(harness.sidebar?.focus, "confirm");
    await nextTurn(); // exact target warning is now displayed
    manager.ownedLiveSessionsData = [{ id: fixture.sessionId }]; // becomes live after preflight
    harness.terminal.emitInput(ENTER);
    await nextTurn();
    assert.equal(harness.sidebar?.focus, "form", "Main rechecks current owned sessions immediately before mutation");
    assert.ok(plain(harness.writer.frames.at(-1)?.frame).includes("Close the Pi session using this conversation"));
    assert.equal(mutationCalls, 0, "current live ownership prevents even starting trash");
    assert.ok(existsSync(fixture.file));
    assert.equal(harness.sidebar?.savedQuery, "");
    assert.equal(await closeWithSignal(harness), 0);
    closed = true;
  } finally {
    if (!closed) await closeWithSignal(harness).catch(() => undefined);
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("Saved unlink fallback refuses a file replaced during the trash attempt", async () => {
  const fixture = makeSavedMainFixture("delete-replacement-race");
  const { overrides } = savedFixtureDependencies(fixture);
  const heldOriginal = `${fixture.file}.held`;
  let unlinkAttempts = 0;
  const replaceDuringTrash = ((command: string, args: readonly string[]) => {
    assert.equal(command, "trash");
    assert.deepEqual(args, [fixture.file]);
    renameSync(fixture.file, heldOriginal);
    writeFileSync(fixture.file, `${JSON.stringify({ type: "session", version: 3, id: "replacement-session", timestamp: "2025-03-01T00:00:00.000Z", cwd: fixture.workspace })}\n`, "utf8");
    return { pid: 2, output: [null, "", "trash unavailable"], stdout: "", stderr: "trash unavailable", status: 1, signal: null };
  }) as NonNullable<SavedSessionDeletionOptions["spawnSync"]>;
  const harness = createHarness({}, {
    ...overrides,
    deleteSavedFile: (file, options) => deleteSavedSessionFile(file, {
      ...options,
      spawnSync: replaceDuringTrash,
      unlink: (path) => { unlinkAttempts += 1; unlinkSync(path); },
    }),
  });
  let closed = false;
  try {
    await ready(harness);
    openSavedPicker(harness.terminal);
    await nextTurn();
    await nextTurn();
    harness.terminal.emitInput("\x04"); // default app.session.delete = Ctrl+D
    await nextTurn();
    assert.equal(harness.sidebar?.focus, "confirm");
    await nextTurn();
    harness.terminal.emitInput(ENTER);
    await nextTurn();
    assert.equal(unlinkAttempts, 0, "replacement is caught by fallback-stage validation before unlink");
    assert.equal(existsSync(heldOriginal), true, "the originally cataloged file is preserved at its moved location");
    assert.equal(existsSync(fixture.file), true, "the replacement at the selected path is not removed");
    assert.match(readFileSync(fixture.file, "utf8"), /replacement-session/);
    assert.equal(harness.sidebar?.focus, "form");
    assert.equal(await closeWithSignal(harness), 0);
    closed = true;
  } finally {
    if (!closed) await closeWithSignal(harness).catch(() => undefined);
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

// --- #428: contained xterm diagnostics, clearable warning, private log -------

const MALFORMED_CSI_ELLIPSIS = "\x1b[3…";

function attachRealSurface(manager: FakeManager, id: string): TerminalSurface {
  const view = manager.views.find((candidate) => candidate.id === id);
  assert.ok(view, `row ${id} exists`);
  const fake = manager.surfaces.get(id)!;
  const surface = new TerminalSurface(fake.cols, fake.rows, {
    onChange: () => manager.options.onChange?.(id),
    onDiagnostic: (event) => manager.options.onTerminalDiagnostic?.(id, event),
  });
  manager.surfaces.set(id, surface as never);
  return surface;
}

/** A test-owned agent directory that outlives the harness run (cleaned by the test). */
function ownedAgentSetup(): { readonly agentDir: string; readonly overrides: MainTestDependencies } {
  const agentDir = makeMainTestDirectory("diagnostics-agent");
  writeFileSync(join(agentDir, "keybindings.json"), "{}", "utf8");
  return {
    agentDir,
    overrides: {
      createSessionSetup: () => ({
        nativeSetup: false,
        nativeAgentDir: agentDir,
        profileRegistry: { prepare: () => { throw new Error("fake manager"); } } satisfies ProfilePreparer,
      }),
    },
  };
}

function diagnosticsLogPath(agentDir: string): string {
  return join(agentDir, "session-host", "terminal-diagnostics.jsonl");
}

async function waitFor(predicate: () => boolean, label: string): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (predicate()) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
  assert.fail(`timed out waiting for ${label}`);
}

function captureConsoleAndStderr(): { readonly output: string[]; restore(): void } {
  const output: string[] = [];
  const methods = ["log", "info", "warn", "error", "debug", "trace"] as const;
  const originals = methods.map((method) => console[method]);
  for (const method of methods) {
    (console as unknown as Record<string, unknown>)[method] = (...args: unknown[]) => output.push(`${method}:${String(args[0])}`);
  }
  const originalWrite = process.stderr.write;
  process.stderr.write = ((chunk: unknown) => { output.push(`stderr:${String(chunk)}`); return true; }) as typeof process.stderr.write;
  return {
    output,
    restore() {
      methods.forEach((method, index) => { (console as unknown as Record<string, unknown>)[method] = originals[index]; });
      process.stderr.write = originalWrite;
    },
  };
}

test("#428 malformed child CSI warns in the composed UI, persists privately, and clears without touching the log", async (t) => {
  const owned = ownedAgentSetup();
  t.after(() => rmSync(owned.agentDir, { recursive: true, force: true }));
  const harness = createHarness({}, owned.overrides);
  harness.agentDir = owned.agentDir;
  const manager = await ready(harness);
  fillForm(harness.terminal, "/diagnostics/workspace");
  await nextTurn();
  assert.equal(harness.sidebar?.focus, "main");
  assert.equal(harness.sidebar?.activeMainOwnerID, "native-1");
  const surface = attachRealSurface(manager, "native-1");
  const capture = captureConsoleAndStderr();
  try {
    surface.write(`visible api_key=sk-SECRET ${MALFORMED_CSI_ELLIPSIS}after\r\nlater valid text`);
    await surface.flush();
    await nextTurn();
  } finally {
    capture.restore();
  }
  assert.deepEqual(capture.output, [], "no out-of-composition diagnostic output");
  assert.deepEqual(harness.reports, []);
  let frame = harness.writer.frames.at(-1)?.frame;
  assert.ok(plainLine(frame, 0).endsWith("! Terminal diagnostics: 1 (clear in sidebar)"), plainLine(frame, 0));
  assert.ok(plain(frame).includes("! Terminal diagnostics (1)"));
  assert.ok(plain(frame).includes("later valid text"), "the composed child frame keeps rendering");
  assert.ok(!plain(frame).includes("Parsing error") && !plain(frame).includes("xterm.js"));
  assert.equal(harness.sidebar?.focus, "main", "the warning never moves focus");

  await waitFor(() => existsSync(diagnosticsLogPath(harness.agentDir)), "private diagnostics log");
  await waitFor(() => readFileSync(diagnosticsLogPath(harness.agentDir), "utf8").includes("\"kind\":\"diagnostic\""), "diagnostic line");
  const logged = readFileSync(diagnosticsLogPath(harness.agentDir), "utf8");
  assert.ok(!logged.includes("SECRET") && !logged.includes("visible") && !logged.includes("…"), "no child text persisted");
  const diagnostic = logged.trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>)
    .find((entry) => entry.kind === "diagnostic")!;
  assert.equal(diagnostic.instance, "native-1");
  assert.equal(diagnostic.messageId, "parser-error");
  assert.equal((diagnostic.identity as unknown), undefined);

  // Explicit host-owned clear: roster focus, highlight the warning, Enter.
  const writesBefore = manager.writes.length;
  harness.terminal.emitInput(ALT_LEFT);
  await nextTurn();
  harness.terminal.emitInput("\x1b[B"); // native-1 card -> warning entry
  await nextTurn();
  harness.terminal.emitInput(ENTER);
  await nextTurn();
  frame = harness.writer.frames.at(-1)?.frame;
  assert.ok(!plainLine(frame, 0).includes("Terminal diagnostics"), "header warning cleared");
  assert.ok(!plain(frame).includes("! Terminal diagnostics ("), "sidebar warning cleared");
  assert.equal(harness.sidebar?.focus, "sidebar", "clearing does not activate or refocus anything");
  assert.equal(harness.sidebar?.activeMainOwnerID, "native-1");
  assert.equal(manager.writes.length, writesBefore, "no clear keystroke reached the child");
  assert.equal(readFileSync(diagnosticsLogPath(harness.agentDir), "utf8"), logged, "the log is preserved byte for byte");

  // A later error re-warns.
  surface.write(MALFORMED_CSI_ELLIPSIS);
  await surface.flush();
  await nextTurn();
  frame = harness.writer.frames.at(-1)?.frame;
  assert.ok(plainLine(frame, 0).endsWith("! Terminal diagnostics: 1 (clear in sidebar)"));

  assert.equal(await closeWithSignal(harness), 0);
  surface.dispose();
  const entries = readFileSync(diagnosticsLogPath(harness.agentDir), "utf8").trim().split("\n")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  assert.deepEqual(entries.map((entry) => entry.kind), ["host-run", "diagnostic", "diagnostic", "host-run-end"]);
  assert.equal((entries[0]!.identity as Record<string, string>).piVersion, "1.0.4");
});

test("#428 an unsafe log path shows a payload-free save-failure warning without interrupting work", { skip: process.platform === "win32" }, async (t) => {
  const owned = ownedAgentSetup();
  t.after(() => rmSync(owned.agentDir, { recursive: true, force: true }));
  const harness = createHarness({}, owned.overrides);
  harness.agentDir = owned.agentDir;
  const manager = await ready(harness);
  const stateDir = join(harness.agentDir, "session-host");
  if (!existsSync(stateDir)) mkdirSync(stateDir, { mode: 0o700 });
  const outside = join(harness.agentDir, "outside.txt");
  writeFileSync(outside, "keep\n");
  execFileSync("ln", ["-s", outside, diagnosticsLogPath(harness.agentDir)]);
  fillForm(harness.terminal, "/diagnostics/workspace");
  await nextTurn();
  const surface = attachRealSurface(manager, "native-1");
  surface.write(`secret-text ${MALFORMED_CSI_ELLIPSIS}`);
  await surface.flush();
  await waitFor(() => plainLine(harness.writer.frames.at(-1)?.frame, 0).includes("unsafe log file"), "save-failure warning");
  const frame = harness.writer.frames.at(-1)?.frame;
  assert.ok(plainLine(frame, 0).endsWith("! Terminal diagnostics: 1; unsafe log file (clear in sidebar)"));
  assert.ok(plain(frame).includes("NOT saved: unsafe log file"));
  assert.ok(!plain(frame).includes(outside) && !plain(frame).includes("Parsing error"), "no path or payload dump");
  assert.equal(readFileSync(outside, "utf8"), "keep\n", "the symlink target is untouched");
  // Ongoing work continues: Main input still routes to the same child.
  harness.terminal.emitInput("x");
  await nextTurn();
  assert.deepEqual(manager.writes.at(-1), { id: "native-1", data: "x" });
  assert.equal(await closeWithSignal(harness), 0);
  surface.dispose();
  assert.deepEqual(harness.reports, []);
});

test("#428 an unsettled diagnostics log is reported as cleanup failure, never as success", async () => {
  let closes = 0;
  const harness = createHarness({}, {
    createTerminalDiagnosticsLog: () => ({
      status: "ok",
      appendDiagnostic: () => undefined,
      noteSuppressed: () => undefined,
      close: async () => { closes += 1; return { settled: false, flushed: false, status: "ok" }; },
    }),
  });
  await ready(harness);
  assert.equal(await closeWithSignal(harness), 1);
  assert.equal(closes, 1);
  assert.deepEqual(harness.reports, ["Session host could not complete startup or cleanup."]);
});

test("#428 a rejected final log sync makes host shutdown report cleanup failure without payload", async (t) => {
  const owned = ownedAgentSetup();
  t.after(() => rmSync(owned.agentDir, { recursive: true, force: true }));
  let syncAttempts = 0;
  const harness = createHarness({}, {
    ...owned.overrides,
    createTerminalDiagnosticsLog: (logOptions) => new TerminalDiagnosticsLog({
      ...logOptions,
      syncFile: async () => {
        syncAttempts += 1;
        throw new Error(`EIO at ${owned.agentDir}`);
      },
    }),
  });
  harness.agentDir = owned.agentDir;
  const manager = await ready(harness);
  fillForm(harness.terminal, "/diagnostics/workspace");
  await nextTurn();
  const surface = attachRealSurface(manager, "native-1");
  surface.write(MALFORMED_CSI_ELLIPSIS);
  await surface.flush();
  await waitFor(() => existsSync(diagnosticsLogPath(owned.agentDir))
    && readFileSync(diagnosticsLogPath(owned.agentDir), "utf8").includes("\"kind\":\"diagnostic\""), "diagnostic line");
  assert.equal(await closeWithSignal(harness), 1, "a failed final flush is never a successful shutdown");
  surface.dispose();
  assert.equal(syncAttempts, 1);
  assert.deepEqual(harness.reports, ["Session host could not complete startup or cleanup."]);
  assert.ok(harness.reports.every((report) => !report.includes(owned.agentDir) && !report.includes("EIO")));
  assert.ok(readFileSync(diagnosticsLogPath(owned.agentDir), "utf8").includes("\"kind\":\"host-run-end\""),
    "accepted records were written before the sync failure");
});

/**
 * Wrap the real owning-host service so a wiring test can see exactly which
 * operations the production host performs through it. Nothing is substituted:
 * the same local service the host constructs is the one being observed.
 */
function recordOwningHostService(
  calls: string[],
  opened: unknown[],
  spawns: { parent: string; request: unknown }[],
): (dependencies: OwningHostServiceDependencies) => OwningHostService {
  return (dependencies) => {
    const service = createLocalOwningHostService(dependencies);
    return new Proxy(service, {
      get(target, property) {
        const value = Reflect.get(target, property);
        if (typeof value !== "function") return value;
        return (...args: unknown[]) => {
          calls.push(String(property));
          if (property === "spawnRequestedChild") spawns.push({ parent: String(args[0]), request: args[1] });
          const result = (value as (...a: unknown[]) => unknown).apply(target, args);
          if (property === "openManager") opened.push(result);
          return result;
        };
      },
    });
  };
}

test("the host runs every session operation through one local owning-host service", async () => {
  const calls: string[] = [];
  const opened: unknown[] = [];
  const spawns: { parent: string; request: unknown }[] = [];
  let constructions = 0;
  const harness = createHarness({}, {
    createOwningHostService: (dependencies) => {
      constructions += 1;
      return recordOwningHostService(calls, opened, spawns)(dependencies);
    },
  });
  const manager = await startTwoSessions(harness);

  assert.equal(constructions, 1, "one host run owns exactly one session operation boundary");
  assert.equal(calls.filter((name) => name === "openManager").length, 1,
    "the host opens exactly one authoritative manager, through the service");
  assert.equal(opened[0], manager, "the manager the service opened is the manager the host uses");
  assert.equal(calls.filter((name) => name === "startSession").length, 2,
    "both deliberate New sessions went through the service start path");
  assert.equal(calls.includes("spawnRequestedChild"), false,
    "no background child is admitted before one is requested");

  const sidebar = harness.sidebar;
  assert.ok(sidebar);
  const before = {
    selectedId: sidebar.selectedId,
    focus: sidebar.focus,
    activeMainOwnerID: sidebar.activeMainOwnerID,
    visible: sidebar.visible,
  };
  const spawn = manager.options.onSpawnRequest;
  assert.equal(typeof spawn, "function");
  const request = {
    workspace: "/requested/existing/workspace",
    title: "Exact sibling title",
    prompt: "@/literal\n--session is prompt content\n",
  };
  assert.equal(await spawn!("native-2", request), "started");
  assert.deepEqual(spawns, [{ parent: "native-2", request }],
    "the broker-authenticated request is admitted by the owning-host service, with the parent id the manager supplied");
  assert.deepEqual(manager.createOptions.at(-1), {
    workspace: request.workspace,
    initialRequest: { title: request.title, prompt: request.prompt },
  }, "the exact workspace/title/prompt still reach the one manager unchanged");
  assert.equal(manager.views.length, 3, "the background child is an independent new row");
  assert.deepEqual({
    selectedId: sidebar.selectedId,
    focus: sidebar.focus,
    activeMainOwnerID: sidebar.activeMainOwnerID,
    visible: sidebar.visible,
  }, before, "the service-owned background path changes no presentation or Main ownership state");

  assert.equal(await closeWithSignal(harness), 0);
  assert.ok(calls.includes("observeOwnedChildSettlement"),
    "teardown takes its owned-child settlement evidence from the same service");
});

test("a background child that finishes launching while the host quits is unknown, not a failure", async () => {
  const harness = createHarness();
  const manager = await ready(harness);
  fillForm(harness.terminal, "/first/workspace");
  await nextTurn();

  let releaseCreate!: () => void;
  let enterCreate!: () => void;
  const createEntered = new Promise<void>((resolve) => { enterCreate = resolve; });
  manager.createGate = new Promise<void>((resolve) => { releaseCreate = resolve; });
  manager.createGateEntered = enterCreate;

  const spawn = manager.options.onSpawnRequest;
  assert.equal(typeof spawn, "function");
  const pending = spawn!("native-1", {
    workspace: "/requested/existing/workspace",
    title: "Pending sibling title",
    prompt: "pending sibling prompt",
  });
  await createEntered;
  assert.equal(manager.views.length, 2);

  harness.signals.emit("SIGTERM");
  releaseCreate();
  assert.equal(await pending, "unknown",
    "a child that finished launching during teardown may exist; the host never claims a definite result");
  assert.equal(await harness.result, 0, "the uncertain child still settles inside the owned teardown");
  assert.equal(harness.sidebar?.activeMainOwnerID, "native-1",
    "the quitting host never moved Main ownership to the background child");
});
