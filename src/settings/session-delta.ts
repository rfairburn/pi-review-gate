/**
 * The process-local pending session-only delta for one live config
 * (issue #294). A root Escape applies the staged settings to the live config
 * without persisting them; this bounded record keeps exactly the transaction
 * metadata a later Save needs to carry those choices through — baseline data,
 * never a mirror of the live config, which remains the single active session
 * store:
 *
 * - the external-agent operations applied session-only, as baseline-only
 *   identity mappings (original id, original on-disk definition baseline,
 *   resulting id) with their pre-cascade reference baselines for the
 *   optimistic guard — never a copy of an active definition, which the live
 *   config owns and which a later Save reconstructs from it; so a later
 *   Save persists the cascade instead of silently reverting it;
 * - the schedule ids removed from live, so a later Save deletes them on disk
 *   instead of preserving them as foreign entries;
 * - the entry ids whose alreadyRun was explicitly toggled, extending the
 *   #306 explicit-toggle-wins rule across menu sessions until saved.
 *
 * The record is keyed by live-config object identity: replaceConfig preserves
 * identity across applies, /reload creates a fresh config object (the delta
 * is auto-invalidated with no explicit clearing), and a successful Save
 * clears it because its effects are then durable. A failed Save retains it.
 */
import type { ReviewGateConfig } from "../config";
import type { ExternalAgentOperation, ExternalAgentReferenceBaseline } from "./external-agent-catalog";

export interface PendingSessionDelta {
  /**
   * External-agent operations applied session-only, as baseline-only identity
   * mappings (no active-definition copies); seeded into the next menu session,
   * where each operation's definition is reconstructed from the live config.
   */
  agentOperations: Array<Omit<ExternalAgentOperation, "definition"> & { definition?: never }>;
  /** Pre-cascade reference baselines keyed by original agent id (optimistic guard at Save). */
  agentReferenceBaselines: Map<string, ExternalAgentReferenceBaseline>;
  /** Schedule ids removed from live by a session-only apply. */
  scheduleDeletions: Set<string>;
  /** Entry ids whose alreadyRun was explicitly toggled in a session-only apply. */
  alreadyRunEdited: Set<string>;
}

const pendingDeltas = new WeakMap<ReviewGateConfig, PendingSessionDelta>();

/** The pending session-only delta for one live config, if any. */
export function getPendingSessionDelta(config: ReviewGateConfig): PendingSessionDelta | undefined {
  return pendingDeltas.get(config);
}

/** Record (replace) the pending session-only delta for one live config. */
export function recordPendingSessionDelta(config: ReviewGateConfig, delta: PendingSessionDelta): void {
  pendingDeltas.set(config, delta);
}

/** Clear the pending delta once its effects are durable (successful Save). */
export function clearPendingSessionDelta(config: ReviewGateConfig): void {
  pendingDeltas.delete(config);
}
