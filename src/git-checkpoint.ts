/**
 * #193: Durable Git-backed workspace checkpoint core (Git-first strategy).
 *
 * A checkpoint arms a small, durable baseline for a Git checkout that is
 * exactly reconstructible later — across HEAD movement, index changes,
 * `git gc --prune=now`, and process restarts — without ever retaining clean
 * tracked content:
 *
 * - **base**: the pinned HEAD commit (full object id), held by an owned ref
 *   `refs/pi-review-gate/checkpoints/<windowId>/base` created at arm time.
 *   The ref keeps the base commit and everything reachable from it alive
 *   against GC until the baseline is released.
 * - **stagedPatch**: the COMPLETE binary patch `git diff --cached <base>`
 *   (base tree → index) captured at arm time.
 * - **unstagedPatch**: the COMPLETE binary patch `git diff` (index →
 *   worktree) captured at arm time.
 * - **untracked**: the exact raw bytes (or symlink target + mode) of every
 *   NON-IGNORED untracked path (`git ls-files -o --exclude-standard`), each
 *   captured no-follow with pre/post stat identity checks. Tracked-but-
 *   ignored paths stay tracked and are covered by the patches; ignored
 *   untracked paths are excluded entirely.
 *
 * Capture consistency: before publishing, arm verifies READ-ONLY that both
 * patches describe ONE consistent (index, worktree) pair. It compares the
 * tree id of a snapshot copy of the live index (`git write-tree` against an
 * alternate index in owned scratch — the live index file is never written,
 * because write-tree can rewrite the index it reads) taken before and after
 * the two patch captures, and requires a full binary `git diff` taken before
 * capture to be byte-identical to the captured unstaged patch. An interleaved `git add` or tracked edit that
 * would yield two empty patches replaying as a clean base fails closed with
 * `capture_inconsistent`; no record is published and only this arm's own pin
 * and scratch are cleaned up. The check is sampling-based: a change that
 * lands and fully reverts inside the capture window is undetectable (a
 * documented residual limit, like any snapshot).
 *
 * Reconstruction (restore/compare) uses Git's own patch/apply against an
 * ALTERNATE temporary index in owned scratch under the git directory — the
 * live index is never written incrementally. Restore materializes only the
 * paths that actually deviate from the armed state (lazy changed-content
 * materialization: clean tracked files are never read), then places the
 * reconstructed armed index with a single atomic rename after backing up the
 * current one into the owned scratch directory.
 *
 * Fail-closed contract: every Git uncertainty is refused with an explicit
 * reason rather than producing a silent gap — external diff/textconv/filter
 * programs, EOL normalization (autocrlf/core.eol/text attributes),
 * assume-unchanged and skip-worktree index flags, unmerged entries, sparse
 * checkout, tracked submodules, unborn HEAD, non-root capture paths,
 * enumeration warnings, capture races (an untracked entry changing under its
 * pre/post stat checks, or the index/tracked worktree shifting between the
 * two patch captures — arm re-verifies consistency read-only before
 * publishing), patch size overflow, malformed or missing pins.
 * `unsupported` results mean the Git strategy cannot be soundly applied to
 * this repository/state and callers may fall back to the existing filesystem
 * snapshot code; `failed` results are operational errors.
 *
 * **Compact descriptor and by-ID reload.** Arm publishes the exact encoded
 * record durably — owned scratch temp file, file fsync, atomic rename,
 * directory fsync — at
 * `<gitDir>/pi-review-gate/checkpoints/<windowId>/arm-<armId>/record.json`,
 * and returns a COMPACT `GitCheckpointDescriptor`: the safe window id, the
 * unique per-arm generation nonce (`armId`), the repository association
 * (the git dir's real path), base commit, pin ref, object format, and the
 * SHA-256 digest of the published record bytes. The descriptor never
 * contains patch or untracked content; a sidecar need store only it.
 * `loadGitCheckpoint(root, descriptor)` re-validates the descriptor schema,
 * the repository identity, the stored record's digest and strict contents,
 * exact pin/ref/base/object reachability, and that the pin's current owning
 * generation is this arm (see below), returning the full record in memory
 * only. Missing, truncated, corrupted, or mismatched data — a descriptor
 * from another checkout, and a stale same-base record outlived by a newer
 * arm — all fail closed without mutating the sidecar, the owned scratch, or
 * the workspace.
 *
 * **Generation identity (release, load, cleanup).** Every pin update is
 * reflog-annotated (`core.logAllRefUpdates=always` plus an explicit message)
 * with the arm generation that owns it; the entry lands in the same atomic
 * unit as the ref write. `releaseGitCheckpointPin` therefore requires BOTH
 * the owner's base commit AND the arm generation nonce (`armId`) before any
 * destructive step, and the pin's latest reflog entry must name that arm: a
 * stale prior generation armed at the SAME commit cannot release a newer arm
 * that reuses the window id, and a release whose generation proof is missing
 * or mismatched removes nothing. `loadGitCheckpoint` applies the same proof
 * on the load side: a record directory that survived an interrupted release
 * (best-effort scratch removal, or a crash between the ref delete and the rm)
 * cannot be loaded after a same-base re-arm — the pin's current owner must be
 * this arm (`pin_generation_mismatch`). `restoreGitCheckpoint` and
 * `compareToGitCheckpoint` apply it before acting on ANY record (including
 * caller-persisted ones), so persisting the `encoded` record instead of the
 * descriptor cannot bypass the gate. A failed arm's cleanup deletes its
 * pin only while THIS generation still owns it: a base-only CAS would also
 * match a newer generation that recreated the same pin at the same commit,
 * stripping GC protection from a live checkpoint. If the reflog proof has
 * been expired or removed, release fails closed with `release_owner_stale`
 * and load/restore/compare with `pin_generation_mismatch`; bounded manual
 * recovery is an operator verifying ownership out-of-band and deleting only
 * this window's
 * owned ref (`git update-ref -d <ref> <expectedBase>`) and its owned scratch
 * directory — never another session's refs.
 *
 * Hardened execution (mirrors src/git-read/git.ts): argv-array spawn, no
 * shell, minimal fixed environment (user/system config replaced with
 * /dev/null, no prompts, GIT_OPTIONAL_LOCKS=0 so read commands never write
 * the index, no lazy fetch, replace refs disabled), fixed `-c` overrides that
 * disable fsmonitor/untracked-cache/pager/gpgsign/submodule recursion and pin
 * `diff.submodule=short`, wall-clock timeout plus stdout byte caps. No Git
 * command in this module can execute an externally configured helper: diff
 * commands pass `--no-ext-diff --no-textconv`, and the effective repository
 * configuration is audited up front and refused when it defines diff
 * programs or clean/smudge filters (the only commands that could run them).
 *
 * POSIX only, matching the rest of the extension. This module is
 * self-contained (node builtins only) and is NOT yet wired into the
 * extension entrypoint; it exposes a clear core API for later integration:
 * `armGitCheckpoint`, `loadGitCheckpoint`, `verifyGitCheckpointPin`,
 * `restoreGitCheckpoint`, `compareToGitCheckpoint`, `compareGitCheckpoints`,
 * `releaseGitCheckpointPin`, `advanceGitCheckpoint`, plus record and
 * descriptor encode/decode.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { constants, type Stats } from "node:fs";
import { chmod, copyFile, lstat, mkdir, mkdtemp, open, readlink, rename, rm, rmdir, stat, symlink, writeFile } from "node:fs/promises";
import { realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

// ── Record format ────────────────────────────────────────────────────────────

/** Stable tag of the durable checkpoint record (bump on incompatible change). */
export const GIT_CHECKPOINT_RECORD_FORMAT = "prg-git-checkpoint/v2";

/**
 * Stable tag of the compact checkpoint descriptor (bump on incompatible
 * change). The descriptor is the only thing a sidecar must persist to be
 * able to reload and verify the full record later.
 */
export const GIT_CHECKPOINT_DESCRIPTOR_FORMAT = "prg-git-checkpoint-descriptor/v1";

/** Ref namespace owned exclusively by this module. */
export const GIT_CHECKPOINT_REF_PREFIX = "refs/pi-review-gate/checkpoints/";

/** Directory under the git directory holding per-window owned scratch. */
const SCRATCH_SUBDIR = join("pi-review-gate", "checkpoints");

export type GitCheckpointObjectFormat = "sha1" | "sha256";

/** Exact capture of one non-ignored untracked path at arm time. */
export interface GitCheckpointUntrackedEntry {
  /** Repository-root-relative path, forward slashes. */
  path: string;
  kind: "file" | "symlink";
  /** Full st_mode at capture time. */
  mode: number;
  /** Stat identity fields for cheap re-verification at restore time. */
  dev: number;
  ino: number;
  size: number;
  mtimeMs: number;
  ctimeMs: number;
  /** Raw file bytes, base64 (files only). */
  contentB64?: string;
  /** Exact symlink target string (symlinks only). */
  target?: string;
}

/**
 * The durable checkpoint record. Small by construction: clean tracked files
 * are referenced only through the pinned base commit, and the two patches
 * carry exactly the staged and unstaged deltas (binary-safe).
 */
export interface GitCheckpointRecord {
  format: typeof GIT_CHECKPOINT_RECORD_FORMAT;
  /**
   * Unique per-arm generation nonce: names this record's owned scratch
   * directory (`arm-<armId>`) and the pin reflog entry that proves which
   * generation owns the window's pin.
   */
  armId: string;
  /** Full object id of the pinned HEAD commit at arm time. */
  base: string;
  /** Owned pin ref holding the base commit against GC until release. */
  ref: string;
  objectFormat: GitCheckpointObjectFormat;
  /** Base→index complete binary patch, base64 ("" when index equals base). */
  stagedPatchB64: string;
  /** Index→worktree complete binary patch, base64 ("" when worktree equals index). */
  unstagedPatchB64: string;
  untracked: GitCheckpointUntrackedEntry[];
}

export interface GitCheckpointArmStats {
  baseCommit: string;
  stagedPatchBytes: number;
  unstagedPatchBytes: number;
  untrackedFileCount: number;
  untrackedRawBytes: number;
  /** Byte length of the encoded record. */
  recordBytes: number;
}

// ── Reasons and results ──────────────────────────────────────────────────────

/**
 * Stable repository/state conditions under which the Git checkpoint strategy
 * cannot be soundly applied. Callers may fall back to the existing
 * filesystem snapshot code for these.
 */
export type GitCheckpointUnsupportedReason =
  | "not_a_git_repository"
  | "not_repository_root"
  | "unborn_head"
  | "diff_program_configured"
  | "filter_or_eol_configured"
  | "text_attribute_in_use"
  | "assume_unchanged_entry"
  | "skip_worktree_entry"
  | "unmerged_index_entry"
  | "submodule_tracked";

/** Operational failures. These never imply a usable partial checkpoint. */
export type GitCheckpointFailureReason =
  | "git_failed"
  | "git_warning"
  | "patch_too_large"
  | "untracked_too_large"
  | "unsafe_window_id"
  | "malformed_record"
  | "pin_ref_missing"
  | "pin_ref_mismatch"
  | "pin_ref_exists"
  | "pin_object_missing"
  | "patch_apply_failed"
  | "restore_path_conflict"
  | "untracked_capture_race"
  | "untracked_unreadable"
  | "unsupported_untracked_entry"
  | "capture_inconsistent"
  | "release_owner_required"
  | "release_owner_stale"
  | "malformed_descriptor"
  | "wrong_repository"
  | "checkpoint_data_missing"
  | "checkpoint_digest_mismatch"
  | "pin_generation_mismatch"
  | "descriptor_record_mismatch"
  | "unsafe_advance_path"
  | "aborted";

export type GitCheckpointReason = GitCheckpointUnsupportedReason | GitCheckpointFailureReason;

const UNSUPPORTED_REASONS: ReadonlySet<string> = new Set([
  "not_a_git_repository",
  "not_repository_root",
  "unborn_head",
  "diff_program_configured",
  "filter_or_eol_configured",
  "text_attribute_in_use",
  "assume_unchanged_entry",
  "skip_worktree_entry",
  "unmerged_index_entry",
  "submodule_tracked",
]);

/** Error with a stable machine-readable checkpoint reason. */
export class GitCheckpointError extends Error {
  constructor(
    message: string,
    readonly reason: GitCheckpointReason,
  ) {
    super(message);
    this.name = "GitCheckpointError";
  }
}

/** Discriminated outcome of every public operation (no silent gaps). */
export type GitCheckpointResult<T> =
  | { status: "ok"; value: T }
  | { status: "unsupported"; reason: GitCheckpointUnsupportedReason; detail?: string }
  | { status: "failed"; reason: GitCheckpointFailureReason; detail?: string };

// ── Options ──────────────────────────────────────────────────────────────────

/** @internal Deterministic fault seams for regression tests. */
export interface GitCheckpointFaultHooks {
  /** Runs after the pre-stat of an untracked path, before its read. */
  beforeUntrackedRead?: (absolutePath: string) => void | Promise<void>;
  /**
   * Runs after the staged (base → index) patch is captured and immediately
   * before the unstaged (index → worktree) patch. Deterministic seam for
   * regression tests of the capture-consistency verification.
   */
  betweenPatchCaptures?: () => void | Promise<void>;
}

export interface GitCheckpointOptions {
  /** Git executable (default "git"). */
  gitPath?: string;
  /** Wall-clock cap per Git command (default 60s). */
  timeoutMs?: number;
  /** Hard cap on each binary patch (default 512 MiB); exceeding fails closed. */
  maxPatchBytes?: number;
  /** Hard cap on total captured untracked bytes (default 512 MiB). */
  maxUntrackedBytes?: number;
  signal?: AbortSignal;
  faultHooks?: GitCheckpointFaultHooks;
}

export interface GitCheckpointRestoreReport {
  /** Tree object id of the armed index state (base + staged patch). */
  armedIndexTree: string;
  /** Tree object id of the armed worktree state (armed index + unstaged patch). */
  armedWorktreeTree: string;
  /** Tracked paths that were written or deleted to converge on the armed state. */
  materializedPaths: string[];
  /** Baseline untracked paths that had to be recreated or rewritten. */
  untrackedRestored: string[];
  /** Baseline untracked paths verified unchanged by stat identity (no read). */
  untrackedVerified: number;
  /**
   * Non-ignored untracked paths present after restore that were not part of
   * the baseline. Reported, never deleted — exactness of the OLD state does
   * not license destroying newer data.
   */
  leftBehind: string[];
  /**
   * Owned scratch directory retained until release; holds `index-backup`,
   * a byte copy of the live index from before the atomic swap, so a restore
   * can be reversed manually if ever needed.
   */
  scratchDir: string;
}

