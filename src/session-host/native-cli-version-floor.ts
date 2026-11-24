/**
 * #682: one strict, bounded comparator for the native provider CLI version
 * floors that gate managed callback eligibility (Claude Code inbox delivery,
 * Claude `/clear` MCP recovery, and the owned Codex callback backend).
 *
 * A floor admits a provider build only when its observed version is a
 * well-formed STABLE `major.minor.patch` triple under the existing official
 * version grammar (one to six ASCII digits per component) that is numerically
 * at or above the floor. Everything else is refused:
 *
 * - non-strings, empty strings, and anything with surrounding whitespace,
 *   control characters, or a line terminator;
 * - fewer or more than three components (`2.1`, `2.1.330.1`);
 * - a `v` prefix, a prerelease (`-alpha.1`), or build metadata (`+build`);
 * - a component longer than six digits; and
 * - a multi-digit component with a leading zero (`2.01.330`), which is
 *   ambiguous: it would otherwise compare equal to a different spelling.
 *
 * Comparison is numeric per component (major, then minor, then patch), never
 * lexicographic, so `2.1.1000` is above `2.1.330` and `0.99.0` is below
 * `0.171.0`. The comparator never normalizes: callers keep the exact observed
 * string as evidence and compare observations to each other by equality.
 *
 * A floor is a compatibility admission, not a claim that a newer release was
 * tested: every other eligibility, ownership, authentication, and response
 * parsing check stays in force and fails closed on any shape it does not know.
 * Pure; no I/O; never throws.
 */

/** Exact stable grammar: three components of 1–6 digits, no leading zero on a multi-digit component. */
const STABLE_CLI_VERSION = /^(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})$/u;

/** The parsed numeric components of one well-formed stable CLI version. */
export type StableCliVersionParts = readonly [major: number, minor: number, patch: number];

/**
 * The numeric `[major, minor, patch]` of a well-formed stable CLI version, or
 * `undefined` for anything else (see the module header for the refused forms).
 */
export function parseStableCliVersion(version: unknown): StableCliVersionParts | undefined {
  if (typeof version !== "string") return undefined;
  const match = STABLE_CLI_VERSION.exec(version);
  // The match must consume the entire string.
  if (match === null || match[0] !== version) return undefined;
  const parts = [Number(match[1]), Number(match[2]), Number(match[3])] as const;
  return parts.every((part) => Number.isSafeInteger(part) && part >= 0) ? Object.freeze(parts) : undefined;
}

/**
 * Whether `version` is a well-formed stable CLI version numerically at or
 * above `floor`. `false` when either side is not well formed (a malformed
 * floor admits nothing).
 */
export function isStableCliVersionAtLeast(version: unknown, floor: string): boolean {
  const observed = parseStableCliVersion(version);
  const minimum = parseStableCliVersion(floor);
  if (observed === undefined || minimum === undefined) return false;
  for (let index = 0; index < 3; index += 1) {
    if (observed[index] !== minimum[index]) return observed[index] > minimum[index];
  }
  return true;
}
