// Shared application preparation authority (issue 344): one current/update
// decision used by every launcher.
//
// This file encodes the CURRENT contract and deliberately replaces the retired
// pre-#344 expectations (rebuild on every launch, whole-artifact re-hashing,
// npm/toolchain content fingerprints, per-launch DDGS validation):
//   * a warm start reads bounded markers and stats only the paths those markers
//     name — no install, compile, staging, inventory, Python probe, skill copy,
//     or cleanup happens;
//   * a genuine miss is prepared automatically in an isolated, inactive
//     generation under a single producer, published atomically, and reused by
//     every launcher and consumer afterwards;
//   * exact full prerelease versions identify packaged installs, so prebuilt
//     consumers never compile;
//   * development checkouts track a bounded application-input index, so real
//     edits/additions/deletions invalidate but touch-only or irrelevant changes
//     do not;
//   * live consumers hold leases so an update's cleanup preserves running code.
//
// Fixtures are synthetic package trees under the git-ignored node_modules tree
// and are retained (never recursively cleaned).

import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { join } from "node:path";
import {
  chmodSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";

import test from "node:test";

const requireCjs = createRequire(join(process.cwd(), "tests", "prepare-application.test.ts"));

interface ApplicationStatus {
  current: boolean;
  mode: string;
  reason?: string;
  preparedRoot?: string;
  reusedPreparedRoot?: boolean;
  marker?: Record<string, unknown>;
}

interface PrepareResult {
  mode: "current" | "prepared" | "failed";
  preparedRoot?: string;
  applicationMode?: string;
  stateRoot?: string;
  status?: number;
  stage?: string;
  lease?: { release(): void } | undefined;
}

interface PrepareModule {
  APPLICATION_SCHEMA: number;
  SKILL_PUBLISH_PLAN: { name: string; label: string; files: { source: string[]; destination: string[] }[] }[];
  applicationStateRoot(agentDir: string): string;
  buildCacheRoot(agentDir: string): string;
  applicationStatus(options: Record<string, unknown>): ApplicationStatus;
  computeInputIdentity(packageRoot: string): { digest: string; files: { path: string }[]; directories: { path: string }[] };
  prepareApplication(options: Record<string, unknown>): Promise<PrepareResult>;
  prepareLaunch(options: Record<string, unknown>): Promise<PrepareResult & { extension?: string; ddgsPython?: string }>;
  attachConsumer(options: Record<string, unknown>): { release(): void } | undefined;
  leasedRoots(stateRoot: string): { roots: Set<string>; complete: boolean };
  isPreparedGenerationRoot(packageRoot: string): boolean;
  applicationModeOf(packageRoot: string): string;
  ensureDdgsReady(options: Record<string, unknown>): Promise<{ ok: boolean; python?: string; provisioned?: boolean; recorded?: boolean; exitCode?: number }>;
  ensureShippedSkills(options: Record<string, unknown>): { ok: boolean; published?: boolean; skills?: { label: string; path: string }[]; error?: string };
  ddgsVenvPath(homeDir: string, env: NodeJS.ProcessEnv, platform?: string): string;
  __test: {
    cleanupPreparedGenerations(options: Record<string, unknown>): string[];
    acquireLockFile(file: string, options?: Record<string, unknown>): Promise<{ release(): void } | null>;
    applicationStatusReadCount(): number;
    resetApplicationStatusReads(): void;
    readGenerationReceipt(preparedRoot: string): Record<string, unknown> | null;
    pythonInterpreters(platform: string): { file: string; prefixArgs: string[] }[];
    writeGenerationReceipt(preparedRoot: string, options: { packageVersion: string; sourceDigest: string }): void;
  };
}

const prepare = requireCjs("../scripts/prepare-application.cjs") as PrepareModule;
const applicationBuild = requireCjs("../scripts/application-build.cjs") as {
  REQUIRED_COMPILED_ENTRIES: string[][];
  createOwnedStage(parent: string, prefix: string): { root: string };
};

const FIXTURE_PARENT = join(process.cwd(), "node_modules", ".prepare-application-fixtures");
mkdirSync(FIXTURE_PARENT, { recursive: true });

let fixtureCounter = 0;
function makeFixture(prefix: string): string {
  fixtureCounter += 1;
  const root = join(FIXTURE_PARENT, `${prefix}-${process.pid}-${fixtureCounter}-${Date.now()}`);
  mkdirSync(root, { recursive: true });
  return root;
}

function writeRequiredOutputs(preparedRoot: string): void {
  for (const entry of applicationBuild.REQUIRED_COMPILED_ENTRIES) {
    const target = join(preparedRoot, ...entry);
    mkdirSync(join(target, ".."), { recursive: true });
    writeFileSync(target, "module.exports = {};\n", "utf8");
  }
}

/**
 * A fake npm that the shared resolver accepts exactly as it accepts a real
 * installation: PATH's `npm` resolves into a package whose manifest is npm's
 * own JS CLI. The CLI then stages a synthetic TypeScript package and records
 * every invocation.
 */
function writeFakeNpm(binDir: string, callsFile: string): void {
  const packageDir = join(binDir, "node_modules", "npm");
  mkdirSync(join(packageDir, "bin"), { recursive: true });
  writeFileSync(
    join(packageDir, "package.json"),
    `${JSON.stringify({ name: "npm", version: "10.0.0", bin: { npm: "bin/npm-cli.js" } })}\n`,
    "utf8",
  );
  writeFileSync(join(packageDir, "bin", "npm-cli.js"), [
    "#!/usr/bin/env node",
    "const fs = require('node:fs');",
    "const path = require('node:path');",
    `fs.appendFileSync(${JSON.stringify(callsFile)}, process.argv.slice(2).join(' ') + '\\n');`,
    "fs.mkdirSync('node_modules/typescript/bin', { recursive: true });",
    "fs.writeFileSync('node_modules/typescript/package.json', JSON.stringify({ name: 'typescript', version: '5.7.2', bin: { tsc: 'bin/tsc' } }));",
    "fs.writeFileSync('node_modules/typescript/bin/tsc', [",
    "  '#!/usr/bin/env node',",
    "  \"const fs = require('node:fs');\",",
    "  \"for (const entry of ['dist/src/index.js','dist/src/session-host/main.js','dist/src/web/cli.js']) {\",",
    "  \"  fs.mkdirSync(require('node:path').dirname(entry), { recursive: true });\",",
    "  \"  fs.writeFileSync(entry, 'module.exports = {};');\",",
    "  \"}\",",
    "].join('\\n'));",
    "process.exit(0);",
  ].join("\n"), "utf8");
  symlinkSync(join("node_modules", "npm", "bin", "npm-cli.js"), join(binDir, "npm"));
}

/** One installed DDGS distribution (package + distribution metadata). */
function writeDdgsDistribution(venv: string): void {
  const sitePackages = join(venv, "lib", "python3.14", "site-packages");
  mkdirSync(join(sitePackages, "ddgs"), { recursive: true });
  mkdirSync(join(sitePackages, "ddgs-9.16.0.dist-info"), { recursive: true });
  writeFileSync(join(sitePackages, "ddgs-9.16.0.dist-info", "METADATA"), "Name: ddgs\nVersion: 9.16.0\n", "utf8");
}

function writeExecutable(file: string, content: string): void {
  writeFileSync(file, content, "utf8");
  chmodSync(file, 0o755);
}

interface SourcePackageFixture {
  root: string;
  agentDir: string;
  prepareCalls: number;
  createStage(agentDir: string): { ok: true; root: string } | { ok: false; status: number };
}

/** A minimal but complete development checkout: exactly the application inputs. */
function makeSourcePackage(prefix: string, createStage?: (agentDir: string, root: string) => { ok: true; root: string } | { ok: false; status: number }): SourcePackageFixture {
  const root = makeFixture(prefix);
  writeFileSync(join(root, "package.json"), `${JSON.stringify({ name: "pi-review-gate", version: "0.1.0" }, null, 2)}\n`, "utf8");
  writeFileSync(join(root, "package-lock.json"), "{}\n", "utf8");
  writeFileSync(join(root, "tsconfig.json"), "{}\n", "utf8");
  mkdirSync(join(root, "src"), { recursive: true });
  mkdirSync(join(root, "scripts"), { recursive: true });
  for (const skill of prepare.SKILL_PUBLISH_PLAN) {
    for (const file of skill.files) {
      const source = join(root, ...file.source);
      mkdirSync(join(source, ".."), { recursive: true });
      writeFileSync(source, `---\nname: ${skill.name}\n---\n`, "utf8");
    }
  }
  writeFileSync(join(root, "src", "index.ts"), "export const value = 1;\n", "utf8");
  writeFileSync(join(root, "scripts", "tool.cjs"), "module.exports = 1;\n", "utf8");
  writeFileSync(join(root, "scripts", "helper.cjs"), "module.exports = 1;\n", "utf8");

  const defaultStage = (agentDir: string): { ok: true; root: string } => {
    const cacheRoot = prepare.buildCacheRoot(agentDir);
    mkdirSync(cacheRoot, { recursive: true });
    const stage = applicationBuild.createOwnedStage(cacheRoot, "pi-review-gate-app-");
    writeRequiredOutputs(stage.root);
    // A real generation is a copy of the package inputs, including the manifest,
    // src/, scripts/, and the shipped skills; the synthetic seam mirrors that.
    writeFileSync(join(stage.root, "package.json"), readFileSync(join(root, "package.json")));
    for (const directory of ["src", "scripts", "skills"]) {
      cpSync(join(root, directory), join(stage.root, directory), { recursive: true });
    }
    return { ok: true, root: stage.root };
  };
  return {
    root,
    agentDir: join(root, "agent"),
    prepareCalls: 0,
    createStage: (agentDir: string) => (createStage ? createStage(agentDir, root) : defaultStage(agentDir)),
  };
}

function prepareWith(fixture: SourcePackageFixture): Promise<PrepareResult> {
  return prepare.prepareApplication({
    packageRoot: fixture.root,
    agentDir: fixture.agentDir,
    env: process.env,
    prepare: async (context: { agentDir: string }) => {
      fixture.prepareCalls += 1;
      const result = fixture.createStage(context.agentDir);
      return result.ok ? { ok: true, status: 0, root: result.root } : { ok: false, status: result.status, stage: "install" };
    },
  });
}

function markerPath(agentDir: string): string {
  return join(prepare.applicationStateRoot(agentDir), "current.json");
}

test("a prepared development checkout is current on the next start without any child process", async () => {
  const fixture = makeSourcePackage("dev-current");
  const first = await prepareWith(fixture);
  assert.equal(first.mode, "prepared");
  assert.equal(fixture.prepareCalls, 1);
  const marker = JSON.parse(readFileSync(markerPath(fixture.agentDir), "utf8"));
  assert.equal(marker.schema, prepare.APPLICATION_SCHEMA);
  assert.equal(marker.mode, "development");
  assert.equal(marker.preparedRoot, first.preparedRoot);
  assert.ok(marker.sourceIndex.files.some((file: { path: string }) => file.path === "src/index.ts"));
  assert.ok(marker.sourceIndex.directories.some((directory: { path: string }) => directory.path === "src"));

  const startedAt = Date.now();
  const second = await prepareWith(fixture);
  const elapsed = Date.now() - startedAt;
  assert.equal(second.mode, "current");
  assert.equal(second.preparedRoot, first.preparedRoot);
  assert.equal(fixture.prepareCalls, 1, "a current start must not prepare anything again");
  assert.ok(elapsed < 500, `current decision took ${elapsed}ms`);

  const status = prepare.applicationStatus({ packageRoot: fixture.root, agentDir: fixture.agentDir });
  assert.equal(status.current, true);
  assert.equal(status.reusedPreparedRoot, false);
});

test("a real edit, addition, or deletion of an application input triggers exactly one update", async () => {
  const fixture = makeSourcePackage("dev-invalidate");
  const first = await prepareWith(fixture);

  writeFileSync(join(fixture.root, "src", "index.ts"), "export const value = 2;\n", "utf8");
  const afterEdit = await prepareWith(fixture);
  assert.equal(afterEdit.mode, "prepared");
  assert.notEqual(afterEdit.preparedRoot, first.preparedRoot);
  assert.equal(fixture.prepareCalls, 2, "an edited input triggers exactly one preparation");
  assert.equal((await prepareWith(fixture)).mode, "current");

  writeFileSync(join(fixture.root, "src", "added.ts"), "export const added = true;\n", "utf8");
  assert.equal((await prepareWith(fixture)).mode, "prepared", "a new file must invalidate");
  assert.equal(fixture.prepareCalls, 3);
  assert.equal((await prepareWith(fixture)).mode, "current");

  rmSync(join(fixture.root, "src", "added.ts"));
  assert.equal((await prepareWith(fixture)).mode, "prepared", "a deleted file must invalidate");
  assert.equal(fixture.prepareCalls, 4);

  // Every staged input tree participates, not only src/.
  writeFileSync(join(fixture.root, "skills", "pi-review-gate-execution", "SKILL.md"), "---\nname: y\n---\n", "utf8");
  assert.equal((await prepareWith(fixture)).mode, "prepared", "a shipped-skill edit must invalidate");
  writeFileSync(join(fixture.root, "tsconfig.json"), "{ \"compilerOptions\": {} }\n", "utf8");
  assert.equal((await prepareWith(fixture)).mode, "prepared", "a manifest edit must invalidate");
  assert.equal((await prepareWith(fixture)).mode, "current");
});

test("touch-only and irrelevant changes never force preparation", async () => {
  const fixture = makeSourcePackage("dev-touch");
  const first = await prepareWith(fixture);
  const target = join(fixture.root, "src", "index.ts");
  const now = new Date();
  utimesSync(target, now, new Date(now.getTime() + 5_000));
  const touched = await prepareWith(fixture);
  assert.equal(touched.mode, "current");
  assert.equal(touched.preparedRoot, first.preparedRoot);
  assert.equal(fixture.prepareCalls, 1);

  // Irrelevant paths are outside the bounded application inputs: no inventory,
  // no invalidation. node_modules/dist/.git/docs/tests/private notes and
  // unrelated nested paths are never scanned.
  for (const relative of ["node_modules", "dist", ".git", "docs", "tests", "notes", "infra/cache"]) {
    mkdirSync(join(fixture.root, relative), { recursive: true });
    writeFileSync(join(fixture.root, relative, "irrelevant.txt"), "irrelevant\n", "utf8");
  }
  assert.equal((await prepareWith(fixture)).mode, "current");
  assert.equal(fixture.prepareCalls, 1);
  const identity = prepare.computeInputIdentity(fixture.root);
  assert.equal(identity.files.some((file) => file.path.includes("irrelevant")), false);
  assert.equal(identity.directories.some((directory) => directory.path.includes("infra")), false);
});

test("a source tree containing a symlink is refused instead of being fingerprinted", () => {
  const fixture = makeSourcePackage("dev-symlink");
  symlinkSync(join(fixture.root, "src", "index.ts"), join(fixture.root, "src", "alias.ts"));
  assert.throws(() => prepare.computeInputIdentity(fixture.root), /symlink/u);
});

test("packaged installs compare the full exact prerelease version and never compile", async () => {
  const root = makeFixture("packaged-version");
  const agentDir = join(root, "agent");
  const writePackage = (version: string): void => {
    writeFileSync(join(root, "package.json"), `${JSON.stringify({ name: "pi-review-gate", version })}\n`, "utf8");
  };
  writePackage("0.1.0-dev.180");
  writeRequiredOutputs(root);
  const calls: string[] = [];
  const run = (): Promise<PrepareResult> => prepare.prepareApplication({
    packageRoot: root,
    agentDir,
    env: process.env,
    prepare: async () => {
      calls.push("prepare");
      return { ok: true, status: 0, root };
    },
  });

  assert.equal((await run()).mode, "prepared");
  assert.equal((await run()).mode, "current", "an installed package with the exact version is current");
  assert.deepEqual(calls, ["prepare"], "prebuilt consumers never compile");

  writePackage("0.1.0-dev.1801");
  assert.equal((await run()).mode, "prepared", "a different full prerelease identity is not current");
  writePackage("0.1.0-dev.180");
  assert.equal((await run()).mode, "prepared", "the version change is compared, not prefix-matched");
  assert.equal((await run()).mode, "current");
});

test("malformed, oversized, symlinked, or escaping markers are misses", async () => {
  const fixture = makeSourcePackage("marker-shapes");
  const first = await prepareWith(fixture);
  const stateRoot = prepare.applicationStateRoot(fixture.agentDir);
  const marker = markerPath(fixture.agentDir);

  for (const raw of ["", "{", "null", "[]", JSON.stringify({ schema: 999 }), JSON.stringify({ schema: prepare.APPLICATION_SCHEMA })]) {
    writeFileSync(marker, raw, "utf8");
    assert.equal(prepare.applicationStatus({ packageRoot: fixture.root, agentDir: fixture.agentDir }).current, false, `marker ${raw.slice(0, 12)} must be a miss`);
  }
  writeFileSync(marker, "x".repeat(70 * 1024), "utf8");
  assert.equal(prepare.applicationStatus({ packageRoot: fixture.root, agentDir: fixture.agentDir }).current, false, "an oversized marker must be a miss");

  // A prepared root outside the managed build cache is never selected.
  const outside = makeFixture("marker-outside");
  writeRequiredOutputs(outside);
  const identityOf = (target: string) => {
    const stats = lstatSync(target, { bigint: true });
    return { dev: stats.dev.toString(), ino: stats.ino.toString(), mode: Number(stats.mode & 0o777n).toString() };
  };
  const valid = {
    schema: prepare.APPLICATION_SCHEMA,
    mode: "development",
    compat: { platform: process.platform, arch: process.arch, abi: process.versions.modules },
    packageVersion: "0.1.0",
    preparedRoot: outside,
    preparedRootIdentity: identityOf(outside),
    buildCacheRoot: prepare.buildCacheRoot(fixture.agentDir),
    sourceDigest: prepare.computeInputIdentity(fixture.root).digest,
    sourceIndex: { files: [], directories: [] },
  };
  writeFileSync(marker, JSON.stringify(valid), "utf8");
  assert.equal(prepare.applicationStatus({ packageRoot: fixture.root, agentDir: fixture.agentDir }).current, false, "a root outside the cache must be refused");

  // A missing compiled output is a miss even with a matching marker.
  valid.preparedRoot = first.preparedRoot as string;
  valid.preparedRootIdentity = identityOf(first.preparedRoot as string);
  writeFileSync(marker, JSON.stringify(valid), "utf8");
  assert.equal(prepare.applicationStatus({ packageRoot: fixture.root, agentDir: fixture.agentDir }).current, true);
  rmSync(join(first.preparedRoot as string, "dist", "src", "web", "cli.js"));
  assert.equal(prepare.applicationStatus({ packageRoot: fixture.root, agentDir: fixture.agentDir }).current, false, "a missing compiled output must be a miss");

  // A symlinked marker is never followed.
  rmSync(marker);
  const target = join(stateRoot, "marker-target.json");
  writeFileSync(target, JSON.stringify(valid), "utf8");
  symlinkSync(target, marker);
  assert.equal(prepare.applicationStatus({ packageRoot: fixture.root, agentDir: fixture.agentDir }).current, false, "a symlinked marker must be a miss");
});

test("failed and racing preparations never publish current state", async () => {
  const failing = makeSourcePackage("prepare-failure", () => ({ ok: false, status: 3 }));
  const failed = await prepareWith(failing);
  assert.equal(failed.mode, "failed");
  assert.equal(failed.status, 3);
  assert.equal(existsSync(markerPath(failing.agentDir)), false);

  // A source change during preparation refuses the result: the published marker
  // must describe coherent inputs only.
  const raced = makeSourcePackage("prepare-race", (agentDir, root) => {
    const cacheRoot = prepare.buildCacheRoot(agentDir);
    mkdirSync(cacheRoot, { recursive: true });
    const stage = applicationBuild.createOwnedStage(cacheRoot, "pi-review-gate-app-");
    writeRequiredOutputs(stage.root);
    writeFileSync(join(root, "src", "index.ts"), "export const raced = true;\n", "utf8");
    return { ok: true, root: stage.root };
  });
  const racedResult = await prepareWith(raced);
  assert.equal(racedResult.mode, "failed");
  assert.equal(existsSync(markerPath(raced.agentDir)), false);
});

test("concurrent callers run one producer and adopt its completed state", async () => {
  const fixture = makeSourcePackage("prepare-concurrent");
  let release: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let prepareCalls = 0;
  const options = {
    packageRoot: fixture.root,
    agentDir: fixture.agentDir,
    env: process.env,
    lockWaitMs: 30_000,
    prepare: async ({ agentDir }: { agentDir: string }) => {
      prepareCalls += 1;
      await gate;
      const cacheRoot = prepare.buildCacheRoot(agentDir);
      mkdirSync(cacheRoot, { recursive: true });
      const stage = applicationBuild.createOwnedStage(cacheRoot, "pi-review-gate-app-");
      writeRequiredOutputs(stage.root);
      return { ok: true, status: 0, root: stage.root };
    },
  };
  const firstRun = prepare.prepareApplication(options);
  // Let the first producer take the lock before the second caller arrives.
  await new Promise((resolve) => setTimeout(resolve, 100));
  const secondRun = prepare.prepareApplication(options);
  await new Promise((resolve) => setTimeout(resolve, 150));
  release?.();
  const [first, second] = await Promise.all([firstRun, secondRun]);
  assert.equal(prepareCalls, 1, "a concurrent launcher must not duplicate the same update");
  assert.equal(first.mode, "prepared");
  assert.equal(second.mode, "current");
  assert.equal(second.preparedRoot, first.preparedRoot);
});

test("a live consumer's lease protects its prepared generation from update cleanup", () => {
  const fixture = makeSourcePackage("lease-protection");
  const stateRoot = prepare.applicationStateRoot(fixture.agentDir);
  const cacheRoot = prepare.buildCacheRoot(fixture.agentDir);
  mkdirSync(cacheRoot, { recursive: true });
  // Deterministic lexicographic generation names: cleanup reclaims the oldest
  // candidates first, so the protected/unprotected difference is observable.
  const generations: string[] = [];
  for (let index = 0; index < 10; index += 1) {
    const stage = join(cacheRoot, `pi-review-gate-app-${String(index).padStart(4, "0")}`);
    mkdirSync(stage, { recursive: true });
    writeRequiredOutputs(stage);
    generations.push(stage);
  }
  const leasedRoot = generations[0];
  const keepRoot = generations[9];
  const lease = prepare.attachConsumer({ stateRoot, agentDir: fixture.agentDir, preparedRoot: leasedRoot });
  assert.ok(lease, "a consumer lease is published before the prepared root is used");
  const leased = prepare.leasedRoots(stateRoot);
  assert.ok(leased.roots.has(leasedRoot));
  assert.equal(leased.complete, true);
  prepare.__test.cleanupPreparedGenerations({
    agentDir: fixture.agentDir,
    keep: [keepRoot],
    preserve: (root: string) => leased.roots.has(root),
  });
  assert.equal(existsSync(leasedRoot), true, "a running consumer's generation must survive cleanup");
  assert.equal(existsSync(generations[1]), false, "excess unleased generations are still reclaimed");

  lease?.release();
  assert.equal(prepare.leasedRoots(stateRoot).roots.size, 0, "releasing the lease ends the protection");
  // New work arrives after the consumer settled: the now-unleased generation is
  // an ordinary reclaimable candidate again.
  for (let index = 10; index < 13; index += 1) {
    const stage = join(cacheRoot, `pi-review-gate-app-${String(index).padStart(4, "0")}`);
    mkdirSync(stage, { recursive: true });
    writeRequiredOutputs(stage);
  }
  prepare.__test.cleanupPreparedGenerations({ agentDir: fixture.agentDir, keep: [join(cacheRoot, "pi-review-gate-app-0012")] });
  assert.equal(existsSync(leasedRoot), false, "an unleased generation is reclaimed by the next preparation");
});

test("DDGS readiness is marker-gated: validation runs only when the environment is missing or outdated", async () => {
  const root = makeFixture("ddgs-marker");
  const agentDir = join(root, "agent");
  const homeDir = join(root, "home");
  mkdirSync(homeDir, { recursive: true });
  const environment: NodeJS.ProcessEnv = { ...process.env };
  delete environment.PI_REVIEW_GATE_DDGS_VENV;
  delete environment.XDG_CACHE_HOME;
  const venv = prepare.ddgsVenvPath(homeDir, environment);
  mkdirSync(join(venv, "bin"), { recursive: true });
  const python = join(venv, "bin", "python");
  writeExecutable(python, "#!/bin/sh\nexit 0\n");
  writeDdgsDistribution(venv);
  const stateRoot = prepare.applicationStateRoot(agentDir);
  let provisions = 0;
  const provision = async () => {
    provisions += 1;
    return { ok: true, python };
  };
  const options = { stateRoot, agentDir, homeDir, env: environment, provision };

  assert.equal((await prepare.ensureDdgsReady(options)).ok, true);
  assert.equal(provisions, 1);
  const warm = await prepare.ensureDdgsReady(options);
  assert.equal(warm.provisioned, false, "a completed environment is reused without starting Python");
  assert.equal(provisions, 1);

  // A replaced interpreter path invalidates the marker.
  rmSync(python);
  writeExecutable(python, "#!/bin/sh\nexit 0\n");
  await prepare.ensureDdgsReady(options);
  assert.equal(provisions, 2);

  // An explicit venv selection must be the one that is ready.
  const otherVenv = join(root, "other-venv");
  mkdirSync(join(otherVenv, "bin"), { recursive: true });
  writeExecutable(join(otherVenv, "bin", "python"), "#!/bin/sh\nexit 0\n");
  writeDdgsDistribution(otherVenv);
  await prepare.ensureDdgsReady({ ...options, env: { ...environment, PI_REVIEW_GATE_DDGS_VENV: otherVenv } });
  assert.equal(provisions, 3);

  // A provisioned interpreter may legitimately be a virtual-environment symlink.
  const linkVenv = join(root, "link-venv");
  mkdirSync(join(linkVenv, "bin"), { recursive: true });
  const base = join(root, "base-python");
  writeExecutable(base, "#!/bin/sh\nexit 0\n");
  symlinkSync(base, join(linkVenv, "bin", "python"));
  writeDdgsDistribution(linkVenv);
  let linkProvisions = 0;
  const linkOptions = {
    stateRoot,
    agentDir,
    homeDir,
    env: { ...environment, PI_REVIEW_GATE_DDGS_VENV: linkVenv },
    provision: async () => {
      linkProvisions += 1;
      return { ok: true, python: join(linkVenv, "bin", "python") };
    },
  };
  assert.equal((await prepare.ensureDdgsReady(linkOptions)).ok, true);
  assert.equal((await prepare.ensureDdgsReady(linkOptions)).provisioned, false);
  assert.equal(linkProvisions, 1);
});

test("shipped-skill readiness publishes once, republishes on change, and fails closed on a missing source", () => {
  const root = makeFixture("skills-marker");
  const packageRoot = join(root, "package");
  const homeDir = join(root, "home");
  const agentDir = join(root, "agent");
  mkdirSync(homeDir, { recursive: true });
  for (const skill of prepare.SKILL_PUBLISH_PLAN) {
    for (const file of skill.files) {
      const source = join(packageRoot, ...file.source);
      mkdirSync(join(source, ".."), { recursive: true });
      writeFileSync(source, `---\nname: ${skill.name}\n---\n`, "utf8");
    }
  }
  const options = {
    stateRoot: prepare.applicationStateRoot(agentDir),
    agentDir,
    packageRoot,
    homeDir,
    applicationIdentity: "source:aaaa",
  };
  const first = prepare.ensureShippedSkills(options);
  assert.equal(first.ok, true);
  assert.equal(first.published, true);
  const warm = prepare.ensureShippedSkills(options);
  assert.equal(warm.published, false, "a current component performs no copy or comparison");

  const changed = prepare.ensureShippedSkills({ ...options, applicationIdentity: "source:bbbb" });
  assert.equal(changed.published, true, "a new application identity republishes the shipped skills");

  const installed = join(homeDir, ".agents", "skills", "pi-review-gate-orchestrator", "SKILL.md");
  writeFileSync(installed, "user modified\n", "utf8");
  const repaired = prepare.ensureShippedSkills({ ...options, applicationIdentity: "source:bbbb" });
  assert.equal(repaired.published, true, "a modified installed skill is refreshed");
  assert.match(readFileSync(installed, "utf8"), /pi-review-gate-orchestrator/u);

  rmSync(join(packageRoot, "skills", "pi-review-gate-research", "SKILL.md"));
  const missing = prepare.ensureShippedSkills(options);
  assert.equal(missing.ok, false);
  assert.match(String(missing.error), /packaged skill file is missing/u);
});

test("the shared CLI reports prepared state, then current state, with zero child processes on the warm path", () => {
  const root = makeFixture("cli-packaged");
  const homeDir = join(root, "home");
  const agentDir = join(root, "agent");
  const bin = join(root, "bin");
  mkdirSync(homeDir, { recursive: true });
  mkdirSync(bin, { recursive: true });
  // A tripwire npm: any invocation on the warm path is recorded.
  const npmRecord = join(root, "npm-invoked");
  writeExecutable(join(bin, "npm"), `#!/bin/sh\nprintf invoked >> "${npmRecord}"\nexit 99\n`);
  writeFileSync(join(root, "package.json"), `${JSON.stringify({ name: "pi-review-gate", version: "0.1.0-dev.181" })}\n`, "utf8");
  writeRequiredOutputs(root);
  for (const skill of prepare.SKILL_PUBLISH_PLAN) {
    for (const file of skill.files) {
      const source = join(root, ...file.source);
      mkdirSync(join(source, ".."), { recursive: true });
      writeFileSync(source, `---\nname: ${skill.name}\n---\n`, "utf8");
    }
  }
  const venv = join(root, "ddgs-venv");
  mkdirSync(join(venv, "bin"), { recursive: true });
  writeExecutable(join(venv, "bin", "python"), "#!/bin/sh\nexit 0\n");

  const run = () => spawnSync(process.execPath, [
    "scripts/prepare-application.cjs",
    "--prepare",
    "--root", root,
    "--home", homeDir,
    "--agent-dir", agentDir,
  ], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH ?? ""}`,
      PI_REVIEW_GATE_DDGS_VENV: venv,
    },
    encoding: "utf8",
  });

  const first = run();
  assert.equal(first.status, 0, first.stderr);
  assert.match(first.stdout, /^mode\tprepared$/mu);
  const second = run();
  assert.equal(second.status, 0, second.stderr);
  assert.match(second.stdout, /^mode\tcurrent$/mu);
  assert.equal(existsSync(npmRecord), false, "a current start must not invoke npm");
});

test("a real update installs and compiles in an isolated generation, never in the live checkout", () => {
  const root = makeFixture("cli-source-update");
  const homeDir = join(root, "home");
  const agentDir = join(root, "agent");
  const bin = join(root, "bin");
  mkdirSync(homeDir, { recursive: true });
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(root, "package.json"), `${JSON.stringify({ name: "pi-review-gate", version: "0.1.0" })}\n`, "utf8");
  writeFileSync(join(root, "package-lock.json"), "{}\n", "utf8");
  writeFileSync(join(root, "tsconfig.json"), "{}\n", "utf8");
  for (const directory of ["src", "scripts", "skills"]) mkdirSync(join(root, directory), { recursive: true });
  writeFileSync(join(root, "src", "index.ts"), "export const value = 1;\n", "utf8");
  writeFileSync(join(root, "scripts", "tool.cjs"), "module.exports = 1;\n", "utf8");
  for (const skill of prepare.SKILL_PUBLISH_PLAN) {
    for (const file of skill.files) {
      const source = join(root, ...file.source);
      mkdirSync(join(source, ".."), { recursive: true });
      writeFileSync(source, `---\nname: ${skill.name}\n---\n`, "utf8");
    }
  }
  // Live dist is a sentinel: preparation must never write into it.
  const liveDist = join(root, "dist", "src");
  mkdirSync(liveDist, { recursive: true });
  writeFileSync(join(liveDist, "index.js"), "LIVE DIST SENTINEL\n", "utf8");

  // Fake npm: stage a TypeScript package in the staging root and record calls.
  const npmCalls = join(root, "npm-calls.txt");
  writeFakeNpm(bin, npmCalls);

  // DDGS provisioning would need a real venv; this test is about application
  // preparation, so give the marker path a ready interpreter.
  const venv = join(root, "ddgs-venv");
  mkdirSync(join(venv, "bin"), { recursive: true });
  writeExecutable(join(venv, "bin", "python"), "#!/bin/sh\nexit 0\n");

  const run = () => spawnSync(process.execPath, [
    "scripts/prepare-application.cjs",
    "--prepare",
    "--root", root,
    "--home", homeDir,
    "--agent-dir", agentDir,
  ], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH ?? ""}`,
      PI_REVIEW_GATE_DDGS_VENV: venv,
    },
    encoding: "utf8",
  });

  const first = run();
  assert.equal(first.status, 0, first.stderr);
  assert.match(first.stdout, /^mode\tprepared$/mu);
  const extensionLine = first.stdout.split("\n").find((line) => line.startsWith("extension\t"));
  assert.ok(extensionLine, "the CLI must report the prepared extension");
  const extension = extensionLine.slice("extension\t".length);
  assert.notEqual(extension, join(liveDist, "index.js"));
  assert.equal(existsSync(extension), true);
  assert.match(readFileSync(join(liveDist, "index.js"), "utf8"), /LIVE DIST SENTINEL/u);
  assert.equal(readFileSync(npmCalls, "utf8").trim().split("\n").length, 1, "one install per update");
  assert.match(readFileSync(npmCalls, "utf8"), /^ci --include=dev --ignore-scripts/u);

  const second = run();
  assert.equal(second.status, 0, second.stderr);
  assert.match(second.stdout, /^mode\tcurrent$/mu);
  assert.equal(readFileSync(npmCalls, "utf8").trim().split("\n").length, 1, "a current start performs no install");

  // Touch-only: no install. Real edit: exactly one more install.
  const now = new Date();
  utimesSync(join(root, "src", "index.ts"), now, new Date(now.getTime() + 5_000));
  assert.match(run().stdout, /^mode\tcurrent$/mu);
  assert.equal(readFileSync(npmCalls, "utf8").trim().split("\n").length, 1);
  writeFileSync(join(root, "src", "index.ts"), "export const value = 2;\n", "utf8");
  const updated = run();
  assert.equal(updated.status, 0, updated.stderr);
  assert.match(updated.stdout, /^mode\tprepared$/mu);
  assert.equal(readFileSync(npmCalls, "utf8").trim().split("\n").length, 2);
  // A chmod-only change is a real input change (staging preserves executable
  // bits), so it prepares a new generation and the staged copy keeps the bits.
  chmodSync(join(root, "scripts", "tool.cjs"), 0o755);
  const modeRun = run();
  assert.equal(modeRun.status, 0, modeRun.stderr);
  assert.match(modeRun.stdout, /^mode\tprepared$/mu);
  assert.equal(readFileSync(npmCalls, "utf8").trim().split("\n").length, 3);
  const modeRootLine = modeRun.stdout.split("\n").find((line) => line.startsWith("root\t"));
  assert.ok(modeRootLine, "the prepared root is reported");
  const modeRoot = modeRootLine.slice("root\t".length);
  assert.equal(lstatSync(join(modeRoot, "scripts", "tool.cjs")).mode & 0o111, 0o111,
    "the staged generation preserves the new executable bits");
  assert.match(run().stdout, /^mode\tcurrent$/mu);
  assert.equal(lstatSync(markerPath(agentDir)).isFile(), true);
});

