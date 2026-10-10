import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, opendirSync, readFileSync, readdirSync, realpathSync, renameSync, rmdirSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, delimiter, dirname, isAbsolute, join } from "node:path";
import nodeTest, { type TestContext } from "node:test";

interface ParsedArguments {
  help: boolean;
  piExecutable?: string;
  stateRoot?: string;
  toggleKey?: string;
  args: string[];
}

interface HostOptions {
  packageRoot: string;
  piExecutable?: string;
  stateRoot?: string;
  toggleKey?: string;
  args: readonly string[];
  env: NodeJS.ProcessEnv;
}

interface PiRuntimeResult {
  file: string;
  version: string;
  source: string;
}

interface BuildResult {
  status: number | null;
  // Which admitted stage failed, so an operator can tell install from compile.
  stage?: "install" | "compile" | "stage";
  // Bounded, sanitized, provenance-labelled child output for that stage.
  diagnostics?: string;
  childStatus?: number | null;
  error?: Error;
  signal?: string | null;
  cleanupConfirmed?: boolean;
  timedOut?: boolean;
  outputExceeded?: boolean;
  retainedStage?: boolean;
  stagingRoot?: string;
  ownedStage?: OwnedStage;
}

interface BoundedProcessResult {
  status: number | null;
  signal: string | null;
  error?: Error;
  cleanupConfirmed?: boolean;
  timedOut: boolean;
  outputExceeded: boolean;
  stdout: string;
  // Present only when the caller admitted stderr capture for this child.
  stderr?: string;
}

interface LauncherOverrides {
  getEnv?: () => NodeJS.ProcessEnv;
  platform?: string;
  nodeVersion?: string;
  stdinIsTTY?: boolean;
  stdoutIsTTY?: boolean;
  packageRoot?: string;
  cwd?: string;
  processEnv?: NodeJS.ProcessEnv;
  build?: (options: { packageRoot: string; agentDir: string; env: NodeJS.ProcessEnv }) => BuildResult | Promise<BuildResult>;
  ensureDdgs?: (homeDir: string, env: NodeJS.ProcessEnv, packageRoot?: string) => { ok: boolean; python?: string; exitCode?: number; cleanupUnconfirmed?: boolean } | Promise<{ ok: boolean; python?: string; exitCode?: number; cleanupUnconfirmed?: boolean }>;
  resolvePiRuntime?: (options: { explicit?: string; env: NodeJS.ProcessEnv; agentDir: string; cwd: string; writeError: (text: string) => void }) => PiRuntimeResult | Promise<PiRuntimeResult>;
  isRegularFile?: (file: string) => boolean;
  loadMain?: (entry: string) => { runSessionHost(options: HostOptions): Promise<number> | number };
  writeOut?: (text: string) => void;
  writeError?: (text: string) => void;
}

interface OwnedStage {
  root: string;
  identity: { dev: bigint; ino: bigint };
  chain?: Array<{ target: string; identity: { dev: bigint; ino: bigint } }>;
}

interface LauncherModule {
  USAGE: string;
  PI_PACKAGE_NAME: string;
  PI_MIN_VERSION: readonly number[];
  PI_PROVISION_VERSION: string;
  parseSessionHostArguments(argv: readonly string[]): ParsedArguments;
  __test: {
    runSessionHostLauncher(argv: readonly string[], overrides?: LauncherOverrides): Promise<number>;
    resolvePiRuntime(options: { explicit?: string; env: NodeJS.ProcessEnv; agentDir: string; cwd: string; writeError: (text: string) => void }): Promise<PiRuntimeResult>;
    buildSourceExtension(options: { packageRoot: string; agentDir: string; env: NodeJS.ProcessEnv; sourceBuildTimeoutMs?: number; runNpm?: (npmCli: string, args: string[], options: Record<string, unknown>) => Promise<BoundedProcessResult>; runCompile?: (compilerCli: string, args: string[], options: Record<string, unknown>) => Promise<BoundedProcessResult> }): Promise<BuildResult>;
    provisionPiRuntime(options: { env: NodeJS.ProcessEnv; agentDir: string; writeError: (text: string) => void; npmCli?: string; beforeVersionRootMkdir?: (versionRoot: string) => void; runNpm?: (npmCli: string, args: string[], options: Record<string, unknown>) => Promise<BoundedProcessResult>; processRunner?: (file: string, args: string[], options: Record<string, unknown>) => Promise<BoundedProcessResult>; validatePiPackage?: (pkgDir: string, env: NodeJS.ProcessEnv, options?: { exactVersion?: string }) => Promise<{ file: string; version: string }> }): Promise<PiRuntimeResult>;
    validatePiPackage(pkgDir: string, env: NodeJS.ProcessEnv, options?: { expectedFile?: string; exactVersion?: string; processRunner?: (file: string, args: string[], options: Record<string, unknown>) => Promise<BoundedProcessResult> }): Promise<{ file: string; version: string }>;
    probePiVersion(file: string, env: NodeJS.ProcessEnv, processRunner?: (file: string, args: string[], options: Record<string, unknown>) => Promise<BoundedProcessResult>): Promise<string>;
    runDdgsSetup(homeDir: string, env: NodeJS.ProcessEnv, packageRoot: string, processRunner?: (file: string, args: string[], options: Record<string, unknown>) => Promise<BoundedProcessResult>): Promise<{ ok: boolean; python?: string; exitCode?: number; cleanupUnconfirmed?: boolean }>;
    stageSourcePackage(packageRoot: string, buildCacheRoot: string): OwnedStage;
    createOwnedStage(parent: string, prefix: string, randomBytes?: (size: number) => Buffer): OwnedStage;
    removeOwnedStage(target: OwnedStage): boolean;
    findNpmCli(env: NodeJS.ProcessEnv): string | undefined;
    findPiOnPath(env: NodeJS.ProcessEnv): string | undefined;
    runBoundedProcess(file: string, args: string[], options: Record<string, unknown>): Promise<BoundedProcessResult>;
    sanitizeDiagnosticText(text: string): string;
    boundDiagnosticText(text: string, limitBytes: number): string;
    formatBuildStageDiagnostics(result: { stdout?: string; stderr?: string } | undefined, stage: "install" | "compile" | "stage"): string;
    activeBoundedProcessCount(): number;
    boundedProcessCleanupStatus(input: {
      closed: boolean;
      pid?: number;
      platform: string;
      timedOut: boolean;
      outputExceeded: boolean;
      normalExit: boolean;
      groupStillExists(): boolean;
    }): boolean | undefined;
  };
}

const requireCjs = createRequire(join(process.cwd(), "tests", "session-host-launcher.test.ts"));
const fsNative = requireCjs("node:fs") as typeof import("node:fs");
const launcher = requireCjs("../scripts/pi-review-sessions.cjs") as LauncherModule;
const gateLauncher = requireCjs("../scripts/pi-review-gate-launcher.cjs") as { ensureDdgs(homeDir: string, env: NodeJS.ProcessEnv): { ok: boolean; python?: string; exitCode?: number } };
const SCRIPT = join(process.cwd(), "scripts", "pi-review-sessions.cjs");

interface OwnedFixture {
  root: string;
  identity: { dev: bigint; ino: bigint };
  assertionsComplete?: boolean;
  processCleanupConfirmed?: boolean;
}

const fixturesByTest = new WeakMap<TestContext, OwnedFixture[]>();
type TestBody = (t: TestContext) => unknown;
type TestOptions = { skip?: boolean | string; todo?: boolean | string; only?: boolean; timeout?: number; concurrency?: number | boolean };

async function runTrackedTestBody(t: TestContext, body: TestBody): Promise<void> {
  const fixtures: OwnedFixture[] = [];
  fixturesByTest.set(t, fixtures);
  let completed = false;
  try {
    await body(t);
    completed = true;
  } finally {
    for (const fixture of fixtures) {
      fixture.assertionsComplete = completed;
      // Direct-child exit or signal delivery alone does not authorize fixture
      // cleanup; unconfirmed setup groups remain counted.
      fixture.processCleanupConfirmed = completed && launcher.__test.activeBoundedProcessCount() === 0;
      t.after(() => {
        if (!fixture.assertionsComplete || !fixture.processCleanupConfirmed) {
          t.diagnostic(`Retained failed-test fixture witness at ${fixture.root}`);
          return;
        }
        if (!removeFixtureTree(fixture.root, fixture.root, fixture.identity)) {
          t.diagnostic(`Retained fixture that could not be safely removed at ${fixture.root}`);
        }
      });
    }
    fixturesByTest.delete(t);
  }
}

function test(name: string, body: TestBody): void;
function test(name: string, options: TestOptions, body: TestBody): void;
function test(name: string, optionsOrBody: TestOptions | TestBody, maybeBody?: TestBody): void {
  const body = typeof optionsOrBody === "function" ? optionsOrBody : maybeBody;
  if (!body) throw new Error("test body is required");
  const trackedBody = (t: TestContext): Promise<void> => runTrackedTestBody(t, body);
  if (typeof optionsOrBody === "function") {
    void nodeTest(name, trackedBody);
  } else {
    void nodeTest(name, optionsOrBody as never, trackedBody);
  }
}

function makePackageFixture(source: boolean): { root: string; packageRoot: string; identity: OwnedFixture["identity"] } {
  const root = mkdtempSync(join(process.cwd(), "node_modules", ".session-host-launcher-fixture-"));
  const rootStats = lstatSync(root, { bigint: true });
  const packageRoot = join(root, "package root π");
  mkdirSync(join(packageRoot, "dist", "src", "session-host"), { recursive: true });
  mkdirSync(join(packageRoot, "scripts"), { recursive: true });
  mkdirSync(join(packageRoot, "skills"), { recursive: true });
  writeFileSync(join(packageRoot, "package.json"), JSON.stringify({ name: "pi-review-gate", version: "0.1.0", scripts: { build: "tsc -p tsconfig.json" } }), "utf8");
  writeFileSync(join(packageRoot, "package-lock.json"), JSON.stringify({ name: "pi-review-gate", version: "0.1.0", lockfileVersion: 3, requires: true, packages: { "": { name: "pi-review-gate", version: "0.1.0" } } }), "utf8");
  writeFileSync(join(packageRoot, "tsconfig.json"), JSON.stringify({ compilerOptions: { outDir: "dist" }, include: ["src/**/*.ts"] }), "utf8");
  // Sentinel content: source-build tests assert the live dist survives.
  writeFileSync(join(packageRoot, "dist", "src", "session-host", "main.js"), "LIVE DIST SENTINEL — never rebuild in place\n", "utf8");
  if (source) {
    mkdirSync(join(packageRoot, "src", "session-host"), { recursive: true });
    writeFileSync(join(packageRoot, "src", "session-host", "main.ts"), "// source marker\n", "utf8");
  }
  return { root, packageRoot, identity: { dev: rootStats.dev, ino: rootStats.ino } };
}

/**
 * Inert synthetic installed TypeScript package inside an owned stage. The
 * launcher only ever resolves and identity-checks this entry; no test executes
 * it as a compiler, so its content is deliberately inert. Fixtures are small
 * and fixed (three files) and are retained, never recursively cleaned.
 */
function writeInertStageTypeScript(stageRoot: string): void {
  const packageDir = join(stageRoot, "node_modules", "typescript");
  mkdirSync(join(packageDir, "bin"), { recursive: true });
  writeFileSync(join(packageDir, "package.json"), JSON.stringify({ name: "typescript", version: "5.7.2", bin: { tsc: "./bin/tsc" } }), { encoding: "utf8", flag: "wx" });
  writeFileSync(join(packageDir, "bin", "tsc"), "// inert synthetic compiler: never executed by the launcher\n", { encoding: "utf8", flag: "wx" });
}

/** The same inert installed layout, as JS source lines for a fake npm script. */
function inertStageTypeScriptScriptLines(): string[] {
  return [
    `const tscPkg = require("node:path").join(process.cwd(), "node_modules", "typescript");`,
    `fs.mkdirSync(require("node:path").join(tscPkg, "bin"), { recursive: true });`,
    `fs.writeFileSync(require("node:path").join(tscPkg, "package.json"), JSON.stringify({ name: "typescript", version: "5.7.2", bin: { tsc: "./bin/tsc" } }), { flag: "wx" });`,
    `fs.writeFileSync(require("node:path").join(tscPkg, "bin", "tsc"), "// inert synthetic compiler: never executed by the launcher\\n", { flag: "wx" });`,
  ];
}

function sameFixtureDirectoryChain(chain: Array<{ target: string; identity: OwnedFixture["identity"] }>): boolean {
  for (const { target, identity } of chain) {
    try {
      const current = lstatSync(target, { bigint: true });
      if (!current.isDirectory() || current.isSymbolicLink() || current.dev !== identity.dev || current.ino !== identity.ino) return false;
    } catch {
      return false;
    }
  }
  return true;
}

function removeFixtureTree(
  target: string,
  root: string,
  identity: OwnedFixture["identity"],
  budget = { entries: 0, bytes: 0 },
  depth = 0,
  ancestors: Array<{ target: string; identity: OwnedFixture["identity"] }> = [],
  expectedEntry?: { dev: bigint; ino: bigint },
): boolean {
  if (basename(target) === ".terraform") return false;
  if (depth > 128 || budget.entries >= 200_000) return false;
  budget.entries += 1;
  let stats;
  try {
    stats = lstatSync(target, { bigint: true });
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT";
  }
  if (target === root && (stats.dev !== identity.dev || stats.ino !== identity.ino || !stats.isDirectory() || stats.isSymbolicLink())) return false;
  const activeChain = ancestors.length > 0 ? ancestors : [{ target: root, identity }];
  if (!sameFixtureDirectoryChain(activeChain)) return false;
  if (expectedEntry && (stats.dev !== expectedEntry.dev || stats.ino !== expectedEntry.ino)) return false;
  if (stats.isSymbolicLink()) {
    try {
      if (!sameFixtureDirectoryChain(activeChain)) return false;
      const current = lstatSync(target, { bigint: true });
      if (!current.isSymbolicLink() || current.dev !== stats.dev || current.ino !== stats.ino) return false;
      unlinkSync(target);
      return true;
    } catch {
      return false;
    }
  }
  if (stats.isFile()) {
    if (stats.size > BigInt(4 * 1024 * 1024 * 1024 - budget.bytes)) return false;
    budget.bytes += Number(stats.size);
    try {
      if (!sameFixtureDirectoryChain(activeChain)) return false;
      const current = lstatSync(target, { bigint: true });
      if (!current.isFile() || current.isSymbolicLink() || current.dev !== stats.dev || current.ino !== stats.ino) return false;
      unlinkSync(target);
      return true;
    } catch {
      return false;
    }
  }
  if (!stats.isDirectory()) return false;
  const directoryIdentity = { dev: stats.dev, ino: stats.ino };
  if (!sameFixtureDirectoryChain(activeChain)) return false;
  const directoryChain = target === root ? activeChain : [...activeChain, { target, identity: directoryIdentity }];
  let complete = true;
  let directory;
  try {
    directory = opendirSync(target);
  } catch {
    return false;
  }
  try {
    for (;;) {
      if (!sameFixtureDirectoryChain(directoryChain)) {
        complete = false;
        break;
      }
      const entry = directory.readSync();
      if (!entry) break;
      const name = entry.name;
      budget.entries += 1;
      if (budget.entries > 200_000) {
        complete = false;
        break;
      }
      if (name === ".terraform") {
        complete = false;
        continue;
      }
      if (!sameFixtureDirectoryChain(directoryChain)) {
        complete = false;
        break;
      }
      const childPath = join(target, name);
      let childStats;
      try {
        childStats = lstatSync(childPath, { bigint: true });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        complete = false;
        continue;
      }
      if (!sameFixtureDirectoryChain(directoryChain)) {
        complete = false;
        break;
      }
      if (!removeFixtureTree(childPath, root, identity, budget, depth + 1, directoryChain, childStats)) complete = false;
    }
  } finally {
    try {
      directory.closeSync();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ERR_DIR_CLOSED") throw error;
    }
  }
  try {
    const after = lstatSync(target, { bigint: true });
    if (!complete || !sameFixtureDirectoryChain(activeChain) || after.isSymbolicLink() || !after.isDirectory() || after.dev !== stats.dev || after.ino !== stats.ino) return false;
    const final = lstatSync(target, { bigint: true });
    if (!sameFixtureDirectoryChain(activeChain) || final.isSymbolicLink() || !final.isDirectory() || final.dev !== stats.dev || final.ino !== stats.ino) return false;
    rmdirSync(target);
    return true;
  } catch {
    return false;
  }
}

function cleanupFixture(t: TestContext, fixture: OwnedFixture): void {
  const fixtures = fixturesByTest.get(t);
  if (!fixtures) throw new Error("fixture cleanup must be registered by its owning test callback");
  fixtures.push(fixture);
}

function withOpendirHook<T>(hook: (path: unknown) => void, action: () => T): T {
  const originalDescriptor = Object.getOwnPropertyDescriptor(fsNative, "opendirSync");
  assert.ok(originalDescriptor);
  const original = fsNative.opendirSync;
  const patched = (...args: Parameters<typeof fsNative.opendirSync>) => {
    const directory = Reflect.apply(original, fsNative, args) as ReturnType<typeof fsNative.opendirSync>;
    hook(args[0]);
    return directory;
  };
  Object.defineProperty(fsNative, "opendirSync", { ...originalDescriptor, value: patched });
  try {
    return action();
  } finally {
    Object.defineProperty(fsNative, "opendirSync", originalDescriptor);
  }
}

function withOpenSyncHook<T>(hook: (path: unknown) => void, action: () => T): T {
  const originalDescriptor = Object.getOwnPropertyDescriptor(fsNative, "openSync");
  assert.ok(originalDescriptor);
  const original = fsNative.openSync;
  const patched = (...args: Parameters<typeof fsNative.openSync>) => {
    hook(args[0]);
    return Reflect.apply(original, fsNative, args) as ReturnType<typeof fsNative.openSync>;
  };
  Object.defineProperty(fsNative, "openSync", { ...originalDescriptor, value: patched });
  try {
    return action();
  } finally {
    Object.defineProperty(fsNative, "openSync", originalDescriptor);
  }
}

test("a failed assertion retains its private fixture witness", async (t) => {
  const fixture = makePackageFixture(false);
  cleanupFixture(t, fixture);
  const afterHooks: Array<() => void> = [];
  const diagnostics: string[] = [];
  const failedContext = {
    after: (callback: () => void) => { afterHooks.push(callback); },
    diagnostic: (message: string) => { diagnostics.push(message); },
  } as unknown as TestContext;

  await assert.rejects(
    () => runTrackedTestBody(failedContext, (failedTest) => {
      cleanupFixture(failedTest, fixture);
      assert.fail("synthetic assertion failure");
    }),
    /synthetic assertion failure/,
  );
  assert.equal(afterHooks.length, 1);
  afterHooks[0]();
  assert.equal(existsSync(fixture.root), true, "failed test cleanup leaves the private witness intact");
  assert.match(diagnostics[0], /Retained failed-test fixture witness/);
});

test("fixture cleanup aborts before following a replaced nested directory", (t) => {
  const fixture = makePackageFixture(false);
  cleanupFixture(t, fixture);
  const outsideRoot = mkdtempSync(join(process.cwd(), "node_modules", ".session-host-cleanup-outside-"));
  const outsideStats = lstatSync(outsideRoot, { bigint: true });
  cleanupFixture(t, { root: outsideRoot, identity: { dev: outsideStats.dev, ino: outsideStats.ino } });
  const nested = join(fixture.root, "nested");
  const held = join(outsideRoot, "held-original");
  const victim = join(outsideRoot, "victim");
  mkdirSync(nested);
  mkdirSync(victim);
  writeFileSync(join(nested, "original-sentinel"), "original stays\n", "utf8");
  writeFileSync(join(victim, "outside-sentinel"), "outside stays\n", "utf8");

  let replaced = false;
  const removed = withOpendirHook((openedPath) => {
    if (openedPath === nested && !replaced) {
      replaced = true;
      renameSync(nested, held);
      symlinkSync(victim, nested);
    }
  }, () => removeFixtureTree(fixture.root, fixture.root, fixture.identity));
  assert.equal(replaced, true);
  assert.equal(removed, false, "fixture cleanup refuses the changed active directory chain");
  assert.equal(readFileSync(join(held, "original-sentinel"), "utf8"), "original stays\n");
  assert.equal(readFileSync(join(victim, "outside-sentinel"), "utf8"), "outside stays\n");
  assert.equal(lstatSync(nested).isSymbolicLink(), true);

  unlinkSync(nested);
  renameSync(held, nested);
  assert.equal(removeFixtureTree(fixture.root, fixture.root, fixture.identity), true, "the restored owned fixture is cleanable");
});

