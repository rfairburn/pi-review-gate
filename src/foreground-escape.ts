/**
 * Escape arbitration for the shared pending-input popup. Pi dispatches raw
 * listeners BEFORE focused component input. Every participating raw listener
 * must route and consume in one call: checking focus after handleInput/done
 * would let a synchronous close expose the same Escape to a later aborter.
 * No packet history or timing grace period is needed; the next press is fresh.
 */
import { isEscapeTerminalInput } from "./pi";

interface EscapeOwner {
  handleInput(data: string): void;
  isForeground(): boolean;
  isCurrent(): boolean;
}

const owners = new WeakMap<object, EscapeOwner>();

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
  owners.set(scope, owner);
  // An older popup's finally must never retire its replacement.
  return () => { if (owners.get(scope) === owner) owners.delete(scope); };
}

export function routeForegroundEscape(origin: unknown, input: unknown): boolean {
  if (!isEscapeTerminalInput(input)) return false;
  const scope = scopeOf(origin);
  const owner = scope ? owners.get(scope) : undefined;
  if (!owner) return false;
  try {
    if (!owner.isCurrent() || !owner.isForeground()) return false;
  } catch {
    return false; // An invalidated host handle/context owns no foreground input.
  }
  // Capture ownership BEFORE invocation. Even when done retires it synchronously,
  // this raw dispatch remains consumed and cannot cancel the review underneath.
  owner.handleInput(typeof input === "string" ? input : "\x1b");
  return true;
}