test("launching from a completed prepared generation is never mistaken for the mutable checkout", async () => {
  const fixture = makeSourcePackage("generation-identity");
  const prepared = await prepareWith(fixture);
  assert.equal(prepared.mode, "prepared");
  const stage = prepared.preparedRoot as string;
  assert.equal(prepare.isPreparedGenerationRoot(stage), true);
  assert.equal(prepare.applicationModeOf(stage), "generation");
  // The generation contains a copy of src/, exactly like a real stage.
  assert.equal(existsSync(join(stage, "src", "index.ts")), true);

  const markerBefore = readFileSync(markerPath(fixture.agentDir), "utf8");
  let prepareCalls = 0;
  // Pi launched with the prepared extension, then the sidebar script executed
  // from that same prepared root, then the original checkout again: the
  // prepared roots are immutable installed code and must not re-prepare or
  // overwrite the checkout's freshness state.
  const run = (packageRoot: string) => prepare.prepareApplication({
    packageRoot,
    agentDir: fixture.agentDir,
    env: process.env,
    prepare: async () => {
      prepareCalls += 1;
      return { ok: false, status: 1, stage: "unexpected" };
    },
  });
  for (const packageRoot of [stage, stage]) {
    const result = await run(packageRoot);
    assert.equal(result.mode, "current", "a completed generation is current");
    assert.equal(result.applicationMode, "generation");
    assert.equal(result.preparedRoot, packageRoot);
  }
  const checkout = await run(fixture.root);
  assert.equal(checkout.mode, "current", "the original checkout is still current afterwards");
  assert.equal(checkout.applicationMode, "development");
  assert.equal(checkout.preparedRoot, stage);
  assert.equal(prepareCalls, 0, "a completed generation never triggers preparation");
  assert.equal(readFileSync(markerPath(fixture.agentDir), "utf8"), markerBefore, "the checkout's marker is untouched");

  // An incomplete generation is refused, never rebuilt in place.
  rmSync(join(stage, "dist", "src", "web", "cli.js"));
  const incomplete = await prepare.prepareApplication({
    packageRoot: stage,
    agentDir: fixture.agentDir,
    env: process.env,
    prepare: async () => {
      prepareCalls += 1;
      return { ok: true, status: 0, root: stage };
    },
  });
  assert.equal(incomplete.mode, "failed");
  assert.equal(prepareCalls, 0);
  assert.equal(readFileSync(markerPath(fixture.agentDir), "utf8"), markerBefore);
});