function makeEnvironment(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH,
    HOME: process.cwd(),
    ...overrides,
  };
}

function baseOverrides(
  packageRoot: string,
  env: NodeJS.ProcessEnv,
  events: string[],
  hostOptions: HostOptions[],
  overrides: LauncherOverrides = {},
): LauncherOverrides {
  return {
    getEnv: () => env,
    processEnv: {},
    platform: "linux",
    nodeVersion: "22.19.0",
    stdinIsTTY: true,
    stdoutIsTTY: true,
    packageRoot,
    build: ({ packageRoot: root, env: setupEnv }) => {
      events.push("build");
      assert.equal(root, packageRoot);
      assert.equal(setupEnv.PI_REVIEW_GATE_SESSION_HOST_BOOTSTRAP, undefined);
      assert.equal(setupEnv.PI_REVIEW_GATE_SESSION_HOST_NODE_OPTIONS_RESTORE, undefined);
      assert.equal(setupEnv.PI_REVIEW_GATE_SETTLEMENT_SECRET, undefined);
      assert.equal(setupEnv.PI_REVIEW_GATE_QUIESCENCE_CHILD, undefined);
      return { status: 0 };
    },
    resolvePiRuntime: (options) => {
      events.push("pi");
      assert.equal(options.env.PI_REVIEW_GATE_SESSION_HOST_BOOTSTRAP, undefined);
      assert.equal(options.env.PI_REVIEW_GATE_SESSION_HOST_NODE_OPTIONS_RESTORE, undefined);
      assert.equal(options.env.PI_REVIEW_GATE_SETTLEMENT_SECRET, undefined);
      assert.equal(options.env.PI_REVIEW_GATE_QUIESCENCE_CHILD, undefined);
      return { file: "/synthetic/pi", version: "1.0.4", source: "npm-global" };
    },
    ensureDdgs: (homeDir, setupEnv) => {
      events.push("ddgs");
      assert.equal(setupEnv.PI_REVIEW_GATE_SESSION_HOST_BOOTSTRAP, undefined);
      assert.equal(setupEnv.PI_REVIEW_GATE_SESSION_HOST_NODE_OPTIONS_RESTORE, undefined);
      assert.equal(setupEnv.PI_REVIEW_GATE_SETTLEMENT_SECRET, undefined);
      assert.equal(setupEnv.PI_REVIEW_GATE_QUIESCENCE_CHILD, undefined);
      void homeDir;
      return { ok: true, python: "/synthetic/ddgs/bin/python" };
    },
    loadMain: (entry) => {
      events.push("load");
      assert.equal(entry, join(packageRoot, "dist", "src", "session-host", "main.js"));
      return {
        runSessionHost(options) {
          events.push("run");
          hostOptions.push(options);
          return 0;
        },
      };
    },
    writeOut: () => undefined,
    writeError: () => undefined,
    ...overrides,
  };
}

test("synthetic Windows launcher admits only normalized host env and preserves trusted values through Main", async () => {
  const env: NodeJS.ProcessEnv = {
    HOME: process.cwd(),
    PI_CODING_AGENT_DIR: join(process.cwd(), "synthetic-agent"),
    Path: join(process.cwd(), "synthetic-bin"),
    node_options: "--no-warnings --require=trusted-loader",
    Anthropic_Api_Key: "provider-secret",
    pi_review_gate_session_host_bootstrap: "stale-bootstrap",
    pi_review_gate_settlement_secret: "stale-settlement",
    PI_REVIEW_GATE_RESEARCH_CEILING: "frozen-research-ceiling",
    PI_REVIEW_GATE_CAPTURE_CEILING: "frozen-capture-ceiling",
  };
  const originalEnv = { ...env };
  const events: string[] = [];
  const captured: HostOptions[] = [];
  const status = await launcher.__test.runSessionHostLauncher([], baseOverrides(process.cwd(), env, events, captured, {
    platform: "win32",
    isRegularFile: () => true,
    resolvePiRuntime: ({ env: setupEnv }) => {
      events.push("pi");
      assert.equal(setupEnv.PATH, join(process.cwd(), "synthetic-bin"));
      assert.equal(setupEnv.NODE_OPTIONS, "--no-warnings --require=trusted-loader");
      assert.equal(setupEnv.ANTHROPIC_API_KEY, "provider-secret");
      assert.equal(setupEnv.PI_REVIEW_GATE_SESSION_HOST_BOOTSTRAP, undefined);
      assert.equal(setupEnv.PI_REVIEW_GATE_SETTLEMENT_SECRET, undefined);
      assert.equal(setupEnv.PI_REVIEW_GATE_RESEARCH_CEILING, "frozen-research-ceiling");
      return { file: join(process.cwd(), "synthetic-pi.js"), version: "1.0.4", source: "explicit" };
    },
    writeError: () => undefined,
  }));
  assert.equal(status, 0);
  assert.deepEqual(events, ["build", "pi", "ddgs", "load", "run"]);
  assert.equal(captured.length, 1);
  assert.equal(captured[0]?.env.PATH, join(process.cwd(), "synthetic-bin"));
  assert.equal(captured[0]?.env.NODE_OPTIONS, "--no-warnings --require=trusted-loader");
  assert.equal(captured[0]?.env.ANTHROPIC_API_KEY, "provider-secret");
  assert.equal(captured[0]?.env.PI_REVIEW_GATE_SESSION_HOST_BOOTSTRAP, undefined);
  assert.equal(captured[0]?.env.PI_REVIEW_GATE_DDGS_PYTHON, "/synthetic/ddgs/bin/python");
  assert.deepEqual(env, originalEnv, "normalization and host scrubbing leave the caller's environment object unchanged");
});

test("Windows role aliases and ambiguous ordinary aliases stop before setup", async () => {
  for (const env of [
    { HOME: process.cwd(), PI_REVIEW_GATE_RUNTIME_ROLE: "", pi_review_gate_runtime_role: "private-role-secret" },
    { HOME: process.cwd(), PATH: "/synthetic/one", Path: "/synthetic/two" },
  ]) {
    const events: string[] = [];
    let stderr = "";
    const status = await launcher.__test.runSessionHostLauncher([], {
      getEnv: () => env,
      processEnv: {},
      platform: "win32",
      nodeVersion: "22.19.0",
      stdinIsTTY: true,
      stdoutIsTTY: true,
      packageRoot: process.cwd(),
      build: () => { events.push("build"); return { status: 0 }; },
      resolvePiRuntime: () => { events.push("pi"); return { file: "/synthetic/pi", version: "1.0.4", source: "explicit" }; },
      ensureDdgs: () => { events.push("ddgs"); return { ok: true, python: "/synthetic/python" }; },
      loadMain: () => { events.push("load"); return { runSessionHost: () => 0 }; },
      writeError: (text) => { stderr += text; },
    });
    assert.notEqual(status, 0);
    assert.deepEqual(events, []);
    assert.doesNotMatch(stderr, /private-role-secret/);
  }
});

test("Windows setup timeout cleanup never treats direct child close as descendant settlement", () => {
  const classify = launcher.__test.boundedProcessCleanupStatus;
  const base = {
    closed: true,
    pid: 123,
    platform: "win32",
    timedOut: true,
    outputExceeded: false,
    normalExit: true,
    groupStillExists: () => false,
  };
  assert.equal(classify(base), false, "even a closed direct child cannot prove timed-out Windows descendants settled");
  assert.equal(classify({ ...base, timedOut: false, outputExceeded: true }), false,
    "an output-limit termination has no Windows process-tree proof");
  assert.equal(classify({ ...base, timedOut: false, normalExit: false }), false,
    "a nonzero Windows child exit has no process-tree proof");
  assert.equal(classify({ ...base, timedOut: false }), undefined,
    "a normal Windows close is not represented as process-tree proof");
  assert.equal(classify({ ...base, platform: "linux", timedOut: false }), true);
  assert.equal(classify({ ...base, platform: "linux", timedOut: false, groupStillExists: () => true }), false);
});

test("synthetic Windows source staging uses positive identities without treating POSIX modes as ACL privacy", (t) => {
  const fixture = makePackageFixture(true);
  cleanupFixture(t, fixture);
  const platform = Object.getOwnPropertyDescriptor(process, "platform");
  assert.ok(platform);
  let stage: OwnedStage | undefined;
  let assertionsComplete = false;
  try {
    Object.defineProperty(process, "platform", { ...platform, value: "win32" });
    stage = launcher.__test.stageSourcePackage(fixture.packageRoot, join(fixture.root, "agent", "build-cache"));
    assert.ok(stage.chain && stage.chain.length > 1, "the owned stage retains its observed parent identity chain");
    assert.ok(stage.chain!.every((entry) => entry.identity.dev >= 0n && entry.identity.ino > 0n));
    assert.equal(readFileSync(join(stage.root, "package-lock.json"), "utf8"),
      readFileSync(join(fixture.packageRoot, "package-lock.json"), "utf8"));
    assert.equal(existsSync(join(stage.root, "dist")), false, "the live checkout's dist is not staged");
    assertionsComplete = true;
  } finally {
    Object.defineProperty(process, "platform", platform);
    if (assertionsComplete) {
      assert.equal(launcher.__test.removeOwnedStage(stage!), false,
        "root identity alone does not authorize recursive descendant cleanup");
      assert.equal(existsSync(stage!.root), true, "the source stage is retained");
    }
  }
});

test("synthetic stage cleanup retains Windows Pi runtime provisioning stage without spawning", async (t) => {
  const fixture = makeRuntimeFixture(".session-host-windows-provision-");
  cleanupFixture(t, fixture);
  const platform = Object.getOwnPropertyDescriptor(process, "platform");
  assert.ok(platform);
  const env = runtimeEnv(fixture, {
    NODE_OPTIONS: "--no-warnings --require=trusted-loader",
    ANTHROPIC_API_KEY: "provider-secret",
  });
  const npmCli = join(fixture.root, "synthetic-npm-cli.js");
  const publishedEntry = join(fixture.agentDir, ".pi-review-gate", "pi-runtime", `pi-${launcher.PI_PROVISION_VERSION}`, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "bundle", "cli.js");
  const diagnostics: string[] = [];
  let installStage = "";
  let probes = 0;
  try {
    Object.defineProperty(process, "platform", { ...platform, value: "win32" });
    const result = await launcher.__test.provisionPiRuntime({
      env,
      agentDir: fixture.agentDir,
      npmCli,
      writeError: (text) => diagnostics.push(text),
      runNpm: async (file, args, options) => {
        assert.equal(file, npmCli, "the injected process seam is used without invoking a host npm");
        installStage = String(options.cwd);
        assert.deepEqual(args.slice(0, 3), ["install", "--prefix", installStage]);
        const installEnv = options.env as NodeJS.ProcessEnv;
        for (const key of ["HOME", "USERPROFILE", "TMP", "TEMP", "TMPDIR", "npm_config_cache"]) {
          assert.ok(installEnv[key]?.startsWith(installStage), `${key} remains inside the exclusive stage`);
        }
        assert.equal(installEnv.NODE_OPTIONS, env.NODE_OPTIONS);
        assert.equal(installEnv.ANTHROPIC_API_KEY, "provider-secret");
        writePiPackage(join(installStage, "node_modules", "@earendil-works", "pi-coding-agent"), launcher.PI_PROVISION_VERSION);
        return { status: 0, signal: null, timedOut: false, outputExceeded: false, stdout: "" };
      },
      processRunner: async (file, args, options) => {
        probes += 1;
        assert.equal(file, process.execPath);
        assert.equal(args[1], "--version");
        const stagedEntry = join(installStage, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "bundle", "cli.js");
        assert.ok(args[0] === stagedEntry || args[0] === publishedEntry);
        assert.equal((options.env as NodeJS.ProcessEnv).NODE_OPTIONS, env.NODE_OPTIONS);
        return { status: 0, signal: null, timedOut: false, outputExceeded: false, stdout: `pi ${launcher.PI_PROVISION_VERSION}` };
      },
    });
    assert.equal(result.file, publishedEntry);
    assert.equal(result.version, launcher.PI_PROVISION_VERSION);
    assert.equal(result.source, "isolated-cache");
    assert.equal(probes, 2, "both staged and published CLI identities are checked with the same bounded public Node probe seam");
    assert.ok(existsSync(publishedEntry));
    assert.equal(existsSync(installStage), true, "the runtime stage is retained after publication without descendant receipts");
    assert.equal(diagnostics.length, 2);
    assert.match(diagnostics[1], /preserving a Pi runtime staging tree because per-entry descendant creation receipts are unavailable/);
  } finally {
    Object.defineProperty(process, "platform", platform);
  }
});

test("parser forwards exact native bytes only after -- and leaves argv untouched", () => {
  const argv = [
    "--pi-executable", "/Applications/Pi Tools/π pi",
    "--state-root", "./private state/用户",
    "--sidebar-key", "ctrl+shift+right",
    "--", "--scheduler", "--help", "--tools", "read,edit", "a 'quoted' value", "雪",
  ];
  const before = argv.slice();
  assert.deepEqual(launcher.parseSessionHostArguments(argv), {
    help: false,
    piExecutable: "/Applications/Pi Tools/π pi",
    stateRoot: "./private state/用户",
    toggleKey: "ctrl+shift+right",
    args: ["--scheduler", "--help", "--tools", "read,edit", "a 'quoted' value", "雪"],
  });
  assert.deepEqual(argv, before);

  const forwardedHelp = launcher.parseSessionHostArguments(["--", "--help"]);
  assert.equal(forwardedHelp.help, false);
  assert.deepEqual(forwardedHelp.args, ["--help"]);
  assert.deepEqual(launcher.parseSessionHostArguments([]), {
    help: false,
    args: [],
  });
});

test("parser accepts bounded Unicode paths and key IDs, rejects malformed wrapper options safely", () => {
  const path2048 = "x".repeat(2048);
  const supportedChord = "ctrl+shift+alt+super+left";
  assert.equal(launcher.parseSessionHostArguments(["--state-root", path2048]).stateRoot, path2048);
  assert.equal(launcher.parseSessionHostArguments(["--sidebar-key", supportedChord]).toggleKey, supportedChord);
  assert.equal(launcher.parseSessionHostArguments(["--sidebar-key", "SUPER+ALT+LEFT"]).toggleKey, "alt+super+left");
  assert.equal(launcher.parseSessionHostArguments(["--sidebar-key", "shift+left"]).toggleKey, "shift+left");
  assert.equal(launcher.parseSessionHostArguments(["--sidebar-key", "ctrl+shift+m"]).toggleKey, "ctrl+shift+m");

  const invalid: Array<{ argv: string[]; diagnostic: string; secret?: string }> = [
    { argv: ["--state-root"], diagnostic: "Missing value for --state-root." },
    { argv: ["--pi-executable", "--help"], diagnostic: "Missing value for --pi-executable." },
    { argv: ["-h", "--help"], diagnostic: "Duplicate pi-review-sessions option." },
    { argv: ["--state-root", "one", "--state-root", "two"], diagnostic: "Duplicate pi-review-sessions option." },
    { argv: ["--access-token=do-not-print-this"], diagnostic: "Unknown pi-review-sessions option.", secret: "do-not-print-this" },
    { argv: ["--version"], diagnostic: "Unknown pi-review-sessions option." },
    { argv: ["--workspace", "/private/workspace"], diagnostic: "Unknown pi-review-sessions option.", secret: "/private/workspace" },
    { argv: ["--scheduler"], diagnostic: "Unknown pi-review-sessions option." },
    { argv: ["credential-must-not-appear"], diagnostic: "Unexpected argument before '--'.", secret: "credential-must-not-appear" },
    { argv: ["--state-root", ""], diagnostic: "Invalid value for --state-root." },
    { argv: ["--state-root", `bad\npath`], diagnostic: "Invalid value for --state-root." },
    { argv: ["--pi-executable", "x".repeat(2049)], diagnostic: "Invalid value for --pi-executable." },
    { argv: ["--sidebar-key", "k".repeat(81)], diagnostic: "Invalid value for --sidebar-key." },
    { argv: ["--sidebar-key", "ctrl\u0000left"], diagnostic: "Invalid value for --sidebar-key." },
    ...["a", "shift+a", "left", "enter", "space", "ctrl+c", "ctrl+[", "ctrl+m", "ctrl+j", "ctrl+f8"].map((key) => ({
      argv: ["--sidebar-key", key], diagnostic: "Invalid value for --sidebar-key.",
    })),
    { argv: ["--sidebar-key=a"], diagnostic: "Unknown pi-review-sessions option." },
  ];
  for (const entry of invalid) {
    assert.throws(
      () => launcher.parseSessionHostArguments(entry.argv),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.ok(error.message.includes(entry.diagnostic));
        if (entry.secret) assert.ok(!error.message.includes(entry.secret));
        return true;
      },
    );
  }
});

test("--help works in the real CLI without TTY, role setup, build, or provisioning", () => {
  const result = spawnSync(process.execPath, [SCRIPT, "--help"], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: makeEnvironment({ PI_REVIEW_GATE_RUNTIME_ROLE: "private-role-marker" }),
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Alpha same-machine macOS\/Linux/);
  assert.match(result.stdout, /Node >=22\.19\.0/);
  assert.match(result.stdout, /Pi >=1\.0\.4/);
  assert.match(result.stdout, /no\s+manual Pi CLI path is needed/);
  assert.match(result.stdout, /Basic controls only;\s*terminal\s+graphics rendering\s+is disabled/);
  assert.match(result.stdout, /native image\/model input behavior\s+stays\s+native/i);
  assert.match(result.stdout, /startup session\s+overrides\s+\(--continue\/-c[^)]*\) are not accepted/);
  assert.match(result.stdout, /choose\s+a workspace explicitly in the UI/);
  assert.match(result.stdout, /new native conversation using Pi's normal session storage/);
  assert.doesNotMatch(result.stdout, /label|profile-owned|profile storage/i);
  assert.doesNotMatch(result.stdout + result.stderr, /private-role-marker/);
});

