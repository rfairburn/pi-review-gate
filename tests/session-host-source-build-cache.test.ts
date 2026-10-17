import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { delimiter, join } from "node:path";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import nodeTest from "node:test";

interface ProcessResult {
  status: number | null;
  signal: string | null;
  error?: Error;
  cleanupConfirmed?: boolean;
  timedOut: boolean;
  outputExceeded: boolean;
  stdout: string;
  stderr?: string;
}

interface BuildResult {
  status: number | null;
  stage?: "install" | "compile" | "stage";
  error?: Error;
  diagnostics?: string;
  stagingRoot?: string;
  ownedStage?: { root: string; identity: { dev: bigint; ino: bigint }; chain?: Array<{ target: string; identity: { dev: bigint; ino: bigint } }>; generation?: { release(): boolean } };
  sourceFingerprint?: string;
  toolchainFingerprint?: string;
  cacheKey?: string;
  cacheParentChain?: Array<{ target: string; identity: { dev: bigint; ino: bigint } }>;
  cacheHit?: boolean;
  cachePublished?: boolean;
  testHooks?: CacheTestHooks;
  toolchainFence?: unknown;
}

interface CacheTestHooks {
  afterSourceCopyRead?: (source: string, destination: string) => void;
  beforeSourceCopyRead?: (source: string, destination: string) => void;
  afterSourceStageCreated?: (stageRoot: string) => void;
  afterSourceFileHashed?: (file: string) => void;
  afterArtifactFileHashed?: (file: string, relative: string) => void;
  beforeCacheRecord?: (recordPath: string, stageRoot: string) => void;
  afterToolchainFingerprint?: () => void;
}

interface BuildOptions {
  packageRoot: string;
  agentDir: string;
  env: NodeJS.ProcessEnv;
  forceFresh?: boolean;
  runNpm?: (npmCli: string, args: string[], options: Record<string, unknown>) => Promise<ProcessResult>;
  runCompile?: (compilerCli: string, args: string[], options: Record<string, unknown>) => Promise<ProcessResult>;
  testHooks?: CacheTestHooks;
}

interface LauncherModule {
  __test: {
    buildSourceExtension(options: BuildOptions): Promise<BuildResult>;
    runSessionHostLauncher(argv: string[], overrides: Record<string, unknown>): Promise<number>;
    fingerprintSourcePackage(packageRoot: string, testHooks?: CacheTestHooks): { digest: string; entries: number; files: number; bytes: number; inventory: Array<Record<string, unknown>> };
    sourceBuildCacheEligible(packageRoot: string, env: NodeJS.ProcessEnv): boolean;
    validateSourceBuildArtifact(stageRoot: string, metadata: { cacheKey: string; sourceFingerprint: string; toolchainFingerprint: string }, parentChain?: Array<{ target: string; identity: { dev: bigint; ino: bigint } }>, testHooks?: CacheTestHooks): { entries: Array<unknown>; files: number; bytes: number } | undefined;
  };
}

const requireCjs = createRequire(join(process.cwd(), "tests", "session-host-source-build-cache.test.ts"));
const launcher = requireCjs("../scripts/pi-review-sessions.cjs") as LauncherModule;
const MANIFEST = ".pi-review-gate-source-build.json";
const CI_ARGS = ["ci", "--include=dev", "--ignore-scripts", "--no-audit", "--no-fund", "--registry", "https://registry.npmjs.org"];

interface Fixture {
  root: string;
  packageRoot: string;
  agentDir: string;
  bin: string;
  npmCli: string;
  env: NodeJS.ProcessEnv;
  identity: { dev: bigint; ino: bigint };
}

interface Counters {
  npm: number;
  compile: number;
  pi: number;
  ddgs: number;
  load: number;
  forceFresh: number;
}

function writePrivateFile(file: string, content: string, mode = 0o600): void {
  writeFileSync(file, content, { encoding: "utf8", flag: "wx", mode });
}

