/**
 * Real-runtime precondition shared by the native Main/launcher acceptance
 * helpers (issue 489). It mirrors Main's stable-only per-line Node security
 * minimums so a host the production preflight would refuse is reported as a
 * missing prerequisite instead of an obscure preflight failure. This is a test
 * precondition only: the production checks are exercised directly by their own
 * focused regressions, never judged against this helper.
 */
export const NODE_SECURITY_FLOOR_TEXT = "Node >=22.23.4 (Node 24 >=24.22.1, Node 26 >=26.12.1)";

const LINE_FLOORS: readonly (readonly [number, number, number])[] = [[22, 23, 4], [24, 22, 1], [26, 12, 1]];

/** True only for a stable `x.y.z` (optional leading `v`) at or above its line's floor. */
export function stableNodeMeetsSecurityFloor(version: string): boolean {
  const parsed = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (!parsed) return false;
  const actual = [Number(parsed[1]), Number(parsed[2]), Number(parsed[3])];
  const floor = [...LINE_FLOORS].reverse().find(([major]) => major <= actual[0]!) ?? LINE_FLOORS[0]!;
  for (let index = 0; index < floor.length; index += 1) {
    if (actual[index]! > floor[index]!) return true;
    if (actual[index]! < floor[index]!) return false;
  }
  return true;
}

/**
 * Hand-written per-line expectations (issue 489) shared by the focused
 * regressions of each production check. `launcher` is the CJS/POSIX/PowerShell
 * semantics (prerelease admitted only strictly above the applicable floor);
 * `main` is Main's stable-only preflight and, for stable versions, the package
 * engines range. Literal values: never derived from the code under test.
 */
export interface NodeSecurityFloorCase {
  readonly version: string;
  readonly launcher: boolean;
  readonly main: boolean;
  readonly why: string;
}

export const NODE_SECURITY_FLOOR_CASES: readonly NodeSecurityFloorCase[] = [
  { version: "21.99.99", launcher: false, main: false, why: "majors below 22 stay refused" },
  { version: "22.19.0", launcher: false, main: false, why: "the superseded 22 floor is now below the minimum" },
  { version: "22.23.3", launcher: false, main: false, why: "below the Node 22 floor in the same line" },
  { version: "22.23.4", launcher: true, main: true, why: "exact Node 22 floor" },
  { version: "22.23.5", launcher: true, main: true, why: "later Node 22 patch" },
  { version: "22.24.0", launcher: true, main: true, why: "later Node 22 minor" },
  { version: "22.23.4-rc.1", launcher: false, main: false, why: "prerelease at the exact Node 22 floor" },
  { version: "22.23.5-rc.1", launcher: true, main: false, why: "prerelease above the floor; Main is stable-only" },
  { version: "23.0.0", launcher: true, main: true, why: "unlisted newer major keeps existing policy" },
  { version: "23.0.0-rc.1", launcher: true, main: false, why: "unlisted-major prerelease keeps existing policy" },
  { version: "24.0.0", launcher: false, main: false, why: "unpatched Node 24 line" },
  { version: "24.22.0", launcher: false, main: false, why: "below the Node 24 floor in the same line" },
  { version: "24.22.1", launcher: true, main: true, why: "exact Node 24 floor" },
  { version: "24.22.2", launcher: true, main: true, why: "later Node 24 patch" },
  { version: "24.23.0", launcher: true, main: true, why: "later Node 24 minor" },
  { version: "24.22.1-rc.1", launcher: false, main: false, why: "prerelease at the exact Node 24 floor" },
  { version: "25.0.0", launcher: true, main: true, why: "unlisted newer major keeps existing policy" },
  { version: "26.0.0", launcher: false, main: false, why: "unpatched Node 26 line" },
  { version: "26.5.0", launcher: false, main: false, why: "unpatched Node 26 release" },
  { version: "26.12.0", launcher: false, main: false, why: "below the Node 26 floor in the same line" },
  { version: "26.12.1", launcher: true, main: true, why: "exact Node 26 floor" },
  { version: "26.12.2", launcher: true, main: true, why: "later Node 26 patch" },
  { version: "26.13.0", launcher: true, main: true, why: "later Node 26 minor" },
  { version: "26.12.1-rc.1", launcher: false, main: false, why: "prerelease at the exact Node 26 floor" },
  { version: "27.0.0", launcher: true, main: true, why: "unlisted newer major keeps existing policy" },
  { version: "30.1.2", launcher: true, main: true, why: "unlisted newer major keeps existing policy" },
];
