/**
 * Opt-in cleanup of the native Pi session histories this project spawned (#533).
 *
 * `deleteSpawnedPiSessionsOnCleanup` (default off) extends EXISTING artifact
 * cleanup: when cleanup already removes a review bundle or a wave/execution
 * artifact root, the exact native session files those artifacts reference are
 * deleted at the same moment. Nothing here selects, schedules, sweeps, or ages
 * anything — the caller's existing selection is the only eligibility, so:
 *
 * - no session is deleted while its artifact is retained or protected;
 * - unrelated primary, historical, and non-Pi histories are never touched;
 * - there is no shared native-store scan, glob, index, or sidecar purge, and no
 *   eager deletion when the setting is switched on.
 *
 * Association comes only from each owner artifact's own canonical references
 * (`<ownerArtifactDir>/pi-sessions/<session-id>.json`, written by
 * `src/pi-session-reference.ts`). For every reference the native header must
 * still prove that exact id and workspace before the referenced `.jsonl` is
 * unlinked; anything unverifiable is preserved and reported, never guessed at,
 * and nothing but a native `.jsonl` session file is ever unlinked. The selected
 * root, bundle, staging directory, and every owner traversed below must itself
 * be a REAL directory — a symlinked one is never followed, because the caller's
 * own removal would only unlink the symlink while these deletions landed on its
 * target. The known owner layouts are traversed directly:
 *
 *   review bundle:   <bundle>/{reviews,questions}/<sequence>/reviewers/<id>/
 *   reviewer staging: <staging>/                  (canceled/failed pass only)
 *   wave/exec root:  <root>/artifacts/<taskId>/
 *
 * An unlink failure is reported, never hidden: the reference and its artifact
 * stay intact, the removal raises a `PiSessionCleanupError`, and the caller
 * decides how to surface it. A shutdown-bound caller can disclose that typed
 * failure and keep finalizing (`removeArtifactRetainingOnSessionCleanupFailure`);
 * every other caller's error path is unchanged.
 */
import { lstat, readdir, unlink } from "node:fs/promises";
import { join } from "node:path";
import {
  iteratePiSessionReferences,
  verifyPiSessionReference,
} from "./pi-session-reference";

/** Cleanup call-site options; only the existing removal points pass them. */
export interface SpawnedPiSessionCleanupOptions {
  /**
   * `deleteSpawnedPiSessionsOnCleanup`: delete the native sessions associated
   * with the artifacts this cleanup is ALREADY removing.
   */
  deleteSpawnedPiSessions?: boolean;
}

/** One referenced native session file that was deleted. */
export interface PiSessionDeletionFailure {
  file: string;
  message: string;
}

/** One referenced native session file left untouched, with the reason. */
export interface PreservedPiSession {
  file: string;
  reason: string;
}

export interface PiSessionDeletionReport {
  deleted: string[];
  preserved: PreservedPiSession[];
  failures: PiSessionDeletionFailure[];
}

/** Review-bundle invocation kinds; each holds one `reviewers/` set per sequence. */
const REVIEW_BUNDLE_INVOCATION_DIRS = ["reviews", "questions"] as const;

function emptyReport(): PiSessionDeletionReport {
  return { deleted: [], preserved: [], failures: [] };
}

function mergeReports(reports: readonly PiSessionDeletionReport[]): PiSessionDeletionReport {
  const merged = emptyReport();
  for (const report of reports) {
    merged.deleted.push(...report.deleted);
    merged.preserved.push(...report.preserved);
    merged.failures.push(...report.failures);
  }
  return merged;
}

/**
 * Real (never symlinked) direct child directories of one known-layout directory.
 * A missing directory, a file, or an owned-looking symlink contributes nothing,
 * so traversal can never leave the artifact being removed.
 */
async function realChildDirectories(dir: string): Promise<string[]> {
  const info = await lstat(dir).catch(() => undefined);
  if (!info?.isDirectory() || info.isSymbolicLink()) return [];
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  const children: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
    const path = join(dir, entry.name);
    const child = await lstat(path).catch(() => undefined);
    if (!child?.isDirectory() || child.isSymbolicLink()) continue;
    children.push(path);
  }
  return children;
}

/** The one native session file extension this cleanup will ever unlink. */
const NATIVE_SESSION_FILE_EXTENSION = ".jsonl";

