import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { DeciderConfig, ReviewGateConfig } from "./config";
import { createReviewerQuestionBundle, createReviewBundle, removeReviewBundle } from "./bundle";
import { compareSnapshots, createWorkspaceSnapshot, type ChangedFile, type WorkspaceSnapshot } from "./capture";
import { buildUnifiedPatch } from "./diff";
import { buildEvidenceBundle, collectEvidenceChanges, type EvidenceState } from "./evidence";
import { buildFollowUpMessage } from "./prompts";
import type { ReviewResult } from "./schema";
import { GenericCliAdapter } from "./adapters/generic-cli";
import { CodexCliAdapter } from "./adapters/codex-cli";
import { ClaudeCliAdapter } from "./adapters/claude-cli";
import { LittleCoderAdapter } from "./adapters/little-coder";
import type { ModelAdapter } from "./adapters/types";
import type { TokenUsage } from "./usage";

export interface ReviewRunInput {
  cwd: string;
  request: string;
  before: WorkspaceSnapshot;
  config: ReviewGateConfig;
  evidence?: EvidenceState;
  actingUsage?: TokenUsage;
  signal?: AbortSignal;
  notify?: (message: string) => void | Promise<void>;
}

export interface ReviewRunOutput {
  changed: boolean;
  changes: ChangedFile[];
  result?: ReviewResult;
  followUpMessage?: string;
  bundleDir?: string;
  bundleRetained?: boolean;
  error?: string;
}

export interface AskReviewerInput {
  cwd: string;
  question: string;
  request: string;
  before?: WorkspaceSnapshot;
  config: ReviewGateConfig;
  evidence?: EvidenceState;
  signal?: AbortSignal;
  notify?: (message: string) => void | Promise<void>;
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
  if (changes.length === 0) {
    return { changed: false, changes };
  }

  const patchResult = workspaceChanges.length > 0
    ? buildUnifiedPatch(workspaceChanges, input.config.maxPatchBytes)
    : { patch: "(no submitted workspace changes detected; review captured side effects below)", truncated: false, omitted: [] };
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

  const bundle = await createReviewBundle({
    cwd: input.cwd,
    request: input.request,
    changes,
    submittedChanges: split.workspaceChanges,
    sideEffectChanges,
    patch: patchResult.patch,
    sideEffectPatch: sideEffectPatchResult.patch,
    evidence: input.evidence
      ? buildEvidenceBundle(input.evidence, evidenceChanges.map((change) => change.path))
      : undefined,
    actingUsage: input.actingUsage,
    metadata: {
      patchTruncated: patchResult.truncated,
      omittedDiffs: patchResult.omitted,
      sideEffectPatchTruncated: sideEffectPatchResult.truncated,
      omittedSideEffectDiffs: sideEffectPatchResult.omitted,
    },
  });

  await input.notify?.(`review gate: reviewing changes with ${reviewers.map((reviewer) => reviewer.id).join(", ")}`);
  const reviewerResults = await Promise.all(reviewers.map((reviewer) => runSingleReviewer({
    reviewer,
    cwd: input.cwd,
    prompt: bundle.prompt,
    bundleDir: bundle.dir,
    signal: input.signal,
  })));
  const result = aggregateReviewResults(reviewerResults);
  await Promise.all([
    writeFile(join(bundle.dir, "parsed-result.json"), JSON.stringify(result, null, 2), "utf8"),
    writeFile(join(bundle.dir, "reviewer-results.json"), JSON.stringify(reviewerResults, null, 2), "utf8"),
    writeFile(join(bundle.dir, "reviewer-usage.json"), JSON.stringify(result.usage ?? null, null, 2), "utf8"),
  ]).catch(() => undefined);

  const shouldRetain = shouldRetainBundle(input.config, result, reviewerResults);
  if (!shouldRetain) {
    await removeReviewBundle(bundle.dir);
  }

  return {
    changed: true,
    changes,
    result,
    followUpMessage: result.verdict === "needs_changes" ? buildFollowUpMessage(result) : undefined,
    bundleDir: bundle.dir,
    bundleRetained: shouldRetain,
  };
}

