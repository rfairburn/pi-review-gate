/**
 * #175/#25: the one authoritative parent-checkpoint ledger, extracted from
 * the background controller. It owns parent-change sampling (admission
 * guards), landing-boundary guards, selective checkpointing against the
 * review window's owners, the landed-change review disposition, two-owner
 * composition, receipt-gated owner retirement, and unreferenced-composition
 * cleanup — the exact controller invariants, verbatim.
 *
 * The ledger owns no controller state: the controller passes live read
 * projections (config, state, cwd), the session-sidecar save callback and its
 * association snapshot at their existing read points, and an activity-context
 * seam that keeps group/task record lookup on the controller. The controller
 * remains the only caller of its delegation methods for force-merge/mark-clean
 * transactions; wave lifecycle runners consume the same ledger instance.
 */
import { realpath } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import {
  effectiveReviewSettings,
  type ReviewGateConfig,
} from "../config";
import { createWorkspaceSnapshot, type FileSnapshot, type WorkspaceSnapshot } from "../capture";
import {
  activeExchangeBaseline,
  checkpointReviewWindow,
  ownedReviewCheckpointDescriptors,
  snapshotOfReviewBaseline,
  type ReviewBaseline,
  type ReviewGateState,
  type UnifiedReviewBaseline,
} from "../state";
import { advanceGitCheckpoint, compareToGitCheckpoint, loadGitCheckpoint } from "../git-checkpoint";
import { advanceRawReviewCheckpoint, changedRawCheckpointPaths, releaseReviewCheckpoint, reviewCheckpointWorkspaceRoot, type ReviewCheckpointDescriptor } from "../review-checkpoint";
import { reviewCheckpointDescriptorIdentity, type ExecutionAssociationsSnapshot } from "../session-state";
import type { BackgroundFaultContext, BackgroundFaultHooks } from "./background-controller";
import type { LandedReviewStatus } from "./force-merge-salvage";

/** A session-sidecar save that also retired every unreferenced checkpoint owner.
 * Bare `true` means durable save only: the controller must retire its own old owners. */
export type ParentCheckpointSaveResult = void | boolean | { saved: true; ownersRetired: true };

/** The session writer uses this only after its serialized save-and-retire
 * operation finishes. A failed/unavailable save cannot issue a receipt. */
export async function acknowledgeOwnerRetiringSave(saveAndRetire: () => Promise<boolean>): Promise<ParentCheckpointSaveResult> {
  return await saveAndRetire() ? { saved: true, ownersRetired: true } : false;
}

/**
 * Live environment projections for the parent-checkpoint ledger. Config,
 * state, cwd, and the fault hook are read at each use — never captured — so
 * the ledger cannot freeze scheduled selections or stale review windows.
 */
export interface ParentCheckpointLedgerEnv {
  config(): ReviewGateConfig;
  state(): ReviewGateState;
  cwd(): string;
  notify?(message: string): void | Promise<void>;
  /** Only true or a save-and-retirement receipt confirms a durable parent sidecar write. */
  onAssociationsChanged?(associations: ExecutionAssociationsSnapshot): ParentCheckpointSaveResult | Promise<ParentCheckpointSaveResult>;
  /** The controller's association snapshot for the durable sidecar save. */
  associationsSnapshot(): ExecutionAssociationsSnapshot;
  /** Records fault-context diagnostics against the owning task's activity; group lookup stays controller-side. */
  addActivityContext(context: BackgroundFaultContext, phase: string, message: string): void;
  /** Deterministic fault hook, read live at each step. */
  faults?(): Pick<BackgroundFaultHooks, "checkpointParent"> | undefined;
}

/**
 * One authoritative parent-checkpoint ledger. Mutates the review window's
 * checkpoint owners in place (state.ts owns the review-window mechanics);
 * the session-sidecar acknowledgement receipt protocol is unchanged.
 */
export class ParentCheckpointLedger {
  constructor(private readonly env: ParentCheckpointLedgerEnv) {}

  reviewLandedChangesEnabled(): boolean {
    const config = this.env.config();
    const review = effectiveReviewSettings(config);
    return config.enabled && review.primaryEnabled && review.reviewLandedChanges;
  }

