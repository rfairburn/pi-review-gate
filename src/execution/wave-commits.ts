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

/** Optional durable prior candidate identity for normalization. */
export interface PriorCandidate {
  /** SHA of the previous candidate commit. */
  commitSha: string;
  /** SHA of the previous candidate tree (resolved from the commit when omitted). */
  treeSha?: string;
  /** Ref under which the previous candidate is durably pinned (verified read-only). */
  ref?: string;
}

/** All-zero object name used as the expected-old-value for create-only ref updates. */
const SHA1_ZERO_SHA = "0000000000000000000000000000000000000000";
const SHA256_ZERO_SHA = "0".repeat(64);

const TREE_SHA_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

const zeroShaCache = new Map<string, string>();

/** Resolve the all-zero object name for a repository's object format. */
async function zeroShaFor(repoPath: string): Promise<string> {
  const cached = zeroShaCache.get(repoPath);
  if (cached) return cached;
  const format = await gitOut(["rev-parse", "--show-object-format"], repoPath).catch(() => "sha1");
  const zero = format.trim() === "sha256" ? SHA256_ZERO_SHA : SHA1_ZERO_SHA;
  zeroShaCache.set(repoPath, zero);
  return zero;
}

/**
 * Resolve the immutable, content-addressed candidate snapshot ref name for a
 * worker task and tree. The ref is create-once: it pins exactly one commit
 * that proves the recorded tree/base/wave/task identity.
 */
export function candidateSnapshotRefName(waveId: string, taskId: string, treeSha: string): string {
  validateSafeId(waveId, "waveId");
  validateSafeId(taskId, "taskId");
  if (!TREE_SHA_PATTERN.test(treeSha)) {
    throw new Error(`Invalid treeSha: "${treeSha}". Must be a full 40-hex object name.`);
  }
  return `refs/pi-review-gate/waves/${waveId}/candidate-snapshots/${taskId}/${treeSha}`;
}

/**
 * Resolve the immutable per-cycle review alias ref name. Cycle numbers are
 * 1-based and zero-padded to six digits.
 */
export function reviewCycleAliasRefName(waveId: string, taskId: string, cycle: number): string {
  validateSafeId(waveId, "waveId");
  validateSafeId(taskId, "taskId");
  if (!Number.isInteger(cycle) || cycle < 1 || cycle > 999_999) {
    throw new Error(`Invalid review cycle: ${cycle}. Must be an integer between 1 and 999999.`);
  }
  return `refs/pi-review-gate/waves/${waveId}/review-candidates/${taskId}/cycle-${String(cycle).padStart(6, "0")}`;
}

/**
 * Resolve the legacy mutable candidate ref name. Legacy refs are strict
 * read-only compatibility inputs: existing code never writes them.
 */
export function candidateRefName(waveId: string, taskId: string): string {
  validateSafeId(waveId, "waveId");
  validateSafeId(taskId, "taskId");
  return `refs/pi-review-gate/waves/${waveId}/candidates/${taskId}`;
}

/**
 * Resolve the legacy mutable recovery ref name. Legacy refs are strict
 * read-only compatibility inputs: existing code never writes them.
 */
export function recoveryRefName(waveId: string, taskId: string): string {
  validateSafeId(waveId, "waveId");
  validateSafeId(taskId, "taskId");
  return `refs/pi-review-gate/waves/${waveId}/recovery/${taskId}`;
}

/**
 * Explicit continuation lineage for wave identity verification. The root
 * wave id and the verifying capture's generation are carried by the capture
 * itself; lineage is never inferred from arbitrary wave-id text, so valid
 * original wave ids that happen to end in "-gN" keep their own identity.
 */
export interface WaveLineage {
  /** Root (original) wave identity of the continuation chain. */
  rootWaveId: string;
  /** Continuation generation of the verifying capture (0 = original wave). */
  generation: number;
}

/** The capture fields that identify a wave's immutable ref namespace and lineage. */
export type WaveIdentityCapture = Pick<
  WaveCaptureResult,
  "waveId" | "repositoryPath" | "baseCommit" | "rootWaveId" | "continuationGeneration"
>;

/**
 * Resolve the explicit continuation lineage recorded on a capture.
 *
 * Original captures (and pre-lineage records) carry no lineage fields and
 * are generation 0 of their own root wave. Continuation captures must carry
 * both fields, and their wave id must be exactly "<root>-g<generation>" —
 * any inconsistency fails closed instead of guessing a lineage.
 */
