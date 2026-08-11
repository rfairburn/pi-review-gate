import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { WaveCaptureResult } from "./wave-repository";
import { GIT_NO_LOCKS_ENV as GIT_ENV, validateSafeId } from "./wave-validation";
import {
  createIntegrationWorktree,
  pinCommit,
  workerRefName,
  integrationRefName,
} from "./wave-worktrees";

const execFileAsync = promisify(execFile);

/** @internal Per-invocation integration fault hooks used by regression tests. */
export interface WaveIntegrationHooks {
  beforeWorktree?: () => void | Promise<void>;
  afterWorktree?: () => void | Promise<void>;
}

// ── types ────────────────────────────────────────────────────────────────────

/** A selected worker result for integration. */
export interface SelectedWorker {
  /** The task identifier. */
  taskId: string;
  /** The commit SHA to integrate. */
  commitSha: string;
}

/** Mapping of a single worker commit in the integration result. */
export interface IntegratedWorkerMapping {
  /** The task identifier. */
  taskId: string;
  /** The original worker commit SHA (as pinned under workers/<task-id>). */
  originalCommitSha: string;
  /** The resulting commit SHA in the integrated history (may differ for cherry-picks). */
  integratedCommitSha: string;
  /** 1-based position in the declared integration order. */
  order: number;
}

/** Status of a wave integration result. */
export type WaveIntegrationStatus = "integrated" | "conflicted" | "no_changes";

/** Successful integration result. */
export interface WaveIntegrationSuccess {
  status: "integrated";
  /** The integrated ref pinned to the final HEAD. */
  integratedRef: string;
  /** The final integrated commit SHA. */
  finalCommitSha: string;
  /** Path to the integration worktree. */
  worktree: string;
  /** Ordered mappings of each worker commit. */
  workerMappings: IntegratedWorkerMapping[];
  /** Validation status (always 'not_run' — no semantic validation). */
  validationStatus: "not_run";
}

/** Conflict result — integration worktree preserved for inspection. */
export interface WaveIntegrationConflict {
  status: "conflicted";
  /** Workers successfully integrated before the conflict. */
  successfullyIntegrated: IntegratedWorkerMapping[];
  /** The task that caused the conflict. */
  conflictingTaskId: string;
  /** The commit SHA that caused the conflict. */
  conflictingCommitSha: string;
  /** NUL-safe list of conflicting file paths. */
  conflictingPaths: string[];
  /** Git diagnostics for the conflict. */
  gitDiagnostics: string;
  /** Path to the preserved integration worktree. */
  worktree: string;
}

/** No-changes result for empty selection. */
export interface WaveIntegrationNoChanges {
  status: "no_changes";
  /** The base commit SHA (pinned under integrated ref). */
  baseCommitSha: string;
  /** The integrated ref pinned to the base. */
  integratedRef: string;
  /** Path to the integration worktree. */
  worktree: string;
  /** Empty worker mappings. */
  workerMappings: IntegratedWorkerMapping[];
  /** Validation status. */
  validationStatus: "not_run";
}

/** Union of all integration result types. */
export type WaveIntegrationResult =
  | WaveIntegrationSuccess
  | WaveIntegrationConflict
  | WaveIntegrationNoChanges;

// ── git helpers ──────────────────────────────────────────────────────────────

async function gitCmd(
  args: string[],
  cwd: string,
  envOverrides: Record<string, string> = {},
  signal?: AbortSignal,
): Promise<void> {
  await execFileAsync(
    "git",
    args,
    {
      cwd,
      env: { ...process.env, ...GIT_ENV, ...envOverrides },
      timeout: 30_000,
      signal,
    },
  );
}

async function gitOut(
  args: string[],
  cwd: string,
  envOverrides: Record<string, string> = {},
  signal?: AbortSignal,
): Promise<string> {
  const { stdout } = await execFileAsync(
    "git",
    args,
    {
      cwd,
      env: { ...process.env, ...GIT_ENV, ...envOverrides },
      timeout: 30_000,
      signal,
    },
  );
  return stdout.trim();
}

// ── commit validation ────────────────────────────────────────────────────────

/**
 * Verify that a commit SHA exactly matches its pinned worker ref
 * and has the wave base as its sole parent.
 */