test("a cross-agent completed generation is leased under its owning cache and reclaimable only after release", async () => {
  const fixture = makeSourcePackage("generation-owner-lease");
  const ownerAgent = fixture.agentDir;
  const ownerState = prepare.applicationStateRoot(ownerAgent);
  const ownerCache = prepare.buildCacheRoot(ownerAgent);
  const prepared = await prepareWith(fixture);
  assert.equal(prepared.mode, "prepared");
  const ownedGeneration = prepared.preparedRoot as string;
  assert.ok(prepared.lease);
  // The preparing agent releases the generation it just built before another
  // agent consumes it: later protection must come from that consumer's lease.
  prepared.lease?.release();
  assert.equal(prepare.leasedRoots(ownerState).roots.size, 0);
  const ownerMarkerBefore = readFileSync(markerPath(ownerAgent), "utf8");

  // A caller agent with no application state of its own.
  const callerAgent = join(fixture.root, "caller-agent");
  mkdirSync(callerAgent, { recursive: true });
  const callerState = prepare.applicationStateRoot(callerAgent);
  assert.equal(existsSync(callerState), false, "the caller starts with no app state");

  let prepareCalls = 0;
  prepare.__test.resetApplicationStatusReads();
  const consumed = await prepare.prepareApplication({
    packageRoot: ownedGeneration,
    agentDir: callerAgent,
    env: process.env,
    prepare: async () => {
      prepareCalls += 1;
      return { ok: false, status: 1, stage: "unexpected" };
    },
  });
  assert.equal(consumed.mode, "current", "the completed generation is current for the caller");
  assert.equal(consumed.applicationMode, "generation");
  assert.equal(consumed.preparedRoot, ownedGeneration);
  assert.equal(consumed.stateRoot, callerState, "the caller's config/component scope is the caller");
  assert.ok(consumed.lease, "the caller leases the generation it will run");
  assert.equal(prepareCalls, 0, "a cross-agent generation never triggers a rebuild");
  assert.equal(prepare.__test.applicationStatusReadCount(), 1, "it is one cheap freshness decision");
  assert.equal(existsSync(callerState), false, "consuming another agent's generation needs no caller app state");
  assert.equal(readFileSync(markerPath(ownerAgent), "utf8"), ownerMarkerBefore, "the owning checkout's source pointer is untouched");
  const ownerLeases = prepare.leasedRoots(ownerState);
  assert.equal(ownerLeases.complete, true);
  assert.ok(ownerLeases.roots.has(ownedGeneration), "the lease is published under the OWNING cache");
  const callerLeases = prepare.leasedRoots(callerState);
  assert.equal(callerLeases.roots.size, 0, "no application lease is filed under the calling agent");

  // Component readiness written by this launch still belongs to the caller.
  const callerHome = join(fixture.root, "caller-home");
  const venv = join(fixture.root, "caller-venv");
  mkdirSync(join(venv, "bin"), { recursive: true });
  mkdirSync(callerHome, { recursive: true });
  const python = join(venv, "bin", "python");
  writeExecutable(python, "#!/bin/sh\nexit 0\n");
  writeDdgsDistribution(venv);
  const launched = await prepare.prepareLaunch({
    packageRoot: ownedGeneration,
    agentDir: callerAgent,
    homeDir: callerHome,
    env: { ...process.env, PI_REVIEW_GATE_DDGS_VENV: venv },
    platform: process.platform,
    provisionDdgs: async () => ({ ok: true, python }),
    publishSkills: () => ({ ok: true, published: false, skills: [] }),
  });
  assert.equal(launched.mode, "current");
  assert.equal(launched.stateRoot, callerState);
  assert.equal(existsSync(join(callerState, "ddgs.json")), true, "caller readiness markers stay under the caller");
  assert.equal(existsSync(join(ownerState, "ddgs.json")), false, "the owning agent's component state is untouched");
  launched.lease?.release();

  // Direct consumer attachment follows the same owning-cache rule.
  const attached = prepare.attachConsumer({ stateRoot: callerState, agentDir: callerAgent, preparedRoot: ownedGeneration });
  assert.ok(attached);
  assert.ok(prepare.leasedRoots(ownerState).roots.has(ownedGeneration));
  attached?.release();

  // Enough obsolete generations to make the owning agent's pass destructive.
  const obsolete: string[] = [];
  for (let index = 0; index < 8; index += 1) {
    const stage = join(ownerCache, `pi-review-gate-app-${String(index).padStart(12, "0")}`);
    mkdirSync(stage, { recursive: true });
    writeRequiredOutputs(stage);
    obsolete.push(stage);
  }
  const reclaim = (keep: string[]) => {
    const leased = prepare.leasedRoots(ownerState);
    assert.equal(leased.complete, true);
    prepare.__test.cleanupPreparedGenerations({
      agentDir: ownerAgent,
      keep,
      preserve: (root: string) => leased.roots.has(root),
      consumerViewComplete: leased.complete,
    });
  };
  const firstKeep = join(ownerCache, "pi-review-gate-app-zzzz00000000");
  mkdirSync(firstKeep, { recursive: true });
  writeRequiredOutputs(firstKeep);
  reclaim([firstKeep]);
  assert.equal(existsSync(obsolete[0]), false, "the owning agent's lease-aware pass does reclaim excess generations");
  assert.equal(existsSync(ownedGeneration), true, "the caller's lease ALONE preserves the owning generation");

  consumed.lease?.release();
  assert.equal(prepare.leasedRoots(ownerState).roots.size, 0, "the caller's release ends the protection");
  const newer: string[] = [];
  for (let index = 1; index <= 6; index += 1) {
    const stage = join(ownerCache, `pi-review-gate-app-zzzz0000000${index}`);
    mkdirSync(stage, { recursive: true });
    writeRequiredOutputs(stage);
    newer.push(stage);
  }
  reclaim([newer[newer.length - 1]]);
  assert.equal(existsSync(ownedGeneration), false, "after the caller releases, the generation is reclaimable");
});

