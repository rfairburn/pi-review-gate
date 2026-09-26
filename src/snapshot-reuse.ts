import { resolve } from "node:path";
import type { WorkspaceSnapshot } from "./capture";

/**
 * #193 lifecycle seam: a bounded, process-/session-local reference to the last
 * successfully completed workspace snapshot, retained across ordinary review-window
 * close so the first capture of a new unseeded exchange can pass it as
 * `reuseUnchangedFrom` to `createWorkspaceSnapshot`.
 *
 * Boundaries (fail closed):
 * - Only completed captures may seed this. An aborted or failed capture rejects,
 *   so callers must invoke `remember` only after the capture promise resolves;
 *   a failure leaves the previous entry untouched (or none).
 * - The retained snapshot is a reuse source, never a review baseline: the capture
 *   still enumerates and stats every current path, re-verifies each reused record
 *   against the live entry, and recomputes every retain/omit decision against the
 *   current limits. Additions, deletions, and edits are always observed fresh.
 * - Never persisted and never carried across session boundaries: the entrypoint
 *   clears it on session_start and session_shutdown (which also covers /new,
 *   replacement, and /reload, where a fresh activation starts empty anyway).
 * - Same resolved root only: a different cwd yields no source, and the next
 *   successful capture moves the entry to that root. The helper independently
 *   refuses cross-root sources as a second gate.
 */
export class CompletedSnapshotCache {
  private retained: { cwd: string; snapshot: WorkspaceSnapshot } | undefined;

  /** Remember the last successfully completed capture (bounded to one entry). */
  remember(snapshot: WorkspaceSnapshot): void {
    this.retained = { cwd: resolve(snapshot.cwd), snapshot };
  }

  /** The retained source only when it came from the same resolved root. */
  reuseSourceFor(cwd: string): WorkspaceSnapshot | undefined {
    if (!this.retained) return undefined;
    return this.retained.cwd === resolve(cwd) ? this.retained.snapshot : undefined;
  }

  /** Drop the retained source at a session boundary (start/shutdown/reload/switch). */
  clear(): void {
    this.retained = undefined;
  }

  /** Read-only observation surface for lifecycle tests: the currently retained entry. */
  current(): { cwd: string; snapshot: WorkspaceSnapshot } | undefined {
    return this.retained;
  }
}
