/**
 * Dependency-baseline guard for routine dependency maintenance.
 *
 * `npm audit` needs the advisory registry, so an offline test cannot re-derive
 * vulnerability state. What *is* checkable offline is the committed resolution:
 * each package listed here carries a maintenance baseline — the release it must
 * reach in the committed lock — and the one direct dependency among them must
 * keep a manifest range whose floor an older locked copy cannot satisfy.
 *
 * A package that resolves above its floor passes, so ordinary upgrades never have
 * to touch this table. A package that has moved below its floor fails, and so does
 * a listed package the lock no longer resolves at all: when such a package really
 * does leave the dependency tree, drop its row rather than lowering the floor.
 *
 * The synchronisation checks are generic and have nothing to do with any single
 * package: they keep the locked dependency specifiers and the resolved copies in
 * step with root `package.json`, which is exactly what a clean `npm ci` assumes.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";
import { projectRoot } from "./helpers/release-scripts";

// The committed maintenance baseline: the lowest release each listed package is
// expected to resolve to, at the root or nested anywhere in the tree.
const BASELINE_FLOORS: ReadonlyArray<{ name: string; floor: string }> = [
  { name: "body-parser", floor: "2.4.0" },
  { name: "fast-uri", floor: "3.1.9" },
  { name: "ip-address", floor: "10.7.5" },
  { name: "qs", floor: "6.16.1" },
  { name: "zod", floor: "4.6.7" },
  { name: "undici", floor: "6.29.1" },
];

// The only direct dependency in the baseline; its manifest range is what a
// consumer's own resolution is allowed to reuse.
const DIRECT_BASELINE_PACKAGE = "undici";
const DIRECT_BASELINE_FLOOR = "6.29.1";

interface LockPackage {
  name?: string;
  version?: string;
  resolved?: string;
}

interface Lock {
  packages?: Record<string, LockPackage>;
}

interface Manifest {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
}

function readLock(): Lock {
  return JSON.parse(fs.readFileSync(path.join(projectRoot(), "package-lock.json"), "utf8")) as Lock;
}

function readManifest(): Manifest {
  return JSON.parse(fs.readFileSync(path.join(projectRoot(), "package.json"), "utf8")) as Manifest;
}

function parseVersion(version: string): { parts: number[]; prerelease: string } {
  const [core, ...rest] = version.split("-");
  const parts = core.split(".").map((part) => {
    if (!/^\d+$/.test(part)) throw new Error(`unsupported version segment in ${JSON.stringify(version)}`);
    return Number(part);
  });
  return { parts, prerelease: rest.join("-") };
}

/** Ordinal comparison of plain and prerelease versions (numeric core, then prerelease presence). */
function compareVersions(left: string, right: string): number {
  const a = parseVersion(left);
  const b = parseVersion(right);
  for (let i = 0; i < Math.max(a.parts.length, b.parts.length); i += 1) {
    const x = a.parts[i] ?? 0;
    const y = b.parts[i] ?? 0;
    if (x !== y) return x < y ? -1 : 1;
  }
  if (a.prerelease !== b.prerelease) return a.prerelease === "" ? 1 : -1;
  return 0;
}

/** Every lockfile resolution for `name`, including nested (de-duplicated) copies. */
function lockEntriesFor(lock: Lock, name: string): Array<{ where: string; version: string }> {
  const top = `node_modules/${name}`;
  const suffix = `/node_modules/${name}`;
  return Object.entries(lock.packages ?? {})
    .filter(([where]) => where === top || where.endsWith(suffix))
    .map(([where, entry]) => {
      assert.equal(typeof entry.version, "string", `${where} has no resolved version`);
      return { where, version: entry.version as string };
    });
}

/**
 * Lowest stable version a manifest specifier can resolve to. Only the single-range
 * forms npm uses here are understood — `^x.y.z`, `~x.y.z`, `>=x.y.z`, `=x.y.z`, or
 * an exact `x.y.z` — and everything else fails closed, because a compound or
 * prerelease range can admit a release below the floor while still carrying a
 * safe-looking prefix.
 */
function specifierFloor(specifier: string): string {
  const match = /^(?:\^|~|>=|=)?\s*(\d+\.\d+\.\d+)$/.exec(specifier.trim());
  assert.ok(
    match,
    `unsupported dependency specifier ${JSON.stringify(specifier)}: this guard understands only one stable `
      + "range (`^x.y.z`, `~x.y.z`, `>=x.y.z`, `=x.y.z`, or `x.y.z`), because compound and prerelease ranges can "
      + "still admit a release below the baseline floor",
  );
  return match[1];
}

/** npm's own semver, so ranges are evaluated with npm's default resolution semantics. */
interface Semver {
  validRange(range: string): string | null;
  satisfies(version: string, range: string): boolean;
}

const requireFromHere = createRequire(__filename);

