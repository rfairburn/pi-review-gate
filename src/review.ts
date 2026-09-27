import { cp, mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { basename, join, relative, resolve, isAbsolute, sep } from "node:path";
import { resolveReviewers, reviewerConfigFingerprint, reviewerDisplayLabel, reviewerDisplayLabels, unresolvedReviewerSelectionsFor, type DeciderConfig, type ReviewGateConfig } from "./config";
import { createReviewerQuestionBundle, createReviewBundle, removeReviewBundle, syncReviewWindowArtifacts, type ReviewBundle } from "./bundle";
import { BINARY_SAMPLE_BYTES, looksBinary, compareFileSnapshots, compareSnapshots, createPathSnapshot, createWorkspaceSnapshot, type ChangedFile, type FileSnapshot, type SnapshotOmission, type WorkspaceSnapshot } from "./capture";
import { captureReviewCheckpoint, compareReviewCheckpoints, loadReviewCheckpoint, releaseReviewCheckpoint, reviewCheckpointWorkspaceRoot, type ReviewCheckpointDescriptor, type ReviewCheckpointChange, type ReviewCheckpointState } from "./review-checkpoint";
import { buildUnifiedPatch, type PatchBuildResult } from "./diff";
import { buildEvidenceBundle, collectEvidenceChanges, type EvidenceState } from "./evidence";
import {
  armGitCheckpoint,
  compareGitCheckpoints,
  loadGitCheckpoint,
  releaseGitCheckpointPin,
  type GitCheckpointDescriptor,
} from "./git-checkpoint";
import { buildGitReviewDelta } from "./git-review-delta";
import type { ChangeIdentity, ReviewResult } from "./schema";
import { validateChangeIdentity } from "./schema";
import { GenericCliAdapter } from "./adapters/generic-cli";
import { CodexCliAdapter } from "./adapters/codex-cli";
import { ClaudeCliAdapter } from "./adapters/claude-cli";
import { PiModelAdapter } from "./adapters/pi-model";
import type { ModelAdapter, ReviewerSession } from "./adapters/types";
import type { TokenUsage } from "./usage";
import { completeActiveExchange, hasUnresolvedReview, isReviewBaseline, snapshotOfReviewBaseline, type GitCheckpointBaseline, type UnifiedReviewBaseline, type ReviewBaseline, type ReviewWindow } from "./state";
import { aggregateReviewDisposition } from "./review-report";

export interface ReviewRunInput {
  cwd: string;
  request: string;
  /**
   * The review baseline: a completed workspace snapshot (legacy) or a typed
   * review baseline. A Git checkpoint variant settles through one frozen
   * after-checkpoint instead of a full-root workspace snapshot.
   */
  before: WorkspaceSnapshot | ReviewBaseline;
  config: ReviewGateConfig;
  evidence?: EvidenceState;
  actingUsage?: TokenUsage;
  correctionAttemptCount?: number;
  changeIdentity?: ChangeIdentity;
  /** Exact Git-derived change data for a normalized candidate. Only valid together with changeIdentity. */
  exactChange?: ExactChangeInput;
  signal?: AbortSignal;
  notify?: (message: string) => void | Promise<void>;
  onUpdate?: (message: string) => void;
  onInvocationPrepared?: () => void | Promise<void>;
  window?: ReviewWindow;
}

/** Exact Git-derived change data for a normalized candidate commit. */
export interface ExactChangeInput {
  /** Deterministic list of changed paths from Git. */
  changedPaths: string[];
  /** The exact commit patch (may be truncated). */
  patch: string;
  /** Whether the patch was truncated. */
  truncated: boolean;
  /** Paths whose diffs were omitted due to truncation. */
  omitted: Array<{ path: string; reason: string }>;
}

export interface ReviewRunOutput {
  changed: boolean;
  changes: ChangedFile[];
  noReviewReason?: "no_initial_changes" | "unchanged_review_response" | "unchanged_deferred_response";
  result?: ReviewResult;
  reviewerResults?: ReviewResult[];
  reviewerDisplayLabels?: Record<string, string>;
  bundleDir?: string;
  invocationDir?: string;
  reviewSequence?: number;
  /** The frozen after-baseline the review settled against; recorded on the window state when a completed pass transfers ownership. */
  reviewedBaseline?: ReviewBaseline;
  /** Release a handed-off after descriptor if the caller cannot record it. */
  releaseReviewedBaseline?: () => Promise<void>;
  bundleRetained?: boolean;
  error?: string;
}

export interface PausedExchangeInput {
  cwd: string;
  config: ReviewGateConfig;
  evidence?: EvidenceState;
  actingUsage?: TokenUsage;
  window: ReviewWindow;
}

export interface AskReviewerInput {
  cwd: string;
  question: string;
  request: string;
  /** Review baseline (legacy snapshot or typed); a Git variant settles through one frozen ephemeral after-checkpoint. */
  before?: WorkspaceSnapshot | ReviewBaseline;
  config: ReviewGateConfig;
  evidence?: EvidenceState;
  correctionAttemptCount?: number;
  changeIdentity?: ChangeIdentity;
  signal?: AbortSignal;
  notify?: (message: string) => void | Promise<void>;
  onUpdate?: (message: string) => void;
  onInvocationPrepared?: () => void | Promise<void>;
  window?: ReviewWindow;
}

export interface AskReviewerOutput {
  changes: ChangedFile[];
  result?: ReviewResult;
  reviewerResults?: ReviewResult[];
  reviewerDisplayLabels?: Record<string, string>;
  bundleDir?: string;
  bundleRetained?: boolean;
  error?: string;
}

export async function runReview(input: ReviewRunInput): Promise<ReviewRunOutput> {
  const validationError = input.changeIdentity !== undefined ? validateChangeIdentity(input.changeIdentity) : undefined;
  if (validationError) {
    return { changed: false, changes: [], error: `Invalid changeIdentity: ${validationError}` };
  }
  // exactChange requires changeIdentity and must be well-formed.
  if (input.exactChange !== undefined) {
    if (input.changeIdentity === undefined) {
      return { changed: false, changes: [], error: "exactChange requires changeIdentity to be set." };
    }
    const ec = input.exactChange;
    if (typeof ec !== "object" || ec === null || Array.isArray(ec)) {
      return { changed: false, changes: [], error: "exactChange must be an object." };
    }
    if (!Array.isArray(ec.changedPaths)) {
      return { changed: false, changes: [], error: "exactChange.changedPaths must be an array." };
    }
    if (typeof ec.patch !== "string") {
      return { changed: false, changes: [], error: "exactChange.patch must be a string." };
    }
    if (typeof ec.truncated !== "boolean") {
      return { changed: false, changes: [], error: "exactChange.truncated must be a boolean." };
    }
    if (!Array.isArray(ec.omitted)) {
      return { changed: false, changes: [], error: "exactChange.omitted must be an array." };
    }
    // Validate changedPaths members: each must be a non-empty string.
    const changedPathSet = new Set<string>();
    for (const path of ec.changedPaths) {
      if (typeof path !== "string" || path.length === 0) {
        return { changed: false, changes: [], error: "exactChange.changedPaths must contain non-empty strings." };
      }
      changedPathSet.add(path);
    }
    // Validate omitted members: each must be an object with string path and reason;
    // omitted paths must belong to changedPaths.
    for (const item of ec.omitted) {
      if (typeof item !== "object" || item === null || Array.isArray(item)) {
        return { changed: false, changes: [], error: "exactChange.omitted entries must be objects." };
      }
      if (typeof (item as Record<string, unknown>).path !== "string") {
        return { changed: false, changes: [], error: "exactChange.omitted entries must have a string path." };
      }
      if (typeof (item as Record<string, unknown>).reason !== "string") {
        return { changed: false, changes: [], error: "exactChange.omitted entries must have a string reason." };
      }
      if (!changedPathSet.has((item as Record<string, unknown>).path as string)) {
        return { changed: false, changes: [], error: "exactChange.omitted path not in changedPaths." };
      }
    }
    // Truncation consistency: if not truncated, omitted must be empty.
    if (!ec.truncated && ec.omitted.length > 0) {
      return { changed: false, changes: [], error: "exactChange cannot have omitted entries when truncated is false." };
    }
    // Patch byte limit: patch must not exceed configured maxPatchBytes.
    if (Buffer.byteLength(ec.patch, "utf8") > input.config.maxPatchBytes) {
      return { changed: false, changes: [], error: "exactChange.patch exceeds maxPatchBytes." };
    }
  }
  // Unified Git and raw baselines settle against one frozen after-checkpoint.
  // Legacy baselines retain their original fail-closed settlement paths.
  const checkpointBefore = typedCheckpointBaselineOf(input.before);
  const gitBefore = typedGitBaselineOf(input.before);
  const settled = checkpointBefore
    ? await settleCheckpointReview({ cwd: input.cwd, before: checkpointBefore, exchangeBefore: input.window?.activeExchange?.baseline, config: input.config, signal: input.signal, evidence: input.evidence })
    : gitBefore
    ? await settleGitReview({
        cwd: input.cwd,
        before: gitBefore,
        exchangeBefore: input.window?.activeExchange?.baseline,
        config: input.config,
        signal: input.signal,
      })
    : await settleSnapshotReview(input);
  try {
    return await runReviewSettled(input, settled);
  } finally {
    // No completed pass owns the frozen after-checkpoint on any earlier exit
    // (no-change, abort, error): release the ephemeral pin. A failed release
    // fails closed — it throws rather than hiding an orphaned pin.
    if (!settled.ownershipTransferred && settled.releaseOrphan) {
      await settled.releaseOrphan();
    }
  }
}

async function runReviewSettled(input: ReviewRunInput, settled: SettledBaseline): Promise<ReviewRunOutput> {
  const correctionAttemptCount = input.correctionAttemptCount ?? 0;
  const guidanceEscalation = buildGuidanceEscalation(input.config, correctionAttemptCount);
  const workspaceChanges = settled.workspaceChanges;
  const evidenceChanges = input.evidence
    ? await collectSettledEvidence(input.evidence, input.cwd, input.config, workspaceChanges, undefined, Boolean(settled.reviewedBaseline && settled.reviewedBaseline.kind !== "snapshot"), settled.frozenCandidateAfter, settled.evidenceRoot)
    : [];
  const split = splitReviewChanges(workspaceChanges, evidenceChanges);
  const { changes, sideEffectChanges } = split;

  // When exactChange is present with nonempty changedPaths, treat as reviewable
  // even if workspace snapshots show no content hash changes (e.g., mode-only or binary changes).
  const hasExactChanges = input.exactChange !== undefined && input.exactChange.changedPaths.length > 0;
  const exchangeSequence = input.window?.activeExchange?.sequence;
  const reviewResponseMode = input.window?.activeExchange?.reviewResponseMode;
  const exchangeWorkspaceChanges = settled.exchangeWorkspaceChanges;
  const exchangeEvidenceChanges = input.evidence && exchangeSequence !== undefined
    ? await collectSettledEvidence(input.evidence, input.cwd, input.config, exchangeWorkspaceChanges, exchangeSequence, Boolean(settled.reviewedBaseline && settled.reviewedBaseline.kind !== "snapshot"), settled.frozenCandidateAfter, settled.evidenceRoot)
    : evidenceChanges;
  const exchangeSplit = splitReviewChanges(exchangeWorkspaceChanges, exchangeEvidenceChanges);
  const exchangeWorkspacePatch = exchangeWorkspaceChanges.length > 0
    ? (settled.exchangePatch ?? buildUnifiedPatch(exchangeWorkspaceChanges, input.config.maxPatchBytes)).patch
    : "";
  const exchangeSideEffectPatch = exchangeSplit.sideEffectChanges.length > 0
    ? buildUnifiedPatch(exchangeSplit.sideEffectChanges, input.config.maxPatchBytes).patch
    : "";
  const completedExchange = input.window
    ? completeActiveExchange(input.window, {
      workspaceChanges: exchangeWorkspaceChanges,
      sideEffectChanges: exchangeSplit.sideEffectChanges,
      workspacePatch: exchangeWorkspacePatch,
      sideEffectPatch: exchangeSideEffectPatch,
      actingUsage: input.actingUsage,
    })
    : undefined;
  const exchangeHasReviewableChanges = exchangeWorkspaceChanges.length > 0 || exchangeSplit.sideEffectChanges.length > 0 || hasExactChanges;
  if ((reviewResponseMode === "observation" || reviewResponseMode === "deferred") && !exchangeHasReviewableChanges) {
    if (input.window?.bundleDir) {
      await syncReviewWindowArtifacts({
        dir: input.window.bundleDir,
        cwd: input.cwd,
        workspaceRoot: settled.evidenceRoot,
        currentReviewSequence: Math.max(1, input.window.nextReviewSequence - 1),
        exchanges: input.window.exchanges,
      });
    }
    return {
      changed: false,
      changes,
      noReviewReason: reviewResponseMode === "deferred"
        ? "unchanged_deferred_response"
        : "unchanged_review_response",
    };
  }
  const isCorrectionValidation = hasUnresolvedReview(input.window) || correctionAttemptCount > 0;
  if (changes.length === 0 && !isCorrectionValidation && !hasExactChanges) {
    return { changed: false, changes, noReviewReason: "no_initial_changes" };
  }

  // When exactChange is present, use the exact Git commit patch as authoritative.
  const patchResult = input.exactChange !== undefined
    ? {
        patch: input.exactChange.patch,
        truncated: input.exactChange.truncated,
        omitted: input.exactChange.omitted,
      }
    : workspaceChanges.length > 0
        ? (settled.windowPatch ?? buildUnifiedPatch(workspaceChanges, input.config.maxPatchBytes))
      : {
          patch: isCorrectionValidation
            ? "(no net submitted workspace changes; validate the current workspace against the prior review feedback)"
            : "(no submitted workspace changes detected; review captured side effects below)",
          truncated: false,
          omitted: [],
        };
  const sideEffectPatchResult = sideEffectChanges.length > 0
    ? buildUnifiedPatch(sideEffectChanges, input.config.maxPatchBytes)
    : { patch: "", truncated: false, omitted: [] };
  const { reviewers, unavailableResults } = resolveExecutableReviewers(input.config);
  if (reviewers.length === 0 && unavailableResults.length === 0) {
    return {
      changed: true,
      changes,
      error: "No reviewers configured.",
    };
  }
  const displayLabels = reviewerDisplayLabels(reviewers);

  const reviewSequence = input.window?.nextReviewSequence ?? 1;
  const bundle = await createReviewBundle({
    dir: input.window?.bundleDir,
    reviewSequence,
    exchanges: input.window?.exchanges,
    cwd: input.cwd,
    workspaceRoot: settled.evidenceRoot,
    request: input.request,
    submittedChanges: split.workspaceChanges,
    sideEffectChanges,
    patch: patchResult.patch,
    sideEffectPatch: sideEffectPatchResult.patch,
    snapshotOmissions: settled.snapshotOmissions,
    snapshotOmissionsTruncated: settled.snapshotOmissionsTruncated,
    evidence: input.evidence
      ? buildEvidenceBundle(
        input.evidence,
        evidenceChanges.map((change) => change.path),
        isCorrectionValidation && completedExchange
          ? {
              // Preserve the task-origin evidence plus the latest correction
              // exchange. Intermediate cycles remain available on disk, but do
              // not grow every correction prompt without bound.
              events: focusedCorrectionEvidence(
                input.window?.exchanges[0]?.evidenceEvents,
                completedExchange.evidenceEvents,
              ),
              finalAssistantSummaries: focusedCorrectionEvidence(
                input.window?.exchanges[0]?.assistantSummaries,
                completedExchange.assistantSummaries,
              ),
            }
          : undefined,
        settled.evidenceRoot ? { selectedCwd: input.cwd, workspaceRoot: settled.evidenceRoot } : undefined,
      )
      : undefined,
    actingUsage: input.actingUsage,
    guidanceEscalation,
    changeIdentity: input.changeIdentity,
    metadata: {
      exchangeSequence: input.window?.exchanges.at(-1)?.sequence,
      correctionAttemptCount,
      requireConcreteGuidance: guidanceEscalation !== undefined,
      implementationGuidanceThreshold: input.config.implementationGuidanceAfterCorrectionAttempts,
      patchTruncated: patchResult.truncated,
      omittedDiffs: patchResult.omitted,
      sideEffectPatchTruncated: sideEffectPatchResult.truncated,
      omittedSideEffectDiffs: sideEffectPatchResult.omitted,
      changeIdentity: input.changeIdentity,
      snapshotOmissions: settled.snapshotOmissions,
      snapshotOmissionsTruncated: settled.snapshotOmissionsTruncated,
      ...(input.exactChange !== undefined ? {
        exactChangedPaths: input.exactChange.changedPaths,
        exactPatchTruncated: input.exactChange.truncated,
        exactOmittedDiffs: input.exactChange.omitted,
      } : {}),
    },
  });
  registerBundleWithWindow(input.window, bundle.dir);
  await input.onInvocationPrepared?.();
  const invocation = await executeReviewerInvocation({
    reviewers,
    unavailableResults,
    bundle,
    cwd: input.cwd,
    config: input.config,
    window: input.window,
    signal: input.signal,
    reviewSequence,
    kind: "review",
    notify: input.notify,
    onUpdate: input.onUpdate,
  });
  if (invocation.aborted) {
    return abortedReviewOutput(changes, bundle.dir);
  }

    // A completed pass owns the frozen after-baseline. Handoff invariant:
    // the caller MUST record output.reviewedBaseline through
    // recordReviewerFeedbackAndArmExchange (or release its pin) before any
    // early return — a successful result's after-baseline is never dropped
    // unclaimed, and a later lifecycle slice owns save-before-release.
    // Every earlier exit leaves ownershipTransferred false and releases the
    // ephemeral pin above.
    settled.ownershipTransferred = true;
  return {
    changed: true,
    changes,
    result: invocation.result,
    reviewerResults: invocation.reviewerResults,
    reviewerDisplayLabels: displayLabels,
    bundleDir: bundle.dir,
    invocationDir: bundle.invocationDir,
    reviewSequence,
    reviewedBaseline: settled.reviewedBaseline,
    releaseReviewedBaseline: settled.releaseOrphan,
    bundleRetained: invocation.bundleRetained,
  };
}

export async function collectPausedReviewExchange(input: PausedExchangeInput): Promise<void> {
  const active = input.window.activeExchange;
  if (!active) {
    return;
  }
  // A typed exchange settles against one frozen ephemeral after-checkpoint;
  // this paused path always releases the after descriptor after artifacts.
  const checkpointBaseline = typedCheckpointBaselineOf(active.baseline);
  const gitBaseline = typedGitBaselineOf(active.baseline);
  if (checkpointBaseline || gitBaseline) {
    const settled = checkpointBaseline
      ? await settleCheckpointReview({ cwd: input.cwd, before: checkpointBaseline, config: input.config, evidence: input.evidence })
      : await settleGitReview({ cwd: input.cwd, before: gitBaseline!, config: input.config });
    try {
      const evidenceChanges = input.evidence
        ? await collectSettledEvidence(input.evidence, input.cwd, input.config, settled.workspaceChanges, active.sequence, true, settled.frozenCandidateAfter, settled.evidenceRoot)
        : [];
      const split = splitReviewChanges(settled.workspaceChanges, evidenceChanges);
      completeActiveExchange(input.window, {
        workspaceChanges: settled.workspaceChanges,
        sideEffectChanges: split.sideEffectChanges,
        workspacePatch: settled.windowPatch?.patch ?? "",
        sideEffectPatch: split.sideEffectChanges.length > 0
          ? buildUnifiedPatch(split.sideEffectChanges, input.config.maxPatchBytes).patch
          : "",
        actingUsage: input.actingUsage,
      });
      if (input.window.bundleDir) {
        await syncReviewWindowArtifacts({
          dir: input.window.bundleDir,
          cwd: input.cwd,
          workspaceRoot: settled.evidenceRoot,
          currentReviewSequence: Math.max(1, input.window.nextReviewSequence - 1),
          exchanges: input.window.exchanges,
        });
      }
    } catch (error) {
      // A failure after settling must not orphan the ephemeral pin either;
      // a failed release is reported alongside the original error.
      return rethrowAfterRelease(error, settled.releaseOrphan);
    }
    // Release the ephemeral after pin only after the exchange artifacts exist.
    await settled.releaseOrphan?.();
    return;
  }

  // #193: the paused-exchange settle capture reuses verified facts from the
  // exchange's own completed baseline when one exists; unchanged entries are
  // re-verified against the live entry and every retain/omit decision is
  // recomputed, so changes made after the baseline are fully inspected
  // exactly as a fresh capture would inspect them.
  const exchangeBaseline = snapshotOfReviewBaseline(active.baseline);
  const after = await createWorkspaceSnapshot(input.cwd, {
    maxFileBytes: input.config.maxFileBytes,
    maxSnapshotBytes: input.config.maxSnapshotBytes,
    reuseUnchangedFrom: exchangeBaseline,
  });
  const workspaceChanges = exchangeBaseline ? compareSnapshots(exchangeBaseline, after) : [];
  const evidenceChanges = input.evidence
    ? await collectEvidenceChanges(input.evidence, input.cwd, {
      maxFileBytes: input.config.maxFileBytes,
      maxSnapshotBytes: input.config.maxSnapshotBytes,
    }, active.sequence)
    : [];
  const split = splitReviewChanges(workspaceChanges, evidenceChanges);
  completeActiveExchange(input.window, {
    workspaceChanges,
    sideEffectChanges: split.sideEffectChanges,
    workspacePatch: workspaceChanges.length > 0
      ? buildUnifiedPatch(workspaceChanges, input.config.maxPatchBytes).patch
      : "",
    sideEffectPatch: split.sideEffectChanges.length > 0
      ? buildUnifiedPatch(split.sideEffectChanges, input.config.maxPatchBytes).patch
      : "",
    actingUsage: input.actingUsage,
  });
  if (input.window.bundleDir) {
    await syncReviewWindowArtifacts({
      dir: input.window.bundleDir,
      cwd: input.cwd,
      currentReviewSequence: Math.max(1, input.window.nextReviewSequence - 1),
      exchanges: input.window.exchanges,
    });
  }
}

export async function runAskReviewer(input: AskReviewerInput): Promise<AskReviewerOutput> {
  const validationError = input.changeIdentity !== undefined ? validateChangeIdentity(input.changeIdentity) : undefined;
  if (validationError) {
    return { changes: [], error: `Invalid changeIdentity: ${validationError}` };
  }
  // A reviewer question uses a frozen ephemeral after-checkpoint, releasing
  // it after artifacts are written without transferring window ownership.
  const collected = await collectCurrentChanges({
    cwd: input.cwd,
    before: input.before,
    config: input.config,
    evidence: input.evidence,
  });
  try {
    return await runAskReviewerSettled(input, collected);
  } finally {
    if (collected.releaseOrphan) {
      await collected.releaseOrphan();
    }
  }
}

async function runAskReviewerSettled(input: AskReviewerInput, collected: CurrentChanges): Promise<AskReviewerOutput> {
  const correctionAttemptCount = input.correctionAttemptCount ?? 0;
  const guidanceEscalation = buildGuidanceEscalation(input.config, correctionAttemptCount);
  const { changes, workspaceChanges, evidenceChanges, sideEffectChanges, snapshotOmissions, snapshotOmissionsTruncated } = collected;
  const patchResult = workspaceChanges.length > 0
    ? (collected.windowPatch ?? buildUnifiedPatch(workspaceChanges, input.config.maxPatchBytes))
    : { patch: input.before ? "(no file changes detected)" : "(no baseline available; answering from request context and session evidence)", truncated: false, omitted: [] };
  const sideEffectPatchResult = sideEffectChanges.length > 0
    ? buildUnifiedPatch(sideEffectChanges, input.config.maxPatchBytes)
    : { patch: "", truncated: false, omitted: [] };
  const { reviewers, unavailableResults } = resolveExecutableReviewers(input.config);
  if (reviewers.length === 0 && unavailableResults.length === 0) {
    return {
      changes,
      error: "No reviewers configured.",
    };
  }
  const displayLabels = reviewerDisplayLabels(reviewers);

  const reviewSequence = input.window?.nextReviewSequence ?? 1;
  const bundle = await createReviewerQuestionBundle({
    dir: input.window?.bundleDir,
    reviewSequence,
    exchanges: input.window?.exchanges,
    cwd: input.cwd,
    workspaceRoot: collected.evidenceRoot,
    question: input.question,
    request: input.request,
    submittedChanges: workspaceChanges,
    sideEffectChanges,
    patch: patchResult.patch,
    sideEffectPatch: sideEffectPatchResult.patch,
    snapshotOmissions,
    snapshotOmissionsTruncated,
    evidence: input.evidence
      ? buildEvidenceBundle(input.evidence, evidenceChanges.map((change) => change.path), undefined,
        collected.evidenceRoot ? { selectedCwd: input.cwd, workspaceRoot: collected.evidenceRoot } : undefined)
      : undefined,
    guidanceEscalation,
    changeIdentity: input.changeIdentity,
    metadata: {
      exchangeSequence: input.window?.exchanges.at(-1)?.sequence,
      correctionAttemptCount,
      requireConcreteGuidance: guidanceEscalation !== undefined,
      implementationGuidanceThreshold: input.config.implementationGuidanceAfterCorrectionAttempts,
      patchTruncated: patchResult.truncated,
      omittedDiffs: patchResult.omitted,
      sideEffectPatchTruncated: sideEffectPatchResult.truncated,
      omittedSideEffectDiffs: sideEffectPatchResult.omitted,
      changeIdentity: input.changeIdentity,
      snapshotOmissions,
      snapshotOmissionsTruncated,
    },
  });
  registerBundleWithWindow(input.window, bundle.dir);
  await input.onInvocationPrepared?.();
  const invocation = await executeReviewerInvocation({
    reviewers,
    unavailableResults,
    bundle,
    cwd: input.cwd,
    config: input.config,
    window: input.window,
    signal: input.signal,
    reviewSequence,
    kind: "reviewer question",
    notify: input.notify,
    onUpdate: input.onUpdate,
  });
  if (invocation.aborted) {
    return {
      changes,
      result: abortedResult(),
      reviewerDisplayLabels: displayLabels,
      bundleDir: bundle.dir,
      bundleRetained: false,
    };
  }

  return {
    changes,
    result: invocation.result,
    reviewerResults: invocation.reviewerResults,
    reviewerDisplayLabels: displayLabels,
    bundleDir: bundle.dir,
    bundleRetained: invocation.bundleRetained,
  };
}

function registerBundleWithWindow(window: ReviewWindow | undefined, bundleDir: string): void {
  if (window) {
    window.bundleDir = bundleDir;
    window.nextReviewSequence += 1;
  }
}

function focusedCorrectionEvidence<T>(initial: T[] | undefined, latest: T[]): T[] {
  if (!initial || initial === latest) return [...latest];
  return [...initial, ...latest];
}

async function executeReviewerInvocation(input: {
  reviewers: DeciderConfig[];
  /** Bounded error outcomes for selections that cannot be resolved; they are
   * aggregated with the staged results but never invoked. */
  unavailableResults?: ReviewResult[];
  bundle: ReviewBundle;
  cwd: string;
  config: ReviewGateConfig;
  window?: ReviewWindow;
  signal?: AbortSignal;
  reviewSequence: number;
  kind: "review" | "reviewer question";
  notify?: (message: string) => void | Promise<void>;
  onUpdate?: (message: string) => void;
}): Promise<
  | { aborted: true; bundleRetained: false }
  | { aborted: false; result: ReviewResult; reviewerResults: ReviewResult[]; bundleRetained: boolean }
> {
  const verb = input.kind === "review" ? "reviewing changes with" : "asking reviewers";
  const target = input.reviewers.length > 0
    ? input.reviewers.map(reviewerDisplayLabel).join(", ")
    : "(no resolvable reviewers; unavailable selections will be reported)";
  await input.notify?.(`review gate: ${verb} ${target}`);
  const sessionsBeforeReview = new Map(input.window?.reviewerSessions ?? []);
  // Reviewer passes are intentionally stateless. Complete prior evidence remains
  // available in the immutable bundle, without carrying model/tool history into
  // the next pass and forcing compaction.
  input.window?.reviewerSessions.clear();
  const stagedReviewers = await Promise.all(input.reviewers.map(async (reviewer) => {
    const label = reviewerDisplayLabel(reviewer);
    input.onUpdate?.(`${label} started`);
    const result = await runSingleReviewer({
      reviewer,
      cwd: input.cwd,
      prompt: input.bundle.prompt,
      bundlePrompt: input.bundle.bundlePrompt,
      bundleDir: input.bundle.dir,
      invocationDir: input.bundle.invocationDir,
      window: input.window,
      signal: input.signal,
      onUpdate: (message) => input.onUpdate?.(`${label} · ${message}`),
    });
    // Snapshot the identity of the configuration that actually ran this
    // reviewer so the result stays attributable even after the window's
    // configuration is reconciled to newer settings.
    if (result.result.displayLabel === undefined) {
      result.result.displayLabel = label;
    }
    stampReviewerIdentity(result.result, reviewer);
    input.onUpdate?.(`${label} finished · ${result.result.verdict}`);
    return result;
  }));
  const stagedResults = stagedReviewers.map((reviewer) => reviewer.result);
  if (reviewWasAborted(input.signal, stagedResults)) {
    await cleanupStagedReviewers(stagedReviewers);
    await recordCanceledInvocation(
      input.bundle.invocationDir,
      input.window,
      sessionsBeforeReview,
      input.reviewSequence,
      input.kind,
      input.signal,
    );
    return { aborted: true, bundleRetained: false };
  }
  // Unresolvable selections are aggregated with the staged results so every
  // configured reviewer has an explicit bounded outcome in the pass.
  const reviewerResults = [...stagedResults, ...(input.unavailableResults ?? [])];

  // Publish reviewer outputs as one completed set. Until this point each
  // reviewer writes outside the evidence bundle, so concurrently running
  // reviewers cannot inspect sibling results or runtime session streams.
  try {
    await publishStagedReviewerSet(
      stagedReviewers,
      input.bundle.invocationDir,
      reviewerDisplayLabels(input.reviewers),
    );
  } catch (error) {
    await cleanupStagedReviewers(stagedReviewers);
    const message = error instanceof Error ? error.message : "Reviewer artifact publication failed.";
    const publicationFailure: ReviewResult = {
      reviewerId: "gate",
      verdict: "error",
      summary: "Reviewer results could not be published atomically.",
      findings: [],
      error: "artifact_publication_failed",
      diagnostic: message,
    };
    if (input.window) input.window.retainBundleAfterClose = true;
    return { aborted: false, result: publicationFailure, reviewerResults: [publicationFailure], bundleRetained: true };
  }

  const result = decideReviewResults(reviewerResults);
  const telemetryPublications = await Promise.allSettled([
    writeFile(join(input.bundle.invocationDir, "reviewer-usage.json"), JSON.stringify(result.usage ?? null, null, 2), "utf8"),
    writeFile(join(input.bundle.invocationDir, "review-telemetry.json"), JSON.stringify({
      version: 1,
      reviewSequence: input.reviewSequence,
      reviewers: reviewerResults.map((reviewerResult) => ({
        reviewerId: reviewerResult.reviewerId,
        verdict: reviewerResult.verdict,
        usage: reviewerResult.usage ? omitRawUsage(reviewerResult.usage) : undefined,
        telemetry: reviewerResult.telemetry,
      })),
    }, null, 2), "utf8"),
    writeFile(join(input.bundle.dir, "sessions.json"), JSON.stringify(
      Object.fromEntries(input.window?.reviewerSessions ?? []),
      null,
      2,
    ), "utf8"),
  ]);
  const telemetryFailures = telemetryPublications
    .filter((publication): publication is PromiseRejectedResult => publication.status === "rejected")
    .map((publication) => publication.reason instanceof Error ? publication.reason.message : String(publication.reason));
  if (telemetryFailures.length > 0) {
    result.diagnostic = [result.diagnostic, `Artifact telemetry publication failed: ${telemetryFailures.join("; ")}`]
      .filter(Boolean)
      .join("\n");
    if (input.window) input.window.retainBundleAfterClose = true;
  }

  const bundleRetained = telemetryFailures.length > 0 || shouldRetainBundle(input.config, result, reviewerResults);
  if (input.window) {
    input.window.retainBundleAfterClose ||= bundleRetained;
  } else if (!bundleRetained) {
    await removeReviewBundle(input.bundle.dir);
  }
  return { aborted: false, result, reviewerResults, bundleRetained };
}

async function runSingleReviewer(input: {
  reviewer: DeciderConfig;
  cwd: string;
  prompt: string;
  bundlePrompt: string;
  bundleDir: string;
  invocationDir: string;
  window?: ReviewWindow;
  signal?: AbortSignal;
  onUpdate?: (message: string) => void;
}): Promise<StagedReviewerResult> {
  const finalReviewerDir = join(input.invocationDir, "reviewers", safePathSegment(input.reviewer.id));
  const reviewerDir = await mkdtemp(join(tmpdir(), "pi-review-gate-reviewer-"));
  const startedAt = Date.now();
  const startedAtIso = new Date(startedAt).toISOString();
  let session: ReviewerSession | undefined;
  let result: ReviewResult;
  let artifactError: string | undefined;
  try {
    const adapter = createAdapter(input.reviewer);
    result = await adapter.run({
      id: input.reviewer.id,
      cwd: input.cwd,
      prompt: input.reviewer.adapter === "generic-cli" ? input.prompt : input.bundlePrompt,
      evidenceBundleDir: input.bundleDir,
      bundleDir: reviewerDir,
      timeoutMs: input.reviewer.timeoutMs ?? 300_000,
      signal: input.signal,
      session: undefined,
      onSession: (nextSession) => { session = nextSession; },
      onUpdate: input.onUpdate,
    });
  } catch (error) {
    artifactError = error instanceof Error ? error.message : "artifact write failed";
    result = {
      reviewerId: input.reviewer.id,
      verdict: "error",
      summary: error instanceof Error ? error.message : "Reviewer failed.",
      findings: [],
      error: error instanceof Error ? error.message : "review_failed",
    };
  }
  const durationMs = Date.now() - startedAt;
  result.telemetry = {
    ...result.telemetry,
    startedAt: startedAtIso,
    durationMs,
    promptBytes: Buffer.byteLength(input.reviewer.adapter === "generic-cli" ? input.prompt : input.bundlePrompt, "utf8"),
    sessionResumed: false,
    restartedAfterResumeFailure: false,
  };
  if (result.rawOutputPath) {
    result.rawOutputPath = join(finalReviewerDir, basename(result.rawOutputPath));
  }
  // Review passes are fresh, so runtime session history is neither needed for
  // continuation nor valid evidence for this or later reviewers.
  await rm(join(reviewerDir, "session"), { recursive: true, force: true });
  try {
    await Promise.all([
      writeFile(join(reviewerDir, "parsed-result.json"), JSON.stringify(result, null, 2), "utf8"),
      writeFile(join(reviewerDir, "reviewer-usage.json"), JSON.stringify(result.usage ?? null, null, 2), "utf8"),
      writeFile(join(reviewerDir, "invocation.json"), JSON.stringify({
        reviewerId: input.reviewer.id,
        adapter: input.reviewer.adapter,
        resumed: false,
        restartedAfterResumeFailure: false,
        durationMs,
        promptBytes: result.telemetry.promptBytes,
        telemetry: result.telemetry,
        session: session ?? null,
      }, null, 2), "utf8"),
    ]);
  } catch (error) {
    result = {
      reviewerId: input.reviewer.id,
      verdict: "error",
      summary: "Reviewer artifacts could not be written completely.",
      findings: [],
      error: "artifact_write_failed",
      diagnostic: artifactError,
      telemetry: result.telemetry,
    };
    await writeFile(join(reviewerDir, "parsed-result.json"), JSON.stringify(result, null, 2), "utf8").catch(() => undefined);
  }
  return { result, stagingDir: reviewerDir, finalDir: finalReviewerDir, artifactError };
}

interface StagedReviewerResult {
  result: ReviewResult;
  stagingDir: string;
  finalDir: string;
  artifactError?: string;
}

async function publishStagedReviewerSet(
  stagedReviewers: StagedReviewerResult[],
  invocationDir: string,
  displayLabels: Record<string, string>,
): Promise<void> {
  const incomplete = stagedReviewers.filter((reviewer) => reviewer.artifactError);
  if (incomplete.length > 0) {
    throw new Error(incomplete.map((reviewer) =>
      `${displayLabels[reviewer.result.reviewerId] ?? reviewer.result.reviewerId}: ${reviewer.artifactError}`).join("; "));
  }
  const finalRoot = join(invocationDir, "reviewers");
  const stagedRoot = await mkdtemp(join(invocationDir, ".reviewers-"));
  try {
    for (const staged of stagedReviewers) {
      const target = join(stagedRoot, basename(staged.finalDir));
      try {
        await rename(staged.stagingDir, target);
      } catch (error) {
        if (!isCrossDeviceRename(error)) throw error;
        await cp(staged.stagingDir, target, { recursive: true });
        await rm(staged.stagingDir, { recursive: true, force: true });
      }
    }
    await writeFile(join(stagedRoot, ".complete"), "complete\n", "utf8");
    await rm(finalRoot, { recursive: true, force: true });
    await rename(stagedRoot, finalRoot);
  } catch (error) {
    await rm(stagedRoot, { recursive: true, force: true });
    throw error;
  }
}

async function cleanupStagedReviewers(stagedReviewers: StagedReviewerResult[]): Promise<void> {
  await Promise.all(stagedReviewers.map((staged) =>
    rm(staged.stagingDir, { recursive: true, force: true })));
}

function isCrossDeviceRename(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "EXDEV";
}

function decideReviewResults(results: ReviewResult[]): ReviewResult {
  if (results.length === 1 && results[0]) {
    return results[0];
  }
  const needsChanges = results.filter((result) => result.verdict === "needs_changes");
  const errors = results.filter((result) => result.verdict === "error");
  const usage = aggregateUsage(results);
  if (needsChanges.length > 0) {
    return {
      reviewerId: "gate",
      verdict: "needs_changes",
      summary: reviewerVerdictSummary(results),
      findings: needsChanges.flatMap((result) => result.findings.map((finding) => ({
        ...finding,
        reviewerId: result.reviewerId,
      }))),
      usage,
      error: errors.length > 0 ? "partial_reviewer_error" : undefined,
    };
  }
  const aggregate = aggregateReviewDisposition(results);
  if (aggregate === "pass" || aggregate === "pass_with_warnings") {
    return {
      reviewerId: "gate",
      verdict: "pass",
      summary: reviewerVerdictSummary(results),
      findings: results.filter((result) => result.verdict === "pass").flatMap((result) =>
        result.findings.map((finding) => ({ ...finding, reviewerId: result.reviewerId }))),
      usage,
      error: aggregate === "pass_with_warnings" ? "partial_reviewer_error" : undefined,
    };
  }
  if (errors.length > 0) {
    return {
      reviewerId: "gate",
      verdict: "error",
      summary: reviewerVerdictSummary(results),
      findings: [],
      usage,
      error: errors.every((result) => result.error === "aborted") ? "aborted" : "reviewer_error",
    };
  }
  throw new Error("review aggregation produced no disposition");
}

function shouldRetainBundle(
  config: ReviewGateConfig,
  result: ReviewResult,
  reviewerResults: ReviewResult[],
): boolean {
  if (config.retainBundles === "always") {
    return true;
  }
  if (config.retainBundles !== "on-failure") {
    return false;
  }
  return result.verdict === "error" || reviewerResults.some((reviewerResult) => reviewerResult.verdict === "error");
}

function reviewerVerdictSummary(results: ReviewResult[]): string {
  const counts = new Map<ReviewResult["verdict"], number>();
  for (const result of results) {
    counts.set(result.verdict, (counts.get(result.verdict) ?? 0) + 1);
  }
  return (["needs_changes", "pass", "error"] as const)
    .filter((verdict) => counts.has(verdict))
    .map((verdict) => `${counts.get(verdict)} ${verdict}`)
    .join(", ");
}

function omitRawUsage(usage: TokenUsage): Omit<TokenUsage, "raw"> {
  const { raw: _raw, ...summary } = usage;
  return summary;
}

function reviewWasAborted(signal: AbortSignal | undefined, results: ReviewResult[]): boolean {
  return Boolean(signal?.aborted || results.some((result) => result.error === "aborted"));
}

async function recordCanceledInvocation(
  invocationDir: string,
  window: ReviewWindow | undefined,
  sessionsBeforeReview: Map<string, ReviewerSession>,
  reviewSequence: number,
  kind: "review" | "reviewer question",
  signal: AbortSignal | undefined,
): Promise<void> {
  await rm(invocationDir, { recursive: true, force: true });
  await mkdir(invocationDir, { recursive: true });
  const canceledAt = new Date().toISOString();
  const canceledBy = signal?.reason === "escape" || signal?.reason === "manual" ? "user" : "session";
  const summary = canceledBy === "user"
    ? `A ${kind} would have been run here but was canceled by the user.`
    : `A ${kind} would have been run here but was canceled with the active session.`;
  await Promise.all([
    writeFile(join(invocationDir, "CANCELED.md"), `${summary}\n`, "utf8"),
    writeFile(join(invocationDir, "canceled.json"), JSON.stringify({
      reviewSequence,
      kind,
      canceledAt,
      canceledBy,
      summary,
    }, null, 2), "utf8"),
  ]);
  if (window) {
    window.reviewerSessions.clear();
    for (const [reviewerId, session] of sessionsBeforeReview) {
      window.reviewerSessions.set(reviewerId, session);
    }
  }
}

function abortedResult(): ReviewResult {
  return {
    reviewerId: "gate",
    verdict: "error",
    summary: "Review aborted.",
    findings: [],
    error: "aborted",
  };
}

function abortedReviewOutput(changes: ChangedFile[], bundleDir: string): ReviewRunOutput {
  return {
    changed: true,
    changes,
    result: abortedResult(),
    bundleDir,
    bundleRetained: false,
  };
}

function buildGuidanceEscalation(
  config: ReviewGateConfig,
  correctionAttemptCount = 0,
): { correctionAttemptCount: number; threshold: number } | undefined {
  const threshold = config.implementationGuidanceAfterCorrectionAttempts;
  return correctionAttemptCount >= threshold ? { correctionAttemptCount, threshold } : undefined;
}

function aggregateUsage(results: ReviewResult[]): ReviewResult["usage"] {
  const usages = results.map((result) => result.usage).filter((usage) => usage !== undefined);
  if (usages.length === 0) {
    return undefined;
  }
  return {
    scope: "invocation",
    inputTokens: sumUsage(usages, "inputTokens"),
    totalInputTokens: sumUsage(usages, "totalInputTokens"),
    uncachedInputTokens: sumUsage(usages, "uncachedInputTokens"),
    cachedInputTokens: sumUsage(usages, "cachedInputTokens"),
    outputTokens: sumUsage(usages, "outputTokens"),
    reasoningOutputTokens: sumUsage(usages, "reasoningOutputTokens"),
    cacheWriteTokens: sumUsage(usages, "cacheWriteTokens"),
    totalTokens: sumUsage(usages, "totalTokens"),
    costTotal: sumUsage(usages, "costTotal"),
    raw: Object.fromEntries(results.map((result) => [result.reviewerId, result.usage?.raw ?? result.usage ?? null])),
  };
}

function sumUsage(usages: Array<NonNullable<ReviewResult["usage"]>>, key: keyof NonNullable<ReviewResult["usage"]>): number | undefined {
  let found = false;
  let total = 0;
  for (const usage of usages) {
    const value = usage[key];
    if (typeof value === "number") {
      found = true;
      total += value;
    }
  }
  return found ? total : undefined;
}

/**
 * Resolve the reviewers an invocation will actually run, plus explicit bounded
 * error outcomes for selections that cannot be resolved from the current
 * configuration. Removed or renamed reviewers are never resurrected: a stale
 * selection becomes a visible `reviewer_unavailable` result while every
 * resolvable reviewer still runs. Duplicated selections run once.
 */
function resolveExecutableReviewers(config: ReviewGateConfig): {
  reviewers: DeciderConfig[];
  unavailableResults: ReviewResult[];
} {
  const resolution = resolveReviewers(config);
  const seen = new Set<string>();
  const reviewers: DeciderConfig[] = [];
  for (const reviewer of resolution.reviewers) {
    if (seen.has(reviewer.id)) continue;
    seen.add(reviewer.id);
    reviewers.push(reviewer);
  }
  // The frozen config materializes only the resolvable subset, so unresolvable
  // selections are also remembered beside it at freeze time. Merge both
  // sources (deduplicated) so every configured reviewer has an explicit
  // bounded outcome without ever being invoked. Keying by the config object
  // keeps an in-flight invocation bound to the selection it started with.
  const unavailable = new Map<string, ReviewResult>();
  for (const selection of [...resolution.unknownIds, ...unresolvedReviewerSelectionsFor(config)]) {
    if (unavailable.has(selection)) continue;
    unavailable.set(selection, {
      reviewerId: selection,
      verdict: "error",
      summary: `Reviewer selection ${selection} is not available in the current configuration and was not run.`,
      findings: [],
      error: "reviewer_unavailable",
    });
  }
  return { reviewers, unavailableResults: [...unavailable.values()] };
}

/**
 * Stamp gate-owned identity metadata on a freshly produced result from the
 * actual invocation configuration. Only safe values cross into persisted
 * metadata: the adapter name and a one-way fingerprint of the effective
 * reviewer config (command, args, env, and credentials are hashed internally,
 * never stored). Already-stamped values are preserved; results without an
 * invocation configuration (unavailable selections, gate aggregates) stay
 * honestly unattributed rather than inheriting a current-configuration guess.
 */
function stampReviewerIdentity(result: ReviewResult, reviewer: DeciderConfig): void {
  if (result.reviewerAdapter === undefined) result.reviewerAdapter = reviewer.adapter;
  if (result.reviewerConfigFingerprint === undefined) {
    result.reviewerConfigFingerprint = reviewerConfigFingerprint(reviewer);
  }
}

function safePathSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9_.-]+/g, "_") || "reviewer";
}