/**
 * A selected root, bundle, staging directory, or owner artifact must itself be a
 * REAL directory.
 *
 * A symlinked `wave-*` root passes the existing lexical ownership guard, but the
 * caller's own removal only unlinks the symlink: traversing it here would delete
 * the sessions of whatever the link points at while those foreign artifacts
 * survive. Absence is not a refusal — there is simply nothing to traverse.
 */
async function ownerDirectoryRefusal(path: string): Promise<string | undefined> {
  const info = await lstat(path).catch(() => undefined);
  if (!info) return undefined;
  if (info.isSymbolicLink()) {
    return `${path} is a symlink, so no session reference was read through it`;
  }
  if (!info.isDirectory()) {
    return `${path} is not a directory, so no session reference was read through it`;
  }
  return undefined;
}

/**
 * Delete the exact native session files ONE owner artifact references.
 *
 * Never throws for a reference this cleanup cannot honour: an unusable or
 * unverifiable reference, a symlinked owner or reference directory, a
 * non-`.jsonl` target, an already-absent file, and an unlink failure are all
 * reported instead, so the caller keeps its own cleanup error conventions and
 * decides what to surface. Only the exact native `.jsonl` named by a verified
 * reference is removed — never a sidecar, index, backup, sibling session, or
 * anything under the shared store.
 */
