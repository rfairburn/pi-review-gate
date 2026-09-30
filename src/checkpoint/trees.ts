/**
 * #233: armed tree reconstruction and object-space tree helpers (extracted
 * from git-checkpoint.ts). Rebuilds the armed index/worktree trees from a
 * record's patches in disposable alternate indexes (the live index is never
 * written), composes selective-advancement trees, and enumerates/diffs trees.
 */

import { randomBytes } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";

import { GitCheckpointError, messageOf } from "./errors";
import { OID_RE_40, OID_RE_64, SCRATCH_SUBDIR, isPathSelected, isSafeRelativePath, type GitCheckpointObjectFormat, type GitCheckpointRecord } from "./record";
import { ZERO_OID_SHA1, ZERO_OID_SHA256, runGit, runGitWithInput, type GitRunOutput, type GitRunSpec } from "./run-git";
import type { ResolvedRepo } from "./audit";
import { copyIndexForWorktreeDiff } from "./capture";

// ── Armed tree reconstruction (temp-index based, live index untouched) ───────

export interface ArmedTrees {
  scratchDir: string;
  tempIndexPath: string;
  worktreeIndexPath: string;
  armedIndexTree: string;
  armedWorktreeTree: string;
}

/**
 * Rebuild the armed index and worktree trees from the record using Git's own
 * patch/apply against an ALTERNATE temporary index in owned scratch. The live
 * index file is never opened for writing here. Any apply failure (including
 * "already exists in working directory" conflicts, which git reports as exit
 * code 1) fails closed with patch_apply_failed.
 */
export async function buildArmedTrees(
  gitPath: string,
  repo: ResolvedRepo,
  record: GitCheckpointRecord,
  windowId: string,
  spec: GitRunSpec,
  scratchDirOverride?: string,
): Promise<ArmedTrees> {
  const scratchDir = scratchDirOverride ?? join(repo.gitDir, SCRATCH_SUBDIR, windowId);
  await mkdir(scratchDir, { recursive: true });
  const tempIndexPath = join(scratchDir, `index-${process.pid}-${randomBytes(6).toString("hex")}`);

  let baseTreeOut: GitRunOutput;
  try {
    baseTreeOut = await runGit(gitPath, repo.root, ["rev-parse", `${record.base}^{tree}`], spec);
  } catch (error) {
    throw error instanceof GitCheckpointError ? error : new GitCheckpointError(messageOf(error), "git_failed");
  }
  if (baseTreeOut.code !== 0) {
    throw new GitCheckpointError(`base tree missing for ${record.base}: ${baseTreeOut.stderr}`, "pin_object_missing");
  }
  const baseTree = baseTreeOut.stdout.toString("utf8").trim();

  // Step 1: temp index = base tree.
  let out = await runGit(gitPath, repo.root, ["read-tree", baseTree], { ...spec, extraEnv: { GIT_INDEX_FILE: tempIndexPath } });
  if (out.code !== 0) throw new GitCheckpointError(`read-tree failed: ${out.stderr}`, "git_failed");

  // Step 2: apply the staged delta into the temp index.
  const stagedPatch = Buffer.from(record.stagedPatchB64, "base64");
  if (stagedPatch.length > 0) {
    // apply reads the patch from stdin — spawn with input.
    const applied = await runGitWithInput(gitPath, repo.root, ["apply", "--cached"], stagedPatch, spec, { GIT_INDEX_FILE: tempIndexPath });
    if (applied.code !== 0) {
      throw new GitCheckpointError(`staged patch did not apply cleanly to the base tree: ${applied.stderr}`, "patch_apply_failed");
    }
  }
  let writeOut: GitRunOutput;
  try {
    writeOut = await runGit(gitPath, repo.root, ["write-tree"], { ...spec, extraEnv: { GIT_INDEX_FILE: tempIndexPath } });
  } catch (error) {
    throw error instanceof GitCheckpointError ? error : new GitCheckpointError(messageOf(error), "git_failed");
  }
  if (writeOut.code !== 0) throw new GitCheckpointError(`write-tree failed: ${writeOut.stderr}`, "git_failed");
  const armedIndexTree = writeOut.stdout.toString("utf8").trim();

  // Step 3: second temp index = armed index + unstaged delta.
  const worktreeIndexPath = join(scratchDir, `index-wt-${process.pid}-${randomBytes(6).toString("hex")}`);
  let wtOut: GitRunOutput;
  try {
    wtOut = await runGit(gitPath, repo.root, ["read-tree", armedIndexTree], { ...spec, extraEnv: { GIT_INDEX_FILE: worktreeIndexPath } });
  } catch (error) {
    throw error instanceof GitCheckpointError ? error : new GitCheckpointError(messageOf(error), "git_failed");
  }
  if (wtOut.code !== 0) throw new GitCheckpointError(`read-tree of armed index failed: ${wtOut.stderr}`, "git_failed");
  const unstagedPatch = Buffer.from(record.unstagedPatchB64, "base64");
  if (unstagedPatch.length > 0) {
    const applied = await runGitWithInput(gitPath, repo.root, ["apply", "--cached"], unstagedPatch, spec, { GIT_INDEX_FILE: worktreeIndexPath });
    if (applied.code !== 0) {
      throw new GitCheckpointError(`unstaged patch did not apply cleanly to the armed index: ${applied.stderr}`, "patch_apply_failed");
    }
  }
  try {
    writeOut = await runGit(gitPath, repo.root, ["write-tree"], { ...spec, extraEnv: { GIT_INDEX_FILE: worktreeIndexPath } });
  } catch (error) {
    throw error instanceof GitCheckpointError ? error : new GitCheckpointError(messageOf(error), "git_failed");
  }
  if (writeOut.code !== 0) throw new GitCheckpointError(`write-tree failed: ${writeOut.stderr}`, "git_failed");
  const armedWorktreeTree = writeOut.stdout.toString("utf8").trim();

  return { scratchDir, tempIndexPath, worktreeIndexPath, armedIndexTree, armedWorktreeTree };
}

