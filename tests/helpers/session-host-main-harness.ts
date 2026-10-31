/**
 * Test-only canonical base harness shared by the Main test modules.
 *
 * Owns the synthetic Main dependency wiring, fake terminal/broker/manager
 * surfaces, owned scratch directories, and common written-frame/input helpers.
 * It registers no tests and contains no remote-domain state; the remote
 * fixtures live in `./session-host-main-remote.ts` and import this module.
 */
import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Writable } from "node:stream";

import type { ComposedHostFrame } from "../../src/session-host/compositor";
import type {
  CreateInstanceOptions,
  InstanceManagerOptions,
  NativeInstanceView,
  SessionGeometry,
  SessionViewerState,
  SessionViewerUpdate,
  SessionViewerUpdateResult,
  ShutdownResult,
} from "../../src/session-host/instances";
import type {
  SessionHostFrameDisposition,
  SessionHostFrameWriterOptions,
} from "../../src/session-host/frame-writer";
import type { KeyboardCapabilityObserverOptions } from "../../src/session-host/input";
import type { StatusBroker, StatusRenameRequest, StatusRenameResult } from "../../src/session-host/broker";
import type { ProfilePreparer } from "../../src/session-host/profiles";
import { SidebarController, type SidebarAction } from "../../src/session-host/sidebar";
import type {
  TerminalFrame,
  TerminalInputModes,
  TerminalMouseReportingRequest,
} from "../../src/session-host/terminal-surface";
import type { TerminalGraphicsFrame } from "../../src/session-host/kitty-graphics";
import type { SessionHostNativeSession } from "../../src/session-host/protocol";
import type { PeerCoordinator, PeerUiCommand, PeerUiConsent, PeerUiSnapshot } from "../../src/session-host/peer-ui-protocol";
import type { PeerCoordinatorOptions } from "../../src/session-host/network/peer-coordinator";
import { __test, type SessionHostOptions } from "../../src/session-host/main";
import { FakeViewerSeam } from "../session-host-viewer-fakes";

export const ESC = "\x1b";
export const ALT_LEFT = `${ESC}[1;3D`;
export const ENTER = "\r";

export const MAIN_TEST_SCRATCH_ROOT = join(process.cwd(), "node_modules", ".cache", "session-host-main-tests");

export function makeMainTestDirectory(prefix: string): string {
  mkdirSync(MAIN_TEST_SCRATCH_ROOT, { recursive: true });
  return mkdtempSync(join(MAIN_TEST_SCRATCH_ROOT, `${prefix}-`));
}

export class FakeInput extends EventEmitter {
  readonly isTTY = true;
  readableEnded = false;
}

export class QueuedFrameOutput extends EventEmitter {
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

export class FakeOutput extends EventEmitter {
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

export class FakeTerminal {
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

export class FakeObserver {
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

export class FakeWriter {
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
      if (this.queueWrites) {
        // Opt-in: retain every in-flight settlement in order, so a test can
        // settle an older frame as actually written before a newer identical
        // candidate is reported unchanged.
        this.queuedSettles.push({ settle: onSettled });
      } else {
        this.pendingSettle = onSettled; // the superseded candidate is dropped, unsettled
      }
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
  /** Opt-in: retain every held settlement instead of only the newest candidate. */
  queueWrites = false;
  readonly queuedSettles: Array<{ settle?: (disposition: SessionHostFrameDisposition) => void }> = [];
  heldSubmits = 0;
  private pendingSettle: ((disposition: SessionHostFrameDisposition) => void) | undefined;

