/**
 * #233: selective checkpoint advancement (extracted from git-checkpoint.ts).
 * Advances only the landed paths of an existing verified baseline to the
 * live index/worktree state; every unselected path stays based on the old
 * checkpoint, and the new generation is published with its own pin, scratch,
 * and atomically durable record.
 */

import { createHash, randomBytes } from "node:crypto";
import { lstat, mkdir, realpath, rm } from "node:fs/promises";
import { join } from "node:path";

import { GitCheckpointError, messageOf, resultFromError, throwIfAborted, type GitCheckpointResult } from "./errors";
import { GIT_CHECKPOINT_DESCRIPTOR_FORMAT, GIT_CHECKPOINT_RECORD_FORMAT, SCRATCH_SUBDIR, assertValidDescriptor, checkpointRefForWindow, decodeGitCheckpointRecord, encodeGitCheckpointRecord, isPathSelected, isSafeRelativePath, isSafeWindowId, sameStatIdentity, statIdentityOf, type GitCheckpointDescriptor, type GitCheckpointRecord, type GitCheckpointUntrackedEntry } from "./record";
import { DEFAULT_MAX_PATCH_BYTES, DEFAULT_MAX_UNTRACKED_BYTES, DEFAULT_TIMEOUT_MS, ZERO_OID_SHA1, ZERO_OID_SHA256, runGit, runGitWithInput, type GitRunSpec } from "./run-git";
import { assertAuditProofStable, auditRepository, resolveRepo, runAfterInitialAuditHook, type ResolvedRepo } from "./audit";
import { cleanupAfterFailedArm, createPinIfMissing } from "./pin";
import { captureDiff, captureUntrackedEntry, listUntrackedPaths, snapshotLiveIndexTree } from "./capture";
import { assertNoTreePathConflicts, assertNoUntrackedPathConflicts, assertSafeTreePaths, buildArmedTrees, composeSelectedTree, lsTreeMap, writeIndexTree } from "./trees";
import { assertContainedParents } from "./content";
import { publishRecordDurable, syncAncestorChain } from "./durability";
import { loadGitCheckpoint } from "./load";
import type { GitCheckpointOptions } from "./types";

function validateAdvancePaths(paths: readonly string[]): Set<string> {
  if (!Array.isArray(paths)) {
    throw new GitCheckpointError("landed paths must be an array of repository-relative paths", "unsafe_advance_path");
  }
  const selected = new Set<string>();
  for (const path of paths) {
    if (
      typeof path !== "string"
      || !isSafeRelativePath(path)
      || Buffer.from(path, "utf8").toString("utf8") !== path
    ) {
      throw new GitCheckpointError(`unsafe landed path ${JSON.stringify(path)}`, "unsafe_advance_path");
    }
    selected.add(path);
  }
  return selected;
}

export interface GitCheckpointAdvanceOutcome {
  /** Compact descriptor of the newly published selective baseline. */
  descriptor: GitCheckpointDescriptor;
}

/**
 * Advance only `landedPaths` in an existing checkpoint baseline to the live
 * index/worktree state. Paths match literally at component boundaries: a
 * selector `a` includes `a` and `a/...`, but not `ab`. Every unselected
 * tracked tree and non-ignored untracked record remains based on the verified
 * old checkpoint, not on unrelated newer workspace changes.
 *
 * The existing descriptor is fully reloaded and verified before use and
 * again before success. A new, unique `checkpointId` gets its own pin,
 * generation, scratch directory, and atomically published record; the old
 * descriptor and its pin are never released or rewritten. All index work is
 * done through disposable alternate indexes, and the live HEAD, index, and
 * worktree are read-only. The caller owns any later durability ordering and
 * release of either descriptor.
 */