test("forbidden parent startup session overrides reject before any setup with bounded diagnostics", async (t) => {
  const fixture = makePackageFixture(false);
  cleanupFixture(t, fixture);
  const env = makeEnvironment();
  const cases: Array<{ argv: string[]; flag: string; secret?: string }> = [
    { argv: ["--", "--session", "/tmp/old.jsonl"], flag: "--session", secret: "/tmp/old.jsonl" },
    { argv: ["--", "--session=/sensitive/path"], flag: "--session", secret: "/sensitive/path" },
    { argv: ["--", "--continue"], flag: "--continue" },
    { argv: ["--", "-c"], flag: "-c" },
    { argv: ["--", "--resume"], flag: "--resume" },
    { argv: ["--", "-r"], flag: "-r" },
    { argv: ["--", "--session-id", "id-secret"], flag: "--session-id", secret: "id-secret" },
    { argv: ["--", "--fork", "id-secret"], flag: "--fork", secret: "id-secret" },
    { argv: ["--", "--session-dir", "/storage/secret"], flag: "--session-dir", secret: "/storage/secret" },
    { argv: ["--", "--no-session"], flag: "--no-session" },
    // --scheduler removal shifts native boundaries: Pi would see
    // `--system-prompt -- --session …` with a live session option.
    { argv: ["--", "--system-prompt", "--scheduler", "--", "--session", "/tmp/old.jsonl"], flag: "--session", secret: "/tmp/old.jsonl" },
  ];
  for (const entry of cases) {
    const events: string[] = [];
    let stderr = "";
    const status = await launcher.__test.runSessionHostLauncher(entry.argv, baseOverrides(fixture.packageRoot, env, events, [], {
      writeError: (text) => { stderr += text; },
    }));
    assert.equal(status, 2, entry.flag);
    assert.deepEqual(events, [], `no build/Pi/DDGS/load/run for ${entry.flag}`);
    assert.match(stderr, new RegExp(entry.flag));
    if (entry.secret) assert.doesNotMatch(stderr, new RegExp(entry.secret.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
});

test("nonempty inherited PI_CODING_AGENT_SESSION_DIR rejects before any setup", async (t) => {
  const fixture = makePackageFixture(false);
  cleanupFixture(t, fixture);
  const env = makeEnvironment({ PI_CODING_AGENT_SESSION_DIR: "/private/storage" });
  const events: string[] = [];
  let stderr = "";
  const status = await launcher.__test.runSessionHostLauncher(["--", "-p", "hello"], baseOverrides(fixture.packageRoot, env, events, [], {
    writeError: (text) => { stderr += text; },
  }));
  assert.equal(status, 2);
  assert.deepEqual(events, []);
  assert.match(stderr, /PI_CODING_AGENT_SESSION_DIR/);
  assert.doesNotMatch(stderr, /\/private\/storage/);
});

test("ordinary native arguments and value lookalikes pass the startup preflight byte-for-byte", async (t) => {
  const fixture = makePackageFixture(false);
  cleanupFixture(t, fixture);
  const env = makeEnvironment();
  for (const args of [
    ["--model", "--session"],
    ["--system-prompt", "--session"],
    ["--", "--session", "/tmp/old.jsonl"],
    ["-p", "hello"],
  ]) {
    const events: string[] = [];
    const captured: HostOptions[] = [];
    const status = await launcher.__test.runSessionHostLauncher(["--", ...args], baseOverrides(fixture.packageRoot, env, events, captured));
    assert.equal(status, 0, JSON.stringify(args));
    assert.deepEqual(events, ["pi", "ddgs", "load", "run"], JSON.stringify(args));
    assert.deepEqual(captured[0].args, args, "native arguments are forwarded byte-for-byte");
  }
});

test("source build, Pi runtime selection, and DDGS setup precede loading the synthetic host API", async (t) => {
  const fixture = makePackageFixture(true);
  cleanupFixture(t, fixture);
  const events: string[] = [];
  const captured: HostOptions[] = [];
  const env = makeEnvironment({
    PI_REVIEW_GATE_SESSION_HOST_BOOTSTRAP: "bootstrap-secret",
    PI_REVIEW_GATE_SESSION_HOST_NODE_OPTIONS_RESTORE: "restore-secret",
    PI_REVIEW_GATE_DDGS_PYTHON: "/inherited/stale/python",
    NODE_OPTIONS: "--no-warnings",
    ANTHROPIC_API_KEY: "provider-secret",
  });
  const overrides = baseOverrides(fixture.packageRoot, env, events, captured, {
    loadMain: (entry) => {
      events.push("load");
      assert.ok(existsSync(entry));
      return {
        runSessionHost(options) {
          events.push("run");
          captured.push(options);
          return 27;
        },
      };
    },
  });
  const argv = ["--pi-executable", "/pi path/π", "--state-root", "./state dir", "--", "--scheduler", "--", "雪"];
  const before = argv.slice();
  assert.equal(await launcher.__test.runSessionHostLauncher(argv, overrides), 27);
  assert.deepEqual(argv, before);
  assert.deepEqual(events, ["build", "pi", "ddgs", "load", "run"]);
  assert.equal(captured.length, 1);
  // The explicit executable is honored by the stubbed resolver seam; the
  // resolved entry (not a bare name) always reaches the host.
  assert.deepEqual(captured[0], {
    packageRoot: fixture.packageRoot,
    piExecutable: "/synthetic/pi",
    stateRoot: "./state dir",
    args: ["--scheduler", "--", "雪"],
    env: {
      PATH: process.env.PATH,
      HOME: process.cwd(),
      NODE_OPTIONS: "--no-warnings",
      ANTHROPIC_API_KEY: "provider-secret",
      PI_REVIEW_GATE_DDGS_PYTHON: "/synthetic/ddgs/bin/python",
    },
  });
  assert.equal(Object.isFrozen(captured[0].args), true);
  assert.equal(env.PI_REVIEW_GATE_SESSION_HOST_BOOTSTRAP, "bootstrap-secret", "the caller-owned env object is not mutated");
  assert.equal(env.PI_REVIEW_GATE_SESSION_HOST_NODE_OPTIONS_RESTORE, "restore-secret");
});

test("production source-build runs in an owned staging root and preserves the live dist", { skip: process.platform === "win32" }, async (t) => {
  const fixture = makePackageFixture(true);
  cleanupFixture(t, fixture);
  const bin = join(fixture.root, "fake-bin");
  mkdirSync(bin);
  const log = join(fixture.root, "npm-invocations.jsonl");
  writeFileSync(join(bin, "package.json"), JSON.stringify({ name: "npm", version: "10.0.0", bin: { npm: "npm" } }), "utf8");
  // The fake public npm JS bin performs only the locked ci install and places
  // an inert synthetic TypeScript package in the stage; it never runs a
  // package build lifecycle.
  writeFileSync(join(bin, "npm"), `#!/usr/bin/env node\n${[
    `const fs = require("node:fs");`,
    `const path = require("node:path");`,
    `const args = process.argv.slice(2);`,
    `fs.appendFileSync(process.env.TEST_NPM_LOG, JSON.stringify({ args, cwd: process.cwd(), home: process.env.HOME, cache: process.env.npm_config_cache, logs: process.env.npm_config_logs_dir, temp: process.env.TMPDIR, bootstrap: process.env.PI_REVIEW_GATE_SESSION_HOST_BOOTSTRAP ?? null, restore: process.env.PI_REVIEW_GATE_SESSION_HOST_NODE_OPTIONS_RESTORE ?? null, settlement: process.env.PI_REVIEW_GATE_SETTLEMENT_SECRET ?? null, quiescence: process.env.PI_REVIEW_GATE_QUIESCENCE_CHILD ?? null, ddgs: process.env.PI_REVIEW_GATE_DDGS_PYTHON ?? null, nodeOptions: process.env.NODE_OPTIONS, nodeEnv: process.env.NODE_ENV ?? null, provider: process.env.ANTHROPIC_API_KEY }) + "\\n");`,
    `if (args[0] !== "ci") { process.stderr.write("unexpected npm run lifecycle\\n"); process.exit(97); }`,
    `fs.mkdirSync(path.join(process.cwd(), "node_modules"));`,
    ...inertStageTypeScriptScriptLines(),
    `process.exit(0);`,
    "",
  ].join("\n")}`, "utf8");

  const events: string[] = [];
  const captured: HostOptions[] = [];
  const diagnostics: string[] = [];
  const compilePlans: Array<{ compilerCli: string; args: string[]; cwd: string; env: NodeJS.ProcessEnv }> = [];
  const env = makeEnvironment({
    HOME: fixture.root,
    PATH: `${bin}${delimiter}${process.env.PATH ?? ""}`,
    TEST_NPM_LOG: log,
    PI_REVIEW_GATE_SESSION_HOST_BOOTSTRAP: "bootstrap-secret",
    PI_REVIEW_GATE_SESSION_HOST_NODE_OPTIONS_RESTORE: "restore-secret",
    PI_REVIEW_GATE_SETTLEMENT_SECRET: "settlement-secret",
    PI_REVIEW_GATE_QUIESCENCE_CHILD: "quiescence-secret",
    PI_REVIEW_GATE_DDGS_PYTHON: "/inherited/stale/python",
    NODE_OPTIONS: "--no-warnings",
    NODE_ENV: "production",
    ANTHROPIC_API_KEY: "provider-secret",
  });
  const status = await launcher.__test.runSessionHostLauncher(["--", "--scheduler"], {
    getEnv: () => env,
    processEnv: {},
    platform: "linux",
    nodeVersion: "22.19.0",
    stdinIsTTY: true,
    stdoutIsTTY: true,
    packageRoot: fixture.packageRoot,
    build: (options) => launcher.__test.buildSourceExtension({
      ...options,
      runCompile: async (compilerCli, args, processOptions) => {
        const stagedRoot = String(processOptions.cwd);
        compilePlans.push({ compilerCli, args, cwd: stagedRoot, env: processOptions.env as NodeJS.ProcessEnv });
        const distDir = join(stagedRoot, "dist", "src", "session-host");
        mkdirSync(distDir, { recursive: true });
        writeFileSync(join(distDir, "main.js"), "// staged compile output\n", "utf8");
        return { status: 0, signal: null, cleanupConfirmed: true, timedOut: false, outputExceeded: false, stdout: "" };
      },
    }),
    resolvePiRuntime: (options) => { events.push("pi"); return { file: "/synthetic/pi", version: "1.0.4", source: "npm-global" }; },
    ensureDdgs: (root) => { events.push("ddgs"); void root; return { ok: true, python: "/synthetic/python" }; },
    loadMain: (entry) => {
      events.push("load");
      assert.ok(existsSync(entry));
      const stagedRoot = dirname(dirname(dirname(dirname(entry))));
      assert.ok(existsSync(join(stagedRoot, "node_modules")), "fresh source setup owns its dependencies in-stage");
      for (const name of ["package.json", "package-lock.json", "tsconfig.json", join("src", "session-host", "main.ts")]) {
        assert.ok(existsSync(join(stagedRoot, name)), `staged package includes ${name}`);
      }
      assert.equal(readFileSync(join(stagedRoot, "package-lock.json"), "utf8"), readFileSync(join(fixture.packageRoot, "package-lock.json"), "utf8"));
      assert.equal(existsSync(join(fixture.packageRoot, "node_modules")), false, "source checkout dependencies are not required or linked");
      return { runSessionHost: (options) => { events.push("run"); captured.push(options); return 0; } };
    },
    writeOut: () => undefined,
    writeError: (text) => { diagnostics.push(text); },
  });
  assert.equal(status, 0);
  // The real default build runs (no build override): its npm invocation is
  // asserted from the log below.
  assert.deepEqual(events, ["pi", "ddgs", "load", "run"]);
  const invocations = readFileSync(log, "utf8").trim().split("\n").map((line) => JSON.parse(line) as {
    args: string[];
    cwd: string;
    home: string;
    cache: string;
    logs: string;
    temp: string;
    bootstrap: string | null;
    restore: string | null;
    settlement: string | null;
    quiescence: string | null;
    ddgs: string | null;
    nodeOptions: string;
    nodeEnv: string | null;
    provider: string;
  });
  assert.equal(invocations.length, 1, "the source stage installs locked dependencies and never runs a package build lifecycle");
  assert.deepEqual(invocations[0].args, ["ci", "--include=dev", "--ignore-scripts", "--no-audit", "--no-fund", "--registry", "https://registry.npmjs.org"]);
  assert.equal(invocations[0].nodeEnv, "production", "npm's production environment is preserved while dev dependencies are explicitly included");
  assert.ok(!invocations[0].args.some((arg) => arg === "run" || arg === "build" || arg === "clean:build"), "no recursive clean/build lifecycle is invoked");
  const invocation = invocations[0];
  const stagingRoot = invocation.cwd;
  // The compile runs against an owned staging package root under the agent
  // directory cache — never the live checkout — as one direct TypeScript
  // project invocation through public Node, without adding a `.bin` PATH shim.
  assert.equal(compilePlans.length, 1, "the compile phase is a single direct TypeScript invocation");
  const compilePlan = compilePlans[0];
  assert.equal(compilePlan.compilerCli, join(stagingRoot, "node_modules", "typescript", "bin", "tsc"), "the compile uses the stage's own installed TypeScript CLI");
  assert.deepEqual(compilePlan.args, ["-p", join(stagingRoot, "tsconfig.json")], "the compile is a direct tsc project invocation, never `npm run build`");
  assert.equal(compilePlan.cwd, stagingRoot);
  assert.equal(compilePlan.env.PATH, env.PATH,
    "the compile preserves the exact caller PATH, including inherited npm entries, without adding a stage .bin shim");
  const agentDir = join(fixture.root, ".pi", "agent");
  assert.ok(stagingRoot.startsWith(`${agentDir}/.pi-review-gate/build/pi-review-sessions-`), `staged root must be owned: ${stagingRoot}`);
  // The host receives the staged root so every runtime lookup stays in the stage.
  assert.equal(captured[0].packageRoot, stagingRoot);
  assert.equal(captured[0].env.NODE_ENV, "production", "the native host environment remains unchanged");
  // Main can settle gracefully, but root identity does not authorize deleting
  // npm/compile descendants without complete per-entry creation receipts.
  assert.equal(existsSync(stagingRoot), true);
  assert.match(diagnostics[0], /^pi-review-sessions: pi runtime: \/synthetic\/pi \(v1\.0\.4, npm-global\)\n$/);
  assert.match(diagnostics[1], /preserving the source stage because per-entry descendant creation receipts are unavailable/);
  // The live checkout dist is preserved byte-for-byte.
  assert.equal(readFileSync(join(fixture.packageRoot, "dist", "src", "session-host", "main.js"), "utf8"), "LIVE DIST SENTINEL — never rebuild in place\n");
  assert.equal(invocation.bootstrap, null);
  assert.equal(invocation.restore, null);
  assert.equal(invocation.settlement, null);
  assert.equal(invocation.quiescence, null);
  assert.equal(invocation.ddgs, null);
  assert.equal(invocation.nodeOptions, "--no-warnings");
  assert.equal(invocation.provider, "provider-secret");
  assert.equal(compilePlan.env.NODE_OPTIONS, "--no-warnings", "the compile environment preserves the user's NODE_OPTIONS");
  assert.equal(compilePlan.env.ANTHROPIC_API_KEY, "provider-secret", "the compile environment preserves trusted provider variables");
  assert.equal(env.PI_REVIEW_GATE_SETTLEMENT_SECRET, "settlement-secret", "the injected caller environment is not mutated");
  assert.equal(env.PI_REVIEW_GATE_QUIESCENCE_CHILD, "quiescence-secret");
  for (const ownedPath of [invocation.home, invocation.cache, invocation.logs, invocation.temp]) {
    assert.ok(ownedPath.startsWith(`${stagingRoot}/`), `npm resources must remain in the owned stage: ${ownedPath}`);
  }
  assert.deepEqual(captured[0].args, ["--scheduler"]);
});

test("a failed staged build preserves the live dist and retains its stage", { skip: process.platform === "win32" }, async (t) => {
  const fixture = makePackageFixture(true);
  cleanupFixture(t, fixture);
  const bin = join(fixture.root, "fake-bin");
  mkdirSync(bin);
  const log = join(fixture.root, "npm-invocation.json");
  writeFileSync(join(bin, "package.json"), JSON.stringify({ name: "npm", version: "10.0.0", bin: { npm: "npm" } }), "utf8");
  writeFileSync(join(bin, "npm"), `#!/usr/bin/env node\n${[
    `const fs = require("node:fs");`,
    `const args = process.argv.slice(2);`,
    `fs.appendFileSync(process.env.TEST_NPM_LOG, JSON.stringify({ args, cwd: process.cwd() }) + "\\n");`,
    `if (args[0] !== "ci") { process.stderr.write("unexpected npm run lifecycle\\n"); process.exit(97); }`,
    ...inertStageTypeScriptScriptLines(),
    `process.exit(0);`,
    "",
  ].join("\n")}`, "utf8");

  const env = makeEnvironment({ HOME: fixture.root, PATH: `${bin}${delimiter}${process.env.PATH ?? ""}`, TEST_NPM_LOG: log });
  const events: string[] = [];
  let stderr = "";
  const status = await launcher.__test.runSessionHostLauncher(["--", "--scheduler"], {
    getEnv: () => env,
    processEnv: {},
    platform: "linux",
    nodeVersion: "22.19.0",
    stdinIsTTY: true,
    stdoutIsTTY: true,
    packageRoot: fixture.packageRoot,
    build: (options) => launcher.__test.buildSourceExtension({
      ...options,
      runCompile: async () => ({ status: 23, signal: null, cleanupConfirmed: true, timedOut: false, outputExceeded: false, stdout: "compile stdout line\n", stderr: "compile failed\n" }),
    }),
    resolvePiRuntime: () => { events.push("pi"); return { file: "/synthetic/pi", version: "1.0.4", source: "npm-global" }; },
    ensureDdgs: (root) => { events.push("ddgs"); void root; return { ok: true, python: "/synthetic/python" }; },
    loadMain: () => { events.push("load"); return { runSessionHost: () => 0 }; },
    writeOut: () => undefined,
    writeError: (text) => { stderr += text; },
  });
  assert.equal(status, 23);
  assert.deepEqual(events, [], "no Pi/DDGS/load after a failed build");
  assert.match(stderr, /failed build stage: TypeScript compile \(tsc -p tsconfig\.json\)/);
  assert.match(stderr, /TypeScript compile \(tsc -p tsconfig\.json\) stderr:\ncompile failed\n/);
  // The live checkout dist is preserved byte-for-byte.
  assert.equal(readFileSync(join(fixture.packageRoot, "dist", "src", "session-host", "main.js"), "utf8"), "LIVE DIST SENTINEL — never rebuild in place\n");
  // The failed build stage is honestly reported and retained: npm/build
  // descendants have no complete per-entry creation receipts.
  const buildCacheRoot = join(fixture.root, ".pi", "agent", ".pi-review-gate", "build");
  const stages = existsSync(buildCacheRoot)
    ? readdirNames(buildCacheRoot).filter((entry) => /^pi-review-sessions-/.test(entry))
    : [];
  assert.equal(stages.length, 1);
  assert.match(stderr, /a source stage was retained because per-entry descendant creation receipts are unavailable/);
});

test("synthetic stage cleanup retains source build stage after unconfirmed setup cleanup", async (t) => {
  const source = makePackageFixture(true);
  const runtime = makeRuntimeFixture(".session-host-build-cleanup-unconfirmed-");
  cleanupFixture(t, source);
  cleanupFixture(t, runtime);
  writeFakeNpm(runtime, "global");
  let stagingRoot = "";
  const result = await launcher.__test.buildSourceExtension({
    packageRoot: source.packageRoot,
    agentDir: runtime.agentDir,
    env: runtimeEnv(runtime),
    runNpm: async (_npmCli, args, options) => {
      stagingRoot = String(options.cwd);
      if (args[0] === "ci") {
        writeInertStageTypeScript(stagingRoot);
        return { status: 0, signal: null, cleanupConfirmed: true, timedOut: false, outputExceeded: false, stdout: "" };
      }
      throw new Error("the npm seam is install-only");
    },
    runCompile: async () => ({
      status: 0,
      signal: null,
      error: new Error("synthetic process-group cleanup unconfirmed"),
      cleanupConfirmed: false,
      timedOut: false,
      outputExceeded: false,
      stdout: "",
    }),
  });

  assert.equal(result.status, 1);
  assert.equal(result.childStatus, 0, "the synthetic child exit is kept separate from launcher status");
  assert.equal(result.cleanupConfirmed, false);
  assert.equal(result.retainedStage, true);
  assert.ok(stagingRoot.startsWith(join(runtime.agentDir, ".pi-review-gate", "build")));
  assert.ok(existsSync(join(stagingRoot, "package.json")), "the owned stage remains available for unresolved setup work");
});

test("synthetic stage cleanup retains source stages across setup and host outcomes", async (t) => {
  const fixture = makePackageFixture(true);
  cleanupFixture(t, fixture);
  const cases: Array<{ name: string; preMainFailure?: boolean; setupCleanupUnconfirmed?: boolean; result?: number; rejected?: boolean; expectedStatus: number; preserve: boolean }> = [
    { name: "pre-Main setup failure", preMainFailure: true, expectedStatus: 1, preserve: true },
    { name: "unconfirmed setup cleanup", setupCleanupUnconfirmed: true, expectedStatus: 1, preserve: true },
    { name: "graceful Main success", result: 0, expectedStatus: 0, preserve: true },
    { name: "unconfirmed native shutdown", result: 1, expectedStatus: 1, preserve: true },
    { name: "invalid Main result", result: Number.NaN, expectedStatus: 1, preserve: true },
    { name: "rejected Main", rejected: true, expectedStatus: 1, preserve: true },
  ];

  for (let index = 0; index < cases.length; index += 1) {
    const scenario = cases[index];
    const owned = launcher.__test.createOwnedStage(fixture.root, `synthetic-host-stage-${index}-`);
    const entry = join(owned.root, "dist", "src", "session-host", "main.js");
    mkdirSync(dirname(entry), { recursive: true });
    writeFileSync(entry, "// synthetic compiled main\n", "utf8");
    const events: string[] = [];
    let stderr = "";
    const status = await launcher.__test.runSessionHostLauncher([], {
      getEnv: () => makeEnvironment({ HOME: fixture.root }),
      processEnv: {},
      platform: "linux",
      nodeVersion: "22.19.0",
      stdinIsTTY: true,
      stdoutIsTTY: true,
      packageRoot: fixture.packageRoot,
      build: () => { events.push("build"); return { status: 0, stagingRoot: owned.root, ownedStage: owned }; },
      resolvePiRuntime: () => {
        events.push("pi");
        if (scenario.preMainFailure) throw new Error("synthetic setup failure");
        return { file: "/synthetic/pi", version: "1.0.4", source: "npm-global" };
      },
      ensureDdgs: () => {
        events.push("ddgs");
        return scenario.setupCleanupUnconfirmed
          ? { ok: false, exitCode: 1, cleanupUnconfirmed: true }
          : { ok: true, python: "/synthetic/python" };
      },
      loadMain: () => {
        events.push("load");
        return {
          runSessionHost: async () => {
            events.push("main");
            if (scenario.rejected) throw new Error("synthetic unresolved child process");
            return scenario.result as number;
          },
        };
      },
      writeOut: () => undefined,
      writeError: (text) => { stderr += text; },
    });
    assert.equal(status, scenario.expectedStatus, scenario.name);
    assert.equal(existsSync(owned.root), scenario.preserve, `${scenario.name}: stage retention policy`);
    if (scenario.preserve) {
      const current = lstatSync(owned.root, { bigint: true });
      assert.equal(current.dev, owned.identity.dev);
      assert.equal(current.ino, owned.identity.ino);
      if (scenario.setupCleanupUnconfirmed) {
        assert.match(stderr, /preserving the source stage because setup cleanup was not confirmed and per-entry descendant creation receipts are unavailable/);
      } else if (scenario.preMainFailure || scenario.result === 0) {
        assert.match(stderr, /preserving the source stage because per-entry descendant creation receipts are unavailable/);
      } else {
        assert.match(stderr, /preserving the source stage because native shutdown was not confirmed and per-entry descendant creation receipts are unavailable/);
      }
    }
    if (scenario.preMainFailure) assert.deepEqual(events, ["build", "pi"]);
    else if (scenario.setupCleanupUnconfirmed) assert.deepEqual(events, ["build", "pi", "ddgs"]);
    else assert.ok(events.includes("main"), `${scenario.name}: Main was started`);
  }
});

test("stageSourcePackage copies build and runtime inputs without touching the checkout", (t) => {
  const fixture = makePackageFixture(true);
  cleanupFixture(t, fixture);
  mkdirSync(join(fixture.packageRoot, "scripts"), { recursive: true });
  writeFileSync(join(fixture.packageRoot, "scripts", "helper.ps1"), "# shipped helper\n", "utf8");
  const skillsDir = join(fixture.packageRoot, "skills", "pi-review-gate-execution");
  mkdirSync(skillsDir, { recursive: true });
  writeFileSync(join(skillsDir, "SKILL.md"), "# skill\n", "utf8");
  // Nested initialized-Terraform directories at several depths: pruned at
  // traversal time, never copied into the stage.
  for (const dir of [join(fixture.packageRoot, "src", ".terraform"), join(fixture.packageRoot, "scripts", "nested", ".terraform"), join(skillsDir, ".terraform")]) {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "sentinel"), "do not copy\n", "utf8");
  }
  const checkoutDependencies = join(fixture.root, "foreign checkout dependencies");
  mkdirSync(checkoutDependencies);
  writeFileSync(join(checkoutDependencies, "sentinel"), "must not be followed\n", "utf8");
  symlinkSync(checkoutDependencies, join(fixture.packageRoot, "node_modules"));

  const buildCacheRoot = join(fixture.root, "build-cache");
  const lockBytes = readFileSync(join(fixture.packageRoot, "package-lock.json"));
  const ownedStage = launcher.__test.stageSourcePackage(fixture.packageRoot, buildCacheRoot);
  const stagingRoot = ownedStage.root;
  assert.ok(stagingRoot.startsWith(buildCacheRoot));
  assert.equal(Number(lstatSync(stagingRoot).mode & 0o077), 0, "owned staging root is private");
  for (const name of ["package.json", "package-lock.json", "tsconfig.json", join("src", "session-host", "main.ts"), join("scripts", "helper.ps1"), join("skills", "pi-review-gate-execution", "SKILL.md")]) {
    assert.ok(existsSync(join(stagingRoot, name)), `staged package must include ${name}`);
  }
  assert.deepEqual(readFileSync(join(stagingRoot, "package-lock.json")), lockBytes, "lockfile is byte-for-byte unchanged");
  assert.equal(existsSync(join(stagingRoot, "node_modules")), false, "checkout dependencies are not linked into staging");
  assert.equal(existsSync(join(stagingRoot, "dist")), false, "the source checkout dist is not copied");
  for (const name of [join("src", ".terraform"), join("scripts", "nested", ".terraform"), join("skills", "pi-review-gate-execution", ".terraform")]) {
    assert.ok(!existsSync(join(stagingRoot, name)), `staged package must omit ${name}`);
  }
  // The checkout is untouched: its live dist sentinel and sources remain.
  assert.equal(readFileSync(join(fixture.packageRoot, "dist", "src", "session-host", "main.js"), "utf8"), "LIVE DIST SENTINEL — never rebuild in place\n");
  assert.ok(existsSync(join(fixture.packageRoot, "src", "session-host", "main.ts")));
  assert.equal(lstatSync(join(fixture.packageRoot, "node_modules")).isSymbolicLink(), true, "the source dependency alias is left untouched");
  assert.equal(readFileSync(join(checkoutDependencies, "sentinel"), "utf8"), "must not be followed\n");
  for (const dir of [join(fixture.packageRoot, "src", ".terraform"), join(fixture.packageRoot, "scripts", "nested", ".terraform"), join(skillsDir, ".terraform")]) {
    unlinkSync(join(dir, "sentinel"));
    rmdirSync(dir);
  }
  assert.equal(launcher.__test.removeOwnedStage(ownedStage), false, "the stage remains without per-entry descendant creation receipts");
  assert.equal(existsSync(stagingRoot), true, "the staged source is retained after assertions");
});

test("exclusive stage creation never adopts a preexisting random-name collision", (t) => {
  const fixture = makePackageFixture(true);
  cleanupFixture(t, fixture);
  const parent = join(fixture.root, "owned-cache");
  mkdirSync(parent);
  const random = Buffer.alloc(16, 0xa5);
  const collision = join(parent, `collision-${random.toString("hex")}`);
  mkdirSync(collision);
  const sentinel = join(collision, "foreign.txt");
  writeFileSync(sentinel, "unknown preexisting data\n", "utf8");

  assert.throws(
    () => launcher.__test.createOwnedStage(parent, "collision-", () => random),
    /could not exclusively create a unique staging directory/,
  );
  assert.equal(readFileSync(sentinel, "utf8"), "unknown preexisting data\n");
  assert.equal(lstatSync(collision).isDirectory(), true);
});

test("source staging rejects symlink aliases and retains its partial stage", (t) => {
  const fixture = makePackageFixture(true);
  cleanupFixture(t, fixture);
  const outside = join(fixture.root, "alias target");
  writeFileSync(outside, "not copied\n", "utf8");
  const alias = join(fixture.packageRoot, "src", "alias.ts");
  symlinkSync(outside, alias);
  const cache = join(fixture.root, "build-cache");

  let stageError: (Error & { retainedStage?: boolean }) | undefined;
  try {
    launcher.__test.stageSourcePackage(fixture.packageRoot, cache);
  } catch (error) {
    stageError = error as Error & { retainedStage?: boolean };
  }
  assert.match(stageError?.message ?? "", /could not stage the source package/);
  assert.equal(stageError?.retainedStage, true, "the stage-retention outcome is reported honestly");
  assert.equal(readFileSync(outside, "utf8"), "not copied\n");
  assert.equal(lstatSync(alias).isSymbolicLink(), true, "the source alias is preserved");
  const stages = readdirSync(cache);
  assert.equal(stages.length, 1, "the failed run's partial stage is retained");
  assert.equal(lstatSync(join(cache, stages[0])).isDirectory(), true);
});

test("source staging stops before opening a replaced source directory", (t) => {
  const fixture = makePackageFixture(true);
  cleanupFixture(t, fixture);
  const sourceDirectory = join(fixture.packageRoot, "src");
  const heldSource = join(fixture.root, "held-source-original");
  const foreignDirectory = join(fixture.root, "foreign-source");
  const foreignFile = join(foreignDirectory, "sentinel.ts");
  mkdirSync(foreignDirectory);
  writeFileSync(foreignFile, "foreign source must not be opened\n", "utf8");
  const aliasedForeignFile = join(sourceDirectory, "sentinel.ts");
  const cache = join(fixture.root, "build-cache");
  let replaced = false;
  let foreignFileOpened = false;

  withOpendirHook((openedPath) => {
    if (openedPath === sourceDirectory && !replaced) {
      replaced = true;
      renameSync(sourceDirectory, heldSource);
      symlinkSync(foreignDirectory, sourceDirectory, "dir");
    }
  }, () => withOpenSyncHook((openedPath) => {
    if (openedPath === aliasedForeignFile) foreignFileOpened = true;
  }, () => {
    assert.throws(() => launcher.__test.stageSourcePackage(fixture.packageRoot, cache), /could not stage the source package/);
  }));

  assert.equal(replaced, true, "the source directory was replaced after its handle was opened");
  assert.equal(foreignFileOpened, false, "no foreign file path was opened through the replacement");
  assert.equal(lstatSync(sourceDirectory).isSymbolicLink(), true, "the source replacement remains intact");
  assert.equal(readFileSync(foreignFile, "utf8"), "foreign source must not be opened\n");
  const [stageName] = readdirSync(cache);
  assert.ok(stageName, "the stage is retained as a witness after a directory-chain change");
  assert.equal(lstatSync(join(cache, stageName, "src")).isDirectory(), true);
});

test("source staging stops before writing through a replaced destination directory", (t) => {
  const fixture = makePackageFixture(true);
  cleanupFixture(t, fixture);
  const sourceDirectory = join(fixture.packageRoot, "src");
  const cache = join(fixture.root, "build-cache");
  const heldDestination = join(fixture.root, "held-destination-original");
  const foreignDestination = join(fixture.root, "foreign-destination");
  mkdirSync(foreignDestination);
  writeFileSync(join(foreignDestination, "sentinel"), "foreign destination stays\n", "utf8");
  let replaced = false;
  let stagedSource = "";

  withOpendirHook((openedPath) => {
    if (openedPath !== sourceDirectory || replaced) return;
    replaced = true;
    const [stageName] = readdirSync(cache);
    assert.ok(stageName, "the stage exists before the source directory is read");
    stagedSource = join(cache, stageName, "src");
    renameSync(stagedSource, heldDestination);
    symlinkSync(foreignDestination, stagedSource, "dir");
  }, () => {
    assert.throws(() => launcher.__test.stageSourcePackage(fixture.packageRoot, cache), /could not stage the source package/);
  });

  assert.equal(replaced, true, "the destination directory was replaced while copying");
  assert.equal(lstatSync(heldDestination).isDirectory(), true, "the displaced original destination remains intact");
  assert.equal(lstatSync(stagedSource).isSymbolicLink(), true, "the replacement symlink is preserved inside the retained stage");
  assert.equal(readFileSync(join(foreignDestination, "sentinel"), "utf8"), "foreign destination stays\n");
  assert.equal(existsSync(join(foreignDestination, "session-host")), false, "no staged file or directory was created in the foreign target");
});

test("synthetic stage cleanup retains replaced roots and symlinks without enumeration", (t) => {
  const fixture = makePackageFixture(true);
  cleanupFixture(t, fixture);
  const owned = launcher.__test.createOwnedStage(fixture.root, "replace-");
  writeFileSync(join(owned.root, "original.txt"), "original stage stays\n", "utf8");
  const held = `${owned.root}-held`;
  renameSync(owned.root, held);
  mkdirSync(owned.root);
  const replacement = join(owned.root, "foreign.txt");
  writeFileSync(replacement, "replacement survives\n", "utf8");

  let enumerations = 0;
  const removed = withOpendirHook(() => { enumerations += 1; }, () => launcher.__test.removeOwnedStage(owned));
  assert.equal(removed, false, "a replaced stage root is retained");
  assert.equal(enumerations, 0, "cleanup does not enumerate descendants");
  assert.equal(readFileSync(replacement, "utf8"), "replacement survives\n");
  assert.equal(launcher.__test.removeOwnedStage({ ...owned, root: held }), false,
    "a relocated stage remains untouched without per-entry descendant receipts");
  assert.equal(readFileSync(join(held, "original.txt"), "utf8"), "original stage stays\n");
  const heldIdentity = lstatSync(held, { bigint: true });
  assert.equal(heldIdentity.dev, owned.identity.dev);
  assert.equal(heldIdentity.ino, owned.identity.ino);

  const victim = join(fixture.root, "symlink-victim");
  mkdirSync(victim);
  writeFileSync(join(victim, "sentinel"), "outside target stays\n", "utf8");
  const symlinkStage = launcher.__test.createOwnedStage(fixture.root, "symlink-stage-");
  symlinkSync(victim, join(symlinkStage.root, "alias"), "dir");
  assert.equal(launcher.__test.removeOwnedStage(symlinkStage), false, "the stage containing a symlink is retained");
  assert.equal(lstatSync(join(symlinkStage.root, "alias")).isSymbolicLink(), true, "the link itself is preserved");
  assert.equal(readFileSync(join(victim, "sentinel"), "utf8"), "outside target stays\n", "the link target is untouched");
  assert.equal(enumerations, 0, "neither cleanup call scans its stage");
});

test("synthetic stage cleanup retains original, replaced, unknown, symlink, and .terraform entries", (t) => {
  const fixture = makePackageFixture(false);
  cleanupFixture(t, fixture);
  const owned = launcher.__test.createOwnedStage(fixture.root, "stage-");
  const stage = owned.root;
  const originalFile = join(stage, "original.txt");
  const unknownFile = join(stage, "unknown-output.txt");
  writeFileSync(originalFile, "original entry stays\n", "utf8");
  writeFileSync(unknownFile, "unknown entry stays\n", "utf8");

  const nested = join(stage, "nested");
  const held = join(stage, "nested-original");
  const victim = join(fixture.root, "victim");
  mkdirSync(nested);
  mkdirSync(victim);
  writeFileSync(join(nested, "sentinel"), "replaced original stays\n", "utf8");
  writeFileSync(join(victim, "sentinel"), "symlink target stays\n", "utf8");
  renameSync(nested, held);
  symlinkSync(victim, nested, "dir");
  symlinkSync(victim, join(stage, "alias"), "dir");

  const terraform = join(stage, "src", ".terraform");
  mkdirSync(terraform, { recursive: true });
  writeFileSync(join(terraform, "sentinel"), "terraform entry stays\n", "utf8");
  writeFileSync(join(stage, "src", "main.ts"), "ordinary entry stays\n", "utf8");

  let enumerations = 0;
  const retained = withOpendirHook(() => { enumerations += 1; }, () => launcher.__test.removeOwnedStage(owned));
  assert.equal(retained, false, "the stage is retained without per-entry creation receipts");
  assert.equal(enumerations, 0, "unknown descendants are not scanned");
  const currentRoot = lstatSync(stage, { bigint: true });
  assert.equal(currentRoot.dev, owned.identity.dev);
  assert.equal(currentRoot.ino, owned.identity.ino);
  assert.equal(readFileSync(originalFile, "utf8"), "original entry stays\n");
  assert.equal(readFileSync(unknownFile, "utf8"), "unknown entry stays\n");
  assert.equal(readFileSync(join(held, "sentinel"), "utf8"), "replaced original stays\n");
  assert.equal(lstatSync(nested).isSymbolicLink(), true, "the replacement link is preserved");
  assert.equal(lstatSync(join(stage, "alias")).isSymbolicLink(), true, "the unknown symlink is preserved");
  assert.equal(readFileSync(join(victim, "sentinel"), "utf8"), "symlink target stays\n");
  assert.equal(readFileSync(join(terraform, "sentinel"), "utf8"), "terraform entry stays\n");
  assert.equal(readFileSync(join(stage, "src", "main.ts"), "utf8"), "ordinary entry stays\n");

  // Remove only the test-created .terraform sentinel so fixture cleanup can
  // safely remove this fixture without traversing initialized Terraform data.
  unlinkSync(join(terraform, "sentinel"));
  rmdirSync(terraform);
});

test("a relative PI_CODING_AGENT_DIR anchors staging and host paths against the startup cwd", { skip: process.platform === "win32" }, async (t) => {
  const fixture = makePackageFixture(true);
  cleanupFixture(t, fixture);
  const bin = join(fixture.root, "fake-bin");
  mkdirSync(bin);
  const log = join(fixture.root, "npm-invocations.jsonl");
  writeFileSync(join(bin, "package.json"), JSON.stringify({ name: "npm", version: "10.0.0", bin: { npm: "npm" } }), "utf8");
  writeFileSync(join(bin, "npm"), `#!/usr/bin/env node\n${[
    `const fs = require("node:fs");`,
    `const path = require("node:path");`,
    `const args = process.argv.slice(2);`,
    `fs.appendFileSync(process.env.TEST_NPM_LOG, JSON.stringify({ args, cwd: process.cwd() }) + "\\n");`,
    `if (args[0] !== "ci") { process.stderr.write("unexpected npm run lifecycle\\n"); process.exit(97); }`,
    `fs.mkdirSync(path.join(process.cwd(), "node_modules"));`,
    ...inertStageTypeScriptScriptLines(),
    `process.exit(0);`,
    "",
  ].join("\n")}`, "utf8");

  const startupCwd = join(fixture.root, "startup cwd");
  mkdirSync(startupCwd);
  const env = makeEnvironment({
    HOME: fixture.root,
    PATH: `${bin}${delimiter}${process.env.PATH ?? ""}`,
    TEST_NPM_LOG: log,
    PI_CODING_AGENT_DIR: "./agent dir π",
  });
  const events: string[] = [];
  const captured: HostOptions[] = [];
  const status = await launcher.__test.runSessionHostLauncher(["--", "--scheduler"], {
    getEnv: () => env,
    processEnv: {},
    platform: "linux",
    nodeVersion: "22.19.0",
    stdinIsTTY: true,
    stdoutIsTTY: true,
    packageRoot: fixture.packageRoot,
    cwd: startupCwd,
    build: (options) => launcher.__test.buildSourceExtension({
      ...options,
      runCompile: async (_compilerCli, _args, processOptions) => {
        const distDir = join(String(processOptions.cwd), "dist", "src", "session-host");
        mkdirSync(distDir, { recursive: true });
        writeFileSync(join(distDir, "main.js"), "// staged compile output\n", "utf8");
        return { status: 0, signal: null, cleanupConfirmed: true, timedOut: false, outputExceeded: false, stdout: "" };
      },
    }),
    resolvePiRuntime: () => { events.push("pi"); return { file: "/synthetic/pi", version: "1.0.4", source: "npm-global" }; },
    ensureDdgs: (root) => { events.push("ddgs"); void root; return { ok: true, python: "/synthetic/python" }; },
    loadMain: () => { events.push("load"); return { runSessionHost: (options) => { events.push("run"); captured.push(options); return 0; } }; },
    writeOut: () => undefined,
    writeError: () => undefined,
  });
  assert.equal(status, 0);
  const anchoredAgentDir = join(startupCwd, "agent dir π");
  // The real default build plan runs against an absolute staged prefix under
  // the anchored agent directory, installing first and then compiling with the
  // stage's own TypeScript CLI.
  const invocations = readFileSync(log, "utf8").trim().split("\n").map((line) => JSON.parse(line) as { args: string[]; cwd: string });
  assert.equal(invocations.length, 1, "only the locked ci install invokes npm");
  assert.equal(invocations[0].args[0], "ci");
  const stagingRoot = invocations[0].cwd;
  assert.ok(isAbsolute(stagingRoot), `staged root must be absolute: ${stagingRoot}`);
  assert.ok(stagingRoot.startsWith(`${anchoredAgentDir}/.pi-review-gate/build/pi-review-sessions-`), `staged root must be anchored: ${stagingRoot}`);
  // The host receives an absolute package root and the anchored override.
  assert.equal(captured[0].packageRoot, stagingRoot);
  assert.ok(isAbsolute(captured[0].packageRoot));
  assert.equal(captured[0].env.PI_CODING_AGENT_DIR, anchoredAgentDir);
});

test("packaged compiled path skips source build and always hands a resolved pi entry to the host", async (t) => {
  const fixture = makePackageFixture(false);
  cleanupFixture(t, fixture);
  const events: string[] = [];
  const captured: HostOptions[] = [];
  const env = makeEnvironment();
  const overrides = baseOverrides(fixture.packageRoot, env, events, captured, {
    build: () => {
      events.push("build");
      return { status: 0 };
    },
    loadMain: () => ({
      runSessionHost(options) {
        events.push("run");
        captured.push(options);
        return 19;
      },
    }),
  });
  assert.equal(await launcher.__test.runSessionHostLauncher(["--", "--help"], overrides), 19);
  assert.deepEqual(events, ["pi", "ddgs", "run"]);
  assert.deepEqual(captured[0].args, ["--help"]);
  // No manual path: the automatic resolver's entry always reaches the host.
  assert.equal(captured[0].piExecutable, "/synthetic/pi");
  assert.equal(Object.hasOwn(captured[0], "stateRoot"), false);
  assert.equal(Object.hasOwn(captured[0], "toggleKey"), false);
});

test("shared Node DDGS provisioning uses the synthetic venv and sanitized production env", { skip: process.platform === "win32" }, async (t) => {
  const fixture = makePackageFixture(false);
  cleanupFixture(t, fixture);
  const venv = join(fixture.root, "synthetic venv");
  const pythonDir = join(venv, "bin");
  mkdirSync(pythonDir, { recursive: true });
  const log = join(fixture.root, "fake-python-log.jsonl");
  const fakePython = join(pythonDir, "python");
  writeFileSync(fakePython, `#!${process.execPath}\nconst fs = require("node:fs");\nfs.appendFileSync(process.env.TEST_DDGS_LOG, JSON.stringify({ argv: process.argv.slice(2), bootstrap: process.env.PI_REVIEW_GATE_SESSION_HOST_BOOTSTRAP ?? null, restore: process.env.PI_REVIEW_GATE_SESSION_HOST_NODE_OPTIONS_RESTORE ?? null, nodeOptions: process.env.NODE_OPTIONS ?? null, provider: process.env.ANTHROPIC_API_KEY ?? null }) + "\\n");\n`, "utf8");
  chmodSync(fakePython, 0o755);

  // Production-like env seam: the launcher scrubs process.env in place, and
  // the shared helper's Python children inherit exactly that scrubbed env.
  const saved: Record<string, string | undefined> = {};
  for (const name of ["PI_REVIEW_GATE_SESSION_HOST_BOOTSTRAP", "PI_REVIEW_GATE_SESSION_HOST_NODE_OPTIONS_RESTORE", "NODE_OPTIONS", "ANTHROPIC_API_KEY", "TEST_DDGS_LOG", "PI_REVIEW_GATE_RUNTIME_ROLE", "PI_REVIEW_GATE_EXECUTOR_TOOL_CATALOG", "PI_REVIEW_GATE_DDGS_VENV"]) {
    saved[name] = process.env[name];
    delete process.env[name];
  }
  t.after(() => {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });
  process.env.PI_REVIEW_GATE_SESSION_HOST_BOOTSTRAP = "bootstrap-secret";
  process.env.PI_REVIEW_GATE_SESSION_HOST_NODE_OPTIONS_RESTORE = "restore-secret";
  process.env.NODE_OPTIONS = "--no-warnings";
  process.env.ANTHROPIC_API_KEY = "provider-secret";
  process.env.TEST_DDGS_LOG = log;
  process.env.PI_REVIEW_GATE_DDGS_VENV = venv;

  const env = makeEnvironment({
    HOME: fixture.root,
    XDG_CACHE_HOME: join(fixture.root, "cache"),
    PI_REVIEW_GATE_DDGS_VENV: venv,
  });
  const events: string[] = [];
  const captured: HostOptions[] = [];
  const result = await launcher.__test.runSessionHostLauncher([], baseOverrides(fixture.packageRoot, env, events, captured, {
    getEnv: () => process.env,
    processEnv: process.env,
    ensureDdgs: (homeDir, setupEnv) => { events.push("ddgs"); return gateLauncher.ensureDdgs(homeDir, setupEnv); },
  }));
  assert.equal(result, 0);
  assert.deepEqual(events, ["pi", "ddgs", "load", "run"]);
  assert.equal(captured[0].env.PI_REVIEW_GATE_DDGS_PYTHON, fakePython);
  assert.equal(captured[0].env.NODE_OPTIONS, "--no-warnings");
  assert.equal(captured[0].env.ANTHROPIC_API_KEY, "provider-secret");
  const pythonCalls = readFileSync(log, "utf8").trim().split("\n").map((line) => JSON.parse(line) as {
    argv: string[];
    bootstrap: string | null;
    restore: string | null;
    nodeOptions: string | null;
    provider: string | null;
  });
  // The shared helper validates twice by design (pre-install decision and
  // final gate): version check + pip check per pass.
  assert.equal(pythonCalls.length, 4, "a valid cached venv runs two validation passes");
  for (const call of pythonCalls) {
    assert.equal(call.bootstrap, null, "the bootstrap token never reaches DDGS descendants");
    assert.equal(call.restore, null, "the restore marker never reaches DDGS descendants");
    assert.equal(call.nodeOptions, "--no-warnings", "the original NODE_OPTIONS is preserved");
    assert.equal(call.provider, "provider-secret", "trusted provider variables are preserved");
  }
});

test("a broken DDGS venv stops the launch before loading the host", { skip: process.platform === "win32" }, async (t) => {
  const fixture = makePackageFixture(false);
  cleanupFixture(t, fixture);
  const venv = join(fixture.root, "broken venv");
  const pythonDir = join(venv, "bin");
  mkdirSync(pythonDir, { recursive: true });
  const fakePython = join(pythonDir, "python");
  // Validation always fails; the install step succeeds but cannot repair it.
  // The venv python is invoked as `python -I -c ...`, so `-c` is argv[3]
  // in the child (argv[1] is the script itself).
  writeFileSync(fakePython, `#!${process.execPath}\nif (process.argv[3] === "-c") process.exit(1);\n`, "utf8");
  chmodSync(fakePython, 0o755);

  const env = makeEnvironment({
    HOME: fixture.root,
    XDG_CACHE_HOME: join(fixture.root, "cache"),
    PI_REVIEW_GATE_DDGS_VENV: venv,
  });
  const events: string[] = [];
  let stderr = "";
  const result = await launcher.__test.runSessionHostLauncher([], baseOverrides(fixture.packageRoot, env, events, [], {
    ensureDdgs: (homeDir, setupEnv) => { events.push("ddgs"); return gateLauncher.ensureDdgs(homeDir, setupEnv); },
    writeError: (text) => { stderr += text; },
  }));
  assert.equal(result, 1);
  assert.deepEqual(events, ["pi", "ddgs"]);
  // The helper's fail-closed diagnostics go to fd 2 directly; the launcher
  // must still stop before loading the host and report a bounded failure.
  assert.match(stderr, /DDGS setup failed/);
});

test("Pi runtime resolution failure stops the launch before DDGS and host load", async (t) => {
  const fixture = makePackageFixture(true);
  cleanupFixture(t, fixture);
  const env = makeEnvironment();
  const events: string[] = [];
  let stderr = "";
  const status = await launcher.__test.runSessionHostLauncher([], baseOverrides(fixture.packageRoot, env, events, [], {
    // A non-PiRuntimeError must be sanitized: no resolver detail may leak.
    resolvePiRuntime: () => { throw new Error("the pi runtime at /synthetic/secret is unavailable"); },
    writeError: (text) => { stderr += text; },
  }));
  assert.equal(status, 1);
  assert.deepEqual(events, ["build"]);
  assert.match(stderr, /Pi runtime selection failed\./);
  assert.doesNotMatch(stderr, /secret/);
});

test("role, platform, Node floor, and TTY failures stop before setup without leaking values", async () => {
  const failures: Array<{ env: NodeJS.ProcessEnv; overrides: Partial<LauncherOverrides>; expected: RegExp; secret?: string }> = [
    {
      env: makeEnvironment({ PI_REVIEW_GATE_RUNTIME_ROLE: "private-role-secret" }),
      overrides: {},
      expected: /PI_REVIEW_GATE_RUNTIME_ROLE/,
      secret: "private-role-secret",
    },
    {
      env: makeEnvironment({ PI_REVIEW_GATE_EXECUTOR_TOOL_CATALOG: "private-catalog-secret" }),
      overrides: {},
      expected: /PI_REVIEW_GATE_EXECUTOR_TOOL_CATALOG/,
      secret: "private-catalog-secret",
    },
    { env: makeEnvironment(), overrides: { platform: "freebsd" }, expected: /macOS\/Linux and Windows source admission only/ },
    { env: makeEnvironment(), overrides: { nodeVersion: "22.18.9" }, expected: /Node >=22\.19\.0/ },
    { env: makeEnvironment(), overrides: { nodeVersion: "22.19.0-rc.1" }, expected: /Node >=22\.19\.0/ },
    { env: makeEnvironment(), overrides: { stdinIsTTY: false }, expected: /interactive stdin and stdout/ },
    { env: makeEnvironment(), overrides: { stdoutIsTTY: false }, expected: /interactive stdin and stdout/ },
  ];
  for (const failure of failures) {
    const events: string[] = [];
    let stderr = "";
    const status = await launcher.__test.runSessionHostLauncher([], {
      getEnv: () => failure.env,
      processEnv: {},
      platform: "linux",
      nodeVersion: "22.19.0",
      stdinIsTTY: true,
      stdoutIsTTY: true,
      packageRoot: process.cwd(),
      build: () => { events.push("build"); return { status: 0 }; },
      resolvePiRuntime: () => { events.push("pi"); return { file: "/synthetic/pi", version: "1.0.4", source: "npm-global" }; },
      ensureDdgs: () => { events.push("ddgs"); return { ok: true, python: "/tmp/python" }; },
      loadMain: () => { events.push("load"); return { runSessionHost: () => 0 }; },
      writeOut: () => undefined,
      writeError: (text) => { stderr += text; },
      ...failure.overrides,
    });
    assert.notEqual(status, 0);
    assert.deepEqual(events, []);
    assert.match(stderr, failure.expected);
    if (failure.secret) assert.doesNotMatch(stderr, new RegExp(failure.secret));
  }
});

test("help bypasses the startup override check as well as all environment and TTY preflight", async () => {
  let envRead = false;
  let output = "";
  const status = await launcher.__test.runSessionHostLauncher(["--help", "--", "--session", "/tmp/old.jsonl"], {
    getEnv: () => { envRead = true; throw new Error("must not inspect environment"); },
    stdinIsTTY: false,
    stdoutIsTTY: false,
    platform: "win32",
    nodeVersion: "1.0.0",
    writeOut: (text) => { output = text; },
    writeError: (text) => { output += text; },
  });
  assert.equal(status, 0);
  assert.equal(envRead, false);
  assert.match(output, /startup session\s+overrides/);
});

test("help bypasses all environment and TTY preflight", async () => {
  let envRead = false;
  let output = "";
  const status = await launcher.__test.runSessionHostLauncher(["--help"], {
    getEnv: () => { envRead = true; throw new Error("must not inspect environment"); },
    stdinIsTTY: false,
    stdoutIsTTY: false,
    platform: "win32",
    nodeVersion: "1.0.0",
    writeOut: (text) => { output = text; },
    writeError: (text) => { output += text; },
  });
  assert.equal(status, 0);
  assert.equal(envRead, false);
  assert.match(output, /terminal\s+graphics rendering\s+is disabled/);
  assert.match(output, /native image\/model input behavior\s+stays\s+native/i);
});

test("build and DDGS failures propagate safely and prevent loading the host", async (t) => {
  const fixture = makePackageFixture(true);
  cleanupFixture(t, fixture);
  const env = makeEnvironment({ PI_REVIEW_GATE_SESSION_HOST_BOOTSTRAP: "never-print-this" });

  for (const failure of [
    {
      label: "build status",
      build: () => ({ status: 23 }),
      ensure: () => ({ ok: true, python: "/synthetic/python" }),
      expected: 23,
      events: ["build"],
    },
    {
      label: "build spawn error",
      build: () => ({ status: null, error: new Error("never-print-this") }),
      ensure: () => ({ ok: true, python: "/synthetic/python" }),
      expected: 1,
      events: ["build"],
    },
    {
      label: "DDGS status",
      build: () => ({ status: 0 }),
      ensure: () => ({ ok: false, exitCode: 17 }),
      expected: 17,
      events: ["build", "pi", "ddgs"],
    },
  ]) {
    const events: string[] = [];
    let stderr = "";
    const status = await launcher.__test.runSessionHostLauncher([], baseOverrides(fixture.packageRoot, env, events, [], {
      build: ({ env: setupEnv }) => {
        events.push("build");
        assert.equal(setupEnv.PI_REVIEW_GATE_SESSION_HOST_BOOTSTRAP, undefined);
        return failure.build();
      },
      ensureDdgs: () => { events.push("ddgs"); return failure.ensure(); },
      loadMain: () => { events.push("load"); return { runSessionHost: () => 0 }; },
      writeError: (text) => { stderr += text; },
    }));
    assert.equal(status, failure.expected, failure.label);
    assert.deepEqual(events, failure.events, failure.label);
    assert.doesNotMatch(stderr, /never-print-this/);
  }
});

test("host-module failures and invalid DDGS paths fail closed with bounded diagnostics", async (t) => {
  const fixture = makePackageFixture(false);
  cleanupFixture(t, fixture);
  const env = makeEnvironment();
  for (const mode of ["module-load", "missing-api", "runtime-reject", "bad-python"] as const) {
    const events: string[] = [];
    let stderr = "";
    const status = await launcher.__test.runSessionHostLauncher([], baseOverrides(fixture.packageRoot, env, events, [], {
      ensureDdgs: () => {
        events.push("ddgs");
        return { ok: true, python: mode === "bad-python" ? "relative/python" : "/synthetic/python" };
      },
      loadMain: () => {
        events.push("load");
        if (mode === "module-load") throw new Error("credential-must-not-appear");
        if (mode === "missing-api") return {} as { runSessionHost(options: HostOptions): number };
        if (mode === "runtime-reject") {
          return { runSessionHost: async () => { throw new Error("credential-must-not-appear"); } };
        }
        return { runSessionHost: () => 0 };
      },
      writeError: (text) => { stderr += text; },
    }));
    assert.notEqual(status, 0, mode);
    assert.doesNotMatch(stderr, /credential-must-not-appear/);
    if (mode === "bad-python") assert.deepEqual(events, ["pi", "ddgs"]);
  }
});

test("missing compiled host never falls back to the review-gate entry", async (t) => {
  const fixture = makePackageFixture(false);
  cleanupFixture(t, fixture);
  unlinkSync(join(fixture.packageRoot, "dist", "src", "session-host", "main.js"));
  const events: string[] = [];
  let stderr = "";
  const status = await launcher.__test.runSessionHostLauncher([], {
    getEnv: () => makeEnvironment(),
    processEnv: {},
    platform: "linux",
    nodeVersion: "22.19.0",
    stdinIsTTY: true,
    stdoutIsTTY: true,
    packageRoot: fixture.packageRoot,
    build: () => { events.push("build"); return { status: 0 }; },
    resolvePiRuntime: () => { events.push("pi"); return { file: "/synthetic/pi", version: "1.0.4", source: "npm-global" }; },
    ensureDdgs: () => { events.push("ddgs"); return { ok: true, python: "/synthetic/python" }; },
    loadMain: () => { events.push("load"); return { runSessionHost: () => 0 }; },
    writeOut: () => undefined,
    writeError: (text) => { stderr += text; },
  });
  assert.equal(status, 2);
  assert.deepEqual(events, []);
  assert.match(stderr, /compiled native session host is unavailable/);
});

// ---------------------------------------------------------------------------
// Pi runtime selection (issue 323): synthetic OWNROOT package metadata,
// public npm Node bins, and runtime cache directories. No real HOME, SDK, or global
// npm root is ever touched.
// ---------------------------------------------------------------------------

interface RuntimeFixture extends OwnedFixture {
  root: string;
  bin: string;
  agentDir: string;
  globalRoot: string;
  npmLog: string;
}

function makeRuntimeFixture(prefix: string): RuntimeFixture {
  const root = mkdtempSync(join(process.cwd(), "node_modules", prefix));
  const rootStats = lstatSync(root, { bigint: true });
  const fixture = {
    root,
    identity: { dev: rootStats.dev, ino: rootStats.ino },
    bin: join(root, "bin"),
    agentDir: join(root, "agent dir π"),
    // The npm global root is the bare node_modules directory; the resolver
    // appends the scoped package path itself.
    globalRoot: join(root, "global root"),
    npmLog: join(root, "npm-invocations.jsonl"),
  };
  mkdirSync(fixture.bin, { recursive: true });
  return fixture;
}

/** A positive Node CLI entry that reports a fixed version and logs its env. */
function writePiEntry(file: string, version: string, logEnv = false): string {
  mkdirSync(join(file, ".."), { recursive: true });
  const lines = ["#!/usr/bin/env node"];
  if (logEnv) {
    lines.push(
      `const fs = require("node:fs");`,
      `if (process.argv[2] === "--version" && process.env.PI_PROBE_LOG) fs.writeFileSync(process.env.PI_PROBE_LOG, JSON.stringify({ args: process.argv.slice(1), bootstrap: process.env.PI_REVIEW_GATE_SESSION_HOST_BOOTSTRAP ?? null, restore: process.env.PI_REVIEW_GATE_SESSION_HOST_NODE_OPTIONS_RESTORE ?? null, nodeOptions: process.env.NODE_OPTIONS ?? null, provider: process.env.ANTHROPIC_API_KEY ?? null }));`,
    );
  }
  lines.push(`if (process.argv[2] === "--version") console.log("pi ${version}");`);
  writeFileSync(file, `${lines.join("\n")}\n`, "utf8");
  chmodSync(file, 0o755);
  return file;
}

function writePiPackage(pkgDir: string, version = "1.0.4", name = launcher.PI_PACKAGE_NAME): string {
  const entry = join(pkgDir, "dist", "bundle", "cli.js");
  mkdirSync(join(pkgDir, "dist", "bundle"), { recursive: true });
  writeFileSync(join(pkgDir, "package.json"), JSON.stringify({
    name,
    version,
    bin: { pi: "dist/bundle/cli.js" },
  }), "utf8");
  writePiEntry(entry, version);
  return entry;
}

test("POSIX PATH discovery canonicalizes npm bin symlinks without spawning the Pi CLI", { skip: process.platform === "win32" }, async (t) => {
  const fixture = makeRuntimeFixture(".session-host-pi-path-symlink-");
  cleanupFixture(t, fixture);
  const pkgDir = join(fixture.root, "path install", "@earendil-works", "pi-coding-agent");
  const pathEntry = writePiPackage(pkgDir);
  const candidate = join(fixture.bin, "pi");
  symlinkSync(pathEntry, candidate);
  const env = runtimeEnv(fixture);
  const discovered = launcher.__test.findPiOnPath(env);
  assert.ok(discovered);
  assert.equal(discovered, realpathSync(pathEntry));

  let probes = 0;
  const validated = await launcher.__test.validatePiPackage(pkgDir, env, {
    expectedFile: discovered,
    processRunner: async (file, args) => {
      probes += 1;
      assert.equal(file, process.execPath);
      assert.deepEqual(args, [discovered, "--version"]);
      return { status: 0, signal: null, timedOut: false, outputExceeded: false, stdout: "pi 1.0.4" };
    },
  });
  assert.deepEqual(validated, { file: realpathSync(pathEntry), version: "1.0.4" });
  assert.equal(probes, 1, "the only version check is an injected public-Node result; no CLI subprocess is started");
});

function writeFakeNpm(fixture: RuntimeFixture, behavior: "global" | "install" | "timeout-build" = "global"): void {
  const fakeNpm = join(fixture.bin, "npm");
  writeFileSync(join(fixture.bin, "package.json"), JSON.stringify({ name: "npm", version: "10.0.0", bin: { npm: "npm" } }), "utf8");
  const lines = [
    `const fs = require("node:fs");`,
    `const args = process.argv.slice(2);`,
    `fs.appendFileSync(process.env.PI_NPM_LOG, JSON.stringify({ args }) + "\\n");`,
  ];
  if (behavior === "global") {
    lines.push(`if (args[0] === "root") { if (process.env.PI_FAKE_GLOBAL_ROOT) console.log(process.env.PI_FAKE_GLOBAL_ROOT); process.exit(0); }`);
    lines.push(`process.exit(1);`);
  } else if (behavior === "timeout-build") {
    // Only the locked ci install invokes npm; it places the stage's inert
    // installed TypeScript fixture. The compile deadline is exercised by the
    // injected compile seam in the timeout test.
    lines.push(`if (args[0] !== "ci") { process.exit(0); }`);
    lines.push(...inertStageTypeScriptScriptLines());
    lines.push(`process.exit(0);`);
  } else {
    // install --prefix <staging> --ignore-scripts --no-audit --no-fund
    // --registry https://registry.npmjs.org @earendil-works/pi-coding-agent@pinned
    // The fake publishes the exact pinned provision version so a
    // provisioning-specific mock never depends on a stale pin.
    lines.push(`if (process.env.PI_FAKE_NPM_FAIL) process.exit(7);`);
    lines.push(`if (args[0] === "install") {`);
    lines.push(`  const prefix = args[args.indexOf("--prefix") + 1];`);
    lines.push(`  const pkgDir = require("node:path").join(prefix, "node_modules", "@earendil-works", "pi-coding-agent");`);
    lines.push(`  fs.mkdirSync(require("node:path").join(pkgDir, "dist", "bundle"), { recursive: true });`);
    lines.push(`  fs.writeFileSync(require("node:path").join(pkgDir, "package.json"), JSON.stringify({ name: "@earendil-works/pi-coding-agent", version: "${launcher.PI_PROVISION_VERSION}", bin: { pi: "dist/bundle/cli.js" } }));`);
    lines.push(`  const entry = require("node:path").join(pkgDir, "dist", "bundle", "cli.js");`);
    lines.push(`  fs.writeFileSync(entry, "#!/usr/bin/env node\\nif (process.argv[2] === '--version') console.log('pi ${launcher.PI_PROVISION_VERSION}');\\n");`);
    lines.push(`  fs.chmodSync(entry, 0o755);`);
    lines.push(`  if (process.env.PI_FAKE_PUBLISH_ROOT) {`);
    lines.push(`    const concurrentPkg = require("node:path").join(process.env.PI_FAKE_PUBLISH_ROOT, "node_modules", "@earendil-works", "pi-coding-agent");`);
    lines.push(`    fs.mkdirSync(require("node:path").join(concurrentPkg, "dist", "bundle"), { recursive: true });`);
    lines.push(`    fs.writeFileSync(require("node:path").join(concurrentPkg, "package.json"), JSON.stringify({ name: "@earendil-works/pi-coding-agent", version: "${launcher.PI_PROVISION_VERSION}", bin: { pi: "dist/bundle/cli.js" } }));`);
    lines.push(`    const concurrentEntry = require("node:path").join(concurrentPkg, "dist", "bundle", "cli.js");`);
    lines.push(`    fs.writeFileSync(concurrentEntry, "#!/usr/bin/env node\\nif (process.argv[2] === '--version') console.log('pi ${launcher.PI_PROVISION_VERSION}');\\n");`);
    lines.push(`    fs.chmodSync(concurrentEntry, 0o755);`);
    lines.push(`  }`);
    lines.push(`}`);
    lines.push(`process.exit(0);`);
  }
  writeFileSync(fakeNpm, `#!/usr/bin/env node\n${lines.join("\n")}\n`, "utf8");
}

function runtimeEnv(fixture: RuntimeFixture, overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  // Fixture-only PATH: automatic-resolution tests must never reach the real
  // npm, a real global Pi install, or any system tool outside the fixture.
  return makeEnvironment({
    PATH: fixture.bin,
    HOME: fixture.root,
    PI_NPM_LOG: fixture.npmLog,
    ...overrides,
  });
}

test("npm PATH resolution uses the native delimiter and rejects opaque shim-only candidates", (t) => {
  const fixture = makeRuntimeFixture(".session-host-npm-resolution-");
  cleanupFixture(t, fixture);
  writeFakeNpm(fixture, "global");
  const env = runtimeEnv(fixture, { PATH: `${join(fixture.root, "missing path")}${delimiter}${fixture.bin}` });
  assert.equal(launcher.__test.findNpmCli(env), join(fixture.bin, "npm"));

  const shimOnly = join(fixture.root, "shim only");
  mkdirSync(shimOnly);
  writeFileSync(join(shimOnly, "npm.cmd"), "@echo off\r\necho opaque shim\r\n", "utf8");
  assert.equal(launcher.__test.findNpmCli(runtimeEnv(fixture, { PATH: shimOnly })), undefined);
});

test("a timed-out source build that exits zero on SIGTERM never falls through to the checkout", async (t) => {
  const runtimeFixture = makeRuntimeFixture(".session-host-build-timeout-");
  const sourceFixture = makePackageFixture(true);
  cleanupFixture(t, runtimeFixture);
  cleanupFixture(t, sourceFixture);
  writeFakeNpm(runtimeFixture, "timeout-build");
  const compileChild = join(runtimeFixture.root, "hanging-compile-child.js");
  writeFileSync(compileChild, "process.on('SIGTERM', () => process.exit(0)); setInterval(() => {}, 1000);\n", "utf8");
  const events: string[] = [];
  let buildResult: BuildResult | undefined;
  let stderr = "";
  const status = await launcher.__test.runSessionHostLauncher(["--", "--scheduler"], {
    getEnv: () => runtimeEnv(runtimeFixture),
    processEnv: {},
    platform: "linux",
    nodeVersion: "22.19.0",
    stdinIsTTY: true,
    stdoutIsTTY: true,
    packageRoot: sourceFixture.packageRoot,
    cwd: runtimeFixture.root,
    build: async (options) => {
      events.push("build");
      buildResult = await launcher.__test.buildSourceExtension({
        ...options,
        sourceBuildTimeoutMs: 500,
        runCompile: (compilerCli, args, compileOptions) => {
          void compilerCli;
          void args;
          return launcher.__test.runBoundedProcess(process.execPath, [compileChild], compileOptions);
        },
      });
      return buildResult;
    },
    resolvePiRuntime: () => { events.push("pi"); return { file: "/synthetic/pi", version: "1.0.4", source: "npm-global" }; },
    ensureDdgs: () => { events.push("ddgs"); return { ok: true, python: "/synthetic/python" }; },
    loadMain: () => { events.push("load"); return { runSessionHost: () => 0 }; },
    writeOut: () => undefined,
    writeError: (text) => { stderr += text; },
  });
  assert.equal(status, 124);
  assert.equal(buildResult?.timedOut, true);
  assert.equal(buildResult?.stage, "compile", "the compile stage owns the admitted deadline");
  assert.equal(buildResult?.childStatus, 0, "the synthetic compile child handled SIGTERM with exit 0");
  assert.equal(buildResult?.status, 124, "expiration remains a nonzero build outcome");
  assert.deepEqual(events, ["build"], "runtime resolution, DDGS, and Main are not reached");
  assert.match(stderr, /extension build failed \(setup deadline exceeded\)/);
  assert.equal(readFileSync(join(sourceFixture.packageRoot, "dist", "src", "session-host", "main.js"), "utf8"), "LIVE DIST SENTINEL — never rebuild in place\n");
});

// The cleanup contract differs by platform and is asserted honestly: Windows
// has no public process-tree proof for any abnormal outcome (see the
// boundedProcessCleanupStatus contract test), while POSIX confirms its own
// owned process group is gone. runBoundedProcess reads the real
// process.platform, so a launcher platform override cannot change this.
const ABNORMAL_CLEANUP_SETTLES = process.platform !== "win32";

test("bounded setup subprocesses preserve exit outcomes and terminate expired groups", async (t) => {
  const fixture = makeRuntimeFixture(".session-host-bounded-process-");
  cleanupFixture(t, fixture);
  const exitScript = join(fixture.root, "exit.js");
  const timeoutScript = join(fixture.root, "timeout.js");
  const outputScript = join(fixture.root, "output.js");
  writeFileSync(exitScript, "process.exit(19);\n", "utf8");
  writeFileSync(timeoutScript, "setInterval(() => {}, 1000);\n", "utf8");
  writeFileSync(outputScript, "process.stdout.write('too much'); setInterval(() => {}, 1000);\n", "utf8");
  const env = runtimeEnv(fixture);

  const exited = await launcher.__test.runBoundedProcess(process.execPath, [exitScript], {
    cwd: fixture.root, env, timeoutMs: 1000, maxOutputBytes: 32, captureStdout: true,
  });
  assert.equal(exited.status, 19);
  assert.equal(exited.timedOut, false);
  assert.equal(exited.cleanupConfirmed, ABNORMAL_CLEANUP_SETTLES);
  const expired = await launcher.__test.runBoundedProcess(process.execPath, [timeoutScript], {
    cwd: fixture.root, env, timeoutMs: 25,
  });
  assert.equal(expired.timedOut, true);
  assert.equal(expired.cleanupConfirmed, ABNORMAL_CLEANUP_SETTLES, "termination is followed by the platform's own settlement evidence");
  assert.ok(expired.signal || expired.status !== 0, "expiration is not reported as a successful exit");
  const oversized = await launcher.__test.runBoundedProcess(process.execPath, [outputScript], {
    cwd: fixture.root, env, timeoutMs: 1000, maxOutputBytes: 4, captureStdout: true,
  });
  assert.equal(oversized.outputExceeded, true);
  assert.equal(oversized.cleanupConfirmed, ABNORMAL_CLEANUP_SETTLES);
});

test("bounded process diagnostics separate stdout from stderr under one shared capture ceiling", async (t) => {
  const fixture = makeRuntimeFixture(".session-host-bounded-streams-");
  cleanupFixture(t, fixture);
  const streamsScript = join(fixture.root, "streams.js");
  const stdoutFlood = join(fixture.root, "stdout-flood.js");
  const stderrFlood = join(fixture.root, "stderr-flood.js");
  const combinedFlood = join(fixture.root, "combined-flood.js");
  // Synthetic child: distinguishable streams and a truthful nonzero exit.
  // A natural exit (exitCode, not process.exit) lets piped writes flush.
  writeFileSync(streamsScript, "process.stdout.write('OUT-MARKER\\n'); process.stderr.write('ERR-MARKER\\n'); process.exitCode = 7;\n", "utf8");
  writeFileSync(stdoutFlood, "const fs = require('node:fs'); fs.writeSync(1, 'o'.repeat(64)); setInterval(() => {}, 1000);\n", "utf8");
  writeFileSync(stderrFlood, "const fs = require('node:fs'); fs.writeSync(2, 'e'.repeat(64)); setInterval(() => {}, 1000);\n", "utf8");
  // 12 + 12 bytes: each stream stays under the 16-byte ceiling alone, so only
  // a genuinely shared accounting can report this as over the limit.
  writeFileSync(combinedFlood, "const fs = require('node:fs'); fs.writeSync(1, 'o'.repeat(12)); fs.writeSync(2, 'e'.repeat(12)); setInterval(() => {}, 1000);\n", "utf8");
  const env = runtimeEnv(fixture);

  const captured = await launcher.__test.runBoundedProcess(process.execPath, [streamsScript], {
    cwd: fixture.root, env, timeoutMs: 5000, maxOutputBytes: 1024, captureStdout: true, captureStderr: true,
  });
  assert.equal(captured.status, 7, "the true child status survives capture");
  assert.equal(captured.signal, null);
  assert.equal(captured.timedOut, false);
  assert.equal(captured.outputExceeded, false);
  assert.equal(captured.cleanupConfirmed, ABNORMAL_CLEANUP_SETTLES);
  assert.match(captured.stdout, /OUT-MARKER/);
  assert.doesNotMatch(captured.stdout, /ERR-MARKER/);
  assert.match(captured.stderr ?? "", /ERR-MARKER/);
  assert.doesNotMatch(captured.stderr ?? "", /OUT-MARKER/);

  // A probe that does not admit stderr keeps its original shape: stdout only.
  const probeOnly = await launcher.__test.runBoundedProcess(process.execPath, [streamsScript], {
    cwd: fixture.root, env, timeoutMs: 5000, maxOutputBytes: 1024, captureStdout: true,
  });
  assert.equal("stderr" in probeOnly, false, "a stream that is not admitted is not reported");
  assert.equal(probeOnly.status, 7);
  assert.match(probeOnly.stdout, /OUT-MARKER/);
  assert.equal(probeOnly.cleanupConfirmed, ABNORMAL_CLEANUP_SETTLES);

  // Both streams count against the same hard ceiling, and flooding it is a
  // failure report, never silent success or unbounded retention.
  const stdoutOverflow = await launcher.__test.runBoundedProcess(process.execPath, [stdoutFlood], {
    cwd: fixture.root, env, timeoutMs: 5000, maxOutputBytes: 16, captureStdout: true, captureStderr: true,
  });
  assert.equal(stdoutOverflow.outputExceeded, true, "a stdout flood exceeds the shared ceiling");
  assert.equal(stdoutOverflow.cleanupConfirmed, ABNORMAL_CLEANUP_SETTLES);
  assert.notEqual(stdoutOverflow.status, 0, "an over-limit child never reads as a clean exit");

  const stderrOverflow = await launcher.__test.runBoundedProcess(process.execPath, [stderrFlood], {
    cwd: fixture.root, env, timeoutMs: 5000, maxOutputBytes: 16, captureStdout: true, captureStderr: true,
  });
  assert.equal(stderrOverflow.outputExceeded, true, "a stderr flood shares the same hard ceiling");
  assert.equal(stderrOverflow.cleanupConfirmed, ABNORMAL_CLEANUP_SETTLES);
  assert.notEqual(stderrOverflow.status, 0, "a stderr flood is never reported as success");

  const combinedOverflow = await launcher.__test.runBoundedProcess(process.execPath, [combinedFlood], {
    cwd: fixture.root, env, timeoutMs: 5000, maxOutputBytes: 16, captureStdout: true, captureStderr: true,
  });
  assert.equal(combinedOverflow.outputExceeded, true, "stdout and stderr bytes are counted together, not per stream");
  assert.equal(combinedOverflow.cleanupConfirmed, ABNORMAL_CLEANUP_SETTLES);
  assert.notEqual(combinedOverflow.status, 0, "combined overflow is never reported as success");
});

test("an admitted stream read error settles as a bounded failure without inventing cleanup", async (t) => {
  const fixture = makeRuntimeFixture(".session-host-bounded-stream-error-");
  cleanupFixture(t, fixture);
  const childScript = join(fixture.root, "stream-error-child.js");
  // The synthetic child installs its SIGTERM answer, then announces readiness
  // on stdout, so the injected stream error is guaranteed to arrive after the
  // handler exists and the child's own exit can be zero.
  writeFileSync(childScript, "process.on('SIGTERM', () => process.exit(0)); process.stdout.write('ready\\n'); setInterval(() => {}, 1000);\n", "utf8");
  const env = runtimeEnv(fixture);

  for (const stream of ["stdout", "stderr"] as const) {
    const startedAt = Date.now();
    const result = await launcher.__test.runBoundedProcess(process.execPath, [childScript], {
      cwd: fixture.root, env, timeoutMs: 5000, maxOutputBytes: 1024, captureStdout: true, captureStderr: true,
      testHooks: {
        onStreams: (streams: { stdout?: NodeJS.ReadableStream; stderr?: NodeJS.ReadableStream }) => {
          // Rendezvous on the child's readiness marker, then error one admitted
          // stream; nothing here changes production behavior.
          streams.stdout?.once("data", () => {
            streams[stream]?.emit("error", new Error(`synthetic ${stream} stream error`));
          });
        },
      },
    });
    const elapsed = Date.now() - startedAt;
    assert.ok(result.error instanceof Error, `${stream}: the stream error is recorded, not left unhandled`);
    assert.match(result.error?.message ?? "", new RegExp(`synthetic ${stream} stream error`));
    assert.equal(result.timedOut, false);
    assert.equal(result.outputExceeded, false);
    assert.equal(result.cleanupConfirmed, ABNORMAL_CLEANUP_SETTLES);
    assert.ok(elapsed < 3_000, `${stream}: settlement stays bounded (elapsed ${elapsed} ms)`);
    if (process.platform !== "win32") {
      assert.equal(result.status, 0, `${stream}: the child's own zero exit is preserved`);
      assert.equal(result.signal, null);
    }
  }
});

test("a synthetic stream read error is never admitted as a successful build", async (t) => {
  const source = makePackageFixture(true);
  const runtime = makeRuntimeFixture(".session-host-build-stream-error-");
  cleanupFixture(t, source);
  cleanupFixture(t, runtime);
  writeFakeNpm(runtime);
  const childScript = join(runtime.root, "stream-error-child.js");
  writeFileSync(childScript, "process.on('SIGTERM', () => process.exit(0)); setInterval(() => {}, 1000);\n", "utf8");

  // The seam routes the admitted stage call through the real bounded process,
  // so the recorded stream error reaches the install failure path unchanged.
  const result = await launcher.__test.buildSourceExtension({
    packageRoot: source.packageRoot,
    agentDir: runtime.agentDir,
    env: runtimeEnv(runtime),
    runNpm: (npmCli, args, options) => {
      void npmCli;
      void args;
      return launcher.__test.runBoundedProcess(process.execPath, [childScript], {
        ...options,
        testHooks: {
          onStreams: (streams: { stdout?: NodeJS.ReadableStream }) => {
            streams.stdout?.emit("error", new Error("synthetic stdout stream error"));
          },
        },
      });
    },
  });
  assert.equal(result.stage, "install");
  assert.equal(result.status, 1, "a stream read error is a failed build, never a green one");
  assert.ok(result.error instanceof Error, "the recorded stream error reaches the build result");
  assert.match(result.error?.message ?? "", /synthetic stdout stream error/);
  assert.equal(result.cleanupConfirmed, ABNORMAL_CLEANUP_SETTLES);
});

test("build failure diagnostics keep stage identity, stream provenance, and bounded sanitized text", () => {
  const sanitized = launcher.__test.sanitizeDiagnosticText("\u001b[31mred\u001b[0m \u001b]0;title\u0007 plain\u0000\u0007tail");
  assert.doesNotMatch(sanitized, /\u001b|\u0007|\u0000/u, "terminal controls are removed, never passed through");
  assert.match(sanitized, /red/);
  assert.match(sanitized, /plain/);

  const bounded = launcher.__test.boundDiagnosticText("x".repeat(5000), 256);
  assert.ok(Buffer.byteLength(bounded, "utf8") <= 256, "emitted diagnostics never exceed their ceiling");
  assert.match(bounded, /diagnostic truncated/);

  const install = launcher.__test.formatBuildStageDiagnostics(
    { stdout: "install stdout line", stderr: "\u001b[31minstall stderr line\u001b[0m" },
    "install",
  );
  assert.match(install, /npm ci \(dependency install\) stdout:\ninstall stdout line/);
  assert.match(install, /npm ci \(dependency install\) stderr:\ninstall stderr line/);
  assert.doesNotMatch(install, /\u001b/u);

  const compile = launcher.__test.formatBuildStageDiagnostics({ stdout: "", stderr: "compile stderr line" }, "compile");
  assert.match(compile, /TypeScript compile \(tsc -p tsconfig\.json\) stderr:\ncompile stderr line/);
  assert.doesNotMatch(compile, /stdout/);
  assert.equal(launcher.__test.formatBuildStageDiagnostics({ stdout: "", stderr: "" }, "compile"), "", "no captured output emits no diagnostic block");

  const aggregate = launcher.__test.formatBuildStageDiagnostics({ stdout: "y".repeat(20000), stderr: "z".repeat(20000) }, "compile");
  assert.ok(Buffer.byteLength(aggregate, "utf8") <= 4096, "both provenance blocks share one aggregate ceiling");
  assert.match(aggregate, /diagnostic truncated/);
});

test("synthetic source build failures name the failing stage and preserve the true status", async (t) => {
  const source = makePackageFixture(true);
  const runtime = makeRuntimeFixture(".session-host-build-stage-diagnostics-");
  cleanupFixture(t, source);
  cleanupFixture(t, runtime);
  writeFakeNpm(runtime);

  const installFailure = await launcher.__test.buildSourceExtension({
    packageRoot: source.packageRoot,
    agentDir: runtime.agentDir,
    env: runtimeEnv(runtime),
    runNpm: async () => ({ status: 5, signal: null, cleanupConfirmed: true, timedOut: false, outputExceeded: false, stdout: "install stdout line\n", stderr: "\u001b[31minstall failed\u001b[0m\n" }),
  });
  assert.equal(installFailure.stage, "install");
  assert.equal(installFailure.status, 5, "the true install status is preserved");
  assert.equal(installFailure.childStatus, 5);
  assert.match(installFailure.diagnostics ?? "", /npm ci \(dependency install\) stderr:\ninstall failed\n/);
  assert.doesNotMatch(installFailure.diagnostics ?? "", /\u001b/u);

  // The compile seam is separate from the npm seam: install stays install-only
  // and the direct TypeScript compile is its own injected stage.
  const compileFailure = await launcher.__test.buildSourceExtension({
    packageRoot: source.packageRoot,
    agentDir: runtime.agentDir,
    env: runtimeEnv(runtime),
    runNpm: async (_npmCli, args, options) => {
      assert.equal(args[0], "ci");
      writeInertStageTypeScript(String(options.cwd));
      return { status: 0, signal: null, cleanupConfirmed: true, timedOut: false, outputExceeded: false, stdout: "" };
    },
    runCompile: async () => ({ status: 23, signal: null, cleanupConfirmed: true, timedOut: false, outputExceeded: false, stdout: "compile stdout line\n", stderr: "compile failed\n" }),
  });
  assert.equal(compileFailure.stage, "compile");
  assert.equal(compileFailure.status, 23);
  assert.match(compileFailure.diagnostics ?? "", /TypeScript compile \(tsc -p tsconfig\.json\) stdout:\ncompile stdout line\n/);
  assert.match(compileFailure.diagnostics ?? "", /TypeScript compile \(tsc -p tsconfig\.json\) stderr:\ncompile failed\n/);
});

test("a failing synthetic compile reports its bounded cause and never turns failure green", { skip: process.platform === "win32" }, async (t) => {
  const fixture = makePackageFixture(true);
  cleanupFixture(t, fixture);
  const bin = join(fixture.root, "fake-bin");
  mkdirSync(bin);
  const log = join(fixture.root, "npm-invocation.json");
  writeFileSync(join(bin, "package.json"), JSON.stringify({ name: "npm", version: "10.0.0", bin: { npm: "npm" } }), "utf8");
  writeFileSync(join(bin, "npm"), `#!/usr/bin/env node\n${[
    `const fs = require("node:fs");`,
    `const args = process.argv.slice(2);`,
    `fs.appendFileSync(process.env.TEST_NPM_LOG, JSON.stringify({ args, cwd: process.cwd() }) + "\\n");`,
    `if (args[0] !== "ci") { process.stderr.write("unexpected npm run lifecycle\\n"); process.exit(97); }`,
    ...inertStageTypeScriptScriptLines(),
    `process.exit(0);`,
    "",
  ].join("\n")}`, "utf8");

  const env = makeEnvironment({ HOME: fixture.root, PATH: `${bin}${delimiter}${process.env.PATH ?? ""}`, TEST_NPM_LOG: log });
  let stderr = "";
  const status = await launcher.__test.runSessionHostLauncher(["--", "--scheduler"], {
    getEnv: () => env,
    processEnv: {},
    platform: "linux",
    nodeVersion: "22.19.0",
    stdinIsTTY: true,
    stdoutIsTTY: true,
    packageRoot: fixture.packageRoot,
    build: (options) => launcher.__test.buildSourceExtension({
      ...options,
      runCompile: async () => ({
        status: 1,
        signal: null,
        cleanupConfirmed: true,
        timedOut: false,
        outputExceeded: false,
        stdout: "synthetic build stdout\n",
        stderr: "\u001b[31mTS2304: Cannot find name 'synthetic'.\u001b[0m\n",
      }),
    }),
    resolvePiRuntime: () => ({ file: "/synthetic/pi", version: "1.0.4", source: "npm-global" }),
    ensureDdgs: () => ({ ok: true, python: "/synthetic/python" }),
    loadMain: () => ({ runSessionHost: () => 0 }),
    writeOut: () => undefined,
    writeError: (text) => { stderr += text; },
  });
  assert.equal(status, 1, "the failing compile keeps its true nonzero status");
  assert.match(stderr, /extension build failed \(exit status 1\)/);
  assert.match(stderr, /failed build stage: TypeScript compile \(tsc -p tsconfig\.json\)/);
  assert.match(stderr, /TypeScript compile \(tsc -p tsconfig\.json\) stderr:\nTS2304: Cannot find name 'synthetic'\.\n/);
  assert.match(stderr, /TypeScript compile \(tsc -p tsconfig\.json\) stdout:\nsynthetic build stdout\n/);
  assert.doesNotMatch(stderr, /\u001b/u, "terminal controls from the failing child never reach the operator");
  assert.equal(readFileSync(join(fixture.packageRoot, "dist", "src", "session-host", "main.js"), "utf8"), "LIVE DIST SENTINEL — never rebuild in place\n");
});

// Parent-owned acceptance: real Windows cmd.exe parsing and runtime behavior
// stay with the parent; this file only locks the escaped source contract.
test("the native .cmd launcher escapes block-breaking parentheses in its role diagnostics", () => {
  const source = readFileSync(join(process.cwd(), "scripts", "pi-review-sessions.cmd"), "utf8");
  assert.ok(source.includes("\r\n"), "the batch file keeps CRLF line endings");
  // Inside a parenthesized IF block an unescaped "(" or ")" is parsed by
  // cmd.exe even when the condition is false, which aborts the launcher with
  // "<token> was unexpected at this time.". Every diagnostic parenthesis is
  // therefore caret-escaped.
  const echoLines = source.split("\r\n").filter((line) => /^\s*echo\b/u.test(line));
  assert.equal(echoLines.length, 3, "every diagnostic echo line is checked");
  for (const line of echoLines) {
    const text = line.slice(line.indexOf("echo") + "echo".length);
    for (const match of text.matchAll(/[()]/gu)) {
      const index = match.index ?? 0;
      assert.equal(text[index - 1], "^", `unescaped parenthesis would break the block: ${line.trim()}`);
    }
  }
  const roleCheck = source.indexOf("if defined PI_REVIEW_GATE_RUNTIME_ROLE");
  const catalogCheck = source.indexOf("if defined PI_REVIEW_GATE_EXECUTOR_TOOL_CATALOG");
  const bootstrapClear = source.indexOf('set "PI_REVIEW_GATE_SESSION_HOST_BOOTSTRAP="');
  assert.ok(roleCheck >= 0 && catalogCheck > roleCheck, "role and catalog rejection both precede any child");
  assert.ok(bootstrapClear > catalogCheck, "capability rejection precedes every environment mutation and child");
  assert.match(source, /DisableDelayedExpansion/);
  assert.match(source, /WindowsPowerShell\\v1\.0\\powershell\.exe/);
  assert.match(source, /-File "%~dp0pi-review-sessions-node\.ps1" %\*/);
  assert.equal(source.split("-File \"%~dp0pi-review-sessions-node.ps1\"").length, 2, "the original argument tail is forwarded exactly once");
  assert.doesNotMatch(source, /POSIX-only|POSIX only/u, "obsolete POSIX-only host prose is removed");
});

test("the provisioning mock follows the pinned provision version while older-Pi admission stays intact", async (t) => {
  const fixture = makeRuntimeFixture(".session-host-provision-pin-");
  cleanupFixture(t, fixture);
  writeFakeNpm(fixture, "install");
  const env = runtimeEnv(fixture);

  const provisioned = await launcher.__test.resolvePiRuntime({ env, agentDir: fixture.agentDir, cwd: fixture.root, writeError: () => undefined });
  assert.equal(provisioned.source, "isolated-cache");
  assert.equal(provisioned.version, launcher.PI_PROVISION_VERSION, "the synthetic install publishes the pin, not a stale literal");
  assert.ok(provisioned.file.startsWith(join(fixture.agentDir, ".pi-review-gate", "pi-runtime", `pi-${launcher.PI_PROVISION_VERSION}`)));

  // The supported floor stays below the pin and is still admitted.
  const floorEntry = writePiEntry(join(fixture.root, "floor pi.js"), launcher.PI_MIN_VERSION.join("."));
  const admitted = await launcher.__test.resolvePiRuntime({ explicit: floorEntry, env, agentDir: fixture.agentDir, cwd: fixture.root, writeError: () => undefined });
  assert.equal(admitted.version, launcher.PI_MIN_VERSION.join("."), "the older supported Pi admission contract is unchanged");
  assert.ok(compareVersionStrings(launcher.PI_MIN_VERSION.join("."), launcher.PI_PROVISION_VERSION) < 0);
});

function compareVersionStrings(left: string, right: string): number {
  const a = left.split(".").map(Number);
  const b = right.split(".").map(Number);
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const diff = (a[index] ?? 0) - (b[index] ?? 0);
    if (diff !== 0) return diff < 0 ? -1 : 1;
  }
  return 0;
}