/** All fixture, HOME, temp, cache, and stage data stay under a new ignored worker node_modules directory. */
function makeFixture(): Fixture {
  const nodeModules = join(process.cwd(), "node_modules");
  const nodeModulesStats = lstatSync(nodeModules, { bigint: true });
  assert.equal(nodeModulesStats.isDirectory(), true, "the worker node_modules root must be a real directory");
  assert.equal(nodeModulesStats.isSymbolicLink(), false, "the worker node_modules root must not be a symlink/shared alias");
  assert.ok(nodeModulesStats.ino > 0n, "the worker node_modules root has a positive identity");
  const root = mkdtempSync(join(nodeModules, ".session-host-source-cache-"));
  const rootStats = lstatSync(root, { bigint: true });
  assert.equal(rootStats.isDirectory(), true);
  assert.equal(rootStats.isSymbolicLink(), false);
  assert.equal(Number(rootStats.mode & 0o077n), 0, "fixture HOME/root is private from creation");
  const packageRoot = join(root, "package π");
  const bin = join(root, "fake-bin");
  for (const directory of [
    join(packageRoot, "src", "session-host"),
    join(packageRoot, "scripts"),
    join(packageRoot, "skills", "cache-test"),
    bin,
  ]) mkdirSync(directory, { recursive: true, mode: 0o700 });
  writePrivateFile(join(packageRoot, "package.json"), JSON.stringify({ name: "pi-review-gate", version: "0.1.0", scripts: { build: "tsc -p tsconfig.json" } }));
  writePrivateFile(join(packageRoot, "package-lock.json"), JSON.stringify({ name: "pi-review-gate", version: "0.1.0", lockfileVersion: 3, packages: { "": { name: "pi-review-gate", version: "0.1.0" } } }));
  writePrivateFile(join(packageRoot, "tsconfig.json"), JSON.stringify({ compilerOptions: { outDir: "dist" }, include: ["src/**/*.ts"] }));
  writePrivateFile(join(packageRoot, "src", "session-host", "main.ts"), "// original synthetic input\n");
  writePrivateFile(join(packageRoot, "scripts", "build-helper.cjs"), "// staged build input\n");
  writePrivateFile(join(packageRoot, "skills", "cache-test", "SKILL.md"), "# staged skill input\n");
  writePrivateFile(join(bin, "package.json"), JSON.stringify({ name: "npm", version: "10.0.0", bin: { npm: "npm" } }));
  writePrivateFile(join(bin, "npm-helper.cjs"), "// synthetic npm implementation helper v1\n");
  const npmCli = join(bin, "npm");
  writePrivateFile(npmCli, "#!/usr/bin/env node\nrequire(\"./npm-helper.cjs\");\n// synthetic validated npm entry; runner is injected\n", 0o700);
  chmodSync(npmCli, 0o700);
  return {
    root,
    packageRoot,
    agentDir: join(root, ".pi", "agent"),
    bin,
    npmCli,
    env: { HOME: root, PATH: bin, NODE_OPTIONS: "--no-warnings", NODE_ENV: "development" },
    identity: { dev: rootStats.dev, ino: rootStats.ino },
  };
}

function ok(overrides: Partial<ProcessResult> = {}): ProcessResult {
  return { status: 0, signal: null, cleanupConfirmed: true, timedOut: false, outputExceeded: false, stdout: "", ...overrides };
}

function writeSyntheticCompiler(stageRoot: string): void {
  const packageDir = join(stageRoot, "node_modules", "typescript");
  mkdirSync(join(packageDir, "bin"), { recursive: true, mode: 0o700 });
  writePrivateFile(join(packageDir, "package.json"), JSON.stringify({ name: "typescript", version: "5.7.2", bin: { tsc: "./bin/tsc" } }));
  writePrivateFile(join(packageDir, "bin", "tsc"), "// inert validated compiler marker\n");
}

function writeSyntheticOutput(stageRoot: string): void {
  const outputDir = join(stageRoot, "dist", "src", "session-host");
  mkdirSync(outputDir, { recursive: true, mode: 0o700 });
  writePrivateFile(join(outputDir, "main.js"), "// synthetic compiled native host\n");
}

interface BuildHooks {
  install?: (stageRoot: string, args: string[], options: Record<string, unknown>) => Promise<ProcessResult> | ProcessResult;
  compile?: (stageRoot: string, args: string[], options: Record<string, unknown>) => Promise<ProcessResult> | ProcessResult;
  testHooks?: CacheTestHooks;
}