function createAdapter(decider: DeciderConfig): ModelAdapter {
  if (decider.adapter === "generic-cli") {
    return new GenericCliAdapter(decider);
  }
  if (decider.adapter === "codex-cli") {
    return new CodexCliAdapter(decider);
  }
  if (decider.adapter === "claude-cli") {
    return new ClaudeCliAdapter(decider);
  }
  if (decider.adapter === "pi-model") {
    return new PiModelAdapter(decider);
  }

  throw new Error("unsupported reviewer adapter");
}

// ---------------------------------------------------------------------------
// #193 slice D: baseline settle — one frozen "after" per review run.
//
// A Git checkpoint baseline settles through exactly ONE new checkpoint armed
// for this run: the before descriptor is verified (pin present, record
// digest intact) BEFORE arming, and both the window and the active-exchange
// comparisons are made frozen-to-frozen against that single after descriptor.
// No full-root workspace snapshot is taken and the live state is never
// inspected twice. Every Git uncertainty fails closed with a descriptive
// error instead of falling back to a synthetic snapshot. Legacy snapshot
// inputs keep the existing settle semantics unchanged.

interface SettledBaseline {
  /** Root used by the checkpoint and its repository-relative change paths. */
  evidenceRoot?: string;
  /** Candidate values captured once before arming the frozen after-checkpoint. */
  frozenCandidateAfter?: Map<string, FileSnapshot>;
  /** Changes against the review's own `before` baseline (window view). */
  workspaceChanges: ChangedFile[];
  /** Changes against the active exchange baseline, or the window view when there is no distinct exchange baseline. */
  exchangeWorkspaceChanges: ChangedFile[];
  /** Changed-only patch for the window view, under the configured limits. */
  windowPatch?: PatchBuildResult;
  /** Changed-only patch for the exchange view (present only when the exchange baseline is distinct). */
  exchangePatch?: PatchBuildResult;
  snapshotOmissions: SnapshotOmission[];
  snapshotOmissionsTruncated: boolean;
  /** True once a completed pass owns the after-baseline (ownership transferred to the window state). */
  ownershipTransferred: boolean;
  /** The frozen after-baseline; recorded on the window state when a completed pass transfers ownership. */
  reviewedBaseline?: ReviewBaseline;
  /** Releases the ephemeral after-checkpoint pin (Git only). Throws on failure — never hides an orphaned pin. */
  releaseOrphan?: () => Promise<void>;
}