export interface GitCheckpointTrackedChange {
  path: string;
  /** Current state relative to the armed worktree baseline. */
  status: "added" | "modified" | "deleted";
  /** Armed (old) content; present only with includeContents and when it existed. */
  oldBytes?: Buffer;
  /** Current content; present only with includeContents and when it exists now. */
  newBytes?: Buffer;
  /** Armed entry kind from the armed worktree tree (absent when added). */
  oldKind?: "file" | "symlink";
  /** Current worktree entry kind (absent when deleted or replaced by a directory). */
  newKind?: "file" | "symlink";
  /** Armed file mode bits (0o777) from the armed tree; git stores no permission bits for symlinks, so they are 0 (absent when added). */
  oldMode?: number;
  /** Current worktree file mode bits (regular files only; symlinks carry no link mode). */
  newMode?: number;
}

/**
 * Exact no-follow state of one untracked worktree entry at a point in time
 * (the armed baseline or the current worktree). Content is present only with
 * includeContents: raw bytes for files, the exact target string for symlinks.
 */
export interface GitCheckpointUntrackedState {
  kind: "file" | "symlink";
  /** Full st_mode at observation time (0o12xxxx for symlinks). */
  mode: number;
  /** Exact raw file bytes (files only); present with includeContents. */
  content?: Buffer;
  /** Exact symlink target string (symlinks only); present with includeContents. */
  target?: string;
}

/** One changed untracked path relative to the armed baseline. */
export interface GitCheckpointUntrackedChange {
  path: string;
  change: "added" | "removed" | "modified";
  /** Armed baseline state (absent for added paths). */
  old?: GitCheckpointUntrackedState;
  /** Current worktree state (absent for removed paths). */
  new?: GitCheckpointUntrackedState;
}

export interface GitCheckpointComparisonReport {
  trackedChanges: GitCheckpointTrackedChange[];
  untrackedAdded: string[];
  untrackedRemoved: string[];
  untrackedModified: string[];
  /**
   * Typed detail for every changed untracked path — the union of the three
   * lists above, sorted by path. Exact old/new bytes or symlink targets are
   * present only with includeContents; kind and mode always are, so a
   * mode-only change is reviewable without copying content.
   */
  untrackedChanges: GitCheckpointUntrackedChange[];
}

// ── Hardened Git execution ───────────────────────────────────────────────────

const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_PATCH_BYTES = 512 * 1024 * 1024;
const DEFAULT_MAX_UNTRACKED_BYTES = 512 * 1024 * 1024;
/** Cap for a single blob materialized during restore/compare. */
const MAX_BLOB_BYTES = 512 * 1024 * 1024;

/** Zero object ids by format — "the ref must not exist" for update-ref CAS. */
const ZERO_OID_SHA1 = "0".repeat(40);
const ZERO_OID_SHA256 = "0".repeat(64);

/** Bounded retries when a pin create loses to a concurrent ref lock. */
const PIN_CREATE_ATTEMPTS = 4;
const PIN_SETTLE_MS = 25;

function hardenedEnv(): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    LC_ALL: "C",
    // Replace user/system config entirely (also suppresses XDG discovery).
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_SYSTEM: "/dev/null",
    // Never prompt — fail instead.
    GIT_TERMINAL_PROMPT: "0",
    // Read commands must never write the index (stat cache, optional locks).
    GIT_OPTIONAL_LOCKS: "0",
    // A partial clone must never lazily fetch missing objects over the network.
    GIT_NO_LAZY_FETCH: "1",
    // Pinned SHAs must name raw objects; replace refs cannot rewrite them.
    GIT_NO_REPLACE_OBJECTS: "1",
    GIT_PAGER: "cat",
  };
}

/** -c overrides prepended to every command (command line beats repo config). */
const SAFE_CONFIG_OVERRIDES = [
  "core.fsmonitor=false",
  "core.untrackedCache=false",
  "core.pager=cat",
  // Mode capture must not depend on ambient config (repo convention: see
  // src/execution/wave-repository.ts).
  "core.filemode=true",
  "commit.gpgsign=false",
  "submodule.recurse=false",
  // Never descend into submodule repositories for diff display.
  "diff.submodule=short",
  // Capture and reconstruction must be independent of ambient diff config:
  // rename detection, coloring, and prefix rewriting would change the
  // captured patches or drop paths from changed-set computation.
  "diff.renames=false",
  "color.diff=never",
  "diff.noprefix=false",
  "diff.mnemonicPrefix=false",
  "diff.relative=false",
  // git apply must never rewrite patched bytes while writing the index.
  "apply.whitespace=nowarn",
  "gc.auto=0",
  "color.ui=false",
  // Every pin update must carry a reflog entry naming its arm generation:
  // release proves ownership of the CURRENT generation (see release docs),
  // and "always" extends automatic reflog creation beyond refs/heads.
  "core.logAllRefUpdates=always",
];

interface GitRunSpec {
  timeoutMs: number;
  maxBytes: number;
  signal?: AbortSignal;
  /** Reason reported when stdout exceeds maxBytes (default git_failed). */
  overflowReason?: GitCheckpointFailureReason;
  /** Extra environment entries layered over the hardened base environment. */
  extraEnv?: NodeJS.ProcessEnv;
}

interface GitRunOutput {
  stdout: Buffer;
  stderr: string;
  code: number;
}

const STDERR_CAP_BYTES = 8_192;

/**
 * Spawns `git --no-pager --no-replace-objects -c <safe overrides> ...args` in
 * `cwd` with the hardened environment. Resolves with capped raw output and
 * the exit code for any normal termination; rejects with GitCheckpointError
 * only on spawn failure, timeout, byte-cap overflow, or abort.
 */
function runGit(
  gitPath: string,
  cwd: string,
  args: readonly string[],
  spec: GitRunSpec,
): Promise<GitRunOutput> {
  const hasAlternateIndex = typeof spec.extraEnv?.GIT_INDEX_FILE === "string" && spec.extraEnv.GIT_INDEX_FILE.length > 0;
  const argv = ["--no-pager", "--no-replace-objects", ...configArgv(hasAlternateIndex), ...args];
  return new Promise<GitRunOutput>((resolvePromise, reject) => {
    let child: ChildProcess;
    try {
      child = spawn(gitPath, argv, {
        cwd,
        env: { ...hardenedEnv(), ...spec.extraEnv },
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      reject(new GitCheckpointError(`failed to start git: ${messageOf(error)}`, "git_failed"));
      return;
    }

    let stdout = Buffer.alloc(0);
    let stderr = Buffer.alloc(0);
    let settled = false;
    let timedOut = false;
    let aborted = false;

    const finish = (error: GitCheckpointError | null, output?: GitRunOutput): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      spec.signal?.removeEventListener("abort", onAbort);
      if (error) reject(error);
      else resolvePromise(output!);
    };

    const kill = (): void => {
      try { child.kill("SIGKILL"); } catch { /* already dead */ }
    };

    const timer = setTimeout(() => {
      timedOut = true;
      kill();
      finish(new GitCheckpointError(`git ${args[0] ?? ""} timed out after ${spec.timeoutMs}ms`, "git_failed"));
    }, spec.timeoutMs);

    const onAbort = (): void => {
      aborted = true;
      kill();
      finish(new GitCheckpointError(`git ${args[0] ?? ""} was aborted`, "aborted"));
    };
    if (spec.signal?.aborted) {
      finish(new GitCheckpointError(`git ${args[0] ?? ""} was aborted`, "aborted"));
      return;
    }
    spec.signal?.addEventListener("abort", onAbort, { once: true });

    child.stdout?.on("data", (chunk: Buffer) => {
      if (settled) return;
      if (stdout.length + chunk.length > spec.maxBytes) {
        kill();
        finish(new GitCheckpointError(
          `git ${args[0] ?? ""} output exceeded the ${spec.maxBytes}-byte cap`,
          spec.overflowReason ?? "git_failed",
        ));
        return;
      }
      stdout = Buffer.concat([stdout, chunk]);
    });

    child.stderr?.on("data", (chunk: Buffer) => {
      if (stderr.length < STDERR_CAP_BYTES) {
        stderr = Buffer.concat([stderr, chunk]).subarray(0, STDERR_CAP_BYTES);
      }
    });

    child.on("error", (error) => {
      finish(new GitCheckpointError(`failed to run git: ${messageOf(error)}`, "git_failed"));
    });

    child.on("close", (code) => {
      if (settled || timedOut || aborted) return;
      if (code === null) {
        finish(new GitCheckpointError(`git ${args[0] ?? ""} was killed by a signal`, "git_failed"));
        return;
      }
      finish(null, { stdout, stderr: stderr.toString("utf8"), code });
    });
  });
}

function configArgv(disableSplitIndex = false): string[] {
  const argv: string[] = [];
  for (const override of SAFE_CONFIG_OVERRIDES) {
    argv.push("-c", override);
  }
  // Disposable alternate indexes must not publish sharedindex.* files outside
  // their owned scratch directory.
  if (disableSplitIndex) argv.push("-c", "core.splitIndex=false");
  return argv;
}

// ── Identity and validation helpers ──────────────────────────────────────────

const OID_RE_40 = /^[0-9a-f]{40}$/;
const OID_RE_64 = /^[0-9a-f]{64}$/;
const BASE64_RE = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

function isObjectFormat(value: unknown): value is GitCheckpointObjectFormat {
  return value === "sha1" || value === "sha256";
}

function oidMatchesFormat(oid: string, format: GitCheckpointObjectFormat): boolean {
  return format === "sha1" ? OID_RE_40.test(oid) : OID_RE_64.test(oid);
}

/** Window ids become ref path segments; keep them to an unambiguous charset. */
export function isSafeWindowId(windowId: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(windowId)
    && !windowId.includes("..")
    && !windowId.endsWith(".");
}

/**
 * Arm generation nonces are 8 random bytes as lowercase hex. They become a
 * scratch directory suffix and part of the pin's reflog message, so the
 * charset is fixed to exactly what this module generates.
 */
export function isSafeArmId(armId: string): boolean {
  return /^[0-9a-f]{16}$/.test(armId);
}

/** Reflog subject that marks which arm generation owns a pin. */
function pinGenerationMessage(armId: string): string {
  return `prg-git-checkpoint arm-${armId}`;
}

/** Owned ref for one review window's baseline pin. */
export function checkpointRefForWindow(windowId: string): string {
  return `${GIT_CHECKPOINT_REF_PREFIX}${windowId}/base`;
}

function windowIdFromRef(ref: string): string | undefined {
  if (!ref.startsWith(GIT_CHECKPOINT_REF_PREFIX) || !ref.endsWith("/base")) return undefined;
  const id = ref.slice(GIT_CHECKPOINT_REF_PREFIX.length, ref.length - "/base".length);
  return isSafeWindowId(id) ? id : undefined;
}

/** Repository-relative path as emitted by Git: no absolute, no traversal. */
function isSafeRelativePath(path: string): boolean {
  if (path.length === 0 || isAbsolute(path) || path.includes("\0")) return false;
  // Raw Git path bytes are decoded lossily as UTF-8; an invalid sequence
  // becomes U+FFFD, which cannot be mapped back to the real worktree entry
  // (and would be materialized as a stray file). Refuse it, per the
  // fail-closed contract.
  if (path.includes("\uFFFD")) return false;
  const segments = path.split("/");
  for (const segment of segments) {
    if (segment === "" || segment === "." || segment === "..") return false;
  }
  return true;
}

/** Exact path or a slash-delimited descendant; `a` never selects `ab`. */
function isPathSelected(path: string, selectors: ReadonlySet<string>): boolean {
  if (selectors.has(path)) return true;
  let slash = path.indexOf("/");
  while (slash >= 0) {
    if (selectors.has(path.slice(0, slash))) return true;
    slash = path.indexOf("/", slash + 1);
  }
  return false;
}

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

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw abortError(signal);
}

function abortError(signal: AbortSignal): Error {
  if (signal.reason instanceof Error) return signal.reason;
  const error = new Error("Operation cancelled.");
  error.name = "AbortError";
  return error;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Map any thrown value to a failed result, preserving typed reasons. */
function resultFromError(error: unknown): GitCheckpointResult<never> {
  if (error instanceof Error && error.name === "AbortError") {
    return { status: "failed", reason: "aborted", detail: truncateDetail(error.message) };
  }
  if (error instanceof GitCheckpointError) {
    const detail = truncateDetail(error.message);
    if (UNSUPPORTED_REASONS.has(error.reason)) {
      return { status: "unsupported", reason: error.reason as GitCheckpointUnsupportedReason, detail };
    }
    return { status: "failed", reason: error.reason as GitCheckpointFailureReason, detail };
  }
  return { status: "failed", reason: "git_failed", detail: truncateDetail(messageOf(error)) };
}

function truncateDetail(detail: string): string {
  return detail.length > 400 ? `${detail.slice(0, 400)}…` : detail;
}

/** Stat identity used to prove a captured entry is still the same entry. */
interface StatIdentity {
  dev: number;
  ino: number;
  size: number;
  mtimeMs: number;
  ctimeMs: number;
  mode: number;
}

function statIdentityOf(stat: { dev: number; ino: number; size: number; mtimeMs: number; ctimeMs: number; mode: number }): StatIdentity {
  return { dev: stat.dev, ino: stat.ino, size: stat.size, mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs, mode: stat.mode };
}

function sameStatIdentity(actual: StatIdentity, expected: StatIdentity): boolean {
  return actual.dev === expected.dev
    && actual.ino === expected.ino
    && actual.size === expected.size
    && actual.mtimeMs === expected.mtimeMs
    && actual.ctimeMs === expected.ctimeMs
    && actual.mode === expected.mode;
}

/** Exact Git blob object id for raw bytes under the repository's format. */
function blobObjectId(objectFormat: GitCheckpointObjectFormat, bytes: Buffer): string {
  const hash = createHash(objectFormat);
  hash.update(`blob ${bytes.length}`);
  hash.update("\0");
  hash.update(bytes);
  return hash.digest("hex");
}

// ── Record encode/decode (malformed pins fail closed) ────────────────────────

/**
 * Compact durable descriptor for ONE arm generation. It is sufficient —
 * together with the repository itself — to reload and verify the full
 * checkpoint record in a fresh process, but it never contains patch or
 * untracked content: identity (window id, per-arm nonce), repository
 * association (git dir real path), pin coordinates (base, ref, object
 * format), and the SHA-256 integrity digest of the published record bytes.
 */
export interface GitCheckpointDescriptor {
  format: typeof GIT_CHECKPOINT_DESCRIPTOR_FORMAT;
  /** Safe checkpoint window id. */
  windowId: string;
  /** Unique per-arm generation nonce (the owner token). */
  armId: string;
  /** Real path of the repository's git directory at arm time. */
  gitDir: string;
  /** Full object id of the pinned base commit. */
  base: string;
  /** Owned pin ref holding the base commit against GC until release. */
  ref: string;
  objectFormat: GitCheckpointObjectFormat;
  /** SHA-256 hex digest of the exact published record bytes (UTF-8). */
  digest: string;
}

export function encodeGitCheckpointDescriptor(descriptor: GitCheckpointDescriptor): string {
  return JSON.stringify(descriptor);
}

const SHA256_HEX_RE = /^[0-9a-f]{64}$/;

/** Strictly validate a decoded descriptor value; throws malformed_descriptor. */
function assertValidDescriptor(value: unknown): GitCheckpointDescriptor {
  const malformed = (why: string): never => {
    throw new GitCheckpointError(`malformed checkpoint descriptor: ${why}`, "malformed_descriptor");
  };
  if (typeof value !== "object" || value === null || Array.isArray(value)) return malformed("not an object");
  const raw = value as Record<string, unknown>;
  if (raw.format !== GIT_CHECKPOINT_DESCRIPTOR_FORMAT) {
    return malformed(`unknown format tag ${JSON.stringify(raw.format)}`);
  }
  if (typeof raw.windowId !== "string" || !isSafeWindowId(raw.windowId)) {
    return malformed(`unsafe window id ${JSON.stringify(raw.windowId)}`);
  }
  if (typeof raw.armId !== "string" || !isSafeArmId(raw.armId)) {
    return malformed(`unsafe arm id ${JSON.stringify(raw.armId)}`);
  }
  if (
    typeof raw.gitDir !== "string"
    || raw.gitDir.length === 0
    || !isAbsolute(raw.gitDir)
    || raw.gitDir.includes("\0")
  ) {
    return malformed(`gitDir is not an absolute path: ${JSON.stringify(raw.gitDir)}`);
  }
  const objectFormat = raw.objectFormat;
  if (!isObjectFormat(objectFormat)) return malformed(`unknown object format ${JSON.stringify(objectFormat)}`);
  if (typeof raw.base !== "string" || !oidMatchesFormat(raw.base, objectFormat)) {
    return malformed("base is not a full lowercase hex object id for the declared format");
  }
  if (typeof raw.ref !== "string" || raw.ref !== checkpointRefForWindow(raw.windowId)) {
    return malformed(`ref ${JSON.stringify(raw.ref)} does not match window id ${raw.windowId}`);
  }
  if (typeof raw.digest !== "string" || !SHA256_HEX_RE.test(raw.digest)) {
    return malformed("digest is not a sha256 hex digest");
  }
  return {
    format: GIT_CHECKPOINT_DESCRIPTOR_FORMAT,
    windowId: raw.windowId,
    armId: raw.armId,
    gitDir: raw.gitDir,
    base: raw.base,
    ref: raw.ref,
    objectFormat,
    digest: raw.digest,
  };
}

/**
 * Strictly decode and validate a persisted checkpoint descriptor. Any
 * structural or encoding violation rejects with reason "malformed_descriptor"
 * — a corrupted sidecar is never partially trusted.
 */
export function decodeGitCheckpointDescriptor(json: string): GitCheckpointDescriptor {
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    throw new GitCheckpointError("malformed checkpoint descriptor: not valid JSON", "malformed_descriptor");
  }
  return assertValidDescriptor(value);
}

