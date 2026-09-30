/**
 * #233: checkpoint contract types (extracted from git-checkpoint.ts).
 * Options and fault hooks plus the report shapes returned by restore and the
 * comparison operations. Leaf module: no internal imports.
 */

// ── Options ──────────────────────────────────────────────────────────────────

/** @internal Deterministic fault seams for regression tests. */
export interface GitCheckpointFaultHooks {
  /** Runs after untracked enumeration, before the first capture stat. */
  afterUntrackedList?: () => void | Promise<void>;
  /** Runs after the pre-stat of an untracked path, before its read. */
  beforeUntrackedRead?: (absolutePath: string) => void | Promise<void>;
  /** Runs after a tracked worktree file is fully read, before its post-read identity re-check. */
  afterTrackedRead?: (absolutePath: string) => void | Promise<void>;
  /**
   * Runs after the staged (base → index) patch is captured and immediately
   * before the unstaged (index → worktree) patch. Deterministic seam for
   * regression tests of the capture-consistency verification.
   */
  betweenPatchCaptures?: () => void | Promise<void>;
  /** Runs after the initial repository audit, before an operation's capture window. */
  afterInitialAudit?: () => void | Promise<void>;
  /** Runs under the window pin lock after release verifies the owner, before deletion. */
  beforePinReleaseDelete?: () => void | Promise<void>;
  /** Runs under the window pin lock after release deletes the ref, before scratch cleanup. */
  afterPinReleaseDelete?: () => void | Promise<void>;
  /** Runs when an arm finds its window pin lock held (test synchronization). */
  onPinLockContended?: () => void | Promise<void>;
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