  /** Guard provenance, not a second parent baseline. At task admission record
   * which paths already differed from EACH verified parent checkpoint. Only
   * path identities are retained; no captured bytes replace checkpoint data. */
  async preTaskParentChanges(sourceRoot: string): Promise<Map<ReviewCheckpointDescriptor, Set<string>>> {
    const changes = new Map<ReviewCheckpointDescriptor, Set<string>>();
    if (await realpath(sourceRoot) !== await realpath(this.env.cwd())) return changes;
    const window = this.env.state().reviewWindow;
    for (const baseline of [window?.baseline, window?.activeExchange?.baseline]) {
      if (!baseline || baseline.kind !== "checkpoint" || changes.has(baseline.descriptor)) continue;
      if (await realpath(baseline.cwd) !== await realpath(sourceRoot)) throw new Error("Parent checkpoint belongs to a different workspace.");
      if (baseline.descriptor.kind === "git") {
        // A nested session still owns the same workspace, but its Git review
        // checkpoint is rooted at the enclosing repository. Keep the session
        // cwd and repo-relative change paths unchanged; the Git loader checks
        // the descriptor's repository identity before comparison.
        const checkpointRoot = await reviewCheckpointWorkspaceRoot(sourceRoot, baseline.descriptor);
        const loaded = await loadGitCheckpoint(checkpointRoot, baseline.descriptor.checkpoint);
        if (loaded.status !== "ok") throw new Error(`Parent checkpoint guard refused: ${loaded.reason} ${loaded.detail ?? ""}`);
        const compared = await compareToGitCheckpoint(checkpointRoot, loaded.value.encoded);
        if (compared.status !== "ok") throw new Error(`Parent checkpoint guard refused: ${compared.reason} ${compared.detail ?? ""}`);
        changes.set(baseline.descriptor, new Set([
          ...compared.value.trackedChanges.map((change) => change.path),
          ...compared.value.untrackedChanges.map((change) => change.path),
        ]));
      } else {
        const compared = await changedRawCheckpointPaths(sourceRoot, baseline.descriptor);
        if (compared.status !== "ok") throw new Error(`Parent checkpoint guard refused: ${compared.reason} ${compared.detail ?? ""}`);
        changes.set(baseline.descriptor, compared.value);
      }
    }
    return changes;
  }

  /** Refresh at the last controller-owned pre-landing boundary. A failed read
   * cannot authorize advancement: leave all landed paths reviewable. Union
   * with admission provenance so an edit later reverted is not silently
   * treated as independently reviewed work. */
  async landingParentGuard(
    sourceRoot: string,
    admission: WorkspaceSnapshot | Map<ReviewCheckpointDescriptor, Set<string>> | undefined,
  ): Promise<Map<ReviewCheckpointDescriptor, Set<string>> | undefined> {
    if (!(admission instanceof Map)) return undefined;
    try {
      const latest = await this.preTaskParentChanges(sourceRoot);
      const combined = new Map<ReviewCheckpointDescriptor, Set<string>>();
      for (const [descriptor, paths] of admission) {
        const now = latest.get(descriptor);
        if (now) combined.set(descriptor, new Set([...paths, ...now]));
      }
      return combined;
    } catch {
      // Keep checkpointParent's eligibility empty on an uncertain read.
      return undefined;
    }
  }