export function waveLineageOf(
  capture: Pick<WaveCaptureResult, "waveId" | "rootWaveId" | "continuationGeneration">,
): WaveLineage {
  const { waveId, rootWaveId, continuationGeneration } = capture;
  if (rootWaveId === undefined && continuationGeneration === undefined) {
    return { rootWaveId: waveId, generation: 0 };
  }
  if (typeof rootWaveId !== "string" || rootWaveId.length === 0) {
    throw new Error("Invalid continuation lineage: rootWaveId is missing.");
  }
  validateSafeId(rootWaveId, "rootWaveId");
  if (typeof continuationGeneration !== "number" || !Number.isInteger(continuationGeneration) || continuationGeneration < 0) {
    throw new Error(
      `Invalid continuation lineage: generation must be a non-negative integer, got ${String(continuationGeneration)}.`,
    );
  }
  const generation = continuationGeneration;
  const expectedWaveId = generation === 0 ? rootWaveId : `${rootWaveId}-g${generation}`;
  if (waveId !== expectedWaveId) {
    throw new Error(
      `Invalid continuation lineage: waveId "${waveId}" does not match recorded root wave ` +
        `"${rootWaveId}" at generation ${generation} (expected "${expectedWaveId}").`,
    );
  }
  return { rootWaveId, generation };
}

/**
 * Whether a commit's Wave-Id trailer belongs to the explicit continuation
 * chain identified by `lineage`. Accepted values are exactly the wave ids
 * of each generation from the root (generation 0) up to and including the
 * lineage generation, so later generations can adopt candidates created by
 * earlier generations of the same chain — and only that chain. Only the
 * suffix after the recorded root prefix is interpreted; a valid original
 * wave id ending in "-gN" is never re-parsed as someone else's base.
 */
function trailerMatchesLineage(trailerWaveId: string, lineage: WaveLineage): boolean {
  if (trailerWaveId === lineage.rootWaveId) return true;
  const prefix = `${lineage.rootWaveId}-g`;
  if (!trailerWaveId.startsWith(prefix)) return false;
  const suffix = trailerWaveId.slice(prefix.length);
  // Reject leading zeros and non-canonical numerals: continuation wave ids
  // are always rendered as "<root>-g<N>" with N in canonical decimal form.
  if (!/^\d+$/.test(suffix) || String(Number(suffix)) !== suffix) return false;
  const generation = Number(suffix);
  return generation >= 1 && generation <= lineage.generation;
}

/** A single Git trailer line: an identifier key, a colon, then its value. */
const TRAILER_LINE_PATTERN = /^([A-Za-z][A-Za-z0-9._-]*):[ \t]*(.*)$/;

/**
 * Parse the final Git trailer block of a commit message into (key, value)
 * pairs.
 *
 * The trailer block is the run of lines after the message's last blank
 * line: Git requires trailers to be separated from the title/body by a
 * blank line, and only that final block is trusted here. Title or body text
 * that merely looks like a trailer (for example a task titled "Wave-Id:
 * example") can therefore never be mistaken for identity data. If the final
 * region contains any non-trailer line the whole block is rejected so
 * identity verification fails closed.
 */
function parseFinalTrailerBlock(message: string): Array<[string, string]> {
  const lines = message.split("\n");
  let lastBlank = -1;
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (lines[i].trim() === "") {
      lastBlank = i;
      break;
    }
  }
  if (lastBlank < 0) return [];
  const entries: Array<[string, string]> = [];
  for (const line of lines.slice(lastBlank + 1)) {
    const match = TRAILER_LINE_PATTERN.exec(line);
    if (!match) return [];
    entries.push([match[1], match[2].trim()]);
  }
  return entries;
}

/**
 * Read one trailer key from a parsed trailer block. Conflicting duplicate
 * values are treated as missing so identity verification fails closed.
 */
function trailerValue(entries: Array<[string, string]>, key: string): string | undefined {
  const values = entries.filter(([entryKey]) => entryKey === key).map(([, value]) => value);
  if (values.length === 0) return undefined;
  if (new Set(values).size > 1) return undefined;
  return values[0];
}

/** Identity proof read from a candidate commit object. */
interface CommitIdentityProof {
  treeSha: string;
  parentShas: string[];
  waveId?: string;
  taskId?: string;
}

/** Read the identity proof fields from a commit object. */
async function readCommitIdentityProof(repoPath: string, commitSha: string): Promise<CommitIdentityProof> {
  const raw = await gitOut(["show", "-s", "--format=%T%n%P%n%B", commitSha], repoPath);
  const lines = raw.split("\n");
  const treeSha = (lines[0] ?? "").trim();
  const parentLine = (lines[1] ?? "").trim();
  const message = lines.slice(2).join("\n");
  const trailers = parseFinalTrailerBlock(message);
  const waveId = trailerValue(trailers, "Wave-Id");
  const taskId = trailerValue(trailers, "Task-Id");
  return {
    treeSha,
    parentShas: parentLine === "" ? [] : parentLine.split(/\s+/),
    waveId,
    taskId,
  };
}

