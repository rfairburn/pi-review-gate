import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { realpathSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import type { Writable } from "node:stream";
import { ProcessTerminal, matchesKey } from "pi-session-host-tui";

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
import {
  MAX_ROSTER_ENTRIES,
  ROSTER_STORE_VERSION,
  isValidRosterName,
  isValidRosterWorkspace,
  openHostState as openProductionHostState,
  type HostStateHandle,
  type HostStateOpenResult,
  type RosterEntry,
  type StoredRoster,
} from "./roster-store";
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
const ROSTER_UNAVAILABLE_MESSAGE = "That remembered conversation is unavailable; remove it or open a saved conversation";
const ROSTER_SAVE_FAILURE_MESSAGE = "The session roster could not be saved; these rows will not be restored after a restart";
const ROSTER_OVERFLOW_MESSAGE = "The session roster is larger than this host can save; the saved roster was left unchanged";
const ROSTER_OWNERSHIP_MESSAGE = "Session host ownership was not confirmed released; a later host will refuse to start until it is resolved.";
const ROSTER_RETAINED_MESSAGE = "Session host ownership is retained because shutdown did not settle.";
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
> & Partial<Pick<InstanceManager, "stop" | "closeError">>;
type MainObserver = Pick<KeyboardCapabilityObserver, "flags" | "wait" | "dispose" | "feed">;
type MainWriter = Pick<SessionHostFrameWriter, "start" | "submit" | "close">
  & Partial<Pick<SessionHostFrameWriter, "invalidate">>;
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
  /**
   * Acquire exclusive ownership of the canonical Pi agent directory and read
   * its globally persisted roster. Production resolves the real store; focused
   * tests inject a hermetic implementation so no real user agent data or lock
   * is ever touched.
   */
  readonly openHostState: (options: { agentDir: string; hostId: string }) => HostStateOpenResult;
  readonly createTerminal: () => MainTerminal;
  readonly createObserver: (options: ConstructorParameters<typeof KeyboardCapabilityObserver>[0]) => MainObserver;
  readonly createWriter: (output: Writable, options: Parameters<typeof createSessionHostFrameWriter>[1]) => MainWriter;
  readonly runExternalEditor: typeof runNativeExternalEditor;
  readonly reportError: (message: string) => void;
}

/**
 * One remembered sidebar roster slot tracked by Main. `slotId` is stable for
 * the slot across native /new and /resume identity changes; `rowId` is the
 * current manager row id when this slot owns a live manager row, and is absent
 * for a remembered conversation that could not be restored (visible as a
 * bounded error row instead of a silently started fresh session). Identity
 * fields stay optional: a row that never reported native metadata, or a
 * conversation that could not be restarted, is still a remembered slot.
 */
