import { randomUUID } from "node:crypto";
import { lstat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { createWorkspaceSnapshot, type WorkspaceSnapshot } from "./capture";
import { armGitCheckpoint, type GitCheckpointReason } from "./git-checkpoint";
import { snapshotReviewBaseline, type ReviewBaseline } from "./state";

export class GitBaselineCaptureError extends Error {
  constructor(readonly reason: GitCheckpointReason, detail?: string) {
    super(`Git review checkpoint could not be armed (${reason})${detail ? `: ${detail}` : ""}`);
    this.name = "GitBaselineCaptureError";
  }
}

export interface ReviewBaselineCaptureOptions {
  maxFileBytes: number;
  maxSnapshotBytes: number;
  signal?: AbortSignal;
  /** Reuse only a completed legacy snapshot; never use it to replace a Git baseline. */
  reuseUnchangedFrom?: WorkspaceSnapshot;
}

/**
 * Git repositories require a complete durable checkpoint; the reviewer patch
 * and snapshot byte limits must never truncate its staged/unstaged/untracked
 * recoverable state. Only a directory that is actually outside Git falls back
 * to the existing best-effort filesystem snapshot. A broken/unreadable .git,
 * unsupported Git feature, or any operational failure fails closed instead.
 */
export async function captureReviewBaseline(root: string, options: ReviewBaselineCaptureOptions): Promise<ReviewBaseline> {
  const cwd = resolve(root);
  const checkpointId = `g-${randomUUID().replace(/-/g, "")}`;
  const armed = await armGitCheckpoint(cwd, checkpointId, { signal: options.signal });
  if (armed.status === "ok") {
    return { kind: "git", cwd, capturedAt: new Date().toISOString(), descriptor: armed.value.descriptor };
  }
  if (armed.reason !== "not_a_git_repository" || await gitMarkerExists(cwd)) {
    throw new GitBaselineCaptureError(armed.reason, armed.detail);
  }
  return snapshotReviewBaseline(await createWorkspaceSnapshot(cwd, {
    maxFileBytes: options.maxFileBytes,
    maxSnapshotBytes: options.maxSnapshotBytes,
    signal: options.signal,
    reuseUnchangedFrom: options.reuseUnchangedFrom,
  }));
}

async function gitMarkerExists(root: string): Promise<boolean> {
  for (let dir = root; ; dir = dirname(dir)) {
    try {
      await lstat(join(dir, ".git"));
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") {
        // An unreadable marker is not evidence of a non-Git directory.
        return true;
      }
    }
    if (dirname(dir) === dir) return false;
  }
}