  async checkpointParent(
    reviewWindowId: number | undefined,
    taskBaseline: ReviewBaseline | undefined,
    before: WorkspaceSnapshot | Map<ReviewCheckpointDescriptor, Set<string>> | undefined,
    sourceRoot: string,
    landedPaths: string[],
    faultContext: BackgroundFaultContext = {},
    landedReview?: LandedReviewStatus,
    conflictResolution = false,
  ): Promise<void> {
    const env = this.env;
    await env.faults?.()?.checkpointParent?.(faultContext);
    if (!taskBaseline || reviewWindowId === undefined || env.state().reviewWindow?.id !== reviewWindowId || landedPaths.length === 0) return;
    // #25: the parent review baseline only covers the parent session's own
    // workspace. Snapshot file keys are relative to each snapshot's root, so
    // merging a different target repository's files into this baseline would
    // surface them as phantom parent changes (or corrupt colliding paths).
    // A landing into an explicitly selected foreign target therefore never
    // checkpoints the parent; same-directory targets keep current behavior.
    if (await realpath(sourceRoot) !== await realpath(env.cwd())) return;
    // #175: with the landed-change review policy on (and automatic primary
    // review on), an UNREVIEWED same-workspace landing keeps its diff in the
    // primary review window's ordinary evidence for the model's normal idle
    // settlement (never an immediate or separate review); a landing whose
    // content already carries a successful subtask review is not
    // double-reviewed and keeps the exact existing selective checkpoint. An
    // outcome whose review status cannot be established fails closed: the
    // diff stays in the review window and the uncertainty is reported rather
    // than guessed or treated as reviewed. The foreign-target identity guard
    // above still keeps unrelated target landings out of the parent window,
    // and the policy off (or primary review off) keeps the exact prior
    // checkpointing behavior.
    if (this.reviewLandedChangesEnabled()) {
      const status = landedReview
        ?? { reviewed: false, uncertain: true, detail: "no review-status evidence supplied for this landing path" };
      if (!status.reviewed) {
        if (status.uncertain) {
          env.addActivityContext(
            faultContext,
            "bookkeeping",
            `Task ${faultContext.taskId} landed with subtask-review status that could not be established from its outcome (${status.detail}); the landed diff stays in the primary review window for the next model-idle review instead of being treated as reviewed.`,
          );
        }
        return;
      }
    }
    // A human-resolved conflict has no provable independently reviewed bytes.
    // Marker/resolution content may contain parent edits made while the worker
    // ran; retain that path for primary review even with landed review off.
    if (conflictResolution) return;
    const state = env.state();
    const window = state.reviewWindow;
    if (!window || window.id !== reviewWindowId) return;
    if (taskBaseline.kind === "snapshot") {
      // Legacy snapshot windows retain the original pre-task parent-change
      // guard; no snapshot is used as a fallback for a checkpoint window.
      if (!before || before instanceof Map) return;
      const after = await createWorkspaceSnapshot(sourceRoot, {
        maxFileBytes: env.config().maxFileBytes,
        maxSnapshotBytes: env.config().maxSnapshotBytes,
        reuseUnchangedFrom: before,
      });
      if (env.state().reviewWindow?.id !== reviewWindowId) return;
      const accumulated = snapshotOfReviewBaseline(activeExchangeBaseline(env.state()));
      if (accumulated) checkpointReviewWindow(env.state(), selectiveCheckpoint(accumulated, taskBaseline.snapshot, before, after, landedPaths, sourceRoot));
      return;
    }
    if (taskBaseline.kind !== "checkpoint") throw new Error("Legacy Git parent baseline cannot be selectively advanced.");
    // Window and active exchange may own distinct pinned descriptors. Compose
    // each against its own verified old state, without folding parent edits
    // into either or turning the task's internal capture into a parent base.
    const oldWindow = window.baseline;
    const oldExchange = window.activeExchange?.baseline;
    if (oldWindow?.kind !== "checkpoint" || oldExchange?.kind !== "checkpoint") {
      throw new Error("Parent review checkpoint owners are incomplete or mixed.");
    }
    // A missing/failed landing-boundary guard is not evidence of a clean
    // parent: retain the landing in both owners rather than advancing it.
    if (!conflictResolution && !(before instanceof Map)) return;
    const updates = new Map<ReviewCheckpointDescriptor, UnifiedReviewBaseline>();
    try {
      for (const old of [oldWindow, oldExchange]) {
        if (updates.has(old.descriptor)) continue;
        if (await realpath(old.cwd) !== await realpath(sourceRoot)) throw new Error("Parent checkpoint belongs to a different workspace.");
        const preExisting = conflictResolution ? new Set<string>() : before instanceof Map ? before.get(old.descriptor) : undefined;
        // If another landing replaced this descriptor after task admission,
        // provenance cannot be established: retain every selected path as
        // review evidence instead of advancing it without an ownership guard.
        if (!preExisting) continue;
        const eligiblePaths = landedPaths.filter((path) => ![...preExisting].some((changed) =>
          changed === path || changed.startsWith(`${path}/`) || path.startsWith(`${changed}/`)));
        if (eligiblePaths.length === 0) continue;
        const checkpointId = `parent-landed-${randomUUID()}`;
        let descriptor: ReviewCheckpointDescriptor;
        if (old.descriptor.kind === "git") {
          // The selector paths are already repository-relative, as are the
          // comparison results; only the checkpoint root needs resolution.
          const checkpointRoot = await reviewCheckpointWorkspaceRoot(sourceRoot, old.descriptor);
          const advanced = await advanceGitCheckpoint(checkpointRoot, old.descriptor.checkpoint, eligiblePaths, checkpointId);
          if (advanced.status !== "ok") throw new Error(`Parent checkpoint advance refused: ${advanced.reason} ${advanced.detail ?? ""}`);
          descriptor = { kind: "git", checkpoint: advanced.value.descriptor };
        } else {
          const advanced = await advanceRawReviewCheckpoint(sourceRoot, old.descriptor, eligiblePaths, checkpointId);
          if (advanced.status !== "ok") throw new Error(`Parent checkpoint advance refused: ${advanced.reason} ${advanced.detail ?? ""}`);
          descriptor = advanced.value;
        }
        updates.set(old.descriptor, { kind: "checkpoint", descriptor, cwd: old.cwd, capturedAt: new Date().toISOString() });
      }
      if (state.reviewWindow !== window || window.id !== reviewWindowId
        || window.baseline !== oldWindow || window.activeExchange?.baseline !== oldExchange) return;
      if (updates.size === 0) return;
      window.baseline = updates.get(oldWindow.descriptor) ?? oldWindow;
      window.activeExchange!.baseline = updates.get(oldExchange.descriptor) ?? oldExchange;
      window.activeExchange!.evidenceEventStart = window.evidence.events.length;
      window.activeExchange!.assistantSummaryStart = window.evidence.finalAssistantSummaries.length;
      window.activeExchange!.requestHistoryStart = window.requestHistory.length;
      // Once reachable from state, new owners must survive even a failed save.
      // The callback is the production session-sidecar writer, not the group
      // association save; only its explicit durable acknowledgement permits
      // retiring old owners. A missing/failed acknowledgement leaves both
      // generations intact for restart recovery.
      updates.clear();
      let saved: ParentCheckpointSaveResult;
      try {
        saved = await env.onAssociationsChanged?.(env.associationsSnapshot());
      } catch (error) {
        await this.reportParentCheckpointRetention(faultContext, `session-sidecar save failed (${messageOf(error)})`);
        return;
      }
      if (saved !== true && !(saved && typeof saved === "object" && saved.saved === true && saved.ownersRetired === true)) {
        await this.reportParentCheckpointRetention(faultContext, "session-sidecar save was unavailable or did not confirm a durable write");
        return;
      }
      // The production session writer saves and retires through one serialized
      // owner ledger. A receipt means its release has already completed; doing
      // it again here would report a false failure (or race a later owner).
      if (saved !== true) return;
      // Check ALL live owners after the save (including last-question and an
      // exchange with a distinct descriptor), not just the replaced slots.
      const referenced = new Set(ownedReviewCheckpointDescriptors(env.state()).map(({ cwd, descriptor }) =>
        reviewCheckpointDescriptorIdentity(cwd, descriptor)));
      const superseded = new Map<string, { cwd: string; descriptor: ReviewCheckpointDescriptor }>();
      for (const old of [oldWindow, oldExchange]) {
        const identity = reviewCheckpointDescriptorIdentity(old.cwd, old.descriptor);
        if (!referenced.has(identity)) superseded.set(identity, { cwd: old.cwd, descriptor: old.descriptor });
      }
      for (const owner of superseded.values()) {
        try {
          const released = await releaseReviewCheckpoint(owner.cwd, owner.descriptor);
          if (released.status !== "ok") await this.reportParentCheckpointRetention(faultContext, `owner release failed (${released.reason}): ${released.detail}`);
        } catch (error) {
          await this.reportParentCheckpointRetention(faultContext, `owner release failed (${messageOf(error)})`);
        }
      }
    } finally {
      // Failed or superseded compositions are not reachable from state.
      for (const update of updates.values()) await releaseReviewCheckpoint(sourceRoot, update.descriptor);
    }
  }

