import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ReviewGateConfig } from "./config";
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
  const changes = mergeChanges(workspaceChanges, evidenceChanges);
  if (changes.length === 0) {
    return { changed: false, changes };
  }

  const patchResult = buildUnifiedPatch(changes, input.config.maxPatchBytes);
  const decider = input.config.decider;
  if (!decider) {
    return {
      changed: true,
      changes,
      error: "No decider configured.",
    };
  }

  const bundle = await createReviewBundle({
    cwd: input.cwd,
    request: input.request,
    changes,
    patch: patchResult.patch,
    evidence: input.evidence
      ? buildEvidenceBundle(input.evidence, evidenceChanges.map((change) => change.path))
      : undefined,
    actingUsage: input.actingUsage,
    metadata: {
      patchTruncated: patchResult.truncated,
      omittedDiffs: patchResult.omitted,
    },
  });

  let result: ReviewResult;
  try {
    const adapter = createAdapter(decider);
    await input.notify?.(`review gate: reviewing changes with ${decider.id}`);
    result = await adapter.run({
      id: decider.id,
      cwd: input.cwd,
      prompt: bundle.prompt,
      bundleDir: bundle.dir,
      timeoutMs: decider.timeoutMs ?? 120_000,
      signal: input.signal,
    });
    await Promise.all([
      writeFile(join(bundle.dir, "parsed-result.json"), JSON.stringify(result, null, 2), "utf8"),
      writeFile(join(bundle.dir, "reviewer-usage.json"), JSON.stringify(result.usage ?? null, null, 2), "utf8"),
    ]);
  } catch (error) {
    result = {
      reviewerId: decider.id,
      verdict: "error",
      summary: error instanceof Error ? error.message : "Reviewer failed.",
      findings: [],
      error: error instanceof Error ? error.message : "review_failed",
    };
    await Promise.all([
      writeFile(join(bundle.dir, "parsed-result.json"), JSON.stringify(result, null, 2), "utf8"),
      writeFile(join(bundle.dir, "reviewer-usage.json"), JSON.stringify(result.usage ?? null, null, 2), "utf8"),
    ]).catch(() => undefined);
  }

  const shouldRetain = input.config.retainBundles === "always" || (input.config.retainBundles === "on-failure" && result.verdict === "error");
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
  const { changes, evidenceChanges } = await collectCurrentChanges({
    cwd: input.cwd,
    before: input.before,
    config: input.config,
    evidence: input.evidence,
  });
  const patchResult = changes.length > 0
    ? buildUnifiedPatch(changes, input.config.maxPatchBytes)
    : { patch: input.before ? "(no file changes detected)" : "(no baseline available; answering from request context and session evidence)", truncated: false, omitted: [] };
  const decider = input.config.decider;
  if (!decider) {
    return {
      changes,
      error: "No decider configured.",
    };
  }

  const bundle = await createReviewerQuestionBundle({
    cwd: input.cwd,
    question: input.question,
    request: input.request,
    changes,
    patch: patchResult.patch,
    evidence: input.evidence
      ? buildEvidenceBundle(input.evidence, evidenceChanges.map((change) => change.path))
      : undefined,
    metadata: {
      patchTruncated: patchResult.truncated,
      omittedDiffs: patchResult.omitted,
    },
  });

  let result: ReviewResult;
  try {
    const adapter = createAdapter(decider);
    await input.notify?.(`review gate: asking reviewer ${decider.id}`);
    result = await adapter.run({
      id: decider.id,
      cwd: input.cwd,
      prompt: bundle.prompt,
      bundleDir: bundle.dir,
      timeoutMs: decider.timeoutMs ?? 120_000,
      signal: input.signal,
    });
    await Promise.all([
      writeFile(join(bundle.dir, "parsed-result.json"), JSON.stringify(result, null, 2), "utf8"),
      writeFile(join(bundle.dir, "reviewer-usage.json"), JSON.stringify(result.usage ?? null, null, 2), "utf8"),
    ]);
  } catch (error) {
    result = {
      reviewerId: decider.id,
      verdict: "error",
      summary: error instanceof Error ? error.message : "Reviewer failed.",
      findings: [],
      error: error instanceof Error ? error.message : "review_failed",
    };
    await Promise.all([
      writeFile(join(bundle.dir, "parsed-result.json"), JSON.stringify(result, null, 2), "utf8"),
      writeFile(join(bundle.dir, "reviewer-usage.json"), JSON.stringify(result.usage ?? null, null, 2), "utf8"),
    ]).catch(() => undefined);
  }

  const shouldRetain = input.config.retainBundles === "always" || (input.config.retainBundles === "on-failure" && result.verdict === "error");
  if (!shouldRetain) {
    await removeReviewBundle(bundle.dir);
  }

  return {
    changes,
    result,
    bundleDir: bundle.dir,
    bundleRetained: shouldRetain,
  };
}

function createAdapter(decider: NonNullable<ReviewGateConfig["decider"]>): ModelAdapter {
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
}): Promise<{ changes: ChangedFile[]; evidenceChanges: ChangedFile[] }> {
  if (!input.before) {
    return { changes: [], evidenceChanges: [] };
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
  return {
    changes: mergeChanges(workspaceChanges, evidenceChanges),
    evidenceChanges,
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
