/**
 * #233: durable by-ID checkpoint reload (extracted from git-checkpoint.ts).
 * Re-validates a compact descriptor against the repository identity, the
 * stored record's digest/strict contents, exact pin/ref/base/object
 * reachability, and the pin's current owning generation — read-only.
 */

import { createHash } from "node:crypto";
import { constants, type Stats } from "node:fs";
import { open, realpath, stat } from "node:fs/promises";
import { join } from "node:path";

import { fsCodeOf, messageOf, resultFromError, throwIfAborted, truncateDetail, type GitCheckpointResult } from "./errors";
import { SCRATCH_SUBDIR, assertValidDescriptor, decodeGitCheckpointRecord, type GitCheckpointDescriptor, type GitCheckpointRecord } from "./record";
import { DEFAULT_MAX_PATCH_BYTES, DEFAULT_MAX_UNTRACKED_BYTES, DEFAULT_TIMEOUT_MS, type GitRunSpec } from "./run-git";
import { resolveRepo } from "./audit";
import { verifyGitCheckpointPin, verifyPinGeneration } from "./pin";
import type { GitCheckpointOptions } from "./types";

// ── Durable by-ID reload ───────────────────────────────────────────────────

export interface GitCheckpointLoadOutcome {
  /** The fully verified checkpoint record (in memory only). */
  record: GitCheckpointRecord;
  /** The verified exact published record bytes, as the UTF-8 JSON string. */
  encoded: string;
}

/**
 * Reload and verify a checkpoint from its compact descriptor in a FRESH
 * process — after HEAD movement, `git gc --prune=now`, or a restart — using
 * only the descriptor plus the repository itself.
 *
 * Verification gates (each fails closed with an explicit reason, and NOTHING
 * is mutated — no sidecar write, no scratch change, no index/worktree touch):
 * 1. Descriptor schema: format tag, safe window id, arm nonce, absolute git
 *    dir, base/ref/object-format consistency, sha256 digest shape.
 * 2. Repository identity: the descriptor's git dir (real path) must equal
 *    THIS repository's git dir — a descriptor from another checkout is
 *    refused with `wrong_repository`.
 * 3. Data presence, type, and size: the record file in this arm's owned
 *    scratch directory (`arm-<armId>/record.json`) must exist
 *    (`checkpoint_data_missing`), be a regular file — never a symlink,
 *    FIFO, or device (`malformed_record`; opened O_NOFOLLOW) — and be at
 *    most 2 * (2 * maxPatchBytes + maxUntrackedBytes) bytes, the
 *    base64-inflated size of every capture arm allows plus envelope margin
 *    (`malformed_record`), all checked before anything is buffered.
 * 4. Integrity: the stored bytes must hash to the descriptor's digest
 *    (`checkpoint_digest_mismatch`), decode strictly (`malformed_record`),
 *    and agree with the descriptor on base/ref/object format/armId
 *    (`descriptor_record_mismatch`).
 * 5. Reachability: the owned pin ref must exist, point exactly at the
 *    recorded base commit, and that commit object must be present
 *    (`pin_ref_missing` / `pin_ref_mismatch` / `pin_object_missing`), and
 *    the pin's LATEST reflog entry must name this arm's generation — a stale
 *    record directory that survived an interrupted release cannot be loaded
 *    over a newer same-base arm (`pin_generation_mismatch`).
 *
 * On success the full record is returned in memory only; pass the returned
 * `encoded` to `restoreGitCheckpoint` / `compareToGitCheckpoint`.
 */
