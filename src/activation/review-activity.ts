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
import {
  registerOwnedActivitySource,
  type OwnedActivityIntentRefresh,
  type OwnedActivitySourceHandle,
} from "../session-host/owned-activity";

/** The current review source incarnation for this module copy (if any). */
let reviewSourceHandle: OwnedActivitySourceHandle | undefined;
// A run must settle through the exact source incarnation that acquired it,
// independently of subsequent state replacement or module registration.
const reviewOwners = new Map<string, OwnedActivitySourceHandle>();

/**
 * The review source's recovery contract: re-acquire the authoritative exact
 * inventory on replay and report it to the registry's coalesced intent-refresh
 * pass. Shared by every entry point that can create the source so a pre-opt-in
 * registration is always replayable, whichever ran first. A pre-opt-in
 * registration is replayed as uncertain on both channels; the resync re-
 * acquires every in-flight run this module copy still owns (the `reviewOwners`
 * map is the authoritative exact inventory, retained across reloads) and then
 * resolves both channels.
 */
const reviewSourceOptions = {
  resync: () => {
    for (const [token] of reviewOwners) {
      reviewSourceHandle?.acquire(token);
      reviewSourceHandle?.acquireIntent(token);
    }
    reviewSourceHandle?.resolveUncertainty();
    reviewSourceHandle?.resolveIntentUncertainty();
  },
  refreshActivity: (): OwnedActivityIntentRefresh => {
    const handle = reviewSourceHandle;
    if (handle === undefined) return { status: "incomplete" };
    // Retirement is not incompleteness: this incarnation's own inventory is
    // still the only proof of its retained runs, and the registry fences the
    // result against this exact incarnation's revision.
    return { status: "complete", intentTokens: new Set(reviewOwners.keys()) };
  },
};

/**
 * Register the review source for this module incarnation so a session with no
 * automatic review can still report a known zero. Idempotent per copy.
 */
export function registerReviewActivitySource(): void {
  reviewSourceHandle ??= registerOwnedActivitySource("backgroundTasks", "review", reviewSourceOptions);
}

/**
 * Begin one automatic-review run. Returns the exact ownership token for that
 * run; the token is positive until `endOwnedReviewActivity` releases it.
 */
export function beginOwnedReviewActivity(): string {
  reviewSourceHandle ??= registerOwnedActivitySource("backgroundTasks", "review", reviewSourceOptions);
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
