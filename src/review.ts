import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { resolveReviewers, type DeciderConfig, type ReviewGateConfig } from "./config";
import { createReviewerQuestionBundle, createReviewBundle, removeReviewBundle, syncReviewWindowArtifacts, type ReviewBundle } from "./bundle";
import { compareSnapshots, createWorkspaceSnapshot, type ChangedFile, type WorkspaceSnapshot } from "./capture";
import { buildUnifiedPatch } from "./diff";
import { buildEvidenceBundle, collectEvidenceChanges, type EvidenceState } from "./evidence";
import type { ChangeIdentity, ReviewResult } from "./schema";
import { validateChangeIdentity } from "./schema";
import { GenericCliAdapter } from "./adapters/generic-cli";
import { CodexCliAdapter } from "./adapters/codex-cli";
import { ClaudeCliAdapter } from "./adapters/claude-cli";
import { LittleCoderAdapter } from "./adapters/little-coder";
import type { ModelAdapter, ReviewerSession } from "./adapters/types";
import type { TokenUsage } from "./usage";
import { completeActiveExchange, hasUnresolvedReview, type ReviewWindow } from "./state";

export interface ReviewRunInput {
  cwd: string;
  request: string;
  before: WorkspaceSnapshot;
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
  reviewedSnapshot?: WorkspaceSnapshot;
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
  before?: WorkspaceSnapshot;
  config: ReviewGateConfig;
  evidence?: EvidenceState;
  correctionAttemptCount?: number;
  changeIdentity?: ChangeIdentity;
  signal?: AbortSignal;
  notify?: (message: string) => void | Promise<void>;
  onUpdate?: (message: string) => void;
  window?: ReviewWindow;
}

export interface AskReviewerOutput {
  changes: ChangedFile[];
  result?: ReviewResult;
  reviewerResults?: ReviewResult[];
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
  const correctionAttemptCount = input.correctionAttemptCount ?? 0;
  const guidanceEscalation = buildGuidanceEscalation(input.config, correctionAttemptCount);
  const after = await createWorkspaceSnapshot(input.cwd, {
    maxFileBytes: input.config.maxFileBytes,
    maxSnapshotBytes: input.config.maxSnapshotBytes,
  });
  const workspaceChanges = compareSnapshots(input.before, after);
  const evidenceChanges = input.evidence
    ? await collectEvidenceChanges(input.evidence, input.cwd, {
      maxFileBytes: input.config.maxFileBytes,
      maxSnapshotBytes: input.config.maxSnapshotBytes,
    })
    : [];
  const split = splitReviewChanges(workspaceChanges, evidenceChanges);
  const { changes, sideEffectChanges } = split;

