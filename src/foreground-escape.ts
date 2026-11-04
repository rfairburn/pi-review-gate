/**
 * Escape arbitration for the shared foreground surface stack (the pending-input
 * popup and the settings transaction's own screens). Pi dispatches raw
 * listeners BEFORE focused component input. Every participating raw listener
 * must route and consume in one call: checking focus after handleInput/done
 * would let a synchronous close expose the same Escape to a later aborter.
 * No packet history or timing grace period is needed; the next press is fresh.
 *
 * Ownership is a per-scope LIFO stack, not one slot. A surface that opens
 * above an already-owned one (the popup over an open settings menu) takes the
 * top, and retiring it uncovers the surface underneath instead of leaving the
 * session with no owner and handing the next Escape to review cancellation.
 * Retirement stays identity-exact — an older surface's cleanup can never
 * retire its replacement — and routing only ever reaches an owner that is
 * still current AND actually foreground, so a stale or covered surface claims
 * nothing and the scan falls through to the surface that really has input.
 */
import { isEscapeTerminalInput } from "./pi";

interface EscapeOwner {
  handleInput(data: string): void;
  isForeground(): boolean;
  isCurrent(): boolean;
}

const owners = new WeakMap<object, EscapeOwner[]>();

/** Fresh native contexts share SessionManager, not their per-access ui object.
 * Direct/non-native callers without one are scoped to their explicit origin.
 */
function scopeOf(origin: unknown): object | undefined {
  if (typeof origin !== "object" || origin === null) return undefined;
  try {
    const session = (origin as { sessionManager?: unknown }).sessionManager;
    if (typeof session === "object" && session !== null) return session;
    return origin;
  } catch {
    return undefined;
  }
}

export function publishForegroundEscape(origin: unknown, owner: EscapeOwner): () => void {
  const scope = scopeOf(origin);
  if (!scope) return () => {};
  const stack = owners.get(scope);
  if (stack) stack.push(owner);
  else owners.set(scope, [owner]);
  // An older surface's finally must never retire its replacement: removal is
  // by owner identity, and the surface underneath stays in place beneath it.
  return () => {
    const current = owners.get(scope);
    if (!current) return;
    const index = current.indexOf(owner);
    if (index >= 0) current.splice(index, 1);
    if (current.length === 0) owners.delete(scope);
  };
}

export function routeForegroundEscape(origin: unknown, input: unknown): boolean {
  if (!isEscapeTerminalInput(input)) return false;
  const scope = scopeOf(origin);
  const stack = scope ? owners.get(scope) : undefined;
  if (!stack || stack.length === 0) return false;
  // Newest first: the surface that opened last is the one the user is looking
  // at. A covered or invalidated owner is skipped rather than consuming, so a
  // settings menu under a popup overlay never steals the overlay's Escape.
  for (let index = stack.length - 1; index >= 0; index -= 1) {
    const owner = stack[index]!;
    try {
      if (!owner.isCurrent() || !owner.isForeground()) continue;
    } catch {
      continue; // An invalidated host handle/context owns no foreground input.
    }
    // Capture ownership BEFORE invocation. Even when done retires it
    // synchronously, this raw dispatch remains consumed and cannot cancel the
    // review underneath.
    owner.handleInput(typeof input === "string" ? input : "\x1b");
    return true;
  }
  return false;
}
