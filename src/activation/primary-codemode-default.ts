/**
 * Wrapper launch intent for the primary Pi process.
 *
 * Pi can replace its session manager and reload extension factories without
 * restarting the Node process. Keep only this boolean in process memory so the
 * primary activation can rebuild its per-session authorization boundary after
 * those replacements. It is never stored in the environment or on disk, and
 * callers must not consult it for executor runtimes.
 */
const PRIMARY_CODEMODE_DEFAULT_KEY = Symbol.for("pi-review-gate.primary-codemode-default.v1");

function processState(): Record<symbol, unknown> {
  return globalThis as unknown as Record<symbol, unknown>;
}

/** Capture a consumed wrapper marker and return the sticky primary-process intent. */
export function capturePrimaryCodemodeDefault(wrapperMarkerPresent: boolean): boolean {
  const slot = processState();
  if (slot[PRIMARY_CODEMODE_DEFAULT_KEY] === true || wrapperMarkerPresent) {
    slot[PRIMARY_CODEMODE_DEFAULT_KEY] = true;
    return true;
  }
  return false;
}

/** @internal Test-only process-state isolation. Production code never resets this. */
export function resetPrimaryCodemodeDefaultForTests(): void {
  delete processState()[PRIMARY_CODEMODE_DEFAULT_KEY];
}
