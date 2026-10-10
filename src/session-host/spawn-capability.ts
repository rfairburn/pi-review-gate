import type { SessionSpawnInput, SessionSpawnOutcome } from "./protocol";

/** Process-local handoff from the authenticated reporter to the top-level gate extension. */
export const SESSION_HOST_SPAWN_CAPABILITY_KEY = Symbol.for("pi-review-gate.session-host.spawn-capability.v1");

export interface SessionHostSpawnCapability {
  /** Host-computed hypothetical-visible sidebar title-space snapshot, in terminal columns. */
  readonly titleColumns: number;
  spawn(input: SessionSpawnInput, signal?: AbortSignal): Promise<SessionSpawnOutcome>;
}

/** Publish only the reporter's closure; the bootstrap token remains private to that closure. */
export function publishSessionHostSpawnCapability(capability: SessionHostSpawnCapability): void {
  (globalThis as Record<PropertyKey, unknown>)[SESSION_HOST_SPAWN_CAPABILITY_KEY] = capability;
}

/** A stale reporter incarnation may clear only the exact capability it published. */
export function revokeSessionHostSpawnCapability(capability: SessionHostSpawnCapability): void {
  const scope = globalThis as Record<PropertyKey, unknown>;
  if (scope[SESSION_HOST_SPAWN_CAPABILITY_KEY] === capability) {
    delete scope[SESSION_HOST_SPAWN_CAPABILITY_KEY];
  }
}

/** Standalone sessions and executor workers have no reporter-published capability. */
export function getSessionHostSpawnCapability(): SessionHostSpawnCapability | undefined {
  const value = (globalThis as Record<PropertyKey, unknown>)[SESSION_HOST_SPAWN_CAPABILITY_KEY];
  if (typeof value !== "object" || value === null || typeof (value as { spawn?: unknown }).spawn !== "function") {
    return undefined;
  }
  return value as SessionHostSpawnCapability;
}
