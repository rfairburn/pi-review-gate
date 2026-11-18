import type { SessionHostsInspection, SessionSpawnInput, SessionSpawnOutcome } from "./protocol";

/** Process-local handoff from the authenticated reporter to the top-level gate extension. */
export const SESSION_HOST_SPAWN_CAPABILITY_KEY = Symbol.for("pi-review-gate.session-host.spawn-capability.v1");

export interface SessionHostSpawnCapability {
  /** Host-computed hypothetical-visible sidebar title-space snapshot, in terminal columns. */
  readonly titleColumns: number;
  /**
   * True only when this reporter's authenticated host registration advertised
   * routed-spawn support (bootstrap `spawnRouting`). Absent or false: only the
   * legacy own-host Pi request is accepted, and `spawn` refuses an input
   * carrying `host` or `kind` with a definite "failed" before staging or
   * sending anything.
   */
  readonly routing?: boolean;
  /** Carries the one exact {@link SessionSpawnInput}; never retries and never drops routing selectors. */
  spawn(input: SessionSpawnInput, signal?: AbortSignal): Promise<SessionSpawnOutcome>;
  /**
   * Read-only SessionHosts inspection. Present only when the authenticated host
   * registration advertised discovery (bootstrap `sessionHosts`, which requires
   * `spawnRouting`), so `routing` is always true alongside it. Resolves with one
   * complete validated snapshot or `unavailable`; it never auto-launches,
   * retries, connects, or reports a partial listing as complete.
   */
  inspectHosts?(signal?: AbortSignal): Promise<SessionHostsInspection>;
}

/** True only when a capability carries the actual routed SessionHosts inspection authority. */
export function hasSessionHostsInspection(
  capability: SessionHostSpawnCapability | undefined,
): capability is SessionHostSpawnCapability & Required<Pick<SessionHostSpawnCapability, "inspectHosts">> {
  return capability !== undefined && capability.routing === true && typeof capability.inspectHosts === "function";
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