function buildRunners(counters: Counters, hooks: BuildHooks = {}): Pick<BuildOptions, "runNpm" | "runCompile"> {
  return {
    runNpm: async (_npmCli, args, options) => {
      counters.npm += 1;
      assert.deepEqual(args, CI_ARGS, "source setup continues to use locked npm ci only");
      const stageRoot = String(options.cwd);
      if (hooks.install) return hooks.install(stageRoot, args, options);
      writeSyntheticCompiler(stageRoot);
      return ok();
    },
    runCompile: async (_compilerCli, args, options) => {
      counters.compile += 1;
      const stageRoot = String(options.cwd);
      assert.deepEqual(args, ["-p", join(stageRoot, "tsconfig.json")]);
      if (hooks.compile) return hooks.compile(stageRoot, args, options);
      writeSyntheticOutput(stageRoot);
      return ok();
    },
  };
}

function newCounters(): Counters {
  return { npm: 0, compile: 0, pi: 0, ddgs: 0, load: 0, forceFresh: 0 };
}

async function build(fixture: Fixture, counters: Counters, env = fixture.env, hooks: BuildHooks = {}, forceFresh = false): Promise<BuildResult> {
  const result = await launcher.__test.buildSourceExtension({
    packageRoot: fixture.packageRoot,
    agentDir: fixture.agentDir,
    env,
    forceFresh,
    testHooks: hooks.testHooks,
    ...buildRunners(counters, hooks),
  });
  // This helper inspects build output only; it never starts a consumer. Its
  // synchronous fixture runners have settled when the producer returns.
  if (result.status === 0) assert.equal(result.ownedStage?.generation?.release(), true);
  return result;
}

async function launch(fixture: Fixture, counters: Counters, buildResults: BuildResult[] = [], hooks: BuildHooks = {}): Promise<{ status: number; loaded: string[]; diagnostics: string[] }> {
  const loaded: string[] = [];
  const diagnostics: string[] = [];
  const status = await launcher.__test.runSessionHostLauncher(["--", "--synthetic-cache-test"], {
    getEnv: () => ({ ...fixture.env }),
    processEnv: {},
    platform: process.platform === "darwin" ? "darwin" : "linux",
    nodeVersion: process.versions.node,
    stdinIsTTY: true,
    stdoutIsTTY: true,
    packageRoot: fixture.packageRoot,
    build: async (options: BuildOptions) => {
      if (options.forceFresh) counters.forceFresh += 1;
      const result = await launcher.__test.buildSourceExtension({ ...options, ...buildRunners(counters, hooks), testHooks: hooks.testHooks });
      buildResults.push(result);
      return result;
    },
    resolvePiRuntime: () => {
      counters.pi += 1;
      return { file: "/synthetic/pi", version: "1.1.0", source: "synthetic-test" };
    },
    ensureDdgs: (_home: string, env: NodeJS.ProcessEnv, root: string) => {
      counters.ddgs += 1;
      assert.equal(env.NODE_OPTIONS, fixture.env.NODE_OPTIONS, "the caller NODE_OPTIONS remains unchanged through DDGS setup");
      assert.equal(typeof root, "string");
      return { ok: true, python: "/synthetic/ddgs-python" };
    },
    // The real skill provisioning is exercised by the focused
    // session-host-skill-provisioning tests; cache flow tests stay hermetic.
    refreshShippedSkills: () => ({ ok: true }),
    loadMain: (entry: string) => {
      counters.load += 1;
      loaded.push(entry);
      assert.ok(existsSync(entry), "only an available compiled entry is handed to the module loader");
      return { runSessionHost: (options: { onCacheConsumersSettled: () => void }) => {
        // This fixture owns no real native child. Explicit settlement, not a
        // bare numeric zero, models Main's positive lifecycle handoff.
        options.onCacheConsumersSettled();
        return 0;
      } };
    },
    writeOut: () => undefined,
    writeError: (text: string) => diagnostics.push(text),
  });
  return { status, loaded, diagnostics };
}