/**
 * Start an alternate index at `baseTree`, replace only selected entries from
 * `sourceEntries`, and write its resulting tree. `--index-info -z` carries
 * literal paths through stdin, avoiding pathspec interpretation entirely.
 */
export async function composeSelectedTree(
  gitPath: string,
  repo: ResolvedRepo,
  baseTree: string,
  baseEntries: ReadonlyMap<string, { mode: string; blob: string }>,
  sourceEntries: ReadonlyMap<string, { mode: string; blob: string }>,
  selected: ReadonlySet<string>,
  indexPath: string,
  objectFormat: GitCheckpointObjectFormat,
  spec: GitRunSpec,
): Promise<{ indexPath: string; tree: string }> {
  const readOut = await runGit(
    gitPath,
    repo.root,
    ["read-tree", baseTree],
    { ...spec, extraEnv: { GIT_INDEX_FILE: indexPath } },
  );
  if (readOut.code !== 0 || readOut.stderr.trim().length > 0) {
    throw new GitCheckpointError(`cannot initialize alternate index: ${readOut.stderr || `read-tree exit ${readOut.code}`}`, "git_failed");
  }

  const zeroOid = objectFormat === "sha1" ? ZERO_OID_SHA1 : ZERO_OID_SHA256;
  const rows: Buffer[] = [];
  for (const path of [...baseEntries.keys()].filter((candidate) => isPathSelected(candidate, selected)).sort()) {
    rows.push(Buffer.from(`0 ${zeroOid}\t${path}\0`, "utf8"));
  }
  for (const [path, entry] of [...sourceEntries.entries()]
    .filter(([candidate]) => isPathSelected(candidate, selected))
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    rows.push(Buffer.from(`${entry.mode} ${entry.blob}\t${path}\0`, "utf8"));
  }
  if (rows.length > 0) {
    const updateOut = await runGitWithInput(
      gitPath,
      repo.root,
      ["update-index", "-z", "--index-info"],
      Buffer.concat(rows),
      spec,
      { GIT_INDEX_FILE: indexPath },
    );
    if (updateOut.code !== 0 || updateOut.stderr.trim().length > 0) {
      throw new GitCheckpointError(
        `selected paths cannot be composed with the retained baseline: ${updateOut.stderr || `update-index exit ${updateOut.code}`}`,
        "restore_path_conflict",
      );
    }
  }
  return { indexPath, tree: await writeIndexTree(gitPath, repo.root, indexPath, spec) };
}

export async function writeIndexTree(gitPath: string, root: string, indexPath: string, spec: GitRunSpec): Promise<string> {
  const out = await runGit(gitPath, root, ["write-tree"], { ...spec, extraEnv: { GIT_INDEX_FILE: indexPath } });
  if (out.code !== 0 || out.stderr.trim().length > 0) {
    throw new GitCheckpointError(`write-tree failed: ${out.stderr || `exit ${out.code}`}`, "restore_path_conflict");
  }
  const tree = out.stdout.toString("utf8").trim();
  if (!OID_RE_40.test(tree) && !OID_RE_64.test(tree)) {
    throw new GitCheckpointError(`write-tree emitted an invalid tree id ${JSON.stringify(tree)}`, "git_failed");
  }
  return tree;
}

export function assertSafeTreePaths(entries: ReadonlyMap<string, { mode: string; blob: string }>): void {
  for (const path of entries.keys()) {
    if (!isSafeRelativePath(path) || Buffer.from(path, "utf8").toString("utf8") !== path) {
      throw new GitCheckpointError(`unsafe tree path ${JSON.stringify(path)} during selective advancement`, "git_warning");
    }
  }
}