function typedCheckpointBaselineOf(value: WorkspaceSnapshot | ReviewBaseline | undefined): UnifiedReviewBaseline | null {
  return isReviewBaseline(value) && value.kind === "checkpoint" ? value : null;
}

function typedGitBaselineOf(value: WorkspaceSnapshot | ReviewBaseline | undefined): GitCheckpointBaseline | null {
  return isReviewBaseline(value) && value.kind === "git" ? value : null;
}

function legacySnapshotOf(value: WorkspaceSnapshot | ReviewBaseline): WorkspaceSnapshot {
  const baseline = isReviewBaseline(value)
    ? (value.kind === "snapshot" ? value.snapshot : undefined)
    : value;
  if (!baseline) {
    throw new Error("review gate: a typed Git checkpoint baseline cannot be treated as a workspace snapshot");
  }
  return baseline;
}

function sameCheckpoint(a: ReviewCheckpointDescriptor, b: ReviewCheckpointDescriptor): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function checkpointFailure(context: string, result: { reason?: string; detail?: string }): Error {
  return new Error(`review gate: ${context} failed (${result.reason ?? "unknown"}): ${result.detail ?? "checkpoint unavailable"}; refusing snapshot fallback`);
}

async function releaseCheckpoint(cwd: string, descriptor: ReviewCheckpointDescriptor): Promise<void> {
  const result = await releaseReviewCheckpoint(cwd, descriptor);
  if (result.status !== "ok") throw checkpointFailure("releasing after-checkpoint", result);
}

