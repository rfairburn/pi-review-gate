import { EventEmitter } from "node:events";
import { realpathSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import type { Writable } from "node:stream";
import { ProcessTerminal } from "pi-session-host-tui";

import { createStatusBroker, type StatusBroker } from "./broker";
import { composeHostFrame, computeHostLayout, type HostFocus, type HostLayout, type RenderedSidebar } from "./compositor";
import { chooseExitedRestart } from "./exited-restart";
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
import { resolveNativePi, RUNTIME_ROLE_ENV, EXECUTOR_TOOL_CATALOG_ENV, snapshotNativeEnvironment } from "./launch";
import { NativeAgentRegistry, type ProfilePreparer } from "./profiles";
import { isValidNativeSessionId } from "./protocol";
import type { NativePersistenceReceipt } from "./native-persistence";
import {
  admitSavedSession,
  listSavedSessions,
  type SavedSessionAdmissionResult,
  type SavedSessionCatalog,
  type SavedSessionRefusalReason,
} from "./saved-sessions";
import { SidebarController, type SidebarAction, type SidebarFieldFactoryOptions, type SidebarItem } from "./sidebar";
import type { TerminalInputModes } from "./terminal-surface";

const STARTUP_OPTIONS_HELPER = join("scripts", "session-host-startup-options.cjs");
const GENERIC_FAILURE_MESSAGE = "Session host could not complete startup or cleanup.";
const GENERIC_CREATE_FAILURE = "Session could not be started. Check the workspace, then try again.";
const ROW_RESUME_FAILURE = "This session could not be restarted; the previous row was kept.";
const ROW_RESUME_DUPLICATE = "This conversation is already restarting";
const SAVED_UNAVAILABLE = "Saved conversations are unavailable in this host";
const REMOVE_REFUSED_MESSAGE = "Session not removed; it may be live, unconfirmed, or no longer available.";
const REMOVE_FAILURE_MESSAGE = "Session was not removed; its state could not be confirmed.";
const INPUT_DRAIN_MAX_MS = 250;
const INPUT_DRAIN_IDLE_MS = 50;
// One bounded readiness deadline for a just-spawned exited-row replacement:
// PTY spawn is not native readiness, and startup/disconnect uncertainty must
// fail closed rather than hang the restart forever.
const ROW_RESUME_READY_DEADLINE_MS = 60_000;

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
  "list" | "surface" | "write" | "resize" | "hasLiveProcesses" | "create" | "rename" | "closeExited" | "shutdown" | "dispose" | "ownedLiveSessions"
> & Partial<Pick<InstanceManager, "stop">>;
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
  readonly platform: NodeJS.Platform;
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
  /** Read-only listing of the shared native agent root's saved conversations. */
  readonly listSavedCatalog: (options: {
    agentDir: string;
    piExecutable: string;
    expectedPiVersion: string;
    signal: AbortSignal;
  }) => Promise<SavedSessionCatalog>;
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

type RowResumeReadiness = "ready" | "pending" | "failed";

/**
 * Readiness of an exited-row replacement child: an owned live process AND a
 * genuine authenticated CURRENT conversation observed on the manager's live
 * field. PTY spawn, the retained `lastNativeSession`, an original reservation,
 * or a launch/name guess are never readiness. `expectedSessionId` is the exact
 * branded saved admission for a saved restart; a fresh restart leaves it
 * undefined and accepts any safe new current id. A row with no live process or
 * a confirmed error/exit can never become ready.
 */
function rowResumeReadiness(
  view: NativeInstanceView | undefined,
  expectedSessionId: string | undefined,
): RowResumeReadiness {
  if (!view) return "failed";
  if (view.lifecycle === "error") return "failed";
  // Only a positively dead replacement child is an actual exit; missing or
  // unknown liveness is never accepted as one.
  if (view.lifecycle === "exited" && view.hasLiveProcess === false) return "failed";
  if (view.lifecycle !== "alive" || view.hasLiveProcess !== true) return "pending";
  const current = view.nativeSession;
  if (!current || !isValidNativeSessionId(current.sessionId)
    || !Number.isSafeInteger(current.epoch) || current.epoch < 1) {
    return "pending";
  }
  if (expectedSessionId !== undefined && current.sessionId !== expectedSessionId) return "failed";
  return "ready";
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
  if (dependencies.platform !== "darwin" && dependencies.platform !== "linux" && dependencies.platform !== "win32") {
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

/** Truthful, bounded picker notices for each admission refusal reason. */
function savedRefusalNotice(reason: SavedSessionRefusalReason): string {
  switch (reason) {
    case "stale-catalog":
      return "The saved list is stale; reopen Saved conversations";
    case "unknown-row":
      return "That saved conversation is no longer available; reopen the list";
    case "missing-file":
    case "not-a-regular-file":
    case "symlink-file":
    case "outside-sessions-root":
      return "That saved conversation file is unavailable; reopen the list";
    case "replaced-file":
    case "malformed-header":
      return "That saved conversation changed since it was listed; reopen the list";
    case "workspace-unavailable":
      return "The saved conversation's workspace is no longer available";
    case "known-owned-duplicate":
      return "That saved conversation is already open in this host";
  }
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
      // Keep the broker's exact registration closures and their auth/tuple fences.
      return registration satisfies InstanceStatusRegistration;
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
    backgroundTasks: view.backgroundTasks ?? null,
    backgroundShells: view.backgroundShells ?? null,
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
    listSavedCatalog: listSavedSessions,
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
    // Windows environment names are case-insensitive. Normalize and reject
    // ambiguous ordinary aliases before startup storage/role checks, resolver
    // probes, or any resource construction. POSIX remains case-sensitive.
    snapshot = {
      ...snapshot,
      env: snapshotNativeEnvironment(snapshot.env, dependencies.platform),
    };
    packageRoot = assertStartupOptions(snapshot);
    assertPreflight(snapshot, dependencies);
  } catch (error) {
    safeReport(dependencies, error instanceof MainFailure && error.phase === "startup-options"
      ? "Session host startup options were rejected."
      : "Session host preflight failed.");
    return 1;
  }

  let pi: { file: string; version: string } | undefined;
  let sessionSetup: {
    nativeSetup: boolean;
    profileRegistry: ProfilePreparer;
    nativeAgentDir?: string;
  } | undefined;
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
  const rowStopTasks = new Map<string, Promise<void>>();
  // Exited-row restart (deliberate Enter): one attempt per old row id, a
  // per-request mapping for cancellation, and every task promise retained for
  // shutdown awaiting. The task map is the duplicate fence; the set is not.
  const rowResumeTasks = new Map<string, { readonly controller: AbortController; spawned: boolean }>();
  const rowResumeTaskSet = new Set<Promise<void>>();
  const rowResumeRequests = new Map<number, { readonly oldId: string; readonly controller: AbortController }>();
  // Exited-row restart native readiness is event-driven only: the manager's
  // existing onChange callback wakes these waiters (there is no polling, timer
  // loop, PID scan, or additional terminal owner). Each waiter is registered
  // for exactly one replacement child id and removed on settlement.
  const rowReadinessWaiters = new Map<string, Set<(forced: RowResumeReadiness | undefined) => void>>();
  const deferredRowResumes = new Map<number, { readonly requestId: number; readonly id: string }>();
  const deferredCreates = new Map<number, Extract<SidebarAction, { type: "create" }>>();
  // Deliberate saved-conversation picker (issue 323): the last accepted
  // catalog mints admissions; listing controllers are aborted on dismiss and
  // shutdown so late completions never contribute.
  let savedCatalog: SavedSessionCatalog | undefined;
  const savedListControllers = new Map<number, AbortController>();
  const savedOpenTasks = new Set<Promise<void>>();
  const deferredSavedOpens = new Map<number, { readonly file: string; readonly sessionId: string }>();
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
        // Title only. Lifecycle, activity and input ownership belong below
        // session-card titles, never on the active conversation's title line.
        const header = view ? view.label : "Session host";
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

  /**
   * Deliberate saved-conversation open (issue 323): revalidate the exact
   * catalog row against the live file and known-owned duplicates, then start
   * a NEW independently owned child with the exact branded per-child
   * --session admission. The active session is never touched; success only
   * highlights the new row.
   */
  function launchSavedOpen(requestId: number, file: string, sessionId: string): void {
    if (!manager || !sidebar || shutdownRequested) return;
    const catalog = savedCatalog;
    const row = catalog === undefined ? undefined : catalog.rows.find(
      (candidate) => candidate.file === file && candidate.id === sessionId,
    );
    if (catalog === undefined || row === undefined) {
      sidebar.failSavedOpen(requestId, "That saved conversation is no longer available; reopen the list");
      scheduleRedraw();
      return;
    }
    let result: SavedSessionAdmissionResult;
    try {
      result = admitSavedSession(catalog, row, { ownedLiveSessions: manager.ownedLiveSessions() });
    } catch {
      result = { status: "refused", reason: "unknown-row" };
    }
    if (result.status === "refused") {
      sidebar.failSavedOpen(requestId, savedRefusalNotice(result.reason));
      scheduleRedraw();
      return;
    }
    const admission = result.admission;
    let task!: Promise<void>;
    task = (async () => {
      try {
        // The exact saved header cwd determines the workspace; the manager
        // refuses any conflicting explicit workspace and fences duplicates.
        const id = await manager!.create({ workspace: admission.workspace, savedSession: admission });
        if (shutdownRequested || !sidebar || !manager) return;
        const created = manager.list().find((candidate) => candidate.id === id);
        if (!created || created.lifecycle === "error" || created.lifecycle === "starting") {
          sidebar.failSavedOpen(requestId, GENERIC_CREATE_FAILURE);
        } else {
          // Highlighting the new row is not ownership transfer; only a later
          // explicit host-row Enter activates it.
          sidebar.completeSavedOpen(requestId, id);
        }
        syncRosterAndSchedule();
        reconcileLayout(true);
      } catch (error) {
        if (!shutdownRequested && sidebar) {
          sidebar.failSavedOpen(requestId,
            error instanceof Error && error.message.includes("already open in this host")
              ? "That saved conversation is already open in this host"
              : GENERIC_CREATE_FAILURE);
          scheduleRedraw();
        }
      } finally {
        savedOpenTasks.delete(task);
      }
    })();
    savedOpenTasks.add(task);
  }

  /**
   * The exact current exited binding of one row, read fresh from the manager:
   * only an actual confirmed exit with no owned process qualifies. The retained
   * last-observed native binding is the restart target; a missing persistence
   * observation is unknown, never assumed unsaved.
   */
  function readExitedResumeTarget(id: string):
    { readonly workspace: string; readonly binding: NativePersistenceReceipt; readonly epoch: number } | undefined {
    if (!manager) return undefined;
    let view: NativeInstanceView | undefined;
    try {
      view = manager.list().find((candidate) => candidate.id === id);
    } catch {
      return undefined;
    }
    if (!view || view.lifecycle !== "exited" || view.hasLiveProcess !== false) return undefined;
    const retained = view.lastNativeSession;
    if (!retained || !isValidNativeSessionId(retained.sessionId)
      || !Number.isSafeInteger(retained.epoch) || retained.epoch < 1) return undefined;
    const persistence = retained.persistence === "saved" || retained.persistence === "unsaved"
      ? retained.persistence
      : "unknown";
    return { workspace: view.workspace, binding: { sessionId: retained.sessionId, persistence }, epoch: retained.epoch };
  }

  /**
   * Current manager row for one replacement child. A listing failure is a
   * readiness failure, never a success and never a poll.
   */
  function readReadinessView(id: string): NativeInstanceView | undefined {
    if (!manager) return undefined;
    try {
      return manager.list().find((candidate) => candidate.id === id);
    } catch {
      return undefined;
    }
  }

  /**
   * Manager onChange fan-out: wake only the readiness waiters for the changed
   * row (each re-reads current state), then run the ordinary roster
   * synchronization. A wake only resolves a promise, so it cannot reenter
   * this path or the manager callback.
   */
  function noteManagerChanged(id: string | undefined): void {
    if (id !== undefined) {
      const waiters = rowReadinessWaiters.get(id);
      if (waiters !== undefined) {
        for (const notify of [...waiters]) {
          try { notify(undefined); } catch { /* one readiness waiter never disturbs the roster */ }
        }
      }
    }
    syncRosterAndSchedule();
  }

  /** Forced settlement of every outstanding readiness wait (shutdown only). */
  function settleRowReadinessWaiters(outcome: RowResumeReadiness): void {
    for (const waiters of [...rowReadinessWaiters.values()]) {
      for (const notify of [...waiters]) {
        try { notify(outcome); } catch { /* per-waiter shutdown settlement is best-effort */ }
      }
    }
  }

  /**
   * Event-driven readiness wait for one just-created replacement child. The
   * waiter is published BEFORE the current-state check so a readiness change
   * (even a synchronous one that lands before create() returns) is never lost,
   * and it is woken by the manager's existing onChange callback. Exactly one
   * 60s deadline bounds unknown startup; a UI/listing cancellation never
   * settles it (an already-started child still completes), while shutdown does.
   * The listener and timer are always removed on settlement.
   */
  function awaitRowReadiness(id: string, expectedSessionId: string | undefined): Promise<RowResumeReadiness> {
    return new Promise<RowResumeReadiness>((resolve) => {
      let finished = false;
      let timer: NodeJS.Timeout | undefined;
      const waiters = rowReadinessWaiters.get(id) ?? new Set<(forced: RowResumeReadiness | undefined) => void>();
      rowReadinessWaiters.set(id, waiters);
      function finish(outcome: RowResumeReadiness): void {
        if (finished) return;
        finished = true;
        if (timer !== undefined) {
          clearTimeout(timer);
          timer = undefined;
        }
        waiters.delete(notify);
        if (waiters.size === 0) rowReadinessWaiters.delete(id);
        resolve(outcome);
      }
      function notify(forced: RowResumeReadiness | undefined): void {
        if (finished) return;
        if (forced !== undefined) {
          finish(forced);
          return;
        }
        let outcome: RowResumeReadiness;
        try {
          outcome = rowResumeReadiness(readReadinessView(id), expectedSessionId);
        } catch {
          // A throwing metadata read is a readiness failure, never a leak: the
          // listener and deadline timer settle through the same path, so no
          // waiter outlives a failed/aborted evaluation.
          outcome = "failed";
        }
        if (outcome !== "pending") finish(outcome);
      }
      waiters.add(notify);
      if (shutdownRequested) {
        finish("failed");
        return;
      }
      timer = setTimeout(() => finish("failed"), ROW_RESUME_READY_DEADLINE_MS);
      notify(undefined);
    });
  }

  /**
   * Deliberate Enter on an exited row (resume-row): restart the EXACT current
   * retained conversation of that one exited row, never the launch arguments,
   * the original conversation, or the newest saved file. The old placeholder is
   * replaced only when a new independently owned child actually became ready;
   * cancellation never kills a child that already started.
   */
  function launchRowResume(requestId: number, id: string): void {
    if (!manager || !sidebar || shutdownRequested) return;
    const existing = rowResumeTasks.get(id);
    if (existing !== undefined) {
      if (existing.spawned) {
        // An already-started replacement child is never canceled or duplicated.
        sidebar.failRowResume(requestId, ROW_RESUME_DUPLICATE);
        scheduleRedraw();
        return;
      }
      // Pre-spawn duplicate: cancel the earlier read-only attempt; this newer
      // deliberate request takes over the same old row.
      try { existing.controller.abort(); } catch { /* abort is best-effort */ }
    }
    const controller = new AbortController();
    const record: { readonly controller: AbortController; spawned: boolean } = { controller, spawned: false };
    // Register the duplicate fence and the cancellation mapping BEFORE the
    // task body can call any dependency, so even a synchronously throwing
    // adapter cannot start a second attempt.
    rowResumeTasks.set(id, record);
    rowResumeRequests.set(requestId, { oldId: id, controller });
    let task!: Promise<void>;
    task = (async () => {
      await Promise.resolve();
      try {
        await runRowResume(record, requestId, id);
      } finally {
        if (rowResumeTasks.get(id) === record) rowResumeTasks.delete(id);
        if (rowResumeRequests.get(requestId)?.controller === controller) rowResumeRequests.delete(requestId);
        rowResumeTaskSet.delete(task);
      }
    })();
    rowResumeTaskSet.add(task);
  }

  async function runRowResume(
    record: { readonly controller: AbortController; spawned: boolean },
    requestId: number,
    oldId: string,
  ): Promise<void> {
    const owner = manager;
    const activeSidebar = sidebar;
    const activePi = pi;
    if (!owner || !activeSidebar || shutdownRequested) return;
    const fail = (message: string): void => {
      if (shutdownRequested || !sidebar) return;
      sidebar.failRowResume(requestId, message);
      scheduleRedraw();
    };
    const controller = record.controller;
    // Capture the exact current exited binding before the read-only listing.
    const before = readExitedResumeTarget(oldId);
    if (!before) {
      fail(ROW_RESUME_FAILURE);
      return;
    }
    const agentDir = sessionSetup?.nativeAgentDir;
    if (typeof agentDir !== "string" || agentDir === ""
      || !activePi || !activePi.file || !activePi.version) {
      fail(ROW_RESUME_FAILURE);
      return;
    }
    let catalog: SavedSessionCatalog;
    try {
      catalog = await dependencies.listSavedCatalog({
        agentDir,
        piExecutable: activePi.file,
        expectedPiVersion: activePi.version,
        signal: controller.signal,
      });
    } catch {
      // A canceled listing (navigation, hide, or shutdown) never renders a notice.
      if (controller.signal.aborted || shutdownRequested || !sidebar) return;
      sidebar.failRowResume(requestId, ROW_RESUME_FAILURE);
      scheduleRedraw();
      return;
    }
    if (controller.signal.aborted || shutdownRequested || manager !== owner) return;
    // Re-read the exited/current binding immediately before any spawn: a row
    // that rebound or was replaced refuses instead of restarting something else.
    const after = readExitedResumeTarget(oldId);
    if (!after || after.binding.sessionId !== before.binding.sessionId || after.epoch !== before.epoch) {
      fail(ROW_RESUME_FAILURE);
      return;
    }
    const choice = chooseExitedRestart(after.binding, after.workspace, catalog);
    if (choice.kind === "refused") {
      fail(ROW_RESUME_FAILURE);
      return;
    }
    let createOptions: CreateInstanceOptions;
    let expectedSessionId: string | undefined;
    if (choice.kind === "saved") {
      let result: SavedSessionAdmissionResult;
      try {
        result = admitSavedSession(catalog, choice.row, { ownedLiveSessions: owner.ownedLiveSessions() });
      } catch {
        result = { status: "refused", reason: "unknown-row" };
      }
      if (result.status === "refused") {
        fail(savedRefusalNotice(result.reason));
        return;
      }
      // The exact branded admission is passed verbatim; the manager owns the
      // launch-time file revalidation and known-owned duplicate fence. The
      // replacement must report exactly this saved conversation to qualify.
      expectedSessionId = result.admission.sessionId;
      createOptions = { workspace: result.admission.workspace, savedSession: result.admission };
    } else {
      // Positive known-unsaved binding plus an issue-free, safely absent
      // catalog: a fresh child in the SAME exited owned workspace.
      createOptions = { workspace: choice.cwd };
    }
    if (controller.signal.aborted || shutdownRequested || manager !== owner) return;
    // The spawn starts here: the per-row map now fences duplicates, and any
    // later UI/listing cancel must never discard this already-started child.
    record.spawned = true;
    let createdId: string;
    try {
      createdId = await owner.create(createOptions);
    } catch (error) {
      if (shutdownRequested || !sidebar) return;
      sidebar.failRowResume(requestId,
        error instanceof Error && error.message.includes("already open in this host")
          ? "That saved conversation is already open in this host"
          : ROW_RESUME_FAILURE);
      syncRosterAndSchedule();
      return;
    }
    // PTY spawn alone is not readiness: the replacement must independently own
    // a live process AND report a genuine authenticated CURRENT conversation
    // (exactly the requested saved id for a saved restart) before the old
    // exited placeholder may be replaced. This wait is event-driven through the
    // manager's existing onChange callback, bounded by one deadline, and is not
    // settled by a UI/listing cancellation.
    const readiness = await awaitRowReadiness(createdId, expectedSessionId);
    if (readiness !== "ready") {
      if (shutdownRequested || !sidebar) return;
      sidebar.failRowResume(requestId, ROW_RESUME_FAILURE);
      syncRosterAndSchedule();
      return;
    }
    // Only the actual ready success replaces the old exited placeholder. The
    // replacement completes independently of any UI/listing abort, but the
    // FULL readiness predicate is revalidated at this final fence: synchronous
    // status frames can clear or change the current binding (or the saved id)
    // after the waiter resolved but before this continuation ran.
    if (shutdownRequested || !sidebar) return;
    let createdView: NativeInstanceView | undefined;
    try {
      createdView = owner.list().find((candidate) => candidate.id === createdId);
    } catch {
      createdView = undefined;
    }
    let finalReadiness: RowResumeReadiness;
    try {
      finalReadiness = rowResumeReadiness(createdView, expectedSessionId);
    } catch {
      finalReadiness = "failed";
    }
    if (finalReadiness !== "ready") {
      sidebar.failRowResume(requestId, ROW_RESUME_FAILURE);
      syncRosterAndSchedule();
      return;
    }
    // Complete the UI before the old placeholder is removed so the synchronous
    // roster notification cannot invalidate a still-current deliberate intent.
    syncRosterAndSchedule();
    // Roster synchronization can synchronously initiate shutdown on a listing
    // or metadata failure; that fail-closed path must retain the recovery
    // placeholder instead of completing the restart mid-shutdown.
    if (shutdownRequested || !sidebar) return;
    sidebar.completeRowResume(requestId, oldId, createdId);
    removeExitedRow(oldId, { replaced: true });
    reconcileLayout(true);
  }

  function removeExitedRow(id: string, options?: { readonly replaced?: boolean }): void {
    if (!manager || !sidebar) return;
    const replacing = options?.replaced === true;
    if (replacing) sidebar.noteRowReplacement(id);
    let removed: boolean;
    try { removed = manager.closeExited(id); }
    catch {
      if (replacing) sidebar.clearRowReplacement(id);
      else { sidebar.showError(REMOVE_FAILURE_MESSAGE); scheduleRedraw(); }
      return;
    }
    if (!removed) {
      // An already-removed placeholder is tolerated; nothing else is touched.
      if (replacing) sidebar.clearRowReplacement(id);
      else { sidebar.showError(REMOVE_REFUSED_MESSAGE); scheduleRedraw(); }
      return;
    }
    removedExitedIds.add(id);
    if (activeId === id) activeId = undefined;
    // Actual-exit-only detachment never activates a sibling or loses its owner.
    syncRosterAndSchedule();
    reconcileLayout(true);
  }

  function launchRowStop(id: string, confirmed: boolean): void {
    if (!manager || !sidebar || rowStopTasks.has(id)) return;
    const owner = manager;
    let task!: Promise<void>;
    task = (async () => {
      // Publish duplicate fencing before even a synchronously throwing adapter.
      await Promise.resolve();
      try {
        const stop = owner.stop;
        if (typeof stop !== "function") throw new Error("owned row stop unavailable");
        const result = await stop.call(owner, id, { confirmed: confirmed === true });
        if (shutdownRequested || manager !== owner || !sidebar) return;
        if (result.status === "exited") removeExitedRow(id);
        else {
          sidebar.showError(result.status === "confirmation-required"
            ? "Activity changed or is unknown. Press d again to confirm stopping this session."
            : REMOVE_REFUSED_MESSAGE);
          syncRosterAndSchedule();
        }
      } catch {
        if (!shutdownRequested && sidebar) { sidebar.showError(REMOVE_FAILURE_MESSAGE); scheduleRedraw(); }
      } finally { rowStopTasks.delete(id); }
    })();
    rowStopTasks.set(id, task);
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
            sidebar.failRename(action.requestId, "Pi could not set or verify the new session name; the active session was not changed");
            scheduleRedraw();
          },
        );
        return;
      }
      case "remove":
        removeExitedRow(action.id);
        return;
      case "resume-row":
        if (negotiationReady) launchRowResume(action.requestId, action.id);
        else deferredRowResumes.set(action.requestId, { requestId: action.requestId, id: action.id });
        scheduleRedraw();
        return;
      case "resume-row-cancel": {
        deferredRowResumes.delete(action.requestId);
        const pending = rowResumeRequests.get(action.requestId);
        if (pending === undefined) return;
        rowResumeRequests.delete(action.requestId);
        try { pending.controller.abort(); } catch { /* abort is best-effort */ }
        const record = rowResumeTasks.get(pending.oldId);
        if (record !== undefined && record.controller === pending.controller && !record.spawned) {
          // Pre-spawn cancellation releases the duplicate fence so a later
          // deliberate retry can start; an already-started child is never canceled.
          rowResumeTasks.delete(pending.oldId);
        }
        return;
      }
      case "stop-remove":
        launchRowStop(action.id, action.confirmed);
        return;
      case "saved-list": {
        if (!manager || !sidebar || !pi || !sessionSetup) return;
        const agentDir = sessionSetup.nativeAgentDir;
        if (agentDir === undefined || agentDir === "") {
          sidebar.failSavedList(action.requestId, SAVED_UNAVAILABLE);
          scheduleRedraw();
          return;
        }
        const controller = new AbortController();
        savedListControllers.set(action.requestId, controller);
        void dependencies.listSavedCatalog({
          agentDir,
          piExecutable: pi.file,
          expectedPiVersion: pi.version,
          signal: controller.signal,
        }).then(
          (catalog) => {
            savedListControllers.delete(action.requestId);
            if (shutdownRequested || !sidebar) return;
            const accepted = sidebar.completeSavedList(
              action.requestId,
              catalog.rows.map((row) => ({ id: row.id, file: row.file, caption: row.caption })),
              catalog.issueCount,
            );
            if (accepted) savedCatalog = catalog;
            scheduleRedraw();
          },
          () => {
            savedListControllers.delete(action.requestId);
            if (shutdownRequested || !sidebar) return;
            // A dismissed or shut-down listing is fenced by the sidebar's own
            // requestId; an aborted signal never renders as a failure notice.
            if (controller.signal.aborted) return;
            sidebar.failSavedList(action.requestId, SAVED_UNAVAILABLE);
            scheduleRedraw();
          },
        );
        reconcileLayout(true);
        scheduleRedraw();
        return;
      }
      case "saved-cancel": {
        const controller = savedListControllers.get(action.requestId);
        if (controller !== undefined) {
          savedListControllers.delete(action.requestId);
          try {
            controller.abort();
          } catch { /* abort is best-effort */ }
        }
        return;
      }
      case "saved-open": {
        if (!manager || !sidebar) return;
        if (negotiationReady) launchSavedOpen(action.requestId, action.file, action.sessionId);
        else deferredSavedOpens.set(action.requestId, { file: action.file, sessionId: action.sessionId });
        scheduleRedraw();
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
    deferredSavedOpens.clear();
    deferredRowResumes.clear();
    // Abort every outstanding restart listing; a started child is never killed.
    for (const record of rowResumeTasks.values()) {
      try { record.controller.abort(); } catch { /* abort is best-effort */ }
    }
    for (const pending of rowResumeRequests.values()) {
      try { pending.controller.abort(); } catch { /* abort is best-effort */ }
    }
    // Abort every outstanding saved-conversation listing; late completions of
    // an aborted query never contribute to the UI.
    for (const controller of savedListControllers.values()) {
      try {
        controller.abort();
      } catch { /* abort is best-effort */ }
    }
    savedListControllers.clear();
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
        // Native readiness waits are settled before the restart tasks are
        // awaited: shutdown must never hang for the readiness deadline, and a
        // pending replacement child is left owned and untouched.
        settleRowReadinessWaiters("failed");
        await Promise.allSettled([...createTasks, ...savedOpenTasks, ...rowStopTasks.values(), ...rowResumeTaskSet]);
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
    sessionSetup = dependencies.createSessionSetup({ env: snapshot.env });
    const activeSessionSetup = sessionSetup;
    const createTextField = (options: SidebarFieldFactoryOptions) => {
      if (!activeSessionSetup.nativeAgentDir) {
        throw new Error("native Pi agent directory is unavailable for session-host fields");
      }
      const keybindings = loadNativeFieldKeybindings(activeSessionSetup.nativeAgentDir);
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
      onChange: (id) => noteManagerChanged(id),
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
        for (const [requestId, pending] of deferredSavedOpens) {
          launchSavedOpen(requestId, pending.file, pending.sessionId);
        }
        deferredSavedOpens.clear();
        for (const deferred of deferredRowResumes.values()) {
          launchRowResume(deferred.requestId, deferred.id);
        }
        deferredRowResumes.clear();
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
  /** Pure readiness decision exposed for source regressions (no runtime effect). */
  rowResumeReadiness: (
    view: NativeInstanceView | undefined,
    expectedSessionId: string | undefined,
  ): "ready" | "pending" | "failed" => rowResumeReadiness(view, expectedSessionId),
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