test("a readable Node CLI entry is probed through the admitted Node and rejected fail-closed otherwise", async (t) => {
  const fixture = makeRuntimeFixture(".session-host-pi-runtime-explicit-");
  cleanupFixture(t, fixture);
  const env = runtimeEnv(fixture);
  const goodEntry = writePiEntry(join(fixture.root, "explicit tools/π pi.js"), "1.0.4");
  if (process.platform === "win32") chmodSync(goodEntry, 0o600);

  const ok = await launcher.__test.resolvePiRuntime({ explicit: goodEntry, env, agentDir: fixture.agentDir, cwd: fixture.root, writeError: () => undefined });
  assert.deepEqual(ok, { file: goodEntry, version: "1.0.4", source: "explicit" });

  const shellShim = join(fixture.root, "shell pi.sh");
  writeFileSync(shellShim, "#!/bin/sh\necho shim\n", "utf8");
  chmodSync(shellShim, 0o755);
  const failures: Array<{ explicit: string; diagnostic: RegExp }> = [
    { explicit: join(fixture.root, "missing pi"), diagnostic: /not a regular readable file/ },
    { explicit: shellShim, diagnostic: /not a positive Node entry/ },
    { explicit: writePiEntry(join(fixture.root, "old pi.js"), "1.0.3"), diagnostic: /found 1\.0\.3/ },
  ];
  for (const failure of failures) {
    await assert.rejects(
      () => launcher.__test.resolvePiRuntime({ explicit: failure.explicit, env, agentDir: fixture.agentDir, cwd: fixture.root, writeError: () => undefined }),
      failure.diagnostic,
    );
  }
});