async function validateWorkerCommit(
  capture: WaveCaptureResult,
  worker: SelectedWorker,
  signal?: AbortSignal,
): Promise<void> {
  const { waveId, repositoryPath, baseCommit } = capture;
  const { taskId, commitSha } = worker;

  // Validate IDs.
  validateSafeId(waveId, "waveId");
  validateSafeId(taskId, "taskId");

  // Resolve the pinned worker ref.
  const workerRef = workerRefName(waveId, taskId);

  // Check that the ref exists and points to the expected commit.
  const pinnedSha = await gitOut(["rev-parse", "--verify", workerRef], repositoryPath, {}, signal)
    .catch((error) => {
      if (signal?.aborted) throw error;
      return null;
    });
  if (!pinnedSha) {
    throw new Error(
      `Worker commit for task "${taskId}" is not pinned under ${workerRef}. ` +
      `The worker result must be accepted before integration.`,
    );
  }
  if (pinnedSha !== commitSha) {
    throw new Error(
      `Worker commit for task "${taskId}" does not match pinned ref ${workerRef}. ` +
      `Expected ${pinnedSha}, got ${commitSha}.`,
    );
  }

  // Verify the commit has exactly one parent and it is the wave base.
  const parentLine = await gitOut(
    ["rev-list", "--parents", "-n", "1", commitSha],
    repositoryPath,
    {},
    signal,
  );
  const tokens = parentLine.split(/\s+/);
  const parentShas = tokens.slice(1);
  if (parentShas.length !== 1) {
    throw new Error(
      `Worker commit ${commitSha} for task "${taskId}" must have exactly one parent, got ${parentShas.length}.`,
    );
  }
  if (parentShas[0] !== baseCommit) {
    throw new Error(
      `Worker commit ${commitSha} for task "${taskId}" has parent ${parentShas[0]}, ` +
      `expected wave base ${baseCommit}.`,
    );
  }
}

// ── cherry-pick with conflict detection ──────────────────────────────────────

/**
 * Cherry-pick a commit in the integration worktree.
 * Returns the new HEAD SHA on success, or conflict diagnostics on failure.
 *
 * Distinguishes actual textual conflicts (unmerged paths exist) from
 * empty cherry-picks (already applied) and infrastructure failures.
 * Empty cherry-picks are kept as no-ops (--keep-redundant-commits) so the
 * integration history preserves the declared worker order. This spelling is
 * supported by older Git releases (including Ubuntu 24.04's Git 2.43), unlike
 * the newer --empty=keep spelling.
 */
async function cherryPickCommit(
  worktreeRoot: string,
  commitSha: string,
  signal?: AbortSignal,
): Promise<{ success: true; newHead: string } | { success: false; conflictingPaths: string[]; gitDiagnostics: string }> {
  const commitEnv = {
    ...process.env,
    ...GIT_ENV,
    GIT_AUTHOR_NAME: "pi-review-gate",
    GIT_AUTHOR_EMAIL: "pi-review-gate@local",
    GIT_COMMITTER_NAME: "pi-review-gate",
    GIT_COMMITTER_EMAIL: "pi-review-gate@local",
  };

  try {
    // Keep already-applied changes as an empty commit rather than silently
    // skipping them, preserving declared worker order across Git versions.
    await gitCmd(["cherry-pick", "--keep-redundant-commits", commitSha], worktreeRoot, commitEnv, signal);
    const newHead = await gitOut(["rev-parse", "HEAD"], worktreeRoot, {}, signal);
    return { success: true, newHead };
  } catch (err) {
    // Distinguish actual textual conflicts from other failures.
    if (signal?.aborted) throw err;
    const conflictingPaths = await getConflictingPaths(worktreeRoot, signal);
    if (conflictingPaths.length > 0) {
      // Real textual conflict — return structured diagnostics.
      const gitDiagnostics = await getConflictDiagnostics(worktreeRoot, err, signal);
      return { success: false, conflictingPaths, gitDiagnostics };
    }
    // No unmerged paths — this is not a textual conflict.
    // Rethrow so infrastructure failures propagate correctly.
    throw err;
  }
}

/** Get NUL-safe list of conflicting file paths. */
async function getConflictingPaths(worktreeRoot: string, signal?: AbortSignal): Promise<string[]> {
  try {
    const rawOutput = await gitOutBuffer(
      ["diff", "--name-only", "-z", "--diff-filter=U"],
      worktreeRoot,
      signal,
    );
    return rawOutput.split("\0").filter(Boolean).sort();
  } catch (error) {
    if (signal?.aborted) throw error;
    // Fallback: parse git status output.
    try {
      const status = await gitOut(["status", "--porcelain"], worktreeRoot, {}, signal);
      const paths: string[] = [];
      for (const line of status.split("\n")) {
        // Conflicted files show as "UU <path>" or "UU\t<path>".
        const match = line.match(/^UU[\t ]+(.+)$/);
        if (match) {
          paths.push(match[1]);
        }
      }
      return paths.sort();
    } catch (fallbackError) {
      if (signal?.aborted) throw fallbackError;
      return [];
    }
  }
}

/** Get Git diagnostics for the conflict. */
async function getConflictDiagnostics(
  worktreeRoot: string,
  originalError?: unknown,
  signal?: AbortSignal,
): Promise<string> {
  const parts: string[] = [];

  if (originalError instanceof Error) {
    parts.push(`cherry-pick error: ${originalError.message}`);
  }

  try {
    const status = await gitOut(["status", "--short"], worktreeRoot, {}, signal);
    parts.push(`git status:\n${status}`);
  } catch (error) {
    if (signal?.aborted) throw error;
    parts.push("git status: unavailable");
  }

  try {
    const diff = await gitOut(["diff", "--name-only", "--diff-filter=U"], worktreeRoot, {}, signal);
    parts.push(`conflicted files:\n${diff}`);
  } catch (error) {
    if (signal?.aborted) throw error;
    parts.push("conflicted files: unavailable");
  }

  return parts.join("\n\n");
}

