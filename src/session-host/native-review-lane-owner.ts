/**
 * #736 slice 3c: the host's owner of one native row's automatic review lane.
 *
 * The manager (./instances) owns a review lane's LIFETIME — created before the
 * provider child exists, retired with the run — and asks exactly one question
 * of the host: does THIS row get a lane? This module is the host's answer. It
 * holds no review policy, reads no provider state, registers nothing with the
 * broker, and stages nothing on the launch; it decides one opt-in question from
 * persisted Review settings and, when the answer is yes, hands the manager the
 * Pi-free coordinator (./native-review-coordinator) that answers that row's
 * held hook requests.
 *
 * The decision is re-read from disk AT EVERY ARM, through the one persisted
 * settings reader this host already has (./persisted-review-gate-snapshot, the
 * same strict snapshot the native managed lane uses): the very file the sidebar
 * editor saves and Pi loads, with no cache, no second settings store, and no
 * snapshot taken at host startup. So a row's lane follows the operator's switch
 * at the moment that row launches, and a host that started hours ago arms a
 * row the way the settings say TODAY.
 *
 * Fail-closed in the one direction that matters here: anything other than a
 * fresh, valid, available snapshot whose master Review switch AND this
 * backend's own switch are exactly On yields `undefined` — no coordinator, no
 * broker review source, no extra hook on the launch, and a row byte for byte
 * the row it was before this feature existed. A throw from the settings read,
 * and a throw from constructing the coordinator, are the same `undefined`. An
 * armed lane can block a user's turn, so it is never armed on a guess.
 *
 * Mid-run changes, stated plainly, because both directions are intentional:
 *
 * - **Off mid-run stops reviewing immediately.** The coordinator's `readConfig`
 *   re-reads the same persisted file on EVERY request, so the next `Stop` of a
 *   row whose switch (or the master switch) went Off answers allow with no
 *   reviewer and closes its window, releasing its checkpoint.
 * - **On mid-run does nothing until the next launch.** The provider's hook is
 *   composed into the launch command before the child exists, so a row that
 *   started with the switch Off has no hook to answer a review request; arming
 *   one later could only ever be a registration with no way to be asked.
 */

import { effectiveReviewSettings, type ReviewGateConfig } from "../config";
import type { NativeReviewCoordinatorHandle, NativeReviewLaneOwner } from "./instances";
import {
  createNativeReviewCoordinator,
  type NativeReviewBackgroundState,
  type NativeReviewCoordinatorBackend,
  type NativeReviewCoordinatorDependencies,
} from "./native-review-coordinator";
import type { NativeReviewRequest } from "./native-review-hook-protocol";
import {
  readPersistedReviewGateSnapshot,
  type PersistedReviewGateSnapshot,
  type PersistedReviewGateSource,
} from "./persisted-review-gate-snapshot";

/**
 * What the host's `backgroundState` answers for a Codex row whose owned-route
 * census is not available (no census reader, or a side of it not yet observed).
 * The coordinator treats `unknown` as "do not review", which is the honest
 * reading of a census nobody took: a workspace this row may still be changing
 * is never certified.
 */
export const NATIVE_REVIEW_CODEX_BACKGROUND_DETAIL
  = "this row's background task and shell census is not available";

/** Absent `backgroundTasks` is never read as "nothing is running". */
export const NATIVE_REVIEW_NO_BACKGROUND_DETAIL
  = "the provider reported no background task set for this turn";

/** One owned Codex row's background census: `null` on a side means not observed. */
export interface NativeReviewBackgroundCensus {
  readonly tasks: number | null;
  readonly shells: number | null;
}

/**
 * The row's background state, from the ONE fact each provider actually reports.
 *
 * Claude: the `backgroundTasks` membership projection on its own hook request
 * (the same projection the observe-only lane derives from the same array).
 * - absent -> `unknown`: the provider omitted the array, or an active entry
 *   carried no usable id. Never a shortened view, and never "idle".
 * - `[]` -> `idle`: a positively observed empty in-flight set.
 * - non-empty -> `running` with the count, which the coordinator turns into a
 *   deferral that says how many tasks are still in flight.
 *
 * Codex: the row's own owned-route census (background tasks and background
 * shells the read-only backend connection observed for the current run). Both
 * sides observed -> `running` with their sum when non-zero, else `idle`; any
 * side unobserved, a census reader that is absent, throws, or answers a value
 * that is not a non-negative integer -> `unknown`. Never a guessed idle.
 */
export function nativeReviewLaneBackgroundState(
  backend: NativeReviewCoordinatorBackend,
  request: NativeReviewRequest,
  census?: () => NativeReviewBackgroundCensus,
): NativeReviewBackgroundState {
  if (backend !== "claude") {
    let observed: NativeReviewBackgroundCensus | undefined;
    try {
      observed = census?.();
    } catch {
      observed = undefined;
    }
    const count = (value: unknown): number | undefined =>
      typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
    const tasks = count(observed?.tasks);
    const shells = count(observed?.shells);
    if (tasks === undefined || shells === undefined) {
      return { state: "unknown", detail: NATIVE_REVIEW_CODEX_BACKGROUND_DETAIL };
    }
    return tasks + shells > 0 ? { state: "running", count: tasks + shells } : { state: "idle" };
  }
  const tasks = request.backgroundTasks;
  if (tasks === undefined) return { state: "unknown", detail: NATIVE_REVIEW_NO_BACKGROUND_DETAIL };
  if (tasks.length === 0) return { state: "idle" };
  return { state: "running", count: tasks.length };
}

