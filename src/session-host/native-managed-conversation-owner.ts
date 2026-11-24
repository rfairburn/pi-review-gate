/**
 * #682: the production owner of the managed Subtasks tools for ONE exact,
 * host-proved native (Claude/Codex) conversation run.
 *
 * Composition only; every rule lives in an existing module:
 * - {@linkcode createNativeManagedOwnerRestore}: one durable restore of this
 *   exact owner's execution associations into the host's real manager, and
 *   the association save path;
 * - the real no-Pi `ExecutionToolManager` with a fixed `hostExposure`;
 * - {@linkcode createNativeManagedToolDelegate}: the lane adapter onto the
 *   canonical shared handler (admission, duplicate fence, effect guards);
 * - {@linkcode readPersistedReviewGateSnapshot} and
 *   {@linkcode resolveNativeWorkerToolCeiling}: one fresh saved-settings
 *   snapshot and the parent tool ceiling computed from it, per Start and per
 *   Add.
 *
 * One owner serves one run, never a registry. The host constructs it with the
 * exact {@linkcode NativeMcpLaneRunScope} object its lane hands out, the
 * lane's row/backend/workspace/conversation identity, and its own trusted
 * facts (state root, settings source, Pi executable/version/launch arguments,
 * scoped models). The row id is the association owner's slot id.
 *
 * Scope resolution. A lane call reaches the manager only when its context
 * carries that same run object (identity, not shape), the same row, backend,
 * workspace, and conversation, the restore settled ready, and the run is still
 * current; the delegate re-proves the call's own context around it. Anything
 * else lists no tools and answers every call as not exposed.
 *
 * Settings. The manager's base configuration (live worker capacity and pool
 * resolvability for every group, and the settings for paths that carry no
 * Start snapshot) is ONE strict saved snapshot read when the manager is
 * constructed; a disabled or unavailable read fails construction, so nothing
 * restores or is exposed. Each admitted Start then reads one fresh snapshot
 * and computes its ceiling from that same snapshot; a disabled, unavailable,
 * or refused read refuses that Start before the handler. A Start snapshot
 * pins only the group it admits; earlier groups keep theirs, and the base is
 * never rewritten. Each admitted Add reads its own fresh snapshot and ceiling
 * the same way (same reader, same refusals) and applies it only to the tasks it
 * adds: a fresh snapshot with no worker route for the group's kind refuses the
 * Add, and otherwise it sets their tool catalog and captured evidence policy
 * (worker runtime permissions stay governed by each external adapter). The
 * target group keeps its own settings (its Start snapshot while this manager
 * holds it, otherwise the base) for route selection, worker/reviewer launch
 * configuration, and continuation, and earlier tasks keep what they were
 * admitted with. No live Pi registry is synthesized: the manager's own
 * `authorizedTools` answers undefined, so any path without a Start or Add
 * snapshot that needs a parent ceiling fails closed.
 *
 * Pi-sourced workers and reviewers. The manager carries the host's admitted
 * Pi executable (the same verified file the ceiling is computed for) as its
 * trusted, nonpersisted `admittedPiCommand`, so a configured Pi worker and a
 * Pi model reviewer launch through that file, never an ambient `pi`, and an
 * unusable file refuses the launch instead of falling back. Every Start and
 * Add still reads one fresh saved snapshot and its version-pinned ceiling;
 * the path is never written to settings or durable records.
 *
 * Exposure. Start, Add, Inspect, Continue, Steer, Interrupt, ForceMerge,
 * and MarkClean, plus Watch only as described below. Add tops off only a group this owner's
 * manager holds (the canonical handler resolves it there), fenced by the lane
 * like Start. Continue and Steer likewise resolve only tasks this owner's
 * manager holds: Continue is fenced by the lane at each admission recheck and
 * before any recovery update (an explicit reattachment bundle stays refused
 * by the canonical boundary), and Steer records its command synchronously
 * after admission. Neither reads a settings snapshot: Continue dispatches on
 * the group's own settings, and admitted work is saved and pumped (Steer:
 * delivered) as on Pi even if the lane falls afterwards. Interrupt and
 * ForceMerge resolve only tasks this owner's manager holds and MarkClean
 * (no arguments) clears only its controller's own validated gates; all three
 * are fenced by the lane before each new effect, read no settings snapshot,
 * and an admitted interrupt or a merge that entered the workspace settles as
 * on Pi.
 * Canonical outcome and Watch events go to the host's optional, run-bound
 * `nativeEventSink` when it is given (it is the sole transport for them
 * then); other controller notifications go to the host's optional
 * `notify`, which also receives a sink delivery-failure diagnostic.
 *
 * Watch. Offered only when the host gives BOTH that sink and its run-bound
 * `watchDeliveryCurrent` predicate: the canonical one-shot Watch is then
 * bound (`hostExposure`), and the live call policy admits it only while the
 * run is current AND the predicate holds. The canonical binding reads that
 * policy for discovery (so a run without a live sender does not list Watch)
 * and for every call synchronously immediately before its owner admission,
 * after which the controller arms the subscription with no await. Watch arms
 * the controller's existing single per-execution subscription and timer:
 * a refused call arms nothing and leaves an armed watch untouched, and an
 * earlier completion, failure, conflict, or recovery event supersedes it as
 * on Pi. Its checkpoint makes exactly the sink's one delivery attempt; the
 * predicate never authorizes a send by itself. Without either input Watch is
 * neither bound nor offered.
 *
 * Activity. The manager opts into its own host-local activity census
 * (`ExecutionToolManager.activityCensus()`), so independent owners never share
 * the process-global Pi registry source; the host reads it for row display only.
 *
 * Lifecycle custody stays with the caller. `prepare()` returns the restore
 * result, including a `retainedManager` on a stale or failed outcome. Nothing
 * here detaches, shuts down, or cancels the manager or its work, neither on a
 * request's abort nor on the run's revocation; retirement and any restart
 * policy are the host's.
 */