export function encodeGitCheckpointRecord(record: GitCheckpointRecord): string {
  return JSON.stringify(record);
}

/**
 * Strictly decode and validate a durable checkpoint record. Any structural,
 * encoding, or consistency violation rejects with reason "malformed_record"
 * — a corrupted pin is never partially trusted.
 */
export function decodeGitCheckpointRecord(json: string): GitCheckpointRecord {
  const malformed = (why: string): never => {
    throw new GitCheckpointError(`malformed checkpoint record: ${why}`, "malformed_record");
  };
  // Unpaired UTF-16 surrogates have no UTF-8 encoding; fs would silently
  // substitute EF BF BD bytes, so such strings are not representable.
  const utf8RoundTrips = (value: string): boolean => Buffer.from(value, "utf8").toString("utf8") === value;

  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    return malformed("not valid JSON");
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return malformed("not an object");
  const raw = value as Record<string, unknown>;

  if (raw.format !== GIT_CHECKPOINT_RECORD_FORMAT) return malformed(`unknown format tag ${JSON.stringify(raw.format)}`);
  if (typeof raw.armId !== "string" || !isSafeArmId(raw.armId)) {
    return malformed(`armId is not a valid arm generation nonce: ${JSON.stringify(raw.armId)}`);
  }
  if (typeof raw.base !== "string" || !(OID_RE_40.test(raw.base) || OID_RE_64.test(raw.base))) {
    return malformed("base is not a full lowercase hex object id");
  }
  const objectFormat = raw.objectFormat;
  if (!isObjectFormat(objectFormat)) return malformed(`unknown object format ${JSON.stringify(objectFormat)}`);
  if (!oidMatchesFormat(raw.base, objectFormat)) return malformed("base length does not match the declared object format");
  if (typeof raw.ref !== "string" || !raw.ref.startsWith(GIT_CHECKPOINT_REF_PREFIX)) {
    return malformed(`ref is outside the owned namespace ${GIT_CHECKPOINT_REF_PREFIX}`);
  }
  if (windowIdFromRef(raw.ref) === undefined) return malformed("ref is not a well-formed checkpoint pin ref");

  const stagedPatchB64 = decodeStrictBase64(raw.stagedPatchB64, "stagedPatchB64", malformed);
  const unstagedPatchB64 = decodeStrictBase64(raw.unstagedPatchB64, "unstagedPatchB64", malformed);

  if (!Array.isArray(raw.untracked)) return malformed("untracked is not an array");
  const untracked: GitCheckpointUntrackedEntry[] = [];
  const seen = new Set<string>();
  for (const item of raw.untracked) {
    if (typeof item !== "object" || item === null) return malformed("untracked entry is not an object");
    const entry = item as Record<string, unknown>;
    if (typeof entry.path !== "string" || !isSafeRelativePath(entry.path)) {
      return malformed(`unsafe untracked path ${JSON.stringify(entry.path)}`);
    }
    if (!utf8RoundTrips(entry.path)) {
      return malformed(`untracked path ${JSON.stringify(entry.path)} is not valid Unicode`);
    }
    if (seen.has(entry.path)) return malformed(`duplicate untracked path ${entry.path}`);
    seen.add(entry.path);
    const mode = entry.mode;
    if (typeof mode !== "number" || !Number.isInteger(mode) || mode < 0 || mode > 0o7777777) {
      return malformed(`invalid untracked mode for ${entry.path}`);
    }
    for (const field of ["dev", "ino", "size", "mtimeMs", "ctimeMs"] as const) {
      const v = entry[field];
      if (typeof v !== "number" || !Number.isFinite(v) || v < 0) return malformed(`invalid ${field} for ${entry.path}`);
    }
    const base: GitCheckpointUntrackedEntry = {
      path: entry.path,
      kind: "file",
      mode,
      dev: entry.dev as number,
      ino: entry.ino as number,
      size: entry.size as number,
      mtimeMs: entry.mtimeMs as number,
      ctimeMs: entry.ctimeMs as number,
    };
    if (entry.kind === "file") {
      const contentB64 = decodeStrictBase64(entry.contentB64, `contentB64 for ${entry.path}`, malformed);
      base.kind = "file";
      base.contentB64 = contentB64;
      if (Buffer.byteLength(contentB64, "base64") !== entry.size) {
        return malformed(`content size mismatch for ${entry.path}`);
      }
    } else if (entry.kind === "symlink") {
      if (typeof entry.target !== "string" || entry.target.length === 0) {
        return malformed(`missing symlink target for ${entry.path}`);
      }
      // U+FFFD marks a lossy UTF-8 decode of raw target bytes; such a target
      // cannot be recreated exactly, so the record is malformed.
      if (entry.target.includes("\uFFFD")) {
        return malformed(`symlink target for ${entry.path} is not valid UTF-8`);
      }
      if (!utf8RoundTrips(entry.target)) {
        return malformed(`symlink target for ${entry.path} is not valid Unicode`);
      }
      base.kind = "symlink";
      base.target = entry.target;
    } else {
      return malformed(`unknown untracked kind for ${entry.path}`);
    }
    untracked.push(base);
  }

  return {
    format: GIT_CHECKPOINT_RECORD_FORMAT,
    armId: raw.armId as string,
    base: raw.base,
    ref: raw.ref,
    objectFormat,
    stagedPatchB64,
    unstagedPatchB64,
    untracked,
  };
}

function decodeStrictBase64(
  value: unknown,
  label: string,
  malformed: (why: string) => never,
): string {
  if (typeof value !== "string" || !BASE64_RE.test(value)) return malformed(`${label} is not valid base64`);
  return value;
}

// ── Repository resolution and safety audit ───────────────────────────────────

interface ResolvedRepo {
  root: string;
  gitDir: string;
  liveIndexPath: string;
}

async function resolveRepo(
  gitPath: string,
  root: string,
  spec: GitRunSpec,
): Promise<GitCheckpointResult<ResolvedRepo>> {
  const rootAbs = resolve(root);
  let out: GitRunOutput;
  try {
    out = await runGit(gitPath, rootAbs, ["rev-parse", "--show-toplevel"], spec);
  } catch (error) {
    return resultFromError(error);
  }
  if (out.code !== 0 || out.stdout.toString("utf8").trim().length === 0) {
    return {
      status: "unsupported",
      reason: "not_a_git_repository",
      detail: truncateDetail(out.stderr || `git rev-parse exit ${out.code}`),
    };
  }
  // Canonicalize both sides: tmp directories may sit behind symlinks
  // (e.g. /var → /private/var on macOS) while git reports resolved paths.
  const [rootReal, toplevelReal] = await Promise.all([
    realpath(rootAbs).catch(() => rootAbs),
    realpath(resolve(out.stdout.toString("utf8").trim())).catch((error: unknown) => {
      throw new GitCheckpointError(`cannot resolve repository top level: ${messageOf(error)}`, "git_failed");
    }),
  ]);
  if (toplevelReal !== rootReal) {
    return {
      status: "unsupported",
      reason: "not_repository_root",
      detail: `capture root ${rootAbs} is not the repository top level ${toplevelReal}`,
    };
  }
  let gitDirOut: GitRunOutput;
  let indexPathOut: GitRunOutput;
  try {
    [gitDirOut, indexPathOut] = await Promise.all([
      runGit(gitPath, rootAbs, ["rev-parse", "--absolute-git-dir"], spec),
      runGit(gitPath, rootAbs, ["rev-parse", "--git-path", "index"], spec),
    ]);
  } catch (error) {
    return resultFromError(error);
  }
  if (gitDirOut.code !== 0 || indexPathOut.code !== 0) {
    return { status: "failed", reason: "git_failed", detail: truncateDetail(gitDirOut.stderr || indexPathOut.stderr) };
  }
  const gitDir = resolve(gitDirOut.stdout.toString("utf8").trim());
  const liveIndexPath = resolve(rootAbs, indexPathOut.stdout.toString("utf8").trim());
  return { status: "ok", value: { root: rootAbs, gitDir, liveIndexPath } };
}

/**
 * Fail-closed audit of everything that could make Git diff/index output
 * untrustworthy or execute external programs. Returns the first violation.
 */
async function auditRepository(
  gitPath: string,
  root: string,
  spec: GitRunSpec,
): Promise<GitCheckpointResult<void>> {
  let configOut: GitRunOutput;
  try {
    configOut = await runGit(gitPath, root, ["config", "--list", "--show-origin", "-z"], {
      ...spec,
      maxBytes: 4 * 1024 * 1024,
    });
  } catch (error) {
    return resultFromError(error);
  }
  if (configOut.code !== 0) {
    return { status: "failed", reason: "git_failed", detail: truncateDetail(configOut.stderr || `git config exit ${configOut.code}`) };
  }
  // With --show-origin -z each entry is two NUL-separated records: an origin
  // record, then a "key\nvalue" record. Scan for keys that could execute
  // programs or normalize bytes during diff/clean.
  const records = configOut.stdout.toString("utf8").split("\0");
  for (let i = 1; i < records.length; i += 2) {
    const record = records[i] ?? "";
    if (!record) continue;
    const nl = record.indexOf("\n");
    const key = (nl >= 0 ? record.slice(0, nl) : record).toLowerCase();
    const value = nl >= 0 ? record.slice(nl + 1) : "";
    // Driver names may contain dots: git splits the driver config key at the LAST dot.
    if (key === "diff.external" || /^diff\..+\.command$/.test(key) || /^diff\..+\.textconv$/.test(key)) {
      return {
        status: "unsupported",
        reason: "diff_program_configured",
        detail: `repository config defines ${key}; external diff helpers could run during capture`,
      };
    }
    if (key.startsWith("filter.")) {
      return {
        status: "unsupported",
        reason: "filter_or_eol_configured",
        detail: `repository config defines ${key}; clean/smudge filters are not trustworthy for exact bytes`,
      };
    }
    if (key === "core.autocrlf" && value !== "" && value !== "false") {
      return {
        status: "unsupported",
        reason: "filter_or_eol_configured",
        detail: `core.autocrlf=${value}; EOL normalization would corrupt exact bytes`,
      };
    }
    if (key === "core.eol") {
      return {
        status: "unsupported",
        reason: "filter_or_eol_configured",
        detail: `core.eol=${value}; EOL normalization would corrupt exact bytes`,
      };
    }
    if ((key === "core.sparsecheckout" || key === "core.sparsecheckoutcone") && value === "true") {
      return {
        status: "unsupported",
        reason: "skip_worktree_entry",
        detail: `sparse checkout is enabled (${key}); the worktree is a partial view`,
      };
    }
  }

  // Index entry flags, modes, stages, and effective EOL attributes in one pass.
  let listOut: GitRunOutput;
  try {
    listOut = await runGit(gitPath, root, ["ls-files", "-s", "-v", "--eol", "-z"], {
      ...spec,
      maxBytes: 32 * 1024 * 1024,
    });
  } catch (error) {
    return resultFromError(error);
  }
  if (listOut.code !== 0 || listOut.stderr.trim().length > 0) {
    return { status: "failed", reason: "git_warning", detail: truncateDetail(listOut.stderr || `git ls-files exit ${listOut.code}`) };
  }
  const trackedPaths: string[] = [];
  for (const record of listOut.stdout.toString("utf8").split("\0")) {
    if (!record) continue;
    const firstTab = record.indexOf("\t");
    if (firstTab < 0) return { status: "failed", reason: "git_failed", detail: "unparseable ls-files record" };
    const meta = record.slice(0, firstTab);
    const eolInfoEnd = record.indexOf("\t", firstTab + 1);
    const eolInfo = eolInfoEnd > 0 ? record.slice(firstTab + 1, eolInfoEnd) : "";
    const path = eolInfoEnd > 0 ? record.slice(eolInfoEnd + 1) : record.slice(firstTab + 1);
    if (!isSafeRelativePath(path)) {
      return { status: "failed", reason: "git_warning", detail: `unsafe tracked path from ls-files: ${JSON.stringify(path)}` };
    }
    const fields = meta.split(" ");
    const flag = fields[0] ?? "";
    const mode = fields[1] ?? "";
    const stage = fields[3] ?? "";
    if (flag === "M" || stage !== "0") {
      return { status: "unsupported", reason: "unmerged_index_entry", detail: `path ${path} has unmerged index stages` };
    }
    if (flag === "S") {
      return { status: "unsupported", reason: "skip_worktree_entry", detail: `path ${path} has the skip-worktree bit set` };
    }
    if (flag === "h") {
      return { status: "unsupported", reason: "assume_unchanged_entry", detail: `path ${path} is marked assume-unchanged; its worktree state is invisible to Git` };
    }
    if (flag !== "H") {
      return { status: "failed", reason: "git_failed", detail: `unknown index flag '${flag}' for path ${path}` };
    }
    if (mode === "160000") {
      return { status: "unsupported", reason: "submodule_tracked", detail: `path ${path} is a tracked submodule (gitlink); subproject state cannot be captured in patches` };
    }
    const attrMark = eolInfo.lastIndexOf("attr/");
    if (attrMark >= 0) {
      // Unset attributes are emitted as "attr/" followed by padding spaces.
      const attr = eolInfo.slice(attrMark + "attr/".length).trim();
      if (attr !== "" && attr !== "-" && attr !== "binary") {
        return { status: "unsupported", reason: "text_attribute_in_use", detail: `path ${path} has EOL/text attribute '${attr}'; normalization would corrupt exact bytes` };
      }
    }
    trackedPaths.push(path);
  }

  // `--eol` only reports the text/eol/crlf attributes. Two further
  // attribute-driven conversions change the raw worktree bytes without
  // appearing there: `ident` ($Id$ expansion on checkout) and
  // `working-tree-encoding` (worktree content re-encoded to UTF-8 in the
  // index). Ask Git for the effective attributes of every tracked path in
  // one batch and fail closed when either is set.
  if (trackedPaths.length > 0) {
    const attrInput = Buffer.from(`${trackedPaths.join("\0")}\0`, "utf8");
    let attrOut: GitRunOutput;
    try {
      attrOut = await runGitWithInput(
        gitPath,
        root,
        ["check-attr", "-z", "--stdin", "ident", "working-tree-encoding"],
        attrInput,
        // Two NUL-terminated triples per tracked path (path + attribute +
        // value), so this output scales with the tracked-path count and needs
        // the same order of cap as the ls-files enumeration above (32 MiB)
        // rather than the 1 MiB base spec cap, which would fail closed with
        // git_failed on repos of the ~20k-path size this module targets.
        { ...spec, maxBytes: 32 * 1024 * 1024 },
        {},
      );
    } catch (error) {
      return resultFromError(error);
    }
    if (attrOut.code !== 0 || attrOut.stderr.trim().length > 0) {
      return { status: "failed", reason: "git_warning", detail: truncateDetail(attrOut.stderr || `git check-attr exit ${attrOut.code}`) };
    }
    // `-z --stdin` output is a flat run of NUL-terminated
    // <path> <attribute> <info> triples.
    const fields = attrOut.stdout.toString("utf8").split("\0");
    for (let i = 0; i + 2 < fields.length; i += 3) {
      const attribute = fields[i + 1] ?? "";
      const value = fields[i + 2] ?? "";
      if (value !== "unspecified" && value !== "unset") {
        return {
          status: "unsupported",
          reason: "filter_or_eol_configured",
          detail: `path ${fields[i]} has the ${attribute} attribute (${value}); raw worktree bytes would not be reconstructible`,
        };
      }
    }
  }
  return { status: "ok", value: undefined };
}

