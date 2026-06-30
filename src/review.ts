import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ReviewGateConfig } from "./config";
import { createReviewBundle, removeReviewBundle } from "./bundle";
import { compareSnapshots, createWorkspaceSnapshot, type ChangedFile, type WorkspaceSnapshot } from "./capture";
import { buildUnifiedPatch } from "./diff";
import { buildFollowUpMessage } from "./prompts";
import type { ReviewResult } from "./schema";
import { GenericCliAdapter } from "./adapters/generic-cli";
import type { ModelAdapter } from "./adapters/types";

export interface ReviewRunInput {
  cwd: string;
  request: string;
  before: WorkspaceSnapshot;
  config: ReviewGateConfig;
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

export async function runReview(input: ReviewRunInput): Promise<ReviewRunOutput> {
  const after = await createWorkspaceSnapshot(input.cwd, {
    maxFileBytes: input.config.maxFileBytes,
    maxSnapshotBytes: input.config.maxSnapshotBytes,
  });
  const changes = compareSnapshots(input.before, after);
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
    await writeFile(join(bundle.dir, "parsed-result.json"), JSON.stringify(result, null, 2), "utf8");
  } catch (error) {
    result = {
      reviewerId: decider.id,
      verdict: "error",
      summary: error instanceof Error ? error.message : "Reviewer failed.",
      findings: [],
      error: error instanceof Error ? error.message : "review_failed",
    };
    await writeFile(join(bundle.dir, "parsed-result.json"), JSON.stringify(result, null, 2), "utf8").catch(() => undefined);
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

function createAdapter(decider: NonNullable<ReviewGateConfig["decider"]>): ModelAdapter {
  if (decider.adapter === "generic-cli") {
    return new GenericCliAdapter(decider);
  }

  throw new Error("little-coder-model adapter is not implemented yet");
}
