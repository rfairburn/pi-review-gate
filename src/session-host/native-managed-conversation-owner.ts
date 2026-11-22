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
 * Pi-sourced workers. The canonical executor factory launches a Pi worker from
 * the ambient `pi` command, not from the host's admitted Pi executable that
 * the ceiling is computed for, and no manager input carries that executable
 * yet. Until that launch seam exists, a snapshot whose worker catalog holds
 * any Pi-sourced resource is refused: as the base it fails construction, and
 * as a Start or Add snapshot it refuses that call before any ceiling, group,
 * or task.
 *
 * Exposure. Only Start, Add, Inspect, Continue, Steer, Interrupt, ForceMerge,
 * and MarkClean: Watch needs the wake routing a later slice wires. Add tops off only a group this owner's
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
import { resolvedWorkerResources, type ReviewGateConfig } from "../config";
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
const OWNER_TOOL_NAMES: ReadonlySet<string> = new Set(OWNER_ACTIONS.map((action) => EXECUTION_TOOL_NAMES[action]));

/**
 * Whether a snapshot can launch a Pi worker, which would run the ambient `pi`
 * instead of the admitted executable (see the module note). Fails closed.
 */
function launchesPiWorkers(config: Readonly<ReviewGateConfig>): boolean {
  try {
    return resolvedWorkerResources(config as ReviewGateConfig).some((entry) => entry.selection.source === "pi");
  } catch {
    return true;
  }
}

/** The host's resolved native Pi facts that worker ceilings are computed from. */
export interface NativeManagedConversationPiHost {
  /** Absolute path of the resolved native Pi CLI file. */
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
  const { run, stateRoot, notify, nativeEventSink, testHooks } = options;
  if (typeof run !== "object" || run === null || !(run.signal instanceof AbortSignal) || typeof run.isCurrent !== "function") {
    throw new Error("session-host: a native managed conversation owner requires the exact host-proved run");
  }
  if (nativeEventSink !== undefined && typeof nativeEventSink !== "function") {
    throw new Error("session-host: a native managed conversation event sink must be a function");
  }
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

  const restore = createNativeManagedOwnerRestore<ExecutionToolManager>({
    stateRoot,
    owner: { slotId: rowId, backend, conversationId, workspace },
    isCurrent: runIsCurrent,
    createManager: (save) => {
      const base = readPersistedReviewGateSnapshot(settings);
      if (base.status !== "available") throw new Error(`session-host: native owner settings are ${base.status}`);
      if (launchesPiWorkers(base.config)) throw new Error("session-host: native owner settings route work to Pi workers");
      const manager = new ExecutionToolManager({
        pi: undefined,
        config: structuredClone(base.config),
        state: createState(),
        cwd: () => workspace,
        authorizedTools: () => undefined,
        liveToolCallAllowed: (name) => OWNER_TOOL_NAMES.has(name) && runIsCurrent(),
        hostExposure: { actions: OWNER_ACTIONS },
        // #682: this owner's controller drives its own per-owner census (never
        // the process-global Pi registry), read by the host's row projection.
        hostActivityCensus: true,
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
    if (snapshot.status !== "available" || launchesPiWorkers(snapshot.config)) return undefined;
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
    return manager === undefined ? undefined : { owner: identity, manager, actions: OWNER_ACTIONS, readStartSettings };
  };

  return Object.freeze({
    delegate: createNativeManagedToolDelegate({ resolveScope }),
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