/** Render only changed entries from two frozen checkpoint records. */
function checkpointDelta(changes: ReviewCheckpointChange[], config: ReviewGateConfig): { changes: ChangedFile[]; patch: PatchBuildResult } {
  let retained = 0;
  const rendered = changes.map(({ path, old, new: next }) => {
    const content = (entry: ReviewCheckpointState | undefined): { text?: string; reason?: string } => {
      if (!entry) return {};
      const bytes = entry.kind === "symlink" ? Buffer.from(entry.target!) : entry.bytes!;
      if (entry.kind === "file" && looksBinary(bytes, bytes.length > BINARY_SAMPLE_BYTES)) return { reason: "binary" };
      if (bytes.length > config.maxFileBytes) return { reason: "oversized" };
      return { text: bytes.toString("utf8") };
    };
    const left = content(old), right = content(next);
    const required = Buffer.byteLength(left.text ?? "") + Buffer.byteLength(right.text ?? "");
    let reason = left.reason ?? right.reason;
    if (!reason && required > config.maxSnapshotBytes - retained) reason = "snapshot_limit";
    if (!reason) retained += required;
    const mode = (entry: ReviewCheckpointState | undefined) => entry && (entry.kind === "symlink" ? "120000" : `100${(entry.mode & 0o777).toString(8).padStart(3, "0")}`);
    return {
      path, status: !old ? "added" as const : !next ? "deleted" as const : "modified" as const,
      binary: left.reason === "binary" || right.reason === "binary",
      oversized: left.reason === "oversized" || right.reason === "oversized",
      oldGitMode: mode(old), newGitMode: mode(next),
      ...(reason ? { diffOmittedReason: reason } : { oldContent: left.text, newContent: right.text }),
    };
  });
  return { changes: rendered, patch: buildUnifiedPatch(rendered, config.maxPatchBytes) };
}

