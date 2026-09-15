/**
 * Explicit worker-work salvage (#126).
 *
 * When an explicit SubtasksForceMerge cannot land the ordinary verified
 * checkpoint (missing checkpoint, attached-HEAD checkpoint failure,
 * failed_critical, interrupted state, or other ordinary lifecycle
 * inconsistency), this module identifies and captures a snapshot of the
 * actual work the worker produced:
 *
 * - retained commits (worker-created history on top of the captured base),
 * - staged and unstaged edits to tracked files,
 * - task-created (untracked, non-ignored) files.
 *
 * The capture is non-destructive: it never resets, checks out, or mutates the
 * worker worktree or its real index. A private temporary index under a scratch
 * directory stages the worktree contents; the salvage candidate commit has the
 * synthetic wave base as its sole parent so the ordinary tree-diff landing
 * machinery applies unchanged.
 *
 * Attribution is evidence-based and conservative:
 * - The captured base is synthetic: it contains the target's uncommitted
 *   files, which no source branch can contain. A path present in the base but
 *   absent from the source's own history is a baseline-only file abandoned by
 *   the source checkout — never an assumed worker deletion.
 * - When the source HEAD derives from the captured base, every delta against
 *   the base is session-local and attributed to the worker.
 * - Otherwise (divergent or disjoint source history) attribution is per path:
 *   worktree-local edits are always attributed; committed changes are
 *   attributed only when every commit that touched the path since the shared
 *   ancestor was created during this task's session, proven by object
 *   identity against the target repository (a pre-existing commit object
 *   exists in the source repository; a worker-created one does not). Branch
 *   names and timestamps locate candidates but never prove ownership on their
 *   own; anything ambiguous is excluded from the transfer and reported, never
 *   guessed.
 *
 * Salvage records forced-salvage provenance durably (task command + operation
 * incident), preserves source evidence, asserts no review status, publishes no
 * continuation bundle for unverified work, and never auto-lands deferred work
 * afterward.
 */

import { execFile, spawnSync } from "node:child_process";
import { mkdtemp, realpath as fsRealpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { promisify } from "node:util";
import type { OperationRecord } from "./operation-record";
import type { WaveCaptureResult } from "./wave-repository";
import {
  createCommitWithParent,
  ensureCandidateSnapshotRef,
  verifyCandidateCommitIdentity,
  waveLineageOf,
  type CandidateCommit,
} from "./wave-commits";

const execFileAsync = promisify(execFile);

/** Bound the session-history walk; beyond this, attribution is refused as ambiguous. */
const MAX_SESSION_COMMITS = 10_000;
/** Bound per-path commit evidence; beyond this, the path is ambiguous. */
const MAX_PATH_COMMITS = 500;

export interface SalvagePathClassification {
  /** Paths whose content is proven worker work and is transferred. */
  attributedPaths: string[];
  /** Base-only paths the source's checkout abandoned; never treated as deletions. */
  baselineOnlyPaths: string[];
  /** Paths that differ from the base but whose ownership could not be proven; not transferred. */
  ambiguousPaths: string[];
}

/** An identified, pinned snapshot of salvaged worker work. */
export interface SalvageCandidateIdentity extends CandidateCommit, SalvagePathClassification {
  sourceKind: "worktree" | "retained_ref";
  /** Worktree HEAD at capture time (worktree sources). */
  headSha?: string;
  /** Attached branch name at capture time (worktree sources on a branch). */
  branchName?: string;
  /** Ref salvaged from (retained-ref sources). */
  refName?: string;
}

/** A surviving ref in the private repository with content differing from the base.
 * Candidates whose delta is entirely ambiguous are listed (and named in
 * unresolved outcomes) but never selected for transfer. */
export interface SalvageRefCandidate extends SalvagePathClassification {
  refName: string;
  tipSha: string;
  /** True when the ref name appears in this task's durable checkpoint-failure incidents. */
  incidentNamed: boolean;
  /** Committer timestamp (ISO) of the newest session commit on the ref, if any.
   * Timestamps are reported as evidence only; they never establish ownership. */
  latestSessionCommitAt?: string;
  /** True when the ref lives in this task's own immutable namespace and its
   * commit proves the task identity (wave/task trailers + base parent) —
   * ownership by construction, not by name or timestamp guessing. */
  taskOwned?: boolean;
}

/** #126 correction: how a salvage candidate relates to a verified checkpoint's tree. */
export interface CheckpointSupersession {
  /** Attributed paths whose content differs from the checkpoint's tree — identified work the checkpoint does not carry. */
  beyondPaths: string[];
  /** True when the candidate preserves every path of the checkpoint's delta with the same content or an attributed newer version. */
  subsumesCheckpoint: boolean;
}

export type SalvageSourceSelection =
  | { kind: "none"; reason: string }
  | { kind: "ref"; candidate: SalvageRefCandidate; unselected: SalvageRefCandidate[] }
  | { kind: "ambiguous"; candidates: SalvageRefCandidate[] };

// ── git helpers (read-only except temporary-index staging) ───────────────────

async function gitOut(repoPath: string, args: readonly string[], env?: Record<string, string>): Promise<string> {
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["-C", repoPath, ...args],
      { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", ...env } },
    );
    return stdout;
  } catch (error) {
    const stderr = (error as { stderr?: string }).stderr?.trim();
    throw new Error(stderr ? `git ${args[0]} failed: ${stderr}` : `git ${args[0]} failed`);
  }
}

