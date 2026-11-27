/**
 * #781 — the ONE shared restore-classification rule for persisted execution
 * associations.
 *
 * A restored controller re-attaches what it can and reports the rest through
 * {@linkcode reconcileExecutionRestore}. Both consumers of
 * `ExecutionToolManager.restoreAssociations` — Pi's session sidecar restore and
 * a hosted native (Claude/Codex) managed-owner restore — read this one result,
 * so there is exactly one answer to "is this stale reference collected work, or
 * work this runtime still owes?". Neither consumer keeps a private variant of
 * the rule, and nothing here persists a second cleanup ledger: the controller's
 * only durable association record stays the one `associations()` publication,
 * and this classification is recomputed per restore from the incoming snapshot,
 * the controller's live snapshot, and the evidence the restore walk observed.
 *
 * The rule is deliberately asymmetric and fail-closed:
 * - A reference is reconciled out (safe to omit from the record a later save
 *   writes) only on positive evidence that it is gone or durably resolved: the
 *   path itself reports ENOENT to `lstat`, or a drained in-flight clearance
 *   proved its exact conflict gate was resolved.
 * - A reference yields an unresolved reason (it must still be present in the
 *   live snapshot, or the record must not be rewritten) whenever its absence
 *   was not verified — a failed or unreadable read, an existing directory whose
 *   manifest is missing, a symlinked/permission-obscured/`ENOTDIR` path, a
 *   still-existing wave or bundle, a bundle whose owning task is still
 *   unsettled, or any reference a live gate still blocks. "Missing" is never by
 *   itself evidence of "collected", and an absent directory is never reported
 *   as a failed read.
 * - Anything the restore re-attached needs no report at all.
 *
 * Reconciliation never deletes, adopts, creates, or renames anything on disk:
 * the only filesystem operation here is the `lstat` absence probe. Canonical
 * bundle adoption stays exactly where it was — a bundle whose wave root
 * survives is still handed to the controller's normal adoption path, and this
 * module only declines to call it collected.
 */
import { lstat } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import type { ReattachmentBundle } from "./operation-record";
import { isArchivableTaskState, salvageEvidenceRequiresRetention, type BackgroundTaskRecord } from "./task-state";
import type { ExecutionAssociationsSnapshot, PersistedConflictGate } from "../session-state";

/**
 * Bound on how many reasons one result reports, so a record with thousands of
 * stale roots still yields a notice-sized diagnostic. `reconciled` stays exact
 * and `truncated` says whether more reasons exist than were reported.
 */
export const MAX_EXECUTION_RESTORE_REASONS = 8;

/** The longest reported detail string (a filesystem error message, clipped). */
const MAX_RESTORE_DETAIL_CHARS = 180;

export type ExecutionRestoreReferenceKind = "group" | "wave" | "bundle" | "gate";

/** One restored task, identified by the exact execution that restored it. */
export interface ExecutionTaskHandle {
  readonly executionId: string;
  readonly taskId: string;
}

/** Machine-readable reason code; stable across releases, safe in a notice. */
export type ExecutionRestoreReasonCode =
  | "group-unavailable"
  | "group-not-durable"
  | "wave-unclaimed"
  | "wave-in-flight"
  | "bundle-unrecoverable"
  | "bundle-in-flight"
  | "association-unverified"
  | "gate-collapsed"
  | "gate-unclaimed"
  | "roster-absent"
  | "restore-superseded";

/** Why one loaded reference must still be preserved. Bounded and notice-safe. */
export interface ExecutionRestoreReason {
  readonly kind: ExecutionRestoreReferenceKind;
  readonly code: ExecutionRestoreReasonCode;
  /** The blocked target, so a notice can name what to inspect. */
  readonly id: string;
  readonly detail: string;
}

export interface ExecutionRestoreRecovery {
  /** True when nothing is unresolved: every loaded reference was re-attached or positively collected. */
  readonly complete: boolean;
  /** Bounded, first-seen-order unresolved reasons; `truncated` says whether more exist. */
  readonly reasons: readonly ExecutionRestoreReason[];
  /** Exact count of references this restore established as collected or resolved. */
  readonly reconciled: number;
  readonly truncated: boolean;
}

/**
 * The shared restore outcome. `associations` is the INCOMING snapshot with only
 * the positively-collected references removed — the exact set of references a
 * later save must still reproduce. It is never persisted by the restore, and it
 * is never a live snapshot: a consumer that must prove the live snapshot lost
 * nothing compares it against `manager.associations()` with
 * {@linkcode executionBundleIsPreservedBy} and
 * {@linkcode executionGateIsPreservedBy}, the same identity rules this
 * classification uses.
 */
export interface ExecutionRestoreResult {
  readonly associations: ExecutionAssociationsSnapshot;
  readonly recovery: ExecutionRestoreRecovery;
}