async function settleCheckpointReview(input: {
  cwd: string; before: UnifiedReviewBaseline; exchangeBefore?: ReviewBaseline;
  config: ReviewGateConfig; signal?: AbortSignal; evidence?: EvidenceState;
}): Promise<SettledBaseline> {
  const { cwd, before, config } = input;
  const options = input.signal ? { signal: input.signal } : {};
  if (before.cwd !== cwd) throw new Error("review gate: checkpoint baseline root mismatch");
  const exchange = input.exchangeBefore;
  if (exchange && (exchange.kind !== "checkpoint" || exchange.cwd !== cwd)) throw new Error("review gate: mixed or wrong-root exchange baseline");
  for (const descriptor of [before.descriptor, ...(exchange && !sameCheckpoint(exchange.descriptor, before.descriptor) ? [exchange.descriptor] : [])]) {
    const loaded = await loadReviewCheckpoint(cwd, descriptor, options);
    if (loaded.status !== "ok") throw checkpointFailure("verifying baseline", loaded);
  }
  const checkpointRoot = before.descriptor.kind === "git"
    ? await reviewCheckpointWorkspaceRoot(cwd, before.descriptor)
    : resolve(cwd);
  const evidenceRoot = before.descriptor.kind === "git" ? checkpointRoot : undefined;
  // Freeze in-root evidence candidates before the checkpoint. Included paths
  // use the checkpoint's authoritative changed entries; only excluded paths
  // (e.g. Git-ignored files) use this separately captured after-value. This
  // map is shared by the window and exchange comparisons, never reread later.
  const frozenCandidateAfter = new Map<string, FileSnapshot>();
  const root = resolve(checkpointRoot);
  for (const candidate of input.evidence?.candidates.values() ?? []) {
    const path = relative(root, resolve(candidate.absolutePath));
    if (!path || isAbsolute(path) || path === ".." || path.startsWith(`..${sep}`)) continue;
    try {
      frozenCandidateAfter.set(candidate.absolutePath, await createPathSnapshot(checkpointRoot, candidate.absolutePath, {
        maxFileBytes: config.maxFileBytes, maxSnapshotBytes: config.maxSnapshotBytes, ...options,
      }));
    } catch (error) {
      if (input.signal?.aborted) throw error;
    }
  }
  const captured = await captureReviewCheckpoint(cwd, randomUUID(), options);
  if (captured.status !== "ok") throw checkpointFailure("capturing after-checkpoint", captured);
  const descriptor = captured.value;
  const releaseOrphan = () => releaseCheckpoint(cwd, descriptor);
  try {
    const windowResult = await compareReviewCheckpoints(cwd, before.descriptor, descriptor, options);
    if (windowResult.status !== "ok") throw checkpointFailure("comparing window", windowResult);
    const windowDelta = checkpointDelta(windowResult.value.changes, config);
    let exchangeDelta = windowDelta;
    if (exchange && !sameCheckpoint(exchange.descriptor, before.descriptor)) {
      const result = await compareReviewCheckpoints(cwd, exchange.descriptor, descriptor, options);
      if (result.status !== "ok") throw checkpointFailure("comparing exchange", result);
      exchangeDelta = checkpointDelta(result.value.changes, config);
    }
    return {
      workspaceChanges: windowDelta.changes, exchangeWorkspaceChanges: exchangeDelta.changes,
      windowPatch: windowDelta.patch, exchangePatch: exchangeDelta.patch,
      snapshotOmissions: [], snapshotOmissionsTruncated: false, ownershipTransferred: false,
      reviewedBaseline: { kind: "checkpoint", descriptor, cwd, capturedAt: new Date().toISOString() },
      evidenceRoot,
      frozenCandidateAfter,
      releaseOrphan,
    };
  } catch (error) { return rethrowAfterRelease(error, releaseOrphan); }
}