export async function treeShaOf(repoPath: string, commitSha: string): Promise<string> {
  return (await gitOut(repoPath, ["rev-parse", `${commitSha}^{tree}`])).trim();
}

/** All file paths in a tree, or undefined when the tree cannot be read. */
async function treeFileSet(repoPath: string, treeSha: string): Promise<Set<string>> {
  const out = await gitOut(repoPath, ["ls-tree", "-r", "--name-only", "-z", treeSha]);
  return new Set(out.split("\0").filter(Boolean));
}

async function diffPaths(repoPath: string, a: string, b: string): Promise<string[]> {
  // --no-renames: attribution must match planWaveLanding's rename-free delta
  // derivation, independent of the ambient diff.renames configuration. A
  // rename classifies as an addition plus a deletion and is reported as such.
  const out = await gitOut(repoPath, ["diff", "--name-only", "--no-renames", "-z", a, b]);
  return out.split("\0").filter(Boolean);
}

/** Lexical root used to confine symlink targets when the source is a retained
 * ref and no live worktree exists; the check is pure path algebra. */
const SALVAGE_SYMLINK_LEXICAL_ROOT = "/worker-worktree";

/** Mirror of ordinary candidate normalization's symlink validation (fail
 * closed): relative targets that stay inside the worker root are allowed to
 * transfer; absolute or escaping targets refuse the salvage. */
export function assertConfinedSymlinkTarget(root: string, relPath: string, rawTarget: string): void {
  if (isAbsolute(rawTarget)) {
    throw new Error(`Worker work contains a symlink with an absolute target ("${relPath}" -> ${rawTarget.trim()}); refusing to salvage it.`);
  }
  const resolved = resolve(dirname(join(root, relPath)), rawTarget);
  if (!resolved.startsWith(root + sep) && resolved !== root) {
    throw new Error(`Worker work contains a symlink that escapes the worker root ("${relPath}" -> ${rawTarget.trim()}); refusing to salvage it.`);
  }
}

/** merge-base, or undefined for disjoint histories. */
async function mergeBaseOf(repoPath: string, a: string, b: string): Promise<string | undefined> {
  try {
    const out = await gitOut(repoPath, ["merge-base", a, b]);
    const sha = out.trim();
    return sha || undefined;
  } catch {
    return undefined;
  }
}

/**
 * Prove which of the supplied commit objects already exist in the target
 * repository. The private repository was cloned from the target at capture
 * time, so an object that exists in both stores is pre-existing work; a
 * worker-created commit has no counterpart there. This is exact object
 * identity, not a branch or timestamp heuristic.
 */
function preexistingInSource(sourceRoot: string, shas: readonly string[]): Set<string> {
  if (shas.length === 0) return new Set();
  const result = spawnSync(
    "git",
    ["-C", sourceRoot, "cat-file", "--batch-check=%(objectname) %(objecttype)"],
    {
      input: `${shas.join("\n")}\n`,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
      env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
    },
  );
  if (result.error || result.status !== 0) {
    // The target repository is unavailable or unreadable: pre-existence cannot
    // be proven, so nothing committed may be attributed (conservative).
    return new Set(["__unavailable__"]);
  }
  const existing = new Set<string>();
  for (const line of (result.stdout ?? "").split("\n")) {
    if (!line.trim()) continue;
    const [sha, type] = line.split(" ");
    if (sha && type && type !== "missing") existing.add(sha);
  }
  return existing;
}

