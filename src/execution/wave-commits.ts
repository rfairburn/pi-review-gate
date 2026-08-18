import { execFile, spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { WaveCaptureResult } from "./wave-repository";
import { GIT_NO_LOCKS_ENV as GIT_ENV, validateSafeId } from "./wave-validation";

// ── review patch types ───────────────────────────────────────────────────────

/** Result of building a bounded review patch for a candidate commit. */
export interface CandidateReviewPatch {
  /** Deterministic list of changed paths (NUL-safe Git output). */
  changedPaths: string[];
  /** The review patch text (may be truncated). */
  patch: string;
  /** Whether the patch was truncated due to maxPatchBytes. */
  truncated: boolean;
  /** Paths whose diffs were omitted due to truncation. */
  omitted: Array<{ path: string; reason: string }>;
  /** Total bytes of the patch before truncation. */
  totalBytes: number;
}

const execFileAsync = promisify(execFile);

// ── types ────────────────────────────────────────────────────────────────────

/** Result of normalizing a worker worktree into a candidate commit. */
export interface CandidateCommit {
  /** SHA of the candidate commit. */
  commitSha: string;
  /** SHA of the candidate tree. */
  treeSha: string;
  /** Full ref name under which the candidate is pinned. */
  candidateRef: string;
  /** Whether the candidate tree differs from the wave base tree. */
  differsFromBase: boolean;
}

/** Optional prior candidate for re-normalization. */
export interface PriorCandidate {
  /** SHA of the previous candidate commit. */
  commitSha: string;
}

/** Validate that a path stays under the wave root. */
async function assertUnderWaveRoot(path: string, waveRoot: string): Promise<void> {
  const resolvedPath = await fs.realpath(path);
  const resolvedRoot = await fs.realpath(waveRoot);
  const rel = relative(resolvedRoot, resolvedPath);
  if (rel === ".." || rel.startsWith(".." + sep) || rel === "") {
    throw new Error(
      `Path "${path}" is not under wave root "${waveRoot}".`,
    );
  }
}

// ── git helpers ──────────────────────────────────────────────────────────────

async function gitCmd(args: string[], cwd: string, envOverrides: Record<string, string> = {}): Promise<void> {
  await execFileAsync(
    "git",
    args,
    {
      cwd,
      env: { ...process.env, ...GIT_ENV, ...envOverrides },
      timeout: 30_000,
    },
  );
}

async function gitOut(args: string[], cwd: string, envOverrides: Record<string, string> = {}): Promise<string> {
  const { stdout } = await execFileAsync(
    "git",
    args,
    {
      cwd,
      env: { ...process.env, ...GIT_ENV, ...envOverrides },
      timeout: 30_000,
    },
  );
  return stdout.trim();
}

// ── candidate normalization ──────────────────────────────────────────────────

/**
 * Resolve the candidate ref name for a worker task.
 */
export function candidateRefName(waveId: string, taskId: string): string {
  validateSafeId(waveId, "waveId");
  validateSafeId(taskId, "taskId");
  return `refs/pi-review-gate/waves/${waveId}/candidates/${taskId}`;
}

export function recoveryRefName(waveId: string, taskId: string): string {
  validateSafeId(waveId, "waveId");
  validateSafeId(taskId, "taskId");
  return `refs/pi-review-gate/waves/${waveId}/recovery/${taskId}`;
}

export async function pinRecoveryCandidate(
  capture: WaveCaptureResult,
  taskId: string,
  candidate: CandidateCommit,
): Promise<string> {
  const ref = recoveryRefName(capture.waveId, taskId);
  await gitCmd(["update-ref", ref, candidate.commitSha], capture.repositoryPath);
  return ref;
}

/**
 * Normalize a worker worktree into a single candidate commit.
 *
 * This function:
 * 1. Validates that the worktree belongs to the supplied private repository
 *    and is at the correct base commit.
 * 2. Stages all non-ignored working-tree changes (new, modified, deleted files).
 * 3. Writes the resulting tree and creates a single commit whose sole parent
 *    is the immutable wave base (flattening any executor-created history).
 * 4. Moves the worker's HEAD/index to the candidate commit.
 * 5. Pins the candidate under a private candidates/<task-id> ref.
 * 6. Returns commit/tree/ref metadata and whether the tree differs from base.
 *
 * Re-normalization replaces the candidate ref atomically — it never stacks
 * correction commits.
 */
export async function normalizeCandidate(
  capture: WaveCaptureResult,
  worktreeRoot: string,
  taskId: string,
  title: string,
  priorCandidate?: PriorCandidate,
): Promise<CandidateCommit> {
  const waveId = capture.waveId;
  const repoPath = capture.repositoryPath;
  const baseCommit = capture.baseCommit;

  // Validate IDs.
  validateSafeId(waveId, "waveId");
  validateSafeId(taskId, "taskId");

  // Validate title: reject newlines that would break trailer parsing.
  if (typeof title !== "string" || title.length === 0) {
    throw new Error("Invalid title: must be a non-empty string.");
  }
  if (/\r|\n/.test(title)) {
    throw new Error("Invalid title: must not contain newlines.");
  }

  // ── Preflight: verify worktree belongs to this private repo ──
  // Resolve canonical paths.
  const resolvedRepoPath = await fs.realpath(repoPath);

  // Verify the supplied path is the Git top-level of the worktree.
  // Resolve Git-reported paths against worktreeRoot before realpath.
  const topLevel = await gitOut(["rev-parse", "--show-toplevel"], worktreeRoot);
  const resolvedTopLevel = await fs.realpath(resolve(worktreeRoot, topLevel));
  const resolvedWorktreeRoot = await fs.realpath(worktreeRoot);
  if (resolvedTopLevel !== resolvedWorktreeRoot) {
    throw new Error(
      `Supplied path "${worktreeRoot}" is not the Git top-level "${topLevel}".`,
    );
  }

  // Verify HEAD is detached (worker worktrees must be detached).
  const headRef = await gitOut(["symbolic-ref", "--short", "HEAD"], worktreeRoot).catch(() => "");
  if (headRef !== "") {
    throw new Error(
      `Worktree at "${worktreeRoot}" is not on a detached HEAD (on branch "${headRef}").`,
    );
  }

  // Verify the common dir is exactly the private bare repository.
  const commonDir = await gitOut(["rev-parse", "--git-common-dir"], worktreeRoot);
  const resolvedCommonDir = await fs.realpath(resolve(worktreeRoot, commonDir));
  if (resolvedCommonDir !== resolvedRepoPath) {
    throw new Error(
      `Worktree at "${worktreeRoot}" does not belong to the private repository "${repoPath}".`,
    );
  }

  // ── Preflight: verify worktree base matches capture base ──
  // The worktree may have commits on top (from executor), but we need to
  // verify the base commit is reachable.
  const currentHead = await gitOut(["rev-parse", "HEAD"], worktreeRoot);
  if (currentHead !== baseCommit) {
    // Check if baseCommit is an ancestor of HEAD.
    try {
      const mergeBase = await gitOut(["merge-base", "HEAD", baseCommit], worktreeRoot);
      if (mergeBase !== baseCommit) {
        throw new Error(
          `Worktree HEAD is not based on the wave base commit "${baseCommit}".`,
        );
      }
    } catch (err) {
      // merge-base failed (unrelated histories) — refuse.
      if (err instanceof Error && err.message.includes("merge-base")) {
        throw err;
      }
      throw new Error(
        `Worktree HEAD is not based on the wave base commit "${baseCommit}".`,
      );
    }
  }

  // ── Preflight: verify worktree is under wave root ──
  await assertUnderWaveRoot(worktreeRoot, capture.waveRoot);

  // ── Stage all non-ignored changes ──
  // Add all tracked changes (modified, deleted) and new non-ignored files.
  // git add -u stages modifications and deletions of tracked files.
  // git add --intent-to-add would be wrong; we want actual new files.
  // Using `git add .` stages everything except ignored files.
  await gitCmd(["add", "."], worktreeRoot);

  // ── Validate symlink targets in staged index ──
  await validateCandidateSymlinks(worktreeRoot);

  // ── Write the tree from the staged index ──
  const treeSha = await gitOut(["write-tree"], worktreeRoot);

  // ── Build the commit message with trailers ──
  const message = `${title}

Wave-Id: ${waveId}
Task-Id: ${taskId}`;

  // ── Create the candidate commit with base as sole parent ──
  const commitSha = await createCommitWithParent(
    worktreeRoot,
    treeSha,
    baseCommit,
    message,
  );

  // ── Move HEAD to the candidate commit ──
  await gitCmd(["reset", "--hard", commitSha], worktreeRoot);

  // ── Verify the worktree is clean ──
  const status = await gitOut(
    ["status", "--porcelain", "--untracked-files=all"],
    worktreeRoot,
  );
  if (status !== "") {
    throw new Error(
      `Worktree is not clean after normalization: ${status.slice(0, 200)}`,
    );
  }

  // ── Pin the candidate under a private ref ──
  const candidateRef = candidateRefName(waveId, taskId);

  // Atomic compare-and-swap: if a prior candidate was supplied, use Git's
  // expected-old-value form so the replacement is a single operation.
  if (priorCandidate) {
    await gitCmd(
      ["update-ref", candidateRef, commitSha, priorCandidate.commitSha],
      repoPath,
    ).catch(() => {
      throw new Error(
        `Candidate ref ${candidateRef} was expected at ${priorCandidate.commitSha} ` +
        `but has changed. Refusing to overwrite.`,
      );
    });
  } else {
    await gitCmd(["update-ref", candidateRef, commitSha], repoPath);
  }

  // ── Check if tree differs from base ──
  const baseTreeSha = await gitOut(
    ["rev-parse", `${baseCommit}^{tree}`],
    worktreeRoot,
  );
  const differsFromBase = treeSha !== baseTreeSha;

  return {
    commitSha,
    treeSha,
    candidateRef,
    differsFromBase,
  };
}

/**
 * Create a commit object with a specific parent using the worktree's index.
 */
async function createCommitWithParent(
  worktreeRoot: string,
  treeSha: string,
  parentSha: string,
  message: string,
): Promise<string> {
  const commitEnv = {
    ...process.env,
    ...GIT_ENV,
    GIT_AUTHOR_NAME: "pi-review-gate",
    GIT_AUTHOR_EMAIL: "pi-review-gate@local",
    GIT_COMMITTER_NAME: "pi-review-gate",
    GIT_COMMITTER_EMAIL: "pi-review-gate@local",
  };

  return new Promise<string>((resolve, reject) => {
    const child = spawn("git", ["commit-tree", treeSha, "-p", parentSha], {
      cwd: worktreeRoot,
      env: commitEnv,
      timeout: 30_000,
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer | string) => { stdout += chunk; });
    child.stderr.on("data", (chunk: Buffer | string) => { stderr += chunk; });
    child.on("error", reject);
    child.on("exit", (code, signal) => {
      if (code !== 0 || signal) {
        reject(new Error(`git commit-tree exited with code ${code} signal ${signal}: ${stderr.trim()}`));
      } else {
        resolve(stdout.trim());
      }
    });

    child.stdin.write(message);
    child.stdin.end();
  });
}

// ── review patch helper ──────────────────────────────────────────────────────

/**
 * Build a bounded review patch for a candidate commit against a wave base.
 *
 * Validates that the candidate has the wave base as its sole parent, obtains
 * deterministic changed paths with NUL-safe Git output, and produces a bounded
 * `git diff --binary --full-index --no-ext-diff --no-renames base candidate`
 * review patch with truncation metadata under maxPatchBytes.
 */
export async function buildCandidateReviewPatch(
  repoPath: string,
  baseCommit: string,
  candidateCommit: string,
  maxPatchBytes: number,
): Promise<CandidateReviewPatch> {
  if (!Number.isInteger(maxPatchBytes) || maxPatchBytes < 0) {
    throw new Error(`Invalid maxPatchBytes: ${maxPatchBytes}. Must be a finite non-negative integer.`);
  }

  // Validate that the candidate has the wave base as its sole parent.
  // Use rev-list --parents to get only the commit header (avoids parsing commit messages).
  const parentLine = await gitOut(
    ["rev-list", "--parents", "-n", "1", candidateCommit],
    repoPath,
  );
  const tokens = parentLine.split(/\s+/);
  // First token is the candidate SHA, remaining tokens are parent SHAs.
  const parentShas = tokens.slice(1);
  if (parentShas.length !== 1) {
    throw new Error(
      `Candidate ${candidateCommit} must have exactly one parent, got ${parentShas.length}.`,
    );
  }
  const actualParent = parentShas[0];
  if (actualParent !== baseCommit) {
    throw new Error(
      `Candidate ${candidateCommit} parent is ${actualParent}, expected wave base ${baseCommit}.`,
    );
  }

  // Obtain deterministic changed paths with NUL-safe Git output.
  // Use --no-renames to match the review patch behavior.
  const rawPaths = await gitOutBuffer(
    ["diff", "--name-only", "-z", "--no-renames", baseCommit, candidateCommit],
    repoPath,
  );
  const changedPaths = rawPaths
    .split("\0")
    .filter(Boolean)
    .sort();

  // Build the diff using a streaming collector that bounds the retained patch
  // to maxPatchBytes while counting total bytes (avoids materializing large diffs).
  const { patch: fullDiff, totalBytes } = await collectGitDiffBounded(
    ["diff", "--binary", "--full-index", "--no-ext-diff", "--no-renames", baseCommit, candidateCommit],
    repoPath,
    maxPatchBytes,
  );

  if (totalBytes <= maxPatchBytes) {
    return {
      changedPaths,
      patch: fullDiff,
      truncated: false,
      omitted: [],
      totalBytes,
    };
  }

  // Truncate the patch to maxPatchBytes using byte-aware, UTF-8-safe slicing.
  const buf = Buffer.from(fullDiff, "utf8");
  const truncatedPatch = utf8SafePrefix(buf, maxPatchBytes).toString("utf8");
  const omitted = changedPaths.map((path) => ({
    path,
    reason: "truncated_by_max_patch_bytes",
  }));

  return {
    changedPaths,
    patch: truncatedPatch,
    truncated: true,
    omitted,
    totalBytes,
  };
}

/**
 * Return a sub-buffer of `buf` limited to `maxBytes` bytes, trimmed to the
 * last complete UTF-8 sequence so we never emit a replacement character.
 */
function utf8SafePrefix(buf: Buffer, maxBytes: number): Buffer {
  if (buf.length <= maxBytes) return buf;
  let end = maxBytes;
  // Walk back from the cut point past continuation bytes (0b10xxxxxx = 0x80..0xBF).
  while (end > 0 && (buf[end - 1] & 0xC0) === 0x80) {
    end -= 1;
  }
  // If the last byte is now a lead byte (0xC0..0xF7), the sequence is
  // incomplete; drop it so we never emit a replacement character.
  if (end > 0 && (buf[end - 1] & 0xC0) === 0xC0) {
    end -= 1;
  }
  return buf.subarray(0, end);
}

/**
 * Stream `git` stdout and retain at most `maxBytes` bytes of the output
 * (UTF-8-safe) while counting the total byte length. This avoids materializing
 * arbitrarily large diffs in memory.
 */
async function collectGitDiffBounded(
  args: string[],
  cwd: string,
  maxBytes: number,
): Promise<{ patch: string; totalBytes: number }> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, {
      cwd,
      env: { ...process.env, ...GIT_ENV },
      timeout: 30_000,
      stdio: ["ignore", "pipe", "pipe"],
    });

    const chunks: Buffer[] = [];
    let retainedBytes = 0;
    let totalBytes = 0;
    let done = false;

    child.stdout.on("data", (chunk: Buffer) => {
      totalBytes += chunk.length;
      if (!done && retainedBytes + chunk.length <= maxBytes) {
        chunks.push(chunk);
        retainedBytes += chunk.length;
      } else if (!done) {
        // Retain only the remaining bytes up to maxBytes.
        const remaining = maxBytes - retainedBytes;
        if (remaining > 0) {
          chunks.push(chunk.subarray(0, remaining));
        }
        done = true;
      }
    });

    child.stderr.on("data", () => {}); // discard stderr
    child.on("error", reject);
    child.on("exit", (code, signal) => {
      if (code !== 0 || signal) {
        reject(new Error(`git ${args.join(" ")} exited with code ${code} signal ${signal}`));
      } else {
        const patch = chunks.length > 0 ? Buffer.concat(chunks).toString("utf8") : "";
        resolve({ patch, totalBytes });
      }
    });
  });
}