function npmSemver(): Semver {
  const candidates: string[] = [];
  const execDirs = new Set([path.dirname(process.execPath)]);
  try {
    execDirs.add(path.dirname(fs.realpathSync(process.execPath)));
  } catch {
    /* keep the literal path */
  }
  for (const dir of execDirs) {
    candidates.push(path.join(dir, "..", "lib", "node_modules", "npm", "node_modules", "semver"));
    candidates.push(path.join(dir, "node_modules", "npm", "node_modules", "semver"));
  }
  const { findNpmCli } = requireFromHere(path.join(projectRoot(), "scripts", "application-build.cjs")) as {
    findNpmCli(env: NodeJS.ProcessEnv): string | undefined;
  };
  const npmCli = findNpmCli(process.env);
  if (npmCli) candidates.push(path.join(path.dirname(path.dirname(npmCli)), "node_modules", "semver"));
  const found = candidates.find((candidate) => fs.existsSync(path.join(candidate, "package.json")));
  assert.ok(found, `npm's bundled semver was not found for ${process.execPath}`);
  return requireFromHere(found) as Semver;
}

/**
 * The range a specifier actually constrains, plus the package name it names. An
 * aliased specifier (`npm:@scope/pkg@1.2.3`) constrains the alias target, not the
 * local alias name, so the target range is what the locked version must satisfy.
 */
function constrainedRange(specifier: string): { packageName: string; range: string } {
  const alias = /^npm:((?:@[^/]+\/)?[^@]+)@(.+)$/.exec(specifier);
  if (alias) return { packageName: alias[1], range: alias[2] };
  return { packageName: "", range: specifier };
}

test("the committed lock keeps every baseline package at or above its selected release", () => {
  const lock = readLock();
  for (const { name, floor } of BASELINE_FLOORS) {
    const entries = lockEntriesFor(lock, name);
    assert.ok(
      entries.length > 0,
      `${name} is part of the dependency baseline but the committed lock resolves it nowhere; `
        + "keep the resolution or drop the package from this baseline table",
    );
    for (const { where, version } of entries) {
      assert.ok(
        compareVersions(version, floor) >= 0,
        `${where} resolves ${name} ${version}, below the baseline ${floor}; refresh the locked resolution `
          + "instead of lowering the floor",
      );
    }
  }
});

test("the direct baseline dependency range cannot be satisfied by an older copy", () => {
  const manifest = readManifest();
  const specifier = manifest.dependencies?.[DIRECT_BASELINE_PACKAGE];
  assert.equal(
    typeof specifier,
    "string",
    `${DIRECT_BASELINE_PACKAGE} must stay a direct dependency so its baseline floor is declared`,
  );
  assert.ok(
    compareVersions(specifierFloor(specifier as string), DIRECT_BASELINE_FLOOR) >= 0,
    `${DIRECT_BASELINE_PACKAGE} is declared as ${specifier}, whose floor is below the baseline `
      + `${DIRECT_BASELINE_FLOOR} and so still admits older releases`,
  );
});

test("the root lock mirrors the manifest dependency sets", () => {
  const manifest = readManifest();
  const lockRoot = readLock().packages?.[""];
  assert.ok(lockRoot, "the committed lock must carry the root package entry");
  const lockRootEntry = lockRoot as unknown as {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
    optionalDependencies?: Record<string, string>;
  };
  for (const key of ["dependencies", "devDependencies", "optionalDependencies"] as const) {
    const declared = { ...(manifest[key] ?? {}) };
    const locked = { ...(lockRootEntry[key] ?? {}) };
    assert.deepEqual(
      Object.keys(locked).sort(),
      Object.keys(declared).sort(),
      `the lock's root ${key} must name exactly the packages package.json declares`,
    );
    for (const [name, specifier] of Object.entries(declared)) {
      assert.equal(
        locked[name],
        specifier,
        `the lock's root ${key} keeps ${name} at ${locked[name]} while package.json declares ${specifier}`,
      );
    }
  }
});

test("every declared dependency resolves at the lock root inside its own range", () => {
  const semver = npmSemver();
  const manifest = readManifest();
  const lock = readLock();
  for (const key of ["dependencies", "devDependencies", "optionalDependencies"] as const) {
    for (const [name, specifier] of Object.entries(manifest[key] ?? {})) {
      const entry = lock.packages?.[`node_modules/${name}`];
      assert.ok(entry, `node_modules/${name} must be resolved in the committed lock for the ${key} entry`);
      const { packageName, range } = constrainedRange(specifier);
      assert.ok(
        semver.validRange(range) !== null,
        `${name} declares a range npm cannot evaluate: ${specifier}`,
      );
      if (packageName) {
        assert.equal(
          entry.name,
          packageName,
          `${name} is an alias for ${packageName}, so the locked copy must be that package`,
        );
      }
      assert.ok(
        semver.satisfies(entry.version as string, range),
        `node_modules/${name} resolves ${entry.version}, outside the declared range ${specifier}`,
      );
    }
  }
});