// ── Arm ──────────────────────────────────────────────────────────────────────

export interface GitCheckpointArmOutcome {
  record: GitCheckpointRecord;
  /**
   * Encoded durable record — already published atomically in this arm's
   * owned scratch directory; kept for callers that persist it themselves.
   * restore/compare verify the pin's generation proof against this record's
   * armId before acting on it, so a persisted record can never be applied
   * over a newer same-base arm; the descriptor remains the compact artifact
   * for fresh-process reloads.
   */
  encoded: string;
  /**
   * Compact descriptor of this arm generation — the only thing a sidecar
   * must store. `loadGitCheckpoint(root, descriptor)` reloads and verifies
   * the full record from it in a fresh process.
   */
  descriptor: GitCheckpointDescriptor;
  stats: GitCheckpointArmStats;
}

/**
 * Arm a durable Git-backed baseline for `root`. See module docs for the
 * record layout and fail-closed contract. The pin ref is created with a
 * compare-and-set expecting it to be missing, so an existing same-id
 * checkpoint is never overwritten: a duplicate arm fails with
 * `pin_ref_exists` before any scratch or capture work begins. Before
 * publishing, the two captured patches are verified read-only to describe one
 * consistent (index, worktree) pair (see module docs); an interleaved index
 * or tracked-worktree change fails with `capture_inconsistent`. On failure
 * only this arm's own pin — conditionally, and only while THIS generation
 * still owns it per the pin reflog — and its own scratch subdirectory are
 * removed, so a failed arm never destroys another same-id checkpoint's state.
 */