/** Like gitOut but returns raw buffer output (for NUL-safe parsing). */
async function gitOutBuffer(args: string[], cwd: string): Promise<string> {
  const { stdout } = await execFileAsync(
    "git",
    args,
    {
      cwd,
      env: { ...process.env, ...GIT_ENV },
      timeout: 30_000,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    },
  );
  return stdout;
}

/**
 * Reject symlinks staged in the candidate whose targets are absolute or
 * resolve outside the worktree root. Prevents worker-created escaping
 * symlinks from being pinned as accepted candidates.
 *
 * Reads the symlink target from the staged Git blob (not the worktree)
 * to prevent index/worktree mismatch bypass attacks.
 */
async function validateCandidateSymlinks(worktreeRoot: string): Promise<void> {
  const staged = await gitOutBuffer(["ls-files", "-s", "-z"], worktreeRoot);
  const root = await fs.realpath(worktreeRoot);
  for (const record of staged.split("\0").filter(Boolean)) {
    const tabIdx = record.indexOf("\t");
    if (tabIdx < 0) continue;
    const meta = record.slice(0, tabIdx);
    const relPath = record.slice(tabIdx + 1);
    const parts = meta.split(" ");
    const mode = parts[0];
    if (mode !== "120000") continue;
    const blobId = parts[1];
    // Read the symlink target from the staged Git blob, not the worktree.
    // This prevents an index/worktree mismatch bypass where the staged blob
    // contains an unsafe target but the worktree symlink is safe.
    // Use gitOutBuffer to get exact blob bytes (gitOut trims stdout,
    // which would alter symlink targets with leading/trailing whitespace).
    const rawTarget = await gitOutBuffer(["cat-file", "-p", blobId], worktreeRoot);
    // git cat-file -p may include a trailing newline; use the raw bytes
    // for the confinement check but trim for the error message.
    const target = rawTarget.trim();
    if (isAbsolute(rawTarget)) {
      throw new Error(`Symlink target is absolute and rejected: "${relPath}" -> ${target}`);
    }
    const resolved = resolve(dirname(join(worktreeRoot, relPath)), rawTarget);
    if (!resolved.startsWith(root + sep) && resolved !== root) {
      throw new Error(`Symlink target escapes worktree root and is rejected: "${relPath}" -> ${target}`);
    }
  }
}