function sameGitDescriptor(a: GitCheckpointDescriptor, b: GitCheckpointDescriptor): boolean {
  return (
    a.format === b.format &&
    a.windowId === b.windowId &&
    a.armId === b.armId &&
    a.gitDir === b.gitDir &&
    a.base === b.base &&
    a.ref === b.ref &&
    a.objectFormat === b.objectFormat &&
    a.digest === b.digest
  );
}

function gitReviewFailure(context: string, outcome: { reason?: string; detail?: string }): Error {
  const reason = outcome.reason ? ` (${outcome.reason})` : "";
  const detail = outcome.detail ? `: ${outcome.detail}` : "";
  return new Error(
    `review gate: ${context} failed${reason}${detail}; refusing to fall back to a workspace snapshot`,
  );
}

async function releaseGitReviewPin(cwd: string, descriptor: GitCheckpointDescriptor): Promise<void> {
  const outcome = await releaseGitCheckpointPin(cwd, descriptor.windowId, {
    expectedBase: descriptor.base,
    armId: descriptor.armId,
  });
  if (outcome.status === "ok") return;
  const reason = outcome.reason ?? "unknown";
  throw new Error(
    `review gate: failed to release the ephemeral Git after-checkpoint pin (${reason}); the pin was left in place for manual recovery`,
  );
}