  /** A missing sidecar acknowledgement leaks conservatively; it must not
   * turn already-landed work into a failed task or hide the recovery caveat. */
  private async reportParentCheckpointRetention(context: BackgroundFaultContext, detail: string): Promise<void> {
    const message = `Parent checkpoint owners retained: ${detail}; review evidence remains intact.`;
    this.env.addActivityContext(context, "bookkeeping", message);
    try { await this.env.notify?.(`review gate: ${message}`); } catch { /* best effort; task activity remains */ }
  }
}

function selectiveCheckpoint(
  accumulatedBaseline: WorkspaceSnapshot,
  taskBaseline: WorkspaceSnapshot,
  before: WorkspaceSnapshot,
  after: WorkspaceSnapshot,
  paths: string[],
  sourceRoot: string,
): WorkspaceSnapshot {
  const absolute = new Set(paths.map((path) => resolve(sourceRoot, path)));
  const files = new Map(accumulatedBaseline.files);
  for (const [key, afterFile] of after.files) {
    if (!absolute.has(afterFile.absolutePath)) continue;
    if (!parentChanged(taskBaseline.files.get(key), before.files.get(key))) files.set(key, afterFile);
  }
  for (const [key, baselineFile] of accumulatedBaseline.files) {
    if (!absolute.has(baselineFile.absolutePath) || after.files.has(key)) continue;
    if (!parentChanged(taskBaseline.files.get(key), before.files.get(key))) files.delete(key);
  }
  return { cwd: accumulatedBaseline.cwd, capturedAt: after.capturedAt, files, omissions: after.omissions, omissionsTruncated: after.omissionsTruncated };
}

function parentChanged(a: FileSnapshot | undefined, b: FileSnapshot | undefined): boolean {
  if (!a && !b) return false;
  if (!a || !b) return true;
  return a.content !== b.content || a.sha256 !== b.sha256 || a.isBinary !== b.isBinary;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}