export async function runAskReviewer(input: AskReviewerInput): Promise<AskReviewerOutput> {
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

  const bundle = await createReviewerQuestionBundle({
    cwd: input.cwd,
    question: input.question,
    request: input.request,
    changes,
    submittedChanges: workspaceChanges,
    sideEffectChanges,
    patch: patchResult.patch,
    sideEffectPatch: sideEffectPatchResult.patch,
    evidence: input.evidence
      ? buildEvidenceBundle(input.evidence, evidenceChanges.map((change) => change.path))
      : undefined,
    metadata: {
      patchTruncated: patchResult.truncated,
      omittedDiffs: patchResult.omitted,
      sideEffectPatchTruncated: sideEffectPatchResult.truncated,
      omittedSideEffectDiffs: sideEffectPatchResult.omitted,
    },
  });

  await input.notify?.(`review gate: asking reviewers ${reviewers.map((reviewer) => reviewer.id).join(", ")}`);
  const reviewerResults = await Promise.all(reviewers.map((reviewer) => runSingleReviewer({
    reviewer,
    cwd: input.cwd,
    prompt: bundle.prompt,
    bundleDir: bundle.dir,
    signal: input.signal,
  })));
  const result = aggregateReviewResults(reviewerResults);
  await Promise.all([
    writeFile(join(bundle.dir, "parsed-result.json"), JSON.stringify(result, null, 2), "utf8"),
    writeFile(join(bundle.dir, "reviewer-results.json"), JSON.stringify(reviewerResults, null, 2), "utf8"),
    writeFile(join(bundle.dir, "reviewer-usage.json"), JSON.stringify(result.usage ?? null, null, 2), "utf8"),
  ]).catch(() => undefined);

  const shouldRetain = shouldRetainBundle(input.config, result, reviewerResults);
  if (!shouldRetain) {
    await removeReviewBundle(bundle.dir);
  }

  return {
    changes,
    result,
    reviewerResults,
    bundleDir: bundle.dir,
    bundleRetained: shouldRetain,
  };
}

async function runSingleReviewer(input: {
  reviewer: DeciderConfig;
  cwd: string;
  prompt: string;
  bundleDir: string;
  signal?: AbortSignal;
}): Promise<ReviewResult> {
  const reviewerDir = join(input.bundleDir, "reviewers", safePathSegment(input.reviewer.id));
  await mkdir(reviewerDir, { recursive: true });
  let result: ReviewResult;
  try {
    const adapter = createAdapter(input.reviewer);
    result = await adapter.run({
      id: input.reviewer.id,
      cwd: input.cwd,
      prompt: input.prompt,
      bundleDir: reviewerDir,
      timeoutMs: input.reviewer.timeoutMs ?? 300_000,
      signal: input.signal,
    });
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
  ]).catch(() => undefined);
  return result;
}

function aggregateReviewResults(results: ReviewResult[]): ReviewResult {
  if (results.length === 1 && results[0]) {
    return results[0];
  }
  const needsChanges = results.filter((result) => result.verdict === "needs_changes");
  const errors = results.filter((result) => result.verdict === "error");
  const usage = aggregateUsage(results);
  if (needsChanges.length > 0) {
    return {
      reviewerId: "aggregate",
      verdict: "needs_changes",
      summary: aggregateSummary(results),
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
      reviewerId: "aggregate",
      verdict: "error",
      summary: aggregateSummary(results),
      findings: [],
      usage,
      error: errors.every((result) => result.error === "aborted") ? "aborted" : "reviewer_error",
    };
  }
  return {
    reviewerId: "aggregate",
    verdict: "pass",
    summary: aggregateSummary(results),
    findings: results.flatMap((result) => result.findings.map((finding) => ({
      ...finding,
      reviewerId: result.reviewerId,
    }))),
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

function aggregateSummary(results: ReviewResult[]): string {
  return results.map((result) => `${result.reviewerId}: ${result.summary}`).join("\n");
}

function aggregateUsage(results: ReviewResult[]): ReviewResult["usage"] {
  const usages = results.map((result) => result.usage).filter((usage) => usage !== undefined);
  if (usages.length === 0) {
    return undefined;
  }
  return {
    inputTokens: sumUsage(usages, "inputTokens"),
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
  if (config.reviewers && config.reviewers.length > 0) {
    return config.reviewers;
  }
  return config.decider ? [config.decider] : [];
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