test("npm global package root is resolved by metadata with bin containment and a live probe", async (t) => {
  const fixture = makeRuntimeFixture(".session-host-pi-runtime-global-");
  cleanupFixture(t, fixture);
  const pkgDir = join(fixture.globalRoot, "@earendil-works", "pi-coding-agent");
  writePiPackage(pkgDir);
  writeFakeNpm(fixture, "global");
  const env = runtimeEnv(fixture, { PI_FAKE_GLOBAL_ROOT: fixture.globalRoot });

  const result = await launcher.__test.resolvePiRuntime({ env, agentDir: fixture.agentDir, cwd: fixture.root, writeError: () => undefined });
  assert.equal(result.source, "npm-global");
  assert.equal(result.version, "1.0.4");
  assert.equal(result.file, join(pkgDir, "dist", "bundle", "cli.js"));
});

test("an unsupported global install falls through to PATH discovery", async (t) => {
  const fixture = makeRuntimeFixture(".session-host-pi-runtime-fallthrough-");
  cleanupFixture(t, fixture);
  const globalPkgDir = join(fixture.globalRoot, "@earendil-works", "pi-coding-agent");
  writePiPackage(globalPkgDir, "1.0.3");
  const pathPkgDir = join(fixture.root, "path install", "@earendil-works", "pi-coding-agent");
  const pathEntry = writePiPackage(pathPkgDir);
  // PATH pi: a symlink into the public package's declared bin entry.
  mkdirSync(join(fixture.bin), { recursive: true });
  const { symlinkSync } = require("node:fs") as typeof import("node:fs");
  symlinkSync(pathEntry, join(fixture.bin, "pi"));
  writeFakeNpm(fixture, "global");
  const env = runtimeEnv(fixture, { PI_FAKE_GLOBAL_ROOT: fixture.globalRoot });

  const result = await launcher.__test.resolvePiRuntime({ env, agentDir: fixture.agentDir, cwd: fixture.root, writeError: () => undefined });
  assert.equal(result.source, "path");
  assert.equal(result.file, pathEntry);
  assert.equal(result.version, "1.0.4");
});