nodeTest.describe("source build cache (POSIX)", { skip: process.platform === "win32" }, () => {
nodeTest("unchanged source launches reuse the exact validated build and preserve per-launch preflights", async (t) => {
  const fixture = makeFixture();
  const counters = newCounters();
  const firstResults: BuildResult[] = [];
  const first = await launch(fixture, counters, firstResults);
  assert.equal(first.status, 0);
  assert.equal(firstResults[0].cachePublished, true, "only a completed fresh build publishes a reusable stage");
  const secondResults: BuildResult[] = [];
  const second = await launch(fixture, counters, secondResults);
  assert.equal(second.status, 0);
  assert.equal(secondResults[0].cacheHit, true);
  assert.equal(first.loaded[0], second.loaded[0], "the exact completed stage is reused");
  assert.deepEqual({ npm: counters.npm, compile: counters.compile }, { npm: 1, compile: 1 }, "a cache hit bypasses both npm ci and tsc");
  assert.deepEqual({ pi: counters.pi, ddgs: counters.ddgs, load: counters.load }, { pi: 2, ddgs: 2, load: 2 }, "startup preflights and native loading still run on every launch");

  const cachedRoot = firstResults[0].stagingRoot!;
  const manifestPath = join(cachedRoot, MANIFEST);
  const manifestText = readFileSync(manifestPath, "utf8");
  assert.doesNotMatch(manifestText, /ANTHROPIC_API_KEY|provider-secret|access-token/i, "manifest/key material contains no provider environment or credentials");
  const verifyStarted = performance.now();
  const verification = launcher.__test.validateSourceBuildArtifact(cachedRoot, {
    cacheKey: secondResults[0].cacheKey!,
    sourceFingerprint: secondResults[0].sourceFingerprint!,
    toolchainFingerprint: secondResults[0].toolchainFingerprint!,
  }, secondResults[0].cacheParentChain);
  const verifyMs = performance.now() - verifyStarted;
  assert.ok(verification, "cached artifacts pass bounded content and identity validation");
  t.diagnostic(`synthetic cache verification: ${verifyMs.toFixed(2)}ms, ${verification.files} files, ${verification.bytes} bytes`);
});

nodeTest("content and mode changes across every staged source area invalidate reuse", async () => {
  const fixture = makeFixture();
  const counters = newCounters();
  const first = await build(fixture, counters);
  assert.equal(first.cachePublished, true);
  const changedInputs = [
    ["package.json", (value: string) => value.replace("0.1.0", "0.1.1")],
    ["package-lock.json", (value: string) => value.replace('"lockfileVersion":3', '"lockfileVersion":2')],
    ["tsconfig.json", (value: string) => value.replace('"outDir":"dist"', '"outDir":"dist-new"')],
    [join("src", "session-host", "main.ts"), (value: string) => `${value}// edited\n`],
    [join("scripts", "build-helper.cjs"), (value: string) => `${value}// edited\n`],
    [join("skills", "cache-test", "SKILL.md"), (value: string) => `${value}edited\n`],
  ] as const;
  for (const [relative, update] of changedInputs) {
    const file = join(fixture.packageRoot, relative);
    const before = readFileSync(file, "utf8");
    writeFileSync(file, update(before), "utf8");
    const changed = await build(fixture, counters);
    assert.equal(changed.cachePublished, true, `${relative} change gets a distinct completed cache entry`);
  }
  const modeFile = join(fixture.packageRoot, "src", "session-host", "main.ts");
  chmodSync(modeFile, 0o700);
  const modeChanged = await build(fixture, counters);
  assert.equal(modeChanged.cachePublished, true, "permission-mode changes are fingerprinted even when contents do not change");
  assert.equal(counters.npm, 8);
  assert.equal(counters.compile, 8);
});

nodeTest("toolchain configuration and executable changes invalidate keys; unknown preload hooks bypass reuse", async () => {
  const fixture = makeFixture();
  const counters = newCounters();
  const first = await build(fixture, counters);
  assert.equal(first.cachePublished, true);
  const envChanged = { ...fixture.env, NODE_ENV: "production" };
  const second = await build(fixture, counters, envChanged);
  assert.equal(second.cachePublished, true, "NODE_ENV is part of the toolchain/configuration identity");
  const npmSource = readFileSync(fixture.npmCli, "utf8");
  writeFileSync(fixture.npmCli, `${npmSource}// changed npm toolchain\n`, "utf8");
  const npmChanged = await build(fixture, counters, envChanged);
  assert.equal(npmChanged.cachePublished, true, "the npm executable's content identity participates in the key");
  const helper = join(fixture.bin, "npm-helper.cjs");
  const helperSource = readFileSync(helper, "utf8");
  writeFileSync(helper, `${helperSource}// helper-only toolchain change\n`, "utf8");
  const helperChanged = await build(fixture, counters, envChanged);
  assert.equal(helperChanged.cachePublished, true, "npm implementation helpers participate in the toolchain fingerprint");
  assert.notEqual(helperChanged.cacheKey, npmChanged.cacheKey, "changing only an imported npm helper changes the cache key");
  const hookedEnv = { ...envChanged, NODE_OPTIONS: "--no-warnings --require=/external/untracked-preload.cjs" };
  assert.equal(launcher.__test.sourceBuildCacheEligible(fixture.packageRoot, hookedEnv), false);
  assert.equal(launcher.__test.sourceBuildCacheEligible(fixture.packageRoot, { ...envChanged, HTTPS_PROXY: "https://user:credential@example.invalid" }), false,
    "unkeyed proxy configuration bypasses reuse without persisting proxy credentials");
  const firstHooked = await build(fixture, counters, hookedEnv);
  const secondHooked = await build(fixture, counters, hookedEnv);
  assert.equal(firstHooked.cachePublished, false);
  assert.equal(secondHooked.cacheHit, false, "untracked preload hooks force fresh setup despite unchanged option text");
  assert.equal(counters.npm, 6);
  assert.equal(counters.compile, 6);
});

nodeTest("equivalent re-extracted npm trees reuse by content while each invocation remains identity-fenced", async () => {
  const fixture = makeFixture();
  const counters = newCounters();
  const first = await build(fixture, counters);
  assert.equal(first.cachePublished, true);
  const alternateBin = join(fixture.root, "re-extracted npm bin");
  mkdirSync(alternateBin, { mode: 0o700 });
  for (const name of ["package.json", "npm-helper.cjs", "npm"]) {
    writePrivateFile(join(alternateBin, name), readFileSync(join(fixture.bin, name), "utf8"), name === "npm" ? 0o700 : 0o600);
  }
  const alternateEnv = { ...fixture.env, PATH: alternateBin };
  const relocated = await build(fixture, counters, alternateEnv);
  assert.equal(relocated.cacheHit, true, "toolchain content identity is stable across absolute npm extraction paths");
  assert.equal(relocated.cacheKey, first.cacheKey);
  assert.deepEqual({ npm: counters.npm, compile: counters.compile }, { npm: 1, compile: 1 });

  const helper = join(alternateBin, "npm-helper.cjs");
  const helperSource = readFileSync(helper, "utf8");
  const raced = await build(fixture, counters, alternateEnv, {
    testHooks: { afterToolchainFingerprint: () => writeFileSync(helper, `${helperSource}// changed after fingerprint\n`, "utf8") },
  });
  assert.equal(raced.status, 1, "a toolchain mutation between fingerprinting and admission fails closed");
  assert.notEqual(raced.cacheHit, true);
  assert.deepEqual({ npm: counters.npm, compile: counters.compile }, { npm: 1, compile: 1 },
    "the mutated npm implementation is not invoked and the old cache is not adopted");
});

nodeTest("source fingerprint final sweep catches an earlier file rewritten during later reads", () => {
  const fixture = makeFixture();
  let firstFile = "";
  let changed = false;
  assert.throws(() => launcher.__test.fingerprintSourcePackage(fixture.packageRoot, {
    afterSourceFileHashed(file) {
      if (!firstFile) {
        firstFile = file;
        return;
      }
      if (changed) return;
      changed = true;
      const original = readFileSync(firstFile, "utf8");
      const replacement = original.replace("0.1.0", "0.1.1");
      assert.equal(replacement.length, original.length);
      writeFileSync(firstFile, replacement, "utf8");
    },
  }), /source file changed during fingerprinting/);
  assert.equal(changed, true);
});

nodeTest("tampered cached contents are preserved and replaced by a fresh build before DDGS or load", async () => {
  const fixture = makeFixture();
  const counters = newCounters();
  const firstResults: BuildResult[] = [];
  const first = await launch(fixture, counters, firstResults);
  assert.equal(first.status, 0);
  const cachedRoot = firstResults[0].stagingRoot!;
  const damaged = join(cachedRoot, "dist", "src", "session-host", "main.js");
  writeFileSync(damaged, "tampered but preserve me\n", "utf8");

  const secondResults: BuildResult[] = [];
  const second = await launch(fixture, counters, secondResults);
  assert.equal(second.status, 0);
  assert.equal(counters.forceFresh, 1, "failed content verification triggers a fresh private build");
  assert.equal(secondResults[0].cacheHit, true, "the cache candidate is rechecked by the launcher before use");
  assert.equal(secondResults.at(-1)?.cacheHit, false, "the replacement is a fresh build, not the damaged cache candidate");
  assert.notEqual(second.loaded[0], damaged, "the invalid cache entry is never loaded");
  assert.equal(readFileSync(damaged, "utf8"), "tampered but preserve me\n", "unknown/corrupt cache contents are never removed");
  assert.equal(counters.npm, 2);
  assert.equal(counters.compile, 2);
});

nodeTest("final artifact snapshot sweep rejects an earlier file rewritten during a later read and rebuilds before load", async () => {
  const fixture = makeFixture();
  const counters = newCounters();
  const firstResults: BuildResult[] = [];
  const first = await launch(fixture, counters, firstResults);
  assert.equal(first.status, 0);
  const cacheRoot = firstResults[0].stagingRoot!;
  let firstFile = "";
  let replacement = "";
  let changed = false;
  const racedResults: BuildResult[] = [];
  const raced = await launch(fixture, counters, racedResults, {
    testHooks: {
      afterArtifactFileHashed(file) {
        if (!firstFile) {
          firstFile = file;
          return;
        }
        if (changed) return;
        changed = true;
        const original = readFileSync(firstFile, "utf8");
        replacement = `${original[0] === "X" ? "Y" : "X"}${original.slice(1)}`;
        assert.equal(replacement.length, original.length);
        writeFileSync(firstFile, replacement, "utf8");
      },
    },
  });
  assert.equal(changed, true, "the cache scan rewrites a previously hashed file in place");
  assert.equal(raced.status, 0);
  assert.equal(counters.forceFresh, 1, "the final metadata sweep forces a separate fresh stage");
  assert.equal(racedResults[0].cacheHit, true, "the candidate is rejected by full verification before DDGS/load");
  assert.equal(racedResults.at(-1)?.cacheHit, false);
  assert.notEqual(raced.loaded[0], join(cacheRoot, "dist", "src", "session-host", "main.js"));
  assert.equal(readFileSync(firstFile, "utf8"), replacement, "the raced cache contents are preserved");
  assert.equal(counters.npm, 2);
  assert.equal(counters.compile, 2);
});

nodeTest("final artifact verification fences live source and npm changes through the scan", async () => {
  for (const kind of ["source", "npm"] as const) {
    const fixture = makeFixture();
    const counters = newCounters();
    const first = await launch(fixture, counters);
    assert.equal(first.status, 0);
    let changed = false;
    const second = await launch(fixture, counters, [], {
      testHooks: {
        afterArtifactFileHashed() {
          if (changed || counters.ddgs !== 2) return;
          changed = true;
          const file = kind === "source"
            ? join(fixture.packageRoot, "src", "session-host", "main.ts")
            : join(fixture.bin, "npm-helper.cjs");
          writeFileSync(file, `${readFileSync(file, "utf8")}// raced input\n`, "utf8");
        },
      },
    });
    assert.equal(changed, true, `${kind} mutation occurs during the post-DDGS artifact scan`);
    assert.equal(second.status, 0);
    assert.equal(counters.forceFresh, 1, `${kind} mutation forces rebuilding`);
    assert.notEqual(second.loaded[0], first.loaded[0], "the stale stage is never loaded");
    assert.deepEqual({ npm: counters.npm, compile: counters.compile }, { npm: 2, compile: 2 });
    assert.equal(counters.ddgs, 3, "DDGS is revalidated against the replacement stage");
  }
});

nodeTest("cached symlinks and unlisted entries fail validation without pruning", async () => {
  const fixture = makeFixture();
  const counters = newCounters();
  const firstResults: BuildResult[] = [];
  const first = await launch(fixture, counters, firstResults);
  assert.equal(first.status, 0);
  const root = firstResults[0].stagingRoot!;
  const main = join(root, "dist", "src", "session-host", "main.js");
  const foreign = join(fixture.root, "foreign-output.js");
  writePrivateFile(foreign, "foreign sentinel\n");
  unlinkSync(main);
  symlinkSync(foreign, main);

  const secondResults: BuildResult[] = [];
  const second = await launch(fixture, counters, secondResults);
  assert.equal(second.status, 0);
  assert.equal(counters.forceFresh, 1, "the cached symlink forces a fresh stage");
  assert.equal(lstatSync(main).isSymbolicLink(), true, "the invalid symlink is preserved, not followed or deleted");
  assert.equal(readFileSync(foreign, "utf8"), "foreign sentinel\n");
  const unexpected = join(root, "unknown-cache-entry");
  writePrivateFile(unexpected, "preserve this entry\n");
  const validation = launcher.__test.validateSourceBuildArtifact(root, {
    cacheKey: firstResults[0].cacheKey!,
    sourceFingerprint: firstResults[0].sourceFingerprint!,
    toolchainFingerprint: firstResults[0].toolchainFingerprint!,
  }, firstResults[0].cacheParentChain);
  assert.equal(validation, undefined, "unlisted artifact content invalidates the manifest");
  assert.equal(readFileSync(unexpected, "utf8"), "preserve this entry\n");
});

nodeTest("staging rejects edits restored during copy and verifies copied bytes before npm or tsc", async () => {
  const fixture = makeFixture();
  const counters = newCounters();
  const source = join(fixture.packageRoot, "src", "session-host", "main.ts");
  const original = readFileSync(source, "utf8");
  const mutated = original.replace("original", "mutated ");
  assert.equal(mutated.length, original.length);
  let copiedDestination = "";
  const racedCopy = await build(fixture, counters, fixture.env, {
    testHooks: {
      beforeSourceCopyRead(file, destination) {
        if (file !== source || copiedDestination) return;
        copiedDestination = destination;
        writeFileSync(source, mutated, "utf8");
      },
      afterSourceCopyRead(file) {
        if (file === source && copiedDestination) writeFileSync(source, original, "utf8");
      },
    },
  });
  assert.equal(racedCopy.status, 1, "copy-time snapshot detects a same-size edit restored before the source rehash");
  assert.match(racedCopy.error?.message ?? "", /could not stage the source package/);
  assert.equal(readFileSync(source, "utf8"), original, "the raced source is restored exactly");
  assert.equal(readFileSync(copiedDestination, "utf8"), mutated, "the stage witness contains the raced bytes");
  assert.deepEqual({ npm: counters.npm, compile: counters.compile }, { npm: 0, compile: 0 });
  assert.equal(racedCopy.cachePublished, undefined);

  const modifiedStageFixture = makeFixture();
  const modifiedStageCounters = newCounters();
  const stagedMismatch = await build(modifiedStageFixture, modifiedStageCounters, modifiedStageFixture.env, {
    testHooks: {
      afterSourceStageCreated(stageRoot) {
        const stagedSource = join(stageRoot, "src", "session-host", "main.ts");
        writeFileSync(stagedSource, "// different staged input\n", "utf8");
      },
    },
  });
  assert.equal(stagedMismatch.status, 1);
  assert.match(stagedMismatch.diagnostics ?? "", /staged source inputs do not match/);
  assert.deepEqual({ npm: modifiedStageCounters.npm, compile: modifiedStageCounters.compile }, { npm: 0, compile: 0 });
  assert.equal(stagedMismatch.cachePublished, undefined);
});

nodeTest("exclusive cache-record publication preserves an empty competing target", async () => {
  const fixture = makeFixture();
  const counters = newCounters();
  let target = "";
  let createdIdentity: { dev: bigint; ino: bigint } | undefined;
  const result = await build(fixture, counters, fixture.env, {
    testHooks: {
      beforeCacheRecord(recordPath) {
        target = recordPath;
        mkdirSync(target, { mode: 0o700 });
        const stats = lstatSync(target, { bigint: true });
        createdIdentity = { dev: stats.dev, ino: stats.ino };
      },
    },
  });
  assert.equal(result.status, 0, "a failed cache publication does not invalidate the fresh build");
  assert.equal(result.cachePublished, false);
  assert.equal(result.cacheHit, false);
  assert.equal(result.stagingRoot && existsSync(result.stagingRoot), true, "the completed stage remains available for this launch");
  const after = lstatSync(target, { bigint: true });
  assert.equal(after.isDirectory(), true, "the competing empty directory is preserved");
  assert.equal(after.dev, createdIdentity?.dev);
  assert.equal(after.ino, createdIdentity?.ino);
  assert.deepEqual({ npm: counters.npm, compile: counters.compile }, { npm: 1, compile: 1 });
});

nodeTest("failed installation/compile and source races never publish a reusable build", async () => {
  const fixture = makeFixture();
  const counters = newCounters();
  const installFailure = await build(fixture, counters, fixture.env, {
    install: () => ok({ status: 23 }),
  });
  assert.equal(installFailure.stage, "install");
  assert.equal(installFailure.cachePublished, undefined);
  const compileFailure = await build(fixture, counters, fixture.env, {
    compile: () => ok({ status: 24 }),
  });
  assert.equal(compileFailure.stage, "compile");
  assert.equal(compileFailure.cachePublished, undefined);
  const success = await build(fixture, counters);
  assert.equal(success.cachePublished, true, "a later complete build can publish independently of failed stages");
  const hit = await build(fixture, counters);
  assert.equal(hit.cacheHit, true);
  assert.equal(counters.npm, 3);
  assert.equal(counters.compile, 2);

  const raced = makeFixture();
  const raceCounters = newCounters();
  const raceResult = await build(raced, raceCounters, raced.env, {
    compile: (stageRoot) => {
      writeSyntheticOutput(stageRoot);
      writeFileSync(join(raced.packageRoot, "src", "session-host", "main.ts"), "// changed during tsc\n", "utf8");
      return ok();
    },
  });
  assert.equal(raceResult.status, 1);
  assert.match(raceResult.diagnostics ?? "", /source changed during the staged build/);
  assert.equal(raceResult.cachePublished, undefined);
  const recovered = await build(raced, raceCounters);
  assert.equal(recovered.cachePublished, true, "a fresh build of the new source state can be cached");
});

nodeTest("concurrent builds keep independent stages and publish at most one completed cache", async () => {
  const fixture = makeFixture();
  const counters = newCounters();
  let installCount = 0;
  let releaseInstall!: () => void;
  const installBarrier = new Promise<void>((resolve) => { releaseInstall = resolve; });
  const hooks: BuildHooks = {
    install: async (stageRoot) => {
      writeSyntheticCompiler(stageRoot);
      installCount += 1;
      if (installCount === 2) releaseInstall();
      await installBarrier;
      return ok();
    },
  };
  const [left, right] = await Promise.all([
    build(fixture, counters, fixture.env, hooks),
    build(fixture, counters, fixture.env, hooks),
  ]);
  assert.equal(left.status, 0);
  assert.equal(right.status, 0);
  assert.equal(Number(left.cachePublished) + Number(right.cachePublished), 1, "exclusive cache publication has one winner");
  assert.notEqual(left.stagingRoot, right.stagingRoot, "the concurrent loser keeps its independent fresh stage");
  const next = await build(fixture, counters, fixture.env, {
    install: () => { throw new Error("a complete concurrent cache must bypass npm"); },
    compile: () => { throw new Error("a complete concurrent cache must bypass tsc"); },
  });
  assert.equal(next.cacheHit, true);
  assert.equal(counters.npm, 2);
  assert.equal(counters.compile, 2);
});
});
