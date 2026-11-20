import { posix, win32 } from "node:path";

/**
 * Managed session-host startup canonicalization of the explicit review-gate
 * configuration override (issue #653).
 *
 * A standalone Pi reads `PI_REVIEW_GATE_CONFIG` relative to its own working
 * directory, and that behavior is unchanged. A managed sidebar host, however,
 * starts every child in that child's own workspace, so a relative override
 * would silently name a different file per workspace. The managed host
 * therefore resolves a nonempty relative override exactly ONCE, against its
 * own startup directory, and hands the resulting absolute path to every
 * managed session it launches (New, SessionSpawn, and every other create that
 * uses the host's startup environment snapshot).
 *
 * This is a value normalization only: the override is never stripped,
 * replaced by a different file, validated, or refused here, an absolute or
 * empty value passes through unchanged, and no live configuration snapshot is
 * consulted. Children still read the file themselves at their own startup.
 */

/** The explicit review-gate configuration override honored by `loadConfig`. */
export const MANAGED_CONFIG_OVERRIDE_ENV = "PI_REVIEW_GATE_CONFIG";

export interface ManagedConfigOverrideRelativeResolution {
  /** The relative override exactly as the host inherited it. */
  readonly original: string;
  /** The single absolute path every managed session receives. */
  readonly resolved: string;
}

export interface ManagedConfigOverrideResolution {
  /**
   * A detached copy of the input environment, identical except that a
   * nonempty relative override is replaced by its startup-resolved absolute
   * path. The caller's environment object is never mutated.
   */
  readonly env: NodeJS.ProcessEnv;
  /** Present only when a relative override was resolved (the warning case). */
  readonly relative?: ManagedConfigOverrideRelativeResolution;
}

/**
 * Resolve the managed host's explicit configuration override once against the
 * host startup directory. Total by design: it never throws for string input,
 * so applying it can never refuse a startup that was accepted before.
 */
export function resolveManagedConfigOverride(
  env: NodeJS.ProcessEnv,
  startupCwd: string,
  platform: NodeJS.Platform = process.platform,
): ManagedConfigOverrideResolution {
  const detached: NodeJS.ProcessEnv = { ...env };
  const value = detached[MANAGED_CONFIG_OVERRIDE_ENV];
  if (typeof value !== "string" || value.length === 0) return { env: detached };
  if (isFullyQualifiedOverride(value, platform)) return { env: detached };
  const resolved = (platform === "win32" ? win32 : posix).resolve(startupCwd, value);
  detached[MANAGED_CONFIG_OVERRIDE_ENV] = resolved;
  return { env: detached, relative: { original: value, resolved } };
}

/**
 * Only a path that names one file regardless of any child's cwd or drive is
 * passed through. On Windows `path.win32.isAbsolute` also accepts rooted but
 * drive-relative forms (`\\cfg\\rg.json`, `/cfg/rg.json`), which still resolve
 * against each child's current drive, so only drive-qualified (`X:\\`, `X:/`)
 * and UNC/device (`\\\\server\\share`, `//server/share`) paths qualify there;
 * every other spelling, including drive-relative `X:file`, is resolved once
 * against the startup directory.
 */
function isFullyQualifiedOverride(value: string, platform: NodeJS.Platform): boolean {
  if (platform !== "win32") return posix.isAbsolute(value);
  return /^[a-zA-Z]:[\\/]/.test(value) || /^[\\/]{2}[^\\/]/.test(value);
}

/** One bounded startup warning for the relative-override case. */
export function managedConfigOverrideWarning(relative: ManagedConfigOverrideRelativeResolution): string {
  return `pi-review-gate: ${MANAGED_CONFIG_OVERRIDE_ENV} is a relative path; `
    + `this session host resolved it once against its startup directory and every managed session uses ${JSON.stringify(relative.resolved)}. `
    + "Set an absolute path to avoid this warning.";
}
