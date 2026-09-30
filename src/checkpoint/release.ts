/**
 * #233: checkpoint pin release (extracted from git-checkpoint.ts). Deletes
 * the owned ref and removes the owned scratch only under BOTH owner proofs
 * (expected base commit AND arm generation nonce) with the window lock held
 * through proof, deletion, and cleanup.
 */

import { rm, rmdir } from "node:fs/promises";
import { join } from "node:path";

import { resultFromError, throwIfAborted, truncateDetail, type GitCheckpointResult } from "./errors";
import { OID_RE_40, OID_RE_64, SCRATCH_SUBDIR, checkpointRefForWindow, isSafeArmId, isSafeWindowId } from "./record";
import { DEFAULT_TIMEOUT_MS, runGit, type GitRunOutput, type GitRunSpec } from "./run-git";
import { resolveRepo } from "./audit";
import { acquireWindowPinLock, pinGenerationMessage } from "./pin";
import type { GitCheckpointOptions } from "./types";

// ── Release ──────────────────────────────────────────────────────────────────

/** Options for {@link releaseGitCheckpointPin}. */
export interface GitCheckpointReleaseOptions extends GitCheckpointOptions {
  /**
   * Owner proof, part 1 (REQUIRED): the base commit this generation pinned
   * (the persisted record's `base`, or the descriptor's `base`). The pin is
   * released only if it still points at exactly this commit; a pin owned by
   * a different base fails with `pin_ref_mismatch` and nothing is removed.
   */
  expectedBase: string;
  /**
   * Owner proof, part 2 (REQUIRED): the arm generation nonce from the
   * descriptor (`armId`) of the checkpoint being released. The pin's reflog
   * records which generation created it, and release requires that entry to
   * name THIS arm before any destructive step — so a stale prior generation
   * armed at the SAME commit cannot release a newer arm reusing the window
   * id (the base alone cannot distinguish them). A missing or mismatched
   * generation fails with `release_owner_stale` and removes nothing.
   */
  armId: string;
}

/**
 * Release the baseline pin for a window: delete the owned ref and remove the
 * owned scratch directory. Idempotent — releasing an already-released (or
 * never-armed) window succeeds with `released: false`. Only refs inside the
 * owned namespace are ever deleted.
 *
 * Destructive release requires BOTH owner proofs — `expectedBase` AND the
 * arm generation nonce `armId` (see {@link GitCheckpointReleaseOptions}).
 * The base check guards against a different base commit; the generation
 * check reads the pin's reflog and requires its latest entry to name THIS
 * arm, which closes the same-commit gap: two generations armed at the same
 * HEAD are indistinguishable by base alone. A call with missing or
 * malformed owner data fails closed with `release_owner_required` before
 * any Git work; a stale generation fails with `release_owner_stale`; in
 * both cases nothing is deleted.
 *
 * If the reflog proof has been expired or removed (for example by an
 * aggressive `git reflog expire`), release fails closed with
 * `release_owner_stale`. Bounded manual recovery: an operator who can verify
 * ownership out-of-band may delete ONLY this window's owned ref —
 * `git update-ref -d <ref> <expectedBase>` (the expected-value form, so a
 * moved ref is left alone) — and remove only the window's owned scratch
 * directory under `<gitDir>/pi-review-gate/checkpoints/<windowId>`. Never
 * delete other sessions' refs or other windows' scratch.
 *
 * A release whose pin is already gone leaves scratch in place (it may belong
 * to a live same-id arm). Successful release removes only its own arm's
 * directory; stale directories require bounded manual recovery.
 */