// ── attribution ──────────────────────────────────────────────────────────────

/**
 * Classify every path that differs between the synthetic base and `finalTree`
 * (the source's final content) as attributed, baseline-only, or ambiguous.
 *
 * `headSha` is the commit the source content was based on (the worktree HEAD
 * for worktree sources, the ref tip for retained-ref sources). `dirtyBaseTree`
 * is the tree of exactly that commit: paths differing between it and
 * `finalTree` are worktree-local edits made during the session.
 */
export async function classifySalvagePaths(
  capture: WaveCaptureResult,
  headSha: string,
  finalTree: string,
): Promise<SalvagePathClassification> {
  const repoPath = capture.repositoryPath;
  const baseCommit = capture.baseCommit;
  const empty: SalvagePathClassification = { attributedPaths: [], baselineOnlyPaths: [], ambiguousPaths: [] };
  const baseTree = await treeShaOf(repoPath, baseCommit);
  if (finalTree === baseTree) return empty;

  const delta = await diffPaths(repoPath, baseTree, finalTree);
  const headTree = await treeShaOf(repoPath, headSha);

  // Fast path: the source derives from the captured base. Every delta against
  // the base is session-local — retained commits made on top of the base plus
  // worktree edits. The synthetic base's uncommitted files were checked out
  // into the worktree, so even deletions here are worker-requested.
  if (headSha === baseCommit || (await mergeBaseOf(repoPath, headSha, baseCommit)) === baseCommit) {
    return { attributedPaths: delta, baselineOnlyPaths: [], ambiguousPaths: [] };
  }

  // Divergent or disjoint source history: attribute per path.
  const dirtyDelta = new Set(await diffPaths(repoPath, headTree, finalTree));
  const pivot = await mergeBaseOf(repoPath, headSha, baseCommit);
  const pivotFiles = pivot ? await treeFileSet(repoPath, await treeShaOf(repoPath, pivot)) : undefined;
  const baseFiles = await treeFileSet(repoPath, baseTree);
  const finalFiles = await treeFileSet(repoPath, finalTree);

  // Session commits: reachable from the source HEAD but not from the captured
  // base. Proven against the target repository by object identity.
  let sessionCommits: { sha: string; committerSeconds: number }[] = [];
  let sessionCapExceeded = false;
  try {
    const out = await gitOut(repoPath, ["log", "--format=%H%x09%ct", headSha, `^${baseCommit}`]);
    const lines = out.split("\n").filter(Boolean);
    if (lines.length > MAX_SESSION_COMMITS) {
      sessionCapExceeded = true;
    } else {
      sessionCommits = lines.map((line) => {
        const [sha, ct] = line.split("\t");
        return { sha: sha!, committerSeconds: Number(ct) };
      });
    }
  } catch {
    sessionCapExceeded = true;
  }
  const preexisting = sessionCapExceeded
    ? new Set<string>(["__unavailable__"])
    : preexistingInSource(capture.discovery.captureRoot, sessionCommits.map((c) => c.sha));
  const isSessionCommit = (sha: string): boolean => !preexisting.has("__unavailable__") && !preexisting.has(sha);

  const attributed: string[] = [];
  const baselineOnly: string[] = [];
  const ambiguous: string[] = [];
  for (const path of delta) {
    if (dirtyDelta.has(path)) {
      // Worktree-local edit made during the session, on top of whatever the
      // source HEAD contained.
      attributed.push(path);
      continue;
    }
    // A file present in the synthetic base (possibly only as an uncommitted
    // target file), absent from the final content, and absent from the
    // source's own history was abandoned by the source checkout — never an
    // assumed worker deletion.
    if (baseFiles.has(path) && !finalFiles.has(path) && pivotFiles && !pivotFiles.has(path)) {
      baselineOnly.push(path);
      continue;
    }
    // Committed change between the shared ancestor and the source HEAD.
    let touching: string[] = [];
    try {
      const out = await gitOut(repoPath, ["rev-list", headSha, `^${baseCommit}`, "--", path]);
      touching = out.split("\n").filter(Boolean);
    } catch {
      touching = [];
    }
    if (touching.length === 0 || touching.length > MAX_PATH_COMMITS) {
      ambiguous.push(path);
      continue;
    }
    // Every commit that touched the path since the ancestor must be a session
    // commit; any pre-existing contributor makes the content mixed.
    const allSession = touching.every((sha) => isSessionCommit(sha));
    (allSession ? attributed : ambiguous).push(path);
  }
  return { attributedPaths: attributed, baselineOnlyPaths: baselineOnly, ambiguousPaths: ambiguous };
}