import { ExecutionToolManager, type ManagedStartSettings, type SharedManagedToolAction } from "../execution/tool";
import { EXECUTION_TOOL_NAMES } from "../execution/tool-names";
import type { ManagedNativeEventSink } from "../execution/wake-delivery";
import { createState } from "../state";
import type { NativeMcpLaneContext, NativeMcpLaneDelegate, NativeMcpLaneRunScope } from "./instances";
import { createNativeManagedOwnerRestore, type NativeManagedOwnerRestoreResult } from "./native-managed-owner-restore";
import {
  createNativeManagedToolDelegate,
  type NativeManagedToolOwnerIdentity,
  type NativeManagedToolScope,
} from "./native-managed-tool-delegate";
import { resolveNativeWorkerToolCeiling, type NativeWorkerToolPolicyDependencies } from "./native-worker-tool-policy";
import { readPersistedReviewGateSnapshot, type PersistedReviewGateSource } from "./persisted-review-gate-snapshot";

/** The shared actions this owner binds and offers on its lane (the host lane's pre-proof catalog lists the same set). */
const OWNER_ACTIONS: readonly SharedManagedToolAction[] = Object.freeze([
  "start", "add", "inspect", "continue", "steer", "interrupt", "force_merge", "mark_clean",
]);
/**
 * The same set plus the one-shot Watch, for an owner with a run-bound delivery
 * sink and its sender predicate (the host lane's receipt-gated delivery
 * catalog lists Watch).
 */
const OWNER_ACTIONS_WITH_WATCH: readonly SharedManagedToolAction[] = Object.freeze([...OWNER_ACTIONS, "watch"]);
const OWNER_TOOL_NAMES: ReadonlySet<string> = new Set(OWNER_ACTIONS.map((action) => EXECUTION_TOOL_NAMES[action]));
const WATCH_TOOL_NAME = EXECUTION_TOOL_NAMES.watch;

/** The host's resolved native Pi facts that worker ceilings are computed from. */
export interface NativeManagedConversationPiHost {
  /** Absolute path of the resolved native Pi CLI file; also the admitted launch file for Pi workers and reviewers. */
  readonly executable: string;
  /** The admitted Pi version. */
  readonly version: string;
  /** The exact arguments the host forwards to Pi. */
  readonly launchArgs: readonly string[];
  /** Owner fact for native codemode in host and worker; anything but `true` withholds it. */
  readonly nativeCodemodeAvailable?: boolean;
}