export async function deleteReferencedPiSessions(ownerArtifactDir: string): Promise<PiSessionDeletionReport> {
  const report = emptyReport();
  const refusal = await ownerDirectoryRefusal(ownerArtifactDir);
  if (refusal) {
    report.preserved.push({ file: ownerArtifactDir, reason: refusal });
    return report;
  }
  for await (const entry of iteratePiSessionReferences(ownerArtifactDir)) {
    if (!entry.reference) {
      report.preserved.push({
        file: entry.path,
        reason: entry.detail ?? "the session reference is not a usable canonical record",
      });
      continue;
    }
    if (!entry.reference.file.endsWith(NATIVE_SESSION_FILE_EXTENSION)) {
      report.preserved.push({
        file: entry.reference.file,
        reason: `only a native ${NATIVE_SESSION_FILE_EXTENSION} session file is deleted, so this reference was preserved`,
      });
      continue;
    }
    const verified = verifyPiSessionReference(entry.reference);
    if (!verified.ok) {
      report.preserved.push({ file: entry.reference.file, reason: verified.message });
      continue;
    }
    try {
      await unlink(entry.reference.file);
      report.deleted.push(entry.reference.file);
    } catch (error) {
      if ((error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") {
        // Already gone between verification and removal: nothing leaked.
        report.deleted.push(entry.reference.file);
        continue;
      }
      report.failures.push({
        file: entry.reference.file,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return report;
}

/**
 * Delete the spawned sessions of one review bundle that is being removed.
 * Every published reviewer invocation of every pass is covered; the bundle
 * root's own layout holds no other session reference.
 */
export async function deleteReviewBundlePiSessions(bundleDir: string): Promise<PiSessionDeletionReport> {
  const refusal = await ownerDirectoryRefusal(bundleDir);
  if (refusal) {
    return { deleted: [], preserved: [{ file: bundleDir, reason: refusal }], failures: [] };
  }
  const reports: PiSessionDeletionReport[] = [];
  for (const kind of REVIEW_BUNDLE_INVOCATION_DIRS) {
    for (const invocation of await realChildDirectories(join(bundleDir, kind))) {
      for (const reviewer of await realChildDirectories(join(invocation, "reviewers"))) {
        reports.push(await deleteReferencedPiSessions(reviewer));
      }
    }
  }
  return mergeReports(reports);
}

/**
 * Delete the spawned sessions of every task artifact under one owned wave or
 * execution root that is being removed. Reviewer bundles spawned by workers are
 * not part of this layout and are left exactly as before.
 */
export async function deleteOwnedRootPiSessions(root: string): Promise<PiSessionDeletionReport> {
  const refusal = await ownerDirectoryRefusal(root);
  if (refusal) {
    return { deleted: [], preserved: [{ file: root, reason: refusal }], failures: [] };
  }
  return await deleteChildOwnerPiSessions(join(root, "artifacts"));
}

/** Delete the spawned sessions of every owner artifact directly under `dir`. */
export async function deleteChildOwnerPiSessions(dir: string): Promise<PiSessionDeletionReport> {
  const reports: PiSessionDeletionReport[] = [];
  for (const artifact of await realChildDirectories(dir)) {
    reports.push(await deleteReferencedPiSessions(artifact));
  }
  return mergeReports(reports);
}

/**
 * Delete the spawned sessions of ONE abandoned reviewer staging directory.
 *
 * A canceled pass and a failed reviewer publication genuinely discard their
 * staged review artifacts, so this rides that existing cleanup exactly as the
 * bundle removals do. A SUCCESSFUL publication is not retirement: it renames
 * (or, on EXDEV, copies and then removes) the staging directory into the
 * invocation, so nothing is deleted here for it.
 */
export async function deleteReviewerStagingPiSessions(
  stagingDir: string,
  options: SpawnedPiSessionCleanupOptions,
): Promise<PiSessionDeletionFailure[]> {
  if (!options.deleteSpawnedPiSessions) return [];
  return (await deleteReferencedPiSessions(stagingDir)).failures;
}

/**
 * Delete the spawned sessions of the reviewer set abandoned inside a failed
 * publication's private `.reviewers-*` root. Already-published copies are
 * untouched.
 */
export async function deleteAbandonedReviewerSetPiSessions(
  stagedRoot: string,
  options: SpawnedPiSessionCleanupOptions,
): Promise<PiSessionDeletionFailure[]> {
  if (!options.deleteSpawnedPiSessions) return [];
  return (await deleteChildOwnerPiSessions(stagedRoot)).failures;
}

/** One bounded diagnostic line naming every spawned-session cleanup failure. */
export function describePiSessionDeletionFailures(
  failures: readonly PiSessionDeletionFailure[],
  subject: string,
): string {
  return `spawned Pi session cleanup failed for ${subject}: ${failures.map((failure) => `${failure.file} (${failure.message})`).join("; ")}`;
}

/**
 * A native-session cleanup failure raised by the opt-in deletion.
 *
 * Typed so a caller whose own work still has to finish — a `session_shutdown`
 * handler that owes durable persistence and finalization — can tell it apart
 * from the removal's pre-existing errors. The selected artifact stays retained
 * by the removal that threw, so its references survive for a later attempt and
 * the failure is disclosed instead of aborting the caller. Ownership refusals,
 * artifact `rm` failures, and every other error stay plain errors and propagate
 * exactly as they did before this option existed.
 */
export class PiSessionCleanupError extends Error {
  readonly failures: readonly PiSessionDeletionFailure[];
  readonly subject: string;

  constructor(failures: readonly PiSessionDeletionFailure[], subject: string) {
    super(describePiSessionDeletionFailures(failures, subject));
    this.name = "PiSessionCleanupError";
    this.failures = failures;
    this.subject = subject;
  }
}

/**
 * True only for a native-session cleanup failure. The name-and-shape check keeps
 * the distinction working when the extension is loaded more than once in one
 * process, where a second module copy carries its own class identity.
 */
export function isPiSessionCleanupError(error: unknown): error is PiSessionCleanupError {
  if (error instanceof PiSessionCleanupError) return true;
  if (typeof error !== "object" || error === null) return false;
  const candidate = error as { name?: unknown; failures?: unknown };
  return candidate.name === "PiSessionCleanupError" && Array.isArray(candidate.failures);
}

/**
 * Surface deletion failures through the calling cleanup's own error path.
 *
 * A root whose associated sessions could not all be deleted is retained by its
 * caller instead of being removed while histories leak, so the failure stays
 * visible and retryable rather than silent.
 */
export function throwPiSessionDeletionFailures(
  failures: readonly PiSessionDeletionFailure[],
  subject: string,
): void {
  if (failures.length === 0) return;
  throw new PiSessionCleanupError(failures, subject);
}

/**
 * Run one removal whose opt-in session deletion may fail, for a caller that must
 * finish its own work either way.
 *
 * Returns `true` when the artifact was removed, and `false` when it was retained
 * because one of its referenced native sessions could not be deleted: the
 * failure is reported through `onCleanupFailure` instead of propagating, so the
 * shutdown sequence that owns this cleanup still performs its persistence and
 * finalization and still removes the other selected artifacts. Any other error —
 * an ownership refusal, an artifact `rm` failure, process teardown — is rethrown
 * unchanged, so no pre-existing fail-closed path is softened.
 */
export async function removeArtifactRetainingOnSessionCleanupFailure(
  remove: () => Promise<void>,
  onCleanupFailure: (error: PiSessionCleanupError) => void | Promise<void>,
): Promise<boolean> {
  try {
    await remove();
    return true;
  } catch (error) {
    if (!isPiSessionCleanupError(error)) throw error;
    await onCleanupFailure(error);
    return false;
  }
}