export async function releaseGitCheckpointPin(
  root: string,
  windowId: string,
  options?: GitCheckpointReleaseOptions,
): Promise<GitCheckpointResult<{ released: boolean }>> {
  const gitPath = options?.gitPath ?? "git";
  const spec: GitRunSpec = { timeoutMs: options?.timeoutMs ?? DEFAULT_TIMEOUT_MS, maxBytes: 1024 * 1024, signal: options?.signal };
  try {
    throwIfAborted(spec.signal);
    if (!isSafeWindowId(windowId)) {
      return { status: "failed", reason: "unsafe_window_id", detail: `unsafe checkpoint window id ${JSON.stringify(windowId)}` };
    }
    // Destructive release requires BOTH owner proofs. An unguarded delete
    // could remove a different owner's pin for the same window id — including
    // a newer generation armed at the very same commit — so missing or
    // malformed tokens fail closed before any Git work begins.
    const expectedBase = options?.expectedBase;
    if (typeof expectedBase !== "string" || !(OID_RE_40.test(expectedBase) || OID_RE_64.test(expectedBase))) {
      return {
        status: "failed",
        reason: "release_owner_required",
        detail: truncateDetail("destructive release requires the owner's base commit (the persisted record's `base`) as expectedBase; refusing to delete a pin without proving ownership"),
      };
    }
    const armId = options?.armId;
    if (typeof armId !== "string" || !isSafeArmId(armId)) {
      return {
        status: "failed",
        reason: "release_owner_required",
        detail: truncateDetail("destructive release requires the owner's arm generation nonce (the descriptor's `armId`) as armId; a stale prior generation at the same commit must not be able to release a newer pin"),
      };
    }
    const resolved = await resolveRepo(gitPath, root, spec);
    if (resolved.status !== "ok") return resolved;
    const repo = resolved.value;

    const unlockPin = await acquireWindowPinLock(repo.gitDir, windowId, spec);
    try {
    const ref = checkpointRefForWindow(windowId);
    let checkOut: GitRunOutput;
    try {
      checkOut = await runGit(gitPath, repo.root, ["rev-parse", "--verify", "--quiet", ref], spec);
    } catch (error) {
      return resultFromError(error);
    }
    const hadRef = checkOut.code === 0;
    if (hadRef) {
      const pinned = checkOut.stdout.toString("utf8").trim();
      if (pinned !== expectedBase) {
        return {
          status: "failed",
          reason: "pin_ref_mismatch",
          detail: truncateDetail(
            `pin ref ${ref} is owned by base ${pinned}, not the expected ${expectedBase}; refusing to release a different checkpoint`,
          ),
        };
      }
      // Generation proof: the pin's LATEST reflog entry must name THIS arm.
      // The entry was written in the same atomic unit as the pin update, so
      // it cannot disagree with who owns the ref — a stale prior generation
      // at the same base is refused here even though the base check passed.
      let genOut: GitRunOutput;
      try {
        genOut = await runGit(gitPath, repo.root, ["log", "-g", "-1", "--format=%gs", ref], spec);
      } catch (error) {
        return resultFromError(error);
      }
      const generation = genOut.code === 0 ? genOut.stdout.toString("utf8").trim() : "";
      if (generation !== pinGenerationMessage(armId)) {
        return {
          status: "failed",
          reason: "release_owner_stale",
          detail: truncateDetail(
            `pin ref ${ref} is owned by a different checkpoint generation than arm ${armId}; refusing to release without the current owner's generation proof`,
          ),
        };
      }
      // The per-window lock holds through proof, deletion, AND cleanup; the
      // expected-base CAS alone cannot protect a same-base re-arm.
      await options?.faultHooks?.beforePinReleaseDelete?.();
      let delOut: GitRunOutput;
      try {
        delOut = await runGit(gitPath, repo.root, ["update-ref", "--no-deref", "-m", "prg-git-checkpoint release", "-d", ref, expectedBase], spec);
      } catch (error) {
        return resultFromError(error);
      }
      if (delOut.code !== 0) {
        // Re-probe: a ref that moved after the check is an owner mismatch,
        // not a Git failure.
        let recheckOut: GitRunOutput;
        try {
          recheckOut = await runGit(gitPath, repo.root, ["rev-parse", "--verify", "--quiet", ref], spec);
        } catch (error) {
          return resultFromError(error);
        }
        if (recheckOut.code === 0 && recheckOut.stdout.toString("utf8").trim() !== expectedBase) {
          return {
            status: "failed",
            reason: "pin_ref_mismatch",
            detail: truncateDetail(
              `pin ref ${ref} moved to ${recheckOut.stdout.toString("utf8").trim()} before release; refusing to remove a different checkpoint`,
            ),
          };
        }
        return { status: "failed", reason: "git_failed", detail: truncateDetail(delOut.stderr || `update-ref -d exit ${delOut.code}`) };
      }
    } else {
      // Release of an already-gone pin: the window scratch may belong to a
      // live same-id arm, so it is left in place as well.
      return { status: "ok", value: { released: false } };
    }
    await options?.faultHooks?.afterPinReleaseDelete?.();
    // Remove only this arm's record. An older interrupted arm may still
    // have scratch here; neither it nor a later arm is ours to delete.
    await removeWindowScratch(repo.gitDir, windowId, armId);
    return { status: "ok", value: { released: hadRef } };
    } finally {
      await unlockPin();
    }
  } catch (error) {
    return resultFromError(error);
  }
}

/** Remove the owned scratch directory for a window (idempotent). */
async function removeWindowScratch(gitDir: string, windowId: string, armId: string): Promise<void> {
  const windowDir = join(gitDir, SCRATCH_SUBDIR, windowId);
  try {
    await rm(join(windowDir, `arm-${armId}`), { recursive: true, force: true });
    await rmdir(windowDir); // only when no other generation has scratch
  } catch { /* best effort — release still succeeds if the ref is gone */ }
}