/**
 * Releases an ephemeral Git after-checkpoint pin and then rethrows the
 * original error; a failed release is reported alongside it instead of hiding
 * either failure. Never returns normally.
 */
async function rethrowAfterRelease(error: unknown, release?: () => Promise<void>): Promise<never> {
  if (release) {
    try {
      await release();
    } catch (releaseError) {
      const original = error instanceof Error ? error.message : String(error);
      const releaseMessage = releaseError instanceof Error ? releaseError.message : String(releaseError);
      throw new Error(
        `${original}; additionally failed to release the ephemeral after-checkpoint: ${releaseMessage}`,
      );
    }
  }
  throw error;
}

async function settleGitReview(input: {
  cwd: string;
  before: GitCheckpointBaseline;
  exchangeBefore?: ReviewBaseline;
  config: ReviewGateConfig;
  signal?: AbortSignal;
}): Promise<SettledBaseline> {
  const { cwd, before, config, signal } = input;
  const options = signal ? { signal } : undefined;
  // Verify every distinct before descriptor BEFORE arming the after
  // checkpoint: a missing pin or corrupted record fails closed with no new
  // state created.
  const beforeLoaded = await loadGitCheckpoint(cwd, before.descriptor, options);
  if (beforeLoaded.status !== "ok") {
    throw gitReviewFailure("verifying the Git review baseline", beforeLoaded);
  }
  const exchangeBaseline = input.exchangeBefore?.kind === "git" ? input.exchangeBefore : undefined;
  if (exchangeBaseline && !sameGitDescriptor(exchangeBaseline.descriptor, before.descriptor)) {
    const exchangeLoaded = await loadGitCheckpoint(cwd, exchangeBaseline.descriptor, options);
    if (exchangeLoaded.status !== "ok") {
      throw gitReviewFailure("verifying the Git exchange baseline", exchangeLoaded);
    }
  }
  // Arm exactly ONE new checkpoint with a unique safe per-generation id.
  const windowId = randomUUID();
  const armed = await armGitCheckpoint(cwd, windowId, options ?? {});
  if (armed.status !== "ok") {
    throw gitReviewFailure("arming the Git after-checkpoint", armed);
  }
  const afterDescriptor = armed.value.descriptor;
  const releaseOrphan = (): Promise<void> => releaseGitReviewPin(cwd, afterDescriptor);
  try {
    // Frozen-to-frozen window comparison against the single after descriptor.
    const windowReport = await compareGitCheckpoints(cwd, before.descriptor, afterDescriptor, options ?? {}, true);
    if (windowReport.status !== "ok") {
      throw gitReviewFailure("comparing the Git review baseline to the frozen after-checkpoint", windowReport);
    }
    // buildGitReviewDelta is a documented fail-closed thrower (invalid limits,
    // malformed comparison report, duplicate changed path); the catch below
    // reclaims the freshly armed pin for any such post-arm failure.
    const windowDelta = buildGitReviewDelta(windowReport.value, {
      maxFileBytes: config.maxFileBytes,
      maxSnapshotBytes: config.maxSnapshotBytes,
      maxPatchBytes: config.maxPatchBytes,
    });

    // The active exchange is compared against the SAME frozen after descriptor;
    // when it shares the window baseline the already-computed delta is reused.
    let exchangeWorkspaceChanges = windowDelta.changes;
    let exchangePatch: PatchBuildResult | undefined;
    if (exchangeBaseline && !sameGitDescriptor(exchangeBaseline.descriptor, before.descriptor)) {
      const exchangeReport = await compareGitCheckpoints(cwd, exchangeBaseline.descriptor, afterDescriptor, options ?? {}, true);
      if (exchangeReport.status !== "ok") {
        throw gitReviewFailure("comparing the Git exchange baseline to the frozen after-checkpoint", exchangeReport);
      }
      const exchangeDelta = buildGitReviewDelta(exchangeReport.value, {
        maxFileBytes: config.maxFileBytes,
        maxSnapshotBytes: config.maxSnapshotBytes,
        maxPatchBytes: config.maxPatchBytes,
      });
      exchangeWorkspaceChanges = exchangeDelta.changes;
      exchangePatch = exchangeDelta.patch;
    }

    const reviewedBaseline: GitCheckpointBaseline = {
      kind: "git",
      descriptor: afterDescriptor,
      cwd,
      capturedAt: new Date().toISOString(),
    };
    return {
      workspaceChanges: windowDelta.changes,
      exchangeWorkspaceChanges,
      windowPatch: windowDelta.patch,
      exchangePatch,
      // The checkpoint is complete by construction; there are no snapshot
      // omissions to report for a verified Git baseline.
      snapshotOmissions: [],
      snapshotOmissionsTruncated: false,
      ownershipTransferred: false,
      reviewedBaseline,
      releaseOrphan,
    };
  } catch (error) {
    // Any post-arm failure must never orphan the freshly armed pin; a failed
    // release is reported alongside the original error instead of hiding it.
    return rethrowAfterRelease(error, releaseOrphan);
  }
}

