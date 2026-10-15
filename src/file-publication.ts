import { open } from "node:fs/promises";

/**
 * Shared best-effort directory-sync mechanics for atomic publication.
 *
 * A rename or hard-link commit only becomes durable once the directory-entry
 * change itself reaches the storage layer, so every async record writer that
 * publishes with rename/link follows its commit with a directory fsync. Not
 * every supported platform or filesystem permits opening or fsync-ing a
 * directory, and a commit that already happened must never be re-reported as a
 * failure, so this stage is best-effort end to end: an open, sync or close
 * failure is swallowed here and never reaches the caller.
 *
 * This module owns that one mechanism and nothing else. Every other publication
 * decision is per-writer policy and stays at the call site: staged-file naming,
 * staged mode and whether it is forced with `chmod`, parent `mkdir`, the commit
 * primitive (rename versus hard-link), temp-file ownership and cleanup, error
 * precedence between a publication failure and a failing close, and
 * serialization. A writer whose post-commit contract deliberately differs must
 * keep its own directory stage: the settings save boundary does not catch its
 * directory close and so can still report a save failure after a rename that
 * already committed (pinned by tests/settings-config-write-publication.test.ts);
 * routing that writer through this helper would silently change its contract.
 */
export interface DirectorySyncOptions {
  /**
   * Runs inside the best-effort boundary, immediately before the directory is
   * opened, so a caller's observability or fault-injection hook keeps its exact
   * position and a throwing hook can never fail an already-committed
   * publication.
   */
  beforeSync?: () => void | Promise<void>;
}

/**
 * fsync `directory` so a publication committed inside it survives power loss.
 * Failures are intentionally invisible to the caller: the atomic publication
 * still protects readers from partial content on a filesystem that refuses
 * directory fsync.
 */
export async function syncDirectoryBestEffort(
  directory: string,
  options: DirectorySyncOptions = {},
): Promise<void> {
  try {
    await options.beforeSync?.();
    const handle = await open(directory, "r");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch {
    // Some platforms and filesystems reject directory handles or directory
    // fsync. A committed write is never failed by this stage.
  }
}
