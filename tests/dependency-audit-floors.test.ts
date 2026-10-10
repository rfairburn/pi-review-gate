import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { projectRoot } from "./helpers/release-scripts";

// Dependency-vulnerability floor guard (issue #329).
//
// `npm audit` needs the advisory registry, so CI cannot re-derive vulnerability
// state offline. What *is* checkable offline is the committed resolution: every
// package the audit reported when #329 was fixed must stay at or above the first
// release outside its vulnerable range, and the one direct dependency among them
// must keep a range floor that a previously hoisted vulnerable copy cannot satisfy.
//
// Each floor below is that first fixed release, with the advisories it clears.
// A package that is absent from the tree, or a later version above the floor, passes:
// ordinary upgrades and removals never have to edit this table. A *new* advisory for
// one of these packages is deliberately not detected here — that requires a fresh
// audit, not this static guard.

const FIXED_FLOORS: ReadonlyArray<{ name: string; floor: string; advisories: readonly string[] }> = [
  {
    name: "@modelcontextprotocol/sdk",
    floor: "1.31.0",
    advisories: ["GHSA-6qxp-vccf-f47h"],
  },
  {
    name: "fast-uri",
    floor: "3.1.8",
    advisories: ["GHSA-qw65-cvwx-89v3", "GHSA-58mr-gqgx-xq4g", "GHSA-hrr3-gc8f-f4qj"],
  },
  {
    name: "hono",
    floor: "4.13.7",
    advisories: ["GHSA-gqvv-2mrq-wpjv", "GHSA-g6gw-c38x-mqfc", "GHSA-crvj-82cr-hjcx", "GHSA-hxh3-vqpv-xpqv"],
  },
  {
    name: "ip-address",
    floor: "10.7.1",
    advisories: ["GHSA-rpw4-54j3-4h4q", "GHSA-2vr4-cq9g-pvrc", "GHSA-j6r3-76f7-8jcv", "GHSA-h3mg-xc3c-68pw"],
  },
  {
    name: "proxy-addr",
    floor: "2.0.8",
    advisories: ["GHSA-jqcg-44mw-7w3h"],
  },
  {
    name: "undici",
    floor: "6.29.0",
    advisories: ["GHSA-3wwx-pv8p-q78v", "GHSA-r53p-7pc4-xj5r", "GHSA-rfgv-xxqx-mfg5"],
  },
];

// The only direct dependency in FIXED_FLOORS; its manifest range is what a
// consumer's own resolution is allowed to reuse.
const DIRECT_FLOOR_PACKAGE = "undici";

function parseVersion(version: string): { parts: number[]; prerelease: boolean } {
  const [core, ...rest] = version.split("-");
  const parts = core.split(".").map((part) => {
    if (!/^\d+$/.test(part)) throw new Error(`unsupported version segment in ${JSON.stringify(version)}`);
    return Number(part);
  });
  return { parts, prerelease: rest.join("-") !== "" };
}

function compareVersions(left: string, right: string): number {
  const a = parseVersion(left);
  const b = parseVersion(right);
  for (let i = 0; i < Math.max(a.parts.length, b.parts.length); i += 1) {
    const x = a.parts[i] ?? 0;
    const y = b.parts[i] ?? 0;
    if (x !== y) return x < y ? -1 : 1;
  }
  if (a.prerelease !== b.prerelease) return a.prerelease ? -1 : 1;
  return 0;
}

interface LockEntry {
  version?: string;
  link?: boolean;
}

/** Every lockfile resolution for `name`, including nested (de-duplicated) copies. */
function lockEntriesFor(lock: { packages?: Record<string, LockEntry> }, name: string): Array<{ where: string; version: string }> {
  const suffix = `/node_modules/${name}`;
  const top = `node_modules/${name}`;
  return Object.entries(lock.packages ?? {})
    .filter(([where]) => where === top || where.endsWith(suffix))
    .map(([where, entry]) => {
      assert.equal(typeof entry.version, "string", `${where} has no resolved version`);
      return { where, version: entry.version as string };
    });
}