/** What one claimed group root's read established during the restore walk. */
export type ExecutionRestoreGroupOutcome =
  /** The root itself reported ENOENT: cleanup collected the whole directory. */
  | { readonly state: "absent" }
  /** The root exists (or its existence is unproven) but no group was attached from it. */
  | { readonly state: "unavailable"; readonly detail?: string };

export interface ExecutionRestoreEvidence {
  /** Resolved claimed group root -> what reading it established. */
  readonly groupOutcomes: ReadonlyMap<string, ExecutionRestoreGroupOutcome>;
  /**
   * Resolved root of a group this restore attached but could NOT durably
   * rewrite, with the bounded reason. The reference is present in memory, so
   * no reference-level comparison can see this failure; it is reported on its
   * own because a record whose attached group is not durable must not be
   * treated as safely rewritable.
   */
  readonly groupSaveFailures: ReadonlyMap<string, string>;
  /**
   * Bundle identity -> why canonical adoption failed for it during this walk.
   * A failed adoption can still leave the group and task attached in memory, so
   * the live snapshot matches the incoming reference; the failure is reported
   * on its own because an undurable adoption is not a restored association.
   */
  readonly bundleAdoptionFailures: ReadonlyMap<string, string>;
  /**
   * Exact identities of persisted gates a drained in-flight clearance cleared.
   * Identity, never source root: a same-root sibling gate was not cleared and
   * stays required even though the store could only hold one gate for that root.
   */
  readonly clearedGateIdentities: ReadonlySet<string>;
  /** Resolved source roots whose record carries more than one distinct persisted gate. */
  readonly collapsedGateRoots: ReadonlySet<string>;
  /**
   * Task ids whose wave/operation association this restore could NOT
   * re-authenticate, with the bounded reason. Their wave and bundle references
   * stay required even though the task record still names them, because a live
   * path reference is not evidence that the work is recoverable.
   */
  readonly taskRecoveryFailures: ReadonlyMap<string, string>;
}

/** Live records the classifier consults to decide "no surviving task can recover this". */
export interface ExecutionRestoreLiveState {
  readonly tasks: readonly BackgroundTaskRecord[];
  /**
   * #781: the exact execution/task pairs this runtime actually restored. A
   * conflict gate identifies both halves of its task, so only a task in the
   * gate's OWN execution anchors it — the same task id restored under a
   * different execution never stands in for the gated task whose group is gone.
   */
  readonly restoredTaskHandles: readonly ExecutionTaskHandle[];
  /**
   * #781: wave references this restore's own normalization cleared from
   * authenticated settled tasks after proving that work collected. Reconciliation
   * takes its claimant snapshot after that erasure, so this transient walk
   * evidence is what keeps a proven-collected wave from reading as an unclaimed
   * orphan. It never claims anything on its own: it only carries references that
   * belonged to a task this restore verified as settled and released.
   */
  readonly normalizedTaskClaimants?: readonly { readonly taskId: string; readonly waveKey: string }[];
  /**
   * Task ids still blocked by a required conflict gate: every gate the live
   * store holds PLUS every gate the persisted record still requires (a gate
   * whose group is gone, or a same-root sibling the one-gate-per-root store
   * could not install, blocks its task just the same).
   */
  readonly gatedTaskIds: ReadonlySet<string>;
  /**
   * Exact lookup of a task record this runtime no longer holds inline: normal
   * compaction evicts settled work from the group's inline window, but its
   * authenticated archive remains readable by handle and can still retain
   * salvage provenance. Throwing means the archive could not be verified, which
   * is never evidence that the reference was released.
   */
  readonly archiveClaimants?: (taskId: string) => Promise<readonly BackgroundTaskRecord[]>;
  /**
   * True when this runtime retains evicted settled work at all. A wave-only
   * reference carries no task id, so it can never be matched to one of those
   * archives by exact handle; while any archive is retained, such a reference
   * stays unresolved rather than assumed released.
   */
  readonly hasArchivedTasks?: boolean;
}

/**
 * Positive absence only, and only for the recorded path itself: `lstat` (never
 * `stat`, so a symlink leaf — dangling or not — is an existing entry) reports
 * ENOENT, and every existing ancestor of that path is a real directory. The
 * ancestor walk matters: a leaf `ENOENT` below a dangling or otherwise
 * unresolved symlink ancestor says only that the symlink does not currently
 * resolve, and a real nearest parent can itself be reached through a higher
 * redirected symlink — in both cases the recorded work may still exist at the
 * link's target, which is a path-obscured reference, not a collected artifact.
 * A genuinely reclaimed parent (the parent directory itself is gone) still
 * walks up to its real existing directory ancestors and reconciles. `ENOTDIR`,
 * `EACCES`, and any
 * other I/O failure are never evidence of absence, matching the ownership
 * guard's discipline for artifact cleanup.
 */
