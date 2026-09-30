/**
 * Issue #26: pure scheduled-dispatch route/config derivations for one
 * execution group, extracted from the background controller. Both functions
 * are pure over the caller's LIVE configuration — the controller passes its
 * current config object at each existing read point, so a pinned worker
 * resource still resolves against the CURRENT catalog at dispatch time
 * (live inheritance) and nothing is ever frozen or captured. The controller
 * keeps the orchestration that schedules, saves, and wakes around these
 * derivations.
 */
import {
  effectiveReviewSettings,
  resolvedWorkerResource,
  resolvedWorkerRoute,
  workerResourceSupportsResearch,
  type ReviewGateConfig,
} from "../config";
import type { ExecutorPoolEntry } from "../config";
import { isWriteCapableKind, workerRouteKeyForKind } from "./task-state";
import type { BackgroundExecutionGroup } from "./background-group-store";

/**
 * Issue #26: the dispatch route for one group. A scheduled group with a
 * pinned worker resource resolves that single resource against the
 * CURRENT catalog (research capability enforced for research groups);
 * every other group keeps the existing global-role route, so ordinary
 * subtask behavior is byte-for-byte unchanged.
 */
export function resolveGroupRoute(group: BackgroundExecutionGroup, config: ReviewGateConfig): ExecutorPoolEntry[] {
  if (group.scheduledWorkerResourceId === undefined) {
    return resolvedWorkerRoute(config, group.kind);
  }
  const pinned = resolvedWorkerResource(config, group.scheduledWorkerResourceId);
  if (!pinned) return [];
  if (group.kind === "research" && !workerResourceSupportsResearch(config, pinned.selection)) return [];
  return [pinned];
}

/**
 * Issue #26: the effective configuration for one group's worker launch.
 * A scheduled write-capable group (execute or in-place, #220) with a
 * review override derives a
 * task-local config: `off` disables automatic subtask review (no PASS is
 * ever fabricated), `selected` replaces exactly the subtask reviewer set
 * while preserving the primary layer. The derivation is pure — the
 * controller's shared global config is never mutated, so concurrent
 * ordinary subtasks keep their own settings.
 */
export function deriveGroupConfig(group: BackgroundExecutionGroup, config: ReviewGateConfig): ReviewGateConfig {
  const override = group.scheduledReviewOverride;
  const pinned = group.scheduledWorkerResourceId;
  if (pinned === undefined && (!override || !isWriteCapableKind(group.kind))) return config;
  const base = config;
  // Issue #26: a pinned entry resolves exactly its pinned resource in every
  // downstream route derivation too — the wave's executor-pool guard and
  // failover both read the derived role route, so the pin holds for the
  // whole run even when the kind's global route is empty, and failover can
  // never silently switch a pinned task onto a global-route worker (a
  // single-entry route fails closed instead). The base config is cloned,
  // never mutated. #220: the in-place kind draws its route key from the
  // write-capable executor pool (the execute route).
  const execution = pinned === undefined || base.execution === undefined
    ? base.execution
    : { ...base.execution, routes: { ...base.execution.routes, [workerRouteKeyForKind(group.kind)]: [{ resourceId: pinned }] } };
  if (override === undefined || !isWriteCapableKind(group.kind)) {
    return execution === base.execution ? config : { ...base, execution };
  }
  // Materialize both layers explicitly: a legacy (activeReviewers-only)
  // base config must not lose its primary set when the derived config
  // becomes split-shaped for this run.
  const effective = effectiveReviewSettings(base);
  return {
    ...base,
    ...(execution !== base.execution ? { execution } : {}),
    review: {
      ...base.review,
      primaryReviewers: effective.primaryReviewers.map((selection) => ({ ...selection })),
      subtaskEnabled: override.mode === "off" ? false : true,
      subtaskReviewers: (override.mode === "selected" ? override.reviewers : effective.subtaskReviewers).map((selection) => ({ ...selection })),
    },
  };
}