/**
 * Lowest stable version a manifest specifier can resolve to. Only the single-range
 * forms npm uses here are understood: `^x.y.z`, `~x.y.z`, `>=x.y.z`, `=x.y.z`, or an
 * exact `x.y.z`, with nothing after them. Everything else fails closed, because a
 * compound or prerelease range can admit a release below the floor while still
 * containing a safe-looking prefix: `^6.29.0 || 6.28.0` admits the vulnerable release
 * through its second alternative, and `^6.29.0-beta.1` admits that prerelease, which
 * sorts below `6.29.0`. Exported for the focused guard tests below.
 */
export function specifierFloor(specifier: string): string {
  const trimmed = specifier.trim();
  const match = /^(?:\^|~|>=|=)?\s*(\d+\.\d+\.\d+)$/.exec(trimmed);
  assert.ok(
    match,
    `unsupported dependency specifier ${JSON.stringify(specifier)}: this guard only understands one stable range `
      + "(`^x.y.z`, `~x.y.z`, `>=x.y.z`, `=x.y.z`, or `x.y.z`); compound and prerelease ranges must be rejected "
      + "because they can still admit a release below the fixed floor",
  );
  return match[1];
}

test("the floor parser reads one stable range and refuses anything a vulnerable release could hide in", () => {
  // Accepted single-range forms (the property is their lowest resolvable version).
  for (const [specifier, floor] of [
    ["^6.29.0", "6.29.0"],
    ["~6.29.0", "6.29.0"],
    [">=6.29.0", "6.29.0"],
    ["=6.29.0", "6.29.0"],
    ["6.29.0", "6.29.0"],
  ] as ReadonlyArray<[string, string]>) {
    assert.equal(specifierFloor(specifier), floor, `${specifier} must parse as ${floor}`);
  }
  // Rejected: a union, a prerelease, a missing patch, and multi-range forms can all
  // admit a release strictly below the floor while carrying a safe-looking prefix.
  for (const unsafe of [
    "^6.29.0 || 6.28.0",
    "^6.29.0-beta.1",
    "6.29.0-rc.1",
    ">=6.29.0-beta.1",
    "^6.29",
    "^6.29.0 <6.30.0",
    "^>=6.29.0",
  ]) {
    assert.throws(
      () => specifierFloor(unsafe),
      /unsupported dependency specifier/,
      `${unsafe} must be refused rather than read as a floor`,
    );
  }
});

test("the committed lock keeps every reported-vulnerable package at or above its fixed release", () => {
  const lock = JSON.parse(
    fs.readFileSync(path.join(projectRoot(), "package-lock.json"), "utf8"),
  ) as { packages?: Record<string, LockEntry> };
  for (const { name, floor, advisories } of FIXED_FLOORS) {
    for (const { where, version } of lockEntriesFor(lock, name)) {
      assert.ok(
        compareVersions(version, floor) >= 0,
        `${where} resolves ${name} ${version}, which is affected by ${advisories.join(", ")}; ` +
          `the committed lock must stay at or above ${floor}`,
      );
    }
  }
});

test("the direct undici range floor cannot be satisfied by a vulnerable copy", () => {
  const manifest = JSON.parse(
    fs.readFileSync(path.join(projectRoot(), "package.json"), "utf8"),
  ) as { dependencies?: Record<string, string> };
  const specifier = manifest.dependencies?.[DIRECT_FLOOR_PACKAGE];
  assert.equal(
    typeof specifier,
    "string",
    `${DIRECT_FLOOR_PACKAGE} must stay a direct dependency so its advisory floor is declared`,
  );
  const floor = FIXED_FLOORS.find((entry) => entry.name === DIRECT_FLOOR_PACKAGE)?.floor as string;
  assert.ok(
    compareVersions(specifierFloor(specifier as string), floor) >= 0,
    `${DIRECT_FLOOR_PACKAGE} is declared as ${specifier}, which still admits releases below the fixed ${floor}`,
  );
});