test("a PATH pi outside the public package is never trusted", async (t) => {
  const fixture = makeRuntimeFixture(".session-host-pi-runtime-untrusted-");
  cleanupFixture(t, fixture);
  // A positive Node entry named `pi` that is NOT inside the public package:
  // no enclosing package.json identifies it, so provisioning must be chosen.
  const strayEntry = writePiEntry(join(fixture.bin, "pi"), "1.0.4");
  void strayEntry;
  writeFakeNpm(fixture, "install");
  const env = runtimeEnv(fixture);

  const result = await launcher.__test.resolvePiRuntime({ env, agentDir: fixture.agentDir, cwd: fixture.root, writeError: () => undefined });
  assert.equal(result.source, "isolated-cache");
  assert.ok(result.file.startsWith(join(fixture.agentDir, ".pi-review-gate", "pi-runtime")));
});

test("absent or unsupported Pi provisions the isolated cache with exact npm arguments", async (t) => {
  const fixture = makeRuntimeFixture(".session-host-pi-runtime-provision-");
  cleanupFixture(t, fixture);
  writeFakeNpm(fixture, "install");
  const env = runtimeEnv(fixture);

  let notice = "";
  const result = await launcher.__test.resolvePiRuntime({ env, agentDir: fixture.agentDir, cwd: fixture.root, writeError: (text) => { notice += text; } });
  assert.equal(result.source, "isolated-cache");
  assert.equal(result.version, launcher.PI_PROVISION_VERSION);
  const expectedPkgDir = join(fixture.agentDir, ".pi-review-gate", "pi-runtime", `pi-${launcher.PI_PROVISION_VERSION}`, "node_modules", "@earendil-works", "pi-coding-agent");
  assert.equal(result.file, join(expectedPkgDir, "dist", "bundle", "cli.js"));
  assert.ok(existsSync(result.file));
  assert.match(notice, /provisioning isolated Pi/);
  assert.match(notice, /installed isolated Pi/);
  assert.match(notice, /preserving a Pi runtime staging tree because per-entry descendant creation receipts are unavailable/);

  const invocations = readFileSync(fixture.npmLog, "utf8").trim().split("\n").map((line) => JSON.parse(line) as { args: string[] });
  const installs = invocations.filter((invocation) => invocation.args[0] === "install");
  assert.equal(installs.length, 1, "exactly one npm install for a fresh provision");
  assert.deepEqual(installs[0].args, [
    "install",
    "--prefix", installs[0].args[2],
    "--ignore-scripts",
    "--no-audit",
    "--no-fund",
    "--registry", "https://registry.npmjs.org",
    `${launcher.PI_PACKAGE_NAME}@${launcher.PI_PROVISION_VERSION}`,
  ]);
  assert.ok(installs[0].args[2].startsWith(join(fixture.agentDir, ".pi-review-gate", "pi-runtime", `.staging-pi-${launcher.PI_PROVISION_VERSION}-`)));
  // Publication remains successful, but the npm stage is retained without
  // complete per-entry creation receipts.
  assert.ok(existsSync(installs[0].args[2]), "the provisioning stage remains after publication");
});

