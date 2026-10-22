/**
 * Issue 489: the package engines range expresses the per-release-line Node
 * security minimums (Node 22 >=22.23.4, Node 24 >=24.22.1, Node 26 >=26.12.1)
 * without dropping other majors above 22. The range is evaluated with npm's own
 * bundled semver (the implementation npm uses for `engines`), not by string
 * comparison, and judged against the literal shared expectation table that the
 * launcher, POSIX entry point, and Main regressions also use.
 */
import assert from "node:assert/strict";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import test from "node:test";
import { NODE_SECURITY_FLOOR_CASES } from "./helpers/node-security-floor";

const ENGINES_RANGE = ">=22.23.4 <24.0.0 || >=24.22.1 <26.0.0 || >=26.12.1";

interface Semver {
  validRange(range: string): string | null;
  satisfies(version: string, range: string): boolean;
}

const requireFromHere = createRequire(__filename);

/** npm's bundled semver for the running Node distribution (or the PATH npm). */
function npmSemver(): Semver {
  const execDirs = new Set([dirname(process.execPath)]);
  try { execDirs.add(dirname(realpathSync(process.execPath))); } catch { /* keep the literal path */ }
  const candidates: string[] = [];
  for (const dir of execDirs) {
    candidates.push(join(dir, "..", "lib", "node_modules", "npm", "node_modules", "semver"));
    candidates.push(join(dir, "node_modules", "npm", "node_modules", "semver"));
  }
  const { findNpmCli } = requireFromHere(join(process.cwd(), "scripts", "application-build.cjs")) as {
    findNpmCli(env: NodeJS.ProcessEnv): string | undefined;
  };
  const npmCli = findNpmCli(process.env);
  if (npmCli) candidates.push(join(dirname(dirname(npmCli)), "node_modules", "semver"));
  const found = candidates.find((candidate) => existsSync(join(candidate, "package.json")));
  assert.ok(found, `npm's bundled semver was not found for ${process.execPath}`);
  return requireFromHere(found) as Semver;
}

test("package and root lock engines declare the exact per-line security range", () => {
  const pkg = JSON.parse(readFileSync(join(process.cwd(), "package.json"), "utf8")) as { engines?: { node?: string } };
  assert.equal(pkg.engines?.node, ENGINES_RANGE);
  const lock = JSON.parse(readFileSync(join(process.cwd(), "package-lock.json"), "utf8")) as {
    packages?: Record<string, { engines?: { node?: string } }>;
  };
  assert.equal(lock.packages?.[""]?.engines?.node, ENGINES_RANGE, "the lock's root package mirrors the engines range");
});

test("npm semver evaluates the engines range per release line and keeps other majors", () => {
  const semver = npmSemver();
  assert.ok(semver.validRange(ENGINES_RANGE), "the engines range is a valid npm semver range");
  for (const entry of NODE_SECURITY_FLOOR_CASES) {
    if (entry.version.includes("-")) {
      // npm's engines evaluation never admits prereleases without an explicit
      // prerelease comparator; the launchers keep their own prerelease policy.
      assert.equal(semver.satisfies(entry.version, ENGINES_RANGE), false, `${entry.version}: prerelease outside engines`);
      continue;
    }
    assert.equal(semver.satisfies(entry.version, ENGINES_RANGE), entry.main, `${entry.version}: ${entry.why}`);
  }
  // A single global floor would still admit unpatched 24.x/26.x; the actual
  // range must not.
  assert.equal(semver.satisfies("24.0.0", ">=22.23.4"), true, "control: a single floor admits unpatched Node 24");
  assert.equal(semver.satisfies("24.0.0", ENGINES_RANGE), false);
  assert.equal(semver.satisfies("26.11.9", ENGINES_RANGE), false);
});