/** Refuse file↔directory collisions across two states that must coexist. */
export function assertNoTreePathConflicts(a: ReadonlySet<string>, b: ReadonlySet<string>, allowSamePath: boolean): void {
  const assertAncestors = (paths: ReadonlySet<string>, other: ReadonlySet<string>): void => {
    for (const path of paths) {
      if (!allowSamePath && other.has(path)) {
        throw new GitCheckpointError(`selected baseline path ${path} conflicts with another entry`, "restore_path_conflict");
      }
      let slash = path.indexOf("/");
      while (slash >= 0) {
        const ancestor = path.slice(0, slash);
        if (other.has(ancestor)) {
          throw new GitCheckpointError(`file/directory path conflict between ${ancestor} and ${path}`, "restore_path_conflict");
        }
        slash = path.indexOf("/", slash + 1);
      }
    }
  };
  assertAncestors(a, b);
  assertAncestors(b, a);
}

/** Reject a retained untracked file combined with one of its descendants. */
export function assertNoUntrackedPathConflicts(paths: ReadonlySet<string>): void {
  for (const path of paths) {
    let slash = path.indexOf("/");
    while (slash >= 0) {
      const ancestor = path.slice(0, slash);
      if (paths.has(ancestor)) {
        throw new GitCheckpointError(
          `untracked baseline file/directory conflict between ${ancestor} and ${path}`,
          "restore_path_conflict",
        );
      }
      slash = path.indexOf("/", slash + 1);
    }
  }
}

// ── Tree comparison helpers (lazy object-space diff) ─────────────────────────

/** Paths whose blob differs between two tree OIDs (empty = identical). */
export async function diffTreePaths(
  gitPath: string,
  root: string,
  a: string,
  b: string,
  spec: GitRunSpec,
): Promise<string[]> {
  const out = await runGit(gitPath, root, ["diff-tree", "-r", "--no-renames", "--name-only", "-z", a, b], { ...spec, maxBytes: 16 * 1024 * 1024 });
  if (out.code !== 0) throw new GitCheckpointError(`diff-tree failed: ${out.stderr}`, "git_failed");
  return out.stdout.toString("utf8").split("\0").filter((p) => p.length > 0);
}

/** Paths where the live worktree deviates from the armed worktree tree. */
export async function worktreeDeltaPaths(gitPath: string, repo: ResolvedRepo, tree: string, spec: GitRunSpec, copyPath: string): Promise<string[]> {
  // --no-renames (and diff.renames=false above): a rename pair must report
  // BOTH sides; --name-only would otherwise print just the post-image name
  // and drop the deleted path from the changed set.
  // Even read-style diff can refresh live index stat metadata. Read from a
  // private copy, just as patch capture does; never write the target index.
  // Concurrent comparisons must never reuse or remove one another's copy.
  const uniqueCopyPath = `${copyPath}-${process.pid}-${randomBytes(6).toString("hex")}`;
  let out: GitRunOutput;
  try {
    await copyIndexForWorktreeDiff(repo, uniqueCopyPath);
    out = await runGit(gitPath, repo.root, ["diff", "--no-ext-diff", "--no-textconv", "--no-renames", "--name-only", "-z", tree], {
      ...spec, maxBytes: 16 * 1024 * 1024,
      extraEnv: { ...spec.extraEnv, GIT_INDEX_FILE: uniqueCopyPath },
    });
  } finally {
    await rm(uniqueCopyPath, { force: true }).catch(() => undefined);
    await rm(`${uniqueCopyPath}.lock`, { force: true }).catch(() => undefined);
  }
  if (out.code !== 0 && out.code !== 1) throw new GitCheckpointError(`worktree diff failed: ${out.stderr}`, "git_failed");
  if (out.stderr.trim().length > 0) throw new GitCheckpointError(`worktree diff warned: ${out.stderr}`, "git_warning");
  return out.stdout.toString("utf8").split("\0").filter((p) => p.length > 0);
}

/** Map of path → blob oid for every entry in a tree (recursive). */
export async function lsTreeMap(
  gitPath: string,
  root: string,
  tree: string,
  spec: GitRunSpec,
): Promise<Map<string, { mode: string; blob: string }>> {
  const out = await runGit(gitPath, root, ["ls-tree", "-r", "-z", tree], { ...spec, maxBytes: 64 * 1024 * 1024 });
  if (out.code !== 0) throw new GitCheckpointError(`ls-tree failed: ${out.stderr}`, "git_failed");
  const map = new Map<string, { mode: string; blob: string }>();
  for (const record of out.stdout.toString("utf8").split("\0")) {
    if (!record) continue;
    const tab = record.indexOf("\t");
    if (tab < 0) throw new GitCheckpointError("unparseable ls-tree record", "git_failed");
    // ls-tree -z record: "<mode> SP <type> SP <oid> TAB <path>"
    const meta = record.slice(0, tab).split(" ");
    const path = record.slice(tab + 1);
    if ((meta[1] ?? "") !== "blob") {
      throw new GitCheckpointError(`unexpected non-blob entry '${meta[1]}' for ${path} in armed tree`, "git_failed");
    }
    map.set(path, { mode: meta[0] ?? "", blob: meta[2] ?? "" });
  }
  return map;
}