// ── candidate capture ────────────────────────────────────────────────────────

/**
 * #126 correction: compare a salvage candidate's transferred content against a
 * verified checkpoint's tree, so a checkpoint never silently hides newer
 * retained work.
 *
 * `beyondPaths` are attributed paths whose content differs from the
 * checkpoint's tree — identified worker work the checkpoint does not carry.
 * `subsumesCheckpoint` is true only when every path of the checkpoint's delta
 * against the base is preserved by the candidate with identical content, or
 * with provably newer content: `headSha` (when given) must descend from a
 * commit whose tree equals the checkpoint's tree, which proves the candidate
 * was produced after the accepted state. A differing checkpoint-delta path
 * without that ordering proof fails the check instead of being preferred —
 * a worktree switched to an older session branch must never supersede a newer
 * checkpoint.
 */
export async function evaluateCandidateAgainstCheckpoint(
  capture: WaveCaptureResult,
  checkpointTree: string,
  candidateTree: string,
  classification: SalvagePathClassification,
  headSha?: string,
): Promise<CheckpointSupersession> {
  const repoPath = capture.repositoryPath;
  const baseTree = await treeShaOf(repoPath, capture.baseCommit);
  const attributed = new Set(classification.attributedPaths);
  const beyondPaths: string[] = [];
  for (const path of classification.attributedPaths) {
    if (!entriesEqual(await treeEntry(repoPath, candidateTree, path), await treeEntry(repoPath, checkpointTree, path))) {
      beyondPaths.push(path);
    }
  }
  const provablyNewer = headSha ? await isDescendantOfCheckpointTree(repoPath, headSha, checkpointTree) : false;
  let subsumesCheckpoint = true;
  for (const path of await diffPaths(repoPath, baseTree, checkpointTree)) {
    if (entriesEqual(await treeEntry(repoPath, checkpointTree, path), await treeEntry(repoPath, candidateTree, path))) continue;
    if (!attributed.has(path) || !provablyNewer) {
      subsumesCheckpoint = false;
      break;
    }
  }
  return { beyondPaths, subsumesCheckpoint };
}

/**
 * True when some ancestor of `headSha` (bounded to the session-history walk)
 * carries exactly `checkpointTree`. Note this matches on the TREE, not on the
 * checkpoint's candidate commit itself: candidate commits are synthetic
 * snapshots parented on the wave base and are never ancestors of the
 * worktree HEAD. The reachable case is the one that matters — the accepted
 * state was an actual committed worktree state (some session commit carries
 * the checkpoint's tree) and work continued from it, so headSha descends
 * through that commit. When no such ancestor exists (for example the accepted
 * state carried uncommitted content), only identical checkpoint-delta content
 * can prove subsumption; a differing delta path then refuses as ambiguous.
 */
async function isDescendantOfCheckpointTree(repoPath: string, headSha: string, checkpointTree: string): Promise<boolean> {
  // One call collects every ancestor's tree id; a per-commit subprocess walk
  // would stall the force-merge path on long histories.
  let out: string;
  try {
    out = await gitOut(repoPath, ["log", `--max-count=${MAX_SESSION_COMMITS + 1}`, "--format=%T", headSha]);
  } catch {
    return false;
  }
  return out.split("\n").some((line) => line.trim() === checkpointTree);
}

/** Read one file entry (mode + object id) from a tree; undefined when absent. */
async function treeEntry(repoPath: string, treeSha: string, path: string): Promise<{ mode: string; oid: string } | undefined> {
  let out: string;
  try {
    out = await gitOut(repoPath, ["ls-tree", treeSha, "--", path]);
  } catch {
    return undefined;
  }
  const line = out.split("\n").find((l) => l.trim().length > 0);
  if (!line) return undefined;
  const [meta] = line.split("\t");
  const [mode, , oid] = (meta ?? "").split(" ");
  if (!mode || !oid) return undefined;
  return { mode, oid };
}

