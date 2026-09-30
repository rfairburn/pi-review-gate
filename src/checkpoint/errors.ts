/**
 * #233: checkpoint error identity and result mapping (extracted from
 * git-checkpoint.ts). Stable reason classifications, the GitCheckpointError
 * identity every operation throws, and the shared helpers that map thrown
 * values to fail-closed results. Leaf module: no internal imports.
 */

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

export function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw abortError(signal);
}

function abortError(signal: AbortSignal): Error {
  if (signal.reason instanceof Error) return signal.reason;
  const error = new Error("Operation cancelled.");
  error.name = "AbortError";
  return error;
}

export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Map any thrown value to a failed result, preserving typed reasons. */
export function resultFromError(error: unknown): GitCheckpointResult<never> {
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

export function truncateDetail(detail: string): string {
  return detail.length > 400 ? `${detail.slice(0, 400)}…` : detail;
}

export function fsCodeOf(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error ? (error as { code?: unknown }).code as string | undefined : undefined;
}