export async function armGitCheckpoint(
  root: string,
  windowId: string,
  options: GitCheckpointOptions = {},
): Promise<GitCheckpointResult<GitCheckpointArmOutcome>> {
  try {
    if (!isSafeWindowId(windowId)) {
      throw new GitCheckpointError(`unsafe checkpoint window id ${JSON.stringify(windowId)}`, "unsafe_window_id");
    }
    const gitPath = options.gitPath ?? "git";
    const spec: GitRunSpec = {
      timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      maxBytes: 1024 * 1024,
      signal: options.signal,
    };

    const resolved = await resolveRepo(gitPath, root, spec);
    if (resolved.status !== "ok") return resolved;
    const repo = resolved.value;
    throwIfAborted(spec.signal);

    // Canonical repository identity for the descriptor (real path: tmp dirs
    // may sit behind symlinks). Fail closed before any pin/scratch work.
    let gitDirReal: string;
    try {
      gitDirReal = await realpath(repo.gitDir);
    } catch (error) {
      return resultFromError(error);
    }

    const audit = await auditRepository(gitPath, repo.root, spec);
    if (audit.status !== "ok") return audit;
    throwIfAborted(spec.signal);

    let headOut: GitRunOutput;
    try {
      headOut = await runGit(gitPath, repo.root, ["rev-parse", "--verify", "HEAD^{commit}"], spec);
    } catch (error) {
      return resultFromError(error);
    }
    if (headOut.code !== 0) {
      return { status: "unsupported", reason: "unborn_head", detail: truncateDetail(headOut.stderr || "HEAD does not name a commit") };
    }
    const base = headOut.stdout.toString("utf8").trim();

    // Derive the object format from the full base oid length (40 hex = sha1,
    // 64 hex = sha256). This matches every oid Git emits in this repository.
    const objectFormat: GitCheckpointObjectFormat | undefined = base.length === 40 ? "sha1" : base.length === 64 ? "sha256" : undefined;
    if (objectFormat === undefined) {
      return { status: "failed", reason: "git_failed", detail: `unexpected object id length for HEAD: ${base.length}` };
    }

    // Pin the base commit in an owned ref BEFORE capturing anything, so the
    // baseline is GC-safe from this point on. The create is a compare-and-set
    // expecting the ref to be MISSING (zero OID for the repository's object
    // format): an existing same-id checkpoint is never overwritten, and the
    // refusal happens before any scratch or capture work begins. The update
    // is reflog-annotated with this arm's generation nonce so release can
    // later prove which generation owns the pin (see release docs).
    const armId = randomBytes(8).toString("hex");
    const ref = checkpointRefForWindow(windowId);
    const zeroOid = objectFormat === "sha1" ? ZERO_OID_SHA1 : ZERO_OID_SHA256;
    const pinCreated = await createPinIfMissing(gitPath, repo.root, ref, base, zeroOid, armId, spec);
    if (pinCreated.status !== "ok") return pinCreated;

    // Owned scratch for this arm: a per-arm subdirectory inside the shared
    // window dir, so a failed arm removes exactly what it created and can
    // never destroy another same-id arm's files. Created before any capture
    // so partial work is always inside the owned dir. The nonce names the
    // directory and doubles as the arm's generation identity (descriptor
    // `armId`, pin reflog entry).
    const scratchDir = join(repo.gitDir, SCRATCH_SUBDIR, windowId, `arm-${armId}`);
    try {
      await mkdir(scratchDir, { recursive: true });
      // Make the newly created directory entries durable in their parents
      // (window dir, checkpoints dir, git dir) so a power loss cannot leave
      // the record path half-materialized; publishRecordDurable then fsyncs
      // the arm dir itself around the rename.
      await syncAncestorChain(scratchDir, repo.gitDir);
    } catch (error) {
      await cleanupAfterFailedArm(gitPath, repo, windowId, base, armId, scratchDir, spec);
      return resultFromError(error);
    }

    const maxPatchBytes = options.maxPatchBytes ?? DEFAULT_MAX_PATCH_BYTES;
    let stagedPatch: Buffer;
    let unstagedPatch: Buffer;
    try {
      // Consistency verification (read-only, fail-closed). The two patches
      // must describe ONE consistent (index, worktree) pair. Without this
      // check a `git add` or tracked edit landing between the two diffs can
      // yield two empty patches that replay as a clean base although an old
      // edit existed throughout. Exact checks:
      //   1. Index stability — the tree id of a snapshot copy of the live
      //      index (`git write-tree` against an alternate index file in this
      //      arm's scratch; the live index is never written) is identical
      //      before and after both patch captures. The tree id is a content
      //      hash of every index entry, so equality proves the entries were
      //      equal.
      //   2. Tracked-worktree stability — a full binary `git diff` (index →
      //      worktree) taken BEFORE the staged capture must be byte-identical
      //      to the captured unstaged patch; with check 1 holding, any
      //      tracked worktree change in the window changes that output.
      // Residual limit (documented): a change that lands and fully reverts
      // inside the capture window is undetectable by sampling, like any
      // snapshot. Changes landing after the unstaged capture are outside the
      // verified window; untracked entries carry their own pre/post stat
      // identity checks below.
      const indexTreeBefore = await snapshotIndexTree(gitPath, repo, join(scratchDir, "index-pre"), spec);
      const preUnstagedDiff = await captureDiff(gitPath, repo.root, [], spec, maxPatchBytes);
      stagedPatch = await captureDiff(gitPath, repo.root, ["--cached", base], spec, maxPatchBytes);
      throwIfAborted(spec.signal);
      // Deterministic fault seam between the two patch captures (tests only).
      try {
        await options.faultHooks?.betweenPatchCaptures?.();
      } catch (error) {
        if (!(error instanceof Error && error.name === "AbortError")) {
          throw new GitCheckpointError(`capture consistency hook failed: ${messageOf(error)}`, "git_failed");
        }
        throw error;
      }
      unstagedPatch = await captureDiff(gitPath, repo.root, [], spec, maxPatchBytes);
      const indexTreeAfter = await snapshotIndexTree(gitPath, repo, join(scratchDir, "index-post"), spec);
      if (indexTreeBefore !== indexTreeAfter) {
        throw new GitCheckpointError(
          `live index changed during checkpoint capture (tree ${indexTreeBefore} → ${indexTreeAfter}); the staged and unstaged patches would describe different indexes`,
          "capture_inconsistent",
        );
      }
      if (!preUnstagedDiff.equals(unstagedPatch)) {
        throw new GitCheckpointError(
          "tracked worktree changed during checkpoint capture; the captured patches would not describe one consistent state",
          "capture_inconsistent",
        );
      }
    } catch (error) {
      await cleanupAfterFailedArm(gitPath, repo, windowId, base, armId, scratchDir, spec);
      return resultFromError(error);
    }

    let untracked: GitCheckpointUntrackedEntry[];
    try {
      const paths = await listUntrackedPaths(gitPath, repo.root, spec);
      untracked = [];
      let totalBytes = 0;
      for (const path of paths) {
        throwIfAborted(spec.signal);
        const entry = await captureUntrackedEntry(repo.root, path, options.faultHooks?.beforeUntrackedRead);
        if (entry.kind === "file" && entry.contentB64 !== undefined) {
          totalBytes += Buffer.byteLength(entry.contentB64, "base64");
          if (totalBytes > (options.maxUntrackedBytes ?? DEFAULT_MAX_UNTRACKED_BYTES)) {
            throw new GitCheckpointError("captured untracked bytes exceeded the cap", "untracked_too_large");
          }
        }
        untracked.push(entry);
        throwIfAborted(spec.signal);
      }
    } catch (error) {
      await cleanupAfterFailedArm(gitPath, repo, windowId, base, armId, scratchDir, spec);
      return resultFromError(error);
    }

    const record: GitCheckpointRecord = {
      format: GIT_CHECKPOINT_RECORD_FORMAT,
      armId,
      base,
      ref,
      objectFormat,
      stagedPatchB64: stagedPatch.toString("base64"),
      unstagedPatchB64: unstagedPatch.toString("base64"),
      untracked,
    };
    const encoded = encodeGitCheckpointRecord(record);
    try {
      // Atomic durable publication: temp file in this arm's owned scratch
      // dir, file fsync, rename over record.json, directory fsync. A crash
      // at any point leaves either no record or the complete one — never a
      // torn file that load could trust.
      await publishRecordDurable(scratchDir, encoded);
    } catch (error) {
      await cleanupAfterFailedArm(gitPath, repo, windowId, base, armId, scratchDir, spec);
      return resultFromError(error);
    }

    // Compact descriptor: identity + integrity only, never record content.
    // This is the only thing a sidecar must persist; loadGitCheckpoint
    // reloads the full record from the owned scratch and verifies it.
    const descriptor: GitCheckpointDescriptor = {
      format: GIT_CHECKPOINT_DESCRIPTOR_FORMAT,
      windowId,
      armId,
      gitDir: gitDirReal,
      base,
      ref,
      objectFormat,
      digest: createHash("sha256").update(encoded, "utf8").digest("hex"),
    };

    const stats: GitCheckpointArmStats = {
      baseCommit: base,
      stagedPatchBytes: stagedPatch.length,
      unstagedPatchBytes: unstagedPatch.length,
      untrackedFileCount: untracked.length,
      untrackedRawBytes: untracked.reduce((sum, e) => sum + (e.kind === "file" ? e.size : 0), 0),
      recordBytes: Buffer.byteLength(encoded, "utf8"),
    };
    return { status: "ok", value: { record, encoded, descriptor, stats } };
  } catch (error) {
    return resultFromError(error);
  }
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
async function createPinIfMissing(
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

function sleepMs(ms: number): Promise<void> {
  return new Promise((resolvePromise) => {
    setTimeout(resolvePromise, ms);
  });
}

/**
 * Atomically and durably publish the encoded record as `record.json` inside
 * this arm's owned scratch directory: write a temp file in the SAME
 * directory (so the rename is atomic on one filesystem), fsync the file,
 * rename it over the final name, then fsync the directory so the directory
 * entry itself is durable. Any step failing throws after removing ONLY this
 * arm's temp file; the caller then runs cleanupAfterFailedArm (pin + this
 * arm's scratch). A crash at any point leaves either no record or the
 * complete one — never a torn file.
 */
async function publishRecordDurable(scratchDir: string, encoded: string): Promise<void> {
  const finalPath = join(scratchDir, "record.json");
  const tmpPath = join(scratchDir, `.record.json.tmp-${randomBytes(6).toString("hex")}`);
  let handle;
  try {
    handle = await open(tmpPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o644);
    await handle.writeFile(encoded, "utf8");
    await handle.sync(); // file contents durable before the rename
    await handle.close();
    handle = undefined;
    await rename(tmpPath, finalPath); // atomic replacement within one directory
    await syncDirectory(scratchDir); // directory entry durable
  } catch (error) {
    if (handle !== undefined) await handle.close().catch(() => undefined);
    // Remove only THIS arm's temp file; the caller cleans up pin + scratch.
    await rm(tmpPath, { force: true }).catch(() => undefined);
    throw new GitCheckpointError(`cannot durably publish checkpoint record: ${messageOf(error)}`, "git_failed");
  }
}

/** fsync a directory so a rename into it is durable (POSIX). */
async function syncDirectory(dir: string): Promise<void> {
  const dirHandle = await open(dir, constants.O_RDONLY | (constants.O_DIRECTORY ?? 0));
  try {
    await dirHandle.sync();
  } finally {
    await dirHandle.close().catch(() => undefined);
  }
}

/**
 * Make newly created directory entries in the owned scratch chain durable:
 * an entry becomes durable only when its PARENT directory is fsynced, so
 * every ancestor of `dir` up to and including `stopAt` (the git dir) is
 * synced. Without this, a power loss could leave the arm/window directories
 * themselves half-materialized even though the record file inside them was
 * fully durable.
 */
async function syncAncestorChain(dir: string, stopAt: string): Promise<void> {
  let current = dirname(dir);
  while (true) {
    await syncDirectory(current);
    if (current === stopAt) return;
    const parent = dirname(current);
    if (parent === current) return; // filesystem root reached
    current = parent;
  }
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
async function cleanupAfterFailedArm(
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
  // Best effort: drop the now-empty shared window dir. rmdir fails (and is
  // ignored) when another same-id arm or an in-flight restore still occupies it.
  try {
    await rmdir(dirname(armScratchDir));
  } catch { /* non-empty or already gone — leave it */ }
}

/**
 * Capture a COMPLETE binary patch with Git's own diff. `--no-ext-diff`
 * forbids external diff programs, `--no-textconv` forbids textconv drivers,
 * and the audited config guarantees no filters/EOL normalization are in play.
 */
async function captureDiff(
  gitPath: string,
  root: string,
  extraArgs: readonly string[],
  spec: GitRunSpec,
  maxBytes: number,
): Promise<Buffer> {
  const args = ["diff", "--no-ext-diff", "--no-textconv", "--binary", ...extraArgs];
  let out: GitRunOutput;
  try {
    out = await runGit(gitPath, root, args, { ...spec, maxBytes, overflowReason: "patch_too_large" });
  } catch (error) {
    throw error instanceof GitCheckpointError ? error : new GitCheckpointError(messageOf(error), "git_failed");
  }
  if (out.code !== 0 && out.code !== 1) {
    throw new GitCheckpointError(`git diff exited ${out.code}: ${out.stderr}`, "git_failed");
  }
  if (out.stderr.trim().length > 0) {
    // Any warning during capture is uncertainty — fail closed.
    throw new GitCheckpointError(`git diff produced a warning: ${out.stderr}`, "git_warning");
  }
  return out.stdout;
}

/**
 * Read the tree object id of the live index WITHOUT writing the live index
 * file. `git write-tree` may rewrite the index it reads — refreshing stale
 * stat-cache entries and updating the TREE_CACHE extension even with
 * GIT_OPTIONAL_LOCKS=0 (observed on git 2.50) — so it must never run
 * directly against the live index. Instead the live index is copied into
 * this arm's owned scratch and the COPY is written: Git rewrites its index
 * only via atomic rename, so the copy is either the complete pre-change or
 * the complete post-change file, never a torn read, and any refresh lands in
 * our own throwaway file. The emitted tree id depends only on entries'
 * (mode, path, blob) content — never on stat-cache data or index extensions
 * — so it is an exact content hash of the index entries at snapshot time.
 * A missing live index file means the empty index.
 */
async function snapshotIndexTree(
  gitPath: string,
  repo: ResolvedRepo,
  copyPath: string,
  spec: GitRunSpec,
): Promise<string> {
  // Distinguish "no live index file yet" (the empty index) from a failed
  // copy: key the fallback on the SOURCE, not on the error code alone, so a
  // missing or unwritable destination fails closed instead of running
  // write-tree against a nonexistent GIT_INDEX_FILE.
  let srcMissing = false;
  try {
    await lstat(repo.liveIndexPath);
  } catch (error) {
    if (fsCodeOf(error) !== "ENOENT") {
      throw new GitCheckpointError(`cannot stat the live index for consistency checking: ${messageOf(error)}`, "git_failed");
    }
    srcMissing = true;
  }
  if (!srcMissing) {
    try {
      await copyFile(repo.liveIndexPath, copyPath);
    } catch (error) {
      // The source vanished between the stat and the copy, or the
      // destination is unwritable: either way, fail closed.
      throw new GitCheckpointError(`cannot snapshot the live index for consistency checking: ${messageOf(error)}`, "git_failed");
    }
  }
  let out: GitRunOutput;
  try {
    out = await runGit(gitPath, repo.root, ["write-tree"], { ...spec, extraEnv: { GIT_INDEX_FILE: copyPath } });
  } catch (error) {
    throw error instanceof GitCheckpointError ? error : new GitCheckpointError(messageOf(error), "git_failed");
  }
  if (out.code !== 0 || out.stderr.trim().length > 0) {
    // Any warning during capture is uncertainty — fail closed.
    throw new GitCheckpointError(`git write-tree failed or warned: ${out.stderr || `exit ${out.code}`}`, "git_warning");
  }
  const treeId = out.stdout.toString("utf8").trim();
  // An empty or malformed id would make both snapshots trivially equal and
  // silently disable the index-stability check — fail closed instead.
  if (!OID_RE_40.test(treeId) && !OID_RE_64.test(treeId)) {
    throw new GitCheckpointError(`git write-tree did not emit a valid object id: ${JSON.stringify(out.stdout.toString("utf8"))}`, "git_failed");
  }
  return treeId;
}

/** Read the live index tree through a uniquely named, disposable index copy. */
async function snapshotLiveIndexTree(
  gitPath: string,
  repo: ResolvedRepo,
  scratchDir: string,
  spec: GitRunSpec,
): Promise<string> {
  const copyPath = join(scratchDir, `index-live-${process.pid}-${randomBytes(6).toString("hex")}`);
  try {
    return await snapshotIndexTree(gitPath, repo, copyPath, spec);
  } finally {
    await rm(copyPath, { force: true });
    await rm(`${copyPath}.lock`, { force: true });
  }
}

/** Non-ignored untracked paths (files, symlinks, and special entries). */
async function listUntrackedPaths(gitPath: string, root: string, spec: GitRunSpec): Promise<string[]> {
  let out: GitRunOutput;
  try {
    out = await runGit(gitPath, root, ["ls-files", "-o", "--exclude-standard", "-z"], {
      ...spec,
      maxBytes: 16 * 1024 * 1024,
    });
  } catch (error) {
    throw error instanceof GitCheckpointError ? error : new GitCheckpointError(messageOf(error), "git_failed");
  }
  if (out.code !== 0 || out.stderr.trim().length > 0) {
    // stderr on ls-files -o means unreadable directories — a silent gap.
    throw new GitCheckpointError(`git ls-files -o failed or warned: ${out.stderr || `exit ${out.code}`}`, "git_warning");
  }
  const paths = out.stdout.toString("utf8").split("\0").filter((p) => p.length > 0);
  for (const path of paths) {
    if (!isSafeRelativePath(path)) {
      throw new GitCheckpointError(`unsafe untracked path from ls-files: ${JSON.stringify(path)}`, "git_warning");
    }
  }
  return paths;
}

/**
 * Capture one untracked path exactly: no-follow stat, pre/post identity
 * check around the read, raw bytes or symlink target. Special entries
 * (fifos, sockets, devices) are refused — they cannot be represented in a
 * checkpoint and silently skipping them would be a gap.
 */
async function captureUntrackedEntry(
  root: string,
  path: string,
  beforeRead?: (absolutePath: string) => void | Promise<void>,
  maxFileBytes?: number,
): Promise<GitCheckpointUntrackedEntry> {
  const absolute = join(root, ...path.split("/"));
  let pre;
  try {
    pre = await lstat(absolute);
  } catch (error) {
    throw untrackedCaptureError(path, error, "could not stat");
  }
  if (pre.isSymbolicLink()) {
    try {
      await beforeRead?.(absolute);
    } catch (error) {
      throw untrackedCaptureError(path, error, "capture hook failed for");
    }
    let target: string;
    try {
      target = await readlink(absolute);
    } catch (error) {
      throw untrackedCaptureError(path, error, "could not read symlink target for");
    }
    // readlink decodes target bytes as UTF-8 (lossy): an invalid sequence
    // becomes U+FFFD and cannot be written back byte-for-byte. Refuse it
    // instead of storing a mangled target that restore would reproduce
    // while still reporting ok.
    if (target.includes("\uFFFD")) {
      throw new GitCheckpointError(
        `untracked symlink ${path} has a target that is not valid UTF-8; its bytes cannot be preserved`,
        "unsupported_untracked_entry",
      );
    }
    // A symlink target cannot be rewritten in place, so a stable inode means
    // the target just read is the one the pre-stat described. A symlink
    // replaced between the lstat and the readlink (new inode/timestamps) is a
    // capture race and must fail closed like the regular-file branch.
    let post;
    try {
      post = await lstat(absolute);
    } catch (error) {
      throw untrackedCaptureError(path, error, "could not re-stat after reading the symlink target for");
    }
    if (!sameStatIdentity(statIdentityOf(post), statIdentityOf(pre))) {
      throw new GitCheckpointError(`untracked path ${path} changed while being captured`, "untracked_capture_race");
    }
    return { path, kind: "symlink", mode: pre.mode, dev: pre.dev, ino: pre.ino, size: pre.size, mtimeMs: pre.mtimeMs, ctimeMs: pre.ctimeMs, target };
  }
  if (!pre.isFile()) {
    throw new GitCheckpointError(`untracked path ${path} is a special file; only regular files and symlinks are checkpointable`, "unsupported_untracked_entry");
  }
  try {
    await beforeRead?.(absolute);
  } catch (error) {
    throw untrackedCaptureError(path, error, "capture hook failed for");
  }
  let bytes: Buffer;
  const handle = await open(absolute, constants.O_RDONLY | constants.O_NOFOLLOW).catch((error): never => {
    throw untrackedCaptureError(path, error, "could not open");
  });
  try {
    const stat = await handle.stat();
    if (!sameStatIdentity(statIdentityOf(stat), statIdentityOf(pre))) {
      throw new GitCheckpointError(`untracked path ${path} changed while being captured`, "untracked_capture_race");
    }
    // Fail before allocating: a single file over the cap can never fit in
    // the bounded capture budget.
    if (maxFileBytes !== undefined && stat.size > maxFileBytes) {
      throw new GitCheckpointError(
        `untracked path ${path} is ${stat.size} bytes, exceeding the ${maxFileBytes}-byte cap`,
        "untracked_too_large",
      );
    }
    bytes = Buffer.alloc(stat.size);
    let offset = 0;
    while (offset < stat.size) {
      const { bytesRead } = await handle.read(bytes, offset, stat.size - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    if (offset !== stat.size) {
      throw new GitCheckpointError(`untracked path ${path} changed while being captured`, "untracked_capture_race");
    }
  } finally {
    await handle.close().catch(() => undefined);
  }
  let post;
  try {
    post = await lstat(absolute);
  } catch (error) {
    throw untrackedCaptureError(path, error, "could not re-stat after read");
  }
  if (!sameStatIdentity(statIdentityOf(post), statIdentityOf(pre))) {
    throw new GitCheckpointError(`untracked path ${path} changed while being captured`, "untracked_capture_race");
  }
  return { path, kind: "file", mode: pre.mode, dev: pre.dev, ino: pre.ino, size: pre.size, mtimeMs: pre.mtimeMs, ctimeMs: pre.ctimeMs, contentB64: bytes.toString("base64") };
}

function untrackedCaptureError(path: string, error: unknown, verb: string): GitCheckpointError {
  const code = fsCodeOf(error);
  if (code === "ENOENT" || code === "ENOTDIR") {
    return new GitCheckpointError(`${verb} ${path}: path disappeared during capture`, "untracked_capture_race");
  }
  return new GitCheckpointError(`${verb} ${path}: ${messageOf(error)}`, "untracked_unreadable");
}

function fsCodeOf(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error ? (error as { code?: unknown }).code as string | undefined : undefined;
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
async function verifyPinGeneration(
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

// ── Armed tree reconstruction (temp-index based, live index untouched) ───────

interface ArmedTrees {
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
async function buildArmedTrees(
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
async function composeSelectedTree(
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

async function writeIndexTree(gitPath: string, root: string, indexPath: string, spec: GitRunSpec): Promise<string> {
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

function assertSafeTreePaths(entries: ReadonlyMap<string, { mode: string; blob: string }>): void {
  for (const path of entries.keys()) {
    if (!isSafeRelativePath(path) || Buffer.from(path, "utf8").toString("utf8") !== path) {
      throw new GitCheckpointError(`unsafe tree path ${JSON.stringify(path)} during selective advancement`, "git_warning");
    }
  }
}

/** Refuse file↔directory collisions across two states that must coexist. */
function assertNoTreePathConflicts(a: ReadonlySet<string>, b: ReadonlySet<string>, allowSamePath: boolean): void {
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
function assertNoUntrackedPathConflicts(paths: ReadonlySet<string>): void {
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

/**
 * runGit variant that feeds `input` to the child's stdin and closes it.
 * Used for `git apply`, which reads patches from standard input.
 */
async function runGitWithInput(
  gitPath: string,
  cwd: string,
  args: readonly string[],
  input: Buffer,
  spec: GitRunSpec,
  extraEnv: NodeJS.ProcessEnv,
): Promise<GitRunOutput> {
  const hasAlternateIndex = (typeof spec.extraEnv?.GIT_INDEX_FILE === "string" && spec.extraEnv.GIT_INDEX_FILE.length > 0)
    || (typeof extraEnv.GIT_INDEX_FILE === "string" && extraEnv.GIT_INDEX_FILE.length > 0);
  const argv = ["--no-pager", "--no-replace-objects", ...configArgv(hasAlternateIndex), ...args];
  return new Promise<GitRunOutput>((resolvePromise, reject) => {
    let child: ChildProcess;
    try {
      child = spawn(gitPath, argv, { cwd, env: { ...hardenedEnv(), ...spec.extraEnv, ...extraEnv }, stdio: ["pipe", "pipe", "pipe"] });
    } catch (error) {
      reject(new GitCheckpointError(`failed to start git: ${messageOf(error)}`, "git_failed"));
      return;
    }
    let stdout = Buffer.alloc(0);
    let stderr = Buffer.alloc(0);
    let settled = false;
    const finish = (error: GitCheckpointError | null, output?: GitRunOutput): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      spec.signal?.removeEventListener("abort", onAbort);
      if (error) reject(error);
      else resolvePromise(output!);
    };
    const timer = setTimeout(() => {
      try { child.kill("SIGKILL"); } catch { /* already dead */ }
      finish(new GitCheckpointError(`git ${args[0] ?? ""} timed out after ${spec.timeoutMs}ms`, "git_failed"));
    }, spec.timeoutMs);
    const onAbort = (): void => {
      try { child.kill("SIGKILL"); } catch { /* already dead */ }
      finish(new GitCheckpointError(`git ${args[0] ?? ""} was aborted`, "aborted"));
    };
    if (spec.signal?.aborted) {
      finish(new GitCheckpointError(`git ${args[0] ?? ""} was aborted`, "aborted"));
      return;
    }
    spec.signal?.addEventListener("abort", onAbort, { once: true });
    child.stdout?.on("data", (chunk: Buffer) => {
      if (settled) return;
      if (stdout.length + chunk.length > spec.maxBytes) {
        try { child.kill("SIGKILL"); } catch { /* already dead */ }
        finish(new GitCheckpointError(
          `git ${args[0] ?? ""} output exceeded the ${spec.maxBytes}-byte cap`,
          spec.overflowReason ?? "git_failed",
        ));
        return;
      }
      stdout = Buffer.concat([stdout, chunk]);
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      if (stderr.length < STDERR_CAP_BYTES) stderr = Buffer.concat([stderr, chunk]).subarray(0, STDERR_CAP_BYTES);
    });
    child.on("error", (error) => finish(new GitCheckpointError(`failed to run git: ${messageOf(error)}`, "git_failed")));
    child.on("close", (code) => {
      if (settled) return;
      if (code === null) { finish(new GitCheckpointError(`git ${args[0] ?? ""} was killed by a signal`, "git_failed")); return; }
      finish(null, { stdout, stderr: stderr.toString("utf8"), code });
    });
    child.stdin?.on("error", () => undefined);
    child.stdin?.end(input);
  });
}

// ── Restore ──────────────────────────────────────────────────────────────────

/**
 * Reconstruct the armed state exactly: worktree converges on the armed
 * worktree tree, and the live index is atomically replaced by the armed
 * index. Only paths that deviate from the armed state are materialized (lazy
 * changed-content materialization — clean tracked files are never read).
 * The current live index is backed up into owned scratch before the swap.
 * Baseline untracked entries are recreated/rewritten only when their stat
 * identity has drifted; new non-ignored untracked paths are reported in
 * `leftBehind` and never deleted.
 * The pin must also be owned by this record's generation (its latest reflog
 * entry names the record's armId) — a stale same-base record, including one
 * persisted by the caller, cannot be restored over a newer arm's state
 * (`pin_generation_mismatch`).
 */
export async function restoreGitCheckpoint(
  root: string,
  encodedRecord: string,
  options: GitCheckpointOptions = {},
): Promise<GitCheckpointResult<GitCheckpointRestoreReport>> {
  let record: GitCheckpointRecord;
  try {
    record = decodeGitCheckpointRecord(encodedRecord);
  } catch (error) {
    return resultFromError(error);
  }
  const gitPath = options.gitPath ?? "git";
  const spec: GitRunSpec = { timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS, maxBytes: 1024 * 1024, signal: options.signal };

  try {
    throwIfAborted(spec.signal);
    const resolved = await resolveRepo(gitPath, root, spec);
    if (resolved.status !== "ok") return resolved;
    const repo = resolved.value;

    const pinCheck = await verifyGitCheckpointPin(repo.root, record, options);
    if (pinCheck.status !== "ok") return pinCheck;
    throwIfAborted(spec.signal);

    // Generation binding: the pin's latest reflog entry must name this
    // record's arm, so a caller-persisted stale same-base record cannot be
    // restored over a newer arm's state (same proof as load gate 5b).
    const genCheck = await verifyPinGeneration(gitPath, repo.root, record.ref, record.armId, spec);
    if (genCheck !== undefined) return genCheck;

    // Re-audit: the repository may have gained filters/EOL config since arm.
    const audit = await auditRepository(gitPath, repo.root, spec);
    if (audit.status !== "ok") return audit;
    throwIfAborted(spec.signal);

    const windowId = windowIdFromRef(record.ref);
    if (windowId === undefined) {
      return { status: "failed", reason: "malformed_record", detail: "record ref does not encode a safe window id" };
    }
    const trees = await buildArmedTrees(gitPath, repo, record, windowId, spec);
    throwIfAborted(spec.signal);

    // Changed set C = paths where armed worktree tree ≠ live index ∪ live worktree.
    // Git write-tree may rewrite its input index even with optional locks off;
    // snapshot a disposable copy before taking the real index's byte backup.
    const liveIndexTree = await snapshotLiveIndexTree(gitPath, repo, trees.scratchDir, spec);

    const [deltaVsIndex, deltaVsWorktree] = await Promise.all([
      diffTreePaths(gitPath, repo.root, trees.armedWorktreeTree, liveIndexTree, spec),
      worktreeDeltaPaths(gitPath, repo.root, trees.armedWorktreeTree, spec),
    ]);
    const changed = new Set<string>([...deltaVsIndex, ...deltaVsWorktree]);

    // Materialize every deviating tracked path from the armed worktree tree.
    const materializedPaths: string[] = [];
    const entries = await lsTreeMap(gitPath, repo.root, trees.armedWorktreeTree, spec);
    for (const path of [...changed].sort()) {
      throwIfAborted(spec.signal);
      if (!isSafeRelativePath(path)) {
        return { status: "failed", reason: "git_warning", detail: `unsafe path in changed set: ${JSON.stringify(path)}` };
      }
      const armed = entries.get(path);
      const absolute = join(repo.root, ...path.split("/"));
      await materializeTrackedPath(gitPath, repo.root, record.objectFormat, path, armed, spec, absolute);
      materializedPaths.push(path);
    }
    // Restore baseline untracked entries (exact bytes / symlink targets).
    const untrackedRestored: string[] = [];
    let untrackedVerified = 0;
    for (const entry of record.untracked) {
      throwIfAborted(spec.signal);
      const state = await restoreUntrackedEntry(repo.root, entry);
      if (state === "restored") untrackedRestored.push(entry.path);
      else untrackedVerified += 1;
    }

    // Snapshot the untracked set BEFORE the index swap: a path that is
    // untracked now but becomes tracked by the armed index would vanish from
    // the post-swap listing and be silently absorbed, so both listings count.
    let preSwapUntracked: string[];
    try {
      preSwapUntracked = await listUntrackedPaths(gitPath, repo.root, spec);
    } catch (error) {
      return resultFromError(error);
    }

    // Atomic live-index swap: back up the current index into owned scratch,
    // then rename the armed temp index over it. Same filesystem (both under
    // the git directory) makes the rename atomic.
    let indexStat;
    try {
      indexStat = await lstat(repo.liveIndexPath);
    } catch (error) {
      if (fsCodeOf(error) === "ENOENT") {
        // No live index yet: nothing to back up, just place the armed one.
      } else {
        return { status: "failed", reason: "git_failed", detail: truncateDetail(`cannot stat live index: ${messageOf(error)}`) };
      }
    }
    if (indexStat !== undefined) {
      try {
        await copyFile(repo.liveIndexPath, join(trees.scratchDir, "index-backup"));
      } catch (error) {
        return { status: "failed", reason: "git_failed", detail: truncateDetail(`cannot back up live index: ${messageOf(error)}`) };
      }
    }
    try {
      await rename(trees.tempIndexPath, repo.liveIndexPath);
    } catch (error) {
      return { status: "failed", reason: "git_failed", detail: truncateDetail(`cannot place armed index: ${messageOf(error)}`) };
    }

    // Report new non-ignored untracked paths without deleting anything.
    // Union of pre-swap and post-swap listings so leftovers that the swap
    // re-tracks are still surfaced to the caller.
    let leftBehind: string[];
    try {
      const postSwapUntracked = await listUntrackedPaths(gitPath, repo.root, spec);
      const baseline = new Set(record.untracked.map((e) => e.path));
      leftBehind = [...new Set([...preSwapUntracked, ...postSwapUntracked])].filter((p) => !baseline.has(p)).sort();
    } catch (error) {
      return resultFromError(error);
    }

    return {
      status: "ok",
      value: {
        armedIndexTree: trees.armedIndexTree,
        armedWorktreeTree: trees.armedWorktreeTree,
        materializedPaths,
        untrackedRestored,
        untrackedVerified,
        leftBehind,
        scratchDir: trees.scratchDir,
      },
    };
  } catch (error) {
    return resultFromError(error);
  }
}

/** Restore one baseline untracked entry; "verified" means stat identity matched. */
async function restoreUntrackedEntry(
  root: string,
  entry: GitCheckpointUntrackedEntry,
): Promise<"restored" | "verified"> {
  const absolute = join(root, ...entry.path.split("/"));
  let current;
  try {
    current = await lstat(absolute);
  } catch (error) {
    if (fsCodeOf(error) !== "ENOENT") {
      throw new GitCheckpointError(`cannot stat ${entry.path} during restore: ${messageOf(error)}`, "git_failed");
    }
  }
  const unchanged = current !== undefined && sameStatIdentity(statIdentityOf(current), statIdentityOf(entry));
  if (unchanged) return "verified";

  // Refuse symlinked parent components before touching anything.
  await assertContainedParents(root, absolute);
  // Ensure the parent directory exists (it may have been removed with a dir).
  await mkdir(join(root, ...entry.path.split("/").slice(0, -1)), { recursive: true });
  if (current !== undefined) {
    try {
      await rm(absolute, { force: true });
    } catch (error) {
      throw new GitCheckpointError(`cannot remove ${entry.path} before restore: ${messageOf(error)}`, "restore_path_conflict");
    }
  }
  if (entry.kind === "symlink") {
    try {
      await symlink(entry.target!, absolute);
    } catch (error) {
      throw new GitCheckpointError(`cannot recreate symlink ${entry.path}: ${messageOf(error)}`, "restore_path_conflict");
    }
  } else {
    const bytes = Buffer.from(entry.contentB64 ?? "", "base64");
    try {
      await writeFile(absolute, bytes);
      await chmod(absolute, entry.mode & 0o7777);
    } catch (error) {
      throw new GitCheckpointError(`cannot restore ${entry.path}: ${messageOf(error)}`, "restore_path_conflict");
    }
  }
  return "restored";
}

// ── Tree comparison helpers (lazy object-space diff) ─────────────────────────

/** Paths whose blob differs between two tree OIDs (empty = identical). */
async function diffTreePaths(
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
async function worktreeDeltaPaths(gitPath: string, root: string, tree: string, spec: GitRunSpec): Promise<string[]> {
  // --no-renames (and diff.renames=false above): a rename pair must report
  // BOTH sides; --name-only would otherwise print just the post-image name
  // and drop the deleted path from the changed set.
  const out = await runGit(gitPath, root, ["diff", "--no-ext-diff", "--no-textconv", "--no-renames", "--name-only", "-z", tree], { ...spec, maxBytes: 16 * 1024 * 1024 });
  if (out.code !== 0 && out.code !== 1) throw new GitCheckpointError(`worktree diff failed: ${out.stderr}`, "git_failed");
  if (out.stderr.trim().length > 0) throw new GitCheckpointError(`worktree diff warned: ${out.stderr}`, "git_warning");
  return out.stdout.toString("utf8").split("\0").filter((p) => p.length > 0);
}

/** Map of path → blob oid for every entry in a tree (recursive). */
async function lsTreeMap(
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

/**
 * Refuse to create or replace anything whose parent chain would leave the
 * repository through a symlinked component. Git's own checkout refuses
 * leading-symlink paths; direct fs writes would otherwise follow the link
 * and clobber files outside repo.root while still reporting success.
 */
async function assertContainedParents(root: string, absolute: string): Promise<void> {
  const rel = relative(root, absolute);
  // Only genuine parent traversal is refused: a top-level name that merely
  // begins with dots ("..env", "...") is legal and stays contained.
  if (rel.length === 0 || isAbsolute(rel) || rel === ".." || rel.startsWith("../")) {
    throw new GitCheckpointError(`path ${absolute} escapes the repository root`, "restore_path_conflict");
  }
  const parts = rel.split("/");
  let prefix = root;
  for (let i = 0; i < parts.length - 1; i++) {
    prefix = join(prefix, parts[i]!);
    let stat;
    try {
      stat = await lstat(prefix);
    } catch (error) {
      if (fsCodeOf(error) === "ENOENT") break; // created later by mkdir -p
      throw new GitCheckpointError(`cannot stat parent of ${absolute}: ${messageOf(error)}`, "git_failed");
    }
    if (stat.isSymbolicLink()) {
      throw new GitCheckpointError(
        `parent component '${parts.slice(0, i + 1).join("/")}' of ${absolute} is a symlink; refusing to write through it`,
        "restore_path_conflict",
      );
    }
  }
}

/**
 * Make one tracked path in the worktree exactly match its armed state:
 * delete it when absent from the armed tree, otherwise write the exact blob
 * bytes with the armed mode, or recreate a symlink with the armed target.
 * Existing content is only read to decide whether writing is needed at all —
 * the fast path skips both the object-store read and the write when the
 * current file already hashes to the armed blob AND carries the armed mode.
 */
async function materializeTrackedPath(
  gitPath: string,
  root: string,
  objectFormat: GitCheckpointObjectFormat,
  path: string,
  armed: { mode: string; blob: string } | undefined,
  spec: GitRunSpec,
  absolute: string,
): Promise<void> {
  if (armed === undefined) {
    // Path not in the armed worktree tree → it must be gone.
    let stat;
    try {
      stat = await lstat(absolute);
    } catch (error) {
      if (fsCodeOf(error) === "ENOENT") return;
      throw new GitCheckpointError(`cannot stat ${path} during restore: ${messageOf(error)}`, "git_failed");
    }
    if (stat.isDirectory()) {
      // A directory in the way of a deletion is a conflict we must not guess at.
      throw new GitCheckpointError(`cannot delete ${path}: it is a directory, not a file`, "restore_path_conflict");
    }
    await assertContainedParents(root, absolute);
    try {
      await rm(absolute, { force: true });
    } catch (error) {
      throw new GitCheckpointError(`cannot delete ${path} during restore: ${messageOf(error)}`, "restore_path_conflict");
    }
    return;
  }

  const armedBlob = armed.blob;
  const wantMode = parseInt(armed.mode, 8) & 0o7777;
  const isSymlink = armed.mode === "120000";

  let currentStat;
  try {
    currentStat = await lstat(absolute);
  } catch (error) {
    if (fsCodeOf(error) !== "ENOENT") {
      throw new GitCheckpointError(`cannot stat ${path} during restore: ${messageOf(error)}`, "git_failed");
    }
  }

  // Fast path: current entry already exactly matches the armed state.
  if (currentStat !== undefined) {
    if (isSymlink && currentStat.isSymbolicLink()) {
      const target = await readlink(absolute).catch(() => undefined);
      if (target !== undefined && blobObjectId(objectFormat, Buffer.from(target, "utf8")) === armedBlob) return;
    } else if (!isSymlink && currentStat.isFile()) {
      const bytes = await readWorktreeFile(absolute, path);
      if (blobObjectId(objectFormat, bytes) === armedBlob && (currentStat.mode & 0o7777) === wantMode) return;
    }
  }

  // Materialize from the object store — only after proving the write cannot
  // escape the repository through a symlinked parent component.
  await assertContainedParents(root, absolute);
  const blobBytes = await catFileBlob(gitPath, root, armedBlob, spec);
  try {
    // Missing parent directories are recreated for both symlinks and files.
    await mkdir(join(root, ...path.split("/").slice(0, -1)), { recursive: true });
    if (isSymlink) {
      if (currentStat !== undefined) await rm(absolute, { force: true });
      // Symlink targets are raw object bytes: write the blob directly so a
      // non-UTF-8 target is restored exactly instead of being re-encoded
      // through a lossy UTF-8 decode.
      await symlink(blobBytes, absolute);
      return;
    }
    if (currentStat !== undefined && !currentStat.isFile()) await rm(absolute, { force: true });
    await writeFile(absolute, blobBytes);
    await chmod(absolute, wantMode);
  } catch (error) {
    throw new GitCheckpointError(`cannot write ${path} during restore: ${messageOf(error)}`, "restore_path_conflict");
  }
}

/** Read a worktree file no-follow, failing closed on races. */
async function readWorktreeFile(absolute: string, path: string, maxBytes?: number): Promise<Buffer> {
  const handle = await open(absolute, constants.O_RDONLY | constants.O_NOFOLLOW).catch((error): never => {
    throw new GitCheckpointError(`cannot open ${path} for comparison: ${messageOf(error)}`, "git_failed");
  });
  let pre: Stats;
  let bytes: Buffer;
  try {
    pre = await handle.stat();
    // Fail before allocating (at the allocation site, so a concurrent grow
    // cannot slip past a caller-side size check): a file over the cap can
    // never be materialized in the bounded review budget.
    if (maxBytes !== undefined && pre.size > maxBytes) {
      throw new GitCheckpointError(
        `worktree file ${path} is ${pre.size} bytes, exceeding the ${maxBytes}-byte cap`,
        "git_failed",
      );
    }
    bytes = Buffer.alloc(pre.size);
    let offset = 0;
    while (offset < pre.size) {
      const { bytesRead } = await handle.read(bytes, offset, pre.size - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    // A short read means the file shrank under us: the buffer would be
    // zero-padded garbage, so fail closed instead of returning it.
    if (offset !== pre.size) {
      throw new GitCheckpointError(`worktree file ${path} changed while being read`, "git_failed");
    }
  } finally {
    await handle.close().catch(() => undefined);
  }
  // Post-read identity check: a concurrent rewrite that preserved the
  // open-time size (grow, truncate+rewrite) would otherwise yield stale
  // bytes with no detectable gap.
  let post: Stats;
  try {
    post = await lstat(absolute);
  } catch (error) {
    if (fsCodeOf(error) === "ENOENT") {
      throw new GitCheckpointError(`worktree file ${path} vanished while being read`, "git_failed");
    }
    throw new GitCheckpointError(`cannot re-stat ${path} after reading: ${messageOf(error)}`, "git_failed");
  }
  if (!sameStatIdentity(statIdentityOf(post), statIdentityOf(pre))) {
    throw new GitCheckpointError(`worktree file ${path} changed while being read`, "git_failed");
  }
  return bytes;
}

/** Read one blob from the object store, capped. */
async function catFileBlob(gitPath: string, root: string, oid: string, spec: GitRunSpec): Promise<Buffer> {
  const out = await runGit(gitPath, root, ["cat-file", "blob", oid], { ...spec, maxBytes: MAX_BLOB_BYTES, overflowReason: "git_failed" });
  if (out.code !== 0) throw new GitCheckpointError(`cat-file blob ${oid} failed: ${out.stderr}`, "git_failed");
  return out.stdout;
}

// ── Compare (lazy changed-content materialization) ───────────────────────────

/**
 * Diff the current repository state against the armed baseline without
 * mutating anything. Tracked changes are computed in object space; blob
 * contents are materialized only for paths that actually changed, and only
 * when `includeContents` is requested. Every tracked change also carries
 * armed/current kind and mode, so a mode-only change or a symlink retarget
 * stays reviewable even when the bytes are equal (symlink content is its
 * exact target, read no-follow). Untracked deltas are reported by path
 * (modified = stat identity drift from the captured entry) AND as typed
 * `untrackedChanges` with exact old/new bytes or symlink targets: new-side
 * content is captured no-follow with pre/post stat identity, only for paths
 * that actually changed, only with includeContents, and bounded by
 * maxUntrackedBytes; the old side reuses the bytes already captured at arm
 * time. Ignored untracked paths stay excluded (the ordinary baseline never
 * includes them); tracked-but-ignored paths remain tracked changes.
 * The pin must also be owned by this record's generation (its latest reflog
 * entry names the record's armId) — a stale same-base record cannot be
 * compared against as if it were the current arm (`pin_generation_mismatch`).
 */
export async function compareToGitCheckpoint(
  root: string,
  encodedRecord: string,
  options: GitCheckpointOptions = {},
  includeContents = false,
): Promise<GitCheckpointResult<GitCheckpointComparisonReport>> {
  let record: GitCheckpointRecord;
  try {
    record = decodeGitCheckpointRecord(encodedRecord);
  } catch (error) {
    return resultFromError(error);
  }
  const gitPath = options.gitPath ?? "git";
  const spec: GitRunSpec = { timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS, maxBytes: 1024 * 1024, signal: options.signal };

  try {
    throwIfAborted(spec.signal);
    const resolved = await resolveRepo(gitPath, root, spec);
    if (resolved.status !== "ok") return resolved;
    const repo = resolved.value;

    const pinCheck = await verifyGitCheckpointPin(repo.root, record, options);
    if (pinCheck.status !== "ok") return pinCheck;
    throwIfAborted(spec.signal);

    // Generation binding: same proof as load gate 5b — a caller-persisted
    // stale same-base record cannot be compared against as if it were the
    // current arm.
    const genCheck = await verifyPinGeneration(gitPath, repo.root, record.ref, record.armId, spec);
    if (genCheck !== undefined) return genCheck;

    const audit = await auditRepository(gitPath, repo.root, spec);
    if (audit.status !== "ok") return audit;
    throwIfAborted(spec.signal);

    const windowId = windowIdFromRef(record.ref);
    if (windowId === undefined) {
      return { status: "failed", reason: "malformed_record", detail: "record ref does not encode a safe window id" };
    }
    const trees = await buildArmedTrees(gitPath, repo, record, windowId, spec);
    throwIfAborted(spec.signal);

    // A comparison is read-only, including index metadata: write-tree only
    // the owned disposable copy, never the live index.
    const liveIndexTree = await snapshotLiveIndexTree(gitPath, repo, trees.scratchDir, spec);

    const [deltaVsIndex, deltaVsWorktree] = await Promise.all([
      diffTreePaths(gitPath, repo.root, trees.armedWorktreeTree, liveIndexTree, spec),
      worktreeDeltaPaths(gitPath, repo.root, trees.armedWorktreeTree, spec),
    ]);
    const changed = [...new Set([...deltaVsIndex, ...deltaVsWorktree])].sort();

    const entries = await lsTreeMap(gitPath, repo.root, trees.armedWorktreeTree, spec);
    const trackedChanges: GitCheckpointTrackedChange[] = [];
    for (const path of changed) {
      throwIfAborted(spec.signal);
      if (!isSafeRelativePath(path)) {
        return { status: "failed", reason: "git_warning", detail: `unsafe path in changed set: ${JSON.stringify(path)}` };
      }
      const armed = entries.get(path);
      const absolute = join(repo.root, ...path.split("/"));
      let currentStat;
      try {
        currentStat = await lstat(absolute);
      } catch (error) {
        if (fsCodeOf(error) !== "ENOENT") {
          return { status: "failed", reason: "git_failed", detail: truncateDetail(`cannot stat ${path}: ${messageOf(error)}`) };
        }
      }
      const existsNow = currentStat !== undefined && !currentStat.isDirectory();
      let status: GitCheckpointTrackedChange["status"];
      if (armed === undefined) status = "added";
      else if (!existsNow) status = "deleted";
      else status = "modified";
      const change: GitCheckpointTrackedChange = { path, status };
      // Armed-side type/mode from the armed tree. Always reported — a
      // mode-only change must stay reviewable even when the bytes are equal.
      if (armed !== undefined) {
        change.oldKind = armed.mode === "120000" ? "symlink" : "file";
        change.oldMode = parseInt(armed.mode, 8) & 0o777;
      }
      // Current-side type/mode. Special files are not representable in the
      // report — fail closed rather than mislabel them.
      if (existsNow) {
        if (currentStat!.isSymbolicLink()) {
          change.newKind = "symlink";
        } else if (currentStat!.isFile()) {
          change.newKind = "file";
          change.newMode = currentStat!.mode & 0o777;
        } else {
          return {
            status: "failed",
            reason: "git_failed",
            detail: truncateDetail(`path ${path} is a special file in the worktree; comparison cannot represent it`),
          };
        }
      }
      if (includeContents) {
        if (armed !== undefined) {
          change.oldBytes = await catFileBlob(gitPath, repo.root, armed.blob, spec);
        }
        if (existsNow) {
          if (change.newKind === "symlink") {
            // Symlink content IS its target: read it no-follow. A lossy
            // UTF-8 decode (U+FFFD) cannot be represented byte-for-byte.
            let target: string;
            try {
              target = await readlink(absolute);
            } catch (error) {
              return { status: "failed", reason: "git_failed", detail: truncateDetail(`cannot read symlink target for ${path}: ${messageOf(error)}`) };
            }
            if (target.includes("\uFFFD")) {
              return { status: "failed", reason: "git_failed", detail: truncateDetail(`symlink ${path} has a target that is not valid UTF-8; its bytes cannot be represented`) };
            }
            change.newBytes = Buffer.from(target, "utf8");
          } else {
            // Bound the new-side worktree read like the old-side blob read
            // (MAX_BLOB_BYTES: a single blob materialized during compare).
            change.newBytes = await readWorktreeFile(absolute, path, MAX_BLOB_BYTES);
          }
        }
      }
      trackedChanges.push(change);
    }

    // Untracked deltas against the baseline. Ignored untracked paths are
    // excluded by --exclude-standard (the ordinary baseline never includes
    // them); tracked-but-ignored paths stay tracked and surface through
    // trackedChanges above.
    const nowUntracked = await listUntrackedPaths(gitPath, repo.root, spec);
    const baseline = new Map(record.untracked.map((e) => [e.path, e]));
    const untrackedAdded: string[] = [];
    const untrackedRemoved: string[] = [];
    const untrackedModified: string[] = [];
    const untrackedChanges: GitCheckpointUntrackedChange[] = [];

    // Old (baseline) side of a changed entry. Exact bytes/target only with
    // includeContents — the content was already captured at arm time.
    const baselineState = (entry: GitCheckpointUntrackedEntry): GitCheckpointUntrackedState => {
      const state: GitCheckpointUntrackedState = { kind: entry.kind, mode: entry.mode };
      if (includeContents) {
        if (entry.kind === "file") state.content = Buffer.from(entry.contentB64 ?? "", "base64");
        else state.target = entry.target;
      }
      return state;
    };

    const maxUntrackedBytes = options.maxUntrackedBytes ?? DEFAULT_MAX_UNTRACKED_BYTES;
    let newUntrackedBytes = 0;
    // Current-side state for a changed path: exact no-follow capture with
    // pre/post stat identity when content is requested, otherwise kind/mode
    // from the classification stat. Special files are not representable.
    const currentStateOf = async (path: string, knownStat?: Stats): Promise<GitCheckpointUntrackedState> => {
      if (includeContents) {
        const captured = await captureUntrackedEntry(repo.root, path, options.faultHooks?.beforeUntrackedRead, maxUntrackedBytes);
        if (captured.kind === "file") {
          newUntrackedBytes += captured.size;
          if (newUntrackedBytes > maxUntrackedBytes) {
            throw new GitCheckpointError("compared untracked bytes exceeded the cap", "untracked_too_large");
          }
        }
        const state: GitCheckpointUntrackedState = { kind: captured.kind, mode: captured.mode };
        if (captured.kind === "file") state.content = Buffer.from(captured.contentB64 ?? "", "base64");
        else state.target = captured.target;
        return state;
      }
      const current = knownStat ?? await lstat(join(repo.root, ...path.split("/"))).catch((error): never => {
        throw untrackedCaptureError(path, error, "could not stat");
      });
      if (current.isSymbolicLink()) return { kind: "symlink", mode: current.mode };
      if (current.isFile()) return { kind: "file", mode: current.mode };
      throw new GitCheckpointError(
        `untracked path ${path} is a special file; only regular files and symlinks are checkpointable`,
        "unsupported_untracked_entry",
      );
    };

    for (const path of nowUntracked.sort()) {
      throwIfAborted(spec.signal);
      const expected = baseline.get(path);
      if (expected === undefined) {
        untrackedAdded.push(path);
        untrackedChanges.push({ path, change: "added", new: await currentStateOf(path) });
        continue;
      }
      const absolute = join(repo.root, ...path.split("/"));
      let current;
      try {
        current = await lstat(absolute);
      } catch (error) {
        // Vanished between listing and stat — treat as removed.
        untrackedRemoved.push(path);
        untrackedChanges.push({ path, change: "removed", old: baselineState(expected) });
        continue;
      }
      if (!sameStatIdentity(statIdentityOf(current), statIdentityOf(expected))) {
        untrackedModified.push(path);
        untrackedChanges.push({ path, change: "modified", old: baselineState(expected), new: await currentStateOf(path, current) });
      }
    }
    const nowUntrackedSet = new Set(nowUntracked);
    for (const entry of record.untracked) {
      if (!nowUntrackedSet.has(entry.path)) {
        untrackedRemoved.push(entry.path);
        untrackedChanges.push({ path: entry.path, change: "removed", old: baselineState(entry) });
      }
    }
    untrackedRemoved.sort();
    untrackedChanges.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

    return {
      status: "ok",
      value: { trackedChanges, untrackedAdded, untrackedRemoved, untrackedModified, untrackedChanges },
    };
  } catch (error) {
    return resultFromError(error);
  }
}

// ── Frozen checkpoint-to-checkpoint comparison ───────────────────────────────

interface CheckpointTreeEntry {
  mode: string;
  blob: string;
}

/** Read and strictly validate the reconstructed tracked worktree tree. */
async function checkpointTreeEntries(
  gitPath: string,
  root: string,
  tree: string,
  objectFormat: GitCheckpointObjectFormat,
  spec: GitRunSpec,
): Promise<Map<string, CheckpointTreeEntry>> {
  if (!oidMatchesFormat(tree, objectFormat)) {
    throw new GitCheckpointError(`reconstruction produced an invalid tree id ${JSON.stringify(tree)}`, "patch_apply_failed");
  }
  const out = await runGit(gitPath, root, ["ls-tree", "-r", "-z", tree], { ...spec, maxBytes: 64 * 1024 * 1024 });
  if (out.code !== 0 || out.stderr.trim().length > 0) {
    throw new GitCheckpointError(`cannot enumerate reconstructed tree: ${out.stderr || `exit ${out.code}`}`, "git_failed");
  }
  const entries = new Map<string, CheckpointTreeEntry>();
  for (const record of out.stdout.subarray(0).toString("binary").split("\0")) {
    if (record.length === 0) continue;
    const tab = record.indexOf("\t");
    if (tab < 0) throw new GitCheckpointError("unparseable reconstructed ls-tree record", "git_failed");
    const fields = record.slice(0, tab).split(" ");
    const mode = fields[0] ?? "";
    const type = fields[1] ?? "";
    const blob = fields[2] ?? "";
    let path: string;
    try {
      path = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.from(record.slice(tab + 1), "binary"));
    } catch {
      throw new GitCheckpointError("reconstructed tree contains a path that is not valid UTF-8", "malformed_record");
    }
    if (!isSafeRelativePath(path)) {
      throw new GitCheckpointError(`unsafe path in reconstructed tree: ${JSON.stringify(path)}`, "git_failed");
    }
    if (type !== "blob" || !["100644", "100755", "120000"].includes(mode)) {
      throw new GitCheckpointError(`unsupported reconstructed tree entry ${mode} ${type} at ${path}`, "malformed_record");
    }
    if (!oidMatchesFormat(blob, objectFormat)) {
      throw new GitCheckpointError(`invalid blob id for reconstructed path ${path}`, "git_failed");
    }
    if (entries.has(path)) throw new GitCheckpointError(`duplicate reconstructed tree path ${path}`, "git_failed");
    entries.set(path, { mode, blob });
  }
  return entries;
}

/** Verify object presence without reading or retaining any blob contents. */
async function verifyCheckpointTreeBlobs(
  gitPath: string,
  root: string,
  entries: ReadonlyMap<string, CheckpointTreeEntry>,
  spec: GitRunSpec,
): Promise<void> {
  const blobs = [...new Set([...entries.values()].map((entry) => entry.blob))].sort();
  if (blobs.length === 0) return;
  const input = Buffer.from(`${blobs.join("\n")}\n`, "ascii");
  const out = await runGitWithInput(
    gitPath,
    root,
    ["cat-file", "--batch-check"],
    input,
    { ...spec, maxBytes: 128 * 1024 * 1024 },
    {},
  );
  if (out.code !== 0 || out.stderr.trim().length > 0) {
    throw new GitCheckpointError(`cannot verify reconstructed blobs: ${out.stderr || `exit ${out.code}`}`, "git_failed");
  }
  const lines = out.stdout.toString("ascii").split("\n");
  if (lines.at(-1) === "") lines.pop();
  if (lines.length !== blobs.length) {
    throw new GitCheckpointError("blob verification returned an incomplete object list", "git_failed");
  }
  for (let i = 0; i < blobs.length; i += 1) {
    const [oid, type, size, extra] = (lines[i] ?? "").split(" ");
    if (oid !== blobs[i] || type !== "blob" || !/^\d+$/.test(size ?? "") || extra !== undefined) {
      throw new GitCheckpointError(`reconstructed blob ${blobs[i]} is missing or has an invalid object type`, "git_failed");
    }
  }
}

/** Validate disjoint tracked/untracked state and representable untracked modes. */
function checkpointUntrackedMap(
  record: GitCheckpointRecord,
  tracked: ReadonlyMap<string, CheckpointTreeEntry>,
): Map<string, GitCheckpointUntrackedEntry> {
  const untracked = new Map<string, GitCheckpointUntrackedEntry>();
  for (const entry of record.untracked) {
    if (!isSafeRelativePath(entry.path) || Buffer.from(entry.path, "utf8").toString("utf8") !== entry.path) {
      throw new GitCheckpointError(`unsafe untracked checkpoint path ${JSON.stringify(entry.path)}`, "malformed_record");
    }
    const kindBits = entry.mode & 0o170000;
    const expectedKindBits = entry.kind === "file" ? 0o100000 : 0o120000;
    if (kindBits !== expectedKindBits || (entry.mode & ~0o177777) !== 0) {
      throw new GitCheckpointError(`unsupported untracked mode ${entry.mode.toString(8)} at ${entry.path}`, "malformed_record");
    }
    if (entry.kind === "file") {
      if (typeof entry.contentB64 !== "string" || !isCanonicalBase64(entry.contentB64)) {
        throw new GitCheckpointError(`non-canonical or missing untracked bytes for ${entry.path}`, "malformed_record");
      }
      if (Buffer.byteLength(entry.contentB64, "base64") !== entry.size) {
        throw new GitCheckpointError(`untracked byte count is inconsistent for ${entry.path}`, "malformed_record");
      }
    } else if (typeof entry.target !== "string" || Buffer.byteLength(entry.target, "utf8") !== entry.size) {
      throw new GitCheckpointError(`untracked symlink target is inconsistent for ${entry.path}`, "malformed_record");
    }
    if (untracked.has(entry.path)) throw new GitCheckpointError(`duplicate untracked path ${entry.path}`, "malformed_record");
    untracked.set(entry.path, entry);
  }
  try {
    assertNoUntrackedPathConflicts(new Set(untracked.keys()));
    assertNoTreePathConflicts(new Set(tracked.keys()), new Set(untracked.keys()), false);
  } catch (error) {
    throw new GitCheckpointError(`checkpoint tracked/untracked states overlap: ${messageOf(error)}`, "malformed_record");
  }
  return untracked;
}

function isCanonicalBase64(value: string): boolean {
  if (!BASE64_RE.test(value)) return false;
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  if (value.endsWith("==")) {
    return (alphabet.indexOf(value[value.length - 3] ?? "") & 0x0f) === 0;
  }
  if (value.endsWith("=")) {
    return (alphabet.indexOf(value[value.length - 2] ?? "") & 0x03) === 0;
  }
  return true;
}

function sameCheckpointUntrackedState(a: GitCheckpointUntrackedEntry, b: GitCheckpointUntrackedEntry): boolean {
  if (a.kind !== b.kind || a.mode !== b.mode) return false;
  return a.kind === "file"
    ? a.contentB64 === b.contentB64
    : a.target === b.target;
}

function checkpointUntrackedState(
  entry: GitCheckpointUntrackedEntry,
  includeContents: boolean,
  accountBytes: (size: number) => void,
): GitCheckpointUntrackedState {
  const state: GitCheckpointUntrackedState = { kind: entry.kind, mode: entry.mode };
  if (includeContents) {
    if (entry.kind === "file") {
      accountBytes(entry.size);
      state.content = Buffer.from(entry.contentB64!, "base64");
    } else {
      state.target = entry.target;
    }
  }
  return state;
}

/**
 * Compare the net worktree states captured by two independently verified
 * checkpoints. This intentionally does not inspect the current HEAD, index,
 * worktree, or ignore results: both worktree trees are rebuilt from their
 * durable patches in disposable alternate indexes, and untracked states are
 * compared from the exact bytes/modes/types in the verified records. Staged
 * and unstaged deltas therefore remain complete in storage while review sees
 * only their net worktree result. Pins and published records are never
 * released or modified.
 */
export async function compareGitCheckpoints(
  root: string,
  beforeDescriptor: GitCheckpointDescriptor,
  afterDescriptor: GitCheckpointDescriptor,
  options: GitCheckpointOptions = {},
  includeContents = false,
): Promise<GitCheckpointResult<GitCheckpointComparisonReport>> {
  const gitPath = options.gitPath ?? "git";
  const spec: GitRunSpec = { timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS, maxBytes: 1024 * 1024, signal: options.signal };
  let scratchDir: string | undefined;
  let result: GitCheckpointResult<GitCheckpointComparisonReport> | undefined;
  let cleanupError: unknown;
  try {
    throwIfAborted(spec.signal);
    // loadGitCheckpoint verifies both descriptors, repository associations,
    // record digests/contents, pin targets, and pin-generation ownership.
    const [beforeLoaded, afterLoaded] = await Promise.all([
      loadGitCheckpoint(root, beforeDescriptor, options),
      loadGitCheckpoint(root, afterDescriptor, options),
    ]);
    if (beforeLoaded.status !== "ok") return beforeLoaded;
    if (afterLoaded.status !== "ok") return afterLoaded;
    const before = beforeLoaded.value.record;
    const after = afterLoaded.value.record;
    if (before.objectFormat !== after.objectFormat) {
      return { status: "failed", reason: "descriptor_record_mismatch", detail: "checkpoint object formats differ" };
    }

    const resolved = await resolveRepo(gitPath, root, spec);
    if (resolved.status !== "ok") return resolved;
    const repo = resolved.value;
    throwIfAborted(spec.signal);

    // A unique private directory lets the finally block remove every
    // disposable index (including a partial reconstruction failure) without
    // touching either checkpoint's durable arm directory.
    const checkpointDir = join(repo.gitDir, SCRATCH_SUBDIR);
    await mkdir(checkpointDir, { recursive: true });
    scratchDir = await mkdtemp(join(checkpointDir, "compare-"));
    const beforeTrees = await buildArmedTrees(gitPath, repo, before, beforeDescriptor.windowId, spec, scratchDir);
    const afterTrees = await buildArmedTrees(gitPath, repo, after, afterDescriptor.windowId, spec, scratchDir);
    throwIfAborted(spec.signal);

    const beforeTracked = await checkpointTreeEntries(gitPath, repo.root, beforeTrees.armedWorktreeTree, before.objectFormat, spec);
    const afterTracked = await checkpointTreeEntries(gitPath, repo.root, afterTrees.armedWorktreeTree, after.objectFormat, spec);
    await Promise.all([
      verifyCheckpointTreeBlobs(gitPath, repo.root, beforeTracked, spec),
      verifyCheckpointTreeBlobs(gitPath, repo.root, afterTracked, spec),
    ]);
    const beforeUntracked = checkpointUntrackedMap(before, beforeTracked);
    const afterUntracked = checkpointUntrackedMap(after, afterTracked);

    const trackedChanges: GitCheckpointTrackedChange[] = [];
    const trackedPaths = [...new Set([...beforeTracked.keys(), ...afterTracked.keys()])].sort();
    for (const path of trackedPaths) {
      throwIfAborted(spec.signal);
      const oldEntry = beforeTracked.get(path);
      const newEntry = afterTracked.get(path);
      if (oldEntry !== undefined && newEntry !== undefined && oldEntry.mode === newEntry.mode && oldEntry.blob === newEntry.blob) continue;
      const change: GitCheckpointTrackedChange = {
        path,
        status: oldEntry === undefined ? "added" : newEntry === undefined ? "deleted" : "modified",
      };
      if (oldEntry !== undefined) {
        change.oldKind = oldEntry.mode === "120000" ? "symlink" : "file";
        change.oldMode = parseInt(oldEntry.mode, 8) & 0o777;
      }
      if (newEntry !== undefined) {
        change.newKind = newEntry.mode === "120000" ? "symlink" : "file";
        if (newEntry.mode !== "120000") change.newMode = parseInt(newEntry.mode, 8) & 0o777;
      }
      if (includeContents) {
        if (oldEntry !== undefined) change.oldBytes = await catFileBlob(gitPath, repo.root, oldEntry.blob, spec);
        if (newEntry !== undefined) change.newBytes = await catFileBlob(gitPath, repo.root, newEntry.blob, spec);
      }
      trackedChanges.push(change);
    }

    const untrackedAdded: string[] = [];
    const untrackedRemoved: string[] = [];
    const untrackedModified: string[] = [];
    const untrackedChanges: GitCheckpointUntrackedChange[] = [];
    const maxUntrackedBytes = options.maxUntrackedBytes ?? DEFAULT_MAX_UNTRACKED_BYTES;
    let materializedUntrackedBytes = 0;
    const accountUntrackedBytes = (size: number): void => {
      materializedUntrackedBytes += size;
      if (materializedUntrackedBytes > maxUntrackedBytes) {
        throw new GitCheckpointError("compared checkpoint untracked bytes exceeded the cap", "untracked_too_large");
      }
    };
    const untrackedPaths = [...new Set([...beforeUntracked.keys(), ...afterUntracked.keys()])].sort();
    for (const path of untrackedPaths) {
      throwIfAborted(spec.signal);
      const oldEntry = beforeUntracked.get(path);
      const newEntry = afterUntracked.get(path);
      if (oldEntry !== undefined && newEntry !== undefined && sameCheckpointUntrackedState(oldEntry, newEntry)) continue;
      if (oldEntry === undefined) {
        untrackedAdded.push(path);
        untrackedChanges.push({
          path,
          change: "added",
          new: checkpointUntrackedState(newEntry!, includeContents, accountUntrackedBytes),
        });
      } else if (newEntry === undefined) {
        untrackedRemoved.push(path);
        untrackedChanges.push({
          path,
          change: "removed",
          old: checkpointUntrackedState(oldEntry, includeContents, accountUntrackedBytes),
        });
      } else {
        untrackedModified.push(path);
        untrackedChanges.push({
          path,
          change: "modified",
          old: checkpointUntrackedState(oldEntry, includeContents, accountUntrackedBytes),
          new: checkpointUntrackedState(newEntry, includeContents, accountUntrackedBytes),
        });
      }
    }
    result = {
      status: "ok",
      value: { trackedChanges, untrackedAdded, untrackedRemoved, untrackedModified, untrackedChanges },
    };
  } catch (error) {
    result = resultFromError(error);
  } finally {
    if (scratchDir !== undefined) {
      try {
        await rm(scratchDir, { recursive: true, force: true });
      } catch (error) {
        cleanupError = error;
      }
    }
  }
  if (cleanupError !== undefined) {
    return {
      status: "failed",
      reason: "git_failed",
      detail: truncateDetail(`cannot remove disposable comparison indexes: ${messageOf(cleanupError)}`),
    };
  }
  return result ?? { status: "failed", reason: "git_failed", detail: "comparison completed without a result" };
}

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
 * A release whose pin is already gone leaves the window scratch in place (it
 * may belong to a live same-id arm); a future successful owner release
 * reclaims it.
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
      // Conditional delete: the ref is removed only if it still matches the
      // verified owner, so a same-id re-arm landing between the check and the
      // delete cannot be destroyed.
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
    await removeWindowScratch(repo.gitDir, windowId);
    return { status: "ok", value: { released: hadRef } };
  } catch (error) {
    return resultFromError(error);
  }
}

/** Remove the owned scratch directory for a window (idempotent). */
async function removeWindowScratch(gitDir: string, windowId: string): Promise<void> {
  try {
    await rm(join(gitDir, SCRATCH_SUBDIR, windowId), { recursive: true, force: true });
  } catch { /* best effort — release still succeeds if the ref is gone */ }
}