/** Like gitOut but returns raw buffer output (for NUL-safe parsing). */
async function gitOutBuffer(args: string[], cwd: string, signal?: AbortSignal): Promise<string> {
  const { stdout } = await execFileAsync(
    "git",
    args,
    {
      cwd,
      env: { ...process.env, ...GIT_ENV },
      timeout: 30_000,
      encoding: "utf8",
      signal,
      maxBuffer: 64 * 1024 * 1024,
    },
  );
  return stdout;
}

// ── main integration ─────────────────────────────────────────────────────────

/**
 * Integrate accepted worker commits into a single integrated history.
 *
 * Given a WaveCaptureResult and an ordered list of selected worker results
 * (taskId + commitSha), this function:
 * 1. Validates each commit matches its pinned workers/<task-id> ref and
 *    has the wave base as its sole parent.
 * 2. Creates a dedicated integration worktree at the base.
 * 3. Fast-forwards to the first selected worker (preserving its original
 *    commit hash).
 * 4. Cherry-picks remaining workers in declared input order.
 * 5. On success, pins the final HEAD under the integrated ref and returns
 *    structured mappings.
 * 6. On conflict, stops without touching the source workspace, preserves
 *    the conflicted integration worktree, and returns diagnostics.
 * 7. On empty selection, pins the base under the integrated ref.
 *
 * This function does NOT:
 * - Perform semantic validation (validationStatus is always 'not_run').
 * - Land or merge into any source branch.
 * - Manage scheduling or manifests.
 * - Wire to external tools.
 */
export async function integrateWave(
  capture: WaveCaptureResult,
  selectedWorkers: SelectedWorker[],
  signal?: AbortSignal,
  hooks: WaveIntegrationHooks = {},
): Promise<WaveIntegrationResult> {
  const { waveId, baseCommit } = capture;

  // Validate waveId.
  validateSafeId(waveId, "waveId");

  // ── Handle empty selection ──
  if (selectedWorkers.length === 0) {
    const worktree = await createIntegrationWorktree(capture, signal);
    const integratedRef = integrationRefName(waveId);
    await pinCommit(capture, baseCommit, { type: "integration" }, signal);

    return {
      status: "no_changes",
      baseCommitSha: baseCommit,
      integratedRef,
      worktree: worktree.worktreeRoot,
      workerMappings: [],
      validationStatus: "not_run",
    };
  }

  // ── Validate all worker commits before touching any worktree ──
  for (const worker of selectedWorkers) {
    await validateWorkerCommit(capture, worker, signal);
  }

  // Regression seam: allow tests to inject errors before worktree creation.
  if (hooks.beforeWorktree) {
    await hooks.beforeWorktree();
  }

  // ── Create the integration worktree at the base ──
  const worktree = await createIntegrationWorktree(capture, signal);
  const worktreeRoot = worktree.worktreeRoot;

  // Regression seam: allow tests to inject errors after worktree creation.
  if (hooks.afterWorktree) {
    await hooks.afterWorktree();
  }

  // ── Fast-forward to the first selected worker ──
  const firstWorker = selectedWorkers[0];
  await gitCmd(["reset", "--hard", firstWorker.commitSha], worktreeRoot, {}, signal);

  // Verify the fast-forward preserved the original commit hash.
  const firstHead = await gitOut(["rev-parse", "HEAD"], worktreeRoot, {}, signal);
  if (firstHead !== firstWorker.commitSha) {
    throw new Error(
      `Fast-forward to first worker ${firstWorker.taskId} did not preserve commit hash. ` +
      `Expected ${firstWorker.commitSha}, got ${firstHead}.`,
    );
  }

  const workerMappings: IntegratedWorkerMapping[] = [
    {
      taskId: firstWorker.taskId,
      originalCommitSha: firstWorker.commitSha,
      integratedCommitSha: firstWorker.commitSha,
      order: 1,
    },
  ];

  // ── Cherry-pick remaining workers in declared order ──
  for (let i = 1; i < selectedWorkers.length; i++) {
    const worker = selectedWorkers[i];
    const result = await cherryPickCommit(worktreeRoot, worker.commitSha, signal);

    if (!result.success) {
      // Conflict — return structured diagnostics without pinning.
      return {
        status: "conflicted",
        successfullyIntegrated: workerMappings,
        conflictingTaskId: worker.taskId,
        conflictingCommitSha: worker.commitSha,
        conflictingPaths: result.conflictingPaths,
        gitDiagnostics: result.gitDiagnostics,
        worktree: worktreeRoot,
      };
    }

    workerMappings.push({
      taskId: worker.taskId,
      originalCommitSha: worker.commitSha,
      integratedCommitSha: result.newHead,
      order: i + 1,
    });
  }

  // ── Pin the final integrated HEAD ──
  const finalHead = await gitOut(["rev-parse", "HEAD"], worktreeRoot, {}, signal);
  const integratedRef = integrationRefName(waveId);
  await pinCommit(capture, finalHead, { type: "integration" }, signal);

  return {
    status: "integrated",
    integratedRef,
    finalCommitSha: finalHead,
    worktree: worktreeRoot,
    workerMappings,
    validationStatus: "not_run",
  };
}
