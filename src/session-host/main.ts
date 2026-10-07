import { EventEmitter } from "node:events";
import { realpathSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import type { Writable } from "node:stream";
import { ProcessTerminal } from "pi-session-host-tui";

import { createStatusBroker, type StatusBroker } from "./broker";
import { composeHostFrame, computeHostLayout, type HostFocus, type HostLayout, type RenderedSidebar } from "./compositor";
import { createSessionHostFrameWriter, type SessionHostFrameWriter } from "./frame-writer";
import { createSessionHostTextField, type SessionHostFieldKeybindings } from "./field-editor";
import { loadNativeFieldKeybindings, runNativeExternalEditor } from "./form-support";
import { normalizeNativeSourceInput, translateInput, KeyboardCapabilityObserver } from "./input";
import {
  InstanceManager,
  type CreateInstanceOptions,
  type InstanceManagerOptions,
  type InstanceStatusRegistration,
  type InstanceStatusUpdate,
  type NativeInstanceView,
  type ShutdownResult,
  type StatusRegistrar,
} from "./instances";
import { resolveNativePi, RUNTIME_ROLE_ENV, EXECUTOR_TOOL_CATALOG_ENV } from "./launch";
import { NativeAgentRegistry, type ProfilePreparer } from "./profiles";
import { SidebarController, type SidebarAction, type SidebarFieldFactoryOptions, type SidebarItem } from "./sidebar";
import type { TerminalInputModes } from "./terminal-surface";

const STARTUP_OPTIONS_HELPER = join("scripts", "session-host-startup-options.cjs");
const GENERIC_FAILURE_MESSAGE = "Session host could not complete startup or cleanup.";
const GENERIC_CREATE_FAILURE = "Session could not be started. Check the workspace, then try again.";
const REMOVE_REFUSED_MESSAGE = "Session not removed; it may be live, unconfirmed, or no longer available.";
const REMOVE_FAILURE_MESSAGE = "Session was not removed; its state could not be confirmed.";
const INPUT_DRAIN_MAX_MS = 250;
const INPUT_DRAIN_IDLE_MS = 50;

/** Public options for the optional standalone native session host. */
export interface SessionHostOptions {
  packageRoot: string;
  piExecutable?: string;
  /** Existing private directory for transient broker transport; never a Pi agent/profile root. */
  stateRoot?: string;
  toggleKey?: string;
  args: readonly string[];
  env: NodeJS.ProcessEnv;
}

type MainTerminal = Pick<ProcessTerminal,
  "start" | "stop" | "drainInput" | "write" | "columns" | "rows" | "kittyProtocolActive" | "modifyOtherKeysActive"
>;
type MainManager = Pick<InstanceManager,
  "list" | "surface" | "write" | "resize" | "hasLiveProcesses" | "create" | "rename" | "closeExited" | "shutdown" | "dispose"
>;
type MainObserver = Pick<KeyboardCapabilityObserver, "flags" | "wait" | "dispose" | "feed">;
type MainWriter = Pick<SessionHostFrameWriter, "start" | "submit" | "close">;
type MainStdin = EventEmitter & { isTTY?: boolean; readableEnded?: boolean };
type MainStdout = Writable & EventEmitter & { isTTY?: boolean; columns?: number; rows?: number };
type MainSignals = EventEmitter;

interface HostSnapshot {
  readonly packageRoot: string;
  readonly piExecutable?: string;
  readonly stateRoot?: string;
  readonly toggleKey?: string;
  readonly args: readonly string[];
  readonly env: NodeJS.ProcessEnv;
  readonly startupCwd: string;
}

interface MainDependencies {
  readonly platform: string;
  readonly nodeVersion: string;
  readonly stdin: MainStdin;
  readonly stdout: MainStdout;
  readonly signals: MainSignals;
  readonly resolvePi: (options: { executable?: string; env: NodeJS.ProcessEnv }) => { file: string; version: string };
  readonly createBroker: (options?: { socketRoot?: string }) => Promise<StatusBroker>;
  readonly createSessionSetup: (options: { env: NodeJS.ProcessEnv }) => {
    nativeSetup: boolean;
    profileRegistry: ProfilePreparer;
    nativeAgentDir?: string;
  };
  readonly createManager: (options: InstanceManagerOptions) => MainManager;
  readonly createSidebar: (options: ConstructorParameters<typeof SidebarController>[0]) => SidebarController;
  readonly createTerminal: () => MainTerminal;
  readonly createObserver: (options: ConstructorParameters<typeof KeyboardCapabilityObserver>[0]) => MainObserver;
  readonly createWriter: (output: Writable, options: Parameters<typeof createSessionHostFrameWriter>[1]) => MainWriter;
  readonly runExternalEditor: typeof runNativeExternalEditor;
  readonly reportError: (message: string) => void;
}

class MainFailure extends Error {
  constructor(readonly phase: "startup-options" | "preflight" | "runtime") {
    super(phase);
  }
}

function snapshotOptions(options: SessionHostOptions): HostSnapshot {
  // Snapshot both mutable inputs before validation, startup admission, probing,
  // or any await. All per-row launches use these detached copies.
  const args = Object.freeze([...(options?.args ?? [])]);
  const env = { ...(options?.env ?? {}) };
  return {
    packageRoot: options?.packageRoot,
    piExecutable: options?.piExecutable,
    stateRoot: options?.stateRoot,
    toggleKey: options?.toggleKey,
    args,
    env,
    startupCwd: process.cwd(),
  };
}

function assertStartupOptions(snapshot: HostSnapshot): string {
  if (typeof snapshot.packageRoot !== "string" || !isAbsolute(snapshot.packageRoot)) {
    throw new MainFailure("startup-options");
  }
  let packageRoot: string;
  let helper: unknown;
  try {
    packageRoot = realpathSync(snapshot.packageRoot);
    // Do not search ancestor directories: the helper is part of this exact,
    // canonical package root and is shared with the parent launcher.
    helper = require(join(packageRoot, STARTUP_OPTIONS_HELPER));
  } catch {
    throw new MainFailure("startup-options");
  }
  const assertOptions = (helper as { assertSessionHostStartupOptions?: unknown } | null)?.assertSessionHostStartupOptions;
  if (typeof assertOptions !== "function") {
    throw new MainFailure("startup-options");
  }
  try {
    (assertOptions as (args: readonly string[], env: NodeJS.ProcessEnv) => void)(snapshot.args, snapshot.env);
  } catch {
    // The shared helper's message is already bounded, but keep Main's
    // diagnostics fixed as a defense against unexpected helper failures.
    throw new MainFailure("startup-options");
  }
  return packageRoot;
}

function assertPreflight(snapshot: HostSnapshot, dependencies: MainDependencies): void {
  if (dependencies.platform !== "darwin" && dependencies.platform !== "linux") {
    throw new MainFailure("preflight");
  }
  if (!stableNodeVersion(dependencies.nodeVersion)) {
    throw new MainFailure("preflight");
  }
  if (!dependencies.stdin.isTTY || !dependencies.stdout.isTTY) {
    throw new MainFailure("preflight");
  }
  if (snapshot.env[RUNTIME_ROLE_ENV] || snapshot.env[EXECUTOR_TOOL_CATALOG_ENV]) {
    throw new MainFailure("preflight");
  }
  if (!Array.isArray(snapshot.args) || snapshot.args.some((arg) => typeof arg !== "string")) {
    throw new MainFailure("preflight");
  }
}

function safeReport(dependencies: MainDependencies, message: string): void {
  try {
    dependencies.reportError(message);
  } catch {
    // Diagnostics never override ownership cleanup or caller streams.
  }
}

function clampDimension(value: unknown, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.max(1, Math.min(1000, Math.floor(value)));
}

function nativeKeyHint(
  manager: SessionHostFieldKeybindings,
  action: string,
  fallback: string,
  excludedActions: readonly string[] = [],
): string {
  try {
    const source = manager as SessionHostFieldKeybindings & { getKeys?: (keybinding: string) => string[] };
    const keys = source.getKeys?.(action);
    if (!Array.isArray(keys)) return fallback;
    const excluded = new Set(excludedActions.flatMap((binding) => source.getKeys?.(binding) ?? []));
    const effective = keys.filter((key) => !excluded.has(key));
    return effective.length === 0 ? "unbound" : effective.join("/");
  } catch {
    return fallback;
  }
}

function stableNodeVersion(version: string): boolean {
  const parsed = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (!parsed) return false;
  const [major, minor] = parsed.slice(1).map(Number);
  return major !== undefined && minor !== undefined && (major > 22 || (major === 22 && minor >= 19));
}

function sidebarFocus(focus: SidebarController["focus"]): HostFocus {
  return focus;
}

function statusRegistrar(broker: StatusBroker): StatusRegistrar {
  return {
    register(instanceId, handlers) {
      const registration = broker.register(instanceId, {
        onStatus: (status) => {
          const update: InstanceStatusUpdate = {
            busy: status.busy,
            pendingInput: status.pendingInput,
            inputSurface: status.inputSurface,
            activity: status.activity,
            ...(status.nativeSession === undefined ? {} : { nativeSession: status.nativeSession }),
          };
          handlers.onStatus(update);
        },
        onDisconnect: handlers.onDisconnect,
      });
      return registration as InstanceStatusRegistration;
    },
  };
}

function toSidebarItem(view: NativeInstanceView): SidebarItem {
  const item: SidebarItem = {
    id: view.id,
    label: view.label,
    workspace: view.workspace,
    agentDir: view.agentDir,
    lifecycle: view.lifecycle,
    hasLiveProcess: view.hasLiveProcess,
    busy: view.busy,
    pendingInput: view.pendingInput,
    inputSurface: view.inputSurface,
    activity: view.activity,
    nativeSession: view.nativeSession,
  };
  if (view.exitCode !== undefined) {
    return { ...item, exitCode: view.exitCode };
  }
  return item;
}

function productionDependencies(): MainDependencies {
  return {
    platform: process.platform,
    nodeVersion: process.versions.node,
    stdin: process.stdin as unknown as MainStdin,
    stdout: process.stdout as unknown as MainStdout,
    signals: process as unknown as MainSignals,
    resolvePi: resolveNativePi,
    createBroker: (options) => createStatusBroker(options),
    createSessionSetup: ({ env }) => {
      const registry = new NativeAgentRegistry({ env });
      return { nativeSetup: true, profileRegistry: registry, nativeAgentDir: registry.agentDir };
    },
    createManager: (options) => new InstanceManager(options),
    createSidebar: (options) => new SidebarController(options),
    createTerminal: () => new ProcessTerminal(),
    createObserver: (options) => new KeyboardCapabilityObserver(options),
    createWriter: (output, options) => createSessionHostFrameWriter(output, options),
    runExternalEditor: runNativeExternalEditor,
    reportError: (message) => { process.stderr.write(`${message}\n`); },
  };
}

/**
 * Run an opt-in native session host. The module is inert until this function is
 * called; it does not construct a terminal, broker, setup registry, timer, listener,
 * or PTY as an import side effect.
 */
export async function runSessionHost(options: SessionHostOptions): Promise<number> {
  let snapshot: HostSnapshot;
  try {
    snapshot = snapshotOptions(options);
  } catch {
    safeReport(productionDependencies(), GENERIC_FAILURE_MESSAGE);
    return 1;
  }
  return runSessionHostController(snapshot, productionDependencies());
}

async function runSessionHostController(snapshot: HostSnapshot, dependencies: MainDependencies): Promise<number> {
  let packageRoot: string;
  try {
    packageRoot = assertStartupOptions(snapshot);
    assertPreflight(snapshot, dependencies);
  } catch (error) {
    safeReport(dependencies, error instanceof MainFailure && error.phase === "startup-options"
      ? "Session host startup options were rejected."
      : "Session host preflight failed.");
    return 1;
  }

  let broker: StatusBroker | undefined;
  let manager: MainManager | undefined;
  let terminal: MainTerminal | undefined;
  let observer: MainObserver | undefined;
  let writer: MainWriter | undefined;
  let sidebar: SidebarController | undefined;
  let terminalStartAttempted = false;
  let terminalStarted = false;
  let observerListenerAttached = false;
  let startupComplete = false;
  let shutdownRequested = false;
  let runtimeFailure = false;
  let cleanupFailure = false;
  let activeId: string | undefined;
  let views: NativeInstanceView[] = [];
  // Successful removals are terminal for this host id. A delayed roster
  // notification must not resurrect a detached row.
  const removedExitedIds = new Set<string>();
  let layout: HostLayout | undefined;
  let lastNativeCols: number | undefined;
  let lastNativeRows: number | undefined;
  let resizeInProgress = false;
  let rosterSyncInProgress = false;
  let rosterSyncQueued = false;
  let redrawQueued = false;
  let negotiationReady = false;
  let observedFlags = 0;
  let passiveInputListener: ((data: string | Buffer) => void) | undefined;
  let mouseTrackingMode: number | undefined;
  let mouseSgrEnabled = false;
  let forcedCount = 0;
  let remainingCount = 0;
  let shutdownPromise: Promise<void> | undefined;
  let externalEditorActive = false;
  let externalEditorAbort: AbortController | undefined;
  let externalEditorTask: Promise<string | undefined> | undefined;
  const createTasks = new Set<Promise<void>>();
  const deferredCreates = new Map<number, Extract<SidebarAction, { type: "create" }>>();
  let finishRun!: (status: number) => void;
  const runFinished = new Promise<number>((resolve) => { finishRun = resolve; });

  const onSignal = (): void => requestShutdown(false);
  const onInputEnd = (): void => requestShutdown(false);
  const onOutputError = (): void => requestShutdown(true);
  const removeOuterListeners = (): void => {
    for (const signal of ["SIGTERM", "SIGHUP", "SIGINT"] as const) {
      try {
        dependencies.signals.removeListener(signal, onSignal);
      } catch {
        cleanupFailure = true;
      }
    }
    try {
      dependencies.stdin.removeListener("end", onInputEnd);
    } catch {
      cleanupFailure = true;
    }
    try {
      dependencies.stdout.removeListener("error", onOutputError);
    } catch {
      cleanupFailure = true;
    }
  };

  function requestShutdown(failed: boolean): void {
    shutdownRequested = true;
    if (failed) runtimeFailure = true;
    try { externalEditorAbort?.abort(); } catch { /* exact child ownership is contained by the helper */ }
    if (startupComplete) beginShutdown();
  }

  function addOuterListeners(): void {
    dependencies.signals.on("SIGTERM", onSignal);
    dependencies.signals.on("SIGHUP", onSignal);
    dependencies.signals.on("SIGINT", onSignal);
    dependencies.stdin.on("end", onInputEnd);
    dependencies.stdout.on("error", onOutputError);
  }

  function findActiveView(): NativeInstanceView | undefined {
    return activeId === undefined ? undefined : views.find((view) => view.id === activeId);
  }

  function writeOwnedMouseSequence(sequence: string): boolean {
    if (!terminal || !terminalStarted) return false;
    try {
      terminal.write(sequence);
      return true;
    } catch {
      runtimeFailure = true;
      shutdownRequested = true;
      if (startupComplete) beginShutdown();
      return false;
    }
  }

  function syncOuterMouseModes(): void {
    if (!terminal || !terminalStarted || !sidebar || shutdownRequested) return;
    const view = findActiveView();
    const surface = view?.hasLiveProcess && view.lifecycle === "alive" ? manager?.surface(view.id) : undefined;
    let desiredTracking: number | undefined;
    let useSgr = false;
    if (sidebar.focus === "main" && surface) {
      let modes: TerminalInputModes | undefined;
      try {
        modes = surface.inputModes();
      } catch {
        modes = undefined;
      }
      if (modes && modes.mouseTracking !== "none" && modes.mouseEncoding !== "sgr-pixels") {
        desiredTracking = modes.mouseTracking === "x10" ? 9
          : modes.mouseTracking === "vt200" ? 1000
            : modes.mouseTracking === "drag" ? 1002
              : modes.mouseTracking === "any" ? 1003 : undefined;
        useSgr = desiredTracking !== undefined;
      }
    }

    if (mouseTrackingMode !== desiredTracking) {
      if (mouseTrackingMode !== undefined) {
        if (!writeOwnedMouseSequence(`\x1b[?${mouseTrackingMode}l`)) return;
        mouseTrackingMode = undefined;
      }
      if (desiredTracking !== undefined) {
        if (!writeOwnedMouseSequence(`\x1b[?${desiredTracking}h`)) return;
        mouseTrackingMode = desiredTracking;
      }
    }
    if (mouseSgrEnabled !== useSgr) {
      if (!writeOwnedMouseSequence(useSgr ? "\x1b[?1006h" : "\x1b[?1006l")) return;
      mouseSgrEnabled = useSgr;
    }
  }

  function scheduleRedraw(): void {
    if (redrawQueued || shutdownRequested || externalEditorActive || !writer || !sidebar || !terminal) return;
    redrawQueued = true;
    queueMicrotask(() => {
      redrawQueued = false;
      if (shutdownRequested || externalEditorActive || !writer || !sidebar || !terminal) return;
      try {
        const cols = clampDimension(terminal.columns, 80);
        const rows = clampDimension(terminal.rows, 24);
        const currentLayout = computeHostLayout(cols, rows, {
          sidebarVisible: sidebar.visible,
          focus: sidebarFocus(sidebar.focus),
        });
        layout = currentLayout;
        const view = findActiveView();
        const surface = view ? manager?.surface(view.id) : undefined;
        let mainFrame = surface?.frame();
        if (mainFrame && view && (!view.hasLiveProcess || view.lifecycle !== "alive")) {
          mainFrame = {
            ...mainFrame,
            cursor: { ...mainFrame.cursor, visible: false },
          };
        }
        // Wide layout with the form open: the roster stays in the left pane
        // while the form temporarily replaces the native (right) pane. Narrow
        // overlays and every other focus render a single sidebar-owned pane.
        const focus = sidebarFocus(sidebar.focus);
        let sidebarFrame: RenderedSidebar = { lines: [] };
        let formFrame: RenderedSidebar | undefined;
        if (currentLayout.sidebar) {
          if (focus === "form" && currentLayout.form !== undefined) {
            sidebarFrame = sidebar.renderRoster(currentLayout.sidebar.cols, currentLayout.sidebar.rows);
            formFrame = sidebar.renderForm(currentLayout.form.cols, currentLayout.form.rows);
          } else {
            sidebarFrame = sidebar.render(currentLayout.sidebar.cols, currentLayout.sidebar.rows);
          }
        }
        const header = view
          ? `Session host · ${view.label} · ${view.lifecycle}`
          : "Session host";
        const composed = composeHostFrame(currentLayout, {
          main: mainFrame,
          sidebar: sidebarFrame,
          form: formFrame,
          header,
          focus,
        });
        writer.submit(composed, cols, rows);
      } catch {
        requestShutdown(true);
      }
    });
  }

  function createFrameWriter(): MainWriter {
    return dependencies.createWriter(dependencies.stdout, {
      onError: () => requestShutdown(true),
    });
  }

  function syncRosterAndSchedule(): void {
    if (!manager || !sidebar || shutdownRequested) return;
    if (rosterSyncInProgress) {
      if (!rosterSyncQueued) {
        rosterSyncQueued = true;
        queueMicrotask(() => {
          rosterSyncQueued = false;
          syncRosterAndSchedule();
        });
      }
      return;
    }
    rosterSyncInProgress = true;
    try {
      views = manager.list().filter((view) => !removedExitedIds.has(view.id));
      if (activeId !== undefined && !views.some((view) => view.id === activeId)) {
        activeId = undefined;
      }
      sidebar.updateItems(views.map(toSidebarItem));
      syncOuterMouseModes();
      scheduleRedraw();
    } catch {
      requestShutdown(true);
    } finally {
      rosterSyncInProgress = false;
    }
  }

  function reconcileLayout(resizeChildren: boolean): void {
    if (!terminal || !sidebar || shutdownRequested) return;
    try {
      const cols = clampDimension(terminal.columns, 80);
      const rows = clampDimension(terminal.rows, 24);
      const next = computeHostLayout(cols, rows, {
        sidebarVisible: sidebar.visible,
        focus: sidebarFocus(sidebar.focus),
      });
      layout = next;
      const changed = next.native.cols !== lastNativeCols || next.native.rows !== lastNativeRows;
      if (resizeChildren && changed && manager && !resizeInProgress) {
        resizeInProgress = true;
        try {
          manager.resize(next.native.cols, next.native.rows);
          lastNativeCols = next.native.cols;
          lastNativeRows = next.native.rows;
        } finally {
          resizeInProgress = false;
        }
      } else if (lastNativeCols === undefined || lastNativeRows === undefined) {
        lastNativeCols = next.native.cols;
        lastNativeRows = next.native.rows;
      }
      syncOuterMouseModes();
      scheduleRedraw();
    } catch {
      requestShutdown(true);
    }
  }

  function routeForward(data: string): void {
    if (!terminal || !sidebar || sidebar.focus !== "main" || shutdownRequested || externalEditorActive) return;
    const view = findActiveView();
    if (!view || !view.hasLiveProcess || view.lifecycle !== "alive" || !layout || !manager) return;
    const surface = manager.surface(view.id);
    if (!surface) return;
    try {
      const sourceNormalized = normalizeNativeSourceInput(data, terminal.kittyProtocolActive);
      const translated = translateInput(sourceNormalized, surface.inputModes(), layout.native);
      if (translated !== undefined) manager.write(view.id, translated);
    } catch {
      // The process may have exited between the snapshot and write. Never
      // retry against a sibling or expose the underlying native diagnostic.
    }
  }

  function handleTerminalInput(data: string): void {
    if (shutdownRequested || externalEditorActive || !sidebar) return;
    try {
      sidebar.handleInput(data);
      reconcileLayout(false);
      scheduleRedraw();
    } catch {
      requestShutdown(true);
    }
  }

  function handleTerminalResize(): void {
    reconcileLayout(true);
  }

  async function handoffExternalEditor(text: string): Promise<string | undefined> {
    if (externalEditorActive || shutdownRequested || !terminal || !terminalStarted) {
      throw new Error("external editor handoff is unavailable");
    }
    externalEditorActive = true;
    const controller = new AbortController();
    externalEditorAbort = controller;
    let terminalPaused = false;
    try {
      await terminal.drainInput(INPUT_DRAIN_MAX_MS, INPUT_DRAIN_IDLE_MS);
      if (shutdownRequested || controller.signal.aborted) return undefined;
      const activeWriter = writer;
      writer = undefined;
      if (!activeWriter) {
        requestShutdown(true);
        throw new Error("external editor handoff is unavailable");
      }
      let writerSettled = false;
      try {
        writerSettled = await activeWriter.close();
      } catch {
        writerSettled = false;
      }
      if (!writerSettled) {
        requestShutdown(true);
        throw new Error("external editor handoff could not settle terminal output");
      }
      if (shutdownRequested || controller.signal.aborted) return undefined;
      if (mouseTrackingMode !== undefined) {
        if (!writeOwnedMouseSequence(`\x1b[?${mouseTrackingMode}l`)) {
          requestShutdown(true);
          throw new Error("terminal handoff failed");
        }
        mouseTrackingMode = undefined;
      }
      if (mouseSgrEnabled) {
        if (!writeOwnedMouseSequence("\x1b[?1006l")) {
          requestShutdown(true);
          throw new Error("terminal handoff failed");
        }
        mouseSgrEnabled = false;
      }
      try {
        terminal.stop();
      } catch {
        requestShutdown(true);
        throw new Error("terminal handoff failed");
      }
      terminalStarted = false;
      terminalPaused = true;
      const result = await dependencies.runExternalEditor(text, {
        env: snapshot.env,
        cwd: snapshot.startupCwd,
        signal: controller.signal,
      });
      if (shutdownRequested || controller.signal.aborted) return undefined;
      return result;
    } finally {
      if (externalEditorAbort === controller) externalEditorAbort = undefined;
      if (!shutdownRequested && terminalPaused && terminal) {
        try {
          const resumedWriter = createFrameWriter();
          writer = resumedWriter;
          resumedWriter.start();
          if (shutdownRequested) throw new Error("terminal output could not be restored");
          terminal.start(handleTerminalInput, handleTerminalResize);
          terminalStarted = true;
          syncOuterMouseModes();
        } catch {
          requestShutdown(true);
        }
      }
      externalEditorActive = false;
      if (!shutdownRequested) {
        reconcileLayout(false);
        scheduleRedraw();
      }
    }
  }

  function startExternalEditor(text: string): Promise<string | undefined> {
    const task = handoffExternalEditor(text);
    externalEditorTask = task;
    void task.then(
      () => { if (externalEditorTask === task) externalEditorTask = undefined; },
      () => { if (externalEditorTask === task) externalEditorTask = undefined; },
    );
    return task;
  }

  function launchCreate(action: Extract<SidebarAction, { type: "create" }>): void {
    if (!manager || shutdownRequested || !negotiationReady) return;
    const createOptions: CreateInstanceOptions = { workspace: action.workspace };
    let task!: Promise<void>;
    task = (async () => {
      try {
        const id = await manager!.create(createOptions);
        if (shutdownRequested || !sidebar || !manager) return;
        const row = manager.list().find((candidate) => candidate.id === id);
        if (!row || row.lifecycle === "error" || row.lifecycle === "starting") {
          sidebar.failCreate(action.requestId, GENERIC_CREATE_FAILURE);
        } else {
          // Selecting/highlighting the new row is not ownership transfer.
          // Only a later explicit SidebarAction.select changes activeId.
          sidebar.completeCreate(action.requestId, id);
        }
        syncRosterAndSchedule();
        reconcileLayout(true);
      } catch {
        if (!shutdownRequested && sidebar) {
          sidebar.failCreate(action.requestId, GENERIC_CREATE_FAILURE);
          scheduleRedraw();
        }
      } finally {
        createTasks.delete(task);
      }
    })();
    createTasks.add(task);
  }

  function handleSidebarAction(action: SidebarAction): void {
    if (shutdownRequested) return;
    switch (action.type) {
      case "forward":
        routeForward(action.data);
        return;
      case "select":
        // This action is emitted only by an explicit roster activation.
        activeId = action.id;
        syncRosterAndSchedule();
        reconcileLayout(true);
        return;
      case "create":
        if (negotiationReady) launchCreate(action);
        else deferredCreates.set(action.requestId, action);
        reconcileLayout(true);
        scheduleRedraw();
        return;
      case "edit": {
        if (!sidebar) return;
        const row = views.find((candidate) => candidate.id === action.id);
        const observed = row?.nativeSession;
        if (!observed || observed.sessionId !== action.nativeSession.sessionId
          || observed.epoch !== action.nativeSession.epoch) {
          sidebar.showError("Session name changed or is unavailable; reopen Edit from the current row");
          scheduleRedraw();
          return;
        }
        const opened = sidebar.openEdit({
          id: row.id,
          nativeSession: action.nativeSession,
          currentName: observed.name,
        });
        if (!opened) sidebar.showError("Session name could not be edited while this row is changing");
        reconcileLayout(true);
        scheduleRedraw();
        return;
      }
      case "rename": {
        if (!manager || !sidebar) return;
        const request = {
          expectedSessionId: action.expectedSessionId,
          expectedSessionEpoch: action.expectedSessionEpoch,
          name: action.name,
        };
        void manager.rename(action.id, request).then(
          (result) => {
            if (shutdownRequested || !sidebar) return;
            sidebar.completeRename(action.requestId, result.status);
            syncRosterAndSchedule();
            reconcileLayout(true);
          },
          () => {
            if (shutdownRequested || !sidebar) return;
            sidebar.failRename(action.requestId, "Session name could not be persisted; the active session was not changed");
            scheduleRedraw();
          },
        );
        return;
      }
      case "remove": {
        if (!manager || !sidebar) return;
        let removed: boolean;
        try {
          removed = manager.closeExited(action.id);
        } catch {
          sidebar.showError(REMOVE_FAILURE_MESSAGE);
          scheduleRedraw();
          return;
        }
        if (!removed) {
          sidebar.showError(REMOVE_REFUSED_MESSAGE);
          scheduleRedraw();
          return;
        }
        removedExitedIds.add(action.id);
        if (activeId === action.id) {
          activeId = undefined;
        }
        // closeExited may synchronously notify after detaching the row. Sync
        // again here so even managers without a callback redraw the picker;
        // the tombstone filters any later stale snapshot of this id.
        syncRosterAndSchedule();
        reconcileLayout(true);
        return;
      }
      case "visibility":
        reconcileLayout(true);
        syncOuterMouseModes();
        scheduleRedraw();
        return;
      case "quit":
        // SidebarController emits this only after its required confirmation.
        requestShutdown(false);
        return;
    }
  }

  function beginShutdown(): void {
    if (shutdownPromise) return;
    // Reserve teardown before invoking any owned component; shutdown() marks
    // manager admission closed synchronously, before a pending create can
    // advance through its next native-launch checkpoint.
    shutdownPromise = Promise.resolve();
    shutdownRequested = true;
    deferredCreates.clear();
    let shutdownTask: Promise<{ result?: ShutdownResult; failed: boolean }> | undefined;
    if (manager) {
      try {
        shutdownTask = Promise.resolve(manager.shutdown()).then(
          (result) => ({ result, failed: false }),
          () => ({ failed: true }),
        );
      } catch {
        cleanupFailure = true;
      }
    }

    shutdownPromise = Promise.resolve().then(async () => {
      let shutdownResult: ShutdownResult | undefined;

      const editorTask = externalEditorTask;
      if (editorTask) await Promise.allSettled([editorTask]);

      // Stop only mouse modes this host enabled. Unknown pre-existing modes
      // and foreign listeners are never guessed at or reset.
      if (terminalStarted) {
        if (mouseTrackingMode !== undefined) {
          if (writeOwnedMouseSequence(`\x1b[?${mouseTrackingMode}l`)) mouseTrackingMode = undefined;
          else cleanupFailure = true;
        }
        if (mouseSgrEnabled) {
          if (writeOwnedMouseSequence("\x1b[?1006l")) mouseSgrEnabled = false;
          else cleanupFailure = true;
        }
      }

      if (observerListenerAttached && passiveInputListener) {
        try {
          dependencies.stdin.removeListener("data", passiveInputListener);
        } catch {
          cleanupFailure = true;
        }
        observerListenerAttached = false;
      }
      try {
        observer?.dispose();
      } catch {
        cleanupFailure = true;
      }
      if (terminalStartAttempted && terminal && !externalEditorActive) {
        try {
          await terminal.drainInput(INPUT_DRAIN_MAX_MS, INPUT_DRAIN_IDLE_MS);
        } catch {
          cleanupFailure = true;
        }
        try {
          terminal.stop();
        } catch {
          cleanupFailure = true;
        }
        terminalStarted = false;
      }

      try {
        const flushed = await writer?.close();
        if (flushed === false) cleanupFailure = true;
      } catch {
        cleanupFailure = true;
      }

      if (manager) {
        if (shutdownTask) {
          try {
            const outcome = await shutdownTask;
            if (outcome.failed) cleanupFailure = true;
            else if (outcome.result) {
              shutdownResult = outcome.result;
              forcedCount = shutdownResult.forcedIds.length;
            }
          } catch {
            // The startup-time rejection handler above keeps this defensive.
            cleanupFailure = true;
          }
        }
        await Promise.allSettled([...createTasks]);
      }

      if (manager) {
        try {
          await manager.dispose();
        } catch {
          cleanupFailure = true;
        }
        try {
          const liveViews = manager.list().filter((view) => view.hasLiveProcess);
          remainingCount = liveViews.length;
        } catch {
          remainingCount = shutdownResult?.remainingIds.length ?? 0;
          try {
            if (remainingCount === 0 && manager.hasLiveProcesses()) remainingCount = 1;
          } catch {
            // Preserve the bounded shutdown snapshot if the live query also fails.
          }
          cleanupFailure = true;
        }
      } else {
        remainingCount = shutdownResult?.remainingIds.length ?? 0;
      }
      if (broker) {
        try {
          await broker.dispose();
        } catch {
          cleanupFailure = true;
        }
      }

      removeOuterListeners();
      const failed = runtimeFailure || cleanupFailure || forcedCount > 0 || remainingCount > 0;
      if (failed) {
        const details = forcedCount > 0 || remainingCount > 0
          ? `Session host shutdown: ${forcedCount} owned process(es) required forced termination; ${remainingCount} remain unconfirmed.`
          : GENERIC_FAILURE_MESSAGE;
        safeReport(dependencies, details);
      }
      finishRun(failed ? 1 : 0);
    }).catch(() => {
      // A final controller-level guard: no rejected teardown promise escapes.
      cleanupFailure = true;
      removeOuterListeners();
      safeReport(dependencies, GENERIC_FAILURE_MESSAGE);
      finishRun(1);
    });
  }

  try {
    addOuterListeners();
    if (dependencies.stdin.readableEnded) {
      requestShutdown(false);
      startupComplete = true;
      beginShutdown();
      return await runFinished;
    }

    let pi: { file: string; version: string } | undefined;
    let probeFailed = false;
    try {
      pi = dependencies.resolvePi({ executable: snapshot.piExecutable, env: snapshot.env });
    } catch {
      probeFailed = true;
    }
    // Let queued external signals run after the synchronous, bounded probe
    // before opening the broker or constructing any interactive resource.
    await new Promise<void>((resolve) => setImmediate(resolve));
    if (shutdownRequested) {
      startupComplete = true;
      beginShutdown();
      return await runFinished;
    }
    if (probeFailed || !pi || !pi.file || !pi.version) {
      throw new MainFailure("preflight");
    }

    broker = await dependencies.createBroker(snapshot.stateRoot === undefined
      ? undefined
      : { socketRoot: snapshot.stateRoot });
    if (shutdownRequested) {
      startupComplete = true;
      beginShutdown();
      return await runFinished;
    }

    observer = dependencies.createObserver({
      onChange: (flags) => {
        observedFlags = flags & 7;
        syncOuterMouseModes();
        scheduleRedraw();
      },
    });
    terminal = dependencies.createTerminal();
    const initialCols = clampDimension(terminal.columns, 80);
    const initialRows = clampDimension(terminal.rows, 24);
    const sessionSetup = dependencies.createSessionSetup({ env: snapshot.env });
    const createTextField = (options: SidebarFieldFactoryOptions) => {
      if (!sessionSetup.nativeAgentDir) {
        throw new Error("native Pi agent directory is unavailable for session-host fields");
      }
      const keybindings = loadNativeFieldKeybindings(sessionSetup.nativeAgentDir);
      const common = {
        initialText: options.initialText,
        keybindings: keybindings.manager,
        actionBindings: {
          clear: "app.clear",
          submit: "tui.input.submit",
          cancel: "app.interrupt",
          externalEditor: "app.editor.external",
        },
        onInvalidate: options.onInvalidate,
        onSubmit: options.onSubmit,
        onCancel: options.onCancel,
        onReject: options.onReject,
        onExternalEditor: startExternalEditor,
      };
      const field = options.kind === "path"
        ? createSessionHostTextField({
          ...common,
          kind: "path",
          workspaceBasePath: snapshot.startupCwd,
        })
        : createSessionHostTextField({ ...common, kind: "name" });
      return {
        field,
        matchesCancel: (data: string) =>
          !keybindings.manager.matches(data, "app.clear")
          && !keybindings.manager.matches(data, "app.editor.external")
          && keybindings.manager.matches(data, "app.interrupt"),
        ...(keybindings.notice ? { notice: keybindings.notice } : {}),
        hints: {
          submit: nativeKeyHint(keybindings.manager, "tui.input.submit", "enter", ["app.clear", "app.editor.external", "app.interrupt"]),
          cancel: nativeKeyHint(keybindings.manager, "app.interrupt", "esc", ["app.clear", "app.editor.external"]),
          complete: nativeKeyHint(keybindings.manager, "tui.input.tab", "tab", ["app.clear", "app.editor.external", "app.interrupt", "tui.input.submit"]),
          clear: nativeKeyHint(keybindings.manager, "app.clear", "ctrl+c"),
          externalEditor: nativeKeyHint(keybindings.manager, "app.editor.external", "ctrl+g", ["app.clear"]),
        },
      };
    };
    sidebar = dependencies.createSidebar({
      toggleKey: snapshot.toggleKey,
      workspaceBasePath: snapshot.startupCwd,
      createTextField,
      initialVisible: true,
      onAction: handleSidebarAction,
      onInvalidate: scheduleRedraw,
    });
    layout = computeHostLayout(initialCols, initialRows, {
      sidebarVisible: sidebar.visible,
      focus: sidebarFocus(sidebar.focus),
    });
    lastNativeCols = layout.native.cols;
    lastNativeRows = layout.native.rows;

    manager = dependencies.createManager({
      packageRoot,
      piExecutable: pi.file,
      statusRegistrar: statusRegistrar(broker),
      nativeSetup: sessionSetup.nativeSetup,
      profileRegistry: sessionSetup.profileRegistry,
      args: snapshot.args,
      env: snapshot.env,
      cols: layout.native.cols,
      rows: layout.native.rows,
      getSupportedKeyboardFlags: () => terminal?.kittyProtocolActive ? observedFlags & 7 : 0,
      onChange: () => syncRosterAndSchedule(),
    });
    writer = createFrameWriter();

    passiveInputListener = (data): void => {
      if (!externalEditorActive) observer?.feed(data);
    };
    dependencies.stdin.on("data", passiveInputListener);
    observerListenerAttached = true;
    if (shutdownRequested) {
      startupComplete = true;
      beginShutdown();
      return await runFinished;
    }

    writer.start();
    if (shutdownRequested) {
      startupComplete = true;
      beginShutdown();
      return await runFinished;
    }
    terminalStartAttempted = true;
    terminal.start(handleTerminalInput, handleTerminalResize);
    terminalStarted = true;
    syncRosterAndSchedule();
    reconcileLayout(false);
    startupComplete = true;
    if (shutdownRequested) beginShutdown();
    else {
      await observer.wait();
      observedFlags = observer.flags & 7;
      negotiationReady = true;
      if (!shutdownRequested) {
        for (const action of deferredCreates.values()) launchCreate(action);
        deferredCreates.clear();
        syncOuterMouseModes();
        scheduleRedraw();
      }
    }
  } catch {
    runtimeFailure = true;
    shutdownRequested = true;
    startupComplete = true;
    beginShutdown();
  }

  if (shutdownRequested && !shutdownPromise) beginShutdown();
  return runFinished;
}

/** Internal-only injection seam for focused controller tests; not an option on the public API or CLI. */
export const __test = Object.freeze({
  runWithDependencies(options: SessionHostOptions, overrides: Partial<MainDependencies>): Promise<number> {
    let snapshot: HostSnapshot;
    try {
      snapshot = snapshotOptions(options);
    } catch {
      return Promise.resolve(1);
    }
    return runSessionHostController(snapshot, { ...productionDependencies(), ...overrides });
  },
});