export async function loadGitCheckpoint(
  root: string,
  descriptor: GitCheckpointDescriptor,
  options: GitCheckpointOptions = {},
): Promise<GitCheckpointResult<GitCheckpointLoadOutcome>> {
  const gitPath = options.gitPath ?? "git";
  const spec: GitRunSpec = { timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS, maxBytes: 1024 * 1024, signal: options.signal };
  try {
    throwIfAborted(spec.signal);

    // Gate 1: descriptor schema — before any I/O of any kind.
    const valid = assertValidDescriptor(descriptor);

    const resolved = await resolveRepo(gitPath, root, spec);
    if (resolved.status !== "ok") return resolved;
    const repo = resolved.value;
    throwIfAborted(spec.signal);

    // Gate 2: repository identity. The descriptor names the git dir it was
    // armed in; a different checkout is a different repository, full stop.
    let gitDirReal: string;
    try {
      gitDirReal = await realpath(repo.gitDir);
    } catch (error) {
      return { status: "failed", reason: "git_failed", detail: truncateDetail(`cannot resolve the git directory: ${messageOf(error)}`) };
    }
    if (gitDirReal !== valid.gitDir) {
      return {
        status: "failed",
        reason: "wrong_repository",
        detail: `descriptor names git dir ${valid.gitDir}, but this repository's git dir is ${gitDirReal}; refusing to load a foreign checkpoint`,
      };
    }

    // Gate 3: the exact published record in THIS arm's owned scratch dir.
    // windowId/armId charsets were validated above, so this path cannot
    // escape the git directory.
    const recordPath = join(gitDirReal, SCRATCH_SUBDIR, valid.windowId, `arm-${valid.armId}`, "record.json");

    // Gate 3a: validate and bound the record BEFORE buffering anything. Arm
    // caps every large capture (maxPatchBytes per patch, maxUntrackedBytes
    // total), so a legitimate published record is at most base64(2P + U)
    // plus JSON envelope overhead; 2 * (2P + U) dominates that in every
    // corner and leaves margin for the envelope. The pre-read `stat` runs
    // first because OPENING a planted FIFO would block, and it rejects any
    // non-regular target (a symlink to /dev/zero reports size 0 but reads
    // unbounded). The file is then opened O_NOFOLLOW — publishRecordDurable
    // only ever publishes a regular file, so a symlinked path is planted —
    // and the type/size checks re-run via fstat on the open handle, so the
    // bound applies to the exact inode that is read (no stat-to-read swap).
    // Callers with pathological untracked entry counts can raise the bound
    // via options.
    const loadCap = 2 * (2 * (options.maxPatchBytes ?? DEFAULT_MAX_PATCH_BYTES) + (options.maxUntrackedBytes ?? DEFAULT_MAX_UNTRACKED_BYTES));
    let recordStat: Stats;
    try {
      recordStat = await stat(recordPath);
    } catch (error) {
      if (fsCodeOf(error) === "ENOENT") {
        return { status: "failed", reason: "checkpoint_data_missing", detail: `durable checkpoint record is missing: ${recordPath}` };
      }
      if (fsCodeOf(error) === "ELOOP") {
        return { status: "failed", reason: "malformed_record", detail: truncateDetail(`checkpoint record ${recordPath} is a symlink loop, not the regular file published at arm time`) };
      }
      return { status: "failed", reason: "git_failed", detail: truncateDetail(`cannot stat checkpoint record: ${messageOf(error)}`) };
    }
    if (!recordStat.isFile()) {
      return { status: "failed", reason: "malformed_record", detail: truncateDetail(`checkpoint record ${recordPath} is not a regular file; refusing to read it`) };
    }
    if (recordStat.size > loadCap) {
      return {
        status: "failed",
        reason: "malformed_record",
        detail: truncateDetail(`checkpoint record is ${recordStat.size} bytes, above the ${loadCap}-byte load cap; refusing to buffer an over-sized record`),
      };
    }

    let bytes: Buffer;
    try {
      const handle = await open(recordPath, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const opened = await handle.stat();
        if (!opened.isFile()) {
          return { status: "failed", reason: "malformed_record", detail: truncateDetail(`checkpoint record ${recordPath} is not a regular file; refusing to read it`) };
        }
        if (opened.size > loadCap) {
          return {
            status: "failed",
            reason: "malformed_record",
            detail: truncateDetail(`checkpoint record is ${opened.size} bytes, above the ${loadCap}-byte load cap; refusing to buffer an over-sized record`),
          };
        }
        bytes = await handle.readFile();
      } finally {
        await handle.close().catch(() => undefined);
      }
    } catch (error) {
      if (fsCodeOf(error) === "ENOENT") {
        return { status: "failed", reason: "checkpoint_data_missing", detail: `durable checkpoint record is missing: ${recordPath}` };
      }
      if (fsCodeOf(error) === "ELOOP") {
        return { status: "failed", reason: "malformed_record", detail: truncateDetail(`checkpoint record ${recordPath} is a symlink, not the regular file published at arm time`) };
      }
      return { status: "failed", reason: "git_failed", detail: truncateDetail(`cannot read checkpoint record: ${messageOf(error)}`) };
    }

    // Gate 4a: the stored bytes must be exactly the published ones.
    const actualDigest = createHash("sha256").update(bytes).digest("hex");
    if (actualDigest !== valid.digest) {
      return {
        status: "failed",
        reason: "checkpoint_digest_mismatch",
        detail: `record digest ${actualDigest} does not match the descriptor digest ${valid.digest}; the stored record was truncated, corrupted, or replaced`,
      };
    }

    // Gate 4b: strict decode of the verified bytes.
    let record: GitCheckpointRecord;
    try {
      record = decodeGitCheckpointRecord(bytes.toString("utf8"));
    } catch (error) {
      return resultFromError(error);
    }

    // Gate 4c: descriptor and record must describe the same generation.
    if (
      record.base !== valid.base
      || record.ref !== valid.ref
      || record.objectFormat !== valid.objectFormat
      || record.armId !== valid.armId
    ) {
      return {
        status: "failed",
        reason: "descriptor_record_mismatch",
        detail: "descriptor does not match the published record's base/ref/object format/arm id; refusing to trust either",
      };
    }

    // Gate 5: exact pin/ref/base/object reachability (read-only).
    const pinCheck = await verifyGitCheckpointPin(repo.root, record, options);
    if (pinCheck.status !== "ok") return pinCheck;

    // Gate 5b: the pin's LATEST reflog entry must name THIS arm's generation.
    // A stale record directory can survive a release (the scratch removal is
    // best effort, and a crash between the ref delete and the rm leaves it);
    // after a same-base re-arm the old descriptor would otherwise pass every
    // earlier gate — its data is intact and digest-valid — and restore an
    // older snapshot over the newer arm's state. Missing/expired proof
    // fails closed; bounded manual recovery applies as for release.
    const genCheck = await verifyPinGeneration(gitPath, repo.root, record.ref, valid.armId, spec);
    if (genCheck !== undefined) return genCheck;
    throwIfAborted(spec.signal);

    return { status: "ok", value: { record, encoded: bytes.toString("utf8") } };
  } catch (error) {
    return resultFromError(error);
  }
}