export interface NativeReviewLaneOwnerDependencies {
  /**
   * The host's own persisted-settings source: its startup environment snapshot,
   * the canonical native Pi agent directory its children receive, and the home
   * the host resolved for the compatibility location. Read, never mutated; the
   * snapshot is re-taken from disk at every read, never cached.
   */
  readonly settings: PersistedReviewGateSource;
  /**
   * This host's ONE resolved Pi executable, admitted exactly the way the native
   * managed lanes admit it (#682): the same `pi.file` fact the host already
   * resolves and passes down. This module never resolves Pi a second way and
   * never falls back to a `PATH` lookup.
   */
  readonly admittedPiCommand: string;
  /**
   * The host's Pi-scoped models for resolving `pi` reviewers — the same list the
   * sidebar's reviewer picker offers — exactly as a Pi session's scoped models
   * gate its own: a configured Pi reviewer outside it is an unresolved selection
   * and gets Pi's "no configured reviewer" notice. Absent is an empty scope.
   */
  readonly scopedModels?: readonly string[];
  /**
   * Test seam for the settings read. Production supplies nothing and uses the
   * one persisted reader; a seam still receives the frozen source this owner
   * bound at construction, so a test proves what the owner would really read.
   */
  readonly testHooks?: {
    readonly readSnapshot?: (source: PersistedReviewGateSource) => PersistedReviewGateSnapshot;
    /** Called only when the opt-in says this row gets a lane. */
    readonly createCoordinator?: (deps: NativeReviewCoordinatorDependencies) => NativeReviewCoordinatorHandle;
  };
}

/** True only when the persisted settings positively opt this backend in. */
function backendReviewEnabled(config: ReviewGateConfig, backend: NativeReviewCoordinatorBackend): boolean {
  // The master Review switch wins over both per-row switches, and a per-row
  // switch answers only for its own backend. Anything that is not exactly true
  // — absent, false, or a value normalization could not produce — is Off.
  if (config.enabled !== true) return false;
  const settings = effectiveReviewSettings(config);
  return (backend === "claude" ? settings.primaryClaudeCodeEnabled : settings.primaryCodexEnabled) === true;
}

/**
 * Build the host's lane owner. It binds the host's facts once (so a later
 * mutation of the caller's environment object changes nothing) and answers
 * `create()` independently for every arm.
 */
export function createNativeReviewLaneOwner(
  deps: NativeReviewLaneOwnerDependencies,
): NativeReviewLaneOwner {
  const settings: PersistedReviewGateSource = Object.freeze({
    env: Object.freeze({ ...deps.settings.env }),
    agentDir: deps.settings.agentDir,
    ...(deps.settings.resolvedHomeDir === undefined ? {} : { resolvedHomeDir: deps.settings.resolvedHomeDir }),
  });
  const admittedPiCommand = deps.admittedPiCommand;
  const scopedModels = deps.scopedModels === undefined ? undefined : Object.freeze([...deps.scopedModels]);
  const readSnapshot = deps.testHooks?.readSnapshot ?? readPersistedReviewGateSnapshot;
  const createCoordinator = deps.testHooks?.createCoordinator ?? createNativeReviewCoordinator;

  /**
   * The coordinator's `readConfig`, consulted on EVERY request of a live lane:
   * a fresh snapshot, or `undefined`. The coordinator reads `undefined` as "this
   * host cannot review right now" — allow with a notice, close the window,
   * never block — which is also the correct reading of the kill switch
   * (`disabled`) and of every unreadable or invalid file (`unavailable`): a
   * settings state the operator did not positively choose never runs a reviewer.
   */
  const readConfig = (): ReviewGateConfig | undefined => {
    let snapshot: PersistedReviewGateSnapshot;
    try {
      snapshot = readSnapshot(settings);
    } catch {
      return undefined;
    }
    return snapshot.status === "available" ? snapshot.config : undefined;
  };

  return {
    create(input) {
      const backend: NativeReviewCoordinatorBackend = input.backend;
      // The WHOLE arm is contained, by this owner's own contract and not by the
      // manager's outer guard: a settings read that throws, a settings document
      // this build cannot interpret, and a coordinator factory that throws are
      // one answer — no lane, this row byte for byte unchanged — and never an
      // error reaching the launch. Nothing here is attempted twice.
      try {
        // A fresh read at THIS arm, never a host-startup snapshot: the operator's
        // switch is what it is now, or this row gets nothing.
        const snapshot = readSnapshot(settings);
        if (snapshot.status !== "available") return undefined;
        if (!backendReviewEnabled(snapshot.config, backend)) return undefined;
        return createCoordinator({
          backend,
          workspace: input.workspace,
          checkpointAgentDir: input.checkpointAgentDir,
          readConfig,
          backgroundState: async (request: NativeReviewRequest): Promise<NativeReviewBackgroundState> =>
            nativeReviewLaneBackgroundState(backend, request, input.backgroundCensus),
          admittedPiCommand,
          ...(scopedModels === undefined ? {} : { scopedModels }),
        });
      } catch {
        return undefined;
      }
    },
  };
}