export async function buildSalvageCommit(
  capture: WaveCaptureResult,
  taskId: string,
  title: string,
  candidateTree: string,
  symlinkRoot?: string,
): Promise<CandidateCommit> {
  const baseTree = await treeShaOf(capture.repositoryPath, capture.baseCommit);
  // Symlink handling mirrors ordinary candidate normalization (fail closed):
  // relative targets confined to the worker root transfer; absolute or
  // escaping targets refuse the salvage, regardless of which source produced
  // the tree. Targets are read from the tree blobs, not from any disk state.
  for (const path of await diffPaths(capture.repositoryPath, baseTree, candidateTree)) {
    const entry = await treeEntry(capture.repositoryPath, candidateTree, path);
    if (entry?.mode === "120000") {
      const rawTarget = await gitOut(capture.repositoryPath, ["cat-file", "-p", entry.oid]);
      assertConfinedSymlinkTarget(symlinkRoot ?? SALVAGE_SYMLINK_LEXICAL_ROOT, path, rawTarget);
    }
  }
  const message = `${title}

Wave-Id: ${capture.waveId}
Task-Id: ${taskId}
Salvage: explicit force-merge`;
  const commitSha = await createCommitWithParent(capture.repositoryPath, candidateTree, capture.baseCommit, message);
  const { ref, commitSha: pinnedSha } = await ensureCandidateSnapshotRef(capture, taskId, candidateTree, commitSha);
  await verifyCandidateCommitIdentity(capture.repositoryPath, {
    commitSha: pinnedSha,
    treeSha: candidateTree,
    baseCommit: capture.baseCommit,
    lineage: waveLineageOf(capture),
    taskId,
  });
  return {
    commitSha: pinnedSha,
    treeSha: candidateTree,
    candidateRef: ref,
    differsFromBase: candidateTree !== baseTree,
  };
}

/** The read-only snapshot of a retained worker worktree's on-disk content. */
export interface WorktreeSalvageSnapshot {
  /** Worktree HEAD at capture time. */
  headSha: string;
  /** Attached branch name (worktrees on a branch). */
  branchName?: string;
  /** Tree of the full on-disk content (staged, unstaged, and task-created files). */
  finalTree: string;
  classification: SalvagePathClassification;
}

/**
 * Snapshot the retained worker worktree's on-disk content without mutating
 * it: a private temporary index stages the content (staged edits, unstaged
 * edits, and task-created non-ignored files), the real index is never
 * touched, and no reset or checkout happens. No candidate commit is built,
 * so callers can evaluate the snapshot before deciding to pin anything.
 */