export async function isExecutionPathPositivelyAbsent(path: unknown): Promise<boolean> {
  if (typeof path !== "string" || path.length === 0) return false;
  let target = executionPathKey(path);
  if (target === undefined) return false;
  try {
    await lstat(target);
    return false;
  } catch (error) {
    if ((error as NodeJS.ErrnoException | undefined)?.code !== "ENOENT") return false;
  }
  let foundDirectory = false;
  for (;;) {
    const parent = dirname(target);
    if (parent === target) return foundDirectory;
    try {
      // Any symlink (live or dangling) or non-directory anywhere on the way up
      // leaves the recorded path's absence unexplained, so it is never treated
      // as collected work.
      const parentEntry = await lstat(parent);
      if (!parentEntry.isDirectory() || parentEntry.isSymbolicLink()) return false;
      foundDirectory = true;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException | undefined)?.code;
      // Below the first existing ancestor the chain is fully accounted for; an
      // ancestor vanishing after one was already seen is an unexplained race.
      if (foundDirectory || code !== "ENOENT") return false;
    }
    target = parent;
  }
}

/** Every persisted gate of a snapshot, legacy singular field included. */
export function persistedConflictGates(snapshot: ExecutionAssociationsSnapshot): readonly PersistedConflictGate[] {
  return snapshot.conflictGates ?? (snapshot.conflictGate ? [snapshot.conflictGate] : []);
}

/**
 * The one bundle identity rule: the full stable identity, revision excluded
 * (revision is compared separately and exactly by {@linkcode
 * executionBundleIsPreservedBy}). Both the shared classification and any
 * consumer's live-versus-loaded comparison use this single helper.
 */
export function executionBundleIdentity(bundle: ReattachmentBundle | undefined): string {
  return JSON.stringify([
    bundle?.version ?? null,
    bundle?.operationId ?? null,
    bundle?.waveId ?? null,
    bundle?.taskId ?? null,
    executionPathKey(bundle?.waveRoot) ?? String(bundle?.waveRoot ?? null),
  ]);
}

/**
 * True when `live` carries the exact bundle `loaded` carried, with a
 * non-regressing expected revision: the single rule for "a later save cannot
 * drop this bundle".
 */
export function executionBundleIsPreservedBy(
  loaded: ReattachmentBundle,
  live: Iterable<ReattachmentBundle | undefined>,
): boolean {
  const identity = executionBundleIdentity(loaded);
  const expected = loaded.expectedRevision;
  if (!Number.isSafeInteger(expected) || expected < 0) return false;
  for (const candidate of live) {
    if (executionBundleIdentity(candidate) !== identity) continue;
    const revision = candidate?.expectedRevision;
    if (Number.isSafeInteger(revision) && (revision as number) >= expected) return true;
  }
  return false;
}

/**
 * The one conflict-gate identity rule: every durable field, in a fixed order,
 * including the sidecar entries. `undefined` (no gate for that root) never
 * matches a real gate.
 */
export function executionGateIdentity(gate: PersistedConflictGate | undefined): string {
  return JSON.stringify([
    gate?.executionId ?? null,
    gate?.taskId ?? null,
    executionPathKey(gate?.sourceRoot) ?? String(gate?.sourceRoot ?? null),
    gate?.paths ?? null,
    gate?.activatedAt ?? null,
    gate?.manifestPath ?? null,
    gate?.reason ?? null,
    gate?.sidecars?.map(({ path, sidecarPath }) => [path, sidecarPath ?? null]) ?? null,
  ]);
}

/** True when `live` carries the exact persisted gate `loaded` carried. */
export function executionGateIsPreservedBy(
  loaded: PersistedConflictGate,
  live: Iterable<PersistedConflictGate | undefined>,
): boolean {
  const identity = executionGateIdentity(loaded);
  for (const candidate of live) {
    if (executionGateIdentity(candidate) === identity) return true;
  }
  return false;
}

/**
 * Resolved source roots whose persisted record carries more than one DISTINCT
 * gate. The canonical gate store holds one gate per root, so a restore can only
 * install one of them; every other record is reported unresolved so the
 * consumer keeps it in the record and keeps treating that target as blocked.
 */
export function collapsedConflictGateRoots(snapshot: ExecutionAssociationsSnapshot): ReadonlySet<string> {
  const perRoot = new Map<string, Set<string>>();
  for (const gate of persistedConflictGates(snapshot)) {
    const key = executionPathKey(gate?.sourceRoot);
    if (key === undefined) continue;
    const identities = perRoot.get(key) ?? new Set<string>();
    identities.add(executionGateIdentity(gate));
    perRoot.set(key, identities);
  }
  return new Set([...perRoot].filter(([, identities]) => identities.size > 1).map(([key]) => key));
}

