/**
 * #233: checkpoint pin ownership and verification (extracted from
 * git-checkpoint.ts). Zero-OID compare-and-set pin creation, the interprocess
 * per-window lock, generation-proof-gated failed-arm cleanup, and the
 * read-only pin/generation verifications that load/restore/compare/release
 * apply before acting on a record.
 */

import { mkdir, rm, rmdir } from "node:fs/promises";
import { dirname, join } from "node:path";

import { GitCheckpointError, fsCodeOf, resultFromError, throwIfAborted, truncateDetail, type GitCheckpointResult } from "./errors";
import { checkpointRefForWindow, type GitCheckpointRecord } from "./record";
import { DEFAULT_TIMEOUT_MS, runGit, type GitRunOutput, type GitRunSpec } from "./run-git";
import type { ResolvedRepo } from "./audit";
import type { GitCheckpointOptions } from "./types";

/** Bounded retries when a pin create loses to a concurrent ref lock. */
const PIN_CREATE_ATTEMPTS = 4;
const PIN_SETTLE_MS = 25;

/** Reflog subject that marks which arm generation owns a pin. */
export function pinGenerationMessage(armId: string): string {
  return `prg-git-checkpoint arm-${armId}`;
}

/**
 * Create the owned pin ref only if it does not exist yet: a compare-and-set
 * against the zero OID for the repository's object format. An existing
 * same-id pin is reported as an explicit `pin_ref_exists` failure — never
 * overwritten. A CAS that loses to a concurrent ref lock (ref still absent)
 * is retried a bounded number of times before failing closed. The update is
 * reflog-annotated with the arm generation nonce: the entry lands in the
 * same atomic unit as the ref write, so "the pin exists at this base" and
 * "this generation owns it" can never disagree.
 */
export async function createPinIfMissing(
  gitPath: string,
  root: string,
  ref: string,
  base: string,
  zeroOid: string,
  armId: string,
  spec: GitRunSpec,
): Promise<GitCheckpointResult<"created">> {
  let lastErrorDetail = "";
  for (let attempt = 0; attempt < PIN_CREATE_ATTEMPTS; attempt++) {
    if (attempt > 0) await sleepMs(PIN_SETTLE_MS);
    let pinOut: GitRunOutput;
    try {
      pinOut = await runGit(gitPath, root, ["update-ref", "--no-deref", "-m", pinGenerationMessage(armId), ref, base, zeroOid], spec);
    } catch (error) {
      return resultFromError(error);
    }
    if (pinOut.code === 0) return { status: "ok", value: "created" };
    // The CAS lost. Probe the ref: if it now names an object, another
    // same-id checkpoint owns the window and this arm must fail without
    // touching anything; if it is still absent, the failure was transient
    // (e.g. a concurrent ref lock) and one more attempt is safe.
    let probeOut: GitRunOutput;
    try {
      probeOut = await runGit(gitPath, root, ["rev-parse", "--verify", "--quiet", ref], spec);
    } catch (error) {
      return resultFromError(error);
    }
    if (probeOut.code === 0) {
      const existing = probeOut.stdout.toString("utf8").trim();
      return {
        status: "failed",
        reason: "pin_ref_exists",
        detail: truncateDetail(`checkpoint pin ${ref} already exists at ${existing}; refusing to overwrite an existing same-id checkpoint`),
      };
    }
    lastErrorDetail = pinOut.stderr || `update-ref exit ${pinOut.code}`;
  }
  return { status: "failed", reason: "git_failed", detail: truncateDetail(lastErrorDetail) };
}

/**
 * Interprocess window mutex. The lock lives OUTSIDE window scratch so a
 * release cannot remove it while held. Never steal an abandoned lock: a
 * timed-out contender fails closed; an operator may remove the lock after
 * establishing that no checkpoint process still holds it.
 */
export async function acquireWindowPinLock(
  gitDir: string, windowId: string, spec: GitRunSpec,
  onContended?: () => void | Promise<void>,
): Promise<() => Promise<void>> {
  const locksDir = join(gitDir, "pi-review-gate", "checkpoint-pin-locks");
  const lockDir = join(locksDir, windowId);
  await mkdir(locksDir, { recursive: true });
  const deadline = Date.now() + spec.timeoutMs;
  while (true) {
    throwIfAborted(spec.signal);
    try {
      await mkdir(lockDir);
      return async () => { await rmdir(lockDir); };
    } catch (error) {
      if (fsCodeOf(error) !== "EEXIST") throw error;
      await onContended?.();
      if (Date.now() >= deadline) {
        throw new GitCheckpointError(`checkpoint pin lock for ${windowId} is held or abandoned; refusing to mutate the pin`, "git_failed");
      }
      await sleepMs(PIN_SETTLE_MS);
    }
  }
}

function sleepMs(ms: number): Promise<void> {
  return new Promise((resolvePromise) => {
    setTimeout(resolvePromise, ms);
  });
}

/**
 * Remove exactly what THIS arm created after a failure. The pin ref is
 * deleted only while THIS arm's generation still owns it — the base-only CAS
 * alone would also match a NEWER generation that recreated the same pin at
 * the same commit while this arm was in flight (concurrent release + re-arm,
 * or documented operator recovery), and deleting that would strip GC
 * protection from a live checkpoint. When the reflog proof is missing or
 * names another arm, the ref is left in place (bounded manual recovery
 * applies) and only this arm's own scratch subdirectory is removed; the
 * shared window scratch directory goes away only when empty (rmdir), so a
 * concurrent same-id arm's files are never destroyed.
 */