interface RosterRecord {
  readonly slotId: string;
  rowId?: string;
  sessionId?: string;
  workspace?: string;
  name?: string;
  persistence?: "saved" | "unsaved" | "unknown";
  /** Bounded truthful reason this remembered conversation is not restorable. */
  unavailableReason?: string;
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

/**
 * Canonical real path of an existing workspace directory, or undefined. Used to
 * require that an automatically restored conversation is restarted in exactly
 * the workspace that was remembered, never in a newly recorded one.
 */
function canonicalExistingDirectory(path: string | undefined): string | undefined {
  if (typeof path !== "string" || path === "") return undefined;
  try {
    return realpathSync(path);
  } catch {
    return undefined;
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
            backgroundTasks: status.backgroundTasks ?? null,
            backgroundShells: status.backgroundShells ?? null,
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
    openHostState: openProductionHostState,
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
  // Globally persisted roster (issue 331): exclusive agent-directory ownership,
  // the remembered ordered slots, and the mapping from this run's manager rows
  // back to their slots. The store is mutated ONLY by roster changes (row
  // create/remove/rename/activate) and never by Quit or teardown, so a normal
  // host shutdown stops owned children without forgetting the roster.
  let hostState: HostStateHandle | undefined;
  const rosterRecords = new Map<string, RosterRecord>();
  const rowSlots = new Map<string, string>();
  // Set for exactly the synchronous stretch of one `manager.create(...)` call
  // that continues an existing slot (startup restore or exited-row restart),
  // so the row inserted by that call is adopted into the reserved slot instead
  // of appending a new one. Nothing can interleave inside that stretch.
  let adoptingSlot: string | undefined;
  let rememberedActiveSlot: string | undefined;
  let lastPersistedRoster = "";
  let rosterSaveFailureNoted = false;
  let rosterOverflowNoted = false;
  let rosterProblemNoted = false;
  let restoreAbort: AbortController | undefined;
  // Every deliberate sidebar action (activation, removal, stop, navigation
  // that reaches Main, typing) advances this generation. A delayed startup
  // restore applies the remembered active entry only while the generation is
  // unchanged, so a later user action is never overridden even when it left
  // `activeId` undefined again.
  let deliberateActionGeneration = 0;
  // Positive evidence that this host's owned-child state settled: a successful
  // manager shutdown result, or a live-state query that actually answered.
  // Unknown/absent evidence never authorizes releasing exclusive ownership.
  let ownedStateSettled = false;
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

  const rosterErrorIdPrefix = "roster-error:";

  function rosterErrorItemId(slotId: string): string {
    return `${rosterErrorIdPrefix}${slotId}`;
  }

  function slotIdFromRosterErrorItemId(id: string): string | undefined {
    if (!id.startsWith(rosterErrorIdPrefix)) return undefined;
    const slotId = id.slice(rosterErrorIdPrefix.length);
    return slotId.length > 0 ? slotId : undefined;
  }

  function toRosterErrorItem(record: RosterRecord): SidebarItem {
    const name = record.name;
    return {
      id: rosterErrorItemId(record.slotId),
      label: name !== undefined && name.trim().length > 0 ? name : "(unavailable conversation)",
      workspace: record.workspace ?? "",
      agentDir: "",
      lifecycle: "error",
      hasLiveProcess: false,
      unavailable: true,
      busy: null,
      pendingInput: null,
      inputSurface: false,
      activity: [record.unavailableReason ?? "This conversation is unavailable"],
    };
  }

  /**
   * Adopt every current manager row into its remembered slot and refresh that
   * slot's last-observed CURRENT conversation identity from the LATEST row in
   * manager order. A slot whose current row left the roster was deliberately
   * removed and is forgotten; a slot with no row stays remembered and renders
   * as a bounded error row at its own remembered position.
   */
  function adoptRosterViews(currentViews: NativeInstanceView[]): void {
    const byRow = new Map(currentViews.map((view) => [view.id, view]));
    const assigned = new Map<string, NativeInstanceView>();
    for (const view of currentViews) {
      const slotId = rowSlots.get(view.id) ?? adoptingSlot;
      const record = slotId === undefined ? undefined : rosterRecords.get(slotId);
      if (record === undefined) {
        const created: RosterRecord = { slotId: view.id };
        rosterRecords.set(created.slotId, created);
        rowSlots.set(view.id, created.slotId);
        assigned.set(created.slotId, view);
      } else {
        rowSlots.set(view.id, record.slotId);
        assigned.set(record.slotId, view);
      }
    }
    for (const [slotId, view] of assigned) {
      const record = rosterRecords.get(slotId);
      if (record === undefined) continue;
      record.rowId = view.id;
      record.unavailableReason = undefined;
      if (view.workspace.length > 0) record.workspace = view.workspace;
      const observed = view.nativeSession ?? view.lastNativeSession;
      if (observed !== undefined && observed !== null && isValidNativeSessionId(observed.sessionId)) {
        record.sessionId = observed.sessionId;
        record.persistence = observed.persistence ?? "unknown";
        // A name outside the native display bound is dropped instead of making
        // the whole roster unpublishable.
        if (isValidRosterName(observed.name)) record.name = observed.name;
        else delete record.name;
      }
    }
    for (const [slotId, record] of [...rosterRecords]) {
      if (record.rowId === undefined || byRow.has(record.rowId)) continue;
      rosterRecords.delete(slotId);
    }
    // Row mappings only exist for current rows; a replaced or removed row's
    // mapping is dropped so a stale id can never claim a slot again.
    for (const rowId of [...rowSlots.keys()]) {
      if (!byRow.has(rowId)) rowSlots.delete(rowId);
    }
  }

  /**
   * Roster DTOs at their stable remembered positions: each remembered slot
   * contributes either its current manager row or, when it has none, its
   * bounded unavailable error row. A slot still awaiting its restore attempt is
   * simply not drawn yet; a live manager row is never hidden.
   */
  function currentRosterItems(): SidebarItem[] {
    const byRow = new Map(views.map((view) => [view.id, view]));
    const emitted = new Set<string>();
    const items: SidebarItem[] = [];
    for (const record of rosterRecords.values()) {
      const view = record.rowId === undefined ? undefined : byRow.get(record.rowId);
      if (view !== undefined) {
        if (emitted.has(view.id)) continue;
        emitted.add(view.id);
        items.push(toSidebarItem(view));
        continue;
      }
      if (record.rowId !== undefined || record.unavailableReason === undefined) continue;
      items.push(toRosterErrorItem(record));
    }
    // Safety net: a manager row without a remembered slot is still drawn.
    for (const view of views) {
      if (!emitted.has(view.id)) items.push(toSidebarItem(view));
    }
    return items;
  }

  /**
   * The persisted projection of the in-memory roster: every remembered slot, in
   * its stable remembered order, with whatever identity it actually observed.
   * A slot with no authenticated conversation id or no known workspace is still
   * persisted (it can only ever restore as an unavailable error entry), and a
   * display-only name outside the native bound is dropped rather than making the
   * whole roster unpublishable. Undefined when the roster exceeds the publishable
   * bound, in which case the published roster is left exactly as it was.
   */
  function buildRosterProjection(): StoredRoster | undefined {
    const entries: RosterEntry[] = [];
    for (const record of rosterRecords.values()) {
      if (entries.length >= MAX_ROSTER_ENTRIES) return undefined;
      entries.push({
        slotId: record.slotId,
        ...(record.sessionId !== undefined && isValidNativeSessionId(record.sessionId)
          ? { sessionId: record.sessionId } : {}),
        ...(record.workspace !== undefined && isValidRosterWorkspace(record.workspace) ? { workspace: record.workspace } : {}),
        ...(record.name !== undefined && isValidRosterName(record.name) ? { name: record.name } : {}),
        ...(record.persistence !== undefined ? { persistence: record.persistence } : {}),
      });
    }
    const activeSlotId = activeId !== undefined ? rowSlots.get(activeId) : rememberedActiveSlot;
    const active = activeSlotId !== undefined && entries.some((entry) => entry.slotId === activeSlotId)
      ? { activeSlotId }
      : {};
    return { version: ROSTER_STORE_VERSION, entries, ...active };
  }

  /**
   * Publish the roster only when it actually changed. A malformed or unwritable
   * store is never overwritten: persistence stays disabled and the bounded
   * problem is surfaced once instead.
   */
  function persistRoster(): void {
    const handle = hostState;
    if (handle === undefined) return;
    if (handle.problem !== undefined) {
      if (!rosterProblemNoted && sidebar) {
        rosterProblemNoted = true;
        sidebar.showError(handle.problem);
        scheduleRedraw();
      }
      return;
    }
    const projection = buildRosterProjection();
    if (projection === undefined) {
      if (!rosterOverflowNoted && sidebar) {
        rosterOverflowNoted = true;
        sidebar.showError(ROSTER_OVERFLOW_MESSAGE);
        scheduleRedraw();
      }
      return;
    }
    const serialized = JSON.stringify(projection);
    if (serialized === lastPersistedRoster) return;
    if (!handle.persist(projection)) {
      if (!rosterSaveFailureNoted && sidebar) {
        rosterSaveFailureNoted = true;
        sidebar.showError(ROSTER_SAVE_FAILURE_MESSAGE);
        scheduleRedraw();
      }
      return;
    }
    lastPersistedRoster = serialized;
  }

  /** Seed the remembered slots from the persisted roster observed at open. */
  function initializeRosterRecords(stored: StoredRoster | undefined): void {
    if (stored !== undefined) {
      for (const entry of stored.entries) {
        if (rosterRecords.has(entry.slotId)) continue;
        rosterRecords.set(entry.slotId, {
          slotId: entry.slotId,
          ...(entry.sessionId !== undefined ? { sessionId: entry.sessionId } : {}),
          ...(entry.workspace !== undefined ? { workspace: entry.workspace } : {}),
          ...(entry.name !== undefined ? { name: entry.name } : {}),
          ...(entry.persistence !== undefined ? { persistence: entry.persistence } : {}),
        });
      }
    }
    rememberedActiveSlot = stored?.activeSlotId;
    // Baseline the published projection so an unchanged roster is never rewritten.
    const baseline = buildRosterProjection();
    lastPersistedRoster = baseline === undefined ? "" : JSON.stringify(baseline);
  }

  /**
   * Deliberate removal of one remembered-but-unavailable entry. Only a slot
   * that owns no manager row can be removed here; a live/exited row is removed
   * through its own manager-owned path.
   */
  function removeRosterEntry(slotId: string): void {
    const record = rosterRecords.get(slotId);
    if (record === undefined || record.rowId !== undefined) {
      sidebar?.showError(REMOVE_REFUSED_MESSAGE);
      scheduleRedraw();
      return;
    }
    rosterRecords.delete(slotId);
    if (rememberedActiveSlot === slotId) rememberedActiveSlot = undefined;
    syncRosterAndSchedule();
    reconcileLayout(true);
  }

  /**
   * Automatic global roster restoration (issue 331). Every remembered entry is
   * revalidated against a FRESH saved-conversation catalog and restarted only
   * through a new exact branded admission as a NEW independently owned child in
   * the conversation's recorded workspace. Nothing is adopted, guessed, or
   * substituted; an entry that cannot be freshly admitted stays visible as a
   * bounded error row and never starts a fresh session.
   */
  async function restorePersistedRoster(): Promise<void> {
    const handle = hostState;
    const activeManager = manager;
    const activeSidebar = sidebar;
    const stored = handle?.roster;
    if (handle === undefined || activeManager === undefined || activeSidebar === undefined) return;
    if (handle.problem !== undefined) return; // surfaced truthfully by persistRoster
    if (stored === undefined || stored.entries.length === 0) return;
    // Automatic activation is fenced by the deliberate-action generation, not by
    // the current activeId alone: a user who activates and then clears/removes a
    // row during a slow restore must not have the remembered sibling activated
    // afterwards. The startup fence is absolute — any deliberate action at all,
    // including one received while keyboard negotiation is still settling,
    // invalidates the automatic activation.
    const generationAtStart = 0;
    const agentDir = sessionSetup?.nativeAgentDir;
    const activePi = pi;
    const controller = new AbortController();
    restoreAbort = controller;
    let catalog: SavedSessionCatalog | undefined;
    if (typeof agentDir === "string" && agentDir !== "" && activePi !== undefined && activePi.file && activePi.version) {
      try {
        catalog = await dependencies.listSavedCatalog({
          agentDir,
          piExecutable: activePi.file,
          expectedPiVersion: activePi.version,
          signal: controller.signal,
        });
      } catch {
        catalog = undefined;
      }
    }
    if (controller.signal.aborted || shutdownRequested || manager !== activeManager) return;
    // Decide every entry synchronously from this one catalog snapshot, minting
    // each branded admission BEFORE any row is created: a later listing, a
    // catalog revision bump, or a concurrent user action can never invalidate an
    // admission half-way through restoration.
    const decisions = stored.entries.map((entry) => {
      let createOptions: CreateInstanceOptions | undefined;
      let reason = "This conversation is unavailable";
      const entrySessionId = entry.sessionId;
      // The remembered workspace is part of the contract: a conversation whose
      // current header resolves elsewhere is never silently launched there.
      const rememberedWorkspace = canonicalExistingDirectory(entry.workspace);
      const matching = entrySessionId === undefined
        ? []
        : (catalog?.rows.filter((row) => row.id === entrySessionId) ?? []);
      const row = matching[0];
      if (entrySessionId === undefined) {
        reason = "This remembered session never reported a conversation; it was not restarted";
      } else if (catalog === undefined) {
        reason = "The saved conversation list is unavailable; this conversation was not restarted";
      } else if (matching.length > 1) {
        reason = "More than one saved conversation matches this session; it was not restarted";
      } else if (row === undefined) {
        reason = catalog.issueCount !== 0
          ? "The saved conversation list is incomplete; this conversation was not restarted"
          : entry.persistence === "unsaved"
            ? "This conversation was never saved to disk; it was not restarted"
            : "This conversation is no longer saved to disk; it was not restarted";
      } else {
        let admitted: SavedSessionAdmissionResult;
        try {
          admitted = admitSavedSession(catalog, row, { ownedLiveSessions: activeManager.ownedLiveSessions() });
        } catch {
          admitted = { status: "refused", reason: "unknown-row" };
        }
        if (admitted.status === "refused") {
          reason = `This conversation could not be revalidated: ${savedRefusalNotice(admitted.reason)}`;
        } else if (rememberedWorkspace === undefined || rememberedWorkspace !== admitted.admission.workspace) {
          reason = "This conversation's recorded workspace changed; it was not restarted";
        } else {
          createOptions = { workspace: admitted.admission.workspace, savedSession: admitted.admission };
        }
      }
      return { entry, createOptions, reason };
    });
    for (const decision of decisions) {
      if (shutdownRequested || manager !== activeManager) return;
      const record = rosterRecords.get(decision.entry.slotId);
      if (record === undefined) continue;
      if (decision.createOptions === undefined) {
        record.rowId = undefined;
        record.unavailableReason = decision.reason;
        continue;
      }
      adoptingSlot = decision.entry.slotId;
      let created: Promise<string>;
      try {
        created = activeManager.create(decision.createOptions);
      } finally {
        adoptingSlot = undefined;
      }
      try {
        await created;
      } catch {
        const live = rosterRecords.get(decision.entry.slotId);
        if (live !== undefined && live.rowId === undefined) {
          live.unavailableReason = "This conversation could not be started; it was not replaced";
        }
      }
    }
    if (shutdownRequested || manager !== activeManager) return;
    // The remembered active entry is applied only after every restore attempt
    // and only while no deliberate user action occurred since restoration began,
    // so a slow restore can never override a user's own focus or action.
    if (deliberateActionGeneration === generationAtStart) {
      const activeSlot = stored.activeSlotId;
      const activeRecord = activeSlot === undefined ? undefined : rosterRecords.get(activeSlot);
      if (activeRecord?.rowId !== undefined) {
        activeId = activeRecord.rowId;
        rememberedActiveSlot = activeRecord.slotId;
        reconcileLayout(true);
      }
    }
    syncRosterAndSchedule();
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
      adoptRosterViews(views);
      if (activeId !== undefined && !views.some((view) => view.id === activeId)) {
        activeId = undefined;
        rememberedActiveSlot = undefined;
      }
      // View-only observer: the sidebar's white title highlight follows the
      // actual active Main owner; clearing it here (owner row gone) prevents a
      // false sibling highlight. It never changes activation or ownership.
      sidebar.setActiveMainOwner(activeId);
      sidebar.updateItems(currentRosterItems());
      persistRoster();
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
      // Focus-only and selection-only host actions (for example the roster-only
      // Alt+Right return to Main) emit no SidebarAction, so the deliberate-action
      // generation is advanced from the sidebar's own observable state as well.
      const previousFocus = sidebar.focus;
      const previousSelection = sidebar.selectedId;
      const previousVisibility = sidebar.visible;
      sidebar.handleInput(data);
      if (sidebar.focus !== previousFocus || sidebar.selectedId !== previousSelection
        || sidebar.visible !== previousVisibility) {
        deliberateActionGeneration += 1;
      }
      reconcileLayout(false);
      scheduleRedraw();
    } catch {
      requestShutdown(true);
    }
  }

  function handleTerminalResize(): void {
    // A real outer resize can reflow the physical screen and then return to
    // the same final geometry before the next coalesced redraw (for example
    // 80 -> 40 -> 80). Invalidate the known baseline before recomputing so the
    // next frame is a complete repaint even when content and geometry did not
    // change. The injected writer seam may omit invalidation; the real writer
    // always implements it.
    writer?.invalidate?.();
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
          // A successful New submission activates the created child as the
          // Main input owner (the sidebar emits select); launch-error rows
          // never reach this success path.
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
   * --session admission. The active session is never touched; a successful
   * open activates the restored child as the Main input owner (the sidebar
   * emits select), with the pane's visibility unchanged.
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
          // A successful Saved open activates the restored child as the Main
          // input owner; launch-error rows never reach this success path.
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
    // The replacement is a NEW, independently remembered slot until it actually
    // replaces the old placeholder: adopting it into the old slot before
    // readiness succeeds would collapse two visible rows into one persisted
    // entry and lose a retained row without any explicit removal. The stable
    // slot moves only when the old placeholder is removed below.
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
    removeExitedRow(oldId, { replaced: true, replacementId: createdId });
    reconcileLayout(true);
  }

  /**
   * Remove one row, optionally completing a confirmed deliberate replacement.
   *
   * A successful replacement transfers its stable roster slot into the old
   * placeholder's position: the slot id, its remembered position, and its
   * active-slot mapping all follow the replaced row, so restarting A in an A,B
   * roster never reorders it to B,A. The transfer happens only after the old
   * row's removal is confirmed, and synchronous roster synchronization is
   * suppressed across that confirmation so the old slot cannot be dropped
   * before the transfer runs.
   */
  function removeExitedRow(id: string, options?: { readonly replaced?: boolean; readonly replacementId?: string }): void {
    if (!manager || !sidebar) return;
    const replacing = options?.replaced === true;
    const replacementId = options?.replacementId;
    const oldSlot = rowSlots.get(id);
    const replacementSlot = replacementId === undefined ? undefined : rowSlots.get(replacementId);
    const replacementRecord = replacementSlot === undefined ? undefined : rosterRecords.get(replacementSlot);
    const wasSyncing = rosterSyncInProgress;
    if (replacing) sidebar.noteRowReplacement(id);
    let removed: boolean;
    try {
      if (replacing) rosterSyncInProgress = true;
      removed = manager.closeExited(id);
    }
    catch {
      if (replacing) sidebar.clearRowReplacement(id);
      else { sidebar.showError(REMOVE_FAILURE_MESSAGE); scheduleRedraw(); }
      return;
    } finally {
      rosterSyncInProgress = wasSyncing;
    }
    if (!removed && !replacing) {
      // A settled error row without an owned PTY exit is closed only through
      // the manager's own closeError authority. Resume replacements never get
      // this fallback: they remain closeExited-only.
      const outcome = tryCloseError(manager, id);
      if (outcome === "closed") removed = true;
      else if (outcome === "failure") return; // generic failure already shown
    }
    if (!removed) {
      // An already-removed placeholder is tolerated; nothing else is touched.
      if (replacing) sidebar.clearRowReplacement(id);
      else { sidebar.showError(REMOVE_REFUSED_MESSAGE); scheduleRedraw(); }
      return;
    }
    removedExitedIds.add(id);
    if (replacing && replacementId !== undefined && oldSlot !== undefined
      && replacementSlot !== undefined && replacementSlot !== oldSlot
      && replacementRecord !== undefined && rosterRecords.has(oldSlot)) {
      // Updating an existing Map key preserves its original remembered position;
      // the replacement's own appended slot is dropped at the same moment.
      rosterRecords.set(oldSlot, { ...replacementRecord, slotId: oldSlot, rowId: replacementId });
      rosterRecords.delete(replacementSlot);
      rowSlots.delete(id);
      rowSlots.set(replacementId, oldSlot);
      if (rememberedActiveSlot === replacementSlot) rememberedActiveSlot = oldSlot;
    }
    if (activeId === id) activeId = undefined;
    // Authoritatively settled removal never activates a sibling or loses its owner.
    syncRosterAndSchedule();
    reconcileLayout(true);
  }

  /**
   * Deliberate-removal fallback for an error row whose closeExited refused:
   * call the optional manager closeError only when the exact current manager
   * row is still in "error" lifecycle. A missing method or a refusal leaves
   * the decision to the caller; a thrown closeError reports the generic
   * failure and keeps the row. No signal, sibling, or other fallback.
   */
  function tryCloseError(owner: MainManager, id: string): "closed" | "not-applicable" | "failure" {
    const closeError = owner.closeError;
    if (typeof closeError !== "function") return "not-applicable";
    if (readReadinessView(id)?.lifecycle !== "error") return "not-applicable";
    try {
      return closeError.call(owner, id) === true ? "closed" : "not-applicable";
    } catch {
      sidebar?.showError(REMOVE_FAILURE_MESSAGE);
      scheduleRedraw();
      return "failure";
    }
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
    // Any deliberate user action invalidates a pending automatic activation.
    deliberateActionGeneration += 1;
    switch (action.type) {
      case "forward":
        routeForward(action.data);
        return;
      case "select": {
        // This action is emitted only by an explicit roster activation. A
        // remembered-but-unavailable entry has no process to own, so it never
        // becomes the input owner; the refusal is surfaced instead.
        const unavailableSlot = slotIdFromRosterErrorItemId(action.id);
        if (unavailableSlot !== undefined) {
          sidebar?.showError(ROSTER_UNAVAILABLE_MESSAGE);
          scheduleRedraw();
          return;
        }
        activeId = action.id;
        rememberedActiveSlot = rowSlots.get(action.id);
        syncRosterAndSchedule();
        reconcileLayout(true);
        return;
      }
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
      case "remove": {
        const unavailableSlot = slotIdFromRosterErrorItemId(action.id);
        if (unavailableSlot !== undefined) {
          removeRosterEntry(unavailableSlot);
          return;
        }
        removeExitedRow(action.id);
        return;
      }
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
              // Display metadata only: the exact recorded workspace (header
              // cwd) flows to the picker's single-line summary and details.
              // Admission always revalidates the raw catalog row, never this.
              catalog.rows.map((row) => ({ id: row.id, file: row.file, caption: row.caption, cwd: row.cwd })),
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
    // Abort an in-flight startup roster restoration; nothing it has not already
    // started is spawned, and an already-started child stays owned.
    try { restoreAbort?.abort(); } catch { /* abort is best-effort */ }
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
              // The manager's own settled shutdown result is positive evidence.
              ownedStateSettled = true;
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
          // A live-state query that actually answered is positive evidence.
          ownedStateSettled = true;
        } catch {
          remainingCount = shutdownResult?.remainingIds.length ?? 0;
          try {
            if (remainingCount === 0 && manager.hasLiveProcesses()) remainingCount = 1;
            // The fallback liveness query answered truthfully.
            ownedStateSettled = true;
          } catch {
            // Both owned-child queries are unavailable: no positive settlement
            // evidence exists, so exclusive ownership is retained fail closed.
            cleanupFailure = true;
          }
        }
      } else {
        // No manager was ever constructed: this host owns no child at all.
        remainingCount = shutdownResult?.remainingIds.length ?? 0;
        ownedStateSettled = true;
      }
      if (broker) {
        try {
          await broker.dispose();
        } catch {
          cleanupFailure = true;
        }
      }

      removeOuterListeners();
      let failed = runtimeFailure || cleanupFailure || forcedCount > 0 || remainingCount > 0;
      // Exclusive agent-directory ownership is released only when owned shutdown
      // settled: a positively settled manager result or live-state answer, and no
      // owned process still unconfirmed. Unknown or absent child state (every
      // query unavailable) keeps ownership held (fail closed) so a later host
      // refuses instead of racing children that may still be running.
      if (hostState !== undefined) {
        if (remainingCount === 0 && ownedStateSettled) {
          let released = false;
          try {
            released = hostState.release();
          } catch {
            released = false;
          }
          if (!released) {
            cleanupFailure = true;
            failed = true;
            safeReport(dependencies, ROSTER_OWNERSHIP_MESSAGE);
          }
        } else {
          safeReport(dependencies, ROSTER_RETAINED_MESSAGE);
        }
      }
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
    // Global roster and single-host ownership (issue 331): acquire exclusive
    // ownership of the canonical Pi agent directory and read the persisted
    // roster BEFORE any roster entry, manager row, or child exists. A host that
    // shares the same agent directory refuses here with an actionable message
    // and starts nothing.
    if (sessionSetup.nativeSetup === true
      && typeof sessionSetup.nativeAgentDir === "string" && sessionSetup.nativeAgentDir !== "") {
      const opened = dependencies.openHostState({ agentDir: sessionSetup.nativeAgentDir, hostId: randomUUID() });
      if (opened.status === "refused") {
        safeReport(dependencies, opened.message);
        runtimeFailure = true;
        shutdownRequested = true;
        startupComplete = true;
        beginShutdown();
        return await runFinished;
      }
      hostState = opened.state;
      initializeRosterRecords(opened.state.roster);
    }
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
        // Mirror the field's own effective submit resolution: the configured
        // `tui.input.submit` binding when it is defined, otherwise Enter. The
        // submission provenance fence uses this to consume the held key.
        matchesSubmit: (data: string) => {
          try {
            const defined = typeof keybindings.manager.getDefinition === "function"
              ? keybindings.manager.getDefinition("tui.input.submit") !== undefined
              : true;
            return defined
              ? keybindings.manager.matches(data, "tui.input.submit")
              : matchesKey(data, "enter");
          } catch {
            return matchesKey(data, "enter");
          }
        },
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
      // Restore the globally persisted roster before any deliberate user action
      // is admitted: restored rows keep their remembered order and the
      // remembered active entry is applied only while no later deliberate
      // activation exists.
      if (!shutdownRequested) await restorePersistedRoster();
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
  /** Production broker-to-manager adapter, exposed only for wiring regressions. */
  statusRegistrar,
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