/** Copied in `required`'s order: the references `live` does not already carry. */
function referencesMissingFrom(
  required: ExecutionAssociationsSnapshot,
  live: ExecutionAssociationsSnapshot,
): ExecutionAssociationsSnapshot | undefined {
  const liveGroupKeys = new Set((live.groupRoots ?? []).map(executionPathKey));
  const liveWaveKeys = new Set((live.waveRoots ?? []).map(executionPathKey));
  const liveBundles = live.bundles ?? [];
  const liveGateIdentities = new Set(persistedConflictGates(live).map(executionGateIdentity));
  const groupRoots = (required.groupRoots ?? []).filter((root) => !liveGroupKeys.has(executionPathKey(root)));
  const waveRoots = (required.waveRoots ?? []).filter((root) => !liveWaveKeys.has(executionPathKey(root)));
  const bundles = (required.bundles ?? []).filter((bundle) => !executionBundleIsPreservedBy(bundle, liveBundles));
  const conflictGates = persistedConflictGates(required).filter((gate) => !liveGateIdentities.has(executionGateIdentity(gate)));
  if (groupRoots.length === 0 && waveRoots.length === 0 && bundles.length === 0 && conflictGates.length === 0) {
    return undefined;
  }
  return {
    ...(required.groupRoots !== undefined ? { groupRoots } : {}),
    waveRoots,
    bundles,
    ...(conflictGates.length > 0 ? { conflictGates } : {}),
  };
}

/**
 * #781: the references a restore kept required but could not re-establish in
 * its own live snapshot — an unreadable execution root's path, a gate the store
 * could not install. They are the whole reason a live-only save can be lossy,
 * so the persistence boundary carries them forward. `undefined` means a save of
 * the live snapshot loses nothing.
 */
export function unresolvedExecutionRestoreReferences(
  required: ExecutionAssociationsSnapshot,
  live: ExecutionAssociationsSnapshot,
): ExecutionAssociationsSnapshot | undefined {
  return referencesMissingFrom(required, live);
}

/**
 * #781: the ONE persistence boundary. A host saves this, never the raw live
 * snapshot: a reference this restore positively proved collected is absent from
 * `retained` and stays dropped, while a reference it could not resolve is put
 * back so the record can still recover it. Identity is compared with the same
 * helpers the classification used — this merges, it never reclassifies.
 */
export function persistableExecutionAssociations(
  live: ExecutionAssociationsSnapshot,
  retained: ExecutionAssociationsSnapshot | undefined,
): ExecutionAssociationsSnapshot {
  if (retained === undefined) return live;
  const missing = referencesMissingFrom(retained, live);
  if (missing === undefined) return live;
  const gates = [...persistedConflictGates(live), ...(missing.conflictGates ?? [])];
  return {
    ...(live.groupRoots !== undefined || missing.groupRoots !== undefined
      ? { groupRoots: [...(live.groupRoots ?? []), ...(missing.groupRoots ?? [])] }
      : {}),
    waveRoots: [...live.waveRoots, ...missing.waveRoots],
    bundles: [...live.bundles, ...missing.bundles],
    ...(gates.length > 0 ? { conflictGates: gates } : {}),
  };
}

/**
 * Classify every reference the incoming snapshot carried against what the
 * controller now holds. Pure over its inputs plus the absence probe: no write,
 * no removal, no adoption.
 */