export async function captureWorktreeSnapshot(
  capture: WaveCaptureResult,
  worktreeRoot: string,
): Promise<WorktreeSalvageSnapshot> {
  const resolvedRoot = resolve(worktreeRoot);
  // The worktree must belong to this capture's private repository (the same
  // identity check as ordinary candidate normalization).
  const commonDir = await gitOut(resolvedRoot, ["rev-parse", "--git-common-dir"]);
  const resolvedCommon = await fsRealpath(resolve(resolvedRoot, commonDir.trim()));
  if (resolvedCommon !== await fsRealpath(capture.repositoryPath)) {
    throw new Error(`Worktree at "${worktreeRoot}" does not belong to the private repository "${capture.repositoryPath}".`);
  }
  let branchName: string | undefined;
  try {
    const headRef = (await gitOut(resolvedRoot, ["symbolic-ref", "--short", "HEAD"])).trim();
    if (headRef) branchName = headRef;
  } catch {
    // Detached HEAD — the ordinary case for worker worktrees.
  }
  const headSha = (await gitOut(resolvedRoot, ["rev-parse", "HEAD"])).trim();

  const tempDir = await mkdtemp(join(tmpdir(), "pi-review-salvage-"));
  try {
    const indexEnv = { GIT_INDEX_FILE: join(tempDir, "index") };
    // Seed the temporary index from the captured base before staging. An empty
    // index makes every worktree path "untracked", so `git add` would apply
    // ignore rules to base-tracked paths that happen to match them (tracked and
    // indexed files are always part of the captured base) and silently drop
    // them; the resulting tree then reports a worker deletion for a path no
    // worker touched and the landing deletes the target's copy. Ordinary
    // normalization starts from the real, base-populated index and never has
    // this gap.
    await gitOut(resolvedRoot, ["read-tree", capture.baseCommit], indexEnv);
    // Stage the on-disk content into the temporary index only. `git add -A .`
    // captures modifications, deletions of tracked files, and new non-ignored
    // files; untracked ignored paths are still excluded exactly as in ordinary
    // capture.
    await gitOut(resolvedRoot, ["add", "-A", "."], indexEnv);
    // Symlink handling mirrors ordinary candidate normalization: relative
    // targets confined to the worktree transfer; absolute or escaping targets
    // refuse the salvage. Targets are read from the staged Git blobs (not the
    // disk) so an index/worktree mismatch cannot bypass the check.
    const staged = await gitOut(resolvedRoot, ["ls-files", "-s", "--cached", "-z"], indexEnv);
    for (const record of staged.split("\0").filter(Boolean)) {
      const tabIdx = record.indexOf("\t");
      if (tabIdx < 0) continue;
      const [mode, , blobId] = record.slice(0, tabIdx).split(" ");
      if (!mode || !blobId || mode !== "120000") continue;
      const relPath = record.slice(tabIdx + 1);
      const rawTarget = await gitOut(resolvedRoot, ["cat-file", "-p", blobId]);
      assertConfinedSymlinkTarget(resolvedRoot, relPath, rawTarget);
    }
    const finalTree = (await gitOut(resolvedRoot, ["write-tree"], indexEnv)).trim();
    const classification = await classifySalvagePaths(capture, headSha, finalTree);
    return { headSha, ...(branchName ? { branchName } : {}), finalTree, classification };
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

/**
 * Capture a salvage candidate from the retained worker worktree without
 * mutating it. The transferred tree keeps the base content for every
 * baseline-only and ambiguous path; only proven worker paths take the
 * source's content.
 */
export async function salvageWorktreeCandidate(
  capture: WaveCaptureResult,
  taskId: string,
  title: string,
  worktreeRoot: string,
): Promise<SalvageCandidateIdentity> {
  if (typeof title !== "string" || title.length === 0 || /\r|\n/.test(title)) {
    throw new Error("Invalid title: must be a non-empty string without newlines.");
  }
  const snapshot = await captureWorktreeSnapshot(capture, worktreeRoot);
  const candidateTree = await buildAttributedCandidateTree(capture, snapshot.finalTree, snapshot.classification);
  const commit = await buildSalvageCommit(capture, taskId, title, candidateTree, resolve(worktreeRoot));
  return {
    ...commit,
    ...snapshot.classification,
    sourceKind: "worktree",
    headSha: snapshot.headSha,
    ...(snapshot.branchName ? { branchName: snapshot.branchName } : {}),
  };
}

/** Branch names named by this task's durable checkpoint-failure incidents. */
export function incidentBranchNames(record: OperationRecord): string[] {
  const names = new Set<string>();
  for (const incident of record.incidents) {
    const match = /on branch "([^"]+)"/.exec(incident.message);
    if (match?.[1]) names.add(match[1]);
  }
  return [...names];
}

/**
 * Enumerate surviving refs in the private repository as salvage candidates.
 * A ref is a candidate when its tree differs from the captured base tree and
 * at least one path of that delta is provably worker work or provably
 * ambiguous; ambiguity-only candidates are surfaced (named) but never
 * selected. In addition to branch heads, this task's own immutable
 * candidate/review namespaces are enumerated: their commits prove task
 * ownership by identity (wave/task trailers plus base parent), so no branch
 * name or timestamp is ever guessed.
 */
