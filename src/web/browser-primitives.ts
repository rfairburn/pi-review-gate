/**
 * Dependency-free fail-closed primitives shared by the interactive browser
 * helper modules (diagnostics, errors, operations, URL policy) and the
 * manager. Nothing in this module imports a browser module, so it cannot take
 * part in a runtime dependency cycle.
 */

/** Coerce an unknown thrown value into an Error without altering its identity. */
export function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

/** Bound manager-authored text with one trailing ellipsis at maxChars. */
export function bounded(value: string, maxChars: number): string {
  return value.length <= maxChars ? value : `${value.slice(0, Math.max(0, maxChars - 1))}…`;
}

/** Fail closed on an already-aborted signal, rethrowing its reason verbatim. */
export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw asError(signal.reason ?? new Error("Browser operation cancelled."));
}