export async function reconcileExecutionRestore(
  incoming: ExecutionAssociationsSnapshot,
  live: ExecutionAssociationsSnapshot,
  evidence: ExecutionRestoreEvidence,
  liveState: ExecutionRestoreLiveState,
): Promise<ExecutionRestoreResult> {
  const reasons: ExecutionRestoreReason[] = [];
  let reconciled = 0;
  const require = (kind: ExecutionRestoreReferenceKind, code: ExecutionRestoreReasonCode, id: string, detail: string): void => {
    reasons.push({ kind, code, id, detail: clip(detail) });
  };

  // An omitted roster is unknown ownership, never an authoritative empty set.
  // Nothing may be reconciled out of such a snapshot: every reference it does
  // carry stays required, and the consumer must not rewrite the record.
  const rosterAbsent = !Array.isArray(incoming.groupRoots)
    || !Array.isArray(incoming.bundles)
    || !Array.isArray(incoming.waveRoots);

  const liveGroupKeys = new Set((live.groupRoots ?? []).map(executionPathKey).filter((key): key is string => key !== undefined));
  const liveWaveKeys = new Set((live.waveRoots ?? []).map(executionPathKey).filter((key): key is string => key !== undefined));
  const liveBundles = live.bundles ?? [];
  const liveGates = persistedConflictGates(live);

  /**
   * #781: required conflict gates with no restored task behind them. Such a
   * gate's blocked work can survive only as a wave reference, and neither a
   * gone group nor a missing directory proves that work was released — so an
   * unclaimed wave stays required while any gate of this record is unanchored.
   */
  const unanchoredGateTaskIds = [...new Set(
    [...persistedConflictGates(incoming), ...liveGates]
      .filter((gate) => gate?.taskId !== undefined
        && !evidence.clearedGateIdentities.has(executionGateIdentity(gate))
        // #781: the exact execution/task pair only. A restored task carrying
        // the same task id under a different execution never anchors this gate's
        // task, so its wave must not be read as released.
        && !liveState.restoredTaskHandles.some((handle) =>
          handle.executionId === gate.executionId && handle.taskId === gate.taskId))
      .map((gate) => gate.taskId as string),
  )];

  const droppedGroups = new Set<string>();
  /**
   * True when a required group could not be verified. Its tasks were never
   * read, so the claimant set below is incomplete: a wave or bundle with no
   * claimant among the groups that *did* load may still belong to this one,
   * and a missing path proves only path absence, not that its task settled.
   */
  let hasUnverifiedGroup = false;
  for (const root of incoming.groupRoots ?? []) {
    const key = executionPathKey(root);
    if (key === undefined) {
      hasUnverifiedGroup = true;
      require("group", "group-unavailable", String(root), "the recorded group root is not a usable path");
      continue;
    }
    if (liveGroupKeys.has(key)) continue;
    const outcome = evidence.groupOutcomes.get(key);
    if (!rosterAbsent && outcome?.state === "absent") {
      droppedGroups.add(key);
      reconciled += 1;
      continue;
    }
    require("group", "group-unavailable", key,
      outcome?.state === "unavailable" ? outcome.detail ?? "the recorded execution root could not be read"
        : outcome === undefined ? "this restore never established this execution root's state"
          : "the execution root is still present but no group was attached from it");
    hasUnverifiedGroup = true;
  }

  // Bundles are classified before wave roots: a bundle that stays required
  // protects the wave root it names, so a gate-blocked bundle (or the sibling
  // of a collapsed same-root gate pair the one-gate-per-root store could not
  // install) can never have its wave root reconciled out from under it.
  const droppedBundles = new Set<string>();
  /**
   * Wave roots named by a bundle that is itself unresolved. That bundle already
   * produced its own reason, so the result is incomplete on its account and the
   * wave root is kept silently.
   */
  const diagnosedBundleWaves = new Set<string>();
  /**
   * Wave roots named by a bundle the live snapshot still carries. A preserved
   * bundle proves its own operation, not this snapshot's separate wave-roster
   * entry, so the entry is still validated on its own below.
   */
  const preservedBundleWaves = new Set<string>();
  /** Wave roots whose bundle was proven collected, task handle included. */
  const releasedBundleWaves = new Set<string>();
  /** Task ids whose unproven association already produced its own reason. */
  const reportedAssociations = new Set<string>();
  for (const bundle of incoming.bundles ?? []) {
    const label = bundleLabel(bundle);
    const waveKey = executionPathKey(bundle?.waveRoot);
    const stalled = bundle?.taskId === undefined ? undefined : evidence.taskRecoveryFailures.get(bundle.taskId);
    if (stalled !== undefined) {
      require("bundle", "bundle-in-flight", label, `this restore could not re-authenticate its operation: ${stalled}`);
      if (bundle?.taskId !== undefined) reportedAssociations.add(bundle.taskId);
      if (waveKey !== undefined) diagnosedBundleWaves.add(waveKey);
      continue;
    }
    const adoptionFailure = evidence.bundleAdoptionFailures.get(executionBundleIdentity(bundle));
    if (adoptionFailure !== undefined) {
      // Canonical adoption attached this bundle's group and then failed to save
      // it, so the live snapshot can match the incoming reference. The failure
      // outranks that identity match: the association is not durably restored.
      require("bundle", "bundle-unrecoverable", label, `canonical adoption failed: ${adoptionFailure}`);
      if (waveKey !== undefined) diagnosedBundleWaves.add(waveKey);
      continue;
    }
    if (executionBundleIsPreservedBy(bundle, liveBundles)) {
      if (waveKey !== undefined) preservedBundleWaves.add(waveKey);
      continue;
    }
    // An unverified group already made this restore incomplete. Its references
    // stay required silently rather than being collected against a claimant set
    // that never saw that group's tasks.
    if (hasUnverifiedGroup) continue;
    const collected = rosterAbsent
      ? { collected: false as const, code: "bundle-unrecoverable" as const, detail: "the persisted record omits a roster, so nothing in it is proven collected" }
      : await inspectCollectedBundleReference(bundle, liveState);
    if (!collected.collected) {
      require("bundle", collected.code, label, collected.detail);
      if (bundle?.taskId !== undefined && evidence.taskRecoveryFailures.has(bundle.taskId)) reportedAssociations.add(bundle.taskId);
      if (waveKey !== undefined) diagnosedBundleWaves.add(waveKey);
      continue;
    }
    droppedBundles.add(executionBundleIdentity(bundle));
    if (waveKey !== undefined) releasedBundleWaves.add(waveKey);
    reconciled += 1;
  }

  const droppedWaves = new Set<string>();
  for (const root of incoming.waveRoots ?? []) {
    const key = executionPathKey(root);
    if (key === undefined) {
      require("wave", "wave-unclaimed", String(root), "the recorded wave root is not a usable path");
      continue;
    }
    // A bundle that is itself unresolved keeps this root in the record and has
    // already reported its own reason; the wave is kept silently and never
    // reconciled a second time.
    if (diagnosedBundleWaves.has(key)) continue;
    const stalled = liveState.tasks.find((task) =>
      referencesWave(task, key) && evidence.taskRecoveryFailures.has(task.taskId));
    if (stalled !== undefined) {
      require("wave", "wave-in-flight", key,
        `this restore could not re-authenticate its operation: ${evidence.taskRecoveryFailures.get(stalled.taskId)}`);
      reportedAssociations.add(stalled.taskId);
      continue;
    }
    if (liveWaveKeys.has(key)) continue;
    if (preservedBundleWaves.has(key)) {
      // The bundle survived, but the live snapshot lost this snapshot's own
      // wave-roster entry. Reporting nothing here would let a save that trusts
      // `complete` drop a root that is still required.
      require("wave", "wave-unclaimed", key,
        "the bundle's live match does not stand in for this snapshot's own wave roster entry");
      continue;
    }
    // As with bundles: an unverified group's tasks were never read, so nothing
    // may infer this root's release from the claimants that remain.
    if (hasUnverifiedGroup) continue;
    if (rosterAbsent || !(await isExecutionPathPositivelyAbsent(key))) {
      require("wave", "wave-unclaimed", key, "no live record claims this wave root and its absence was not verified");
      continue;
    }
    const claimant = liveState.tasks.find((task) => referencesWave(task, key));
    if (claimant && !isRestoredTaskReferenceReleased(claimant, liveState.gatedTaskIds)) {
      require("wave", "wave-in-flight", key, `a surviving task (${claimant.taskId}) is not settled work`);
      continue;
    }
    // #781: an unclaimed wave is not released merely because its group is gone.
    // While a required gate has no restored task, this reference may be the only
    // remaining anchor for the work that gate still blocks.
    if (claimant === undefined && unanchoredGateTaskIds.length > 0) {
      require("wave", "wave-unclaimed", key,
        `a required conflict gate (task ${unanchoredGateTaskIds.join(", ")}) has no restored task to anchor it, so this wave-only reference cannot be proven released`);
      continue;
    }
    // #781: this restore may itself have proven the wave collected and then
    // normalized away its only claimant. That authenticated reference is the
    // exact task-handle evidence, so the root is collected work here — keeping it
    // would let a positively collected reference survive the first save.
    if (claimant === undefined
      && (liveState.normalizedTaskClaimants ?? []).some((carry) => carry.waveKey === key)) {
      droppedWaves.add(key);
      reconciled += 1;
      continue;
    }
    // Retention can clear a salvage task's bundle while keeping its wave
    // reference. Once that task is evicted, a snapshot carrying only the wave
    // has no task id for an exact archive lookup — so nothing here may infer
    // that the archive released it. Where a collected bundle supplied the task
    // handle above, that exact evidence already applies.
    if (claimant === undefined && liveState.hasArchivedTasks === true && !releasedBundleWaves.has(key)) {
      require("wave", "wave-unclaimed", key, "a wave-only reference has no exact task handle to verify against retained archives");
      continue;
    }
    droppedWaves.add(key);
    reconciled += 1;
  }

  const droppedGates = new Set<string>();
  for (const gate of persistedConflictGates(incoming)) {
    const key = executionPathKey(gate?.sourceRoot);
    if (key === undefined) {
      require("gate", "gate-unclaimed", "gate", "the recorded conflict gate has no usable source root");
      continue;
    }
    const identity = executionGateIdentity(gate);
    // Only the exact cleared record is collected: a same-root sibling gate that
    // the one-per-root store could not install stays required. This proven
    // clearance outranks an omitted roster — the gate really was released during
    // this restore, so retaining it would put a cleared block back into the next
    // save and reinstall it on the following restore. A gate this restore
    // reinstalled live is never dropped.
    if (evidence.clearedGateIdentities.has(identity)
      && !liveGates.some((candidate) => executionGateIdentity(candidate) === identity)) {
      droppedGates.add(identity);
      reconciled += 1;
      continue;
    }
    // Everything else a live gate or an omitted roster still protects survives.
    if (executionGateIsPreservedBy(gate, liveGates)) continue;
    if (evidence.collapsedGateRoots.has(key)) {
      require("gate", "gate-collapsed", key,
        "more than one distinct gate was persisted for this source root and the canonical store holds one per root");
      continue;
    }
    require("gate", "gate-unclaimed", key, "no live gate blocks this source root and no clearance was proven");
  }

  if (rosterAbsent) {
    require("group", "roster-absent", "association roster",
      "the persisted record omits the group, wave, or bundle roster, so its ownership is unknown");
  }

  // Failures the restore walk observed that no reference comparison can see: an
  // attached group whose durable rewrite failed, and a task association this
  // restore could not re-authenticate when the persisted record names only the
  // group (or the failed path is known only from the group manifest). Both keep
  // the record closed even though every listed reference looks present.
  for (const [root, detail] of evidence.groupSaveFailures) {
    require("group", "group-not-durable", root, `the attached group could not be durably saved: ${detail}`);
  }
  for (const [taskId, detail] of evidence.taskRecoveryFailures) {
    if (reportedAssociations.has(taskId)) continue;
    require("bundle", "association-unverified", `task ${taskId}`,
      `a restored task's wave/operation association could not be re-authenticated: ${detail}`);
  }

  return {
    associations: pruneAssociations(incoming, droppedGroups, droppedWaves, droppedBundles, droppedGates),
    recovery: {
      complete: reasons.length === 0,
      reasons: reasons.slice(0, MAX_EXECUTION_RESTORE_REASONS),
      reconciled,
      truncated: reasons.length > MAX_EXECUTION_RESTORE_REASONS,
    },
  };
}