export async function listSalvageRefCandidates(
  capture: WaveCaptureResult,
  record: OperationRecord,
  taskId: string,
): Promise<SalvageRefCandidate[]> {
  const repoPath = capture.repositoryPath;
  const baseTree = await treeShaOf(repoPath, capture.baseCommit);
  const named = new Set(incidentBranchNames(record));
  const candidates: SalvageRefCandidate[] = [];
  // Content-addressed dedupe: several refs pinning the same tree are one
  // source of evidence, not several. The strongest ownership proof wins — a
  // task-owned ref cannot be masked by an earlier-listed branch head with the
  // identical tree (which would force ambiguity in a shared wave).
  const seenTrees = new Map<string, SalvageRefCandidate>();

  const consider = async (refName: string, tipSha: string, taskOwned: boolean): Promise<void> => {
    let tree: string;
    try {
      tree = await treeShaOf(repoPath, tipSha);
    } catch {
      return;
    }
    if (tree === baseTree) return;
    const incidentNamed = named.has(refName.replace(/^refs\/heads\//, ""));
    const existing = seenTrees.get(tree);
    if (existing) {
      if (taskOwned) existing.taskOwned = true;
      if (incidentNamed) existing.incidentNamed = true;
      return;
    }
    const classification = await classifySalvagePaths(capture, tipSha, tree);
    // A delta that is neither provably worker work nor ambiguous carries
    // nothing to salvage or surface; everything else stays in the listing.
    if (classification.attributedPaths.length === 0 && classification.ambiguousPaths.length === 0) return;
    let latestSessionCommitAt: string | undefined;
    try {
      const out = await gitOut(repoPath, ["log", "--format=%ct", tipSha, `^${capture.baseCommit}`]);
      const newest = out.split("\n").map((l) => Number(l.trim())).filter((n) => Number.isFinite(n)).sort((a, b) => b - a)[0];
      if (newest !== undefined) latestSessionCommitAt = new Date(newest * 1000).toISOString();
    } catch {
      // Timestamp evidence is optional; absence never blocks selection.
    }
    const candidate: SalvageRefCandidate = {
      refName,
      tipSha,
      ...classification,
      incidentNamed,
      ...(taskOwned ? { taskOwned: true } : {}),
      ...(latestSessionCommitAt ? { latestSessionCommitAt } : {}),
    };
    candidates.push(candidate);
    seenTrees.set(tree, candidate);
  };

  // Branch heads: a shared namespace — ownership is never assumed from the name.
  const refsOut = await gitOut(repoPath, ["for-each-ref", "--format=%(refname)%09%(objectname)", "refs/heads"]);
  for (const line of refsOut.split("\n")) {
    if (!line.trim()) continue;
    const [refName, tipSha] = line.split("\t");
    if (!refName || !tipSha) continue;
    await consider(refName, tipSha, false);
  }

  // This task's own immutable namespaces across the whole continuation chain
  // (root wave plus every generation up to the current one). A ref is only a
  // candidate when its commit passes the existing identity verification —
  // anything that cannot prove this task's wave/task identity is skipped,
  // never guessed at. `workers/<taskId>` pins the accepted worker result and
  // is included: with a missing worktree it can be the only attributable
  // survivor. The shared `integrated` ref is deliberately excluded — it pins
  // already-landed integration results, not unlanded worker work.
  const lineage = waveLineageOf(capture);
  const waveSegments = [lineage.rootWaveId];
  for (let generation = 1; generation <= lineage.generation; generation += 1) {
    waveSegments.push(`${lineage.rootWaveId}-g${generation}`);
  }
  const ownedPatterns: string[] = [];
  for (const waveSegment of waveSegments) {
    ownedPatterns.push(
      `refs/pi-review-gate/waves/${waveSegment}/candidate-snapshots/${taskId}`,
      `refs/pi-review-gate/waves/${waveSegment}/review-candidates/${taskId}`,
      `refs/pi-review-gate/waves/${waveSegment}/candidates/${taskId}`,
      `refs/pi-review-gate/waves/${waveSegment}/recovery/${taskId}`,
      `refs/pi-review-gate/waves/${waveSegment}/workers/${taskId}`,
    );
  }
  const ownedOut = await gitOut(repoPath, ["for-each-ref", "--format=%(refname)%09%(objectname)", ...ownedPatterns]);
  for (const line of ownedOut.split("\n")) {
    if (!line.trim()) continue;
    const [refName, tipSha] = line.split("\t");
    if (!refName || !tipSha) continue;
    try {
      await verifyCandidateCommitIdentity(repoPath, {
        commitSha: tipSha,
        baseCommit: capture.baseCommit,
        lineage,
        taskId,
      });
    } catch {
      // The commit cannot prove this task's identity: not a candidate.
      continue;
    }
    await consider(refName, tipSha, true);
  }

  return candidates.sort((a, b) => a.refName.localeCompare(b.refName));
}

/**
 * Select the salvage source among surviving refs. Only refs with provably
 * worker-created (attributed) content are selectable; ambiguity-only refs are
 * surfaced in unresolved outcomes, never selected. Durable incident evidence
 * naming exactly one ref as this task's own selects it; a sole task-owned
 * candidate is selected on its proven identity even with sibling tasks; a
 * sole branch-head candidate is used only when no other execute task shares
 * the wave's private repository (where a sibling task's branch could be the
 * single candidate and its content would land under this task's force-merge).
 * Everything else is surfaced as ambiguous — never guessed.
 */
export function selectSalvageSource(
  candidates: readonly SalvageRefCandidate[],
  context: { hasSiblingTasks?: boolean } = {},
): SalvageSourceSelection {
  const selectable = candidates.filter((c) => c.attributedPaths.length > 0);
  if (selectable.length === 0) {
    if (candidates.length > 0) {
      // Surviving refs carry only ambiguous content: name them instead of
      // reporting no recoverable work.
      return { kind: "ambiguous", candidates: [...candidates] };
    }
    return { kind: "none", reason: "no surviving ref in the private repository carries provably worker-created or ambiguous content" };
  }
  const named = selectable.filter((c) => c.incidentNamed);
  if (named.length === 1) {
    // This task's own checkpoint-failure incidents name exactly one ref.
    return { kind: "ref", candidate: named[0]!, unselected: candidates.filter((c) => c !== named[0]) };
  }
  if (selectable.length === 1) {
    const sole = selectable[0]!;
    // A task-owned ref proves ownership by commit identity regardless of
    // siblings; a branch head does not, so with siblings present ownership
    // cannot be excluded and selection falls through to ambiguous.
    if (sole.taskOwned || !context.hasSiblingTasks) {
      return { kind: "ref", candidate: sole, unselected: candidates.filter((c) => c !== sole) };
    }
  }
  return { kind: "ambiguous", candidates: [...candidates] };
}

/**
 * Build the transferred candidate tree: base content plus exactly the
 * attributed paths (proven worker deletions remove the base entry).
 * Baseline-only and ambiguous paths keep the target's own content — they are
 * never transferred.
 */
export async function buildAttributedCandidateTree(
  capture: WaveCaptureResult,
  finalTree: string,
  classification: SalvagePathClassification,
): Promise<string> {
  if (classification.baselineOnlyPaths.length === 0 && classification.ambiguousPaths.length === 0) {
    return finalTree;
  }
  const repoPath = capture.repositoryPath;
  const tempDir = await mkdtemp(join(tmpdir(), "pi-review-salvage-"));
  try {
    const indexEnv = { GIT_INDEX_FILE: join(tempDir, "index") };
    await gitOut(repoPath, ["read-tree", capture.baseCommit], indexEnv);
    for (const path of classification.attributedPaths) {
      const entry = await treeEntry(repoPath, finalTree, path);
      if (!entry) {
        // Proven worker deletion of a base path.
        await gitOut(repoPath, ["update-index", "--force-remove", path], indexEnv);
        continue;
      }
      if (entry.mode === "040000") {
        throw new Error(`Salvage attribution produced a directory entry for ${path}; refusing.`);
      }
      await gitOut(repoPath, ["update-index", "--add", "--force-remove", "--cacheinfo", `${entry.mode},${entry.oid},${path}`], indexEnv);
    }
    return (await gitOut(repoPath, ["write-tree"], indexEnv)).trim();
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

function entriesEqual(
  a: { mode: string; oid: string } | undefined,
  b: { mode: string; oid: string } | undefined,
): boolean {
  if (!a && !b) return true;
  if (!a || !b) return false;
  return a.mode === b.mode && a.oid === b.oid;
}

/** Build the pinned salvage candidate commit from a selected surviving ref. */
export async function salvageRefCandidate(
  capture: WaveCaptureResult,
  taskId: string,
  title: string,
  selection: SalvageRefCandidate,
): Promise<SalvageCandidateIdentity> {
  const tree = await treeShaOf(capture.repositoryPath, selection.tipSha);
  // The ref's full tree must not carry ambiguous or baseline-only content:
  // rebuild the transferred tree from exactly the attributed paths.
  const candidateTree = await buildAttributedCandidateTree(capture, tree, {
    attributedPaths: selection.attributedPaths,
    baselineOnlyPaths: selection.baselineOnlyPaths,
    ambiguousPaths: selection.ambiguousPaths,
  });
  const commit = await buildSalvageCommit(capture, taskId, title, candidateTree);
  return {
    ...commit,
    attributedPaths: [...selection.attributedPaths],
    baselineOnlyPaths: [...selection.baselineOnlyPaths],
    ambiguousPaths: [...selection.ambiguousPaths],
    sourceKind: "retained_ref",
    headSha: selection.tipSha,
    refName: selection.refName,
  };
}