export async function cleanupAfterFailedArm(
  gitPath: string,
  repo: ResolvedRepo,
  windowId: string,
  base: string,
  armId: string,
  armScratchDir: string,
  spec: GitRunSpec,
): Promise<void> {
  // Cleanup must run even when the caller's signal is already aborted,
  // otherwise a canceled arm leaks the owned pin ref (and its objects).
  const cleanupSpec: GitRunSpec = { ...spec, signal: undefined };
  // Generation proof first: the pin's LATEST reflog entry must name THIS
  // arm. The entry was written atomically with this arm's pin create, so a
  // mismatch means someone else now owns the ref — leave it alone.
  // A cleanup racing another release/re-arm must hold the SAME interprocess
  // lock. If the lock cannot be obtained, leave the pin in place: no proof
  // can authorize deleting it later outside this critical section.
  let unlockPin: (() => Promise<void>) | undefined;
  try {
    unlockPin = await acquireWindowPinLock(repo.gitDir, windowId, cleanupSpec);
    let genOut: GitRunOutput | undefined;
    try {
      genOut = await runGit(gitPath, repo.root, ["log", "-g", "-1", "--format=%gs", checkpointRefForWindow(windowId)], cleanupSpec);
    } catch { /* best effort — no proof, so no delete */ }
    if (genOut !== undefined && genOut.code === 0 && genOut.stdout.toString("utf8").trim() === pinGenerationMessage(armId)) {
      try {
        await runGit(
          gitPath,
          repo.root,
          ["update-ref", "--no-deref", "-m", "prg-git-checkpoint cleanup", "-d", checkpointRefForWindow(windowId), base],
          cleanupSpec,
        );
      } catch { /* best effort */ }
    }

    try {
      await rm(armScratchDir, { recursive: true, force: true });
    } catch { /* best effort */ }
    // Drop the shared window dir only if empty; never delete other arms.
    try { await rmdir(dirname(armScratchDir)); } catch { /* non-empty */ }
  } catch { /* no lock/proof: leave the pin for bounded manual recovery */ }
  finally { await unlockPin?.(); }
}

// ── Pin verification ─────────────────────────────────────────────────────────

/**
 * Verify that the record's owned pin ref still exists, points exactly at the
 * recorded base commit, and that the base object is present. This is the
 * first gate of restore/compare: a missing or moved pin fails closed with a
 * specific reason instead of reconstructing from an unknown state.
 */
export async function verifyGitCheckpointPin(
  root: string,
  record: GitCheckpointRecord,
  options: GitCheckpointOptions = {},
): Promise<GitCheckpointResult<void>> {
  const gitPath = options.gitPath ?? "git";
  const spec: GitRunSpec = { timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS, maxBytes: 1024 * 1024, signal: options.signal };
  try {
    throwIfAborted(spec.signal);
    let refOut: GitRunOutput;
    try {
      refOut = await runGit(gitPath, root, ["rev-parse", "--verify", "--quiet", `${record.ref}^{commit}`], spec);
    } catch (error) {
      return resultFromError(error);
    }
    if (refOut.code !== 0) {
      return { status: "failed", reason: "pin_ref_missing", detail: `owned pin ref ${record.ref} is gone; the baseline commit may have been pruned` };
    }
    const pinned = refOut.stdout.toString("utf8").trim();
    if (pinned !== record.base) {
      return { status: "failed", reason: "pin_ref_mismatch", detail: `pin ref ${record.ref} points at ${pinned}, not the recorded base ${record.base}` };
    }
    let catOut: GitRunOutput;
    try {
      catOut = await runGit(gitPath, root, ["cat-file", "-e", `${record.base}^{commit}`], spec);
    } catch (error) {
      return resultFromError(error);
    }
    if (catOut.code !== 0) {
      return { status: "failed", reason: "pin_object_missing", detail: `base commit ${record.base} is missing from the object store` };
    }
    return { status: "ok", value: undefined };
  } catch (error) {
    return resultFromError(error);
  }
}

/**
 * Verify that the checkpoint pin's LATEST reflog entry names exactly the
 * given arm generation — the fail-closed proof that the pin is currently
 * owned by this record's arm, not a newer same-base re-arm. Read-only.
 * Returns a failed result when the proof is missing or mismatched (an
 * expired reflog included), or undefined when it holds.
 */
export async function verifyPinGeneration(
  gitPath: string,
  root: string,
  ref: string,
  armId: string,
  spec: GitRunSpec,
): Promise<GitCheckpointResult<never> | undefined> {
  let genOut: GitRunOutput;
  try {
    genOut = await runGit(gitPath, root, ["log", "-g", "-1", "--format=%gs", ref], spec);
  } catch (error) {
    return resultFromError(error);
  }
  if (genOut.code !== 0 || genOut.stdout.toString("utf8").trim() !== pinGenerationMessage(armId)) {
    return {
      status: "failed",
      reason: "pin_generation_mismatch",
      detail: truncateDetail(`pin ref ${ref} is owned by a different checkpoint generation than arm ${armId}; refusing to act on a stale record`),
    };
  }
  return undefined;
}
