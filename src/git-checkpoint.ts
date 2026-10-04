/**
 * #193: Durable Git-backed workspace checkpoint core (Git-first strategy).
 *
 * A checkpoint arms a small, durable baseline for a Git checkout that is
 * reconstructible later under Git's tracked-content semantics — across HEAD movement, index changes,
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
 * programs and non-EOL clean/smudge transformations,
 * assume-unchanged and skip-worktree index flags, unmerged entries, sparse
 * checkout, tracked submodules, corrupt or unclassifiable HEAD, non-root capture paths,
 * enumeration warnings, capture races (an untracked entry changing under its
 * pre/post stat checks, or the index/tracked worktree shifting between the
 * two patch captures — arm re-verifies consistency read-only before
 * publishing), patch size overflow, malformed or missing pins.
 * `unsupported` results mean the Git strategy cannot be soundly applied to
 * this repository/state and callers may fall back to the existing filesystem
 * snapshot code; `failed` results are operational errors. Tracked text follows
 * Git-normalized semantics: CRLF/LF differences alone are not separately
 * captured. Non-ignored untracked content remains raw-exact.
 * A verified unborn symbolic HEAD uses a checkpoint-owned synthetic
 * parentless empty-tree commit as its base. The fixed non-personal identity
 * and object are created through hardened Git plumbing; the loose commit is
 * synced before its owned pin is published. This does not create the user's
 * first commit, move HEAD, change branch refs, or write the live index.
 * Corrupt or otherwise unverified HEAD state remains fail-closed.
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
 * or mismatched removes nothing. An interprocess per-window lock serializes
 * arm creation and failed-arm cleanup with release's proof, ref delete, and
 * owned-record removal; base-only ref CAS cannot close that interval.
 * `loadGitCheckpoint` applies the same proof
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
 * directory — never another session's refs. A crashed process may leave a
 * per-window mutex under `pi-review-gate/checkpoint-pin-locks`; removal is
 * manual only after confirming no checkpoint process still holds it.
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
 * EOL/mode fidelity (#204): the EFFECTIVE `core.autocrlf` (system/global/
 * local precedence) is read once per operation by a shell-free, config-only
 * probe that still sees ambient configuration, frozen as a final `-c`
 * override for every capture command — so a native Windows checkout with
 * system-level core.autocrlf=true diffs its CRLF worktree exactly as live
 * Git does instead of emitting a false full-file patch — and mixed into the
 * initial/final audit proof, so a mid-capture configuration change fails
 * closed. `core.filemode` is pinned false on Windows, where worktree
 * permission bits are noise (staged index mode changes remain fully captured
 * in the base→index patch), and true elsewhere. Durable-record base64 fields
 * are validated with a linear strict scan: the previous group-repetition
 * regex stack-overflows on the 8+ MiB payloads this module reloads.
 *
 * Directory fsync `EPERM` is best-effort on Windows; other sync errors remain
 * strict. This module is self-contained (node builtins only) and exposes:
 * `armGitCheckpoint`, `loadGitCheckpoint`, `verifyGitCheckpointPin`,
 * `restoreGitCheckpoint`, `compareToGitCheckpoint`, `compareGitCheckpoints`,
 * `releaseGitCheckpointPin`, `advanceGitCheckpoint`, plus record and
 * descriptor encode/decode.
 */

/**
 * Implementation layout (#233): the responsibilities documented above are
 * implemented in internal modules under `src/checkpoint/` — record codecs and
 * identity validation, hardened Git execution, repository resolution and
 * safety audit, capture primitives, durable record publication, pin
 * ownership/verification, armed tree reconstruction, worktree content access,
 * and the arm/load/advance/restore/live-compare/frozen-compare/release
 * operations. Those modules are internal: they are not a documented public
 * API and must not be imported by consumers or tests. This file is the stable
 * public facade and re-exports exactly the values listed above — no more, no
 * less — so existing imports keep their exact meaning.
 */

export { GitCheckpointError } from "./checkpoint/errors";
export type {
  GitCheckpointFailureReason,
  GitCheckpointReason,
  GitCheckpointResult,
  GitCheckpointUnsupportedReason,
} from "./checkpoint/errors";
export type {
  GitCheckpointComparisonReport,
  GitCheckpointFaultHooks,
  GitCheckpointOptions,
  GitCheckpointRestoreReport,
  GitCheckpointTrackedChange,
  GitCheckpointUntrackedChange,
  GitCheckpointUntrackedState,
} from "./checkpoint/types";
export {
  GIT_CHECKPOINT_DESCRIPTOR_FORMAT,
  GIT_CHECKPOINT_RECORD_FORMAT,
  GIT_CHECKPOINT_REF_PREFIX,
  checkpointRefForWindow,
  decodeGitCheckpointDescriptor,
  decodeGitCheckpointRecord,
  encodeGitCheckpointDescriptor,
  encodeGitCheckpointRecord,
  isSafeArmId,
  isSafeWindowId,
  isStrictBase64,
} from "./checkpoint/record";
export type {
  GitCheckpointArmStats,
  GitCheckpointDescriptor,
  GitCheckpointObjectFormat,
  GitCheckpointRecord,
  GitCheckpointUntrackedEntry,
} from "./checkpoint/record";
export { coreFilemodeOverrideFor, gitCheckpointDiscoveryEnv } from "./checkpoint/run-git";
export type { GitCheckpointArmOutcome } from "./checkpoint/arm";
export { armGitCheckpoint } from "./checkpoint/arm";
export { verifyGitCheckpointPin } from "./checkpoint/pin";
export type { GitCheckpointLoadOutcome } from "./checkpoint/load";
export { loadGitCheckpoint } from "./checkpoint/load";
export type { GitCheckpointAdvanceOutcome } from "./checkpoint/advance";
export { advanceGitCheckpoint } from "./checkpoint/advance";
export { restoreGitCheckpoint } from "./checkpoint/restore";
export { compareToGitCheckpoint } from "./checkpoint/compare";
export { compareGitCheckpoints } from "./checkpoint/frozen-compare";
export type { GitCheckpointReleaseOptions } from "./checkpoint/release";
export { releaseGitCheckpointPin } from "./checkpoint/release";