/**
 * A restore superseded by a detach or shutdown attached nothing it can vouch
 * for: the incoming record is reported unchanged and nothing is reconciled, so
 * the consumer keeps every reference.
 */
export function supersededExecutionRestore(incoming: ExecutionAssociationsSnapshot): ExecutionRestoreResult {
  return {
    associations: cloneAssociations(incoming),
    recovery: {
      complete: false,
      reasons: [{
        kind: "group",
        code: "restore-superseded",
        id: "restore",
        detail: "a detach or shutdown superseded this restore before it finished accounting for the record",
      }],
      reconciled: 0,
      truncated: false,
    },
  };
}

/** A stable one-line summary of a restore result, sized for a bounded notice. */
export function describeExecutionRestore(result: ExecutionRestoreResult): string {
  const { reasons, reconciled, truncated } = result.recovery;
  const codes = reasons.map((reason) => `${reason.kind}:${reason.code}`).filter((code, index, all) => all.indexOf(code) === index);
  return `execution restore: ${reconciled} collected, ${reasons.length}${truncated ? "+" : ""} unresolved${codes.length > 0 ? ` (${codes.join(", ")})` : ""}`;
}

function pruneAssociations(
  incoming: ExecutionAssociationsSnapshot,
  droppedGroups: ReadonlySet<string>,
  droppedWaves: ReadonlySet<string>,
  droppedBundles: ReadonlySet<string>,
  droppedGates: ReadonlySet<string>,
): ExecutionAssociationsSnapshot {
  // The restore reader gives the array precedence and ignores the singular
  // fallback whenever it is present, so pruning must too: otherwise emptying the
  // current roster by a verified clearance would resurrect the shadowed legacy
  // gate, and the persistence projection would write that stale block back for
  // the next restore to reinstate. The fallback survives only for a record that
  // never carried an array at all.
  const legacy = incoming.conflictGates === undefined
    && incoming.conflictGate !== undefined
    && !droppedGates.has(executionGateIdentity(incoming.conflictGate));
  const gates = persistedConflictGates(incoming)
    .filter((gate) => !droppedGates.has(executionGateIdentity(gate)))
    .map((gate) => ({ ...gate, paths: [...gate.paths] }));
  const pruned: Record<string, unknown> = {};
  // An absent roster field stays absent (not an explicit undefined): an
  // omitted roster is unknown ownership, and reconciliation never turns it
  // into an authoritative empty list.
  if (Array.isArray(incoming.waveRoots)) pruned.waveRoots = incoming.waveRoots.filter((root) => !droppedWaves.has(executionPathKey(root) ?? ""));
  if (Array.isArray(incoming.bundles)) pruned.bundles = incoming.bundles.filter((bundle) => !droppedBundles.has(executionBundleIdentity(bundle)));
  if (Array.isArray(incoming.groupRoots)) pruned.groupRoots = incoming.groupRoots.filter((root) => !droppedGroups.has(executionPathKey(root) ?? ""));
  if (legacy && incoming.conflictGate !== undefined) pruned.conflictGate = incoming.conflictGate;
  if (Array.isArray(incoming.conflictGates) && gates.length > 0) pruned.conflictGates = gates;
  return pruned as unknown as ExecutionAssociationsSnapshot;
}