test("version-probe and DDGS setup expose unconfirmed cleanup", async (t) => {
  const fixture = makeRuntimeFixture(".session-host-probe-cleanup-unconfirmed-");
  cleanupFixture(t, fixture);
  let probeError: (Error & { cleanupUnconfirmed?: boolean }) | undefined;
  await launcher.__test.probePiVersion("/synthetic/pi", runtimeEnv(fixture), async () => ({
    status: 0,
    signal: null,
    error: new Error("synthetic setup cleanup unconfirmed"),
    cleanupConfirmed: false,
    timedOut: false,
    outputExceeded: false,
    stdout: "pi 1.0.4\n",
  })).catch((error: unknown) => { probeError = error as Error & { cleanupUnconfirmed?: boolean }; });
  assert.equal(probeError?.cleanupUnconfirmed, true, "Pi probe cleanup uncertainty is propagated distinctly");

  const setup = await launcher.__test.runDdgsSetup(fixture.root, runtimeEnv(fixture), fixture.root, async () => ({
    status: null,
    signal: null,
    error: new Error("synthetic DDGS setup cleanup unconfirmed"),
    cleanupConfirmed: false,
    timedOut: true,
    outputExceeded: false,
    stdout: "",
  }));
  assert.deepEqual(setup, { ok: false, exitCode: 124, cleanupUnconfirmed: true });
});

test("a staged Pi runtime is retained when its version probe cleanup is unconfirmed", async (t) => {
  const fixture = makeRuntimeFixture(".session-host-pi-probe-cleanup-unconfirmed-");
  cleanupFixture(t, fixture);
  const probeError = Object.assign(new Error("synthetic staged Pi probe cleanup unconfirmed"), { cleanupUnconfirmed: true });
  let stagingRoot = "";
  let diagnostic = "";

  await assert.rejects(() => launcher.__test.provisionPiRuntime({
    env: runtimeEnv(fixture),
    agentDir: fixture.agentDir,
    npmCli: "/synthetic/npm-cli.js",
    writeError: (text) => { diagnostic += text; },
    runNpm: async (_npmCli, _args, options) => {
      stagingRoot = String(options.cwd);
      writePiPackage(join(stagingRoot, "node_modules", "@earendil-works", "pi-coding-agent"), launcher.PI_PROVISION_VERSION);
      return { status: 0, signal: null, cleanupConfirmed: true, timedOut: false, outputExceeded: false, stdout: "" };
    },
    validatePiPackage: async () => { throw probeError; },
  }), /synthetic staged Pi probe cleanup unconfirmed/);

  assert.ok(stagingRoot.includes(".staging-pi-"));
  assert.ok(existsSync(join(stagingRoot, "node_modules", "@earendil-works", "pi-coding-agent", "package.json")), "the staged runtime remains available");
  assert.match(diagnostic, /preserving a Pi runtime staging tree/);
});