export interface NativeManagedConversationOwnerOptions {
  /** The exact run proof the lane hands out (`NativeMcpLaneContext.run`), matched by identity. */
  readonly run: NativeMcpLaneRunScope;
  /** The lane's row, backend, canonical workspace, and bound conversation. */
  readonly identity: NativeManagedToolOwnerIdentity;
  /** Trusted host state root for the owner association store. */
  readonly stateRoot: string;
  /** Host settings source for every saved-snapshot read. */
  readonly settings: PersistedReviewGateSource;
  readonly pi: NativeManagedConversationPiHost;
  /** The host's scoped model selectors for this owner's workers. */
  readonly scopedModels?: readonly string[];
  /** Host delivery for controller notifications. */
  readonly notify?: (message: string) => void | Promise<void>;
  /** #682: the host's run-bound sink for canonical outcome and Watch events (see ManagedNativeEventSink). */
  readonly nativeEventSink?: ManagedNativeEventSink;
  /**
   * #682: the host's trusted, synchronous, side-effect-free predicate that this
   * exact run still has the live backend sender `nativeEventSink` would use.
   * Only together with that sink does it bind and offer Watch (see the module
   * note); it never sends, and a throw counts as false.
   */
  readonly watchDeliveryCurrent?: () => boolean;
  /** Test-only ceiling seams; production callers never pass hooks. */
  readonly testHooks?: { readonly ceiling?: NativeWorkerToolPolicyDependencies };
}

export interface NativeManagedConversationOwner {
  /** Pass as `NativeMcpLaneOwner.delegate`. Exposes nothing until `prepare()` is ready. */
  readonly delegate: NativeMcpLaneDelegate;
  /**
   * The single restore attempt, shared by every call; never rejects. A ready
   * result (and any retained manager) is the caller's to retire.
   */
  prepare(): Promise<NativeManagedOwnerRestoreResult<ExecutionToolManager>>;
}