test("a completed generation whose owning coordination is unavailable fails closed without installing", async () => {
  const fixture = makeSourcePackage("generation-owner-unavailable");
  const ownerAgent = fixture.agentDir;
  const prepared = await prepareWith(fixture);
  assert.equal(prepared.mode, "prepared");
  const ownedGeneration = prepared.preparedRoot as string;
  prepared.lease?.release();
  const ownerMarkerBefore = readFileSync(markerPath(ownerAgent), "utf8");
  const callerAgent = join(fixture.root, "caller-agent");
  mkdirSync(callerAgent, { recursive: true });
  const callerState = prepare.applicationStateRoot(callerAgent);

  // The owning cache's state chain is no longer a real directory, so its cleanup
  // coordination is unavailable and no lease can be published there.
  const ownerStateDir = prepare.applicationStateRoot(ownerAgent);
  renameSync(ownerStateDir, `${ownerStateDir}-real`);
  symlinkSync(`${ownerStateDir}-real`, ownerStateDir);

  let prepareCalls = 0;
  const blocked = await prepare.prepareApplication({
    packageRoot: ownedGeneration,
    agentDir: callerAgent,
    env: process.env,
    prepare: async () => {
      prepareCalls += 1;
      return { ok: true, status: 0, root: ownedGeneration };
    },
  });
  assert.equal(blocked.mode, "failed", "an uncoordinated completed generation is never handed back");
  assert.equal(blocked.stage, "coordination");
  assert.equal(prepareCalls, 0, "unavailable owning coordination never starts a redundant install");
  assert.equal(existsSync(callerState), false, "no caller application state is created for the failed launch");
  assert.equal(readFileSync(markerPath(ownerAgent), "utf8"), ownerMarkerBefore, "the owning checkout's source pointer is untouched");
  assert.ok(prepare.__test.readGenerationReceipt(ownedGeneration), "the completed generation is retained intact");
  assert.equal(existsSync(join(ownedGeneration, "package.json")), true, "the generation's source identity is retained");
});