test("Pi provisioning retains its stage when the install group cleanup is unconfirmed", async (t) => {
  const fixture = makeRuntimeFixture(".session-host-pi-install-cleanup-unconfirmed-");
  cleanupFixture(t, fixture);
  let stagingRoot = "";
  let validationAttempted = false;
  let diagnostic = "";

  await assert.rejects(() => launcher.__test.provisionPiRuntime({
    env: runtimeEnv(fixture),
    agentDir: fixture.agentDir,
    npmCli: "/synthetic/npm-cli.js",
    writeError: (text) => { diagnostic += text; },
    runNpm: async (_npmCli, _args, options) => {
      stagingRoot = String(options.cwd);
      return {
        status: 0,
        signal: null,
        error: new Error("synthetic install cleanup unconfirmed"),
        cleanupConfirmed: false,
        timedOut: false,
        outputExceeded: false,
        stdout: "",
      };
    },
    validatePiPackage: async () => {
      validationAttempted = true;
      return { file: "/synthetic/pi", version: launcher.PI_PROVISION_VERSION };
    },
  }), /cleanup was not confirmed/);

  assert.equal(validationAttempted, false, "an unconfirmed install is never validated or published");
  assert.ok(stagingRoot.includes(".staging-pi-"));
  assert.ok(existsSync(join(stagingRoot, ".npm-cache")), "the owned staging root is preserved");
  assert.match(diagnostic, /preserving a Pi runtime staging tree/);
});

function readdirNames(dir: string): string[] {
  return require("node:fs").readdirSync(dir) as string[];
}

test("a valid cached runtime is reused without any npm invocation", async (t) => {
  const fixture = makeRuntimeFixture(".session-host-pi-runtime-cached-");
  cleanupFixture(t, fixture);
  const pkgDir = join(fixture.agentDir, ".pi-review-gate", "pi-runtime", `pi-${launcher.PI_PROVISION_VERSION}`, "node_modules", "@earendil-works", "pi-coding-agent");
  writePiPackage(pkgDir, launcher.PI_PROVISION_VERSION);
  writeFakeNpm(fixture, "install");
  const env = runtimeEnv(fixture);

  const result = await launcher.__test.resolvePiRuntime({ env, agentDir: fixture.agentDir, cwd: fixture.root, writeError: () => undefined });
  assert.equal(result.source, "isolated-cache");
  assert.equal(result.file, join(pkgDir, "dist", "bundle", "cli.js"));
  // Only the global-root probe may run; a valid cached runtime is never
  // reinstalled.
  const invocations = existsSync(fixture.npmLog)
    ? readFileSync(fixture.npmLog, "utf8").trim().split("\n").map((line) => JSON.parse(line) as { args: string[] })
    : [];
  for (const invocation of invocations) {
    assert.notDeepEqual(invocation.args[0], "install", "no npm install for a valid cached runtime");
  }
});

test("an invalid cached runtime is preserved and fails closed", async (t) => {
  const fixture = makeRuntimeFixture(".session-host-pi-runtime-badcache-");
  cleanupFixture(t, fixture);
  const pkgDir = join(fixture.agentDir, ".pi-review-gate", "pi-runtime", `pi-${launcher.PI_PROVISION_VERSION}`, "node_modules", "@earendil-works", "pi-coding-agent");
  writePiPackage(pkgDir, "1.0.4", "some-other-package");
  const marker = join(fixture.agentDir, ".pi-review-gate", "pi-runtime", "unknown-resource.txt");
  writeFileSync(marker, "preserve me\n", "utf8");
  // Fixture-only npm: the global-root probe must stay inside the fixture.
  writeFakeNpm(fixture, "global");
  const env = runtimeEnv(fixture);

  await assert.rejects(
    () => launcher.__test.resolvePiRuntime({ env, agentDir: fixture.agentDir, cwd: fixture.root, writeError: () => undefined }),
    /cached pi runtime .* is invalid/,
  );
  assert.equal(readFileSync(marker, "utf8"), "preserve me\n", "unknown cache resources are preserved");
});

test("preexisting empty and partial version destinations are preserved rather than replaced", async (t) => {
  for (const shape of ["empty", "unknown-node-modules"] as const) {
    const fixture = makeRuntimeFixture(`.session-host-pi-runtime-partial-${shape}-`);
    cleanupFixture(t, fixture);
    writeFakeNpm(fixture, "global");
    const versionRoot = join(fixture.agentDir, ".pi-review-gate", "pi-runtime", `pi-${launcher.PI_PROVISION_VERSION}`);
    mkdirSync(shape === "empty" ? versionRoot : join(versionRoot, "node_modules"), { recursive: true });
    const marker = shape === "unknown-node-modules" ? join(versionRoot, "node_modules", "unknown.txt") : join(versionRoot, "unknown.txt");
    if (shape === "unknown-node-modules") writeFileSync(marker, "preserve this node_modules tree\n", "utf8");
    const identity = lstatSync(versionRoot, { bigint: true });

    await assert.rejects(
      () => launcher.__test.resolvePiRuntime({ env: runtimeEnv(fixture), agentDir: fixture.agentDir, cwd: fixture.root, writeError: () => undefined }),
      /partial or unknown/,
    );
    const after = lstatSync(versionRoot, { bigint: true });
    assert.equal(after.dev, identity.dev);
    assert.equal(after.ino, identity.ino);
    if (shape === "unknown-node-modules") assert.equal(readFileSync(marker, "utf8"), "preserve this node_modules tree\n");
    const invocations = readFileSync(fixture.npmLog, "utf8").trim().split("\n").map((line) => JSON.parse(line) as { args: string[] });
    assert.ok(invocations.every(({ args }) => args[0] !== "install"), "a partial destination blocks installation and publication");
  }
});

test("a concurrent valid Pi cache publication is reused only after metadata and Node probe validation", async (t) => {
  const fixture = makeRuntimeFixture(".session-host-pi-runtime-concurrent-publish-");
  cleanupFixture(t, fixture);
  writeFakeNpm(fixture, "install");
  const versionRoot = join(fixture.agentDir, ".pi-review-gate", "pi-runtime", `pi-${launcher.PI_PROVISION_VERSION}`);
  const result = await launcher.__test.resolvePiRuntime({
    env: runtimeEnv(fixture, { PI_FAKE_PUBLISH_ROOT: versionRoot }),
    agentDir: fixture.agentDir,
    cwd: fixture.root,
    writeError: () => undefined,
  });
  const publishedEntry = join(versionRoot, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "bundle", "cli.js");
  assert.equal(result.source, "isolated-cache");
  assert.equal(result.file, publishedEntry);
  assert.ok(existsSync(publishedEntry));
  assert.equal(existsSync(join(versionRoot, "node_modules", "@earendil-works", "pi-coding-agent", ".staging")), false);
});

test("a version-root symlink injected at publication cannot be reused as a concurrent cache", async (t) => {
  const fixture = makeRuntimeFixture(".session-host-pi-runtime-publication-alias-");
  cleanupFixture(t, fixture);
  writeFakeNpm(fixture, "install");
  const versionRoot = join(fixture.agentDir, ".pi-review-gate", "pi-runtime", `pi-${launcher.PI_PROVISION_VERSION}`);
  const aliasRoot = join(fixture.root, "concurrent version alias");
  const aliasPkgDir = join(aliasRoot, "node_modules", "@earendil-works", "pi-coding-agent");
  const aliasEntry = writePiPackage(aliasPkgDir);
  const env = runtimeEnv(fixture);
  const npmCli = launcher.__test.findNpmCli(env);
  assert.ok(npmCli);

  await assert.rejects(
    () => launcher.__test.provisionPiRuntime({
      env,
      agentDir: fixture.agentDir,
      npmCli,
      writeError: () => undefined,
      beforeVersionRootMkdir: (target) => {
        assert.equal(target, versionRoot);
        symlinkSync(aliasRoot, versionRoot, "dir");
      },
    }),
    /partial or unsafe/,
  );
  assert.equal(lstatSync(versionRoot).isSymbolicLink(), true, "the foreign alias is preserved");
  assert.ok(existsSync(aliasEntry), "the alias target remains untouched");
  assert.equal(readFileSync(aliasEntry, "utf8").includes("pi 1.0.4"), true);
});

test("failed provisioning preserves foreign staging, unknown resources, and its own stage", async (t) => {
  const fixture = makeRuntimeFixture(".session-host-pi-runtime-fail-");
  cleanupFixture(t, fixture);
  writeFakeNpm(fixture, "install");
  const runtimeRoot = join(fixture.agentDir, ".pi-review-gate", "pi-runtime");
  mkdirSync(runtimeRoot, { recursive: true });
  const marker = join(runtimeRoot, "unknown-resource.txt");
  writeFileSync(marker, "preserve me\n", "utf8");
  // A staging directory from another (possibly concurrent) launch: a name
  // proves neither ownership nor inactivity, so it must be preserved.
  const foreignStage = join(runtimeRoot, ".staging-pi-1.0.4-concurrent-launch");
  mkdirSync(foreignStage, { recursive: true });
  writeFileSync(join(foreignStage, "active-download"), "in progress\n", "utf8");
  const env = runtimeEnv(fixture, { PI_FAKE_NPM_FAIL: "1" });
  let diagnostic = "";

  await assert.rejects(
    () => launcher.__test.resolvePiRuntime({ env, agentDir: fixture.agentDir, cwd: fixture.root, writeError: (text) => { diagnostic += text; } }),
    /pi runtime provisioning failed/,
  );
  assert.equal(readFileSync(marker, "utf8"), "preserve me\n", "unknown resources are preserved");
  assert.equal(readFileSync(join(foreignStage, "active-download"), "utf8"), "in progress\n", "foreign staging is preserved");
  const ownStages = readdirNames(runtimeRoot).filter((entry) => entry.startsWith(`.staging-pi-${launcher.PI_PROVISION_VERSION}-`));
  assert.equal(ownStages.length, 1, "this run's stage is retained without descendant receipts");
  assert.match(diagnostic, /preserving a Pi runtime staging tree because per-entry descendant creation receipts are unavailable/);
});

test("a concurrent launch's staging survives a successful provision", async (t) => {
  const fixture = makeRuntimeFixture(".session-host-pi-runtime-concurrent-");
  cleanupFixture(t, fixture);
  writeFakeNpm(fixture, "install");
  const runtimeRoot = join(fixture.agentDir, ".pi-review-gate", "pi-runtime");
  const foreignStage = join(runtimeRoot, ".staging-pi-1.0.4-other-launch");
  mkdirSync(foreignStage, { recursive: true });
  writeFileSync(join(foreignStage, "active-download"), "in progress\n", "utf8");
  const env = runtimeEnv(fixture);

  const result = await launcher.__test.resolvePiRuntime({ env, agentDir: fixture.agentDir, cwd: fixture.root, writeError: () => undefined });
  assert.equal(result.source, "isolated-cache");
  assert.ok(existsSync(result.file), "the provisioned runtime is published");
  assert.equal(readFileSync(join(foreignStage, "active-download"), "utf8"), "in progress\n", "foreign staging is untouched");
});

test("version probes run on the supplied env with provider variables preserved", async (t) => {
  const fixture = makeRuntimeFixture(".session-host-pi-runtime-probe-env-");
  cleanupFixture(t, fixture);
  const pkgDir = join(fixture.globalRoot, "@earendil-works", "pi-coding-agent");
  const probeLog = join(fixture.root, "probe-env.json");
  mkdirSync(join(pkgDir, "dist", "bundle"), { recursive: true });
  writeFileSync(join(pkgDir, "package.json"), JSON.stringify({
    name: launcher.PI_PACKAGE_NAME,
    version: "1.0.4",
    bin: { pi: "dist/bundle/cli.js" },
  }), "utf8");
  const cliEntry = writePiEntry(join(pkgDir, "dist", "bundle", "cli.js"), "1.0.4", true);
  writeFakeNpm(fixture, "global");
  const env = runtimeEnv(fixture, {
    PI_FAKE_GLOBAL_ROOT: fixture.globalRoot,
    PI_REVIEW_GATE_SESSION_HOST_BOOTSTRAP: "bootstrap-secret",
    PI_REVIEW_GATE_SESSION_HOST_NODE_OPTIONS_RESTORE: "restore-secret",
    NODE_OPTIONS: "--no-warnings",
    ANTHROPIC_API_KEY: "provider-secret",
    PI_PROBE_LOG: probeLog,
  });

  const result = await launcher.__test.resolvePiRuntime({ env, agentDir: fixture.agentDir, cwd: fixture.root, writeError: () => undefined });
  assert.equal(result.source, "npm-global");
  const probe = JSON.parse(readFileSync(probeLog, "utf8")) as {
    args: string[];
    bootstrap: string | null;
    restore: string | null;
    nodeOptions: string | null;
    provider: string | null;
  };
  assert.deepEqual(probe.args, [cliEntry, "--version"], "the admitted Node interprets the public CLI entry with argv unchanged");
  assert.equal(probe.bootstrap, "bootstrap-secret", "the direct resolver receives the caller env; the launcher scrubs it before calling");
  assert.equal(probe.nodeOptions, "--no-warnings", "the original NODE_OPTIONS is preserved for probes");
  assert.equal(probe.provider, "provider-secret", "trusted provider variables are preserved for probes");
});

test("bin containment rejects a package whose pi entry escapes the package directory", async (t) => {
  const fixture = makeRuntimeFixture(".session-host-pi-runtime-escape-");
  cleanupFixture(t, fixture);
  const pkgDir = join(fixture.root, "escaping package", "@earendil-works", "pi-coding-agent");
  mkdirSync(join(pkgDir, "dist"), { recursive: true });
  writeFileSync(join(pkgDir, "package.json"), JSON.stringify({
    name: launcher.PI_PACKAGE_NAME,
    version: "1.0.4",
    bin: { pi: "../../outside-cli.js" },
  }), "utf8");
  const outside = join(fixture.root, "escaping package", "outside-cli.js");
  writePiEntry(outside, "1.0.4");

  await assert.rejects(
    () => launcher.__test.validatePiPackage(pkgDir, runtimeEnv(fixture)),
    /bin entry escapes the package directory/,
  );
});

test("an in-package bin symlink that resolves outside is never executed", async (t) => {
  const fixture = makeRuntimeFixture(".session-host-pi-runtime-symlink-escape-");
  cleanupFixture(t, fixture);
  const pkgDir = join(fixture.root, "symlink package", "@earendil-works", "pi-coding-agent");
  mkdirSync(join(pkgDir, "dist", "bundle"), { recursive: true });
  writeFileSync(join(pkgDir, "package.json"), JSON.stringify({
    name: launcher.PI_PACKAGE_NAME,
    version: "1.0.4",
    bin: { pi: "dist/bundle/cli.js" },
  }), "utf8");
  // Lexically inside the package, canonically outside it.
  const outside = join(fixture.root, "symlink package", "outside-cli.js");
  writePiEntry(outside, "1.0.4");
  symlinkSync(outside, join(pkgDir, "dist", "bundle", "cli.js"));

  let probeCalled = false;
  await assert.rejects(
    () => launcher.__test.validatePiPackage(pkgDir, runtimeEnv(fixture), {
      processRunner: async () => {
        probeCalled = true;
        throw new Error("unexpected CLI probe");
      },
    }),
    /(?:resolves outside the package directory|not a regular readable file)/,
  );
  assert.equal(probeCalled, false, "canonical containment on POSIX or original-entry rejection on Windows precedes every CLI probe");
});

test("POSIX in-package bin symlinks validate their canonical target without spawning", { skip: process.platform === "win32" }, async (t) => {
  const fixture = makeRuntimeFixture(".session-host-pi-runtime-internal-symlink-");
  cleanupFixture(t, fixture);
  const pkgDir = join(fixture.root, "internal symlink package", "@earendil-works", "pi-coding-agent");
  const target = writePiEntry(join(pkgDir, "dist", "bundle", "real-cli.js"), "1.0.4");
  const entry = join(pkgDir, "dist", "bundle", "cli.js");
  symlinkSync(target, entry);
  writeFileSync(join(pkgDir, "package.json"), JSON.stringify({
    name: launcher.PI_PACKAGE_NAME,
    version: "1.0.4",
    bin: { pi: "dist/bundle/cli.js" },
  }), "utf8");

  let probeCalled = false;
  const canonical = realpathSync(target);
  const result = await launcher.__test.validatePiPackage(pkgDir, runtimeEnv(fixture), {
    processRunner: async (file, args) => {
      probeCalled = true;
      assert.equal(file, process.execPath);
      assert.deepEqual(args, [canonical, "--version"]);
      return { status: 0, signal: null, timedOut: false, outputExceeded: false, stdout: "pi 1.0.4" };
    },
  });
  assert.equal(probeCalled, true);
  assert.deepEqual(result, { file: canonical, version: "1.0.4" });
});

test("a probe that disagrees with the package metadata is rejected", async (t) => {
  const fixture = makeRuntimeFixture(".session-host-pi-runtime-mismatch-");
  cleanupFixture(t, fixture);
  const pkgDir = join(fixture.root, "mismatch package", "@earendil-works", "pi-coding-agent");
  mkdirSync(join(pkgDir, "dist", "bundle"), { recursive: true });
  writeFileSync(join(pkgDir, "package.json"), JSON.stringify({
    name: launcher.PI_PACKAGE_NAME,
    version: "1.0.4",
    bin: { pi: "dist/bundle/cli.js" },
  }), "utf8");
  // The entry reports a different version than its metadata declares.
  writePiEntry(join(pkgDir, "dist", "bundle", "cli.js"), "1.2.3");

  await assert.rejects(
    () => launcher.__test.validatePiPackage(pkgDir, runtimeEnv(fixture)),
    /disagrees with the package metadata/,
  );
});

test("staged and cached provisions require exactly the pinned provision version", async (t) => {
  const fixture = makeRuntimeFixture(".session-host-pi-runtime-wrongversion-");
  cleanupFixture(t, fixture);
  const pkgDir = join(fixture.root, "newer package", "@earendil-works", "pi-coding-agent");
  // Above the floor, but not the pinned provision version.
  writePiPackage(pkgDir, "1.0.5");

  await assert.rejects(
    () => launcher.__test.validatePiPackage(pkgDir, runtimeEnv(fixture), { exactVersion: launcher.PI_PROVISION_VERSION }),
    /does not match the pinned provision version/,
  );
});

test("bounded setup settles without close and retains an unconfirmed process group", async (t) => {
  const fixture = makeRuntimeFixture(".session-host-unconfirmed-process-group-");
  cleanupFixture(t, fixture);
  const closeObserved = { value: false };
  const startedAt = Date.now();
  const before = launcher.__test.activeBoundedProcessCount();
  const result = await launcher.__test.runBoundedProcess(process.execPath, [
    "-e",
    'process.on("SIGTERM", () => process.exit(0)); setInterval(() => {}, 1000);',
  ], {
    cwd: fixture.root,
    env: runtimeEnv(fixture),
    timeoutMs: 100,
    testHooks: {
      // The controlled hook models an unobservable descendant group and a
      // missing close notification while the owned child handle still exits.
      groupStillExists: () => true,
      ignoreClose: true,
      onClose: () => { closeObserved.value = true; },
    },
  });
  const elapsed = Date.now() - startedAt;

  assert.equal(result.cleanupConfirmed, false);
  assert.equal(result.timedOut, true);
  assert.equal(result.status, null, "without close, no child exit is invented");
  assert.equal(closeObserved.value, true, "the synthetic child handle emitted close but the controlled observer withheld it");
  assert.ok(elapsed < 3_000, `settlement remains bounded (elapsed ${elapsed} ms)`);
  assert.equal(launcher.__test.activeBoundedProcessCount(), before + 1, "unconfirmed setup groups remain counted");
});