/** Build the owner for one host-proved run. Throws only on malformed host inputs. */
export function createNativeManagedConversationOwner(options: NativeManagedConversationOwnerOptions): NativeManagedConversationOwner {
  const { run, stateRoot, notify, nativeEventSink, watchDeliveryCurrent, testHooks } = options;
  if (typeof run !== "object" || run === null || !(run.signal instanceof AbortSignal) || typeof run.isCurrent !== "function") {
    throw new Error("session-host: a native managed conversation owner requires the exact host-proved run");
  }
  if (nativeEventSink !== undefined && typeof nativeEventSink !== "function") {
    throw new Error("session-host: a native managed conversation event sink must be a function");
  }
  if (watchDeliveryCurrent !== undefined && (typeof watchDeliveryCurrent !== "function" || nativeEventSink === undefined)) {
    throw new Error("session-host: a native managed conversation Watch sender predicate must be a function beside its event sink");
  }
  // Watch only with both host inputs: the sink is its only transport.
  const actions = watchDeliveryCurrent === undefined ? OWNER_ACTIONS : OWNER_ACTIONS_WITH_WATCH;
  // Bind every host input once, so later caller mutation changes nothing.
  const { rowId, backend, workspace, conversationId } = options.identity;
  const identity: NativeManagedToolOwnerIdentity = Object.freeze({ rowId, backend, workspace, conversationId });
  const settings: PersistedReviewGateSource = Object.freeze({
    env: Object.freeze({ ...options.settings.env }),
    agentDir: options.settings.agentDir,
    ...(options.settings.resolvedHomeDir === undefined ? {} : { resolvedHomeDir: options.settings.resolvedHomeDir }),
  });
  const { executable, version, nativeCodemodeAvailable } = options.pi;
  const launchArgs = Object.freeze([...options.pi.launchArgs]);
  const scopedModels = options.scopedModels === undefined ? undefined : Object.freeze([...options.scopedModels]);
  if (scopedModels?.some((model) => typeof model !== "string")) {
    throw new Error("session-host: native managed conversation scoped models must be strings");
  }

  const runIsCurrent = (): boolean => {
    try {
      return !run.signal.aborted && run.isCurrent() === true;
    } catch {
      return false;
    }
  };
  /** The exact run is current and still has its live delivery sender. Fails closed. */
  const watchAllowed = (): boolean => {
    if (watchDeliveryCurrent === undefined || !runIsCurrent()) return false;
    try {
      return watchDeliveryCurrent() === true;
    } catch {
      return false;
    }
  };

  const restore = createNativeManagedOwnerRestore<ExecutionToolManager>({
    stateRoot,
    owner: { slotId: rowId, backend, conversationId, workspace },
    isCurrent: runIsCurrent,
    createManager: (save) => {
      const base = readPersistedReviewGateSnapshot(settings);
      if (base.status !== "available") throw new Error(`session-host: native owner settings are ${base.status}`);
      const manager = new ExecutionToolManager({
        pi: undefined,
        config: structuredClone(base.config),
        state: createState(),
        cwd: () => workspace,
        authorizedTools: () => undefined,
        // Read by the canonical binding for discovery and synchronously right
        // before each owner admission; Watch also needs the live sender.
        liveToolCallAllowed: (name) => name === WATCH_TOOL_NAME
          ? watchAllowed()
          : OWNER_TOOL_NAMES.has(name) && runIsCurrent(),
        hostExposure: { actions },
        // #682: this owner's controller drives its own per-owner census (never
        // the process-global Pi registry), read by the host's row projection.
        hostActivityCensus: true,
        // #682: Pi workers and Pi model reviewers launch through the host's
        // verified executable (runtime only, never persisted).
        admittedPiCommand: executable,
        onAssociationsChanged: save,
        ...(notify === undefined ? {} : { notify }),
        ...(nativeEventSink === undefined ? {} : { nativeEventSink }),
      });
      if (scopedModels !== undefined) manager.setScopedModels(scopedModels);
      return manager;
    },
  });

  /** One fresh saved snapshot and the ceiling from that same snapshot, or undefined (refuses the Start or Add). */
  const readStartSettings = (): ManagedStartSettings | undefined => {
    const snapshot = readPersistedReviewGateSnapshot(settings);
    if (snapshot.status !== "available") return undefined;
    try {
      const ceiling = resolveNativeWorkerToolCeiling({
        piExecutable: executable,
        piVersion: version,
        cwd: workspace,
        launchArgs,
        settings: snapshot.config,
        nativeCodemodeAvailable: nativeCodemodeAvailable === true,
      }, testHooks?.ceiling);
      return { config: snapshot.config, authorizedTools: ceiling.parentCeiling };
    } catch {
      return undefined;
    }
  };

  // The base pool is resolved once, after the restore is ready; a failure is sticky.
  let sync: "pending" | "synced" | "failed" = "pending";
  const resolveScope = (context: NativeMcpLaneContext): NativeManagedToolScope | undefined => {
    if (sync !== "synced"
      || context.run !== run
      || context.rowId !== rowId
      || context.backend !== backend
      || context.workspace !== workspace
      || context.conversationId !== conversationId) {
      return undefined;
    }
    const manager = restore.readyManager();
    return manager === undefined ? undefined : { owner: identity, manager, actions, readStartSettings };
  };

  const toolDelegate = createNativeManagedToolDelegate({ resolveScope });
  /**
   * #682: Watch is bound for this owner and every Watch discovery condition but
   * the live sender holds for this exact context right now: the request is still
   * current, the run is current, and the context resolves this owner's ready,
   * synced scope (exact run, slot row, backend, workspace, and conversation).
   * Read synchronously; it never reads the sender predicate, sends, or arms.
   */
  const discoveryAwaitsDeliverySender = (context: NativeMcpLaneContext): boolean => {
    if (watchDeliveryCurrent === undefined || !runIsCurrent()) return false;
    try {
      if (!(context.signal instanceof AbortSignal) || context.signal.aborted || context.isCurrent() !== true) return false;
      return resolveScope(context) !== undefined;
    } catch {
      return false;
    }
  };

  return Object.freeze({
    delegate: Object.freeze({
      listTools: toolDelegate.listTools,
      callTool: toolDelegate.callTool,
      discoveryAwaitsDeliverySender,
    }),
    prepare: async (): Promise<NativeManagedOwnerRestoreResult<ExecutionToolManager>> => {
      const result = await restore.restore();
      if (result.status !== "ready") return result;
      // The run may have been revoked after the hand-out, before this resumed.
      const stale = { status: "stale", retainedManager: result.manager } as const;
      if (restore.readyManager() !== result.manager) return stale;
      if (sync === "pending") {
        try {
          // Resolves the fixed base pool, which gates canonical exposure.
          result.manager.sync();
          sync = "synced";
        } catch {
          sync = "failed";
        }
      }
      if (sync !== "synced") return { status: "failed", reason: "manager-construction-failed", retainedManager: result.manager };
      return restore.readyManager() === result.manager ? result : stale;
    },
  });
}