async function settleSnapshotReview(input: ReviewRunInput): Promise<SettledBaseline> {
  const before = legacySnapshotOf(input.before);
  // #193: the settle capture reuses verified facts from the newest completed
  // same-root baseline this run already holds — the active exchange's
  // baseline (the prior settle's reviewed snapshot) when present, otherwise
  // the review's own `before` baseline. Only completed captures are ever
  // passed; the helper still enumerates and stats every current path,
  // re-verifies each reused record against the live entry without following
  // symlinks, and recomputes every retain/omit decision against the current
  // limits, so paths changed between that baseline and settle are fully
  // inspected exactly as a fresh capture would inspect them.
  const exchangeBaseline = input.window?.activeExchange?.baseline;
  if (exchangeBaseline && isReviewBaseline(exchangeBaseline) && exchangeBaseline.kind === "git") {
    // A mixed-kind window state would make the next restore fail closed; a
    // snapshot settle must not silently ignore the Git exchange baseline.
    throw new Error(
      "review gate: a Git exchange baseline cannot be settled through the workspace-snapshot pipeline; refusing to fall back to a synthetic snapshot",
    );
  }
  const exchangeBefore = exchangeBaseline && isReviewBaseline(exchangeBaseline)
    ? (exchangeBaseline.kind === "snapshot" ? exchangeBaseline.snapshot : undefined)
    : undefined;
  const after = await createWorkspaceSnapshot(input.cwd, {
    maxFileBytes: input.config.maxFileBytes,
    maxSnapshotBytes: input.config.maxSnapshotBytes,
    reuseUnchangedFrom: exchangeBefore ?? before,
  });
  const workspaceChanges = compareSnapshots(before, after);
  const exchangeWorkspaceChanges = exchangeBefore ? compareSnapshots(exchangeBefore, after) : workspaceChanges;
  return {
    workspaceChanges,
    exchangeWorkspaceChanges,
    snapshotOmissions: after.omissions,
    snapshotOmissionsTruncated: after.omissionsTruncated,
    ownershipTransferred: false,
    reviewedBaseline: { kind: "snapshot", snapshot: after },
  };
}

interface CurrentChanges {
  evidenceRoot?: string;
  changes: ChangedFile[];
  workspaceChanges: ChangedFile[];
  evidenceChanges: ChangedFile[];
  sideEffectChanges: ChangedFile[];
  windowPatch?: PatchBuildResult;
  snapshotOmissions: SnapshotOmission[];
  snapshotOmissionsTruncated: boolean;
  releaseOrphan?: () => Promise<void>;
}

async function collectCurrentChanges(input: {
  cwd: string;
  before?: WorkspaceSnapshot | ReviewBaseline;
  config: ReviewGateConfig;
  evidence?: EvidenceState;
}): Promise<CurrentChanges> {
  if (!input.before) {
    return { changes: [], workspaceChanges: [], evidenceChanges: [], sideEffectChanges: [], snapshotOmissions: [], snapshotOmissionsTruncated: false };
  }
  // #193 slice D: a Git baseline settles through one frozen ephemeral
  // after-checkpoint; the caller releases the pin (fail closed) once every
  // artifact is written.
  const checkpointBefore = typedCheckpointBaselineOf(input.before);
  const gitBefore = typedGitBaselineOf(input.before);
  if (checkpointBefore || gitBefore) {
    const settled = checkpointBefore
      ? await settleCheckpointReview({ cwd: input.cwd, before: checkpointBefore, config: input.config, evidence: input.evidence })
      : await settleGitReview({ cwd: input.cwd, before: gitBefore!, config: input.config });
    try {
      const evidenceChanges = input.evidence
        ? await collectSettledEvidence(input.evidence, input.cwd, input.config, settled.workspaceChanges, undefined, true, settled.frozenCandidateAfter, settled.evidenceRoot)
        : [];
      return {
        ...splitReviewChanges(settled.workspaceChanges, evidenceChanges),
        windowPatch: settled.windowPatch,
        snapshotOmissions: [],
        snapshotOmissionsTruncated: false,
        evidenceRoot: settled.evidenceRoot,
        releaseOrphan: settled.releaseOrphan,
      };
    } catch (error) {
      // Evidence collection after settling must not orphan the ephemeral pin
      // either; a failed release is reported alongside the original error.
      return rethrowAfterRelease(error, settled.releaseOrphan);
    }
  }
  // #193: the reviewer-question settle capture reuses verified facts from
  // the provided completed `before` baseline; unchanged entries are
  // re-verified against the live entry and every retain/omit decision is
  // recomputed, so changes made after the baseline are fully inspected
  // exactly as a fresh capture would inspect them.
  const legacyBefore = legacySnapshotOf(input.before);
  const after = await createWorkspaceSnapshot(input.cwd, {
    maxFileBytes: input.config.maxFileBytes,
    maxSnapshotBytes: input.config.maxSnapshotBytes,
    reuseUnchangedFrom: legacyBefore,
  });
  const workspaceChanges = compareSnapshots(legacyBefore, after);
  const evidenceChanges = input.evidence
    ? await collectEvidenceChanges(input.evidence, input.cwd, {
      maxFileBytes: input.config.maxFileBytes,
      maxSnapshotBytes: input.config.maxSnapshotBytes,
    })
    : [];
  return {
    ...splitReviewChanges(workspaceChanges, evidenceChanges),
    snapshotOmissions: after.omissions,
    snapshotOmissionsTruncated: after.omissionsTruncated,
  };
}

/** Typed checkpoints supply included in-root after-values. Excluded evidence
 * candidates use one separately frozen pre-checkpoint value, shared by window
 * and exchange comparisons; neither kind is reread after the checkpoint.
 * External side effects retain their separate live capture path.
 */
async function collectSettledEvidence(
  evidence: EvidenceState, cwd: string, config: ReviewGateConfig,
  frozenChanges: ChangedFile[], exchangeSequence?: number, typed = false,
  frozenCandidateAfter?: Map<string, FileSnapshot>, evidenceRoot?: string,
): Promise<ChangedFile[]> {
  const options = { maxFileBytes: config.maxFileBytes, maxSnapshotBytes: config.maxSnapshotBytes };
  if (!typed || !frozenCandidateAfter) return collectEvidenceChanges(evidence, cwd, options, exchangeSequence);
  const root = resolve(evidenceRoot ?? cwd);
  const inside = (absolute: string): string | undefined => {
    const path = relative(root, resolve(absolute));
    return path && !isAbsolute(path) && path !== ".." && !path.startsWith(`..${sep}`) ? path.split(sep).join("/") : undefined;
  };
  const changed = new Map(frozenChanges.map((change) => [change.path, change]));
  const inRoot = [...evidence.candidates.values()].flatMap((candidate) => {
    const path = inside(candidate.absolutePath);
    const baseline = exchangeSequence === undefined ? candidate.baseline : candidate.exchangeBaselines.get(exchangeSequence)?.snapshot;
    if (!path || !baseline) return [];
    const change = changed.get(path);
    if (change) return [change];
    const after = frozenCandidateAfter.get(candidate.absolutePath);
    const sideEffect = after && compareFileSnapshots(
      { ...baseline, relativePath: path }, { ...after, relativePath: path },
    );
    return sideEffect ? [sideEffect] : [];
  });
  const external = new Map([...evidence.candidates].filter(([, candidate]) => inside(candidate.absolutePath) === undefined));
  const externalChanges = await collectEvidenceChanges({ ...evidence, candidates: external }, cwd, options, exchangeSequence);
  return mergeChanges(inRoot, externalChanges);
}

function splitReviewChanges(
  workspaceChanges: ChangedFile[],
  evidenceChanges: ChangedFile[],
): { changes: ChangedFile[]; workspaceChanges: ChangedFile[]; evidenceChanges: ChangedFile[]; sideEffectChanges: ChangedFile[] } {
  const workspacePathSet = new Set(workspaceChanges.map((change) => change.path));
  return {
    changes: mergeChanges(workspaceChanges, evidenceChanges),
    workspaceChanges,
    evidenceChanges,
    sideEffectChanges: evidenceChanges.filter((change) => !workspacePathSet.has(change.path)),
  };
}

function mergeChanges<T extends { path: string }>(workspaceChanges: T[], evidenceChanges: T[]): T[] {
  const byPath = new Map<string, T>();
  for (const change of workspaceChanges) {
    byPath.set(change.path, change);
  }
  for (const change of evidenceChanges) {
    if (!byPath.has(change.path)) {
      byPath.set(change.path, change);
    }
  }
  return [...byPath.values()].sort((a, b) => a.path.localeCompare(b.path));
}