function cloneAssociations(incoming: ExecutionAssociationsSnapshot): ExecutionAssociationsSnapshot {
  const clone: Record<string, unknown> = {};
  if (Array.isArray(incoming.waveRoots)) clone.waveRoots = [...incoming.waveRoots];
  if (Array.isArray(incoming.bundles)) clone.bundles = incoming.bundles.map((bundle) => ({ ...bundle }));
  if (Array.isArray(incoming.groupRoots)) clone.groupRoots = [...incoming.groupRoots];
  if (incoming.conflictGate !== undefined) clone.conflictGate = { ...incoming.conflictGate, paths: [...incoming.conflictGate.paths] };
  if (incoming.conflictGates !== undefined) clone.conflictGates = incoming.conflictGates.map((gate) => ({ ...gate, paths: [...gate.paths] }));
  return clone as unknown as ExecutionAssociationsSnapshot;
}

/** A surviving task record still names this wave root (directly or through its bundle). */
function referencesWave(task: BackgroundTaskRecord, waveKey: string): boolean {
  return (task.waveRoot !== undefined && executionPathKey(task.waveRoot) === waveKey)
    || (task.bundle?.waveRoot !== undefined && executionPathKey(task.bundle.waveRoot) === waveKey);
}

/**
 * True when a surviving task record proves the work is finished and released:
 * landed/reported, not blocked by any live conflict gate, and not a force-merge
 * salvage whose provenance still anchors retained source evidence — the same
 * settled-and-released predicate artifact cleanup retires under. Anything else
 * (in-flight, paused-recoverable, conflicted, failed, interrupted, gated, or
 * salvage-retained) keeps its references required.
 */