export async function advanceGitCheckpoint(
  root: string,
  descriptor: GitCheckpointDescriptor,
  landedPaths: readonly string[],
  checkpointId: string,
  options: GitCheckpointOptions = {},
): Promise<GitCheckpointResult<GitCheckpointAdvanceOutcome>> {
  const gitPath = options.gitPath ?? "git";
  const spec: GitRunSpec = {
    timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    maxBytes: 1024 * 1024,
    signal: options.signal,
  };
  let owned: { repo: ResolvedRepo; armId: string; base: string; scratchDir: string } | undefined;
  let succeeded = false;

  try {
    throwIfAborted(spec.signal);
    if (!isSafeWindowId(checkpointId)) {
      throw new GitCheckpointError(`unsafe checkpoint id ${JSON.stringify(checkpointId)}`, "unsafe_window_id");
    }
    const validDescriptor = assertValidDescriptor(descriptor);
    const oldLoaded = await loadGitCheckpoint(root, validDescriptor, options);
    if (oldLoaded.status !== "ok") return oldLoaded;
    const oldRecord = oldLoaded.value.record;
    const selected = validateAdvancePaths(landedPaths);

    const resolved = await resolveRepo(gitPath, root, spec);
    if (resolved.status !== "ok") return resolved;
    const repo = resolved.value;
    throwIfAborted(spec.signal);
    const gitDirReal = await realpath(repo.gitDir);
    if (gitDirReal !== validDescriptor.gitDir) {
      return {
        status: "failed",
        reason: "wrong_repository",
        detail: `descriptor names git dir ${validDescriptor.gitDir}, but this repository's git dir is ${gitDirReal}`,
      };
    }

    const audit = await auditRepository(gitPath, repo.root, spec);
    if (audit.status !== "ok") return audit;
    const initialAuditProof = audit.value;
    // Freeze the probed EOL semantics for every capture command below.
    spec.frozenAutocrlf = audit.value.effectiveAutocrlf;
    await runAfterInitialAuditHook(options);
    throwIfAborted(spec.signal);

    const armId = randomBytes(8).toString("hex");
    const ref = checkpointRefForWindow(checkpointId);
    const zeroOid = oldRecord.objectFormat === "sha1" ? ZERO_OID_SHA1 : ZERO_OID_SHA256;
    const pin = await createPinIfMissing(gitPath, repo.root, ref, oldRecord.base, zeroOid, armId, spec);
    if (pin.status !== "ok") return pin;

    const scratchDir = join(repo.gitDir, SCRATCH_SUBDIR, checkpointId, `arm-${armId}`);
    owned = { repo, armId, base: oldRecord.base, scratchDir };
    await mkdir(scratchDir, { recursive: true });
    await syncAncestorChain(scratchDir, repo.gitDir);

    const temporaryIndexes = new Set<string>();
    const oldTrees = await buildArmedTrees(gitPath, repo, oldRecord, checkpointId, spec, scratchDir);
    temporaryIndexes.add(oldTrees.tempIndexPath);
    temporaryIndexes.add(oldTrees.worktreeIndexPath);

    const oldIndexEntries = await lsTreeMap(gitPath, repo.root, oldTrees.armedIndexTree, spec);
    const oldWorktreeEntries = await lsTreeMap(gitPath, repo.root, oldTrees.armedWorktreeTree, spec);
    assertSafeTreePaths(oldIndexEntries);
    assertSafeTreePaths(oldWorktreeEntries);

    // Snapshot the live index through a private copy, then sign the tracked
    // worktree view. The matching post-capture samples fail closed if an
    // index or tracked worktree change interleaves with the selected capture.
    const liveIndexTree = await snapshotLiveIndexTree(gitPath, repo, scratchDir, spec);
    const liveIndexEntries = await lsTreeMap(gitPath, repo.root, liveIndexTree, spec);
    assertSafeTreePaths(liveIndexEntries);
    const preUnstagedDiff = await captureDiff(
      gitPath,
      repo.root,
      [],
      spec,
      options.maxPatchBytes ?? DEFAULT_MAX_PATCH_BYTES,
      { repo, copyPath: join(scratchDir, "advance-index-pre-diff") },
    );
    const untrackedBefore = (await listUntrackedPaths(gitPath, repo.root, spec))
      .filter((path) => isPathSelected(path, selected))
      .sort();

    const composedIndexPath = join(scratchDir, `advance-index-${process.pid}-${randomBytes(6).toString("hex")}`);
    temporaryIndexes.add(composedIndexPath);
    const composedIndex = await composeSelectedTree(
      gitPath,
      repo,
      oldTrees.armedIndexTree,
      oldIndexEntries,
      liveIndexEntries,
      selected,
      composedIndexPath,
      oldRecord.objectFormat,
      spec,
    );

    const composedWorktreePath = join(scratchDir, `advance-worktree-${process.pid}-${randomBytes(6).toString("hex")}`);
    temporaryIndexes.add(composedWorktreePath);
    const composedWorktree = await composeSelectedTree(
      gitPath,
      repo,
      oldTrees.armedWorktreeTree,
      oldWorktreeEntries,
      liveIndexEntries,
      selected,
      composedWorktreePath,
      oldRecord.objectFormat,
      spec,
    );

    // `git add -u` updates only paths already in the live index. Using
    // literal NUL-delimited pathspecs prevents wildcard/path-prefix leakage;
    // newly untracked files remain exact raw-byte records below.
    const liveSelectedTrackedPaths = [...liveIndexEntries.keys()]
      .filter((path) => isPathSelected(path, selected))
      .sort();
    if (liveSelectedTrackedPaths.length > 0) {
      const pathspecs = Buffer.concat(liveSelectedTrackedPaths.map((path) => Buffer.from(`:(top,literal)${path}\0`, "utf8")));
      const addOut = await runGitWithInput(
        gitPath,
        repo.root,
        ["add", "-u", "--pathspec-from-file=-", "--pathspec-file-nul"],
        pathspecs,
        spec,
        { GIT_INDEX_FILE: composedWorktree.indexPath },
      );
      if (addOut.code !== 0 || addOut.stderr.trim().length > 0) {
        throw new GitCheckpointError(
          `cannot capture selected tracked worktree paths: ${addOut.stderr || `git add -u exit ${addOut.code}`}`,
          "restore_path_conflict",
        );
      }
    }
    const composedWorktreeTree = await writeIndexTree(gitPath, repo.root, composedWorktree.indexPath, spec);

    const retainedUntracked = oldRecord.untracked.filter((entry) => !isPathSelected(entry.path, selected));
    const maxUntrackedBytes = options.maxUntrackedBytes ?? DEFAULT_MAX_UNTRACKED_BYTES;
    let totalUntrackedBytes = retainedUntracked.reduce(
      (sum, entry) => sum + (entry.kind === "file" ? entry.size : 0),
      0,
    );
    const advancedUntracked: GitCheckpointUntrackedEntry[] = [];
    for (const path of untrackedBefore) {
      throwIfAborted(spec.signal);
      await assertContainedParents(repo.root, join(repo.root, ...path.split("/")));
      const entry = await captureUntrackedEntry(
        repo.root,
        path,
        options.faultHooks?.beforeUntrackedRead,
        maxUntrackedBytes,
      );
      if (entry.kind === "file") totalUntrackedBytes += entry.size;
      if (totalUntrackedBytes > maxUntrackedBytes) {
        throw new GitCheckpointError("advanced untracked bytes exceeded the cap", "untracked_too_large");
      }
      advancedUntracked.push(entry);
    }
    const untracked = [...retainedUntracked, ...advancedUntracked].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    const untrackedPaths = new Set<string>();
    for (const entry of untracked) {
      if (untrackedPaths.has(entry.path)) {
        throw new GitCheckpointError(`duplicate untracked baseline path ${entry.path}`, "restore_path_conflict");
      }
      untrackedPaths.add(entry.path);
    }

    const composedIndexEntries = await lsTreeMap(gitPath, repo.root, composedIndex.tree, spec);
    const composedWorktreeEntries = await lsTreeMap(gitPath, repo.root, composedWorktreeTree, spec);
    assertSafeTreePaths(composedIndexEntries);
    assertSafeTreePaths(composedWorktreeEntries);
    assertNoTreePathConflicts(new Set(composedIndexEntries.keys()), new Set(composedWorktreeEntries.keys()), true);
    assertNoTreePathConflicts(new Set(composedIndexEntries.keys()), untrackedPaths, false);
    assertNoTreePathConflicts(new Set(composedWorktreeEntries.keys()), untrackedPaths, false);
    assertNoUntrackedPathConflicts(untrackedPaths);

    const baseTreeOut = await runGit(gitPath, repo.root, ["rev-parse", `${oldRecord.base}^{tree}`], spec);
    if (baseTreeOut.code !== 0 || baseTreeOut.stderr.trim().length > 0) {
      throw new GitCheckpointError(`cannot resolve pinned base tree: ${baseTreeOut.stderr || `exit ${baseTreeOut.code}`}`, "pin_object_missing");
    }
    const baseTree = baseTreeOut.stdout.toString("utf8").trim();
    const maxPatchBytes = options.maxPatchBytes ?? DEFAULT_MAX_PATCH_BYTES;
    const stagedPatch = await captureDiff(gitPath, repo.root, [baseTree, composedIndex.tree], spec, maxPatchBytes);
    const unstagedPatch = await captureDiff(gitPath, repo.root, [composedIndex.tree, composedWorktreeTree], spec, maxPatchBytes);
    const newRecord: GitCheckpointRecord = {
      format: GIT_CHECKPOINT_RECORD_FORMAT,
      armId,
      base: oldRecord.base,
      ref,
      objectFormat: oldRecord.objectFormat,
      stagedPatchB64: stagedPatch.toString("base64"),
      unstagedPatchB64: unstagedPatch.toString("base64"),
      untracked,
    };
    const encoded = encodeGitCheckpointRecord(newRecord);
    // Validate the composed patch pair using the same reconstruction path
    // restore will use; do not publish a record that cannot reproduce both
    // intended trees.
    decodeGitCheckpointRecord(encoded);
    const verifiedTrees = await buildArmedTrees(gitPath, repo, newRecord, checkpointId, spec, scratchDir);
    temporaryIndexes.add(verifiedTrees.tempIndexPath);
    temporaryIndexes.add(verifiedTrees.worktreeIndexPath);
    if (
      verifiedTrees.armedIndexTree !== composedIndex.tree
      || verifiedTrees.armedWorktreeTree !== composedWorktreeTree
    ) {
      throw new GitCheckpointError("composed patches do not reconstruct the selected baseline trees", "patch_apply_failed");
    }

    // Close the capture window with the same read-only consistency checks as
    // arm, plus a selected-untracked path-set and identity check.
    const finalIndexTree = await snapshotLiveIndexTree(gitPath, repo, scratchDir, spec);
    const finalUnstagedDiff = await captureDiff(
      gitPath,
      repo.root,
      [],
      spec,
      options.maxPatchBytes ?? DEFAULT_MAX_PATCH_BYTES,
      { repo, copyPath: join(scratchDir, "advance-index-final-diff") },
    );
    const untrackedAfter = (await listUntrackedPaths(gitPath, repo.root, spec))
      .filter((path) => isPathSelected(path, selected))
      .sort();
    if (
      finalIndexTree !== liveIndexTree
      || !finalUnstagedDiff.equals(preUnstagedDiff)
      || untrackedAfter.length !== untrackedBefore.length
      || untrackedAfter.some((path, i) => path !== untrackedBefore[i])
    ) {
      throw new GitCheckpointError("live index or selected worktree paths changed during selective advancement", "capture_inconsistent");
    }
    for (const entry of advancedUntracked) {
      const absolute = join(repo.root, ...entry.path.split("/"));
      await assertContainedParents(repo.root, absolute);
      const current = await lstat(absolute).catch((error: unknown) => {
        throw new GitCheckpointError(`selected untracked path ${entry.path} changed during advancement: ${messageOf(error)}`, "untracked_capture_race");
      });
      if (!sameStatIdentity(statIdentityOf(current), statIdentityOf(entry))) {
        throw new GitCheckpointError(`selected untracked path ${entry.path} changed during advancement`, "untracked_capture_race");
      }
    }

    // The verification pass created only disposable alternate indexes. The
    // durable directory is left with the record alone after publication.
    for (const indexPath of temporaryIndexes) {
      await rm(indexPath, { force: true });
      await rm(`${indexPath}.lock`, { force: true });
    }

    // The existing descriptor is still caller-owned and must remain valid
    // through publication. A concurrent release/re-arm fails this gate and
    // causes only the new generation to be cleaned up by finally.
    const oldStillValid = await loadGitCheckpoint(root, validDescriptor, options);
    if (oldStillValid.status !== "ok") return oldStillValid;

    // Recheck audited config/flags immediately before publication;
    // worktree/index consistency was sampled immediately above.
    const finalAudit = await auditRepository(gitPath, repo.root, spec);
    assertAuditProofStable(initialAuditProof, finalAudit);
    await publishRecordDurable(scratchDir, encoded);
    const newDescriptor: GitCheckpointDescriptor = {
      format: GIT_CHECKPOINT_DESCRIPTOR_FORMAT,
      windowId: checkpointId,
      armId,
      gitDir: gitDirReal,
      base: oldRecord.base,
      ref,
      objectFormat: oldRecord.objectFormat,
      digest: createHash("sha256").update(encoded, "utf8").digest("hex"),
    };
    const newLoaded = await loadGitCheckpoint(root, newDescriptor, options);
    if (newLoaded.status !== "ok") return newLoaded;
    const oldAfterPublish = await loadGitCheckpoint(root, validDescriptor, options);
    if (oldAfterPublish.status !== "ok") return oldAfterPublish;

    succeeded = true;
    return { status: "ok", value: { descriptor: newDescriptor } };
  } catch (error) {
    return resultFromError(error);
  } finally {
    if (owned !== undefined && !succeeded) {
      await cleanupAfterFailedArm(
        gitPath,
        owned.repo,
        checkpointId,
        owned.base,
        owned.armId,
        owned.scratchDir,
        spec,
      );
    }
  }
}