/** Verify a commit proves the recorded tree/base/wave/task identity, or throw. */
export async function verifyCandidateCommitIdentity(
  repoPath: string,
  expectation: {
    commitSha: string;
    treeSha?: string;
    baseCommit: string;
    lineage: WaveLineage;
    taskId: string;
  },
): Promise<void> {
  let proof: CommitIdentityProof;
  try {
    proof = await readCommitIdentityProof(repoPath, expectation.commitSha);
  } catch (error) {
    throw new Error(
      `Candidate commit ${expectation.commitSha} could not be read to prove its identity: ` +
        `${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (expectation.treeSha !== undefined && proof.treeSha !== expectation.treeSha) {
    throw new Error(
      `Candidate commit ${expectation.commitSha} does not prove the recorded tree identity: ` +
        `commit tree is ${proof.treeSha}, expected ${expectation.treeSha}.`,
    );
  }
  if (proof.parentShas.length !== 1 || proof.parentShas[0] !== expectation.baseCommit) {
    throw new Error(
      `Candidate commit ${expectation.commitSha} does not prove the base identity: ` +
        `expected sole parent ${expectation.baseCommit}, got [${proof.parentShas.join(", ") || "none"}].`,
    );
  }
  if (!proof.waveId || !trailerMatchesLineage(proof.waveId, expectation.lineage)) {
    throw new Error(
      `Candidate commit ${expectation.commitSha} does not prove the wave identity: ` +
        `commit Wave-Id is "${proof.waveId ?? "missing"}", expected root wave ` +
        `"${expectation.lineage.rootWaveId}" at generation 0..${expectation.lineage.generation}.`,
    );
  }
  if (proof.taskId !== expectation.taskId) {
    throw new Error(
      `Candidate commit ${expectation.commitSha} does not prove the task identity: ` +
        `commit Task-Id is "${proof.taskId ?? "missing"}", expected "${expectation.taskId}".`,
    );
  }
}

/**
 * Verify that a recovery checkpoint's ref is one of the allowed durable forms
 * for exactly `taskId` within the explicit continuation chain identified by
 * `lineage`:
 *
 *   refs/pi-review-gate/waves/<wave>/candidate-snapshots/<task>/<tree>
 *   refs/pi-review-gate/waves/<wave>/candidates/<task>      (legacy, read-only)
 *   refs/pi-review-gate/waves/<wave>/recovery/<task>        (legacy, read-only)
 *
 * where `<wave>` is any wave id of the chain (the root, or the canonical
 * <root>-g1..gN up to and including the lineage generation), `<task>` is
 * exactly `taskId`, and — for content-addressed snapshot refs — `<tree>` is
 * a full object name equal to `treeSha` when supplied. Any other ref shape,
 * task, or wave identity fails closed so a checkpoint from another task or
 * wave can never be restored into this operation's worktree.
 */
export function verifyCheckpointRefPath(
  ref: string,
  taskId: string,
  lineage: WaveLineage,
  treeSha?: string,
): void {
  const parts = ref.split("/");
  if (parts.length !== 6 && parts.length !== 7) {
    throw new Error(`Recovery checkpoint ref is not an allowed candidate or recovery form: ${ref}.`);
  }
  if (parts[0] !== "refs" || parts[1] !== "pi-review-gate" || parts[2] !== "waves") {
    throw new Error(`Recovery checkpoint ref is outside the protected namespace: ${ref}.`);
  }
  const waveSegment = parts[3];
  const kind = parts[4];
  if (parts[5] !== taskId) {
    throw new Error(
      `Recovery checkpoint ref ${ref} does not belong to task "${taskId}"; refusing to restore a foreign checkpoint.`,
    );
  }
  if (!trailerMatchesLineage(waveSegment, lineage)) {
    throw new Error(
      `Recovery checkpoint ref ${ref} is outside the wave chain rooted at "${lineage.rootWaveId}" ` +
        `(generation 0..${lineage.generation}); refusing to restore a foreign checkpoint.`,
    );
  }
  if (kind === "candidate-snapshots") {
    if (parts.length !== 7) {
      throw new Error(`Recovery checkpoint ref is not an allowed candidate or recovery form: ${ref}.`);
    }
    const treeSegment = parts[6];
    if (!TREE_SHA_PATTERN.test(treeSegment)) {
      throw new Error(`Recovery checkpoint ref ${ref} is not a content-addressed candidate snapshot form.`);
    }
    if (treeSha !== undefined && treeSegment !== treeSha) {
      throw new Error(
        `Recovery checkpoint ref ${ref} records tree ${treeSegment}, but the checkpoint records ${treeSha}.`,
      );
    }
  } else if (kind === "candidates" || kind === "recovery") {
    if (parts.length !== 6) {
      throw new Error(`Recovery checkpoint ref is not an allowed candidate or recovery form: ${ref}.`);
    }
  } else {
    throw new Error(`Recovery checkpoint ref is not an allowed candidate or recovery form: ${ref}.`);
  }
}

/**
 * Create-once immutable ref update. If the ref already exists, its current
 * target is returned after passing the adopt check; otherwise the ref is
 * created with atomic create-only update-ref semantics (expected old value
 * is the all-zero object name). Concurrent creators race safely: the loser
 * re-reads the winner's target and must adopt it or fail closed.
 */
async function ensureImmutableRef(
  repoPath: string,
  ref: string,
  newSha: string,
  adopt?: (existingSha: string) => Promise<void> | void,
): Promise<string> {
  const existing = await gitOut(["rev-parse", "--verify", ref], repoPath).catch(() => "");
  if (existing !== "") {
    if (adopt) await adopt(existing);
    return existing;
  }
  try {
    await gitCmd(["update-ref", ref, newSha, await zeroShaFor(repoPath)], repoPath);
    return newSha;
  } catch (error) {
    const raced = await gitOut(["rev-parse", "--verify", ref], repoPath).catch(() => "");
    if (raced === "") {
      throw error;
    }
    if (adopt) await adopt(raced);
    return raced;
  }
}

/**
 * Return every tracked, untracked, or ignored workspace change. Research uses
 * this stricter check because ordinary candidate normalization deliberately
 * omits ignored files from execution landing.
 */
export async function researchWorkspaceChanges(worktreeRoot: string): Promise<string[]> {
  const output = await gitOutBuffer([
    "status",
    "--porcelain=v1",
    "-z",
    "--untracked-files=all",
    "--ignored=matching",
  ], worktreeRoot);
  return output.split("\0").map((entry) => entry.trim()).filter(Boolean);
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
 * Pin (create-once) or adopt the immutable candidate snapshot ref for a tree.
 *
 * The ref target must prove the same tree/base/wave/task identity; an
 * existing ref that fails the identity proof fails closed. Returns the
 * adopted or created commit SHA, which may differ from `createCommitSha`
 * when an equal-identity commit already won the race.
 */
async function ensureCandidateSnapshotRef(
  capture: WaveCaptureResult,
  taskId: string,
  treeSha: string,
  createCommitSha: string,
): Promise<{ ref: string; commitSha: string }> {
  const ref = candidateSnapshotRefName(capture.waveId, taskId, treeSha);
  const lineage = waveLineageOf(capture);
  const adoptedSha = await ensureImmutableRef(
    capture.repositoryPath,
    ref,
    createCommitSha,
    (existingSha) => verifyCandidateCommitIdentity(capture.repositoryPath, {
      commitSha: existingSha,
      treeSha,
      baseCommit: capture.baseCommit,
      lineage,
      taskId,
    }),
  );
  return { ref, commitSha: adoptedSha };
}

/**
 * Pin the immutable per-cycle review alias for one reviewed candidate.
 *
 * The candidate commit must prove the recorded tree/base/wave/task identity
 * before the alias is created. The alias is create-once: re-pinning the same
 * cycle with the same commit is idempotent, while any attempt to record a
 * different commit under an existing cycle alias fails closed and leaves the
 * alias untouched.
 */
export async function pinReviewCycleCandidate(
  capture: WaveIdentityCapture,
  taskId: string,
  cycle: number,
  candidate: { commitSha: string; treeSha: string },
): Promise<string> {
  const ref = reviewCycleAliasRefName(capture.waveId, taskId, cycle);
  await verifyCandidateCommitIdentity(capture.repositoryPath, {
    commitSha: candidate.commitSha,
    treeSha: candidate.treeSha,
    baseCommit: capture.baseCommit,
    lineage: waveLineageOf(capture),
    taskId,
  });
  await ensureImmutableRef(
    capture.repositoryPath,
    ref,
    candidate.commitSha,
    (existingSha) => {
      if (existingSha !== candidate.commitSha) {
        throw new Error(
          `Review cycle alias ${ref} is immutable and points to ${existingSha}; ` +
            `refusing to record candidate ${candidate.commitSha} for cycle ${cycle}.`,
        );
      }
    },
  );
  return ref;
}

/**
 * Re-verify (read-only) that a review cycle alias still pins the exact
 * reviewed candidate identity before patch generation or verdict acceptance.
 */
export async function verifyReviewCycleIdentity(
  capture: WaveIdentityCapture,
  taskId: string,
  aliasRef: string,
  candidate: { commitSha: string; treeSha: string },
): Promise<void> {
  const pinned = await gitOut(["rev-parse", "--verify", aliasRef], capture.repositoryPath).catch(() => "");
  if (pinned !== candidate.commitSha) {
    throw new Error(
      `Review cycle alias ${aliasRef} points to ${pinned || "nothing"}; ` +
        `expected the reviewed candidate ${candidate.commitSha}.`,
    );
  }
  await verifyCandidateCommitIdentity(capture.repositoryPath, {
    commitSha: candidate.commitSha,
    treeSha: candidate.treeSha,
    baseCommit: capture.baseCommit,
    lineage: waveLineageOf(capture),
    taskId,
  });
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
 * 5. Pins the candidate under a create-once, content-addressed
 *    candidate-snapshots/<task-id>/<tree-sha> ref that proves the recorded
 *    tree/base/wave/task identity. Equal-tree candidates (including a
 *    supplied durable prior candidate) adopt the existing proven commit
 *    instead of creating a parallel one; any existing ref that fails the
 *    identity proof fails closed.
 * 6. Returns commit/tree/ref metadata and whether the tree differs from base.
 *
 * Re-normalization never stacks correction commits and never mutates legacy
 * candidates/<task-id> or recovery/<task-id> refs. Legacy prior refs are
 * verified strictly read-only and migrated lazily onto the immutable
 * snapshot namespace when a continuation adopts them.
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

  // Resolve the explicit continuation lineage before any Git mutation so an
  // inconsistent capture (waveId vs recorded root/generation) fails closed
  // without touching the worktree.
  const lineage = waveLineageOf(capture);

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

  // ── Resolve the durable candidate identity ──
  // A supplied prior candidate is verified strictly read-only (its ref must
  // still pin its recorded commit). When the new tree matches the prior
  // tree, the prior commit is adopted after proving the same
  // tree/base/wave/task identity — this carries the durable checkpoint's
  // actual ref forward instead of creating a parallel candidate.
  let commitSha = await adoptPriorCandidate(
    repoPath,
    lineage,
    taskId,
    baseCommit,
    treeSha,
    priorCandidate,
  );

  // ── Create the candidate commit with base as sole parent ──
  if (!commitSha) {
    commitSha = await createCommitWithParent(
      worktreeRoot,
      treeSha,
      baseCommit,
      message,
    );
  }

  // ── Pin the candidate under a create-once, content-addressed ref ──
  // Equal-tree candidates (including concurrent races) adopt the existing
  // commit that proves the same identity; anything else fails closed.
  const pinned = await ensureCandidateSnapshotRef(capture, taskId, treeSha, commitSha);
  commitSha = pinned.commitSha;
  const candidateRef = pinned.ref;

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
 * Verify a supplied prior candidate strictly (read-only) and return its
 * commit SHA when the new tree matches the prior tree, or undefined when the
 * tree differs and a fresh candidate must be created. Legacy mutable prior
 * refs are accepted only while they still pin the recorded commit.
 */
async function adoptPriorCandidate(
  repoPath: string,
  lineage: WaveLineage,
  taskId: string,
  baseCommit: string,
  treeSha: string,
  priorCandidate: PriorCandidate | undefined,
): Promise<string | undefined> {
  if (!priorCandidate) return undefined;
  if (priorCandidate.ref) {
    const pinned = await gitOut(["rev-parse", "--verify", priorCandidate.ref], repoPath).catch(() => "");
    if (pinned !== priorCandidate.commitSha) {
      throw new Error(
        `Prior candidate ref ${priorCandidate.ref} points to ${pinned || "nothing"}, ` +
          `expected ${priorCandidate.commitSha}. Refusing to continue from an unverified prior candidate.`,
      );
    }
  }
  const priorTree = priorCandidate.treeSha
    ?? await gitOut(["rev-parse", `${priorCandidate.commitSha}^{tree}`], repoPath);
  if (priorTree !== treeSha) return undefined;
  await verifyCandidateCommitIdentity(repoPath, {
    commitSha: priorCandidate.commitSha,
    treeSha,
    baseCommit,
    lineage,
    taskId,
  });
  return priorCandidate.commitSha;
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