export function isRestoredTaskReferenceReleased(task: BackgroundTaskRecord, gatedTaskIds: ReadonlySet<string>): boolean {
  return isArchivableTaskState(task.state)
    && !gatedTaskIds.has(task.taskId)
    && !salvageEvidenceRequiresRetention(task);
}

/** Outcome of the one shared "is this bundle already collected?" check. */
export type CollectedBundleCheck =
  | { readonly collected: true }
  | { readonly collected: false; readonly code: ExecutionRestoreReasonCode; readonly detail: string };

/**
 * The one shared rule for whether a reattachment bundle is already collected
 * work: its wave root is positively absent, no surviving task record still
 * needs it unsettled, and no still-required conflict gate blocks its owning
 * task. Both the shared classification and the controller's legacy-adoption
 * pass use this single predicate, so a proven-collected bundle is never
 * attempted — or announced as a failure — while a surviving or unverified one
 * keeps its full diagnostic and stays in the record.
 */
export async function inspectCollectedBundleReference(
  bundle: ReattachmentBundle | undefined,
  liveState: ExecutionRestoreLiveState,
): Promise<CollectedBundleCheck> {
  if (!(await isExecutionPathPositivelyAbsent(bundle?.waveRoot))) {
    return { collected: false, code: "bundle-unrecoverable", detail: "the bundle's wave root was not verified absent, so its recovery state is unproven" };
  }
  const claimant = liveState.tasks.find((task) => task.taskId === bundle?.taskId);
  if (claimant && !isRestoredTaskReferenceReleased(claimant, liveState.gatedTaskIds)) {
    return { collected: false, code: "bundle-in-flight", detail: `its owning task (${claimant.taskId}) is not settled work` };
  }
  if (bundle?.taskId !== undefined && liveState.gatedTaskIds.has(bundle.taskId)) {
    return { collected: false, code: "bundle-in-flight", detail: "a conflict gate still blocks its owning task" };
  }
  // The inline window is not the whole owning record: compaction evicts settled
  // work, yet its authenticated archive can still retain force-merge salvage
  // evidence that anchors source the wave root provides. Only an exact,
  // successful read of that archive may release the reference.
  if (bundle?.taskId !== undefined && liveState.archiveClaimants !== undefined) {
    try {
      const archived = await liveState.archiveClaimants(bundle.taskId);
      if (archived.some((task) => !isRestoredTaskReferenceReleased(task, liveState.gatedTaskIds))) {
        return { collected: false, code: "bundle-in-flight", detail: "an archived task still requires its recovery evidence" };
      }
    } catch {
      return { collected: false, code: "bundle-unrecoverable", detail: "the owning task archive could not be verified" };
    }
  }
  return { collected: true };
}

/**
 * A resolved path key, or undefined when the value cannot name a path.
 *
 * A recorded path containing a parent segment (`..`) is refused outright:
 * `resolve()` erases both the parent segment and any symlink it passed through,
 * so `alias/../wave` would be keyed as `wave` and certified absent while the
 * path the record actually names resolves somewhere else entirely. Neither
 * comparison identity nor positive absence may be inferred from such a path.
 */
export function executionPathKey(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length === 0) return undefined;
  const separators = process.platform === "win32" ? /[\\/]/ : /\//;
  if (value.split(separators).includes("..")) return undefined;
  try {
    return resolve(value);
  } catch {
    return undefined;
  }
}

function bundleLabel(bundle: ReattachmentBundle | undefined): string {
  return `bundle ${clip(String(bundle?.operationId ?? "?"))}/${clip(String(bundle?.taskId ?? "?"))}`;
}

function clip(value: string): string {
  return value.length <= MAX_RESTORE_DETAIL_CHARS ? value : `${value.slice(0, MAX_RESTORE_DETAIL_CHARS - 1)}…`;
}