test("an owning path aliased while the consumer waits is revalidated before leasing", async () => {
  const fixture = makeSourcePackage("generation-owner-wait-alias");
  const ownerAgent = fixture.agentDir;
  const ownerState = prepare.applicationStateRoot(ownerAgent);
  const ownerCache = prepare.buildCacheRoot(ownerAgent);
  const prepared = await prepareWith(fixture);
  assert.equal(prepared.mode, "prepared");
  const ownedGeneration = prepared.preparedRoot as string;
  prepared.lease?.release();
  const ownerMarkerBefore = readFileSync(markerPath(ownerAgent), "utf8");
  const callerAgent = join(fixture.root, "caller-agent");
  mkdirSync(callerAgent, { recursive: true });
  const callerState = prepare.applicationStateRoot(callerAgent);

  // Hold the owning cache's cleanup coordination so the caller must wait.
  const holder = await prepare.__test.acquireLockFile(join(ownerState, "cleanup.lock"), { waitMs: 0, pollMs: 10 });
  assert.ok(holder);
  let prepareCalls = 0;
  let waitObserved = 0;
  let aliased = false;
  const blocked = await prepare.prepareApplication({
    packageRoot: ownedGeneration,
    agentDir: callerAgent,
    env: process.env,
    onCoordinationWait: () => {
      waitObserved += 1;
      if (aliased) return;
      aliased = true;
      // Replace the owning cache's build directory with an alias exactly while
      // this consumer is waiting: the generation's receipt and directory
      // identity still match, so only the revalidated owning chain can refuse it.
      renameSync(ownerCache, `${ownerCache}-real`);
      symlinkSync(`${ownerCache}-real`, ownerCache);
      holder.release();
    },
    prepare: async () => {
      prepareCalls += 1;
      return { ok: true, status: 0, root: ownedGeneration };
    },
  });
  assert.equal(waitObserved > 0, true, "the caller actually waited on the owning coordination");
  assert.equal(blocked.mode, "failed", "an owning chain aliased during the wait is never handed back");
  assert.equal(blocked.stage, "coordination");
  assert.equal(prepareCalls, 0, "no installation is attempted for a refused owning chain");
  assert.equal(existsSync(callerState), false, "no caller application state is created for the refused launch");
  assert.equal(prepare.leasedRoots(ownerState).roots.size, 0, "no lease is published under the aliased owning cache");
  assert.equal(readFileSync(markerPath(ownerAgent), "utf8"), ownerMarkerBefore, "the owning checkout's source pointer is untouched");
  assert.ok(prepare.__test.readGenerationReceipt(ownedGeneration), "the generation itself is retained intact");
});