  /** Settle one retained in-flight submission with an explicit disposition. */
  settleQueued(index: number, disposition: SessionHostFrameDisposition): void {
    const [entry] = this.queuedSettles.splice(index, 1);
    entry?.settle?.(disposition);
  }

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

export class FakeSurface {
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

export class FakeManager {
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

export type MainTestDependencies = NonNullable<Parameters<typeof __test.runWithDependencies>[1]>;

export interface Harness {
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

export function options(overrides: Partial<SessionHostOptions> = {}): SessionHostOptions {
  return {
    packageRoot: process.cwd(),
    stateRoot: "/synthetic/session-host-state",
    args: [],
    env: { PATH: process.env.PATH, HOME: "/synthetic-home" },
    ...overrides,
  };
}

export function createHarness(
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
    nodeVersion: "22.23.4",
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

export class FakePeerCoordinator implements PeerCoordinator {
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
    settings: {
      hostingEnabled: false, bindHost: "", bindPort: null, autoReconnect: false, bellEnabled: true,
      viewerNativeInputEnabled: true, remoteHistoryDeleteEnabled: true,
    },
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
  readonly repairs: number[] = [];
  async repairStorageProtection(generation: number): Promise<"ran" | "stale" | "busy" | "not-run"> {
    this.repairs.push(generation);
    this.publish({ storage: { ...this.snapshot.storage!, repair: { state: "restart-required", outcome: "repaired", priorExposurePossible: true } } });
    return "ran";
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

export async function peerMainHarness(
  t: { after(callback: () => void): void },
  configure?: (peer: FakePeerCoordinator) => void,
  extraDependencies: MainTestDependencies = {},
  suppliedPeer?: FakePeerCoordinator,
): Promise<{
  harness: Harness; peer: FakePeerCoordinator; dispatch(action: SidebarAction): void; releases(): number;
}> {
  const agentDir = makeMainTestDirectory("peer-ui-agent");
  writeFileSync(join(agentDir, "keybindings.json"), "{}", "utf8");
  t.after(() => rmSync(agentDir, { recursive: true, force: true }));
  // The coordinator Main actually receives is the one this harness publishes and
  // asserts on, so a content-capable fake needs no second coordinator anywhere.
  const peer = suppliedPeer ?? new FakePeerCoordinator();
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

/**
 * The ordinary indented owner-host line directly above the selected roster
 * marker. Remote cards put their host line under the title and keep the
 * selection marker on the status line, exactly like a local card.
 */
export function selectedRosterHostLine(harness: Harness): string {
  const lines = harness.writer.frames.at(-1)?.frame.lines
    .map((line) => line.replace(/\x1b\[[0-9;]*m/g, "")) ?? [];
  const markerRow = lines.findIndex((line) => line.startsWith("> "));
  return markerRow > 0 ? lines[markerRow - 1] ?? "" : "";
}

export async function nextTurn(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

export async function started(harness: Harness): Promise<FakeManager> {
  await nextTurn();
  assert.ok(harness.manager, "manager initialized after Pi preflight and broker setup");
  return harness.manager;
}

export async function ready(harness: Harness, flags = 0): Promise<FakeManager> {
  const manager = await started(harness);
  assert.equal(harness.observer.waitCalls, 1, "Main waits for actual keyboard negotiation before spawning children");
  assert.ok(harness.events.indexOf("resolve") < harness.events.indexOf("observer.construct"), "Pi entry/version probe precedes the observer constructor");
  assert.ok(harness.events.indexOf("resolve") < harness.events.indexOf("terminal.construct"), "Pi entry/version probe precedes the public terminal constructor");
  harness.observer.settle(flags);
  await nextTurn();
  return manager;
}

export function fillForm(terminal: FakeTerminal, workspace = "/explicit/workspace"): void {
  terminal.emitInput(ENTER); // New session
  completeForm(terminal, workspace);
}

export function completeForm(terminal: FakeTerminal, workspace = "/explicit/workspace"): void {
  terminal.emitInput("\x15"); // replace any retained workspace draft
  terminal.emitInput(workspace);
  terminal.emitInput(ENTER); // submit
}

export async function closeWithSignal(harness: Harness, signal = "SIGTERM"): Promise<number> {
  harness.signals.emit(signal);
  return harness.result;
}

export function plain(frame: ComposedHostFrame | undefined): string {
  return frame?.lines.join("\n").replace(/\x1b\[[0-9;]*m/g, "") ?? "";
}

export function plainLine(frame: ComposedHostFrame | undefined, row: number): string {
  return frame?.lines[row]?.replace(/\x1b\[[0-9;]*m/g, "") ?? "";
}

export function emitMouse(
  terminal: FakeTerminal,
  column: number,
  row: number,
  button = 0,
  final: "M" | "m" = "M",
): void {
  terminal.emitInput(`${ESC}[<${button};${column + 1};${row + 1}${final}`);
}