  // When exactChange is present with nonempty changedPaths, treat as reviewable
  // even if workspace snapshots show no content hash changes (e.g., mode-only or binary changes).
  const hasExactChanges = input.exactChange !== undefined && input.exactChange.changedPaths.length > 0;
  const exchangeBefore = input.window?.activeExchange?.baseline;
  const exchangeSequence = input.window?.activeExchange?.sequence;
  const reviewResponseMode = input.window?.activeExchange?.reviewResponseMode;
  const exchangeWorkspaceChanges = exchangeBefore ? compareSnapshots(exchangeBefore, after) : workspaceChanges;
  const exchangeEvidenceChanges = input.evidence && exchangeSequence !== undefined
    ? await collectEvidenceChanges(input.evidence, input.cwd, {
      maxFileBytes: input.config.maxFileBytes,
      maxSnapshotBytes: input.config.maxSnapshotBytes,
    }, exchangeSequence)
    : evidenceChanges;
  const exchangeSplit = splitReviewChanges(exchangeWorkspaceChanges, exchangeEvidenceChanges);
  const exchangeWorkspacePatch = exchangeWorkspaceChanges.length > 0
    ? buildUnifiedPatch(exchangeWorkspaceChanges, input.config.maxPatchBytes).patch
    : "";
  const exchangeSideEffectPatch = exchangeSplit.sideEffectChanges.length > 0
    ? buildUnifiedPatch(exchangeSplit.sideEffectChanges, input.config.maxPatchBytes).patch
    : "";
  if (input.window) {
    completeActiveExchange(input.window, {
      workspaceChanges: exchangeWorkspaceChanges,
      sideEffectChanges: exchangeSplit.sideEffectChanges,
      workspacePatch: exchangeWorkspacePatch,
      sideEffectPatch: exchangeSideEffectPatch,
      actingUsage: input.actingUsage,
    });
  }
  const exchangeHasReviewableChanges = exchangeWorkspaceChanges.length > 0 || exchangeSplit.sideEffectChanges.length > 0 || hasExactChanges;
  if ((reviewResponseMode === "observation" || reviewResponseMode === "deferred") && !exchangeHasReviewableChanges) {
    if (input.window?.bundleDir) {
      await syncReviewWindowArtifacts({
        dir: input.window.bundleDir,
        cwd: input.cwd,
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
      ? buildUnifiedPatch(workspaceChanges, input.config.maxPatchBytes)
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
  const reviewers = getReviewers(input.config);
  if (reviewers.length === 0) {
    return {
      changed: true,
      changes,
      error: "No reviewers configured.",
    };
  }

  const reviewSequence = input.window?.nextReviewSequence ?? 1;
  const bundle = await createReviewBundle({
    dir: input.window?.bundleDir,
    reviewSequence,
    exchanges: input.window?.exchanges,
    cwd: input.cwd,
    request: input.request,
    submittedChanges: split.workspaceChanges,
    sideEffectChanges,
    patch: patchResult.patch,
    sideEffectPatch: sideEffectPatchResult.patch,
    evidence: input.evidence
      ? buildEvidenceBundle(input.evidence, evidenceChanges.map((change) => change.path))
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
      ...(input.exactChange !== undefined ? {
        exactChangedPaths: input.exactChange.changedPaths,
        exactPatchTruncated: input.exactChange.truncated,
        exactOmittedDiffs: input.exactChange.omitted,
      } : {}),
    },
  });
  registerBundleWithWindow(input.window, bundle.dir);
  const invocation = await executeReviewerInvocation({
    reviewers,
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

  return {
    changed: true,
    changes,
    result: invocation.result,
    reviewerResults: invocation.reviewerResults,
    reviewerDisplayLabels: Object.fromEntries(
      reviewers.map((reviewer) => [reviewer.id, reviewerDisplayLabel(reviewer)]),
    ),
    bundleDir: bundle.dir,
    invocationDir: bundle.invocationDir,
    reviewSequence,
    reviewedSnapshot: after,
    bundleRetained: invocation.bundleRetained,
  };
}

export async function collectPausedReviewExchange(input: PausedExchangeInput): Promise<void> {
  const active = input.window.activeExchange;
  if (!active) {
    return;
  }
  const after = await createWorkspaceSnapshot(input.cwd, {
    maxFileBytes: input.config.maxFileBytes,
    maxSnapshotBytes: input.config.maxSnapshotBytes,
  });
  const workspaceChanges = active.baseline ? compareSnapshots(active.baseline, after) : [];
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
  const correctionAttemptCount = input.correctionAttemptCount ?? 0;
  const guidanceEscalation = buildGuidanceEscalation(input.config, correctionAttemptCount);
  const { changes, workspaceChanges, evidenceChanges, sideEffectChanges } = await collectCurrentChanges({
    cwd: input.cwd,
    before: input.before,
    config: input.config,
    evidence: input.evidence,
  });
  const patchResult = workspaceChanges.length > 0
    ? buildUnifiedPatch(workspaceChanges, input.config.maxPatchBytes)
    : { patch: input.before ? "(no file changes detected)" : "(no baseline available; answering from request context and session evidence)", truncated: false, omitted: [] };
  const sideEffectPatchResult = sideEffectChanges.length > 0
    ? buildUnifiedPatch(sideEffectChanges, input.config.maxPatchBytes)
    : { patch: "", truncated: false, omitted: [] };
  const reviewers = getReviewers(input.config);
  if (reviewers.length === 0) {
    return {
      changes,
      error: "No reviewers configured.",
    };
  }

  const reviewSequence = input.window?.nextReviewSequence ?? 1;
  const bundle = await createReviewerQuestionBundle({
    dir: input.window?.bundleDir,
    reviewSequence,
    exchanges: input.window?.exchanges,
    cwd: input.cwd,
    question: input.question,
    request: input.request,
    submittedChanges: workspaceChanges,
    sideEffectChanges,
    patch: patchResult.patch,
    sideEffectPatch: sideEffectPatchResult.patch,
    evidence: input.evidence
      ? buildEvidenceBundle(input.evidence, evidenceChanges.map((change) => change.path))
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
    },
  });
  registerBundleWithWindow(input.window, bundle.dir);
  const invocation = await executeReviewerInvocation({
    reviewers,
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
      bundleDir: bundle.dir,
      bundleRetained: false,
    };
  }

  return {
    changes,
    result: invocation.result,
    reviewerResults: invocation.reviewerResults,
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

async function executeReviewerInvocation(input: {
  reviewers: DeciderConfig[];
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
  await input.notify?.(`review gate: ${verb} ${input.reviewers.map(reviewerDisplayLabel).join(", ")}`);
  const sessionsBeforeReview = new Map(input.window?.reviewerSessions ?? []);
  const reviewerResults = await Promise.all(input.reviewers.map(async (reviewer) => {
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
    input.onUpdate?.(`${label} finished · ${result.verdict}`);
    return result;
  }));
  if (reviewWasAborted(input.signal, reviewerResults)) {
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

  const result = decideReviewResults(reviewerResults);
  await Promise.all([
    writeFile(join(input.bundle.invocationDir, "reviewer-usage.json"), JSON.stringify(result.usage ?? null, null, 2), "utf8"),
    writeFile(join(input.bundle.dir, "sessions.json"), JSON.stringify(
      Object.fromEntries(input.window?.reviewerSessions ?? []),
      null,
      2,
    ), "utf8"),
  ]).catch(() => undefined);

  const bundleRetained = shouldRetainBundle(input.config, result, reviewerResults);
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
}): Promise<ReviewResult> {
  const reviewerDir = join(input.invocationDir, "reviewers", safePathSegment(input.reviewer.id));
  await mkdir(reviewerDir, { recursive: true });
  const startedAt = Date.now();
  let resumed = false;
  let restartedAfterResumeFailure = false;
  let result: ReviewResult;
  try {
    const adapter = createAdapter(input.reviewer);
    const previousSession = input.window?.reviewerSessions.get(input.reviewer.id);
    const usableSession = previousSession?.adapter === adapter.kind ? previousSession : undefined;
    resumed = Boolean(usableSession);
    const invoke = (session = usableSession) => adapter.run({
      id: input.reviewer.id,
      cwd: input.cwd,
      prompt: input.reviewer.adapter === "generic-cli" ? input.prompt : input.bundlePrompt,
      evidenceBundleDir: input.bundleDir,
      bundleDir: reviewerDir,
      timeoutMs: input.reviewer.timeoutMs ?? 300_000,
      signal: input.signal,
      session,
      onSession: (nextSession) => input.window?.reviewerSessions.set(input.reviewer.id, nextSession),
      onUpdate: input.onUpdate,
    });
    result = await invoke();
    if (usableSession && isResumeFailure(result)) {
      input.window?.reviewerSessions.delete(input.reviewer.id);
      restartedAfterResumeFailure = true;
      result = await invoke(undefined);
    }
  } catch (error) {
    result = {
      reviewerId: input.reviewer.id,
      verdict: "error",
      summary: error instanceof Error ? error.message : "Reviewer failed.",
      findings: [],
      error: error instanceof Error ? error.message : "review_failed",
    };
  }
  await Promise.all([
    writeFile(join(reviewerDir, "parsed-result.json"), JSON.stringify(result, null, 2), "utf8"),
    writeFile(join(reviewerDir, "reviewer-usage.json"), JSON.stringify(result.usage ?? null, null, 2), "utf8"),
    writeFile(join(reviewerDir, "invocation.json"), JSON.stringify({
      reviewerId: input.reviewer.id,
      adapter: input.reviewer.adapter,
      resumed,
      restartedAfterResumeFailure,
      durationMs: Date.now() - startedAt,
      session: input.window?.reviewerSessions.get(input.reviewer.id) ?? null,
    }, null, 2), "utf8"),
  ]).catch(() => undefined);
  return result;
}

function isResumeFailure(result: ReviewResult): boolean {
  return result.verdict === "error" && Boolean(result.error?.startsWith("exit_"));
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
  return {
    reviewerId: "gate",
    verdict: "pass",
    summary: reviewerVerdictSummary(results),
    findings: [],
    usage,
  };
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
  const canceledBy = signal?.reason === "escape" ? "user" : "session";
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

function getReviewers(config: ReviewGateConfig): DeciderConfig[] {
  const resolution = resolveReviewers(config);
  return resolution.unknownIds.length === 0 && resolution.duplicateEnabledIds.length === 0
    ? resolution.reviewers
    : [];
}

export function reviewerDisplayLabel(reviewer: DeciderConfig): string {
  if (reviewer.adapter === "little-coder-model") {
    return reviewer.thinkingLevel
      ? `${reviewer.model} (${reviewer.thinkingLevel})`
      : reviewer.model;
  }
  if ((reviewer.adapter === "codex-cli" || reviewer.adapter === "claude-cli") && reviewer.model) {
    return `${reviewer.id} [${reviewer.adapter}/${reviewer.model}]`;
  }
  return reviewer.id;
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
  if (decider.adapter === "little-coder-model") {
    return new LittleCoderAdapter(decider);
  }

  throw new Error("unsupported reviewer adapter");
}

async function collectCurrentChanges(input: {
  cwd: string;
  before?: WorkspaceSnapshot;
  config: ReviewGateConfig;
  evidence?: EvidenceState;
}): Promise<{ changes: ChangedFile[]; workspaceChanges: ChangedFile[]; evidenceChanges: ChangedFile[]; sideEffectChanges: ChangedFile[] }> {
  if (!input.before) {
    return { changes: [], workspaceChanges: [], evidenceChanges: [], sideEffectChanges: [] };
  }
  const after = await createWorkspaceSnapshot(input.cwd, {
    maxFileBytes: input.config.maxFileBytes,
    maxSnapshotBytes: input.config.maxSnapshotBytes,
  });
  const workspaceChanges = compareSnapshots(input.before, after);
  const evidenceChanges = input.evidence
    ? await collectEvidenceChanges(input.evidence, input.cwd, {
      maxFileBytes: input.config.maxFileBytes,
      maxSnapshotBytes: input.config.maxSnapshotBytes,
    })
    : [];
  return splitReviewChanges(workspaceChanges, evidenceChanges);
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