test("the preparation lock publishes a complete owner record and never deletes a live contender", async () => {
  const root = makeFixture("lock-invariants");
  const stateRoot = prepare.applicationStateRoot(join(root, "agent"));
  mkdirSync(stateRoot, { recursive: true });
  const lockPath = join(stateRoot, "prepare.lock");

  const first = await prepare.__test.acquireLockFile(lockPath, { waitMs: 0, pollMs: 10 });
  assert.ok(first, "the lock is acquired");
  const published = JSON.parse(readFileSync(lockPath, "utf8"));
  assert.equal(published.pid, process.pid, "the record is complete before the lock is observable");

  const second = await prepare.__test.acquireLockFile(lockPath, { waitMs: 0, pollMs: 10 });
  assert.equal(second, null, "a live holder is honored, not replaced");
  first?.release();
  assert.equal(existsSync(lockPath), false, "release removes exactly this owner's record");

  // A live pid with no recorded birth token is still a live holder.
  writeFileSync(lockPath, `${JSON.stringify({ schema: prepare.APPLICATION_SCHEMA, pid: process.pid, birth: "" })}\n`, "utf8");
  const conservative = await prepare.__test.acquireLockFile(lockPath, { waitMs: 0, pollMs: 10 });
  assert.equal(conservative, null, "an unknown birth token never proves mismatch");
  assert.equal(existsSync(lockPath), true);

  // A provably dead owner is reclaimed.
  writeFileSync(lockPath, `${JSON.stringify({ schema: prepare.APPLICATION_SCHEMA, pid: 2 ** 22 + 7, birth: "gone" })}\n`, "utf8");
  const reclaimed = await prepare.__test.acquireLockFile(lockPath, { waitMs: 500, pollMs: 10 });
  assert.ok(reclaimed, "an abandoned record is reclaimed");
  reclaimed?.release();
});

test("an incomplete consumer view skips cleanup and preserves unknown entries", () => {
  const fixture = makeSourcePackage("lease-incomplete");
  const stateRoot = prepare.applicationStateRoot(fixture.agentDir);
  const cacheRoot = prepare.buildCacheRoot(fixture.agentDir);
  mkdirSync(cacheRoot, { recursive: true });
  const stages: string[] = [];
  for (let index = 0; index < 8; index += 1) {
    const stage = join(cacheRoot, `pi-review-gate-app-${String(index).padStart(4, "0")}`);
    mkdirSync(stage, { recursive: true });
    writeRequiredOutputs(stage);
    stages.push(stage);
  }
  const consumers = join(stateRoot, "consumers");
  mkdirSync(consumers, { recursive: true });
  const unknown = join(consumers, "unrelated-entry");
  writeFileSync(unknown, "not a lease record\n", "utf8");

  const leased = prepare.leasedRoots(stateRoot);
  assert.equal(leased.complete, false, "an unidentifiable entry makes the view incomplete");
  assert.equal(existsSync(unknown), true, "an unknown entry is preserved, never deleted as stale");

  prepare.__test.cleanupPreparedGenerations({
    agentDir: fixture.agentDir,
    keep: [stages[7]],
    consumerViewComplete: leased.complete,
  });
  assert.equal(existsSync(stages[0]), true, "cleanup is skipped when the consumer view is incomplete");
});

test("recorded application-input paths are strictly validated before any filesystem access", async () => {
  const fixture = makeSourcePackage("index-validation");
  const first = await prepareWith(fixture);
  assert.equal(first.mode, "prepared");
  const marker = JSON.parse(readFileSync(markerPath(fixture.agentDir), "utf8"));
  const identity = (target: string) => {
    const stats = lstatSync(target, { bigint: true });
    return { dev: stats.dev.toString(), ino: stats.ino.toString(), mode: Number(stats.mode & 0o777n).toString() };
  };
  const base = {
    ...marker,
    preparedRootIdentity: identity(first.preparedRoot as string),
  };
  for (const badPath of ["../escape.ts", "/etc/passwd", "src\\index.ts", "src/../index.ts", "src//index.ts", "src/\u0000x"]) {
    writeFileSync(markerPath(fixture.agentDir), JSON.stringify({
      ...base,
      sourceIndex: { ...marker.sourceIndex, files: [...marker.sourceIndex.files, { path: badPath, size: "1", mtimeNs: "1", ctimeNs: "1", ino: "1", dev: "1", mode: "420" }] },
    }), "utf8");
    assert.equal(
      prepare.applicationStatus({ packageRoot: fixture.root, agentDir: fixture.agentDir }).current,
      false,
      `recorded path ${JSON.stringify(badPath)} must be refused`,
    );
  }
  writeFileSync(markerPath(fixture.agentDir), JSON.stringify(base), "utf8");
  assert.equal(prepare.applicationStatus({ packageRoot: fixture.root, agentDir: fixture.agentDir }).current, true);
});

