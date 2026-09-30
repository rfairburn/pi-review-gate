/**
 * Read-only force-merge landing-source, salvage-capture, and provenance
 * mechanics (#126, #175), extracted from the background controller.
 *
 * These helpers own no controller state: task/operation records are passed in
 * by reference and never cached, and the only group-derived input — the
 * sibling tasks that share a wave's private repository and can therefore
 * contest ref ownership — arrives as an explicit parameter from the caller.
 * The force-merge and mark-clean transactions that consume them remain in the
 * controller (finding-13 boundary: a single transaction over lease, gate,
 * save, publish, parent checkpoint, and wake state).
 */
import { realpathSync } from "node:fs";
import { realpath, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { BackgroundTaskRecord, ForceMergeSalvageProvenance } from "./task-state";
import type { ReattachmentBundle } from "./operation-record";
import {
  createIncident,
  createReattachmentBundle,
  readOperationRecord,
  writeOperationRecord,
  type OperationRecord,
} from "./operation-record";
import {
  buildAttributedCandidateTree,
  buildSalvageCommit,
  captureWorktreeSnapshot,
  evaluateCandidateAgainstCheckpoint,
  incidentBranchNames,
  listSalvageRefCandidates,
  salvageRefCandidate,
  salvageWorktreeCandidate,
  selectSalvageSource,
  treeShaOf,
  type SalvageCandidateIdentity,
} from "./salvage";
import { readWaveCaptureRecord } from "./wave-repository";

/**
 * #126: the landing source an explicit force-merge resolved to.
 * `checkpoint` is the ordinary verified-checkpoint path (unchanged behavior);
 * `forced_checkpoint` is an explicit override of a lifecycle refusal against a
 * genuinely verified checkpoint; `salvage` is an identified snapshot of actual
 * worker work captured without any ordinary checkpoint, or — when newer
 * retained work provably subsumes one — the snapshot that supersedes it.
 */
export type ForceMergeLandingSource =
  | { kind: "checkpoint"; commitSha: string; ref: string }
  | { kind: "forced_checkpoint"; commitSha: string; ref: string; reason: string }
  | { kind: "salvage"; candidate: SalvageCandidateIdentity; supersededCheckpoint?: { commitSha: string; ref: string } };

/** Human-readable description of where a salvaged landing came from. */
export function describeSalvageSource(source: ForceMergeLandingSource): string {
  if (source.kind !== "salvage") return "its verified checkpoint";
  const candidate = source.candidate;
  if (candidate.sourceKind === "worktree") {
    const where = candidate.branchName
      ? `branch "${candidate.branchName}"`
      : `head ${candidate.headSha?.slice(0, 12) ?? "unknown"}`;
    return `the retained worker worktree (${where})`;
  }
  return `retained ref ${candidate.refName ?? "unknown"}`;
}

/**
 * #175: subtask-review status established from a landing's settled outcome.
 * `reviewed` is true only when the outcome provably carries a successful
 * subtask review (an accepted/accepted_with_warnings result whose final
 * recorded review cycle passed). `uncertain` marks outcomes whose review
 * status cannot be established from the evidence: callers fail closed by
 * keeping the landed diff in the primary review window and reporting the
 * uncertainty, never by guessing a review status or fabricating a PASS.
 */
export interface LandedReviewStatus {
  reviewed: boolean;
  uncertain?: boolean;
  detail?: string;
}

/**
 * #175: establish the subtask-review status of a landing outcome from the
 * settled subtask result (status, explicit unreviewed flag, review cycles)
 * and, for explicit force-merges, the landing source: a forced checkpoint or
 * salvage carries no review success by construction, while an ordinary
 * verified-checkpoint force-merge inherits the settled result's review
 * status. Unknown evidence fails closed (unreviewed + uncertain).
 */
export function landedReviewStatusOf(
  result:
    | { status?: string; unreviewed?: boolean; reviewCycles?: ReadonlyArray<{ verdict?: string }> }
    | undefined,
  forceMergeSource?: ForceMergeLandingSource,
): LandedReviewStatus {
  if (forceMergeSource && forceMergeSource.kind !== "checkpoint") {
    return {
      reviewed: false,
      detail: forceMergeSource.kind === "forced_checkpoint"
        ? "explicitly forced checkpoint landing; no review success is asserted"
        : "salvage landing; no ordinary checkpoint or review behind it",
    };
  }
  if (!result) {
    return { reviewed: false, uncertain: true, detail: "no settled subtask result evidence" };
  }
  if (result.status === "completed_unreviewed" || result.unreviewed === true) {
    return { reviewed: false, detail: "subtask completed unreviewed" };
  }
  if (result.status === "accepted" || result.status === "accepted_with_warnings") {
    const finalCycle = result.reviewCycles?.at(-1);
    if (finalCycle?.verdict === "pass") return { reviewed: true };
    return {
      reviewed: false,
      uncertain: true,
      detail: "accepted result without a passing final review cycle",
    };
  }
  return {
    reviewed: false,
    uncertain: true,
    detail: `unrecognized subtask outcome status ${typeof result.status === "string" ? result.status : "missing"}`,
  };
}

/** #175: synchronous same-workspace identity test for conflict-gate review
 *  readiness (the sync twin of checkpointParent's realpath guard). An
 *  identity-resolution error fails closed by treating the gate as
 *  same-workspace, keeping the review blocker. */
export function sameWorkspaceGate(sourceRoot: string, cwd: string): boolean {
  try {
    return realpathSync(sourceRoot) === realpathSync(cwd);
  } catch {
    return true;
  }
}

/** Durable forced-salvage provenance for a force-merge whose source is not the
 * ordinary verified checkpoint. Undefined for that ordinary path, which
 * records no salvage. */
export function salvageProvenanceFor(
  source: ForceMergeLandingSource,
  commitSha: string,
  checkpoint?: { changedPaths?: string[] },
): ForceMergeSalvageProvenance | undefined {
  if (source.kind === "checkpoint") return undefined;
  const superseded = source.kind === "salvage" ? source.supersededCheckpoint : undefined;
  return {
    reason: source.kind === "forced_checkpoint"
      ? source.reason
      : superseded
        ? `verified checkpoint ${superseded.ref} (${superseded.commitSha.slice(0, 12)}) superseded by identified newer retained work; salvaged from ${describeSalvageSource(source)}`
        : `no ordinary verified checkpoint; salvaged from ${describeSalvageSource(source)}`,
    sourceKind: source.kind === "forced_checkpoint" ? "verified_checkpoint" : source.candidate.sourceKind,
    ...(superseded ? { supersededCheckpoint: superseded } : {}),
    ...(source.kind === "salvage" && source.candidate.branchName ? { branchName: source.candidate.branchName } : {}),
    ...(source.kind === "salvage" && source.candidate.headSha ? { headSha: source.candidate.headSha } : {}),
    ...(source.kind === "salvage" && source.candidate.refName ? { refName: source.candidate.refName } : {}),
    candidateCommit: commitSha,
    candidateRef: source.kind === "salvage" ? source.candidate.candidateRef : source.ref,
    attributedPaths: source.kind === "salvage" ? [...source.candidate.attributedPaths] : [...(checkpoint?.changedPaths ?? [])],
    baselineOnlyPaths: source.kind === "salvage" ? [...source.candidate.baselineOnlyPaths] : [],
    ambiguousPaths: source.kind === "salvage" ? [...source.candidate.ambiguousPaths] : [],
  };
}

/** #126: resolve the operation bundle when no verified bundle is published on
 * the task (the salvage path). A missing wave root or record means there is
 * no recoverable anchor; other read errors are surfaced as-is. */
export async function resolveUnverifiedForceMergeBundle(task: BackgroundTaskRecord): Promise<ReattachmentBundle | undefined> {
  if (!task.waveRoot) return undefined;
  let ownedRoot: string;
  try {
    ownedRoot = await realpath(task.waveRoot);
  } catch {
    return undefined;
  }
  try {
    const record = await readOperationRecord(join(ownedRoot, "artifacts", task.taskId, "operation.json"));
    return createReattachmentBundle(record, ownedRoot);
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return undefined;
    throw error;
  }
}

/**
 * #126: identify and capture a salvage snapshot of the task's actual worker
 * work when no ordinary verified checkpoint is available. A retained
 * worktree is the authoritative source (it holds dirty work no ref can);
 * only when it is gone are surviving refs in the private repository
 * identified, with durable incident evidence breaking ties. Refusals throw
 * an explicit unresolved status; nothing is transferred and the task state
 * is left for inspection.
 *
 * `siblings` names the other task records that share this task's wave root
 * (passed in from the controller's actual group record, never cached): the
 * wave's private repository is shared by every task of its group, so their
 * durable incident evidence is the boundary of contested ref ownership.
 */
export async function captureSalvageSource(
  task: BackgroundTaskRecord,
  record: OperationRecord,
  siblings: BackgroundTaskRecord[],
): Promise<ForceMergeLandingSource> {
  const capture = await readWaveCaptureRecord(task.waveRoot!);
  const worktreeStat = await stat(record.worktreeRoot).catch(() => undefined);
  if (worktreeStat?.isDirectory()) {
    // The retained worktree is this task's own checkout (identity-checked
    // against the private repository); sibling tasks cannot claim it.
    const candidate = await salvageWorktreeCandidate(capture, task.taskId, record.title, record.worktreeRoot);
    if (!candidate.differsFromBase) {
      throw new Error(`No provably worker-owned content identified in the retained work for task ${task.taskId}; nothing was transferred.`);
    }
    return { kind: "salvage", candidate };
  }
  const candidates = await listSalvageRefCandidates(capture, record, task.taskId);
  // #126 review: the wave's private repository is shared by every task of
  // this group, so a surviving branch-head ref may belong to a sibling task.
  // Durable incident evidence naming refs and proven task-owned namespaces
  // are the only ownership proofs; with siblings present, an unnamed sole
  // branch-head candidate cannot be excluded and selection falls through to
  // ambiguous rather than transferring another task's work.
  const siblingNamedRefs = new Set<string>();
  for (const sibling of siblings) {
    try {
      const siblingRecord = await readOperationRecord(join(task.waveRoot!, "artifacts", sibling.taskId, "operation.json"));
      for (const name of incidentBranchNames(siblingRecord)) siblingNamedRefs.add(name);
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") throw error;
    }
  }
  const selection = selectSalvageSource(candidates, { hasSiblingTasks: siblings.length > 0 });
  if (selection.kind === "none") {
    throw new Error(`No recoverable worker work identified for task ${task.taskId}: ${selection.reason}.`);
  }
  if (selection.kind === "ambiguous") {
    // Ambiguity-only candidates are named here too: surviving evidence with
    // unproven ownership is reported, never called nonexistent.
    const listing = selection.candidates.map((c) => {
      const shortName = c.refName.replace(/^refs\/heads\//, "");
      return `${c.refName} (tip ${c.tipSha.slice(0, 12)}; attributed ${c.attributedPaths.length}, ambiguous ${c.ambiguousPaths.length}${c.taskOwned ? "; task-owned immutable ref" : ""}${c.incidentNamed ? "; named in this task's checkpoint-failure incident" : ""}${siblingNamedRefs.has(shortName) ? "; also named in another task's incidents" : ""})`;
    }).join("; ");
    const ownershipNote = siblings.length > 0 && !selection.candidates.some((c) => c.incidentNamed)
      ? " The wave's private repository is shared by this group's tasks and no durable evidence attributes exactly one ref to this task."
      : "";
    throw new Error(`Multiple plausible salvage sources for task ${task.taskId} and no durable evidence identifies exactly one; none was transferred: ${listing}.${ownershipNote}`);
  }
  const candidate = await salvageRefCandidate(capture, task.taskId, record.title, selection.candidate);
  return { kind: "salvage", candidate };
}

/**
 * #126 correction: a verified checkpoint must not silently hide newer
 * retained work. The retained worktree is inspected for committed/staged/
 * unstaged/task-created content the checkpoint's tree does not carry; when
 * it provably subsumes the checkpoint it supersedes it, and anything that
 * cannot be ordered is surfaced rather than guessed.
 *
 * The worktree is never assumed to be a superset of the checkpoint: a branch
 * switch can abandon older worker commits or the captured uncommitted
 * baseline. It supersedes only when every checkpoint delta is preserved with
 * identical content or provably newer content (its head descends from a
 * commit carrying the checkpoint's tree). Surviving refs — branch heads and
 * this task's own candidate/review namespaces — are superseded review
 * history: their candidate commits all share the wave base as parent, so
 * they pass identity verification but cannot be ordered against the accepted
 * checkpoint. Landing one would regress to an older cycle's tree and refusing
 * on one would block an ordinary reviewed landing, so refs are excluded from
 * this decision entirely. The inspection is read-only; on ambiguity nothing
 * is transferred, no stale checkpoint is regressed to, and no prior work is
 * dropped.
 */
export async function identifyWorkBeyondCheckpoint(
  task: BackgroundTaskRecord,
  record: OperationRecord,
  checkpoint: { commitSha: string; ref: string },
): Promise<
  | { kind: "none" }
  | { kind: "salvage"; candidate: SalvageCandidateIdentity }
  | { kind: "ambiguous"; message: string }
> {
  const capture = await readWaveCaptureRecord(task.waveRoot!);
  const repoPath = capture.repositoryPath;
  const checkpointTree = await treeShaOf(repoPath, checkpoint.commitSha);

  const worktreeStat = await stat(record.worktreeRoot).catch(() => undefined);
  if (!worktreeStat?.isDirectory()) return { kind: "none" };
  const snapshot = await captureWorktreeSnapshot(capture, record.worktreeRoot);
  if (snapshot.finalTree === checkpointTree) return { kind: "none" };
  const candidateTree = await buildAttributedCandidateTree(capture, snapshot.finalTree, snapshot.classification);
  const supersession = await evaluateCandidateAgainstCheckpoint(
    capture, checkpointTree, candidateTree, snapshot.classification, snapshot.headSha,
  );
  if (supersession.beyondPaths.length === 0) return { kind: "none" };
  if (!supersession.subsumesCheckpoint) {
    const message = `Verified checkpoint ${checkpoint.ref} (${checkpoint.commitSha.slice(0, 12)}) and the retained worker worktree both carry identified changes; the worktree does not preserve every checkpoint delta with identical or provably newer content, so it is not a provable superset; nothing was transferred. The worktree carries beyond-checkpoint path(s) ${supersession.beyondPaths.join(", ")}. Manual inspection of the retained worktree is required before choosing a recovery.`;
    return { kind: "ambiguous", message };
  }
  const commit = await buildSalvageCommit(capture, task.taskId, record.title, candidateTree, resolve(record.worktreeRoot));
  return {
    kind: "salvage",
    candidate: {
      ...commit,
      ...snapshot.classification,
      sourceKind: "worktree",
      headSha: snapshot.headSha,
      ...(snapshot.branchName ? { branchName: snapshot.branchName } : {}),
    },
  };
}

/** #126: durable operation-record provenance for a salvaged force-merge.
 * This is tolerated bookkeeping: it records what happened to the source
 * evidence and never changes the truthful operation state or asserts review
 * success. `conflicted` reports an outcome where only the non-conflicting
 * paths were transferred and materialized markers await resolution. */
export async function recordSalvageProvenanceIncident(
  task: BackgroundTaskRecord,
  provenance: ForceMergeSalvageProvenance,
  conflicted?: { appliedPaths: string[]; conflictPaths: string[] },
): Promise<void> {
  if (!task.waveRoot) return;
  const ownedRoot = await realpath(task.waveRoot);
  const record = await readOperationRecord(join(ownedRoot, "artifacts", task.taskId, "operation.json"));
  const outcome = conflicted
    ? `Transferred ${conflicted.appliedPaths.length} non-conflicting path(s); ${conflicted.conflictPaths.length} conflict(s) await resolution (${conflicted.conflictPaths.join(", ")});`
    : `Landed all attributed paths;`;
  const checkpointNote = provenance.sourceKind === "verified_checkpoint"
    ? "despite the operation lifecycle state"
    : provenance.supersededCheckpoint
      ? `superseding verified checkpoint ${provenance.supersededCheckpoint.ref} (${provenance.supersededCheckpoint.commitSha.slice(0, 12)})`
      : "without an ordinary verified checkpoint";
  record.incidents.push(createIncident({
    attempt: record.attempts.length,
    generation: record.generation,
    cause: "salvage",
    stage: "force_merge",
    message: `Explicit force-merge ${conflicted ? "materialized conflicts from" : "landed"} candidate ${provenance.candidateCommit} from ${provenance.sourceKind} ${checkpointNote}; no review status was asserted. ${outcome} ${provenance.baselineOnlyPaths.length} baseline-only and ${provenance.ambiguousPaths.length} ambiguous path(s) were not transferred.`,
    retryable: false,
  }));
  await writeOperationRecord(record);
}