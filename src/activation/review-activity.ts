/**
 * Automatic-review owned-work telemetry (native session cards).
 *
 * Owns exactly one review source incarnation and mints one exact ownership
 * token per review run. Behavior is never changed: the review gate itself
 * remains owned by review-turn.ts; this module only mirrors the authoritative
 * `reviewInProgress` lifecycle into the process-local owned-activity registry,
 * which stays inert (no IO, no observation) until the authenticated session
 * host reporter opts in. Each run mints the same token on BOTH channels: the
 * review's ownership obligation and its activity intent begin and end together,
 * so a running automatic review is displayed as active work and is released at
 * settlement (success, failure, cancellation, or reset).
 *
 * A token is released only by the run that holds it. Session reset/restore and
 * a reloaded module copy therefore cannot release a newer incarnation's
 * unsettled review.
 */
import { randomUUID } from "node:crypto";
import { registerOwnedActivitySource, type OwnedActivitySourceHandle } from "../session-host/owned-activity";

/** The current review source incarnation for this module copy (if any). */
let reviewSourceHandle: OwnedActivitySourceHandle | undefined;
// A run must settle through the exact source incarnation that acquired it,
// independently of subsequent state replacement or module registration.
const reviewOwners = new Map<string, OwnedActivitySourceHandle>();

/**
 * Register the review source for this module incarnation so a session with no
 * automatic review can still report a known zero. Idempotent per copy.
 */
export function registerReviewActivitySource(): void {
  reviewSourceHandle ??= registerOwnedActivitySource("backgroundTasks", "review");
}

/**
 * Begin one automatic-review run. Returns the exact ownership token for that
 * run; the token is positive until `endOwnedReviewActivity` releases it.
 */
export function beginOwnedReviewActivity(): string {
  reviewSourceHandle ??= registerOwnedActivitySource("backgroundTasks", "review");
  const token = randomUUID();
  reviewOwners.set(token, reviewSourceHandle);
  reviewSourceHandle.acquire(token);
  reviewSourceHandle.acquireIntent(token);
  return token;
}

/**
 * End exactly the review run identified by `token` (a missing or already
 * released token is a no-op). Never touches another incarnation's run.
 */
export function endOwnedReviewActivity(token: string | undefined): void {
  if (!token) return;
  const owner = reviewOwners.get(token);
  if (!owner) return;
  reviewOwners.delete(token);
  owner.release(token);
  owner.releaseIntent(token);
}

/** Test seam: forget the module-copy handle (a fresh registration follows). */
export const __test = Object.freeze({
  resetReviewActivityForTests(): void {
    reviewSourceHandle = undefined;
    reviewOwners.clear();
  },
});