test("same-size rewrites, permission changes, replaced roots, and retargeted entries are detected", async () => {
  const fixture = makeSourcePackage("metadata-guards");
  const prepared = await prepareWith(fixture);
  const status = () => prepare.applicationStatus({ packageRoot: fixture.root, agentDir: fixture.agentDir });
  assert.equal(status().current, true);

  // Same size, same mtime, different bytes: the inode change time still moves.
  const target = join(fixture.root, "src", "index.ts");
  const original = lstatSync(target);
  writeFileSync(target, "export const value = 2;\n", "utf8");
  utimesSync(target, original.atime, original.mtime);
  assert.equal(lstatSync(target).size, original.size);
  assert.equal(status().current, false, "a same-size rewrite with a restored mtime is still a change");

  // Restoring identical bytes is a touch-only change: still current.
  writeFileSync(target, "export const value = 1;\n", "utf8");
  assert.equal((await prepareWith(fixture)).mode, "current");
  // Executable bits are part of the staged input identity: a chmod-only change
  // produces a new generation and the staged copy keeps the new bits.
  chmodSync(target, 0o755);
  const executable = await prepareWith(fixture);
  assert.equal(executable.mode, "prepared", "a chmod-only change is a real input change");
  assert.equal(lstatSync(join(executable.preparedRoot as string, "src", "index.ts")).mode & 0o111, 0o111);
  assert.equal(status().current, true);
  chmodSync(target, 0o644);
  const restored = await prepareWith(fixture);
  assert.equal(restored.mode, "prepared", "removing executable bits is also a real change");
  assert.equal(lstatSync(join(restored.preparedRoot as string, "src", "index.ts")).mode & 0o111, 0);

  // A replaced prepared root is detected by its recorded identity. Use the
  // currently published root (the chmod-only steps produced newer generations).
  const root = JSON.parse(readFileSync(markerPath(fixture.agentDir), "utf8")).preparedRoot as string;
  // The prepared root is replaced by a different directory with the same name.
  const moved = `${root}-moved`;
  renameSync(root, moved);
  mkdirSync(root, { recursive: true });
  writeRequiredOutputs(root);
  assert.equal(status().current, false, "a replaced prepared root is never reused");
  rmSync(root, { recursive: true, force: true });
  renameSync(moved, root);
  assert.equal(status().current, true);

  // A retargeted dist/src junction cannot redirect the compiled entry.
  const distSrc = join(root, "dist", "src");
  renameSync(distSrc, `${distSrc}-real`);
  const outside = makeFixture("metadata-junction");
  writeRequiredOutputs(outside);
  symlinkSync(join(outside, "dist", "src"), distSrc);
  assert.equal(status().current, false, "a symlinked required-entry ancestor is refused");
});

test("a prepared generation is usable only with a valid completion receipt", async () => {
  const fixture = makeSourcePackage("generation-receipt");
  const prepared = await prepareWith(fixture);
  const stage = prepared.preparedRoot as string;
  const receiptPath = join(stage, ".pi-review-gate-complete.json");
  assert.equal(existsSync(receiptPath), true, "publication writes a completion receipt inside the generation");
  assert.ok(prepare.__test.readGenerationReceipt(stage));
  assert.equal(prepare.applicationStatus({ packageRoot: stage, agentDir: fixture.agentDir }).current, true);

  // Naming convention plus emitted JavaScript is not proof: without the receipt
  // the generation is recognized as immutable code but never accepted, and it is
  // never rebuilt in place.
  rmSync(receiptPath);
  assert.equal(prepare.isPreparedGenerationRoot(stage), true);
  assert.equal(prepare.applicationStatus({ packageRoot: stage, agentDir: fixture.agentDir }).current, false);
  let prepareCalls = 0;
  const refused = await prepare.prepareApplication({
    packageRoot: stage,
    agentDir: fixture.agentDir,
    prepare: async () => {
      prepareCalls += 1;
      return { ok: true, status: 0, root: stage };
    },
  });
  assert.equal(refused.mode, "failed");
  assert.equal(prepareCalls, 0, "an incomplete generation is never rebuilt in place");

  // A receipt that names a different package version or identity is refused too.
  prepare.__test.writeGenerationReceipt(stage, { packageVersion: "9.9.9", sourceDigest: "a".repeat(64) });
  assert.equal(prepare.applicationStatus({ packageRoot: stage, agentDir: fixture.agentDir }).current, false);
});

test("a current launch makes exactly one freshness decision and keeps resources paired with its root", async () => {
  const fixture = makeSourcePackage("single-decision");
  const prepared = await prepareWith(fixture);
  assert.ok(prepared.lease);
  const venv = join(fixture.root, "ddgs-venv");
  mkdirSync(join(venv, "bin"), { recursive: true });
  const python = join(venv, "bin", "python");
  writeExecutable(python, "#!/bin/sh\nexit 0\n");
  const options = {
    packageRoot: fixture.root,
    agentDir: fixture.agentDir,
    homeDir: join(fixture.root, "home"),
    env: { ...process.env, PI_REVIEW_GATE_DDGS_VENV: venv },
    platform: process.platform,
    provisionDdgs: async () => ({ ok: true, python }),
  };
  mkdirSync(options.homeDir, { recursive: true });
  const first = await prepare.prepareLaunch(options);
  assert.equal(first.mode, "current");
  first.lease?.release();

  prepare.__test.resetApplicationStatusReads();
  const warm = await prepare.prepareLaunch(options);
  assert.equal(warm.mode, "current");
  assert.equal(warm.preparedRoot, prepared.preparedRoot, "the selected root is the leased root");
  assert.equal(prepare.__test.applicationStatusReadCount(), 1, "a current start makes one freshness decision");
  warm.lease?.release();
  prepared.lease?.release();
});

test("an update between selection and component provisioning keeps code and resources paired", async () => {
  const fixture = makeSourcePackage("paired-update");
  const first = await prepareWith(fixture);
  assert.equal(first.mode, "prepared");
  assert.ok(first.lease);
  const pinnedRoot = first.preparedRoot as string;
  const pinnedSkill = readFileSync(join(pinnedRoot, "skills", "pi-review-gate-execution", "SKILL.md"), "utf8");
  const venv = join(fixture.root, "ddgs-venv");
  mkdirSync(join(venv, "bin"), { recursive: true });
  const python = join(venv, "bin", "python");
  writeExecutable(python, "#!/bin/sh\nexit 0\n");
  const homeDir = join(fixture.root, "home");
  mkdirSync(homeDir, { recursive: true });

  let newer: PrepareResult | undefined;
  const result = await prepare.prepareLaunch({
    packageRoot: fixture.root,
    agentDir: fixture.agentDir,
    homeDir,
    env: { ...process.env, PI_REVIEW_GATE_DDGS_VENV: venv },
    platform: process.platform,
    provisionDdgs: async () => {
      // A concurrent update completes while this launch is between selecting its
      // leased root and provisioning its components.
      writeFileSync(join(fixture.root, "skills", "pi-review-gate-execution", "SKILL.md"), "---\nname: newer\n---\n", "utf8");
      newer = await prepareWith(fixture);
      return { ok: true, python };
    },
  });
  assert.equal(newer?.mode, "prepared");
  assert.notEqual(newer?.preparedRoot, pinnedRoot);
  assert.equal(result.mode, "current");
  assert.equal(result.preparedRoot, pinnedRoot, "the launch keeps the root it selected and leased");
  const installed = readFileSync(join(homeDir, ".agents", "skills", "pi-review-gate-execution", "SKILL.md"), "utf8");
  assert.equal(installed, pinnedSkill, "shipped resources come from the selected prepared root, not the newer checkout state");
  assert.equal(prepare.leasedRoots(prepare.applicationStateRoot(fixture.agentDir)).roots.has(pinnedRoot), true);

  // The global marker advanced, but the pinned generation is still current and
  // still leased: an older live prepared launcher is never orphaned by an update.
  const pinnedStatus = prepare.applicationStatus({ packageRoot: pinnedRoot, agentDir: fixture.agentDir });
  assert.equal(pinnedStatus.current, true);
  assert.equal(prepare.__test.readGenerationReceipt(pinnedRoot)?.sourceDigest !== undefined, true);
  const older = await prepare.prepareApplication({ packageRoot: pinnedRoot, agentDir: fixture.agentDir });
  assert.equal(older.mode, "current");
  assert.equal(older.preparedRoot, pinnedRoot);
  assert.ok(older.lease, "a generation used as a launcher is leased like any managed root");

  older.lease?.release();
  result.lease?.release();
  newer?.lease?.release();
  first.lease?.release();
});

test("application preparation never reclaims before its coordinated lease-aware pass", () => {
  const fixture = makeSourcePackage("admit-non-destructive");
  const stateRoot = prepare.applicationStateRoot(fixture.agentDir);
  const cacheRoot = prepare.buildCacheRoot(fixture.agentDir);
  mkdirSync(cacheRoot, { recursive: true });
  const generations: string[] = [];
  for (let index = 0; index < 8; index += 1) {
    const stage = join(cacheRoot, `pi-review-gate-app-${String(index).padStart(4, "0")}`);
    mkdirSync(stage, { recursive: true });
    writeRequiredOutputs(stage);
    generations.push(stage);
  }
  // The oldest generation is actively consumed while a fresh preparation runs.
  const lease = prepare.attachConsumer({ stateRoot, agentDir: fixture.agentDir, preparedRoot: generations[0] });
  assert.ok(lease);
  // Admission is non-destructive for application preparation; only the
  // coordinated post-publication pass reclaims, and it preserves the lease.
  const leased = prepare.leasedRoots(stateRoot);
  prepare.__test.cleanupPreparedGenerations({
    agentDir: fixture.agentDir,
    keep: [generations[7]],
    preserve: (root: string) => leased.roots.has(root),
  });
  assert.equal(existsSync(generations[0]), true, "a leased oldest generation survives the coordinated pass");
  assert.equal(existsSync(generations[1]), false, "unleased excess generations are still reclaimed");
  lease.release();
});

test("the CLI binds the consumer lease to its native invoking parent and it survives exec", { skip: process.platform === "win32" }, async (t) => {
  const root = makeFixture("cli-lease-parent");
  const homeDir = join(root, "home");
  const agentDir = join(root, "agent");
  const bin = join(root, "bin");
  mkdirSync(homeDir, { recursive: true });
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(root, "package.json"), `${JSON.stringify({ name: "pi-review-gate", version: "0.1.0-dev.181" })}\n`, "utf8");
  writeRequiredOutputs(root);
  for (const skill of prepare.SKILL_PUBLISH_PLAN) {
    for (const file of skill.files) {
      const source = join(root, ...file.source);
      mkdirSync(join(source, ".."), { recursive: true });
      writeFileSync(source, `---\nname: ${skill.name}\n---\n`, "utf8");
    }
  }
  const venv = join(root, "ddgs-venv");
  mkdirSync(join(venv, "bin"), { recursive: true });
  writeExecutable(join(venv, "bin", "python"), "#!/bin/sh\nexit 0\n");
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: homeDir,
    PATH: `${bin}:${process.env.PATH ?? ""}`,
    PI_REVIEW_GATE_DDGS_VENV: venv,
  };
  // A wrapper exactly like the real POSIX launchers: run the shared CLI, then
  // exec the long-lived consumer. `$$` is the shell pid; exec preserves it.
  const wrapper = join(root, "wrapper.sh");
  writeFileSync(wrapper, [
    "#!/bin/sh",
    `node ${JSON.stringify(join(process.cwd(), "scripts", "prepare-application.cjs"))} --prepare --root ${JSON.stringify(root)} --home ${JSON.stringify(homeDir)} --agent-dir ${JSON.stringify(agentDir)} || exit $?`,
    "exec node -e 'require(\"node:fs\").writeSync(1, `READY ${process.pid}\\n`); setInterval(() => {}, 1000);'",
    "",
  ].join("\n"));
  chmodSync(wrapper, 0o755);
  const child = spawn("/bin/sh", [wrapper], { env, detached: true, stdio: ["ignore", "pipe", "inherit"] });
  let readyPid: number | undefined;
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("consumer did not become ready")), 60_000);
    child.stdout.on("data", (chunk: Buffer) => {
      const match = /READY (\d+)/u.exec(chunk.toString("utf8"));
      if (!match) return;
      readyPid = Number(match[1]);
      clearTimeout(timer);
      resolve();
    });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (readyPid === undefined) {
        clearTimeout(timer);
        reject(new Error(`consumer exited before readiness (${code})`));
      }
    });
  });
  const stateRoot = prepare.applicationStateRoot(agentDir);
  const leased = prepare.leasedRoots(stateRoot);
  const marker = JSON.parse(readFileSync(markerPath(agentDir), "utf8"));
  assert.equal(leased.complete, true);
  assert.ok(leased.roots.has(marker.preparedRoot), "the live exec'd consumer protects the generation");
  const leasePids = readdirSync(join(stateRoot, "consumers")).map((name) => Number(name.split("-")[0]));
  assert.ok(readyPid !== undefined && leasePids.includes(readyPid), "the lease names the native pid that exec preserved");

  // When the consumer really ends, its lease becomes stale and the generation
  // is an ordinary reclaimable candidate again.
  child.kill("SIGKILL");
  await new Promise<void>((resolve) => child.once("close", () => resolve()));
  assert.equal(prepare.leasedRoots(stateRoot).roots.has(marker.preparedRoot), false, "a dead consumer grants no protection");
  void t;
});

test("deleting the installed DDGS package invalidates the component marker", async () => {
  const root = makeFixture("ddgs-components");
  const agentDir = join(root, "agent");
  const homeDir = join(root, "home");
  mkdirSync(homeDir, { recursive: true });
  const environment: NodeJS.ProcessEnv = { ...process.env };
  delete environment.PI_REVIEW_GATE_DDGS_VENV;
  delete environment.XDG_CACHE_HOME;
  const venv = prepare.ddgsVenvPath(homeDir, environment);
  const sitePackages = join(venv, "lib", "python3.14", "site-packages");
  mkdirSync(join(sitePackages, "ddgs"), { recursive: true });
  mkdirSync(join(sitePackages, "ddgs-9.16.0.dist-info"), { recursive: true });
  writeFileSync(join(sitePackages, "ddgs-9.16.0.dist-info", "METADATA"), "Name: ddgs\nVersion: 9.16.0\n", "utf8");
  mkdirSync(join(venv, "bin"), { recursive: true });
  const python = join(venv, "bin", "python");
  writeExecutable(python, "#!/bin/sh\nexit 0\n");
  const stateRoot = prepare.applicationStateRoot(agentDir);
  let provisions = 0;
  const options = {
    stateRoot,
    agentDir,
    homeDir,
    env: environment,
    provision: async () => {
      provisions += 1;
      return { ok: true, python };
    },
  };
  const first = await prepare.ensureDdgsReady(options);
  assert.equal(first.ok, true);
  assert.equal(first.recorded, true, "a complete environment records its distribution paths");
  assert.equal((await prepare.ensureDdgsReady(options)).provisioned, false);
  assert.equal(provisions, 1);
  rmSync(join(sitePackages, "ddgs"), { recursive: true, force: true });
  await prepare.ensureDdgsReady(options);
  assert.equal(provisions, 2, "a removed package invalidates readiness even though Python is unchanged");
});

test("a symlinked managed state parent is refused instead of executing prepared code", async () => {
  const fixture = makeSourcePackage("unsafe-parent");
  const first = await prepareWith(fixture);
  assert.equal(first.mode, "prepared");
  const runtime = join(fixture.agentDir, ".pi-review-gate");
  const moved = `${runtime}-real`;
  renameSync(runtime, moved);
  symlinkSync(moved, runtime);
  const status = prepare.applicationStatus({ packageRoot: fixture.root, agentDir: fixture.agentDir });
  assert.equal(status.current, false);
  const refused = await prepareWith(fixture);
  assert.equal(refused.mode, "failed");
  assert.match(String(refused.stage), /state|input/u);
  assert.equal(existsSync(join(first.preparedRoot as string, "dist", "src", "web", "cli.js")), true,
    "the preserved generation is never executed or mutated through the alias");
});

test("the Python probe tries the Windows py launcher only on win32", () => {
  const posix = prepare.__test.pythonInterpreters("linux");
  assert.deepEqual(posix.map((candidate: { file: string }) => candidate.file), ["python3", "python"]);
  const windows = prepare.__test.pythonInterpreters("win32");
  assert.deepEqual(windows.map((candidate: { file: string }) => candidate.file), ["python3", "python", "py"]);
  assert.deepEqual(windows[2].prefixArgs, ["-3"], "the py launcher selects Python 3 explicitly");
});

test("skill readiness is tied to the complete current destination plan", () => {
  const root = makeFixture("skills-plan");
  const packageRoot = join(root, "package");
  const agentDir = join(root, "agent");
  const homeA = join(root, "home-a");
  const homeB = join(root, "home-b");
  mkdirSync(homeA, { recursive: true });
  mkdirSync(homeB, { recursive: true });
  for (const skill of prepare.SKILL_PUBLISH_PLAN) {
    for (const file of skill.files) {
      const source = join(packageRoot, ...file.source);
      mkdirSync(join(source, ".."), { recursive: true });
      writeFileSync(source, `---\nname: ${skill.name}\n---\n`, "utf8");
    }
  }
  const stateRoot = prepare.applicationStateRoot(agentDir);
  const base = { stateRoot, agentDir, packageRoot, applicationIdentity: "source:plan" };
  const publishA = prepare.ensureShippedSkills({ ...base, homeDir: homeA });
  assert.equal(publishA.ok, true);
  assert.equal(publishA.published, true);
  const warmA = prepare.ensureShippedSkills({ ...base, homeDir: homeA });
  assert.equal(warmA.published, false);
  assert.deepEqual((warmA.skills ?? []).map((skill: { path: string }) => skill.path),
    prepare.SKILL_PUBLISH_PLAN.map((skill: { name: string }) => join(homeA, ".agents", "skills", skill.name, "SKILL.md")),
    "returned skill paths derive from the current destination plan");

  // Same agent dir + application identity, different HOME: never reuse the old
  // home's readiness; publish every required destination into the new home.
  const publishB = prepare.ensureShippedSkills({ ...base, homeDir: homeB });
  assert.equal(publishB.published, true, "a changed HOME is a component miss");
  for (const skill of prepare.SKILL_PUBLISH_PLAN) {
    for (const file of skill.files) {
      const destination = join(homeB, ".agents", "skills", skill.name, ...file.destination);
      assert.ok(existsSync(destination), `published into the new home: ${destination}`);
    }
  }
  assert.equal(prepare.ensureShippedSkills({ ...base, homeDir: homeB }).published, false);

  // An empty or partial recorded file list is not readiness.
  const markerPath = join(stateRoot, "skills.json");
  const marker = JSON.parse(readFileSync(markerPath, "utf8"));
  for (const files of [[], marker.files.slice(0, 1)]) {
    writeFileSync(markerPath, JSON.stringify({ ...marker, files }), "utf8");
    const repaired = prepare.ensureShippedSkills({ ...base, homeDir: homeB });
    assert.equal(repaired.published, true, "an incomplete marker forces full publication");
    assert.equal(prepare.ensureShippedSkills({ ...base, homeDir: homeB }).published, false);
  }
});
